# Engine tab (local daemons)

One page (`#engine`, admin only, in the "Autres espaces" menu) to see and control the local daemons HQ depends on.

## What it shows
Per daemon: state (`ready` / `loading` / `down` / `foreign` / `error`), port, PID, memory (committed bytes, children included),
VRAM (when `nvidia-smi` exists), uptime, facts from its `/health` (e.g. loaded Phonon languages), a log tail, and
Start / Restart / Stop. Stop and Restart need a second click ("Confirmer ?"). Below the cards: the last actions taken.

Default registry (`hq_engine.register_defaults`): `bridge` (this server, read-only), `phonon` (port 8058), `xtts` (8057, Else),
`forge` (7860, observe-only, links to Forge Studio).

## Adding a daemon
```python
import hq_engine
hq_engine.register(hq_engine.Daemon(
    id="mything", label="My thing", description="...", port=8123, kind="service",
    process_hint="my_daemon.py",           # must appear in the owner's command line before HQ will stop it
    log_path=Path(".tmp/mything.log"),
    start=lambda: launch(),                # detached launch, returns quickly
    stop=None))                            # None = verified kill of whoever owns the port
```
`observe_only=True` shows a daemon without any control (owned by another subsystem). `details=lambda health: {...}` adds facts.

## Safety
* A process is only stopped if the spec allows it **and** the PID owning the port has `process_hint` in its command line;
  anything else on the port is reported `foreign` and never touched.
* Logs are served by daemon id (never by path), tailed (<= 300 lines / 64 KB) with `key/token/secret/password/authorization/cookie` values hidden.
* Admin only (`/api/engine/` is outside the upload-role allowlist); POST is CSRF-checked by the bridge before routing.
* The UI is built with `createElement` + `textContent` only.
* "Start" succeeds when the process or its port appears within 6 s (start hooks return "ready right now?", false while a model loads).

## API
`GET /api/engine/status` · `GET /api/engine/logs/<id>?lines=80` · `POST /api/engine/daemons/<id>/<start|stop|restart>`

Files: `hq_engine.py`, `assets/hq-engine.js`, `assets/hq-engine.css`, hooks in `iphone_bridge.py` (import, 2 routes, `engine` view,
panel, nav link, setView hook), tests `tests/test_hq_engine.py`, `tests/test_hq_engine_wiring.py`.

## Checks (things that are not a port)
A `Daemon` may carry `check=callable` returning `{"state", "facts", "note", "rows", "pid"}`; states add `idle` (a worker that is not
running right now), `busy` and `warn`. `idle` and `busy` count as healthy in the header chip, `warn`/`error`/`foreign` as "à vérifier".

| id | what it answers |
|---|---|
| `spotify` | Is the Spotify desktop app open (a Connect device exists only then)? Is HQ linked to the account, which offer (free limits playback)? "Démarrer" wakes the app. |
| `gemini` | Google AI Studio: keys configured, live reachability via one cached (60 s) models-list call (no generation quota used), latency, requests today. 429 = `warn`, 400/401/403 = `error`. Key sent in a header, never shown. |
| `logins` | Presence-only rows: Spotify account, Google AI keys, Hugging Face token (`HF_TOKEN` or `$HF_HOME/token`, needed by Phonon), Discord webhook (optional), HQ PIN. No value is ever read out. |
| `music` | ACE-Step: is `hq_music_studio_worker.py` running (`busy`) or not (`idle`); venv present; last job result and compute time; log tail of the latest job. The settings shown (turbo DiT + INT8, 0.6B LM on the PyTorch backend, CUDA, 8 steps, batch 1, CPU/DiT offload) are parsed from the worker script, so the card cannot disagree with what runs. |

Process lookups use psutil when installed, otherwise one PowerShell/CIM query (about 2 s, cached 10 s), so memory and worker detection
also work in a Python without psutil (the live bridge runs Python 3.13 without it; `pip install psutil` there makes it faster).

## Resource use
`GET /api/engine/status` also returns `system` (this PC) and, per daemon, `cpu_pct`, `rss_mb`, `vram_mb`, `uptime_s` and a `history`
(last 90 samples, one per status call).

* **This PC**: CPU % (GetSystemTimes delta), RAM (GlobalMemoryStatusEx), disk free, GPU name / load / VRAM / temperature (`nvidia-smi`).
* **Per daemon** (the whole process tree, so a venv launcher plus its worker count together): CPU % is the CPU-time delta since the previous
  sample, as a share of the whole machine; memory is committed (private) bytes, because Windows trims an idle daemon's working set;
  VRAM is read from the Windows "GPU Process Memory" counter because `nvidia-smi` prints `[N/A]` per process on WDDM. That counter takes
  about 3 s, so it refreshes in the background (and so does the PowerShell process list on a Python without psutil): a status request never
  waits for it, and VRAM shows from the second poll on.
* The tab draws bars (amber from 70 %, red from 90 %) and a two-line sparkline per daemon (memory, CPU).

## Other computers
Each extra PC runs `scripts/engine_agent.py`, which **pushes** a status report to HQ every 10 s. HQ never dials out and the browser never
supplies a host, same trust model as the Forge workers.

1. Engine tab > "Autres ordinateurs" > **Ajouter un ordinateur**: shows a one-time code (10 min, stored hashed) and the two commands.
2. On the PC (files needed: `scripts/engine_agent.py`, `hq_engine.py`, `hq_forge_worker.py`):
   `py -3 scripts\engine_agent.py pair --hq https://<your-hq-tailscale-name> --name "PC salon"` (code asked), then `py -3 scripts\engine_agent.py run`
   (a scheduled task at logon keeps it running). Credentials are saved in `%LOCALAPPDATA%\TransfertHQ\engine-agent.json` with a protected ACL.
3. The PC appears with its totals, its daemons, "En ligne" (a report in the last 35 s) or "Hors ligne · vu il y a ...". Rename / Retirer in the card.

Which daemons an agent watches: `%LOCALAPPDATA%\TransfertHQ\engine-agent-daemons.json` (`{"daemons": [{"id","label","kind","port","health_path","process_hint"}]}`),
default Forge 7860, Phonon 8058, XTTS 8057. Agent-side daemons are observe-only: HQ cannot start or stop anything on another PC.

Security (`hq_engine_fleet.py`): HMAC-SHA256 over method, path, timestamp, nonce and body hash (the `hq_forge_worker` wire format, a different
path prefix `/engine-agent/v1`), 90 s clock window, nonce replay cache, secrets wrapped with DPAPI (no plaintext fallback), enrollment
limited to 10 tries per IP / 30 global per 10 min, at most 16 PCs, reports capped at 64 KB. Every report field is type- and range-checked,
clipped and bounded (24 daemons, 4 GPUs); it is displayed as text only, never as markup, and never causes an action.
HTTPS is required (Tailscale); `--dev` allows http only for a loopback HQ in tests.

Admin routes: `POST /api/engine/machines/code`, `POST /api/engine/machines/<pc_id>/rename|remove`. Agent routes: `POST /engine-agent/v1/enroll|report`.

Not built yet: the Pistonia assistant (chat + propose-only actions), idle auto-stop, starting/stopping daemons on other PCs.
