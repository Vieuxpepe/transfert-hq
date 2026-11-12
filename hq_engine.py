"""Engine: one place to see and control the local daemons HQ depends on (voice engines, image backend, ...).

* A **registry** of :class:`Daemon` specs. Adding a daemon is one ``register(Daemon(...))`` call; the Engine tab, the
  status API and the safety checks are generic.
* Status is **probed live** (loopback TCP + optional ``/health`` JSON + process lookup). Nothing is cached across
  requests except a 3 s nvidia-smi sample, so the tab never shows a stale "warm".
* **Safety**: a process is only ever stopped when (a) the daemon spec says it may be, and (b) the PID that owns the
  daemon's port has a command line containing the spec's ``process_hint``. An unrelated program that happens to sit on
  the port is reported as ``foreign`` and never touched. Log files are exposed by daemon id only, never by path, and
  are tailed (bounded) with secrets scrubbed.
* Admin only: routes live under ``/api/engine/`` which is outside the upload-role allowlist; POST is CSRF-checked by the
  bridge before routing.

Routes (see :func:`http_get` / :func:`http_post`):
    GET  /api/engine/status
    GET  /api/engine/logs/<id>?lines=80
    POST /api/engine/daemons/<id>/<start|stop|restart>
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

try:  # optional: without it we still report up/down and ready, just no memory / PID lookup by port
    import psutil
except Exception:  # pragma: no cover - environment dependent
    psutil = None  # type: ignore[assignment]

PROJECT_ROOT = Path(__file__).resolve().parent
LOG_TAIL_MAX_LINES = 300
LOG_TAIL_MAX_BYTES = 64 * 1024
EVENTS_MAX = 50
PROBE_TIMEOUT = 1.0
STOP_WAIT = 6.0
START_WAIT = 6.0
GPU_TTL = 3.0
ACTIONS = ("start", "stop", "restart")
_SECRET_RE = re.compile(r"(?i)\b(api[_-]?key|token|secret|password|authorization|cookie)\b(\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|\S+)")
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}\Z")


@dataclass
class Daemon:
    id: str
    label: str
    description: str
    port: Optional[int] = None                       # loopback port it listens on (None: only process-based)
    kind: str = "service"                            # voice | image | core | service (just a UI grouping)
    health_path: Optional[str] = "/health"           # GET -> JSON (``ready`` bool, optional ``pid``) or plain 200
    process_hint: str = ""                           # substring the owner's command line must contain before we kill it
    log_path: Optional[Path] = None
    start: Optional[Callable[[], Any]] = None        # launches detached, returns quickly
    stop: Optional[Callable[[], Any]] = None         # custom stop; default = verified kill of the port owner
    kill_by_port: bool = True                        # allow the generic verified kill when ``stop`` is None
    observe_only: bool = False                       # never start/stop from the tab (owned by another subsystem)
    details: Optional[Callable[[dict], dict]] = None  # health JSON -> small dict of facts for the card
    link_view: Optional[str] = None                  # HQ view that owns this daemon (e.g. "forge")
    self_process: bool = False                       # the bridge itself

    def can(self, action: str) -> bool:
        if self.observe_only or self.self_process:
            return False
        if action == "start":
            return self.start is not None
        if action == "stop":
            return self.stop is not None or (self.kill_by_port and bool(self.process_hint))
        if action == "restart":
            return self.can("start") and self.can("stop")
        return False


_registry: dict[str, Daemon] = {}
_reg_lock = threading.RLock()
_events: deque[dict] = deque(maxlen=EVENTS_MAX)
_action_locks: dict[str, threading.Lock] = {}
_gpu_cache: dict[str, Any] = {"at": 0.0, "value": None}
_boot_time = time.time()


# ---- registry ----------------------------------------------------------------------------------------------------

def register(d: Daemon) -> Daemon:
    if not _ID_RE.match(d.id):
        raise ValueError(f"bad daemon id: {d.id!r}")
    with _reg_lock:
        _registry[d.id] = d
        _action_locks.setdefault(d.id, threading.Lock())
    return d


def unregister(daemon_id: str) -> None:
    with _reg_lock:
        _registry.pop(daemon_id, None)


def get(daemon_id: str) -> Optional[Daemon]:
    with _reg_lock:
        return _registry.get(daemon_id)


def all_daemons() -> list[Daemon]:
    with _reg_lock:
        return list(_registry.values())


def reset_events() -> None:
    _events.clear()


def _event(daemon_id: str, action: str, ok: bool, message: str = "") -> None:
    _events.appendleft({"at": time.time(), "id": daemon_id, "action": action, "ok": bool(ok), "message": message[:200]})


# ---- probing -----------------------------------------------------------------------------------------------------

def _port_open(port: int, timeout: float = 0.3) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def _health(d: Daemon) -> Optional[dict]:
    """None = nothing answered. {} = answered but not JSON. dict = parsed health JSON."""
    if not d.port or d.health_path is None:
        return None
    if not _port_open(int(d.port)):      # a closed loopback port can take ~1 s to refuse on Windows: bound it
        return None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{int(d.port)}{d.health_path}", timeout=PROBE_TIMEOUT) as r:
            raw = r.read(65536)
            try:
                data = json.loads(raw or b"{}")
            except ValueError:
                return {"_plain": True}
            return data if isinstance(data, dict) else {"_plain": True}
    except urllib.error.HTTPError as exc:
        # A server that answers 4xx/5xx (e.g. 503 "not ready") is up but not ready.
        return {"ready": False, "_http": exc.code}
    except Exception:
        return None


_owner_cache: dict[int, tuple[float, Optional[int]]] = {}
OWNER_TTL = 5.0


def _owner_pid(port: int) -> Optional[int]:
    """PID that LISTENs on 127.0.0.1:<port> (cached a few seconds: the lookup is slow on Windows)."""
    hit = _owner_cache.get(port)
    if hit and time.time() - hit[0] < OWNER_TTL:
        return hit[1]
    pid = _owner_pid_uncached(port)
    _owner_cache[port] = (time.time(), pid)
    return pid


def _owner_pid_uncached(port: int) -> Optional[int]:
    """psutil first, ``netstat -ano`` as a Windows fallback."""
    if psutil is not None:
        try:
            for c in psutil.net_connections(kind="tcp"):
                if c.status == psutil.CONN_LISTEN and c.laddr and c.laddr.port == port and c.pid:
                    return int(c.pid)
        except Exception:
            pass
    if os.name == "nt":
        try:
            out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True, timeout=5,
                                 creationflags=0x08000000).stdout
            for line in out.splitlines():
                parts = line.split()
                if len(parts) >= 5 and parts[3].upper() == "LISTENING" and parts[1].endswith(f":{port}"):
                    return int(parts[4])
        except Exception:
            pass
    return None


def _find_by_hint(hint: str) -> Optional[int]:
    """A process whose command line contains ``hint`` (used when the port is still closed: model loading)."""
    if psutil is None or not hint:
        return None
    me = os.getpid()
    try:
        for p in psutil.process_iter(["pid", "cmdline"]):
            if p.info["pid"] == me:
                continue
            cmd = " ".join(p.info.get("cmdline") or [])
            if hint in cmd:
                return int(p.info["pid"])
    except Exception:
        pass
    return None


def _mem(p) -> int:
    """Committed (private) bytes on Windows: an idle daemon's working set is trimmed by the OS and would read as ~20 MB
    while still owning its whole model. Elsewhere, resident size."""
    mi = p.memory_info()
    return int(getattr(mi, "private", 0) or mi.rss)


def _proc_info(pid: Optional[int]) -> dict:
    if not pid or psutil is None:
        return {}
    try:
        p = psutil.Process(pid)
        with p.oneshot():
            rss = _mem(p)
            started, cmd = p.create_time(), " ".join(p.cmdline())
        pids = [pid]
        for c in p.children(recursive=True):    # a venv python.exe is a thin launcher: the real work is in a child
            try:
                rss += _mem(c)
                pids.append(c.pid)
            except Exception:
                pass
        return {"pid": pid, "pids": pids, "rss_mb": round(rss / 1048576), "started": started, "cmdline": cmd}
    except Exception:
        return {"pid": pid}


def _gpu() -> Optional[dict]:
    """{pid: used_mb} from nvidia-smi, or None when there is no NVIDIA driver. Sampled at most every GPU_TTL s."""
    now = time.time()
    if now - _gpu_cache["at"] < GPU_TTL:
        return _gpu_cache["value"]
    value: Optional[dict] = None
    try:
        out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=4,
                             creationflags=0x08000000 if os.name == "nt" else 0)
        if out.returncode == 0:
            value = {}
            for line in out.stdout.splitlines():
                bits = [b.strip() for b in line.split(",")]
                if len(bits) == 2 and bits[0].isdigit() and bits[1].replace(".", "", 1).isdigit():
                    value[int(bits[0])] = int(float(bits[1]))
    except Exception:
        value = None
    _gpu_cache.update(at=now, value=value)
    return value


def probe(d: Daemon) -> dict:
    """One daemon's live status card. States: ready | loading | down | foreign | error."""
    out: dict[str, Any] = {
        "id": d.id, "label": d.label, "description": d.description, "kind": d.kind, "port": d.port,
        "link_view": d.link_view, "observe_only": bool(d.observe_only or d.self_process), "self": bool(d.self_process),
        "can": {a: d.can(a) for a in ACTIONS}, "has_log": bool(d.log_path), "state": "down", "details": {},
    }
    if d.self_process:
        info = _proc_info(os.getpid())
        out.update(state="ready", pid=os.getpid(), rss_mb=info.get("rss_mb"), uptime_s=int(time.time() - _boot_time))
        return out

    health = _health(d)
    pid: Optional[int] = None
    if health is not None:
        pid = health.get("pid") if isinstance(health.get("pid"), int) else None
        if pid is None and d.port:
            pid = _owner_pid(int(d.port))
        info = _proc_info(pid)
        foreign = bool(d.process_hint and info.get("cmdline") and d.process_hint not in info["cmdline"])
        ready = bool(health.get("ready", health.get("_plain", False)))
        errors = health.get("errors") if isinstance(health.get("errors"), dict) else {}
        if foreign:
            out["state"] = "foreign"
        elif errors and not ready:
            out["state"] = "error"
        else:
            out["state"] = "ready" if ready else "loading"
        if errors:
            out["details"]["errors"] = {str(k): str(v)[:160] for k, v in list(errors.items())[:5]}
        if d.details:
            try:
                out["details"].update({k: v for k, v in d.details(health).items()})
            except Exception:
                pass
    else:
        if d.port and d.health_path is not None and _port_open(int(d.port)):
            out["state"] = "foreign" if not d.process_hint else "loading"   # port bound but not answering yet
            pid = _owner_pid(int(d.port))
        else:
            pid = _find_by_hint(d.process_hint)
            if pid:
                out["state"] = "loading"                                    # process exists, port not open yet
        info = _proc_info(pid)
    if pid:
        out["pid"] = pid
        if info.get("rss_mb") is not None:
            out["rss_mb"] = info["rss_mb"]
        if info.get("started"):
            out["uptime_s"] = max(0, int(time.time() - info["started"]))
        gpu = _gpu()
        if gpu is not None:
            used = [gpu[x] for x in info.get("pids", [pid]) if x in gpu]
            if used:
                out["vram_mb"] = sum(used)
    return out


