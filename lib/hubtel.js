// lib/hubtel.js — Hubtel payment helper
//
// Required env vars:
//   HUBTEL_CLIENT_ID      — API ID (username) from Hubtel dashboard
//   HUBTEL_CLIENT_SECRET  — API Key (password) from Hubtel dashboard
//   HUBTEL_MERCHANT_ID    — POS Sales ID from Hubtel dashboard
//   NEXT_PUBLIC_BASE_URL  — your site URL

function authHeader() {
  const creds = Buffer.from(
    `${process.env.HUBTEL_CLIENT_ID}:${process.env.HUBTEL_CLIENT_SECRET}`
  ).toString('base64');
  return `Basic ${creds}`;
}

// clientReference max 32 chars, alphanumeric only
function safeRef(ref) {
  return ref.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
}

// Ensure phone is in international format 233XXXXXXXXX
function toInternational(phone) {
  const clean = (phone || '').replace(/\s+/g, '');
  if (clean.startsWith('+233')) return clean.slice(1);
  if (clean.startsWith('233'))  return clean;
  if (clean.startsWith('0'))    return '233' + clean.slice(1);
  return clean;
}

// Initiate a Hubtel web checkout — returns { paymentUrl, reference }
export async function initHubtelPayment({ phone, name, amount, reference, description, returnUrl, cancelUrl }) {
  const merchantId  = process.env.HUBTEL_MERCHANT_ID;
  const clientRef   = safeRef(reference);

  console.log('[Hubtel] checkout merchantId:', merchantId || 'MISSING');
  console.log('[Hubtel] checkout clientRef:', clientRef, '(', clientRef.length, 'chars)');

  let res, text;
  try {
    res  = await fetch('https://payproxyapi.hubtel.com/items/initiate', {
      method: 'POST',
      headers: {
        Authorization:  authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        merchantAccountNumber: merchantId,
        totalAmount:           parseFloat(amount).toFixed(2),
        description,
        callbackUrl:           `${process.env.NEXT_PUBLIC_BASE_URL}/api/hubtel-webhook`,
        returnUrl,
        cancellationUrl:       cancelUrl,
        clientReference:       clientRef,
        ...(name  && { payeeName:         name }),
        ...(phone && { payeeMobileNumber: toInternational(phone) }),
      }),
    });
    text = await res.text();
  } catch (fetchErr) {
    throw new Error(`Hubtel checkout fetch failed: ${fetchErr.message}`);
  }

  console.log('[Hubtel] checkout HTTP status:', res.status);
  console.log('[Hubtel] checkout raw:', text.slice(0, 400));

  let data;
  try { data = JSON.parse(text); }
  catch (_) { throw new Error(`Hubtel checkout non-JSON (${res.status}): ${text.slice(0, 200)}`); }

  if (data.responseCode !== '0000') {
    throw new Error(`Hubtel checkout failed [${data.responseCode}]: ${data.status || data.message || text.slice(0, 100)}`);
  }

  const paymentUrl = data.data?.checkoutUrl || data.data?.checkoutDirectUrl;
  if (!paymentUrl) throw new Error('Hubtel checkout returned no URL');

  return { paymentUrl, reference: clientRef };
}

// Trigger a direct MoMo debit (PIN prompt on customer's phone)
// Requires IP whitelisting with Hubtel — contact your Retail Systems Engineer
// network: 'MTN' | 'TELECEL' | 'AT'
export async function initHubtelDirectDebit({ phone, amount, reference, description, network }) {
  const channelMap  = { MTN: 'mtn-gh', TELECEL: 'vodafone-gh', AT: 'tigo-gh' };
  const channel     = channelMap[network?.toUpperCase()] || 'mtn-gh';
  const merchantId  = process.env.HUBTEL_MERCHANT_ID;
  const clientRef   = safeRef(reference);
  const msisdn      = toInternational(phone);

  const url = `https://rmp.hubtel.com/merchantaccount/merchants/${merchantId}/receive/mobilemoney`;

  console.log('[Hubtel] direct debit url:', url);
  console.log('[Hubtel] direct debit msisdn:', msisdn, 'channel:', channel, 'ref:', clientRef);

  let res, text;
  try {
    res  = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:  authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        CustomerMsisdn:     msisdn,
        Channel:            channel,
        Amount:             parseFloat(amount).toFixed(2),
        Description:        description,
        ClientReference:    clientRef,
        PrimaryCallbackUrl: `${process.env.NEXT_PUBLIC_BASE_URL}/api/hubtel-webhook`,
      }),
    });
    text = await res.text();
  } catch (fetchErr) {
    throw new Error(`Hubtel direct debit fetch failed: ${fetchErr.message}`);
  }

  console.log('[Hubtel] direct debit HTTP status:', res.status);
  console.log('[Hubtel] direct debit raw:', text.slice(0, 400));

  let data;
  try { data = JSON.parse(text); }
  catch (_) { throw new Error(`Hubtel direct debit non-JSON (${res.status}): ${text.slice(0, 200)}`); }

  // 0001 = pending (expected success), 0000 = immediate success
  if (data.ResponseCode !== '0001' && data.ResponseCode !== '0000') {
    throw new Error(`Hubtel direct debit failed [${data.ResponseCode}]: ${data.Message || text.slice(0, 100)}`);
  }

  return data;
}

// Verify transaction status by clientReference
// Note: also requires IP whitelisting for api-txnstatus.hubtel.com
export async function verifyHubtelPayment(clientReference) {
  const merchantId = process.env.HUBTEL_MERCHANT_ID;
  const url = `https://api-txnstatus.hubtel.com/transactions/${merchantId}/status?clientReference=${encodeURIComponent(clientReference)}`;

  let res, text;
  try {
    res  = await fetch(url, { headers: { Authorization: authHeader() } });
    text = await res.text();
  } catch (fetchErr) {
    throw new Error(`Hubtel verify fetch failed: ${fetchErr.message}`);
  }

  console.log('[Hubtel] verify raw:', text.slice(0, 400));

  let data;
  try { data = JSON.parse(text); }
  catch (_) { throw new Error(`Hubtel verify non-JSON: ${text.slice(0, 200)}`); }

  const txData    = data.data || {};
  const status    = (txData.status || '').toLowerCase();
  const isSuccess = data.responseCode === '0000' && status === 'paid';

  return { isSuccess, status, responseCode: data.responseCode, data };
}
