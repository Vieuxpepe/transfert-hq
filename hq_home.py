"""Accueil layout: which cards show, in what order, and (desktop) in which column.

One small JSON file next to the other HQ state, shared by every device, so the phone and the PC show
the same home. Only known card keys are kept; anything else is dropped. The welcome header and the
action row are fixed and are not part of the layout.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import hq_state

KEYS = ("carnet", "today", "devices", "pc", "send", "feed")  # the default order (phone: one list; desktop: side column = DEFAULT_SIDE)
DEFAULT_SIDE = ("devices", "pc", "send")


def default() -> dict:
    return {"order": list(KEYS), "hidden": [], "side": list(DEFAULT_SIDE)}


def normalize(data: Any) -> dict:
    """A valid layout from anything: known keys only, each once, every card placed."""
    if not isinstance(data, dict):
        return default()
    order: list[str] = []
    for key in data.get("order") if isinstance(data.get("order"), list) else []:
        if isinstance(key, str) and key in KEYS and key not in order:
            order.append(key)
    order += [key for key in KEYS if key not in order]
    def subset(name: str) -> list[str]:
        raw = data.get(name)
        if not isinstance(raw, list):
            return list(DEFAULT_SIDE) if name == "side" else []
        return [key for key in order if key in raw]
    return {"order": order, "hidden": subset("hidden"), "side": subset("side")}


def load(path: Path) -> dict:
    try:
        return normalize(json.loads(Path(path).read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return default()


def save(path: Path, data: Any) -> dict:
    layout = normalize(data)
    with hq_state.path_lock(Path(path)):
        hq_state.write_json_atomic(Path(path), layout)
    return layout