def status() -> dict:
    ds = all_daemons()
    cards: list[Optional[dict]] = [None] * len(ds)

    def work(i: int, d: Daemon) -> None:
        try:
            cards[i] = probe(d)
        except Exception as exc:   # a broken probe must never take the tab down
            cards[i] = {"id": d.id, "label": d.label, "description": d.description, "kind": d.kind, "port": d.port,
                        "state": "error", "can": {a: False for a in ACTIONS}, "observe_only": True, "has_log": False,
                        "details": {"errors": {"probe": str(exc)[:160]}}}

    threads = [threading.Thread(target=work, args=(i, d), daemon=True) for i, d in enumerate(ds)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=8)
    daemons = [c for c in cards if c]
    return {"ok": True, "now": time.time(), "daemons": daemons, "events": list(_events), "gpu": _gpu() is not None,
            "summary": {"ready": sum(1 for c in daemons if c["state"] == "ready"),
                        "total": len(daemons), "problems": sum(1 for c in daemons if c["state"] in ("error", "foreign"))}}


# ---- actions -----------------------------------------------------------------------------------------------------

def _verified_owner(d: Daemon) -> Optional[int]:
    """PID to kill for ``d`` or None. Refuses anything whose command line does not carry the spec's hint."""
    if not d.process_hint:
        return None
    pid = None
    if d.port:
        h = _health(d)
        if h is not None and isinstance(h.get("pid"), int):
            pid = h["pid"]
        if pid is None:
            pid = _owner_pid(int(d.port))
    if pid is None:
        pid = _find_by_hint(d.process_hint)
    if not pid or pid == os.getpid():
        return None
    cmd = _proc_info(pid).get("cmdline", "")
    return pid if d.process_hint in cmd else None


