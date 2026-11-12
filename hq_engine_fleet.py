"""Engine fleet: other computers report their daemons and resource use to HQ.

Same trust model as the Forge workers (hq_forge_fleet): HQ never dials out, the browser never supplies a host, and every
request from a remote PC is signed (HMAC-SHA256 over method, path, timestamp, nonce and body hash, the wire format of
``hq_forge_worker``). A PC is enrolled with a one-time code that an admin creates in the Engine tab; HQ keeps only the code's
hash, and keeps the PC's secret wrapped with Windows DPAPI (no plaintext fallback).

* ``POST /engine-agent/v1/enroll``  one-time code -> machine id + secret (rate limited per IP and globally)
* ``POST /engine-agent/v1/report``  signed status report (system totals + the PC's daemons), every ~10 s

A report is *data*, never instructions: it is validated field by field, clipped, bounded and only ever displayed
(the UI uses textContent). Nothing in a report starts or stops anything on HQ or on any PC.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import tempfile
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Optional

import hq_forge_worker as wire

PREFIX = "/engine-agent/v1"
MACHINE_RE = re.compile(r"^pc_[0-9a-f]{16}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_TTL_SEC = 600
SKEW_SEC = 90
NONCE_TTL_SEC = 180
ONLINE_SEC = 35                 # agents report every ~10 s
REPORT_SEC = 10
MAX_MACHINES = 16
MAX_CODES = 4
MAX_DAEMONS = 24
REPORT_MAX = 64 * 1024
ENROLL_MAX = 8 * 1024
ENROLL_WINDOW_SEC = 600
ENROLL_MAX_PER_IP = 10
ENROLL_MAX_GLOBAL = 30
HIST_MAX = 60
SAVE_SEEN_EVERY = 60.0
STATES = ("ready", "loading", "down", "foreign", "error", "idle", "busy", "warn")
KINDS = ("core", "voice", "music", "apps", "image", "service")
TEST_PLAIN_ENV = "HQ_ENGINE_FLEET_TEST_PLAINTEXT"

_LOCK = threading.RLock()
_root: Optional[Path] = None
_clock = time.time
_registry: dict[str, Any] = {"machines": [], "codes": []}
_live: dict[str, dict] = {}
_nonces: dict[str, dict[str, float]] = {}
_enroll_hits: dict[str, list[float]] = {}
_wrap_enabled = True
_dummy = secrets.token_hex(16)


# ---- storage -----------------------------------------------------------------------------------------------------

def _dir() -> Path:
    if _root is None:
        raise RuntimeError("engine fleet not bound")
    folder = _root / ".hq-engine"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _write_atomic(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + ".partial")
    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    if _wrap_enabled:
        wire.protect_path(tmp)
    os.replace(tmp, path)


def _save() -> None:
    _write_atomic(_dir() / "machines.json", _registry)


def bind(root: Path | str) -> None:
    """Idempotent: the bridge calls it on every agent request."""
    global _root
    root = Path(root)
    if _root is not None and Path(_root) == root:
        return
    with _LOCK:
        _root = root
        _registry.update(machines=[], codes=[])
        _live.clear()
        try:
            data = json.loads((_dir() / "machines.json").read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeError):
            data = {}
        if isinstance(data, dict):
            for m in data.get("machines", [])[:MAX_MACHINES]:
                if isinstance(m, dict) and MACHINE_RE.fullmatch(str(m.get("id", ""))) and isinstance(m.get("secret"), dict):
                    _registry["machines"].append({k: m.get(k) for k in ("id", "name", "secret", "created", "seen")})
            _registry["codes"] = [c for c in data.get("codes", []) if isinstance(c, dict)][-MAX_CODES:]


def reset_for_tests(root: Path | str, *, clock=None, wrap: bool = False) -> None:
    global _root, _clock, _wrap_enabled
    with _LOCK:
        _root = None
        _clock = clock or time.time
        _wrap_enabled = wrap
        _registry.update(machines=[], codes=[])
        _live.clear()
        _nonces.clear()
        _enroll_hits.clear()
    bind(root)


# ---- secrets (DPAPI, no plaintext fallback outside tests) --------------------------------------------------------

def _test_plain_allowed() -> bool:
    if _wrap_enabled or os.environ.get(TEST_PLAIN_ENV) != "1" or _root is None:
        return False
    try:
        temp = Path(tempfile.gettempdir()).resolve()
        root = Path(_root).resolve()
    except OSError:
        return False
    return root != temp and temp in root.parents


def _wrap(secret: str) -> Optional[dict]:
    if _test_plain_allowed():
        return {"kind": "test-plain", "value": secret}
    if os.name != "nt":
        return None
    import hq_forge_fleet
    sealed = hq_forge_fleet._dpapi(secret.encode("ascii"), True)
    return {"kind": "dpapi", "value": base64.b64encode(sealed).decode("ascii")} if sealed else None


def _unwrap(row: dict) -> str:
    stored = row.get("secret")
    if not isinstance(stored, dict):
        return ""
    if stored.get("kind") == "test-plain":
        return str(stored.get("value") or "") if _test_plain_allowed() else ""
    if stored.get("kind") == "dpapi" and os.name == "nt":
        try:
            import hq_forge_fleet
            opened = hq_forge_fleet._dpapi(base64.b64decode(str(stored.get("value") or "")), False)
        except Exception:
            return ""
        return opened.decode("ascii", "replace") if opened else ""
    return ""


def _code_hash(code: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9]", "", code or "").upper()
    return hashlib.sha256(("hq-engine-code|" + clean).encode("utf-8")).hexdigest()


def _same(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


# ---- enrollment ---------------------------------------------------------------------------------------------------

def _clean_name(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    name = re.sub(r"[\x00-\x1f\x7f]", " ", value).strip()[:40]
    return name or None


def create_code() -> dict:
    """One-time pairing code, shown once. Only its hash is stored."""
    now = _clock()
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(12))
    pretty = "-".join(code[i:i + 4] for i in range(0, 12, 4))
    with _LOCK:
        _registry["codes"] = [c for c in _registry["codes"] if float(c.get("expires") or 0) > now][-(MAX_CODES - 1):]
        _registry["codes"].append({"hash": _code_hash(code), "expires": now + CODE_TTL_SEC})
        _save()
    return {"ok": True, "code": pretty, "ttl_sec": CODE_TTL_SEC, "expires_at": now + CODE_TTL_SEC}


def _rate_ok(ip: str) -> bool:
    now = _clock()
    hits = [t for t in _enroll_hits.get(ip, []) if now - t < ENROLL_WINDOW_SEC]
    total = sum(1 for bucket in _enroll_hits.values() for t in bucket if now - t < ENROLL_WINDOW_SEC)
    if len(hits) >= ENROLL_MAX_PER_IP or total >= ENROLL_MAX_GLOBAL:
        _enroll_hits[ip] = hits
        return False
    hits.append(now)
    _enroll_hits[ip] = hits
    return True


def enroll(body: dict, ip: str) -> tuple[int, dict]:
    with _LOCK:
        if not _rate_ok(ip or "?"):
            return 429, {"error": "Trop d'essais. Réessaie plus tard.", "code": "rate"}
        now = _clock()
        digest = _code_hash(str(body.get("code") or ""))
        match = next((c for c in _registry["codes"] if _same(str(c.get("hash") or ""), digest) and float(c.get("expires") or 0) > now), None)
        if match is None:
            return 403, {"error": "Code invalide ou expiré.", "code": "code_invalid"}
        if len(_registry["machines"]) >= MAX_MACHINES:
            return 409, {"error": "Trop d'ordinateurs appairés.", "code": "full"}
        machine_id = "pc_" + secrets.token_hex(8)
        secret = secrets.token_hex(32)
        sealed = _wrap(secret)
        if sealed is None:                       # nothing changes: the code is NOT consumed, no machine is created
            return 503, {"error": "Impossible de protéger le secret sur HQ (DPAPI).", "code": "secret_protect"}
        _registry["codes"] = [c for c in _registry["codes"] if c is not match and float(c.get("expires") or 0) > now]
        _registry["machines"].append({"id": machine_id, "name": _clean_name(body.get("name")) or "Ordinateur",
                                      "secret": sealed, "created": now, "seen": None})
        _save()
    return 200, {"machine_id": machine_id, "secret": secret, "report_sec": REPORT_SEC}


def _machine(machine_id: str) -> Optional[dict]:
    return next((m for m in _registry["machines"] if m["id"] == machine_id), None)


def rename(machine_id: str, name: Any) -> tuple[int, dict]:
    clean = _clean_name(name)
    with _LOCK:
        row = _machine(machine_id) if MACHINE_RE.fullmatch(machine_id or "") else None
        if row is None:
            return 404, {"error": "Ordinateur inconnu.", "code": "not_found"}
        if clean is None:
            return 400, {"error": "Nom invalide.", "code": "validation_error"}
        row["name"] = clean
        _save()
    return 200, {"ok": True}


def remove(machine_id: str) -> tuple[int, dict]:
    with _LOCK:
        row = _machine(machine_id) if MACHINE_RE.fullmatch(machine_id or "") else None
        if row is None:
            return 404, {"error": "Ordinateur inconnu.", "code": "not_found"}
        _registry["machines"].remove(row)
        _live.pop(machine_id, None)
        _nonces.pop(machine_id, None)
        _save()
    return 200, {"ok": True}


# ---- request authentication ---------------------------------------------------------------------------------------

def _header(headers, name: str) -> str:
    try:
        value = headers.get(name)
    except Exception:
        value = None
    return str(value or "").strip()[:200]


def _remember_nonce(machine_id: str, nonce: str, now: float) -> bool:
    bucket = _nonces.setdefault(machine_id, {})
    for key in [k for k, seen in bucket.items() if now - seen > NONCE_TTL_SEC]:
        bucket.pop(key, None)
    if nonce in bucket:
        return False
    if len(bucket) > 512:
        for key, _seen in sorted(bucket.items(), key=lambda kv: kv[1])[:128]:
            bucket.pop(key, None)
    bucket[nonce] = now
    return True


def authenticate(method: str, path: str, headers, body: bytes) -> Optional[dict]:
    machine_id = _header(headers, wire.HEADER_WORKER)
    stamp_raw = _header(headers, wire.HEADER_TIME)
    nonce = _header(headers, wire.HEADER_NONCE)
    presented = _header(headers, wire.HEADER_SIGNATURE).lower()
    stamp = int(stamp_raw) if stamp_raw.isdigit() and len(stamp_raw) < 12 else None
    now = _clock()
    with _LOCK:
        row = _machine(machine_id) if MACHINE_RE.fullmatch(machine_id) else None
        secret = _unwrap(row) if row else ""
        expected = wire.sign(secret or _dummy, method, path, stamp or 0, nonce, body or b"")
        ok = _same(presented, expected) and len(presented) == 64
        if not row or not secret or not ok or stamp is None:
            return None
        if abs(now - stamp) > SKEW_SEC or not NONCE_RE.fullmatch(nonce):
            return None
        if not _remember_nonce(machine_id, nonce, now):
            return None
        return row


# ---- report validation --------------------------------------------------------------------------------------------

def _clip(v: Any, n: int) -> Optional[str]:
    if not isinstance(v, str):
        return None
    t = re.sub(r"[\x00-\x1f\x7f]", " ", v).strip()[:n]
    return t or None


def _num(v: Any, lo: float, hi: float, digits: Optional[int] = 0) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        return None
    return round(v, digits) if digits else int(round(v))


def _clean_system(raw: Any) -> dict:
    out: dict[str, Any] = {}
    if not isinstance(raw, dict):
        return out
    for key, hi, dg in (("cpu_pct", 100, 1), ("cpu_count", 4096, 0), ("ram_total_mb", 1 << 26, 0), ("ram_used_mb", 1 << 26, 0),
                        ("disk_free_gb", 1 << 20, 0), ("disk_total_gb", 1 << 20, 0)):
        n = _num(raw.get(key), 0, hi, dg)
        if n is not None:
            out[key] = n
    gpus = []
    for g in (raw.get("gpus") if isinstance(raw.get("gpus"), list) else [])[:16]:
        if len(gpus) >= 4:
            break
        if not isinstance(g, dict) or not _clip(g.get("name"), 60):
            continue
        row = {"name": _clip(g.get("name"), 60)}
        for key, hi in (("util_pct", 100), ("vram_used_mb", 1 << 20), ("vram_total_mb", 1 << 20), ("temp_c", 150)):
            n = _num(g.get(key), 0, hi)
            if n is not None:
                row[key] = n
        gpus.append(row)
    if gpus:
        out["gpus"] = gpus
    return out


def _clean_daemons(raw: Any) -> list[dict]:
    out = []
    for d in (raw if isinstance(raw, list) else [])[:MAX_DAEMONS * 3]:      # bounded scan, then capped
        if len(out) >= MAX_DAEMONS:
            break
        if not isinstance(d, dict) or not ID_RE.fullmatch(str(d.get("id") or "")):
            continue
        row: dict[str, Any] = {"id": d["id"], "label": _clip(d.get("label"), 60) or d["id"],
                               "kind": d.get("kind") if d.get("kind") in KINDS else "service",
                               "state": d.get("state") if d.get("state") in STATES else "error"}
        for key, hi, dg in (("port", 65535, 0), ("pid", 1 << 24, 0), ("rss_mb", 1 << 26, 0), ("vram_mb", 1 << 20, 0),
                            ("cpu_pct", 100, 1), ("uptime_s", 10 ** 9, 0)):
            n = _num(d.get(key), 0, hi, dg)
            if n is not None:
                row[key] = n
        note = _clip(d.get("note"), 160)
        if note:
            row["note"] = note
        out.append(row)
    return out


def _clean_report(raw: Any) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    return {"host": _clip(raw.get("host"), 40), "os": _clip(raw.get("os"), 60),
            "version": _num(raw.get("version"), 0, 1000), "system": _clean_system(raw.get("system")),
            "daemons": _clean_daemons(raw.get("daemons"))}


def handle_agent(method: str, path: str, headers, body: bytes, ip: str) -> tuple[int, dict]:
    if _root is None:
        return 503, {"error": "Indisponible"}
    if method != "POST":
        return 405, {"error": "POST requis"}
    route = path[len(PREFIX):] if path.startswith(PREFIX) else ""
    if len(body or b"") > (ENROLL_MAX if route == "/enroll" else REPORT_MAX):
        return 413, {"error": "Requête trop grande."}
    try:
        data = json.loads(body.decode("utf-8")) if body else {}
    except (ValueError, UnicodeError):
        return 400, {"error": "JSON invalide"}
    if not isinstance(data, dict):
        return 400, {"error": "JSON invalide"}
    if route == "/enroll":
        return enroll(data, ip)
    if route != "/report":
        return 404, {"error": "Inconnu"}
    row = authenticate(method, path, headers, body)
    if row is None:
        return 401, {"error": "Signature refusée"}
    report = _clean_report(data)
    if report is None:
        return 400, {"error": "Rapport invalide"}
    now = _clock()
    with _LOCK:
        live = _live.setdefault(row["id"], {"hist": deque(maxlen=HIST_MAX)})
        live["report"], live["seen"] = report, now
        sysinfo = report["system"]
        used, total = sysinfo.get("ram_used_mb"), sysinfo.get("ram_total_mb")
        live["hist"].append((sysinfo.get("cpu_pct") or 0.0, round(100.0 * used / total, 1) if used is not None and total else 0.0,
                             (sysinfo.get("gpus") or [{}])[0].get("util_pct") or 0))
        if not row.get("seen") or now - float(row["seen"]) > SAVE_SEEN_EVERY:
            row["seen"] = now
            _save()
    return 200, {"ok": True, "report_sec": REPORT_SEC}


# ---- admin view ---------------------------------------------------------------------------------------------------

def machines_view() -> list[dict]:
    """What the Engine tab shows for the paired computers (never any secret)."""
    if _root is None:
        return []
    now = _clock()
    out = []
    with _LOCK:
        for m in _registry["machines"]:
            live = _live.get(m["id"]) or {}
            seen = live.get("seen") or m.get("seen")
            report = live.get("report") or {}
            hist = list(live.get("hist") or [])
            out.append({
                "id": m["id"], "name": m.get("name") or "Ordinateur",
                "online": bool(live.get("seen") and now - live["seen"] <= ONLINE_SEC),
                "seen_ago": None if not seen else max(0, int(now - seen)),
                "host": report.get("host"), "os": report.get("os"), "system": report.get("system") or {},
                "daemons": report.get("daemons") or [],
                "history": {"cpu": [round(h[0], 1) for h in hist], "ram": [h[1] for h in hist], "gpu": [h[2] for h in hist]},
            })
    return out
