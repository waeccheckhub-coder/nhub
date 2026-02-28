// POST /api/verify-payment
import pool from '../../lib/db';
import { sendAdminAlert, checkAndAlertStock } from '../../lib/alerts';

async function sendVoucherSMS(phone, vouchers, voucherType) {
  const lines = vouchers.map((v, i) => `${i + 1}. Serial: ${v.serial} PIN: ${v.pin}`);
  const message =
    `Your WAEC ${voucherType} checker voucher(s):\n` + lines.join('\n') +
    '\nVisit waecgh.org to check results. Thank you!';

  await fetch('https://sms.arkesel.com/api/v2/sms/send', {
    method: 'POST',
    headers: { 'api-key': process.env.ARKESEL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'WAEC-GH', message, recipients: [phone] }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // CHANGED: We only expect reference now.
  const { reference } = req.body;

  if (!reference) {
    return res.status(400).json({ error: 'Missing payment reference' });
  }

  const client = await pool.connect();
  
  try {
    // 1. RETRIEVE MISSING DATA FROM DB
    // We look for the record created during the "initiate" phase
    const txResult = await client.query(
      'SELECT phone, quantity, voucher_type, amount, status FROM transactions WHERE reference = $1',
      [reference]
    );

    if (txResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction record not found.' });
    }

    const transaction = txResult.rows[0];

    // Check if already fulfilled to avoid double processing
    if (transaction.status === 'success') {
       // Fetch the assigned vouchers to show them again
       const assignedVouchers = await client.query(
         'SELECT serial, pin FROM vouchers WHERE transaction_ref = $1',
         [reference]
       );
       return res.status(200).json({ success: true, vouchers: assignedVouchers.rows });
    }

    // Destructure the data we retrieved from DB
    const { phone, quantity, voucher_type: voucherType, amount } = transaction;

    // 2. Check payment status with Moolre
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
          idtype: 1, 
          id: reference,
          accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
        }),
      });

      const statusData = await statusRes.json();
      txstatus = statusData?.data?.txstatus; 

      if (txstatus === 2) {
        // Update DB to failed
        await client.query("UPDATE transactions SET status = 'failed' WHERE reference = $1", [reference]);
        return res.status(402).json({ error: 'Payment failed or was rejected.' });
      }
      if (txstatus !== 1) {
        return res.status(202).json({ status: 'pending', message: 'Payment is still being processed.' });
      }
    } catch (err) {
      console.error('verify-payment status check error:', err);
      return res.status(500).json({ error: 'Could not verify payment status.' });
    }

    // 3. Attempt to grab available vouchers
    const voucherResult = await client.query(
      `SELECT id, serial, pin FROM vouchers
       WHERE type = $1 AND status = 'available'
       ORDER BY id ASC LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [voucherType, parseInt(quantity)]
    );

    // 4. Handle Out of Stock
    if (voucherResult.rows.length < parseInt(quantity)) {
      // Update existing transaction to preorder
      await client.query(
        `UPDATE transactions SET status = 'preorder' WHERE reference = $1`,
        [reference]
      );
      
      // Upsert into preorders (just in case)
      await client.query(
        `INSERT INTO preorders (reference, phone, amount, quantity, voucher_type, status)
         VALUES ($1, $2, $3, $4, $5, 'pending') 
         ON CONFLICT (reference) DO NOTHING`,
        [reference, phone, parseFloat(amount), parseInt(quantity), voucherType]
      );

      await sendAdminAlert(
        `PREORDER: ${voucherType} x${quantity} from ${phone}. Ref: ${reference}. Stock exhausted - upload vouchers.`
      );

      return res.status(200).json({
        success: true,
        preorder: true,
        message: 'Payment received but vouchers are currently out of stock. You will receive them via SMS once restocked.',
      });
    }

    // 5. Mark vouchers as sold
    const ids = voucherResult.rows.map((v) => v.id);
    await client.query(
      `UPDATE vouchers SET status = 'sold', sold_to = $1, transaction_ref = $2, sold_at = NOW()
       WHERE id = ANY($3)`,
      [phone, reference, ids]
    );

    // 6. Update transaction to success
    // (We UPDATE now, because we INSERTED at step 1)
    await client.query(
      `UPDATE transactions SET status = 'success' WHERE reference = $1`,
      [reference]
    );

    // 7. Send SMS & Alerts
    await sendVoucherSMS(phone, voucherResult.rows, voucherType);
    await checkAndAlertStock(voucherType);

    return res.status(200).json({
      success: true,
      vouchers: voucherResult.rows.map((v) => ({ serial: v.serial, pin: v.pin })),
    });
  } finally {
    client.release();
  }
}
