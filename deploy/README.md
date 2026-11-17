# QueuePlay → Oracle VM (zero monthly bills)

Part of the 17 Nov 2026 zero-bill plan. QueuePlay leaves Railway ($/month) for the shared
Oracle Always Free VM (`~/Projects/oracle-vm`), with its database in the VM's shared Postgres.

## Why the VM, not Neon / Vercel / Cloudflare

| Option | Verdict |
|---|---|
| **Oracle VM + VM Postgres** | ✅ Chosen. The playback engine (`src/engine.js`) runs a timer per venue and polls Spotify + Postgres every few seconds, and guests/players hold WebSockets. That needs one process running all the time. |
| Neon free | ❌ The engine never lets the database sleep: ~720 compute-hours a month against a 100 CU-h cap. |
| Vercel / Cloudflare Workers | ❌ Serverless: no long-lived timers or WebSocket server. (`vercel.json` removed, it never worked for this app.) |

Cost after cutover: **$0**. Backups: the shared base's nightly `pg_dump` → R2 covers the
`queueplay` database, and the super-admin **⬇ Download backup** button keeps working.

## Files

| File | What it does |
|---|---|
| `Dockerfile` | Node 20 alpine image, runs as `node`, health check on `/api/health` |
| `deploy/compose.yml` | `queueplay` container on the shared `infra` network (384 MB, 0.5 CPU); optional `staging` profile |
| `deploy/Caddyfile.snippet` | HTTPS hostname → `queueplay:3000` (WebSockets work as-is) |
| `deploy/.env.vm.example` | Env for the VM; values come from Railway unchanged |
| `deploy/migrate-db.sh` | Railway Postgres → VM Postgres (dump, create role/db, restore, row counts) |
| `.github/workflows/deploy-vm.yml` | Auto-deploy on push to `main` over SSH (off until secrets set) |

## Prerequisites (blocking)

1. The VM is running (`~/Projects/oracle-vm/bin/vm-retry-service status`) and the shared base
   is up: Docker, Caddy, Postgres, network `infra`.
2. **A hostname for QueuePlay** (`QUEUEPLAY_HOST`) with an A record → VM IP. This must be a
   name you'll keep for good: it's in every QR code and printed table card.

## Cutover (≈20 min, do it outside bar hours)

```bash
# On the VM
git clone https://github.com/angellog/bar-jukebox ~/apps/bar-jukebox && cd ~/apps/bar-jukebox
cp deploy/.env.vm.example .env && chmod 600 .env   # fill in from Railway; SALT must match
```

1. **Spotify dashboard**: add redirect URI `https://<QUEUEPLAY_HOST>/auth/spotify/callback` (keep the Railway one until the end).
2. **Flutterwave dashboard**: set the webhook to `https://<QUEUEPLAY_HOST>/api/webhooks/flutterwave`.
3. **Freeze Railway**: Railway → queueplay-jukebox → production → scale the app to 0 replicas (Postgres stays up).
4. Railway Postgres → Settings → Networking → enable **TCP Proxy**; copy `DATABASE_PUBLIC_URL`.
5. On the VM:
   ```bash
   RAILWAY_DATABASE_URL='<DATABASE_PUBLIC_URL>' QUEUEPLAY_DB_PASSWORD='<same as in .env>' deploy/migrate-db.sh
   docker compose -f deploy/compose.yml up -d --build app
   ```
6. Add `deploy/Caddyfile.snippet` to the shared Caddyfile (`QUEUEPLAY_HOST=<host>`), reload Caddy.
7. Check: `npm run smoke -- https://<QUEUEPLAY_HOST>` from the Mac (add `SUPER_ADMIN_KEY=…` for the full run), log in to one venue, play a song.
8. Venues: each one downloads/prints its new QR from the dashboard (old Railway QR codes stop working when Railway is cancelled).
9. GitHub → Settings → Secrets → Actions: add `VM_HOST`, `VM_SSH_KEY`. Push to `main` deploys from then on.
10. After 7 quiet days: delete the Railway projects `queueplay-jukebox` **and** the leftover `bar-jukebox`, remove `railway.toml` and `.github/workflows/db-backup.yml`, delete the Railway redirect URI in Spotify.

## Rollback

Until step 10, Railway still has the old database: scale the Railway app back to 1 and point
Flutterwave's webhook back. Data written on the VM after cutover would need a manual merge
(`scripts/restore-backup.js --merge` with a super-admin backup file).
