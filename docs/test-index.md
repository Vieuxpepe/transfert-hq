# Test index (agents)

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
| Refusal / body drain | `python -m unittest tests.test_hq_refusal_drain -v` |
| Phase 15 pins (regression guards) | `python tests/test_phase15_pins.py` (heavier) |

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

---

## Perf / assets

| If you changed… | Run |
|-----------------|-----|
| Companion Live2D, pull, idle throttling | `python scripts/verify_animation_pipeline.py` (includes `test_hq_motion_coordinator`, `test_hq_motion_perf14`, `test_hq_motion_perf16`) |
| Animation / motion perf | same (`test_hq_avatar_idle_perf12`, `test_hq_dangling_perf15`, `test_hq_motion_tools`) |
| Playwright idle gate | `python tests/visual_hq_motion_fps_playwright.py` |
| Home FX idle (clock, stars, pause) | same (`test_hq_idle_perf11`) |
| Asset delivery / gzip | `python -m unittest tests.test_asset_delivery tests.test_perf_gzip_cache -v` |
| Page load perf | `python -m unittest tests.test_hq_pageload_perf9 -v` |

Workflow for agents: [agent-animation-pipeline.md](agent-animation-pipeline.md). CI: `.github/workflows/animation-perf.yml`.

---

## Full suite

Only when the Maître asks or before release: `python -m unittest discover -s tests -p "test_*.py"` (slow).
