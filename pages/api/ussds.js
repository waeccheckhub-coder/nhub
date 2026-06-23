// POST /api/ussd — Moolre USSD menu handler, now paying out via Npontu Pay
//
// The USSD menu itself is still driven by Moolre's USSD callback (the
// sessionId/msisdn/network/message fields below are Moolre's). What has
// changed is WHO we ask to actually move money once the customer confirms:
// that now goes to Npontu Pay (https://pay.npontu.com) instead of Moolre's
// payment API.
//
// Npontu Pay also delivers payment confirmations via webhook to whatever
// `callback_url` we send on the initiate-payment call — and we point that
// at THIS SAME endpoint, so payment webhooks arrive here too, alongside
// USSD menu traffic. We detect them defensively (see the webhook-detection
// check in the main handler, and parseNpontuWebhook below) since Npontu's
// public docs at the time of writing only document the initiate-payment
// request, not the exact webhook body shape — we accept several plausible
// field names rather than guessing a single rigid shape.
//
// MOOLRE USSD FIELDS (menu flow only — payment is now Npontu):
//   sessionId  — unique session ID
//   new        — true/1/"true"/"1" on first request
//   msisdn     — customer phone e.g. "233241235993"
//   network    — 3=MTN, 5=AT, 6=Telecel
//   message    — accumulated input e.g. "1*2*1"
//
// NPONTU PAY — POST https://pay.npontu.com/api/v1/pay
//   Auth: HTTP Basic, username=NPONTU_UID, password=NPONTU_PASS
//   Body: { transaction_id, network: 'mtn'|'telecel'|'tigo', amount,
//           phone_number: '233XXXXXXXXX', reference, callback_url }
//   NOTE: Npontu's documented network values are lowercase 'mtn', 'telecel',
//   'tigo' — there is no separate AirtelTigo/AT split like Moolre's channel
//   codes had, so both AT and Telecel USSD traffic must map sensibly here.
//   (Network code 5 in Moolre's USSD payload is "AT" / AirtelTigo — mapped
//   to Npontu's 'tigo' below since that's the literal token their docs use.)
//
// RESPONSE: { message: string, reply: boolean }

import pool from '../../lib/db';
import { getPrices, getSetting } from '../../lib/settings';
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
// Called when Npontu Pay POSTs a payment confirmation to our callback_url.
//
// Npontu's published docs (https://pay.npontu.com/documentation) document the
// *request* to POST /api/v1/pay in detail, but do NOT document the exact JSON
// body of the webhook callback they send to `callback_url`. To avoid silently
// failing to detect a real webhook because of a guessed field name, this
// parser checks several plausible variants for each value rather than
// assuming one fixed shape. The full raw payload is always logged so the
// actual shape can be confirmed from production logs and this parser
// tightened later if needed.

