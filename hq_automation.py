"""Schedules, automation rules, runbooks, backup catalog, telemetry, brief, push.

No arbitrary shell. Terminal steps accept an allowlisted command id only.
Callbacks are injected by iphone_bridge so this module stays free of HTTP
and of direct subprocess use.

State files (gitignored, never wiped when malformed):
  hq_automation.json, hq_runs.json, hq_telemetry.json,
  hq_backup_index.json, hq_push_subscriptions.json, hq_vapid.json
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from contextlib import nullcontext
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import hq_state

AUTOMATION_NAME = "hq_automation.json"
RUNS_NAME = "hq_runs.json"
TELEMETRY_NAME = "hq_telemetry.json"
BACKUP_INDEX_NAME = "hq_backup_index.json"
PUSH_NAME = "hq_push_subscriptions.json"
VAPID_NAME = "hq_vapid.json"

STEP_TYPES = {
    "explore",
    "action",
    "terminal",
    "backup",
    "capture",
    "print",
    "notify",
    "wait",
    "move",
    "scene",
    "condition",
}
ACTION_TYPES = {"notify", "scene", "journal", "backup", "terminal", "capture"}
TRIGGER_TYPES = {"event", "manual", "device_online", "disk_low"}
SCHEDULE_WHENS = {"online", "wake", "now", "daily", "weekdays", "weekly", "once", "on-online"}
LEGACY_WHENS = {"online", "wake", "now"}
SCHEDULED_WHENS = {"daily", "weekdays", "weekly", "once", "on-online"}
JOB_TYPES = {"explore", "action", "scene", "backup", "terminal", "notify", "capture"}
RESTORE_FOLDERS = {"Inbox", "Uni", "Print"}
CONDITION_CHECKS = {"disk_ok", "device_online", "file_exists"}

WAIT_STEP_MAX = 10.0
WAIT_RUN_MAX = 30.0
DEPTH_MAX = 3
STEPS_MAX = 32
EXEC_MAX = 64
RUNS_MAX = 200
RULES_MAX = 50
ACTIONS_MAX = 8
TELEMETRY_MAX = 5000
PUSH_MAX = 20
BACKUP_INDEX_MAX = 60
RESTORE_FILE_MAX = 5000
# One overdue calendar run after restart. Older slots are skipped, not replayed.
CATCHUP_WINDOW_SEC = 12 * 3600
PUSH_CATEGORIES = ("alert", "attention", "automation_failure")

_cb: dict[str, Any] = {}
_cause_local = threading.local()
_pushing = threading.local()
_ready = False
_last_local_sample = 0.0
_last_remote_sample = 0.0


def bind(**kwargs: Any) -> None:
    global _ready, _last_local_sample, _last_remote_sample
    _cb.update(kwargs)
    _ready = _cb.get("root") is not None
    _last_local_sample = 0.0
    _last_remote_sample = 0.0


def ready() -> bool:
    return _ready and _cb.get("root") is not None


def _root() -> Path:
    root = _cb.get("root")
    if root is None:
        raise RuntimeError("hq_automation non initialisé")
    return Path(root)


def _cfg() -> dict:
    fn = _cb.get("get_config")
    if callable(fn):
        data = fn()
        return data if isinstance(data, dict) else {}
    return {}


def _now() -> float:
    fn = _cb.get("now")
    if callable(fn):
        return float(fn())
    return time.time()


def _local_now() -> datetime:
    fn = _cb.get("local_now")
    if callable(fn):
        return fn()
    return datetime.now()


def _cause_stack() -> list[dict]:
    stack = getattr(_cause_local, "stack", None)
    if stack is None:
        stack = []
        _cause_local.stack = stack
    return stack


def _current_cause() -> dict:
    stack = getattr(_cause_local, "stack", None) or []
    if not stack:
        return {}
    top = stack[-1]
    out = {}
    if top.get("rule_id"):
        out["rule_id"] = str(top["rule_id"])[:40]
    if top.get("run_id"):
        out["run_id"] = str(top["run_id"])[:40]
    return out


def _journal(kind: str, message: str, *, level: str = "info", **meta: Any) -> None:
    fn = _cb.get("journal")
    if not callable(fn):
        return
    merged = _current_cause()
    merged.update(meta)
    try:
        fn(kind, message, level=level, **merged)
    except TypeError:
        try:
            fn(kind, message)
        except Exception:
            pass
    except Exception:
        pass


def _sleep(seconds: float) -> None:
    fn = _cb.get("sleep") or time.sleep
    fn(seconds)


# ---- safe JSON state (never clobber malformed files) ----

def _read_state(name: str, expect: str) -> tuple[Any, bool]:
    """Return (data, malformed). Missing -> (None, False)."""
    path = _root() / name
    if not path.is_file():
        return None, False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, True
    if expect == "dict" and not isinstance(data, dict):
        return None, True
    if expect == "list" and not isinstance(data, list):
        return None, True
    return data, False


def _write_state(name: str, data: Any) -> None:
    """Atomic replace. A missing file is created. A malformed file is kept."""
    path = _root() / name
    if path.is_file():
        _existing, bad = _read_state(name, "dict" if isinstance(data, dict) else "list")
        if bad:
            raise RuntimeError(f"{name} illisible — fichier conservé")
    hq_state.write_json_atomic(path, data)


# ---- scenes / runbooks ----

def _reject_raw_shell(step: dict) -> None:
    for key in ("cmd", "command", "shell", "host"):
        if key in step and step.get(key) not in (None, ""):
            raise ValueError("Shell arbitraire refusé")


def _terminal_allowed(cmd_id: str) -> bool:
    allowed = set()
    for c in _cfg().get("terminal_commands") or []:
        if isinstance(c, dict) and c.get("id"):
            allowed.add(str(c["id"]))
    return cmd_id in allowed


def _scene_by_id(scene_id: str) -> dict:
    scenes = _cfg().get("scenes") or []
    for scene in scenes:
        if isinstance(scene, dict) and str(scene.get("id") or "") == scene_id:
            return scene
    raise ValueError("Scène inconnue")


def _eval_condition(step: dict) -> bool:
    check = str(step.get("check") or "")
    if check not in CONDITION_CHECKS:
        raise ValueError("Condition inconnue")
    if check == "disk_ok":
        disk_free = _cb.get("disk_free")
        root = _root()
        info = disk_free(root) if callable(disk_free) else {}
        free = int((info or {}).get("free") or 0)
        try:
            min_gb = float(_cfg().get("alert_disk_min_gb") or 20)
        except (TypeError, ValueError):
            min_gb = 20.0
        return bool(free) and free >= min_gb * 1024**3
    if check == "device_online":
        want = str(step.get("device_id") or "pc-host")
        devices = _cb.get("devices")
        roster = devices() if callable(devices) else []
        for d in roster or []:
            if str(d.get("id") or "") == want:
                return bool(d.get("online"))
        return False
    if check == "file_exists":
        rel = str(step.get("rel") or "")
        fn = _cb.get("file_exists")
        if not callable(fn):
            return False
        return bool(fn(rel))
    return False


def _append_receipt(receipt: dict) -> None:
    data, bad = _read_state(RUNS_NAME, "dict")
    if bad:
        return
    if not isinstance(data, dict):
        data = {"version": 1, "runs": []}
    runs = [r for r in (data.get("runs") or []) if isinstance(r, dict)]
    runs.insert(0, receipt)
    data["version"] = 1
    data["runs"] = runs[:RUNS_MAX]
    try:
        _write_state(RUNS_NAME, data)
    except (OSError, RuntimeError):
        pass


def list_runs(*, limit: int = 20, offset: int = 0) -> dict:
    data, bad = _read_state(RUNS_NAME, "dict")
    runs = []
    if isinstance(data, dict):
        runs = [r for r in (data.get("runs") or []) if isinstance(r, dict)]
    offset = max(0, int(offset or 0))
    limit = max(0, int(limit or 0))
    return {
        "ok": not bad,
        "malformed": bad,
        "total": len(runs),
        "runs": runs[offset : offset + limit],
    }


def run_scene(scene_id: str, ctx: dict | None = None) -> dict:
    scene = _scene_by_id(str(scene_id or "").strip())
    own = ctx is None
    if own:
        ctx = {
            "depth": 0,
            "stack": [],
            "wait_used": 0.0,
            "executed": 0,
            "steps_log": [],
            "run_id": f"run-{uuid.uuid4().hex[:12]}",
            "root_scene": scene.get("id"),
            "started": _now(),
        }
    assert ctx is not None
    sid = str(scene.get("id") or scene_id)
    if sid in ctx["stack"]:
        raise ValueError("Récursion de scène")
    if ctx["depth"] >= DEPTH_MAX:
        raise ValueError("Profondeur de scène dépassée")
    steps = scene.get("steps") or []
    if not isinstance(steps, list):
        raise ValueError("Étapes invalides")
    if len(steps) > STEPS_MAX:
        raise ValueError("Trop d'étapes")
    stop_on_failure = scene.get("stop_on_failure")
    if stop_on_failure is None:
        stop_on_failure = True
    ctx["stack"].append(sid)
    ctx["depth"] += 1
    failed = False
    try:
        for index, step in enumerate(steps):
            if ctx["executed"] >= EXEC_MAX:
                raise ValueError("Budget d'étapes dépassé")
            if not isinstance(step, dict):
                raise ValueError("Étape invalide")
            try:
                detail = _run_step(step, ctx)
                ctx["steps_log"].append(
                    {"index": index, "type": step.get("type"), "ok": True, "detail": _short(detail)}
                )
            except Exception as e:
                failed = True
                ctx["steps_log"].append(
                    {
                        "index": index,
                        "type": step.get("type"),
                        "ok": False,
                        "detail": str(e)[:200],
                    }
                )
                if stop_on_failure:
                    break
    finally:
        ctx["depth"] -= 1
        ctx["stack"].pop()
    if own:
        receipt = {
            "id": ctx["run_id"],
            "scene_id": sid,
            "label": str(scene.get("label") or sid)[:80],
            "started": ctx["started"],
            "finished": _now(),
            "ok": not failed,
            "stop_on_failure": bool(stop_on_failure),
            "steps": ctx["steps_log"],
        }
        _append_receipt(receipt)
        _journal(
            "scene",
            f"Scène {scene.get('label') or sid} {'ok' if not failed else 'échec'}",
            level="info" if not failed else "warning",
            scene_id=sid,
        )
        if failed and stop_on_failure:
            return {"ok": False, "id": sid, "run": receipt, "error": "Étape en échec"}
        return {"ok": not failed, "id": sid, "run": receipt}
    return {"ok": not failed, "id": sid}


def _short(detail: Any) -> str:
    if detail is None:
        return ""
    if isinstance(detail, dict):
        return str({k: detail.get(k) for k in list(detail)[:4]})[:180]
    return str(detail)[:180]


def _run_step(step: dict, ctx: dict) -> Any:
    _reject_raw_shell(step)
    st = str(step.get("type") or "")
    if st not in STEP_TYPES:
        raise ValueError(f"Type d'étape inconnu: {st}")
    ctx["executed"] += 1
    if st == "explore":
        path = str(step.get("path") or "")
        if not path:
            raise ValueError("explore: chemin requis")
        fn = _cb.get("explore")
        if not callable(fn):
            raise ValueError("explore indisponible")
        fn(path)
        return {"path": path}
    if st == "action":
        aid = str(step.get("id") or step.get("action_id") or "")
        if not aid:
            raise ValueError("action: id requis")
        fn = _cb.get("action")
        if not callable(fn):
            raise ValueError("action indisponible")
        return fn(aid)
    if st == "terminal":
        cmd_id = str(step.get("id") or step.get("cmd_id") or "")
        if not cmd_id or not _terminal_allowed(cmd_id):
            raise ValueError("Commande non autorisée")
        fn = _cb.get("terminal")
        if not callable(fn):
            raise ValueError("terminal indisponible")
        return fn(cmd_id)
    if st == "backup":
        fn = _cb.get("backup")
        if not callable(fn):
            raise ValueError("backup indisponible")
        return fn()
    if st == "capture":
        fn = _cb.get("capture")
        if not callable(fn):
            raise ValueError("capture indisponible")
        return fn()
    if st == "print":
        rel = str(step.get("rel") or "")
        fn = _cb.get("print_file")
        if not callable(fn):
            raise ValueError("impression indisponible")
        return fn(rel)
    if st == "notify":
        title = str(step.get("title") or "HQ")[:120]
        body = str(step.get("body") or step.get("message") or "")[:500]
        fn = _cb.get("notify")
        if callable(fn):
            fn(title, body)
        _journal("notify", f"{title}: {body}"[:240], level="info")
        return {"title": title}
    if st == "wait":
        try:
            sec = float(step.get("seconds") if step.get("seconds") is not None else step.get("sec") or 1)
        except (TypeError, ValueError) as e:
            raise ValueError("Attente invalide") from e
        sec = max(0.0, min(WAIT_STEP_MAX, sec))
        if ctx["wait_used"] + sec > WAIT_RUN_MAX:
            raise ValueError("Attente totale dépassée")
        ctx["wait_used"] += sec
        if sec:
            _sleep(sec)
        return {"seconds": sec}
    if st == "move":
        src = str(step.get("src") or step.get("rel") or "")
        dest = str(step.get("dest") or "")
        fn = _cb.get("move")
        if not callable(fn):
            raise ValueError("déplacement indisponible")
        return fn(src, dest)
    if st == "scene":
        nested = str(step.get("id") or step.get("scene_id") or "")
        if not nested:
            raise ValueError("scène imbriquée: id requis")
        result = run_scene(nested, ctx)
        if isinstance(result, dict) and not result.get("ok", True):
            raise ValueError("Scène imbriquée en échec")
        return result
    if st == "condition":
        ok = _eval_condition(step)
        branch = step.get("then") if ok else step.get("else")
        if branch is None:
            branch = []
        if not isinstance(branch, list):
            raise ValueError("Branche de condition invalide")
        if len(branch) > STEPS_MAX:
            raise ValueError("Trop d'étapes")
        for sub in branch:
            if not isinstance(sub, dict):
                raise ValueError("Étape invalide")
            _run_step(sub, ctx)
        return {"check": step.get("check"), "ok": ok}
    raise ValueError("Étape non gérée")


# ---- automation rules ----

def _default_automation() -> dict:
    return {"version": 1, "rules": [], "meta": {}}


def _load_automation() -> tuple[dict, bool]:
    data, bad = _read_state(AUTOMATION_NAME, "dict")
    if bad:
        return _default_automation(), True
    if not isinstance(data, dict):
        return _default_automation(), False
    rules = [r for r in (data.get("rules") or []) if isinstance(r, dict)]
    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    return {"version": 1, "rules": rules[:RULES_MAX], "meta": meta}, False


def _save_automation(data: dict) -> None:
    _write_state(AUTOMATION_NAME, data)


def validate_rule(rule: dict) -> dict:
    if not isinstance(rule, dict):
        raise ValueError("Règle invalide")
    _reject_raw_shell(rule)
    rid = str(rule.get("id") or f"rule-{uuid.uuid4().hex[:8]}")[:40]
    if not re.fullmatch(r"[A-Za-z0-9_\-]{1,40}", rid):
        raise ValueError("Id de règle invalide")
    trigger = rule.get("trigger") if isinstance(rule.get("trigger"), dict) else {}
    ttype = str(trigger.get("type") or "")
    if ttype not in TRIGGER_TYPES:
        raise ValueError("Déclencheur inconnu")
    _reject_raw_shell(trigger)
    actions_in = rule.get("actions") or []
    if not isinstance(actions_in, list) or not actions_in or len(actions_in) > ACTIONS_MAX:
        raise ValueError("Actions invalides")
    actions = []
    for act in actions_in:
        if not isinstance(act, dict):
            raise ValueError("Action invalide")
        _reject_raw_shell(act)
        at = str(act.get("type") or "")
        if at not in ACTION_TYPES:
            raise ValueError("Type d'action inconnu")
        if at == "terminal":
            cmd_id = str(act.get("id") or act.get("cmd_id") or "")
            if not _terminal_allowed(cmd_id):
                raise ValueError("Commande non autorisée")
            actions.append({"type": "terminal", "id": cmd_id})
        elif at == "scene":
            actions.append({"type": "scene", "id": str(act.get("id") or "")[:40]})
        elif at == "notify":
            actions.append(
                {
                    "type": "notify",
                    "title": str(act.get("title") or "HQ")[:120],
                    "body": str(act.get("body") or act.get("message") or "")[:500],
                }
            )
        elif at == "journal":
            actions.append({"type": "journal", "message": str(act.get("message") or "")[:240]})
        else:
            actions.append({"type": at})
    try:
        cool = int(rule.get("cooldown_sec") or 300)
    except (TypeError, ValueError):
        cool = 300
    cool = max(30, min(86400, cool))
    clean_trigger: dict[str, Any] = {"type": ttype}
    if ttype == "event":
        clean_trigger["kind"] = str(trigger.get("kind") or "alert")[:40]
    if ttype == "device_online":
        clean_trigger["device_id"] = str(trigger.get("device_id") or "")[:80]
    return {
        "id": rid,
        "label": str(rule.get("label") or rid)[:80],
        "enabled": bool(rule.get("enabled", True)),
        "cooldown_sec": cool,
        "trigger": clean_trigger,
        "actions": actions,
        "last_fired": float(rule.get("last_fired") or 0),
    }


def list_rules() -> dict:
    data, bad = _load_automation()
    return {"ok": not bad, "malformed": bad, "rules": data.get("rules") or [], "meta": data.get("meta") or {}}


def _automation_lock():
    return hq_state.path_lock(_root() / AUTOMATION_NAME)


def save_rule(rule: dict) -> dict:
    with _automation_lock():
        return _save_rule(rule)


def _save_rule(rule: dict) -> dict:
    clean = validate_rule(rule)
    data, bad = _load_automation()
    if bad:
        raise RuntimeError("hq_automation.json illisible — fichier conservé")
    rules = data["rules"]
    replaced = False
    for i, existing in enumerate(rules):
        if existing.get("id") == clean["id"]:
            clean["last_fired"] = float(existing.get("last_fired") or 0)
            if "device_was_online" in existing:
                clean["device_was_online"] = bool(existing.get("device_was_online"))
            if "device_edge_pending" in existing:
                clean["device_edge_pending"] = bool(existing.get("device_edge_pending"))
            if existing.get("event_cursor_id"):
                clean["event_cursor_id"] = str(existing.get("event_cursor_id"))[:80]
            rules[i] = clean
            replaced = True
            break
    if not replaced:
        if len(rules) >= RULES_MAX:
            raise ValueError("Trop de règles")
        rules.append(clean)
    data["rules"] = rules
    _save_automation(data)
    _journal("automation", f"Règle enregistrée: {clean['label']}")
    return clean


def delete_rule(rule_id: str) -> dict:
    with _automation_lock():
        return _delete_rule(rule_id)


def _delete_rule(rule_id: str) -> dict:
    data, bad = _load_automation()
    if bad:
        raise RuntimeError("hq_automation.json illisible — fichier conservé")
    before = len(data["rules"])
    data["rules"] = [r for r in data["rules"] if r.get("id") != rule_id]
    if len(data["rules"]) == before:
        raise ValueError("Règle introuvable")
    _save_automation(data)
    _journal("automation", f"Règle supprimée: {rule_id}")
    return {"ok": True, "id": rule_id}


def set_rule_enabled(rule_id: str, enabled: bool) -> dict:
    with _automation_lock():
        return _set_rule_enabled(rule_id, enabled)


def _set_rule_enabled(rule_id: str, enabled: bool) -> dict:
    data, bad = _load_automation()
    if bad:
        raise RuntimeError("hq_automation.json illisible — fichier conservé")
    for rule in data["rules"]:
        if rule.get("id") == rule_id:
            rule["enabled"] = bool(enabled)
            _save_automation(data)
            return rule
    raise ValueError("Règle introuvable")


def _recent_events(limit: int = 100) -> list[dict]:
    fn = _cb.get("events_recent")
    if callable(fn):
        data = fn(limit)
    else:
        since_fn = _cb.get("events_since")
        data = since_fn(0) if callable(since_fn) else []
    if isinstance(data, dict):
        data = data.get("events") or []
    return [ev for ev in (data or []) if isinstance(ev, dict)][: max(1, int(limit or 100))]


def _observe_device_edge(rule: dict) -> tuple[bool, bool]:
    """Track offline→online. First sample only baselines. Returns (ready, dirty)."""
    trigger = rule.get("trigger") or {}
    online = _device_online(str(trigger.get("device_id") or ""))
    if "device_was_online" not in rule:
        rule["device_was_online"] = bool(online)
        rule["device_edge_pending"] = False
        return False, True
    prev = bool(rule.get("device_was_online"))
    dirty = False
    if prev != bool(online):
        rule["device_was_online"] = bool(online)
        dirty = True
    if (not prev) and online and not rule.get("device_edge_pending"):
        rule["device_edge_pending"] = True
        dirty = True
    ready = bool(rule.get("device_edge_pending")) and bool(online)
    return ready, dirty


def _event_match(rule: dict) -> tuple[dict | None, str]:
    """Newest-first journal. Skip this rule's own descendants. Do not move the cursor."""
    events = _recent_events(100)
    cursor = str(rule.get("event_cursor_id") or "")
    fresh: list[dict] = []
    for ev in events:
        if cursor and str(ev.get("id") or "") == cursor:
            break
        fresh.append(ev)
    kind = str((rule.get("trigger") or {}).get("kind") or "")
    rid = str(rule.get("id") or "")
    match = None
    for ev in reversed(fresh):
        meta = ev.get("meta") if isinstance(ev.get("meta"), dict) else {}
        if str(meta.get("rule_id") or "") == rid and rid:
            continue
        if kind and str(ev.get("kind") or "") != kind:
            continue
        match = ev
        break
    newest = str(events[0].get("id") or "") if events else ""
    return match, newest


