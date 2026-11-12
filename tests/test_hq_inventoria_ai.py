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


class ShoppingListTests(_IntakeHelpers, _Base):
    def test_list_is_plain_checkbox_text_sorted_by_urgency_with_sane_quantities(self) -> None:
        self.mk("Colle", 0, "tubes", mn=3)
        self.mk("Beurre", 2, "plaquettes", mn=1)          # getting low
        self.mk("Riz", 50, "kg", mn=2)                    # fine: not listed
        out = iai.shopping_list(lang="fr", today="2026-11-12")
        lines = out["text"].splitlines()
        self.assertEqual(lines[0], "Courses — 2026-11-12")
        self.assertEqual(lines[1:], [
            "☐ Colle — 5 tubes (reste 0, min 3)",
            "☐ Vis M3 — 26 pcs (reste 4, min 20)",
            "☐ Beurre — 1 plaquettes (reste 2, min 1)"])
        self.assertNotIn("Riz", out["text"])
        self.assertEqual(out["count"], 3)
        self.assertNotIn("Beurre", iai.shopping_list(include_soon=False, lang="fr")["text"])
        self.assertIn("(left 4, min 20)", iai.shopping_list(lang="en")["text"])

    def test_buy_quantity_never_zero_and_watch_only_items_use_the_watch_level(self) -> None:
        self.assertEqual(iai.suggested_buy({"qty": 1, "min": 1, "warn_at": None}), 1)      # target 2
        self.assertEqual(iai.suggested_buy({"qty": 40, "min": 0, "warn_at": 35}), 13)       # 35*1.5=53 -> 13
        self.assertEqual(iai.suggested_buy({"qty": 0, "min": 0, "warn_at": None}), 1)
        self.mk("Piles AA", 40, "pcs")
        aa = self.by_name()["Piles AA"]["id"]
        iai.Toolbox().run("watch", {"item_id": aa, "warn_at": 45})
        self.assertIn("Piles AA — 28 pcs (reste 40, alerte 45)", iai.shopping_list(lang="fr")["text"])

    def test_nothing_to_buy_and_status_feed(self) -> None:
        self.assertEqual(iai.shopping_list({"places": [], "items": []}, lang="en", today="d")["text"], "Shopping list — d\nNothing to buy right now.")
        _, st = ivo.http_get("/api/inventoria/status")
        self.assertEqual(st["shopping"]["all"]["count"], 1)
        self.assertIn("Vis M3", st["shopping"]["urgent"]["text"])


class UndoTests(_IntakeHelpers, _Base):
    def _commit(self, props):
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"proposals": props})
        self.assertEqual(code, 200, out)
        op = out["operation"]["id"]
        self.assertTrue(ivo.http_post(f"/api/inventoria/ops/{op}/validate", {})[1]["validation"]["ok"])
        ivo.http_post(f"/api/inventoria/ops/{op}/preview", {"confirm": True})
        code, res = ivo.http_post(f"/api/inventoria/ops/{op}/commit", {"idempotency_key": "undo-test-" + op[-6:]})
        self.assertEqual(code, 200, res)
        return op

    def _apply_draft(self, op, tag):
        self.assertTrue(ivo.http_post(f"/api/inventoria/ops/{op}/validate", {})[1]["validation"]["ok"])
        ivo.http_post(f"/api/inventoria/ops/{op}/preview", {"confirm": True})
        code, res = ivo.http_post(f"/api/inventoria/ops/{op}/commit", {"idempotency_key": f"undo-apply-{tag}"})
        self.assertEqual(code, 200, res)

    def test_undo_restores_adjusts_edits_moves_and_removes_created_items(self) -> None:
        inv.apply({"action": "place.create", "name": "Cave", "kind": "shelf"})
        cave = inv.snapshot()["places"][-1]["id"]
        self.mk("Tape", 5, "rolls", place=inv.snapshot()["places"][0]["id"])
        ids = self.by_name()
        before = {i["name"]: (i["qty"], i["place"]) for i in inv.snapshot()["items"]}
        P = lambda op, refs, payload, label: {"op": op, "refs": refs, "resolved": {"confidence": "high"}, "payload": payload, "label_fr": label}
        op = self._commit([
            P("item.adjust", {"item_id": ids["Vis M3"]["id"]}, {"id": ids["Vis M3"]["id"], "delta": 16}, "adj"),
            P("item.update", {"item_id": ids["Tape"]["id"]}, {"id": ids["Tape"]["id"], "rev": ids["Tape"]["rev"], "name": "Ruban", "min": 2}, "upd"),
            P("item.move", {}, {"ids": [ids["Tape"]["id"]], "place": cave}, "mov"),
            P("item.create", {}, {"name": "Colle", "qty": 3}, "crt")])
        self.assertEqual(self.by_name()["Vis M3"]["qty"], 20)
        self.assertIn("Colle", self.by_name())
        code, out = ivo.http_post(f"/api/inventoria/ops/{op}/undo", {})
        self.assertEqual(code, 200, out)
        draft = out["operation"]
        self.assertEqual(draft["status"], "draft")
        self.assertEqual(self.by_name()["Vis M3"]["qty"], 20)                      # nothing changes until confirmed
        self.assertEqual(ivo.http_post(f"/api/inventoria/ops/{op}/undo", {})[1]["operation"]["id"], draft["id"])   # idempotent
        self._apply_draft(draft["id"], "a")
        now = {i["name"]: (i["qty"], i["place"]) for i in inv.snapshot()["items"]}
        self.assertEqual(now, before)                                              # exactly where we started (name restored too)
        self.assertEqual(ivo.http_post(f"/api/inventoria/ops/{op}/undo", {})[0], 409)   # already undone

    def test_undo_refuses_unjournaled_uncommitted_and_stale_batches(self) -> None:
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        vis = self.by_name()["Vis M3"]["id"]
        _, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"proposals": [
            {"op": "item.adjust", "refs": {"item_id": vis}, "resolved": {"confidence": "high"}, "payload": {"id": vis, "delta": 1}, "label_fr": "x"}]})
        self.assertEqual(ivo.http_post(f"/api/inventoria/ops/{out['operation']['id']}/undo", {})[0], 409)   # still a draft
        op = self._commit([{"op": "item.adjust", "refs": {"item_id": vis}, "resolved": {"confidence": "high"},
                            "payload": {"id": vis, "delta": 10}, "label_fr": "x"}])
        inv.apply({"action": "item.adjust", "id": vis, "delta": -13})            # stock moved on since (4+10-13 = 1)
        code, res = ivo.http_post(f"/api/inventoria/ops/{op}/undo", {})
        self.assertEqual(code, 409, res)                                         # undoing -10 would go negative
        self.assertEqual(self.by_name()["Vis M3"]["qty"], 1)


