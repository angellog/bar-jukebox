#!/usr/bin/env node
// Simulation test for the playback engine: a fake Spotify player with a
// controllable clock, against a real PostgreSQL database.
//
//   DATABASE_URL=postgresql://... node scripts/engine-test.js

const QueuePlayDB = require('../src/database');
const { PlaybackEngine } = require('../src/engine');

const DURATION = 60000;
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++; else failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
}

function fakeTrack(uri) {
  const id = uri.split(':').pop();
  return { uri, id, name: `Track ${id}`, duration_ms: DURATION, artists: [{ name: `Artist ${id}` }], album: { name: 'Album', images: [] }, explicit: false };
}

class FakeSpotify {
  constructor() { this.reset(); }
  reset() {
    this.current = null; this.progress = 0; this.playing = false;
    this.queue = []; this.context = null; this.contextTracks = []; this.contextIndex = 0;
    this.radio = false; this.calls = [];
  }
  log(name, arg) { this.calls.push(arg ? `${name}:${arg}` : name); }
  async getPlaybackState() {
    if (!this.current) return null;
    return {
      is_playing: this.playing, progress_ms: this.progress, item: fakeTrack(this.current),
      context: this.context ? { uri: this.context } : null, device: { name: 'Fake Speaker' }
    };
  }
  async transfer() { this.log('transfer'); }
  async play(token, deviceId, body) {
    if (body && body.uris) { this.log('play', body.uris[0]); this.current = body.uris[0]; this.context = null; this.progress = 0; this.queue = []; }
    else if (body && body.context_uri) {
      this.log('playContext', body.context_uri);
      this.context = body.context_uri; this.contextTracks = ['spotify:track:pl1', 'spotify:track:pl2', 'spotify:track:pl3'];
      this.contextIndex = 0; this.current = this.contextTracks[0]; this.progress = 0;
    } else this.log('resume');
    this.playing = true;
  }
  async pause() { this.log('pause'); this.playing = false; }
  async next() { this.log('next'); this.endTrack(); }
  async addToQueue(token, uri) { this.log('queue', uri); this.queue.push(uri); }
  async setShuffle() {}
  async searchByGenre(token, genre) {
    return Array.from({ length: 10 }, (_, i) => ({ id: `${genre}${i}`, title: `${genre} ${i}`, artist: 'X', album: '', albumArt: '', durationMs: DURATION, uri: `spotify:track:${genre.replace(/\W/g, '')}${i}${Math.random().toString(36).slice(2, 6)}`, explicit: false }));
  }
  endTrack() {
    if (this.queue.length) { this.current = this.queue.shift(); this.progress = 0; return; }
    if (this.context) {
      this.contextIndex = (this.contextIndex + 1) % this.contextTracks.length;
      this.current = this.contextTracks[this.contextIndex]; this.progress = 0; return;
    }
    if (this.radio) { this.current = `spotify:track:radio${Math.random().toString(36).slice(2, 6)}`; this.progress = 0; return; }
    this.playing = false; this.progress = 0; // stopped at start of the finished track
  }
  advance(ms) {
    if (!this.playing || !this.current) return;
    this.progress += ms;
    if (this.progress >= DURATION) this.endTrack();
  }
}

