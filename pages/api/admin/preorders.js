import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import db from '../../../lib/db';
import { ensurePreordersTable } from '../../../lib/settings';

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Access Denied" });

  await ensurePreordersTable();

  if (req.method !== 'GET') return res.status(405).end();

  const { page = 1, limit = 50, status = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const where = status ? `WHERE status = '${status}'` : '';

  const [preorderRes, countRes] = await Promise.all([
    db.query(
      `SELECT * FROM preorders ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [parseInt(limit), offset]
    ),
    db.query(`SELECT COUNT(*) FROM preorders ${where}`),
  ]);

  return res.status(200).json({
    preorders: preorderRes.rows,
    total: parseInt(countRes.rows[0].count),
    page: parseInt(page),
    limit: parseInt(limit),
  });
}
