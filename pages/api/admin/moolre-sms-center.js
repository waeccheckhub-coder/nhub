// POST /api/admin/moolre-sms-center
// Sends bulk SMS via Moolre's SMS API using the Best_Offers sender ID.
// Requires MOOLRE_SMS_VASKEY env var (from app.moolre.com → SMS Service → Admin → Manage API Key).

import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import pool from '../../../lib/db';
import { v4 as uuidv4 } from 'uuid';

const MOOLRE_SMS_URL  = 'https://api.moolre.com/open/sms/send';
const SENDER_ID       = 'Best_Offers';
const BATCH_SIZE      = 100; // max recipients per request

function normalisePhone(phone) {
  const clean = (phone || '').replace(/\s+/g, '');
  if (clean.startsWith('+233')) return clean.slice(1);
  if (clean.startsWith('233'))  return clean;
  if (clean.startsWith('0'))    return '233' + clean.slice(1);
  return clean;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const vasKey = process.env.MOOLRE_SMS_VASKEY;
  if (!vasKey) return res.status(500).json({ error: 'MOOLRE_SMS_VASKEY is not configured' });

  const { message, audience, voucherType, customNumbers } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

  // Build recipient list
  let phones = [];

  if (audience === 'custom') {
    phones = customNumbers.split(/[\n,]+/).map(p => p.trim()).filter(Boolean);
  } else {
    let query = `SELECT DISTINCT phone FROM transactions WHERE status='success' AND phone IS NOT NULL AND phone != ''`;
    const params = [];
    if (audience === 'type' && voucherType) {
      query += ` AND voucher_type=$1`;
      params.push(voucherType);
    }
    const result = await pool.query(query, params);
    phones = result.rows.map(r => r.phone);
  }

  if (phones.length === 0) return res.status(400).json({ error: 'No recipients found' });

  const formatted = phones.map(normalisePhone);

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < formatted.length; i += BATCH_SIZE) {
    const batch = formatted.slice(i, i + BATCH_SIZE);
    const messages = batch.map(recipient => ({
      recipient,
      message: message.trim(),
      ref: uuidv4(),
    }));

    try {
      const response = await fetch(MOOLRE_SMS_URL, {
        method: 'POST',
        headers: {
          'X-API-VASKEY':  vasKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 1, senderid: SENDER_ID, messages }),
      });
      const data = await response.json();
      console.log('[Moolre SMS] Batch response:', JSON.stringify(data));
      if (data.status === 1) sent += batch.length;
      else { failed += batch.length; console.error('[Moolre SMS] Batch failed:', JSON.stringify(data)); }
    } catch (err) {
      console.error('[Moolre SMS] Batch error:', err.message);
      failed += batch.length;
    }
  }

  return res.status(200).json({ success: true, total: formatted.length, sent, failed });
}
