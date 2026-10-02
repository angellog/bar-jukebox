// ============================================
// PLAYBACK ENGINE
// Drives each venue's Spotify playback from the server, on any Spotify Connect
// device (the browser player page, a phone/tablet running Spotify, a smart
// speaker, a TV...). Guest requests play in the order they were added; when
// none are waiting, background music (genre mix or playlist) keeps going.
//
// Spotify is the source of truth: we poll the venue's playback state and,
// shortly before the current track ends, hand Spotify the next track via its
// queue so transitions are gapless.
// ============================================

const { trackFromApi } = require('./spotify');

const IDLE_POLL_MS = 5000;
const NEAR_END_POLL_MS = 2000;
const PUSH_WINDOW_MS = 20000;   // queue the next track this long before the end
const STATION_MIN = 5;          // refill the genre mix below this many tracks
const RECENT_LIMIT = 150;       // don't repeat background tracks within this many

// Genres offered in the dashboard. Values are Spotify genre names used with
// the search `genre:` filter.
const GENRES = [
  'afrobeats', 'amapiano', 'afro house', 'bongo flava', 'dancehall', 'reggae',
  'hip hop', 'r&b', 'soul', 'neo soul', 'jazz', 'smooth jazz', 'lo-fi',
  'deep house', 'house', 'dance pop', 'pop', 'gospel', 'highlife', 'bossa nova',
  'acoustic', 'chill', 'latin', 'rock', 'classical'
];

const VENUE_PRESETS = {
  cafe: ['acoustic', 'jazz', 'lo-fi', 'neo soul'],
  restaurant: ['jazz', 'soul', 'bossa nova', 'r&b'],
  lounge: ['afrobeats', 'amapiano', 'r&b', 'deep house'],
  bar: ['afrobeats', 'hip hop', 'dancehall', 'amapiano'],
  club: ['amapiano', 'afro house', 'dancehall', 'hip hop'],
  hotel: ['smooth jazz', 'soul', 'chill', 'bossa nova'],
  gym: ['hip hop', 'dance pop', 'house', 'afrobeats'],
  retail: ['pop', 'r&b', 'dance pop', 'afrobeats']
};