class StoresTrendAndTickOffTests(_IntakeHelpers, _Base):
    DAY = 86400.0

    def test_store_tool_groups_the_shopping_list(self) -> None:
        self.mk("Colle", 0, "tubes", mn=3)
        ids = self.by_name()
        tb = iai.Toolbox()
        self.assertTrue(tb.run("set_store", {"item_id": ids["Vis M3"]["id"], "store": "Quincaillerie"})["saved"])
        self.assertTrue(tb.run("set_store", {"item_id": ids["Colle"]["id"], "store": "Quincaillerie"})["saved"])
        self.assertFalse(tb.run("set_store", {"item_id": "itm-0000000000000000", "store": "x"})["saved"])
        out = iai.shopping_list(lang="fr", today="d")
        self.assertEqual(out["text_grouped"].splitlines(), [
            "Courses — d", "", "— Quincaillerie —",
            "☐ Colle — 5 tubes (reste 0, min 3)", "☐ Vis M3 — 26 pcs (reste 4, min 20)"])
        self.assertTrue(tb.run("set_store", {"item_id": ids["Vis M3"]["id"], "store": ""})["saved"])
        self.assertIn("— Autres —", iai.shopping_list(lang="fr", today="d")["text_grouped"])
        self.assertEqual(iai.shopping_list(lang="fr")["items"][0]["store"] in ("Quincaillerie", ""), True)

    def test_estimate_needs_history_and_ignores_restocks(self) -> None:
        import hq_inventoria_history as h
        d = self.DAY
        pts = [[0, 10], [2 * d, 8], [4 * d, 6], [6 * d, 4]]
        e = h.estimate_from(pts, 4, 6 * d)
        self.assertEqual((e["rate_per_day"], e["days_left"]), (1.0, 4))
        self.assertIsNone(h.estimate_from(pts[:2], 8, 2 * d))                         # too little data
        self.assertIsNone(h.estimate_from([[0, 10], [d, 9], [2 * d, 8]], 8, 2 * d))    # span under 5 days
        restock = [[0, 10], [2 * d, 8], [3 * d, 20], [5 * d, 18], [7 * d, 16]]
        self.assertEqual(h.estimate_from(restock, 16, 7 * d)["rate_per_day"], round(6 / 7, 3))   # the +12 restock is ignored
        self.assertIsNone(h.estimate_from([[0, 1], [3 * d, 5], [6 * d, 9]], 9, 6 * d))  # only increases

    def test_trend_alert_appears_before_any_minimum_is_hit_and_is_labelled_an_estimate(self) -> None:
        import hq_inventoria_history as h
        self.mk("Café", 40, "g", mn=5)
        cafe = self.by_name()["Café"]["id"]
        for day, qty in enumerate([40, 34, 28, 22, 16, 10]):
            inv.apply({"action": "item.update", "id": cafe, "rev": self.by_name()["Café"]["rev"], "qty": qty})
            h.observe(self.root, inv.snapshot(), now=day * self.DAY)
        rows = {a["name"]: a for a in iai.alerts(now=5 * self.DAY)}
        self.assertEqual(rows["Café"]["level"], "trend")                                # 10 g left at 6 g/day, minimum 5 not hit
        self.assertEqual(rows["Café"]["days_left"], 1)
        with mock.patch.object(iai, "language", return_value="en"):
            self.assertIn("estimate", iai.GREETING["en"]["state"]["trend"])
        shop = iai.shopping_list(lang="en", today="d", now=5 * self.DAY)
        buy = [i for i in shop["items"] if i["name"] == "Café"]
        self.assertIn("~1 days left", shop["text"])
        self.assertNotIn("Café", iai.shopping_list(lang="en", today="d", now=5 * self.DAY, include_soon=False)["text"])
        self.assertTrue(buy and buy[0]["buy"] >= 1)

    def test_tick_off_route_builds_one_reviewable_adjust_draft_without_the_model(self) -> None:
        ids = self.by_name()
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        with mock.patch.object(hq_ai, "generate", side_effect=AssertionError("no model call allowed")):
            code, out = ivo.http_post("/api/inventoria/purchased", {"session_id": sid, "items": [{"id": ids["Vis M3"]["id"], "qty": 26}]})
        self.assertEqual(code, 200, out)
        self.assertEqual(out["operation"]["proposals"][0]["label_fr"], "Acheté : Vis M3 de +26")
        self.assertEqual(self.by_name()["Vis M3"]["qty"], 4)                              # still a draft
        for bad in ([], [{"id": "itm-0000000000000000", "qty": 1}], [{"id": ids["Vis M3"]["id"], "qty": 0}],
                    [{"id": ids["Vis M3"]["id"], "qty": 1}, {"id": ids["Vis M3"]["id"], "qty": 2}]):
            self.assertEqual(ivo.http_post("/api/inventoria/purchased", {"session_id": sid, "items": bad})[0], 400)
        self.assertEqual(ivo.http_post("/api/inventoria/purchased", {"session_id": "nope", "items": []})[0], 400)

    def test_prompt_understands_checkbox_lists_and_stores(self) -> None:
        with mock.patch("hq_voice_phonon.language_directive", return_value=""):
            system = iai.build_system("x")
        self.assertIn("BOUGHT", system)
        self.assertIn("set_store", system)


def _jpeg_data_url(w=64, h=48, text="LAIT 2x") -> str:
    import base64, io
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (w, h), "white")
    ImageDraw.Draw(img).text((4, 4), text, fill="black")
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=70)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


