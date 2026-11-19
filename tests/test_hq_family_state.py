"""The family stays distinct, and each assistant's history changes what she says.

Pins three things the roster promises: every assistant has her own voice and her
own opinion, her persisted state moves with real events, and pair familiarity
reaches both sides' prompts with a rung that rises as days accumulate.
"""
import json
import tempfile
import threading
import time
import unittest
from datetime import datetime, time as clock_time
from pathlib import Path

import hq_ai as ai
import hq_assistant_visits as visits

try:
    import hq_assistant_voice as voice
except ImportError:  # a checkout without the voice block: nothing here can be asserted
    raise unittest.SkipTest("hq_assistant_voice is not part of this checkout")

import hq_companion_memory as memory
import hq_culinia
import hq_elsea
import hq_forgia
import hq_inventoria
import hq_musica
import hq_personas
import hq_personhood as ph
import hq_pistonia_store as pistonia_store
import hq_relationships as rel
import hq_securia
import hq_state
from tests import hq_assistant_state  # noqa: F401  (imported for its side effect: nothing)

# Real clock: the personality ledger prunes anything stamped in the future, so a
# fixed far-future constant would make every bond and pair test read as empty.
NOW = time.time()
DAY = 86400


class FamilyBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        ai.bind(root=self.root, now=lambda: NOW, key=lambda: "test-key")
        hq_assistant_state.guard(self)  # a store left unbound would write the checkout
        self.bind_all()
        self.scope = memory.owner_context("admin")
        self.scope.__enter__()
        self.addCleanup(self.scope.__exit__, None, None, None)
        memory._owner_established.set(True)

    def bind_all(self):
        """Everything a restart would re-bind, so a read after this is a fresh process."""
        memory.bind(root=self.root, now=lambda: NOW)
        hq_state.bind_root(self.root)  # hq_relationships resolves its files through hq_state
        hq_inventoria.bind(root=self.root)
        pistonia_store.bind(self.root)
        # Every sister whose visit log pair_threads can read: a store left bound
        # to an earlier root shows this test a thread she never had.
        for module in (hq_culinia, hq_forgia, hq_securia, hq_musica, hq_elsea):
            module.bind(root=self.root)

    def tearDown(self):
        self.tmp.cleanup()


class DistinctnessTests(FamilyBase):
    def test_every_assistant_has_her_own_voice_and_opinion(self):
        cards, opinions, caps = {}, {}, {}
        for key in hq_personas.keys():
            card = hq_personas.voice_line(key)
            opinion = hq_personas.opinion_line(key)
            self.assertTrue(card, f"{key} has no voice card")
            self.assertTrue(opinion, f"{key} has no opinion")
            cards[key], opinions[key] = card, opinion
            caps[key] = hq_personas.get(key)["voice"]["cap"]
        self.assertEqual(len(set(cards.values())), len(cards), "two assistants share a voice card")
        self.assertEqual(len(set(opinions.values())), len(opinions), "two assistants share an opinion")
        self.assertEqual(len(set(caps.values())), len(caps), "two assistants share a prose cap")

    def test_no_assistant_repeats_anothers_opinion_or_banned_phrase(self):
        opinions = {key: hq_personas.opinion_line(key) for key in hq_personas.keys()}
        for key in hq_personas.keys():
            mine = hq_personas.get(key)["voice"]["never"]
            for other, opinion in opinions.items():
                if other == key:
                    continue
                block = voice.block(other)
                self.assertNotIn(opinions[key], block, f"{other} carries {key}'s opinion")
            for banned in mine:
                for other in hq_personas.keys():
                    if other == key:
                        continue
                    self.assertNotIn(banned, voice.block(other),
                                     f"{other} would say {key}'s banned phrase {banned!r}")

    def test_each_prompt_carries_her_own_card_and_opinion_once(self):
        for key in hq_personas.on_hq_keys():
            block = voice.block(key)
            self.assertEqual(block.count(hq_personas.voice_line(key)), 1, key)
            self.assertEqual(block.count(hq_personas.opinion_line(key)), 1, key)
            for other in hq_personas.keys():
                if other == key:
                    continue
                self.assertNotIn(hq_personas.opinion_line(other), block, f"{key} borrows {other}")

    def test_quirks_are_per_assistant(self):
        seen = {}
        for key in hq_personas.keys():
            quirks = set(hq_personas.traits(key)["quirks"])
            self.assertEqual(len(quirks), 3, key)
            for other, theirs in seen.items():
                self.assertFalse(quirks & theirs, f"{key} and {other} share a quirk")
            seen[key] = quirks


