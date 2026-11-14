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
# A plain statement, not a recall request: the recall slot would otherwise hand
# the turn to the correction episode and the personhood branch would never run.
QUERY = "La fermentation du chou, c'est intéressant."


class PersonhoodSalienceTests(Base):
    def seed(self, *ages, subject=SUBJECT, query=None):
        with memory.owner_context("admin"), memory.memory_scope("transferania"):
            for age in ages:
                ph.observe_chat("transferania", subject, now=self.clock[0] - age)
        asked = query or QUERY
        return memory.context_packet(asked, conversation_text=asked)

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
        packet = self.seed(20 * 3600, subject=SHORT_SUBJECT,
                           query="Le robot de la maison, c'est utile.")
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
                    "id": f"correction{index}-{int(age)}",
                    "text": f"Non, pas la {subject} ({int(age)}h, {index + 1}).",
                    "kind": "correction", "topic": subject, "source_device": "hqtestdevice01ab",
                    "source_key": "preference:" + subject, "at": self.clock[0] - age,
                    "evidence": "user_correction",
                    "status": "active" if index == times - 1 else "superseded"})
            memory._save(data)

    def test_one_correction_puts_her_on_the_first_rung_down(self):
        self.push_back(times=1)
        packet = self.seed(3600, 1800)
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 1)
        self.assertFalse(salience["withhold"])
        self.assertEqual((salience["tier"], salience["rung"]), ("almost_herself", "almost_herself"))
        self.assertEqual(salience["base"], "hot")
        self.assertEqual((salience["priority"], salience["share"]), (95, 260))
        self.assertEqual(salience["score"], 0.649)
        row, _, payload = self.assemble(packet)
        self.assertTrue(row["selected"])
        self.assertEqual(row["priority"], 95)
        self.assertIn("SUJET RÉCENT", payload)

    def test_two_corrections_take_the_offer_away(self):
        self.push_back(times=2)
        packet = self.seed(3600, 1800)
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 2)
        self.assertTrue(salience["withhold"])
        self.assertEqual(salience["tier"], "withheld")
        self.assertEqual(salience["rung"], "answering")
        self.assertEqual((salience["priority"], salience["share"]), (91, 240))
        self.assertEqual(packet["continuity"], "", "she stops offering the subject unprompted")
        self.assertNotEqual(packet["presence"]["continuity_kind"], "episode",
                            "the correction must not be what silences her")
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

    def test_every_rung_is_declared_named_and_monotone(self):
        samples = {"hot": (1800, 2), "warm": (3600, 1), "cold": (20 * 3600, 1)}
        for base, (age, repeats) in samples.items():
            rungs = ph.SALIENCE_LADDER[base]
            self.assertEqual(sorted(rungs), [1, 2, 3])
            priorities = [rungs[depth][1] for depth in (3, 2, 1)]
            shares = [rungs[depth][2] for depth in (3, 2, 1)]
            self.assertEqual(priorities, sorted(priorities), base)
            self.assertEqual(shares, sorted(shares), base)
            self.assertLess(priorities[-1], ph.SALIENCE_PRIORITY[base], base)
            self.assertLess(shares[-1], ph.SALIENCE_SHARE[base], base)
            for depth in (1, 2, 3):
                name, priority, share, factor = rungs[depth]
                got = ph.salience(age, repeats, depth, 4)
                self.assertEqual(got["base"], base)
                self.assertEqual((got["rung"], got["priority"], got["share"]), (name, priority, share),
                                 (base, depth))
                self.assertEqual(got["tier"], "withheld" if got["withhold"] else name, (base, depth))
                self.assertEqual(got["score"], round(round(0.65 * (1 - age / (24 * 3600))
                                                           + 0.35 * min(1.0, (repeats - 1) / 2.0), 3)
                                                         * factor, 3))

    def test_a_partial_recovery_never_reports_a_base_tier(self):
        self.push_back(times=4, age=4 * 3600)
        for ages, expected in (((1800, 1500), "answering"), ((1800, 1500, 1200), "almost_herself")):
            self.tearDown()
            self.setUp()
            self.push_back(times=4, age=4 * 3600)
            tier = self.seed(*ages)["personhood"]["tier"]
            self.assertEqual(tier, expected)
            self.assertNotIn(tier, ("cold", "warm", "hot"))

    def test_a_burst_of_returns_counts_beyond_the_three_kept_sources(self):
        self.push_back(times=4, age=4 * 3600)
        packet = self.seed(1800, 1500, 1200, 900, 600)
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 0, "five returns answer four corrections")
        self.assertFalse(salience["withhold"])
        self.assertEqual(salience["tier"], "hot")
        self.assertEqual((salience["priority"], salience["share"]), (98, 320))
        row, _, payload = self.assemble(packet)
        self.assertTrue(row["selected"])
        self.assertEqual(row["priority"], 98)
        self.assertIn("SUJET RÉCENT", payload)

    def test_the_ledger_sees_more_returns_than_the_snapshot_keeps(self):
        self.seed(1800, 1500, 1200, 900, 600)
        snap = ph.snapshot("transferania", owner="admin", now=self.clock[0])
        row = snap["preoccupations"][0]
        self.assertEqual(len(row["sources"]), 3, "the snapshot keeps three turns")
        self.assertEqual(ph._subject_returns("transferania", row["label"],
                                            self.clock[0] - 2000, owner="admin",
                                            now=self.clock[0]), 5)

    def test_exactly_n_returns_answer_n_corrections(self):
        self.push_back(times=4, age=4 * 3600)
        packet = self.seed(1800, 1500, 1200, 900)
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 0)
        self.assertEqual((salience["priority"], salience["share"]), (98, 320))
        row, _, _ = self.assemble(packet)
        self.assertTrue(row["selected"])

    def test_one_return_short_leaves_her_close_to_her_own_salience(self):
        self.push_back(times=4, age=4 * 3600)
        packet = self.seed(1800, 1500, 1200)
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 1)
        self.assertFalse(salience["withhold"])
        self.assertEqual(salience["tier"], "almost_herself")
        self.assertEqual((salience["priority"], salience["share"]), (95, 260))

    def test_salience_climbs_with_each_of_his_returns(self):
        """One ladder, not an on/off switch: each answer raises her a step."""
        self.push_back(times=4, age=4 * 3600)
        ladder = []
        for ages in ((1800, 1500), (1800, 1500, 1200), (1800, 1500, 1200, 900)):
            if ladder:  # fresh store per rung
                self.tearDown()
                self.setUp()
                self.push_back(times=4, age=4 * 3600)
            packet = self.seed(*ages)
            salience = packet["personhood"]
            self.assertEqual(salience["pushback"], 4 - len(ages))
            row, _, payload = self.assemble(packet)
            ladder.append((salience["priority"], salience["share"], row is not None
                           and row["selected"], "SUJET RÉCENT" in payload))
        self.assertEqual([(p, s) for p, s, _, _ in ladder], [(91, 240), (95, 260), (98, 320)])
        self.assertEqual([selected for _, _, selected, _ in ladder], [True, True, True])
        self.assertEqual([shown for _, _, _, shown in ladder], [True, True, True])

    def test_a_barely_answered_subject_stays_closed(self):
        # One of four corrections answered: a quarter of the way back, still shut.
        self.push_back(times=4, age=4 * 3600)
        packet = self.seed(20000, 1800)  # one turn long before the corrections
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 3)
        self.assertEqual(salience["progress"], 0.25)
        self.assertTrue(salience["withhold"])
        self.assertEqual((salience["tier"], salience["rung"]), ("withheld", "guarded"))
        self.assertEqual((salience["priority"], salience["share"]), (88, 200))
        self.assertEqual(packet["continuity"], "")

    def test_interleaved_corrections_and_returns_end_clean(self):
        for hours in (6, 4, 2):
            self.push_back(times=1, age=hours * 3600)
        packet = self.seed(5 * 3600, 3 * 3600, 1800, 1500, 1200)
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 0)
        self.assertEqual(salience["tier"], "hot")
        row, _, _ = self.assemble(packet)
        self.assertTrue(row["selected"])

    def test_a_return_after_a_correction_cancels_one(self):
        self.push_back(times=2, age=3600)
        packet = self.seed(7200, 1800)  # one turn before the correction, one after
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 1)
        self.assertEqual(salience["progress"], 0.5)
        self.assertFalse(salience["withhold"], "one return reopens the offer")
        self.assertEqual(salience["tier"], "almost_herself")
        self.assertEqual((salience["priority"], salience["share"]), (95, 260))
        self.assertNotEqual(packet["continuity"], "")
        row, _, payload = self.assemble(packet)
        self.assertTrue(row["selected"])
        self.assertEqual(row["priority"], 95)
        self.assertIn("SUJET RÉCENT", payload)

    def test_coming_back_twice_restores_the_full_salience(self):
        self.push_back(times=2, age=3 * 3600)
        packet = self.seed(1800, 900)
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 0)
        self.assertFalse(salience["withhold"])
        self.assertEqual(salience["tier"], "hot")
        self.assertEqual((salience["priority"], salience["share"]), (98, 320))
        self.assertNotEqual(packet["presence"]["continuity_kind"], "episode")
        row, _, payload = self.assemble(packet)
        self.assertTrue(row["selected"])
        self.assertEqual(row["priority"], 98)
        self.assertIn("SUJET RÉCENT", payload)

    def test_a_turn_before_the_correction_does_not_count_as_a_return(self):
        self.push_back(times=2, age=3600)
        packet = self.seed(2 * 3600)
        salience = packet["personhood"]
        self.assertEqual(salience["pushback"], 2)
        self.assertTrue(salience["withhold"])
        self.assertEqual(packet["continuity"], "")

    def test_returns_are_counted_only_after_the_latest_correction(self):
        now = self.clock[0]
        corrections = [{"topic": "fermentation du chou", "at": now - 7200},
                       {"topic": "fermentation du chou", "at": now - 3600}]
        self.assertEqual(ph._pushback_count(corrections, "fermentation du chou", now,
                                            [now - 10800, now - 5400]), 2)
        self.assertEqual(ph._pushback_count(corrections, "fermentation du chou", now,
                                            [now - 600]), 1)
        self.assertEqual(ph._pushback_count(corrections, "fermentation du chou", now,
                                            [now - 600, now - 300]), 0)

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
