import pool from '../../lib/db';
import { sendAdminAlert, checkAndAlertStock } from '../../lib/alerts';

/**
 * Helper to send SMS via Arkesel
 */
async function sendVoucherSMS(phone, vouchers, voucherType) {
  const lines = vouchers.map((v, i) => `${i + 1}. Serial: ${v.serial} PIN: ${v.pin}`);
  const message =
    `Your WAEC ${voucherType} checker voucher(s):\n` + lines.join('\n') +
    '\nVisit waecgh.org to check results. Thank you!';

  try {
    await fetch('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: { 
        'api-key': process.env.ARKESEL_API_KEY, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ sender: 'WAEC-GH', message, recipients: [phone] }),
    });
  } catch (err) {
    console.error('SMS Delivery Error:', err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { reference } = req.body;

  if (!reference) {
    return res.status(400).json({ error: 'Missing reference' });
  }

  // 1. Fetch Transaction Status & Metadata from Moolre
  // This replaces the need for localStorage by getting the order info from the provider
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
        idtype: 1, // Lookup by externalref
        id: reference,
        accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
      }),
    });

    const result = await statusRes.json();
    moolreData = result?.data;

    if (!moolreData || moolreData.txstatus === 2) {
      return res.status(402).json({ error: 'Payment failed or was rejected by the provider.' });
    }
    
    if (moolreData.txstatus !== 1) {
      return res.status(202).json({ status: 'pending', message: 'Payment is still being processed.' });
    }
  } catch (err) {
    console.error('Moolre Verify Error:', err);
    return res.status(500).json({ error: 'Communication error with payment gateway.' });
  }

  // 2. Extract Details from Metadata (Sent during init-payment)
  const { phone, quantity, voucher_type } = moolreData.metadata;
  const amount = moolreData.amount;

  const client = await pool.connect();
  try {
    // 3. IDEMPOTENCY CHECK: Has this reference already been processed in our DB?
    const existingTx = await client.query(
      'SELECT status FROM transactions WHERE reference = $1',
      [reference]
    );

    if (existingTx.rows.length > 0) {
      // If found, fetch the vouchers already assigned to this reference
      const savedVouchers = await client.query(
        'SELECT serial, pin, type FROM vouchers WHERE transaction_ref = $1',
        [reference]
      );
      return res.status(200).json({ 
        success: true, 
        preorder: existingTx.rows[0].status === 'preorder',
        vouchers: savedVouchers.rows 
      });
    }

    // 4. STOCK CHECK: Attempt to grab available vouchers
    const voucherResult = await client.query(
      `SELECT id, serial, pin, type FROM vouchers
       WHERE type = $1 AND status = 'available'
       ORDER BY id ASC LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [voucher_type, parseInt(quantity)]
    );

    // 5. CASE A: OUT OF STOCK (Preorder)
    if (voucherResult.rows.length < parseInt(quantity)) {
      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
         VALUES ($1, $2, $3, $4, $5, 'preorder')`,
        [reference, phone, parseFloat(amount), parseInt(quantity), voucher_type]
      );

      await sendAdminAlert(
        `STOCK EXHAUSTED: ${voucher_type} x${quantity} for ${phone}. Transaction saved as Preorder. Ref: ${reference}`
      );

      return res.status(200).json({
        success: true,
        preorder: true,
        message: 'Payment verified. Vouchers will be sent via SMS once restocked.'
      });
    }

    // 6. CASE B: SUCCESSFUL FULFILLMENT
    const idsToUpdate = voucherResult.rows.map((v) => v.id);

    // Update Vouchers to 'sold'
    await client.query(
      `UPDATE vouchers SET status = 'sold', sold_to = $1, transaction_ref = $2, sold_at = NOW()
       WHERE id = ANY($3)`,
      [phone, reference, idsToUpdate]
    );

    // Insert into Transactions Table (Matching your provided schema)
    await client.query(
      `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
       VALUES ($1, $2, $3, $4, $5, 'success')`,
      [reference, phone, parseFloat(amount), parseInt(quantity), voucher_type]
    );

    // 7. Post-Processing: SMS & Stock Alerts
    await sendVoucherSMS(phone, voucherResult.rows, voucher_type);
    await checkAndAlertStock(voucher_type);

    return res.status(200).json({
      success: true,
      vouchers: voucherResult.rows.map(v => ({ serial: v.serial, pin: v.pin, type: v.type }))
    });

  } catch (dbErr) {
    console.error('Database fulfillment error:', dbErr);
    return res.status(500).json({ error: 'Internal server error during voucher allocation.' });
  } finally {
    client.release();
  }
}
