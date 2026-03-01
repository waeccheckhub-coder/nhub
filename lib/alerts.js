import pool from './db';
import { getSetting } from './settings';
import { sendSMS } from './sms';

// Send a plain alert SMS to the admin number stored in settings
export async function sendAdminAlert(message) {
  const adminPhone = await getSetting('admin_phone');
  if (!adminPhone) {
    console.warn('[alerts] admin_phone not set in settings — skipping admin alert');
    return;
  }
  return sendSMS(adminPhone, message);
}

// Check stock level for a voucher type and alert admin if low or zero
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
    return sendSMS(adminPhone, `WAEC Checkers: ${voucherType} vouchers are OUT OF STOCK. Upload more immediately!`);
  } else if (count <= threshold) {
    return sendSMS(adminPhone, `WAEC Checkers: ${voucherType} stock is low — only ${count} remaining.`);
  }
}
