"""Phase 15 — local, read-mostly production diagnostics for the Transfert HQ bridge.

Design rules (see the Phase 15 contracts in the review package):

* Local only: stdlib, no network, no subprocess, no Git invocation. The running build SHA is read ONCE at startup from the
  checkout's ``.git`` files (or ``HQ_BUILD_SHA``); an unknown SHA is reported as ``unknown``, never fabricated.
* The application never depends on this module to serve a request: every public function either returns data or a typed
  error; callers wrap it so a diagnostics bug can never take a Carnet route down.
* Liveness and readiness never write. Writing is a separate, explicit, admin-triggered probe confined to
  ``<root>/.hq-carnet/diagnostics/`` with generated names (no caller-supplied path).
* Output never carries secrets: no config values, no session data, no request bodies, no query strings, no record content.
  Filesystem paths are reduced to a root *name* or scrubbed placeholders. Stack traces are kept as ``file.py:line in func``
  frames only (no locals, no source) and are served to admins only.
* Bounded: the in-memory error ring holds at most ``RING_MAX`` entries and the on-disk JSONL log is capped at about
  ``LOG_ROTATE_BYTES * 2``.

Typed statuses (subsystems and checks): ``ok`` | ``degraded`` | ``unavailable`` | ``not_configured`` | ``error``.
"""

from __future__ import annotations

import collections
import json
import os
import platform
import re
import secrets
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

STATUSES = ("ok", "degraded", "unavailable", "not_configured", "error")
DATA_DIR_NAME = ".hq-carnet"
DIAG_DIR_NAME = "diagnostics"
PROBE_PREFIX = "hq-diag-probe-"
ERROR_LOG_NAME = "errors.jsonl"
CLIENT_LOG_NAME = "client-browser.jsonl"
STARTUP_FATAL_NAME = "hq-startup-error.txt"
RING_MAX = 100
LOG_ROTATE_BYTES = 128 * 1024
CLIENT_LOG_LINES_PER_FILE = 200
CLIENT_LOG_FILES_MAX = 2
CLIENT_LOG_RING_MAX = 200
CLIENT_BATCH_MAX = 48
CLIENT_MSG_MAX = 400
CLIENT_PAGE_MAX = 80
CLIENT_VIEW_MAX = 40
REQUEST_ID_MAX = 16
CLIENT_SESSION_MAX = 16
CLIENT_KINDS = frozenset(
    ("perf", "api", "meta", "view", "carnet", "console", "console-quiet", "agent", "error", "bundle", "perf-mark", "lag-spike")
)
CLIENT_DATA_KEYS_MAX = 14
REPRO_NOTE_NAME = "repro-notes.jsonl"
REPRO_NOTE_LINES_MAX = 100
REPRO_NOTE_MSG_MAX = 280
LAG_CAPTURES_DIR_NAME = "lag-captures"
LAG_SPIKE_RECENT_MINUTES = 15.0
LAG_SPIKES_LIST_MAX = 8
LAG_CAPTURE_LIST_MAX = 10
LAG_CAPTURE_MAX_FILES = 50
LAG_CAPTURE_JPEG_QUALITY = 85
LAG_CAPTURE_WEBP_QUALITY = 82
LAG_CAPTURE_MAX_EDGE = 2560
LAG_CAPTURE_ALLOWED_EXT = frozenset({".webp", ".jpg", ".jpeg", ".png"})
LAG_CAPTURE_FILE_RE = re.compile(r"^lag_\d{8}_\d{6}_[a-fA-F0-9]{6,16}_[a-zA-Z0-9_-]+(?:_hq)?$")
LAG_HQ_VIEW_MAX_BYTES = 512 * 1024
REDACTION_CONTRACT = {
    "never_logged": [
        "PIN and session cookies",
        "Authorization headers",
        "URL query strings",
        "Full home or project paths",
        "Webhook secrets and API keys",
    ],
    "scrubbed": ["filesystem paths", "email addresses", "tokens longer than 31 chars"],
    "limits": {"message_chars": CLIENT_MSG_MAX, "lines_per_file": CLIENT_LOG_LINES_PER_FILE, "log_files_max": CLIENT_LOG_FILES_MAX},
}
MESSAGE_MAX = 160
TRACE_FRAMES_MAX = 8
BACKUP_STAMP_RE = re.compile(r"^\d{8}_\d{6}$")
DEPLOY_BACKUP_PREFIX = "_backup_pre-"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA_PREFIX_RE = re.compile(r"^[0-9a-f]{7,40}$")
BACKUP_STALE_MIN_HOURS = 36.0
BACKUP_WALK_MAX_FILES = 20000
BACKUP_WALK_MAX_SECONDS = 2.0
REQUIRED_MODULES = (
    "hq_carnet", "hq_carnet_reader", "hq_carnet_snapshots", "hq_carnet_history", "hq_carnet_reviews",
    "hq_carnet_verifications", "hq_carnet_reasoning", "hq_carnet_annotations", "hq_carnet_sources",
    "hq_carnet_media", "hq_carnet_voice", "hq_carnet_ask",
)
OCR_ASSETS = (
    "eng.traineddata.gz", "fra.traineddata.gz", "vendor-tesseract.min.js", "vendor-tesseract-worker.min.js",
    "vendor-tesseract-core-simd-lstm.wasm.js",
)
# Where each optional Carnet store lives under <root>/.hq-carnet (directory or single JSON file).
CARNET_STORES = {
    "history": ("history.json", "file"),
    "sources": ("sources.json", "file"),
    "snapshots": ("snapshots", "dir"),
    "reviews": ("reviews", "dir"),
    "verifications": ("verifications", "dir"),
    "reasoning": ("reasoning", "dir"),
    "annotations": ("annotations", "dir"),
    "media": ("assets", "dir"),
    "voice": ("voice", "dir"),
}


# ---------------------------------------------------------------- scrubbing

_WIN_PATH = re.compile(r"[A-Za-z]:[\\/][^\s'\"<>|]*")
_POSIX_PATH = re.compile(r"(?<![\w.])/(?:[\w.@+~-]+/)+[\w.@+~-]*")
_LONG_TOKEN = re.compile(r"[A-Za-z0-9_\-+=/]{32,}")
_CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def scrub(text: Any, root: Any = None, limit: int = MESSAGE_MAX) -> str:
    """Short, single-line, path- and token-free text for diagnostics. Never raises."""
    try:
        s = str(text)
    except Exception:
        return "<unprintable>"
    try:
        for r in {str(root or ""), os.path.realpath(str(root)) if root else ""}:
            if r and len(r) > 2:
                s = s.replace(r, "<root>").replace(r.replace("\\", "/"), "<root>")
        s = _WIN_PATH.sub("<path>", s)
        s = _POSIX_PATH.sub("<path>", s)
        s = _EMAIL.sub("<email>", s)
        s = _LONG_TOKEN.sub("<redacted>", s)
        s = _CTRL.sub(" ", s)
        s = re.sub(r"\s+", " ", s).strip()
    except Exception:
        return "<unprintable>"
    return s if len(s) <= limit else s[: limit - 1] + "…"


KNOWN_API = frozenset((
    "carnet", "diag", "hq", "status", "health", "list", "upload", "inbox", "inbox-zero", "calendar", "drawings", "backup", "backups",
    "events", "device", "palette", "automation", "runs", "telemetry", "brief", "push", "schedules", "terminal", "shell", "captures",
    "print", "me", "presence", "scratchpad", "activity", "alerts", "media", "pc", "files",
))
KNOWN_TOP = frozenset(("assets", "diagnostics", "login", "logout", "files", "download", "media", "wallboard", "manifest.webmanifest"))


def path_category(path: Any) -> str:
    """``/api/carnet``-style category of a request path: never the query string, never an id."""
    try:
        p = str(path or "").split("?", 1)[0].split("#", 1)[0]
    except Exception:
        return "unknown"
    parts = [x for x in p.split("/") if x]
    if not parts:
        return "/"
    # Only fixed, known path areas are ever echoed: a category is never built from caller-controlled text.
    if parts[0] == "api":
        return "/api/" + (parts[1] if len(parts) > 1 and parts[1] in KNOWN_API else "other")
    if parts[0] in KNOWN_TOP:
        return "/" + parts[0]
    return "/other"


