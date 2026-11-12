"""Inventoria's Gemini-backed replies: persona, inventory context, session history, read-only guarantee."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import hq_ai
import hq_finances as fin
import hq_household_store as store
import hq_inventoria as ivo
import hq_inventoria_ai as iai
import hq_inventory as inv


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="ivo-ai-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        inv.bind(root=self.root, now=lambda: 600.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0, llm_adapter=iai.adapter)
        inv.apply({"action": "place.create", "name": "Atelier", "kind": "shelf"})
        place = inv.snapshot()["places"][0]["id"]
        inv.apply({"action": "item.create", "name": "Vis M3", "qty": 4, "unit": "pcs", "min": 20, "place": place})
        inv.apply({"action": "item.create", "name": "Ruban adhésif", "qty": 9, "unit": "rouleaux", "min": 2, "place": place})
        self.calls: list[tuple[str, list]] = []

    def tearDown(self) -> None:
        ivo.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def fake_generate(self, answer):
        def gen(chain, system, contents, **kw):
            self.calls.append((system, contents))
            return (answer if isinstance(answer, str) else answer.pop(0)), "gemini-test"
        return mock.patch.object(hq_ai, "generate", side_effect=gen)


class ContextTests(_Base):
    def test_system_has_persona_and_live_inventory(self) -> None:
        with mock.patch("hq_voice_phonon.language_directive", return_value=""):
            system = iai.build_system("combien de vis ?")
        self.assertIn("You are Inventoria", system)
        self.assertIn("Vis M3: 4 pcs | min 20 | in Atelier", system)   # low stock and matched by the query
        self.assertIn("Below minimum (1)", system)
        self.assertNotIn("Ruban adhésif: 9", system)                    # fine stock, not asked about
        self.assertIn("Reply in French", system)

    def test_english_directive_follows_the_saved_voice(self) -> None:
        with mock.patch("hq_voice_phonon.language_directive", return_value="LANGUAGE OVERRIDE English"):
            self.assertIn("LANGUAGE OVERRIDE English", iai.build_system("x"))
            self.assertNotIn("Reply in French", iai.build_system("x"))

    def test_history_alternates_starts_with_user_and_is_capped(self) -> None:
        hist = [{"role": "assistant", "text": "orphan"}] + [
            {"role": "user" if i % 2 == 0 else "assistant", "text": f"m{i}" + "x" * 2000} for i in range(30)]
        rows = iai.build_contents(hist, "latest question")
        self.assertEqual(rows[0]["role"], "user")
        self.assertEqual(rows[-1]["parts"][0]["text"].splitlines()[-1], "latest question")
        self.assertTrue(all(a["role"] != b["role"] for a, b in zip(rows, rows[1:])))
        self.assertLessEqual(len(rows), iai.HISTORY_TURNS + 1)
        self.assertTrue(all(len(p["text"]) <= iai.HISTORY_CHARS + 40 for r in rows[:-1] for p in r["parts"]))

    def test_parse_reply_variants(self) -> None:
        self.assertEqual(iai.parse_reply('{"reply": "Il reste **4** vis."}'), "Il reste 4 vis.")
        self.assertEqual(iai.parse_reply('plain text answer'), "plain text answer")
        self.assertEqual(iai.parse_reply('{"reply": "truncated'), '{"reply": "truncated')
        self.assertEqual(len(iai.parse_reply(json.dumps({"reply": "a" * 5000}))), iai.REPLY_MAX)


class SessionFlowTests(_Base):
    def _session(self) -> str:
        return ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]

    def test_reply_is_stored_history_is_sent_and_stock_untouched(self) -> None:
        sid = self._session()
        rev = inv.snapshot()["rev"]
        with self.fake_generate(['{"reply": "Il reste 4 vis M3, sous le minimum de 20."}',
                                 '{"reply": "Je te propose d\'en ajouter 16."}']):
            c1, out1 = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": "Combien de vis ?"})
            c2, out2 = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": "Et pour la suite ?"})
        self.assertEqual((c1, c2), (200, 200), (out1, out2))
        roles = [m["role"] for m in out2["messages"]]
        self.assertEqual(roles, ["user", "assistant", "user", "assistant"])
        self.assertIn("16", out2["messages"][-1]["text"])
        self.assertNotIn("operation", out2)                               # read-only: no proposals created
        self.assertEqual(inv.snapshot()["rev"], rev)
        # second request carried the first exchange as history, in order
        system, contents = self.calls[1]
        texts = [p["text"] for r in contents for p in r["parts"]]
        self.assertTrue(any("Combien de vis" in t for t in texts) and any("sous le minimum" in t for t in texts))
        self.assertEqual(contents[-1]["parts"][0]["text"].splitlines()[-1], "Et pour la suite ?")
        self.assertIsNone(ivo.current_history() or None)                  # history never leaks between calls

    def test_model_failure_persists_nothing(self) -> None:
        sid = self._session()
        with mock.patch.object(hq_ai, "generate", side_effect=hq_ai.AiError("quota", 429, "quota")):
            code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": "salut"})
        self.assertGreaterEqual(code, 400)
        msgs = ivo.http_get(f"/api/inventoria/sessions/{sid}")[1]["session"]["messages"]
        self.assertEqual(msgs, [])

    def test_adapter_without_reply_keeps_legacy_behaviour(self) -> None:
        sid = self._session()
        ivo.bind(llm_adapter=lambda text, session_id=None: {"proposals": []})
        code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": "range"})
        self.assertEqual(code, 200)
        self.assertEqual([m["role"] for m in out["messages"]], ["user"])


if __name__ == "__main__":
    unittest.main()
