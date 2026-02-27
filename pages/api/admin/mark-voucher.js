import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import db from '../../../lib/db';

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Access Denied" });

  if (req.method !== 'POST') return res.status(405).end();

  const { serial, serials, status } = req.body;
  const allowed = ['available', 'sold', 'used'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    if (serials && Array.isArray(serials)) {
      // Bulk update
      await db.query(
        `UPDATE vouchers SET status = $1 WHERE serial = ANY($2)`,
        [status, serials]
      );
      return res.status(200).json({ success: true, updated: serials.length });
    } else if (serial) {
      await db.query(
        `UPDATE vouchers SET status = $1 WHERE serial = $2`,
        [status, serial]
      );
      return res.status(200).json({ success: true });
    } else {
      return res.status(400).json({ error: 'No serial(s) provided' });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
