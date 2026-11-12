"""Offline stock warnings: a morning digest and an instant ping when an item crosses into a worse alert level.

A small watcher thread (started by the bridge) wakes every few minutes. It ALWAYS records quantity history (so run-out estimates keep
learning while HQ is closed) but it only SENDS notifications when the Master has switched them on (default: off), and only through the
channels HQ already has (Discord webhook, web push). Nothing is sent about an item that was already alerting when notifications were enabled.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any, Callable

import hq_state

STATE_FOLDER = ".hq-inventoria"
FILE = "notify.json"
DEFAULT = {"enabled": False, "instant": True, "digest_hour": 8}
RANK = {"trend": 1, "soon": 2, "low": 3, "out": 4}
MAX_LINES = 8
_lock = threading.RLock()
_thread: threading.Thread | None = None
_stop = threading.Event()


def _path(root: Any) -> Path:
    return Path(root) / STATE_FOLDER / FILE


def _load(root: Any) -> dict:
    try:
        data = json.loads(_path(root).read_text(encoding="utf-8"))
    except Exception:
        data = {}
    return data if isinstance(data, dict) else {}


def _save(root: Any, data: dict) -> None:
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    hq_state.write_json_atomic(p, data)


def get_settings(root: Any) -> dict:
    d = _load(root)
    out = dict(DEFAULT)
    if isinstance(d.get("enabled"), bool):
        out["enabled"] = d["enabled"]
    if isinstance(d.get("instant"), bool):
        out["instant"] = d["instant"]
    if isinstance(d.get("digest_hour"), int) and not isinstance(d.get("digest_hour"), bool) and 0 <= d["digest_hour"] <= 23:
        out["digest_hour"] = d["digest_hour"]
    return out


def save_settings(root: Any, *, enabled: Any = None, instant: Any = None, digest_hour: Any = None, inv: dict | None = None) -> dict:
    """Update settings. Turning notifications ON seeds the 'already alerting' state so nothing old is announced."""
    with _lock:
        d = _load(root)
        cur = get_settings(root)
        if enabled is not None:
            if not isinstance(enabled, bool):
                raise ValueError("enabled doit être un booléen")
            cur["enabled"] = enabled
        if instant is not None:
            if not isinstance(instant, bool):
                raise ValueError("instant doit être un booléen")
            cur["instant"] = instant
        if digest_hour is not None:
            if isinstance(digest_hour, bool) or not isinstance(digest_hour, int) or not 0 <= digest_hour <= 23:
                raise ValueError("digest_hour: 0 à 23")
            cur["digest_hour"] = digest_hour
        d.update(cur)
        if enabled is True:
            import hq_inventoria_ai as ai
            d["state"] = {"alerts": {a["id"]: RANK[a["level"]] for a in ai.alerts(inv)}, "digest_day": d.get("state", {}).get("digest_day", "")}
        _save(root, d)
        return cur


def _sentence(row: dict, lang: str) -> str:
    import hq_inventoria_ai as ai
    t = ai.GREETING.get(lang, ai.GREETING["fr"])
    return f"{row['name']}: " + t["state"][row["level"]].format(qty=row["qty"], mn=row["min"], days=row.get("days_left"))


def tick(root: Any, send: Callable[[str, str], Any] | None, *, inv: dict | None = None, now: float | None = None) -> dict:
    """One watcher pass. Returns {"instant": [names], "digest": bool}. Never raises on a failed send."""
    import hq_inventory
    import hq_inventoria_ai as ai
    import hq_inventoria_history as history
    now = float(now if now is not None else time.time())
    inv = inv if isinstance(inv, dict) else hq_inventory.snapshot()
    history.observe(root, inv, now)                       # learn usage even when notifications are off
    out: dict[str, Any] = {"instant": [], "digest": False}
    with _lock:
        cfg = get_settings(root)
        if not cfg["enabled"] or send is None:
            return out
        d = _load(root)
        state = d.get("state") if isinstance(d.get("state"), dict) else {}
        seen = state.get("alerts") if isinstance(state.get("alerts"), dict) else {}
        rows = ai.alerts(inv, root, now)
        lang = ai.language()
        cur = {r["id"]: RANK[r["level"]] for r in rows}
        fresh = [r for r in rows if RANK[r["level"]] > int(seen.get(r["id"], 0))]
        if cfg["instant"] and fresh:
            lines = [_sentence(r, lang) for r in fresh[:MAX_LINES]]
            title = "Inventoria" if len(fresh) > 1 else f"Inventoria — {fresh[0]['name']}"
            try:
                send(title, "\n".join(lines) + (f"\n(+{len(fresh) - MAX_LINES})" if len(fresh) > MAX_LINES else ""))
            except Exception:
                pass
            out["instant"] = [r["name"] for r in fresh]
        lt = time.localtime(now)
        today = time.strftime("%Y-%m-%d", lt)
        digest_day = state.get("digest_day", "")
        if lt.tm_hour >= cfg["digest_hour"] and digest_day != today:
            digest_day = today
            if rows:
                shop = ai.shopping_list(inv, include_soon=True, lang=lang, today=today, now=now)
                head = (f"{len(rows)} item(s) need attention" if lang == "en" else f"{len(rows)} article(s) à surveiller")
                try:
                    send("Inventoria — " + ("morning digest" if lang == "en" else "résumé du matin"), head + "\n" + shop["text"][:1500])
                except Exception:
                    pass
                out["digest"] = True
        # only ever remember the highest level seen per item; improvements reset so a later relapse warns again
        d["state"] = {"alerts": cur, "digest_day": digest_day}
        _save(root, d)
    return out


def start(root_fn: Callable[[], Any], send: Callable[[str, str], Any] | None, interval: float = 600.0) -> bool:
    """Start the watcher thread once (idempotent). ``root_fn`` is called each pass so tests/rebinds keep working."""
    global _thread
    if _thread is not None and _thread.is_alive():
        return False
    _stop.clear()

    def loop() -> None:
        time.sleep(30)                                     # let the bridge finish booting
        while not _stop.is_set():
            try:
                tick(root_fn(), send)
            except Exception:
                pass
            _stop.wait(interval)

    _thread = threading.Thread(target=loop, daemon=True, name="inventoria-watch")
    _thread.start()
    return True


def stop() -> None:
    _stop.set()
