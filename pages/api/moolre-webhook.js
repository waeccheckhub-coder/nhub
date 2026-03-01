// POST /api/moolre-webhook
// Moolre fires this when a payment completes.
//
// Actual Moolre webhook payload shape:
// {
//   status: 1, code: "P01", message: "Transaction Successful",
//   data: {
//     txstatus: 1,           // 1=success, 0=pending, 2=failed
//     payer: "233xxxxxxxx",  // customer phone
//     amount: "30.00",
//     externalref: "WAEC-WASSCE-xxx", // YOUR reference
//     secret: "...",         // verify against MOOLRE_WEBHOOK_SECRET
//     transactionid: 123456,
//     ts: "2024-11-27 21:11:29"
//   }
// }

import db from '../../lib/db';
import { formatPhone } from '../../lib/phone';
import { sendAdminAlert, checkAndAlertStock } from '../../lib/alerts';

export const config = { api: { bodyParser: true } };

function getPortalLink(type) {
  const t = (type || '').toUpperCase();
  if (t.includes('WASSCE') || t.includes('NOVDEC')) return 'https://ghana.waecdirect.org';
  if (t.includes('BECE')) return 'https://eresults.waecgh.org';
  if (t.includes('CSSPS') || t.includes('PLACEMENT')) return 'https://www.cssps.gov.gh';
  return 'https://waeccardsonline.com';
}

async function sendVoucherSMS(phone, vouchers, voucherType) {
  const lines = vouchers.map((v, i) => `${i + 1}. S/N: ${v.serial} PIN: ${v.pin}`).join('\n');
  const message =
    `CheckerCard: Your ${voucherType} voucher(s) are ready!\n\n` +
    `${lines}\n\n` +
    `Check results: ${getPortalLink(voucherType)}\n\nThank you!`;

  try {
    const response = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: { 'api-key': process.env.ARKESEL_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'WAEC-GH', message, recipients: [formatPhone(phone)] }),
    });
    const result = await response.json();
    if (result.status !== 'success') {
      console.error('Arkesel SMS error (webhook):', JSON.stringify(result));
    }
  } catch (e) {
    console.error('Webhook SMS send failed:', e.message);
  }
}

export default async function handler(req, res) {
  // Always respond 200 quickly — Moolre will retry on non-200
  if (req.method !== 'POST') return res.status(200).end();

  const payload = req.body;

  try {
    // ── PARSE MOOLRE WEBHOOK PAYLOAD ──────────────────────────────────────
    const txData = payload?.data;
    if (!txData) {
      console.warn('Webhook: empty data field', JSON.stringify(payload));
      return res.status(200).json({ received: true });
    }

    const { txstatus, externalref: reference, payer, amount, secret } = txData;

    // Verify secret if configured
    if (process.env.MOOLRE_WEBHOOK_SECRET && secret !== process.env.MOOLRE_WEBHOOK_SECRET) {
      console.warn('Webhook: secret mismatch — ignoring');
      return res.status(200).json({ received: true });
    }

    // Only process successful payments
    if (txstatus !== 1) {
      return res.status(200).json({ received: true, note: 'Non-success txstatus, ignored' });
    }

    if (!reference) {
      console.warn('Webhook: no externalref in payload', JSON.stringify(payload));
      return res.status(200).json({ received: true });
    }

    // ── IDEMPOTENCY ────────────────────────────────────────────────────────
    const existingTx = await db.query(
      `SELECT id FROM transactions WHERE reference = $1 AND status = 'success'`,
      [reference]
    );
    if (existingTx.rowCount > 0) {
      return res.status(200).json({ received: true, note: 'Already processed' });
    }

    // ── LOAD ORDER DETAILS from preorders table ────────────────────────────
    const preorderRow = await db.query(
      `SELECT phone, quantity, voucher_type, amount FROM preorders WHERE reference = $1`,
      [reference]
    );

    let phone, qty, voucherType, orderAmount;

    if (preorderRow.rowCount > 0) {
      ({ phone, quantity: qty, voucher_type: voucherType, amount: orderAmount } = preorderRow.rows[0]);
    } else {
      // Fallback: use payer from webhook payload
      // voucherType cannot be reliably inferred without a DB record
      phone = payer || '';
      qty = 1;
      voucherType = null;
      orderAmount = amount || 0;
    }

    if (!voucherType) {
      console.error('Webhook: cannot determine voucherType for ref', reference, '— manual action needed');
      await sendAdminAlert(
        `WEBHOOK ALERT: Payment received (GHS ${amount}) but order not found! Ref: ${reference}. Phone: ${payer}. Check Moolre dashboard and fulfill manually.`
      );
      return res.status(200).json({ received: true, note: 'Order not found — admin alerted' });
    }

    qty = parseInt(qty);

    // ── ASSIGN VOUCHERS atomically ─────────────────────────────────────────
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const vouchers = await client.query(
        `SELECT id, serial, pin FROM vouchers
         WHERE type = $1 AND status = 'available'
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [voucherType, qty]
      );

      if (vouchers.rowCount < qty) {
        // Out of stock — ensure preorder and transaction records exist
        await client.query(
          `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
           VALUES ($1, $2, '', $3, $4, $5, 'pending', NOW())
           ON CONFLICT (reference) DO UPDATE SET status = 'pending'`,
          [reference, phone, parseFloat(orderAmount), qty, voucherType]
        );
        await client.query(
          `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
           VALUES ($1, $2, $3, $4, $5, 'preorder', NOW())
           ON CONFLICT (reference) DO UPDATE SET status = 'preorder'`,
          [reference, phone, parseFloat(orderAmount), qty, voucherType]
        );
        await client.query('COMMIT');
        client.release();

        // Notify customer
        try {
          await fetch('https://sms.arkesel.com/api/v2/sms/send', {
            method: 'POST',
            headers: { 'api-key': process.env.ARKESEL_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sender: 'WAEC-GH',
              message: `CheckerCard: Payment confirmed (Ref: ${reference.slice(-8)}). Your ${voucherType} voucher(s) are temporarily out of stock and will be SMS'd as soon as available. Thank you!`,
              recipients: [formatPhone(phone)],
            }),
          });
        } catch (e) { console.error('Out-of-stock SMS error:', e.message); }

        await sendAdminAlert(
          `OUT OF STOCK (webhook): ${voucherType} x${qty} from ${phone}. Ref: ${reference}. Upload vouchers!`
        );

        return res.status(200).json({ received: true, fulfilled: false, note: 'Out of stock — preorder created' });
      }

      // Mark vouchers as sold
      const ids = vouchers.rows.map(v => v.id);
      await client.query(
        `UPDATE vouchers SET status = 'sold', sold_to = $1, sold_at = NOW(), transaction_ref = $2
         WHERE id = ANY($3)`,
        [phone, reference, ids]
      );

      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'success', NOW())
         ON CONFLICT (reference) DO UPDATE SET status = 'success'`,
        [reference, phone, parseFloat(orderAmount), qty, voucherType]
      );

      await client.query(
        `UPDATE preorders SET status = 'fulfilled', fulfilled_at = NOW()
         WHERE reference = $1 AND status IN ('initiated', 'pending')`,
        [reference]
      );

      await client.query('COMMIT');
      client.release();

      // Send vouchers via SMS
      await sendVoucherSMS(phone, vouchers.rows, voucherType);
      await checkAndAlertStock(voucherType);

      return res.status(200).json({ received: true, fulfilled: true });

    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(200).json({ received: true, error: 'Processing failed' });
  }
}
