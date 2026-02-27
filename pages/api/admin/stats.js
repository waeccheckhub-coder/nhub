import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import db from '../../../lib/db';
import { ensurePreordersTable } from '../../../lib/settings';

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Access Denied" });

  try {
    await ensurePreordersTable();

    const [totalRes, soldRes, availableRes, usedRes, revenueRes, pendingPreordersRes, byTypeRes, recentTxRes] =
      await Promise.all([
        db.query('SELECT COUNT(*) FROM vouchers'),
        db.query("SELECT COUNT(*) FROM vouchers WHERE status = 'sold'"),
        db.query("SELECT COUNT(*) FROM vouchers WHERE status = 'available'"),
        db.query("SELECT COUNT(*) FROM vouchers WHERE status = 'used'"),
        db.query("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE status = 'success'"),
        db.query("SELECT COUNT(*) FROM preorders WHERE status = 'pending'"),
        db.query(`
          SELECT type,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status = 'available') as available,
            COUNT(*) FILTER (WHERE status = 'sold') as sold,
            COUNT(*) FILTER (WHERE status = 'used') as used
          FROM vouchers GROUP BY type ORDER BY type
        `),
        db.query(`
          SELECT reference, phone, amount, quantity, voucher_type, status, created_at
          FROM transactions ORDER BY created_at DESC LIMIT 10
        `),
      ]);

    return res.status(200).json({
      stats: {
        total: parseInt(totalRes.rows[0].count),
        sold: parseInt(soldRes.rows[0].count),
        available: parseInt(availableRes.rows[0].count),
        used: parseInt(usedRes.rows[0].count),
        revenue: parseFloat(revenueRes.rows[0].total),
        pendingPreorders: parseInt(pendingPreordersRes.rows[0].count),
      },
      byType: byTypeRes.rows,
      recentTransactions: recentTxRes.rows,
    });
  } catch (error) {
    console.error("Stats API Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
