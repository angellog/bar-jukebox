const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

class QueuePlayDB {
  constructor(connectionString) {
    this.pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  async initializeSchema() {
    await this.pool.query(`
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS venues (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'cafe',
        email TEXT,
        phone TEXT,
        address TEXT,
        timezone TEXT DEFAULT 'UTC',
        plan_id TEXT NOT NULL DEFAULT 'free',
        subscription_status TEXT NOT NULL DEFAULT 'active',
        subscription_started_at TIMESTAMP,
        subscription_expires_at TIMESTAMP,
        stripe_customer_id TEXT,
        spotify_access_token TEXT,
        spotify_refresh_token TEXT,
        spotify_token_expires_at TIMESTAMP,
        spotify_connected INTEGER NOT NULL DEFAULT 0,
        admin_password_hash TEXT NOT NULL,
        admin_key TEXT NOT NULL,
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
        rate_limit_minutes INTEGER DEFAULT 5,
        max_queue_size INTEGER DEFAULT 20,
        songs_per_guest INTEGER DEFAULT 1,
        allow_explicit INTEGER DEFAULT 1,
        auto_play INTEGER DEFAULT 1,
        show_queue_position INTEGER DEFAULT 1,
        show_album_art INTEGER DEFAULT 1,
        genre_restrictions TEXT,
        blocked_songs TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
      );

      CREATE TABLE IF NOT EXISTS queue (
        id SERIAL PRIMARY KEY,
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
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );

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
        started_at TIMESTAMP,
        added_by TEXT,
        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );

      CREATE TABLE IF NOT EXISTS guest_sessions (
        id SERIAL PRIMARY KEY,
        venue_id TEXT NOT NULL,
        guest_id TEXT NOT NULL,
        ip_address TEXT,
        last_request_at TIMESTAMP,
        request_count INTEGER DEFAULT 0,
        songs_today INTEGER DEFAULT 0,
        last_song_date TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(venue_id, guest_id),
        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );

      CREATE TABLE IF NOT EXISTS playback_history (
        id SERIAL PRIMARY KEY,
        venue_id TEXT NOT NULL,
        song_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        added_by TEXT,
        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );

      CREATE TABLE IF NOT EXISTS super_admins (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_venues_slug ON venues(slug);
      CREATE INDEX IF NOT EXISTS idx_queue_venue ON queue(venue_id, status, position);
      CREATE INDEX IF NOT EXISTS idx_guest_sessions_venue ON guest_sessions(venue_id, guest_id);
      CREATE INDEX IF NOT EXISTS idx_history_venue ON playback_history(venue_id, played_at);
    `);

    await this.seedSubscriptionPlans();
    console.log('[DB] PostgreSQL schema initialized');
  }

  async seedSubscriptionPlans() {
    const { rows } = await this.pool.query('SELECT COUNT(*)::int as count FROM subscription_plans');
    if (rows[0].count > 0) return;

    const plans = [
      ['free', 'Free', 0, 0, 10, 30, 10, 0, 0, 0, 0, 0, 10, 'Try QueuePlay with basic features', '["Up to 10 songs in queue","30 songs per day","10-min cooldown between requests","QueuePlay watermark","Basic support"]'],
      ['starter', 'Starter', 19.99, 199, 25, 100, 5, 1, 0, 1, 0, 1, 30, 'Perfect for small cafes and shops', '["Up to 25 songs in queue","100 songs per day","5-min cooldown","Custom colors & logo","No watermark","Basic analytics","Email support"]'],
      ['pro', 'Pro', 49.99, 499, 50, 500, 3, 1, 1, 1, 1, 1, 100, 'For busy restaurants and lounges', '["Up to 50 songs in queue","500 songs per day","3-min cooldown","Full brand customization","Custom domain support","Advanced analytics","Priority support","Genre restrictions","Song blocking"]'],
      ['enterprise', 'Enterprise', 99.99, 999, 200, 9999, 1, 1, 1, 1, 1, 1, 500, 'Multi-location chains and franchises', '["Unlimited queue size","Unlimited songs per day","1-min cooldown","Full white-label","Custom domain","Real-time analytics dashboard","Dedicated support","API access","Multi-venue management","Custom integrations"]']
    ];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const p of plans) {
        await client.query(
          `INSERT INTO subscription_plans (id, name, price_monthly, price_yearly, max_queue_size, max_songs_per_day, rate_limit_minutes, custom_branding, custom_domain, analytics, priority_support, remove_watermark, max_active_sessions, description, features_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          p
        );
      }
      await client.query('COMMIT');
      console.log('[DB] Subscription plans seeded');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async createVenue(data) {
    const id = uuidv4();
    const slug = data.slug || data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const adminKey = uuidv4();

    await this.pool.query(
      `INSERT INTO venues (id, slug, name, type, email, phone, address, plan_id, admin_password_hash, admin_key, page_title, welcome_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id, slug, data.name, data.type || 'cafe',
        data.email || null, data.phone || null, data.address || null,
        data.plan_id || 'free',
        data.password_hash,
        adminKey,
        data.name,
        data.welcome_message || 'Search, add, and enjoy music together'
      ]
    );

    return { id, slug, adminKey };
  }

  async getVenueBySlug(slug) {
    const { rows } = await this.pool.query('SELECT * FROM venues WHERE slug = $1 AND is_active = 1', [slug]);
    return rows[0] || null;
  }

  async getVenueById(id) {
    const { rows } = await this.pool.query('SELECT * FROM venues WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async getAllVenues() {
    const { rows } = await this.pool.query(`
      SELECT v.*, sp.name as plan_name, sp.price_monthly,
        (SELECT COUNT(*) FROM playback_history WHERE venue_id = v.id) as total_played,
        (SELECT COUNT(*) FROM guest_sessions WHERE venue_id = v.id) as total_guests
      FROM venues v
      LEFT JOIN subscription_plans sp ON v.plan_id = sp.id
      ORDER BY v.created_at DESC
    `);
    return rows;
  }

  async updateVenueBranding(venueId, branding) {
    const allowed = [
      'logo_url', 'brand_primary', 'brand_secondary', 'brand_accent',
      'brand_bg_dark', 'brand_bg_card', 'brand_text', 'brand_text_secondary',
      'brand_radius', 'brand_font', 'welcome_message', 'page_title', 'custom_css',
      'name', 'type'
    ];

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const key of allowed) {
      if (branding[key] !== undefined) {
        setClauses.push(`${key} = $${idx++}`);
        values.push(branding[key]);
      }
    }

    if (setClauses.length === 0) return false;

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(venueId);

    await this.pool.query(
      `UPDATE venues SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      values
    );
    return true;
  }

  async updateVenueConfig(venueId, config) {
    const allowed = [
      'rate_limit_minutes', 'max_queue_size', 'songs_per_guest',
      'allow_explicit', 'auto_play', 'show_queue_position', 'show_album_art',
      'genre_restrictions', 'blocked_songs'
    ];

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const key of allowed) {
      if (config[key] !== undefined) {
        setClauses.push(`${key} = $${idx++}`);
        values.push(config[key]);
      }
    }

    if (setClauses.length === 0) return false;

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(venueId);

    await this.pool.query(
      `UPDATE venues SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      values
    );
    return true;
  }

  async updateVenuePlan(venueId, planId) {
    await this.pool.query(
      'UPDATE venues SET plan_id = $1, subscription_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [planId, venueId]
    );
  }

  async updateVenueSpotifyTokens(venueId, tokens) {
    await this.pool.query(
      `UPDATE venues SET
        spotify_access_token = $1,
        spotify_refresh_token = $2,
        spotify_token_expires_at = $3,
        spotify_connected = 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4`,
      [tokens.access_token, tokens.refresh_token, tokens.expires_at, venueId]
    );
  }

  async deleteVenue(venueId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM queue WHERE venue_id = $1', [venueId]);
      await client.query('DELETE FROM now_playing WHERE venue_id = $1', [venueId]);
      await client.query('DELETE FROM guest_sessions WHERE venue_id = $1', [venueId]);
      await client.query('DELETE FROM playback_history WHERE venue_id = $1', [venueId]);
      await client.query('DELETE FROM venues WHERE id = $1', [venueId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getQueue(venueId) {
    const { rows } = await this.pool.query(
      "SELECT * FROM queue WHERE venue_id = $1 AND status = 'pending' ORDER BY position ASC",
      [venueId]
    );
    return rows;
  }

  async addToQueue(venueId, song) {
    const venue = await this.getVenueById(venueId);
    const plan = await this.getPlan(venue.plan_id);

    const { rows: countRows } = await this.pool.query(
      "SELECT COUNT(*)::int as count FROM queue WHERE venue_id = $1 AND status = 'pending'",
      [venueId]
    );

    if (countRows[0].count >= (venue.max_queue_size || plan.max_queue_size)) {
      throw new Error(`Queue is full (max ${venue.max_queue_size || plan.max_queue_size} songs)`);
    }

    const { rows: dupRows } = await this.pool.query(
      "SELECT id FROM queue WHERE venue_id = $1 AND song_id = $2 AND status = 'pending'",
      [venueId, song.id]
    );

    if (dupRows.length > 0) {
      throw new Error('This song is already in the queue');
    }

    const { rows: maxPosRows } = await this.pool.query(
      "SELECT COALESCE(MAX(position), 0) as max FROM queue WHERE venue_id = $1 AND status = 'pending'",
      [venueId]
    );

    const position = maxPosRows[0].max + 1;

    const { rows } = await this.pool.query(
      `INSERT INTO queue (venue_id, song_id, title, artist, album, album_art, preview_url, spotify_uri, duration_ms, added_by, guest_name, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        venueId, song.id, song.title, song.artist,
        song.album || '', song.albumArt || '', song.previewUrl || '',
        song.uri || '', song.durationMs || 0,
        song.addedBy || 'anonymous', song.guestName || '', position
      ]
    );

    return { id: rows[0].id, position };
  }

  async removeFromQueue(venueId, queueId) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM queue WHERE id = $1 AND venue_id = $2',
      [queueId, venueId]
    );
    if (rowCount > 0) {
      await this.reorderQueue(venueId);
    }
    return rowCount > 0;
  }

  async reorderQueue(venueId) {
    const { rows } = await this.pool.query(
      "SELECT id FROM queue WHERE venue_id = $1 AND status = 'pending' ORDER BY position ASC",
      [venueId]
    );

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < rows.length; i++) {
        await client.query('UPDATE queue SET position = $1 WHERE id = $2', [i + 1, rows[i].id]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async clearQueue(venueId) {
    await this.pool.query('DELETE FROM queue WHERE venue_id = $1', [venueId]);
  }

  async playNext(venueId) {
    const { rows } = await this.pool.query(
      "SELECT * FROM queue WHERE venue_id = $1 AND status = 'pending' ORDER BY position ASC LIMIT 1",
      [venueId]
    );

    if (rows.length > 0) {
      const next = rows[0];
      await this.pool.query("UPDATE queue SET status = 'playing' WHERE id = $1", [next.id]);
      await this.setNowPlaying(venueId, next);
      return next;
    }

    return null;
  }

  async getNowPlaying(venueId) {
    const { rows } = await this.pool.query('SELECT * FROM now_playing WHERE venue_id = $1', [venueId]);
    return rows[0] || null;
  }

  async setNowPlaying(venueId, song) {
    await this.pool.query(
      `INSERT INTO now_playing (venue_id, song_id, title, artist, album, album_art, preview_url, spotify_uri, duration_ms, started_at, added_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, $10)
       ON CONFLICT (venue_id)
       DO UPDATE SET
         song_id = EXCLUDED.song_id,
         title = EXCLUDED.title,
         artist = EXCLUDED.artist,
         album = EXCLUDED.album,
         album_art = EXCLUDED.album_art,
         preview_url = EXCLUDED.preview_url,
         spotify_uri = EXCLUDED.spotify_uri,
         duration_ms = EXCLUDED.duration_ms,
         started_at = CURRENT_TIMESTAMP,
         added_by = EXCLUDED.added_by`,
      [
        venueId, song.song_id || song.id, song.title, song.artist,
        song.album || '', song.album_art || song.albumArt || '',
        song.preview_url || song.previewUrl || '',
        song.spotify_uri || song.uri || '',
        song.duration_ms || song.durationMs || 0,
        song.added_by || song.addedBy || 'anonymous'
      ]
    );

    await this.addToHistory(venueId, song);
  }

  async clearNowPlaying(venueId) {
    await this.pool.query('DELETE FROM now_playing WHERE venue_id = $1', [venueId]);
  }

  async getGuestSession(venueId, guestId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM guest_sessions WHERE venue_id = $1 AND guest_id = $2',
      [venueId, guestId]
    );
    return rows[0] || null;
  }

  async createOrUpdateGuestSession(venueId, guestId, ipAddress) {
    const existing = await this.getGuestSession(venueId, guestId);
    if (existing) {
      await this.pool.query(
        'UPDATE guest_sessions SET ip_address = $1, updated_at = CURRENT_TIMESTAMP WHERE venue_id = $2 AND guest_id = $3',
        [ipAddress, venueId, guestId]
      );
    } else {
      await this.pool.query(
        'INSERT INTO guest_sessions (venue_id, guest_id, ip_address) VALUES ($1, $2, $3)',
        [venueId, guestId, ipAddress]
      );
    }
  }

  async canGuestRequest(venueId, guestId, rateLimitMinutes = 5) {
    const session = await this.getGuestSession(venueId, guestId);

    if (!session || !session.last_request_at) {
      return { allowed: true, timeRemaining: 0 };
    }

    const lastRequest = new Date(session.last_request_at);
    const now = new Date();
    const minutesElapsed = (now - lastRequest) / 1000 / 60;

    if (minutesElapsed >= rateLimitMinutes) {
      return { allowed: true, timeRemaining: 0 };
    }

    const timeRemaining = Math.ceil((rateLimitMinutes - minutesElapsed) * 60);
    return { allowed: false, timeRemaining };
  }

  async updateGuestLastRequest(venueId, guestId) {
    const today = new Date().toISOString().split('T')[0];
    const session = await this.getGuestSession(venueId, guestId);

    let songsToday = 1;
    if (session && session.last_song_date === today) {
      songsToday = (session.songs_today || 0) + 1;
    }

    await this.pool.query(
      `UPDATE guest_sessions
       SET last_request_at = CURRENT_TIMESTAMP,
           request_count = request_count + 1,
           songs_today = $1,
           last_song_date = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE venue_id = $3 AND guest_id = $4`,
      [songsToday, today, venueId, guestId]
    );
  }

  async getGuestSongsToday(venueId, guestId) {
    const today = new Date().toISOString().split('T')[0];
    const session = await this.getGuestSession(venueId, guestId);
    if (!session || session.last_song_date !== today) return 0;
    return session.songs_today || 0;
  }

  async resetGuestLimits(venueId) {
    await this.pool.query(
      'UPDATE guest_sessions SET last_request_at = NULL, songs_today = 0 WHERE venue_id = $1',
      [venueId]
    );
  }

  async addToHistory(venueId, song) {
    await this.pool.query(
      'INSERT INTO playback_history (venue_id, song_id, title, artist, album, added_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        venueId, song.song_id || song.id, song.title, song.artist,
        song.album || '',
        song.added_by || song.addedBy || 'anonymous'
      ]
    );
  }

  async getHistory(venueId, limit = 50) {
    const { rows } = await this.pool.query(
      'SELECT * FROM playback_history WHERE venue_id = $1 ORDER BY played_at DESC LIMIT $2',
      [venueId, limit]
    );
    return rows;
  }

  async getVenueStats(venueId) {
    const { rows: queueCount } = await this.pool.query(
      "SELECT COUNT(*)::int as count FROM queue WHERE venue_id = $1 AND status = 'pending'",
      [venueId]
    );
    const { rows: totalPlayed } = await this.pool.query(
      'SELECT COUNT(*)::int as count FROM playback_history WHERE venue_id = $1',
      [venueId]
    );
    const { rows: activeGuests } = await this.pool.query(
      'SELECT COUNT(*)::int as count FROM guest_sessions WHERE venue_id = $1',
      [venueId]
    );
    const { rows: topSongs } = await this.pool.query(
      `SELECT title, artist, COUNT(*)::int as play_count FROM playback_history
       WHERE venue_id = $1 GROUP BY song_id, title, artist ORDER BY play_count DESC LIMIT 10`,
      [venueId]
    );
    const { rows: todayPlayed } = await this.pool.query(
      "SELECT COUNT(*)::int as count FROM playback_history WHERE venue_id = $1 AND played_at::date = CURRENT_DATE",
      [venueId]
    );

    return {
      queueCount: queueCount[0].count,
      totalPlayed: totalPlayed[0].count,
      todayPlayed: todayPlayed[0].count,
      activeGuests: activeGuests[0].count,
      topSongs
    };
  }

  async getAllPlans() {
    const { rows } = await this.pool.query('SELECT * FROM subscription_plans ORDER BY price_monthly ASC');
    return rows.map(p => ({ ...p, features: JSON.parse(p.features_json || '[]') }));
  }

  async getPlan(planId) {
    const { rows } = await this.pool.query('SELECT * FROM subscription_plans WHERE id = $1', [planId]);
    return rows[0] || null;
  }

  async getPlatformStats() {
    const { rows: totalVenues } = await this.pool.query('SELECT COUNT(*)::int as count FROM venues');
    const { rows: activeVenues } = await this.pool.query("SELECT COUNT(*)::int as count FROM venues WHERE is_active = 1");
    const { rows: totalSongsPlayed } = await this.pool.query('SELECT COUNT(*)::int as count FROM playback_history');
    const { rows: totalGuests } = await this.pool.query('SELECT COUNT(*)::int as count FROM guest_sessions');

    const { rows: revenueByPlan } = await this.pool.query(`
      SELECT sp.name, sp.price_monthly, COUNT(v.id)::int as venue_count,
        COUNT(v.id) * sp.price_monthly as monthly_revenue
      FROM subscription_plans sp
      LEFT JOIN venues v ON v.plan_id = sp.id AND v.is_active = 1
      GROUP BY sp.id, sp.name, sp.price_monthly
      ORDER BY sp.price_monthly ASC
    `);

    const totalMRR = revenueByPlan.reduce((sum, p) => sum + Number(p.monthly_revenue || 0), 0);

    return {
      totalVenues: totalVenues[0].count,
      activeVenues: activeVenues[0].count,
      totalSongsPlayed: totalSongsPlayed[0].count,
      totalGuests: totalGuests[0].count,
      totalMRR,
      revenueByPlan
    };
  }

  async getSuperAdmin(email) {
    const { rows } = await this.pool.query('SELECT * FROM super_admins WHERE email = $1', [email]);
    return rows[0] || null;
  }

  async createSuperAdmin(email, passwordHash, name) {
    const id = uuidv4();
    await this.pool.query(
      'INSERT INTO super_admins (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
      [id, email, passwordHash, name]
    );
    return { id, email };
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = QueuePlayDB;
