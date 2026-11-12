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


class CheckTests(EngineBase):
    """Spotify / Google AI Studio / logins / music worker checks, with every outside world faked."""

    def _fake_spotify(self, running, connected, product="premium", configured=True):
        import types
        fake = types.SimpleNamespace(
            local_spotify_probe=lambda: {"spotify_desktop_running": running, "spotify_pids": [11, 12] if running else [],
                                         "spotify_install_path": "C:/x/Spotify.exe"},
            status=lambda: ({"connected": True, "display_name": "Ana", "product": product, "configured": True}
                            if connected else {"connected": False, "configured": configured}),
            wake_local_spotify=lambda wait_s=0: {"ok": True})
        saved = sys.modules.get("hq_spotify")
        sys.modules["hq_spotify"] = fake
        self.addCleanup(lambda: sys.modules.__setitem__("hq_spotify", saved) if saved else sys.modules.pop("hq_spotify", None))

    def test_spotify_states(self):
        self._fake_spotify(running=False, connected=True)
        self.assertEqual(eng.spotify_check()["state"], "down")
        self._fake_spotify(running=True, connected=True)
        r = eng.spotify_check()
        self.assertEqual((r["state"], r["facts"]["Application"], r["facts"]["Compte"]), ("ready", "ouverte", "Ana"))
        self._fake_spotify(running=True, connected=False)
        self.assertEqual(eng.spotify_check()["state"], "warn")
        self._fake_spotify(running=True, connected=True, product="free")
        self.assertIn("gratuite", eng.spotify_check()["note"])

    def test_spotify_card_offers_start_only(self):
        self._fake_spotify(running=False, connected=False)
        d = eng.Daemon(id="spotify", label="S", description="", kind="apps", check=eng.spotify_check, start=lambda: True)
        card = eng.probe(d)
        self.assertEqual(card["state"], "down")
        self.assertEqual(card["can"], {"start": True, "stop": False, "restart": False})

    def _gemini(self, keys, code, ms=120):
        old = (eng._gemini_keys, eng._gemini_ping)
        eng._gemini_keys = lambda: keys
        eng._gemini_ping = lambda k: {"code": code, "ms": ms}
        self.addCleanup(lambda: (setattr(eng, "_gemini_keys", old[0]), setattr(eng, "_gemini_ping", old[1])))

    def test_gemini_states_and_no_key_leak(self):
        cases = [([], None, "down"), (["sk-SECRET"], 200, "ready"), (["sk-SECRET"], 429, "warn"),
                 (["sk-SECRET"], 403, "error"), (["sk-SECRET"], 400, "error"), (["sk-SECRET"], 0, "warn"), (["sk-SECRET"], 500, "warn")]
        for keys, code, want in cases:
            self._gemini(keys, code)
            r = eng.gemini_check()
            self.assertEqual(r["state"], want, (code, r))
            self.assertNotIn("sk-SECRET", json.dumps(r))

    def test_gemini_ping_is_cached(self):
        import urllib.request
        calls = []

        class R:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        real = urllib.request.urlopen
        urllib.request.urlopen = lambda req, timeout=0: calls.append(req.get_header("X-goog-api-key")) or R()
        self.addCleanup(lambda: setattr(urllib.request, "urlopen", real))
        eng._gemini_cache.update(at=0.0, value=None)
        self.addCleanup(lambda: eng._gemini_cache.update(at=0.0, value=None))
        for _ in range(5):
            eng._gemini_ping("k")
        self.assertEqual(calls, ["k"])                           # key goes in a header, once

    def test_logins_rows_and_state(self):
        self._fake_spotify(running=True, connected=True)
        self._gemini(["k1", "k2"], 200)
        saved = (eng._hf_token_present, eng._cfg_file)
        eng._hf_token_present = lambda: False
        eng._cfg_file = lambda: {"pin": "123456", "discord_webhook_url": ""}
        self.addCleanup(lambda: (setattr(eng, "_hf_token_present", saved[0]), setattr(eng, "_cfg_file", saved[1])))
        r = eng.logins_check()
        rows = {x["label"]: x for x in r["rows"]}
        self.assertEqual(rows["Spotify"]["state"], "ok")
        self.assertIn("2 clé", rows["Google AI Studio"]["text"])
        self.assertEqual(rows["Hugging Face"]["state"], "warn")
        self.assertEqual(rows["Discord"]["state"], "off")
        self.assertEqual(r["state"], "warn")
        self.assertNotIn("123456", json.dumps(r))                # presence only, never the value
        eng._hf_token_present = lambda: True
        self.assertEqual(eng.logins_check()["state"], "ready")
        eng._cfg_file = lambda: {"pin": ""}
        self.assertEqual(eng.logins_check()["state"], "error")   # no PIN is a real problem

    def _music_env(self, venv=True):
        tmp = Path(tempfile.mkdtemp())
        ace = tmp / "ACE-Step-1.5"
        if venv:
            (ace / ".venv" / "Scripts").mkdir(parents=True)
            (ace / ".venv" / "Scripts" / "python.exe").write_text("")
        worker = tmp / "worker.py"
        worker.write_text(
            "initialize_service(config_path='acestep-v15-turbo', device='cuda', offload_to_cpu=True, offload_dit_to_cpu=True,"
            " quantization='int8_weight_only')\nlm.initialize(lm_model_path='acestep-5Hz-lm-0.6B', backend='pt', device='cuda')\n"
            "GenerationParams(inference_steps=8)\nGenerationConfig(batch_size=1)\n")
        saved = (eng.ACE_DIR, eng.WORKER_SCRIPT, eng.STUDIO_DIR)
        eng.ACE_DIR, eng.WORKER_SCRIPT, eng.STUDIO_DIR = ace, worker, tmp / "studio"
        self.addCleanup(lambda: (setattr(eng, "ACE_DIR", saved[0]), setattr(eng, "WORKER_SCRIPT", saved[1]),
                                 setattr(eng, "STUDIO_DIR", saved[2])))
        return tmp

    def _freeze_procs(self, rows):
        eng._ps_cache.update(at=time.time() + 1e6, rows=rows)
        self.addCleanup(lambda: eng._ps_cache.update(at=0.0, rows=[]))

    def test_music_settings_come_from_the_worker_script(self):
        self._music_env()
        self._freeze_procs([])
        r = eng.music_check()
        f = r["facts"]
        self.assertEqual(r["state"], "idle")
        self.assertEqual(f["DiT"], "acestep-v15-turbo · INT8")
        self.assertEqual(f["LM"], "acestep-5Hz-lm-0.6B · backend PyTorch")
        self.assertEqual((f["Appareil"], f["Étapes"], f["Lot"], f["Décharge"]), ("CUDA", 8, 1, "CPU + DiT"))

    def test_music_missing_env_and_busy(self):
        self._music_env(venv=False)
        self.assertEqual(eng.music_check()["state"], "error")
        self._music_env()
        self._freeze_procs([{"pid": 4321, "ppid": 1, "name": "python.exe",
                             "cmdline": "python hq_music_studio_worker.py x y", "private_mb": 5000, "started": None}])
        r = eng.music_check()
        self.assertEqual((r["state"], r["pid"]), ("busy", 4321))

    def test_music_last_job_and_log(self):
        tmp = self._music_env()
        self._freeze_procs([])
        job = tmp / "studio" / ("a" * 32)
        job.mkdir(parents=True)
        (job / "job.json").write_text("{}")
        (job / "result.json").write_text(json.dumps({"status": "completed", "elapsed_seconds": 127.4}))
        (job / "worker.log").write_text("generating...\napi_key=sk-ZZZ\n")
        f = eng.music_check()["facts"]
        self.assertEqual((f["Dernière création"], f["Durée de calcul"]), ("terminée", "127 s"))
        eng.register(eng.Daemon(id="m", label="M", description="", check=eng.music_check, log_path=eng._latest_worker_log, observe_only=True))
        code, out = eng.tail_log("m")
        self.assertEqual(code, 200)
        self.assertNotIn("sk-ZZZ", "\n".join(out["lines"]))

    def test_callable_log_without_file_is_empty_not_404(self):
        eng.register(eng.Daemon(id="m", label="M", description="", log_path=lambda: None))
        self.assertEqual(eng.tail_log("m")[0], 200)

    def test_summary_counts_idle_busy_as_healthy_and_warn_as_problem(self):
        for i, st in enumerate(("ready", "idle", "busy", "warn", "error", "down")):
            eng.register(eng.Daemon(id=f"c{i}", label=st, description="", check=(lambda s=st: {"state": s})))
        s = eng.status()["summary"]
        self.assertEqual((s["ready"], s["problems"], s["total"]), (3, 2, 6))

    @unittest.skipUnless(sys.platform == "win32", "PowerShell fallback is Windows only")
    def test_proc_table_fallback_without_psutil(self):
        saved = (eng.psutil, subprocess.run)
        self.addCleanup(lambda: (setattr(eng, "psutil", saved[0]), setattr(subprocess, "run", saved[1]), eng._ps_cache.update(at=0.0, rows=[])))
        eng.psutil = None
        eng._ps_cache.update(at=0.0, rows=[])
        rows = [{"p": 10, "pp": 1, "n": "python.exe", "c": "python phonon_daemon.py", "w": 100 * 1048576, "s": 1700000000},
                {"p": 11, "pp": 10, "n": "ffmpeg.exe", "c": "ffmpeg", "w": 50 * 1048576, "s": 1700000001}]

        class Done:
            stdout = json.dumps(rows)

        subprocess.run = lambda *a, **k: Done()
        self.assertEqual(eng._find_by_hint("phonon_daemon"), 10)
        info = eng._proc_info(10)
        self.assertEqual((info["rss_mb"], sorted(info["pids"])), (150, [10, 11]))     # parent + child
        eng._ps_cache.update(at=0.0, rows=[])
        Done.stdout = json.dumps(rows[0])                                              # PowerShell emits a bare object for one row
        self.assertEqual(len(eng._proc_table()), 1)


class AutoStopTests(EngineBase):
    """Idle auto-stop: policy validation/persistence, the quiet-period maths, and what the watcher may and may not stop."""

    def setUp(self):
        super().setUp()
        self._saved_state = (dict(eng._policy), dict(eng._last_used), dict(eng._ready_since), eng._policy_path)
        eng._policy.clear()
        eng._last_used.clear()
        eng._ready_since.clear()
        eng._policy_path = None
        self.addCleanup(self._restore)

    def _restore(self):
        eng.stop_watcher()
        eng._policy.clear()
        eng._policy.update(self._saved_state[0])
        eng._last_used.clear()
        eng._last_used.update(self._saved_state[1])
        eng._ready_since.clear()
        eng._ready_since.update(self._saved_state[2])
        eng._policy_path = self._saved_state[3]

    def _daemon(self, **kw):
        fh = FakeHealth(kw.pop("body", {"ready": True}))
        self.addCleanup(fh.close)
        stops = []

        def stop():
            stops.append(1)
            fh.srv.shutdown()
            fh.srv.server_close()
            return True

        spec = dict(id="a", label="A", description="", port=fh.port, idle_stop=True, stop=stop, process_hint="x", start=lambda: True)
        spec.update(kw)
        eng.register(eng.Daemon(**spec))
        return fh, stops

    # -- policy ---------------------------------------------------------------------------------------------------------
    def test_policy_validation(self):
        self._daemon()
        eng.register(eng.Daemon(id="plain", label="P", description="", port=free_port(), start=lambda: True, process_hint="x"))
        eng.register(eng.Daemon(id="obs", label="O", description="", port=free_port(), idle_stop=True, observe_only=True))
        self.assertEqual(eng.set_policy("nope", True, 10)[0], 404)
        self.assertEqual(eng.set_policy("plain", True, 10)[0], 409)          # does not support it
        self.assertEqual(eng.set_policy("obs", True, 10)[0], 409)            # observe-only daemons are never stopped
        self.assertEqual(eng.set_policy("a", "yes", 10)[0], 400)
        self.assertEqual(eng.set_policy("a", 1, 10)[0], 400)
        for bad in (0, 2, eng.IDLE_MAX + 1, -5, True, "10", 7.5):
            self.assertEqual(eng.set_policy("a", True, bad)[0], 400, bad)
        self.assertEqual(eng.set_policy("a", True, 10)[0], 200)
        self.assertEqual(eng.get_policy(eng.get("a")), {"enabled": True, "idle_min": 10})
        self.assertEqual(eng.set_policy("a", False, None)[1]["auto_stop"]["idle_min"], 10)   # keeps the chosen minutes

    def test_policy_is_off_by_default_with_the_daemons_suggested_minutes(self):
        self._daemon(idle_default_min=30)
        self.assertEqual(eng.get_policy(eng.get("a")), {"enabled": False, "idle_min": 30})

    def test_policy_persists_and_ignores_garbage(self):
        self._daemon()
        eng._policy_path = Path(tempfile.mkdtemp()) / ".hq-engine" / "autostop.json"
        eng.set_policy("a", True, 15)
        self.assertTrue(eng._policy_path.is_file())
        eng._policy.clear()
        eng._policy_load()
        self.assertEqual(eng.get_policy(eng.get("a")), {"enabled": True, "idle_min": 15})
        eng._policy_path.write_text(json.dumps({"a": {"enabled": "true", "idle_min": 99999}, "../x": {"enabled": True}, "b": 5}))
        eng._policy.clear()
        eng._policy_load()
        self.assertEqual(eng.get_policy(eng.get("a"))["enabled"], False)                      # only a real boolean enables
        self.assertEqual(eng.get_policy(eng.get("a"))["idle_min"], 15)                        # absurd minutes fall back to the default
        self.assertNotIn("../x", eng._policy)
        eng._policy_path.write_text("{not json")
        eng._policy_load()                                                                    # corrupt file: no crash, nothing enabled
        self.assertEqual(eng._policy, {})

    # -- the quiet-period maths -----------------------------------------------------------------------------------------
    def test_idle_info(self):
        self._daemon()
        self.assertEqual(eng.idle_info(eng.get("a"), "down"), {"enabled": False, "idle_min": 15, "choices": list(eng.IDLE_CHOICES)})
        eng.set_policy("a", True, 10)
        t0 = 1000.0
        eng._ready_since["a"], eng._last_used["a"] = t0, t0 + 100
        info = eng.idle_info(eng.get("a"), "ready", now=t0 + 160)
        self.assertEqual((info["idle_for_s"], info["stops_in_s"]), (60, 540))
        eng.register(eng.Daemon(id="plain", label="P", description=""))
        self.assertIsNone(eng.idle_info(eng.get("plain"), "ready"))

    def test_status_card_carries_the_block_only_when_supported(self):
        self._daemon()
        eng.register(eng.Daemon(id="plain", label="P", description="", port=free_port()))
        cards = {c["id"]: c for c in eng.status()["daemons"]}
        self.assertIn("auto_stop", cards["a"])
        self.assertNotIn("auto_stop", cards["plain"])

    # -- the watcher ----------------------------------------------------------------------------------------------------
    def test_stops_after_the_quiet_period_and_not_before(self):
        fh, stops = self._daemon()
        eng.set_policy("a", True, 5)
        eng._ready_since.clear()                                              # simulated clock: forget the real-time baseline
        eng._last_used.clear()
        t0 = time.time() + 1000
        self.assertEqual(eng.autostop_tick(now=t0), [])                       # first sight starts the quiet period
        self.assertEqual(eng.autostop_tick(now=t0 + 299), [])
        self.assertEqual(stops, [])
        self.assertEqual(eng.autostop_tick(now=t0 + 301), ["a"])
        self.assertEqual(stops, [1])
        ev = eng.status()["events"][0]
        self.assertEqual((ev["action"], ev["ok"]), ("autostop", True))
        self.assertIn("5 min", ev["message"])

    def test_a_request_resets_the_clock(self):
        fh, stops = self._daemon()
        eng.set_policy("a", True, 5)
        eng._ready_since.clear()                                              # simulated clock: forget the real-time baseline
        eng._last_used.clear()
        t0 = time.time() + 1000
        eng.autostop_tick(now=t0)
        eng._last_used["a"] = t0 + 250                                        # a request arrived
        self.assertEqual(eng.autostop_tick(now=t0 + 301), [])                 # 51 s since the request: still warm
        self.assertEqual(eng.autostop_tick(now=t0 + 250 + 301), ["a"])

    def test_disabled_policy_never_stops(self):
        fh, stops = self._daemon()
        t0 = time.time() + 1000
        eng.autostop_tick(now=t0)
        self.assertEqual(eng.autostop_tick(now=t0 + 10 ** 6), [])
        self.assertEqual(stops, [])

    def test_loading_daemon_is_never_stopped(self):
        fh, stops = self._daemon(body={"ready": False})
        eng.set_policy("a", True, 5)
        eng._ready_since.clear()                                              # simulated clock: forget the real-time baseline
        eng._last_used.clear()
        t0 = time.time() + 1000
        eng.autostop_tick(now=t0)
        self.assertEqual(eng.autostop_tick(now=t0 + 10 ** 6), [])
        self.assertEqual(stops, [])

    def test_down_daemon_resets_the_quiet_period(self):
        fh, stops = self._daemon()
        eng.set_policy("a", True, 5)
        eng._ready_since.clear()                                              # simulated clock: forget the real-time baseline
        eng._last_used.clear()
        t0 = time.time() + 1000
        eng.autostop_tick(now=t0)
        self.assertIn("a", eng._ready_since)
        fh.srv.shutdown()
        fh.srv.server_close()
        eng.autostop_tick(now=t0 + 10)
        self.assertNotIn("a", eng._ready_since)

    def test_never_touches_observe_only_self_or_unsupported(self):
        called = []
        for spec in (dict(id="obs", observe_only=True), dict(id="me", self_process=True), dict(id="plain", idle_stop=False)):
            fh = FakeHealth()
            self.addCleanup(fh.close)
            eng.register(eng.Daemon(label="x", description="", port=fh.port, idle_stop=spec.pop("idle_stop", True), process_hint="x",
                                    stop=lambda: called.append(1) or True, **spec))
            eng._policy[spec["id"]] = {"enabled": True, "idle_min": 5}
        eng.autostop_tick(now=time.time() + 10 ** 6)
        eng.autostop_tick(now=time.time() + 2 * 10 ** 6)
        self.assertEqual(called, [])

    def test_failed_stop_is_reported_and_retried(self):
        fh, _ = self._daemon(stop=lambda: False)
        eng.set_policy("a", True, 5)
        eng._ready_since.clear()                                              # simulated clock: forget the real-time baseline
        eng._last_used.clear()
        t0 = time.time() + 1000
        eng.autostop_tick(now=t0)
        self.assertEqual(eng.autostop_tick(now=t0 + 400), [])
        ev = eng.status()["events"][0]
        self.assertEqual((ev["action"], ev["ok"]), ("autostop", False))
        self.assertIn("a", eng._ready_since)                                   # still warm: it will be tried again

    def test_skipped_while_a_manual_action_holds_the_lock(self):
        fh, stops = self._daemon()
        eng.set_policy("a", True, 5)
        eng._ready_since.clear()                                              # simulated clock: forget the real-time baseline
        eng._last_used.clear()
        t0 = time.time() + 1000
        eng.autostop_tick(now=t0)
        lock = eng._action_locks["a"]
        lock.acquire()
        try:
            self.assertEqual(eng.autostop_tick(now=t0 + 400), [])
        finally:
            lock.release()
        self.assertEqual(stops, [])

    def test_manual_start_counts_as_use_and_stop_forgets_the_baseline(self):
        fh, stops = self._daemon()
        eng._ready_since["a"] = 1.0
        code, _ = eng.act("a", "start")                                        # already running: no-op, still counts as use
        self.assertEqual(code, 200)
        self.assertGreater(eng._last_used["a"], 1000)
        eng.act("a", "stop")
        self.assertNotIn("a", eng._ready_since)

    def test_touch_is_cheap_and_never_raises(self):
        eng.touch("whatever")
        eng.touch("")
        self.assertIn("whatever", eng._last_used)

    # -- HTTP + wiring --------------------------------------------------------------------------------------------------
    def test_route(self):
        self._daemon()
        code, out = eng.http_post("/api/engine/daemons/a/autostop", {"enabled": True, "idle_min": 30})
        self.assertEqual(code, 200)
        self.assertEqual((out["auto_stop"]["enabled"], out["auto_stop"]["idle_min"]), (True, 30))
        self.assertEqual(eng.http_post("/api/engine/daemons/a/autostop", {"enabled": True, "idle_min": 1})[0], 400)
        self.assertEqual(eng.http_post("/api/engine/daemons/a/autostop", {})[0], 400)
        self.assertEqual(eng.http_post("/api/engine/daemons/zzz/autostop", {"enabled": True})[0], 404)
        self.assertEqual(eng.http_post("/api/engine/daemons/a/autostop/x", {"enabled": True})[0], 404)

    def test_watcher_thread_stops_a_quiet_daemon_and_is_idempotent(self):
        fh, stops = self._daemon()
        eng._policy["a"] = {"enabled": True, "idle_min": 0.001}                 # ~0.06 s: bypasses validation on purpose
        old = eng.WATCH_EVERY
        eng.WATCH_EVERY = 0.1
        self.addCleanup(lambda: setattr(eng, "WATCH_EVERY", old))
        eng.start_watcher()
        first = eng._watcher["thread"]
        eng.start_watcher()
        self.assertIs(eng._watcher["thread"], first)
        for _ in range(40):
            if stops:
                break
            time.sleep(0.1)
        eng.stop_watcher()
        self.assertEqual(stops, [1])

    def test_bind_enables_policy_file_and_defaults_support_it(self):
        eng._registry.clear()
        eng.register_defaults()
        self.assertTrue(eng.get("phonon").idle_stop)
        self.assertTrue(eng.get("xtts").idle_stop)
        self.assertEqual((eng.get("phonon").idle_default_min, eng.get("xtts").idle_default_min), (30, 15))
        self.assertFalse(eng.get("forge").idle_stop)
        self.assertFalse(eng.get("bridge").idle_stop)

    def test_voice_engines_report_use(self):
        for name, key in (("hq_voice_phonon.py", "phonon"), ("hq_voice.py", "xtts")):
            src = (ROOT / name).read_text(encoding="utf-8")
            self.assertIn(f'hq_engine.touch("{key}")', src)


if __name__ == "__main__":
    unittest.main()
