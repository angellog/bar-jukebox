require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const QueuePlayDB = require('./database');
const SpotifyService = require('./spotify');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[FATAL] DATABASE_URL environment variable is required');
  process.exit(1);
}

const db = new QueuePlayDB(DATABASE_URL);
const spotify = new SpotifyService(
  process.env.SPOTIFY_CLIENT_ID,
  process.env.SPOTIFY_CLIENT_SECRET,
  `${BASE_URL}/auth/spotify/callback`
);

const STATE_SECRET = process.env.SESSION_SECRET || process.env.SUPER_ADMIN_KEY || process.env.SALT || 'queueplay-state';

// Legacy hashes were unsalted-per-user SHA-256; new ones are scrypt ("scrypt$salt$hash").
function legacyHash(password) {
  return crypto.createHash('sha256').update(password + (process.env.SALT || 'queueplay-salt')).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  if (stored.startsWith('scrypt$')) {
    const [, salt, hash] = stored.split('$');
    const candidate = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  }
  const candidate = Buffer.from(legacyHash(password));
  const expected = Buffer.from(stored);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// Signed OAuth state so a Spotify account can only be bound to the venue that started the flow.
function signState(venueId) {
  const ts = Date.now().toString(36);
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(`${venueId}.${ts}`).digest('hex').slice(0, 32);
  return `${venueId}.${ts}.${sig}`;
}

function verifyState(state) {
  const parts = (state || '').split('.');
  if (parts.length !== 3) return null;
  const [venueId, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', STATE_SECRET).update(`${venueId}.${ts}`).digest('hex').slice(0, 32);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Date.now() - parseInt(ts, 36) > 15 * 60 * 1000) return null;
  return venueId;
}

app.set('trust proxy', 1);
app.use(cors({ origin: false }));
app.use(express.json());
app.use(cookieParser());
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));

