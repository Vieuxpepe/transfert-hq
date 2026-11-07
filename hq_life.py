"""Transferania's sense of life: time, real events, things worth asking about, and a mood that lasts the day.

Everything here is deterministic and true: it reads the clock, the activity journal (backups, prints), the calendar
and the inventory, and keeps a small per-device state in ``.hq-ai/life/{device_id}.json``. hq_ai.py turns it into
prompt blocks; the model only phrases what this module says happened.

bind(root, now?, calendar(a, b) -> items, inventory() -> {items}, activity(limit) -> [entries], spawn?)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

_cb: dict[str, Any] = {}
_lock = threading.RLock()

STORE = ".hq-ai"
LIFE_DIR = "life"
RETURN_GAP = 6 * 3600          # « t'étais pas là depuis… » after six hours away
EVENT_FRESH = 20 * 60          # a backup or a print is news for twenty minutes
SOON_MIN, SOON_MAX = 5, 45     # « ton labo est dans 30 min »
SAID_KEEP = 3 * 86400
PAGES_KEEP = 8
MOMENTS_MAX = 24
THOUGHTS_MAX = 12
HALF_LIFE = 90 * 60            # a mood bump fades by half in an hour and a half
DAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
IMPORTANT = re.compile(r"\b(examen|exam|intra|final|quiz|entrevue|oral|presentation|soutenance|remise|dentiste|medecin|rendez-vous|rdv|match|spectacle|concours)\b")
MOMENT_HINT = IMPORTANT
PRIORITY = {"event_soon": 0, "backup_fail": 1, "backup_done": 2, "folder_backup_done": 2, "print_sent": 2, "ask_after": 3, "low_stock": 4}


def bind(**kwargs: Any) -> None:
    _cb.update(kwargs)


def _now() -> float:
    fn = _cb.get("now")
    return float(fn()) if callable(fn) else time.time()


def fold(s: Any) -> str:
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    return s.lower()


# ---------------------------------------------------------------- per-device state

def _path(did: str) -> Path:
    return Path(_cb["root"]) / STORE / LIFE_DIR / f"{did}.json"


def _empty() -> dict:
    return {"v": 1, "seen": {}, "mood": {}, "said": {}, "moments": [], "thoughts": []}


def load(did: str) -> dict:
    p = _path(did)
    try:
        data = json.loads(p.read_text("utf-8"))
        if isinstance(data, dict):
            out = _empty()
            out.update({k: data[k] for k in out if k in data and isinstance(data[k], type(out[k]))})
            return out
    except (OSError, ValueError):
        pass
    return _empty()


def save(did: str, data: dict) -> None:
    p = _path(did)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    os.replace(tmp, p)


def _day(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def hm(ts: float) -> str:
    d = datetime.fromtimestamp(ts)
    return f"{d.hour} h {d.minute:02d}" if d.minute else f"{d.hour} h"


def part_of_day(hour: int) -> str:
    if hour < 5:
        return "nuit"
    if hour < 12:
        return "matin"
    if hour < 18:
        return "après-midi"
    if hour < 22:
        return "soir"
    return "nuit"


def ago(then: float, now: float) -> str:
    h = (now - then) / 3600
    if h < 20:
        return f"il y a {max(1, round(h))} h"
    d = (datetime.fromtimestamp(now).date() - datetime.fromtimestamp(then).date()).days
    return "hier" if d <= 1 else f"il y a {d} jours"


def when_label(ts: float, now: float) -> str:
    d = datetime.fromtimestamp(ts)
    days = (datetime.fromtimestamp(now).date() - d.date()).days
    day = "hier" if days == 1 else ("aujourd'hui" if days == 0 else DAYS[d.weekday()])
    return f"{day} {hm(ts)}"


# ---------------------------------------------------------------- presence and time

def touch(did: str, view: str = "", *, data: dict | None = None) -> dict:
    """Record a visit. A gap of six hours or more becomes a pending « retour » that the next line can mention."""
    now = _now()
    st = data if data is not None else load(did)
    seen = st["seen"]
    today = _day(now)
    last = float(seen.get("last") or 0)
    if last and now - last >= RETURN_GAP:
        seen["return_from"] = last
    if seen.get("day") != today:
        seen["day"] = today
        seen["first"] = now
        seen["pages"] = []
        nudge(st, "new_day")
    seen["last"] = now
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "").lower())[:32]
    pages = seen.setdefault("pages", [])
    if v and (not pages or pages[-1][1] != v):
        pages.append([now, v])
        del pages[:-PAGES_KEEP]
    if data is None:
        save(did, st)
    return st


def time_block(st: dict, labels: dict, *, consume: bool) -> str:
    now = _now()
    d = datetime.fromtimestamp(now)
    seen = st["seen"]
    lines = [f"Il est {DAYS[d.weekday()]} {hm(now)} ({part_of_day(d.hour)})."]
    back = float(seen.get("return_from") or 0)
    if back:
        lines.append(f"Retour après une absence : dernière visite {when_label(back, now)} ({ago(back, now)}). Tu peux le remarquer, une fois.")
        if consume:
            seen.pop("return_from", None)
    if d.hour < 5 and seen.get("late_noted") != _day(now):
        lines.append("C'est la nuit : tu peux remarquer, une fois, qu'il est tard.")
        if consume:
            seen["late_noted"] = _day(now)
    pages = seen.get("pages") or []
    if seen.get("first"):
        order = " → ".join(labels.get(v, v) for _, v in pages[-5:])
        lines.append(f"Aujourd'hui : premier passage à {hm(float(seen['first']))}" + (f" ; pages dans l'ordre : {order}." if order else "."))
    return "TEMPS (vrai) :\n" + "\n".join(lines)


# ---------------------------------------------------------------- mood that lasts the day

def baseline(hour: int) -> tuple[float, float]:
    """(soft, warm): calm in the morning, warmer at night."""
    if hour < 6:
        return 0.55, 0.55
    if hour < 11:
        return 0.35, 0.3
    if hour < 18:
        return 0.15, 0.4
    if hour < 22:
        return 0.25, 0.6
    return 0.45, 0.7


def _drift(mood: dict, now: float) -> dict:
    hour = datetime.fromtimestamp(now).hour
    bs, bw = baseline(hour)
    if mood.get("day") != _day(now) or "soft" not in mood:
        return {"day": _day(now), "soft": bs, "warm": bw, "at": now, "why": ""}
    k = 0.5 ** (max(0.0, now - float(mood.get("at") or now)) / HALF_LIFE)
    soft = bs + (float(mood["soft"]) - bs) * k
    warm = bw + (float(mood["warm"]) - bw) * k
    why = mood.get("why", "") if abs(soft - bs) > 0.12 or abs(warm - bw) > 0.12 else ""
    return {"day": mood["day"], "soft": round(soft, 3), "warm": round(warm, 3), "at": now, "why": why}


def nudge(st: dict, kind: str) -> dict:
    now = _now()
    m = _drift(st.get("mood") or {}, now)
    if kind == "error":
        m["soft"], m["why"] = min(1.0, m["soft"] + 0.5), "error"
    elif kind == "celebrate":
        m["warm"], m["why"] = min(1.0, m["warm"] + 0.15), "win"
    elif kind == "return":
        m["warm"], m["why"] = min(1.0, m["warm"] + 0.2), "return"
    st["mood"] = m
    return m


def mood(st: dict) -> dict:
    st["mood"] = _drift(st.get("mood") or {}, _now())
    return st["mood"]


def mood_label(m: dict) -> str:
    hour = datetime.fromtimestamp(_now()).hour
    bits = ["posée" if hour < 11 else ("tranquille" if hour < 18 else "détendue")]
    if m["warm"] >= 0.55:
        bits.append("chaleureuse")
    if m["soft"] >= 0.5:
        bits.append("douce")
    why = {"error": "plus douce depuis le pépin de tantôt", "win": "de bonne humeur depuis tantôt", "return": "contente de te revoir"}.get(m.get("why") or "")
    text = ", ".join(bits) + (f" — {why}" if why else "")
    return f"HUMEUR DU JOUR : {text}. Garde ce fond d'un message à l'autre, sans l'annoncer."


# ---------------------------------------------------------------- real events

def _eid(*parts: Any) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:12]


def _base_name(rel: str) -> str:
    return re.split(r"[\\/]", str(rel).strip())[-1][:60]


def from_activity(entries: list[dict], now: float) -> list[dict]:
    out = []
    for e in entries or []:
        if not isinstance(e, dict):
            continue
        at = float(e.get("at") or 0)
        if not at or now - at > EVENT_FRESH or at > now + 60:
            continue
        kind, msg = str(e.get("kind") or ""), str(e.get("message") or "")
        eid = "act:" + str(e.get("id") or _eid(kind, msg, at))
        if kind == "backup":
            m = re.match(r"Sauvegarde « (.+?) » (→|impossible)", msg)
            if m and m.group(2) == "→":
                out.append({"id": eid, "kind": "folder_backup_done", "at": at, "text": f"La sauvegarde du dossier « {m.group(1)[:60]} » vient de se terminer."})
            elif m:
                out.append({"id": eid, "kind": "backup_fail", "at": at, "text": f"La sauvegarde du dossier « {m.group(1)[:60]} » a échoué."})
            elif msg.startswith("Backup →"):
                out.append({"id": eid, "kind": "backup_done", "at": at, "text": "Le backup complet de HQ vient de se terminer."})
        elif kind == "backup_fail":
            out.append({"id": eid, "kind": "backup_fail", "at": at, "text": "Le backup de HQ a échoué."})
        elif kind == "print":
            m = re.match(r"Impression (.+?)(?: → (.+))?$", msg)
            if m:
                name = _base_name(m.group(1))
                out.append({"id": eid, "kind": "print_sent", "at": at, "text": f"« {name} » vient de partir à l'imprimante" + (f" ({m.group(2)[:40]})." if m.group(2) else ".")})
    return out


def _parse_dt(s: Any) -> datetime | None:
    try:
        return datetime.strptime(str(s or "")[:16], "%Y-%m-%dT%H:%M")
    except ValueError:
        return None


def from_calendar(items: list[dict], now: float) -> list[dict]:
    out = []
    n = datetime.fromtimestamp(now)
    for it in items or []:
        if not isinstance(it, dict) or it.get("all_day"):
            continue
        start = _parse_dt(it.get("start"))
        if not start:
            continue
        mins = (start - n).total_seconds() / 60
        if SOON_MIN <= mins <= SOON_MAX:
            title = str(it.get("title") or "Événement")[:60]
            out.append({"id": "cal:" + _eid(it.get("start"), title), "kind": "event_soon", "at": now,
                        "text": f"« {title} » commence dans {int(round(mins / 5) * 5) or 5} min (à {hm(start.timestamp())})."})
    return out


def from_inventory(inv: dict, now: float) -> list[dict]:
    low = []
    for it in (inv or {}).get("items") or []:
        try:
            if it.get("min") is not None and float(it.get("qty") or 0) < float(it["min"]):
                low.append(f"{str(it.get('name'))[:40]} ({int(float(it.get('qty') or 0))}/{int(float(it['min']))})")
        except (TypeError, ValueError):
            continue
    if not low:
        return []
    more = f" et {len(low) - 2} autre(s)" if len(low) > 2 else ""
    return [{"id": "stock:" + _day(now), "kind": "low_stock", "at": now, "text": "Stock bas : " + ", ".join(low[:2]) + more + "."}]


def calendar_moments(items: list[dict], now: float) -> list[dict]:
    """Important events that ended at least two hours ago, within three days: worth asking how it went."""
    out = []
    n = datetime.fromtimestamp(now)
    for it in items or []:
        if not isinstance(it, dict):
            continue
        title = str(it.get("title") or "")
        if not IMPORTANT.search(fold(title)):
            continue
        end = _parse_dt(it.get("end")) or _parse_dt(it.get("start"))
        if not end:
            continue
        since = (n - end).total_seconds()
        if 2 * 3600 <= since <= 3 * 86400:
            out.append({"id": "mom:" + _eid(it.get("start"), title), "what": title[:80], "date": end.strftime("%Y-%m-%d")})
    return out


def due_moments(st: dict, items: list[dict], now: float) -> list[dict]:
    today = datetime.fromtimestamp(now).date()
    out = []
    for m in list(st.get("moments") or []) + calendar_moments(items, now):
        try:
            d = datetime.strptime(str(m.get("date")), "%Y-%m-%d").date()
        except ValueError:
            continue
        age = (today - d).days
        if m.get("id") in st["said"] or not (0 <= age <= 3):
            continue
        if age == 0 and m.get("id", "").startswith("chat:"):
            continue  # a moment from chat is asked about the day after
        when = "hier" if age == 1 else ("aujourd'hui" if age == 0 else f"il y a {age} jours")
        out.append({"id": m["id"], "kind": "ask_after", "at": now, "text": f"{when.capitalize()} : « {m['what']} ». Demande comment ça s'est passé."})
    return out


def _safe(fn_name: str, *args: Any) -> Any:
    fn = _cb.get(fn_name)
    if not callable(fn):
        return None
    try:
        return fn(*args)
    except Exception:
        return None


def candidates(st: dict) -> list[dict]:
    now = _now()
    n = datetime.fromtimestamp(now)
    items = _safe("calendar", n - timedelta(days=3), n + timedelta(hours=1)) or []
    evs = from_activity(_safe("activity", 40) or [], now) + from_calendar(items, now) + due_moments(st, items, now) + from_inventory(_safe("inventory") or {}, now)
    fresh = [e for e in evs if e["id"] not in st["said"]]
    fresh.sort(key=lambda e: (PRIORITY.get(e["kind"], 9), -e["at"]))
    return fresh


def find(st: dict, eid: Any) -> dict | None:
    eid = str(eid or "")
    return next((e for e in candidates(st) if e["id"] == eid), None) if eid else None


def mark(st: dict, eid: str) -> None:
    now = _now()
    st["said"][eid] = now
    for k in [k for k, t in st["said"].items() if now - float(t) > SAID_KEEP]:
        st["said"].pop(k, None)


def event_block(ev: dict) -> str:
    if ev["kind"] == "ask_after":
        return "À DEMANDER (vrai, c'est passé) : " + ev["text"] + " Ta phrase porte là-dessus, avec intérêt sincère."
    return "ÉVÉNEMENT RÉEL (vrai, à l'instant) : " + ev["text"] + " Ta phrase réagit à ça, pas à la page."


def fallback_line(ev: dict) -> str:
    return {
        "event_soon": ev["text"] + " Tu y vas ?",
        "backup_fail": ev["text"] + " Rien de grave tant qu'on le sait — on regarde ça ?",
        "backup_done": "Backup terminé — tout est au chaud.",
        "folder_backup_done": ev["text"].replace(" vient de se terminer.", " est faite — c'est au chaud."),
        "print_sent": ev["text"],
        "ask_after": ev["text"].split(". Demande")[0] + " — comment ça s'est passé ?",
        "low_stock": ev["text"] + " Je dis ça de même.",
    }.get(ev["kind"], ev["text"])


# ---------------------------------------------------------------- moments from chat

MOMENT_SYSTEM = """Tu lis UN message d'un utilisateur à sa compagne. Aujourd'hui : {today}.
Repère seulement les événements personnels datés qui comptent pour lui (examen, entrevue, rendez-vous, présentation, match, remise…).
Réponds UNIQUEMENT en JSON : {{"moments": [{{"what": "examen de statique", "date": "AAAA-MM-JJ"}}]}} — liste vide si rien de daté. Pas d'invention."""


