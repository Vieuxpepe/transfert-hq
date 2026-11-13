"""Contracts for the assistant roster, memory scopes, tool schemas and relationships."""
import importlib
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import hq_companion_memory as memory
import hq_personas
import hq_relationships as rel

PERSONAS = {
    "musica": ("hq_musica", "PERSONA_CORE", "fr"),
    "inventoria": ("hq_inventoria_ai", "PERSONA", "en"),
    "pistonia": ("hq_pistonia", "PERSONA", "en"),
    "culinia": ("hq_culinia", "PERSONA_CORE", "fr"),
    "forgia": ("hq_forgia", "PERSONA_CORE", "fr"),
    "securia": ("hq_securia", "PERSONA_CORE", "fr"),
}

TOOL_MODULES = (("hq_musica", "TOOL_SCHEMA"), ("hq_culinia", "TOOL_SCHEMA"),
                ("hq_forgia", "TOOL_SCHEMA"), ("hq_securia", "TOOL_SCHEMA"),
                ("hq_pistonia", "TOOLS_DOC"))


class PersonaRosterTests(unittest.TestCase):
    def test_every_prompt_names_the_whole_on_hq_roster(self):
        for key, (module_name, attr, lang) in PERSONAS.items():
            text = getattr(importlib.import_module(module_name), attr)
            self.assertIn(hq_personas.others_line(key, lang=lang), text, f"{module_name}.{attr} roster drifted")
            for other in hq_personas.others(key):
                self.assertIn(other["name"], text, f"{module_name}.{attr} misses {other['name']}")
            # Aliases stay in each assistant's own prompt; another assistant's
            # roster sentence must not carry them.
            self.assertNotIn("(", hq_personas.others_line(key), f"{key}: alias leaked into the roster")

    def test_static_stays_off_hq_and_out_of_the_roster(self):
        self.assertNotIn("static", hq_personas.on_hq_keys())
        self.assertFalse(hq_personas.get("static")["on_hq"])
        for key in hq_personas.on_hq_keys():
            self.assertNotIn("Static", hq_personas.others_line(key))

    def test_dj_guest_voices_come_from_the_registry(self):
        import hq_music_dj
        self.assertEqual(hq_music_dj.GUEST_VOICES, hq_personas.guest_voices())

    def test_unknown_assistant_is_refused(self):
        with self.assertRaises(ValueError):
            hq_personas.get("nobody")

    def test_every_entry_has_alias_quirks_habit_and_pastimes(self):
        for key in hq_personas.keys():
            entry = hq_personas.get(key)
            self.assertTrue(entry["alias"], key)
            self.assertEqual(len(entry["quirks"]), 3, key)
            self.assertTrue(all(len(q) > 12 for q in entry["quirks"]), key)
            self.assertTrue(entry["tell"], key)
            self.assertTrue(entry["pastimes"], key)
            self.assertIn(entry["alias"], hq_personas.quirks_line(key), key)

    def test_no_assistant_carries_another_prompt_alias(self):
        for key, (module_name, attr, _lang) in PERSONAS.items():
            text = getattr(importlib.import_module(module_name), attr)
            for other in hq_personas.keys():
                if other == key:
                    continue
                self.assertNotIn(hq_personas.get(other)["alias"], text,
                                 f"{key} carries {other}'s alias")

    def test_prompts_carry_their_own_quirks_line_once(self):
        import hq_companion_presence as presence
        import hq_else_persona
        for key, (module_name, attr, _lang) in PERSONAS.items():
            text = getattr(importlib.import_module(module_name), attr)
            self.assertEqual(text.count(hq_personas.quirks_line(key)), 1, f"{key}: quirks line missing or duplicated")
        self.assertEqual(hq_else_persona.ELSE_CAPSULE.count(hq_personas.quirks_line("else")), 1)
        # Transferania's editor is the live source: her registry pastimes only seed
        # the editable default, they are never injected a second time.
        self.assertIn(hq_personas.get("transferania")["pastimes"], presence.character_defaults()["pastimes"])


class TransferaniaAliasTests(unittest.TestCase):
    def setUp(self):
        import hq_ai as ai
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-alias-")
        ai.bind(root=Path(self.tmp.name), now=lambda: 1_700_000_100.0, key=lambda: "test-key")
        self.ai = ai
        self.kwargs = dict(nsfw=False, view="accueil", device_id="device-alias", prefs={}, signals={})

    def tearDown(self):
        self.tmp.cleanup()

    def test_alias_lives_in_the_stable_core_exactly_once(self):
        for channel in ("chat", "ambient"):
            system = self.ai.build_transferania_system(channel, "warm", trait_overrides={}, **self.kwargs)
            self.assertEqual(system.count("Transferina"), 1, channel)
            self.assertIn("Autre nom : « Transferina ».", system)

    def test_alias_survives_a_customised_editable_trait(self):
        # The alias is identity, not a field: editing the ambient voice text must
        # neither duplicate it nor delete it.
        system = self.ai.build_transferania_system(
            "ambient", "warm", trait_overrides={"ambient_warm": "Voix brève, sans fioriture."}, **self.kwargs)
        self.assertEqual(system.count("Transferina"), 1)
        self.assertIn("Voix brève, sans fioriture.", system)


