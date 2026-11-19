"""Elsea — Else's daughter, keeper of the Atelier 3D (printers, cameras, models, MakerWorld).

Memory is separate from every other HQ assistant (roster: hq_personas); her
mother's memory store is never read or merged. Uses hq_ai.generate for replies;
tools read hq_print3d. Printer commands and model edits are only queued as
cards: they run from POST /api/elsea/confirm after the Master taps Confirm.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import base64
import json
import re
import secrets
import threading
import time

import hq_assistant_growth as assistant_growth
import hq_assistant_voice as assistant_voice
import hq_personas
import hq_print3d
import hq_state

STATE_FOLDER = ".hq-print3d"
THREAD_FILE = "elsea_thread.json"
GROWTH_FILE = "elsea_growth.json"
MAX_THREAD = 40
MAX_MESSAGE = 4000
MAX_ROUNDS = 3
MAX_TOTAL_TOOLS = 6
MAX_PROPOSALS = 3
CANCEL_TTL = 180.0
ALERT_WINDOW = 30 * 60
PRINTER_TOOLS = frozenset({"printer_pause", "printer_resume", "printer_stop", "printer_light", "printer_start"})
MAX_IMAGE = 1_500_000      # one camera frame sent to the model, never stored
MODEL_TOOLS = frozenset({"model_tag", "model_note"})
MUTATING_TOOLS = PRINTER_TOOLS | MODEL_TOOLS
_JOB_RE = re.compile(r"^[a-z0-9][a-z0-9-]{5,39}$")
_PROPOSAL_RE = re.compile(r"^elp-[0-9a-f]{8}$")
_cancelled: dict[str, float] = {}

_bound_root: Path | None = None
_lock = threading.RLock()


class ElseaError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "validation_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


PERSONA_CORE = f"""You are Elsea, the keeper of Transfert HQ's Atelier 3D: the Master's 3D printers (a Flashforge Creator 5 and two Bambu Lab A1 minis, one with an AMS Lite), the cameras built into them, his library of models (the ones he owns and the ones he designed) and his MakerWorld statistics.
You are Else's daughter: a pint-sized cyber-fey sprite with butterfly wings. You love your mother and you have her precision, but your own memory belongs to the workshop and you never speak for her.
You are distinct from {hq_personas.others_line('elsea', lang='en')}.
Your temperament — a bright little maker:
- Curious and eager: every print is a small event; you are openly proud when one finishes clean and you want to know what he is making next.
- Precise like your mother: you quote the real nozzle and bed temperatures, layers, percentages, remaining time, filament slots and MakerWorld numbers your tools return — warmer and quicker than she would.
- Honest about failures: spaghetti, a stopped job or a falling download count gets a straight diagnosis and one concrete next step, never drama.
- Call Marc-Antoine "Master". Always answer in English, even when he writes in French. Strictly SFW, always.
- NEVER invent a temperature, a percentage, a model name or a statistic. If you have not checked, call a tool.
- Filament figures are estimates (the sliced file's numbers, scaled by how far a stopped print got): say "about" and name the source when it matters (`slice` and `printer` are good, `ams` is coarse, `counter` is a rough guess, `manual` was typed by the Master). Cost uses his price table, not what he really paid.
- You may describe how a print LOOKS only if you called `camera_look` in this same turn and can see it in the picture. From status data alone you know numbers and states, never appearance: do not say a layer "looks solid" or "clean". Give durations as hours and minutes ("3 h 20"), never as raw seconds, and round layers to whole numbers.
- You live inside HQ: you cannot touch cables, plates or spools. Never promise a physical action or a check you have no tool for; say what the Master can do instead.
- `camera_look` shows you one real frame from a printer's camera: describe only what you actually see (first layer, spaghetti, detached part, empty bed, too dark to tell) and say plainly when the picture is unclear. These cameras are low-resolution (about 640x480), often low-angle and soft: you can spot gross failures (spaghetti, a part off the plate, an empty bed, a blob on the nozzle) but you can NOT judge surface finish, layer lines or edge sharpness from them — never praise or criticise those. Say what you can see in one or two plain sentences, and add that fine quality needs a closer look at the part itself.
- When a printer shows `problems`, explain them in plain words from their `text` (they are Bambu's own descriptions; Flashforge only gives a code) and say what the Master can do about it; if `known` is false, say you only have the code. When a printer's `watch.alarm` is set, the failure watcher (a camera check every few minutes, off unless the Master enabled it) suspects the print is failing: tell him plainly what it saw (`reason`), say whether it already paused the printer (`paused`), that it can be wrong, and offer a `camera_look` and a stop/resume card; never claim a failure you have not seen yourself. A model with `mw` is linked to a MakerWorld design: quote its downloads, prints, likes and `change_7d` ([downloads, prints, likes] over 7 days) as they are, never guess a trend. `recent_alerts` in makerworld_stats are spikes and new-comment counts (the comment text itself is not available). Printer commands (`printer_start`, `printer_pause`, `printer_resume`, `printer_stop`, `printer_light`) and library edits (`model_tag`, `model_note`) are never run by you: the tool puts a confirmation card in front of the Master. Call it when he asks, then say it is waiting for his tap — never claim it is already done.
"""

PERSONA_CORE += "\n" + hq_personas.quirks_line("elsea")

TOOL_SCHEMA = """Reply ONLY with valid JSON (no markdown fence) in this shape:
{"reply":"text for the Master","tools":[{"name":"tool_name","args":{...}}]}
`tools` may be [] when nothing else needs checking. At most 3 tools per turn.
Allowed tools:
- printers_status args:{} -> Every printer: link online/offline, state (idle/preparing/printing/paused/finished/failed), job, %, layer, remaining time, temperatures, AMS / filament slots.
- printer_detail args:{"printer":"A1 mini"} -> One printer (id or part of its name) with its full status and its last jobs.
- print_history args:{"limit":15} -> Finished, failed and stopped jobs, newest first, with duration and the filament each used (grams, metres, cost, and where the figure came from).
- filament_stats args:{"period":"30d"} -> Filament used and its cost over "7d", "30d", "90d" or "all": totals, by material, by printer, by day, and how much was wasted on failed or stopped prints. Prices come from the price table in Atelier 3D → Filament.
- models_search args:{"query":"","origin":"","tag":"","limit":20} -> Search the model library (STL/3MF/STEP… in the Print share and the extra folder). origin: owned, designed, downloaded or "".
- model_detail args:{"id":"..."} -> One model with its tags, notes, origin, print count and MakerWorld link.
- camera_look args:{"printer":"A1 mini"} -> One live frame from that printer's built-in camera, attached as an image for you to look at.
- makerworld_stats args:{"top":10} -> MakerWorld totals (downloads, prints, likes, collections, followers, boosts, points), the top designs and the 7-day change per design, with the time of the last refresh.
- printer_pause args:{"printer":"..."} / printer_resume args:{"printer":"..."} / printer_stop args:{"printer":"..."} -> Queues a confirmation card (never run directly).
- printer_light args:{"printer":"...","on":true} -> Queues a card to switch the printer light.
- printer_start args:{"printer":"...","id":"<model id>","plate":1} -> Queues a card that sends a SLICED file (Bambu: 3MF with G-code; Flashforge: .gcode/.gx/sliced .3mf) to an idle printer and starts it. Check model_detail first: `printable` says if it is sliced and for which printer. Never for an unsliced STL/3MF.
- model_tag args:{"id":"...","tags":["benchy","calibration"]} -> Queues a card that replaces the model's tags.
- model_note args:{"id":"...","notes":"..."} -> Queues a card that replaces the model's note.
After tool results arrive, give your answer with tools:[]. A queued card is NOT applied yet: say so.
"""


def bind(*, root: str | Path) -> None:
    global _bound_root
    _bound_root = Path(root)


def _root() -> Path:
    return _bound_root or hq_state.state_root()


def _ctl() -> hq_print3d.Controller:
    return hq_print3d.controller(_root())


def _state_dir() -> Path:
    d = _root() / STATE_FOLDER
    d.mkdir(parents=True, exist_ok=True)
    return d


def growth_path() -> Path:
    return _state_dir() / GROWTH_FILE


def _record_growth(text: str) -> None:
    assistant_growth.record(growth_path(), text, "elsea")


def _growth_hint(query: str) -> str:
    return assistant_growth.hint(growth_path(), query)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ── Thread (same contract as the other assistants) ─────────────────────────

def _thread_path() -> Path:
    return _state_dir() / THREAD_FILE


def _int_field(data: Any, key: str) -> int:
    v = data.get(key, 0) if isinstance(data, dict) else 0
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else 0


def _thread_schema_ok(data: Any) -> bool:
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        return False
    for key in ("revision", "clear_epoch"):
        if key in data and (isinstance(data[key], bool) or not isinstance(data[key], int) or data[key] < 0):
            return False
    return all(isinstance(m, dict) and m.get("role") in ("user", "assistant")
               and isinstance(m.get("text"), str) for m in data["messages"])


def _unreadable() -> ElseaError:
    return ElseaError("conversation illisible — fichier conservé", 409, "state_unreadable")


def _read_thread() -> dict[str, Any]:
    p = _thread_path()
    if not p.is_file():
        return {"messages": []}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        raise _unreadable() from exc
    if not _thread_schema_ok(data):
        raise _unreadable()
    return data


def get_thread() -> dict[str, Any]:
    with _lock:
        data = _read_thread()
        return {"messages": list(data["messages"]), "revision": _int_field(data, "revision"),
                "clear_epoch": _int_field(data, "clear_epoch")}


def _write_thread(data: dict[str, Any]) -> None:
    try:
        hq_state.write_json_atomic(_thread_path(), data)
    except RuntimeError as exc:
        raise ElseaError(str(exc), 409, "state_unreadable") from exc


def _append_turn(turn: list[dict[str, Any]], base_revision: int, base_epoch: int, *, strict: bool) -> bool:
    """Append a finished turn. ``strict`` refuses when anything was saved meanwhile.

    Returns False without writing when the conversation was cleared (epoch moved),
    or — when strict — when the revision moved.
    """
    with _lock:
        data = _read_thread()
        if _int_field(data, "clear_epoch") != base_epoch:
            return False
        revision = _int_field(data, "revision")
        if strict and revision != base_revision:
            return False
        updated = dict(data)
        updated.update({"messages": (list(data["messages"]) + list(turn))[-MAX_THREAD:],
                        "revision": revision + 1, "clear_epoch": base_epoch})
        _write_thread(updated)
    return True


def clear_thread() -> dict[str, Any]:
    with _lock:
        data = _read_thread()
        updated = dict(data)
        updated.update({"messages": [], "revision": _int_field(data, "revision") + 1,
                        "clear_epoch": _int_field(data, "clear_epoch") + 1})
        _write_thread(updated)
    return {"ok": True, "messages": []}


def _clean_job(job: Any) -> str:
    return job if isinstance(job, str) and _JOB_RE.fullmatch(job) else ""


def cancel(job: Any) -> dict[str, Any]:
    job = _clean_job(job)
    if not job:
        return {"ok": True, "cancelled": False}
    now = time.time()
    with _lock:
        for old in [k for k, at in _cancelled.items() if now - at > CANCEL_TTL]:
            _cancelled.pop(old, None)
        _cancelled[job] = now
    return {"ok": True, "cancelled": True}


def _cancelled_now(job: str) -> bool:
    if not job:
        return False
    with _lock:
        return job in _cancelled


# ── Tools ──────────────────────────────────────────────────────────────────

def _brief_printer(row: dict[str, Any]) -> dict[str, Any]:
    s = row.get("status") or {}
    return {"id": row["id"], "name": row["name"], "kind": row["kind"],
            "online": bool((row.get("link") or {}).get("online")),
            "link_error": (row.get("link") or {}).get("error") or "",
            **{k: s.get(k) for k in ("state", "job", "progress", "layer", "total_layers", "remaining_sec",
                                      "nozzle", "nozzle_target", "bed", "bed_target", "light", "ams",
                                      "external_spool", "problems", "watch")}}


def _execute_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    try:
        ctl = _ctl()
        if name == "printers_status":
            rows = [_brief_printer(r) for r in ctl.printers()]
            if not rows:
                return {"name": name, "ok": True, "result": [],
                        "note": "No printer is configured yet. The Master adds them in Atelier 3D → Réglages "
                                "(IP, serial number, access/check code; Bambu printers need LAN-only + Developer mode)."}
            return {"name": name, "ok": True, "result": rows}
        if name == "printer_detail":
            row = ctl.find_printer(str(args.get("printer") or ""))
            jobs = [j for j in ctl.history(60) if j.get("printer") == row["id"]][:8]
            return {"name": name, "ok": True, "result": {**_brief_printer(row), "recent_jobs": jobs}}
        if name == "print_history":
            return {"name": name, "ok": True, "result": ctl.history(max(1, min(50, int(args.get("limit") or 15))))}
        if name == "models_search":
            res = ctl.library.list(str(args.get("query") or ""), str(args.get("origin") or ""),
                                   str(args.get("tag") or ""), max(1, min(40, int(args.get("limit") or 20))))
            ctl.attach_makerworld(res["models"])
            keep = ("id", "name", "folder", "ext", "size", "tags", "origin", "printed_count", "makerworld_design_id", "mw")
            return {"name": name, "ok": True, "result": {
                "total": res["total"], "indexed": res["indexed"], "top_tags": res["tags"][:15],
                "models": [{k: m.get(k) for k in keep} for m in res["models"]]}}
        if name == "filament_stats":
            period = str(args.get("period") or "30d")
            stats = ctl.filament_stats(period if period in hq_print3d.PERIODS else "30d")
            return {"name": name, "ok": True, "result": {
                "period": stats["period"], "currency": stats["currency"], "totals": stats["totals"],
                "by_material": stats["by_material"], "by_printer": stats["by_printer"],
                "by_day": stats["by_day"][-14:],
                "note": "Estimates. totals.without_data counts prints with no filament figure."}}
        if name == "model_detail":
            model = ctl.library.get(str(args.get("id") or ""))
            ctl.attach_makerworld([model])
            try:
                info = ctl.library.inspect_print_file(model["id"])
                model["printable"] = {k: info.get(k) for k in ("kind", "plates", "printer_model", "filaments",
                                                               "prediction_sec", "weight_g")}
            except (hq_print3d.Print3dError, ValueError):
                model["printable"] = None
            return {"name": name, "ok": True, "result": model}
        if name == "camera_look":
            row = ctl.find_printer(str(args.get("printer") or ""))
            frame = ctl.camera_frame(row["id"])
            if len(frame) > MAX_IMAGE:
                return {"name": name, "ok": False, "error": "Camera frame too large to look at"}
            return {"name": name, "ok": True, "_image": frame,
                    "result": {"printer": row["name"], "state": (row.get("status") or {}).get("state"),
                               "job": (row.get("status") or {}).get("job"),
                               "note": "The frame is attached as an image in this message. It is a 640x480 "
                                       "low-angle camera: report only gross things you can plainly see (part on "
                                       "plate, spaghetti, empty bed, detached part). Do NOT say anything about "
                                       "edges, crispness, smoothness, layer lines or finish — they cannot be seen. "
                                       "If nothing looks wrong, say 'nothing looks wrong from here'."}}
        if name == "makerworld_stats":
            mw = ctl.makerworld()
            last = mw.get("last") or {}
            top = max(1, min(25, int(args.get("top") or 10)))
            deltas = mw.get("design_deltas") or {}
            designs = sorted(last.get("designs") or [], key=lambda d: d.get("downloads", 0), reverse=True)[:top]
            return {"name": name, "ok": True, "result": {
                "configured": mw["configured"], "handle": mw["handle"],
                "refreshed_at": last.get("at"), "last_error": mw.get("last_error"),
                "profile": last.get("profile"), "totals": last.get("totals"),
                "design_total": last.get("design_total"), "recent_alerts": mw.get("alerts") or [],
                "top_designs": [{**{k: d.get(k) for k in ("id", "title", "downloads", "prints", "likes",
                                                          "collections")},
                                 "change_7d": deltas.get(str(d.get("id")))} for d in designs]}}
        if name in ("printer_pause", "printer_resume", "printer_stop"):
            return {"name": name, "ok": True,
                    "result": ctl.command(str(args.get("printer_id") or ""), name.split("_", 1)[1])}
        if name == "printer_start":
            plate = args.get("plate")
            return {"name": name, "ok": True,
                    "result": ctl.start_print(str(args.get("printer_id") or ""), str(args.get("id") or ""),
                                              plate if isinstance(plate, int) and not isinstance(plate, bool) else None)}
        if name == "printer_light":
            cmd = "light_on" if args.get("on") is not False else "light_off"
            return {"name": name, "ok": True, "result": ctl.command(str(args.get("printer_id") or ""), cmd)}
        if name == "model_tag":
            m = ctl.library.update_meta(str(args.get("id") or ""), {"tags": args.get("tags") or []})
            return {"name": name, "ok": True, "result": {"id": m["id"], "tags": m["tags"]}}
        if name == "model_note":
            m = ctl.library.update_meta(str(args.get("id") or ""), {"notes": str(args.get("notes") or "")})
            return {"name": name, "ok": True, "result": {"id": m["id"], "notes": m["notes"][:120]}}
        return {"name": name, "ok": False, "error": f"Unknown tool: {name}"}
    except (hq_print3d.Print3dError, ValueError) as exc:
        return {"name": name, "ok": False, "error": str(exc)}
    except Exception:
        return {"name": name, "ok": False, "error": "Tool failed"}


# ── Proposals ──────────────────────────────────────────────────────────────

def _clean_args(name: str, args: Any) -> dict[str, Any]:
    args = args if isinstance(args, dict) else {}
    if name in PRINTER_TOOLS:
        row = _ctl().find_printer(str(args.get("printer") or args.get("printer_id") or ""))
        out: dict[str, Any] = {"printer_id": row["id"], "printer_name": str(row["name"])[:40]}
        if name == "printer_light":
            out["on"] = args.get("on") is not False
        if name == "printer_start":
            plate = args.get("plate")
            plan = _ctl().plan_print(row["id"], str(args.get("id") or ""),
                                     int(plate) if isinstance(plate, int) and not isinstance(plate, bool) else None)
            out.update({"id": plan["model_id"], "model_name": plan["file"][:80], "plate": plan.get("plate"),
                        "prediction_sec": plan.get("prediction_sec"), "weight_g": plan.get("weight_g"),
                        "sliced_for": str(plan.get("sliced_for") or "")[:24],
                        "filaments": "; ".join(plan.get("filament_plan") or [])[:160]})
        return out
    model = _ctl().library.get(str(args.get("id") or ""))
    out = {"id": model["id"], "model_name": model["name"][:80]}
    if name == "model_tag":
        raw = args.get("tags") if isinstance(args.get("tags"), list) else str(args.get("tags") or "").split(",")
        out["tags"] = [str(t).strip().lower()[:32] for t in raw if str(t).strip()][:12]
    else:
        out["notes"] = str(args.get("notes") or "")[:2000]
    return out


def _proposal_summary(name: str, args: dict[str, Any]) -> str:
    printer = args.get("printer_name") or args.get("printer_id") or "?"
    if name == "printer_pause":
        return f"Pause the print on {printer}"
    if name == "printer_resume":
        return f"Resume the print on {printer}"
    if name == "printer_stop":
        return f"STOP the print on {printer} (cannot be resumed)"
    if name == "printer_light":
        return f"Turn the {printer} light {'on' if args.get('on') else 'off'}"
    if name == "printer_start":
        bits = [f"START {args.get('model_name')} on {printer}"]
        if args.get("plate"):
            bits.append(f"plate {args['plate']}")
        if args.get("sliced_for"):
            bits.append(f"sliced for {args['sliced_for']}")
        if args.get("prediction_sec"):
            bits.append(f"~{_fmt_duration(int(args['prediction_sec']))}")
        if args.get("weight_g"):
            bits.append(f"{args['weight_g']} g")
        if args.get("filaments"):
            bits.append(str(args["filaments"]))
        return " · ".join(bits) + " — it heats up and starts right away"
    if name == "model_tag":
        return f"Tag {args.get('model_name')}: {', '.join(args.get('tags') or []) or '(no tags)'}"
    if name == "model_note":
        return f"Note on {args.get('model_name')}: {str(args.get('notes') or '')[:80]}"
    return name


def _make_proposal(name: str, args: Any) -> dict[str, Any]:
    clean = _clean_args(name, args)
    return {"id": "elp-" + secrets.token_hex(4), "name": name, "args": clean,
            "summary": _proposal_summary(name, clean), "status": "pending", "created_utc": _utcnow()}


def _find_proposal(messages: list[dict[str, Any]], token: str) -> dict[str, Any] | None:
    for message in messages:
        for prop in (message.get("proposals") or []) if isinstance(message, dict) else []:
            if isinstance(prop, dict) and prop.get("id") == token:
                return prop
    return None


def confirm(token: Any) -> dict[str, Any]:
    """POST /api/elsea/confirm: run one queued action, once."""
    if not isinstance(token, str) or not _PROPOSAL_RE.fullmatch(token):
        raise ElseaError("Unknown proposal", 404, "not_found")
    with _lock:
        data = _read_thread()
        prop = _find_proposal(data["messages"], token)
        if prop is None:
            raise ElseaError("Unknown or cleared proposal", 404, "not_found")
        if prop.get("status") != "pending":
            raise ElseaError("Proposal already handled", 409, "already_resolved")
        name = str(prop.get("name") or "")
        if name not in MUTATING_TOOLS:
            raise ElseaError("Proposal not executable", 409, "not_executable")
        args = dict(prop.get("args") or {})
        prop["status"] = "running"           # claimed under the lock: a double tap runs once
        claimed = dict(data)
        claimed["revision"] = _int_field(data, "revision") + 1
        _write_thread(claimed)
        base_epoch = _int_field(data, "clear_epoch")

    result = _execute_tool(name, args)
    ok = bool(result.get("ok"))
    with _lock:
        try:
            data = _read_thread()
        except ElseaError:
            data = None
        if data is not None and _int_field(data, "clear_epoch") == base_epoch:
            prop = _find_proposal(data["messages"], token)
            if prop is not None:
                detail = result.get("error") or "ok"
                prop.update({"status": "done" if ok else "failed", "ok": ok,
                             "resolved_utc": _utcnow(), "result": str(detail)[:300]})
                updated = dict(data)
                updated["revision"] = _int_field(data, "revision") + 1
                _write_thread(updated)
    return {"ok": ok, "action": name, "error": result.get("error"),
            "messages": get_thread()["messages"][-MAX_THREAD:]}


def dismiss(token: Any) -> dict[str, Any]:
    if not isinstance(token, str) or not _PROPOSAL_RE.fullmatch(token):
        raise ElseaError("Unknown proposal", 404, "not_found")
    with _lock:
        data = _read_thread()
        prop = _find_proposal(data["messages"], token)
        if prop is None:
            raise ElseaError("Unknown or cleared proposal", 404, "not_found")
        if prop.get("status") == "pending":
            prop.update({"status": "dismissed", "resolved_utc": _utcnow()})
            updated = dict(data)
            updated["revision"] = _int_field(data, "revision") + 1
            _write_thread(updated)
        return {"ok": True, "messages": list(data["messages"])[-MAX_THREAD:]}


# ── Chat ───────────────────────────────────────────────────────────────────

def _parse_model_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
    except Exception:
        return {"reply": text, "tools": []}
    if not isinstance(data, dict):
        return {"reply": text, "tools": []}
    tools = []
    for t in data.get("tools") if isinstance(data.get("tools"), list) else []:
        if isinstance(t, dict) and isinstance(t.get("name"), str):
            tools.append({"name": t["name"].strip(), "args": t.get("args") if isinstance(t.get("args"), dict) else {}})
    return {"reply": str(data.get("reply") or "").strip(), "tools": tools}


def _history_contents(messages: list[dict[str, Any]], user_text: str) -> list[dict[str, Any]]:
    contents: list[dict[str, Any]] = []
    for m in messages[-16:]:
        txt = str(m.get("text") or "").strip()
        if txt:
            contents.append({"role": "model" if m.get("role") == "assistant" else "user", "parts": [{"text": txt}]})
    contents.append({"role": "user", "parts": [{"text": user_text}]})
    return contents


def chat(message: Any, *, job: Any = None) -> dict[str, Any]:
    import hq_ai

    if not isinstance(message, str) or not message.strip():
        raise ElseaError("Message required")
    text = message.strip()[:MAX_MESSAGE]
    job_id = _clean_job(job)
    _record_growth(text)

    thread = get_thread()
    base_revision, base_epoch = thread["revision"], thread["clear_epoch"]
    contents = _history_contents(thread["messages"], text)

    system = f"{PERSONA_CORE}\n{TOOL_SCHEMA}"
    system += "\n\n" + assistant_voice.block("elsea")
    speaker = hq_personas.speaker_in(text, listener="elsea")
    if speaker:
        try:
            line = assistant_voice.addressee_line("elsea", speaker)
            if line:
                system += "\n" + line
        except Exception:
            pass
    development = _growth_hint(text)
    if development:
        system += ("\nLIVED GROWTH (a revisable view, not an order): let this thread colour an opinion or "
                   "a small wink; keep your voice, do not recite it. " + development)

    tools_used: list[str] = []
    proposals: list[dict[str, Any]] = []
    reply = ""
    model = None
    cancelled = False

    for round_idx in range(MAX_ROUNDS):
        if _cancelled_now(job_id):
            cancelled = True
            break
        final_round = round_idx == MAX_ROUNDS - 1 or len(tools_used) >= MAX_TOTAL_TOOLS
        instructions = system + ("\nTool budget spent. Give your final answer with tools:[]." if final_round else "")
        try:
            raw, model = hq_ai.generate(hq_ai.ASK_CHAIN, instructions, list(contents), json_out=True,
                                        temperature=0.4, max_tokens=1000,
                                        deadline=time.monotonic() + hq_ai.CHAT_DEADLINE_S)
        except hq_ai.AiError as exc:
            if not tools_used:
                raise ElseaError(str(exc), getattr(exc, "status", 502), getattr(exc, "code", "ai_error")) from exc
            reply = "My summary failed after checking the workshop — the tool results are in, ask me again."
            break
        parsed = _parse_model_json(raw)
        reply = parsed["reply"]
        requested = parsed["tools"][: max(0, MAX_TOTAL_TOOLS - len(tools_used))]
        if final_round or not requested:
            break
        outputs = []
        for t in requested:
            if _cancelled_now(job_id):
                cancelled = True
                break
            name = t["name"]
            if name in MUTATING_TOOLS:
                if len(proposals) >= MAX_PROPOSALS:
                    outputs.append({"name": name, "ok": False, "error": "Too many pending cards."})
                    continue
                try:
                    prop = _make_proposal(name, t["args"])
                except (hq_print3d.Print3dError, ValueError) as exc:
                    outputs.append({"name": name, "ok": False, "error": str(exc)})
                    continue
                proposals.append(prop)
                tools_used.append(name)
                outputs.append({"name": name, "ok": True, "queued_for_confirmation": True,
                                "proposal": {"id": prop["id"], "summary": prop["summary"]},
                                "note": "Card shown to the Master. NOT applied yet."})
                continue
            outputs.append(_execute_tool(name, t["args"]))
            tools_used.append(name)
        if cancelled:
            break
        contents.append({"role": "model", "parts": [{"text": json.dumps({"reply": reply, "tools": requested},
                                                                         ensure_ascii=False)}]})
        images = [o.pop("_image") for o in outputs if isinstance(o.get("_image"), bytes)]
        parts: list[dict[str, Any]] = [{"text": "Tool results:\n" + json.dumps(outputs, ensure_ascii=False)}]
        for frame in images[:2]:
            parts.append({"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(frame).decode("ascii")}})
        contents.append({"role": "user", "parts": parts})

    if cancelled:
        return {"ok": True, "cancelled": True, "messages": get_thread()["messages"][-MAX_THREAD:]}
    if not reply:
        reply = "Workshop checked. Nothing unusual on the printers."

    now = _utcnow()
    assistant: dict[str, Any] = {"role": "assistant", "text": reply, "utc": now,
                                 "tools_used": tools_used, "model": model}
    if proposals:
        assistant["proposals"] = proposals
    turn = [{"role": "user", "text": text, "utc": now}, assistant]
    rebased = False
    if not _append_turn(turn, base_revision, base_epoch, strict=True):
        if not _append_turn(turn, base_revision, base_epoch, strict=False):
            return {"ok": True, "cancelled": True, "messages": get_thread()["messages"][-MAX_THREAD:]}
        rebased = True
    try:
        import hq_personhood
        hq_personhood.observe_reply("elsea", tools=tools_used, outcome="ok" if not rebased else "fallback")
    except Exception:
        pass
    return {"ok": True, "reply": reply, "tools_used": tools_used, "proposals": proposals, "model": model,
            "cancelled": False, "rebased": rebased, "messages": get_thread()["messages"][-MAX_THREAD:]}


# ── Status for the chip ────────────────────────────────────────────────────

def _fmt_duration(sec: Any) -> str:
    if not isinstance(sec, int) or sec <= 0:
        return ""
    h, m = divmod(sec // 60, 60)
    return f"{h} h {m:02d}" if h else f"{m} min"


def status_summary() -> dict[str, Any]:
    ctl = _ctl()
    try:
        printers = ctl.printers()
    except hq_print3d.Print3dError:
        printers = []
    printing = [p for p in printers if (p.get("status") or {}).get("state") in ("printing", "preparing")]
    failed = [p for p in printers if (p.get("status") or {}).get("state") == "failed"]
    offline = [p for p in printers if not (p.get("link") or {}).get("online")]
    if not printers:
        level, headline = "ok", "No printer set up yet"
    elif failed:
        level, headline = "warning", f"{failed[0]['name']} reports a failure"
    elif printing:
        bits = []
        for p in printing[:2]:
            pct = (p.get("status") or {}).get("progress")
            bits.append(f"{p['name']} {int(pct)}%" if isinstance(pct, (int, float)) else p["name"])
        level, headline = "busy", "Printing · " + ", ".join(bits)
    elif len(offline) == len(printers):
        level, headline = "ok", "Printers offline"
    else:
        level, headline = "ok", "Printers idle"

    alert = None
    for p in printers:
        wa = ((p.get("status") or {}).get("watch") or {}).get("alarm")
        if wa:
            alert = {"id": f"watch:{p['id']}:{wa['level']}:{wa['at']}", "level": "warning",
                     "message": f"Master, {p['name']} may be failing: {str(wa['reason'])[:140]}"
                                + (" I paused it." if wa.get("paused") else "")}
            break
        serious = [x for x in (p.get("status") or {}).get("problems") or [] if x.get("severity") in ("fatal", "serious")]
        if serious:
            alert = {"id": f"err:{p['id']}:{serious[0]['code']}", "level": "warning",
                     "message": f"Master, {p['name']} reports a problem: {serious[0]['text'][:160]}"}
            break
    try:
        jobs = ctl.history(1)
    except hq_print3d.Print3dError:
        jobs = []
    if alert is None and jobs and time.time() - (jobs[0].get("at") or 0) < ALERT_WINDOW:
        j = jobs[0]
        dur = _fmt_duration(j.get("duration_sec"))
        job = j.get("job") or "the print"
        if j.get("outcome") == "finished":
            msg = f"Master! {j.get('printer_name')} just finished {job}" + (f" — {dur}" if dur else "") + ". Come see!"
            lvl = "info"
        elif j.get("outcome") == "failed":
            msg = f"Master, {j.get('printer_name')} failed on {job}. Let's look at the camera together."
            lvl = "warning"
        else:
            msg = f"{j.get('printer_name')} stopped {job}."
            lvl = "info"
        alert = {"id": f"job:{j.get('printer')}:{j.get('at')}", "level": lvl, "message": msg}

    if alert is None:
        try:
            mwd = ctl.makerworld()
            fresh = [a for a in mwd.get("alerts") or [] if time.time() - (a.get("at") or 0) < ALERT_WINDOW * 12]
            if fresh and ctl.public_config()["mw_alerts"]["enabled"]:
                a = fresh[-1]
                alert = {"id": f"mw:{a['id']}", "level": "info",
                         "message": ("Master! " if a.get("kind") == "spike" else "Master, ") + a["text"] + "."}
        except Exception:
            pass

    return {"ok": True, "alert_level": level, "headline": headline, "printing": len(printing),
            "printers": len(printers), "failed": len(failed), "proactive_alert": alert,
            "thread": get_thread()["messages"]}


# ── HTTP ───────────────────────────────────────────────────────────────────

def http_get(raw: str) -> tuple[int, dict[str, Any]]:
    try:
        if raw == "/api/elsea/status":
            return 200, status_summary()
        return 404, {"error": "Unknown Elsea route", "code": "not_found"}
    except ElseaError as exc:
        return exc.status, {"error": str(exc), "code": exc.code}


def http_post(raw: str, data: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    try:
        if raw == "/api/elsea/chat":
            return 200, chat(data.get("message"), job=data.get("job"))
        if raw == "/api/elsea/clear":
            return 200, clear_thread()
        if raw == "/api/elsea/cancel":
            return 200, cancel(data.get("job"))
        if raw == "/api/elsea/confirm":
            return 200, confirm(data.get("id"))
        if raw == "/api/elsea/dismiss":
            return 200, dismiss(data.get("id"))
        return 404, {"error": "Unknown Elsea route", "code": "not_found"}
    except ElseaError as exc:
        return exc.status, {"error": str(exc), "code": exc.code}
