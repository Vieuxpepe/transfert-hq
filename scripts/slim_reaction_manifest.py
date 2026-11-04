"""Write manifest.runtime.json — routing-only payload for in-browser reaction audio."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BANK = ROOT / "assets/companion/chat/reactions"
FULL = BANK / "manifest.json"
RUNTIME = BANK / "manifest.runtime.json"
ROUTE_KEYS = ("url", "duration_ms", "natural", "model")


def slim_sample(entry: dict) -> dict:
    return {key: entry[key] for key in ROUTE_KEYS if key in entry}


def slim_pool(pool) -> list | dict:
    if isinstance(pool, list):
        return [slim_sample(item) for item in pool if isinstance(item, dict) and item.get("url")]
    if isinstance(pool, dict) and pool.get("url"):
        return slim_sample(pool)
    return pool


def slim_manifest(full: dict) -> dict:
    out: dict = {"samples": {}, "phases": {}, "impacts": {}}
    idle = (full.get("mastering") or {}).get("idle_playback_gain_db")
    if idle is not None:
        out["mastering"] = {"idle_playback_gain_db": idle}
    m = full.get("mastering") or {}
    out.setdefault("mastering", {})
    for key in (
        "voice_playback_gain_db",
        "phase_playback_gain_db",
        "impact_playback_gain_db",
    ):
        if m.get(key) is not None:
            out["mastering"][key] = m[key]
    if "idle_playback_gain_db" not in out["mastering"] and idle is not None:
        out["mastering"]["idle_playback_gain_db"] = idle
    for section in ("samples", "phases", "impacts"):
        for key, pool in (full.get(section) or {}).items():
            slimmed = slim_pool(pool)
            if slimmed:
                out[section][key] = slimmed
    return out


def write_runtime_manifest(full_path: Path = FULL, runtime_path: Path = RUNTIME) -> int:
    full = json.loads(full_path.read_text(encoding="utf-8"))
    runtime = slim_manifest(full)
    runtime_path.write_text(json.dumps(runtime, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return len(runtime_path.read_bytes())


def main() -> None:
    size = write_runtime_manifest()
    print(f"manifest.runtime.json bytes={size}")


if __name__ == "__main__":
    main()
