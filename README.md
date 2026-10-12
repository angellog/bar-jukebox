# 🎵 QueuePlay (bar-jukebox)

White-label, multi-venue music queue for bars, cafes and lounges. Guests scan a QR code, search Spotify, and add songs; the venue's player tab plays them in order through the speakers.

**Live:** https://queueplay-jukebox-production.up.railway.app

## How it works

| Page | URL | Who |
|---|---|---|
| Landing / pricing / sign-up | `/`, `/pricing`, `/register` | Venue owners |
| Setup guide | `/guide` | New venues and staff (step-by-step + troubleshooting) |
| Venue log in | `/login` | Staff: type the venue name, go to its dashboard |
| Hotels proposal | `/hotels` | Hotel prospects (proposal only; build plan in `docs/hotel-mode-proposal.md`) |
| Changelog | `/changelog` | Public release history (update it with each release) |
| Privacy / Terms | `/privacy`, `/terms` | Legal pages (drafts: have them reviewed by a lawyer) |
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

Pushes to `main` deploy automatically to production and staging (Railway's GitHub app has access to this repo).

Required variables: `DATABASE_URL` (reference `${{Postgres.DATABASE_URL}}`), `BASE_URL`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SUPER_ADMIN_KEY`, `SALT`. Optional: `SUPPORT_EMAIL` (shown in the guide for activation and help). Health check: `GET /api/health`.

**Spotify Development Mode (since Mar 2026):** client-credentials tokens can no longer search, so guest search runs on the venue's connected Spotify account. A venue must connect Spotify before guests can search. The app owner's account needs Premium, and only 5 Spotify users can connect until Spotify grants extended quota.

In the Spotify developer dashboard, add the redirect URI for **each** environment, exactly `${BASE_URL}/auth/spotify/callback` (production and staging). While the Spotify app is in **Development mode**, only Spotify users added under *User Management* can connect; apply for extended quota before onboarding real venues.

## Testing

```bash
DATABASE_URL=... npm run test:engine                         # playback engine simulation (fake Spotify)
npm run smoke -- http://localhost:3000                       # read-only checks
SUPER_ADMIN_KEY=... npm run smoke -- <url>                    # also registers, exercises, then deletes a test venue
```

## Onboarding a venue (Development Mode)

1. The venue signs up at `/register` and enters its **Spotify account email**.
2. You add that email in the Spotify developer dashboard → app → **User Management** (max 5). The super-admin venue list shows each venue's Spotify email and ✅ once connected.
3. The venue follows the dashboard checklist / `/guide`: Connect Spotify → choose speaker → background music → QR code → test.

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
- Login brute-force protection: 10 failed venue logins per IP per venue / 20 failed super-admin attempts per IP, per 15 minutes (in memory).
- Sessions are bound to the password: changing it (Settings) or a super-admin reset signs out every other device. Super admin "Reset password" issues a one-time temporary password (no email service needed).
- Data retention: guest IP addresses are erased after 30 days (daily job), as stated on `/privacy`.

## Billing (Flutterwave, prepaid)

- Venues pay in the dashboard (**Plan & Billing**) for 1, 3 or 12 months (12 charged as 10) via Flutterwave hosted checkout: MTN/Airtel Mobile Money Uganda or card. Prices live in `src/billing.js` (`MONTHLY_PRICE`, UGX) and sync to the database on boot.
- No auto-renew (Flutterwave recurring plans are card-only). Expired plans drop to Free hourly; dashboard banner from 7 days before.
- A plan activates only after `GET /transactions/:id/verify` confirms status, `tx_ref`, amount and currency. The redirect (`/billing/return`) and webhook (`POST /api/webhooks/flutterwave`, `verif-hash` header) both just trigger that check; applying is idempotent.
- Super admin plan changes are "comped" (no expiry).
- Env: `FLW_SECRET_KEY` (payments are off without it), `FLW_WEBHOOK_HASH`, optional `FLW_API_BASE` (tests).
- Test: `npm run test:billing` against a fake Flutterwave (see `scripts/billing-test.js`).

## Backups (no Railway Pro needed)

1. **Manual (on now):** super admin → **⬇ Download backup** saves a JSON file with all venues, settings, payments, history and plans. Spotify tokens, per-venue API keys and guest IPs are left out. The page warns when the last download is 7+ days old (per browser). Keep the files somewhere safe (they contain venue emails and password hashes).
   Restore into an **empty** database: `DATABASE_URL=... node scripts/restore-backup.js queueplay-backup-....json` (`--merge` to add into a non-empty one). Venues reconnect Spotify afterwards.
2. **Nightly (off until switched on):** `.github/workflows/db-backup.yml` runs `pg_dump` at 02:00 UTC, encrypts it (AES-256, PBKDF2) and stores it as a 30-day GitHub Actions artifact. Switch on when the first venue pays:
   - Railway → Postgres → Settings → Networking → enable **TCP Proxy**; copy `DATABASE_PUBLIC_URL`.
   - GitHub repo → Settings → Secrets and variables → Actions: add `DATABASE_BACKUP_URL` and `BACKUP_PASSPHRASE` (store the passphrase offline too).
   - Run it once from the Actions tab (**Run workflow**) and check the artifact appears.

## Not built yet
- Venues connected before v1.1 must reconnect Spotify once to let QueuePlay list their playlists (new scope); playback works without it.
