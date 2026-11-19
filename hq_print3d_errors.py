"""Plain-language printer errors for the Atelier 3D.

Bambu printers send numeric codes: ``hms`` entries (``attr`` + ``code``, 16 hex digits together)
and a ``print_error`` (8 hex digits). Bambu publishes the matching English descriptions as one
JSON file (``https://e.bambulab.com/query.php?lang=en``, ~330 KB, ~2 500 entries). HQ downloads
it **only when a printer actually reports a problem and no fresh copy is cached**, then at
most once a month, keeps just ``ecode -> text`` in ``.hq-print3d/bambu_errors.json``, and never
sends anything but the request itself.

A code the catalog does not know (or no catalog yet) still shows its code, grouped the way
Bambu's own wiki writes it (``0500-0200-0003-0012``), so it can be looked up by hand.
The Flashforge API only gives an opaque error code, so those get a generic message that points
to the printer's screen.
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

import hq_state

HOST = "e.bambulab.com"
URL = f"https://{HOST}/query.php?lang=en"
MAX_BODY = 4 * 1024 * 1024
TIMEOUT = 20
MAX_AGE = 30 * 86400
RETRY_AFTER = 3600
MAX_TEXT = 400
MAX_PROBLEMS = 8
SEVERITY = {1: "fatal", 2: "serious", 3: "common", 4: "info"}
_HEX16 = re.compile(r"^[0-9A-F]{16}$")
_HEX8 = re.compile(r"^[0-9A-F]{8}$")
_CTRL = re.compile(r"[\x00-\x1f\x7f]+")

Opener = Callable[[urllib.request.Request, float], Any]


class _SameHost(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        parts = urllib.parse.urlsplit(newurl)
        if parts.scheme != "https" or parts.hostname != HOST:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_SameHost)


def _default_open(req: urllib.request.Request, timeout: float) -> Any:
    return _OPENER.open(req, timeout=timeout)


def clean_text(text: Any) -> str:
    return _CTRL.sub(" ", str(text or "")).strip()[:MAX_TEXT]


def ecode_from_hms(entry: Any) -> str:
    """``{"attr": 83887616, "code": 196627}`` → ``"0500020000030013"`` (or "")."""
    if not isinstance(entry, dict):
        return ""
    try:
        attr, code = int(entry.get("attr")), int(entry.get("code"))
    except (TypeError, ValueError):
        return ""
    if not (0 <= attr <= 0xFFFFFFFF and 0 <= code <= 0xFFFFFFFF):
        return ""
    return f"{attr:08X}{code:08X}"


def display_code(ecode: str) -> str:
    """``0500020000030013`` → ``0500-0200-0003-0013``; ``07004001`` → ``0700-4001``."""
    return "-".join(ecode[i:i + 4] for i in range(0, len(ecode), 4))


def severity_of(ecode: str) -> str:
    """HMS severity lives in the top half of ``code``: 1 fatal, 2 serious, 3 common, 4 info."""
    if _HEX16.fullmatch(ecode):
        return SEVERITY.get(int(ecode[8:12], 16), "common")
    return "serious"                        # a print_error stops the job


class Catalog:
    def __init__(self, path: Path, opener: Opener | None = None) -> None:
        self._path = Path(path)
        self._opener = opener or _default_open
        self._lock = threading.Lock()
        self._data: dict[str, Any] | None = None
        self._loaded = False
        self._busy = False
        self._last_try = 0.0

    # ── cache ──
    def _load(self) -> dict[str, Any]:
        if self._loaded:
            return self._data or {}
        self._loaded = True
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("hms"), dict) and isinstance(data.get("error"), dict):
                self._data = data
        except (OSError, ValueError):
            self._data = None
        return self._data or {}

    def known(self) -> bool:
        return bool(self._load())

    def needs_refresh(self, now: float | None = None) -> bool:
        data = self._load()
        now = time.time() if now is None else now
        return not data or now - float(data.get("fetched") or 0) > MAX_AGE

    def lookup(self, ecode: str) -> str:
        data = self._load()
        if _HEX16.fullmatch(ecode):
            return str((data.get("hms") or {}).get(ecode) or "")
        if _HEX8.fullmatch(ecode):
            return str((data.get("error") or {}).get(ecode) or "")
        return ""

    # ── download ──
    @staticmethod
    def parse(raw: bytes) -> dict[str, Any]:
        try:
            body = json.loads(raw.decode("utf-8", "replace"))
            data = body["data"]
            hms, err = data["device_hms"]["en"], data["device_error"]["en"]
        except (ValueError, KeyError, TypeError):
            raise ValueError("catalogue illisible") from None
        if not isinstance(hms, list) or not isinstance(err, list):
            raise ValueError("catalogue illisible")

        def table(rows: list[Any], pattern: re.Pattern[str]) -> dict[str, str]:
            out: dict[str, str] = {}
            for row in rows:
                if not isinstance(row, dict):
                    continue
                code = str(row.get("ecode") or "").upper()
                text = clean_text(row.get("intro"))
                if pattern.fullmatch(code) and text:
                    out[code] = text
            return out

        parsed = {"hms": table(hms, _HEX16), "error": table(err, _HEX8)}
        if len(parsed["hms"]) < 50 or len(parsed["error"]) < 20:     # a truncated or wrong file
            raise ValueError("catalogue incomplet")
        return parsed

    def refresh(self) -> bool:
        """Download and cache the catalog. Never raises; returns whether a new copy was stored."""
        self._last_try = time.time()
        try:
            req = urllib.request.Request(URL, headers={"Accept": "application/json", "User-Agent": "Transfert-HQ"})
            resp = self._opener(req, TIMEOUT)
            raw = resp.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                return False
            parsed = self.parse(raw)
            parsed["fetched"] = int(time.time())
            self._path.parent.mkdir(parents=True, exist_ok=True)
            hq_state.write_json_atomic(self._path, parsed, compact=True)
        except (urllib.error.URLError, OSError, ValueError, RuntimeError, TimeoutError):
            return False
        with self._lock:
            self._data, self._loaded = parsed, True
        return True

    def ensure_async(self, now: float | None = None) -> bool:
        """Start a background download when one is due (once per hour at most)."""
        now = time.time() if now is None else now
        with self._lock:
            if self._busy or now - self._last_try < RETRY_AFTER or not self.needs_refresh(now):
                return False
            self._busy = True

        def run() -> None:
            try:
                self.refresh()
            finally:
                with self._lock:
                    self._busy = False
        threading.Thread(target=run, name="print3d-hms", daemon=True).start()
        return True

    # ── problems ──
    def explain(self, ecodes: list[str], *, kind: str = "bambu") -> list[dict[str, Any]]:
        out, seen = [], set()
        for ecode in ecodes:
            if ecode in seen or len(out) >= MAX_PROBLEMS:
                continue
            seen.add(ecode)
            text = self.lookup(ecode)
            out.append({"code": display_code(ecode), "text": text or (
                "Bambu reports this code but its description is not in the catalog yet — look the code up on "
                "Bambu's wiki or check the printer's screen."),
                "severity": severity_of(ecode), "known": bool(text)})
        return out


def flashforge_problem(code: Any) -> list[dict[str, Any]]:
    text = clean_text(code)
    if not text or text in ("0", "None"):
        return []
    return [{"code": text[:24], "known": False, "severity": "serious",
             "text": f"The printer reports error code {text[:24]}. Flashforge does not publish a code list over the network: "
                     "check the printer's screen, it explains the fault."}]
