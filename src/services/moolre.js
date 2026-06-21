/**
 * Moolre API client
 */

const axios  = require('axios');
const config = require('../config');

// ── API clients ───────────────────────────────────────────────────────────────

const publicClient = axios.create({
  baseURL: config.MOOLRE_BASE_URL,
  headers: {
    'X-API-USER':   config.MOOLRE_USERNAME,
    'X-API-PUBKEY': config.MOOLRE_PUBLIC_KEY,
    'Content-Type': 'application/json',
  },
  timeout: 12_000,
});

const privateClient = axios.create({
  baseURL: config.MOOLRE_BASE_URL,
  headers: {
    'X-API-USER': config.MOOLRE_USERNAME,
    'X-API-KEY':  config.MOOLRE_API_KEY,
    'Content-Type': 'application/json',
  },
  timeout: 10_000,
});

function _attachErrorHandler(client) {
  client.interceptors.response.use(
    (res) => res,
    (err) => {
      const status  = err.response?.status;
      const body    = err.response?.data;
      const message = body?.message || body?.error || err.message;
      if (status === 401 || status === 403)
        throw new Error('[Moolre] Authentication failed — check credentials in .env');
      if (status >= 500)
        throw new Error(`[Moolre] Server error (${status}): ${message}`);
      if (!err.response)
        throw new Error(`[Moolre] Network error: ${err.message}`);
      throw new Error(`[Moolre] ${message || `HTTP ${status}`}`);
    }
  );
}

_attachErrorHandler(publicClient);
_attachErrorHandler(privateClient);

// ── Initiate payment ──────────────────────────────────────────────────────────

async function initiatePayment({ payer, networkCode, amount, externalRef, ussdSessionId, reference }) {
  const channel = config.NETWORK_TO_CHANNEL[networkCode];
  if (!channel) throw new Error(`[Moolre] Unknown network code: ${networkCode}`);

  // Moolre requires the payer number in international format: 233XXXXXXXXX
  const payerFormatted = _toInternational(payer);

  const payload = {
    type:          1,
    channel,
    currency:      'GHS',
    payer:         payerFormatted,
    amount,
    externalref:   externalRef,
    accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
    reference:     reference || 'Data bundle purchase',
    sessionid:     ussdSessionId,
  };

  // ── Full request log — check Render logs if payment prompt doesn't arrive ──
  console.log('[Moolre] → initiatePayment request:', JSON.stringify({
    ...payload,
    // mask last 4 digits of payer for privacy in logs
    payer: payerFormatted.slice(0, -4) + '****',
  }));

  // IMPORTANT: Initiate Payment requires the PRIVATE key under X-API-KEY,
  // not the public key under X-API-PUBKEY. See:
  // https://docs.moolre.com/ai/initiate-payment.html
  // Using publicClient here was rejected by Moolre before any USSD prompt
  // was sent — this was the root cause of missing payment prompts.
  const { data } = await privateClient.post('/open/transact/payment', payload);

  // ── Full response log — this is the most important thing to check ──────────
  console.log('[Moolre] ← initiatePayment response:', JSON.stringify(data));

  // Per Moolre docs (https://docs.moolre.com/ai/initiate-payment.html),
  // a prompt was actually sent to the customer's phone only when:
  //   status === 1 AND code is "TR099" (prompt sent) or "TP14" (OTP required,
  //   prompt also sent — customer must verify via SMS first)
  // Any other status/code (e.g. AIN01 auth error, TP13 duplicate ref) means
  // NO prompt reached the customer. Guessing "ok" from message text alone
  // (e.g. matching "pending"/"processing") risks masking real auth/validation
  // failures as success, which is what let this fail silently before.
  const statusCode = data?.status;
  const numStatus  = typeof statusCode === 'string' ? parseInt(statusCode, 10) : statusCode;
  const code       = data?.code || '';

  const ok = numStatus === 1 && (code === 'TR099' || code === 'TP14');

  if (!ok) {
    console.warn(`[Moolre] ⚠️  Payment NOT accepted for ${externalRef}:`);
    console.warn(`[Moolre]    status=${numStatus} message="${data?.message}"`);
    console.warn(`[Moolre]    Full response: ${JSON.stringify(data)}`);
  } else {
    console.log(`[Moolre] ✅ Payment accepted for ${externalRef} — status=${numStatus} message="${data?.message}"`);
  }

  return { ok, statusCode: numStatus, message: data?.message || '', raw: data };
}

async function checkPaymentStatus(externalRef) {
  const { data } = await privateClient.post('/open/transact/status', {
    type:          1,
    idtype:        1,
    id:            externalRef,
    accountnumber: config.MOOLRE_ACCOUNT_NUMBER,
  });
  console.log(`[Moolre] ← checkPaymentStatus (${externalRef}):`, JSON.stringify(data));
  return data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert any phone format to international: 233XXXXXXXXX
 * Moolre's payment API expects the payer in this format.
 */
function _toInternational(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('233') && digits.length >= 12) return digits;
  if (digits.startsWith('0')   && digits.length === 10) return '233' + digits.slice(1);
  if (digits.length === 9)                               return '233' + digits;
  return digits;
}

module.exports = { initiatePayment, checkPaymentStatus };
