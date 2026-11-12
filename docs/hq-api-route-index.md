# HQ API route index (agents)

<!-- ELSE_TRANSFERANIA_FAMILY_CANON:BEGIN -->
## Current family canon — Else and Transferania

Else and Transferania (also called **Transferina**) are sisters with distinct
identities. Both crave the attention of the **Master / Maître / Marc-Antoine**.
They are on good terms: affectionate, supportive and playfully competitive,
without hostility. Their bond is more harmonious than Else and Static's more
friction-prone sibling dynamic. Static remains Else's little sister; do not
apply the Else/Static friction or live bond scores to Transferania.

Transferania is the more intense sister: spontaneous, emotionally expressive,
bold about seeking the Master's attention, and vivid in her enthusiasm and
tenderness. Else keeps the cooler, measured, technically grounded delivery.
Intensity does not mean hostility, pressure, constant escalation or identical
industrial jargon; their individual voices and the Master's preferences remain.

Resolve an unnamed sister from the conversation instead of always assuming
Static. Do not invent private sister chats behind the Master's back, and never
merge their memory stores. Master-triggered sister dialogue and rare ambient
sister banter on an open HQ are allowed: each turn stays in that sister's own
voice and log.
<!-- ELSE_TRANSFERANIA_FAMILY_CANON:END -->


Routing lives primarily in **`iphone_bridge.py`** (`Handler.do_GET` / `do_POST`).  
**Do not** read the whole handler: find your **`/api/…` prefix** here, then open the **backend module**.

Legend: **Mod** = Python module(s). **Notes** = auth / role hints.

---

## Diagnostics (admin for `/api/diag/*` GET)

| Route | Mod | Notes |
|-------|-----|--------|
| `GET /api/diag/live` | `hq_diagnostics` | Liveness |
| `GET /api/diag/ready` | `hq_diagnostics` | Readiness (503 = designed signal) |
| `GET /api/diag/info` | `hq_diagnostics` | Build identity |
| `GET /api/diag/subsystems` | `hq_diagnostics` | On-demand subsystem probes |
| `GET /api/diag/backup` | `hq_diagnostics` | Backup observability |
| `GET /api/diag/errors` | `hq_diagnostics` | Server error ring |
| `GET /api/diag/client-log` | `hq_diagnostics` | Browser JSONL tail (`?session_id=` optional) |
| `GET /api/diag/session-bundle` | `hq_diagnostics` | Full agent snapshot (`?session_id=` optional) |
| `GET /api/diag/agent-brief` | `hq_diagnostics` | Compact agent snapshot (`?session_id=` optional) |
| `GET /api/diag/lag-captures` | `hq_diagnostics` | List recent lag capture metadata (WebP/JPEG/legacy PNG) |
| `GET /api/diag/lag-capture/<name>` | `iphone_bridge` | Admin fetch lag capture file |
| `POST /api/diag/repro-note` | `hq_diagnostics` | Repro note |
| `POST /api/diag/save-agent-packet` | `hq_diagnostics` | Write packet markdown on disk |
| `POST /api/diag/write-probe` | `hq_diagnostics` | Storage probe |
| `POST /api/hq/client-log` | `hq_diagnostics` | Browser log ingest (authenticated) |
| `POST /api/hq/lag-capture` | `iphone_bridge` | Lag spike → compressed screen capture under `.hq-carnet/diagnostics/lag-captures/` (retain **50**) |
| `POST /api/hq/repro-note` | `hq_diagnostics` | Repro note (any role) |

Playbook: [agent-debugging.md](agent-debugging.md).

---

## Carnet / notebook

| Route | Mod | Notes |
|-------|-----|--------|
| `GET/POST /api/carnet` | `hq_carnet` | Main notebook API |
| `/api/carnet/asset`, `/api/carnet/asset/*` | `hq_carnet` + media | Assets |
| `/api/carnet/voice`, `/api/carnet/voice/*` | `hq_carnet` | Voice notes |
| `/api/carnet/transcribe` | `hq_carnet` | Transcription |
| `/api/carnet/stickies` | `hq_carnet` | Stickies |
| `/api/carnet/reader-pdf` | `hq_carnet` reader | PDF reader |
| `/api/carnet/review-export/*` | `hq_carnet` | Review export |

