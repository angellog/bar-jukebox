// ============================================
// QUEUEPLAY - MULTI-TENANT DATABASE
// ============================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

class QueuePlayDB {
  constructor(dbPath = './database/queueplay.db') {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initializeSchema();
    this.seedSubscriptionPlans();
  }

  initializeSchema() {
    this.db.exec(`
      -- ============================================
      -- SUBSCRIPTION PLANS
      -- ============================================
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price_monthly REAL NOT NULL DEFAULT 0,
        price_yearly REAL NOT NULL DEFAULT 0,
        max_queue_size INTEGER NOT NULL DEFAULT 10,
        max_songs_per_day INTEGER NOT NULL DEFAULT 50,
        rate_limit_minutes INTEGER NOT NULL DEFAULT 5,
        custom_branding INTEGER NOT NULL DEFAULT 0,
        custom_domain INTEGER NOT NULL DEFAULT 0,
        analytics INTEGER NOT NULL DEFAULT 0,
        priority_support INTEGER NOT NULL DEFAULT 0,
        remove_watermark INTEGER NOT NULL DEFAULT 0,
        max_active_sessions INTEGER NOT NULL DEFAULT 20,
        description TEXT,
        features_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- ============================================
      -- VENUES (tenants)
      -- ============================================
      CREATE TABLE IF NOT EXISTS venues (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'cafe',
        email TEXT,
        phone TEXT,
        address TEXT,
        timezone TEXT DEFAULT 'UTC',

        -- Subscription
        plan_id TEXT NOT NULL DEFAULT 'free',
        subscription_status TEXT NOT NULL DEFAULT 'active',
        subscription_started_at DATETIME,
        subscription_expires_at DATETIME,
        stripe_customer_id TEXT,

        -- Spotify OAuth
        spotify_access_token TEXT,
        spotify_refresh_token TEXT,
        spotify_token_expires_at DATETIME,
        spotify_connected INTEGER NOT NULL DEFAULT 0,

        -- Admin auth
        admin_password_hash TEXT NOT NULL,
        admin_key TEXT NOT NULL,

        -- Branding
        logo_url TEXT,
        brand_primary TEXT DEFAULT '#8b5cf6',
        brand_secondary TEXT DEFAULT '#ec4899',
        brand_accent TEXT DEFAULT '#f43f5e',
        brand_bg_dark TEXT DEFAULT '#0d0d14',
        brand_bg_card TEXT DEFAULT 'rgba(30, 20, 60, 0.4)',
        brand_text TEXT DEFAULT '#fafafa',
        brand_text_secondary TEXT DEFAULT '#bfbfbf',
        brand_radius TEXT DEFAULT '12px',
        brand_font TEXT DEFAULT 'Outfit',
        welcome_message TEXT DEFAULT 'Search, add, and enjoy music together',
        page_title TEXT,
        custom_css TEXT,

        -- Config
        rate_limit_minutes INTEGER DEFAULT 5,
        max_queue_size INTEGER DEFAULT 20,
        songs_per_guest INTEGER DEFAULT 1,
        allow_explicit INTEGER DEFAULT 1,
        auto_play INTEGER DEFAULT 1,
        show_queue_position INTEGER DEFAULT 1,
        show_album_art INTEGER DEFAULT 1,
        genre_restrictions TEXT,
        blocked_songs TEXT,

        -- Meta
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
      );

      -- ============================================
      -- QUEUE
      -- ============================================
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venue_id TEXT NOT NULL,
        song_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        album_art TEXT,
        preview_url TEXT,
        spotify_uri TEXT,
        duration_ms INTEGER,
        added_by TEXT,
        guest_name TEXT,
        position INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );

      -- ============================================
      -- NOW PLAYING (one per venue)
      -- ============================================
      CREATE TABLE IF NOT EXISTS now_playing (
        venue_id TEXT PRIMARY KEY,
        song_id TEXT,
        title TEXT,
        artist TEXT,
        album TEXT,
        album_art TEXT,
        preview_url TEXT,
        spotify_uri TEXT,
        duration_ms INTEGER,
        started_at DATETIME,
        added_by TEXT,

        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );

      -- ============================================
      -- GUEST SESSIONS (rate limiting)
      -- ============================================
      CREATE TABLE IF NOT EXISTS guest_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venue_id TEXT NOT NULL,
        guest_id TEXT NOT NULL,
        ip_address TEXT,
        last_request_at DATETIME,
        request_count INTEGER DEFAULT 0,
        songs_today INTEGER DEFAULT 0,
        last_song_date TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

        UNIQUE(venue_id, guest_id),
        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );

      -- ============================================
      -- PLAYBACK HISTORY
      -- ============================================
      CREATE TABLE IF NOT EXISTS playback_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venue_id TEXT NOT NULL,
        song_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        added_by TEXT,

        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );

      -- ============================================
      -- SUPER ADMIN
      -- ============================================
      CREATE TABLE IF NOT EXISTS super_admins (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- ============================================
      -- INDEXES
      -- ============================================
      CREATE INDEX IF NOT EXISTS idx_venues_slug ON venues(slug);
      CREATE INDEX IF NOT EXISTS idx_queue_venue ON queue(venue_id, status, position);
      CREATE INDEX IF NOT EXISTS idx_guest_sessions_venue ON guest_sessions(venue_id, guest_id);
      CREATE INDEX IF NOT EXISTS idx_history_venue ON playback_history(venue_id, played_at);
    `);

    console.log('[DB] Schema initialized');
  }

