// POST /api/verify-payment
// Called from /thank-you page after Moolre redirects back.
// Checks payment status then assigns vouchers or saves a preorder.
// Docs: POST https://api.moolre.com/open/transact/status

import pool from '../../lib/db';
import { getSetting } from '../../lib/settings';
import { sendAdminAlert, checkAndAlertStock } from '../../lib/alerts';

async function sendVoucherSMS(phone, vouchers, voucherType) {
  const arkeselKey = process.env.ARKESEL_API_KEY;
  const lines = vouchers.map(
    (v, i) => `${i + 1}. Serial: ${v.serial} PIN: ${v.pin}`
  );
  const message =
    `Your WAEC ${voucherType} checker voucher(s):\n` + lines.join('\n') +
    '\nVisit waecgh.org to check results. Thank you!';

  await fetch('https://sms.arkesel.com/api/v2/sms/send', {
    method: 'POST',
    headers: {
      'api-key': arkeselKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: 'WAEC-GH',
      message,
      recipients: [phone],
    }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { reference, phone, quantity, voucherType, amount } = req.body;

  if (!reference || !phone || !quantity || !voucherType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // 1. Check payment status with Moolre
  let txstatus;
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
        idtype: 1,           // 1 = lookup by externalref
        id: reference,
        accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
      }),
    });

    const statusData = await statusRes.json();

    // txstatus: 1=Successful, 0=Pending, 2=Failed
    txstatus = statusData?.data?.txstatus;

    if (txstatus === 2) {
      return res.status(402).json({ error: 'Payment failed or was rejected.' });
    }

    if (txstatus !== 1) {
      // Pending — tell the client to wait
      return res.status(202).json({ status: 'pending', message: 'Payment is still being processed.' });
    }
  } catch (err) {
    console.error('verify-payment status check error:', err);
    return res.status(500).json({ error: 'Could not verify payment status.' });
  }

  // 2. Prevent duplicate fulfillment
  const client = await pool.connect();
  try {
    const existing = await client.query(
      'SELECT id FROM transactions WHERE reference = $1',
      [reference]
    );
    if (existing.rows.length > 0) {
      // Already processed — just return the vouchers
      const vouchers = await client.query(
        'SELECT serial, pin FROM vouchers WHERE transaction_ref = $1 AND type = $2',
        [reference, voucherType]
      );
      return res.status(200).json({ success: true, vouchers: vouchers.rows });
    }

    // 3. Attempt to grab available vouchers
    const voucherResult = await client.query(
      `SELECT id, serial, pin FROM vouchers
       WHERE type = $1 AND status = 'available'
       ORDER BY id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [voucherType, parseInt(quantity)]
    );

    if (voucherResult.rows.length < parseInt(quantity)) {
      // Out of stock → save preorder
      await client.query(
        `INSERT INTO preorders (reference, phone, amount, quantity, voucher_type, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         ON CONFLICT (reference) DO NOTHING`,
        [reference, phone, parseFloat(amount), parseInt(quantity), voucherType]
      );

      // Record transaction as preorder
      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
         VALUES ($1, $2, $3, $4, $5, 'preorder')
         ON CONFLICT (reference) DO NOTHING`,
        [reference, phone, parseFloat(amount), parseInt(quantity), voucherType]
      );

      // Notify admin via WhatsApp
      const adminPhone = await getSetting('admin_whatsapp');
      if (adminPhone) {
        await sendWhatsAppAlert(
          adminPhone,
          `⚠️ New Preorder!\nType: ${voucherType}\nQty: ${quantity}\nPhone: ${phone}\nRef: ${reference}\nStock exhausted — please upload vouchers.`
        );
      }

      return res.status(200).json({
        success: true,
        preorder: true,
        message: 'Payment received but vouchers are currently out of stock. You will receive them via SMS once restocked.',
      });
    }

    // 4. Mark vouchers as sold
    const ids = voucherResult.rows.map((v) => v.id);
    await client.query(
      `UPDATE vouchers
       SET status = 'sold', sold_to = $1, transaction_ref = $2, sold_at = NOW()
       WHERE id = ANY($3)`,
      [phone, reference, ids]
    );

    // 5. Record transaction
    await client.query(
      `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
       VALUES ($1, $2, $3, $4, $5, 'success')
       ON CONFLICT (reference) DO NOTHING`,
      [reference, phone, parseFloat(amount), parseInt(quantity), voucherType]
    );

    // 6. Send SMS with vouchers
    await sendVoucherSMS(phone, voucherResult.rows, voucherType);

    // 7. Check stock alert
    await checkAndAlertStock(voucherType);

    return res.status(200).json({
      success: true,
      vouchers: voucherResult.rows.map((v) => ({ serial: v.serial, pin: v.pin })),
    });
  } finally {
    client.release();
  }
}
