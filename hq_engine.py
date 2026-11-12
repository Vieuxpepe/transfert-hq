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

import ctypes
import json
import os
import re
import shutil
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
HEALTHY_STATES = ("ready", "idle", "busy")      # idle = a worker that is not running right now, which is its normal state
PROBLEM_STATES = ("error", "foreign", "warn")
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
    log_path: Any = None                             # Path, or a callable returning a Path/None (e.g. "latest job log")
    check: Optional[Callable[[], dict]] = None       # custom probe for things that are not a port (apps, APIs, logins)
    start: Optional[Callable[[], Any]] = None        # launches detached, returns quickly
    stop: Optional[Callable[[], Any]] = None         # custom stop; default = verified kill of the port owner
    kill_by_port: bool = True                        # allow the generic verified kill when ``stop`` is None
    observe_only: bool = False                       # never start/stop from the tab (owned by another subsystem)
    details: Optional[Callable[[dict], dict]] = None  # health JSON -> small dict of facts for the card
    link_view: Optional[str] = None                  # HQ view that owns this daemon (e.g. "forge")
    self_process: bool = False                       # the bridge itself
    idle_stop: bool = False                          # may be stopped automatically after a quiet period (opt-in per daemon)
    idle_default_min: int = 15                       # suggested quiet period shown in the UI

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

_ps_cache: dict[str, Any] = {"at": 0.0, "rows": []}
PS_TTL = 10.0                 # the PowerShell fallback costs ~2 s per refresh, so refresh it less often


def _proc_table_build() -> list[dict]:
    rows: list[dict] = []
    if psutil is not None:
        try:
            # pid + cmdline only: asking psutil for name/ppid/create_time opens every process and takes seconds on Windows
            for p in psutil.process_iter(["pid", "cmdline"]):
                i = p.info
                rows.append({"pid": i["pid"], "ppid": 0, "name": "", "cmdline": " ".join(i.get("cmdline") or []),
                             "private_mb": None, "started": None})
        except Exception:
            rows = []
    elif os.name == "nt":
        script = ("Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{p=$_.ProcessId;pp=$_.ParentProcessId;"
                  "n=$_.Name;c=$_.CommandLine;w=[int64]$_.PrivatePageCount;"
                  "s=([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds()} } | ConvertTo-Json -Compress")
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True,
                                 text=True, timeout=15, creationflags=0x08000000).stdout
            data = json.loads(out or "[]")
            for r in (data if isinstance(data, list) else [data]):
                rows.append({"pid": int(r["p"]), "ppid": int(r.get("pp") or 0), "name": r.get("n") or "",
                             "cmdline": r.get("c") or "", "private_mb": round(int(r.get("w") or 0) / 1048576),
                             "started": r.get("s")})
        except Exception:
            rows = []
    return rows


_ps_busy = threading.Event()


def _proc_table_refresh() -> None:
    rows = _proc_table_build()
    _ps_cache.update(at=time.time(), rows=rows)
    _ps_busy.clear()


def _proc_table() -> list[dict]:
    """Every process as {pid, ppid, name, cmdline, private_mb, started}. psutil when present, else one PowerShell/CIM
    query (~2 s). Stale-while-revalidate: once there is data, an expired table is returned at once and refreshed in the
    background, so a status request never waits for it. Callers that need the truth now (stop/start) reset the cache
    time to 0, which forces a synchronous rebuild."""
    now = time.time()
    ttl = PS_TTL if psutil is None else 3.0
    if now - _ps_cache["at"] < ttl:
        return _ps_cache["rows"]
    if _ps_cache["at"] > 0 and _ps_cache["rows"]:
        if not _ps_busy.is_set():
            _ps_busy.set()
            threading.Thread(target=_proc_table_refresh, daemon=True).start()
        return _ps_cache["rows"]
    rows = _proc_table_build()
    _ps_cache.update(at=time.time(), rows=rows)
    return rows


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
    if not hint:
        return None
    me = os.getpid()
    for r in _proc_table():
        if r["pid"] != me and hint in r["cmdline"]:
            return int(r["pid"])
    return None





def _mem(p) -> int:
    """Committed (private) bytes on Windows: an idle daemon's working set is trimmed by the OS and would read as ~20 MB
    while still owning its whole model. Elsewhere, resident size."""
    mi = p.memory_info()
    return int(getattr(mi, "private", 0) or mi.rss)


def _proc_info_from_table(pid: int) -> dict:
    rows = {r["pid"]: r for r in _proc_table()}
    me = rows.get(pid)
    if not me:
        return {}
    kids: dict[int, list[int]] = {}
    for r in rows.values():
        kids.setdefault(r["ppid"], []).append(r["pid"])
    pids, stack = [], [pid]
    while stack:
        x = stack.pop()
        if x in pids:
            continue
        pids.append(x)
        stack.extend(kids.get(x, []))
    mem = sum(rows[x]["private_mb"] or 0 for x in pids if x in rows)
    return {"pid": pid, "pids": pids, "rss_mb": mem or None, "started": me.get("started"), "cmdline": me["cmdline"]}


def _proc_info(pid: Optional[int]) -> dict:
    if not pid:
        return {}
    if psutil is None:
        return _proc_info_from_table(pid)
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


