"""Embedding jobs on the voice worker: the HQ queue (hq_voice_remote.embed) and the worker's CPU embedding server."""
import argparse
import json
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_voice_remote as remote  # noqa: E402
import hq_voice_worker as worker  # noqa: E402
from tests.test_hq_voice_remote import Base, call  # noqa: E402


class EmbedTests(Base):
    """The embedding model on the worker PC (CPU): vectors for Carnet texts, never ahead of a sentence."""
    TEXTS = ["Le couple de serrage des vis M3", "Tightening torque for M3 screws"]

    def setUp(self):
        super().setUp()
        remote._embed_breaker.update(fails=0, until=0.0)

    def pair_embed(self):
        token = self.pair()
        call("poll", {"info": {"ready": True, "embed": True}}, token=token)
        return token

    def play(self, token, result):
        out = {}

        def go():
            status, data = call("poll", {"info": {"ready": True, "embed": True}}, token=token)
            out["job"] = data.get("job")
            if out["job"]:
                call("result/" + out["job"]["id"], result(out["job"]), token=token)
        thread = threading.Thread(target=go)
        thread.start()
        return thread, out

    def good(self, job):
        return {"ok": True, "vectors": [[0.1 * (i + 1)] * 12 for i, _t in enumerate(job["texts"])]}

    def voice_job(self, job_id, created):
        return {"id": job_id, "kind": "voice", "state": "queued", "created": created, "voice_stamp": 1,
                "payload": {"text": "x", "voice": "musica"}, "wav": None, "error": None}

    def test_vectors_come_back_in_order_and_the_job_carries_texts_only(self):
        token = self.pair_embed()
        thread, out = self.play(token, self.good)
        vectors = remote.embed(self.TEXTS, timeout=5)
        thread.join()
        self.assertEqual(len(vectors), 2)
        self.assertEqual((vectors[0][0], vectors[1][0]), (0.1, 0.2))
        self.assertEqual(out["job"]["kind"], "embed")
        self.assertEqual(out["job"]["texts"], self.TEXTS)
        self.assertEqual(set(out["job"]) - {"id", "kind", "voice_stamp", "texts"}, set())  # no path, no command
        self.assertTrue(remote.status()["embed"])

    def test_not_available_without_the_capability_or_with_bad_input(self):
        self.assertIsNone(remote.embed(self.TEXTS))
        token = self.pair()
        call("poll", {"info": {"ready": True}}, token=token)  # a worker without an embedding model
        self.assertFalse(remote.embed_ready())
        self.assertIsNone(remote.embed(self.TEXTS))
        self.pair_embed()
        for bad in ([], "text", [""], ["ok", "  "], [1], ["x"] * (remote.EMBED_MAX_TEXTS + 1)):
            self.assertIsNone(remote.embed(bad), bad)
        self.assertEqual(remote._jobs, {})

    def test_long_texts_are_cut(self):
        token = self.pair_embed()
        thread, out = self.play(token, self.good)
        remote.embed(["x" * 5000], timeout=5)
        thread.join()
        self.assertEqual(len(out["job"]["texts"][0]), remote.EMBED_MAX_CHARS)

    def test_a_malformed_answer_is_refused(self):
        token = self.pair_embed()
        bads = [{"ok": True, "vectors": [[0.1] * 12]},                         # one vector for two texts
                {"ok": True, "vectors": [[0.1] * 12, [0.1] * 11]},              # mixed dimensions
                {"ok": True, "vectors": [[0.1] * 12, [float("inf")] * 12]},     # not finite
                {"ok": True, "vectors": [[0.1] * 12, [True] * 12]},             # booleans are not numbers
                {"ok": True, "vectors": [[0.1] * 3, [0.1] * 3]},                # too short to be an embedding
                {"ok": True, "vectors": "no"}]
        for bad in bads:
            self.assertIsNone(remote._clean_vectors(bad["vectors"], 2), bad)
        self.assertIsNotNone(remote._clean_vectors([[0.1] * 12, [0.2] * 12], 2))
        thread, _out = self.play(token, lambda job: bads[1])  # through the real route: the job fails, nothing is returned
        self.assertIsNone(remote.embed(self.TEXTS, timeout=5))
        thread.join()
        self.assertEqual(remote.status()["last_error"], "vecteurs invalides")

    def test_voice_keeps_priority(self):
        token = self.pair_embed()
        remote._live["voice_last"] = time.time()  # a sentence was just asked for
        self.assertIsNone(remote.embed(self.TEXTS))  # batch indexing waits TEXT_QUIET
        remote._live["voice_last"] = time.time() - remote.EMBED_QUIET - 1
        thread, _out = self.play(token, self.good)
        self.assertIsNotNone(remote.embed(self.TEXTS, urgent=True, timeout=5))  # the owner's query only waits EMBED_QUIET
        thread.join()
        remote._jobs["v"] = self.voice_job("v", time.time())
        self.assertIsNone(remote.embed(self.TEXTS, urgent=True))  # a sentence is waiting: never queue behind it
        remote._jobs.clear()
        remote._jobs["e"] = {"id": "e", "kind": "embed", "state": "queued", "created": time.time() - 5, "voice_stamp": 0,
                             "payload": {"texts": self.TEXTS}, "vectors": None, "error": None}
        remote._jobs["w"] = self.voice_job("w", time.time())
        self.assertEqual(call("poll", {}, token=token)[1]["job"]["id"], "w")  # the sentence goes before the older embed job

    def test_the_embed_breaker_is_its_own(self):
        token = self.pair_embed()
        for _ in range(remote.BREAKER_FAILS):
            thread, _out = self.play(token, lambda job: {"ok": False, "error": "OOM"})
            self.assertIsNone(remote.embed(self.TEXTS, timeout=5))
            thread.join()
        self.assertFalse(remote.embed_ready())
        self.assertTrue(remote.available())  # the voice is untouched
        self.assertFalse(remote.status()["breaker_open"])


class WorkerEmbedTests(Base):
    def test_embed_job_starts_a_cpu_server_and_returns_ordered_vectors(self):
        class Emb(BaseHTTPRequestHandler):
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
                rows = [{"index": i, "embedding": [float(i)] * 8} for i in reversed(range(len(body["input"])))]  # out of order
                out = json.dumps({"data": rows}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Emb)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        args = argparse.Namespace(llm_server="llama-server.exe", embed_model="e.gguf", embed_port=server.server_address[1])
        self.assertTrue(worker.has_embed(args))
        self.assertFalse(worker.has_embed(argparse.Namespace(llm_server="x")))  # no model, no embed jobs
        fake = mock.Mock()
        fake.poll.return_value = None
        fake.pid = 4343
        with mock.patch.object(worker.subprocess, "Popen", return_value=fake) as popen, mock.patch.object(worker.subprocess, "run") as run:
            worker.STOP.clear()
            worker._emb.update(proc=None, last=0.0)
            vectors = worker.embed_texts(args, {"texts": ["a", "b", "c"]})
            self.assertEqual([v[0] for v in vectors], [0.0, 1.0, 2.0])  # back in the order of the texts
            cmd = popen.call_args[0][0]
            self.assertIn("--embedding", cmd)
            self.assertEqual(cmd[cmd.index("-ngl") + 1], "0")  # CPU only: never VRAM from Chatterbox
            self.assertIn("127.0.0.1", cmd)
            with self.assertRaises(RuntimeError):
                worker.embed_texts(args, {"texts": []})
            worker.stop_embed()
            self.assertIn("4343", run.call_args[0][0])


if __name__ == "__main__":
    unittest.main()