def _utc_iso(ts: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if ts is None else ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _islink(p: str) -> bool:
    """Symlink OR (Python 3.12+, Windows) junction: Carnet's own storage code refuses both, so diagnostics must not follow either."""
    try:
        if os.path.islink(p):
            return True
        isj = getattr(os.path, "isjunction", None)
        return bool(isj and isj(p))
    except OSError:
        return False


def _is_dir_nolink(p: str) -> bool:
    return os.path.isdir(p) and not _islink(p)


# ---------------------------------------------------------------- identity

_IDENTITY: dict[str, Any] = {}


def read_git_head(root: Any) -> tuple[str | None, str]:
    """``(sha | None, source)`` read from ``<root>/.git`` WITHOUT running Git. Handles a plain ``HEAD`` ref, a detached HEAD,
    ``packed-refs`` and a ``.git`` *file* (worktree / submodule ``gitdir:`` pointer). Never raises; ``None`` means unknown."""
    try:
        git = os.path.join(os.fspath(root), ".git")
        if os.path.isfile(git):
            with open(git, "r", encoding="utf-8", errors="replace") as fh:
                line = fh.readline().strip()
            if not line.lower().startswith("gitdir:"):
                return None, "git_pointer_unreadable"
            gd = line.split(":", 1)[1].strip()
            git = gd if os.path.isabs(gd) else os.path.normpath(os.path.join(os.fspath(root), gd))
        if not os.path.isdir(git):
            return None, "not_a_checkout"
        with open(os.path.join(git, "HEAD"), "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(512).strip()
        if SHA_RE.match(head):
            return head, "git_head_detached"
        if not head.startswith("ref:"):
            return None, "git_head_unrecognised"
        ref = head.split(":", 1)[1].strip()
        if not re.fullmatch(r"refs/[A-Za-z0-9._/-]+", ref) or ".." in ref:
            return None, "git_ref_unrecognised"
        # a linked worktree keeps refs in the common dir
        common = git
        cd = os.path.join(git, "commondir")
        if os.path.isfile(cd):
            with open(cd, "r", encoding="utf-8", errors="replace") as fh:
                c = fh.readline().strip()
            common = c if os.path.isabs(c) else os.path.normpath(os.path.join(git, c))
        for base in (git, common):
            rp = os.path.join(base, *ref.split("/"))
            if os.path.isfile(rp):
                with open(rp, "r", encoding="utf-8", errors="replace") as fh:
                    val = fh.readline().strip()
                if SHA_RE.match(val):
                    return val, "git_ref"
        packed = os.path.join(common, "packed-refs")
        if os.path.isfile(packed):
            with open(packed, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if line.endswith(" " + ref) and SHA_RE.match(line.split(" ", 1)[0]):
                        return line.split(" ", 1)[0], "git_packed_refs"
        return None, "git_ref_not_found"
    except Exception:
        return None, "git_read_failed"


def init_identity(root: Any, *, version: str = "", started_at: float | None = None, env: dict | None = None) -> dict:
    """Capture the process identity ONCE (call at startup). Idempotent for the same process only if you want a refresh."""
    env = os.environ if env is None else env
    sha: str | None = None
    source = "unknown"
    forced = str(env.get("HQ_BUILD_SHA") or "").strip().lower()
    if forced and SHA_PREFIX_RE.match(forced):
        sha, source = forced, "env"
    else:
        sha, source = read_git_head(root)
    started = time.time() if started_at is None else started_at
    _IDENTITY.clear()
    _IDENTITY.update(
        build_sha=sha,
        build_sha_short=(sha[:12] if sha else None),
        build_sha_source=source if sha else (source or "unknown"),
        version=str(version or ""),
        python=sys.version.split()[0],
        python_implementation=platform.python_implementation(),
        platform=sys.platform,
        os=f"{platform.system()} {platform.release()}".strip(),
        pid=os.getpid(),
        started_at=float(started),
        root_name=os.path.basename(os.path.abspath(os.fspath(root))) or "root",
        data_dir=DATA_DIR_NAME,
        run_mode="git_checkout" if os.path.exists(os.path.join(os.fspath(root), ".git")) else "not_a_checkout",
    )
    return dict(_IDENTITY)


def identity(root: Any = None, *, expect: str | None = None, now: float | None = None) -> dict:
    """The captured identity plus live uptime. ``checkout_sha`` is re-read from disk (two small file reads — on demand only) so a
    deployment that moved ``HEAD`` without a restart is visible as ``restart_pending``. ``expect`` is a full or abbreviated SHA."""
    now = time.time() if now is None else now
    out = dict(_IDENTITY) if _IDENTITY else {"build_sha": None, "build_sha_source": "unknown", "version": "", "pid": os.getpid()}
    started = float(out.get("started_at") or now)
    out["uptime_sec"] = max(0, int(now - started))
    out["started_at_utc"] = _utc_iso(started)
    out.pop("started_at", None)
    if root is not None:
        cur, _src = read_git_head(root)
        out["checkout_sha"] = cur
        running = out.get("build_sha")
        out["restart_pending"] = bool(running and cur and running != cur) if (running and cur) else None
    if expect is not None:
        e = str(expect).strip().lower()
        running = out.get("build_sha")
        if not SHA_PREFIX_RE.match(e):
            out["expected"] = {"given": scrub(e, limit=48), "valid": False, "matches": None}
        elif not running:
            out["expected"] = {"given": e, "valid": True, "matches": None, "note": "running build unknown"}
        else:
            out["expected"] = {"given": e, "valid": True, "matches": running.startswith(e)}
    return out


def liveness() -> dict:
    ident = _IDENTITY
    started = float(ident.get("started_at") or time.time())
    return {
        "status": "alive",
        "pid": os.getpid(),
        "uptime_sec": max(0, int(time.time() - started)),
        "build_sha_short": ident.get("build_sha_short"),
        "checked_at": _utc_iso(),
    }


# ---------------------------------------------------------------- readiness (cheap, never writes)

def _chk(status: str, detail: str, **extra: Any) -> dict:
    assert status in STATUSES, status
    d = {"status": status, "detail": detail}
    d.update(extra)
    return d


def required_assets(render_app: Callable[[], str] | None) -> list[str]:
    """Asset names the app shell references (``/assets/<name>``), derived from the real HTML so it cannot drift."""
    if render_app is None:
        return []
    try:
        html = render_app()
        if isinstance(html, (bytes, bytearray)):
            html = bytes(html).decode("utf-8", errors="replace")
        names = {m for m in re.findall(r"/assets/([A-Za-z0-9._-]+\.(?:js|css|png|svg|wasm|json))", html)}
        # Feature scripts loaded on demand (Carnet, Forge, Dessiner) are listed by bare name in the shell's loader arrays.
        names |= set(re.findall(r"'(hq-[A-Za-z0-9._-]+\.js)'", html))
        return sorted(names)
    except Exception:
        return []


def check_config_file(config_path: Any, config: Any) -> dict:
    if not isinstance(config, dict) or not config:
        return _chk("error", "config_not_loaded")
    try:
        p = os.fspath(config_path)
        if not os.path.isfile(p):
            return _chk("ok", "config_in_memory_only", file="absent")
        with open(p, "r", encoding="utf-8") as fh:
            data = json.loads(fh.read())
        if not isinstance(data, dict):
            return _chk("error", "config_file_not_an_object", note="the next restart would abort")
        return _chk("ok", "config_file_parses", file="parses")
    except json.JSONDecodeError:
        return _chk("error", "config_file_malformed", note="running instance is unaffected; the NEXT restart would abort")
    except OSError:
        return _chk("degraded", "config_file_unreadable")


def check_data_root(root: Any) -> dict:
    r = os.fspath(root)
    if not os.path.isdir(r):
        return _chk("unavailable", "root_missing")
    try:
        with os.scandir(r):
            pass
    except OSError:
        return _chk("unavailable", "root_unreadable")
    return _chk("ok", "root_readable")


def check_carnet_dir(root: Any) -> dict:
    d = os.path.join(os.fspath(root), DATA_DIR_NAME)
    if _islink(d):
        return _chk("unavailable", "data_dir_is_symlink", note="Carnet refuses links")
    if not os.path.exists(d):
        return _chk("degraded", "data_dir_not_initialised", note="created on first save")
    if not os.path.isdir(d):
        return _chk("unavailable", "data_dir_not_a_directory")
    try:
        with os.scandir(d):
            pass
    except OSError:
        return _chk("unavailable", "data_dir_unreadable")
    nb = os.path.join(d, "notebook.json")
    if _islink(nb):
        return _chk("unavailable", "notebook_is_symlink")
    if os.path.isfile(nb):
        try:
            size = os.stat(nb).st_size
        except OSError:
            return _chk("unavailable", "notebook_unreadable")
        return _chk("ok" if size > 0 else "degraded", "notebook_present" if size > 0 else "notebook_empty", notebook_bytes=size)
    return _chk("ok", "no_notebook_yet", note="fresh instance")


def check_static_assets(root: Any, names: list[str]) -> dict:
    if not names:
        return _chk("degraded", "asset_list_unknown")
    base = os.path.join(os.fspath(root), "assets")
    missing, empty = [], []
    for n in names:
        p = os.path.join(base, n)
        try:
            if not os.path.isfile(p):
                missing.append(n)
            elif os.stat(p).st_size == 0:
                empty.append(n)
        except OSError:
            missing.append(n)
    if missing or empty:
        return _chk("unavailable", "assets_missing_or_empty", checked=len(names), missing=missing[:20], empty=empty[:20],
                    missing_count=len(missing), empty_count=len(empty))
    return _chk("ok", "assets_present", checked=len(names))


def check_modules(names: tuple[str, ...] = REQUIRED_MODULES) -> dict:
    missing = [n for n in names if n not in sys.modules]
    if missing:
        return _chk("error", "modules_not_imported", missing=missing)
    return _chk("ok", "modules_imported", checked=len(names))


def check_ocr_assets(root: Any) -> dict:
    base = os.path.join(os.fspath(root), "assets")
    missing, bad = [], []
    for n in OCR_ASSETS:
        p = os.path.join(base, n)
        if not os.path.isfile(p):
            missing.append(n)
            continue
        try:
            with open(p, "rb") as fh:
                head = fh.read(2)
            if os.stat(p).st_size == 0 or (n.endswith(".gz") and head != b"\x1f\x8b"):
                bad.append(n)
        except OSError:
            bad.append(n)
    if missing or bad:
        return _chk("unavailable", "ocr_assets_missing_or_invalid", missing=missing, invalid=bad,
                    note="OCR runs in the browser; it cannot work without these files")
    return _chk("ok", "ocr_assets_present", checked=len(OCR_ASSETS), note="presence/format only; OCR itself is not run")


def check_voice(config: Any, voice_mod: Any = None) -> dict:
    cmd = (config or {}).get("transcribe_command") if isinstance(config, dict) else None
    if not cmd:
        return _chk("not_configured", "transcribe_command_not_set", note="optional")
    if not isinstance(cmd, list) or not cmd or not all(isinstance(x, str) for x in cmd):
        return _chk("error", "transcribe_command_invalid")
    exe = cmd[0]
    if not os.path.isabs(exe):
        return _chk("error", "transcribe_command_not_absolute")
    if not os.path.isfile(exe):
        return _chk("unavailable", "transcribe_engine_missing", note="configured executable not found")
    return _chk("ok", "transcribe_engine_present", note="presence only; no transcription is run")


def check_backup_cheap(config: Any) -> dict:
    raw = str((config or {}).get("backup_dir") or "") if isinstance(config, dict) else ""
    if not raw:
        return _chk("not_configured", "backup_dir_not_set")
    if not os.path.isabs(raw) and not re.match(r"^[A-Za-z]:[\\/]", raw):
        return _chk("error", "backup_dir_not_absolute")
    if not os.path.isdir(raw):
        return _chk("unavailable", "backup_dir_missing")
    return _chk("ok", "backup_dir_present", note="existence only; see /api/diag/backup for recency")


READY_REQUIRED = ("config", "data_root", "carnet_dir", "static_assets", "modules")


def readiness(*, root: Any, config: Any, config_path: Any = None, asset_names: list[str] | None = None,
              voice_mod: Any = None) -> dict:
    checks = {
        "config": check_config_file(config_path, config) if config_path is not None else (_chk("ok", "config_loaded") if isinstance(config, dict) and config else _chk("error", "config_not_loaded")),
        "data_root": check_data_root(root),
        "carnet_dir": check_carnet_dir(root),
        "static_assets": check_static_assets(root, asset_names or []),
        "modules": check_modules(),
        "ocr_assets": check_ocr_assets(root),
        "transcription": check_voice(config, voice_mod),
        "backup_dir": check_backup_cheap(config),
    }
    if checks["data_root"]["status"] != "ok":  # nothing below the root can be trusted
        checks["carnet_dir"] = _chk("unavailable", "root_unavailable")
    required_bad = [k for k in READY_REQUIRED if checks[k]["status"] in ("unavailable", "error")]
    soft = [k for k, v in checks.items() if v["status"] in ("degraded", "unavailable", "error") and k not in required_bad]
    if required_bad:
        state = "not_ready"
        summary = "Not ready: " + ", ".join(required_bad)
    elif soft:
        state = "degraded"
        summary = "Ready with degradation: " + ", ".join(sorted(soft))
    else:
        state = "ready"
        summary = "Ready"
    return {"status": state, "summary": summary, "checks": checks, "checked_at": _utc_iso()}


# ---------------------------------------------------------------- subsystems (on demand, read-only)

def _read_json_file_status(path: str, limit: int = 64 * 1024 * 1024) -> dict:
    try:
        if _islink(path):
            return _chk("unavailable", "symlink_refused")
        size = os.stat(path).st_size
        if size > limit:
            return _chk("degraded", "too_large_to_verify", bytes=size)
        with open(path, "rb") as fh:
            json.loads(fh.read().decode("utf-8"))
        return _chk("ok", "json_valid", bytes=size)
    except FileNotFoundError:
        return _chk("not_configured", "no_data_yet")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _chk("error", "json_corrupt")
    except OSError:
        return _chk("unavailable", "unreadable")


def _store_status(root: str, name: str) -> dict:
    rel, kind = CARNET_STORES[name]
    base = os.path.join(root, DATA_DIR_NAME)
    p = os.path.join(base, rel)
    if _islink(base) or _islink(p):
        return _chk("unavailable", "symlink_refused")
    if not os.path.exists(base):
        return _chk("not_configured", "no_data_yet")
    if kind == "file":
        return _read_json_file_status(p)
    if not os.path.exists(p):
        return _chk("not_configured", "no_data_yet")
    if not os.path.isdir(p):
        return _chk("unavailable", "not_a_directory")
    try:
        n = 0
        with os.scandir(p) as it:
            for _e in it:
                n += 1
                if n >= 100000:
                    break
        return _chk("ok", "store_readable", entries=n)
    except OSError:
        return _chk("unavailable", "unreadable")


def _carnet_read(carnet: Any) -> dict:
    if carnet is None:
        return _chk("error", "carnet_module_missing")
    try:
        code, payload = carnet.http_get({})
    except Exception as e:  # simulated or real internal exception: classified, never propagated
        return _chk("error", "carnet_read_exception", type=type(e).__name__)
    if code == 200:
        return _chk("ok", "carnet_read_ok")
    if code == 503:
        return _chk("unavailable", "carnet_storage_error", http=code, code=str((payload or {}).get("code") or "")[:40])
    return _chk("error", "carnet_read_unexpected", http=code)


def _reader_check(carnet: Any) -> dict:
    """The Reader serves a sealed PDF only for a matching identity. With no identity it must answer a structured refusal (a 4xx
    with a code) — an exception or a 5xx means the Reader path itself is broken. A real PDF is NOT generated or streamed here."""
    if carnet is None:
        return _chk("error", "carnet_module_missing")
    try:
        code, _name, got = carnet.http_reader_pdf({})
    except Exception as e:
        return _chk("error", "reader_exception", type=type(e).__name__)
    if isinstance(code, int) and 400 <= code < 500 and isinstance(got, dict) and got.get("code"):
        return _chk("ok", "reader_refusal_path_ok", note="route logic alive; no PDF streamed")
    if code == 503:
        return _chk("unavailable", "reader_storage_error", http=code)
    return _chk("error", "reader_unexpected", http=code)


def _ask_check(carnet: Any) -> dict:
    if carnet is None:
        return _chk("error", "carnet_module_missing")
    try:
        code, payload = carnet.http_post({"action": "ask", "question": "diagnostic", "scope": {"kind": "notebook"}, "limit": 1})
    except Exception as e:
        return _chk("error", "ask_exception", type=type(e).__name__)
    if code == 200:
        return _chk("ok", "ask_search_ok", note="read-only constant query; results discarded")
    if code == 503:
        return _chk("unavailable", "ask_storage_error", http=code)
    return _chk("degraded", "ask_unexpected", http=code, code=str((payload or {}).get("code") or "")[:40])


def subsystems(*, root: Any, config: Any, carnet: Any, asset_names: list[str] | None = None) -> dict:
    r = os.fspath(root)
    data_ok = os.path.isdir(r)
    out: dict[str, dict] = {}
    # The real Carnet read path SEEDS notebook.json on a fresh root. A diagnostic must not create data, so with no notebook yet
    # the read-path checks are reported honestly as not run instead of being allowed to write.
    has_nb = os.path.isfile(os.path.join(r, DATA_DIR_NAME, "notebook.json"))
    no_nb = _chk("not_configured", "no_notebook_yet", note="not exercised: the read path would create the notebook")
    out["carnet_read"] = (_carnet_read(carnet) if has_nb else no_nb) if data_ok else _chk("unavailable", "root_missing")
    out["reader"] = (_reader_check(carnet) if has_nb else no_nb) if data_ok else _chk("unavailable", "root_missing")
    out["ask_search"] = (_ask_check(carnet) if has_nb else no_nb) if data_ok else _chk("unavailable", "root_missing")
    out["static_assets"] = check_static_assets(r, asset_names or [])
    out["ocr"] = check_ocr_assets(r)
    out["transcription"] = check_voice(config)
    for name in CARNET_STORES:
        out[name] = _store_status(r, name) if data_ok else _chk("unavailable", "root_missing")
    counts = collections.Counter(v["status"] for v in out.values())
    return {"subsystems": out, "counts": dict(counts), "checked_at": _utc_iso()}


# ---------------------------------------------------------------- explicit write probe

_PROBE_LOCK = threading.Lock()


def write_probe(root: Any) -> dict:
    """Explicit, admin-triggered. Create → fsync → atomic replace → read back → remove → verify removal inside
    ``<root>/.hq-carnet/diagnostics/``. The name is generated; nothing user-supplied reaches the filesystem. Never touches a real
    Carnet record. On failure names the exact step."""
    t0 = time.time()
    steps: list[dict] = []
    created_dirs: list[str] = []

    def done(status: str, failed: str | None, note: str = "") -> dict:
        res = {"status": status, "failed_step": failed, "steps": steps, "duration_ms": int((time.time() - t0) * 1000), "checked_at": _utc_iso()}
        if note:
            res["note"] = note
        return res

    if not _PROBE_LOCK.acquire(blocking=False):
        return {"status": "error", "failed_step": "lock", "steps": [], "note": "probe_in_progress", "duration_ms": 0, "checked_at": _utc_iso()}
    try:
        r = os.fspath(root)
        base = os.path.join(r, DATA_DIR_NAME)
        diag = os.path.join(base, DIAG_DIR_NAME)
        if not os.path.isdir(r):
            steps.append({"step": "root_exists", "ok": False})
            return done("unavailable", "root_exists")
        steps.append({"step": "root_exists", "ok": True})
        if _islink(base) or _islink(diag):
            steps.append({"step": "no_symlinks", "ok": False})
            return done("unavailable", "no_symlinks", "symlink_refused")
        steps.append({"step": "no_symlinks", "ok": True})
        try:
            for d in (base, diag):
                if not os.path.exists(d):
                    os.mkdir(d)
                    created_dirs.append(d)
                elif not os.path.isdir(d):
                    raise NotADirectoryError(DATA_DIR_NAME)
            steps.append({"step": "mkdir", "ok": True})
        except OSError:
            steps.append({"step": "mkdir", "ok": False})
            return done("error", "mkdir")
        token = secrets.token_hex(16)
        tmp = os.path.join(diag, f"{PROBE_PREFIX}{secrets.token_hex(6)}.tmp")
        final = tmp[:-4] + ".json"
        step = "write_tmp"
        try:
            with open(tmp, "wb") as fh:
                fh.write(token.encode("ascii"))
                steps.append({"step": "write_tmp", "ok": True})
                step = "fsync"
                fh.flush()
                os.fsync(fh.fileno())
                steps.append({"step": "fsync", "ok": True})
            step = "atomic_replace"
            os.replace(tmp, final)
            steps.append({"step": "atomic_replace", "ok": True})
            step = "read_back"
            with open(final, "rb") as fh:
                back = fh.read()
            if back != token.encode("ascii"):
                steps.append({"step": "read_back", "ok": False})
                _best_effort_remove(tmp, final)
                return done("error", "read_back", "content_mismatch")
            steps.append({"step": "read_back", "ok": True})
            step = "remove"
            os.remove(final)
            steps.append({"step": "remove", "ok": True})
            step = "verify_removed"
            if os.path.exists(final) or os.path.exists(tmp):
                steps.append({"step": "verify_removed", "ok": False})
                return done("error", "verify_removed")
            steps.append({"step": "verify_removed", "ok": True})
        except OSError:
            steps.append({"step": step, "ok": False})
            _best_effort_remove(tmp, final)
            return done("error", step)
        # Leave no trace: also drop stale probe files from an earlier failed run, and the dirs this probe created.
        _remove_stale_probe_files(diag)
        for d in reversed(created_dirs):
            try:
                os.rmdir(d)
            except OSError:
                pass
        return done("ok", None)
    finally:
        _PROBE_LOCK.release()


def _best_effort_remove(*paths: str) -> None:
    for p in paths:
        try:
            os.remove(p)
        except OSError:
            pass


def _rotate_jsonl_chain(path: str, *, max_files: int) -> None:
    """Roll ``path`` into ``path.1``, ``path.1`` into ``path.2``, … keeping at most ``max_files`` files. Never raises."""
    if max_files < 1:
        return
    try:
        if max_files == 1:
            _best_effort_remove(path)
            return
        top = max_files - 1
        _best_effort_remove(f"{path}.{top}")
        for n in range(top - 1, 0, -1):
            src = f"{path}.{n}"
            dst = f"{path}.{n + 1}"
            if os.path.isfile(src):
                os.replace(src, dst)
        if os.path.isfile(path):
            os.replace(path, f"{path}.1")
        for n in range(max_files, max_files + 6):
            _best_effort_remove(f"{path}.{n}")
    except OSError:
        pass


def _remove_stale_probe_files(diag: str) -> None:
    try:
        with os.scandir(diag) as it:
            for e in list(it):
                if e.name.startswith(PROBE_PREFIX) and (e.name.endswith(".tmp") or e.name.endswith(".json")) and e.is_file(follow_symlinks=False):
                    _best_effort_remove(e.path)
    except OSError:
        pass


# ---------------------------------------------------------------- bounded recent-error log

class ErrorLog:
    """Bounded in-memory ring + optional bounded JSONL file under ``.hq-carnet/diagnostics``. Records ONLY: time, subsystem,
    exception class, a scrubbed short message, a request *category*, a short correlation id and (admin-only) code frames."""

    def __init__(self, maxlen: int = RING_MAX) -> None:
        self._ring: collections.deque[dict] = collections.deque(maxlen=maxlen)
        self._lock = threading.Lock()
        self._seq = 0
        self._log_path: str | None = None
        self._root: str | None = None
        self.dropped_writes = 0

    def attach(self, root: Any) -> None:
        self._root = os.fspath(root)
        self._log_path = os.path.join(self._root, DATA_DIR_NAME, DIAG_DIR_NAME, ERROR_LOG_NAME)
        self._load_tail()

    def _load_tail(self) -> None:
        try:
            p = self._log_path
            if not p or not os.path.isfile(p) or _islink(p):
                return
            size = os.stat(p).st_size
            with open(p, "rb") as fh:
                if size > LOG_ROTATE_BYTES:
                    fh.seek(size - LOG_ROTATE_BYTES)
                    fh.readline()
                raw = fh.read().decode("utf-8", errors="replace")
            for line in raw.splitlines()[-self._ring.maxlen:]:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict) and e.get("at") and e.get("subsystem"):
                    e["restored"] = True
                    with self._lock:
                        self._seq += 1
                        e["seq"] = self._seq
                        self._ring.append(e)
        except Exception:
            pass

    def record(self, subsystem: str, *, exc: BaseException | None = None, message: str = "", path: Any = None,
               status: int | None = None, request_id: str | None = None, code: str | None = None,
               session_id: str | None = None) -> str:
        rid = request_id or secrets.token_hex(4)
        try:
            frames: list[str] = []
            etype = "event"
            msg = message
            if exc is not None:
                etype = re.sub(r"[^A-Za-z0-9_.]", "", type(exc).__name__)[:60] or "Exception"
                msg = message or str(exc)
                tb = exc.__traceback__
                if tb is not None:
                    for fs in traceback.extract_tb(tb)[-TRACE_FRAMES_MAX:]:
                        frames.append(f"{os.path.basename(fs.filename)}:{fs.lineno} in {fs.name}")
            elif code:
                etype = "http_5xx"
                msg = message or code
            sess_s = re.sub(r"[^a-fA-F0-9]", "", str(session_id or ""))[:CLIENT_SESSION_MAX] or None
            entry = {
                "at": _utc_iso(),
                "subsystem": re.sub(r"[^A-Za-z0-9_./-]", "", str(subsystem))[:40] or "unknown",
                "type": etype,
                "message": scrub(msg, self._root),
                "path_category": path_category(path),
                "status": int(status) if isinstance(status, int) else None,
                "request_id": rid,
                "session_id": sess_s,
                "code": re.sub(r"[^A-Za-z0-9_.-]", "", str(code or ""))[:40] or None,
                "trace": frames,
            }
            with self._lock:
                self._seq += 1
                entry["seq"] = self._seq
                self._ring.append(entry)
            self._append_file(entry)
        except Exception:
            pass  # observability must never break the request it observes
        return rid

    def _append_file(self, entry: dict) -> None:
        p = self._log_path
        if not p:
            return
        try:
            d = os.path.dirname(p)
            base = os.path.dirname(d)
            if not os.path.isdir(base) or _islink(base) or _islink(d):
                return  # never create the data dir just to log; never follow links
            os.makedirs(d, exist_ok=True)
            line = json.dumps({k: v for k, v in entry.items() if k not in ("seq", "restored")}, ensure_ascii=False) + "\n"
            try:
                if os.path.getsize(p) > LOG_ROTATE_BYTES:
                    os.replace(p, p + ".1")
            except OSError:
                pass
            with open(p, "a", encoding="utf-8") as fh:
                fh.write(line)
        except OSError:
            self.dropped_writes += 1

    def recent(self, limit: int = 50, *, include_trace: bool = True) -> list[dict]:
        limit = max(1, min(int(limit), RING_MAX))
        with self._lock:
            items = list(self._ring)[-limit:]
        items.reverse()
        out = []
        for e in items:
            c = dict(e)
            if not include_trace:
                c.pop("trace", None)
            out.append(c)
        return out

    def summary(self) -> dict:
        with self._lock:
            n = len(self._ring)
            last = self._ring[-1]["at"] if n else None
        return {"count": n, "capacity": self._ring.maxlen, "last_at": last, "persistent": bool(self._log_path),
                "dropped_writes": self.dropped_writes}

    def clear_for_tests(self) -> None:
        with self._lock:
            self._ring.clear()


ERRORS = ErrorLog()


class ClientBrowserLog:
    """Bounded JSONL log of scrubbed browser console / window errors under ``.hq-carnet/diagnostics``. Never stores cookies,
    tokens, or full URLs (query stripped)."""

    _LEVELS = frozenset(("log", "info", "warn", "error", "debug"))

    def __init__(self, maxlen: int = CLIENT_LOG_RING_MAX) -> None:
        self._ring: collections.deque[dict] = collections.deque(maxlen=maxlen)
        self._lock = threading.Lock()
        self._log_path: str | None = None
        self._root: str | None = None
        self.dropped_writes = 0
        self._active_lines = 0

    def attach(self, root: Any) -> None:
        self._root = os.fspath(root)
        self._log_path = os.path.join(self._root, DATA_DIR_NAME, DIAG_DIR_NAME, CLIENT_LOG_NAME)
        self._active_lines = 0
        p = self._log_path
        try:
            if p and os.path.isfile(p) and not _islink(p):
                with open(p, "rb") as fh:
                    self._active_lines = sum(1 for _ in fh)
        except OSError:
            self._active_lines = 0

    def _sanitize_data(self, raw: Any) -> dict | None:
        if not isinstance(raw, dict):
            return None
        out: dict[str, Any] = {}
        for k, v in list(raw.items())[:CLIENT_DATA_KEYS_MAX]:
            key = re.sub(r"[^a-zA-Z0-9_]", "", str(k))[:32]
            if not key:
                continue
            if isinstance(v, bool):
                out[key] = v
            elif isinstance(v, int):
                out[key] = v
            elif isinstance(v, float):
                out[key] = float(v)
            elif isinstance(v, str):
                out[key] = scrub(v, self._root, limit=120)
            else:
                out[key] = scrub(str(v), self._root, limit=120)
        return out or None

    def ingest(self, entries: Any, *, page: str = "", role: str = "", view: str = "", session_id: str = "") -> dict:
        if not isinstance(entries, list):
            return {"accepted": 0, "rejected": 0, "error": "bad_payload"}
        page_s = scrub(page, self._root, limit=CLIENT_PAGE_MAX)[:CLIENT_PAGE_MAX]
        try:
            page_s = page_s.split("?", 1)[0].split("#", 1)[0]
        except Exception:
            pass
        batch_view = scrub(view, self._root, limit=CLIENT_VIEW_MAX)[:CLIENT_VIEW_MAX]
        batch_view = re.sub(r"[^a-zA-Z0-9_\-./]", "", batch_view)[:CLIENT_VIEW_MAX] or None
        batch_session = re.sub(r"[^a-fA-F0-9]", "", str(session_id or ""))[:CLIENT_SESSION_MAX] or None
        role_s = re.sub(r"[^a-z]", "", str(role or ""))[:12] or "unknown"
        accepted = 0
        rejected = 0
        for raw in entries[:CLIENT_BATCH_MAX]:
            if not isinstance(raw, dict):
                rejected += 1
                continue
            level = str(raw.get("level") or "log").lower()
            if level not in self._LEVELS:
                level = "log"
            msg = scrub(raw.get("message") or raw.get("msg") or "", self._root, limit=CLIENT_MSG_MAX)
            if not msg:
                rejected += 1
                continue
            detail = raw.get("detail")
            detail_s = None
            if detail is not None:
                detail_s = scrub(detail, self._root, limit=CLIENT_MSG_MAX)
            view_raw = raw.get("view") or batch_view or ""
            view_s = scrub(view_raw, self._root, limit=CLIENT_VIEW_MAX)[:CLIENT_VIEW_MAX]
            view_s = re.sub(r"[^a-zA-Z0-9_\-./]", "", view_s)[:CLIENT_VIEW_MAX] or None
            rid_raw = raw.get("request_id") or raw.get("requestId") or ""
            rid_s = re.sub(r"[^a-fA-F0-9]", "", str(rid_raw))[:REQUEST_ID_MAX] or None
            kind_raw = str(raw.get("kind") or "")[:24]
            kind_s = re.sub(r"[^a-zA-Z0-9_.-]", "", kind_raw)[:24] or None
            if kind_s and kind_s not in CLIENT_KINDS:
                kind_s = "agent"
            sess_raw = raw.get("session_id") or batch_session or ""
            sess_s = re.sub(r"[^a-fA-F0-9]", "", str(sess_raw))[:CLIENT_SESSION_MAX] or None
            data_s = self._sanitize_data(raw.get("data"))
            entry = {
                "at": _utc_iso(),
                "level": level,
                "kind": kind_s,
                "message": msg,
                "page": page_s or None,
                "view": view_s,
                "role": role_s,
                "detail": detail_s,
                "request_id": rid_s,
                "session_id": sess_s,
                "data": data_s,
            }
            with self._lock:
                self._ring.append(entry)
            self._append_file(entry)
            accepted += 1
        return {"accepted": accepted, "rejected": rejected, "summary": self.summary()}

    def _append_file(self, entry: dict) -> None:
        p = self._log_path
        if not p or not self._root:
            return
        try:
            r = self._root
            if not os.path.isdir(r) or _islink(r):
                return
            base = os.path.join(r, DATA_DIR_NAME)
            d = os.path.join(base, DIAG_DIR_NAME)
            if _islink(base) or _islink(d):
                return
            for path in (base, d):
                if not os.path.exists(path):
                    os.mkdir(path)
                elif not os.path.isdir(path):
                    return
            line = json.dumps({k: v for k, v in entry.items() if v is not None}, ensure_ascii=False) + "\n"
            with open(p, "a", encoding="utf-8") as fh:
                fh.write(line)
            self._active_lines += 1
            if self._active_lines >= CLIENT_LOG_LINES_PER_FILE:
                _rotate_jsonl_chain(p, max_files=CLIENT_LOG_FILES_MAX)
                self._active_lines = 0
        except OSError:
            self.dropped_writes += 1

    def summary(self) -> dict:
        with self._lock:
            n = len(self._ring)
            last = self._ring[-1]["at"] if n else None
        return {
            "count": n,
            "capacity": self._ring.maxlen,
            "last_at": last,
            "persistent": bool(self._log_path),
            "file": CLIENT_LOG_NAME,
            "lines_per_file": CLIENT_LOG_LINES_PER_FILE,
            "files_max": CLIENT_LOG_FILES_MAX,
            "dropped_writes": self.dropped_writes,
        }

    def clear_for_tests(self) -> None:
        with self._lock:
            self._ring.clear()

    def tail(self, limit: int = 50, session_id: str | None = None) -> list[dict]:
        limit = max(1, min(int(limit), self._ring.maxlen or CLIENT_LOG_RING_MAX))
        file_items = _read_jsonl_tail(self._log_path, limit)
        backup = (self._log_path + ".1") if self._log_path else None
        if backup and len(file_items) < limit:
            file_items = (_read_jsonl_tail(backup, limit - len(file_items)) + file_items)[-limit:]
        with self._lock:
            ring_items = [dict(e) for e in list(self._ring)[-limit:]]
        seen = set()
        merged: list[dict] = []
        for item in file_items + ring_items:
            key = (item.get("at"), item.get("message"), item.get("session_id"))
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
        merged = merged[-limit:]
        sid = normalize_client_session_id(session_id)
        if sid:
            merged = [row for row in merged if row.get("session_id") == sid][-limit:]
        return merged


CLIENT_LOG = ClientBrowserLog()


def _read_jsonl_tail(path: str | None, limit: int) -> list[dict]:
    if not path or limit < 1:
        return []
    try:
        if not os.path.isfile(path) or _islink(path):
            return []
        with open(path, "rb") as fh:
            raw = fh.read()
        lines = raw.splitlines()[-limit:]
        out: list[dict] = []
        for line in lines:
            try:
                j = json.loads(line.decode("utf-8", errors="replace"))
            except ValueError:
                continue
            if isinstance(j, dict):
                out.append(j)
        return out
    except OSError:
        return []


def _repro_notes_path(root: Any) -> str:
    return os.path.join(os.fspath(root), DATA_DIR_NAME, DIAG_DIR_NAME, REPRO_NOTE_NAME)


def append_repro_note(root: Any, *, session_id: str, note: str, role: str = "", view: str = "") -> dict:
    try:
        r = os.fspath(root)
        if not os.path.isdir(r) or _islink(r):
            return {"ok": False, "error": "root_unavailable"}
        text = scrub(note, root, limit=REPRO_NOTE_MSG_MAX)
        if not text:
            return {"ok": False, "error": "empty"}
        sess = re.sub(r"[^a-fA-F0-9]", "", str(session_id or ""))[:CLIENT_SESSION_MAX] or None
        view_s = re.sub(r"[^a-zA-Z0-9_\-./]", "", scrub(view, root, limit=CLIENT_VIEW_MAX))[:CLIENT_VIEW_MAX] or None
        role_s = re.sub(r"[^a-z]", "", str(role or ""))[:12] or "unknown"
        entry = {"at": _utc_iso(), "session_id": sess, "view": view_s, "role": role_s, "note": text}
        base = os.path.join(r, DATA_DIR_NAME)
        d = os.path.join(base, DIAG_DIR_NAME)
        if _islink(base) or _islink(d):
            return {"ok": False, "error": "symlink_refused"}
        for path in (base, d):
            if not os.path.exists(path):
                os.mkdir(path)
            elif not os.path.isdir(path):
                return {"ok": False, "error": "not_dir"}
        p = _repro_notes_path(r)
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        _trim_jsonl_file(p, REPRO_NOTE_LINES_MAX)
        return {"ok": True, "entry": entry}
    except OSError:
        return {"ok": False, "error": "io"}


def _trim_jsonl_file(path: str, max_lines: int) -> None:
    if max_lines < 1 or not os.path.isfile(path):
        return
    try:
        with open(path, "rb") as fh:
            lines = fh.read().splitlines()
        if len(lines) <= max_lines:
            return
        body = b"\n".join(lines[-max_lines:]) + b"\n"
        tmp = path + ".trim.tmp"
        with open(tmp, "wb") as fh:
            fh.write(body)
        os.replace(tmp, path)
    except OSError:
        _best_effort_remove(path + ".trim.tmp")


def repro_notes_recent(root: Any, limit: int = 30) -> list[dict]:
    return _read_jsonl_tail(_repro_notes_path(root), max(1, min(int(limit), REPRO_NOTE_LINES_MAX)))


AGENT_PACKET_NAME = "agent-packet-latest.md"
AGENT_PACKET_BYTES_MAX = 48_000
REQUEST_ID_INDEX_MAX = 30

SUBSYSTEM_AGENT_MAP: list[dict[str, Any]] = [
    {"subsystem": "carnet", "views": ["carnet", "accueil"], "files": ["assets/hq-carnet.js", "iphone_bridge.py"], "check": "readiness.carnet_read"},
    {"subsystem": "forge", "views": ["forge"], "files": ["assets/hq-forge.js", "iphone_bridge.py"], "check": "lazy hqForgeLoad"},
    {"subsystem": "companion", "views": ["intime"], "files": ["assets/hq-companion.js"], "check": "perf-mark companion"},
    {"subsystem": "dessiner", "views": ["dessiner"], "files": ["assets/hq-dessiner.js", "iphone_bridge.py"], "check": "perf-mark dessiner"},
    {"subsystem": "bridge", "views": ["accueil", "fichiers", "calendrier", "plus"], "files": ["iphone_bridge.py", "assets/hq.js"], "check": "api fetch-slow"},
    {"subsystem": "static_assets", "views": [], "files": ["assets/"], "check": "readiness.static_assets"},
]

SUBSYSTEM_FILE_HINTS: dict[str, list[str]] = {row["subsystem"]: list(row["files"]) for row in SUBSYSTEM_AGENT_MAP}

AGENT_PLAYBOOK_STEPS = [
    "GET /api/diag/agent-brief (or Maître: HUD Brief / diagnostics packet)",
    "If agent_triage.capture_hint → enable client_debug_hud, repro, re-fetch only",
    "Read top_issues, error_code_hints, request_id_index",
    "Follow likely_subsystem → recommended_files (do not repo-wide grep first)",
    "session-bundle only if raw client_log lines needed",
]


def _agent_packet_path(root: Any) -> str:
    return os.path.join(os.fspath(root), DATA_DIR_NAME, DIAG_DIR_NAME, AGENT_PACKET_NAME)


def write_agent_packet_file(root: Any, markdown: str) -> dict:
    """Overwrite a single scrubbed agent packet for local tools / disk-based agents."""
    try:
        r = os.fspath(root)
        if not os.path.isdir(r) or _islink(r):
            return {"ok": False, "error": "root_unavailable"}
        text = scrub(markdown, root, limit=AGENT_PACKET_BYTES_MAX)
        if not text.strip():
            return {"ok": False, "error": "empty"}
        base = os.path.join(r, DATA_DIR_NAME)
        d = os.path.join(base, DIAG_DIR_NAME)
        if _islink(base) or _islink(d):
            return {"ok": False, "error": "symlink_refused"}
        for path in (base, d):
            if not os.path.exists(path):
                os.mkdir(path)
            elif not os.path.isdir(path):
                return {"ok": False, "error": "not_dir"}
        p = _agent_packet_path(r)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text if text.endswith("\n") else text + "\n")
        os.replace(tmp, p)
        return {"ok": True, "relative": f"{DATA_DIR_NAME}/{DIAG_DIR_NAME}/{AGENT_PACKET_NAME}", "bytes": len(text.encode("utf-8"))}
    except OSError:
        return {"ok": False, "error": "io"}


def agent_packet_disk_hint(root: Any) -> dict:
    p = _agent_packet_path(root)
    if not os.path.isfile(p) or _islink(p):
        return {
            "relative": f"{DATA_DIR_NAME}/{DIAG_DIR_NAME}/{AGENT_PACKET_NAME}",
            "present": False,
            "save_route": "POST /api/diag/save-agent-packet",
        }
    try:
        st = os.stat(p)
        return {
            "relative": f"{DATA_DIR_NAME}/{DIAG_DIR_NAME}/{AGENT_PACKET_NAME}",
            "present": True,
            "bytes": st.st_size,
            "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "save_route": "POST /api/diag/save-agent-packet",
        }
    except OSError:
        return {"relative": f"{DATA_DIR_NAME}/{DIAG_DIR_NAME}/{AGENT_PACKET_NAME}", "present": False, "save_route": "POST /api/diag/save-agent-packet"}


AGENT_TIMELINE_MAX = 40
AGENT_TOP_ISSUES_MAX = 5
AGENT_SLOWEST_MARKS_MAX = 8

AGENT_TRIAGE_KEYS = frozenset(
    (
        "capture_ok",
        "capture_hint",
        "capture_effective",
        "likely_subsystem",
        "likely_subsystem_reason",
        "top_issues",
        "slowest_marks",
        "degraded_now",
        "view_context",
        "error_code_hints",
        "recommended_files",
        "last_lag_spikes",
    )
)

AGENT_TIMELINE_EVENT_KEYS = frozenset(
    ("at", "severity", "source", "summary", "request_id", "session_id", "view", "kind")
)

AGENT_BRIEF_KEYS = frozenset(
    (
        "generated_at",
        "identity",
        "readiness_status",
        "last_client_view",
        "request_ids",
        "request_id_index",
        "config_effective",
        "agent_triage",
        "timeline",
        "brief_md",
        "packet_md",
        "playbook",
        "symptom_index",
        "error_codes_doc",
        "subsystem_map",
        "agent_playbook_steps",
        "agent_packet_disk",
    )
)

# Agent hints for stable JSON ``code`` fields (see docs/hq-error-codes.md).
ERROR_CODE_AGENT_HINTS: dict[str, str] = {
    "storage_error": "Carnet/media storage refused — readiness carnet_read, disk, .hq-carnet permissions",
    "transcribe_failed": "Voice transcription pipeline failed",
    "notebook_revision_conflict": "Notebook changed elsewhere — refresh Carnet",
    "revision_conflict": "Optimistic lock conflict on Carnet write",
    "validation_error": "Request body/params failed validation",
    "validation": "Forge vault validation",
    "bad_triage": "Inbox triage state unknown or invalid",
    "bad_length": "Upload rejected — Content-Length required",
    "forbidden": "Role or policy refused the action",
    "nsfw_off": "NSFW companion/forge action blocked by config",
    "forge_error": "Forge/companion art internal error",
    "reader_unknown": "Reader PDF route not available",
    "diagnostic_failed": "Diagnostics route threw — not the main app route",
    "http_500": "Generic server fault — use path_category + trace in errors.jsonl",
    "http_503": "Structured HTTP refusal — read ``code`` and readiness checks",
}

_VIEW_SUBSYSTEM = {
    "carnet": "carnet",
    "forge": "forge",
    "dessiner": "dessiner",
    "intime": "companion",
    "accueil": "bridge",
    "fichiers": "bridge",
    "calendrier": "bridge",
}


def _at_sort_key(at: Any) -> str:
    return at if isinstance(at, str) and at else ""


def _client_row_severity(level: Any) -> str:
    lv = str(level or "").lower()
    if lv == "error":
        return "error"
    if lv in ("warn", "warning"):
        return "warn"
    return "info"


def normalize_client_session_id(raw: Any) -> str | None:
    sid = re.sub(r"[^a-fA-F0-9]", "", str(raw or ""))[:CLIENT_SESSION_MAX]
    return sid or None


def _minutes_since_utc_iso(at: Any) -> float | None:
    if not isinstance(at, str) or not at.strip():
        return None
    try:
        s = at.strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt.astimezone(timezone.utc)).total_seconds() / 60.0
    except (TypeError, ValueError):
        return None


