"""Local memory meaning, owner boundaries, shared follow-through and migration."""
import json
import threading
from unittest import mock

import hq_ai as ai
import hq_companion_growth as growth
import hq_companion_memory as memory
import hq_personhood
from tests.test_hq_ai import Base, DEV, DEV2, reply


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
