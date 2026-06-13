// ============================================
// BAR JUKEBOX - EXPRESS SERVER
// ============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const JukeboxDatabase = require('./database');
const SpotifyService = require('./spotify');

// ============================================
// CONFIGURATION
// ============================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const RATE_LIMIT_MINUTES = parseInt(process.env.RATE_LIMIT_MINUTES) || 5;

// Initialize services
const db = new JukeboxDatabase(process.env.DATABASE_PATH);
const spotify = new SpotifyService(
    process.env.SPOTIFY_CLIENT_ID,
    process.env.SPOTIFY_CLIENT_SECRET
);

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static('.'));

// User identification middleware
app.use((req, res, next) => {
    let userId = req.cookies.userId;

    if (!userId) {
        userId = uuidv4();
        res.cookie('userId', userId, {
            maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
            httpOnly: true
        });
    }

    req.userId = userId;
    req.userIp = req.ip || req.connection.remoteAddress;

    // Ensure user session exists
    db.createOrUpdateSession(userId, req.userIp);

    next();
});

// ============================================
// WEBSOCKET - REAL-TIME UPDATES
// ============================================

const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('📡 WebSocket client connected');

    // Send current state
    ws.send(JSON.stringify({
        type: 'init',
        queue: db.getQueue(),
        nowPlaying: db.getNowPlaying()
    }));

    ws.on('close', () => {
        clients.delete(ws);
        console.log('📡 WebSocket client disconnected');
    });
});

function broadcastUpdate(type, data) {
    const message = JSON.stringify({ type, data });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ============================================
// API ROUTES
// ============================================

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        spotify: !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET)
    });
});

// Search songs
app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;

        if (!q || q.trim().length === 0) {
            return res.status(400).json({ error: 'Search query required' });
        }

        if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
            return res.status(503).json({
                error: 'Spotify API not configured. Please add credentials to .env file'
            });
        }

        const results = await spotify.search(q);
        res.json({ results });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get queue
app.get('/api/queue', (req, res) => {
    try {
        const queue = db.getQueue();
        res.json({ queue });
    } catch (error) {
        console.error('Get queue error:', error);
        res.status(500).json({ error: 'Failed to fetch queue' });
    }
});

// Add to queue
app.post('/api/queue', async (req, res) => {
    try {
        const { songId } = req.body;

        if (!songId) {
            return res.status(400).json({ error: 'Song ID required' });
        }

        // Check rate limit
        const rateCheck = db.canUserRequest(req.userId, RATE_LIMIT_MINUTES);
        if (!rateCheck.allowed) {
            return res.status(429).json({
                error: 'Rate limit exceeded',
                timeRemaining: rateCheck.timeRemaining,
                message: `Please wait ${Math.ceil(rateCheck.timeRemaining / 60)} minute(s) before adding another song`
            });
        }

        // Fetch song details from Spotify
        const song = await spotify.getTrack(songId);
        song.addedBy = req.userId;

        // Add to queue
        const result = db.addToQueue(song);

        // Update rate limit
        db.updateLastRequest(req.userId);

        // Broadcast update
        broadcastUpdate('queue_updated', { queue: db.getQueue() });

        // If nothing is playing, start playback
        if (!db.getNowPlaying()) {
            const nextSong = db.playNext();
            if (nextSong) {
                broadcastUpdate('now_playing', nextSong);
            }
        }

        res.json({
            success: true,
            position: result.position,
            nextRequestIn: RATE_LIMIT_MINUTES * 60 // seconds
        });
    } catch (error) {
        console.error('Add to queue error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Remove from queue
app.delete('/api/queue/:id', (req, res) => {
    try {
        const { id } = req.params;
        const success = db.removeFromQueue(parseInt(id));

        if (success) {
            broadcastUpdate('queue_updated', { queue: db.getQueue() });
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Queue item not found' });
        }
    } catch (error) {
        console.error('Remove from queue error:', error);
        res.status(500).json({ error: 'Failed to remove from queue' });
    }
});

// Get now playing
app.get('/api/now-playing', (req, res) => {
    try {
        const nowPlaying = db.getNowPlaying();
        res.json({ nowPlaying });
    } catch (error) {
        console.error('Get now playing error:', error);
        res.status(500).json({ error: 'Failed to fetch now playing' });
    }
});

// Play next (admin or automatic)
app.post('/api/play-next', (req, res) => {
    try {
        const nextSong = db.playNext();

        if (nextSong) {
            broadcastUpdate('now_playing', nextSong);
            broadcastUpdate('queue_updated', { queue: db.getQueue() });
            res.json({ success: true, nowPlaying: nextSong });
        } else {
            db.clearNowPlaying();
            broadcastUpdate('now_playing', null);
            res.json({ success: true, nowPlaying: null, message: 'Queue is empty' });
        }
    } catch (error) {
        console.error('Play next error:', error);
        res.status(500).json({ error: 'Failed to play next song' });
    }
});

// Check rate limit status
app.get('/api/rate-limit', (req, res) => {
    try {
        const rateCheck = db.canUserRequest(req.userId, RATE_LIMIT_MINUTES);
        res.json({
            allowed: rateCheck.allowed,
            timeRemaining: rateCheck.timeRemaining,
            rateLimitMinutes: RATE_LIMIT_MINUTES
        });
    } catch (error) {
        console.error('Rate limit check error:', error);
        res.status(500).json({ error: 'Failed to check rate limit' });
    }
});

// Get stats
app.get('/api/stats', (req, res) => {
    try {
        const stats = db.getStats();
        res.json(stats);
    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ============================================
// ADMIN ROUTES (Protected)
// ============================================

function adminAuth(req, res, next) {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey === process.env.ADMIN_KEY) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// Clear queue
app.post('/api/admin/clear-queue', adminAuth, (req, res) => {
    try {
        db.clearQueue();
        db.clearNowPlaying();
        broadcastUpdate('queue_updated', { queue: [] });
        broadcastUpdate('now_playing', null);
        res.json({ success: true });
    } catch (error) {
        console.error('Clear queue error:', error);
        res.status(500).json({ error: 'Failed to clear queue' });
    }
});

// Reset rate limits
app.post('/api/admin/reset-limits', adminAuth, (req, res) => {
    try {
        db.resetUserLimits();
        res.json({ success: true });
    } catch (error) {
        console.error('Reset limits error:', error);
        res.status(500).json({ error: 'Failed to reset limits' });
    }
});

// ============================================
// SERVE FRONTEND
// ============================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================
// START SERVER
// ============================================

server.listen(PORT, () => {
    console.log('🎵 ================================');
    console.log('🎵 BAR JUKEBOX SERVER RUNNING');
    console.log('🎵 ================================');
    console.log(`🌐 Server: http://localhost:${PORT}`);
    console.log(`⏱️  Rate limit: ${RATE_LIMIT_MINUTES} minutes`);
    console.log(`💾 Database: ${process.env.DATABASE_PATH || './database/jukebox.db'}`);
    console.log(`🎧 Spotify: ${process.env.SPOTIFY_CLIENT_ID ? '✅ Configured' : '❌ Not configured'}`);
    console.log('🎵 ================================');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    db.close();
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

module.exports = app;
