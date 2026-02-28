// POST /api/ussd
// Moolre USSD callback — confirmed field names from docs:
//
// REQUEST:
//   sessionId  — unique session ID (persists across interaction)
//   new        — boolean, true if this is the first request
//   msisdn     — customer phone number e.g. "233241235993"
//   network    — integer: 3=MTN, 5=AT, 6=Telecel
//   message    — string the user typed (empty on first request)
//   extension  — the extension dialled
//   data       — additional data
//
// RESPONSE:
//   message    — text to display on screen (keep under 160 chars)
//   reply      — boolean: true=keep session open, false=end session
//
// ⚠️  In-memory SESSIONS only works on persistent servers (PM2/VPS).
//     On Vercel/serverless, store sessions in the DB using the table below:
//
// CREATE TABLE IF NOT EXISTS ussd_sessions (
//   session_id VARCHAR(100) PRIMARY KEY,
//   stage VARCHAR(50) NOT NULL DEFAULT 'MENU',
//   voucher_type VARCHAR(50),
//   quantity INTEGER DEFAULT 1,
//   updated_at TIMESTAMP DEFAULT NOW()
// );

import pool from '../../lib/db';
import { getPrices } from '../../lib/settings';
import { sendAdminAlert } from '../../lib/alerts';

// In-memory store (replace with DB queries for serverless)
const SESSIONS = {};

function getSession(sessionId) {
  return SESSIONS[sessionId] || { stage: 'MENU' };
}
function setSession(sessionId, data) {
  SESSIONS[sessionId] = data;
}
function clearSession(sessionId) {
  delete SESSIONS[sessionId];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Confirmed Moolre USSD field names
  const { sessionId, new: isNew, msisdn, message: userInput } = req.body;

  if (!sessionId) {
    return res.status(400).json({ message: 'Invalid request', reply: false });
  }

  const respond = (message, keepOpen = true) => {
    if (!keepOpen) clearSession(sessionId);
    return res.json({ message, reply: keepOpen });
  };

  const prices = await getPrices();

  // New session — show main menu
  if (isNew) {
    setSession(sessionId, { stage: 'MENU' });
    return respond(
      `Welcome to WAEC GH Checkers\n` +
      `1. WASSCE (GHS ${prices.WASSCE})\n` +
      `2. BECE (GHS ${prices.BECE})\n` +
      `3. CSSPS (GHS ${prices.CSSPS})\n` +
      `0. Exit`,
      true
    );
  }

  const session = getSession(sessionId);

  switch (session.stage) {
    case 'MENU': {
      const choice = userInput?.trim();
      const typeMap = { '1': 'WASSCE', '2': 'BECE', '3': 'CSSPS' };

      if (choice === '0') return respond('Thank you. Goodbye!', false);

      if (!typeMap[choice]) {
        return respond(
          `Invalid choice. Please select:\n1. WASSCE\n2. BECE\n3. CSSPS\n0. Exit`,
          true
        );
      }

      const voucherType = typeMap[choice];
      setSession(sessionId, { stage: 'SELECT_QTY', voucherType });
      return respond(
        `You selected ${voucherType} @ GHS ${prices[voucherType]} each.\nHow many vouchers? (1-5)`,
        true
      );
    }

    case 'SELECT_QTY': {
      const qty = parseInt(userInput?.trim());
      if (isNaN(qty) || qty < 1 || qty > 5) {
        return respond('Please enter a number between 1 and 5:', true);
      }

      const { voucherType } = session;
      const total = (prices[voucherType] * qty).toFixed(2);
      setSession(sessionId, { stage: 'CONFIRM', voucherType, quantity: qty, total });

      return respond(
        `Confirm order:\n${qty}x ${voucherType} = GHS ${total}\nPhone: ${msisdn}\n\n1. Confirm\n2. Cancel`,
        true
      );
    }

    case 'CONFIRM': {
      const { voucherType, quantity, total } = session;
      const choice = userInput?.trim();

      if (choice === '2') return respond('Order cancelled. Goodbye!', false);
      if (choice !== '1') return respond('Please press 1 to confirm or 2 to cancel:', true);

      // Save preorder — Moolre collects payment within their USSD session.
      // The webhook fires and delivers vouchers when payment completes.
      try {
        const ref = `ussd_${sessionId}_${Date.now()}`;
        await pool.query(
          `INSERT INTO preorders (reference, phone, amount, quantity, voucher_type, status)
           VALUES ($1, $2, $3, $4, $5, 'pending') ON CONFLICT (reference) DO NOTHING`,
          [ref, msisdn, parseFloat(total), quantity, voucherType]
        );
        await pool.query(
          `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
           VALUES ($1, $2, $3, $4, $5, 'pending') ON CONFLICT (reference) DO NOTHING`,
          [ref, msisdn, parseFloat(total), quantity, voucherType]
        );

        await sendAdminAlert(
          `USSD Order: ${voucherType} x${quantity} GHS ${total} from ${msisdn}. Ref: ${ref}`
        );

        return respond(
          `Order placed! GHS ${total} will be deducted from your MoMo.\n` +
          `You will receive your voucher(s) via SMS after payment.\n` +
          `Ref: ${ref.slice(-8)}`,
          false
        );
      } catch (err) {
        console.error('USSD confirm error:', err);
        return respond('An error occurred. Please try again later.', false);
      }
    }

    default:
      setSession(sessionId, { stage: 'MENU' });
      return respond(`WAEC GH Checkers\n1. WASSCE\n2. BECE\n3. CSSPS\n0. Exit`, true);
  }
}
