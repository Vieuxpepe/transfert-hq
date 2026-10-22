"""HQ must survive a burst of simultaneous connections (Tailscale Serve proxies the page's
~50 assets at once). Regression for the c89ac66 incident: backlog 5 -> resets -> 502 -> modules missing."""

from __future__ import annotations

import re
import socket
import sys
import threading
import time
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import iphone_bridge as B  # noqa: E402
from http.server import BaseHTTPRequestHandler  # noqa: E402


class Slow(BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(0.02)
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def burst(port: int, count: int) -> int:
    ok = []
    go = threading.Event()

    def one():
        go.wait()
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=10) as conn:
                conn.sendall(b"GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n")
                ok.append(conn.recv(16).startswith(b"HTTP/1."))
        except OSError:
            ok.append(False)

    threads = [threading.Thread(target=one) for _ in range(count)]
    for thread in threads:
        thread.start()
    time.sleep(0.2)
    go.set()
    for thread in threads:
        thread.join()
    return sum(ok)


class Backlog(unittest.TestCase):
    def test_server_class_has_a_real_backlog(self):
        self.assertGreaterEqual(B.HQServer.request_queue_size, 128)
        self.assertTrue(B.HQServer.daemon_threads)

    def test_main_uses_the_hq_server_class(self):
        text = (SOURCE / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertIn("server = HQServer((BIND_HOST, PORT), Handler)", text)
        self.assertIsNone(re.search(r"server = ThreadingHTTPServer\(\(BIND_HOST", text))

    def test_a_burst_of_simultaneous_connections_is_served(self):
        server = B.HQServer(("127.0.0.1", 0), Slow)
        port = server.server_address[1]
        self.assertNotIn(port, (8765, 8766, 8776, 7860))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            for _ in range(3):
                self.assertEqual(burst(port, 64), 64)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
