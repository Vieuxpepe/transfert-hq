"""Headless official Spotify Connect player (Spotify Soloist) for Windows/Linux/macOS.

Replaces the heavy Chromium/Electron Spotify Desktop client (~400-700 MB RAM)
with a lightweight ~20 MB WASAPI Connect receiver and local WebSocket control
plane. Needs Spotify Premium and a personal Soloist API Key stored outside Git
(``SPOTIFY_SOLOIST_API_KEY`` env or ``spotify_soloist_api_key`` in ``bridge_config.json``).
"""

from __future__ import annotations

import base64
from datetime import date, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import struct
import subprocess
import time
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_EXE = PROJECT_ROOT / "tools" / "soloist" / ("soloist.exe" if os.name == "nt" else "soloist")
DATA_DIR = PROJECT_ROOT / ".tmp" / "soloist-data"
CACHE_DIR = PROJECT_ROOT / ".tmp" / "soloist-cache"
LOG_PATH = PROJECT_ROOT / ".tmp" / "soloist.log"
ROTATION_PATH = PROJECT_ROOT / ".tmp" / "soloist-key-rotation.json"
PROCESS_HINT = "soloist"
BUILD_LIFETIME_DAYS = 90
DEFAULT_ROTATION_DAYS = 90
EXPIRY_EXIT_CODE = 10

_last_error: dict[str, Any] = {}


def device_name() -> str:
    return (os.environ.get("HQ_SOLOIST_NAME") or "Transfert HQ").strip()[:60] or "Transfert HQ"


def device_id() -> str | None:
    path = DATA_DIR / ".device_id"
    try:
        if path.is_file() and not path.is_symlink():
            val = path.read_text(encoding="utf-8", errors="replace").strip()
            return val or None
    except OSError:
        pass
    return None


def exe_path() -> Path | None:
    env = (os.environ.get("HQ_SOLOIST_EXE") or "").strip()
    for cand in ([Path(env)] if env else []) + [DEFAULT_EXE]:
        if cand.is_file():
            return cand
    found = shutil.which("soloist")
    return Path(found) if found else None


