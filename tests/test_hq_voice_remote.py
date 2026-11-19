"""Musica's voice worker: pairing, auth, the job queue, fallbacks, and an end-to-end run of the real worker script."""
import argparse
import base64
import io
import json
import tempfile
import threading
import time
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import hq_music
import hq_voice_chatterbox as cb
import hq_voice_remote as remote
import hq_voice_worker as worker


def wav(seconds: float = 0.2) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * int(24000 * seconds))
    return buf.getvalue()


def call(route, data=None, token="", ip="100.1.1.1"):
    class Headers(dict):
        pass
    headers = Headers({"Authorization": "Bearer " + token} if token else {})
    return remote.handle_worker("POST", "/voice-worker/v1/" + route, headers, json.dumps(data or {}).encode(), ip)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(hq_music.reset_for_tests)
        hq_music.bind(root=self.tmp.name)
        remote._jobs.clear()
        remote._live.update(seen=0.0, info={}, busy=None, last_ms=None, last_error=None, done=0, voice_last=0.0, text_done=0)
        remote._breaker.update(fails=0, until=0.0)
        remote._text_breaker.update(fails=0, until=0.0)
        remote._hits.clear()
        remote.POLL_WAIT = 0.4  # keep long polls short in tests
        self.addCleanup(setattr, remote, "POLL_WAIT", 8.0)

    def pair(self):
        code = remote.create_code()["code"]
        status, data = call("enroll", {"code": code, "name": "Portable", "info": {"gpu": "RTX 2060", "vram_mb": 6144, "ready": True}})
        self.assertEqual(status, 200, data)
        return f"{data['worker_id']}.{data['token']}"


class PairingTests(Base):
    def test_code_is_single_use_and_hashed(self):
        code = remote.create_code()["code"]
        raw = json.dumps(remote._state())
        self.assertNotIn(code.replace("-", ""), raw)  # only the hash is stored
        self.assertEqual(call("enroll", {"code": "AAAA-BBBB-CCCC"})[0], 403)
        status, data = call("enroll", {"code": code.lower(), "name": "  Mon   portable "})
        self.assertEqual(status, 200)
        self.assertEqual(remote.status()["name"], "Mon portable")
        self.assertNotIn(data["token"], json.dumps(remote._state()))  # the token itself is never stored
        self.assertEqual(call("enroll", {"code": code})[0], 403)  # used up

    def test_expired_code_and_rate_limit(self):
        remote.create_code()
        state = remote._state()
        state["code"]["expires"] = time.time() - 1
        remote._save(state)
        self.assertEqual(call("enroll", {"code": "x"})[0], 403)
        for _ in range(remote.ENROLL_MAX):
            call("enroll", {"code": "bad"}, ip="9.9.9.9")
        self.assertEqual(call("enroll", {"code": "bad"}, ip="9.9.9.9")[0], 429)

    def test_every_other_route_needs_the_token(self):
        token = self.pair()
        self.assertEqual(call("poll", {})[0], 401)
        self.assertEqual(call("poll", {}, token="vw_x." + "0" * 64)[0], 401)
        self.assertEqual(call("poll", {}, token=token.split(".")[0] + ".wrong")[0], 401)
        self.assertEqual(call("poll", {}, token=token)[0], 200)
        self.assertEqual(remote.handle_worker("GET", "/voice-worker/v1/poll", {}, b"", "x")[0], 405)
        self.assertEqual(call("nothing", {}, token=token)[0], 404)

    def test_remove_revokes_the_token(self):
        token = self.pair()
        remote.remove()
        self.assertEqual(call("poll", {}, token=token)[0], 401)
        self.assertFalse(remote.status()["paired"])


