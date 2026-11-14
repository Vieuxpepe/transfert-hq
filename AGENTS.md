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


# AGENTS.md — Transfert HQ agent contract

Read this first. **`docs/agent-conventions.md`** is the detailed global contract
(stop rules, handoff block, PIN/UAC). This file is the short entry point that the
README, the Cursor rules and `.github/workflows/agent-maps.yml` expect.

---

## What this repository is

**Transfert HQ v7 — Mission Control.** A single-operator personal bridge between
Windows PCs and an iPhone over LAN + Tailscale. Python standard library only
(`ThreadingHTTPServer`), local JSON state, no SaaS, no external database. The
admin PIN stays mandatory; the upload role is an explicit allowlist.

| Layer | Where |
|-------|-------|
| HTTP, auth, CSRF, routing | `iphone_bridge.py` (large — never read whole) |
| Feature modules | `hq_*.py` (events, calendar, carnet, forge, companion, household…) |
| Front end | `assets/*.js`, `assets/*.css` (lazy-loaded per view) |
| Tests | `tests/` (unittest + node `check_*.mjs`) |
| Verify scripts | `scripts/verify_*.py` |

---

## Before any codebase search

1. Classify the task (table below).
2. Open the **one** domain doc + skill for that class.
3. Check the **map** before grepping.
4. **Never** read multi-MB files whole (`assets/hq-carnet.js`, all of
   `iphone_bridge.py`). Use the maps and targeted `grep` (±80 lines).

| Task class | Doc | Skill (`.cursor/skills/`) |
|------------|-----|---------------------------|
| HQ incident (lag, API errors, empty log) | `docs/agent-debugging.md` | `hq-incident` |
| Carnet (notebook, pages, poll, UI) | `docs/carnet-agent-anchors.md` | `carnet-change` |
| Bridge / new HTTP route | `docs/hq-api-route-index.md` | `bridge-route` |
| Companion (Intime, Live2D, voice) | `docs/companion-*.md` | `companion-behavior` |
| Forge (SD jobs, vaults, workers) | `docs/forge-workers.md` | `run-these-tests` |
| Tests / CI | `docs/test-index.md` | `run-these-tests` |

---

## Maps — check in before grep

| Map | Use |
|-----|-----|
| `docs/hq-api-route-index.md` | Which `/api/*` route lives in which module |
| `docs/frontend-view-index.md` | `data-view` → lazy scripts → hooks |
| `docs/hq-symptom-index.md` | User symptom → bundle fields → files |
| `docs/hq-error-codes.md` | Stable JSON `code` values |
| `docs/test-index.md` | What to run after a given change |
| `docs/carnet-agent-anchors.md` | Carnet grep anchors |
| `docs/agent-animation-pipeline.md` | Motion/perf reproduce → fix → verify |
| `docs/household/README.md` | Finances / Repas / Inventoria foundations |

---

## HQ debug pipeline (summary)

Full playbook: **`docs/agent-debugging.md`**.

1. If nothing is captured, enable it in `bridge_config.json`
   (`client_debug_hud`, `client_debug_agent`, `client_debug_perf_interval_sec`),
   restart the bridge, hard-refresh. Override: `HQ_CLIENT_DEBUG=1`.
2. **One admin request instead of a repo hunt:**
   `GET /api/diag/agent-brief?limit=50` → `agent_triage`
   (`top_issues`, `slowest_marks`, `likely_subsystem`, `degraded_now`,
   `view_context`), `timeline`, and `request_id` values that join with the
   server's `errors.jsonl`.
3. Full raw lines: `GET /api/diag/session-bundle`.
4. CLI: `python scripts/agent_hq_brief.py --pin … --packet`
   (`scripts/fetch_session_bundle.py`, `scripts/save_agent_packet.py`).
5. Symptom → file mapping in `docs/hq-symptom-index.md`; stable error codes in
   `docs/hq-error-codes.md`.

Do not hunt random paths when the brief, the bundle or `/diagnostics` already
answers the question.

---

## Architecture rules that must not be broken

- **No import cycles.** `hq_*` modules receive callbacks and never import
  `iphone_bridge` (the one deliberate exception is
  `hq_forge_lifecycle.session_role_from_cookie`, a separate-process listener
  that needs the persisted session table).
- **Atomic state.** JSON state goes through `hq_state` (lock, `.tmp`, fsync,
  `os.replace`). A missing file is normal; an unreadable file is preserved, never
  overwritten.
- **No arbitrary shell.** Feature modules do not spawn shells; terminal actions
  run only allowlisted `cmd_id` entries.
- **Secrets never leave their files.** `bridge_config.json`,
  `bridge_sessions.json`, `hq_vapid.json`, `.hq-agent-state/`, `agent_config.json`
  are gitignored and must never be pasted in chat, logged, or returned by an API.
- **Admin vs upload.** Admin routes need the admin cookie **and** CSRF; the
  upload role is an allowlist in `iphone_bridge.py` and gets nothing else.
- **Forge is the owner's.** HQ reads `/sdapi/v1/options` and never writes it, and
  never interrupts, skips or reconfigures the owner's Forge
  (`docs/forge-studio-next-features-plan.md` §5). The adapter's POST surface is
  masked `img2img` only.
- **Carnet stays confined.** The server validates structure and never decodes
  pixels or audio; the browser normalises before upload; storage is confined and
  symlinks are refused, never followed.

---

## Verify

Prefer a `verify_*.py` script or one targeted module over the full suite.

```bash
python scripts/verify_all_agent_maps.py      # maps + bridge smoke + carnet smoke
python scripts/verify_agent_pipeline.py      # HQ debug pipeline
python scripts/verify_bridge_smoke.py
python scripts/verify_carnet_smoke.py
python -m unittest tests.test_<area> -v      # pick the row in docs/test-index.md
node tests/check_<area>.mjs
```

`python -m unittest discover -s tests -v` is the full run: it is large, and a few
tests need symlink privilege or the production checkout, so prefer the index.

---

## Stop rules

- **Smallest diff** for the stated task. No drive-by refactors, no new tests
  unless the Maître asked or the change is otherwise untested.
- **No repo-wide exploratory subagents** unless a broad audit was requested.
- **UAC is auto-accepted** on the Maître's Windows machine: run the elevated
  command instead of asking the Maître to click.
- **Commits only when asked.**
- **Temp roots cost ~0.8 GB each.** Fixture and visual tests copy HQ into `%TEMP%\hq-*`. Use
  `tempfile.TemporaryDirectory` or delete your root in `finally`; never set `HQ_KEEP_TEST_ROOTS`
  except to debug one run. `tests/hq_temp_janitor.py` sweeps HQ copies idle for 1 h, but run visual
  `visual_*_playwright.py` scripts only when the change is visual, not as a routine check.
- Use the **operator PIN from the credential store and the base URL from the handoff block** in
  `docs/agent-conventions.md` — do not ask the Maître to repeat them, and do not
  copy the secret into new files.

Short handoff format:

```
Subsystem: carnet | forge | companion | bridge | hq-debug
View: (accueil, carnet, …)
Symptom: (one line)
Packet: (optional — brief_md or agent-packet-latest.md)
Changed files: (optional)
Failing test: (optional)
```
