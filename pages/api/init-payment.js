// POST /api/init-payment
// Supports Hubtel (default) and Moolre (fallback).
// provider param: 'hubtel' | 'moolre' — defaults to 'hubtel'

import db from '../../lib/db';
import { v4 as uuidv4 } from 'uuid';
import { getPrices, ensurePreordersTable } from '../../lib/settings';
import { initHubtelPayment } from '../../lib/hubtel';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { phone, name, quantity, type, provider = 'hubtel' } = req.body;
  if (!phone || !quantity || !type) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await ensurePreordersTable();

    const prices = await getPrices();
    const unitPrice = prices[type] || 30;
    const qty = parseInt(quantity);
    const amount = unitPrice * qty;
    // Reference must be alphanumeric, max 32 chars (Hubtel requirement)
    const reference = (`WAEC${type}${Date.now()}${uuidv4().slice(0, 8)}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32).toUpperCase();
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;

    // Save initiated order to DB before redirecting
    await db.query(
      `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'initiated', NOW())
       ON CONFLICT (reference) DO NOTHING`,
      [reference, phone, name || '', amount, qty, type]
    );

    const usedProvider = provider === 'moolre' ? 'moolre' : 'hubtel';
    let paymentUrl;

    // ── Hubtel ────────────────────────────────────────────────────────────────
    if (usedProvider === 'hubtel') {
      try {
        const result = await initHubtelPayment({
          phone, name, amount, reference,
          description: `${qty}x ${type} Voucher(s) - WAEC GH Checkers`,
          returnUrl: `${baseUrl}/thank-you?ref=${reference}&provider=hubtel`,
          cancelUrl: `${baseUrl}/?cancelled=1`,
        });
        paymentUrl = result.paymentUrl;
      } catch (hubtelErr) {
        console.error('[init-payment] Hubtel failed, falling back to Moolre:', hubtelErr.message);
        // Fall through to Moolre fallback
      }
    }

    // ── Moolre (explicit choice or Hubtel fallback) ────────────────────────
    if (!paymentUrl) {
      const moolreRes = await fetch('https://api.moolre.com/embed/link', {
        method: 'POST',
        headers: {
          'X-API-USER':   process.env.MOOLRE_USERNAME,
          'X-API-PUBKEY': process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type:          1,
          amount:        amount.toFixed(2),
          email:         'checkout@waecghcheckers.com',
          externalref:   reference,
          callback:      `${baseUrl}/api/moolre-webhook`,
          redirect:      `${baseUrl}/thank-you?ref=${reference}&provider=moolre`,
          reusable:      '0',
          currency:      'GHS',
          accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
          metadata:      { phone, name: name || '', quantity: String(qty), voucher_type: type },
        }),
      });

      const moolreData = await moolreRes.json();
      console.log('[init-payment] Moolre response:', JSON.stringify(moolreData));

      if (moolreData.status !== 1 || !moolreData.data?.authorization_url) {
        await db.query(`DELETE FROM preorders WHERE reference = $1`, [reference]);
        return res.status(500).json({ error: 'Payment initialization failed. Please try again.' });
      }

      paymentUrl = moolreData.data.authorization_url;
    }

    return res.status(200).json({ reference, paymentUrl, amount, type, provider: usedProvider });

  } catch (error) {
    console.error('[init-payment] Error:', error.message);
    return res.status(500).json({ error: 'Failed to initialize payment. Please try again.' });
  }
}