_gpu_lock = threading.Lock()
_gpu_proc_cache: dict[str, Any] = {"at": 0.0, "value": {}}
GPU_PROC_TTL = 8.0
_gpu_proc_busy = threading.Event()


def _num(text: str) -> Optional[float]:
    t = text.strip()
    return float(t) if re.fullmatch(r"\d+(\.\d+)?", t) else None


def _gpu_proc_mem_refresh() -> None:
    value: dict[int, int] = {}
    if os.name == "nt":
        script = ("(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction Stop).CounterSamples | "
                  "Where-Object { $_.CookedValue -gt 20MB } | ForEach-Object { '{0} {1}' -f $_.InstanceName, [int]($_.CookedValue/1MB) }")
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True,
                                 text=True, timeout=12, creationflags=0x08000000).stdout
            for line in out.splitlines():
                m = re.match(r"pid_(\d+)_\S+\s+(\d+)$", line.strip())
                if m:
                    value[int(m.group(1))] = value.get(int(m.group(1)), 0) + int(m.group(2))
        except Exception:
            value = {}
    _gpu_proc_cache.update(at=time.time(), value=value)
    _gpu_proc_busy.clear()


def _gpu_proc_mem() -> dict:
    """{pid: dedicated VRAM MB} from the Windows 'GPU Process Memory' counter. nvidia-smi prints [N/A] per process on
    WDDM, so this is the only per-process VRAM source there. The PowerShell call takes ~3 s, so it runs in the background
    and callers get the last answer (empty before the first one finishes): a status request never waits for it."""
    if time.time() - _gpu_proc_cache["at"] >= GPU_PROC_TTL and not _gpu_proc_busy.is_set():
        _gpu_proc_busy.set()
        threading.Thread(target=_gpu_proc_mem_refresh, daemon=True).start()
    return _gpu_proc_cache["value"]


def _gpu_sample() -> Optional[dict]:
    """{"gpus": [...], "apps": {pid: used_mb}} or None without an NVIDIA driver. Cached GPU_TTL seconds."""
    now = time.time()
    with _gpu_lock:
        if now - _gpu_cache["at"] < GPU_TTL:
            return _gpu_cache["value"]
        value: Optional[dict] = None
        flags = 0x08000000 if os.name == "nt" else 0
        try:
            q = subprocess.run(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                                "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=4, creationflags=flags)
            if q.returncode == 0:
                gpus = []
                for line in q.stdout.splitlines():
                    bits = [b.strip() for b in line.split(",")]
                    if len(bits) >= 5:
                        util, used, total, temp = (_num(bits[1]), _num(bits[2]), _num(bits[3]), _num(bits[4]))
                        gpus.append({"name": bits[0][:60], "util_pct": None if util is None else round(util),
                                     "vram_used_mb": None if used is None else round(used),
                                     "vram_total_mb": None if total is None else round(total),
                                     "temp_c": None if temp is None else round(temp)})
                apps: dict[int, int] = {}
                a = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                                   capture_output=True, text=True, timeout=4, creationflags=flags)
                for line in (a.stdout if a.returncode == 0 else "").splitlines():
                    bits = [b.strip() for b in line.split(",")]
                    if len(bits) == 2 and bits[0].isdigit() and _num(bits[1]) is not None:
                        apps[int(bits[0])] = int(float(bits[1]))
                value = {"gpus": gpus, "apps": apps}
        except Exception:
            value = None
        _gpu_cache.update(at=now, value=value)
        return value


def _gpu() -> Optional[dict]:
    """{pid: used_mb} (per-process VRAM) or None when there is no NVIDIA driver."""
    sample = _gpu_sample()
    if sample is None:
        return None
    if sample["apps"]:
        return sample["apps"]
    return _gpu_proc_mem()


# ---- machine totals + per-process CPU (stdlib ctypes on Windows, psutil elsewhere) -------------------------------

class _FT(ctypes.Structure):
    _fields_ = [("lo", ctypes.c_uint32), ("hi", ctypes.c_uint32)]


class _MEMSTATUS(ctypes.Structure):
    _fields_ = [("length", ctypes.c_uint32), ("load", ctypes.c_uint32), ("total", ctypes.c_uint64), ("avail", ctypes.c_uint64),
                ("tpage", ctypes.c_uint64), ("apage", ctypes.c_uint64), ("tvirt", ctypes.c_uint64), ("avirt", ctypes.c_uint64),
                ("ext", ctypes.c_uint64)]


def _ft(v: _FT) -> int:
    return (v.hi << 32) | v.lo


_cpu_prev: dict[str, Any] = {"sys": None, "proc": {}}
_cpu_lock = threading.Lock()


def _sys_cpu_pct() -> Optional[float]:
    """Whole-machine CPU load since the previous call (first call: None)."""
    with _cpu_lock:
        if os.name == "nt":
            try:
                idle, kern, user = _FT(), _FT(), _FT()
                if not ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kern), ctypes.byref(user)):
                    return None
                cur = (_ft(idle), _ft(kern) + _ft(user))
            except Exception:
                return None
            prev, _cpu_prev["sys"] = _cpu_prev["sys"], cur
            if not prev or cur[1] <= prev[1]:
                return None
            busy = (cur[1] - prev[1]) - (cur[0] - prev[0])
            return max(0.0, min(100.0, round(100.0 * busy / (cur[1] - prev[1]), 1)))
        if psutil is not None:
            try:
                return psutil.cpu_percent(interval=None)
            except Exception:
                return None
    return None


