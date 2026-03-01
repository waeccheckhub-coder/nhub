import db from '../../lib/db';
import axios from 'axios';
import { getSetting } from '../../lib/settings';
import { checkAndAlertStock } from '../../lib/whatsapp';
import { formatPhone } from '../../lib/phone';

export const config = { api: { bodyParser: true } };

function getPortalLink(type) {
  const t = (type || '').toUpperCase();
  if (t.includes('WASSCE') || t.includes('NOVDEC')) return 'https://ghana.waecdirect.org';
  if (t.includes('BECE')) return 'https://eresults.waecgh.org';
  if (t.includes('CSSPS') || t.includes('PLACEMENT')) return 'https://www.cssps.gov.gh';
  return 'https://waeccardsonline.com';
}

async function sendSMS(to, message) {
  try {
    await axios.get('https://sms.arkesel.com/sms/api', {
      params: { action: 'send-sms', api_key: process.env.ARKESEL_API_KEY, to, from: 'CheckerCard', sms: message },
    });
  } catch (e) {
    console.error('SMS error:', e?.response?.data || e.message);
  }
}

async function fulfillOrder({ client, phone, quantity, type, amount, reference }) {
  // Lock available vouchers atomically
  const vouchers = await client.query(
    `SELECT id, serial, pin FROM vouchers
     WHERE type = $1 AND status = 'available'
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [type, quantity]
  );

  if (vouchers.rowCount < quantity) {
    return { fulfilled: false, available: vouchers.rowCount };
  }

  const voucherIds = vouchers.rows.map(v => v.id);
  await client.query(
    `UPDATE vouchers SET status = 'sold', sold_to = $1, sold_at = NOW(), transaction_ref = $2
     WHERE id = ANY($3)`,
    [phone, reference, voucherIds]
  );

  await client.query(
    `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'success', NOW())
     ON CONFLICT (reference) DO UPDATE SET status = 'success'`,
    [reference, phone, amount, quantity, type]
  );

  await client.query(
    `UPDATE preorders SET status = 'fulfilled', fulfilled_at = NOW()
     WHERE reference = $1 AND status IN ('initiated', 'pending')`,
    [reference]
  );

  return { fulfilled: true, vouchers: vouchers.rows };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Process FIRST, respond after — don't respond before processing in Next.js
  const payload = req.body;

  try {
    const reference = payload.reference || payload.transactionReference || payload.ref;
    const status = (payload.status || '').toLowerCase();

    if (!reference) {
      return res.status(400).json({ error: 'No reference in payload' });
    }

    const isSuccess = ['success', 'successful', 'completed', 'paid'].includes(status);
    if (!isSuccess) {
      return res.status(200).json({ received: true, note: 'Non-success status, no action taken' });
    }

    // Idempotency — if already processed, return OK immediately
    const existingTx = await db.query(
      `SELECT id FROM transactions WHERE reference = $1 AND status = 'success'`,
      [reference]
    );
    if (existingTx.rowCount > 0) {
      return res.status(200).json({ received: true, note: 'Already processed' });
    }

    // Look up the order — try preorders first (covers both web + USSD)
    const preorderRes = await db.query(
      `SELECT * FROM preorders WHERE reference = $1`,
      [reference]
    );

    let phone, quantity, type, amount;

    if (preorderRes.rowCount > 0) {
      // Order found in preorders table (saved by init-payment or USSD handler)
      const order = preorderRes.rows[0];
      phone = order.phone;
      quantity = order.quantity;
      type = order.voucher_type;
      amount = order.amount;
    } else {
      // No preorder found — this can happen if init-payment DB write failed.
      // Try to extract order details from the webhook payload itself.
      phone = payload.customerPhone || payload.phone || payload.msisdn || '';
      quantity = parseInt(payload.quantity || payload.qty || 1);
      type = payload.voucherType || payload.voucher_type || payload.description?.split('x ')?.[1]?.split(' ')?.[0] || '';
      amount = payload.amount || 0;

      if (!phone || !type) {
        // Cannot fulfill without knowing phone and type — log and alert admin
        console.error('WEBHOOK: Cannot fulfill — no preorder found and payload missing phone/type. Ref:', reference, 'Payload:', JSON.stringify(payload));
        const adminPhone = await getSetting('admin_whatsapp');
        if (adminPhone) {
          const { sendWhatsAppAlert } = await import('../../lib/whatsapp');
          await sendWhatsAppAlert(adminPhone,
            `🚨 *WEBHOOK ALERT — MANUAL ACTION REQUIRED*\n\nPayment received but order data not found!\nRef: ${reference}\nAmount: GHS ${amount}\n\nCheck Moolre dashboard and fulfill manually.`
          );
        }
        return res.status(200).json({ received: true, note: 'Payment logged, manual fulfillment needed' });
      }
    }

    // Fulfill with DB-level lock to prevent race conditions with verify-payment
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await fulfillOrder({ client, phone, quantity, type, amount, reference });
      await client.query('COMMIT');
      client.release();

      if (result.fulfilled) {
        // Send vouchers via SMS
        const voucherDetails = result.vouchers.map(v => `S/N: ${v.serial} PIN: ${v.pin}`).join('\n');
        await sendSMS(
          formatPhone(phone),
          `CheckerCard: Your ${type} voucher(s) are ready!\n\n${voucherDetails}\n\nCheck results: ${getPortalLink(type)}\n\nThank you!`
        );

        const adminPhone = await getSetting('admin_whatsapp');
        if (adminPhone) await checkAndAlertStock(db, adminPhone);

        return res.status(200).json({ received: true, fulfilled: true });

      } else {
        // Insufficient stock — keep as pending, notify customer + admin
        await db.query(
          `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
           VALUES ($1, $2, $3, $4, $5, 'preorder', NOW())
           ON CONFLICT (reference) DO UPDATE SET status = 'preorder'`,
          [reference, phone, amount, quantity, type]
        );
        await db.query(
          `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
           VALUES ($1, $2, 'Customer', $3, $4, $5, 'pending', NOW())
           ON CONFLICT (reference) DO UPDATE SET status = 'pending'`,
          [reference, phone, amount, quantity, type]
        );

        await sendSMS(
          formatPhone(phone),
          `CheckerCard: Payment confirmed (Ref: ${reference}). Your ${type} voucher(s) are temporarily out of stock. We will SMS them as soon as they are available. Thank you for your patience.`
        );

        const adminPhone = await getSetting('admin_whatsapp');
        if (adminPhone) {
          const { sendWhatsAppAlert } = await import('../../lib/whatsapp');
          await sendWhatsAppAlert(adminPhone,
            `📋 *PRE-ORDER — ACTION NEEDED*\nPhone: ${phone}\nType: ${type}\nQty: ${quantity}\nAmount: GHS ${amount}\nRef: ${reference}\n\n⚠️ Out of stock! Upload vouchers and fulfill from admin panel.`
          );
        }

        return res.status(200).json({ received: true, fulfilled: false, note: 'Out of stock — preorder created' });
      }

    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }

  } catch (err) {
    console.error('Webhook error:', err.message);
    // Still return 200 so Moolre doesn't retry indefinitely
    return res.status(200).json({ received: true, error: 'Processing failed — check server logs' });
  }
}
