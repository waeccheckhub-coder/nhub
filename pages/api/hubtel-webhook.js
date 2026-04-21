// POST /api/hubtel-webhook
// Receives payment confirmations from both Hubtel checkout and direct debit.
//
// Checkout callback: { ResponseCode, Status, Data: { ClientReference, Status, Amount, CustomerPhoneNumber, ... } }
// Direct debit callback: { ResponseCode, Message, Data: { ClientReference, Amount, TransactionId, ... } }

import pool from '../../lib/db';
import { sendVoucherSMS, sendPreorderSMS } from '../../lib/sms';
import { sendAdminAlert, checkAndAlertStock } from '../../lib/alerts';

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).end();

  const payload = req.body;
  console.log('[Hubtel Webhook] Received:', JSON.stringify(payload));

  try {
    const responseCode = payload?.ResponseCode || payload?.responseCode || '';
    const txData       = payload?.Data         || payload?.data         || {};

    // ClientReference and status from Data object
    const reference = txData?.ClientReference || txData?.clientReference || '';
    const payer     = txData?.CustomerPhoneNumber || txData?.CustomerMsisdn || txData?.customerPhoneNumber || '';
    const amount    = txData?.Amount          || txData?.amount          || 0;

    // Checkout uses Data.Status, direct debit uses ResponseCode
    const dataStatus = (txData?.Status || txData?.status || '').toLowerCase();
    const isSuccess  = responseCode === '0000' &&
      (dataStatus === 'success' || dataStatus === 'paid' || dataStatus === '');

    if (!isSuccess) {
      console.log('[Hubtel Webhook] Non-success — ResponseCode:', responseCode, 'Status:', dataStatus);
      return res.status(200).json({ received: true });
    }

    if (!reference) {
      console.warn('[Hubtel Webhook] No ClientReference in payload');
      return res.status(200).json({ received: true });
    }

    // Idempotency
    const existing = await pool.query(
      `SELECT id FROM transactions WHERE reference=$1 AND status='success'`, [reference]
    );
    if (existing.rowCount > 0) {
      console.log('[Hubtel Webhook] Already processed:', reference);
      return res.status(200).json({ received: true });
    }

    // Load order — check preorders then transactions
    let phone, qty, voucherType, orderAmount;

    const preorderRow = await pool.query(
      `SELECT phone, quantity, voucher_type, amount FROM preorders WHERE reference=$1 OR reference=SUBSTRING($1, 1, 32)`,
      [reference]
    );
    if (preorderRow.rowCount > 0) {
      ({ phone, quantity: qty, voucher_type: voucherType, amount: orderAmount } = preorderRow.rows[0]);
      console.log('[Hubtel Webhook] Order from preorders:', { phone, qty, voucherType });
    } else {
      const txRow = await pool.query(
        `SELECT phone, quantity, voucher_type, amount FROM transactions WHERE reference=$1 OR reference=SUBSTRING($1, 1, 32)`,
        [reference]
      );
      if (txRow.rowCount > 0) {
        ({ phone, quantity: qty, voucher_type: voucherType, amount: orderAmount } = txRow.rows[0]);
        console.log('[Hubtel Webhook] Order from transactions:', { phone, qty, voucherType });
      } else {
        phone = payer; qty = 1; voucherType = null; orderAmount = amount;
      }
    }

    if (!voucherType) {
      console.error('[Hubtel Webhook] voucherType not found for ref:', reference);
      await sendAdminAlert(
        `HUBTEL WEBHOOK: Payment GHS ${amount} received but order not found! Ref: ${reference}. Phone: ${payer}. Fulfill manually.`
      );
      return res.status(200).json({ received: true });
    }

    qty = parseInt(qty);

    const client = await pool.connect();
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
        await sendAdminAlert(`⚠️ OUT OF STOCK (Hubtel): ${voucherType} x${qty} from ${phone}. Ref: ${reference}`);
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
      await sendAdminAlert(`✅ Hubtel Sale: ${qty}x ${voucherType} GHS ${orderAmount} to ${phone}. Ref: ${reference}`);
      await checkAndAlertStock(voucherType);

      return res.status(200).json({ received: true, fulfilled: true });

    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }

  } catch (err) {
    console.error('[Hubtel Webhook] Error:', err.message);
    return res.status(200).json({ received: true });
  }
}
