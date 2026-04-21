// lib/hubtel.js — Hubtel payment helper
//
// Required env vars:
//   HUBTEL_CLIENT_ID      — API ID (username) from Hubtel dashboard
//   HUBTEL_CLIENT_SECRET  — API Key (password) from Hubtel dashboard
//   HUBTEL_MERCHANT_ID    — Account ID from Hubtel dashboard
//   NEXT_PUBLIC_BASE_URL  — your site URL

function authHeader() {
  const creds = Buffer.from(
    `${process.env.HUBTEL_CLIENT_ID}:${process.env.HUBTEL_CLIENT_SECRET}`
  ).toString('base64');
  return `Basic ${creds}`;
}

// Initiate a Hubtel web checkout — returns { paymentUrl, reference }
export async function initHubtelPayment({ phone, name, amount, reference, description, returnUrl, cancelUrl }) {
  const res = await fetch('https://payproxyapi.hubtel.com/items/initiate', {
    method: 'POST',
    headers: {
      Authorization:  authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      merchantAccountNumber: process.env.HUBTEL_MERCHANT_ID,
      totalAmount:           amount,
      description,
      callbackUrl:           `${process.env.NEXT_PUBLIC_BASE_URL}/api/hubtel-webhook`,
      returnUrl,
      cancellationUrl:       cancelUrl,
      clientReference:       reference,
      ...(name  && { payeeName:         name }),
      ...(phone && { payeeMobileNumber: phone }),
    }),
  });

  // Hubtel returns HTML on wrong URLs — catch it explicitly
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (_) { throw new Error(`Hubtel returned non-JSON: ${text.slice(0, 120)}`); }

  console.log('[Hubtel] checkout response:', JSON.stringify(data));

  if (data.responseCode !== '0000' && data.code !== '200') {
    throw new Error(data.message || data.description || 'Hubtel checkout failed');
  }

  const paymentUrl = data.data?.checkoutUrl || data.data?.checkoutDirectUrl;
  if (!paymentUrl) throw new Error('Hubtel returned no checkout URL');

  return { paymentUrl, reference };
}

// Trigger a direct debit (MoMo PIN prompt) via Hubtel Merchant Account API
// network: 'MTN' | 'TELECEL' | 'AT'
export async function initHubtelDirectDebit({ phone, amount, reference, description, network }) {
  const channelMap = { MTN: 'mtn-gh', TELECEL: 'vodafone-gh', AT: 'airtel-tigo-gh' };
  const channel    = channelMap[network?.toUpperCase()] || 'mtn-gh';
  const merchantId = process.env.HUBTEL_MERCHANT_ID;

  const url = `https://api.hubtel.com/v1/merchantaccount/merchants/${merchantId}/receive/mobilemoney`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:  authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      CustomerMsisdn:      phone,
      Channel:             channel,
      Amount:              amount,
      Description:         description,
      ClientReference:     reference,
      PrimaryCallbackUrl:  `${process.env.NEXT_PUBLIC_BASE_URL}/api/hubtel-webhook`,
    }),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (_) { throw new Error(`Hubtel direct debit returned non-JSON: ${text.slice(0, 120)}`); }

  console.log('[Hubtel] direct debit response:', JSON.stringify(data));

  if (data.ResponseCode !== '0000') {
    throw new Error(data.Data?.Description || data.Message || `Hubtel direct debit failed: ${data.ResponseCode}`);
  }

  return data;
}

// Verify a Hubtel transaction by ClientReference
export async function verifyHubtelPayment(clientReference) {
  const merchantId = process.env.HUBTEL_MERCHANT_ID;
  const url = `https://api.hubtel.com/v1/merchantaccount/merchants/${merchantId}/transactions/status?clientReference=${encodeURIComponent(clientReference)}`;

  const res  = await fetch(url, { headers: { Authorization: authHeader() } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (_) { throw new Error(`Hubtel verify returned non-JSON: ${text.slice(0, 120)}`); }

  console.log('[Hubtel] verify response:', JSON.stringify(data));

  const responseCode = data.ResponseCode || data.responseCode || '';
  const txData       = data.Data || data.data || {};
  const status       = (txData.Status || txData.status || txData.TransactionStatus || '').toLowerCase();

  const isSuccess = responseCode === '0000' &&
    ['successful', 'success', 'paid', 'completed'].includes(status);

  return { isSuccess, status, responseCode, data };
}
