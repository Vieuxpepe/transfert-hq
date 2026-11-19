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

import hq_assistant_voice as assistant_voice
import hq_companion_memory as memory
import hq_personhood
import hq_personas
import hq_relationships as rel
from tests import hq_assistant_state

_GLOBAL_STATE: tuple | None = None
_AUX_STATE: tuple | None = None


def setUpModule():
    """These tests bind the shared store; later modules must get theirs back."""
    global _GLOBAL_STATE, _AUX_STATE
    hq_assistant_state.set_up()
    import hq_ai as ai
    import hq_life as life
    import hq_state
    _GLOBAL_STATE = (memory._root, memory._now, memory._owner.get(),
                     memory._owner_established.get(), memory._memory_scope.get())
    _AUX_STATE = (dict(ai._cb), dict(life._cb), hq_state._STATE_ROOT.get())
    for name in ("hq_forgia", "hq_culinia", "hq_securia", "hq_musica", "hq_pistonia", "hq_inventoria_ai", "hq_elsea"):
        module = __import__(name)
        if hasattr(module, "_bound_root"):
            _AUX_STATE += ((name, module._bound_root),)


def tearDownModule():
    if _GLOBAL_STATE is None:
        return
    root, now, owner, established, scope = _GLOBAL_STATE
    memory.bind(root=root, now=now)
    memory._owner.set(owner)
    memory._owner_established.set(established)
    memory._memory_scope.set(scope)
    if _AUX_STATE is not None:
        import hq_ai as ai
        import hq_life as life
        import hq_state
        ai_cb, life_cb, state_root = _AUX_STATE[:3]
        ai._cb.clear()
        ai._cb.update(ai_cb)
        life._cb.clear()
        life._cb.update(life_cb)
        hq_state.bind_root(state_root)
        for name, bound in (entry for entry in _AUX_STATE[3:]):
            setattr(__import__(name), "_bound_root", bound)

PERSONAS = {
    "musica": ("hq_musica", "PERSONA_CORE", "en"),
    "inventoria": ("hq_inventoria_ai", "PERSONA", "en"),
    "pistonia": ("hq_pistonia", "PERSONA", "en"),
    "culinia": ("hq_culinia", "PERSONA_CORE", "fr"),
    "forgia": ("hq_forgia", "PERSONA_CORE", "fr"),
    "securia": ("hq_securia", "PERSONA_CORE", "fr"),
    "elsea": ("hq_elsea", "PERSONA_CORE", "en"),
}

TOOL_MODULES = (("hq_musica", "TOOL_SCHEMA"), ("hq_culinia", "TOOL_SCHEMA"),
                ("hq_forgia", "TOOL_SCHEMA"), ("hq_securia", "TOOL_SCHEMA"),
                ("hq_pistonia", "TOOLS_DOC"), ("hq_elsea", "TOOL_SCHEMA"))


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


