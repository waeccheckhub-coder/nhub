import db from '../../lib/db';
import { getPrices, getSetting } from '../../lib/settings';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const [stockRes, prices, supportWhatsapp] = await Promise.all([
      db.query(`SELECT type, COUNT(*) as count FROM vouchers WHERE status = 'available' GROUP BY type`),
      getPrices(),
      getSetting('support_whatsapp', ''),
    ]);

    const stock = { WASSCE: 0, BECE: 0, CSSPS: 0 };
    stockRes.rows.forEach(row => { stock[row.type] = parseInt(row.count); });

    res.status(200).json({ stock, prices, supportWhatsapp });
  } catch (error) {
    console.error('public-stock error:', error.message);
    res.status(500).json({ error: 'Stock check failed' });
  }
}
