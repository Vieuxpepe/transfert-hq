"""Else chip: separate memory store + thread, shared context assembly."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import hq_ai as ai
import hq_companion_memory as mem

DEV = "device-else-chip-01"


class ElseMemoryScope(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-else-")
        root = Path(self.tmp.name)
        ai.bind(root=root, now=lambda: 1_700_000_000.0, key=lambda: "test-key")
        mem.bind(root=root, now=lambda: 1_700_000_000.0)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_memory_paths_are_partitioned(self) -> None:
        token = mem._owner.set("admin")
        try:
            transfer_path = mem.path()
            with mem.memory_scope("else"):
                else_path = mem.path()
            self.assertNotEqual(transfer_path, else_path)
            self.assertIn("else", str(else_path).replace("\\", "/"))
            self.assertNotIn("/else/", str(transfer_path).replace("\\", "/"))
        finally:
            mem._owner.reset(token)

    def test_else_thread_is_separate_from_transferania(self) -> None:
        token = mem._owner.set("admin")
        try:
            ai.save_transferania({"v": 1, "summary": "t", "messages": [{"role": "user", "text": "hi-t", "ts": 1}], "facts": [], "recent_replies": [], "open_thread": ""}, DEV)
            ai.save_else({"v": 1, "summary": "e", "messages": [{"role": "user", "text": "hi-e", "ts": 1}], "facts": [], "recent_replies": [], "open_thread": ""}, DEV)
            self.assertEqual(ai.load_transferania(DEV)["summary"], "t")
            self.assertEqual(ai.load_else(DEV)["summary"], "e")
            self.assertNotEqual(ai._thread_path(DEV), ai._else_thread_path(DEV))
        finally:
            mem._owner.reset(token)

    def test_else_system_names_else_not_transferania_sheet(self) -> None:
        token = mem._owner.set("admin")
        try:
            with mem.memory_scope("else"):
                system = ai.build_else_system("chat", "warm", nsfw=False, view="accueil", device_id=DEV, context_core=True)
            self.assertTrue(system.startswith("Tu es Else"))
            self.assertNotIn("Tu es Transferania", system)
            self.assertIn("FICHE ELSE", system)
            self.assertIn("obsidienne", system.lower())
            self.assertIn("machine-wife", system.lower())
            self.assertNotIn("FICHE TRANSFERANIA", system)
            self.assertIn("puce", system.lower())
            sister = ai.build_sister_system("else", nsfw=False, view="accueil", device_id=DEV)
            self.assertTrue(sister.startswith("Tu es Else"))
            self.assertIn("FICHE ELSE", sister)
            self.assertLess(len(sister), len(system))
        finally:
            mem._owner.reset(token)

    def test_else_handoff_digest_is_evidence_only(self) -> None:
        import hq_else_handoff as handoff
        token = mem._owner.set("admin")
        try:
            with mem.memory_scope("else"):
                ai.save_else({
                    "v": 1,
                    "summary": "Il aime le thé matcha sur HQ.",
                    "messages": [
                        {"role": "user", "text": "J'aime le matcha", "ts": 1},
                        {"role": "assistant", "text": "Noté, Maître.", "ts": 2, "kind": "chat"},
                    ],
                    "facts": [],
                    "recent_replies": [],
                    "open_thread": "",
                }, DEV)
            digest = handoff.build_digest(device_id=DEV, owner="admin")
            self.assertEqual(digest["source"], "transfert_hq")
            self.assertTrue(digest["content_hash"])
            self.assertTrue(any("matcha" in b.lower() for b in digest["bullets"]))
            self.assertTrue(all(b.startswith("On Transfert HQ") for b in digest["bullets"]))
            dry = handoff.export_else_handoff(device_id=DEV, owner="admin", dry_run=True)
            self.assertTrue(dry["dry_run"])
            self.assertFalse(dry["wrote"])
            tmp = Path(ai._cb["root"]) / "gemini-out"
            out = handoff.write_digest(digest, gemini_root=tmp)
            self.assertTrue(Path(out["path"]).is_file())
            loaded = json.loads(Path(out["path"]).read_text(encoding="utf-8"))
            self.assertEqual(loaded["content_hash"], digest["content_hash"])
            with self.assertRaises(ValueError):
                handoff.write_digest(digest, gemini_root=Path(ai._cb["root"]))
            self.assertIsNone(handoff.maybe_export_after_chat(device_id=DEV, owner="admin"))
        finally:
            mem._owner.reset(token)

    def test_else_handoff_empty_when_no_thread(self) -> None:
        import hq_else_handoff as handoff
        digest = handoff.build_digest(device_id=None, owner="admin")
        self.assertTrue(digest["empty"])
        self.assertEqual(digest["bullets"], [])
        self.assertEqual(digest["source"], "transfert_hq")


    def test_else_send_persists_in_else_thread_and_memory(self) -> None:
        token = mem._owner.set("admin")
        try:
            with mock.patch.object(ai, "generate", return_value=("Noté, Maître.", "gemini-3.1-flash-lite")), \
                 mock.patch.object(ai, "_api_keys", return_value=["k"]), \
                 mock.patch.object(ai, "transferania_ok", return_value=True), \
                 mock.patch.object(ai, "nsfw_allowed", return_value=False), \
                 mock.patch.object(ai, "hq_live_lookup_block", return_value=("", [])), \
                 mock.patch.object(ai, "_life_begin", return_value={"mood": 0}), \
                 mock.patch.object(ai.hq_life, "time_block", return_value="TEMPS (vrai) : maintenant"):
                code, out = ai.http_post(
                    {"action": "else", "op": "send", "message": "J'aime le thé matcha", "view": "accueil", "persona": "warm", "device_id": DEV},
                    role="admin",
                    owner_id="admin",
                )
            self.assertEqual(code, 200, out)
            self.assertTrue(out.get("ok"))
            self.assertEqual(out.get("character"), "else")
            self.assertEqual(out.get("name"), ai.ELSE_NAME)
            thread = ai.load_else(DEV)
            texts = [m.get("text") for m in thread.get("messages") or []]
            self.assertIn("J'aime le thé matcha", texts)
            self.assertTrue(any("Noté" in str(t) for t in texts))
            asst = next(m for m in (thread.get("messages") or []) if m.get("role") == "assistant")
            self.assertEqual(asst.get("model"), "gemini-3.1-flash-lite")
            self.assertEqual(asst.get("model_label"), ai.MODELS["gemini-3.1-flash-lite"][0])
            pub = next(m for m in (out.get("messages") or []) if m.get("role") == "assistant")
            self.assertEqual(pub.get("model"), "gemini-3.1-flash-lite")
            self.assertEqual((out.get("meter") or {}).get("favor"), "else")
            self.assertTrue((out.get("meter") or {}).get("tease"))
            # Else memory file should exist under companion-memory/else/
            else_mem = Path(ai._cb["root"]) / ".hq-ai" / "companion-memory" / "else"
            self.assertTrue(else_mem.is_dir())
            self.assertTrue(any(else_mem.glob("*.json")))
        finally:
            mem._owner.reset(token)

    def test_else_chat_awareness_does_not_write_transferania_memory(self) -> None:
        token = mem._owner.set("admin")
        try:
            import hq_sister as sister
            now = sister._now()
            sister.save_dialogue({
                "v": 1,
                "topic": "pont",
                "messages": [
                    {"speaker": "transferania", "text": "Else, tu m'écoutes ?", "ts": now - 5},
                    {"speaker": "else", "text": "Oui.", "ts": now - 1},
                ],
                "last_ambient_at": 0.0,
                "last_react_at": 0.0,
            }, DEV)
            block = ai.sister_awareness_block(DEV, "else")
            self.assertIn("Transferania", block)
            with mock.patch.object(ai, "generate", return_value=("Compris.", "gemini-3.1-flash-lite")), \
                 mock.patch.object(ai, "_api_keys", return_value=["k"]), \
                 mock.patch.object(ai, "transferania_ok", return_value=True), \
                 mock.patch.object(ai, "nsfw_allowed", return_value=False), \
                 mock.patch.object(ai, "hq_live_lookup_block", return_value=("", [])), \
                 mock.patch.object(ai, "_life_begin", return_value={"mood": 0}), \
                 mock.patch.object(ai.hq_life, "time_block", return_value="TEMPS (vrai) : maintenant"):
                code, out = ai.http_post(
                    {"action": "else", "op": "send", "message": "Salut", "view": "accueil", "persona": "warm", "device_id": DEV},
                    role="admin",
                    owner_id="admin",
                )
            self.assertEqual(code, 200, out)
            # Transferania memory partition stays empty of Else chat episodes
            with mem.memory_scope("transferania"):
                snap_t = mem.snapshot()
            with mem.memory_scope("else"):
                snap_e = mem.snapshot()
            self.assertFalse(any("Salut" in (e.get("text") or "") for e in (snap_t.get("episodes") or [])))
            # Else thread got the turn; Transferania thread untouched
            self.assertTrue(any(m.get("text") == "Salut" for m in (ai.load_else(DEV).get("messages") or [])))
            t_msgs = ai.load_transferania(DEV).get("messages") or []
            self.assertFalse(any(m.get("text") == "Salut" for m in t_msgs))
            self.assertIsNotNone(snap_e)
        finally:
            mem._owner.reset(token)

    def test_else_ambient_soft_and_cooldown(self) -> None:
        token = mem._owner.set("admin")
        try:
            with mock.patch.object(ai, "_api_keys", return_value=["k"]), \
                 mock.patch.object(ai, "ambient_ok", return_value=False), \
                 mock.patch.object(ai, "nsfw_allowed", return_value=False):
                code, out = ai.http_post(
                    {"action": "else", "op": "ambient", "view": "accueil", "device_id": DEV},
                    role="admin",
                    owner_id="admin",
                )
            self.assertEqual(code, 200, out)
            self.assertTrue(out.get("ok"))
            self.assertTrue(out.get("ambient"))
            self.assertTrue(out.get("fallback"))
            self.assertTrue(out.get("line"))
            self.assertTrue(any(m.get("kind") == "ambient" for m in (ai.load_else(DEV).get("messages") or [])))
            with mock.patch.object(ai, "_api_keys", return_value=["k"]), \
                 mock.patch.object(ai, "ambient_ok", return_value=False), \
                 mock.patch.object(ai, "nsfw_allowed", return_value=False):
                code2, out2 = ai.http_post(
                    {"action": "else", "op": "ambient", "view": "accueil", "device_id": DEV},
                    role="admin",
                    owner_id="admin",
                )
            self.assertEqual(code2, 200, out2)
            self.assertTrue(out2.get("skipped"))
            self.assertEqual(out2.get("reason"), "cooldown")
        finally:
            mem._owner.reset(token)

    def test_else_voice_op_returns_structured_payload(self) -> None:
        token = mem._owner.set("admin")
        try:
            import hq_voice
            with mock.patch.object(hq_voice, "synthesize", return_value={
                "ok": True,
                "audio_url": "/assets/companion/chat/voice_cache/else-test.wav",
                "engine": "test",
                "delivery": "thoughtful",
                "text": "Bonjour",
            }):
                code, out = ai.http_post(
                    {"action": "else", "op": "voice", "text": "Bonjour Maître", "device_id": DEV},
                    role="admin",
                    owner_id="admin",
                )
            self.assertEqual(code, 200, out)
            self.assertTrue(out.get("ok"))
            self.assertTrue(out.get("quiet"))
            self.assertEqual(out.get("character"), "else")
            self.assertIn("audio_url", out)
        finally:
            mem._owner.reset(token)

    def test_else_prefs_cadence_voice_and_address(self) -> None:
        token = mem._owner.set("admin")
        try:
            code, out = ai.http_post(
                {
                    "action": "else",
                    "op": "prefs",
                    "save": True,
                    "prefs": {
                        "else_proactive": True,
                        "else_proactive_cadence": "often",
                        "else_voice": True,
                        "else_address": "vous",
                        "else_topics_off": ["politique"],
                    },
                    "device_id": DEV,
                },
                role="admin",
                owner_id="admin",
            )
            self.assertEqual(code, 200, out)
            prefs = out.get("prefs") or {}
            self.assertEqual(prefs.get("else_proactive_cadence"), "often")
            self.assertTrue(prefs.get("else_voice"))
            self.assertEqual(prefs.get("else_address"), "vous")
            self.assertEqual(prefs.get("else_topics_off"), ["politique"])
            loaded = ai.load_transferania_prefs(DEV)
            self.assertEqual(loaded.get("else_proactive_cadence"), "often")
            self.assertEqual(ai.ELSE_CADENCE_COOLDOWN_S["often"], 7 * 60)
        finally:
            mem._owner.reset(token)

    def test_else_memory_remember_and_forget(self) -> None:
        token = mem._owner.set("admin")
        try:
            code, out = ai.http_post(
                {"action": "else", "op": "memory_remember", "text": "Il préfère le matcha le soir", "device_id": DEV},
                role="admin",
                owner_id="admin",
            )
            self.assertEqual(code, 200, out)
            self.assertTrue(out.get("remembered"))
            mems = out.get("memories") or []
            self.assertTrue(any("matcha" in (m.get("text") or "").lower() for m in mems))
            hit = next(m for m in mems if "matcha" in (m.get("text") or "").lower())
            code2, out2 = ai.http_post(
                {"action": "else", "op": "memory_forget", "id": hit["id"], "device_id": DEV},
                role="admin",
                owner_id="admin",
            )
            self.assertEqual(code2, 200, out2)
            remaining = out2.get("memories") or []
            self.assertFalse(any(m.get("id") == hit["id"] for m in remaining))
        finally:
            mem._owner.reset(token)

    def test_else_handoff_includes_view_trail_and_meter(self) -> None:
        import hq_else_handoff as handoff
        import hq_sister as sister
        token = mem._owner.set("admin")
        try:
            with mem.memory_scope("else"):
                ai.save_else({
                    "v": 1,
                    "summary": "Travail HQ en cours.",
                    "messages": [
                        {"role": "user", "text": "Ouvre le carnet", "ts": 10, "view": "carnet"},
                        {"role": "assistant", "text": "Carnet prêt.", "ts": 11, "view": "carnet", "kind": "chat"},
                        {"role": "user", "text": "Retour accueil", "ts": 20, "view": "accueil"},
                        {"role": "assistant", "text": "Accueil.", "ts": 21, "view": "accueil", "kind": "chat"},
                    ],
                    "facts": [],
                    "recent_replies": [],
                    "open_thread": "",
                }, DEV)
            sister.save_dialogue({
                "v": 1,
                "topic": "attention",
                "open_thread": "qui a le dernier mot",
                "messages": [
                    {"speaker": "else", "text": "Je reste calme.", "ts": 15},
                    {"speaker": "transferania", "text": "Moi j'y vais.", "ts": 16},
                ],
                "last_ambient_at": 0.0,
                "last_react_at": 0.0,
            }, DEV)
            digest = handoff.build_digest(device_id=DEV, owner="admin")
            self.assertIn("carnet", digest.get("view_trail") or [])
            self.assertIn("accueil", digest.get("view_trail") or [])
            self.assertTrue(any("recent views" in b.lower() for b in digest["bullets"]))
            self.assertTrue(digest.get("open_thread"))
            self.assertTrue(any("open sister thread" in b.lower() for b in digest["bullets"]))
            self.assertTrue((digest.get("meter") or {}).get("tease"))
            self.assertTrue(any("attention tease" in b.lower() for b in digest["bullets"]))
        finally:
            mem._owner.reset(token)


if __name__ == "__main__":
    unittest.main()
