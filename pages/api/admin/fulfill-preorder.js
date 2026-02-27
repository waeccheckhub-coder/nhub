import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import db from '../../../lib/db';
import axios from 'axios';

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
    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Preorder is already ${order.status}` });
    }

    const { phone, quantity, voucher_type: type, amount, reference } = order;

    // Check stock
    const vouchers = await db.query(
      'SELECT id, serial, pin FROM vouchers WHERE type = $1 AND status = $2 LIMIT $3',
      [type, 'available', quantity]
    );

    if (vouchers.rowCount < quantity) {
      return res.status(400).json({
        error: `Not enough stock. Need ${quantity}, have ${vouchers.rowCount}.`
      });
    }

    // Mark vouchers as sold
    const voucherIds = vouchers.rows.map(v => v.id);
    await db.query(
      'UPDATE vouchers SET status = $1, sold_to = $2, sold_at = NOW() WHERE id = ANY($3)',
      ['sold', phone, voucherIds]
    );

    // Update preorder
    await db.query(
      "UPDATE preorders SET status = 'fulfilled', fulfilled_at = NOW() WHERE id = $1",
      [preorderId]
    );

    // Update transaction if exists
    await db.query(
      "UPDATE transactions SET status = 'success' WHERE reference = $1",
      [reference]
    );

    // Portal link
    const getPortalLink = (t) => {
      const u = (t || '').toUpperCase();
      if (u.includes('WASSCE') || u.includes('NOVDEC')) return 'https://ghana.waecdirect.org';
      if (u.includes('BECE')) return 'https://eresults.waecgh.org';
      if (u.includes('CSSPS') || u.includes('PLACEMENT')) return 'https://www.cssps.gov.gh';
      return 'https://waeccardsonline.com';
    };

    // Send SMS
    const voucherDetails = vouchers.rows.map(v => `S/N: ${v.serial} PIN: ${v.pin}`).join('\n');
    const formattedPhone = phone.startsWith('0') ? '233' + phone.slice(1) : phone;

    try {
      await axios.get(`https://sms.arkesel.com/sms/api`, {
        params: {
          action: 'send-sms',
          api_key: process.env.ARKESEL_API_KEY,
          to: formattedPhone,
          from: 'CheckerCard',
          sms: `CheckerCard: Your ${type} voucher(s) are finally ready!\n\n${voucherDetails}\n\nCheck Result: ${getPortalLink(type)}\n\nSorry for the wait — thank you!`,
        }
      });
    } catch (e) { console.error('SMS error:', e.message); }

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
