# -*- coding: utf-8 -*-
"""How Inventoria feels: a calm "all good" line, a quiet streak, small voice lines, and a budget for what it may ask of the Master.

Nothing here changes stock. State is one small file (.hq-inventoria/feel.json), written atomically through hq_state; an unreadable
file is preserved and treated as defaults for reads (a write then refuses rather than overwrite it).
Asks that are PUSHED (instant pings, the morning digest) go through ``ask_allowed`` / ``ask_spend``: snooze, quiet hours and a daily cap.
"""
from __future__ import annotations

import json
import re
import threading
import time
import zlib
from pathlib import Path
from typing import Any

import hq_state

STATE_FOLDER = ".hq-inventoria"
FILE = "feel.json"
DEFAULT_ASKS = {"max_per_day": 4, "quiet_start": 22, "quiet_end": 7}
STREAK_MIN_DAYS = 7
SNOOZE_MAX_DAYS = 30
_lock = threading.RLock()

NUMBER_WORDS = {"un", "une", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "douze", "one", "two", "three",
                "four", "five", "six", "seven", "eight", "nine", "ten", "twelve", "dozen", "douzaine", "couple", "half", "demi", "moitie"}

# Short, warm, never gushing. {c} is what changed ("Lait −1"), {n} a count. French is the source text, English is applied by the server
# when the language pin says so (the panel asks for it in status, so toast, empty states and digest share one voice).
VOICE = {
    "en": {
        "applied": ["Done — {c}.", "Got it: {c}.", "Noted — {c}. Stock is current."],
        "applied_line": ["Done. The stock is current.", "All set. Stock is up to date."],
        "undone": ["Undone. Back to how it was.", "Okay, taken back."],
        "queued": "Saved here. I'll send it when you're back online.",
        "digest_head": "Morning. {n} thing(s) want a look:",
        "digest_soon": "Use these soon: ",
        "usual": "Usual amount",
        "checked": "Checked ✓",
        "calm_empty": "Nothing to buy.",
    },
    "fr": {
        "applied": ["Fait — {c}.", "Compris : {c}.", "Noté — {c}. Le stock est à jour."],
        "applied_line": ["C'est fait. Le stock est à jour.", "Voilà, le stock est à jour."],
        "undone": ["Annulé. Retour comme avant.", "D'accord, c'est repris."],
        "queued": "Gardé ici. Je l'envoie dès que tu as du réseau.",
        "digest_head": "Bonjour. {n} chose(s) à regarder :",
        "digest_soon": "À utiliser bientôt : ",
        "usual": "Quantité habituelle",
        "checked": "Vérifié ✓",
        "calm_empty": "Rien à acheter.",
    },
}


def voice(lang: str | None) -> dict:
    return VOICE["en" if lang == "en" else "fr"]


def pick(lines: Any, seed: Any) -> str:
    """A stable choice (same seed, same line) so a repeated render never flickers between wordings."""
    if isinstance(lines, str):
        return lines
    if not lines:
        return ""
    return str(lines[zlib.crc32(str(seed).encode("utf-8")) % len(lines)])


# ---------------------------------------------------------------- state

def _path(root: Any) -> Path:
    return Path(root) / STATE_FOLDER / FILE


def _load(root: Any) -> dict:
    try:
        data = json.loads(_path(root).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return {"_unreadable": True}
    return data if isinstance(data, dict) else {"_unreadable": True}


def _save(root: Any, data: dict) -> None:
    if data.get("_unreadable"):
        raise ValueError("feel.json illisible : rien n'est écrasé")
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    hq_state.write_json_atomic(p, data)


def _int(v: Any, lo: int, hi: int, default: int) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi else default


def _day(now: float) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(now))


# ---------------------------------------------------------------- streak: "nothing ran out for N days"

def observe(root: Any, alerts: list[dict], now: float | None = None) -> None:
    """Remember when tracking began and the last time something was out. Writes only when that changes."""
    if root is None:
        return
    now = float(now if now is not None else time.time())
    with _lock:
        d = _load(root)
        if d.get("_unreadable"):
            return
        changed = False
        if not isinstance(d.get("since"), (int, float)):
            d["since"] = now
            changed = True
        if any(a.get("level") == "out" for a in alerts or []):
            last = d.get("last_out")
            if not isinstance(last, (int, float)) or now - last > 3600:      # hourly resolution is plenty for a day count
                d["last_out"] = now
                changed = True
        if changed:
            try:
                _save(root, d)
            except Exception:
                pass


