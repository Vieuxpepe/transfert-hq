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
        vis_id = self.ids_by_name()["Vis M3"]
        self.assertIn(f"Vis M3 [{vis_id}]: 4 pcs | min 20 | in Atelier", system)   # low stock, matched, with its id
        self.assertIn("Below minimum (1)", system)
        self.assertNotIn("Ruban adhésif: 9", system)                    # fine stock, not asked about
        self.assertIn("Reply in French", system)

    def ids_by_name(self) -> dict:
        return {i["name"]: i["id"] for i in inv.snapshot()["items"]}

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
        self.assertEqual(iai.parse_reply('{"reply": "Riz [itm-47bc5254d9fc4452] : 1 kg dans plc-1f722c3e1c3710da."}'), "Riz : 1 kg dans.")
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


def _j(reply="", tools=None):
    return json.dumps({"reply": reply, "tools": tools or []})


class ToolTests(_Base):
    def ids(self):
        snap = inv.snapshot()
        return ({i["name"]: i for i in snap["items"]}, {p["name"]: p for p in snap["places"]})

    def test_read_tools_return_real_data_with_place_paths(self) -> None:
        tb = iai.Toolbox()
        items, places = self.ids()
        res = tb.run("search_items", {"query": "vis"})
        self.assertEqual(res["count"], 1)
        self.assertEqual(res["items"][0]["id"], items["Vis M3"]["id"])
        self.assertEqual(res["items"][0]["place"], "Atelier")
        self.assertEqual(tb.run("get_item", {"id": items["Vis M3"]["id"]})["qty"], 4)
        self.assertIn("error", tb.run("get_item", {"id": "nope"}))
        self.assertEqual([r["name"] for r in tb.run("list_low_stock", {})["items"]], ["Vis M3"])
        self.assertEqual(tb.run("list_place", {"place_id": places["Atelier"]["id"]})["item_count"], 2)
        self.assertEqual(tb.run("list_places", {})["places"][0]["items"], 2)
        self.assertIn("error", tb.run("rm_rf", {}))
        self.assertEqual(inv.snapshot()["rev"], inv.snapshot()["rev"])

    def test_propose_validates_each_change_and_refuses_deletes(self) -> None:
        tb = iai.Toolbox()
        items, places = self.ids()
        vis = items["Vis M3"]["id"]
        out = tb.run("propose_changes", {"changes": [
            {"op": "adjust", "item_id": vis, "delta": 16},
            {"op": "adjust", "item_id": "itm-0000000000000000", "delta": 1},   # unknown id
            {"op": "delete", "item_id": vis},                                    # not offered
            {"op": "adjust", "item_id": vis, "delta": -500},                     # would go negative
            {"op": "adjust", "item_id": vis, "delta": 1.5},                      # not whole
            {"op": "create", "name": "Colle", "qty": 2, "unit": "tubes", "place_id": places["Atelier"]["id"]},
        ]})
        queued = [r["queued"] for r in out["results"]]
        self.assertEqual(queued, [True, False, False, False, False, True], out)
        self.assertIn("deleting is not available", out["results"][2]["error"])
        self.assertEqual([p["op"] for p in tb.proposals], ["item.adjust", "item.create"])

    def test_loop_feeds_tool_results_back_and_creates_a_draft_only(self) -> None:
        items, _ = self.ids()
        vis = items["Vis M3"]["id"]
        rev = inv.snapshot()["rev"]
        script = [
            _j("", [{"name": "search_items", "args": {"query": "vis"}}]),
            _j("", [{"name": "propose_changes", "args": {"changes": [{"op": "adjust", "item_id": vis, "delta": 16}]}}]),
            _j("A draft is ready: +16 M3 screws. Review it in the panel."),
        ]
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        with self.fake_generate(script):
            code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": "Restock the screws"})
        self.assertEqual(code, 200, out)
        self.assertEqual(len(self.calls), 3)
        second = json.dumps(self.calls[1][1])
        self.assertIn("TOOL RESULTS", second)
        self.assertIn(vis, second)                                   # real id came back from search_items
        self.assertIn("DRAFT", self.calls[0][0])                     # protocol documented in the prompt
        self.assertEqual(out["operation"]["status"], "draft")
        self.assertEqual(len(out["operation"]["proposals"]), 1)
        self.assertIn("draft is ready", out["messages"][-1]["text"])
        self.assertEqual(inv.snapshot()["rev"], rev)                 # nothing applied from the chat
        self.assertEqual(self.ids()[0]["Vis M3"]["qty"], 4)

    def test_ai_draft_goes_through_the_real_validate_preview_commit_flow(self) -> None:
        items, _ = self.ids()
        vis = items["Vis M3"]["id"]
        script = [_j("", [{"name": "propose_changes", "args": {"changes": [{"op": "adjust", "item_id": vis, "delta": 16}]}}]),
                  _j("Draft ready.")]
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        with self.fake_generate(script):
            _, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": "restock"})
        op = out["operation"]["id"]
        self.assertTrue(ivo.http_post(f"/api/inventoria/ops/{op}/validate", {})[1]["validation"]["ok"])
        _, prev = ivo.http_post(f"/api/inventoria/ops/{op}/preview", {"confirm": True})
        self.assertEqual(prev["preview"]["changes"][0]["after"]["qty"], 20)
        code, res = ivo.http_post(f"/api/inventoria/ops/{op}/commit", {"idempotency_key": "ai-draft-test-0001"})
        self.assertEqual(code, 200, res)
        self.assertEqual(self.ids()[0]["Vis M3"]["qty"], 20)

    def test_tool_loop_is_bounded(self) -> None:
        always = _j("", [{"name": "list_places", "args": {}}])
        with self.fake_generate([always] * 10 + [_j("done")]):
            reply, props = iai.respond("loop forever", [], None)
        self.assertLessEqual(len(self.calls), iai.MAX_ROUNDS)
        self.assertEqual(props, [])
        self.assertIn("Tool budget exhausted", self.calls[-1][0])
        self.assertIn("couldn't put together", reply)               # graceful, message not lost

    def test_bad_tool_args_never_break_the_chat(self) -> None:
        script = [_j("", [{"name": "search_items", "args": {"limit": "abc"}}, {"name": "propose_changes", "args": {"changes": "x"}}]),
                  _j("Sorry, I could not look that up.")]
        with self.fake_generate(script):
            reply, props = iai.respond("hello", [], None)
        self.assertEqual(reply, "Sorry, I could not look that up.")
        self.assertIn("error", self.calls[1][1][-1]["parts"][0]["text"])


