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


def _send(send: Callable[..., Any], title: str, body: str, **extra: Any) -> Any:
    """Pass the deep link / buttons only to a sender that takes them (the bridge does; simple test senders do not)."""
    import inspect
    try:
        params = inspect.signature(send).parameters
    except (TypeError, ValueError):
        params = {}
    takes_kw = any(p.kind == p.VAR_KEYWORD for p in params.values())
    kw = {k: v for k, v in extra.items() if takes_kw or k in params}
    return send(title, body, **kw)


def _alert_extras(fresh: list[dict], inv: dict, lang: str) -> dict:
    """A tap opens the chip on that item; with one item, two buttons answer from the notification itself
    (computers/Android show them; iPhone shows none and the tap opens the same choice in HQ)."""
    if len(fresh) != 1:
        return {"url": "/#inventoria-open"}
    row = fresh[0]
    import hq_inventoria_ai as ai
    shop = next((i for i in ai.shopping_list(inv, include_soon=True, lang=lang).get("items", []) if i.get("id") == row["id"]), None)
    buy = int(shop["buy"]) if shop and isinstance(shop.get("buy"), int) and shop["buy"] > 0 else 1
    en = lang == "en"
    line = {"name": str(row["name"])[:160], "qty": buy, "unit": str(row.get("unit") or "")[:20], "store": str(row.get("store") or "")[:60]}
    return {
        "url": "/#inventoria-low=" + str(row["id"]),
        "actions": [
            {"action": "grocery", "title": (f"Add to list ({buy})" if en else f"Ajouter à la liste ({buy})"),
             "post": {"url": "/api/inventoria/to-grocery", "body": {"lines": [line]}}},
            {"action": "ignore", "title": "Ignore" if en else "Ignorer"},
        ],
    }


def _use_soon_line(root: Any, inv: dict, lang: str, now: float) -> str:
    try:
        import hq_inventoria_links as links
        rows = links.use_soon(root, inv, days=2, now=now)
    except Exception:
        return ""
    if not rows:
        return ""
    names = ", ".join(f"{r['name']} ({r['days_left']} {'d' if lang == 'en' else 'j'})" for r in rows[:5])
    import hq_inventoria_feel as feel
    return feel.voice(lang)["digest_soon"] + names


def tick(root: Any, send: Callable[[str, str], Any] | None, *, inv: dict | None = None, now: float | None = None) -> dict:
    """One watcher pass. Returns {"instant": [names], "digest": bool}. Never raises on a failed send."""
    import hq_inventory
    import hq_inventoria_ai as ai
    import hq_inventoria_history as history
    now = float(now if now is not None else time.time())
    inv = inv if isinstance(inv, dict) else hq_inventory.snapshot()
    try:                                                  # finished 3D prints subtract their filament (opt-in links)
        import hq_inventoria_links as links
        if links.sync_filament(root, inv, hq_inventory.apply, now=now):
            inv = hq_inventory.snapshot()
    except Exception:
        pass
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
        import hq_inventoria_feel as feel
        feel.observe(root, rows, now)
        cur = {r["id"]: RANK[r["level"]] for r in rows}
        fresh = [r for r in rows if RANK[r["level"]] > int(seen.get(r["id"], 0))]
        ok_instant, _why = feel.ask_allowed(root, "instant", now)
        if fresh and cfg["instant"] and not ok_instant:     # snoozed, quiet hours or over today's cap: keep them fresh, tell later
            for r in fresh:
                cur[r["id"]] = int(seen.get(r["id"], 0))
            fresh = []
        if cfg["instant"] and fresh:
            lines = [_sentence(r, lang) for r in fresh[:MAX_LINES]]
            title = "Inventoria" if len(fresh) > 1 else f"Inventoria — {fresh[0]['name']}"
            text = "\n".join(lines) + (f"\n(+{len(fresh) - MAX_LINES})" if len(fresh) > MAX_LINES else "")
            try:
                _send(send, title, text, **_alert_extras(fresh, inv, lang))
            except Exception:
                pass
            out["instant"] = [r["name"] for r in fresh]
            feel.ask_spend(root, now)
        lt = time.localtime(now)
        today = time.strftime("%Y-%m-%d", lt)
        digest_day = state.get("digest_day", "")
        ok_digest, _why = feel.ask_allowed(root, "digest", now)
        if lt.tm_hour >= cfg["digest_hour"] and digest_day != today and ok_digest:
            digest_day = today
            soon_line = _use_soon_line(root, inv, lang, now)
            if rows or soon_line:
                shop = ai.shopping_list(inv, include_soon=True, lang=lang, today=today, now=now)
                head = feel.voice(lang)["digest_head"].format(n=len(rows)) if rows else ""
                listing = (shop.get("text_grouped") or shop["text"]) if rows else ""     # grouped by store when stores are known
                body = "\n".join(x for x in (soon_line, head, listing) if x)
                try:
                    _send(send, "Inventoria — " + ("morning digest" if lang == "en" else "résumé du matin"), body[:1500],
                          url="/#inventoria-shop")
                except Exception:
                    pass
                out["digest"] = True
                feel.ask_spend(root, now)
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
