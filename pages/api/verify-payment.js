import pool from '../../lib/db';
import { sendAdminAlert, checkAndAlertStock } from '../../lib/alerts';

// ... keep your sendVoucherSMS function exactly as it is ...
async function sendVoucherSMS(phone, vouchers, voucherType) {
  // ... (Keep existing code)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // WE ONLY NEED REFERENCE NOW
  const { reference } = req.body;

  if (!reference) {
    return res.status(400).json({ error: 'Missing payment reference' });
  }

  const client = await pool.connect();
  
  try {
    // 1. LOOKUP TRANSACTION DETAILS
    const txResult = await client.query(
      'SELECT * FROM transactions WHERE reference = $1',
      [reference]
    );

    if (txResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    const transaction = txResult.rows[0];
    const { phone, quantity, voucher_type: voucherType, amount, status } = transaction;

    // 2. IDEMPOTENCY CHECK (If already successful, just return vouchers)
    if (status === 'success') {
       const soldVouchers = await client.query(
         'SELECT serial, pin FROM vouchers WHERE transaction_ref = $1',
         [reference]
       );
       return res.status(200).json({ success: true, vouchers: soldVouchers.rows });
    }

    // 3. CHECK MOOLRE STATUS
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
            accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER 
        }),
      });

      const statusData = await statusRes.json();
      txstatus = statusData?.data?.txstatus; // 1=Success

      if (txstatus === 2) {
        await client.query("UPDATE transactions SET status = 'failed' WHERE reference = $1", [reference]);
        return res.status(402).json({ error: 'Payment failed or was rejected.' });
      }
      if (txstatus !== 1) {
        return res.status(202).json({ status: 'pending', message: 'Payment processing...' });
      }
    } catch (err) {
      console.error('Status check error:', err);
      return res.status(500).json({ error: 'Payment verification error.' });
    }

    // 4. CHECK STOCK
    const voucherResult = await client.query(
      `SELECT id, serial, pin FROM vouchers
       WHERE type = $1 AND status = 'available'
       ORDER BY id ASC LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [voucherType, parseInt(quantity)]
    );

    // 5. HANDLE OUT OF STOCK (Preorder)
    if (voucherResult.rows.length < parseInt(quantity)) {
      // Update the EXISTING transaction to preorder (don't insert new)
      await client.query(
        `UPDATE transactions SET status = 'preorder' WHERE reference = $1`,
        [reference]
      );
      
      // Add to preorders table if you use that for specific tracking
      await client.query(
        `INSERT INTO preorders (reference, phone, amount, quantity, voucher_type, status)
         VALUES ($1, $2, $3, $4, $5, 'pending') 
         ON CONFLICT (reference) DO NOTHING`,
        [reference, phone, parseFloat(amount), parseInt(quantity), voucherType]
      );

      await sendAdminAlert(`PREORDER: ${voucherType} x${quantity} (Ref: ${reference}) - Stock exhausted.`);

      return res.status(200).json({
        success: true,
        preorder: true,
        message: 'Out of stock. You will receive vouchers via SMS shortly.',
      });
    }

    // 6. FULFILL ORDER
    const ids = voucherResult.rows.map((v) => v.id);
    
    // Mark vouchers sold
    await client.query(
      `UPDATE vouchers SET status = 'sold', sold_to = $1, transaction_ref = $2, sold_at = NOW()
       WHERE id = ANY($3)`,
      [phone, reference, ids]
    );

    // Update Transaction to Success
    await client.query(
      `UPDATE transactions SET status = 'success' WHERE reference = $1`,
      [reference]
    );

    // Send SMS & Alert
    // Note: Pass voucherResult.rows explicitly as second arg
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
