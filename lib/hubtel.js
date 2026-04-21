// lib/hubtel.js — Hubtel payment helper
// Docs: https://developers.hubtel.com/docs/
//
// Required env vars:
//   HUBTEL_CLIENT_ID      — from Hubtel merchant dashboard
//   HUBTEL_CLIENT_SECRET  — from Hubtel merchant dashboard
//   HUBTEL_MERCHANT_ID    — your Hubtel merchant account number
//   NEXT_PUBLIC_BASE_URL  — your site URL

const HUBTEL_BASE = 'https://api.hubtel.com/v2';

function authHeader() {
  const creds = Buffer.from(
    `${process.env.HUBTEL_CLIENT_ID}:${process.env.HUBTEL_CLIENT_SECRET}`
  ).toString('base64');
  return `Basic ${creds}`;
}

// Initiate a Hubtel checkout — returns { paymentUrl, reference }
export async function initHubtelPayment({ phone, name, amount, reference, description, returnUrl, cancelUrl }) {
  const res = await fetch(`${HUBTEL_BASE}/checkout/initiate`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      merchantAccountNumber: process.env.HUBTEL_MERCHANT_ID,
      returnUrl,
      cancellationUrl: cancelUrl,
      clientReference: reference,
      description,
      totalAmount: amount,
      callbackUrl: `${process.env.NEXT_PUBLIC_BASE_URL}/api/hubtel-webhook`,
      requestInitiatorCountryAlpha2Code: 'GH',
      customerPhoneNumber: phone,
      customerName: name || 'Customer',
    }),
  });

  const data = await res.json();
  console.log('[Hubtel] init response:', JSON.stringify(data));

  if (!res.ok || data.responseCode !== '0000') {
    throw new Error(data.message || 'Hubtel checkout initiation failed');
  }

  return {
    paymentUrl: data.data?.checkoutDirectUrl || data.data?.checkoutUrl,
    reference,
  };
}

// Trigger a USSD push payment (direct debit) via Hubtel
// network: 'MTN', 'VODAFONE', 'AIRTELTIGO'
export async function initHubtelDirectDebit({ phone, amount, reference, description, network }) {
  // Map network names to Hubtel channel codes
  const channelMap = { MTN: 'mtn-gh', TELECEL: 'vodafone-gh', AT: 'airtel-tigo-gh' };
  const channel = channelMap[network?.toUpperCase()] || 'mtn-gh';

  const res = await fetch(`${HUBTEL_BASE}/receive-money/request`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      customerMsisdn: phone,
      amount,
      primaryCallbackUrl: `${process.env.NEXT_PUBLIC_BASE_URL}/api/hubtel-webhook`,
      description,
      clientReference: reference,
      channel,
    }),
  });

  const data = await res.json();
  console.log('[Hubtel] direct debit response:', JSON.stringify(data));

  if (!res.ok || data.responseCode !== '0000') {
    throw new Error(data.message || 'Hubtel direct debit failed');
  }

  return data;
}

// Verify a Hubtel transaction status
export async function verifyHubtelPayment(clientReference) {
  const res = await fetch(
    `${HUBTEL_BASE}/transactions/status?clientReference=${encodeURIComponent(clientReference)}`,
    { headers: { Authorization: authHeader() } }
  );

  const data = await res.json();
  console.log('[Hubtel] verify response:', JSON.stringify(data));

  const status = (data.data?.transactionStatus || data.data?.status || '').toLowerCase();
  const isSuccess = ['successful', 'success', 'paid', 'completed'].includes(status);

  return { isSuccess, status, data };
}
