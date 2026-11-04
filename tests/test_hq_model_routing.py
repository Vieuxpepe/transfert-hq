"""Project-wide input TPM reservations, background routing and local daily caps."""
import math
import json
import threading
from unittest.mock import patch

import hq_ai as ai
from tests.test_hq_ai import Base, DEV, reply

GEMMA = "gemma-4-26b-a4b-it"
LITE = "gemini-3.1-flash-lite"


class RoutingTests(Base):
    def payload(self, size=100):
        return "core", [{"role": "user", "parts": [{"text": "x" * size}]}]

    def configure_tpm(self, tokens):
        ai.bind(companion_context_config=lambda: {"model_input_tpm": {GEMMA: tokens}})

    def test_short_background_prefers_gemma_large_prefers_lite(self):
        for size, expected in ((100, GEMMA), (5000, LITE)):
            system, contents = self.payload(size)
            _, model = ai.generate(ai.AMBIENT_CHAIN, system, contents, background=True, transferania=True)
            self.assertEqual(model, expected)

    def test_normal_chat_stays_on_flash_lite(self):
        result = ai.transferania_chat("bonjour", device_id=DEV)
        self.assertEqual(result["model"], LITE)

    def test_gemma_tpm_exhaustion_falls_back_without_calling_it(self):
        system, contents = self.payload()
        estimate = ai.estimate_context(system, contents)
        self.configure_tpm(ai.estimate_tokens(GEMMA, estimate))
        ai.generate(ai.AMBIENT_CHAIN, system, contents, ambient=True)
        _, model = ai.generate(ai.AMBIENT_CHAIN, system, contents, ambient=True)
        self.assertEqual(model, LITE)
        self.assertEqual([call[0] for call in self.calls], [GEMMA, LITE])
        self.clock[0] += 60
        _, model = ai.generate(ai.AMBIENT_CHAIN, system, contents, ambient=True)
        self.assertEqual(model, GEMMA)

    def test_actual_usage_releases_reservation(self):
        system, contents = self.payload(900)
        estimate = ai.estimate_context(system, contents)
        self.configure_tpm(estimate + 100)
        status, data = reply("ok")
        data["usageMetadata"] = {"promptTokenCount": 100}
        self.answers = [(status, data)]
        ai.generate((GEMMA,), system, contents)
        self.assertTrue(ai.available(GEMMA, estimate))
        rows = ai.usage()["token_window"][GEMMA]
        self.assertEqual(rows[0]["tokens"], 100)

    def test_missing_usage_and_failed_calls_keep_reservation(self):
        system, contents = self.payload()
        self.configure_tpm(ai.estimate_tokens(GEMMA, ai.estimate_context(system, contents)))
        self.answers = [(503, {})]
        with self.assertRaises(ai.AiError):
            ai.generate((GEMMA,), system, contents)
        self.assertFalse(ai.available(GEMMA, 1))
        self.assertEqual(ai.usage()["count"][GEMMA], 1)

    def test_reservations_survive_process_minute_cache_reset(self):
        system, contents = self.payload()
        estimate = ai.estimate_context(system, contents)
        self.configure_tpm(ai.estimate_tokens(GEMMA, estimate))
        ai.generate((GEMMA,), system, contents)
        ai._minute.clear()
        self.assertFalse(ai.available(GEMMA, 1))

    def test_429_applies_persisted_cooldown_without_resetting_usage(self):
        system, contents = self.payload()
        self.answers = [(429, {}), reply("fallback")]
        _, model = ai.generate(ai.AMBIENT_CHAIN, system, contents, ambient=True)
        self.assertEqual(model, LITE)
        self.assertFalse(ai.available(GEMMA))
        ai._minute.clear()
        self.assertFalse(ai.available(GEMMA))
        self.clock[0] += 60
        self.assertTrue(ai.available(GEMMA))
        self.assertEqual(ai.usage()["count"][GEMMA], 1)

    def test_all_jobs_share_tpm_pool(self):
        system, contents = self.payload()
        estimate = ai.estimate_context(system, contents)
        self.configure_tpm(ai.estimate_tokens(GEMMA, estimate) * 2)
        ai.generate((GEMMA,), system, contents, ambient=True)
        ai.generate((GEMMA,), system, contents, transferania=True, background=True)
        with self.assertRaises(ai.AiError):
            ai.generate((GEMMA,), system, contents)
        self.assertEqual(len(self.calls), 2)

    def test_configurable_caps_and_status(self):
        ai.bind(companion_context_config=lambda: {"ambient_daily_limit": 1, "chat_daily_limit": 2})
        system, contents = self.payload()
        ai.generate((LITE,), system, contents, ambient=True)
        with self.assertRaises(ai.AiError):
            ai.generate((LITE,), system, contents, ambient=True)
        ai.generate((LITE,), system, contents, transferania=True)
        ai.generate((LITE,), system, contents, transferania=True)
        with self.assertRaises(ai.AiError):
            ai.generate((LITE,), system, contents, transferania=True)
        status = ai.status()
        self.assertEqual(status["ambient"]["per_day"], 1)
        self.assertEqual(status["transferania"]["per_day"], 2)
        self.assertEqual(next(m for m in status["models"] if m["id"] == GEMMA)["input_tpm"], 16000)
        ai.bind(companion_context_config=lambda: {"chat_daily_limit": 0})
        self.assertFalse(ai.transferania_ok())

    def test_invalid_configuration_uses_defaults(self):
        ai.bind(companion_context_config=lambda: {"chat_daily_limit": "bad", "ambient_daily_limit": None,
            "model_input_tpm": {GEMMA: "bad"}})
        self.assertEqual(ai.daily_limit("chat"), 1000)
        self.assertEqual(ai.daily_limit("ambient"), 240)
        self.assertEqual(ai.model_tpm(GEMMA), 16000)

    def test_concurrent_reservation_is_atomic(self):
        system, contents = self.payload()
        self.configure_tpm(ai.estimate_tokens(GEMMA, ai.estimate_context(system, contents)))
        entered, release = threading.Event(), threading.Event()
        result, errors = [], []
        def post(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return reply("ok")
        ai.bind(post=post)
        def first():
            try:
                result.append(ai.generate((GEMMA,), system, contents))
            except Exception as error:
                errors.append(error)
        worker = threading.Thread(target=first)
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
            with self.assertRaises(ai.AiError):
                ai.generate((GEMMA,), system, contents)
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(errors)
        self.assertEqual(len(result), 1)
        self.assertEqual(ai.usage()["count"][GEMMA], 1)

    def test_model_daily_quota_still_blocks_calls(self):
        u = {"day": ai._today(), "count": {GEMMA: ai.MODELS[GEMMA][2]}}
        (self.root / ai.STORE).mkdir()
        (self.root / ai.STORE / ai.USAGE).write_text(json.dumps(u))
        system, contents = self.payload()
        _, model = ai.generate(ai.AMBIENT_CHAIN, system, contents, ambient=True)
        self.assertEqual(model, LITE)
        self.assertEqual(len(self.calls), 1)

    def test_daily_resets_preserve_the_rolling_window(self):
        system, contents = self.payload()
        estimate = ai.estimate_context(system, contents)
        self.configure_tpm(ai.estimate_tokens(GEMMA, estimate))
        ai.generate((GEMMA,), system, contents, ambient=True)
        with patch.object(ai, "_today", return_value="2026-11-02"):
            self.assertEqual(ai.ambient_used(), 0)
            self.assertEqual(ai.usage()["count"][GEMMA], 1)
            self.assertFalse(ai.available(GEMMA, 1))
        with patch.object(ai, "_provider_day", return_value="2026-11-02"):
            self.assertEqual(ai.usage()["count"], {})
            self.assertFalse(ai.available(GEMMA, 1))
            self.assertEqual(ai.ambient_used(), 1)

    def test_transport_failure_keeps_reservation_and_safe_metrics(self):
        def post(*args):
            raise ai.AiError("provider unavailable", 502, "unreachable")
        ai.bind(post=post)
        result = ai.transferania_chat("bonjour", device_id=DEV)
        self.assertTrue(result["fallback"])
        metrics = result["context_usage"]
        # A transport failure no longer ends the reply: the second model is tried before the fallback line.
        self.assertEqual(metrics["provider_attempts"], 2)
        self.assertEqual([u["error"] for u in metrics["provider_usage"]], ["transport", "transport"])
        self.assertIsNone(metrics["cost"])
        self.assertGreater(ai.usage()["token_window"][LITE][0]["tokens"], 0)


class GemmaThinkingTests(Base):
    def test_gemma_gets_minimal_thinking_and_gemini_body_is_unchanged(self):
        ai.generate(("gemma-4-26b-a4b-it",), "core", [{"role": "user", "parts": [{"text": "salut"}]}], max_tokens=640)
        gemma_cfg = self.calls[-1][1]["generationConfig"]
        self.assertEqual(gemma_cfg["thinkingConfig"], {"thinkingLevel": "minimal"})
        self.assertEqual(gemma_cfg["maxOutputTokens"], 640)
        ai.generate(("gemini-3.1-flash-lite",), "core", [{"role": "user", "parts": [{"text": "salut"}]}])
        self.assertNotIn("thinkingConfig", self.calls[-1][1]["generationConfig"])

    def test_adult_mode_tries_flash_lite_then_gemma_and_keeps_gemma_31b_last(self):
        self.assertEqual(ai.NSFW_CHAIN[:2], ("gemini-3.5-flash-lite", "gemma-4-26b-a4b-it"))
        self.assertEqual(ai.NSFW_CHAIN[-1], "gemma-4-31b-it")


class SecondKeyTests(Base):
    FL = "gemini-3.5-flash-lite"  # first model of NSFW_CHAIN
    MSG = [{"role": "user", "parts": [{"text": "salut"}]}]

    def setUp(self):
        super().setUp()
        ai.bind(extra_keys=lambda: ["second-key"])

    def tearDown(self):
        ai._cb.pop("extra_keys", None)
        super().tearDown()

    def _keys_used(self):
        return [(c[0], c[2]["x-goog-api-key"]) for c in self.calls]

    def test_exhausted_key_1_uses_the_same_model_on_key_2_before_gemma(self):
        with ai._usage_transaction():
            u = ai.usage()
            u["count"][self.FL] = ai.MODELS[self.FL][2]
            ai._save_usage(u)
        text, model = ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True, transferania=True)
        self.assertEqual(model, self.FL)
        self.assertEqual(self._keys_used(), [(self.FL, "second-key")])
        self.assertEqual(ai.usage()["count"][ai.quota_slot(self.FL, 1)], 1)
        self.assertEqual(ai.usage()["count"][self.FL], ai.MODELS[self.FL][2])

    def test_provider_429_on_key_1_retries_the_model_on_key_2(self):
        self.answers = [(429, {}), reply("ok")]
        ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True, transferania=True)
        self.assertEqual(self._keys_used(), [(self.FL, "test-key"), (self.FL, "second-key")])
        self.assertGreater(ai.usage()["model_backoff_until"][self.FL], ai._now())
        self.assertNotIn(ai.quota_slot(self.FL, 1), ai.usage().get("model_backoff_until", {}))

    def test_filtered_reply_moves_to_the_next_model_not_the_same_model_on_key_2(self):
        self.answers = [reply("Je veux sentir le poids de t", finish_reason="SAFETY"), reply("Une phrase complète.")]
        ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True, transferania=True)
        self.assertEqual(self._keys_used(), [(self.FL, "test-key"), ("gemma-4-26b-a4b-it", "test-key")])

    def test_rejected_key_2_falls_through_instead_of_failing_the_request(self):
        with ai._usage_transaction():
            u = ai.usage()
            u["count"][self.FL] = ai.MODELS[self.FL][2]
            ai._save_usage(u)
        self.answers = [(400, {"error": {"message": "API key not valid. Please pass a valid API key."}}), reply("ok")]
        text, model = ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True)
        self.assertEqual(self._keys_used(), [(self.FL, "second-key"), ("gemma-4-26b-a4b-it", "test-key")])
        self.assertEqual(model, "gemma-4-26b-a4b-it")

    def test_status_adds_up_both_keys_and_never_returns_a_key(self):
        out = ai.status(role="admin")
        fl = next(m for m in out["models"] if m["id"] == self.FL)
        self.assertEqual((out["keys"], fl["per_day"]), (2, 2 * ai.MODELS[self.FL][2]))
        self.assertNotIn("second-key", json.dumps(out))

    def test_overloaded_model_503_moves_to_the_next_model_not_key_2(self):
        self.answers = [(503, {"error": {"message": "This model is currently experiencing high demand."}}), reply("ok")]
        ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True, transferania=True)
        self.assertEqual(self._keys_used(), [(self.FL, "test-key"), ("gemma-4-26b-a4b-it", "test-key")])


