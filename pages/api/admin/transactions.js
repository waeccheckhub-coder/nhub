import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import db from '../../../lib/db';

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Access Denied" });

  if (req.method !== 'GET') return res.status(405).end();

  const { page = 1, limit = 50, type = '', status = '', search = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const conditions = [];
  const params = [];

  if (type) { params.push(type); conditions.push(`voucher_type = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(reference ILIKE $${params.length} OR phone ILIKE $${params.length})`);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(parseInt(limit));
  params.push(offset);

  const [txRes, countRes, sumRes] = await Promise.all([
    db.query(
      `SELECT * FROM transactions ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    ),
    db.query(`SELECT COUNT(*) FROM transactions ${where}`, params.slice(0, -2)),
    db.query(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE status = 'success'`),
  ]);

  return res.status(200).json({
    transactions: txRes.rows,
    total: parseInt(countRes.rows[0].count),
    totalRevenue: parseFloat(sumRes.rows[0].total),
    page: parseInt(page),
    limit: parseInt(limit),
  });
}
