# Hotel mode: internal build plan

**Status:** proposal only. **Don't build until a hotel reaches out.** The public pitch is at `/hotels` (`public/hotels.html`).

## Pre-conditions (agree before writing code)

1. **Music source.** Hotels can't use consumer Spotify accounts (Spotify Developer Policy forbids business and public use), and each zone would use one of the 5 Development Mode accounts. Options, in order of preference:
   - **Soundtrack**: full API (search, `soundZoneQueueTracks`, play/pause/skip, `nowPlaying`), but not sold in Uganda or Kenya as of Oct 2026. Ask Soundtrack about East Africa availability or a partner deal.
   - **Epidemic Sound partnership**: owns its catalogue including public-performance rights; Partner API has search and streaming; production music, no chart hits; needs a signed agreement.
   - A Spotify demo for a short on-site pilot only (no paid deployment).
2. **UPRS licence** held by the property.
3. **TV platform.** Ask which IPTV / hospitality TV system they use (LG Pro:Centric, Samsung LYNK, Sonifi, other) and whether a QR code or link can be added to the welcome screen.

## What to build

| # | Piece | Notes | Estimate |
|---|---|---|---|
| 1 | **Hotel account + zones** | `hotels` table (id, slug, name, branding). `venues.hotel_id` (nullable) makes each zone a venue, so queues, rules, engine and background music are reused as-is. Hotel admin login sees all zones; zone staff can stay venue-scoped. | 3–4 days |
| 2 | **Zone picker page** `/h/:hotelSlug` | Lists zones with open/closed state and hours; links into each zone's guest page. One QR code per hotel for rooms and TVs, plus per-zone table QR codes. | 1–2 days |
| 3 | **Opening hours & quiet hours** | `zone_hours` (day, open, close). Guest add returns "Rooftop opens at 17:00" when closed; the engine pauses requests at close (background music optional). | 1–2 days |
| 4 | **Room number + per-room limits** | Optional `room` field on queue add; rate limits keyed by room when given (else cookie). Shown to staff in the queue. Delete room numbers after 30 days (as promised on `/hotels`). | 1 day |
| 5 | **Staff approval mode** | Per-zone toggle: requests land in `pending_approval`, and staff approve or reject from the dashboard (and from a phone-friendly view). | 1–2 days |
| 6 | **TV mode** `?tv=1` | Large type, D-pad / remote focus styles (`:focus-visible`, arrow-key navigation), on-screen keyboard-friendly search, no hover dependencies. Test on the hotel's actual TV browser. | 2–3 days |
| 7 | **Music provider adapter** | Engine already isolates provider calls (`spotify.*` in `src/engine.js`). Extract a provider interface (`search`, `queue`, `play`, `pause`, `skip`, `nowPlaying`, `devices/zones`) and implement it for the chosen business provider. | 4–6 days (provider-dependent) |
| 8 | **Group reporting** | Requests per zone per hour; top songs per zone; CSV export. | 1–2 days |

**Total:** roughly 3 weeks of build for 1–6 + 8, plus the provider adapter (7). This matches the "about 4 weeks to all zones live" on the public page if the provider is decided in week 1.

## Data retention promise on `/hotels`

The public page says: song, zone and (optional) room number are kept **30 days**; no names, phones or payment data. Implement a daily cleanup job when building #4.

## Discovery questions for the first hotel call

- Which spaces have music today, and how (speakers, who controls them)?
- Opening hours per space; any quiet hours or events?
- TV system brand and who manages it (in-house or vendor)?
- Current music service and UPRS status?
- Guest Wi-Fi setup (client isolation, captive portal)?
- Who signs off: GM, F&B manager or IT?
- Single property or group?