class FailurePathTests(SecondKeyTests):
    """Every way one model/key can fail must leave the rest of the chain usable."""

    def _script(self, *steps):
        steps = list(steps)
        def post(url, body, headers, timeout):
            self.calls.append((url.split("/models/")[1].split(":")[0], body, headers))
            step = steps.pop(0) if steps else reply("ok")
            if isinstance(step, BaseException):
                raise step
            return step
        ai.bind(post=post)

    def test_timeout_on_one_model_falls_through_to_the_next_model(self):
        self._script(ai.AiError("Google injoignable (timed out)", 502, "unreachable"), reply("ok"))
        _, model = ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True, transferania=True)
        self.assertEqual(model, "gemma-4-26b-a4b-it")
        self.assertEqual(self._keys_used(), [(self.FL, "test-key"), ("gemma-4-26b-a4b-it", "test-key")])

    def test_unreadable_body_is_a_failed_model_not_a_crash(self):
        self._script(ValueError("Expecting value"), (200, ["not", "a", "dict"]), reply("ok"))
        ai.bind(extra_keys=lambda: [])
        _, model = ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True)
        self.assertEqual(model, "gemini-3.1-flash-lite")

    def test_quota_429_on_both_keys_still_leaves_gemma_its_turn(self):
        self._script((429, {}), (429, {}), reply("ok"))
        _, model = ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True, transferania=True)
        self.assertEqual(model, "gemma-4-26b-a4b-it")
        self.assertEqual(self._keys_used(), [(self.FL, "test-key"), (self.FL, "second-key"), ("gemma-4-26b-a4b-it", "test-key")])

    def test_rejected_key_is_not_retried_on_the_next_request(self):
        bad = (403, {"error": {"message": "Permission denied"}})
        self._script((429, {}), bad, reply("ok"), reply("ok"))
        ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True, transferania=True)
        self.calls.clear()
        self.clock[0] += 120  # past the 429 cooldown, well inside the rejected-key backoff
        ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True, transferania=True)
        self.assertNotIn((self.FL, "second-key"), self._keys_used())
        self.assertEqual(self._keys_used()[0], (self.FL, "test-key"))

    def test_rejected_thinking_setting_never_fails_the_reply(self):
        ai.bind(extra_keys=lambda: [])
        self._script((400, {"error": {"message": "Thinking level is not supported for this model."}}), reply("ok"))
        _, model = ai.generate(("gemma-4-26b-a4b-it", "gemini-3.1-flash-lite"), "core", self.MSG)
        self.assertEqual(model, "gemini-3.1-flash-lite")

    def test_other_400_still_reports_the_request_error(self):
        self._script((400, {"error": {"message": "Invalid JSON payload"}}))
        with self.assertRaises(ai.AiError) as error:
            ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True)
        self.assertEqual(error.exception.code, "model_error")

    def test_never_more_than_two_slow_attempts_for_a_companion_reply(self):
        self._script(*[ai.AiError("timed out", 502, "unreachable")] * 8)
        with self.assertRaises(ai.AiError) as error:
            ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True, transferania=True)
        self.assertEqual(error.exception.code, "busy")
        self.assertEqual(len(self.calls), 2)

    def test_key_2_alone_is_enough_to_be_configured(self):
        ai.bind(key=lambda: "")
        _, model = ai.generate(ai.NSFW_CHAIN, "core", self.MSG, nsfw=True)
        self.assertEqual(self._keys_used(), [(self.FL, "second-key")])
        self.assertTrue(ai.status(role="admin")["configured"])


