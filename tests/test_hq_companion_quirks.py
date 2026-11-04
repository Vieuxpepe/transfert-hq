"""Contextual character habits without permanent prompt/catalog growth."""
import json

import hq_ai as ai
import hq_companion_memory as memory
import hq_companion_presence as presence
from tests.test_hq_ai import Base, DEV


class QuirkTests(Base):
    def test_all_seven_habits_are_contextual_optional_and_small(self):
        cases = [("Tu es adorable", False, "bref trouble"),
                 ("I finished the painting.", False, "petite joie"),
                 ("Regarde ce petit détail.", False, "détail fourni"),
                 ("Reste avec moi.", False, "autocorrection"),
                 ("Notre rituel du café", True, "rituel fourni"),
                 ("My painting is crooked.", False, "doit être réparé"),
                 ("What about your sister Else?", False, "mot technique d'Else")]
        for text, ritual, expected in cases:
            hint = presence.quirk_hint(text, {"mode": "social"}, has_ritual=ritual)
            self.assertIn(expected, hint)
            self.assertEqual(hint.count("TOUCHE FACULTATIVE"), 1)
            self.assertLessEqual(len(hint.encode()), 300)
            delivery = presence.delivery_hint("Une réponse précédente.", text, {"mode": "social"}, has_ritual=ritual)
            self.assertLessEqual(len(delivery.encode()), 500)

    def test_no_habit_on_generic_tasks_distress_repair_or_recent_repetition(self):
        for mode in ("practical", "comfort", "recall"):
            self.assertEqual(presence.quirk_hint("You are adorable", {"mode": mode}), "")
        self.assertEqual(presence.quirk_hint("You are adorable", {"mode": "social", "repair_pending": True}), "")
        self.assertEqual(presence.quirk_hint("Bonjour", {"mode": "social"}), "")
        self.assertEqual(presence.quirk_hint("I finished the painting.", {"mode": "social"}, previous_reply="Bravo pour cette victoire !"), "")
        for text in ("Imagine I finished the painting.", '"I finished the painting."', "I finished the painting?"):
            self.assertEqual(presence.quirk_hint(text, {"mode": "social"}), "")

    def test_a_ritual_requires_current_grounded_context(self):
        query = "Notre rituel du café"
        self.assertEqual(presence.quirk_hint(query, {"mode": "social"}), "")
        memory.observe_user("Notre rituel c'est le café avant la peinture.", DEV)
        packet = memory.context_packet(query, conversation_text=query)
        self.assertTrue(packet["ritual_available"])
        source = memory.snapshot()["episodes"][0]["id"]
        memory.forget(source)
        self.assertFalse(memory.context_packet(query, conversation_text=query)["ritual_available"])

    def test_one_provider_call_and_no_permanent_core_growth(self):
        core_before = ai.build_transferania_system("chat", "warm", nsfw=False, view="accueil", device_id=DEV, context_core=True)
        code, out = ai.http_post({"action": "transferania", "op": "send", "message": "Tu es adorable",
            "persona": "warm", "device_id": DEV}, role="admin")
        self.assertEqual(code, 200, out)
        self.assertEqual(len(self.calls), 1)
        prompt = json.dumps(self.calls[0][1], ensure_ascii=False)
        self.assertEqual(prompt.count("TOUCHE FACULTATIVE"), 1)
        self.assertIn("bref trouble", prompt)
        self.assertNotIn("mot technique d'Else", prompt)
        core_after = ai.build_transferania_system("chat", "warm", nsfw=False, view="accueil", device_id=DEV, context_core=True)
        self.assertEqual(core_before, core_after)
        self.assertFalse(memory.snapshot()["development"])
        self.assertLessEqual(out["context_usage"]["estimated_input_tokens"], out["context_usage"]["input_budget"])

    def test_delivery_guidance_does_not_repeat_the_core_identity(self):
        hint = presence.voice_hint("Une réponse déjà assez longue. "*8)
        self.assertLess(len(hint.encode()), 200)
        self.assertNotIn("plus intense qu'Else", hint)
        self.assertNotIn("jargon industriel", hint)
        self.assertNotIn("Maître", hint)

    def test_page_signals_share_a_heading_without_losing_order_or_current_message(self):
        _, contents, usage = ai.build_companion_context("chat", "core", "current message",
            page="PAGE A\n\nTRUE EVENT B\n\nDELIVERY C\n\nPAGE A")
        prompt = contents[-1]["parts"][0]["text"]
        self.assertEqual(prompt.count("CONTEXTE ACTUEL:"), 1)
        self.assertEqual(prompt.count("PAGE A"), 1)
        self.assertLess(prompt.index("PAGE A"), prompt.index("TRUE EVENT B"))
        self.assertLess(prompt.index("TRUE EVENT B"), prompt.index("DELIVERY C"))
        self.assertTrue(prompt.endswith("current message"))
        self.assertLessEqual(usage["estimated_input_tokens"], usage["input_budget"])