class NotifyTests(_IntakeHelpers, _Base):
    DAY = 86400.0

    def setUp(self) -> None:
        super().setUp()
        import hq_inventoria_notify as n
        self.n = n
        self.sent: list = []
        self.send = lambda t, b: self.sent.append((t, b))
        self.noon = __import__("time").mktime((2026, 11, 12, 12, 0, 0, 0, 0, -1))

    def test_default_off_but_history_is_still_recorded(self) -> None:
        import hq_inventoria_history as h
        self.assertFalse(self.n.get_settings(self.root)["enabled"])
        out = self.n.tick(self.root, self.send, now=self.noon)
        self.assertEqual((out, self.sent), ({"instant": [], "digest": False}, []))
        self.assertTrue(h._path(self.root).exists())

    def test_enabling_does_not_announce_old_alerts_but_new_ones_ping_once(self) -> None:
        self.n.save_settings(self.root, enabled=True, digest_hour=23)           # Vis M3 is already low
        self.assertEqual(self.n.tick(self.root, self.send, now=self.noon)["instant"], [])
        self.mk("Beurre", 9, "pl", mn=2)
        beurre = self.by_name()["Beurre"]
        inv.apply({"action": "item.update", "id": beurre["id"], "rev": beurre["rev"], "qty": 2})   # crosses into "low"
        out = self.n.tick(self.root, self.send, now=self.noon + 600)
        self.assertEqual(out["instant"], ["Beurre"])
        self.assertIn("Beurre", self.sent[0][0])
        self.n.tick(self.root, self.send, now=self.noon + 1200)
        self.assertEqual(len(self.sent), 1)                                      # not repeated every pass
        b = self.by_name()["Beurre"]
        inv.apply({"action": "item.update", "id": b["id"], "rev": b["rev"], "qty": 9})            # restocked ...
        self.n.tick(self.root, self.send, now=self.noon + 1800)
        b = self.by_name()["Beurre"]
        inv.apply({"action": "item.update", "id": b["id"], "rev": b["rev"], "qty": 1})            # ... then relapses
        self.assertEqual(self.n.tick(self.root, self.send, now=self.noon + 2400)["instant"], ["Beurre"])

    def test_digest_once_per_day_after_the_hour_and_only_when_something_needs_attention(self) -> None:
        self.n.save_settings(self.root, enabled=True, instant=False, digest_hour=8)
        morning = self.noon - 5 * 3600                                           # 07:00 -> too early
        self.assertFalse(self.n.tick(self.root, self.send, now=morning)["digest"])
        self.assertTrue(self.n.tick(self.root, self.send, now=self.noon)["digest"])
        self.assertIn("Vis M3", self.sent[-1][1])
        self.assertFalse(self.n.tick(self.root, self.send, now=self.noon + 3600)["digest"])      # same day
        self.assertTrue(self.n.tick(self.root, self.send, now=self.noon + self.DAY)["digest"])   # next day

    def test_failing_channel_never_breaks_the_watcher(self) -> None:
        def boom(t, b):
            raise RuntimeError("discord down")
        self.n.save_settings(self.root, enabled=True, instant=False, digest_hour=0)
        self.assertTrue(self.n.tick(self.root, boom, now=self.noon)["digest"])

    def test_notify_route_validates_and_test_ping_uses_the_bound_channel(self) -> None:
        self.assertEqual(ivo.http_post("/api/inventoria/notify", {"enabled": "yes"})[0], 400)
        self.assertEqual(ivo.http_post("/api/inventoria/notify", {"digest_hour": 30})[0], 400)
        ivo.bind(notify=self.send)
        code, out = ivo.http_post("/api/inventoria/notify", {"enabled": True, "digest_hour": 7, "test": True})
        self.assertEqual((code, out["notify"]["digest_hour"], out["test_sent"]), (200, 7, True))
        self.assertEqual(len(self.sent), 1)
        self.assertTrue(ivo.http_get("/api/inventoria/status")[1]["notify"]["enabled"])


class PhotoTests(_IntakeHelpers, _Base):
    def test_photo_reaches_the_model_on_a_vision_chain_and_is_never_stored(self) -> None:
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        chains = []

        def gen(chain, system, contents, **kw):
            chains.append(chain)
            self.calls.append((system, contents))
            return '{"reply": "I read a receipt with milk.", "tools": []}', "m"
        with mock.patch.object(hq_ai, "generate", side_effect=gen):
            code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"image": _jpeg_data_url(), "text": "my receipt"})
        self.assertEqual(code, 200, out)
        self.assertEqual(chains[0], iai.VISION_CHAIN)
        parts = self.calls[0][1][-1]["parts"]
        self.assertTrue(any("inlineData" in p and p["inlineData"]["mimeType"] == "image/jpeg" for p in parts))
        self.assertIn("RECEIPT", self.calls[0][0])
        self.assertEqual(out["messages"][0]["text"], "\U0001F4F7 my receipt")
        stored = json.dumps(ivo.http_get(f"/api/inventoria/sessions/{sid}")[1])
        self.assertNotIn("base64", stored)
        self.assertIsNone(ivo.current_image())                                   # no leak between requests

    def test_text_only_requests_keep_the_normal_chain_and_bad_photos_are_refused(self) -> None:
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        chains = []

        def gen(c, *a, **k):
            chains.append(c)
            return '{"reply": "ok", "tools": []}', "m"
        with mock.patch.object(hq_ai, "generate", side_effect=gen):
            ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": "hello"})
        self.assertEqual(chains[0], hq_ai.ASK_CHAIN)
        for bad in ("not a data url", "data:text/html;base64,PGI+", "data:image/png;base64," + "A" * 2_100_000):
            self.assertEqual(ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"image": bad})[0], 400)
        self.assertEqual(ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": "x" * 1_100_000})[0], 413)

    def test_photo_without_text_gets_a_default_label(self) -> None:
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        with self.fake_generate(['{"reply": "ok", "tools": []}']):
            _, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"image": _jpeg_data_url()})
        self.assertEqual(out["messages"][0]["text"], "\U0001F4F7 (photo)")


