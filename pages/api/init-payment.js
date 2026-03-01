import db from '../../lib/db';
import { v4 as uuidv4 } from 'uuid';
import { getPrices, ensurePreordersTable } from '../../lib/settings';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { phone, name, quantity, type } = req.body;
  if (!phone || !quantity || !type) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await ensurePreordersTable();

    const prices = await getPrices();
    const unitPrice = prices[type];
    if (!unitPrice) return res.status(400).json({ error: `Unknown voucher type: ${type}` });

    const qty = parseInt(quantity);
    const amount = (unitPrice * qty).toFixed(2);
    const reference = `WAEC-${type}-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;

    // Save order to DB before redirect so webhook can always find and fulfill it
    await db.query(
      `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'initiated', NOW())
       ON CONFLICT (reference) DO NOTHING`,
      [reference, phone, name || '', amount, qty, type]
    );

    // Request payment link from Moolre
    const moolreRes = await fetch('https://api.moolre.com/embed/link', {
      method: 'POST',
      headers: {
        'X-API-USER': process.env.MOOLRE_USERNAME,
        'X-API-PUBKEY': process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 1,
        amount,
        email: 'customer@waecghcheckers.com',
        externalref: reference,
        callback: `${baseUrl}/api/moolre-webhook`,
        redirect: `${baseUrl}/thank-you?ref=${reference}`,
        reusable: '0',
        currency: 'GHS',
        accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
        metadata: { phone, quantity: String(qty), voucher_type: type },
      }),
    });

    const data = await moolreRes.json();

    if (data.status !== 1 || !data.data?.authorization_url) {
      // Clean up the initiated preorder so it doesn't linger
      await db.query(`DELETE FROM preorders WHERE reference = $1`, [reference]);
      console.error('Moolre error:', data);
      return res.status(500).json({ error: data.message || 'Moolre did not return a payment URL' });
    }

    return res.status(200).json({
      reference,
      paymentUrl: data.data.authorization_url,
      amount,
      type,
    });

  } catch (error) {
    console.error('Init payment error:', error.message);
    return res.status(500).json({ error: 'Failed to initialize payment. Please try again.' });
  }
}
