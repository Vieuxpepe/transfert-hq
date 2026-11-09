# Test index (agents)

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


Run **targeted** tests from this table instead of discovering files or running the full suite.

Verify scripts (recommended):

| Script | Scope |
|--------|--------|
| `python scripts/verify_agent_pipeline.py` | HQ client debug + agent triage unit |
| `python scripts/verify_animation_pipeline.py` | Companion/dangle/home motion perf guards |
| `python scripts/verify_bridge_smoke.py` | Bridge HTTP + diag secrecy slice |
| `python scripts/verify_carnet_smoke.py` | Carnet storage/API core |
| `python scripts/verify_all_agent_maps.py` | All of the above |

---

## HQ debug / diagnostics

| If you changed… | Run |
|-----------------|-----|
| `hq_diagnostics.py`, `hq-debug-panel.js`, agent brief | `python scripts/verify_agent_pipeline.py` |
| `/api/diag/*`, `/diagnostics` | `python -m unittest tests.test_hq_diagnostics_http.Secrecy tests.test_hq_diagnostics_http.ErrorRecording.test_save_agent_packet_http -v` |
| Client log / bundle only | `python tests/test_hq_client_debug_smoke.py` |

---

## Bridge / HTTP core

| If you changed… | Run |
|-----------------|-----|
| `iphone_bridge.py` routing, CSRF, access log | `python scripts/verify_bridge_smoke.py` |
| Mini-Quêtes (`mini_quests.py`, `/api/mini-quests/*`) | `python -m unittest tests.test_mini_quests -v` |
| Refusal / body drain | `python -m unittest tests.test_hq_refusal_drain -v` |
| Phase 15 pins (regression guards) | `python tests/test_phase15_pins.py` (heavier) |
| Bounded read-route latency + Unicode file headers | `python -m unittest tests.test_hq_backend_latency tests.test_hq_startup_perf10.ForgeStatusCache.test_http_get_does_not_block_on_forge_probe tests.test_media_viewer.MediaRouteTests.test_files_header_supports_unicode_filename -v` |
| Live navigation/idle backend soak | `python tests/visual_hq_backend_soak_playwright.py --pin 1427785 --minutes 15` |

---

## Carnet {#carnet}

| If you changed… | Run |
|-----------------|-----|
| `hq_carnet.py` notebook/pages | `python scripts/verify_carnet_smoke.py` |
| Rich / struct / field | `python -m unittest tests.test_hq_carnet_rich tests.test_hq_carnet_structured -v` |
| Reader / PDF | `python -m unittest tests.test_hq_carnet_reader -v` |
| Voice / transcribe | `python -m unittest tests.test_hq_carnet_voice -v` |
| Stickies | `python -m unittest tests.test_hq_carnet_stickies -v` |
| Carnet UI / bootstrap in bridge | `python -m unittest tests.test_hq_carnet_ui tests.test_dessiner_bootstrap -v` |
| Intel / reasoning | `python -m unittest tests.test_hq_carnet_intel tests.test_hq_carnet_reasoning -v` |

---

## Forge

| If you changed… | Run |
|-----------------|-----|
| Vault / HTTP | `python -m unittest tests.test_hq_forge_vault tests.test_hq_forge_http -v` |
| Jobs / transport | `python -m unittest tests.test_hq_forge_jobs tests.test_hq_forge_transport_http -v` |

---

## Companion

| If you changed… | Run |
|-----------------|-----|
| Art API | `python -m unittest tests.test_hq_companion_art -v` |
| Character / memory / voice | `python -m unittest tests.test_hq_companion_character tests.test_hq_companion_memory -v` |
| Else image chip (memory/thread/API/handoff) | `python -m unittest tests.test_hq_else_chip -v` |
| Else chip client contracts (moods/voice/DND/prefs) | `python -m unittest tests.test_hq_else_chip_client -v` |
| Sister dialogue (Else ↔ Transferania) | `python -m unittest tests.test_hq_sister_dialogue -v` |
| Sister UI director (JS helpers) | `python -m unittest tests.test_hq_sister_ui -v` |

---

## Perf / assets

| If you changed… | Run |
|-----------------|-----|
| Companion Live2D, pull, idle throttling | `python scripts/verify_animation_pipeline.py` (includes `test_hq_motion_coordinator`, `test_hq_motion_perf14`, `test_hq_motion_perf16`) |
| Animation / motion perf | same (`test_hq_avatar_idle_perf12`, `test_hq_dangling_perf15`, `test_hq_motion_tools`) |
| Playwright Full/Lite/Parked + navigation/request budgets | `python tests/visual_hq_motion_fps_playwright.py` |
| Home FX idle (clock, stars, pause) | same (`test_hq_idle_perf11`) |
| Asset delivery / gzip | `python -m unittest tests.test_asset_delivery tests.test_perf_gzip_cache -v` |
| Page load perf | `python -m unittest tests.test_hq_pageload_perf9 -v` |

Workflow for agents: [agent-animation-pipeline.md](agent-animation-pipeline.md). CI: `.github/workflows/animation-perf.yml`.

---

## Full suite

Only when the Maître asks or before release: `python -m unittest discover -s tests -p "test_*.py"` (slow).
