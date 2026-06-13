// ============================================
// SPOTIFY API INTEGRATION
// ============================================

const axios = require('axios');

class SpotifyService {
    constructor(clientId, clientSecret) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.accessToken = null;
        this.tokenExpiry = null;
    }

    // ============================================
    // AUTHENTICATION
    // ============================================

    async getAccessToken() {
        // Return cached token if still valid
        if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        try {
            const response = await axios.post(
                'https://accounts.spotify.com/api/token',
                'grant_type=client_credentials',
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')
                    }
                }
            );

            this.accessToken = response.data.access_token;
            this.tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000; // 1 min buffer

            console.log('✅ Spotify access token obtained');
            return this.accessToken;
        } catch (error) {
            console.error('❌ Spotify authentication error:', error.response?.data || error.message);
            throw new Error('Failed to authenticate with Spotify');
        }
    }

    // ============================================
    // SEARCH
    // ============================================

    async search(query, limit = 20) {
        try {
            const token = await this.getAccessToken();

            const response = await axios.get('https://api.spotify.com/v1/search', {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                params: {
                    q: query,
                    type: 'track',
                    limit: limit,
                    market: 'US' // You can make this configurable
                }
            });

            // Transform Spotify response to our format
            return response.data.tracks.items.map(track => ({
                id: track.id,
                title: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                album: track.album.name,
                albumArt: track.album.images[0]?.url || '',
                previewUrl: track.preview_url, // 30-second preview
                durationMs: track.duration_ms,
                spotifyUrl: track.external_urls.spotify,
                uri: track.uri
            }));
        } catch (error) {
            console.error('❌ Spotify search error:', error.response?.data || error.message);
            throw new Error('Search failed');
        }
    }

    // ============================================
    // GET TRACK INFO
    // ============================================

    async getTrack(trackId) {
        try {
            const token = await this.getAccessToken();

            const response = await axios.get(
                `https://api.spotify.com/v1/tracks/${trackId}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                }
            );

            const track = response.data;
            return {
                id: track.id,
                title: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                album: track.album.name,
                albumArt: track.album.images[0]?.url || '',
                previewUrl: track.preview_url,
                durationMs: track.duration_ms,
                spotifyUrl: track.external_urls.spotify,
                uri: track.uri
            };
        } catch (error) {
            console.error('❌ Spotify track fetch error:', error.response?.data || error.message);
            throw new Error('Failed to fetch track');
        }
    }

    // ============================================
    // RECOMMENDATIONS (BONUS FEATURE)
    // ============================================

    async getRecommendations(seedTracks, limit = 10) {
        try {
            const token = await this.getAccessToken();

            const response = await axios.get('https://api.spotify.com/v1/recommendations', {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                params: {
                    seed_tracks: seedTracks.join(','),
                    limit: limit
                }
            });

            return response.data.tracks.map(track => ({
                id: track.id,
                title: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                album: track.album.name,
                albumArt: track.album.images[0]?.url || '',
                previewUrl: track.preview_url,
                durationMs: track.duration_ms,
                spotifyUrl: track.external_urls.spotify,
                uri: track.uri
            }));
        } catch (error) {
            console.error('❌ Spotify recommendations error:', error.response?.data || error.message);
            return [];
        }
    }
}

module.exports = SpotifyService;
