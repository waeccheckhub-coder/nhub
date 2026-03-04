// POST /api/ussd — Moolre USSD callback handler with DB-backed sessions
//
// ROOT CAUSE FIX: bodyParser is disabled and body is parsed manually.
// Moolre sends USSD requests as application/x-www-form-urlencoded, but
// Next.js's default body parser only handles that if Content-Type is set
// correctly. Manual parsing handles JSON, form-encoded, and anything else.
//
// MOOLRE FIELDS:
//   sessionId  — unique session ID (persists across interaction)
//   new        — true / "true" on first request
//   msisdn     — customer phone e.g. "233241235993"
//   message    — what the user typed (empty string on first request)
//
// RESPONSE: { message: string, reply: boolean }

import pool from '../../lib/db';
import { getPrices } from '../../lib/settings';
import { sendAdminAlert } from '../../lib/alerts';

// CRITICAL: disable Next.js body parser so we can handle any content-type
export const config = { api: { bodyParser: false } };

async function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk.toString(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      // Try JSON
      try { return resolve(JSON.parse(raw)); } catch (_) {}
      // Try form-encoded
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

// ── DB session helpers ──────────────────────────────────────────────────────

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
    if (r.rows.length === 0) return null; // null = no session row = new session
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

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Gateways often ping GET to validate the URL
  if (req.method === 'GET') return res.status(200).json({ status: 'ok' });
  if (req.method !== 'POST') return res.status(405).end();

  // Parse body manually — works for JSON, form-encoded, or any content-type
  let body = {};
  try {
    body = await parseBody(req);
  } catch (err) {
    console.error('[USSD] parseBody error:', err.message);
  }

  console.log('[USSD] body:', JSON.stringify(body));

  // Safely extract and coerce every field — never trust undefined
  const sessionId = body.sessionId   != null ? String(body.sessionId).trim()   :
                    body.session_id  != null ? String(body.session_id).trim()  :
                    body.SessionId   != null ? String(body.SessionId).trim()   : '';

  const msisdn    = body.msisdn      != null ? String(body.msisdn).trim()      :
                    body.phone       != null ? String(body.phone).trim()       :
                    body.PhoneNumber != null ? String(body.PhoneNumber).trim() : '';

  // isNew: Moolre may send boolean true, integer 1, or strings "true"/"1"
  const isNewFlag =
    body.new   === true || body.new   === 'true' || body.new   === 1 || body.new   === '1' ||
    body.isNew === true || body.isNew === 'true' || body.isNew === 1 || body.isNew === '1';

  // Moolre sends accumulated USSD string like "1*2*1" — only want the LAST segment
  const rawMsg    = body.message ?? body.input ?? body.userInput ?? '';
  const userInput = rawMsg != null && String(rawMsg).includes('*')
    ? String(rawMsg).split('*').pop().trim()
    : String(rawMsg ?? '').trim();

  // isNew = flag says so (any truthy form) OR no session row in DB (checked below)
  const isNew = isNewFlag;

  console.log(`[USSD] sessionId="${sessionId}" isNew=${isNew} msisdn="${msisdn}" input="${userInput}"`);

  if (!sessionId) {
    console.error('[USSD] Missing sessionId in body:', JSON.stringify(body));
    return res.status(200).json({ message: 'Session error. Please try again.', reply: false });
  }

  const respond = async (message, keepOpen = true) => {
    if (!keepOpen) await clearSession(sessionId);
    console.log(`[USSD] reply=${keepOpen}: ${String(message).replace(/\n/g, '|').slice(0, 80)}`);
    return res.status(200).json({ message, reply: keepOpen });
  };

  try {
    const prices = await getPrices();

    // ── New session → show main menu ─────────────────────────────────────
    // Look up DB — null means no row exists yet (genuinely first request)
    const existingSession = await getSession(sessionId);

    // Treat as new if flag says so OR no DB record found
    const isNewSession = isNew || existingSession === null;

    console.log(`[USSD] isNewSession=${isNewSession} existingStage=${existingSession?.stage ?? 'none'}`);

    if (isNewSession) {
      await setSession(sessionId, { stage: 'MENU' });
      return respond(
        `Welcome to WAEC GH Checkers\n` +
        `1. WASSCE (GHS ${prices.WASSCE})\n` +
        `2. BECE (GHS ${prices.BECE})\n` +
        `3. CSSPS (GHS ${prices.CSSPS})\n` +
        `0. Exit`,
        true
      );
    }

    const session = existingSession;
    const choice  = userInput;

    console.log(`[USSD] stage="${session.stage}" choice="${choice}"`);

    switch (session.stage) {

      case 'MENU': {
        const typeMap = { '1': 'WASSCE', '2': 'BECE', '3': 'CSSPS' };
        if (choice === '0') return respond('Thank you. Goodbye!', false);
        if (!typeMap[choice]) {
          return respond(
            `Choose an option:\n1. WASSCE (GHS ${prices.WASSCE})\n2. BECE (GHS ${prices.BECE})\n3. CSSPS (GHS ${prices.CSSPS})\n0. Exit`,
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
        const total     = (unitPrice * qty).toFixed(2);
        await setSession(sessionId, {
          stage:       'CONFIRM',
          voucherType: session.voucherType,
          quantity:    qty,
        });
        return respond(
          `${qty}x ${session.voucherType} = GHS ${total}\nMoMo: ${msisdn}\n\n1. Confirm & Pay\n2. Cancel`,
          true
        );
      }

      case 'CONFIRM': {
        if (choice === '2') return respond('Cancelled. Goodbye!', false);
        if (choice !== '1') return respond('Press 1 to confirm or 2 to cancel:', true);

        const voucherType = session.voucherType ? String(session.voucherType) : null;
        const quantity    = session.quantity    ? parseInt(session.quantity, 10) : 0;
        const total       = (parseFloat(prices[voucherType] || 0) * quantity).toFixed(2);

        if (!voucherType || !quantity) {
          console.error('[USSD] CONFIRM: missing session data', JSON.stringify(session));
          return respond('Session expired. Please dial again.', false);
        }

        const safeSuffix = String(sessionId).replace(/\W/g, '').slice(-6).toUpperCase() || 'USSD';
        const ref = `USSD-${Date.now()}-${safeSuffix}`;

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const available = await client.query(
            `SELECT id, serial, pin FROM vouchers
             WHERE type = $1 AND status = 'available'
             ORDER BY id ASC LIMIT $2
             FOR UPDATE SKIP LOCKED`,
            [voucherType, quantity]
          );

          if (available.rows.length >= quantity) {
            const ids = available.rows.map(v => v.id);
            await client.query(
              `UPDATE vouchers
               SET status='sold', sold_to=$1, transaction_ref=$2, sold_at=NOW()
               WHERE id=ANY($3)`,
              [msisdn, ref, ids]
            );
            await client.query(
              `INSERT INTO transactions
                 (reference, phone, amount, quantity, voucher_type, status, created_at)
               VALUES ($1,$2,$3,$4,$5,'pending',NOW())
               ON CONFLICT (reference) DO NOTHING`,
              [ref, msisdn, parseFloat(total), quantity, voucherType]
            );
          } else {
            await client.query(
              `INSERT INTO preorders
                 (reference, phone, name, amount, quantity, voucher_type, status, created_at)
               VALUES ($1,$2,'',$3,$4,$5,'pending',NOW())
               ON CONFLICT (reference) DO NOTHING`,
              [ref, msisdn, parseFloat(total), quantity, voucherType]
            );
            await client.query(
              `INSERT INTO transactions
                 (reference, phone, amount, quantity, voucher_type, status, created_at)
               VALUES ($1,$2,$3,$4,$5,'preorder',NOW())
               ON CONFLICT (reference) DO NOTHING`,
              [ref, msisdn, parseFloat(total), quantity, voucherType]
            );
            await sendAdminAlert(
              `USSD Preorder: ${voucherType} x${quantity} GHS ${total} from ${msisdn}. Ref: ${ref}`
            );
          }

          await client.query('COMMIT');
          client.release();

          // Moolre handles the MoMo PIN prompt automatically within their USSD session
          // after we return reply:false. The webhook fires when payment completes.
          return respond(
            `Confirm GHS ${total} payment\nfrom ${msisdn}?\nEnter MoMo PIN to pay.\nRef: ${ref.slice(-8)}`,
            false
          );

        } catch (err) {
          await client.query('ROLLBACK');
          client.release();
          console.error('[USSD] CONFIRM DB error:', err.message);
          return respond('An error occurred. Please try again.', false);
        }
      }

      default:
        await setSession(sessionId, { stage: 'MENU' });
        return respond(
          `WAEC GH Checkers\n1. WASSCE\n2. BECE\n3. CSSPS\n0. Exit`,
          true
        );
    }

  } catch (err) {
    console.error('[USSD] Unhandled error:', err.message, err.stack);
    return res.status(200).json({ message: 'Service error. Please try again.', reply: false });
  }
}