def _lag_screenshot_from_row(row: dict) -> str | None:
    data = row.get("data") if isinstance(row.get("data"), dict) else {}
    shot = data.get("screenshot") or data.get("screenshot_rel")
    if isinstance(shot, str) and shot.strip():
        return shot.strip()
    detail = row.get("detail")
    if isinstance(detail, str) and "screenshot=" in detail:
        m = re.search(r"screenshot=([^\s]+)", detail)
        if m:
            return m.group(1).strip()
    return None


def collect_last_lag_spikes(client_lines: list[dict], *, limit: int = LAG_SPIKES_LIST_MAX) -> list[dict]:
    out: list[dict] = []
    for row in reversed(client_lines):
        if not isinstance(row, dict) or row.get("kind") != "lag-spike":
            continue
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        reason = str(data.get("reason") or row.get("message") or "lag").replace("lag spike: ", "")[:80]
        shot = _lag_screenshot_from_row(row)
        hq_view = data.get("hq_view") or data.get("hq_view_rel")
        out.append(
            {
                "at": row.get("at"),
                "reason": reason,
                "screenshot_rel": scrub(shot, None, limit=220) if shot else None,
                "hq_view_rel": scrub(hq_view, None, limit=220) if hq_view else None,
                "view": row.get("view"),
                "session_id": row.get("session_id"),
                "capture_route": "GET /api/diag/lag-capture/<name>" if shot else None,
            }
        )
        if len(out) >= limit:
            break
    out.reverse()
    return out