class DynamicBudgetTests(Base):
    """One configured chat budget, narrowed per model by what that model accepts per minute."""
    MSG = [{"role": "user", "parts": [{"text": "salut"}]}]

    def setUp(self):
        super().setUp()
        ai.bind(companion_context_config=lambda: {"chat_input_budget": 100000})

    def _chat_calls(self):
        return [c for c in self.calls if c[1]["systemInstruction"]["parts"][0]["text"].startswith("Tu es Transferania")]

    def _sizes(self):
        return [(c[0], ai.estimate_context(c[1]["systemInstruction"]["parts"][0]["text"], c[1]["contents"])) for c in self._chat_calls()]

    def test_caps_follow_each_model(self):
        gemma_cap = int(16000 * ai.MODEL_INPUT_SHARE * ai.BYTES_PER_TOKEN_DEFAULT)  # tokens/min → bytes
        self.assertEqual(ai.model_input_cap("gemini-3.5-flash-lite"), 100000)
        self.assertEqual(ai.model_input_cap("gemma-4-26b-a4b-it"), gemma_cap)
        self.assertEqual(ai.model_input_cap("gemma-4-26b-a4b-it@k2"), gemma_cap)
        self.assertEqual(ai.chain_floor_cap(ai.NSFW_CHAIN), gemma_cap)
        ai.bind(companion_context_config=lambda: {"chat_input_budget": 9000})
        self.assertEqual(ai.model_input_cap("gemma-4-26b-a4b-it"), 9000)  # never above the configured budget

    def test_long_history_uses_the_full_budget_on_gemini_and_a_refit_prompt_on_gemma(self):
        thread = ai._empty_transferania()
        thread["messages"] = [m for i in range(60) for m in (
            {"role": "user", "text": f"sujet {i} " + "robot calibration détail " * 40},
            {"role": "assistant", "text": f"réponse {i} " + "on ajuste le moteur " * 40})]
        thread["summary_attempt_at"] = self.clock[0]  # keep the optional summary model call out of this test
        ai.save_transferania(thread, DEV)
        self.answers = [(503, {"error": {"message": "high demand"}}), reply("ok")]
        out = ai.transferania_chat("robot calibration, on en était où ?", device_id=DEV, nsfw=True, client_ip="127.0.0.1", role="admin")
        self.assertFalse(out["fallback"])
        (first, big), (second, small) = self._sizes()
        self.assertEqual((first, second), ("gemini-3.5-flash-lite", "gemma-4-26b-a4b-it"))
        self.assertGreater(big, 16000)
        self.assertLessEqual(small, ai.model_input_cap("gemma-4-26b-a4b-it"))
        chat = self._chat_calls()
        gemma_payload = json.dumps(chat[1][1]["contents"], ensure_ascii=False)
        self.assertIn("réponse 59", gemma_payload)  # newest exchange survives the refit
        self.assertTrue(gemma_payload.rstrip("\"}]").endswith("on en était où ?"))
        self.assertEqual(chat[0][1]["systemInstruction"], chat[1][1]["systemInstruction"])

    def test_without_refit_an_oversized_prompt_still_skips_gemma(self):
        big = [{"role": "user", "parts": [{"text": "x" * 60000}]}]  # above Gemma's ~40.8 KB cap
        _, model = ai.generate(("gemma-4-26b-a4b-it", "gemini-3.1-flash-lite"), "core", big)
        self.assertEqual(model, "gemini-3.1-flash-lite")

    def test_core_too_big_for_gemma_skips_it_instead_of_failing(self):
        def refit(cap):
            raise ai.AiError("trop grand", 413, "context_budget")
        big = [{"role": "user", "parts": [{"text": "x" * 60000}]}]  # above Gemma's ~40.8 KB cap
        _, model = ai.generate(("gemma-4-26b-a4b-it", "gemini-3.1-flash-lite"), "core", big, refit=refit)
        self.assertEqual(model, "gemini-3.1-flash-lite")

    def test_summary_still_tracks_the_smallest_model_of_the_chain(self):
        thread = ai._empty_transferania()
        thread["messages"] = [m for i in range(14) for m in (
            {"role": "user", "text": f"We decided item {i} " + "detail " * 200},
            {"role": "assistant", "text": "noted " * 200})]
        ai.save_transferania(thread, DEV)
        ai.transferania_chat("Bonjour", device_id=DEV, nsfw=True, client_ip="127.0.0.1", role="admin")
        self.assertTrue(ai.load_transferania(DEV).get("summary"))