class StateTests(FamilyBase):
    def _history(self, key="culinia"):
        for age in (DAY + 3600, 0):
            ph.observe_chat(key, "On prépare une soupe de courge.", now=NOW - age, owner="admin")
        ph.record_event(key, kind="error", outcome="failed", text="le four a lâché",
                        now=NOW - 300, owner="admin")

    def test_a_fresh_assistant_and_one_with_history_say_it_differently(self):
        fresh = voice.block("culinia")
        self.assertNotIn("LIEN AU MAÎTRE", fresh)
        self.assertNotIn("ÉTAT INTERNE", fresh)
        self._history()
        after = voice.block("culinia")
        self.assertNotEqual(fresh, after)
        self.assertIn("LIEN AU MAÎTRE", after)
        self.assertIn("ÉTAT INTERNE", after)

    def test_one_assistants_history_never_leaks_into_another(self):
        self._history("culinia")
        self.assertNotEqual(ph.state_line("culinia", owner="admin", now=NOW), "")
        self.assertEqual(ph.state_line("forgia", owner="admin", now=NOW), "")
        self.assertEqual(ph.bond("forgia", owner="admin", now=NOW)["days"], 0)
        self.assertNotIn("LIEN AU MAÎTRE", voice.block("forgia"))

    def test_a_short_exchange_still_counts_its_day(self):
        for age in (DAY + 3600, 0):
            ph.observe_chat("culinia", "Salut", now=NOW - age, owner="admin")
        self.assertEqual(ph.bond("culinia", owner="admin")["days"], 2)
        panel = ph.snapshot("culinia", owner="admin")
        self.assertTrue(panel["bond"]["line"].startswith("LIEN AU MAÎTRE"), panel["bond"]["line"])
        # A greeting is a day, not a subject: no thread is invented from it.
        self.assertEqual(panel["preoccupations"], [])
        self.assertEqual(ph.hint("culinia", "Salut", owner="admin"), "")

    def test_state_is_persisted_and_survives_a_restart(self):
        self._history("culinia")
        before = ph.state_line("culinia", owner="admin", now=NOW)
        path = ph.self_path("culinia", owner="admin")
        self.assertIsNotNone(path)
        stored = json.loads(path.read_text(encoding="utf-8"))
        self.assertIn("affect", stored)
        self.assertGreater(len(stored.get("events") or []), 0)
        # A restart re-binds the stores and drops in-memory objects; the file is the state.
        self.bind_all()
        after = ph.state_line("culinia", owner="admin", now=NOW)
        self.assertEqual(before, after)

    def test_compact_state_is_one_short_line_or_nothing(self):
        self.assertEqual(ph.state_line("culinia", owner="admin", now=NOW, compact=True), "")
        self._history("culinia")
        compact = ph.state_line("culinia", owner="admin", now=NOW, compact=True)
        self.assertTrue(compact.startswith("ÉTAT — "))
        self.assertLessEqual(len(compact.encode("utf-8")), 120)


class RelationshipTests(FamilyBase):
    def _meet(self, days):
        for day in days:
            rel.note_exchange(None, "culinia", "forgia", "Le four tient.",
                              now=NOW - day * DAY, owner="admin")

    def test_familiarity_rung_rises_with_distinct_days(self):
        self._meet([1])
        self.assertEqual(rel.line(None, "culinia", "forgia", owner="admin"), "")
        self._meet([2])
        acquainted = rel.line(None, "culinia", "forgia", owner="admin")
        self.assertIn("2 jours distincts", acquainted)
        self.assertIn("connaissance", acquainted)
        self.assertEqual(rel.tier(2), "connaissance")
        self._meet([3, 4, 5])
        used_to = rel.line(None, "culinia", "forgia", owner="admin")
        self.assertIn("habitude", used_to)
        self.assertIn("Le four tient.", used_to)  # a real shared moment, quotable
        self.assertNotEqual(acquainted, used_to)
        self._meet([6, 7, 8, 9, 10])
        close = rel.line(None, "culinia", "forgia", owner="admin")
        self.assertIn("complicité", close)
        self.assertIn("raccourcis", close)

    def test_pair_familiarity_reaches_both_prompts(self):
        self._meet([1, 2])
        self.assertIn("Familiarité avec Forgia", voice.block("culinia"))
        self.assertIn("Familiarité avec Culinia", voice.block("forgia"))

    def test_relationship_line_never_carries_the_other_alias(self):
        self._meet([3, 4])
        for key in ("culinia", "forgia"):
            block = voice.block(key)
            for other in hq_personas.keys():
                if other == key:
                    continue
                alias = hq_personas.get(other)["alias"]
                if alias:
                    self.assertNotIn(alias, block, f"{key} borrows {other}'s alias")


