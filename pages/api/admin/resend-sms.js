// POST /api/admin/resend-sms
// Looks up the vouchers for a transaction by reference and resends them via SMS.

import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import db from '../../../lib/db';

function getPortalLink(type) {
  const t = (type || '').toUpperCase();
  if (t.includes('WASSCE') || t.includes('NOVDEC')) return 'https://ghana.waecdirect.org';
  if (t.includes('BECE')) return 'https://eresults.waecgh.org';

  return 'https://waeccardsonline.com';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'Missing reference' });

  // Load transaction
  const txRes = await db.query(
    `SELECT * FROM transactions WHERE reference = $1`,
    [reference]
  );
  if (txRes.rowCount === 0) return res.status(404).json({ error: 'Transaction not found' });
  const tx = txRes.rows[0];

  // Load vouchers assigned to this transaction
  const voucherRes = await db.query(
    `SELECT serial, pin FROM vouchers WHERE transaction_ref = $1`,
    [reference]
  );
  if (voucherRes.rowCount === 0) {
    return res.status(404).json({ error: 'No vouchers found for this transaction' });
  }

  const phone = tx.phone;
  const type  = tx.voucher_type;
  const clean = (phone || '').replace(/\s+/g, '');
  const formattedPhone = clean.startsWith('+233') ? clean.slice(1)
    : clean.startsWith('233') ? clean
    : clean.startsWith('0')   ? '233' + clean.slice(1)
    : clean;

  const lines = voucherRes.rows.map((v, i) => `${i + 1}. S/N: ${v.serial} PIN: ${v.pin}`).join('\n');
  const message =
    `Your ${type} checker voucher(s):\n\n${lines}\n\nCheck results: ${getPortalLink(type)}\n\nThank you!`;

  const smsRes = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
    method: 'POST',
    headers: { 'api-key': process.env.ARKESEL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: process.env.ARKESEL_SENDER_ID || 'WAEC-GH',
      message,
      recipients: [formattedPhone],
    }),
  });

  const smsData = await smsRes.json();
  console.log('[resend-sms] Arkesel response:', JSON.stringify(smsData));

  if (smsData.status !== 'success') {
    return res.status(502).json({ error: 'SMS failed', detail: smsData });
  }

  return res.status(200).json({ success: true, phone: formattedPhone, vouchers: voucherRes.rowCount });
}
