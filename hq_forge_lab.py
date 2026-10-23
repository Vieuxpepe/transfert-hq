"""Laboratoire: read-only views over the generation statistics (phase A records).

Three separate views, never one score: speed, reliability and keep rate. Honesty
rules: a setting needs MIN_SAMPLES measurements before it is compared, only
comparable runs (same checkpoint, size and hires) sit side by side, settings that
were only ever measured together are named as confounded, and no cause is
guessed. Only normal-mode data exists here; the private vault never writes stats.
"""

from __future__ import annotations

from pathlib import Path

import hq_forge_gallery as gallery
import hq_forge_stats as stats

MIN_SAMPLES = 20
PLAN_MIN = 5  # planner: fewer measurements than this for a device -> "Pas assez de donn\u00e9es"


def _quantile(values: list, q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    return round(ordered[low] + (ordered[high] - ordered[low]) * (pos - low), 2)


def _checkpoint(row: dict) -> str:
    return row.get("checkpoint") or (row.get("checkpoint_sha256") or "")[:12] or "?"


def _device(row: dict) -> str:
    return row.get("device_name") or ("Cet HQ" if row.get("device_id") == "local" else row.get("device_id") or "?")


def _bucket(row: dict) -> tuple:
    return (_checkpoint(row), int(row.get("width") or 0), int(row.get("height") or 0), bool(row.get("hires")))


def _bucket_public(key: tuple) -> dict:
    return {"checkpoint": key[0], "width": key[1], "height": key[2], "hires": key[3]}


def _setting(row: dict) -> tuple:
    return (_device(row), row.get("sampler_name") or "?", int(row.get("steps") or 0))


def _settings_for_form(bucket: tuple, setting: tuple, sample: dict) -> dict:
    """What 'Appliquer ces r\u00e9glages' may put in the form: technical fields only, never a prompt."""
    out = {"width": bucket[1], "height": bucket[2], "steps": setting[2], "sampler_name": setting[1]}
    if sample.get("checkpoint"):
        out["checkpoint"] = sample["checkpoint"]
    if sample.get("scheduler"):
        out["scheduler"] = sample["scheduler"]
    if isinstance(sample.get("cfg_scale"), (int, float)):
        out["cfg_scale"] = sample["cfg_scale"]
    return out


def _grouped(rows: list) -> dict:
    out: dict = {}
    for row in rows:
        out.setdefault(_bucket(row), {}).setdefault(_setting(row), []).append(row)
    return out


def speed(rows: list) -> list:
    done = [row for row in rows if row.get("outcome") == "completed" and isinstance(row.get("duration_s"), (int, float))]
    groups = []
    for bucket, settings in _grouped(done).items():
        items = []
        for setting, members in settings.items():
            values = [float(row["duration_s"]) for row in members]
            enough = len(values) >= MIN_SAMPLES
            items.append({
                "device": setting[0], "sampler": setting[1], "steps": setting[2], "samples": len(values), "enough": enough,
                "median_s": _quantile(values, 0.5) if enough else None,
                "low_s": _quantile(values, 0.2) if enough else None, "high_s": _quantile(values, 0.8) if enough else None,
                "settings": _settings_for_form(bucket, setting, members[-1]),
            })
        items.sort(key=lambda item: (not item["enough"], item["median_s"] or 0, item["device"]))
        groups.append({**_bucket_public(bucket), "rows": items})
    groups.sort(key=lambda group: -sum(item["samples"] for item in group["rows"]))
    return groups


def reliability(rows: list) -> list:
    groups = []
    for bucket, settings in _grouped(rows).items():
        items = []
        for setting, members in settings.items():
            outcomes = [row.get("outcome") for row in members]
            errors: dict = {}
            for row in members:
                if row.get("outcome") in ("failed", "uncertain") and row.get("error"):
                    errors[row["error"]] = errors.get(row["error"], 0) + 1
            total = len(members)
            items.append({
                "device": setting[0], "sampler": setting[1], "steps": setting[2], "samples": total,
                "enough": total >= MIN_SAMPLES, "completed": outcomes.count("completed"), "failed": outcomes.count("failed"),
                "uncertain": outcomes.count("uncertain"), "cancelled": outcomes.count("cancelled"), "lost": outcomes.count("lost"),
                "errors": sorted(({"code": code, "count": count} for code, count in errors.items()), key=lambda e: -e["count"])[:3],
                "settings": _settings_for_form(bucket, setting, members[-1]),
            })
        items.sort(key=lambda item: (not item["enough"], -(item["completed"] / item["samples"]) if item["samples"] else 0, item["device"]))
        groups.append({**_bucket_public(bucket), "rows": items})
    groups.sort(key=lambda group: -sum(item["samples"] for item in group["rows"]))
    return groups


def keep_rate(rows: list, flags: dict) -> list:
    """Share of sorted images kept (garder or favori). Unsorted images are not counted either way."""
    sorted_rows = [row for row in rows if row.get("outcome") == "completed" and flags.get(row.get("image_id") or "", "none") != "none"]
    groups = []
    for bucket, settings in _grouped(sorted_rows).items():
        items = []
        for setting, members in settings.items():
            kept = sum(1 for row in members if flags.get(row["image_id"]) in ("keep", "favorite"))
            favorite = sum(1 for row in members if flags.get(row["image_id"]) == "favorite")
            items.append({
                "device": setting[0], "sampler": setting[1], "steps": setting[2], "samples": len(members),
                "enough": len(members) >= MIN_SAMPLES, "kept": kept, "favorite": favorite, "rejected": len(members) - kept,
                "settings": _settings_for_form(bucket, setting, members[-1]),
            })
        items.sort(key=lambda item: (not item["enough"], -(item["kept"] / item["samples"]), item["device"]))
        groups.append({**_bucket_public(bucket), "rows": items})
    groups.sort(key=lambda group: -sum(item["samples"] for item in group["rows"]))
    return groups


_DIMENSIONS = {
    "device": _device,
    "checkpoint": _checkpoint,
    "sampler": lambda row: row.get("sampler_name") or "?",
    "size": lambda row: f"{row.get('width')}\u00d7{row.get('height')}",
}
_PAIRS = (("device", "checkpoint"), ("sampler", "device"), ("sampler", "checkpoint"), ("device", "size"))


def confounded(rows: list) -> list:
    """Values that were only ever measured together: their effects cannot be separated."""
    out = []
    for left, right in _PAIRS:
        lf, rf = _DIMENSIONS[left], _DIMENSIONS[right]
        seen: dict = {}
        for row in rows:
            seen.setdefault(lf(row), set()).add(rf(row))
        rights = set().union(*seen.values()) if seen else set()
        if len(seen) < 2 or len(rights) < 2:
            continue
        for value, partners in sorted(seen.items()):
            if len(partners) == 1:
                out.append({"kind": left, "value": value, "with_kind": right, "with": next(iter(partners))})
    return out[:12]


def _int(query: dict, key: str, low: int, high: int) -> int | None:
    try:
        value = int((query.get(key) or [""])[0])
    except (TypeError, ValueError):
        return None
    return value if low <= value <= high else None


def plan(rows: list, query: dict) -> dict | None:
    """Duration range per device and a suggested split from real measurements of the same
    size, steps and hires. Extends the usual-duration estimate; never decides anything."""
    width, height = _int(query, "width", 64, 4096), _int(query, "height", 64, 4096)
    steps, count = _int(query, "steps", 1, 200), _int(query, "count", 1, 64)
    if not (width and height and steps and count):
        return None
    hires = (query.get("hires") or ["0"])[0] == "1"
    checkpoint = (query.get("checkpoint") or [""])[0][:200]
    same = [row for row in rows if row.get("width") == width and row.get("height") == height and bool(row.get("hires")) == hires]
    timed = [row for row in same if row.get("steps") == steps and row.get("outcome") == "completed" and isinstance(row.get("duration_s"), (int, float))]
    if checkpoint and any(row.get("checkpoint") == checkpoint for row in timed):
        timed = [row for row in timed if row.get("checkpoint") == checkpoint]
    per: dict = {}
    for row in timed:
        per.setdefault(_device(row), []).append(float(row["duration_s"]))
    devices = []
    for name, values in sorted(per.items()):
        enough = len(values) >= PLAN_MIN
        item = {"device": name, "samples": len(values), "enough": enough}
        if enough:
            item.update(per_image_s=_quantile(values, 0.5), low_s=round(_quantile(values, 0.2) * count, 1), high_s=round(_quantile(values, 0.8) * count, 1))
        devices.append(item)
    ready = [item for item in devices if item["enough"]]
    split = None
    if len(ready) >= 2:
        weights = [1.0 / max(0.01, item["per_image_s"]) for item in ready]
        total = sum(weights)
        raw = [count * w / total for w in weights]
        shares = [int(r) for r in raw]
        for i in sorted(range(len(raw)), key=lambda i: raw[i] - shares[i], reverse=True)[: count - sum(shares)]:
            shares[i] += 1
        low = max(_quantile(per[item["device"]], 0.2) * share for item, share in zip(ready, shares))
        high = max(_quantile(per[item["device"]], 0.8) * share for item, share in zip(ready, shares))
        split = {"shares": [{"device": item["device"], "count": share} for item, share in zip(ready, shares) if share],
                 "low_s": round(low, 1), "high_s": round(high, 1)}
    memory: dict = {}
    for row in same:
        if row.get("outcome") == "failed" and row.get("error") == "forge_oom":
            batch = int(row.get("n_iter") or row.get("count") or 1)
            key = (_device(row), batch)
            memory[key] = memory.get(key, 0) + 1
    warnings = [{"device": device, "batch": batch, "times": times} for (device, batch), times in sorted(memory.items()) if count >= batch]
    return {"width": width, "height": height, "steps": steps, "hires": hires, "count": count, "min_samples": PLAN_MIN,
            "devices": devices, "split": split, "memory": warnings}


def summary(root: Path, query: dict | None = None) -> dict:
    rows = [row for row in stats.records(root) if row.get("kind") in ("job", "batch")]
    if query and (query.get("plan") or [""])[0] == "1":
        return {"vault_excluded": True, "plan": plan(rows, query)}
    flags = gallery.triage_map(root)
    return {
        "min_samples": MIN_SAMPLES,
        "records": len(rows),
        "vault_excluded": True,
        "speed": speed(rows),
        "reliability": reliability(rows),
        "keep": keep_rate(rows, flags),
        "confounded": confounded(rows),
    }