class PanelTests(FamilyBase):
    def test_snapshot_exposes_voice_bond_and_family_for_the_panel(self):
        for age in (DAY + 3600, 0):
            ph.observe_chat("culinia", "On prépare une soupe de courge.", now=NOW - age, owner="admin")
        rel.note_exchange(None, "culinia", "forgia", "Le four tient.", now=NOW - DAY, owner="admin")
        rel.note_exchange(None, "culinia", "forgia", "Le four tient encore.", now=NOW, owner="admin")
        snap = ph.snapshot("culinia", owner="admin", now=NOW)
        self.assertEqual(snap["ok"], True)
        self.assertIn("AVIS", snap["voice"]["opinion"])
        self.assertEqual(snap["voice"]["card"], hq_personas.voice_line("culinia"))
        self.assertEqual(snap["bond"]["days"], 2)
        self.assertTrue(snap["bond"]["line"].startswith("LIEN AU MAÎTRE"))
        rows = {row["other_name"]: row for row in snap["family"]}
        self.assertIn("Forgia", rows)
        self.assertEqual(rows["Forgia"]["tier"], "connaissance")
        self.assertEqual(rows["Forgia"]["tier_label"], "connaissance")

    def test_panel_payload_survives_the_http_adapter(self):
        code, payload = ph.http_get({"key": "culinia"}, owner_id="admin")
        self.assertEqual(code, 200)
        self.assertIn("family", payload)
        self.assertIn("bond", payload)
        self.assertIn("voice", payload)

    def test_panel_sits_above_the_navigation_rail(self):
        """The rail is translucent and blurred; below it the panel's left third was unreadable."""
        import re

        project = Path(__file__).resolve().parent.parent
        panel = (project / "assets" / "hq-personhood.css").read_text(encoding="utf-8")
        # The rail's own z-index lives in the page stylesheet served by the bridge.
        page = (project / "iphone_bridge.py").read_text(encoding="utf-8", errors="replace")
        nav = re.search(r"\.bottom-nav\s*\{[^}]*?z-index:\s*(\d+)", page)
        self.assertIsNotNone(nav, "the navigation rail still declares a z-index")
        for selector in (".hq-self-open", ".hq-self-panel"):
            block = re.search(re.escape(selector) + r"\s*\{[^}]*?z-index:\s*(\d+)", panel)
            self.assertIsNotNone(block, selector + " declares a z-index")
            self.assertGreater(int(block.group(1)), int(nav.group(1)), selector + " must sit above the rail")
        # The page's generic h2 rule is dark; on this dark panel it hid the title.
        head = re.search(r"\.hq-self-head h2\s*\{([^}]*)\}", panel)
        self.assertIsNotNone(head)
        self.assertIn("color: inherit", head.group(1))
        self.assertNotIn("rgba(16,16,20,.97)", panel)   # opaque panel: text ghosted through the old alpha
        # The dev-only debug chip sits in the same corner at z-index 120000 and used
        # to take every click meant for the button; the button clears it instead.
        self.assertIn("body.hq-self-debug-chip .hq-self-open", panel)
        clear = re.search(r"body\.hq-self-debug-chip \.hq-self-open\s*\{[^}]*?bottom:\s*var\(--hq-self-chip-clear",
                          panel)
        self.assertIsNotNone(clear, "the lift must use the measured chip height, not a guess")
        script = (project / "assets" / "hq-personhood.js").read_text(encoding="utf-8")
        self.assertIn("--hq-self-chip-clear", script)
        self.assertIn("ResizeObserver", script)   # the chip's own collapse changes its height

    def test_panel_renders_voice_bond_and_family(self):
        source = (Path(__file__).resolve().parent.parent / "assets" / "hq-personhood.js").read_text(encoding="utf-8")
        for needle in ("Lien au Maître", "Famille", "data.voice", "data.bond", "data.family",
                       "row.stage_label", "voice.opinion"):
            self.assertIn(needle, source)
        # One ladder only: the panel renders the rung the API names and keeps no
        # table of its own, and `tier_label` (a day-count label that can sit below
        # the real rung) is no longer a fallback for what the pair earned.
        self.assertNotIn("row.tier_label", source)
        self.assertNotIn("STAGE_LABELS", source)


