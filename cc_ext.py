"""Command Center extensions for Transfert HQ (alerts, queue, scratchpad, send, health)."""

from __future__ import annotations

import ipaddress
import json
import re
import shutil
import socket
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

ACTIVITY_MAX = 80
ALERT_MAX = 40
INBOX_MAX = 30
QUEUE_PATH_NAME = "bridge_queue.json"
SCRATCHPAD_NAME = "scratchpad.txt"
TRANSFERS_PATH_NAME = "bridge_transfers.json"
ACTIVITY_PATH_NAME = "bridge_activity.json"

_lock = threading.Lock()
_activity: list[dict] = []
_alerts: list[dict] = []
_inbox: dict[str, list[dict]] = {}
_seen_presence: dict[str, dict] = {}
_disk_alerted = False
_monitor_started = False
_disk_cache: dict[str, dict] = {}  # peer id -> {disks, error, at, os}
_disk_cache_lock = threading.Lock()
_last_disk_probe = 0.0

# Fixed allowlisted remote probes (not user-supplied).
_DISK_CMD_WIN = (
    "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | "
    "Select-Object @{n='name';e={$_.DeviceID}},"
    "@{n='free';e={[int64]$_.FreeSpace}},"
    "@{n='total';e={[int64]$_.Size}} | ConvertTo-Json -Compress"
)
_DISK_CMD_UNIX = (
    "df -B1 -P 2>/dev/null | awk 'NR>1 && $1 !~ /^(tmpfs|devtmpfs|overlay|squashfs)$/ "
    "{printf \"%s %s %s\\n\", $6, $4, $2}'"
)

# injected by bridge
ROOT: Path | None = None
human_size: Callable[[int], str] | None = None
notify_discord: Callable[[str, str], None] | None = None
disk_free: Callable[[Path], dict] | None = None
get_config: Callable[[], dict] | None = None
pc_run_action: Callable[[str], dict] | None = None
pc_explore: Callable[[str], None] | None = None


def bind(**kwargs: Any) -> None:
    global ROOT, human_size, notify_discord, disk_free, get_config, pc_run_action, pc_explore
    ROOT = kwargs.get("ROOT", ROOT)
    human_size = kwargs.get("human_size", human_size)
    notify_discord = kwargs.get("notify_discord", notify_discord)
    disk_free = kwargs.get("disk_free", disk_free)
    get_config = kwargs.get("get_config", get_config)
    pc_run_action = kwargs.get("pc_run_action", pc_run_action)
    pc_explore = kwargs.get("pc_explore", pc_explore)


def _cfg() -> dict:
    return get_config() if get_config else {}


def _root() -> Path:
    assert ROOT is not None
    return ROOT


def classify_ip(ip: str) -> str:
    try:
        addr = ipaddress.ip_address(ip.split("%")[0])
    except ValueError:
        return "unknown"
    if addr.is_loopback:
        return "local"
    # Tailscale CGNAT
    if ipaddress.ip_address("100.64.0.0") <= addr <= ipaddress.ip_address("100.127.255.255"):
        return "tailscale"
    if addr.is_private:
        return "lan"
    return "wan"


def default_scenes() -> list[dict]:
    r = str(_root()) if ROOT else "D:\\Transfert"
    return [
        {
            "id": "study",
            "label": "Mode étude",
            "steps": [{"type": "explore", "path": f"{r}\\Uni"}],
        },
        {
            "id": "print-job",
            "label": "Job impression",
            "steps": [{"type": "explore", "path": f"{r}\\Print"}],
        },
        {
            "id": "backup-now",
            "label": "Ouvrir Inbox (backup)",
            "steps": [{"type": "explore", "path": f"{r}\\Inbox"}],
        },
    ]


def log_activity(kind: str, message: str, **extra: Any) -> None:
    entry = {
        "id": f"{int(time.time()*1000)}-{kind}",
        "kind": kind,
        "message": message[:240],
        "at": time.time(),
        "at_h": datetime.now().strftime("%H:%M:%S"),
        **{k: v for k, v in extra.items() if v is not None},
    }
    with _lock:
        _activity.insert(0, entry)
        del _activity[ACTIVITY_MAX:]
        _persist_activity()
    if kind in ("upload", "lock", "screenshot", "print", "action", "scene", "send", "alert"):
        pass