function defaultGenres(venueType) {
  return VENUE_PRESETS[venueType] || VENUE_PRESETS.lounge;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class PlaybackEngine {
  constructor({ db, spotify, getToken, broadcast }) {
    this.db = db;
    this.spotify = spotify;
    this.getToken = getToken;     // (venue, { force }) => access token
    this.broadcast = broadcast;   // (venueId, type, data)
    this.venues = new Map();      // venueId -> runtime state
  }

  state(venueId) {
    if (!this.venues.has(venueId)) {
      this.venues.set(venueId, {
        running: false,
        timer: null,
        ticking: false,
        dirty: false,
        deviceId: null,
        lastTrackUri: null,
        lastDurationMs: 0,
        lastProgressMs: 0,
        pushed: null,            // { forUri, uri, queueId? }
        userPaused: false,
        station: [],
        stationGenresKey: '',
        recent: [],
        backoffUntil: 0,
        status: { state: 'stopped', message: 'Music is stopped' }
      });
    }
    return this.venues.get(venueId);
  }

  status(venueId) {
    const st = this.state(venueId);
    return { running: st.running, paused: st.userPaused, deviceId: st.deviceId, ...st.status };
  }

  setStatus(venueId, state, message) {
    const st = this.state(venueId);
    if (st.status.state === state && st.status.message === message) return;
    st.status = { state, message };
    this.broadcast(venueId, 'engine_status', this.status(venueId));
  }

  // ---------- lifecycle ----------

  async resumeAll() {
    const ids = await this.db.getRunningVenueIds();
    for (const id of ids) {
      const venue = await this.db.getVenueById(id);
      // Browser players get a new device id on every page load; wait for the page to report it.
      if (venue.playback_mode === 'device' && venue.playback_device_id) {
        await this.start(id, { deviceId: venue.playback_device_id, transfer: false }).catch(() => {});
      }
    }
  }

  async start(venueId, { deviceId, transfer = true } = {}) {
    const st = this.state(venueId);
    const venue = await this.db.getVenueById(venueId);
    if (!venue.spotify_connected) {
      this.setStatus(venueId, 'not_connected', 'Connect Spotify in the dashboard');
      throw Object.assign(new Error('Connect Spotify first'), { status: 400 });
    }
    st.deviceId = deviceId || (venue.playback_mode === 'device' ? venue.playback_device_id : st.deviceId);
    if (!st.deviceId) {
      this.setStatus(venueId, 'no_device', 'Choose a speaker, or open the Player page');
      throw Object.assign(new Error('No playback device selected'), { status: 400 });
    }
    st.running = true;
    st.userPaused = false;
    await this.db.updateVenuePlayback(venueId, { engine_running: 1 });
    if (transfer) {
      const token = await this.getToken(venue);
      await this.spotify.transfer(token, st.deviceId, false).catch(() => {});
    }
    this.schedule(venueId, 0);
  }

  async stop(venueId) {
    const st = this.state(venueId);
    st.running = false;
    clearTimeout(st.timer);
    st.timer = null;
    await this.db.updateVenuePlayback(venueId, { engine_running: 0 });
    const venue = await this.db.getVenueById(venueId);
    if (venue && venue.spotify_connected) {
      const token = await this.getToken(venue).catch(() => null);
      if (token) await this.spotify.pause(token, st.deviceId).catch(() => {});
    }
    this.setStatus(venueId, 'stopped', 'Music is stopped');
  }

  // Browser player page reported its Spotify device id.
  async attachBrowserDevice(venueId, deviceId) {
    const venue = await this.db.getVenueById(venueId);
    if (venue.playback_mode !== 'browser') return false;
    await this.start(venueId, { deviceId, transfer: true });
    return true;
  }

  // Something changed (guest added a song, settings saved): re-evaluate soon.
  nudge(venueId) {
    const st = this.state(venueId);
    if (!st.running) return;
    if (st.ticking) { st.dirty = true; return; }
    this.schedule(venueId, 200);
  }

  schedule(venueId, ms) {
    const st = this.state(venueId);
    clearTimeout(st.timer);
    if (!st.running) return;
    st.timer = setTimeout(() => this.tick(venueId), Math.max(ms, st.backoffUntil - Date.now(), 0));
  }

  // ---------- controls ----------

  async pause(venueId) {
    const st = this.state(venueId);
    const venue = await this.db.getVenueById(venueId);
    st.userPaused = true;
    await this.spotify.pause(await this.getToken(venue), st.deviceId).catch(() => {});
    this.setStatus(venueId, 'paused', 'Paused by staff');
  }

  async resume(venueId) {
    const st = this.state(venueId);
    const venue = await this.db.getVenueById(venueId);
    st.userPaused = false;
    if (!st.running) return this.start(venueId);
    await this.spotify.play(await this.getToken(venue), st.deviceId).catch(() => {});
    this.schedule(venueId, 500);
  }

  async skip(venueId) {
    const st = this.state(venueId);
    const venue = await this.db.getVenueById(venueId);
    const token = await this.getToken(venue);
    st.userPaused = false;
    st.pushed = null;
    const queue = await this.db.getQueue(venueId);
    if (queue.length) {
      await this.playGuest(venue, token, queue[0]);
    } else if (venue.autofill_enabled) {
      await this.startBackground(venue, token, { skipping: true });
    } else {
      await this.spotify.pause(token, st.deviceId).catch(() => {});
      await this.db.clearNowPlaying(venueId);
      st.lastTrackUri = null;
      this.broadcast(venueId, 'now_playing', null);
      this.setStatus(venueId, 'idle', 'Waiting for guests to add songs');
    }
    this.schedule(venueId, 1500);
  }

  // ---------- the loop ----------

  async tick(venueId) {
    const st = this.state(venueId);
    if (!st.running || st.ticking) return;
    st.ticking = true;
    st.dirty = false;
    let nextIn = IDLE_POLL_MS;
    try {
      nextIn = await this.step(venueId);
    } catch (error) {
      nextIn = await this.handleError(venueId, error);
    } finally {
      st.ticking = false;
      this.schedule(venueId, st.dirty ? 200 : nextIn);
    }
  }

  async step(venueId) {
    const st = this.state(venueId);
    const venue = await this.db.getVenueById(venueId);
    if (!venue || !venue.spotify_connected) {
      this.setStatus(venueId, 'not_connected', 'Connect Spotify in the dashboard');
      st.running = false;
      return IDLE_POLL_MS;
    }
    const token = await this.getToken(venue);
    const pb = await this.spotify.getPlaybackState(token);
    const queue = await this.db.getQueue(venueId);
    const item = pb && pb.item;

    // Nothing loaded on the account at all.
    if (!item) {
      if (st.userPaused) return IDLE_POLL_MS;
      if (queue.length && venue.auto_play !== 0) { await this.playGuest(venue, token, queue[0]); return NEAR_END_POLL_MS; }
      if (venue.autofill_enabled) { await this.startBackground(venue, token); return NEAR_END_POLL_MS; }
      this.setStatus(venueId, 'idle', queue.length ? 'Songs waiting: press Skip/Play to start' : 'Waiting for guests to add songs');
      return IDLE_POLL_MS;
    }

    if (item.uri !== st.lastTrackUri) {
      const took = await this.onTrackChanged(venue, item, queue, pb);
      if (took) return NEAR_END_POLL_MS;
    }
    st.lastDurationMs = item.duration_ms || 0;

    if (!pb.is_playing) {
      if (st.userPaused) return IDLE_POLL_MS;
      // Stopped at the start of a track after the previous one ended, or the
      // track ran out with nothing queued: move on.
      const ended = pb.progress_ms === 0 || (st.lastDurationMs && st.lastProgressMs >= st.lastDurationMs - 5000);
      if (ended) {
        st.pushed = null;
        if (queue.length) { await this.playGuest(venue, token, queue[0]); return NEAR_END_POLL_MS; }
        if (venue.autofill_enabled) { await this.startBackground(venue, token); return NEAR_END_POLL_MS; }
        await this.db.clearNowPlaying(venueId);
        this.broadcast(venueId, 'now_playing', null);
        st.lastTrackUri = null;
        this.setStatus(venueId, 'idle', 'Waiting for guests to add songs');
        return IDLE_POLL_MS;
      }
      this.setStatus(venueId, 'paused', 'Paused on the Spotify device');
      return IDLE_POLL_MS;
    }

    st.lastProgressMs = pb.progress_ms;
    const deviceName = pb.device && pb.device.name;
    this.setStatus(venueId, 'playing', deviceName ? `Playing on ${deviceName}` : 'Playing');

    const remaining = (item.duration_ms || 0) - (pb.progress_ms || 0);
    if (remaining <= PUSH_WINDOW_MS && (!st.pushed || st.pushed.forUri !== item.uri)) {
      await this.pushNext(venue, token, item.uri, queue);
    }
    return remaining <= PUSH_WINDOW_MS + 10000 ? NEAR_END_POLL_MS : IDLE_POLL_MS;
  }

  // Hand Spotify the next track shortly before the current one ends.
  async pushNext(venue, token, currentUri, queue) {
    const st = this.state(venue.id);
    const nextGuest = queue[0];
    if (nextGuest && nextGuest.spotify_uri) {
      await this.spotify.addToQueue(token, nextGuest.spotify_uri, st.deviceId);
      st.pushed = { forUri: currentUri, uri: nextGuest.spotify_uri, queueId: nextGuest.id };
      return;
    }
    if (venue.autofill_enabled && venue.autofill_source === 'genre') {
      const track = await this.nextStationTrack(venue, token);
      if (track) {
        await this.spotify.addToQueue(token, track.uri, st.deviceId);
        st.pushed = { forUri: currentUri, uri: track.uri, track };
        return;
      }
    }
    // Playlist background music continues on its own (Spotify plays queued
    // guest songs, then resumes the playlist). Nothing to push.
    st.pushed = { forUri: currentUri, uri: null };
  }

  // Returns true if it started something else instead (caller should re-poll).
  async onTrackChanged(venue, item, queue, pb) {
    const st = this.state(venue.id);
    const expectedBackground = (st.pushed && st.pushed.uri === item.uri) ||
      (venue.autofill_enabled && venue.autofill_source === 'playlist' && pb && pb.context && pb.context.uri === venue.autofill_playlist_uri);
    st.lastTrackUri = item.uri;
    st.lastProgressMs = 0;
    const guest = queue.find(q => q.spotify_uri === item.uri || q.song_id === item.id ||
      (item.linked_from && q.song_id === item.linked_from.id));
    const current = await this.db.getNowPlaying(venue.id);
    if (current && current.spotify_uri === item.uri) {
      st.pushed = null;
      return false; // we already recorded it when we started it
    }
    if (guest) {
      await this.db.playQueueItem(venue.id, guest.id);
    } else if (queue.length && !expectedBackground) {
      // Spotify's own autoplay (or someone else) started a track while guests are waiting.
      await this.playGuest(venue, await this.getToken(venue), queue[0]);
      return true;
    } else {
      const track = trackFromApi(item);
      this.remember(venue.id, track.uri);
      await this.db.setBackgroundPlaying(venue.id, {
        id: track.id, title: track.title, artist: track.artist, album: track.album,
        albumArt: track.albumArt, uri: track.uri, durationMs: track.durationMs
      });
    }
    st.pushed = null;
    await this.broadcastState(venue.id);
    return false;
  }

  async playGuest(venue, token, song) {
    const st = this.state(venue.id);
    await this.spotify.play(token, st.deviceId, { uris: [song.spotify_uri || `spotify:track:${song.song_id}`] });
    await this.db.playQueueItem(venue.id, song.id);
    st.lastTrackUri = song.spotify_uri;
    st.lastProgressMs = 0;
    st.pushed = null;
    await this.broadcastState(venue.id);
  }

  async startBackground(venue, token, { skipping = false } = {}) {
    const st = this.state(venue.id);
    if (venue.autofill_source === 'playlist' && venue.autofill_playlist_uri) {
      // Keep the playlist going if it's already the context; otherwise start it shuffled.
      if (skipping) {
        const pb = await this.spotify.getPlaybackState(token).catch(() => null);
        if (pb && pb.context && pb.context.uri === venue.autofill_playlist_uri) {
          await this.spotify.next(token, st.deviceId);
          return;
        }
      }
      await this.spotify.setShuffle(token, true, st.deviceId).catch(() => {});
      await this.spotify.play(token, st.deviceId, { context_uri: venue.autofill_playlist_uri });
      st.lastTrackUri = null; // recorded on the next tick when Spotify reports the track
      this.setStatus(venue.id, 'playing', `Background music: ${venue.autofill_playlist_name || 'playlist'}`);
      return;
    }
    const track = await this.nextStationTrack(venue, token);
    if (!track) {
      this.setStatus(venue.id, 'idle', 'No background tracks found for the chosen genres');
      return;
    }
    await this.spotify.play(token, st.deviceId, { uris: [track.uri] });
    st.lastTrackUri = track.uri;
    st.lastProgressMs = 0;
    st.pushed = null;
    await this.db.setBackgroundPlaying(venue.id, track);
    await this.broadcastState(venue.id);
  }

  // ---------- genre mix ----------

  genresFor(venue) {
    const chosen = (venue.autofill_genres || '').split(',').map(g => g.trim()).filter(Boolean);
    return chosen.length ? chosen : defaultGenres(venue.type);
  }

  remember(venueId, uri) {
    const st = this.state(venueId);
    st.recent.push(uri);
    if (st.recent.length > RECENT_LIMIT) st.recent.shift();
  }

  async nextStationTrack(venue, token) {
    const st = this.state(venue.id);
    const genres = this.genresFor(venue);
    const key = genres.join('|') + `|${venue.allow_explicit}`;
    if (key !== st.stationGenresKey) {
      st.station = [];
      st.stationGenresKey = key;
    }
    if (st.station.length < STATION_MIN) await this.refillStation(venue, token, genres);
    while (st.station.length) {
      const track = st.station.shift();
      if (!st.recent.includes(track.uri)) {
        this.remember(venue.id, track.uri);
        return track;
      }
    }
    return null;
  }

  async refillStation(venue, token, genres) {
    const st = this.state(venue.id);
    const seen = new Set([...st.recent, ...st.station.map(t => t.uri)]);
    const pages = await Promise.all(genres.flatMap(genre =>
      // Two random pages per genre (search returns at most 10 per page).
      [0, 1].map(() => this.spotify.searchByGenre(token, genre, Math.floor(Math.random() * 20) * 10).catch(() => []))
    ));
    const fresh = [];
    for (const track of pages.flat()) {
      if (!track || seen.has(track.uri)) continue;
      if (!venue.allow_explicit && track.explicit) continue;
      seen.add(track.uri);
      fresh.push(track);
    }
    st.station.push(...shuffle(fresh));
  }

  // ---------- helpers ----------

  async broadcastState(venueId) {
    const [nowPlaying, queue] = await Promise.all([this.db.getNowPlaying(venueId), this.db.getQueue(venueId)]);
    this.broadcast(venueId, 'now_playing', nowPlaying);
    this.broadcast(venueId, 'queue_updated', { queue });
  }

  async handleError(venueId, error) {
    const st = this.state(venueId);
    const status = error.status;
    if (status === 429) {
      const wait = Math.max((error.retryAfter || 5) * 1000, 5000);
      st.backoffUntil = Date.now() + wait;
      return wait;
    }
    if (status === 401) {
      const venue = await this.db.getVenueById(venueId);
      await this.getToken(venue, { force: true }).catch(() => {});
      return 1000;
    }
    if (status === 404) {
      this.setStatus(venueId, 'device_offline', 'Speaker not found. Open Spotify on the device (or the Player page) and press Start');
      return 10000;
    }
    if (status === 403) {
      this.setStatus(venueId, 'error', 'Spotify refused playback (Premium required, or the device is restricted)');
      return 15000;
    }
    console.error(`[Engine ${venueId}]`, error.message);
    this.setStatus(venueId, 'error', 'Playback problem, retrying...');
    return 8000;
  }
}

module.exports = { PlaybackEngine, GENRES, VENUE_PRESETS, defaultGenres };
