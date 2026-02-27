import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";
import db from '../../../lib/db';

export default async function handler(req, res) {
  // 1. Security Check: Verify Admin Session
  const session = await getServerSession(req, res, authOptions);

  if (!session) {
    return res.status(401).json({ error: "Access Denied" });
  }

  // 2. Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { csvData, type } = req.body;

  // 3. Basic Validation
  if (!csvData || !type) {
    return res.status(400).json({ error: 'Missing required data: csvData or type' });
  }

  try {
    // Split the data by new lines (handles both single manual entry and bulk CSV)
    const lines = csvData.trim().split(/\r?\n/);
    const results = {
      success: 0,
      failed: 0,
    };

    // 4. Process each line and insert into DB
    for (const line of lines) {
      // Clean up whitespace and split by comma
      const parts = line.split(',').map(item => item.trim());
      
      // Check if we have both Serial and Pin
      if (parts.length >= 2) {
        const [serial, pin] = parts;

        try {
          // Using 'ON CONFLICT' to prevent duplicate serial numbers
          await db.query(
            `INSERT INTO vouchers (type, serial, pin, status, created_at) 
             VALUES ($1, $2, $3, $4, NOW()) 
             ON CONFLICT (serial) DO NOTHING`, 
            [type, serial, pin, 'available']
          );
          results.success++;
        } catch (dbError) {
          console.error(`Error inserting line: ${line}`, dbError);
          results.failed++;
        }
      } else {
        results.failed++;
      }
    }

    // 5. Return summary to the dashboard
    return res.status(200).json({
      message: 'Processing complete',
      summary: results
    });

  } catch (error) {
    console.error('Upload API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error during upload' });
  }
}
