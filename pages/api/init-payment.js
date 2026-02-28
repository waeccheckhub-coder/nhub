// POST /api/init-payment
// Creates a Moolre hosted payment link and returns the authorization_url
// Docs: POST https://api.moolre.com/embed/link

import { v4 as uuidv4 } from 'uuid';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, quantity, voucherType, amount, name, email } = req.body;

  if (!phone || !quantity || !voucherType || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Generate a unique reference for this transaction
  const externalref = `waec_${uuidv4()}`;

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;

  try {
    const response = await fetch('https://api.moolre.com/embed/link', {
      method: 'POST',
      headers: {
        'X-API-USER': process.env.MOOLRE_USERNAME,
        'X-API-PUBKEY': process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 1,
        amount: parseFloat(amount).toFixed(2),
        email: email || 'customer@waeccheckers.com',
        externalref,
        callback: `${baseUrl}/api/moolre-webhook`,
        redirect: `${baseUrl}/thank-you?ref=${externalref}`,
        reusable: '0',
        currency: 'GHS',
        accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
        metadata: {
          phone,
          quantity: String(quantity),
          voucher_type: voucherType,
          customer_name: name || '',
        },
      }),
    });

    const data = await response.json();

    // Moolre returns status: 1 for success, with data.authorization_url
    if (data.status !== 1 || !data.data?.authorization_url) {
      console.error('Moolre init-payment error:', data);
      return res.status(502).json({ error: data.message || 'Failed to create payment link' });
    }

    return res.status(200).json({
      paymentUrl: data.data.authorization_url,
      reference: externalref,
    });
  } catch (err) {
    console.error('init-payment fetch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