class ToolContractTests(unittest.TestCase):
    def test_each_declared_tool_has_a_handler(self):
        for module_name, attr in TOOL_MODULES:
            module = importlib.import_module(module_name)
            source = Path(module.__file__).read_text(encoding="utf-8")
            declared = set(re.findall(r"^-\s*([a-z_][a-z0-9_]*)", getattr(module, attr), re.M))
            self.assertTrue(declared, f"{module_name}.{attr} declares no tools")
            for name in sorted(declared):
                self.assertGreaterEqual(len(re.findall(rf"\b{name}\b", source)), 2,
                                        f"{module_name}: {name} is declared but has no handler")


class MemoryScopeTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        memory.bind(root=self.root, now=lambda: 0.0)
        memory._owner.set("admin")

    def test_every_assistant_gets_its_own_file(self):
        paths = {}
        for key in hq_personas.on_hq_keys():
            with memory.memory_scope(key):
                paths[key] = memory.path()
        self.assertEqual(len(set(paths.values())), len(paths))
        with memory.memory_scope("else"):
            self.assertIn("else", memory.path().parts)
        with memory.memory_scope("transferania"):
            self.assertNotIn("transferania", memory.path().parts)  # original path kept

    def test_unknown_scope_raises_instead_of_borrowing_transferania(self):
        for name in ("nobody", "static"):
            with self.assertRaises(ValueError):
                with memory.memory_scope(name):
                    pass


class RelationshipTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def test_two_distinct_days_before_familiarity_is_mentioned(self):
        rel.note_exchange(self.root, "else", "transferania", "Salut", now=1_700_000_000)
        self.assertEqual(rel.line(self.root, "else", "transferania"), "")
        rel.note_exchange(self.root, "else", "transferania", "Encore", now=1_700_100_000)
        row = rel.pair(self.root, "else", "transferania")
        self.assertEqual((row["exchanges"], row["days"]), (2, 2))
        self.assertIn("2 jours", rel.line(self.root, "else", "transferania"))

    def test_one_sitting_cannot_reinforce_familiarity(self):
        for _ in range(4):
            rel.note_exchange(self.root, "else", "transferania", "Bavardage", now=1_700_000_000)
        self.assertEqual(rel.pair(self.root, "else", "transferania")["days"], 1)

    def test_no_affection_score_and_unknown_assistant_refused(self):
        row = rel.note_exchange(self.root, "else", "transferania", "Salut", now=1_700_000_000)
        self.assertEqual(set(row), {"a", "b", "exchanges", "days", "last_at", "motif"})
        with self.assertRaises(ValueError):
            rel.note_exchange(self.root, "else", "nobody", "Salut")


class InventoriaMemoryTests(unittest.TestCase):
    def setUp(self):
        import hq_inventoria_memory
        self.mem = hq_inventoria_memory
        self.root = Path(tempfile.mkdtemp())

    def test_relevant_notes_are_selected_instead_of_the_whole_notepad(self):
        for index in range(10):
            self.mem.add(self.root, f"note numero {index} sur les vis")
        self.mem.add(self.root, "Le Master range le ruban adhesif dans le garage")
        block = self.mem.prompt_block(self.root, "ou est le ruban adhesif ?")
        self.assertIn("ruban adhesif", block)
        self.assertNotIn("note numero 0", block)

    def test_explicit_correction_supersedes_the_note(self):
        first = self.mem.add(self.root, "Le Master range les vis dans le garage")
        second = self.mem.add(self.root, "En fait le Master range les vis dans le sous-sol")
        self.assertEqual(second.get("superseded"), first["id"])
        self.assertEqual(len(self.mem.list_notes(self.root)), 1)

    def test_cap_reports_the_evicted_note(self):
        for index in range(self.mem.MAX_NOTES):
            self.mem.add(self.root, f"preference numero {index}")
        out = self.mem.add(self.root, "preference numero supplementaire")
        self.assertEqual(len(out["evicted"]), 1)

    def test_unreadable_file_is_preserved_untouched(self):
        path = self.root / self.mem.STATE_FOLDER / self.mem.FILE
        path.parent.mkdir(parents=True)
        path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(self.mem.MemoryError_):
            self.mem.add(self.root, "Le Master achete du lait le samedi")
        self.assertEqual(path.read_text(encoding="utf-8"), "{not json")
        self.assertIn("INDISPONIBLE", self.mem.prompt_block(self.root, "lait"))


