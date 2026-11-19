"""Local memory meaning, owner boundaries, shared follow-through and migration."""
import json
import threading
from pathlib import Path
from unittest import mock

import hq_ai as ai
import hq_companion_growth as growth
import hq_companion_memory as memory
import hq_personhood
from tests import hq_assistant_state
from tests.test_hq_ai import Base, DEV, DEV2, reply

setUpModule = hq_assistant_state.set_up
tearDownModule = hq_assistant_state.tear_down


class MemoryTests(Base):
    def setUp(self):
        super().setUp()
        # Run the post-reply moment extraction inline: as a real daemon thread it could add a model call
        # between two assertions, or write into the temp root while tearDown deletes it (intermittent).
        ai.bind(spawn=lambda fn: fn())

    def tearDown(self):
        ai._cb.pop("spawn", None)
        super().tearDown()

    def api(self, op, *, device=DEV, owner="admin", **kwargs):
        return ai.http_post({"action": "transferania", "op": op, "device_id": device, **kwargs}, owner_id=owner, role="admin")

    def send(self, text, *, device=DEV, owner="admin"):
        code, data = self.api("send", device=device, owner=owner, message=text, persona="warm")
        self.assertEqual(code, 200, data)
        return data

    def profile(self, *, device=DEV, owner="admin"):
        code, data = self.api("memory", device=device, owner=owner)
        self.assertEqual(code, 200, data)
        return data

    def test_positive_and_negative_statements_keep_their_meaning(self):
        self.send("J'aime le café.")
        self.clock[0] += 10
        self.send("En fait, je n'aime plus le café.", device=DEV2)
        memories = self.profile()["memories"]
        active = [m["text"] for m in memories]
        self.assertIn("En fait, je n'aime plus le café", active)
        self.assertNotIn("J'aime le café", active)
        selected, _ = memory.context("café")
        self.assertEqual(selected, ["En fait, je n'aime plus le café"])

    def test_pc_and_phone_share_memories_not_raw_conversations(self):
        self.send("I prefer coffee.")
        self.assertIn("I prefer coffee", [m["text"] for m in self.profile(device=DEV2)["memories"]])
        phone = ai.transferania_history(device_id=DEV2)
        self.assertEqual(phone["messages"], [])
        before = len(self.calls)
        self.send("What do I like about coffee?", device=DEV2)
        self.assertEqual(len(self.calls), before + 1)
        prompt = json.dumps(self.calls[-1][1])
        self.assertIn("I prefer coffee", prompt)
        self.assertEqual(len(ai.load_transferania(DEV)["messages"]), 2)

    def test_owner_isolation_and_client_cannot_choose_another_owner(self):
        self.send("I dislike coffee.", owner="alice")
        self.assertTrue(self.profile(owner="alice", device=DEV2)["memories"])
        self.assertFalse(self.profile(owner="bob")["memories"])
        code, data = ai.http_post({"action": "transferania", "op": "memory", "device_id": DEV,
                                  "owner_id": "alice"}, owner_id="bob", role="admin")
        self.assertEqual(code, 200)
        self.assertFalse(data["memories"])
        code, data = ai.http_get({"transferania": ["1"], "device_id": [DEV]}, owner_id="bob", role="admin")
        self.assertEqual(code, 200)
        self.assertEqual(data["messages"], [])

    def test_upload_role_cannot_read_shared_memories(self):
        code, _ = ai.http_post({"action": "transferania", "op": "memory", "device_id": DEV}, role="upload")
        self.assertEqual(code, 403)

    def test_questions_hypotheticals_quotes_and_assistant_claims_are_not_facts(self):
        for text in ("Do I like coffee?", "Si j'aime le café, que proposes-tu ?", '"I love coffee."',
                     '"I love coffee. I hate tea."', 'She said "I like coffee. I hate tea."',
                     "She says I love coffee.", "If I loved coffee I would buy some.",
                     "Imagine I love coffee. I hate tea."):
            self.assertFalse(memory.extract(text), text)
        memory.observe_reply("bonjour", "Tu adores le café.", DEV)
        self.assertFalse(memory.snapshot()["memories"])

    def test_compound_preferences_keep_separate_polarities(self):
        items = memory.extract("Je n'aime pas le café mais j'adore le thé.")
        self.assertEqual(len(items), 2)
        self.assertEqual([item["polarity"] for item in items], ["negative", "positive"])

    def test_temporary_state_expires_without_losing_preferences(self):
        self.send("Je suis fatigué. J'aime le café.")
        self.assertEqual(len(self.profile()["memories"]), 2)
        self.clock[0] += 6 * 3600 + 1
        memories = self.profile(device=DEV2)["memories"]
        self.assertEqual([m["text"] for m in memories], ["J'aime le café"])
        self.assertFalse(memory.context("fatigué")[0])

    def test_followup_resolves_on_outcome_from_other_device(self):
        self.send("Je travaille sur le robot.")
        followups = self.profile()["followups"]
        self.assertEqual(len(followups), 1)
        self.assertEqual(followups[0]["status"], "awaiting_outcome")
        self.send("J'ai fini le robot.", device=DEV2)
        self.assertFalse(self.profile()["followups"])

    def test_specific_question_is_answered_but_greeting_does_not_clear_it(self):
        self.answers = [reply("Do you prefer coffee hot or cold?")]
        self.send("I like coffee.")
        self.assertEqual(self.profile()["followups"][0]["status"], "awaiting_user")
        self.send("bonjour", device=DEV2)
        self.assertTrue(self.profile()["followups"])
        self.send("I prefer cold coffee.", device=DEV2)
        self.assertFalse(self.profile()["followups"])

    def test_generic_question_does_not_become_a_followup(self):
        memory.observe_reply("bonjour", "Comment ça va ?", DEV)
        self.assertFalse(memory.snapshot()["followups"])

    def test_followup_is_shared_and_cooldown_prevents_repeated_prompts(self):
        self.send("Je travaille sur le robot.")
        self.assertEqual(memory.context("bonjour", reserve_followup=True)[1], "")
        self.clock[0] += 86401
        _, hint = memory.context("bonjour", reserve_followup=True)
        self.assertIn("robot", hint)
        self.assertEqual(memory.context("bonjour", reserve_followup=True)[1], "")
        self.assertTrue(self.profile(device=DEV2)["followups"])
        self.clock[0] += 21601
        self.assertIn("robot", memory.context("bonjour", reserve_followup=True)[1])

    def _tense(self, key="transferania"):
        hq_personhood.record_event(key, kind="tool", outcome="failed", now=self.clock[0])
        hq_personhood.record_event(key, kind="error", outcome="failed", now=self.clock[0])

    def test_personhood_gate_fails_open_when_it_raises(self):
        memory.observe_reply("Je travaille sur le robot.", "Tu as fini le robot ?", DEV)
        self.clock[0] += 86401
        with mock.patch.object(hq_personhood, "withholds_initiative", side_effect=RuntimeError("self file")):
            packet = memory.context_packet("Tu as fini le robot ?", conversation_text="Tu as fini le robot ?")
        # A broken personhood read must never cost her the offer or the reply.
        self.assertIn("SUJET EN ATTENTE", packet["continuity"])
        self.assertEqual(packet["presence"]["continuity_kind"], "followup")

    def test_tense_grade_still_returns_the_requested_episode(self):
        memory.observe_user("On a décidé de refaire le robot.", DEV)
        self.clock[0] += 86401
        self._tense()
        packet = memory.context_packet("Tu te souviens du robot ?", conversation_text="Tu te souviens du robot ?")
        # Recall is an answer, not an initiative: the gate must not touch it.
        self.assertIn("ÉPISODE ÉNONCÉ", packet["continuity"])
        self.assertEqual(packet["presence"]["continuity_kind"], "episode")

    def test_tense_grade_does_not_register_a_new_followup(self):
        self._tense()
        memory.observe_reply("Je travaille sur le robot.", "Tu as fini le robot ?", DEV)
        self.assertFalse(memory.snapshot()["followups"])

    def test_tense_grade_withholds_the_absence_callback(self):
        memory.observe_user("On a décidé de refaire le robot.", DEV)
        self.clock[0] += 86401
        memory.observe_user("bonjour", DEV)
        calm = memory.context_packet("robot", conversation_text="robot")
        self.assertIn("ÉPISODE ÉNONCÉ", calm["continuity"])
        self._tense()
        tense = memory.context_packet("robot", conversation_text="robot")
        self.assertEqual(tense["continuity"], "")
        self.assertEqual(tense["presence"]["continuity_kind"], "none")

    def test_tense_grade_never_asks_growth_for_a_callback(self):
        memory.observe_user("On a décidé de refaire le robot.", DEV)
        self.clock[0] += 7200
        with mock.patch.object(growth, "natural_callback", return_value=None) as motif:
            memory.context_packet("jazz", conversation_text="jazz")
        self.assertEqual(motif.call_count, 1)
        self._tense()
        with mock.patch.object(growth, "natural_callback", return_value=None) as motif:
            memory.context_packet("jazz", conversation_text="jazz")
        self.assertEqual(motif.call_count, 0)

    def test_tense_grade_withholds_the_visit_continuity_hint(self):
        memory.record_visit(other_key="forgia", other_name="Forgia", lines=[{"who": "forgia", "text": "Le rendu tient."}])
        self.clock[0] += 60
        calm = memory.context_packet("Forgia a fini le rendu ?", conversation_text="Forgia a fini le rendu ?")
        self.assertIn("VISITE RÉCENTE", calm["continuity"])
        self._tense()
        tense = memory.context_packet("Forgia a fini le rendu ?", conversation_text="Forgia a fini le rendu ?")
        self.assertNotIn("VISITE RÉCENTE", tense["continuity"])
        # …but an explicitly requested visit is recall and still comes back.
        asked = memory.context_packet("Tu te souviens de Forgia ?", conversation_text="Tu te souviens de Forgia ?")
        self.assertIn("VISITE RÉCENTE", asked["continuity"])

    def _ambient_call(self, fn, *args, **kwargs):
        """The ambient paths coalesce and cool down, so prime, then let it decide."""
        fn(*args, **kwargs)
        self.clock[0] += 9
        return fn(*args, **kwargs)

    def test_open_thread_line_reaches_continuity_only_when_the_grade_allows_it(self):
        snap = {"ok": True, "affect": {"withholds": False, "energy": .5, "tension": .1, "warmth": .5},
                "preoccupations": [{"label": "On prépare une soupe de courge.", "at": self.clock[0] - 60}],
                "pair_threads": [], "contested": [], "self_notes": [], "values": []}
        with mock.patch.object(hq_personhood, "snapshot", return_value=snap):
            calm = memory.context_packet("Tu penses à la courge ?", conversation_text="Tu penses à la courge ?")
        self.assertIn("SUJET RÉCENT", calm["continuity"])
        held = {**snap, "affect": {**snap["affect"], "withholds": True}}
        with mock.patch.object(hq_personhood, "snapshot", return_value=held):
            tense = memory.context_packet("Tu penses à la courge ?", conversation_text="Tu penses à la courge ?")
        self.assertEqual(tense["continuity"], "")

    def test_open_thread_is_offered_when_calm_and_withheld_when_tense(self):
        def seed():
            hq_personhood.observe_chat("transferania", "On prépare une soupe de courge.", now=self.clock[0] - 300)
        seed()
        calm = memory.context_packet("Tu penses à la courge ?", conversation_text="Tu penses à la courge ?")
        self.assertIn("SUJET RÉCENT", calm["continuity"])
        path = hq_personhood.self_path("transferania")
        if path and path.exists():
            path.unlink()
        seed()
        self._tense()
        tense = memory.context_packet("Tu penses à la courge ?", conversation_text="Tu penses à la courge ?")
        self.assertNotIn("SUJET RÉCENT", tense["continuity"])

    def test_tense_grade_silences_the_spontaneous_ambient_message(self):
        calm = self._ambient_call(ai.ambient, "accueil", "calme", "warm", device_id=DEV)
        self.assertFalse(calm.get("skipped"))
        self._tense()
        self.clock[0] += 130  # clear the ambient cooldown; the tension is still fresh
        tense = self._ambient_call(ai.ambient, "accueil", "tendu", "warm", device_id=DEV)
        self.assertTrue(tense.get("skipped"))
        self.assertEqual(tense.get("reason"), "withheld")

    def test_tense_grade_silences_the_else_aside(self):
        calm = self._ambient_call(ai.else_ambient, "accueil", "calme", "warm", device_id=DEV)
        self.assertNotEqual(calm.get("reason"), "withheld")
        self.clock[0] += 25 * 3600
        self._tense("else")
        tense = self._ambient_call(ai.else_ambient, "accueil", "tendu", "warm", device_id=DEV)
        self.assertTrue(tense.get("skipped"))
        self.assertEqual(tense.get("reason"), "withheld")

    def test_tense_grade_withholds_the_followup_offer_structurally(self):
        memory.observe_reply("Je travaille sur le robot.", "Tu as fini le robot ?", DEV)
        self.clock[0] += 86401
        calm = memory.context_packet("Tu as fini le robot ?", conversation_text="Tu as fini le robot ?")
        self.assertIn("SUJET EN ATTENTE", calm["continuity"])
        self.assertEqual(calm["presence"]["continuity_kind"], "followup")
        # Same pending follow-up, but a tense grade: the memory layer stops
        # offering it instead of asking the model to hold back.
        hq_personhood.record_event("transferania", kind="tool", outcome="failed", now=self.clock[0])
        hq_personhood.record_event("transferania", kind="error", outcome="failed", now=self.clock[0])
        tense = memory.context_packet("Tu as fini le robot ?", conversation_text="Tu as fini le robot ?")
        self.assertEqual(tense["continuity"], "")
        self.assertEqual(tense["presence"]["continuity_kind"], "none")
        self.assertIsNone(tense["reservation"])
        # Withheld, not forgotten: the record is still pending for a calmer turn.
        self.assertTrue(memory.snapshot()["followups"])

    def test_manual_close_prevents_further_followup(self):
        self.send("Je travaille sur le robot.")
        item = self.profile()["followups"][0]
        self.api("followup_close", id=item["id"], device=DEV2)
        self.clock[0] += 86401
        self.assertFalse(memory.context("robot")[1])

    def test_legacy_fragments_need_confirmation_and_cost_no_api_calls(self):
        data = ai._empty_transferania()
        data["facts"] = ["café noir"]
        ai.save_transferania(data, DEV)
        records = self.profile()["memories"]
        self.assertEqual(records[0]["evidence"], "legacy_unverified")
        self.assertFalse(memory.context("café noir")[0])
        self.assertFalse(self.calls)
        code, _ = self.api("memory_correct", id=records[0]["id"], text="Je déteste le café noir", device=DEV2)
        self.assertEqual(code, 200)
        self.assertEqual(memory.context("café noir")[0], ["Je déteste le café noir"])
        self.assertFalse(self.calls)

    def test_legacy_full_user_messages_migrate_with_source_and_polarity(self):
        data = ai._empty_transferania()
        data["messages"] = [{"role": "user", "text": "I dislike coffee.", "ts": self.clock[0]}]
        ai.save_transferania(data, DEV)
        result = self.profile()
        self.assertEqual(result["memories"][0]["text"], "I dislike coffee")
        self.assertEqual(memory.context("coffee")[0], ["I dislike coffee"])
        stored = json.loads(memory.path().read_text("utf-8"))
        self.assertEqual(stored["memories"][0]["polarity"], "negative")
        self.assertEqual(stored["memories"][0]["source_device"], DEV)
        self.assertFalse(self.calls)

    def test_forgetting_blocks_resurrection_on_another_device(self):
        self.send("J'aime le café.")
        item = self.profile()["memories"][0]
        self.api("memory_forget", id=item["id"])
        old = ai._empty_transferania()
        old["messages"] = [{"role": "user", "text": "J'aime le café.", "ts": self.clock[0] + 100}]
        ai.save_transferania(old, DEV2)
        self.assertFalse(self.profile(device=DEV2)["memories"])
        self.assertFalse(memory.context("café")[0])

    def test_older_device_does_not_override_newer_correction(self):
        self.send("Je déteste le café.")
        old = ai._empty_transferania()
        old["messages"] = [{"role": "user", "text": "J'aime le café.", "ts": self.clock[0] - 100}]
        ai.save_transferania(old, DEV2)
        self.profile(device=DEV2)
        self.assertEqual(memory.context("café")[0], ["Je déteste le café"])

    def test_corrupt_shared_profile_is_not_overwritten(self):
        self.send("I prefer coffee.")
        p = memory.path()
        p.write_text("{broken", encoding="utf-8")
        code, data = self.api("memory")
        self.assertEqual(code, 503)
        self.assertEqual(data["code"], "companion_memory_unavailable")
        self.assertEqual(p.read_text("utf-8"), "{broken")

    def test_parallel_devices_do_not_lose_shared_updates(self):
        errors = []
        def observe(text, device):
            try:
                memory.observe_user(text, device)
            except Exception as error:
                errors.append(error)
        workers = [threading.Thread(target=observe, args=("J'aime le café.", DEV)),
                   threading.Thread(target=observe, args=("Je préfère le thé.", DEV2))]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(5)
        self.assertFalse(errors)
        self.assertEqual(len(memory.snapshot()["memories"]), 2)
        self.assertEqual(memory.context("thé")[0], ["Je préfère le thé"])

    def test_short_option_answer_on_phone_carries_its_question_context(self):
        self.answers = [reply("Do you prefer coffee hot or cold?")]
        self.send("I like coffee.")
        self.send("cold please", device=DEV2)
        self.assertFalse(self.profile()["followups"])
        payload = json.dumps(self.calls[-1][1])
        self.assertIn("Do you prefer coffee hot or cold?", payload)

    def test_name_is_shared_and_generic_dismissal_closes_one_topic(self):
        self.send("Call me Marco.")
        self.assertEqual(self.profile(device=DEV2)["memories"][0]["text"], "Call me Marco")
        self.send("Je travaille sur le robot.")
        self.send("Laisse tomber", device=DEV2)
        self.assertFalse(self.profile()["followups"])

    def test_dated_event_reuses_existing_extraction_and_follows_up_on_phone(self):
        self.send("Retiens que mon examen de statique est jeudi.")
        calls = len(self.calls)
        memory.remember_moments([{"what": "examen de statique", "date": "2026-11-05"}], "Mon examen de statique est jeudi", DEV)
        self.assertEqual(len(self.calls), calls)
        self.assertIn("2026-11-05", " ".join(memory.context("statique")[0]))
        from datetime import datetime
        self.clock[0] = datetime(2026, 11, 6, 10).timestamp()
        self.send("bonjour", device=DEV2)
        self.assertIn("examen de statique", json.dumps(self.calls[-1][1]))

    def test_removing_a_project_memory_drops_its_followup(self):
        self.send("Je travaille sur le robot.")
        item = self.profile()["memories"][0]
        self.api("memory_forget", id=item["id"], device=DEV2)
        self.assertFalse(self.profile()["followups"])