def _advance_event_cursor(rule: dict) -> None:
    events = _recent_events(20)
    if events and events[0].get("id"):
        rule["event_cursor_id"] = str(events[0]["id"])[:80]


def _rule_triggered(rule: dict, *, manual: bool = False) -> bool:
    trigger = rule.get("trigger") or {}
    ttype = trigger.get("type")
    if manual:
        return True
    if ttype == "manual":
        return False
    if ttype == "disk_low":
        disk_free = _cb.get("disk_free")
        info = disk_free(_root()) if callable(disk_free) else {}
        free = int((info or {}).get("free") or 0)
        try:
            min_gb = float(_cfg().get("alert_disk_min_gb") or 20)
        except (TypeError, ValueError):
            min_gb = 20.0
        return bool(free) and free < min_gb * 1024**3
    # device_online and event are decided in run_rule (edge + cursor).
    return False


def _run_actions(actions: list[dict], *, origin: str) -> list[dict]:
    log = []
    for act in actions:
        at = act.get("type")
        try:
            if at == "notify":
                fn = _cb.get("notify")
                if callable(fn):
                    fn(str(act.get("title") or "HQ"), str(act.get("body") or ""))
                _journal("automation", f"{origin}: notify", level="info")
            elif at == "journal":
                _journal("automation", str(act.get("message") or origin)[:240], level="info")
            elif at == "scene":
                run_scene(str(act.get("id") or ""))
            elif at == "backup":
                fn = _cb.get("backup")
                if not callable(fn):
                    raise ValueError("backup indisponible")
                fn()
            elif at == "terminal":
                cmd_id = str(act.get("id") or "")
                if not _terminal_allowed(cmd_id):
                    raise ValueError("Commande non autorisée")
                fn = _cb.get("terminal")
                if not callable(fn):
                    raise ValueError("terminal indisponible")
                fn(cmd_id)
            elif at == "capture":
                fn = _cb.get("capture")
                if not callable(fn):
                    raise ValueError("capture indisponible")
                fn()
            else:
                raise ValueError("Action inconnue")
            log.append({"type": at, "ok": True})
        except Exception as e:
            log.append({"type": at, "ok": False, "error": str(e)[:200]})
            _journal("automation", f"{origin} échec {at}: {e}", level="warning")
            send_push(
                "Automatisation",
                f"{origin}: {at} — {e}"[:180],
                category="automation_failure",
            )
            break
    return log


