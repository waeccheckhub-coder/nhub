// POST /api/init-payment
// Creates a Moolre hosted payment link and returns the authorization_url.
// Docs: POST https://api.moolre.com/embed/link

import { v4 as uuidv4 } from 'uuid';
import { getPrices } from '../../lib/settings';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Frontend sends: phone, name, quantity, type, network
  const { phone, name, quantity, type: voucherType, email } = req.body;

  if (!phone || !quantity || !voucherType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Look up price from settings (falls back to default if not set)
  const prices = await getPrices();
  const unitPrice = prices[voucherType];
  if (!unitPrice) {
    return res.status(400).json({ error: `Unknown voucher type: ${voucherType}` });
  }
  const amount = (unitPrice * parseInt(quantity)).toFixed(2);

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
        amount,
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
