/**
 * USSD callback handler — implements the state machine.
 *
 * Moolre sends POST requests with:
 *   { sessionId, new, msisdn, network, message, extension, data }
 *
 * We reply within ~2 seconds with:
 *   { message: "...", reply: true }   ← keeps session open
 *   { message: "...", reply: false }  ← ends session
 *
 * State machine stages:
 *   WELCOME         → greeting + main menu
 *   SELECT_NETWORK  → choose MTN / AirtelTigo / Telecel
 *   SELECT_PLAN     → paginated plan list
 *   ENTER_RECIPIENT → type number or press 0 for own number
 *   CONFIRM         → show order summary, confirm or cancel
 *   (end)           → payment initiated; session closed
 */

const session  = require('../session');
const datadash = require('../services/datadash');
const moolre   = require('../services/moolre');
const store    = require('../store');    // file-backed pending orders
const config   = require('../config');

// ─── Response helpers ─────────────────────────────────────────────────────────

function reply(res, message, keepOpen = true) {
  return res.json({ message: message.slice(0, 182), reply: keepOpen });
}

function end(res, message) {
  return reply(res, message, false);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function makeRef(msisdn) {
  return `DTHUB-${String(msisdn).slice(-6)}-${Date.now()}`;
}

function formatPlan(plan) {
  const allowance = plan.allowance ? `${plan.allowance} ` : '';
  const validity  = plan.validity  ? `${plan.validity} `  : '';
  return `${allowance}${validity}GHS${plan.price.toFixed(2)}`.trim();
}

function buildPlanPage(plans, page) {
  const perPage  = config.PLANS_PER_PAGE;
  const start    = page * perPage;
  const slice    = plans.slice(start, start + perPage);
  const hasNext  = start + perPage < plans.length;
  const hasPrev  = page > 0;

  let msg = 'Select plan:\n';
  slice.forEach((p, i) => { msg += `${i + 1}. ${formatPlan(p)}\n`; });
  if (hasNext) msg += '9. Next page\n';
  if (hasPrev) msg += '8. Prev page\n';
  msg += '0. Back';

  return { msg, slice, hasNext, hasPrev };
}

function mainMenu(serviceName) {
  return `Welcome to ${serviceName}\n1. Buy Data\n2. My Balance\n0. Exit`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

async function handleUssd(req, res) {
  // Guard: Moolre request body may be missing fields
  const {
    sessionId,
    new: isNew,
    msisdn,
    network,
    message: input,
  } = req.body || {};

  if (!sessionId || !msisdn) {
    console.warn('[USSD] Received request with missing sessionId or msisdn:', req.body);
    return end(res, 'Service error. Please dial again.');
  }

  // ── NEW SESSION ─────────────────────────────────────────────────────────────
  if (isNew) {
    await session.set(sessionId, {
      stage:           'WELCOME',
      msisdn:          String(msisdn),
      network:         parseInt(network, 10) || 0,
      planPage:        0,
      selectedNetwork: null,
      selectedPlan:    null,
      recipient:       null,
    });
    return reply(res, mainMenu(config.SERVICE_NAME));
  }

  // ── CONTINUING SESSION ──────────────────────────────────────────────────────
  const sess = await session.get(sessionId);
  if (!sess) {
    return end(res, 'Session expired. Please dial again.');
  }

  const choice = String(input || '').trim();

  try {
    switch (sess.stage) {

      // ── WELCOME ─────────────────────────────────────────────────────────────
      case 'WELCOME': {
        if (choice === '0') return end(res, 'Thank you. Goodbye!');

        if (choice === '2') {
          const balance = await datadash.getWalletBalance();
          return end(res, `${config.SERVICE_NAME} Balance:\nGHS ${balance.toFixed(2)}`);
        }

        if (choice === '1') {
          let networks;
          try {
            networks = await datadash.getNetworks();
          } catch (err) {
            console.error('[USSD] Failed to load networks:', err.message);
            return end(res, 'Service unavailable. Please try again in a few minutes.');
          }

          if (networks.length === 0) {
            return end(res, 'No plans available at this time. Try again later.');
          }

          await session.update(sessionId, { stage: 'SELECT_NETWORK', availableNetworks: networks });

          let msg = 'Select network:\n';
          networks.forEach((n, i) => { msg += `${i + 1}. ${n}\n`; });
          msg += '0. Back';
          return reply(res, msg);
        }

        // Invalid
        return reply(res, `Invalid option.\n${mainMenu(config.SERVICE_NAME)}`);
      }

      // ── SELECT NETWORK ───────────────────────────────────────────────────────
      case 'SELECT_NETWORK': {
        const networks = sess.availableNetworks || [];

        if (choice === '0') {
          await session.update(sessionId, { stage: 'WELCOME' });
          return reply(res, mainMenu(config.SERVICE_NAME));
        }

        const idx = parseInt(choice, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= networks.length) {
          let msg = 'Invalid. Select network:\n';
          networks.forEach((n, i) => { msg += `${i + 1}. ${n}\n`; });
          msg += '0. Back';
          return reply(res, msg);
        }

        const selectedNetwork = networks[idx];
        let plans;
        try {
          plans = await datadash.getPlansByNetwork(selectedNetwork);
        } catch (err) {
          console.error('[USSD] Failed to load plans:', err.message);
          return end(res, 'Could not load plans. Please try again.');
        }

        if (plans.length === 0) {
          let msg = `No plans for ${selectedNetwork}.\nSelect network:\n`;
          networks.forEach((n, i) => { msg += `${i + 1}. ${n}\n`; });
          msg += '0. Back';
          return reply(res, msg);
        }

        await session.update(sessionId, { stage: 'SELECT_PLAN', selectedNetwork, networkPlans: plans, planPage: 0 });
        return reply(res, buildPlanPage(plans, 0).msg);
      }

      // ── SELECT PLAN ──────────────────────────────────────────────────────────
      case 'SELECT_PLAN': {
        const plans = sess.networkPlans || [];
        const page  = sess.planPage || 0;

        if (choice === '0') {
          await session.update(sessionId, { stage: 'SELECT_NETWORK' });
          const networks = sess.availableNetworks || [];
          let msg = 'Select network:\n';
          networks.forEach((n, i) => { msg += `${i + 1}. ${n}\n`; });
          msg += '0. Back';
          return reply(res, msg);
        }

        const { slice, hasNext, hasPrev } = buildPlanPage(plans, page);

        if (choice === '9' && hasNext) {
          const p = page + 1;
          await session.update(sessionId, { planPage: p });
          return reply(res, buildPlanPage(plans, p).msg);
        }

        if (choice === '8' && hasPrev) {
          const p = page - 1;
          await session.update(sessionId, { planPage: p });
          return reply(res, buildPlanPage(plans, p).msg);
        }

        const planIdx = parseInt(choice, 10) - 1;
        if (isNaN(planIdx) || planIdx < 0 || planIdx >= slice.length) {
          return reply(res, `Invalid option.\n${buildPlanPage(plans, page).msg}`);
        }

        const selectedPlan = slice[planIdx];
        await session.update(sessionId, { stage: 'ENTER_RECIPIENT', selectedPlan });

        return reply(
          res,
          `${formatPlan(selectedPlan)}\n\nEnter recipient number\nor press 0 for your own number:`
        );
      }

      // ── ENTER RECIPIENT ──────────────────────────────────────────────────────
      case 'ENTER_RECIPIENT': {
        let recipient;

        if (choice === '0') {
          recipient = sess.msisdn;
        } else if (/^0\d{9}$/.test(choice)) {
          recipient = choice;
        } else if (/^\d{9}$/.test(choice)) {
          recipient = '0' + choice;
        } else {
          return reply(res, 'Invalid number. Enter 10-digit\nnumber (e.g. 0541234567)\nor press 0 for your own number:');
        }

        await session.update(sessionId, { stage: 'CONFIRM', recipient });

        const plan = sess.selectedPlan;
        return reply(
          res,
          `Confirm Order:\n` +
          `Plan: ${formatPlan(plan)}\n` +
          `For:  ${recipient}\n` +
          `Cost: GHS${plan.price.toFixed(2)}\n\n` +
          `1. Confirm\n0. Cancel`
        );
      }

      // ── CONFIRM ──────────────────────────────────────────────────────────────
      case 'CONFIRM': {
        if (choice === '0') {
          await session.update(sessionId, { stage: 'WELCOME' });
          return reply(res, `Cancelled.\n\n${mainMenu(config.SERVICE_NAME)}`);
        }

        if (choice !== '1') {
          const plan = sess.selectedPlan;
          return reply(
            res,
            `Confirm Order:\n` +
            `Plan: ${formatPlan(plan)}\n` +
            `For:  ${sess.recipient}\n` +
            `Cost: GHS${plan.price.toFixed(2)}\n\n` +
            `1. Confirm\n0. Cancel`
          );
        }

        // ── Initiate payment ─────────────────────────────────────────────────
        const plan        = sess.selectedPlan;
        const externalRef = makeRef(sess.msisdn);

        // Save order to Redis BEFORE calling Moolre — ensures the record exists
        // even if the webhook fires before initiatePayment returns.
        await store.set(externalRef, {
          planId:    plan.id,
          recipient: sess.recipient,
          amount:    plan.price,
          msisdn:    sess.msisdn,
          planName:  plan.name,
        });

        await session.update(sessionId, { stage: 'PROCESSING', externalRef });

        console.log(`[USSD] Initiating payment: ref=${externalRef} network=${sess.network}→channel=${config.NETWORK_TO_CHANNEL[sess.network]} amount=${plan.price}`);

        let paymentResponse;
        try {
          paymentResponse = await moolre.initiatePayment({
            payer:         sess.msisdn,
            networkCode:   sess.network,
            amount:        plan.price,
            externalRef,
            ussdSessionId: sessionId,
            reference:     `${plan.name} → ${sess.recipient}`,
          });
        } catch (err) {
          console.error(`[USSD] Payment initiation error for ${externalRef}:`, err.message);
          await store.remove(externalRef);
          return end(res, 'Payment service error. Please try again.\n\nNo charge was made.');
        }

        // If Moolre rejected the request, clean up and tell the user
        if (!paymentResponse.ok) {
          const reason = paymentResponse.raw?.message || 'Request declined';
          console.warn(`[USSD] Payment rejected for ${externalRef}: status=${paymentResponse.statusCode} reason="${reason}"`);
          await store.remove(externalRef);
          return end(res, `Payment declined: ${reason}\n\nNo charge was made.`);
        }

        // Success — payment prompt is on the customer's phone
        const networkName = config.NETWORK_NAMES[sess.network] || 'your network';
        return end(
          res,
          `GHS${plan.price.toFixed(2)} payment requested.\n` +
          `Approve the ${networkName} prompt to get your data.\n\n` +
          `Ref: ${externalRef}`
        );
      }

      // ── PROCESSING ───────────────────────────────────────────────────────────
      case 'PROCESSING': {
        return end(res, 'Your order is being processed. You will receive your bundle shortly.');
      }

      default:
        return end(res, 'An error occurred. Please dial again.');
    }

  } catch (err) {
    console.error('[USSD] Unhandled error in stage', sess?.stage, ':', err.message);
    return end(res, 'Service error. Please try again later.');
  }
}

module.exports = { handleUssd };