class GroceryAndMealsTests(_IntakeHelpers, _Base):
    def test_lines_use_canonical_units_and_known_merchants(self) -> None:
        items = [{"name": "Riz", "buy": 2, "unit": "kg", "store": "Metro"}, {"name": "Huile", "buy": 1, "unit": "L", "store": ""},
                 {"name": "Vis M3", "buy": 26, "unit": "pcs", "store": "Metro"}, {"name": "Poivre", "buy": 50, "unit": "g", "store": "x"}]
        lines = iai.grocery_lines(items, {"metro": "mrc-0123456789abcdef"})
        self.assertEqual([(l["name"], l["qty_milli"], l["unit"], l.get("merchant_id")) for l in lines], [
            ("Riz", 2_000_000, "g", "mrc-0123456789abcdef"), ("Huile", 1_000_000, "ml", None),
            ("Vis M3", 26_000, "each", "mrc-0123456789abcdef"), ("Poivre", 50_000, "g", None)])

    def test_to_grocery_route_creates_an_open_list_in_the_grocery_module(self) -> None:
        code, out = ivo.http_post("/api/inventoria/to-grocery", {})
        self.assertEqual(code, 200, out)
        self.assertEqual(out["count"], 1)
        line = out["list"]["lines"][0]
        self.assertEqual((line["name"], line["qty_milli"], line["unit"], line["checked"]), ("Vis M3", 26_000, "each", False))
        self.assertEqual(out["list"]["status"], "open")

    def test_to_grocery_refuses_an_empty_list(self) -> None:
        vis = {i["name"]: i for i in inv.snapshot()["items"]}["Vis M3"]
        inv.apply({"action": "item.update", "id": vis["id"], "rev": vis["rev"], "qty": 99})
        self.assertEqual(ivo.http_post("/api/inventoria/to-grocery", {})[0], 409)

    def test_meal_tool_is_read_only_and_needs_a_session_db(self) -> None:
        self.assertIn("error", iai.Toolbox().run("meal_needs", {}))               # outside a chat turn
        seen: dict = {}

        def gen(chain, system, contents, **kw):
            if not seen:
                seen["x"] = 1
                return '{"reply": "", "tools": [{"name": "meal_needs", "args": {}}]}', "m"
            seen["result"] = contents[-1]["parts"][0]["text"]
            return '{"reply": "No meal plan yet.", "tools": []}', "m"
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        with mock.patch.object(hq_ai, "generate", side_effect=gen):
            code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": "what do my meals need?"})
        self.assertEqual(code, 200, out)
        self.assertIn("no meal plan yet", seen["result"])

    def test_meal_tool_picks_the_current_plan_and_lists_only_what_is_missing(self) -> None:
        import hq_meals
        plans = [{"id": "mpl-1", "period_start": "2000-01-01", "period_end": "2000-01-07"},
                 {"id": "mpl-2", "period_start": "2000-01-01", "period_end": "2999-12-31"}]
        lines = [{"name": "Poulet", "qty_milli": 1_500, "unit": "each"}, {"name": "Riz", "qty_milli": 0, "unit": "g"}]
        with mock.patch.object(hq_meals, "list_meal_plans", return_value={"items": plans}), \
             mock.patch.object(hq_meals, "build_list_preview", return_value={"lines": lines, "warnings": []}) as prev, \
             mock.patch.object(ivo, "current_db", return_value=(object(), "hhold-x")):
            res = iai.Toolbox().run("meal_needs", {})
        self.assertEqual(prev.call_args.args[2], "mpl-2")
        self.assertEqual(res["to_buy"], [{"name": "Poulet", "qty": 1.5, "unit": "each"}])


class ResolveItemTests(_IntakeHelpers, _Base):
    def test_wrong_id_for_the_named_item_is_refused_with_a_pointer_to_the_right_one(self) -> None:
        self.mk("Beurre", 2, "pl", mn=1)
        self.mk("Riz basmati", 1, "kg", mn=2)
        ids = self.by_name()
        tb = iai.Toolbox()
        bad = tb.run("set_store", {"item_id": ids["Riz basmati"]["id"], "item_name": "Beurre", "store": "Laiterie"})
        self.assertFalse(bad["saved"])
        self.assertIn(ids["Beurre"]["id"], bad["error"])                                  # tells the model who Beurre really is
        ok = tb.run("set_store", {"item_id": ids["Beurre"]["id"], "item_name": "beurre", "store": "Laiterie"})
        self.assertTrue(ok["saved"])
        self.assertTrue(tb.run("watch", {"item_name": "Beurre", "warn_at": 3})["saved"])  # a bare name is enough when it is unambiguous
        self.assertFalse(tb.run("watch", {"item_name": "xyzzy", "warn_at": 3})["saved"])
        out = tb.run("propose_changes", {"changes": [{"op": "adjust", "item_id": ids["Riz basmati"]["id"], "item_name": "Beurre", "delta": 1}]})
        self.assertFalse(out["results"][0]["queued"])                                      # same guard inside drafts
        out = tb.run("propose_changes", {"changes": [{"op": "adjust", "item_name": "Riz", "delta": 2}]})
        self.assertTrue(out["results"][0]["queued"])