def run_rule(rule_id: str, *, manual: bool = False, ignore_cooldown: bool = False) -> dict:
    with _automation_lock():
        return _run_rule(rule_id, manual=manual, ignore_cooldown=ignore_cooldown)


def _run_rule(rule_id: str, *, manual: bool = False, ignore_cooldown: bool = False) -> dict:
    data, bad = _load_automation()
    if bad:
        raise RuntimeError("hq_automation.json illisible — fichier conservé")
    if not _cfg().get("automation_enabled", True) and not manual:
        return {"ok": True, "skipped": True, "reason": "automation désactivée"}
    rule = next((r for r in data["rules"] if r.get("id") == rule_id), None)
    if not rule:
        raise ValueError("Règle introuvable")
    if not rule.get("enabled", True):
        return {"ok": True, "skipped": True, "reason": "règle désactivée"}
    now = _now()
    cool = int(rule.get("cooldown_sec") or 300)
    last = float(rule.get("last_fired") or 0)
    cooling = (not ignore_cooldown) and bool(last) and (now - last) < cool
    trigger = rule.get("trigger") or {}
    ttype = trigger.get("type")

    if manual:
        if cooling:
            return {"ok": True, "skipped": True, "reason": "cooldown"}
    elif ttype == "device_online":
        ready, dirty = _observe_device_edge(rule)
        if cooling or not ready:
            if dirty:
                _save_automation(data)
            if cooling:
                return {"ok": True, "skipped": True, "reason": "cooldown"}
            return {"ok": True, "skipped": True, "reason": "déclencheur inactif"}
    elif ttype == "event":
        match, newest = _event_match(rule)
        if cooling or match is None:
            dirty = False
            if match is None and newest and rule.get("event_cursor_id") != newest:
                rule["event_cursor_id"] = newest
                dirty = True
            if dirty:
                _save_automation(data)
            if cooling:
                return {"ok": True, "skipped": True, "reason": "cooldown"}
            return {"ok": True, "skipped": True, "reason": "déclencheur inactif"}
    else:
        if cooling:
            return {"ok": True, "skipped": True, "reason": "cooldown"}
        if not _rule_triggered(rule, manual=False):
            return {"ok": True, "skipped": True, "reason": "déclencheur inactif"}

    stack = _cause_stack()
    stack.append({"rule_id": str(rule.get("id") or rule_id), "run_id": f"ar-{uuid.uuid4().hex[:12]}"})
    try:
        log = _run_actions(rule.get("actions") or [], origin=str(rule.get("label") or rule_id))
    finally:
        stack.pop()
    rule["last_fired"] = now
    if ttype == "device_online":
        rule["device_edge_pending"] = False
    if ttype == "event":
        _advance_event_cursor(rule)
    _save_automation(data)
    ok = all(item.get("ok") for item in log) if log else True
    return {"ok": ok, "id": rule_id, "actions": log}