def safe_lag_capture_basename(name: str) -> str | None:
    base = (name or "").strip().replace("\\", "/").split("/")[-1]
    ext = ""
    lower = base.lower()
    for cand in (".webp", ".jpeg", ".jpg", ".png"):
        if lower.endswith(cand):
            ext = ".jpg" if cand == ".jpeg" else cand
            base = base[: -len(cand)]
            break
    if not ext:
        return None
    if ext not in LAG_CAPTURE_ALLOWED_EXT:
        return None
    if not LAG_CAPTURE_FILE_RE.match(base):
        return None
    return base + ext


def _lag_downscale_image(im: Any, max_edge: int) -> Any:
    w, h = im.size
    edge = max(w, h)
    if edge <= max_edge:
        return im
    scale = max_edge / float(edge)
    nw = max(1, int(w * scale))
    nh = max(1, int(h * scale))
    resample = getattr(getattr(im, "Resampling", None), "LANCZOS", None) or getattr(im, "LANCZOS", 1)
    return im.resize((nw, nh), resample)


def compress_lag_image_blob(blob: bytes) -> tuple[bytes, str]:
    """Lossy compress for disk retention; prefers WebP, falls back to JPEG, then original."""
    if not blob:
        return blob, ".png"
    try:
        from io import BytesIO

        from PIL import Image
    except ImportError:
        if blob[:3] == b"\xff\xd8\xff":
            return blob, ".jpg"
        if blob[:8] == b"\x89PNG\r\n\x1a\n":
            return blob, ".png"
        return blob, ".bin"
    im = None
    try:
        im = Image.open(BytesIO(blob))
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGB")
        elif im.mode != "RGB":
            im = im.convert("RGB")
        im = _lag_downscale_image(im, LAG_CAPTURE_MAX_EDGE)
        buf = BytesIO()
        im.save(buf, "WEBP", quality=LAG_CAPTURE_WEBP_QUALITY, method=4)
        webp = buf.getvalue()
        if webp:
            return webp, ".webp"
    except Exception:
        pass
    if im is not None:
        try:
            buf = BytesIO()
            im.save(buf, "JPEG", quality=LAG_CAPTURE_JPEG_QUALITY, optimize=True)
            jpg = buf.getvalue()
            if jpg and len(jpg) < len(blob):
                return jpg, ".jpg"
        except Exception:
            pass
    return blob, ".png" if blob[:8] == b"\x89PNG\r\n\x1a\n" else ".jpg"