class GroceryRoutingTests(_IntakeHelpers, _Base):
    def _open_lists(self):
        import hq_household_store as hs
        try:
            with hs.open_store(self.root, readonly=True) as st:
                return [dict(r) for r in st.conn.execute("SELECT * FROM grocery_lists").fetchall()]
        except hs.HouseholdStoreError:
            return []                                                                      # no household database yet

    def test_propose_grocery_validates_merges_duplicates_and_writes_nothing(self) -> None:
        tb = iai.Toolbox()
        out = tb.run("propose_grocery", {"lines": [
            {"name": "Oeufs", "qty": 12, "unit": "pcs"}, {"name": "oeufs", "qty": 6}, {"name": "Pain"},
            {"name": "", "qty": 1}, {"name": "Sucre", "qty": 0}, {"name": "Lait", "qty": 2.5}, "pain"]})
        self.assertEqual([r["queued"] for r in out["results"]], [True, True, True, False, False, False, False])
        self.assertEqual({g["name"]: g["qty"] for g in tb.grocery}, {"Oeufs": 12, "Pain": 1})   # duplicate keeps the larger qty
        self.assertEqual(self._open_lists(), [])                                              # nothing reached the grocery module

    def test_photo_of_a_need_goes_to_a_grocery_card_not_the_stock(self) -> None:
        script = ['{"reply": "", "tools": [{"name": "propose_grocery", "args": {"lines": [{"name": "Oeufs", "qty": 12}, {"name": "Pain", "qty": 1}]}}]}',
                  '{"reply": "I added eggs and bread to a grocery draft. Confirm to put them on your list.", "tools": []}']
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        before = {i["name"]: i["qty"] for i in inv.snapshot()["items"]}
        with self.fake_generate(script):
            code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"image": _jpeg_data_url(), "intent": "grocery"})
        self.assertEqual(code, 200, out)
        self.assertEqual(out["grocery"]["lines"], [{"name": "Oeufs", "qty": 12, "unit": "", "store": ""}, {"name": "Pain", "qty": 1, "unit": "", "store": ""}])
        self.assertNotIn("operation", out)
        self.assertEqual({i["name"]: i["qty"] for i in inv.snapshot()["items"]}, before)
        self.assertEqual(self._open_lists(), [])
        self.assertIn("NEED to buy", self.calls[0][0])                                          # intent reached the model
        self.assertIn("WHERE IT GOES", self.calls[0][0])

    def test_intent_is_validated_and_only_applies_to_photos(self) -> None:
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        with self.fake_generate(['{"reply": "ok", "tools": []}'] * 3):
            ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"image": _jpeg_data_url(), "intent": "stock"})
            ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"image": _jpeg_data_url(), "intent": "rm -rf"})
            ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": "hi", "intent": "grocery"})
        self.assertIn("now HAVE", self.calls[0][0])
        self.assertNotIn("NEED to buy", self.calls[1][0])
        self.assertNotIn("PHOTO", self.calls[2][0])
        self.assertIsNone(ivo.current_intent())

    def test_to_grocery_with_lines_creates_then_appends_and_never_doubles(self) -> None:
        code, out = ivo.http_post("/api/inventoria/to-grocery", {"lines": [{"name": "Oeufs", "qty": 12, "unit": "pcs"}, {"name": "Pain", "qty": 1}]})
        self.assertEqual((code, out["appended"], out["count"]), (200, False, 2))
        first = out["list"]["id"]
        code, out = ivo.http_post("/api/inventoria/to-grocery", {"lines": [{"name": "oeufs", "qty": 12, "unit": "pcs"}, {"name": "Bananes", "qty": 6}]})
        self.assertEqual((code, out["appended"], out["list"]["id"]), (200, True, first))        # same list
        lines = {l["name"]: l["qty_milli"] for l in out["list"]["lines"]}
        self.assertEqual(lines, {"Oeufs": 12_000, "Pain": 1_000, "Bananes": 6_000})              # eggs not doubled
        self.assertEqual(len(self._open_lists()), 1)

    def test_lists_tied_to_a_meal_plan_are_never_edited(self) -> None:
        import hq_household_store as hs
        code, out = ivo.http_post("/api/inventoria/to-grocery", {"lines": [{"name": "Riz", "qty": 1}]})
        with hs.open_store(self.root) as st:
            st.conn.execute("PRAGMA foreign_keys = OFF")                                   # the plan row itself is irrelevant here
            st.conn.execute("UPDATE grocery_lists SET meal_plan_id = 'mpl-0123456789abcdef' WHERE id = ?", (out["list"]["id"],))
            st.conn.commit()
        code, out2 = ivo.http_post("/api/inventoria/to-grocery", {"lines": [{"name": "Thé", "qty": 1}]})
        self.assertEqual((code, out2["appended"]), (200, False))                                 # a fresh list instead
        self.assertNotEqual(out2["list"]["id"], out["list"]["id"])
        plan_list = [l for l in self._open_lists() if l["meal_plan_id"]][0]
        self.assertNotIn("Thé", plan_list["lines_json"])

    def test_custom_lines_are_validated(self) -> None:
        for bad in ([{"name": "", "qty": 1}], [{"name": "x", "qty": 0}], [{"name": "x", "qty": 1.5}], [{"name": "x", "qty": True}], ["x"]):
            self.assertEqual(ivo.http_post("/api/inventoria/to-grocery", {"lines": bad})[0], 400, bad)
        self.assertEqual(ivo.http_post("/api/inventoria/to-grocery", {"lines": []})[0], 409)


class ClaimGuardTests(_IntakeHelpers, _Base):
    def test_a_claim_without_a_draft_gets_one_correction_round_that_acts_for_real(self) -> None:
        script = ['{"reply": "I have added the items to your grocery list.", "tools": []}',
                  '{"reply": "", "tools": [{"name": "propose_grocery", "args": {"lines": [{"name": "Oeufs", "qty": 12}]}}]}',
                  '{"reply": "Eggs are in a grocery draft; confirm to add them.", "tools": []}']
        tb = iai.Toolbox()
        with self.fake_generate(script):
            reply, _ = iai.respond("photo of my list", [], None, toolbox=tb)
        self.assertEqual(len(self.calls), 3)
        self.assertIn("SYSTEM NOTE", json.dumps(self.calls[1][1]))
        self.assertEqual(tb.grocery[0]["name"], "Oeufs")
        self.assertIn("confirm", reply)

    def test_the_guard_runs_once_and_leaves_negative_or_already_acted_replies_alone(self) -> None:
        with self.fake_generate(['{"reply": "I have prepared a draft.", "tools": []}'] * 5):
            iai.respond("x", [], None)                                                   # keeps claiming: stops after ONE correction
        self.assertEqual(len(self.calls), 2)
        self.calls.clear()
        with self.fake_generate(['{"reply": "I could not add that; it is not in the inventory.", "tools": []}']):
            iai.respond("x", [], None)
        self.assertEqual(len(self.calls), 1)                                             # a negation is not a false claim
        self.calls.clear()
        script = ['{"reply": "", "tools": [{"name": "remember", "args": {"note": "Buys eggs by the dozen"}}]}',
                  '{"reply": "I have noted that for next time.", "tools": []}']
        with self.fake_generate(script):
            iai.respond("remember eggs by the dozen", [], None)
        self.assertEqual(len(self.calls), 2)                                             # a real memory save needs no draft
        self.calls.clear()
        script = ['{"reply": "", "tools": [{"name": "propose_changes", "args": {"changes": [{"op": "adjust", "item_name": "Vis", "delta": 2}]}}]}',
                  '{"reply": "I have prepared a draft for the screws.", "tools": []}']
        with self.fake_generate(script):
            iai.respond("add 2 screws", [], None)
        self.assertEqual(len(self.calls), 2)                                             # a real draft exists: claim is true