def _kill(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=10, creationflags=0x08000000)
    else:
        os.kill(pid, 15)


def _is_down(d: Daemon) -> bool:
    if d.port and _port_open(int(d.port)):
        return False
    return _find_by_hint(d.process_hint) is None if d.process_hint else True


def _do_stop(d: Daemon) -> tuple[bool, str]:
    if d.stop is not None:
        try:
            res = d.stop()
            return (res is not False), ""
        except Exception as exc:
            return False, f"stop failed: {exc}"[:200]
    pid = _verified_owner(d)
    if pid is None:
        return (_is_down(d), "nothing to stop" if _is_down(d) else "refused: owner process does not look like this daemon")
    try:
        _kill(pid)
    except Exception as exc:
        return False, f"kill failed: {exc}"[:200]
    end = time.time() + STOP_WAIT
    while time.time() < end:
        if _is_down(d):
            return True, ""
        time.sleep(0.25)
    return _is_down(d), "still running after stop"


def _do_start(d: Daemon) -> tuple[bool, str]:
    if not _is_down(d):
        return True, "already running"
    try:
        d.start() if d.start else False
    except Exception as exc:
        return False, f"start failed: {exc}"[:200]
    # The start hooks return "ready right now?", which is False for a daemon that is launching. Success means the
    # process (or its port) showed up shortly after the launch.
    end = time.time() + START_WAIT
    while time.time() < end:
        if not _is_down(d):
            return True, ""
        time.sleep(0.3)
    return False, "could not start (is it installed?)"