class LiveWiringTests(FamilyBase):
    """A real chat turn must reach the very ledger the Master's panel opens.

    Run on the real clock, like the bridge: the ledger prunes an event stamped
    after its own read clock, so a day seeded for yesterday is written first.
    """

    # The ambient owner the chat paths write under. The bridge establishes it as
    # the session name ("Administrateur") before dispatch; here it is the default.
    OWNER = "admin"

    def setUp(self):
        super().setUp()
        ai.bind(root=self.root, now=time.time, key=lambda: "test-key")
        memory.bind(root=self.root, now=time.time)
        hq_state.bind_root(self.root)
        hq_inventoria.bind(root=self.root)
        pistonia_store.bind(self.root)
        for module in (hq_culinia, hq_forgia, hq_securia, hq_musica, hq_elsea):
            module.bind(root=self.root)

    def _turn(self, fn, message):
        from unittest import mock

        def fake(chain, system, contents, **kw):
            return json.dumps({"reply": "ok", "tools": []}), "gemini-3.1-flash-lite"

        with mock.patch.object(ai, "generate", side_effect=fake):
            return fn(message, device_id="family-test-device")

    def _panel(self, key):
        return ph.snapshot(key, owner=self.OWNER)

    def test_a_chat_turn_reaches_the_panel_the_master_opens(self):
        self.assertEqual(ph.bond("transferania", owner=self.OWNER)["days"], 0)
        self._turn(ai.transferania_chat, "Le four m'a lâché en pleine soirée, je rentre tard.")
        bond = self._panel("transferania")["bond"]
        self.assertEqual(bond["days"], 1)
        self.assertGreaterEqual(bond["turns"], 1)
        self.assertEqual(bond["line"], "")   # one day is a turn, not a link yet

    def test_two_distinct_days_turn_the_line_into_a_link(self):
        ph.record_event("transferania", kind="chat", topic="Le four froid", text="Le four froid",
                        outcome="turn", source="chat", now=time.time() - 86400, owner=self.OWNER)
        self._turn(ai.transferania_chat, "Le four m'a lâché en pleine soirée, je rentre tard.")
        bond = self._panel("transferania")["bond"]
        self.assertEqual(bond["days"], 2)
        self.assertTrue(bond["line"].startswith("LIEN AU MAÎTRE"), bond["line"])

    def test_one_sisters_turn_is_not_anothers(self):
        self._turn(ai.else_chat, "Le four m'a lâché en pleine soirée, je rentre tard.")
        self.assertEqual(ph.bond("else", owner=self.OWNER)["days"], 1)
        self.assertEqual(ph.bond("transferania", owner=self.OWNER)["days"], 0)

    def test_a_short_exchange_can_form_the_link(self):
        ph.observe_chat("transferania", "Salut", now=time.time() - 86400, owner=self.OWNER)
        self._turn(ai.transferania_chat, "Salut")
        bond = self._panel("transferania")["bond"]
        self.assertEqual(bond["days"], 2, bond)
        self.assertTrue(bond["line"].startswith("LIEN AU MAÎTRE"), bond["line"])


