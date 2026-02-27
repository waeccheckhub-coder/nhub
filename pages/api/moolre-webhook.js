import db from '../../lib/db';
import axios from 'axios';
import { getSetting } from '../../lib/settings';
import { checkAndAlertStock } from '../../lib/whatsapp';

/**
 * Moolre Webhook — called by Moolre when a payment status changes.
 * Set your webhook URL in Moolre dashboard to:
 * https://yoursite.com/api/moolre-webhook
 *
 * This handles asynchronous payment confirmation (backup to frontend verify).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const payload = req.body;
    const reference = payload.reference || payload.transactionReference || payload.ref;
    const status = (payload.status || '').toLowerCase();

    if (!reference) {
      return res.status(400).json({ error: 'No reference in webhook' });
    }

    const isSuccess = ['success', 'successful', 'completed', 'paid'].includes(status);
    if (!isSuccess) {
      // Payment failed or pending — just acknowledge
      return res.status(200).json({ received: true });
    }

    // Check if transaction already processed (idempotency)
    const existingTx = await db.query(
      "SELECT id FROM transactions WHERE reference = $1 AND status = 'success'",
      [reference]
    );
    if (existingTx.rowCount > 0) {
      return res.status(200).json({ received: true, alreadyProcessed: true });
    }

    // Look up pending preorder for this reference
    const preorderRes = await db.query(
      "SELECT * FROM preorders WHERE reference = $1 AND status = 'pending'",
      [reference]
    );

    if (preorderRes.rowCount > 0) {
      const order = preorderRes.rows[0];
      const { phone, quantity, voucher_type: type, amount } = order;

      // Try to fulfill immediately
      const vouchers = await db.query(
        'SELECT id, serial, pin FROM vouchers WHERE type = $1 AND status = $2 LIMIT $3',
        [type, 'available', quantity]
      );

      if (vouchers.rowCount >= quantity) {
        const voucherIds = vouchers.rows.map(v => v.id);
        await db.query(
          'UPDATE vouchers SET status = $1, sold_to = $2, sold_at = NOW() WHERE id = ANY($3)',
          ['sold', phone, voucherIds]
        );
        await db.query(
          "UPDATE preorders SET status = 'fulfilled', fulfilled_at = NOW() WHERE reference = $1",
          [reference]
        );
        await db.query(
          `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
           VALUES ($1, $2, $3, $4, $5, 'success', NOW()) ON CONFLICT (reference) DO NOTHING`,
          [reference, phone, amount, quantity, type]
        );

        // Send SMS
        const getPortalLink = (t) => {
          const u = (t || '').toUpperCase();
          if (u.includes('WASSCE') || u.includes('NOVDEC')) return 'https://ghana.waecdirect.org';
          if (u.includes('BECE')) return 'https://eresults.waecgh.org';
          if (u.includes('CSSPS') || u.includes('PLACEMENT')) return 'https://www.cssps.gov.gh';
          return 'https://waeccardsonline.com';
        };
        const voucherDetails = vouchers.rows.map(v => `S/N: ${v.serial} PIN: ${v.pin}`).join('\n');
        const formattedPhone = phone.startsWith('0') ? '233' + phone.slice(1) : phone;
        try {
          await axios.get(`https://sms.arkesel.com/sms/api`, {
            params: {
              action: 'send-sms', api_key: process.env.ARKESEL_API_KEY, to: formattedPhone, from: 'CheckerCard',
              sms: `CheckerCard: Your ${type} voucher(s) are ready!\n\n${voucherDetails}\n\nCheck Result: ${getPortalLink(type)}\n\nThank you!`,
            }
          });
        } catch (_) {}

        const adminPhone = await getSetting('admin_whatsapp');
        if (adminPhone) await checkAndAlertStock(db, adminPhone);
      }
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Webhook error:', error.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}
