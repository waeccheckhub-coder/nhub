import db from '../../lib/db';
import axios from 'axios';
import { getSetting } from '../../lib/settings';
import { checkAndAlertStock } from '../../lib/whatsapp';
import { formatPhone } from '../../lib/phone';

const MOOLRE_API_BASE = process.env.MOOLRE_API_BASE || 'https://api.moolre.com/v2';

function getPortalLink(type) {
  const t = (type || '').toUpperCase();
  if (t.includes('WASSCE') || t.includes('NOVDEC')) return 'https://ghana.waecdirect.org';
  if (t.includes('BECE')) return 'https://eresults.waecgh.org';
  if (t.includes('CSSPS') || t.includes('PLACEMENT')) return 'https://www.cssps.gov.gh';
  return 'https://waeccardsonline.com';
}

async function sendSMS(to, message) {
  try {
    await axios.get('https://sms.arkesel.com/sms/api', {
      params: { action: 'send-sms', api_key: process.env.ARKESEL_API_KEY, to, from: 'CheckerCard', sms: message },
    });
  } catch (e) {
    console.error('SMS error:', e?.response?.data || e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { reference, quantity, type, phone, name } = req.body;

  if (!reference) return res.status(400).json({ error: 'Missing reference' });

  try {
    // IDEMPOTENCY CHECK — if already processed successfully, return the assigned vouchers
    // This handles page refreshes and double-calls safely.
    const existingTx = await db.query(
      `SELECT status FROM transactions WHERE reference = $1`,
      [reference]
    );
    if (existingTx.rowCount > 0 && existingTx.rows[0].status === 'success') {
      // Payment already fulfilled — return the vouchers that were assigned
      const assignedVouchers = await db.query(
        `SELECT type, serial, pin FROM vouchers WHERE sold_to = $1 AND transaction_ref = $2`,
        [phone, reference]
      );
      if (assignedVouchers.rowCount > 0) {
        return res.status(200).json({ vouchers: assignedVouchers.rows });
      }
      // transaction_ref column may not be set — try by sold_to + sold_at proximity
      const assignedByPhone = await db.query(
        `SELECT type, serial, pin FROM vouchers 
         WHERE sold_to = $1 AND type = $2 AND status = 'sold'
         ORDER BY sold_at DESC LIMIT $3`,
        [phone, type, parseInt(quantity) || 1]
      );
      if (assignedByPhone.rowCount > 0) {
        return res.status(200).json({ vouchers: assignedByPhone.rows });
      }
    }

    // Verify payment with Moolre
    const moolreRes = await axios.get(
      `${MOOLRE_API_BASE}/transactions/${reference}`,
      { headers: { Authorization: `Bearer ${process.env.MOOLRE_SECRET_KEY}` } }
    );

    const txData = moolreRes.data?.data || moolreRes.data;
    const paymentStatus = (txData?.status || '').toLowerCase();
    const isSuccess = ['success', 'successful', 'completed', 'paid'].includes(paymentStatus);

    if (!isSuccess) {
      return res.status(400).json({ error: `Payment not confirmed (status: ${paymentStatus})` });
    }

    const verifiedAmount = txData.amount || txData.total || 0;
    const qty = parseInt(quantity) || 1;
    const resolvedPhone = phone || txData.customerPhone || txData.phone || '';

    // Check stock with a DB-level lock to prevent race conditions
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Lock the rows we want to assign — SKIP LOCKED means concurrent requests
      // will skip already-locked rows instead of waiting or double-assigning.
      const vouchers = await client.query(
        `SELECT id, serial, pin, type FROM vouchers 
         WHERE type = $1 AND status = 'available'
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [type, qty]
      );

      if (vouchers.rowCount < qty) {
        await client.query('ROLLBACK');
        client.release();

        // Not enough stock — save as preorder
        await db.query(
          `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
           ON CONFLICT (reference) DO UPDATE SET status = 'pending'`,
          [reference, resolvedPhone, name || '', verifiedAmount, qty, type]
        );
        await db.query(
          `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
           VALUES ($1, $2, $3, $4, $5, 'preorder', NOW())
           ON CONFLICT (reference) DO UPDATE SET status = 'preorder'`,
          [reference, resolvedPhone, verifiedAmount, qty, type]
        );

        // SMS customer
        await sendSMS(
          formatPhone(resolvedPhone),
          `Thank you for your ${type} purchase (Ref: ${reference}). Vouchers are temporarily out of stock. We will SMS them to you as soon as they are available!`
        );

        // Alert admin
        const adminPhone = await getSetting('admin_whatsapp');
        if (adminPhone) {
          const { sendWhatsAppAlert } = await import('../../lib/whatsapp');
          await sendWhatsAppAlert(adminPhone,
            `📋 *NEW PRE-ORDER*\nCustomer: ${resolvedPhone}\nType: ${type}\nQty: ${qty}\nAmount: GHS ${verifiedAmount}\nRef: ${reference}\n\n⚠️ Upload vouchers ASAP!`
          );
        }

        return res.status(200).json({ success: true, preorder: true, vouchers: [] });
      }

      // Assign vouchers atomically
      const voucherIds = vouchers.rows.map(v => v.id);
      await client.query(
        `UPDATE vouchers SET status = 'sold', sold_to = $1, sold_at = NOW(), transaction_ref = $2 
         WHERE id = ANY($3)`,
        [resolvedPhone, reference, voucherIds]
      );

      // Record transaction
      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'success', NOW())
         ON CONFLICT (reference) DO UPDATE SET status = 'success'`,
        [reference, resolvedPhone, verifiedAmount, qty, type]
      );

      // Mark preorder as fulfilled (if it existed from init-payment)
      await client.query(
        `UPDATE preorders SET status = 'fulfilled', fulfilled_at = NOW() 
         WHERE reference = $1 AND status IN ('initiated', 'pending')`,
        [reference]
      );

      await client.query('COMMIT');
      client.release();

      // Send SMS with vouchers
      const voucherDetails = vouchers.rows.map(v => `S/N: ${v.serial} PIN: ${v.pin}`).join('\n');
      await sendSMS(
        formatPhone(resolvedPhone),
        `CheckerCard: Your ${type} purchase was successful.\n\n${voucherDetails}\n\nCheck results: ${getPortalLink(type)}\n\nThank you!`
      );

      // Stock alerts
      const adminPhone = await getSetting('admin_whatsapp');
      if (adminPhone) await checkAndAlertStock(db, adminPhone);

      return res.status(200).json({ vouchers: vouchers.rows });

    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }

  } catch (error) {
    console.error('Verify payment error:', error?.response?.data || error.message);
    return res.status(500).json({ error: 'Internal server error. If you were charged, contact support with ref: ' + reference });
  }
}
