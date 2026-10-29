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
from datetime import datetime, timedelta
from email.utils import formatdate
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

import cc_ext
import hq_automation
import hq_calendar
import hq_carnet
import hq_diagnostics
import hq_diagnostics_ui
import hq_drawings
import hq_companion
import hq_planner
import hq_devices
import hq_events
import hq_home
import hq_forge
import hq_forge_fleet
import hq_forge_gallery
import hq_forge_jobs
import hq_forge_lab
import hq_forge_night
import hq_forge_inpaint
import hq_forge_presets
import hq_forge_bricks
import hq_forge_lineage
import hq_forge_style
import hq_forge_vault
import hq_today
import hq_search

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

# Lecteur: the only types /media/ streams (inline). Fixed here, never taken from
# mimetypes (on Windows it merges registry values that vary per machine).
MEDIA_CONTENT_TYPES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    # 3D models for the Lecteur viewer (parsed in JS, never rendered by the browser itself).
    # IANA-registered types; browsers have no inline handler for them. /media/ still sends them
    # as attachment + CSP sandbox so a direct navigation downloads instead of rendering.
    ".glb": "model/gltf-binary",
    ".stl": "model/stl",
}
# Types /media/ must never serve inline (fetched by the Lecteur's parser, not a media element).
MEDIA_ATTACHMENT_EXTS = {".glb", ".stl"}
MEDIA_LIBRARY_MAX = 500      # files returned by /api/media/library
MEDIA_SCAN_MAX = 20000       # directory entries visited per library request
MEDIA_SCAN_DEPTH = 12

# upload role: explicit allowlist (everything else = 403)
UPLOAD_GET_EXACT = {
    "/", "/login", "/logout", "/manifest.webmanifest",
    "/icon-192.png", "/icon-512.png", "/wallboard",
    "/api/me",
    "/api/upload/status",
}
UPLOAD_GET_PREFIX = ("/assets/",)
# /assets/* types are fixed here, never read from mimetypes: on Windows it merges
# HKCR "Content Type" values, and a text/plain .js there plus nosniff makes every
# browser refuse the scripts (Dessiner then stayed on « Chargement… »).
ASSET_CONTENT_TYPES = {
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".gz": "application/gzip",  # Phase 4: the vendored OCR language data (served raw; the engine inflates it itself)
}
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
    "design.md",
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
    "hq_drawings.py",
    "hq_solid.py",
    "hq_face_solid.py",
    "hq_round_solid.py",
    "hq_earcut.py",
    "requirements-face3d.txt",
    "earcut-license.txt",
    "tesseract-license.txt",
    "hq_state.py",
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
    "/api/today",
    "/api/home-layout",
    "/api/push",
    "/api/schedules",
    "/api/calendar",
    "/api/carnet",
    "/api/drawings",
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


def parse_byte_range(header: str | None, size: int) -> tuple[int, int] | str | None:
    """One RFC 9110 byte range for a file of `size` bytes.

    Returns (start, end) inclusive for a satisfiable range, "unsatisfiable" for a
    416, or None to ignore the header and send the whole file (missing, not
    bytes, malformed, or several ranges: a single range is all the Lecteur needs).
    """
    if not header:
        return None
    unit, sep, spec = header.strip().partition("=")
    if not sep or unit.strip().lower() != "bytes" or "," in spec:
        return None
    m = re.fullmatch(r"\s*(\d{0,19})-(\d{0,19})\s*", spec)
    if not m or (not m.group(1) and not m.group(2)):
        return None
    first, last = m.group(1), m.group(2)
    if not first:  # suffix: the last N bytes
        n = int(last)
        if n == 0 or size == 0:
            return "unsatisfiable"
        return max(0, size - n), size - 1
    start = int(first)
    if last and int(last) < start:
        return None  # invalid range-spec: ignore
    if start >= size:
        return "unsatisfiable"
    end = min(int(last), size - 1) if last else size - 1
    return start, end


def media_library(limit: int = MEDIA_LIBRARY_MAX) -> dict:
    """Playable files under ROOT/{Inbox|Uni|Print}, newest first. Bounded walk:
    no dotfiles, system names, symlinks or junctions; depth and entry caps."""
    items: list[dict] = []
    scanned = 0
    truncated = False
    for folder in list(CONFIG.get("folders") or DEFAULT_FOLDERS):
        base = ROOT / folder
        if not base.is_dir():
            continue
        stack: list[tuple[str, list[str]]] = [(str(base), [folder])]
        while stack and not truncated:
            directory, parts = stack.pop()
            try:
                with os.scandir(directory) as it:
                    entries = list(it)
            except OSError:
                continue
            for entry in entries:
                scanned += 1
                if scanned > MEDIA_SCAN_MAX:
                    truncated = True
                    break
                name = entry.name
                if name.startswith(".") or name.lower() in SYSTEM_NAMES:
                    continue
                try:
                    if entry.is_symlink() or (hasattr(entry, "is_junction") and entry.is_junction()):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if len(parts) < MEDIA_SCAN_DEPTH:
                            stack.append((entry.path, parts + [name]))
                        continue
                    ext = os.path.splitext(name)[1].lower()
                    if ext not in MEDIA_CONTENT_TYPES or not entry.is_file(follow_symlinks=False):
                        continue
                    st = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                items.append(
                    {
                        "name": name,
                        "rel": "/".join(parts + [name]),
                        "kind": MEDIA_CONTENT_TYPES[ext].split("/", 1)[0],
                        "size": st.st_size,
                        "size_h": human_size(st.st_size),
                        "mtime": int(st.st_mtime),
                        "mtime_h": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                    }
                )
    items.sort(key=lambda x: x["mtime"], reverse=True)
    total = len(items)
    return {"items": items[:limit], "total": total, "truncated": truncated or total > limit}


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
        "backup_auto_paused": False,  # true = no automatic backups (manual POST /api/backup still works)
        "backup_keep_days": 14,  # retention: purge backups older than N days after a new backup; <= 0 = never purge
        "backup_keep_min": 3,  # the newest N backups are always kept, whatever their age (minimum 1)
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
    base["backup_auto_paused"] = cc_ext.config_flag(base.get("backup_auto_paused", False))
    base["backup_keep_days"] = cc_ext.parse_backup_keep_days(base.get("backup_keep_days", cc_ext.BACKUP_KEEP_DAYS_DEFAULT))
    base["backup_keep_min"] = cc_ext.parse_backup_keep_min(base.get("backup_keep_min", cc_ext.BACKUP_KEEP_MIN_DEFAULT))
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



try:
    CONFIG = load_config()
except SystemExit as _fatal:  # Phase 15: a malformed config otherwise dies in a hidden console and nobody sees why
    hq_diagnostics.record_startup_fatal(ROOT, _fatal.code if isinstance(_fatal.code, str) else "startup aborted")
    raise


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
    (ROOT / "Inbox" / "Drawings").mkdir(parents=True, exist_ok=True)
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
    changed = False
    now = time.time()
    generation = auth_generation()
    with _SESSIONS_LOCK:
        for key, raw in list(_SESSIONS.items()):
            if isinstance(raw, (int, float)):
                if raw < now:
                    _SESSIONS.pop(key, None)
                    changed = True
                else:
                    _SESSIONS[key] = {"user": "admin", "role": "admin", "exp": raw, "gen": 0}
                    changed = True
            elif float(raw.get("exp") or 0) < now or int(raw.get("gen") or 0) != generation:
                _SESSIONS.pop(key, None)
                changed = True
        current = _SESSIONS.get(token)
        info = dict(current) if isinstance(current, dict) else None
        live = set(_SESSIONS)
    if changed:
        _persist_sessions()
    hq_forge_vault.retain_only(live)
    return info


def session_valid(token: str | None) -> bool:
    return session_info(token) is not None


hq_forge_vault.bind_session_checker(session_valid)


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
    hq_forge_vault.drop_session(token)


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
        # disk_transfert = HQ-root volume (primary); disk_d kept for older clients,
        # flagged missing:true when there is no D: drive.
        "disk_d": cc_ext.volume_info(Path("D:/"), disk_free(Path("D:/"))),
        "disk_transfert": cc_ext.volume_info(ROOT, disk_free(ROOT)),
        "backup_auto_paused": cc_ext.backup_auto_paused(),
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
    """This PC as a roster entry with real volume free space.

    Primary free space = the HQ-root volume (the drive holding ROOT); C:/D: follow
    when present. Missing drives are skipped, never reported as free space.
    """
    root_label = cc_ext.volume_label(ROOT)
    root_disk = disk_free(ROOT)
    candidates = [(root_label, root_disk)]
    for label, probe in (("C:", Path("C:/")), ("D:", Path("D:/"))):
        if label.upper() != root_label.upper():
            candidates.append((label, disk_free(probe)))
    disks = []
    readable = []
    for label, info in candidates:
        if info.get("error"):
            continue
        readable.append(info)
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
    primary = readable[0] if readable else {}
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
    return hq_companion.overlay_roster([host_device_entry(), *presence_list(), *peers])


def devices_roster() -> dict:
    peers = tailscale_peers()
    devices = [host_device_entry()] + presence_list() + peers
    _store_roster_cache(devices)
    return {"devices": [hq_devices.present(d) for d in hq_companion.overlay_roster(devices)]}


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
        "calendar": _calendar_summary(),
        "agent": hq_companion.summary(),
    }


def _calendar_summary() -> dict:
    """Local calendar only. Must not probe Tailscale."""
    try:
        if hq_calendar.ready():
            return hq_calendar.summary()
    except Exception:
        return {"today": [], "next": None, "malformed": True}
    return {"today": [], "next": None}


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


def search_content(q: str) -> list[dict]:
    """Palette content hits: Carnet pages, Forge prompts (normal gallery only, never the vault),
    calendar event titles and Inbox file names. A source that fails is skipped."""
    if len(" ".join(hq_search.words(q))) < hq_search.MIN_QUERY:
        return []

    def pages():
        if not hq_carnet.ready():
            return []
        out = []
        for page in hq_carnet.get_notebook().get("pages") or []:
            text = hq_carnet._text(page)
            out.append({"id": page.get("id"), "title": hq_carnet.derive_title(text), "text": text,
                        "updated_at": page.get("updated_at"), "deleted_at": page.get("deleted_at")})
        return out

    def images():
        base = hq_forge_gallery.gallery_dir(ROOT)
        out = []
        if base.is_dir() and not base.is_symlink():
            for child in base.iterdir():
                if child.is_symlink() or not hq_forge_gallery.IMG_RE.fullmatch(child.name):
                    continue
                try:
                    meta = hq_forge_gallery.get(ROOT, child.name)
                except hq_forge_gallery.GalleryError:
                    continue
                out.append({"id": child.name, "prompt": (meta.get("settings") or {}).get("prompt") or "", "created": meta.get("created")})
        return out

    def events():
        now = datetime.now()
        found, _bad = hq_calendar.manual_between(now - timedelta(days=366), now + timedelta(days=731))
        return found

    sources = {}
    for name, read in (("pages", pages), ("images", images), ("events", events), ("files", lambda: hq_search.inbox_files(ROOT))):
        try:
            sources[name] = read()
        except Exception:
            sources[name] = []
    return hq_search.search(q, **sources)


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


def build_today() -> dict:
    """Accueil 'Aujourd'hui' > 'Depuis hier'. Each source is optional: one that fails is left out."""
    now = time.time()
    since = now - hq_today.WINDOW_SEC
    sources: dict = {}
    readers = {
        "events": lambda: hq_events.list_events(limit=500).get("events") or [],
        "jobs": lambda: hq_forge_jobs.summary_rows(ROOT),
        "pages": lambda: hq_carnet.get_notebook(meta=True).get("pages") or [] if hq_carnet.ready() else [],
        "devices": lambda: hq_companion.list_devices(),
        "inbox": lambda: hq_today.inbox_times(ROOT / "Inbox", since),
    }
    missing = []
    for name, read in readers.items():
        try:
            sources[name] = read()
        except Exception:
            sources[name] = []
            missing.append(name)
    out = hq_today.build(now=now, **sources)
    out["missing"] = missing
    return out


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


class HQServer(ThreadingHTTPServer):
    """The HQ HTTP server. The page loads ~50 scripts and styles at once; through Tailscale
    Serve (HTTP/2 to the browser) they arrive as a burst of upstream connections. The stdlib
    default listen backlog of 5 makes Windows reset the overflow, which Tailscale turns into
    502 and the browser into missing modules (Carnet, Forge Studio, Accueil)."""

    request_queue_size = 128
    daemon_threads = True


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
        backup=lambda: cc_ext.run_backup(force=True, automatic=True),  # schedules/rules/scenes
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
        queue_lock=cc_ext.queue_lock,
        events_since=lambda since: [
            ev
            for ev in (hq_events.list_events(limit=100).get("events") or [])
            if float(ev.get("ts") or 0) > float(since or 0)
        ],
        events_recent=lambda limit=100: hq_events.list_events(limit=int(limit or 100)).get("events") or [],
        attention_items=lambda: hq_attention(cached_roster_devices()),
        build_brief=build_daily_brief,
    )
    hq_calendar.bind(
        root=ROOT,
        journal=lambda kind, message, **extra: cc_ext.log_activity(kind, message, **extra),
        alert=cc_ext.push_alert,
        queue_load=cc_ext.queue_load,
        run_scene=cc_ext.run_scene,
        run_action=pc_run_action,
        scenes=lambda: [s for s in (CONFIG.get("scenes") or []) if isinstance(s, dict)],
        actions=lambda: [a for a in (CONFIG.get("actions") or []) if isinstance(a, dict)],
        devices=cached_roster_devices,
    )
    hq_carnet.bind(
        root=ROOT,
        folders=lambda: list(CONFIG.get("folders") or DEFAULT_FOLDERS),
        system_names=SYSTEM_NAMES,
        safe_leaf_name=safe_leaf_name,
        task_add=cc_ext.kanban_add,  # Stage 07: selection -> card of the EXISTING Kanban board (no second task engine)
        task_path=cc_ext.kanban_path,
        transcribe_command=lambda: CONFIG.get("transcribe_command"),  # Phase 4: optional, never downloaded or installed by the bridge
    )

    def _agent_journal(kind, message, **extra):
        hq_events.record(
            kind,
            message,
            level=str(extra.get("level") or "info"),
            source=str(extra.get("source") or "agent"),
            meta=extra.get("meta") if isinstance(extra.get("meta"), dict) else None,
        )

    hq_companion.bind(ROOT, journal=_agent_journal, disk_free=disk_free, reserve_bytes=upload_disk_reserve_bytes)
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

const VIEW_LABELS = { accueil: 'Accueil', carnet: 'Carnet', calendrier: 'Calendrier', dessiner: 'Dessiner', forge: 'Forge Studio', fichiers: 'Fichiers', lecteur: 'Lecteur', ops: 'Terminal', plus: 'Plus' };
function viewTitle(view) {
  if (view === 'plus' && window.matchMedia('(min-width: 900px)').matches) return 'Système';
  return VIEW_LABELS[view] || 'Accueil';
}
// Dessiner bootstrap watchdog: the tab must never stay on « Chargement… ».
// Event-driven only (script error events, setView, one check at window load).
const SK_SCRIPTS = [
  ['hq-sketch-core.js', 'HQSketch', true],
  ['hq-solid-view.js', 'HQSolidView', false],
  ['hq-face-sketch.js', 'HQFaceSketch', false],
  ['hq-dessiner.js', 'hqSketchShow', true],
];
const SK_INIT_ERROR = "erreur d'initialisation";
const skFailedScripts = new Set();
window.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.tagName === 'SCRIPT' && t.dataset && t.dataset.sk) skFailedScripts.add(t.dataset.sk);
}, true);
function skMissingReason() {
  const failed = SK_SCRIPTS.find(([name, glob, required]) => required && !window[glob] && skFailedScripts.has(name));
  if (failed) return 'module de dessin non chargé (' + failed[0] + ')';
  if (!window.HQSketch) return 'module de dessin non chargé (hq-sketch-core.js)';
  if (!window.hqSketchShow) return 'module de dessin non chargé (hq-dessiner.js)';
  return SK_INIT_ERROR;
}
window.hqSketchFail = function (reason, kind) {
  const app = document.getElementById('hq-sk-app');
  if (!app) return;
  const box = document.createElement('div');
  box.className = 'sk-fail';
  box.setAttribute('role', 'alert');
  const title = document.createElement('p');
  title.className = 'sk-fail-title';
  title.textContent = "Dessiner n'a pas pu démarrer.";
  const why = document.createElement('p');
  why.className = 'hint sk-fail-reason';
  why.textContent = String(reason || SK_INIT_ERROR).slice(0, 120);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'secondary sk-retry';
  btn.textContent = 'Réessayer';
  btn.addEventListener('click', () => hqSketchRetry(kind === 'init' ? 'init' : 'load', btn));
  box.append(title, why, btn);
  app.textContent = '';
  app.appendChild(box);
};
function hqSketchStart() {
  if (!window.hqSketchShow) {
    // Classic scripts at the end of <body> all run before DOMContentLoaded, so a
    // missing module after that point is a load failure, not a race.
    if (document.readyState !== 'loading') window.hqSketchFail(skMissingReason(), 'load');
    return;
  }
  try { window.hqSketchShow(); } catch (e) { console.error(e); window.hqSketchFail(SK_INIT_ERROR, 'init'); }
}
let skRetrying = false;
function hqSketchRetry(kind, btn) {
  // Scripts present but init threw: state may be half-built, reload is the safe retry.
  if (kind === 'init' && window.hqSketchShow) { location.reload(); return; }
  if (skRetrying) return;
  skRetrying = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Nouvel essai…'; }
  // Re-inject only what never ran, in page order; never re-run hq-dessiner.js once it has.
  const todo = SK_SCRIPTS.filter(([, glob]) => !window[glob]);
  const next = () => {
    const item = todo.shift();
    if (!item) {
      skRetrying = false;
      skFailedScripts.clear();
      hqSketchStart();
      return;
    }
    const [name, , required] = item;
    const el = document.createElement('script');
    el.src = '/assets/' + name;
    el.dataset.sk = name;
    el.onload = next;
    el.onerror = () => {
      el.remove();
      if (!required) { next(); return; }  // 3D helpers are optional, as on first load
      skRetrying = false;
      window.hqSketchFail('module de dessin non chargé (' + name + ')', 'load');
    };
    document.body.appendChild(el);
  };
  next();
}
// Carnet bootstrap fallback: if hq-carnet.js never ran, show a durable error with retry
// instead of « Chargement… ». A Carnet failure never aborts HQ startup/navigation.
let carnetRetrying = false;
function hqCarnetMissing() {
  const app = document.getElementById('hq-carnet-app');
  if (!app || app.querySelector('.carnet, .carnet-fail')) return;
  const box = document.createElement('div');
  box.className = 'carnet-fail';
  box.setAttribute('role', 'alert');
  const title = document.createElement('p');
  title.className = 'carnet-fail-title';
  title.textContent = "Le carnet n'a pas pu s'ouvrir.";
  const why = document.createElement('p');
  why.className = 'hint carnet-fail-reason';
  why.textContent = 'module carnet non chargé (hq-carnet.js)';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'secondary carnet-retry';
  btn.textContent = 'Réessayer';
  btn.addEventListener('click', () => {
    if (window.hqCarnetShow) { app.textContent = ''; setView('carnet'); return; }
    if (carnetRetrying) return;
    carnetRetrying = true;
    btn.disabled = true;
    const load = (src, done, optional) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = done;
      el.onerror = () => { el.remove(); if (optional) { done(); return; } carnetRetrying = false; btn.disabled = false; };
      document.body.appendChild(el);
    };
    // Stage 04/05: the structured-content and sources modules must load before the editor.
    // Stage 06: the image pipeline is optional (the editor then reports "Images indisponibles" and keeps working).
    load('/assets/hq-carnet-modal.js', () => load('/assets/hq-carnet-errors.js', () => load('/assets/hq-carnet-annotations.js', () => load('/assets/hq-carnet-annotations-ui.js', () => load('/assets/hq-carnet-verifications.js', () => load('/assets/hq-carnet-verifications-ui.js', () => load('/assets/hq-carnet-reasoning.js', () => load('/assets/hq-carnet-reasoning-ui.js', () => load('/assets/hq-carnet-reader.js', () => load('/assets/hq-carnet-reader-ui.js', () => load('/assets/hq-carnet-media.js', () => load('/assets/hq-carnet-eng.js', () => load('/assets/hq-carnet-struct.js', () => load('/assets/hq-carnet-rich.js', () => load('/assets/hq-carnet-field.js', () => load('/assets/hq-carnet-field-ui.js', () => load('/assets/hq-carnet-sources.js', () => load('/assets/hq-carnet-eng-ui.js', () => load('/assets/hq-carnet-history-ui.js', () => load('/assets/hq-carnet-reviews.js', () => load('/assets/hq-carnet-intel.js', () => load('/assets/hq-carnet-intel-ui.js', () => load('/assets/hq-carnet-ask.js', () => load('/assets/hq-carnet-ask-ui.js', () => load('/assets/hq-carnet-reviews-ui.js', () => load('/assets/hq-carnet-portals.js', () => load('/assets/hq-carnet-portals-ui.js', () => load('/assets/hq-carnet-image-ui.js', () => load('/assets/hq-carnet-structured-ui.js', () => load('/assets/hq-carnet-nav.js', () => load('/assets/hq-carnet-polish-ui.js', () => load('/assets/hq-carnet-dessiner.js', () => load('/assets/hq-carnet-commands.js', () => load('/assets/hq-carnet-templates.js', () => load('/assets/hq-carnet-editor-ui.js', () => load('/assets/hq-carnet.js', () => {
      carnetRetrying = false;
      app.textContent = '';
      if (document.body.dataset.view === 'carnet' && window.hqCarnetShow) {
        try { window.hqCarnetShow(); } catch (e) { console.error(e); }
      }
    })))))))))))))))))))))))))))))))), true))));
  });
  box.append(title, why, btn);
  app.textContent = '';
  app.appendChild(box);
}
window.addEventListener('load', () => {
  const app = document.getElementById('hq-sk-app');
  if (document.body.dataset.view === 'dessiner' && app && !app.querySelector('.sk, .sk-fail')) hqSketchStart();
}, { once: true });

// Narrow phones may scroll the bottom nav sideways: keep the active target in view.
function hqNavReveal(b) {
  const nav = b.parentElement;
  if (!nav || nav.scrollWidth <= nav.clientWidth + 1) return;
  const l = b.offsetLeft, r = l + b.offsetWidth;
  if (l < nav.scrollLeft) nav.scrollLeft = l;
  else if (r > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = r - nav.clientWidth;
}
function setView(name) {
  let view = VIEW_LABELS[name] ? name : 'accueil';
  if (document.body.classList.contains('mode-simple') && view === 'ops') view = 'accueil';
  document.body.dataset.view = view;
  if (window.hqHideHelp) window.hqHideHelp();
  const lab = $('#view-label');
  const title = viewTitle(view);
  if (lab) lab.textContent = title;
  document.title = 'Transfert HQ · ' + title;
  $$('.bottom-nav [data-nav]').forEach(b => {
    const on = b.dataset.nav === view;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
    if (on) hqNavReveal(b);
  });
  try { localStorage.setItem('tf_hq_view', view); } catch (_) {}
  if (window.hqPlayerView) {
    try { window.hqPlayerView(view); } catch (e) { console.error(e); }  // like the other view hooks: never abort setView
  }
  if (view === 'fichiers') refreshFiles().catch(() => {});
  if (view === 'carnet' && window.hqCarnetShow) {
    try { window.hqCarnetShow(); } catch (e) { console.error(e); }  // a Carnet failure never aborts HQ
  } else if (view === 'carnet' && document.readyState !== 'loading') {
    hqCarnetMissing();
  }
  if (view === 'accueil' && window.hqCarnetHome) {
    try { window.hqCarnetHome(); } catch (e) { console.error(e); }  // admin-only summary; never aborts HQ
  }
  if (view === 'calendrier' && window.hqCalendarShow) {
    try { window.hqCalendarShow(); } catch (e) { console.error(e); }  // log as before, never abort startup
  }
  if (view === 'dessiner') hqSketchStart();
  if (view === 'forge' && window.hqForgeShow) {
    try { window.hqForgeShow(); } catch (e) { console.error(e); }
  } else if (window.hqForgeHide) {
    try { window.hqForgeHide(); } catch (e) { console.error(e); }
  }
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
    btn.removeAttribute('title');
    btn.setAttribute('data-help', simple
      ? 'Mode simple : le terminal et les outils avancés sont masqués.'
      : 'Mode complet : terminal, planning et automatisations sont visibles.');
  }
  if (window.hqHideHelp) window.hqHideHelp();
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
  const wide = window.matchMedia('(min-width: 900px)');
  if (wide.addEventListener) wide.addEventListener('change', () => {
    if (document.body.dataset.view) setView(document.body.dataset.view);
  });
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
  // Non-2xx errors carry err.status (+ err.data for JSON bodies); messages unchanged.
  const fail = (msg, data) => { const err = new Error(msg); err.status = res.status; if (data !== undefined) err.data = data; return err; };
  if (res.status === 401) {
    const now = Date.now();
    const last = Number(sessionStorage.getItem('tf_auth_at') || 0);
    if (!sessionStorage.getItem('tf_auth_redirect') && (now - last > 15000)) {
      sessionStorage.setItem('tf_auth_redirect', '1');
      sessionStorage.setItem('tf_auth_at', String(now));
      location.replace('/logout');
    }
    throw fail('PIN requis');
  }
  if (res.status === 403) {
    let msg = 'Réservé admin';
    try { const j = await res.clone().json(); if (j.error) msg = j.error; } catch (_) {}
    throw fail(msg);
  }
  sessionStorage.removeItem('tf_auth_redirect');
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) throw fail((data && data.error) || ('Erreur ' + res.status), data);
    return data;
  }
  if (!res.ok) throw fail('Erreur ' + res.status);
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

function currentFilesSort() {
  let value = 'name';
  try { value = localStorage.getItem('hq_files_sort') || 'name'; } catch (_) {}
  if (typeof hqFilesSortMode === 'function') return hqFilesSortMode(value);
  return value === 'recent' || value === 'size' ? value : 'name';
}