class QueueTests(Base):
    def run_worker_once(self, token, result):
        """Play the worker: claim the next job and answer it."""
        out = {}

        def go():
            status, data = call("poll", {"info": {"ready": True}}, token=token)
            out["job"] = data.get("job")
            if out["job"]:
                call("result/" + out["job"]["id"], result(out["job"]), token=token)
        thread = threading.Thread(target=go)
        thread.start()
        return thread, out

    def test_generate_returns_the_workers_audio(self):
        token = self.pair()
        thread, out = self.run_worker_once(token, lambda job: {"ok": True, "wav_b64": base64.b64encode(wav()).decode(), "ms": 1234})
        data = remote.generate({"text": "Hello Master", "voice": "musica", "exaggeration": 0.6, "cfg_weight": 0.4, "temperature": 0.8}, 7, 5)
        thread.join()
        self.assertEqual(data[:4], b"RIFF")
        self.assertEqual(out["job"]["text"], "Hello Master")
        self.assertEqual(out["job"]["voice_stamp"], 7)
        self.assertEqual(remote.status()["last_ms"], 1234)
        self.assertEqual(remote.status()["done"], 1)

    def test_not_available_without_pairing_or_when_off_or_offline(self):
        self.assertIsNone(remote.generate({"text": "x", "voice": "musica"}, 1, 1))
        token = self.pair()
        self.assertTrue(remote.available())
        remote.set_enabled(False)
        self.assertFalse(remote.available())
        remote.set_enabled(True)
        remote._live["seen"] = time.time() - 120
        self.assertFalse(remote.available())
        call("poll", {}, token=token)
        self.assertTrue(remote.available())
        with self.assertRaises(ValueError):
            remote.set_enabled("yes")

    def test_bad_voice_name_is_never_queued(self):
        self.pair()
        self.assertIsNone(remote.generate({"text": "x", "voice": "../secret"}, 1, 1))
        self.assertEqual(remote._jobs, {})

    def test_failure_and_timeout_fall_back_and_open_the_breaker(self):
        token = self.pair()
        thread, _ = self.run_worker_once(token, lambda job: {"ok": False, "error": "OOM"})
        self.assertIsNone(remote.generate({"text": "x", "voice": "musica"}, 1, 5))
        thread.join()
        self.assertEqual(remote.status()["last_error"], "OOM")
        remote._live["seen"] = time.time() - 24  # the worker stops polling: a queued job is not kept waiting for nothing
        t0 = time.monotonic()
        self.assertIsNone(remote.generate({"text": "x", "voice": "musica"}, 1, 0.1))
        self.assertLess(time.monotonic() - t0, 5.0)
        self.assertTrue(remote.status()["breaker_open"])
        self.assertFalse(remote.available())  # skipped for a minute: no more slow lines

    def test_the_timeout_runs_from_the_claim_not_from_the_queue(self):
        """A job queued behind a slow one still succeeds: only the worker's own time counts against it."""
        token = self.pair()
        done = []

        def worker():
            for delay in (2.4, 2.4):  # two jobs, each well inside the 3 s limit, back to back
                _, data = call("poll", {}, token=token)
                job = data.get("job")
                if not job:
                    _, data = call("poll", {}, token=token)
                    job = data.get("job")
                time.sleep(delay)
                call("result/" + job["id"], {"ok": True, "wav_b64": base64.b64encode(wav()).decode()}, token=token)
        thread = threading.Thread(target=worker)
        thread.start()
        results = []

        def ask():
            results.append(remote.generate({"text": "x", "voice": "musica"}, 1, 3))
        first = threading.Thread(target=ask)
        first.start()
        time.sleep(0.3)
        second = threading.Thread(target=ask)
        second.start()
        for t in (first, second, thread):
            t.join(timeout=20)
        self.assertEqual([r[:4] for r in results if r], [b"RIFF", b"RIFF"])  # the second waited ~4.5 s in total > 3 s

    def test_a_busy_worker_still_counts_as_online(self):
        token = self.pair()
        remote._live["seen"] = time.time() - 60
        self.assertFalse(remote.online())
        remote._live["busy"], remote._live["busy_since"] = "job", time.time() - 20  # synthesizing, so not polling
        self.assertTrue(remote.online())
        remote._live["busy_since"] = time.time() - 200  # but not forever
        self.assertFalse(remote.online())

    def test_non_ascii_credentials_are_refused_not_crashed(self):
        self.pair()
        status, _ = call("poll", {}, token="vw_\u00e9\u00e8." + "z")
        self.assertEqual(status, 401)

    def test_late_result_of_an_abandoned_job_is_ignored(self):
        token = self.pair()
        self.assertEqual(call("result/doesnotexist", {"ok": True, "wav_b64": "AAAA"}, token=token)[1], {"ok": False, "ignored": True})

    def test_result_must_be_a_wav(self):
        token = self.pair()
        results = {}

        def fake(job):
            return {"ok": True, "wav_b64": base64.b64encode(b"not a wav at all, just text" * 5).decode()}
        thread, _ = self.run_worker_once(token, fake)
        results["data"] = remote.generate({"text": "x", "voice": "musica"}, 1, 5)
        thread.join()
        self.assertIsNone(results["data"])

    def test_reference_voice_is_served_by_name_only(self):
        token = self.pair()
        voices = Path(self.tmp.name) / "voices"
        voices.mkdir()
        (voices / "musica.wav").write_bytes(wav())
        with mock.patch.object(cb, "VOICES_DIR", voices):
            status, data = call("voice/musica", {}, token=token)
            self.assertEqual(status, 200)
            self.assertEqual(base64.b64decode(data["wav_b64"])[:4], b"RIFF")
            self.assertEqual(call("voice/nobody", {}, token=token)[0], 404)
            big = Path(self.tmp.name) / "voices" / "long.wav"
            big.write_bytes(wav(1.0) + b"\x00" * 3_300_000)  # the real reference clip is about 3.2 MB
            self.assertEqual(call("voice/long", {}, token=token)[0], 200)
            self.assertEqual(call("voice/..%2Fx", {}, token=token)[0], 400)


