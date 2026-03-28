// TEMPORARY - DELETE AFTER USE
// Deploy to pages/api/update-moolre.js
// Visit https://yoursite.vercel.app/api/update-moolre once, then delete this file.

export default async function handler(req, res) {
  const callbackUrl = `${process.env.NEXT_PUBLIC_BASE_URL}api/moolre-webhook`;

  // Show which env vars are present (masked) to help debug auth errors
  const envDebug = {
    MOOLRE_USERNAME:                   process.env.MOOLRE_USERNAME ? `set (${process.env.MOOLRE_USERNAME})` : 'MISSING',
    MOOLRE_SECRET_KEY:                 process.env.MOOLRE_SECRET_KEY ? `set (${process.env.MOOLRE_SECRET_KEY.slice(0,6)}...)` : 'MISSING',
    MOOLRE_API_KEY:                    process.env.MOOLRE_API_KEY ? `set (${process.env.MOOLRE_API_KEY.slice(0,6)}...)` : 'MISSING',
    NEXT_PUBLIC_MOOLRE_PUBLIC_KEY:     process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY ? `set (${process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY.slice(0,6)}...)` : 'MISSING',
    NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER || 'MISSING',
  };

  // Try with MOOLRE_SECRET_KEY first, fall back to MOOLRE_API_KEY
  const apiKey = process.env.MOOLRE_API_KEY;

  const response = await fetch('https://api.moolre.com/open/account/update', {
    method: 'POST',
    headers: {
      'X-API-USER':   process.env.MOOLRE_USERNAME,
      'X-API-KEY':    apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type:          1,
      api:           true,
      callback:      callbackUrl,
      accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
    }),
  });

  const data = await response.json();
  console.log('[update-moolre] Response:', JSON.stringify(data));
  return res.status(200).json({ callbackUrl, envDebug, moolreResponse: data });
}