function renderFiles() {
  const q = ($('#search')?.value || '').trim().toLowerCase();
  const list = $('#file-list');
  const matched = itemsCache.filter(f => !q || f.name.toLowerCase().includes(q));
  const items = typeof hqSortFolderItems === 'function' ? hqSortFolderItems(matched, currentFilesSort()) : matched;
  $('#file-count').textContent = String(items.length);
  if (!items.length) {
    if (q && itemsCache.length) {
      list.innerHTML = '<li class="file empty empty-teach"><em>Aucun résultat dans ce dossier</em></li>';
    } else {
      list.innerHTML = `<li class="file empty empty-teach">
        <em>Aucun fichier ici</em>
        <p class="hint"><button type="button" class="ghost" data-go-accueil>Envoie depuis Accueil</button></p>
      </li>`;
      $$('[data-go-accueil]', list).forEach(b => b.addEventListener('click', () => setView('accueil')));
    }
    return;
  }
  list.innerHTML = items.map(f => {
    const isDir = f.type === 'dir';
    const mkind = isDir ? '' : hqMediaKind(f.name);
    const mediaAttr = mkind ? ` data-media="${mkind}" data-rel="${escapeAttr(f.rel)}" title="Double-clic : ouvrir dans le Lecteur"` : '';
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
      : `<a class="fname" href="${fmtRel(f.rel)}" target="_blank" rel="noopener">${hqMediaIcon(mkind)} ${escapeHtml(f.name)}</a>`;
    return `<li class="file ${isDir ? 'is-dir' : ''}"${mediaAttr}>
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
  const qs = new URLSearchParams();
  if (currentRel) qs.set('path', currentRel);
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
  if (n < 1024) return Math.round(n) + ' o'; // speeds are fractions: never « 96.55172413793105 o »
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
window.hqFavoriteFolders = () => favoritesCache.slice();
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
    <div class="space-track" aria-hidden="true">
      <div class="space-fill" style="width:${pctUsed}%;background:${color}"></div>
    </div>
  </div>`;
}

/* Accueil: one row of small device tiles (storage ring, name, status); offline ones fold away.
   The wallboard keeps the detailed cards. */
function deviceTile(d) {
  const on = d.online !== false;
  const name = String(d.name || '?').replace(/\.[a-z0-9-]+\.ts\.net$/i, '');
  let used = null;
  let freeLabel = '';
  let totalLabel = '';
  const round = (h) => String(h || '').replace(/\d+(?:\.\d+)?/, (m) => (+m >= 10 ? String(Math.round(+m)) : String(+(+m).toFixed(1))));
  const disks = (d.disks && d.disks.length) ? d.disks : ((d.free != null && d.total) ? [{ free: d.free, total: d.total, free_h: d.free_h, total_h: d.total_h }] : []);
  const many = disks.filter(x => x.total).length > 1;
  for (const x of disks) {
    if (!x.total) continue;
    const u = 1 - (x.free / x.total);
    // The fullest disk speaks for the device: « C: 106.88 Go libres sur 952.49 Go ».
    if (used == null || u > used) { used = u; freeLabel = (many && x.name ? x.name + ' ' : '') + round(x.free_h) + ' libres'; totalLabel = x.total_h ? 'sur ' + round(x.total_h) : ''; }
  }
  const detail = disks.filter(x => x.total).map(x => (x.name ? x.name + ' ' : '') + (x.free_h || '?') + ' libres sur ' + (x.total_h || '?')).join(' · ');
  const tone = used == null ? '' : (used > 0.85 ? 'is-low' : (used > 0.7 ? 'is-mid' : 'is-ok'));
  const mobile = /ios|android|iphone/i.test((d.os || '') + ' ' + name);
  const glyph = mobile
    ? '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M8 3.5h8a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1zM11 17.5h2"/>'
    : '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M4 5.5h16v10H4zM9 19.5h6M12 15.5v4"/>';
  const meta = on ? (freeLabel || (d.source === 'browser' ? 'navigateur' : 'en ligne')) : 'hors ligne';
  const ring = used == null ? '' : ` style="--used:${Math.max(0.02, Math.min(1, used)).toFixed(3)}"`;
  return `<li class="device-card device-tile ${on ? '' : 'is-off'} ${tone}" tabindex="0" role="button" aria-label="${escapeAttr(name + ' — ' + (detail || meta) + ' — ouvrir la fiche')}"${detail ? ` data-help="${escapeAttr(detail)}"` : ''} data-device-id="${escapeAttr(d.id || '')}">
      <span class="device-ring${used == null ? ' is-none' : ''}"${ring}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${glyph}</svg></span>
      <span class="device-tile-text"><strong>${escapeHtml(name)}</strong><span class="device-tile-meta">${escapeHtml(meta)}</span>${on && totalLabel ? `<span class="device-tile-meta device-tile-total">${escapeHtml(totalLabel)}</span>` : ''}</span>
      <span class="dot ${on ? 'on' : 'off'}" aria-hidden="true"></span>
    </li>`;
}

function renderDevices(devices) {
  const el = $('#hq-devices');
  if (!el) return;
  $('#hq-dev-count').textContent = String((devices || []).length);
  if (!devices || !devices.length) {
    el.innerHTML = '<li class="empty-teach"><em>Aucun appareil détecté</em><p class="hint">Ouvre HQ sur ton téléphone (même Tailscale) pour le voir ici</p></li>';
    return;
  }
  if (!document.body.classList.contains('wall')) {
    const online = devices.filter(d => d.online !== false);
    const offline = devices.filter(d => d.online === false);
    el.innerHTML = online.map(deviceTile).join('') + (offline.length
      ? `<li class="device-off-toggle"><button type="button" class="ghost home-link" id="home-devices-off" aria-expanded="false">${offline.length} hors ligne</button></li>` + offline.map(deviceTile).join('')
      : '');
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
    const accessLabels = {agent:'Agent HQ', ssh:'SSH', browser:'Navigateur', local:'Cet ordinateur'};
    const accessBadges = (Array.isArray(d.access) ? d.access : []).map(a => accessLabels[a]).filter(Boolean).map(label => `<span class="access-badge">${escapeHtml(label)}</span>`).join('');
    return `<li class="device-card" tabindex="0" role="button" aria-label="${escapeAttr((d.name || 'Appareil') + ' — ouvrir la fiche')}" data-device-id="${escapeAttr(d.id || '')}">
      <div class="device-head">
        <span class="dot ${on ? 'on' : 'off'}"></span>
        <strong>${escapeHtml(d.name || '?')}</strong>
        ${pathBadge}
        ${accessBadges}
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
          <div class="meta">opération · ${escapeHtml(x.at_h || '')} · ${escapeHtml(x.kind || '')}</div></li>`
      });
    }
  }
  if (filter === 'all') rows.sort((a, b) => (b.sort || 0) - (a.sort || 0));
  el.innerHTML = rows.slice(0, 16).map(r => r.html).join('')
    || '<li class="hint">Rien de récent. Un envoi depuis Accueil apparaîtra ici.</li>';
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
      const free = disk.free_h || '';
      chip.textContent = free ? ('● ' + free + ' libres') : '● État';
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
      $('#hq-health').textContent = ts + ' · ' + smb + (health.backup && health.backup.auto_paused ? ' · Backup auto en pause' : '');
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
  if (q.length < 2) {
    el.innerHTML = '<li class="hint">Saisis au moins deux lettres.</li>';
    return;
  }
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(q));
    el.innerHTML = (data.hits||[]).map(h =>
      `<li><button type="button" class="fname" data-srel="${escapeAttr(h.rel)}" style="background:none;border:0;padding:0;color:var(--accent)">${escapeHtml(h.name)}</button>
      <div class="meta">${escapeHtml(h.rel)} · ${escapeHtml(h.match)}${h.snippet? ' — '+escapeHtml(h.snippet):''}</div></li>`
    ).join('') || '<li class="hint">Aucun fichier ne correspond.</li>';
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
  ).join('') || '<li class="hint">Aucune alerte pour le moment.</li>';
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
    el.innerHTML = '<li class="hint">Rien de récent. Un envoi depuis Accueil apparaîtra ici.</li>';
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
      await withBusy('Lancement…', () => api('/api/scene', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: b.dataset.scene }) }));
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
    try {
      await withBusy('Verrouillage…', () => api('/api/pc/lock', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }));
      toast('PC verrouillé');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-sleep')?.addEventListener('click', async () => {
    if (!confirm('Mettre le PC en veille ?')) return;
    try {
      await withBusy('Mise en veille…', () => api('/api/pc/sleep', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }));
      toast('Veille demandée');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-shot')?.addEventListener('click', async () => {
    try {
      const data = await withBusy('Capture…', () => api('/api/pc/screenshot', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'
      }));
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
      await withBusy('Ouverture du dossier…', () => api('/api/pc/explore', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ path: currentRel || 'Inbox' })
      }));
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
      await withBusy('Envoi…', () => api('/api/send', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ to, rel, from: deviceName(), from_id: presenceId })
      }));
      toast('Envoyé');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-queue-add')?.addEventListener('click', async () => {
    const label = prompt('Nom de la tâche (ex: Ouvrir Uni au réveil):', 'Ouvrir Uni');
    if (!label) return;
    try {
      await api('/api/queue', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ label, when: 'online', type: 'explore', path: 'C:/Transfert/Uni' })
      });
      toast('Ajouté à la file');
      await refreshHQ();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-backup')?.addEventListener('click', async () => {
    if (!confirm('Lancer un backup maintenant ?')) return;
    try {
      const d = await withBusy('Sauvegarde…', () => api('/api/backup', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }), 'backup-busy');
      toast(d.path || 'Backup OK');
    }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-iz-archive')?.addEventListener('click', async () => {
    if (!confirm('Archiver les fichiers de Inbox ?')) return;
    try {
      const d = await withBusy('Archivage…', () => api('/api/inbox-zero', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'archive' }) }));
      toast(d.moved + ' fichier(s) archivé(s)');
      await refreshFiles();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-iz-sort')?.addEventListener('click', async () => {
    try {
      const d = await withBusy('Tri…', () => api('/api/inbox-zero', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'sort' }) }));
      toast(d.moved + ' fichier(s) trié(s)');
      await refreshFiles();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-iz-tmp')?.addEventListener('click', async () => {
    try {
      const d = await withBusy('Nettoyage…', () => api('/api/inbox-zero', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'empty-tmp' }) }));
      toast((d.removed||0) + ' fichier(s) tmp supprimé(s)');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#global-search')?.addEventListener('input', () => { clearTimeout(window._sq); window._sq = setTimeout(runSearch, 280); });
  $('#btn-print')?.addEventListener('click', async () => {
    const rel = ($('#print-rel')?.value || '').trim();
    if (!rel) { toast('Indique Print/fichier…', 'err'); return; }
    if (!confirm('Imprimer ' + rel + ' ?')) return;
    try {
      await withBusy('Impression…', () => api('/api/print', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ rel, printer: $('#print-printer')?.value || '' })
      }));
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
      const data = await withBusy('Exécution…', () => api('/api/shell', {
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

// ---- Lecteur (audio / vidéo) --------------------------------------------------
// Types streamed by /media/ (keep in sync with MEDIA_CONTENT_TYPES in iphone_bridge.py).
const HQ_MEDIA_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac',
  ogg: 'audio/ogg', opus: 'audio/ogg', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  glb: 'model/gltf-binary', stl: 'model/stl' };
function hqMediaIcon(kind) { return kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : kind === 'model' ? '🧊' : '📄'; }
// Containers no browser plays: the Lecteur explains instead of showing a broken player.
const HQ_MEDIA_UNSUPPORTED = ['mkv', 'avi', 'wmv', 'flv', 'wma', 'mpg', 'mpeg', 'vob'];
function hqMediaExt(name) { const m = /\.([a-z0-9]+)$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
function hqMediaKind(name) {
  const ext = hqMediaExt(name), type = HQ_MEDIA_TYPES[ext];
  if (type) return type.split('/')[0];
  return HQ_MEDIA_UNSUPPORTED.includes(ext) ? 'unsupported' : '';
}
function mediaRel(rel) { return '/media/' + rel.split('/').map(encodeURIComponent).join('/'); }
const hqPlayer = { rel: '', openedAt: 0, restored: false, ready: false, lib: [], libAt: 0, libError: '', libTruncated: false };
// Lecteur 3D (.glb / .stl): parsed and drawn by assets/hq-model-view.js (no network beyond /media/).
const hqModel = { viewer: null, token: 0, abort: null };
function hqModelInfo(text) { const el = $('#player-model-info'); if (el) el.textContent = text || ''; }
function hqModelStop() {
  hqModel.token++;
  if (hqModel.abort) { try { hqModel.abort.abort(); } catch (_) {} hqModel.abort = null; }
  const box = $('#player-model'); if (box) box.hidden = true;
  if (hqModel.viewer) hqModel.viewer.setModel(null);
  hqModelInfo('');
}
function hqModelFail(token, text) {
  if (token !== hqModel.token) return;
  hqModel.abort = null;
  if (hqPlayer.restored) { hqPlayerClear(); return; }  // last file from a previous visit is gone: start empty
  hqModelStop();
  hqPlayerMessage(text);
}
function hqModelWaitLib() {
  // The page loads hq-model-view.js after this script; wait for it instead of failing on first paint.
  if (window.HQModel) return Promise.resolve(window.HQModel);
  if (document.readyState === 'complete') return Promise.resolve(null);
  return new Promise(res => window.addEventListener('load', () => res(window.HQModel || null), { once: true }));
}
async function hqModelLoad(rel) {
  const token = ++hqModel.token;
  if (hqModel.abort) { try { hqModel.abort.abort(); } catch (_) {} }
  const box = $('#player-model'), canvas = $('#player-model-canvas');
  box.hidden = false;
  hqModelInfo('Chargement du modèle…');
  const M = await hqModelWaitLib();
  if (token !== hqModel.token) return;
  if (!M) { hqModelFail(token, 'Module 3D non chargé (hq-model-view.js). Recharge la page.'); return; }
  const entry = hqPlayer.lib.find(f => f.rel === rel);
  if (entry && entry.size > M.LIMITS.maxBytes) {
    hqModelFail(token, 'Modèle trop volumineux pour le lecteur 3D (' + entry.size_h + ', maximum ' + Math.round(M.LIMITS.maxBytes / 1048576) + ' Mo). « Sauver » reste possible.');
    return;
  }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  hqModel.abort = ctl;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; if (ctl) ctl.abort(); }, 120000);
  let buf;
  try {
    const r = await fetch(mediaRel(rel), { credentials: 'same-origin', cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    if (token !== hqModel.token) return;
    if (r.status === 401) { hqModelFail(token, 'Session expirée : reconnecte-toi puis réessaie.'); return; }
    if (r.status === 404) { hqModelFail(token, 'Fichier introuvable (déplacé ou supprimé ?).'); return; }
    if (!r.ok) { hqModelFail(token, 'Chargement impossible (erreur ' + r.status + ').'); return; }
    const len = Number(r.headers.get('Content-Length') || 0);
    if (len > M.LIMITS.maxBytes) { hqModelFail(token, 'Modèle trop volumineux pour le lecteur 3D (maximum ' + Math.round(M.LIMITS.maxBytes / 1048576) + ' Mo). « Sauver » reste possible.'); return; }
    hqModelInfo('Chargement du modèle…' + (len ? ' (' + (len / 1048576).toFixed(1) + ' Mo)' : ''));
    buf = await r.arrayBuffer();
  } catch (e) {
    if (token !== hqModel.token) return;
    hqModelFail(token, timedOut ? 'Chargement trop long (plus de 2 minutes). Réessaie sur un meilleur réseau.' : 'Chargement interrompu (réseau ou session expirée). Réessaie.');
    return;
  } finally { clearTimeout(timer); }
  if (token !== hqModel.token) return;
  hqModel.abort = null;
  hqModelInfo('Analyse du modèle…');
  await new Promise(res => setTimeout(res, 0));  // let the message paint before a long parse
  if (token !== hqModel.token) return;
  try {
    const model = M.parse(rel.split('/').pop() || rel, buf);
    if (!hqModel.viewer) hqModel.viewer = M.viewer(canvas);
    hqModel.viewer.setModel(model);
    hqPlayer.restored = false;
    const info = model.format + ' · ' + model.triangles.toLocaleString('fr-CA') + ' triangles' + (hqModel.viewer.webgl ? '' : ' · affichage simplifié (sans WebGL)');
    hqModelInfo(info);
    if (model.notices.length) hqPlayerMessage(model.notices.join(' '));
  } catch (e) {
    const text = e && e.name === 'ModelError' ? e.message : 'Modèle illisible : ' + ((e && e.message) || 'erreur inconnue') + '.';
    hqModelFail(token, text);
  }
}
function hqIsIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function hqPlayerMessage(text) { const m = $('#player-msg'); if (!m) return; m.textContent = text || ''; m.hidden = !text; }
function hqPlayerStop(el) {
  if (!el) return;
  try { el.pause(); } catch (_) {}
  if (el.getAttribute('src')) { el.removeAttribute('src'); try { el.load(); } catch (_) {} }
  el.hidden = true;
}
function hqPlayerClear() {
  hqPlayer.rel = ''; hqPlayer.restored = false;
  try { localStorage.removeItem('tf_hq_player_rel'); } catch (_) {}
  hqPlayerStop($('#player-video')); hqPlayerStop($('#player-audio')); hqModelStop();
  $('#player-name').textContent = 'Aucun fichier sélectionné';
  $('#player-where').textContent = 'Double-clique une musique, une vidéo ou un modèle 3D dans Fichiers, ou choisis-le ci-dessous.';
  $('#player-dl').hidden = true;
  hqPlayerMessage('');
  hqPlayerRenderList();
}
function hqPlayerLoad(rel, autoplay) {
  const video = $('#player-video'), audio = $('#player-audio');
  if (!video || !audio) return;
  const name = rel.split('/').pop() || rel, kind = hqMediaKind(name), ext = hqMediaExt(name);
  hqPlayer.rel = rel;
  try { localStorage.setItem('tf_hq_player_rel', rel); } catch (_) {}
  $('#player-name').textContent = name;
  $('#player-where').textContent = rel.split('/').slice(0, -1).join(' / ');
  const dl = $('#player-dl'); dl.href = dlRel(rel); dl.hidden = false;
  hqPlayerMessage('');
  if (kind === 'model') {
    hqPlayerStop(video); hqPlayerStop(audio);
    hqPlayerRenderList();
    hqModelLoad(rel);
    return;
  }
  hqModelStop();
  const use = kind === 'video' ? video : audio;
  hqPlayerStop(kind === 'video' ? audio : video);
  if (kind !== 'audio' && kind !== 'video') {
    hqPlayerStop(use);
    hqPlayerMessage(kind === 'unsupported'
      ? 'Le format .' + ext + ' ne se lit pas dans un navigateur (MKV, AVI, WMV… : ni Safari ni Chrome). Utilise « Sauver » puis ouvre-le avec VLC.'
      : "Ce fichier n'est ni une musique, ni une vidéo, ni un modèle 3D.");
    hqPlayerRenderList();
    return;
  }
  use.hidden = false;
  use.src = mediaRel(rel);
  hqPlayerRenderList();
  if (autoplay) {
    // Called from the double-click / double-tap handler, so iOS counts it as a user gesture.
    const started = use.play();
    if (started && started.catch) started.catch(e => { if (e && e.name === 'NotAllowedError') hqPlayerMessage('Appuie sur lecture pour démarrer.'); });
  }
}
function hqPlayerError(e) {
  const el = e.target;
  if (el.hidden || !el.getAttribute('src')) return;
  if (hqPlayer.restored) { hqPlayerClear(); return; }  // last file from a previous visit is gone: start empty
  const ext = hqMediaExt(hqPlayer.rel), code = el.error && el.error.code;
  let text;
  if (code === 2) text = 'Lecture interrompue (réseau ou session expirée). Réessaie.';
  else {
    text = 'Impossible de lire ce fichier ici : format ou codec non pris en charge par ce navigateur.';
    if (hqIsIOS() && (ext === 'ogg' || ext === 'opus')) text += ' Sur iPhone, OGG/Opus demande iOS 18.4 ou plus récent.';
    else if (hqIsIOS() && ext === 'webm') text += ' Sur iPhone, WebM demande iOS 17.4 ou plus récent.';
    text += ' « Sauver » reste possible.';
  }
  hqPlayerStop(el);
  hqPlayerMessage(text);
}
function hqPlayerInit() {
  if (hqPlayer.ready || !$('#player-video')) return;
  hqPlayer.ready = true;
  $('#player-video').addEventListener('error', hqPlayerError);
  $('#player-audio').addEventListener('error', hqPlayerError);
  $('#player-video').addEventListener('loadedmetadata', () => { hqPlayer.restored = false; });
  $('#player-audio').addEventListener('loadedmetadata', () => { hqPlayer.restored = false; });
  $('#btn-player-back').addEventListener('click', () => navigate(hqPlayer.rel ? hqPlayer.rel.split('/').slice(0, -1).join('/') : currentRel));
  $('#player-filter').addEventListener('input', hqPlayerRenderList);
  $('#player-list').addEventListener('click', (e) => { const b = e.target.closest('[data-play]'); if (b) hqPlayerOpen(b.dataset.play, true); });
  $('#btn-player-fit').addEventListener('click', () => { if (hqModel.viewer) hqModel.viewer.fit(); });
}
function hqPlayerOpen(rel, autoplay) {
  if (!rel) return;
  const now = Date.now();
  // One gesture can arrive twice (a touch double-tap that the browser also reports as dblclick).
  if (rel === hqPlayer.rel && now - hqPlayer.openedAt < 700 && document.body.dataset.view === 'lecteur') return;
  hqPlayer.openedAt = now;
  hqPlayer.rel = rel; hqPlayer.restored = false;
  if (document.body.dataset.view !== 'lecteur') setView('lecteur');
  hqPlayerInit();
  hqPlayerLoad(rel, autoplay);
  // Opened from far down Fichiers or the Lecteur list: bring the player (and any message) on screen.
  const top = $('#player-title');
  if (top && top.scrollIntoView) { try { top.scrollIntoView({ block: 'start' }); } catch (_) { top.scrollIntoView(); } }
}
window.hqPlayerOpen = hqPlayerOpen;
window.hqPlayerView = function (view) {
  if (view !== 'lecteur') {
    const video = $('#player-video');
    if (video && !video.paused) video.pause();  // music keeps playing while browsing; a hidden video does not
    return;
  }
  hqPlayerInit();
  if (!hqPlayer.rel) {
    let saved = '';
    try { saved = localStorage.getItem('tf_hq_player_rel') || ''; } catch (_) {}
    if (saved) { hqPlayer.restored = true; hqPlayerLoad(saved, false); }
  }
  hqPlayerLibrary(false);
};
async function hqPlayerLibrary(force) {
  if (!force && hqPlayer.libAt && Date.now() - hqPlayer.libAt < 30000) { hqPlayerRenderList(); return; }
  hqPlayer.libAt = Date.now();
  try {
    const d = await api('/api/media/library');
    hqPlayer.lib = d.items || []; hqPlayer.libTruncated = !!d.truncated; hqPlayer.libError = '';
  } catch (e) {
    hqPlayer.lib = []; hqPlayer.libError = e.message || 'Liste indisponible'; hqPlayer.libAt = 0;
  }
  hqPlayerRenderList();
}
function hqPlayerRenderList() {
  const list = $('#player-list');
  if (!list) return;
  const q = ($('#player-filter')?.value || '').trim().toLowerCase();
  const items = hqPlayer.lib.filter(f => !q || f.rel.toLowerCase().includes(q));
  $('#player-count').textContent = String(hqPlayer.lib.length);
  if (!items.length) {
    const empty = hqPlayer.libError || (q ? 'Aucun résultat' : "Aucune musique, vidéo ni modèle 3D dans Transfert pour l'instant.");
    list.innerHTML = `<li class="hint">${escapeHtml(empty)}</li>`;
    return;
  }
  list.innerHTML = items.map(f => {
    const cur = f.rel === hqPlayer.rel;
    return `<li class="player-item${cur ? ' is-current' : ''}"><button type="button" class="player-pick" data-play="${escapeAttr(f.rel)}"${cur ? ' aria-current="true"' : ''}>
      <span class="player-ico" aria-hidden="true">${hqMediaIcon(f.kind)}</span>
      <span class="player-item-body"><span class="fname">${escapeHtml(f.name)}</span>
      <span class="meta">${escapeHtml(f.rel.split('/').slice(0, -1).join(' / '))} · ${escapeHtml(f.size_h)} · ${escapeHtml(f.mtime_h)}</span></span></button></li>`;
  }).join('') + (hqPlayer.libTruncated ? '<li class="hint">Liste limitée aux 500 fichiers les plus récents.</li>' : '');
}
// File manager: double-click (mouse) or double-tap (touch, handled here because iOS Safari
// doesn't reliably fire dblclick) on a media row opens it in the Lecteur. Links and buttons
// in the row keep their single-click behavior.
function hqMediaRow(target) {
  if (!target || !target.closest) return null;
  const row = target.closest('#file-list li.file[data-media]');
  if (!row || target.closest('a, button, input, select, textarea, label, .file-more-menu')) return null;
  return row;
}
document.addEventListener('dblclick', (e) => {
  const row = hqMediaRow(e.target);
  if (!row) return;
  e.preventDefault();
  try { window.getSelection()?.removeAllRanges(); } catch (_) {}
  hqPlayerOpen(row.dataset.rel, true);
});
// Media names: a single click waits ~300 ms for a second one, then opens the file as before
// (new tab); a double click / double tap opens the Lecteur. Other names stay immediate.
// window.open runs inside the click's transient user activation (Chrome ~5 s, WebKit ~1 s).
let hqNameClick = null;
document.addEventListener('click', (e) => {
  const link = e.target && e.target.closest ? e.target.closest('#file-list li.file[data-media] a.fname') : null;
  if (!link || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const rel = link.closest('li.file').dataset.rel;
  if (hqNameClick && hqNameClick.rel === rel) {
    clearTimeout(hqNameClick.timer);
    hqNameClick = null;
    hqPlayerOpen(rel, true);
    return;
  }
  if (hqNameClick) clearTimeout(hqNameClick.timer);
  const href = link.href;
  hqNameClick = { rel, timer: setTimeout(() => { hqNameClick = null; window.open(href, '_blank', 'noopener'); }, 300) };
});
let hqLastTap = null;
// After a double tap opens the Lecteur, the browser still sends the second tap's compatibility
// click to whatever is now under the finger (e.g. another file in the Lecteur list): swallow it.
// Only a click at the tap's own spot within 600 ms counts; any other click passes (some browsers send none).
let hqGhostClick = null;
document.addEventListener('click', (e) => {
  const g = hqGhostClick;
  if (!g) return;
  hqGhostClick = null;
  if (Date.now() < g.until && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 30) { e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse') return;
  const row = hqMediaRow(e.target);
  if (!row) { hqLastTap = null; return; }
  const now = Date.now(), rel = row.dataset.rel;
  if (hqLastTap && hqLastTap.rel === rel && now - hqLastTap.t <= 300 && Math.hypot(e.clientX - hqLastTap.x, e.clientY - hqLastTap.y) < 40) {
    hqLastTap = null;
    e.preventDefault();
    hqGhostClick = { until: now + 600, x: e.clientX, y: e.clientY };
    hqPlayerOpen(rel, true);
    return;
  }
  hqLastTap = { rel, t: now, x: e.clientX, y: e.clientY };
});

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
  const sortSel = $('#file-sort');
  if (sortSel) {
    sortSel.value = currentFilesSort();
    sortSel.addEventListener('change', () => {
      const mode = typeof hqFilesSortMode === 'function' ? hqFilesSortMode(sortSel.value) : (sortSel.value === 'recent' || sortSel.value === 'size' ? sortSel.value : 'name');
      sortSel.value = mode;
      try { localStorage.setItem('hq_files_sort', mode); } catch (_) {}
      renderFiles();
    });
  }
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
  --tap-min:44px;
  --text-xs:.75rem;
  --text-sm:.82rem;
  --text-base:1rem;
  --focus-ring:2px solid var(--accent);
}
@media (prefers-color-scheme: light) {
  :root {
    --bg:#f0f3f6; --panel:#ffffff; --panel-2:#e8eef4; --text:#121a22; --muted:#3d4d5c; --line:#c5d0dc;
    /* #08724f on #fff ≈ 5.95:1 (AA). Previous #0b8f62 was ≈ 4.10:1. */
    /* #8b5e00 on #fff ≈ 5.68:1, on #e8eef4 ≈ 4.86:1 (AA). Previous #b87a12 was ≈ 3.60:1 / 3.08:1. */
    --accent:#08724f; --accent2:#08724f; --ok:#08724f; --warn:#8b5e00; --danger:#c62828;
    --okbg:#1f8f4e18; --errbg:#ff3b3018; --accent-text:#fff;
  }
}
*{box-sizing:border-box}
body{margin:0;font-family:var(--font);color:var(--text);min-height:100vh;background:var(--bg);line-height:1.45;
  padding-bottom:calc(var(--nav-h) + env(safe-area-inset-bottom,0px))}
.wrap{max-width:720px;margin:0 auto;padding:14px max(14px, env(safe-area-inset-right)) 24px max(14px, env(safe-area-inset-left));min-width:0}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.brand-lockup{display:flex;align-items:baseline;gap:8px}
.brand{font-size:1.25rem;letter-spacing:-.02em;text-transform:none;color:var(--text);font-weight:800}
.hq-pill{font-size:var(--text-xs);font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:3px 7px;border-radius:999px;
  background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 35%,var(--line))}
.status-chip{border:1px solid var(--line);background:var(--panel-2);color:var(--text);font:inherit;font-size:var(--text-sm);font-family:var(--font-mono);
  padding:8px 12px;border-radius:999px;cursor:pointer;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:var(--tap-min)}
.view-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 12px}.view-label{margin:0;font-size:var(--text-sm);font-weight:800;letter-spacing:.04em;text-transform:none;color:var(--muted)}
h1{font-size:1.7rem;margin:4px 0 6px;letter-spacing:-.02em}
.sub{color:var(--muted);margin:0 0 14px}
[data-panel]{display:none}
body[data-view="accueil"] [data-panel="accueil"],
body[data-view="carnet"] [data-panel="carnet"],
body[data-view="calendrier"] [data-panel="calendrier"],
body[data-view="dessiner"] [data-panel="dessiner"],
body[data-view="fichiers"] [data-panel="fichiers"],
body[data-view="ops"] [data-panel="ops"],
body[data-view="lecteur"] [data-panel="lecteur"],
body[data-view="forge"] [data-panel="forge"],
body[data-view="plus"] [data-panel="plus"]{display:block}
.player-name{margin:0;font-weight:800;font-size:1.05rem;word-break:break-word}
.player-where{margin:2px 0 12px}
.player-stage video{display:block;width:100%;max-height:62vh;background:#000;border-radius:12px}
.player-stage audio{display:block;width:100%}
.player-model canvas{display:block;width:100%;height:min(62vh,520px);background:#edf5fa;border-radius:12px;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.player-model-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:8px}
.player-model-bar button{width:auto;padding:8px 14px;min-height:var(--tap-min)}
.player-model-help{margin:6px 0 0;font-size:.85rem}
.player-stage [hidden],.player-actions [hidden]{display:none}
.player-msg{margin:12px 0 0;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--text)}
.player-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.player-actions .btn,.player-actions button{width:auto;padding:8px 14px;min-height:var(--tap-min)}
#player-filter{margin-bottom:12px}
.player-list .player-pick{display:flex;gap:10px;align-items:flex-start;justify-content:flex-start;width:100%;text-align:left;background:none;border:0;padding:8px;border-radius:10px;color:var(--text);min-height:var(--tap-min)}
.player-list .is-current .player-pick{background:color-mix(in srgb,var(--accent) 16%,transparent)}
.player-item-body{display:flex;flex-direction:column;gap:2px;min-width:0}
li.file[data-media]{touch-action:manipulation}
body[data-view="lecteur"] .wrap{width:100%}
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
.view-tools{display:flex;align-items:center;gap:8px}
.view-search{display:inline-flex;align-items:center;justify-content:center;width:var(--tap-min);height:var(--tap-min);padding:0;border:1px solid var(--line);
  border-radius:999px;background:var(--panel-2);color:var(--text);cursor:pointer}
.view-search svg{width:20px;height:20px}
.view-search:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mode-toggle{border:1px solid var(--line);background:var(--panel-2);color:var(--text);font:inherit;font-size:var(--text-sm);font-weight:800;
  padding:8px 12px;border-radius:999px;cursor:pointer;min-height:var(--tap-min);letter-spacing:.01em}
.mode-toggle[aria-pressed="true"]{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));color:var(--accent);
  background:color-mix(in srgb,var(--accent) 16%,var(--panel));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 40%,var(--line))}
