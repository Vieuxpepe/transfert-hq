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
| `python tests/visual_hq_rain_sky_playwright.py` | Rainy Accueil sky, weather pinned: 3 interleaved samples, precipitation must stay 2 sheet animations (0 in Lite), rain-vs-cloudy fps within 15 % |
| `python scripts/verify_home_bg_composite_budget.py` | Home background grain: paired Full fps + pixel parity (blend vs composite) |
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

## Musique / Spotify

| If you changed… | Run |
|-----------------|-----|
| `hq_music.py`, discoveries/presets | `python -m unittest tests.test_hq_music -v` |
| `hq_music_mixer.py` | `python -m unittest tests.test_hq_music_mixer -v` |
| `hq_spotify.py` (mocked) | `python -m unittest tests.test_hq_spotify -v` |
| Musique nav / lazy-load wiring | `python -m unittest tests.test_hq_music_ui -v` |
| All Musique unit | `python -m unittest tests.test_hq_music tests.test_hq_music_mixer tests.test_hq_spotify tests.test_hq_music_ui -v` |

Setup notes: [musique-spotify.md](musique-spotify.md). Live Spotify OAuth/playback is **not** covered by CI mocks.

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
| Dessiner « Valider le dessin » + « Réparer » (rapport lecture seule : points, objets et contraintes introuvables, esquisses sur une face disparue, lignes de longueur nulle, cotes sans cercle ; réparation bornée qui ne retire que le vide, `S.diagnose` / `S.repair` dans `assets/hq-sketch-core.js`) | `node tests/check_hq_sketch_validate.mjs` |
| Dessiner rendu mesuré (anneau d'images, budget 500 objets ≤ 6 ms de JS, calque statique + calque transparent, culling, LOD sous-pixel, index de hit-test équivalent au balayage linéaire) | `node tests/check_hq_dessiner_perf.mjs`. Navigateur : `window.hqDessinerPerf()` (HUD avec `?perfhud=1`) |
| Dessiner cotes ⌀ / R (leader, valeur réelle, drapeau de référence, tolérance, export DXF en `%%c`) | `node tests/check_hq_sketch_dims.mjs` |
| Dessiner paramètres et cotes pilotantes (`doc.params` + langage d'expressions dans `assets/hq-sketch-core.js` : dépendances, cycles, virgule décimale, `dim.drive` résolu par une contrainte `distance` / `angle` temporaire, libellé réécrit, échec signalé sans demi-application) | `node tests/check_hq_sketch_params.mjs` + `python -m unittest tests.test_hq_drawings_params -v` |
| Dessiner arbre de fonctions (`S.featureRows` / `activeFeatures` : ordre, répression, point de retour, erreurs dites — profil vide ou disparu, source d'une répétition) | `node tests/check_hq_sketch_features.mjs` + `node tests/check_hq_sketch_v6.mjs` |
| Dessiner tracé reconnu (`S.recognizeStroke` / `applyStrokeShape` : moindres carrés de ligne, Kasa pour le cercle, arc déduit de la couverture, polyligne RDP, accroche H / V et aux points existants) | `node tests/check_hq_sketch_recognize.mjs` |
| Dessiner atelier 3D (`assets/hq-dessiner.js` + `assets/hq-solid-view.js` : onglets Pièce · Opération · Propriétés, opérations offertes seulement si la sélection les nourrit (raison du refus), arbre compact (nom, valeur, œil, erreurs, glisser-déposer, point de retour), fantôme de l'opération en attente, vues iso / face / dessus / droite, double-clic sur une face, coupe Z, mesure deux points, pellicule d'historique (triangles et volume de chaque étape), pièces types plaque / équerre / entretoise, conseils au premier usage, dernier maillage conservé, reconstructions en file, toast Annuler) | `node tests/check_hq_sketch_features.mjs` + `node tests/check_hq_sketch_params.mjs` + `node tests/check_hq_sketch_v6.mjs` |
| Dessiner noms et valeurs pilotées de fonction (`name` ≤ 40 sans caractère de contrôle, `driven` version 6 borné aux champs numériques et résolu avant reconstruction, côté client et côté serveur) | `node tests/check_hq_sketch_features.mjs` + `python -m unittest tests.test_hq_drawings_3d_names -v` |
| Dessiner partagé (`hq_drawings_live.py` + `GET`/`POST /api/drawings/live` : révisions par dessin, conflit 409 qui renvoie la tête du serveur, présence avec sélection / curseur qui expire, plafonds et clés refusées) | `python -m unittest tests.test_hq_drawings_live -v` |
| Dessiner invariants aléatoires (séquences d'opérations semées : `validateDoc` après chaque édition, identifiants uniques, extrémités d'arc sur le cercle, Annuler/Rétablir identiques, contraintes cassées refusées) | `node tests/check_hq_sketch_fuzz.mjs` |
| Dessiner exports et brouillons (`hq_drawings.py` : calques DXF par esquisse, cotes ⌀/R, aller-retour DXF, fiche d'atelier PDF A4 générée à la demande via `kind=pdf`, brouillons bornés K/TTL/orphelins) | `python -m unittest tests.test_hq_drawings_export -v` |
| Dessiner 3D v5 (revolve, holes, shell, patterns, editable features, 3D history, AR, Carnet 3D view) | Needs manifold3d: run with the bridge's Python (`C:\Python313\python.exe` here). `python -m unittest tests.test_hq_solid_ops tests.test_hq_usdz -v` + `node tests/check_hq_solid_v5.mjs`. Browser (throwaway, server on that Python): see the header of `tests/visual_hq_solid_v5_playwright.py` (seed → server → `save` → run) |
| Intel / reasoning | `python -m unittest tests.test_hq_carnet_intel tests.test_hq_carnet_reasoning -v` |

---

## Forge

| If you changed… | Run |
|-----------------|-----|
| Vault / HTTP | `python -m unittest tests.test_hq_forge_vault tests.test_hq_forge_http -v` |
| Galerie : restauration (413/507 avant écriture, dédoublonnage SHA-256, vérification sans import), sauvegarde complète et son marqueur, export d'une sélection, corbeille vidée des seuls rejets | `python -m unittest tests.test_hq_forge_gallery tests.test_hq_forge_http -v` |
| Lot multi-appareils : file, annulation, pause / reprise sans interrompre la tâche en cours | `python -m unittest tests.test_hq_forge_fleet -v` |
| Onglet Forge — budget de chargement (poids gz des `assets/hq-forge*`, compilation JS) | `node tests/check_hq_forge_budget.mjs` |
| Jobs / transport | `python -m unittest tests.test_hq_forge_jobs tests.test_hq_forge_transport_http -v` |
| « Forge peint » (sketch → img2img) | `python -m unittest tests.test_hq_forge_sketch -v` + `node tests/check_hq_sketch_paint_lift.mjs` + `node tests/check_hq_sketch_palette.mjs` (also the pad's sketch-to-3D gesture). Browser (throwaway + fake Forge `HQ_FORGE_MOCK=ready HQ_FORGE_MOCK_DELAY=1.5`): `python tests/visual_hq_sketch_3d_paint_playwright.py` |
| Constellation de graines (seed previews) | `python -m unittest tests.test_hq_forge_preview tests.test_hq_forge_http -v` |
| Génération refusée avant envoi par le quota : galerie pleine (images ou octets), un emplacement pour deux images, puis deux emplacements pour deux images (Générer revient) | `python tests/visual_forge_quota_playwright.py` |

---

## Robotique

| Zone | Commande |
|------|----------|
| Validation, simulation, propriétaire, reprise, HTTP RoArm, caméra et approbation des scripts | `python -m unittest tests.test_hq_robotics tests.test_hq_robotics_http tests.test_hq_robotics_editor -v` |
| Vue 3D : cinématique inverse, test de recouvrement et formes des trajectoires (comparées à celles du serveur) | `node tests/check_hq_robotics_3d.mjs` |
| E-stop, keep-out et préréglages ONVIF contre des serveurs loopback | `python scripts/verify_robotics_loopback.py` |
| Navigation, responsive, gestes, désarmement et cycle du flux avec Chromium | Définir `HQ_ROBOTICS_BROWSER=1`, puis relancer la commande ci-dessus |

Les tests utilisent un état temporaire et des périphériques simulés. [Guide Robotique](robotics.md)

## Household Intelligence

| If you changed… | Run |
|-----------------|-----|
| `hq_household_schemas.py`, `schemas/household/*`, docs contracts | `python -m unittest tests.test_household_schemas -v` (CI: `.github/workflows/household-foundations.yml`) |
| `hq_household_store.py` SQLite shell | `python -m unittest tests.test_household_store tests.test_household_schemas -v` (CI: `.github/workflows/household-store.yml`) |
| Household HQ backup (`snapshot_to` + `cc_ext.run_backup`) | `python -m unittest tests.test_hq_household_backup tests.test_household_store tests.test_backup_retention -v` |
| Gate B init safety (absent GET / first POST) | `python -m unittest tests.test_hq_household_backup.HouseholdInitSafetyTests -v` |

Architecture index: [household/README.md](household/README.md). `*.v1.json` = custom contract descriptors (not JSON Schema Draft). Store shell + HQ backup packaging; domain routes are bridge-wired.

---

## Companion

| If you changed… | Run |
|-----------------|-----|
| Art API | `python -m unittest tests.test_hq_companion_art -v` |
| Chat aliveness (scripted 6-turn payload evidence, no model calls; live payload probe) | `python -m unittest tests.test_chat_aliveness -q` + `python scripts/verify_chat_aliveness.py` + `python scripts/verify_live_chat_prompt.py` |
| Character / memory / voice | `python -m unittest tests.test_hq_companion_character tests.test_hq_companion_memory -v` |
| Else image chip (memory/thread/API/handoff) | `python -m unittest tests.test_hq_else_chip -v` |
| Else chip client contracts (moods/voice/DND/prefs) | `python -m unittest tests.test_hq_else_chip_client -v` |
| Per-assistant sound stash (`hq-assistant-sfx.js`) | `node tests/check_assistant_sfx.mjs` |
| Sister dialogue (Else ↔ Transferania) | `python -m unittest tests.test_hq_sister_dialogue -v` |
| Sister UI director (JS helpers) | `python -m unittest tests.test_hq_sister_ui -v` |
| Musique and Musica (privacy, handles, chained tools, cards, Mixer, taste, radar, Spotify and voice route) | `python -m unittest tests.test_hq_musica tests.test_hq_music tests.test_hq_music_mixer tests.test_hq_music_ui tests.test_hq_music_radar tests.test_hq_spotify -v` |
| Musica chip dance beat engine (`assets/hq-musica-beat.js`: tempo folding, shared clock and lock, tap tempo, live tempo / phase / drops, energy curve) and the beat-grid store | `node tests/check_musica_beat.mjs` and `python -m unittest tests.test_hq_musica -v` |
| Musica chip song identity, wiring (`currentSong()` and `syncBeatKey()` must both go through `assets/hq-now-playing.js`, and speech payloads may not read the raw Spotify snapshot) | `node tests/check_musica_song_identity.mjs` |
| Shared now-playing identity (`assets/hq-now-playing.js`: golden local/Spotify keys, local-over-Spotify precedence, stability clock, speech filter that rejects another track's title, blind-match conceal flag) and its consumers (`hq-musica-chip.js`, `hq-music.js` DJ/tournament wiring) | `node tests/check_song_identity.mjs` |
| Musica speech identity on the server (`dance_prompt_context` / `ambient_now_playing` never name a track when none is known, speech trace ring + routes, play-memory source) | `python -m unittest tests.test_hq_musica.SpeechIdentityTests -v` |
| Owner title overrides (`musica_song_titles.json` behind `GET/POST /api/musica/song-titles`, keyed like the beat grid, used by `dance_prompt_context`) | `python -m unittest tests.test_hq_musica.SongTitleOverrideTests -v` |
| DJ page browser smoke (on-air strip names the song through the shared identity, blind concealment without the Musique page, local playback steps the show aside; stubbed APIs on a throwaway HQ) | `python tests/visual_dj_page_playwright.py` |
| Chip touch holds (head and tail spanks fire at ~0.55 s; a ~1.25 s hold opens the title editor; cheek/thigh squeezes at 280 ms, keeps the editor at 1.25 s and releases on lift; drag past threshold, second finger and pointercancel suppress both; 390x844 touch viewport) | `python tests/visual_musica_chip_touch_playwright.py` |
| Load-time script dependencies (a page script that reads another module's global while it loads, e.g. `hq-musica-chip.js` → `hq-musica-beat.js`; the page must load the provider first, statically or earlier in the lazy list) | `node tests/check_hq_script_deps.mjs` — regenerate the table with `--write-doc` into `docs/script-order.md` |
| Type scale (six steps 11/13/15/17/20/26 across `assets/*.css`, BASE_CSS and inline styles; `em` only in the notebook's document prose, `pt` only in print, display art ≥ 38px) | `node tests/check_hq_scale.mjs` — for what the cascade actually paints, paste `tools/hq_scale_audit.js` into the console |
| DJ Musica Chatterbox voice (engine choice, moods, cache, fallback, A/B) | `python -m unittest tests.test_hq_voice_chatterbox -v` |
| DJ Musica show engine (segments, drops mix with ffmpeg — loudness + sidechain bed, observe / advance / skips, steering, schedules, jingles, guests) and the pipeline work (prep stage timings, busy / queued / cancelled preparations, polled-state snapshot, cache size budget, reactive replan after two mood skips) | `python -m unittest tests.test_hq_music_dj -v` |
| DJ Musica episode export (one MP3 with chapter marks, reuse, cache protection) and Rembobiner text search + their routes | `python -m unittest tests.test_hq_music_dj_export -v` |
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
| Rainy sky (weather pinned): Full/Lite budget, 2 sheet animations (0 in Lite), rain-vs-cloudy fps within 15 % of its own baseline | `python tests/visual_hq_rain_sky_playwright.py` |
| Home background grain / full-screen blend layer | `python scripts/verify_home_bg_composite_budget.py` |
| Home FX idle (clock, stars, pause) | same (`test_hq_idle_perf11`) |
| Asset delivery / gzip | `python -m unittest tests.test_asset_delivery tests.test_perf_gzip_cache -v` |
| Page load perf | `python -m unittest tests.test_hq_pageload_perf9 -v` |

Workflow for agents: [agent-animation-pipeline.md](agent-animation-pipeline.md). CI: `.github/workflows/animation-perf.yml`.

---

## Full suite

Only when the Maître asks or before release: `python -m unittest discover -s tests -p "test_*.py"` (slow).

- `tests/test_hq_voice_phonon.py`, `tests/check_hq_voice_studio.mjs` — Phonon engine routing, cache isolation, fallbacks, studio UI.

---

## Assistant chat (Culinia / Forgia / Securia / Inventoria)

| If you changed… | Run |
|-----------------|-----|
| thread state, clear epoch, cancel job, Securia tool gating | `python -m unittest tests.test_hq_securia tests.test_hq_forgia tests.test_hq_culinia tests.test_hq_musica -v` |
| Inventoria chat turn, session `rev` merge, cancel | `python -m unittest tests.test_hq_inventoria_ai tests.test_hq_inventoria -v` |
| Inventoria auto-apply/Undo, quick, barcode, nicknames, usual amounts, alert buttons | `python -m unittest tests.test_hq_inventoria_fast -v` |
| Inventoria where-is, parts/recipes, cooked, prices, use-soon, spot-checks, filament, digest | `python -m unittest tests.test_hq_inventoria_links -v` |
| Inventoria item sheet, minimum, history, spending, recipes, barcodes list, duplicate-safe retries | `python -m unittest tests.test_hq_inventoria_suivi -v` |
| Inventoria Suivi tab, item sheet, offline queue, haptics, language, calm/voice/guess-fix/shop mode/quiet settings (offline DOM) | `node tests/check_inventoria_suivi_ui.mjs` (`HQ_UI_PROVE=1` proves each case) |
| Inventoria feel: calm line, streak, usual/checked marks, voice, ask budget (quiet hours, cap, snooze) | `python -m unittest tests.test_hq_inventoria_feel -v` |
| Inventoria language layer (dictionary, server-label patterns, translate/revert) | `node tests/check_inventoria_i18n.mjs` |
| Inventoria panel in Chromium: tabs, Suivi, sheet, offline, slow-network ack, shop mode, calm line, discretion, no French in the English panel (throwaway server) | `python tests/visual_inventoria_playwright.py [--shots dir]` |
| Inventoria chip cards, Undo toast, deep links (offline DOM) | `node tests/check_assistant_chat_ui.mjs` (`HQ_UI_PROVE=1` proves each case is load-bearing) |
| the rules themselves | read `docs/assistant-chat-contract.md` (§7 lists what is still open) |
| Elsea, Atelier 3D (printers, cameras, models, MakerWorld) | `python -m unittest tests.test_hq_elsea tests.test_hq_print3d tests.test_hq_print3d_http tests.test_hq_print3d_filament tests.test_hq_print3d_errors tests.test_hq_print3d_watch tests.test_hq_makerworld_alerts -v` · `node tests/check_hq_print3d.mjs` (STL preview abort, poll guard, tab gating, stale replies, camera/alerts node reuse, empty states, price form, a11y, upload progress/cancel/retry, paging, tile reuse, 304 and 401, poll budget, offline since, tab underline/pane fade, progress tick gating, busy buttons, camera live, history enter) |

### Store binding

Every assistant test module must bind the stores it touches: `tests/hq_assistant_state.py`
is the shared binder, and it now enforces that.

| If you added or changed… | Run |
|--------------------------|-----|
| a test that reads personhood, visit or relationship data | `python -m unittest tests.test_hq_personhood tests.test_hq_assistant_visits -v` |
| a module-level `set_up`/`tear_down` binding | same module: `tear_down` fails the run when a store wrote the checkout |
| a module that binds per test | put `hq_assistant_state.guard(self)` in `setUp`; it fails that test if a store writes the checkout |
| a read of the wrong root | call `hq_assistant_state.assert_stores_bound(root)`; it names every store that still resolves elsewhere |

An unbound store resolves to the checkout (`tests/hq_assistant_state.LIVE_ROOT`), so a
test that forgot to bind reads the Master's real data or overwrites it.

**Omitting the helper no longer buys silence.** `conftest.py` arms `tests/hq_store_guard.py`
for the whole pytest session, whatever the module does: it hooks the real store read and
write paths (`Path.read_text`/`read_bytes`/`open`, `Path.unlink`, `os.replace`/`unlink`) and
fails the test that touched the checkout, naming the store file and the test node. Any
create, rewrite or delete inside a `.hq-*` store folder fails; reads count while a test
runs, and reads at import/collection time are listed at the end of the run without failing
it (a module may import an assistant package before it binds). `tests/__init__.py` also
snapshots the checkout's store files, so a `python -m unittest` run names on stderr any
file a test wrote there.

## Playground

| If you changed… | Run |
|-----------------|-----|
| `assets/hq-playground.js`, `hq-playground.css` (échiquier, règles, clavier, assistantes) | `node tests/check_hq_playground.mjs` + `node tests/check_hq_playground_report.mjs` (rejoue la série et la preuve de traits de `docs/hq-playground-growth-report.md` et échoue si l'un des deux blocs cités a dérivé) |
| Nav / lazy load Playground in `iphone_bridge.py` | `python scripts/verify_bridge_smoke.py` + `python -m unittest tests.test_hq_ux -v` |

## UX / tooltips

| If you changed… | Run |
|-----------------|-----|
| `assets/hq.js` tooltip controller, dynamic Forge/Robotique controls, or `tests/check_hq_dynamic_help.mjs` | `python -m unittest tests.test_hq_ux -v` (includes `node tests/check_hq_dynamic_help.mjs`) |

CI: `.github/workflows/ux-tooltips.yml`.

## Navigation

| If you changed… | Run |
|-----------------|-----|
| `assets/hq-nav-badges.js` (Carnet / Calendrier / Forge / Sécurité badge sources, the single dot Plus folds them into on a phone, the Calendrier next-event tooltip) | `node tests/check_hq_nav_badges.mjs` |
| `assets/hq-nav-order.js` (section hairlines, rail collapse), `assets/hq-nav-plus.js` (measured `--nav-h`, Plus icons / Récemment ouvert / Système fold), nav CSS in `iphone_bridge.py` | `node tests/check_hq_nav_badges.mjs` + `node tests/check_hq_nav_rail.mjs` + `node tests/check_hq_chrome.mjs` + `node tests/check_hq_polish.mjs` |