def streak_line(root: Any, lang: str | None, now: float | None = None) -> str | None:
    """One quiet line once it is true for a week; never invents days before tracking began."""
    now = float(now if now is not None else time.time())
    d = _load(root)
    since = d.get("since")
    if not isinstance(since, (int, float)):
        return None
    base = d.get("last_out") if isinstance(d.get("last_out"), (int, float)) else since
    days = int((now - base) // 86400)
    if days < STREAK_MIN_DAYS:
        return None
    return f"Nothing ran out for {days} days." if lang == "en" else f"Rien n'a manqué depuis {days} jours."


# ---------------------------------------------------------------- calm state

def calm(inv: dict, alerts: list[dict], use_soon: list[dict], last_count_days: int | None, lang: str | None) -> dict:
    """{"calm": bool, "line": str|None}. Calm only when there is stock to speak of and nothing needs attention."""
    has_stock = bool((inv or {}).get("items"))
    ok = has_stock and not alerts and not use_soon
    if not ok:
        return {"calm": False, "line": None}
    en = lang == "en"
    bits = ["Nothing to buy", "nothing expiring"] if en else ["Rien à acheter", "rien qui expire"]
    if last_count_days is not None:
        bits.append((f"last count {last_count_days} day{'s' if last_count_days != 1 else ''} ago") if en
                    else (f"dernier compte il y a {last_count_days} j"))
    line = ", ".join(bits) + "."
    return {"calm": True, "line": line[0].upper() + line[1:]}


# ---------------------------------------------------------------- "Usual amount": only when it is true

def _has_number(text: str) -> bool:
    if re.search(r"\d", text):
        return True
    words = set(re.findall(r"[a-zà-ÿ]+", text.lower()))
    return bool(words & NUMBER_WORDS)


def mark_usual(root: Any, applied: list[dict], text: Any) -> None:
    """Flag a change ``usual: true`` when the Master gave no number and the amount equals what he usually adds or uses."""
    if root is None or not isinstance(text, str) or not text.strip() or _has_number(text):
        return
    try:
        import hq_inventoria_habits as habits
    except Exception:
        return
    for a in applied or []:
        for c in a.get("changes") or []:
            iid, b, f = c.get("item_id"), (c.get("before") or {}).get("qty"), (c.get("after") or {}).get("qty")
            if c.get("op") != "item.adjust" or not isinstance(iid, str) or not isinstance(b, (int, float)) or not isinstance(f, (int, float)):
                continue
            delta = int(f - b)
            u = habits.usual(root, iid)
            if delta > 0 and u.get("add") == delta or delta < 0 and u.get("use") == -delta:
                c["usual"] = True


# ---------------------------------------------------------------- the ask budget

def asks_get(root: Any, now: float | None = None) -> dict:
    now = float(now if now is not None else time.time())
    d = _load(root)
    a = d.get("asks") if isinstance(d.get("asks"), dict) else {}
    out = {k: _int(a.get(k), 0 if k != "max_per_day" else 0, 23 if k != "max_per_day" else 20, v) for k, v in DEFAULT_ASKS.items()}
    snooze = a.get("snooze_until") if isinstance(a.get("snooze_until"), (int, float)) else 0
    spot = a.get("spot_snooze_until") if isinstance(a.get("spot_snooze_until"), (int, float)) else 0
    out["snoozed"] = snooze > now
    out["snooze_until"] = int(snooze) if snooze > now else 0
    out["spot_snoozed"] = spot > now
    return out


def asks_set(root: Any, *, max_per_day: Any = None, quiet_start: Any = None, quiet_end: Any = None,
             snooze_days: Any = None, spot_snooze_days: Any = None, now: float | None = None) -> dict:
    now = float(now if now is not None else time.time())
    with _lock:
        d = _load(root)
        a = d.get("asks") if isinstance(d.get("asks"), dict) else {}
        for key, val, lo, hi in (("max_per_day", max_per_day, 0, 20), ("quiet_start", quiet_start, 0, 23), ("quiet_end", quiet_end, 0, 23)):
            if val is None:
                continue
            if isinstance(val, bool) or not isinstance(val, int) or not lo <= val <= hi:
                raise ValueError(f"{key} : {lo} à {hi}")
            a[key] = val
        for key, val in (("snooze_until", snooze_days), ("spot_snooze_until", spot_snooze_days)):
            if val is None:
                continue
            if isinstance(val, bool) or not isinstance(val, int) or not 0 <= val <= SNOOZE_MAX_DAYS:
                raise ValueError(f"snooze : 0 à {SNOOZE_MAX_DAYS} jours")
            a[key] = now + val * 86400 if val else 0
        d["asks"] = a
        _save(root, d)
    return asks_get(root, now)


def in_quiet_hours(cfg: dict, now: float) -> bool:
    s, e = cfg["quiet_start"], cfg["quiet_end"]
    if s == e:
        return False
    h = time.localtime(now).tm_hour
    return (s <= h < e) if s < e else (h >= s or h < e)


def ask_allowed(root: Any, kind: str, now: float | None = None) -> tuple[bool, str]:
    """May Inventoria push something now? kind: 'instant' (daily cap applies) or 'digest' (once a day by itself, never capped)."""
    now = float(now if now is not None else time.time())
    cfg = asks_get(root, now)
    if cfg["snoozed"]:
        return False, "snoozed"
    if in_quiet_hours(cfg, now):
        return False, "quiet"
    if kind == "instant":
        sent = _load(root).get("sent") if isinstance(_load(root).get("sent"), dict) else {}
        if sent.get("day") == _day(now) and int(sent.get("n") or 0) >= cfg["max_per_day"]:
            return False, "budget"
    return True, ""


def ask_spend(root: Any, now: float | None = None) -> None:
    now = float(now if now is not None else time.time())
    with _lock:
        d = _load(root)
        if d.get("_unreadable"):
            return
        sent = d.get("sent") if isinstance(d.get("sent"), dict) else {}
        today = _day(now)
        d["sent"] = {"day": today, "n": (int(sent.get("n") or 0) if sent.get("day") == today else 0) + 1}
        try:
            _save(root, d)
        except Exception:
            pass


def spot_hidden(root: Any, now: float | None = None) -> bool:
    cfg = asks_get(root, now)
    return cfg["snoozed"] or cfg["spot_snoozed"]