class DetectionTests(_IntakeHelpers, _Base):
    def setUp(self) -> None:
        super().setUp()
        inv.apply({"action": "place.create", "name": "Frigo", "kind": "shelf"})
        inv.apply({"action": "place.create", "name": "Garde-manger", "kind": "shelf"})
        self.places = {p["name"]: p["id"] for p in inv.snapshot()["places"]}
        self.mk("Lait demi-écrémé", 1, "cartons", mn=2, place=self.places["Frigo"])
        self.mk("Riz basmati", 1, "kg", mn=2, place=self.places["Garde-manger"])
        self.mk("Sauce tomate", 2, "pots", place=self.places["Garde-manger"])

    def _report(self, items, mode="add"):
        tb = iai.Toolbox()
        tb.match_called = True                                                       # the catalog step has happened
        out = tb.run("report_detections", {"mode": mode, "items": items})
        return tb, out

    def test_rows_are_matched_across_languages_placed_and_never_summed(self) -> None:
        tb, out = self._report([
            {"name": "Lait", "qty": 3, "confidence": "high"},
            {"name": "Sauce tomate bio", "qty": 4},
            {"name": "Lait", "qty": 5, "confidence": "low"},                       # same item seen twice -> one row, max qty, lowest confidence
            {"name": "Poivre noir", "qty": 1, "place": "garde-manger", "note": "partly hidden"},
            {"name": "Beurre", "qty": 2, "place": "Cave"},                         # unknown place hint -> ignored
            {"name": "", "qty": 1}, {"name": "Sucre", "qty": 0}])
        rows = {r["name"]: r for r in tb.detections}
        self.assertEqual((out["rows"], out["existing"], out["new"]), (4, 2, 2))
        lait = rows["Lait demi-écrémé"]
        self.assertEqual((lait["item_id"], lait["qty"], lait["qty_now"], lait["confidence"], lait["place"]), (
            self.by_name()["Lait demi-écrémé"]["id"], 5, 1, "low", "Frigo"))
        self.assertEqual(rows["Sauce tomate"]["qty"], 4)
        self.assertEqual((rows["Poivre noir"]["item_id"], rows["Poivre noir"]["place"], rows["Poivre noir"]["note"]), (None, "Garde-manger", "partly hidden"))
        self.assertIsNone(rows["Beurre"]["place_id"])
        self.assertEqual([r.get("queued") for r in out["results"][-2:]], [False, False])
        self.assertEqual({i["name"]: i["qty"] for i in inv.snapshot()["items"]}["Lait demi-écrémé"], 1)   # nothing applied

    def test_new_items_default_to_the_place_of_their_closest_relative(self) -> None:
        tb, _ = self._report([{"name": "Sauce pesto", "qty": 1}])
        row = tb.detections[0]
        self.assertEqual((row["item_id"], row["place"]), (None, "Garde-manger"))

    def test_photo_message_returns_an_editable_review_not_drafts(self) -> None:
        script = ['{"reply": "", "tools": [{"name": "match_items", "args": {"names": ["Lait", "Poivre"]}}, {"name": "report_detections", "args": {"photo_kind": "objects", "mode": "count", "items": [{"name": "Lait", "qty": 3}, {"name": "Poivre", "qty": 1, "confidence": "low"}]}}]}',
                  '{"reply": "I saw 2 kinds of items; counts from a photo are estimates, please check them.", "tools": []}']
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        before = {i["name"]: i["qty"] for i in inv.snapshot()["items"]}
        with self.fake_generate(list(script)):
            code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"image": _jpeg_data_url(), "intent": "stock"})
        self.assertEqual(code, 200, out)
        det = out["detections"]
        self.assertEqual(det["mode"], "add")                                         # the Master's hint wins over the model's "count"
        self.assertEqual({r["name"] for r in det["rows"]}, {"Lait demi-écrémé", "Poivre"})
        self.assertEqual({p["name"] for p in det["places"]}, {"Atelier", "Frigo", "Garde-manger"})
        self.assertNotIn("operation", out)
        self.assertEqual({i["name"]: i["qty"] for i in inv.snapshot()["items"]}, before)
        self.assertIn("report_detections", self.calls[0][0])
        self.assertIn("PHYSICAL ITEMS", self.calls[0][0])
        with self.fake_generate(list(script)):
            _, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"image": _jpeg_data_url(), "intent": "count"})
        self.assertEqual(out["detections"]["mode"], "count")
        self.assertTrue(any("IN STOCK" in c[0] for c in self.calls[2:]))

    def test_reviewed_rows_in_add_mode_become_drafts_that_commit(self) -> None:
        ids = self.by_name()
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        rows = [{"item_id": ids["Lait demi-écrémé"]["id"], "qty": 3}, {"item_id": ids["Riz basmati"]["id"], "qty": 0},
                {"name": "Poivre noir", "qty": 2, "unit": "pots", "place_id": self.places["Garde-manger"]},
                {"name": "Beurre", "qty": 1}]
        code, out = ivo.http_post("/api/inventoria/detections", {"session_id": sid, "mode": "add", "rows": rows})
        self.assertEqual(code, 200, out)
        ops = out["operations"] if "operations" in out else [out["operation"]]
        self.assertEqual([len(o["proposals"]) for o in ops], [2, 1])                 # adjust + first create, then the second create
        self.assertEqual(self.by_name()["Lait demi-écrémé"]["qty"], 1)               # still a draft
        for n, o in enumerate(ops):
            self.assertTrue(ivo.http_post(f"/api/inventoria/ops/{o['id']}/validate", {})[1]["validation"]["ok"])
            ivo.http_post(f"/api/inventoria/ops/{o['id']}/preview", {"confirm": True})
            self.assertEqual(ivo.http_post(f"/api/inventoria/ops/{o['id']}/commit", {"idempotency_key": f"detect-add-{n:05d}"})[0], 200)
        now = self.by_name()
        self.assertEqual((now["Lait demi-écrémé"]["qty"], now["Riz basmati"]["qty"], now["Poivre noir"]["qty"], now["Beurre"]["qty"]), (4, 1, 2, 1))
        self.assertEqual(now["Poivre noir"]["place"], self.places["Garde-manger"])

    def test_count_mode_sets_the_stock_and_skips_unchanged_rows(self) -> None:
        ids = self.by_name()
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        rows = [{"item_id": ids["Lait demi-écrémé"]["id"], "qty": 5}, {"item_id": ids["Sauce tomate"]["id"], "qty": 2},     # unchanged
                {"item_id": ids["Riz basmati"]["id"], "qty": 0}]                                                             # counted: none left
        code, out = ivo.http_post("/api/inventoria/detections", {"session_id": sid, "mode": "count", "rows": rows})
        self.assertEqual(code, 200, out)
        labels = [p["label_fr"] for p in out["operation"]["proposals"]]
        self.assertEqual(labels, ["Compter Lait demi-écrémé : 1 → 5", "Compter Riz basmati : 1 → 0"])
        op = out["operation"]["id"]
        ivo.http_post(f"/api/inventoria/ops/{op}/validate", {})
        ivo.http_post(f"/api/inventoria/ops/{op}/preview", {"confirm": True})
        self.assertEqual(ivo.http_post(f"/api/inventoria/ops/{op}/commit", {"idempotency_key": "detect-count-0001"})[0], 200)
        now = self.by_name()
        self.assertEqual((now["Lait demi-écrémé"]["qty"], now["Riz basmati"]["qty"], now["Sauce tomate"]["qty"]), (5, 0, 2))

    def test_detection_route_rejects_bad_rows(self) -> None:
        ids = self.by_name()
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        lait = ids["Lait demi-écrémé"]["id"]
        bad = [("add", []), ("nope", [{"name": "x", "qty": 1}]), ("add", [{"item_id": "itm-0000000000000000", "qty": 1}]),
               ("add", [{"item_id": lait, "qty": 1}, {"item_id": lait, "qty": 2}]), ("add", [{"name": "", "qty": 1}]),
               ("add", [{"name": "x", "qty": 0}]), ("add", [{"name": "x", "qty": 1}, {"name": "X", "qty": 1}]),
               ("add", [{"name": "x", "qty": 1, "place_id": "plc-0000000000000000"}]), ("add", [{"item_id": lait, "qty": -1}]),
               ("count", [{"item_id": ids["Sauce tomate"]["id"], "qty": 2}])]
        for mode, rows in bad:
            self.assertEqual(ivo.http_post("/api/inventoria/detections", {"session_id": sid, "mode": mode, "rows": rows})[0], 400, (mode, rows))
        self.assertEqual(ivo.http_post("/api/inventoria/detections", {"session_id": "nope", "mode": "add", "rows": []})[0], 400)

    def test_claim_guard_does_not_fire_after_detections(self) -> None:
        script = ['{"reply": "", "tools": [{"name": "match_items", "args": {"names": ["Lait"]}}, {"name": "report_detections", "args": {"items": [{"name": "Lait", "qty": 1}]}}]}',
                  '{"reply": "I have prepared the list of what I saw; please check it.", "tools": []}']
        with self.fake_generate(script):
            iai.respond("photo", [], None)
        self.assertEqual(len(self.calls), 2)