def act(daemon_id: str, action: str) -> tuple[int, dict]:
    d = get(daemon_id)
    if d is None:
        return 404, {"error": "unknown daemon", "code": "not_found"}
    if action not in ACTIONS:
        return 400, {"error": "unknown action", "code": "validation_error"}
    if not d.can(action):
        return 409, {"error": f"{action} is not available for {d.label}", "code": "not_supported"}
    lock = _action_locks.setdefault(d.id, threading.Lock())
    if not lock.acquire(blocking=False):
        return 409, {"error": "another action is already running for this daemon", "code": "busy"}
    try:
        ok, msg = True, ""
        if action in ("stop", "restart"):
            ok, msg = _do_stop(d)
        if ok and action in ("start", "restart"):
            ok, msg = _do_start(d)
        _event(d.id, action, ok, msg)
        card = probe(d)
        return (200 if ok else 500), {"ok": ok, "message": msg, "daemon": card, "events": list(_events)}
    finally:
        lock.release()


# ---- logs --------------------------------------------------------------------------------------------------------

def scrub(line: str) -> str:
    return _SECRET_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}[hidden]", line)


def tail_log(daemon_id: str, lines: int = 80) -> tuple[int, dict]:
    d = get(daemon_id)
    if d is None:
        return 404, {"error": "unknown daemon", "code": "not_found"}
    if not d.log_path:
        return 404, {"error": "no log for this daemon", "code": "not_found"}
    lines = max(1, min(LOG_TAIL_MAX_LINES, int(lines)))
    p = Path(d.log_path)
    try:
        size = p.stat().st_size
        with open(p, "rb") as f:
            if size > LOG_TAIL_MAX_BYTES:
                f.seek(size - LOG_TAIL_MAX_BYTES)
            raw = f.read(LOG_TAIL_MAX_BYTES)
    except OSError:
        return 200, {"ok": True, "id": d.id, "lines": [], "size": 0, "note": "no log yet"}
    text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n")
    rows = [scrub(ln)[:400] for ln in text.split("\n") if ln.strip()][-lines:]
    return 200, {"ok": True, "id": d.id, "lines": rows, "size": size}


