#!/usr/bin/env node
// End-to-end smoke test against a running QueuePlay server.
//
//   node scripts/smoke-test.js http://localhost:3000
//   SUPER_ADMIN_KEY=... node scripts/smoke-test.js https://queueplay-jukebox-production.up.railway.app
//
// Without SUPER_ADMIN_KEY only read-only checks run (nothing is created).
// With it, a throwaway venue is registered, exercised, and deleted at the end.

const WebSocket = require('ws');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const SUPER_KEY = process.env.SUPER_ADMIN_KEY;
const TEST_TRACK = '0DiWol3AO6WpXZgp0goxAV'; // Daft Punk - One More Time

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
}

// Minimal cookie jar per simulated browser
function client() {
  const jar = {};
  req.cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  return req;
  async function req(path, { method = 'GET', body, headers = {}, redirect = 'follow' } = {}) {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + path, {
      method,
      redirect,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const [k, ...v] = pair.split('=');
      const value = v.join('=');
      if (value) jar[k.trim()] = value; else delete jar[k.trim()];
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
}

// Opens a player-role socket; resolves with { ws, events[], closed: Promise<code> }.
function openPlayer(venue, cookie) {
  return new Promise(resolve => {
    const url = BASE.replace(/^http/, 'ws') + `?venue=${encodeURIComponent(venue)}&role=player`;
    const ws = new WebSocket(url, { headers: cookie ? { Cookie: cookie } : {} });
    const events = [];
    const closed = new Promise(r => ws.on('close', code => r(code)));
    ws.on('message', m => events.push(JSON.parse(String(m))));
    ws.on('open', () => setTimeout(() => resolve({ ws, events, closed }), 500));
    ws.on('error', () => resolve({ ws, events, closed }));
    closed.then(() => resolve({ ws, events, closed }));
  });
}

function wsInit(venue) {
  return new Promise(resolve => {
    const url = BASE.replace(/^http/, 'ws') + `?venue=${encodeURIComponent(venue)}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.terminate(); resolve(null); }, 5000);
    ws.on('message', m => { clearTimeout(timer); ws.close(); resolve(JSON.parse(String(m))); });
    ws.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function main() {
  console.log(`\nSmoke testing ${BASE}\n`);
  const anon = client();

  // ---- Read-only checks ----
  const health = await anon('/api/health');
  check('health endpoint', health.status === 200 && health.json?.database === 'ok', JSON.stringify(health.json));
  check('spotify configured', health.json?.spotify === true);

  for (const page of ['/', '/pricing', '/register', '/superadmin']) {
    const r = await anon(page);
    check(`page ${page}`, r.status === 200);
  }

  const plans = await anon('/api/plans');
  check('plans API', plans.status === 200 && plans.json?.plans?.length >= 4);

  const missing = await anon('/v/this-venue-does-not-exist-xyz');
  check('unknown venue 404s', missing.status === 404);

  const forged = await anon('/auth/spotify/callback?code=x&state=forged');
  check('forged OAuth state rejected', forged.status === 400);

  if (!SUPER_KEY) {
    console.log('\n(SUPER_ADMIN_KEY not set: skipping write tests)');
    return;
  }

  // ---- Write tests on a throwaway venue ----
  const slug = `smoke-${Date.now().toString(36)}`;
  const password = 'smoke-test-pw';
  const owner = client();
  let venueId = null;

  try {
    const reg = await owner('/api/register', { method: 'POST', body: { name: slug, password, slug } });
    venueId = reg.json?.venue?.id;
    check('register venue', reg.status === 200 && !!venueId);
    check('register does not expose admin key', reg.json && !('adminKey' in reg.json.venue));

    const session = await owner(`/api/venue/${slug}/admin/session`);
    check('register auto-logs-in', session.json?.authenticated === true);

    const stranger = client();
    const noAuth = await stranger(`/api/venue/${slug}/admin/stats`);
    check('admin API rejects strangers', noAuth.status === 401);

    const connect = await stranger(`/auth/spotify/connect/${slug}`, { redirect: 'manual' });
    check('Spotify connect requires login', connect.status === 302 && (connect.headers.get('location') || '').startsWith(`/admin/${slug}`));

    const badLogin = await stranger(`/api/venue/${slug}/admin/login`, { method: 'POST', body: { password: 'nope' } });
    check('wrong password rejected', badLogin.status === 401);

    const goodLogin = await stranger(`/api/venue/${slug}/admin/login`, { method: 'POST', body: { password } });
    check('correct password logs in', goodLogin.status === 200);
    const stats = await stranger(`/api/venue/${slug}/admin/stats`);
    check('admin API works with session cookie', stats.status === 200);

    const cfg = await stranger(`/api/venue/${slug}/admin/config`, {
      method: 'PUT',
      body: { rate_limit_minutes: 0, songs_per_guest: 99999, max_queue_size: 30, allow_explicit: 1, auto_play: 1 }
    });
    check('save rate limits (0 = no cooldown)', cfg.status === 200 && cfg.json?.config?.rate_limit_minutes === 0);
    check('songs/day capped at plan max', cfg.json?.config?.songs_per_guest > 0 && cfg.json.config.songs_per_guest < 99999, `saved ${cfg.json?.config?.songs_per_guest}`);
    const rl = await anon(`/api/venue/${slug}/rate-limit`);
    check('guest sees no cooldown', rl.json?.allowed === true && rl.json?.rateLimitMinutes === 0);
    // restore a cooldown so the queue tests below exercise it
    await stranger(`/api/venue/${slug}/admin/config`, { method: 'PUT', body: { rate_limit_minutes: 5 } });

    const strangerCfg = await anon(`/api/venue/${slug}/admin/config`, { method: 'PUT', body: { rate_limit_minutes: 0 } });
    check('strangers cannot change limits', strangerCfg.status === 401);

    await stranger(`/api/venue/${slug}/admin/logout`, { method: 'POST' });
    const afterLogout = await stranger(`/api/venue/${slug}/admin/stats`);
    check('logout ends session', afterLogout.status === 401);

    // A fresh venue has no Spotify account connected. Spotify Development Mode apps
    // can't search without one, so either real results or the clear 503 is acceptable.
    const search = await anon(`/api/venue/${slug}/search?q=daft%20punk`);
    const searchOk = search.status === 200 ? search.json?.results?.length > 0 : search.status === 503;
    check('Spotify search (or clear not-connected message)', searchOk, search.status === 200 ? `${search.json.results.length} results` : search.json?.error);
    const canQueue = search.status === 200;

    const ws = await wsInit(slug);
    check('WebSocket by slug', ws?.type === 'init');

    const anonPlayer = await openPlayer(slug, null);
    check('player socket requires login', (await anonPlayer.closed) === 4001);

    const p1 = await openPlayer(slug, owner.cookieHeader());
    const p2 = await openPlayer(slug, owner.cookieHeader());
    const p1Code = await Promise.race([p1.closed, new Promise(r => setTimeout(() => r(null), 3000))]);
    check('second player replaces the first', p1Code === 4000 && p1.events.some(e => e.type === 'player_replaced'));
    check('second player stays connected', p2.ws.readyState === WebSocket.OPEN);
    p2.ws.close();

    if (!canQueue) {
      console.log('   (queue tests skipped: needs Spotify search, i.e. a connected venue or extended-quota app)');
      return;
    }

    const guestA = client();
    const add = await guestA(`/api/venue/${slug}/queue`, { method: 'POST', body: { songId: TEST_TRACK, guestName: 'Smoke' } });
    check('guest adds song', add.status === 200, add.json?.error);

    const again = await guestA(`/api/venue/${slug}/queue`, { method: 'POST', body: { songId: TEST_TRACK } });
    check('guest cooldown enforced', again.status === 429);

    const guestB = client();
    const dup = await guestB(`/api/venue/${slug}/queue`, { method: 'POST', body: { songId: TEST_TRACK } });
    check('duplicate song blocked', dup.status === 409);

    const next = await owner(`/api/venue/${slug}/play-next`, { method: 'POST', body: { current: '' } });
    check('play-next starts song', next.status === 200 && next.json?.nowPlaying?.song_id === TEST_TRACK);

    // Two players racing to advance from the same (now stale) state must not double-skip.
    const stale = await owner(`/api/venue/${slug}/play-next`, { method: 'POST', body: { current: '' } });
    check('stale play-next does not skip', stale.status === 200 && stale.json?.advanced === false && stale.json?.nowPlaying?.song_id === TEST_TRACK);

    const empty = await owner(`/api/venue/${slug}/play-next`, { method: 'POST' });
    check('play-next on empty queue', empty.status === 200 && empty.json?.nowPlaying === null);
  } finally {
    if (venueId) {
      const del = await anon(`/api/superadmin/venues/${venueId}`, { method: 'DELETE', headers: { 'x-super-key': SUPER_KEY } });
      check('cleanup: delete test venue', del.status === 200);
    }
  }
}

main()
  .catch(err => { failed++; console.error('❌ crashed:', err.message); })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  });