def evaluate_rules() -> list[dict]:
    if not _cfg().get("automation_enabled", True):
        return []
    data, bad = _load_automation()
    if bad:
        return []
    fired = []
    for rule in list(data.get("rules") or []):
        if not rule.get("enabled", True):
            continue
        if (rule.get("trigger") or {}).get("type") == "manual":
            continue
        try:
            result = run_rule(str(rule.get("id") or ""), manual=False)
        except Exception as e:
            _journal("automation", f"Règle {rule.get('id')}: {e}", level="warning")
            continue
        if result and not result.get("skipped"):
            fired.append(result)
    return fired


# ---- schedules (extend the existing queue) ----

_AT_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def normalize_schedule_job(job: dict) -> dict:
    if not isinstance(job, dict):
        raise ValueError("Tâche invalide")
    _reject_raw_shell(job)
    when = str(job.get("when") or "online")
    if when not in SCHEDULE_WHENS:
        raise ValueError("when invalide")
    typ = str(job.get("type") or "explore")
    if typ not in JOB_TYPES:
        raise ValueError("type invalide")
    if typ == "terminal":
        cmd_id = str(job.get("cmd_id") or job.get("id") or job.get("action_id") or "")
        # `id` on a job is the queue id, so terminal id lives in cmd_id.
        if not cmd_id or not _terminal_allowed(cmd_id):
            raise ValueError("Commande non autorisée")
    stored: dict[str, Any] = {
        "id": str(job.get("id") or f"q-{int(_now() * 1000)}")[:48],
        "label": str(job.get("label") or "Tâche")[:80],
        "when": when,
        "type": typ,
        "path": job.get("path"),
        "action_id": job.get("action_id"),
        "scene_id": job.get("scene_id"),
        "cmd_id": str(job.get("cmd_id") or "")[:40] or None,
        "created": float(job.get("created") or _now()),
        "status": str(job.get("status") or "pending"),
        "last_minute": job.get("last_minute") or "",
        "last_fired": float(job.get("last_fired") or 0),
    }
    if when in ("daily", "weekdays", "weekly"):
        at = str(job.get("at") or "").strip()
        if not _AT_RE.match(at):
            raise ValueError("at HH:MM requis")
        stored["at"] = at
    if when == "weekly":
        try:
            weekday = int(job.get("weekday"))
        except (TypeError, ValueError) as e:
            raise ValueError("weekday 0-6 requis") from e
        if weekday < 0 or weekday > 6:
            raise ValueError("weekday 0-6 requis")
        stored["weekday"] = weekday
    if when == "once":
        try:
            once_at = float(job.get("once_at") or 0)
        except (TypeError, ValueError) as e:
            raise ValueError("once_at requis") from e
        if once_at <= 0:
            raise ValueError("once_at requis")
        stored["once_at"] = once_at
    if when == "on-online":
        device_id = str(job.get("device_id") or "").strip()
        if not device_id:
            raise ValueError("device_id requis")
        stored["device_id"] = device_id[:80]
    if typ == "notify":
        stored["title"] = str(job.get("title") or stored["label"])[:120]
        stored["body"] = str(job.get("body") or "")[:500]
    return stored


def _minute_key(moment: datetime | None = None) -> str:
    moment = moment or _local_now()
    return moment.strftime("%Y-%m-%dT%H:%M")


def _device_online(device_id: str) -> bool:
    devices = _cb.get("devices")
    roster = devices() if callable(devices) else []
    for d in roster or []:
        if str(d.get("id") or "") == device_id:
            return bool(d.get("online"))
    return False


def _schedule_due(job: dict, moment: datetime, now: float) -> bool:
    when = job.get("when")
    if when not in SCHEDULED_WHENS:
        return False
    if job.get("status") not in ("pending", "armed"):
        return False
    if when == "once":
        return now >= float(job.get("once_at") or 0) and job.get("status") == "pending"
    if when == "on-online":
        online = _device_online(str(job.get("device_id") or ""))
        if job.get("status") == "armed":
            return False
        return online
    at = str(job.get("at") or "")
    if moment.strftime("%H:%M") != at:
        return False
    if when == "weekdays" and moment.weekday() >= 5:
        return False
    if when == "weekly" and moment.weekday() != int(job.get("weekday") or 0):
        return False
    return True


