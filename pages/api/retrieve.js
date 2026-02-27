import db from '../../lib/db';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  const { phone } = req.body;
  
  try {
    const { rows } = await db.query(`
      SELECT type, serial, pin, created_at 
      FROM vouchers 
      WHERE sold_to = $1 
      ORDER BY created_at DESC 
      LIMIT 20
    `, [phone]);
    
    res.status(200).json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
}
