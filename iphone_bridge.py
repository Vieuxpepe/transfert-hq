#!/usr/bin/env python3
"""Transfert HQ v7 — Mission Control (stdlib HTTP, local JSON state)."""

from __future__ import annotations

import ctypes
import hashlib
import hmac
import html
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zlib
from datetime import datetime
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

import cc_ext
import hq_automation
import hq_devices
import hq_events

PORT = 8765
ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "bridge_config.json"
PID_PATH = ROOT / "bridge.pid"
TMP_DIR = ROOT / ".tmp"
DEFAULT_MAX_UPLOAD_MB = 102400  # 100 Go
SESSION_TTL_SEC = 60 * 60 * 24 * 7  # 7 days (was 30)
LOGIN_BODY_MAX = 16 * 1024
UPLOAD_TTL_SEC = 6 * 3600
LOOPBACK_ONLY = False  # legacy flag; PIN is mandatory at startup (fail closed)
BIND_HOST = "0.0.0.0"
REQ_TIMEOUT_SEC = 30
REQ_SEM_MAX = 64

# Active content must never execute on the HQ origin
FORCE_ATTACHMENT_EXTS = {".html", ".htm", ".svg", ".xml", ".js", ".mjs", ".xhtml"}

# upload role: explicit allowlist (everything else = 403)
UPLOAD_GET_EXACT = {
    "/", "/login", "/logout", "/manifest.webmanifest",
    "/icon-192.png", "/icon-512.png", "/wallboard",
    "/api/me",
    "/api/upload/status",
}
UPLOAD_GET_PREFIX = ("/assets/",)
UPLOAD_POST_EXACT = {
    "/login", "/logout",
    "/api/me", "/api/presence",
    "/api/upload",
    "/api/upload/init", "/api/upload/chunk", "/api/upload/complete",
}
UPLOAD_POST_PREFIX = ()
COOKIE_NAME = "transfert_session"
DEFAULT_FOLDERS = ["Inbox", "Uni", "Print"]
TEXT_EDIT_EXTS = {
    ".txt", ".md", ".csv", ".json", ".log", ".py", ".css", ".js",
    ".html", ".htm", ".xml", ".yml", ".yaml", ".ini", ".cfg", ".srt",
}
CHUNK = 1024 * 1024
PRESENCE_TTL_SEC = 90
PRESENCE_ID_MAX = 128
PRESENCE_MAX_ENTRIES = 64
TRANSFER_HISTORY = 40
LIST_LIMIT_DEFAULT = 50
LIST_LIMIT_MAX = 100
LIST_OFFSET_MAX = 1000
UPLOAD_SESSIONS_MAX = 32
UPLOAD_DISK_RESERVE_GB_DEFAULT = 2.0
# CSRF / QR: optional public_base_urls in bridge_config.json (Serve HTTPS bases).
# Never put PIN, session cookies, or tokens in QR payloads or public_base_urls.

SYSTEM_NAMES = {
    "iphone_bridge.py",
    "cc_ext.py",
    "readme.txt",
    "third_party.txt",
    "start-iphone-upload.bat",
    "enable-openssh-server.bat",
    "authorize-hq-ssh-key.bat",
    "fix-ssh-key-on-remote-pc.bat",
    "fix-ssh-key-on-remote-pc.ps1",
    "fix-ssh-key-payload.ps1",
    "hq_ssh.pub",
    "bridge_config.json",
    "install_autostart.ps1",
    "start_bridge_hidden.vbs",
    "bridge.pid",
    "iphone upload (transfert).bat",
    "bridge_stdout.log",
    "bridge_stderr.log",
    "bridge_queue.json",
    "bridge_transfers.json",
    "bridge_activity.json",
    "scratchpad.txt",
    "kanban.json",
    "bridge_presence_history.json",
    "bridge_sessions.json",
    "bridge_screenshot_ingest.json",
    "hq_events.py",
    "hq_automation.py",
    "hq_devices.py",
    "hq_events.json",
    "hq_automation.json",
    "hq_runs.json",
    "hq_telemetry.json",
    "hq_backup_index.json",
    "hq_push_subscriptions.json",
    "hq_vapid.json",
    ".gitignore",
    ".tmp",
}

_SESSIONS: dict[str, dict] = {}  # token -> {exp, role, user}
_SESSIONS_LOCK = threading.Lock()
SESSIONS_PATH = ROOT / "bridge_sessions.json"
_CONFIG_LOCK = threading.Lock()
_PRESENCE: dict[str, dict] = {}
_PRESENCE_LOCK = threading.Lock()
_TRANSFERS: list[dict] = []
_TRANSFERS_LOCK = threading.Lock()
_STARTED_AT = time.time()
UPLOAD_SESSIONS: dict[str, dict] = {}
UPLOAD_SESSIONS_LOCK = threading.Lock()
CLIENT_CHUNK = 2 * 1024 * 1024

# Legacy denylist kept only as documentation; enforcement is UPLOAD_* allowlists.
ADMIN_PREFIXES = (
    "/api/pc/",
    "/api/clipboard/pc",
    "/api/scene",
    "/api/queue",
    "/api/terminal",
    "/api/shell",
    "/api/backup",
    "/api/inbox-zero",
    "/api/captures",
    "/api/print",
    "/api/hq",
    "/api/events",
    "/api/device",
    "/api/palette",
    "/api/automation",
    "/api/runs",
    "/api/backups",
    "/api/telemetry",
    "/api/brief",
    "/api/push",
    "/api/schedules",
)

_LOGIN_FAILS: dict[str, list[float]] = {}
_LOGIN_FAILS_LOCK = threading.Lock()
_REQ_SEM = threading.Semaphore(REQ_SEM_MAX)


def default_auto_route() -> dict:
    return {
        ".jpg": "Inbox/Photos",
        ".jpeg": "Inbox/Photos",
        ".png": "Inbox/Photos",
        ".heic": "Inbox/Photos",
        ".heif": "Inbox/Photos",
        ".webp": "Inbox/Photos",
        ".gif": "Inbox/Photos",
        ".pdf": "Uni",
        ".doc": "Uni",
        ".docx": "Uni",
        ".ppt": "Uni",
        ".pptx": "Uni",
        ".stl": "Print",
        ".3mf": "Print",
        ".obj": "Print",
    }


def default_actions() -> list[dict]:
    actions = [
        {"id": "open-transfert", "label": "Ouvrir Transfert", "type": "explore", "path": str(ROOT)},
        {"id": "open-inbox", "label": "Ouvrir Inbox", "type": "explore", "path": str(ROOT / "Inbox")},
        {"id": "open-uni", "label": "Ouvrir Uni", "type": "explore", "path": str(ROOT / "Uni")},
        {"id": "open-print", "label": "Ouvrir Print", "type": "explore", "path": str(ROOT / "Print")},
        {"id": "open-captures", "label": "Captures d'écran", "type": "explore", "path": str(ROOT / "Inbox" / "Captures")},
    ]
    # optional CAD shortcuts if present
    for label, path in (
        ("SolidWorks Projects", Path(r"D:\CAD\SolidWorks\Projects")),
        ("Hybrid repo", Path(r"D:\Dev\Experiments\ChatGPT_Cursor_Hybrid-desktop-control")),
    ):
        if path.exists():
            actions.append(
                {
                    "id": "open-" + label.lower().replace(" ", "-")[:24],
                    "label": label,
                    "type": "explore",
                    "path": str(path),
                }
            )
    return actions


def default_scenes() -> list[dict]:
    return cc_ext.default_scenes() if ROOT else []

def parse_multipart(body: bytes, content_type: str) -> list[tuple[str, str | None, bytes]]:
    m = re.search(r"boundary=([^;]+)", content_type, flags=re.I)
    if not m:
        return []
    boundary = m.group(1).strip().strip('"').encode()
    out: list[tuple[str, str | None, bytes]] = []
    for part in body.split(b"--" + boundary):
        if not part or part.startswith(b"--"):
            continue
        if part.startswith(b"\r\n"):
            part = part[2:]
        if part.endswith(b"\r\n"):
            part = part[:-2]
        if b"\r\n\r\n" not in part:
            continue
        head, payload = part.split(b"\r\n\r\n", 1)
        if payload.endswith(b"\r\n"):
            payload = payload[:-2]
        header_text = head.decode("utf-8", errors="replace")
        name_m = re.search(r'name="([^"]+)"', header_text, flags=re.I)
        if not name_m:
            continue
        file_m = re.search(r'filename="([^"]*)"', header_text, flags=re.I)
        out.append((name_m.group(1), file_m.group(1) if file_m else None, payload))
    return out


def max_upload_bytes() -> int:
    try:
        mb = int(CONFIG.get("max_upload_mb") or DEFAULT_MAX_UPLOAD_MB)
    except (TypeError, ValueError):
        mb = DEFAULT_MAX_UPLOAD_MB
    return max(1, mb) * 1024 * 1024


def human_size(n: int) -> str:
    if n < 1024:
        return f"{n} o"
    if n < 1024**2:
        return f"{n / 1024:.1f} Ko"
    if n < 1024**3:
        return f"{n / 1024**2:.1f} Mo"
    return f"{n / 1024**3:.2f} Go"


def receive_body_to_temp(rfile, length: int, limit: int) -> Path:
    """Stream request body to disk (not RAM)."""
    if length <= 0:
        raise ValueError("Content-Length manquant")
    if length > limit:
        raise ValueError(f"Envoi trop gros (max {human_size(limit)})")
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="up_", suffix=".bin", dir=str(TMP_DIR))
    path = Path(name)
    try:
        with os.fdopen(fd, "wb") as out:
            left = length
            while left > 0:
                chunk = rfile.read(min(CHUNK, left))
                if not chunk:
                    break
                out.write(chunk)
                left -= len(chunk)
        if left != 0:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
            raise ValueError("Corps de requête tronqué")
        return path
    except Exception:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def looks_like_screenshot(filename: str) -> bool:
    """Detect common screenshot filenames (Windows / macOS / Android / FR)."""
    name = Path(filename or "").name
    stem = name.rsplit(".", 1)[0] if "." in name else name
    n = stem.lower().replace("_", " ").replace("-", " ")
    n = re.sub(r"\s+", " ", n).strip()
    needles = (
        "screenshot",
        "screen shot",
        "screen capture",
        "capture d'ecran",
        "capture d ecran",
        "capture decran",
        "captures d'ecran",
        "cleanshot",
        "snipping",
        "snip ",
        "grab",
    )
    # normalize accents lightly
    flat = (
        n.replace("é", "e")
        .replace("è", "e")
        .replace("ê", "e")
        .replace("à", "a")
        .replace("'", " ")
        .replace("’", " ")
    )
    flat = re.sub(r"\s+", " ", flat).strip()
    if any(x in flat for x in needles):
        return True
    if flat.startswith("screenshot"):
        return True
    if re.match(r"^capture(s)?( d ecran)?( \d+)?$", flat):
        return True
    # Android: Screenshot_20240101-120000
    if re.match(r"^screenshot[_\s]?\d", Path(filename).stem.lower()):
        return True
    return False


def captures_dir() -> Path:
    d = ROOT / "Inbox" / "Captures"
    d.mkdir(parents=True, exist_ok=True)
    return d


def apply_auto_route(folder_rel: str, filename: str) -> str:
    """Remap uploads: screenshots -> Inbox/Captures; else extension auto_route on root folders."""
    if looks_like_screenshot(filename):
        return "Inbox/Captures"
    parts = [p for p in (folder_rel or "").replace("\\", "/").strip("/").split("/") if p]
    # already in Captures / Screenshots — keep
    if len(parts) >= 2 and parts[0] == "Inbox" and parts[1].lower() in ("captures", "screenshots"):
        return "Inbox/Captures"
    if len(parts) != 1:
        return folder_rel
    ext = Path(filename).suffix.lower()
    route = (CONFIG.get("auto_route") or {}).get(ext)
    if not route:
        return folder_rel
    return str(route).replace("\\", "/").strip("/")


def extract_multipart_files(tmp: Path, content_type: str, default_folder: str, limit: int) -> tuple[str, list[dict]]:
    """Parse multipart from a temp file via mmap; stream file parts to disk.
    Returns (folder_rel, [{rel, size, name}, ...]).
    """
    import mmap

    m = re.search(r"boundary=([^;]+)", content_type, flags=re.I)
    if not m:
        raise ValueError("boundary manquant")
    boundary = m.group(1).strip().strip('"').encode()
    delim = b"--" + boundary
    folder_rel = default_folder
    base_folder = default_folder
    dest_dir = resolve_writable_dir(folder_rel, create=True)
    if not dest_dir:
        raise ValueError("Dossier cible invalide")
    saved: list[dict] = []

    with tmp.open("rb") as f:
        if tmp.stat().st_size == 0:
            return folder_rel, saved
        with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            size = mm.size()
            pos = 0
            idx = mm.find(delim, pos)
            if idx < 0:
                return folder_rel, saved
            pos = idx + len(delim)
            if pos + 1 < size and mm[pos : pos + 2] == b"--":
                return folder_rel, saved
            if pos + 1 < size and mm[pos : pos + 2] == b"\r\n":
                pos += 2

            while pos < size:
                header_end = mm.find(b"\r\n\r\n", pos)
                if header_end < 0:
                    break
                header_text = mm[pos:header_end].decode("utf-8", errors="replace")
                body_start = header_end + 4
                next_delim = mm.find(b"\r\n" + delim, body_start)
                if next_delim < 0:
                    body_end = size
                    next_pos = size
                else:
                    body_end = next_delim
                    next_pos = next_delim + 2 + len(delim)

                name_m = re.search(r'name="([^"]+)"', header_text, flags=re.I)
                file_m = re.search(r'filename="([^"]*)"', header_text, flags=re.I)
                field = name_m.group(1) if name_m else ""
                filename = file_m.group(1) if file_m else None
                part_len = max(0, body_end - body_start)

                if field == "folder" and not filename:
                    folder_rel = mm[body_start:body_end].decode("utf-8", errors="replace").strip() or folder_rel
                    base_folder = folder_rel
                    new_dir = resolve_writable_dir(folder_rel, create=True)
                    if not new_dir:
                        raise ValueError("Dossier cible invalide")
                    dest_dir = new_dir
                elif field == "files" and filename:
                    if part_len > limit:
                        raise ValueError(f"Fichier trop gros: {filename} ({human_size(part_len)})")
                    leaf = Path(filename).name
                    if leaf and leaf.lower() not in SYSTEM_NAMES:
                        target_rel = apply_auto_route(base_folder, leaf)
                        target_dir = resolve_writable_dir(target_rel, create=True)
                        if not target_dir:
                            raise ValueError("Dossier cible invalide")
                        dest = unique_in_dir(target_dir, leaf)
                        with dest.open("wb") as out:
                            offset = body_start
                            while offset < body_end:
                                out.write(mm[offset : min(offset + CHUNK, body_end)])
                                offset += CHUNK
                        rel = "/".join(dest.relative_to(ROOT).parts)
                        saved.append({"rel": rel, "size": part_len, "name": dest.name})

                if next_delim < 0:
                    break
                if next_pos + 1 < size and mm[next_pos : next_pos + 2] == b"--":
                    break
                if next_pos + 1 < size and mm[next_pos : next_pos + 2] == b"\r\n":
                    next_pos += 2
                pos = next_pos

    return folder_rel, saved


def default_config() -> dict:
    return {
        "pin": "",  # REQUIRED. Empty PIN refuses bridge startup (fail closed).
        "discord_webhook_url": "",
        "folders": list(DEFAULT_FOLDERS),
        "default_folder": "Inbox",
        "max_upload_mb": DEFAULT_MAX_UPLOAD_MB,
        "notify_min_upload_mb": 50,
        "auto_route": default_auto_route(),
        "actions": default_actions(),
        "favorites": [],
        "scenes": [],  # filled after ROOT-aware defaults in load_config
        "alert_disk_min_gb": 20,
        "backup_every_hours": 24,
        "backup_dir": "D:/Backups/Transfert",
        "users": [],  # optional: [{"name":"admin","pin":"...","role":"admin"},{"name":"phone","pin":"...","role":"upload"}]
        "terminal_commands": [],
        "shell_targets": [],
        "ssh_user": "",
        "shell_timeout_sec": 45,
        "disk_probe_enabled": True,
        "disk_probe_every_sec": 120,
        "disk_probe_timeout_sec": 12,
        "screenshot_ingest_enabled": True,
        "screenshot_ingest_every_sec": 5,
        "screenshot_ingest_max_age_sec": 90,
        "autostart": True,
        "public_base_urls": [],  # optional https://… bases (Tailscale Serve) for CSRF allowlist + QR
        "upload_sessions_max": UPLOAD_SESSIONS_MAX,
        "upload_disk_reserve_gb": UPLOAD_DISK_RESERVE_GB_DEFAULT,
        "automation_enabled": True,
        "schedules_enabled": True,
        "daily_brief_discord": False,  # brief Discord seulement si webhook ET ce flag
        "push_enabled": False,  # Web Push opt-in (HTTPS / Tailscale Serve)
        "telemetry_local_sec": 45,
        "telemetry_remote_sec": 180,
        "telemetry_retain_hours": 36,
        "created": datetime.now().isoformat(timespec="seconds"),
        "note": "Mission Control HQ v7. PIN required in bridge_config.json. public_base_urls optional (Serve HTTPS). Never commit PIN. push_enabled / daily_brief_discord restent off par défaut.",
    }


def load_config(*, write: bool = True) -> dict:
    """Load config. Malformed JSON aborts without overwriting the file."""
    base = default_config()
    existed = CONFIG_PATH.is_file()
    if existed:
        try:
            raw_txt = CONFIG_PATH.read_text(encoding="utf-8")
            data = json.loads(raw_txt)
        except json.JSONDecodeError as e:
            raise SystemExit(
                f"FATAL: bridge_config.json is malformed and will NOT be overwritten.\n"
                f"  Path: {CONFIG_PATH}\n  Error: {e}\n"
                f"Fix the JSON or restore a backup, then restart."
            ) from e
        except OSError as e:
            raise SystemExit(f"FATAL: cannot read bridge_config.json: {e}") from e
        if not isinstance(data, dict):
            raise SystemExit("FATAL: bridge_config.json must be a JSON object")
        base.update(data)
    if not base.get("folders"):
        base["folders"] = list(DEFAULT_FOLDERS)
    if base.get("default_folder") not in base["folders"]:
        base["default_folder"] = base["folders"][0]
    ar = dict(default_auto_route())
    if isinstance(base.get("auto_route"), dict):
        ar.update({str(k).lower(): v for k, v in base["auto_route"].items()})
    base["auto_route"] = ar
    if not isinstance(base.get("actions"), list) or not base["actions"]:
        base["actions"] = default_actions()
    if not isinstance(base.get("favorites"), list):
        base["favorites"] = []
    if not isinstance(base.get("public_base_urls"), list):
        base["public_base_urls"] = []
    else:
        cleaned_urls = []
        for u in base["public_base_urls"]:
            s = str(u or "").strip()
            if s:
                cleaned_urls.append(s)
        base["public_base_urls"] = cleaned_urls[:32]
    if not isinstance(base.get("scenes"), list) or not base["scenes"]:
        base["scenes"] = default_scenes() or cc_ext.default_scenes()
    try:
        base["alert_disk_min_gb"] = float(base.get("alert_disk_min_gb") or 20)
    except (TypeError, ValueError):
        base["alert_disk_min_gb"] = 20
    try:
        base["backup_every_hours"] = float(base.get("backup_every_hours") or 24)
    except (TypeError, ValueError):
        base["backup_every_hours"] = 24
    if not isinstance(base.get("users"), list):
        base["users"] = []
    if not isinstance(base.get("terminal_commands"), list) or not base["terminal_commands"]:
        base["terminal_commands"] = cc_ext.default_terminal_commands()
    if not isinstance(base.get("shell_targets"), list) or not base["shell_targets"]:
        base["shell_targets"] = cc_ext.default_shell_targets()
    if not isinstance(base.get("ssh_user"), str) or not str(base.get("ssh_user") or "").strip():
        base["ssh_user"] = os.environ.get("USERNAME") or os.environ.get("USER") or ""
    try:
        base["shell_timeout_sec"] = int(base.get("shell_timeout_sec") or 45)
    except (TypeError, ValueError):
        base["shell_timeout_sec"] = 45
    if "disk_probe_enabled" not in base:
        base["disk_probe_enabled"] = True
    else:
        base["disk_probe_enabled"] = bool(base.get("disk_probe_enabled"))
    try:
        base["disk_probe_every_sec"] = max(60, int(base.get("disk_probe_every_sec") or 120))
    except (TypeError, ValueError):
        base["disk_probe_every_sec"] = 120
    try:
        base["disk_probe_timeout_sec"] = max(5, min(60, int(base.get("disk_probe_timeout_sec") or 12)))
    except (TypeError, ValueError):
        base["disk_probe_timeout_sec"] = 12
    if "screenshot_ingest_enabled" not in base:
        base["screenshot_ingest_enabled"] = True
    else:
        base["screenshot_ingest_enabled"] = bool(base.get("screenshot_ingest_enabled"))
    try:
        base["screenshot_ingest_every_sec"] = max(3, min(120, int(base.get("screenshot_ingest_every_sec") or 5)))
    except (TypeError, ValueError):
        base["screenshot_ingest_every_sec"] = 5
    try:
        base["screenshot_ingest_max_age_sec"] = max(30, min(600, int(base.get("screenshot_ingest_max_age_sec") or 90)))
    except (TypeError, ValueError):
        base["screenshot_ingest_max_age_sec"] = 90
    try:
        base["upload_sessions_max"] = max(1, min(256, int(base.get("upload_sessions_max") or UPLOAD_SESSIONS_MAX)))
    except (TypeError, ValueError):
        base["upload_sessions_max"] = UPLOAD_SESSIONS_MAX
    try:
        base["upload_disk_reserve_gb"] = max(0.0, min(100.0, float(
            base.get("upload_disk_reserve_gb") if base.get("upload_disk_reserve_gb") is not None else UPLOAD_DISK_RESERVE_GB_DEFAULT
        )))
    except (TypeError, ValueError):
        base["upload_disk_reserve_gb"] = UPLOAD_DISK_RESERVE_GB_DEFAULT
    try:
        base["notify_min_upload_mb"] = int(base.get("notify_min_upload_mb") or 50)
    except (TypeError, ValueError):
        base["notify_min_upload_mb"] = 50
    base["automation_enabled"] = bool(base.get("automation_enabled", True))
    base["schedules_enabled"] = bool(base.get("schedules_enabled", True))
    base["daily_brief_discord"] = bool(base.get("daily_brief_discord"))
    base["push_enabled"] = bool(base.get("push_enabled"))
    try:
        base["telemetry_local_sec"] = max(30, min(60, int(base.get("telemetry_local_sec") or 45)))
    except (TypeError, ValueError):
        base["telemetry_local_sec"] = 45
    try:
        base["telemetry_remote_sec"] = max(120, min(600, int(base.get("telemetry_remote_sec") or 180)))
    except (TypeError, ValueError):
        base["telemetry_remote_sec"] = 180
    try:
        base["telemetry_retain_hours"] = max(24, min(48, int(base.get("telemetry_retain_hours") or 36)))
    except (TypeError, ValueError):
        base["telemetry_retain_hours"] = 36
    # Credential fingerprint → bump auth_generation when PIN/users change
    users = [u for u in (base.get("users") or []) if isinstance(u, dict)]
    cred = str(base.get("pin") or "") + "|" + "|".join(
        f"{u.get('name')}:{u.get('pin')}:{u.get('role')}" for u in users
    )
    fp = hashlib.sha256(cred.encode("utf-8")).hexdigest()[:24]
    try:
        gen = int(base.get("auth_generation") or 0)
    except (TypeError, ValueError):
        gen = 0
    if base.get("_auth_fp") != fp:
        gen += 1
        base["auth_generation"] = gen
        base["_auth_fp"] = fp
    else:
        base["auth_generation"] = gen
    if write:
        with _CONFIG_LOCK:
            CONFIG_PATH.write_text(json.dumps(base, indent=2) + "\n", encoding="utf-8")
    return base



CONFIG = load_config()


def save_config() -> None:
    with _CONFIG_LOCK:
        CONFIG_PATH.write_text(json.dumps(CONFIG, indent=2) + "\n", encoding="utf-8")


def ensure_folders_and_migrate() -> None:
    folders = list(CONFIG.get("folders") or DEFAULT_FOLDERS)
    for name in folders:
        (ROOT / name).mkdir(parents=True, exist_ok=True)
    (ROOT / "assets").mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    (ROOT / "Inbox" / "Photos").mkdir(parents=True, exist_ok=True)
    (ROOT / "Inbox" / "Captures").mkdir(parents=True, exist_ok=True)
    (ROOT / "Inbox" / "Voice").mkdir(parents=True, exist_ok=True)
    (ROOT / "Inbox" / "Screenshots").mkdir(parents=True, exist_ok=True)  # legacy alias folder
    # one-time: move legacy Screenshots files into Captures
    legacy = ROOT / "Inbox" / "Screenshots"
    dest_cap = ROOT / "Inbox" / "Captures"
    if legacy.is_dir():
        for p in list(legacy.iterdir()):
            if not p.is_file():
                continue
            target = dest_cap / p.name
            if target.exists():
                target = dest_cap / f"{p.stem}-from-screenshots{p.suffix}"
            try:
                p.rename(target)
            except OSError:
                pass
    inbox = ROOT / (CONFIG.get("default_folder") or "Inbox")
    for p in ROOT.iterdir():
        if not p.is_file():
            continue
        if p.name.startswith(".") or p.name.lower() in SYSTEM_NAMES:
            continue
        # never migrate bridge/code helpers
        if p.suffix.lower() in {".py", ".pyc", ".pyw", ".vbs", ".ps1", ".bat", ".cmd", ".json", ".log", ".pid"}:
            continue
        dest = inbox / p.name
        if dest.exists():
            dest = inbox / f"{p.stem}-migrated{p.suffix}"
        try:
            p.rename(dest)
        except OSError:
            pass


def pin_enabled() -> bool:
    users = CONFIG.get("users") or []
    if isinstance(users, list) and any(isinstance(u, dict) and str(u.get("pin") or "").strip() for u in users):
        return True
    return bool(str(CONFIG.get("pin", "") or "").strip())


def pin_value() -> str:
    return str(CONFIG.get("pin", "") or "").strip()


def pin_hash(pin: str) -> str:
    return hashlib.sha256(f"transfert-bridge:{pin}".encode()).hexdigest()


def authenticate_pin(pin: str) -> dict | None:
    pin = (pin or "").strip()
    users = [u for u in (CONFIG.get("users") or []) if isinstance(u, dict) and str(u.get("pin") or "").strip()]
    if users:
        for u in users:
            if hmac.compare_digest(pin_hash(str(u.get("pin") or "")), pin_hash(pin)):
                role = str(u.get("role") or "admin").lower()
                if role not in ("admin", "upload"):
                    role = "admin"
                return {"user": str(u.get("name") or "user")[:40], "role": role}
        return None
    if not pin_enabled():
        # Fail closed: empty PIN never authenticates (startup should have refused).
        return None
    if hmac.compare_digest(pin_hash(pin), pin_hash(pin_value())):
        return {"user": "admin", "role": "admin"}
    return None