def _run_scheduled_job(job: dict) -> None:
    typ = job.get("type")
    _reject_raw_shell(job)
    if typ == "explore":
        fn = _cb.get("explore")
        if not callable(fn):
            raise ValueError("explore indisponible")
        fn(str(job.get("path") or ""))
    elif typ == "action":
        fn = _cb.get("action")
        if not callable(fn):
            raise ValueError("action indisponible")
        fn(str(job.get("action_id") or ""))
    elif typ == "scene":
        run_scene(str(job.get("scene_id") or ""))
    elif typ == "backup":
        fn = _cb.get("backup")
        if not callable(fn):
            raise ValueError("backup indisponible")
        fn()
    elif typ == "terminal":
        cmd_id = str(job.get("cmd_id") or "")
        if not _terminal_allowed(cmd_id):
            raise ValueError("Commande non autorisée")
        fn = _cb.get("terminal")
        if not callable(fn):
            raise ValueError("terminal indisponible")
        fn(cmd_id)
    elif typ == "notify":
        fn = _cb.get("notify")
        if callable(fn):
            fn(str(job.get("title") or job.get("label") or "HQ"), str(job.get("body") or ""))
        _journal("schedule", str(job.get("label") or "notify"), level="info")
    elif typ == "capture":
        fn = _cb.get("capture")
        if not callable(fn):
            raise ValueError("capture indisponible")
        fn()
    else:
        raise ValueError("Job invalide")


