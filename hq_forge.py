"""Forge Studio: fixed-localhost Forge client.

The browser never receives a Forge URL and cannot choose the upstream.
Status and catalog use GET on http://127.0.0.1:7860. Text-to-image is a
separate POST to /sdapi/v1/txt2img only. This module never calls Forge's
global interrupt.
"""

from __future__ import annotations

import json
import math
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

UPSTREAM_ORIGIN = "http://127.0.0.1:7860"
PROBE_TIMEOUT_SEC = 2.5
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_SUBMIT_BYTES = 32 * 1024 * 1024
CATALOG_TTL_SEC = 60.0
MAX_CACHE_ENTRIES = 8
MAX_LIST = 64
SUBMIT_PATH = "/sdapi/v1/txt2img"
JOB_TIMEOUT_SEC = 600.0

ALLOWED_ROUTES = frozenset({
    ("GET", "/sdapi/v1/samplers"),
    ("GET", "/sdapi/v1/schedulers"),
    ("GET", "/sdapi/v1/sd-models"),
    ("GET", "/sdapi/v1/upscalers"),
    ("GET", "/sdapi/v1/options"),
    ("GET", "/sdapi/v1/loras"),
    ("GET", "/sdapi/v1/progress"),
    ("GET", "/internal/pending-tasks"),
})

_SAFE_TITLE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._\-()\[\]+]{0,180}$")
_SAFE_FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_HEX = re.compile(r"^[0-9a-fA-F]{4,64}$")
_SHA = re.compile(r"^[0-9a-fA-F]{64}$")

_MESSAGES = {
    "forge_offline": "Forge n'est pas démarré.",
    "api_disabled": "Forge est ouvert, mais son API n'est pas activée.",
    "catalog_empty": "Forge répond, mais le catalogue utilisable est vide.",
    "forge_timeout": "Forge n’a pas répondu à temps.",
    "forge_auth": "Forge a refusé la lecture.",
    "forge_error": "Forge a renvoyé une réponse inutilisable.",
    "forge_http": "Forge a répondu par un code d'erreur.",
    "forge_malformed": "Forge a renvoyé un JSON illisible.",
    "forge_schema": "Forge a renvoyé un résultat inattendu.",
    "busy": "Forge est déjà en train de générer.",
    "ready": "Forge est en ligne.",
}

_test_transport = None
_upstream = UPSTREAM_ORIGIN
_probe_timeout = PROBE_TIMEOUT_SEC
_catalog_ttl = CATALOG_TTL_SEC
_catalog_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()
_LOOPBACK_ORIGIN = re.compile(r"^http://127\.0\.0\.1:([0-9]{1,5})$")


class _Probe(Exception):
    def __init__(self, code: str, *, http_status: int | None = None, elapsed_ms: int | None = None) -> None:
        self.code = code
        self.http_status = http_status if isinstance(http_status, int) and 100 <= http_status <= 599 else None
        self.elapsed_ms = elapsed_ms if isinstance(elapsed_ms, int) and 0 <= elapsed_ms <= 3_600_000 else None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _opener() -> urllib.request.OpenerDirector:
    # An empty proxy map ignores HTTP_PROXY, HTTPS_PROXY, and ALL_PROXY.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def _require_json(header: str | None) -> None:
    media = str(header or "").split(";", 1)[0].strip().lower()
    if media != "application/json":
        raise OSError("forge")


def reset_for_tests() -> None:
    global _test_transport, _upstream, _probe_timeout, _catalog_ttl
    _test_transport = None
    _upstream = UPSTREAM_ORIGIN
    _probe_timeout = PROBE_TIMEOUT_SEC
    _catalog_ttl = CATALOG_TTL_SEC
    with _lock:
        _catalog_cache.clear()


def set_transport_for_tests(transport) -> None:
    global _test_transport
    _test_transport = transport
    with _lock:
        _catalog_cache.clear()


