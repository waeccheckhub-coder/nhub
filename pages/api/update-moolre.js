// TEMPORARY - DELETE AFTER USE
// Deploy to pages/api/update-moolre.js
// Visit https://yoursite.vercel.app/api/update-moolre once, then delete this file.

export default async function handler(req, res) {
  const callbackUrl = `${process.env.NEXT_PUBLIC_BASE_URL}api/moolre-webhook`;

  const response = await fetch('https://api.moolre.com/open/account/update', {
    method: 'POST',
    headers: {
      'X-API-USER':   process.env.MOOLRE_USERNAME,
      'X-API-KEY':    process.env.MOOLRE_SECRET_KEY,
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
  return res.status(200).json({ callbackUrl, moolreResponse: data });
}