class TextTests(Base):
    """The small LLM on the worker PC: text jobs, always behind the voice."""
    MSG = [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "Say hi."}]

    def pair_llm(self):
        token = self.pair()
        call("poll", {"info": {"ready": True, "llm": True}}, token=token)
        return token

    def play(self, token, result):
        out = {}

        def go():
            status, data = call("poll", {"info": {"ready": True, "llm": True}}, token=token)
            out["job"] = data.get("job")
            if out["job"]:
                call("result/" + out["job"]["id"], result(out["job"]), token=token)
        thread = threading.Thread(target=go)
        thread.start()
        return thread, out

    def test_text_goes_to_the_worker_and_back(self):
        token = self.pair_llm()
        thread, out = self.play(token, lambda job: {"ok": True, "text": "  Hi Master.  ", "ms": 900})
        text = remote.generate_text(self.MSG, temperature=0.6, max_tokens=999, timeout=5)
        thread.join()
        self.assertEqual(text, "Hi Master.")
        self.assertEqual(out["job"]["kind"], "text")
        self.assertEqual(out["job"]["max_tokens"], remote.TEXT_MAX_TOKENS)  # capped
        self.assertNotIn("voice", out["job"])  # a text job never names a voice, a path or a command
        self.assertEqual(remote.status()["text_done"], 1)
        self.assertEqual(remote.status()["done"], 0)  # the voice counters stay the voice's
        self.assertFalse(out["job"]["json"])
        thread, out = self.play(token, lambda job: {"ok": True, "text": "{}"})
        remote.generate_text(self.MSG, timeout=5, json_mode=True)
        thread.join()
        self.assertTrue(out["job"]["json"])  # the worker asks llama-server for valid JSON

    def test_no_text_without_a_worker_that_has_an_llm(self):
        self.assertIsNone(remote.generate_text(self.MSG))
        token = self.pair()
        call("poll", {"info": {"ready": True}}, token=token)  # an older worker: no "llm" flag
        self.assertFalse(remote.llm_ready())
        self.assertIsNone(remote.generate_text(self.MSG))
        self.assertEqual(remote._jobs, {})

    def test_messages_are_cleaned_and_a_user_turn_is_required(self):
        self.pair_llm()
        self.assertIsNone(remote.generate_text([{"role": "system", "content": "x"}]))
        self.assertIsNone(remote.generate_text([{"role": "tool", "content": "x"}, {"role": "user", "content": ""}]))
        self.assertIsNone(remote.generate_text([{"role": "user", "content": "x" * (remote.TEXT_MAX_CHARS + 1)}]))
        self.assertEqual(remote._jobs, {})

    def test_voice_keeps_the_gpu(self):
        token = self.pair_llm()
        remote._live["voice_last"] = time.time()  # a sentence was just asked for
        self.assertIsNone(remote.generate_text(self.MSG))
        remote._live["voice_last"] = time.time() - remote.TEXT_QUIET - 1
        remote._jobs["v"] = {"id": "v", "kind": "voice", "state": "queued", "created": time.time(), "voice_stamp": 1,
                             "payload": {"text": "x", "voice": "musica"}, "wav": None, "error": None}
        self.assertIsNone(remote.generate_text(self.MSG))  # a sentence is waiting: no text behind it
        remote._jobs.pop("v")
        # and when both are queued the sentence is claimed first
        now = time.time()
        remote._jobs["t"] = {"id": "t", "kind": "text", "state": "queued", "created": now - 5, "voice_stamp": 0,
                             "payload": {"messages": self.MSG}, "text": None, "error": None}
        remote._jobs["v"] = {"id": "v", "kind": "voice", "state": "queued", "created": now, "voice_stamp": 1,
                             "payload": {"text": "x", "voice": "musica"}, "wav": None, "error": None}
        self.assertEqual(call("poll", {}, token=token)[1]["job"]["id"], "v")
        self.assertEqual(call("poll", {}, token=token)[1]["job"]["id"], "t")

    def test_failures_open_a_text_breaker_that_leaves_the_voice_alone(self):
        token = self.pair_llm()
        for _ in range(remote.BREAKER_FAILS):
            thread, _ = self.play(token, lambda job: {"ok": False, "error": "llama-server s’est arrêté"})
            self.assertIsNone(remote.generate_text(self.MSG, timeout=5))
            thread.join()
        self.assertTrue(remote.status()["text_breaker_open"])
        self.assertFalse(remote.llm_ready())
        self.assertFalse(remote.status()["breaker_open"])  # the voice breaker is untouched
        self.assertTrue(remote.available())

    def test_an_empty_text_result_is_a_failure(self):
        token = self.pair_llm()
        thread, _ = self.play(token, lambda job: {"ok": True, "text": "   "})
        self.assertIsNone(remote.generate_text(self.MSG, timeout=5))
        thread.join()