def _sys_mem() -> Optional[dict]:
    try:
        if os.name == "nt":
            m = _MEMSTATUS()
            m.length = ctypes.sizeof(_MEMSTATUS)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
                return None
            total, avail = m.total, m.avail
        elif psutil is not None:
            vm = psutil.virtual_memory()
            total, avail = vm.total, vm.available
        else:
            return None
        return {"ram_total_mb": round(total / 1048576), "ram_used_mb": round((total - avail) / 1048576)}
    except Exception:
        return None


def _proc_cpu_seconds(pid: int) -> Optional[float]:
    """Total CPU time (user+kernel) a process has used, in seconds."""
    if os.name == "nt":
        try:
            k = ctypes.windll.kernel32
            h = k.OpenProcess(0x1000, False, int(pid))           # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return None
            try:
                c, e, kern, user = _FT(), _FT(), _FT(), _FT()
                if not k.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(kern), ctypes.byref(user)):
                    return None
                return (_ft(kern) + _ft(user)) / 1e7
            finally:
                k.CloseHandle(h)
        except Exception:
            return None
    if psutil is not None:
        try:
            t = psutil.Process(pid).cpu_times()
            return t.user + t.system
        except Exception:
            return None
    return None


def _cpu_pct_tree(key: str, pids: list[int]) -> Optional[float]:
    """CPU use of a process tree as % of the whole machine, from the CPU-time delta since the previous sample."""
    total, seen = 0.0, 0
    for x in pids:
        v = _proc_cpu_seconds(x)
        if v is not None:
            total += v
            seen += 1
    if not seen:
        return None
    now = time.time()
    with _cpu_lock:
        prev = _cpu_prev["proc"].get(key)
        _cpu_prev["proc"][key] = (now, total, tuple(sorted(pids)))
    if not prev or now - prev[0] < 0.4 or prev[2] != tuple(sorted(pids)):
        return None
    return max(0.0, round(100.0 * (total - prev[1]) / (now - prev[0]) / (os.cpu_count() or 1), 1))


def system() -> dict:
    """This computer's totals: CPU, RAM, disk, GPU. Fields that cannot be read are simply absent."""
    out: dict[str, Any] = {"host": socket.gethostname()[:40]}
    cpu = _sys_cpu_pct()
    if cpu is not None:
        out["cpu_pct"] = cpu
    out["cpu_count"] = os.cpu_count()
    out.update(_sys_mem() or {})
    try:
        du = shutil.disk_usage(PROJECT_ROOT)
        out["disk_free_gb"], out["disk_total_gb"] = round(du.free / 1e9), round(du.total / 1e9)
    except OSError:
        pass
    sample = _gpu_sample()
    if sample and sample["gpus"]:
        out["gpus"] = sample["gpus"]
    return out


_hist: dict[str, deque] = {}
HIST_MAX = 90


def _record(key: str, cpu: Optional[float], mem_mb: Optional[float], vram_mb: Optional[float] = None) -> dict:
    h = _hist.setdefault(key, deque(maxlen=HIST_MAX))
    h.append((cpu or 0.0, mem_mb or 0.0, vram_mb or 0.0))
    return {"cpu": [round(x[0], 1) for x in h], "mem": [round(x[1]) for x in h], "vram": [round(x[2]) for x in h]}


def _attach_usage(out: dict, pid: int, info: dict) -> None:
    """Fill pid, memory, uptime, VRAM and CPU for a process tree onto a status card."""
    pids = info.get("pids") or [pid]
    out["pid"] = pid
    if info.get("rss_mb") is not None:
        out["rss_mb"] = info["rss_mb"]
    if info.get("started"):
        out["uptime_s"] = max(0, int(time.time() - info["started"]))
    gpu = _gpu()
    if gpu is not None:
        used = [gpu[x] for x in pids if x in gpu]
        if used:
            out["vram_mb"] = sum(used)
    cpu = _cpu_pct_tree(out["id"], pids)
    if cpu is not None:
        out["cpu_pct"] = cpu


def probe(d: Daemon) -> dict:
    out = _probe_core(d)
    info = idle_info(d, out.get("state", "down"))
    if info is not None:
        out["auto_stop"] = info
    return out


