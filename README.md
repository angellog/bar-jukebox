# 🎵 QueuePlay (bar-jukebox)

White-label, multi-venue music queue for bars, cafes and lounges. Guests scan a QR code, search Spotify, and add songs; the venue's player tab plays them in order through the speakers.

**Live:** https://queueplay-jukebox-production.up.railway.app

## How it works

| Page | URL | Who |
|---|---|---|
| Landing / pricing / sign-up | `/`, `/pricing`, `/register` | Venue owners |
| Guest jukebox | `/v/:slug` | Guests (via QR code) |
| Admin dashboard | `/admin/:slug` | Venue staff: queue, branding, limits, QR, Spotify connect |
| Player | `/player/:slug` | The device plugged into the speakers (Spotify Premium) |
| Super admin | `/superadmin` | Platform owner (`SUPER_ADMIN_KEY`) |

The venue connects **its own Spotify Premium account** from the admin dashboard; the platform supplies one Spotify developer app for everyone.

**Playback is driven by the server** (`src/engine.js`) on whichever Spotify device the venue chooses in *Music & Speaker*:

- **Spotify speaker or app** (no screen needed): a phone/tablet running Spotify plugged into the sound system, or a Spotify Connect speaker (Sonos, Echo, Google, smart TV, Chromecast).
- **This browser**: the `/player/:slug` page (Web Playback SDK) acts as the speaker and shows Now Playing + Up next.

Guest songs play in the order added. Shortly before a track ends the engine queues the next one on Spotify, so transitions are gapless. When no requests are waiting, optional **background music** plays: a genre mix (defaults by venue type) or a Spotify playlist. Guest requests always play next, after the current track.

## Run locally

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL + Spotify app credentials
npm start              # http://localhost:3000
```

Requires Node 20+ and PostgreSQL. The schema is created automatically on boot.

## Deploy (Railway)

Railway project `queueplay-jukebox`, two environments, each with its own app + Postgres:

| Environment | URL | Branch |
|---|---|---|
| production | https://queueplay-jukebox-production.up.railway.app | `main` |
| staging | https://queueplay-jukebox-staging.up.railway.app | `main` (point it at a feature branch to test new work) |

Workflow: build on a feature branch → test on staging → merge to `main` → production. Releases are tagged (`v1.0.0-mvp`, `v1.1.0`); roll back by redeploying a tag.

The GitHub push webhook isn't firing (Oct 2026). Until Railway's GitHub app is granted access to this repo, trigger deploys from the Railway dashboard or by reconnecting the service source.

Required variables: `DATABASE_URL` (reference `${{Postgres.DATABASE_URL}}`), `BASE_URL`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SUPER_ADMIN_KEY`, `SALT`. Health check: `GET /api/health`.

**Spotify Development Mode (since Mar 2026):** client-credentials tokens can no longer search, so guest search runs on the venue's connected Spotify account. A venue must connect Spotify before guests can search. The app owner's account needs Premium, and only 5 Spotify users can connect until Spotify grants extended quota.

In the Spotify developer dashboard, add the redirect URI for **each** environment, exactly `${BASE_URL}/auth/spotify/callback` (production and staging). While the Spotify app is in **Development mode**, only Spotify users added under *User Management* can connect; apply for extended quota before onboarding real venues.

## Testing

```bash
DATABASE_URL=... npm run test:engine                         # playback engine simulation (fake Spotify)
npm run smoke -- http://localhost:3000                       # read-only checks
SUPER_ADMIN_KEY=... npm run smoke -- <url>                    # also registers, exercises, then deletes a test venue
```

## Limits (who can use it)

- **Guests:** no cap on how many people can scan and add songs. Each phone is limited by the venue's Settings → Guest Rate Limits (cooldown, songs per day) and the queue size.
- **Venues:** no cap in the app. The real limit is Spotify: each venue connects its own Spotify Premium account, and while the Spotify app is in Development Mode only **5 Spotify accounts** can connect, so **5 venues**. One Spotify account can't power two venues at once (Spotify plays on one device per account).
- **Players:** one player tab per venue. Opening a second one takes over and idles the first.

## Security notes

- Venue staff log in with their password; the server sets a signed, httpOnly session cookie (30 days). No admin key to copy around. `x-admin-key` header still works for scripts.
- Connecting Spotify requires an admin session.
- Venue admin passwords use scrypt (legacy SHA-256 hashes are upgraded on next login).
- Spotify OAuth `state` is HMAC-signed and expires after 15 minutes.
- Guests are rate-limited per venue by cookie (cooldown + daily cap, both capped by plan).

## Not built yet

- Billing: plans exist and the super admin can change a venue's plan, but there is no Stripe checkout.
- Venues connected before v1.1 must reconnect Spotify once to let QueuePlay list their playlists (new scope); playback works without it.