def set_upstream_for_tests(origin: str | None) -> None:
    """Test-only loopback origin. Production stays on UPSTREAM_ORIGIN."""
    global _upstream
    if origin is None:
        _upstream = UPSTREAM_ORIGIN
    else:
        match = _LOOPBACK_ORIGIN.fullmatch(origin)
        if match is None:
            raise ValueError("origin")
        port = int(match.group(1))
        if port < 1 or port > 65535:
            raise ValueError("origin")
        _upstream = origin
    with _lock:
        _catalog_cache.clear()


def set_probe_timeout_for_tests(seconds: float | None) -> None:
    global _probe_timeout
    if seconds is None:
        _probe_timeout = PROBE_TIMEOUT_SEC
        return
    value = float(seconds)
    if value <= 0 or value > PROBE_TIMEOUT_SEC:
        raise ValueError("timeout")
    _probe_timeout = value


def set_catalog_ttl_for_tests(seconds: float | None) -> None:
    global _catalog_ttl
    if seconds is None:
        _catalog_ttl = CATALOG_TTL_SEC
        return
    value = float(seconds)
    if value <= 0 or value > CATALOG_TTL_SEC:
        raise ValueError("ttl")
    _catalog_ttl = value


def cache_entry_count_for_tests() -> int:
    with _lock:
        return len(_catalog_cache)


def _resolve(transport):
    if transport is not None:
        return transport
    if _test_transport is not None:
        return _test_transport
    return _default_transport


def _allowed(method: str, path: str) -> bool:
    if method == "GET":
        return ("GET", path) in ALLOWED_ROUTES
    return method == "POST" and path == SUBMIT_PATH


def _check_url(method: str, url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "http" or parts.hostname != "127.0.0.1" or parts.username or parts.password:
        raise OSError("forge")
    if not url.startswith(_upstream + "/"):
        raise OSError("forge")
    path = parts.path
    if not _allowed(method, path):
        raise OSError("forge")
    return path


def _default_transport(method: str, url: str, timeout: float, body: bytes | None = None, max_bytes: int | None = None) -> tuple[int, bytes]:
    _check_url(method, url)
    if method == "GET" and body is not None:
        raise OSError("forge")
    if method == "POST" and not isinstance(body, (bytes, bytearray)):
        raise OSError("forge")
    cap = MAX_RESPONSE_BYTES if method == "GET" else MAX_SUBMIT_BYTES
    if max_bytes is not None:
        cap = min(cap, int(max_bytes))
    timeout = min(float(timeout), JOB_TIMEOUT_SEC if method == "POST" else PROBE_TIMEOUT_SEC)
    headers = {"Accept": "application/json"}
    if method == "POST":
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with _opener().open(request, timeout=timeout) as response:
            final = response.geturl()
            if urllib.parse.urlsplit(final).hostname != "127.0.0.1":
                raise OSError("forge")
            _require_json(response.headers.get("Content-Type"))
            return response.status, response.read(cap + 1)
    except urllib.error.HTTPError as exc:
        if exc.code == 200:
            _require_json(exc.headers.get("Content-Type") if exc.headers else None)
        return exc.code, exc.read(cap + 1)
    except TimeoutError:
        raise
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, TimeoutError):
            raise TimeoutError from None
        if isinstance(reason, ConnectionRefusedError):
            raise ConnectionRefusedError from None
        if isinstance(reason, (ConnectionResetError, ConnectionAbortedError)):
            raise ConnectionResetError from None
        winerror = getattr(reason, "winerror", None)
        if winerror in (10061, 10054, 10053):
            raise ConnectionResetError from None
        if winerror == 10060:
            raise TimeoutError from None
        raise OSError("forge") from None


def _public(code: str) -> str:
    if code in ("forge_offline", "api_disabled"):
        return "offline" if code == "forge_offline" else "api_disabled"
    return "error"


