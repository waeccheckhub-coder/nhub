import db from '../../lib/db';
import axios from 'axios';
import { getPrices, ensurePreordersTable } from '../../lib/settings';

/**
 * USSD Service Handler
 * Configure your USSD provider (e.g. GiantSMS, AfricasTalking) to POST here.
 * 
 * Expected payload: { msisdn, msgType, text, sessionId }
 * msgType "1" or "0" = new session, "2" = continuation
 *
 * This uses the same DB as the web frontend — same stock, same vouchers.
 */

const SESSIONS = {}; // In-memory session store (use Redis in production)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { msisdn, msgType, text, sessionId, session_id, ussdServiceOp } = req.body;
  const phone = msisdn?.toString();
  const sid = sessionId || session_id || phone;
  const isNew = msgType === '1' || msgType === '0' || text === '' || ussdServiceOp === 'USSD_REQUEST';
  const input = (text || '').trim().split('*').pop(); // Get last menu selection

  if (isNew) SESSIONS[sid] = { step: 'main' };
  const session = SESSIONS[sid] || { step: 'main' };
  const prices = await getPrices();

  let response = '';
  let action = 'con';

  try {
    if (session.step === 'main' || isNew) {
      response = `Welcome to WAEC GH Checkers\n1. Buy WASSCE (GHS ${prices.WASSCE})\n2. Buy BECE (GHS ${prices.BECE})\n3. Buy CSSPS/Placement (GHS ${prices.CSSPS})\n4. Retrieve Vouchers`;
      SESSIONS[sid] = { step: 'menu' };

    } else if (session.step === 'menu') {
      if (input === '1') {
        const stock = await getStock('WASSCE');
        SESSIONS[sid] = { step: 'qty', type: 'WASSCE', price: prices.WASSCE };
        response = `WASSCE Checker (GHS ${prices.WASSCE} each)\n${stock > 0 ? `In Stock: ${stock}` : 'Pre-order available'}\nEnter Quantity (1-10):`;
      } else if (input === '2') {
        const stock = await getStock('BECE');
        SESSIONS[sid] = { step: 'qty', type: 'BECE', price: prices.BECE };
        response = `BECE Checker (GHS ${prices.BECE} each)\n${stock > 0 ? `In Stock: ${stock}` : 'Pre-order available'}\nEnter Quantity (1-10):`;
      } else if (input === '3') {
        const stock = await getStock('CSSPS');
        SESSIONS[sid] = { step: 'qty', type: 'CSSPS', price: prices.CSSPS };
        response = `School Placement (GHS ${prices.CSSPS} each)\n${stock > 0 ? `In Stock: ${stock}` : 'Pre-order available'}\nEnter Quantity (1-10):`;
      } else if (input === '4') {
        SESSIONS[sid] = { step: 'retrieve' };
        response = 'Retrieve Vouchers\nYour vouchers will be sent via SMS to this number.\n\n1. Send my vouchers';
      } else {
        response = 'Invalid option. Please try again.\n1. WASSCE\n2. BECE\n3. CSSPS\n4. Retrieve';
      }

    } else if (session.step === 'qty') {
      const qty = parseInt(input);
      if (isNaN(qty) || qty < 1 || qty > 10) {
        response = 'Please enter a valid quantity between 1 and 10:';
      } else {
        const total = session.price * qty;
        SESSIONS[sid] = { ...session, step: 'confirm', qty };
        response = `Confirm Purchase:\n${qty}x ${session.type}\nTotal: GHS ${total}\n\n1. Confirm & Pay\n2. Cancel`;
      }

    } else if (session.step === 'confirm') {
      if (input === '1') {
        const total = session.price * session.qty;
        // Trigger MoMo payment prompt
        // This would integrate with your mobile money push API
        // For now, log and inform user
        const reference = `USSD-${session.type}-${Date.now()}`;
        
        // You'll integrate a mobile money push (e.g. MTN API, Hubtel) here
        // The customer would receive a USSD push to approve payment
        // After approval, verify and deliver vouchers

        action = 'end';
        response = `Processing GHS ${total} payment...\n\nAuthorize the Mobile Money prompt on your phone.\n\nRef: ${reference}\n\nVouchers will be sent via SMS after payment.`;

        // In production, initiate the payment push here and handle callback
        SESSIONS[sid] = {};
      } else {
        action = 'end';
        response = 'Purchase cancelled. Goodbye!';
        SESSIONS[sid] = {};
      }

    } else if (session.step === 'retrieve') {
      if (input === '1') {
        const vouchers = await db.query(
          "SELECT type, serial, pin FROM vouchers WHERE sold_to = $1 ORDER BY sold_at DESC LIMIT 5",
          [phone]
        );
        if (vouchers.rowCount === 0) {
          response = 'No vouchers found for this number.';
        } else {
          // Send via SMS
          const details = vouchers.rows.map(v => `${v.type}: S/N ${v.serial} PIN ${v.pin}`).join('\n');
          try {
            const formatted = phone.startsWith('0') ? '233' + phone.slice(1) : phone;
            await axios.get(`https://sms.arkesel.com/sms/api`, {
              params: {
                action: 'send-sms', api_key: process.env.ARKESEL_API_KEY,
                to: formatted, from: 'CheckerCard',
                sms: `Your WAEC GH vouchers:\n\n${details}\n\nContact support if you need help.`,
              }
            });
          } catch (_) {}
          response = `Found ${vouchers.rowCount} voucher(s).\nDetails sent via SMS to ${phone}.`;
        }
        action = 'end';
        SESSIONS[sid] = {};
      } else {
        action = 'end';
        response = 'Goodbye!';
        SESSIONS[sid] = {};
      }

    } else {
      response = 'Session expired. Please dial again.';
      action = 'end';
      SESSIONS[sid] = {};
    }

  } catch (err) {
    console.error('USSD error:', err.message);
    response = 'Service unavailable. Please try again later.';
    action = 'end';
  }

  // Format for different USSD providers
  // GiantSMS format
  return res.status(200).json({ message: response, action });

  // For AfricasTalking, uncomment below:
  // return res.status(200).send(`${action === 'con' ? 'CON' : 'END'} ${response}`);
}

async function getStock(type) {
  const res = await db.query("SELECT COUNT(*) as count FROM vouchers WHERE type = $1 AND status = 'available'", [type]);
  return parseInt(res.rows[0].count);
}
