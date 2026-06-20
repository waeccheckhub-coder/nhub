// GET /api/ussd — Wigal Smart USSD callback handler with DB-backed sessions
//
// Smart USSD sends a GET with query parameters on every interaction.
// We respond with a pipe-delimited plain-text string.
//
// WIGAL SMART USSD INBOUND QUERY PARAMS:
//   network     — originating network e.g. "wigal_mtn_gh"
//   sessionid   — unique session identifier for this USSD dialogue
//   mode        — "start" (new session) | "MORE" (awaiting input) | "END" (close)
//   msisdn      — customer phone e.g. "233241235993"
//   userdata    — what the customer typed (empty string on first hit)
//   username    — WIGAL username (echo back as-is)
//   trafficid   — unique per-request ID (echo back as-is)
//   other       — optional reference data (echo back as-is)
//
// WIGAL SMART USSD OUTBOUND RESPONSE FORMAT (pipe-delimited string):
//   NETWORK|MODE|MSISDN|SESSIONID|USERDATA|USERNAME|TRAFFICID|OTHER
//   MODE must be MORE (keep open) or END (close session)
//   Use ^ as newline in USERDATA. Max 160 chars total in USERDATA.
//
// PAYMENT WEBHOOKS:
//   Hubtel sends confirmations to /api/hubtel-webhook (separate endpoint).
//   This endpoint is USSD-only — no payment webhook detection needed here.

import pool from '../../lib/db';
import { initHubtelDirectDebit } from '../../lib/hubtel';
import { getPrices, getSetting } from '../../lib/settings';
import { sendAdminAlert } from '../../lib/alerts';
import { sendVoucherSMS, sendPreorderSMS } from '../../lib/sms';

// Smart USSD sends GET requests, so disable Next.js body parsing
export const config = {
  api: { bodyParser: false },
};

// ── SV USSD Proxy ─────────────────────────────────────────────────────────────
// When a user dials *xxx*xxx*7#, Wigal sends mode=START with userdata="7".
// All traffic for those sessions is forwarded to the SV data-bundle service.
//
// Set SV_USSD_URL in your .env.local, e.g.:
//   SV_USSD_URL=https://sv.yourdomain.com/api/ussd
//
// SV uses Wigal V2 (POST JSON); nhub uses Wigal V1 (GET + pipe string).
// This function bridges the two protocols in both directions.

const SV_USSD_URL = process.env.SV_USSD_URL;

async function proxyToSv({ network, sessionid, mode, msisdn, userdata, username, trafficid, other }) {
  if (!SV_USSD_URL) {
    console.error('[USSD] SV_USSD_URL is not configured — cannot proxy *7 sessions');
    return null;
  }

  // Build the V2 JSON body that SV's POST handler expects.
  // SV accepts both "phonenumber" (V2) and "msisdn" (V1) — send both to be safe.
  const body = {
    network,
    sessionid,
    mode:        mode.toUpperCase(), // START | MORE | END
    phonenumber: msisdn,
    msisdn,
    userdata,
    username,
    trafficid,
    other: other ?? '',
  };

  console.log(`[USSD] Proxying to SV (${mode}):`, JSON.stringify(body));

  try {
    const res = await fetch(SV_USSD_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      console.error('[USSD] SV proxy returned HTTP', res.status);
      return null;
    }

    // SV responds with a JSON object: { network, sessionid, mode, msisdn, userdata, username, trafficid, other }
    const json = await res.json();
    console.log('[USSD] SV proxy response:', JSON.stringify(json));

    // Convert back to the V1 pipe string that Wigal expects from nhub.
    // SV uses \n as newline; Wigal V1 uses ^ as newline.  Pipe chars are illegal in userdata.
    const safeUserdata = String(json.userdata ?? '')
      .replace(/\n/g, '^')
      .replace(/\|/g, ' ');

    return [
      json.network   ?? network,
      json.mode      ?? 'END',
      json.msisdn    ?? msisdn,
      json.sessionid ?? sessionid,
      safeUserdata,
      json.username  ?? username,
      json.trafficid ?? trafficid,
      json.other     ?? other ?? '',
    ].join('|');

  } catch (err) {
    console.error('[USSD] SV proxy fetch error:', err.message);
    return null;
  }
}

