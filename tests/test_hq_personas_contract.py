"""Contracts for the assistant roster, memory scopes, tool schemas and relationships."""
import importlib
import json
import re
import tempfile
import threading
import time
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
        self.assertEqual(hq_else_persona.ELSE_CAPSULE.count(
            hq_personas.quirks_line("else", include_pastimes=False)), 1)
        # Her pastimes are an editable trait, so the capsule must not repeat them.
        self.assertNotIn(hq_personas.get("else")["pastimes"], hq_else_persona.ELSE_CAPSULE)
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
        memory.set_owner("admin")      # an explicit session, not the bare context default

    def test_unbound_owner_cannot_read_relationships(self):
        token = memory._owner_established.set(False)
        try:
            with self.assertRaises(RuntimeError):
                rel.pair(self.root, "else", "transferania")
        finally:
            memory._owner_established.reset(token)

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
        second = self.mem.add(self.root, "En fait le Master range les vis dans le sous-sol",
                              corrects_id=first["id"], expect="Le Master range les vis dans le garage")
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
            memory.set_owner("admin")
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
                memory.set_owner("admin")


class MusicaTasteTests(unittest.TestCase):
    def test_her_taste_is_separate_from_the_master_profile(self):
        import hq_musica
        taste = {"history_sharing": True, "banned_artists": [], "loved": [], "rejected": []}
        system = hq_musica.persona_system(spotify_connected=False,
                                          profile={"favorite_artists": [], "preferred_genres": []},
                                          taste=taste)
        self.assertIn("TES GOÛTS À TOI", system)
        self.assertIn("pas des faits sur le Maître", system)


