"""Grounded, reversible development within existing context and identity limits."""
import json

import hq_ai as ai
import hq_companion_memory as memory
import hq_companion_growth as growth
from tests.test_hq_ai import Base, DEV, DEV2


class GrowthTests(Base):
    def observe(self, text, device=DEV):
        memory.observe_user(text, device)

    def views(self):
        return memory.snapshot()["development"]

    def test_reported_experience_becomes_revisable_view_not_verified_fact(self):
        source = "I tried caching and it worked because repeated reads became faster."
        self.observe(source)
        view = self.views()[0]
        self.assertEqual(view["topic"], "caching")
        self.assertEqual(view["evidence"], source)
        self.assertEqual(view["evidence_type"], "user_report")
        packet = memory.context_packet("caching", conversation_text="What do you think about caching?")
        self.assertIn("Piste à privilégier", packet["memories"][0])
        self.assertIn("non vérifiée indépendamment", packet["memories"][0])
        self.assertEqual(packet["continuity"], "")
        self.assertLessEqual(len(packet["memories"]), 5)
        self.assertFalse(self.calls)

    def test_later_evidence_changes_opinion_and_removal_recalculates(self):
        self.observe("I tried caching and it worked because reads were faster.")
        self.clock[0] += 10
        self.observe("I tried caching and it failed because invalidation was unreliable.", DEV2)
        latest = self.views()[0]
        self.assertIn("Réserve", latest["description"])
        self.assertIn("change l'avis précédent", latest["description"])
        memory.forget(latest["source_ids"][-1])
        self.assertIn("Piste à privilégier", self.views()[0]["description"])
        memory.forget(self.views()[0]["source_ids"][0])
        self.assertFalse(self.views())

    def test_mixed_results_remain_uncertain(self):
        self.observe("I tried caching and it worked locally but it failed in production.")
        self.assertIn("Résultats mitigés", self.views()[0]["description"])

    def test_interest_requires_separate_days_and_is_bounded_by_time(self):
        self.observe("I'm curious about orbital mechanics.")
        self.observe("I keep exploring orbital mechanics.")
        self.assertFalse(self.views())
        self.clock[0] += 86401
        self.observe("I'm curious about orbital mechanics.", DEV2)
        self.assertEqual(len(self.views()), 1)
        packet = memory.context_packet("orbital mechanics", conversation_text="Are you curious about orbital mechanics?")
        self.assertIn("Intérêt partagé", packet["memories"][0])
        for text in ("What are your interests?", "What are you interested in?", "Qu'est-ce qui t'intéresse ?"):
            packet = memory.context_packet(text, conversation_text=text)
            self.assertIn("orbital mechanics", packet["memories"][0])
        self.clock[0] += 91 * 86400
        self.assertFalse(self.views())

    def test_why_matters_preserves_negative_meaning_and_full_source(self):
        source = "My robot matters to me because I don't want to abandon another unfinished project."
        self.observe(source)
        view = self.views()[0]
        self.assertEqual(view["kind"], "meaning")
        self.assertEqual(view["evidence"], source)
        packet = memory.context_packet("robot", conversation_text="Why does my robot matter to me?")
        self.assertIn("don't want to abandon", packet["memories"][0])
        self.assertNotIn("sad", packet["memories"][0])

    def test_reasoned_decision_has_one_source_and_retains_why(self):
        self.observe("We decided to use Gemma because the quota suits short replies.")
        self.assertEqual(len(memory.snapshot()["episodes"]), 1)
        self.assertEqual(self.views()[0]["kind"], "meaning")
        self.assertIn("quota", self.views()[0]["evidence"])

    def test_explicit_frustration_is_about_event_not_current_mood_forever(self):
        self.observe("J'étais frustré par le déploiement parce que mes corrections avaient disparu.")
        self.assertEqual(self.views()[0]["kind"], "meaning")
        self.assertIn("sans inventer d'émotion", self.views()[0]["description"])

    def test_questions_fiction_quotations_and_incomplete_reports_do_not_develop(self):
        for text in ('"I tried caching and it worked."',
                     "Imagine I tried caching and it worked.",
                     "I tried caching and it worked?",
                     "I tried caching and it might have worked.",
                     "My robot matters to me because",
                     "I'm curious about orbital mechanics?",
                     "If I tried caching and it worked, would you like it?",
                     "I tried caching and it worked " + "very " * 150):
            self.assertIsNone(growth.extract(text), text)
            self.observe(text)
        self.assertFalse(self.views())

    def test_background_tasks_and_unrelated_topics_do_not_get_reflections(self):
        self.observe("I tried caching and it worked because reads were faster.")
        for text in ("Fix the API bug", "I feel sad", "What do you think about painting?"):
            packet = memory.context_packet("caching " + text, conversation_text=text)
            self.assertFalse(any("Avis provisoire" in m for m in packet["memories"]))
            self.assertEqual(packet["continuity"], "")

    def test_owner_isolation_and_shared_devices(self):
        self.observe("I tried caching and it worked because reads were faster.", DEV)
        code, shared = ai.http_post({"action": "transferania", "op": "memory", "device_id": DEV2}, role="admin")
        self.assertEqual(code, 200)
        self.assertEqual(len(shared["development"]), 1)
        _, other = ai.http_post({"action": "transferania", "op": "memory", "device_id": DEV2}, role="admin", owner_id="another-owner")
        self.assertFalse(other["development"])

    def test_api_uses_existing_budget_and_metadata_excludes_evidence(self):
        source = "I tried caching and it worked because reads were faster."
        self.observe(source)
        code, out = ai.http_post({"action": "transferania", "op": "send", "message": "What do you think about caching?",
                                 "device_id": DEV2, "persona": "flirt"}, role="admin")
        self.assertEqual(code, 200, out)
        sent = json.dumps(self.calls[-1][1], ensure_ascii=False)
        self.assertIn("Avis provisoire", sent)
        self.assertIn("CHIMIE : flirt joueur", sent)
        self.assertEqual(len(self.calls), 1)
        self.assertLessEqual(out["context_usage"]["estimated_input_tokens"], out["context_usage"]["input_budget"])
        self.assertNotIn(source, json.dumps(out["context_usage"]))

    def test_sources_survive_reload_and_forgotten_sources_do_not_return(self):
        self.observe("I tried caching and it worked because reads were faster.")
        source_id = self.views()[0]["source_ids"][0]
        memory.bind(root=self.root, now=lambda: self.clock[0])
        self.assertTrue(self.views())
        memory.forget(source_id)
        memory.bind(root=self.root, now=lambda: self.clock[0])
        self.assertFalse(self.views())

    def test_reinforced_interest_surfaces_naturally_without_a_memory_question(self):
        self.observe("I'm curious about orbital mechanics.")
        self.clock[0] += 86401
        self.observe("I keep exploring orbital mechanics.", DEV2)
        query = "Let's talk about orbital mechanics tonight."
        packet = memory.context_packet(query, conversation_text=query, reserve_followup=True)
        self.assertEqual(packet["presence"]["continuity_kind"], "episode")
        self.assertIn("ÉVOLUTION VÉCUE", packet["continuity"])
        self.assertIn("orbital mechanics", packet["continuity"])
        self.assertEqual(memory.context_packet(query, conversation_text=query)["continuity"], "")
        memory.cancel_context_reservation(packet)
        self.assertIn("orbital mechanics", memory.context_packet(query, conversation_text=query)["continuity"])
        self.assertFalse(self.calls)

    def test_single_sitting_does_not_create_a_durable_character_motif(self):
        for n in range(6):
            self.observe(f"I tried painting and it worked because colour study {n} helped.")
        card = self.views()[0]
        self.assertEqual(card["reinforcement_days"], 1)
        self.assertEqual(card["salience"], .2)
        self.assertEqual(memory.context_packet("painting", conversation_text="Let's talk about painting.")["continuity"], "")

    def test_repeated_evidence_on_separate_days_reinforces_and_decays(self):
        source = "I tried painting and it worked because the colours were expressive."
        self.observe(source)
        self.clock[0] += 86401
        self.observe(source, DEV2)
        card = self.views()[0]
        self.assertEqual(card["reinforcement_days"], 2)
        self.assertEqual(card["salience"], .4)
        self.clock[0] += 40*86400
        self.assertLess(self.views()[0]["salience"], card["salience"])
        memory.forget(card["source_ids"][-1])
        self.assertEqual(self.views()[0]["reinforcement_days"], 1)
        query = "Let's talk about painting."
        self.assertIsNone(growth.natural_callback(self.views(), query, terms=memory.terms))

    def test_explicit_ritual_is_reviewable_optional_and_reversible(self):
        source = "Our ritual is coffee before painting."
        self.observe(source)
        card = self.views()[0]
        self.assertEqual(card["kind"], "ritual")
        self.assertIn("facultatif", card["description"])
        query = "Coffee and painting tonight."
        self.assertIn(source, memory.context_packet(query, conversation_text=query)["continuity"])
        memory.bind(root=self.root, now=lambda: self.clock[0])
        self.assertEqual(self.views()[0]["evidence"], source)
        memory.forget(card["source_ids"][0])
        self.assertFalse(self.views())
        self.assertEqual(memory.context_packet(query, conversation_text=query)["continuity"], "")

    def test_motifs_do_not_intrude_on_tasks_comfort_repair_or_other_topics(self):
        self.observe("Our ritual is coffee before painting.")
        for query in ("Fix the painting API", "I feel sad about painting", "Let's talk about astronomy."):
            self.assertEqual(memory.context_packet(query, conversation_text=query)["continuity"], "", query)
        self.observe("You misunderstood.")
        self.assertEqual(memory.context_packet("coffee painting", conversation_text="Coffee and painting tonight.")["continuity"], "")

    def test_ritual_extractor_rejects_quoted_hypothetical_and_assistant_claims(self):
        for text in ('"Our ritual is coffee."', "Our ritual is coffee?", "Imagine our ritual is coffee."):
            self.assertIsNone(growth.extract(text))
        memory.observe_reply("hello", "Our ritual is coffee.", DEV)
        self.assertFalse(self.views())

    def test_explicit_retirement_stops_a_ritual_and_forgetting_it_restores_source(self):
        self.observe("Our ritual is coffee before painting.")
        self.clock[0] += 1
        self.observe("Our ritual is no longer coffee before painting.", DEV2)
        self.assertFalse(self.views())
        cancellation = memory.snapshot()["episodes"][-1]
        memory.forget(cancellation["id"])
        self.assertEqual(self.views()[0]["topic"], "coffee before painting")

    def test_natural_evolution_is_owner_scoped_and_uses_existing_model_budget(self):
        source = "Our ritual is coffee before painting."
        self.observe(source)
        message = "Let's talk about coffee and painting tonight."
        code, out = ai.http_post({"action": "transferania", "op": "send", "message": message,
                                 "device_id": DEV2, "persona": "warm"}, role="admin")
        self.assertEqual(code, 200, out)
        self.assertEqual(len(self.calls), 1)
        self.assertIn("Rituel partagé", json.dumps(self.calls[-1][1], ensure_ascii=False))
        self.assertLessEqual(out["context_usage"]["estimated_input_tokens"], out["context_usage"]["input_budget"])
        _, other = ai.http_post({"action": "transferania", "op": "memory", "device_id": DEV2}, role="admin", owner_id="other-owner")
        self.assertFalse(other["development"])
