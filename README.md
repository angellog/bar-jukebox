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

Playback uses the Spotify Web Playback SDK in the player tab, controlled by the server over WebSockets. The venue connects **its own Spotify Premium account** from the admin dashboard; the platform supplies one Spotify developer app for everyone.

## Run locally

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL + Spotify app credentials
npm start              # http://localhost:3000
```

Requires Node 20+ and PostgreSQL. The schema is created automatically on boot.

## Deploy (Railway)

The Railway project `queueplay-jukebox` has two services: `queueplay-jukebox` (this app) and `Postgres`. The app service is connected to `angellog/bar-jukebox` on `main`, so **every push to `main` deploys automatically**.

Required variables: `DATABASE_URL` (reference `${{Postgres.DATABASE_URL}}`), `BASE_URL`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SUPER_ADMIN_KEY`, `SALT`. Health check: `GET /api/health`.

In the Spotify developer dashboard, the redirect URI must be exactly `${BASE_URL}/auth/spotify/callback`. While the Spotify app is in **Development mode**, only Spotify users added under *User Management* can connect; apply for extended quota before onboarding real venues.

## Security notes

- Venue admin passwords use scrypt (legacy SHA-256 hashes are upgraded on next login).
- Spotify OAuth `state` is HMAC-signed and expires after 15 minutes.
- Guests are rate-limited per venue by cookie (cooldown + daily cap, both capped by plan).

## Not built yet

- Billing: plans exist and the super admin can change a venue's plan, but there is no Stripe checkout.
