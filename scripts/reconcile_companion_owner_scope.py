"""Merge companion / personhood stores keyed by a stale owner id into the canonical one.

Default is dry-run. Pass --apply to write (backs up each touched file as .bak).

    python scripts/reconcile_companion_owner_scope.py
    python scripts/reconcile_companion_owner_scope.py --apply --owner-id usr_...

The canonical owner id defaults to the enabled admin user's ``id`` in bridge_config.json.
Stale prefixes always include sha256(\"admin\")[:32].
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import hq_state  # noqa: E402


def _prefix(owner_key: str) -> str:
    return hashlib.sha256(owner_key.encode("utf-8")).hexdigest()[:32]


def _load_json(path: Path) -> dict | list | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _merge_events(dst: list, src: list) -> list:
    seen = {e.get("id") for e in dst if isinstance(e, dict) and e.get("id")}
    out = list(dst)
    for event in src:
        if not isinstance(event, dict):
            continue
        eid = event.get("id")
        if eid and eid in seen:
            continue
        out.append(event)
        if eid:
            seen.add(eid)
    out.sort(key=lambda e: float(e.get("at") or 0) if isinstance(e, dict) else 0)
    return out[-80:]


def _merge_list_by_id(dst: list, src: list, id_key: str = "id") -> list:
    seen = {row.get(id_key) for row in dst if isinstance(row, dict) and row.get(id_key)}
    out = list(dst)
    for row in src:
        if not isinstance(row, dict):
            continue
        rid = row.get(id_key)
        if rid and rid in seen:
            continue
        out.append(row)
        if rid:
            seen.add(rid)
    return out


def _merge_companion(dst: dict, src: dict) -> dict:
    merged = dict(dst)
    merged["memories"] = _merge_list_by_id(dst.get("memories") or [], src.get("memories") or [])
    merged["episodes"] = _merge_list_by_id(dst.get("episodes") or [], src.get("episodes") or [])
    merged["followups"] = _merge_list_by_id(dst.get("followups") or [], src.get("followups") or [])
    merged["revision"] = max(int(dst.get("revision") or 0), int(src.get("revision") or 0)) + 1
    return merged


def _merge_self(dst: dict, src: dict) -> dict:
    merged = dict(dst)
    merged["events"] = _merge_events(dst.get("events") or [], src.get("events") or [])
    for key in ("history", "values", "self_notes", "pinned", "dismissed", "used_feedback"):
        if key in src and key not in dst:
            merged[key] = src[key]
    return merged


def _admin_from_config(config_path: Path) -> tuple[str, str]:
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "", ""
    for user in config.get("users") or []:
        if not isinstance(user, dict):
            continue
        if user.get("role") == "admin" and user.get("enabled", True):
            return str(user.get("id") or "").strip(), str(user.get("name") or "").strip()
    return "", ""


def _stale_prefixes(canonical: str, extra: list[str]) -> list[str]:
    out = {_prefix("admin")}
    for key in extra:
        if key and _prefix(key) != _prefix(canonical):
            out.add(_prefix(key))
    canon_pref = _prefix(canonical)
    out.discard(canon_pref)
    return sorted(out)


def _paths_for(prefix: str, base: Path) -> list[Path]:
    mem = base / ".hq-ai" / "companion-memory"
    rel = base / ".hq-ai" / "relationships" / f"{prefix}.json"
    found: list[Path] = []
    if mem.is_dir():
        for p in mem.rglob(f"{prefix}.json"):
            found.append(p)
        for p in mem.rglob(f"{prefix}_self.json"):
            found.append(p)
        for p in mem.rglob(f"{prefix}_visits.json"):
            found.append(p)
    if rel.is_file():
        found.append(rel)
    return found


def _reconcile_pair(stale_path: Path, canon_path: Path, *, apply: bool) -> str:
    stale = _load_json(stale_path)
    if stale is None:
        return f"skip unreadable stale {stale_path.name}"
    if not canon_path.is_file():
        if apply:
            canon_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(stale_path, canon_path.with_suffix(canon_path.suffix + ".bak-src"))
            hq_state.write_json_atomic(canon_path, stale)
            if stale_path.resolve() != canon_path.resolve():
                stale_path.unlink()
        return f"move {stale_path.relative_to(ROOT)} -> {canon_path.relative_to(ROOT)}"
    canon = _load_json(canon_path)
    if canon is None or not isinstance(canon, dict) or not isinstance(stale, dict):
        return f"skip merge (non-dict) {stale_path.name}"
    if stale_path.name.endswith("_self.json") or (
        stale_path.name.endswith(".json") and isinstance(stale.get("events"), list)
    ):
        merged = _merge_self(canon, stale)
    elif "memories" in stale or "episodes" in stale:
        merged = _merge_companion(canon, stale)
    elif "pairs" in stale:
        pairs = dict(canon.get("pairs") or {})
        for key, row in (stale.get("pairs") or {}).items():
            if key not in pairs:
                pairs[key] = row
        merged = {**canon, "pairs": pairs}
    else:
        return f"skip unknown shape {stale_path.name}"
    if apply:
        backup = canon_path.with_suffix(canon_path.suffix + ".bak")
        shutil.copy2(canon_path, backup)
        hq_state.write_json_atomic(canon_path, merged)
        if stale_path.resolve() != canon_path.resolve() and stale_path.is_file():
            stale_path.unlink()
    return f"merge {stale_path.relative_to(ROOT)} into {canon_path.relative_to(ROOT)}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="HQ project root")
    parser.add_argument("--owner-id", default="", help="Canonical account id (default: admin id from config)")
    parser.add_argument("--stale-key", action="append", default=[], help="Extra stale owner string (display name, etc.)")
    parser.add_argument("--apply", action="store_true", help="Write merged files (default: dry-run)")
    args = parser.parse_args()
    base = args.root.resolve()
    hq_state.bind_root(base)
    config_path = base / "bridge_config.json"
    default_id, default_name = _admin_from_config(config_path)
    canonical = args.owner_id.strip() or default_id
    if not canonical:
        print("No canonical owner id; pass --owner-id or fix bridge_config.json", file=sys.stderr)
        return 2
    stale_keys = list(args.stale_key)
    if default_name and default_name not in stale_keys:
        stale_keys.append(default_name)
    stale_prefs = _stale_prefixes(canonical, stale_keys)
    canon_pref = _prefix(canonical)
    print(f"canonical owner={canonical!r} prefix={canon_pref}")
    print(f"stale prefixes: {', '.join(stale_prefs)}")
    actions: list[str] = []
    for stale_pref in stale_prefs:
        for stale_path in _paths_for(stale_pref, base):
            rel = stale_path.relative_to(base)
            parts = list(rel.parts)
            # swap prefix in filename
            name = stale_path.name
            canon_name = name.replace(stale_pref, canon_pref, 1)
            canon_path = stale_path.with_name(canon_name)
            actions.append(_reconcile_pair(stale_path, canon_path, apply=args.apply))
    for line in actions:
        print(line)
    if not actions:
        print("Nothing to reconcile under companion-memory / relationships.")
    elif not args.apply:
        print("Dry-run only; re-run with --apply to write.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())