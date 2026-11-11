"""M2b listener authorization on ephemeral loopback ports.

These tests do not bind ports 7865, 8765, or 8776 and do not pause Tailscale.
A passing run is not evidence that a browser loaded http://127.0.0.1:8765 and
called a listener on http://127.0.0.1:8776.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_lifecycle as life  # noqa: E402
import hq_forge_lifecycle_listener as gate  # noqa: E402
import importlib.util  # noqa: E402

_PUBLICATION_SPEC = importlib.util.spec_from_file_location(
    "m2b_publication",
    Path(__file__).with_name("m2b_publication.py"),
)
publication = importlib.util.module_from_spec(_PUBLICATION_SPEC)
_PUBLICATION_SPEC.loader.exec_module(publication)

EVIDENCE: list[dict] = []
ORPHANS: list[dict] = []
FORGE_BEFORE: int | None = None
PRODUCTION = Path(r"C:\Transfert\iphone_bridge.py")


def forge_listener_pid() -> int | None:
    output = subprocess.check_output(["netstat", "-ano", "-p", "tcp"], text=True, encoding="utf-8", errors="replace")
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[1].startswith("127.0.0.1:7860") and parts[3] == "LISTENING":
            return int(parts[4])
    return None


def port_open(port: int) -> bool:
    return life.loopback_open(port)


def note(test: str, **facts) -> None:
    EVIDENCE.append({"test": test, **facts})


def setUpModule() -> None:
    global FORGE_BEFORE
    FORGE_BEFORE = forge_listener_pid()


def tearDownModule() -> None:
    gate.reset_browser_binding_for_tests()
    after = forge_listener_pid()
    if after != FORGE_BEFORE:
        raise AssertionError(f"Forge listener changed: {FORGE_BEFORE} -> {after}")
    if port_open(8776):
        raise AssertionError("port 8776 is listening")
    if ORPHANS:
        raise AssertionError(f"sleeper left behind: {ORPHANS}")
    destination = os.environ.get("HQ_M2B_EVIDENCE")
    if destination:
        Path(destination).write_text(json.dumps({
            "production_pair_exercised": False,
            "listener_bound_to_8776": False,
            "page_bound_to_8765": False,
            "forge_listener_pid_before": FORGE_BEFORE,
            "forge_listener_pid_after": after,
            "cases": EVIDENCE,
        }, indent=2) + "\n", encoding="utf-8")


class Policy(unittest.TestCase):
    def tearDown(self) -> None:
        gate.reset_browser_binding_for_tests()

    def test_default_exception_is_only_the_localhost_probe(self) -> None:
        allowed = gate.content_security_policy("127.0.0.1:8765", "/lifecycle-probe")
        self.assertIn("connect-src 'self' http://127.0.0.1:8776", allowed)
        self.assertNotIn("*", allowed)
        ordinary = gate.content_security_policy("127.0.0.1:8765", "/")
        self.assertIn("connect-src 'self';", ordinary)
        self.assertNotIn("8776", ordinary)
        for host in ("192.168.1.20:8765", "localhost:8765", "vieuxpeepee.taila4d470.ts.net", "127.0.0.1:9100"):
            refused = gate.content_security_policy(host, "/lifecycle-probe")
            self.assertNotIn("8776", refused, host)
        self.assertTrue(gate.is_lifecycle_action_path("/lifecycle/start"))
        self.assertTrue(gate.is_lifecycle_action_path("/api/forge/lifecycle/start"))
        self.assertFalse(gate.is_lifecycle_action_path("/lifecycle-probe"))
        with self.assertRaises(RuntimeError):
            gate.assert_development_port(8776)
        with self.assertRaises(RuntimeError):
            gate.assert_development_port(8765)
        note("csp-default", production_pair_exercised=False)

    def test_ephemeral_binding_does_not_grant_a_lan_host(self) -> None:
        gate.set_browser_binding_for_tests("127.0.0.1:9100", "http://127.0.0.1:9101")
        granted = gate.content_security_policy("127.0.0.1:9100", "/lifecycle-probe")
        self.assertIn("http://127.0.0.1:9101", granted)
        self.assertNotIn("8776", granted)
        for host in ("192.168.1.20:9100", "vieuxpeepee.taila4d470.ts.net", "127.0.0.1:9102"):
            self.assertNotIn("9101", gate.content_security_policy(host, "/lifecycle-probe"), host)
        with self.assertRaises(RuntimeError):
            gate.set_browser_binding_for_tests("192.168.1.20:9100", "http://127.0.0.1:9101")
        note("csp-ephemeral", production_pair_exercised=False)


class Roles(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config_path = SOURCE / "bridge_config.json"
        cls.config_existed = cls.config_path.is_file()
        import iphone_bridge as bridge
        cls.bridge = bridge
        cls.sessions_dir = tempfile.TemporaryDirectory()
        bridge.SESSIONS_PATH = Path(cls.sessions_dir.name) / "bridge_sessions.json"
        bridge._SESSIONS.clear()
        bridge.CONFIG["pin"] = "m2b-disposable-pin"
        bridge.CONFIG["users"] = []

    @classmethod
    def tearDownClass(cls) -> None:
        cls.bridge.SESSIONS_PATH = SOURCE / "bridge_sessions.json"
        cls.bridge._SESSIONS.clear()
        cls.sessions_dir.cleanup()
        if not cls.config_existed and cls.config_path.is_file() and cls.config_path.parent == SOURCE:
            cls.config_path.unlink()

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.sessions = self.root / "bridge_sessions.json"
        self.bridge.SESSIONS_PATH = self.sessions
        self.bridge._SESSIONS.clear()
        self.nonce = uuid.uuid4().hex[:12]
        self.generation = self.bridge.auth_generation()
        self.hq_creation = life.process_creation(os.getpid())
        self.supervisor = life.Supervisor(
            self.root,
            f"Local\\TransfertHQ-M1-{self.nonce}",
            f"Local\\TransfertHQ-M1-Mutex-{self.nonce}",
        )
        self.listener = None
        self.tracked: list[tuple[int, int, str]] = []

    def tearDown(self) -> None:
        if self.listener is not None:
            self.listener.close()
        self.supervisor.terminate_if_proven()
        path = self.root / "lifecycle.json"
        if path.is_file():
            record = json.loads(path.read_text(encoding="utf-8"))
            if "pid" in record and "creation" in record:
                outcome = life.harness_stop(int(record["pid"]), int(record["creation"]), "cmd.exe")
                if outcome not in {"stopped-by-harness", "already-gone"}:
                    ORPHANS.append({"pid": record["pid"], "outcome": outcome})
        self.supervisor.close_supervisor_handles()
        self.tmp.cleanup()

    def start_listener(self, *, pid: int | None = None, creation: int | None = None, origin: str = "http://127.0.0.1:8765") -> None:
        self.listener = gate.LifecycleListener(
            self.supervisor,
            origin,
            self.sessions,
            self.generation,
            os.getpid() if pid is None else pid,
            self.hq_creation if creation is None else creation,
            lambda: "ready",
        )
        self.assertNotIn(self.listener.port, gate.RESERVED_PORTS)

    def write_sessions(self, records: dict) -> None:
        self.sessions.write_text(json.dumps(records), encoding="utf-8")

    def bound_csrf(self, token: str, *, credential_exp: int | None = None) -> str:
        before = self.sessions.read_bytes()
        if credential_exp is None:
            minted = gate.mint_csrf_for_session(self.sessions, token)
        else:
            info = json.loads(before.decode("utf-8"))[token]
            minted = gate.mint_csrf(
                token,
                int(info["gen"]),
                float(info["exp"]),
                gate.ensure_csrf_key(self.sessions),
                credential_exp=credential_exp,
            )
        if self.sessions.read_bytes() != before:
            raise AssertionError("csrf mint rewrote the session file")
        if not minted:
            raise AssertionError("csrf mint failed")
        return minted

    def exchange(
        self,
        token: str,
        *,
        origin: str = "http://127.0.0.1:8765",
        host: str | None = None,
        body: bytes = b"{}",
        content_type: str = "application/json",
        method: str = "POST",
        path: str = "/lifecycle/start",
        extra: dict | None = None,
        csrf: str | None = None,
        send_csrf: bool = True,
        cookie: bool = True,
    ) -> tuple[int, bytes, str]:
        headers = {"Origin": origin, "Content-Type": content_type}
        if cookie:
            headers["Cookie"] = f"transfert_session={token}"
        if send_csrf:
            headers[gate.CSRF_HEADER] = self.bound_csrf(token) if csrf is None else csrf
        if host is not None:
            headers["Host"] = host
        if extra:
            headers.update(extra)
        request = Request(
            f"http://127.0.0.1:{self.listener.port}{path}",
            data=body,
            method=method,
            headers=headers,
        )
        try:
            with urlopen(request, timeout=10) as response:
                return response.status, response.read(), str(response.headers)
        except HTTPError as exc:
            return exc.code, exc.read(), str(exc.headers)

    def post(self, token: str, **kwargs) -> int:
        return self.exchange(token, **kwargs)[0]

    def test_raw_role_table_and_legacy_helper(self) -> None:
        exp = time.time() + 3600
        base = {"exp": exp, "user": "admin", "gen": self.generation}
        cases = {
            "missing": {key: value for key, value in base.items()},
            "null": {**base, "role": None},
            "number": {**base, "role": 1},
            "bool": {**base, "role": True},
            "empty": {**base, "role": ""},
            "upper": {**base, "role": "Admin"},
            "space": {**base, "role": "admin "},
            "upload": {**base, "role": "upload"},
            "operator": {**base, "role": "operator"},
        }
        payload = {name: info for name, info in cases.items()}
        self.write_sessions(payload)
        before = self.sessions.read_bytes()
        self.bridge.SESSIONS_PATH = self.sessions
        life.reload_persisted_sessions(self.bridge)
        self.assertEqual(self.bridge.session_role("operator"), "")
        self.assertEqual(self.bridge.session_role("missing"), "")
        self.assertEqual(self.sessions.read_bytes(), before)
        for name in cases:
            self.assertEqual(gate.classify_persisted_session(self.sessions, name, self.generation), "forbidden", name)
        self.assertEqual(self.sessions.read_bytes(), before)
        self.start_listener()
        for name in cases:
            status, body, calls = self.exchange(name)
            self.assertEqual(status, 403, name)
            self.assertEqual(body, b'{"error":"admin"}', name)
            self.assertNotIn(name.encode("utf-8"), body)
            self.assertEqual(self.sessions.read_bytes(), before)
            self.assertNotIn(name, calls)
        self.assertFalse((self.root / "lifecycle.json").is_file())
        dumped = json.dumps(self.listener.calls)
        self.assertNotIn("transfert_session=", dumped)
        for name in cases:
            self.assertNotIn(name, dumped)
        note("raw-role-table", refused=len(cases), legacy_operator_is_admin=False, file_preserved=True, production_pair_exercised=False)

    def test_exact_admin_revocation_generation_and_identity(self) -> None:
        token = self.bridge.issue_session("admin", "admin")
        before = self.sessions.read_bytes()
        self.assertEqual(gate.classify_persisted_session(self.sessions, token, self.generation), "admin")
        credential = self.bound_csrf(token)
        self.assertEqual(self.sessions.read_bytes(), before)
        self.start_listener()
        self.assertEqual(self.post(token, csrf=credential), 200)
        self.bridge.revoke_session(token)
        revoked = self.sessions.read_bytes()
        self.assertNotEqual(revoked, before)
        record_bytes = (self.root / "lifecycle.json").read_bytes()
        status, body, _headers = self.exchange(token, csrf=credential)
        self.assertEqual((status, body), (403, b'{"error":"csrf"}'))
        self.assertEqual(gate.authorize_action(self.sessions, token, credential, self.generation, gate.load_csrf_key(self.sessions)), "revoked")
        self.assertEqual(self.sessions.read_bytes(), revoked)
        self.assertEqual((self.root / "lifecycle.json").read_bytes(), record_bytes)
        self.assertEqual(self.exchange(token, cookie=False, csrf=credential)[0], 401)
        record = json.loads(record_bytes.decode("utf-8"))
        self.assertTrue(life.process_alive(int(record["pid"])))
        stale = {"stale": {"exp": time.time() + 3600, "user": "admin", "role": "admin", "gen": self.generation + 1}}
        self.write_sessions(stale)
        self.assertEqual(self.post("stale"), 401)
        self.listener.close()
        self.listener = None
        self.write_sessions({"admin-live": {"exp": time.time() + 3600, "user": "admin", "role": "admin", "gen": self.generation}})
        snapshot = self.sessions.read_bytes()
        self.start_listener(creation=1)
        self.assertEqual(self.post("admin-live"), 503)
        self.assertEqual(self.sessions.read_bytes(), snapshot)
        note("admin-revocation-identity", production_pair_exercised=False)

    def test_origin_host_csrf_and_body(self) -> None:
        self.write_sessions({"admin-live": {"exp": time.time() + 3600, "user": "admin", "role": "admin", "gen": self.generation}})
        self.start_listener()
        token = "admin-live"
        self.assertEqual(self.post(token, origin=""), 403)
        self.assertEqual(self.post(token, origin="http://192.168.2.22:8765"), 403)
        self.assertEqual(self.post(token, origin="https://vieuxpeepee.taila4d470.ts.net"), 403)
        self.assertEqual(self.post(token, origin="http://localhost:8765"), 403)
        self.assertEqual(self.post(token, host="192.168.2.22:8765"), 403)
        self.assertEqual(self.post(token, host="vieuxpeepee.taila4d470.ts.net"), 403)
        self.assertEqual(self.post(token, extra={"Referer": "http://127.0.0.1:8765/lifecycle-probe"}, origin="", send_csrf=False), 403)
        self.assertEqual(self.post(token, body=b'{"executable":"C:\\\\Windows\\\\System32\\\\cmd.exe"}'), 400)
        self.assertEqual(self.post(token, content_type="text/plain"), 415)
        self.assertEqual(self.post(token, method="GET"), 405)
        self.assertFalse((self.root / "lifecycle.json").is_file())
        note("origin-host-body", production_pair_exercised=False)

    def test_session_bound_csrf_credential(self) -> None:
        source = Path(gate.__file__).read_text(encoding="utf-8")
        self.assertNotIn("session_role", source)
        self.assertNotIn("csrf_allowed_origins", source)
        with self.assertRaises(RuntimeError):
            gate.ensure_csrf_key(Path(r"C:\Transfert\bridge_sessions.json"))
        first = self.bridge.issue_session("admin", "admin")
        second = self.bridge.issue_session("other", "admin")
        before = self.sessions.read_bytes()
        valid = self.bound_csrf(first)
        other = self.bound_csrf(second)
        expired = self.bound_csrf(first, credential_exp=int(time.time()) - 5)
        self.assertEqual(self.sessions.read_bytes(), before)
        self.assertEqual(gate.assess_csrf(valid, first, gate.load_csrf_key(self.sessions))[0], "ok")
        self.assertEqual(gate.assess_csrf("", first, gate.load_csrf_key(self.sessions))[0], "missing")
        self.assertEqual(gate.assess_csrf("forged", first, gate.load_csrf_key(self.sessions))[0], "invalid")
        self.assertEqual(gate.assess_csrf(other, first, gate.load_csrf_key(self.sessions))[0], "wrong-session")
        self.assertEqual(gate.assess_csrf(expired, first, gate.load_csrf_key(self.sessions))[0], "expired")
        self.start_listener()
        status, body, headers = self.exchange(first, csrf=valid)
        self.assertEqual((status, body), (200, body))
        self.assertIn('"code"', body.decode("utf-8"))
        self.assertNotIn(valid, headers)
        self.assertNotIn(first, json.dumps(self.listener.calls))
        self.assertNotIn(valid, json.dumps(self.listener.calls))
        started = (self.root / "lifecycle.json").read_bytes()
        refusals = (
            {"send_csrf": False},
            {"csrf": "forged"},
            {"csrf": other},
            {"csrf": expired},
            {"csrf": valid, "extra": {"Referer": "http://127.0.0.1:8765/lifecycle-probe"}, "send_csrf": False},
            {"body": b'{"csrf":"v1.1.1.aa","executable":"C:\\\\Windows\\\\System32\\\\ping.exe"}', "csrf": valid},
        )
        for case in refusals:
            status, body, headers = self.exchange(first, **case)
            self.assertEqual(status, 403 if b"executable" not in case.get("body", b"") else 400)
            if status == 403:
                self.assertEqual(body, b'{"error":"csrf"}')
            self.assertNotIn("Access-Control-Allow-Origin: *", headers)
            self.assertEqual((self.root / "lifecycle.json").read_bytes(), started)
        foreign_status, foreign_body, foreign_headers = self.exchange(
            first,
            origin="http://192.168.2.22:8765",
            csrf=valid,
        )
        self.assertEqual((foreign_status, foreign_body), (403, b'{"error":"origin"}'))
        self.assertNotIn("Access-Control-Allow-Origin", foreign_headers)
        self.assertEqual(self.exchange("", cookie=False, csrf=valid)[0], 401)
        self.assertEqual((self.root / "lifecycle.json").read_bytes(), started)
        self.assertEqual(self.sessions.read_bytes(), before)
        note("session-csrf", missing=True, invalid=True, expired=True, wrong_session=True, revoked_covered_separately=True, production_pair_exercised=False)

    def test_preflight_is_exact(self) -> None:
        self.start_listener()
        port = self.listener.port

        def options(origin: str, method: str = "POST", headers: str = "content-type,x-hq-lifecycle-csrf", private: str = "", host: str | None = None) -> int:
            request_headers = {
                "Origin": origin,
                "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": headers,
            }
            if private:
                request_headers["Access-Control-Request-Private-Network"] = private
            if host is not None:
                request_headers["Host"] = host
            request = Request(f"http://127.0.0.1:{port}/lifecycle/start", method="OPTIONS", headers=request_headers)
            try:
                with urlopen(request, timeout=5) as response:
                    return response.status
            except HTTPError as exc:
                return exc.code

        self.assertEqual(options("http://127.0.0.1:8765"), 204)
        self.assertEqual(options("http://127.0.0.1:8765", headers="X-HQ-Lifecycle-CSRF, Content-Type"), 204)
        self.assertEqual(options("http://127.0.0.1:8765", headers="content-type"), 204)
        self.assertEqual(options("http://192.168.2.22:8765"), 403)
        self.assertEqual(options("https://vieuxpeepee.taila4d470.ts.net"), 403)
        self.assertEqual(options("http://127.0.0.1:8765", method="PUT"), 403)
        self.assertEqual(options("http://127.0.0.1:8765", headers="authorization"), 403)
        self.assertEqual(options("http://127.0.0.1:8765", headers="x-hq-lifecycle-csrf"), 403)
        self.assertEqual(options("http://127.0.0.1:8765", headers="content-type,x-hq-lifecycle-csrf,authorization"), 403)
        self.assertEqual(options("http://127.0.0.1:8765", host="10.1.1.1"), 403)
        self.assertEqual(options("http://10.1.1.1:8765", private="true"), 403)
        request = Request(
            f"http://127.0.0.1:{port}/lifecycle/start",
            method="OPTIONS",
            headers={
                "Origin": "http://127.0.0.1:8765",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-hq-lifecycle-csrf",
            },
        )
        with urlopen(request, timeout=5) as response:
            allow_headers = response.headers.get("Access-Control-Allow-Headers") or ""
            allow_origin = response.headers.get("Access-Control-Allow-Origin") or ""
        self.assertEqual(allow_origin, "http://127.0.0.1:8765")
        self.assertIn("X-HQ-Lifecycle-CSRF", allow_headers)
        self.assertNotIn("*", allow_origin)
        note("preflight", credential_header_permitted=True, content_type_alone_permitted=True, production_pair_exercised=False)


class SeparateProcess(unittest.TestCase):
    def test_operator_refusal_preserves_bytes_in_another_process(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        sessions = root / "bridge_sessions.json"
        payload = {"operator": {"exp": time.time() + 3600, "user": "admin", "role": "operator", "gen": 0}}
        sessions.write_text(json.dumps(payload), encoding="utf-8")
        before = sessions.read_bytes()
        credential = gate.mint_csrf_for_session(sessions, "operator")
        self.assertEqual(sessions.read_bytes(), before)
        self.assertTrue(credential)
        port_file = root / "port.txt"
        stderr_path = root / "listener.stderr"
        stderr_handle = stderr_path.open("wb", buffering=0)
        nonce = uuid.uuid4().hex[:12]
        creation = life.process_creation(os.getpid())
        proc = subprocess.Popen(
            [
                sys.executable,
                str(SOURCE / "tests" / "m2b_listener_worker.py"),
                str(sessions),
                str(root),
                "http://127.0.0.1:8765",
                "0",
                str(os.getpid()),
                str(creation),
                str(port_file),
                nonce,
            ],
            cwd=str(SOURCE),
            stderr=stderr_handle,
        )
        try:
            try:
                port = publication.wait_until_ready(port_file, publication.parse_port, proc, 10, stderr_path)
            except publication.PublicationError as exc:
                self.fail(f"listener publication {exc.code} exit={exc.returncode} stderr={exc.stderr[:500]}")
            self.assertNotIn(port, gate.RESERVED_PORTS)
            self.assertNotEqual(proc.pid, os.getpid())
            request = Request(
                f"http://127.0.0.1:{port}/lifecycle/start",
                data=b"{}",
                method="POST",
                headers={
                    "Origin": "http://127.0.0.1:8765",
                    "Content-Type": "application/json",
                    "Cookie": "transfert_session=operator",
                    gate.CSRF_HEADER: credential,
                },
            )
            try:
                with urlopen(request, timeout=10) as response:
                    status = response.status
                    body = response.read()
            except HTTPError as exc:
                status = exc.code
                body = exc.read()
            self.assertEqual(status, 403)
            self.assertEqual(body, b'{"error":"admin"}')
            self.assertEqual(sessions.read_bytes(), before)
            self.assertFalse((root / "lifecycle.json").is_file())
            note("cross-process-operator", listener_pid=proc.pid, port=port, production_pair_exercised=False)
        finally:
            proc.kill()
            proc.wait(5)
            stderr_handle.close()
            tmp.cleanup()


class PageServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config_path = SOURCE / "bridge_config.json"
        cls.config_existed = cls.config_path.is_file()
        import iphone_bridge as bridge
        from http.server import ThreadingHTTPServer
        cls.bridge = bridge
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
        cls.port = int(cls.server.server_address[1])
        if cls.port in gate.RESERVED_PORTS:
            cls.server.server_close()
            raise AssertionError("page server selected a reserved port")
        import threading
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        gate.reset_browser_binding_for_tests()
        if not cls.config_existed and cls.config_path.is_file() and cls.config_path.parent == SOURCE:
            cls.config_path.unlink()

    def request(self, path: str, method: str = "GET", host: str | None = None, cookie: str = "") -> tuple[int, str]:
        headers = {}
        if host is not None:
            headers["Host"] = host
        if cookie:
            headers["Cookie"] = cookie
        request = Request(f"http://127.0.0.1:{self.port}{path}", data=b"{}" if method == "POST" else None, method=method, headers=headers)
        try:
            with urlopen(request, timeout=10) as response:
                policy = response.headers.get("Content-Security-Policy") or ""
                return response.status, policy
        except HTTPError as exc:
            policy = exc.headers.get("Content-Security-Policy") or ""
            return exc.code, policy

    def test_page_server_has_no_action_and_scopes_csp(self) -> None:
        status, _policy = self.request("/lifecycle/start", "POST")
        self.assertEqual(status, 404)
        status, _policy = self.request("/api/forge/lifecycle/start", "POST")
        self.assertEqual(status, 404)
        status, policy = self.request("/lifecycle-probe", host="192.168.1.20:8765")
        self.assertEqual(status, 401)
        self.assertNotIn("8776", policy)
        status, policy = self.request("/lifecycle-probe", host="vieuxpeepee.taila4d470.ts.net")
        self.assertNotIn("8776", policy)
        status, policy = self.request("/lifecycle-probe", host="127.0.0.1:8765")
        self.assertIn("connect-src 'self' http://127.0.0.1:8776", policy)
        note("page-server", port=self.port, action_status=404, production_pair_exercised=False)


if __name__ == "__main__":
    unittest.main()