class DetectionDedupeTests(_IntakeHelpers, _Base):
    def test_a_stock_draft_for_the_same_items_is_dropped_when_a_review_list_exists(self) -> None:
        self.mk("Lait demi-écrémé", 1, "cartons", mn=2)
        lait = self.by_name()["Lait demi-écrémé"]["id"]
        vis = self.by_name()["Vis M3"]["id"]
        script = ['{"reply": "", "tools": [{"name": "match_items", "args": {"names": ["Lait", "Beurre"]}}, {"name": "report_detections", "args": {"mode": "add", "items": [{"name": "Lait", "qty": 2}, {"name": "Beurre", "qty": 1}]}},'
                  f' {{"name": "propose_changes", "args": {{"changes": [{{"op": "adjust", "item_id": "{lait}", "delta": 2}}, {{"op": "adjust", "item_id": "{vis}", "delta": 5}}, {{"op": "create", "name": "Beurre", "qty": 1}}]}}}}]}}',
                  '{"reply": "Reviewing the list of what I saw.", "tools": []}']
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        with self.fake_generate(script):
            code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"text": "here is what I saw and what to change"})
        self.assertEqual(code, 200, out)
        self.assertEqual({r["name"] for r in out["detections"]["rows"]}, {"Lait demi-écrémé", "Beurre"})
        labels = [p["label_fr"] for p in out["operation"]["proposals"]]
        self.assertEqual(len(labels), 1)                                     # only the unrelated Vis M3 adjustment survives
        self.assertIn("Vis M3", labels[0])


class DetectionDisciplineTests(_IntakeHelpers, _Base):
    def test_report_detections_is_refused_until_the_catalog_step_has_run(self) -> None:
        self.mk("Huile d'olive", 3, "bouteilles")
        tb = iai.Toolbox()
        first = tb.run("report_detections", {"items": [{"name": "OLIVE OIL", "qty": 1}]})
        self.assertIn("match_items", first["error"])
        self.assertEqual(tb.detections, [])
        tb.run("match_items", {"names": ["OLIVE OIL"]})
        self.assertEqual(tb.run("report_detections", {"items": [{"name": "Huile d'olive", "qty": 1}]})["existing"], 1)
        self.assertEqual(iai.Toolbox().__class__.__name__, "Toolbox")

    def test_an_empty_inventory_does_not_need_the_catalog_step(self) -> None:
        for it in inv.snapshot()["items"]:
            inv.apply({"action": "item.delete", "id": it["id"], "rev": it["rev"]})
        self.assertEqual(iai.Toolbox().run("report_detections", {"items": [{"name": "Café", "qty": 1}]})["new"], 1)

    def test_a_photo_claim_without_any_result_gets_the_correction_round(self) -> None:
        self.assertTrue(iai.claims_a_draft("I have processed the photo and updated the draft.", photo=True))
        self.assertFalse(iai.claims_a_draft("I have processed the photo and updated the draft.", photo=False))
        self.assertFalse(iai.claims_a_draft("I could not identify anything in this photo.", photo=True))
        script = ['{"reply": "I have processed the photo of your stock.", "tools": []}',
                  '{"reply": "", "tools": [{"name": "match_items", "args": {"names": ["Café"]}}, {"name": "report_detections", "args": {"photo_kind": "objects", "mode": "count", "items": [{"name": "Café", "qty": 1}]}}]}',
                  '{"reply": "I saw 1 kind of item; please check it.", "tools": []}']
        tb = iai.Toolbox()
        with self.fake_generate(script):
            iai.respond("", [], None, toolbox=tb, image={"mimeType": "image/jpeg", "data": "AAAA"})
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(tb.detections[0]["name"], "Café")


class PhotoKindGateTests(_IntakeHelpers, _Base):
    def _tb(self, image=True):
        tb = iai.Toolbox()
        tb.has_image = image
        tb.match_called = True
        return tb

    def test_with_a_photo_the_two_stock_tools_require_a_matching_photo_kind(self) -> None:
        vis = self.by_name()["Vis M3"]["id"]
        change = {"changes": [{"op": "adjust", "item_id": vis, "delta": 1}]}
        det = {"items": [{"name": "Café", "qty": 1}]}
        tb = self._tb()
        self.assertIn("photo_kind", tb.run("propose_changes", change)["error"])
        self.assertIn("photo_kind", tb.run("report_detections", det)["error"])
        self.assertIn("report_detections", tb.run("propose_changes", {**change, "photo_kind": "objects"})["error"])
        self.assertIn("only for photos of physical objects", tb.run("report_detections", {**det, "photo_kind": "receipt"})["error"])
        self.assertTrue(tb.run("propose_changes", {**change, "photo_kind": "receipt"})["results"][0]["queued"])
        self.assertEqual(tb.run("report_detections", {**det, "photo_kind": "objects"})["new"], 1)

    def test_text_only_messages_are_not_affected(self) -> None:
        vis = self.by_name()["Vis M3"]["id"]
        tb = self._tb(image=False)
        self.assertTrue(tb.run("propose_changes", {"changes": [{"op": "adjust", "item_id": vis, "delta": 1}]})["results"][0]["queued"])
        self.assertEqual(tb.run("report_detections", {"items": [{"name": "Café", "qty": 1}]})["new"], 1)

    def test_the_model_recovers_from_a_wrong_tool_choice_within_the_same_message(self) -> None:
        script = ['{"reply": "", "tools": [{"name": "match_items", "args": {"names": ["Café"]}}, {"name": "propose_changes", "args": {"photo_kind": "objects", "changes": [{"op": "create", "name": "Café", "qty": 1}]}}]}',
                  '{"reply": "", "tools": [{"name": "report_detections", "args": {"photo_kind": "objects", "mode": "add", "items": [{"name": "Café", "qty": 1}]}}]}',
                  '{"reply": "I saw 1 kind of item; please check it.", "tools": []}']
        tb = iai.Toolbox()
        with self.fake_generate(script):
            iai.respond("", [], None, toolbox=tb, image={"mimeType": "image/jpeg", "data": "AAAA"})
        self.assertEqual(tb.proposals, [])
        self.assertEqual(tb.detections[0]["name"], "Café")


