// ============================================
// DATABASE CONFIGURATION & SCHEMA
// ============================================

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

class JukeboxDatabase {
    constructor(dbPath = './database/jukebox.db') {
        // Ensure database directory exists
        const dbDir = path.dirname(dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.initializeSchema();
    }

    initializeSchema() {
        // Create tables
        this.db.exec(`
      -- Queue table
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        song_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        album_art TEXT,
        preview_url TEXT,
        duration_ms INTEGER,
        added_by TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        position INTEGER NOT NULL,
        status TEXT DEFAULT 'pending'
      );
      
      -- User sessions table (for rate limiting)
      CREATE TABLE IF NOT EXISTS user_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT UNIQUE NOT NULL,
        ip_address TEXT,
        last_request_at DATETIME,
        request_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Playback history
      CREATE TABLE IF NOT EXISTS playback_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        song_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        added_by TEXT
      );
      
      -- Now playing
      CREATE TABLE IF NOT EXISTS now_playing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        song_id TEXT,
        title TEXT,
        artist TEXT,
        album TEXT,
        album_art TEXT,
        preview_url TEXT,
        duration_ms INTEGER,
        started_at DATETIME,
        added_by TEXT
      );
      
      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_queue_position ON queue(position);
      CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_ip ON user_sessions(ip_address);
    `);

        console.log('✅ Database schema initialized');
    }

    // ============================================
    // QUEUE OPERATIONS
    // ============================================

    getQueue() {
        return this.db.prepare(`
      SELECT * FROM queue 
      WHERE status = 'pending' 
      ORDER BY position ASC
    `).all();
    }

    addToQueue(song) {
        const maxPosition = this.db.prepare(
            "SELECT MAX(position) as max FROM queue WHERE status = 'pending'"
        ).get();

        const position = (maxPosition.max || 0) + 1;

        const insert = this.db.prepare(`
      INSERT INTO queue (song_id, title, artist, album, album_art, preview_url, duration_ms, added_by, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        const result = insert.run(
            song.id,
            song.title,
            song.artist,
            song.album || '',
            song.albumArt || '',
            song.previewUrl || '',
            song.durationMs || 0,
            song.addedBy || 'anonymous',
            position
        );

        return { id: result.lastInsertRowid, position };
    }

    removeFromQueue(queueId) {
        const deleted = this.db.prepare('DELETE FROM queue WHERE id = ?').run(queueId);

        // Reorder remaining items
        if (deleted.changes > 0) {
            this.reorderQueue();
        }

        return deleted.changes > 0;
    }

    reorderQueue() {
        const items = this.db.prepare(`
      SELECT id FROM queue 
      WHERE status = 'pending' 
      ORDER BY position ASC
    `).all();

        const update = this.db.prepare('UPDATE queue SET position = ? WHERE id = ?');

        this.db.exec('BEGIN TRANSACTION');
        try {
            items.forEach((item, index) => {
                update.run(index + 1, item.id);
            });
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    playNext() {
        const next = this.db.prepare(`
      SELECT * FROM queue 
      WHERE status = 'pending' 
      ORDER BY position ASC 
      LIMIT 1
    `).get();

        if (next) {
            // Mark as playing
            this.db.prepare('UPDATE queue SET status = ? WHERE id = ?').run('playing', next.id);

            // Update now playing
            this.setNowPlaying(next);

            return next;
        }

        return null;
    }

    // ============================================
    // NOW PLAYING
    // ============================================

    getNowPlaying() {
        return this.db.prepare('SELECT * FROM now_playing WHERE id = 1').get();
    }

    setNowPlaying(song) {
        this.db.prepare(`
      INSERT OR REPLACE INTO now_playing (id, song_id, title, artist, album, album_art, preview_url, duration_ms, started_at, added_by)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    `).run(
            song.song_id,
            song.title,
            song.artist,
            song.album || '',
            song.album_art || '',
            song.preview_url || '',
            song.duration_ms || 0,
            song.added_by || 'anonymous'
        );

        // Add to history
        this.addToHistory(song);
    }

    clearNowPlaying() {
        this.db.prepare('DELETE FROM now_playing WHERE id = 1').run();
    }

    // ============================================
    // USER SESSIONS & RATE LIMITING
    // ============================================

    getUserSession(userId) {
        return this.db.prepare('SELECT * FROM user_sessions WHERE user_id = ?').get(userId);
    }

    createOrUpdateSession(userId, ipAddress) {
        const existing = this.getUserSession(userId);

        if (existing) {
            this.db.prepare(`
        UPDATE user_sessions 
        SET ip_address = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE user_id = ?
      `).run(ipAddress, userId);
        } else {
            this.db.prepare(`
        INSERT INTO user_sessions (user_id, ip_address) 
        VALUES (?, ?)
      `).run(userId, ipAddress);
        }
    }

    updateLastRequest(userId) {
        this.db.prepare(`
      UPDATE user_sessions 
      SET last_request_at = CURRENT_TIMESTAMP, 
          request_count = request_count + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(userId);
    }

    canUserRequest(userId, rateLimitMinutes = 5) {
        const session = this.getUserSession(userId);

        if (!session || !session.last_request_at) {
            return { allowed: true, timeRemaining: 0 };
        }

        const lastRequest = new Date(session.last_request_at);
        const now = new Date();
        const minutesElapsed = (now - lastRequest) / 1000 / 60;

        if (minutesElapsed >= rateLimitMinutes) {
            return { allowed: true, timeRemaining: 0 };
        }

        const timeRemaining = Math.ceil((rateLimitMinutes - minutesElapsed) * 60); // in seconds
        return { allowed: false, timeRemaining };
    }

    // ============================================
    // HISTORY
    // ============================================

    addToHistory(song) {
        this.db.prepare(`
      INSERT INTO playback_history (song_id, title, artist, added_by)
      VALUES (?, ?, ?, ?)
    `).run(song.song_id, song.title, song.artist, song.added_by || 'anonymous');
    }

    getHistory(limit = 50) {
        return this.db.prepare(`
      SELECT * FROM playback_history 
      ORDER BY played_at DESC 
      LIMIT ?
    `).all(limit);
    }

    // ============================================
    // ADMIN
    // ============================================

    clearQueue() {
        this.db.prepare('DELETE FROM queue').run();
    }

    resetUserLimits() {
        this.db.prepare('UPDATE user_sessions SET last_request_at = NULL').run();
    }

    getStats() {
        const queueCount = this.db.prepare("SELECT COUNT(*) as count FROM queue WHERE status = 'pending'").get();
        const totalPlayed = this.db.prepare('SELECT COUNT(*) as count FROM playback_history').get();
        const activeUsers = this.db.prepare('SELECT COUNT(*) as count FROM user_sessions').get();

        return {
            queueCount: queueCount.count,
            totalPlayed: totalPlayed.count,
            activeUsers: activeUsers.count
        };
    }

    close() {
        this.db.close();
    }
}

module.exports = JukeboxDatabase;
