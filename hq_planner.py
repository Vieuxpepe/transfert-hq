"""Loopback planner API.

Tailscale Serve proxies public clients to 127.0.0.1:8765, so a loopback
check on the public port is not a boundary. This listener binds 127.0.0.1
only (default 8766). The public handler does not serve these routes.

The planner token is its own random credential. It is not the PIN, not an
admin session, and not a device secret. Every job created here is origin
``planner``. A caller-supplied origin is rejected.

If the planner process runs as the same OS account as the controller, it
can read hq_agents.json anyway. This module does not claim otherwise.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import hq_agent_ops as ops
import hq_companion
import hq_jobs
import hq_state

TOKEN_NAME = "hq_planner.json"
TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")
DEFAULT_PORT = 8766
BODY_MAX = 64 * 1024
FORWARDED = ("X-Forwarded-For", "X-Forwarded-Proto", "X-Forwarded-Host", "Forwarded")
JOB_PATH_RE = re.compile(r"^/local-agent/v1/jobs/([A-Za-z0-9_]+)$")
CANCEL_PATH_RE = re.compile(r"^/local-agent/v1/jobs/([A-Za-z0-9_]+)/cancel$")

_token = ""


def token_path(root: Path | str) -> Path:
    return Path(root) / TOKEN_NAME


def ensure_token(root: Path | str) -> str:
    """Return the planner token. A corrupt file is kept and not replaced."""
    path = token_path(root)
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError("hq_planner.json illisible — fichier conservé") from exc
        token = raw.get("token") if isinstance(raw, dict) else None
        if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
            raise RuntimeError("hq_planner.json illisible — fichier conservé")
        return token
    token = secrets.token_hex(32)
    hq_state.write_json_atomic(path, {"version": 1, "token": token})
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return token


def token_matches(expected: str, presented: str) -> bool:
    left = hashlib.sha256(str(expected or "").encode("utf-8")).digest()
    right = hashlib.sha256(str(presented or "").encode("utf-8")).digest()
    same = hmac.compare_digest(left, right)
    if not TOKEN_RE.fullmatch(str(expected or "")) or not TOKEN_RE.fullmatch(str(presented or "")):
        return False
    return bool(same)


def direct_loopback(host: str, header_get: Callable[[str], str | None]) -> bool:
    """True only for a direct loopback peer with no forwarding headers."""
    if host not in ("127.0.0.1", "::1"):
        return False
    for name in FORWARDED:
        if header_get(name):
            return False
    return True


def _scrub(value: Any) -> Any:
    if isinstance(value, dict):
        for key in ("secret", "device_secret", "dispatch_token"):
            value.pop(key, None)
        for item in value.values():
            _scrub(item)
    elif isinstance(value, list):
        for item in value:
            _scrub(item)
    return value


def _bearer(header: str | None) -> str:
    text = str(header or "")
    if not text.startswith("Bearer "):
        return ""
    return text[7:].strip()


def submit_job(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ops.AgentOpError("JSON invalide")
    if "origin" in data:
        raise ops.AgentOpError("origine imposée")
    device_id = str(data.get("device_id") or "")
    granted = hq_companion.granted_for(device_id)
    if granted is None:
        raise ops.AgentOpError("appareil introuvable")
    job = hq_jobs.create_job(
        device_id=device_id,
        op=str(data.get("op") or ""),
        args=data.get("args") if isinstance(data.get("args"), dict) else {},
        origin="planner",
        ttl_sec=data.get("ttl_sec") if isinstance(data.get("ttl_sec"), int) and not isinstance(data.get("ttl_sec"), bool) else None,
        timeout_sec=data.get("timeout_sec") if isinstance(data.get("timeout_sec"), int) and not isinstance(data.get("timeout_sec"), bool) else None,
        granted=granted,
        confirm=None,
    )
    return {"ok": True, "job": job}


def _own_job(job_id: str) -> dict:
    job = hq_jobs.get_job(job_id)
    if job is None or job.get("origin") != "planner":
        raise ops.AgentOpError("travail introuvable")
    return job


def handle_planner(method: str, path: str, body: bytes, *, authorized: bool) -> tuple[int, dict]:
    if not authorized:
        return 401, {"error": "jeton planificateur refusé"}
    try:
        if method == "GET" and path == "/local-agent/v1/devices":
            devices = hq_companion.list_devices()
            return 200, _scrub({"ok": True, "devices": devices})
        if method == "GET" and path == "/local-agent/v1/jobs":
            listed = hq_jobs.list_jobs(origin="planner", limit=50)
            return 200, _scrub(listed)
        match = JOB_PATH_RE.fullmatch(path)
        if method == "GET" and match:
            return 200, _scrub({"ok": True, "job": _own_job(match.group(1))})
        if method == "POST" and path == "/local-agent/v1/jobs":
            data = json.loads(body.decode("utf-8") or "{}")
            return 200, _scrub(submit_job(data))
        cancel = CANCEL_PATH_RE.fullmatch(path)
        if method == "POST" and cancel:
            job = hq_jobs.cancel(cancel.group(1), actor="planner")
            return 200, _scrub({"ok": True, "job": job})
    except PermissionError as exc:
        return 403, {"error": str(exc)}
    except ops.AgentOpError as exc:
        return 400, {"error": str(exc)}
    except RuntimeError as exc:
        return 409, {"error": str(exc)}
    except (UnicodeDecodeError, json.JSONDecodeError):
        return 400, {"error": "JSON invalide"}
    return 404, {"error": "Inconnu"}


def _make_handler(token: str) -> type[BaseHTTPRequestHandler]:
    class PlannerHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def _send(self, status: int, payload: dict) -> None:
            raw = json.dumps(_scrub(payload), ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _guard(self) -> bool:
            host = self.client_address[0] if self.client_address else ""
            if not direct_loopback(host, self.headers.get):
                self._send(404, {"error": "Inconnu"})
                return False
            return True

        def _dispatch(self, method: str) -> None:
            if not self._guard():
                return
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length < 0 or length > BODY_MAX:
                self._send(413, {"error": "corps trop volumineux"})
                return
            body = self.rfile.read(length) if length else b""
            path = urlparse(self.path).path
            status, payload = handle_planner(
                method,
                path,
                body,
                authorized=token_matches(token, _bearer(self.headers.get("Authorization"))),
            )
            self._send(status, payload)

        def do_GET(self) -> None:
            self._dispatch("GET")

        def do_POST(self) -> None:
            self._dispatch("POST")

        def do_PUT(self) -> None:
            self._send(404, {"error": "Inconnu"})

        def do_DELETE(self) -> None:
            self._send(404, {"error": "Inconnu"})

    return PlannerHandler


def start(root: Path | str, *, port: int = DEFAULT_PORT) -> ThreadingHTTPServer:
    """Bind 127.0.0.1 only and serve until shutdown. Daemon thread."""
    global _token
    if isinstance(port, bool) or not isinstance(port, int) or port < 0 or port > 65535:
        raise RuntimeError("port planificateur refusé")
    _token = ensure_token(root)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), _make_handler(_token))
    bound_host = httpd.server_address[0]
    if bound_host not in ("127.0.0.1", "::1"):
        httpd.server_close()
        raise RuntimeError("écoute planificateur refusée")
    threading.Thread(target=httpd.serve_forever, name="hq-planner", daemon=True).start()
    return httpd