class AssistantVoiceTests(unittest.TestCase):
    """Distinctness, an evidence-only bond, and pair familiarity in one block."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-voice-")

    def tearDown(self):
        self.tmp.cleanup()

    def test_every_assistant_has_a_distinct_voice_card(self):
        caps, forms, bans = [], [], []
        for key in hq_personas.keys():
            voice = hq_personas.get(key)["voice"]
            card = hq_personas.voice_line(key)
            self.assertTrue(card, key)
            self.assertIn(str(voice["cap"]), card, key)
            self.assertGreaterEqual(voice["cap"], 8, key)
            self.assertLessEqual(voice["cap"], 60, key)
            self.assertGreaterEqual(len(voice["never"]), 2, key)
            # The card is what a reply can be held to; the likeness line keeps
            # the alias, the quirks and the speech habit, so it must not repeat.
            self.assertNotIn(hq_personas.get(key)["tell"], card, key)
            caps.append(voice["cap"])
            forms.append(voice["syntax"])
            bans.append(tuple(voice["never"]))
        self.assertEqual(len(set(caps)), len(caps), "two assistants share a prose cap")
        self.assertEqual(len(set(forms)), len(forms), "two assistants share a form rule")
        self.assertEqual(len(set(bans)), len(bans), "two assistants share a banned list")

    def test_bond_needs_real_days_and_counts_them(self):
        import hq_culinia as culinia
        import hq_personhood as personhood
        culinia.bind(root=Path(self.tmp.name))
        now = 1_700_000_000
        self.assertEqual(personhood.bond("culinia", now=now)["days"], 0)
        for offset in (0, 86400, 3 * 86400):
            personhood.observe_chat("culinia", "On prepare une soupe de courge.", now=now + offset)
        row = personhood.bond("culinia", now=now + 3 * 86400 + 60)
        self.assertEqual(row["days"], 3)
        line = hq_personas.closeness_line("culinia", row["days"])
        self.assertIn("3", line)
        self.assertIn("LIEN", line)
        self.assertEqual(hq_personas.closeness_line("culinia", 1), "")

    def test_each_assistant_names_her_own_link_with_the_master_from_day_zero(self):
        """The Master bond exists per assistant before any day, and moves with real days.

        ``closeness_line`` keeps its own rule (no closeness sentence under two
        distinct days); what changes is that the link is no longer silent and no
        longer identical across assistants: each one names it in her own words,
        and the stage name advances only with days really spent with him.
        """
        import hq_personas as personas
        keys = [a["key"] for a in personas.ASSISTANTS]
        early = {key: personas.bond_line(key, 0) for key in keys}
        for key, line in early.items():
            self.assertTrue(line, key)
            self.assertIn("LIEN" if not personas.get(key)["lang"].startswith("en") else "BOND", line)
            # No count is claimed before two distinct days.
            self.assertNotIn("0", line)
            self.assertNotIn("1", line)
        self.assertEqual(len(set(early.values())), len(keys), "two assistants share the same opening line")
        self.assertEqual(personas.bond_stage(0), "rencontre")
        self.assertEqual(personas.bond_stage(1), "premier_jour")
        self.assertEqual(personas.bond_stage(4), "habitude")
        self.assertEqual(personas.bond_stage(9), "complicite")
        # The first real day changes the stage while keeping her own wording.
        self.assertNotEqual(personas.bond_stage(0), personas.bond_stage(1))
        self.assertEqual(personas.bond_line("culinia", 1), personas.bond_line("culinia", 0))
        # From two days the old count-bearing sentence takes over.
        self.assertEqual(personas.bond_line("culinia", 3), personas.closeness_line("culinia", 3))
        self.assertIn("3", personas.bond_line("culinia", 3))

    def test_master_bond_view_names_her_stage_before_and_after_a_real_turn(self):
        """The link exists per assistant at zero days, and one real turn moves it."""
        import time
        import hq_culinia as culinia
        import hq_personhood as personhood
        culinia.bind(root=Path(self.tmp.name))
        now = time.time()
        before = personhood.snapshot("culinia", now=now, owner="admin")["bond"]
        self.assertEqual(before["days"], 0)
        self.assertEqual(before["stage"], "rencontre")
        self.assertEqual(before["line"], "")                       # no closeness claimed
        self.assertTrue(before["stage_line"].startswith("LIEN AU MAÎTRE"))
        personhood.observe_chat("culinia", "On prepare une soupe de courge.", now=now + 60, owner="admin")
        after = personhood.snapshot("culinia", now=now + 120, owner="admin")["bond"]
        self.assertEqual((after["days"], after["turns"]), (1, 1))
        self.assertEqual(after["stage"], "premier_jour")
        self.assertNotEqual(after["stage"], before["stage"])
        self.assertEqual(after["line"], "")                        # still no closeness at one day

    def test_each_pair_names_its_own_link_and_claims_nothing_at_zero(self):
        """Fifteen untouched pairs must not collapse into one shared sentence.

        ``line`` keeps its rule (a count-bearing familiarity note from two days, so
        it stays empty before that); ``stage_line`` is the pair's own wording at
        every rung, built from what the two assistants tend and from the days and
        exchanges they really shared — never from another pair's text.
        """
        import itertools
        import hq_personas as personas
        import hq_relationships as rel
        keys = ["culinia", "forgia", "musica", "inventoria", "pistonia", "securia"]
        pairs = list(itertools.combinations(keys, 2))
        self.assertEqual(len(pairs), 15)
        lines = {pair: rel.stage_line(Path(self.tmp.name), pair[0], pair[1], lang="fr", owner="admin") for pair in pairs}
        self.assertEqual(len(set(lines.values())), 15, "two untouched pairs share a sentence")
        for pair, text in lines.items():
            self.assertTrue(text, pair)
            self.assertIn(personas.get(pair[1])["name"], text)
            self.assertEqual(rel.pair_stage(0), "rencontre")
            # Nothing is claimed: no day count, and the closeness sentence stays away.
            self.assertNotIn("jour(s)", text)
            self.assertEqual(rel.line(Path(self.tmp.name), pair[0], pair[1], owner="admin"), "")
            self.assertIn(personas.get(pair[0])["domain"]["fr"], text)
        # One day in: still no closeness, and still one sentence per pair even when
        # two pairs share a name and an exchange count (the live panel showed that
        # collapse once, which is why the early wording names both domains).
        when = 1_700_000_000
        for index, pair in enumerate(pairs):
            rel.note_exchange(Path(self.tmp.name), pair[0], pair[1], "Une visite réelle.",
                              now=when + index, owner="admin")
        one_day = {pair: rel.stage_line(Path(self.tmp.name), pair[0], pair[1], lang="fr", owner="admin")
                   for pair in pairs}
        self.assertEqual(len(set(one_day.values())), 15, "two pairs share their first-day sentence")
        for pair, text in one_day.items():
            self.assertIn("Un seul jour partagé", text)
            self.assertIn("1 échange(s)", text)
            self.assertEqual(rel.line(Path(self.tmp.name), pair[0], pair[1], owner="admin"), "")
        # The viewer's own language decides the wording.
        english = rel.stage_line(Path(self.tmp.name), "musica", "inventoria", lang="en", owner="admin")
        self.assertTrue(english.startswith("One day shared with Inventoria"), english)
        self.assertIn(personas.get("inventoria")["domain"]["en"], english)

    def test_folding_real_visits_adds_days_without_touching_family_pacing(self):
        """Backfilling logged visits moves counts only, never ``family_at``."""
        import hq_relationships as rel
        root = Path(self.tmp.name)
        start = 1_700_000_000
        rel.note_exchange(root, "culinia", "forgia", "Le pain du four a tenu la promesse.",
                          kind="famille", now=start, owner="admin")
        family_at = next(row for row in rel.pairs(root, owner="admin")
                         if {row["a"], row["b"]} == {"culinia", "forgia"})["family_at"]
        self.assertEqual(family_at, start)
        # Two copies of the same visit, plus one on each of two later days.
        moments = [start + 86400, start + 86400, start + 2 * 86400]
        changed = rel.fold_visits(root, {("culinia", "forgia"): moments,
                                          ("forgia", "culinia"): moments}, owner="admin")
        self.assertEqual(len(changed), 1, "the pair is folded once, not once per direction")
        row = next(r for r in rel.pairs(root, owner="admin")
                   if {r["a"], r["b"]} == {"culinia", "forgia"})
        self.assertEqual(row["days"], 3)
        # The two copies of one visit share a moment: they count once.
        self.assertEqual(row["exchanges"], 2)
        self.assertEqual(row["family_at"], family_at, "the house's pacing day moved")
        self.assertEqual(rel.fold_visits(root, {("culinia", "forgia"): moments}, owner="admin"), [],
                         "a second fold must change nothing")

    def test_pairs_at_the_same_rung_never_share_a_sentence(self):
        """Three pairs, one assistant, one day count: the domains tell them apart."""
        import hq_relationships as rel
        root = Path(self.tmp.name)
        now = 1_700_000_000
        trio = [("culinia", "musica"), ("forgia", "musica"), ("musica", "securia")]
        for a, b in trio:
            for day in (0, 86400):
                rel.note_exchange(root, a, b, "Le four et l'écoute ont tenu parole.",
                                  kind="famille", now=now + day, owner="admin")
        lines = [rel.stage_line(root, a, b, lang="fr", owner="admin") for a, b in trio]
        self.assertEqual(len(set(lines)), 3, lines)
        for text in lines:
            self.assertIn("2 jours distincts", text)
            self.assertIn("connaissance", text)

    def test_every_assistant_keeps_a_distinct_hidden_heart(self):
        """A core undercurrent for all of them, and no two hiding it the same way."""
        hiddens, wants, tells = {}, {}, {}
        for key in hq_personas.on_hq_keys():
            heart = hq_personas.get(key)["heart"]
            for field in ("hidden", "want", "tell", "never"):
                self.assertTrue(str(heart.get(field) or "").strip(), f"{key} has no heart.{field}")
            hiddens[key], wants[key], tells[key] = heart["hidden"], heart["want"], heart["tell"]
            # The wish is roster data only: no panel line and no prompt carries it.
            self.assertNotIn(heart["want"], hq_personas.heart_line(key, 0))
            self.assertNotIn(heart["want"], hq_personas.heart_line(key, 12, 200))
            self.assertNotIn(heart["want"], hq_personas.heart_prompt(key, 3))
            self.assertIn(heart["colour"], hq_personas.heart_prompt(key, 3))
        self.assertEqual(len(set(hiddens.values())), len(hiddens), "two assistants hide the same thing")
        self.assertEqual(len(set(wants.values())), len(wants), "two assistants want the same thing")
        self.assertEqual(len(set(tells.values())), len(tells), "two assistants give themselves away alike")

    def test_the_hidden_heart_colours_the_reply_without_naming_it(self):
        """Audible in a reply, never a declaration: distinct and staged per woman."""
        declarations = ("je t'aime", "amour", "i love you", "in love", "love you")
        colours, early, late = {}, {}, {}
        for key in hq_personas.on_hq_keys():
            heart = hq_personas.get(key)["heart"]
            one = hq_personas.heart_prompt(key, 1)
            self.assertTrue(one, key)
            self.assertIn(heart["colour"], one, key)
            # The cue is the rung's own, in her language.
            cues = (hq_personas.HEART_COLOUR_CUES_EN
                    if str(hq_personas.get(key)["lang"]).lower().startswith("en")
                    else hq_personas.HEART_COLOUR_CUES)
            self.assertIn(cues["lueur"], one, key)
            # Hidden: no declaration, no wish, and an explicit ban on naming it.
            for marker in declarations:
                self.assertNotIn(marker, one.lower(), key)
            self.assertNotIn(heart["want"], one, key)
            self.assertNotIn(heart["hidden"], one, key)
            self.assertIn("jamais" if "CŒUR" in one else "never", one, key)
            # The tight sister-chat core keeps the same ear in one clause.
            brief = heart["colour_brief"]
            self.assertTrue(brief, key)
            self.assertLessEqual(len(brief), 60, key)
            small = hq_personas.heart_prompt(key, 1, compact=True)
            self.assertIn(brief, small, key)
            self.assertIn(brief, hq_personas.heart_prompt(key, 10, compact=True), key)
            self.assertNotIn(heart["want"], small, key)
            colours[key], early[key] = one, hq_personas.heart_prompt(key, 5)
            late[key] = hq_personas.heart_prompt(key, 12)
            self.assertEqual(len({one, early[key], late[key]}), 3, f"{key}'s colour does not evolve")
        self.assertEqual(len(set(colours.values())), len(colours), "two assistants colour the same way")
        self.assertEqual(len(set(early.values())), len(early))
        self.assertEqual(len(set(late.values())), len(late))
        # A fresh prompt carries none of it; the reply block is where it lands,
        # and only once the same store that feeds her bond has a real day.
        for key in hq_personas.on_hq_keys():
            self.assertEqual(hq_personas.heart_prompt(key, 0), "")
            days = int(hq_personhood.bond(key, owner="admin").get("days") or 0)
            self.assertEqual(bool(assistant_voice.heart_line(key)), days >= 1, key)
            compact = assistant_voice.block(key, compact=True)
            if days < 1:
                self.assertNotIn("CŒUR —", compact, key)
            else:
                self.assertIn(hq_personas.get(key)["heart"]["colour_brief"], compact, key)
                self.assertLessEqual(len(compact.encode("utf-8")), assistant_voice.BLOCK_MAX_BYTES)

    def test_the_hidden_heart_evolves_on_real_days_only(self):
        self.assertEqual(hq_personas.heart_stage(0), "braise")
        self.assertEqual(hq_personas.heart_stage(1), "lueur")
        self.assertEqual(hq_personas.heart_stage(4), "lueur")
        self.assertEqual(hq_personas.heart_stage(5), "elan")
        self.assertEqual(hq_personas.heart_stage(10), "attachement")
        cold = hq_personas.heart_line("culinia", 0)
        warm = hq_personas.heart_line("culinia", 6)
        self.assertIn("braise", cold)
        self.assertIn("élan", warm)
        self.assertNotEqual(cold, warm)
        self.assertNotIn("attachement", cold)      # nothing is claimed as lived yet
        self.assertNotIn("Ce qui la trahit", cold)  # a tell is earned, not assumed
        self.assertIn("Ce qui la trahit", warm)
        # Never spoken: no prompt line before a real day, and it forbids the rest.
        self.assertEqual(hq_personas.heart_prompt("culinia", 0), "")
        spoken = hq_personas.heart_prompt("culinia", 1)
        self.assertIn("jamais", spoken)
        self.assertNotIn(hq_personas.get("culinia")["heart"]["want"], spoken)

    def test_the_heart_is_panel_evidence_and_never_a_prompt_claim(self):
        snapshot = hq_personhood.snapshot("inventoria", owner="admin")
        heart, bond = snapshot["heart"], snapshot["bond"]
        self.assertTrue(heart["hidden"])
        self.assertEqual(heart["days"], bond["days"], "the heart must follow the same evidence as the bond")
        self.assertEqual(heart["turns"], bond["turns"])
        self.assertEqual(heart["stage"], hq_personas.heart_stage(bond["days"]))
        self.assertTrue(heart["line"])
        self.assertEqual(bool(assistant_voice.heart_line("inventoria")), bond["days"] >= 1,
                         "the prompt constraint must appear only once a real day exists")

    def test_the_pair_echo_needs_both_hearts_and_real_evidence(self):
        """A shared secret is only shown where both women and the pair earned it."""
        echo = hq_personas.echo_line("culinia", "pistonia", days=1, exchanges=1,
                                     a_heart_days=1, b_heart_days=1, lang="fr")
        self.assertTrue(echo)
        self.assertIn("Écho non dit", echo)
        for who in ("culinia", "pistonia"):
            heart = hq_personas.get(who)["heart"]
            self.assertNotIn(heart["want"], echo, f"{who}'s wish leaked into the echo")
            self.assertNotIn(heart["hidden"], echo)
        # One unlit heart is enough to keep the echo away, whichever side it is.
        self.assertEqual(hq_personas.echo_line("culinia", "pistonia", days=1, exchanges=1,
                                               a_heart_days=1, b_heart_days=0, lang="fr"), "")
        self.assertEqual(hq_personas.echo_line("culinia", "pistonia", days=1, exchanges=1,
                                               a_heart_days=0, b_heart_days=4, lang="fr"), "")
        # Two lit hearts with nothing passed between them: still nothing.
        self.assertEqual(hq_personas.echo_line("culinia", "pistonia", days=0, exchanges=0,
                                               a_heart_days=3, b_heart_days=3, lang="fr"), "")

    def test_each_pair_echo_reads_differently_and_evolves_with_its_evidence(self):
        keys = list(hq_personas.on_hq_keys())
        texts = {}
        for index, a in enumerate(keys):
            for b in keys[index + 1:]:
                text = hq_personas.echo_line(a, b, days=2, exchanges=12,
                                             a_heart_days=2, b_heart_days=2, lang="fr")
                self.assertTrue(text, f"{a}|{b} has no echo on real evidence")
                texts[(a, b)] = text
                for who in (a, b):
                    self.assertNotIn(hq_personas.get(who)["heart"]["want"], text)
                for who in keys:
                    if who in (a, b):
                        continue
                    self.assertNotIn(hq_personas.get(who)["heart"]["echo"], text,
                                     f"{who}'s stance surfaced on {a}|{b}")
        self.assertEqual(len(set(texts.values())), len(texts), "two pairs share an echo")
        # The tone is the pair's own evidence, not a constant.
        truce = hq_personas.echo_line("culinia", "pistonia", days=1, exchanges=1,
                                      a_heart_days=2, b_heart_days=2, lang="fr")
        entente = hq_personas.echo_line("culinia", "pistonia", days=2, exchanges=1,
                                        a_heart_days=2, b_heart_days=2, lang="fr")
        complicity = hq_personas.echo_line("culinia", "pistonia", days=2, exchanges=12,
                                          a_heart_days=2, b_heart_days=2, lang="fr")
        self.assertIn("trêve prudente", truce)
        self.assertIn("entente tacite", entente)
        self.assertIn("complicité tacite", complicity)
        self.assertEqual(len({truce, entente, complicity}), 3)

    def test_the_addressee_is_read_from_the_turn_not_hand_passed(self):
        """Only an explicit speech marker means a sister is speaking."""
        self.assertEqual(hq_personas.key_for_name("Pistonia"), "pistonia")
        self.assertEqual(hq_personas.key_for_name("nobody at all"), "")
        self.assertEqual(hq_personas.speaker_in("Culinia, a Pistonia : « ... »",
                                               listener="pistonia"), "culinia")
        self.assertEqual(hq_personas.speaker_in("Pistonia : la salle est calme",
                                               listener="culinia"), "pistonia")
        self.assertEqual(hq_personas.speaker_in("Culinia te passe la parole",
                                               listener="pistonia"), "culinia")
        self.assertEqual(hq_personas.speaker_in("Culinia → Pistonia : ...",
                                               listener="pistonia"), "culinia")
        # The Master writing her name is how he addresses her, not how she speaks.
        self.assertEqual(hq_personas.speaker_in("Pistonia, comment va la salle ?",
                                               listener="pistonia"), "")
        self.assertEqual(hq_personas.speaker_in("Salut.", listener="pistonia"), "")

    def test_the_echo_has_a_prompt_side_and_speaks_to_each_woman_herself(self):
        """Both women of one pair hear their own line, and only where it is earned."""
        mine = hq_personas.echo_prompt("culinia", "pistonia", days=2, exchanges=12,
                                      a_heart_days=2, b_heart_days=2, lang="fr")
        hers = hq_personas.echo_prompt("pistonia", "culinia", days=2, exchanges=12,
                                      a_heart_days=2, b_heart_days=2, lang="fr")
        self.assertTrue(mine and hers)
        self.assertNotEqual(mine, hers, "the two women of a pair read the same line")
        self.assertIn(hq_personas.get("culinia")["heart"]["echo"], mine)
        self.assertIn(hq_personas.get("pistonia")["heart"]["echo"], hers)
        self.assertIn("Pistonia", mine)
        self.assertIn("Culinia", hers)
        for who in ("culinia", "pistonia"):
            heart = hq_personas.get(who)["heart"]
            self.assertNotIn(heart["want"], mine + hers)
            self.assertNotIn(heart["hidden"], mine + hers)
        # The same two gates as the panel echo: one unlit heart, or no real day
        # between them, and there is nothing to say to each other yet.
        self.assertEqual(hq_personas.echo_prompt("culinia", "pistonia", days=2, exchanges=12,
                                                a_heart_days=0, b_heart_days=2, lang="fr"), "")
        self.assertEqual(hq_personas.echo_prompt("culinia", "pistonia", days=0, exchanges=0,
                                                a_heart_days=2, b_heart_days=2, lang="fr"), "")
        # Every pair, told in each direction, is its own line.
        keys = list(hq_personas.on_hq_keys())
        seen = set()
        for index, a in enumerate(keys):
            for b in keys[index + 1:]:
                for speaker, listener in ((a, b), (b, a)):
                    text = hq_personas.echo_prompt(speaker, listener, days=2, exchanges=12,
                                                   a_heart_days=2, b_heart_days=2, lang="fr")
                    self.assertTrue(text, f"{speaker} has nothing for {listener}")
                    self.assertNotIn(text, seen, f"{speaker} borrows another pair's line")
                    seen.add(text)
        self.assertEqual(len(seen), len(keys) * (len(keys) - 1))
        self.assertTrue(hq_personas.echo_prompt("pistonia", "culinia", days=2, exchanges=12,
                                                a_heart_days=2, b_heart_days=2,
                                                lang="en").startswith("ECHO — with"))

    def test_family_rows_carry_the_echo_only_where_it_qualifies(self):
        """The API gate and the pure rule must agree on every row it serves."""
        for key in hq_personas.on_hq_keys():
            mine = int(hq_personhood.bond(key, owner="admin").get("days") or 0)
            for row in hq_personhood._family_rows(key, owner="admin"):
                theirs = int(hq_personhood.bond(row["other"], owner="admin").get("days") or 0)
                should = mine >= 1 and theirs >= 1 and int(row["days"]) >= 1
                self.assertEqual(bool(row["echo"]), should, f"{key}|{row['other']}")
                if row["echo"]:
                    self.assertIn("Écho non dit", row["echo"])

    def test_a_pair_reads_differently_at_each_stage(self):
        """One real day moves the rung; the same pair never reads the same twice."""
        import time
        import hq_relationships as rel
        now = time.time()
        zero = rel.stage_line(Path(self.tmp.name), "culinia", "forgia", lang="fr", owner="admin")
        self.assertEqual(rel.pair_stage(0), "rencontre")
        rel.note_exchange(Path(self.tmp.name), "culinia", "forgia", "Le pain du four a tenu la promesse.", now=now, owner="admin")
        one = rel.stage_line(Path(self.tmp.name), "culinia", "forgia", lang="fr", owner="admin")
        self.assertEqual(rel.pair_stage(1), "premier_jour")
        self.assertNotEqual(one, zero)
        self.assertIn("Un seul jour partagé", one)
        self.assertIn("1 échange(s)", one)
        self.assertEqual(rel.line(Path(self.tmp.name), "culinia", "forgia", owner="admin"), "")   # still no closeness
        rel.note_exchange(Path(self.tmp.name), "culinia", "forgia", "Le pain du four a tenu la promesse.", now=now + 86400, owner="admin")
        two = rel.stage_line(Path(self.tmp.name), "culinia", "forgia", lang="fr", owner="admin")
        self.assertEqual(rel.pair_stage(2), "connaissance")
        self.assertIn("2 jours distincts", two)
        self.assertEqual(two, rel.line(Path(self.tmp.name), "culinia", "forgia", owner="admin"))
        # Above ``connaissance`` a rung also needs substance, never days alone:
        # many days with one line each is not a habit, and one long sitting is not
        # a complicity. Both axes come from real records.
        self.assertEqual(rel.pair_stage(2, 9), "connaissance")
        self.assertEqual(rel.pair_stage(2, 10), "habitude")
        self.assertEqual(rel.pair_stage(3, 40), "habitude")          # days alone carry the middle rung
        self.assertEqual(rel.pair_stage(4, 19), "habitude")
        self.assertEqual(rel.pair_stage(4, 20), "complicite")
        self.assertEqual(rel.pair_stage(9, 200), "complicite")

    def test_block_keeps_voice_and_sheds_whole_lines(self):
        import hq_culinia as culinia
        culinia.bind(root=Path(self.tmp.name))
        with mock.patch.object(assistant_voice, "state_line", return_value="ETAT " + "x" * 500), \
                mock.patch.object(assistant_voice, "bond_line", return_value="LIEN " + "y" * 500), \
                mock.patch.object(assistant_voice, "pair_line", return_value="PAIRE " + "z" * 500):
            text = assistant_voice.block("culinia")
        self.assertIn("VOIX", text)
        self.assertLessEqual(len(text.encode("utf-8")), assistant_voice.BLOCK_MAX_BYTES)
        self.assertNotIn("PAIRE", text)   # the lowest priority goes first
        for line in text.splitlines():
            self.assertTrue(line.startswith(("VOIX", "AVIS", "OPINION", "ETAT", "LIEN")), line)

    def test_pair_line_uses_relationship_evidence(self):
        row = {"a": "culinia", "b": "forgia", "exchanges": 4, "days": 3,
               "last_at": 0.0, "motif": ""}
        with mock.patch("hq_relationships.pair", return_value=row) as pair, \
                mock.patch("hq_relationships.line",
                           return_value="Familiarite avec Forgia : 3 jours distincts d'echange."):
            self.assertIn("3 jours", assistant_voice.pair_line("culinia"))
            self.assertTrue(pair.called)

    def test_pair_line_text_stays_empty_under_two_days(self):
        row = {"a": "culinia", "b": "forgia", "exchanges": 1, "days": 1,
               "last_at": 0.0, "motif": ""}
        with mock.patch("hq_relationships.pair", return_value=row):
            self.assertEqual(assistant_voice.pair_line("culinia"), "")

    def test_no_voice_card_borrows_another_stance_or_form(self):
        for key in hq_personas.keys():
            for compact in (False, True):
                text = hq_personas.voice_line(key, compact=compact)
                self.assertTrue(text, (key, compact))
                for other in hq_personas.keys():
                    if other == key:
                        continue
                    self.assertNotIn(hq_personas.get(other)["voice"]["stance"], text, (key, other))
                    self.assertNotIn(hq_personas.get(other)["voice"]["syntax"], text, (key, other))


class SisterVoiceTests(unittest.TestCase):
    """The sisters' own cores carry their own card, inside their byte budget."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-sister-voice-")
        self.root = Path(self.tmp.name)
        # Real clock: the bond line is read at "now" in production, and evidence
        # older than the 90-day retention belongs to no one.
        self.now = time.time()
        import hq_ai as ai
        ai.bind(root=self.root, now=lambda: self.now, key=lambda: "k")
        memory.bind(root=self.root, now=lambda: self.now)

    def tearDown(self):
        self.tmp.cleanup()

    def _system(self, key, channel="chat"):
        import hq_ai as ai
        fn = ai.build_transferania_system if key == "transferania" else ai.build_else_system
        return fn(channel, "warm", nsfw=False, view="accueil",
                  device_id="sister-device-1", context_core=True)

    def test_each_sister_carries_only_her_own_card(self):
        for key in ("transferania", "else"):
            other = "else" if key == "transferania" else "transferania"
            text = self._system(key)
            self.assertEqual(text.count("VOIX —"), 1, key)
            self.assertEqual(text.count("VOICE —"), 0, key)
            self.assertNotIn(hq_personas.get(other)["voice"]["stance"], text, key)
            for phrase in hq_personas.get(other)["voice"]["never"]:
                self.assertNotIn(phrase, text, key)

    def test_transferania_chat_core_stays_inside_the_tight_budget(self):
        core = self._system("transferania")
        base = 48 + len(core.encode("utf-8")) + len("bonjour".encode("utf-8"))
        self.assertLessEqual(base, 6000, "the warm chat core must still fit the 6 000 B tight budget")
        self.assertIn("40 mots max", core)
        self.assertTrue(any(line.startswith("VOIX —") for line in core.splitlines()))

    def test_bond_line_appears_once_two_real_days_exist(self):
        with memory.owner_context("admin"):
            hq_personhood.observe_chat("else", "Bonjour Else.", now=self.now - 86400, owner="admin")
            hq_personhood.observe_chat("else", "Encore un mot.", now=self.now, owner="admin")
        self.assertGreaterEqual(hq_personhood.bond("else", owner="admin", now=self.now)["days"], 2)
        text = self._system("else")
        self.assertEqual(text.count("LIEN AU MAÎTRE —"), 1)
        self.assertIn("2 jours d'échange", text)

    def test_static_has_no_prompt_in_this_repo(self):
        entry = hq_personas.get("static")
        self.assertFalse(entry["on_hq"])
        self.assertEqual(entry["module"], "", "Static lives in Project G, not on this HQ")


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
        self.assertIn("YOUR OWN TASTE", system)
        self.assertIn("not facts about the Master", system)


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
            base = module.get_thread()["revision"]
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
            before = module.status_summary()["reply_contention"]

            def fake_generate(chain, system, contents, _m=module, _calls=calls, **kw):
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
            after = module.status_summary()["reply_contention"]
            self.assertEqual(after["regenerations"] - before["regenerations"], 1)
            self.assertEqual(after["fallbacks"] - before["fallbacks"], 0)
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

            def racing_append(turn, base, epoch=0, _m=module, _real=real_append, _raced=raced):
                if not _raced["done"]:
                    _raced["done"] = True
                    # lands after the chat read the thread, before its atomic append
                    _m._append_turn([{"role": "user", "text": "tardif", "ts": 4.0},
                                     {"role": "assistant", "text": "ok2", "ts": 4.0}], base, epoch)
                return _real(turn, base, epoch)

            def fake_generate(chain, system, contents, _calls=calls, **kw):
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
            before = module.status_summary()["reply_contention"]

            def always_raced(turn, base, epoch=0, _m=module, _c=counter):
                _c["n"] += 1
                _m._append_turn([{"role": "user", "text": f"tardif{_c['n']}", "ts": 4.0 + _c["n"]},
                                 {"role": "assistant", "text": "ok", "ts": 4.0 + _c["n"]}], base, epoch)
                return False

            def fake_generate(chain, system, contents, _calls=calls, **kw):
                _calls.append(contents)
                return json.dumps({"reply": f"r{len(_calls)}", "tools": []}), "m"

            with mock.patch.dict(os.environ, {"HQ_CHAT_REPLY_ATTEMPTS": "2"}), \
                 mock.patch.object(ai, "generate", side_effect=fake_generate), \
                 mock.patch.object(module, "_append_turn_if_current", always_raced), \
                 self.assertLogs(module.__name__, level="WARNING") as captured:
                out = module.chat("lent")
            self.assertTrue(out["fallback_append"])
            after = module.status_summary()["reply_contention"]
            self.assertEqual(after["regenerations"] - before["regenerations"], 1)
            self.assertEqual(after["fallbacks"] - before["fallbacks"], 1)
            self.assertIn("1 regeneration(s)", captured.output[0])
            self.assertIn("not reconciled", captured.output[0])
            self.assertEqual(len(calls), 2)          # initial reply + one regeneration
            texts = [m["text"] for m in module.get_thread()["messages"]]
            self.assertEqual(texts[-2:], ["lent", "r2"])
            self.assertEqual(texts.count("lent"), 1)
            self.assertIn("tardif2", texts)

    def test_saturated_thread_still_triggers_regeneration(self):
        import hq_ai as ai
        import hq_culinia as culinia
        import hq_forgia as forgia
        for module, folder, name in ((culinia, ".hq-household", "culinia_thread.json"),
                                     (forgia, ".hq-forge", "forgia_thread.json")):
            module.bind(root=self.root)
            path = self.root / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            rows = [{"role": "user" if i % 2 else "assistant", "text": f"vieux {i}", "ts": float(i)}
                    for i in range(module.MAX_THREAD)]
            path.write_text(json.dumps({"messages": rows, "revision": 7}), encoding="utf-8")
            calls = []

            def fake_generate(chain, system, contents, _calls=calls, _m=module, **kw):
                _calls.append(contents)
                if len(_calls) == 1:
                    _m._append_turn([{"role": "user", "text": "nouveau", "ts": 99.0},
                                     {"role": "assistant", "text": "ok", "ts": 99.0}], 7)
                    return json.dumps({"reply": "première", "tools": []}), "m"
                return json.dumps({"reply": "seconde", "tools": []}), "m"

            with mock.patch.object(ai, "generate", side_effect=fake_generate):
                out = module.chat("lent")
            self.assertEqual(out["reply"], "seconde")
            self.assertEqual(len(calls), 2)
            self.assertEqual(len(module.get_thread()["messages"]), module.MAX_THREAD)
            self.assertIn("nouveau", json.dumps(calls[1], ensure_ascii=False))

    def test_revision_detects_a_replacement_at_the_same_length(self):
        import hq_culinia as culinia
        import hq_forgia as forgia
        for module, folder, name in ((culinia, ".hq-household", "culinia_thread.json"),
                                     (forgia, ".hq-forge", "forgia_thread.json")):
            module.bind(root=self.root)
            path = self.root / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"messages": [{"role": "user", "text": "a", "ts": 1.0},
                                                      {"role": "assistant", "text": "b", "ts": 1.0}],
                                        "revision": 5}), encoding="utf-8")
            module.clear_thread()
            self.assertEqual(module.get_thread()["revision"], 6)
            epoch = module.get_thread()["clear_epoch"]
            stale = module._append_turn_if_current([{"role": "user", "text": "lent", "ts": 2.0}], 5, epoch)
            self.assertFalse(stale)
            self.assertEqual(module.get_thread()["messages"], [])
            fresh = module._append_turn_if_current([{"role": "user", "text": "lent", "ts": 2.0}], 6, epoch)
            self.assertTrue(fresh)

    def test_regeneration_includes_tool_results_without_replaying_tools(self):
        import hq_ai as ai
        import hq_culinia as culinia
        culinia.bind(root=self.root)
        path = self.root / ".hq-household" / "culinia_thread.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"messages": [{"role": "user", "text": "ancien", "ts": 1.0}],
                                    "revision": 0}), encoding="utf-8")
        calls = []
        executions = []

        def fake_execute(name, args):
            executions.append(name)
            culinia._append_turn([{"role": "user", "text": "autre", "ts": 2.0},
                                  {"role": "assistant", "text": "ok", "ts": 2.0}], 0)
            return {"name": name, "ok": True, "result": {"days": {"lundi": "soupe"}}}

        def fake_generate(chain, system, contents, _calls=calls, **kw):
            _calls.append(contents)
            if len(_calls) == 1:
                return json.dumps({"reply": "", "tools": [{"name": "get_meal_plan", "args": {}}]}), "m"
            if len(_calls) == 2:
                return json.dumps({"reply": "ancienne", "tools": []}), "m"
            return json.dumps({"reply": "seconde", "tools": []}), "m"

        with mock.patch.object(culinia, "_execute_tool", side_effect=fake_execute), \
             mock.patch.object(ai, "generate", side_effect=fake_generate):
            out = culinia.chat("lent")
        self.assertEqual(out["reply"], "seconde")
        self.assertEqual(executions, ["get_meal_plan"])      # not replayed
        regenerated = json.dumps(calls[-1], ensure_ascii=False)
        self.assertIn("lundi", regenerated)                  # tool result kept
        self.assertIn("autre", regenerated)                  # new turn seen

    def test_regeneration_that_requests_tools_is_a_fallback_not_a_reconciliation(self):
        import hq_ai as ai
        import hq_culinia as culinia
        culinia.bind(root=self.root)
        path = self.root / ".hq-household" / "culinia_thread.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"messages": [{"role": "user", "text": "ancien", "ts": 1.0}],
                                    "revision": 0}), encoding="utf-8")
        calls = []

        def fake_generate(chain, system, contents, _calls=calls, **kw):
            _calls.append(contents)
            if len(_calls) == 1:
                culinia._append_turn([{"role": "user", "text": "autre", "ts": 2.0},
                                      {"role": "assistant", "text": "ok", "ts": 2.0}], 0)
                return json.dumps({"reply": "ancienne", "tools": []}), "m"
            return json.dumps({"reply": "", "tools": [{"name": "get_meal_plan", "args": {}}]}), "m"

        with mock.patch.object(ai, "generate", side_effect=fake_generate), \
             self.assertLogs(culinia.__name__, level="WARNING"):
            out = culinia.chat("lent")
        self.assertTrue(out["fallback_append"])
        self.assertEqual(out["reply"], "ancienne")          # stale answer not sold as reconciled
        self.assertIn("autre", [m["text"] for m in culinia.get_thread()["messages"]])

    def test_growth_views_reach_culinia_and_forgia_without_changing_their_voice(self):
        import time as _time
        import hq_ai as ai
        import hq_culinia as culinia
        import hq_forgia as forgia
        now = _time.time()
        for module, folder, filename, growth_file in (
                (culinia, ".hq-household", "culinia_thread.json", "culinia_growth.json"),
                (forgia, ".hq-forge", "forgia_thread.json", "forgia_growth.json")):
            module.bind(root=self.root)
            path = self.root / folder / growth_file
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"episodes": [
                {"id": "a", "text": "Je m'intéresse à la fermentation lactique.", "kind": "interest",
                 "topic": "fermentation lactique", "at": now - 90000, "status": "active",
                 "source_device": "test", "evidence": "user_statement"},
                {"id": "b", "text": "J'explore la fermentation lactique.", "kind": "interest",
                 "topic": "fermentation lactique", "at": now - 180000, "status": "active",
                 "source_device": "test", "evidence": "user_statement"},
            ]}), encoding="utf-8")
            seen = []

            def fake_generate(chain, system, contents, _seen=seen, **kw):
                _seen.append(system)
                return json.dumps({"reply": "ok", "tools": []}), "m"

            with mock.patch.object(ai, "generate", side_effect=fake_generate):
                out = module.chat("Parle-moi de la fermentation.")
            self.assertEqual(out["reply"], "ok")
            self.assertEqual(len(seen), 1)
            self.assertIn("ÉVOLUTION VÉCUE", seen[0])
            self.assertIn("fermentation lactique", seen[0])
            self.assertTrue(seen[0].startswith(module.PERSONA_CORE))

    def test_growth_episodes_are_forgotten_after_the_window(self):
        import time as _time
        import hq_ai as ai
        import hq_culinia as culinia
        import hq_forgia as forgia
        now = _time.time()
        for module, folder, growth_file in ((culinia, ".hq-household", "culinia_growth.json"),
                                            (forgia, ".hq-forge", "forgia_growth.json")):
            module.bind(root=self.root)
            path = self.root / folder / growth_file
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"episodes": [
                {"id": "old", "text": "Je m'intéresse à la fermentation lactique.", "kind": "interest",
                 "topic": "fermentation lactique", "at": now - 100 * 86400, "status": "active",
                 "source_device": "test", "evidence": "user_statement"},
            ]}), encoding="utf-8")

            def fake_generate(chain, system, contents, **kw):
                return json.dumps({"reply": "ok", "tools": []}), "m"

            with mock.patch.object(ai, "generate", side_effect=fake_generate):
                module.chat("bonjour")
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["episodes"], [], module.__name__)

    def test_growth_reaches_musica_securia_inventoria_and_pistonia(self):
        import time as _time
        import hq_ai as ai
        import hq_inventoria
        import hq_inventoria_ai
        import hq_music
        import hq_musica
        import hq_pistonia
        import hq_pistonia_store
        import hq_securia
        now = _time.time()
        hq_music.bind(root=self.root)
        seed = {"episodes": [
            {"id": "a", "text": "Je m'intéresse à la fermentation lactique.", "kind": "interest",
             "topic": "fermentation lactique", "at": now - 90000, "status": "active",
             "source_device": "test", "evidence": "user_statement"},
            {"id": "b", "text": "J'explore la fermentation lactique.", "kind": "interest",
             "topic": "fermentation lactique", "at": now - 180000, "status": "active",
             "source_device": "test", "evidence": "user_statement"},
        ]}

        for module, folder, filename in ((hq_musica, ".hq-music", "musica_growth.json"),
                                         (hq_securia, ".hq-security", "securia_growth.json")):
            module.bind(root=self.root)
            path = self.root / folder / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(seed), encoding="utf-8")
            seen = []

            def fake_generate(chain, system, contents, _seen=seen, **kw):
                _seen.append(system)
                return json.dumps({"reply": "ok", "tools": []}), "m"

            with mock.patch.object(ai, "generate", side_effect=fake_generate):
                module.chat("Parle-moi de la fermentation.")
            self.assertIn("ÉVOLUTION VÉCUE", seen[0], module.__name__)
            self.assertIn("fermentation lactique", seen[0], module.__name__)

        hq_inventoria.bind(root=self.root)
        path = self.root / ".hq-inventoria" / "inventoria_growth.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(seed), encoding="utf-8")
        seen = []

        def inv_generate(chain, system, contents, _seen=seen, **kw):
            _seen.append(system)
            return json.dumps({"reply": "ok", "tools": []}), "m"

        with mock.patch.object(ai, "generate", side_effect=inv_generate):
            hq_inventoria_ai.respond("Parle-moi de la fermentation.", [], {})
        self.assertIn("ÉVOLUTION VÉCUE", seen[0])
        self.assertIn("fermentation lactique", seen[0])

        hq_pistonia_store.bind(self.root)
        path = self.root / ".hq-engine" / "pistonia" / "pistonia_growth.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(seed), encoding="utf-8")
        seen = []

        def pis_generate(system, contents, _seen=seen):
            _seen.append(system)
            return json.dumps({"reply": "ok", "tools": []})

        hq_pistonia.message({"text": "Parle-moi de la fermentation."}, generate=pis_generate)
        self.assertIn("ÉVOLUTION VÉCUE", seen[0])
        self.assertIn("fermentation lactique", seen[0])

    def test_single_day_interest_is_not_yet_a_view(self):
        import time as _time
        import hq_ai as ai
        import hq_culinia as culinia
        import hq_forgia as forgia
        now = _time.time()
        for module, folder, growth_file in ((culinia, ".hq-household", "culinia_growth.json"),
                                            (forgia, ".hq-forge", "forgia_growth.json")):
            module.bind(root=self.root)
            path = self.root / folder / growth_file
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"episodes": [
                {"id": "a", "text": "Je m'intéresse à la fermentation lactique.", "kind": "interest",
                 "topic": "fermentation lactique", "at": now - 3600, "status": "active",
                 "source_device": "test", "evidence": "user_statement"},
            ]}), encoding="utf-8")
            seen = []

            def fake_generate(chain, system, contents, _seen=seen, **kw):
                _seen.append(system)
                return json.dumps({"reply": "ok", "tools": []}), "m"

            with mock.patch.object(ai, "generate", side_effect=fake_generate):
                module.chat("Parle-moi de la fermentation.")
            self.assertEqual(len(seen), 1)
            self.assertNotIn("ÉVOLUTION VÉCUE", seen[0])

    def test_personhood_line_fits_culinia_full_system_prompt(self):
        import time as _time
        import hq_ai as ai
        import hq_culinia as culinia
        import hq_personhood as personhood

        ai = self._ai()
        culinia.bind(root=self.root)
        personhood.observe_chat(
            "culinia", "Parle-moi de la fermentation.", now=_time.time() - 7200)
        query = "Tu penses à la fermentation ?"

        def ask():
            seen = []

            def fake_generate(chain, system, contents, _seen=seen, **kw):
                _seen.append(system)
                return json.dumps({"reply": "ok", "tools": []}), "m"

            with mock.patch.object(ai, "generate", side_effect=fake_generate):
                culinia.chat(query)
            self.assertEqual(len(seen), 1)
            return seen[0]

        with_personhood = ask()
        self.assertIn("SUJET RÉCENT", with_personhood)
        self.assertIn("fermentation", with_personhood)
        self.assertLessEqual(len(with_personhood.encode("utf-8")), ai.context_budget("chat"))

        with mock.patch.object(personhood, "hint", return_value=""):
            baseline = ask()
        self.assertNotIn("SUJET RÉCENT", baseline)
        delta = len(with_personhood.encode("utf-8")) - len(baseline.encode("utf-8"))
        self.assertGreater(delta, 0)
        self.assertLessEqual(delta, 500, "Culinia's full system prompt must stay within a small margin")

    def test_explicit_development_is_recorded_per_assistant(self):
        import hq_ai as ai
        import hq_culinia as culinia
        import hq_forgia as forgia
        for module, folder, growth_file in ((culinia, ".hq-household", "culinia_growth.json"),
                                            (forgia, ".hq-forge", "forgia_growth.json")):
            module.bind(root=self.root)

            def fake_generate(chain, system, contents, **kw):
                return json.dumps({"reply": "ok", "tools": []}), "m"

            with mock.patch.object(ai, "generate", side_effect=fake_generate):
                module.chat("Je m'intéresse à la fermentation lactique.")
            data = json.loads((self.root / folder / growth_file).read_text(encoding="utf-8"))
            self.assertEqual([e["kind"] for e in data["episodes"]], ["interest"])
            self.assertIn("fermentation lactique", data["episodes"][0]["topic"])
            other = "forgia_growth.json" if growth_file.startswith("culinia") else "culinia_growth.json"
            self.assertFalse((self.root / folder / other).exists())

    def test_clear_during_generation_cancels_the_reply(self):
        import hq_ai as ai
        import hq_culinia as culinia
        import hq_forgia as forgia
        for module, folder, name in ((culinia, ".hq-household", "culinia_thread.json"),
                                     (forgia, ".hq-forge", "forgia_thread.json")):
            module.bind(root=self.root)
            path = self.root / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"messages": [{"role": "user", "text": "ancien", "ts": 1.0}],
                                        "revision": 0, "clear_epoch": 2}), encoding="utf-8")
            calls = []

            def fake_generate(chain, system, contents, _calls=calls, _m=module, **kw):
                _calls.append(contents)
                _m.clear_thread()          # the user clears while the model is thinking
                return json.dumps({"reply": "fantôme", "tools": []}), "m"

            with mock.patch.object(ai, "generate", side_effect=fake_generate), \
                 self.assertLogs(module.__name__, level="WARNING") as captured:
                out = module.chat("lent")
            self.assertTrue(out["cancelled"])
            self.assertFalse(out["fallback_append"])
            self.assertEqual(len(calls), 1)            # no regeneration into the empty thread
            self.assertEqual(module.get_thread()["messages"], [])
            self.assertEqual(module.get_thread()["clear_epoch"], 3)
            self.assertIn("cleared", captured.output[0])

    def test_clear_between_append_attempt_and_fallback_does_not_resurrect(self):
        import os
        import hq_ai as ai
        import hq_culinia as culinia
        import hq_forgia as forgia
        for module, folder, name in ((culinia, ".hq-household", "culinia_thread.json"),
                                     (forgia, ".hq-forge", "forgia_thread.json")):
            module.bind(root=self.root)
            path = self.root / folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"messages": [{"role": "user", "text": "ancien", "ts": 1.0}],
                                        "revision": 0, "clear_epoch": 0}), encoding="utf-8")

            def racing_clear(turn, base, epoch=0, _m=module):
                _m.clear_thread()          # clear lands after the check, before the write
                return False

            def fake_generate(chain, system, contents, **kw):
                return json.dumps({"reply": "fantôme", "tools": []}), "m"

            with mock.patch.dict(os.environ, {"HQ_CHAT_REPLY_ATTEMPTS": "1"}), \
                 mock.patch.object(ai, "generate", side_effect=fake_generate), \
                 mock.patch.object(module, "_append_turn_if_current", racing_clear), \
                 self.assertLogs(module.__name__, level="WARNING"):
                out = module.chat("lent")
            self.assertTrue(out["cancelled"])
            self.assertFalse(out["fallback_append"])
            self.assertEqual(module.get_thread()["messages"], [])
            self.assertEqual(module.get_thread()["clear_epoch"], 1)

    def test_forgia_regeneration_includes_tool_results_without_replaying(self):
        import hq_ai as ai
        import hq_forgia as forgia
        forgia.bind(root=self.root)
        path = self.root / ".hq-forge" / "forgia_thread.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"messages": [{"role": "user", "text": "ancien", "ts": 1.0}],
                                    "revision": 0, "clear_epoch": 0}), encoding="utf-8")
        calls = []
        executions = []

        def fake_execute(name, args):
            executions.append(name)
            forgia._append_turn([{"role": "user", "text": "autre", "ts": 2.0},
                                 {"role": "assistant", "text": "ok", "ts": 2.0}], 0, 0)
            return {"name": name, "ok": True, "result": {"queue": ["job-42"]}}

        def fake_generate(chain, system, contents, _calls=calls, **kw):
            _calls.append(contents)
            if len(_calls) == 1:
                return json.dumps({"reply": "", "tools": [{"name": "forge_status", "args": {}}]}), "m"
            if len(_calls) == 2:
                return json.dumps({"reply": "ancienne", "tools": []}), "m"
            return json.dumps({"reply": "seconde", "tools": []}), "m"

        with mock.patch.object(forgia, "_execute_tool", side_effect=fake_execute), \
             mock.patch.object(ai, "generate", side_effect=fake_generate):
            out = forgia.chat("lent")
        self.assertEqual(out["reply"], "seconde")
        self.assertEqual(executions, ["forge_status"])
        regenerated = json.dumps(calls[-1], ensure_ascii=False)
        self.assertIn("job-42", regenerated)
        self.assertIn("autre", regenerated)

    def test_regeneration_failure_keeps_the_tool_backed_reply_as_a_fallback(self):
        import hq_ai as ai
        import hq_culinia as culinia
        culinia.bind(root=self.root)
        path = self.root / ".hq-household" / "culinia_thread.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"messages": [{"role": "user", "text": "ancien", "ts": 1.0}],
                                    "revision": 0, "clear_epoch": 0}), encoding="utf-8")
        calls = []
        executions = []

        def fake_execute(name, args):
            executions.append(name)
            culinia._append_turn([{"role": "user", "text": "autre", "ts": 2.0},
                                  {"role": "assistant", "text": "ok", "ts": 2.0}], 0, 0)
            return {"name": name, "ok": True, "result": {"days": {"lundi": "soupe"}}}

        def fake_generate(chain, system, contents, _calls=calls, **kw):
            _calls.append(contents)
            if len(_calls) == 1:
                return json.dumps({"reply": "", "tools": [{"name": "get_meal_plan", "args": {}}]}), "m"
            if len(_calls) == 2:
                return json.dumps({"reply": "ancienne", "tools": []}), "model-a"
            raise TimeoutError("modèle lent")

        with mock.patch.object(culinia, "_execute_tool", side_effect=fake_execute), \
             mock.patch.object(ai, "generate", side_effect=fake_generate), \
             self.assertLogs(culinia.__name__, level="WARNING"):
            out = culinia.chat("lent")
        self.assertTrue(out["fallback_append"])
        self.assertFalse(out["cancelled"])
        self.assertEqual(out["reply"], "ancienne")
        self.assertEqual(out["model"], "model-a")
        self.assertEqual(executions, ["get_meal_plan"])      # never replayed

    def test_rejected_regeneration_keeps_attempts_and_model_attribution_apart(self):
        import hq_ai as ai
        import hq_culinia as culinia
        culinia.bind(root=self.root)
        path = self.root / ".hq-household" / "culinia_thread.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"messages": [{"role": "user", "text": "ancien", "ts": 1.0}],
                                    "revision": 0, "clear_epoch": 0}), encoding="utf-8")
        calls = []

        def fake_generate(chain, system, contents, _calls=calls, **kw):
            _calls.append(contents)
            if len(_calls) == 1:
                culinia._append_turn([{"role": "user", "text": "autre", "ts": 2.0},
                                      {"role": "assistant", "text": "ok", "ts": 2.0}], 0, 0)
                return json.dumps({"reply": "ancienne", "tools": []}), "model-a"
            return json.dumps({"reply": "", "tools": [{"name": "get_meal_plan", "args": {}}]}), "model-b"

        with mock.patch.object(ai, "generate", side_effect=fake_generate), \
             self.assertLogs(culinia.__name__, level="WARNING"):
            out = culinia.chat("lent")
        self.assertEqual(out["regenerations"], 1)
        self.assertEqual(out["reconciled"], 0)              # attempted, not reconciled
        self.assertTrue(out["fallback_append"])
        self.assertEqual(out["model"], "model-a")          # retained reply's model, not the rejected one

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