def _fmt_slot(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M")


def _calendar_matches(job: dict, moment: datetime) -> bool:
    when = job.get("when")
    at = str(job.get("at") or "")
    match = _AT_RE.match(at)
    if not match:
        return False
    if moment.hour != int(match.group(1)) or moment.minute != int(match.group(2)):
        return False
    if when == "daily":
        return True
    if when == "weekdays":
        return moment.weekday() < 5
    if when == "weekly":
        raw = job.get("weekday")
        try:
            weekday = int(raw)
        except (TypeError, ValueError):
            return False
        return moment.weekday() == weekday
    return False


def _next_calendar_after(job: dict, after: datetime) -> datetime | None:
    """First daily/weekdays/weekly slot strictly after ``after``."""
    when = job.get("when")
    at = str(job.get("at") or "")
    match = _AT_RE.match(at)
    if when not in ("daily", "weekdays", "weekly") or not match:
        return None
    hh, mm = int(match.group(1)), int(match.group(2))
    cursor = after.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if cursor <= after:
        cursor += timedelta(days=1)
    weekday = None
    if when == "weekly":
        try:
            weekday = int(job.get("weekday"))
        except (TypeError, ValueError):
            return None
    for _ in range(14):
        if when == "daily":
            return cursor
        if when == "weekdays" and cursor.weekday() < 5:
            return cursor
        if when == "weekly" and cursor.weekday() == weekday:
            return cursor
        cursor += timedelta(days=1)
    return None


def _recurring_created(job: dict) -> datetime | None:
    """HQ-local creation instant for a recurring job. Unusable values mean no floor."""
    raw = job.get("created")
    if isinstance(raw, bool):
        return None
    try:
        stamp = float(raw)
    except (TypeError, ValueError):
        return None
    if stamp <= 0:
        return None
    try:
        return datetime.fromtimestamp(stamp)
    except (OSError, OverflowError, ValueError):
        return None


def project_schedule_slots(job: dict, start: datetime, end: datetime) -> list[datetime]:
    """Read-only occurrences in ``[start, end)``.

    Uses the same daily / weekdays / weekly / once rules as the scheduler.
    Does not write ``next_run`` or any other field on ``job``.
    ``online``, ``wake``, and ``on-online`` are not grid times and yield nothing.
    Recurring slots start at ``max(start, job.created)``: a daily 08:00 job
    created at 10:00 does not appear earlier that day, or in earlier months.
    """
    if not isinstance(job, dict) or not isinstance(start, datetime) or not isinstance(end, datetime):
        return []
    if end <= start:
        return []
    when = str(job.get("when") or "")
    if when == "once":
        try:
            stamp = float(job.get("once_at") or 0)
        except (TypeError, ValueError):
            return []
        if stamp <= 0:
            return []
        moment = datetime.fromtimestamp(stamp).replace(second=0, microsecond=0)
        if start <= moment < end:
            return [moment]
        return []
    if when not in ("daily", "weekdays", "weekly"):
        return []
    effective = start
    created = _recurring_created(job)
    if created is not None and created > effective:
        effective = created
    if effective >= end:
        return []
    cursor = effective - timedelta(minutes=1)
    found: list[datetime] = []
    for _ in range(400):
        nxt = _next_calendar_after(job, cursor)
        if nxt is None or nxt >= end:
            break
        if nxt >= effective:
            found.append(nxt)
        cursor = nxt
    return found


def _calendar_plan(job: dict, moment: datetime) -> str:
    """Return fire, reschedule, or same. Reschedule writes the next future slot only."""
    if job.get("status") not in (None, "", "pending", "armed"):
        return "same"
    current = moment.replace(second=0, microsecond=0)
    raw = job.get("next_run")
    slot = None
    if isinstance(raw, str) and raw:
        try:
            slot = datetime.strptime(raw, "%Y-%m-%dT%H:%M")
        except ValueError:
            slot = None
    if slot is None:
        if _calendar_matches(job, moment):
            return "fire"
        nxt = _next_calendar_after(job, current - timedelta(seconds=1))
        formatted = _fmt_slot(nxt) if nxt else ""
        if formatted and job.get("next_run") != formatted:
            job["next_run"] = formatted
            return "reschedule"
        return "same"
    if slot > current:
        return "same"
    window_start = current - timedelta(seconds=CATCHUP_WINDOW_SEC)
    if slot < window_start:
        nxt = _next_calendar_after(job, current)
        formatted = _fmt_slot(nxt) if nxt else ""
        if formatted and job.get("next_run") != formatted:
            job["next_run"] = formatted
            return "reschedule"
        return "same"
    return "fire"


def _commit_schedule_fire(job: dict, *, minute: str, now: float) -> bool:
    when = job.get("when")
    job["last_minute"] = minute
    try:
        _run_scheduled_job(job)
        job["last_fired"] = now
        job["error"] = ""
        if when == "once":
            job["status"] = "done"
        elif when == "on-online":
            job["status"] = "armed"
        else:
            job["status"] = "pending"
        _journal("schedule", f"Planifié: {job.get('label')}", level="info")
        return True
    except Exception as e:
        job["error"] = str(e)[:200]
        if when == "once":
            job["status"] = "error"
        _journal("schedule", f"Échec planifié {job.get('label')}: {e}", level="warning")
        return False


def _advance_calendar(job: dict, moment: datetime) -> None:
    current = moment.replace(second=0, microsecond=0)
    nxt = _next_calendar_after(job, current)
    if nxt is not None:
        job["next_run"] = _fmt_slot(nxt)


def process_schedules(items: list[dict]) -> dict:
    """Mutates queue items in place. Once-per-minute guard. Returns fired + changed.

    Calendar jobs persist ``next_run``. If HQ was down, one overdue slot inside
    CATCHUP_WINDOW_SEC (12 h) runs on the next tick. Older periods are skipped.
    """
    if not isinstance(items, list):
        return {"fired": [], "changed": False}
    if not _cfg().get("schedules_enabled", True):
        return {"fired": [], "changed": False}
    moment = _local_now()
    now = _now()
    minute = _minute_key(moment)
    fired: list[dict] = []
    changed = False
    for job in items:
        if not isinstance(job, dict):
            continue
        when = job.get("when")
        if when == "on-online" and job.get("status") == "armed":
            if not _device_online(str(job.get("device_id") or "")):
                job["status"] = "pending"
                changed = True
            continue
        if when in ("daily", "weekdays", "weekly"):
            plan = _calendar_plan(job, moment)
            if plan == "same":
                continue
            if plan == "reschedule":
                changed = True
                continue
            if job.get("last_minute") == minute:
                continue
            changed = True
            if _commit_schedule_fire(job, minute=minute, now=now):
                fired.append(job)
            _advance_calendar(job, moment)
            continue
        if when not in SCHEDULED_WHENS:
            continue
        if job.get("last_minute") == minute:
            continue
        if not _schedule_due(job, moment, now):
            continue
        changed = True
        if _commit_schedule_fire(job, minute=minute, now=now):
            fired.append(job)
    return {"fired": fired, "changed": changed}


# ---- backup catalog + safe restore ----

_BACKUP_ID = re.compile(r"^\d{8}_\d{6}$")


def note_backup(info: dict) -> dict:
    if not isinstance(info, dict):
        raise ValueError("Backup invalide")
    bid = str(info.get("id") or "")
    if not _BACKUP_ID.match(bid):
        # accept path stamp
        path = str(info.get("path") or "")
        bid = Path(path).name
    if not _BACKUP_ID.match(bid):
        raise ValueError("Identifiant de backup invalide")
    with hq_state.path_lock(_root() / BACKUP_INDEX_NAME):
        entry = _note_backup_locked(bid, info)
    _journal("backup", f"Catalogue backup {bid}", level="info")
    return entry


def _note_backup_locked(bid: str, info: dict) -> dict:
    data, bad = _read_state(BACKUP_INDEX_NAME, "dict")
    if bad:
        raise RuntimeError("hq_backup_index.json illisible — fichier conservé")
    if not isinstance(data, dict):
        data = {"version": 1, "backups": []}
    entry = {
        "id": bid,
        "path": str(info.get("path") or "")[:300],
        "at": float(info.get("at") or _now()),
        "folders": int(info.get("folders") or 0),
    }
    carnet = info.get("carnet")
    if isinstance(carnet, dict):
        # Separate Carnet status; never folded into the legacy `folders` count.
        entry["carnet"] = {
            "status": str(carnet.get("status") or "")[:20],
            "ok": carnet.get("ok") is True,
            "included": carnet.get("included") is True,
        }
        if "valid" in carnet:
            entry["carnet"]["valid"] = carnet.get("valid") is True
    items = [b for b in (data.get("backups") or []) if isinstance(b, dict) and b.get("id") != bid]
    items.insert(0, entry)
    data["version"] = 1
    data["backups"] = items[:BACKUP_INDEX_MAX]
    _write_state(BACKUP_INDEX_NAME, data)
    return entry


def _index_path_key(path: str) -> str:
    return os.path.normcase(os.path.normpath(path)) if path else ""


def forget_backups(paths: list[str]) -> int:
    """Drop the catalog entries of purged backup folders (matched by full path).

    Entries of other folders, or of the same id under another backup_dir, are kept.
    A malformed index is never rewritten (RuntimeError)."""
    targets = {_index_path_key(str(p)) for p in paths if p}
    if not targets:
        return 0
    with hq_state.path_lock(_root() / BACKUP_INDEX_NAME):
        data, bad = _read_state(BACKUP_INDEX_NAME, "dict")
        if bad:
            raise RuntimeError("hq_backup_index.json illisible — fichier conservé")
        if not isinstance(data, dict):
            return 0
        items = list(data.get("backups") or [])
        keep = [b for b in items if not (isinstance(b, dict) and _index_path_key(str(b.get("path") or "")) in targets)]
        removed = len(items) - len(keep)
        if removed:
            data["backups"] = keep
            _write_state(BACKUP_INDEX_NAME, data)
    if removed:
        _journal("backup", f"Catalogue : {removed} backup(s) purgé(s) retiré(s)", level="info")
    return removed


def list_backups() -> dict:
    data, bad = _read_state(BACKUP_INDEX_NAME, "dict")
    items = []
    if isinstance(data, dict):
        items = [b for b in (data.get("backups") or []) if isinstance(b, dict)]
    return {"ok": not bad, "malformed": bad, "backups": items}


def _backup_root() -> Path:
    raw = str(_cfg().get("backup_dir") or "").strip()
    if not raw:
        raise ValueError("backup_dir non configuré")
    return Path(raw).resolve()


def restore_backup(backup_id: str, folder: str, *, confirm: bool) -> dict:
    if confirm is not True:
        raise ValueError("Confirmation d'écrasement requise")
    folder = str(folder or "")
    if folder not in RESTORE_FOLDERS:
        raise ValueError("Dossier de restauration invalide")
    if not _BACKUP_ID.match(str(backup_id or "")):
        raise ValueError("Identifiant de backup invalide")
    backup_root = _backup_root()
    src = (backup_root / backup_id / folder).resolve()
    try:
        src.relative_to(backup_root)
    except ValueError as e:
        raise ValueError("Backup hors périmètre") from e
    if not src.is_dir():
        raise ValueError("Backup introuvable")
    root = _root().resolve()
    dest = (root / folder).resolve()
    try:
        dest.relative_to(root)
    except ValueError as e:
        raise ValueError("Destination hors périmètre") from e
    dest.mkdir(parents=True, exist_ok=True)
    planned: list[tuple[Path, Path]] = []
    for path in src.rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        try:
            path.resolve().relative_to(src)
        except ValueError:
            continue
        rel = path.relative_to(src)
        if any(part in (".", "..") or part.startswith(".") for part in rel.parts):
            continue
        target = (dest / rel).resolve()
        try:
            target.relative_to(dest)
        except ValueError:
            continue
        planned.append((path, target))
        if len(planned) > RESTORE_FILE_MAX:
            raise ValueError("Trop de fichiers à restaurer")
    copied = 0
    overwritten = 0
    for path, target in planned:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            overwritten += 1
        shutil.copy2(path, target)
        copied += 1
    _journal(
        "backup",
        f"Restauration {backup_id}/{folder} · {copied} fichier(s), {overwritten} écrasé(s)",
        level="warning",
    )
    return {
        "ok": True,
        "id": backup_id,
        "folder": folder,
        "copied": copied,
        "overwritten": overwritten,
    }


# ---- telemetry (cached samples only) ----

def _telemetry_doc() -> tuple[dict, bool]:
    data, bad = _read_state(TELEMETRY_NAME, "dict")
    if bad:
        return {"version": 1, "samples": []}, True
    if not isinstance(data, dict):
        return {"version": 1, "samples": []}, False
    samples = [s for s in (data.get("samples") or []) if isinstance(s, dict)]
    return {"version": 1, "samples": samples}, False


def record_samples(items: list[dict]) -> None:
    """Append several samples with one read and one atomic write.

    Each item: {"device_id", "free", "total", "scope"}.
    """
    items = [it for it in (items or []) if isinstance(it, dict)]
    if not items:
        return
    doc, bad = _telemetry_doc()  # the single parse; malformed file -> kept, skip
    if bad:
        return
    try:
        retain_h = int(_cfg().get("telemetry_retain_hours") or 36)
    except (TypeError, ValueError):
        retain_h = 36
    retain_h = max(24, min(48, retain_h))
    now = _now()
    for it in items:
        free = it.get("free")
        total = it.get("total")
        scope = it.get("scope")
        pct = None
        if free is not None and total:
            try:
                pct = round(100.0 * (1 - (float(free) / float(total))), 2)
            except (TypeError, ValueError, ZeroDivisionError):
                pct = None
        doc["samples"].append(
            {
                "t": now,
                "device": str(it.get("device_id"))[:80],
                "free": free,
                "total": total,
                "pct_used": pct,
                "scope": "remote" if scope == "remote" else "local",
            }
        )
    cutoff = now - retain_h * 3600
    doc["samples"] = [s for s in doc["samples"] if float(s.get("t") or 0) >= cutoff][-TELEMETRY_MAX:]
    try:
        # Already parsed + validated above: skip _write_state/write_json_atomic re-parses.
        hq_state.write_json_atomic(_root() / TELEMETRY_NAME, doc, verify_existing=False, compact=True)
    except (OSError, RuntimeError):
        pass


def record_sample(device_id: str, *, free: int | None, total: int | None, scope: str) -> None:
    record_samples([{"device_id": device_id, "free": free, "total": total, "scope": scope}])


def sample_from_devices(devices: list[dict]) -> None:
    """Record telemetry from an already-cached roster. Does not probe."""
    global _last_local_sample, _last_remote_sample
    now = _now()
    try:
        local_every = int(_cfg().get("telemetry_local_sec") or 45)
    except (TypeError, ValueError):
        local_every = 45
    local_every = max(30, min(60, local_every))
    try:
        remote_every = int(_cfg().get("telemetry_remote_sec") or 180)
    except (TypeError, ValueError):
        remote_every = 180
    remote_every = max(120, min(600, remote_every))
    take_local = (now - _last_local_sample) >= local_every
    take_remote = (now - _last_remote_sample) >= remote_every
    if not take_local and not take_remote:
        return
    batch: list[dict] = []
    for device in devices or []:
        if not isinstance(device, dict):
            continue
        scope = "local" if device.get("source") == "host" or device.get("id") == "pc-host" else "remote"
        if scope == "local" and not take_local:
            continue
        if scope == "remote" and not take_remote:
            continue
        disks = device.get("disks") or []
        if isinstance(disks, list) and disks:
            for disk in disks:
                if not isinstance(disk, dict):
                    continue
                batch.append({
                    "device_id": f"{device.get('id')}:{disk.get('name') or 'disk'}",
                    "free": disk.get("free"),
                    "total": disk.get("total"),
                    "scope": scope,
                })
        elif device.get("free") is not None or device.get("total") is not None:
            batch.append({
                "device_id": str(device.get("id") or "device"),
                "free": device.get("free"),
                "total": device.get("total"),
                "scope": scope,
            })
    record_samples(batch)  # one read + one write per tick
    if take_local:
        _last_local_sample = now
    if take_remote:
        _last_remote_sample = now


def telemetry_series(device: str | None = None, *, limit: int = 240) -> dict:
    doc, bad = _telemetry_doc()
    samples = doc.get("samples") or []
    if device:
        samples = [s for s in samples if str(s.get("device") or "") == device or str(s.get("device") or "").startswith(device + ":")]
    limit = max(1, min(1000, int(limit or 240)))
    return {"ok": not bad, "malformed": bad, "samples": samples[-limit:]}


# ---- daily brief ----

def build_brief(*, state: str, attention: list[dict], events: list[dict], queue: list[dict], backups: list[dict], disk: dict | None = None) -> dict:
    moment = _local_now()
    lines: list[str] = []
    label = {"ok": "OK", "warning": "Attention", "critical": "Critique"}.get(state, state or "OK")
    lines.append(f"État HQ : {label}.")
    if disk and disk.get("free_h"):
        lines.append(f"Espace libre : {disk.get('free_h')}.")
    if attention:
        lines.append(f"{len(attention)} point(s) d'attention.")
        for item in attention[:5]:
            lines.append(f"- {item.get('title') or 'Attention'}: {item.get('detail') or ''}".strip())
    else:
        lines.append("Aucun point d'attention.")
    pending = [j for j in (queue or []) if isinstance(j, dict) and j.get("status") == "pending"]
    lines.append(f"File : {len(pending)} tâche(s) en attente.")
    kinds: dict[str, int] = {}
    cutoff = _now() - 86400
    for ev in events or []:
        try:
            ts = float(ev.get("ts") or 0)
        except (TypeError, ValueError):
            ts = 0
        if ts < cutoff:
            continue
        k = str(ev.get("kind") or "info")
        kinds[k] = kinds.get(k, 0) + 1
    if kinds:
        summary = ", ".join(f"{k} {n}" for k, n in sorted(kinds.items()))
        lines.append(f"Journal 24 h : {summary}.")
    else:
        lines.append("Journal 24 h : aucun événement.")
    if backups:
        last = backups[0]
        lines.append(f"Dernier backup catalogué : {last.get('id') or '?'}.")
    else:
        lines.append("Aucun backup catalogué.")
    return {
        "ok": True,
        "title": f"Brief du {moment.strftime('%Y-%m-%d')}",
        "date": moment.strftime("%Y-%m-%d"),
        "state": state or "ok",
        "lines": lines,
        "generated_at": _now(),
    }


def maybe_send_brief(brief: dict, *, force: bool = False) -> dict:
    """Send the daily brief, then stamp ``last_brief_date`` on a fresh snapshot.

    ``notify`` runs outside ``_automation_lock`` (Discord send is threaded and
    returns immediately). The date is written on a reload so a rule save during
    notify is not overwritten by the pre-notify snapshot.
    """
    cfg = _cfg()
    webhook = str(cfg.get("discord_webhook_url") or "").strip()
    enabled = bool(cfg.get("daily_brief_discord"))
    if not enabled or not webhook:
        return {"ok": True, "sent": False, "reason": "Discord brief désactivé"}
    fn = _cb.get("notify")
    if not callable(fn):
        return {"ok": False, "sent": False, "reason": "notify indisponible"}
    today = _local_now().strftime("%Y-%m-%d")
    with _automation_lock():
        data, bad = _load_automation()
        if bad:
            return {"ok": False, "sent": False, "reason": "état automation illisible"}
        meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
        if not force and meta.get("last_brief_date") == today:
            return {"ok": True, "sent": False, "reason": "déjà envoyé aujourd'hui"}
    fn(str(brief.get("title") or "Brief"), "\n".join(brief.get("lines") or [])[:1800])
    with _automation_lock():
        data, bad = _load_automation()
        if bad:
            return {"ok": False, "sent": True, "reason": "état automation illisible"}
        meta = data.setdefault("meta", {})
        if not isinstance(meta, dict):
            meta = {}
            data["meta"] = meta
        meta["last_brief_date"] = today
        try:
            _save_automation(data)
        except (OSError, RuntimeError):
            pass
    _journal("brief", "Brief envoyé sur Discord", level="info")
    return {"ok": True, "sent": True}


# ---- web push (opt-in, no send without pywebpush) ----

def push_status() -> dict:
    cfg = _cfg()
    enabled = bool(cfg.get("push_enabled"))
    public = ""
    error = ""
    if enabled:
        try:
            public = vapid_public_key()
        except Exception as e:
            error = str(e)[:200]
    data, bad = _read_state(PUSH_NAME, "dict")
    count = 0
    if isinstance(data, dict):
        count = len(data.get("subscriptions") or [])
    return {
        "ok": True,
        "enabled": enabled,
        "configured": bool(public),
        "public_key": public,
        "subscriptions": count,
        "malformed": bad,
        "error": error,
        "categories": list(PUSH_CATEGORIES),
        "https_note": (
            "Web Push opt-in (HTTPS / Tailscale Serve) : alertes, attention critique "
            "et échec d'automatisation. Pas toutes les notifications HQ."
        ),
    }


def _vapid_path() -> Path:
    return _root() / VAPID_NAME


def vapid_public_key() -> str:
    """Return base64url uncompressed P-256 public key. Generates keys if missing.

    Private key stays in hq_vapid.json. Never log it or return it.
    """
    path = _vapid_path()
    with hq_state.path_lock(path):
        return _vapid_public_key_locked(path)


def _vapid_public_key_locked(path: Path) -> str:
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise RuntimeError("hq_vapid.json illisible — fichier conservé") from e
        if isinstance(data, dict) and data.get("public_key"):
            return str(data["public_key"])
        raise RuntimeError("hq_vapid.json illisible — fichier conservé")
    try:
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives import serialization
        import base64
    except ImportError as e:
        raise RuntimeError("cryptography non installé — Web Push indisponible") from e
    key = ec.generate_private_key(ec.SECP256R1())
    raw_pub = key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    priv_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")
    public = base64.urlsafe_b64encode(raw_pub).decode("ascii").rstrip("=")
    payload = {"public_key": public, "private_pem": priv_pem}
    hq_state.write_json_atomic(path, payload)
    return public


def _load_subs() -> tuple[dict, bool]:
    data, bad = _read_state(PUSH_NAME, "dict")
    if bad:
        return {"version": 1, "subscriptions": []}, True
    if not isinstance(data, dict):
        return {"version": 1, "subscriptions": []}, False
    subs = [s for s in (data.get("subscriptions") or []) if isinstance(s, dict)]
    return {"version": 1, "subscriptions": subs[:PUSH_MAX]}, False


def subscribe_push(sub: dict) -> dict:
    if not _cfg().get("push_enabled"):
        raise ValueError("Web Push désactivé (push_enabled)")
    if not isinstance(sub, dict):
        raise ValueError("Abonnement invalide")
    endpoint = str(sub.get("endpoint") or "").strip()
    keys = sub.get("keys") if isinstance(sub.get("keys"), dict) else {}
    if not endpoint.startswith("https://") or len(endpoint) > 500:
        raise ValueError("Endpoint HTTPS requis")
    p256dh = str(keys.get("p256dh") or "")
    auth = str(keys.get("auth") or "")
    if not p256dh or not auth or len(p256dh) > 200 or len(auth) > 200:
        raise ValueError("Clés d'abonnement invalides")
    data, bad = _load_subs()
    if bad:
        raise RuntimeError("hq_push_subscriptions.json illisible — fichier conservé")
    clean = {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}, "at": _now()}
    subs = [s for s in data["subscriptions"] if s.get("endpoint") != endpoint]
    subs.insert(0, clean)
    data["subscriptions"] = subs[:PUSH_MAX]
    _write_state(PUSH_NAME, data)
    _journal("push", "Abonnement Web Push enregistré", level="info")
    return {"ok": True, "endpoint": endpoint[:80]}


