"""Else-inspired arbitration without Else runtime/data or additional model calls."""
import json

import hq_ai as ai
import hq_companion_memory as memory
import hq_companion_presence as presence
from tests.test_hq_ai import Base, DEV, DEV2


class PresenceTests(Base):
    def test_family_canon_keeps_transferania_distinct_and_the_bond_warm(self):
        for persona in ("warm", "flirt"):
            for compact in (False, True):
                text = presence.character_hint(persona, compact=compact)
                self.assertIn("Transferina", text)
                self.assertIn("Else", text)
                self.assertIn("Maître", text)
                self.assertIn("Static", text)
                self.assertIn("plus intense qu'Else", text)
                if compact:
                    self.assertLessEqual(len(text.encode("utf-8")), 320)
                else:
                    self.assertIn("complicité affectueuse", text)
                    self.assertIn("sa propre identité", text)

    def test_temperament_reaches_chat_and_ambient_core_without_calls(self):
        for channel in ("chat", "ambient"):
            for core in (False, True):
                for persona in ("warm", "flirt"):
                    system = ai.build_transferania_system(
                        channel, persona, nsfw=False, view="accueil",
                        device_id=DEV, context_core=core)
                    self.assertEqual(system.count("TEMPÉRAMENT :"), 1)
                    self.assertIn("humour noir", system)
                    if channel == "ambient":
                        self.assertIn("aucune supposition sur son corps", system)
                        self.assertIn("Flirt audacieux et piquant." if persona == "flirt" else "Complicité amicale.", system)
                    elif persona == "flirt":
                        self.assertIn("CHIMIE : flirt joueur", system)
                        self.assertIn("une demande de sérieux", system)
                    elif channel == "chat":
                        self.assertIn("ne transforme pas ces goûts en avances", system)
        self.assertFalse(self.calls)

    def test_deeper_character_fits_budgets_and_preserves_visual_grounding(self):
        for channel in ("chat", "ambient"):
            for persona in ("warm", "flirt"):
                for adult in (False, True):
                    system = ai.build_transferania_system(
                        channel, persona, nsfw=adult, view="accueil",
                        device_id=DEV, context_core=True)
                    _, _, usage = ai.build_companion_context(channel, system, "Bonjour !")
                    self.assertLessEqual(usage["estimated_input_tokens"], usage["input_budget"])
                    self.assertIn("veines", system.lower())
        full = presence.character_hint("flirt")
        self.assertIn("SIGNATURE — VEINES", full)
        self.assertIn("du bout du doigt", full)
        self.assertIn("satisfaction esthétique", full)
        self.assertIn("Ne prétends pas sentir un contact ou un pouls réel", full)
        self.assertIn("Pouls : artères", full)
        self.assertIn("doux mordillements consentis sur la peau, sans blessure", full)
        self.assertIn("la peau bouger légèrement avec ce geste, sans prétendre l'observer", full)
        self.assertIn("sans attribuer de supériorité morale", full)
        self.assertIn("véritables vaisseaux sanguins", full)
        self.assertIn("jamais un contact physique réellement effectué", full.replace("\n", " "))
        self.assertIn("une image effectivement accessible", full)
        self.assertIn("pour une description", full)
        self.assertIn("pas de blessure, de diagnostic", full)
        self.assertIn("changer d'avis avec une raison précise", full)
        self.assertIn("ne ramène pas chaque échange", full)
        self.assertFalse(self.calls)

    def send(self, text, device=DEV):
        code, data = ai.http_post({"action": "transferania", "op": "send", "message": text,
                                  "device_id": device, "persona": "warm"}, role="admin")
        self.assertEqual(code, 200, data)
        return data

    def outcome(self):
        memory.observe_user("Je travaille sur le robot.", DEV)
        self.clock[0] += 10
        memory.observe_user("J'ai fini le robot.", DEV)

    def test_mode_follows_current_request(self):
        for text, expected in (("Fix the API quota bug", "practical"),
                               ("Je me sens triste", "comfort"),
                               ("I'm overwhelmed by this API bug", "comfort"),
                               ("Can you fix this API bug? I'm overwhelmed", "practical"),
                               ("Do you remember our decision?", "recall"),
                               ("Bonjour", "social")):
            self.assertEqual(presence.classify(text), expected)

    def test_single_continuity_slot_and_practical_suppression(self):
        state = {"mode": "social", "at": self.clock[0]}
        decision = presence.arbitrate(state, now=self.clock[0], has_followup=True, has_episode=True)
        self.assertEqual(decision["continuity_kind"], "followup")
        for mode in ("practical", "comfort"):
            self.assertEqual(presence.arbitrate({**state, "mode": mode}, now=self.clock[0], has_followup=True, has_episode=True)["continuity_kind"], "none")

    def test_repair_suppresses_callbacks_but_explicit_recall_can_answer(self):
        now = self.clock[0]
        state = presence.advance({}, "You misunderstood what I asked", now)
        self.assertTrue(state["repair_until"] > now)
        self.assertEqual(presence.arbitrate(state, now=now, has_followup=True, has_episode=True)["continuity_kind"], "none")
        recalled = presence.arbitrate(state, now=now, has_followup=True, has_episode=True, explicit_recall=True)
        self.assertEqual(recalled["continuity_kind"], "episode")
        self.assertEqual(presence.advance(state, "Thanks, but you are still wrong", now + 1)["repair_until"], state["repair_until"])
        self.assertEqual(presence.advance(state, "Thanks, that's better", now + 2)["repair_until"], 0)

    def test_quoted_correction_does_not_start_repair(self):
        state = presence.advance({}, 'Explain the phrase "you misunderstood"', self.clock[0])
        self.assertEqual(state["repair_until"], 0)

    def test_old_practical_mode_expires_without_a_timer(self):
        now = self.clock[0]
        state = {"mode": "practical", "at": now - 1801}
        self.assertEqual(presence.arbitrate(state, now=now, has_followup=True, has_episode=False)["mode"], "social")

    def test_style_is_explicit_shared_and_reversible(self):
        self.send("Je préfère les réponses courtes.")
        packet = memory.context_packet("bonjour")
        self.assertEqual(packet["presence"]["style"]["detail"], "concise")
        self.send("Bonjour", DEV2)
        self.assertIn("réponses concises", json.dumps(self.calls[-1][1], ensure_ascii=False))
        item = next(m for m in memory.snapshot()["memories"] if "courtes" in m["text"])
        memory.forget(item["id"])
        self.assertEqual(memory.context_packet("bonjour")["presence"]["style"]["detail"], "balanced")

    def test_temporary_request_does_not_permanently_change_style(self):
        self.send("Please be concise for this answer.")
        self.assertEqual(memory.context_packet("hello")["presence"]["style"]["detail"], "balanced")

    def test_unrelated_preferences_do_not_change_reply_style(self):
        for text in ("I like short button animations.", "Je préfère les réponses françaises."):
            memory.observe_user(text, DEV)
        style = memory.context_packet("hello")["presence"]["style"]
        self.assertEqual(style, {"detail": "balanced", "tone": "warm"})

    def test_completed_project_is_an_episode_not_current_work(self):
        self.outcome()
        data = memory.snapshot()
        self.assertFalse(any(m["kind"] == "project" for m in data["memories"]))
        self.assertEqual(data["episodes"][0]["text"], "J'ai fini le robot.")
        packet = memory.context_packet("Did I finish the robot?", conversation_text="Did I finish the robot?")
        self.assertEqual(packet["selected_episode_count"], 1)
        self.assertIn("robot", packet["continuity"])
        self.assertEqual(self.calls, [])

    def test_fictional_or_questioned_completion_does_not_resolve_or_create_episode(self):
        memory.observe_user("Je travaille sur le robot.", DEV)
        for text in ('"I finished the robot."', "Imagine I finished the robot.", "I finished the robot?"):
            memory.observe_user(text, DEV)
        self.assertTrue(memory.snapshot()["followups"])
        self.assertFalse(memory.snapshot()["episodes"])

    def test_genuine_return_callback_is_relevant_and_cooldown_bounded(self):
        self.outcome()
        self.clock[0] += 21601
        memory.observe_user("About the robot", DEV2)
        first = memory.context_packet("robot", conversation_text="About the robot", reserve_followup=True)
        self.assertEqual(first["presence"]["continuity_kind"], "episode")
        second = memory.context_packet("robot", conversation_text="About the robot", reserve_followup=True)
        self.assertEqual(second["presence"]["continuity_kind"], "none")

    def test_episode_can_be_inspected_and_removed(self):
        self.outcome()
        episode = memory.snapshot()["episodes"][0]
        memory.forget(episode["id"])
        packet = memory.context_packet("robot", conversation_text="Do you remember the robot?")
        self.assertEqual(packet["selected_episode_count"], 0)

    def test_completed_project_does_not_return_through_old_device_import(self):
        self.outcome()
        thread = {"messages": [{"role": "user", "text": "Je travaille sur le robot.", "ts": self.clock[0] - 10}]}
        memory.migrate(DEV2, thread)
        self.assertFalse(any(m["kind"] == "project" for m in memory.snapshot()["memories"]))

    def test_two_callbacks_do_not_compete_and_tasks_do_not_get_followups(self):
        self.outcome()
        memory.observe_user("Je travaille sur le jardin.", DEV)
        self.clock[0] += 86401
        memory.observe_user("Bonjour", DEV2)
        packet = memory.context_packet("robot", conversation_text="Bonjour", reserve_followup=True)
        self.assertEqual(packet["presence"]["continuity_kind"], "followup")
        self.assertNotIn("ÉPISODE", packet["continuity"])
        task = memory.context_packet("robot", conversation_text="Fix the robot API bug")
        self.assertEqual(task["presence"]["continuity_kind"], "none")

    def test_modes_and_episode_selection_are_visible_without_private_text_in_metrics(self):
        self.outcome()
        out = self.send("Do you remember the robot?", DEV2)
        metrics = out["context_usage"]
        self.assertEqual(metrics["conversation_mode"], "recall")
        self.assertEqual(metrics["selected_episode_count"], 1)
        self.assertNotIn("J'ai fini", json.dumps(metrics))
        self.assertEqual(metrics["provider_attempts"], 1)

    def test_old_profile_gains_optional_fields_without_losing_memories(self):
        memory.observe_user("I prefer coffee.", DEV)
        path = memory.path()
        old = json.loads(path.read_text("utf-8"))
        old.pop("presence")
        old.pop("episodes")
        path.write_text(json.dumps(old), encoding="utf-8")
        self.assertEqual(memory.context_packet("coffee")["memories"], ["I prefer coffee"])

    def test_question_is_not_a_decision_but_a_stated_decision_is_recalled(self):
        memory.observe_user("We decided to use Gemma?", DEV)
        self.assertFalse(memory.snapshot()["episodes"])
        memory.observe_user("We decided to use Gemma for small jobs.", DEV)
        packet = memory.context_packet("Gemma", conversation_text="What did we decide about Gemma?")
        self.assertIn("We decided to use Gemma", packet["continuity"])
        self.assertFalse(self.calls)

    def test_budget_omission_releases_the_unused_continuity_slot(self):
        self.outcome()
        self.clock[0] += 21601
        memory.observe_user("About the robot", DEV)
        packet = memory.context_packet("robot", conversation_text="About the robot", reserve_followup=True)
        self.assertEqual(packet["presence"]["continuity_kind"], "episode")
        ai._finalize_continuity_context(packet, [{"role": "user", "parts": [{"text": "current message only"}]}])
        retry = memory.context_packet("robot", conversation_text="About the robot", reserve_followup=True)
        self.assertEqual(retry["presence"]["continuity_kind"], "episode")