class OfflineAlertTests(Base):
    def test_a_silent_worker_is_flagged_only_after_ten_minutes_and_only_when_it_matters(self):
        self.assertIsNone(remote.offline_alert())  # not paired
        token = self.pair()
        call("poll", {}, token=token)
        self.assertIsNone(remote.offline_alert())  # answering
        with mock.patch.object(remote, "_STARTED", time.time() - 3600):
            remote._live["seen"] = time.time() - 300
            self.assertIsNone(remote.offline_alert())  # 5 min: the laptop's task is still relaunching it
            remote._live["seen"] = time.time() - 700
            alert = remote.offline_alert()
            self.assertEqual(alert["name"], "Portable")
            self.assertGreaterEqual(alert["quiet_sec"], 700)
            remote.set_enabled(False)
            self.assertIsNone(remote.offline_alert())  # switched off on purpose: not an alert
            remote.set_enabled(True)
            remote._live.update(busy="job", busy_since=time.time())
            self.assertIsNone(remote.offline_alert())  # busy on a long job counts as alive

    def test_a_bridge_restart_does_not_raise_a_false_alarm(self):
        self.pair()
        remote._live["seen"] = 0.0  # what a restart leaves behind
        self.assertIsNone(remote.offline_alert())  # silence is counted from the bridge start
        with mock.patch.object(remote, "_STARTED", time.time() - 1200):
            self.assertIsNotNone(remote.offline_alert())