def _status_payload(code: str, *, model: str | None = None, forge: str | None = None) -> dict:
    kind = forge or _public(code)
    return {
        "forge": kind,
        "model": model,
        "message": _MESSAGES.get(code, _MESSAGES["forge_error"]),
        "code": code,
    }


def _catalog_payload(code: str, *, models=None, samplers=None, schedulers=None, upscalers=None, forge: str | None = None) -> dict:
    kind = forge or _public(code)
    return {
        "forge": kind,
        "models": models or [],
        "samplers": samplers or [],
        "schedulers": schedulers or [],
        "upscalers": upscalers or [],
        "message": _MESSAGES.get(code, _MESSAGES["forge_error"]),
        "code": code,
    }


def _call(transport, path: str, query: str = ""):
    if ("GET", path) not in ALLOWED_ROUTES or "://" in query or "\\" in query:
        raise _Probe("forge_error")
    url = _upstream + path + query
    try:
        status, body = transport("GET", url, _probe_timeout)
    except TimeoutError:
        raise _Probe("forge_timeout") from None
    except ConnectionRefusedError:
        raise _Probe("forge_offline") from None
    except ConnectionResetError:
        raise _Probe("forge_offline") from None
    except OSError:
        raise _Probe("forge_error") from None
    if not isinstance(status, int) or not isinstance(body, (bytes, bytearray)):
        raise _Probe("forge_error")
    if len(body) > MAX_RESPONSE_BYTES:
        raise _Probe("forge_error")
    if status == 404:
        raise _Probe("api_disabled")
    if status == 401:
        raise _Probe("forge_auth")
    if status != 200:
        raise _Probe("forge_error")
    try:
        return json.loads(bytes(body).decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise _Probe("forge_malformed") from None


def _records(value):
    if not isinstance(value, list) or len(value) > MAX_LIST:
        return None
    return value


def _checkpoint(value) -> str | None:
    if not isinstance(value, str) or not _SAFE_FILE.fullmatch(value.strip()):
        return None
    return value.strip()


def _model_row(item) -> dict | None:
    if not isinstance(item, dict):
        return None
    title = item.get("title")
    name = item.get("model_name")
    digest = item.get("hash")
    sha = item.get("sha256")
    if not isinstance(title, str) or not _SAFE_TITLE.fullmatch(title):
        return None
    if not isinstance(name, str) or not _SAFE_FILE.fullmatch(name):
        return None
    if not isinstance(digest, str) or not _HEX.fullmatch(digest):
        return None
    if sha is not None and (not isinstance(sha, str) or not _SHA.fullmatch(sha)):
        return None
    return {
        "title": title,
        "model_name": name,
        "hash": digest,
        "sha256": sha.lower() if isinstance(sha, str) else None,
    }


def _sampler_row(item) -> dict | None:
    if not isinstance(item, dict):
        return None
    name = item.get("name")
    if not isinstance(name, str) or not _SAFE_TITLE.fullmatch(name):
        return None
    row = {"name": name}
    aliases = item.get("aliases")
    if isinstance(aliases, list):
        clean = [alias for alias in aliases if isinstance(alias, str) and _SAFE_TITLE.fullmatch(alias)]
        if clean and len(clean) == len(aliases):
            row["aliases"] = clean[:8]
    return row


def _upscaler_row(item) -> dict | None:
    if not isinstance(item, dict):
        return None
    name = item.get("name")
    if not isinstance(name, str) or name in {"None", "none"} or not _SAFE_TITLE.fullmatch(name):
        return None
    return {"name": name}


def _safe_upscalers(transport) -> list:
    """Upscalers are optional. A missing list leaves Hires. fix unavailable."""
    try:
        rows = _rows(_records(_call(transport, "/sdapi/v1/upscalers")), _upscaler_row)
    except _Probe:
        return []
    if not rows:
        return []
    return rows[:32]


def _scheduler_row(item) -> dict | None:
    if not isinstance(item, dict):
        return None
    name = item.get("name")
    label = item.get("label")
    if not isinstance(name, str) or not _SAFE_TITLE.fullmatch(name):
        return None
    if not isinstance(label, str) or not _SAFE_TITLE.fullmatch(label):
        return None
    return {"name": name, "label": label}


def _rows(records, parser) -> list | None:
    if records is None:
        return None
    rows = []
    for item in records:
        row = parser(item)
        if row is not None:
            rows.append(row)
    return rows


def status(*, transport=None) -> dict:
    transport = _resolve(transport)
    try:
        samplers = _records(_call(transport, "/sdapi/v1/samplers"))
        if samplers is None:
            raise _Probe("forge_error")
        progress = _call(transport, "/sdapi/v1/progress", "?skip_current_image=true")
        pending = _call(transport, "/internal/pending-tasks")
        options = _call(transport, "/sdapi/v1/options")
    except _Probe as exc:
        return _status_payload(exc.code)
    if not isinstance(progress, dict) or not isinstance(pending, dict) or not isinstance(options, dict):
        return _status_payload("forge_error")
    state = progress.get("state")
    if not isinstance(state, dict):
        return _status_payload("forge_error")
    job = state.get("job", "")
    job_count = state.get("job_count", 0)
    pending_size = pending.get("size", 0)
    if not isinstance(job, str) or not isinstance(job_count, int) or isinstance(job_count, bool):
        return _status_payload("forge_error")
    if not isinstance(pending_size, int) or isinstance(pending_size, bool):
        return _status_payload("forge_error")
    if job_count < 0 or pending_size < 0 or job_count > MAX_LIST or pending_size > MAX_LIST:
        return _status_payload("forge_error")
    model = _checkpoint(options.get("sd_model_checkpoint"))
    if job or job_count > 0 or pending_size > 0:
        return _status_payload("busy", model=model, forge="busy")
    return _status_payload("ready", model=model, forge="ready")


def _build_catalog(transport) -> dict:
    try:
        models = _rows(_records(_call(transport, "/sdapi/v1/sd-models")), _model_row)
        samplers = _rows(_records(_call(transport, "/sdapi/v1/samplers")), _sampler_row)
        schedulers_raw = _records(_call(transport, "/sdapi/v1/schedulers"))
    except _Probe as exc:
        return _catalog_payload(exc.code)
    if models is None or samplers is None or schedulers_raw is None:
        return _catalog_payload("forge_error")
    schedulers = _rows(schedulers_raw, _scheduler_row)
    if schedulers is None:
        return _catalog_payload("forge_error")
    upscalers = _safe_upscalers(transport)
    if not models or not samplers or not schedulers:
        return _catalog_payload("catalog_empty", upscalers=upscalers)
    return _catalog_payload(
        "ready", models=models, samplers=samplers, schedulers=schedulers, upscalers=upscalers, forge="ready"
    )


def _cache_key(transport) -> str:
    marker = getattr(transport, "forge_cache_key", None)
    if isinstance(marker, str) and marker.isascii() and 1 <= len(marker) <= 64:
        return "k:" + marker
    return "id:" + format(id(transport), "x")


def _cache_sweep(now: float) -> None:
    expired = [key for key, (stamp, _payload) in _catalog_cache.items() if now - stamp >= _catalog_ttl]
    for key in expired:
        _catalog_cache.pop(key, None)
    overflow = len(_catalog_cache) - MAX_CACHE_ENTRIES
    if overflow > 0:
        oldest = sorted(_catalog_cache, key=lambda key: _catalog_cache[key][0])
        for key in oldest[:overflow]:
            _catalog_cache.pop(key, None)


def catalog(*, transport=None) -> dict:
    transport = _resolve(transport)
    key = _cache_key(transport)
    now = time.monotonic()
    with _lock:
        _cache_sweep(now)
        hit = _catalog_cache.get(key)
        if hit is not None and now - hit[0] < _catalog_ttl:
            return json.loads(json.dumps(hit[1]))
    payload = _build_catalog(transport)
    if payload.get("forge") == "ready":
        with _lock:
            _catalog_cache[key] = (time.monotonic(), payload)
            _cache_sweep(time.monotonic())
    return payload


ETA_MAX_SEC = 3600.0


def eta_seconds(progress) -> float | None:
    """Forge's /sdapi/v1/progress ``eta_relative`` (seconds left), sanitized:
    finite, above 0 and at most an hour, else None (the UI hides it)."""
    if not isinstance(progress, dict):
        return None
    value = progress.get("eta_relative")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or number <= 0 or number > ETA_MAX_SEC:
        return None
    return round(number, 1)


def read_progress(*, transport=None) -> dict:
    transport = _resolve(transport)
    value = _call(transport, "/sdapi/v1/progress", "?skip_current_image=true")
    if not isinstance(value, dict):
        raise _Probe("forge_error")
    return value


def read_loras(*, transport=None) -> list:
    """GET /sdapi/v1/loras (read-only, sd_forge_lora). Rows are {name, alias, metadata}."""
    transport = _resolve(transport)
    value = _call(transport, "/sdapi/v1/loras")
    if not isinstance(value, list):
        raise _Probe("forge_error")
    return value


def read_options(*, transport=None) -> dict:
    """GET /sdapi/v1/options (already allowlisted). Read-only; HQ never writes options."""
    transport = _resolve(transport)
    value = _call(transport, "/sdapi/v1/options")
    if not isinstance(value, dict):
        raise _Probe("forge_error")
    return value


def _elapsed_ms(started: float) -> int:
    return max(0, min(3_600_000, int((time.monotonic() - started) * 1000)))


def post_json(path: str, payload: dict, *, timeout: float, transport=None) -> dict:
    """POST one allowlisted JSON route. The only route is txt2img."""
    if path != SUBMIT_PATH or not isinstance(payload, dict):
        raise _Probe("forge_error")
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    if len(body) > 256 * 1024:
        raise _Probe("forge_error")
    transport = _resolve(transport)
    url = _upstream + path
    started = time.monotonic()
    try:
        try:
            status, raw = transport("POST", url, float(timeout), body)
        except TypeError:
            raise _Probe("forge_error", elapsed_ms=_elapsed_ms(started)) from None
    except TimeoutError:
        raise _Probe("forge_timeout", elapsed_ms=_elapsed_ms(started)) from None
    except ConnectionRefusedError:
        raise _Probe("forge_offline", elapsed_ms=_elapsed_ms(started)) from None
    except ConnectionResetError:
        raise _Probe("forge_offline", elapsed_ms=_elapsed_ms(started)) from None
    except OSError:
        raise _Probe("forge_error", elapsed_ms=_elapsed_ms(started)) from None
    elapsed = _elapsed_ms(started)
    if not isinstance(status, int) or not isinstance(raw, (bytes, bytearray)):
        raise _Probe("forge_error", elapsed_ms=elapsed)
    if len(raw) > MAX_SUBMIT_BYTES:
        raise _Probe("forge_error", http_status=status if isinstance(status, int) else None, elapsed_ms=elapsed)
    if status != 200:
        raise _Probe("forge_http", http_status=status, elapsed_ms=elapsed)
    try:
        parsed = json.loads(bytes(raw).decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise _Probe("forge_malformed", http_status=status, elapsed_ms=elapsed) from None
    if not isinstance(parsed, dict):
        raise _Probe("forge_schema", http_status=status, elapsed_ms=elapsed)
    images = parsed.get("images")
    if "images" in parsed and (
        not isinstance(images, list) or any(not isinstance(item, str) for item in images)
    ):
        raise _Probe("forge_schema", http_status=status, elapsed_ms=elapsed)
    return parsed