class PrefsGuardTests(unittest.TestCase):
    def _check(self, module_name, folder, filename, error, block):
        module = importlib.import_module(module_name)
        root = Path(tempfile.mkdtemp())
        module.bind(root=root)
        path = root / folder / filename
        path.parent.mkdir(parents=True)
        path.write_text("{oops", encoding="utf-8")
        with self.assertRaises(error):
            module._save_json(filename, {"likes": []})
        self.assertEqual(path.read_text(encoding="utf-8"), "{oops")
        self.assertIn("illisibles", block())

    def test_culinia_corrupt_preferences_are_not_replaced(self):
        import hq_culinia as culinia
        self._check("hq_culinia", ".hq-household", "culinia_prefs.json", culinia.CuliniaError,
                    culinia._prefs_prompt_block)

    def test_forgia_corrupt_preferences_are_not_replaced(self):
        import hq_forgia as forgia
        self._check("hq_forgia", ".hq-forge", "forgia_prefs.json", forgia.ForgiaError,
                    forgia._prefs_prompt_block)


class PersonalityMigrationTests(unittest.TestCase):
    def test_profile_saved_before_pastimes_still_loads(self):
        """A near-cap profile from before the sixth trait must not become unreadable."""
        root = Path(tempfile.mkdtemp())
        memory.bind(root=root, now=lambda: 0.0)
        memory._owner.set("admin")
        with memory.memory_scope("transferania"):
            data = memory._empty()
            data["personality"] = {"humor": "x" * 2300, "curiosity": "y" * 2200}
            memory._save(data)
            traits = memory.personality_traits()
        self.assertEqual(traits["humor"], "x" * 2300)
        with self.assertRaises(ValueError):
            memory.validate_personality(traits, enforce_budget=True)


class PastimesTraitTests(unittest.TestCase):
    def test_pastimes_is_editable_and_counted_in_the_budget(self):
        import hq_companion_presence as presence
        defaults = presence.character_defaults()
        self.assertIn("pastimes", defaults)
        saved = memory.validate_personality({"pastimes": "Dessiner des réseaux."})
        self.assertEqual(saved["pastimes"], "Dessiner des réseaux.")
        hint = presence.character_hint("warm", traits={"pastimes": "Dessiner des réseaux."})
        self.assertIn("Dessiner des réseaux.", hint)


class SisterRelationshipTests(unittest.TestCase):
    def test_real_sister_exchange_records_relationship_evidence(self):
        import hq_ai as ai
        with tempfile.TemporaryDirectory(prefix="hq-rel-") as tmp:
            root = Path(tmp)
            ai.bind(root=root, now=lambda: 1_700_000_100.0, key=lambda: "test-key")
            memory.bind(root=root, now=lambda: 1_700_000_100.0)
            owner = memory._owner.set("admin")
            lines = iter(["Salut Else.", "Salut Transferania."])
            try:
                with mock.patch.object(ai, "generate", side_effect=lambda *a, **k: (next(lines), "gemini-3.1-flash-lite")), \
                     mock.patch.object(ai, "_api_keys", return_value=["k"]), \
                     mock.patch.object(ai, "transferania_ok", return_value=True), \
                     mock.patch.object(ai, "nsfw_allowed", return_value=False):
                    code, out = ai.http_post({"action": "sister", "op": "exchange", "topic": "le pont",
                                              "turns": 2, "view": "accueil", "device_id": "device-rel-01"},
                                             role="admin", owner_id="admin")
                self.assertEqual(code, 200, out)
                bond = ai.sister_history(device_id="device-rel-01")["bond"]
                self.assertEqual(bond["exchanges"], 2)
                self.assertEqual(bond["days"], 1)
            finally:
                memory._owner.reset(owner)


class MusicaTasteTests(unittest.TestCase):
    def test_her_taste_is_separate_from_the_master_profile(self):
        import hq_musica
        taste = {"history_sharing": True, "banned_artists": [], "loved": [], "rejected": []}
        system = hq_musica.persona_system(spotify_connected=False,
                                          profile={"favorite_artists": [], "preferred_genres": []},
                                          taste=taste)
        self.assertIn("TES GOÛTS À TOI", system)
        self.assertIn("pas des faits sur le Maître", system)


if __name__ == "__main__":
    unittest.main()
