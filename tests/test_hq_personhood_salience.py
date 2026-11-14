"""How present a subject is decides her personhood row: tier, priority, bytes.

The evidence comes from what the store already keeps about the subject: when it
last appeared (``sources[].at``) and how many recent turns carried it.
"""
import json

import hq_ai as ai
import hq_companion_memory as memory
import hq_personhood as ph
from tests.test_hq_ai import Base, DEV

SUBJECT = "Parle-moi de la fermentation du chou."
SHORT_SUBJECT = "robot maison"
QUERY = "Tu te souviens de notre discussion ?"


class PersonhoodSalienceTests(Base):
    def seed(self, *ages, subject=SUBJECT):
        with memory.owner_context("admin"), memory.memory_scope("transferania"):
            for age in ages:
                ph.observe_chat("transferania", subject, now=self.clock[0] - age)
        return memory.context_packet(QUERY, conversation_text=QUERY)

    def assemble(self, packet, *, budget=None):
        system = ai.build_transferania_system("chat", "warm", nsfw=False, view="accueil",
                                              device_id=DEV, context_core=True)
        _, contents, usage = ai.build_companion_context(
            "chat", system, QUERY, memories=packet["memories"],
            corrections=packet.get("corrections", []), page=packet["continuity"],
            personhood=packet.get("personhood"), budget=budget)
        row = next((r for r in usage["selection_manifest"] if r["kind"] == "personhood"), None)
        payload = json.dumps(contents, ensure_ascii=False)
        return row, usage, payload

    def test_a_recent_repeated_subject_is_hot_and_keeps_the_full_share(self):
        packet = self.seed(3600, 1800)
        salience = packet["personhood"]
        self.assertEqual(salience["tier"], "hot")
        self.assertEqual(salience["priority"], 98)
        self.assertEqual(salience["share"], 320)
        self.assertEqual(salience["repeats"], 2)
        self.assertLessEqual(salience["age_s"], 3600)
        row, usage, payload = self.assemble(packet)
        self.assertTrue(row["selected"])
        self.assertEqual(row["reason"], "included")
        self.assertEqual(row["priority"], 98)
        self.assertEqual(row["share"], 320)
        self.assertIn("SUJET RÉCENT", payload)

    def test_a_recent_single_subject_is_warm_with_a_middle_share(self):
        packet = self.seed(3 * 3600)
        salience = packet["personhood"]
        self.assertEqual(salience["tier"], "warm")
        self.assertEqual((salience["priority"], salience["share"]), (92, 200))
        row, _, payload = self.assemble(packet)
        self.assertTrue(row["selected"])
        self.assertEqual(row["priority"], 92)
        self.assertIn("SUJET RÉCENT", payload)

    def test_a_stale_single_subject_is_cold_and_loses_its_room(self):
        packet = self.seed(20 * 3600)
        salience = packet["personhood"]
        self.assertEqual(salience["tier"], "cold")
        self.assertEqual((salience["priority"], salience["share"]), (84, 160))
        self.assertEqual(salience["repeats"], 1)
        row, usage, payload = self.assemble(packet)
        self.assertFalse(row["selected"], "a cold subject must not occupy the packet")
        self.assertEqual(row["reason"], "budget", "refused on her own byte share")
        self.assertEqual((row["priority"], row["share"]), (84, 160))
        self.assertNotIn("SUJET RÉCENT", payload)
        self.assertNotIn("personhood", usage["selection_totals"], "nothing selected on that share")

    def test_the_cold_share_is_a_byte_limit_not_a_blanket_drop(self):
        packet = self.seed(20 * 3600, subject=SHORT_SUBJECT)
        salience = packet["personhood"]
        self.assertEqual(salience["tier"], "cold")
        row, _, payload = self.assemble(packet)
        self.assertTrue(row["selected"], "a compact cold line still fits its share")
        self.assertEqual(row["priority"], 84)
        self.assertIn("SUJET RÉCENT", payload)

    def test_the_two_states_differ_in_priority_share_and_totals(self):
        hot = self.assemble(self.seed(3600, 1800))
        hot_row, hot_usage, hot_payload = hot
        cold_packet = self.seed(20 * 3600)
        cold_row, cold_usage, cold_payload = self.assemble(cold_packet)
        self.assertGreater(hot_row["priority"], cold_row["priority"])
        self.assertGreater(hot_row["share"], cold_row["share"])
        self.assertTrue(hot_row["selected"])
        self.assertFalse(cold_row["selected"])
        self.assertNotEqual(hot_usage["selection_totals"], cold_usage["selection_totals"])
        self.assertGreater(hot_usage["estimated_input_tokens"], cold_usage["estimated_input_tokens"])
        self.assertIn("SUJET RÉCENT", hot_payload)
        self.assertNotIn("SUJET RÉCENT", cold_payload)

    def test_salience_never_changes_her_wording(self):
        packet = self.seed(3600, 1800)
        detail = ph.hint_detail("transferania", QUERY, owner="admin", now=self.clock[0])
        self.assertEqual(detail["line"], packet["continuity"])
        self.assertEqual(packet["continuity"], ph.hint("transferania", QUERY, owner="admin", now=self.clock[0]))
        self.assertIn("SUJET RÉCENT", packet["continuity"])

    def push_back(self, subject="fermentation du chou", times=2, age=600):
        """The Master corrects the same subject again and again.

        Written as the archive holds them: one active correction, the earlier
        ones superseded, all still evidence of the repetition.
        """
        with memory.owner_context("admin"), memory.memory_scope("transferania"):
            data = memory._load()
            for index in range(times):
                data["episodes"].append({
                    "id": f"correction{index}", "text": f"Non, pas la {subject} ({index + 1}).",
                    "kind": "correction", "topic": subject, "source_device": "hqtestdevice01ab",
                    "source_key": "preference:" + subject, "at": self.clock[0] - age,
                    "evidence": "user_correction",
                    "status": "active" if index == times - 1 else "superseded"})
            memory._save(data)

    def test_one_correction_lowers_the_subject_one_tier(self):
        self.push_back(times=1)
        packet = self.seed(3600, 1800)
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 1)
        self.assertFalse(salience["withhold"])
        self.assertEqual(salience["tier"], "warm")
        self.assertEqual((salience["priority"], salience["share"]), (92, 200))
        self.assertLess(salience["score"], 0.811)
        row, _, payload = self.assemble(packet)
        self.assertTrue(row["selected"])
        self.assertEqual(row["priority"], 92)
        self.assertIn("SUJET RÉCENT", payload)

    def test_two_corrections_take_the_offer_away(self):
        self.push_back(times=2)
        packet = self.seed(3600, 1800)
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 2)
        self.assertTrue(salience["withhold"])
        self.assertEqual(salience["tier"], "cold")
        self.assertEqual((salience["priority"], salience["share"]), (84, 160))
        self.assertEqual(packet["continuity"], "", "she stops offering the subject unprompted")
        row, usage, payload = self.assemble(packet)
        self.assertIsNone(row, "no personhood row is offered for a refused subject")
        self.assertNotIn("personhood", usage["selection_totals"])
        self.assertNotIn("SUJET RÉCENT", payload)

    def test_corrections_about_another_subject_do_not_count(self):
        self.push_back(subject="café", times=2)
        packet = self.seed(3600, 1800)
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 0)
        self.assertEqual(salience["tier"], "hot")
        self.assertEqual((salience["priority"], salience["share"]), (98, 320))

    def test_corrections_outside_the_window_do_not_count(self):
        now = self.clock[0]
        old = [{"topic": "fermentation du chou", "text": "Non.", "at": now - 30 * 3600}] * 2
        fresh = [{"topic": "fermentation du chou", "text": "Non.", "at": now - 3600}] * 2
        self.assertEqual(ph._pushback_count(old, "fermentation du chou", now), 0)
        self.assertEqual(ph._pushback_count(fresh, "fermentation du chou", now), 2)

    def test_a_hot_line_survives_competition_but_a_cold_long_one_does_not(self):
        hot_row, hot_usage, _ = self.assemble(self.seed(3600, 1800), budget=6200)
        cold_row, cold_usage, _ = self.assemble(self.seed(20 * 3600), budget=6200)
        self.assertTrue(hot_row["selected"])
        self.assertFalse(cold_row["selected"])
        self.assertLessEqual(hot_usage["estimated_input_tokens"], hot_usage["input_budget"])
        self.assertLessEqual(cold_usage["estimated_input_tokens"], cold_usage["input_budget"])