def _persist_activity() -> None:
    try:
        path = _root() / ACTIVITY_PATH_NAME
        path.write_text(json.dumps(_activity[:ACTIVITY_MAX], indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass


def load_activity() -> None:
    global _activity
    path = _root() / ACTIVITY_PATH_NAME
    if not path.is_file():
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            _activity = data[:ACTIVITY_MAX]
    except (OSError, json.JSONDecodeError):
        pass


def activity_list(limit: int | None = None, offset: int = 0) -> list[dict]:
    with _lock:
        items = list(_activity)
    if offset:
        items = items[offset:]
    if limit is not None:
        items = items[: max(0, int(limit))]
    return items


def push_alert(title: str, detail: str, *, discord: bool = True) -> None:
    entry = {
        "id": f"a-{int(time.time()*1000)}",
        "title": title[:120],
        "detail": detail[:400],
        "at": time.time(),
        "at_h": datetime.now().strftime("%H:%M:%S"),
    }
    with _lock:
        _alerts.insert(0, entry)
        del _alerts[ALERT_MAX:]
    log_activity("alert", f"{title}: {detail}")
    if discord and notify_discord:
        notify_discord(title, detail)


def alerts_list() -> list[dict]:
    with _lock:
        return list(_alerts)


def note_presence_snapshot(devices: list[dict]) -> None:
    """Track browser devices for offline alerts."""
    global _seen_presence
    now = time.time()
    browser = {d["id"]: d for d in devices if d.get("source") == "browser" and d.get("id")}
    with _lock:
        # offline?
        for pid, prev in list(_seen_presence.items()):
            if pid not in browser and now - prev.get("last_seen", 0) < 600:
                name = prev.get("name") or pid
                push_alert("Appareil hors ligne", f"**{name}** ne répond plus")
                _seen_presence.pop(pid, None)
        for pid, d in browser.items():
            _seen_presence[pid] = {
                "name": d.get("name"),
                "last_seen": d.get("last_seen") or now,
            }


def check_disk_alert() -> None:
    global _disk_alerted
    if not disk_free or not human_size:
        return
    try:
        min_gb = float((_cfg() or {}).get("alert_disk_min_gb") or 20)
    except (TypeError, ValueError):
        min_gb = 20
    info = disk_free(Path("D:/"))
    free = info.get("free") or 0
    if free and free < min_gb * 1024**3:
        if not _disk_alerted:
            _disk_alerted = True
            push_alert("Espace disque bas", f"D: libre: **{human_size(int(free))}** (seuil {min_gb} Go)")
    else:
        _disk_alerted = False


def start_monitor(
    get_devices: Callable[[], list[dict]],
    process_queue: Callable[[], None],
    probe_disks: Callable[[], None] | None = None,
    harvest_shots: Callable[[], None] | None = None,
) -> None:
    global _monitor_started
    if _monitor_started:
        return
    _monitor_started = True

    def loop() -> None:
        while True:
            try:
                check_disk_alert()
                devices = get_devices()
                note_presence_snapshot(devices)
                try:
                    record_presence_snapshot(devices)
                except Exception:
                    pass
                process_queue()
                maybe_backup()
                if harvest_shots:
                    try:
                        harvest_shots()
                    except Exception as e:
                        try:
                            __import__("sys").stderr.write(f"shot harvest: {e}\n")
                        except Exception:
                            pass
                if probe_disks:
                    try:
                        probe_disks()
                    except Exception as e:
                        try:
                            __import__("sys").stderr.write(f"disk probe: {e}\n")
                        except Exception:
                            pass
            except Exception as e:
                try:
                    sys_stderr = __import__("sys").stderr
                    sys_stderr.write(f"cc monitor: {e}\n")
                except Exception:
                    pass
            time.sleep(20)

    threading.Thread(target=loop, daemon=True).start()


# ---- screenshot harvest -> Inbox/Captures ----

INGEST_NAME = "bridge_screenshot_ingest.json"
_last_shot_harvest = 0.0
_SHOT_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".bmp"}


def captures_path() -> Path:
    d = _root() / "Inbox" / "Captures"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _ingest_state_path() -> Path:
    return _root() / INGEST_NAME


def _load_ingest() -> dict:
    path = _ingest_state_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_ingest(state: dict) -> None:
    try:
        items = list(state.items())
        if len(items) > 2000:
            state = dict(items[-2000:])
        _ingest_state_path().write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass


def local_screenshot_dirs() -> list[Path]:
    home = Path.home()
    cand: list[Path] = [
        home / "Pictures" / "Screenshots",
        home / "Pictures" / "Captures d'écran",
        home / "Pictures" / "Captures d'ecran",
        home / "Images" / "Screenshots",
        home / "Images" / "Captures d'écran",
        home / "OneDrive" / "Pictures" / "Screenshots",
        home / "OneDrive" / "Pictures" / "Captures d'écran",
        home / "OneDrive" / "Images" / "Captures d'écran",
    ]
    try:
        import ctypes
        from ctypes import wintypes

        # CSIDL_MYPICTURES = 39
        buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 39, None, 0, buf) == 0 and buf.value:
            base = Path(buf.value)
            cand.extend(
                [
                    base / "Screenshots",
                    base / "Captures d'écran",
                    base / "Captures d'ecran",
                ]
            )
    except Exception:
        pass
    try:
        for p in home.glob("OneDrive*/Pictures/Screenshots"):
            cand.append(p)
        for p in home.glob("OneDrive*/Pictures/Captures*"):
            cand.append(p)
        for p in home.glob("OneDrive*/Images/Screenshots"):
            cand.append(p)
        for p in home.glob("OneDrive*/Images/Captures*"):
            cand.append(p)
    except OSError:
        pass
    out: list[Path] = []
    seen: set[str] = set()
    for c in cand:
        try:
            if c.is_dir():
                key = str(c.resolve())
                if key not in seen:
                    seen.add(key)
                    out.append(c)
        except OSError:
            continue
    return out


def _shot_max_age_sec() -> float:
    try:
        return float((_cfg() or {}).get("screenshot_ingest_max_age_sec") or 90)
    except (TypeError, ValueError):
        return 90.0


def _copy_shot_in(src: Path, *, prefix: str, state: dict, min_mtime: float | None = None) -> bool:
    try:
        st = src.stat()
    except OSError:
        return False
    if src.suffix.lower() not in _SHOT_EXTS:
        return False
    if min_mtime is not None and st.st_mtime < min_mtime:
        return False
    key = f"{prefix}|{src.name}|{st.st_size}|{int(st.st_mtime)}"
    if key in state:
        return False
    dest_dir = captures_path()
    safe = re.sub(r"[^\w.\- ()\[\]]+", "_", src.name, flags=re.UNICODE).strip() or "capture.png"
    tagged = f"{prefix}_{safe}" if prefix and prefix != "local" else safe
    dest = dest_dir / tagged
    if dest.exists():
        dest = dest_dir / f"{dest.stem}_{int(st.st_mtime)}{dest.suffix}"
    try:
        shutil.copy2(src, dest)
    except OSError:
        return False
    rel = "/".join(dest.relative_to(_root()).parts)
    state[key] = {"at": time.time(), "rel": rel}
    log_activity("screenshot", f"Capture locale · {dest.name}", rel=rel)
    if notify_discord:
        notify_discord("Nouvelle capture", f"`{rel}`")
    return True


def harvest_local_screenshots(state: dict) -> int:
    n = 0
    min_mtime = time.time() - _shot_max_age_sec()
    for folder in local_screenshot_dirs():
        try:
            for p in folder.iterdir():
                if p.is_file() and _copy_shot_in(p, prefix="local", state=state, min_mtime=min_mtime):
                    n += 1
        except OSError:
            continue
    return n


