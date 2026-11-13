"""Pistonia speaks up first: a detector over the Engine status, with her own words.

No model call: conditions are checked from live numbers, held for a while before they count (so a spike is not an alert), raised once,
re-raised only after a cool-down, and followed by an "all clear" when they end. A raised alert becomes an assistant message in her
conversation (with a ready-made, still-unapplied proposal when there is an obvious fix) and, only if the Master switched notifications
on, a Discord / push ping through the channels HQ already has. Nothing here ever acts on a daemon.
"""
from __future__ import annotations

import hashlib
import threading
import time
from typing import Any, Callable, Optional

import hq_pistonia_store as store

RAM_PCT = 90
VRAM_PCT = 90
DISK_FREE_GB = 10
HOLD = {"ram": 300, "vram": 300, "disk": 600, "daemon": 90, "crash": 90, "machine": 120}
COOLDOWN = {"ram": 1800, "vram": 1800, "disk": 6 * 3600, "daemon": 1800, "crash": 1800, "machine": 6 * 3600}
MACHINE_RECENT = 86400         # only a PC seen in the last day can "drop off"
NOTIFY_MAX = 300
_lock = threading.RLock()
_since: dict[str, float] = {}
_was_ready: dict[str, float] = {}
_tick_lock = threading.Lock()


def reset_for_tests() -> None:
    _since.clear()
    _was_ready.clear()


def _mb(v: Any) -> str:
    return "?" if v is None else (f"{v / 1024:.1f} GB" if v >= 1024 else f"{int(v)} MB")


def _mins(sec: float) -> str:
    return f"{max(1, round(sec / 60))} min"


# ---- her words (variants are picked deterministically so tests are stable and she does not repeat herself back to back) -----------

LINES = {
    "ram": ["RAM has been above {pct}% for {held}. {top_txt}Want me to prepare a stop?",
            "I don't like this: memory at {pct}% for {held} now. {top_txt}Say the word and I'll line something up.",
            "The engine room is running hot on memory ({pct}%, {held}). {top_txt}I can queue a stop for you to confirm."],
    "vram": ["VRAM is sitting at {pct}%. {top_txt}Want me to prepare a stop?",
             "The GPU's memory is nearly full ({pct}% for {held}). {top_txt}I can line up a stop.",
             "VRAM at {pct}% and not coming down. {top_txt}Shall I prepare something?"],
    "disk": ["Disk is down to {free} free. That is the kind of thing that bites at 3 a.m.",
             "Only {free} left on the disk. Worth clearing something before a big generation needs the room."],
    "error": ["{label} is in trouble{note_txt}. I can pull its log if you like.",
              "{label} reports an error{note_txt}. Want me to read its log?"],
    "foreign": ["Something else has taken {label}'s port. I won't touch it, but you should know.",
                "Another program is sitting on {label}'s port. Hands off from my side."],
    "crash": ["{label} went down and nobody asked it to. I can restart it, or read its log first.",
              "{label} just dropped out on its own. Restart, or log first?"],
    "machine": ["{label} dropped off the network {ago} ago. Asleep, or in trouble?",
                "I lost {label} {ago} ago. Last I saw, it was fine."],
    "clear": ["All clear on {what}. Carry on.",
              "{what} is back under control. Good.",
              "{what} has settled down. Nice and quiet again."],
}


def _pick(kind: str, key: str, n: int) -> str:
    pool = LINES[kind]
    return pool[int(hashlib.sha256(f"{key}|{n}".encode()).hexdigest(), 16) % len(pool)]


# ---- detection -----------------------------------------------------------------------------------------------------------------

