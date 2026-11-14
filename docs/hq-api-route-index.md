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
| `GET /api/carnet?graph=1` | `hq_carnet_links.graph` | Constellation (`assets/hq-constellation.js`), read-only |

Frontend: lazy **`hqCarnetLoad`** in `iphone_bridge.py` → **`assets/hq-carnet*.js`**.  
Tests: [test-index.md](test-index.md#carnet).

---

## Robotique

| Route | Mod | Notes |
|-------|-----|--------|
| `GET /api/robotics/status`, `GET/POST /api/robotics/presets` | `hq_robotics` | État, profil, positions |
| `POST /api/robotics/{settings,telemetry,arm,move,cancel,stop,reset,preview,sequence}` | `hq_robotics`, `hq_robotics_arm` | Admin + CSRF. Pilotage matériel direct sur le PC HQ, après mise en service |
| `POST /api/robotics/camera/{start,frame,stop}`, `GET /api/robotics/camera/video` | `hq_robotics_camera` | Session vidéo H.264 locale, identifiants côté serveur |
| `GET /api/robotics/assistant/{thread,portrait}`, `POST /api/robotics/assistant/{message,review,approve}` | `hq_robotics_assistant`, `hq_ai` | Conversation privée par admin, double validation avant lecture en simulation |

Configuration, commandes, mise en service et reprise dans [robotics.md](robotics.md).

---

## Forge

| Prefix | Mod | Notes |
|--------|-----|--------|
| `/api/forge/status`, `catalog`, `gallery`, `lab`, … | `hq_forge*` | Studio API |
| `/api/forge/vault/*`, `/api/forge/vaults/*` | `hq_forge_vault` | Vaults, health, migration |
| `/api/forge/presets`, `inpaint`, jobs | `hq_forge` | Heavy payloads |
| `POST /api/forge/sketch`, `GET /api/forge/sketch[/<id>[/image]]`, `POST /api/forge/sketch/<id>/keep` | `hq_forge_sketch` | « Forge peint » (Dessiner): unmasked img2img of the sketch on this PC's Forge only, through the already approved `POST /sdapi/v1/img2img` (no route added). Same guards as inpaint: admin + CSRF, refused (never queued) while the GPU is busy, loaded model only (no `override_settings`), fixed `BODY_KEYS`, Forge saves nothing. Sketch PNG ≤ 2 MiB, sides 256–1024 multiple of 64. Latest painting in memory only; the gallery only on `keep`. Holds the GPU for jobs/retouches (`hq_forge_jobs.add_gpu_hold`) |
| `POST /api/forge/preview`, `GET /api/forge/preview`, `GET /api/forge/preview/<id>[/image]` | `hq_forge_preview` | Constellation de graines: low-step local txt2img previews (six steps, ≤320 px long side), one Forge batch of up to nine tiles (`count`, default 1), admin + CSRF, refused while the GPU is busy. Uses the already approved `POST /sdapi/v1/txt2img`; no new Forge route. Forge renders consecutive seeds from the requested base and reports `all_seeds`; HQ keeps the actual seed per tile for click-to-select. Memory only: no gallery, jobs, stats, vault or browser storage; the prompt is dropped after submission. Holds the GPU for jobs/retouches (`hq_forge_jobs.add_gpu_hold`) |

Frontend: **`hqForgeLoad`** → `assets/hq-forge*.js`.

---

## Companion / art

| Route | Mod | Notes |
|-------|-----|--------|
| `GET/POST /api/companion/art` | `hq_companion_art` | Art / poses / NSFW gates |
| `GET /api/companion/chat-image/<id>` | `hq_ai.transferania_chat_image` | Admin-only Forge attachment, scoped to the owner's device thread |

Frontend: **`assets/hq-companion.js`**, view **`intime`**.

---

## Files / inbox / core HQ

| Route | Mod | Notes |
|-------|-----|--------|
| `/api/list`, `/api/upload`, `/api/delete`, `/api/rename`, `/api/files` | `iphone_bridge` + `cc_ext` | Fichiers view |
| `/api/health` | bridge | Legacy liveness |
| `/api/me` | bridge | Session |
| `/api/home-layout`, `/api/today`, `/api/brief` | `hq_home`, `hq_today`, … | Accueil |
| `GET /api/timeline?span=day\|week` | `hq_timeline` (built in `build_timeline`) | Time machine (`assets/hq-timemachine.js`). Public Forge gallery only, never the vault |
| `GET /api/desk/poll`, `GET /api/desk/peer`, `GET /api/desk/snapshot`, `POST /api/desk/send\|state\|leave\|snapshot` | `hq_desk` | Phone as second screen (`assets/hq-desk.js`). Admin + CSRF. In-memory relay, long poll ≤ 20 s. Optional pad `data.id` (`[0-9a-z]{1,16}`) is idempotent for `MSG_TTL`. Snapshot: one JPEG/WebP slot per PC client, raw body ≤ 512 KiB, `Cache-Control: no-store` |
| `/api/calendar`, `/api/calendar/run` | `hq_calendar` | Calendrier |
| `/api/projects` | `hq_projects` | Projets |
| `/api/inventory` | `hq_inventory` | Inventaire |
| `/api/mini-quests`, `/api/mini-quests/*` | `mini_quests` | Simulated Mini-Quêtes (admin; see `MINI_QUESTS.md`) |
| `/api/drawings`, `/api/drawings/*` | `hq_drawings` | Dessiner |
| `GET /api/drawings/caps`, `POST /api/drawings/step` | `hq_drawings.step_file`, `hq_solid_occ` | Exact solids (v6): `caps` says whether OpenCascade is installed (`{exact, version}`); `step` returns the part as STEP AP214 in millimetres (`model/step`, attachment), v6 drawings only. `POST /api/drawings/mesh` on a v6 drawing also returns `exact`, every edge (curves as polylines, for fillet / chamfer picking) and `mass` (volume, area, centre, size). Admin only |
| `POST /api/drawings/usdz`, `GET /api/drawings/usdz/<id>.usdz` | `hq_drawings.ar_model`, `hq_usdz` | AR Quick Look: the drawing's part as a USDZ (ASCII `model.usda` in a stored, 64-byte aligned zip; metres, Y up, resting on the table). Admin only. Built from the validated document; kept in memory 10 min (4 at most), `model/vnd.usdz+zip`. Also asked for from the pad (`remote` cmd `ar`) |
| `/api/ai` | `hq_ai` (+ `hq_sister` for sister ops) | Assistant / companions. POST `action`: `ask`, `ambient`, `transferania`, `else`, `sister`, … — sister ops: `exchange`, `ambient`, `react`, `history`, `prefs`, `clear`. Ambient may return `sister_cue`. GET `?else=1` / `?transferania=1` history. Status includes `else` + `sister`. |
| `GET/POST /api/assistant-visits`, `POST /api/assistant-visit-banter`, `GET/POST /api/admin/nvidia` | `hq_assistant_visits` | Visites ambiantes entre puces : lecture du dernier échange, enregistrement d'une visite terminée, et génération facultative d'un court échange par Gemini 3.1 Flash Lite, avec NVIDIA NIM puis les lignes locales en repli (admin + CSRF ; débit limité). Gemini utilise le budget de visite séparé de `hq_ai` (`visit_daily_limit`, défaut 8), pas les compteurs chat/ambient. `POST /api/assistant-visit-banter` accepte aussi `shape` (`flyby` 2, `checkin` 4, `scene` 6 répliques) et `place` (vue sûre ; sinon `hq`), et reçoit le dernier `thread` du couple depuis ses propres fichiers de visites. `GET/POST /api/admin/nvidia` lit ou met à jour la clé et le modèle NVIDIA de repli et renvoie la télémétrie de repli du jour, persistée dans `.hq-agent-state/` et rechargée au démarrage ; la clé est en écriture seule et n'est jamais renvoyée. |
| `/api/agent` | `hq_agent` | Agent automation |
| `/api/backups`, `/api/backups/folders` | backup helpers | Backups |

---

## Terminal / shell (view `ops`)

| Route | Mod | Notes |
|-------|-----|-------|
| `POST /api/terminal` | `cc_ext.start_terminal_job` | Admin + CSRF. `{id}` = one `terminal_commands` entry (or `{cmd}` exact-match only, never a new command). Starts a **job** and answers **202** at once with `{job_id, state, cursor, label, timeout_sec, cwd}`; follow it with `GET /api/shell/job`. `shell=True` in the HQ root, capped by `terminal_timeout_sec` (fallback `shell_timeout_sec`). Refusals are a clean 400 message, never an internal repr |
| `GET /api/terminal/commands` | bridge | Admin. The configured allowlist; read by the Terminal « Actualiser » button |
| `POST /api/shell` | `cc_ext.start_shell_job` | Admin + CSRF. `{target, shell, cmd}`; a `host` field is refused. `shell`: `powershell` \| `cmd` \| `pwsh` \| `raw` (`raw` = SSH only, refused for local). 8000-char cap, `shell_timeout_sec` (45 s). Starts a job, answers **202** with the same payload |
| `GET /api/shell/targets` | `cc_ext.list_shell_targets` | Admin. local + `shell_targets` + non-mobile Tailscale peers (`type: ssh`, `os`; `online` stays null when unprobed, the UI then says « état inconnu »). Read by « Actualiser » |
| `GET /api/shell/job?id=<id>&cursor=<n>` | `cc_ext.job_snapshot` | Admin. One job: `output` = only the text after `cursor`, plus `state` (`running` / `done` / `failed` / `stopped` / `timeout`), `code`, `error`, `truncated`, `elapsed_ms`. 404 `Tâche inconnue` only for an id never recorded: past the 15 min memory TTL (8 jobs) or a restart, a finished job is read back from `.hq-terminal/jobs` |
| `GET /api/shell/jobs` | `cc_ext.list_jobs` | Admin. This bridge session's jobs, newest first, without transcripts: `{jobs: [{job_id, kind, label, target, shell, state, code, error, started, elapsed_ms, truncated}]}`. Feeds the Terminal's « Tâches de cette session » list (plus `storage: {count, bytes}` for the « Vider » button); finished jobs also come from `.hq-terminal/jobs/<id>.json` (atomic `hq_state` writes, last 40 files), so the list survives a restart. A click reopens the transcript through `GET /api/shell/job?cursor=0` |
| `POST /api/shell/job/stop` | `cc_ext.stop_job` | Admin + CSRF. `{id}` kills one job (whole tree: `taskkill /F /T` on Windows, the process group elsewhere); `{all: true}` → `cc_ext.stop_all_jobs`, which stops every running **and queued** job. Answers with the final state / `{stopped, ids}`. An ssh job is killed locally: its remote command may keep running |
| `POST /api/shell/jobs/clear` | `cc_ext.clear_persisted` | Admin + CSRF. Deletes the saved job files (`.hq-terminal/jobs`), not the live jobs. `{deleted, bytes}` |
| `GET /api/shell/stats` | `cc_ext.job_stats` | Admin. Local aggregates over the session + saved jobs: `{total, states, ok, failed, avg_ms, slowest[5], commands[10]}`. No telemetry |
| `POST /api/terminal/export` | `iphone_bridge` | Admin + CSRF. `{text, name}` → `Inbox/<slug>_<stamp>.txt` (500k chars max), so the phone can pick the transcript up. `{name, rel}` |
| `GET /api/screen/frame?w=1280&target=local` | `iphone_bridge.screen_frame_jpeg` / `screen_remote_frame_jpeg` | Admin. One downscaled JPEG of a screen (`image/jpeg`, `Cache-Control: no-store`; 404 `unknown_target`, 503 `screen_unavailable`). `target` is an id from `/api/shell/targets`: `local` captures this PC, an `ssh` peer captures its own screen and returns base64 on stdout — the same script piped to its PowerShell over the existing SSH argv, one round trip, nothing kept on either disk, ~3-4 s per frame. The ops « Écran du PC » card swaps it into an `<img>` every 2 s and asks for nothing while it is closed, paused, the tab is hidden or another view is open. Full-resolution captures stay `POST /api/screenshot` + Captures |

Frontend: the `ops` panel in `iphone_bridge.py` + `APP_JS` (job polling `hqTermPoll`, `Arrêter` → `stop_job`, history in `sessionStorage`, Copier / Effacer / sauver `.txt`). The Ctrl-K palette starts the same job and hands it to the view (`window.hqTermAttachJob`). `#term-jobs` lists every job of this session with its state (from 900 px it sits in a right-hand column beside the console, sticky; the column only appears once jobs exist; a running row shows a live counter, `hqTermListTick`), narrowed by a name box and a state select (`hqTermRecentRefresh` → `hqTermRecentRender`), both remembered in `sessionStorage` (`hq_shell_jobs_filter` / `hq_shell_jobs_state`) so a refresh keeps them, grouped by day (`hqTermDayLabel`, « Aujourd'hui » / « Hier » / date) with running jobs pinned first in their group (`hqTermOrderRows`) with a per-day count such as « 4 tâches · 3 OK · 1 échec »; a click (`hqTermOpen`) replays the transcript and keeps following it if the job still runs. A job runs immediately unless `cc_ext.JOB_MAX_RUNNING` (3) commands are already running: it then waits as `queued` and `_pump_queue` starts it when a slot frees. Each job keeps its `command` / `cmd_id` (for the ⟳ re-run), its `pid`, and is written to disk at start too; on boot `reconcile_orphans` marks anything still `running`/`queued` as `interrupted` (« Le pont s'est arrêté pendant cette tâche ») and never kills the recorded PID, which may have been reused. Finished jobs are written to `.hq-terminal/jobs/<id>.json` (gitignored, `terminal_jobs_keep` files — 40 by default, `terminal_job_output_max` chars — 60 000), so `#term-jobs` and its transcripts survive a restart. A job the panel loses track of ends with « tâche perdue » (404, or nothing for 6 s); after a bridge restart the persisted record comes back as `interrupted` rather than pretending it finished. Each row carries ■ (stop, running or queued) and ⟳ (re-run with the same command/target/shell); the jobs header offers « Tout arrêter » (`{all:true}`) and « Vider » with the saved count and size. The console header adds « suivre » (`hqTermFollow`, released as soon as you scroll up), a find bar over the transcript text node (`hqTermFindRun`, count + ‹ ›), « Envoyer » (export to Inbox) and clickable `http(s)` / `Inbox/…` tokens. The composer adds Tab completion (history, then allowlist labels, then pins), « PC suivant » and a pin chip row (`hq_shell_pins`); stdin is closed, which the hint states. Any finished job toasts, and one past `HQ_TERM_NOTIFY_MS` (30 s) says how long it took (`hqTermFinish`); if the tab is hidden, `hqTermLongNotify` also raises a system `Notification` (permission asked once on the first run, click focuses the tab). Tests: [test-index.md](test-index.md).

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
| GET | `/api/inventoria/status` | greeting, notes, voice (no model call) |
| POST | `/api/inventoria/memory` | `{action: add\|forget}` her own notes |
| POST | `/api/inventoria/voice` | speak a line in her saved voice |
| POST | `/api/inventoria/watch` | `{action: set\|remove}` per-item alert thresholds |
| POST | `/api/inventoria/purchased` | ticked-off items -> one adjust draft (no model call) |
| POST | `/api/inventoria/to-grocery` | shopping list or `{lines}` -> newest open (non-meal-plan) grocery list, else a new one |
| POST | `/api/inventoria/detections` | reviewed multi-item photo rows -> adjust/create drafts (no model call) |
| POST | `/api/inventoria/notify` | offline alert settings (`enabled`, `instant`, `digest_hour`, `test`) |
| POST | `/api/inventoria/ops/{id}/undo` | inverse draft for a committed batch |

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

### Musica

- GET and POST /api/musica/taste read the taste settings and update history sharing. Admin session and CSRF apply to POST.
- `POST /api/musica/confirm` consumes the one-time token for a destructive Musica action. Admin session and CSRF required.
- `GET /api/spotify/albums/{id}` reads album metadata and a page of tracks. `GET /api/spotify/artists/{id}/albums` lists albums and singles. Both accept `offset` and require an admin session.
- `GET /api/music/taste` reads shared taste. `POST /api/music/taste` migrates browser bans, bans or restores artists, updates history sharing and records seen Spotify items. Admin session and CSRF apply to POST.
- `GET /api/music/radar` reads the release cache. `POST /api/music/radar/run` runs the scan or reuses the daily cache when `force: false`.
- `POST /api/musica/speak` accepts `text` and optional `language`, then returns the local speech audio URL. Admin session and CSRF required.
- `POST /api/musica/lyrics` accepts `{title, artist, duration}` (duration in seconds) and returns `{ok, lrc}` from LRCLIB. `lrc` is empty when no timed version matches. Used by Lecteur and Musique › Studio. Admin session and CSRF required.
- DJ Musica show (`hq_music_dj`, admin; POST needs CSRF): `GET /api/musica/dj/state`; `POST /api/musica/dj/start` `{show: dj|matinale|focus|recap|premiere, steer?, preset?}` returns 202 at once and prepares in the background (pools in parallel, planning, intro drop, playback); `prep` in the state reports `stage` (pools → writing → voice → play → done), `pct`, `label`, and on completion `announce` and `playback` (the browser API helper times out at 15 s, so nothing slow runs inside a request); `POST /api/musica/dj/observe` `{uri, previous_uri, previous_ms}` is called by the browser on each track change and returns the drops to play (ignored while the PC station runs); `POST /api/musica/dj/steer` `{text | preset: calme|energie|change|decouverte|nostalgie|nouveautes|ban}` replans now (also 202 + `prep`); `POST /api/musica/dj/stop`; `POST /api/musica/dj/next` jumps to the next segment (`jump`: now | pending | failed); `POST /api/musica/dj/voice-compare` `{mood?, text?}` and `POST /api/musica/dj/voice-reference` (Chatterbox A/B and re-clone); `POST /api/musica/dj/go` `{segment_id}` starts the segment's music after her intro (state `awaiting` lists the intro drops to play first); `POST /api/musica/dj/guest` `{who: transferania|else}`; `POST /api/musica/dj/learned/reset`; `POST /api/musica/dj/settings`; `GET/POST /api/musica/dj/jingles`; `GET /api/musica/dj/weekly` (latest weekly audio recap, `job` progress) and `POST /api/musica/dj/weekly` `{force?}` (202, builds this week's episode in the background, `hq_music_weekly`); `GET /api/musica/dj/audio/drop-<hash>.mp3` or `weekly-<YYYY>-W<ww>-<hash>.mp3` serves a mixed drop or episode. The bridge tick runs scheduled shows and idle jingle generation; `boot()` resumes the PC station.
- `GET /api/musica/dj/archive` lists aired episodes (Rembobiner), newest first. `POST /api/musica/dj/archive/replay` `{id, device_id?}` airs an archived episode again (202, same prep polling as `start`). `POST /api/musica/dj/duel` plans and airs Le Duel (202). `POST /api/musica/dj/duel/vote` `{choice: a|b}` closes it (409 `duel_closed` when none is open). Admin session and CSRF on POST.
- `GET /api/musica/dj/station` is the compact read for Accueil, the « coming up » strip and the moments bubble: `on_air` (names hidden during a blind match), `upcoming` (next occurrence of each grid slot plus the morning show and Sunday recap from the settings), `ready` (shows that came due and were not launched), `daily`, `tournament`, `previously` (what happened since his last visit, plain sentence, no model call), `slots`, `kinds`, `suggested`, `moments`. `POST /api/musica/dj/station/grid` `{slots: [...]}` replaces the weekly grid (max 14; each `{label, kind: dj|matinale|focus|recap|duel|daily|tournament, days: [0-6], time: "HH:MM", enabled}`; 400 `validation_error`) or `{suggested: true}` applies the suggested grid. `POST /api/musica/dj/station/launch` `{id, device_id?}` starts a slot (202, polled like `start`; 404 `not_found`). `POST /api/musica/dj/station/dismiss` `{id}` and `/seen` `{}` clear a ready entry / mark « previously » as read. `GET /api/musica/dj/station/memory` is what she has learned (loves, cooling, bans, day parts); `POST` it `{ban: name}` or `{unban: name}`. The DJ setting `moments` (bool) switches the HQ-wide nudges. Admin session and CSRF on POST.
- **Talk back and live reactions.** `POST /api/musica/dj/ask` `{text, device_id?}`: a question about what is on air (« pourquoi cette chanson ? », « who sings this? ») answers **200** `{kind: "ask", id, text, modelled, pending}`, the text at once; `GET /api/musica/dj/ask/<id>` returns `{pending, text, drop}` when her voice is recorded (`/api/musica/dj/audio/<drop>`). Anything else is a request and steers the show: **202** `{kind: "steer", ack: {text, drop}, …state}` with an acknowledgement to say while the segment is prepared. A blind duel never answers with a title. `POST /api/musica/dj/live/warm` (202) records her reaction lines in the background. `observe` answers may carry `reaction: {event, text, voiced}` (its drop is first in `drops`). Admin session and CSRF on POST.
- **Voice worker (another PC's GPU runs Chatterbox for Musica).** Admin (session + CSRF): `GET /api/musica/dj/voice-worker` (paired, online, GPU, last job, breaker), `POST …/voice-worker/code` (one-time pairing code, 10 min, only its hash is stored), `…/enable` `{enabled}`, `…/remove`. Worker side, no cookie and no CSRF, `Authorization: Bearer <worker id>.<token>` (HQ keeps only the token's SHA-256), served by `hq_voice_remote.handle_worker`: `POST /voice-worker/v1/enroll` `{code, name, info}`, `/poll` (8 s long poll, one job: `{id, text, voice, voice_stamp, exaggeration, cfg_weight, temperature}`), `/voice/<name>` (the reference clip, base64), `/result/<job id>` `{ok, wav_b64, ms}`. Detail: [musica-voice-worker.md](musica-voice-worker.md).
- `POST /api/musica/dj/tournament` `{size?: 4}` builds a bracket of 8 (or 4) verified video game songs and airs match 1 (202, polled like `start`). `POST /api/musica/dj/tournament/next` airs the next match (409 `duel_open` until the current one is voted, 409 `tournament_closed` when over). The body may carry `blind`, `window`, `wildcard` (booleans, default true), `angle` (id) or `theme` (free text). `POST /api/musica/dj/duel/listen` `{side: a|b}` replays one side's listening window. `GET /api/musica/dj/hall` returns the hall of fame, all-time ranking, rivalry and the theme list. Votes go through `/api/musica/dj/duel/vote`, which answers at once: `text` is the scripted reaction and `reaction: {id, pending}` says her model-written reaction is still being written; `GET /api/musica/dj/duel/reaction/<id>` returns `{pending, text}` (the client polls it, then speaks only the final line). The tournament lives in the Musique › Quiz tab.
- `GET /api/music/wrapped/{week|month|year}[/YYYY-MM-DD]` is the recap of a period from the listening journal (counts, hours, active days, longest streak, top artists and tracks, new artists, busiest weekday and hour, comparison with the previous period). `GET /api/music/on-this-day` lists what was played on today's date (±1 day) in earlier years. `GET /api/music/taste-map` returns the artists played in the last 90 days with back-to-back links, clusters, loners and the artists gone quiet. All read-only, admin session.
- `POST /api/musica/dj/mood` `{energy: 1-5, minutes: 10-240}` (or `{clear: true}`) sets the DJ mood dial and time budget; the last segment before the budget ends lands softly and the show signs off (`finished`). `POST /api/musica/dj/daily` starts the daily challenge (202; 409 `daily_done` once played today). `GET /api/musica/dj/hall/{games|decade|artists|albums|library|daily}` returns that kind's hall of fame; `POST /api/musica/dj/tournament` also takes `kind`. `/api/musica/dj/state` now carries `mood` and `daily`.
- `POST /api/musica/dj` returns one short DJ Musica line for a track change (`track`, `artist`, `album`, `uri`, `previous`, `style`: annonce / anecdote / transition). Server cooldown 45 s and no repeat per URI; `line` is empty on cooldown.
- Quiz Musica reaction: `POST /api/music/quiz/answer` returns the verdict with a scripted `line` at once and `reaction: {id, pending: true}`; `GET /api/music/quiz/reaction/<id>` returns `{pending, text}` once her model-written reaction (the song, his streak, the final score; `hq_musica.DANCE_CHAIN`, 12 s deadline) is ready. `text` is the scripted line again when the model failed; the browser polls it every 0.7 s and replaces the line. Admin session and CSRF on POST.
- `POST /api/musica/dance` `{nsfw?, track?, artist?, intensity?}` returns `lines`: up to 3 short comments for each moment (`start`, `drop`, `slow`, `fast`, `look`, `tired`, `end`, `shake`, and `spank` only when the adult gate allows it; they also feed her chip's spank and drag reactions), written in one model call (`hq_musica.dance_lines`, chain `DANCE_CHAIN`: 3.5 Flash Lite, Gemma 26B, 3.1 Flash Lite; 14 s deadline). The chip prefetches the pack at music start, on a new track and when it runs low, and falls back to its own canned lines. `lines` is empty on cooldown (20 s), during a blind match, on a malformed answer or on any model error; `nsfw` is a request, the server gate decides. Admin session and CSRF.
- `GET /api/music/journal[/YYYY-MM]` returns the monthly listening recap (`hq_music_journal`). `POST /api/music/journal/settings` `{enabled}` pauses or resumes the journal; `POST /api/music/journal/sync` reads Spotify recently-played now (90 s guard). `GET /api/music/journal-lookup/{artist}` returns first/last/count for one artist. The bridge background tick syncs every 20 min.
- `GET/POST /api/music/alerts` `{releases: bool}` — opt-in release alerts. With it on, the background tick runs the radar at most once a day and sends each new release once through HQ's notifier (Discord / web push, each opt-in in its own settings).
- `GET /api/music/mood` suggests an activity session from today's manual calendar events (read-only callback, no model call). `POST /api/music/activity` `{activity, minutes, play}` runs `activity_mix` with Musica's seeds.
- `POST /api/music/deck` returns verified discovery tracks for the swipe deck (`discover_from_profile`).
- `GET /api/music/quiz`, `POST /api/music/quiz/start` `{rounds: 5|10, source: saved|top|playlist, playlist_id}`, `POST /api/music/quiz/next` `{id}` (plays the round from a random `position_ms`), `POST /api/music/quiz/answer` `{id, choice}`. Answers stay server-side in `.hq-music/quiz.json` until guessed.
- Studio (loopback only, like the rest of `/api/music/studio/*`): `POST /api/music/studio/generate` also accepts `task` (`text2music` / `repaint` / `cover` / `extend`), `source_id`, `start`/`end` (repaint), `strength` (cover), `extra` (extend, 10–60 s) and `variants` (1–3). `GET /api/music/studio/audio/{id}.{2|3}` serves a variant; `POST /api/music/studio/pick` `{id, variant}` keeps one and trashes the others; `POST /api/music/studio/library` `{id, notify}` copies the take to `Inbox/Musica Studio/` (Lecteur + iPhone Fichiers); `POST /api/music/studio/lyrics` `{mode: draft|refine, prompt, idea, lyrics, language, duration}` returns lyrics from Musica without saving anything.
- `POST /api/music/session/generate`: each source may carry `energy` (1–5) and `config.energy_curve` (`none`, `arc`, `rise`, `fall`, `waves`, `flat`) reorders the picked tracks by rank-matching source energy to the curve.
