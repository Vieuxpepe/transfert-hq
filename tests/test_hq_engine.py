"""Engine registry: probing, safe stop/start, log tail, HTTP routes. Uses throw-away loopback servers/processes only."""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import hq_engine as eng  # noqa: E402


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeHealth:
    """Tiny /health server on a free port; ``body`` / ``code`` are mutable."""

    def __init__(self, body=None, code=200, port=None):
        outer = self
        self.body, self.code = body if body is not None else {"ready": True}, code

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                raw = json.dumps(outer.body).encode()
                self.send_response(outer.code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *a):
                pass

        self.port = port or free_port()
        self.srv = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def launcher(port, calls=None):
    """A start hook that really brings a daemon up on ``port`` (after a short delay, like a model loading)."""
    made = []

    def start():
        if calls is not None:
            calls.append(1)
        threading.Timer(0.3, lambda: made.append(FakeHealth(port=port))).start()
        return False                      # real hooks answer "ready right now?": not yet

    start.made = made
    return start


class EngineBase(unittest.TestCase):
    def setUp(self):
        self._saved = dict(eng._registry)
        eng._registry.clear()
        eng.reset_events()
        eng._gpu_cache.update(at=time.time(), value=None)   # never shell out to nvidia-smi in tests

    def tearDown(self):
        eng._registry.clear()
        eng._registry.update(self._saved)


class ProbeTests(EngineBase):
    def test_down_when_nothing_listens(self):
        eng.register(eng.Daemon(id="a", label="A", description="", port=free_port()))
        card = eng.status()["daemons"][0]
        self.assertEqual(card["state"], "down")

    def test_ready_and_loading(self):
        fh = FakeHealth({"ready": True, "models": {"en": {}}})
        self.addCleanup(fh.close)
        eng.register(eng.Daemon(id="a", label="A", description="", port=fh.port,
                                details=lambda h: {"models": ",".join(h.get("models", {}))}))
        self.assertEqual(eng.probe(eng.get("a"))["state"], "ready")
        self.assertEqual(eng.probe(eng.get("a"))["details"]["models"], "en")
        fh.body = {"ready": False}
        self.assertEqual(eng.probe(eng.get("a"))["state"], "loading")

    def test_http_503_is_loading_not_down(self):
        fh = FakeHealth({"error": "not ready"}, code=503)
        self.addCleanup(fh.close)
        eng.register(eng.Daemon(id="a", label="A", description="", port=fh.port))
        self.assertEqual(eng.probe(eng.get("a"))["state"], "loading")

    def test_errors_without_ready_is_error_state(self):
        fh = FakeHealth({"ready": False, "errors": {"en": "model missing"}})
        self.addCleanup(fh.close)
        eng.register(eng.Daemon(id="a", label="A", description="", port=fh.port))
        card = eng.probe(eng.get("a"))
        self.assertEqual(card["state"], "error")
        self.assertIn("en", card["details"]["errors"])

    def test_one_broken_probe_does_not_break_the_list(self):
        eng.register(eng.Daemon(id="ok", label="Ok", description="", port=free_port()))
        eng.register(eng.Daemon(id="bad", label="Bad", description="", port=free_port(),
                                details=lambda h: 1 / 0))
        fh = FakeHealth()
        self.addCleanup(fh.close)
        eng.get("bad").port = fh.port
        cards = {c["id"]: c for c in eng.status()["daemons"]}
        self.assertEqual(set(cards), {"ok", "bad"})

    def test_self_process_card(self):
        eng.register(eng.Daemon(id="bridge", label="Bridge", description="", self_process=True, health_path=None))
        card = eng.status()["daemons"][0]
        self.assertEqual(card["state"], "ready")
        self.assertFalse(any(card["can"].values()))

    def test_summary_counts(self):
        fh = FakeHealth()
        self.addCleanup(fh.close)
        eng.register(eng.Daemon(id="a", label="A", description="", port=fh.port))
        eng.register(eng.Daemon(id="b", label="B", description="", port=free_port()))
        s = eng.status()["summary"]
        self.assertEqual((s["ready"], s["total"], s["problems"]), (1, 2, 0))

    def test_bad_ids_rejected(self):
        for bad in ("", "A", "../x", "a b", "x" * 40):
            with self.assertRaises(ValueError):
                eng.register(eng.Daemon(id=bad, label="x", description=""))