def _persist_sessions() -> None:
    try:
        now = time.time()
        with _SESSIONS_LOCK:
            slim = {
                tok: info
                for tok, info in _SESSIONS.items()
                if isinstance(info, dict) and float(info.get("exp") or 0) > now
            }
            _SESSIONS.clear()
            _SESSIONS.update(slim)
            payload = dict(slim)
        SESSIONS_PATH.write_text(json.dumps(payload), encoding="utf-8")
    except OSError as e:
        sys.stderr.write(f"persist sessions: {e}\n")


def load_sessions() -> None:
    if not SESSIONS_PATH.is_file():
        return
    try:
        data = json.loads(SESSIONS_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return
        now = time.time()
        with _SESSIONS_LOCK:
            for tok, info in data.items():
                if not isinstance(tok, str) or not isinstance(info, dict):
                    continue
                if float(info.get("exp") or 0) <= now:
                    continue
                _SESSIONS[tok] = {
                    "exp": float(info["exp"]),
                    "user": str(info.get("user") or "admin")[:40],
                    "role": str(info.get("role") or "admin"),
                }
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        pass


def auth_generation() -> int:
    try:
        return int((CONFIG or {}).get("auth_generation") or 0)
    except (TypeError, ValueError):
        return 0


def issue_session(user: str = "admin", role: str = "admin") -> str:
    token = secrets.token_urlsafe(24)
    with _SESSIONS_LOCK:
        _SESSIONS[token] = {
            "exp": time.time() + SESSION_TTL_SEC,
            "user": user,
            "role": role,
            "gen": auth_generation(),
        }
    _persist_sessions()
    return token


def session_info(token: str | None) -> dict | None:
    if not pin_enabled():
        # Fail closed: no PIN => no session, never implicit admin.
        return None
    if not token:
        return None
    with _SESSIONS_LOCK:
        info = _SESSIONS.get(token)
        if not info:
            return None
        if isinstance(info, (int, float)):
            if info < time.time():
                _SESSIONS.pop(token, None)
                info = None
            else:
                info = {"user": "admin", "role": "admin", "exp": info, "gen": 0}
                _SESSIONS[token] = info
        elif float(info.get("exp") or 0) < time.time():
            _SESSIONS.pop(token, None)
            info = None
        elif int(info.get("gen") or 0) != auth_generation():
            _SESSIONS.pop(token, None)
            info = None
        else:
            info = dict(info)
    if info is None:
        _persist_sessions()
    return info


def session_valid(token: str | None) -> bool:
    return session_info(token) is not None


def session_role(token: str | None) -> str:
    info = session_info(token)
    if not info:
        return ""
    role = str(info.get("role") or "admin").lower()
    return role if role in ("admin", "upload") else "admin"


def revoke_session(token: str | None) -> None:
    if not token:
        return
    with _SESSIONS_LOCK:
        _SESSIONS.pop(token, None)
    _persist_sessions()


def slugify(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE)
    text = re.sub(r"[\s_-]+", "-", text).strip("-")
    return text[:40] or "note"


def valid_folder(name: str | None) -> str:
    folders = list(CONFIG.get("folders") or DEFAULT_FOLDERS)
    name = (name or "").strip()
    if name in folders:
        return name
    return str(CONFIG.get("default_folder") or folders[0])


def parse_rel(rel: str) -> list[str] | None:
    rel = unquote(rel or "").replace("\\", "/").strip("/")
    parts = [p for p in rel.split("/") if p and p not in (".", "..")]
    if not parts:
        return []
    folders = list(CONFIG.get("folders") or DEFAULT_FOLDERS)
    if parts[0] not in folders:
        return None
    for p in parts:
        if p.startswith(".") or p.lower() in SYSTEM_NAMES or "/" in p or "\\" in p:
            return None
    return parts


def resolve_rel(rel: str, *, must_exist: bool = True, allow_dir: bool = True) -> Path | None:
    """Resolve path under ROOT/{Inbox|Uni|Print}/..."""
    parts = parse_rel(rel)
    if parts is None:
        return None
    if not parts:
        return None
    path = (ROOT.joinpath(*parts)).resolve()
    root_folder = (ROOT / parts[0]).resolve()
    try:
        path.relative_to(root_folder)
    except ValueError:
        return None
    if must_exist:
        if allow_dir and path.is_dir():
            return path
        if path.is_file():
            return path
        return None
    # parent must exist for create targets
    if not path.parent.exists():
        return None
    return path


def safe_rel_path(rel: str) -> Path | None:
    """File only (download/open/delete file)."""
    path = resolve_rel(rel, must_exist=True, allow_dir=False)
    return path if path and path.is_file() else None


def unique_in_dir(directory: Path, filename: str) -> Path:
    dest = directory / filename
    if not dest.exists():
        return dest
    stem, suffix = Path(filename).stem, Path(filename).suffix
    i = 1
    while True:
        candidate = directory / f"{stem}-{i}{suffix}"
        if not candidate.exists():
            return candidate
        i += 1


def unique_in_folder(folder: str, filename: str) -> Path:
    return unique_in_dir(ROOT / valid_folder(folder), filename)


def safe_leaf_name(name: str) -> str | None:
    name = Path(str(name or "").strip()).name
    if not name or name in (".", "..") or name.startswith("."):
        return None
    if name.lower() in SYSTEM_NAMES:
        return None
    if "/" in name or "\\" in name:
        return None
    return name


def resolve_writable_dir(rel: str, *, create: bool = False) -> Path | None:
    """Existing (or creatable) directory under Inbox/Uni/Print."""
    parts = parse_rel(rel)
    if parts is None or not parts:
        return None
    path = ROOT.joinpath(*parts)
    root_folder = (ROOT / parts[0]).resolve()
    if create:
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError:
            return None
    if not path.is_dir():
        return None
    resolved = path.resolve()
    try:
        resolved.relative_to(root_folder)
    except ValueError:
        return None
    return resolved


def unique_under_rel(rel: str, filename: str) -> Path | None:
    directory = resolve_writable_dir(rel, create=True)
    if not directory:
        return None
    return unique_in_dir(directory, filename)


def list_dir(rel: str = "", q: str = "") -> dict:
    """List one directory. rel='' means virtual roots Inbox/Uni/Print."""
    q = (q or "").strip().lower()
    folders = list(CONFIG.get("folders") or DEFAULT_FOLDERS)
    items: list[dict] = []
    breadcrumb = [{"name": "Racine", "rel": ""}]

    if not rel or rel == "all":
        for f in folders:
            d = ROOT / f
            d.mkdir(parents=True, exist_ok=True)
            if q and q not in f.lower():
                continue
            st = d.stat()
            items.append(
                {
                    "name": f,
                    "rel": f,
                    "type": "dir",
                    "size": 0,
                    "size_h": "—",
                    "mtime": int(st.st_mtime),
                    "mtime_h": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                }
            )
        return {"rel": "", "breadcrumb": breadcrumb, "items": items}

    parts = parse_rel(rel)
    if parts is None:
        return {"rel": "", "breadcrumb": breadcrumb, "items": [], "error": "Chemin invalide"}
    path = resolve_rel("/".join(parts), must_exist=True, allow_dir=True)
    if not path or not path.is_dir():
        return {"rel": "", "breadcrumb": breadcrumb, "items": [], "error": "Dossier introuvable"}

    acc: list[str] = []
    for p in parts:
        acc.append(p)
        breadcrumb.append({"name": p, "rel": "/".join(acc)})

    for child in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if child.name.startswith("."):
            continue
        if child.name.lower() in SYSTEM_NAMES:
            continue
        if q and q not in child.name.lower():
            continue
        child_rel = "/".join(parts + [child.name])
        st = child.stat()
        is_dir = child.is_dir()
        items.append(
            {
                "name": child.name,
                "rel": child_rel,
                "type": "dir" if is_dir else "file",
                "size": 0 if is_dir else st.st_size,
                "size_h": "—" if is_dir else human_size(st.st_size),
                "mtime": int(st.st_mtime),
                "mtime_h": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
            }
        )
    return {"rel": "/".join(parts), "breadcrumb": breadcrumb, "items": items}


def list_files(folder: str | None = None, q: str = "") -> list[dict]:
    """Flat list for legacy callers."""
    if folder and folder not in ("all", ""):
        data = list_dir(folder, q)
    else:
        # flatten all roots
        items: list[dict] = []
        for f in CONFIG.get("folders") or DEFAULT_FOLDERS:
            items.extend([i for i in list_dir(f, q)["items"] if i["type"] == "file"])
        items.sort(key=lambda x: x["mtime"], reverse=True)
        return items
    return [i for i in data.get("items", []) if i["type"] == "file"]


def lan_ipv4() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    return "127.0.0.1"


_TAILSCALE_BIN: str | None = None


def tailscale_bin() -> str | None:
    """Resolve Tailscale CLI (often not on PATH when launched as a service/hidden process)."""
    global _TAILSCALE_BIN
    if _TAILSCALE_BIN is not None:
        return _TAILSCALE_BIN or None
    candidates = [
        shutil.which("tailscale"),
        r"C:\Program Files\Tailscale\tailscale.exe",
        r"C:\Program Files (x86)\Tailscale\tailscale.exe",
        str(Path.home() / "AppData" / "Local" / "Tailscale" / "tailscale.exe"),
    ]
    for c in candidates:
        if c and Path(c).is_file():
            _TAILSCALE_BIN = c
            return c
    _TAILSCALE_BIN = ""
    return None


def tailscale_ipv4() -> str | None:
    exe = tailscale_bin()
    if not exe:
        return None
    try:
        r = subprocess.run(
            [exe, "ip", "-4"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if r.returncode == 0:
            ip = (r.stdout or "").strip().splitlines()[0].strip()
            if re.match(r"^\d+\.\d+\.\d+\.\d+$", ip):
                return ip
    except (OSError, IndexError, subprocess.TimeoutExpired):
        pass
    return None


def notify_discord(title: str, description: str) -> None:
    url = str(CONFIG.get("discord_webhook_url") or "").strip()
    if not url:
        return

    def _send() -> None:
        payload = json.dumps(
            {
                "embeds": [
                    {
                        "title": title[:200],
                        "description": description[:1800],
                        "color": 0x3B9EFF,
                        "timestamp": datetime.utcnow().isoformat() + "Z",
                    }
                ]
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "TransfertBridge/3"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp.read()
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            sys.stderr.write(f"Discord webhook failed: {e}\n")

    threading.Thread(target=_send, daemon=True).start()


def disk_free(path: Path) -> dict:
    try:
        u = shutil.disk_usage(path)
        return {
            "total": u.total,
            "used": u.used,
            "free": u.free,
            "total_h": human_size(u.total),
            "used_h": human_size(u.used),
            "free_h": human_size(u.free),
            "pct_used": round(100 * u.used / u.total, 1) if u.total else 0,
        }
    except OSError as e:
        return {"error": str(e)}



def _normalize_public_base(url: str) -> str | None:
    """Allow only http(s)://host[:port]/ — no path/query/fragment, never credentials."""
    s = (url or "").strip()
    if not s or any(c.isspace() for c in s):
        return None
    if "://" not in s:
        s = "http://" + s
    p = urlparse(s)
    if p.scheme not in ("http", "https"):
        return None
    if not p.netloc or "@" in p.netloc:
        return None
    path = p.path or "/"
    if path not in ("", "/"):
        return None
    if p.query or p.fragment or p.params:
        return None
    host = p.hostname
    if not host:
        return None
    netloc = host
    if p.port:
        netloc = f"{host}:{p.port}"
    return f"{p.scheme}://{netloc}/"


def public_bridge_urls() -> list[dict]:
    """Server-decided bridge base URLs for QR + CSRF. URL-only — never PIN/session/token."""
    seen: set[str] = set()
    out: list[dict] = []

    def add(label: str, url: str) -> None:
        norm = _normalize_public_base(url)
        if not norm or norm in seen:
            return
        seen.add(norm)
        out.append({"label": label, "url": norm})

    add("localhost", f"http://127.0.0.1:{PORT}/")
    add("localhost", f"http://localhost:{PORT}/")
    lan = lan_ipv4()
    if lan:
        add("LAN", f"http://{lan}:{PORT}/")
    ts = tailscale_ipv4()
    if ts:
        add("Tailscale", f"http://{ts}:{PORT}/")
    for u in (CONFIG.get("public_base_urls") or []):
        add("Serve", str(u))
    return out


def csrf_allowed_origins(request_host: str | None = None) -> set[str]:
    """Origins derived from request Host + LAN/Tailscale/localhost + public_base_urls."""
    origins: set[str] = set()
    host = (request_host or "").split(",")[0].strip()
    if host and "/" not in host and " " not in host and "\\" not in host:
        origins.add(f"http://{host}")
        origins.add(f"https://{host}")
    for entry in public_bridge_urls():
        p = urlparse(entry["url"])
        if p.scheme and p.netloc:
            origins.add(f"{p.scheme}://{p.netloc}")
    return origins


def parse_list_bounds(qs: dict, *, default: int = LIST_LIMIT_DEFAULT, max_limit: int = LIST_LIMIT_MAX) -> tuple[int, int]:
    """Parse limit/offset. Raises ValueError for absurd values (caller → 400)."""
    raw_limit = (qs.get("limit") or [None])[0]
    raw_offset = (qs.get("offset") or [None])[0]
    if raw_limit is None or str(raw_limit).strip() == "":
        limit = default
    else:
        try:
            limit = int(raw_limit)
        except (TypeError, ValueError) as e:
            raise ValueError("limit invalide") from e
        if limit < 0 or limit > max_limit:
            raise ValueError(f"limit max {max_limit}")
    if raw_offset is None or str(raw_offset).strip() == "":
        offset = 0
    else:
        try:
            offset = int(raw_offset)
        except (TypeError, ValueError) as e:
            raise ValueError("offset invalide") from e
        if offset < 0 or offset > LIST_OFFSET_MAX:
            raise ValueError(f"offset max {LIST_OFFSET_MAX}")
    return limit, offset


def bridge_status() -> dict:
    return {
        "hostname": socket.gethostname(),
        "root": str(ROOT),
        "uptime_sec": int(time.time() - _STARTED_AT),
        "uptime_h": _fmt_uptime(time.time() - _STARTED_AT),
        "lan": lan_ipv4(),
        "tailscale": tailscale_ipv4(),
        "pin": pin_enabled(),
        "discord": bool(str(CONFIG.get("discord_webhook_url") or "").strip()),
        "max_upload": max_upload_bytes(),
        "max_upload_h": human_size(max_upload_bytes()),
        "disk_d": disk_free(Path("D:/")),
        "disk_transfert": disk_free(ROOT),
        "version": "7.0",
        "terminal_commands": [
            {"id": c.get("id"), "label": c.get("label")}
            for c in (CONFIG.get("terminal_commands") or [])
            if isinstance(c, dict) and c.get("id")
        ],
        "chunk": CLIENT_CHUNK,
        "shell_targets": cc_ext.list_shell_targets(tailscale_peers_fn=tailscale_peers),
        "ssh_user": str(CONFIG.get("ssh_user") or ""),
        "actions": [
            {"id": a.get("id"), "label": a.get("label"), "type": a.get("type")}
            for a in (CONFIG.get("actions") or [])
            if isinstance(a, dict) and a.get("id")
        ],
        "favorites": list(CONFIG.get("favorites") or []),
        "scenes": [
            {"id": s.get("id"), "label": s.get("label")}
            for s in (CONFIG.get("scenes") or [])
            if isinstance(s, dict) and s.get("id")
        ],
        "notify_min_upload_mb": CONFIG.get("notify_min_upload_mb", 50),
        "alert_disk_min_gb": CONFIG.get("alert_disk_min_gb", 20),
        "urls": {
            "lan": next((e["url"] for e in public_bridge_urls() if e["label"] == "LAN"), f"http://{lan_ipv4()}:{PORT}/"),
            "tailscale": next((e["url"] for e in public_bridge_urls() if e["label"] == "Tailscale"), ""),
            # QR payloads must use these server-built bases only (URL-only, jamais de PIN)
            "qr": [{"label": e["label"], "url": e["url"]} for e in public_bridge_urls() if e["label"] in ("LAN", "Tailscale", "Serve")],
            "public": [e["url"] for e in public_bridge_urls()],
        },
    }


def _fmt_uptime(sec: float) -> str:
    s = int(sec)
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    if d:
        return f"{d}j {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m {s}s"


def presence_upsert(client_id: str, payload: dict, ip: str) -> None:
    client_id = str(client_id or "")[:PRESENCE_ID_MAX].strip()
    if not client_id:
        return
    now = time.time()
    free = payload.get("free")
    total = payload.get("total")
    used = payload.get("used")
    try:
        free_i = int(free) if free is not None else None
    except (TypeError, ValueError):
        free_i = None
    try:
        total_i = int(total) if total is not None else None
    except (TypeError, ValueError):
        total_i = None
    try:
        used_i = int(used) if used is not None else None
    except (TypeError, ValueError):
        used_i = None
    entry = {
        "id": client_id,
        "name": str(payload.get("name") or "Appareil")[:60],
        "kind": str(payload.get("kind") or "browser")[:40],
        "battery": payload.get("battery"),
        "ip": ip,
        "path": cc_ext.classify_ip(ip),
        "last_seen": now,
        "source": "browser",
        "online": True,
    }
    if free_i is not None and free_i >= 0:
        entry["free"] = free_i
        entry["free_h"] = human_size(free_i)
    if total_i is not None and total_i >= 0:
        entry["total"] = total_i
        entry["total_h"] = human_size(total_i)
    if used_i is not None and used_i >= 0:
        entry["used"] = used_i
        entry["used_h"] = human_size(used_i)
    with _PRESENCE_LOCK:
        _PRESENCE[client_id] = entry
        dead = [k for k, v in _PRESENCE.items() if now - v.get("last_seen", 0) > PRESENCE_TTL_SEC]
        for k in dead:
            _PRESENCE.pop(k, None)
        while len(_PRESENCE) > PRESENCE_MAX_ENTRIES:
            oldest_k = min(_PRESENCE.items(), key=lambda kv: float(kv[1].get("last_seen") or 0))[0]
            _PRESENCE.pop(oldest_k, None)


def presence_list() -> list[dict]:
    now = time.time()
    with _PRESENCE_LOCK:
        dead = [k for k, v in _PRESENCE.items() if now - v.get("last_seen", 0) > PRESENCE_TTL_SEC]
        for k in dead:
            _PRESENCE.pop(k, None)
        items = [dict(v) for v in _PRESENCE.values()]
    out = []
    for it in items:
        it["ago_sec"] = int(now - it.get("last_seen", now))
        it["online"] = True
        out.append(it)
    return out


def host_device_entry() -> dict:
    """This PC as a roster entry with real volume free space."""
    disk_d = disk_free(Path("D:/"))
    disk_c = disk_free(Path("C:/"))
    disks = []
    for label, info in (("C:", disk_c), ("D:", disk_d)):
        if info.get("error"):
            continue
        disks.append(
            {
                "name": label,
                "free": info.get("free"),
                "free_h": info.get("free_h"),
                "total": info.get("total"),
                "total_h": info.get("total_h"),
                "pct_used": info.get("pct_used"),
            }
        )
    primary = disk_d if not disk_d.get("error") else disk_c
    return {
        "id": "pc-host",
        "name": socket.gethostname(),
        "kind": "pc",
        "online": True,
        "source": "host",
        "ip": lan_ipv4(),
        "path": "lan",
        "last_seen": time.time(),
        "ago_sec": 0,
        "free": primary.get("free"),
        "free_h": primary.get("free_h"),
        "total": primary.get("total"),
        "total_h": primary.get("total_h"),
        "disks": disks,
    }


_ROSTER_CACHE_LOCK = threading.Lock()
_ROSTER_CACHE: dict = {"at": 0.0, "devices": []}
_HQ_BOUND = False


def _store_roster_cache(devices: list[dict]) -> None:
    with _ROSTER_CACHE_LOCK:
        _ROSTER_CACHE["at"] = time.time()
        _ROSTER_CACHE["devices"] = [dict(d) for d in devices]


def roster_cache_age() -> float | None:
    with _ROSTER_CACHE_LOCK:
        if not _ROSTER_CACHE.get("devices"):
            return None
        return max(0.0, time.time() - float(_ROSTER_CACHE.get("at") or 0))


def cached_roster_devices() -> list[dict]:
    """Local host + browsers, plus last cached Tailscale peers. Does not probe."""
    with _ROSTER_CACHE_LOCK:
        cached = [dict(d) for d in (_ROSTER_CACHE.get("devices") or [])]
    peers = [d for d in cached if d.get("source") == "tailscale"]
    return [host_device_entry(), *presence_list(), *peers]


def devices_roster() -> dict:
    peers = tailscale_peers()
    devices = [host_device_entry()] + presence_list() + peers
    _store_roster_cache(devices)
    return {"devices": devices}


def tailscale_peers() -> list[dict]:
    exe = tailscale_bin()
    if not exe:
        return []
    try:
        r = subprocess.run(
            [exe, "status", "--json"],
            capture_output=True,
            text=True,
            timeout=4,
            check=False,
        )
        if r.returncode != 0 or not (r.stdout or "").strip():
            return []
        data = json.loads(r.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return []
    out: list[dict] = []
    peers = dict(data.get("Peer") or {})
    # Do not inject Self — host_device_entry() already represents this PC.
    for _key, peer in peers.items():
        if not isinstance(peer, dict):
            continue
        dns = peer.get("DNSName") or peer.get("HostName") or "tailscale"
        online = bool(peer.get("Online"))
        ips = peer.get("TailscaleIPs") or []
        relay = peer.get("Relay") or ""
        cur = peer.get("CurAddr") or peer.get("Active") or ""
        if not online:
            path = "offline"
        elif relay and not cur:
            path = "relay"
        elif cur or peer.get("Active"):
            path = "direct"
        else:
            path = "tailscale"
        entry = {
            "id": f"ts:{peer.get('ID') or dns}",
            "name": str(dns).rstrip("."),
            "kind": "tailscale",
            "online": online,
            "ip": ips[0] if ips else "",
            "os": peer.get("OS") or "",
            "source": "tailscale",
            "path": path,
            "relay": relay or None,
            "last_seen": time.time() if online else 0,
            "ago_sec": 0 if online else None,
        }
        cc_ext.apply_disk_cache(entry)
        out.append(entry)
    return out


def probe_remote_disks_now() -> None:
    """Background disk probe. Refreshes the roster cache; HTTP /api/hq does not probe."""
    peers = tailscale_peers()
    cc_ext.refresh_remote_disks(peers)
    for peer in peers:
        cc_ext.apply_disk_cache(peer)
    _store_roster_cache([host_device_entry(), *presence_list(), *peers])


def harvest_screenshots_now(*, force: bool = False) -> dict:
    return cc_ext.harvest_screenshots(peers_fn=tailscale_peers, force=force)


def transfer_start(tid: str, *, name: str, size: int, folder: str, ip: str) -> None:
    entry = {
        "id": tid,
        "name": name,
        "size": size,
        "size_h": human_size(size) if size else "—",
        "folder": folder,
        "ip": ip,
        "state": "active",
        "started": time.time(),
        "finished": None,
    }
    with _TRANSFERS_LOCK:
        _TRANSFERS.insert(0, entry)
        del _TRANSFERS[TRANSFER_HISTORY:]


def transfer_finish(tid: str, *, ok: bool = True, rel: str = "", error: str = "") -> None:
    snapshot: list[dict] = []
    with _TRANSFERS_LOCK:
        for t in _TRANSFERS:
            if t.get("id") == tid:
                t["state"] = "done" if ok else "error"
                t["finished"] = time.time()
                if rel:
                    t["rel"] = rel
                if error:
                    t["error"] = error
                break
        snapshot = list(_TRANSFERS)
    try:
        cc_ext.persist_transfers(snapshot)
    except Exception as e:
        sys.stderr.write(f"persist_transfers: {e}\n")
    try:
        if not ok:
            cc_ext.push_alert("Transfert échoué", error or tid)
        else:
            cc_ext.log_activity("upload", f"Upload OK {rel or tid}", rel=rel)
    except Exception as e:
        sys.stderr.write(f"transfer_finish side-effect: {e}\n")


def transfers_list() -> list[dict]:
    with _TRANSFERS_LOCK:
        return list(_TRANSFERS)


def read_pc_clipboard() -> str:
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"],
        capture_output=True,
        text=True,
        timeout=8,
        check=False,
    )
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "clipboard read failed").strip()[:200])
    # PowerShell often appends a trailing newline
    return (r.stdout or "").rstrip("\r\n")


def write_pc_clipboard(text: str) -> None:
    # Use stdin to avoid command-line length / quoting issues
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $input"],
        input=text,
        capture_output=True,
        text=True,
        timeout=8,
        check=False,
    )
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "clipboard write failed").strip()[:200])


def pc_lock() -> None:
    if not ctypes.windll.user32.LockWorkStation():
        raise RuntimeError("LockWorkStation a échoué")
    cc_ext.log_activity("lock", "PC verrouillé")


def pc_sleep() -> None:
    cc_ext.log_activity("sleep", "PC en veille")
    # Hibernate=False, ForceCritical=True, DisableWakeEvent=False
    ctypes.windll.powrprof.SetSuspendState(0, 1, 0)


def pc_screenshot() -> dict:
    out_dir = captures_dir()
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = unique_in_dir(out_dir, f"Capture_{stamp}.png")
    ps = f"""
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('{str(dest).replace("'", "''")}')
$g.Dispose(); $bmp.Dispose()
"""
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if r.returncode != 0 or not dest.is_file():
        raise RuntimeError((r.stderr or "screenshot failed").strip()[:300])
    rel = "/".join(dest.relative_to(ROOT).parts)
    notify_discord("Capture d'écran PC", f"`{rel}`")
    cc_ext.log_activity("screenshot", f"Capture {dest.name}", rel=rel)
    return {"rel": rel, "name": dest.name, "size": dest.stat().st_size}


def _path_allowed(path: Path) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        return False
    # Always allow under Transfert root
    try:
        resolved.relative_to(ROOT.resolve())
        return True
    except ValueError:
        pass
    # Allowlisted action paths (exact file/dir or under that path)
    for a in CONFIG.get("actions") or []:
        if not isinstance(a, dict):
            continue
        raw = str(a.get("path") or "")
        if not raw:
            continue
        try:
            base = Path(raw).resolve()
        except OSError:
            continue
        if resolved == base:
            return True
        try:
            resolved.relative_to(base)
            return True
        except ValueError:
            continue
    return False


