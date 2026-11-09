"""Local lifecycle listener.

The listener is a separate process from HQ. Ordinary calls bind 127.0.0.1 on
an ephemeral port and refuse 7860, 8765, and 8776. The only fixed endpoint
this module can name is 127.0.0.1:8776, and both the configuration gate and
the bind latch stay false, so this process does not open that port.

Authorization reads the persisted session record. It does not call the
HQ session-role helper and it does not rewrite the role field.

The HQ origin allowlist is not consulted. A lifecycle action needs a
credential bound to the presented session token. The credential is not
stored in the session file.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import socket
import threading
import time
from pathlib import Path
from typing import Callable

import hq_forge_csrf_key as csrf_key
import hq_forge_lifecycle as life

RESERVED_PORTS = frozenset({7860, 8765, 8776})
PRODUCTION_ROOT = Path(r"C:\Transfert").resolve()
_HOST_RE = re.compile(r"^127\.0\.0\.1:([1-9][0-9]{0,4})$")
_ORIGIN_RE = re.compile(r"^http://127\.0\.0\.1:([1-9][0-9]{0,4})$")
_MISSING = object()
_page_host: str | None = None
_listener_origin: str | None = None
CSRF_HEADER = "X-HQ-Lifecycle-CSRF"
CSRF_TTL_SEC = 120
_CSRF_RE = re.compile(r"^v1\.(\d{1,10})\.(\d{1,10})\.([0-9a-f]{64})$")
_PREFLIGHT_HEADERS = frozenset({
    frozenset({"content-type"}),
    frozenset({"content-type", "x-hq-lifecycle-csrf"}),
})


def _port_of(pattern: re.Pattern[str], value: str) -> int:
    match = pattern.fullmatch(value)
    if match is None:
        raise RuntimeError("loopback host required")
    port = int(match.group(1))
    if port > 65535:
        raise RuntimeError("loopback host required")
    return port


def assert_isolated_session_path(path: Path) -> None:
    resolved = Path(path).resolve()
    if resolved == PRODUCTION_ROOT or PRODUCTION_ROOT in resolved.parents:
        raise RuntimeError("refusing a production session path")


def assert_development_port(port: int) -> None:
    if int(port) in RESERVED_PORTS:
        raise RuntimeError("refusing to bind a reserved port")


FIXED_LISTENER_HOST = "127.0.0.1"
FIXED_LISTENER_PORT = 8776
# Both stay false until a separate maintenance authorization. The decision
# function can name 127.0.0.1:8776 only when the first flag is set. The socket
# is opened only when the second flag is also set. Neither flag is read from
# the environment or from a state file.
EXACT_PORT_LISTENER_ENABLED = False
EXACT_PORT_BIND_PERMITTED = False


def fixed_listener_decision(*, authorized: bool) -> tuple[str, int]:
    """Name the only fixed listener endpoint. This does not bind a socket."""
    if authorized is not True or EXACT_PORT_LISTENER_ENABLED is not True:
        raise RuntimeError("fixed listener port is disabled")
    return (FIXED_LISTENER_HOST, FIXED_LISTENER_PORT)


def assert_fixed_listener_bind(port: int, *, authorized: bool) -> tuple[str, int]:
    """Allow a socket only for the gated loopback endpoint."""
    host, decided = fixed_listener_decision(authorized=authorized)
    if type(port) is not int or port != decided or host != FIXED_LISTENER_HOST:
        raise RuntimeError("fixed listener port is disabled")
    if EXACT_PORT_BIND_PERMITTED is not True:
        raise RuntimeError("fixed listener bind is not permitted")
    return host, decided


def set_browser_binding_for_tests(page_host: str | None, listener_origin: str | None) -> None:
    """Point the probe page at an ephemeral loopback pair. Does not bind a port."""
    global _page_host, _listener_origin
    if page_host is not None:
        _port_of(_HOST_RE, page_host)
    if listener_origin is not None:
        _port_of(_ORIGIN_RE, listener_origin)
    _page_host = page_host
    _listener_origin = listener_origin


def reset_browser_binding_for_tests() -> None:
    set_browser_binding_for_tests(None, None)


def approved_page_host() -> str:
    return _page_host or "127.0.0.1:8765"


def active_listener_origin() -> str:
    return _listener_origin or life.LISTENER_ORIGIN


def content_security_policy(host: str, path: str, *, frame_self: bool = False, wasm: bool = False) -> str:
    """Production policy, plus one connect-src target on the localhost probe page."""
    connect = "connect-src 'self'"
    normalized = (host or "").split(",")[0].strip()
    if path == "/lifecycle-probe" and normalized == approved_page_host() and _HOST_RE.fullmatch(normalized):
        connect = f"connect-src 'self' {active_listener_origin()}"
    policy = (
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
        f"script-src 'self' 'unsafe-inline'; {connect}; "
        + ("frame-ancestors 'self'" if frame_self else "frame-ancestors 'none'")
        + "; base-uri 'self'"
    )
    if wasm:
        policy = policy.replace(
            "script-src 'self' 'unsafe-inline';",
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval';",
            1,
        )
    return policy


def probe_page_html(credential: str = "") -> bytes:
    origin = active_listener_origin()
    _port_of(_ORIGIN_RE, origin)
    if credential and _CSRF_RE.fullmatch(credential) is None:
        credential = ""
    spec = json.dumps({"csrf": credential, "action": origin + "/lifecycle/start"})
    html = f"""<!doctype html>
<meta charset="utf-8">
<title>lifecycle probe</title>
<button id="go" type="button">go</button>
<pre id="out"></pre>
<script type="application/json" id="lifecycle-csrf">{spec}</script>
<script>
document.getElementById("go").addEventListener("click", async () => {{
  const out = document.getElementById("out");
  const spec = JSON.parse(document.getElementById("lifecycle-csrf").textContent);
  try {{
    const response = await fetch(spec.action, {{
      method: "POST",
      credentials: "include",
      mode: "cors",
      headers: {{"Content-Type": "application/json", "X-HQ-Lifecycle-CSRF": spec.csrf}},
      body: "{{}}"
    }});
    out.textContent = String(response.status);
  }} catch (error) {{
    out.textContent = "blocked";
  }}
}});
</script>
"""
    return html.encode("utf-8")


def is_lifecycle_action_path(path: str) -> bool:
    raw = (path or "").split("?", 1)[0]
    if raw in {"/lifecycle/start", "/lifecycle/restart"}:
        return True
    return raw == "/api/forge/lifecycle" or raw.startswith("/api/forge/lifecycle/")


def cookie_token(cookie_header: str) -> str:
    for part in str(cookie_header or "").split(";"):
        name, separator, value = part.strip().partition("=")
        if separator and name == "transfert_session":
            return value
    return ""


def csrf_key_path(sessions: Path) -> Path:
    return csrf_key.csrf_key_path(sessions)


def load_csrf_key(sessions: Path) -> bytes | None:
    return csrf_key.load_csrf_key(sessions)


def ensure_csrf_key(sessions: Path) -> bytes:
    """Create the key, or read one that already has the protected DACL."""
    return csrf_key.ensure_csrf_key(sessions)


def _csrf_message(session_token: str, generation: int, credential_exp: int) -> bytes:
    return b"\n".join((
        b"v1",
        str(generation).encode("ascii"),
        str(credential_exp).encode("ascii"),
        session_token.encode("utf-8"),
    ))


def mint_csrf(
    session_token: str,
    generation: int,
    session_exp: float,
    key: bytes,
    *,
    now: float | None = None,
    credential_exp: int | None = None,
) -> str:
    if type(session_token) is not str or not session_token:
        raise RuntimeError("csrf subject required")
    if type(generation) is not int or type(key) is not bytes or len(key) != 32:
        raise RuntimeError("csrf subject required")
    current = time.time() if now is None else now
    if credential_exp is None:
        if type(session_exp) is bool or not isinstance(session_exp, (int, float)):
            raise RuntimeError("csrf subject required")
        credential_exp = min(int(session_exp), int(current) + CSRF_TTL_SEC)
    if type(credential_exp) is not int:
        raise RuntimeError("csrf expiry required")
    mac = hmac.new(key, _csrf_message(session_token, generation, credential_exp), hashlib.sha256).hexdigest()
    return f"v1.{credential_exp}.{generation}.{mac}"


def mint_csrf_for_session(sessions: Path, token: str, *, now: float | None = None) -> str:
    """Bind a credential to the raw session token. Never writes the session file."""
    if type(token) is not str or not token:
        return ""
    kind, info = read_session_record(sessions, token)
    if kind != "ok" or info is None:
        return ""
    generation = info.get("gen", _MISSING)
    exp = info.get("exp", _MISSING)
    if type(generation) is not int or exp is _MISSING or type(exp) is bool or not isinstance(exp, (int, float)):
        return ""
    current = time.time() if now is None else now
    if float(exp) <= current:
        return ""
    return mint_csrf(token, generation, float(exp), ensure_csrf_key(sessions), now=current)


def assess_csrf(
    presented: str,
    session_token: str,
    key: bytes | None,
    *,
    now: float | None = None,
) -> tuple[str, int | None]:
    """Return missing, invalid, wrong-session, expired, or ok. Does not read a session file."""
    if not presented:
        return "missing", None
    if key is None or len(key) != 32 or type(session_token) is not str or not session_token:
        return "invalid", None
    match = _CSRF_RE.fullmatch(presented)
    if match is None:
        return "invalid", None
    credential_exp = int(match.group(1))
    generation = int(match.group(2))
    mac = match.group(3)
    expected = hmac.new(key, _csrf_message(session_token, generation, credential_exp), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, expected):
        return "wrong-session", None
    current = time.time() if now is None else now
    if credential_exp <= int(current):
        return "expired", generation
    return "ok", generation


def read_session_record(path: Path, token: str) -> tuple[str, dict | None]:
    """Return bad, absent, or ok. Never writes the file."""
    try:
        csrf_key.assert_direct_path(path)
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, RuntimeError):
        return "bad", None
    if not isinstance(data, dict):
        return "bad", None
    info = data.get(token)
    if not isinstance(info, dict):
        return "absent", None
    return "ok", info


def authorize_action(
    sessions: Path,
    token: str,
    presented: str,
    expected_generation: int,
    key: bytes | None,
    *,
    now: float | None = None,
) -> str:
    """Return anonymous, a CSRF failure, forbidden, or ok. Never writes the session file."""
    if not token:
        return "anonymous"
    verdict, credential_generation = assess_csrf(presented, token, key, now=now)
    if verdict != "ok":
        return verdict
    kind, info = read_session_record(sessions, token)
    if kind == "bad":
        return "anonymous"
    if kind == "absent" or info is None:
        return "revoked"
    if type(info.get("gen")) is not int or info.get("gen") != credential_generation:
        return "revoked"
    decision = classify_persisted_session(sessions, token, expected_generation)
    if decision == "anonymous":
        return "anonymous"
    if decision != "admin":
        return "forbidden"
    return "ok"


def classify_persisted_session(path: Path, token: str, expected_generation: int) -> str:
    """Return admin, forbidden, or anonymous. Never writes the session file.

    admin requires the raw persisted role to be exactly the string admin.
    """
    if not token or type(expected_generation) is not int:
        return "anonymous"
    try:
        csrf_key.assert_direct_path(path)
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, RuntimeError):
        return "anonymous"
    if not isinstance(data, dict):
        return "anonymous"
    info = data.get(token)
    if not isinstance(info, dict):
        return "anonymous"
    if "gen" not in info or type(info["gen"]) is not int or info["gen"] != expected_generation:
        return "anonymous"
    exp = info.get("exp", _MISSING)
    if exp is _MISSING or type(exp) is bool or not isinstance(exp, (int, float)):
        return "anonymous"
    if float(exp) <= time.time():
        return "anonymous"
    role = info.get("role", _MISSING)
    if type(role) is not str or role != "admin":
        return "forbidden"
    return "admin"


def hq_process_ok(pid: int, creation: int) -> bool:
    if type(pid) is not int or type(creation) is not int or pid <= 0 or creation <= 0:
        return False
    if not life.process_alive(pid):
        return False
    actual = life.process_creation(pid)
    return actual == creation


def _make_server(handler_type):
    from http.server import ThreadingHTTPServer

    class Server(ThreadingHTTPServer):
        allow_reuse_address = False

        def server_bind(self) -> None:
            if self.server_address[0] != "127.0.0.1":
                raise RuntimeError("listener left loopback")
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()
            if self.server_address[0] != "127.0.0.1":
                raise RuntimeError("listener left loopback")

    for _ in range(8):
        server = Server(("127.0.0.1", 0), handler_type)
        port = int(server.server_address[1])
        if port not in RESERVED_PORTS:
            return server
        server.server_close()
    raise RuntimeError("no free listener port")


def _make_bound_server(handler_type, host: str, port: int):
    """Bind the gated endpoint. The latch is checked again before the socket."""
    from http.server import ThreadingHTTPServer

    host, port = assert_fixed_listener_bind(port, authorized=True)
    if EXACT_PORT_LISTENER_ENABLED is not True:
        raise RuntimeError("fixed listener port is disabled")

    class Server(ThreadingHTTPServer):
        allow_reuse_address = False

        def server_bind(self) -> None:
            if self.server_address != (FIXED_LISTENER_HOST, FIXED_LISTENER_PORT):
                raise RuntimeError("listener left the fixed endpoint")
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()
            if self.server_address != (FIXED_LISTENER_HOST, FIXED_LISTENER_PORT):
                raise RuntimeError("listener left the fixed endpoint")

    return Server((host, port), handler_type)


class LifecycleListener:
    """Credentialed loopback listener. The request body cannot choose a command."""

    def __init__(
        self,
        supervisor: life.Supervisor,
        allowed_origin: str,
        sessions_path: Path,
        generation: int,
        hq_pid: int,
        hq_creation: int,
        probe: Callable[[], str],
        *,
        listen_port: int | None = None,
        fixed_port_authorized: bool = False,
    ) -> None:
        from http.server import BaseHTTPRequestHandler

        assert_isolated_session_path(sessions_path)
        _port_of(_ORIGIN_RE, allowed_origin)
        if type(generation) is not int:
            raise RuntimeError("generation required")
        self.supervisor = supervisor
        self.allowed_origin = allowed_origin
        self.sessions_path = Path(sessions_path)
        self.generation = generation
        self.hq_pid = hq_pid
        self.hq_creation = hq_creation
        self.probe = probe
        self.calls: list[dict] = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                return

            def _seen(self, kind: str) -> None:
                owner.calls.append({
                    "kind": kind,
                    "origin": self.headers.get("Origin") or "",
                    "host": self.headers.get("Host") or "",
                    "cookie_present": bool(self.headers.get("Cookie")),
                    "referer_present": bool(self.headers.get("Referer")),
                    "csrf_present": self.headers.get(CSRF_HEADER) is not None,
                })

            def _cors(self, allow: bool, private: bool) -> None:
                if not allow:
                    return
                self.send_header("Access-Control-Allow-Origin", owner.allowed_origin)
                self.send_header("Access-Control-Allow-Credentials", "true")
                self.send_header("Access-Control-Allow-Methods", "POST")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-HQ-Lifecycle-CSRF")
                self.send_header("Access-Control-Max-Age", "0")
                self.send_header("Vary", "Origin")
                if private:
                    self.send_header("Access-Control-Allow-Private-Network", "true")

            def _send(self, status: int, body: bytes, allow: bool, private: bool = False) -> None:
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self._cors(allow, private)
                    self.end_headers()
                    if body:
                        self.wfile.write(body)
                except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                    return

            def _host_ok(self) -> bool:
                return (self.headers.get("Host") or "") == f"127.0.0.1:{owner.port}"

            def _origin_ok(self) -> bool:
                return (self.headers.get("Origin") or "") == owner.allowed_origin

            def _preflight_ok(self) -> bool:
                method = (self.headers.get("Access-Control-Request-Method") or "").upper()
                headers = [
                    part.strip().lower()
                    for part in (self.headers.get("Access-Control-Request-Headers") or "").split(",")
                    if part.strip()
                ]
                return (
                    self._host_ok()
                    and self._origin_ok()
                    and method == "POST"
                    and frozenset(headers) in _PREFLIGHT_HEADERS
                )

            def do_OPTIONS(self):
                self._seen("preflight")
                private = (self.headers.get("Access-Control-Request-Private-Network") or "").lower() == "true"
                allow = self._preflight_ok()
                if private and not allow:
                    self._send(403, b"", False)
                    return
                self._send(204 if allow else 403, b"", allow, private and allow)

            def do_GET(self):
                self._seen("method")
                self._send(405, b'{"error":"method"}', False)

            def do_PUT(self):
                self.do_GET()

            def do_DELETE(self):
                self.do_GET()

            def do_POST(self):
                self._seen("action")
                try:
                    length = int(self.headers.get("Content-Length") or "0")
                except ValueError:
                    self._send(400, b'{"error":"body"}', False)
                    return
                if length < 0 or length > 2048:
                    self._send(400, b'{"error":"body"}', self._origin_ok() and self._host_ok())
                    return
                raw = self.rfile.read(length) if length else b""
                allow = self._host_ok() and self._origin_ok()
                if not self._host_ok() or not self._origin_ok():
                    self._send(403, b'{"error":"origin"}', False)
                    return
                content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
                if content_type != "application/json":
                    self._send(415, b'{"error":"type"}', True)
                    return
                path = self.path.split("?", 1)[0]
                if self.path != path:
                    self._send(400, b'{"error":"path"}', True)
                    return
                try:
                    payload = json.loads(raw.decode("utf-8") or "{}")
                except (UnicodeError, json.JSONDecodeError):
                    self._send(400, b'{"error":"json"}', True)
                    return
                if not isinstance(payload, dict) or payload != {}:
                    self._send(400, b'{"error":"body"}', True)
                    return
                token = cookie_token(self.headers.get("Cookie") or "")
                decision = authorize_action(
                    owner.sessions_path,
                    token,
                    self.headers.get(CSRF_HEADER) or "",
                    owner.generation,
                    load_csrf_key(owner.sessions_path),
                )
                if decision == "anonymous":
                    self._send(401, b'{"error":"anonymous"}', True)
                    return
                if decision == "forbidden":
                    self._send(403, b'{"error":"admin"}', True)
                    return
                if decision != "ok":
                    self._send(403, b'{"error":"csrf"}', True)
                    return
                if not hq_process_ok(owner.hq_pid, owner.hq_creation):
                    self._send(503, b'{"error":"hq"}', True)
                    return
                if path == "/lifecycle/start":
                    result = owner.supervisor.start()
                elif path == "/lifecycle/restart":
                    result = owner.supervisor.restart(owner.probe)
                else:
                    self._send(404, b'{"error":"unknown"}', True)
                    return
                encoded = json.dumps({"code": result["code"], "signaled": result["signaled"]}).encode("utf-8")
                self._send(200 if result["ok"] else 409, encoded, True)

        if listen_port not in (None, 0):
            assert_fixed_listener_bind(listen_port, authorized=fixed_port_authorized)
            self._server = _make_bound_server(Handler, FIXED_LISTENER_HOST, FIXED_LISTENER_PORT)
            self.port = int(self._server.server_address[1])
            if self.port != FIXED_LISTENER_PORT:
                self._server.server_close()
                raise RuntimeError("listener left the fixed endpoint")
        else:
            if fixed_port_authorized is not False:
                raise RuntimeError("authorization does not select a port")
            self._server = _make_server(Handler)
            self.port = int(self._server.server_address[1])
            assert_development_port(self.port)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