def _api_key() -> str:
    for env_name in ("SPOTIFY_SOLOIST_API_KEY", "SOLOIST_API_KEY"):
        val = (os.environ.get(env_name) or "").strip()
        if val:
            return val
    try:
        import hq_spotify as spotify
        raw = spotify._config_getter() if spotify._config_getter else None
        if isinstance(raw, dict):
            val = str(raw.get("spotify_soloist_api_key") or raw.get("SPOTIFY_SOLOIST_API_KEY") or "").strip()
            if val:
                return val
    except Exception:  # noqa: BLE001
        pass
    try:
        cfg_file = PROJECT_ROOT / "bridge_config.json"
        if cfg_file.is_file() and not cfg_file.is_symlink():
            raw = json.loads(cfg_file.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return str(raw.get("spotify_soloist_api_key") or "").strip()
    except Exception:  # noqa: BLE001
        pass
    return ""


def has_api_key() -> bool:
    return bool(_api_key())


def available() -> bool:
    return exe_path() is not None and has_api_key()


def build_args(exe: Path, key: str) -> list[str]:
    return [
        str(exe),
        "-n", device_name(),
        "-k", key,
        "-D", str(DATA_DIR),
        "-C", str(CACHE_DIR),
        "-z", "256",
        "-i", "70",
        "-w", "127.0.0.1:0",
    ]


def build_info() -> dict[str, Any]:
    """Read ``soloist --version`` and compute days until the 90-day build expiry."""
    exe = exe_path()
    if exe is None:
        return {}
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        res = subprocess.run([str(exe), "--version"], capture_output=True, text=True, errors="replace", timeout=4, creationflags=flags)
        text = (res.stdout or res.stderr or "").strip()
    except (OSError, subprocess.SubprocessError):
        return {}
    out: dict[str, Any] = {"raw": text}
    m = re.search(r"\((\d{8})\)", text)
    if m:
        try:
            built = datetime.strptime(m.group(1), "%Y%m%d")
            age_days = max(0, (datetime.now() - built).days)
            days_left = max(0, BUILD_LIFETIME_DAYS - age_days)
            out.update(
                build_date=built.strftime("%Y-%m-%d"),
                age_days=age_days,
                days_remaining=days_left,
                expired=days_left <= 0,
            )
        except ValueError:
            pass
    return out


def _rotation_days() -> int:
    raw_val: Any = os.environ.get("HQ_SOLOIST_ROTATION_DAYS")
    if not raw_val:
        try:
            import hq_spotify as spotify
            cfg = spotify._config_getter() if spotify._config_getter else None
            if isinstance(cfg, dict):
                raw_val = cfg.get("spotify_soloist_rotation_days")
        except Exception:  # noqa: BLE001
            raw_val = None
    try:
        days = int(raw_val) if raw_val is not None and str(raw_val).strip() else DEFAULT_ROTATION_DAYS
    except (TypeError, ValueError):
        days = DEFAULT_ROTATION_DAYS
    return max(1, min(3650, days))


def _atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    if path.is_symlink():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    data = json.dumps(payload, ensure_ascii=False, indent=2)
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def rotation_info(*, today: date | None = None) -> dict[str, Any]:
    """Track non-secret API-key rotation cycle starting from key install/change date."""
    key = _api_key()
    if not key:
        return {}
    fp = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    cur = today or datetime.now().date()
    cycle_days = _rotation_days()

    saved: dict[str, Any] | None = None
    if ROTATION_PATH.is_file() and not ROTATION_PATH.is_symlink():
        try:
            parsed = json.loads(ROTATION_PATH.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                saved = parsed
        except (OSError, ValueError):
            saved = None

    rotated_date: date | None = None
    if saved and saved.get("key_fp") == fp and isinstance(saved.get("rotated_at"), str):
        try:
            rotated_date = date.fromisoformat(saved["rotated_at"][:10])
        except ValueError:
            rotated_date = None

    if rotated_date is None:
        rotated_date = cur
        try:
            _atomic_json_write(
                ROTATION_PATH,
                {"key_fp": fp, "rotated_at": rotated_date.isoformat(), "cycle_days": cycle_days},
            )
        except OSError:
            pass

    elapsed = max(0, (cur - rotated_date).days)
    reset_date = rotated_date + timedelta(days=cycle_days)
    remaining = max(0, (reset_date - cur).days)
    pct = round(min(100.0, (elapsed / cycle_days) * 100.0), 1)
    due = remaining <= 0
    lvl = "hot" if (due or remaining <= 7 or pct >= 90.0) else ("warm" if (remaining <= 21 or pct >= 75.0) else "")
    return {
        "rotated_at": rotated_date.isoformat(),
        "reset_date": reset_date.isoformat(),
        "cycle_days": cycle_days,
        "elapsed_days": elapsed,
        "days_remaining": remaining,
        "pct": pct,
        "due": due,
        "level": lvl,
    }


def running_pids() -> list[int]:
    if os.name != "nt":
        try:
            out = subprocess.run(["pgrep", "-x", "soloist"], capture_output=True, text=True, errors="replace", timeout=3).stdout or ""
            return [int(x) for x in out.split() if x.isdigit()]
        except (OSError, subprocess.SubprocessError):
            return []
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq soloist.exe", "/FO", "CSV", "/NH"],
                             capture_output=True, text=True, errors="replace", timeout=4,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout or ""
    except (OSError, subprocess.SubprocessError):
        return []
    pids: list[int] = []
    for line in out.splitlines():
        parts = [p.strip().strip('"') for p in line.split('","')]
        if len(parts) >= 2 and "soloist" in parts[0].casefold() and parts[1].isdigit():
            pids.append(int(parts[1]))
    return pids


def ws_endpoint() -> tuple[str, int] | None:
    try:
        addr = (DATA_DIR / "ws.addr").read_text(encoding="utf-8").strip()
        port_s = (DATA_DIR / "ws.port").read_text(encoding="utf-8").strip()
        return (addr, int(port_s)) if addr and port_s.isdigit() else None
    except (OSError, ValueError):
        return None


def _recv_exact(sock: socket.socket, n: int, pre: bytearray) -> bytes:
    while len(pre) < n:
        chunk = sock.recv(max(4096, n - len(pre)))
        if not chunk:
            raise EOFError("ws eof")
        pre.extend(chunk)
    out = bytes(pre[:n])
    del pre[:n]
    return out


def _ws_send(sock: socket.socket, opcode: int, payload: bytes) -> None:
    mask = os.urandom(4)
    n = len(payload)
    hdr = bytearray([0x80 | (opcode & 0x0F)])
    if n < 126:
        hdr.append(0x80 | n)
    elif n < 65536:
        hdr.extend([0x80 | 126, *struct.pack("!H", n)])
    else:
        hdr.extend([0x80 | 127, *struct.pack("!Q", n)])
    hdr.extend(mask)
    masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
    sock.sendall(bytes(hdr) + masked)


def _ws_recv_json(sock: socket.socket, pre: bytearray) -> dict[str, Any] | None:
    chunks = bytearray()
    while True:
        hdr = _recv_exact(sock, 2, pre)
        fin = bool(hdr[0] & 0x80)
        op = hdr[0] & 0x0F
        masked = bool(hdr[1] & 0x80)
        ln = hdr[1] & 0x7F
        if ln == 126:
            ln = struct.unpack("!H", _recv_exact(sock, 2, pre))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", _recv_exact(sock, 8, pre))[0]
        mask = _recv_exact(sock, 4, pre) if masked else b""
        data = _recv_exact(sock, ln, pre) if ln else b""
        if masked:
            data = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
        if op == 0x8:
            return None
        if op == 0x9:
            _ws_send(sock, 0xA, data)
            continue
        if op == 0xA:
            continue
        chunks.extend(data)
        if fin:
            if op in (0x1, 0x0):
                parsed = json.loads(chunks.decode("utf-8", errors="replace"))
                return parsed if isinstance(parsed, dict) else None
            chunks.clear()


def _ws_exchange(
    commands: list[dict[str, Any]] | None = None,
    *,
    need_playback: bool = False,
    timeout: float = 1.5,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, list[dict[str, Any]]] | None:
    ep = ws_endpoint()
    if ep is None:
        return None
    host, port = ep
    if host not in ("127.0.0.1", "localhost", "::1"):
        return None
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            ws_key = base64.b64encode(os.urandom(16)).decode("ascii")
            req = (
                f"GET / HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {ws_key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode("ascii")
            sock.sendall(req)
            buf = b""
            while b"\r\n\r\n" not in buf and len(buf) < 8192:
                chunk = sock.recv(4096)
                if not chunk:
                    return None
                buf += chunk
            if b"\r\n\r\n" not in buf or b" 101 " not in buf.split(b"\r\n", 1)[0]:
                return None
            pre = bytearray(buf.split(b"\r\n\r\n", 1)[1])

            auth: dict[str, Any] | None = None
            playback: dict[str, Any] | None = None
            if need_playback or not commands:
                for _ in range(3):
                    try:
                        msg = _ws_recv_json(sock, pre)
                    except (OSError, EOFError, ValueError, TimeoutError):
                        break
                    if not msg:
                        break
                    t = msg.get("type")
                    if t == "auth_state":
                        auth = msg
                        if not need_playback:
                            break
                    elif t == "playback_state":
                        playback = msg
                        if auth is not None:
                            break
                    if need_playback and not (auth and auth.get("logged_in")):
                        sock.settimeout(0.2)
            else:
                msg = _ws_recv_json(sock, pre)
                if msg and msg.get("type") == "auth_state":
                    auth = msg

            results: list[dict[str, Any]] = []
            if commands:
                if not (auth and auth.get("logged_in")):
                    return (auth, playback, results)
                for cmd in commands:
                    _ws_send(sock, 0x1, json.dumps(cmd).encode("utf-8"))
                deadline = time.monotonic() + timeout
                while len(results) < len(commands) and time.monotonic() < deadline:
                    try:
                        msg = _ws_recv_json(sock, pre)
                    except (OSError, EOFError, ValueError, TimeoutError):
                        break
                    if not msg:
                        break
                    if msg.get("type") == "command_result":
                        results.append(msg)
                    elif msg.get("type") == "error":
                        results.append(msg)
                        break
            return (auth, playback, results)
    except (OSError, EOFError, ValueError, TimeoutError):
        return None


def ctl_status() -> dict[str, Any]:
    ep = ws_endpoint()
    ws_res = _ws_exchange(need_playback=False) if ep else None
    if ws_res is not None:
        auth, _, _ = ws_res
        if auth is not None:
            return {
                "running": True,
                "logged_in": bool(auth.get("logged_in")),
                "is_active": bool(auth.get("is_active")),
                "ws": f"{ep[0]}:{ep[1]}" if ep else None,
            }
    exe = exe_path()
    pids = running_pids()
    if exe is None or not pids:
        return {"running": False, "logged_in": False}
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        res = subprocess.run([str(exe), "ctl", "-D", str(DATA_DIR), "status"],
                             capture_output=True, text=True, errors="replace", timeout=3, creationflags=flags)
        out = res.stdout or ""
    except (OSError, subprocess.SubprocessError):
        return {"running": bool(pids), "logged_in": False}
    logged_in = bool(re.search(r"logged in:\s*yes\b", out, re.I))
    m_ws = re.search(r"ws:\s*listening on\s*(\S+)", out, re.I)
    return {"running": True, "logged_in": logged_in, "ws": m_ws.group(1) if m_ws else None}


def now() -> dict[str, Any] | None:
    """Query local Soloist playback state without hitting Spotify Web API."""
    ws_res = _ws_exchange(need_playback=True)
    if ws_res is not None:
        _, playback, _ = ws_res
        return playback
    exe = exe_path()
    if exe is None or not running_pids():
        return None
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        res = subprocess.run([str(exe), "ctl", "-D", str(DATA_DIR), "now", "--json"],
                             capture_output=True, text=True, errors="replace", timeout=3, creationflags=flags)
        if res.returncode != 0 or not (res.stdout or "").strip():
            return None
        parsed = json.loads(res.stdout)
        return parsed if isinstance(parsed, dict) else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def _build_control_specs(action: str, params: dict[str, Any] | None) -> tuple[list[str] | None, list[dict[str, Any]] | None]:
    p = params if isinstance(params, dict) else {}
    act = str(action or "").strip().lower()
    if act == "play":
        if p.get("position_ms") is not None or p.get("offset") is not None:
            return None, None
        uris = p.get("uris")
        ctx = p.get("context_uri")
        if uris:
            if isinstance(uris, list) and len(uris) == 1 and isinstance(uris[0], str) and uris[0].startswith("spotify:"):
                return ["play", uris[0]], [{"type": "command", "command": "play", "uri": uris[0]}]
            return None, None
        if isinstance(ctx, str) and ctx.startswith("spotify:"):
            return ["play", ctx], [{"type": "command", "command": "play", "uri": ctx}]
        return ["play"], [{"type": "command", "command": "play"}]
    if act == "pause":
        return ["pause"], [{"type": "command", "command": "pause"}]
    if act == "next":
        return ["next"], [{"type": "command", "command": "skip_next"}]
    if act == "previous":
        return ["prev"], [{"type": "command", "command": "skip_prev"}]
    if act == "seek":
        pos = max(0, int(p.get("position_ms", 0)))
        return ["seek", str(pos)], [{"type": "command", "command": "seek", "position_ms": pos}]
    if act == "volume":
        vol = max(0, min(100, int(p.get("volume_percent", 50))))
        return ["volume", str(vol)], [{"type": "command", "command": "set_volume", "volume": vol}]
    if act == "shuffle":
        on = bool(p.get("state", True))
        return ["shuffle", "on" if on else "off"], [{"type": "command", "command": "set_shuffle", "enabled": on}]
    if act == "repeat":
        st = str(p.get("state") or "off")
        if st not in ("off", "track", "context"):
            return None, None
        ws_cmds = [
            {"type": "command", "command": "set_repeat_context", "enabled": st == "context"},
            {"type": "command", "command": "set_repeat_track", "enabled": st == "track"},
        ]
        return ["repeat", st], ws_cmds
    if act in ("queue", "queue_add"):
        uri = p.get("uri")
        if not isinstance(uri, str) or not uri.startswith("spotify:"):
            return None, None
        return ["add-to-queue", uri], [{"type": "command", "command": "add_to_queue", "uri": uri}]
    if act == "activate":
        return ["activate"], [{"type": "command", "command": "activate"}]
    return None, None


def control(action: str, params: dict[str, Any] | None = None) -> bool:
    """Execute a playback command locally via Soloist WebSocket (with ``ctl`` CLI fallback)."""
    cmd, ws_cmds = _build_control_specs(action, params)
    if not cmd or not ws_cmds:
        return False
    ws_res = _ws_exchange(ws_cmds)
    if ws_res is not None:
        auth, _, results = ws_res
        if not (auth and auth.get("logged_in")):
            return False
        return len(results) == len(ws_cmds) and all(r.get("type") == "command_result" and not r.get("error") for r in results)

    exe = exe_path()
    if exe is None or not running_pids():
        return False
    if not ctl_status().get("logged_in"):
        return False
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        res = subprocess.run([str(exe), "ctl", "-D", str(DATA_DIR), *cmd],
                             capture_output=True, text=True, errors="replace", timeout=4, creationflags=flags)
        return res.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def start() -> bool:
    """Launch Soloist hidden and detached. Returns True if running after launch."""
    _last_error.clear()
    if running_pids():
        return True
    exe = exe_path()
    key = _api_key()
    if exe is None or not key:
        _last_error["reason"] = "missing_binary" if exe is None else "missing_api_key"
        return False
    info = build_info()
    if info.get("expired"):
        _last_error.update(reason="expired_build", exit_code=EXPIRY_EXIT_CODE)
        return False
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    flags = 0
    extra: dict[str, Any] = {}
    if os.name == "nt":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0
        extra["startupinfo"] = si
    with open(LOG_PATH, "ab") as log:
        proc = subprocess.Popen(build_args(exe, key), cwd=str(exe.parent), stdout=log, stderr=log,
                                stdin=subprocess.DEVNULL, creationflags=flags, close_fds=True, **extra)
    deadline = time.monotonic() + 1.8
    while time.monotonic() < deadline:
        rc = proc.poll()
        if rc is not None:
            _last_error.update(reason="expired_build" if rc == EXPIRY_EXIT_CODE else "exited", exit_code=rc)
            return False
        if (DATA_DIR / "ws.port").is_file() or running_pids():
            return True
        time.sleep(0.15)
    return bool(running_pids())


def stop() -> bool:
    pids = running_pids()
    if not pids:
        return True
    for pid in pids:
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=6,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            else:
                os.kill(pid, 15)
        except (OSError, subprocess.SubprocessError):
            pass
    end = time.monotonic() + 4.0
    while time.monotonic() < end:
        if not running_pids():
            return True
        time.sleep(0.15)
    return not running_pids()


def _build_meters(info: dict[str, Any], rot: dict[str, Any]) -> list[dict[str, Any]]:
    meters: list[dict[str, Any]] = []
    if rot:
        text = (
            f"Rotation due · {rot['reset_date']}"
            if rot["due"]
            else f"{rot['elapsed_days']} / {rot['cycle_days']} j · reset {rot['reset_date']}"
        )
        meters.append({"label": "Rotation clé API", "pct": rot["pct"], "text": text, "level": rot["level"]})
    if info.get("days_remaining") is not None:
        rem_b = int(info["days_remaining"])
        age_b = int(info.get("age_days", max(0, BUILD_LIFETIME_DAYS - rem_b)))
        pct_b = round(min(100.0, (age_b / BUILD_LIFETIME_DAYS) * 100.0), 1)
        lvl_b = "hot" if (info.get("expired") or rem_b <= 7) else ("warm" if rem_b <= 21 else "")
        text_b = "Expiré (>90 j)" if info.get("expired") else f"{age_b} / {BUILD_LIFETIME_DAYS} j · reste {rem_b} j"
        meters.append({"label": "Build Soloist", "pct": pct_b, "text": text_b, "level": lvl_b})
    return meters


def check() -> dict[str, Any]:
    exe = exe_path()
    has_key = has_api_key()
    pids = running_pids()
    info = build_info() if exe else {}
    rot = rotation_info() if has_key else {}
    meters = _build_meters(info, rot)
    facts: dict[str, Any] = {
        "Appareil": device_name(),
        "Binaire": "trouvé" if exe else "introuvable",
        "Clé API": "présente" if has_key else "manquante",
    }
    if rot:
        facts["Prochain reset"] = rot["reset_date"]
    if info.get("days_remaining") is not None:
        facts["Validité"] = f"{info['days_remaining']} j"
    if pids:
        facts["Processus"] = len(pids)
        status = ctl_status()
        logged = bool(status.get("logged_in"))
        facts["Connexion"] = "enregistrée" if logged else "à associer (une fois)"
        if status.get("ws"):
            facts["WebSocket"] = status["ws"]
        if info.get("expired"):
            return {"state": "warn", "pid": pids[0], "facts": facts, "meters": meters,
                    "note": "Build Soloist expiré (>90 j) — mets à jour soloist.exe."}
        note = "" if logged else f"Ouvre Spotify sur ton téléphone et choisis « {device_name()} » une fois pour l'associer."
        return {"state": "ready" if logged else "warn", "pid": pids[0], "facts": facts, "meters": meters, "note": note}
    if not exe:
        note = "Place soloist.exe dans tools/soloist/ (Spotify Premium requis)."
    elif not has_key:
        note = "Ajoute spotify_soloist_api_key dans bridge_config.json."
    elif info.get("expired"):
        note = "Build Soloist expiré (code 10) : télécharge une build récente."
    else:
        note = "Arrêté."
    return {"state": "down", "facts": facts, "meters": meters, "note": note}
