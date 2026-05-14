// POST /api/ussd — Wigal Frog Smart USSD callback handler with DB-backed sessions
//
// Wigal Frog sends a POST with JSON body. newSession=true on the first hit.
// We respond with JSON. continueSession=true keeps the menu open; false closes it.
//
// WIGAL FROG INBOUND FIELDS:
//   sessionId     — unique session identifier for this USSD dialogue
//   newSession    — boolean; true on the very first request of a session
//   msisdn        — customer phone e.g. "233241235993"
//   network       — network name string e.g. "MTN", "AT", "TELECEL"
//   userInput     — what the customer typed (empty string on first hit)
//
// WIGAL FROG OUTBOUND FIELDS:
//   sessionId       — echo back as received
//   continueSession — true = keep session open (MORE), false = end session (END)
//   message         — text to display on the customer's handset
//
// PAYMENT WEBHOOKS:
//   Hubtel sends confirmations to /api/hubtel-webhook (separate endpoint).
//   This endpoint is USSD-only — no payment webhook detection needed here.

import pool from '../../lib/db';
import { initHubtelDirectDebit } from '../../lib/hubtel';
import { getPrices } from '../../lib/settings';
import { sendAdminAlert } from '../../lib/alerts';
import { sendVoucherSMS, sendPreorderSMS } from '../../lib/sms';

// Next.js default body parser handles JSON fine for Wigal Frog
// (they POST application/json), so we leave bodyParser enabled.

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

// ── Payment polling (background) ──────────────────────────────────────────────
// Hubtel fires a webhook to /api/hubtel-webhook on payment confirmation.
// This poll is a safety net in case the webhook is delayed or missed.
// Polls every 5 s for up to 60 s after the MoMo prompt is sent.