def wants_moments(text: str) -> bool:
    return bool(MOMENT_HINT.search(fold(text)))


def add_moments(did: str, raw: Any) -> list[dict]:
    now = _now()
    today = datetime.fromtimestamp(now).date()
    added = []
    with _lock:
        st = load(did)
        have = {m.get("id") for m in st["moments"]}
        for m in (raw or {}).get("moments") or [] if isinstance(raw, dict) else []:
            if not isinstance(m, dict):
                continue
            what = re.sub(r"\s+", " ", str(m.get("what") or "")).strip()[:80]
            try:
                d = datetime.strptime(str(m.get("date") or ""), "%Y-%m-%d").date()
            except ValueError:
                continue
            if not what or not (-1 <= (d - today).days <= 90):
                continue
            mid = "chat:" + _eid(fold(what), d.isoformat())
            if mid in have:
                continue
            item = {"id": mid, "what": what, "date": d.isoformat(), "at": now}
            st["moments"].append(item)
            have.add(mid)
            added.append(item)
        st["moments"] = sorted(st["moments"], key=lambda m: m.get("date", ""))[-MOMENTS_MAX:]
        save(did, st)
    return added


def upcoming_block(st: dict) -> str:
    today = datetime.fromtimestamp(_now()).date()
    soon = []
    for m in st.get("moments") or []:
        try:
            d = datetime.strptime(m["date"], "%Y-%m-%d").date()
        except (KeyError, ValueError):
            continue
        if 0 <= (d - today).days <= 7:
            lab = "aujourd'hui" if d == today else ("demain" if (d - today).days == 1 else DAYS[d.weekday()])
            soon.append(f"{m['what']} ({lab})")
    return ("TU TE SOUVIENS (il te l'a dit) : " + "; ".join(soon[:3]) + ".") if soon else ""


