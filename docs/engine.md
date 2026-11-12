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

Not built yet: the Pistonia assistant (chat + propose-only actions) and idle auto-stop.
