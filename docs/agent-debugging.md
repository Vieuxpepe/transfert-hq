# Agent playbook — HQ browser & bridge debugging

Use this when you (or the Maître) need to find **errors**, **slow API**, or **which subsystem is lagging**, without remembering the full pipeline.

---

## 1. Turn logging on (if nothing is being captured)

In **`bridge_config.json`** on the machine running `iphone_bridge.py`:

```json
"client_debug_hud": true,
"client_debug_agent": true,
"client_debug_perf_interval_sec": 15
```

| Key | Effect |
|-----|--------|
| `client_debug_hud` | Perf HUD + ship logs to disk |
| `client_debug_agent` | Less perf noise; view changes + marks still logged; 50-line copy buffer |
| `client_debug_perf_interval_sec` | `0` = perf only at page load/unload; `15` = every 15s |

Override: environment **`HQ_CLIENT_DEBUG=1`**. Disable: `HQ_CLIENT_DEBUG=0` or `"client_debug_hud": false`.

Then **restart the bridge** and **hard-refresh** HQ (Ctrl+F5).

---

## 2. Fastest path — one admin request

Authenticated **admin** session (PIN):

```http
GET /api/diag/agent-brief?limit=50
GET /api/diag/agent-brief?limit=50&session_id=<hex>
```

**Prefer brief for agents** — compact JSON + pasteable **`brief_md`**, without full `client_log`.

Full tail when needed:

```http
GET /api/diag/session-bundle?limit=50
GET /api/diag/session-bundle?limit=50&session_id=<hex>
```

Optional **`session_id`** filters the **client log tail** to one browser tab (same id as HUD `#…` and `X-HQ-Session`).

```http
GET /api/diag/lag-captures?limit=10
GET /api/diag/lag-capture/<basename>.webp
GET /api/diag/lag-capture/<basename>.jpg
```

Admin only. Basename must match the safe `lag_*.png` pattern (no path traversal). Use with PIN login or in-session admin cookie.

**Lag spike auto-packet:** a successful **`POST /api/hq/lag-capture`** refreshes **`.hq-carnet/diagnostics/agent-packet-latest.md`** on disk (same content as **Packet** / `save-agent-packet`).

Both include **`agent_triage`** and **`timeline`** (`timeline` lag rows include screenshot paths when present).

### `agent_triage` (read this first)

| Field | Use |
|-------|-----|
| `capture_ok` / `capture_hint` | If hint is set → enable HUD, repro, re-fetch **before** code search |
| `top_issues` | Up to 5 joined client/server/repro/readiness bullets (includes **recent lag spike** when &lt; ~15 min) |
| `last_lag_spikes` | Tail of `kind=lag-spike` rows: `at`, `reason`, `screenshot_rel`, `view`, `session_id`, `capture_route` |
| `slowest_marks` | Worst `perf-mark` rows by `ms` |
| `degraded_now` | Flat readiness problems |
| `view_context` | `last_view` + recent nav / `setView-commit` |
| `likely_subsystem` | Rule-based hint (`carnet`, `companion`, `forge`, …) |
| `capture_effective` | HUD on/off, agent mode, perf interval, config vs env |

### `timeline`

Up to **40** events, sorted by time: **client**, **server**, **repro** — one skim for order of failure.

Symptom → file map: **[hq-symptom-index.md](hq-symptom-index.md)**.

### Full bundle fields (session-bundle only extras)

| Field | Use |
|-------|-----|
| `request_id_index` | Pre-joined client + server rows per `request_id` (max 30) |
| `config_effective` | Redacted debug flags + safe config (no secrets) |
| `client_log` | Recent browser lines (errors, API fails, perf-mark, view changes) |
| `server_errors` | Matching `errors.jsonl` entries |
| `request_ids` | Flat list of ids in the tail |
| `readiness_degraded` | Bridge/subsystems not OK |
| `last_client_view` | Last HQ screen (`accueil`, `carnet`, …) |
| `repro_notes` | Maître/agent repro notes (`POST /api/hq/repro-note` or HUD **Note**) |
| `redaction` | What is never stored (PIN, queries, paths, secrets) |

Error codes: **`agent_triage.error_code_hints`** · **[hq-error-codes.md](hq-error-codes.md)**.

**In the browser:** open **`/diagnostics`** → scroll **Journal navigateur**; use the same APIs from devtools if needed.

**In the HUD** (bottom-left when debug is on; draggable):

| Control | Action |
|---------|--------|
| **Copy** | Local line buffer + session + last API failure |
| **Brief** | Copy **`brief_md`** from `agent-brief` (admin); preferred for pasting into chat |
| **Spike** | Copy last lag capture path + last ~10 HUD lines + brief `top_issues` snippet |
| **Snap** | Download `session-bundle` as `.json` (admin) |
| **Bundle** | Copy full `session-bundle` JSON (admin); else local fallback |
| **Note** | Prompt → `POST /api/hq/repro-note` (appears in bundle `repro_notes`) |

Default **`client_debug_agent: true`** (bridge config): quieter journal (views, errors, slow/failed API, lag-spike) — full perf-mark HUD still available when **`client_debug_hud`** is on and agent mode is off.

Pending client-log batches survive a reload via **`sessionStorage`** (`hq-debug-pending-v1`) until POST succeeds.

---

## 3. Where files live on disk

