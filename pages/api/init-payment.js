import { v4 as uuidv4 } from 'uuid';
import { getPrices } from '../../lib/settings';
import pool from '../../lib/db'; // Import your DB connection

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, name, quantity, type: voucherType, email } = req.body;

  if (!phone || !quantity || !voucherType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const prices = await getPrices();
  const unitPrice = prices[voucherType];
  if (!unitPrice) return res.status(400).json({ error: `Unknown voucher type: ${voucherType}` });
  
  const amount = (unitPrice * parseInt(quantity)).toFixed(2);
  const externalref = `waec_${uuidv4()}`;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;

  const client = await pool.connect();

  try {
    // 1. SAVE TRANSACTION BEFORE REDIRECT (Status: 'initialized')
    await client.query(
      `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'initialized', NOW())`,
      [externalref, phone, amount, quantity, voucherType]
    );

    // 2. Request Payment Link from Moolre
    const response = await fetch('https://api.moolre.com/embed/link', {
      method: 'POST',
      headers: {
        'X-API-USER': process.env.MOOLRE_USERNAME,
        'X-API-PUBKEY': process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 1,
        amount,
        email: email || 'customer@waeccheckers.com',
        externalref,
        callback: `${baseUrl}/api/moolre-webhook`,
        redirect: `${baseUrl}/thank-you?ref=${externalref}`, // Moolre returns here
        reusable: '0',
        currency: 'GHS',
        accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
        metadata: { phone, quantity: String(quantity), voucher_type: voucherType } // Backup metadata
      }),
    });

    const data = await response.json();

    if (data.status !== 1 || !data.data?.authorization_url) {
      throw new Error(data.message || 'Failed to generate payment link');
    }

    return res.status(200).json({
      paymentUrl: data.data.authorization_url,
      reference: externalref,
    });

  } catch (err) {
    console.error('init-payment error:', err);
    // Optional: Delete the initialized transaction if Moolre fails, or leave it as failed
    return res.status(500).json({ error: 'Could not initiate payment. Please try again.' });
  } finally {
    client.release();
  }
}
