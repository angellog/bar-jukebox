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

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + (process.env.SALT || 'queueplay-salt')).digest('hex');
}

app.use(cors());
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

function venueAdminAuth(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  if (!req.venue) return res.status(400).json({ error: 'Venue not resolved' });
  if (adminKey !== req.venue.admin_key) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function superAdminAuth(req, res, next) {
  const key = req.headers['x-super-key'];
  if (key !== process.env.SUPER_ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const venueClients = new Map();

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const venueId = url.searchParams.get('venue');

  if (!venueId) { ws.close(); return; }

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

    let results = await spotify.search(q);

    if (!req.venue.allow_explicit) {
      results = results.filter(r => !r.explicit);
    }

    res.json({ results });
  } catch (error) {
    console.error('[Search Error]', error.message);
    res.status(500).json({ error: error.message });
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

    const rateCheck = await db.canGuestRequest(venue.id, req.guestId, venue.rate_limit_minutes || plan.rate_limit_minutes);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        timeRemaining: rateCheck.timeRemaining,
        message: `Please wait ${Math.ceil(rateCheck.timeRemaining / 60)} minute(s) before adding another song`
      });
    }

    const songsToday = await db.getGuestSongsToday(venue.id, req.guestId);
    const maxPerDay = plan.max_songs_per_day;
    if (songsToday >= (venue.songs_per_guest || maxPerDay)) {
      return res.status(429).json({
        error: 'Daily limit reached',
        message: `You have reached your daily song limit`
      });
    }

    const song = await spotify.getTrack(songId);
    song.addedBy = req.guestId;
    song.guestName = guestName || '';

    const result = await db.addToQueue(venue.id, song);

    await db.updateGuestLastRequest(venue.id, req.guestId);

    const queue = await db.getQueue(venue.id);
    broadcastToVenue(venue.id, 'queue_updated', { queue });

    if (venue.auto_play && venue.spotify_connected) {
      const current = await db.getNowPlaying(venue.id);
      if (!current) {
        const nextSong = await db.playNext(venue.id);
        if (nextSong) {
          broadcastToVenue(venue.id, 'now_playing', nextSong);
        }
      }
    }

    res.json({
      success: true,
      position: result.position,
      nextRequestIn: (venue.rate_limit_minutes || plan.rate_limit_minutes) * 60
    });
  } catch (error) {
    console.error('[Queue Add Error]', error.message);
    res.status(error.message.includes('already in the queue') || error.message.includes('full') ? 409 : 500).json({ error: error.message });
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

app.post('/api/venue/:venueSlug/play-next', resolveVenue, venueAdminAuth, async (req, res) => {
  try {
    const nextSong = await db.playNext(req.venue.id);
    if (nextSong) {
      broadcastToVenue(req.venue.id, 'now_playing', nextSong);
      const queue = await db.getQueue(req.venue.id);
      broadcastToVenue(req.venue.id, 'queue_updated', { queue });
      res.json({ success: true, nowPlaying: nextSong });
    } else {
      await db.clearNowPlaying(req.venue.id);
      broadcastToVenue(req.venue.id, 'now_playing', null);
      res.json({ success: true, nowPlaying: null, message: 'Queue is empty' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to play next' });
  }
});

app.get('/api/venue/:venueSlug/rate-limit', resolveVenue, async (req, res) => {
  try {
    const plan = await db.getPlan(req.venue.plan_id);
    const rateCheck = await db.canGuestRequest(req.venue.id, req.guestId, req.venue.rate_limit_minutes || plan.rate_limit_minutes);
    res.json({ ...rateCheck, rateLimitMinutes: req.venue.rate_limit_minutes || plan.rate_limit_minutes });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check rate limit' });
  }
});

app.post('/api/venue/:venueSlug/admin/login', resolveVenue, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (hashPassword(password) !== req.venue.admin_password_hash) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ success: true, adminKey: req.venue.admin_key, venue: { id: req.venue.id, slug: req.venue.slug, name: req.venue.name } });
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
  await db.updateVenueConfig(req.venue.id, req.body);
  res.json({ success: true });
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
  const authUrl = spotify.getAuthUrl(req.venue.id);
  res.redirect(authUrl);
});

app.get('/auth/spotify/callback', async (req, res) => {
  try {
    const { code, state: venueId } = req.query;
    if (!code || !venueId) return res.status(400).send('Missing auth code');

    const tokens = await spotify.exchangeCode(code);
    await db.updateVenueSpotifyTokens(venueId, tokens);

    const venue = await db.getVenueById(venueId);

    if (venue && venue.auto_play) {
      const current = await db.getNowPlaying(venue.id);
      if (!current) {
        const nextSong = await db.playNext(venue.id);
        if (nextSong) {
          broadcastToVenue(venue.id, 'now_playing', nextSong);
        }
      }
    }

    const slug = venue ? venue.slug : '';
    res.redirect(`/admin/${slug}?spotify=connected`);
  } catch (error) {
    console.error('[Spotify OAuth Error]', error.message);
    res.status(500).send('Spotify connection failed. Please try again.');
  }
});

app.get('/api/venue/:venueSlug/spotify-token', resolveVenue, venueAdminAuth, async (req, res) => {
  try {
    const venue = req.venue;
    if (!venue.spotify_connected) {
      return res.status(400).json({ error: 'Spotify not connected' });
    }

    const expiresAt = new Date(venue.spotify_token_expires_at);
    if (Date.now() >= expiresAt.getTime()) {
      const tokens = await spotify.refreshToken(venue.spotify_refresh_token);
      await db.updateVenueSpotifyTokens(venue.id, tokens);
      return res.json({ token: tokens.access_token });
    }

    res.json({ token: venue.spotify_access_token });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get Spotify token' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, type, email, password, slug } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'Name and password required' });

    const desiredSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const existing = await db.getVenueBySlug(desiredSlug);
    if (existing) return res.status(409).json({ error: 'This URL is already taken. Try a different name or custom URL.' });

    const result = await db.createVenue({
      name,
      type: type || 'cafe',
      email,
      slug: desiredSlug,
      password_hash: hashPassword(password)
    });

    res.json({
      success: true,
      venue: {
        id: result.id,
        slug: result.slug,
        adminKey: result.adminKey,
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

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
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

process.on('SIGINT', async () => {
  console.log('\n  Shutting down...');
  await db.close();
  server.close(() => process.exit(0));
});

module.exports = app;