def reencode_lag_capture_file(path: Any) -> str:
    """Rewrite one capture on disk in a smaller format; returns final absolute path."""
    try:
        p = Path(os.fspath(path))
    except (TypeError, ValueError):
        return os.fspath(path)
    if not p.is_file():
        return str(p)
    try:
        raw = p.read_bytes()
    except OSError:
        return str(p)
    new_data, ext = compress_lag_image_blob(raw)
    out = p.with_suffix(ext)
    try:
        out.write_bytes(new_data)
        if out.resolve() != p.resolve():
            p.unlink(missing_ok=True)
    except OSError:
        return str(p)
    return str(out)


def prune_lag_capture_files(root: Any) -> None:
    """Keep at most LAG_CAPTURE_MAX_FILES newest lag_* captures (all formats)."""
    try:
        r = os.fspath(root)
        d = os.path.join(r, DATA_DIR_NAME, DIAG_DIR_NAME, LAG_CAPTURES_DIR_NAME)
        if not os.path.isdir(d) or _islink(d):
            return
        entries: list[tuple[float, str]] = []
        for name in os.listdir(d):
            safe = safe_lag_capture_basename(name)
            if not safe:
                continue
            p = os.path.join(d, safe)
            if not os.path.isfile(p) or _islink(p):
                continue
            try:
                entries.append((os.stat(p).st_mtime, p))
            except OSError:
                continue
        entries.sort(key=lambda x: x[0], reverse=True)
        for _mtime, p in entries[LAG_CAPTURE_MAX_FILES:]:
            try:
                os.unlink(p)
            except OSError:
                pass
    except OSError:
        pass


def lag_capture_path(root: Any, filename: str) -> str | None:
    safe = safe_lag_capture_basename(filename)
    if not safe:
        return None
    try:
        r = os.fspath(root)
        if not os.path.isdir(r) or _islink(r):
            return None
        base = os.path.join(r, DATA_DIR_NAME, DIAG_DIR_NAME, LAG_CAPTURES_DIR_NAME)
        if _islink(base):
            return None
        p = os.path.join(base, safe)
        p = os.path.normpath(p)
        if not p.startswith(os.path.normpath(base + os.sep)):
            return None
        if not os.path.isfile(p) or _islink(p):
            return None
        return p
    except (TypeError, ValueError, OSError):
        return None