def harvest_remote_screenshots(peers: list[dict], state: dict) -> int:
    import base64

    cfg = _cfg()
    user = str(cfg.get("ssh_user") or "").strip()
    if not user:
        return 0
    key = Path.home() / ".ssh" / "id_ed25519"
    max_age = int(_shot_max_age_sec())
    # Stage under %TEMP% with ASCII names so scp never sees accents (FR OneDrive paths).
    # Only brand-new shots (LastWriteTime within max_age seconds).
    ps = rf"""
$ErrorActionPreference='SilentlyContinue'
$maxAge = {max_age}
$cutoff = (Get-Date).ToUniversalTime().AddSeconds(-$maxAge)
$stage = Join-Path $env:TEMP 'transfert_captures'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Get-ChildItem -LiteralPath $stage -File -ErrorAction SilentlyContinue |
  Where-Object {{ $_.LastWriteTimeUtc -lt (Get-Date).ToUniversalTime().AddHours(-6) }} |
  Remove-Item -Force -ErrorAction SilentlyContinue

$dirs = New-Object System.Collections.Generic.List[string]
$bases = New-Object System.Collections.Generic.List[string]
$myPics = [Environment]::GetFolderPath('MyPictures')
if ($myPics) {{ [void]$bases.Add($myPics) }}
foreach ($extra in @(
  (Join-Path $env:USERPROFILE 'Pictures'),
  (Join-Path $env:USERPROFILE 'Images')
)) {{
  if ($extra) {{ [void]$bases.Add($extra) }}
}}
Get-ChildItem -Path (Join-Path $env:USERPROFILE 'OneDrive*') -Directory -ErrorAction SilentlyContinue |
  ForEach-Object {{
    foreach ($leaf in @('Pictures','Images')) {{
      $p = Join-Path $_.FullName $leaf
      if (Test-Path -LiteralPath $p) {{ [void]$bases.Add($p) }}
    }}
  }}
$bases = @($bases | Where-Object {{ $_ -and (Test-Path -LiteralPath $_) }} | Select-Object -Unique)
foreach ($base in $bases) {{
  Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
    Where-Object {{ $_.Name -match 'Screenshot|Capture|Screen' }} |
    ForEach-Object {{ [void]$dirs.Add($_.FullName) }}
}}
$dirs = @($dirs | Select-Object -Unique)
if ($dirs.Count -eq 0) {{ exit 0 }}

Get-ChildItem -LiteralPath $dirs -File -ErrorAction SilentlyContinue |
  Where-Object {{
    $_.Extension -match '\.(png|jpg|jpeg|webp|gif|bmp)$' -and
    $_.LastWriteTimeUtc -ge $cutoff
  }} |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 12 |
  ForEach-Object {{
    $hash = [System.BitConverter]::ToString(
      [System.Security.Cryptography.SHA1]::Create().ComputeHash(
        [System.Text.Encoding]::UTF8.GetBytes($_.FullName)
      )
    ).Replace('-','').Substring(0,16).ToLower()
    $staged = Join-Path $stage ($hash + $_.Extension.ToLower())
    Copy-Item -LiteralPath $_.FullName -Destination $staged -Force
    $safeName = ($_.BaseName -replace '[^\w.\- ]','_') + $_.Extension.ToLower()
    if ([string]::IsNullOrWhiteSpace($safeName)) {{ $safeName = $hash + $_.Extension.ToLower() }}
    '{{0}}|{{1}}|{{2:o}}|{{3}}|{{4}}' -f $safeName, $_.Length, $_.LastWriteTimeUtc, $staged.Replace('\','/'), $hash
  }}
"""
    enc = base64.b64encode(ps.encode("utf-16le")).decode("ascii")
    remote_cmd = f"powershell -NoProfile -NonInteractive -EncodedCommand {enc}"

    n = 0
    for peer in peers:
        if not isinstance(peer, dict) or not peer.get("online"):
            continue
        os_name = str(peer.get("os") or "").lower()
        if any(x in os_name for x in ("ios", "android", "mac", "darwin", "linux")):
            continue
        host = str(peer.get("ip") or "").strip()
        if not host:
            continue
        short = str(peer.get("name") or host).split(".")[0]
        target = {"id": f"shot-{short}", "label": short, "type": "ssh", "host": host, "user": user}
        try:
            info = run_shell(target=target, shell="raw", command=remote_cmd, timeout=45, quiet=True)
        except Exception:
            continue
        lines = [ln.strip() for ln in (info.get("stdout") or "").splitlines() if ln.count("|") >= 4]
        for ln in lines:
            parts = ln.split("|", 4)
            if len(parts) != 5:
                continue
            name, size_s, mtime_s, staged, file_hash = parts
            if "transfert_captures" not in staged.replace("\\", "/"):
                continue
            key_id = f"{short}|{file_hash}|{size_s}|{mtime_s}"
            if key_id in state:
                continue
            dest_dir = captures_path()
            safe = re.sub(r"[^\w.\- ()\[\]]+", "_", name, flags=re.UNICODE).strip() or f"{file_hash}.png"
            dest = dest_dir / f"{short}_{safe}"
            if dest.exists():
                dest = dest_dir / f"{short}_{file_hash}_{safe}"
            remote_spec = f"{user}@{host}:{staged}"
            argv = [
                "scp", "-F", "NUL",
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=10",
                "-o", "StrictHostKeyChecking=accept-new",
                "-o", "IdentitiesOnly=yes",
            ]
            if key.is_file():
                argv += ["-i", str(key)]
            argv += [remote_spec, str(dest)]
            try:
                r = subprocess.run(argv, capture_output=True, text=True, timeout=90, check=False)
            except (OSError, subprocess.TimeoutExpired):
                continue
            if r.returncode != 0 or not dest.is_file():
                continue
            rel = "/".join(dest.relative_to(_root()).parts)
            state[key_id] = {"at": time.time(), "rel": rel}
            log_activity("screenshot", f"Capture distante · {dest.name}", rel=rel)
            n += 1
            if notify_discord:
                notify_discord("Capture distante", f"**{short}** → `{rel}`")
    return n


def harvest_screenshots(peers_fn=None, *, force: bool = False) -> dict:
    global _last_shot_harvest
    cfg = _cfg()
    if cfg.get("screenshot_ingest_enabled", True) is False:
        return {"ok": True, "skipped": True}
    every = float(cfg.get("screenshot_ingest_every_sec") or 5)
    now = time.time()
    if not force and _last_shot_harvest and (now - _last_shot_harvest) < every:
        return {"ok": True, "skipped": True}
    _last_shot_harvest = now
    state = _load_ingest()
    local_n = harvest_local_screenshots(state)
    remote_n = 0
    peers = []
    if callable(peers_fn):
        try:
            peers = peers_fn() or []
        except Exception:
            peers = []
    try:
        remote_n = harvest_remote_screenshots(peers, state)
    except Exception as e:
        try:
            __import__("sys").stderr.write(f"remote shot harvest: {e}\n")
        except Exception:
            pass
    _save_ingest(state)
    return {"ok": True, "local": local_n, "remote": remote_n, "captures": "Inbox/Captures"}


