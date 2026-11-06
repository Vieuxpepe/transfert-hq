"""Master-triggered sister dialogue: separate log, partitioned memories."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import hq_ai as ai
import hq_companion_memory as mem
import hq_sister as sister

DEV = "device-sister-dlg-01"


class SisterDialogue(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-sister-")
        root = Path(self.tmp.name)
        ai.bind(root=root, now=lambda: 1_700_000_100.0, key=lambda: "test-key")
        mem.bind(root=root, now=lambda: 1_700_000_100.0)
        self.owner = mem._owner.set("admin")

    def tearDown(self) -> None:
        mem._owner.reset(self.owner)
        self.tmp.cleanup()

    def test_exchange_alternates_and_logs(self) -> None:
        lines = iter(["Hé Else, tu surveilles le pont ?", "Oui — le pont est stable, Transferania."])

        def fake_generate(*_a, **_k):
            return next(lines), "gemini-3.1-flash-lite"

        with mock.patch.object(ai, "generate", side_effect=fake_generate), \
             mock.patch.object(ai, "_api_keys", return_value=["k"]), \
             mock.patch.object(ai, "transferania_ok", return_value=True), \
             mock.patch.object(ai, "nsfw_allowed", return_value=False):
            code, out = ai.http_post(
                {"action": "sister", "op": "exchange", "topic": "le pont", "turns": 2, "view": "accueil", "device_id": DEV},
                role="admin",
                owner_id="admin",
            )
        self.assertEqual(code, 200, out)
        self.assertTrue(out.get("ok"))
        turns = out.get("turns") or []
        self.assertEqual(len(turns), 2)
        self.assertEqual(turns[0]["speaker"], "transferania")
        self.assertEqual(turns[1]["speaker"], "else")
        hist = ai.sister_history(device_id=DEV)
        speakers = [m["speaker"] for m in hist["messages"] if m.get("speaker") != "master"]
        self.assertEqual(speakers[-2:], ["transferania", "else"])
        with mem.memory_scope("transferania"):
            snap_t = mem.snapshot()
        with mem.memory_scope("else"):
            snap_e = mem.snapshot()
        self.assertTrue(any("dialogue sœurs" in (e.get("text") or "") for e in (snap_t.get("episodes") or [])))
        self.assertTrue(any("dialogue sœurs" in (e.get("text") or "") for e in (snap_e.get("episodes") or [])))

    def test_ambient_picks_seed_and_respects_cooldown(self) -> None:
        lines = iter(["Else, t'as vu l'heure ?", "Oui — on respire un peu."])

        def fake_generate(*_a, **_k):
            return next(lines), "gemini-3.1-flash-lite"

        # Force situation seed (no named event) so turn bias stays deterministic for this test.
        with mock.patch.object(ai, "generate", side_effect=fake_generate), \
             mock.patch.object(ai, "_api_keys", return_value=["k"]), \
             mock.patch.object(ai, "transferania_ok", return_value=True), \
             mock.patch.object(ai, "nsfw_allowed", return_value=False), \
             mock.patch.object(sister, "pick_sister_event", return_value=None), \
             mock.patch.object(sister, "_ambient_turn_count", return_value=2):
            code, out = ai.http_post(
                {"action": "sister", "op": "ambient", "turns": 2, "view": "accueil", "device_id": DEV},
                role="admin",
                owner_id="admin",
            )
            self.assertEqual(code, 200, out)
            self.assertTrue(out.get("ok"))
            self.assertTrue(out.get("ambient"))
            self.assertEqual(len(out.get("turns") or []), 2)
            self.assertTrue(out.get("topic"))
            code2, out2 = ai.http_post(
                {"action": "sister", "op": "ambient", "device_id": DEV},
                role="admin",
                owner_id="admin",
            )
        self.assertEqual(code2, 200, out2)
        self.assertTrue(out2.get("skipped"))
        self.assertEqual(out2.get("reason"), "cooldown")

    def test_awareness_block_is_read_only_and_scoped(self) -> None:
        now = sister._now()
        data = sister.empty_dialogue()
        data["messages"] = [
            {"speaker": "master", "text": "sujet", "ts": now - 10},
            {"speaker": "transferania", "text": "Else, tu es là ?", "ts": now - 5},
            {"speaker": "else", "text": "Toujours, près du pont.", "ts": now - 1},
        ]
        sister.save_dialogue(data, DEV)
        block_t = sister.awareness_block(DEV, for_character="transferania")
        block_e = sister.awareness_block(DEV, for_character="else")
        self.assertIn("SŒUR PRÉSENTE", block_t)
        self.assertIn("Else", block_t)
        self.assertIn("Toujours", block_t)
        self.assertIn("Transferania", block_e)
        self.assertEqual(sister.awareness_block(DEV, for_character="nobody"), "")
        # Awareness must not create Transferania thread/memory writes
        self.assertFalse((Path(ai._cb["root"]) / ".hq-ai" / "threads" / f"{DEV}.json").exists())
        stale = sister.empty_dialogue()
        stale["messages"] = [
            {"speaker": "else", "text": "Vieille réplique.", "ts": now - sister.OPEN_THREAD_TTL_S - 60},
        ]
        sister.save_dialogue(stale, DEV)
        self.assertEqual(sister.awareness_block(DEV, for_character="transferania"), "")

    def test_react_and_cooldown(self) -> None:
        with mock.patch.object(ai, "generate", return_value=("Je t'ai entendue.", "gemini-3.1-flash-lite")), \
             mock.patch.object(ai, "_api_keys", return_value=["k"]), \
             mock.patch.object(ai, "transferania_ok", return_value=True), \
             mock.patch.object(ai, "nsfw_allowed", return_value=False):
            code, out = ai.http_post(
                {"action": "sister", "op": "react", "trigger": "Le pont tient.", "speaker": "else", "device_id": DEV},
                role="admin",
                owner_id="admin",
            )
            self.assertEqual(code, 200, out)
            self.assertTrue(out.get("ok"))
            self.assertTrue(out.get("react"))
            self.assertEqual((out.get("turns") or [{}])[0].get("speaker"), "else")
            code2, out2 = ai.http_post(
                {"action": "sister", "op": "react", "trigger": "Encore.", "speaker": "else", "device_id": DEV},
                role="admin",
                owner_id="admin",
            )
        self.assertEqual(code2, 200, out2)
        self.assertTrue(out2.get("skipped"))
        self.assertEqual(out2.get("reason"), "cooldown")

    def test_prefs_disable_ambient(self) -> None:
        sister.save_sister_prefs({"sister_ambient_enabled": False}, DEV)
        prefs = sister.sister_prefs(DEV)
        self.assertFalse(prefs["sister_ambient_enabled"])
        with mock.patch.object(ai, "generate", return_value=("x", "gemini-3.1-flash-lite")), \
             mock.patch.object(ai, "_api_keys", return_value=["k"]), \
             mock.patch.object(ai, "transferania_ok", return_value=True), \
             mock.patch.object(ai, "nsfw_allowed", return_value=False):
            code, out = ai.http_post(
                {"action": "sister", "op": "ambient", "device_id": DEV},
                role="admin",
                owner_id="admin",
            )
        self.assertEqual(code, 200, out)
        self.assertTrue(out.get("skipped"))
        self.assertEqual(out.get("reason"), "disabled")

    def test_status_includes_sister_fields(self) -> None:
        st = ai.status(role="admin", device_id=DEV)
        self.assertIn("sister", st)
        self.assertIn("else", st)
        self.assertEqual(st["else"]["name"], ai.ELSE_NAME)
        self.assertTrue(st["sister"]["ambient_enabled"])

    def test_maybe_sister_cue_not_always_on_integer_clock(self) -> None:
        hits = 0
        for i in range(400):
            with mock.patch.object(sister, "_now", return_value=float(1_700_000_000 + i)):
                if sister.maybe_sister_cue(idle=True):
                    hits += 1
        self.assertGreater(hits, 5)
        self.assertLess(hits, 50)
        self.assertFalse(sister.maybe_sister_cue(idle=False))

    def test_should_sister_cue_quality_gates(self) -> None:
        self.assertFalse(sister.should_sister_cue(idle=False, line="Else est là près du pont"))
        self.assertFalse(sister.should_sister_cue(idle=True, line="court", nsfw=False, fallback=False))
        self.assertFalse(sister.should_sister_cue(idle=True, line="Else est là près du pont", nsfw=True))
        self.assertFalse(sister.should_sister_cue(idle=True, line="Else est là près du pont", fallback=True))
        self.assertFalse(sister.should_sister_cue(idle=True, line="Else est là près du pont", has_event=True))
        # Sisterly mention while idle/addressable → yes
        self.assertTrue(sister.should_sister_cue(idle=True, line="Else est là près du pont, Maître", device_id=DEV))
        sister.save_sister_prefs({"sister_react_enabled": False}, DEV)
        self.assertFalse(sister.should_sister_cue(idle=True, line="Else est là près du pont", device_id=DEV))

    def test_ambient_turn_bias_and_situation_seed(self) -> None:
        hits = 0
        for i in range(40):
            with mock.patch.object(sister, "_now", return_value=float(1_700_000_100 + i * 0.3)):
                if sister._ambient_turn_count(2) == 1:
                    hits += 1
        self.assertGreaterEqual(hits, 20)
        data = sister.empty_dialogue()
        seed = sister._situation_seed("forge", "", data)
        self.assertTrue(seed)
        self.assertRegex(seed.lower(), r"forge|stock|projet|étincelle")
        data["open_thread"] = "taquinerie sur la Forge"
        data["open_thread_until"] = 1_700_000_100 + sister.OPEN_THREAD_TTL_S
        with mock.patch.object(sister, "_now", return_value=1_700_000_100.0):
            cont = sister._situation_seed("accueil", "", data)
        self.assertIn("reprendre le fil", cont)
        self.assertIn("Forge", cont)

    def test_sister_events_respect_open_thread_and_recent(self) -> None:
        data = sister.empty_dialogue()
        with mock.patch.object(sister, "_now", return_value=1_700_000_100.0):
            ev = sister.pick_sister_event(data, view="accueil", force=True)
        self.assertIsNotNone(ev)
        self.assertIn("id", ev)
        self.assertTrue(str(ev.get("seed") or "").startswith("mini-événement"))
        sister._remember_event(data, ev)
        self.assertEqual(data["last_event_id"], ev["id"])
        self.assertIn(ev["id"], data["recent_event_ids"])
        # Same id should not reappear while still in recent list when forced.
        with mock.patch.object(sister, "_now", return_value=1_700_000_101.0):
            ev2 = sister.pick_sister_event(data, view="accueil", force=True)
        self.assertIsNotNone(ev2)
        self.assertNotEqual(ev2["id"], ev["id"])
        # Open fil blocks events entirely.
        data["open_thread"] = "fil ouvert test"
        data["open_thread_until"] = 1_700_000_100 + sister.OPEN_THREAD_TTL_S
        with mock.patch.object(sister, "_now", return_value=1_700_000_100.0):
            self.assertIsNone(sister.pick_sister_event(data, view="accueil", force=True))
            seed, picked = sister._pick_ambient_seed(data, view="accueil")
        self.assertIn("reprendre le fil", seed)
        self.assertIsNone(picked)
        self.assertEqual(sister._ambient_turn_count(2, event={"turns": 2}), 2)
        self.assertEqual(sister._ambient_turn_count(2, event={"turns": 1}), 1)

    def test_nudge_soft_and_escalate_followup(self) -> None:
        with mock.patch.object(sister, "_now", return_value=1_700_000_100.0):
            soft = sister.nudge(toward="else", escalate=False, device_id=DEV)
        self.assertTrue(soft.get("ok"))
        self.assertTrue(soft.get("soft"))
        self.assertEqual(soft.get("toward"), "else")
        self.assertTrue((soft.get("peek") or {}).get("text"))
        self.assertEqual((soft.get("glance") or {}).get("to"), "transferania")
        # Soft spam is cooled down.
        with mock.patch.object(sister, "_now", return_value=1_700_000_110.0):
            cooled = sister.nudge(toward="else", escalate=False, device_id=DEV)
        self.assertTrue(cooled.get("skipped"))
        self.assertEqual(cooled.get("reason"), "cooldown")

        lines = iter(["Else — il nous pousse encore.", "Je sais."])

        def fake_generate(*_a, **_k):
            return next(lines), "gemini-3.1-flash-lite"

        with mock.patch.object(ai, "generate", side_effect=fake_generate), \
             mock.patch.object(ai, "_api_keys", return_value=["k"]), \
             mock.patch.object(ai, "transferania_ok", return_value=True), \
             mock.patch.object(ai, "nsfw_allowed", return_value=False), \
             mock.patch.object(sister, "pick_sister_event", return_value=None), \
             mock.patch.object(sister, "_ambient_turn_count", return_value=1), \
             mock.patch.object(sister, "_now", return_value=1_700_000_108.0):
            code, out = ai.http_post(
                {"action": "sister", "op": "nudge", "toward": "else", "escalate": True, "device_id": DEV},
                role="admin",
                owner_id="admin",
            )
        self.assertEqual(code, 200, out)
        self.assertTrue(out.get("ok"))
        self.assertTrue(out.get("escalate"))
        self.assertTrue(out.get("turns"))

    def test_should_pass_ball_gates(self) -> None:
        self.assertFalse(sister.should_pass_ball(ambient=False, turns=[{"speaker": "else", "text": "x" * 20}]))
        self.assertFalse(sister.should_pass_ball(ambient=True, turns=[]))
        hits = 0
        for i in range(40):
            with mock.patch.object(sister, "_now", return_value=float(1_700_000_100 + i * 0.4)):
                if sister.should_pass_ball(
                    ambient=True,
                    turns=[{"speaker": "else", "text": "ligne assez longue"}],
                    event={"id": "favor_tease"},
                ):
                    hits += 1
        self.assertGreater(hits, 5)
        self.assertLess(hits, 35)

    def test_ambient_emits_event_metadata(self) -> None:
        lines = iter(["Else, et si on lui volait un regard ?", "Discret. Mais oui."])

        def fake_generate(*_a, **_k):
            return next(lines), "gemini-3.1-flash-lite"

        forced = {
            "id": "favor_tease",
            "kind": "compete",
            "label": "faveur",
            "weight": 3,
            "turns": 2,
            "seed": "mini-événement : qui a la faveur du Maître en ce moment — taquinerie légère, sans drama",
        }
        with mock.patch.object(ai, "generate", side_effect=fake_generate), \
             mock.patch.object(ai, "_api_keys", return_value=["k"]), \
             mock.patch.object(ai, "transferania_ok", return_value=True), \
             mock.patch.object(ai, "nsfw_allowed", return_value=False), \
             mock.patch.object(sister, "pick_sister_event", return_value=forced):
            code, out = ai.http_post(
                {"action": "sister", "op": "ambient", "turns": 2, "view": "accueil", "device_id": DEV},
                role="admin",
                owner_id="admin",
            )
        self.assertEqual(code, 200, out)
        self.assertTrue(out.get("ok"))
        self.assertEqual((out.get("event") or {}).get("id"), "favor_tease")
        self.assertEqual((out.get("event") or {}).get("kind"), "compete")
        self.assertIn("mini-événement", out.get("topic") or "")
        self.assertEqual(len(out.get("turns") or []), 2)
        snap = sister.status_snapshot(DEV)
        self.assertEqual(snap.get("last_event_id"), "favor_tease")

    def test_dialogue_cache_avoids_reread(self) -> None:
        sister._cache_clear()
        sister.save_dialogue({
            "v": 1, "topic": "x", "messages": [{"speaker": "else", "text": "hi", "ts": sister._now()}],
            "last_ambient_at": 0.0, "last_react_at": 0.0, "open_thread": "", "open_thread_until": 0.0, "last_speaker": "else",
        }, DEV)
        reads = {"n": 0}
        real_read = Path.read_text

        def counting_read(self, *a, **k):
            if "sister_dialogue" in str(self).replace("\\", "/"):
                reads["n"] += 1
            return real_read(self, *a, **k)

        with mock.patch.object(Path, "read_text", counting_read):
            sister._cache_clear(DEV)
            a = sister.load_dialogue(DEV)
            b = sister.load_dialogue(DEV)
            c = sister.awareness_block(DEV, for_character="else")
        self.assertEqual(a["topic"], "x")
        self.assertEqual(b["topic"], "x")
        self.assertIn("Else", c)
        self.assertEqual(reads["n"], 1)

    def test_react_aside_flag(self) -> None:
        with mock.patch.object(ai, "generate", return_value=("Elle force un peu.", "gemini-3.1-flash-lite")), \
             mock.patch.object(ai, "_api_keys", return_value=["k"]), \
             mock.patch.object(ai, "transferania_ok", return_value=True), \
             mock.patch.object(ai, "nsfw_allowed", return_value=False):
            code, out = ai.http_post(
                {"action": "sister", "op": "react", "trigger": "Le pont tient bien ce soir.",
                 "speaker": "else", "aside": True, "device_id": DEV},
                role="admin",
                owner_id="admin",
            )
        self.assertEqual(code, 200, out)
        self.assertTrue(out.get("aside"))
        self.assertEqual((out.get("turns") or [{}])[0].get("aside"), True)


if __name__ == "__main__":
    unittest.main()
