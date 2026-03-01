import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import db from '../../../lib/db';
import { sendVoucherSMS } from '../../../lib/sms';

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Access Denied" });
  if (req.method !== 'POST') return res.status(405).end();

  const { preorderId } = req.body;
  if (!preorderId) return res.status(400).json({ error: 'Missing preorderId' });

  try {
    const preorderRes = await db.query("SELECT * FROM preorders WHERE id = $1", [preorderId]);
    if (preorderRes.rowCount === 0) return res.status(404).json({ error: 'Preorder not found' });

    const order = preorderRes.rows[0];
    if (order.status === 'fulfilled') {
      return res.status(400).json({ error: 'Preorder is already fulfilled' });
    }

    const { phone, quantity, voucher_type: type, amount, reference } = order;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const vouchers = await client.query(
        `SELECT id, serial, pin FROM vouchers
         WHERE type = $1 AND status = 'available'
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [type, quantity]
      );

      if (vouchers.rowCount < quantity) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({
          error: `Not enough stock. Need ${quantity}, only ${vouchers.rowCount} available.`
        });
      }

      const voucherIds = vouchers.rows.map(v => v.id);

      await client.query(
        `UPDATE vouchers SET status = 'sold', sold_to = $1, sold_at = NOW(), transaction_ref = $2
         WHERE id = ANY($3)`,
        [phone, reference, voucherIds]
      );

      await client.query(
        `UPDATE preorders SET status = 'fulfilled', fulfilled_at = NOW() WHERE id = $1`,
        [preorderId]
      );

      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'success', NOW())
         ON CONFLICT (reference) DO UPDATE SET status = 'success'`,
        [reference, phone, amount, quantity, type]
      );

      await client.query('COMMIT');
      client.release();

      await sendVoucherSMS(phone, vouchers.rows, type, { waitMessage: true });

      return res.status(200).json({
        success: true,
        vouchers: vouchers.rows,
        message: `Fulfilled ${quantity} voucher(s) and SMS sent to ${phone}`,
      });

    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }

  } catch (error) {
    console.error('Fulfill preorder error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