body.mode-simple .mode-complet-only{display:none!important}
body.mode-simple .bottom-nav [data-nav="ops"]{display:none}
body.mode-simple[data-view="ops"] [data-panel="ops"]{display:none}
.empty-teach{padding:16px 4px;text-align:center}
.empty-teach em{display:block;font-style:normal;font-weight:700;margin-bottom:6px}
.empty-teach .hint{margin:0}
button.danger-outline,.btn.danger-outline{background:transparent;border:1.5px solid var(--danger);color:var(--danger);padding:8px 12px;font-size:var(--text-sm)}
.badge{font-size:var(--text-xs);font-weight:800;padding:3px 8px;border-radius:999px;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent)}
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
button.danger,.btn.danger{background:transparent;border:1.5px solid var(--danger);color:var(--danger);padding:8px 12px;font-size:var(--text-sm)}
button.ghost,.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text);padding:8px 12px;font-size:var(--text-sm);min-height:var(--tap-min)}
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
.crumb{border:0;background:transparent;color:var(--accent);font:inherit;font-weight:700;padding:8px 8px;cursor:pointer;min-height:var(--tap-min)}
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
.meta{font-size:var(--text-sm);color:var(--muted);font-family:var(--font-mono);line-height:1.4}
.row-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.row-actions .btn, .row-actions button{flex:0 0 auto;width:auto;padding:8px 12px;font-size:var(--text-sm);line-height:1.3;min-height:var(--tap-min)}
.file-more{position:relative}
.file-more-menu{display:none;position:absolute;right:0;top:calc(100% + 4px);z-index:20;min-width:160px;padding:6px;
  background:var(--panel-2);border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 28px #0008}
.file-more.open .file-more-menu{display:flex;flex-direction:column;gap:4px}
.file-more-menu .btn,.file-more-menu button,.file-more-menu a{width:100%;justify-content:flex-start}
.qrs{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.qrbox{text-align:center}
.qrbox div{display:inline-block;padding:8px;background:#fff;border-radius:12px;max-width:100%}
.qrbox canvas,.qrbox img{max-width:120px!important;height:auto!important}
.qrbox a{display:block;font-size:var(--text-xs);color:var(--muted);margin-top:6px;word-break:break-all;font-family:var(--font-mono);line-height:1.4}
.status dd{margin:2px 0 8px;font-weight:700;word-break:break-all;font-family:var(--font-mono)}
.status dt{font-size:var(--text-xs);text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
#toasts{position:fixed;left:50%;bottom:calc(var(--nav-h) + 12px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:99;width:min(92vw,420px);display:grid;gap:8px;pointer-events:none}
.toast{opacity:0;transform:translateY(8px);transition:.25s;background:var(--panel);border:1px solid var(--line);
  padding:12px 14px;border-radius:12px;box-shadow:0 10px 30px #0004;font-weight:700}
.toast.show{opacity:1;transform:none}
.toast.err{border-color:var(--danger)}
.pin-card{text-align:center;padding:28px 16px}
.pin-card input{text-align:center;letter-spacing:.28em;font-size:1.2rem}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.chip{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:999px;padding:8px 12px;font-weight:700;cursor:pointer;font-size:var(--text-sm);width:auto;flex:0 0 auto;min-height:var(--tap-min)}
.chip.active{background:var(--accent);border-color:var(--accent);color:var(--accent-text);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent-text) 30%,transparent)}
.hq-status{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0}
.hq-status dt{font-size:var(--text-xs);text-transform:uppercase;letter-spacing:.04em;color:var(--muted);align-self:center}
.hq-status dd{margin:0;font-weight:700;word-break:break-all;font-family:var(--font-mono)}
.hq-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:12px}
.hq-list li{border-bottom:0;font-size:.95rem;line-height:1.4}.hq-list li:not(.device-card){padding:0}
.hq-list .meta{font-size:var(--text-sm);color:var(--muted);line-height:1.4}
.hq-list li.device-card,.device-card{border:1px solid var(--line);border-radius:14px;padding:18px 20px 16px;background:color-mix(in srgb,var(--bg) 40%,var(--panel));box-sizing:border-box}
.device-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-bottom:10px}
.device-head strong{font-size:.98rem}
.device-kind{font-size:var(--text-xs);color:var(--muted);flex:1 1 auto;line-height:1.35}
.device-spaces{display:flex;flex-direction:column;gap:8px}
.space-row{display:flex;flex-direction:column;gap:4px}
.space-top{display:flex;justify-content:space-between;gap:8px;font-size:var(--text-xs);color:var(--muted);line-height:1.35}
.space-top span:first-child{font-weight:800;color:var(--text)}
.space-track{height:10px;border-radius:99px;background:color-mix(in srgb,var(--line) 80%,transparent);overflow:hidden}
.space-fill{height:100%;width:0;border-radius:99px;transition:width .35s ease,background .35s ease}
.path-badge{font-size:var(--text-xs);font-weight:800;padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--text)}
.path-badge.path-lan,.path-badge.path-direct,.path-badge.path-local{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,var(--line))}
.path-badge.path-tailscale{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,var(--line))}
.path-badge.path-relay{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}
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
.term-out{background:#0a0e14;color:#c6f6d5;border-radius:10px;padding:10px;min-height:80px;max-height:220px;overflow:auto;font-size:var(--text-sm);line-height:1.45;white-space:pre-wrap;font-family:var(--font-mono)}
.home-chart{min-height:72px}
.icon-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.icon-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:56px;padding:10px 6px;
  border-radius:12px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);font:inherit;font-weight:700;cursor:pointer}
.icon-btn .ico{font-size:1.25rem;line-height:1}
.icon-btn .lbl{font-size:var(--text-sm);color:var(--text);text-transform:none;letter-spacing:0;font-weight:700;line-height:1.2}
.bottom-nav{position:fixed;left:0;right:0;bottom:0;z-index:80;display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:0;
  background:color-mix(in srgb,var(--panel) 94%,transparent);border-top:1px solid var(--line);
  padding:6px max(8px, env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom,0px)) max(8px, env(safe-area-inset-left));backdrop-filter:blur(10px)}
.bottom-nav button{background:transparent;color:var(--muted);border:0;border-radius:10px;padding:6px 2px;font-size:var(--text-xs);
  font-weight:700;letter-spacing:0;text-transform:none;min-height:52px;flex-direction:column;gap:3px;line-height:1.2}
.bottom-nav button.active{color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 35%,transparent)}
.bottom-nav .nav-ico{display:flex;align-items:center;justify-content:center;line-height:0}
.nav-svg{display:block;width:20px;height:20px}
.bottom-nav .nav-label{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-label-desktop{display:none}
body.theme-oled{--bg:#000;--panel:#0a0a0a;--panel-2:#111;--line:#222}
body.theme-midnight{--bg:#0b1220;--panel:#121a2b;--accent:#7dd3fc;--accent2:#7dd3fc}
body.kiosk .wrap{max-width:100%;padding:10px}
body.kiosk .bottom-nav{display:none}
.hq-actions{justify-content:flex-start}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:2px;background:var(--muted);flex:0 0 auto}
.dot.on{background:var(--ok)}
.dot.off{background:var(--danger)}
@media (max-width:430px){
  /* Narrow phones: every nav target stays >= 44x44. If they cannot all fit (full mode
     below 360px), the nav scrolls sideways instead of shrinking the buttons. */
  .bottom-nav{padding-left:max(4px, env(safe-area-inset-left));padding-right:max(4px, env(safe-area-inset-right));
    grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:minmax(44px,1fr);
    overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;scrollbar-width:none;-webkit-overflow-scrolling:touch}
  .bottom-nav::-webkit-scrollbar{display:none}
  .bottom-nav button{padding:6px 0;font-size:.66rem;min-width:44px}
}
@media (max-width:359px){
  /* 6.5 buttons visible: the half-cut next button shows the nav scrolls. */
  body:not(.mode-simple) .bottom-nav{grid-auto-columns:max(44px, calc((100vw - 8px) / 6.5));scroll-snap-type:x proximity}
  body:not(.mode-simple) .bottom-nav button{scroll-snap-align:start}
}
@media (max-width:520px){
  .qrs{grid-template-columns:1fr}
  .wrap{padding:12px max(12px, env(safe-area-inset-right)) 20px max(12px, env(safe-area-inset-left))}
  .icon-actions{grid-template-columns:repeat(4,minmax(0,1fr))}
}
@media (min-width:900px){
  body{padding-bottom:0;display:grid;grid-template-columns:164px 1fr;min-height:100vh}
  .bottom-nav{position:sticky;top:0;left:auto;right:auto;bottom:auto;height:100vh;width:164px;grid-template-columns:1fr;
    border-top:0;border-right:1px solid var(--line);padding:16px 10px;align-content:start;gap:6px;order:0}
  .nav-label-mobile{display:none}
  .nav-label-desktop{display:inline}
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
.note-acc > summary{cursor:pointer;font-size:var(--text-sm);font-weight:800;letter-spacing:0;text-transform:none;color:var(--text);min-height:var(--tap-min);display:flex;align-items:center}
.note-acc[open] > summary{margin-bottom:10px;color:var(--text)}
.filter-chips{margin-bottom:10px}
[hidden]{display:none!important}
.busy-line,.op-busy{display:flex;align-items:center;gap:8px;margin-top:8px;padding:8px 10px;border-radius:10px;
  background:color-mix(in srgb,var(--accent) 12%,var(--panel-2));border:1px solid color-mix(in srgb,var(--accent) 30%,var(--line));
  font-size:var(--text-sm);font-family:var(--font);color:var(--text)}
.op-busy{position:fixed;left:50%;bottom:calc(var(--nav-h) + 56px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);
  z-index:90;width:min(92vw,420px);margin:0}
.busy-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1s infinite}
.busy-elapsed{margin-left:auto;color:var(--muted)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.skeleton{opacity:.7}
li.hint.skeleton::after{content:'';display:inline-block;width:4ch;animation:pulse 1.2s infinite}
button:disabled,.btn:disabled{opacity:.72;cursor:not-allowed}
:where(button,a,input,select,textarea,summary,[role="button"],.palette-card li):focus-visible{outline:var(--focus-ring);outline-offset:2px}
.accueil-main,.accueil-side,.accueil-grid,section{min-width:0}
@media (hover:hover) and (pointer:fine){
  button.secondary:not(:disabled):hover,
  button.ghost:not(:disabled):hover,
  button.danger:not(:disabled):hover,
  button.danger-outline:not(:disabled):hover,
  .icon-btn:not(:disabled):hover,
  .chip:not(.active):hover,
  .status-chip:hover,
  .mode-toggle:hover,
  .launch:hover,
  .palette-card li:hover,
  .device-card[data-device-id]:hover,
  .drop:hover,
  .bottom-nav button:hover,
  .crumb:hover{border-color:color-mix(in srgb,var(--accent) 50%,var(--line));background:color-mix(in srgb,var(--text) 6%,var(--panel))}
  button:not(.secondary):not(.ghost):not(.danger):not(.danger-outline):not(.icon-btn):not(.status-chip):not(.mode-toggle):not(.chip):not(:disabled):hover{filter:brightness(1.06)}
  .bottom-nav button:hover,.crumb:hover{filter:none}
}
@media (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference){
  .icon-btn:not(:disabled):hover,
  .launch:hover,
  .device-card[data-device-id]:hover{transform:translateY(-1px)}
}
@media (prefers-reduced-motion:reduce){
  .busy-dot,.skeleton,li.hint.skeleton::after{animation:none}
  .toast,.space-fill,.progress>div,.drop,.hq-cal-chip,.hq-cal-event{transition:none}
}
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
  <section class="hq" aria-labelledby="wb-next-title">
    <h2 id="wb-next-title">Prochain</h2>
    <div id="wb-next"><p class="hint">…</p></div>
  </section>
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
    $('#wb-health').textContent = (h.hostname||'') + ' · up ' + Math.round((h.uptime_sec||0)/60) + 'm · ' + ts + ' · ' + smb + ' · ' + ((h.disk_root && h.disk_root.volume) || 'D:') + ' ' + ((h.disk_root || h.disk_d || {{}}).free_h || '?');
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
    try {{
      const hq = await api('/api/hq');
      if (window.hqPaintCalendarSummary) window.hqPaintCalendarSummary(hq.calendar || {{}});
    }} catch (_) {{}}
    await refreshHQ();
    if (typeof renderHomeChart === 'function') await renderHomeChart();
  }} catch(e) {{ $('#wb-health').textContent = e.message; }}
}}
document.addEventListener('DOMContentLoaded', () => {{
  refreshWall();
  setInterval(refreshWall, 6000);
}});
</script>
<script src="/assets/hq-features.js"></script>
<script src="/assets/hq.js"></script>
<script src="/assets/hq-calendar.js"></script>
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
<link rel="stylesheet" href="/assets/hq-calendar.css"/>
<link rel="stylesheet" href="/assets/hq-dessiner.css"/>
<link rel="stylesheet" href="/assets/hq-carnet.css"/>
<link rel="stylesheet" href="/assets/hq-forge.css"/>
<link rel="stylesheet" href="/assets/hq-home.css"/>
<script src="/assets/qrcode.min.js"></script>
</head>
<body data-view="accueil">
<a class="skip-link" href="#main">Aller au contenu</a>
<nav class="bottom-nav" aria-label="Navigation HQ">
  <button type="button" class="active" data-nav="accueil" aria-current="page"><span class="nav-ico" aria-hidden="true"><svg class="nav-svg" viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/></svg></span><span class="nav-label">Accueil</span></button>
  <button type="button" data-nav="carnet"><span class="nav-ico" aria-hidden="true"><svg class="nav-svg" viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M6 3.5h11a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H6zM6 3.5v17M9.5 8h5.5M9.5 11.5h5.5"/></svg></span><span class="nav-label">Carnet</span></button>
  <button type="button" data-nav="calendrier"><span class="nav-ico" aria-hidden="true"><svg class="nav-svg" viewBox="0 0 24 24" focusable="false"><rect x="4" y="5" width="16" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M8 3.5v3M16 3.5v3M4 10h16"/></svg></span><span class="nav-label">Calendrier</span></button>
  <button type="button" data-nav="dessiner"><span class="nav-ico" aria-hidden="true"><svg class="nav-svg" viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M4 20l1.2-4.6L15.8 4.8a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8zM13.5 7l3.5 3.5M4 20h7"/></svg></span><span class="nav-label">Dessiner</span></button>
  <button type="button" data-nav="forge"><span class="nav-ico" aria-hidden="true"><svg class="nav-svg" viewBox="0 0 24 24" focusable="false"><rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.4" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M4 16l4.2-3.2 2.6 2.2L15 11l5 4"/></svg></span><span class="nav-label">Forge</span></button>
  <button type="button" data-nav="fichiers"><span class="nav-ico" aria-hidden="true"><svg class="nav-svg" viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg></span><span class="nav-label">Fichiers</span></button>
  <button type="button" data-nav="lecteur"><span class="nav-ico" aria-hidden="true"><svg class="nav-svg" viewBox="0 0 24 24" focusable="false"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="currentColor" d="M10 8.6v6.8l5.6-3.4z"/></svg></span><span class="nav-label">Lecteur</span></button>
  <button type="button" data-nav="ops"><span class="nav-ico" aria-hidden="true"><svg class="nav-svg" viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M5 7l5 5-5 5M12 17h7"/></svg></span><span class="nav-label">Terminal</span></button>
  <button type="button" data-nav="plus"><span class="nav-ico" aria-hidden="true"><svg class="nav-svg" viewBox="0 0 24 24" focusable="false"><circle cx="6" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18" cy="12" r="1.4" fill="currentColor"/></svg></span><span class="nav-label nav-label-mobile">Plus</span><span class="nav-label nav-label-desktop">Système</span></button>