function parseNpontuWebhook(payload) {
  // Some gateways nest the transaction under "data" or "transaction";
  // others send it flat at the top level. Check both.
  const txData = payload?.data || payload?.transaction || payload;

  // IMPORTANT: we deliberately do NOT collapse these into one value with
  // "??". transaction_id is what WE send Npontu on the initiate-payment
  // call (our own `ref`, e.g. "USSD-..."), so it should always be the
  // primary key to look up. But some payloads may carry a *different*
  // identifier under "reference"/"order_id"/etc that is actually Npontu's
  // own internal id rather than ours, or — on the flip side — may omit
  // transaction_id and only carry the order reference. Collapsing these
  // into a single value with "??" means whichever field happens to come
  // first in the chain wins, and if that's the wrong one for a given
  // payload shape, the order lookup silently fails even though it really
  // is one of ours. So we keep every distinct candidate value and let the
  // caller try each one against the DB in turn.
  const refCandidates = [
    txData.transaction_id,
    txData.transactionId,
    txData.reference,
    txData.order_id,
    txData.orderId,
    txData.externalref,
    txData.external_reference,
    txData.txn_id,
  ]
    .filter((v) => v != null && String(v).trim() !== '')
    .map((v) => String(v).trim());

  // De-duplicate while preserving order (e.g. when transaction_id and
  // reference happen to carry the same value).
  const references = [...new Set(refCandidates)];

  const rawStatus =
    txData.status ?? txData.payment_status ?? txData.transaction_status ??
    txData.txstatus ?? '';

  const payer =
    txData.phone_number ?? txData.phoneNumber ?? txData.payer ??
    txData.msisdn ?? '';

  const amount = txData.amount ?? 0;

  // Seen in production: Npontu includes a pipe-delimited diagnostic string
  // here on failures, e.g. "TARGET_AUTHORIZATION_ERROR|<detail>". Captured
  // purely for logging — not used in any control-flow decision.
  const responseMessage = txData.responseMessage ?? txData.ourDesc ?? '';

  // Normalise status to one of: success | failed | pending | unknown
  const statusStr = String(rawStatus).trim().toUpperCase();
  let status = 'unknown';
  if (statusStr === 'SUCCESS' || statusStr === '1' || statusStr === 'COMPLETED' || statusStr === 'SUCCESSFUL') {
    status = 'success';
  } else if (statusStr === 'FAILED' || statusStr === 'CANCELLED' || statusStr === 'CANCELED' || statusStr === '2') {
    status = 'failed';
  } else if (statusStr === 'PENDING' || statusStr === '0' || statusStr === '') {
    status = 'pending';
  }

  // `reference` is kept for logging/back-compat — first candidate found,
  // same as before — but control flow below uses `references` (plural)
  // to try every candidate against the DB rather than trusting one guess.
  return { reference: references[0] ?? null, references, status, payer: String(payer || ''), amount, responseMessage };
}

// Look up an order by trying each candidate identifier in turn, checking
// preorders first then transactions (matching the original single-reference
// lookup order). Returns the matched reference (the one actually found in
// OUR database) plus the order row, or null if none of the candidates
// match anything we know about — which legitimately happens for webhooks
// belonging to other systems/integrations sharing the same Npontu account.
async function findOrderByAnyReference(references) {
  for (const candidate of references) {
    const preorderRow = await pool.query(
      `SELECT phone, quantity, voucher_type, amount FROM preorders WHERE reference=$1`,
      [candidate]
    );
    if (preorderRow.rowCount > 0) {
      return { matchedReference: candidate, source: 'preorders', row: preorderRow.rows[0] };
    }

    const txRow = await pool.query(
      `SELECT phone, quantity, voucher_type, amount FROM transactions WHERE reference=$1`,
      [candidate]
    );
    if (txRow.rowCount > 0) {
      return { matchedReference: candidate, source: 'transactions', row: txRow.rows[0] };
    }
  }
  return null;
}