def unsubscribe_push(endpoint: str) -> dict:
    data, bad = _load_subs()
    if bad:
        raise RuntimeError("hq_push_subscriptions.json illisible — fichier conservé")
    endpoint = str(endpoint or "").strip()
    data["subscriptions"] = [s for s in data["subscriptions"] if s.get("endpoint") != endpoint]
    _write_state(PUSH_NAME, data)
    return {"ok": True}


def push_enabled() -> bool:
    return bool(_cfg().get("push_enabled"))


def _deliver_push(sub: dict, payload: str) -> int:
    """Return HTTP-like status. 404/410 means the subscription is gone. -1: no sender."""
    transport = _cb.get("push_transport")
    if callable(transport):
        return int(transport(sub, payload) or 0)
    try:
        from pywebpush import webpush
    except ImportError:
        return -1
    path = _vapid_path()
    try:
        vapid = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    if not isinstance(vapid, dict):
        return 0
    priv = str(vapid.get("private_pem") or "")
    if not priv:
        return 0
    try:
        webpush(
            subscription_info={"endpoint": sub.get("endpoint"), "keys": sub.get("keys")},
            data=payload,
            vapid_private_key=priv,
            vapid_claims={"sub": "mailto:hq@transfert.local"},
        )
        return 201
    except Exception as e:
        response = getattr(e, "response", None)
        status = getattr(response, "status_code", None) if response is not None else None
        if status:
            return int(status)
        return 500