class RepairTests(Base):
    """A correction that supersedes an earlier answer is her own dated history."""

    def store(self):
        return memory.owner_context("admin"), memory.memory_scope("transferania")

    def remember(self, text):
        owner, scope = self.store()
        with owner, scope:
            memory.observe_user(text, DEV)
            wanted = memory.fold(text).strip(" .!")
            return next(m for m in memory.snapshot()["memories"]
                        if memory.fold(m["text"]).strip(" .!") == wanted)

    def correct(self, memory_id, text):
        owner, scope = self.store()
        with owner, scope:
            memory.correct(memory_id, text)

    def records(self):
        owner, scope = self.store()
        with owner, scope:
            return memory.repair_records(memory._load(), self.clock[0])

    def packet(self, query, *, reserve=True):
        owner, scope = self.store()
        with owner, scope:
            return memory.context_packet(query, conversation_text=query, reserve_followup=reserve)

    def profile(self):
        code, data = ai.http_post({"action": "transferania", "op": "memory", "device_id": DEV},
                                  role="admin", owner_id="admin")
        self.assertEqual(code, 200, data)
        return data

    def test_a_correction_yields_one_dated_repair_naming_both_answers(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.clock[0] += 3600
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        rows = self.records()
        self.assertEqual(len(rows), 1, rows)
        row = rows[0]
        self.assertIn("fermentation", memory.fold(row["topic"]))
        self.assertIn("aime la fermentation", memory.fold(row["old"]))
        self.assertIn("n'aime pas la fermentation", memory.fold(row["new"]))
        self.assertEqual(row["since"], self.clock[0], "the date is the moment the answer changed")
        line = hq_personhood._repair_line(row)
        self.assertIn("je disais", line)
        self.assertIn("je dis", line)
        self.assertIn(hq_personhood._date(self.clock[0]), line)
        self.assertIn("fermentation", line)
        self.assertLessEqual(len(line), hq_personhood.MAX_HINT_CHARS)
        self.assertLessEqual(len(line.encode("utf-8")), hq_personhood.MAX_HINT_BYTES)

    def test_without_a_superseded_answer_there_is_no_repair(self):
        self.remember("J'aime la fermentation du chou.")
        self.assertEqual(self.records(), [])

    def test_the_repair_is_offered_only_when_his_message_returns_to_the_topic(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.clock[0] += 3600
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        rows = [dict(r, quoted=False) for r in self.records()]
        social = "Salut, ça va ?"
        line, evidence = hq_personhood._pick({}, self.clock[0], hq_personhood._fold(social), True,
                                             hq_personhood._words(social), rows)
        self.assertEqual(line, "", "a greeting is not a return to that topic")
        asked = "et la fermentation, alors ?"
        line, evidence = hq_personhood._pick({}, self.clock[0], hq_personhood._fold(asked), False,
                                             hq_personhood._words(asked), rows)
        self.assertTrue(line.startswith("RÉPARATION — "), line)
        self.assertEqual(evidence["basis"], "repair")
        self.assertEqual(evidence["repair_id"], rows[0]["id"])

    def test_the_repair_reaches_the_packet_once_and_not_on_a_second_return(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.clock[0] += 3600
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        query = "et la fermentation du chou ?"
        first = self.packet(query)
        self.assertIsNotNone(first["repair"], first["continuity"])
        self.assertEqual(first["repair"]["basis"], "repair")
        self.assertIn("RÉPARATION", first["continuity"])
        self.assertIn("n'aime pas", first["continuity"])
        self.assertEqual(first["personhood"].get("basis"), "repair")
        second = self.packet(query)
        self.assertIsNone(second["repair"])
        self.assertNotIn("RÉPARATION", second["continuity"])

    def test_a_preview_does_not_spend_the_one_time(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.clock[0] += 3600
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        query = "et la fermentation du chou ?"
        preview = self.packet(query, reserve=False)
        self.assertIsNotNone(preview["repair"])
        again = self.packet(query)
        self.assertIsNotNone(again["repair"], "only a real turn says it")

    def test_the_repair_line_is_refused_on_its_own_share_without_breaking_the_packet(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.clock[0] += 3600
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        query = "La fermentation du chou, c'est intéressant."
        packet = self.packet(query)
        system = ai.build_transferania_system("chat", "warm", nsfw=False, view="accueil",
                                              device_id=DEV, context_core=True)

        def build(personhood):
            _, contents, usage = ai.build_companion_context(
                "chat", system, query, memories=packet["memories"],
                corrections=packet.get("corrections", []), page=packet["continuity"],
                personhood=personhood, budget=6200)
            row = next(r for r in usage["selection_manifest"] if r["kind"] == "personhood")
            return row, usage, json.dumps(contents, ensure_ascii=False)

        row, usage, payload = build(packet["personhood"])
        self.assertTrue(row["selected"])
        self.assertIn("RÉPARATION", payload)
        tight, tight_usage, tight_payload = build({**packet["personhood"], "share": 100})
        self.assertFalse(tight["selected"], "a share smaller than the line refuses it")
        self.assertEqual(tight["reason"], "budget")
        self.assertNotIn("RÉPARATION", tight_payload)
        self.assertLessEqual(tight_usage["estimated_input_tokens"], tight_usage["input_budget"])

    def test_the_recall_view_lists_the_repair_with_both_answers_and_both_evidence_ids(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.clock[0] += 3600
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        view = self.profile()["repairs"]
        self.assertEqual((view["complete_count"], view["partial_count"]), (1, 0), view)
        row = view["rows"][0]
        self.assertEqual(row["topic"], "fermentation du chou")
        self.assertIn("aime la fermentation", memory.fold(row["old"]))
        self.assertIn("n'aime pas la fermentation", memory.fold(row["new"]))
        self.assertEqual(row["since"], self.clock[0])
        self.assertTrue(row["complete"])
        self.assertEqual(row["missing"], [])
        self.assertEqual(row["basis"], "repair")
        self.assertEqual(row["evidence"]["live"], self.records()[0]["id"],
                         "the live row is the one the dialogue line quotes")
        self.assertTrue(row["evidence"]["superseded"])
        self.assertNotEqual(row["evidence"]["live"], row["evidence"]["superseded"])

    def test_reading_the_view_spends_nothing_so_a_real_turn_still_says_it(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.clock[0] += 3600
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        query = "et la fermentation du chou ?"
        owner, scope = self.store()
        with owner, scope:
            path = Path(memory.path())
            before = path.read_bytes()
            memory.repair_ledger()
            memory.context_packet(query, conversation_text=query, reserve_followup=False)
            self.assertEqual(Path(memory.path()).read_bytes(), before,
                             "the ledger read and a preview stamp nothing")
        self.assertTrue(self.profile()["repairs"]["rows"],
                        "the operator view is a read, not a write")
        owner, scope = self.store()
        with owner, scope:
            self.assertEqual(memory._load().get("repairs") or {}, {},
                             "the view spends no reservation")
        told = self.packet(query)
        self.assertIsNotNone(told["repair"], "the read left the one-time line intact")
        self.assertIn("RÉPARATION", told["continuity"])
        self.assertIsNone(self.packet(query)["repair"], "and it is still only said once")

    def test_a_pruned_old_answer_is_named_but_not_reconstructed(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.clock[0] += 3600
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        owner, scope = self.store()
        with owner, scope:
            data = memory._load()
            data["memories"] = [m for m in data["memories"] if m["status"] != "superseded"]
            memory._save(data)
            self.assertEqual(memory.repair_records(memory._load(), self.clock[0]), [],
                             "without the old answer there is no dialogue line")
        view = self.profile()["repairs"]
        self.assertEqual((view["complete_count"], view["partial_count"]), (0, 1), view)
        row = view["rows"][0]
        self.assertEqual(row["topic"], "fermentation du chou")
        self.assertIsNone(row["old"], "the pruned answer is never guessed")
        self.assertIn("n'aime pas la fermentation", memory.fold(row["new"]))
        self.assertEqual(row["since"], self.clock[0])
        self.assertEqual(row["missing"], ["old"])
        self.assertFalse(row["complete"])
        self.assertTrue(row["evidence"]["live"])
        self.assertEqual(row["evidence"]["superseded"], "")
        page = self.packet("Qu'est-ce que tu disais avant ?", reserve=False)["continuity"]
        self.assertIn("non reconstruite", page)
        self.assertIn("il manque l'ancienne réponse", page)

    def test_a_correction_without_a_change_date_says_which_field_is_missing(self):
        owner, scope = self.store()
        with owner, scope:
            data = memory._load()
            data["episodes"].extend([
                {"id": "ep-old", "text": "J'aime la fermentation du chou", "kind": "interest",
                 "topic": "fermentation du chou", "source_device": DEV, "source_key": None,
                 "at": self.clock[0] - 86400, "evidence": "user_statement", "status": "superseded"},
                {"id": "ep-new", "text": "Je n'aime pas la fermentation du chou", "kind": "interest",
                 "topic": "fermentation du chou", "source_device": DEV, "source_key": None,
                 "at": self.clock[0] - 86400, "evidence": "user_correction", "status": "active"}])
            memory._save(data)
            self.assertEqual(memory.repair_records(memory._load(), self.clock[0]), [],
                             "an undated change is not dated by guessing")
        row = self.profile()["repairs"]["rows"][0]
        self.assertEqual(row["topic"], "fermentation du chou")
        self.assertIn("aime la fermentation", memory.fold(row["old"]))
        self.assertIn("n'aime pas la fermentation", memory.fold(row["new"]))
        self.assertIsNone(row["since"])
        self.assertEqual(row["missing"], ["since"])
        self.assertEqual(row["evidence"], {"live": "ep-new", "superseded": "ep-old"})

    def test_the_ledger_page_appears_only_when_he_asks_for_it(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.clock[0] += 3600
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        asked = "Qu'est-ce que tu disais avant sur la fermentation du chou ?"
        packet = self.packet(asked, reserve=False)
        self.assertTrue(packet["repair_ledger"]["requested"])
        self.assertTrue(packet["repair_ledger"]["rendered"])
        self.assertEqual(packet["repair_ledger"]["complete"], 1)
        page = packet["continuity"]
        self.assertIn("RÉPARATIONS DU JOURNAL", page)
        self.assertIn("je disais", page)
        self.assertIn("je dis « Je n'aime pas la fermentation du chou »", page)
        self.assertIn(hq_personhood._date(self.clock[0]), page)
        self.assertIn("journal : " + packet["repair"]["id"][:8], page)
        plain = self.packet("La fermentation du chou, c'est intéressant.", reserve=False)
        self.assertFalse(plain["repair_ledger"]["requested"])
        self.assertNotIn("RÉPARATIONS DU JOURNAL", plain["continuity"])

    def test_the_page_caps_its_rows_and_says_how_many_it_left_out(self):
        for topic in ("fermentation du chou", "robot maison", "café filtre", "statique", "imprimante"):
            item = self.remember("J'aime " + topic + ".")
            self.clock[0] += 10
            self.correct(item["id"], "Je n'aime pas " + topic + ".")
        packet = self.packet("Montre-moi tes corrections du journal.", reserve=False)
        self.assertEqual(packet["repair_ledger"],
                         {"requested": True, "complete": 5, "partial": 0, "rendered": True})
        page = packet["continuity"]
        rows = [line for line in page.splitlines() if line.startswith("— ")]
        self.assertEqual(len(rows), memory.REPAIR_LEDGER_MAX_ROWS,
                         "the page carries whole rows inside its byte share")
        self.assertIn("(2 réparation(s) de plus dans la vue Mémoire)", page)
        self.assertLessEqual(len(page.encode("utf-8")),
                             memory.REPAIR_LEDGER_MAX_BYTES + 140,
                             "and it stays a bounded block")

    def profile_for(self, scope):
        with memory.owner_context("admin"), memory.memory_scope(scope):
            return memory.snapshot()

    def test_a_correction_writes_a_question_of_her_own_that_is_not_due_at_once(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        rows = self.profile()["questions"]
        self.assertEqual(len(rows), 1, rows)
        row = rows[0]
        self.assertEqual((row["source"], row["opener"]), ("self", "correction"))
        self.assertEqual(row["status"], "awaiting_user")
        self.assertIn("changer d'avis", row["question"])
        self.assertIn("fermentation du chou", row["question"])
        self.assertEqual(row["not_before"] - row["created_at"], memory.AUTHOR_DELAY,
                         "she asks later, never in the same breath")

    def test_the_question_is_asked_days_later_and_only_once(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        query = "et la fermentation du chou ?"
        self.clock[0] += 3600
        early = self.packet(query)
        self.assertNotEqual((early.get("reservation") or {}).get("kind"), "followup",
                            "nothing of hers is asked before its day")
        self.assertEqual(self.profile()["questions"][0]["status"], "awaiting_user")
        self.clock[0] += 2 * 86400
        asked = self.packet(query)
        self.assertEqual((asked.get("reservation") or {}).get("kind"), "followup")
        self.assertIn("changer d'avis", asked["continuity"])
        row = self.profile()["questions"][0]
        self.assertEqual((row["status"], row["ask_count"]), ("asked", 1))
        again = self.packet(query)
        self.assertIsNone(again.get("reservation"))
        self.assertNotIn("changer d'avis", again["continuity"])
        self.assertEqual(self.profile()["questions"][0]["ask_count"], 1, "asked once, never again")

    def test_a_told_repair_does_not_add_a_second_question_for_its_topic(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        self.clock[0] += 3600
        packet = self.packet("et la fermentation du chou ?")
        self.assertEqual(packet["repair"]["topic"], "fermentation du chou")
        self.assertEqual(len(self.profile()["questions"]), 1, "one topic, one question")

    def test_each_sister_reads_the_same_stored_day_differently(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        context, scope = self.store()
        with context, scope:
            data = memory._load()
            memory._record_episode(data, "On a fait le rituel du café filtre.", "ritual", DEV,
                                   None, topic="café filtre")
            memory._save(data)
            source = Path(memory.path())
        target = source.parent / "else" / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
        self.clock[0] += 60
        transferania, else_lens = self.profile()["lens"], self.profile_for("else")["lens"]
        self.assertEqual((transferania["name"], else_lens["name"]), ("transferania", "else"))
        self.assertEqual(transferania["surfaced"][0]["kind"], "ritual")
        self.assertEqual(else_lens["surfaced"][0]["kind"], "correction")
        self.assertNotEqual(transferania["surfaced"][0]["id"], else_lens["surfaced"][0]["id"])
        self.assertIn("ritual", transferania["prefers"])
        self.assertIn("correction", else_lens["prefers"])

    def test_the_artifact_accumulates_and_its_phrase_changes(self):
        seen = []
        for days, phrase in ((0, "On a fait le rituel du café filtre."),
                             (2, "Encore le rituel du café filtre."),
                             (3, "Troisième rituel du café filtre.")):
            self.clock[0] += days * 86400
            context, scope = self.store()
            with context, scope:
                data = memory._load()
                memory._record_episode(data, phrase, "ritual", DEV, None, topic="café filtre")
                memory._save(data)
            seen.append(self.profile()["artifact"])
        self.assertEqual([row["count"] for row in seen], [1, 2, 3])
        self.assertEqual(len({row["phrase"] for row in seen}), 3, "phrasing moves with the count")
        self.assertEqual(seen[-1]["kind"], "ritual")
        self.assertIn("troisième fois", seen[-1]["phrase"])
        packet = self.packet("et le café filtre ?", reserve=False)
        self.assertIn("RITUEL QUI S'ACCUMULE", packet["continuity"])
        self.assertIn("troisième fois", packet["continuity"])

    def test_the_quiet_state_is_explained_from_the_correction_counters(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        self.assertFalse(self.profile()["quiet"]["withheld"])
        context, scope = self.store()
        with context, scope:
            data = memory._load()
            # A second correction of the same subject, exactly as ``correct``
            # records it: same key, so the same folded topic on the counter.
            data["episodes"].append({"id": "corr-second", "text": "Non, la fermentation du chou, non.",
                "kind": "correction", "topic": "fermentation du chou", "source_device": DEV,
                "source_key": "preference:fermentation du chou", "at": self.clock[0] - 60,
                "evidence": "user_correction", "status": "active"})
            memory._save(data)
        quiet = self.profile()["quiet"]
        self.assertTrue(quiet["withheld"], quiet)
        self.assertEqual(quiet["corrections"], 2)
        self.assertIn("fermentation du chou", quiet["says"])
        self.assertIn("2 fois", quiet["says"])
        self.assertIn("je me tais", quiet["says"])

    def test_else_keeps_a_list_that_accumulates(self):
        seen = []
        for days, phrase, topic in ((0, "On a décidé de réparer le vélo.", "vélo"),
                                    (2, "On a décidé de changer les servos.", "servos"),
                                    (3, "On a décidé de ranger l'atelier.", "atelier")):
            self.clock[0] += days * 86400
            with memory.owner_context("admin"), memory.memory_scope("else"):
                data = memory._load()
                memory._record_episode(data, phrase, "decision", DEV, None, topic=topic)
                memory._save(data)
            seen.append(self.profile_for("else")["artifact"])
        self.assertEqual([row["kind"] for row in seen], ["list", "list", "list"])
        self.assertEqual([row["count"] for row in seen], [1, 2, 3])
        self.assertEqual(len({row["phrase"] for row in seen}), 3)
        self.assertIn("points notés", seen[-1]["phrase"])
        with memory.owner_context("admin"), memory.memory_scope("else"):
            page = memory.context_packet("où en est l'atelier ?",
                                         conversation_text="où en est l'atelier ?")["continuity"]
        self.assertIn("LISTE TENUE", page)
        self.assertIn("points notés", page)

    def test_the_model_restating_her_question_does_not_arm_a_second_ask(self):
        item = self.remember("J'aime la fermentation du chou.")
        self.correct(item["id"], "Je n'aime pas la fermentation du chou.")
        context, scope = self.store()
        with context, scope:
            before = len(memory._load()["followups"])
            memory.observe_reply("J'aime la fermentation du chou.",
                                 "Et qu'est-ce qui a changé sur la fermentation du chou pour toi ?", DEV)
            self.assertEqual(len(memory._load()["followups"]), before,
                             "one topic, one authored question")

    def chapters(self):
        owner, scope = self.store()
        with owner, scope:
            return memory.chapter_records(memory._load(), self.clock[0])

    def close_project(self):
        owner, scope = self.store()
        with owner, scope:
            memory.observe_user("Je travaille sur le dossier fiscal.", DEV)
            data = memory._load()
            self.assertTrue([m for m in data["memories"] if m["key"] == "project:le dossier fiscal"])
            self.assertIn("awaiting_outcome", [f["status"] for f in data["followups"]])
        self.clock[0] += 4 * 86400
        owner, scope = self.store()
        with owner, scope:
            memory.observe_user("C'est fait pour le dossier fiscal.", DEV)

    def test_a_closed_project_becomes_a_dated_chapter_from_stored_episodes(self):
        self.close_project()
        rows = self.chapters()
        self.assertEqual(len(rows), 1, rows)
        row = rows[0]
        self.assertIn("dossier fiscal", memory.fold(row["topic"]))
        self.assertEqual(row["closed_at"], self.clock[0])
        self.assertEqual(row["opened_at"], self.clock[0] - 4 * 86400)
        self.assertEqual(row["days"], 4)
        self.assertIn("c'est fait", memory.fold(row["outcome"]))
        self.assertTrue(row["closed_id"], "the chapter names the episode that closed it")
        line = hq_personhood._chapter_line(row)
        self.assertIn("CHAPITRE CLOS", line)
        self.assertIn(hq_personhood._date(row["opened_at"]), line)
        self.assertIn(hq_personhood._date(row["closed_at"]), line)
        self.assertIn("4 jours", line)
        self.assertIn("dossier fiscal", line)
        self.assertLessEqual(len(line), hq_personhood.MAX_HINT_CHARS)
        self.assertLessEqual(len(line.encode("utf-8")), hq_personhood.MAX_HINT_BYTES)

    def test_the_chapter_reads_as_closed_and_is_quoted_once(self):
        self.close_project()
        self.clock[0] += 3600
        first = self.packet("Où en est le dossier fiscal ?")
        self.assertIn("CHAPITRE CLOS", first["continuity"])
        self.assertNotIn("SUJET EN ATTENTE", first["continuity"])
        self.assertEqual(first["chapter"]["basis"], "chapter")
        self.assertEqual(first["chapter"]["days"], 4)
        second = self.packet("Où en est le dossier fiscal ?")
        self.assertNotIn("CHAPITRE CLOS", second["continuity"])
        self.assertIsNone(second["chapter"])

    def test_a_preview_does_not_spend_the_chapter(self):
        self.close_project()
        self.clock[0] += 3600
        for _ in range(2):
            preview = self.packet("Où en est le dossier fiscal ?", reserve=False)
            self.assertIn("CHAPITRE CLOS", preview["continuity"])
        self.assertIn("CHAPITRE CLOS", self.packet("Où en est le dossier fiscal ?")["continuity"])

    def test_a_reopened_subject_is_not_a_closed_chapter(self):
        self.close_project()
        self.clock[0] += 3600
        owner, scope = self.store()
        with owner, scope:
            data = memory._load()
            memory._record_episode(data, "On repart sur le dossier fiscal.", "interest", DEV, None,
                                   topic="le dossier fiscal")
            memory._save(data)
        self.assertEqual(self.chapters(), [])
