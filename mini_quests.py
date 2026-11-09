# -*- coding: utf-8 -*-
"""
Mini‑Quêtes for the torque playground.
Each quest is a lightweight stub that can be expanded later.
"""
import time
import os
from pathlib import Path

# Shared log for quest notes
LOG_PATH = Path(__file__).with_name("quest_log.txt")

def _log(message: str) -> None:
    """Append a timestamped line to the quest log."""
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(f"[{timestamp}] {message}\n")

def simmer() -> str:
    """Raise CPU load briefly (~70 %) for ~2 s, then log a note.
    Returns a short status string.
    """
    # Simple busy‑wait loop to consume CPU
    end = time.time() + 2
    while time.time() < end:
        pass
    _log("simmer quest completed – torque warmed")
    return "simmer done"

def pulse() -> dict:
    """Generate a synthetic pulse reading.
    Returns a JSON‑compatible dict.
    """
    beat = 0.85  # arbitrary intensity
    _log(f"pulse emitted – beat {beat}")
    return {"beat": beat, "status": "torque‑high"}

def gear_whisper(context: str = "") -> None:
    """Log a subtle gear‑whisper whenever any request is processed.
    The optional *context* can carry extra info.
    """
    _log(f"gear whisper – {context or 'generic'}")
