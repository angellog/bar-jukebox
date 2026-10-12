#!/usr/bin/env node
// Billing flow test against a fake Flutterwave API.
//
// 1. Start the app pointed at the fake API:
//      FLW_SECRET_KEY=test FLW_WEBHOOK_HASH=hookhash FLW_API_BASE=http://localhost:4799/v3 \
//      SUPER_ADMIN_KEY=testsuper DATABASE_URL=... PORT=4719 BASE_URL=http://localhost:4719 node src/server.js
// 2. DATABASE_URL=... SUPER_ADMIN_KEY=testsuper node scripts/billing-test.js http://localhost:4719
//
// The fake API listens on :4799 while this script runs.

const http = require('http');
const QueuePlayDB = require('../src/database');

const BASE = (process.argv[2] || 'http://localhost:4719').replace(/\/$/, '');
const SUPER_KEY = process.env.SUPER_ADMIN_KEY;
const HOOK = 'hookhash';
let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => { ok ? passed++ : failed++; console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- fake Flutterwave ----
const checkouts = [];
const transactions = {}; // id -> { status, tx_ref, amount, currency, payment_type }
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer test') { res.statusCode = 401; return res.end('{"status":"error","message":"bad key"}'); }
    if (req.method === 'POST' && req.url === '/v3/payments') {
      const p = JSON.parse(body);
      checkouts.push(p);
      return res.end(JSON.stringify({ status: 'success', data: { link: `https://checkout.example/pay/${p.tx_ref}` } }));
    }
    const m = req.url.match(/^\/v3\/transactions\/(\w+)\/verify$/);
    if (req.method === 'GET' && m) {
      const tx = transactions[m[1]];
      if (!tx) { res.statusCode = 404; return res.end('{"status":"error","message":"No transaction was found for this id"}'); }
      return res.end(JSON.stringify({ status: 'success', data: { id: Number(m[1]), ...tx } }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});

function client() {
  const jar = {};
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';'); const [k, ...v] = pair.split('='); jar[k.trim()] = v.join('=');
    }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, location: res.headers.get('location') };
  };
}