async function handlePaymentWebhook(res, payload) {
  console.log('[Webhook] Received payload:', JSON.stringify(payload));

  const { references, status, payer, amount, responseMessage } = parseNpontuWebhook(payload);
  const logRef = references[0] ?? '(none)';

  if (status !== 'success') {
    console.log(
      `[Webhook] Non-success status (${status}) for ref ${logRef}` +
      (responseMessage ? ` — ${responseMessage}` : '')
    );

    // A definitive failure means any vouchers the USSD handler pre-assigned
    // while waiting for this webhook must be released back to stock, and
    // the transaction marked failed — otherwise they stay locked forever
    // even though the customer was never charged. Try every candidate
    // reference, since whichever one matches OUR transaction_ref is the
    // one that matters here.
    if (status === 'failed' && references.length > 0) {
      try {
        for (const candidate of references) {
          await pool.query(
            `UPDATE vouchers SET status='available', sold_to=NULL, transaction_ref=NULL, sold_at=NULL
             WHERE transaction_ref=$1 AND status='sold'`,
            [candidate]
          );
          await pool.query(
            `UPDATE transactions SET status='failed' WHERE reference=$1 AND status NOT IN ('success')`,
            [candidate]
          );
        }
      } catch (releaseErr) {
        console.error('[Webhook] Failed to release vouchers for failed payment:', releaseErr.message);
      }
    }

    return res.status(200).json({ received: true, note: `Non-success status: ${status}` });
  }

  if (references.length === 0) {
    console.warn('[Webhook] Could not determine any transaction reference from payload');
    return res.status(200).json({ received: true });
  }

  // Idempotency — skip if already fulfilled under ANY candidate reference
  for (const candidate of references) {
    const existing = await pool.query(
      `SELECT id FROM transactions WHERE reference=$1 AND status='success'`,
      [candidate]
    );
    if (existing.rowCount > 0) {
      console.log('[Webhook] Already processed:', candidate);
      return res.status(200).json({ received: true, note: 'Already processed' });
    }
  }

  // Load order — try every candidate reference against preorders, then
  // transactions, in that order, exactly as the original single-reference
  // lookup did. `reference` below becomes the one that ACTUALLY matched —
  // not just whichever field a single guess happened to pick.
  let reference, phone, qty, voucherType, orderAmount;

  const found = await findOrderByAnyReference(references);

  if (found) {
    reference = found.matchedReference;
    ({ phone, quantity: qty, voucher_type: voucherType, amount: orderAmount } = found.row);
    console.log(`[Webhook] Order found in ${found.source} via ref "${reference}":`, { phone, qty, voucherType });
  } else {
    // None of the candidate references match anything in our database.
    // This is expected (not an error) when the webhook belongs to a
    // different system/integration sharing the same Npontu Pay account —
    // raising an admin alert for every such webhook would be noise, not
    // signal, so we only alert when at least one candidate LOOKS like one
    // of ours (our "USSD-" prefix) yet still wasn't found — that case is
    // worth a human looking at.
    const looksLikeOurs = references.some((r) => r.startsWith('USSD-'));
    if (looksLikeOurs) {
      console.error('[Webhook] Reference looks like ours but no matching order found:', references);
      await sendAdminAlert(
        `WEBHOOK: Payment received (GHS ${amount}) but order not found! Ref(s): ${references.join(', ')}. Phone: ${payer}. Fulfill manually.`
      );
      return res.status(200).json({ received: true, note: 'Order not found — admin alerted' });
    }

    console.log('[Webhook] No matching order for any candidate reference — likely belongs to another system:', references);
    return res.status(200).json({ received: true, note: 'No matching order — ignored' });
  }

  if (!voucherType) {
    // Distinct from "no order found" above — we DID find a matching row,
    // but its voucher_type column is empty. A genuine data issue worth a
    // human looking at rather than a missing-order case.
    console.error('[Webhook] Order found but voucher_type is missing for ref', reference);
    await sendAdminAlert(
      `WEBHOOK: Payment received (GHS ${amount}) for ref ${reference} but voucher_type is missing on the order record. Phone: ${payer}. Fulfill manually.`
    );
    return res.status(200).json({ received: true, note: 'Order found but voucher_type missing — admin alerted' });
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
  // Npontu Pay sends payment confirmations to whatever callback_url we passed
  // on the initiate-payment call — which we point at this same endpoint, so
  // payment webhooks arrive here too, alongside Moolre USSD menu traffic.
  //
  // Moolre's USSD menu hits always carry sessionId + msisdn (see fields
  // below), so a payload that has a transaction reference + status but is
  // missing those USSD session fields is treated as a Npontu webhook. This
  // mirrors the defensive field-name matching in parseNpontuWebhook above —
  // again because Npontu's public docs don't pin down the exact webhook
  // body shape.
  const looksLikeUssdSession =
    (body.sessionId != null || body.session_id != null || body.SessionId != null) &&
    (body.msisdn != null || body.phone != null || body.PhoneNumber != null);

  const npontuRefField =
    body.transaction_id ?? body.transactionId ?? body.reference ??
    body.order_id ?? body.orderId ??
    body.data?.transaction_id ?? body.data?.reference ?? null;

  const npontuStatusField =
    body.status ?? body.payment_status ?? body.transaction_status ??
    body.data?.status ?? body.data?.payment_status ?? null;

  if (!looksLikeUssdSession && npontuRefField != null && npontuStatusField != null) {
    console.log('[USSD] Detected Npontu payment webhook — routing to fulfillment');
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
        `3. Retrieve Voucher\n` +
        `4. BECE Release Date\n` +
        `5. WASSCE Release Date\n` +
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
        if (choice === '3') {
          await setSession(sessionId, { stage: 'RETRIEVE_PHONE' });
          return respond('Enter phone number used for purchase\n(or press 0 to go back):', true);
        }
        if (choice === '4') {
          const msg = await getSetting('bece_release_message', 'BECE release date has not been announced yet. Check back soon.');
          return respond(msg, false);
        }
        if (choice === '5') {
          const msg = await getSetting('wassce_release_message', 'WASSCE release date has not been announced yet. Check back soon.');
          return respond(msg, false);
        }
        if (!typeMap[choice]) {
          return respond(
            `Choose an option:\n1. WASSCE (GHS ${prices.WASSCE})\n2. BECE (GHS ${prices.BECE})\n3. Retrieve Voucher\n4. BECE Release Date\n5. WASSCE Release Date\n0. Exit`,
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

        // ── Do NOT reserve vouchers or create a preorder here ─────────────
        // Payment has not happened yet — the customer still needs to approve
        // the MoMo prompt. Vouchers are assigned (or a preorder created) only
        // after payment is confirmed inside handlePaymentWebhook, once Npontu
        // posts its callback.

        // Map Moolre's USSD network code to Npontu Pay's network token.
        // USSD: 3=MTN, 5=AT, 6=Telecel → Npontu: 'mtn' | 'tigo' | 'telecel'
        // Npontu's docs only list mtn/telecel/tigo (no separate "AT" token),
        // so network 5 (AirtelTigo) is mapped to 'tigo' — the literal token
        // their docs use — rather than guessing an unlisted alternative.
        const networkToNpontu = { 3: 'mtn', 5: 'tigo', 6: 'telecel' };
        const npontuNetwork = networkToNpontu[network] || 'mtn';

        // Npontu Pay requires international format: 233XXXXXXXXX
        const payerInternational =
          msisdn.startsWith('+233') ? msisdn.slice(1) :
          msisdn.startsWith('233')  ? msisdn :
          msisdn.startsWith('0')    ? '233' + msisdn.slice(1) :
          msisdn;

        // Build our own callback URL from the incoming request so this works
        // correctly across environments (e.g. preview deployments) without
        // hardcoding a host. Falls back to NPONTU_CALLBACK_URL if the host
        // header is unavailable for any reason.
        const reqHost  = req.headers['x-forwarded-host'] || req.headers.host;
        const reqProto = req.headers['x-forwarded-proto'] || 'https';
        const callbackUrl = reqHost
          ? `${reqProto}://${reqHost}/api/ussds`
          : process.env.NPONTU_CALLBACK_URL;

        // Trigger MoMo PIN prompt via Npontu Pay
        let npontuFailed = false;
        try {
          const npontuAuth = Buffer.from(
            `${process.env.NPONTU_UID}:${process.env.NPONTU_PASS}`
          ).toString('base64');

          const payRes = await fetch('https://pay.npontu.com/api/v1/pay', {
            method: 'POST',
            headers: {
              // Npontu Pay's docs require HTTP Basic Auth on this endpoint:
              // username = NPONTU_UID, password = NPONTU_PASS.
              // (https://pay.npontu.com/documentation)
              'Authorization': `Basic ${npontuAuth}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              transaction_id: ref,
              network:        npontuNetwork,
              amount:         parseFloat(total),
              phone_number:   payerInternational,
              reference:      `${quantity}x ${voucherType} - WAEC GH Checkers`,
              callback_url:   callbackUrl,
            }),
          });

          const payData = await payRes.json().catch(() => ({}));
          console.log('[USSD] Npontu payment response:', payRes.status, JSON.stringify(payData));

          // Npontu's documented error responses (401/400) include an
          // "error" field. We treat any non-2xx HTTP status, or a body that
          // carries an "error" field, as the prompt NOT having been sent —
          // there is no documented success-body shape to positively match
          // against, so we fail closed rather than assume success.
          if (!payRes.ok || payData?.error) {
            npontuFailed = true;
            console.error(
              `[USSD] Npontu payment NOT accepted for ${ref} — ` +
              `httpStatus=${payRes.status} error=${payData?.error} message=${payData?.message}`
            );
          }
        } catch (payErr) {
          npontuFailed = true;
          console.error('[USSD] Npontu payment error:', payErr.message);
        }

        // Payment was never triggered — tell the customer instead of ending
        // the session as if it worked. Sending them away under a false
        // "check your phone" message is exactly what was costing conversions
        // to other vendors.
        if (npontuFailed) {
          return respond(
            'Sorry, we could not start your payment right now. Please try again shortly or contact support.',
            false
          );
        }

        // No polling fallback — Npontu Pay's callback_url webhook
        // (handlePaymentWebhook, above) is the sole source of payment
        // confirmation now. Npontu's docs don't expose a status-check
        // endpoint to poll against.

        return respond(
          `Please authorize the GHS ${total} MoMo payment prompt on your phone.\nVouchers will be sent via SMS after payment.`,
          false
        );
      }

      // ── Retrieve voucher — phone entry ────────────────────────────────────
      case 'RETRIEVE_PHONE': {
        if (choice === '0') {
          await setSession(sessionId, { stage: 'MENU' });
          return respond(
            `WAEC GH Checkers\n1. WASSCE (GHS ${prices.WASSCE})\n2. BECE (GHS ${prices.BECE})\n3. Retrieve Voucher\n4. BECE Release Date\n5. WASSCE Release Date\n0. Exit`,
            true
          );
        }
        // Normalise the phone number to 233XXXXXXXXX
        let lookupPhone = choice.replace(/\s/g, '');
        if (lookupPhone.startsWith('+')) lookupPhone = lookupPhone.slice(1);
        if (lookupPhone.startsWith('0')) lookupPhone = '233' + lookupPhone.slice(1);

        try {
          const result = await pool.query(
            `SELECT serial, pin, type FROM vouchers
             WHERE sold_to = $1 AND status = 'sold'
             ORDER BY sold_at DESC LIMIT 5`,
            [lookupPhone]
          );
          if (result.rowCount === 0) {
            return respond('No vouchers found for that number. Please check the number and try again.', false);
          }
          const lines = result.rows.map(v => `${v.type}: SN ${v.serial} PIN ${v.pin}`);
          return respond(`Your vouchers:\n${lines.join('\n')}`, false);
        } catch (dbErr) {
          console.error('[USSD] RETRIEVE_PHONE DB error:', dbErr.message);
          return respond('Error looking up vouchers. Please try again.', false);
        }
      }

      default:
        await setSession(sessionId, { stage: 'MENU' });
        return respond(
          `WAEC GH Checkers\n1. WASSCE (GHS ${prices.WASSCE})\n2. BECE (GHS ${prices.BECE})\n3. Retrieve Voucher\n4. BECE Release Date\n5. WASSCE Release Date\n0. Exit`,
          true
        );
    }

  } catch (err) {
    console.error('[USSD] Unhandled error:', err.message, err.stack);
    return res.status(200).json({ message: 'Service error. Please try again.', reply: false });
  }
}