class PlaceNameTests(_Base):
    def test_tools_accept_exact_place_names_and_reject_unknown(self) -> None:
        tb = iai.Toolbox()
        self.assertEqual(tb.run("list_place", {"place_id": "atelier"})["item_count"], 2)       # name, any case
        self.assertEqual(tb.run("search_items", {"query": "vis", "place_id": "Atelier"})["count"], 1)
        self.assertIn("error", tb.run("list_place", {"place_id": "Garage"}))
        vis = {i["name"]: i["id"] for i in inv.snapshot()["items"]}["Vis M3"]
        out = tb.run("propose_changes", {"changes": [{"op": "move", "item_ids": [vis], "place_id": "Atelier"}]})
        self.assertIn("results", out)
        bad = tb.run("propose_changes", {"changes": [{"op": "move", "item_ids": [vis], "place_id": "Garage"}]})
        self.assertFalse(bad["results"][0]["queued"])

    def test_pre_tool_guesses_are_not_echoed_back_to_the_model(self) -> None:
        script = [json.dumps({"reply": "There is flour in the pantry.", "tools": [{"name": "list_places", "args": {}}]}),
                  json.dumps({"reply": "Only the Atelier exists.", "tools": []})]
        with self.fake_generate(script):
            reply, _ = iai.respond("what is in the pantry?", [], None)
        self.assertEqual(reply, "Only the Atelier exists.")
        echoed = self.calls[1][1][-2]["parts"][0]["text"]
        self.assertNotIn("flour", echoed)