def _probe_core(d: Daemon) -> dict:
    """One daemon's live status card. States: ready | loading | down | foreign | error."""
    out: dict[str, Any] = {
        "id": d.id, "label": d.label, "description": d.description, "kind": d.kind, "port": d.port,
        "link_view": d.link_view, "observe_only": bool(d.observe_only or d.self_process), "self": bool(d.self_process),
        "can": {a: d.can(a) for a in ACTIONS}, "has_log": bool(d.log_path), "state": "down", "details": {},
    }
    if d.check is not None:
        try:
            res = d.check() or {}
        except Exception as exc:
            res = {"state": "error", "note": f"check failed: {exc}"[:160]}
        out["state"] = res.get("state", "error")
        for k in ("note", "rows"):
            if res.get(k):
                out[k] = res[k]
        out["details"] = dict(res.get("facts") or {})
        pid = res.get("pid")
        if pid:
            _attach_usage(out, int(pid), _proc_info(int(pid)))
        if pid or d.id in _hist:
            out["history"] = _record(d.id, out.get("cpu_pct"), out.get("rss_mb"), out.get("vram_mb"))
        return out
    if d.self_process:
        info = _proc_info(os.getpid())
        _attach_usage(out, os.getpid(), info)
        out.update(state="ready", uptime_s=int(time.time() - _boot_time))
        out["history"] = _record(d.id, out.get("cpu_pct"), out.get("rss_mb"), out.get("vram_mb"))
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
        _attach_usage(out, pid, info)
    if pid or d.id in _hist:
        out["history"] = _record(d.id, out.get("cpu_pct"), out.get("rss_mb"), out.get("vram_mb"))
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
    sysinfo = system()
    sysinfo["history"] = _record("__system__", sysinfo.get("cpu_pct"), sysinfo.get("ram_used_mb"),
                                 (sysinfo.get("gpus") or [{}])[0].get("vram_used_mb"))
    try:
        import hq_engine_fleet as fleet
        machines, fleet_on = fleet.machines_view(), fleet._root is not None
    except Exception:
        machines, fleet_on = [], False
    try:
        import hq_pistonia_store
        unseen, last_id = hq_pistonia_store.unseen_count(), hq_pistonia_store.last_message_id()
    except Exception:
        unseen, last_id = 0, None
    return {"ok": True, "now": time.time(), "daemons": daemons, "events": list(_events), "gpu": _gpu_sample() is not None,
            "system": sysinfo, "machines": machines, "fleet": fleet_on, "pistonia": {"unseen": unseen, "last": last_id},
            "summary": {"ready": sum(1 for c in daemons if c["state"] in HEALTHY_STATES),
                        "total": len(daemons), "problems": sum(1 for c in daemons if c["state"] in PROBLEM_STATES)}}


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
    _ps_cache["at"] = 0.0                      # never judge "still running?" from a 3 s old process list
    if d.check is not None:
        try:
            return (d.check() or {}).get("state") == "down"
        except Exception:
            return False
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
            touch(d.id)
        if action in ("stop", "restart"):
            _ready_since.pop(d.id, None)
        _event(d.id, action, ok, msg)
        card = probe(d)
        return (200 if ok else 500), {"ok": ok, "message": msg, "daemon": card, "events": list(_events)}
    finally:
        lock.release()


# ---- idle auto-stop ------------------------------------------------------------------------------------------------
# A daemon that supports it (``idle_stop``) can be stopped after N quiet minutes to free RAM/VRAM. It is OFF by default and
# chosen per daemon. "Quiet" = nobody called touch() for it: the voice engines call touch() on every request that needs the
# daemon (cache hits do not count), and Start/Restart from the tab count as use. Both voice engines restart themselves on the
# next request (that one line falls back to browser speech while the model loads), so stopping them is safe.
IDLE_MIN, IDLE_MAX = 3, 480
IDLE_CHOICES = (5, 10, 15, 30, 60, 120)
WATCH_EVERY = 30.0
ALERTS_EVERY = 60.0
_last_used: dict[str, float] = {}
_ready_since: dict[str, float] = {}
_policy: dict[str, dict] = {}
_policy_path: Optional[Path] = None
_policy_lock = threading.Lock()
_watcher: dict[str, Any] = {"thread": None, "stop": None}


def touch(daemon_id: str) -> None:
    """Record that ``daemon_id`` was just needed (cheap, never raises)."""
    _last_used[daemon_id] = time.time()


