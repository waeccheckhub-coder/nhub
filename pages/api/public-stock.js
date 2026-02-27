import db from '../../lib/db';
import { getPrices } from '../../lib/settings';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const results = await db.query(`
      SELECT type, COUNT(*) as count
      FROM vouchers
      WHERE status = 'available'
      GROUP BY type
    `);

    const stockMap = { WASSCE: 0, BECE: 0, CSSPS: 0 };
    results.rows.forEach(row => {
      stockMap[row.type] = parseInt(row.count);
    });

    // Get current prices from settings
    const prices = await getPrices();

    res.status(200).json({ stock: stockMap, prices });
  } catch (error) {
    res.status(500).json({ error: 'Stock check failed' });
  }
}
