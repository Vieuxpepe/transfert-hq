"""Atomic JSON persistence for Transfert HQ v7 state files.

One lock per path. Writers serialize to a sibling ``*.json.tmp``, flush, fsync,
then ``os.replace``. A file that is not valid JSON is left untouched.

Companion secrets live in ``<root>/.hq-agent-state/``. The temp file is created
in that same directory, so it inherits the directory ACL before replace.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

_GUARD = threading.Lock()
_LOCKS: dict[str, threading.RLock] = {}

# Private directory for companion secrets. Not the artifact inbox.
AGENT_STATE_DIR = ".hq-agent-state"
AGENT_STATE_FILES = ("hq_agents.json", "hq_agent_jobs.json", "hq_planner.json")


def agent_state_dir(root: Path | str) -> Path:
    return Path(root) / AGENT_STATE_DIR


def prepare_agent_state(root: Path | str) -> Path:
    """Create the private state directory and migrate legacy root files once.

    A legacy file moves only when the destination is absent. If both copies
    exist, nothing is chosen and nothing is overwritten. Bytes are not parsed,
    so a malformed file is preserved. No file contents are logged.
    """
    base = Path(root)
    dest_dir = agent_state_dir(base)
    planned: list[tuple[Path, Path]] = []
    conflicts: list[str] = []
    for name in AGENT_STATE_FILES:
        old = base / name
        new = dest_dir / name
        if old.exists() and new.exists():
            conflicts.append(name)
            continue
        if old.exists():
            if not old.is_file():
                raise RuntimeError(f"{name} conservé — pas un fichier")
            planned.append((old, new))
    if conflicts:
        raise RuntimeError(
            "état agent en double ("
            + ", ".join(conflicts)
            + ") — présent à la racine et dans .hq-agent-state. Aucun fichier écrasé."
        )
    dest_dir.mkdir(parents=True, exist_ok=True)
    linked: list[tuple[Path, Path]] = []
    try:
        for old, new in planned:
            if new.exists():
                raise RuntimeError(f"{old.name} déjà présent dans .hq-agent-state — aucun fichier écrasé")
            try:
                os.link(old, new)
            except FileExistsError as exc:
                raise RuntimeError(f"{old.name} déjà présent dans .hq-agent-state — aucun fichier écrasé") from exc
            except OSError as exc:
                raise RuntimeError(f"{old.name} non déplacé — fichier conservé") from exc
            linked.append((old, new))
        for old, _new in linked:
            os.unlink(old)
    except Exception:
        for old, new in linked:
            if old.exists() and new.exists():
                try:
                    new.unlink()
                except OSError:
                    pass
        raise
    return dest_dir


def path_lock(path: Path | str) -> threading.RLock:
    key = str(Path(path))
    with _GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _LOCKS[key] = lock
        return lock


def write_json_atomic(path: Path | str, data: Any) -> None:
    """Replace ``path`` with JSON ``data``.

    Raises RuntimeError when the current file exists but is not a JSON object
    or array — the bytes on disk are preserved.
    """
    dest = Path(path)
    lock = path_lock(dest)
    with lock:
        if dest.is_file():
            try:
                existing = json.loads(dest.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:
                raise RuntimeError(f"{dest.name} illisible — fichier conservé") from e
            if not isinstance(existing, (dict, list)):
                raise RuntimeError(f"{dest.name} illisible — fichier conservé")
        text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        # Same directory as dest, so a private-state temp file inherits that
        # directory ACL (controller-only) before os.replace.
        tmp = dest.parent / (dest.name + ".tmp")
        try:
            with tmp.open("w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, dest)
        except Exception:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise
