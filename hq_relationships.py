"""Pairwise familiarity between HQ assistants, derived from real exchanges.

Evidence only: distinct days of exchange (capped), the exchange count, the last
timestamp and one short motif. There is no affection score, no debt and no
private chat invented between assistants. All pairs for one owner live in that
owner's file under ``.hq-ai/relationships/`` (a ``pairs`` map), and the
per-assistant memory stores are never merged.

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

# The roster is eight assistants, so the family itself holds 28 pairs. A cap of
# 24 evicted the coldest pair exactly when it had just been given its first
# exchange, and its row disappeared from the panel that had just filled it.
MAX_PAIRS = 32
MAX_DAYS = 30
MOTIF_CHARS = 160
_lock = threading.RLock()
_root = Path(".")


def bind(root) -> None:
    global _root
    _root = Path(root)


def _owner_id(owner: str | None = None) -> str:
    """An explicitly named owner, else the established request one.

    Fail closed: no established owner means no relationship record, never
    admin's. Callers that already authenticated a request (a recorded visit)
    may name its owner instead of relying on the request context.
    """
    if owner is not None and str(owner).strip():
        return str(owner)
    import hq_companion_memory as memory
    current = memory.current_owner()
    # The context default is "admin"; only an explicitly established owner may
    # read or write relationship evidence, so an unbound request cannot inherit
    # the admin account's file.
    if not memory.owner_established() or current is None or not str(current).strip():
        raise RuntimeError("relations indisponibles — propriétaire inconnu")
    return str(current)


def _owner() -> str:
    return _owner_id()


def _base_root() -> Path:
    """The store root: an explicit bind, else whatever hq_state has bound.

    ``hq_sister`` writes with an explicit root, so an unbound reader must not
    fall back to the process working directory and silently find nothing.
    """
    return _root if _root != Path(".") else hq_state.state_root()


def _path(root=None, owner: str | None = None) -> Path:
    base = Path(root if root is not None else _base_root()) / ".hq-ai" / "relationships"
    return base / (hashlib.sha256(_owner_id(owner).encode("utf-8")).hexdigest()[:32] + ".json")


def _empty() -> dict:
    return {"v": 1, "pairs": {}}


def _load(root=None, owner: str | None = None) -> dict:
    p = _path(root, owner)
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


def note_exchange(root, a, b, text="", *, kind="exchange", now=None,
                  owner: str | None = None) -> dict:
    """Record one real exchange between two assistants.

    Only an exchange that actually happened is recorded: a visit the Master
    started, a sister's line, or a house-started visit in front of him. An idle
    tick never writes here; it has no dialogue to record.
    """
    ka, kb = hq_personas.get(a)["key"], hq_personas.get(b)["key"]
    if ka == kb:
        raise ValueError("un échange demande deux assistants distincts")
    stamp = float(now if now is not None else time.time())
    motif = _clean(text)
    with _lock:
        data = _load(root, owner)
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
        if kind == "famille":
            # Kept apart from ``last_at``: a later visit the Master opens must not
            # erase when the house itself last put this pair together.
            row["family_at"] = stamp
        data["pairs"][key] = row
        if len(data["pairs"]) > MAX_PAIRS:
            keep = sorted(data["pairs"].items(), key=lambda kv: kv[1].get("last_at") or 0)[-MAX_PAIRS:]
            data["pairs"] = dict(keep)
        p = _path(root, owner)
        p.parent.mkdir(parents=True, exist_ok=True)
        hq_state.write_json_atomic(p, data)
    return pair(root, ka, kb, owner=owner)


def mark_echo(root, a, b, *, now=None, owner: str | None = None) -> float:
    """Remember that this pair actually earned its shared, unspoken edge.

    Idempotent and kept beside the pair's own evidence, so the bond outlives the raw
    day rows in each assistant's self model: a day that ages out of retention must
    not turn a lived closeness back into a stranger's silence.
    """
    ka, kb = hq_personas.get(a)["key"], hq_personas.get(b)["key"]
    if ka == kb:
        return 0.0
    stamp = float(now if now is not None else time.time())
    with _lock:
        data = _load(root, owner)
        key = _key(ka, kb)
        row = data["pairs"].get(key) or {"a": min(ka, kb), "b": max(ka, kb),
                                         "exchanges": 0, "days": [], "last_at": 0.0, "motif": ""}
        earned = float(row.get("echo_at") or 0.0)
        if not earned:
            row["echo_at"] = stamp
            data["pairs"][key] = row
            p = _path(root, owner)
            p.parent.mkdir(parents=True, exist_ok=True)
            hq_state.write_json_atomic(p, data)
            earned = stamp
    return earned


def echo_earned(root, a, b, *, owner: str | None = None) -> float:
    """When this pair first earned its echo, or 0.0 if it never did."""
    try:
        ka, kb = hq_personas.get(a)["key"], hq_personas.get(b)["key"]
        row = _load(root, owner)["pairs"].get(_key(ka, kb)) or {}
    except (ValueError, RuntimeError):
        return 0.0
    try:
        return float(row.get("echo_at") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def pairs(root=None, *, owner: str | None = None) -> list[dict]:
    """Every stored pair, read-only, from a single file read.

    The family's own pacing needs the whole map at once (who spoke today, and
    how long ago the last pair did); asking pair by pair would read the same
    small file once per pair on every request.
    """
    out = []
    for row in _load(root, owner)["pairs"].values():
        if not isinstance(row, dict):
            continue
        out.append({"a": str(row.get("a") or ""), "b": str(row.get("b") or ""),
                    "exchanges": int(row.get("exchanges") or 0),
                    "days": len([d for d in (row.get("days") or []) if isinstance(d, str)]),
                    "last_at": float(row.get("last_at") or 0.0),
                    "family_at": float(row.get("family_at") or 0.0),
                    "kind": str(row.get("kind") or ""),
                    "motif": str(row.get("motif") or "")})
    return out


def pair(root, a, b, *, owner: str | None = None) -> dict:
    ka, kb = hq_personas.get(a)["key"], hq_personas.get(b)["key"]
    row = _load(root, owner)["pairs"].get(_key(ka, kb)) or {}
    return {"a": ka, "b": kb, "exchanges": int(row.get("exchanges") or 0),
            "days": len(row.get("days") or []), "last_at": float(row.get("last_at") or 0.0),
            "motif": str(row.get("motif") or "")}


TIER_MIN_DAYS = ((10, "complicite"), (5, "habitude"), (2, "connaissance"))
# How each tier is allowed to change behaviour. Evidence only: a tier names what
# the pair has actually lived, never a feeling they owe each other.
TIER_BEHAVIOUR = {
    "connaissance": "tu peux lui parler franchement, sans confidence inventée.",
    "habitude": "un clin d'œil à un moment partagé est permis; rien de plus n'est inventé.",
    "complicite": "vous avez vos raccourcis; ils restent facultatifs et jamais inventés.",
}
TIER_BEHAVIOUR_EN = {
    "connaissance": "you may be direct with her, without inventing confidences.",
    "habitude": "a nod to a shared moment is allowed; nothing more is invented.",
    "complicite": "you have your own shortcuts; they stay optional and never invented.",
}
TIER_LABEL = {"connaissance": "connaissance", "habitude": "habitude", "complicite": "complicité"}
TIER_LABEL_EN = {"connaissance": "acquaintance", "habitude": "habit", "complicite": "complicity"}

# Five rungs, so a pair that has barely met still names where it stands instead of
# reading like every other pair. Two axes, both made of real records. Distinct
# days can carry a pair on their own (a pair that turns up once a day for five
# days is a habit, whatever the word count), and real volume can reach a rung one
# day early but never more — one long sitting is not a complicity. Thresholds
# stay small because HQ is young: they separate a one-off from a standing pair,
# nothing more.
PAIR_STAGES = (
    {"stage": "complicite", "days": 10, "early": (4, 20)},
    {"stage": "habitude", "days": 5, "early": (2, 10)},
    {"stage": "connaissance", "days": 2},
    {"stage": "premier_jour", "days": 1},
    {"stage": "rencontre", "days": 0},
)
PAIR_STAGE_LABEL = {"rencontre": "rencontre", "premier_jour": "premier jour",
                    "connaissance": "connaissance", "habitude": "habitude", "complicite": "complicité"}
PAIR_STAGE_LABEL_EN = {"rencontre": "first meeting", "premier_jour": "first day",
                       "connaissance": "acquaintance", "habitude": "habit", "complicite": "complicity"}


def pair_stage(days, exchanges: int = 0) -> str:
    """The rung a pair stands on, from distinct days and real exchanges only."""
    try:
        count = int(days)
    except (TypeError, ValueError):
        count = 0
    try:
        said = int(exchanges or 0)
    except (TypeError, ValueError):
        said = 0
    for rung in PAIR_STAGES:
        if count >= rung["days"]:
            return rung["stage"]
        early = rung.get("early")
        if early and count >= early[0] and said >= early[1]:
            return rung["stage"]
    return PAIR_STAGES[-1]["stage"]


def fold_visits(root, evidence, *, owner: str | None = None) -> list[dict]:
    """Fold visits that were really recorded into each pair's evidence.

    ``evidence`` maps ``(a, b)`` to that pair's real visit moments (epoch
    seconds, deduplicated by the caller from the two copies the recorder writes).
    Only counted facts move, and only upward: distinct days join the stored list,
    the exchange count becomes the larger of what is stored and what the logs
    prove, and ``last_at`` only moves forward. ``family_at``, ``kind`` and
    ``motif`` are never touched — the family pacing is not this function's
    business — and a second run changes nothing.

    Nothing is invented: every day and every count here comes from a visit row
    that already exists on disk with its own timestamp. Returns the rows that
    actually changed.
    """
    changed: list[dict] = []
    # The caller may hand the same pair twice (once per direction, as the logs
    # write it); fold it once, under its sorted key.
    merged: dict[str, set[float]] = {}
    for (a, b), moments in (evidence or {}).items():
        try:
            ka, kb = hq_personas.get(a)["key"], hq_personas.get(b)["key"]
        except Exception:
            continue
        if ka == kb:
            continue
        bucket = merged.setdefault(_key(ka, kb), set())
        bucket.update(float(m) for m in (moments or ()) if isinstance(m, (int, float)))
    with _lock:
        data = _load(root, owner)
        for key, moments in merged.items():
            stamps = sorted(moments)
            if not stamps:
                continue
            ka, kb = key.split("|")
            days = {datetime.fromtimestamp(s).date().isoformat() for s in stamps}
            row = data["pairs"].get(key) or {"a": min(ka, kb), "b": max(ka, kb),
                                             "exchanges": 0, "days": [], "last_at": 0.0, "motif": ""}
            before = (len(row.get("days") or []), int(row.get("exchanges") or 0), float(row.get("last_at") or 0))
            merged = [d for d in (row.get("days") or []) if isinstance(d, str)]
            for day in sorted(days):
                if day not in merged:
                    merged.append(day)
            row["days"] = sorted(merged)[-MAX_DAYS:]
            row["exchanges"] = max(int(row.get("exchanges") or 0), len(stamps))
            row["last_at"] = max(float(row.get("last_at") or 0.0), stamps[-1])
            after = (len(row["days"]), int(row["exchanges"]), float(row["last_at"]))
            data["pairs"][key] = row
            if after != before:
                changed.append({"a": row["a"], "b": row["b"], "before": before, "after": after})
        if changed:
            p = _path(root, owner)
            p.parent.mkdir(parents=True, exist_ok=True)
            hq_state.write_json_atomic(p, data)
    return changed


def stage_label(stage, *, lang: str = "fr") -> str:
    table = PAIR_STAGE_LABEL_EN if str(lang).lower().startswith("en") else PAIR_STAGE_LABEL
    return table.get(str(stage or ""), "")


def _domain(key: str, lang: str) -> str:
    """One short noun phrase for what she tends, in the asked language."""
    try:
        names = hq_personas.get(key).get("domain") or {}
    except Exception:
        names = {}
    pick = "en" if str(lang).lower().startswith("en") else "fr"
    return str(names.get(pick) or names.get("fr") or "")


def _early_stage_line(me: str, other: str, days: int, exchanges: int, *, lang: str) -> str:
    """A pair's own words before any familiarity exists.

    Nothing is borrowed from another pair: the sentence names the two domains that
    have not crossed yet, so fifteen untouched pairs read as fifteen different
    statements, none of which claims a closeness it has not lived.
    """
    mine, theirs = _domain(me, lang), _domain(other, lang)
    name = hq_personas.get(other)["name"]
    # Both stages name the two domains, never just the other's name: two pairs
    # that share a name and a count must still read as two different statements.
    if str(lang).lower().startswith("en"):
        if int(days) <= 0:
            return (f"Nothing shared with {name} yet — {mine} and {theirs} have not crossed paths. "
                    "Evidence only: no invented past.")
        return (f"One day shared with {name} ({int(exchanges)} exchange(s)) — {mine} and {theirs} "
                "crossed once, not a habit yet. Evidence only.")
    if int(days) <= 0:
        return (f"Rien de partagé avec {name} pour l'instant — {mine} et {theirs} ne se sont pas encore "
                "croisés. Preuve seulement : aucun passé inventé.")
    return (f"Un seul jour partagé avec {name} ({int(exchanges)} échange(s)) — {mine} et {theirs} "
            "se sont croisés une fois, pas encore une habitude. Preuve seulement.")


def tier(days) -> str:
    """The rung a pair stands on, from distinct days only (empty below two)."""
    try:
        count = int(days)
    except (TypeError, ValueError):
        return ""
    for minimum, name in TIER_MIN_DAYS:
        if count >= minimum:
            return name
    return ""


def stage_line(root, a, b, *, lang="fr", owner: str | None = None) -> str:
    """How this pair names its own link, at whatever stage it is.

    ``line`` keeps its rule (a count-bearing familiarity note from two distinct
    days). Before that this returns the pair's own early wording, so every pair
    is already itself and two untouched pairs never share a sentence.
    """
    row = pair(root, a, b, owner=owner)
    if row["days"] >= 2:
        return line(root, a, b, lang=lang, owner=owner)
    return _early_stage_line(hq_personas.get(a)["key"], hq_personas.get(b)["key"],
                            row["days"], row["exchanges"], lang=lang)


def line(root, a, b, *, lang="fr", owner: str | None = None) -> str:
    """Short familiarity note for a prompt; empty until two distinct days exist.

    Injected by ``hq_assistant_voice`` into each assistant's own chat prompt.
    The tier moves with the distinct-day count, so the same pair is written
    differently once they have actually lived through more days together.
    """
    row = pair(root, a, b, owner=owner)
    if row["days"] < 2:
        return ""
    me = hq_personas.get(a)["key"]
    # Plain name only: a prompt line must never carry the other assistant's alias.
    other = hq_personas.get(row["b"] if row["a"] == me else row["a"])["name"]
    # The rung the pair has actually reached, not the day count alone: a note that
    # says "(connaissance)" next to a complicity stage contradicts itself.
    rung = pair_stage(row["days"], row["exchanges"])
    motif = str(row.get("motif") or "").strip()
    callback = ""
    if motif and row["days"] >= 5:
        # A real shared moment, quotable — never invented, and short enough that
        # it cannot crowd the rest of the prompt block.
        callback = (f" You may call back to « {motif[:60]} »."
                    if str(lang).lower().startswith("en")
                    else f" Rappel possible : « {motif[:60]} ».")
    # The count and both domains belong in the note: several pairs share one
    # assistant's name and a day count, and a note that names only the other
    # assistant makes three different pairs read as one.
    mine, theirs = _domain(me, lang), _domain(other, lang)
    if str(lang).lower().startswith("en"):
        return (f"Familiarity with {other}: {row['days']} separate days and "
                f"{int(row['exchanges'])} exchanges between {mine} and {theirs} "
                f"({TIER_LABEL_EN.get(rung, 'acquaintance')}) — "
                f"{TIER_BEHAVIOUR_EN.get(rung, TIER_BEHAVIOUR_EN['connaissance'])} "
                "Evidence only — no invented past, no emotional debt." + callback)
    return (f"Familiarité avec {other} : {row['days']} jours distincts et "
            f"{int(row['exchanges'])} échanges entre {mine} et {theirs} "
            f"({TIER_LABEL.get(rung, 'connaissance')}) — "
            f"{TIER_BEHAVIOUR.get(rung, TIER_BEHAVIOUR['connaissance'])} "
            "Preuve seulement — aucun passé inventé, aucune dette affective." + callback)
