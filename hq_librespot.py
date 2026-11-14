"""Headless Spotify Connect player (librespot) so HQ can play on this PC without the Spotify desktop window.

librespot registers as a normal Connect device; HQ keeps driving it through the Spotify Web API (hq_spotify.py).
Needs Spotify Premium. The binary is NOT shipped: drop ``librespot.exe`` in ``tools/librespot/`` (or set
``HQ_LIBRESPOT_EXE``). First run: open Spotify on your phone, pick the device named below once — the login is then
cached in ``.tmp/librespot-cache`` and no password is ever handled here.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_EXE = PROJECT_ROOT / "tools" / "librespot" / "librespot.exe"
CACHE_DIR = PROJECT_ROOT / ".tmp" / "librespot-cache"
LOG_PATH = PROJECT_ROOT / ".tmp" / "librespot.log"
PROCESS_HINT = "librespot"


def device_name() -> str:
    return (os.environ.get("HQ_LIBRESPOT_NAME") or "Transfert HQ").strip()[:60] or "Transfert HQ"


def exe_path() -> Optional[Path]:
    env = (os.environ.get("HQ_LIBRESPOT_EXE") or "").strip()
    for cand in ([Path(env)] if env else []) + [DEFAULT_EXE]:
        if cand.is_file():
            return cand
    found = shutil.which("librespot")
    return Path(found) if found else None


def build_args(exe: Path) -> list[str]:
    return [str(exe), "--name", device_name(), "--cache", str(CACHE_DIR), "--disable-audio-cache",
            "--device-type", "computer", "--bitrate", "160", "--initial-volume", "70"]


def running_pids() -> list[int]:
    if os.name != "nt":
        try:
            out = subprocess.run(["pgrep", "-x", "librespot"], capture_output=True, text=True, timeout=3).stdout
            return [int(x) for x in out.split() if x.isdigit()]
        except (OSError, subprocess.SubprocessError):
            return []
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq librespot.exe", "/FO", "CSV", "/NH"], capture_output=True,
                             text=True, timeout=4, creationflags=0x08000000).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    pids = []
    for line in out.splitlines():
        parts = [p.strip().strip('"') for p in line.split('","')]
        if len(parts) >= 2 and "librespot" in parts[0].casefold() and parts[1].isdigit():
            pids.append(int(parts[1]))
    return pids


def start() -> bool:
    """Launch hidden and detached from HQ's console. Returns whether it is running right now."""
    if running_pids():
        return True
    exe = exe_path()
    if exe is None:
        return False
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    flags: int = 0
    extra: dict[str, Any] = {}
    if os.name == "nt":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | 0x08000000      # CREATE_NO_WINDOW (not DETACHED_PROCESS)
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0
        extra["startupinfo"] = si
    with open(LOG_PATH, "ab") as log:
        subprocess.Popen(build_args(exe), cwd=str(exe.parent), stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                         creationflags=flags, close_fds=True, **extra)
    return False


def check() -> dict:
    exe = exe_path()
    pids = running_pids()
    cached = CACHE_DIR.joinpath("credentials.json").is_file()
    facts: dict[str, Any] = {"Appareil": device_name(), "Binaire": "trouvé" if exe else "introuvable"}
    if pids:
        facts["Processus"] = len(pids)
    facts["Connexion"] = "enregistrée" if cached else "à faire (une fois)"
    if pids:
        note = "" if cached else "Ouvre Spotify sur ton téléphone et choisis cet appareil une fois pour l'associer."
        return {"state": "ready" if cached else "warn", "facts": facts, "note": note}
    note = ("Arrêté." if exe else "Place librespot.exe dans tools/librespot/ (Spotify Premium requis).")
    return {"state": "down", "facts": facts, "note": note}
