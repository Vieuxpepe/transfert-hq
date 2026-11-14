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
| Terminal tab (view `ops`: `POST /api/terminal`, `POST /api/shell`, allowlist, truncation flags, raw SSH on non-Windows peers) | `python -m unittest tests.test_terminal_tab tests.test_hq_ux_features -v` |
| Time machine / second screen / constellation (`hq_timeline.py`, `hq_desk.py`, `hq_carnet_links.graph`) | `python -m unittest tests.test_hq_timeline tests.test_hq_desk tests.test_hq_carnet_graph -v` + `node tests/check_hq_time_sky_desk.mjs` + `node tests/check_hq_pad.mjs` (shape snap, stroke width, replay, retry, gamma, send queue) + `node tests/check_hq_ink.mjs` (shared ink look `assets/hq-ink.js`: smoothing, tapers, seamless pieces; width-aware stroke simplification; pressure easing, tilt, « Lissage », send timing, ink colour). Drawings width/version: `python -m unittest tests.test_hq_drawings -v`. Browser (throwaway only): `python tests/visual_hq_desk_pad_playwright.py` and `python tests/visual_hq_desk_feel_playwright.py` |
| Mini-Quêtes (`mini_quests.py`, `/api/mini-quests/*`) | `python -m unittest tests.test_mini_quests -v` (CI: `.github/workflows/mini-quests.yml`) |
| Refusal / body drain | `python -m unittest tests.test_hq_refusal_drain -v` |
| Phase 15 pins (regression guards) | `python tests/test_phase15_pins.py` (heavier) |
| Bounded read-route latency + Unicode file headers | `python -m unittest tests.test_hq_backend_latency tests.test_hq_startup_perf10.ForgeStatusCache.test_http_get_does_not_block_on_forge_probe tests.test_media_viewer.MediaRouteTests.test_files_header_supports_unicode_filename -v` |
| Live navigation/idle backend soak | `python tests/visual_hq_backend_soak_playwright.py --pin <admin-pin> --minutes 15` |

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
| Dessiner floating action bubble (`assets/hq-sketch-float.js`: fields next to the selection, Enter / Escape, 3D edge picking, docked on phones, tap ghost-click guard, action ring layout) | `node tests/check_hq_sketch_float.mjs`. Browser (throwaway): `python tests/visual_hq_sketch_float_playwright.py` |
| Dessiner fluid editing (`assets/hq-sketch-input.js`: typed dimensions while drawing, click-click shapes, automatic H / V constraints, alignment guides, double-click outline, box select, right-click / long-press ring, `?` sheet, Space repeats, remembered values, « 2D + 3D », push / pull with instant preview) | `node tests/check_hq_sketch_input.mjs`. Browser (throwaway, Python with OCP): `python tests/visual_hq_sketch_fluid_playwright.py` |
| Dessiner sketch on a picked face (« Esquisser sur la face »: sketch plane / height / outward side from the face, face outline guide, boss outward, pocket into the part) | `node tests/check_hq_sketch_v6.mjs`, `test_hq_solid_occ.V6FormatTests`. Browser (throwaway, Python with OCP): `python tests/visual_hq_sketch_face_playwright.py` |
| Dessiner v6 (exact solids: sketches on planes, arcs, constraint solver, boss / cut, congé / chanfrein, sweep, loft, suppress / reorder / rollback, STEP, mass) | Needs `requirements-occ.txt` (a venv works: `python -m venv --system-site-packages <dir>` then install it). `python -m unittest tests.test_hq_solid_occ -v` (format tests run everywhere; geometry tests skip without OCP) + `node tests/check_hq_sketch_v6.mjs`. Browser (throwaway server run by that Python): `python tests/visual_hq_dessiner_v6_playwright.py` |
| Dessiner 3D v5 (revolve, holes, shell, patterns, editable features, 3D history, AR, Carnet 3D view) | Needs manifold3d: run with the bridge's Python (`C:\Python313\python.exe` here). `python -m unittest tests.test_hq_solid_ops tests.test_hq_usdz -v` + `node tests/check_hq_solid_v5.mjs`. Browser (throwaway, server on that Python): see the header of `tests/visual_hq_solid_v5_playwright.py` (seed → server → `save` → run) |
| Intel / reasoning | `python -m unittest tests.test_hq_carnet_intel tests.test_hq_carnet_reasoning -v` |

---

## Forge

