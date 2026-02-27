import axios from 'axios';

/**
 * Send a WhatsApp message using UltraMsg API
 * Set in .env:
 *   ULTRAMSG_TOKEN=your_token
 *   ULTRAMSG_INSTANCE_ID=your_instance_id
 *
 * Alternatively, use Twilio or CallMeBot by swapping the sender below.
 */
export async function sendWhatsAppAlert(toPhone, message) {
  const token = process.env.ULTRAMSG_TOKEN;
  const instanceId = process.env.ULTRAMSG_INSTANCE_ID;

  if (!token || !instanceId) {
    console.warn('[WhatsApp] ULTRAMSG_TOKEN or ULTRAMSG_INSTANCE_ID not set. Skipping alert.');
    return;
  }

  // Format phone to international format (Ghana: 233XXXXXXXXX)
  let formattedPhone = toPhone.toString().trim();
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '233' + formattedPhone.slice(1);
  }
  // WhatsApp needs the number with country code
  if (!formattedPhone.startsWith('+')) {
    formattedPhone = '+' + formattedPhone;
  }

  try {
    await axios.post(
      `https://api.ultramsg.com/${instanceId}/messages/chat`,
      new URLSearchParams({
        token,
        to: formattedPhone,
        body: message,
        priority: '10',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    console.log(`[WhatsApp] Alert sent to ${formattedPhone}`);
  } catch (err) {
    console.error('[WhatsApp] Failed to send alert:', err?.response?.data || err.message);
  }
}

/**
 * Check stock and send alerts if needed
 * Call this after any sale or stock change.
 */
export async function checkAndAlertStock(db, adminPhone) {
  if (!adminPhone) return;

  try {
    const result = await db.query(`
      SELECT type, COUNT(*) as count
      FROM vouchers
      WHERE status = 'available'
      GROUP BY type
    `);

    const stockMap = {};
    result.rows.forEach(row => {
      stockMap[row.type] = parseInt(row.count);
    });

    for (const [type, count] of Object.entries(stockMap)) {
      if (count === 0) {
        await sendWhatsAppAlert(
          adminPhone,
          `🚨 *STOCK ALERT — OUT OF STOCK*\n\n*${type}* vouchers have completely run out!\n\nPlease upload new vouchers immediately to avoid missed sales.\n\n— WAEC GH Checkers System`
        );
      } else if (count <= 5) {
        await sendWhatsAppAlert(
          adminPhone,
          `⚠️ *STOCK WARNING — LOW STOCK*\n\n*${type}* vouchers are running low!\nOnly *${count}* remaining.\n\nPlease upload more vouchers soon.\n\n— WAEC GH Checkers System`
        );
      }
    }
  } catch (err) {
    console.error('[WhatsApp] Stock check failed:', err.message);
  }
}
