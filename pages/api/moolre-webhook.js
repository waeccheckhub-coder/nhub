import db from '../../lib/db';
import axios from 'axios';
import { getSetting } from '../../lib/settings';
import { checkAndAlertStock } from '../../lib/whatsapp';

/**
 * Moolre Webhook
 * Set your webhook URL in the Moolre dashboard to: https://yourdomain.com/api/moolre-webhook
 * This handles both web-initiated and USSD-initiated payments.
 */

export const config = { api: { bodyParser: true } };

const MOOLRE_API_BASE = process.env.MOOLRE_API_BASE || 'https://api.moolre.com/v2';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Acknowledge immediately — Moolre expects a fast 200
  res.status(200).json({ received: true });

  try {
    const payload = req.body;
    const reference = payload.reference || payload.transactionReference || payload.ref;
    const status = (payload.status || '').toLowerCase();

    if (!reference) return;

    const isSuccess = ['success', 'successful', 'completed', 'paid'].includes(status);
    if (!isSuccess) return;

    // Idempotency — skip if already processed
    const existingTx = await db.query(
      `SELECT id FROM transactions WHERE reference = $1 AND status = 'success'`,
      [reference]
    );
    if (existingTx.rowCount > 0) return;

    // Look up pending preorder for this reference (covers both web pre-orders and USSD payments)
    const preorderRes = await db.query(
      `SELECT * FROM preorders WHERE reference = $1 AND status = 'pending'`,
      [reference]
    );

    if (preorderRes.rowCount === 0) {
      // No preorder — this was a direct web payment already verified by /api/verify-payment
      // Update transaction status if it exists as pending
      await db.query(
        `UPDATE transactions SET status = 'success' WHERE reference = $1 AND status = 'pending'`,
        [reference]
      );
      return;
    }

    const order = preorderRes.rows[0];
    const { phone, quantity, voucher_type: type, amount } = order;

    // Try to fulfill immediately
    const vouchers = await db.query(
      `SELECT id, serial, pin FROM vouchers WHERE type = $1 AND status = 'available' LIMIT $2`,
      [type, quantity]
    );

    if (vouchers.rowCount >= quantity) {
      // Fulfill now
      const voucherIds = vouchers.rows.map(v => v.id);
      await db.query(
        `UPDATE vouchers SET status = 'sold', sold_to = $1, sold_at = NOW(), transaction_ref = $2 WHERE id = ANY($3)`,
        [phone, reference, voucherIds]
      );
      await db.query(
        `UPDATE preorders SET status = 'fulfilled', fulfilled_at = NOW() WHERE reference = $1`,
        [reference]
      );
      await db.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'success', NOW())
         ON CONFLICT (reference) DO UPDATE SET status = 'success'`,
        [reference, phone, amount, quantity, type]
      );

      // Send SMS
      const voucherDetails = vouchers.rows.map(v => `S/N: ${v.serial} PIN: ${v.pin}`).join('\n');
      const portalLink = getPortalLink(type);
      const formattedPhone = phone.startsWith('0') ? '233' + phone.slice(1) : phone;

      await sendSMS(
        formattedPhone,
        `CheckerCard: Your ${type} voucher(s) are ready!\n\n${voucherDetails}\n\nCheck results: ${portalLink}\n\nThank you!`
      );

      // Stock alerts
      const adminPhone = await getSetting('admin_whatsapp');
      if (adminPhone) await checkAndAlertStock(db, adminPhone);

    } else {
      // Not enough stock — keep as pending preorder, update transaction
      await db.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'preorder', NOW())
         ON CONFLICT (reference) DO UPDATE SET status = 'preorder'`,
        [reference, phone, amount, quantity, type]
      );

      // Notify customer their order is pending stock
      const formattedPhone = phone.startsWith('0') ? '233' + phone.slice(1) : phone;
      await sendSMS(
        formattedPhone,
        `CheckerCard: Payment confirmed (Ref: ${reference}). Your ${type} voucher(s) are temporarily out of stock. We will SMS them as soon as they are available. Thank you for your patience.`
      );

      // Alert admin
      const adminPhone = await getSetting('admin_whatsapp');
      if (adminPhone) {
        const { sendWhatsAppAlert } = await import('../../lib/whatsapp');
        await sendWhatsAppAlert(
          adminPhone,
          `📋 *NEW PRE-ORDER*\nPhone: ${phone}\nType: ${type}\nQty: ${quantity}\nAmount: GHS ${amount}\nRef: ${reference}\n\n⚠️ Stock insufficient. Upload vouchers and fulfill from admin panel.`
        );
      }
    }

  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
}

async function sendSMS(to, message) {
  try {
    await axios.get(`https://sms.arkesel.com/sms/api`, {
      params: {
        action: 'send-sms',
        api_key: process.env.ARKESEL_API_KEY,
        to,
        from: 'CheckerCard',
        sms: message,
      },
    });
  } catch (e) {
    console.error('SMS error:', e?.response?.data || e.message);
  }
}

function getPortalLink(type) {
  const t = (type || '').toUpperCase();
  if (t.includes('WASSCE') || t.includes('NOVDEC')) return 'https://ghana.waecdirect.org';
  if (t.includes('BECE')) return 'https://eresults.waecgh.org';
  if (t.includes('CSSPS') || t.includes('PLACEMENT')) return 'https://www.cssps.gov.gh';
  return 'https://waeccardsonline.com';
}
