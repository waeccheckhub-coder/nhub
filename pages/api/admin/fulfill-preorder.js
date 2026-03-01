import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import db from '../../../lib/db';
import { formatPhone } from '../../../lib/phone';

function getPortalLink(type) {
  const t = (type || '').toUpperCase();
  if (t.includes('WASSCE') || t.includes('NOVDEC')) return 'https://ghana.waecdirect.org';
  if (t.includes('BECE')) return 'https://eresults.waecgh.org';
  if (t.includes('CSSPS') || t.includes('PLACEMENT')) return 'https://www.cssps.gov.gh';
  return 'https://waeccardsonline.com';
}

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
        `UPDATE transactions SET status = 'success' WHERE reference = $1`,
        [reference]
      );

      await client.query('COMMIT');
      client.release();

      // Send SMS via Arkesel v2
      const voucherDetails = vouchers.rows.map((v, i) => `${i + 1}. S/N: ${v.serial} PIN: ${v.pin}`).join('\n');
      try {
        const smsRes = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
          method: 'POST',
          headers: { 'api-key': process.env.ARKESEL_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: 'WAEC-GH',
            message: `CheckerCard: Your ${type} voucher(s) are ready!\n\n${voucherDetails}\n\nCheck results: ${getPortalLink(type)}\n\nSorry for the wait — thank you!`,
            recipients: [formatPhone(phone)],
          }),
        });
        const smsResult = await smsRes.json();
        if (smsResult.status !== 'success') console.error('Arkesel error:', JSON.stringify(smsResult));
      } catch (e) { console.error('SMS error:', e.message); }

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