class ActionTests(EngineBase):
    def test_unknown_and_unsupported(self):
        eng.register(eng.Daemon(id="a", label="A", description="", observe_only=True))
        self.assertEqual(eng.act("nope", "start")[0], 404)
        self.assertEqual(eng.act("a", "start")[0], 409)
        self.assertEqual(eng.act("a", "stop")[0], 409)
        self.assertEqual(eng.act("a", "explode")[0] in (400, 409), True)

    def test_start_calls_hook_and_records_event(self):
        calls = []
        port = free_port()
        hook = launcher(port, calls)
        eng.register(eng.Daemon(id="a", label="A", description="", port=port, start=hook))
        code, out = eng.act("a", "start")
        self.addCleanup(lambda: [f.close() for f in hook.made])
        self.assertEqual((code, calls), (200, [1]))
        self.assertEqual(out["events"][0]["action"], "start")
        self.assertTrue(out["events"][0]["ok"])

    def test_start_is_noop_when_already_running(self):
        fh = FakeHealth()
        self.addCleanup(fh.close)
        calls = []
        eng.register(eng.Daemon(id="a", label="A", description="", port=fh.port, start=lambda: calls.append(1) or True))
        code, out = eng.act("a", "start")
        self.assertEqual((code, calls), (200, []))
        self.assertIn("already", out["message"])

    def test_failed_start_reports_500(self):
        old = eng.START_WAIT
        eng.START_WAIT = 0.5
        self.addCleanup(lambda: setattr(eng, "START_WAIT", old))
        eng.register(eng.Daemon(id="a", label="A", description="", port=free_port(), start=lambda: False))
        code, out = eng.act("a", "start")
        self.assertEqual(code, 500)
        self.assertFalse(out["ok"])

    def test_custom_stop_and_restart(self):
        state = {"up": True, "log": []}
        fh = FakeHealth()
        self.addCleanup(fh.close)

        def stop():
            state["log"].append("stop")
            fh.srv.shutdown()
            fh.srv.server_close()
            return True

        hook = launcher(fh.port)

        def start():
            state["log"].append("start")
            return hook()

        self.addCleanup(lambda: [f.close() for f in hook.made])
        eng.register(eng.Daemon(id="a", label="A", description="", port=fh.port, start=start, stop=stop))
        code, out = eng.act("a", "restart")
        self.assertEqual(state["log"], ["stop", "start"])
        self.assertEqual(code, 200)

    def test_generic_kill_stops_a_matching_process(self):
        port = free_port()
        script = (f"import http.server,socketserver\n# hq_engine_test_marker\n"
                  f"class H(http.server.BaseHTTPRequestHandler):\n"
                  f"    def do_GET(self):\n        self.send_response(200);self.end_headers();self.wfile.write(b'{{\"ready\":true}}')\n"
                  f"    def log_message(self,*a):pass\n"
                  f"http.server.HTTPServer(('127.0.0.1',{port}),H).serve_forever()\n")
        f = Path(tempfile.mkdtemp()) / "hq_engine_test_marker.py"
        f.write_text(script)
        proc = subprocess.Popen([sys.executable, str(f)])
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        for _ in range(50):
            if eng._port_open(port):
                break
            time.sleep(0.1)
        eng._owner_cache.clear()
        eng.register(eng.Daemon(id="a", label="A", description="", port=port, process_hint="hq_engine_test_marker"))
        self.assertEqual(eng.probe(eng.get("a"))["state"], "ready")
        code, out = eng.act("a", "stop")
        self.assertEqual(code, 200, out)
        for _ in range(30):
            if proc.poll() is not None:
                break
            time.sleep(0.1)
        self.assertIsNotNone(proc.poll())

    def test_foreign_process_is_never_killed(self):
        port = free_port()
        f = Path(tempfile.mkdtemp()) / "innocent.py"
        f.write_text(f"import http.server\nclass H(http.server.BaseHTTPRequestHandler):\n"
                     f"    def do_GET(self):\n        self.send_response(200);self.end_headers();self.wfile.write(b'{{}}')\n"
                     f"    def log_message(self,*a):pass\n"
                     f"http.server.HTTPServer(('127.0.0.1',{port}),H).serve_forever()\n")
        proc = subprocess.Popen([sys.executable, str(f)])
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        for _ in range(50):
            if eng._port_open(port):
                break
            time.sleep(0.1)
        eng._owner_cache.clear()
        eng.register(eng.Daemon(id="a", label="A", description="", port=port, process_hint="phonon_daemon"))
        self.assertEqual(eng.probe(eng.get("a"))["state"], "foreign")
        code, out = eng.act("a", "stop")
        self.assertEqual(code, 500)
        self.assertIsNone(proc.poll())                       # still alive

    def test_stop_unavailable_without_hint_or_hook(self):
        eng.register(eng.Daemon(id="a", label="A", description="", port=free_port(), start=lambda: True))
        self.assertEqual(eng.act("a", "stop")[0], 409)

    def test_events_ring_is_bounded(self):
        from collections import deque
        self.assertEqual(eng._events.maxlen, eng.EVENTS_MAX)
        eng._events = deque(maxlen=5)
        self.addCleanup(lambda: setattr(eng, "_events", deque(maxlen=eng.EVENTS_MAX)))
        for i in range(12):
            eng._event("a", "start", True, str(i))
        self.assertEqual(len(eng.status()["events"]), 5)
        self.assertEqual(eng.status()["events"][0]["message"], "11")     # newest first