Under the **Transfert root** (folder containing `iphone_bridge.py` / data):

| File | Contents |
|------|----------|
| `.hq-carnet/diagnostics/client-browser.jsonl` | Active browser log |
| `.hq-carnet/diagnostics/client-browser.jsonl.1` | Previous chunk (max **2** files, **200** lines each) |
| `.hq-carnet/diagnostics/lag-captures/lag_*.{webp,jpg,png}` | Lag spike captures (WebP/JPEG when Pillow available; max **50** files) |
| `.hq-carnet/diagnostics/agent-packet-latest.md` | Last auto/manual agent packet (brief + appendix) |

Ingest from the page: **`POST /api/hq/client-log`** (any logged-in role).

---

## 4. How to read a line (decision tree)

```
Is level "error" or fetch 4xx/5xx?
  → Read message, view, request_id → match server_errors / errors.jsonl

Is kind "lag-spike"?
  → Read data.reason, screenshot_rel / detail screenshot= → GET /api/diag/lag-capture/<name>.png

Is kind "perf-mark"?
  → Read data.subsystem + data.op + data.ms
     companion + live2d-frame  → intimate layer animation cost
     carnet + poll            → Carnet poll tick slow
     carnet / forge + script-load → lazy script bundle slow
     api + fetch-slow         → backend route slow (path in data)
     dessiner + show          → sketch panel init slow
     nav + view               → screen change (from/to in data)
     nav + setView-commit     → view commit slow (>120ms in inline setView)

Is kind "view"?
  → User navigated data-view (accueil → carnet, …)

Is kind "perf" (snapshot)?
  → Whole-tab FPS / heap / long-task count at that moment
```

Correlate everything with **`session_id`** (page load) on each line and **`X-HQ-Session`** on API calls (also stored on **server** `errors.jsonl` entries for 5xx).

Full field reference: **[client-debug-log.md](client-debug-log.md)**.

---

## 5. Reproduce & automate

| Command | Purpose |
|---------|---------|
| `python scripts/agent_hq_brief.py --pin 1427785` | Brief markdown (PIN in [agent-conventions.md](agent-conventions.md)) |
| `python scripts/agent_hq_brief.py --pin 1427785 --packet` | Full agent packet |
| `python scripts/fetch_session_bundle.py --pin 1427785 --brief --md` | Brief via fetch script |
| `python scripts/save_agent_packet.py --pin 1427785` | Save packet on disk |

**UAC:** On the Maître’s Windows host, elevation is **auto-accepted** — agents should run these commands without asking for UAC clicks.
| `python tests/test_hq_client_debug_smoke.py` | Bundle + client-log HTTP smoke |
| `python tests/visual_hq_client_debug_playwright.py` | HUD + session attr in browser |
| `python tests/test_hq_diagnostics_http.py` | Admin diag routes |

CI: **`.github/workflows/client-debug.yml`** · local: **`python scripts/verify_agent_pipeline.py`**.

---

## 8. Tier 3 — polish (optional depth)

| Feature | Use |
|---------|-----|
| **`agent_triage.recommended_files`** | First files to open after **`likely_subsystem`** |
| **`subsystem_map`** in brief | Machine-readable symptom → files map |
| **`POST /api/diag/save-agent-packet`** | Write **`packet_md`** to `.hq-carnet/diagnostics/agent-packet-latest.md` |
| **HUD Packet** / **`scripts/save_agent_packet.py`** | Handoff without pasting huge JSON |
| **Perf marks** `bridge boot-ready`, `fichiers list`, `nav setView-lazy` | Extra lag signals in **`slowest_marks`** |
| **Project skill** | `.cursor/skills/hq-incident/SKILL.md` — auto-guidance for HQ incidents |

Do **not** widen log retention or add distributed tracing here; use brief + packet + symptom index first.

## 6. Related code (when you need to change instrumentation)

| Piece | Location |
|-------|----------|
| HUD, marks, fetch wrap | `assets/hq-debug-panel.js` (`hqPerfMark`, `hqClientLog`) |
| Server ingest + bundle | `hq_diagnostics.py` (`_assemble_session_snapshot`, `agent_brief`, `CLIENT_LOG`) |
| Routes | `iphone_bridge.py` (`/api/diag/session-bundle`, `/api/hq/client-log`) |
| Admin page | `/diagnostics` → `assets/hq-diagnostics.js` |
| Companion frame cost | `assets/hq-companion.js` (`noteLive2dFrameCost`) |
| Carnet poll | `assets/hq-carnet.js` (`startPoll`) |
| Lazy loads | `iphone_bridge.py` (`hqCarnetLoad`, `hqForgeLoad`) |

---

## 7. Checklist for a new agent session

1. **`GET /api/diag/agent-brief`** (or Maître pastes **`brief_md`** from HUD/diagnostics).
2. If **`capture_hint`** → fix capture only; stop.
3. Read **`top_issues`**, **`likely_subsystem`**, **`view_context`**; use **[hq-symptom-index.md](hq-symptom-index.md)**.
4. Match **`request_id`** on **`timeline`** / **`server_errors`**.
5. For lag → **`slowest_marks`** (not manual sort of `client_log`).
6. Need raw lines → **`session-bundle`** `client_log`.

Do not ask the Maître to hunt paths under `%USERPROFILE%` unless bundle and `/diagnostics` are unavailable.