| If you changed… | Run |
|-----------------|-----|
| Vault / HTTP | `python -m unittest tests.test_hq_forge_vault tests.test_hq_forge_http -v` |
| Jobs / transport | `python -m unittest tests.test_hq_forge_jobs tests.test_hq_forge_transport_http -v` |
| « Forge peint » (sketch → img2img) | `python -m unittest tests.test_hq_forge_sketch -v` + `node tests/check_hq_sketch_paint_lift.mjs` (also the pad's sketch-to-3D gesture). Browser (throwaway + fake Forge `HQ_FORGE_MOCK=ready HQ_FORGE_MOCK_DELAY=1.5`): `python tests/visual_hq_sketch_3d_paint_playwright.py` |
| Constellation de graines (seed previews) | `python -m unittest tests.test_hq_forge_preview tests.test_hq_forge_http -v` |

---

## Robotique

| Zone | Commande |
|------|----------|
| Validation, simulation, propriétaire, reprise, HTTP RoArm, caméra et approbation des scripts | `python -m unittest tests.test_hq_robotics tests.test_hq_robotics_http -v` |
| Navigation, responsive, gestes, désarmement et cycle du flux avec Chromium | Définir `HQ_ROBOTICS_BROWSER=1`, puis relancer la commande ci-dessus |

Les tests utilisent un état temporaire et des périphériques simulés. [Guide Robotique](robotics.md)

## Household Intelligence

| If you changed… | Run |
|-----------------|-----|
| `hq_household_schemas.py`, `schemas/household/*`, docs contracts | `python -m unittest tests.test_household_schemas -v` (CI: `.github/workflows/household-foundations.yml`) |
| `hq_household_store.py` SQLite shell | `python -m unittest tests.test_household_store tests.test_household_schemas -v` (CI: `.github/workflows/household-store.yml`) |

Architecture index: [household/README.md](household/README.md). `*.v1.json` = custom contract descriptors (not JSON Schema Draft). Store shell is **not** wired to the bridge (PR #31).

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
| Musique and Musica (privacy, handles, chained tools, cards, Mixer, taste, radar, Spotify and voice route) | `python -m unittest tests.test_hq_musica tests.test_hq_music tests.test_hq_music_mixer tests.test_hq_music_ui tests.test_hq_music_radar tests.test_hq_spotify -v` |
| DJ Musica Chatterbox voice (engine choice, moods, cache, fallback, A/B) | `python -m unittest tests.test_hq_voice_chatterbox -v` |
| DJ Musica show engine (segments, drops mix with ffmpeg, observe / advance / skips, steering, schedules, jingles, guests) | `python -m unittest tests.test_hq_music_dj -v` |
| Temp-root janitor (`tests/hq_temp_janitor.py`: stale `%TEMP%\hq-*` test copies, never follows links) | `python -m unittest tests.test_hq_temp_janitor -v` |
| DJ Musica Rembobiner (episode archive, replay, drops spared by the cache prune), Le Duel (contenders, instant vote and streamed reaction, champion, Panthéon) and the mood dial | `python -m unittest tests.test_hq_music_dj_duel -v` |
| Musica voice worker (pairing, bearer auth, job queue, breaker and fallbacks, reference clip, real worker script against a fake HQ and daemon) | `python -m unittest tests.test_hq_voice_remote -v` |
| DJ Musica live reactions (pacing, cached voices, warm-up, skip/streak/bet events in `observe`) and talk back (question vs request, grounded answers, blind-match guard, acknowledgement, routes) | `python -m unittest tests.test_hq_music_dj_live -v` |
| DJ Musica station (weekly grid, tick, ready/launch, previously, memory page, routes, moments setting) | `python -m unittest tests.test_hq_music_station -v` |
| DJ Musica Le Tournoi (video game bracket: memory, angles, seeds and upsets, wild card repêchage, blind masking, listening windows, themes, hall of fame, rivalry, sister cameo), kinds (decade, artists, albums, library) and the daily challenge | `python -m unittest tests.test_hq_music_dj_tournament -v` |
| Musique recaps (Wrapped week/month/year, on this day, taste map clusters and quiet artists) | `python -m unittest tests.test_hq_music_wrapped -v` |
| DJ Musica Fouille (`hq_music_dj_dig`: sources, cache, steering weights, mix, deadline) | `python -m unittest tests.test_hq_music_dj_dig -v` |
| DJ Musica picks (her scored bets), « Charme » levels and adult gate, web-checked facts (`hq_music_dj_facts`, grounded `hq_ai.generate(search=True)`) and the weekly audio recap (`hq_music_weekly`) | `python -m unittest tests.test_hq_music_dj_stories tests.test_hq_ai -v` |
| Musique salon extras (journal, release alerts, quiz, mood, energy curve, DJ line, lyrics, Studio remix / variants / library) | `python -m unittest tests.test_hq_music_salon tests.test_hq_music_studio -v` |

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

- `tests/test_hq_voice_phonon.py`, `tests/check_hq_voice_studio.mjs` — Phonon engine routing, cache isolation, fallbacks, studio UI.
