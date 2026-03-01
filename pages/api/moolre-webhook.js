import db from '../../lib/db';
import { sendVoucherSMS, sendPreorderSMS } from '../../lib/sms';
import { sendAdminAlert, checkAndAlertStock } from '../../lib/alerts';

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).end();

  const payload = req.body;
  console.log('[Webhook] Received payload:', JSON.stringify(payload));

  try {
    const txData = payload?.data;
    if (!txData) {
      console.warn('[Webhook] Empty data field');
      return res.status(200).json({ received: true });
    }

    const { txstatus, externalref: reference, payer, amount, secret } = txData;

    if (process.env.MOOLRE_WEBHOOK_SECRET && secret !== process.env.MOOLRE_WEBHOOK_SECRET) {
      console.warn('[Webhook] Secret mismatch — ignoring');
      return res.status(200).json({ received: true });
    }

    if (txstatus !== 1) {
      return res.status(200).json({ received: true, note: 'Non-success txstatus' });
    }

    if (!reference) {
      console.warn('[Webhook] No externalref in payload');
      return res.status(200).json({ received: true });
    }

    // ── IDEMPOTENCY ────────────────────────────────────────────────────────
    const existing = await db.query(
      `SELECT id FROM transactions WHERE reference=$1 AND status='success'`, [reference]
    );
    if (existing.rowCount > 0) {
      return res.status(200).json({ received: true, note: 'Already processed' });
    }

    // ── LOAD ORDER ─────────────────────────────────────────────────────────
    const preorderRow = await db.query(
      `SELECT phone, quantity, voucher_type, amount FROM preorders WHERE reference=$1`, [reference]
    );

    let phone, qty, voucherType, orderAmount;
    if (preorderRow.rowCount > 0) {
      ({ phone, quantity: qty, voucher_type: voucherType, amount: orderAmount } = preorderRow.rows[0]);
    } else {
      phone = payer || '';
      qty = 1;
      voucherType = null;
      orderAmount = amount || 0;
    }

    if (!voucherType) {
      console.error('[Webhook] Cannot determine voucherType for ref', reference);
      await sendAdminAlert(
        `WEBHOOK: Payment received (GHS ${amount}) but order not found! Ref: ${reference}. Phone: ${payer}. Fulfill manually.`
      );
      return res.status(200).json({ received: true, note: 'Order not found — admin alerted' });
    }

    qty = parseInt(qty);

    // ── ASSIGN VOUCHERS ────────────────────────────────────────────────────
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const vouchers = await client.query(
        `SELECT id, serial, pin FROM vouchers
         WHERE type=$1 AND status='available'
         LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [voucherType, qty]
      );

      if (vouchers.rowCount < qty) {
        await client.query(
          `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
           VALUES ($1,$2,'',$3,$4,$5,'pending',NOW())
           ON CONFLICT (reference) DO UPDATE SET status='pending'`,
          [reference, phone, parseFloat(orderAmount), qty, voucherType]
        );
        await client.query(
          `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
           VALUES ($1,$2,$3,$4,$5,'preorder',NOW())
           ON CONFLICT (reference) DO UPDATE SET status='preorder'`,
          [reference, phone, parseFloat(orderAmount), qty, voucherType]
        );
        await client.query('COMMIT');
        client.release();

        await sendPreorderSMS(phone, voucherType, reference);
        await sendAdminAlert(`OUT OF STOCK (webhook): ${voucherType} x${qty} from ${phone}. Ref: ${reference}. Upload vouchers!`);
        return res.status(200).json({ received: true, fulfilled: false });
      }

      const ids = vouchers.rows.map(v => v.id);
      await client.query(
        `UPDATE vouchers SET status='sold', sold_to=$1, sold_at=NOW(), transaction_ref=$2 WHERE id=ANY($3)`,
        [phone, reference, ids]
      );
      await client.query(
        `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
         VALUES ($1,$2,$3,$4,$5,'success',NOW())
         ON CONFLICT (reference) DO UPDATE SET status='success'`,
        [reference, phone, parseFloat(orderAmount), qty, voucherType]
      );
      await client.query(
        `UPDATE preorders SET status='fulfilled', fulfilled_at=NOW()
         WHERE reference=$1 AND status IN ('initiated','pending')`,
        [reference]
      );
      await client.query('COMMIT');
      client.release();

      await sendVoucherSMS(phone, vouchers.rows, voucherType);
      await checkAndAlertStock(voucherType);
      return res.status(200).json({ received: true, fulfilled: true });

    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    return res.status(200).json({ received: true, error: 'Processing failed' });
  }
}
