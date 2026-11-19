"""One temporary state root for the bridge runtime in every test process.

Importing ``iphone_bridge`` binds its config, sessions, pid and temp paths, and
its server attaches the security, rate-limit and diagnostics stores to ``ROOT``
when it starts. Without a sandbox, a test process therefore rewrites
``bridge_config.json``, ``.bridge_sessions.json``, ``.hq-restart.log`` and
``.hq-carnet/diagnostics/*`` inside the live checkout — handler threads read
``ROOT`` at call time, so repointing it before the tests run also covers the
off-main-thread writers.

``tests/__init__.py`` calls :func:`sandbox` before any test module is imported,
which makes every bridge-importing test share one temp root. A test that means
to exercise production paths sets its own ``CONFIG_PATH``/``ROOT`` afterwards
and keeps that behaviour explicit.
"""
import atexit
import shutil
import tempfile
import time
from pathlib import Path

_ROOT: Path | None = None


def sandbox() -> Path:
    """Import the bridge once and repoint every state path at a temp root."""
    global _ROOT
    if _ROOT is not None:
        return _ROOT
    import iphone_bridge as bridge

    _prune_stale()
    root = Path(tempfile.mkdtemp(prefix="hq-bridge-state-"))
    _ROOT = root
    bridge.ROOT = root
    bridge.CONFIG_PATH = root / "bridge_config.json"
    bridge.CONFIG_BAK_PATH = root / ".bridge_config.json.bak"
    bridge.SESSIONS_PATH = root / "bridge_sessions.json"
    bridge.PID_PATH = root / "bridge.pid"
    bridge.TMP_DIR = root / ".tmp"
    # ``hq_state.state_root()`` falls back to the working directory — the checkout —
    # so every store with no binding of its own would still write live.
    import hq_state

    hq_state.bind_root(root)
    _attach_stores(root)
    _rebind_assistant_stores(root)
    atexit.register(cleanup)
    return root


# Stores the bridge binds to ``ROOT`` while it imports. Sandboxing ``bridge.ROOT``
# afterwards leaves those bindings naming the checkout, so a test that reaches one
# of them writes the Master's real state (the assistant harness only rebinds inside
# the modules that use it).
_BRIDGE_BOUND_STORES = ("hq_elsea", "hq_culinia", "hq_forgia", "hq_musica",
                        "hq_securia", "hq_pistonia_store", "hq_inventoria")


def _rebind_assistant_stores(root: Path) -> None:
    """Move every assistant store the bridge bound to the checkout onto ``root``.

    Only the root attribute is reassigned: the bridge's callbacks, getters and
    provider hooks stay exactly as it wired them.
    """
    try:
        import hq_assistant_visits

        hq_assistant_visits.bind_state_root(root)
    except Exception:  # noqa: BLE001 — an unbound visit store writes nothing anyway
        pass
    for name in _BRIDGE_BOUND_STORES:
        try:
            module = __import__(name)
        except Exception:  # noqa: BLE001 — a store that cannot import holds no path
            continue
        if hasattr(module, "_bound_root"):
            module._bound_root = root
        # Some modules expose ``_root`` as a helper function, not a root.
        elif hasattr(module, "_root") and not callable(module._root):
            module._root = root
        # Others keep it in the callbacks dict the bridge populated at import.
        elif isinstance(getattr(module, "_cb", None), dict) and "root" in module._cb:
            module._cb["root"] = root


def _attach_stores(root: Path) -> None:
    """Attach the long-lived diagnostics stores even when a test never starts the server."""
    holders = []
    try:
        import hq_diagnostics
        holders += [getattr(hq_diagnostics, name, None)
                    for name in ("ERRORS", "CLIENT_LOG", "SECURITY_LOG")]
    except Exception:  # noqa: BLE001 — an unattached store stays in memory only
        pass
    try:
        import hq_security
        holders += [getattr(hq_security, name, None)
                    for name in ("IP_BLOCKLIST", "AUTH_RATE_LIMITER")]
    except Exception:  # noqa: BLE001
        pass
    for holder in holders:
        attach = getattr(holder, "attach", None)
        if not callable(attach):
            continue
        try:
            attach(root)
        except Exception:  # noqa: BLE001 — a store that refuses a root keeps no path
            pass


def _prune_stale(max_age: float = 3600.0) -> None:
    """Remove sandbox roots left behind by a killed run (an atexit sweep cannot see those)."""
    base = Path(tempfile.gettempdir())
    now = time.time()
    for entry in base.glob("hq-bridge-state-*"):
        try:
            if now - entry.stat().st_mtime > max_age:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue


def current_root() -> Path | None:
    """The sandbox root in use, or ``None`` when the sandbox is off."""
    return _ROOT


def cleanup() -> None:
    """Remove the temp root; callers never depend on it afterwards."""
    global _ROOT
    if _ROOT is None:
        return
    shutil.rmtree(_ROOT, ignore_errors=True)
    _ROOT = None