def _normalize_disks(raw: list[dict]) -> list[dict]:
    out: list[dict] = []
    for d in raw:
        if not isinstance(d, dict):
            continue
        try:
            free = int(d.get("free") or 0)
            total = int(d.get("total") or 0)
        except (TypeError, ValueError):
            continue
        if total <= 0 or free < 0:
            continue
        name = str(d.get("name") or "?").strip() or "?"
        if len(name) > 24:
            name = name[:24]
        entry = {
            "name": name,
            "free": free,
            "total": total,
            "pct_used": round(100 * (total - free) / total, 1) if total else 0,
        }
        if human_size:
            entry["free_h"] = human_size(free)
            entry["total_h"] = human_size(total)
        out.append(entry)
    # Prefer fixed drives first, cap list
    out.sort(key=lambda x: (0 if len(x["name"]) <= 3 else 1, x["name"]))
    return out[:8]


def _parse_win_disk_json(text: str) -> list[dict]:
    text = (text or "").strip()
    if not text:
        return []
    # PowerShell may emit a single object or an array; also noise before/after.
    start = text.find("[")
    start_obj = text.find("{")
    if start == -1 or (start_obj != -1 and start_obj < start):
        start = start_obj
    if start == -1:
        return []
    chunk = text[start:]
    # trim trailing junk after JSON
    for end_ch, open_ch in (("]", "["), ("}", "{")):
        if chunk.startswith(open_ch):
            depth = 0
            for i, c in enumerate(chunk):
                if c == open_ch:
                    depth += 1
                elif c == end_ch:
                    depth -= 1
                    if depth == 0:
                        chunk = chunk[: i + 1]
                        break
            break
    data = json.loads(chunk)
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return []
    return _normalize_disks(data)


def _parse_unix_df(text: str) -> list[dict]:
    rows: list[dict] = []
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        mount, avail_s, size_s = parts[0], parts[1], parts[2]
        try:
            free = int(avail_s)
            total = int(size_s)
        except ValueError:
            continue
        rows.append({"name": mount, "free": free, "total": total})
    return _normalize_disks(rows)


def apply_disk_cache(device: dict) -> None:
    """Mutate a roster device with cached remote disk info if present."""
    key = str(device.get("id") or "")
    ip = str(device.get("ip") or "")
    with _disk_cache_lock:
        cached = _disk_cache.get(key) or (_disk_cache.get(ip) if ip else None)
        if not cached:
            return
        cached = dict(cached)
    if cached.get("disks"):
        device["disks"] = cached["disks"]
        primary = cached["disks"][0]
        device["free"] = primary.get("free")
        device["total"] = primary.get("total")
        device["free_h"] = primary.get("free_h")
        device["total_h"] = primary.get("total_h")
        device.pop("disk_error", None)
    elif cached.get("error"):
        device["disk_error"] = str(cached["error"])[:80]


def _peer_probeable(peer: dict) -> bool:
    if not peer.get("online"):
        return False
    os_name = str(peer.get("os") or "").lower()
    if os_name in ("ios", "android", "tvos", "watchos"):
        return False
    if not (peer.get("ip") or peer.get("name")):
        return False
    return True


def _probe_one_peer(peer: dict) -> None:
    pid = str(peer.get("id") or peer.get("ip") or "")
    if not pid:
        return
    os_name = str(peer.get("os") or "").lower()
    host = str(peer.get("ip") or "").strip()
    if not host:
        host = str(peer.get("name") or "").split(".")[0]
    cfg = _cfg()
    user = str(cfg.get("ssh_user") or "").strip()
    timeout = int(cfg.get("disk_probe_timeout_sec") or 12)
    is_win = "windows" in os_name or os_name in ("win", "win32")
    is_unix = any(x in os_name for x in ("linux", "mac", "darwin", "freebsd", "ubuntu", "debian"))
    if not is_win and not is_unix:
        is_win = True

    target = {
        "id": f"disk-{pid}",
        "label": peer.get("name") or host,
        # Windows: OpenSSH over Tailscale IP (Tailscale SSH server is not supported on Windows).
        # Linux/macOS: Tailscale SSH when available.
        "type": "ssh" if is_win else "tailscale-ssh",
        "host": host,
        "user": user,
    }
    try:
        if is_win:
            info = run_shell(
                target=target,
                shell="powershell",
                command=_DISK_CMD_WIN,
                timeout=timeout,
                quiet=True,
            )
            disks = _parse_win_disk_json(info.get("stdout") or "")
        else:
            info = run_shell(
                target=target,
                shell="raw",
                command=_DISK_CMD_UNIX,
                timeout=timeout,
                quiet=True,
            )
            disks = _parse_unix_df(info.get("stdout") or "")
        if not disks:
            err_bits = (info.get("stderr") or info.get("stdout") or f"exit {info.get('code')}")[:120]
            raise RuntimeError(err_bits.strip() or "SSH disk probe failed")
        with _disk_cache_lock:
            entry = {"disks": disks, "at": time.time(), "os": os_name}
            _disk_cache[pid] = entry
            if peer.get("ip"):
                _disk_cache[str(peer["ip"])] = entry
    except Exception as e:
        err = str(e)[:120]
        low = err.lower()
        if "unexpected htt" in low or "tailscale ssh" in low:
            err = "OpenSSH Server requis (Tailscale SSH = Linux only)"
        elif "connection refused" in low or "actively refused" in low:
            err = "OpenSSH Server off — active-le sur ce PC"
        elif "timed out" in low or "timeout" in low or "connection timed out" in low:
            err = "SSH timeout"
        elif "permission denied" in low:
            err = "SSH refusé (clé/user) — vois ssh_user"
        elif "could not resolve" in low or "no route" in low:
            err = "Hôte injoignable via Tailscale"
        err = err[:80]
        with _disk_cache_lock:
            prev = _disk_cache.get(pid) or {}
            if prev.get("disks"):
                kept = dict(prev)
                kept["error"] = err
                kept["at"] = time.time()
                _disk_cache[pid] = kept
            else:
                entry = {"error": err, "at": time.time(), "os": os_name, "disks": []}
                _disk_cache[pid] = entry
                if peer.get("ip"):
                    _disk_cache[str(peer["ip"])] = entry


def refresh_remote_disks(peers: list[dict]) -> None:
    """Background: SSH probe online Windows/Linux Tailscale peers for free space."""
    global _last_disk_probe
    cfg = _cfg()
    if not cfg.get("disk_probe_enabled", True):
        return
    every = float(cfg.get("disk_probe_every_sec") or 120)
    now = time.time()
    if _last_disk_probe and (now - _last_disk_probe) < every:
        return
    _last_disk_probe = now
    candidates = [p for p in peers if isinstance(p, dict) and _peer_probeable(p)]
    # Cap concurrent work — sequential to avoid hammering Tailscale SSH
    for peer in candidates[:8]:
        try:
            _probe_one_peer(peer)
        except Exception:
            pass
        time.sleep(0.3)


