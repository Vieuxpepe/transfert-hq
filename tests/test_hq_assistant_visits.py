"""Contracts for memories left by scripted visits between assistant chips."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError

import hq_assistant_growth
import hq_assistant_visits
import hq_companion_memory as memory
import hq_culinia
import hq_forgia
import hq_musica
import hq_visit_memory


class VisitMemoryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        hq_culinia.bind(root=self.root)
        hq_forgia.bind(root=self.root)
        hq_musica.bind(root=self.root)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def _record(self, host, visitor):
        return hq_assistant_visits.record({
            "host": host,
            "visitor": visitor,
            "lines": [
                {"who": "host", "text": "Je goute trois fois avant de servir."},
                {"who": "visitor", "text": "La lumiere decide de tout."},
            ],
        })

    def test_each_participant_gets_her_own_file_and_prompt_recall(self):
        code, payload = self._record("culinia", "forgia")
        self.assertEqual(code, 200)
        self.assertEqual(sorted(payload["recorded"]), ["culinia", "forgia"])
        culinia_path = self.root / ".hq-household" / "culinia_visits.json"
        forgia_path = self.root / ".hq-forge" / "forgia_visits.json"
        self.assertTrue(culinia_path.is_file())
        self.assertTrue(forgia_path.is_file())
        self.assertNotEqual(culinia_path.read_bytes(), forgia_path.read_bytes())
        hint = hq_assistant_growth.hint(hq_culinia.growth_path(), "Bonjour Culinia")
        self.assertIn("VISITE RÉCENTE AVEC FORGIA", hint)
        self.assertIn("La lumiere decide", hint)

    def test_a_generated_visit_gets_the_last_pair_thread(self):
        self._record("culinia", "forgia")
        hq_assistant_visits._banter_last = 0.0
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Bonjour Forgia."},
            {"who": "visitor", "text": "Je passais voir la lumière."},
            {"who": "host", "text": "Elle est stable aujourd'hui."},
            {"who": "visitor", "text": "Je retourne à l'atelier."},
        ]})
        gemini = mock.Mock(return_value=(raw, "gemini-3.1-flash-lite"))
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", new=gemini):
            code, _ = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 200)
        prompt = gemini.call_args.args[1]
        self.assertIn("La lumiere decide de tout", prompt)
        self.assertIn("Fil précédent", prompt)

    def test_unrelated_work_question_does_not_pull_the_visit(self):
        self._record("culinia", "forgia")
        hint = hq_assistant_growth.hint(hq_culinia.growth_path(), "Quel est le stock de farine ?")
        self.assertNotIn("VISITE", hint)

    def test_named_visitor_wins_over_a_more_recent_other_visit(self):
        self._record("culinia", "forgia")
        code, _ = self._record("culinia", "musica")
        self.assertEqual(code, 200)
        hint = hq_visit_memory.hint(
            hq_visit_memory.visit_path(hq_culinia.growth_path()),
            self_key="culinia", query="Tu te souviens de Forgia ?")
        self.assertIn("FORGIA", hint)
        self.assertNotIn("MUSICA", hint)

    def test_visits_fall_out_of_the_ninety_day_window(self):
        path = hq_visit_memory.visit_path(hq_culinia.growth_path())
        hq_visit_memory.record(path, self_key="culinia", other_key="forgia",
                               other_name="Forgia", lines=[{"who": "forgia", "text": "bonjour"}],
                               now=1_700_000_000.0)
        self.assertIsNone(hq_visit_memory.latest(path, self_key="culinia", other_key="forgia",
                                                 now=1_700_000_000.0 + hq_visit_memory.RETENTION + 1))
        self.assertIsNotNone(hq_visit_memory.latest(path, self_key="culinia", other_key="forgia",
                                                    now=1_700_000_000.0 + hq_visit_memory.RETENTION - 1))

    def test_unreadable_file_is_preserved(self):
        path = self.root / ".hq-forge" / "forgia_visits.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{broken", encoding="utf-8")
        with self.assertLogs("hq_visit_memory", level="WARNING"):
            row = hq_visit_memory.record(
                hq_visit_memory.visit_path(hq_forgia.growth_path()), self_key="forgia",
                other_key="culinia", other_name="Culinia",
                lines=[{"who": "culinia", "text": "bonjour"}])
        self.assertIsNone(row)
        self.assertEqual(path.read_text(encoding="utf-8"), "{broken")

    def test_stored_lines_are_bounded_and_keys_are_checked(self):
        path = self.root / ".hq-forge" / "forgia_visits.json"
        row = hq_visit_memory.record(
            hq_visit_memory.visit_path(hq_forgia.growth_path()), self_key="forgia",
            other_key="culinia", other_name="Culinia",
            lines=[{"who": "unknown", "text": "ignore"}])
        self.assertIsNone(row)
        self.assertFalse(path.exists())


class ElseVisitMemoryTests(unittest.TestCase):
    def setUp(self):
        import hq_ai
        self.root = Path(tempfile.mkdtemp())
        hq_ai.bind(root=self.root)
        self.memory = memory
        self.memory.bind(root=self.root, now=lambda: 1_700_000_000.0)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def _record(self, owner):
        with self.memory.owner_context(owner), self.memory.memory_scope("else"):
            self.memory.record_visit(other_key="culinia", other_name="Culinia", lines=[
                {"who": "culinia", "text": "Je goute trois fois."},
                {"who": "else", "text": "Je regarde."},
            ])

    def test_else_recall_is_scoped_to_the_owner(self):
        self._record("alice")
        with self.memory.owner_context("alice"), self.memory.memory_scope("else"):
            packet = self.memory.context_packet("Bonjour Else", conversation_text="Bonjour Else")
            self.assertIn("VISITE RÉCENTE AVEC CULINIA", packet["continuity"])
        with self.memory.owner_context("bob"), self.memory.memory_scope("else"):
            packet = self.memory.context_packet("Bonjour Else", conversation_text="Bonjour Else")
            self.assertEqual(packet["continuity"], "")
        with self.memory.owner_context("alice"), self.memory.memory_scope("else"):
            ambient = self.memory.context_packet("Bonjour Else")
            self.assertEqual(ambient["continuity"], "")

    def test_else_visit_file_keeps_owner_hash_in_its_name(self):
        self._record("alice")
        files = list((self.root / ".hq-ai" / "companion-memory" / "else").glob("*_visits.json"))
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].name.endswith("_visits.json"))
        self.assertNotIn("alice", files[0].name)


class VisitBanterTests(unittest.TestCase):
    def setUp(self):
        hq_assistant_visits._banter_last = 0.0
        hq_assistant_visits._reset_telemetry()

    def test_generated_exchange_is_validated_and_mapped_to_the_two_assistants(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Bonjour Forgia."},
            {"who": "visitor", "text": "Je passais voir la lumière."},
            {"who": "host", "text": "Elle est stable aujourd'hui."},
            {"who": "visitor", "text": "Je retourne à l'atelier."},
        ]})
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", return_value=raw) as generate:
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 200)
        self.assertEqual([line["who"] for line in payload["lines"]],
                         ["culinia", "forgia", "culinia", "forgia"])
        self.assertIn("Bonjour Forgia", payload["lines"][0]["text"])
        prompt = generate.call_args.args[0]
        self.assertIn("Culinia", prompt)
        self.assertIn("Forgia", prompt)
        self.assertIn("Pas de hostilité", prompt)

    def test_gemini_is_preferred_and_nvidia_is_not_called(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Bonjour Forgia."},
            {"who": "visitor", "text": "Je passais voir la lumière."},
            {"who": "host", "text": "Elle est stable aujourd'hui."},
            {"who": "visitor", "text": "Je retourne à l'atelier."},
        ]})
        gemini = mock.Mock(return_value=(raw, "gemini-3.1-flash-lite"))
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", new=gemini), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat") as nvidia:
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 200)
        self.assertEqual(payload["provider"], "gemini")
        self.assertEqual(len(payload["lines"]), 4)
        nvidia.assert_not_called()
        args, kwargs = gemini.call_args
        self.assertEqual(args[0], hq_assistant_visits.GEMINI_VISIT_CHAIN)
        self.assertTrue(kwargs["json_out"])
        self.assertEqual(kwargs["attempt_timeout"], hq_assistant_visits.GEMINI_ATTEMPT_TIMEOUT_S)
        self.assertTrue(kwargs["visit"], "visits use their own quota bucket")
        self.assertIn("Culinia", args[1])

    def test_flyby_shape_gets_two_lines_and_safe_place_context(self):
        raw = json.dumps({"lines": [
            {"who": "visitor", "text": "Je passais par le Carnet."},
            {"who": "host", "text": "Tu tombes bien, j'allais fermer."},
        ]})
        gemini = mock.Mock(return_value=(raw, "gemini-3.1-flash-lite"))
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", new=gemini):
            code, payload = hq_assistant_visits.banter(
                {"host": "culinia", "visitor": "forgia", "shape": "flyby", "place": "carnet"})
        self.assertEqual(code, 200)
        self.assertEqual(len(payload["lines"]), 2)
        prompt = gemini.call_args.args[1]
        self.assertIn("le Carnet", prompt)
        self.assertIn("deux répliques exactement", prompt)
        self.assertEqual(hq_assistant_visits._place("../secret"), "hq")

    def test_scene_shape_accepts_six_lines(self):
        raw = json.dumps({"lines": [
            {"who": "visitor", "text": "Bonjour."},
            {"who": "host", "text": "Tiens, tu passes."},
            {"who": "visitor", "text": "Je cherchais un peu de calme."},
            {"who": "host", "text": "Reste un instant."},
            {"who": "visitor", "text": "Je veux bien."},
            {"who": "host", "text": "Je retourne à l'atelier."},
        ]})
        gemini = mock.Mock(return_value=(raw, "gemini-3.1-flash-lite"))
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", new=gemini):
            code, payload = hq_assistant_visits.banter(
                {"host": "culinia", "visitor": "forgia", "shape": "scene"})
        self.assertEqual(code, 200)
        self.assertEqual(len(payload["lines"]), 6)
        self.assertIn("six répliques exactement", gemini.call_args.args[1])

    def test_telemetry_counts_gemini_success_and_nvidia_fallback(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Bonjour."}, {"who": "visitor", "text": "Salut."},
            {"who": "host", "text": "Tu repars ?"}, {"who": "visitor", "text": "Oui, à bientôt."},
        ]})
        with mock.patch.object(hq_assistant_visits, "_gemini_generate",
                               return_value=(raw, "gemini-3.1-flash-lite")):
            self.assertEqual(hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})[0], 200)
        telemetry = hq_assistant_visits.settings_snapshot()["telemetry"]
        self.assertEqual((telemetry["gemini_ok"], telemetry["gemini_error"]), (1, 0))
        self.assertEqual(telemetry["last_provider"], "gemini")

        hq_assistant_visits._banter_last = 0.0
        with mock.patch.object(hq_assistant_visits, "_gemini_generate",
                               side_effect=RuntimeError("Gemini down")), \
                mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", return_value=raw):
            self.assertEqual(hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})[0], 200)
        telemetry = hq_assistant_visits.settings_snapshot()["telemetry"]
        self.assertEqual((telemetry["gemini_ok"], telemetry["gemini_error"]), (1, 1))
        self.assertEqual((telemetry["nvidia_ok"], telemetry["nvidia_error"]), (1, 0))
        self.assertEqual((telemetry["last_provider"], telemetry["last_reason"]),
                         ("nvidia", "gemini_unavailable"))
        self.assertNotIn("culinia", json.dumps(telemetry))

    def test_gemini_failure_falls_back_to_nvidia(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Bonjour."},
            {"who": "visitor", "text": "Salut."},
            {"who": "host", "text": "Tu repars ?"},
            {"who": "visitor", "text": "Oui, à bientôt."},
        ]})
        gemini = mock.Mock(side_effect=RuntimeError("Gemini down"))
        nvidia = mock.Mock(return_value=raw)
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", new=gemini), \
                mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", nvidia):
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 200)
        self.assertEqual(payload["provider"], "nvidia")
        self.assertEqual(payload["fallback_reason"], "gemini_unavailable")
        nvidia.assert_called_once()
        self.assertEqual(nvidia.call_args.kwargs["timeout"], hq_assistant_visits.NVIDIA_FALLBACK_TIMEOUT_S)

    def test_a_second_exchange_is_rate_limited_without_calling_the_model(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "a"}, {"who": "visitor", "text": "b"},
            {"who": "host", "text": "c"}, {"who": "visitor", "text": "d"},
        ]})
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", return_value=raw) as generate:
            self.assertEqual(hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})[0], 200)
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 429)
        self.assertEqual(payload["code"], "rate_limited")
        self.assertEqual(generate.call_count, 1)

    def test_bad_model_output_returns_a_fallback_error(self):
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", return_value="pas du json"):
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 502)
        self.assertEqual(payload["code"], "invalid_output")

    def test_missing_nvidia_key_returns_a_fallback_error_without_a_call(self):
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value=""), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat") as generate:
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 503)
        self.assertEqual(payload["code"], "nvidia_not_configured")
        generate.assert_not_called()

    def test_nvidia_request_uses_the_configured_model_and_bearer_key(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Bonjour."}, {"who": "visitor", "text": "Salut."},
            {"who": "host", "text": "Tu repars ?"}, {"who": "visitor", "text": "Oui, à bientôt."},
        ]})
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {"choices": [{"message": {"content": raw}}]}).encode()
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_model", return_value="meta/test-model"), \
                mock.patch.object(hq_assistant_visits.urllib.request, "urlopen", return_value=response) as open_url:
            code, _ = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 200)
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, hq_assistant_visits.NVIDIA_CHAT_URL)
        self.assertEqual(request.get_header("Authorization"), "Bearer nvapi-test")
        body = json.loads(request.data)
        self.assertEqual(body["model"], "meta/test-model")
        self.assertFalse(body["stream"])


class VisitTelemetryPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.now = 1_700_000_000.0
        self.clock = mock.Mock(return_value=self.now)
        hq_assistant_visits.bind(root=self.root, now=self.clock)

    def tearDown(self):
        hq_assistant_visits.bind(root=None)
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    @property
    def path(self):
        return self.root / ".hq-agent-state" / hq_assistant_visits.TELEMETRY_NAME

    def test_today_totals_survive_a_bridge_restart(self):
        hq_assistant_visits._note_telemetry("gemini", True)
        hq_assistant_visits._note_telemetry("gemini", False, "gemini_timeout")
        hq_assistant_visits._note_telemetry("nvidia", True, "gemini_timeout")
        hq_assistant_visits.bind(root=self.root, now=self.clock)
        telemetry = hq_assistant_visits.telemetry_snapshot()
        self.assertEqual((telemetry["gemini_ok"], telemetry["gemini_error"]), (1, 1))
        self.assertEqual((telemetry["nvidia_ok"], telemetry["nvidia_error"]), (1, 0))
        self.assertEqual(telemetry["last_provider"], "nvidia")
        self.assertEqual(telemetry["day"], hq_assistant_visits._today())
        self.assertTrue(telemetry["persisted"])
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(stored["day"], telemetry["day"])
        self.assertEqual(stored["gemini_error"], 1)

    def test_a_new_day_starts_at_zero_and_persists_the_new_totals(self):
        hq_assistant_visits._note_telemetry("gemini", True)
        old_day = hq_assistant_visits.telemetry_snapshot()["day"]
        self.clock.return_value += 86400
        telemetry = hq_assistant_visits.telemetry_snapshot()
        self.assertNotEqual(telemetry["day"], old_day)
        self.assertEqual(telemetry["gemini_ok"], 0)
        hq_assistant_visits._note_telemetry("nvidia", False, "nvidia_timeout")
        hq_assistant_visits.bind(root=self.root, now=self.clock)
        telemetry = hq_assistant_visits.telemetry_snapshot()
        self.assertEqual(telemetry["day"], hq_assistant_visits._today())
        self.assertEqual((telemetry["nvidia_ok"], telemetry["nvidia_error"]), (0, 1))

    def test_unreadable_file_is_preserved_and_writes_stop(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("{broken", encoding="utf-8")
        with self.assertLogs("hq_assistant_visits", level="WARNING"):
            hq_assistant_visits.bind(root=self.root, now=self.clock)
        telemetry = hq_assistant_visits.telemetry_snapshot()
        self.assertEqual(telemetry["gemini_ok"], 0)
        self.assertFalse(telemetry["persisted"])
        hq_assistant_visits._note_telemetry("gemini", True)
        self.assertEqual(self.path.read_text(encoding="utf-8"), "{broken")


class AssistantVisitFocusPolicyTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_autofocus_is_passive_but_user_focus_blocks(self):
        script = Path(__file__).with_name("check_hq_assistant_visits_focus.mjs")
        completed = subprocess.run(
            ["node", str(script)], cwd=Path(__file__).resolve().parent.parent,
            capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
        self.assertIn("check_hq_assistant_visits_focus: ok", completed.stdout)


class NvidiaSettingsTests(unittest.TestCase):
    def setUp(self):
        self.cfg = {}
        self.save = mock.Mock()
        self.patches = [
            mock.patch.object(hq_assistant_visits, "_config", return_value=self.cfg),
            mock.patch.object(hq_assistant_visits, "_save_config", self.save),
            mock.patch.object(hq_assistant_visits, "_nvidia_key",
                              side_effect=lambda: self.cfg.get("nvidia_api_key", "")),
            mock.patch.object(hq_assistant_visits, "_nvidia_model",
                              side_effect=lambda: self.cfg.get("nvidia_visit_model") or hq_assistant_visits.DEFAULT_NVIDIA_MODEL),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()

    def test_snapshot_reports_whether_a_key_exists_without_returning_it(self):
        self.cfg.update(nvidia_api_key="nvapi-secret", nvidia_visit_model="meta/test")
        payload = hq_assistant_visits.settings_snapshot()
        self.assertTrue(payload["configured"])
        self.assertEqual(payload["model"], "meta/test")
        self.assertIn("telemetry", payload)
        self.assertNotIn("nvapi-secret", json.dumps(payload))

    def test_update_saves_key_and_model_and_never_echoes_the_key(self):
        code, payload = hq_assistant_visits.settings_update(
            {"api_key": "nvapi-test", "model": "meta/test-model"})
        self.assertEqual(code, 200)
        self.assertEqual(self.cfg["nvidia_api_key"], "nvapi-test")
        self.assertEqual(self.cfg["nvidia_visit_model"], "meta/test-model")
        self.save.assert_called_once()
        self.assertNotIn("nvapi-test", json.dumps(payload))

    def test_clear_key_removes_it_without_touching_the_model(self):
        self.cfg.update(nvidia_api_key="nvapi-test", nvidia_visit_model="meta/test")
        code, payload = hq_assistant_visits.settings_update({"clear_key": True})
        self.assertEqual(code, 200)
        self.assertNotIn("nvidia_api_key", self.cfg)
        self.assertEqual(self.cfg["nvidia_visit_model"], "meta/test")
        self.assertFalse(payload["configured"])

    def test_invalid_key_or_model_is_rejected_without_writing(self):
        for payload in ({"api_key": "bad-key"}, {"model": "bad model"}):
            code, _ = hq_assistant_visits.settings_update(payload)
            self.assertEqual(code, 400)
        self.save.assert_not_called()
        self.assertEqual(self.cfg, {})

    def test_invalid_model_does_not_partially_save_a_valid_key(self):
        code, _ = hq_assistant_visits.settings_update(
            {"api_key": "nvapi-test", "model": "bad model"})
        self.assertEqual(code, 400)
        self.assertNotIn("nvidia_api_key", self.cfg)
        self.save.assert_not_called()


class NvidiaErrorReasonTests(unittest.TestCase):
    def test_visit_quota_maps_to_a_visible_fallback_reason(self):
        error = type("VisitQuota", (Exception,), {"code": "visit_quota"})()
        self.assertEqual(hq_assistant_visits._gemini_error_code(error), "gemini_visit_quota")

    def test_provider_failures_map_to_specific_reasons(self):
        cases = [
            (HTTPError("https://nvidia.test", 401, "unauthorized", None, None), "nvidia_auth"),
            (HTTPError("https://nvidia.test", 404, "not found", None, None), "nvidia_model_not_found"),
            (HTTPError("https://nvidia.test", 429, "limited", None, None), "nvidia_rate_limited"),
            (HTTPError("https://nvidia.test", 503, "down", None, None), "nvidia_unavailable"),
            (TimeoutError("timed out"), "nvidia_timeout"),
            (OSError("connection refused"), "nvidia_unreachable"),
        ]
        for error, code in cases:
            self.assertEqual(hq_assistant_visits._nvidia_error_code(error), code)

    def test_rate_limit_from_nvidia_reaches_the_caller(self):
        hq_assistant_visits._banter_last = 0.0
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat",
                                  side_effect=HTTPError("https://nvidia.test", 429, "limited", None, None)):
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 502)
        self.assertEqual(payload["code"], "nvidia_rate_limited")


if __name__ == "__main__":
    unittest.main()