def pc_explore(target: str) -> None:
    target = (target or "").strip()
    path: Path | None = None
    if Path(target).is_absolute():
        path = Path(target)
    else:
        path = resolve_rel(target, must_exist=True, allow_dir=True)
        if not path:
            path = safe_rel_path(target)
        if not path:
            path = resolve_writable_dir(target, create=False)
    if not path or not path.exists():
        raise ValueError("Chemin introuvable")
    if not _path_allowed(path):
        raise ValueError("Chemin non autorisé")
    if path.is_file():
        subprocess.Popen(["explorer.exe", f"/select,{path}"], close_fds=True)
    else:
        subprocess.Popen(["explorer.exe", str(path)], close_fds=True)


def pc_run_action(action_id: str) -> dict:
    action = None
    for a in CONFIG.get("actions") or []:
        if isinstance(a, dict) and a.get("id") == action_id:
            action = a
            break
    if not action:
        raise ValueError("Action inconnue")
    path = Path(str(action.get("path") or ""))
    if not path.exists():
        raise ValueError("Chemin action manquant")
    if not _path_allowed(path):
        raise ValueError("Chemin non autorisé")
    typ = str(action.get("type") or "explore")
    if typ == "explore":
        if path.is_file():
            subprocess.Popen(["explorer.exe", f"/select,{path}"], close_fds=True)
        else:
            subprocess.Popen(["explorer.exe", str(path)], close_fds=True)
    elif typ == "script":
        if path.suffix.lower() in {".bat", ".cmd", ".ps1", ".exe", ".py"}:
            if path.suffix.lower() == ".ps1":
                subprocess.Popen(
                    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(path)],
                    close_fds=True,
                    cwd=str(path.parent),
                )
            elif path.suffix.lower() == ".py":
                subprocess.Popen([sys.executable, str(path)], close_fds=True, cwd=str(path.parent))
            else:
                subprocess.Popen([str(path)], close_fds=True, cwd=str(path.parent), shell=True)
        else:
            raise ValueError("Type de script non supporté")
    else:
        raise ValueError("Type d'action invalide")
    notify_discord("Action PC", f"**{action.get('label') or action_id}** (`{action_id}`)")
    cc_ext.log_activity("action", f"Action {action.get('label') or action_id}")
    return {"ok": True, "id": action_id}


def pc_print_file(rel: str) -> dict:
    path = safe_rel_path(rel)
    if not path:
        raise ValueError("Fichier introuvable")
    # must live under Print/
    try:
        path.resolve().relative_to((ROOT / "Print").resolve())
    except ValueError as e:
        raise ValueError("Seuls les fichiers dans Print/ peuvent être imprimés") from e
    try:
        os.startfile(str(path), "print")  # type: ignore[attr-defined]
    except OSError as e:
        raise RuntimeError(f"Impression impossible: {e}") from e
    notify_discord("Impression", f"`{rel}`")
    cc_ext.log_activity("print", f"Impression {rel}", rel=rel)
    return {"ok": True, "rel": rel}


def hq_attention(devices: list[dict]) -> list[dict]:
    items: list[dict] = []
    disk = disk_free(ROOT)
    try:
        min_gb = float(CONFIG.get("alert_disk_min_gb") or 20)
    except (TypeError, ValueError):
        min_gb = 20.0
    free = int(disk.get("free") or 0) if "error" not in disk else 0
    if free and free < min_gb * 1024**3:
        items.append(
            {
                "level": "critical",
                "title": "Espace disque bas",
                "detail": f"{disk.get('free_h') or '?'} libre (seuil {min_gb:g} Go)",
            }
        )
    elif free and free < min_gb * 2 * 1024**3:
        items.append(
            {
                "level": "warning",
                "title": "Espace disque à surveiller",
                "detail": f"{disk.get('free_h') or '?'} libre",
            }
        )
    for device in devices:
        if device.get("source") == "tailscale" and device.get("online") is False:
            items.append(
                {
                    "level": "warning",
                    "title": "Appareil hors ligne",
                    "detail": str(device.get("name") or device.get("id") or "")[:80],
                }
            )
            if sum(1 for it in items if it["title"] == "Appareil hors ligne") >= 5:
                break
    for alert in (cc_ext.alerts_list() or [])[:5]:
        items.append(
            {
                "level": "warning",
                "title": str(alert.get("title") or "Alerte")[:80],
                "detail": str(alert.get("detail") or "")[:180],
            }
        )
    for ev in hq_events.recent(30):
        if ev.get("level") == "critical":
            items.append(
                {
                    "level": "critical",
                    "title": str(ev.get("kind") or "Critique"),
                    "detail": str(ev.get("message") or "")[:180],
                }
            )
            break
    try:
        for job in cc_ext.queue_list():
            if isinstance(job, dict) and job.get("status") == "error":
                items.append(
                    {
                        "level": "warning",
                        "title": "Tâche en échec",
                        "detail": str(job.get("label") or "")[:80],
                    }
                )
                break
    except Exception:
        pass
    return items[:12]


def hq_overall_state(attention: list[dict]) -> str:
    if any(item.get("level") == "critical" for item in attention):
        return "critical"
    if attention:
        return "warning"
    return "ok"


def hq_snapshot() -> dict:
    raw_devices = cached_roster_devices()
    devices = hq_devices.normalize_all(raw_devices)
    attention = hq_attention(raw_devices)
    scenes = [
        {"id": s.get("id"), "label": s.get("label")}
        for s in (CONFIG.get("scenes") or [])
        if isinstance(s, dict) and s.get("id")
    ]
    return {
        "ok": True,
        "version": "7.0",
        "state": hq_overall_state(attention),
        "attention": attention,
        "devices": devices,
        "events": hq_events.recent(12),
        "scenes": scenes,
        "generated_at": time.time(),
        "cached": True,
        "roster_age_sec": roster_cache_age(),
    }


def palette_catalog() -> list[dict]:
    items: list[dict] = []
    for folder in CONFIG.get("folders") or []:
        items.append({"kind": "folder", "id": str(folder), "label": str(folder), "hint": "Dossier"})
    for fav in CONFIG.get("favorites") or []:
        items.append({"kind": "favorite", "id": str(fav), "label": str(fav), "hint": "Favori"})
    for scene in CONFIG.get("scenes") or []:
        if isinstance(scene, dict) and scene.get("id"):
            items.append(
                {
                    "kind": "scene",
                    "id": str(scene["id"]),
                    "label": str(scene.get("label") or scene["id"]),
                    "hint": "Scène",
                }
            )
    for action in CONFIG.get("actions") or []:
        if isinstance(action, dict) and action.get("id"):
            items.append(
                {
                    "kind": "action",
                    "id": str(action["id"]),
                    "label": str(action.get("label") or action["id"]),
                    "hint": "Action",
                }
            )
    for cmd in CONFIG.get("terminal_commands") or []:
        if isinstance(cmd, dict) and cmd.get("id"):
            items.append(
                {
                    "kind": "terminal",
                    "id": str(cmd["id"]),
                    "label": str(cmd.get("label") or cmd["id"]),
                    "hint": "Commande allowlist",
                }
            )
    for device in hq_devices.normalize_all(cached_roster_devices()):
        items.append(
            {
                "kind": "device",
                "id": str(device.get("id") or ""),
                "label": str(device.get("name") or device.get("id") or ""),
                "hint": "Appareil",
            }
        )
    return items


def hq_safe_move(src: str, dest: str) -> dict:
    path = resolve_rel(src, must_exist=True, allow_dir=True)
    if not path:
        raise ValueError("Source introuvable")
    parts = parse_rel(src)
    if parts is not None and len(parts) == 1 and path.is_dir():
        raise ValueError("Impossible de déplacer une racine")
    dest_dir = resolve_writable_dir(dest, create=True)
    if not dest_dir:
        raise ValueError("Destination invalide")
    try:
        dest_dir.resolve().relative_to(path.resolve())
        if path.is_dir():
            raise ValueError("Impossible de déplacer un dossier dans lui-même")
    except ValueError as e:
        if "lui-même" in str(e):
            raise
    target = dest_dir / path.name
    if target.exists():
        target = unique_in_dir(dest_dir, path.name)
    shutil.move(str(path), str(target))
    rel = "/".join(Path(target).resolve().relative_to(ROOT).parts)
    return {"ok": True, "rel": rel}


def _file_exists_rel(rel: str) -> bool:
    return safe_rel_path(rel) is not None


def build_daily_brief() -> dict:
    snap = hq_snapshot()
    events = (hq_events.list_events(limit=200).get("events") or [])
    try:
        queue = cc_ext.queue_list()
    except Exception:
        queue = []
    backups: list[dict] = []
    if hq_automation.ready():
        backups = hq_automation.list_backups().get("backups") or []
    return hq_automation.build_brief(
        state=str(snap.get("state") or "ok"),
        attention=list(snap.get("attention") or []),
        events=events,
        queue=queue,
        backups=backups,
        disk=disk_free(ROOT),
    )


def bind_hq() -> None:
    global _HQ_BOUND
    hq_events.bind(ROOT)
    hq_automation.bind(
        root=ROOT,
        get_config=lambda: CONFIG,
        journal=lambda kind, message, **extra: cc_ext.log_activity(kind, message, **extra),
        explore=pc_explore,
        action=pc_run_action,
        terminal=lambda cmd_id: cc_ext.run_terminal(cmd_id=cmd_id),
        backup=lambda: cc_ext.run_backup(force=True),
        capture=pc_screenshot,
        print_file=pc_print_file,
        notify=notify_discord,
        move=hq_safe_move,
        sleep=time.sleep,
        disk_free=disk_free,
        devices=cached_roster_devices,
        file_exists=_file_exists_rel,
        queue_load=cc_ext.queue_load,
        queue_save=cc_ext.queue_save,
        events_since=lambda since: [
            ev
            for ev in (hq_events.list_events(limit=100).get("events") or [])
            if float(ev.get("ts") or 0) > float(since or 0)
        ],
        build_brief=build_daily_brief,
    )
    _HQ_BOUND = True


def ensure_hq() -> None:
    if not _HQ_BOUND:
        bind_hq()


def bind_cc_ext() -> None:
    cc_ext.bind(
        ROOT=ROOT,
        human_size=human_size,
        notify_discord=notify_discord,
        disk_free=disk_free,
        get_config=lambda: CONFIG,
        pc_run_action=pc_run_action,
        pc_explore=pc_explore,
    )
    cc_ext.load_activity()
    with _TRANSFERS_LOCK:
        if not _TRANSFERS:
            loaded = cc_ext.load_transfers()
            if loaded:
                _TRANSFERS.extend(loaded)


def _valid_upload_id(upload_id: str) -> bool:
    return bool(re.fullmatch(r"[a-f0-9]{16,32}", upload_id or ""))


def chunk_upload_dir(upload_id: str, *, create: bool = True) -> Path:
    if not _valid_upload_id(upload_id):
        raise ValueError("Upload id invalide")
    d = TMP_DIR / "chunks" / upload_id
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d


def upload_sessions_max() -> int:
    try:
        n = int(CONFIG.get("upload_sessions_max") or UPLOAD_SESSIONS_MAX)
    except (TypeError, ValueError):
        n = UPLOAD_SESSIONS_MAX
    return max(1, min(256, n))


def upload_disk_reserve_bytes() -> int:
    try:
        gb = float(CONFIG.get("upload_disk_reserve_gb") if CONFIG.get("upload_disk_reserve_gb") is not None else UPLOAD_DISK_RESERVE_GB_DEFAULT)
    except (TypeError, ValueError):
        gb = UPLOAD_DISK_RESERVE_GB_DEFAULT
    gb = max(0.0, min(100.0, gb))
    return int(gb * 1024 ** 3)


def upload_active_count() -> int:
    cleanup_stale_uploads()
    root = TMP_DIR / "chunks"
    n_disk = 0
    if root.is_dir():
        n_disk = sum(1 for d in root.iterdir() if d.is_dir())
    with UPLOAD_SESSIONS_LOCK:
        n_mem = len(UPLOAD_SESSIONS)
    return max(n_disk, n_mem)


def ensure_upload_capacity(size: int = 0) -> None:
    """Refuse new chunk sessions when concurrent quota or free-disk reserve is exceeded."""
    if upload_active_count() >= upload_sessions_max():
        raise ValueError(f"Trop d'envois en cours (max {upload_sessions_max()})")
    info = disk_free(ROOT)
    free = int(info.get("free") or 0) if "error" not in info else 0
    need = upload_disk_reserve_bytes() + max(0, int(size or 0))
    if free and free < need:
        raise ValueError(
            f"Espace disque insuffisant (libre {human_size(free)}, reserve {human_size(upload_disk_reserve_bytes())})"
        )


def cleanup_stale_uploads(*, ttl: int = UPLOAD_TTL_SEC) -> int:
    root = TMP_DIR / "chunks"
    if not root.is_dir():
        return 0
    now = time.time()
    n = 0
    for d in list(root.iterdir()):
        if not d.is_dir():
            continue
        meta_path = d / "meta.json"
        created = 0.0
        try:
            if meta_path.is_file():
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                created = float(meta.get("created") or 0)
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            created = 0.0
        if not created:
            try:
                created = d.stat().st_mtime
            except OSError:
                created = 0.0
        if created and (now - created) > ttl:
            shutil.rmtree(d, ignore_errors=True)
            n += 1
            with UPLOAD_SESSIONS_LOCK:
                UPLOAD_SESSIONS.pop(d.name, None)
    return n


