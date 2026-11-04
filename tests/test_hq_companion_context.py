"""Context selection, storage continuity and API traffic with a fake provider."""
import json
import threading
from unittest.mock import patch

import hq_ai as ai
from tests.test_hq_ai import Base, DEV, DEV2, reply


class ContextTests(Base):
    def history(self, pairs=30, text="école 🙂 " * 80):
        return [m for i in range(pairs) for m in (
            {"role": "user", "text": f"{i}: {text}"},
            {"role": "assistant", "text": f"Réponse {i}: {text}"})]

    def test_whole_exchanges_and_current_message_survive(self):
        history = self.history()
        snapshot = json.dumps(history)
        for channel in ("chat", "ambient"):
            system, contents, info = ai.build_companion_context(channel, "Core facts and rules", "Mon message 🙂",
                history=history, summary="Ancienne décision", page=("digest répété " * 10000))
            self.assertLessEqual(ai.estimate_context(system, contents), ai.context_budget(channel))
            self.assertTrue(contents[-1]["parts"][0]["text"].endswith("Mon message 🙂"))
            self.assertEqual((len(contents) - 1) % 2, 0)
            self.assertGreater(info["omitted_history_count"], 0)
        self.assertEqual(json.dumps(history), snapshot)

    def test_core_too_large_fails_without_a_call(self):
        with self.assertRaises(ai.AiError) as cm:
            ai.build_companion_context("ambient", "x" * 5000, "message")
        self.assertEqual(cm.exception.code, "context_budget")
        self.assertFalse(self.calls)

    def test_preferences_keep_polarity_and_legacy_strings(self):
        data = ai._empty_transferania()
        ai.merge_thread_facts(data, "Je déteste le café. J'aime le thé.", "Compris.")
        self.assertIn("Je déteste le café", data["facts"])
        data["facts"] += ["Je préfère le café décaféiné", {"text": "Je préfère le thé vert"}]
        selected = ai.relevant_memories(data, "café et thé")
        self.assertIn("Je déteste le café", selected)
        self.assertLessEqual(len(selected), 5)
        self.assertFalse(ai.relevant_memories(data, "robot moteurs"))

    def test_sections_are_not_duplicated(self):
        _, contents, _ = ai.build_companion_context("chat", "core\n\ncore", "bonjour", summary="Je déteste le café",
            memories=["Je déteste le café", "Je déteste le café"], page="PAGE A\n\nPAGE A")
        text = contents[-1]["parts"][0]["text"]
        self.assertEqual(text.count("Je déteste le café"), 1)
        self.assertEqual(text.count("PAGE A"), 1)

    def test_summary_threshold_cooldown_and_retention(self):
        data = ai._empty_transferania()
        data["messages"] = self.history(7)
        ai.save_transferania(data, DEV)
        ai.refresh_companion_summary(data, DEV, "core", "current", "page")
        self.assertFalse(self.calls)
        data["messages"] = self.history(12, "courte phrase.")
        ai.save_transferania(data, DEV)
        ai.refresh_companion_summary(data, DEV, "core", "current", "page")
        self.assertFalse(self.calls, "below the byte budget")
        data["messages"] = self.history(12)
        ai.save_transferania(data, DEV)
        with patch.object(ai, "compress_with_llm", return_value="Décision : garder le contexte court.") as compress:
            data = ai.refresh_companion_summary(data, DEV, "core", "current", "page")
            self.assertEqual(compress.call_count, 1)
            self.assertEqual(data["summary_through"], 8)
            self.assertEqual(len(data["messages"]), 24)
            data["messages"] += self.history(7)
            ai.save_transferania(data, DEV)
            data = ai.refresh_companion_summary(data, DEV, "core", "current", "page")
            self.assertEqual(compress.call_count, 1)
            data["messages"] += self.history(1)
            ai.save_transferania(data, DEV)
            data = ai.refresh_companion_summary(data, DEV, "core", "current", "page")
            self.assertEqual(compress.call_count, 1, "15-minute model cooldown uses local summary")
            self.assertLessEqual(len(data["summary"]), 1400)
            self.assertEqual(len(data["messages"]), 40)

    def test_summary_failure_preserves_sources(self):
        data = ai._empty_transferania()
        data["messages"] = self.history(12)
        ai.save_transferania(data, DEV)
        with patch.object(ai, "compress_with_llm", side_effect=ai.AiError("unavailable")):
            result = ai.refresh_companion_summary(data, DEV, "core", "current", "page")
        self.assertEqual(result["messages"], data["messages"])
        self.assertTrue(result["summary"])

    def test_ambient_coalesces_latest_event_then_deduplicates(self):
        payload = {"device_id": DEV, "persona": "warm"}
        out = ai.ambient("accueil", "old event", **payload)
        self.assertEqual(out["retry_after"], 8)
        self.clock[0] += 3
        ai.ambient("projets", "latest event", **payload)
        self.clock[0] += 5
        out = ai.ambient("accueil", "old event", **payload)
        self.assertEqual(out["context_usage"]["provider_attempts"], 1)
        self.assertIn("latest event", json.dumps(self.calls[0][1]))
        self.assertTrue(ai.ambient("projets", "latest event", **payload)["skipped"])
        self.assertTrue(ai.ambient("forge", "different event", **payload)["skipped"])
        self.assertEqual(len(self.calls), 1)
        self.clock[0] += 121
        self.assertEqual(ai.ambient("projets", "latest event", **payload)["reason"], "duplicate")
        self.clock[0] += 180
        self.assertEqual(ai.ambient("projets", "latest event", **payload)["reason"], "coalescing")

    def test_manual_chat_bypasses_ambient_delay_and_reports_safe_usage(self):
        ai.ambient("accueil", device_id=DEV)
        status, data = reply("Salut.")
        data["usageMetadata"] = {"promptTokenCount": 300, "candidatesTokenCount": 12, "totalTokenCount": 312}
        self.answers = [(status, data)]
        out = ai.transferania_chat("PRIVATE MESSAGE", device_id=DEV)
        info = out["context_usage"]
        self.assertEqual(info["provider_usage"][0]["promptTokenCount"], 300)
        self.assertEqual(info["cost_status"], "unavailable")
        self.assertNotIn("PRIVATE MESSAGE", json.dumps(info))
        log = (self.root / ai.STORE / "context-usage.json").read_text()
        self.assertNotIn("PRIVATE MESSAGE", log)
        self.assertNotIn("test-key", log)

    def test_two_attempts_and_daily_quota_include_failures(self):
        self.answers = [(503, {}), (503, {}), reply("must not be used")]
        out = ai.transferania_chat("bonjour", device_id=DEV)
        self.assertTrue(out["fallback"])
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(ai.transferania_used(), 2)
        u = ai.usage()
        u["transferania"] = ai.TRANSFERANIA_DAILY - 1
        (self.root / ai.STORE / ai.USAGE).write_text(json.dumps(u))
        self.answers = [(503, {}), reply("no")]
        with self.assertRaises(ai.AiError):
            ai.transferania_chat("bonjour", device_id=DEV)
        self.assertEqual(ai.transferania_used(), ai.TRANSFERANIA_DAILY)
        self.assertEqual(len(self.calls), 3)

    def test_concurrent_chat_rejected_ambient_skipped_other_device_free(self):
        entered, release = threading.Event(), threading.Event()
        result = []
        def post(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return reply("ok")
        ai.bind(post=post)
        def chat():
            result.append(ai.transferania_chat("bonjour", device_id=DEV))
        thread = threading.Thread(target=chat)
        thread.start()
        try:
            self.assertTrue(entered.wait(5))
            with self.assertRaises(ai.AiError) as cm:
                ai.transferania_chat("encore", device_id=DEV)
            self.assertEqual(cm.exception.code, "companion_busy")
            self.assertEqual(ai.ambient("accueil", device_id=DEV)["reason"], "busy")
            self.assertEqual(ai.ambient("accueil", device_id=DEV2)["reason"], "coalescing")
        finally:
            release.set()
            thread.join(5)
        self.assertTrue(result)
        self.assertEqual(len(ai.load_transferania(DEV)["messages"]), 2)

    def test_log_is_bounded(self):
        for i in range(505):
            ai._write_context_usage({"reason": "test", "at": i, "private": "omit"})
        rows = json.loads((self.root / ai.STORE / "context-usage.json").read_text())
        self.assertEqual(len(rows), 500)
        self.assertNotIn("private", rows[-1])

    def test_configured_cost_and_input_budget(self):
        model = ai.AMBIENT_CHAIN[0]
        ai.bind(companion_context_config=lambda: {"chat_input_budget": 6000,
            "prices_per_million": {model: {"input": 1, "output": 2}}})
        status, data = reply("ok")
        data["usageMetadata"] = {"promptTokenCount": 100, "candidatesTokenCount": 20}
        self.answers = [(status, data)]
        out = ai.transferania_chat("bonjour", device_id=DEV)
        self.assertEqual(out["context_usage"]["input_budget"], 6000)
        self.assertAlmostEqual(out["context_usage"]["cost"], 0.00014)
        self.assertEqual(out["context_usage"]["cost_status"], "configured_estimate")

    def test_summary_provider_calls_use_quota_without_global_lock(self):
        data = ai._empty_transferania()
        data["messages"] = self.history(12, "Un message assez long. " * 30)
        ai.save_transferania(data, DEV)
        def post(*args):
            self.assertFalse(ai._lock._is_owned(), "network must not hold the global lock")
            self.calls.append(args)
            return reply("Préférence conservée et sujet à reprendre.")
        ai.bind(post=post)
        out = ai.transferania_chat("bonjour", device_id=DEV)
        self.assertEqual(out["context_usage"]["summary_calls"], 1)
        self.assertEqual(ai.transferania_used(), 2, "one summary plus one chat")
        self.assertEqual(out["context_usage"]["provider_attempts"], 2)
        self.assertEqual(len(ai.load_transferania(DEV)["messages"]), 26)