def send_push(title: str, body: str, *, category: str = "alert", url: str = "/") -> dict:
    """Send one opt-in notification. Never returns or logs VAPID private material.

    Categories: alert, attention (critical), automation_failure.
    404/410 subscriptions are pruned. No-op when push_enabled is false.
    """
    if category not in PUSH_CATEGORIES:
        return {"ok": False, "sent": 0, "pruned": 0, "errors": 0, "error": "catégorie ignorée"}
    if not push_enabled():
        return {"ok": False, "sent": 0, "pruned": 0, "errors": 0, "error": "Web Push désactivé"}
    if getattr(_pushing, "on", False):
        return {"ok": False, "sent": 0, "pruned": 0, "errors": 0, "error": "reentrant"}
    _pushing.on = True
    try:
        data, bad = _load_subs()
        if bad:
            return {"ok": False, "sent": 0, "pruned": 0, "errors": 0, "error": "abonnements illisibles"}
        subs = list(data.get("subscriptions") or [])
        if not subs:
            return {"ok": False, "sent": 0, "pruned": 0, "errors": 0, "error": "aucun abonné"}
        payload = json.dumps(
            {
                "title": str(title or "HQ")[:80],
                "body": str(body or "")[:180],
                "url": str(url or "/")[:200],
                "category": category,
            },
            ensure_ascii=False,
        )
        sent = 0
        pruned = 0
        errors = 0
        missing_lib = False
        keep: list[dict] = []
        for sub in subs:
            status = _deliver_push(sub, payload)
            if status == -1:
                missing_lib = True
                keep.append(sub)
                errors += 1
                continue
            if status in (404, 410):
                pruned += 1
                continue
            keep.append(sub)
            if status in (200, 201, 202):
                sent += 1
            else:
                errors += 1
        if pruned:
            data["subscriptions"] = keep
            _write_state(PUSH_NAME, data)
        result: dict[str, Any] = {
            "ok": sent > 0 and errors == 0,
            "sent": sent,
            "pruned": pruned,
            "errors": errors,
        }
        if missing_lib:
            result["error"] = "pywebpush non installé"
        elif not sent and not pruned and errors and not missing_lib:
            result["error"] = "envoi incomplet"
        return result
    finally:
        _pushing.on = False


def send_test_push() -> dict:
    if not push_enabled():
        raise ValueError("Web Push désactivé (push_enabled)")
    result = send_push("Transfert HQ", "Notification de test", category="alert")
    if result.get("error") == "pywebpush non installé":
        raise RuntimeError("pywebpush non installé — envoi impossible (opt-in)")
    if result.get("error") == "aucun abonné":
        raise ValueError("Aucun abonnement")
    if result.get("error") == "abonnements illisibles":
        raise RuntimeError("hq_push_subscriptions.json illisible — fichier conservé")
    _journal("push", f"Test push envoyé ({result.get('sent')})", level="info")
    return {
        "ok": bool(result.get("ok")),
        "sent": int(result.get("sent") or 0),
        "errors": int(result.get("errors") or 0),
        "pruned": int(result.get("pruned") or 0),
    }


def _push_critical_attention() -> None:
    if not push_enabled():
        return
    fn = _cb.get("attention_items")
    if not callable(fn):
        return
    try:
        items = fn() or []
    except Exception:
        return
    data, bad = _load_automation()
    if bad:
        return
    meta = data.setdefault("meta", {})
    seen = [str(x) for x in (meta.get("attention_pushed") or []) if x][-40:]
    seen_set = set(seen)
    fresh: list[str] = []
    for item in items:
        if not isinstance(item, dict) or item.get("level") != "critical":
            continue
        key = f"{item.get('title')}|{item.get('detail')}"[:160]
        if not key.strip("|") or key in seen_set:
            continue
        send_push(
            str(item.get("title") or "Attention")[:80],
            str(item.get("detail") or "")[:180],
            category="attention",
            url="/#wallboard",
        )
        fresh.append(key)
        seen_set.add(key)
    if not fresh:
        return
    with _automation_lock():
        data, bad = _load_automation()
        if bad:
            return
        meta = data.setdefault("meta", {})
        merged = [str(x) for x in (meta.get("attention_pushed") or []) if x]
        for key in fresh:
            if key not in merged:
                merged.append(key)
        meta["attention_pushed"] = merged[-40:]
        try:
            _save_automation(data)
        except (OSError, RuntimeError):
            pass


def tick() -> None:
    """Monitor hook: schedules, rules, telemetry, optional daily brief. No remote probe."""
    if not ready():
        return
    load = _cb.get("queue_load")
    save = _cb.get("queue_save")
    if callable(load) and callable(save):
        lock_fn = _cb.get("queue_lock")
        holder = lock_fn() if callable(lock_fn) else nullcontext()
        try:
            with holder:
                items = load()
                if isinstance(items, list):
                    result = process_schedules(items)
                    if result.get("changed"):
                        save(items)
        except Exception as e:
            _journal("schedule", f"Tick file: {e}", level="warning")
    try:
        evaluate_rules()
    except Exception as e:
        _journal("automation", f"Tick règles: {e}", level="warning")
    try:
        _push_critical_attention()
    except Exception as e:
        _journal("push", f"Attention: {e}", level="warning")
    devices_fn = _cb.get("devices")
    roster = devices_fn() if callable(devices_fn) else []
    try:
        sample_from_devices(roster or [])
    except Exception:
        pass
    if _cfg().get("daily_brief_discord") and str(_cfg().get("discord_webhook_url") or "").strip():
        try:
            # Brief content is built by the bridge (needs snapshot). Optional callback.
            builder = _cb.get("build_brief")
            if callable(builder):
                brief = builder()
                if isinstance(brief, dict):
                    maybe_send_brief(brief, force=False)
        except Exception as e:
            _journal("brief", f"Brief: {e}", level="warning")
