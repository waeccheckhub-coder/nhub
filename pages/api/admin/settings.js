import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import { getAllSettings, setSetting } from '../../../lib/settings';

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Access Denied" });

  if (req.method === 'GET') {
    const settings = await getAllSettings();
    return res.status(200).json({ settings });
  }

  if (req.method === 'POST') {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Missing key' });
    await setSetting(key, value);
    return res.status(200).json({ success: true, key, value });
  }

  // Bulk update
  if (req.method === 'PUT') {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Invalid settings object' });
    }
    for (const [key, value] of Object.entries(settings)) {
      await setSetting(key, value);
    }
    return res.status(200).json({ success: true });
  }

  return res.status(405).end();
}