def _policy_load() -> None:
    _policy.clear()
    if _policy_path is None:
        return
    try:
        data = json.loads(_policy_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return
    for k, v in (data.items() if isinstance(data, dict) else []):
        if _ID_RE.match(str(k)) and isinstance(v, dict):
            m = v.get("idle_min")
            _policy[k] = {"enabled": v.get("enabled") is True,
                          "idle_min": m if isinstance(m, int) and not isinstance(m, bool) and IDLE_MIN <= m <= IDLE_MAX else None}


def _policy_save() -> None:
    if _policy_path is None:
        return
    try:
        _policy_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = _policy_path.with_name(_policy_path.name + ".partial")
        tmp.write_text(json.dumps(_policy), encoding="utf-8")
        os.replace(tmp, _policy_path)
    except OSError:
        pass


def get_policy(d: Daemon) -> dict:
    p = _policy.get(d.id) or {}
    return {"enabled": bool(p.get("enabled")), "idle_min": p.get("idle_min") or d.idle_default_min}


def set_policy(daemon_id: str, enabled: Any, idle_min: Any) -> tuple[int, dict]:
    d = get(daemon_id)
    if d is None:
        return 404, {"error": "unknown daemon", "code": "not_found"}
    if not d.idle_stop or d.observe_only or d.self_process:
        return 409, {"error": f"auto-stop is not available for {d.label}", "code": "not_supported"}
    if not isinstance(enabled, bool):
        return 400, {"error": "enabled must be true or false", "code": "validation_error"}
    if idle_min is None:
        idle_min = get_policy(d)["idle_min"]
    if isinstance(idle_min, bool) or not isinstance(idle_min, int) or not IDLE_MIN <= idle_min <= IDLE_MAX:
        return 400, {"error": f"idle_min must be a whole number of minutes ({IDLE_MIN}-{IDLE_MAX})", "code": "validation_error"}
    with _policy_lock:
        _policy[d.id] = {"enabled": enabled, "idle_min": idle_min}
        _policy_save()
    h = _health(d)
    ready = h is not None and bool(h.get("ready", h.get("_plain", False)))
    if enabled and ready:
        _ready_since.setdefault(d.id, time.time())
        touch(d.id)                                    # the quiet period starts now, not from an older call
    _event(d.id, "autostop_on" if enabled else "autostop_off", True, f"{idle_min} min" if enabled else "")
    return 200, {"ok": True, "auto_stop": idle_info(d, "ready" if ready else "down"), "events": list(_events)}


def idle_info(d: Daemon, state: str, now: Optional[float] = None) -> Optional[dict]:
    """The auto-stop block of a status card (None when the daemon does not support it)."""
    if not d.idle_stop or d.observe_only or d.self_process:
        return None
    now = time.time() if now is None else now
    pol = get_policy(d)
    info: dict[str, Any] = {"enabled": pol["enabled"], "idle_min": pol["idle_min"], "choices": list(IDLE_CHOICES)}
    if state == "ready":
        base = max(_last_used.get(d.id, 0.0), _ready_since.get(d.id, 0.0))
        if base:
            info["idle_for_s"] = max(0, int(now - base))
            if pol["enabled"]:
                info["stops_in_s"] = max(0, int(pol["idle_min"] * 60 - (now - base)))
    return info


def autostop_tick(now: Optional[float] = None) -> list[str]:
    """One watcher pass. Stops every enabled daemon that is ready and has been quiet long enough. Returns the ids stopped."""
    now = time.time() if now is None else now
    stopped: list[str] = []
    for d in all_daemons():
        if not d.idle_stop or d.observe_only or d.self_process or not d.can("stop"):
            continue
        h = _health(d)
        if h is None:
            _ready_since.pop(d.id, None)                   # down: the next time it comes up starts a fresh quiet period
            continue
        if not bool(h.get("ready", h.get("_plain", False))):
            continue                                       # loading or failing: never auto-stop what is not serving yet
        _ready_since.setdefault(d.id, now)
        pol = get_policy(d)
        if not pol["enabled"]:
            continue
        base = max(_last_used.get(d.id, 0.0), _ready_since[d.id])
        if now - base < pol["idle_min"] * 60:
            continue
        lock = _action_locks.setdefault(d.id, threading.Lock())
        if not lock.acquire(blocking=False):
            continue                                       # a manual action is running
        try:
            ok, msg = _do_stop(d)
            _event(d.id, "autostop", ok, (f"inactif depuis {pol['idle_min']} min" if ok else msg))
            if ok:
                _ready_since.pop(d.id, None)
                stopped.append(d.id)
        finally:
            lock.release()
    return stopped


def start_watcher() -> None:
    """Background pass every WATCH_EVERY seconds (idempotent). Started by the bridge via bind()."""
    t = _watcher.get("thread")
    if t is not None and t.is_alive():
        return
    stop = threading.Event()

    def loop() -> None:
        last_alerts = 0.0
        while not stop.wait(WATCH_EVERY):
            try:
                autostop_tick()
            except Exception:                              # the watcher must never die
                pass
            if time.time() - last_alerts >= ALERTS_EVERY:
                last_alerts = time.time()
                try:
                    import hq_pistonia
                    import hq_pistonia_alerts
                    hq_pistonia_alerts.tick(notify=hq_pistonia.notifier())
                except Exception:
                    pass

    th = threading.Thread(target=loop, daemon=True, name="engine-autostop")
    _watcher.update(thread=th, stop=stop)
    th.start()


def stop_watcher() -> None:
    ev = _watcher.get("stop")
    if ev is not None:
        ev.set()
    _watcher.update(thread=None, stop=None)


# ---- logs --------------------------------------------------------------------------------------------------------

def scrub(line: str) -> str:
    return _SECRET_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}[hidden]", line)


def tail_log(daemon_id: str, lines: int = 80) -> tuple[int, dict]:
    d = get(daemon_id)
    if d is None:
        return 404, {"error": "unknown daemon", "code": "not_found"}
    callable_log = callable(d.log_path)
    lp = d.log_path() if callable_log else d.log_path
    if not lp and callable_log:
        return 200, {"ok": True, "id": d.id, "lines": [], "size": 0, "note": "no log yet"}
    if not lp:
        return 404, {"error": "no log for this daemon", "code": "not_found"}
    lines = max(1, min(LOG_TAIL_MAX_LINES, int(lines)))
    p = Path(lp)
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
_MACHINE_RE = re.compile(r"^/api/engine/machines/(pc_[0-9a-f]{16})/(rename|remove)\Z")
_AUTOSTOP_RE = re.compile(r"^/api/engine/daemons/([a-z0-9][a-z0-9_-]{0,31})/autostop\Z")


