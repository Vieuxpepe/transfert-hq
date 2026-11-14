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

KEYS = (
    "carnet", "today", "musica", "brief", "devices", "pc", "send", "feed",
    "budget", "meals", "stock", "forge", "projects", "quests",
)  # the default order (phone: one list; desktop: side column = DEFAULT_SIDE)
DEFAULT_SIDE = ("devices", "pc", "send")
PLACED_AFTER = {"musica": "today"}  # cards added later: where an older saved layout gains them


LAYOUT_V = 2  # 2 = the status cards (budget, meals, stock, forge, projects, quests) exist
STATUS_CARDS = ("budget", "meals", "stock", "forge", "projects", "quests")


def default() -> dict:
    return {"v": LAYOUT_V, "order": list(KEYS), "hidden": [], "side": list(DEFAULT_SIDE) + list(STATUS_CARDS)}


def normalize(data: Any) -> dict:
    """A valid layout from anything: known keys only, each once, every card placed."""
    if not isinstance(data, dict):
        return default()
    order: list[str] = []
    for key in data.get("order") if isinstance(data.get("order"), list) else []:
        if isinstance(key, str) and key in KEYS and key not in order:
            order.append(key)
    for key in PLACED_AFTER:  # a recent card the saved layout never saw goes next to its neighbour, not at the bottom
        if key not in order and PLACED_AFTER[key] in order:
            order.insert(order.index(PLACED_AFTER[key]) + 1, key)
    order += [key for key in KEYS if key not in order]
    def subset(name: str) -> list[str]:
        raw = data.get(name)
        if not isinstance(raw, list):
            return list(DEFAULT_SIDE) if name == "side" else []
        return [key for key in order if key in raw]
    side = subset("side")
    hidden = subset("hidden")
    if data.get("v") == LAYOUT_V:
        return {"v": LAYOUT_V, "order": order, "hidden": hidden, "side": side}
    # A layout saved before the status cards existed: they start in the short side column.
    for key in STATUS_CARDS:
        if key not in side and key not in hidden:
            side.append(key)
    return {"v": LAYOUT_V, "order": order, "hidden": hidden, "side": side}


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