class FamilyLifeTests(FamilyBase):
    """The house lets two assistants who never met run into each other on its own.

    A self-started exchange goes through the same generator and the same recorder
    a visit the Master opens uses: both her own visit log and the relationship row
    the panel reads must grow, and nothing is invented that a served visit would
    not also write.
    """

    def setUp(self):
        super().setUp()
        visits.bind(root=self.root, now=time.time, gemini_generate=lambda *a, **k: ("", "stub"))
        visits._reset_banter_limit()
        visits._family_inflight = False
        visits._family_retry_at = 0.0
        visits._family_recent = None
        self.addCleanup(setattr, visits, "_family_retry_at", 0.0)


    def _spoke(self, a, b, *, days_ago=0, kind="famille", at=None):
        rel.note_exchange(None, a, b, "Le four tient.", kind=kind,
                          now=(time.time() if at is None else at) - days_ago * DAY, owner="admin")

    def _stub_banter(self, first="Le four tient encore.", second="Il tiendra."):
        calls = []

        def fake(payload, *, owner_id=None):
            calls.append(dict(payload))
            host, visitor = payload["host"], payload["visitor"]
            return 200, {"ok": True, "provider": "gemini",
                         "lines": [{"who": host, "text": first},
                                   {"who": visitor, "text": second}]}

        self.addCleanup(setattr, visits, "banter", visits.banter)
        visits.banter = fake
        return calls

    def test_the_house_never_pairs_the_sisters_on_its_own(self):
        pairs = visits.family_pairs()
        n = len(visits.FAMILY_KEYS)
        self.assertEqual(len(pairs), n * (n - 1) // 2)   # 21 with Elsea
        for pair in pairs:
            self.assertNotIn("else", pair)
            self.assertNotIn("transferania", pair)

    def test_the_coldest_pair_comes_first(self):
        self._spoke("culinia", "forgia", days_ago=3)
        pick = visits.family_pick(owner_id="admin", now=time.time())
        self.assertTrue(pick["ok"], pick)
        self.assertNotEqual(pick["pair"], ("culinia", "forgia"))
        self.assertEqual(pick["days"], 0)

    def test_a_pair_is_still_recognised_when_its_key_sorts_the_other_way(self):
        self._spoke("musica", "inventoria", kind="famille")
        pick = visits.family_pick(owner_id="admin",
                                  now=time.time() + visits.FAMILY_GAP_S + 60)
        self.assertTrue(pick["ok"], pick)
        self.assertNotEqual(pick["pair"], ("musica", "inventoria"))

    def test_a_pair_that_already_spoke_today_is_left_alone(self):
        self._spoke("culinia", "forgia")
        pick = visits.family_pick(owner_id="admin", now=time.time() + visits.FAMILY_GAP_S + 5)
        self.assertTrue(pick["ok"], pick)
        self.assertNotEqual(pick["pair"], ("culinia", "forgia"))

    def test_every_pair_still_fits_in_one_day(self):
        # Read late in a day, the house's window would cross midnight and its
        # count would start over: seed the scenes just before the day ends.
        stamp = time.time()
        later = stamp + visits.FAMILY_GAP_S + 60
        if visits._today(later) != visits._today(stamp):
            end = datetime.combine(datetime.fromtimestamp(stamp).date(), clock_time.max).timestamp()
            later = end - 30
            stamp = later - visits.FAMILY_GAP_S - 60
        for pair in visits.family_pairs()[:-1]:
            self._spoke(*pair, kind="famille", at=stamp)
        self.assertTrue(visits.family_pick(owner_id="admin", now=later)["ok"])  # 14 scenes: still room
        self._spoke(*visits.family_pairs()[-1], kind="famille", at=stamp)
        self.assertEqual(visits.family_pick(owner_id="admin", now=later)["reason"], "daily_cap")

    def test_the_demo_knob_shortens_the_wait_but_defaults_to_twenty_minutes(self):
        self.assertEqual(visits._family_gap_s, float(visits.FAMILY_GAP_S))
        self._spoke("culinia", "forgia", kind="famille")
        self.assertEqual(visits.family_pick(owner_id="admin", now=time.time() + 60)["reason"], "gap")
        visits.bind(root=self.root, now=time.time, family_gap_s=2,
                    gemini_generate=lambda *args, **kwargs: (500, {}))
        self.assertTrue(visits.family_pick(owner_id="admin", now=time.time() + 5)["ok"])

    def test_the_house_waits_between_its_own_exchanges(self):
        self._spoke("culinia", "forgia")
        pick = visits.family_pick(owner_id="admin", now=time.time() + 30)
        self.assertFalse(pick["ok"])
        self.assertEqual(pick["reason"], "gap")
        self.assertGreater(pick["retry_after"], 0)

    def test_a_visit_the_master_opens_does_not_silence_the_house(self):
        for pair in visits.family_pairs():
            self._spoke(*pair, kind="visit")
        # Their day is the house's own: every pair met the Master's tab today,
        # and none of them has had its scene yet, so the rotation is still free.
        pick = visits.family_pick(owner_id="admin", now=time.time() + 30)
        self.assertTrue(pick["ok"], pick)

    def test_without_a_generator_the_house_stays_quiet(self):
        visits.bind(root=self.root, now=time.time)
        pick = visits.family_pick(owner_id="admin", now=time.time())
        self.assertFalse(pick["ok"])
        self.assertEqual(pick["reason"], "no_provider")

    def test_one_self_started_exchange_fills_both_rows_and_both_logs(self):
        calls = self._stub_banter()
        out = visits.family_turn(owner_id="admin")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["pair"], ["culinia", "elsea"])
        self.assertEqual(calls[0]["shape"], "flyby")
        for key, other in (("culinia", "elsea"), ("elsea", "culinia")):
            panel = ph.snapshot(key, owner="admin")
            row = next(r for r in panel["family"] if r["other"] == other)
            self.assertEqual(row["exchanges"], 1, key)
            self.assertEqual(row["days"], 1, key)
            # One day is a first exchange, not a rung: the panel prints no tier yet.
            self.assertEqual((row["tier"], row["tier_label"]), ("", ""), key)
            thread = next(r for r in panel["pair_threads"] if r["other"] == other)
            self.assertTrue(thread["thread"], key)
        pair = rel.pair(None, "culinia", "elsea", owner="admin")
        self.assertEqual((pair["days"], pair["exchanges"]), (1, 1))
        row = next(r for r in rel.pairs(None, owner="admin")
                   if (r["a"], r["b"]) == ("culinia", "elsea"))
        self.assertEqual(row["kind"], "famille")
        self.assertGreater(row["family_at"], 0)
        self.assertIn("four", visits._latest_context("culinia", "elsea", owner_id="admin")["thread"])

    def test_the_house_only_pairs_a_chip_the_view_can_show(self):
        pick = visits.family_pick(owner_id="admin", now=time.time(), visible=["musica"])
        self.assertTrue(pick["ok"], pick)
        self.assertIn("musica", pick["pair"])
        self.assertEqual(
            visits.family_pick(owner_id="admin", now=time.time(), visible=[])["reason"],
            "nothing_visible")

    def test_the_pulse_carries_the_house_visit_to_the_open_hq(self):
        self._stub_banter()
        out = visits.family_turn(owner_id="admin")
        self.assertTrue(out["ok"], out)
        code, payload = visits.pulse(owner_id="admin")
        self.assertEqual(code, 200)
        family = payload.get("family")
        self.assertIsNotNone(family, payload)
        self.assertEqual((family["host"], family["visitor"]), ("culinia", "elsea"))
        # The wire form a visit uses everywhere else: one line per side.
        self.assertEqual([line["who"] for line in family["lines"]], ["host", "visitor"])
        self.assertTrue(all(line["text"] for line in family["lines"]))
        self.assertGreater(family["at"], 0)

    def test_a_house_visit_is_not_replayed_once_it_is_old(self):
        self._stub_banter()
        out = visits.family_turn(owner_id="admin")
        self.assertTrue(out["ok"], out)
        recent = visits.family_recent()
        self.assertIsNotNone(recent)
        self.assertIsNone(visits.family_recent(now=recent["at"] + visits.FAMILY_SHOW_TTL_S + 1))

    def test_the_heartbeat_starts_one_exchange_and_never_waits(self):
        gate = threading.Event()
        started = []
        real = visits.family_turn
        self.addCleanup(setattr, visits, "family_turn", real)

        def slow(**kwargs):
            started.append(kwargs)
            gate.wait(5)
            return {"ok": True, "skipped": False}

        visits.family_turn = slow
        self.assertTrue(visits.maybe_start_family(owner_id="admin"))
        self.assertFalse(visits.maybe_start_family(owner_id="admin"))
        gate.set()
        deadline = time.time() + 2
        while visits._family_inflight and time.time() < deadline:
            time.sleep(0.01)
        self.assertFalse(visits._family_inflight)
        self.assertEqual(len(started), 1)

    def test_pulse_answers_even_when_the_house_cannot_speak(self):
        visits.bind(root=self.root, now=time.time)
        code, payload = visits.pulse(owner_id="admin")
        self.assertEqual(code, 200)
        self.assertTrue(payload["ok"])
        self.assertNotIn("family_started", payload)


