# Bridge lifecycle — start, restart, and one identity at a time

The HQ bridge is a single process that owns one state root, two ports (8765 bridge, 8766 planner) and a handful of
locks. This page is the operator procedure and the invariants behind it. Audit history: `docs/hq-symptom-index.md`
for symptoms, `docs/agent-debugging.md` for incident triage.

## The one canonical chain

```
logon task / Restart-Bridge.bat / POST /api/pc/restart-bridge
        └─ Restart-Bridge.ps1            (mutex, stop, restore identity)
              └─ start_bridge_hidden.vbs (hidden window)
                    └─ start_bridge_logged.cmd (rotation, duplicate guard, logs, identity line)
                          └─ py -3 iphone_bridge.py
```

`Start-iPhone-Upload.bat` calls the same `start_bridge_logged.cmd`, so it shares the guard and the logs. There is no
other supported way to start the bridge.

## Identity: state root + owner mode

A state root holds `bridge_config.json`, `bridge_sessions.json`, `bridge.pid`, `bridge.lock`, `.hq-terminal/`,
household data and caches. Two roots are two different applications: different PIN/config, different sessions (so a
different login), different history.

The running bridge publishes the identity a restarter must restore in `.hq-boot.json` next to `iphone_bridge.py`:

```json
{ "pid": 1234, "port": 8765, "state_root": "C:\\Transfert", "production_owner": false, "started": 1762900000 }
```

- It is written only for port 8765, so a scratch instance on another port can never overwrite the live identity.
- It is removed on shutdown, and only by the process it describes.
- `Restart-Bridge.ps1` reads it and hands the identity to the launcher through `HQ_LAUNCH_PORT`,
  `HQ_LAUNCH_STATE_ROOT` and `HQ_LAUNCH_OWNER`. The launcher ignores any inherited `HQ_PORT` / `HQ_STATE_ROOT` /
  `HQ_PRODUCTION_OWNER`: a stray value in a shell used to move the bridge to another state root, or make it look like
  a side-by-side release and refuse to bind 8765 at all.
- The live checkout is never passed as an explicit state root. `HQ_STATE_ROOT` pointing at the code folder makes the
  bridge take the state lock and refuse 8765, so the restarter normalises that case to "defaults".
- Before this existed, a restart from Explorer silently moved the bridge to the default state root, which looked like
  "the app forgot everything and logged me out".

`Restart-Bridge.ps1 -Plan` prints the identity it would restore, the targets it would stop, and exits without
touching anything — it also works while another restart is in flight. A side-by-side release must name its own root:
`Restart-Bridge.ps1 -Port 8799 -StateRoot C:\hq-state\live` (refused without it, because the published identity only
describes port 8765).

## Invariants the code enforces

| Invariant | Where |
|---|---|
| One listener per port | `HQServer.server_bind` binds with `SO_EXCLUSIVEADDRUSE` on Windows |
| One owner per state root | `bridge.lock` (`acquire_state_lock`) |
| One restart at a time, machine-wide | `Global\TransfertBridgeRestart` mutex in `Restart-Bridge.ps1` |
| A duplicate start writes nothing | `already_running()` runs before migrations and `reconcile_orphans` |
| Production ports are refused to side-by-side releases | `side_by_side_ports_ok`, in both launch modes |
| Every start and every death leaves a line | `bridge_stdout.log` / `bridge_stderr.log` (`===== boot` / `===== exit … code N`) |
| A second instance keeps its own log | `bridge_stdout-<port>.log` for any port other than 8765 |
| The guard is decided by Windows, not by log text | `Get-NetTCPConnection` exit code in the launcher |

## Rules of thumb

- **Restart from the app or `Restart-Bridge.bat`.** Both restore the running identity; both are serialised.
- **Never run `py iphone_bridge.py` from another folder or with a hand-typed `HQ_STATE_ROOT`** while a bridge runs.
  The port and the state lock will refuse it, but it will have loaded that root's state first, and a stale
  `running` job in it is marked `interrupted` on the way.
- **A side-by-side release never takes 8765/8766.** Use `start_release.ps1 -ReleaseDir … -StateRoot … -Port …`;
  it sets the environment itself and validates the layout.
- **`install_autostart.ps1` does not regenerate the VBS.** Editing `start_bridge_hidden.vbs` by hand is fine; the
  installer only re-registers the task.
- **Logs are bounded**: both files rotate to `.1` at 5 MB on the next start. A side-by-side instance writes
  `bridge_stdout-<port>.log`, because the live launcher holds its own log open for the whole run.
- **Telling a death apart from a kill**: `exit … code -1` means the process was terminated from outside (a restart,
  Task Manager, the task's 3 retries); a Python traceback in `bridge_stderr.log` means the bridge itself failed.

## Task settings

`TransfertBridge` runs at logon, `MultipleInstances: IgnoreNew`, `RestartCount 3` / `PT1M`, no execution time limit
(a bridge runs for weeks; the 72 h default killed it mid-session). The task starts the live checkout; a production
state root at `C:\hq-state\live` is a side-by-side deployment and is not the logon path.
