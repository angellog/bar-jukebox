// ============================================
// SPOTIFY SERVICE - OAuth + Search + Playback
// ============================================

async function spotifyError(prefix, response) {
  const body = await response.json().catch(() => ({}));
  const detail = body.error?.message || body.error_description || response.statusText;
  const err = new Error(`${prefix} (Spotify ${response.status}: ${detail})`);
  err.status = response.status;
  return err;
}

function trackFromApi(track) {
  return {
    id: track.id,
    title: track.name,
    artist: (track.artists || []).map(a => a.name).join(', '),
    album: track.album?.name || '',
    albumArt: track.album?.images?.[0]?.url || '',
    durationMs: track.duration_ms,
    uri: track.uri,
    explicit: !!track.explicit
  };
}

class SpotifyService {
  constructor(clientId, clientSecret, redirectUri) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  // ============================================
  // CLIENT CREDENTIALS (for search - no user auth)
  // ============================================

  async getClientToken() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')
      },
      body: 'grant_type=client_credentials'
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Spotify auth failed: ${err.error_description || response.statusText}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
    return this.accessToken;
  }

  // ============================================
  // OAUTH - Authorization Code Flow (venue owner)
  // ============================================

  getAuthUrl(venueId) {
    const scopes = [
      'streaming',
      'user-read-email',
      'user-read-private',
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-currently-playing',
      'playlist-read-private',
      'playlist-read-collaborative'
    ].join(' ');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: scopes,
      redirect_uri: this.redirectUri,
      state: venueId,
      show_dialog: 'true'
    });

    return `https://accounts.spotify.com/authorize?${params.toString()}`;
  }

  async exchangeCode(code) {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri
      }).toString()
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`Token exchange failed: ${err.error_description || response.statusText}`);
    }

    const data = await response.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString()
    };
  }

  async refreshToken(refreshToken) {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }).toString()
    });

    if (!response.ok) {
      throw new Error('Token refresh failed');
    }

    const data = await response.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString()
    };
  }

  // ============================================
  // SEARCH
  // ============================================

  // userToken: a venue's OAuth token. Spotify Development Mode apps can no longer
  // use client-credentials tokens for metadata (403), so prefer the user token.
  async search(query, limit = 10, userToken = null) {
    const token = userToken || await this.getClientToken();

    const params = new URLSearchParams({
      q: query,
      type: 'track',
      limit: String(limit),
      market: userToken ? 'from_token' : 'US'
    });

    const response = await fetch(`https://api.spotify.com/v1/search?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) throw await spotifyError('Search failed', response);

    const data = await response.json();
    return data.tracks.items.map(track => ({
      id: track.id,
      title: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      album: track.album.name,
      albumArt: track.album.images[0]?.url || '',
      albumArtSmall: track.album.images[2]?.url || track.album.images[0]?.url || '',
      previewUrl: track.preview_url,
      durationMs: track.duration_ms,
      spotifyUrl: track.external_urls.spotify,
      uri: track.uri,
      explicit: track.explicit
    }));
  }

  async getTrack(trackId, userToken = null) {
    const token = userToken || await this.getClientToken();
    const market = userToken ? '?market=from_token' : '';
    const response = await fetch(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}${market}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) throw await spotifyError('Failed to fetch track', response);

    const track = await response.json();
    return {
      id: track.id,
      title: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      album: track.album.name,
      albumArt: track.album.images[0]?.url || '',
      albumArtSmall: track.album.images[2]?.url || track.album.images[0]?.url || '',
      previewUrl: track.preview_url,
      durationMs: track.duration_ms,
      spotifyUrl: track.external_urls.spotify,
      uri: track.uri,
      explicit: track.explicit
    };
  }

  // ============================================
  // PLAYBACK CONTROL (venue's Spotify account, OAuth token)
  // ============================================

  // Generic user-token call. Returns parsed JSON, or null for 204/empty.
  // Throws an Error with .status (and .retryAfter for 429).
  async userApi(token, method, path, { query, body } = {}) {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)) : '';
    const response = await fetch(`https://api.spotify.com/v1${path}${qs}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (response.status === 204 || response.status === 202) return null;
    if (!response.ok) {
      const err = await spotifyError(`${method} ${path} failed`, response);
      err.retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
      throw err;
    }
    // Some player endpoints (e.g. POST /me/player/queue) answer 200 with a
    // plain-text id instead of JSON. The call succeeded; don't treat it as an error.
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  getPlaybackState(token) {
    return this.userApi(token, 'GET', '/me/player', { query: { additional_types: 'track' } });
  }

  async getDevices(token) {
    const data = await this.userApi(token, 'GET', '/me/player/devices');
    return (data && data.devices) || [];
  }

  transfer(token, deviceId, play = false) {
    return this.userApi(token, 'PUT', '/me/player', { body: { device_ids: [deviceId], play } });
  }

  // Either { uris: [...] } or { context_uri } (playlist), optionally offset/position_ms.
  play(token, deviceId, body) {
    return this.userApi(token, 'PUT', '/me/player/play', { query: { device_id: deviceId || undefined }, body: body || undefined });
  }

  pause(token, deviceId) {
    return this.userApi(token, 'PUT', '/me/player/pause', { query: { device_id: deviceId || undefined } });
  }

  next(token, deviceId) {
    return this.userApi(token, 'POST', '/me/player/next', { query: { device_id: deviceId || undefined } });
  }

  addToQueue(token, uri, deviceId) {
    return this.userApi(token, 'POST', '/me/player/queue', { query: { uri, device_id: deviceId || undefined } });
  }

  setShuffle(token, state, deviceId) {
    return this.userApi(token, 'PUT', '/me/player/shuffle', { query: { state: String(state), device_id: deviceId || undefined } });
  }

  async getMyPlaylists(token) {
    const data = await this.userApi(token, 'GET', '/me/playlists', { query: { limit: 50 } });
    return ((data && data.items) || []).filter(Boolean).map(p => ({
      uri: p.uri,
      name: p.name,
      image: p.images?.[0]?.url || '',
      tracks: p.items?.total ?? p.tracks?.total ?? null
    }));
  }

  async getPlaylist(token, playlistId) {
    const p = await this.userApi(token, 'GET', `/playlists/${encodeURIComponent(playlistId)}`, { query: { fields: 'name,uri,images' } });
    return { uri: p.uri, name: p.name, image: p.images?.[0]?.url || '' };
  }

  // Genre-filtered track search for background music. Search is capped at 10 per page.
  async searchByGenre(token, genre, offset = 0) {
    const data = await this.userApi(token, 'GET', '/search', {
      query: { q: `genre:"${genre}"`, type: 'track', limit: 10, offset, market: 'from_token' }
    });
    return ((data && data.tracks && data.tracks.items) || []).map(trackFromApi);
  }
}

module.exports = SpotifyService;
module.exports.trackFromApi = trackFromApi;