class TokenCalibrationTests(Base):
    MSG = [{"role": "user", "parts": [{"text": "x" * 4000}]}]

    def test_default_is_conservative_until_enough_samples(self):
        self.assertEqual(ai.bytes_per_token(GEMMA), ai.BYTES_PER_TOKEN_DEFAULT)
        for _ in range(ai.CALIBRATION_MIN_SAMPLES - 1):
            ai._observe_tokens(GEMMA, 3750, 1000)
        self.assertEqual(ai.bytes_per_token(GEMMA), ai.BYTES_PER_TOKEN_DEFAULT)
        ai._observe_tokens(GEMMA, 3750, 1000)
        self.assertAlmostEqual(ai.bytes_per_token(GEMMA), 3.75 * ai.CALIBRATION_MARGIN)
        self.assertEqual(ai.bytes_per_token(LITE), ai.BYTES_PER_TOKEN_DEFAULT)  # families learn separately

    def test_uses_the_low_end_of_recent_samples(self):
        for ratio in [3.6] * 3 + [3.8] * 17:  # 10th percentile of 20 = 3rd lowest
            ai._observe_tokens(GEMMA, int(ratio * 1000), 1000)
        self.assertAlmostEqual(ai.bytes_per_token(GEMMA), 3.6 * ai.CALIBRATION_MARGIN, places=3)

    def test_ignores_tiny_prompts_outliers_and_bad_counts(self):
        for est, measured in ((800, 200), (4000, 100), (4000, 0), (4000, True), (4000, None), (4000, "1000")):
            ai._observe_tokens(GEMMA, est, measured)
        self.assertFalse((self.root / ai.STORE / ai.CALIBRATION_FILE).exists())

    def test_damaged_file_falls_back_to_the_default(self):
        p = self.root / ai.STORE / ai.CALIBRATION_FILE
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text('{"gemma": [9, "x", null, 3.7, true]}', "utf-8")
        ai._calibration_cache.clear()
        self.assertEqual(ai.bytes_per_token(GEMMA), ai.BYTES_PER_TOKEN_DEFAULT)  # one valid sample is not enough
        p.write_text("not json", "utf-8")
        ai._calibration_cache.clear()
        self.assertEqual(ai.bytes_per_token(GEMMA), ai.BYTES_PER_TOKEN_DEFAULT)

    def test_successful_calls_teach_the_ratio_and_grow_gemma_cap(self):
        ai.bind(companion_context_config=lambda: {"chat_input_budget": 100000})
        before = ai.model_input_cap(GEMMA)
        est = ai.estimate_context("core", self.MSG)
        for _ in range(ai.CALIBRATION_MIN_SAMPLES):
            status, data = reply("ok")
            data["usageMetadata"] = {"promptTokenCount": round(est / 3.75)}
            self.answers = [(status, data)]
            ai.generate((GEMMA,), "core", self.MSG)
            self.clock[0] += 61
        self.assertGreater(ai.model_input_cap(GEMMA), before)
        self.assertAlmostEqual(ai.bytes_per_token(GEMMA), 3.75 * ai.CALIBRATION_MARGIN, places=2)

    def test_quota_window_reserves_calibrated_tokens_not_bytes(self):
        est = ai.estimate_context("core", self.MSG)
        self.answers = [(503, {})]
        with self.assertRaises(ai.AiError):
            ai.generate((GEMMA,), "core", self.MSG)
        self.assertEqual(ai.usage()["token_window"][GEMMA][0]["tokens"], ai.estimate_tokens(GEMMA, est))


