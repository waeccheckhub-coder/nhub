// POST /api/ussd — Moolre USSD callback handler with DB-backed sessions
//
// Moolre uses ONE callback URL per account — so payment webhooks also
// arrive here. We detect them by checking for body.data.txstatus and
// route them to the webhook fulfillment logic.
//
// MOOLRE USSD FIELDS:
//   sessionId  — unique session ID
//   new        — true/1/"true"/"1" on first request
//   msisdn     — customer phone e.g. "233241235993"
//   network    — 3=MTN, 5=AT, 6=Telecel
//   message    — accumulated input e.g. "1*2*1"
//
// RESPONSE: { message: string, reply: boolean }

import pool from '../../lib/db';
import { initHubtelDirectDebit } from '../../lib/hubtel';
import { getPrices } from '../../lib/settings';
import { sendAdminAlert } from '../../lib/alerts';
import { sendVoucherSMS, sendPreorderSMS } from '../../lib/sms';

// CRITICAL: disable Next.js body parser — handle all content-types manually
export const config = { api: { bodyParser: false } };

// ── Body parser ───────────────────────────────────────────────────────────────

async function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk.toString(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { return resolve(JSON.parse(raw)); } catch (_) {}
      try {
        const obj = {};
        new URLSearchParams(raw).forEach((v, k) => { obj[k] = v; });
        if (Object.keys(obj).length > 0) return resolve(obj);
      } catch (_) {}
      console.warn('[USSD] Could not parse body:', raw.slice(0, 200));
      return resolve({});
    });
    req.on('error', () => resolve({}));
  });
}

