import db from '../../lib/db';
import { sendVoucherSMS, sendPreorderSMS } from '../../lib/sms';
import { sendAdminAlert, checkAndAlertStock } from '../../lib/alerts';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'Missing reference' });

  try {
    // ── IDEMPOTENCY ────────────────────────────────────────────────────────
    const existingTx = await db.query(
      `SELECT status FROM transactions WHERE reference = $1`, [reference]
    );
    if (existingTx.rowCount > 0) {
      if (existingTx.rows[0].status === 'success') {
        const vouchers = await db.query(
          `SELECT type, serial, pin FROM vouchers WHERE transaction_ref = $1`, [reference]
        );
        return res.status(200).json({ vouchers: vouchers.rows });
      }
      if (existingTx.rows[0].status === 'preorder') {
        return res.status(200).json({ preorder: true, vouchers: [] });
      }
    }

    // ── VERIFY WITH MOOLRE ─────────────────────────────────────────────────
    const moolreRes = await fetch('https://api.moolre.com/open/transact/status', {
      method: 'POST',
      headers: {
        'X-API-USER': process.env.MOOLRE_USERNAME,
        'X-API-PUBKEY': process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 1, idtype: 1, id: reference,
        accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
      }),
    });

    const moolreData = await moolreRes.json();
    const txData = moolreData?.data;
    const txstatus = txData?.txstatus;

    if (!txData || txstatus === 2) {
      return res.status(402).json({ error: 'Payment failed or was rejected.' });
    }
    if (txstatus !== 1) {
      return res.status(202).json({ status: 'pending', message: 'Payment still processing...' });
    }

    // ── LOAD ORDER from DB ─────────────────────────────────────────────────
    const preorderRow = await db.query(
      `SELECT phone, quantity, voucher_type, amount FROM preorders WHERE reference = $1`,
      [reference]
    );

    let phone, qty, voucherType, amount;
    if (preorderRow.rowCount > 0) {
      ({ phone, quantity: qty, voucher_type: voucherType, amount } = preorderRow.rows[0]);
    } else {
      const meta = txData?.metadata;
      phone = meta?.phone || txData?.payer || '';
      qty = parseInt(meta?.quantity || 1);
      voucherType = meta?.voucher_type || '';
      amount = txData?.amount || 0;

      if (!phone || !voucherType) {
        console.error('verify-payment: cannot resolve order for ref', reference);
        return res.status(404).json({
          error: `Order not found. Contact support with reference: ${reference}`,
        });
      }
    }
    qty = parseInt(qty);

    // ── ASSIGN VOUCHERS ────────────────────────────────────────────────────
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const vouchers = await client.query(
        `SELECT id, serial, pin, type FROM vouchers
         WHERE type = $1 AND status = 'available'
         LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [voucherType, qty]
      );

      if (vouchers.rowCount < qty) {
        await client.query(
          `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
           VALUES ($1,$2,'',$3,$4,$5,'pending',NOW())
           ON CONFLICT (reference) DO UPDATE SET status='pending'`,
          [reference, phone, parseFloat(amount), qty, voucherType]
        );
        await client.query(
          `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
           VALUES ($1,$2,$3,$4,$5,'preorder',NOW())
           ON CONFLICT (reference) DO UPDATE SET status='preorder'`,
          [reference, phone, parseFloat(amount), qty, voucherType]
        );
        await client.query('COMMIT');
        client.release();

        await sendPreorderSMS(phone, voucherType, reference);
        await sendAdminAlert(`PREORDER: ${voucherType} x${qty} from ${phone}. Ref: ${reference}. Upload vouchers!`);
        return res.status(200).json({ preorder: true, vouchers: [] });
      }

      const ids = vouchers.rows.map(v => v.id);
      await client.query(
        `UPDATE vouchers SET status='sold', sold_to=$1, sold_at=NOW(), transaction_ref=$2 WHERE id=ANY($3)`,
        [phone, reference, ids]
      );
      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
         VALUES ($1,$2,$3,$4,$5,'success',NOW())
         ON CONFLICT (reference) DO UPDATE SET status='success'`,
        [reference, phone, parseFloat(amount), qty, voucherType]
      );
      await client.query(
        `UPDATE preorders SET status='fulfilled', fulfilled_at=NOW()
         WHERE reference=$1 AND status IN ('initiated','pending')`,
        [reference]
      );
      await client.query('COMMIT');
      client.release();

      await sendVoucherSMS(phone, vouchers.rows, voucherType);
      await checkAndAlertStock(voucherType);
      return res.status(200).json({ vouchers: vouchers.rows });

    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }

  } catch (error) {
    console.error('Verify payment error:', error.message);
    return res.status(500).json({ error: `Internal error. Contact support with reference: ${reference}` });
  }
}