class SameMessageTests(FamilyBase):
    """One Master sentence, two assistants: what they are told to say differs."""

    MESSAGE = "Le four m'a lâché en pleine soirée. Je n'ai pas envie de recommencer ce soir."

    def _compose(self, module):
        """Run the module's real chat path; only the network call is stubbed out."""
        from unittest import mock

        seen = []

        def fake(chain, system, contents, **kw):
            seen.append({"system": system, "contents": contents})
            return json.dumps({"reply": "ok", "tools": []}), "stub"

        with mock.patch.object(ai, "generate", side_effect=fake):
            module.chat(self.MESSAGE)
        self.assertTrue(seen, module.__name__ + " composed no prompt")
        return seen[0]

    def _establish_forgia(self):
        for age in (2 * DAY + 3600, DAY + 1800, 600):
            ph.observe_chat("forgia", "Le LoRA sort encore flou, on recommence le prompt.",
                            now=NOW - age, owner="admin")
        ph.record_event("forgia", kind="error", outcome="failed", text="le rendu est parti en fumée",
                        now=NOW - 240, owner="admin")
        for age in (3 * DAY, 2 * DAY, DAY + 60):
            rel.note_exchange(None, "forgia", "culinia", "Le pain du four a tenu la promesse.",
                              now=NOW - age, owner="admin")

    def test_the_same_message_gets_two_different_briefs(self):
        self._establish_forgia()
        culinia = self._compose(hq_culinia)
        forgia = self._compose(hq_forgia)
        self.assertNotEqual(culinia["system"], forgia["system"])
        for other, key in ((culinia, "culinia"), (forgia, "forgia")):
            system = other["system"]
            self.assertIn(hq_personas.voice_line(key), system, key)
            self.assertIn(hq_personas.opinion_line(key), system, key)
            self.assertIn(self.MESSAGE, json.dumps(other["contents"], ensure_ascii=False))
        for mine, theirs in ((culinia, "forgia"), (forgia, "culinia")):
            self.assertIn(hq_personas.voice_line("culinia" if theirs == "forgia" else "forgia"), mine["system"])
            self.assertNotIn(hq_personas.opinion_line(theirs), mine["system"])

    def test_history_reaches_only_the_assistant_that_lived_it(self):
        self._establish_forgia()
        culinia = self._compose(hq_culinia)["system"]
        forgia = self._compose(hq_forgia)["system"]
        self.assertIn("LIEN AU MAÎTRE", forgia)
        self.assertIn("ÉTAT INTERNE", forgia)
        self.assertIn("Familiarité avec Culinia", forgia)
        self.assertIn("Familiarité avec Forgia", culinia)   # the pair is shared evidence
        self.assertNotIn("LIEN AU MAÎTRE", culinia)
        self.assertNotIn("ÉTAT INTERNE", culinia)

    def test_the_same_assistant_speaks_differently_once_she_has_history(self):
        fresh = self._compose(hq_forgia)["system"]
        self._establish_forgia()
        seasoned = self._compose(hq_forgia)["system"]
        self.assertNotEqual(fresh, seasoned)
        self.assertNotIn("LIEN AU MAÎTRE", fresh)
        self.assertIn("LIEN AU MAÎTRE", seasoned)
        self.assertGreater(len(seasoned.encode("utf-8")), len(fresh.encode("utf-8")))


