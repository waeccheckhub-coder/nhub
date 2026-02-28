import pool from '../../lib/db';
import { sendAdminAlert, checkAndAlertStock } from '../../lib/alerts';

/**
 * Sends the actual SMS via Arkesel
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
  // 405 FIX: Explicitly handle allowed methods
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'Missing reference' });

  // 1. Verify Status with Moolre
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

    if (!moolreData || moolreData.txstatus === 2) {
      return res.status(402).json({ error: 'Payment failed or was rejected.' });
    }
    if (moolreData.txstatus !== 1) {
      return res.status(202).json({ status: 'pending', message: 'Processing payment...' });
    }
  } catch (err) {
    console.error('Moolre Fetch Error:', err);
    return res.status(500).json({ error: 'Communication error with payment gateway.' });
  }

  // Extract from Moolre Metadata
  const { phone, quantity, voucher_type } = moolreData.metadata;
  const amount = moolreData.amount;

  const client = await pool.connect();

  try {
    // 2. IDEMPOTENCY: Check if already processed
    const existing = await client.query(
      'SELECT status FROM transactions WHERE reference = $1',
      [reference]
    );

    if (existing.rows.length > 0) {
      const vouchers = await client.query(
        'SELECT serial, pin, type FROM vouchers WHERE transaction_ref = $1',
        [reference]
      );
      return res.status(200).json({ 
        success: true, 
        preorder: existing.rows[0].status === 'preorder',
        vouchers: vouchers.rows 
      });
    }

    // 3. STOCK CHECK
    const voucherResult = await client.query(
      `SELECT id, serial, pin, type FROM vouchers 
       WHERE type = $1 AND status = 'available' 
       ORDER BY id ASC LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [voucher_type, parseInt(quantity)]
    );

    if (voucherResult.rows.length < parseInt(quantity)) {
      // 4. PREORDER LOGIC: Insert into both tables
      await client.query(
        `INSERT INTO preorders (reference, phone, amount, quantity, voucher_type, status)
         VALUES ($1, $2, $3, $4, $5, 'pending') ON CONFLICT (reference) DO NOTHING`,
        [reference, phone, parseFloat(amount), parseInt(quantity), voucher_type]
      );
      
      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
         VALUES ($1, $2, $3, $4, $5, 'preorder') ON CONFLICT (reference) DO NOTHING`,
        [reference, phone, parseFloat(amount), parseInt(quantity), voucher_type]
      );

      await sendAdminAlert(`STOCK ALERT: Pre-order created for ${phone}. ${voucher_type} x${quantity}. Ref: ${reference}`);

      return res.status(200).json({ 
        success: true, 
        preorder: true,
        message: 'Payment confirmed. Out of stock - vouchers will be sent via SMS soon.'
      });
    }

    // 5. SUCCESSFUL FULFILLMENT
    const voucherIds = voucherResult.rows.map(v => v.id);

    await client.query(
      `UPDATE vouchers SET status = 'sold', sold_to = $1, transaction_ref = $2, sold_at = NOW() 
       WHERE id = ANY($3)`,
      [phone, reference, voucherIds]
    );

    await client.query(
      `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status)
       VALUES ($1, $2, $3, $4, $5, 'success') ON CONFLICT (reference) DO NOTHING`,
      [reference, phone, parseFloat(amount), parseInt(quantity), voucher_type]
    );

    // 6. Notifications
    await sendVoucherSMS(phone, voucherResult.rows, voucher_type);
    await checkAndAlertStock(voucher_type);

    return res.status(200).json({
      success: true,
      vouchers: voucherResult.rows
    });

  } catch (err) {
    console.error("Critical DB Error:", err);
    return res.status(500).json({ error: "Internal server error during voucher allocation." });
  } finally {
    client.release();
  }
}