</nav>
<main class="wrap" id="main">
  <header class="topbar" role="banner">
    <div class="brand-lockup">
      <div class="brand">Transfert</div>
      <span class="hq-pill">HQ</span>
    </div>
    <button type="button" class="status-chip" id="status-chip" data-help="État du pont. Ouvre Système pour l'espace, l'hôte et le rôle.">● …</button>
  </header>
  <div class="view-bar">
    <p class="view-label" id="view-label">Accueil</p>
    <div class="view-tools">
    <button type="button" class="view-search" id="btn-search-bar" aria-label="Recherche" data-help="Recherche partout : dossiers, scènes, appareils, Carnet, prompts Forge, calendrier et noms de fichiers. Ctrl+K ou Cmd+K."><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.9"/><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="m15 15 5 5"/></svg></button>
    <button type="button" class="mode-toggle" id="mode-toggle" aria-pressed="true" data-help="Mode simple : le terminal et les outils avancés sont masqués.">Mode simple</button>
    </div>
  </div>

  <div data-panel="accueil" class="accueil-grid home-v2">
    <section id="hq-banner" class="hq home-hero hq-banner state-ok" aria-labelledby="home-greet">
      <div class="home-hero-head">
        <div class="home-hello">
          <p class="home-date" id="home-date"></p>
          <h2 class="home-greet" id="home-greet">Bonjour</h2>
        </div>
        <button type="button" class="hq-disclosure home-status" id="hq-attention-toggle" aria-expanded="false" aria-controls="hq-attention-panel" data-help="Affiche les éléments qui demandent ton attention.">
          <span class="hq-state-dot" id="hq-state-dot" aria-hidden="true"></span>
          <strong id="hq-state-label">HQ</strong>
          <span class="hq-disclosure-meta" id="hq-state-sub" aria-live="polite"><span class="home-skel" aria-hidden="true"></span><span class="visually-hidden">Lecture de l'état…</span></span>
          <svg class="hq-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
      <div id="hq-attention-panel" class="hq-disclosure-panel" hidden>
        <ul class="hq-list" id="hq-attention"></ul>
        <div class="row hq-actions" id="hq-quick-scenes"></div>
      </div>
      <button type="button" class="home-next" id="home-next" hidden></button>
    </section>

    <nav class="home-actions" aria-label="Actions rapides">
      <button type="button" class="home-act" id="btn-camera" data-help="Prend une photo et l'envoie dans le dossier choisi."><span class="home-act-ico" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></span><span class="home-act-label">Photo</span></button>
      <button type="button" class="home-act" id="home-act-note" hidden data-help="Écrit une note rapide dans le Carnet."><span class="home-act-ico" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M6 3.5h8l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1zM14 3.5v4h4M8.5 12h7M8.5 15.5h5"/></svg></span><span class="home-act-label">Note</span></button>
      <button type="button" class="home-act" id="home-act-event" data-help="Ajoute un événement en une phrase : « Dentiste demain 14h »."><span class="home-act-ico" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><rect x="4" y="5" width="16" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M8 3.5v3M16 3.5v3M4 10h16M12 13v4.5M9.75 15.25h4.5"/></svg></span><span class="home-act-label">Agenda</span></button>
      <button type="button" class="home-act" id="home-act-file" data-help="Envoie un fichier dans le dossier choisi (Envoyer, plus bas). Sur ordinateur, glisse-le n'importe où sur Accueil."><span class="home-act-ico" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" d="M12 15V4.5M7.5 9 12 4.5 16.5 9M5 14.5v4A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-4"/></svg></span><span class="home-act-label">Fichier</span></button>
      <button type="button" class="home-act" id="btn-palette" data-help="Cherche un dossier, une scène, un appareil, une action, ou un mot dans le Carnet, les prompts Forge, le calendrier et les noms de fichiers. Ctrl+K ou Cmd+K."><span class="home-act-ico" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="m15 15 5 5"/></svg></span><span class="home-act-label">Recherche</span><kbd class="kbd-hint">Ctrl K</kbd></button>
    </nav>

    <div class="home-col home-col-main">
    <section class="hq carnet-home" id="hq-carnet-home" aria-label="Carnet" hidden></section>

    <section class="hq home-today" id="hq-cal-home" aria-labelledby="cal-home-title">
      <button type="button" class="hq-disclosure" id="hq-today-toggle" aria-expanded="true" aria-controls="hq-today-panel" data-help="Ce qui est prévu aujourd'hui.">
        <span class="hq-disclosure-copy">
          <strong id="cal-home-title">Aujourd'hui</strong>
          <span class="hq-disclosure-meta" id="hq-cal-next"><span class="home-skel" aria-hidden="true"></span><span class="visually-hidden">Chargement…</span></span>
        </span>
        <svg class="hq-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
      <div id="hq-today-panel" class="hq-disclosure-panel">
        <div id="hq-cal-today"><div class="home-skel-lines" aria-hidden="true"><span class="home-skel"></span><span class="home-skel is-short"></span></div></div>
        <button type="button" class="ghost home-link" id="hq-cal-open">Ouvrir le calendrier ›</button>
      </div>
    </section>

    <section class="hq home-feed" aria-labelledby="recents-title">
      <div class="home-head">
        <h2 id="recents-title">Activité récente</h2>
      </div>
      <div id="hq-since" class="hq-since" hidden>
        <h3 id="hq-since-title" class="hq-since-title">Depuis hier</h3>
        <ul class="hq-list hq-since-list" id="hq-since-list" aria-labelledby="hq-since-title"></ul>
        <p class="hint" id="hq-since-empty" hidden>Rien de nouveau depuis hier.</p>
      </div>
      <div class="chips filter-chips" id="recents-filters" role="tablist" aria-label="Filtrer récents">
        <button type="button" class="chip active" data-recents="all" role="tab" aria-selected="true">Tous</button>
        <button type="button" class="chip" data-recents="transfers" role="tab" aria-selected="false">Envois</button>
        <button type="button" class="chip" data-recents="activity" role="tab" aria-selected="false">Opérations</button>
      </div>
      <ul class="hq-list home-feed-list" id="hq-recents"><li class="home-skel-row" aria-hidden="true"><span class="home-skel"></span><span class="home-skel is-short"></span></li><li class="home-skel-row" aria-hidden="true"><span class="home-skel"></span><span class="home-skel is-short"></span></li><li class="home-skel-row" aria-hidden="true"><span class="home-skel"></span><span class="home-skel is-short"></span></li></ul>
      <button type="button" class="ghost home-link" id="home-feed-more" aria-controls="hq-recents" aria-expanded="false" hidden>Tout voir</button>
      <ul class="hq-list" id="hq-transfers" hidden></ul>
      <ul class="hq-list" id="hq-activity" hidden></ul>
    </section>
    </div>

    <div class="home-col home-col-side">
    <section class="hq home-devices" aria-labelledby="devices-title">
      <div class="home-head">
        <h2 id="devices-title">Appareils <span class="badge" id="hq-dev-count">0</span></h2>
        <button type="button" class="ghost home-link" id="btn-agent-center" data-help="Jetons d'enrôlement, approbations et historique des companions. Les iPhone restent des navigateurs.">Centre agents ›</button>
      </div>
      <ul class="hq-list home-device-row" id="hq-devices"><li class="device-tile device-skel" aria-hidden="true"><span class="device-ring is-none"></span><span class="device-tile-text"><span class="home-skel"></span><span class="home-skel is-short"></span></span></li><li class="device-tile device-skel" aria-hidden="true"><span class="device-ring is-none"></span><span class="device-tile-text"><span class="home-skel"></span><span class="home-skel is-short"></span></span></li><li class="visually-hidden">Chargement…</li></ul>
    </section>

    <section class="hq home-pc" aria-labelledby="actions-title">
      <div class="home-head">
        <h2 id="actions-title">Ce PC</h2>
        <button type="button" class="secondary home-chip" id="btn-sync-captures" data-help="Ramène les captures récentes dans Inbox/Captures.">Récupérer les captures</button>
      </div>
      <div class="icon-actions home-pc-row" id="hq-actions">
        <button type="button" class="icon-btn" id="btn-lock" aria-label="Verrouiller le PC" data-help="Verrouille la session Windows de ce PC."><span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><rect x="5" y="10.5" width="14" height="9.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg></span><span class="lbl">Verrouiller</span></button>
        <button type="button" class="icon-btn" id="btn-sleep" aria-label="Mettre en veille" data-help="Met ce PC en veille."><span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/></svg></span><span class="lbl">Veille</span></button>
        <button type="button" class="icon-btn" id="btn-shot" aria-label="Prendre une capture" data-help="Enregistre une capture d'écran dans Captures."><span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></span><span class="lbl">Capture</span></button>
        <button type="button" class="icon-btn" id="btn-explore" aria-label="Ouvrir l'explorateur" data-help="Ouvre le dossier courant dans l'explorateur de ce PC."><span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg></span><span class="lbl">Dossier</span></button>
      </div>
      <div class="row hq-actions mode-complet-only" id="hq-custom-actions" aria-label="Actions personnalisées"></div>
      <div class="row hq-actions mode-complet-only" id="hq-scenes" aria-label="Scènes"></div>
      <p class="sec-hint mode-complet-only">Scènes = plusieurs actions d'un coup</p>
    </section>

    <section class="hq home-send" aria-labelledby="envoyer-title">
      <div class="home-head">
        <h2 id="envoyer-title">Envoyer</h2>
        <label class="home-send-to" for="upload-folder"><span>vers</span><select id="upload-folder">{opts}</select></label>
      </div>
      <div class="row home-send-more">
        <button type="button" class="secondary home-chip" id="btn-paste">Coller une image</button>
        <button type="button" class="secondary home-chip" id="btn-voice">Note vocale</button>
      </div>
      <p class="hint home-send-hint">Photos → Inbox/Photos · captures → Captures · PDF → Uni · max {html.escape(human_size(max_upload_bytes()))}</p>
      <div id="progress" class="progress" hidden><div id="progress-fill"></div></div>
      <div id="progress-label" class="hint"></div>
      <div id="offline-queue" class="hint"></div>
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

    <div class="home-edit-row" id="home-edit-row" hidden>
      <button type="button" class="ghost home-link" id="home-edit" aria-pressed="false">Modifier l'accueil</button>
    </div>

    <div id="drop-zone" class="home-drop" role="button" tabindex="-1" aria-label="Zone d'envoi de fichiers">
      <div class="home-drop-card"><strong>Lâche pour envoyer</strong><span class="hint">vers <b id="home-drop-folder">Inbox</b></span></div>
    </div>
    <input id="file-input" type="file" multiple hidden/>
    <input id="camera-input" type="file" accept="image/*" capture="environment" hidden/>
  </div>

  <div data-panel="carnet">
    <section class="hq hq-carnet" aria-labelledby="carnet-title">
      <h2 id="carnet-title" class="visually-hidden">Carnet</h2>
      <div id="hq-carnet-app">
        <p class="hint">Chargement…</p>
      </div>
    </section>
  </div>

  <div data-panel="calendrier">
    <section class="hq hq-cal" aria-labelledby="cal-title">
      <div class="sec-head">
        <h2 id="cal-title" class="visually-hidden">Calendrier</h2>
        <p class="sec-hint" id="hq-cal-tz">Ce qui se passe, ce qui est prévu, ce qui vient</p>
      </div>
      <div id="hq-cal-app"><p class="hint">Chargement…</p></div>
    </section>
  </div>

  <div data-panel="dessiner">
    <section class="hq hq-sk" aria-labelledby="sk-title">
      <div class="sec-head">
        <h2 id="sk-title">Dessiner</h2>
        <p class="sec-hint">Croquis rapide ou construction cotée · tactile, stylet, souris · enregistré dans Inbox/Drawings (JSON + PNG + DXF)</p>
      </div>
      <div id="hq-sk-app"><p class="hint">Chargement…</p></div>
    </section>
  </div>

  <div data-panel="fichiers">
    <section class="hq" aria-labelledby="search-title">
      <div class="sec-head">
        <h2 id="search-title">Recherche globale</h2>
        <p class="sec-hint">Chercher un fichier ou du texte dans les notes</p>
      </div>
      <input id="global-search" type="search" placeholder="Ex. facture, capture, notes…" aria-label="Recherche globale" data-help="Cherche un nom de fichier ou du texte dans les notes."/>
      <ul class="hq-list" id="search-hits"><li class="hint">Saisis au moins deux lettres.</li></ul>
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
      </div>
      <div class="fm-filter">
        <input id="search" type="search" placeholder="Filtrer ce dossier…" aria-label="Filtrer ce dossier"/>
        <label class="fm-sort" for="file-sort">Trier
          <select id="file-sort">
            <option value="name">Nom</option>
            <option value="recent">Récent</option>
            <option value="size">Taille</option>
          </select>
        </label>
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

  <div data-panel="lecteur">
    <section class="hq hq-primary" aria-labelledby="player-title">
      <div class="sec-head">
        <h2 id="player-title">Lecteur</h2>
        <p class="sec-hint">Musique, vidéos et modèles 3D déjà dans Transfert</p>
      </div>
      <p class="player-name" id="player-name">Aucun fichier sélectionné</p>
      <p class="hint player-where" id="player-where">Double-clique une musique, une vidéo ou un modèle 3D dans Fichiers, ou choisis-le ci-dessous.</p>
      <div class="player-stage">
        <video id="player-video" controls playsinline preload="metadata" hidden></video>
        <audio id="player-audio" controls preload="metadata" hidden></audio>
        <div id="player-model" class="player-model" hidden>
          <canvas id="player-model-canvas" aria-label="Aperçu 3D du modèle"></canvas>
          <div class="player-model-bar">
            <button type="button" class="secondary" id="btn-player-fit">Recadrer</button>
            <span class="hint" id="player-model-info" role="status"></span>
          </div>
          <p class="hint player-model-help">Un doigt : tourner · deux doigts : déplacer et zoomer · souris : glisser pour tourner, clic droit ou Maj pour déplacer, molette pour zoomer.</p>
        </div>
      </div>
      <p class="player-msg" id="player-msg" role="status" hidden></p>
      <div class="player-actions">
        <button type="button" class="secondary" id="btn-player-back">← Retour aux fichiers</button>
        <a class="btn secondary" id="player-dl" href="#" download hidden>Sauver</a>
      </div>
    </section>
    <section class="hq" aria-labelledby="player-lib-title">
      <div class="sec-head">
        <h2 id="player-lib-title">Musique, vidéos et 3D <span class="badge" id="player-count">0</span></h2>
        <p class="sec-hint">Dans Inbox, Uni et Print, les plus récents d'abord</p>
      </div>
      <input id="player-filter" type="search" placeholder="Filtrer…" aria-label="Filtrer la musique, les vidéos et les modèles 3D"/>
      <ul class="hq-list player-list" id="player-list"><li class="hint">Chargement…</li></ul>
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

  <div data-panel="forge" id="forge-studio" data-layout="auto">
    <header class="forge-head">
      <p class="forge-kicker">Espace indépendant</p>
      <h1>Forge Studio</h1>
      <p id="forge-couch-note" class="forge-note forge-couch-note" hidden>Mode canapé : réglages masqués, ils restent appliqués. La session et le verrouillage ne changent pas.</p>
      <p id="forge-status" class="forge-status" role="status" aria-live="polite">Lecture de Forge…</p>
      <div class="forge-head-tools">
        <div class="forge-layout-pick">
          <label for="forge-layout">Disposition</label>
          <select id="forge-layout">
            <option value="auto" selected>Automatique</option>
            <option value="compact">Compacte</option>
            <option value="expanded">Étendue</option>
          </select>
        </div>
        <button type="button" id="forge-couch" class="secondary forge-couch-toggle" aria-pressed="false">Mode canapé</button>
        <button type="button" id="forge-capture" class="forge-capture" aria-haspopup="dialog" aria-expanded="false" aria-controls="hq-capture" title="Capture rapide dans le carnet" hidden>Capturer</button>
      </div>
    </header>
    <div class="forge-shell">
      <div class="forge-dest forge-m" role="radiogroup" aria-label="Destination">
        <div class="forge-help-wrap">
          <label><input type="radio" name="forge-destination" value="normal" checked/> Galerie</label>
          <button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-gallery">Aide</button>
          <p id="forge-help-gallery" class="forge-help-pop" role="tooltip">L'image est enregistrée dans la galerie de cet HQ. Elle n'entre pas dans le coffre privé.</p>
        </div>
        <div class="forge-help-wrap">
          <label><input type="radio" name="forge-destination" value="private"/> Coffre privé</label>
          <button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-private">Aide</button>
          <p id="forge-help-private" class="forge-help-pop" role="tooltip">L'image n'est gardée que si le coffre est déverrouillé et limité à ce compte Windows. Un préréglage n'enregistre jamais ces images ni la clé du coffre. Un préréglage créatif copie le prompt en clair, hors du coffre.</p>
        </div>
      </div>
      <section id="forge-vault" class="forge-vault forge-m" hidden>
        <div class="forge-vault-banner">
          <span class="forge-lock" aria-hidden="true">&#128274;</span>
          <div>
            <h2 id="forge-vault-title">Coffre privé</h2>
            <div class="forge-help-wrap forge-vault-lead-wrap"><p id="forge-vault-lead">Chiffré à part, avec sa propre phrase.</p><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-vault-lead">Aide</button><p id="forge-help-vault-lead" class="forge-help-pop" role="tooltip">Un chiffrement séparé protège ces images. Le PIN HQ ne les déverrouille pas : seule la phrase du coffre (ou sa clé de récupération) l'ouvre.</p></div>
          </div>
        </div>
        <div id="forge-vaults" class="forge-vaults" hidden>
          <div class="forge-vaults-head">
            <h3 id="forge-vaults-title" class="forge-vault-sub">Mes coffres</h3>
            <button type="button" id="forge-vaults-new" class="secondary">Nouveau coffre</button>
            <button type="button" id="forge-vaults-restore" class="secondary">Restaurer un ZIP</button>
          </div>
          <p id="forge-vaults-note" class="forge-note" role="status" aria-live="polite"></p>
          <ul id="forge-vaults-list" class="forge-vaults-list" aria-labelledby="forge-vaults-title"></ul>
          <p id="forge-vaults-empty" class="forge-note">Aucun coffre pour l'instant.</p>
          <div id="forge-vault-current-actions" class="forge-actions forge-vault-main" hidden>
            <button type="button" id="forge-vault-lock">Verrouiller</button>
            <button type="button" id="forge-vault-current-open" hidden>Ouvrir</button>
          </div>
          <button type="button" id="forge-vaults-all" class="secondary forge-vaults-all" aria-expanded="false" aria-controls="forge-vaults-more" hidden>Tous mes coffres</button>
          <div id="forge-vaults-more" class="forge-vaults-more" hidden>
            <div class="field forge-vaults-sort"><label for="forge-vaults-sort">Trier</label><select id="forge-vaults-sort"><option value="manuel">Ordre choisi</option><option value="nom">Par nom</option><option value="recent">Par récent</option></select></div>
            <p id="forge-vaults-sort-note" class="forge-note" hidden>« Récent » utilise le jour de la dernière ouverture. Ce jour reste visible quand les coffres sont verrouillés.</p>
          </div>
          <details id="forge-vaults-health-fold" class="forge-fold">
            <summary>État des coffres</summary>
            <div class="forge-help-wrap"><p class="forge-note">Lecture seule : rien n'est réparé ni effacé.</p><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-vaults-health">Aide</button>
            <p id="forge-help-vaults-health" class="forge-help-pop" role="tooltip">Sans phrase, HQ ne vérifie que ce que le disque montre : dossiers, en-têtes, fichiers en trop, taille et dernière sauvegarde. Pour déchiffrer chaque image, ouvre le coffre puis « Vérifier toutes les images ».</p></div>
            <button type="button" id="forge-vaults-health-run" class="secondary">Actualiser</button>
            <ul id="forge-vaults-health-list" class="forge-health-list" aria-label="État de chaque coffre"></ul>
            <p id="forge-vaults-health-total" class="forge-note" role="status" aria-live="polite"></p>
          </details>
        </div>
        <section id="forge-migrate" class="forge-migrate" aria-labelledby="forge-migrate-title" hidden>
          <h3 id="forge-migrate-title" class="forge-vault-sub">Déplacer ton coffre</h3>
          <p class="forge-note">Ton coffre va être déplacé, sans être rechiffré. Ta phrase, ta clé de récupération et tes images restent les mêmes. Ensuite, il apparaît dans Mes coffres et tu peux en créer d'autres.</p>
          <p class="forge-note">Rien ne se fait tout seul : le déplacement commence seulement quand tu le confirmes.</p>
          <form id="forge-migrate-unlock" class="forge-vault-sheet">
            <div class="field"><label for="forge-migrate-pass">Phrase du coffre</label><input id="forge-migrate-pass" type="password" maxlength="128" autocomplete="current-password" required/></div>
            <button type="submit" id="forge-migrate-open">Ouvrir le coffre</button>
          </form>
          <div id="forge-migrate-offer" class="forge-migrate-step" hidden>
            <p class="forge-note">1. Télécharge d'abord une sauvegarde chiffrée (ZIP) et garde-la hors de HQ.</p>
            <div class="forge-actions">
              <button type="button" id="forge-migrate-zip">Télécharger la sauvegarde</button>
              <button type="button" class="secondary" id="forge-migrate-skip">Continuer sans sauvegarde</button>
            </div>
          </div>
          <div id="forge-migrate-confirm" class="forge-migrate-step" hidden>
            <p id="forge-migrate-offer-note" class="forge-note">2. Confirme dans les 15 minutes, sans verrouiller. Verrouiller, l'auto-verrouillage ou 5 minutes sans rien faire annulent l'offre : il faudra télécharger à nouveau la sauvegarde.</p>
            <label class="forge-privacy-ack" for="forge-migrate-ack"><input type="checkbox" id="forge-migrate-ack"/> J'ai compris : mon coffre va être déplacé</label>
            <button type="button" id="forge-migrate-go" disabled>Déplacer mon coffre</button>
          </div>
          <div class="forge-actions"><button type="button" class="secondary" id="forge-migrate-lock" hidden>Verrouiller</button></div>
          <p id="forge-migrate-status" class="forge-note" role="status" aria-live="polite"></p>
        </section>
        <p id="forge-private-note" class="forge-note">La génération privée reste désactivée tant que cette installation de Forge n'a pas prouvé qu'elle n'écrit pas de copie en clair.</p>
        <form id="forge-vault-setup" class="forge-vault-create" hidden>
          <div class="forge-vault-create-head"><span id="forge-vault-create-tile" class="forge-vault-tile" data-colour="ardoise" aria-hidden="true"></span><h3 class="forge-vault-sub">Nouveau coffre</h3></div>
          <div class="field"><label for="forge-vault-label">Nom du coffre</label><input id="forge-vault-label" type="text" maxlength="40" autocomplete="off" autocapitalize="sentences" spellcheck="false" required/></div>
          <p id="forge-vault-label-warn" class="forge-note forge-vault-warn" role="note"></p>
          <label class="forge-privacy-ack" for="forge-vault-discret"><input type="checkbox" id="forge-vault-discret"/> Discret : verrouillé, seul un numéro s'affiche</label>
          <div class="forge-vault-picks">
            <fieldset class="forge-pick"><legend>Symbole</legend><select id="forge-vault-glyph" class="forge-pick-native" tabindex="-1" aria-hidden="true"></select><div class="forge-pick-grid" data-for="forge-vault-glyph" role="radiogroup" aria-label="Symbole"></div></fieldset>
            <fieldset class="forge-pick"><legend>Couleur</legend><select id="forge-vault-colour" class="forge-pick-native" tabindex="-1" aria-hidden="true"></select><div class="forge-pick-grid" data-for="forge-vault-colour" role="radiogroup" aria-label="Couleur"></div></fieldset>
          </div>
          <div class="field"><label for="forge-vault-new">Phrase du coffre</label><input id="forge-vault-new" type="password" minlength="12" maxlength="128" autocomplete="new-password" required/></div>
          <div class="field"><label for="forge-vault-confirm">Confirmation</label><input id="forge-vault-confirm" type="password" minlength="12" maxlength="128" autocomplete="new-password" required/></div>
          <p class="forge-note">Au moins 12 caractères, et pas seulement des chiffres. Une clé de récupération s'affichera une seule fois.</p>
          <div class="forge-actions">
            <button type="submit" id="forge-vault-create">Créer le coffre</button>
            <button type="button" class="secondary" id="forge-vault-create-cancel">Annuler</button>
          </div>
          <p id="forge-vault-create-error" class="forge-note" role="alert"></p>
        </form>
        <form id="forge-vault-restore" class="forge-vault-create" hidden>
          <h3 class="forge-vault-sub">Restaurer une sauvegarde</h3>
          <p class="forge-note">Le ZIP revient comme un nouveau coffre, verrouillé. Aucun coffre existant n'est remplacé.</p>
          <label class="secondary forge-file" for="forge-vault-restore-file">Choisir le ZIP<input id="forge-vault-restore-file" type="file" accept=".zip,application/zip"/></label>
          <p id="forge-vault-restore-picked" class="forge-note" role="status"></p>
          <div class="field"><label for="forge-vault-restore-label">Nom du coffre (facultatif)</label><input id="forge-vault-restore-label" type="text" maxlength="40" autocomplete="off" autocapitalize="sentences" spellcheck="false" placeholder="Coffre restauré"/></div>
          <p class="forge-note forge-vault-warn">Ne mets rien de sensible dans le nom : il reste lisible quand le coffre est verrouillé. Un coffre Discret revient Discret, avec son nom scellé.</p>
          <div class="field"><label for="forge-vault-restore-pass">Phrase du coffre au moment de la sauvegarde</label><input id="forge-vault-restore-pass" type="password" maxlength="128" autocomplete="off" required/></div>
          <div class="forge-actions">
            <button type="submit" id="forge-vault-restore-go">Restaurer</button>
            <button type="button" class="secondary" id="forge-vault-restore-cancel">Annuler</button>
          </div>
          <p id="forge-vault-restore-error" class="forge-note" role="alert"></p>
        </form>
        <form id="forge-vault-unlock" class="forge-vault-sheet" hidden>
          <p id="forge-vault-unlock-for" class="forge-vault-sub"></p>
          <p id="forge-vault-switch-note" class="forge-note" role="status" hidden></p>
          <div class="field">
            <label for="forge-vault-pass">Phrase du coffre</label>
            <input id="forge-vault-pass" type="password" maxlength="128" autocomplete="current-password" required/>
          </div>
          <div class="forge-actions">
            <button type="button" id="forge-vault-reveal" aria-pressed="false">Afficher</button>
            <button type="submit" id="forge-vault-open">Déverrouiller</button>
            <button type="button" class="secondary" id="forge-vault-unlock-cancel">Annuler</button>
          </div>
          <p id="forge-vault-error" class="forge-note" role="alert"></p>
          <button type="button" class="secondary" id="forge-vault-back">Retour à la galerie</button>
        </form>
        <div id="forge-vault-recovery" hidden>
          <p class="forge-note">Conservez cette clé hors de HQ. Elle ne sera plus affichée.</p>
          <p id="forge-vault-recovery-extra" class="forge-note" hidden></p>
          <textarea id="forge-vault-recovery-key" readonly rows="3"></textarea>
          <button type="button" id="forge-vault-recovery-ok">J'ai enregistré la clé</button>
        </div>
        <div id="forge-vault-open-tools" hidden>
          <details id="forge-vault-edit-fold" class="forge-fold">
            <summary>Apparence</summary>
            <div id="forge-vault-rename-row" class="forge-vault-rename">
              <p class="forge-note">Nom : <strong id="forge-vault-rename-current"></strong></p>
              <button type="button" id="forge-vault-rename-open" class="secondary" aria-expanded="false" aria-controls="forge-vault-rename">Renommer</button>
              <form id="forge-vault-rename" hidden>
                <div class="field"><label for="forge-vault-rename-label">Nouveau nom</label><input id="forge-vault-rename-label" type="text" maxlength="40" autocomplete="off" spellcheck="false" required/></div>
                <p id="forge-vault-rename-honest" class="forge-note"></p>
                <div class="forge-actions">
                  <button type="submit" class="secondary">Enregistrer le nom</button>
                  <button type="button" id="forge-vault-rename-cancel" class="secondary">Annuler</button>
                </div>
              </form>
              <p id="forge-vault-rename-status" class="forge-note" role="status" aria-live="polite"></p>
            </div>
            <form id="forge-vault-edit">
              <div class="forge-vault-pick">
                <fieldset class="forge-pick"><legend>Icône</legend><select id="forge-vault-edit-glyph" class="forge-pick-native" tabindex="-1" aria-hidden="true"></select><div class="forge-pick-grid" data-for="forge-vault-edit-glyph" role="radiogroup" aria-label="Icône"></div></fieldset>
                <fieldset class="forge-pick"><legend>Couleur</legend><select id="forge-vault-edit-colour" class="forge-pick-native" tabindex="-1" aria-hidden="true"></select><div class="forge-pick-grid" data-for="forge-vault-edit-colour" role="radiogroup" aria-label="Couleur"></div></fieldset>
              </div>
              <label class="forge-privacy-ack" for="forge-vault-edit-discret"><input type="checkbox" id="forge-vault-edit-discret"/> Discret : le nom n'apparaît que coffre ouvert</label>
              <p id="forge-vault-edit-honest" class="forge-note"></p>
              <button type="submit" class="secondary">Enregistrer les réglages</button>
              <p id="forge-vault-edit-status" class="forge-note" role="status" aria-live="polite"></p>
            </form>
            <div id="forge-vault-icon-row" class="forge-actions" hidden>
              <p class="forge-note">Une photo du coffre sert d'icône. Elle est chiffrée dans ce coffre et n'apparaît que coffre ouvert.</p>
              <button type="button" id="forge-vault-icon-clear" class="secondary">Retirer l'icône photo</button>
            </div>
          </details>
          <details id="forge-vault-security-fold" class="forge-fold">
            <summary>Sécurité</summary>
            <div class="forge-help-wrap forge-vault-away">
              <label class="forge-privacy-ack" for="forge-vault-away"><input type="checkbox" id="forge-vault-away"/> Verrouiller en quittant l'app</label>
            <button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-vault-away">Aide</button>
            <p id="forge-help-vault-away" class="forge-help-pop" role="tooltip">Si HQ reste en arrière-plan 30 secondes, le coffre se verrouille. Sans ce réglage, il se verrouille quand même après 5 minutes sans activité.</p>
          </div>
            <form id="forge-vault-rotate">
              <div class="forge-help-wrap"><p class="forge-vault-sub">Changer la phrase</p><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-vault-rotate">Aide</button><p id="forge-help-vault-rotate" class="forge-help-pop" role="tooltip">Changer la phrase ne retire pas la clé de récupération actuelle.</p></div>
              <div class="field"><label for="forge-vault-current">Phrase actuelle</label><input id="forge-vault-current" type="password" autocomplete="current-password"/></div>
              <div class="field"><label for="forge-vault-next">Nouvelle phrase</label><input id="forge-vault-next" type="password" minlength="12" maxlength="128" autocomplete="new-password" required/></div>
              <div class="field"><label for="forge-vault-next-confirm">Confirmation</label><input id="forge-vault-next-confirm" type="password" minlength="12" maxlength="128" autocomplete="new-password" required/></div>
              <button type="submit">Enregistrer la phrase</button>
            </form>
            <form id="forge-vault-rekey">
              <div class="forge-help-wrap"><p class="forge-vault-sub">Clé de récupération</p><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-vault-rekey">Aide</button><p id="forge-help-vault-rekey" class="forge-help-pop" role="tooltip">Remplacer la clé de récupération invalide l'ancienne. La phrase du coffre ne change pas.</p></div>
              <div class="field"><label for="forge-vault-rekey-pass">Phrase actuelle</label><input id="forge-vault-rekey-pass" type="password" autocomplete="current-password" required/></div>
              <button type="submit" class="secondary">Remplacer la clé de récupération</button>
            </form>
          </details>
          <details id="forge-vault-backup-fold" class="forge-fold">
            <summary>Sauvegarde</summary>
            <div class="forge-help-wrap"><p class="forge-note">Un ZIP chiffré de ce coffre seul. Images, nom Discret et icône restent scellés.</p><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-vault-backup">Aide</button>
            <p id="forge-help-vault-backup" class="forge-help-pop" role="tooltip">Garde le ZIP hors de HQ. Pour le reprendre : Mes coffres, « Restaurer un ZIP ». Il revient comme un nouveau coffre, avec la phrase qu'il avait le jour de la sauvegarde.</p></div>
            <button type="button" id="forge-vault-backup-zip" class="secondary">Télécharger la sauvegarde</button>
            <p id="forge-vault-backup-status" class="forge-note" role="status" aria-live="polite"></p>
          </details>
          <details id="forge-vault-check-fold" class="forge-fold">
            <summary>Vérification</summary>
            <p class="forge-note">Déchiffre chaque image de ce coffre pour vérifier qu'elle est intacte. Rien n'est modifié.</p>
            <button type="button" id="forge-vault-check-run" class="secondary">Vérifier toutes les images</button>
            <ul id="forge-vault-check-result" class="forge-health-detail" aria-live="polite"></ul>
            <p id="forge-vault-check-status" class="forge-note" role="status" aria-live="polite"></p>
          </details>
          <details id="forge-vault-destroy-fold" class="forge-fold">
            <summary>Supprimer ce coffre</summary>
            <form id="forge-vault-destroy">
              <p class="forge-note forge-vault-warn">Irréversible : ce coffre, ses images et ses clés disparaissent. Télécharge d'abord une sauvegarde si tu veux pouvoir revenir en arrière.</p>
              <p class="forge-note">Les fichiers sont écrasés avant d'être retirés. Sur un SSD, cela ne garantit pas leur effacement physique.</p>
              <div class="field"><label for="forge-vault-destroy-pass">Phrase du coffre</label><input id="forge-vault-destroy-pass" type="password" maxlength="128" autocomplete="current-password" required/></div>
              <div class="field"><label for="forge-vault-destroy-word">Tape SUPPRIMER</label><input id="forge-vault-destroy-word" type="text" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" required/></div>
              <button type="submit" id="forge-vault-destroy-go" class="forge-danger" disabled>Supprimer définitivement</button>
              <p id="forge-vault-destroy-error" class="forge-note" role="alert"></p>
            </form>
          </details>
          <section aria-labelledby="forge-vault-gallery-title">
            <h2 id="forge-vault-gallery-title">Coffre</h2>
            <div class="forge-triage-bar"><button type="button" id="forge-vault-triage-open" class="secondary">Trier</button><button type="button" id="forge-vault-trash-open" class="secondary">Corbeille du coffre</button><label class="secondary forge-file" for="forge-vault-import">Importer une image<input id="forge-vault-import" type="file" accept="image/png,image/jpeg,image/webp"/></label></div>
            <form id="forge-vault-search" class="forge-vault-search" role="search">
              <input id="forge-vault-q" type="search" autocomplete="off" spellcheck="false" maxlength="120" aria-label="Rechercher dans le coffre" placeholder="Prompt, étiquette ou collection"/>
              <button type="submit" class="secondary">Chercher</button>
            </form>
            <div id="forge-vault-filters" class="forge-vault-filters" role="group" aria-label="Étiquettes et collections du coffre"></div>
            <p id="forge-vault-search-note" class="forge-note" role="status"></p>
            <div id="forge-vault-gallery" class="forge-grid"></div>
            <p id="forge-vault-empty" class="forge-note">Le coffre ne contient pas encore d'image.</p>
          </section>
        </div>
      </section>
      <form id="forge-form" class="forge-compose forge-m">
        <div id="forge-dest-chip-row" class="forge-dest-chip-row" hidden>
          <button type="button" id="forge-dest-chip" class="forge-dest-chip" aria-expanded="false" aria-controls="forge-private-target-row"><span class="forge-dest-chip-lock" aria-hidden="true">&#128274;</span> <span id="forge-dest-chip-text">Coffre : à choisir</span></button>
        </div>
        <div id="forge-private-target-row" class="field forge-private-target forge-dest-sheet" hidden>
          <label for="forge-private-target">Coffre de destination</label>
          <select id="forge-private-target"></select>
          <p id="forge-private-target-note" class="forge-note" role="status" aria-live="polite"></p>
        </div>
        <div class="field">
          <label for="forge-prompt">Prompt</label>
          <textarea id="forge-prompt" name="prompt" required maxlength="2000" rows="4" placeholder="Décris l'image"></textarea>
          <p id="forge-draft-note" class="forge-note" role="status" hidden></p>
        </div>
        <div class="forge-prompt-tools" role="group" aria-label="Prompts précédents">
          <button type="button" id="forge-last-prompt" class="forge-tool">Dernier prompt</button>
          <button type="button" id="forge-history-open" class="forge-tool" aria-haspopup="dialog" aria-controls="forge-history">Historique</button>
          <span id="forge-prompt-count" class="forge-count" aria-hidden="true">0 / 2000</span>
        </div>
        <p id="forge-history-note" class="forge-note" role="status" aria-live="polite"></p>
        <details id="forge-bricks" class="forge-bricks">
          <summary>Briques</summary>
          <div class="forge-label-row"><span class="forge-note">Touchez une brique pour l'ajouter au prompt. Rien n'est lancé.</span><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-bricks">Aide</button><p id="forge-help-bricks" class="forge-help-pop" role="tooltip">Une brique est un morceau de prompt réutilisable : un texte, et si besoin un LoRA avec son poids et ses mots-clés. Les briques sont gardées sur cet HQ, hors du coffre ; en mode privé, on peut les ajouter mais pas en enregistrer.</p></span></div>
          <div id="forge-bricks-list" class="forge-bricks-list" role="group" aria-label="Briques enregistrées"></div>
          <p id="forge-bricks-empty" class="forge-note">Aucune brique pour l'instant.</p>
          <button type="button" id="forge-brick-new" class="secondary">Nouvelle brique</button>
          <div id="forge-brick-editor" class="forge-brick-editor" hidden>
            <div class="field"><label for="forge-brick-name">Nom</label><input id="forge-brick-name" maxlength="60" autocomplete="off"/></div>
            <div class="field"><label for="forge-brick-text">Texte</label><textarea id="forge-brick-text" rows="2" maxlength="400" autocomplete="off" spellcheck="false"></textarea></div>
            <div class="field"><label for="forge-brick-lora">LoRA (facultatif)</label><select id="forge-brick-lora"><option value="">Aucun</option></select></div>
            <div class="field" id="forge-brick-weight-field" hidden><label for="forge-brick-weight">Poids du LoRA</label><input id="forge-brick-weight" type="number" min="-2" max="2" step="0.05" value="0.8" inputmode="decimal"/></div>
            <div class="field"><label for="forge-brick-words">Mots-clés (séparés par des virgules)</label><input id="forge-brick-words" maxlength="500" autocomplete="off" spellcheck="false"/></div>
            <div id="forge-brick-suggest" class="forge-brick-suggest" role="group" aria-label="Mots-clés suggérés" hidden></div>
            <p id="forge-brick-note" class="forge-note" role="status"></p>
            <div class="forge-actions">
              <button type="button" id="forge-brick-save">Enregistrer la brique</button>
              <button type="button" id="forge-brick-delete" class="secondary" hidden>Supprimer</button>
              <button type="button" id="forge-brick-cancel" class="secondary">Annuler</button>
            </div>
          </div>
        </details>
        <details id="forge-style" class="forge-style">
          <summary>Style maison</summary>
          <div class="forge-label-row"><span class="forge-note">Indicatif : les réglages les plus fréquents parmi vos images gardées.</span><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-style">Aide</button><p id="forge-help-style" class="forge-help-pop" role="tooltip">Calculé sur les images gardées ou favorites de la galerie (une favorite compte double), jamais sur le coffre. Appliquer remplit seulement les réglages ; rien n'est lancé et le modèle n'est jamais changé.</p></span></div>
          <p id="forge-style-note" class="forge-note" role="status"></p>
          <dl id="forge-style-list" class="forge-style-list"></dl>
          <div class="forge-actions">
            <button type="button" id="forge-style-apply" hidden>Appliquer le style maison</button>
            <button type="button" id="forge-style-negative" class="secondary" hidden>Reprendre son prompt négatif</button>
          </div>
          <p id="forge-style-done" class="forge-note" role="status"></p>
        </details>
        <div id="forge-restore-confirm" class="forge-privacy forge-confirm" role="group" aria-labelledby="forge-restore-text" hidden>
          <p id="forge-restore-text">Le prompt actuel n'a pas été utilisé. Le remplacer ?</p>
          <div class="forge-actions">
            <button type="button" id="forge-restore-replace">Remplacer</button>
            <button type="button" id="forge-restore-keep" class="secondary">Garder mon texte</button>
          </div>
        </div>
        <details class="forge-fold" id="forge-negative-fold">
          <summary>Prompt négatif</summary>
          <div class="forge-fold-body">
            <div class="field">
              <div class="forge-label-row">
                <label for="forge-negative">À éviter</label>
                <span class="forge-help-wrap">
                  <button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-negative">Aide</button>
                  <p id="forge-help-negative" class="forge-help-pop" role="tooltip">Décrivez ce qu'il faut éviter, par exemple le flou ou le texte illisible. Ce champ ne remplace pas le prompt.</p>
                </span>
              </div>
              <textarea id="forge-negative" name="negative_prompt" maxlength="1000" rows="2" placeholder="Ce qu'il faut éviter"></textarea>
            </div>
          </div>
        </details>
      </form>
        <aside class="forge-side" aria-label="Réglages de génération">
          <section class="forge-quick" aria-labelledby="forge-quick-title">
            <h2 id="forge-quick-title">Réglages</h2>
            <div class="field">
              <div class="forge-label-row"><label for="forge-checkpoint">Modèle</label><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-checkpoint">Aide</button><p id="forge-help-checkpoint" class="forge-help-pop" role="tooltip">Le modèle dessine l'image. Un modèle illustré et un modèle photo ne donnent pas le même résultat.</p></span></div>
              <select id="forge-checkpoint"></select>
            </div>
            <p id="forge-choice-note" class="forge-note" role="status"></p>
            <div class="forge-ratios" role="group" aria-label="Format">
              <button type="button" class="forge-ratio" data-forge-ratio="1:1" data-width="1024" data-height="1024" aria-pressed="false">1:1</button>
              <button type="button" class="forge-ratio" data-forge-ratio="3:2" data-width="1152" data-height="768" aria-pressed="false">3:2</button>
              <button type="button" class="forge-ratio" data-forge-ratio="2:3" data-width="768" data-height="1152" aria-pressed="false">2:3</button>
              <button type="button" class="forge-ratio" data-forge-ratio="4:3" data-width="1024" data-height="768" aria-pressed="false">4:3</button>
              <button type="button" class="forge-ratio" data-forge-ratio="3:4" data-width="768" data-height="1024" aria-pressed="false">3:4</button>
              <button type="button" class="forge-ratio" data-forge-ratio="16:9" data-width="1024" data-height="576" aria-pressed="false">16:9</button>
              <button type="button" class="forge-ratio" data-forge-ratio="9:16" data-width="576" data-height="1024" aria-pressed="false">9:16</button>
            </div>
            <div class="field">
              <div class="forge-label-row"><label id="forge-steps-label" for="forge-steps">Pas</label><span id="forge-steps-live" class="forge-live">20</span><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-steps">Aide</button><p id="forge-help-steps" class="forge-help-pop" role="tooltip">Plus de pas affine l'image et prend plus de temps. Vingt est un équilibre courant.</p></span></div>
              <div class="forge-slider">
                <input id="forge-steps-range" type="range" min="1" max="40" step="1" value="20" aria-labelledby="forge-steps-label"/>
                <input id="forge-steps" type="number" min="1" max="40" step="1" value="20" inputmode="numeric"/>
              </div>
            </div>
          </section>
          <section class="forge-advanced" aria-labelledby="forge-advanced-title">
            <h2 id="forge-advanced-title">Réglages avancés</h2>
            <details class="forge-fold" id="forge-sampling">
              <summary>Échantillonneur et planificateur</summary>
              <div class="forge-fold-body forge-grid-fields">
                <div class="field">
                  <div class="forge-label-row"><label for="forge-sampler">Échantillonneur</label><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-sampler">Aide</button><p id="forge-help-sampler" class="forge-help-pop" role="tooltip">C'est la méthode qui construit l'image pas à pas. Euler a est un bon départ. Les méthodes DPM sont souvent plus nettes.</p></span></div>
                  <select id="forge-sampler"></select>
                </div>
                <div class="field">
                  <div class="forge-label-row"><label for="forge-scheduler">Planificateur</label><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-scheduler">Aide</button><p id="forge-help-scheduler" class="forge-help-pop" role="tooltip">Il répartit les pas du début à la fin. Automatic convient presque toujours.</p></span></div>
                  <select id="forge-scheduler"></select>
                </div>
              </div>
            </details>
            <details class="forge-fold" id="forge-cfg-fold">
              <summary>CFG</summary>
              <div class="forge-fold-body">
                <div class="field">
                  <div class="forge-label-row"><label id="forge-cfg-label" for="forge-cfg">Suivi du prompt</label><span id="forge-cfg-live" class="forge-live">7</span><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-cfg">Aide</button><p id="forge-help-cfg" class="forge-help-pop" role="tooltip">Indique à quel point Forge suit le prompt. Autour de 7, le prompt guide sans figer l'image.</p></span></div>
                  <div class="forge-slider">
                    <input id="forge-cfg-range" type="range" min="1" max="15" step="0.5" value="7" aria-labelledby="forge-cfg-label"/>
                    <input id="forge-cfg" type="number" min="1" max="15" step="0.5" value="7" inputmode="decimal"/>
                  </div>
                </div>
              </div>
            </details>
            <details class="forge-fold" id="forge-seed-fold">
              <summary>Graine</summary>
              <div class="forge-fold-body">
                <div class="forge-seed-modes" role="radiogroup" aria-label="Graine">
                  <label><input type="radio" name="forge-seed-mode" value="random" checked/> Aléatoire</label>
                  <label><input type="radio" name="forge-seed-mode" value="fixed"/> Fixe</label>
                </div>
                <div class="field">
                  <div class="forge-label-row"><label for="forge-seed">Valeur</label><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-seed">Aide</button><p id="forge-help-seed" class="forge-help-pop" role="tooltip">Aléatoire change l'image à chaque fois. Fixe répète une base proche si les autres réglages ne changent pas. Réutiliser reprend la dernière graine de la galerie normale.</p></span></div>
                  <input id="forge-seed" type="number" min="0" max="4294967295" step="1" value="0" inputmode="numeric" disabled/>
                </div>
                <p id="forge-variation-chip" class="forge-note forge-variation-chip" hidden><span id="forge-variation-text"></span> <button type="button" id="forge-variation-clear" class="secondary">Retirer</button></p>
                <div class="forge-actions">
                  <button type="button" id="forge-seed-reuse">Réutiliser</button>
                </div>
                <p id="forge-seed-note" class="forge-note" role="status"></p>
              </div>
            </details>
            <details class="forge-fold" id="forge-advanced">
              <summary>Dimensions exactes</summary>
              <div class="forge-fold-body forge-grid-fields">
                <div class="field">
                  <div class="forge-label-row"><label for="forge-width">Largeur</label><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-width">Aide</button><p id="forge-help-width" class="forge-help-pop" role="tooltip">Largeur en pixels, multiple de 64, entre 256 et 1536. Une image plus grande demande plus de mémoire.</p></span></div>
                  <input id="forge-width" type="number" min="256" max="1536" step="64" value="512" inputmode="numeric"/>
                </div>
                <div class="field">
                  <div class="forge-label-row"><label for="forge-height">Hauteur</label><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-height">Aide</button><p id="forge-help-height" class="forge-help-pop" role="tooltip">Hauteur en pixels, multiple de 64, entre 256 et 1536.</p></span></div>
                  <input id="forge-height" type="number" min="256" max="1536" step="64" value="512" inputmode="numeric"/>
                </div>
              </div>
            </details>
            <details class="forge-fold" id="forge-batch-fold">
              <summary>Lot</summary>
              <div class="forge-fold-body forge-grid-fields">
                <div class="field">
                  <div class="forge-label-row"><label for="forge-iter">Images à la suite</label><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-iter">Aide</button><p id="forge-help-iter" class="forge-help-pop" role="tooltip">Une ou deux images, l'une après l'autre. Deux prend environ deux fois plus de temps.</p></span></div>
                  <select id="forge-iter"><option value="1" selected>1</option><option value="2">2</option></select>
                </div>
                <div class="field">
                  <div class="forge-label-row"><label for="forge-batch">Taille de lot</label><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-batch">Aide</button><p id="forge-help-batch" class="forge-help-pop" role="tooltip">HQ garde une seule image par passage. La taille de lot reste à 1.</p></span></div>
                  <input id="forge-batch" type="text" value="1" readonly tabindex="-1"/>
                </div>
              </div>
            </details>
            <details class="forge-fold" id="forge-hr-fold">
              <summary>Hires. fix</summary>
              <div class="forge-fold-body">
                <p id="forge-hr-private" class="forge-note">Réservé à la galerie normale. La génération privée n'accepte pas ce second passage.</p>
                <label class="forge-privacy-ack" for="forge-hr"><input id="forge-hr" type="checkbox"/> Activer le second passage</label>
                <div class="forge-grid-fields">
                  <div class="field">
                    <div class="forge-label-row"><label for="forge-hr-scale">Échelle</label><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-hr-scale">Aide</button><p id="forge-help-hr-scale" class="forge-help-pop" role="tooltip">1,5 ou 2. Le résultat de chaque côté doit rester d'au plus 2048 pixels.</p></span></div>
                    <select id="forge-hr-scale"><option value="1.5">1,5</option><option value="2" selected>2</option></select>
                  </div>
                  <div class="field">
                    <div class="forge-label-row"><label for="forge-hr-upscaler">Agrandisseur</label><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-hr-upscaler">Aide</button><p id="forge-help-hr-upscaler" class="forge-help-pop" role="tooltip">Méthode du second passage, parmi celles proposées par Forge.</p></span></div>
                    <select id="forge-hr-upscaler"></select>
                  </div>
                  <div class="field">
                    <div class="forge-label-row"><label for="forge-hr-steps">Pas du second passage</label><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-hr-steps">Aide</button><p id="forge-help-hr-steps" class="forge-help-pop" role="tooltip">0 reprend le nombre de pas du premier passage. Sinon, de 1 à 20.</p></span></div>
                    <input id="forge-hr-steps" type="number" min="0" max="20" step="1" value="0" inputmode="numeric"/>
                  </div>
                  <div class="field">
                    <div class="forge-label-row"><label id="forge-hr-denoise-label" for="forge-hr-denoise">Force</label><span id="forge-hr-denoise-live" class="forge-live">0,5</span><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-hr-denoise">Aide</button><p id="forge-help-hr-denoise" class="forge-help-pop" role="tooltip">De 0,2 à 0,7. Plus la force est haute, plus le second passage s'éloigne de la première image.</p></span></div>
                    <div class="forge-slider">
                      <input id="forge-hr-denoise-range" type="range" min="0.2" max="0.7" step="0.05" value="0.5" aria-labelledby="forge-hr-denoise-label"/>
                      <input id="forge-hr-denoise" type="number" min="0.2" max="0.7" step="0.05" value="0.5" inputmode="decimal"/>
                    </div>
                  </div>
                </div>
                <p id="forge-hr-note" class="forge-note" role="status"></p>
              </div>
            </details>
          </section>
          <details id="forge-presets" class="forge-presets" open>
            <summary><h2 id="forge-presets-title">Préréglages</h2><span id="forge-preset-current" class="forge-summary-hint"></span></summary>
            <div class="forge-presets-body">
            <div class="field">
              <label for="forge-preset-list">Préréglage enregistré</label>
              <select id="forge-preset-list"><option value="">Aucun</option></select>
            </div>
            <p id="forge-preset-state" class="forge-note" role="status"></p>
            <div class="forge-actions forge-preset-main">
              <button type="button" id="forge-preset-load">Charger</button>
              <button type="button" id="forge-preset-save">Enregistrer</button>
            </div>
            <div class="forge-actions forge-preset-more" role="group" aria-label="Autres actions du préréglage">
              <button type="button" id="forge-preset-update">Mettre à jour</button>
              <button type="button" id="forge-preset-rename">Renommer</button>
              <button type="button" id="forge-preset-duplicate">Dupliquer</button>
              <button type="button" id="forge-preset-delete" class="secondary">Supprimer</button>
              <button type="button" id="forge-preset-export" class="secondary">Exporter</button>
              <label class="secondary forge-file" for="forge-preset-import">Importer<input id="forge-preset-import" type="file" accept="application/json,.json"/></label>
            </div>
            <div id="forge-preset-export-gate" class="forge-privacy" hidden>
              <p id="forge-preset-export-plain">Le fichier exporté contient les prompts en clair. Le coffre privé ne les chiffre pas.</p>
              <p id="forge-preset-export-vault" hidden>Génération privée : cet export n'est pas une sauvegarde du coffre. Les prompts du fichier restent lisibles.</p>
              <div class="forge-actions">
                <button type="button" id="forge-preset-export-confirm">Télécharger le fichier en clair</button>
                <button type="button" id="forge-preset-export-cancel" class="secondary">Annuler</button>
              </div>
            </div>
            <div id="forge-preset-update-gate" class="forge-privacy" hidden>
              <p id="forge-preset-update-plain">La mise à jour copie le prompt en clair dans les préréglages, hors du coffre privé.</p>
              <p id="forge-preset-update-vault" hidden>Génération privée : le coffre ne protège pas cette copie. Le prompt actuel quitte le coffre et reste lisible.</p>
              <label class="forge-privacy-ack" for="forge-preset-update-ack"><input id="forge-preset-update-ack" type="checkbox"/> Je copie ce prompt en clair, hors du coffre</label>
              <div class="forge-actions">
                <button type="button" id="forge-preset-update-confirm" disabled>Confirmer la mise à jour</button>
                <button type="button" id="forge-preset-update-cancel" class="secondary">Annuler</button>
              </div>
            </div>
            <form id="forge-preset-editor" hidden>
              <div class="field"><label for="forge-preset-name">Nom</label><input id="forge-preset-name" maxlength="60" autocomplete="off"/></div>
              <div class="forge-dest" role="radiogroup" aria-label="Contenu du préréglage">
                <label><input type="radio" name="forge-preset-kind" value="technical" checked/> Technique, sans le prompt</label>
                <label><input type="radio" name="forge-preset-kind" value="creative"/> Créatif, avec le prompt</label>
              </div>
              <div id="forge-preset-privacy" class="forge-privacy" hidden>
                <p id="forge-preset-privacy-plain">Le prompt est enregistré en clair dans les préréglages. Ce n'est pas un stockage chiffré.</p>
                <p id="forge-preset-privacy-vault" hidden>Génération privée : le coffre privé ne chiffre pas les préréglages. Confirmer copie ce prompt hors du coffre, où il reste lisible.</p>
                <label class="forge-privacy-ack" for="forge-preset-privacy-ack"><input id="forge-preset-privacy-ack" type="checkbox"/> J'enregistre ce prompt en clair, hors du coffre</label>
              </div>
              <div class="forge-actions">
                <button type="submit" id="forge-preset-confirm">Confirmer</button>
                <button type="button" id="forge-preset-cancel" class="secondary">Annuler</button>
              </div>
            </form>
            </div>
          </details>
        </aside>
      <section id="forge-devices" class="forge-devices forge-m" aria-labelledby="forge-devices-title">
        <div class="forge-devices-head">
          <h2 id="forge-devices-title">Appareils de génération</h2>
          <span id="forge-devices-count" class="forge-summary-hint" aria-live="polite"></span>
        </div>
        <p id="forge-devices-note" class="forge-note" role="status"></p>
        <ul id="forge-device-list" class="forge-device-list" aria-label="Appareils"></ul>
        <div class="forge-devices-tools">
          <button type="button" id="forge-devices-all" class="forge-tool">Tout sélectionner (compatibles)</button>
          <button type="button" id="forge-device-add" class="forge-tool" aria-haspopup="dialog" aria-controls="forge-device-dialog">Ajouter un appareil</button>
          <div id="forge-fleet-count-field" class="forge-fleet-count" hidden>
            <label for="forge-fleet-count">Images</label>
            <input id="forge-fleet-count" type="number" min="1" max="16" step="1" value="4" inputmode="numeric"/>
          </div>
        </div>
        <p id="forge-fleet-private" class="forge-note forge-fleet-private" hidden>La génération privée reste sur cet HQ. Les autres appareils ne reçoivent jamais un prompt privé.</p>
      </section>
      <div id="forge-plan" class="forge-plan forge-m" aria-live="polite" hidden></div>
      <details class="forge-fold forge-block forge-m forge-sweep" id="forge-sweep">
        <summary>Balayage d'un paramètre</summary>
        <p class="forge-note">Même prompt et même graine ; un seul réglage change d'une image à l'autre. 8 images au plus, réparties sur les appareils choisis.</p>
        <div class="field"><label for="forge-sweep-axis">Réglage</label>
          <select id="forge-sweep-axis"><option value="cfg_scale">CFG</option><option value="steps">Pas</option><option value="sampler_name">Échantillonneur</option><option value="lora_weight">Poids d'un LoRA</option></select></div>
        <div class="field" id="forge-sweep-lora-field" hidden><label for="forge-sweep-lora">LoRA du prompt</label><select id="forge-sweep-lora"></select></div>
        <div class="field"><label for="forge-sweep-values">Valeurs (séparées par ;)</label><input id="forge-sweep-values" type="text" autocomplete="off" spellcheck="false" value="4 ; 6 ; 8 ; 10"/></div>
        <p id="forge-sweep-note" class="forge-note" role="status"></p>
        <button type="button" id="forge-sweep-run">Lancer le balayage</button>
      </details>
      <details class="forge-fold forge-block forge-m forge-night" id="forge-night">
        <summary>Atelier de nuit</summary>
        <p class="forge-note">Met ces réglages en file sur ce PC : « ce soir » (22 h – 7 h) ou « quand Forge est libre ». Rien n'est interrompu : une entrée attend tant que Forge ou le GPU travaille. 6 h au plus par nuit, 24 entrées au plus.</p>
        <div class="forge-actions">
          <button type="button" id="forge-night-tonight">Lancer ce soir</button>
          <button type="button" id="forge-night-idle" class="secondary">Quand Forge est libre</button>
        </div>
        <button type="button" id="forge-night-finish" class="secondary">Finir les gardées cette nuit</button>
        <p id="forge-night-note" class="forge-note" role="status"></p>
        <ul id="forge-night-list" class="forge-night-list" aria-label="File de nuit"></ul>
        <button type="button" id="forge-night-cancel-all" class="secondary" hidden>Annuler les entrées en attente</button>
      </details>
      <div id="forge-actionbar" class="forge-actionbar forge-m">
        <p id="forge-generate-reason" class="forge-note" role="status"></p>
        <p id="forge-usual-duration" class="forge-note forge-usual" hidden></p>
        <div class="forge-actions">
          <button type="submit" id="forge-generate" form="forge-form">Générer</button>
          <button type="button" id="forge-generate-private" hidden>Générer en privé</button>
          <button type="button" id="forge-cancel" disabled>Annuler</button>
        </div>
        <button type="button" id="forge-see-result" class="forge-see-result" aria-controls="forge-normal-results" hidden>Voir le résultat</button>
        <div id="forge-progress" class="forge-progress" hidden>
          <progress id="forge-progress-bar" max="1" value="0" aria-labelledby="forge-progress-label"></progress>
          <span id="forge-progress-label" aria-live="polite"></span>
        </div>
        <div id="forge-wait" class="forge-wait" hidden>
          <button type="button" id="forge-start-now">Lancer quand même</button>
          <p class="forge-note">Votre image passera après le travail en cours de Forge. Rien n'est interrompu.</p>
        </div>
      </div>
        <p id="forge-cancel-note" class="forge-note forge-m">L'annulation n'est possible que tant que le travail est encore dans HQ. Une génération déjà envoyée à Forge n'est pas interrompue : l'arrêt global pourrait couper un autre travail.</p>
      <div id="forge-prefs" class="forge-prefs forge-m">
        <div id="forge-wake-wrap" class="forge-help-wrap" hidden>
          <label class="forge-privacy-ack" for="forge-wake"><input type="checkbox" id="forge-wake"/> Garder l'écran allumé</label>
          <button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-wake">Aide</button>
          <p id="forge-help-wake" class="forge-help-pop" role="tooltip">Pendant une génération ou un lot, l'écran de cet appareil ne se met pas en veille. Réglage gardé sur cet appareil ; rien n'est envoyé à Forge.</p>
        </div>
      </div>
      <section id="forge-fleet-batch" class="forge-block forge-m forge-fleet-batch" aria-labelledby="forge-fleet-batch-title" hidden>
        <div class="forge-devices-head">
          <h2 id="forge-fleet-batch-title">Lot multi-appareils</h2>
          <span id="forge-fleet-batch-state" class="forge-summary-hint" aria-live="polite"></span>
        </div>
        <p id="forge-fleet-batch-totals" class="forge-fleet-batch-totals" aria-live="polite"></p>
        <ul id="forge-fleet-batch-workers" class="forge-fleet-batch-workers"></ul>
        <p id="forge-fleet-batch-note" class="forge-note" role="status"></p>
        <details class="forge-fold" id="forge-fleet-batch-journal">
          <summary>Journal</summary>
          <ol id="forge-fleet-journal-list" class="forge-journal"></ol>
        </details>
        <div class="forge-actions">
          <button type="button" id="forge-fleet-batch-cancel" class="secondary">Annuler le lot</button>
          <button type="button" id="forge-fleet-batch-retry" hidden>Relancer les images manquantes</button>
          <button type="button" id="forge-fleet-batch-close" class="secondary" hidden>Masquer</button>
        </div>
      </section>
      <section class="forge-block forge-m" id="forge-normal-results" aria-labelledby="forge-results-title">
        <h2 id="forge-results-title">Résultat</h2>
        <div id="forge-job-choice" class="forge-job-choice" hidden></div>
        <details class="forge-fold" id="forge-job-journal" hidden>
          <summary>Journal</summary>
          <ol id="forge-job-journal-list" class="forge-journal"></ol>
        </details>
        <p id="forge-results-empty" class="forge-note">Le résultat de la génération apparaîtra ici.</p>
        <section id="forge-night-summary" class="forge-night-summary" aria-label="Résumé de la nuit" hidden>
          <p id="forge-night-summary-text"></p>
          <div id="forge-night-summary-images" class="forge-night-thumbs"></div>
          <button type="button" id="forge-night-summary-ok" class="secondary">Vu</button>
        </section>
        <div id="forge-sweep-strip" class="forge-sweep-strip" role="list" aria-label="Balayage, une image par valeur" hidden></div>
        <div id="forge-results" class="forge-grid"></div>
      </section>
      <section class="forge-block forge-m" id="forge-normal-gallery" aria-labelledby="forge-gallery-title">
        <h2 id="forge-gallery-title">Galerie</h2>
        <div class="forge-triage-bar"><button type="button" id="forge-triage-open" class="secondary">Trier</button><button type="button" id="forge-trash-open" class="secondary">Corbeille</button></div>
        <p id="forge-gallery-empty" class="forge-note">La galerie HQ est vide. Les images de Forge ne sont pas copiées ici toutes seules.</p>
        <div id="forge-gallery" class="forge-grid"></div>
        <button type="button" id="forge-more" class="secondary" hidden>Plus d'images</button>
      </section>
      <details class="forge-fold forge-block forge-m forge-lab" id="forge-lab">
        <summary>Laboratoire</summary>
        <div class="forge-lab-help">
          <p id="forge-lab-intro" class="forge-note">Trois vues séparées, sans note globale. Coffre exclu.</p>
          <p id="forge-help-lab" class="forge-note forge-lab-rules">Seules les images de la galerie comptent ; le coffre privé n’est jamais mesuré. Un réglage n’est comparé qu’à partir de 20 images, et seulement avec le même modèle, la même taille et la même haute résolution. Les chiffres disent ce qui s’est passé, pas pourquoi.</p>
        </div>
        <div class="forge-lab-tabs" role="tablist" aria-label="Vues du laboratoire">
          <button type="button" role="tab" id="forge-lab-tab-speed" data-view="speed" aria-selected="true" aria-controls="forge-lab-panel">Vitesse</button>
          <button type="button" role="tab" id="forge-lab-tab-reliability" data-view="reliability" aria-selected="false" aria-controls="forge-lab-panel">Fiabilité</button>
          <button type="button" role="tab" id="forge-lab-tab-keep" data-view="keep" aria-selected="false" aria-controls="forge-lab-panel">Taux de garde</button>
        </div>
        <div id="forge-lab-panel" role="tabpanel" aria-live="polite"></div>
        <div id="forge-lab-mixed" class="forge-lab-mixed" hidden></div>
        <p id="forge-lab-applied" class="forge-note" role="status" tabindex="-1"></p>
        <button type="button" id="forge-lab-refresh" class="secondary">Actualiser</button>
      </details>
    </div>
    <dialog id="forge-vault-viewer" aria-labelledby="forge-vault-viewer-title">
      <form method="dialog">
        <header class="forge-viewer-bar">
          <h2 id="forge-vault-viewer-title">Image privée</h2>
          <button type="button" id="forge-vault-viewer-close" class="secondary">Fermer</button>
        </header>
        <img id="forge-vault-viewer-img" alt=""/>
        <p id="forge-vault-viewer-meta"></p>
        <div class="forge-vault-labels" id="forge-vault-labels">
          <div class="field"><label for="forge-vault-tags">Étiquettes (séparées par une virgule)</label><input id="forge-vault-tags" type="text" autocomplete="off" spellcheck="false" maxlength="420"/></div>
          <div class="field"><label for="forge-vault-collection">Collection</label><input id="forge-vault-collection" type="text" autocomplete="off" spellcheck="false" maxlength="48"/></div>
          <button type="button" id="forge-vault-labels-save" class="secondary">Enregistrer</button>
          <p id="forge-vault-labels-note" class="forge-note" role="status">Chiffrées dans le coffre, comme l'image.</p>
        </div>
        <div class="forge-triage-row" id="forge-vault-viewer-triage" role="group" aria-label="Tri de l’image"></div>
        <button type="button" id="forge-vault-viewer-inpaint" class="secondary forge-inpaint-open">Retoucher une zone</button>
        <button type="button" id="forge-vault-icon-use" class="secondary">Utiliser comme icône</button>
        <p id="forge-vault-icon-note" class="forge-note" role="status" aria-live="polite"></p>
        <div class="forge-explore" id="forge-vault-explore-box">
          <div class="forge-label-row"><label for="forge-vault-explore-range">Explorer autour</label></div>
          <div class="forge-explore-row"><span aria-hidden="true">proche</span><input type="range" id="forge-vault-explore-range" min="0.05" max="0.6" step="0.05" value="0.2" aria-valuetext="proche"/><span aria-hidden="true">loin</span></div>
          <button type="button" id="forge-vault-explore">Générer 6 variations</button>
          <p class="forge-note" id="forge-vault-explore-note" role="status">Même graine et mêmes réglages : proche garde l'image, loin s'en écarte. Touchez une variation puis Réutiliser pour continuer depuis elle. Reste dans le coffre, sur cet HQ : jamais envoyé aux autres appareils.</p>
        </div>
        <div class="forge-actions">
          <button type="button" id="forge-vault-download">Télécharger l'original</button>
          <button type="button" id="forge-vault-share" class="secondary" hidden>Enregistrer dans Photos</button>
          <label class="forge-privacy-ack" for="forge-vault-params"><input type="checkbox" id="forge-vault-params"/> Inclure les paramètres</label>
          <button type="button" id="forge-vault-reuse">Réutiliser les réglages</button>
          <button type="button" id="forge-vault-delete" class="secondary">Supprimer du coffre</button>
        </div>
      </form>
    </dialog>
    <dialog id="forge-triage" class="forge-triage" aria-labelledby="forge-triage-title">
      <div class="forge-triage-inner">
        <header class="forge-viewer-bar">
          <h2 id="forge-triage-title">Tri rapide</h2>
          <span id="forge-triage-count" class="forge-summary-hint" aria-live="polite"></span>
          <button type="button" id="forge-triage-close" class="secondary">Fermer</button>
        </header>
        <div id="forge-triage-stage" class="forge-triage-stage"><img id="forge-triage-img" alt=""/></div>
        <p id="forge-triage-empty" class="forge-note" hidden>Rien à trier : toutes les images ont déjà un choix.</p>
        <div class="forge-triage-actions">
          <button type="button" id="forge-triage-reject" class="secondary">Rejeter</button>
          <button type="button" id="forge-triage-favorite" class="secondary">Favori</button>
          <button type="button" id="forge-triage-keep">Garder</button>
        </div>
        <button type="button" id="forge-triage-undo" class="secondary" disabled>Annuler le dernier choix</button>
        <p id="forge-triage-note" class="forge-note" role="status">Glisser à droite : garder · à gauche : rejeter · vers le haut : favori. Une image rejetée va à la corbeille ; rien n’est effacé.</p>
      </div>
    </dialog>
    <dialog id="forge-trash" class="forge-sheet" aria-labelledby="forge-trash-title">
      <div class="forge-sheet-inner">
        <header class="forge-viewer-bar">
          <h2 id="forge-trash-title">Corbeille</h2>
          <button type="button" id="forge-trash-close" class="secondary">Fermer</button>
        </header>
        <p class="forge-note">Les images rejetées restent ici. Remettre les fait revenir dans la galerie ; rien n’est effacé sans Supprimer.</p>
        <p id="forge-trash-empty" class="forge-note" hidden>La corbeille est vide.</p>
        <div id="forge-trash-grid" class="forge-grid"></div>
      </div>
    </dialog>
    <dialog id="forge-inpaint" class="forge-inpaint" aria-labelledby="forge-inpaint-title">
      <header class="forge-viewer-bar">
        <h2 id="forge-inpaint-title">Retoucher une zone</h2>
        <button type="button" id="forge-inpaint-close" class="secondary">Fermer</button>
      </header>
      <div class="forge-inpaint-stage"><img id="forge-inpaint-img" alt=""/><canvas id="forge-inpaint-canvas" width="1" height="1" aria-label="Peignez au doigt la zone à refaire"></canvas></div>
      <div class="forge-inpaint-tools" role="group" aria-label="Pinceau">
        <label class="forge-inpaint-brush">Pinceau <input type="range" id="forge-inpaint-brush" min="8" max="80" step="2" value="28"/></label>
        <button type="button" id="forge-inpaint-undo" class="secondary">Annuler</button>
        <button type="button" id="forge-inpaint-clear" class="secondary">Effacer</button>
      </div>
      <label class="forge-check"><input type="checkbox" id="forge-inpaint-invert"/> Inverser : refaire tout sauf la zone</label>
      <label for="forge-inpaint-prompt">Ce qu’il faut dans la zone</label>
      <textarea id="forge-inpaint-prompt" rows="3" autocomplete="off" spellcheck="false"></textarea>
      <details class="forge-inpaint-more"><summary>Réglages de retouche</summary>
        <label>Force <input type="range" id="forge-inpaint-denoise" min="0.05" max="1" step="0.05" value="0.6"/></label>
        <label>Fondu du bord <input type="range" id="forge-inpaint-blur" min="0" max="32" step="1" value="4"/></label>
        <label for="forge-inpaint-fill">Point de départ</label>
        <select id="forge-inpaint-fill"><option value="1" selected>Image d’origine</option><option value="0">Remplissage</option><option value="2">Bruit latent</option><option value="3">Latent vide</option></select>
        <label class="forge-check"><input type="checkbox" id="forge-inpaint-fullres" checked/> Détailler la zone seule</label>
      </details>
      <p class="forge-note" id="forge-inpaint-where"></p>
      <p class="forge-note" id="forge-inpaint-model" role="status"></p>
      <button type="button" id="forge-inpaint-send">Retoucher</button>
      <p class="forge-note" id="forge-inpaint-note" role="status">Peignez la zone à refaire, puis touchez Retoucher. Forge (ce PC) doit être libre.</p>
    </dialog>
    <dialog id="forge-viewer" aria-labelledby="forge-viewer-title">
      <form method="dialog">
        <header class="forge-viewer-bar">
          <h2 id="forge-viewer-title">Image</h2>
          <button type="button" id="forge-viewer-close" class="secondary">Fermer</button>
        </header>
        <img id="forge-viewer-img" alt=""/>
        <p id="forge-viewer-meta"></p>
        <div class="forge-triage-row" id="forge-viewer-triage" role="group" aria-label="Tri de l’image"></div>
        <button type="button" id="forge-viewer-inpaint" class="secondary forge-inpaint-open">Retoucher une zone</button>
        <details id="forge-lineage" class="forge-lineage">
          <summary>Généalogie</summary>
          <div class="forge-label-row"><span class="forge-note">D'où vient cette image et ce qui en est né.</span><span class="forge-help-wrap"><button type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-lineage">Aide</button><p id="forge-help-lineage" class="forge-help-pop" role="tooltip">Les liens viennent des finitions et des retouches de la galerie. Les variations ne sont pas reliées. Le coffre privé n'apparaît jamais ici.</p></span></div>
          <p id="forge-lineage-note" class="forge-note" role="status"></p>
          <ol id="forge-lineage-tree" class="forge-lineage-tree" aria-label="Arbre de l'image"></ol>
        </details>
        <div class="forge-explore" id="forge-viewer-explore-box">
          <div class="forge-label-row"><label for="forge-viewer-explore-range">Explorer autour</label></div>
          <div class="forge-explore-row"><span aria-hidden="true">proche</span><input type="range" id="forge-viewer-explore-range" min="0.05" max="0.6" step="0.05" value="0.2" aria-valuetext="proche"/><span aria-hidden="true">loin</span></div>
          <button type="button" id="forge-viewer-explore">Générer 6 variations</button>
          <p class="forge-note" id="forge-viewer-explore-note" role="status">Même graine et mêmes réglages : proche garde l'image, loin s'en écarte. Touchez une variation puis Réutiliser pour continuer depuis elle.</p>
        </div>
        <div class="forge-finish" id="forge-viewer-finish">
          <div class="forge-label-row"><label for="forge-finish-scale">Finition sur ce PC</label></div>
          <select id="forge-finish-scale"><option value="1.5">Haute résolution ×1,5</option><option value="2">Haute résolution ×2</option></select>
          <button type="button" id="forge-finish">Lancer la finition</button>
          <p class="forge-note" id="forge-finish-note" role="status">Finition, pas une copie identique : la haute résolution peut changer des détails et la composition. Rendu par le Forge de ce PC.</p>
        </div>
        <p class="forge-note" id="forge-finish-of" hidden><span>Finition d'une image de la galerie. La composition peut différer.</span> <button type="button" id="forge-finish-source" class="forge-tool">Voir l'image d'origine</button></p>
        <div class="forge-actions">
          <a id="forge-download" href="#" download>Télécharger l'original</a>
          <button type="button" id="forge-share" class="secondary" hidden>Enregistrer dans Photos</button>
          <button type="button" id="forge-reuse">Réutiliser les réglages</button>
          <button type="button" id="forge-compare-start" class="secondary">Comparer avec…</button>
          <button type="button" id="forge-delete" class="secondary">Supprimer la copie HQ</button>
        </div>
      </form>
    </dialog>
    <p id="forge-compare-pick" class="forge-compare-pick" role="status" hidden><span>Touchez la seconde image à comparer.</span> <button type="button" id="forge-compare-pick-cancel" class="secondary">Annuler</button></p>
    <dialog id="forge-compare" class="forge-sheet forge-compare" aria-labelledby="forge-compare-title">
      <div class="forge-sheet-inner">
        <header class="forge-viewer-bar">
          <h2 id="forge-compare-title">Comparer A / B</h2>
          <button type="button" id="forge-compare-close" class="secondary">Fermer</button>
        </header>
        <div id="forge-compare-stage" class="forge-compare-stage" role="img" aria-label="Image A et image B superposées. Pincez pour zoomer sur les deux à la fois.">
          <div class="forge-compare-layer"><img id="forge-compare-a" alt=""/></div>
          <div class="forge-compare-clip"><div class="forge-compare-layer"><img id="forge-compare-b" alt=""/></div></div>
          <span class="forge-compare-tag forge-compare-tag-b" aria-hidden="true">B</span><span class="forge-compare-tag forge-compare-tag-a" aria-hidden="true">A</span>
        </div>
        <div class="forge-label-row"><label for="forge-compare-reveal">Révéler B</label></div>
        <input type="range" id="forge-compare-reveal" min="0" max="100" step="1" value="50"/>
        <div class="forge-actions">
          <button type="button" id="forge-compare-swap" class="secondary">Inverser A et B</button>
          <button type="button" id="forge-compare-reset" class="secondary">Zoom initial</button>
        </div>
        <h3 class="forge-compare-h">Différences de réglages</h3>
        <dl id="forge-compare-diff" class="forge-compare-diff"></dl>
        <p class="forge-note">Comparaison faite sur cet appareil ; rien n'est envoyé ni copié, les deux images restent dans la galerie. Le coffre privé n'est pas comparable ici.</p>
      </div>
    </dialog>
    <dialog id="forge-device-dialog" class="forge-sheet" aria-labelledby="forge-device-dialog-title">
      <div class="forge-sheet-inner">
        <header class="forge-viewer-bar">
          <h2 id="forge-device-dialog-title">Ajouter un appareil</h2>
          <button type="button" id="forge-device-dialog-close" class="secondary">Fermer</button>
        </header>
        <p class="forge-note">Six étapes sur le PC à ajouter. Rien n'est installé automatiquement. Ce PC appelle HQ par Tailscale ; HQ ne se connecte jamais à lui.</p>
        <ol class="forge-device-steps forge-guide">
          <li><h3>Logiciels requis</h3><p>Windows 10 ou 11, <strong>Python 3.10+</strong> (python.org, avec le lanceur <code>py</code>), <strong>Tailscale</strong> et <strong>Forge</strong> (Stable Diffusion WebUI Forge) avec au moins un modèle.</p></li>
          <li><h3>Tailscale</h3><p>Connectez Tailscale sur ce PC au <strong>même tailnet</strong> que HQ, puis ouvrez cette page depuis ce PC pour vérifier qu'il joint bien HQ.</p></li>
          <li><h3>Forge</h3><p>Démarrez Forge avec <code>--api</code> et <strong>sans</strong> <code>--listen</code> : son API reste sur 127.0.0.1, seul le worker local l'utilise.</p></li>
          <li><h3>Worker</h3><p>Copiez le fichier <code>hq_forge_worker.py</code> du dossier HQ (à côté de <code>iphone_bridge.py</code>) dans un dossier de ce PC, puis ouvrez PowerShell dans ce dossier et lancez l'appairage :</p>
            <pre id="forge-device-snippet" class="forge-snippet"></pre>
            <button type="button" class="forge-tool" data-copy="pair">Copier la commande d'appairage</button></li>
          <li><h3>Code d'appairage</h3><p>Créez un code et tapez-le à l'invite masquée de PowerShell. Il n'est jamais dans une commande copiée, une URL ou un fichier.</p>
            <button type="button" id="forge-device-code-new">Créer un code à usage unique</button>
            <div id="forge-device-code-box" class="forge-device-code-box" hidden>
              <p class="forge-note">Code valable 10 minutes, une seule fois. Il ne sera plus affiché.</p>
              <output id="forge-device-code" class="forge-device-code" aria-live="polite"></output>
              <p id="forge-device-code-ttl" class="forge-note" role="status"></p>
            </div>
            <p>Puis démarrez le worker :</p>
            <pre id="forge-device-run" class="forge-snippet"></pre>
            <button type="button" class="forge-tool" data-copy="run">Copier la commande de lancement</button></li>
          <li><h3>Vérification</h3><p id="forge-device-detect" class="forge-device-detect" role="status" aria-live="polite"></p></li>
        </ol>
        <p class="forge-note">Démarrage automatique : voir <code>docs/forge-workers.md</code> (tâche planifiée à l'ouverture de session).</p>
      </div>
    </dialog>
    <dialog id="forge-history" class="forge-sheet" aria-labelledby="forge-history-title">
      <div class="forge-sheet-inner">
        <header class="forge-viewer-bar">
          <h2 id="forge-history-title">Historique des prompts</h2>
          <button type="button" id="forge-history-close" class="secondary">Fermer</button>
        </header>
        <p class="forge-note">Les images de la galerie HQ, des plus récentes aux plus anciennes. Rien n'est généré sans votre action. Le coffre privé n'apparaît jamais ici.</p>
        <div class="field">
          <label for="forge-history-search">Rechercher</label>
          <input id="forge-history-search" type="search" autocomplete="off" placeholder="Mot du prompt, modèle…"/>
        </div>
        <p id="forge-history-state" class="forge-note" role="status" aria-live="polite"></p>
        <ul id="forge-history-list" class="forge-history-list"></ul>
        <button type="button" id="forge-history-more" class="secondary" hidden>Plus d'entrées</button>
      </div>
    </dialog>
  </div>

  <div data-panel="plus">
    <nav class="sys-jump" aria-label="Sections Système">
      <button type="button" data-jump="system-session">Session</button>
      <button type="button" data-jump="system-backups">Sauvegardes</button>
      <button type="button" data-jump="system-notifications">Notifications</button>
      <button type="button" class="mode-complet-only" data-jump="system-automations">Automatisations</button>
      <button type="button" class="mode-complet-only" data-jump="system-tasks">Tâches</button>
      <button type="button" data-jump="system-journal">Journal</button>
      <button type="button" data-jump="system-alerts">Alertes</button>
      <button type="button" data-jump="system-info">Infos</button>
    </nav>
    <section class="hq" id="system-session" aria-labelledby="plus-status-title">
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
      <details class="access-share">
        <summary>Partager l'accès</summary>
        <p class="sec-hint">Écran TV / présence / QR → <a href="/wallboard?theme=oled&kiosk=1" style="color:var(--accent)">Wallboard</a>
          · <a href="/wallboard?theme=midnight" style="color:var(--accent)">midnight</a></p>
        <div class="qrs" style="margin-top:10px" aria-label="QR d'accès">
          {qr_lan}
          {qr_ts}
        </div>
        <p class="hint">QR = adresse du pont seulement (pas de PIN ni de session).</p>
      </details>
      <span id="hq-health" class="visually-hidden"></span>
      <div id="hq-spark-host" class="spark-host"></div>
    </section>

    <section class="hq" id="system-brief" aria-labelledby="brief-title">
      <div class="sec-head">
        <h2 id="brief-title">Brief du jour</h2>
        <p class="sec-hint">Résumé déterministe, sans service externe</p>
      </div>
      <div id="hq-brief" class="brief"><p class="hint">Chargement…</p></div>
    </section>

    <section class="hq" id="system-backups" aria-labelledby="backup-title">
      <div class="sec-head">
        <h2 id="backup-title">Sauvegardes</h2>
        <p class="sec-hint">Catalogue local. La restauration écrase le dossier choisi.</p>
      </div>
      <ul class="hq-list" id="hq-backups"><li class="hint">Chargement…</li></ul>
    </section>

    <details class="hq mode-complet-only" id="system-automations">
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

    <section class="hq" id="system-notifications" aria-labelledby="push-title">
      <div class="sec-head">
        <h2 id="push-title">Notifications</h2>
        <p class="sec-hint">Web Push opt-in (HTTPS / Tailscale Serve, push_enabled) : alertes, attention critique, échec d'automatisation. Pas toutes les notifications HQ.</p>
      </div>
      <p id="hq-push-note" class="hint"></p>
      <button type="button" class="secondary" id="btn-push">Activer sur cet appareil</button>
    </section>

    <details class="hq mode-complet-only" id="system-tasks">
      <summary>
        <div class="sec-head">
          <span class="summary-title" style="font-size:1.12rem;font-weight:800;color:var(--text)">Tâches</span>
          <p class="sec-hint">Kanban personnel — pour toi seulement</p>
        </div>
      </summary>
      <div class="kanban" id="kanban"></div>
    </details>

    <details class="hq" id="system-journal">
      <summary>
        <div class="sec-head">
          <span class="summary-title" id="events-title" style="font-size:1.12rem;font-weight:800;color:var(--text)">Journal technique</span>
          <p class="sec-hint">Historique détaillé du pont. Fermé tant que tu n'en as pas besoin.</p>
        </div>
      </summary>
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
    </details>

    <details class="hq" id="system-alerts">
      <summary>
        <div class="sec-head">
          <span class="summary-title" style="font-size:1.12rem;font-weight:800;color:var(--text)">Alertes <span class="badge" id="hq-alert-count">0</span></span>
          <p class="sec-hint">Disque plein, erreurs, avertissements</p>
        </div>
      </summary>
      <ul class="hq-list" id="hq-alerts"><li class="hint">Aucune alerte pour le moment.</li></ul>
    </details>

    <section class="hq" id="system-info">
      <div class="sec-head">
        <h2>Infos</h2>
        <p class="sec-hint">Réglages de base du pont</p>
      </div>
      <dl class="hq-status">
        <dt>Dossier PC</dt><dd>C:\\Transfert\\{{Inbox,Uni,Print}}</dd>
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
<script src="/assets/hq-features.js"></script>
<script src="/assets/hq.js"></script>
<script src="/assets/hq-agent.js"></script>
<script src="/assets/hq-calendar-quick.js"></script>
<script src="/assets/hq-calendar.js"></script>
<script src="/assets/hq-today.js"></script>
<script src="/assets/hq-home.js"></script>
<script src="/assets/hq-carnet-media.js"></script>
<script src="/assets/hq-carnet-eng.js"></script>
<script src="/assets/hq-carnet-struct.js"></script>
<script src="/assets/hq-carnet-rich.js"></script>
<script src="/assets/hq-carnet-field.js"></script>
<script src="/assets/hq-carnet-field-ui.js"></script>
<script src="/assets/hq-carnet-modal.js"></script>
<script src="/assets/hq-carnet-errors.js"></script>
<script src="/assets/hq-carnet-sources.js"></script>
<script src="/assets/hq-carnet-eng-ui.js"></script>
<script src="/assets/hq-carnet-history-ui.js"></script>
<script src="/assets/hq-carnet-reviews.js"></script>
<script src="/assets/hq-carnet-intel.js"></script>
<script src="/assets/hq-carnet-intel-ui.js"></script>
<script src="/assets/hq-carnet-ask.js"></script>
<script src="/assets/hq-carnet-ask-ui.js"></script>
<script src="/assets/hq-carnet-annotations.js"></script>
<script src="/assets/hq-carnet-annotations-ui.js"></script>
<script src="/assets/hq-carnet-verifications.js"></script>
<script src="/assets/hq-carnet-verifications-ui.js"></script>
<script src="/assets/hq-carnet-reasoning.js"></script>
<script src="/assets/hq-carnet-reasoning-ui.js"></script>
<script src="/assets/hq-carnet-reviews-ui.js"></script>
<script src="/assets/hq-carnet-portals.js"></script>
<script src="/assets/hq-carnet-portals-ui.js"></script>
<script src="/assets/hq-carnet-reader.js"></script>
<script src="/assets/hq-carnet-reader-ui.js"></script>
<script src="/assets/hq-carnet-image-ui.js"></script>
<script src="/assets/hq-carnet-structured-ui.js"></script>
<script src="/assets/hq-carnet-nav.js"></script>
<script src="/assets/hq-carnet-polish-ui.js"></script>
<script src="/assets/hq-carnet-dessiner.js"></script>
<script src="/assets/hq-carnet-commands.js"></script>
<script src="/assets/hq-carnet-templates.js"></script>
<script src="/assets/hq-carnet-editor-ui.js"></script>
<script src="/assets/hq-carnet.js"></script>
<script src="/assets/hq-carnet-capture.js"></script>
<script src="/assets/hq-sketch-core.js" data-sk="hq-sketch-core.js"></script>
<script src="/assets/hq-solid-view.js" data-sk="hq-solid-view.js"></script>
<script src="/assets/hq-face-sketch.js" data-sk="hq-face-sketch.js"></script>
<script src="/assets/hq-dessiner.js" data-sk="hq-dessiner.js"></script>
<script src="/assets/hq-forge.js"></script>
<script src="/assets/hq-forge-next.js"></script>
<script src="/assets/hq-forge-explore.js"></script>
<script src="/assets/hq-forge-night.js"></script>
<script src="/assets/hq-forge-vault-search.js"></script>
<script src="/assets/hq-forge-inpaint.js"></script>
<script src="/assets/hq-forge-bricks.js"></script>
<script src="/assets/hq-forge-lineage.js"></script>
<script src="/assets/hq-forge-style.js"></script>
<script src="/assets/hq-forge-couch.js"></script>
<script src="/assets/hq-model-view.js"></script>
<dialog id="hq-device-dialog" aria-labelledby="hq-device-title">
  <form method="dialog">
    <header><strong id="hq-device-title">Appareil</strong></header>
    <div id="hq-device-body"></div>
    <div class="row"><button value="cancel" class="secondary">Fermer</button></div>
  </form>
</dialog>
<dialog id="hq-agent-dialog" aria-labelledby="hq-agent-title">
  <form method="dialog">
    <header><strong id="hq-agent-title">Centre agents</strong></header>
    <div id="hq-agent-body"><p class="hint">Chargement…</p></div>
    <div class="row"><button value="cancel" class="secondary">Fermer</button></div>
  </form>
</dialog>
<div id="hq-palette" class="palette" hidden>
  <div class="palette-card" role="dialog" aria-modal="true" aria-labelledby="hq-palette-title">
    <p id="hq-palette-title" class="palette-title">Recherche HQ</p>
    <input id="hq-palette-input" type="search" placeholder="Dossier, scène, appareil, action…" autocomplete="off" aria-autocomplete="list" aria-controls="hq-palette-list"/>
    <div id="hq-palette-list"></div>
    <p class="palette-foot">↑ ↓ naviguer · Entrée ouvrir · Échap fermer</p>
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


_DIAG_STATE: dict = {"root": None, "assets": None, "last_probe": None}
_DIAG_LOCK = threading.Lock()


def _diag_ensure() -> None:
    """Lazy, once-per-ROOT: capture identity (build SHA read from .git ONCE) and attach the bounded error log."""
    with _DIAG_LOCK:
        if _DIAG_STATE["root"] == str(ROOT):
            return
        hq_diagnostics.init_identity(ROOT, version="7.0", started_at=_STARTED_AT)
        hq_diagnostics.ERRORS.attach(ROOT)
        _DIAG_STATE["root"] = str(ROOT)
        _DIAG_STATE["assets"] = None


def _diag_asset_names() -> list[str]:
    with _DIAG_LOCK:
        if _DIAG_STATE["assets"] is None:
            _DIAG_STATE["assets"] = hq_diagnostics.required_assets(render_app)
        return list(_DIAG_STATE["assets"])


# Capture the build identity when the module is LOADED (the code in memory is the code that matters): a later `git pull` moves HEAD
# on disk but not this process, and /api/diag/info reports that difference as restart_pending.
_diag_ensure()


def _diag_record_exc(handler, exc: BaseException) -> str:
    try:
        _diag_ensure()
        sub = hq_diagnostics.path_category(getattr(handler, "path", ""))
        return hq_diagnostics.ERRORS.record(sub, exc=exc, path=getattr(handler, "path", ""), status=500)
    except Exception:
        return ""


_LOG_QUERY = re.compile(r"\?\S*")
_LOG_CTRL = re.compile(r"[\x00-\x1f\x7f]")


REFUSAL_DRAIN_MAX = 64 * 1024  # bytes a pre-body 401/403 may read and discard
REFUSAL_DRAIN_TIMEOUT = 1.5  # seconds, total, for that discard


def _log_safe_arg(a):
    """Access-log argument with any query string / fragment removed. A request line that does not parse as
    ``METHOD target VERSION`` is replaced outright (a malformed line may hold query text across spaces)."""
    if not isinstance(a, str) or ("?" not in a and "#" not in a):
        return a
    if a.count(" ") != 2:
        return "<malformed request>"
    return re.sub(r"[?#]\S*", "?<q>", a)


def _diag_record_5xx(handler, code: int, obj) -> None:
    try:
        _diag_ensure()
        path = getattr(handler, "path", "")
        sub = hq_diagnostics.path_category(path)
        if sub == "/api/diag":  # readiness / probe 503 is the designed signal, not an application fault (and must not flood the log)
            return
        fixed = obj.get("code") if isinstance(obj, dict) and isinstance(obj.get("code"), str) else None
        hq_diagnostics.ERRORS.record(sub, path=path, status=code, code=fixed or f"http_{code}")
    except Exception:
        pass


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
        # Access log keeps client / method / path / status / size but never the query string (it can carry
        # search text, tokens or ids): same policy as the scrubbed error log.
        try:
            line = fmt % tuple(_log_safe_arg(a) for a in args)
            line = _LOG_QUERY.sub("?<q>", line)
            line = _LOG_CTRL.sub(" ", line)[:400]
        except Exception:
            line = "<log line unavailable>"
        sys.stderr.write("%s - %s\n" % (self.address_string(), line))

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

    def _security_headers(self, *, frame_self: bool = False) -> None:
        """``frame_self`` (Stage 05, inline PDFs served by /files/ only): the Carnet source viewer embeds
        the confined local PDF in a same-origin frame. Every other response keeps ``frame-ancestors 'none'``."""
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN" if frame_self else "DENY")
        # same-origin: keep Referer for CSRF on same-host GETs (logout); never leak off-origin
        self.send_header("Referrer-Policy", "same-origin")
        policy = (
            "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self' 'unsafe-inline'; connect-src 'self'; "
            + ("frame-ancestors 'self'" if frame_self else "frame-ancestors 'none'")
            + "; base-uri 'self'"
        )
        if getattr(self, "_wasm_ok", False):  # Phase 4: set ONLY while serving the vendored OCR worker script
            policy = policy.replace("script-src 'self' 'unsafe-inline';", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval';", 1)
        self.send_header("Content-Security-Policy", policy)

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
        if code in (401, 403) and getattr(self, "_prebody_refusal", False):
            headers = list(headers or []) + self._drain_refused_body()
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

    def _drain_refused_body(self) -> list[tuple[str, str]]:
        """Pre-body POST refusal (status already decided): read and discard a small declared body so the client
        sees the 401/403 instead of a connection abort. Never parsed, stored, logged or passed on. Too large,
        missing or invalid Content-Length, a slow sender or a short body -> no (further) read + Connection: close."""
        self._prebody_refusal = False
        close = [("Connection", "close")]
        raw = (self.headers.get("Content-Length") or "").strip()
        if not raw.isdigit() or int(raw) > REFUSAL_DRAIN_MAX:
            self.close_connection = True
            return close
        left = int(raw)
        if not left:
            return []
        sock = self.connection
        old = sock.gettimeout()
        deadline = time.monotonic() + REFUSAL_DRAIN_TIMEOUT
        try:
            while left > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                sock.settimeout(remaining)
                chunk = self.rfile.read1(min(8192, left))
                if not chunk:
                    break
                left -= len(chunk)
                chunk = b""
        except OSError:
            pass
        finally:
            try:
                sock.settimeout(old)
            except OSError:
                pass
        if left > 0:
            self.close_connection = True
            return close
        return []

    def _json(self, code: int, obj: dict, headers: list[tuple[str, str]] | None = None) -> None:
        try:
            body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        except Exception:
            body = json.dumps({"error": "Réponse JSON invalide"}).encode("utf-8")
            code = 500
        if code >= 500:  # Phase 15: bounded local record (category + fixed error code only; never the message or the body)
            _diag_record_5xx(self, code, obj)
        self._send(code, body, "application/json; charset=utf-8", headers)

    def _agent_v1(self) -> None:
        """Signed companion routes. No cookie session, no public RPC."""
        raw = urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self._json(400, {"error": "longueur invalide"})
            return
        cap = hq_companion.max_body_for(raw)
        if length < 0 or length > cap:
            self._json(413, {"error": "corps trop volumineux"})
            return
        body = self.rfile.read(length) if length else b""
        ip = self.client_address[0] if self.client_address else ""
        code, payload = hq_companion.handle_device(
            method=self.command or "POST",
            path=raw,
            headers=self.headers,
            body=body,
            client_ip=ip,
        )
        self._json(code, payload)

    def _forge_worker(self, raw: str) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self._json(400, {"error": "longueur invalide"})
            return
        if length < 0 or length > hq_forge_fleet.max_body(raw):
            self._json(413, {"error": "Requête trop grande."})
            return
        body = self.rfile.read(length) if length else b""
        hq_forge_fleet.bind(ROOT)
        ip = self.client_address[0] if self.client_address else ""
        code, payload = hq_forge_fleet.handle_worker(self.command or "POST", raw, self.headers, body, ip)
        self._json(code, payload)

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

    # ---- Phase 15: local diagnostics (admin-only; read-only except the explicit write probe) ----
    def _diag_get(self, raw: str, parsed) -> bool:
        if raw != "/diagnostics" and not raw.startswith("/api/diag/"):
            return False
        if not self._require_admin():
            return True
        try:
            _diag_ensure()
            qs = parse_qs(parsed.query)
            if raw == "/diagnostics":
                self._send(200, hq_diagnostics_ui.render_page().encode("utf-8"), "text/html; charset=utf-8")
            elif raw == "/api/diag/live":
                self._json(200, hq_diagnostics.liveness())
            elif raw == "/api/diag/ready":
                rep = hq_diagnostics.readiness(root=ROOT, config=CONFIG, config_path=CONFIG_PATH, asset_names=_diag_asset_names(), voice_mod=None)
                self._json(200 if rep["status"] != "not_ready" else 503, rep)
            elif raw == "/api/diag/info":
                exp = (qs.get("expect", [""])[0] or "").strip() or None
                info = hq_diagnostics.identity(ROOT, expect=exp)
                info["version"] = info.get("version") or "7.0"
                fatal = hq_diagnostics.startup_fatal(ROOT)
                if fatal:
                    fatal["before_current_start"] = bool(fatal.get("at", "") < info.get("started_at_utc", ""))
                    info["last_startup_error"] = fatal
                info["errors"] = hq_diagnostics.ERRORS.summary()
                self._json(200, info)
            elif raw == "/api/diag/subsystems":
                self._json(200, hq_diagnostics.subsystems(root=ROOT, config=CONFIG, carnet=hq_carnet, asset_names=_diag_asset_names()))
            elif raw == "/api/diag/backup":
                verify = (qs.get("verify", [""])[0] or "") in ("1", "true", "yes")
                self._json(200, hq_diagnostics.backup_report(config=CONFIG, root=ROOT, verify=verify))
            elif raw == "/api/diag/errors":
                try:
                    lim = int((qs.get("limit", ["50"])[0] or "50"))
                except ValueError:
                    lim = 50
                self._json(200, {"errors": hq_diagnostics.ERRORS.recent(lim), "summary": hq_diagnostics.ERRORS.summary()})
            else:
                self._json(404, {"error": "Inconnu"})
        except Exception as e:  # a diagnostics bug must answer, not crash the handler thread
            rid = hq_diagnostics.ERRORS.record("diagnostics", exc=e, path=raw)
            self._json(500, {"error": "diagnostic_failed", "request_id": rid})
        return True

    def _diag_post(self, raw: str) -> bool:
        if not raw.startswith("/api/diag/"):
            return False
        if not self._require_admin():
            return True
        if raw != "/api/diag/write-probe":
            self._json(404, {"error": "Inconnu"})
            return True
        try:
            _diag_ensure()
            res = hq_diagnostics.write_probe(ROOT)
            if res.get("status") != "ok":
                hq_diagnostics.ERRORS.record("diagnostics.write_probe", message=f"write probe failed at {res.get('failed_step')}", path=raw)
            _DIAG_STATE["last_probe"] = res
            self._json(200 if res.get("status") == "ok" else 503, res)
        except Exception as e:
            rid = hq_diagnostics.ERRORS.record("diagnostics", exc=e, path=raw)
            self._json(500, {"error": "diagnostic_failed", "request_id": rid})
        return True

    def _guard_admin_path(self, raw: str) -> bool:
        """Return False if blocked (response already sent). Allowlist for upload role."""
        if self._role() == "admin":
            return True
        # Static/login already handled; for authenticated GETs enforce allowlist.
        method = "GET"
        if not self._upload_allowed(method, raw):
            if raw == "/api/carnet/reader-pdf":
                self._carnet_reader_pdf_refusal(403, {"error": "Réservé admin"})  # frame-readable (see above)
            else:
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
        # No "Accept-Ranges": this route streams the whole file and never answers a Range request (the media / voice routes do).
        self.send_header("Cache-Control", "no-store")
        self._security_headers(frame_self=(ext == ".pdf" and not as_download))
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

    def _send_media(self, path: Path) -> None:
        """Lecteur stream: allow-listed type, inline, one byte range (206/416), chunked.
        3D models go out as attachment with an extra sandbox CSP: the Lecteur reads them
        with fetch(); a direct navigation must download, never render."""
        ctype = MEDIA_CONTENT_TYPES[path.suffix.lower()]
        attachment = path.suffix.lower() in MEDIA_ATTACHMENT_EXTS
        with path.open("rb") as f:
            st = os.fstat(f.fileno())
            size = st.st_size
            etag = f'"{size:x}-{st.st_mtime_ns:x}"'
            last_modified = formatdate(st.st_mtime, usegmt=True)
            rng = parse_byte_range(self.headers.get("Range"), size)
            if_range = (self.headers.get("If-Range") or "").strip()
            if rng is not None and if_range and if_range not in (etag, last_modified):
                rng = None  # file changed since the client's first response: send it whole
            if rng == "unsatisfiable":
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.send_header("Cache-Control", "no-store")
                self._security_headers()
                self.end_headers()
                return
            start, end = rng if isinstance(rng, tuple) else (0, size - 1)
            length = max(0, end - start + 1)
            ascii_name = re.sub(r"[^A-Za-z0-9._ -]", "_", path.name) or "media"
            self.send_response(206 if isinstance(rng, tuple) else 200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            if isinstance(rng, tuple):
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", etag)
            self.send_header("Last-Modified", last_modified)
            self.send_header("Cache-Control", "no-store")
            self._security_headers()
            if attachment:
                self.send_header("Content-Security-Policy", "sandbox; default-src 'none'")
            disposition = "attachment" if attachment else "inline"
            self.send_header("Content-Disposition", f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(path.name)}")
            self.end_headers()
            f.seek(start)
            remaining = length
            try:
                while remaining > 0:
                    chunk = f.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (ConnectionError, TimeoutError):
                # Players abort and re-request ranges when seeking or pausing: normal, not an error.
                self.close_connection = True
                return
            if remaining:
                self.close_connection = True  # file shrank mid-stream; Content-Length can't be honoured

    def _drawings_get(self, raw: str, parsed) -> bool:
        """Dessiner: list / reopen / fetch saved files. Admin-only (not in UPLOAD_* allowlists)."""
        if raw not in ("/api/drawings", "/api/drawings/open", "/api/drawings/file"):
            return False
        qs = parse_qs(parsed.query)
        try:
            if raw == "/api/drawings":
                self._json(200, hq_drawings.list_drawings(ROOT))
            elif raw == "/api/drawings/open":
                self._json(200, hq_drawings.open_drawing(ROOT, (qs.get("stem") or [""])[0]))
            else:
                kind = (qs.get("kind") or [""])[0]
                body, ctype, name = hq_drawings.read_file(ROOT, (qs.get("stem") or [""])[0], kind)
                disp = "inline" if kind == "png" else "attachment"
                self._send(200, body, ctype, [("Content-Disposition", f'{disp}; filename="{name}"')])
        except hq_drawings.DrawingError as e:
            self._json(e.status, {"error": str(e)})
        return True

    def _drawings_post(self, raw: str) -> bool:
        if raw not in ("/api/drawings", "/api/drawings/mesh"):
            return False
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self._json(400, {"error": "longueur invalide"})
            return True
        if length <= 0 or length > hq_drawings.MAX_BODY:
            self.close_connection = True
            self._json(413 if length > 0 else 400, {"error": "Dessin trop volumineux" if length > 0 else "Corps vide"})
            return True
        body = self.rfile.read(length)
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {"error": "JSON invalide"})
            return True
        try:
            result = hq_drawings.preview_mesh(data) if raw == "/api/drawings/mesh" else hq_drawings.save_drawing(ROOT, data, asset_exists=hq_carnet.media.asset_exists)
        except hq_drawings.DrawingError as e:
            self._json(e.status, {"error": str(e)})
            return True
        # No cc_ext.log_activity here: the save must never wait on the shared activity lock.
        self._json(200, result)
        return True

    # Multi-vault: /api/forge/vaults/<vid>/... per vault. V4 removed the old /api/forge/vault/* alias
    # (404 now). Only ids travel in paths, never a name. Per-vault setup and restore-in-place are not
    # offered (create is its own route; V6 restores a ZIP as a new vault via /api/forge/vaults/restore).
    _NOT_PER_VAULT = ("/setup", "/restore")

    def _vault_route(self, raw: str) -> tuple[str | None, str | None]:
        """(vid, sub-path); sub None when the path is not a per-vault path."""
        if raw.startswith("/api/forge/vaults/"):
            vid, sep, tail = raw[len("/api/forge/vaults/"):].partition("/")
            if sep and tail and hq_forge_vault.registry.VID_RE.fullmatch(vid):
                return vid, "/" + tail
        return None, None

    def _forge_vault_binary(self, raw: str, token: str | None, vid: str | None = None) -> bool:
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self._json(400, {"error": "Requête invalide"})
            return True
        cap = hq_forge_vault.BACKUP_MAX + 4096 if raw.endswith("/restore") else hq_forge_vault.IMPORT_MAX
        if length <= 0 or length > cap:
            self._json(413, {"error": "Requête trop grande."})
            return True
        blob = self.rfile.read(length)
        try:
            if raw.endswith("/import"):
                self._json(201, hq_forge_vault.store_image(ROOT, token, blob, None, vid=vid))
                return True
            if length < 5:
                raise hq_forge_vault.VaultError("validation")
            meta_len = struct.unpack(">I", blob[:4])[0]
            if meta_len <= 0 or meta_len > 4096 or 4 + meta_len > len(blob):
                raise hq_forge_vault.VaultError("validation")
            meta = json.loads(blob[4:4 + meta_len].decode("utf-8"))
            if not isinstance(meta, dict):
                raise hq_forge_vault.VaultError("validation")
            self._json(201, hq_forge_vault.restore_as_new(
                ROOT, token, blob[4 + meta_len:], str(meta.get("passphrase") or ""), label=meta.get("label"),
                glyph=meta.get("glyph", "coffre"), colour=meta.get("colour", "ardoise")))  # V6: always a new vault
        except hq_forge_vault.VaultError as exc:
            self._vault_error(exc)
        except (UnicodeError, json.JSONDecodeError, struct.error):
            self._json(400, {"error": hq_forge_vault.public_error("validation"), "code": "validation"})
        return True

    def _forge_vault_post(self, raw: str, data: dict, token: str | None) -> None:
        if raw in self._MIGRATION_POSTS:
            self._forge_migration_post(raw, data, token)
            return
        if raw in ("/api/forge/vaults/new", "/api/forge/vaults/migrate", "/api/forge/vaults/backup-offer", "/api/forge/vaults/order"):
            try:
                if raw.endswith("/order"):
                    self._json(200, hq_forge_vault.reorder_vaults(ROOT, token, data.get("ids")))  # V5: up/down buttons
                elif raw.endswith("/backup-offer"):
                    self._json(200, hq_forge_vault.acknowledge_backup_offer(ROOT, token))
                elif raw.endswith("/new"):
                    self._json(201, hq_forge_vault.create_vault(
                        ROOT, token, str(data.get("passphrase") or ""), str(data.get("confirm") or ""),
                        label=data.get("label"), glyph=data.get("glyph", "coffre"), colour=data.get("colour", "ardoise"),
                        discret=data.get("discret", False)))
                else:
                    self._json(200, hq_forge_vault.migrate_legacy(ROOT, token))
            except hq_forge_vault.VaultError as exc:
                self._vault_error(exc)
            return
        vid, sub = self._vault_route(raw)
        if sub is None or vid is None or sub in self._NOT_PER_VAULT:
            self._json(404, {"error": "Inconnu"})
            return
        try:
            if sub == "/unlock":
                self._json(200, hq_forge_vault.unlock(ROOT, token, str(data.get("passphrase") or ""), vid=vid))
            elif sub == "/recover":
                self._json(200, hq_forge_vault.unlock_with_recovery(ROOT, token, str(data.get("recovery_key") or ""), vid=vid))
            elif sub == "/lock":
                self._json(200, hq_forge_vault.lock(token))
            elif sub == "/passphrase":
                self._json(200, hq_forge_vault.change_passphrase(
                    ROOT, token, str(data.get("current") or ""), str(data.get("passphrase") or ""),
                    str(data.get("confirm") or ""), recovery_key=data.get("recovery_key") if isinstance(data.get("recovery_key"), str) else None, vid=vid,
                ))
            elif sub == "/recovery":
                self._json(200, hq_forge_vault.rotate_recovery(ROOT, token, str(data.get("passphrase") or ""), vid=vid))
            elif sub.startswith("/images/") and sub.endswith("/delete"):
                image_id = sub[len("/images/"):-len("/delete")]
                self._json(200, hq_forge_vault.delete(ROOT, token, image_id, vid=vid))
            elif sub.startswith("/images/") and sub.endswith("/triage"):
                image_id = sub[len("/images/"):-len("/triage")]
                self._json(200, hq_forge_vault.set_triage(ROOT, token, image_id, data.get("state"), vid=vid))
            elif sub.startswith("/images/") and sub.endswith("/labels"):
                image_id = sub[len("/images/"):-len("/labels")]
                if not hq_forge_vault.ID_RE.fullmatch(image_id):
                    raise hq_forge_vault.VaultError("bad_id")
                self._json(200, hq_forge_vault.set_labels(ROOT, token, image_id, data.get("tags"), data.get("collection"), vid=vid))
            elif sub == "/search":
                self._json(200, hq_forge_vault.search(ROOT, token, data, vid=vid))
            elif sub == "/settings":
                self._json(200, hq_forge_vault.update_vault(ROOT, token, vid, data))
            elif sub == "/icon":
                self._json(200, hq_forge_vault.set_icon(ROOT, token, vid, data.get("image_id")))  # V5: sealed in this vault
            elif sub == "/icon/clear":
                self._json(200, hq_forge_vault.clear_icon(ROOT, token, vid))
            elif sub == "/check":
                self._json(200, hq_forge_vault.deep_check(ROOT, token, vid))  # open vault only; changes nothing
            elif sub == "/destroy":
                self._json(200, hq_forge_vault.delete_vault(
                    ROOT, token, vid, str(data.get("passphrase") or ""), str(data.get("confirm") or "")))  # V6
            elif sub == "/rename":
                self._json(200, hq_forge_vault.rename_vault(ROOT, token, vid, data.get("label")))  # open vault only
            else:
                self._json(404, {"error": "Inconnu"})
        except hq_forge_vault.VaultError as exc:
            self._vault_error(exc)

    # Multi-vault V4: the single pre-migration vault has its own small set of routes, used only by the
    # migration screen (open it, download its ZIP, then migrate). They answer 404 once the layout is
    # not 'legacy'. /api/forge/vaults/lock closes whatever vault this session has open.
    _MIGRATION_POSTS = ("/api/forge/vaults/lock", "/api/forge/vaults/migration/unlock", "/api/forge/vaults/migration/recover")

    def _forge_migration_post(self, raw: str, data: dict, token: str | None) -> None:
        if raw == "/api/forge/vaults/lock":
            self._json(200, hq_forge_vault.lock(token))
            return
        if hq_forge_vault.layout(ROOT) != "legacy":
            self._json(404, {"error": "Inconnu"})
            return
        try:
            if raw.endswith("/unlock"):
                self._json(200, hq_forge_vault.unlock(ROOT, token, str(data.get("passphrase") or "")))
            else:
                self._json(200, hq_forge_vault.unlock_with_recovery(ROOT, token, str(data.get("recovery_key") or "")))
        except hq_forge_vault.VaultError as exc:
            self._vault_error(exc)

    def _forge_migration_get(self, raw: str, token: str | None) -> None:
        state = hq_forge_vault.layout(ROOT)
        if raw == "/api/forge/vaults/migration":
            info = {"layout": state, "configured": False, "unlocked": False}
            if state == "legacy":
                found = hq_forge_vault.status(ROOT, token)
                info.update(configured=bool(found.get("configured")), unlocked=bool(found.get("unlocked")))
            self._json(200, info)
            return
        if state != "legacy":
            self._json(404, {"error": "Inconnu"})
            return
        try:
            payload = hq_forge_vault.backup_bytes(ROOT, token)  # records the offer, bound to this unlock
        except hq_forge_vault.VaultError as exc:
            self._vault_error(exc)
            return
        self._send(200, payload, "application/zip", [("Content-Disposition", 'attachment; filename="coffre-chiffre.zip"')])

    def _vault_error(self, exc: hq_forge_vault.VaultError) -> None:
        self._json(hq_forge_vault.http_status(exc.code), {"error": hq_forge_vault.public_error(exc.code), "code": exc.code})

    def _forge_vault_get(self, raw: str, parsed) -> bool:
        if not raw.startswith("/api/forge/vault"):
            return False
        token = self._token()
        if raw in ("/api/forge/vaults/migration", "/api/forge/vaults/migration/backup"):
            self._forge_migration_get(raw, token)
            return True
        if raw == "/api/forge/vaults/health":
            try:
                self._json(200, hq_forge_vault.health(ROOT, token))  # read-only, counts and codes only
            except hq_forge_vault.VaultError as exc:
                self._vault_error(exc)
            return True
        if raw == "/api/forge/vaults":
            try:
                self._json(200, hq_forge_vault.list_vaults(ROOT, token))
            except hq_forge_vault.VaultError as exc:
                self._vault_error(exc)
            return True
        vid, sub = self._vault_route(raw)
        if sub is None or vid is None or sub in self._NOT_PER_VAULT:
            self._json(404, {"error": "Inconnu"})
            return True
        if sub == "/status":
            info = hq_forge_vault.status(ROOT, token, vid=vid)
            if vid is not None and info.get("code") in ("bad_vault", "registry"):
                self._vault_error(hq_forge_vault.VaultError(info["code"]))  # unknown id: 404, never an empty 200
                return True
            self._json(200, info)
            return True
        if sub == "/icon":
            try:
                payload, ctype = hq_forge_vault.icon_bytes(ROOT, token, vid)  # V5: only while this vault is open here
            except hq_forge_vault.VaultError as exc:
                self._vault_error(exc)
                return True
            self._send(200, payload, ctype, [("Content-Disposition", 'inline; filename="icone"')])
            return True
        if sub == "/backup":
            try:
                payload = hq_forge_vault.backup_bytes(ROOT, token, vid=vid)
            except hq_forge_vault.VaultError as exc:
                self._vault_error(exc)
                return True
            self._send(200, payload, "application/zip", [("Content-Disposition", 'attachment; filename="coffre-chiffre.zip"')])
            return True
        if sub == "/gallery":
            qs = parse_qs(parsed.query)
            try:
                limit = int((qs.get("limit") or ["24"])[0])
            except ValueError:
                limit = 24
            cursor = (qs.get("cursor") or [None])[0] or None
            try:
                view = (qs.get("view") or [""])[0]
                self._json(200, hq_forge_vault.page(ROOT, token, limit=limit, cursor=cursor, view=view if view in ("trash", "untriaged") else "", vid=vid))
            except hq_forge_vault.VaultError as exc:
                self._vault_error(exc)
            return True
        prefix = "/images/"
        if not sub.startswith(prefix):
            self._json(404, {"error": "Inconnu"})
            return True
        rest = sub[len(prefix):]
        kind = ""
        if rest.endswith("/original"):
            image_id, kind = rest[: -len("/original")], "original"
        elif rest.endswith("/thumb"):
            image_id, kind = rest[: -len("/thumb")], "thumb"
        else:
            image_id = rest
        if kind:
            try:
                wanted = kind == "original" and (parse_qs(parsed.query).get("parameters") or [""])[0] == "1"
                payload, ctype, disposition = hq_forge_vault.file_bytes(ROOT, token, image_id, kind, include_parameters=wanted, vid=vid)
            except hq_forge_vault.VaultError as exc:
                self._vault_error(exc)
                return True
            self._send(200, payload, ctype, [("Content-Disposition", disposition)])
            return True
        if "/" in image_id:
            self._json(404, {"error": "Inconnu"})
            return True
        try:
            self._json(200, hq_forge_vault.detail(ROOT, token, image_id, vid=vid))
        except hq_forge_vault.VaultError as exc:
            self._vault_error(exc)
        return True

    def _forge_get(self, raw: str, parsed) -> bool:
        if not raw.startswith("/api/forge/"):
            return False
        if not self._require_admin():
            return True
        if self._forge_vault_get(raw, parsed):
            return True
        hq_forge_jobs.recover(ROOT)
        hq_forge_fleet.bind(ROOT)
        fleet = hq_forge_fleet.serve_get(raw)
        if fleet is not None:
            self._json(fleet[0], fleet[1])
            return True
        night = hq_forge_night.serve_get(ROOT, raw)
        if night is not None:
            self._json(night[0], night[1])
            return True
        inpaint = hq_forge_inpaint.serve_get(raw)
        if inpaint is not None:
            self._json(inpaint[0], inpaint[1])
            return True
        if raw == "/api/forge/status":
            self._json(200, hq_forge.status())
            return True
        if raw == "/api/forge/catalog":
            self._json(200, hq_forge.catalog())
            return True
        presets = hq_forge_presets.serve_get(ROOT, raw)
        if presets is not None:
            self._json(presets[0], presets[1])
            return True
        style = hq_forge_style.serve_get(ROOT, raw)
        if style is not None:
            self._json(style[0], style[1])
            return True
        bricks = hq_forge_bricks.serve_get(ROOT, raw)
        if bricks is not None:
            self._json(bricks[0], bricks[1])
            return True
        lineage = hq_forge_lineage.serve_get(ROOT, raw)
        if lineage is not None:
            self._json(lineage[0], lineage[1])
            return True
        served = hq_forge_gallery.serve_file(ROOT, raw)
        if served is not None:
            code, body, ctype, headers = served
            if isinstance(body, dict):
                self._json(code, body)
            else:
                self._send(code, body, ctype, headers)
            return True
        if raw == "/api/forge/gallery":
            qs = parse_qs(parsed.query)
            try:
                limit = int((qs.get("limit") or ["24"])[0])
            except ValueError:
                limit = 24
            cursor = (qs.get("cursor") or [None])[0] or None
            try:
                if (qs.get("view") or [""])[0] == "history":
                    self._json(200, hq_forge_gallery.history_page(ROOT, limit=limit, cursor=cursor, query=(qs.get("q") or [""])[0]))
                    return True
                view = (qs.get("view") or [""])[0]
                self._json(200, hq_forge_gallery.page(ROOT, limit=limit, cursor=cursor, view=view if view in ("trash", "untriaged") else ""))
            except hq_forge_gallery.GalleryError:
                self._json(400, {"error": "Introuvable"})
            return True
        prefix = "/api/forge/gallery/"
        if raw.startswith(prefix) and "/" not in raw[len(prefix):]:
            try:
                self._json(200, hq_forge_gallery.get(ROOT, raw[len(prefix):]))
            except hq_forge_gallery.GalleryError:
                self._json(404, {"error": "Introuvable"})
            return True
        if raw == "/api/forge/lab":
            # Read-only Laboratoire summary: settings, durations, outcomes and sort flags. No prompt, no vault.
            self._json(200, hq_forge_lab.summary(ROOT, parse_qs(parsed.query)))
            return True
        got = hq_forge_jobs.serve_get(ROOT, raw, parsed.query, self._token())
        if got is None:
            self._json(404, {"error": "Inconnu"})
            return True
        self._json(got[0], got[1])
        return True

    def _forge_post(self, raw: str) -> bool:
        if not raw.startswith("/api/forge/"):
            return False
        if not self._require_admin():
            return True
        token = self._token()
        if raw.startswith("/api/forge/vault/"):
            self._json(404, {"error": "Inconnu"})  # V4: the old single-vault alias is gone
            return True
        vault_vid, vault_sub = self._vault_route(raw)
        if vault_vid is not None and vault_sub == "/import":
            return self._forge_vault_binary(raw, token, vault_vid)
        if raw == "/api/forge/vaults/restore":
            return self._forge_vault_binary(raw, token)
        hq_forge_jobs.recover(ROOT)
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self._json(400, {"error": "JSON invalide"})
            return True
        max_length = 262144 if raw == "/api/forge/presets" else (3 * 1024 * 1024 if raw == "/api/forge/inpaint" else 65536)
        if length < 0 or length > max_length:
            self._json(413, {"error": "Requête trop grande."})
            return True
        blob = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(blob.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            self._json(400, {"error": "JSON invalide"})
            return True
        if not isinstance(data, dict):
            self._json(400, {"error": "JSON invalide"})
            return True
        prefix = "/api/forge/gallery/"
        if raw.startswith(prefix) and raw.endswith("/triage"):
            try:
                self._json(200, hq_forge_gallery.set_triage(ROOT, raw[len(prefix):-len("/triage")], data.get("state")))
            except hq_forge_gallery.GalleryError as exc:
                if exc.code == "bad_triage":
                    self._json(400, {"error": "\u00c9tat de tri inconnu.", "code": "bad_triage"})
                else:
                    self._json(404, {"error": "Introuvable"})
            return True
        if raw.startswith(prefix) and raw.endswith("/delete"):
            image_id = raw[len(prefix):-len("/delete")]
            try:
                self._json(200, hq_forge_gallery.delete(ROOT, image_id))
            except hq_forge_gallery.GalleryError:
                self._json(404, {"error": "Introuvable"})
            return True
        if raw.startswith("/api/forge/vaults/"):
            self._forge_vault_post(raw, data, token)
            return True
        presets = hq_forge_presets.serve_post(ROOT, raw, data)
        if presets is not None:
            self._json(presets[0], presets[1])
            return True
        style = hq_forge_style.serve_post(ROOT, raw, data)
        if style is not None:
            self._json(style[0], style[1])
            return True
        bricks = hq_forge_bricks.serve_post(ROOT, raw, data)
        if bricks is not None:
            self._json(bricks[0], bricks[1])
            return True
        inpaint = hq_forge_inpaint.serve_post(ROOT, raw, data, token)
        if inpaint is not None:
            self._json(inpaint[0], inpaint[1])
            return True
        night = hq_forge_night.serve_post(ROOT, raw, data)
        if night is not None:
            self._json(night[0], night[1])
            return True
        hq_forge_fleet.bind(ROOT)
        fleet = hq_forge_fleet.serve_post(raw, data, (self.headers.get("Idempotency-Key") or "").strip())
        if fleet is not None:
            self._json(fleet[0], fleet[1])
            return True
        got = hq_forge_jobs.serve_post(ROOT, raw, data, (self.headers.get("Idempotency-Key") or "").strip(), token)
        if got is None:
            self._json(404, {"error": "Inconnu"})
            return True
        self._json(got[0], got[1])
        return True

    def _hq_get(self, raw: str, parsed) -> bool:
        if self._forge_get(raw, parsed):
            return True
        if self._drawings_get(raw, parsed):
            return True
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
        if raw in ("/api/agent", "/api/agent/jobs"):
            code, payload = hq_companion.admin_get(raw, parse_qs(parsed.query))
            self._json(code, payload)
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
            self._json(200, {"q": q, "hits": hits + search_content(q)})  # content groups follow the catalog
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
        if raw == "/api/today":
            self._json(200, build_today())
            return True
        if raw == "/api/home-layout":
            self._json(200, {"layout": hq_home.load(ROOT / "hq_home_layout.json")})
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
        if raw == "/api/calendar":
            qs = parse_qs(parsed.query)
            try:
                start = hq_calendar.parse_bound((qs.get("from", [""])[0] or ""))
                end = hq_calendar.parse_bound((qs.get("to", [""])[0] or ""))
                flag = (qs.get("include_activity", ["0"])[0] or "0").strip()
                if flag not in ("0", "1"):
                    raise hq_calendar.CalendarError("include_activity invalide")
                payload = hq_calendar.query(start, end, include_activity=(flag == "1"))
            except hq_calendar.CalendarError as e:
                self._json(400, {"error": str(e)})
                return True
            except hq_calendar.CalendarConflict as e:
                self._json(409, {"error": str(e)})
                return True
            self._json(200, payload)
            return True
        if raw == "/api/carnet":
            code, payload = hq_carnet.http_get(parse_qs(parsed.query, keep_blank_values=True))
            self._json(code, payload)
            return True
        if raw == "/api/carnet/asset":
            code, payload = hq_carnet.http_asset_usage()
            self._json(code, payload)
            return True
        if raw.startswith("/api/carnet/asset/"):
            self._carnet_asset_get(raw[len("/api/carnet/asset/"):])
            return True
        if raw == "/api/carnet/voice":
            code, payload = hq_carnet.http_voice_usage()
            self._json(code, payload)
            return True
        if raw == "/api/carnet/transcribe":
            code, payload = hq_carnet.http_transcribe_status()
            self._json(code, payload)
            return True
        if raw.startswith("/api/carnet/voice/"):
            self._carnet_voice_get(raw[len("/api/carnet/voice/"):])
            return True
        if raw.startswith("/api/carnet/review-export/"):
            self._carnet_review_export(raw[len("/api/carnet/review-export/"):])
            return True
        if raw == "/api/carnet/reader-pdf":
            self._carnet_reader_pdf(parse_qs(parsed.query, keep_blank_values=True))
            return True
        return False

    def _carnet_reader_pdf(self, qs: dict) -> None:
        """Phase 9 r2: the frozen PDF whose seal matched, streamed from the very bytes that were hashed (a spool; the pathname is not
        reopened). Admin-only like every /api/carnet route; identities in, never a path; refused (409) if the file no longer matches."""
        code, name, got = hq_carnet.http_reader_pdf(qs)
        if code != 200:
            self._carnet_reader_pdf_refusal(code, got)
            return
        spool, size = got
        with spool:
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self._security_headers(frame_self=True)
            self.send_header("Content-Disposition", f"inline; filename=\"{name}\"; filename*=UTF-8''{quote(name)}")
            self.end_headers()
            while True:
                chunk = spool.read(CHUNK)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _carnet_review_export(self, review_id: str) -> None:
        """Phase 7: the deterministic review handoff package (ZIP of review.json, review.md, manifest.json). Admin-only like every
        /api/carnet route; read-only, no-cache, always a download (never rendered), nosniff."""
        code, name, data = hq_carnet.http_review_export(review_id)
        if code != 200:
            self._json(code, data)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.send_header("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def _carnet_reader_pdf_refusal(self, code: int, obj: dict) -> None:
        """Every refusal of THIS iframe route (its own, and the generic 401 / 403 gates) is a same-origin, no-store JSON body that the
        Reader can read inside its frame; a blocked frame would leave the sealed-match state standing. No file bytes, nothing sensitive."""
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers(frame_self=True)
        self.end_headers()
        self.wfile.write(body)

    def _carnet_asset_get(self, asset_id: str) -> None:
        """Stage 06: serve one confined Carnet image. Admin-only (the caller already enforced the role).
        Fixed Content-Type from the stored extension, nosniff, a locked-down CSP, never framed; private/no-cache + ETag."""
        media = hq_carnet.media
        try:
            handle, mime, size = media.open_asset(asset_id)
        except media.MediaError as e:
            self._json(e.status, {"error": str(e), "code": e.code})
            return
        except OSError:
            self._json(503, {"error": "Images inaccessibles", "code": "storage_error"})
            return
        etag = f'"{asset_id}"'  # assets are write-once: the id IS the version
        with handle:
            if (self.headers.get("If-None-Match") or "").strip() == etag and not self.headers.get("Range"):
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "private, no-cache")
                self.send_header("Content-Length", "0")
                self._security_headers()
                self.end_headers()
                return
            # Phase 4 (r3): ONE bounded byte range, only when the client asks for it (the field capture's existence probe asks for 1 byte).
            # A request without Range is byte-for-byte what it always was.
            start, end, status = 0, size - 1, 200
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", (self.headers.get("Range") or "").strip())
            if m and (m.group(1) or m.group(2)):
                if m.group(1) == "":
                    n = int(m.group(2))
                    start = max(0, size - n) if n > 0 else size
                else:
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self._security_headers()
                    self.end_headers()
                    return
                status = 206
            length = end - start + 1
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(length))
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", etag)
            # private + no-cache: the browser may keep the bytes but MUST revalidate (auth is checked on every
            # request; an unchanged image costs a 304). Keeps the editor from re-downloading on every re-render.
            self.send_header("Cache-Control", "private, no-cache")
            self.send_header("Content-Disposition", "inline")
            self._security_headers()
            self.send_header("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox; frame-ancestors 'none'")
            self.end_headers()
            handle.seek(start)
            sent = 0
            while sent < length:
                chunk = handle.read(min(CHUNK, length - sent))
                if not chunk:
                    break
                self.wfile.write(chunk)
                sent += len(chunk)

    def _carnet_voice_get(self, voice_id: str) -> None:
        """Phase 4: serve one confined voice note, with a single bounded byte range (an <audio> element needs it to seek).
        Admin-only (the caller already enforced the role). Fixed Content-Type from the stored extension, nosniff, locked-down CSP."""
        voice = hq_carnet.voice
        try:
            handle, mime, size = voice.open_voice(voice_id)
        except voice.VoiceError as e:
            self._json(e.status, {"error": str(e), "code": e.code})
            return
        except OSError:
            self._json(503, {"error": "Notes vocales inaccessibles", "code": "storage_error"})
            return
        etag = f'"{voice_id}"'
        with handle:
            if (self.headers.get("If-None-Match") or "").strip() == etag and not self.headers.get("Range"):
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "private, no-cache")
                self.send_header("Content-Length", "0")
                self._security_headers()
                self.end_headers()
                return
            start, end, status = 0, size - 1, 200
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", (self.headers.get("Range") or "").strip())
            if m and (m.group(1) or m.group(2)):
                if m.group(1) == "":
                    n = int(m.group(2))
                    start = max(0, size - n) if n > 0 else size
                else:
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self._security_headers()
                    self.end_headers()
                    return
                status = 206
            length = end - start + 1
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "private, no-cache")
            self.send_header("Content-Disposition", "inline")
            self._security_headers()
            self.send_header("Content-Security-Policy", "default-src 'none'; media-src 'self'; sandbox; frame-ancestors 'none'")
            self.end_headers()
            handle.seek(start)
            sent = 0
            while sent < length:
                chunk = handle.read(min(CHUNK, length - sent))
                if not chunk:
                    break
                self.wfile.write(chunk)
                sent += len(chunk)

    def _carnet_voice_post(self, voice_id: str | None) -> None:
        """Phase 4: raw-body voice upload (``voice_id`` None) or the optional transcription of one stored note."""
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._json(411, {"error": "Content-Length requis", "code": "bad_length"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        if voice_id is None:
            declared = (self.headers.get("X-Carnet-Mime") or "").strip().lower() or None
            code, payload = hq_carnet.http_voice_upload(self.rfile.read, length, declared)
        else:
            code, payload = hq_carnet.http_voice_transcribe(voice_id, self.rfile.read, length)
        if code != 200:
            self.close_connection = True  # the unread body must never be parsed as the next request
        self._json(code, payload)

    def _carnet_asset_post(self) -> None:
        """Stage 06: raw-body image upload (no JSON/base64, no client file name or path). Bounded by
        Content-Length BEFORE any read; the body is streamed to a generated temp file by hq_carnet_media."""
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._json(411, {"error": "Content-Length requis", "code": "bad_length"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        declared = (self.headers.get("X-Carnet-Mime") or "").strip().lower() or None
        # A stalled client is bounded by the handler's existing per-connection timeout (REQ_TIMEOUT_SEC, see setup()).
        code, payload = hq_carnet.http_asset_upload(self.rfile.read, length, declared)
        if code != 200:
            self.close_connection = True  # the unread body must never be parsed as the next request
        self._json(code, payload)

    def _hq_post(self, raw: str) -> bool:
        if self._forge_post(raw):
            return True
        if raw == "/api/home-layout":
            data = self._read_json()
            layout = hq_home.default() if data.get("reset") is True else data.get("layout")
            self._json(200, {"ok": True, "layout": hq_home.save(ROOT / "hq_home_layout.json", layout)})
            return True
        if self._drawings_post(raw):
            return True
        if raw == "/api/agent":
            data = self._read_json()
            code, payload = hq_companion.admin_post(data)
            self._json(code, payload)
            return True
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
                    confirm=data.get("confirm"),
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
        if raw == "/api/calendar":
            data = self._read_json()
            action = str(data.get("action") or "")
            try:
                if action == "save":
                    event = data.get("event") if isinstance(data.get("event"), dict) else {}
                    saved = hq_calendar.save_event(event, data.get("expected_rev"))
                    self._json(200, {"ok": True, "event": saved})
                elif action == "delete":
                    self._json(200, hq_calendar.delete_event(str(data.get("id") or ""), data.get("expected_rev")))
                else:
                    self._json(400, {"error": "action invalide"})
            except hq_calendar.CalendarError as e:
                self._json(400, {"error": str(e)})
            except hq_calendar.CalendarConflict as e:
                self._json(409, {"error": str(e)})
            return True
        if raw == "/api/calendar/run":
            data = self._read_json()
            try:
                self._json(
                    200,
                    hq_calendar.run_linked(str(data.get("id") or ""), str(data.get("target") or "")),
                )
            except hq_calendar.CalendarError as e:
                self._json(400, {"error": str(e)})
            except hq_calendar.CalendarConflict as e:
                self._json(409, {"error": str(e)})
            return True
        if raw == "/api/carnet/asset":
            self._carnet_asset_post()
            return True
        if raw == "/api/carnet/voice":
            self._carnet_voice_post(None)
            return True
        _vm = re.fullmatch(r"/api/carnet/voice/(voice-[0-9a-f]{24})/transcribe", raw)
        if _vm:
            self._carnet_voice_post(_vm.group(1))
            return True
        if raw == "/api/carnet":
            try:
                data = self._read_json()
            except ValueError as e:
                self._json(400, {"error": str(e)[:200], "code": "validation_error"})
                return True
            code, payload = hq_carnet.http_post(data)
            self._json(code, payload)
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
            rid = _diag_record_exc(self, e)
            sys.stderr.write(f"GET error {hq_diagnostics.path_category(self.path)} #{rid}: {type(e).__name__}: {hq_diagnostics.scrub(e, ROOT)}\n")
            try:
                if self.path.startswith("/api/"):
                    self._json(500, {"error": hq_diagnostics.scrub(str(e), ROOT, 300), "request_id": rid})
                else:
                    self._send(500, b"Internal error")
            except Exception:
                pass

    def _do_GET(self) -> None:
        parsed = urlparse(self.path)
        raw = parsed.path
        ensure_hq()

        if raw == "/local-agent" or raw.startswith("/local-agent/"):
            self._json(404, {"error": "Inconnu"})
            return

        if raw.startswith("/agent/v1/") or raw.startswith("/forge-worker/v1/"):
            self._json(405, {"error": "POST requis"})
            return

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
                ctype = ASSET_CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
                # Phase 4: ONLY the vendored OCR worker script is allowed to compile WebAssembly (its own response CSP);
                # the page and every other response keep the unchanged policy.
                self._wasm_ok = name == "vendor-tesseract-worker.min.js"
                try:
                    self._send(200, path.read_bytes(), ctype)
                finally:
                    self._wasm_ok = False
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
            if raw == "/api/carnet/reader-pdf":
                self._carnet_reader_pdf_refusal(401, {"error": "PIN requis"})  # frame-readable: the Reader shows the access state
                return
            if raw.startswith(("/api/", "/files/", "/download/", "/media/")):
                self._json(401, {"error": "PIN requis"})
                return
            self._send(200, render_login())
            return

        if not self._guard_admin_path(raw):
            return

        if self._diag_get(raw, parsed):
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

        if raw == "/api/media/library":
            self._json(200, media_library())
            return

        if raw.startswith("/media/"):
            # Same confinement as /files/ (resolve_rel under ROOT/{Inbox|Uni|Print}); cookie session only.
            path = safe_rel_path(raw[len("/media/") :])
            if not path:
                self._json(404, {"error": "Fichier introuvable"})
                return
            if path.suffix.lower() not in MEDIA_CONTENT_TYPES:
                self._json(415, {"error": "Format non lisible dans le lecteur"})
                return
            self._send_media(path)
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
            rid = _diag_record_exc(self, e)
            sys.stderr.write(f"POST error {hq_diagnostics.path_category(self.path)} #{rid}: {type(e).__name__}: {hq_diagnostics.scrub(e, ROOT)}\n")
            try:
                self._json(500, {"error": hq_diagnostics.scrub(str(e), ROOT, 300), "request_id": rid})
            except Exception:
                pass

    def _do_POST(self) -> None:
        raw = urlparse(self.path).path
        ensure_hq()

        if raw == "/local-agent" or raw.startswith("/local-agent/"):
            self._json(404, {"error": "Inconnu"})
            return

        if raw.startswith("/forge-worker/v1/"):
            # Forge generation workers: no browser session and no CSRF (no cookie is read), HMAC on every route
            # except the one-time-code enrollment. The body is never logged.
            self._forge_worker(raw)
            return

        # Pre-body refusals below (CSRF 403, anonymous 401, upload-role 403) drain a small body (_drain_refused_body).
        self._prebody_refusal = True
        try:
            # CSRF for cookie sessions + /login (same-origin form). No Bearer exception today.
            if not self._check_csrf():
                return
        finally:
            self._prebody_refusal = False

        if raw.startswith("/agent/v1/"):
            self._agent_v1()
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

        self._prebody_refusal = True
        try:
            if not self._auth():
                self._json(401, {"error": "PIN requis"})
                return

            # upload role: explicit allowlist only
            if self._role() != "admin" and not self._upload_allowed("POST", raw):
                self._json(403, {"error": "Réservé admin"})
                return
        finally:
            self._prebody_refusal = False

        if self._diag_post(raw):
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
    hq_forge_fleet.bind(ROOT)  # resumes queued multi-device tasks; dispatched ones become uncertain
    # Resume the backup schedule from the catalog: a restart within backup_every_hours
    # of the last backup (same backup_dir) makes no new backup. Reads the index only.
    _seed = cc_ext.seed_last_backup_from_index()
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
        try:
            hq_calendar.tick()
        except Exception as e:
            sys.stderr.write(f"calendar tick: {e}\n")

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
        server = HQServer((BIND_HOST, PORT), Handler)
    except OSError as e:
        raise SystemExit(f"Cannot bind {BIND_HOST}:{PORT}: {e}") from e
    # Mild DoS mitigation for stdlib server
    server.timeout = 30
    try:
        planner_port = int(CONFIG.get("planner_port") or hq_planner.DEFAULT_PORT)
    except (TypeError, ValueError):
        planner_port = hq_planner.DEFAULT_PORT
    planner_httpd = None
    try:
        planner_httpd = hq_planner.start(ROOT, port=planner_port)
    except (RuntimeError, OSError) as exc:
        server.server_close()
        raise SystemExit(f"FATAL: planner loopback refused ({exc})") from exc
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
    print(f" Planner: http://127.0.0.1:{planner_httpd.server_address[1]}/ (loopback only, not Tailscale)")
    print(f" Max up : {human_size(max_upload_bytes())}")
    print(f" Backup : every {CONFIG.get('backup_every_hours')}h -> {CONFIG.get('backup_dir')}")
    _bk = cc_ext.backup_target_status()
    if _bk.get("auto_paused"):
        print(" Backup : PAUSE (backup_auto_paused) — aucun backup automatique ; manuel via POST /api/backup")
    if not _bk.get("ok"):
        print(f" Backup : ATTENTION {_bk.get('error')}")
    _ret = _bk.get("retention") or {}
    if _ret.get("enabled"):
        print(f" Backup : rétention {_ret.get('keep_days')} j, {_ret.get('keep_min')} plus récents toujours gardés (purge après chaque backup réussi)")
    else:
        print(" Backup : rétention désactivée (backup_keep_days <= 0) — aucune purge")
    if _seed.get("seeded"):
        print(f" Backup : dernier backup {datetime.fromtimestamp(_seed['at']).strftime('%Y-%m-%d %H:%M')} — pas de backup au démarrage avant {CONFIG.get('backup_every_hours')}h")
    else:
        print(f" Backup : backup automatique au démarrage ({_seed.get('reason')})")
    print(" Ctrl+C to stop")
    print("=" * 56)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        if planner_httpd is not None:
            planner_httpd.shutdown()
            planner_httpd.server_close()
        try:
            PID_PATH.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    try:
        main()
    except SystemExit as _fatal:
        if isinstance(_fatal.code, str):  # config / bind aborts: leave one scrubbed line a human can find
            hq_diagnostics.record_startup_fatal(ROOT, _fatal.code)
        raise