async function main() {
  const db = new QueuePlayDB(process.env.DATABASE_URL);
  await db.initializeSchema();
  const fake = new FakeSpotify();
  const events = [];
  const engine = new PlaybackEngine({
    db, spotify: fake,
    getToken: async () => 'token',
    broadcast: (venueId, type, data) => events.push({ type, data })
  });

  const slug = `engine-${Date.now().toString(36)}`;
  const { id: venueId } = await db.createVenue({ name: slug, slug, password_hash: 'x', type: 'lounge' });
  await db.updateVenueSpotifyTokens(venueId, { access_token: 't', refresh_token: 'r', expires_at: new Date(Date.now() + 3600e3).toISOString() });
  await db.updateVenueConfig(venueId, { max_queue_size: 50 });

  const st = engine.state(venueId);
  st.running = true;
  st.deviceId = 'dev1';

  // Run the engine for `ms` of simulated time, stepping like the real loop.
  async function run(ms, stepMs = 2000) {
    for (let t = 0; t < ms; t += stepMs) {
      await engine.step(venueId);
      fake.advance(stepMs);
    }
    await engine.step(venueId);
  }
  const addGuest = (n) => db.addToQueue(venueId, { id: `g${n}`, title: `Guest ${n}`, artist: 'Guest', uri: `spotify:track:g${n}`, durationMs: DURATION });
  const nowPlaying = async () => (await db.getNowPlaying(venueId)) || {};

  try {
    // 1. Idle, no background: nothing happens
    await run(4000);
    check('idle with no requests: plays nothing', !fake.current);

    // 2. Guests add three songs: they play in order, gapless (queued before the end)
    await addGuest(1); await addGuest(2); await addGuest(3);
    await run(2000);
    check('first guest song starts', fake.current === 'spotify:track:g1' && (await nowPlaying()).song_id === 'g1');
    await run(DURATION);
    check('second guest song follows in order', fake.current === 'spotify:track:g2' && (await nowPlaying()).song_id === 'g2');
    check('next song was queued on Spotify before the end (gapless)', fake.calls.includes('queue:spotify:track:g2'));
    await run(DURATION);
    check('third guest song follows', fake.current === 'spotify:track:g3');

    // 3. Adding a song mid-track never interrupts the current one
    await run(10000);
    const before = fake.current;
    await addGuest(4);
    engine.nudge(venueId);
    await run(4000);
    check('adding a song does not interrupt the current one', fake.current === before);
    await run(DURATION);
    check('added song plays after the current one', fake.current === 'spotify:track:g4');

    // 4. Queue runs out, no background music: stops cleanly
    await run(DURATION + 4000);
    check('queue empty without background music: stops', !fake.playing && !(await db.getNowPlaying(venueId)));

    // 5. Background genre mix fills silence
    await db.updateVenuePlayback(venueId, { autofill_enabled: 1, autofill_source: 'genre', autofill_genres: 'afrobeats,amapiano' });
    await run(4000);
    const np5 = await nowPlaying();
    check('background music starts when queue is empty', fake.playing && np5.source === 'background', np5.title);
    await run(DURATION);
    check('background keeps going track after track', fake.playing && (await nowPlaying()).source === 'background' && fake.current !== np5.spotify_uri);

    // 6. Guest request during background: waits for the background track to end, then plays
    await run(10000);
    const bgTrack = fake.current;
    await addGuest(5);
    engine.nudge(venueId);
    await run(6000);
    check('guest request does not cut the background track', fake.current === bgTrack);
    await run(DURATION);
    check('guest request plays right after the background track', fake.current === 'spotify:track:g5' && (await nowPlaying()).source === 'guest');
    await run(DURATION);
    check('background resumes after guest songs', (await nowPlaying()).source === 'background');

    // 7. Skip
    await addGuest(6);
    await engine.skip(venueId);
    check('skip jumps to the next guest song', fake.current === 'spotify:track:g6');

    // 8. Pause holds; resume continues
    await engine.pause(venueId);
    await run(8000);
    check('pause holds (engine does not restart music)', !fake.playing);
    await engine.resume(venueId);
    check('resume continues', fake.playing && fake.current === 'spotify:track:g6');

    // 9. Spotify autoplay radio can't block waiting guests
    await db.updateVenuePlayback(venueId, { autofill_enabled: 0 });
    fake.radio = true;
    await run(DURATION + 4000);
    check('Spotify autoplay radio took over after the queue emptied', fake.current.includes('radio'));
    await addGuest(7);
    engine.nudge(venueId);
    await run(4000);
    // the radio track counts as "someone else's" track: guests waiting jump in at its end
    await run(DURATION);
    check('waiting guest plays instead of more autoplay radio', fake.current === 'spotify:track:g7');
    fake.radio = false;

    // 10. Playlist background music
    await db.updateVenuePlayback(venueId, { autofill_enabled: 1, autofill_source: 'playlist', autofill_playlist_uri: 'spotify:playlist:abc', autofill_playlist_name: 'Lounge' });
    await run(DURATION + 6000);
    check('playlist background starts', fake.context === 'spotify:playlist:abc' && (await nowPlaying()).source === 'background');
    await run(10000);
    await addGuest(8);
    engine.nudge(venueId);
    await run(DURATION);
    check('guest song plays between playlist tracks', fake.current === 'spotify:track:g8');
    await run(DURATION);
    check('playlist resumes after the guest song', fake.current.startsWith('spotify:track:pl') && (await nowPlaying()).source === 'background');

    const order = (await db.getHistory(venueId, 100)).filter(h => h.added_by !== 'background').map(h => h.song_id).reverse();
    check('guest songs played in the order added', JSON.stringify(order) === JSON.stringify(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']), order.join(','));
  } finally {
    await db.deleteVenue(venueId);
    await db.close();
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
