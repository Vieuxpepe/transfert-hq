"""Pre-body POST refusals (CSRF 403, anonymous 401, upload-role 403) drain a small body instead of aborting.
Disposable root, fake PINs, mock Forge transport, raw sockets on an ephemeral port."""

from __future__ import annotations

import io
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr
from http.server import ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_diagnostics as D  # noqa: E402
import hq_forge as F  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import iphone_bridge as B  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))  # importable as tests.test_hq_refusal_drain too
from test_hq_forge_http import ADMIN_PIN, UPLOAD_PIN, Client  # noqa: E402

MARK = b"DRAINED-BODY-MARKER-7f3a"
PATH = "/api/forge/jobs/job-" + "0" * 24 + "/start-now"
LOGS: list[str] = []


class RefusalDrain(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="forge-drain-")
        cls.root = Path(cls.tmp) / "root"
        cls.root.mkdir()
        for name in ("Inbox", "Uni", "Print"):
            (cls.root / name).mkdir()
        shutil.copytree(SOURCE / "assets", cls.root / "assets")
        cls.saved = (B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH, dict(B.CONFIG), dict(B._DIAG_STATE))
        B.ROOT = cls.root
        B.SESSIONS_PATH = cls.root / "bridge_sessions.json"
        B.CONFIG_PATH = cls.root / "bridge_config.json"
        B.CONFIG_PATH.write_text("{}", encoding="utf-8")
        B.CONFIG.update({"pin": "", "users": [
            {"name": "admin-test", "pin": ADMIN_PIN, "role": "admin"},
            {"name": "upload-test", "pin": UPLOAD_PIN, "role": "upload"},
        ]})
        B.bind_cc_ext()
        B.bind_hq()
        D.ERRORS.clear_for_tests()
        B._DIAG_STATE.update(root=None, assets=None, last_probe=None)

        class Capture(B.Handler):  # real access-log formatting, captured instead of printed
            def log_message(self, fmt, *args):
                err = io.StringIO()
                with redirect_stderr(err):
                    B.Handler.log_message(self, fmt, *args)
                LOGS.append(err.getvalue())

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Capture)
        cls.port = cls.httpd.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.admin = Client(cls.base, ADMIN_PIN)
        cls.upload = Client(cls.base, UPLOAD_PIN)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        F.reset_for_tests()
        B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH = cls.saved[0], cls.saved[1], cls.saved[2]
        B.CONFIG.clear()
        B.CONFIG.update(cls.saved[3])
        B._DIAG_STATE.clear()
        B._DIAG_STATE.update(cls.saved[4])
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self) -> None:
        F.reset_for_tests()
        J.reset_for_tests()
        F.set_transport_for_tests(lambda method, url, timeout: (_ for _ in ()).throw(ConnectionRefusedError()))

    def tearDown(self) -> None:
        F.set_transport_for_tests(None)

    # helpers ---------------------------------------------------------------
    def cookie(self, client: Client) -> str:
        return "; ".join(f"{c.name}={c.value}" for c in client.jar)

    def head(self, length: str | None, extra: str = "", path: str = PATH) -> bytes:
        lines = [f"POST {path} HTTP/1.1", f"Host: 127.0.0.1:{self.port}", "Content-Type: application/json"]
        if length is not None:
            lines.append(f"Content-Length: {length}")
        if extra:
            lines.append(extra)
        return ("\r\n".join(lines) + "\r\n\r\n").encode()

    def response(self, sock: socket.socket) -> tuple[int, dict, bytes]:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        headers = {k.strip().lower(): v.strip() for k, _, v in (l.partition(":") for l in lines[1:])}
        n = int(headers.get("content-length", "0"))
        while len(rest) < n:
            chunk = sock.recv(65536)
            if not chunk:
                break
            rest += chunk
        return int(lines[0].split()[1]), headers, rest[:n]

    def closed(self, sock: socket.socket) -> bool:
        sock.settimeout(3)
        try:
            return sock.recv(1) == b""
        except (ConnectionResetError, ConnectionAbortedError):
            return True
        except socket.timeout:
            return False

    def conn(self) -> socket.socket:
        return socket.create_connection(("127.0.0.1", self.port), timeout=10)

    # tests -----------------------------------------------------------------
    def test_small_body_is_drained_and_connection_kept(self):
        body = b'{"x":"' + MARK + b'"}' + b" " * 4000
        with self.conn() as s:
            s.sendall(self.head(str(len(body))) + body)
            code, headers, _ = self.response(s)
            self.assertEqual(code, 401)
            # Since keep-alive landed, every POST reply carries "Connection: close" (parse_request closes after any
            # request with a body), so the header no longer tells a drained refusal apart; the clean close below does.
            # HTTP/1.0 handler: the server then closes; with the body drained that is a clean FIN, never a reset
            s.settimeout(3)
            self.assertEqual(s.recv(1), b"")

    def test_no_drain_and_close_for_large_missing_or_invalid_length(self):
        for length in (str(64 * 1024 + 1), "1000000", None, "abc", "-5", "1e3"):
            with self.subTest(length=length), self.conn() as s:
                t0 = time.monotonic()
                s.sendall(self.head(length))  # headers only: a drain would have to wait
                code, headers, _ = self.response(s)
                self.assertLess(time.monotonic() - t0, 1.0)
                self.assertEqual(code, 401)
                self.assertEqual(headers.get("connection", "").lower(), "close")
                self.assertTrue(self.closed(s))

    def test_exactly_64k_is_drained(self):
        body = b"a" * (64 * 1024)
        with self.conn() as s:
            s.sendall(self.head(str(len(body))) + body)
            code, headers, _ = self.response(s)
            self.assertEqual(code, 401)
            # Since keep-alive landed, every POST reply carries "Connection: close" (parse_request closes after any
            # request with a body), so the header no longer tells a drained refusal apart; the clean close below does.

    def test_slow_sender_is_time_boxed(self):
        with self.conn() as s:
            t0 = time.monotonic()
            s.sendall(self.head("1000") + b"{" + MARK)  # then stall
            code, headers, _ = self.response(s)
            elapsed = time.monotonic() - t0
            self.assertEqual(code, 401)
            self.assertLess(elapsed, 2.5)
            self.assertGreater(elapsed, 1.0)
            self.assertEqual(headers.get("connection", "").lower(), "close")
            self.assertTrue(self.closed(s))

    def test_status_codes_unchanged(self):
        body = b'{"state": "keep"}'
        anon_cookie = ""
        with self.conn() as s:
            s.sendall(self.head(str(len(body))) + body)
            self.assertEqual(self.response(s)[0], 401)
        with self.conn() as s:
            s.sendall(self.head(str(len(body)), f"Cookie: {self.cookie(self.upload)}\r\nOrigin: {self.base}") + body)
            self.assertEqual(self.response(s)[0], 403)
        with self.conn() as s:
            s.sendall(self.head(str(len(body)), f"Cookie: {self.cookie(self.admin)}\r\nOrigin: http://evil.example") + body)
            code, _, payload = self.response(s)
            self.assertEqual(code, 403)
            self.assertIn("CSRF", payload.decode("utf-8"))
        # accepted authenticated request still reads its body as today
        with self.conn() as s:
            s.sendall(self.head(str(len(body)), f"Cookie: {self.cookie(self.admin)}\r\nOrigin: {self.base}") + body)
            self.assertEqual(self.response(s)[0], 404)
        self.assertEqual(self.upload.req(PATH, "POST", body)[0], 403)
        self.assertEqual(self.admin.req(PATH, "POST", body, {"Origin": "http://evil.example"}, origin=False)[0], 403)
        self.assertEqual(anon_cookie, "")

    def test_drained_bytes_never_logged(self):
        LOGS.clear()
        D.ERRORS.clear_for_tests()
        err = io.StringIO()
        with redirect_stderr(err):
            for extra in ("", f"Cookie: {self.cookie(self.upload)}\r\nOrigin: {self.base}",
                          f"Cookie: {self.cookie(self.admin)}\r\nOrigin: http://evil.example"):
                body = b'{"p":"' + MARK + b'"}'
                with self.conn() as s:
                    s.sendall(self.head(str(len(body)), extra) + body)
                    self.assertIn(self.response(s)[0], (401, 403))
            with self.conn() as s:
                s.sendall(self.head("1000") + MARK)
                self.response(s)
        time.sleep(0.2)
        blob = "".join(LOGS) + err.getvalue() + repr(D.ERRORS.__dict__)
        self.assertTrue(LOGS)
        self.assertNotIn(MARK.decode(), blob)


if __name__ == "__main__":
    unittest.main()