class SurfaceRenderTests(FamilyBase):
    """The panel draws two different real payloads with no error, in a real DOM."""

    def _payloads(self):
        for age in (2 * DAY + 3600, DAY + 1800, 600):
            ph.observe_chat("forgia", "Le LoRA sort encore flou.", now=NOW - age, owner="admin")
        for age in (3 * DAY, 2 * DAY, DAY + 60):
            rel.note_exchange(None, "forgia", "culinia", "Le pain du four a tenu la promesse.",
                              now=NOW - age, owner="admin")
        # A stamped day bucket is local: derive it exactly as note_exchange does, so
        # a run started just after midnight cannot fold two days into one.
        return {"culinia": ph.snapshot("culinia", owner="admin", now=NOW),
                "forgia": ph.snapshot("forgia", owner="admin", now=NOW)}

    def test_the_pair_echo_renders_where_two_hearts_met_real_evidence(self):
        import os
        import shutil
        import subprocess
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        # Both women have really spent days with the Master, and the pair has met.
        for age in (DAY + 3600, 900):
            ph.observe_chat("forgia", "Le four tient.", now=NOW - age, owner="admin")
            ph.observe_chat("culinia", "La soupe tient.", now=NOW - age, owner="admin")
        for age in (2 * DAY, DAY + 60):
            rel.note_exchange(None, "forgia", "culinia", "Le pain du four a tenu la promesse.",
                              now=NOW - age, owner="admin")
        payloads = {"culinia": ph.snapshot("culinia", owner="admin", now=NOW),
                    "forgia": ph.snapshot("forgia", owner="admin", now=NOW)}
        pair = next(row for row in payloads["forgia"]["family"] if row["other"] == "culinia")
        self.assertTrue(pair["echo"], pair)
        self.assertIn("Écho non dit", pair["echo"])
        for key, payload in payloads.items():
            for row in payload["family"]:
                if {key, row["other"]} == {"culinia", "forgia"}:
                    continue
                self.assertEqual(row["echo"], "", f"{key}|{row['other']} claims an echo it has not earned")
        # The same shared secret has a prompt side, and each woman carries her own
        # side of it: neither line names it, and the two are not the same line.
        culinia_prompt = voice.block("culinia")
        forgia_prompt = voice.block("forgia")
        self.assertIn("ÉCHO — avec Forgia", culinia_prompt)
        self.assertIn("ÉCHO — avec Culinia", forgia_prompt)
        self.assertIn(hq_personas.get("culinia")["heart"]["echo"], culinia_prompt)
        self.assertIn(hq_personas.get("forgia")["heart"]["echo"], forgia_prompt)
        self.assertNotIn(hq_personas.get("forgia")["heart"]["echo"], culinia_prompt)
        self.assertNotIn(hq_personas.get("culinia")["heart"]["want"], culinia_prompt)
        self.assertNotIn("ÉCHO — avec", voice.block("musica"), "a heartless pair carries no echo")
        # The addressee is derived from the situation, and only a pair that shares
        # the secret is told who is speaking to it.
        self.assertIn("INTERLOCUTRICE : Forgia", voice.addressee_line("culinia", "forgia"))
        self.assertEqual(voice.addressee_line("culinia", "musica"), "")
        self.assertEqual(voice.addressee_line("forgia", "culinia").count("INTERLOCUTRICE"), 1)
        fixtures = Path(self.tmp.name) / "personhood-echo.json"
        fixtures.write_text(json.dumps(payloads, ensure_ascii=False), encoding="utf-8")
        script = Path(__file__).with_name("check_personhood_panel.mjs")
        result = subprocess.run([node, str(script)], capture_output=True, text=True, timeout=60,
                                env={**os.environ, "HQ_PERSONHOOD_FIXTURES": str(fixtures)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("personhood panel: OK", result.stdout)

    def test_two_histories_render_as_two_different_panels(self):
        import shutil
        import subprocess

        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        payloads = self._payloads()
        self.assertEqual(payloads["culinia"]["bond"]["days"], 0)
        self.assertGreaterEqual(payloads["forgia"]["bond"]["days"], 3)
        self.assertGreater(len(payloads["forgia"]["voice"]["card"]), 0)
        self.assertNotEqual(payloads["culinia"]["bond"]["line"], payloads["forgia"]["bond"]["line"])
        fixtures = Path(self.tmp.name) / "personhood-fixtures.json"
        fixtures.write_text(json.dumps(payloads, ensure_ascii=False), encoding="utf-8")
        script = Path(__file__).with_name("check_personhood_panel.mjs")
        result = subprocess.run([node, str(script)], capture_output=True, text=True, timeout=60,
                                env={**__import__("os").environ, "HQ_PERSONHOOD_FIXTURES": str(fixtures)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("personhood panel: OK", result.stdout)


if __name__ == "__main__":
    unittest.main()
