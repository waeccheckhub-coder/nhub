import db from './db';

// Ensure settings table exists
export async function ensureSettingsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Ensure preorders table exists
export async function ensurePreordersTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS preorders (
      id SERIAL PRIMARY KEY,
      reference VARCHAR(100) UNIQUE NOT NULL,
      phone VARCHAR(20) NOT NULL,
      name VARCHAR(100),
      amount NUMERIC(10,2) NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      voucher_type VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      fulfilled_at TIMESTAMP
    )
  `);
}

export async function getSetting(key, defaultValue = null) {
  try {
    await ensureSettingsTable();
    const result = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (result.rows.length === 0) return defaultValue;
    return result.rows[0].value;
  } catch (err) {
    console.error('getSetting error:', err.message);
    return defaultValue;
  }
}

export async function setSetting(key, value) {
  await ensureSettingsTable();
  await db.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

export async function getAllSettings() {
  await ensureSettingsTable();
  const result = await db.query('SELECT key, value FROM settings');
  const settings = {};
  result.rows.forEach(row => { settings[row.key] = row.value; });
  return settings;
}

// Default prices
export const DEFAULT_PRICES = {
  WASSCE: 30,
  BECE: 30,
  CSSPS: 30,
};

export async function getPrices() {
  const settings = await getAllSettings();
  return {
    WASSCE: parseFloat(settings['price_WASSCE'] || DEFAULT_PRICES.WASSCE),
    BECE: parseFloat(settings['price_BECE'] || DEFAULT_PRICES.BECE),
    CSSPS: parseFloat(settings['price_CSSPS'] || DEFAULT_PRICES.CSSPS),
  };
}
