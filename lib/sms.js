import { formatPhone } from './phone.js';

function getPortalLink(type) {
  const t = (type || '').toUpperCase();
  if (t.includes('WASSCE') || t.includes('NOVDEC')) return 'https://ghana.waecdirect.org';
  if (t.includes('BECE')) return 'https://eresults.waecgh.org';
  if (t.includes('CSSPS') || t.includes('PLACEMENT')) return 'https://www.cssps.gov.gh';
  return 'https://waeccardsonline.com';
}

/**
 * Send an SMS via Arkesel v2.
 * Sender ID is read from ARKESEL_SENDER_ID env var.
 */
export async function sendSMS(phone, message) {
  const apiKey = process.env.ARKESEL_API_KEY;
  const sender = process.env.ARKESEL_SENDER_ID;

  if (!apiKey) { console.error('[SMS] ARKESEL_API_KEY not set'); return null; }
  if (!sender) { console.error('[SMS] ARKESEL_SENDER_ID not set'); return null; }
  if (!phone)  { console.error('[SMS] No phone provided'); return null; }

  const recipient = formatPhone(phone);
  const payload = { sender, message, recipients: [recipient] };

  try {
    const res = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (result.status !== 'success') {
      console.error('[SMS] Arkesel error:', JSON.stringify(result), '| to:', recipient, '| sender:', sender);
    } else {
      console.log('[SMS] Sent OK to', recipient);
    }
    return result;
  } catch (err) {
    console.error('[SMS] Network error:', err.message);
    return null;
  }
}

/** Send vouchers to a customer after successful payment */
export async function sendVoucherSMS(phone, vouchers, voucherType, { waitMessage = false } = {}) {
  const lines = vouchers.map((v, i) => `${i + 1}. S/N: ${v.serial}  PIN: ${v.pin}`).join('\n');
  const suffix = waitMessage ? '\nSorry for the wait — thank you!' : '\nThank you!';
  const message =
    `Your ${voucherType} voucher(s):\n\n${lines}\n\nCheck results: ${getPortalLink(voucherType)}${suffix}`;
  return sendSMS(phone, message);
}

/** Notify customer their payment is confirmed but vouchers are out of stock */
export async function sendPreorderSMS(phone, voucherType, reference) {
  const message =
    `Payment confirmed (Ref: ${reference.slice(-8)}). Your ${voucherType} voucher(s) are ` +
    `temporarily out of stock and will be SMS'd as soon as available. Thank you!`;
  return sendSMS(phone, message);
}
