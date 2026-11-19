"""Prove the earned bond survives its raw day rows, on a copy of the live store.

Copies the live stores into a temp root (never touching the originals), removes the
raw personhood day rows for the pair that earned its echo, then asks the real visit
route for the note and the payload marker again.

    python -X utf8 scripts/verify_echo_ageing.py
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAIR = ("culinia", "pistonia")
STRANGERS = ("culinia", "musica")
TREES = (".hq-ai/relationships", ".hq-ai/companion-memory", ".hq-engine",
         ".hq-household", ".hq-forge", ".hq-security")


def _live_owner() -> str:
    """The owner key the live bridge stores relationships under.

    Production uses the authenticated account id (``session_memory_owner``), not
    the display name: asking for the display name reads an empty legacy file and
    would report a bond that was never lost.
    """
    import hq_security
    try:
        sessions = json.loads((ROOT / "bridge_sessions.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        sessions = {}
    rows = [row for row in sessions.values() if isinstance(row, dict)] if isinstance(sessions, dict) else []
    rows = [row for row in rows if row.get("role") == "admin"]
    rows.sort(key=lambda row: float(row.get("last_active") or 0), reverse=True)
    return hq_security.session_memory_owner(rows[0] if rows else None)


def _copy_live(tmp: Path) -> None:
    for rel in TREES:
        source = ROOT / rel
        if not source.exists():
            continue
        target = tmp / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target, dirs_exist_ok=True)


def _age_out_days(tmp: Path) -> list[str]:
    """Empty the raw day rows in the copied self models, leaving the pair record."""
    cleared = []
    for path in tmp.rglob("*_self.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or not data.get("events"):
            continue
        data["events"] = []
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        cleared.append(str(path.relative_to(tmp)))
    return cleared


def main() -> int:
    sys.path.insert(0, str(ROOT))
    tmp = Path(tempfile.mkdtemp(prefix="hq-echo-age-"))
    try:
        _copy_live(tmp)
        cleared = _age_out_days(tmp)

        import hq_ai
        import hq_assistant_visits as visits
        import hq_companion_memory as memory
        import hq_culinia
        import hq_engine
        import hq_personhood as ph
        import hq_relationships as rel

        hq_ai.bind(root=tmp, now=lambda: time.time(), key=lambda: "", extra_keys=lambda: [])
        hq_engine.bind(tmp)
        hq_culinia.bind(root=tmp)
        memory.bind(root=tmp, now=time.time())
        owner = _live_owner()

        with memory.owner_context(owner):
            note = visits._pair_note(PAIR[0], PAIR[1], owner)
            bond = visits._bond_marker(PAIR[0], PAIR[1], owner)
            stranger_note = visits._pair_note(STRANGERS[0], STRANGERS[1], owner)
            stranger_bond = visits._bond_marker(STRANGERS[0], STRANGERS[1], owner)
            days = {key: ph.bond(key, owner=owner)["days"] for key in ("culinia", "pistonia", "musica")}
            earned = rel.echo_earned(None, PAIR[0], PAIR[1], owner=owner)

        ok = bool(note) and bool(bond.get("text")) and not stranger_note and not stranger_bond
        print(json.dumps({
            "owner": owner,
            "cleared_self_models": cleared,
            "raw_days_after_ageing": days,
            "echo_earned_at": earned,
            "pair_note": note or None,
            "batch_marker": bond or None,
            "stranger_note": stranger_note or None,
            "stranger_marker": stranger_bond or None,
            "ok": ok,
        }, ensure_ascii=False, indent=2))
        return 0 if ok else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
