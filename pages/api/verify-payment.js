// POST /api/verify-payment
// Verifies payment with either Hubtel or Moolre based on provider param.

import db from '../../lib/db';
import { verifyHubtelPayment } from '../../lib/hubtel';
import { sendVoucherSMS, sendPreorderSMS } from '../../lib/sms';
import { sendAdminAlert, checkAndAlertStock } from '../../lib/alerts';

function getPortalLink(type) {
  const t = (type || '').toUpperCase();
  if (t.includes('WASSCE') || t.includes('NOVDEC')) return 'https://ghana.waecdirect.org';
  if (t.includes('BECE')) return 'https://eresults.waecgh.org';
  return 'https://waeccardsonline.com';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { reference, quantity, type, phone, name, provider = 'hubtel' } = req.body;
  if (!reference) return res.status(400).json({ error: 'Missing reference' });

  try {
    // Idempotency — already fulfilled
    const existingTx = await db.query(
      `SELECT status FROM transactions WHERE reference=$1`,
      [reference]
    );
    if (existingTx.rowCount > 0 && existingTx.rows[0].status === 'success') {
      const assigned = await db.query(
        `SELECT type, serial, pin FROM vouchers WHERE transaction_ref=$1`,
        [reference]
      );
      if (assigned.rowCount > 0) return res.status(200).json({ vouchers: assigned.rows });
    }

    // ── Verify payment with the correct provider ─────────────────────────────
    let isSuccess = false;
    let verifiedAmount = 0;
    let resolvedPhone = phone || '';

    if (provider === 'moolre') {
      // Moolre verify
      const moolreRes = await fetch('https://api.moolre.com/open/transact/status', {
        method: 'POST',
        headers: {
          'X-API-USER':   process.env.MOOLRE_USERNAME,
          'X-API-PUBKEY': process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 1, idtype: 1, id: reference,
          accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
        }),
      });
      const moolreData = await moolreRes.json();
      console.log('[verify-payment] Moolre status:', JSON.stringify(moolreData));
      isSuccess = Number(moolreData?.data?.txstatus) === 1;
      verifiedAmount = moolreData?.data?.amount || 0;
    } else {
      // Hubtel verify (default)
      const result = await verifyHubtelPayment(reference);
      isSuccess = result.isSuccess;
      verifiedAmount = result.data?.data?.amount || 0;
      resolvedPhone = result.data?.data?.customerMsisdn || phone || '';
    }

    if (!isSuccess) {
      return res.status(400).json({ error: 'Payment not confirmed. Please wait a moment and try again.' });
    }

    const qty = parseInt(quantity) || 1;

    // Fulfill with DB lock
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const vouchers = await client.query(
        `SELECT id, serial, pin, type FROM vouchers
         WHERE type=$1 AND status='available'
         LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [type, qty]
      );

      if (vouchers.rowCount < qty) {
        await client.query('ROLLBACK');
        client.release();

        await db.query(
          `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW())
           ON CONFLICT (reference) DO UPDATE SET status='pending'`,
          [reference, resolvedPhone, name || '', verifiedAmount, qty, type]
        );
        await db.query(
          `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
           VALUES ($1,$2,$3,$4,$5,'preorder',NOW())
           ON CONFLICT (reference) DO UPDATE SET status='preorder'`,
          [reference, resolvedPhone, verifiedAmount, qty, type]
        );

        await sendPreorderSMS(resolvedPhone, type, reference);
        await sendAdminAlert(`⚠️ OUT OF STOCK (verify): ${type} x${qty} from ${resolvedPhone}. Ref: ${reference}`);

        return res.status(200).json({ success: true, preorder: true, vouchers: [] });
      }

      const ids = vouchers.rows.map(v => v.id);
      await client.query(
        `UPDATE vouchers SET status='sold', sold_to=$1, sold_at=NOW(), transaction_ref=$2 WHERE id=ANY($3)`,
        [resolvedPhone, reference, ids]
      );
      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
         VALUES ($1,$2,$3,$4,$5,'success',NOW())
         ON CONFLICT (reference) DO UPDATE SET status='success'`,
        [reference, resolvedPhone, verifiedAmount, qty, type]
      );
      await client.query(
        `UPDATE preorders SET status='fulfilled', fulfilled_at=NOW()
         WHERE reference=$1 AND status IN ('initiated','pending')`,
        [reference]
      );
      await client.query('COMMIT');
      client.release();

      await sendVoucherSMS(resolvedPhone, vouchers.rows, type);
      await checkAndAlertStock(type);

      return res.status(200).json({ vouchers: vouchers.rows });

    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }

  } catch (error) {
    console.error('[verify-payment] Error:', error.message);
    return res.status(500).json({
      error: 'Verification failed. If you were charged, contact support with ref: ' + reference
    });
  }
}
