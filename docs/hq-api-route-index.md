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
