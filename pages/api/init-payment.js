import db from '../../lib/db';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { getPrices } from '../../lib/settings';

/**
 * Moolre Payment Initialization
 *
 * Required .env variables:
 *   MOOLRE_SECRET_KEY    — Your Moolre secret/private key
 *   NEXT_PUBLIC_MOOLRE_PUBLIC_KEY — Your Moolre public key
 *   NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER — Your Moolre account number
 *
 * Moolre API Docs: https://docs.moolre.com
 * This uses the Moolre Collect (Receive Money) API.
 */

const MOOLRE_API_BASE = process.env.MOOLRE_API_BASE || 'https://api.moolre.com/v2';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { phone, name, quantity, type } = req.body;

  if (!phone || !quantity || !type) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const prices = await getPrices();
    const unitPrice = prices[type] || 30;
    const amount = unitPrice * parseInt(quantity);

    // Generate a unique reference
    const reference = `WAEC-${type}-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;

    /**
     * Initialize payment with Moolre API
     * 
     * NOTE: Confirm exact endpoint and payload structure with Moolre docs at https://docs.moolre.com
     * The structure below follows common Moolre API patterns.
     */
    const moolreRes = await axios.post(
      `${MOOLRE_API_BASE}/collect`,
      {
        publicKey: process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY,
        accountNumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
        amount: amount,
        currency: 'GHS',
        reference: reference,
        customerName: name || 'Customer',
        customerPhone: phone,
        description: `${quantity}x ${type} Voucher(s) - WAEC GH Checkers`,
        callbackUrl: `${process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL}/api/moolre-webhook`,
        returnUrl: `${process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL}/thank-you?ref=${reference}`,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.MOOLRE_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const { data } = moolreRes;

    // Return payment URL and reference to frontend
    return res.status(200).json({
      reference,
      paymentUrl: data.paymentUrl || data.payment_url || data.redirect_url || data.url,
      checkoutId: data.checkoutId || data.id || data.transactionId,
      amount,
      type,
    });

  } catch (error) {
    console.error('Init payment error:', error?.response?.data || error.message);
    return res.status(500).json({
      error: error?.response?.data?.message || 'Failed to initialize payment',
    });
  }
}
