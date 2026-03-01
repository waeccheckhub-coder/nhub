import db from '../../lib/db';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getPrices, ensurePreordersTable } from '../../lib/settings';

const MOOLRE_API_BASE = process.env.MOOLRE_API_BASE || 'https://api.moolre.com/v2';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { phone, name, quantity, type } = req.body;
  if (!phone || !quantity || !type) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await ensurePreordersTable();

    const prices = await getPrices();
    const unitPrice = prices[type] || 30;
    const qty = parseInt(quantity);
    const amount = unitPrice * qty;
    const reference = `WAEC-${type}-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;

    // Save initiated order to DB BEFORE redirecting to Moolre.
    // This ensures the webhook can always find and fulfill the order,
    // even if the customer clears localStorage or uses a different device.
    await db.query(
      `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'initiated', NOW())
       ON CONFLICT (reference) DO NOTHING`,
      [reference, phone, name || '', amount, qty, type]
    );

    // Initialize payment with Moolre
    const moolreRes = await axios.post(
      `${MOOLRE_API_BASE}/collect`,
      {
        publicKey: process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY,
        accountNumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
        amount,
        currency: 'GHS',
        reference,
        customerName: name || 'Customer',
        customerPhone: phone,
        description: `${qty}x ${type} Voucher(s) - WAEC GH Checkers`,
        callbackUrl: `${process.env.NEXT_PUBLIC_BASE_URL}/api/moolre-webhook`,
        returnUrl: `${process.env.NEXT_PUBLIC_BASE_URL}/thank-you?ref=${reference}`,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.MOOLRE_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const { data } = moolreRes;
    const paymentUrl = data.paymentUrl || data.payment_url || data.redirect_url || data.url;

    if (!paymentUrl) {
      // Clean up the initiated preorder since we can't redirect
      await db.query(`DELETE FROM preorders WHERE reference = $1`, [reference]);
      return res.status(500).json({ error: 'Moolre did not return a payment URL' });
    }

    return res.status(200).json({ reference, paymentUrl, amount, type });

  } catch (error) {
    console.error('Init payment error:', error?.response?.data || error.message);
    return res.status(500).json({
      error: error?.response?.data?.message || 'Failed to initialize payment',
    });
  }
}