# ---- HTTP (called by the bridge) --------------------------------------------------------------------------------

_LOGS_RE = re.compile(r"^/api/engine/logs/([a-z0-9][a-z0-9_-]{0,31})\Z")
_ACT_RE = re.compile(r"^/api/engine/daemons/([a-z0-9][a-z0-9_-]{0,31})/(start|stop|restart)\Z")


def http_get(path: str, query: Optional[dict] = None) -> tuple[int, dict]:
    query = query or {}
    if path == "/api/engine/status":
        return 200, status()
    m = _LOGS_RE.match(path)
    if m:
        try:
            n = int((query.get("lines") or ["80"])[0])
        except (ValueError, TypeError, IndexError):
            n = 80
        return tail_log(m.group(1), n)
    return 404, {"error": "not found", "code": "not_found"}


def http_post(path: str, data: Optional[dict] = None) -> tuple[int, dict]:
    m = _ACT_RE.match(path)
    if m:
        return act(m.group(1), m.group(2))
    return 404, {"error": "not found", "code": "not_found"}


def redact_for_logs(payload: Any) -> dict:
    if isinstance(payload, dict):
        return {"error": str(payload.get("error", ""))[:120], "code": payload.get("code", "error")}
    return {"error": "error", "code": "error"}


# ---- default registry --------------------------------------------------------------------------------------------

def register_defaults() -> None:
    """XTTS, Phonon, Forge (observe-only) and the bridge itself. Imports are local so a missing optional engine
    never stops the others from being listed."""
    register(Daemon(id="bridge", label="HQ bridge", kind="core", self_process=True, port=None, health_path=None,
                    description="Le serveur qui affiche cette page."))
    try:
        import hq_voice_phonon as ph

        def ph_details(h: dict) -> dict:
            models = h.get("models") or {}
            return {"models": ", ".join(sorted(models)) or "none loaded"}

        register(Daemon(id="phonon", label="Phonon TTS", kind="voice", port=ph.PHONON_PORT, health_path="/health",
                        process_hint="phonon_daemon", log_path=ph.PHONON_LOG, details=ph_details,
                        start=lambda: ph.start_daemon(wait_sec=0.0), stop=lambda: ph.stop_daemon(),
                        description="Voix sur processeur de Transferina, Inventoria et Musica (anglais)."))
    except Exception:
        pass
    try:
        import hq_voice as xt

        def xt_details(h: dict) -> dict:
            return {"load_sec": h.get("load_sec")} if h.get("load_sec") is not None else {}

        register(Daemon(id="xtts", label="Coqui XTTS", kind="voice", port=xt.XTTS_DAEMON_PORT, health_path="/health",
                        process_hint="coqui_xtts_daemon", log_path=xt.DAEMON_LOG, details=xt_details,
                        start=lambda: xt.start_daemon(wait_sec=0.0),
                        description="Voix d'Else sur carte graphique (français/anglais). Garde le modèle chaud en VRAM."))
    except Exception:
        pass
    register(Daemon(id="forge", label="Forge (image backend)", kind="image", port=7860, health_path="/",
                    observe_only=True, link_view="forge",
                    description="Moteur de génération d'images, piloté depuis l'onglet Forge Studio."))


register_defaults()