def detect(st: dict, now: float, events: Optional[list] = None) -> dict[str, dict]:
    """Conditions that are true right now: {key: {kind, level, ...params}}. Pure apart from tracking when daemons were last ready."""
    out: dict[str, dict] = {}
    s = st.get("system") or {}
    daemons = st.get("daemons") or []
    if s.get("ram_total_mb") and s.get("ram_used_mb") is not None:
        pct = round(100 * s["ram_used_mb"] / s["ram_total_mb"])
        if 100 * s["ram_used_mb"] / s["ram_total_mb"] >= RAM_PCT:
            top = max((d for d in daemons if d.get("rss_mb")), key=lambda d: d["rss_mb"], default=None)
            out["ram"] = {"kind": "ram", "pct": pct, "top": top}
    g = (s.get("gpus") or [None])[0]
    if g and g.get("vram_total_mb") and g.get("vram_used_mb") is not None:
        pct = round(100 * g["vram_used_mb"] / g["vram_total_mb"])
        if 100 * g["vram_used_mb"] / g["vram_total_mb"] >= VRAM_PCT:
            top = max((d for d in daemons if d.get("vram_mb")), key=lambda d: d["vram_mb"], default=None)
            out["vram"] = {"kind": "vram", "pct": pct, "top": top}
    if s.get("disk_free_gb") is not None and s["disk_free_gb"] < DISK_FREE_GB:
        out["disk"] = {"kind": "disk", "free": f"{s['disk_free_gb']} GB"}
    for d in daemons:
        did, state = d.get("id"), d.get("state")
        if not did or d.get("self") or d.get("observe_only") and d.get("kind") == "core":
            continue
        if state == "ready":
            _was_ready[did] = now
        if state in ("error", "foreign"):
            out[f"daemon:{did}"] = {"kind": "foreign" if state == "foreign" else "error", "daemon": d,
                                    "note": (next(iter((d.get("details") or {}).get("errors", {}).values()), None) or d.get("note") or "")}
        elif state == "down" and did in _was_ready and not d.get("observe_only"):
            deliberate = any(e.get("id") == did and e.get("action") in ("stop", "restart", "autostop") and e.get("at", 0) >= _was_ready[did] - 120
                             for e in (events or []))
            if not deliberate:
                out[f"crash:{did}"] = {"kind": "crash", "daemon": d}
    for m in st.get("machines") or []:
        if not m.get("online") and m.get("seen_ago") is not None and m["seen_ago"] < MACHINE_RECENT and m["seen_ago"] >= HOLD["machine"]:
            out[f"machine:{m['id']}"] = {"kind": "machine", "machine": m}
    return out


def _hold_for(key: str) -> int:
    return HOLD.get(key.split(":")[0], HOLD["daemon"])


def _cooldown_for(key: str) -> int:
    return COOLDOWN.get(key.split(":")[0], 1800)


def _compose(key: str, cond: dict, held: float, n: int) -> str:
    kind = cond["kind"]
    if kind in ("ram", "vram"):
        top = cond.get("top")
        mem = top.get("rss_mb") if kind == "ram" else top.get("vram_mb") if top else None
        top_txt = f"{top['label']} holds the most ({_mb(mem)}). " if top else ""
        return _pick(kind, key, n).format(pct=cond["pct"], held=_mins(held), top_txt=top_txt)
    if kind == "disk":
        return _pick(kind, key, n).format(free=cond["free"])
    if kind in ("error", "foreign", "crash"):
        d = cond["daemon"]
        note = cond.get("note")
        return _pick(kind, key, n).format(label=d.get("label", d.get("id")), note_txt=(f" ({str(note)[:80]})" if note else ""))
    if kind == "machine":
        m = cond["machine"]
        return _pick(kind, key, n).format(label=m.get("name", "A computer"), ago=_mins(m.get("seen_ago") or 0))
    return "Something needs a look."


def _what(key: str, cond: dict) -> str:
    kind = cond["kind"]
    return {"ram": "memory", "vram": "VRAM", "disk": "the disk"}.get(kind) or (cond.get("daemon") or {}).get("label") or (cond.get("machine") or {}).get("name") or "that"


def _proposals_for(cond: dict) -> list[dict]:
    """A ready-made card when there is an obvious fix. Validated by the same Toolbox as her chat tools; never executed here."""
    import hq_pistonia
    tb = hq_pistonia.Toolbox()
    kind = cond["kind"]
    try:
        if kind in ("ram", "vram") and cond.get("top"):
            tb.propose_action(cond["top"]["id"], "stop", "Free " + ("memory" if kind == "ram" else "VRAM"))
        elif kind == "crash":
            tb.propose_action(cond["daemon"]["id"], "start", "It went down on its own")
        elif kind == "error":
            tb.propose_action(cond["daemon"]["id"], "restart", "It reports an error")
    except Exception:
        return []
    return tb.proposals