# ---- health / media sections continue below in original file order ----


# ---- scratchpad ----

def scratchpad_path() -> Path:
    return _root() / SCRATCHPAD_NAME


def scratchpad_get() -> dict:
    path = scratchpad_path()
    text = ""
    mtime = 0.0
    if path.is_file():
        try:
            text = path.read_text(encoding="utf-8")
            mtime = path.stat().st_mtime
        except OSError:
            pass
    return {"text": text, "mtime": mtime}


def scratchpad_set(text: str) -> dict:
    path = scratchpad_path()
    path.write_text(text, encoding="utf-8")
    log_activity("scratchpad", "Bloc-notes partagé mis à jour")
    return scratchpad_get()


# ---- send / inbox ----

def inbox_push(to_id: str, item: dict) -> None:
    with _lock:
        bucket = _inbox.setdefault(to_id, [])
        bucket.insert(0, item)
        del bucket[INBOX_MAX:]


def inbox_get(device_id: str, *, clear: bool = False) -> list[dict]:
    with _lock:
        items = list(_inbox.get(device_id) or [])
        if clear:
            _inbox[device_id] = []
        return items


def send_to_device(*, to_id: str, rel: str, from_name: str, from_id: str = "") -> dict:
    item = {
        "id": f"s-{int(time.time()*1000)}",
        "rel": rel,
        "from": from_name,
        "from_id": from_id,
        "at": time.time(),
        "at_h": datetime.now().strftime("%H:%M:%S"),
    }
    if to_id == "all":
        # fan-out later by caller with device list
        return item
    inbox_push(to_id, item)
    log_activity("send", f"{from_name} → {to_id}: {rel}", rel=rel)
    if notify_discord:
        notify_discord("Envoi inter-appareils", f"**{from_name}** → `{to_id}`\n`{rel}`")
    return item


# ---- queue (run when PC / bridge awake) ----

def queue_path() -> Path:
    return _root() / QUEUE_PATH_NAME


def queue_load() -> list[dict]:
    path = queue_path()
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def queue_save(items: list[dict]) -> None:
    queue_path().write_text(json.dumps(items, indent=2) + "\n", encoding="utf-8")


def queue_add(job: dict) -> dict:
    items = queue_load()
    job = {
        "id": job.get("id") or f"q-{int(time.time()*1000)}",
        "label": str(job.get("label") or "Tâche")[:80],
        "when": str(job.get("when") or "online"),
        "type": str(job.get("type") or "explore"),
        "path": job.get("path"),
        "action_id": job.get("action_id"),
        "scene_id": job.get("scene_id"),
        "created": time.time(),
        "status": "pending",
    }
    items.insert(0, job)
    queue_save(items[:50])
    log_activity("queue", f"Au réveil: {job['label']}")
    return job


def queue_list() -> list[dict]:
    return queue_load()


def queue_process() -> list[dict]:
    """Run pending online jobs (bridge is up = PC awake enough)."""
    items = queue_load()
    changed = False
    done = []
    for job in items:
        if job.get("status") != "pending":
            continue
        if job.get("when") not in ("online", "wake", "now"):
            continue
        try:
            _run_job(job)
            job["status"] = "done"
            job["finished"] = time.time()
            done.append(job)
            log_activity("queue", f"Au réveil exécuté: {job.get('label')}")
        except Exception as e:
            job["status"] = "error"
            job["error"] = str(e)[:200]
            if notify_discord:
                notify_discord("Au réveil — échec", f"{job.get('label')}: {e}")
        changed = True
    if changed:
        queue_save(items)
    return done


def _run_job(job: dict) -> None:
    typ = job.get("type")
    if typ == "explore" and pc_explore and job.get("path"):
        pc_explore(str(job["path"]))
    elif typ == "action" and pc_run_action and job.get("action_id"):
        pc_run_action(str(job["action_id"]))
    elif typ == "scene":
        run_scene(str(job.get("scene_id") or ""))
    else:
        raise ValueError("Job invalide")


def run_scene(scene_id: str) -> dict:
    scenes = _cfg().get("scenes") or default_scenes()
    scene = next((s for s in scenes if isinstance(s, dict) and s.get("id") == scene_id), None)
    if not scene:
        raise ValueError("Scène inconnue")
    for step in scene.get("steps") or []:
        if not isinstance(step, dict):
            continue
        st = step.get("type")
        if st == "explore" and pc_explore:
            pc_explore(str(step.get("path") or _root()))
        elif st == "action" and pc_run_action:
            pc_run_action(str(step.get("id") or step.get("action_id") or ""))
        time.sleep(0.3)
    log_activity("scene", f"Scène: {scene.get('label') or scene_id}")
    if notify_discord:
        notify_discord("Scène", f"**{scene.get('label') or scene_id}**")
    return {"ok": True, "id": scene_id}


# ---- media strip ----

def recent_media(limit: int = 16) -> list[dict]:
    folders = [
        _root() / "Inbox" / "Captures",
        _root() / "Inbox" / "Screenshots",
        _root() / "Inbox" / "Photos",
    ]
    exts = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic"}
    items: list[dict] = []
    for folder in folders:
        if not folder.is_dir():
            continue
        for p in folder.iterdir():
            if p.is_file() and p.suffix.lower() in exts:
                st = p.stat()
                rel = "/".join(p.relative_to(_root()).parts)
                items.append(
                    {
                        "rel": rel,
                        "name": p.name,
                        "mtime": st.st_mtime,
                        "size": st.st_size,
                        "size_h": human_size(st.st_size) if human_size else str(st.st_size),
                    }
                )
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items[:limit]


# ---- health ----

_smb_cache: tuple[float, bool] | None = None
_printers_cache: tuple[float, list[dict]] | None = None


def smb_share_ok() -> bool:
    global _smb_cache
    now = time.time()
    if _smb_cache and (now - _smb_cache[0]) < 60:
        return _smb_cache[1]
    ok = False
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Get-SmbShare -Name Transfert -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        ok = "Transfert" in (r.stdout or "")
    except (OSError, subprocess.TimeoutExpired):
        ok = False
    _smb_cache = (now, ok)
    return ok


