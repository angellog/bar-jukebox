// ============================================
// BILLING: prepaid plans paid through Flutterwave (mobile money + card)
//
// Venues pay for 1, 3 or 12 months up front (Flutterwave's recurring plans are
// card-only, and most venues here pay with MTN/Airtel mobile money). Nothing
// renews automatically; plans lapse to Free when they expire.
//
// A payment only activates a plan after the server verifies the transaction
// with Flutterwave (status, reference, amount and currency all match). The
// browser redirect and the webhook are just triggers for that check.
// ============================================

const crypto = require('crypto');

const CURRENCY = 'UGX';

// Monthly price per plan, in UGX. 12 months are charged as 10.
const MONTHLY_PRICE = {
  starter: 75000,
  pro: 185000,
  enterprise: 370000
};

const PERIODS = { 1: 1, 3: 3, 12: 10 }; // months bought -> months charged

// What each plan actually changes. Kept here so the pricing page, dashboard
// and database always agree.
const PLAN_FEATURES = {
  free: ['Up to 10 songs in the queue', 'Each guest: up to 30 songs a day', 'Background music & speaker mode', 'Your logo and colours', 'Email support'],
  starter: ['Up to 25 songs in the queue', 'Each guest: up to 100 songs a day', 'Everything in Free'],
  pro: ['Up to 50 songs in the queue', 'Each guest: up to 500 songs a day', 'Everything in Starter', 'Priority support'],
  enterprise: ['Up to 200 songs in the queue', 'No practical daily limit per guest', 'Everything in Pro', 'Dedicated onboarding']
};

function priceFor(planId, months) {
  const monthly = MONTHLY_PRICE[planId];
  const charged = PERIODS[months];
  if (!monthly || !charged) return null;
  return monthly * charged;
}

function billingEnabled() {
  return !!process.env.FLW_SECRET_KEY;
}

function apiBase() {
  return (process.env.FLW_API_BASE || 'https://api.flutterwave.com/v3').replace(/\/$/, '');
}

async function flw(method, path, body) {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === 'error') {
    const err = new Error(`Flutterwave ${method} ${path} failed: ${data.message || res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function newTxRef(venueId) {
  return `qp-${venueId.slice(0, 8)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

// Creates a hosted checkout link (Flutterwave Standard).
async function createCheckout({ txRef, amount, venue, planName, months, customerEmail, redirectUrl }) {
  const data = await flw('POST', '/payments', {
    tx_ref: txRef,
    amount,
    currency: CURRENCY,
    redirect_url: redirectUrl,
    payment_options: 'mobilemoneyuganda,card',
    customer: { email: customerEmail, name: venue.name },
    customizations: {
      title: 'QueuePlay',
      description: `${planName} plan for ${venue.name}: ${months} month${months === 1 ? '' : 's'}`
    },
    meta: { venue_id: venue.id, months }
  });
  return data.data && data.data.link;
}

async function verifyTransaction(transactionId) {
  const data = await flw('GET', `/transactions/${encodeURIComponent(transactionId)}/verify`);
  return data.data;
}

// Flutterwave sends the secret hash you configured in the dashboard in the
// `verif-hash` header. Compare in constant time.
function webhookAuthentic(headerValue) {
  const expected = process.env.FLW_WEBHOOK_HASH || '';
  const got = String(headerValue || '');
  if (!expected || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

module.exports = {
  CURRENCY, MONTHLY_PRICE, PERIODS, PLAN_FEATURES,
  priceFor, billingEnabled, newTxRef, createCheckout, verifyTransaction, webhookAuthentic
};
