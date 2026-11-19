"""Print-failure watcher for the Atelier 3D (spaghetti, detached parts, a print that vanished).

While a printer is *printing*, one camera frame is sent every few minutes to the vision model with a
narrow question and the verdict is one of ``ok`` / ``suspect`` / ``failure``. A single odd verdict never
acts: it triggers a second look 45 s later, and only two non-``ok`` verdicts in a row (at least one
``failure``) raise an alarm. An alarm always notifies (chip whisper + Web Push when enabled). It
**pauses the printer only when the Master turned on ``auto_pause``** (off by default), at most once
per job, never stops it, and a Resume after an alarm is respected (no second automatic pause).

Everything is off until ``enabled`` is switched on. Frames are sent to the model and dropped, never
stored; only the verdict, a short reason and counters are kept in memory. This module never imports
``iphone_bridge`` and talks to the printer only through the callbacks it is given.
"""
from __future__ import annotations

import json
import re
import threading
import time
from typing import Any, Callable

DEFAULTS = {"enabled": False, "auto_pause": False, "interval_sec": 180}
MIN_INTERVAL, MAX_INTERVAL = 120, 900
RECHECK_SEC = 45
SETTLE_SEC = 240            # no look during the first minutes: the bed is still empty
MIN_PROGRESS, MAX_PROGRESS = 2.0, 98.0
MAX_CHECKS_PER_DAY = 300    # one shared Google quota: leave room for the chat
ERROR_BACKOFF = 600
MIN_FRAME = 2000
MAX_REASON = 160
VERDICTS = ("ok", "suspect", "failure")
# Gemma first (the Master's choice); a Gemini model answers only when both Gemma models are busy or out of quota.
CHAIN = ("gemma-4-26b-a4b-it", "gemma-4-31b-it", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite")

SYSTEM = (
    "You look at one frame from the camera of a 3D printer that is printing right now, and report whether the "
    "print has failed. Answer with JSON only: {\"verdict\": \"ok\" | \"suspect\" | \"failure\", \"reason\": \"<one short "
    "sentence in English>\"}.\n"
    "failure = filament spaghetti or a loose tangle of strands, the part detached from the plate or knocked over or "
    "lying loose, nothing on the plate where a part should be, a big blob wrapped around the nozzle.\n"
    "suspect = something looks wrong but you are not sure (a lifting corner, heavy stringing, a lump building up).\n"
    "ok = anything else, including an unfinished part, supports, a brim, a skirt, or a camera view that is too dark, "
    "blocked or blurry to judge (say so in the reason).\n"
    "The camera is low resolution: never judge surface finish, layer lines or small defects. When a second image is "
    "given it is the same printer earlier in this print, for comparison. Do not invent details."
)


def clean_settings(data: Any, current: Any = None) -> dict[str, Any]:
    """Validate the Master's settings; unknown keys dropped, booleans must be real booleans."""
    out = dict(DEFAULTS)
    for src in (current, data):
        if not isinstance(src, dict):
            continue
        for key in ("enabled", "auto_pause"):
            if key in src:
                out[key] = src[key] is True
        if "interval_sec" in src:
            try:
                out["interval_sec"] = int(src["interval_sec"])
            except (TypeError, ValueError):
                pass
    out["interval_sec"] = max(MIN_INTERVAL, min(MAX_INTERVAL, int(out["interval_sec"])))
    return out


def parse_verdict(text: Any) -> tuple[str, str]:
    """Model reply → (verdict, reason). Anything unreadable counts as ``ok`` so noise never alarms."""
    raw = str(text or "").strip()
    match = re.search(r"\{.*\}", raw, re.S)
    try:
        body = json.loads(match.group(0) if match else raw)
    except (ValueError, TypeError):
        return "ok", ""
    if not isinstance(body, dict):
        return "ok", ""
    verdict = str(body.get("verdict") or "").strip().lower()
    reason = re.sub(r"[\x00-\x1f\x7f]+", " ", str(body.get("reason") or "")).strip()[:MAX_REASON]
    return (verdict if verdict in VERDICTS else "ok"), reason


def _default_ai(system: str, frames: list[bytes]) -> tuple[str, str]:
    import base64

    import hq_ai
    parts: list[dict[str, Any]] = [{"text": "Is this print failing? The last image is the current frame."}]
    for frame in frames:
        parts.append({"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(frame).decode("ascii")}})
    return hq_ai.generate(CHAIN, system, [{"role": "user", "parts": parts}], json_out=True,
                                  temperature=0.1, background=True, max_tokens=200, attempt_timeout=40)


class Watcher:
    def __init__(self, *, frame: Callable[[str], bytes], pause: Callable[[str], Any],
                 notify: Callable[[str, str], Any],
                 ai: Callable[[str, list[bytes]], Any] | None = None,
                 clock: Callable[[], float] = time.time,
                 run: Callable[[Callable[[], None]], Any] | None = None) -> None:
        self._frame, self._pause, self._notify = frame, pause, notify
        self._ai = ai or _default_ai
        self._clock = clock
        self._run = run or (lambda fn: threading.Thread(target=fn, name="print3d-watch", daemon=True).start())
        self._lock = threading.Lock()
        self._busy = False
        self._jobs: dict[str, dict[str, Any]] = {}
        self._day = ""
        self._count = 0

    # ── bookkeeping ──
    def _today(self) -> str:
        return time.strftime("%Y-%m-%d", time.localtime(self._clock()))

    def _budget_left(self) -> bool:
        day = self._today()
        if day != self._day:
            self._day, self._count = day, 0
        return self._count < MAX_CHECKS_PER_DAY

    def checks_today(self) -> int:
        self._budget_left()
        return self._count

    def public(self, printer_id: str) -> dict[str, Any] | None:
        """What the UI / Elsea see for a printer: last verdict and the alarm, if any."""
        with self._lock:
            j = self._jobs.get(printer_id)
            if not j:
                return None
            return {"verdict": j["verdict"], "reason": j["reason"], "checked": j["checked"], "checks": j["checks"],
                    "looked": j.get("looked", 0), "next": j.get("next", 0.0),
                    "model": j.get("model", ""),
                    "alarm": dict(j["alarm"]) if j["alarm"] else None}

    def _fresh(self, start: Any) -> dict[str, Any]:
        return {"start": start, "ref": None, "next": 0.0, "looked": 0, "strikes": 0, "failure_seen": False, "verdict": "",
                "reason": "", "checked": 0, "checks": 0, "alarm": None, "auto_paused": False, "was_paused": False}

    # ── scheduling ──
    def tick(self, targets: list[dict[str, Any]], settings: dict[str, Any]) -> None:
        """Called from the bridge background loop. ``targets``: id, name, state, progress, job_start. Never raises."""
        try:
            self._tick(targets, settings)
        except Exception:
            pass

    def _tick(self, targets: list[dict[str, Any]], settings: dict[str, Any]) -> None:
        now = self._clock()
        live = {t["id"] for t in targets if t.get("state") in ("printing", "paused")}
        with self._lock:
            for pid in [p for p in self._jobs if p not in live]:
                self._jobs.pop(pid, None)
        if not settings.get("enabled"):
            return
        interval = int(settings.get("interval_sec") or DEFAULTS["interval_sec"])
        for t in targets:
            pid, state = t["id"], t.get("state")
            if state not in ("printing", "paused"):
                continue
            with self._lock:
                j = self._jobs.get(pid)
                if j is None or j["start"] != t.get("job_start"):
                    start = t.get("job_start")
                    j = self._jobs[pid] = self._fresh(start)
                    j["next"] = max(now, float(start or now) + SETTLE_SEC)   # first look after settling
                if state == "paused":
                    j["was_paused"] = True
                    continue
                if j["was_paused"]:            # resumed (by the Master, or after an auto-pause): start over
                    j["was_paused"], j["strikes"], j["failure_seen"] = False, 0, False
                    j["alarm"] = None
                    j["next"] = now + RECHECK_SEC
                    continue
                progress = t.get("progress")
                if (self._busy or now < j["next"] or not self._budget_left()
                        or now - float(t.get("job_start") or now) < SETTLE_SEC
                        or not isinstance(progress, (int, float))
                        or not MIN_PROGRESS <= progress <= MAX_PROGRESS):
                    continue
                self._busy = True
                j["next"] = now + interval
            name = str(t.get("name") or pid)
            self._run(lambda pid=pid, name=name, start=t.get("job_start"): self._check(pid, name, start, settings))
            break                                 # one look per tick, one printer at a time

    # ── one look ──
    def _check(self, pid: str, name: str, start: Any, settings: dict[str, Any]) -> None:
        try:
            frame = self._frame(pid)
            if not isinstance(frame, (bytes, bytearray)) or len(frame) < MIN_FRAME:
                return
            frame = bytes(frame)
            with self._lock:
                j = self._jobs.get(pid)
                if j is None or j["start"] != start:
                    return
                ref = j["ref"]
                j["looked"] = int(self._clock())
                self._count += 1
            try:
                text = self._ai(SYSTEM, [ref, frame] if ref else [frame])
            except Exception:
                with self._lock:
                    if pid in self._jobs:
                        self._jobs[pid]["next"] = self._clock() + ERROR_BACKOFF
                return
            model = ""
            if isinstance(text, tuple):
                text, model = text[0], str(text[1] or "")[:60]
            self._apply(pid, name, start, frame, *parse_verdict(text), settings, model=model)
        finally:
            with self._lock:
                self._busy = False

    def _apply(self, pid: str, name: str, start: Any, frame: bytes, verdict: str, reason: str,
               settings: dict[str, Any], model: str = "") -> None:
        alarm = None
        with self._lock:
            j = self._jobs.get(pid)
            if j is None or j["start"] != start:
                return
            j["verdict"], j["reason"], j["checked"] = verdict, reason, int(self._clock())
            j["model"] = model
            j["checks"] += 1
            if verdict == "ok":
                if j["ref"] is None:
                    j["ref"] = frame             # first clean look = the comparison picture
                j["strikes"], j["failure_seen"] = 0, False
                return
            j["strikes"] += 1
            j["failure_seen"] = j["failure_seen"] or verdict == "failure"
            if j["strikes"] < 2:
                j["next"] = self._clock() + RECHECK_SEC          # second look soon
                return
            level = "failure" if j["failure_seen"] else "suspect"
            if j["alarm"] and (j["alarm"]["level"] == level or level == "suspect"):
                return                                           # already told him
            alarm = j["alarm"] = {"level": level, "reason": reason or "Something looks wrong on the plate.",
                                  "at": int(self._clock()), "paused": False}
            do_pause = level == "failure" and settings.get("auto_pause") is True and not j["auto_paused"]
            if do_pause:
                j["auto_paused"] = True
        paused = False
        if do_pause:
            try:
                self._pause(pid)
                paused = True
            except Exception:
                paused = False
        with self._lock:
            j = self._jobs.get(pid)
            if j and j["alarm"] is alarm:
                alarm["paused"] = paused
        title = f"{name}: print failing?" if level == "failure" else f"{name}: check the print"
        body = alarm["reason"] + (" Paused automatically." if paused else
                                  (" Auto-pause could not reach the printer." if do_pause else ""))
        try:
            self._notify(title, body)
        except Exception:
            pass
