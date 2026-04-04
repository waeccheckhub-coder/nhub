// POST /api/admin/sms-center
// Sends a bulk SMS to all customers, a specific voucher type's customers,
// or a custom list of numbers using Arkesel.

import pool from '../../../lib/db';


import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { message, audience, voucherType, customNumbers } = req.body;

  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
  if (message.length > 320) return res.status(400).json({ error: 'Message too long (max 320 chars)' });

  const apiKey = process.env.ARKESEL_API_KEY;
  const senderId = process.env.ARKESEL_SENDER_ID || 'WAEC-GH';
  if (!apiKey) return res.status(500).json({ error: 'SMS API key not configured' });

  // Build recipient list
  let phones = [];

  if (audience === 'custom') {
    // Custom numbers — one per line or comma separated
    phones = customNumbers
      .split(/[\n,]+/)
      .map(p => p.trim())
      .filter(Boolean);
  } else {
    // Pull from transactions table — unique phones
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

  // Normalise to 233XXXXXXXXX format
  const allFormatted = phones.map(p => {
    const clean = (p || '').replace(/\s+/g, '');
    if (clean.startsWith('+233')) return clean.slice(1);
    if (clean.startsWith('233'))  return clean;
    if (clean.startsWith('0'))    return '233' + clean.slice(1);
    return clean;
  });

  // Hobby plan: process one page of 25 per request
  // Frontend calls repeatedly with increasing offset until done
  const BATCH_SIZE = 25;
  const offset = parseInt(req.body.offset || 0);
  const batch = allFormatted.slice(offset, offset + BATCH_SIZE);
  const remaining = allFormatted.length - offset - batch.length;

  let sent = 0;
  let failed = 0;

  if (batch.length > 0) {
    try {
      const response = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: senderId, message: message.trim(), recipients: batch }),
      });
      const data = await response.json();
      console.log('[SMS Center] Batch response:', JSON.stringify(data));
      if (data.status === 'success') sent += batch.length;
      else { failed += batch.length; console.error('[SMS Center] Failed:', JSON.stringify(data)); }
    } catch (err) {
      console.error('[SMS Center] Batch error:', err.message);
      failed += batch.length;
    }
  }

  return res.status(200).json({
    success: true,
    total: allFormatted.length,
    sent,
    failed,
    nextOffset: remaining > 0 ? offset + BATCH_SIZE : null,
    remaining,
  });
}
