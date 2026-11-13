"""Episode-backed development for the non-companion assistants.

Culinia, Forgia, Musica, Inventoria, Pistonia and Securia reuse the growth engine
that backs Transferania's development, but each assistant supplies its own file
path. Nothing here reads or writes the companion store or another assistant's
file. A file that exists but is unreadable is preserved and ignored.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import hq_companion_growth as growth
import hq_state

log = logging.getLogger(__name__)
KINDS = {"outcome", "decision", "correction", "experience", "interest", "meaning", "ritual"}
STATUSES = {"active", "superseded", "forgotten"}
_LIMIT = 40
_lock = threading.RLock()
_UNREADABLE = object()


def _schema_ok(episodes: Any) -> bool:
    if not isinstance(episodes, list):
        return False
    for episode in episodes:
        if not isinstance(episode, dict) or not isinstance(episode.get("text"), str) or not episode["text"].strip():
            return False
        if episode.get("kind") not in KINDS or episode.get("status") not in STATUSES:
            return False
        if not isinstance(episode.get("topic", ""), str) or not isinstance(episode.get("id"), str):
            return False
        at = episode.get("at")
        if isinstance(at, bool) or not isinstance(at, (int, float)):
            return False
    return True


def _load(path: Path) -> list[dict[str, Any]] | object:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        log.warning("growth file unreadable; development skipped (%s)", path.name)
        return _UNREADABLE
    episodes = data.get("episodes") if isinstance(data, dict) else None
    if not _schema_ok(episodes):
        log.warning("growth file invalid; development skipped (%s)", path.name)
        return _UNREADABLE
    return [dict(e) for e in episodes]


def record(path: Path, text: str, device: str) -> None:
    """Keep only explicit statements the growth engine recognises."""
    item = growth.extract(text)
    if not item:
        return
    try:
        with _lock:
            episodes = _load(path)
            if episodes is _UNREADABLE:
                return
            now = time.time()
            today = time.strftime("%Y-%m-%d", time.localtime(now))
            for episode in episodes:
                if (episode.get("status") == "active"
                        and growth.fold(episode["text"]) == growth.fold(item["text"])
                        and time.strftime("%Y-%m-%d", time.localtime(float(episode["at"]))) == today):
                    return
            episodes.append({"id": uuid.uuid4().hex, "text": item["text"], "kind": item["kind"],
                             "topic": item["topic"], "at": now, "status": "active",
                             "source_device": device, "evidence": "user_statement"})
            path.parent.mkdir(parents=True, exist_ok=True)
            hq_state.write_json_atomic(path, {"episodes": episodes[-_LIMIT:]})
    except Exception:
        log.warning("growth episode not saved (%s)", path.name, exc_info=True)


def hint(path: Path, query: str) -> str:
    """At most one topic-relevant, revisable view — never a personality rewrite."""
    episodes = _load(path)
    if episodes is _UNREADABLE:
        return ""
    cards = growth.derive(episodes, time.time())
    words = set(re.findall(r"[a-z0-9]{4,}", growth.fold(query)))
    if not words:
        return ""
    related = [c for c in cards
               if words & set(re.findall(r"[a-z0-9]{4,}", growth.fold(c.get("topic", ""))))]
    if not related:
        return ""
    card = max(related, key=lambda c: (c.get("salience", 0), c.get("updated_at", 0)))
    return growth.render(card)
