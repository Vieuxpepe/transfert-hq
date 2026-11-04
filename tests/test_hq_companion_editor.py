"""Owner-shared trait editing and read-only budgeted context inspection."""
import json

import hq_ai as ai
import hq_companion_memory as memory
from tests.test_hq_ai import Base, DEV, DEV2


class EditorTests(Base):
    def request(self, op, *, owner="admin", role="admin", device=DEV, **kwargs):
        return ai.http_post({"action": "transferania", "op": op, "device_id": device, **kwargs},
                            owner_id=owner, role=role, client_ip="100.64.1.1")

    def test_edits_shared_between_devices_but_not_owners_and_reset(self):
        code, initial = self.request("personality")
        self.assertEqual(code, 200)
        traits = {**initial["traits"], "humor": "Humour très sec, une pointe à la fois."}
        code, saved = self.request("personality_save", revision=initial["revision"], traits=traits)
        self.assertEqual(code, 200, saved)
        _, second = self.request("personality", device=DEV2)
        self.assertEqual(second["traits"]["humor"], traits["humor"])
        _, other = self.request("personality", owner="other")
        self.assertEqual(other["customized"], [])
        system = ai.build_transferania_system("chat", "flirt", nsfw=False, view="accueil", device_id=DEV, context_core=True)
        self.assertIn(traits["humor"], system)
        self.assertNotIn(initial["traits"]["humor"], system)
        _, reset = self.request("personality_reset", revision=second["revision"])
        self.assertEqual(reset["traits"], initial["traits"])
        self.assertFalse(self.calls)

    def test_stale_edit_rejected_but_memory_updates_do_not_invalidate_draft(self):
        _, initial = self.request("personality")
        memory.observe_user("I prefer coffee.", DEV)
        code, saved = self.request("personality_save", traits={"humor": "Humour tendre."}, revision=initial["revision"])
        self.assertEqual(code, 200, saved)
        code, error = self.request("personality_save", traits={"humor": "Stale"}, revision=initial["revision"])
        self.assertEqual(code, 400)
        self.assertIn("autre appareil", error["error"])
        self.assertEqual(memory.personality_traits()["humor"], "Humour tendre.")

    def test_invalid_traits_never_overwrite(self):
        for traits in ({"unknown": "x"}, {"humor": 123}, {"humor": " "}, {"ambient_flirt": "😀" * 90},
                       {"humor": "é" * 1300}, {k: "x" * 1200 for k in ("humor", "curiosity", "strength", "signature", "flirt")}):
            code, out = self.request("personality_save", revision=0, traits=traits)
            self.assertEqual(code, 400, out)
            self.assertFalse(memory.personality_traits())
        code, _ = self.request("personality_save", revision=True, traits={"humor": "x"})
        self.assertEqual(code, 400)

    def test_editor_requires_admin_for_reads_writes_and_preview(self):
        for op in ("personality", "personality_save", "personality_reset", "context_preview"):
            for role in ("upload", None):
                code, _ = self.request(op, role=role, revision=0, traits={})
                self.assertEqual(code, 403)

    def test_ambient_and_chat_use_their_edited_fields_without_warm_flirt_bleed(self):
        self.request("personality_save", revision=0, traits={"ambient_warm": "Ambiance amicale très calme.",
                     "ambient_flirt": "Ambiance taquine très légère.", "flirt": "CHIMIE : charme complice unique."})
        for mode, text in (("warm", "amicale"), ("flirt", "taquine")):
            system = ai.build_transferania_system("ambient", mode, nsfw=False, view="accueil", device_id=DEV, context_core=True)
            self.assertIn(text, system)
        warm = ai.build_transferania_system("chat", "warm", nsfw=False, view="accueil", device_id=DEV, context_core=True)
        self.assertNotIn("charme complice unique", warm)

    def test_preview_is_complete_budgeted_and_does_not_write_or_generate(self):
        memory.observe_user("I prefer coffee.", DEV)
        ai.save_transferania({"v": 1, "messages": [{"role": "user", "text": "Older question", "ts": self.clock[0]},
                                           {"role": "assistant", "text": "Older reply", "ts": self.clock[0]}],
                             "summary": "Existing summary"}, DEV)
        before = {str(p): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        for kind in ("chat", "ambient"):
            code, out = self.request("context_preview", kind=kind, message="Do you remember coffee?", persona="flirt", view="accueil",
                                     live=True, digest="é😀" * 2000)
            self.assertEqual(code, 200, out)
            self.assertTrue(out["read_only"])
            self.assertEqual(out["model_calls"], 0)
            self.assertEqual(out["context_usage"]["estimated_input_tokens"], ai.estimate_context(out["system"], out["contents"]))
            self.assertLessEqual(out["context_usage"]["estimated_input_tokens"], ai.context_budget(kind))
            if kind == "chat":
                self.assertIn("Do you remember coffee?", json.dumps(out["contents"]))
                self.assertTrue(any("Older question" in str(m) for m in out["contents"]))
            self.assertNotIn("test-key", json.dumps(out))
        after = {str(p): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertFalse(self.calls)

    def test_preview_wrong_kind_empty_or_oversized_message(self):
        for kwargs in ({"kind": "wrong", "message": "Hi"}, {"kind": "chat", "message": ""},
                       {"kind": "chat", "message": "x" * 1601}):
            code, _ = self.request("context_preview", **kwargs)
            self.assertEqual(code, 400)

    def test_trait_save_cannot_break_configured_context_budget(self):
        ai.bind(companion_context_config=lambda: {"chat_input_budget": 2000})
        code, out = self.request("personality_save", revision=0, traits={"humor": "A thoughtful voice."})
        self.assertEqual(code, 413, out)
        self.assertFalse(memory.personality_traits())
