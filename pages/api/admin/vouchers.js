import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import db from '../../../lib/db';

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Access Denied" });

  if (req.method === 'GET') {
    const {
      page = 1,
      limit = 50,
      type = '',
      status = '',
      search = '',
      sortBy = 'created_at',
      sortDir = 'DESC',
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];

    if (type) { params.push(type); conditions.push(`type = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(serial ILIKE $${params.length} OR pin ILIKE $${params.length} OR sold_to ILIKE $${params.length})`);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const allowedSort = ['created_at', 'sold_at', 'type', 'status', 'serial'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'created_at';
    const safeSortDir = sortDir === 'ASC' ? 'ASC' : 'DESC';

    params.push(parseInt(limit));
    params.push(offset);

    const [vouchersRes, countRes] = await Promise.all([
      db.query(
        `SELECT id, type, serial, pin, status, sold_to, transaction_ref, created_at, sold_at
         FROM vouchers ${where}
         ORDER BY ${safeSortBy} ${safeSortDir}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      db.query(`SELECT COUNT(*) FROM vouchers ${where}`, params.slice(0, -2)),
    ]);

    return res.status(200).json({
      vouchers: vouchersRes.rows,
      total: parseInt(countRes.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  }

  return res.status(405).end();
}