// ── DB session helpers ────────────────────────────────────────────────────────

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ussd_sessions (
      session_id   VARCHAR(100) PRIMARY KEY,
      stage        VARCHAR(50)  NOT NULL DEFAULT 'MENU',
      voucher_type VARCHAR(50),
      quantity     INTEGER,
      updated_at   TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function getSession(sessionId) {
  try {
    await ensureTable();
    const r = await pool.query(
      'SELECT stage, voucher_type, quantity FROM ussd_sessions WHERE session_id = $1',
      [String(sessionId)]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      stage:       row.stage || 'MENU',
      voucherType: row.voucher_type || null,
      quantity:    row.quantity != null ? parseInt(row.quantity, 10) : null,
    };
  } catch (err) {
    console.error('[USSD] getSession error:', err.message);
    return { stage: 'MENU' };
  }
}

async function setSession(sessionId, data) {
  try {
    await ensureTable();
    await pool.query(
      `INSERT INTO ussd_sessions (session_id, stage, voucher_type, quantity, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (session_id) DO UPDATE
       SET stage=$2, voucher_type=$3, quantity=$4, updated_at=NOW()`,
      [
        String(sessionId),
        String(data.stage),
        data.voucherType != null ? String(data.voucherType) : null,
        data.quantity    != null ? parseInt(data.quantity, 10) : null,
      ]
    );
  } catch (err) {
    console.error('[USSD] setSession error:', err.message);
  }
}

async function clearSession(sessionId) {
  try {
    await pool.query('DELETE FROM ussd_sessions WHERE session_id = $1', [String(sessionId)]);
  } catch (err) {
    console.error('[USSD] clearSession error:', err.message);
  }
}

// ── Payment polling (background) ──────────────────────────────────────────────
// Hubtel fires a webhook to /api/hubtel-webhook on payment confirmation.
// This poll is a safety net in case the webhook is delayed or missed.
// Polls every 5 s for up to 60 s after the MoMo prompt is sent.

async function pollAndFulfill({ ref, phone, voucherType, quantity, total }) {
  const maxAttempts = 12; // 12 × 5 s = 60 s
  const delay = ms => new Promise(r => setTimeout(r, ms));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await delay(5000);
    try {
      const statusRes = await fetch('https://api.moolre.com/open/transact/status', {
        method: 'POST',
        headers: {
          'X-API-USER':   process.env.MOOLRE_USERNAME,
          'X-API-PUBKEY': process.env.NEXT_PUBLIC_MOOLRE_PUBLIC_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type:          1,
          idtype:        1,
          id:            ref,
          accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
        }),
      });
      const statusData = await statusRes.json();
      const txstatus = Number(statusData?.data?.txstatus);
      console.log(`[USSD] Poll attempt ${attempt} for ${ref}: txstatus=${txstatus}`);

      if (txstatus === 2) {
        // Payment failed — release pre-assigned vouchers back to available
        console.log('[USSD] Payment failed — releasing reserved vouchers for', ref);
        await pool.query(
          `UPDATE vouchers SET status='available', sold_to=NULL, transaction_ref=NULL, sold_at=NULL
           WHERE transaction_ref=$1 AND status='sold'`,
          [ref]
        );
        await pool.query(
          `UPDATE transactions SET status='failed' WHERE reference=$1`,
          [ref]
        );
        return;
      }

      if (txstatus !== 1) continue; // still pending

      // Payment confirmed — check idempotency first
      const already = await pool.query(
        `SELECT id FROM transactions WHERE reference=$1 AND status='success'`,
        [ref]
      );
      if (already.rowCount > 0) {
        console.log('[USSD] Poll: already fulfilled', ref);
        return;
      }

      // Fulfill
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const preAssigned = await client.query(
          `SELECT id, serial, pin FROM vouchers WHERE transaction_ref=$1 AND status='sold'`,
          [ref]
        );

        if (preAssigned.rowCount >= quantity) {
          await client.query(
            `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
             VALUES ($1,$2,$3,$4,$5,'success',NOW())
             ON CONFLICT (reference) DO UPDATE SET status='success'`,
            [ref, phone, parseFloat(total), quantity, voucherType]
          );
          await client.query('COMMIT');
          client.release();
          await sendVoucherSMS(phone, preAssigned.rows, voucherType);
          console.log('[USSD] Poll fulfilled:', ref);
          return;
        }

        // No pre-assigned — grab fresh vouchers
        const vouchers = await client.query(
          `SELECT id, serial, pin FROM vouchers
           WHERE type=$1 AND status='available'
           LIMIT $2 FOR UPDATE SKIP LOCKED`,
          [voucherType, quantity]
        );

        if (vouchers.rowCount < quantity) {
          // Payment confirmed but no stock — save preorder so admin can fulfill it
          await client.query(
            `INSERT INTO preorders (reference, phone, name, amount, quantity, voucher_type, status, created_at)
             VALUES ($1,$2,'',$3,$4,$5,'pending',NOW())
             ON CONFLICT (reference) DO NOTHING`,
            [ref, phone, parseFloat(total), quantity, voucherType]
          );
          await client.query(
            `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
             VALUES ($1,$2,$3,$4,$5,'preorder',NOW())
             ON CONFLICT (reference) DO UPDATE SET status='preorder'`,
            [ref, phone, parseFloat(total), quantity, voucherType]
          );
          await client.query('COMMIT');
          client.release();
          await sendPreorderSMS(phone, voucherType, ref);
          await sendAdminAlert(`⚠️ USSD Preorder: ${voucherType} x${quantity} from ${phone}. Ref: ${ref}`);
          return;
        }

        const ids = vouchers.rows.map(v => v.id);
        await client.query(
          `UPDATE vouchers SET status='sold', sold_to=$1, sold_at=NOW(), transaction_ref=$2 WHERE id=ANY($3)`,
          [phone, ref, ids]
        );
        await client.query(
          `INSERT INTO transactions (reference, phone, amount, quantity, voucher_type, status, created_at)
           VALUES ($1,$2,$3,$4,$5,'success',NOW())
           ON CONFLICT (reference) DO UPDATE SET status='success'`,
          [ref, phone, parseFloat(total), quantity, voucherType]
        );
        await client.query('COMMIT');
        client.release();
        await sendVoucherSMS(phone, vouchers.rows, voucherType);
        console.log('[USSD] Poll fulfilled (fresh vouchers):', ref);
        return;

      } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        console.error('[USSD] Poll fulfill error:', err.message);
        return;
      }

    } catch (err) {
      console.error(`[USSD] Poll attempt ${attempt} error:`, err.message);
    }
  }

  console.warn('[USSD] Poll timed out for', ref);
}

