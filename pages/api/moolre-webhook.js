// POST /api/moolre-webhook
// Moolre POSTs this when a payment completes (async backup to the redirect flow).
//
// Webhook payload shape (confirmed from docs):
// {
//   status: 1, code: "P01", message: "Transaction Successful",
//   data: {
//     txstatus: 1,             // 1=Successful, 0=Pending, 2=Failed
//     payer: "233xxxxxxxxx",   // customer phone
//     amount: "15.21",
//     externalref: "waec_xxx", // YOUR reference
//     secret: "c80b20ce-...", // verify against MOOLRE_WEBHOOK_SECRET
//     transactionid: 32712684,
//     ts: "2024-11-27 21:11:29"
//   }
// }

import pool from '../../lib/db';
import { sendAdminAlert, checkAndAlertStock } from '../../lib/alerts';

async function sendVoucherSMS(phone, vouchers, voucherType) {
  const formattedPhone = phone.startsWith('0') ? '233' + phone.slice(1) : phone;
  const lines = vouchers.map((v, i) => `${i + 1}. Serial: ${v.serial} PIN: ${v.pin}`);
  const message =
    `Your WAEC ${voucherType} checker voucher(s):\n` +
    lines.join('\n') +
    '\nVisit waecgh.org to check results. Thank you!';

  await fetch('https://sms.arkesel.com/api/v2/sms/send', {
    method: 'POST',
    headers: { 'api-key': process.env.ARKESEL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'WAEC-GH', message, recipients: [formattedPhone] }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const txData = req.body?.data;

  if (!txData) {
    console.warn('Moolre webhook: empty data field', req.body);
    return res.status(200).end(); // Always 200 to Moolre
  }

  const { txstatus, externalref, payer, amount, secret } = txData;

  // Optional: verify secret matches your Moolre account secret
  if (process.env.MOOLRE_WEBHOOK_SECRET && secret !== process.env.MOOLRE_WEBHOOK_SECRET) {
    console.warn('Moolre webhook: secret mismatch');
    return res.status(200).end();
  }

  if (txstatus !== 1) return res.status(200).end();

  if (!externalref) {
    console.warn('Moolre webhook: no externalref');
    return res.status(200).end();
  }

  const client = await pool.connect();
  try {
    // Check if already fulfilled by the redirect flow
    const existing = await client.query(
      'SELECT id, status FROM transactions WHERE reference = $1',
      [externalref]
    );
    if (existing.rows.length > 0 && existing.rows[0].status === 'success') {
      return res.status(200).end();
    }

    // Resolve order details — prefer transaction record (set during init-payment)
    let phone = payer;
    let quantity = 1;
    let voucherType = null;

    if (existing.rows.length > 0) {
      const tx = await client.query(
        'SELECT * FROM transactions WHERE reference = $1',
        [externalref]
      );
      if (tx.rows.length > 0) {
        phone = tx.rows[0].phone || payer;
        quantity = tx.rows[0].quantity;
        voucherType = tx.rows[0].voucher_type;
      }
    }

    // Fall back to preorder table if transaction record missing details
    if (!voucherType) {
      const preorderRes = await client.query(
        'SELECT * FROM preorders WHERE reference = $1',
        [externalref]
      );
      if (preorderRes.rows.length > 0) {
        const po = preorderRes.rows[0];
        phone = po.phone || payer;
        quantity = po.quantity;
        voucherType = po.voucher_type;
      }
    }

    if (!voucherType) {
      console.warn('Moolre webhook: cannot determine voucherType for ref', externalref);
      return res.status(200).end();
    }

    // Attempt to grab vouchers
    const voucherResult = await client.query(
      `SELECT id, serial, pin FROM vouchers
       WHERE type = $1 AND status = 'available'
       ORDER BY id ASC LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [voucherType, quantity]
    );

    if (voucherResult.rows.length < quantity) {
      // Still out of stock — ensure preorder exists
      await client.query(
        `INSERT INTO preorders (reference, phone, amount, quantity, voucher_type, status)
         VALUES ($1, $2, $3, $4, $5, 'pending') ON CONFLICT (reference) DO NOTHING`,
        [externalref, phone, parseFloat(amount || 0), quantity, voucherType]
      );
      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
         VALUES ($1, $2, $3, $4, $5, 'preorder') ON CONFLICT (reference) DO NOTHING`,
        [externalref, phone, parseFloat(amount || 0), quantity, voucherType]
      );

      await sendAdminAlert(
        `PREORDER (webhook): ${voucherType} x${quantity} from ${phone}. Ref: ${externalref}. Upload vouchers.`
      );
      return res.status(200).end();
    }

    // Mark vouchers as sold
    const ids = voucherResult.rows.map((v) => v.id);
    await client.query(
      `UPDATE vouchers SET status = 'sold', sold_to = $1, transaction_ref = $2, sold_at = NOW()
       WHERE id = ANY($3)`,
      [phone, externalref, ids]
    );

    await client.query(
      `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
       VALUES ($1, $2, $3, $4, $5, 'success')
       ON CONFLICT (reference) DO UPDATE SET status = 'success'`,
      [externalref, phone, parseFloat(amount || 0), quantity, voucherType]
    );

    await client.query(
      `UPDATE preorders SET status = 'fulfilled', fulfilled_at = NOW() WHERE reference = $1`,
      [externalref]
    );

    await sendVoucherSMS(phone, voucherResult.rows, voucherType);
    await checkAndAlertStock(voucherType);

    return res.status(200).end();
  } catch (err) {
    console.error('moolre-webhook error:', err);
    return res.status(200).end(); // Always 200 to prevent Moolre retries
  } finally {
    client.release();
  }
}
