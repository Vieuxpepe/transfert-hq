"""Local memory meaning, owner boundaries, shared follow-through and migration."""
import json
import threading

import hq_ai as ai
import hq_companion_memory as memory
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