class CompanionParityTests(_Base):
    def test_memory_notes_persist_dedupe_cap_and_refuse_secrets(self) -> None:
        import hq_inventoria_memory as mem
        r = mem.add(self.root, "Prefers screws in packs of 100")
        self.assertFalse(r["duplicate"])
        self.assertTrue(mem.add(self.root, "prefers SCREWS in packs of 100")["duplicate"])
        with self.assertRaises(mem.MemoryError_):
            mem.add(self.root, "my wifi password is hunter2")
        with self.assertRaises(mem.MemoryError_):
            mem.add(self.root, "x")
        for i in range(mem.MAX_NOTES + 5):
            mem.add(self.root, f"note number {i} about shelves")
        notes = mem.list_notes(self.root)
        self.assertEqual(len(notes), mem.MAX_NOTES)
        self.assertNotIn("packs of 100", " ".join(n["text"] for n in notes))   # oldest fell off
        self.assertTrue(mem.forget(self.root, notes[0]["id"]))
        self.assertFalse(mem.forget(self.root, "../../etc"))
        self.assertEqual(mem.clean("a\nb\x00<b>c</b>"), "a b c")

    def test_remember_tool_feeds_the_next_prompt_and_forget_removes_it(self) -> None:
        script = [_j("", [{"name": "remember", "args": {"note": "Buys duct tape only from the hardware store"}}]),
                  _j("Noted, I'll remember that.")]
        with self.fake_generate(script):
            reply, props = iai.respond("remember I only buy duct tape at the hardware store", [], None)
        self.assertEqual(props, [])
        with mock.patch("hq_voice_phonon.language_directive", return_value=""):
            system = iai.build_system("tape")
        self.assertIn("Buys duct tape only from the hardware store", system)
        mem_id = system.split("[mem-")[1].split("]")[0]
        out = iai.Toolbox().run("forget", {"id": "mem-" + mem_id})
        self.assertTrue(out["forgotten"])
        self.assertIn("nothing saved yet", iai.build_system("tape"))

    def test_status_route_reports_greeting_memory_and_voice(self) -> None:
        code, out = ivo.http_get("/api/inventoria/status")
        self.assertEqual(code, 200)
        g = out["greeting"]
        self.assertEqual((g["low_count"], g["mood"]), (1, "proactive"))
        self.assertIn("Vis M3", g["line"])
        self.assertEqual(out["memory"], [])
        self.assertIn(out["language"], ("fr", "en"))

    def test_greeting_variants_and_language(self) -> None:
        with mock.patch.object(iai, "language", return_value="en"):
            self.assertIn("below its minimum", iai.greeting()["line"])
            ok = iai.greeting({"places": [], "items": [{"id": "a", "name": "x", "qty": 5, "min": 2, "rev": 1}]})
            self.assertEqual((ok["low_count"], ok["mood"]), (0, "idle"))
            self.assertIn("No items yet", iai.greeting({"places": [], "items": []})["line"])
        with mock.patch.object(iai, "language", return_value="fr"):
            self.assertIn("sous son minimum", iai.greeting()["line"])

    def test_memory_route_add_forget_and_validation(self) -> None:
        code, out = ivo.http_post("/api/inventoria/memory", {"action": "add", "text": "Likes labels in capitals"})
        self.assertEqual(code, 200)
        nid = out["memory"][0]["id"]
        self.assertEqual(ivo.http_post("/api/inventoria/memory", {"action": "add", "text": "my pin is 1234 token"})[0], 400)
        self.assertEqual(ivo.http_post("/api/inventoria/memory", {"action": "nope"})[0], 400)
        self.assertEqual(ivo.http_post("/api/inventoria/memory", {"action": "forget", "id": "mem-00000000"})[0], 404)
        code, out = ivo.http_post("/api/inventoria/memory", {"action": "forget", "id": nid})
        self.assertEqual((code, out["memory"]), (200, []))

    def test_long_conversations_trim_the_transcript_instead_of_failing(self) -> None:
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        with self.fake_generate(['{"reply": "ok", "tools": []}'] * 80):
            for i in range(ivo.MESSAGES_MAX // 2 + 6):
                code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": f"message {i}"})
                self.assertEqual(code, 200, (i, out))
        msgs = ivo.http_get(f"/api/inventoria/sessions/{sid}")[1]["session"]["messages"]
        self.assertLessEqual(len(msgs), ivo.MESSAGES_MAX)
        self.assertIn(f"message {ivo.MESSAGES_MAX // 2 + 5}", msgs[-2]["text"])   # newest kept


class _IntakeHelpers:
    def mk(self, name, qty, unit="", mn=None, place=None):
        inv.apply({"action": "item.create", "name": name, "qty": qty, "unit": unit, **({"min": mn} if mn is not None else {}),
                   **({"place": place} if place else {})})

    def by_name(self):
        return {i["name"]: i for i in inv.snapshot()["items"]}


class AlertsAndIntakeTests(_IntakeHelpers, _Base):
    def test_alert_levels_and_getting_low_band(self) -> None:
        f = iai.alert_level
        self.assertEqual(f({"qty": 0, "min": 5}), "out")
        self.assertIsNone(f({"qty": 0}))                       # untracked zero is not an alarm
        self.assertEqual(f({"qty": 5, "min": 5}), "low")
        self.assertEqual(f({"qty": 25, "min": 20}), "soon")     # within 25% above the minimum
        self.assertIsNone(f({"qty": 26, "min": 20}))
        self.assertEqual(f({"qty": 30, "min": 20}, warn_at=30), "soon")   # a watch widens the band
        self.assertIsNone(f({"qty": 31}, warn_at=30))
        self.assertEqual(f({"qty": 0}, warn_at=3), "out")

    def test_watch_tool_creates_an_alert_and_changes_no_stock(self) -> None:
        self.mk("Piles AA", 40, "pcs")
        aa = self.by_name()["Piles AA"]
        rev = inv.snapshot()["rev"]
        tb = iai.Toolbox()
        self.assertEqual([a["name"] for a in iai.alerts()], ["Vis M3"])
        out = tb.run("watch", {"item_id": aa["id"], "warn_at": 45})
        self.assertTrue(out["saved"])
        rows = iai.alerts()
        self.assertEqual([(a["name"], a["level"], a["watched"]) for a in rows], [("Vis M3", "low", False), ("Piles AA", "soon", True)])
        self.assertEqual(inv.snapshot()["rev"], rev)
        self.assertFalse(tb.run("watch", {"item_id": aa["id"], "warn_at": -1})["saved"])
        self.assertFalse(tb.run("watch", {"item_id": "itm-0000000000000000", "warn_at": 3})["saved"])
        self.assertTrue(tb.run("unwatch", {"item_id": aa["id"]})["removed"])
        self.assertEqual([a["name"] for a in iai.alerts()], ["Vis M3"])

    def test_status_and_watch_routes_expose_and_edit_alerts(self) -> None:
        self.mk("Piles AA", 40, "pcs")
        aa = self.by_name()["Piles AA"]["id"]
        self.assertEqual(ivo.http_post("/api/inventoria/watch", {"action": "set", "item_id": aa, "warn_at": 50})[0], 200)
        _, st = ivo.http_get("/api/inventoria/status")
        self.assertEqual([a["name"] for a in st["alerts"]], ["Vis M3", "Piles AA"])
        self.assertEqual(st["watches"][0]["warn_at"], 50)
        self.assertEqual(ivo.http_post("/api/inventoria/watch", {"action": "set", "item_id": aa, "warn_at": "x"})[0], 400)
        self.assertEqual(ivo.http_post("/api/inventoria/watch", {"action": "remove", "item_id": aa})[0], 200)
        self.assertEqual(ivo.http_post("/api/inventoria/watch", {"action": "remove", "item_id": aa})[0], 404)

    def test_match_items_finds_plurals_accents_and_gives_a_catalog(self) -> None:
        self.mk("Scie à main", 2, "pcs")
        self.mk("Lait demi-écrémé", 1, "L")
        res = iai.Toolbox().run("match_items", {"names": ["saws", "scies", "cartons de lait", "green apples"]})
        got = {r["name"]: [m["name"] for m in r["matches"]] for r in res["results"]}
        self.assertIn("Scie à main", got["scies"])
        self.assertIn("Lait demi-écrémé", got["cartons de lait"])
        self.assertEqual(got["green apples"], [])
        self.assertTrue(any("Scie à main" in c for c in res["catalog"]))      # lets the model map "saws" itself
        self.assertGreater(iai.match_score("pommes", "Pomme verte"), 0.7)

    def test_intake_message_becomes_one_reviewable_draft_and_commits_correctly(self) -> None:
        inv.apply({"action": "place.create", "name": "Garde-manger", "kind": "shelf"})
        pantry = {p["name"]: p["id"] for p in inv.snapshot()["places"]}["Garde-manger"]
        self.mk("Scie à main", 2, "pcs", place=inv.snapshot()["places"][0]["id"])
        self.mk("Lait", 1, "cartons", place=pantry)
        ids = self.by_name()
        script = [
            _j("", [{"name": "match_items", "args": {"names": ["saws", "green apples", "cartons de lait"]}},
                    {"name": "list_places", "args": {}}]),
            _j("", [{"name": "propose_changes", "args": {"changes": [
                {"op": "adjust", "item_id": ids["Scie à main"]["id"], "delta": 10},
                {"op": "create", "name": "Pommes vertes", "qty": 3, "unit": "pcs", "place_id": "Garde-manger"},
                {"op": "adjust", "item_id": ids["Lait"]["id"], "delta": 3}]}}]),
            _j("Done: 2 updated, 1 new (Pommes vertes in Garde-manger). Review the draft."),
        ]
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        before = {i["name"]: i["qty"] for i in inv.snapshot()["items"]}
        with self.fake_generate(script):
            code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message",
                                      {"text": "bought 10 saws, 3 green apples, 3 cartons de lait"})
        self.assertEqual(code, 200, out)
        self.assertEqual(self.calls[0][0].count("INTAKE"), 1)                  # workflow is in the prompt
        feedback = json.dumps(self.calls[1][1])
        self.assertIn("catalog", feedback)
        self.assertIn("holds", feedback)                                       # place contents help choose where things go
        self.assertEqual(len(out["operation"]["proposals"]), 3)
        self.assertEqual({i["name"]: i["qty"] for i in inv.snapshot()["items"]}, before)   # nothing applied yet
        labels = [p["label_fr"] for p in out["operation"]["proposals"]]
        self.assertIn("Créer Pommes vertes (×3) dans Garde-manger", labels)
        op = out["operation"]["id"]
        self.assertTrue(ivo.http_post(f"/api/inventoria/ops/{op}/validate", {})[1]["validation"]["ok"])
        ivo.http_post(f"/api/inventoria/ops/{op}/preview", {"confirm": True})
        code, res = ivo.http_post(f"/api/inventoria/ops/{op}/commit", {"idempotency_key": "intake-test-0001"})
        self.assertEqual(code, 200, res)
        after = self.by_name()
        self.assertEqual((after["Scie à main"]["qty"], after["Lait"]["qty"]), (12, 4))
        self.assertEqual((after["Pommes vertes"]["qty"], after["Pommes vertes"]["place"]), (3, pantry))

    def test_large_batches_are_queued_up_to_the_limit(self) -> None:
        for i in range(25):
            self.mk(f"Article {i:02d}", 1, "pcs")
        ids = [i["id"] for i in inv.snapshot()["items"] if i["name"].startswith("Article")]
        out = iai.Toolbox().run("propose_changes", {"changes": [{"op": "adjust", "item_id": x, "delta": 1} for x in ids]})
        self.assertEqual(sum(r["queued"] for r in out["results"]), iai.MAX_PROPOSALS)