class SessionRegressionTests(Base):
    """Interactions between the larger chat budget and the rest of the chat request."""

    def test_large_budget_keeps_the_summary_model_call_at_its_historical_size(self):
        ai.bind(companion_context_config=lambda: {"chat_input_budget": 100000})
        chunk = [{"role": "user", "text": "We decided item " + "detail " * 400} for _ in range(30)]  # 500 chars kept each
        with self.assertRaises(ai.AiError) as error:
            ai.compress_with_llm("", chunk)
        self.assertEqual(error.exception.code, "context_budget")
        self.assertFalse(self.calls)  # local summary instead of a long synchronous call before the reply
        ai.compress_with_llm("", chunk[:1])
        self.assertEqual(len(self.calls), 1)

    def _chat_with_followup(self, gemma_extra_bytes):
        from unittest.mock import patch
        real = ai.companion_memory.context_packet("bonjour", conversation_text="bonjour")
        marker = "SUJET EN ATTENTE (une seule relance) : MARQUEUR " + "x" * 1500
        packet = {**real, "continuity": marker}
        core = ai._chat_system("warm", nsfw=False, view="accueil", device_id=DEV)
        cap_bytes = ai.estimate_context(core, [{"role": "user", "parts": [{"text": "bonjour"}]}]) + gemma_extra_bytes
        tpm = math.ceil(cap_bytes / (ai.MODEL_INPUT_SHARE * ai.BYTES_PER_TOKEN_DEFAULT))
        ai.bind(companion_context_config=lambda: {"chat_input_budget": 100000, "model_input_tpm": {GEMMA: tpm}})
        cancelled = []
        self.answers = [(503, {}), reply("ok")]
        with patch.object(ai, "_continuity_packet", return_value=packet), \
             patch.object(ai.companion_memory, "cancel_context_reservation", side_effect=lambda p: cancelled.append(p["continuity"])):
            out = ai.transferania_chat("bonjour", device_id=DEV)
        return out, cancelled, marker

    def test_followup_dropped_by_a_refit_is_released(self):
        out, cancelled, marker = self._chat_with_followup(gemma_extra_bytes=1200)
        self.assertEqual(out["model"], GEMMA)
        self.assertNotIn("MARQUEUR", json.dumps(self.calls[-1][1]["contents"]))
        self.assertEqual(cancelled, [marker])

    def test_followup_kept_by_the_answering_model_stays_reserved(self):
        out, cancelled, _ = self._chat_with_followup(gemma_extra_bytes=60000)
        self.assertEqual(out["model"], GEMMA)
        self.assertIn("MARQUEUR", json.dumps(self.calls[-1][1]["contents"]))
        self.assertEqual(cancelled, [])
