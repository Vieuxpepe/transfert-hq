"""Transfert HQ Forge generation worker. Python standard library only.

Run on a generation PC that has Stable Diffusion WebUI Forge started with
``--api`` on 127.0.0.1. The worker:

* talks to its own Forge at http://127.0.0.1:<port> only (fixed host);
* polls HQ outbound (HTTPS over Tailscale; plain HTTP is accepted only for a
  loopback HQ with ``--dev``); HQ never dials the worker;
* signs every request with HMAC-SHA256 over
  ``hq-forge-worker-v1|METHOD|path|timestamp|nonce|sha256(body)``;
* reports real hardware only (unknown stays unknown);
* runs one txt2img task at a time and uploads the PNG.

It runs no commands from HQ, reads no files besides its credential file, and
never calls Forge's /interrupt.

Pair once (the one-time code is read from stdin, never argv)::

    py -3 hq_forge_worker.py pair --hq https://<hq>.ts.net --name "PC salon"

Then run::

    py -3 hq_forge_worker.py run
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import hmac
import json
import os
import platform
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

VERSION = 2  # 2: checkpoint sha256 and VAE/modules in the report (fleet parity)
SCHEME = "hq-forge-worker-v1"
PREFIX = "/forge-worker/v1"
HEADER_WORKER = "X-HQ-Worker"
HEADER_TIME = "X-HQ-Time"
HEADER_NONCE = "X-HQ-Nonce"
HEADER_SIGNATURE = "X-HQ-Signature"

FORGE_HOST = "127.0.0.1"
DEFAULT_FORGE_PORT = 7860
HQ_TIMEOUT_SEC = 20.0
FORGE_PROBE_TIMEOUT_SEC = 4.0
FORGE_JOB_TIMEOUT_SEC = 600.0
MAX_HQ_RESPONSE = 256 * 1024
MAX_FORGE_PROBE = 1024 * 1024
MAX_FORGE_RESULT = 48 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_LIST = 64
POLL_SEC = 3.0
PROGRESS_SEC = 2.0
IDLE_MAX_SEC = 10.0
BACKOFF_MAX_SEC = 60.0
CATALOG_TTL_SEC = 60.0
UPLOAD_RETRIES = 3
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
FORGE_ROUTES = frozenset({
    "/sdapi/v1/samplers", "/sdapi/v1/schedulers", "/sdapi/v1/sd-models", "/sdapi/v1/upscalers",
    "/sdapi/v1/options", "/sdapi/v1/progress", "/internal/pending-tasks",
})
SUBMIT_PATH = "/sdapi/v1/txt2img"
SETTING_KEYS = (
    "prompt", "negative_prompt", "checkpoint", "sampler_name", "scheduler", "width", "height", "steps",
    "cfg_scale", "seed", "enable_hr", "hr_scale", "hr_upscaler", "hr_second_pass_steps", "denoising_strength",
)
ACL_SIDS = ("S-1-5-18", "S-1-5-32-544")


# ---------------------------------------------------------------- signing

def body_hash(body: bytes) -> str:
    return hashlib.sha256(body or b"").hexdigest()


def canonical(method: str, path: str, timestamp: int, nonce: str, body: bytes) -> bytes:
    return "|".join([SCHEME, (method or "").upper(), path or "", str(int(timestamp)), nonce or "", body_hash(body)]).encode("utf-8")


def sign(secret: str, method: str, path: str, timestamp: int, nonce: str, body: bytes) -> str:
    return hmac.new((secret or "").encode("utf-8"), canonical(method, path, timestamp, nonce, body), hashlib.sha256).hexdigest()


def signed_headers(worker_id: str, secret: str, method: str, path: str, body: bytes, *, now: float | None = None) -> dict:
    stamp = int(time.time() if now is None else now)
    nonce = secrets.token_urlsafe(18)
    return {
        HEADER_WORKER: worker_id,
        HEADER_TIME: str(stamp),
        HEADER_NONCE: nonce,
        HEADER_SIGNATURE: sign(secret, method, path, stamp, nonce, body),
    }


def validate_hq_url(url: str, *, dev: bool) -> str:
    parsed = urllib.parse.urlsplit((url or "").strip())
    host = (parsed.hostname or "").lower()
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("Adresse HQ invalide.")
    if parsed.scheme == "https" and host:
        return f"https://{parsed.netloc}"
    if dev and parsed.scheme == "http" and host in ("127.0.0.1", "localhost"):
        return f"http://{parsed.netloc}"
    raise ValueError("HQ doit être joint en HTTPS (Tailscale). HTTP n'est accepté qu'en local avec --dev.")


# ---------------------------------------------------------------- hardware

def _run(args: list[str], timeout: float = 8.0) -> str | None:
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        result = subprocess.run(args, capture_output=True, timeout=timeout, check=False, creationflags=flags)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    if result.returncode != 0:
        return None
    try:
        return result.stdout.decode("utf-8", "replace")[:16384]
    except Exception:
        return None


def _clip(value, limit: int = 120) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    return text[:limit] or None


def _nvidia() -> list[dict]:
    out = _run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
    gpus = []
    for line in (out or "").splitlines()[:8]:
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 2 or not parts[0]:
            continue
        try:
            vram = int(float(parts[1]))
        except ValueError:
            vram = None
        gpus.append({"name": _clip(parts[0]), "vram_mb": vram if vram and 0 < vram < 1_048_576 else None, "source": "nvidia-smi"})
    return gpus


def _cim_gpus() -> list[dict]:
    if os.name != "nt":
        return []
    out = _run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"])
    # AdapterRAM is a 32-bit field and is wrong above 4 GB, so VRAM stays unknown here.
    return [{"name": _clip(line), "vram_mb": None, "source": "cim"} for line in (out or "").splitlines()[:8] if line.strip()]


def _cpu_name() -> str | None:
    if os.name == "nt":
        out = _run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                    "(Get-CimInstance Win32_Processor | Select-Object -First 1).Name"])
        name = _clip(out or "")
        if name:
            return name
    if sys.platform.startswith("linux"):
        try:
            for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="replace").splitlines():
                if line.startswith("model name"):
                    return _clip(line.split(":", 1)[1])
        except OSError:
            pass
    return _clip(platform.processor() or "")


def _ram_mb() -> int | None:
    if os.name == "nt":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]
        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(MemoryStatus)
        try:
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return int(status.ullTotalPhys // (1024 * 1024))
        except (AttributeError, OSError):
            return None
        return None
    try:
        pages = os.sysconf("SC_PHYS_PAGES")
        size = os.sysconf("SC_PAGE_SIZE")
        return int(pages * size // (1024 * 1024))
    except (ValueError, OSError, AttributeError):
        return None


def detect_hardware() -> dict:
    """Real values or None. Nothing is guessed."""
    gpus = _nvidia() or _cim_gpus()
    return {
        "gpus": gpus,
        "cpu": _cpu_name(),
        "ram_mb": _ram_mb(),
        "os": _clip(f"{platform.system()} {platform.release()}", 60),
        "hostname": _clip(platform.node(), 60),
    }


# ---------------------------------------------------------------- protected credential file

def current_user_sid() -> str | None:
    if os.name != "nt":
        return None
    out = _run(["whoami", "/user", "/fo", "csv", "/nh"])
    if not out:
        return None
    parts = [part.strip().strip('"') for part in out.strip().split(",")]
    sid = parts[-1] if parts else ""
    return sid if sid.startswith("S-1-") and all(ch.isalnum() or ch == "-" for ch in sid) else None


def protect_path(path: Path) -> str:
    """Protected DACL: SYSTEM, Administrators, current user. Inheritance removed."""
    if os.name != "nt":
        try:
            os.chmod(path, 0o600)
        except OSError:
            return "unverified"
        return "posix-0600"
    sid = current_user_sid()
    if not sid:
        return "unverified"
    grants = []
    for item in (*ACL_SIDS, sid):
        grants += ["/grant:r", f"*{item}:(F)"]
    out = _run(["icacls", str(path), "/inheritance:r", *grants], timeout=15)
    return "restricted" if out is not None else "unverified"


def default_credential_path() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "TransfertHQ" / "forge-worker.json"


def save_credentials(path: Path, data: dict) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".partial")
    payload = json.dumps(data).encode("utf-8")
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    state = protect_path(temporary)
    os.replace(temporary, path)
    return state


def load_credentials(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not all(isinstance(data.get(key), str) for key in ("hq", "worker_id", "secret")):
        raise ValueError("Fichier d'identification invalide.")
    return data


# ---------------------------------------------------------------- transports

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect, urllib.request.ProxyHandler({}))


def http_transport(method: str, url: str, timeout: float, body: bytes | None, headers: dict, max_bytes: int) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            raw = response.read(max_bytes + 1)
            status = response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read(max_bytes + 1)
        status = exc.code
    if len(raw) > max_bytes:
        raise OSError("response too large")
    return status, raw


class ForgeLocal:
    """The only Forge this worker talks to: 127.0.0.1:<port>, allowlisted routes."""

    def __init__(self, port: int = DEFAULT_FORGE_PORT, transport=None) -> None:
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("port")
        self.origin = f"http://{FORGE_HOST}:{port}"
        self.transport = transport or http_transport
        self._catalog = None
        self._catalog_at = 0.0

    def _get(self, path: str, query: str = ""):
        if path not in FORGE_ROUTES:
            raise ValueError("route")
        status, raw = self.transport("GET", self.origin + path + query, FORGE_PROBE_TIMEOUT_SEC, None, {"Accept": "application/json"}, MAX_FORGE_PROBE)
        if status != 200:
            raise OSError(f"http {status}")
        return json.loads(raw.decode("utf-8"))

    def probe(self) -> dict:
        try:
            options = self._get("/sdapi/v1/options")
            progress = self._get("/sdapi/v1/progress", "?skip_current_image=true")
        except (OSError, ValueError, TimeoutError):
            return {"state": "offline", "model": None}
        model = options.get("sd_model_checkpoint") if isinstance(options, dict) else None
        state = progress.get("state") if isinstance(progress, dict) else None
        busy = isinstance(state, dict) and (bool(state.get("job")) or (isinstance(state.get("job_count"), int) and state["job_count"] > 0))
        return {"state": "busy" if busy else "ready", "model": _clip(model, 200) if isinstance(model, str) else None,
                "vae": vae_names(options)}

    def catalog(self, *, force: bool = False) -> dict | None:
        if not force and self._catalog is not None and time.monotonic() - self._catalog_at < CATALOG_TTL_SEC:
            return self._catalog
        try:
            models = self._get("/sdapi/v1/sd-models")
            samplers = self._get("/sdapi/v1/samplers")
            schedulers = self._get("/sdapi/v1/schedulers")
        except (OSError, ValueError, TimeoutError):
            return None
        try:
            upscalers = self._get("/sdapi/v1/upscalers")
        except (OSError, ValueError, TimeoutError):
            upscalers = []

        def names(rows, key):
            out = []
            for row in rows if isinstance(rows, list) else []:
                value = row.get(key) if isinstance(row, dict) else None
                if isinstance(value, str) and value and len(value) <= 200 and value not in out:
                    out.append(value)
            return out[:MAX_LIST]

        self._catalog = {
            "hashes": model_hashes(models),
            "models": names(models, "title"),
            "samplers": names(samplers, "name"),
            "schedulers": names(schedulers, "name"),
            "upscalers": names(upscalers, "name"),
        }
        self._catalog_at = time.monotonic()
        return self._catalog

    def progress(self) -> dict | None:
        try:
            value = self._get("/sdapi/v1/progress", "?skip_current_image=true")
        except (OSError, ValueError, TimeoutError):
            return None
        if not isinstance(value, dict):
            return None
        state = value.get("state") if isinstance(value.get("state"), dict) else {}
        fraction = value.get("progress")
        if isinstance(fraction, bool) or not isinstance(fraction, (int, float)):
            fraction = 0.0
        step = state.get("sampling_step") if isinstance(state.get("sampling_step"), int) else 0
        steps = state.get("sampling_steps") if isinstance(state.get("sampling_steps"), int) else 0
        return {"progress": max(0.0, min(1.0, float(fraction))), "step": max(0, step), "steps": max(0, steps)}

    def txt2img(self, body: dict) -> dict:
        raw_body = json.dumps(body, separators=(",", ":")).encode("utf-8")
        status, raw = self.transport("POST", self.origin + SUBMIT_PATH, FORGE_JOB_TIMEOUT_SEC, raw_body,
                                     {"Accept": "application/json", "Content-Type": "application/json"}, MAX_FORGE_RESULT)
        if status != 200:
            raise OSError(f"forge_http_{status}")
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("forge_schema")
        return parsed


def vae_names(options) -> list[str] | None:
    """VAE / extra modules in effect, as sorted file names (never full paths). None when unreadable."""
    if not isinstance(options, dict):
        return None
    out = []
    extra = options.get("forge_additional_modules")
    values = list(extra) if isinstance(extra, list) else []
    vae = options.get("sd_vae")
    if isinstance(vae, str) and vae not in ("", "Automatic", "None"):
        values.append(vae)
    for value in values:
        if not isinstance(value, str) or not value:
            continue
        name = value.replace("\\", "/").rsplit("/", 1)[-1][:120]
        if name and not any(ord(ch) < 32 for ch in name) and name not in out:
            out.append(name)
    return sorted(out)[:16]


def model_hashes(rows) -> dict:
    """title -> sha256 (lower-case hex) or None while Forge has not hashed the file yet."""
    out = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        title, sha = row.get("title"), row.get("sha256")
        if not isinstance(title, str) or not title or len(title) > 200:
            continue
        ok = isinstance(sha, str) and len(sha) == 64 and all(ch in "0123456789abcdefABCDEF" for ch in sha)
        out[title] = sha.lower() if ok else None
        if len(out) >= MAX_LIST:
            break
    return out


def submission_body(settings: dict, task_id: str) -> dict:
    """Same txt2img shape HQ uses for the local Forge. One image per task."""
    body = {
        "prompt": settings["prompt"],
        "negative_prompt": settings.get("negative_prompt") or "",
        "seed": settings["seed"],
        "sampler_name": settings["sampler_name"],
        "scheduler": settings.get("scheduler") or "automatic",
        "steps": settings["steps"],
        "cfg_scale": settings["cfg_scale"],
        "width": settings["width"],
        "height": settings["height"],
        "batch_size": 1,
        "n_iter": 1,
        "save_images": False,
        "send_images": True,
        "script_name": "",
        "script_args": [],
        "alwayson_scripts": {},
        "force_task_id": f"task(hq-{task_id[3:]})",
        "override_settings": {"sd_model_checkpoint": settings["checkpoint"]},
        "override_settings_restore_afterwards": True,
    }
    if settings.get("enable_hr"):
        body.update({
            "enable_hr": True,
            "hr_scale": settings["hr_scale"],
            "hr_upscaler": settings["hr_upscaler"],
            "hr_second_pass_steps": settings["hr_second_pass_steps"],
            "denoising_strength": settings["denoising_strength"],
            "hr_resize_x": 0,
            "hr_resize_y": 0,
        })
    return body


def _clean_settings(raw) -> dict | None:
    if not isinstance(raw, dict) or set(raw) - set(SETTING_KEYS):
        return None
    needed = ("prompt", "checkpoint", "sampler_name", "width", "height", "steps", "cfg_scale", "seed")
    if any(key not in raw for key in needed):
        return None
    for key in ("width", "height", "steps", "seed"):
        if isinstance(raw[key], bool) or not isinstance(raw[key], int):
            return None
    if not 64 <= raw["width"] <= 2048 or not 64 <= raw["height"] <= 2048 or not 1 <= raw["steps"] <= 150 or not 0 <= raw["seed"] < 2**32:
        return None
    if not isinstance(raw["prompt"], str) or len(raw["prompt"]) > 4000:
        return None
    return dict(raw)


# ---------------------------------------------------------------- HQ client

class HQError(Exception):
    def __init__(self, status: int, payload: dict | None = None) -> None:
        self.status = status
        self.payload = payload or {}
        super().__init__(f"HQ {status}")


class HQClient:
    def __init__(self, base: str, worker_id: str = "", secret: str = "", *, transport=None) -> None:
        self.base = base.rstrip("/")
        self.worker_id = worker_id
        self.secret = secret
        self.transport = transport or http_transport

    def call(self, route: str, payload: dict, *, signed: bool = True, max_body: int = 64 * 1024) -> dict:
        path = PREFIX + route
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        if len(body) > max_body:
            raise ValueError("payload too large")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if signed:
            headers.update(signed_headers(self.worker_id, self.secret, "POST", path, body))
        status, raw = self.transport("POST", self.base + path, HQ_TIMEOUT_SEC, body, headers, MAX_HQ_RESPONSE)
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeError, json.JSONDecodeError):
            data = {}
        if status != 200:
            raise HQError(status, data if isinstance(data, dict) else {})
        return data if isinstance(data, dict) else {}


def pair(hq: str, code: str, name: str, *, dev: bool = False, transport=None, hardware: dict | None = None) -> dict:
    base = validate_hq_url(hq, dev=dev)
    client = HQClient(base, transport=transport)
    result = client.call("/enroll", {"code": code.strip(), "name": name[:40], "hardware": hardware if hardware is not None else detect_hardware(), "version": VERSION}, signed=False)
    if not isinstance(result.get("worker_id"), str) or not isinstance(result.get("secret"), str):
        raise HQError(500)
    return {"hq": base, "worker_id": result["worker_id"], "secret": result["secret"], "dev": bool(dev)}


# ---------------------------------------------------------------- worker loop

class Worker:
    def __init__(self, hq: HQClient, forge: ForgeLocal, *, hardware: dict | None = None, log=None) -> None:
        self.hq = hq
        self.forge = forge
        self.hardware = hardware if hardware is not None else detect_hardware()
        self.log = log or (lambda message: None)
        self.current: dict | None = None
        self.last_error = ""
        # Latest HQ-unreachable spell seen by this PC (network/Tailscale), reported once HQ answers again.
        self.net_report: dict | None = None
        self._hq_down_since: float | None = None
        self._lock = threading.Lock()
        self.stop = threading.Event()

    def _report(self) -> dict:
        forge = self.forge.probe()
        catalog = self.forge.catalog() if forge["state"] != "offline" else None
        with self._lock:
            current = dict(self.current) if self.current else None
        return {
            "version": VERSION,
            "hardware": self.hardware,
            "forge": {**forge, "catalog": catalog},
            "current_task": current["task_id"] if current else None,
            "last_error": self.last_error[:120],
            **({"net": dict(self.net_report)} if self.net_report else {}),
        }

    def poll_once(self) -> dict | None:
        """One heartbeat. Returns the task HQ handed over, if any."""
        reply = self.hq.call("/poll", self._report())
        task = reply.get("task")
        if not isinstance(task, dict):
            return None
        return task

    def _progress_loop(self, task_id: str, done: threading.Event) -> None:
        while not done.wait(PROGRESS_SEC):
            value = self.forge.progress()
            if value is None:
                continue
            try:
                self.hq.call("/progress", {"task_id": task_id, **value})
            except (HQError, OSError, ValueError, TimeoutError):
                continue

    def run_task(self, task: dict) -> str:
        task_id = task.get("task_id")
        settings = _clean_settings(task.get("settings"))
        if not isinstance(task_id, str) or not task_id.startswith("tk-") or len(task_id) > 40 or settings is None:
            return "rejected"
        with self._lock:
            self.current = {"task_id": task_id}
        done = threading.Event()
        threading.Thread(target=self._progress_loop, args=(task_id, done), daemon=True).start()
        try:
            catalog = self.forge.catalog(force=True) or {}
            if settings["checkpoint"] not in (catalog.get("models") or []):
                return self._fail(task_id, "model_missing")
            wanted = task.get("checkpoint_sha256")
            if isinstance(wanted, str) and (catalog.get("hashes") or {}).get(settings["checkpoint"]) != wanted:
                return self._fail(task_id, "model_mismatch")
            try:
                parsed = self.forge.txt2img(submission_body(settings, task_id))
            except TimeoutError:
                return self._fail(task_id, "forge_timeout")
            except (OSError, ValueError):
                return self._fail(task_id, "forge_error")
            images = parsed.get("images")
            if not isinstance(images, list) or not images or not isinstance(images[0], str):
                return self._fail(task_id, "bad_image")
            try:
                raw = base64.b64decode(images[0], validate=True)
            except (ValueError, TypeError):
                return self._fail(task_id, "bad_image")
            if not raw.startswith(PNG_MAGIC) or len(raw) > MAX_IMAGE_BYTES:
                return self._fail(task_id, "bad_image")
            payload = {"task_id": task_id, "image_b64": base64.b64encode(raw).decode("ascii")}
            for attempt in range(UPLOAD_RETRIES):
                try:
                    self.hq.call("/result", payload, max_body=MAX_IMAGE_BYTES * 2)
                    self.last_error = ""
                    return "completed"
                except HQError as exc:
                    if exc.status < 500:
                        self.last_error = str(exc.payload.get("code") or exc.status)
                        return "refused"
                except (OSError, TimeoutError):
                    pass
                if self.stop.wait(min(10.0, 2.0 * (attempt + 1))):
                    break
            self.last_error = "upload"
            return "upload_failed"
        finally:
            done.set()
            with self._lock:
                self.current = None

    def _fail(self, task_id: str, code: str) -> str:
        self.last_error = code
        try:
            self.hq.call("/fail", {"task_id": task_id, "code": code})
        except (HQError, OSError, ValueError, TimeoutError):
            pass
        return code

    def run_forever(self) -> None:
        errors = 0
        idle = 0
        while not self.stop.is_set():
            try:
                task = self.poll_once()
                errors = 0
                if self._hq_down_since is not None:
                    self.net_report = {"code": "hq_unreachable", "since": int(self._hq_down_since), "until": int(time.time())}
                    self._hq_down_since = None
            except HQError as exc:
                if exc.status in (401, 403):
                    self.log("HQ refuse cet appareil (révoqué ou désactivé).")
                errors += 1
                task = None
            except (OSError, TimeoutError):
                errors += 1
                task = None
                if self._hq_down_since is None:
                    self._hq_down_since = time.time()
            except ValueError:
                errors += 1
                task = None
            if task is not None:
                idle = 0
                self.run_task(task)
                continue
            idle += 1
            delay = min(BACKOFF_MAX_SEC, POLL_SEC * (2 ** min(errors, 5))) if errors else min(IDLE_MAX_SEC, POLL_SEC + idle // 5)
            self.stop.wait(delay)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Transfert HQ Forge worker", allow_abbrev=False)
    sub = parser.add_subparsers(dest="command", required=True)
    pair_cmd = sub.add_parser("pair", help="Pair with HQ. The one-time code is read from stdin.", allow_abbrev=False)
    pair_cmd.add_argument("--hq", required=True)
    pair_cmd.add_argument("--name", default=platform.node()[:40] or "PC")
    pair_cmd.add_argument("--credentials", type=Path, default=default_credential_path())
    pair_cmd.add_argument("--code-file", type=Path, help="Read the code from this protected file instead of stdin.")
    pair_cmd.add_argument("--dev", action="store_true", help="Allow HTTP to a loopback HQ (tests only).")
    run_cmd = sub.add_parser("run", help="Poll HQ and generate.", allow_abbrev=False)
    run_cmd.add_argument("--credentials", type=Path, default=default_credential_path())
    run_cmd.add_argument("--forge-port", type=int, default=DEFAULT_FORGE_PORT)
    args = parser.parse_args(argv)
    if args.command == "pair":
        if args.code_file:
            code = args.code_file.read_text(encoding="utf-8").strip()
        else:
            if sys.stdin.isatty():
                import getpass
                code = getpass.getpass("Code d'appairage : ")
            else:
                code = sys.stdin.readline()
        try:
            creds = pair(args.hq, code, args.name, dev=args.dev)
        except (HQError, ValueError, OSError) as exc:
            print(f"Appairage refusé : {getattr(exc, 'payload', {}).get('error') or exc.__class__.__name__}", file=sys.stderr)
            return 2
        state = save_credentials(args.credentials, creds)
        print(f"Appareil appairé ({creds['worker_id']}). Identifiants : {args.credentials} (accès : {state}).")
        return 0
    creds = load_credentials(args.credentials)
    validate_hq_url(creds["hq"], dev=bool(creds.get("dev")))
    worker = Worker(HQClient(creds["hq"], creds["worker_id"], creds["secret"]), ForgeLocal(args.forge_port), log=lambda m: print(m, file=sys.stderr))
    print(f"Worker {creds['worker_id']} actif. Forge : 127.0.0.1:{args.forge_port}.", file=sys.stderr)
    try:
        worker.run_forever()
    except KeyboardInterrupt:
        worker.stop.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