function guestIdentity(req, res, next) {
  let guestId = req.cookies.qp_guest;
  if (!guestId) {
    guestId = uuidv4();
    res.cookie('qp_guest', guestId, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
  }
  req.guestId = guestId;
  req.guestIp = req.ip || req.connection?.remoteAddress || '0.0.0.0';
  next();
}

app.use(guestIdentity);

async function resolveVenue(req, res, next) {
  try {
    const slug = req.params.venueSlug;
    if (!slug) return res.status(400).json({ error: 'Venue slug required' });

    const venue = await db.getVenueBySlug(slug);
    if (!venue) return res.status(404).json({ error: 'Venue not found' });

    req.venue = venue;
    next();
  } catch (error) {
    console.error('[Resolve Venue Error]', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Admin sessions: signed, httpOnly cookie per venue ("qp_admin_<slug>"), valid 30 days.
// The x-admin-key header still works for scripted/API access.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sessionCookieName(slug) {
  return `qp_admin_${slug}`;
}

function signSession(venueId) {
  const exp = (Date.now() + SESSION_TTL_MS).toString(36);
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(`session.${venueId}.${exp}`).digest('hex');
  return `${exp}.${sig}`;
}

function verifySession(token, venueId) {
  const [exp, sig] = (token || '').split('.');
  if (!exp || !sig) return false;
  const expected = crypto.createHmac('sha256', STATE_SECRET).update(`session.${venueId}.${exp}`).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Date.now() < parseInt(exp, 36);
}

function setAdminSession(res, venue) {
  res.cookie(sessionCookieName(venue.slug), signSession(venue.id), {
    maxAge: SESSION_TTL_MS,
    httpOnly: true,
    sameSite: 'lax',
    secure: BASE_URL.startsWith('https://'),
    path: '/'
  });
}

function isVenueAdmin(req) {
  if (!req.venue) return false;
  const headerKey = req.headers['x-admin-key'];
  if (headerKey && headerKey === req.venue.admin_key) return true;
  return verifySession(req.cookies[sessionCookieName(req.venue.slug)], req.venue.id);
}

function venueAdminAuth(req, res, next) {
  if (!req.venue) return res.status(400).json({ error: 'Venue not resolved' });
  if (!isVenueAdmin(req)) return res.status(401).json({ error: 'Please log in again' });
  next();
}

function superAdminAuth(req, res, next) {
  const key = req.headers['x-super-key'];
  if (key !== process.env.SUPER_ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Returns a valid OAuth access token for the venue's connected Spotify account, refreshing if needed.
async function getVenueSpotifyToken(venue) {
  if (!venue.spotify_connected || !venue.spotify_refresh_token) return null;
  const expiresAt = new Date(venue.spotify_token_expires_at).getTime();
  if (venue.spotify_access_token && Date.now() < expiresAt - 60 * 1000) {
    return venue.spotify_access_token;
  }
  const tokens = await spotify.refreshToken(venue.spotify_refresh_token);
  await db.updateVenueSpotifyTokens(venue.id, tokens);
  venue.spotify_access_token = tokens.access_token;
  venue.spotify_refresh_token = tokens.refresh_token;
  venue.spotify_token_expires_at = tokens.expires_at;
  return tokens.access_token;
}

const NOT_CONNECTED_MSG = "This venue hasn't connected Spotify yet. Ask the staff to connect it in the admin dashboard.";

// Venue setting wins (0 = no cooldown); fall back to the plan default when unset.
function cooldownMinutes(venue, plan) {
  return venue.rate_limit_minutes ?? plan.rate_limit_minutes;
}

function clampInt(value, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(n, min), max);
}

const venueClients = new Map();
const venuePlayers = new Map();

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function nowPlayingKey(np) {
  if (!np) return '';
  const started = np.started_at instanceof Date ? np.started_at.toISOString() : String(np.started_at);
  return `${np.song_id}|${started}`;
}

// Serialize advances per venue so concurrent "next" requests can't skip several songs.
const advanceLocks = new Map();
function withVenueLock(venueId, fn) {
  const prev = advanceLocks.get(venueId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  advanceLocks.set(venueId, run);
  run.finally(() => { if (advanceLocks.get(venueId) === run) advanceLocks.delete(venueId); });
  return run;
}

// Moves to the next queued song and broadcasts the now_playing row (with started_at).
async function advanceVenue(venueId) {
  const next = await db.playNext(venueId);
  if (!next) await db.clearNowPlaying(venueId);
  const nowPlaying = next ? await db.getNowPlaying(venueId) : null;
  broadcastToVenue(venueId, 'now_playing', nowPlaying);
  broadcastToVenue(venueId, 'queue_updated', { queue: await db.getQueue(venueId) });
  return nowPlaying;
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const venueParam = url.searchParams.get('venue');
  if (!venueParam) { ws.close(); return; }

  let venueId;
  let venue;
  try {
    venue = (await db.getVenueById(venueParam)) || (await db.getVenueBySlug(venueParam));
    if (!venue) { ws.close(); return; }
    venueId = venue.id;
  } catch (error) {
    console.error('[WS Resolve Error]', error.message);
    ws.close();
    return;
  }

  // Only one player tab per venue: each player is a separate Spotify device on the same
  // account, and two of them fight over playback (music stops and starts).
  if (url.searchParams.get('role') === 'player') {
    const cookies = parseCookies(req.headers.cookie);
    if (!verifySession(cookies[sessionCookieName(venue.slug)], venue.id)) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    const previous = venuePlayers.get(venueId);
    if (previous && previous !== ws && previous.readyState === WebSocket.OPEN) {
      previous.send(JSON.stringify({ type: 'player_replaced' }));
      previous.close(4000, 'Replaced by another player');
    }
    venuePlayers.set(venueId, ws);
    ws.on('close', () => {
      if (venuePlayers.get(venueId) === ws) venuePlayers.delete(venueId);
    });
  }

  if (!venueClients.has(venueId)) venueClients.set(venueId, new Set());
  venueClients.get(venueId).add(ws);

  try {
    const [queue, nowPlaying] = await Promise.all([
      db.getQueue(venueId),
      db.getNowPlaying(venueId)
    ]);

    ws.send(JSON.stringify({ type: 'init', queue, nowPlaying }));
  } catch (error) {
    console.error('[WS Init Error]', error.message);
  }

  ws.on('close', () => {
    const clients = venueClients.get(venueId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) venueClients.delete(venueId);
    }
  });
});

function broadcastToVenue(venueId, type, data) {
  const clients = venueClients.get(venueId);
  if (!clients) return;
  const message = JSON.stringify({ type, data });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
});

app.get('/pricing', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pricing.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'register.html'));
});

app.get('/v/:venueSlug', resolveVenue, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'guest', 'index.html'));
});

app.get('/admin/:venueSlug', resolveVenue, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

app.get('/player/:venueSlug', resolveVenue, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'player', 'index.html'));
});