async function pollAndFulfill({ ref, phone, voucherType, quantity, total }) {
  const maxAttempts = 12; // 12 × 5 s = 60 s
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

// ── Network name → Hubtel channel ─────────────────────────────────────────────
// Wigal Frog passes the network as a human-readable string.

function networkToHubtelName(network) {
  const n = String(network || '').toUpperCase();
  if (n.includes('MTN'))                       return 'MTN';
  if (n.includes('AT') || n.includes('AIRTEL') || n.includes('TIGO')) return 'AT';
  if (n.includes('TELECEL') || n.includes('VODA')) return 'TELECEL';
  return 'MTN'; // safe default
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ status: 'ok' });
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};

  console.log('[USSD] body:', JSON.stringify(body));

  // ── Parse Wigal Frog fields ────────────────────────────────────────────────
  const sessionId  = String(body.sessionId  ?? body.session_id ?? '').trim();
  const msisdn     = String(body.msisdn     ?? body.phonenumber ?? body.phoneNumber ?? '').trim();
  const networkRaw = String(body.network    ?? '').trim();
  const isNew      = body.newSession === true || body.newSession === 'true' ||
                     body.new        === true || body.new        === 'true';

  // userInput is empty string on first hit; just the single digit on subsequent hits
  const userInput  = String(body.userInput  ?? body.userdata ?? '').trim();

  console.log(`[USSD] sessionId="${sessionId}" isNew=${isNew} msisdn="${msisdn}" input="${userInput}" network="${networkRaw}"`);

  if (!sessionId) {
    console.error('[USSD] Missing sessionId:', JSON.stringify(body));
    return res.status(200).json({
      sessionId:       sessionId || 'unknown',
      continueSession: false,
      message:         'Session error. Please try again.',
    });
  }

  // ── Wigal Frog response helper ─────────────────────────────────────────────
  // continueSession=true  → MORE (keep menu open, wait for input)
  // continueSession=false → END  (close session)
  const respond = async (message, keepOpen = true) => {
    if (!keepOpen) await clearSession(sessionId);
    console.log(`[USSD] continueSession=${keepOpen}: ${String(message).replace(/\n/g, '|').slice(0, 120)}`);
    return res.status(200).json({
      sessionId,
      continueSession: keepOpen,
      message,
    });
  };

  try {
    const prices = await getPrices();

    const existingSession = await getSession(sessionId);
    const isNewSession    = isNew || existingSession === null;

    console.log(`[USSD] isNewSession=${isNewSession} existingStage=${existingSession?.stage ?? 'none'}`);

    // ── New session → show main menu ─────────────────────────────────────────
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

      // ── Main menu ──────────────────────────────────────────────────────────
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

      // ── Quantity selection ─────────────────────────────────────────────────
      case 'SELECT_QTY': {
        const qty = parseInt(choice, 10);
        if (!qty || qty < 1 || qty > 5) {
          return respond('Please enter a number between 1 and 5:', true);
        }
        const unitPrice = parseFloat(prices[String(session.voucherType)] || 0);
        const total     = (unitPrice * qty).toFixed(2);
        await setSession(sessionId, { stage: 'CONFIRM', voucherType: session.voucherType, quantity: qty });
        return respond(
          `${qty}x ${session.voucherType} = GHS ${total}\nMoMo: ${msisdn}\n\n1. Confirm & Pay\n2. Cancel`,
          true
        );
      }

      // ── Order confirmation ─────────────────────────────────────────────────
      case 'CONFIRM': {
        if (choice === '2') return respond('Cancelled. Goodbye!', false);
        if (choice !== '1') return respond('Press 1 to confirm or 2 to cancel:', true);

        const voucherType = session.voucherType ? String(session.voucherType) : null;
        const quantity    = session.quantity    ? parseInt(session.quantity, 10) : 0;
        const unitPrice   = parseFloat(prices[voucherType] || 0);
        const total       = (unitPrice * quantity).toFixed(2);

        if (!voucherType || !quantity) {
          console.error('[USSD] CONFIRM: missing session data', JSON.stringify(session));
          return respond('Session expired. Please dial again.', false);
        }

        const safeSuffix = String(sessionId).replace(/\W/g, '').slice(-6).toUpperCase() || 'USSD';
        const ref        = `USSD-${Date.now()}-${safeSuffix}`;

        // ── Reserve vouchers / create preorder ────────────────────────────
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
            // Out of stock — record pre-order; admin will fulfil when stock is uploaded
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

        // ── Trigger MoMo PIN prompt ────────────────────────────────────────
        // Phone format for Hubtel: local 0XXXXXXXXX
        const payerLocal = msisdn.startsWith('233')  ? '0' + msisdn.slice(3)  :
                           msisdn.startsWith('+233') ? '0' + msisdn.slice(4)  :
                           msisdn;

        const networkName = networkToHubtelName(networkRaw);

        let paymentTriggered = false;

        // Primary — Hubtel direct debit
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
          console.error('[USSD] Hubtel direct debit failed, trying Moolre fallback:', hubtelErr.message);
        }

        // Fallback — Moolre direct payment
        if (!paymentTriggered) {
          try {
            const channelMap  = { MTN: '13', AT: '7', TELECEL: '6' };
            const channel     = channelMap[networkName] || '13';
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

        // Background poll — safety net if webhook is delayed
        pollAndFulfill({ ref, phone: msisdn, voucherType, quantity, total });

        // Close the USSD session — customer now approves on MoMo prompt
        return respond(
          `Please authorize the GHS ${total} MoMo payment on your phone.\nYour voucher PIN will be sent by SMS once payment is confirmed.`,
          false // END session — no more USSD input needed
        );
      }

      // ── Unknown stage — reset ──────────────────────────────────────────────
      default:
        await setSession(sessionId, { stage: 'MENU' });
        return respond(
          `WAEC GH Checkers\n1. WASSCE (GHS ${prices.WASSCE})\n2. BECE (GHS ${prices.BECE})\n0. Exit`,
          true
        );
    }

  } catch (err) {
    console.error('[USSD] Unhandled error:', err.message, err.stack);
    return res.status(200).json({
      sessionId,
      continueSession: false,
      message: 'Service error. Please try again.',
    });
  }
}
