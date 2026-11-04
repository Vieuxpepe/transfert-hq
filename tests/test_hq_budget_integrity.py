"""Fail-closed budget persistence, process races, clock changes and caching."""
import json
import subprocess
import sys
import time
import random
from pathlib import Path
from unittest.mock import patch

import hq_ai as ai
from tests.test_hq_ai import Base, DEV, reply

MODEL = "gemma-4-26b-a4b-it"


class IntegrityTests(Base):
    def stored(self, content):
        p = self.root / ai.STORE / ai.USAGE
        p.parent.mkdir(exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return p

    def payload(self):
        return "core", [{"role": "user", "parts": [{"text": "hello"}]}]

    def test_corrupt_store_never_grants_a_fresh_quota(self):
        malformed = ["{broken", "[]", '{"count": {}}',
            {"day": ai._today(), "count": {MODEL: -1}},
            {"day": ai._today(), "count": {}, "ambient": "0"},
            {"day": ai._today(), "count": {}, "token_window": {MODEL: [{}]}},
            {"day": ai._today(), "count": {}, "model_backoff_until": {MODEL: float("nan")}}]
        for content in malformed:
            with self.subTest(content=content):
                self.stored(content if isinstance(content, str) else json.dumps(content))
                with self.assertRaises(ai.AiError) as cm:
                    ai.generate((MODEL,), *self.payload())
                self.assertEqual(cm.exception.code, "quota_store_corrupt")
        self.assertFalse(self.calls)

    def test_failed_durable_reservation_sends_nothing(self):
        with patch.object(ai, "_save_usage", side_effect=OSError("disk full")):
            with self.assertRaises(ai.AiError) as cm:
                ai.generate((MODEL,), *self.payload())
        self.assertEqual(cm.exception.code, "quota_store_unavailable")
        self.assertFalse(self.calls)
        # The process lock is released even after a write failure.
        ai.generate((MODEL,), *self.payload())
        self.assertEqual(len(self.calls), 1)

    def test_clock_rollback_does_not_release_a_reservation(self):
        system, contents = self.payload()
        estimate = ai.estimate_context(system, contents)
        ai.bind(companion_context_config=lambda: {"model_input_tpm": {MODEL: ai.estimate_tokens(MODEL, estimate)}})
        ai.generate((MODEL,), system, contents, ambient=True)
        self.clock[0] -= 86400
        ai._minute.clear()
        self.assertFalse(ai.available(MODEL, 1))
        self.assertEqual(ai.ambient_used(), 1)
        self.assertEqual(ai.usage()["count"][MODEL], 1)

    def test_usage_cache_is_immutable_and_detects_external_changes(self):
        ai.generate((MODEL,), *self.payload())
        u = ai.usage()
        u["count"][MODEL] = 0
        self.assertEqual(ai.usage()["count"][MODEL], 1)
        p = ai._usage_path()
        ai._usage_cache.clear()
        original = Path.read_text
        reads = []
        def read(path, *args, **kwargs):
            if path == p:
                reads.append(path)
            return original(path, *args, **kwargs)
        with patch.object(Path, "read_text", read):
            for _ in range(30):
                ai.available(MODEL)
            self.assertEqual(len(reads), 1)
        p.write_text("invalid", encoding="utf-8")
        with self.assertRaises(ai.AiError):
            ai.available(MODEL)

    def test_send_boundary_rejects_oversized_or_unmetered_payloads(self):
        for contents in ([{"role": "user", "parts": [{"text": "x" * 5000}]}],
                         [{"role": "user", "parts": [{"inlineData": {"data": "abc"}}]}]):
            with self.assertRaises(ai.AiError):
                ai.generate((MODEL,), "core", contents, ambient=True)
        self.assertFalse(self.calls)

    def test_memory_not_lost_when_its_summary_was_omitted(self):
        ai.bind(companion_context_config=lambda: {"chat_input_budget": 512})
        _, contents, info = ai.build_companion_context("chat", "core", "latest", summary="Important preference. " + "x" * 1300,
            memories=["Important preference."])
        self.assertEqual(info["selected_memory_count"], 1)
        self.assertIn("Important preference.", contents[-1]["parts"][0]["text"])
        self.assertNotIn("RÉSUMÉ", contents[-1]["parts"][0]["text"])

    def test_known_store_disappearing_does_not_reset_capacity(self):
        ai.generate((MODEL,), *self.payload())
        ai._usage_path().unlink()
        with self.assertRaises(ai.AiError) as cm:
            ai.generate((MODEL,), *self.payload())
        self.assertEqual(cm.exception.code, "quota_store_missing")
        self.assertEqual(len(self.calls), 1)

    def test_nonfinite_and_boolean_configuration_uses_safe_defaults(self):
        for invalid in (float("inf"), float("nan"), True, False, 1.5, {}, None):
            ai.bind(companion_context_config=lambda: {"chat_input_budget": invalid, "chat_daily_limit": invalid,
                    "model_input_tpm": {MODEL: invalid}})
            self.assertEqual(ai.context_budget("chat"), 12000)
            self.assertEqual(ai.daily_limit("chat"), 1000)
            self.assertEqual(ai.model_tpm(MODEL), 16000)

    def test_randomized_context_boundaries_and_current_message_integrity(self):
        rng = random.Random(21)
        message = "Correction : je ne veux PAS perdre ceci 🙂\nDeuxième ligne."
        for _ in range(100):
            budget = rng.randint(512, 12000)
            ai.bind(companion_context_config=lambda: {"chat_input_budget": budget})
            history = [m for i in range(rng.randint(0, 40)) for m in (
                {"role": "user", "text": "École 🙂 " * rng.randint(1, 50)},
                {"role": "assistant", "text": "Réponse courte. " * rng.randint(1, 40)})]
            system, contents, info = ai.build_companion_context("chat", "Core instructions.", message, history=history,
                summary="Previous decisions. " * rng.randint(1, 60), memories=["I dislike coffee."], page="Current page. " * rng.randint(1, 100))
            self.assertLessEqual(ai.estimate_context(system, contents), budget)
            self.assertEqual(info["estimated_input_tokens"], ai.estimate_context(system, contents))
            self.assertTrue(contents[-1]["parts"][0]["text"].endswith(message))
            self.assertEqual((len(contents) - 1) % 2, 0)

    def test_malformed_provider_usage_cannot_release_capacity_or_break_json(self):
        status, data = reply("ok")
        data["usageMetadata"] = {"promptTokenCount": float("nan"), "totalTokenCount": True, "candidatesTokenCount": -1}
        self.answers = [(status, data)]
        result = ai.transferania_chat("bonjour", device_id=DEV)
        measured = result["context_usage"]["provider_usage"][0]
        self.assertNotIn("promptTokenCount", measured)
        self.assertNotIn("totalTokenCount", measured)
        self.assertNotIn("candidatesTokenCount", measured)
        self.assertTrue(json.dumps(result, allow_nan=False))
        row = ai.usage()["token_window"][ai.AMBIENT_CHAIN[0]][0]
        self.assertGreater(row["tokens"], 0)

    def test_separate_processes_cannot_double_spend_the_same_capacity(self):
        script = r'''
import sys, time
from pathlib import Path
import hq_ai as ai
root = Path(sys.argv[1])
contents = [{"role": "user", "parts": [{"text": "hello"}]}]
model = "gemma-4-26b-a4b-it"
ai.bind(root=root, key=lambda: "fake", companion_context_config=lambda: {"model_input_tpm": {model: ai.estimate_tokens(model, ai.estimate_context("core", contents))}},
    post=lambda *args: (200, {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}))
deadline = time.monotonic() + 10
while not (root / "start").exists() and time.monotonic() < deadline:
    time.sleep(.01)
try:
    ai.generate((model,), "core", contents)
    print("accepted")
except ai.AiError as error:
    print(error.code)
'''
        workers = [subprocess.Popen([sys.executable, "-c", script, str(self.root)], cwd=Path(ai.__file__).parent,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(6)]
        try:
            (self.root / "start").write_text("go")
            outputs = [worker.communicate(timeout=20) for worker in workers]
            for worker, (_, error) in zip(workers, outputs):
                self.assertEqual(worker.returncode, 0, error)
            accepted = [out.strip() for out, _ in outputs]
            self.assertEqual(accepted.count("accepted"), 1, accepted)
            self.assertEqual(ai.usage()["count"][MODEL], 1)
        finally:
            for worker in workers:
                if worker.poll() is None:
                    worker.kill()
                    worker.communicate()
