// POST /api/moolre-webhook
// Moolre POSTs this when a payment completes (async backup to the redirect flow).
//
// Confirmed webhook payload shape (from docs):
// {
//   status: 1,
//   code: "P01",
//   message: "Transaction Successful",
//   data: {
//     txstatus: 1,          // 1=Successful, 0=Pending, 2=Failed
//     payer: "233xxxxxxxxx", // customer phone
//     terminalid: "",
//     accountnumber: "420500413146",
//     name: "Nancy Naaki",
//     amount: "15.21",
//     value: "15.21",
//     transactionid: 32712684,
//     externalref: "waec_xxx",   // YOUR reference
//     thirdpartyref: "48149622075",
//     secret: "c80b20ce-...",    // verify against your account secret
//     ts: "2024-11-27 21:11:29"
//   },
//   go: null
// }

import pool from '../../lib/db';
import { getSetting } from '../../lib/settings';
import { sendWhatsAppAlert, checkAndAlertStock } from '../../lib/whatsapp';

async function sendVoucherSMS(phone, vouchers, voucherType) {
  const arkeselKey = process.env.ARKESEL_API_KEY;
  const lines = vouchers.map((v, i) => `${i + 1}. Serial: ${v.serial} PIN: ${v.pin}`);
  const message =
    `Your WAEC ${voucherType} checker voucher(s):\n` +
    lines.join('\n') +
    '\nVisit waecgh.org to check results. Thank you!';

  await fetch('https://sms.arkesel.com/api/v2/sms/send', {
    method: 'POST',
    headers: { 'api-key': arkeselKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'WAEC-GH', message, recipients: [phone] }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body;
  const txData = body?.data;

  if (!txData) {
    console.warn('Moolre webhook: empty data field', body);
    return res.status(200).end(); // Always 200 to Moolre
  }

  const { txstatus, externalref, payer, amount, secret } = txData;

  // Optional: verify the secret matches your account's secret key
  // (obtain your account secret from POST /open/account/create or /open/account/update response)
  if (process.env.MOOLRE_WEBHOOK_SECRET && secret !== process.env.MOOLRE_WEBHOOK_SECRET) {
    console.warn('Moolre webhook: secret mismatch');
    return res.status(200).end(); // Still 200 to avoid Moolre retries
  }

  // Only process successful payments
  if (txstatus !== 1) {
    return res.status(200).end();
  }

  if (!externalref) {
    console.warn('Moolre webhook: no externalref');
    return res.status(200).end();
  }

  // Check if already processed (verify-payment flow may have handled it)
  const client = await pool.connect();
  try {
    const existing = await client.query(
      "SELECT id, status FROM transactions WHERE reference = $1",
      [externalref]
    );

    if (existing.rows.length > 0 && existing.rows[0].status === 'success') {
      // Already fulfilled via the redirect flow — nothing to do
      return res.status(200).end();
    }

    // Look up the preorder to get quantity, phone, voucherType
    const preorderRes = await client.query(
      "SELECT * FROM preorders WHERE reference = $1",
      [externalref]
    );

    // If no preorder exists, try to reconstruct from transaction record
    let phone = payer;
    let quantity = 1;
    let voucherType = null;

    if (preorderRes.rows.length > 0) {
      const po = preorderRes.rows[0];
      phone = po.phone || payer;
      quantity = po.quantity;
      voucherType = po.voucher_type;
    } else if (existing.rows.length > 0) {
      const tx = await client.query(
        "SELECT * FROM transactions WHERE reference = $1",
        [externalref]
      );
      if (tx.rows.length > 0) {
        phone = tx.rows[0].phone || payer;
        quantity = tx.rows[0].quantity;
        voucherType = tx.rows[0].voucher_type;
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
         VALUES ($1, $2, $3, $4, $5, 'pending')
         ON CONFLICT (reference) DO NOTHING`,
        [externalref, phone, parseFloat(amount || 0), quantity, voucherType]
      );

      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
         VALUES ($1, $2, $3, $4, $5, 'preorder')
         ON CONFLICT (reference) DO NOTHING`,
        [externalref, phone, parseFloat(amount || 0), quantity, voucherType]
      );

      const adminPhone = await getSetting('admin_whatsapp');
      if (adminPhone) {
        await sendWhatsAppAlert(
          adminPhone,
          `⚠️ Webhook Preorder!\nType: ${voucherType}\nQty: ${quantity}\nPhone: ${phone}\nRef: ${externalref}`
        );
      }
      return res.status(200).end();
    }

    // Mark vouchers as sold
    const ids = voucherResult.rows.map((v) => v.id);
    await client.query(
      `UPDATE vouchers
       SET status = 'sold', sold_to = $1, transaction_ref = $2, sold_at = NOW()
       WHERE id = ANY($3)`,
      [phone, externalref, ids]
    );

    // Upsert transaction record as success
    await client.query(
      `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
       VALUES ($1, $2, $3, $4, $5, 'success')
       ON CONFLICT (reference) DO UPDATE SET status = 'success'`,
      [externalref, phone, parseFloat(amount || 0), quantity, voucherType]
    );

    // Mark preorder fulfilled if it existed
    await client.query(
      `UPDATE preorders SET status = 'fulfilled', fulfilled_at = NOW()
       WHERE reference = $1`,
      [externalref]
    );

    // Send SMS
    await sendVoucherSMS(phone, voucherResult.rows, voucherType);

    // Check low stock alert
    await checkAndAlertStock(voucherType);

    return res.status(200).end();
  } catch (err) {
    console.error('moolre-webhook error:', err);
    return res.status(200).end(); // Always 200 to prevent Moolre retries
  } finally {
    client.release();
  }
}