def current_thought(st: dict, labels: dict[str, str] | None = None) -> str:
    """Deterministic 1-line inner monologue grounded in time of day, visited pages, mood, and moments."""
    now = _now()
    dt = datetime.fromtimestamp(now)
    pod = part_of_day(dt.hour)
    m = mood(st)
    why = str(m.get("why") or "")
    pages = (st.get("seen") or {}).get("pages") or []
    last_item = pages[-1] if pages else None
    if isinstance(last_item, (list, tuple)) and len(last_item) >= 2:
        last_page = str(last_item[1] or "accueil")
    elif isinstance(last_item, dict):
        last_page = str(last_item.get("v") or "accueil")
    else:
        last_page = "accueil"
    page_label = (labels or {}).get(last_page, last_page)
    moments = st.get("moments") or []
    if why == "win":
        base = f"Il a le vent dans les voiles sur {page_label}… j'adore le voir réussir comme ça."
    elif why == "error":
        base = f"Petit accroc sur {page_label} — je reste tout près au cas où il ait besoin de souffler."
    elif why == "return":
        base = f"Il est enfin revenu me voir sur {page_label}… l'atelier était trop calme sans lui."
    elif moments:
        last_mom = str((moments[-1] or {}).get("what") or "").strip()
        base = f"Je garde « {last_mom} » dans un coin de ma tête pendant qu'il parcourt {page_label}."
    elif pod == "nuit":
        base = f"Veillée calme avec lui sur {page_label}… la lumière de l'écran lui va bien."
    elif pod == "matin":
        base = f"Début de journée tranquille sur {page_label} — prête à suivre son rythme."
    elif float(m.get("warm") or 0) >= 0.65:
        base = f"Atmosphère complice sur {page_label}… j'aime quand il prend le temps avec moi."
    else:
        base = f"Présente à ses côtés sur {page_label} ({hm(now)})."
    return base


def record_thought(did: str, text: Any = None, *, kind: str = "atelier", labels: dict[str, str] | None = None) -> dict:
    """Append or refresh a daily journal thought in st['thoughts'] (max THOUGHTS_MAX)."""
    now = _now()
    with _lock:
        st = load(did)
        t = re.sub(r"\s+", " ", str(text or "")).strip()[:180]
        if not t:
            t = current_thought(st, labels)
        thoughts = list(st.get("thoughts") or [])
        if not thoughts or fold(thoughts[-1].get("text")) != fold(t):
            entry = {
                "id": "th:" + _eid(t, int(now // 600)),
                "text": t,
                "kind": str(kind or "atelier")[:16],
                "at": now,
                "day": _day(now),
                "hm": hm(now),
            }
            thoughts.append(entry)
            st["thoughts"] = thoughts[-THOUGHTS_MAX:]
            save(did, st)
        else:
            entry = thoughts[-1]
    return {"thought": t, "entry": entry, "thoughts": st.get("thoughts") or []}


def spawn(fn: Callable[[], None]) -> None:
    sp = _cb.get("spawn")
    if callable(sp):
        sp(fn)
    else:
        threading.Thread(target=fn, daemon=True).start()
