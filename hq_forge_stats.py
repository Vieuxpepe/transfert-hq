"""Generation statistics for Forge Studio: settings, durations and outcomes only.

One record per image (or per failed attempt). Never a prompt, never a negative
prompt, never anything from the private vault: only normal-mode jobs and
multi-device batches write here. Old installs simply have no file yet.
"""

from __future__ import annotations

import json
import math
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

MAX_RECORDS = 5000
OUTCOMES = {"completed", "failed", "uncertain", "cancelled", "lost"}
_LOCK = threading.Lock()

# key -> (type, limit). Anything else is dropped, so a prompt can never be stored by mistake.
_FIELDS = {
    "ts": (str, 40), "kind": (str, 8), "job_id": (str, 40), "batch_id": (str, 40), "task_id": (str, 40),
    "image_id": (str, 40), "device_id": (str, 40), "device_name": (str, 40), "checkpoint": (str, 200),
    "checkpoint_sha256": (str, 64), "sampler_name": (str, 80), "scheduler": (str, 80), "error": (str, 40),
    "outcome": (str, 12), "cfg_scale": (float, None), "steps": (int, None), "width": (int, None),
    "height": (int, None), "hires": (bool, None), "hr_scale": (float, None), "n_iter": (int, None),
    "count": (int, None), "seed": (int, None), "subseed_strength": (float, None), "duration_s": (float, None),
    "attempt": (int, None), "uncertain": (bool, None),
}


def _path(root: Path) -> Path:
    return Path(root) / ".hq-forge" / "stats.json"


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clean(record: dict) -> dict | None:
    if not isinstance(record, dict):
        return None
    out = {}
    for key, (kind, limit) in _FIELDS.items():
        value = record.get(key)
        if value is None:
            continue
        if kind is str:
            if isinstance(value, str) and 0 < len(value) <= limit and not any(ord(ch) < 32 for ch in value):
                out[key] = value
        elif kind is bool:
            if isinstance(value, bool):
                out[key] = value
        elif kind is int:
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 2**32:
                out[key] = value
        elif isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) and 0 <= float(value) < 1e7:
            out[key] = round(float(value), 3)
    if out.get("outcome") not in OUTCOMES:
        return None
    return out


def from_settings(settings: dict) -> dict:
    """The technical part of a job's settings. The prompt is not read."""
    s = settings if isinstance(settings, dict) else {}
    return {
        "checkpoint": s.get("checkpoint"), "sampler_name": s.get("sampler_name"), "scheduler": s.get("scheduler"),
        "cfg_scale": s.get("cfg_scale"), "steps": s.get("steps"), "width": s.get("width"), "height": s.get("height"),
        "hires": s.get("enable_hr") is True, "hr_scale": s.get("hr_scale") if s.get("enable_hr") is True else None,
        "n_iter": s.get("n_iter"), "seed": s.get("seed") if isinstance(s.get("seed"), int) and s.get("seed", -1) >= 0 else None,
        "subseed_strength": s.get("subseed_strength"),
    }


def _load(root: Path) -> list:
    path = _path(root)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows = data.get("records") if isinstance(data, dict) else None
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def record(root: Path, entry: dict) -> bool:
    if root is None:
        return False
    row = clean(entry)
    if row is None:
        return False
    row.setdefault("ts", now())
    with _LOCK:
        rows = _load(root)
        rows.append(row)
        rows = rows[-MAX_RECORDS:]
        path = _path(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name("stats.json.tmp")
        tmp.write_text(json.dumps({"version": 1, "records": rows}, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    return True


def records(root: Path) -> list:
    with _LOCK:
        return [row for row in (clean(item) for item in _load(root)) if row is not None]
