"""Pairwise familiarity between HQ assistants, derived from real exchanges.

Evidence only: distinct days of exchange (capped), the exchange count, the last
timestamp and one short motif. There is no affection score, no debt and no
private chat invented between assistants: each pair lives in its own
owner-scoped file under ``.hq-ai/relationships/`` and the per-assistant memory
stores are never merged.

Canon: ``docs/companion-family.md`` (sisters stay affectionate and playfully
competitive; Static remains Else's little sister in the lab).
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from datetime import datetime
from pathlib import Path

import hq_personas
import hq_state

MAX_PAIRS = 24
MAX_DAYS = 30
MOTIF_CHARS = 160
_lock = threading.RLock()
_root = Path(".")


def bind(root) -> None:
    global _root
    _root = Path(root)


def _owner() -> str:
    """Fail closed: no established owner means no relationship record, never admin's."""
    import hq_companion_memory as memory
    owner = memory.current_owner()
    # The context default is "admin"; only an explicitly established owner may
    # read or write relationship evidence, so an unbound request cannot inherit
    # the admin account's file.
    if not memory.owner_established() or owner is None or not str(owner).strip():
        raise RuntimeError("relations indisponibles — propriétaire inconnu")
    return str(owner)


def _path(root=None) -> Path:
    base = Path(root or _root) / ".hq-ai" / "relationships"
    return base / (hashlib.sha256(_owner().encode("utf-8")).hexdigest()[:32] + ".json")


def _empty() -> dict:
    return {"v": 1, "pairs": {}}


def _load(root=None) -> dict:
    p = _path(root)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _empty()
    except (OSError, ValueError) as exc:
        raise RuntimeError("relations indisponibles — fichier conservé") from exc
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("pairs"), dict):
        raise RuntimeError("relations indisponibles — fichier conservé")
    return data


def _key(a: str, b: str) -> str:
    x, y = sorted((hq_personas.get(a)["key"], hq_personas.get(b)["key"]))
    return f"{x}|{y}"


def _clean(text) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()[:MOTIF_CHARS]


def note_exchange(root, a, b, text="", *, kind="exchange", now=None) -> dict:
    """Record one real exchange between two assistants. Never called by a timer."""
    ka, kb = hq_personas.get(a)["key"], hq_personas.get(b)["key"]
    if ka == kb:
        raise ValueError("un échange demande deux assistants distincts")
    stamp = float(now if now is not None else time.time())
    motif = _clean(text)
    with _lock:
        data = _load(root)
        key = _key(ka, kb)
        row = data["pairs"].get(key) or {"a": min(ka, kb), "b": max(ka, kb),
                                         "exchanges": 0, "days": [], "last_at": 0.0, "motif": ""}
        row["exchanges"] = int(row.get("exchanges") or 0) + 1
        day = datetime.fromtimestamp(stamp).date().isoformat()
        # A single sitting cannot reinforce familiarity: one entry per day.
        days = [d for d in (row.get("days") or []) if isinstance(d, str) and d != day]
        row["days"] = (days + [day])[-MAX_DAYS:]
        row["last_at"] = stamp
        if motif:
            row["motif"] = motif
        if kind:
            row["kind"] = str(kind)[:24]
        data["pairs"][key] = row
        if len(data["pairs"]) > MAX_PAIRS:
            keep = sorted(data["pairs"].items(), key=lambda kv: kv[1].get("last_at") or 0)[-MAX_PAIRS:]
            data["pairs"] = dict(keep)
        p = _path(root)
        p.parent.mkdir(parents=True, exist_ok=True)
        hq_state.write_json_atomic(p, data)
    return pair(root, ka, kb)


def pair(root, a, b) -> dict:
    ka, kb = hq_personas.get(a)["key"], hq_personas.get(b)["key"]
    row = _load(root)["pairs"].get(_key(ka, kb)) or {}
    return {"a": ka, "b": kb, "exchanges": int(row.get("exchanges") or 0),
            "days": len(row.get("days") or []), "last_at": float(row.get("last_at") or 0.0),
            "motif": str(row.get("motif") or "")}


def line(root, a, b, *, lang="fr") -> str:
    """Short familiarity note for a prompt; empty until two distinct days exist.

    Not yet injected by any production prompt; kept for a future mastery line.
    """
    row = pair(root, a, b)
    if row["days"] < 2:
        return ""
    me = hq_personas.get(a)["key"]
    # Plain name only: a prompt line must never carry the other assistant's alias.
    other = hq_personas.get(row["b"] if row["a"] == me else row["a"])["name"]
    if str(lang).lower().startswith("en"):
        return (f"Familiarity with {other}: {row['days']} separate days of exchange. "
                "Evidence only — no invented past, no emotional debt.")
    return (f"Familiarité avec {other} : {row['days']} jours distincts d'échange. "
            "Preuve seulement — aucun passé inventé, aucune dette affective.")
