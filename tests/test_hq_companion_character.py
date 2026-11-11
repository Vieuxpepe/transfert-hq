"""Character nuance, meaningful follow-through and editable journal evidence."""
import json

import hq_ai as ai
import hq_companion_memory as memory
import hq_companion_presence as presence
from tests.test_hq_ai import Base, DEV, DEV2


class CharacterTests(Base):
    def request(self, op, **kwargs):
        return ai.http_post({"action": "transferania", "op": op, "device_id": DEV2, **kwargs}, role="admin")

    def test_response_nuance_prioritizes_repair_comfort_and_tasks(self):
        cases = [("I am proud but still unsure", "social", "pride", "cautious"),
                 ("I feel sad", "comfort", "reassurance", "attentive"),
                 ("Fix the code that worked but now fails", "practical", "concentration", "attentive"),
                 ("Why are leaves shaped this way?", "social", "curiosity", "thoughtful"),
                 ("I finished the painting", "social", "pride", "gentle"),
                 ("Tease me", "social", "playful", "gentle")]
        for text, mode, primary, secondary in cases:
            plan = presence.response_plan(text, {"mode": mode})
            self.assertEqual((plan["primary"], plan["secondary"]), (primary, secondary))
        self.assertEqual(presence.response_plan("hello", {"mode": "social", "repair_pending": True})["primary"], "thoughtful")
        self.assertEqual(presence.response_plan("hello", {"mode": "social"})["primary"], "neutral")

    def test_explicit_expression_cues(self):
        for text, expected in [("Surprise me", "surprised"), ("I am worried", "concerned"),
                               ("That's funny", "amused"), ("I love you", "affectionate"),
                               ("I am delighted", "delighted"), ("look flirty", "flirty"),
                               ("look coy", "coy"), ("be mischievous", "mischievous"),
                               ("look adoring", "adoring"), ("be bashful", "bashful"),
                               ("look excited", "excited"), ("be pouty", "pouty"),
                               ("look sleepy", "sleepy"), ("look contented", "contented"),
                               ("look savoring", "savoring"), ("look pleasantly surprised", "pleasant_surprise"),
                               ("look disgusted", "disgust"), ("look shocked", "shock"), ("look cute", "cute"),
                               ("look pleased", "pleased")]:
            plan = presence.response_plan(text, {"mode": "social"})
            self.assertEqual(plan["primary"], expected)
            self.assertTrue(presence.response_hint(plan))

    def test_voice_cadence_varies_without_another_history_or_catchphrase(self):
        short = presence.voice_hint("Oui.")
        long = presence.voice_hint("Une réponse déjà très développée. " * 8)
        self.assertNotEqual(short, long)
        self.assertIn("question finale systématique", short)
        self.assertNotIn("Une réponse déjà", long)

    def test_followthrough_retains_stated_meaning_without_inventing_it(self):
        memory.observe_user("My robot matters to me because I want to finish something difficult.", DEV)
        memory.observe_user("Je travaille sur le robot.", DEV)
        result = memory.observe_user("J'ai fini le robot.", DEV2)
        self.assertIn("POURQUOI CELA COMPTAIT", result)
        self.assertIn("finish something difficult", result)
        self.assertNotIn("you feel", result)
        unrelated = memory.observe_user("I finished the painting.", DEV2)
        self.assertNotIn("robot matters", unrelated)

    def test_removed_meaning_does_not_colour_a_followup(self):
        memory.observe_user("My robot matters to me because I want to finish something difficult.", DEV)
        source = memory.snapshot()["development"][0]["source_ids"][0]
        memory.forget(source)
        memory.observe_user("Je travaille sur le robot.", DEV)
        self.assertNotIn("POURQUOI CELA COMPTAIT", memory.observe_user("J'ai fini le robot.", DEV2))

    def test_opinion_change_exposes_both_sources_and_is_reversible(self):
        memory.observe_user("I tried painting and it worked because colours helped.", DEV)
        self.clock[0] += 1
        memory.observe_user("I tried painting and it failed because the pigments faded.", DEV2)
        card = memory.snapshot()["development"][0]
        self.assertEqual((card["stance"], card["previous_stance"]), ("negative", "positive"))
        self.assertIn("colours helped", card["previous_evidence"])
        packet = memory.context_packet("painting", conversation_text="What do you think about painting?")
        self.assertIn("ce qui a changé", packet["memories"][0])
        memory.forget(card["source_ids"][-1])
        self.assertEqual(memory.snapshot()["development"][0]["stance"], "positive")

    def test_journal_correction_recomputes_without_reinforcing_an_extra_day(self):
        memory.observe_user("Our ritual is coffee before painting.", DEV)
        _, before = self.request("memory")
        episode = before["episodes"][0]
        self.clock[0] += 86401
        code, after = self.request("episode_correct", id=episode["id"], revision=before["revision"],
                                   text="Our ritual is tea before painting.")
        self.assertEqual(code, 200, after)
        self.assertEqual(after["development"][0]["topic"], "tea before painting")
        self.assertEqual(after["development"][0]["reinforcement_days"], 1)
        self.assertEqual(after["episodes"][0]["at"], episode["at"])
        self.assertEqual(after["episodes"][0]["evidence"], "user_correction")
        self.assertFalse(self.calls)

    def test_stale_invalid_and_cross_owner_corrections_preserve_sources(self):
        memory.observe_user("Our ritual is coffee before painting.", DEV)
        _, before = self.request("memory")
        source = before["episodes"][0]
        for revision, text in [(True, "Our ritual is tea."), (before["revision"]-1, "Our ritual is tea."),
                               (before["revision"], "Imagine our ritual is tea."), (before["revision"], "Our ritual is tea?")]:
            code, _ = self.request("episode_correct", id=source["id"], revision=revision, text=text)
            self.assertEqual(code, 400)
        code, _ = ai.http_post({"action": "transferania", "op": "episode_correct", "device_id": DEV2,
            "id": source["id"], "revision": 0, "text": "Our ritual is tea."}, role="admin", owner_id="other")
        self.assertEqual(code, 400)
        self.assertEqual(memory.snapshot()["episodes"], before["episodes"])
        code, _ = ai.http_post({"action": "transferania", "op": "episode_correct", "device_id": DEV2, "id": source["id"],
            "revision": before["revision"], "text": "Our ritual is tea."}, role="upload")
        self.assertEqual(code, 403)

    def test_reply_plan_and_voice_guidance_use_the_existing_provider_call(self):
        code, out = self.request("send", message="Why are leaves shaped this way?", persona="warm")
        self.assertEqual(code, 200, out)
        self.assertEqual(out["expression"]["primary"], "curiosity")
        self.assertEqual(out["expression"]["voice"], "thoughtful")
        self.assertEqual(len(self.calls), 1)
        prompt = json.dumps(self.calls[0][1], ensure_ascii=False)
        self.assertIn("NUANCE DE RÉPONSE", prompt)
        self.assertIn("VOIX TRANSFERANIA", prompt)
        self.assertLessEqual(out["context_usage"]["estimated_input_tokens"], out["context_usage"]["input_budget"])