class LogTests(EngineBase):
    def _daemon_with_log(self, text: str) -> str:
        f = Path(tempfile.mkdtemp()) / "d.log"
        f.write_text(text, encoding="utf-8")
        eng.register(eng.Daemon(id="a", label="A", description="", log_path=f))
        return "a"

    def test_tail_is_bounded_and_ordered(self):
        self._daemon_with_log("\n".join(f"line {i}" for i in range(1000)))
        code, out = eng.tail_log("a", 5)
        self.assertEqual(out["lines"], [f"line {i}" for i in range(995, 1000)])
        self.assertEqual(len(eng.tail_log("a", 10_000)[1]["lines"]), eng.LOG_TAIL_MAX_LINES)

    def test_secrets_are_scrubbed(self):
        self._daemon_with_log("loading api_key=sk-12345\nAuthorization: Bearer abc\nplain line\npassword = 'hunter2'\n")
        text = "\n".join(eng.tail_log("a", 20)[1]["lines"])
        for leaked in ("sk-12345", "hunter2"):
            self.assertNotIn(leaked, text)
        self.assertIn("plain line", text)

    def test_missing_log_file_is_empty_not_error(self):
        eng.register(eng.Daemon(id="a", label="A", description="", log_path=Path(tempfile.gettempdir()) / "nope-xyz.log"))
        code, out = eng.tail_log("a")
        self.assertEqual((code, out["lines"]), (200, []))

    def test_no_log_or_unknown(self):
        eng.register(eng.Daemon(id="a", label="A", description=""))
        self.assertEqual(eng.tail_log("a")[0], 404)
        self.assertEqual(eng.tail_log("zzz")[0], 404)

    def test_status_never_exposes_paths(self):
        f = Path(tempfile.mkdtemp()) / "secret_dir_name.log"
        f.write_text("x")
        eng.register(eng.Daemon(id="a", label="A", description="", log_path=f))
        self.assertNotIn("secret_dir_name", json.dumps(eng.status()))


class HttpTests(EngineBase):
    def test_routes(self):
        fh = FakeHealth()
        self.addCleanup(fh.close)
        eng.register(eng.Daemon(id="a", label="A", description="", port=fh.port, start=lambda: True))
        self.assertEqual(eng.http_get("/api/engine/status")[0], 200)
        self.assertEqual(eng.http_get("/api/engine/nope")[0], 404)
        self.assertEqual(eng.http_get("/api/engine/logs/../etc")[0], 404)
        self.assertEqual(eng.http_post("/api/engine/daemons/a/start")[0], 200)
        self.assertEqual(eng.http_post("/api/engine/daemons/a/destroy")[0], 404)
        self.assertEqual(eng.http_post("/api/engine/daemons/..%2f/start")[0], 404)

    def test_defaults_register_and_probe(self):
        eng._registry.clear()
        eng.register_defaults()
        ids = {d.id for d in eng.all_daemons()}
        self.assertTrue({"bridge", "phonon", "xtts", "forge"} <= ids)
        self.assertTrue(eng.get("forge").observe_only)
        self.assertFalse(eng.get("forge").can("stop"))
        self.assertTrue(all("state" in c for c in eng.status()["daemons"]))


if __name__ == "__main__":
    unittest.main()
