// ============================================
// SPOTIFY SERVICE - OAuth + Search + Playback
// ============================================

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
      'user-read-currently-playing'
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

  async search(query, limit = 10) {
    const token = await this.getClientToken();

    const params = new URLSearchParams({
      q: query,
      type: 'track',
      limit: String(limit),
      market: 'US'
    });

    const response = await fetch(`https://api.spotify.com/v1/search?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) throw new Error('Search failed');

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

  async getTrack(trackId) {
    const token = await this.getClientToken();
    const response = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) throw new Error('Failed to fetch track');

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
  // PLAYBACK CONTROL (venue's Spotify account)
  // ============================================

  async play(accessToken, uri, deviceId) {
    const body = { uris: [uri] };
    const url = deviceId
      ? `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`
      : 'https://api.spotify.com/v1/me/player/play';

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    return response.ok;
  }

  async pause(accessToken) {
    const response = await fetch('https://api.spotify.com/v1/me/player/pause', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    return response.ok;
  }

  async getPlaybackState(accessToken) {
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!response.ok || response.status === 204) return null;
    return response.json();
  }
}

module.exports = SpotifyService;