// ── DB session helpers ────────────────────────────────────────────────────────

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ussd_sessions (
      session_id   VARCHAR(100) PRIMARY KEY,
      stage        VARCHAR(50)  NOT NULL DEFAULT 'MENU',
      voucher_type VARCHAR(50),
      quantity     INTEGER,
      updated_at   TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function getSession(sessionId) {
  try {
    await ensureTable();
    const r = await pool.query(
      'SELECT stage, voucher_type, quantity FROM ussd_sessions WHERE session_id = $1',
      [String(sessionId)]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      stage:       row.stage || 'MENU',
      voucherType: row.voucher_type || null,
      quantity:    row.quantity != null ? parseInt(row.quantity, 10) : null,
    };
  } catch (err) {
    console.error('[USSD] getSession error:', err.message);
    return { stage: 'MENU' };
  }
}

async function setSession(sessionId, data) {
  try {
    await ensureTable();
    await pool.query(
      `INSERT INTO ussd_sessions (session_id, stage, voucher_type, quantity, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (session_id) DO UPDATE
       SET stage=$2, voucher_type=$3, quantity=$4, updated_at=NOW()`,
      [
        String(sessionId),
        String(data.stage),
        data.voucherType != null ? String(data.voucherType) : null,
        data.quantity    != null ? parseInt(data.quantity, 10) : null,
      ]
    );
  } catch (err) {
    console.error('[USSD] setSession error:', err.message);
  }
}

async function clearSession(sessionId) {
  try {
    await pool.query('DELETE FROM ussd_sessions WHERE session_id = $1', [String(sessionId)]);
  } catch (err) {
    console.error('[USSD] clearSession error:', err.message);
  }
}

// ── Payment webhook fulfillment ───────────────────────────────────────────────
// Called when Moolre POSTs a payment confirmation to this URL.

async function handlePaymentWebhook(res, payload) {
  console.log('[Webhook] Received payload:', JSON.stringify(payload));

  const txData = payload?.data;
  if (!txData) {
    console.warn('[Webhook] Empty data field');
    return res.status(200).json({ received: true });
  }

  const txstatus  = Number(txData.txstatus);
  const reference = txData.externalref;
  const payer     = txData.payer || '';
  const amount    = txData.amount || 0;
  const secret    = txData.secret;

  if (process.env.MOOLRE_WEBHOOK_SECRET && secret !== process.env.MOOLRE_WEBHOOK_SECRET) {
    console.warn('[Webhook] Secret mismatch — ignoring');
    return res.status(200).json({ received: true });
  }

  if (txstatus !== 1) {
    console.log('[Webhook] Non-success txstatus:', txstatus);
    return res.status(200).json({ received: true, note: 'Non-success txstatus' });
  }

  if (!reference) {
    console.warn('[Webhook] No externalref in payload');
    return res.status(200).json({ received: true });
  }

  // Idempotency — skip if already fulfilled
  const existing = await pool.query(
    `SELECT id FROM transactions WHERE reference=$1 AND status='success'`,
    [reference]
  );
  if (existing.rowCount > 0) {
    console.log('[Webhook] Already processed:', reference);
    return res.status(200).json({ received: true, note: 'Already processed' });
  }

  // Load order — check preorders first, then transactions (USSD saves to transactions)
  let phone, qty, voucherType, orderAmount;

  const preorderRow = await pool.query(
    `SELECT phone, quantity, voucher_type, amount FROM preorders WHERE reference=$1`,
    [reference]
  );

  if (preorderRow.rowCount > 0) {
    ({ phone, quantity: qty, voucher_type: voucherType, amount: orderAmount } = preorderRow.rows[0]);
    console.log('[Webhook] Order found in preorders:', { phone, qty, voucherType });
  } else {
    const txRow = await pool.query(
      `SELECT phone, quantity, voucher_type, amount FROM transactions WHERE reference=$1`,
      [reference]
    );
    if (txRow.rowCount > 0) {
      ({ phone, quantity: qty, voucher_type: voucherType, amount: orderAmount } = txRow.rows[0]);
      console.log('[Webhook] Order found in transactions:', { phone, qty, voucherType });
    } else {
      phone = payer;
      qty = 1;
      voucherType = null;
      orderAmount = amount;
    }
  }

  if (!voucherType) {
    console.error('[Webhook] Cannot determine voucherType for ref', reference);
    await sendAdminAlert(
      `WEBHOOK: Payment received (GHS ${amount}) but order not found! Ref: ${reference}. Phone: ${payer}. Fulfill manually.`
    );
    return res.status(200).json({ received: true, note: 'Order not found — admin alerted' });
  }

  qty = parseInt(qty);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check for vouchers pre-assigned by USSD handler
    const preAssigned = await client.query(
      `SELECT id, serial, pin FROM vouchers WHERE transaction_ref=$1 AND status='sold'`,
      [reference]
    );

    if (preAssigned.rowCount >= qty) {
      // USSD pre-assigned them — just confirm payment and send SMS
      console.log('[Webhook] Vouchers pre-assigned by USSD, confirming payment');
      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
         VALUES ($1,$2,$3,$4,$5,'success',NOW())
         ON CONFLICT (reference) DO UPDATE SET status='success'`,
        [reference, phone, parseFloat(orderAmount), qty, voucherType]
      );
      await client.query('COMMIT');
      client.release();

      await sendVoucherSMS(phone, preAssigned.rows, voucherType);
      await sendAdminAlert(`✅ USSD Sale: ${qty}x ${voucherType} GHS ${orderAmount} to ${phone}. Ref: ${reference}`);
      return res.status(200).json({ received: true, fulfilled: true });
    }

    // No pre-assigned vouchers — assign fresh ones (web payment / preorder flow)
    const vouchers = await client.query(
      `SELECT id, serial, pin FROM vouchers
       WHERE type=$1 AND status='available'
       LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [voucherType, qty]
    );

    if (vouchers.rowCount < qty) {
      // Out of stock
      await client.query(
        `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
         VALUES ($1,$2,'',$3,$4,$5,'pending',NOW())
         ON CONFLICT (reference) DO UPDATE SET status='pending'`,
        [reference, phone, parseFloat(orderAmount), qty, voucherType]
      );
      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
         VALUES ($1,$2,$3,$4,$5,'preorder',NOW())
         ON CONFLICT (reference) DO UPDATE SET status='preorder'`,
        [reference, phone, parseFloat(orderAmount), qty, voucherType]
      );
      await client.query('COMMIT');
      client.release();

      await sendPreorderSMS(phone, voucherType, reference);
      await sendAdminAlert(`⚠️ OUT OF STOCK: ${voucherType} x${qty} from ${phone}. Ref: ${reference}. Upload vouchers!`);
      return res.status(200).json({ received: true, fulfilled: false });
    }

    const ids = vouchers.rows.map(v => v.id);
    await client.query(
      `UPDATE vouchers SET status='sold', sold_to=$1, sold_at=NOW(), transaction_ref=$2 WHERE id=ANY($3)`,
      [phone, reference, ids]
    );
    await client.query(
      `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
       VALUES ($1,$2,$3,$4,$5,'success',NOW())
       ON CONFLICT (reference) DO UPDATE SET status='success'`,
      [reference, phone, parseFloat(orderAmount), qty, voucherType]
    );
    await client.query(
      `UPDATE preorders SET status='fulfilled', fulfilled_at=NOW()
       WHERE reference=$1 AND status IN ('initiated','pending')`,
      [reference]
    );
    await client.query('COMMIT');
    client.release();

    await sendVoucherSMS(phone, vouchers.rows, voucherType);
    await sendAdminAlert(`✅ Web Sale: ${qty}x ${voucherType} GHS ${orderAmount} to ${phone}. Ref: ${reference}`);
    return res.status(200).json({ received: true, fulfilled: true });

  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    console.error('[Webhook] DB error:', err.message);
    return res.status(200).json({ received: true, error: 'Processing failed' });
  }
}


// ── Poll for payment confirmation ─────────────────────────────────────────────
// Polls Moolre every 5s for up to 60s after a USSD payment is triggered.
// Fulfills the order directly if payment confirmed — handles the case where
// Moolre does not fire a webhook for USSD-triggered direct debit payments.

async function pollAndFulfill({ ref, phone, voucherType, quantity, total }) {
  const maxAttempts = 12; // 12 x 5s = 60s
  const delay = ms => new Promise(r => setTimeout(r, ms));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await delay(5000);
    try {
      const statusRes = await fetch('https://api.moolre.com/open/transact/status', {
        method: 'POST',
        headers: {
          'X-API-USER':   process.env.MOOLRE_USERNAME,
          'X-API-PUBKEY': process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type:          1,
          idtype:        1,
          id:            ref,
          accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
        }),
      });
      const statusData = await statusRes.json();
      const txstatus = Number(statusData?.data?.txstatus);
      console.log(`[USSD] Poll attempt ${attempt} for ${ref}: txstatus=${txstatus}`);

      if (txstatus === 2) {
        // Payment failed — release pre-assigned vouchers back to available
        console.log('[USSD] Payment failed — releasing reserved vouchers for', ref);
        await pool.query(
          `UPDATE vouchers SET status='available', sold_to=NULL, transaction_ref=NULL, sold_at=NULL
           WHERE transaction_ref=$1 AND status='sold'`,
          [ref]
        );
        await pool.query(
          `UPDATE transactions SET status='failed' WHERE reference=$1`,
          [ref]
        );
        return;
      }

      if (txstatus !== 1) continue; // still pending

      // Payment confirmed — check idempotency first
      const already = await pool.query(
        `SELECT id FROM transactions WHERE reference=$1 AND status='success'`,
        [ref]
      );
      if (already.rowCount > 0) {
        console.log('[USSD] Poll: already fulfilled', ref);
        return;
      }

      // Fulfill
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const preAssigned = await client.query(
          `SELECT id, serial, pin FROM vouchers WHERE transaction_ref=$1 AND status='sold'`,
          [ref]
        );

        if (preAssigned.rowCount >= quantity) {
          await client.query(
            `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
             VALUES ($1,$2,$3,$4,$5,'success',NOW())
             ON CONFLICT (reference) DO UPDATE SET status='success'`,
            [ref, phone, parseFloat(total), quantity, voucherType]
          );
          await client.query('COMMIT');
          client.release();
          await sendVoucherSMS(phone, preAssigned.rows, voucherType);
          console.log('[USSD] Poll fulfilled:', ref);
          return;
        }

        // No pre-assigned — grab fresh vouchers
        const vouchers = await client.query(
          `SELECT id, serial, pin FROM vouchers
           WHERE type=$1 AND status='available'
           LIMIT $2 FOR UPDATE SKIP LOCKED`,
          [voucherType, quantity]
        );

        if (vouchers.rowCount < quantity) {
          await client.query('COMMIT');
          client.release();
          await sendPreorderSMS(phone, voucherType, ref);
          await sendAdminAlert(`OUT OF STOCK (poll): ${voucherType} x${quantity} from ${phone}. Ref: ${ref}`);
          return;
        }

        const ids = vouchers.rows.map(v => v.id);
        await client.query(
          `UPDATE vouchers SET status='sold', sold_to=$1, sold_at=NOW(), transaction_ref=$2 WHERE id=ANY($3)`,
          [phone, ref, ids]
        );
        await client.query(
          `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
           VALUES ($1,$2,$3,$4,$5,'success',NOW())
           ON CONFLICT (reference) DO UPDATE SET status='success'`,
          [ref, phone, parseFloat(total), quantity, voucherType]
        );
        await client.query('COMMIT');
        client.release();
        await sendVoucherSMS(phone, vouchers.rows, voucherType);
        console.log('[USSD] Poll fulfilled (fresh vouchers):', ref);
        return;

      } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        console.error('[USSD] Poll fulfill error:', err.message);
        return;
      }

    } catch (err) {
      console.error(`[USSD] Poll attempt ${attempt} error:`, err.message);
    }
  }

  console.warn('[USSD] Poll timed out for', ref);
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'ok' });
  if (req.method !== 'POST') return res.status(405).end();

  let body = {};
  try {
    body = await parseBody(req);
  } catch (err) {
    console.error('[USSD] parseBody error:', err.message);
  }

  console.log('[USSD] body:', JSON.stringify(body));

  // ── Detect payment webhook ─────────────────────────────────────────────────
  // Moolre sends payment confirmations to the account callback URL.
  // If that's this USSD endpoint, payment webhooks arrive here too.
  if (body.data && body.data.txstatus !== undefined && body.data.externalref) {
    console.log('[USSD] Detected payment webhook — routing to fulfillment');
    return handlePaymentWebhook(res, body);
  }

  // ── USSD menu flow ─────────────────────────────────────────────────────────

  const sessionId = body.sessionId  != null ? String(body.sessionId).trim()  :
                    body.session_id != null ? String(body.session_id).trim() :
                    body.SessionId  != null ? String(body.SessionId).trim()  : '';

  const msisdn    = body.msisdn      != null ? String(body.msisdn).trim()      :
                    body.phone       != null ? String(body.phone).trim()       :
                    body.PhoneNumber != null ? String(body.PhoneNumber).trim() : '';

  const network   = body.network != null ? parseInt(body.network, 10) : 3;

  const isNewFlag =
    body.new   === true || body.new   === 'true' || body.new   === 1 || body.new   === '1' ||
    body.isNew === true || body.isNew === 'true' || body.isNew === 1 || body.isNew === '1';

  // Moolre sends accumulated input like "1*2*1" — take only the last segment
  const rawMsg    = body.message ?? body.input ?? body.userInput ?? '';
  const userInput = String(rawMsg).includes('*')
    ? String(rawMsg).split('*').pop().trim()
    : String(rawMsg).trim();

  console.log(`[USSD] sessionId="${sessionId}" isNew=${isNewFlag} msisdn="${msisdn}" input="${userInput}"`);

  if (!sessionId) {
    console.error('[USSD] Missing sessionId:', JSON.stringify(body));
    return res.status(200).json({ message: 'Session error. Please try again.', reply: false });
  }

  const respond = async (message, keepOpen = true) => {
    if (!keepOpen) await clearSession(sessionId);
    console.log(`[USSD] reply=${keepOpen}: ${String(message).replace(/\n/g, '|').slice(0, 100)}`);
    return res.status(200).json({ message, reply: keepOpen });
  };

  try {
    const prices = await getPrices();

    const existingSession = await getSession(sessionId);
    const isNewSession = isNewFlag || existingSession === null;

    console.log(`[USSD] isNewSession=${isNewSession} existingStage=${existingSession?.stage ?? 'none'}`);

    if (isNewSession) {
      await setSession(sessionId, { stage: 'MENU' });
      return respond(
        `Welcome to WAEC GH Checkers\n` +
        `1. WASSCE (GHS ${prices.WASSCE})\n` +
        `2. BECE (GHS ${prices.BECE})\n` +
        `0. Exit`,
        true
      );
    }

    const session = existingSession;
    const choice  = userInput;

    console.log(`[USSD] stage="${session.stage}" choice="${choice}"`);

    switch (session.stage) {

      case 'MENU': {
        const typeMap = { '1': 'WASSCE', '2': 'BECE' };
        if (choice === '0') return respond('Thank you. Goodbye!', false);
        if (!typeMap[choice]) {
          return respond(
            `Choose an option:\n1. WASSCE (GHS ${prices.WASSCE})\n2. BECE (GHS ${prices.BECE})\n0. Exit`,
            true
          );
        }
        const voucherType = typeMap[choice];
        await setSession(sessionId, { stage: 'SELECT_QTY', voucherType });
        return respond(
          `${voucherType} @ GHS ${prices[voucherType]} each.\nHow many? (1-5)`,
          true
        );
      }

      case 'SELECT_QTY': {
        const qty = parseInt(choice, 10);
        if (!qty || qty < 1 || qty > 5) {
          return respond('Please enter a number between 1 and 5:', true);
        }
        const unitPrice = parseFloat(prices[String(session.voucherType)] || 0);
        const total = (unitPrice * qty).toFixed(2);
        await setSession(sessionId, { stage: 'CONFIRM', voucherType: session.voucherType, quantity: qty });
        return respond(
          `${qty}x ${session.voucherType} = GHS ${total}\nMoMo: ${msisdn}\n\n1. Confirm & Pay\n2. Cancel`,
          true
        );
      }

      case 'CONFIRM': {
        if (choice === '2') return respond('Cancelled. Goodbye!', false);
        if (choice !== '1') return respond('Press 1 to confirm or 2 to cancel:', true);

        const voucherType = session.voucherType ? String(session.voucherType) : null;
        const quantity    = session.quantity ? parseInt(session.quantity, 10) : 0;
        const unitPrice   = parseFloat(prices[voucherType] || 0);
        const total       = (unitPrice * quantity).toFixed(2);

        if (!voucherType || !quantity) {
          console.error('[USSD] CONFIRM: missing session data', JSON.stringify(session));
          return respond('Session expired. Please dial again.', false);
        }

        const safeSuffix = String(sessionId).replace(/\W/g, '').slice(-6).toUpperCase() || 'USSD';
        const ref = `USSD-${Date.now()}-${safeSuffix}`;

        // Reserve vouchers (or create preorder) before triggering payment
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const available = await client.query(
            `SELECT id, serial, pin FROM vouchers
             WHERE type=$1 AND status='available'
             ORDER BY id ASC LIMIT $2
             FOR UPDATE SKIP LOCKED`,
            [voucherType, quantity]
          );

          if (available.rows.length >= quantity) {
            // Reserve vouchers — mark as sold with this ref
            // Webhook will send SMS after payment confirmed
            const ids = available.rows.map(v => v.id);
            await client.query(
              `UPDATE vouchers SET status='sold', sold_to=$1, transaction_ref=$2, sold_at=NOW()
               WHERE id=ANY($3)`,
              [msisdn, ref, ids]
            );
            await client.query(
              `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
               VALUES ($1,$2,$3,$4,$5,'pending',NOW())
               ON CONFLICT (reference) DO NOTHING`,
              [ref, msisdn, parseFloat(total), quantity, voucherType]
            );
          } else {
            // Out of stock — save preorder, webhook will handle when stock is added
            await client.query(
              `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
               VALUES ($1,$2,'',$3,$4,$5,'pending',NOW())
               ON CONFLICT (reference) DO NOTHING`,
              [ref, msisdn, parseFloat(total), quantity, voucherType]
            );
            await client.query(
              `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
               VALUES ($1,$2,$3,$4,$5,'preorder',NOW())
               ON CONFLICT (reference) DO NOTHING`,
              [ref, msisdn, parseFloat(total), quantity, voucherType]
            );
            await sendAdminAlert(
              `⚠️ USSD Preorder: ${voucherType} x${quantity} GHS ${total} from ${msisdn}. Ref: ${ref}`
            );
          }

          await client.query('COMMIT');
          client.release();
        } catch (dbErr) {
          await client.query('ROLLBACK');
          client.release();
          console.error('[USSD] CONFIRM DB error:', dbErr.message);
          return respond('An error occurred. Please try again.', false);
        }

        // Map USSD network to Moolre payment channel
        // USSD: 3=MTN, 5=AT, 6=Telecel → Payment: 13=MTN, 7=AT, 6=Telecel
        const networkToChannel = { 3: '13', 5: '7', 6: '6' };
        const channel = networkToChannel[network] || '13';

        // Moolre payment API requires local format: 0XXXXXXXXX
        const payerLocal = msisdn.startsWith('233')  ? '0' + msisdn.slice(3)  :
                           msisdn.startsWith('+233') ? '0' + msisdn.slice(4)  :
                           msisdn;

        // Trigger MoMo PIN prompt via Hubtel (primary) with Moolre fallback
        // Map USSD network to Hubtel/Moolre channel names
        const networkNameMap = { 3: 'MTN', 5: 'AT', 6: 'TELECEL' };
        const networkName = networkNameMap[network] || 'MTN';

        let paymentTriggered = false;

        // ── Hubtel direct debit (primary) ─────────────────────────────────
        try {
          await initHubtelDirectDebit({
            phone:       payerLocal,
            amount:      parseFloat(total),
            reference:   ref,
            description: `${quantity}x ${voucherType} - WAEC GH Checkers`,
            network:     networkName,
          });
          console.log('[USSD] Hubtel direct debit triggered for', ref);
          paymentTriggered = true;
        } catch (hubtelErr) {
          console.error('[USSD] Hubtel direct debit failed, trying Moolre:', hubtelErr.message);
        }

        // ── Moolre fallback ───────────────────────────────────────────────
        if (!paymentTriggered) {
          try {
            const networkToChannel = { 3: '13', 5: '7', 6: '6' };
            const channel = networkToChannel[network] || '13';
            const payRes = await fetch('https://api.moolre.com/open/transact/payment', {
              method: 'POST',
              headers: {
                'X-API-USER':   process.env.MOOLRE_USERNAME,
                'X-API-PUBKEY': process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                type:          1,
                channel,
                currency:      'GHS',
                payer:         payerLocal,
                amount:        parseFloat(total),
                externalref:   ref,
                reference:     `${quantity}x ${voucherType} - WAEC GH Checkers`,
                sessionid:     sessionId,
                accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
              }),
            });
            const payData = await payRes.json();
            console.log('[USSD] Moolre fallback response:', JSON.stringify(payData));
          } catch (moolreErr) {
            console.error('[USSD] Moolre fallback also failed:', moolreErr.message);
          }
        }

        // Poll for payment status as fallback — Moolre may not fire a webhook
        // for USSD-triggered payments. Poll every 5s for up to 60s.
        pollAndFulfill({ ref, phone: msisdn, voucherType, quantity, total });

        return respond(
          `Please authorize the GHS ${total} MoMo payment prompt on your phone.\nVouchers will be sent via SMS after payment.`,
          false
        );
      }

      default:
        await setSession(sessionId, { stage: 'MENU' });
        return respond(
          `WAEC GH Checkers\n1. WASSCE\n2. BECE\n0. Exit`,
          true
        );
    }

  } catch (err) {
    console.error('[USSD] Unhandled error:', err.message, err.stack);
    return res.status(200).json({ message: 'Service error. Please try again.', reply: false });
  }
}