app.get('/superadmin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'superadmin', 'index.html'));
});

app.get('/api/venue/:venueSlug', resolveVenue, (req, res) => {
  const v = req.venue;
  res.json({
    id: v.id,
    slug: v.slug,
    name: v.name,
    type: v.type,
    logo_url: v.logo_url,
    brand_primary: v.brand_primary,
    brand_secondary: v.brand_secondary,
    brand_accent: v.brand_accent,
    brand_bg_dark: v.brand_bg_dark,
    brand_bg_card: v.brand_bg_card,
    brand_text: v.brand_text,
    brand_text_secondary: v.brand_text_secondary,
    brand_radius: v.brand_radius,
    brand_font: v.brand_font,
    welcome_message: v.welcome_message,
    page_title: v.page_title,
    custom_css: v.custom_css,
    rate_limit_minutes: v.rate_limit_minutes,
    songs_per_guest: v.songs_per_guest,
    show_queue_position: v.show_queue_position,
    show_album_art: v.show_album_art,
    spotify_connected: v.spotify_connected,
    plan_id: v.plan_id
  });
});

app.get('/api/venue/:venueSlug/search', resolveVenue, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length === 0) return res.status(400).json({ error: 'Search query required' });

    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
      return res.status(503).json({ error: 'Spotify API not configured' });
    }

    const userToken = await getVenueSpotifyToken(req.venue).catch(e => {
      console.error('[Spotify Refresh Error]', e.message);
      return null;
    });
    let results;
    try {
      results = await spotify.search(q, 10, userToken);
    } catch (error) {
      if (error.status === 403 && !userToken) return res.status(503).json({ error: NOT_CONNECTED_MSG });
      throw error;
    }

    if (!req.venue.allow_explicit) {
      results = results.filter(r => !r.explicit);
    }

    res.json({ results });
  } catch (error) {
    console.error('[Search Error]', error.message);
    res.status(502).json({ error: 'Search is unavailable right now. Please try again.' });
  }
});

app.get('/api/venue/:venueSlug/queue', resolveVenue, async (req, res) => {
  try {
    const queue = await db.getQueue(req.venue.id);
    res.json({ queue });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

app.post('/api/venue/:venueSlug/queue', resolveVenue, async (req, res) => {
  try {
    const { songId, guestName } = req.body;
    if (!songId) return res.status(400).json({ error: 'Song ID required' });

    const venue = req.venue;
    const plan = await db.getPlan(venue.plan_id);

    await db.createOrUpdateGuestSession(venue.id, req.guestId, req.guestIp);

    const rateCheck = await db.canGuestRequest(venue.id, req.guestId, cooldownMinutes(venue, plan));
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        timeRemaining: rateCheck.timeRemaining,
        message: `Please wait ${Math.ceil(rateCheck.timeRemaining / 60)} minute(s) before adding another song`
      });
    }

    const songsToday = await db.getGuestSongsToday(venue.id, req.guestId);
    const maxPerDay = Math.min(venue.songs_per_guest || plan.max_songs_per_day, plan.max_songs_per_day);
    if (songsToday >= maxPerDay) {
      return res.status(429).json({
        error: 'Daily limit reached',
        message: `You have reached your daily song limit`
      });
    }

    const userToken = await getVenueSpotifyToken(venue).catch(() => null);
    let song;
    try {
      song = await spotify.getTrack(songId, userToken);
    } catch (error) {
      if (error.status === 403 && !userToken) return res.status(503).json({ error: NOT_CONNECTED_MSG });
      throw error;
    }
    song.addedBy = req.guestId;
    song.guestName = guestName || '';

    const result = await db.addToQueue(venue.id, song);

    await db.updateGuestLastRequest(venue.id, req.guestId);

    const queue = await db.getQueue(venue.id);
    broadcastToVenue(venue.id, 'queue_updated', { queue });

    if (venue.auto_play && venue.spotify_connected) {
      await withVenueLock(venue.id, async () => {
        if (!(await db.getNowPlaying(venue.id))) await advanceVenue(venue.id);
      });
    }

    res.json({
      success: true,
      position: result.position,
      nextRequestIn: (cooldownMinutes(venue, plan)) * 60
    });
  } catch (error) {
    console.error('[Queue Add Error]', error.message);
    const code = error.message.includes('already in the queue') || error.message.includes('full') ? 409 : 500;
    res.status(code).json({ error: code === 409 ? error.message : 'Could not add that song. Please try again.' });
  }
});

