"""Contracts for memories left by scripted visits between assistant chips."""
import json
import time
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
from tests import hq_assistant_state

setUpModule = hq_assistant_state.set_up
tearDownModule = hq_assistant_state.tear_down


class VisitMemoryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        hq_culinia.bind(root=self.root)
        hq_forgia.bind(root=self.root)
        hq_musica.bind(root=self.root)

    def tearDown(self):
        import shutil
        # bind() has no unbind: clear the test root so a later module sees the
        # store as unbound instead of resolving into this deleted temp tree.
        hq_culinia._bound_root = None
        hq_forgia._bound_root = None
        hq_musica._bound_root = None
        shutil.rmtree(self.root, ignore_errors=True)

    def _record(self, host, visitor):
        return hq_assistant_visits.record({
            "host": host,
            "visitor": visitor,
            "lines": [
                {"who": "host", "text": "I taste three times before serving."},
                {"who": "visitor", "text": "Light decides everything."},
            ],
        })

    def test_the_same_visit_id_is_recorded_once(self):
        hq_assistant_visits._reset_telemetry()
        body = {"host": "culinia", "visitor": "forgia", "visit_id": "visit-abc12345",
                "lines": [{"who": "host", "text": "Are you closing the door?"},
                          {"who": "visitor", "text": "Yes, right away."}]}
        with mock.patch("hq_personhood.observe_visit") as observe:
            self.assertEqual(hq_assistant_visits.record(body)[0], 200)
            code, payload = hq_assistant_visits.record(body)
        self.assertEqual(code, 200)
        self.assertEqual(sorted(payload["recorded"]), ["culinia", "forgia"])
        self.assertEqual(observe.call_count, 1)
        rows = json.loads((self.root / ".hq-household" / "culinia_visits.json")
                          .read_text(encoding="utf-8"))["visits"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(hq_assistant_visits.telemetry_snapshot()["visits_saved"], 1)

    def test_a_record_is_capped_at_the_largest_shape_and_shares_one_moment(self):
        lines = [{"who": "host" if i % 2 == 0 else "visitor", "text": f"Line {i}."} for i in range(12)]
        hq_assistant_visits.record({"host": "culinia", "visitor": "forgia", "lines": lines})
        mine = json.loads((self.root / ".hq-household" / "culinia_visits.json")
                          .read_text(encoding="utf-8"))["visits"][0]
        hers = json.loads((self.root / ".hq-forge" / "forgia_visits.json")
                          .read_text(encoding="utf-8"))["visits"][0]
        self.assertEqual(len(mine["lines"]), hq_assistant_visits.RECORD_MAX_LINES)
        self.assertEqual(mine["at"], hers["at"])

    def test_a_one_sided_save_is_partial_not_saved(self):
        hq_assistant_visits._reset_telemetry()
        with mock.patch.object(hq_assistant_visits, "_paths",
                               return_value={"culinia": hq_culinia.growth_path()}):
            code, payload = hq_assistant_visits.record({
                "host": "culinia", "visitor": "forgia", "source": "gemini",
                "lines": [{"who": "host", "text": "Are you coming by?"}, {"who": "visitor", "text": "Yes."}]})
        self.assertEqual((code, payload["recorded"], payload["skipped"]), (200, ["culinia"], ["forgia"]))
        telemetry = hq_assistant_visits.telemetry_snapshot()
        self.assertEqual((telemetry["visits_saved"], telemetry["visits_partial"]), (0, 1))
        self.assertEqual(telemetry["source_gemini"], 1)

    def test_the_departure_line_is_not_the_thread(self):
        thread = hq_visit_memory._thread([
            {"who": "a", "text": "Oh, you came by."},
            {"who": "b", "text": "I was looking for quiet."},
            {"who": "a", "text": "There's a bit left."},
            {"who": "b", "text": "I'll take five minutes."}])
        self.assertEqual(thread, "There's a bit left.")
        self.assertEqual(hq_visit_memory._thread([
            {"who": "a", "text": "Did you end up closing?"},
            {"who": "b", "text": "Almost. One thing is left."}]), "Did you end up closing?")

    def test_one_chatty_partner_does_not_push_the_others_out(self):
        path = hq_visit_memory.visit_path(hq_culinia.growth_path())
        base = 1_700_000_000.0
        hq_visit_memory.record(path, self_key="culinia", other_key="musica", other_name="Musica",
                               lines=[{"who": "musica", "text": "An old song."}], now=base)
        for i in range(hq_visit_memory.PER_OTHER + 5):
            hq_visit_memory.record(path, self_key="culinia", other_key="forgia", other_name="Forgia",
                                   lines=[{"who": "forgia", "text": f"Visit number {i}."}],
                                   now=base + 10 + i)
        data = json.loads(path.read_text(encoding="utf-8"))["visits"]
        self.assertEqual(sum(1 for r in data if r["other"] == "forgia"), hq_visit_memory.PER_OTHER)
        self.assertEqual(sum(1 for r in data if r["other"] == "musica"), 1)

    def test_a_clock_stepped_back_does_not_erase_a_fresh_visit(self):
        path = hq_visit_memory.visit_path(hq_culinia.growth_path())
        base = 1_700_000_000.0
        hq_visit_memory.record(path, self_key="culinia", other_key="forgia", other_name="Forgia",
                               lines=[{"who": "forgia", "text": "A real visit here."}], now=base)
        row = hq_visit_memory.record(path, self_key="culinia", other_key="musica", other_name="Musica",
                                     lines=[{"who": "musica", "text": "Another visit."}],
                                     now=base - 3600)
        self.assertIsNotNone(row)
        self.assertIsNotNone(hq_visit_memory.latest(path, self_key="culinia", other_key="forgia",
                                                    now=base - 3600))

    def test_the_masters_answer_is_kept_and_comes_back_in_prompt_and_recall(self):
        body = {"host": "culinia", "visitor": "forgia", "visit_id": "visit-answer01",
                "answer": {"q": "Do you prefer a dish that comforts or one that surprises?", "a": "Surprises"},
                "lines": [{"who": "host", "text": "I have a question for you."},
                          {"who": "visitor", "text": "I'll try the unlikely pairing."}]}
        self.assertEqual(hq_assistant_visits.record(body)[0], 200)
        hq_assistant_visits._reset_banter_limit()
        ctx = hq_assistant_visits._latest_context("culinia", "forgia")
        self.assertEqual(ctx["answer"]["a"], "Surprises")
        self.assertEqual(ctx["meetings"], 1)
        prompt = hq_assistant_visits._banter_prompt("culinia", "forgia", ctx=ctx)
        self.assertIn("He answered: \u201cSurprises\u201d", prompt)
        hint = hq_visit_memory.hint(
            hq_visit_memory.visit_path(hq_culinia.growth_path()),
            self_key="culinia", query="Do you remember Forgia?")
        self.assertIn("il avait répondu « Surprises »", hint)

    def test_a_malformed_answer_is_dropped_not_stored(self):
        for bad in ("oui", {"q": "", "a": "x"}, {"q": "x"}, ["q", "a"]):
            hq_assistant_visits.record({"host": "culinia", "visitor": "forgia",
                                        "answer": bad, "lines": [{"who": "host", "text": "Are you coming by?"}]})
        rows = json.loads((self.root / ".hq-household" / "culinia_visits.json")
                          .read_text(encoding="utf-8"))["visits"]
        self.assertTrue(all("answer" not in row for row in rows))

    def test_a_thread_that_keeps_coming_back_gets_deeper_then_starts_over(self):
        path = hq_visit_memory.visit_path(hq_culinia.growth_path())
        base = 1_700_000_000.0

        def visit(n, text):
            return hq_visit_memory.record(
                path, self_key="culinia", other_key="forgia", other_name="Forgia",
                lines=[{"who": "forgia", "text": text}, {"who": "culinia", "text": "I see."}],
                now=base + n)
        self.assertEqual(visit(1, "The big door still creaks.")["depth"], 0)
        self.assertEqual(visit(2, "The door creaks just as much.")["depth"], 1)
        self.assertEqual(visit(3, "That door creaks even more.")["depth"], 2)
        self.assertEqual(visit(4, "A forgotten cup on the table.")["depth"], 0)

    def test_the_personhood_event_carries_the_thread_not_the_departure(self):
        body = {"host": "culinia", "visitor": "forgia",
                "lines": [{"who": "host", "text": "Oh, you came by."},
                          {"who": "visitor", "text": "I was looking for quiet."},
                          {"who": "host", "text": "There's a bit left."},
                          {"who": "visitor", "text": "I'll take five minutes."}]}
        with mock.patch("hq_personhood.observe_visit") as observe:
            hq_assistant_visits.record(body)
        self.assertEqual(observe.call_args.kwargs["thread"], "There's a bit left.")
        import hq_personhood
        with mock.patch.object(hq_personhood, "record_event") as event:
            hq_personhood.observe_visit("culinia", "forgia", body["lines"],
                                        thread="There's a bit left.")
        self.assertTrue(all(c.kwargs["text"] == "There's a bit left." for c in event.call_args_list))
        self.assertEqual(event.call_count, 2)

    def test_each_participant_gets_her_own_file_and_prompt_recall(self):
        code, payload = self._record("culinia", "forgia")
        self.assertEqual(code, 200)
        self.assertEqual(sorted(payload["recorded"]), ["culinia", "forgia"])
        culinia_path = self.root / ".hq-household" / "culinia_visits.json"
        forgia_path = self.root / ".hq-forge" / "forgia_visits.json"
        self.assertTrue(culinia_path.is_file())
        self.assertTrue(forgia_path.is_file())
        self.assertNotEqual(culinia_path.read_bytes(), forgia_path.read_bytes())
        hint = hq_assistant_growth.hint(hq_culinia.growth_path(), "Hello Culinia")
        self.assertIn("VISITE RÉCENTE AVEC FORGIA", hint)
        self.assertIn("Light decides", hint)

    def test_a_generated_visit_gets_the_last_pair_thread(self):
        self._record("culinia", "forgia")
        hq_assistant_visits._reset_banter_limit()
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Oh, you came by."},
            {"who": "visitor", "text": "I came to see the light."},
            {"who": "host", "text": "It holds well."},
            {"who": "visitor", "text": "Back to the workshop."},
        ]})
        gemini = mock.Mock(return_value=(raw, "gemini-3.1-flash-lite"))
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", new=gemini):
            code, _ = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 200)
        prompt = gemini.call_args.args[1]
        # The visit's last line is its departure; the thread is the point before it.
        self.assertIn("I taste three times before serving", prompt)
        self.assertNotIn("Light decides everything", prompt)
        self.assertIn("Previous thread", prompt)

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
            self_key="culinia", query="Do you remember Forgia?")
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

    def test_a_closing_line_is_not_stored_as_the_pair_thread(self):
        path = hq_visit_memory.visit_path(hq_culinia.growth_path())
        row = hq_visit_memory.record(
            path, self_key="culinia", other_key="forgia", other_name="Forgia",
            lines=[{"who": "forgia", "text": "I'll pick the render back up tomorrow."},
                   {"who": "culinia", "text": "Back to the workshop."}])
        self.assertIsNotNone(row)
        self.assertIn("render", row["thread"])
        self.assertNotIn("workshop", row["thread"])

    def test_a_canned_visit_is_not_quoted_back_by_recall(self):
        path = hq_visit_memory.visit_path(hq_culinia.growth_path())
        hq_visit_memory.record(
            path, self_key="culinia", other_key="forgia", other_name="Forgia",
            lines=[{"who": "forgia", "text": "Light settles it before anything else."}],
            source="canned")
        self.assertEqual(hq_visit_memory.hint(path, self_key="culinia", query="Hello Culinia"), "")

    def test_a_record_keeps_its_generated_source(self):
        code, payload = hq_assistant_visits.record({
            "host": "culinia", "visitor": "forgia", "source": "gemini",
            "lines": [{"who": "host", "text": "I taste three times."},
                      {"who": "visitor", "text": "Light decides."}]})
        self.assertEqual(code, 200)
        self.assertEqual(sorted(payload["recorded"]), ["culinia", "forgia"])
        row = hq_visit_memory.latest(
            hq_visit_memory.visit_path(hq_culinia.growth_path()),
            self_key="culinia", other_key="forgia")
        self.assertEqual(row["source"], "gemini")


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
                {"who": "culinia", "text": "I taste three times."},
                {"who": "else", "text": "I'm looking."},
            ])

    def test_else_recall_is_scoped_to_the_owner(self):
        self._record("alice")
        with self.memory.owner_context("alice"), self.memory.memory_scope("else"):
            packet = self.memory.context_packet("Hello Else", conversation_text="Hello Else")
            self.assertIn("VISITE RÉCENTE AVEC CULINIA", packet["continuity"])
        with self.memory.owner_context("bob"), self.memory.memory_scope("else"):
            packet = self.memory.context_packet("Hello Else", conversation_text="Hello Else")
            self.assertEqual(packet["continuity"], "")
        with self.memory.owner_context("alice"), self.memory.memory_scope("else"):
            ambient = self.memory.context_packet("Hello Else")
            self.assertEqual(ambient["continuity"], "")

    def test_else_visit_file_keeps_owner_hash_in_its_name(self):
        self._record("alice")
        files = list((self.root / ".hq-ai" / "companion-memory" / "else").glob("*_visits.json"))
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].name.endswith("_visits.json"))
        self.assertNotIn("alice", files[0].name)