class DetectionBoxTests(_IntakeHelpers, _Base):
    def test_boxes_are_validated_clamped_and_merged_with_duplicates(self) -> None:
        self.assertEqual(iai.clean_boxes([10, 20, 300, 400]), [[10, 20, 300, 400]])                  # a single flat box
        self.assertEqual(iai.clean_boxes([[-5, 0, 2000, 1000], [1, 1, 3, 3], [5, 5, 5, 50], "x", [1, 2, 3], [0, 0, 900, 900]]),
                         [[0, 0, 1000, 1000], [0, 0, 900, 900]])                                    # clamped; tiny, flat and malformed ones dropped
        self.assertEqual(iai.clean_boxes(None), [])
        self.assertEqual(len(iai.clean_boxes([[0, 0, 10, 10]] * 40)), iai.BOX_MAX)
        tb = iai.Toolbox()
        tb.match_called = True
        tb.run("report_detections", {"items": [
            {"name": "Oeufs", "qty": 2, "boxes": [[100, 100, 300, 200]]},
            {"name": "oeufs", "qty": 3, "box": [100, 300, 300, 400]},
            {"name": "Sel", "qty": 1}]})
        rows = {r["name"]: r for r in tb.detections}
        self.assertEqual(rows["Oeufs"]["boxes"], [[100, 100, 300, 200], [100, 300, 300, 400]])
        self.assertEqual((rows["Oeufs"]["qty"], rows["Sel"]["boxes"]), (3, []))

    def test_boxes_reach_the_client_inside_the_detections_payload(self) -> None:
        script = ['{"reply": "", "tools": [{"name": "match_items", "args": {"names": ["Lait"]}}, {"name": "report_detections", "args": {"photo_kind": "objects", "mode": "add", "items": [{"name": "Lait", "qty": 1, "boxes": [[10, 10, 500, 400]]}]}}]}',
                  '{"reply": "I saw one kind of item.", "tools": []}']
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        with self.fake_generate(script):
            _, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"image": _jpeg_data_url()})
        self.assertEqual(out["detections"]["rows"][0]["boxes"], [[10, 10, 500, 400]])


class LocateTests(_IntakeHelpers, _Base):
    IMG = {"mimeType": "image/jpeg", "data": "AAAA"}

    def _rows(self):
        return [{"name": "Lait demi-écrémé", "seen_as": "MILK", "qty": 2, "boxes": []}, {"name": "Oeufs", "seen_as": "EGGS", "qty": 4, "boxes": []}]

    def test_the_locate_pass_attaches_clean_boxes_by_index(self) -> None:
        rows = self._rows()
        raw = '```json\n[{"index": 1, "box_2d": [10, 20, 300, 400]}, {"index": 1, "box_2d": [10, 450, 300, 800]}, {"index": 2, "box_2d": [-9, 0, 5000, 100]}, {"index": 9, "box_2d": [1, 1, 99, 99]}, {"index": 2, "box_2d": "x"}]\n```'
        with self.fake_generate([raw]):
            iai.locate_items(self.IMG, rows)
        self.assertEqual(rows[0]["boxes"], [[10, 20, 300, 400], [10, 450, 300, 800]])
        self.assertEqual(rows[1]["boxes"], [[0, 0, 1000, 100]])                                    # clamped; out-of-range index and junk ignored
        self.assertIn("MILK", self.calls[0][1][0]["parts"][0]["text"])                              # asks about what she SAW (the label)
        self.assertTrue(any("inlineData" in p for p in self.calls[0][1][0]["parts"]))

    def test_a_failed_or_garbled_locate_pass_never_breaks_detection(self) -> None:
        for raw in ("not json at all", "{}", "[]", '{"boxes": "x"}'):
            rows = self._rows()
            with self.fake_generate([raw]):
                iai.locate_items(self.IMG, rows)
            self.assertEqual([r["boxes"] for r in rows], [[], []])
        rows = self._rows()
        with mock.patch.object(hq_ai, "generate", side_effect=hq_ai.AiError("busy", 503, "busy")):
            iai.locate_items(self.IMG, rows)
        self.assertEqual([r["boxes"] for r in rows], [[], []])
        iai.locate_items(None, self._rows())                                                      # no image / no rows: nothing happens

    def test_photo_replies_include_boxes_end_to_end(self) -> None:
        script = ['{"reply": "", "tools": [{"name": "match_items", "args": {"names": ["Lait"]}}, {"name": "report_detections", "args": {"photo_kind": "objects", "mode": "add", "items": [{"name": "Lait", "qty": 2}]}}]}',
                  '{"reply": "I saw one kind of item.", "tools": []}',
                  '[{"index": 1, "box_2d": [100, 100, 400, 300]}]']
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        with self.fake_generate(script):
            code, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"image": _jpeg_data_url()})
        self.assertEqual(code, 200, out)
        self.assertEqual(out["detections"]["rows"][0]["boxes"], [[100, 100, 400, 300]])
        self.assertEqual(len(self.calls), 3)                                                       # 2 loop rounds + 1 locate pass

    def test_boxes_the_model_already_gave_are_not_requested_again(self) -> None:
        script = ['{"reply": "", "tools": [{"name": "match_items", "args": {"names": ["Lait"]}}, {"name": "report_detections", "args": {"photo_kind": "objects", "items": [{"name": "Lait", "qty": 1, "boxes": [[1, 1, 50, 50]]}]}}]}',
                  '{"reply": "One item.", "tools": []}']
        sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]
        with self.fake_generate(script):
            _, out = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"image": _jpeg_data_url()})
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(out["detections"]["rows"][0]["boxes"], [[1, 1, 50, 50]])