app.delete('/api/venue/:venueSlug/queue/:id', resolveVenue, venueAdminAuth, async (req, res) => {
  try {
    const success = await db.removeFromQueue(req.venue.id, parseInt(req.params.id));
    if (success) {
      const queue = await db.getQueue(req.venue.id);
      broadcastToVenue(req.venue.id, 'queue_updated', { queue });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Queue item not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove from queue' });
  }
});

app.get('/api/venue/:venueSlug/now-playing', resolveVenue, async (req, res) => {
  const nowPlaying = await db.getNowPlaying(req.venue.id);
  res.json({ nowPlaying });
});

// Body { current } (optional): the now-playing key the caller believes is current.
// If it no longer matches, someone else already advanced, so we don't skip again.
app.post('/api/venue/:venueSlug/play-next', resolveVenue, venueAdminAuth, async (req, res) => {
  const venueId = req.venue.id;
  const expected = req.body && typeof req.body.current === 'string' ? req.body.current : null;
  try {
    const result = await withVenueLock(venueId, async () => {
      if (expected !== null) {
        const current = await db.getNowPlaying(venueId);
        if (nowPlayingKey(current) !== expected) return { advanced: false, nowPlaying: current };
      }
      return { advanced: true, nowPlaying: await advanceVenue(venueId) };
    });
    res.json({
      success: true,
      advanced: result.advanced,
      nowPlaying: result.nowPlaying,
      ...(result.nowPlaying ? {} : { message: 'Queue is empty' })
    });
  } catch (error) {
    console.error('[Play Next Error]', error.message);
    res.status(500).json({ error: 'Failed to play next' });
  }
});

app.get('/api/venue/:venueSlug/rate-limit', resolveVenue, async (req, res) => {
  try {
    const plan = await db.getPlan(req.venue.plan_id);
    const rateCheck = await db.canGuestRequest(req.venue.id, req.guestId, cooldownMinutes(req.venue, plan));
    res.json({ ...rateCheck, rateLimitMinutes: cooldownMinutes(req.venue, plan) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check rate limit' });
  }
});

app.post('/api/venue/:venueSlug/admin/login', resolveVenue, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!verifyPassword(password, req.venue.admin_password_hash)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  if (!req.venue.admin_password_hash.startsWith('scrypt$')) {
    db.updateVenuePasswordHash(req.venue.id, hashPassword(password)).catch(e => console.error('[Rehash Error]', e.message));
  }
  setAdminSession(res, req.venue);
  res.json({ success: true, venue: { id: req.venue.id, slug: req.venue.slug, name: req.venue.name } });
});

app.post('/api/venue/:venueSlug/admin/logout', resolveVenue, (req, res) => {
  res.clearCookie(sessionCookieName(req.venue.slug), { path: '/' });
  res.json({ success: true });
});

app.get('/api/venue/:venueSlug/admin/session', resolveVenue, (req, res) => {
  res.json({ authenticated: isVenueAdmin(req) });
});

app.get('/api/venue/:venueSlug/admin/stats', resolveVenue, venueAdminAuth, async (req, res) => {
  const stats = await db.getVenueStats(req.venue.id);
  res.json(stats);
});

app.get('/api/venue/:venueSlug/admin/history', resolveVenue, venueAdminAuth, async (req, res) => {
  const history = await db.getHistory(req.venue.id, parseInt(req.query.limit) || 50);
  res.json({ history });
});

app.put('/api/venue/:venueSlug/admin/branding', resolveVenue, venueAdminAuth, async (req, res) => {
  const plan = await db.getPlan(req.venue.plan_id);
  if (!plan.custom_branding && req.venue.plan_id !== 'free') {
    return res.status(403).json({ error: 'Custom branding requires Starter plan or above' });
  }
  await db.updateVenueBranding(req.venue.id, req.body);
  res.json({ success: true });
});

app.put('/api/venue/:venueSlug/admin/config', resolveVenue, venueAdminAuth, async (req, res) => {
  try {
    const plan = await db.getPlan(req.venue.plan_id);
    const b = req.body || {};
    const config = {
      rate_limit_minutes: clampInt(b.rate_limit_minutes, 0, 120),
      songs_per_guest: clampInt(b.songs_per_guest, 1, plan.max_songs_per_day),
      max_queue_size: clampInt(b.max_queue_size, 1, 200),
      allow_explicit: b.allow_explicit === undefined ? undefined : (Number(b.allow_explicit) ? 1 : 0),
      auto_play: b.auto_play === undefined ? undefined : (Number(b.auto_play) ? 1 : 0)
    };
    await db.updateVenueConfig(req.venue.id, config);
    res.json({ success: true, config });
  } catch (error) {
    console.error('[Config Error]', error.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

app.post('/api/venue/:venueSlug/admin/clear-queue', resolveVenue, venueAdminAuth, async (req, res) => {
  await db.clearQueue(req.venue.id);
  await db.clearNowPlaying(req.venue.id);
  broadcastToVenue(req.venue.id, 'queue_updated', { queue: [] });
  broadcastToVenue(req.venue.id, 'now_playing', null);
  res.json({ success: true });
});

app.post('/api/venue/:venueSlug/admin/reset-limits', resolveVenue, venueAdminAuth, async (req, res) => {
  await db.resetGuestLimits(req.venue.id);
  res.json({ success: true });
});

app.get('/api/venue/:venueSlug/qr', resolveVenue, async (req, res) => {
  try {
    const url = `${BASE_URL}/v/${req.venue.slug}`;
    const qr = await QRCode.toDataURL(url, {
      width: parseInt(req.query.size) || 400,
      margin: 2,
      color: { dark: req.venue.brand_primary || '#8b5cf6', light: '#ffffff' }
    });
    res.json({ qr, url });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

app.get('/api/venue/:venueSlug/admin/full', resolveVenue, venueAdminAuth, async (req, res) => {
  const v = req.venue;
  const { spotify_access_token, spotify_refresh_token, admin_password_hash, ...safe } = v;
  const plan = await db.getPlan(v.plan_id);
  res.json({ venue: safe, plan });
});

app.get('/auth/spotify/connect/:venueSlug', resolveVenue, (req, res) => {
  if (!isVenueAdmin(req)) return res.redirect(`/admin/${req.venue.slug}`);
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    return res.send(`
      <div style="font-family: sans-serif; max-width: 500px; margin: 5rem auto; padding: 2rem; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); background-color: #121212; color: #fff;">
        <h2 style="color: #f43f5e; margin-bottom: 1rem;">QueuePlay Spotify Credentials Not Configured</h2>
        <p style="color: #bfbfbf; line-height: 1.5;">The QueuePlay platform owner has not configured Spotify credentials yet.</p>
        <p style="color: #bfbfbf; line-height: 1.5;">These are QueuePlay's own Developer App credentials — venues just click "Connect" using their personal Spotify account.</p>
        <p style="color: #bfbfbf;"><strong>To fix this (platform owner):</strong></p>
        <ol style="color: #bfbfbf; padding-left: 1.25rem; line-height: 1.8;">
          <li>Go to <a href="https://developer.spotify.com/dashboard" target="_blank" style="color: #a78bfa; text-decoration: underline;">Spotify Developer Dashboard</a></li>
          <li>Create an app (or use an existing one) named "QueuePlay"</li>
          <li>Add this Redirect URI: <br><code style="background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; font-family: monospace; display: inline-block; margin: 4px 0;">${BASE_URL}/auth/spotify/callback</code></li>
          <li>Set <code>SPOTIFY_CLIENT_ID</code> and <code>SPOTIFY_CLIENT_SECRET</code> in Railway environment variables</li>
        </ol>
        <a href="/admin/${req.venue.slug}" style="display: inline-block; margin-top: 1.5rem; padding: 0.6rem 1.25rem; background: #8b5cf6; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">Back to Dashboard</a>
      </div>
    `);
  }
  if (req.query.return === 'player') {
    res.cookie('qp_oauth_return', 'player', { maxAge: 15 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
  } else {
    res.clearCookie('qp_oauth_return');
  }
  const authUrl = spotify.getAuthUrl(signState(req.venue.id));
  res.redirect(authUrl);
});

app.get('/auth/spotify/callback', async (req, res) => {
  try {
    const { code, state, error: authError } = req.query;
    if (authError) return res.redirect('/?spotify=denied');
    const venueId = verifyState(state);
    if (!code || !venueId) return res.status(400).send('Invalid or expired Spotify authorization. Please try connecting again from your dashboard.');

    const tokens = await spotify.exchangeCode(code);
    await db.updateVenueSpotifyTokens(venueId, tokens);

    const venue = await db.getVenueById(venueId);

    if (venue && venue.auto_play) {
      await withVenueLock(venue.id, async () => {
        if (!(await db.getNowPlaying(venue.id))) await advanceVenue(venue.id);
      });
    }

    const slug = venue ? venue.slug : '';
    const backToPlayer = req.cookies.qp_oauth_return === 'player';
    res.clearCookie('qp_oauth_return');
    res.redirect(backToPlayer ? `/player/${slug}` : `/admin/${slug}?spotify=connected`);
  } catch (error) {
    console.error('[Spotify OAuth Error]', error.message);
    res.status(500).send(`Spotify connection failed: ${error.message.replace(/[<>&]/g, '')}. Please try again from your dashboard.`);
  }
});

app.get('/api/venue/:venueSlug/spotify-token', resolveVenue, venueAdminAuth, async (req, res) => {
  try {
    const venue = req.venue;
    if (!venue.spotify_connected) {
      return res.status(400).json({ error: 'Spotify not connected' });
    }

    res.json({ token: await getVenueSpotifyToken(venue) });
  } catch (error) {
    console.error('[Spotify Token Error]', error.message);
    res.status(500).json({ error: 'Failed to get Spotify token. Try reconnecting Spotify in the admin dashboard.' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, type, email, password, slug } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const desiredSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!desiredSlug) return res.status(400).json({ error: 'Please choose a venue name with letters or numbers' });
    const existing = await db.slugExists(desiredSlug);
    if (existing) return res.status(409).json({ error: 'This URL is already taken. Try a different name or custom URL.' });

    const result = await db.createVenue({
      name,
      type: type || 'cafe',
      email,
      slug: desiredSlug,
      password_hash: hashPassword(password)
    });

    setAdminSession(res, { id: result.id, slug: result.slug });
    res.json({
      success: true,
      venue: {
        id: result.id,
        slug: result.slug,
        guestUrl: `${BASE_URL}/v/${result.slug}`,
        adminUrl: `${BASE_URL}/admin/${result.slug}`,
        playerUrl: `${BASE_URL}/player/${result.slug}`
      }
    });
  } catch (error) {
    console.error('[Register Error]', error.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.get('/api/plans', async (req, res) => {
  const plans = await db.getAllPlans();
  res.json({ plans });
});

app.get('/api/superadmin/stats', superAdminAuth, async (req, res) => {
  const stats = await db.getPlatformStats();
  res.json(stats);
});

app.get('/api/superadmin/venues', superAdminAuth, async (req, res) => {
  const venues = await db.getAllVenues();
  res.json({ venues });
});

app.put('/api/superadmin/venues/:id/plan', superAdminAuth, async (req, res) => {
  const { planId } = req.body;
  await db.updateVenuePlan(req.params.id, planId);
  res.json({ success: true });
});

app.delete('/api/superadmin/venues/:id', superAdminAuth, async (req, res) => {
  await db.deleteVenue(req.params.id);
  res.json({ success: true });
});

app.get('/api/health', async (req, res) => {
  let database = 'ok';
  try {
    await db.pool.query('SELECT 1');
  } catch (error) {
    database = 'error';
  }
  res.status(database === 'ok' ? 200 : 503).json({
    status: database === 'ok' ? 'ok' : 'degraded',
    version: '2.1.0',
    database,
    spotify: !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET)
  });
});

async function start() {
  try {
    await db.initializeSchema();

    server.listen(PORT, () => {
      console.log('');
      console.log('  ╔══════════════════════════════════════╗');
      console.log('  ║        QUEUEPLAY SERVER v2.0         ║');
      console.log('  ║         (PostgreSQL Edition)          ║');
      console.log('  ╠══════════════════════════════════════╣');
      console.log(`  ║  Server:   ${BASE_URL.padEnd(25)}║`);
      console.log(`  ║  Database: PostgreSQL                ║`);
      console.log(`  ║  Spotify:  ${process.env.SPOTIFY_CLIENT_ID ? 'Connected'.padEnd(25) : 'Not configured'.padEnd(25)}║`);
      console.log('  ╚══════════════════════════════════════╝');
      console.log('');
    });
  } catch (err) {
    console.error('[FATAL] Failed to initialize database:', err.message);
    process.exit(1);
  }
}

start();

async function shutdown(signal) {
  console.log(`\n  ${signal} received, shutting down...`);
  wss.clients.forEach(client => client.terminate());
  server.close(async () => {
    await db.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