class MultiCreateTests(_IntakeHelpers, _Base):
    def test_several_new_items_become_ordered_operations_that_all_commit(self) -> None:
        inv.apply({"action": "place.create", "name": "Garde-manger", "kind": "shelf"})
        self.mk("Lait", 1, "cartons")
        ids = self.by_name()
        script = [_j("", [{"name": "propose_changes", "args": {"changes": [
                    {"op": "create", "name": "Pommes vertes", "qty": 3, "place_id": "Garde-manger"},
                    {"op": "adjust", "item_id": ids["Lait"]["id"], "delta": 3},
                    {"op": "create", "name": "Scies", "qty": 10},
                    {"op": "create", "name": "Riz", "qty": 2, "unit": "kg", "place_id": "Garde-manger"}]}}]),
                  _j("Three new items and one update; review the drafts.")]
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        with self.fake_generate(script):
            code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": "bought stuff"})
        self.assertEqual(code, 200, out)
        ops = out["operations"]
        self.assertEqual([len(o["proposals"]) for o in ops], [2, 1, 1])
        self.assertEqual([p["op"] for p in ops[0]["proposals"]], ["item.adjust", "item.create"])   # create always last
        for n, o in enumerate(ops):
            self.assertTrue(ivo.http_post(f"/api/inventoria/ops/{o['id']}/validate", {})[1]["validation"]["ok"], n)
            ivo.http_post(f"/api/inventoria/ops/{o['id']}/preview", {"confirm": True})
            code, res = ivo.http_post(f"/api/inventoria/ops/{o['id']}/commit", {"idempotency_key": f"multi-create-{n:04d}"})
            self.assertEqual(code, 200, res)
        after = self.by_name()
        self.assertEqual((after["Lait"]["qty"], after["Pommes vertes"]["qty"], after["Scies"]["qty"], after["Riz"]["qty"]), (4, 3, 10, 2))
        self.assertIsNone(after["Scies"]["place"])


class DuplicateGuardTests(_IntakeHelpers, _Base):
    def test_repeated_adjusts_and_creates_are_refused_not_doubled(self) -> None:
        vis = self.by_name()["Vis M3"]["id"]
        out = iai.Toolbox().run("propose_changes", {"changes": [
            {"op": "adjust", "item_id": vis, "delta": 5},
            {"op": "adjust", "item_id": vis, "delta": 5},
            {"op": "create", "name": "Colle", "qty": 1},
            {"op": "create", "name": "colle", "qty": 2}]})
        self.assertEqual([r["queued"] for r in out["results"]], [True, False, True, False])
        self.assertIn("duplicate", out["results"][1]["error"])