def upload_init(name: str, size: int, folder: str) -> dict:
    cleanup_stale_uploads()
    size = int(size)
    if size < 0:
        raise ValueError("Taille invalide")
    if size > max_upload_bytes():
        raise ValueError(f"Envoi trop gros (max {human_size(max_upload_bytes())})")
    ensure_upload_capacity(size)
    upload_id = secrets.token_hex(12)
    chunk = CLIENT_CHUNK
    expected_parts = max(1, (size + chunk - 1) // chunk) if size else 1
    meta = {
        "id": upload_id,
        "name": Path(name).name,
        "size": size,
        "folder": folder,
        "received": 0,
        "created": time.time(),
        "chunk": chunk,
        "expected_parts": expected_parts,
        "indexes": [],
    }
    d = chunk_upload_dir(upload_id)
    (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    with UPLOAD_SESSIONS_LOCK:
        UPLOAD_SESSIONS[upload_id] = meta
    return {"id": upload_id, "chunk": chunk}


def upload_chunk(upload_id: str, index: int, data: bytes) -> dict:
    if not _valid_upload_id(upload_id):
        raise ValueError("Upload id invalide")
    d = chunk_upload_dir(upload_id, create=False)
    meta_path = d / "meta.json"
    if not meta_path.is_file():
        raise ValueError("Upload inconnu / expiré")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    expected = int(meta.get("size") or 0)
    chunk_sz = int(meta.get("chunk") or CLIENT_CHUNK)
    max_index = int(meta.get("expected_parts") or max(1, (expected + chunk_sz - 1) // chunk_sz if expected else 1)) - 1
    if index < 0 or index > max_index or index > 20000:
        raise ValueError("Index chunk invalide")
    # projected size BEFORE write
    other = 0
    for p in d.glob("part_*"):
        try:
            idx = int(p.name.split("_", 1)[1])
        except (IndexError, ValueError):
            continue
        if idx == int(index):
            continue
        other += p.stat().st_size
    projected = other + len(data)
    if expected and projected > expected:
        raise ValueError("Taille reçue incohérente")
    part = d / f"part_{int(index):06d}"
    part.write_bytes(data)
    received = sum(p.stat().st_size for p in d.glob("part_*"))
    idxs = sorted(meta.get("indexes") or [])
    if int(index) not in idxs:
        idxs.append(int(index))
        idxs.sort()
    meta["indexes"] = idxs
    meta["received"] = received
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    with UPLOAD_SESSIONS_LOCK:
        UPLOAD_SESSIONS[upload_id] = meta
    return {"ok": True, "received": received, "size": meta.get("size")}


def upload_status(upload_id: str) -> dict:
    if not _valid_upload_id(upload_id):
        raise ValueError("Upload id invalide")
    d = chunk_upload_dir(upload_id, create=False)
    meta_path = d / "meta.json"
    if not meta_path.is_file():
        raise ValueError("Upload inconnu / expiré")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    parts = sorted(d.glob("part_*"))
    received = sum(p.stat().st_size for p in parts)
    meta["received"] = received
    meta["parts"] = len(parts)
    return meta


def upload_complete(upload_id: str) -> dict:
    if not _valid_upload_id(upload_id):
        raise ValueError("Upload id invalide")
    d = chunk_upload_dir(upload_id, create=False)
    meta = upload_status(upload_id)
    parts = sorted(d.glob("part_*"))
    if not parts:
        raise ValueError("Aucun chunk")
    expected = int(meta.get("size") or 0)
    received = sum(p.stat().st_size for p in parts)
    if expected and received != expected:
        raise ValueError(f"Incomplet: {received}/{expected} octets")
    try:
        indexes = sorted(int(p.name.split("_", 1)[1]) for p in parts)
    except (IndexError, ValueError) as e:
        raise ValueError("Chunks invalides") from e
    if indexes != list(range(len(indexes))):
        raise ValueError("Chunks manquants ou non contigus")
    exp_parts = int(meta.get("expected_parts") or 0)
    if exp_parts and len(indexes) != exp_parts:
        raise ValueError(f"Nombre de chunks incorrect: {len(indexes)}/{exp_parts}")
    folder = str(meta.get("folder") or "Inbox")
    name = safe_leaf_name(str(meta.get("name") or "file.bin")) or "file.bin"
    target_rel = apply_auto_route(folder, name)
    dest_dir = resolve_writable_dir(target_rel, create=True)
    if not dest_dir:
        raise ValueError("Dossier cible invalide")
    dest = unique_in_dir(dest_dir, name)
    with dest.open("wb") as out:
        for part in parts:
            with part.open("rb") as inp:
                shutil.copyfileobj(inp, out, length=CHUNK)
    shutil.rmtree(d, ignore_errors=True)
    with UPLOAD_SESSIONS_LOCK:
        UPLOAD_SESSIONS.pop(upload_id, None)
    rel = "/".join(dest.relative_to(ROOT).parts)
    size = dest.stat().st_size

    def _notify() -> None:
        try:
            cc_ext.log_activity("upload", f"Chunked OK {rel}", rel=rel)
            notify_discord("Nouveau fichier", f"`{rel}` ({human_size(size)})")
        except Exception as e:
            sys.stderr.write(f"upload_complete notify: {e}\n")

    threading.Thread(target=_notify, daemon=True).start()
    return {"ok": True, "rel": rel, "name": dest.name, "size": size}


def png_icon(size: int = 192) -> bytes:
    """Minimal solid PNG with a simple T mark (no Pillow)."""
    # Very small solid blue PNG
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            # background
            r, g, b = 15, 20, 25
            # rounded-ish circle accent
            cx, cy = size / 2, size / 2
            if (x - cx) ** 2 + (y - cy) ** 2 < (size * 0.38) ** 2:
                r, g, b = 59, 158, 255
            # T stem
            if abs(x - size / 2) < size * 0.06 and size * 0.32 < y < size * 0.72:
                r, g, b = 255, 255, 255
            # T bar
            if size * 0.30 < y < size * 0.40 and size * 0.28 < x < size * 0.72:
                r, g, b = 255, 255, 255
            raw += bytes((r, g, b, 255))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def write_pid() -> None:
    PID_PATH.write_text(str(os.getpid()), encoding="utf-8")


APP_JS = r"""
const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];
const toastBox = () => $('#toasts');

function toast(msg, kind='ok', ms=3200) {
  const box = toastBox();
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

const VIEW_LABELS = { accueil: 'Accueil', fichiers: 'Fichiers', ops: 'Terminal', plus: 'Plus' };
function setView(name) {
  let view = VIEW_LABELS[name] ? name : 'accueil';
  if (document.body.classList.contains('mode-simple') && view === 'ops') view = 'accueil';
  document.body.dataset.view = view;
  const lab = $('#view-label');
  if (lab) lab.textContent = VIEW_LABELS[view];
  $$('.bottom-nav [data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  try { localStorage.setItem('tf_hq_view', view); } catch (_) {}
  if (view === 'fichiers') refreshFiles().catch(() => {});
}
function isSimpleMode() {
  try { return (localStorage.getItem('tf_hq_mode') || 'simple') === 'simple'; } catch (_) { return true; }
}
function applyMode(simple) {
  document.body.classList.toggle('mode-simple', !!simple);
  const btn = $('#mode-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', simple ? 'true' : 'false');
    btn.textContent = simple ? 'Mode simple' : 'Mode complet';
    btn.title = simple ? 'Afficher Terminal et outils avancés' : 'Masquer Terminal et outils avancés';
  }
  try { localStorage.setItem('tf_hq_mode', simple ? 'simple' : 'complet'); } catch (_) {}
  if (simple && document.body.dataset.view === 'ops') setView('accueil');
}
function setupModeToggle() {
  applyMode(isSimpleMode());
  $('#mode-toggle')?.addEventListener('click', () => applyMode(!document.body.classList.contains('mode-simple')));
}
function setupNav() {
  $$('.bottom-nav [data-nav]').forEach(b => b.addEventListener('click', () => setView(b.dataset.nav)));
  $('#status-chip')?.addEventListener('click', () => setView('plus'));
  let saved = 'accueil';
  try { saved = localStorage.getItem('tf_hq_view') || 'accueil'; } catch (_) {}
  setView(saved);
}

function fmtRel(rel) {
  return '/files/' + rel.split('/').map(encodeURIComponent).join('/');
}
function dlRel(rel) {
  return '/download/' + rel.split('/').map(encodeURIComponent).join('/');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

let currentRel = '';
let itemsCache = [];

async function api(url, opts={}) {
  const timeoutMs = Number(opts.timeoutMs || 15000);
  const { timeoutMs: _drop, ...fetchOpts } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal, ...fetchOpts });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Délai dépassé');
    throw new Error(navigator.onLine ? 'Réseau indisponible' : 'Hors ligne');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    const now = Date.now();
    const last = Number(sessionStorage.getItem('tf_auth_at') || 0);
    if (!sessionStorage.getItem('tf_auth_redirect') && (now - last > 15000)) {
      sessionStorage.setItem('tf_auth_redirect', '1');
      sessionStorage.setItem('tf_auth_at', String(now));
      location.replace('/logout');
    }
    throw new Error('PIN requis');
  }
  if (res.status === 403) {
    let msg = 'Réservé admin';
    try { const j = await res.clone().json(); if (j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  sessionStorage.removeItem('tf_auth_redirect');
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('Erreur ' + res.status));
    return data;
  }
  if (!res.ok) throw new Error('Erreur ' + res.status);
  return res;
}

function renderCrumbs(breadcrumb) {
  const el = $('#crumbs');
  if (!el) return;
  el.innerHTML = (breadcrumb || []).map((c, i, arr) => {
    const sep = i ? '<span class="crumb-sep">/</span>' : '';
    if (i === arr.length - 1) {
      return sep + `<span class="crumb">${escapeHtml(c.name)}</span>`;
    }
    return sep + `<button type="button" class="crumb" data-rel="${escapeAttr(c.rel)}">${escapeHtml(c.name)}</button>`;
  }).join('');
  $$('.crumb[data-rel]', el).forEach(b => b.addEventListener('click', () => navigate(b.dataset.rel)));
}

function renderFiles() {
  const q = ($('#search')?.value || '').trim().toLowerCase();
  const list = $('#file-list');
  const items = itemsCache.filter(f => !q || f.name.toLowerCase().includes(q));
  $('#file-count').textContent = String(items.length);
  if (!items.length) {
    list.innerHTML = `<li class="file empty empty-teach">
      <em>Aucun fichier ici</em>
      <p class="hint"><button type="button" class="ghost" data-go-accueil>Envoie depuis Accueil</button></p>
    </li>`;
    $$('[data-go-accueil]', list).forEach(b => b.addEventListener('click', () => setView('accueil')));
    return;
  }
  list.innerHTML = items.map(f => {
    const isDir = f.type === 'dir';
    const editable = !isDir && /\.(txt|md|csv|json|log|py|css|js|html?|xml|ya?ml|ini|cfg|srt)$/i.test(f.name);
    const openBtn = isDir
      ? `<button type="button" class="btn" data-open="${escapeAttr(f.rel)}">Ouvrir</button>`
      : `<a class="btn" href="${fmtRel(f.rel)}" target="_blank" rel="noopener">Ouvrir</a>`;
    const saveBtn = isDir ? '' : `<a class="btn secondary" href="${dlRel(f.rel)}" download>Sauver</a>`;
    const editBtn = editable ? `<button type="button" class="ghost" data-edit="${escapeAttr(f.rel)}">Éditer</button>` : '';
    const printBtn = (!isDir && f.rel.startsWith('Print/'))
      ? `<button type="button" class="ghost" data-print="${escapeAttr(f.rel)}">Imprimer</button>` : '';
    const nameEl = isDir
      ? `<button type="button" class="fname" data-open="${escapeAttr(f.rel)}" style="background:none;border:0;padding:0;text-align:left">📁 ${escapeHtml(f.name)}</button>`
      : `<a class="fname" href="${fmtRel(f.rel)}" target="_blank" rel="noopener">📄 ${escapeHtml(f.name)}</a>`;
    return `<li class="file ${isDir ? 'is-dir' : ''}">
      ${nameEl}
      <div class="row-actions">
        ${openBtn}${saveBtn}
        <div class="file-more">
          <button type="button" class="ghost more-toggle" aria-label="Plus d'actions">⋯</button>
          <div class="file-more-menu">
            ${editBtn}${printBtn}
            <button type="button" class="ghost" data-rename="${escapeAttr(f.rel)}" data-name="${escapeAttr(f.name)}">Renommer</button>
            <button type="button" class="ghost" data-move="${escapeAttr(f.rel)}">Déplacer</button>
            <button type="button" class="danger" data-del="${escapeAttr(f.rel)}" data-type="${f.type}" data-name="${escapeAttr(f.name)}">Supprimer</button>
          </div>
        </div>
      </div>
      <div class="meta">${escapeHtml(f.size_h)} · ${escapeHtml(f.mtime_h)}</div>
    </li>`;
  }).join('');

  $$('[data-open]', list).forEach(b => b.addEventListener('click', () => navigate(b.dataset.open)));
  $$('[data-del]', list).forEach(b => b.addEventListener('click', () => deleteItem(b.dataset.del, b.dataset.type, b.dataset.name)));
  $$('[data-rename]', list).forEach(b => b.addEventListener('click', () => renameItem(b.dataset.rename, b.dataset.name)));
  $$('[data-move]', list).forEach(b => b.addEventListener('click', () => moveItem(b.dataset.move)));
  $$('[data-edit]', list).forEach(b => b.addEventListener('click', () => editFile(b.dataset.edit)));
  $$('.more-toggle', list).forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const wrap = b.closest('.file-more');
    $$('.file-more.open', list).forEach(m => { if (m !== wrap) m.classList.remove('open'); });
    wrap?.classList.toggle('open');
  }));
  $$('[data-print]', list).forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Imprimer ' + b.dataset.print + ' ?')) return;
    try {
      await api('/api/print', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ rel: b.dataset.print })
      });
      toast("Envoyé à l'imprimante");
    } catch (e) { toast(e.message, 'err'); }
  }));
}

async function navigate(rel) {
  currentRel = rel || '';
  const root = (currentRel.split('/')[0] || '');
  if (root && $('#upload-folder')) {
    const opt = [...$('#upload-folder').options].find(o => o.value === root);
    if (opt) { $('#upload-folder').value = root; if ($('#note-folder')) $('#note-folder').value = root; }
  }
  if (document.body?.dataset?.view !== 'fichiers') setView('fichiers');
  await refreshFiles();
}

async function refreshFiles() {
  const list = $('#file-list');
  if (!list) return;
  const q = ($('#search')?.value || '').trim();
  const qs = new URLSearchParams();
  if (currentRel) qs.set('path', currentRel);
  if (q) qs.set('q', q);
  const data = await api('/api/list?' + qs.toString());
  if (data.error) throw new Error(data.error);
  itemsCache = data.items || [];
  renderCrumbs(data.breadcrumb || []);
  renderFiles();
}

async function deleteItem(rel, type, name) {
  const label = name || rel || (type === 'dir' ? 'ce dossier' : 'ce fichier');
  if (!confirm('Supprimer « ' + label + ' » ?')) return;
  try {
    await api('/api/delete', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ rel })
    });
    toast('Supprimé');
    await refreshFiles();
  } catch (e) { toast(e.message, 'err'); }
}

async function renameItem(rel, oldName) {
  const name = prompt('Nouveau nom:', oldName);
  if (!name || name === oldName) return;
  try {
    await api('/api/rename', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ rel, name })
    });
    toast('Renommé');
    await refreshFiles();
  } catch (e) { toast(e.message, 'err'); }
}

async function moveItem(rel) {
  const dest = prompt('Déplacer vers (ex: Uni ou Inbox/Cours):', currentRel || 'Inbox');
  if (dest === null) return;
  try {
    await api('/api/move', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ rel, dest })
    });
    toast('Déplacé');
    await refreshFiles();
  } catch (e) { toast(e.message, 'err'); }
}

async function mkdir() {
  const name = prompt('Nom du nouveau dossier:');
  if (!name) return;
  try {
    await api('/api/mkdir', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ path: currentRel, name })
    });
    toast('Dossier créé');
    await refreshFiles();
  } catch (e) { toast(e.message, 'err'); }
}

async function createFile() {
  if (!currentRel) { toast("Ouvre d'abord Inbox, Uni ou Print", 'err'); return; }
  const name = prompt('Nom du fichier (ex: notes.txt, cours.md):');
  if (!name) return;
  const content = prompt('Contenu (laissez vide pour un fichier vide):', '');
  if (content === null) return;
  try {
    const data = await api('/api/create', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ path: currentRel, name, content })
    });
    toast('Créé: ' + data.name);
    await refreshFiles();
  } catch (e) { toast(e.message, 'err'); }
}

async function editFile(rel) {
  try {
    const data = await api('/api/read', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ rel })
    });
    const next = prompt('Éditer ' + data.name + ':', data.content);
    if (next === null) return;
    await api('/api/write', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ rel, content: next })
    });
    toast('Enregistré');
    await refreshFiles();
  } catch (e) { toast(e.message, 'err'); }
}

function fmtBytes(n) {
  if (n < 1024) return n + ' o';
  if (n < 1048576) return (n/1024).toFixed(1) + ' Ko';
  if (n < 1073741824) return (n/1048576).toFixed(1) + ' Mo';
  return (n/1073741824).toFixed(2) + ' Go';
}

async function submitNote(ev) {
  ev.preventDefault();
  const title = $('#note-title').value.trim();
  const body = $('#note-body').value.trim();
  let folder = $('#note-folder').value;
  // if browsing inside a subfolder of that root, save there
  if (currentRel && currentRel.startsWith(folder)) folder = currentRel;
  else if (currentRel && currentRel.split('/')[0] === folder) folder = currentRel;
  if (!body) { toast('Note vide', 'err'); return; }
  try {
    const data = await api('/api/note', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ title, body, folder })
    });
    toast('Note: ' + data.name);
    $('#note-body').value = '';
    $('#note-title').value = '';
    await refreshFiles();
  } catch (e) { toast(e.message, 'err'); }
}

function uploadTargetFolder() {
  const root = $('#upload-folder').value || 'Inbox';
  if (currentRel && currentRel.split('/')[0] === root) return currentRel;
  return root;
}

const OFFLINE_KEY = 'transfert_offline_queue_v1';

function loadOfflineQueue() {
  try { return JSON.parse(localStorage.getItem(OFFLINE_KEY) || '[]'); } catch (_) { return []; }
}
function saveOfflineQueue(q) { localStorage.setItem(OFFLINE_KEY, JSON.stringify(q.slice(0, 20))); }

async function idbPut(id, blob, meta) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('transfert_hq', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ blob, meta }, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(id) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('transfert_hq', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('files', 'readonly');
      const g = tx.objectStore('files').get(id);
      g.onsuccess = () => resolve(g.result);
      g.onerror = () => reject(g.error);
    };
    req.onerror = () => reject(req.error);
  });
}
async function idbDel(id) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('transfert_hq', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

async function queueOffline(file, folder) {
  const id = 'off-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  await idbPut(id, file, { name: file.name, size: file.size, folder, type: file.type });
  const q = loadOfflineQueue();
  q.push({ id, name: file.name, size: file.size, folder });
  saveOfflineQueue(q);
  toast("Hors ligne — file d'attente: " + file.name);
  renderOfflineQueue();
}

function renderOfflineQueue() {
  const el = $('#offline-queue');
  if (!el) return;
  const q = loadOfflineQueue();
  el.textContent = q.length ? (q.length + ' fichier(s) en attente hors-ligne') : '';
}

let _flushOfflineBusy = false;
async function flushOfflineQueue() {
  if (_flushOfflineBusy || !navigator.onLine) return;
  _flushOfflineBusy = true;
  try {
    const q = loadOfflineQueue();
    if (!q.length) return;
    const left = [];
    for (const item of q) {
      try {
        const rec = await idbGet(item.id);
        if (!rec || !rec.blob) continue;
        const file = new File([rec.blob], rec.meta.name, { type: rec.meta.type || 'application/octet-stream' });
        await uploadOneChunked(file, rec.meta.folder || 'Inbox');
        await idbDel(item.id);
        toast('Repris: ' + item.name);
      } catch (_) {
        left.push(item);
      }
    }
    saveOfflineQueue(left);
    renderOfflineQueue();
    await refreshFiles();
    await refreshHQ();
  } finally {
    _flushOfflineBusy = false;
  }
}

async function uploadOneChunked(file, folder) {
  const bar = $('#progress');
  const fill = $('#progress-fill');
  const label = $('#progress-label');
  bar.hidden = false;
  fill.style.width = '0%';
  const init = await api('/api/upload/init', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name: file.name, size: file.size, folder })
  });
  const uid = init.id;
  const chunkSize = init.chunk || (2 * 1024 * 1024);
  let offset = 0;
  let index = 0;
  const t0 = performance.now();
  while (offset < file.size) {
    const blob = file.slice(offset, offset + chunkSize);
    const buf = await blob.arrayBuffer();
    const res = await fetch('/api/upload/chunk', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Id': uid,
        'X-Chunk-Index': String(index),
      },
      body: buf,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Chunk échoué');
    offset += blob.size;
    index += 1;
    const pct = Math.round(offset / file.size * 100);
    fill.style.width = pct + '%';
    const sec = (performance.now() - t0) / 1000;
    const speed = sec > 0 ? offset / sec : 0;
    if (label) label.textContent = file.name + ' · ' + pct + '% · ' + fmtBytes(speed) + '/s';
  }
  const done = await api('/api/upload/complete', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ id: uid })
  });
  return done;
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const folder = uploadTargetFolder();
  const bar = $('#progress');
  let ok = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      toast('Envoi ' + (i+1) + '/' + files.length + ' · ' + f.name + ' (' + fmtBytes(f.size) + ')');
      if (!navigator.onLine) {
        await queueOffline(f, folder);
        continue;
      }
      try {
        await uploadOneChunked(f, folder);
        ok++;
      } catch (e) {
        if (!navigator.onLine) await queueOffline(f, folder);
        else throw e;
      }
    }
    if (ok) toast(ok === 1 ? 'Fichier envoyé' : ok + ' fichiers envoyés');
    await refreshFiles();
    await refreshHQ();
  } catch (e) {
    toast(e.message || 'Échec envoi', 'err');
  } finally {
    bar.hidden = true;
  }
}

async function pasteClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find(t => t.startsWith('image/'));
      if (imgType) {
        const blob = await item.getType(imgType);
        const ext = imgType.split('/')[1] || 'png';
        const file = new File([blob], 'Paste_' + Date.now() + '.' + ext, { type: imgType });
        uploadFiles([file]);
        return;
      }
    }
    const text = await navigator.clipboard.readText();
    if (!text.trim()) { toast('Presse-papiers vide', 'err'); return; }
    const data = await api('/api/clipboard', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ text, folder: uploadTargetFolder() })
    });
    toast('Collé: ' + data.name);
    await refreshFiles();
  } catch (e) {
    const text = prompt('Colle le texte ici (Safari peut bloquer le presse-papiers):');
    if (!text) return;
    try {
      const data = await api('/api/clipboard', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ text, folder: uploadTargetFolder() })
      });
      toast('Collé: ' + data.name);
      await refreshFiles();
    } catch (err) { toast(err.message, 'err'); }
  }
}

function setupDrop() {
  const zone = $('#drop-zone');
  if (!zone) return;
  const input = $('#file-input');
  const cam = $('#camera-input');
  if (!input) return;
  zone.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    input.click();
  });
  $('#btn-camera').addEventListener('click', (e) => { e.stopPropagation(); cam.click(); });
  input.addEventListener('change', () => { uploadFiles(input.files); input.value=''; });
  cam.addEventListener('change', () => { uploadFiles(cam.files); cam.value=''; });
  ['dragenter','dragover'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); zone.classList.add('drag');
  }));
  ['dragleave','drop'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); zone.classList.remove('drag');
  }));
  zone.addEventListener('drop', e => uploadFiles(e.dataTransfer.files));
}

function setupQR() {
  /* QR = URL de base du pont uniquement (jamais PIN / cookie / token). Serveur décide. */
  if (typeof QRCode === 'undefined') return;
  const lan = $('#qr-lan');
  const ts = $('#qr-ts');
  const ok = (u) => typeof u === 'string' && /^https?:\/\/[^\s?#]+\/$/i.test(u);
  if (lan && ok(lan.dataset.url)) { lan.innerHTML = ''; new QRCode(lan, { text: lan.dataset.url, width: 112, height: 112 }); }
  if (ts && ok(ts.dataset.url)) { ts.innerHTML = ''; new QRCode(ts, { text: ts.dataset.url, width: 112, height: 112 }); }
}

let presenceId = localStorage.getItem('transfert_presence_id') || '';
let favoritesCache = [];
let hqTimer = null;

function deviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  return 'Navigateur';
}

async function beatPresence() {
  try {
    const body = { id: presenceId || undefined, name: deviceName(), kind: 'browser' };
    if (navigator.getBattery) {
      try {
        const b = await navigator.getBattery();
        body.battery = Math.round(b.level * 100);
      } catch (_) {}
    }
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        if (est && typeof est.quota === 'number' && est.quota > 0) {
          body.total = est.quota;
          body.used = est.usage || 0;
          body.free = Math.max(0, est.quota - (est.usage || 0));
        }
      } catch (_) {}
    }
    const data = await api('/api/presence', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    if (data.id && data.id !== presenceId) {
      presenceId = data.id;
      localStorage.setItem('transfert_presence_id', presenceId);
    }
  } catch (_) {}
}

function spaceColor(pctFree) {
  // more free → greener; less free → redder
  const p = Math.max(0, Math.min(100, Number(pctFree) || 0));
  const h = p * 1.2; // 0=red, 120=green
  return `hsl(${h} 72% 42%)`;
}

function spaceBar(label, free, total, freeH, totalH) {
  const f = Number(free) || 0;
  const t = Number(total) || 0;
  const pctFree = t > 0 ? Math.round((f / t) * 1000) / 10 : null;
  const pctUsed = pctFree == null ? 0 : Math.max(0, Math.min(100, 100 - pctFree));
  const color = pctFree == null ? 'var(--muted)' : spaceColor(pctFree);
  const caption = pctFree == null
    ? 'espace n/d'
    : `${escapeHtml(freeH || '?')} libre / ${escapeHtml(totalH || '?')} (${pctFree}%)`;
  return `<div class="space-row">
    <div class="space-top"><span>${escapeHtml(label)}</span><span>${caption}</span></div>
    <div class="space-track" title="${pctFree == null ? 'n/d' : pctFree + '% libre'}">
      <div class="space-fill" style="width:${pctUsed}%;background:${color}"></div>
    </div>
  </div>`;
}

function renderDevices(devices) {
  const el = $('#hq-devices');
  if (!el) return;
  $('#hq-dev-count').textContent = String((devices || []).length);
  if (!devices || !devices.length) {
    el.innerHTML = '<li class="empty-teach"><em>Aucun appareil détecté</em><p class="hint">Ouvre HQ sur ton téléphone (même Tailscale) pour le voir ici</p></li>';
    return;
  }
  el.innerHTML = devices.map(d => {
    const on = d.online !== false;
    const bat = (d.battery != null) ? ` · bat ${d.battery}%` : '';
    const ip = d.ip ? ` · ${escapeHtml(d.ip)}` : '';
    const ago = (d.source !== 'host' && d.ago_sec != null) ? ` · il y a ${d.ago_sec}s` : '';
    let bars = '';
    if (d.disks && d.disks.length) {
      bars = d.disks.map(x => spaceBar(x.name, x.free, x.total, x.free_h, x.total_h)).join('');
    } else if (d.free != null && d.total != null) {
      const label = d.source === 'browser' ? 'Navigateur' : 'Disque';
      bars = spaceBar(label, d.free, d.total, d.free_h, d.total_h);
    } else if (d.disk_error) {
      bars = `<div class="meta">Disque: ${escapeHtml(d.disk_error)}</div>`;
    } else if (d.source === 'tailscale' && /ios|android/i.test(d.os || '')) {
      bars = `<div class="meta">Stockage: n/a (mobile)</div>`;
    } else if (d.source === 'tailscale' && d.online === false) {
      bars = `<div class="meta">Stockage: hors ligne</div>`;
    } else if (d.source === 'tailscale') {
      bars = `<div class="meta">Stockage: probe SSH…</div>`;
    } else {
      bars = spaceBar('Stockage', null, null, null, null);
    }
    const pathLabel = ({lan:'LAN',tailscale:'Tailscale',direct:'Direct',relay:'Relay (lent)',local:'Local',wan:'WAN',offline:'Off',unknown:'?'})[d.path] || (d.path || '');
    const pathBadge = pathLabel ? `<span class="path-badge path-${escapeAttr(d.path || 'unknown')}">${escapeHtml(pathLabel)}</span>` : '';
    return `<li class="device-card" data-device-id="${escapeAttr(d.id || '')}">
      <div class="device-head">
        <span class="dot ${on ? 'on' : 'off'}"></span>
        <strong>${escapeHtml(d.name || '?')}</strong>
        ${pathBadge}
        <span class="device-kind">${escapeHtml(d.kind || '')}${ip}${bat}${ago}</span>
      </div>
      <div class="device-spaces">${bars}</div>
    </li>`;
  }).join('');
}

let transfersCache = [];
let activityCache = [];
let recentsFilter = 'all';

function renderTransfers(items) {
  transfersCache = items || [];
  const el = $('#hq-transfers');
  if (el && document.body.classList.contains('wall')) {
    // wallboard still shows dedicated transfers list
    if (!transfersCache.length) {
      el.innerHTML = '<li class="hint">Aucun transfert récent</li>';
    } else {
      el.innerHTML = transfersCache.slice(0, 12).map(t => {
        const st = t.state === 'active' ? 'en cours' : (t.state === 'done' ? 'ok' : 'erreur');
        return `<li><strong>${escapeHtml(t.name || 'fichier')}</strong> · ${escapeHtml(t.size_h || '')}
          <div class="meta">${escapeHtml(st)} · ${escapeHtml(t.folder || '')}</div></li>`;
      }).join('');
    }
  }
  renderRecents();
}

function renderActivity(items) {
  activityCache = items || [];
  const el = $('#hq-activity');
  if (el && !el.hidden) {
    el.innerHTML = (items || []).slice(0, 14).map(x =>
      `<li><strong>${escapeHtml(x.message || '')}</strong><div class="meta">${escapeHtml(x.at_h || '')} · ${escapeHtml(x.kind || '')}</div></li>`
    ).join('') || '<li class="hint">—</li>';
  }
  renderRecents();
}

function renderRecents() {
  const el = $('#hq-recents');
  if (!el) return;
  const filter = recentsFilter || 'all';
  const rows = [];
  if (filter === 'all' || filter === 'transfers') {
    for (const t of transfersCache.slice(0, 12)) {
      const st = t.state === 'active' ? 'en cours' : (t.state === 'done' ? 'ok' : 'erreur');
      rows.push({
        sort: t.at || 0,
        html: `<li data-kind="transfer"><strong>${escapeHtml(t.name || 'fichier')}</strong> · ${escapeHtml(t.size_h || '')}
          ${t.rel ? ` <button type="button" class="ghost" data-open-rel="${escapeAttr((t.rel||'').split('/').slice(0,-1).join('/') || t.folder || '')}">Dossier</button>` : ''}
          <div class="meta">transfert · ${escapeHtml(st)} · ${escapeHtml(t.folder || '')}</div></li>`
      });
    }
  }
  if (filter === 'all' || filter === 'activity') {
    for (const x of activityCache.slice(0, 14)) {
      rows.push({
        sort: x.at || 0,
        html: `<li data-kind="activity"><strong>${escapeHtml(x.message || '')}</strong>
          <div class="meta">activité · ${escapeHtml(x.at_h || '')} · ${escapeHtml(x.kind || '')}</div></li>`
      });
    }
  }
  if (filter === 'all') rows.sort((a, b) => (b.sort || 0) - (a.sort || 0));
  el.innerHTML = rows.slice(0, 16).map(r => r.html).join('')
    || '<li class="empty-teach"><em>Rien de récent</em><p class="hint">Envoie un fichier depuis Accueil</p></li>';
  $$('[data-open-rel]', el).forEach(b => b.addEventListener('click', () => navigate(b.dataset.openRel || '')));
}

function setupRecentsFilters() {
  $$('#recents-filters [data-recents]').forEach(b => b.addEventListener('click', () => {
    recentsFilter = b.dataset.recents || 'all';
    $$('#recents-filters [data-recents]').forEach(x => {
      const on = x === b;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderRecents();
  }));
}

let _busyTimer = null;
function startBusy(label, localId) {
  const global = $('#op-busy');
  const local = localId ? $('#' + localId) : null;
  const targets = [global, local].filter(Boolean);
  const t0 = Date.now();
  targets.forEach(el => {
    el.hidden = false;
    const lab = el.querySelector('.busy-text') || $('#op-busy-label');
    if (lab && label) lab.textContent = label;
  });
  if (_busyTimer) clearInterval(_busyTimer);
  const tick = () => {
    const sec = Math.round((Date.now() - t0) / 1000) + 's';
    targets.forEach(el => {
      const e = el.querySelector('.busy-elapsed') || (el.id === 'op-busy' ? $('#op-busy-elapsed') : null);
      if (e) e.textContent = sec;
    });
    if ($('#op-busy-elapsed') && global && !global.hidden) $('#op-busy-elapsed').textContent = sec;
  };
  tick();
  _busyTimer = setInterval(tick, 250);
  return () => {
    if (_busyTimer) { clearInterval(_busyTimer); _busyTimer = null; }
    targets.forEach(el => { el.hidden = true; });
    if (global) global.hidden = true;
  };
}
async function withBusy(label, fn, localId) {
  const stop = startBusy(label, localId);
  try { return await fn(); }
  finally { stop(); }
}

function renderFavorites() {
  const el = $('#hq-favorites');
  if (!el) return;
  if (!favoritesCache.length) {
    el.innerHTML = '<span class="hint">Aucun favori — ouvre un dossier puis « Épingler »</span>';
    return;
  }
  el.innerHTML = favoritesCache.map(f =>
    `<button type="button" class="chip" data-fav="${escapeAttr(f)}">${escapeHtml(f)}</button>`
  ).join('');
  $$('[data-fav]', el).forEach(b => b.addEventListener('click', () => navigate(b.dataset.fav)));
}

function renderCustomActions(actions) {
  const el = $('#hq-custom-actions');
  if (!el) return;
  el.innerHTML = (actions || []).map(a =>
    `<button type="button" class="secondary" data-action="${escapeAttr(a.id)}">${escapeHtml(a.label || a.id)}</button>`
  ).join('');
  $$('[data-action]', el).forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Lancer « ' + b.textContent + ' » sur le PC ?')) return;
    try {
      await withBusy('Action…', () => api('/api/pc/action', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ id: b.dataset.action })
      }));
      toast('Action lancée');
    } catch (e) { toast(e.message, 'err'); }
  }));
}

function renderLauncher(_actions) {
  // Merged into Actions PC (hq-custom-actions) + Scènes
}

async function refreshHQ() {
  try {
    // Critical path first — don't wait on slow health/printers to paint the roster.
    const [st, dev, tr] = await Promise.all([
      api('/api/status', { timeoutMs: 12000 }),
      api('/api/devices', { timeoutMs: 12000 }),
      api('/api/transfers', { timeoutMs: 12000 }),
    ]);
    if ($('#hq-uptime')) $('#hq-uptime').textContent = st.uptime_h || '—';
    const disk = st.disk_transfert || st.disk_d || {};
    if ($('#hq-disk')) $('#hq-disk').textContent = (disk.free_h || '?') + ' libre / ' + (disk.total_h || '?');
    if ($('#hq-host')) $('#hq-host').textContent = st.hostname || '—';
    if ($('#hq-max')) $('#hq-max').textContent = st.max_upload_h || '—';
    const chip = $('#status-chip');
    if (chip) {
      const free = disk.free_h || '?';
      chip.textContent = '● ' + (st.hostname || 'PC') + ' · ' + free;
    }
    renderDevices(dev.devices || []);
    renderTransfers(tr.transfers || []);
    favoritesCache = st.favorites || favoritesCache || [];
    renderFavorites();
    renderCustomActions(st.actions || []);
    renderScenes(st.scenes || []);
    renderLauncher(st.actions || []);
    renderTerminalCmds(st.terminal_commands || []);
    fillShellTargets(st.shell_targets || []);
    fillSendTargets(dev.devices || []);
  } catch (e) {
    if ($('#hq-dev-count')) $('#hq-dev-count').textContent = '!';
    const el = $('#hq-devices');
    if (el && /Chargement/.test(el.textContent || '')) {
      el.innerHTML = `<li class="hint">Erreur HQ: ${escapeHtml(e.message || 'réseau')}</li>`;
    }
  }
  // Secondary — best effort, never blocks first paint
  try {
    const [fav, act, al, med, health, q] = await Promise.all([
      api('/api/favorites', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/activity', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/alerts', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/media/recent', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/health', { timeoutMs: 10000 }).catch(() => ({})),
      api('/api/queue', { timeoutMs: 10000 }).catch(() => ({})),
    ]);
    if (fav.favorites) { favoritesCache = fav.favorites; renderFavorites(); }
    if ($('#hq-health') && health && health.hostname) {
      const smb = health.smb_transfert?.ok ? 'SMB OK' : 'SMB off';
      const ts = health.tailscale?.ok ? 'Tailscale OK' : 'Tailscale off';
      $('#hq-health').textContent = ts + ' · ' + smb;
    }
    renderActivity(act.activity || []);
    renderAlerts(al.alerts || []);
    renderMedia(med.items || []);
    renderQueue(q.queue || []);
    if ($('#home-chart')) await renderHomeChart();
    await loadKanban();
    await loadPrinters();
    renderOfflineQueue();
    await pollInbox();
    const me = await api('/api/me', { timeoutMs: 8000 }).catch(() => null);
    if (me && $('#hq-role')) $('#hq-role').textContent = (me.user || '') + ' · ' + (me.role || '');
  } catch (_) {}
}

async function renderHomeChart() {
  const el = $('#home-chart');
  if (!el) return;
  try {
    const data = await api('/api/presence/history');
    const hist = data.history || [];
    if (!hist.length) { el.innerHTML = '<span class="hint">Pas encore d\'historique</span>'; return; }
    const max = Math.max(1, ...hist.map(h => h.online || 0));
    const w = el.clientWidth || 280;
    const h = 64;
    const step = w / Math.max(1, hist.length - 1);
    const pts = hist.map((p, i) => {
      const x = i * step;
      const y = h - ((p.online || 0) / max) * (h - 4) - 2;
      return x + ',' + y;
    }).join(' ');
    const last = hist[hist.length - 1] || {};
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
      <polyline fill="none" stroke="var(--accent2)" stroke-width="2" points="${pts}"/></svg>
      <div class="meta">Maintenant: ${last.online||0} online · LAN ${last.lan||0} · TS ${last.tailscale||0} · relay ${last.relay||0}</div>`;
  } catch (_) {}
}

function renderTerminalCmds(cmds) {
  const el = $('#term-cmds');
  if (!el) return;
  el.innerHTML = (cmds || []).map(c =>
    `<button type="button" class="secondary" data-term="${escapeAttr(c.id)}">${escapeHtml(c.label||c.id)}</button>`
  ).join('');
  $$('[data-term]', el).forEach(b => b.addEventListener('click', async () => {
    try {
      const data = await api('/api/terminal', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: b.dataset.term }) });
      const head = data.ok === false ? ('exit ' + (data.code ?? '?') + '\n') : '';
      const out = $('#shell-out') || $('#term-out');
      if (out) out.textContent = head + (data.stdout || '') + (data.stderr ? '\n' + data.stderr : '');
    } catch (e) { toast(e.message, 'err'); }
  }));
}

function fillShellTargets(targets) {
  const sel = $('#shell-target');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = (targets || []).map(t => {
    const off = t.online === false ? ' (off)' : '';
    return `<option value="${escapeAttr(t.id)}">${escapeHtml(t.label || t.id)}${off}</option>`;
  }).join('') || '<option value="local">Ce PC (local)</option>';
  if (cur) sel.value = cur;
}

async function loadKanban() {
  const el = $('#kanban');
  if (!el) return;
  try {
    const board = await api('/api/kanban');
    el.innerHTML = (board.columns || []).map(col => {
      const cards = (col.cards || []).map(c =>
        `<div class="kcard" data-card="${escapeAttr(c.id)}">
          <div>${escapeHtml(c.title||'')}</div>
          <div class="row-actions">
            <button type="button" class="ghost" data-km="todo" data-id="${escapeAttr(c.id)}">Todo</button>
            <button type="button" class="ghost" data-km="doing" data-id="${escapeAttr(c.id)}">Do</button>
            <button type="button" class="ghost" data-km="done" data-id="${escapeAttr(c.id)}">Done</button>
            <button type="button" class="danger" data-kd="${escapeAttr(c.id)}">×</button>
          </div>
        </div>`
      ).join('') || '<div class="hint">Vide</div>';
      return `<div class="kcol"><h3>${escapeHtml(col.title||col.id)}</h3>${cards}
        <button type="button" class="secondary" data-ka="${escapeAttr(col.id)}">+ Carte</button></div>`;
    }).join('');
    $$('[data-ka]', el).forEach(b => b.addEventListener('click', async () => {
      const title = prompt('Titre de la carte:');
      if (!title) return;
      await api('/api/kanban', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'add', column: b.dataset.ka, title }) });
      await loadKanban();
    }));
    $$('[data-km]', el).forEach(b => b.addEventListener('click', async () => {
      await api('/api/kanban', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'move', id: b.dataset.id, column: b.dataset.km }) });
      await loadKanban();
    }));
    $$('[data-kd]', el).forEach(b => b.addEventListener('click', async () => {
      await api('/api/kanban', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'delete', id: b.dataset.kd }) });
      await loadKanban();
    }));
  } catch (_) {}
}

async function loadPrinters() {
  const sel = $('#print-printer');
  if (!sel) return;
  try {
    const data = await api('/api/printers');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Par défaut</option>' + (data.printers||[]).map(p =>
      `<option value="${escapeAttr(p.name)}">${escapeHtml(p.name)}${p.default?' ★':''}</option>`
    ).join('');
    if (cur) sel.value = cur;
  } catch (_) {}
}

async function runSearch() {
  const q = ($('#global-search')?.value || '').trim();
  const el = $('#search-hits');
  if (!el) return;
  if (q.length < 2) { el.innerHTML = ''; return; }
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(q));
    el.innerHTML = (data.hits||[]).map(h =>
      `<li><button type="button" class="fname" data-srel="${escapeAttr(h.rel)}" style="background:none;border:0;padding:0;color:var(--accent)">${escapeHtml(h.name)}</button>
      <div class="meta">${escapeHtml(h.rel)} · ${escapeHtml(h.match)}${h.snippet? ' — '+escapeHtml(h.snippet):''}</div></li>`
    ).join('') || '<li class="hint">Aucun résultat</li>';
    $$('[data-srel]', el).forEach(b => b.addEventListener('click', () => {
      const parts = b.dataset.srel.split('/');
      parts.pop();
      navigate(parts.join('/'));
    }));
  } catch (e) { toast(e.message, 'err'); }
}

function renderAlerts(items) {
  const list = items || [];
  const el = $('#hq-alerts');
  const count = $('#hq-alert-count');
  if (count) count.textContent = String(list.length);
  if (!el) return;
  el.innerHTML = list.slice(0, 8).map(x =>
    `<li><strong>${escapeHtml(x.title || '')}</strong><div class="meta">${escapeHtml(x.detail || '')}</div></li>`
  ).join('') || '<li class="hint">Aucune alerte</li>';
}

function renderMedia(items) {
  const el = $('#hq-media');
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<div class="empty-teach"><em>Aucune image récente</em><p class="hint">Les captures et photos apparaîtront ici</p></div>';
    return;
  }
  el.innerHTML = items.map(m => {
    const href = '/files/' + m.rel.split('/').map(encodeURIComponent).join('/');
    return `<a href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${escapeAttr(m.name)}"/></a>`;
  }).join('');
}

function renderRecentsEmptyHint() {
  const el = $('#hq-recents');
  if (!el) return;
  if ((transfersCache.length + activityCache.length) === 0) {
    el.innerHTML = '<li class="hint empty-teach"><em>Rien de récent</em><p class="hint">Envoie un fichier depuis Accueil</p></li>';
  }
}

function renderScenes(scenes) {
  const el = $('#hq-scenes');
  if (!el) return;
  el.innerHTML = (scenes || []).map(s =>
    `<button type="button" class="secondary" data-scene="${escapeAttr(s.id)}">${escapeHtml(s.label || s.id)}</button>`
  ).join('');
  $$('[data-scene]', el).forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Lancer la scène « ' + b.textContent + ' » ?')) return;
    try {
      await api('/api/scene', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: b.dataset.scene }) });
      toast('Scène lancée');
      await refreshHQ();
    } catch (e) { toast(e.message, 'err'); }
  }));
}

function renderQueue(items) {
  const el = $('#hq-queue');
  if (!el) return;
  el.innerHTML = (items || []).slice(0, 8).map(j =>
    `<li><strong>${escapeHtml(j.label || '')}</strong><div class="meta">${escapeHtml(j.status || '')} · ${escapeHtml(j.when || '')}</div></li>`
  ).join('') || '<li class="hint">File vide</li>';
}

function fillSendTargets(devices) {
  const sel = $('#send-to');
  if (!sel) return;
  const cur = sel.value;
  const opts = ['<option value="">Choisir…</option>', '<option value="all">Tous les navigateurs</option>'];
  (devices || []).filter(d => d.source === 'browser').forEach(d => {
    opts.push(`<option value="${escapeAttr(d.id)}">${escapeHtml(d.name)} (${escapeHtml(d.path || '')})</option>`);
  });
  sel.innerHTML = opts.join('');
  if (cur) sel.value = cur;
}

async function pollInbox() {
  if (!presenceId) return;
  try {
    const data = await api('/api/inbox?id=' + encodeURIComponent(presenceId) + '&clear=1');
    for (const it of (data.items || [])) {
      toast((it.from || 'Quelqu’un') + ' t’a envoyé: ' + (it.rel || ''), 'ok', 6000);
    }
  } catch (_) {}
}

let scratchTimer = null;
let scratchMtime = 0;
async function loadScratchpad() {
  try {
    const data = await api('/api/scratchpad');
    const box = $('#scratchpad');
    if (!box) return;
    if (document.activeElement !== box && data.mtime !== scratchMtime) {
      box.value = data.text || '';
      scratchMtime = data.mtime;
    }
  } catch (_) {}
}
async function saveScratchpad() {
  const box = $('#scratchpad');
  if (!box) return;
  try {
    const data = await api('/api/scratchpad', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ text: box.value })
    });
    scratchMtime = data.mtime;
    toast('Bloc-notes enregistré');
  } catch (e) { toast(e.message, 'err'); }
}

function setupHQ() {
  if (!$('#hq-devices') && !$('#btn-lock')) return;
  $('#btn-lock')?.addEventListener('click', async () => {
    if (!confirm('Verrouiller le PC ?')) return;
    try { await api('/api/pc/lock', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }); toast('PC verrouillé'); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-sleep')?.addEventListener('click', async () => {
    if (!confirm('Mettre le PC en veille ?')) return;
    try { await api('/api/pc/sleep', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }); toast('Veille…'); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-shot')?.addEventListener('click', async () => {
    try {
      const data = await api('/api/pc/screenshot', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'
      });
      toast('Capture: ' + data.name);
      await refreshFiles();
      await refreshHQ();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-sync-captures')?.addEventListener('click', async () => {
    try {
      const data = await withBusy('Récupération des captures…', () => api('/api/captures/sync', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}'
      }));
      toast('Captures: ' + (data.local||0) + ' ici · ' + (data.remote||0) + ' distantes');
      await refreshFiles();
      await refreshHQ();
      if ((data.remote||0) + (data.local||0) > 0) navigate('Inbox/Captures');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-explore')?.addEventListener('click', async () => {
    try {
      await api('/api/pc/explore', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ path: currentRel || 'Inbox' })
      });
      toast('Explorateur ouvert');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-clip-to-pc')?.addEventListener('click', clipToPc);
  $('#btn-clip-from-pc')?.addEventListener('click', clipFromPc);
  $('#btn-fav-toggle')?.addEventListener('click', toggleFavorite);
  $('#btn-scratch-save')?.addEventListener('click', saveScratchpad);
  $('#btn-send')?.addEventListener('click', async () => {
    const to = $('#send-to')?.value;
    const rel = ($('#send-rel')?.value || '').trim();
    if (!to || !rel) { toast('Destinataire + fichier requis', 'err'); return; }
    try {
      await api('/api/send', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ to, rel, from: deviceName(), from_id: presenceId })
      });
      toast('Envoyé');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-queue-add')?.addEventListener('click', async () => {
    const label = prompt('Nom de la tâche (ex: Ouvrir Uni au réveil):', 'Ouvrir Uni');
    if (!label) return;
    try {
      await api('/api/queue', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ label, when: 'online', type: 'explore', path: 'D:/Transfert/Uni' })
      });
      toast('Ajouté à la file');
      await refreshHQ();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-backup')?.addEventListener('click', async () => {
    if (!confirm('Lancer un backup maintenant ?')) return;
    try {
      const d = await withBusy('Backup…', () => api('/api/backup', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }), 'backup-busy');
      toast(d.path || 'Backup OK');
    }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-iz-archive')?.addEventListener('click', async () => {
    if (!confirm('Archiver les fichiers de Inbox ?')) return;
    try { const d = await api('/api/inbox-zero', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'archive' }) }); toast(d.moved + ' fichier(s) archivé(s)'); await refreshFiles(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-iz-sort')?.addEventListener('click', async () => {
    try { const d = await api('/api/inbox-zero', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'sort' }) }); toast(d.moved + ' fichier(s) trié(s)'); await refreshFiles(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-iz-tmp')?.addEventListener('click', async () => {
    try { const d = await api('/api/inbox-zero', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'empty-tmp' }) }); toast((d.removed||0) + ' fichier(s) tmp supprimé(s)'); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#global-search')?.addEventListener('input', () => { clearTimeout(window._sq); window._sq = setTimeout(runSearch, 280); });
  $('#btn-print')?.addEventListener('click', async () => {
    const rel = ($('#print-rel')?.value || '').trim();
    if (!rel) { toast('Indique Print/fichier…', 'err'); return; }
    if (!confirm('Imprimer ' + rel + ' ?')) return;
    try {
      await api('/api/print', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ rel, printer: $('#print-printer')?.value || '' })
      });
      toast("Envoyé à l'imprimante");
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-print-preview')?.addEventListener('click', () => {
    const rel = ($('#print-rel')?.value || '').trim();
    if (!rel) return;
    window.open('/files/' + rel.split('/').map(encodeURIComponent).join('/'), '_blank');
  });
  $('#btn-shell-run')?.addEventListener('click', async () => {
    const cmd = ($('#shell-cmd')?.value || '').trim();
    if (!cmd) { toast('Commande vide', 'err'); return; }
    const target = $('#shell-target')?.value || 'local';
    const shell = $('#shell-type')?.value || 'powershell';
    if (!confirm('Exécuter sur ' + target + ' ?\n\n' + cmd)) return;
    $('#shell-out').textContent = '…';
    try {
      const data = await withBusy('Shell…', () => api('/api/shell', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ target, shell, cmd })
      }), 'shell-busy');
      $('#shell-out').textContent =
        (data.ok ? '' : ('exit ' + data.code + '\n')) +
        (data.stdout || '') +
        (data.stderr ? ('\n' + data.stderr) : '');
    } catch (e) {
      $('#shell-out').textContent = e.message;
      toast(e.message, 'err');
    }
  });
  $('#shell-cmd')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-shell-run')?.click();
  });
  window.addEventListener('online', () => { toast('En ligne — reprise file'); flushOfflineQueue(); });
  setupRecentsFilters();
  beatPresence();
  loadScratchpad();
  refreshHQ();
  flushOfflineQueue();
  renderOfflineQueue();
  hqTimer = setInterval(() => {
    if (document.hidden) return;
    beatPresence();
    refreshHQ();
    loadScratchpad();
  }, 8000);
}

async function toggleFavorite() {
  if (!currentRel) { toast("Ouvre un dossier d'abord", 'err'); return; }
  try {
    const data = await api('/api/favorites', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ rel: currentRel })
    });
    favoritesCache = data.favorites || [];
    renderFavorites();
    toast(favoritesCache.includes(currentRel) ? 'Épinglé' : 'Retiré');
  } catch (e) { toast(e.message, 'err'); }
}

async function clipToPc() {
  let text = ($('#clip-box')?.value || '').trim();
  if (!text) {
    try { text = await navigator.clipboard.readText(); } catch (_) {}
  }
  if (!text) { toast('Rien à envoyer', 'err'); return; }
  try {
    await api('/api/clipboard/pc', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text })
    });
    toast('Copié sur le PC');
  } catch (e) { toast(e.message, 'err'); }
}

async function clipFromPc() {
  try {
    const data = await api('/api/clipboard/pc');
    $('#clip-box').value = data.text || '';
    try { await navigator.clipboard.writeText(data.text || ''); } catch (_) {}
    toast('Presse-papiers PC récupéré');
  } catch (e) { toast(e.message, 'err'); }
}

document.addEventListener('DOMContentLoaded', async () => {
  setupModeToggle();
  setupNav();
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.file-more')) $$('.file-more.open').forEach(m => m.classList.remove('open'));
  });
  $('#note-form')?.addEventListener('submit', submitNote);
  $('#btn-paste')?.addEventListener('click', pasteClipboard);
  $('#btn-mkdir')?.addEventListener('click', mkdir);
  $('#btn-newfile')?.addEventListener('click', createFile);
  $('#btn-up')?.addEventListener('click', () => {
    if (!currentRel) return;
    const parts = currentRel.split('/');
    parts.pop();
    navigate(parts.join('/'));
  });
  $('#search')?.addEventListener('input', () => renderFiles());
  setupDrop();
  setupQR();
  // Warm session, but NEVER leave the UI stuck on "Chargement…"
  let ready = false;
  for (let i = 0; i < 4; i++) {
    try {
      await api('/api/me', { timeoutMs: 8000 });
      ready = true;
      break;
    } catch (e) {
      if (String(e.message || '').includes('PIN')) break;
      await new Promise(r => setTimeout(r, 200));
    }
  }
  setupHQ();
  if (!ready) {
    toast('Session lente — nouvel essai…', 'err');
  }
  refreshFiles().catch(e => toast(e.message, 'err'));
});
"""

BASE_CSS = """
:root {
  color-scheme: light dark;
  --bg:#0c1014; --panel:#161d26; --panel-2:#1c2530; --text:#f3f6fa; --muted:#b7c2ce; --line:#334055;
  --accent:#3dffb5; --accent2:#3dffb5; --ok:#3dffb5; --warn:#e8a838; --danger:#ff5c5c;
  --okbg:#1f8f4e33; --errbg:#ff3b3033; --accent-text:#04140e; --radius:12px;
  --font:system-ui,-apple-system,"Segoe UI",sans-serif;
  --font-mono:ui-monospace,Consolas,monospace;
  --nav-h:64px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg:#f0f3f6; --panel:#ffffff; --panel-2:#e8eef4; --text:#121a22; --muted:#3d4d5c; --line:#c5d0dc;
    --accent:#0b8f62; --accent2:#0b8f62; --ok:#0b8f62; --warn:#b87a12; --danger:#c62828;
    --okbg:#1f8f4e18; --errbg:#ff3b3018; --accent-text:#fff;
  }
}
*{box-sizing:border-box}
body{margin:0;font-family:var(--font);color:var(--text);min-height:100vh;background:var(--bg);line-height:1.45;
  padding-bottom:calc(var(--nav-h) + env(safe-area-inset-bottom,0px))}
.wrap{max-width:720px;margin:0 auto;padding:14px 14px 24px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.brand-lockup{display:flex;align-items:baseline;gap:8px}
.brand{font-size:1.25rem;letter-spacing:-.02em;text-transform:none;color:var(--text);font-weight:800}
.hq-pill{font-size:.65rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:3px 7px;border-radius:999px;
  background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 35%,var(--line))}
.status-chip{border:1px solid var(--line);background:var(--panel-2);color:var(--muted);font:inherit;font-size:.72rem;font-family:var(--font-mono);
  padding:8px 10px;border-radius:999px;cursor:pointer;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.view-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 12px}.view-label{margin:0;font-size:.72rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
h1{font-size:1.7rem;margin:4px 0 6px;letter-spacing:-.02em}
.sub{color:var(--muted);margin:0 0 14px}
[data-panel]{display:none}
body[data-view="accueil"] [data-panel="accueil"],
body[data-view="fichiers"] [data-panel="fichiers"],
body[data-view="ops"] [data-panel="ops"],
body[data-view="plus"] [data-panel="plus"]{display:block}
section{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin-bottom:12px}
section.hq-primary{border-color:color-mix(in srgb,var(--accent) 40%,var(--line));border-left:3px solid var(--accent)}
.sec-head{margin:0 0 14px}
.sec-head h2,.sec-head summary-title{margin:0 0 4px;font-size:1.12rem;font-weight:800;letter-spacing:-.02em;text-transform:none;color:var(--text);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sec-hint{margin:0;font-size:.88rem;color:var(--muted);line-height:1.4;font-weight:500}
section h2{margin:0 0 4px;font-size:1.12rem;font-weight:800;letter-spacing:-.02em;text-transform:none;color:var(--text);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
section.hq-primary h2{color:var(--text)}
details.hq{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px 16px;margin-bottom:12px}
details.hq > summary{cursor:pointer;list-style:none}
details.hq > summary::-webkit-details-marker{display:none}
details.hq > summary .sec-head{margin:0}
details.hq[open] > summary .sec-head{margin-bottom:12px}
.mode-toggle{border:1px solid var(--line);background:var(--panel-2);color:var(--text);font:inherit;font-size:.72rem;font-weight:800;
  padding:8px 10px;border-radius:999px;cursor:pointer;min-height:36px;letter-spacing:.02em}
.mode-toggle[aria-pressed="true"]{border-color:color-mix(in srgb,var(--accent) 45%,var(--line));color:var(--accent)}
body.mode-simple .mode-complet-only{display:none!important}
body.mode-simple .bottom-nav [data-nav="ops"]{display:none}
body.mode-simple[data-view="ops"] [data-panel="ops"]{display:none}
.empty-teach{padding:16px 4px;text-align:center}
.empty-teach em{display:block;font-style:normal;font-weight:700;margin-bottom:6px}
.empty-teach .hint{margin:0}
button.danger-outline,.btn.danger-outline{background:transparent;border:1.5px solid var(--danger);color:var(--danger);padding:7px 10px;font-size:.8rem}
.badge{font-size:.72rem;font-weight:800;padding:3px 8px;border-radius:999px;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent)}
label{display:block;font-weight:700;margin:0 0 6px;font-size:.92rem}
.field{margin-bottom:10px}
input[type=text],input[type=password],input[type=search],select,textarea{
  width:100%;font:inherit;padding:12px 14px;border-radius:12px;border:1px solid var(--line);
  background:color-mix(in srgb,var(--bg) 55%,var(--panel));color:var(--text)}
textarea{min-height:120px;resize:vertical}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:12px;
  background:var(--accent);color:var(--accent-text);font:inherit;font-weight:800;padding:10px 12px;cursor:pointer;text-decoration:none;
  width:auto;max-width:100%;flex:0 0 auto;min-height:44px;-webkit-appearance:none}
button.block,.btn.block,#note-form button[type=submit]{width:100%}
button.secondary,.btn.secondary{background:color-mix(in srgb,var(--text) 10%,transparent);color:var(--text)}
button.danger,.btn.danger{background:transparent;border:1.5px solid var(--danger);color:var(--danger);padding:7px 10px;font-size:.8rem}
button.ghost,.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text);padding:7px 10px;font-size:.8rem;min-height:36px}
.row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.row.stretch > *{flex:1 1 0}
.row:not(.stretch) > *{flex:0 0 auto}
.hint{font-size:.84rem;color:var(--muted);margin:6px 0 0}
.drop{border:1.5px dashed var(--line);border-radius:14px;padding:22px 14px;text-align:center;cursor:pointer;
  transition:.15s background,.15s border-color;background:color-mix(in srgb,var(--bg) 40%,var(--panel))}
.drop.drag{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
.drop strong{display:block;margin-bottom:4px;font-size:1.05rem}
.drop .row{margin-top:12px}
.progress{height:8px;background:var(--line);border-radius:99px;overflow:hidden;margin-top:10px}
.progress > div{height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--ok));transition:width .15s}
.crumbs{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:10px;font-size:.85rem;font-family:var(--font-mono)}
.crumb{border:0;background:transparent;color:var(--accent);font:inherit;font-weight:700;padding:4px 6px;cursor:pointer;min-height:36px}
.crumb:last-child{color:var(--text);cursor:default}
.crumb-sep{color:var(--muted)}
.fm-tools{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;align-items:center}
.fm-tools > button{flex:0 0 auto;width:auto}
.fm-tools input{flex:1 1 140px;min-width:0}
ul.files{list-style:none;padding:0;margin:0}
li.file{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-bottom:1px solid var(--line)}
li.file:last-child{border-bottom:0}
li.file.is-dir .fname{color:var(--ok)}
.fname{font-weight:750;color:var(--text);text-decoration:none;word-break:break-word;font-size:.95rem}
.meta{font-size:.78rem;color:var(--muted);font-family:var(--font-mono)}
.row-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.row-actions .btn, .row-actions button{flex:0 0 auto;width:auto;padding:7px 10px;font-size:.78rem;line-height:1.2}
.file-more{position:relative}
.file-more-menu{display:none;position:absolute;right:0;top:calc(100% + 4px);z-index:20;min-width:160px;padding:6px;
  background:var(--panel-2);border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 28px #0008}
.file-more.open .file-more-menu{display:flex;flex-direction:column;gap:4px}
.file-more-menu .btn,.file-more-menu button,.file-more-menu a{width:100%;justify-content:flex-start}
.qrs{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.qrbox{text-align:center}
.qrbox div{display:inline-block;padding:8px;background:#fff;border-radius:12px;max-width:100%}
.qrbox canvas,.qrbox img{max-width:120px!important;height:auto!important}
.qrbox a{display:block;font-size:.72rem;color:var(--muted);margin-top:6px;word-break:break-all;font-family:var(--font-mono)}
.status dd{margin:2px 0 8px;font-weight:700;word-break:break-all;font-family:var(--font-mono)}
.status dt{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
#toasts{position:fixed;left:50%;bottom:calc(var(--nav-h) + 12px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:99;width:min(92vw,420px);display:grid;gap:8px}
.toast{opacity:0;transform:translateY(8px);transition:.25s;background:var(--panel);border:1px solid var(--line);
  padding:12px 14px;border-radius:12px;box-shadow:0 10px 30px #0004;font-weight:700}
.toast.show{opacity:1;transform:none}
.toast.err{border-color:var(--danger)}
.pin-card{text-align:center;padding:28px 16px}
.pin-card input{text-align:center;letter-spacing:.28em;font-size:1.2rem}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.chip{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:999px;padding:7px 12px;font-weight:700;cursor:pointer;font-size:.85rem;width:auto;flex:0 0 auto;min-height:36px}
.chip.active{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
.hq-status{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0}
.hq-status dt{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);align-self:center}
.hq-status dd{margin:0;font-weight:700;word-break:break-all;font-family:var(--font-mono)}
.hq-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:12px}
.hq-list li{border-bottom:0;font-size:.9rem}.hq-list li:not(.device-card){padding:0}
.hq-list .meta{font-size:.75rem;color:var(--muted)}
.hq-list li.device-card,.device-card{border:1px solid var(--line);border-radius:14px;padding:18px 20px 16px;background:color-mix(in srgb,var(--bg) 40%,var(--panel));box-sizing:border-box}
.device-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-bottom:10px}
.device-head strong{font-size:.98rem}
.device-kind{font-size:.72rem;color:var(--muted);flex:1 1 auto}
.device-spaces{display:flex;flex-direction:column;gap:8px}
.space-row{display:flex;flex-direction:column;gap:4px}
.space-top{display:flex;justify-content:space-between;gap:8px;font-size:.72rem;color:var(--muted)}
.space-top span:first-child{font-weight:800;color:var(--text)}
.space-track{height:10px;border-radius:99px;background:color-mix(in srgb,var(--line) 80%,transparent);overflow:hidden}
.space-fill{height:100%;width:0;border-radius:99px;transition:width .35s ease,background .35s ease}
.path-badge{font-size:.65rem;font-weight:800;padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.path-badge.path-lan,.path-badge.path-direct,.path-badge.path-local{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,var(--line))}
.path-badge.path-tailscale{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,var(--line))}
.path-badge.path-relay{color:#e8a838;border-color:#e8a83866}
.path-badge.path-offline,.path-badge.path-unknown{opacity:.7}
.media-strip{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch}
.media-strip a{flex:0 0 auto;width:88px;height:88px;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:color-mix(in srgb,var(--bg) 50%,transparent)}
.media-strip img{width:100%;height:100%;object-fit:cover;display:block}
.launcher{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.launch{display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 8px;border-radius:14px;border:1px solid var(--line);background:color-mix(in srgb,var(--bg) 40%,var(--panel));color:var(--text);font:inherit;font-weight:700;cursor:pointer;min-height:44px}
.launch span{font-size:1.4rem}
.kanban{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
@media(max-width:700px){.kanban{grid-template-columns:1fr}}
.kcol{border:1px solid var(--line);border-radius:12px;padding:8px;background:color-mix(in srgb,var(--bg) 35%,var(--panel));min-height:120px}
.kcol h3{margin:0 0 8px;font-size:.85rem}
.kcard{border:1px solid var(--line);border-radius:10px;padding:8px;margin-bottom:6px;background:var(--panel);font-size:.85rem}
.term-out{background:#0a0e14;color:#c6f6d5;border-radius:10px;padding:10px;min-height:80px;max-height:220px;overflow:auto;font-size:.75rem;white-space:pre-wrap;font-family:var(--font-mono)}
.home-chart{min-height:72px}
.icon-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.icon-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:56px;padding:10px 6px;
  border-radius:12px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);font:inherit;font-weight:700;cursor:pointer}
.icon-btn .ico{font-size:1.25rem;line-height:1}
.icon-btn .lbl{font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.bottom-nav{position:fixed;left:0;right:0;bottom:0;z-index:80;display:grid;grid-template-columns:repeat(4,1fr);gap:0;
  background:color-mix(in srgb,var(--panel) 92%,transparent);border-top:1px solid var(--line);
  padding:6px 8px calc(6px + env(safe-area-inset-bottom,0px));backdrop-filter:blur(10px)}
.bottom-nav button{background:transparent;color:var(--muted);border:0;border-radius:10px;padding:8px 4px;font-size:.68rem;
  font-weight:800;letter-spacing:.02em;text-transform:uppercase;min-height:52px;flex-direction:column;gap:2px}
.bottom-nav button.active{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
.bottom-nav .nav-ico{font-size:1.1rem}
body.theme-oled{--bg:#000;--panel:#0a0a0a;--panel-2:#111;--line:#222}
body.theme-midnight{--bg:#0b1220;--panel:#121a2b;--accent:#7dd3fc;--accent2:#7dd3fc}
body.kiosk .wrap{max-width:100%;padding:10px}
body.kiosk .bottom-nav{display:none}
.hq-actions{justify-content:flex-start}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:2px;background:var(--muted);flex:0 0 auto}
.dot.on{background:var(--ok)}
.dot.off{background:var(--danger)}
@media (max-width:520px){
  .qrs{grid-template-columns:1fr}
  .wrap{padding:12px 12px 20px}
  .icon-actions{grid-template-columns:repeat(4,minmax(0,1fr))}
}
@media (min-width:900px){
  body{padding-bottom:0;display:grid;grid-template-columns:148px 1fr;min-height:100vh}
  .bottom-nav{position:sticky;top:0;left:auto;right:auto;bottom:auto;height:100vh;width:148px;grid-template-columns:1fr;
    border-top:0;border-right:1px solid var(--line);padding:16px 10px;align-content:start;gap:6px;order:0}
  .wrap{order:1;max-width:980px;padding:20px 24px 40px}
  #toasts{bottom:18px}
  .op-busy{bottom:72px}
  body[data-view="accueil"] .accueil-grid{display:grid;grid-template-columns:1.15fr 0.95fr;gap:12px;align-items:start}
  .accueil-side{display:flex;flex-direction:column;gap:0}
}
.skip-link{position:absolute;left:-9999px;top:0;z-index:100;background:var(--accent);color:var(--accent-text);padding:10px 14px;font-weight:800;border-radius:0 0 8px 0}
.skip-link:focus{left:0}
.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}
.fav-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.fav-bar .chips{margin:0;flex:1 1 auto}
.note-acc{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
.note-acc > summary{cursor:pointer;font-size:.75rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.note-acc[open] > summary{margin-bottom:10px;color:var(--text)}
.filter-chips{margin-bottom:10px}
[hidden]{display:none!important}
.busy-line,.op-busy{display:flex;align-items:center;gap:8px;margin-top:8px;padding:8px 10px;border-radius:10px;
  background:color-mix(in srgb,var(--accent) 12%,var(--panel-2));border:1px solid color-mix(in srgb,var(--accent) 30%,var(--line));
  font-size:.8rem;font-family:var(--font-mono);color:var(--text)}
.op-busy{position:fixed;left:50%;bottom:calc(var(--nav-h) + 56px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);
  z-index:90;width:min(92vw,420px);margin:0}
.busy-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1s infinite}
.busy-elapsed{margin-left:auto;color:var(--muted)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.skeleton{opacity:.7}
li.hint.skeleton::after{content:'';display:inline-block;width:4ch;animation:pulse 1.2s infinite}
"""


def render_wallboard() -> bytes:
    page = f"""<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="theme-color" content="#070b10"/>
<title>Transfert HQ · Wallboard</title>
<link rel="stylesheet" href="/assets/hq.css"/>
<style>{BASE_CSS}
body.wall{{background:#070b10}}
.wall .wrap{{max-width:1100px;padding:16px}}
.wall h1{{font-size:1.6rem;margin:0 0 12px}}
.wall-grid{{display:grid;grid-template-columns:1.2fr 1fr;gap:12px}}
@media(max-width:800px){{.wall-grid{{grid-template-columns:1fr}}}}
.wall .hq-list{{max-height:42vh;overflow:auto}}
.media-strip{{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px}}
.media-strip a{{flex:0 0 auto;width:96px;height:96px;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:#111}}
.media-strip img{{width:100%;height:100%;object-fit:cover}}
</style>
<script src="/assets/qrcode.min.js"></script>
</head>
<body class="wall">
<script>
(() => {{
  const q = new URLSearchParams(location.search);
  const theme = q.get('theme');
  if (theme) document.body.classList.add('theme-' + theme);
  if (q.get('kiosk') === '1') {{
    document.body.classList.add('kiosk');
    const goFs = () => document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    document.addEventListener('click', goFs, {{ once: true }});
  }}
}})();
</script>
<div class="wrap">
  <header>
    <div class="brand">Transfert HQ</div>
    <h1>Wallboard</h1>
    <p class="sub" id="wb-health" aria-live="polite">Santé…</p>
    <p class="sub" id="fleet-state">Flotte…</p>
  </header>
  <section class="hq" aria-labelledby="fleet-title">
    <h2 id="fleet-title">Flotte</h2>
    <div id="fleet-map" class="fleet-map"></div>
  </section>
  <section class="hq" aria-labelledby="wb-presence-title">
    <h2 id="wb-presence-title">Qui est là ?</h2>
    <div id="home-chart" class="home-chart"></div>
  </section>
  <div class="wall-grid">
    <section class="hq"><h2>Appareils</h2><ul class="hq-list" id="hq-devices"></ul></section>
    <section class="hq"><h2>Activité</h2><ul class="hq-list" id="wb-activity"></ul></section>
    <section class="hq"><h2>Transferts</h2><ul class="hq-list" id="hq-transfers"></ul></section>
    <section class="hq"><h2>Alertes</h2><ul class="hq-list" id="wb-alerts"></ul></section>
  </div>
  <section class="hq" style="margin-top:12px"><h2>Médias récents</h2><div class="media-strip" id="wb-media"></div></section>
  <section class="hq status" style="margin-top:12px">
    <h2>Accès QR</h2>
    <p class="hint">QR = URL du pont seulement (pas de PIN ni de session).</p>
    <div class="qrs">
      <div class="qrbox"><div id="qr-lan" data-url=""></div><a id="qr-lan-link" href="#">LAN</a></div>
      <div class="qrbox"><div id="qr-ts" data-url=""></div><a id="qr-ts-link" href="#">Tailscale</a></div>
    </div>
  </section>
<p class="hint"><a href="/" style="color:var(--accent)">← HQ</a></p>
</div>
<script>
{APP_JS}
// wallboard extras
async function refreshWall() {{
  try {{
    const [h, act, al, med, st] = await Promise.all([
      api('/api/health'), api('/api/activity'), api('/api/alerts'), api('/api/media/recent'), api('/api/status')
    ]);
    const smb = h.smb_transfert?.ok ? 'SMB OK' : 'SMB ?';
    const ts = h.tailscale?.ok ? ('TS ' + (h.tailscale.ip||'')) : 'TS off';
    $('#wb-health').textContent = (h.hostname||'') + ' · up ' + Math.round((h.uptime_sec||0)/60) + 'm · ' + ts + ' · ' + smb + ' · D: ' + (h.disk_d?.free_h||'?');
    const ael = $('#wb-activity');
    ael.innerHTML = (act.activity||[]).slice(0,20).map(x => `<li><strong>${{escapeHtml(x.message||'')}}</strong><div class="meta">${{escapeHtml(x.at_h||'')}} · ${{escapeHtml(x.kind||'')}}</div></li>`).join('') || '<li class="hint">—</li>';
    const lel = $('#wb-alerts');
    lel.innerHTML = (al.alerts||[]).slice(0,12).map(x => `<li><strong>${{escapeHtml(x.title||'')}}</strong><div class="meta">${{escapeHtml(x.detail||'')}}</div></li>`).join('') || '<li class="hint">Aucune</li>';
    const mel = $('#wb-media');
    mel.innerHTML = (med.items||[]).map(m => `<a href="/files/${{m.rel.split('/').map(encodeURIComponent).join('/')}}" target="_blank"><img src="/files/${{m.rel.split('/').map(encodeURIComponent).join('/')}}" alt=""/></a>`).join('') || '<span class="hint">Aucun média</span>';
    // Serveur décide des URLs QR (LAN / Tailscale / Serve) — jamais depuis le client
    const qrList = Array.isArray(st.urls?.qr) ? st.urls.qr : [];
    const lan = (qrList.find(x => x.label === 'LAN') || {{}}).url || st.urls?.lan || '';
    const tsu = (qrList.find(x => x.label === 'Tailscale') || {{}}).url || st.urls?.tailscale || '';
    const okUrl = (u) => typeof u === 'string' && /^https?:\\/\\/[^\\s?#]+\\/$/i.test(u);
    const setQr = (id, url, label) => {{
      const box = document.getElementById(id);
      const link = document.getElementById(id + '-link');
      if (!box) return;
      const safe = okUrl(url) ? url : '';
      box.dataset.url = safe;
      box.innerHTML = '';
      if (safe && window.QRCode) {{
        try {{ new QRCode(box, {{ text: safe, width: 120, height: 120 }}); }} catch (_) {{}}
      }}
      if (link) {{ link.href = safe || '#'; link.textContent = safe ? (label + ' · ' + safe) : (id === 'qr-ts' ? 'Tailscale off' : 'LAN'); }}
    }};
    setQr('qr-lan', lan, 'LAN');
    setQr('qr-ts', tsu, 'Tailscale');
    await refreshHQ();
    if (typeof renderHomeChart === 'function') await renderHomeChart();
  }} catch(e) {{ $('#wb-health').textContent = e.message; }}
}}
document.addEventListener('DOMContentLoaded', () => {{
  refreshWall();
  setInterval(refreshWall, 6000);
}});
</script>
<script src="/assets/hq.js"></script>
</body></html>"""
    return page.encode("utf-8")


def render_login(flash: str = "", error: bool = False) -> bytes:
    box = f'<div class="toast show {"err" if error else ""}" style="position:static;margin:12px 0">{html.escape(flash)}</div>' if flash else ""
    page = f"""<!DOCTYPE html><html lang="fr"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="theme-color" content="#0f1419"/>
<link rel="manifest" href="/manifest.webmanifest"/>
<link rel="apple-touch-icon" href="/icon-192.png"/>
<title>Transfert · PIN</title><style>{BASE_CSS}</style>
<script>try{{sessionStorage.removeItem('tf_auth_redirect');sessionStorage.removeItem('tf_auth_at');}}catch(e){{}}</script>
</head><body>
<div class="wrap"><section class="pin-card">
<div class="brand">Transfert Bridge</div>
<h1>Code PIN</h1>
<p class="sub">Accès au pont fichiers / notes</p>
{box}
<form method="post" action="/login">
<input name="pin" type="password" inputmode="numeric" required placeholder="••••••" autofocus autocomplete="one-time-code"/>
<button type="submit" style="width:100%;margin-top:12px">Continuer</button>
</form>
<p class="hint">PIN dans bridge_config.json</p>
</section></div></body></html>"""
    return page.encode("utf-8")


def render_app() -> bytes:
    folders = list(CONFIG.get("folders") or DEFAULT_FOLDERS)
    default_folder = valid_folder(CONFIG.get("default_folder"))
    # QR payloads: server-built base URLs only (label LAN / Tailscale / Serve) — never PIN
    _qr = {e["label"]: e["url"] for e in public_bridge_urls() if e["label"] in ("LAN", "Tailscale", "Serve")}
    lan_url = _qr.get("LAN") or ""
    ts_url = _qr.get("Tailscale") or ""
    chips = ""  # file manager breadcrumbs replace chips
    opts = "".join(
        f'<option value="{html.escape(f)}"{" selected" if f == default_folder else ""}>{html.escape(f)}</option>'
        for f in folders
    )
    qr_lan = (
        f'<div class="qrbox"><div id="qr-lan" data-url="{html.escape(lan_url)}"></div>'
        f'<a href="{html.escape(lan_url)}">LAN · {html.escape(lan_url)}</a></div>'
        if lan_url
        else '<div class="qrbox"><em class="hint">LAN indisponible</em></div>'
    )
    qr_ts = (
        f'<div class="qrbox"><div id="qr-ts" data-url="{html.escape(ts_url)}"></div>'
        f'<a href="{html.escape(ts_url)}">Tailscale · {html.escape(ts_url)}</a></div>'
        if ts_url
        else '<div class="qrbox"><em class="hint">Installe Tailscale pour un QR distant</em></div>'
    )
    page = f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-title" content="Transfert HQ"/>
<meta name="theme-color" content="#0c1014"/>
<link rel="manifest" href="/manifest.webmanifest"/>
<link rel="apple-touch-icon" href="/icon-192.png"/>
<title>Transfert HQ</title>
<style>{BASE_CSS}</style>
<link rel="stylesheet" href="/assets/hq.css"/>
<script src="/assets/qrcode.min.js"></script>
</head>
<body data-view="accueil">
<a class="skip-link" href="#main">Aller au contenu</a>
<nav class="bottom-nav" aria-label="Navigation HQ">
  <button type="button" class="active" data-nav="accueil"><span class="nav-ico">⌂</span>Accueil</button>
  <button type="button" data-nav="fichiers"><span class="nav-ico">📁</span>Fichiers</button>
  <button type="button" data-nav="ops"><span class="nav-ico">⚡</span>Terminal</button>
  <button type="button" data-nav="plus"><span class="nav-ico">⋯</span>Plus</button>
</nav>
<main class="wrap" id="main">
  <header class="topbar" role="banner">
    <div class="brand-lockup">
      <div class="brand">Transfert</div>
      <span class="hq-pill">HQ</span>
    </div>
    <button type="button" class="status-chip" id="status-chip" title="Statut">● …</button>
  </header>
  <div class="view-bar">
    <p class="view-label" id="view-label">Accueil</p>
    <button type="button" class="mode-toggle" id="mode-toggle" aria-pressed="true" title="Masquer Ops avancé">Mode simple</button>
  </div>

  <div data-panel="accueil" class="accueil-grid">
    <section id="hq-banner" class="hq hq-banner state-ok" aria-live="polite">
      <div class="hq-banner-row">
        <span class="hq-state-dot" id="hq-state-dot" aria-hidden="true"></span>
        <div>
          <strong id="hq-state-label">HQ</strong>
          <p class="sec-hint" id="hq-state-sub">Lecture de l'état…</p>
        </div>
        <button type="button" class="secondary" id="btn-palette">Recherche</button>
      </div>
      <ul class="hq-list" id="hq-attention"></ul>
      <div class="row hq-actions" id="hq-quick-scenes"></div>
    </section>
    <div class="accueil-main">
      <section class="hq hq-primary" aria-labelledby="envoyer-title">
        <div class="sec-head">
          <h2 id="envoyer-title">Envoyer</h2>
          <p class="sec-hint">Déposer un fichier vers Inbox, Photos ou Print</p>
        </div>
        <div class="field">
          <label for="upload-folder">Dossier de destination</label>
          <select id="upload-folder">{opts}</select>
        </div>
        <div id="drop-zone" class="drop" role="button" tabindex="0" aria-label="Zone d'envoi de fichiers">
          <strong>Glisse ici, ou utilise Caméra</strong>
          <span class="hint">Photos → Inbox/Photos · captures → Captures · PDF → Uni · max {html.escape(human_size(max_upload_bytes()))}</span>
          <div class="row" style="margin-top:12px">
            <button type="button" class="secondary" id="btn-camera">Caméra</button>
            <button type="button" class="secondary" id="btn-paste">Coller une image</button>
            <button type="button" class="secondary" id="btn-voice">Note vocale</button>
          </div>
        </div>
        <input id="file-input" type="file" multiple hidden/>
        <input id="camera-input" type="file" accept="image/*" capture="environment" hidden/>
        <div id="progress" class="progress" hidden><div id="progress-fill"></div></div>
        <div id="progress-label" class="hint" style="margin-top:6px"></div>
        <div id="offline-queue" class="hint" style="margin-top:6px"></div>
        <details class="note-acc mode-complet-only">
          <summary>Écrire une note (.txt)</summary>
          <form id="note-form">
            <div class="field"><label for="note-folder">Dossier</label><select id="note-folder">{opts}</select></div>
            <div class="field"><label for="note-title">Titre</label>
              <input id="note-title" type="text" maxlength="80" placeholder="Optionnel"/></div>
            <div class="field"><label for="note-body">Texte</label>
              <textarea id="note-body" required placeholder="Écris ici…" style="min-height:72px"></textarea></div>
            <button class="block" type="submit">Enregistrer la note</button>
          </form>
        </details>
      </section>
    </div>
    <div class="accueil-side">
      <section class="hq" aria-labelledby="devices-title">
        <div class="sec-head">
          <h2 id="devices-title">Appareils <span class="badge" id="hq-dev-count">0</span></h2>
          <p class="sec-hint">En ligne et espace disque disponible</p>
        </div>
        <ul class="hq-list" id="hq-devices"><li class="hint skeleton">Chargement…</li></ul>
      </section>

      <section class="hq" aria-labelledby="actions-title">
        <div class="sec-head">
          <h2 id="actions-title">Ce PC</h2>
          <p class="sec-hint">Verrouiller, veille, capture d'écran, explorateur</p>
        </div>
        <div class="icon-actions" id="hq-actions">
          <button type="button" class="icon-btn" id="btn-lock" aria-label="Verrouiller le PC"><span class="ico" aria-hidden="true">🔒</span><span class="lbl">Verrouiller</span></button>
          <button type="button" class="icon-btn" id="btn-sleep" aria-label="Mettre en veille"><span class="ico" aria-hidden="true">💤</span><span class="lbl">Veille</span></button>
          <button type="button" class="icon-btn" id="btn-shot" aria-label="Prendre une capture"><span class="ico" aria-hidden="true">📸</span><span class="lbl">Capture</span></button>
          <button type="button" class="icon-btn" id="btn-explore" aria-label="Ouvrir l'explorateur"><span class="ico" aria-hidden="true">📁</span><span class="lbl">Dossier</span></button>
        </div>
        <div class="row hq-actions" style="margin-top:10px">
          <button type="button" id="btn-sync-captures">Récupérer les captures</button>
        </div>
        <div class="row hq-actions mode-complet-only" id="hq-custom-actions" style="margin-top:8px" aria-label="Actions personnalisées"></div>
        <div class="row hq-actions mode-complet-only" id="hq-scenes" style="margin-top:8px" aria-label="Scènes"></div>
        <p class="sec-hint mode-complet-only" style="margin-top:8px">Scènes = plusieurs actions d'un coup</p>
      </section>

      <section class="hq" aria-labelledby="recents-title">
        <div class="sec-head">
          <h2 id="recents-title">Récents</h2>
          <p class="sec-hint">Derniers envois et activité</p>
        </div>
        <div class="chips filter-chips" id="recents-filters" role="tablist" aria-label="Filtrer récents">
          <button type="button" class="chip active" data-recents="all" role="tab" aria-selected="true">Tous</button>
          <button type="button" class="chip" data-recents="transfers" role="tab" aria-selected="false">Envois</button>
          <button type="button" class="chip" data-recents="activity" role="tab" aria-selected="false">Activité</button>
        </div>
        <ul class="hq-list" id="hq-recents"><li class="hint">Rien pour l'instant — envoie un fichier ci-contre</li></ul>
        <ul class="hq-list" id="hq-transfers" hidden></ul>
        <ul class="hq-list" id="hq-activity" hidden></ul>
      </section>

      <section class="hq" aria-labelledby="events-title">
        <div class="sec-head">
          <h2 id="events-title">Journal</h2>
          <p class="sec-hint">Événements récents du pont</p>
        </div>
        <div class="chips filter-chips" id="hq-event-filters" role="tablist" aria-label="Filtrer le journal">
          <button type="button" class="chip active" data-event-kind="all">Tous</button>
          <button type="button" class="chip" data-event-kind="alert">Alertes</button>
          <button type="button" class="chip" data-event-kind="upload">Envois</button>
          <button type="button" class="chip" data-event-kind="scene">Scènes</button>
          <button type="button" class="chip" data-event-kind="backup">Backups</button>
          <button type="button" class="chip" data-event-kind="automation">Auto</button>
          <button type="button" class="chip" data-event-kind="schedule">Planning</button>
        </div>
        <ul class="hq-list" id="hq-events"><li class="hint">Chargement…</li></ul>
      </section>
    </div>
  </div>

  <div data-panel="fichiers">
    <section class="hq" aria-labelledby="search-title">
      <div class="sec-head">
        <h2 id="search-title">Recherche</h2>
        <p class="sec-hint">Trouver un fichier ou du texte dans .txt / .md</p>
      </div>
      <input id="global-search" type="search" placeholder="Ex. facture, capture, notes…" aria-label="Recherche globale"/>
      <ul class="hq-list" id="search-hits"></ul>
    </section>

    <section class="hq" aria-labelledby="fm-title">
      <div class="sec-head">
        <h2 id="fm-title">Fichiers <span class="badge" id="file-count">0</span></h2>
        <p class="sec-hint">Parcourir, télécharger, déplacer</p>
      </div>
      <div class="fav-bar">
        <button type="button" class="secondary" id="btn-fav-toggle">Épingler ce dossier</button>
        <div class="chips" id="hq-favorites" aria-label="Favoris"></div>
      </div>
      <nav class="crumbs" id="crumbs" aria-label="Chemin"></nav>
      <div class="fm-tools">
        <button type="button" class="secondary" id="btn-up">↑ Remonter</button>
        <button type="button" class="secondary" id="btn-mkdir">+ Dossier</button>
        <button type="button" class="secondary" id="btn-newfile">+ Fichier</button>
        <input id="search" type="search" placeholder="Filtrer…" aria-label="Filtrer la liste"/>
      </div>
      <ul class="files" id="file-list"></ul>
    </section>

    <section class="hq" aria-labelledby="media-title">
      <div class="sec-head">
        <h2 id="media-title">Médias</h2>
        <p class="sec-hint">Aperçu des images récentes</p>
      </div>
      <div class="media-strip" id="hq-media"></div>
    </section>
  </div>

  <div data-panel="ops" class="mode-complet-only">
    <section class="hq hq-primary" aria-labelledby="shell-title">
      <div class="sec-head">
        <h2 id="shell-title">Terminal</h2>
        <p class="sec-hint">Commande rapide sur ce PC ou un autre via Tailscale</p>
      </div>
      <div class="field"><label for="shell-target">Sur quel PC ?</label><select id="shell-target"></select></div>
      <div class="field"><label for="shell-type">Type de terminal</label>
        <select id="shell-type">
          <option value="powershell">PowerShell</option>
          <option value="cmd">CMD</option>
          <option value="pwsh">PowerShell 7 (pwsh)</option>
        </select>
      </div>
      <div class="row hq-actions" id="term-cmds" style="margin-bottom:8px"></div>
      <div class="field"><label for="shell-cmd">Commande</label>
        <input id="shell-cmd" type="text" placeholder="Get-Process | Select -First 5" autocomplete="off"/>
      </div>
      <div class="row hq-actions">
        <button type="button" id="btn-shell-run">Lancer</button>
      </div>
      <p class="sec-hint">« Local » = cet ordinateur. Les autres PCs apparaissent s'ils ont OpenSSH.</p>
      <div class="busy-line" id="shell-busy" hidden><span class="busy-dot"></span><span class="busy-text">Exécution…</span><span class="busy-elapsed">0s</span></div>
      <pre id="shell-out" class="term-out" aria-live="polite"></pre>
    </section>

    <details class="hq">
      <summary>
        <div class="sec-head">
          <span class="sec-head summary-title" style="font-size:1.12rem;font-weight:800">Ranger l'Inbox</span>
          <p class="sec-hint">Archiver, trier, ou vider les fichiers temporaires</p>
        </div>
      </summary>
      <div class="row hq-actions">
        <button type="button" class="secondary" id="btn-iz-archive">Archiver l'Inbox</button>
        <button type="button" class="secondary" id="btn-iz-sort">Trier l'Inbox</button>
        <button type="button" class="secondary" id="btn-iz-tmp">Vider le dossier tmp</button>
        <button type="button" class="secondary" id="btn-backup">Faire une sauvegarde</button>
      </div>
      <div class="busy-line" id="backup-busy" hidden><span class="busy-dot"></span><span class="busy-text">Backup…</span><span class="busy-elapsed">0s</span></div>
    </details>

    <details class="hq">
      <summary>
        <div class="sec-head">
          <span class="summary-title" style="font-size:1.12rem;font-weight:800;color:var(--text)">Au réveil</span>
          <p class="sec-hint">Tâches à lancer quand le PC revient en ligne</p>
        </div>
      </summary>
      <div class="row hq-actions" style="margin-bottom:8px">
        <button type="button" class="secondary" id="btn-queue-add">+ Ouvrir Uni au réveil</button>
      </div>
      <form id="hq-schedule-form" class="rule-form">
        <div class="field"><label for="sched-label">Planifier</label><input id="sched-label" type="text" maxlength="80" placeholder="Backup du matin"/></div>
        <div class="field"><label for="sched-when">Quand</label>
          <select id="sched-when">
            <option value="daily">Chaque jour</option>
            <option value="weekdays">Jours ouvrés</option>
            <option value="weekly">Chaque semaine</option>
            <option value="once">Une fois</option>
            <option value="on-online">Quand l'appareil revient</option>
          </select>
        </div>
        <div class="field"><label for="sched-at">Heure (HH:MM)</label><input id="sched-at" type="text" value="08:00" maxlength="5"/></div>
        <div class="field"><label for="sched-weekday">Jour (0=lundi, hebdo)</label><input id="sched-weekday" type="number" min="0" max="6" value="0"/></div>
        <div class="field"><label for="sched-device">Appareil (au retour)</label><input id="sched-device" type="text" placeholder="pc-host"/></div>
        <div class="field"><label for="sched-type">Action allowlist</label>
          <select id="sched-type">
            <option value="backup">Backup</option>
            <option value="notify">Notification</option>
            <option value="capture">Capture</option>
            <option value="scene">Scène</option>
          </select>
        </div>
        <div class="field"><label for="sched-target">Id de scène</label><input id="sched-target" type="text" maxlength="40"/></div>
        <button type="submit" class="secondary">Ajouter au planning</button>
      </form>
      <ul class="hq-list" id="hq-queue"><li class="hint">File vide — rien n'attend le réveil</li></ul>
    </details>

    <section class="hq" aria-labelledby="clip-title">
      <div class="sec-head">
        <h2 id="clip-title">Presse-papiers</h2>
        <p class="sec-hint">Copier du texte entre téléphone et PC</p>
      </div>
      <div class="row hq-actions">
        <button type="button" class="secondary" id="btn-clip-to-pc">Téléphone → PC</button>
        <button type="button" class="secondary" id="btn-clip-from-pc">PC → Téléphone</button>
      </div>
      <textarea id="clip-box" placeholder="Texte à synchroniser…" style="margin-top:10px;min-height:72px"></textarea>
    </section>

    <details class="hq">
      <summary>
        <div class="sec-head">
          <span class="summary-title" style="font-size:1.12rem;font-weight:800;color:var(--text)">Bloc-notes partagé</span>
          <p class="sec-hint">Notes synchronisées entre tes appareils</p>
        </div>
      </summary>
      <textarea id="scratchpad" placeholder="Écris une note partagée…" style="min-height:90px"></textarea>
      <button type="button" class="secondary" id="btn-scratch-save" style="margin-top:8px">Enregistrer le bloc-notes</button>
    </details>

    <details class="hq">
      <summary>
        <div class="sec-head">
          <span class="summary-title" style="font-size:1.12rem;font-weight:800;color:var(--text)">Envoyer à un appareil</span>
          <p class="sec-hint">Pousser un fichier déjà sur le PC vers un navigateur connecté</p>
        </div>
      </summary>
      <div class="field"><label for="send-to">Destinataire</label><select id="send-to"></select></div>
      <div class="field"><label for="send-rel">Fichier (ex: Inbox/Photos/x.jpg)</label>
        <input id="send-rel" type="text" placeholder="Inbox/…"/></div>
      <button type="button" id="btn-send">Envoyer</button>
    </details>

    <details class="hq">
      <summary>
        <div class="sec-head">
          <span class="summary-title" style="font-size:1.12rem;font-weight:800;color:var(--text)">Imprimer</span>
          <p class="sec-hint">Envoyer un PDF du dossier Print à l'imprimante</p>
        </div>
      </summary>
      <div class="field">
        <label for="print-rel">Fichier dans Print/</label>
        <select id="print-printer"></select>
        <div class="row" style="justify-content:stretch;margin-top:8px">
          <input id="print-rel" type="text" placeholder="Print/fichier.pdf" style="flex:1 1 auto;min-width:0"/>
          <button type="button" class="secondary" id="btn-print-preview">Aperçu</button>
          <button type="button" class="secondary" id="btn-print">Imprimer</button>
        </div>
      </div>
    </details>
  </div>

  <div data-panel="plus">
    <section class="hq" aria-labelledby="plus-status-title">
      <div class="sec-head">
        <h2 id="plus-status-title">Session <span class="badge" id="hq-uptime">—</span></h2>
        <p class="sec-hint">Espace disque, hôte, et rôle de connexion</p>
      </div>
      <dl class="hq-status" id="hq-status">
        <dt>Espace libre</dt><dd id="hq-disk">…</dd>
        <dt>Hôte</dt><dd id="hq-host">…</dd>
        <dt>Max upload</dt><dd id="hq-max">…</dd>
        <dt>Session</dt><dd id="hq-role">…</dd>
      </dl>
      <p class="sec-hint">Écran TV / présence / QR → <a href="/wallboard?theme=oled&kiosk=1" style="color:var(--accent)">Wallboard</a>
        · <a href="/wallboard?theme=midnight" style="color:var(--accent)">midnight</a></p>
      <div class="qrs" style="margin-top:10px" aria-label="QR d'accès">
        {qr_lan}
        {qr_ts}
      </div>
      <p class="hint">QR = adresse du pont seulement (pas de PIN ni de session).</p>
      <span id="hq-health" class="visually-hidden"></span>
      <div id="hq-spark-host" class="spark-host"></div>
    </section>

    <section class="hq" aria-labelledby="brief-title">
      <div class="sec-head">
        <h2 id="brief-title">Brief du jour</h2>
        <p class="sec-hint">Résumé déterministe, sans service externe</p>
      </div>
      <div id="hq-brief" class="brief"></div>
    </section>

    <section class="hq" aria-labelledby="backup-title">
      <div class="sec-head">
        <h2 id="backup-title">Sauvegardes</h2>
        <p class="sec-hint">Catalogue local. La restauration écrase le dossier choisi.</p>
      </div>
      <ul class="hq-list" id="hq-backups"><li class="hint">Aucune sauvegarde cataloguée</li></ul>
    </section>

    <details class="hq mode-complet-only">
      <summary>
        <div class="sec-head">
          <span class="summary-title" style="font-size:1.12rem;font-weight:800;color:var(--text)">Automatisations</span>
          <p class="sec-hint">Déclencheurs bornés — pas de shell arbitraire</p>
        </div>
      </summary>
      <ul class="hq-list" id="hq-rules"><li class="hint">Aucune règle</li></ul>
      <form id="hq-rule-form" class="rule-form">
        <div class="field"><label for="rule-label">Libellé</label><input id="rule-label" type="text" maxlength="80" required/></div>
        <div class="field"><label for="rule-trigger">Déclencheur</label>
          <select id="rule-trigger">
            <option value="manual">Manuel</option>
            <option value="disk_low">Disque bas</option>
            <option value="event">Événement</option>
          </select>
        </div>
        <div class="field"><label for="rule-action">Action</label>
          <select id="rule-action">
            <option value="journal">Journal</option>
            <option value="notify">Notification Discord</option>
            <option value="backup">Backup</option>
            <option value="capture">Capture</option>
            <option value="scene">Scène</option>
            <option value="terminal">Commande allowlist</option>
          </select>
        </div>
        <div class="field"><label for="rule-target">Cible (id scène ou commande)</label><input id="rule-target" type="text" maxlength="40"/></div>
        <button type="submit" class="secondary">Enregistrer la règle</button>
      </form>
    </details>

    <section class="hq" aria-labelledby="push-title">
      <div class="sec-head">
        <h2 id="push-title">Notifications</h2>
        <p class="sec-hint">Web Push opt-in. Nécessite HTTPS (Tailscale Serve) et push_enabled.</p>
      </div>
      <p id="hq-push-note" class="hint"></p>
      <button type="button" class="secondary" id="btn-push">Activer sur cet appareil</button>
    </section>

    <details class="hq mode-complet-only">
      <summary>
        <div class="sec-head">
          <span class="summary-title" style="font-size:1.12rem;font-weight:800;color:var(--text)">Tâches</span>
          <p class="sec-hint">Kanban personnel — pour toi seulement</p>
        </div>
      </summary>
      <div class="kanban" id="kanban"></div>
    </details>

    <details class="hq">
      <summary>
        <div class="sec-head">
          <span class="summary-title" style="font-size:1.12rem;font-weight:800;color:var(--text)">Alertes <span class="badge" id="hq-alert-count">0</span></span>
          <p class="sec-hint">Disque plein, erreurs, avertissements</p>
        </div>
      </summary>
      <ul class="hq-list" id="hq-alerts"><li class="hint">Aucune alerte</li></ul>
    </details>

    <section class="hq">
      <div class="sec-head">
        <h2>Infos</h2>
        <p class="sec-hint">Réglages de base du pont</p>
      </div>
      <dl class="hq-status">
        <dt>Dossier PC</dt><dd>D:\\Transfert\\{{Inbox,Uni,Print}}</dd>
        <dt>PIN</dt><dd>{"activé" if pin_enabled() else "désactivé"}</dd>
        <dt>Gros fichiers</dt><dd>jusqu'à {html.escape(human_size(max_upload_bytes()))} (stream)</dd>
        <dt>Discord</dt><dd>{"activé" if str(CONFIG.get("discord_webhook_url") or "").strip() else "off"}</dd>
        <dt>PWA</dt><dd>iPhone: Partager → Sur l'écran d'accueil</dd>
      </dl>
    </section>
  </div>

</main>
<div id="op-busy" class="op-busy" hidden aria-live="polite">
  <span class="busy-dot"></span>
  <span id="op-busy-label">Travail en cours…</span>
  <span id="op-busy-elapsed">0s</span>
</div>
<div id="toasts" aria-live="polite" aria-relevant="additions"></div>
<script>{APP_JS}</script>
<script src="/assets/hq.js"></script>
<dialog id="hq-device-dialog">
  <form method="dialog">
    <header><strong id="hq-device-title">Appareil</strong></header>
    <div id="hq-device-body"></div>
    <div class="row"><button value="cancel" class="secondary">Fermer</button></div>
  </form>
</dialog>
<div id="hq-palette" class="palette" hidden>
  <div class="palette-card" role="dialog" aria-label="Recherche HQ">
    <input id="hq-palette-input" type="search" placeholder="Dossier, scène, appareil, action…" autocomplete="off"/>
    <ul id="hq-palette-list"></ul>
  </div>
</div>
</body></html>"""
    return page.encode("utf-8")




def _login_rate_ok(ip: str) -> bool:
    now = time.time()
    with _LOGIN_FAILS_LOCK:
        hits = [t for t in _LOGIN_FAILS.get(ip, []) if now - t < 60]
        _LOGIN_FAILS[ip] = hits
        return len(hits) < 12


def _login_fail(ip: str) -> None:
    with _LOGIN_FAILS_LOCK:
        hits = _LOGIN_FAILS.setdefault(ip, [])
        hits.append(time.time())


class Handler(BaseHTTPRequestHandler):
    server_version = "TransfertBridge/7.0"

    def setup(self) -> None:
        super().setup()
        try:
            self.connection.settimeout(REQ_TIMEOUT_SEC)
        except OSError:
            pass

    def handle(self) -> None:
        """Bound concurrent handlers; refuse quickly with 503 when saturated."""
        if not _REQ_SEM.acquire(blocking=False):
            try:
                self.close_connection = True
                self.connection.sendall(
                    b"HTTP/1.1 503 Service Unavailable\r\n"
                    b"Content-Type: text/plain; charset=utf-8\r\n"
                    b"Content-Length: 11\r\n"
                    b"Connection: close\r\n"
                    b"\r\n"
                    b"Server busy"
                )
            except OSError:
                pass
            return
        try:
            super().handle()
        finally:
            _REQ_SEM.release()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _token(self) -> str | None:
        raw = self.headers.get("Cookie", "")
        if not raw:
            return None
        c = SimpleCookie()
        try:
            c.load(raw)
        except Exception:
            return None
        return c[COOKIE_NAME].value if COOKIE_NAME in c else None

    def _auth(self) -> bool:
        # Never treat loopback / missing PIN as authenticated admin.
        if not pin_enabled():
            return False
        return session_valid(self._token())

    def _role(self) -> str:
        if not pin_enabled():
            return ""
        return session_role(self._token())

    def _require_admin(self) -> bool:
        if self._role() == "admin":
            return True
        self._json(403, {"error": "Réservé admin"})
        return False

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        # same-origin: keep Referer for CSRF on same-host GETs (logout); never leak off-origin
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
        )

    def _request_is_https(self) -> bool:
        xf = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        return xf == "https"

    def _session_cookie(self, token: str = "", *, clear: bool = False) -> str:
        if clear:
            parts = [f"{COOKIE_NAME}=", "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"]
        else:
            parts = [
                f"{COOKIE_NAME}={token}",
                "Path=/",
                f"Max-Age={SESSION_TTL_SEC}",
                "HttpOnly",
                "SameSite=Lax",
            ]
        if self._request_is_https():
            parts.append("Secure")
        return "; ".join(parts)

    def _csrf_candidate(self, path: str) -> bool:
        """True if this request is state-changing and needs Origin/Referer."""
        method = (self.command or "GET").upper()
        if method in ("POST", "PUT", "PATCH", "DELETE"):
            return True
        if method == "GET" and path == "/logout":
            return True
        if method == "GET" and path == "/api/inbox":
            qs = parse_qs(urlparse(self.path).query)
            if (qs.get("clear") or [""])[0] in ("1", "true", "yes"):
                return True
        return False

    def _check_csrf(self) -> bool:
        """Fail-closed CSRF for cookie sessions (and /login form POST).

        Allowlist = request Host + LAN/Tailscale/localhost + config public_base_urls.
        Intentional exception: none today — no Bearer auth bypass.
        Same-origin HQ fetch/forms send Origin; login PIN form is same-origin.
        """
        path = urlparse(self.path).path
        if not self._csrf_candidate(path):
            return True
        has_cookie = bool(self._token())
        if not has_cookie and path != "/login":
            return True

        allowed = csrf_allowed_origins(self.headers.get("Host"))
        origin = (self.headers.get("Origin") or "").strip()
        referer = (self.headers.get("Referer") or "").strip()

        def matches(raw: str) -> bool:
            if not raw:
                return False
            try:
                p = urlparse(raw)
                if not p.scheme or not p.netloc:
                    return False
                return f"{p.scheme}://{p.netloc}" in allowed
            except Exception:
                return False

        if origin:
            if matches(origin):
                return True
            self._csrf_reject("Origin refusée")
            return False
        if referer:
            if matches(referer):
                return True
            self._csrf_reject("Referer refusé")
            return False
        self._csrf_reject("Origin ou Referer requis")
        return False

    def _csrf_reject(self, detail: str) -> None:
        path = urlparse(self.path).path
        msg = f"CSRF: {detail}"
        if path in ("/login", "/logout") and (self.command or "").upper() in ("GET", "POST"):
            try:
                body = render_login(msg, error=True) if pin_enabled() else msg.encode("utf-8")
                self._send(403, body)
            except Exception:
                self._json(403, {"error": msg})
        else:
            self._json(403, {"error": msg})


    def _send(
        self,
        code: int,
        body: bytes,
        content_type: str = "text/html; charset=utf-8",
        headers: list[tuple[str, str]] | None = None,
    ) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        if headers:
            for k, v in headers:
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: dict, headers: list[tuple[str, str]] | None = None) -> None:
        try:
            body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        except Exception:
            body = json.dumps({"error": "Réponse JSON invalide"}).encode("utf-8")
            code = 500
        self._send(code, body, "application/json; charset=utf-8", headers)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length < 0 or length > 8 * 1024 * 1024:
            raise ValueError("JSON trop volumineux")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as e:
            raise ValueError("JSON invalide") from e
        if not isinstance(data, dict):
            raise ValueError("JSON invalide")
        return data

    def _upload_allowed(self, method: str, raw: str) -> bool:
        """Explicit allowlist for role=upload. Admin always True."""
        if self._role() == "admin":
            return True
        if method == "GET":
            if raw in UPLOAD_GET_EXACT:
                return True
            return any(raw.startswith(p) for p in UPLOAD_GET_PREFIX)
        if method == "POST":
            if raw in UPLOAD_POST_EXACT:
                return True
            return any(raw.startswith(p) for p in UPLOAD_POST_PREFIX)
        return False

    def _guard_admin_path(self, raw: str) -> bool:
        """Return False if blocked (response already sent). Allowlist for upload role."""
        if self._role() == "admin":
            return True
        # Static/login already handled; for authenticated GETs enforce allowlist.
        method = "GET"
        if not self._upload_allowed(method, raw):
            self._json(403, {"error": "Réservé admin"})
            return False
        return True

    def _send_file(self, path: Path, as_download: bool = False) -> None:
        size = path.stat().st_size
        ext = path.suffix.lower()
        force_attach = as_download or ext in FORCE_ATTACHMENT_EXTS
        if force_attach and ext in FORCE_ATTACHMENT_EXTS:
            ctype = "application/octet-stream"
        else:
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        if force_attach and ext in FORCE_ATTACHMENT_EXTS:
            self.send_header(
                "Content-Security-Policy",
                "sandbox; default-src 'none'; base-uri 'none'",
            )
        disp = "attachment" if force_attach else "inline"
        self.send_header(
            "Content-Disposition",
            f"{disp}; filename=\"{path.name}\"; filename*=UTF-8''{quote(path.name)}",
        )
        self.end_headers()
        with path.open("rb") as f:
            while True:
                chunk = f.read(CHUNK)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _hq_get(self, raw: str, parsed) -> bool:
        if raw == "/hq-sw.js":
            path = ROOT / "assets" / "hq-sw.js"
            if not path.is_file():
                self._send(404, b"missing", "text/plain; charset=utf-8")
                return True
            self._send(
                200,
                path.read_bytes(),
                "application/javascript; charset=utf-8",
                headers=[("Service-Worker-Allowed", "/")],
            )
            return True
        if raw == "/api/hq":
            self._json(200, hq_snapshot())
            return True
        if raw == "/api/events":
            qs = parse_qs(parsed.query)
            try:
                limit, offset = parse_list_bounds(qs)
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return True
            since_raw = (qs.get("since", [""])[0] or "").strip()
            since = None
            if since_raw:
                try:
                    since = float(since_raw)
                except ValueError:
                    self._json(400, {"error": "since invalide"})
                    return True
            self._json(
                200,
                hq_events.list_events(
                    kind=(qs.get("kind", [""])[0] or "").strip(),
                    level=(qs.get("level", [""])[0] or "").strip(),
                    q=(qs.get("q", [""])[0] or "").strip(),
                    since=since,
                    limit=limit,
                    offset=offset,
                ),
            )
            return True
        if raw == "/api/device":
            qs = parse_qs(parsed.query)
            ident = (qs.get("id", [""])[0] or "").strip()
            found = None
            for device in cached_roster_devices():
                if str(device.get("id") or "") == ident:
                    found = device
                    break
            if not found:
                self._json(404, {"error": "Appareil introuvable"})
                return True
            normalized = hq_devices.normalize(found)
            self._json(200, {"ok": True, "device": normalized, "gates": hq_devices.gates_for(found)})
            return True
        if raw == "/api/palette":
            qs = parse_qs(parsed.query)
            q = (qs.get("q", [""])[0] or "").strip()
            try:
                limit, _offset = parse_list_bounds(qs, default=20, max_limit=LIST_LIMIT_MAX)
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return True
            hits = hq_devices.search_catalog(q, palette_catalog(), limit=limit)
            self._json(200, {"q": q, "hits": hits})
            return True
        if raw == "/api/runs":
            qs = parse_qs(parsed.query)
            try:
                limit, offset = parse_list_bounds(qs, default=20, max_limit=LIST_LIMIT_MAX)
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return True
            self._json(200, hq_automation.list_runs(limit=limit, offset=offset))
            return True
        if raw == "/api/automation":
            self._json(200, hq_automation.list_rules())
            return True
        if raw == "/api/backups":
            self._json(200, hq_automation.list_backups())
            return True
        if raw == "/api/telemetry":
            qs = parse_qs(parsed.query)
            device = (qs.get("device", [""])[0] or "").strip() or None
            try:
                limit, _offset = parse_list_bounds(qs, default=240, max_limit=1000)
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return True
            self._json(200, hq_automation.telemetry_series(device, limit=limit))
            return True
        if raw == "/api/brief":
            self._json(200, build_daily_brief())
            return True
        if raw == "/api/push/status":
            self._json(200, hq_automation.push_status())
            return True
        if raw == "/api/schedules":
            items = [
                job
                for job in cc_ext.queue_list()
                if isinstance(job, dict) and job.get("when") in ("daily", "weekdays", "weekly", "once", "on-online")
            ]
            self._json(200, {"schedules": items})
            return True
        return False

    def _hq_post(self, raw: str) -> bool:
        if raw == "/api/automation":
            data = self._read_json()
            action = str(data.get("action") or "")
            try:
                if action == "save":
                    rule = hq_automation.save_rule(data.get("rule") if isinstance(data.get("rule"), dict) else {})
                    self._json(200, {"ok": True, "rule": rule})
                elif action == "delete":
                    self._json(200, hq_automation.delete_rule(str(data.get("id") or "")))
                elif action == "enable":
                    self._json(
                        200,
                        {
                            "ok": True,
                            "rule": hq_automation.set_rule_enabled(
                                str(data.get("id") or ""),
                                bool(data.get("enabled", True)),
                            ),
                        },
                    )
                elif action == "run":
                    self._json(200, hq_automation.run_rule(str(data.get("id") or ""), manual=True))
                else:
                    self._json(400, {"error": "action invalide"})
            except ValueError as e:
                self._json(400, {"error": str(e)})
            except RuntimeError as e:
                self._json(409, {"error": str(e)})
            return True
        if raw == "/api/backup/restore":
            data = self._read_json()
            try:
                info = hq_automation.restore_backup(
                    str(data.get("id") or ""),
                    str(data.get("folder") or ""),
                    confirm=bool(data.get("confirm")),
                )
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return True
            except RuntimeError as e:
                self._json(409, {"error": str(e)})
                return True
            self._json(200, info)
            return True
        if raw == "/api/brief":
            data = self._read_json()
            brief = build_daily_brief()
            if str(data.get("action") or "") == "discord":
                result = hq_automation.maybe_send_brief(brief, force=True)
                self._json(200, {**brief, "discord": result})
                return True
            self._json(200, brief)
            return True
        if raw == "/api/push/subscribe":
            data = self._read_json()
            sub = data.get("subscription") if isinstance(data.get("subscription"), dict) else data
            try:
                self._json(200, hq_automation.subscribe_push(sub if isinstance(sub, dict) else {}))
            except ValueError as e:
                self._json(400, {"error": str(e)})
            except RuntimeError as e:
                self._json(409, {"error": str(e)})
            return True
        if raw == "/api/push/unsubscribe":
            data = self._read_json()
            try:
                self._json(200, hq_automation.unsubscribe_push(str(data.get("endpoint") or "")))
            except RuntimeError as e:
                self._json(409, {"error": str(e)})
            return True
        if raw == "/api/push/test":
            try:
                self._json(200, hq_automation.send_test_push())
            except ValueError as e:
                self._json(400, {"error": str(e)})
            except RuntimeError as e:
                self._json(409, {"error": str(e)})
            return True
        return False

    def do_GET(self) -> None:
        try:
            self._do_GET()
        except BrokenPipeError:
            return
        except ConnectionResetError:
            return
        except Exception as e:
            sys.stderr.write(f"GET error {self.path}: {e}\n")
            try:
                if self.path.startswith("/api/"):
                    self._json(500, {"error": str(e)[:300]})
                else:
                    self._send(500, b"Internal error")
            except Exception:
                pass

    def _do_GET(self) -> None:
        parsed = urlparse(self.path)
        raw = parsed.path
        ensure_hq()

        if raw == "/logout":
            if not self._check_csrf():
                return
            tok = self._token()
            revoke_session(tok)
            body = render_login("Déconnecté.") if pin_enabled() else render_app()
            self._send(200, body, headers=[("Set-Cookie", self._session_cookie(clear=True))])
            return

        if raw == "/login":
            if pin_enabled() and self._auth():
                self.send_response(303)
                self.send_header("Location", "/")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self._send(200, render_login())
            return

        if raw == "/manifest.webmanifest":
            mani = {
                "name": "Transfert HQ",
                "short_name": "Transfert HQ",
                "start_url": "/",
                "display": "standalone",
                "background_color": "#0f1419",
                "theme_color": "#0f1419",
                "icons": [
                    {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
                    {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
                ],
            }
            self._send(200, json.dumps(mani).encode(), "application/manifest+json")
            return

        if raw in ("/icon-192.png", "/icon-512.png"):
            size = 512 if "512" in raw else 192
            self._send(200, png_icon(size), "image/png")
            return

        if raw.startswith("/assets/"):
            name = Path(raw[len("/assets/") :]).name
            path = ROOT / "assets" / name
            if path.is_file():
                ctype = mimetypes.guess_type(name)[0] or "application/javascript"
                self._send(200, path.read_bytes(), ctype)
                return
            self._send(404, b"missing")
            return

        # Method guard before auth so clients see 405 (not 401) for wrong verb.
        if raw == "/api/pc/screenshot":
            self.send_response(405)
            self.send_header("Allow", "POST")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self._security_headers()
            body = b'{"error":"POST requis"}'
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if not self._auth():
            if raw.startswith("/api/") or raw.startswith("/files/") or raw.startswith("/download/"):
                self._json(401, {"error": "PIN requis"})
                return
            self._send(200, render_login())
            return

        if not self._guard_admin_path(raw):
            return

        if self._hq_get(raw, parsed):
            return

        if raw in ("/", "/index.html"):
            self._send(200, render_app())
            return

        if raw == "/api/list":
            qs = parse_qs(parsed.query)
            path = (qs.get("path", [""])[0] or qs.get("rel", [""])[0] or "").strip()
            q = (qs.get("q", [""])[0] or "").strip()
            try:
                limit, offset = parse_list_bounds(qs, default=LIST_LIMIT_MAX, max_limit=LIST_LIMIT_MAX)
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return
            data = list_dir(path, q)
            items = list(data.get("items") or [])
            data["total"] = len(items)
            data["items"] = items[offset : offset + limit]
            data["limit"] = limit
            data["offset"] = offset
            self._json(200, data)
            return

        if raw == "/api/status":
            self._json(200, bridge_status())
            return

        if raw == "/api/health":
            self._json(
                200,
                cc_ext.health_report(
                    uptime_sec=time.time() - _STARTED_AT,
                    tailscale_ip=tailscale_ipv4(),
                    version="7.0",
                ),
            )
            return

        if raw == "/api/activity":
            qs = parse_qs(parsed.query)
            try:
                limit, offset = parse_list_bounds(qs)
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return
            items = cc_ext.activity_list()
            self._json(200, {"activity": items[offset : offset + limit], "total": len(items), "limit": limit, "offset": offset})
            return

        if raw == "/api/alerts":
            self._json(200, {"alerts": cc_ext.alerts_list()})
            return

        if raw == "/api/scratchpad":
            self._json(200, cc_ext.scratchpad_get())
            return

        if raw == "/api/media/recent":
            qs = parse_qs(parsed.query)
            try:
                limit, offset = parse_list_bounds(qs, default=16, max_limit=LIST_LIMIT_MAX)
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return
            items = cc_ext.recent_media(limit=limit + offset)
            self._json(200, {"items": items[offset : offset + limit], "limit": limit, "offset": offset})
            return

        if raw == "/api/queue":
            self._json(200, {"queue": cc_ext.queue_list()})
            return

        if raw == "/api/inbox":
            if not self._check_csrf():
                return
            qs = parse_qs(parsed.query)
            did = (qs.get("id", [""])[0] or "").strip()
            clear = (qs.get("clear", [""])[0] or "") in ("1", "true", "yes")
            self._json(200, {"items": cc_ext.inbox_get(did, clear=clear) if did else []})
            return

        if raw == "/api/presence/history":
            qs = parse_qs(parsed.query)
            try:
                limit, offset = parse_list_bounds(qs)
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return
            items = cc_ext.presence_history()
            self._json(200, {"history": items[offset : offset + limit], "total": len(items), "limit": limit, "offset": offset})
            return

        if raw == "/api/search":
            qs = parse_qs(parsed.query)
            q = (qs.get("q", [""])[0] or "").strip()
            try:
                limit, offset = parse_list_bounds(qs, default=40, max_limit=LIST_LIMIT_MAX)
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return
            hits = cc_ext.search_files(q, limit=limit + offset)
            self._json(200, {"q": q, "hits": hits[offset : offset + limit], "limit": limit, "offset": offset})
            return

        if raw == "/api/kanban":
            self._json(200, cc_ext.kanban_get())
            return

        if raw == "/api/printers":
            self._json(200, {"printers": cc_ext.list_printers()})
            return

        if raw == "/api/terminal/commands":
            self._json(200, {"commands": CONFIG.get("terminal_commands") or []})
            return

        if raw == "/api/shell/targets":
            self._json(200, {"targets": cc_ext.list_shell_targets(tailscale_peers_fn=tailscale_peers), "ssh_user": CONFIG.get("ssh_user") or ""})
            return

        if raw == "/api/me":
            info = session_info(self._token()) or {"user": "?", "role": self._role() or "upload"}
            self._json(200, {"user": info.get("user"), "role": info.get("role")})
            return

        if raw == "/api/upload/status":
            qs = parse_qs(parsed.query)
            uid = (qs.get("id", [""])[0] or "").strip()
            try:
                self._json(200, upload_status(uid))
            except Exception as e:
                self._json(404, {"error": str(e)})
            return

        if raw == "/wallboard" or raw == "/wallboard.html":
            self._send(200, render_wallboard())
            return

        if raw == "/api/devices":
            self._json(200, devices_roster())
            return

        if raw == "/api/transfers":
            qs = parse_qs(parsed.query)
            try:
                limit, offset = parse_list_bounds(qs)
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return
            items = transfers_list()
            self._json(200, {"transfers": items[offset : offset + limit], "total": len(items), "limit": limit, "offset": offset})
            return

        if raw == "/api/favorites":
            self._json(200, {"favorites": list(CONFIG.get("favorites") or [])})
            return

        if raw == "/api/clipboard/pc":
            try:
                text = read_pc_clipboard()
            except Exception as e:
                self._json(500, {"error": str(e)})
                return
            self._json(200, {"ok": True, "text": text})
            return

        if raw == "/api/files":
            qs = parse_qs(parsed.query)
            folder = (qs.get("folder", [""])[0] or "").strip() or None
            q = (qs.get("q", [""])[0] or "").strip()
            if folder == "all":
                folder = None
            self._json(200, {"files": list_files(folder, q)})
            return

        if raw.startswith("/files/") or raw.startswith("/download/"):
            prefix = "/files/" if raw.startswith("/files/") else "/download/"
            path = safe_rel_path(raw[len(prefix) :])
            if not path:
                self._send(404, render_app() if not raw.startswith("/api/") else b"{}")
                return
            self._send_file(path, as_download=raw.startswith("/download/"))
            return

        self._send(404, b"Not found")

    def do_POST(self) -> None:
        try:
            self._do_POST()
        except BrokenPipeError:
            return
        except ConnectionResetError:
            return
        except ValueError as e:
            try:
                self._json(400, {"error": str(e)[:300]})
            except Exception:
                pass
        except Exception as e:
            sys.stderr.write(f"POST error {self.path}: {e}\n")
            try:
                self._json(500, {"error": str(e)[:300]})
            except Exception:
                pass

    def _do_POST(self) -> None:
        raw = urlparse(self.path).path
        ensure_hq()

        # CSRF for cookie sessions + /login (same-origin form). No Bearer exception today.
        if not self._check_csrf():
            return

        if raw == "/login":
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length < 0 or length > LOGIN_BODY_MAX:
                self._send(413, render_login("Requête trop grande.", error=True))
                return
            ip = self.client_address[0] if self.client_address else "?"
            if not _login_rate_ok(ip):
                self._send(429, render_login("Trop d'essais — réessaie dans une minute.", error=True))
                return
            body = self.rfile.read(length).decode("utf-8", errors="replace")
            data = parse_qs(body, keep_blank_values=True)
            pin = (data.get("pin", [""])[0] or "").strip()
            auth = authenticate_pin(pin)
            if pin_enabled() and not auth:
                _login_fail(ip)
                self._send(401, render_login("PIN incorrect.", error=True))
                return
            if not auth:
                self._send(401, render_login("Authentification requise.", error=True))
                return
            token = issue_session(auth["user"], auth["role"])
            # 303 so the browser stores the cookie, then loads / with it.
            # Returning the app HTML in the same Set-Cookie response races on Safari/iOS
            # (fetch runs before the cookie sticks → 401 → logout loop).
            self.send_response(303)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", self._session_cookie(token))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if not self._auth():
            self._json(401, {"error": "PIN requis"})
            return

        # upload role: explicit allowlist only
        if self._role() != "admin" and not self._upload_allowed("POST", raw):
            self._json(403, {"error": "Réservé admin"})
            return

        if self._hq_post(raw):
            return

        if raw == "/api/presence":
            data = self._read_json()
            cid = str(data.get("id") or secrets.token_hex(8))[:PRESENCE_ID_MAX].strip()
            if not cid:
                cid = secrets.token_hex(8)
            presence_upsert(cid, data, self.client_address[0])
            self._json(200, {"ok": True, "id": cid, "path": cc_ext.classify_ip(self.client_address[0])})
            return

        if raw == "/api/scratchpad":
            data = self._read_json()
            if "text" not in data:
                self._json(400, {"error": "Champ text requis"})
                return
            text = str(data.get("text") if data.get("text") is not None else "")
            self._json(200, {"ok": True, **cc_ext.scratchpad_set(text)})
            return

        if raw == "/api/scene":
            data = self._read_json()
            try:
                info = cc_ext.run_scene(str(data.get("id") or ""))
            except Exception as e:
                self._json(400, {"error": str(e)})
                return
            self._json(200, info)
            return

        if raw == "/api/queue":
            data = self._read_json()
            job = cc_ext.queue_add(data)
            # try run immediately if when=now/online
            cc_ext.queue_process()
            self._json(200, {"ok": True, "job": job, "queue": cc_ext.queue_list()})
            return

        if raw == "/api/send":
            data = self._read_json()
            to_id = str(data.get("to") or "").strip()
            rel = str(data.get("rel") or "").strip()
            from_name = str(data.get("from") or "Appareil")[:60]
            from_id = str(data.get("from_id") or "")
            if not to_id or not rel or not safe_rel_path(rel):
                self._json(400, {"error": "Destinataire / fichier invalide"})
                return
            if to_id == "all":
                targets = [d["id"] for d in presence_list() if d.get("id")]
                for tid in targets:
                    if tid != from_id:
                        cc_ext.send_to_device(to_id=tid, rel=rel, from_name=from_name, from_id=from_id)
                cc_ext.log_activity("send", f"{from_name} → tous: {rel}", rel=rel)
                self._json(200, {"ok": True, "sent": len(targets)})
                return
            item = cc_ext.send_to_device(to_id=to_id, rel=rel, from_name=from_name, from_id=from_id)
            self._json(200, {"ok": True, "item": item})
            return

        if raw == "/api/favorites":
            data = self._read_json()
            favs = data.get("favorites")
            if isinstance(favs, list):
                cleaned = []
                for f in favs[:30]:
                    s = str(f).replace("\\", "/").strip("/")
                    if s and parse_rel(s) is not None:
                        cleaned.append(s)
                CONFIG["favorites"] = cleaned
            else:
                rel = str(data.get("rel") or "").replace("\\", "/").strip("/")
                if not rel or parse_rel(rel) is None:
                    self._json(400, {"error": "Chemin invalide"})
                    return
                cur = [str(x) for x in (CONFIG.get("favorites") or [])]
                if rel in cur:
                    cur = [f for f in cur if f != rel]
                else:
                    cur.append(rel)
                CONFIG["favorites"] = cur[:30]
            save_config()
            self._json(200, {"ok": True, "favorites": CONFIG["favorites"]})
            return

        if raw == "/api/clipboard/pc":
            data = self._read_json()
            text = str(data.get("text") if data.get("text") is not None else "")
            try:
                write_pc_clipboard(text)
            except Exception as e:
                self._json(500, {"error": str(e)})
                return
            self._json(200, {"ok": True})
            return

        if raw == "/api/pc/screenshot":
            if not self._require_admin():
                return
            try:
                info = pc_screenshot()
            except Exception as e:
                self._json(500, {"error": str(e)})
                return
            self._json(200, {"ok": True, **info})
            return

        if raw == "/api/pc/lock":
            try:
                pc_lock()
            except Exception as e:
                self._json(500, {"error": str(e)})
                return
            notify_discord("PC verrouillé", f"Depuis `{self.client_address[0]}`")
            self._json(200, {"ok": True})
            return

        if raw == "/api/pc/sleep":
            self._json(200, {"ok": True, "message": "Mise en veille…"})

            def _do_sleep() -> None:
                try:
                    pc_sleep()
                except Exception as e:
                    sys.stderr.write(f"sleep failed: {e}\n")

            threading.Timer(0.8, _do_sleep).start()
            return

        if raw == "/api/pc/explore":
            data = self._read_json()
            target = str(data.get("path") or data.get("rel") or "").strip()
            if not target:
                target = str(ROOT)
            try:
                pc_explore(target)
            except Exception as e:
                self._json(400, {"error": str(e)})
                return
            self._json(200, {"ok": True})
            return

        if raw == "/api/pc/action":
            data = self._read_json()
            aid = str(data.get("id") or "").strip()
            try:
                info = pc_run_action(aid)
            except Exception as e:
                self._json(400, {"error": str(e)})
                return
            self._json(200, info)
            return

        if raw == "/api/print":
            data = self._read_json()
            rel = str(data.get("rel") or "").strip()
            printer = str(data.get("printer") or "").strip() or None
            path = safe_rel_path(rel)
            if not path:
                self._json(404, {"error": "Fichier introuvable"})
                return
            try:
                path.resolve().relative_to((ROOT / "Print").resolve())
            except ValueError:
                self._json(400, {"error": "Seuls les fichiers dans Print/ peuvent être imprimés"})
                return
            try:
                cc_ext.print_file(path, printer)
            except Exception as e:
                self._json(400, {"error": str(e)})
                return
            cc_ext.log_activity("print", f"Impression {rel}" + (f" → {printer}" if printer else ""))
            notify_discord("Impression", f"`{rel}`" + (f" via `{printer}`" if printer else ""))
            self._json(200, {"ok": True, "rel": rel, "printer": printer})
            return

        if raw == "/api/upload/init":
            data = self._read_json()
            name = Path(str(data.get("name") or "file.bin")).name
            size = int(data.get("size") or 0)
            folder = str(data.get("folder") or valid_folder(None))
            if size <= 0 or size > max_upload_bytes():
                self._json(400, {"error": "Taille invalide"})
                return
            self._json(200, upload_init(name, size, folder))
            return

        if raw == "/api/upload/chunk":
            # raw binary body; headers: X-Upload-Id, X-Chunk-Index
            uid = self.headers.get("X-Upload-Id") or ""
            try:
                index = int(self.headers.get("X-Chunk-Index") or "0")
            except ValueError:
                self._json(400, {"error": "index invalide"})
                return
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length <= 0 or length > CLIENT_CHUNK * 2:
                self._json(400, {"error": "chunk invalide"})
                return
            data = self.rfile.read(length)
            try:
                info = upload_chunk(uid, index, data)
            except Exception as e:
                self._json(400, {"error": str(e)})
                return
            self._json(200, info)
            return

        if raw == "/api/upload/complete":
            data = self._read_json()
            uid = str(data.get("id") or "")
            try:
                info = upload_complete(uid)
            except Exception as e:
                self._json(400, {"error": str(e)})
                return
            # Respond first so clients never hang on bookkeeping / locks / Discord.
            self._json(200, {**info, "message": "Fichier envoyé"})
            try:
                tid = secrets.token_hex(6)
                transfer_start(
                    tid,
                    name=info["name"],
                    size=info["size"],
                    folder=info["rel"].split("/")[0],
                    ip=self.client_address[0],
                )
                transfer_finish(tid, ok=True, rel=info["rel"])
            except Exception as e:
                sys.stderr.write(f"upload complete bookkeeping: {e}\n")
            return

        if raw == "/api/backup":
            if not self._require_admin():
                return
            try:
                info = cc_ext.run_backup(force=True)
            except Exception as e:
                self._json(500, {"error": str(e)})
                return
            self._json(200, info)
            return

        if raw == "/api/captures/sync":
            if not self._require_admin():
                return
            try:
                info = harvest_screenshots_now(force=True)
            except Exception as e:
                self._json(500, {"error": str(e)})
                return
            self._json(200, info)
            return

        if raw == "/api/inbox-zero":
            if not self._require_admin():
                return
            data = self._read_json()
            try:
                info = cc_ext.inbox_zero(str(data.get("action") or ""))
            except Exception as e:
                self._json(400, {"error": str(e)})
                return
            self._json(200, info)
            return

        if raw == "/api/kanban":
            data = self._read_json()
            action = str(data.get("action") or "save")
            try:
                if action == "add":
                    info = cc_ext.kanban_add(str(data.get("column") or "todo"), str(data.get("title") or "Sans titre"))
                elif action == "move":
                    info = cc_ext.kanban_move(str(data.get("id") or ""), str(data.get("column") or "todo"))
                elif action == "delete":
                    info = cc_ext.kanban_delete(str(data.get("id") or ""))
                elif action == "save":
                    info = cc_ext.kanban_save(data.get("board") or cc_ext.kanban_get())
                else:
                    raise ValueError("action invalide")
            except Exception as e:
                self._json(400, {"error": str(e)})
                return
            self._json(200, {"ok": True, **info} if "columns" not in info else info)
            return

        if raw == "/api/terminal":
            if not self._require_admin():
                return
            data = self._read_json()
            try:
                info = cc_ext.run_terminal(cmd_id=data.get("id"), raw=data.get("cmd"))
            except Exception as e:
                self._json(400, {"error": str(e)})
                return
            self._json(200, info)
            return

        if raw == "/api/shell":
            if not self._require_admin():
                return
            data = self._read_json()
            if data.get("host"):
                self._json(400, {"error": "Cible non autorisée — utilisez un id de shell_targets"})
                return
            target_id = str(data.get("target") or "local")
            shell = str(data.get("shell") or "powershell")
            command = str(data.get("cmd") or data.get("command") or "")
            targets = {t["id"]: t for t in cc_ext.list_shell_targets(tailscale_peers_fn=tailscale_peers)}
            target = targets.get(target_id)
            if not target:
                self._json(400, {"error": "Cible inconnue"})
                return
            try:
                info = cc_ext.run_shell(target=target, shell=shell, command=command)
            except subprocess.TimeoutExpired:
                self._json(400, {"error": "Délai dépassé"})
                return
            except Exception as e:
                self._json(400, {"error": str(e)})
                return
            self._json(200, info)
            return

        if raw == "/api/note":
            data = self._read_json()
            title = str(data.get("title") or "").strip()
            body = str(data.get("body") or "").strip()
            folder_rel = str(data.get("folder") or "").strip() or valid_folder(None)
            if not body:
                self._json(400, {"error": "Note vide"})
                return
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            name = f"Note_{stamp}_{slugify(title)}.txt" if title else f"Note_{stamp}.txt"
            dest = unique_under_rel(folder_rel, name)
            if not dest:
                self._json(400, {"error": "Dossier cible invalide"})
                return
            lines = []
            if title:
                lines += [title, "=" * min(len(title), 60), ""]
            lines += [
                f"Créée: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
                f"Depuis: {self.client_address[0]}",
                f"Dossier: {folder_rel}",
                "",
                body,
                "",
            ]
            dest.write_text("\n".join(lines), encoding="utf-8")
            rel = "/".join(Path(dest).relative_to(ROOT).parts)
            notify_discord("Nouvelle note", f"**{dest.name}**\nDossier: `{folder_rel}`\nIP: `{self.client_address[0]}`")
            self._json(200, {"ok": True, "name": dest.name, "rel": rel})
            return

        if raw == "/api/clipboard":
            data = self._read_json()
            text = str(data.get("text") or "")
            folder_rel = str(data.get("folder") or "").strip() or valid_folder(None)
            if not text.strip():
                self._json(400, {"error": "Presse-papiers vide"})
                return
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            name = f"Paste_{stamp}.txt"
            dest = unique_under_rel(folder_rel, name)
            if not dest:
                self._json(400, {"error": "Dossier cible invalide"})
                return
            dest.write_text(text, encoding="utf-8")
            rel = "/".join(Path(dest).relative_to(ROOT).parts)
            notify_discord("Presse-papiers", f"**{dest.name}** dans `{folder_rel}`")
            self._json(200, {"ok": True, "name": dest.name, "rel": rel})
            return

        if raw == "/api/mkdir":
            data = self._read_json()
            parent = str(data.get("path") or data.get("rel") or "").strip()
            name = safe_leaf_name(str(data.get("name") or ""))
            if not name:
                self._json(400, {"error": "Nom de dossier invalide"})
                return
            if not parent:
                self._json(400, {"error": "Ouvre d'abord Inbox, Uni ou Print"})
                return
            parent_dir = resolve_writable_dir(parent, create=False)
            if not parent_dir:
                self._json(400, {"error": "Dossier parent introuvable"})
                return
            dest = parent_dir / name
            if dest.exists():
                self._json(400, {"error": "Existe déjà"})
                return
            try:
                dest.mkdir(parents=False, exist_ok=False)
            except OSError as e:
                self._json(500, {"error": str(e)})
                return
            rel = "/".join(dest.relative_to(ROOT).parts)
            self._json(200, {"ok": True, "rel": rel, "name": name})
            return

        if raw == "/api/create":
            data = self._read_json()
            parent = str(data.get("path") or data.get("folder") or "").strip()
            name = safe_leaf_name(str(data.get("name") or ""))
            content = str(data.get("content") if data.get("content") is not None else "")
            if not name:
                self._json(400, {"error": "Nom de fichier invalide"})
                return
            if not parent:
                self._json(400, {"error": "Ouvre d'abord Inbox, Uni ou Print"})
                return
            dest = unique_under_rel(parent, name)
            if not dest:
                self._json(400, {"error": "Dossier cible invalide"})
                return
            try:
                dest.write_text(content, encoding="utf-8")
            except OSError as e:
                self._json(500, {"error": str(e)})
                return
            rel = "/".join(dest.relative_to(ROOT).parts)
            notify_discord("Nouveau fichier", f"`{rel}` créé depuis l'iPhone")
            self._json(200, {"ok": True, "rel": rel, "name": dest.name})
            return

        if raw == "/api/read":
            data = self._read_json()
            rel = str(data.get("rel") or "")
            path = safe_rel_path(rel)
            if not path:
                self._json(404, {"error": "Fichier introuvable"})
                return
            if path.suffix.lower() not in TEXT_EDIT_EXTS:
                self._json(400, {"error": "Ce type n'est pas éditable ici"})
                return
            if path.stat().st_size > 2 * 1024 * 1024:
                self._json(400, {"error": "Fichier texte trop gros pour l'éditeur (>2 Mo)"})
                return
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError as e:
                self._json(500, {"error": str(e)})
                return
            self._json(200, {"ok": True, "rel": rel, "name": path.name, "content": text})
            return

        if raw == "/api/write":
            data = self._read_json()
            rel = str(data.get("rel") or "")
            content = str(data.get("content") if data.get("content") is not None else "")
            path = safe_rel_path(rel)
            if not path:
                self._json(404, {"error": "Fichier introuvable"})
                return
            if path.suffix.lower() not in TEXT_EDIT_EXTS:
                self._json(400, {"error": "Ce type n'est pas éditable ici"})
                return
            try:
                path.write_text(content, encoding="utf-8")
            except OSError as e:
                self._json(500, {"error": str(e)})
                return
            self._json(200, {"ok": True, "rel": rel, "size": path.stat().st_size})
            return

        if raw == "/api/rename":
            data = self._read_json()
            rel = str(data.get("rel") or "")
            new_name = safe_leaf_name(str(data.get("name") or ""))
            if not new_name:
                self._json(400, {"error": "Nom invalide"})
                return
            path = resolve_rel(rel, must_exist=True, allow_dir=True)
            if not path:
                self._json(404, {"error": "Introuvable"})
                return
            # don't rename root folders Inbox/Uni/Print
            parts = parse_rel(rel)
            if parts is not None and len(parts) == 1 and path.is_dir():
                self._json(400, {"error": "Impossible de renommer une racine"})
                return
            dest = path.parent / new_name
            if dest.exists():
                self._json(400, {"error": "Ce nom existe déjà"})
                return
            try:
                path.rename(dest)
            except OSError as e:
                self._json(500, {"error": str(e)})
                return
            new_rel = "/".join(dest.relative_to(ROOT).parts)
            self._json(200, {"ok": True, "rel": new_rel})
            return

        if raw == "/api/move":
            data = self._read_json()
            rel = str(data.get("rel") or "")
            dest_rel = str(data.get("dest") or "").strip().strip("/")
            path = resolve_rel(rel, must_exist=True, allow_dir=True)
            if not path:
                self._json(404, {"error": "Introuvable"})
                return
            parts = parse_rel(rel)
            if parts is not None and len(parts) == 1 and path.is_dir():
                self._json(400, {"error": "Impossible de déplacer une racine"})
                return
            dest_dir = resolve_writable_dir(dest_rel, create=True)
            if not dest_dir:
                self._json(400, {"error": "Destination invalide (ex: Uni ou Inbox/Cours)"})
                return
            # prevent moving a folder into itself
            try:
                dest_dir.relative_to(path)
                if path.is_dir():
                    self._json(400, {"error": "Impossible de déplacer un dossier dans lui-même"})
                    return
            except ValueError:
                pass
            target = dest_dir / path.name
            if target.exists():
                target = unique_in_dir(dest_dir, path.name)
            try:
                shutil.move(str(path), str(target))
            except OSError as e:
                self._json(500, {"error": str(e)})
                return
            new_rel = "/".join(Path(target).resolve().relative_to(ROOT).parts)
            self._json(200, {"ok": True, "rel": new_rel})
            return

        if raw == "/api/delete":
            data = self._read_json()
            rel = str(data.get("rel") or data.get("name") or "")
            path = resolve_rel(rel, must_exist=True, allow_dir=True)
            if not path:
                self._json(404, {"error": "Introuvable"})
                return
            parts = parse_rel(rel)
            if parts is not None and len(parts) == 1 and path.is_dir():
                self._json(400, {"error": "Impossible de supprimer une racine"})
                return
            try:
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
            except OSError as e:
                self._json(500, {"error": str(e)})
                return
            self._json(200, {"ok": True})
            return

        if raw == "/api/upload":
            ctype = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in ctype:
                self._json(400, {"error": "multipart requis"})
                return
            length = int(self.headers.get("Content-Length", "0") or 0)
            limit = max_upload_bytes()
            tid = secrets.token_hex(6)
            transfer_start(
                tid,
                name="upload",
                size=length,
                folder="?",
                ip=self.client_address[0],
            )
            tmp: Path | None = None
            try:
                tmp = receive_body_to_temp(self.rfile, length, limit)
                default_folder = valid_folder(CONFIG.get("default_folder"))
                folder, saved = extract_multipart_files(tmp, ctype, default_folder, limit)
            except ValueError as e:
                transfer_finish(tid, ok=False, error=str(e))
                self._json(400, {"error": str(e)})
                return
            except OSError as e:
                transfer_finish(tid, ok=False, error=str(e))
                self._json(500, {"error": str(e)})
                return
            finally:
                if tmp is not None:
                    try:
                        tmp.unlink(missing_ok=True)
                    except OSError:
                        pass
            if not saved:
                transfer_finish(tid, ok=False, error="Aucun fichier")
                self._json(400, {"error": "Aucun fichier reçu"})
                return
            rels = [s["rel"] for s in saved]
            total = sum(int(s.get("size") or 0) for s in saved)
            transfer_finish(tid, ok=True, rel=rels[0])
            with _TRANSFERS_LOCK:
                for t in _TRANSFERS:
                    if t.get("id") == tid:
                        t["name"] = saved[0]["name"] if len(saved) == 1 else f"{len(saved)} fichiers"
                        t["size"] = total
                        t["size_h"] = human_size(total)
                        t["folder"] = folder
                        t["files"] = rels
                        break
            msg = "Fichier envoyé" if len(saved) == 1 else f"{len(saved)} fichiers envoyés"
            min_mb = int(CONFIG.get("notify_min_upload_mb") or 50)
            desc = "\n".join(f"`{x['rel']}` ({human_size(x.get('size') or 0)})" for x in saved[:10])
            if total >= min_mb * 1024 * 1024:
                notify_discord("Gros fichier reçu", desc)
            else:
                notify_discord("Nouveau fichier", desc)
            self._json(200, {"ok": True, "files": rels, "message": msg})
            return

        # legacy form fallbacks
        if raw in ("/note", "/upload", "/delete"):
            self._json(400, {"error": "Utilise /api/* (UI JavaScript)"})
            return

        self._json(404, {"error": "Inconnu"})


def already_running() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.4):
            return True
    except OSError:
        return False


def main() -> None:
    global CONFIG, LOOPBACK_ONLY, BIND_HOST
    CONFIG = load_config()
    load_sessions()
    ensure_folders_and_migrate()
    bind_cc_ext()
    bind_hq()
    cleanup_stale_uploads()
    if already_running():
        print(f"Transfert Bridge already running on port {PORT}")
        return

    # Fail closed: PIN is mandatory. No-PIN + Tailscale Serve/Funnel must never yield unauthenticated admin.
    if not pin_enabled():
        raise SystemExit(
            "FATAL: PIN required. Set pin (or users[].pin) in bridge_config.json.\n"
            "Refusing to start without authentication (Tailscale Serve/Funnel safety)."
        )
    LOOPBACK_ONLY = False
    BIND_HOST = str(CONFIG.get("bind_host") or "0.0.0.0").strip() or "0.0.0.0"

    write_pid()
    lan = lan_ipv4()
    ts = tailscale_ipv4()
    try:
        mtime = datetime.fromtimestamp(Path(__file__).stat().st_mtime).isoformat(timespec="seconds")
        print(f" Loaded : {__file__} (mtime {mtime})")
        print(f" Sessions loaded: {len(_SESSIONS)}")
    except OSError:
        pass
    if pin_enabled():
        notify_discord(
            "Transfert HQ en ligne",
            f"PC `{socket.gethostname()}`\nLAN: `http://{lan}:{PORT}/`"
            + (f"\nTailscale: `http://{ts}:{PORT}/`" if ts else ""),
        )
    cc_ext.log_activity("boot", f"Bridge démarré (bind {BIND_HOST}, pin={'on' if pin_enabled() else 'off'})")
    def _hq_background() -> None:
        try:
            cc_ext.queue_process()
        except Exception as e:
            sys.stderr.write(f"queue: {e}\n")
        try:
            hq_automation.tick()
        except Exception as e:
            sys.stderr.write(f"hq tick: {e}\n")

    cc_ext.start_monitor(
        get_devices=lambda: presence_list(),
        process_queue=_hq_background,
        probe_disks=probe_remote_disks_now,
        harvest_shots=harvest_screenshots_now,
    )
    threading.Thread(target=probe_remote_disks_now, daemon=True).start()
    threading.Thread(target=harvest_screenshots_now, daemon=True).start()
    cc_ext.queue_process()
    try:
        server = ThreadingHTTPServer((BIND_HOST, PORT), Handler)
    except OSError as e:
        raise SystemExit(f"Cannot bind {BIND_HOST}:{PORT}: {e}") from e
    # Mild DoS mitigation for stdlib server
    server.timeout = 30
    print("=" * 56)
    print(" Transfert HQ v7.0 — Mission Control")
    print("=" * 56)
    print(f" Folder : {ROOT}")
    print(f" Bind   : {BIND_HOST}:{PORT}")
    if BIND_HOST == "127.0.0.1":
        print(f" Local  : http://127.0.0.1:{PORT}/")
    else:
        print(f" LAN    : http://{lan}:{PORT}/")
        print(f" Wallboard: http://{lan}:{PORT}/wallboard")
        print(f" Tailscale: http://{ts}:{PORT}/" if ts else " Tailscale: (not installed)")
    print(f" PIN    : required (on)")
    print(f" Max up : {human_size(max_upload_bytes())}")
    print(f" Backup : every {CONFIG.get('backup_every_hours')}h -> {CONFIG.get('backup_dir')}")
    print(" Ctrl+C to stop")
    print("=" * 56)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        try:
            PID_PATH.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    main()
