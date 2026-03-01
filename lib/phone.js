/**
 * Normalize a Ghana phone number to 233XXXXXXXXX format for SMS.
 * Handles: 0244123456, 233244123456, +233244123456
 */
export function formatPhone(phone) {
  let p = (phone || '').toString().trim().replace(/\s+/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('233')) return p;
  if (p.startsWith('0')) return '233' + p.slice(1);
  // Bare 9-digit number
  if (p.length === 9) return '233' + p;
  return p;
}