class WorkerTextTests(Base):
    def test_text_job_starts_the_llm_and_a_sentence_stops_it(self):
        replies = []

        class Llm(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                out = b'{"status":"ok"}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                replies.append(body)
                out = json.dumps({"choices": [{"message": {"content": " Salut, Maître. "}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Llm)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        args = argparse.Namespace(llm_server="llama-server.exe", llm_model="m.gguf", llm_port=server.server_address[1])
        self.assertTrue(worker.has_llm(args))
        self.assertFalse(worker.has_llm(argparse.Namespace()))  # an older command line: no text jobs
        fake = mock.Mock()
        fake.poll.return_value = None
        fake.pid = 4242
        with mock.patch.object(worker.subprocess, "Popen", return_value=fake) as popen,              mock.patch.object(worker.subprocess, "run") as run:
            worker.STOP.clear()  # an earlier test leaves it set
            worker._llm.update(proc=None, last=0.0)
            text = worker.complete(args, {"messages": [{"role": "user", "content": "hi"}], "temperature": 0.5, "max_tokens": 9999})
            self.assertEqual(text, "Salut, Maître.")
            self.assertEqual(replies[0]["max_tokens"], 400)  # the worker caps it too
            self.assertNotIn("response_format", replies[0])
            worker.complete(args, {"messages": [{"role": "user", "content": "hi"}], "json": True})
            self.assertEqual(replies[1]["response_format"], {"type": "json_object"})
            cmd = popen.call_args[0][0]
            self.assertIn("127.0.0.1", cmd)  # loopback only, nothing listens on the network
            self.assertEqual(cmd[cmd.index("-fitt") + 1], "3300")  # llama.cpp leaves VRAM for Chatterbox
            worker.stop_llm()  # idle, or --llm-exclusive and a sentence arrived
            self.assertIn("4242", run.call_args[0][0])
            self.assertIsNone(worker._llm["proc"])


class SynthPathTests(Base):
    def test_chatterbox_generate_tries_the_worker_then_the_local_daemon(self):
        with mock.patch.object(remote, "available", return_value=True), mock.patch.object(remote, "generate", return_value=b"RIFFxxxx") as gen, \
             mock.patch.object(cb, "voice_stamp", return_value=3):
            self.assertEqual(cb._generate("Hello there", "musica", "warm", 1.0, 90), b"RIFFxxxx")
            self.assertEqual(gen.call_args.args[1:], (3, 45.0))  # a worker never gets more than 45 s per sentence
        with mock.patch.object(remote, "available", return_value=True), mock.patch.object(remote, "generate", return_value=None), \
             mock.patch("urllib.request.urlopen", side_effect=OSError("daemon down")):
            self.assertIsNone(cb._generate("Hello there", "musica", "warm", 1.0, 5))  # both failed: the caller uses Phonon

    def test_synthesize_with_a_worker_never_wakes_the_local_gpu(self):
        out = Path(self.tmp.name) / "cache"
        with mock.patch.object(remote, "available", return_value=True), mock.patch.object(cb, "installed", return_value=False), \
             mock.patch.object(cb, "CACHE_DIR", out), mock.patch.object(cb, "has_voice", return_value=True), \
             mock.patch.object(cb, "start_daemon") as start, mock.patch.object(cb, "_generate", return_value=wav()), \
             mock.patch.object(cb, "_master", return_value=False):
            result = cb.synthesize("A short line for the show.", character="musica")
        self.assertTrue(result and result["ok"])
        start.assert_not_called()

    def test_weekly_recap_does_not_wake_the_local_gpu_when_a_worker_is_online(self):
        import hq_music_weekly as weekly
        with mock.patch.object(cb, "_remote_ok", return_value=True), mock.patch.object(cb, "installed", return_value=True), \
             mock.patch.object(cb, "daemon_ready", return_value=False), mock.patch.object(cb, "start_daemon") as start, \
             mock.patch.object(weekly, "_stage"):
            self.assertEqual(weekly._engine("en"), "chatterbox")
        start.assert_not_called()

    def test_dj_reports_chatterbox_when_a_worker_is_online(self):
        import hq_music_dj as dj
        with mock.patch.object(cb, "_remote_ok", return_value=True):
            self.assertEqual(dj.voice_engine_for("musica", "en", {"voice_engine": "auto"}, warm=False), "chatterbox")
        with mock.patch.object(cb, "_remote_ok", return_value=True):
            self.assertEqual(dj.voice_engine_for("musica", "fr", {"voice_engine": "auto"}, warm=False), "phonon")  # French stays on Phonon


class EndToEndTests(Base):
    """The real worker script against an in-process HQ endpoint and a fake Chatterbox daemon."""

    def serve(self, handler):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)  # cleanups run last-in first-out: shutdown, then close
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def test_worker_pairs_fetches_the_voice_and_synthesizes(self):
        voices_hq = Path(self.tmp.name) / "hq_voices"
        voices_hq.mkdir()
        (voices_hq / "musica.wav").write_bytes(wav(0.3))
        seen_requests = []

        class Hq(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                code, payload = remote.handle_worker("POST", self.path, self.headers, body, "127.0.0.1")
                seen_requests.append(self.path)
                out = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

        class Daemon(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                out = json.dumps({"ready": True, "device": "cuda"}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                out = wav(0.25)
                self.send_response(200)
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

        hq_port, daemon_port = self.serve(Hq), self.serve(Daemon)
        creds = Path(self.tmp.name) / "creds.json"
        root = Path(self.tmp.name) / "cb_root"
        code_file = Path(self.tmp.name) / "code.txt"
        code_file.write_text(remote.create_code()["code"])
        with mock.patch.object(worker, "CREDS", creds), mock.patch.object(worker, "protect"), mock.patch.object(worker, "gpu_info", return_value={"gpu": "RTX 2060", "vram_mb": 6144}), \
             mock.patch.object(cb, "VOICES_DIR", voices_hq):
            args = argparse.Namespace(hq=f"http://127.0.0.1:{hq_port}", name="Portable", code_file=str(code_file))
            self.assertEqual(worker.cmd_pair(args), 0)
            self.assertTrue(creds.is_file())
            self.assertTrue(remote.status()["paired"])
            run_args = argparse.Namespace(daemon_port=daemon_port, root=str(root), daemon_python=None, daemon_script=None)
            worker.STOP.clear()
            self.addCleanup(worker.STOP.set)
            thread = threading.Thread(target=worker.cmd_run, args=(run_args,), daemon=True)
            thread.start()
            deadline = time.time() + 10
            while not remote.online() and time.time() < deadline:
                time.sleep(0.05)
            self.assertTrue(remote.online())
            with mock.patch.object(cb, "voice_stamp", return_value=11):
                data = remote.generate({"text": "Hello Master, welcome back.", "voice": "musica", "exaggeration": 0.5,
                                        "cfg_weight": 0.5, "temperature": 0.8}, 11, 15)
            worker.STOP.set()
            thread.join(timeout=12)
        self.assertEqual((data or b"")[:4], b"RIFF")
        self.assertTrue((root / "voices" / "musica.wav").is_file())  # the reference came from HQ
        self.assertEqual((root / "voices" / "musica.stamp").read_text().strip(), "11")
        self.assertIn("/voice-worker/v1/voice/musica", seen_requests)


class BridgeWiringTests(unittest.TestCase):
    def test_bridge_routes_the_worker_prefix_before_any_cookie_or_csrf_check(self):
        src = (Path(__file__).resolve().parent.parent / "iphone_bridge.py").read_text(encoding="utf-8")
        post = src.index('if raw.startswith("/voice-worker/v1/"):\n            # Musica')
        self.assertLess(post, src.index("# CSRF for cookie sessions + /login", post))  # dispatched before the CSRF gate
        self.assertIn("hq_voice_remote.handle_worker", src)
        self.assertIn('raw.startswith("/engine-agent/v1/") or raw.startswith("/voice-worker/v1/")', src)  # GET answers 405


class AdminRouteTests(Base):
    def test_admin_routes(self):
        import hq_music_dj as dj
        self.assertEqual(dj.http_get("/api/musica/dj/voice-worker")[1]["paired"], False)
        status, body = dj.http_post("/api/musica/dj/voice-worker/code", {})
        self.assertEqual(status, 200)
        self.assertRegex(body["code"], r"^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$")
        self.pair()
        self.assertEqual(dj.http_post("/api/musica/dj/voice-worker/enable", {"enabled": False})[1]["enabled"], False)
        self.assertEqual(dj.http_post("/api/musica/dj/voice-worker/enable", {"enabled": "x"})[0], 400)
        self.assertEqual(dj.http_post("/api/musica/dj/voice-worker/nope", {})[0], 404)
        self.assertFalse(dj.http_post("/api/musica/dj/voice-worker/remove", {})[1]["paired"])
        self.assertIn("remote", dj.voice_status())


if __name__ == "__main__":
    unittest.main()
