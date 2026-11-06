# Client debug log (browser → disk)

Agent-oriented diagnostics for Transfert HQ: structured client events, server correlation, bounded retention.

## Enable

`bridge_config.json`:

```json
"client_debug_hud": true,
"client_debug_perf_interval_sec": 15,
"client_debug_log_when_collapsed": false,
"client_debug_agent": false
```

Or environment: `HQ_CLIENT_DEBUG=1`.

**Agent tuning:** `"client_debug_agent": true` — no periodic perf spam (start/exit only), view changes always logged, 50-line copy buffer.

## On disk

- Path: `<Transfert root>/.hq-carnet/diagnostics/client-browser.jsonl`
- Rotation: **200 lines** per file, **2 files** max (`client-browser.jsonl` + `.1`)

## Redaction contract (never in JSONL)

- PIN, session cookies, `Authorization` headers
- URL **query strings** (page path only)
- Full home/project paths (scrubbed to `<path>`)
- Webhook secrets, API keys, tokens > 31 chars (→ `<redacted>`)

Fields are scrubbed server-side in `hq_diagnostics.scrub` before append.

## JSONL entry shape

| Field | Purpose |
|-------|---------|
| `at` | UTC timestamp |
| `level` | log / info / warn / error |
| `kind` | perf, api, view, carnet, meta, **perf-mark**, **lag-spike**, … |
| `message` | Short human line |
| `view` | HQ `data-view` (accueil, carnet, …) |
| `session_id` | Page load id (`data-hq-session`, also `X-HQ-Session` on fetch) |
| `request_id` | Server JSON error body (match `errors.jsonl`) |
| `data` | Structured scrubbed object (status, path, ms, from/to view, …) |

### perf-mark (subsystem lag)

`window.hqPerfMark(subsystem, data, opts)` — throttled structured marks when work is slow:

| subsystem | op | When logged |
|-----------|-----|-------------|
| `companion` | `live2d-frame` | Frame ≥ ~50 ms or perf **pressure** toggles (throttled ~12 s) |
| `carnet` | `poll` | Poll tick ≥ ~12 ms |
| `carnet` | `script-load` | Lazy Carnet bundle load (forced if &gt; 800 ms or fail) |
| `forge` | `script-load` | Forge scripts load |
| `dessiner` | `show` | Sketch show ≥ ~16 ms |
| `nav` | `setView-commit` | View commit slow (>120ms) |
| `nav` | `setView-lazy` | Carnet/Forge lazy load after navigation |
| `bridge` | `boot-ready` | DOM ready + `/api/me` warm (forced at boot) |
| `fichiers` | `list` | `/api/list` refresh ≥ ~250ms |
| `nav` | `view` | View change (with `from` / `to`) |
| `api` | `fetch-slow` | Successful `/api/*` ≥ ~800 ms | `kind: perf-mark` and `data.subsystem` / `data.op` / `data.ms` in JSONL or session-bundle.

### lag-spike (desktop capture)

When the HUD detects a spike (**long task ≥ 120 ms**, **FPS &lt; 28**, or **Live2D frame ≥ 50 ms**), it `POST`s **`/api/hq/lag-capture`** (throttled **45 s** per session). The bridge grabs the **primary monitor** (Windows) into:

`.hq-carnet/diagnostics/lag-captures/lag_<timestamp>_<session>_<reason>.{webp,jpg}` (optional `*_hq.*`; **50** files max on disk)

A client log line follows: `kind: lag-spike`, `detail: screenshot=<rel path>`, `data.screenshot` same path (max **80** PNGs kept).

## HTTP (admin unless noted)

| Route | Role |
|-------|------|
| `POST /api/hq/client-log` | Any authenticated session — ingest batches |
| `POST /api/hq/lag-capture` | Any authenticated session — lag spike PNG (Windows primary screen) |
| `GET /api/diag/client-log?limit=40` | Admin — tail for `/diagnostics` page |
| `GET /api/diag/agent-brief?limit=50` | Admin — **compact** triage + `timeline` + pasteable **`brief_md`** (no full `client_log`) |
| `GET /api/diag/session-bundle?limit=50` | Admin — full tail + **`agent_triage`** + **`timeline`** |
| `POST /api/hq/repro-note` | Any authenticated session — `{ session_id, view, note }` |
| `POST /api/diag/repro-note` | Admin — same payload |
| `POST /api/diag/save-agent-packet` | Admin — write **`packet_md`** to `.hq-carnet/diagnostics/agent-packet-latest.md` |

### `agent_triage` (both brief and bundle)

Stable keys (see `hq_diagnostics.AGENT_TRIAGE_KEYS`): includes `error_code_hints` (server `code` → agent hint).

### `timeline`

Up to **40** merged events (`client` | `server` | `repro`); stable event keys in `AGENT_TIMELINE_EVENT_KEYS`.

### `agent_brief` / packet

Keys include `request_id_index`, `config_effective`, `brief_md`, **`packet_md`** (brief + JSON appendix for escalations). See `hq_diagnostics.AGENT_BRIEF_KEYS`.

Registry: **[hq-error-codes.md](hq-error-codes.md)**.

## HUD

- **Copy** — local buffer (+ session, last API failure)
- **Brief** — admin: **`brief_md`** from `agent-brief`; else hint text
- **Snap** — download admin `session-bundle` as `.json`
- **Bundle** — admin: full `session-bundle` to clipboard; else local JSON fallback
- **Note** — repro note tied to session (bundle `repro_notes`)
- **Packet** — admin: full **`packet_md`** (brief + JSON appendix)

## Carnet

Lazy-loaded Carnet uses the same global `fetch` wrapper and `window.hqClientLog()` / `hqClientLogView()` from `hq-debug-panel.js`. Missing Carnet module after load logs `kind: carnet`.