  seedSubscriptionPlans() {
    const existing = this.db.prepare('SELECT COUNT(*) as count FROM subscription_plans').get();
    if (existing.count > 0) return;

    const insert = this.db.prepare(`
      INSERT INTO subscription_plans (id, name, price_monthly, price_yearly, max_queue_size, max_songs_per_day, rate_limit_minutes, custom_branding, custom_domain, analytics, priority_support, remove_watermark, max_active_sessions, description, features_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const plans = [
      ['free', 'Free', 0, 0, 10, 30, 10, 0, 0, 0, 0, 0, 10, 'Try QueuePlay with basic features', '["Up to 10 songs in queue","30 songs per day","10-min cooldown between requests","QueuePlay watermark","Basic support"]'],
      ['starter', 'Starter', 19.99, 199, 25, 100, 5, 1, 0, 1, 0, 1, 30, 'Perfect for small cafes and shops', '["Up to 25 songs in queue","100 songs per day","5-min cooldown","Custom colors & logo","No watermark","Basic analytics","Email support"]'],
      ['pro', 'Pro', 49.99, 499, 50, 500, 3, 1, 1, 1, 1, 1, 100, 'For busy restaurants and lounges', '["Up to 50 songs in queue","500 songs per day","3-min cooldown","Full brand customization","Custom domain support","Advanced analytics","Priority support","Genre restrictions","Song blocking"]'],
      ['enterprise', 'Enterprise', 99.99, 999, 200, 9999, 1, 1, 1, 1, 1, 1, 500, 'Multi-location chains and franchises', '["Unlimited queue size","Unlimited songs per day","1-min cooldown","Full white-label","Custom domain","Real-time analytics dashboard","Dedicated support","API access","Multi-venue management","Custom integrations"]']
    ];

    const insertMany = this.db.transaction((plans) => {
      for (const p of plans) {
        insert.run(...p);
      }
    });

    insertMany(plans);
    console.log('[DB] Subscription plans seeded');
  }

  // ============================================
  // VENUE OPERATIONS
  // ============================================

  createVenue(data) {
    const id = uuidv4();
    const slug = data.slug || data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const adminKey = uuidv4();

    this.db.prepare(`
      INSERT INTO venues (id, slug, name, type, email, phone, address, plan_id, admin_password_hash, admin_key, page_title, welcome_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, slug, data.name, data.type || 'cafe',
      data.email || null, data.phone || null, data.address || null,
      data.plan_id || 'free',
      data.password_hash,
      adminKey,
      data.name,
      data.welcome_message || 'Search, add, and enjoy music together'
    );

    return { id, slug, adminKey };
  }

  getVenueBySlug(slug) {
    return this.db.prepare('SELECT * FROM venues WHERE slug = ? AND is_active = 1').get(slug);
  }

  getVenueById(id) {
    return this.db.prepare('SELECT * FROM venues WHERE id = ?').get(id);
  }

  getAllVenues() {
    return this.db.prepare(`
      SELECT v.*, sp.name as plan_name, sp.price_monthly,
        (SELECT COUNT(*) FROM playback_history WHERE venue_id = v.id) as total_played,
        (SELECT COUNT(*) FROM guest_sessions WHERE venue_id = v.id) as total_guests
      FROM venues v
      LEFT JOIN subscription_plans sp ON v.plan_id = sp.id
      ORDER BY v.created_at DESC
    `).all();
  }

  updateVenueBranding(venueId, branding) {
    const fields = [];
    const values = [];

    const allowed = [
      'logo_url', 'brand_primary', 'brand_secondary', 'brand_accent',
      'brand_bg_dark', 'brand_bg_card', 'brand_text', 'brand_text_secondary',
      'brand_radius', 'brand_font', 'welcome_message', 'page_title', 'custom_css',
      'name', 'type'
    ];

    for (const key of allowed) {
      if (branding[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(branding[key]);
      }
    }

    if (fields.length === 0) return false;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(venueId);

    this.db.prepare(`UPDATE venues SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return true;
  }

  updateVenueConfig(venueId, config) {
    const fields = [];
    const values = [];

    const allowed = [
      'rate_limit_minutes', 'max_queue_size', 'songs_per_guest',
      'allow_explicit', 'auto_play', 'show_queue_position', 'show_album_art',
      'genre_restrictions', 'blocked_songs'
    ];

    for (const key of allowed) {
      if (config[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(config[key]);
      }
    }

    if (fields.length === 0) return false;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(venueId);

    this.db.prepare(`UPDATE venues SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return true;
  }

  updateVenuePlan(venueId, planId) {
    this.db.prepare(`
      UPDATE venues SET plan_id = ?, subscription_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(planId, venueId);
  }

  updateVenueSpotifyTokens(venueId, tokens) {
    this.db.prepare(`
      UPDATE venues SET
        spotify_access_token = ?,
        spotify_refresh_token = ?,
        spotify_token_expires_at = ?,
        spotify_connected = 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(tokens.access_token, tokens.refresh_token, tokens.expires_at, venueId);
  }

  deleteVenue(venueId) {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM queue WHERE venue_id = ?').run(venueId);
      this.db.prepare('DELETE FROM now_playing WHERE venue_id = ?').run(venueId);
      this.db.prepare('DELETE FROM guest_sessions WHERE venue_id = ?').run(venueId);
      this.db.prepare('DELETE FROM playback_history WHERE venue_id = ?').run(venueId);
      this.db.prepare('DELETE FROM venues WHERE id = ?').run(venueId);
    });
    tx();
  }

  // ============================================
  // QUEUE OPERATIONS (venue-scoped)
  // ============================================

  getQueue(venueId) {
    return this.db.prepare(`
      SELECT * FROM queue
      WHERE venue_id = ? AND status = 'pending'
      ORDER BY position ASC
    `).all(venueId);
  }

  addToQueue(venueId, song) {
    const venue = this.getVenueById(venueId);
    const plan = this.getPlan(venue.plan_id);

    // Check queue size limit
    const currentSize = this.db.prepare(
      "SELECT COUNT(*) as count FROM queue WHERE venue_id = ? AND status = 'pending'"
    ).get(venueId);

    if (currentSize.count >= (venue.max_queue_size || plan.max_queue_size)) {
      throw new Error(`Queue is full (max ${venue.max_queue_size || plan.max_queue_size} songs)`);
    }

    // Check duplicate
    const duplicate = this.db.prepare(
      "SELECT id FROM queue WHERE venue_id = ? AND song_id = ? AND status = 'pending'"
    ).get(venueId, song.id);

    if (duplicate) {
      throw new Error('This song is already in the queue');
    }

    const maxPos = this.db.prepare(
      "SELECT MAX(position) as max FROM queue WHERE venue_id = ? AND status = 'pending'"
    ).get(venueId);

    const position = (maxPos.max || 0) + 1;

    const result = this.db.prepare(`
      INSERT INTO queue (venue_id, song_id, title, artist, album, album_art, preview_url, spotify_uri, duration_ms, added_by, guest_name, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      venueId, song.id, song.title, song.artist,
      song.album || '', song.albumArt || '', song.previewUrl || '',
      song.uri || '', song.durationMs || 0,
      song.addedBy || 'anonymous', song.guestName || '', position
    );

    return { id: result.lastInsertRowid, position };
  }

  removeFromQueue(venueId, queueId) {
    const deleted = this.db.prepare('DELETE FROM queue WHERE id = ? AND venue_id = ?').run(queueId, venueId);
    if (deleted.changes > 0) {
      this.reorderQueue(venueId);
    }
    return deleted.changes > 0;
  }

  reorderQueue(venueId) {
    const items = this.db.prepare(`
      SELECT id FROM queue WHERE venue_id = ? AND status = 'pending' ORDER BY position ASC
    `).all(venueId);

    const update = this.db.prepare('UPDATE queue SET position = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      items.forEach((item, index) => {
        update.run(index + 1, item.id);
      });
    });
    tx();
  }

  clearQueue(venueId) {
    this.db.prepare("DELETE FROM queue WHERE venue_id = ?").run(venueId);
  }

  playNext(venueId) {
    const next = this.db.prepare(`
      SELECT * FROM queue WHERE venue_id = ? AND status = 'pending' ORDER BY position ASC LIMIT 1
    `).get(venueId);

    if (next) {
      this.db.prepare("UPDATE queue SET status = 'playing' WHERE id = ?").run(next.id);
      this.setNowPlaying(venueId, next);
      return next;
    }

    return null;
  }

  // ============================================
  // NOW PLAYING (venue-scoped)
  // ============================================

  getNowPlaying(venueId) {
    return this.db.prepare('SELECT * FROM now_playing WHERE venue_id = ?').get(venueId);
  }

  setNowPlaying(venueId, song) {
    this.db.prepare(`
      INSERT OR REPLACE INTO now_playing (venue_id, song_id, title, artist, album, album_art, preview_url, spotify_uri, duration_ms, started_at, added_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    `).run(
      venueId, song.song_id || song.id, song.title, song.artist,
      song.album || '', song.album_art || song.albumArt || '',
      song.preview_url || song.previewUrl || '',
      song.spotify_uri || song.uri || '',
      song.duration_ms || song.durationMs || 0,
      song.added_by || song.addedBy || 'anonymous'
    );

    this.addToHistory(venueId, song);
  }

  clearNowPlaying(venueId) {
    this.db.prepare('DELETE FROM now_playing WHERE venue_id = ?').run(venueId);
  }

  // ============================================
  // GUEST RATE LIMITING (venue-scoped)
  // ============================================

  getGuestSession(venueId, guestId) {
    return this.db.prepare('SELECT * FROM guest_sessions WHERE venue_id = ? AND guest_id = ?').get(venueId, guestId);
  }

  createOrUpdateGuestSession(venueId, guestId, ipAddress) {
    const existing = this.getGuestSession(venueId, guestId);
    if (existing) {
      this.db.prepare(`
        UPDATE guest_sessions SET ip_address = ?, updated_at = CURRENT_TIMESTAMP WHERE venue_id = ? AND guest_id = ?
      `).run(ipAddress, venueId, guestId);
    } else {
      this.db.prepare(`
        INSERT INTO guest_sessions (venue_id, guest_id, ip_address) VALUES (?, ?, ?)
      `).run(venueId, guestId, ipAddress);
    }
  }

  canGuestRequest(venueId, guestId, rateLimitMinutes = 5) {
    const session = this.getGuestSession(venueId, guestId);

    if (!session || !session.last_request_at) {
      return { allowed: true, timeRemaining: 0 };
    }

    const lastRequest = new Date(session.last_request_at + 'Z');
    const now = new Date();
    const minutesElapsed = (now - lastRequest) / 1000 / 60;

    if (minutesElapsed >= rateLimitMinutes) {
      return { allowed: true, timeRemaining: 0 };
    }

    const timeRemaining = Math.ceil((rateLimitMinutes - minutesElapsed) * 60);
    return { allowed: false, timeRemaining };
  }

  updateGuestLastRequest(venueId, guestId) {
    const today = new Date().toISOString().split('T')[0];
    const session = this.getGuestSession(venueId, guestId);

    let songsToday = 1;
    if (session && session.last_song_date === today) {
      songsToday = (session.songs_today || 0) + 1;
    }

    this.db.prepare(`
      UPDATE guest_sessions
      SET last_request_at = CURRENT_TIMESTAMP,
          request_count = request_count + 1,
          songs_today = ?,
          last_song_date = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE venue_id = ? AND guest_id = ?
    `).run(songsToday, today, venueId, guestId);
  }

  getGuestSongsToday(venueId, guestId) {
    const today = new Date().toISOString().split('T')[0];
    const session = this.getGuestSession(venueId, guestId);
    if (!session || session.last_song_date !== today) return 0;
    return session.songs_today || 0;
  }

  resetGuestLimits(venueId) {
    this.db.prepare('UPDATE guest_sessions SET last_request_at = NULL, songs_today = 0 WHERE venue_id = ?').run(venueId);
  }

  // ============================================
  // HISTORY & ANALYTICS
  // ============================================

  addToHistory(venueId, song) {
    this.db.prepare(`
      INSERT INTO playback_history (venue_id, song_id, title, artist, album, added_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(venueId, song.song_id || song.id, song.title, song.artist, song.album || '', song.added_by || song.addedBy || 'anonymous');
  }

  getHistory(venueId, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM playback_history WHERE venue_id = ? ORDER BY played_at DESC LIMIT ?
    `).all(venueId, limit);
  }

  getVenueStats(venueId) {
    const queueCount = this.db.prepare("SELECT COUNT(*) as count FROM queue WHERE venue_id = ? AND status = 'pending'").get(venueId);
    const totalPlayed = this.db.prepare('SELECT COUNT(*) as count FROM playback_history WHERE venue_id = ?').get(venueId);
    const activeGuests = this.db.prepare('SELECT COUNT(*) as count FROM guest_sessions WHERE venue_id = ?').get(venueId);
    const topSongs = this.db.prepare(`
      SELECT title, artist, COUNT(*) as play_count FROM playback_history
      WHERE venue_id = ? GROUP BY song_id ORDER BY play_count DESC LIMIT 10
    `).all(venueId);
    const todayPlayed = this.db.prepare(`
      SELECT COUNT(*) as count FROM playback_history
      WHERE venue_id = ? AND date(played_at) = date('now')
    `).get(venueId);

    return {
      queueCount: queueCount.count,
      totalPlayed: totalPlayed.count,
      todayPlayed: todayPlayed.count,
      activeGuests: activeGuests.count,
      topSongs
    };
  }

  // ============================================
  // SUBSCRIPTION PLANS
  // ============================================

  getAllPlans() {
    return this.db.prepare('SELECT * FROM subscription_plans ORDER BY price_monthly ASC').all();
  }

  getPlan(planId) {
    return this.db.prepare('SELECT * FROM subscription_plans WHERE id = ?').get(planId);
  }

  // ============================================
  // SUPER ADMIN
  // ============================================

  getPlatformStats() {
    const totalVenues = this.db.prepare('SELECT COUNT(*) as count FROM venues').get();
    const activeVenues = this.db.prepare("SELECT COUNT(*) as count FROM venues WHERE is_active = 1").get();
    const totalSongsPlayed = this.db.prepare('SELECT COUNT(*) as count FROM playback_history').get();
    const totalGuests = this.db.prepare('SELECT COUNT(*) as count FROM guest_sessions').get();

    const revenueByPlan = this.db.prepare(`
      SELECT sp.name, sp.price_monthly, COUNT(v.id) as venue_count,
        COUNT(v.id) * sp.price_monthly as monthly_revenue
      FROM subscription_plans sp
      LEFT JOIN venues v ON v.plan_id = sp.id AND v.is_active = 1
      GROUP BY sp.id
      ORDER BY sp.price_monthly ASC
    `).all();

    const totalMRR = revenueByPlan.reduce((sum, p) => sum + (p.monthly_revenue || 0), 0);

    return {
      totalVenues: totalVenues.count,
      activeVenues: activeVenues.count,
      totalSongsPlayed: totalSongsPlayed.count,
      totalGuests: totalGuests.count,
      totalMRR,
      revenueByPlan
    };
  }

  getSuperAdmin(email) {
    return this.db.prepare('SELECT * FROM super_admins WHERE email = ?').get(email);
  }

  createSuperAdmin(email, passwordHash, name) {
    const id = uuidv4();
    this.db.prepare('INSERT INTO super_admins (id, email, password_hash, name) VALUES (?, ?, ?, ?)').run(id, email, passwordHash, name);
    return { id, email };
  }

  close() {
    this.db.close();
  }
}

module.exports = QueuePlayDB;