# ---- the tick ------------------------------------------------------------------------------------------------------------------

def tick(st: Optional[dict] = None, now: Optional[float] = None, notify: Optional[Callable[[str, str], None]] = None) -> list[dict]:
    """One pass. Returns the messages added to her conversation (alerts and all-clears)."""
    if not _tick_lock.acquire(blocking=False):
        return []
    try:
        now = time.time() if now is None else now
        import hq_engine
        st = st or hq_engine.status()
        conds = detect(st, now, list(hq_engine._events))
        if store.alerts_unreadable():
            # The alert file exists but cannot be parsed: raising an alert now would
            # append to the thread and notify without a durable cooldown, repeating
            # the same alert every tick. Preserve the file and stay quiet.
            return []
        state = store.alerts_state()
        active = set(state["active"])
        added: list[dict] = []
        for key in list(_since):
            if key not in conds:
                _since.pop(key, None)
        for key, cond in conds.items():
            first = _since.setdefault(key, now)
            held = now - first
            if key in active or held < _hold_for(key):
                continue
            if now - float(state["cooldown"].get(key, 0)) < _cooldown_for(key):
                continue
            n = sum(1 for a in state["alerts"] if a.get("key") == key)
            text = _compose(key, cond, held, n)
            props = _proposals_for(cond)
            # Snapshot, append, commit and rollback under one lock: a chat message
            # arriving mid-sequence must not be erased by the rollback.
            with store.thread_transaction():
                before_alerts = len(state["alerts"])
                before_cooldown = dict(state["cooldown"])
                before_active = set(active)
                before_thread = store.thread()
                # A `mark_seen` may have committed since the tick read its state:
                # merge acknowledgements so saving the tick's copy cannot undo them.
                fresh = store.alerts_state()
                seen_ids = {a.get("id") for a in fresh["alerts"] if a.get("seen")}
                for acked in state["alerts"]:
                    if acked.get("id") in seen_ids:
                        acked["seen"] = True
                try:
                    msg = store.add_message("assistant", text, kind="alert", proposals=props, now=now)
                except store.StoreError:
                    continue      # thread file unreadable: keep it, never overwrite it
                state["alerts"].append({"id": msg["id"], "key": key, "kind": "alert", "text": text, "at": now, "seen": False,
                                        "label": _what(key, cond)})
                state["cooldown"][key] = now
                active.add(key)
                state["active"] = sorted(active)
                try:
                    # Durable before notify/return: a later tick must not repeat it.
                    store.save_alerts_state(state)
                except store.StoreError:
                    # Restore the snapshot: add_message() may have evicted the oldest
                    # message, which removing the new one would not bring back.
                    store.restore_thread(before_thread)
                    state["alerts"] = state["alerts"][:before_alerts]
                    state["cooldown"] = before_cooldown
                    active = before_active
                    state["active"] = sorted(active)
                    continue
                added.append(msg)
            if notify and store.settings().get("notify"):
                try:
                    notify("Pistonia · Engine", text[:NOTIFY_MAX])
                except Exception:
                    pass
        for key in list(active):
            if key not in conds:
                active.discard(key)
                ref = next((a for a in reversed(state["alerts"]) if a.get("key") == key and a.get("kind") == "alert"), None)
                what = (ref and ref.get("label")) or "that"
                n = sum(1 for a in state["alerts"] if a.get("key") == key and a.get("kind") == "clear")
                text = _pick("clear", key, n).format(what=what)
                text = text[:1].upper() + text[1:]
                with store.thread_transaction():
                    before_thread = store.thread()
                    try:
                        msg = store.add_message("assistant", text, kind="clear", now=now)
                    except store.StoreError:
                        active.add(key)
                        continue
                    state["alerts"].append({"id": msg["id"], "key": key, "kind": "clear", "text": text, "at": now, "seen": True})
                    state["active"] = sorted(active)
                    try:
                        store.save_alerts_state(state)
                    except store.StoreError:
                        store.restore_thread(before_thread)
                        state["alerts"].pop()
                        active.add(key)             # the condition is still uncleared
                        state["active"] = sorted(active)
                        continue
                    added.append(msg)
        state["active"] = sorted(active)
        return added
    finally:
        _tick_lock.release()
