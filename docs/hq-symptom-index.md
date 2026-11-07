# HQ symptom index (agents)

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


Quick map from **what the Maître sees** → **what to read in the bundle first** → **where code usually lives**.  
Always start with **`GET /api/diag/agent-brief`** or **`session-bundle`** and read **`agent_triage`** before grepping the repo.

---

## How to use this table

1. Open **`agent_triage.top_issues`** and **`likely_subsystem`**.
2. If **`capture_hint`** is set → fix capture first (no codebase search yet).
3. Use **`slowest_marks`** for lag; **`timeline`** for order of events.
4. Match **`request_id`** between client lines and **`server_errors`**.

---

| Symptom | Bundle fields | Subsystem | Code / docs (usual) |
|--------|-------------|-----------|---------------------|
| Blank or stuck **Carnet** | `view_context.last_view=carnet`; client `carnet` / `perf-mark` `carnet` + `script-load` or `poll`; readiness `carnet_read` | `carnet` | `assets/hq-carnet.js`, lazy load in `iphone_bridge.py` (`hqCarnetLoad`, `hqCarnetShow`) |
| **Forge** won't open / slow | `perf-mark` `forge` + `script-load` / `forge-show`; view `forge` | `forge` | `assets/hq-forge.js`, `hqForgeLoad` in `iphone_bridge.py` |
| **Intime / companion** lag or freeze | `slowest_marks` `companion` + `live2d-frame`; view `intime` | `companion` | `assets/hq-companion.js` |
| **Dessiner / sketch** broken | `perf-mark` `dessiner` + `show`; view `dessiner` | `dessiner` | `assets/hq-dessiner.js`, `hqSketchShow` in bridge inline JS |
| **API slow** (any screen) | `perf-mark` `api` + `fetch-slow`; `data.path` | `bridge` / route owner | Handler in `iphone_bridge.py`; backend module for that `/api/…` path |
| **500** on an action | `top_issues` with `#request_id`; `server_errors` same id; `timeline` server row | varies | Join on `request_id`; see **`code`** in server error (`storage_error`, …) |
| **503 on /api/diag/ready** only | `readiness_degraded` check name; often **empty** `server_errors` | readiness | Missing asset / config — **not** the same as app 500 flood (see playbook) |
| **Missing JS/CSS** | `readiness_degraded.static_assets`; 404 on `/assets/…` | `static_assets` | `assets/` tree, `required_assets` in `hq_diagnostics.py` |
| **Nothing in client_log** | `agent_triage.capture_hint` | — | Enable `client_debug_hud` or `HQ_CLIENT_DEBUG=1`, restart bridge, hard-refresh |
| **Lag after changing screen** | `view_context.recent_nav`; `nav` + `setView-commit` with high `ms` | `nav` / target view | Inline `setView` in `iphone_bridge.py` |
| Maître left **repro steps** | `repro_notes`; timeline `source=repro` | — | HUD **Note** or `POST /api/hq/repro-note` |

---

## Stable server `code` values (5xx)

When **`server_errors[].code`** is present, prefer **`agent_triage.error_code_hints`** and **`request_id_index`**, then **[hq-error-codes.md](hq-error-codes.md)**.

---

## Stop rules (save quota)

- **Do not** search the repo until **`agent_triage.capture_hint`** is cleared and you have **`top_issues`** or **`slowest_marks`**.
- **Do not** treat readiness **503** on `/api/diag/ready` as a generic “app error” without reading **`degraded_now`**.
- **Do** paste **`brief_md`** from **`GET /api/diag/agent-brief`** into chat when escalating to another agent.

See also: **[agent-debugging.md](agent-debugging.md)**.