class ReviewFixTests(unittest.TestCase):
    """Regressions from the package review: prompt ownership, store preservation, alerts."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-review-fix-")
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _ai(self):
        import hq_ai as ai
        ai.bind(root=self.root, now=lambda: 1_700_000_100.0, key=lambda: "test-key")
        return ai

    def test_default_prompt_carries_registry_pastimes(self):
        ai = self._ai()
        system = ai.build_transferania_system("chat", "warm", nsfw=False, view="accueil",
                                              device_id="device-pastimes", prefs={}, signals={},
                                              trait_overrides={})
        self.assertIn("OCCUPATIONS", system)
        self.assertIn(hq_personas.get("transferania")["pastimes"], system)

    def test_else_prompt_never_borrows_transferania_traits(self):
        import hq_companion_presence as presence
        ai = self._ai()
        system = ai.build_else_system("chat", "warm", nsfw=False, view="accueil",
                                      device_id="device-else-traits", prefs={})
        self.assertNotIn(presence.PASTIMES_DEFAULT, system)
        self.assertNotIn("NOYAU — TRANSFERANIA", system)
        self.assertNotIn(hq_personas.get("transferania")["pastimes"], system)
        self.assertIn(hq_personas.get("else")["pastimes"], system)

    def test_one_damaged_row_blocks_writes_and_preserves_file(self):
        import hq_inventoria_memory as inv
        p = self.root / inv.STATE_FOLDER / inv.FILE
        p.parent.mkdir(parents=True)
        good = {"id": "mem-aaaaaaaa", "text": "Le Master aime le thé vert.", "at": 1.0}
        raw = json.dumps({"version": 1, "notes": [good, {"id": "nope", "text": "x"}]}).encode("utf-8")
        p.write_bytes(raw)
        with self.assertRaises(inv.MemoryError_):
            inv.add(self.root, "Le Master aime le café noir.")
        self.assertEqual(p.read_bytes(), raw)
        self.assertEqual(inv.list_notes(self.root), [])

    def test_implicit_correction_never_guesses_its_target(self):
        """Two generic shared words must not overwrite an unrelated saved note."""
        import hq_inventoria_memory as inv
        target = inv.add(self.root, "Le Master range les bols dans le placard", now=1.0)
        other = inv.add(self.root, "Le Master range les vis dans l'atelier", now=2.0)
        out = inv.add(self.root, "En fait le Master range les bols dans le tiroir", now=3.0)
        rows = {r["id"]: r["text"] for r in inv.list_notes(self.root)}
        self.assertEqual(rows[target["id"]], "Le Master range les bols dans le placard")
        self.assertEqual(rows[other["id"]], "Le Master range les vis dans l'atelier")
        self.assertTrue(out.get("needs_target"))
        self.assertIn(target["id"], out["candidates"])

    def test_plain_non_asks_for_a_target_without_writing(self):
        import hq_inventoria_memory as inv
        first = inv.add(self.root, "Le Master range les bols dans le placard", now=1.0)
        asked = inv.add(self.root, "Non, le Master range les bols dans le tiroir", now=2.0)
        self.assertFalse(asked.get("saved"))
        self.assertTrue(asked.get("needs_target"))
        self.assertEqual([r["text"] for r in inv.list_notes(self.root)],
                         ["Le Master range les bols dans le placard"])
        fixed = inv.add(self.root, "Non, le Master range les bols dans le tiroir", now=3.0,
                        corrects_id=first["id"], expect="Le Master range les bols dans le placard")
        self.assertEqual(fixed.get("superseded"), first["id"])
        self.assertEqual([r["text"] for r in inv.list_notes(self.root)],
                         ["Non, le Master range les bols dans le tiroir"])

    def test_pending_correction_on_a_full_notepad_evicts_nothing(self):
        import hq_inventoria_memory as inv
        target = inv.add(self.root, "Le Master range les bols dans le placard", now=1.0)
        for index in range(inv.MAX_NOTES - 1):
            inv.add(self.root, f"note numero {index} sur les etageres", now=2.0 + index)
        before = [(r["id"], r["text"]) for r in inv.list_notes(self.root)]
        out = inv.add(self.root, "En fait le Master range les bols dans le tiroir", now=100.0)
        self.assertFalse(out.get("saved"))
        self.assertTrue(out.get("needs_target"))
        self.assertIn(target["id"], out["candidates"])
        self.assertEqual([(r["id"], r["text"]) for r in inv.list_notes(self.root)], before)

    def test_resolution_leaves_exactly_one_active_fact(self):
        import hq_inventoria_memory as inv
        first = inv.add(self.root, "Le Master range les bols dans le placard", now=1.0)
        inv.add(self.root, "En fait le Master range les bols dans le tiroir", now=2.0)
        inv.add(self.root, "En fait le Master range les bols dans le tiroir", now=3.0,
                corrects_id=first["id"], expect="Le Master range les bols dans le placard")
        notes = inv.list_notes(self.root)
        self.assertEqual(len(notes), 1)
        self.assertIn("tiroir", notes[0]["text"])

    def test_missing_expect_is_refused(self):
        import hq_inventoria_memory as inv
        first = inv.add(self.root, "Le Master range les bols dans le placard", now=1.0)
        before = [(r["id"], r["text"]) for r in inv.list_notes(self.root)]
        path = self.root / ".hq-inventoria" / "memory.json"
        raw = path.read_bytes()
        with self.assertRaises(inv.MemoryError_):
            inv.add(self.root, "Le Master range les bols dans le tiroir", now=2.0,
                    corrects_id=first["id"])
        self.assertEqual([(r["id"], r["text"]) for r in inv.list_notes(self.root)], before)
        self.assertEqual(path.read_bytes(), raw)

    def test_zero_overlap_correction_on_a_full_notepad_evicts_nothing(self):
        import hq_inventoria_memory as inv
        inv.add(self.root, "La boite est au garage", now=1.0)
        for index in range(inv.MAX_NOTES - 1):
            inv.add(self.root, f"note numero {index} sur les etageres", now=2.0 + index)
        before = [(r["id"], r["text"]) for r in inv.list_notes(self.root)]
        out = inv.add(self.root, "Non, maintenant au grenier", now=100.0)
        self.assertFalse(out.get("saved"))
        self.assertTrue(out.get("needs_target"))
        self.assertEqual(out.get("candidates"), [])
        self.assertEqual([(r["id"], r["text"]) for r in inv.list_notes(self.root)], before)

    def test_wrong_target_text_is_refused(self):
        import hq_inventoria_memory as inv
        first = inv.add(self.root, "Le Master range les bols dans le placard", now=1.0)
        with self.assertRaises(inv.MemoryError_):
            inv.add(self.root, "Le Master range les bols dans le tiroir", now=2.0,
                    corrects_id=first["id"], expect="Le Master range les vis au garage")
        self.assertEqual(len(inv.list_notes(self.root)), 1)

    def test_unknown_schema_version_is_preserved(self):
        import hq_inventoria_memory as inv
        p = self.root / inv.STATE_FOLDER / inv.FILE
        p.parent.mkdir(parents=True)
        raw = json.dumps({"version": 2, "notes": [
            {"id": "mem-aaaaaaaa", "text": "Le Master aime le thé vert.", "at": 1.0}]}).encode("utf-8")
        p.write_bytes(raw)
        with self.assertRaises(inv.MemoryError_):
            inv.add(self.root, "Le Master aime le café noir.")
        self.assertEqual(p.read_bytes(), raw)

    def test_numeric_string_timestamp_is_refused(self):
        import hq_inventoria_memory as inv
        p = self.root / inv.STATE_FOLDER / inv.FILE
        p.parent.mkdir(parents=True)
        raw = json.dumps({"version": 1, "notes": [
            {"id": "mem-aaaaaaaa", "text": "Le Master aime le thé vert.", "at": "1.0"}]}).encode("utf-8")
        p.write_bytes(raw)
        with self.assertRaises(inv.MemoryError_):
            inv.add(self.root, "Le Master aime le café noir.")
        self.assertEqual(p.read_bytes(), raw)

    def test_duplicate_ids_block_writes_and_preserve_the_file(self):
        import hq_inventoria_memory as inv
        p = self.root / inv.STATE_FOLDER / inv.FILE
        p.parent.mkdir(parents=True)
        row = {"id": "mem-aaaaaaaa", "text": "Le Master aime le thé vert.", "at": 1.0}
        raw = json.dumps({"version": 1, "notes": [row, dict(row)]}).encode("utf-8")
        p.write_bytes(raw)
        with self.assertRaises(inv.MemoryError_):
            inv.add(self.root, "Le Master aime le café noir.")
        self.assertEqual(p.read_bytes(), raw)

    def test_correction_is_not_evicted_before_older_notes(self):
        import hq_inventoria_memory as inv
        first = inv.add(self.root, "Le Master range les bols dans le placard", now=1.0)
        for index in range(inv.MAX_NOTES - 1):
            inv.add(self.root, f"note numero {index} sur les etageres", now=2.0 + index)
        inv.add(self.root, "Le Master range les bols dans le tiroir", now=100.0,
                corrects_id=first["id"], expect="Le Master range les bols dans le placard")
        out = inv.add(self.root, "Le Master aime le the vert", now=200.0)
        self.assertEqual(len(out["evicted"]), 1)
        self.assertNotIn(first["id"], out["evicted"])
        self.assertIn(first["id"], {r["id"] for r in inv.list_notes(self.root)})

    def test_corrected_note_ranks_as_recent(self):
        import hq_inventoria_memory as inv
        rows = [{"id": "mem-aaaaaaaa", "text": "Le Master aime les bols bleus", "at": 10.0},
                {"id": "mem-bbbbbbbb", "text": "Le Master aime les bols verts", "at": 50.0}]
        rows[0]["updated_at"] = 100.0
        self.assertEqual(inv._select(rows, "bols")[0]["id"], "mem-aaaaaaaa")

    def _alert_tick(self, payload: str):
        import hq_pistonia_store as pstore
        import hq_pistonia_alerts as palerts
        pstore.bind(self.root)
        folder = self.root / ".hq-engine" / "pistonia"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "alerts.json").write_text(payload, encoding="utf-8")
        palerts.reset_for_tests()
        palerts._since["ram"] = 0.0          # hold already elapsed: an alert is due
        return pstore, palerts

    def test_unreadable_alert_state_sends_nothing(self):
        pstore, palerts = self._alert_tick("{not json")
        with mock.patch.object(palerts, "detect", return_value={"ram": {"kind": "ram"}}), \
             mock.patch.object(palerts, "_compose", return_value="RAM high"), \
             mock.patch.object(pstore, "add_message") as add_message:
            self.assertEqual(palerts.tick({"daemons": []}, now=1000.0), [])
        add_message.assert_not_called()
        self.assertEqual(pstore.thread(), [])

    def test_schema_invalid_alert_state_sends_nothing(self):
        pstore, palerts = self._alert_tick("[]")
        with mock.patch.object(palerts, "detect", return_value={"ram": {"kind": "ram"}}), \
             mock.patch.object(palerts, "_compose", return_value="RAM high"), \
             mock.patch.object(pstore, "add_message") as add_message:
            self.assertEqual(palerts.tick({"daemons": []}, now=1000.0), [])
        add_message.assert_not_called()

    def test_damaged_alert_record_inside_valid_json_is_preserved(self):
        pstore, palerts = self._alert_tick(json.dumps({
            "alerts": [{"key": "ram"}, {"damaged": True}],
            "cooldown": {"ram": "invalid"}, "active": [123]}))
        path = self.root / ".hq-engine" / "pistonia" / "alerts.json"
        before = path.read_bytes()
        with mock.patch.object(palerts, "detect", return_value={"ram": {"kind": "ram"}}), \
             mock.patch.object(palerts, "_compose", return_value="RAM high"), \
             mock.patch.object(pstore, "add_message") as add_message:
            self.assertEqual(palerts.tick({"daemons": []}, now=1000.0), [])
        add_message.assert_not_called()
        self.assertEqual(path.read_bytes(), before)

    def test_failed_alert_state_save_rolls_the_thread_back(self):
        pstore, palerts = self._alert_tick('{"alerts": [], "cooldown": {}, "active": []}')
        for index in range(60):                      # a full thread: adding evicts the oldest
            pstore.add_message("user" if index % 2 else "assistant", f"message {index}", now=index)
        before = [(m["id"], m["text"]) for m in pstore.thread()]
        notified = []
        with mock.patch.object(palerts, "detect", return_value={"ram": {"kind": "ram"}}), \
             mock.patch.object(palerts, "_compose", return_value="RAM high"), \
             mock.patch.object(pstore, "save_alerts_state", side_effect=pstore.StoreError("io")):
            self.assertEqual(palerts.tick({"daemons": []}, now=1000.0,
                                          notify=lambda *a: notified.append(a)), [])
        self.assertEqual([(m["id"], m["text"]) for m in pstore.thread()], before)
        self.assertEqual(notified, [])

    def test_failed_clear_keeps_the_condition_active(self):
        import hq_pistonia_store as pstore
        import hq_pistonia_alerts as palerts
        pstore.bind(self.root)
        pstore.save_alerts_state({"alerts": [{"id": "msg-aaaaaaaaaa", "key": "ram", "kind": "alert",
                                              "text": "RAM high", "at": 1.0, "seen": True}],
                                  "cooldown": {}, "active": ["ram"]})
        palerts.reset_for_tests()
        with mock.patch.object(palerts, "detect", return_value={}), \
             mock.patch.object(pstore, "save_alerts_state", side_effect=pstore.StoreError("io")):
            self.assertEqual(palerts.tick({"daemons": []}, now=1000.0), [])
        self.assertEqual(pstore.alerts_state()["active"], ["ram"])
        self.assertEqual(pstore.thread(), [])

    def test_transferania_never_reads_else_traits(self):
        ai = self._ai()
        seen = lambda: {"humor": "ELSE ONLY"} if memory._memory_scope.get() == "else" else {}
        with mock.patch.object(memory, "personality_traits", side_effect=seen):
            with memory.memory_scope("else"):
                system = ai.build_transferania_system("chat", "warm", nsfw=False, view="accueil",
                                                      device_id="device-scope", prefs={}, signals={})
        self.assertNotIn("ELSE ONLY", system)

    def test_two_owners_cannot_see_each_other_evidence(self):
        memory.set_owner("owner-a")
        rel.note_exchange(self.root, "else", "transferania", "Salut", now=1_700_000_000)
        memory.set_owner("owner-b")
        self.assertEqual(rel.pair(self.root, "else", "transferania")["exchanges"], 0)
        memory.set_owner("owner-a")
        self.assertEqual(rel.pair(self.root, "else", "transferania")["exchanges"], 1)

    def test_sister_line_is_ignored_in_a_foreign_scope(self):
        memory.bind(root=self.root, now=lambda: 1_700_000_100.0)
        memory.set_owner("admin")
        with memory.memory_scope("musica"):
            memory.note_sister_line("else", "Salut Transferania.", "device-scope-01")
            # Assert inside the scope: outside it, snapshot() reads Transferania's store.
            self.assertEqual(memory.snapshot()["memories"], [])

    def test_culinia_malformed_preferences_are_preserved(self):
        import hq_culinia as culinia
        culinia.bind(root=self.root)
        path = self.root / ".hq-household" / "culinia_prefs.json"
        path.parent.mkdir(parents=True)
        raw = json.dumps({"likes": {"eggs": "yes"}}).encode("utf-8")
        path.write_bytes(raw)
        with self.assertRaises(culinia.CuliniaError):
            culinia._load_prefs()
        self.assertEqual(path.read_bytes(), raw)
        self.assertIn("illisibles", culinia._prefs_prompt_block())

    def test_forgia_malformed_preferences_are_preserved(self):
        import hq_forgia as forgia
        forgia.bind(root=self.root)
        path = self.root / ".hq-forge" / "forgia_prefs.json"
        path.parent.mkdir(parents=True)
        raw = json.dumps({"styles": {"anime": True}}).encode("utf-8")
        path.write_bytes(raw)
        with self.assertRaises(forgia.ForgiaError):
            forgia._load_prefs()
        self.assertEqual(path.read_bytes(), raw)
        self.assertIn("illisibles", forgia._prefs_prompt_block())

    def test_pistonia_duplicate_note_ids_are_refused(self):
        import hq_pistonia_store as pstore
        pstore.bind(self.root)
        folder = self.root / ".hq-engine" / "pistonia"
        folder.mkdir(parents=True)
        row = {"id": "mem-aaaaaaaa", "text": "Le Master aime le thé vert.", "at": 1.0}
        raw = json.dumps({"version": 1, "notes": [row, dict(row)]}).encode("utf-8")
        (folder / "memory.json").write_bytes(raw)
        with self.assertRaises(pstore.StoreError):
            pstore.forget("mem-aaaaaaaa")
        self.assertEqual((folder / "memory.json").read_bytes(), raw)

    def test_mark_seen_refuses_a_damaged_alert_store(self):
        import hq_pistonia_store as pstore
        pstore.bind(self.root)
        folder = self.root / ".hq-engine" / "pistonia"
        folder.mkdir(parents=True)
        raw = json.dumps({"version": 1, "alerts": [
            {"id": "msg-aaaaaaaaaa", "key": "ram", "kind": "alert", "text": "x", "at": 1.0, "seen": False},
            {"damaged": True}], "cooldown": {}, "active": []}).encode("utf-8")
        (folder / "alerts.json").write_bytes(raw)
        with self.assertRaises(pstore.StoreError):
            pstore.mark_seen()
        self.assertEqual((folder / "alerts.json").read_bytes(), raw)

    def test_add_message_refuses_a_partly_damaged_thread(self):
        import hq_pistonia_store as pstore
        pstore.bind(self.root)
        folder = self.root / ".hq-engine" / "pistonia"
        folder.mkdir(parents=True)
        raw = json.dumps({"version": 1, "messages": [
            {"id": "msg-aaaaaaaaaa", "role": "user", "text": "bonjour", "at": 1.0},
            {"id": "bad", "role": "user", "text": "x", "at": 2.0}]}).encode("utf-8")
        (folder / "thread.json").write_bytes(raw)
        with self.assertRaises(pstore.StoreError):
            pstore.add_message("assistant", "salut", now=3.0)
        self.assertEqual((folder / "thread.json").read_bytes(), raw)

    def test_thread_transaction_blocks_a_chat_writer(self):
        """The alert snapshot/commit/rollback window excludes chat writes, so a
        rollback cannot erase a message that arrived in between."""
        import hq_pistonia_store as pstore
        pstore.bind(self.root)
        done = threading.Event()

        def chat():
            pstore.add_message("user", "message du Maître", now=1.0)
            done.set()

        with pstore.thread_transaction():
            threading.Thread(target=chat, daemon=True).start()
            time.sleep(0.1)
            self.assertFalse(done.is_set(), "a chat writer entered the alert transaction")
        self.assertTrue(done.wait(2.0))
        self.assertIn("message du Maître", [m["text"] for m in pstore.thread()])

    def test_mark_seen_survives_a_concurrent_all_clear(self):
        import contextlib
        pstore, palerts = self._alert_tick(json.dumps({
            "version": 1,
            "alerts": [{"id": "msg-aaaaaaaaaa", "key": "disk", "kind": "alert", "text": "Disk",
                        "at": 10.0, "seen": False, "label": "the disk"}],
            "cooldown": {"disk": 1.0}, "active": ["disk"]}))
        real_tx = pstore.thread_transaction

        @contextlib.contextmanager
        def ack_then_transaction():
            pstore.mark_seen()          # acknowledged after the tick read its state
            with real_tx():
                yield

        with mock.patch.object(palerts, "detect", return_value={}), \
             mock.patch.object(pstore, "thread_transaction", ack_then_transaction):
            palerts.tick({"daemons": []}, now=10000.0)
        rows = pstore.alerts_state()["alerts"]
        disk = next(a for a in rows if a.get("key") == "disk" and a.get("kind") == "alert")
        self.assertTrue(disk["seen"], "the all-clear un-acknowledged the alert")
        self.assertTrue(any(a.get("kind") == "clear" and a.get("key") == "disk" for a in rows))

    def test_settings_keep_unknown_fields(self):
        import hq_pistonia_store as pstore
        pstore.bind(self.root)
        folder = self.root / ".hq-engine" / "pistonia"
        folder.mkdir(parents=True)
        (folder / "settings.json").write_text(json.dumps({"notify": True, "future": {"x": 1}}), encoding="utf-8")
        pstore.save_settings(voice=False)
        saved = json.loads((folder / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["future"], {"x": 1})
        self.assertTrue(saved["notify"])
        self.assertFalse(saved["voice"])

    def test_slow_reply_appends_after_a_newer_turn(self):
        import hq_culinia as culinia
        import hq_forgia as forgia
        for module, folder, name in ((culinia, ".hq-household", "culinia_thread.json"),
                                     (forgia, ".hq-forge", "forgia_thread.json")):
            module.bind(root=self.root)
            path = self.root / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"messages": [{"role": "user", "text": "ancien", "ts": 1.0}]}),
                            encoding="utf-8")
            base = 1
            # another tab finishes a turn while this one is still generating
            module._append_turn([{"role": "user", "text": "autre", "ts": 2.0},
                                 {"role": "assistant", "text": "ok", "ts": 2.0}], base)
            rebased = module._append_turn([{"role": "user", "text": "lent", "ts": 3.0},
                                           {"role": "assistant", "text": "réponse", "ts": 3.0}], base)
            self.assertTrue(rebased)
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual([m["text"] for m in saved["messages"]],
                             ["ancien", "autre", "ok", "lent", "réponse"])

    def test_reply_answers_turns_that_land_during_generation(self):
        import hq_ai as ai
        import hq_culinia as culinia
        import hq_forgia as forgia
        for module, folder, name in ((culinia, ".hq-household", "culinia_thread.json"),
                                     (forgia, ".hq-forge", "forgia_thread.json")):
            module.bind(root=self.root)
            path = self.root / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"messages": [{"role": "user", "text": "ancien", "ts": 1.0}]}),
                            encoding="utf-8")
            calls = []

            def fake_generate(chain, contents, system_instruction="", _m=module, _calls=calls, **kw):
                _calls.append(contents)
                if len(_calls) == 1:
                    # a second tab completes a turn while this reply is generating
                    _m._append_turn([{"role": "user", "text": "autre", "ts": 2.0},
                                     {"role": "assistant", "text": "ok", "ts": 2.0}], 1)
                    return json.dumps({"reply": "première", "tools": []}), "m"
                return json.dumps({"reply": "seconde", "tools": []}), "m"

            with mock.patch.object(ai, "generate", side_effect=fake_generate):
                out = module.chat("lent")
            self.assertEqual(out["reply"], "seconde")
            self.assertFalse(out["fallback_append"])
            self.assertEqual(out["reconciled"], 1)
            self.assertEqual(len(calls), 2)
            self.assertIn("autre", json.dumps(calls[1], ensure_ascii=False))
            texts = [m["text"] for m in module.get_thread()["messages"]]
            self.assertEqual(texts, ["ancien", "autre", "ok", "lent", "seconde"])

    def test_turn_landing_between_check_and_append_is_answered(self):
        import hq_ai as ai
        import hq_culinia as culinia
        import hq_forgia as forgia
        for module, folder, name in ((culinia, ".hq-household", "culinia_thread.json"),
                                     (forgia, ".hq-forge", "forgia_thread.json")):
            module.bind(root=self.root)
            path = self.root / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"messages": [{"role": "user", "text": "ancien", "ts": 1.0}]}),
                            encoding="utf-8")
            calls = []
            raced = {"done": False}
            real_append = module._append_turn_if_current

            def racing_append(turn, base, _m=module, _real=real_append, _raced=raced):
                if not _raced["done"]:
                    _raced["done"] = True
                    # lands after the chat read the thread, before its atomic append
                    _m._append_turn([{"role": "user", "text": "tardif", "ts": 4.0},
                                     {"role": "assistant", "text": "ok2", "ts": 4.0}], base)
                return _real(turn, base)

            def fake_generate(chain, contents, system_instruction="", _calls=calls, **kw):
                _calls.append(contents)
                answer = "seconde" if len(_calls) > 1 else "première"
                return json.dumps({"reply": answer, "tools": []}), "m"

            with mock.patch.object(ai, "generate", side_effect=fake_generate), \
                 mock.patch.object(module, "_append_turn_if_current", racing_append):
                out = module.chat("lent")
            self.assertEqual(out["reply"], "seconde")
            self.assertFalse(out["fallback_append"])
            self.assertEqual(len(calls), 2)
            self.assertIn("tardif", json.dumps(calls[1], ensure_ascii=False))
            texts = [m["text"] for m in module.get_thread()["messages"]]
            self.assertEqual(texts, ["ancien", "tardif", "ok2", "lent", "seconde"])

    def test_fallback_append_is_reported_when_every_attempt_races(self):
        import os
        import hq_ai as ai
        import hq_culinia as culinia
        import hq_forgia as forgia
        for module, folder, name in ((culinia, ".hq-household", "culinia_thread.json"),
                                     (forgia, ".hq-forge", "forgia_thread.json")):
            module.bind(root=self.root)
            path = self.root / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"messages": [{"role": "user", "text": "ancien", "ts": 1.0}]}),
                            encoding="utf-8")
            calls = []
            counter = {"n": 0}

            def always_raced(turn, base, _m=module, _c=counter):
                _c["n"] += 1
                _m._append_turn([{"role": "user", "text": f"tardif{_c['n']}", "ts": 4.0 + _c["n"]},
                                 {"role": "assistant", "text": "ok", "ts": 4.0 + _c["n"]}], base)
                return False

            def fake_generate(chain, contents, system_instruction="", _calls=calls, **kw):
                _calls.append(contents)
                return json.dumps({"reply": f"r{len(_calls)}", "tools": []}), "m"

            with mock.patch.dict(os.environ, {"HQ_CHAT_REPLY_ATTEMPTS": "2"}), \
                 mock.patch.object(ai, "generate", side_effect=fake_generate), \
                 mock.patch.object(module, "_append_turn_if_current", always_raced):
                out = module.chat("lent")
            self.assertTrue(out["fallback_append"])
            self.assertEqual(len(calls), 2)          # initial reply + one regeneration
            texts = [m["text"] for m in module.get_thread()["messages"]]
            self.assertEqual(texts[-2:], ["lent", "r2"])
            self.assertEqual(texts.count("lent"), 1)
            self.assertIn("tardif2", texts)

    def test_thread_without_messages_key_is_refused(self):
        import hq_culinia as culinia
        import hq_forgia as forgia
        culinia.bind(root=self.root)
        forgia.bind(root=self.root)
        for module, folder, name in ((culinia, ".hq-household", "culinia_thread.json"),
                                     (forgia, ".hq-forge", "forgia_thread.json")):
            path = self.root / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}", encoding="utf-8")
            with self.assertRaises(module.CuliniaError if module is culinia else module.ForgiaError):
                module._save_thread([{"role": "assistant", "text": "bonjour"}])
            self.assertEqual(path.read_text(encoding="utf-8"), "{}")

    def test_duplicate_message_ids_are_refused(self):
        import hq_pistonia_store as pstore
        pstore.bind(self.root)
        folder = self.root / ".hq-engine" / "pistonia"
        folder.mkdir(parents=True)
        row = {"id": "msg-bbbbbbbbbb", "role": "user", "text": "bonjour", "at": 1.0}
        raw = json.dumps({"version": 1, "messages": [row, dict(row)]}).encode("utf-8")
        (folder / "thread.json").write_bytes(raw)
        with self.assertRaises(pstore.StoreError):
            pstore.add_message("assistant", "salut", now=2.0)
        self.assertEqual((folder / "thread.json").read_bytes(), raw)

    def test_clear_thread_refuses_a_damaged_thread(self):
        import hq_pistonia_store as pstore
        pstore.bind(self.root)
        folder = self.root / ".hq-engine" / "pistonia"
        folder.mkdir(parents=True)
        raw = json.dumps({"version": 1, "messages": [{"role": "user"}]}).encode("utf-8")
        (folder / "thread.json").write_bytes(raw)
        with self.assertRaises(pstore.StoreError):
            pstore.clear_thread()
        self.assertEqual((folder / "thread.json").read_bytes(), raw)

    def test_settings_writer_refuses_a_malformed_preference(self):
        import hq_pistonia_store as pstore
        pstore.bind(self.root)
        folder = self.root / ".hq-engine" / "pistonia"
        folder.mkdir(parents=True)
        raw = json.dumps({"notify": {"unexpected": True}, "voice": True}).encode("utf-8")
        (folder / "settings.json").write_bytes(raw)
        with self.assertRaises(pstore.StoreError):
            pstore.save_settings(notify=False)
        self.assertEqual((folder / "settings.json").read_bytes(), raw)

    def test_unknown_alert_version_is_refused(self):
        pstore, palerts = self._alert_tick(json.dumps({"version": 2, "alerts": [], "cooldown": {}, "active": []}))
        path = self.root / ".hq-engine" / "pistonia" / "alerts.json"
        raw = path.read_bytes()
        with mock.patch.object(palerts, "detect", return_value={"ram": {"kind": "ram"}}), \
             mock.patch.object(palerts, "_compose", return_value="RAM high"):
            self.assertEqual(palerts.tick({"daemons": []}, now=1000.0), [])
        with self.assertRaises(pstore.StoreError):
            pstore.mark_seen()
        self.assertEqual(path.read_bytes(), raw)

    def test_mark_seen_survives_a_concurrent_alert_tick(self):
        import contextlib
        pstore, palerts = self._alert_tick(json.dumps({
            "version": 1,
            "alerts": [{"id": "msg-aaaaaaaaaa", "key": "disk", "kind": "alert", "text": "Disk",
                        "at": 10.0, "seen": False, "label": "the disk"}],
            "cooldown": {"disk": 1.0}, "active": ["disk"]}))
        real_tx = pstore.thread_transaction

        @contextlib.contextmanager
        def ack_then_transaction():
            pstore.mark_seen()          # acknowledged after the tick read its state, before it writes
            with real_tx():
                yield

        with mock.patch.object(palerts, "detect", return_value={"ram": {"kind": "ram", "pct": 91}}), \
             mock.patch.object(palerts, "_compose", return_value="RAM high"), \
             mock.patch.object(pstore, "thread_transaction", ack_then_transaction):
            palerts.tick({"daemons": []}, now=10000.0)   # past the default RAM cooldown
        rows = pstore.alerts_state()["alerts"]
        disk = next(a for a in rows if a.get("key") == "disk")
        self.assertTrue(disk["seen"], "the tick's stale copy un-acknowledged the alert")
        self.assertTrue(any(a.get("key") == "ram" for a in rows))

    def test_culinia_refuses_to_rewrite_a_damaged_thread(self):
        import hq_culinia as culinia
        culinia.bind(root=self.root)
        path = self.root / ".hq-household" / "culinia_thread.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps({"messages": [{"role": "user"}]}).encode("utf-8")
        path.write_bytes(raw)
        with self.assertRaises(culinia.CuliniaError):
            culinia._save_thread([{"role": "assistant", "text": "bonjour"}])
        with self.assertRaises(culinia.CuliniaError):
            culinia.clear_thread()
        self.assertEqual(path.read_bytes(), raw)

    def test_culinia_refuses_to_rewrite_a_malformed_meal_plan(self):
        import hq_culinia as culinia
        culinia.bind(root=self.root)
        path = self.root / ".hq-household" / "culinia_meals.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps({"days": [["monday", "soup"]], "note": "", "updated_at": ""}).encode("utf-8")
        path.write_bytes(raw)
        out = culinia._execute_tool("save_meal_plan", {"days": {"tuesday": "rice"}, "note": "x"})
        self.assertFalse(out.get("ok"))
        self.assertEqual(path.read_bytes(), raw)

    def test_forgia_refuses_to_rewrite_a_damaged_thread(self):
        import hq_forgia as forgia
        forgia.bind(root=self.root)
        path = self.root / ".hq-forge" / "forgia_thread.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps({"messages": "not a list"}).encode("utf-8")
        path.write_bytes(raw)
        with self.assertRaises(forgia.ForgiaError):
            forgia._save_thread([{"role": "assistant", "text": "bonjour"}])
        with self.assertRaises(forgia.ForgiaError):
            forgia.clear_thread()
        self.assertEqual(path.read_bytes(), raw)

    def test_relationship_owner_never_defaults_to_admin(self):
        with mock.patch.object(memory, "current_owner", return_value=None):
            with self.assertRaises(RuntimeError):
                rel.pair(self.root, "else", "transferania")

    def test_else_pastime_appears_once_and_a_custom_value_replaces_it(self):
        ai = self._ai()
        pastime = hq_personas.get("else")["pastimes"]
        system = ai.build_else_system("chat", "warm", nsfw=False, view="accueil",
                                      device_id="device-else-pastimes", prefs={})
        self.assertEqual(system.count(pastime), 1)
        with mock.patch.object(memory, "personality_traits",
                               return_value={"pastimes": "Collectionner des engrenages."}):
            custom = ai.build_else_system("chat", "warm", nsfw=False, view="accueil",
                                          device_id="device-else-pastimes", prefs={})
        self.assertIn("Collectionner des engrenages.", custom)
        self.assertNotIn(pastime, custom)


if __name__ == "__main__":
    unittest.main()
