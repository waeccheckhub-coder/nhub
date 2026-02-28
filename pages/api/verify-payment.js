// POST /api/verify-payment
// Called from /thank-you page after Moolre redirects back.
// Only needs { reference } from the frontend — all order details are read from DB.

import pool from '../../lib/db';
import { sendAdminAlert, checkAndAlertStock } from '../../lib/alerts';

async function sendVoucherSMS(phone, vouchers, voucherType) {
  const lines = vouchers.map((v, i) => `${i + 1}. Serial: ${v.serial} PIN: ${v.pin}`);
  const message =
    `Your WAEC ${voucherType} checker voucher(s):\n` + lines.join('\n') +
    '\nVisit waecgh.org to check results. Thank you!';

  try {
    await fetch('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: { 'api-key': process.env.ARKESEL_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'WAEC-GH', message, recipients: [phone] }),
    });
  } catch (err) {
    console.error('SMS delivery error:', err);
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'Missing reference' });

  // 1. Verify payment status with Moolre
  let txstatus;
  let moolreData;
  try {
    const statusRes = await fetch('https://api.moolre.com/open/transact/status', {
      method: 'POST',
      headers: {
        'X-API-USER': process.env.MOOLRE_USERNAME,
        'X-API-PUBKEY': process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 1,
        idtype: 1,
        id: reference,
        accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
      }),
    });

    const result = await statusRes.json();
    moolreData = result?.data;
    txstatus = moolreData?.txstatus;

    if (!moolreData || txstatus === 2) {
      return res.status(402).json({ error: 'Payment failed or was rejected.' });
    }
    if (txstatus !== 1) {
      return res.status(202).json({ status: 'pending', message: 'Processing payment...' });
    }
  } catch (err) {
    console.error('Moolre fetch error:', err);
    return res.status(500).json({ error: 'Communication error with payment gateway.' });
  }

  const client = await pool.connect();
  try {
    // 2. Load order details from DB (set during init-payment)
    const txRow = await client.query(
      'SELECT * FROM transactions WHERE reference = $1',
      [reference]
    );

    // 2a. Already fully processed — return existing vouchers
    if (txRow.rows.length > 0 && txRow.rows[0].status === 'success') {
      const vouchers = await client.query(
        'SELECT serial, pin, type FROM vouchers WHERE transaction_ref = $1',
        [reference]
      );
      return res.status(200).json({ success: true, vouchers: vouchers.rows });
    }

    // 2b. Already a preorder
    if (txRow.rows.length > 0 && txRow.rows[0].status === 'preorder') {
      return res.status(200).json({
        success: true,
        preorder: true,
        message: 'Payment confirmed. Out of stock — vouchers will be sent via SMS soon.',
      });
    }

    // 2c. Read order details — from DB row if it exists, otherwise fall back
    // to Moolre metadata (for orders placed before the DB-first init-payment change)
    let phone, quantity, voucher_type, amount;

    if (txRow.rows.length > 0) {
      ({ phone, quantity, voucher_type, amount } = txRow.rows[0]);
    } else {
      // Legacy fallback: read from Moolre status response metadata
      const meta = moolreData?.metadata;
      if (!meta?.phone || !meta?.quantity || !meta?.voucher_type) {
        console.error('verify-payment: no DB row and no Moolre metadata for ref', reference);
        return res.status(404).json({ error: 'Order not found. Please contact support with your reference: ' + reference });
      }
      phone = meta.phone;
      quantity = meta.quantity;
      voucher_type = meta.voucher_type;
      amount = moolreData.amount || 0;
    }

    // 3. Attempt to grab vouchers
    const voucherResult = await client.query(
      `SELECT id, serial, pin, type FROM vouchers
       WHERE type = $1 AND status = 'available'
       ORDER BY id ASC LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [voucher_type, parseInt(quantity)]
    );

    if (voucherResult.rows.length < parseInt(quantity)) {
      // Out of stock → preorder
      await client.query(
        `INSERT INTO preorders (reference, phone, amount, quantity, voucher_type, status)
         VALUES ($1, $2, $3, $4, $5, 'pending') ON CONFLICT (reference) DO NOTHING`,
        [reference, phone, parseFloat(amount), parseInt(quantity), voucher_type]
      );
      await client.query(
        `UPDATE transactions SET status = 'preorder' WHERE reference = $1`,
        [reference]
      );

      await sendAdminAlert(
        `PREORDER: ${voucher_type} x${quantity} from ${phone}. Ref: ${reference}. Upload vouchers.`
      );

      return res.status(200).json({
        success: true,
        preorder: true,
        message: 'Payment confirmed. Out of stock — vouchers will be sent via SMS soon.',
      });
    }

    // 4. Mark vouchers as sold
    const voucherIds = voucherResult.rows.map(v => v.id);
    await client.query(
      `UPDATE vouchers SET status = 'sold', sold_to = $1, transaction_ref = $2, sold_at = NOW()
       WHERE id = ANY($3)`,
      [phone, reference, voucherIds]
    );

    // 5. Update transaction to success
    await client.query(
      `UPDATE transactions SET status = 'success' WHERE reference = $1`,
      [reference]
    );

    // 6. Send SMS and stock alert
    await sendVoucherSMS(phone, voucherResult.rows, voucher_type);
    await checkAndAlertStock(voucher_type);

    return res.status(200).json({
      success: true,
      vouchers: voucherResult.rows,
    });

  } catch (err) {
    console.error('verify-payment DB error:', err);
    return res.status(500).json({ error: 'Internal server error during voucher allocation.' });
  } finally {
    client.release();
  }
}
