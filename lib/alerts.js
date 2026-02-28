// lib/alerts.js
// Sends admin alert SMS via Arkesel (same API used for voucher delivery).
// Replaces the old UltraMsg/WhatsApp lib.

import pool from './db';
import { getSetting } from './settings';

async function sendSMS(phone, message) {
  const apiKey = process.env.ARKESEL_API_KEY;
  if (!apiKey || !phone) return;

  await fetch('https://sms.arkesel.com/api/v2/sms/send', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: 'WAEC-GH',
      message,
      recipients: [phone],
    }),
  });
}

// Send a plain alert SMS to the admin number stored in settings
export async function sendAdminAlert(message) {
  const adminPhone = await getSetting('admin_phone');
  if (!adminPhone) return;
  await sendSMS(adminPhone, message);
}

// Check stock level for a voucher type and alert if low or zero
export async function checkAndAlertStock(voucherType) {
  const threshold = parseInt(await getSetting('low_stock_threshold') || '5');
  const adminPhone = await getSetting('admin_phone');
  if (!adminPhone) return;

  const result = await pool.query(
    "SELECT COUNT(*) FROM vouchers WHERE type = $1 AND status = 'available'",
    [voucherType]
  );
  const count = parseInt(result.rows[0].count);

  if (count === 0) {
    await sendSMS(
      adminPhone,
      `WAEC Checkers ALERT: ${voucherType} vouchers are OUT OF STOCK. Please upload more immediately.`
    );
  } else if (count <= threshold) {
    await sendSMS(
      adminPhone,
      `WAEC Checkers ALERT: ${voucherType} stock is low — only ${count} remaining.`
    );
  }
}