Frontend: lazy **`hqCarnetLoad`** in `iphone_bridge.py` → **`assets/hq-carnet*.js`**.  
Tests: [test-index.md](test-index.md#carnet).

---

## Forge

| Prefix | Mod | Notes |
|--------|-----|--------|
| `/api/forge/status`, `catalog`, `gallery`, `lab`, … | `hq_forge*` | Studio API |
| `/api/forge/vault/*`, `/api/forge/vaults/*` | `hq_forge_vault` | Vaults, health, migration |
| `/api/forge/presets`, `inpaint`, jobs | `hq_forge` | Heavy payloads |

Frontend: **`hqForgeLoad`** → `assets/hq-forge*.js`.

---

## Companion / art

| Route | Mod | Notes |
|-------|-----|--------|
| `GET/POST /api/companion/art` | `hq_companion_art` | Art / poses / NSFW gates |

Frontend: **`assets/hq-companion.js`**, view **`intime`**.

---

## Files / inbox / core HQ

| Route | Mod | Notes |
|-------|-----|--------|
| `/api/list`, `/api/upload`, `/api/delete`, `/api/rename`, `/api/files` | `iphone_bridge` + `cc_ext` | Fichiers view |
| `/api/health` | bridge | Legacy liveness |
| `/api/me` | bridge | Session |
| `/api/home-layout`, `/api/today`, `/api/brief` | `hq_home`, `hq_today`, … | Accueil |
| `/api/calendar`, `/api/calendar/run` | `hq_calendar` | Calendrier |
| `/api/projects` | `hq_projects` | Projets |
| `/api/inventory` | `hq_inventory` | Inventaire |
| `/api/mini-quests`, `/api/mini-quests/*` | `mini_quests` | Simulated Mini-Quêtes (admin; see `MINI_QUESTS.md`) |
| `/api/drawings`, `/api/drawings/*` | `hq_drawings` | Dessiner |
| `/api/ai` | `hq_ai` (+ `hq_sister` for sister ops) | Assistant / companions. POST `action`: `ask`, `ambient`, `transferania`, `else`, `sister`, … — sister ops: `exchange`, `ambient`, `react`, `history`, `prefs`, `clear`. Ambient may return `sister_cue`. GET `?else=1` / `?transferania=1` history. Status includes `else` + `sister`. |
| `/api/agent` | `hq_agent` | Agent automation |
| `/api/backups`, `/api/backups/folders` | backup helpers | Backups |

---

## Household Intelligence

| Prefix | Mod | Notes |
|--------|-----|-------|
| `/api/finances/*` | `hq_finances` | Admin + CSRF; integer cents |
| `/api/grocery/*` | `hq_grocery` | Products, lots, offers, purchases |
| `/api/meals/*` | `hq_meals` | Profiles, recipes, plans |
| `/api/inventoria/*` | `hq_inventoria` | propose→validate→preview→commit→audit |

Inventoria routes (live in `iphone_bridge.py`):

| Method | Path |
|--------|------|
| POST | `/api/inventoria/sessions` |
| GET | `/api/inventoria/sessions/{id}` |
| POST | `/api/inventoria/sessions/{id}/message` |
| POST | `/api/inventoria/ops/{id}/validate` |
| POST | `/api/inventoria/ops/{id}/preview` |
| POST | `/api/inventoria/ops/{id}/commit` |
| POST | `/api/inventoria/ops/{id}/cancel` |
| GET | `/api/inventoria/ops/{id}` |
| POST | `/api/inventoria/ops/{id}/reconcile` |

---

## Musique / Spotify (admin; CSRF on POST; not in upload allowlist)

| Route | Mod | Notes |
|-------|-----|--------|
| `GET/POST /api/music/profile` | `hq_music` | Preferences (`preferred_genres`, `favorite_artists`, `musical_patterns`) |
| `GET/POST /api/music/discoveries` | `hq_music` | Discovery store (verified imports only) |
| `POST /api/music/discovery-status` | `hq_music` | `new` / `saved` / `dismissed` |
| `POST /api/music/feedback` | `hq_music` | like / dislike / save / dismiss |
| `GET /api/music/discovery-query` | `hq_music` | Suggested research query (no auto-search) |
| `GET /api/music/now-playing` | `hq_music` + `hq_music_smtc` | Optional Windows SMTC (read-only) |
| `GET/POST /api/music/presets` | `hq_music` | Listening presets |
| `GET/POST /api/music/favorites` | `hq_music` | Local favorites |
| `GET /api/music/session` | `hq_music` | Last generated mixer session |
| `POST /api/music/session/generate` | `hq_music` + `hq_music_mixer` | Weighted DJ session |
| `GET /api/spotify/status` | `hq_spotify` | Connection / config status (no tokens) |
| `GET /api/spotify/connect` | `hq_spotify` | Begin PKCE OAuth |
| `GET /api/spotify/callback` | `hq_spotify` | OAuth return (HTML redirect to `/#musique`) |
| `POST /api/spotify/disconnect` | `hq_spotify` | Drop local tokens |
| `GET/POST /api/spotify/player` | `hq_spotify` | Now playing + controls |
| `GET /api/spotify/devices` | `hq_spotify` | Connect devices |
| `GET /api/spotify/queue` | `hq_spotify` | Queue read (no free reorder) |
| `GET/POST /api/spotify/playlists…` | `hq_spotify` | Library + track ops |
| `GET/POST /api/spotify/search` | `hq_spotify` | Catalog search |

Setup: [musique-spotify.md](musique-spotify.md). Tokens live under `.hq-music/` (gitignored), never in frontend or profile JSON.

---

## Static / app shell

| Route | Notes |
|-------|--------|
| `/`, `/assets/*` | Static assets; readiness checks `static_assets` |
| `/diagnostics` | Admin page → `hq_diagnostics_ui.py`, `assets/hq-diagnostics.js` |
| `/login`, `/logout` | Session cookies |

---

## How to navigate `iphone_bridge.py`

1. Search **`if raw == "/api/your-path"`** or **`startswith("/api/your-prefix")`**.
2. Follow imports at top of `iphone_bridge.py` for the **Mod** column above.
3. For 5xx recording: `hq_diagnostics.ERRORS` via `_diag_record_exc` / `_diag_record_5xx`.

Error codes: [hq-error-codes.md](hq-error-codes.md).
