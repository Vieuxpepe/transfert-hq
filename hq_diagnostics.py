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
STARTUP_FATAL_NAME = "hq-startup-error.txt"
RING_MAX = 100
LOG_ROTATE_BYTES = 128 * 1024
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
               status: int | None = None, request_id: str | None = None, code: str | None = None) -> str:
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
            entry = {
                "at": _utc_iso(),
                "subsystem": re.sub(r"[^A-Za-z0-9_./-]", "", str(subsystem))[:40] or "unknown",
                "type": etype,
                "message": scrub(msg, self._root),
                "path_category": path_category(path),
                "status": int(status) if isinstance(status, int) else None,
                "request_id": rid,
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