class VisitBanterTests(unittest.TestCase):
    def setUp(self):
        hq_assistant_visits._reset_banter_limit()
        hq_assistant_visits._reset_telemetry()

    def test_generated_exchange_is_validated_and_mapped_to_the_two_assistants(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Oh, you came by."},
            {"who": "visitor", "text": "I came to see the light."},
            {"who": "host", "text": "It holds well."},
            {"who": "visitor", "text": "Back to the workshop."},
        ]})
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", return_value=raw) as generate:
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 200)
        self.assertEqual([line["who"] for line in payload["lines"]],
                         ["culinia", "forgia", "culinia", "forgia"])
        self.assertIn("Oh, you came by", payload["lines"][0]["text"])
        prompt = generate.call_args.args[0]
        self.assertIn("Culinia", prompt)
        self.assertIn("Forgia", prompt)
        self.assertIn("No hostility", prompt)

    def test_gemini_is_preferred_and_nvidia_is_not_called(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Oh, you came by."},
            {"who": "visitor", "text": "I came to see the light."},
            {"who": "host", "text": "It holds well."},
            {"who": "visitor", "text": "Back to the workshop."},
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
        self.assertEqual(args[0], hq_assistant_visits.GEMINI_VISIT_CHAIN[:1])
        self.assertTrue(kwargs["json_out"])
        self.assertEqual(kwargs["attempt_timeout"], hq_assistant_visits.GEMINI_ATTEMPT_TIMEOUT_S)
        self.assertTrue(kwargs["visit"], "visits use their own quota bucket")
        self.assertIn("Culinia", args[1])

    def test_a_bare_array_is_accepted_as_the_lines_list(self):
        raw = json.dumps([
            {"who": "Culinia", "text": "You left your jacket."},
            {"who": "Forgia", "text": "I forgot it on purpose."},
            {"who": "Culinia", "text": "It's gathering dust."},
            {"who": "Forgia", "text": "I'll go get it."},
        ])
        lines = hq_assistant_visits._parse_banter(raw, "culinia", "forgia", "checkin")
        self.assertEqual([line["who"] for line in lines], ["host", "visitor", "host", "visitor"])
        self.assertEqual(lines[0]["text"], "You left your jacket.")

    def test_visit_persona_is_a_voice_not_a_job_brief(self):
        prompt = hq_assistant_visits._banter_prompt("securia", "culinia", place="accueil", shape="checkin")
        self.assertIn("short, crisp, cautious", prompt)
        self.assertNotIn("sentinel", prompt)
        self.assertNotIn("quotes the time", prompt)
        prompt = hq_assistant_visits._banter_prompt("musica", "else", place="musique", shape="scene")
        self.assertNotIn("names her source", prompt)
        self.assertNotIn("vibration", prompt)

    def test_flyby_shape_gets_two_lines_and_safe_place_context(self):
        raw = json.dumps({"lines": [
            {"who": "visitor", "text": "I was passing through the Notebook."},
            {"who": "host", "text": "Good timing, I was about to close up."},
        ]})
        gemini = mock.Mock(return_value=(raw, "gemini-3.1-flash-lite"))
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", new=gemini):
            code, payload = hq_assistant_visits.banter(
                {"host": "culinia", "visitor": "forgia", "shape": "flyby", "place": "carnet"})
        self.assertEqual(code, 200)
        self.assertEqual(len(payload["lines"]), 2)
        prompt = gemini.call_args.args[1]
        self.assertIn("the Notebook", prompt)
        self.assertIn("exactly two lines", prompt)
        self.assertEqual(hq_assistant_visits._place("../secret"), "hq")

    def test_scene_shape_accepts_six_lines(self):
        raw = json.dumps({"lines": [
            {"who": "visitor", "text": "Oh, a visitor."},
            {"who": "host", "text": "Oh, you're passing."},
            {"who": "visitor", "text": "I was looking for a bit of calm."},
            {"who": "host", "text": "Stay a moment."},
            {"who": "visitor", "text": "I'd like that."},
            {"who": "host", "text": "Back to the workshop."},
        ]})
        gemini = mock.Mock(return_value=(raw, "gemini-3.1-flash-lite"))
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", new=gemini):
            code, payload = hq_assistant_visits.banter(
                {"host": "culinia", "visitor": "forgia", "shape": "scene"})
        self.assertEqual(code, 200)
        self.assertEqual(len(payload["lines"]), 6)
        self.assertIn("exactly six lines", gemini.call_args.args[1])

    def test_telemetry_counts_gemini_success_and_nvidia_fallback(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Oh."}, {"who": "visitor", "text": "Yes."},
            {"who": "host", "text": "Leaving already?"}, {"who": "visitor", "text": "Yes, I'm done."},
        ]})
        with mock.patch.object(hq_assistant_visits, "_gemini_generate",
                               return_value=(raw, "gemini-3.1-flash-lite")):
            self.assertEqual(hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})[0], 200)
        telemetry = hq_assistant_visits.settings_snapshot()["telemetry"]
        self.assertEqual((telemetry["gemini_ok"], telemetry["gemini_error"]), (1, 0))
        self.assertEqual(telemetry["last_provider"], "gemini")

        hq_assistant_visits._reset_banter_limit()
        with mock.patch.object(hq_assistant_visits, "_gemini_generate",
                               side_effect=RuntimeError("Gemini down")), \
                mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", return_value=raw):
            self.assertEqual(hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})[0], 200)
        telemetry = hq_assistant_visits.settings_snapshot()["telemetry"]
        # both Gemini models were tried before the fallback took over
        self.assertEqual((telemetry["gemini_ok"], telemetry["gemini_error"]), (1, 2))
        self.assertEqual((telemetry["nvidia_ok"], telemetry["nvidia_error"]), (1, 0))
        self.assertEqual((telemetry["last_provider"], telemetry["last_reason"]),
                         ("nvidia", "gemini_unavailable"))
        self.assertNotIn("culinia", json.dumps(telemetry))

    def test_gemini_failure_falls_back_to_nvidia(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Hello."},
            {"who": "visitor", "text": "Hi."},
            {"who": "host", "text": "Leaving already?"},
            {"who": "visitor", "text": "Yes, quite."},
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

    def test_a_failed_generation_does_not_spend_the_pair_slot(self):
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value=""), \
                mock.patch.object(hq_assistant_visits, "_gemini_generate", None):
            self.assertEqual(hq_assistant_visits.banter(
                {"host": "culinia", "visitor": "forgia"})[0], 503)
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Hello."}, {"who": "visitor", "text": "Hi."},
            {"who": "host", "text": "Leaving already?"}, {"who": "visitor", "text": "Yes, quite."},
        ]})
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", return_value=raw):
            self.assertEqual(hq_assistant_visits.banter(
                {"host": "culinia", "visitor": "forgia"})[0], 200)

    # ---- audit fixes: thread, retention, idempotency, pair slot, telemetry

    def test_the_slot_is_shared_by_both_orders_of_a_pair(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Closing up?"}, {"who": "visitor", "text": "Yes."},
            {"who": "host", "text": "Fine."}, {"who": "visitor", "text": "I'm passing."}]})
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", return_value=raw):
            self.assertEqual(hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})[0], 200)
            self.assertEqual(hq_assistant_visits.banter({"host": "forgia", "visitor": "culinia"})[0], 429)

    def test_a_missing_key_is_a_reason_not_an_nvidia_error(self):
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value=""), \
                mock.patch.object(hq_assistant_visits, "_gemini_generate", None):
            hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        telemetry = hq_assistant_visits.telemetry_snapshot()
        self.assertEqual(telemetry["nvidia_error"], 0)
        self.assertEqual(telemetry["reasons"], {"nvidia_not_configured": 1})

    def test_nvidia_retries_stop_at_the_server_budget(self):
        calls = []

        def slow(*args, **kwargs):
            calls.append(kwargs.get("timeout"))
            return "not json"
        ticks = iter([0.0, 0.0, 6.0, 12.0, hq_assistant_visits.BANTER_SERVER_BUDGET_S - 1.0, 99.0, 99.0, 99.0])
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_gemini_generate", None), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", side_effect=slow), \
                mock.patch.object(hq_assistant_visits.time, "monotonic", side_effect=lambda: next(ticks)):
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 502)
        self.assertLess(len(calls), 4)
        self.assertTrue(all(t <= hq_assistant_visits.NVIDIA_FALLBACK_TIMEOUT_S for t in calls))

    # ---- richer visits: true facts, private wants, forms, the Master's answer, voice

    def test_the_prompt_carries_a_form_private_wants_and_fixed_true_facts(self):
        facts = ["a print has just finished", "the Master is currently in the Forge"]
        prompt = hq_assistant_visits._banter_prompt(
            "forgia", "culinia", place="forge", shape="checkin",
            ctx={"form": "fragment", "wants": ("taquiner", "regard"), "facts": facts, "meetings": 7})
        self.assertIn("into the middle of a conversation already under way", prompt)
        self.assertIn(hq_assistant_visits.WANTS["taquiner"], prompt)
        self.assertIn(hq_assistant_visits.WANTS["regard"], prompt)
        self.assertIn("the only ones allowed: " + "; ".join(facts), prompt)
        self.assertIn("beyond the true facts given", prompt)
        self.assertIn("words of their own", prompt)
        plain = hq_assistant_visits._banter_prompt("forgia", "culinia")
        self.assertNotIn("True facts of the moment", plain)
        self.assertIn("Invent no precise fact:", plain)

    def test_true_facts_come_from_fresh_activity_in_fixed_words_only(self):
        now = time.time()
        rows = [{"kind": "print", "message": "C:\\\\secret\\\\plan.stl", "at": now - 60},
                {"kind": "print", "message": "again", "at": now - 90},
                {"kind": "backup", "message": "Dossiers", "at": now - 3 * 3600},
                {"kind": "screenshot", "message": "x", "at": now - 120},
                {"kind": "auth", "message": "pin", "at": now - 5}]
        hq_assistant_visits.bind(activity=lambda n: rows)
        try:
            facts = hq_assistant_visits._true_facts("hq")
            self.assertEqual(facts, [hq_assistant_visits.FACT_KINDS["print"],
                                     hq_assistant_visits.FACT_KINDS["screenshot"]])
            self.assertNotIn("secret", json.dumps(facts))
            self.assertEqual(hq_assistant_visits._true_facts("carnet")[-1],
                             hq_assistant_visits.FACT_KINDS["screenshot"])
        finally:
            hq_assistant_visits.bind()
        self.assertEqual(hq_assistant_visits._true_facts("carnet"),
                         ["the Master is currently in the Notebook"])

    def test_generated_lines_are_judged_on_voice(self):
        ok = [{"who": "host", "text": "Are you done?"}, {"who": "visitor", "text": "Almost."}]
        self.assertTrue(hq_assistant_visits._voice_ok(ok, "culinia", "forgia"))
        for bad in ("Hello to you.", "Forgia, are you coming?", "Two days ago.", "Perfect.",
                    "See you then."):
            rows = [{"who": "host", "text": bad}, {"who": "visitor", "text": "Almost."}]
            self.assertFalse(hq_assistant_visits._voice_ok(rows, "culinia", "forgia"), bad)
        long_else = [{"who": "host", "text": "I watch the light falling across the wall this evening."},
                     {"who": "visitor", "text": "Yes."}]
        self.assertFalse(hq_assistant_visits._voice_ok(long_else, "else", "forgia"))
        # the same line is fine for a sister whose voice runs longer
        self.assertTrue(hq_assistant_visits._voice_ok(long_else, "culinia", "forgia"))
        self.assertFalse(hq_assistant_visits._voice_ok(
            [{"who": "host", "text": "You were here yesterday."}, {"who": "visitor", "text": "Yes."}], "culinia", "forgia"))
        self.assertTrue(hq_assistant_visits._voice_ok(
            [{"who": "host", "text": "Stay a minute."}, {"who": "visitor", "text": "Another time."}],
            "culinia", "forgia"), "everyday hedges are not invented facts")

    def test_a_generic_gemini_reply_is_rewritten_once_before_falling_back(self):
        generic = json.dumps({"lines": [
            {"who": "host", "text": "Hello Forgia."}, {"who": "visitor", "text": "Hi."},
            {"who": "host", "text": "Leaving already?"}, {"who": "visitor", "text": "Yes."}]})
        good = json.dumps({"lines": [
            {"who": "host", "text": "Oh, you're here."}, {"who": "visitor", "text": "Just passing."},
            {"who": "host", "text": "Staying?"}, {"who": "visitor", "text": "A moment."}]})
        gemini = mock.Mock(side_effect=[(generic, "m"), (good, "m")])
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", new=gemini):
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual((code, payload["provider"]), (200, "gemini"))
        self.assertEqual(gemini.call_count, 2)
        self.assertIn("refused", gemini.call_args.args[1])
        telemetry = hq_assistant_visits.telemetry_snapshot()
        self.assertEqual((telemetry["gemini_ok"], telemetry["gemini_error"]), (1, 1))
        self.assertEqual(telemetry["reasons"], {"gemini_voice_rejected": 1, "voice_name": 1})
        self.assertIn("a first name appears", gemini.call_args.args[1],
                      "the rewrite is told what was wrong, not just that it was refused")

    def test_two_rejected_gemini_replies_fall_back_to_the_next_provider(self):
        generic = json.dumps({"lines": [
            {"who": "host", "text": "Hello."}, {"who": "visitor", "text": "Hi."},
            {"who": "host", "text": "Leaving already?"}, {"who": "visitor", "text": "Yes."}]})
        gemini = mock.Mock(return_value=(generic, "m"))
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", new=gemini), \
                mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value=""):
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(gemini.call_count, 2)
        self.assertEqual((code, payload["code"]), (502, "gemini_voice_rejected"))

    def test_the_visit_budget_default_covers_a_working_day(self):
        import hq_ai
        self.assertGreaterEqual(hq_ai.VISIT_DAILY, 100)

    def test_the_pulse_reports_recent_events_without_their_text(self):
        now = time.time()
        rows = [{"kind": "print", "message": "C:\\secret\\plan.stl", "at": now - 30},
                {"kind": "backup", "message": "Dossiers", "at": now - 20 * 60},
                {"kind": "auth", "message": "pin 1234", "at": now - 5},
                {"kind": "screenshot", "message": "x", "at": now - 90}]
        hq_assistant_visits.bind(activity=lambda n: rows)
        try:
            code, payload = hq_assistant_visits.http_get({"pulse": ["1"]})
        finally:
            hq_assistant_visits.bind()
        self.assertEqual(code, 200)
        self.assertEqual([(e["kind"], e["sister"]) for e in payload["events"]],
                         [("print", "pistonia"), ("screenshot", "forgia")])
        self.assertNotIn("secret", json.dumps(payload))
        self.assertNotIn("pin", json.dumps(payload))
        self.assertEqual(hq_assistant_visits.http_get({"pulse": ["1"]})[1]["events"], [])

    def test_a_gemini_visit_carries_its_wants_and_form_for_the_chips(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Oh, you're here."}, {"who": "visitor", "text": "Just passing."},
            {"who": "host", "text": "Staying?"}, {"who": "visitor", "text": "A moment."}]})
        with mock.patch.object(hq_assistant_visits, "_gemini_generate",
                               return_value=(raw, "m")), \
                mock.patch.object(hq_assistant_visits, "_pick_wants", return_value=("regard", "service")), \
                mock.patch.object(hq_assistant_visits, "_pick_form", return_value="porte"):
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 200)
        self.assertEqual(payload["wants"], {"host": "regard", "visitor": "service"})
        self.assertEqual(payload["form"], "porte")
        self.assertTrue(set(payload["wants"].values()) <= set(hq_assistant_visits.WANTS))

    def test_the_nvidia_fallback_sends_no_wants(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Oh, you're here."}, {"who": "visitor", "text": "Just passing."},
            {"who": "host", "text": "Staying?"}, {"who": "visitor", "text": "A moment."}]})
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", None), \
                mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", return_value=raw):
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 200)
        self.assertNotIn("wants", payload)

    def test_the_two_wants_always_differ(self):
        for _ in range(300):
            first, second = hq_assistant_visits._pick_wants()
            self.assertNotEqual(first, second)
            self.assertIn(first, hq_assistant_visits.WANTS)
            self.assertIn(second, hq_assistant_visits.WANTS)

    def test_each_sister_is_given_lines_to_hear_not_only_an_adjective(self):
        for key in hq_assistant_visits.KEYS:
            samples = hq_assistant_visits.VOICE_SAMPLES[key]
            self.assertGreaterEqual(len(samples), 3, key)
            limit = hq_assistant_visits.VOICE_MAX_WORDS[key]
            for line in samples:
                self.assertLessEqual(len(line.split()), limit, f"{key}: {line}")
        prompt = hq_assistant_visits._banter_prompt("securia", "else")
        self.assertIn("Everything's shut.", prompt)
        self.assertIn("I was just looking.", prompt)
        self.assertIn("never these exact sentences", prompt)
        # no sample names a sister or talks shop: they are voices, not content
        every = " ".join(" ".join(v) for v in hq_assistant_visits.VOICE_SAMPLES.values())
        self.assertIsNone(hq_assistant_visits._JOB_WORDS.search(every.replace("I'm noting", "")))

    def test_the_prompt_asks_for_a_reply_that_answers_and_one_small_prop(self):
        prompt = hq_assistant_visits._banter_prompt("culinia", "forgia")
        self.assertIn("answers the previous one", prompt)
        self.assertIn("No specific object or new place", prompt)
        self.assertIn("no cup, coat, pen", prompt)
        self.assertIn("avoid \"You still\"", prompt)
        self.assertIn("you should still recognise who is speaking", prompt)
        self.assertIn("Never talk about your work", prompt)

    def test_a_long_running_thread_must_be_closed_in_other_words(self):
        prompt = hq_assistant_visits._banter_prompt(
            "culinia", "forgia", last_thread="The door creaks.", ctx={"depth": 3})
        self.assertIn("settle it", prompt)
        self.assertIn("never word for word", prompt)

    def test_a_recited_thread_is_rejected_with_its_reason(self):
        rows = [{"who": "host", "text": "You were looking for the right light."},
                {"who": "visitor", "text": "Not anymore."}]
        problem = hq_assistant_visits._voice_problem(
            rows, "else", "forgia", thread="You were looking for the right light.")
        self.assertEqual(problem[0], "thread_echo")
        self.assertIsNone(hq_assistant_visits._voice_problem(
            rows, "else", "forgia", thread="Another sentence of the thread."))

    def test_shop_talk_is_rejected_unless_the_true_fact_carries_the_word(self):
        rows = [{"who": "host", "text": "The backup is done."},
                {"who": "visitor", "text": "At last."}]
        self.assertEqual(hq_assistant_visits._voice_problem(rows, "securia", "culinia")[0], "shop_talk")
        self.assertIsNone(hq_assistant_visits._voice_problem(
            rows, "securia", "culinia", facts=["a backup has just finished"]))
        work = [{"who": "host", "text": "Your verifications again."}, {"who": "visitor", "text": "Yes."}]
        self.assertEqual(hq_assistant_visits._voice_problem(
            work, "securia", "culinia", facts=["a backup has just finished"])[0], "shop_talk")

    def test_the_voice_problem_names_which_sister_ran_long(self):
        rows = [{"who": "host", "text": "I was watching the light that fell on that wall already yesterday."},
                {"who": "visitor", "text": "Yes."}]
        code, reason = hq_assistant_visits._voice_problem(rows, "else", "forgia")
        self.assertEqual(code, "invented_fact")  # "soir" is an invented moment, found first
        rows = [{"who": "host", "text": "I was watching the light fall across the wall without saying anything."},
                {"who": "visitor", "text": "Yes."}]
        code, reason = hq_assistant_visits._voice_problem(rows, "else", "forgia")
        self.assertEqual(code, "length")
        self.assertIn("Else", reason)
        self.assertIn("8", reason)

    def test_a_line_lifted_from_the_voice_examples_is_rejected(self):
        rows = [{"who": "host", "text": "Hm. We'll see."}, {"who": "visitor", "text": "Plus tard."}]
        self.assertEqual(hq_assistant_visits._voice_problem(rows, "else", "pistonia")[0], "sample_copy")
        near = [{"who": "host", "text": "Come on, sit down for a minute."}, {"who": "visitor", "text": "Non."}]
        self.assertEqual(hq_assistant_visits._voice_problem(near, "culinia", "forgia")[0], "sample_copy")
        fresh = [{"who": "host", "text": "You walk like someone who hesitates."},
                 {"who": "visitor", "text": "I don't hesitate."}]
        self.assertIsNone(hq_assistant_visits._voice_problem(fresh, "culinia", "forgia"))

    def test_invented_clock_times_are_rejected_but_hedges_are_not(self):
        for bad in ("The copy has been done since noon.", "You've carried that for an hour.",
                    "It's due Monday.", "He left yesterday."):
            rows = [{"who": "host", "text": bad}, {"who": "visitor", "text": "Yes."}]
            self.assertEqual(hq_assistant_visits._voice_problem(rows, "culinia", "forgia")[0],
                             "invented_fact", bad)
        for fine in ("Stay a moment.", "Another time.", "Give me a minute.", "Today, maybe."):
            rows = [{"who": "host", "text": fine}, {"who": "visitor", "text": "Yes."}]
            self.assertIsNone(hq_assistant_visits._voice_problem(rows, "culinia", "forgia"), fine)

    def test_openings_that_became_a_tic_are_named_to_the_next_visit(self):
        hq_assistant_visits._reset_recent_lines()
        hq_assistant_visits._remember_lines([
            {"who": "host", "text": "You still have your coat."},
            {"who": "visitor", "text": "Yes."},
            {"who": "host", "text": "You still left the door open."},
            {"who": "visitor", "text": "A little."}])
        recent = hq_assistant_visits._recent_context()
        self.assertEqual(recent["tics"], ["you still"])
        prompt = hq_assistant_visits._banter_prompt("culinia", "forgia", ctx={"recent": recent})
        self.assertIn("Do not start any line with: \u201cyou still ...\u201d", prompt)
        self.assertIn("You still left the door open.", prompt)
        hq_assistant_visits._reset_recent_lines()
        self.assertEqual(hq_assistant_visits._recent_context(), {"tics": [], "worn": [], "recent": []})

    def test_a_word_every_visit_reaches_for_is_named_as_worn(self):
        hq_assistant_visits._reset_recent_lines()
        hq_assistant_visits._remember_lines([
            {"who": "host", "text": "You keep walking on tiptoe."},
            {"who": "visitor", "text": "Tiptoe, yes."},
            {"who": "host", "text": "Still on tiptoe?"},
            {"who": "visitor", "text": "Always."}])
        recent = hq_assistant_visits._recent_context()
        try:
            self.assertIn("tiptoe", recent["worn"])
            self.assertNotIn("always", recent["worn"], "filler words are not tics")
            prompt = hq_assistant_visits._banter_prompt("culinia", "forgia", ctx={"recent": recent})
            self.assertIn("Words heard too often lately, avoid them: tiptoe", prompt)
        finally:
            hq_assistant_visits._reset_recent_lines()

    def test_a_served_gemini_visit_is_remembered_for_the_next_prompt(self):
        hq_assistant_visits._reset_recent_lines()
        raw = json.dumps({"lines": [
            {"who": "host", "text": "You walk softly."}, {"who": "visitor", "text": "I'm thinking."},
            {"who": "host", "text": "Want to sit?"}, {"who": "visitor", "text": "Not yet."}]})
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", return_value=(raw, "m")):
            self.assertEqual(hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})[0], 200)
        try:
            self.assertEqual(hq_assistant_visits._recent_context()["recent"][-1], "Not yet.")
        finally:
            hq_assistant_visits._reset_recent_lines()

    def test_a_hung_provider_does_not_outlive_the_request_budget(self):
        def hang(*args, **kwargs):
            time.sleep(3)
            return "{}", "m"
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            hq_assistant_visits._within(0.5, hang)
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertEqual(hq_assistant_visits._within(2.0, lambda: ("ok", "m")), ("ok", "m"))
        with self.assertRaises(ValueError):
            hq_assistant_visits._within(2.0, lambda: (_ for _ in ()).throw(ValueError("x")))

    def test_an_overloaded_model_hands_the_visit_to_the_next_one(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "You walk softly."}, {"who": "visitor", "text": "I'm thinking."},
            {"who": "host", "text": "Want to sit?"}, {"who": "visitor", "text": "Not yet."}]})

        class Busy(Exception):
            code = "busy"
            status = 503
        gemini = mock.Mock(side_effect=[Busy("high demand"), (raw, "m")])
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", new=gemini):
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual((code, payload["provider"]), (200, "gemini"))
        first, second = (c.args[0] for c in gemini.call_args_list)
        self.assertEqual(first, hq_assistant_visits.GEMINI_VISIT_CHAIN[:1])
        self.assertEqual(second, hq_assistant_visits.GEMINI_VISIT_CHAIN[1:2])
        telemetry = hq_assistant_visits.telemetry_snapshot()
        self.assertEqual((telemetry["gemini_ok"], telemetry["gemini_error"]), (1, 1))

    def test_a_refused_key_does_not_try_another_model(self):
        class Denied(Exception):
            code = "auth"
            status = 403
        gemini = mock.Mock(side_effect=Denied("denied"))
        with mock.patch.object(hq_assistant_visits, "_gemini_generate", new=gemini), \
                mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value=""):
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(gemini.call_count, 1)
        self.assertEqual(payload["code"], "gemini_auth")

    def test_the_cooldown_is_per_pair(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Hello."}, {"who": "visitor", "text": "Hi."},
            {"who": "host", "text": "Leaving already?"}, {"who": "visitor", "text": "Yes, quite."},
        ]})
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", return_value=raw):
            self.assertEqual(hq_assistant_visits.banter(
                {"host": "culinia", "visitor": "forgia"})[0], 200)
            self.assertEqual(hq_assistant_visits.banter(
                {"host": "culinia", "visitor": "musica"})[0], 200)
            self.assertEqual(hq_assistant_visits.banter(
                {"host": "culinia", "visitor": "forgia"})[0], 429)

    def test_requests_and_rate_limits_are_counted(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "a"}, {"who": "visitor", "text": "b"},
            {"who": "host", "text": "c"}, {"who": "visitor", "text": "d"},
        ]})
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", return_value=raw):
            self.assertEqual(hq_assistant_visits.banter(
                {"host": "culinia", "visitor": "forgia"})[0], 200)
            self.assertEqual(hq_assistant_visits.banter(
                {"host": "culinia", "visitor": "forgia"})[0], 429)
        telemetry = hq_assistant_visits.settings_snapshot()["telemetry"]
        self.assertEqual((telemetry["requests"], telemetry["rate_limited"]), (2, 1))

    def test_bad_model_output_returns_a_fallback_error(self):
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat", return_value="not json"):
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 502)
        self.assertEqual(payload["code"], "invalid_output")

    def test_missing_nvidia_key_returns_a_fallback_error_without_a_call(self):
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value=""), \
                mock.patch.object(hq_assistant_visits, "_gemini_generate", None), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat") as generate:
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 503)
        self.assertEqual(payload["code"], "nvidia_not_configured")
        generate.assert_not_called()

    def test_nvidia_request_uses_the_configured_model_and_bearer_key(self):
        raw = json.dumps({"lines": [
            {"who": "host", "text": "Hello."}, {"who": "visitor", "text": "Hi."},
            {"who": "host", "text": "Leaving already?"}, {"who": "visitor", "text": "Yes, quite."},
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


class VisitPairNoteTests(unittest.TestCase):
    """The visit carries a pair's unspoken edge, and only a pair that has one."""

    def setUp(self):
        import hq_personhood as ph
        import hq_relationships as rel
        self.root = Path(tempfile.mkdtemp(prefix="hq-visit-note-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        memory.bind(root=self.root, now=time.time())
        self.ph, self.rel = ph, rel

    def _seed(self, a, b):
        with memory.owner_context("admin"):
            self.ph.observe_chat(a, "Le four tient.", now=time.time() - 86400, owner="admin")
            self.ph.observe_chat(b, "La salle tient.", now=time.time() - 86400, owner="admin")
            self.rel.note_exchange(None, a, b, "Le four et la salle se sont parlé.",
                                   now=time.time(), owner="admin")

    def test_a_pair_that_shares_nothing_gets_no_note(self):
        self._seed("culinia", "pistonia")
        self.assertEqual(hq_assistant_visits._pair_note("culinia", "musica", "admin"), "")
        self.assertEqual(hq_assistant_visits._pair_note("culinia", "pistonia", "admin").count("Something passes"), 1)

    def test_the_note_speaks_each_womans_own_stance_and_forbids_naming_it(self):
        self._seed("culinia", "pistonia")
        note = hq_assistant_visits._pair_note("culinia", "pistonia", "admin")
        self.assertIn("offers what she has before being asked", note)
        self.assertIn("answers with one plain fact", note)
        self.assertIn("not to be named", note)
        self.assertIn("no work, no tools, no numbers", note)
        prompt = hq_assistant_visits._banter_prompt("culinia", "pistonia", pair_note=note)
        self.assertIn("offers what she has before being asked", prompt)
        self.assertIn("no naming of any secret", prompt)
        plain = hq_assistant_visits._banter_prompt("culinia", "pistonia")
        self.assertNotIn("Something passes between them", plain)

    def test_an_earned_bond_outlives_the_day_rows_it_was_read_from(self):
        import hq_personas
        # With no heart days left, the live gate is silent…
        self.assertEqual(hq_personas.echo_line("culinia", "pistonia", days=1, exchanges=1,
                                              a_heart_days=0, b_heart_days=0, lang="fr"), "")
        # …but a bond earned once still speaks, on the pair's own record alone.
        earned = hq_personas.echo_line("culinia", "pistonia", days=1, exchanges=1,
                                       a_heart_days=0, b_heart_days=0, lang="fr", earned=True)
        self.assertIn("Pistonia", earned)
        self.assertTrue(hq_personas.echo_prompt("culinia", "pistonia", days=1, exchanges=1,
                                                a_heart_days=0, b_heart_days=0, lang="fr",
                                                earned=True))
        # The milestone itself is idempotent and lives beside the pair's evidence.
        with memory.owner_context("admin"):
            first = self.rel.mark_echo(None, "culinia", "pistonia", owner="admin")
            again = self.rel.mark_echo(None, "culinia", "pistonia", owner="admin")
            self.assertTrue(first > 0)
            self.assertEqual(first, again)
            self.assertEqual(self.rel.echo_earned(None, "culinia", "pistonia", owner="admin"), first)
            self.assertEqual(self.rel.echo_earned(None, "musica", "pistonia", owner="admin"), 0.0)

    def test_the_note_survives_aged_out_day_rows(self):
        """Regression: a real day ages out of retention, the earned note stays."""
        import hq_assistant_voice as voice
        with memory.owner_context("admin"):
            self.rel.mark_echo(None, "culinia", "pistonia", owner="admin")
            real_bond = voice.bond
            voice.bond = lambda key, *, owner=None: {"days": 0, "turns": 0}
            try:
                self.assertTrue(voice.echo_for("culinia", "pistonia", owner="admin"))
                self.assertIn("Something passes between them",
                              hq_assistant_visits._pair_note("culinia", "pistonia", "admin"))
                # A pair that never earned it stays silent with the same ageing.
                self.assertEqual(voice.echo_for("culinia", "musica", owner="admin"), "")
                self.assertEqual(hq_assistant_visits._pair_note("culinia", "musica", "admin"), "")
            finally:
                voice.bond = real_bond

    def test_the_visit_route_hands_the_note_to_the_prompt(self):
        self._seed("culinia", "pistonia")
        original, original_gen = hq_assistant_visits._banter_prompt, hq_assistant_visits._gemini_generate
        seen = {}

        def spy(host, visitor, **kwargs):
            seen.update(kwargs)
            return original(host, visitor, **kwargs)

        def offline(*_args, **_kwargs):
            raise RuntimeError("offline")

        hq_assistant_visits._banter_prompt = spy
        hq_assistant_visits._gemini_generate = offline
        self.addCleanup(setattr, hq_assistant_visits, "_banter_prompt", original)
        self.addCleanup(setattr, hq_assistant_visits, "_gemini_generate", original_gen)
        hq_assistant_visits.banter({"host": "culinia", "visitor": "pistonia",
                                    "shape": "checkin", "place": "hq"}, owner_id="admin")
        self.assertIn("Something passes between them", seen.get("pair_note") or "")


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

    def test_provider_failures_keep_a_count_per_reason_and_the_budget(self):
        hq_assistant_visits.bind(root=self.root, budget=lambda: {"used": 3, "per_day": 8})
        hq_assistant_visits._note_telemetry("gemini", False, "gemini_timeout")
        hq_assistant_visits._note_telemetry("gemini", False, "gemini_timeout")
        hq_assistant_visits._note_telemetry("gemini", False, "gemini_visit_quota")
        telemetry = hq_assistant_visits.telemetry_snapshot()
        self.assertEqual(telemetry["reasons"], {"gemini_timeout": 2, "gemini_visit_quota": 1})
        self.assertEqual(telemetry["visit_budget"], {"used": 3, "per_day": 8})
        hq_assistant_visits.bind(root=self.root)
        self.assertEqual(hq_assistant_visits.telemetry_snapshot()["reasons"],
                         {"gemini_timeout": 2, "gemini_visit_quota": 1})

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
        hq_assistant_visits._reset_banter_limit()
        with mock.patch.object(hq_assistant_visits, "_nvidia_key", return_value="nvapi-test"), \
                mock.patch.object(hq_assistant_visits, "_nvidia_chat",
                                  side_effect=HTTPError("https://nvidia.test", 429, "limited", None, None)):
            code, payload = hq_assistant_visits.banter({"host": "culinia", "visitor": "forgia"})
        self.assertEqual(code, 502)
        self.assertEqual(payload["code"], "nvidia_rate_limited")


if __name__ == "__main__":
    unittest.main()
