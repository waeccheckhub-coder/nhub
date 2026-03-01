import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import db from '../../../lib/db';
import { sendAdminAlert } from '../../../lib/alerts';
import { sendVoucherSMS } from '../../../lib/sms';

async function autoFulfillPreorders(type) {
  const preorders = await db.query(
    `SELECT * FROM preorders WHERE voucher_type = $1 AND status = 'pending'
     ORDER BY created_at ASC`,
    [type]
  );

  if (preorders.rows.length === 0) return { fulfilled: 0, stillPending: 0 };

  let fulfilled = 0;

  for (const order of preorders.rows) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const vouchers = await client.query(
        `SELECT id, serial, pin FROM vouchers
         WHERE type = $1 AND status = 'available'
         ORDER BY id ASC LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [type, order.quantity]
      );

      if (vouchers.rows.length < order.quantity) {
        await client.query('ROLLBACK');
        continue;
      }

      const ids = vouchers.rows.map(v => v.id);

      await client.query(
        `UPDATE vouchers SET status = 'sold', sold_to = $1, transaction_ref = $2, sold_at = NOW()
         WHERE id = ANY($3)`,
        [order.phone, order.reference, ids]
      );

      await client.query(
        `UPDATE preorders SET status = 'fulfilled', fulfilled_at = NOW() WHERE id = $1`,
        [order.id]
      );

      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'success', NOW())
         ON CONFLICT (reference) DO UPDATE SET status = 'success'`,
        [order.reference, order.phone, order.amount, order.quantity, type]
      );

      await client.query('COMMIT');
      client.release();

      await sendVoucherSMS(order.phone, vouchers.rows, type, { waitMessage: true });
      fulfilled++;
    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      console.error(`Auto-fulfill failed for preorder ${order.id}:`, err.message);
    }
  }

  const stillPending = preorders.rows.length - fulfilled;
  return { fulfilled, stillPending };
}

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: 'Access Denied' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { csvData, type } = req.body;
  if (!csvData || !type) {
    return res.status(400).json({ error: 'Missing csvData or type' });
  }

  try {
    const lines = csvData.trim().split(/\r?\n/);
    const results = { success: 0, failed: 0 };

    for (const line of lines) {
      const parts = line.split(',').map(s => s.trim());
      if (parts.length >= 2) {
        const [serial, pin] = parts;
        try {
          await db.query(
            `INSERT INTO vouchers (type, serial, pin, status, created_at)
             VALUES ($1, $2, $3, 'available', NOW())
             ON CONFLICT (serial) DO NOTHING`,
            [type, serial, pin]
          );
          results.success++;
        } catch (err) {
          console.error(`Insert error for line "${line}":`, err.message);
          results.failed++;
        }
      } else {
        results.failed++;
      }
    }

    let autoFulfill = { fulfilled: 0, stillPending: 0 };
    if (results.success > 0) {
      autoFulfill = await autoFulfillPreorders(type);
      if (autoFulfill.fulfilled > 0) {
        await sendAdminAlert(
          `AUTO-FULFILLED: ${autoFulfill.fulfilled} preorder(s) for ${type} fulfilled after upload. ${autoFulfill.stillPending} still pending.`
        );
      }
    }

    return res.status(200).json({
      message: 'Processing complete',
      summary: {
        uploaded: results.success,
        failed: results.failed,
        preordersFulfilled: autoFulfill.fulfilled,
        preordersStillPending: autoFulfill.stillPending,
      },
    });

  } catch (error) {
    console.error('Upload API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error during upload' });
  }
}
