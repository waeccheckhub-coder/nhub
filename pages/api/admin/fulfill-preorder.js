import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import db from '../../../lib/db';

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: 'Access Denied' });
  if (req.method !== 'POST') return res.status(405).end();

  const { preorderId } = req.body;
  if (!preorderId) return res.status(400).json({ error: 'Missing preorderId' });

  try {
    const preorderRes = await db.query('SELECT * FROM preorders WHERE id = $1', [preorderId]);
    if (preorderRes.rowCount === 0) return res.status(404).json({ error: 'Preorder not found' });

    const order = preorderRes.rows[0];
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Preorder is already ${order.status}` });
    }

    const { phone, quantity, voucher_type: type, reference } = order;

    // Check stock
    const vouchers = await db.query(
      'SELECT id, serial, pin FROM vouchers WHERE type = $1 AND status = $2 LIMIT $3',
      [type, 'available', quantity]
    );

    if (vouchers.rowCount < quantity) {
      return res.status(400).json({
        error: `Not enough stock. Need ${quantity}, have ${vouchers.rowCount}.`,
      });
    }

    // Mark vouchers as sold
    const voucherIds = vouchers.rows.map(v => v.id);
    await db.query(
      'UPDATE vouchers SET status = $1, sold_to = $2, transaction_ref = $3, sold_at = NOW() WHERE id = ANY($4)',
      ['sold', phone, reference, voucherIds]
    );

    // Update preorder and transaction
    await db.query(
      "UPDATE preorders SET status = 'fulfilled', fulfilled_at = NOW() WHERE id = $1",
      [preorderId]
    );
    await db.query(
      "UPDATE transactions SET status = 'success' WHERE reference = $1",
      [reference]
    );

    // Portal link helper
    const getPortalLink = (t) => {
      const u = (t || '').toUpperCase();
      if (u.includes('WASSCE') || u.includes('NOVDEC')) return 'https://ghana.waecdirect.org';
      if (u.includes('BECE')) return 'https://eresults.waecgh.org';
      if (u.includes('CSSPS') || u.includes('PLACEMENT')) return 'https://www.cssps.gov.gh';
      return 'https://waeccardsonline.com';
    };

    // Send SMS via Arkesel v2
    const formattedPhone = phone.startsWith('0') ? '233' + phone.slice(1) : phone;
    const voucherLines = vouchers.rows.map((v, i) => `${i + 1}. S/N: ${v.serial} PIN: ${v.pin}`).join('\n');

    try {
      await fetch('https://sms.arkesel.com/api/v2/sms/send', {
        method: 'POST',
        headers: {
          'api-key': process.env.ARKESEL_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sender: 'WAEC-GH',
          message:
            `Your ${type} voucher(s) are ready!\n\n` +
            `${voucherLines}\n\n` +
            `Check results: ${getPortalLink(type)}\n\n` +
            `Sorry for the wait — thank you!`,
          recipients: [formattedPhone],
        }),
      });
    } catch (e) {
      console.error('SMS error:', e.message);
    }

    return res.status(200).json({
      success: true,
      vouchers: vouchers.rows,
      message: `Fulfilled ${quantity} voucher(s) and SMS sent to ${phone}`,
    });

  } catch (error) {
    console.error('Fulfill preorder error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
