// ============================================
// QUEUEPLAY - MAIN SERVER
// ============================================

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

// ============================================
// CONFIGURATION
// ============================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const db = new QueuePlayDB(process.env.DATABASE_PATH || './database/queueplay.db');
const spotify = new SpotifyService(
  process.env.SPOTIFY_CLIENT_ID,
  process.env.SPOTIFY_CLIENT_SECRET,
  `${BASE_URL}/auth/spotify/callback`
);

// Simple password hashing (use bcrypt in production)
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + (process.env.SALT || 'queueplay-salt')).digest('hex');
}

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));

// Guest identification middleware
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

// Venue resolution middleware - extracts venue from URL
function resolveVenue(req, res, next) {
  const slug = req.params.venueSlug;
  if (!slug) return res.status(400).json({ error: 'Venue slug required' });

  const venue = db.getVenueBySlug(slug);
  if (!venue) return res.status(404).json({ error: 'Venue not found' });

  req.venue = venue;
  next();
}

// Venue admin auth
function venueAdminAuth(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  if (!req.venue) return res.status(400).json({ error: 'Venue not resolved' });
  if (adminKey !== req.venue.admin_key) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Super admin auth
function superAdminAuth(req, res, next) {
  const key = req.headers['x-super-key'];
  if (key !== process.env.SUPER_ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ============================================
// WEBSOCKET - VENUE-SCOPED REAL-TIME
// ============================================

const venueClients = new Map(); // venueId -> Set<ws>

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const venueId = url.searchParams.get('venue');

  if (!venueId) { ws.close(); return; }

  if (!venueClients.has(venueId)) venueClients.set(venueId, new Set());
  venueClients.get(venueId).add(ws);

  // Send current state
  ws.send(JSON.stringify({
    type: 'init',
    queue: db.getQueue(venueId),
    nowPlaying: db.getNowPlaying(venueId)
  }));

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

// ============================================
// PAGE ROUTES
// ============================================

// Landing / marketing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
});

// Pricing page
app.get('/pricing', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pricing.html'));
});

// Venue registration
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'register.html'));
});

// Guest page (public - customers scan QR and land here)
app.get('/v/:venueSlug', resolveVenue, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'guest', 'index.html'));
});

// Venue admin dashboard
app.get('/admin/:venueSlug', resolveVenue, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

// Venue player (bar speaker device)
app.get('/player/:venueSlug', resolveVenue, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'player', 'index.html'));
});

// Super admin panel
app.get('/superadmin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'superadmin', 'index.html'));
});

// ============================================
// API: VENUE DATA (public - for page rendering)
// ============================================