async function main() {
  await new Promise(r => fake.listen(4799, r));
  const db = new QueuePlayDB(process.env.DATABASE_URL);
  const owner = client();
  const anon = client();
  const slug = `bill-${Date.now().toString(36)}`;
  let venueId;

  try {
    const reg = await owner('/api/register', { method: 'POST', body: { name: slug, slug, password: 'billing123', email: 'owner@venue.test' } });
    venueId = reg.json.venue.id;

    const b0 = await owner(`/api/venue/${slug}/admin/billing`);
    check('billing enabled with keys set', b0.json?.enabled === true);
    check('new venue starts on Free', b0.json?.current?.planId === 'free');
    check('prices in UGX', b0.json?.currency === 'UGX' && b0.json.plans.find(p => p.id === 'pro')?.monthly === 185000);

    check('strangers cannot start checkout', (await anon(`/api/venue/${slug}/admin/billing/checkout`, { method: 'POST', body: { planId: 'pro', months: 1 } })).status === 401);
    check('invalid period rejected', (await owner(`/api/venue/${slug}/admin/billing/checkout`, { method: 'POST', body: { planId: 'pro', months: 2 } })).status === 400);

    // 1. Pay for Pro, 3 months
    const co = await owner(`/api/venue/${slug}/admin/billing/checkout`, { method: 'POST', body: { planId: 'pro', months: 3, email: 'owner@venue.test' } });
    const sent = checkouts[checkouts.length - 1];
    check('checkout returns Flutterwave link', co.status === 200 && co.json.link.includes(sent.tx_ref));
    check('charges 3 x 185,000 UGX with mobile money + card', sent.amount === 555000 && sent.currency === 'UGX' && sent.payment_options.includes('mobilemoneyuganda') && sent.payment_options.includes('card'));
    check('redirects back to /billing/return', sent.redirect_url.endsWith('/billing/return'));

    transactions['1001'] = { status: 'successful', tx_ref: sent.tx_ref, amount: 555000, currency: 'UGX', payment_type: 'mobilemoneyuganda' };
    const ret = await anon(`/billing/return?status=successful&tx_ref=${sent.tx_ref}&transaction_id=1001`);
    check('return redirects to dashboard with success', ret.status === 302 && ret.location === `/admin/${slug}?billing=success`, ret.location);
    const b1 = await owner(`/api/venue/${slug}/admin/billing`);
    const exp1 = new Date(b1.json.current.expiresAt);
    const months1 = (exp1 - Date.now()) / (30.4 * 86400000);
    check('plan is now Pro', b1.json.current.planId === 'pro');
    check('paid for ~3 months', months1 > 2.8 && months1 < 3.2, `${months1.toFixed(2)} months`);
    check('payment recorded as paid', b1.json.payments[0]?.status === 'successful' && b1.json.payments[0]?.method === 'mobilemoneyuganda');

    // 2. Replays don't extend twice
    await anon(`/billing/return?status=successful&tx_ref=${sent.tx_ref}&transaction_id=1001`);
    const badHook = await anon('/api/webhooks/flutterwave', { method: 'POST', headers: { 'verif-hash': 'wrong' }, body: { event: 'charge.completed', data: { id: 1001, tx_ref: sent.tx_ref } } });
    check('webhook with wrong secret rejected', badHook.status === 401);
    const goodHook = await anon('/api/webhooks/flutterwave', { method: 'POST', headers: { 'verif-hash': HOOK }, body: { event: 'charge.completed', data: { id: 1001, tx_ref: sent.tx_ref } } });
    await sleep(500);
    const b2 = await owner(`/api/venue/${slug}/admin/billing`);
    check('duplicate return + webhook do not extend twice', goodHook.status === 200 && b2.json.current.expiresAt === b1.json.current.expiresAt);

    // 3. Underpaid / tampered transaction doesn't activate anything
    const co2 = await owner(`/api/venue/${slug}/admin/billing/checkout`, { method: 'POST', body: { planId: 'enterprise', months: 12, email: 'owner@venue.test' } });
    const sent2 = checkouts[checkouts.length - 1];
    transactions['1002'] = { status: 'successful', tx_ref: sent2.tx_ref, amount: 1000, currency: 'UGX', payment_type: 'card' };
    const ret2 = await anon(`/billing/return?status=successful&tx_ref=${sent2.tx_ref}&transaction_id=1002`);
    const b3 = await owner(`/api/venue/${slug}/admin/billing`);
    check('underpaid transaction is not accepted', co2.status === 200 && ret2.location.endsWith('billing=pending') && b3.json.current.planId === 'pro');
    transactions['1003'] = { status: 'successful', tx_ref: 'someone-elses-ref', amount: 3700000, currency: 'UGX', payment_type: 'card' };
    const ret3 = await anon(`/billing/return?status=successful&tx_ref=${sent2.tx_ref}&transaction_id=1003`);
    check("another payment's transaction can't be reused", ret3.location.endsWith('billing=pending') && (await owner(`/api/venue/${slug}/admin/billing`)).json.current.planId === 'pro');

    // 4. Cancelled payment
    await owner(`/api/venue/${slug}/admin/billing/checkout`, { method: 'POST', body: { planId: 'starter', months: 1, email: 'owner@venue.test' } });
    const sent4 = checkouts[checkouts.length - 1];
    const ret4 = await anon(`/billing/return?status=cancelled&tx_ref=${sent4.tx_ref}`);
    const pay4 = (await owner(`/api/venue/${slug}/admin/billing`)).json.payments.find(p => p.txRef === sent4.tx_ref);
    check('cancelled payment marked not completed', ret4.location.endsWith('billing=cancelled') && pay4.status === 'failed');

    // 5. Renewal via webhook extends from the current expiry
    await owner(`/api/venue/${slug}/admin/billing/checkout`, { method: 'POST', body: { planId: 'pro', months: 1, email: 'owner@venue.test' } });
    const sent5 = checkouts[checkouts.length - 1];
    transactions['1005'] = { status: 'successful', tx_ref: sent5.tx_ref, amount: 185000, currency: 'UGX', payment_type: 'card' };
    await anon('/api/webhooks/flutterwave', { method: 'POST', headers: { 'verif-hash': HOOK }, body: { event: 'charge.completed', data: { id: 1005, tx_ref: sent5.tx_ref, status: 'successful' } } });
    await sleep(800);
    const b5 = await owner(`/api/venue/${slug}/admin/billing`);
    const addedDays = (new Date(b5.json.current.expiresAt) - exp1) / 86400000;
    check('renewal adds a month on top of current expiry', addedDays > 27 && addedDays < 32, `${addedDays.toFixed(1)} days`);

    // 6. Expiry lapses to Free
    await db.pool.query("UPDATE venues SET subscription_expires_at = NOW() - interval '1 day' WHERE id = $1", [venueId]);
    await db.expireLapsedPlans();
    const b6 = await owner(`/api/venue/${slug}/admin/billing`);
    check('expired plan drops to Free', b6.json.current.planId === 'free' && b6.json.current.status === 'expired');

    // 7. Plan limits: Free caps the queue setting at 10
    const cfg = await owner(`/api/venue/${slug}/admin/config`, { method: 'PUT', body: { max_queue_size: 150 } });
    check('queue setting capped at plan maximum', cfg.json?.config?.max_queue_size === 10);
  } finally {
    if (venueId && SUPER_KEY) await anon(`/api/superadmin/venues/${venueId}`, { method: 'DELETE', headers: { 'x-super-key': SUPER_KEY } });
    await db.pool.query('DELETE FROM payments WHERE venue_id = $1', [venueId || '']).catch(() => {});
    await db.close();
    fake.close();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
