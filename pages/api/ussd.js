// POST /api/ussd
// Moolre USSD callback handler with DB-backed sessions (works on Vercel/serverless).
//
// MOOLRE REQUEST FIELDS:
//   sessionId  — unique session ID (persists across the interaction)
//   new        — boolean, true on first request
//   msisdn     — customer phone e.g. "233241235993"
//   network    — integer: 3=MTN, 5=AT, 6=Telecel
//   message    — what the user typed (empty on first request)
//
// RESPONSE FORMAT:
//   { message: string, reply: boolean }
//   reply: true = keep session open, false = end session
//
// DB TABLE REQUIRED — run this once in Neon:
// CREATE TABLE IF NOT EXISTS ussd_sessions (
//   session_id  VARCHAR(100) PRIMARY KEY,
//   stage       VARCHAR(50)  NOT NULL DEFAULT 'MENU',
//   voucher_type VARCHAR(50),
//   quantity    INTEGER,
//   total       NUMERIC(10,2),
//   updated_at  TIMESTAMP DEFAULT NOW()
// );

import pool from '../../lib/db';
import { getPrices } from '../../lib/settings';
import { sendAdminAlert } from '../../lib/alerts';

// --- DB session helpers ---

async function getSession(sessionId) {
  const result = await pool.query(
    'SELECT stage, voucher_type, quantity, total FROM ussd_sessions WHERE session_id = $1',
    [sessionId]
  );
  if (result.rows.length === 0) return { stage: 'MENU' };
  const r = result.rows[0];
  return {
    stage: r.stage,
    voucherType: r.voucher_type,
    quantity: r.quantity,
    total: r.total,
  };
}

async function setSession(sessionId, data) {
  await pool.query(
    `INSERT INTO ussd_sessions (session_id, stage, voucher_type, quantity, total, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (session_id) DO UPDATE
     SET stage = $2, voucher_type = $3, quantity = $4, total = $5, updated_at = NOW()`,
    [sessionId, data.stage, data.voucherType || null, data.quantity || null, data.total || null]
  );
}

async function clearSession(sessionId) {
  await pool.query('DELETE FROM ussd_sessions WHERE session_id = $1', [sessionId]);
}

// --- Main handler ---

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { sessionId, new: isNew, msisdn, message: userInput } = req.body;

  if (!sessionId) {
    return res.status(400).json({ message: 'Invalid request.', reply: false });
  }

  const respond = async (message, keepOpen = true) => {
    if (!keepOpen) await clearSession(sessionId);
    return res.json({ message, reply: keepOpen });
  };

  // Ensure table exists (no-op after first run)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ussd_sessions (
      session_id   VARCHAR(100) PRIMARY KEY,
      stage        VARCHAR(50)  NOT NULL DEFAULT 'MENU',
      voucher_type VARCHAR(50),
      quantity     INTEGER,
      total        NUMERIC(10,2),
      updated_at   TIMESTAMP DEFAULT NOW()
    )
  `);

  const prices = await getPrices();

  // New session — show main menu
  if (isNew) {
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

  const session = await getSession(sessionId);
  const choice = userInput?.trim();

  switch (session.stage) {

    case 'MENU': {
      const typeMap = { '1': 'WASSCE', '2': 'BECE', '3': 'CSSPS' };

      if (choice === '0') return respond('Thank you. Goodbye!', false);

      if (!typeMap[choice]) {
        return respond(
          `Invalid choice.\n1. WASSCE\n2. BECE\n3. CSSPS\n0. Exit`,
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
      const qty = parseInt(choice);
      if (isNaN(qty) || qty < 1 || qty > 5) {
        return respond('Enter a number between 1 and 5:', true);
      }

      const total = (prices[session.voucherType] * qty).toFixed(2);
      await setSession(sessionId, {
        stage: 'CONFIRM',
        voucherType: session.voucherType,
        quantity: qty,
        total,
      });

      return respond(
        `${qty}x ${session.voucherType} = GHS ${total}\n` +
        `MoMo: ${msisdn}\n\n` +
        `1. Confirm & Pay\n2. Cancel`,
        true
      );
    }

    case 'CONFIRM': {
      if (choice === '2') return respond('Cancelled. Goodbye!', false);
      if (choice !== '1') return respond('Press 1 to confirm or 2 to cancel:', true);

      const { voucherType, quantity, total } = session;

      try {
        const ref = `ussd_${sessionId}_${Date.now()}`;

        // Check stock — fulfill immediately if available, otherwise preorder
        const client = await pool.connect();
        let fulfilled = false;

        try {
          const voucherResult = await client.query(
            `SELECT id, serial, pin FROM vouchers
             WHERE type = $1 AND status = 'available'
             ORDER BY id ASC LIMIT $2
             FOR UPDATE SKIP LOCKED`,
            [voucherType, quantity]
          );

          if (voucherResult.rows.length >= quantity) {
            // Stock available — mark sold immediately
            const ids = voucherResult.rows.map(v => v.id);
            await client.query(
              `UPDATE vouchers SET status = 'sold', sold_to = $1, transaction_ref = $2, sold_at = NOW()
               WHERE id = ANY($3)`,
              [msisdn, ref, ids]
            );

            await client.query(
              `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
               VALUES ($1, $2, $3, $4, $5, 'pending')`,
              [ref, msisdn, parseFloat(total), quantity, voucherType]
            );

            fulfilled = true;
          } else {
            // Out of stock — create preorder
            await client.query(
              `INSERT INTO preorders (reference, phone, amount, quantity, voucher_type, status)
               VALUES ($1, $2, $3, $4, $5, 'pending') ON CONFLICT (reference) DO NOTHING`,
              [ref, msisdn, parseFloat(total), quantity, voucherType]
            );
            await client.query(
              `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
               VALUES ($1, $2, $3, $4, $5, 'preorder') ON CONFLICT (reference) DO NOTHING`,
              [ref, msisdn, parseFloat(total), quantity, voucherType]
            );

            await sendAdminAlert(
              `USSD Preorder: ${voucherType} x${quantity} GHS ${total} from ${msisdn}. Ref: ${ref}`
            );
          }
        } finally {
          client.release();
        }

        // Moolre collects MoMo payment within their USSD session after this response.
        // The webhook fires on payment success and updates the transaction to 'success'
        // and sends the SMS vouchers.
        return respond(
          `Order confirmed!\n` +
          `GHS ${total} will be deducted from your MoMo.\n` +
          `Voucher(s) sent via SMS after payment.\n` +
          `Ref: ${ref.slice(-8)}`,
          false
        );

      } catch (err) {
        console.error('USSD confirm error:', err);
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
}
