"""Atomic JSON persistence for Transfert HQ v7 state files.

One lock per path. Writers serialize to a sibling ``*.json.tmp``, flush, fsync,
then ``os.replace``. A file that is not valid JSON is left untouched.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

_GUARD = threading.Lock()
_LOCKS: dict[str, threading.RLock] = {}


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
