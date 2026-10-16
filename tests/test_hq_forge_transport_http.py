"""Real loopback HTTP tests for the Forge client. No process on port 7860."""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge as F  # noqa: E402


def _ready(path: str) -> bytes:
    if path.startswith("/sdapi/v1/samplers"):
        body = [{"name": "Euler", "aliases": ["euler"]}]
    elif path.startswith("/sdapi/v1/schedulers"):
        body = [{"name": "automatic", "label": "Automatic"}]
    elif path.startswith("/sdapi/v1/sd-models"):
        body = [{"title": "example.safetensors [abcd]", "model_name": "example", "hash": "abcd", "sha256": None}]
    elif path.startswith("/sdapi/v1/progress"):
        body = {"progress": 0, "state": {"job": "", "job_count": 0}}
    elif path.startswith("/internal/pending-tasks"):
        body = {"size": 0, "tasks": []}
    elif path.startswith("/sdapi/v1/options"):
        body = {"sd_model_checkpoint": "example.safetensors"}
    else:
        body = {"unexpected": True}
    return json.dumps(body).encode("utf-8")


class _Quiet(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        return

    def _note(self) -> None:
        if not hasattr(self.server, "seen"):
            self.server.seen = []
        self.server.seen.append({
            "method": self.command,
            "path": self.path.split("?", 1)[0],
            "content_type": self.headers.get("Content-Type"),
            "accept": self.headers.get("Accept"),
        })

    def do_GET(self):
        self._note()
        mode = getattr(self.server, "mode", "ready")
        self.server.hits.append(self.path)
        if mode == "hang":
            time.sleep(3)
            return
        if mode == "slow_headers":
            time.sleep(2)
            mode = "ready"
        if mode == "badtype":
            payload = _ready(self.path)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if mode == "redirect":
            self.send_response(302)
            self.send_header("Location", getattr(self.server, "redirect_to", "/stolen"))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if mode == "malformed":
            payload = b"not-json"
        elif mode == "oversize":
            payload = b"{" + b" " * (F.MAX_RESPONSE_BYTES + 8)
        elif mode == "slow":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "8")
            self.end_headers()
            self.wfile.write(b"{")
            time.sleep(2)
            try:
                self.wfile.write(b'"x":1}')
            except OSError:
                return
            return
        else:
            payload = _ready(self.path)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send(self, status: int, payload: bytes, content_type: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        self._note()
        if not hasattr(self.server, "hits"):
            self.server.hits = []
        self.server.hits.append(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1024 * 1024:
            length = 1024 * 1024
        if length:
            self.rfile.read(length)
        mode = getattr(self.server, "mode", "ready")
        if mode == "hang":
            time.sleep(3)
            return
        if mode == "redirect":
            self.send_response(302)
            self.send_header("Location", getattr(self.server, "redirect_to", "/stolen"))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        accept = (self.headers.get("Accept") or "").lower()
        if content_type != "application/json" or "application/json" not in accept:
            self._send(415, b'{"detail":"media-type-rejected"}')
            return
        if mode == "http500":
            self._send(500, b'{"detail":"upstream-secret-body","prompt":"do-not-keep"}')
            return
        if mode == "malformed":
            self._send(200, b"not-json-SECRET")
            return
        if mode == "schema":
            self._send(200, b'{"images":12,"prompt":"do-not-keep"}')
            return
        if mode == "oversize":
            self._send(200, b"{" + b"x" * (F.MAX_SUBMIT_BYTES + 8))
            return
        self._send(200, b'{"images":["ok"],"info":"{}"}')


class TransportHttp(unittest.TestCase):
    def setUp(self) -> None:
        F.reset_for_tests()
        self.servers = []

    def tearDown(self) -> None:
        for server in self.servers:
            server.shutdown()
            server.server_close()
        F.reset_for_tests()
        for name in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
            os.environ.pop(name, None)

    def _serve(self, mode: str = "ready") -> str:
        server = ThreadingHTTPServer(("127.0.0.1", 0), _Quiet)
        server.mode = mode
        server.hits = []
        self.servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{server.server_address[1]}"
        F.set_upstream_for_tests(origin)
        return origin

    def test_redirect_is_not_followed(self):
        self._serve("redirect")
        other = ThreadingHTTPServer(("127.0.0.1", 0), _Quiet)
        other.mode = "ready"
        other.hits = []
        self.servers.append(other)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        self.servers[0].redirect_to = f"http://127.0.0.1:{other.server_address[1]}/stolen"
        got = F.status()
        self.assertEqual(got["forge"], "error")
        self.assertEqual(other.hits, [])
        self.assertTrue(self.servers[0].hits)
        self.assertNotIn("/stolen", self.servers[0].hits)

    def test_timeout_and_slow_body(self):
        F.set_probe_timeout_for_tests(0.3)
        self._serve("hang")
        started = time.monotonic()
        got = F.status()
        self.assertEqual(got["forge"], "error")
        self.assertEqual(got["code"], "forge_timeout")
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertNotIn("7860", got["message"])

        F.reset_for_tests()
        F.set_probe_timeout_for_tests(0.3)
        self._serve("slow")
        got = F.status()
        self.assertEqual(got["code"], "forge_timeout")

    def test_oversize_and_malformed_do_not_echo_the_body(self):
        self._serve("oversize")
        got = F.status()
        self.assertEqual(got["forge"], "error")
        self.assertNotIn(" " * 40, json.dumps(got))

        F.reset_for_tests()
        self._serve("malformed")
        got = F.status()
        self.assertEqual(got["forge"], "error")
        self.assertNotIn("not-json", json.dumps(got))

        F.reset_for_tests()
        self._serve("badtype")
        got = F.status()
        self.assertEqual(got["forge"], "error")
        self.assertNotIn("example.safetensors", json.dumps(got))

    def test_slow_headers_time_out(self):
        F.set_probe_timeout_for_tests(0.3)
        self._serve("slow_headers")
        started = time.monotonic()
        got = F.status()
        self.assertEqual(got["code"], "forge_timeout")
        self.assertLess(time.monotonic() - started, 2.0)

    def test_connection_refused(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        F.set_upstream_for_tests(f"http://127.0.0.1:{port}")
        got = F.status()
        self.assertEqual(got["forge"], "offline")
        self.assertNotIn(str(port), got["message"])

    def test_concurrent_status_polls(self):
        self._serve("ready")
        errors = []
        results = []

        def poll() -> None:
            try:
                results.append(F.status()["forge"])
            except Exception as exc:  # noqa: BLE001 - the test records it
                errors.append(exc)

        threads = [threading.Thread(target=poll) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
        self.assertEqual(errors, [])
        self.assertEqual(results, ["ready"] * 8)

    def test_environment_proxy_is_not_used(self):
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), _Quiet)
        proxy.mode = "ready"
        proxy.hits = []
        self.servers.append(proxy)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        os.environ["HTTP_PROXY"] = f"http://127.0.0.1:{proxy.server_address[1]}"
        os.environ["http_proxy"] = os.environ["HTTP_PROXY"]
        self._serve("ready")
        got = F.status()
        self.assertEqual(got["forge"], "ready")
        self.assertEqual(proxy.hits, [])
        self.assertTrue(self.servers[-1].hits)
        self.assertEqual(self.servers[-1].seen[-1]["accept"], "application/json")

    def test_txt2img_sends_json_and_rejects_the_wrong_type(self):
        origin = self._serve("ready")
        bare = urllib.request.Request(origin + "/sdapi/v1/txt2img", data=b"{}", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(bare, timeout=2)
        self.assertEqual(caught.exception.code, 415)
        wrong = urllib.request.Request(
            origin + "/sdapi/v1/txt2img",
            data=b"{}",
            method="POST",
            headers={"Content-Type": "text/plain", "Accept": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(wrong, timeout=2)
        self.assertEqual(caught.exception.code, 415)
        missing_accept = urllib.request.Request(
            origin + "/sdapi/v1/txt2img",
            data=b"{}",
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(missing_accept, timeout=2)
        self.assertEqual(caught.exception.code, 415)

        parsed = F.post_json("/sdapi/v1/txt2img", {"prompt": "local-only"}, timeout=2)
        self.assertEqual(parsed["images"], ["ok"])
        sent = self.servers[-1].seen[-1]
        self.assertEqual(sent["content_type"], "application/json")
        self.assertEqual(sent["accept"], "application/json")
        self.assertNotIn("local-only", json.dumps(sent))

    def test_post_failures_keep_status_without_the_body(self):
        self._serve("http500")
        with self.assertRaises(F._Probe) as caught:
            F.post_json("/sdapi/v1/txt2img", {"prompt": "hidden-prompt"}, timeout=2)
        self.assertEqual(caught.exception.code, "forge_http")
        self.assertEqual(caught.exception.http_status, 500)
        self.assertIsInstance(caught.exception.elapsed_ms, int)
        self.assertNotIn("upstream-secret-body", str(caught.exception))
        self.assertNotIn("hidden-prompt", str(caught.exception))

        F.reset_for_tests()
        self._serve("malformed")
        with self.assertRaises(F._Probe) as caught:
            F.post_json("/sdapi/v1/txt2img", {"prompt": "hidden-prompt"}, timeout=2)
        self.assertEqual(caught.exception.code, "forge_malformed")
        self.assertEqual(caught.exception.http_status, 200)
        self.assertNotIn("not-json-SECRET", str(caught.exception))

        F.reset_for_tests()
        self._serve("schema")
        with self.assertRaises(F._Probe) as caught:
            F.post_json("/sdapi/v1/txt2img", {"prompt": "hidden-prompt"}, timeout=2)
        self.assertEqual(caught.exception.code, "forge_schema")
        self.assertNotIn("do-not-keep", str(caught.exception))

        F.reset_for_tests()
        self._serve("oversize")
        with self.assertRaises(F._Probe) as caught:
            F.post_json("/sdapi/v1/txt2img", {"prompt": "hidden-prompt"}, timeout=2)
        self.assertEqual(caught.exception.code, "forge_error")
        self.assertNotIn("x" * 40, str(caught.exception))

        F.reset_for_tests()
        self._serve("hang")
        with self.assertRaises(F._Probe) as caught:
            F.post_json("/sdapi/v1/txt2img", {"prompt": "hidden-prompt"}, timeout=0.4)
        self.assertEqual(caught.exception.code, "forge_timeout")

        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        port = sock.getsockname()[1]

        def _drop() -> None:
            try:
                peer, _addr = sock.accept()
                peer.close()
            except OSError:
                return

        threading.Thread(target=_drop, daemon=True).start()
        F.reset_for_tests()
        F.set_upstream_for_tests(f"http://127.0.0.1:{port}")
        try:
            with self.assertRaises(F._Probe) as caught:
                F.post_json("/sdapi/v1/txt2img", {"prompt": "hidden-prompt"}, timeout=2)
        finally:
            sock.close()
        self.assertEqual(caught.exception.code, "forge_offline")
        self.assertIsNone(caught.exception.http_status)
        self.assertNotIn(str(port), str(caught.exception))

    def test_post_redirect_and_proxy_are_not_used(self):
        self._serve("redirect")
        other = ThreadingHTTPServer(("127.0.0.1", 0), _Quiet)
        other.mode = "ready"
        other.hits = []
        other.seen = []
        self.servers.append(other)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        self.servers[0].redirect_to = f"http://127.0.0.1:{other.server_address[1]}/stolen"
        with self.assertRaises(F._Probe) as caught:
            F.post_json("/sdapi/v1/txt2img", {"prompt": "hidden-prompt"}, timeout=2)
        self.assertEqual(caught.exception.code, "forge_http")
        self.assertEqual(caught.exception.http_status, 302)
        self.assertEqual(other.hits, [])

        proxy = ThreadingHTTPServer(("127.0.0.1", 0), _Quiet)
        proxy.mode = "ready"
        proxy.hits = []
        proxy.seen = []
        self.servers.append(proxy)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        os.environ["HTTP_PROXY"] = f"http://127.0.0.1:{proxy.server_address[1]}"
        os.environ["http_proxy"] = os.environ["HTTP_PROXY"]
        F.reset_for_tests()
        self._serve("ready")
        parsed = F.post_json("/sdapi/v1/txt2img", {"prompt": "hidden-prompt"}, timeout=2)
        self.assertEqual(parsed["images"], ["ok"])
        self.assertEqual(proxy.hits, [])


if __name__ == "__main__":
    unittest.main()