def http_get(path: str, query: Optional[dict] = None) -> tuple[int, dict]:
    query = query or {}
    if path == "/api/engine/status":
        return 200, status()
    if path in ("/api/engine/pistonia/greeting", "/api/engine/pistonia/thread"):
        try:
            import hq_pistonia
            return 200, (hq_pistonia.greeting() if path.endswith("greeting") else hq_pistonia.thread_payload())
        except Exception:
            return 500, {"error": "Pistonia indisponible", "code": "error"}
    m = _LOGS_RE.match(path)
    if m:
        try:
            n = int((query.get("lines") or ["80"])[0])
        except (ValueError, TypeError, IndexError):
            n = 80
        return tail_log(m.group(1), n)
    return 404, {"error": "not found", "code": "not_found"}


def _pistonia_post(route: str, data: dict) -> tuple[int, dict]:
    import hq_pistonia
    try:
        if route == "message":
            return 200, hq_pistonia.message(data)
        if route == "clear":
            return 200, hq_pistonia.clear_thread()
        if route == "seen":
            return 200, hq_pistonia.mark_seen()
        if route == "resolve":
            return 200, hq_pistonia.resolve(data.get("id"))
        if route == "memory/delete":
            return hq_pistonia.forget_note(data.get("id"))
        if route == "settings":
            return hq_pistonia.save_settings(data)
        if route == "voice":
            return hq_pistonia.speak(data)
    except hq_pistonia.PistoniaError as exc:
        return exc.status, {"error": str(exc), "code": exc.code, "retryable": exc.retryable}
    except Exception:
        return 500, {"error": "Pistonia a rencontré une erreur.", "code": "error", "retryable": True}
    return 404, {"error": "not found", "code": "not_found"}


def http_post(path: str, data: Optional[dict] = None) -> tuple[int, dict]:
    m = _ACT_RE.match(path)
    if m:
        return act(m.group(1), m.group(2))
    if path.startswith("/api/engine/pistonia/"):
        return _pistonia_post(path[len("/api/engine/pistonia/"):], data or {})
    m = _AUTOSTOP_RE.match(path)
    if m:
        body = data or {}
        return set_policy(m.group(1), body.get("enabled"), body.get("idle_min"))
    try:
        import hq_engine_fleet as fleet
    except Exception:
        return 404, {"error": "not found", "code": "not_found"}
    if path == "/api/engine/machines/code":
        if fleet._root is None:
            return 503, {"error": "fleet unavailable", "code": "unavailable"}
        return 200, fleet.create_code()
    m = _MACHINE_RE.match(path)
    if m:
        if m.group(2) == "rename":
            return fleet.rename(m.group(1), (data or {}).get("name"))
        return fleet.remove(m.group(1))
    return 404, {"error": "not found", "code": "not_found"}


def redact_for_logs(payload: Any) -> dict:
    if isinstance(payload, dict):
        out = {"error": str(payload.get("error", ""))[:160], "code": payload.get("code", "error")}
        if payload.get("retryable"):
            out["retryable"] = True
        return out
    return {"error": "error", "code": "error"}


# ---- checks: Spotify, Google AI Studio, logins, music worker ------------------------------------------------------