def list_lag_capture_files(root: Any, *, limit: int = LAG_CAPTURE_LIST_MAX) -> list[dict]:
    lim = max(1, min(int(limit), LAG_CAPTURE_LIST_MAX))
    try:
        r = os.fspath(root)
        d = os.path.join(r, DATA_DIR_NAME, DIAG_DIR_NAME, LAG_CAPTURES_DIR_NAME)
        if not os.path.isdir(d) or _islink(d):
            return []
        files: list[dict] = []
        for name in os.listdir(d):
            safe = safe_lag_capture_basename(name)
            if not safe or safe != name:
                continue
            p = os.path.join(d, name)
            if not os.path.isfile(p) or _islink(p):
                continue
            try:
                st = os.stat(p)
            except OSError:
                continue
            rel = f"{DATA_DIR_NAME}/{DIAG_DIR_NAME}/{LAG_CAPTURES_DIR_NAME}/{name}"
            files.append(
                {
                    "name": name,
                    "relative": rel,
                    "size": st.st_size,
                    "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "url": f"/api/diag/lag-capture/{name}",
                }
            )
        files.sort(key=lambda x: x.get("modified_at") or "", reverse=True)
        return files[:lim]
    except OSError:
        return []


def _companion_accueil_lag_hint(client_lines: list[dict]) -> tuple[str | None, list[str]]:
    marks = 0
    accueil = 0
    for row in client_lines:
        if not isinstance(row, dict) or row.get("kind") != "perf-mark":
            continue
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        if str(data.get("subsystem") or "") != "companion":
            continue
        if str(data.get("op") or "") != "live2d-frame":
            continue
        marks += 1
        if row.get("view") == "accueil":
            accueil += 1
    if marks >= 4 and accueil >= max(3, marks // 2):
        msg = (
            "Companion Live2D pressure on accueil — tune noteLive2dFrameCost / live2dFrameMinGap "
            "in assets/hq-companion.js"
        )
        return msg, ["assets/hq-companion.js", "assets/hq-debug-panel.js"]
    return None, []


def build_agent_timeline(
    *,
    client_lines: list[dict],
    server_errs: list[dict],
    repro_notes: list[dict],
    limit: int = AGENT_TIMELINE_MAX,
) -> list[dict]:
    """Merge client, server, and repro lines into one chronological list for agents."""
    lim = max(1, min(int(limit), AGENT_TIMELINE_MAX))
    events: list[dict] = []
    for row in client_lines:
        if not isinstance(row, dict):
            continue
        msg = str(row.get("message") or "")[:240]
        if not msg:
            continue
        if row.get("kind") == "lag-spike":
            shot = _lag_screenshot_from_row(row)
            if shot:
                msg = (msg + " · " + scrub(shot, None, limit=120))[:240]
        events.append(
            {
                "at": row.get("at"),
                "severity": _client_row_severity(row.get("level")),
                "source": "client",
                "summary": msg,
                "request_id": row.get("request_id"),
                "session_id": row.get("session_id"),
                "view": row.get("view"),
                "kind": row.get("kind"),
            }
        )
    for row in server_errs:
        if not isinstance(row, dict):
            continue
        pc = row.get("path_category") or row.get("subsystem") or "server"
        code = row.get("code") or row.get("type") or "error"
        st = row.get("status")
        summary = f"{pc} HTTP {st} {code}" if st else f"{pc} {code}"
        events.append(
            {
                "at": row.get("at"),
                "severity": "error" if isinstance(st, int) and st >= 500 else "warn",
                "source": "server",
                "summary": summary[:240],
                "request_id": row.get("request_id"),
                "session_id": row.get("session_id"),
                "view": None,
                "kind": "server_error",
            }
        )
    for row in repro_notes:
        if not isinstance(row, dict):
            continue
        note = str(row.get("note") or "")[:200]
        if not note:
            continue
        events.append(
            {
                "at": row.get("at"),
                "severity": "info",
                "source": "repro",
                "summary": "repro: " + note,
                "request_id": None,
                "session_id": row.get("session_id"),
                "view": row.get("view"),
                "kind": "repro_note",
            }
        )
    events.sort(key=lambda e: _at_sort_key(e.get("at")))
    if len(events) > lim:
        events = events[-lim:]
    _assert_timeline_shape(events)
    return events


def _score_likely_subsystem(
    *,
    client_lines: list[dict],
    server_errs: list[dict],
    degraded: dict,
    last_view: str | None,
) -> tuple[str | None, str | None]:
    scores: collections.Counter[str] = collections.Counter()

    def bump_api_path(path: str, weight: float) -> None:
        p = path.lower()
        if "carnet" in p:
            scores["carnet"] += weight
        elif "forge" in p:
            scores["forge"] += weight
        elif "companion" in p or "intime" in p:
            scores["companion"] += weight
        else:
            scores["bridge"] += weight * 0.5

    for row in client_lines:
        kind = row.get("kind")
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        if kind == "perf-mark":
            sub = str(data.get("subsystem") or "").strip()
            if sub:
                ms = data.get("ms")
                try:
                    ms_f = float(ms) if ms is not None else 0.0
                except (TypeError, ValueError):
                    ms_f = 0.0
                key = sub if sub in ("companion", "carnet", "forge", "api", "nav", "dessiner", "fichiers", "bridge") else "bridge"
                scores[key] += ms_f if ms_f > 0 else 1.0
                if sub == "nav" and data.get("op") == "setView-lazy":
                    tgt = str(data.get("target") or "")
                    if tgt in _VIEW_SUBSYSTEM:
                        scores[_VIEW_SUBSYSTEM[tgt]] += ms_f if ms_f > 0 else 8.0
        elif kind == "api" and _client_row_severity(row.get("level")) != "info":
            bump_api_path(str(data.get("path") or row.get("message") or ""), 12.0)
        elif kind in ("error", "carnet") or _client_row_severity(row.get("level")) == "error":
            v = row.get("view")
            if isinstance(v, str) and v in _VIEW_SUBSYSTEM:
                scores[_VIEW_SUBSYSTEM[v]] += 8.0
            else:
                scores["bridge"] += 4.0

    for row in server_errs:
        pc = str(row.get("path_category") or row.get("subsystem") or "")
        bump_api_path(pc, 18.0)
        if pc.startswith("/api/diag"):
            scores["diagnostics"] += 6.0

    for name, chk in degraded.items():
        if not isinstance(chk, dict):
            continue
        st = chk.get("status")
        if st in ("ok", "not_configured"):
            continue
        if name == "static_assets":
            scores["static_assets"] += 20.0
        elif "carnet" in name:
            scores["carnet"] += 14.0
        elif "reader" in name:
            scores["carnet"] += 10.0
        else:
            scores["bridge"] += 6.0

    if isinstance(last_view, str) and last_view in _VIEW_SUBSYSTEM:
        scores[_VIEW_SUBSYSTEM[last_view]] += 3.0

    if not scores:
        return None, None
    sub, weight = scores.most_common(1)[0]
    reason = f"scored from client/server marks and readiness (weight≈{weight:.0f})"
    return sub, reason


def _view_context_from_client(client_lines: list[dict], last_view: str | None) -> dict:
    nav: list[dict] = []
    for row in reversed(client_lines):
        if not isinstance(row, dict):
            continue
        kind = row.get("kind")
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        item = None
        if kind == "view":
            item = {
                "at": row.get("at"),
                "from": data.get("from"),
                "to": data.get("to"),
                "op": "view",
                "ms": data.get("ms"),
            }
        elif kind == "perf-mark" and data.get("subsystem") == "nav":
            op = data.get("op")
            if op in ("view", "setView-commit"):
                item = {
                    "at": row.get("at"),
                    "from": data.get("from"),
                    "to": data.get("to"),
                    "op": op,
                    "ms": data.get("ms"),
                }
        if item:
            nav.append(item)
        if len(nav) >= 5:
            break
    nav.reverse()
    return {"last_view": last_view, "recent_nav": nav}


def build_config_effective(config: dict, capture_effective: dict | None) -> dict:
    """Redacted bridge flags for agents (no secrets, no paths)."""
    cap = capture_effective if isinstance(capture_effective, dict) else {}
    cfg = config if isinstance(config, dict) else {}
    out: dict[str, Any] = {
        "client_debug_hud": bool(cap.get("hud_enabled")),
        "client_debug_agent": bool(cap.get("agent_mode")),
        "client_debug_perf_interval_sec": cap.get("perf_interval_sec"),
        "client_debug_log_when_collapsed": bool(cap.get("log_when_collapsed")),
        "hq_client_debug_env": cap.get("source") or "config",
    }
    for key in ("planner_port",):
        v = cfg.get(key)
        if isinstance(v, bool):
            out[key] = v
        elif isinstance(v, int):
            out[key] = v
        elif isinstance(v, str) and len(v) <= 32 and "\n" not in v:
            out[key] = v
    return out


def build_error_code_hints(server_errs: list[dict]) -> list[dict]:
    counts: collections.Counter[str] = collections.Counter()
    for row in server_errs:
        if not isinstance(row, dict):
            continue
        code = row.get("code")
        if isinstance(code, str) and code:
            counts[code] += 1
        elif isinstance(row.get("status"), int) and row.get("status") >= 500:
            counts[f"http_{row['status']}"] += 1
    hints: list[dict] = []
    for code, n in counts.most_common(8):
        hints.append(
            {
                "code": code,
                "count": n,
                "hint": ERROR_CODE_AGENT_HINTS.get(code, "See docs/hq-error-codes.md"),
            }
        )
    return hints


def build_request_id_index(
    client_lines: list[dict],
    server_errs: list[dict],
    *,
    max_ids: int = REQUEST_ID_INDEX_MAX,
) -> dict[str, dict]:
    index: dict[str, dict] = {}

    def ensure(rid: str) -> dict:
        if rid not in index:
            index[rid] = {"client": [], "server": None}
        return index[rid]

    for row in client_lines:
        if not isinstance(row, dict):
            continue
        rid = row.get("request_id")
        if not isinstance(rid, str) or not rid:
            continue
        ensure(rid)["client"].append(
            {
                "at": row.get("at"),
                "level": row.get("level"),
                "kind": row.get("kind"),
                "view": row.get("view"),
                "message": str(row.get("message") or "")[:160],
            }
        )
    for row in server_errs:
        if not isinstance(row, dict):
            continue
        rid = row.get("request_id")
        if not isinstance(rid, str) or not rid:
            continue
        ensure(rid)["server"] = {
            "at": row.get("at"),
            "path_category": row.get("path_category"),
            "status": row.get("status"),
            "code": row.get("code"),
            "type": row.get("type"),
            "session_id": row.get("session_id"),
        }

    if len(index) <= max_ids:
        return index

    def sort_key(item: tuple[str, dict]) -> str:
        rid, blob = item
        ats = [c.get("at") for c in blob.get("client") or [] if c.get("at")]
        srv = blob.get("server")
        if isinstance(srv, dict) and srv.get("at"):
            ats.append(srv["at"])
        return max(ats) if ats else rid

    trimmed = dict(sorted(index.items(), key=sort_key)[-max_ids:])
    return trimmed


def render_agent_packet_md(*, brief_md: str, request_id_index: dict, config_effective: dict) -> str:
    appendix = json.dumps(
        {"config_effective": config_effective, "request_id_index": request_id_index},
        indent=2,
        ensure_ascii=False,
    )
    return brief_md + "\n\n---\n\n## Machine appendix\n\n```json\n" + appendix + "\n```\n"


def build_agent_triage(
    *,
    client_lines: list[dict],
    server_errs: list[dict],
    degraded: dict,
    repro_notes: list[dict],
    client_summary: dict,
    last_view: str | None,
    capture_effective: dict | None,
) -> dict:
    cap = capture_effective if isinstance(capture_effective, dict) else {}
    hud = bool(cap.get("hud_enabled"))
    log_count = int((client_summary or {}).get("count") or 0)
    has_lines = bool(client_lines) or log_count > 0
    capture_ok = hud and has_lines
    capture_hint = None
    if not hud:
        capture_hint = (
            "Client capture off. Set bridge_config client_debug_hud true or HQ_CLIENT_DEBUG=1, "
            "restart bridge, hard-refresh HQ, reproduce, then fetch bundle again."
        )
    elif not has_lines:
        capture_hint = (
            "HUD is on but client_log is empty. Hard-refresh HQ, reproduce the issue, then fetch bundle again."
        )

    server_by_rid = {e.get("request_id"): e for e in server_errs if isinstance(e, dict) and e.get("request_id")}

    top_issues: list[str] = []
    for row in server_errs[:AGENT_TOP_ISSUES_MAX]:
        if not isinstance(row, dict):
            continue
        rid = row.get("request_id")
        line = f"Server {row.get('path_category') or row.get('subsystem')} {row.get('status')} {row.get('code') or row.get('type')}"
        if rid:
            line += f" #{rid}"
        top_issues.append(line[:240])

    if len(top_issues) < AGENT_TOP_ISSUES_MAX:
        for row in reversed(client_lines):
            if len(top_issues) >= AGENT_TOP_ISSUES_MAX:
                break
            if not isinstance(row, dict):
                continue
            sev = _client_row_severity(row.get("level"))
            kind = row.get("kind")
            if sev == "info" and kind not in ("api", "error"):
                continue
            rid = row.get("request_id")
            msg = str(row.get("message") or "")[:160]
            line = f"Client [{row.get('view') or '?'}] {msg}"
            if rid:
                line += f" #{rid}"
                if rid in server_by_rid:
                    line += " ↔ server"
            top_issues.append(line[:240])

    for name, chk in degraded.items():
        if len(top_issues) >= AGENT_TOP_ISSUES_MAX:
            break
        if not isinstance(chk, dict):
            continue
        if chk.get("status") in ("ok", "not_configured"):
            continue
        detail = chk.get("detail") or chk.get("note") or name
        top_issues.append(f"Readiness {name}: {chk.get('status')} — {detail}"[:240])

    for row in repro_notes[-2:]:
        if len(top_issues) >= AGENT_TOP_ISSUES_MAX:
            break
        if isinstance(row, dict) and row.get("note"):
            top_issues.append(f"Repro note: {row.get('note')}"[:240])

    last_lag_spikes = collect_last_lag_spikes(client_lines)
    if last_lag_spikes:
        latest = last_lag_spikes[-1]
        age = _minutes_since_utc_iso(latest.get("at"))
        if age is not None and age <= LAG_SPIKE_RECENT_MINUTES:
            line = f"Lag spike {age:.0f}m ago: {latest.get('reason') or 'lag'}"
            if latest.get("screenshot_rel"):
                line += f" · {latest.get('screenshot_rel')}"
            top_issues.insert(0, line[:240])

    slowest: list[dict] = []
    for row in client_lines:
        if not isinstance(row, dict) or row.get("kind") != "perf-mark":
            continue
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        try:
            ms = float(data.get("ms") if data.get("ms") is not None else 0)
        except (TypeError, ValueError):
            ms = 0.0
        slowest.append(
            {
                "at": row.get("at"),
                "view": row.get("view"),
                "subsystem": data.get("subsystem"),
                "op": data.get("op"),
                "ms": ms,
                "path": data.get("path"),
            }
        )
    slowest.sort(key=lambda x: (-(x.get("ms") or 0), _at_sort_key(x.get("at"))))
    slowest = slowest[:AGENT_SLOWEST_MARKS_MAX]

    degraded_now: list[str] = []
    for name, chk in degraded.items():
        if not isinstance(chk, dict):
            continue
        if chk.get("status") in ("ok", "not_configured"):
            continue
        detail = chk.get("detail") or chk.get("note") or ""
        degraded_now.append(f"{name}: {chk.get('status')} — {detail}"[:200])

    likely, reason = _score_likely_subsystem(
        client_lines=client_lines,
        server_errs=server_errs,
        degraded=degraded,
        last_view=last_view,
    )
    code_hints = build_error_code_hints(server_errs)

    recommended = list(SUBSYSTEM_FILE_HINTS.get(likely or "", []))[:8] if likely else []
    companion_hint, companion_files = _companion_accueil_lag_hint(client_lines)
    if companion_hint:
        if len(top_issues) < AGENT_TOP_ISSUES_MAX:
            top_issues.insert(0, companion_hint[:240])
        for fp in companion_files:
            if fp not in recommended:
                recommended.append(fp)
        if likely in (None, "bridge"):
            likely = "companion"
            reason = "perf-mark companion live2d-frame on accueil"

    return {
        "capture_ok": capture_ok,
        "capture_hint": capture_hint,
        "capture_effective": {
            "hud_enabled": hud,
            "agent_mode": bool(cap.get("agent_mode")),
            "perf_interval_sec": cap.get("perf_interval_sec"),
            "source": cap.get("source") or "config",
        },
        "likely_subsystem": likely,
        "likely_subsystem_reason": reason,
        "top_issues": top_issues[:AGENT_TOP_ISSUES_MAX],
        "slowest_marks": slowest,
        "degraded_now": degraded_now,
        "view_context": _view_context_from_client(client_lines, last_view),
        "error_code_hints": code_hints,
        "recommended_files": recommended[:8],
        "last_lag_spikes": last_lag_spikes,
    }


def _assert_agent_triage_shape(triage: dict) -> None:
    missing = AGENT_TRIAGE_KEYS - set(triage.keys())
    if missing:
        raise ValueError(f"agent_triage missing keys: {sorted(missing)}")


def _assert_timeline_shape(events: list[dict]) -> None:
    for i, ev in enumerate(events):
        if not isinstance(ev, dict):
            raise ValueError(f"timeline[{i}] is not a dict")
        missing = AGENT_TIMELINE_EVENT_KEYS - set(ev.keys())
        if missing:
            raise ValueError(f"timeline[{i}] missing keys: {sorted(missing)}")


def render_agent_brief_md(
    *,
    triage: dict,
    timeline: list[dict],
    readiness_status: Any,
    last_client_view: str | None,
    identity: dict | None = None,
) -> str:
    lines = ["# HQ agent brief", ""]
    ident = identity or {}
    ver = ident.get("version") or "?"
    sha = ident.get("build_sha") or "?"
    lines.append(f"Version **{ver}** · build `{sha}` · readiness **{readiness_status}** · view **{last_client_view or '—'}**")
    lines.append("")
    if triage.get("capture_hint"):
        lines.append(f"**Capture:** {triage['capture_hint']}")
        lines.append("")
    sub = triage.get("likely_subsystem")
    if sub:
        lines.append(f"**Likely subsystem:** `{sub}` ({triage.get('likely_subsystem_reason') or ''})")
        rec = triage.get("recommended_files") or []
        if rec:
            lines.append("**Files to inspect first:** " + ", ".join(f"`{x}`" for x in rec))
        lines.append("")
    issues = triage.get("top_issues") or []
    if issues:
        lines.append("## Top issues")
        for item in issues:
            lines.append(f"- {item}")
        lines.append("")
    degraded = triage.get("degraded_now") or []
    if degraded:
        lines.append("## Degraded readiness")
        for item in degraded:
            lines.append(f"- {item}")
        lines.append("")
    marks = triage.get("slowest_marks") or []
    if marks:
        lines.append("## Slowest perf-mark")
        for m in marks:
            ms = m.get("ms")
            lines.append(
                f"- `{m.get('subsystem')}` `{m.get('op')}` {ms}ms"
                + (f" view={m.get('view')}" if m.get("view") else "")
            )
        lines.append("")
    codes = triage.get("error_code_hints") or []
    if codes:
        lines.append("## Server error codes (tail)")
        for c in codes:
            lines.append(f"- `{c.get('code')}` ×{c.get('count')} — {c.get('hint')}")
        lines.append("")
    nav = (triage.get("view_context") or {}).get("recent_nav") or []
    if nav:
        lines.append("## Recent navigation")
        for n in nav:
            fr, to = n.get("from"), n.get("to")
            op = n.get("op") or "view"
            ms = n.get("ms")
            extra = f" {ms}ms" if ms not in (None, 0, 0.0) else ""
            lines.append(f"- {op}: {fr or '—'} → {to or '?'}{extra}")
        lines.append("")
    lag_spikes = triage.get("last_lag_spikes") or []
    if lag_spikes:
        lines.append("## Lag spikes (tail)")
        for sp in lag_spikes[-5:]:
            shot = sp.get("screenshot_rel") or "—"
            lines.append(
                f"- `{sp.get('at')}` **{sp.get('reason') or 'lag'}** view={sp.get('view') or '—'} · `{shot}`"
            )
        lines.append("")
    if timeline:
        lines.append("## Timeline (tail)")
        for ev in timeline[-12:]:
            lines.append(f"- `{ev.get('at')}` **{ev.get('source')}** {ev.get('summary')}")
        lines.append("")
    lines.append("Full JSON: `GET /api/diag/agent-brief` · `GET /api/diag/session-bundle` · Playbook: `docs/agent-debugging.md` · Symptoms: `docs/hq-symptom-index.md`")
    return "\n".join(lines)


def session_bundle(
    *,
    root: Any,
    config: dict,
    config_path: Any,
    asset_names: list[str],
    limit: int = 50,
    capture_effective: dict | None = None,
    session_id: str | None = None,
) -> dict:
    """Single JSON snapshot for agents: client tail, server errors, degraded readiness, request_id index."""
    return _assemble_session_snapshot(
        root=root,
        config=config,
        config_path=config_path,
        asset_names=asset_names,
        limit=limit,
        capture_effective=capture_effective,
        session_id=session_id,
    )


def _assemble_session_snapshot(
    *,
    root: Any,
    config: dict,
    config_path: Any,
    asset_names: list[str],
    limit: int,
    capture_effective: dict | None,
    session_id: str | None = None,
) -> dict:
    lim = max(1, min(int(limit), CLIENT_LOG_RING_MAX))
    sid = normalize_client_session_id(session_id)
    ident = identity(root)
    ready = readiness(root=root, config=config, config_path=config_path, asset_names=asset_names, voice_mod=None)
    checks = ready.get("checks") or {}
    degraded = {k: v for k, v in checks.items() if isinstance(v, dict) and v.get("status") not in ("ok", "not_configured")}
    client_lines = CLIENT_LOG.tail(lim, session_id=sid)
    client_summary = CLIENT_LOG.summary()
    server_errs = ERRORS.recent(lim, include_trace=False)
    repro_notes = repro_notes_recent(root, min(lim, 30))
    rids: list[str] = []
    for row in client_lines + server_errs:
        rid = row.get("request_id")
        if isinstance(rid, str) and rid:
            rids.append(rid)
    last_view = None
    for row in reversed(client_lines):
        v = row.get("view")
        if isinstance(v, str) and v:
            last_view = v
            break
    triage = build_agent_triage(
        client_lines=client_lines,
        server_errs=server_errs,
        degraded=degraded,
        repro_notes=repro_notes,
        client_summary=client_summary,
        last_view=last_view,
        capture_effective=capture_effective,
    )
    _assert_agent_triage_shape(triage)
    timeline = build_agent_timeline(
        client_lines=client_lines,
        server_errs=server_errs,
        repro_notes=repro_notes,
    )
    config_eff = build_config_effective(config, capture_effective)
    rid_index = build_request_id_index(client_lines, server_errs)
    identity_block = {
        "build_sha": ident.get("build_sha"),
        "checkout_sha": ident.get("checkout_sha"),
        "started_at_utc": ident.get("started_at_utc"),
        "version": ident.get("version"),
    }
    return {
        "generated_at": _utc_iso(),
        "redaction": REDACTION_CONTRACT,
        "identity": identity_block,
        "readiness_status": ready.get("status"),
        "readiness_degraded": degraded,
        "last_client_view": last_view,
        "agent_triage": triage,
        "timeline": timeline,
        "config_effective": config_eff,
        "request_id_index": rid_index,
        "client_log": client_lines,
        "client_log_summary": client_summary,
        "repro_notes": repro_notes,
        "server_errors": server_errs,
        "server_errors_summary": ERRORS.summary(),
        "request_ids": sorted(set(rids))[:80],
        "agent_packet_disk": agent_packet_disk_hint(root),
        "session_filter": sid,
        "lag_capture_files": list_lag_capture_files(root),
    }


def agent_brief(
    *,
    root: Any,
    config: dict,
    config_path: Any,
    asset_names: list[str],
    limit: int = 50,
    capture_effective: dict | None = None,
    session_id: str | None = None,
) -> dict:
    """Compact agent snapshot: triage + timeline + pasteable markdown (no full client_log)."""
    snap = _assemble_session_snapshot(
        root=root,
        config=config,
        config_path=config_path,
        asset_names=asset_names,
        limit=limit,
        capture_effective=capture_effective,
        session_id=session_id,
    )
    triage = snap.get("agent_triage") or {}
    timeline = snap.get("timeline") or []
    identity = snap.get("identity") or {}
    config_eff = snap.get("config_effective") or build_config_effective(config, capture_effective)
    rid_index = snap.get("request_id_index") or {}
    brief_md = render_agent_brief_md(
        triage=triage,
        timeline=timeline,
        readiness_status=snap.get("readiness_status"),
        last_client_view=snap.get("last_client_view"),
        identity=identity,
    )
    packet_md = render_agent_packet_md(
        brief_md=brief_md,
        request_id_index=rid_index,
        config_effective=config_eff,
    )
    out = {
        "generated_at": snap.get("generated_at"),
        "identity": identity,
        "readiness_status": snap.get("readiness_status"),
        "last_client_view": snap.get("last_client_view"),
        "request_ids": snap.get("request_ids") or [],
        "request_id_index": rid_index,
        "config_effective": config_eff,
        "agent_triage": triage,
        "timeline": timeline,
        "brief_md": brief_md,
        "packet_md": packet_md,
        "playbook": "docs/agent-debugging.md",
        "symptom_index": "docs/hq-symptom-index.md",
        "error_codes_doc": "docs/hq-error-codes.md",
        "subsystem_map": SUBSYSTEM_AGENT_MAP,
        "agent_playbook_steps": list(AGENT_PLAYBOOK_STEPS),
        "agent_packet_disk": agent_packet_disk_hint(root),
    }
    missing = AGENT_BRIEF_KEYS - set(out.keys())
    if missing:
        raise ValueError(f"agent_brief missing keys: {sorted(missing)}")
    return out


def persist_agent_packet_from_snapshot(
    *,
    root: Any,
    config: dict,
    config_path: Any,
    asset_names: list[str],
    limit: int = 50,
    capture_effective: dict | None = None,
    session_id: str | None = None,
) -> dict:
    """Write agent-packet-latest.md from current brief (after lag spike or manual save)."""
    brief = agent_brief(
        root=root,
        config=config,
        config_path=config_path,
        asset_names=asset_names,
        limit=limit,
        capture_effective=capture_effective,
        session_id=session_id,
    )
    md = brief.get("packet_md") or brief.get("brief_md") or ""
    rep = write_agent_packet_file(root, md)
    if rep.get("ok"):
        rep["agent_packet_disk"] = agent_packet_disk_hint(root)
    return rep


def record_startup_fatal(root: Any, message: Any) -> None:
    """A startup abort (e.g. malformed ``bridge_config.json``) otherwise lives only in a hidden console. Write ONE short scrubbed
    line to ``<root>/hq-startup-error.txt`` (overwritten, ≤ 600 bytes). Never raises."""
    try:
        text = scrub(message, root, limit=500)
        with open(os.path.join(os.fspath(root), STARTUP_FATAL_NAME), "w", encoding="utf-8") as fh:
            fh.write(f"{_utc_iso()} {text}\n")
    except Exception:
        pass


def startup_fatal(root: Any) -> dict | None:
    try:
        p = os.path.join(os.fspath(root), STARTUP_FATAL_NAME)
        if not os.path.isfile(p) or _islink(p):
            return None
        with open(p, "r", encoding="utf-8", errors="replace") as fh:
            txt = fh.read(700).strip()
        return {"at": txt[:20], "message": scrub(txt[21:], root, limit=300)}
    except Exception:
        return None


# ---------------------------------------------------------------- backup observability

def _label_dir(raw: str) -> str:
    """Drive + leaf only, e.g. ``D:/…/Transfert`` — enough to recognise, not a full path."""
    s = raw.replace("\\", "/").rstrip("/")
    m = re.match(r"^([A-Za-z]:)/(?:.*/)?([^/]+)$", s)
    if m:
        return f"{m.group(1)}/…/{m.group(2)}" if s.count("/") > 1 else s
    leaf = s.rsplit("/", 1)[-1] if s else ""
    return "…/" + leaf if leaf else ""


def _dir_size(path: str) -> tuple[int, bool]:
    total, n, truncated = 0, 0, False
    deadline = time.time() + BACKUP_WALK_MAX_SECONDS
    for dp, dn, fn in os.walk(path, followlinks=False):
        for f in fn:
            n += 1
            if n > BACKUP_WALK_MAX_FILES or time.time() > deadline:
                return total, True
            try:
                total += os.lstat(os.path.join(dp, f)).st_size
            except OSError:
                pass
    return total, truncated


def parse_stamp(name: str) -> float | None:
    try:
        return datetime.strptime(name, "%Y%m%d_%H%M%S").timestamp()
    except ValueError:
        return None


def _sha256_file(path: str, limit: int = 2 * 1024 * 1024 * 1024) -> str | None:
    import hashlib

    h = hashlib.sha256()
    try:
        if os.stat(path).st_size > limit:
            return None
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def parse_hash_file(path: str) -> dict[str, str] | None:
    """``<hex>  <name>`` lines (sha256sum / HASHES.sha256 style). ``None`` if unreadable or no valid line."""
    try:
        out: dict[str, str] = {}
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                m = re.match(r"^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$", line)
                if m:
                    out[m.group(2).replace("\\", "/").lstrip("./")] = m.group(1).lower()
        return out or None
    except OSError:
        return None


def backup_report(*, config: Any, root: Any, verify: bool = False, now: float | None = None) -> dict:
    """What can be said about backups without trusting file existence alone. ``verified`` is ``not_run`` unless ``verify``."""
    now = time.time() if now is None else now
    cfg = config if isinstance(config, dict) else {}
    raw = str(cfg.get("backup_dir") or "")
    try:
        every_h = float(cfg.get("backup_every_hours") or 24)
    except (TypeError, ValueError):
        every_h = 24.0
    stale_after = max(BACKUP_STALE_MIN_HOURS, 1.5 * every_h)
    rep: dict[str, Any] = {
        "status": "unavailable", "detail": "", "dir_label": _label_dir(raw) if raw else "",
        "stale_after_hours": stale_after, "auto_paused": bool(cfg.get("backup_auto_paused")),
        "latest": None, "recent_count": 0, "verified": "not_run", "checksum_available": False,
        "deployment_backups": deployment_backups(root, verify=verify), "checked_at": _utc_iso(now),
        "note": "The legacy backup writes no checksum or rollback-SHA file; recency is judged from the folder timestamp only.",
    }
    if not raw:
        rep.update(status="not_configured", detail="backup_dir_not_set")
        return rep
    if not os.path.isdir(raw):
        rep.update(status="unavailable", detail="backup_dir_missing")
        return rep
    try:
        stamps = sorted((e.name for e in os.scandir(raw) if e.is_dir(follow_symlinks=False) and BACKUP_STAMP_RE.match(e.name)), reverse=True)
    except OSError:
        rep.update(status="unavailable", detail="backup_dir_unreadable")
        return rep
    rep["recent_count"] = len(stamps)
    if not stamps:
        rep.update(status="degraded", detail="no_backups_found")
        return rep
    latest = stamps[0]
    p = os.path.join(raw, latest)
    ts = parse_stamp(latest)
    size, trunc = _dir_size(p)
    try:
        names = set(os.listdir(p))
    except OSError:
        names = set()
    carnet_dir = os.path.join(p, "Carnet")
    carnet_nb = os.path.join(carnet_dir, "notebook.json")
    hash_files = sorted(n for n in names if n.lower().endswith(".sha256") or n.upper() in ("SHA256.TXT", "HASHES.SHA256"))
    rep["checksum_available"] = bool(hash_files)
    age_h = (now - ts) / 3600.0 if ts is not None else None
    rep["latest"] = {
        "id": latest, "age_hours": round(age_h, 1) if age_h is not None else None, "size_bytes": size, "size_truncated": trunc,
        "has_readme_marker": "README.txt" in names, "carnet_included": os.path.isfile(carnet_nb),
        "checksum_files": hash_files[:3],
    }
    if age_h is None:
        rep.update(status="degraded", detail="timestamp_unparseable")
    elif age_h > stale_after:
        rep.update(status="degraded", detail="backup_stale")
    elif age_h < -1:
        rep.update(status="degraded", detail="timestamp_in_future")
    else:
        rep.update(status="ok", detail="recent_backup_present")
    if verify:
        res: dict[str, Any] = {"carnet_notebook": "absent"}
        if os.path.isfile(carnet_nb):
            res["carnet_notebook"] = _read_json_file_status(carnet_nb)["detail"]
        res["checksums"] = "not_available"
        if hash_files:
            table = parse_hash_file(os.path.join(p, hash_files[0]))
            if table is None:
                res["checksums"] = "hash_file_unparseable"
            else:
                bad = 0
                for rel, want in table.items():
                    target = os.path.normpath(os.path.join(p, *rel.split("/")))
                    if not target.startswith(os.path.normpath(p) + os.sep):
                        bad += 1
                        continue
                    got = _sha256_file(target)
                    if got != want:
                        bad += 1
                res["checksums"] = "mismatch" if bad else "match"
                res["checked_files"] = len(table)
        rep["verified"] = res
        if res["carnet_notebook"] in ("json_corrupt", "unreadable") or res["checksums"] in ("mismatch", "hash_file_unparseable"):
            rep["status"] = "error"
            rep["detail"] = "verification_failed"
    return rep


def deployment_backups(root: Any, *, verify: bool = False) -> dict:
    """The operator's pre-deploy rollback folders ``<root>/_backup_pre-<sha7>_<stamp>``: name, whether ``ROLLBACK-SHA.txt`` parses,
    which expected members exist. Hash verification only when ``verify``. Contents are never returned."""
    r = os.fspath(root)
    out: dict[str, Any] = {"count": 0, "latest": None}
    try:
        names = sorted((e.name for e in os.scandir(r) if e.is_dir(follow_symlinks=False) and e.name.startswith(DEPLOY_BACKUP_PREFIX)), reverse=True)
    except OSError:
        out["detail"] = "root_unreadable"
        return out
    out["count"] = len(names)
    if not names:
        out["detail"] = "none_found"
        return out
    newest = max(names, key=lambda n: _mtime(os.path.join(r, n)))
    p = os.path.join(r, newest)
    info: dict[str, Any] = {"name": newest, "rollback_sha": None, "members": {}}
    try:
        members = set(os.listdir(p))
    except OSError:
        members = set()
    for want in ("ROLLBACK-SHA.txt", "SHA256.txt", "hq-carnet-data.tar.gz", "tracked-worktree-as-deployed.tar.gz"):
        info["members"][want] = want in members
    rs = os.path.join(p, "ROLLBACK-SHA.txt")
    if os.path.isfile(rs):
        try:
            with open(rs, "r", encoding="utf-8", errors="replace") as fh:
                val = fh.readline().strip().lower()
            info["rollback_sha"] = val if SHA_RE.match(val) else None
            info["rollback_sha_valid"] = bool(SHA_RE.match(val))
        except OSError:
            info["rollback_sha_valid"] = False
    else:
        info["rollback_sha_valid"] = False
    if verify and "SHA256.txt" in members:
        table = parse_hash_file(os.path.join(p, "SHA256.txt"))
        if table is None:
            info["hashes"] = "hash_file_unparseable"
        else:
            bad = 0
            for rel, want in table.items():
                target = os.path.normpath(os.path.join(p, *rel.split("/")))
                if not target.startswith(os.path.normpath(p) + os.sep) or _sha256_file(target) != want:
                    bad += 1
            info["hashes"] = "mismatch" if bad else "match"
            info["checked_files"] = len(table)
    elif verify:
        info["hashes"] = "not_available"
    out["latest"] = info
    return out


def _mtime(p: str) -> float:
    try:
        return os.stat(p).st_mtime
    except OSError:
        return 0.0
