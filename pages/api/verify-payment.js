import db from '../../lib/db';
import axios from 'axios';
import { getSetting, ensurePreordersTable } from '../../lib/settings';
import { checkAndAlertStock } from '../../lib/whatsapp';

const MOOLRE_API_BASE = process.env.MOOLRE_API_BASE || 'https://api.moolre.com/v2';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { reference, quantity, type, phone, name, isPreorder } = req.body;

  try {
    // 1. Verify Payment with Moolre
    // NOTE: Confirm exact endpoint at https://docs.moolre.com
    const moolreRes = await axios.get(
      `${MOOLRE_API_BASE}/transactions/${reference}`,
      { headers: { Authorization: `Bearer ${process.env.MOOLRE_SECRET_KEY}` } }
    );

    const txData = moolreRes.data?.data || moolreRes.data;
    const isSuccess = ['success', 'successful', 'completed', 'paid'].includes(
      (txData?.status || '').toLowerCase()
    );

    if (!isSuccess) {
      return res.status(400).json({ error: 'Payment not verified' });
    }

    const verifiedAmount = txData.amount;
    const qty = parseInt(quantity);

    // 2. Check stock
    const stockRes = await db.query(
      "SELECT COUNT(*) as count FROM vouchers WHERE type = $1 AND status = 'available'",
      [type]
    );
    const stockCount = parseInt(stockRes.rows[0].count);

    // 3. Pre-order mode: if stock insufficient, queue as preorder
    if (isPreorder || stockCount < qty) {
      await ensurePreordersTable();
      await db.query(
        `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW()) ON CONFLICT (reference) DO NOTHING`,
        [reference, phone, name || '', verifiedAmount, qty, type]
      );
      try {
        await db.query(
          `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
           VALUES ($1, $2, $3, $4, $5, 'preorder', NOW()) ON CONFLICT (reference) DO NOTHING`,
          [reference, phone, verifiedAmount, qty, type]
        );
      } catch (_) {}

      // SMS customer
      const formattedPhone = phone.startsWith('0') ? '233' + phone.slice(1) : phone;
      try {
        await axios.get(`https://sms.arkesel.com/sms/api`, {
          params: {
            action: 'send-sms', api_key: process.env.ARKESEL_API_KEY, to: formattedPhone, from: 'CheckerCard',
            sms: `Thank you for your ${type} purchase (Ref: ${reference}). Vouchers are temporarily out of stock. We'll SMS them as soon as they're available!`,
          }
        });
      } catch (_) {}

      // Alert admin
      const adminPhone = await getSetting('admin_whatsapp');
      if (adminPhone) {
        const { sendWhatsAppAlert } = await import('../../lib/whatsapp');
        await sendWhatsAppAlert(adminPhone,
          `📋 *NEW PRE-ORDER*\nCustomer: ${phone}\nType: ${type}\nQty: ${qty}\nAmount: GHS ${verifiedAmount}\nRef: ${reference}\n\n⚠️ Stock insufficient. Please upload vouchers ASAP!`
        );
      }

      return res.status(200).json({ success: true, preorder: true, message: 'Payment confirmed. Vouchers will be sent when stock is available.', vouchers: [] });
    }

    // 4. Fetch available vouchers
    const vouchers = await db.query(
      'SELECT id, serial, pin FROM vouchers WHERE type = $1 AND status = $2 LIMIT $3',
      [type, 'available', qty]
    );
    if (vouchers.rowCount < qty) return res.status(400).json({ error: 'OUT_OF_STOCK' });

    // 5. Mark as sold
    const voucherIds = vouchers.rows.map(v => v.id);
    await db.query('UPDATE vouchers SET status = $1, sold_to = $2, sold_at = NOW() WHERE id = ANY($3)', ['sold', phone, voucherIds]);

    // 6. Record transaction
    try {
      await db.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'success', NOW()) ON CONFLICT (reference) DO NOTHING`,
        [reference, phone, verifiedAmount, qty, type]
      );
    } catch (_) {}

    // 7. Portal links
    const getPortalLink = (t) => {
      const u = (t || '').toUpperCase();
      if (u.includes('WASSCE') || u.includes('NOVDEC')) return 'https://ghana.waecdirect.org';
      if (u.includes('BECE')) return 'https://eresults.waecgh.org';
      if (u.includes('CSSPS') || u.includes('PLACEMENT')) return 'https://www.cssps.gov.gh';
      return 'https://waeccardsonline.com';
    };

    // 8. SMS
    const voucherDetails = vouchers.rows.map(v => `S/N: ${v.serial} PIN: ${v.pin}`).join('\n');
    const formattedPhone2 = phone.startsWith('0') ? '233' + phone.slice(1) : phone;
    try {
      await axios.get(`https://sms.arkesel.com/sms/api`, {
        params: {
          action: 'send-sms', api_key: process.env.ARKESEL_API_KEY, to: formattedPhone2, from: 'CheckerCard',
          sms: `CheckerCard: Your ${type} purchase was successful.\n\n${voucherDetails}\n\nCheck Result: ${getPortalLink(type)}\n\nThank you!`,
        }
      });
    } catch (e) { console.error('SMS error:', e.message); }

    // 9. Stock alerts
    const adminPhone = await getSetting('admin_whatsapp');
    if (adminPhone) await checkAndAlertStock(db, adminPhone);

    return res.status(200).json({ vouchers: vouchers.rows });

  } catch (error) {
    console.error('Verify error:', error?.response?.data || error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