def _cfg_file() -> dict:
    try:
        return json.loads((PROJECT_ROOT / "bridge_config.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def spotify_check() -> dict:
    """Is the Spotify desktop app open (a Connect device exists only then) and is HQ linked to the account?"""
    try:
        import hq_spotify as sp
        local = sp.local_spotify_probe()
        running = bool(local.get("spotify_desktop_running"))
        pids = [p for p in (local.get("spotify_pids") or []) if isinstance(p, int)]
        installed = bool(local.get("spotify_install_path"))
    except Exception:
        running, pids, installed = False, [], False
    link: dict = {}
    try:
        import hq_spotify as sp
        link = sp.status() or {}
    except Exception:
        link = {}
    facts = {"Application": "ouverte" if running else ("fermée" if installed else "introuvable")}
    if running:
        facts["Processus"] = len(pids)
    if link.get("connected"):
        facts["Compte"] = (link.get("display_name") or link.get("user_id") or "connecté")
        if link.get("product"):
            facts["Offre"] = link["product"]
    else:
        facts["Compte HQ"] = "non connecté" if link.get("configured", True) else "clés Spotify manquantes"
    state = "ready" if running else "down"
    note = ""
    if running and not link.get("connected"):
        state, note = "warn", "Spotify est ouvert mais HQ n'est pas relié au compte (onglet Musique)."
    elif not running:
        note = "Ouvre l'application Spotify : sans elle, HQ ne voit aucun appareil de lecture."
    elif link.get("product") == "free":
        note = "Offre gratuite : la commande de lecture depuis HQ est limitée."
    return {"state": state, "facts": facts, "note": note}


_gemini_cache: dict[str, Any] = {"at": 0.0, "value": None}
GEMINI_TTL = 60.0
GEMINI_PING_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"


def _gemini_ping(key: str) -> dict:
    """One cheap models-list call (not a generation: no quota burned). Cached for GEMINI_TTL seconds."""
    now = time.time()
    if _gemini_cache["value"] is not None and now - _gemini_cache["at"] < GEMINI_TTL:
        return _gemini_cache["value"]
    t0 = time.time()
    try:
        req = urllib.request.Request(GEMINI_PING_URL, headers={"x-goog-api-key": key})
        with urllib.request.urlopen(req, timeout=5) as r:
            res = {"code": r.status, "ms": round((time.time() - t0) * 1000)}
    except urllib.error.HTTPError as exc:
        res = {"code": exc.code, "ms": round((time.time() - t0) * 1000)}
    except Exception:
        res = {"code": 0, "ms": None}
    _gemini_cache.update(at=now, value=res)
    return res


def _gemini_keys() -> list[str]:
    try:
        import hq_ai
        keys = hq_ai._api_keys()
        if keys:
            return keys
    except Exception:
        pass
    cfg = _cfg_file()
    return [k for k in (str(cfg.get("gemini_api_key") or "").strip(), str(cfg.get("gemini_api_key_2") or "").strip()) if k]


def gemini_check() -> dict:
    keys = _gemini_keys()
    if not keys:
        return {"state": "down", "facts": {"Clés": 0}, "note": "Aucune clé Google AI Studio configurée (gemini_api_key)."}
    ping = _gemini_ping(keys[0])
    facts: dict[str, Any] = {"Clés": len(keys)}
    if ping.get("ms") is not None:
        facts["Latence"] = f"{ping['ms']} ms"
    try:
        import hq_ai
        used = sum(int(v) for v in (hq_ai.usage().get("count") or {}).values() if isinstance(v, (int, float)))
        facts["Requêtes aujourd'hui"] = used
    except Exception:
        pass
    code = ping.get("code")
    if code == 200:
        return {"state": "ready", "facts": facts}
    if code == 429:
        return {"state": "warn", "facts": facts, "note": "Google limite le débit (429) : quota atteint pour le moment."}
    if code in (400, 401, 403):
        return {"state": "error", "facts": facts, "note": f"Clé refusée par Google ({code}). Vérifie gemini_api_key."}
    if code == 0:
        return {"state": "warn", "facts": facts, "note": "Google AI Studio injoignable (réseau ?)."}
    return {"state": "warn", "facts": facts, "note": f"Réponse inattendue de Google ({code})."}


def _hf_token_present() -> bool:
    if os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"):
        return True
    homes = [Path(os.environ["HF_HOME"])] if os.environ.get("HF_HOME") else []
    homes += [Path.home() / ".cache" / "huggingface", Path.home() / ".huggingface"]
    for h in homes:
        try:
            if (h / "token").is_file() and (h / "token").stat().st_size > 0:
                return True
        except OSError:
            pass
    return False


def logins_check() -> dict:
    """Which external accounts/keys HQ can use right now. Presence only: no secret is read out or shown."""
    rows = []
    try:
        import hq_spotify as sp
        st = sp.status() or {}
        if st.get("connected"):
            rows.append({"label": "Spotify", "state": "ok", "text": f"connecté ({st.get('display_name') or st.get('user_id') or 'compte'})"})
        elif st.get("configured", False):
            rows.append({"label": "Spotify", "state": "warn", "text": "clés présentes, compte non connecté"})
        else:
            rows.append({"label": "Spotify", "state": "bad", "text": "client_id / redirect manquants"})
    except Exception:
        rows.append({"label": "Spotify", "state": "off", "text": "indisponible"})
    keys = _gemini_keys()
    rows.append({"label": "Google AI Studio", "state": "ok" if keys else "bad",
                 "text": (f"{len(keys)} clé(s) configurée(s)" if keys else "aucune clé")})
    hf = _hf_token_present()
    rows.append({"label": "Hugging Face", "state": "ok" if hf else "warn",
                 "text": "jeton présent (voix Phonon)" if hf else "pas de jeton : le modèle Phonon peut refuser de charger"})
    cfg = _cfg_file()
    rows.append({"label": "Discord", "state": "ok" if cfg.get("discord_webhook_url") else "off",
                 "text": "webhook configuré" if cfg.get("discord_webhook_url") else "non configuré (facultatif)"})
    rows.append({"label": "Code PIN HQ", "state": "ok" if cfg.get("pin") else "bad",
                 "text": "défini" if cfg.get("pin") else "aucun PIN défini"})
    bad = sum(1 for r in rows if r["state"] == "bad")
    warn = sum(1 for r in rows if r["state"] == "warn")
    state = "error" if bad else ("warn" if warn else "ready")
    return {"state": state, "rows": rows}


ACE_DIR = PROJECT_ROOT / "ACE-Step-1.5"
WORKER_SCRIPT = PROJECT_ROOT / "hq_music_studio_worker.py"
STUDIO_DIR = PROJECT_ROOT / ".hq-music" / "studio"


def _worker_settings() -> dict:
    """The generation settings, read from the worker script itself so this card can never disagree with what runs."""
    try:
        src = WORKER_SCRIPT.read_text(encoding="utf-8")
    except OSError:
        return {}

    def grab(pat: str) -> Optional[str]:
        m = re.search(pat, src)
        return m.group(1) if m else None

    dit = grab(r"config_path='([^']+)'")
    quant = grab(r"quantization='([^']+)'")
    lm = grab(r"lm_model_path='([^']+)'")
    backend = grab(r"backend='([^']+)'")
    device = grab(r"device='([^']+)'")
    steps = grab(r"inference_steps=(\d+)")
    batch = grab(r"batch_size=(\d+)")
    off_cpu = "offload_to_cpu=True" in src
    off_dit = "offload_dit_to_cpu=True" in src
    facts: dict[str, Any] = {}
    if dit:
        facts["DiT"] = dit + (" · INT8" if quant and "int8" in quant else (f" · {quant}" if quant else ""))
    if lm:
        facts["LM"] = lm + (f" · backend {'PyTorch' if backend == 'pt' else backend}" if backend else "")
    if device:
        facts["Appareil"] = device.upper()
    if steps:
        facts["Étapes"] = int(steps)
    if batch:
        facts["Lot"] = int(batch)
    if off_cpu or off_dit:
        facts["Décharge"] = " + ".join(x for x, on in (("CPU", off_cpu), ("DiT", off_dit)) if on)
    return facts


def _latest_job() -> Optional[Path]:
    try:
        jobs = [p for p in STUDIO_DIR.iterdir() if p.is_dir() and not p.is_symlink() and (p / "job.json").is_file()]
        return max(jobs, key=lambda p: (p / "job.json").stat().st_mtime) if jobs else None
    except OSError:
        return None


def _latest_worker_log() -> Optional[Path]:
    job = _latest_job()
    return (job / "worker.log") if job and (job / "worker.log").is_file() else None


def music_check() -> dict:
    """Is the ACE-Step worker (spawned per job in its own venv) running right now, and with which settings."""
    facts = _worker_settings()
    if not (ACE_DIR / ".venv" / "Scripts" / "python.exe").is_file():
        return {"state": "error", "facts": facts, "note": "Environnement ACE-Step introuvable (ACE-Step-1.5/.venv)."}
    pid = _find_by_hint("hq_music_studio_worker")
    job = _latest_job()
    if job is not None:
        try:
            result = json.loads((job / "result.json").read_text(encoding="utf-8")) if (job / "result.json").is_file() else None
        except (OSError, ValueError):
            result = None
        last = (result or {}).get("status") or ("en cours" if pid else "interrompue")
        facts["Dernière création"] = {"completed": "terminée", "failed": "échec"}.get(last, last)
        if isinstance(result, dict) and result.get("elapsed_seconds"):
            facts["Durée de calcul"] = f"{round(float(result['elapsed_seconds']))} s"
    if pid:
        return {"state": "busy", "facts": facts, "pid": pid, "note": "Génération en cours : le GPU est occupé."}
    return {"state": "idle", "facts": facts, "note": "Le worker se lance à la demande pour chaque création (rien ne reste en mémoire)."}


# ---- default registry --------------------------------------------------------------------------------------------

def bind(root: Any, notify: Any = None) -> None:
    """Called once by the bridge: pairing of other computers, Pistonia's state (all under <root>/.hq-engine) and, optionally, HQ's
    notifier (Discord / web push) that Pistonia uses for alerts only when the Master switched notifications on."""
    global _policy_path
    import hq_engine_fleet
    import hq_pistonia
    import hq_pistonia_store
    hq_engine_fleet.bind(root)
    hq_pistonia_store.bind(root)
    hq_pistonia.bind(notify)
    _policy_path = Path(root) / ".hq-engine" / "autostop.json"
    _policy_load()
    start_watcher()


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
                        idle_stop=True, idle_default_min=30,
                        description="Voix sur processeur de Transferina, Inventoria et Musica (anglais)."))
    except Exception:
        pass
    try:
        import hq_voice as xt

        def xt_details(h: dict) -> dict:
            return {"load_sec": h.get("load_sec")} if h.get("load_sec") is not None else {}

        register(Daemon(id="xtts", label="Coqui XTTS", kind="voice", port=xt.XTTS_DAEMON_PORT, health_path="/health",
                        process_hint="coqui_xtts_daemon", log_path=xt.DAEMON_LOG, details=xt_details,
                        start=lambda: xt.start_daemon(wait_sec=0.0), idle_stop=True, idle_default_min=15,
                        description="Voix d'Else sur carte graphique (français/anglais). Garde le modèle chaud en VRAM."))
    except Exception:
        pass
    def spotify_start():
        import hq_spotify as sp
        return sp.wake_local_spotify(wait_s=0.0)

    register(Daemon(id="spotify", label="Spotify", kind="apps", check=spotify_check, start=spotify_start,
                    description="L'application Spotify doit être ouverte pour que HQ ait un appareil de lecture."))
    register(Daemon(id="gemini", label="Google AI Studio", kind="apps", check=gemini_check,
                    description="Gemini : les réponses des compagnons et d'Inventoria passent par cette API."))
    register(Daemon(id="logins", label="Connexions", kind="apps", check=logins_check,
                    description="Comptes et clés dont HQ dépend (présence uniquement, jamais affichés)."))
    register(Daemon(id="music", label="Génération musicale (ACE-Step)", kind="music", check=music_check,
                    log_path=_latest_worker_log, observe_only=True, link_view="musique",
                    description="HQ lance un worker dans l'environnement ACE-Step dédié, une création à la fois."))
    register(Daemon(id="forge", label="Forge (image backend)", kind="image", port=7860, health_path="/",
                    observe_only=True, link_view="forge",
                    description="Moteur de génération d'images, piloté depuis l'onglet Forge Studio."))


register_defaults()