// ── Network name → Hubtel channel ─────────────────────────────────────────────
// Smart USSD passes network as e.g. "wigal_mtn_gh", "wigal_at_gh", "wigal_telecel_gh"

function networkToHubtelName(network) {
  const n = String(network || '').toUpperCase();
  if (n.includes('MTN'))                               return 'MTN';
  if (n.includes('AT') || n.includes('AIRTEL') || n.includes('TIGO')) return 'AT';
  if (n.includes('TELECEL') || n.includes('VODA'))     return 'TELECEL';
  return 'MTN'; // safe default
}

// ── Smart USSD response builder ───────────────────────────────────────────────
// Builds the required pipe-delimited response string.
// USERDATA uses ^ as newline (max 160 chars).
// mode should be 'MORE' (keep open) or 'END' (close session).

function buildResponse({ network, mode, msisdn, sessionid, userdata, username, trafficid, other }) {
  // Replace \n with ^ for USSD display, strip any pipe chars from message content
  const safeUserdata = String(userdata)
    .replace(/\n/g, '^')
    .replace(/\|/g, ' ');
  return `${network}|${mode}|${msisdn}|${sessionid}|${safeUserdata}|${username}|${trafficid}|${other}`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Smart USSD uses GET requests
  if (req.method === 'POST') return res.status(200).send('ok');
  if (req.method !== 'GET')  return res.status(405).end();

  const q = req.query;

  console.log('[USSD] query:', JSON.stringify(q));

  // ── Parse Smart USSD fields ────────────────────────────────────────────────
  const network   = String(q.network   ?? '').trim();
  const sessionid = String(q.sessionid ?? '').trim();
  const mode      = String(q.mode      ?? '').trim().toUpperCase(); // START | MORE | END
  const msisdn    = String(q.msisdn    ?? '').trim();
  const userdata  = String(q.userdata  ?? '').trim();
  const username  = String(q.username  ?? '').trim();
  const trafficid = String(q.trafficid ?? '').trim();
  const other     = String(q.other     ?? '').trim();

  console.log(`[USSD] sessionid="${sessionid}" mode=${mode} msisdn="${msisdn}" input="${userdata}" network="${network}"`);

  // ── Response helpers ───────────────────────────────────────────────────────
  const sendText = (text, keepOpen = true) => {
    const responseMode = keepOpen ? 'MORE' : 'END';
    const responseStr  = buildResponse({
      network, mode: responseMode, msisdn, sessionid,
      userdata: text, username, trafficid, other,
    });
    console.log(`[USSD] response (${responseMode}): ${responseStr.slice(0, 160)}`);
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(responseStr);
  };

  const endSession = async (text) => {
    await clearSession(sessionid);
    return sendText(text, false);
  };

  if (!sessionid) {
    console.error('[USSD] Missing sessionid:', JSON.stringify(q));
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(
      buildResponse({ network, mode: 'END', msisdn, sessionid: 'unknown',
        userdata: 'Session error. Please try again.', username, trafficid, other })
    );
  }

  try {
    const prices = await getPrices();

    const isNewSession    = mode === 'START';
    const existingSession = isNewSession ? null : await getSession(sessionid);

    console.log(`[USSD] isNewSession=${isNewSession} existingStage=${existingSession?.stage ?? 'none'}`);

    // ── *7 shortcode → proxy to SV data-bundle USSD ──────────────────────────
    // Dialling *xxx*xxx*7# makes Wigal send mode=START with userdata ending in "*7"
    // (e.g. "xxxx*7") — or just "7" on some network configs. Match both.
    // We mark the session as SV_PROXY and forward every request from here on.

    const isSvShortcode = isNewSession && /(?:^|\*)7$/.test(userdata);

    if (isSvShortcode) {
      // Mark session so all follow-up inputs are forwarded too.
      await setSession(sessionid, { stage: 'SV_PROXY' });
      // Forward the START to SV with empty userdata (the "7" was just routing).
      const svReply = await proxyToSv({
        network, sessionid, mode: 'START', msisdn,
        userdata: '', username, trafficid, other,
      });
      if (svReply) {
        // If SV already closed the session (unlikely on START but be safe), clean up.
        if (svReply.split('|')[1] === 'END') await clearSession(sessionid);
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send(svReply);
      }
      return endSession('DataBundles service is unavailable. Please try again.');
    }

    if (!isNewSession && existingSession?.stage === 'SV_PROXY') {
      // ── END notification — forward to SV then clean up ──────────────────
      if (mode === 'END') {
        await proxyToSv({ network, sessionid, mode: 'END', msisdn, userdata, username, trafficid, other });
        await clearSession(sessionid);
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send('');
      }

      // ── Regular input — forward to SV ────────────────────────────────────
      const svReply = await proxyToSv({ network, sessionid, mode, msisdn, userdata, username, trafficid, other });
      if (svReply) {
        // SV returned mode=END → clean up proxy session record.
        if (svReply.split('|')[1] === 'END') await clearSession(sessionid);
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send(svReply);
      }
      return endSession('DataBundles service is unavailable. Please try again.');
    }

    // ── New session → show main menu ─────────────────────────────────────────
    if (isNewSession || existingSession === null) {
      await setSession(sessionid, { stage: 'MENU' });
      return sendText(
        `Welcome to WAEC GH Checkers\n` +
        `1. WASSCE (GHS ${prices.WASSCE})\n` +
        `2. BECE (GHS ${prices.BECE})\n` +
        `3. Retrieve Voucher\n` +
        `4. BECE Release Date\n` +
        `5. WASSCE Release Date\n` +
        `0. Exit`,
        true
      );
    }

    // ── END mode — customer closed the session on their handset ──────────────
    if (mode === 'END') {
      await clearSession(sessionid);
      // No response needed for END; Wigal just notifies us the session closed
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send('');
    }

    const session = existingSession;
    const choice  = userdata; // digit(s) the customer typed

    console.log(`[USSD] stage="${session.stage}" choice="${choice}"`);

    switch (session.stage) {

      // ── Main menu ──────────────────────────────────────────────────────────
      case 'MENU': {
        const typeMap = { '1': 'WASSCE', '2': 'BECE' };
        if (choice === '0') return endSession('Thank you. Goodbye!');
        if (choice === '3') {
          await setSession(sessionid, { stage: 'RETRIEVE_PHONE' });
          return sendText('Enter phone number used for purchase\n(or press 0 to go back):', true);
        }
        if (choice === '4') {
          const msg = await getSetting('bece_release_message', 'BECE release date has not been announced yet. Check back soon.');
          return endSession(msg);
        }
        if (choice === '5') {
          const msg = await getSetting('wassce_release_message', 'WASSCE release date has not been announced yet. Check back soon.');
          return endSession(msg);
        }
        if (!typeMap[choice]) {
          return sendText(
            `Choose an option:\n1. WASSCE (GHS ${prices.WASSCE})\n2. BECE (GHS ${prices.BECE})\n3. Retrieve Voucher\n4. BECE Release Date\n5. WASSCE Release Date\n0. Exit`,
            true
          );
        }
        const voucherType = typeMap[choice];
        await setSession(sessionid, { stage: 'SELECT_QTY', voucherType });
        return sendText(
          `${voucherType} @ GHS ${prices[voucherType]} each.\nHow many? (1-5)`,
          true
        );
      }

      // ── Quantity selection ─────────────────────────────────────────────────
      case 'SELECT_QTY': {
        const qty = parseInt(choice, 10);
        if (!qty || qty < 1 || qty > 5) {
          return sendText('Please enter a number between 1 and 5:', true);
        }
        const unitPrice = parseFloat(prices[String(session.voucherType)] || 0);
        const total     = (unitPrice * qty).toFixed(2);
        await setSession(sessionid, { stage: 'CONFIRM', voucherType: session.voucherType, quantity: qty });
        return sendText(
          `${qty}x ${session.voucherType} = GHS ${total}\nMoMo: ${msisdn}\n\n1. Confirm & Pay\n2. Cancel`,
          true
        );
      }

      // ── Order confirmation ─────────────────────────────────────────────────
      case 'CONFIRM': {
        if (choice === '2') return endSession('Cancelled. Goodbye!');
        if (choice !== '1') return sendText('Press 1 to confirm or 2 to cancel:', true);

        const voucherType = session.voucherType ? String(session.voucherType) : null;
        const quantity    = session.quantity    ? parseInt(session.quantity, 10) : 0;
        const unitPrice   = parseFloat(prices[voucherType] || 0);
        const total       = (unitPrice * quantity).toFixed(2);

        if (!voucherType || !quantity) {
          console.error('[USSD] CONFIRM: missing session data', JSON.stringify(session));
          return endSession('Session expired. Please dial again.');
        }

        const safeSuffix = String(sessionid).replace(/\W/g, '').slice(-6).toUpperCase() || 'USSD';
        const ref        = `USSD-${Date.now()}-${safeSuffix}`;

        // ── Do NOT reserve vouchers or create a preorder here ─────────────
        // Payment has not happened yet — the customer still needs to approve
        // the MoMo prompt. Vouchers are assigned (or a preorder created) only
        // after payment is confirmed inside pollAndFulfill / hubtel-webhook.

        // ── Trigger MoMo PIN prompt ────────────────────────────────────────
        // Phone format for Hubtel: local 0XXXXXXXXX
        const payerLocal = msisdn.startsWith('233')  ? '0' + msisdn.slice(3)  :
                           msisdn.startsWith('+233') ? '0' + msisdn.slice(4)  :
                           msisdn;

        const networkName = networkToHubtelName(network);

        let paymentTriggered = false;

        // Primary — Hubtel direct debit
        try {
          await initHubtelDirectDebit({
            phone:       payerLocal,
            amount:      parseFloat(total),
            reference:   ref,
            description: `${quantity}x ${voucherType} - WAEC GH Checkers`,
            network:     networkName,
          });
          console.log('[USSD] Hubtel direct debit triggered for', ref);
          paymentTriggered = true;
        } catch (hubtelErr) {
          console.error('[USSD] Hubtel direct debit failed, trying Moolre fallback:', hubtelErr.message);
        }

        // Fallback — Moolre direct payment
        if (!paymentTriggered) {
          try {
            const channelMap  = { MTN: '13', AT: '7', TELECEL: '6' };
            const channel     = channelMap[networkName] || '13';
            console.log('[USSD] Moolre fallback request:', JSON.stringify({
              channel, currency: 'GHS', payer: payerLocal.slice(0, -4) + '****',
              amount: total, externalref: ref, accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
              hasApiKey: !!process.env.MOOLRE_API_KEY,
            }));
            const payRes = await fetch('https://api.moolre.com/open/transact/payment', {
              method: 'POST',
              headers: {
                // NOTE: the Initiate Payment endpoint requires the PRIVATE key
                // (X-API-KEY), not the public key. Using X-API-PUBKEY here makes
                // Moolre reject the request, so the MoMo prompt never goes out.
                'X-API-USER':   process.env.MOOLRE_USERNAME,
                'X-API-KEY':    process.env.MOOLRE_API_KEY,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                type:          1,
                channel,
                currency:      'GHS',
                payer:         payerLocal,
                amount:        total, // Moolre docs: amount must be a string, e.g. "30.00"
                externalref:   ref,
                reference:     `${quantity}x ${voucherType} - WAEC GH Checkers`,
                sessionid:     sessionid,
                accountnumber: process.env.NEXT_PUBLIC_MOOLRE_ACCOUNT_NUMBER,
              }),
            });
            const payData = await payRes.json();
            console.log('[USSD] Moolre fallback response:', JSON.stringify(payData));
            // status === 1 means Moolre accepted the request and sent the
            // prompt. Anything else means it failed — don't tell the customer
            // to check their phone if nothing was actually sent.
            paymentTriggered = Number(payData?.status) === 1;
            if (!paymentTriggered) {
              console.error(`[USSD] Moolre payment NOT accepted for ${ref}: status=${payData?.status} code=${payData?.code} message="${payData?.message}"`);
            }
          } catch (moolreErr) {
            console.error('[USSD] Moolre fallback also failed:', moolreErr.message);
          }
        }

        if (!paymentTriggered) {
          await sendAdminAlert(`⚠️ USSD payment trigger FAILED for ${ref} (${quantity}x ${voucherType}, ${msisdn}). Customer saw an error.`);
          return endSession('Unable to start payment right now. Please try again shortly.');
        }

        // Background poll — safety net if webhook is delayed
        pollAndFulfill({ ref, phone: msisdn, voucherType, quantity, total });

        // Close the USSD session — customer now approves on MoMo prompt
        return endSession(
          `Please authorize the GHS ${total} MoMo payment on your phone. Your voucher PIN will be sent by SMS once payment is confirmed.`
        );
      }

      // ── Unknown stage — reset ──────────────────────────────────────────────
      // ── Retrieve voucher — phone entry ────────────────────────────────────
      case 'RETRIEVE_PHONE': {
        if (choice === '0') {
          await setSession(sessionid, { stage: 'MENU' });
          return sendText(
            `WAEC GH Checkers\n1. WASSCE (GHS ${prices.WASSCE})\n2. BECE (GHS ${prices.BECE})\n3. Retrieve Voucher\n4. BECE Release Date\n5. WASSCE Release Date\n0. Exit`,
            true
          );
        }
        // Normalise the phone number to 233XXXXXXXXX
        let lookupPhone = choice.replace(/\s/g, '');
        if (lookupPhone.startsWith('+')) lookupPhone = lookupPhone.slice(1);
        if (lookupPhone.startsWith('0')) lookupPhone = '233' + lookupPhone.slice(1);

        try {
          const result = await pool.query(
            `SELECT serial, pin, type FROM vouchers
             WHERE sold_to = $1 AND status = 'sold'
             ORDER BY sold_at DESC LIMIT 5`,
            [lookupPhone]
          );
          if (result.rowCount === 0) {
            return endSession('No vouchers found for that number. Please check the number and try again.');
          }
          const lines = result.rows.map(v => `${v.type}: SN ${v.serial} PIN ${v.pin}`);
          return endSession(`Your vouchers:\n${lines.join('\n')}`);
        } catch (dbErr) {
          console.error('[USSD] RETRIEVE_PHONE DB error:', dbErr.message);
          return endSession('Error looking up vouchers. Please try again.');
        }
      }

      default:
        await setSession(sessionid, { stage: 'MENU' });
        return sendText(
          `WAEC GH Checkers\n1. WASSCE (GHS ${prices.WASSCE})\n2. BECE (GHS ${prices.BECE})\n3. Retrieve Voucher\n4. BECE Release Date\n5. WASSCE Release Date\n0. Exit`,
          true
        );
    }

  } catch (err) {
    console.error('[USSD] Unhandled error:', err.message, err.stack);
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(
      buildResponse({ network, mode: 'END', msisdn, sessionid,
        userdata: 'Service error. Please try again.', username, trafficid, other })
    );
  }
}