app.get('/api/venue/:venueSlug', resolveVenue, (req, res) => {
  const v = req.venue;
  // Public-safe venue data (no tokens, no admin keys)
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

// ============================================
// API: SEARCH (venue-scoped)
// ============================================

app.get('/api/venue/:venueSlug/search', resolveVenue, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length === 0) return res.status(400).json({ error: 'Search query required' });

    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
      return res.status(503).json({ error: 'Spotify API not configured' });
    }

    let results = await spotify.search(q);

    // Filter explicit content if venue disallows it
    if (!req.venue.allow_explicit) {
      results = results.filter(r => !r.explicit);
    }

    res.json({ results });
  } catch (error) {
    console.error('[Search Error]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// API: QUEUE (venue-scoped)
// ============================================

app.get('/api/venue/:venueSlug/queue', resolveVenue, (req, res) => {
  try {
    res.json({ queue: db.getQueue(req.venue.id) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

app.post('/api/venue/:venueSlug/queue', resolveVenue, async (req, res) => {
  try {
    const { songId, guestName } = req.body;
    if (!songId) return res.status(400).json({ error: 'Song ID required' });

    const venue = req.venue;
    const plan = db.getPlan(venue.plan_id);

    // Ensure guest session exists
    db.createOrUpdateGuestSession(venue.id, req.guestId, req.guestIp);

    // Check rate limit
    const rateCheck = db.canGuestRequest(venue.id, req.guestId, venue.rate_limit_minutes || plan.rate_limit_minutes);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        timeRemaining: rateCheck.timeRemaining,
        message: `Please wait ${Math.ceil(rateCheck.timeRemaining / 60)} minute(s) before adding another song`
      });
    }

    // Check daily limit
    const songsToday = db.getGuestSongsToday(venue.id, req.guestId);
    const maxPerDay = plan.max_songs_per_day;
    if (songsToday >= (venue.songs_per_guest || maxPerDay)) {
      return res.status(429).json({
        error: 'Daily limit reached',
        message: `You have reached your daily song limit`
      });
    }

    // Fetch song details
    const song = await spotify.getTrack(songId);
    song.addedBy = req.guestId;
    song.guestName = guestName || '';

    // Add to queue
    const result = db.addToQueue(venue.id, song);

    // Update rate limit
    db.updateGuestLastRequest(venue.id, req.guestId);

    // Broadcast
    broadcastToVenue(venue.id, 'queue_updated', { queue: db.getQueue(venue.id) });

    // Auto-play if nothing playing
    if (venue.auto_play && !db.getNowPlaying(venue.id)) {
      const nextSong = db.playNext(venue.id);
      if (nextSong) {
        broadcastToVenue(venue.id, 'now_playing', nextSong);
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

app.delete('/api/venue/:venueSlug/queue/:id', resolveVenue, venueAdminAuth, (req, res) => {
  try {
    const success = db.removeFromQueue(req.venue.id, parseInt(req.params.id));
    if (success) {
      broadcastToVenue(req.venue.id, 'queue_updated', { queue: db.getQueue(req.venue.id) });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Queue item not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove from queue' });
  }
});

// ============================================
// API: PLAYBACK (venue-scoped)
// ============================================

app.get('/api/venue/:venueSlug/now-playing', resolveVenue, (req, res) => {
  res.json({ nowPlaying: db.getNowPlaying(req.venue.id) });
});

app.post('/api/venue/:venueSlug/play-next', resolveVenue, venueAdminAuth, (req, res) => {
  try {
    const nextSong = db.playNext(req.venue.id);
    if (nextSong) {
      broadcastToVenue(req.venue.id, 'now_playing', nextSong);
      broadcastToVenue(req.venue.id, 'queue_updated', { queue: db.getQueue(req.venue.id) });
      res.json({ success: true, nowPlaying: nextSong });
    } else {
      db.clearNowPlaying(req.venue.id);
      broadcastToVenue(req.venue.id, 'now_playing', null);
      res.json({ success: true, nowPlaying: null, message: 'Queue is empty' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to play next' });
  }
});

app.get('/api/venue/:venueSlug/rate-limit', resolveVenue, (req, res) => {
  try {
    const plan = db.getPlan(req.venue.plan_id);
    const rateCheck = db.canGuestRequest(req.venue.id, req.guestId, req.venue.rate_limit_minutes || plan.rate_limit_minutes);
    res.json({ ...rateCheck, rateLimitMinutes: req.venue.rate_limit_minutes || plan.rate_limit_minutes });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check rate limit' });
  }
});

// ============================================
// API: VENUE ADMIN
// ============================================

app.post('/api/venue/:venueSlug/admin/login', resolveVenue, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (hashPassword(password) !== req.venue.admin_password_hash) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ success: true, adminKey: req.venue.admin_key, venue: { id: req.venue.id, slug: req.venue.slug, name: req.venue.name } });
});

app.get('/api/venue/:venueSlug/admin/stats', resolveVenue, venueAdminAuth, (req, res) => {
  res.json(db.getVenueStats(req.venue.id));
});

app.get('/api/venue/:venueSlug/admin/history', resolveVenue, venueAdminAuth, (req, res) => {
  res.json({ history: db.getHistory(req.venue.id, parseInt(req.query.limit) || 50) });
});

app.put('/api/venue/:venueSlug/admin/branding', resolveVenue, venueAdminAuth, (req, res) => {
  const plan = db.getPlan(req.venue.plan_id);
  if (!plan.custom_branding && req.venue.plan_id !== 'free') {
    return res.status(403).json({ error: 'Custom branding requires Starter plan or above' });
  }
  db.updateVenueBranding(req.venue.id, req.body);
  res.json({ success: true });
});

app.put('/api/venue/:venueSlug/admin/config', resolveVenue, venueAdminAuth, (req, res) => {
  db.updateVenueConfig(req.venue.id, req.body);
  res.json({ success: true });
});

app.post('/api/venue/:venueSlug/admin/clear-queue', resolveVenue, venueAdminAuth, (req, res) => {
  db.clearQueue(req.venue.id);
  db.clearNowPlaying(req.venue.id);
  broadcastToVenue(req.venue.id, 'queue_updated', { queue: [] });
  broadcastToVenue(req.venue.id, 'now_playing', null);
  res.json({ success: true });
});

app.post('/api/venue/:venueSlug/admin/reset-limits', resolveVenue, venueAdminAuth, (req, res) => {
  db.resetGuestLimits(req.venue.id);
  res.json({ success: true });
});

// QR Code generation
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

// Full venue data for admin
app.get('/api/venue/:venueSlug/admin/full', resolveVenue, venueAdminAuth, (req, res) => {
  const v = req.venue;
  // Exclude sensitive tokens
  const { spotify_access_token, spotify_refresh_token, admin_password_hash, ...safe } = v;
  const plan = db.getPlan(v.plan_id);
  res.json({ venue: safe, plan });
});

// ============================================
// API: SPOTIFY OAUTH (venue connects their account)
// ============================================

app.get('/auth/spotify/connect/:venueSlug', resolveVenue, (req, res) => {
  const authUrl = spotify.getAuthUrl(req.venue.id);
  res.redirect(authUrl);
});

app.get('/auth/spotify/callback', async (req, res) => {
  try {
    const { code, state: venueId } = req.query;
    if (!code || !venueId) return res.status(400).send('Missing auth code');

    const tokens = await spotify.exchangeCode(code);
    db.updateVenueSpotifyTokens(venueId, tokens);

    const venue = db.getVenueById(venueId);
    res.redirect(`/admin/${venue.slug}?spotify=connected`);
  } catch (error) {
    console.error('[Spotify OAuth Error]', error.message);
    res.status(500).send('Spotify connection failed. Please try again.');
  }
});

// Get Spotify token for Web Playback SDK (admin only)
app.get('/api/venue/:venueSlug/spotify-token', resolveVenue, venueAdminAuth, async (req, res) => {
  try {
    const venue = req.venue;
    if (!venue.spotify_connected) {
      return res.status(400).json({ error: 'Spotify not connected' });
    }

    // Refresh if expired
    const expiresAt = new Date(venue.spotify_token_expires_at);
    if (Date.now() >= expiresAt.getTime()) {
      const tokens = await spotify.refreshToken(venue.spotify_refresh_token);
      db.updateVenueSpotifyTokens(venue.id, tokens);
      return res.json({ token: tokens.access_token });
    }

    res.json({ token: venue.spotify_access_token });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get Spotify token' });
  }
});

// ============================================
// API: VENUE REGISTRATION
// ============================================

app.post('/api/register', (req, res) => {
  try {
    const { name, type, email, password, slug } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'Name and password required' });

    // Check slug uniqueness
    const desiredSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const existing = db.getVenueBySlug(desiredSlug);
    if (existing) return res.status(409).json({ error: 'This URL is already taken. Try a different name or custom URL.' });

    const result = db.createVenue({
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

// ============================================
// API: SUBSCRIPTION PLANS
// ============================================

app.get('/api/plans', (req, res) => {
  const plans = db.getAllPlans();
  res.json({ plans: plans.map(p => ({ ...p, features: JSON.parse(p.features_json || '[]') })) });
});

// ============================================
// API: SUPER ADMIN
// ============================================

app.get('/api/superadmin/stats', superAdminAuth, (req, res) => {
  res.json(db.getPlatformStats());
});

app.get('/api/superadmin/venues', superAdminAuth, (req, res) => {
  res.json({ venues: db.getAllVenues() });
});

app.put('/api/superadmin/venues/:id/plan', superAdminAuth, (req, res) => {
  const { planId } = req.body;
  db.updateVenuePlan(req.params.id, planId);
  res.json({ success: true });
});

app.delete('/api/superadmin/venues/:id', superAdminAuth, (req, res) => {
  db.deleteVenue(req.params.id);
  res.json({ success: true });
});

// ============================================
// HEALTH CHECK
// ============================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    spotify: !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET)
  });
});

// ============================================
// START SERVER
// ============================================

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║        QUEUEPLAY SERVER v2.0         ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║  Server:   ${BASE_URL.padEnd(25)}║`);
  console.log(`  ║  Spotify:  ${process.env.SPOTIFY_CLIENT_ID ? 'Connected'.padEnd(25) : 'Not configured'.padEnd(25)}║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  db.close();
  server.close(() => process.exit(0));
});

module.exports = app;