def health_report(*, uptime_sec: float, tailscale_ip: str | None, version: str) -> dict:
    d = disk_free(Path("D:/")) if disk_free else {}
    ts_ok = bool(tailscale_ip)
    return {
        "ok": True,
        "version": version,
        "hostname": socket.gethostname(),
        "uptime_sec": int(uptime_sec),
        "tailscale": {"ok": ts_ok, "ip": tailscale_ip},
        "disk_d": d,
        "smb_transfert": {"ok": smb_share_ok()},
        "bridge": {"ok": True, "port": 8765},
        "checked_at": time.time(),
    }


# ---- transfers persist ----

def transfers_path() -> Path:
    return _root() / TRANSFERS_PATH_NAME


def persist_transfers(items: list[dict]) -> None:
    try:
        # only serializable fields
        slim = []
        for t in items[:40]:
            slim.append({k: t.get(k) for k in ("id", "name", "size", "size_h", "folder", "ip", "state", "started", "finished", "rel", "files", "error")})
        transfers_path().write_text(json.dumps(slim, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass


def load_transfers() -> list[dict]:
    path = transfers_path()
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


# ---- v6: presence history / who's home ----

PRESENCE_HIST = "bridge_presence_history.json"
PRESENCE_HIST_MAX = 288  # ~24h at 5 min if sampled often; we sample every monitor tick but downsample


def presence_history_path() -> Path:
    return _root() / PRESENCE_HIST


def record_presence_snapshot(devices: list[dict]) -> None:
    now = time.time()
    counts = {"lan": 0, "tailscale": 0, "direct": 0, "relay": 0, "browser": 0, "online": 0}
    for d in devices:
        if d.get("online") is False:
            continue
        counts["online"] += 1
        p = d.get("path") or ""
        if p in counts:
            counts[p] += 1
        if d.get("source") == "browser":
            counts["browser"] += 1
    path = presence_history_path()
    items: list[dict] = []
    if path.is_file():
        try:
            items = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(items, list):
                items = []
        except (OSError, json.JSONDecodeError):
            items = []
    # keep at most one sample per ~60s
    if items and now - float(items[-1].get("t") or 0) < 55:
        return
    items.append({"t": now, "at_h": datetime.now().strftime("%H:%M"), **counts})
    items = items[-PRESENCE_HIST_MAX:]
    try:
        path.write_text(json.dumps(items) + "\n", encoding="utf-8")
    except OSError:
        pass


def presence_history(limit: int | None = None, offset: int = 0) -> list[dict]:
    path = presence_history_path()
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        items = data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []
    if offset:
        items = items[offset:]
    if limit is not None:
        items = items[: max(0, int(limit))]
    return items


# ---- v6: backup ----

_last_backup = 0.0


def run_backup(*, force: bool = False) -> dict:
    global _last_backup
    cfg = _cfg()
    every_h = float(cfg.get("backup_every_hours") or 24)
    dest_root = Path(str(cfg.get("backup_dir") or (Path("D:/Backups/Transfert"))))
    now = time.time()
    if not force and _last_backup and (now - _last_backup) < every_h * 3600:
        return {"ok": True, "skipped": True, "next_h": every_h}
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = dest_root / stamp
    dest.mkdir(parents=True, exist_ok=True)
    copied = 0
    for name in ("Inbox", "Uni", "Print"):
        src = _root() / name
        if not src.is_dir():
            continue
        target = dest / name
        shutil_copy = __import__("shutil").copytree
        try:
            shutil_copy(src, target, dirs_exist_ok=True, ignore=__import__("shutil").ignore_patterns(".tmp", "*.pid"))
            copied += 1
        except OSError as e:
            raise RuntimeError(f"Backup {name}: {e}") from e
    _last_backup = now
    # marker
    (dest / "README.txt").write_text(f"Transfert backup {stamp}\n", encoding="utf-8")
    log_activity("backup", f"Backup → {dest}")
    if notify_discord:
        notify_discord("Backup Transfert", f"`{dest}` ({copied} dossiers)")
    return {"ok": True, "path": str(dest), "folders": copied}


def maybe_backup() -> None:
    try:
        run_backup(force=False)
    except Exception as e:
        try:
            __import__("sys").stderr.write(f"backup: {e}\n")
        except Exception:
            pass


# ---- v6: kanban ----

KANBAN_NAME = "kanban.json"


def kanban_path() -> Path:
    return _root() / KANBAN_NAME


def kanban_default() -> dict:
    return {
        "columns": [
            {"id": "todo", "title": "À faire", "cards": []},
            {"id": "doing", "title": "En cours", "cards": []},
            {"id": "done", "title": "Fait", "cards": []},
        ]
    }


def kanban_get() -> dict:
    path = kanban_path()
    if not path.is_file():
        data = kanban_default()
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        return data
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("columns"):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return kanban_default()


def kanban_save(data: dict) -> dict:
    kanban_path().write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    log_activity("kanban", "Kanban mis à jour")
    return data


def kanban_add(column_id: str, title: str) -> dict:
    data = kanban_get()
    card = {"id": f"c-{int(time.time()*1000)}", "title": title[:120], "created": time.time()}
    for col in data["columns"]:
        if col.get("id") == column_id:
            col.setdefault("cards", []).insert(0, card)
            break
    else:
        raise ValueError("Colonne inconnue")
    return kanban_save(data)


def kanban_move(card_id: str, to_column: str) -> dict:
    data = kanban_get()
    found = None
    for col in data["columns"]:
        cards = col.get("cards") or []
        for i, c in enumerate(cards):
            if c.get("id") == card_id:
                found = cards.pop(i)
                break
        if found:
            break
    if not found:
        raise ValueError("Carte introuvable")
    for col in data["columns"]:
        if col.get("id") == to_column:
            col.setdefault("cards", []).insert(0, found)
            break
    else:
        raise ValueError("Colonne cible inconnue")
    return kanban_save(data)


def kanban_delete(card_id: str) -> dict:
    data = kanban_get()
    for col in data["columns"]:
        col["cards"] = [c for c in (col.get("cards") or []) if c.get("id") != card_id]
    return kanban_save(data)


# ---- v6: search ----

SEARCH_EXTS = {".txt", ".md", ".csv", ".json", ".log", ".py", ".css", ".js", ".html", ".htm", ".yml", ".yaml"}


def search_files(q: str, limit: int = 40) -> list[dict]:
    q = (q or "").strip().lower()
    if not q or len(q) < 2:
        return []
    hits: list[dict] = []
    for folder in ("Inbox", "Uni", "Print"):
        base = _root() / folder
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if not p.is_file():
                continue
            if p.name.startswith("."):
                continue
            name_hit = q in p.name.lower()
            content_hit = False
            snippet = ""
            if p.suffix.lower() in SEARCH_EXTS and p.stat().st_size < 2_000_000:
                try:
                    text = p.read_text(encoding="utf-8", errors="ignore")
                    low = text.lower()
                    idx = low.find(q)
                    if idx >= 0:
                        content_hit = True
                        start = max(0, idx - 40)
                        snippet = text[start : start + 120].replace("\n", " ")
                except OSError:
                    pass
            if name_hit or content_hit:
                rel = "/".join(p.relative_to(_root()).parts)
                hits.append(
                    {
                        "rel": rel,
                        "name": p.name,
                        "match": "name" if name_hit and not content_hit else ("content" if content_hit else "name"),
                        "snippet": snippet,
                    }
                )
                if len(hits) >= limit:
                    return hits
    return hits


# ---- v6: inbox zero ----

def inbox_zero(action: str) -> dict:
    inbox = _root() / "Inbox"
    inbox.mkdir(exist_ok=True)
    action = (action or "").strip().lower()
    moved = 0
    if action == "archive":
        dest = inbox / "Archive" / datetime.now().strftime("%Y-%m-%d")
        dest.mkdir(parents=True, exist_ok=True)
        for p in list(inbox.iterdir()):
            if p.name in ("Archive", "Photos", "Screenshots", "Captures") or p.name.startswith("."):
                continue
            if p.is_file():
                target = dest / p.name
                if target.exists():
                    target = dest / f"{p.stem}-{int(time.time())}{p.suffix}"
                p.rename(target)
                moved += 1
        log_activity("inbox", f"Inbox archivée · {moved} fichier(s)")

        return {"ok": True, "action": "archive", "moved": moved, "dest": str(dest.relative_to(_root())).replace('\\', '/')}
    if action == "sort":
        # re-apply auto_route by renaming into mapped folders
        route = _cfg().get("auto_route") or {}
        for p in list(inbox.iterdir()):
            if not p.is_file():
                continue
            ext = p.suffix.lower()
            target_rel = route.get(ext)
            if not target_rel:
                continue
            parts = [p for p in str(target_rel).replace("\\", "/").strip("/").split("/") if p and p not in (".", "..")]
            if not parts:
                continue
            dest_dir = (_root().joinpath(*parts)).resolve()
            try:
                dest_dir.relative_to(_root().resolve())
            except ValueError:
                continue
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / p.name
            if dest.exists():
                continue
            p.rename(dest)
            moved += 1
        log_activity("inbox", f"Inbox triée · {moved} fichier(s)")

        return {"ok": True, "action": "sort", "moved": moved}
    if action == "empty-tmp":
        tmp = _root() / ".tmp"
        removed = 0
        if tmp.is_dir():
            for p in tmp.rglob("*"):
                if p.is_file():
                    try:
                        p.unlink()
                        removed += 1
                    except OSError:
                        pass
        return {"ok": True, "action": "empty-tmp", "removed": removed}
    raise ValueError("Action: archive | sort | empty-tmp")


# ---- v6: printers ----

def list_printers() -> list[dict]:
    global _printers_cache
    now = time.time()
    if _printers_cache and (now - _printers_cache[0]) < 120:
        return list(_printers_cache[1])
    ps = (
        "Get-Printer | Select-Object Name,DriverName,Shared,Default | "
        "ConvertTo-Json -Compress"
    )
    out: list[dict] = []
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            text=True,
            timeout=6,
            check=False,
        )
        if r.returncode == 0 and (r.stdout or "").strip():
            data = json.loads(r.stdout)
            if isinstance(data, dict):
                data = [data]
            for p in data or []:
                out.append(
                    {
                        "name": p.get("Name"),
                        "driver": p.get("DriverName"),
                        "shared": bool(p.get("Shared")),
                        "default": bool(p.get("Default") or p.get("DefaultPrinter")),
                    }
                )
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        out = []
    _printers_cache = (now, out)
    return list(out)


def print_file(path: Path, printer: str | None = None) -> None:
    if printer:
        # Use Out-Printer via PowerShell for specific printer when possible
        ps = (
            f"$p = '{str(path).replace(chr(39), chr(39)+chr(39))}'; "
            f"$printer = '{printer.replace(chr(39), chr(39)+chr(39))}'; "
            "Start-Process -FilePath $p -Verb PrintTo -ArgumentList $printer -ErrorAction SilentlyContinue; "
            "if (-not $?) { Start-Process -FilePath $p -Verb Print }"
        )
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if r.returncode != 0:
            # fallback default
            os_start = getattr(__import__("os"), "startfile", None)
            if os_start:
                os_start(str(path), "print")
            else:
                raise RuntimeError("Impression impossible")
    else:
        os_start = getattr(__import__("os"), "startfile", None)
        if not os_start:
            raise RuntimeError("Impression non supportée")
        os_start(str(path), "print")


# ---- v6: allowlisted terminal ----

def run_terminal(cmd_id: str | None = None, raw: str | None = None) -> dict:
    cfg = _cfg()
    allowed = cfg.get("terminal_commands") or []
    cmdline = None
    label = cmd_id or "cmd"
    if cmd_id:
        for c in allowed:
            if isinstance(c, dict) and c.get("id") == cmd_id:
                cmdline = c.get("cmd")
                label = c.get("label") or cmd_id
                break
        if not cmdline:
            raise ValueError("Commande non autorisée")
    elif raw is not None:
        # only exact match against allowlist cmd strings
        for c in allowed:
            if isinstance(c, dict) and str(c.get("cmd") or "").strip() == raw.strip():
                cmdline = raw.strip()
                label = c.get("label") or c.get("id") or "cmd"
                break
        if not cmdline:
            raise ValueError("Commande brute non autorisée")
    else:
        raise ValueError("cmd_id requis")
    r = subprocess.run(
        cmdline,
        shell=True,
        capture_output=True,
        text=True,
        timeout=int(cfg.get("terminal_timeout_sec") or 20),
        check=False,
        cwd=str(_root()),
    )
    out = (r.stdout or "")[-8000:]
    err = (r.stderr or "")[-2000:]
    log_activity("terminal", f"Terminal: {label}")
    return {
        "ok": r.returncode == 0,
        "code": r.returncode,
        "label": label,
        "stdout": out,
        "stderr": err,
    }


def default_terminal_commands() -> list[dict]:
    return [
        {"id": "ipconfig", "label": "ipconfig", "cmd": "ipconfig"},
        {"id": "tailscale-status", "label": "Tailscale status", "cmd": "tailscale status"},
        {"id": "dir-transfert", "label": "Dir Transfert", "cmd": "dir D:\\Transfert"},
        {"id": "freespace", "label": "Espace disque", "cmd": "powershell -NoProfile -Command \"Get-PSDrive -PSProvider FileSystem | Format-Table Name,Used,Free\""},
    ]


def default_shell_targets() -> list[dict]:
    return [
        {
            "id": "local",
            "label": "Ce PC (local)",
            "type": "local",
        }
    ]


def list_shell_targets(tailscale_peers_fn=None) -> list[dict]:
    """Merge config shell_targets with online Tailscale peers as SSH candidates."""
    cfg = _cfg()
    out: list[dict] = []
    seen = set()
    for t in cfg.get("shell_targets") or default_shell_targets():
        if not isinstance(t, dict) or not t.get("id"):
            continue
        tid = str(t["id"])
        seen.add(tid)
        out.append(
            {
                "id": tid,
                "label": t.get("label") or tid,
                "type": t.get("type") or "local",
                "host": t.get("host") or "",
                "user": t.get("user") or cfg.get("ssh_user") or "",
                "online": True if (t.get("type") or "local") == "local" else t.get("online"),
            }
        )
    # auto Tailscale peers
    peers = []
    if callable(tailscale_peers_fn):
        try:
            peers = tailscale_peers_fn() or []
        except Exception:
            peers = []
    default_user = str(cfg.get("ssh_user") or "").strip()
    for p in peers:
        if not isinstance(p, dict):
            continue
        os_name = str(p.get("os") or "").lower()
        if os_name in ("ios", "android", "tvos", "watchos"):
            continue  # no remote shell on phones
        name = str(p.get("name") or "").split(".")[0]
        if not name or name.lower() in seen:
            continue
        if p.get("id") == "pc-host":
            continue
        host = (p.get("ip") or name).strip()
        tid = f"ts-{name}"
        if tid in seen:
            continue
        seen.add(tid)
        is_win = "windows" in os_name or os_name in ("win", "win32")
        out.append(
            {
                "id": tid,
                "label": f"{name} ({'OpenSSH' if is_win else 'SSH'} · Tailscale)",
                "type": "ssh",
                "host": host,
                "user": default_user,
                "online": bool(p.get("online")),
                "path": p.get("path"),
                "os": p.get("os") or "",
            }
        )
    return out


def run_shell(
    *,
    target: dict,
    shell: str = "powershell",
    command: str,
    timeout: int | None = None,
    quiet: bool = False,
) -> dict:
    command = (command or "").strip()
    if not command:
        raise ValueError("Commande vide")
    if len(command) > 8000:
        raise ValueError("Commande trop longue")
    cfg = _cfg()
    timeout = int(timeout or cfg.get("shell_timeout_sec") or 45)
    shell = (shell or "powershell").lower()
    if shell not in ("powershell", "cmd", "pwsh", "raw"):
        raise ValueError("Shell: powershell | cmd | pwsh | raw")

    typ = str(target.get("type") or "local")
    label = str(target.get("label") or target.get("id") or typ)

    if typ == "local":
        if shell == "raw":
            raise ValueError("Shell raw réservé au SSH distant")
        if shell == "cmd":
            full = f'cmd.exe /c {command}'
        elif shell == "pwsh":
            full = ["pwsh", "-NoProfile", "-NonInteractive", "-Command", command]
        else:
            full = ["powershell", "-NoProfile", "-NonInteractive", "-Command", command]
        r = subprocess.run(
            full,
            shell=isinstance(full, str),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            cwd=str(_root()),
        )
    elif typ in ("ssh", "tailscale-ssh"):
        host = str(target.get("host") or "").strip()
        user = str(target.get("user") or cfg.get("ssh_user") or "").strip()
        if not host:
            raise ValueError("Hôte SSH manquant")
        # Prefer Tailscale SSH when available and type says so, else OpenSSH.
        # shell=raw sends the command unchanged (Linux/macOS probes).
        remote_cmd = command
        if shell == "cmd":
            remote_cmd = f"cmd.exe /c {command}"
        elif shell in ("powershell", "pwsh"):
            exe = "pwsh" if shell == "pwsh" else "powershell"
            remote_cmd = f'{exe} -NoProfile -NonInteractive -Command "{command.replace(chr(34), chr(92)+chr(34))}"'

        # Only use `tailscale ssh` when explicitly requested.
        # Auto Windows peers use OpenSSH over the 100.x IP (id may still be ts-*).
        use_ts = typ == "tailscale-ssh"
        dest = f"{user}@{host}" if user else host
        if use_ts:
            ts = shutil.which("tailscale")
            if not ts:
                for c in (
                    r"C:\Program Files\Tailscale\tailscale.exe",
                    r"C:\Program Files (x86)\Tailscale\tailscale.exe",
                ):
                    if Path(c).is_file():
                        ts = c
                        break
            if not ts:
                raise ValueError("Tailscale CLI introuvable")
            argv = [ts, "ssh", dest, remote_cmd]
        else:
            key = Path.home() / ".ssh" / "id_ed25519"
            argv = [
                "ssh",
                "-F", "NUL",
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=10",
                "-o", "StrictHostKeyChecking=accept-new",
                "-o", "IdentitiesOnly=yes",
            ]
            if key.is_file():
                argv += ["-i", str(key)]
            argv += [dest, remote_cmd]
        r = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    else:
        raise ValueError(f"Type de cible inconnu: {typ}")

    out = (r.stdout or "")[-12000:]
    err = (r.stderr or "")[-4000:]
    if not quiet:
        # Never log/post raw command text (may contain secrets).
        log_activity("shell", f"{label} [{shell}] exit={r.returncode}")
        if notify_discord and _cfg().get("discord_log_shell"):
            notify_discord("Terminal distant", f"**{label}** `{shell}` exit={r.returncode}")

    return {
        "ok": r.returncode == 0,
        "code": r.returncode,
        "target": target.get("id"),
        "label": label,
        "shell": shell,
        "stdout": out,
        "stderr": err,
    }