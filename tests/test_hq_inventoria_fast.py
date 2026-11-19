"""Fast logging: trusted auto-apply + one-tap undo, quick/barcode routes, nicknames, usual amounts, notification buttons."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import hq_automation
import hq_finances as fin
import hq_household_store as store
import hq_inventoria as ivo
import hq_inventoria_ai as iai
import hq_inventoria_habits as habits
import hq_inventoria_notify as notify
import hq_inventory as inv


def adjust(iid: str, delta: int, label: str = "x") -> dict:
    return {"op": "item.adjust", "refs": {"item_id": iid}, "resolved": {"confidence": "high"},
            "payload": {"id": iid, "delta": delta}, "label_fr": label}


def create(name: str) -> dict:
    return {"op": "item.create", "refs": {}, "resolved": {"confidence": "high"},
            "payload": {"name": name, "qty": 1, "unit": "pcs"}, "label_fr": f"Créer {name} (×1) (sans emplacement)"}


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="ivo-fast-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        inv.bind(root=self.root, now=lambda: 600.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0, llm_adapter=lambda text, session_id=None: {"reply": "ok"})
        inv.apply({"action": "place.create", "name": "Atelier", "kind": "shelf"})
        self.place = inv.snapshot()["places"][0]["id"]
        inv.apply({"action": "item.create", "name": "Lait", "qty": 3, "unit": "L", "min": 1, "place": self.place})
        inv.apply({"action": "item.create", "name": "Riz", "qty": 2, "unit": "kg", "min": 1, "place": self.place})
        items = {i["name"]: i["id"] for i in inv.snapshot()["items"]}
        self.lait, self.riz = items["Lait"], items["Riz"]
        self.sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]

    def tearDown(self) -> None:
        ivo.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def qty(self, iid: str) -> int:
        return next(i["qty"] for i in inv.snapshot()["items"] if i["id"] == iid)

    def turn(self, proposals: list[dict], text: str = "hello") -> tuple[int, dict]:
        ivo.bind(llm_adapter=lambda t, session_id=None: {"reply": "Noté.", "proposals": proposals})
        return ivo.http_post(f"/api/inventoria/sessions/{self.sid}/message", {"text": text})


class AutoApplyTests(_Base):
    def test_a_simple_adjust_is_applied_at_once_and_one_tap_undo_reverts_it(self) -> None:
        code, out = self.turn([adjust(self.lait, -1, "Ajuster Lait de -1")])
        self.assertEqual(code, 200, out)
        self.assertEqual(self.qty(self.lait), 2)
        self.assertNotIn("operation", out)
        (applied,) = out["applied"]
        self.assertEqual(applied["changes"][0]["before"]["qty"], 3)
        self.assertEqual(applied["changes"][0]["after"]["qty"], 2)
        op = ivo.http_get(f"/api/inventoria/ops/{applied['operation_id']}")[1]
        self.assertEqual(op["operation"]["status"], "committed")
        self.assertIn("commit", [a["action"] for a in op["audit"]])       # the audit trail is the normal one

        code, undo = ivo.http_post(f"/api/inventoria/ops/{applied['operation_id']}/undo", {"apply": True})
        self.assertEqual(code, 200, undo)
        self.assertEqual(len(undo["applied"]), 1)
        self.assertEqual(self.qty(self.lait), 3)

    def test_creates_stay_a_draft_while_the_adjusts_of_the_same_message_apply(self) -> None:
        code, out = self.turn([adjust(self.riz, 2), create("Colle")])
        self.assertEqual(code, 200, out)
        self.assertEqual(self.qty(self.riz), 4)
        self.assertEqual([p["op"] for p in out["operation"]["proposals"]], ["item.create"])
        self.assertEqual(out["operation"]["status"], "draft")

    def test_auto_apply_off_keeps_every_change_a_draft(self) -> None:
        habits.set_prefs(self.root, auto_apply=False)
        code, out = self.turn([adjust(self.lait, -1)])
        self.assertEqual(code, 200)
        self.assertNotIn("applied", out)
        self.assertEqual(out["operation"]["status"], "draft")
        self.assertEqual(self.qty(self.lait), 3)

    def test_large_or_entangled_changes_are_not_trusted(self) -> None:
        habits.set_prefs(self.root, auto_delta_max=5)
        code, out = self.turn([adjust(self.lait, 6)])
        self.assertEqual((code, "applied" in out), (200, False))
        self.assertEqual(self.qty(self.lait), 3)
        move = {"op": "item.move", "refs": {}, "resolved": {"confidence": "high"},
                "payload": {"ids": [self.riz], "place": None}, "label_fr": "Déplacer 1 article(s) vers sans emplacement"}
        code, out = self.turn([adjust(self.riz, 1), move])
        self.assertEqual((code, "applied" in out), (200, False))   # the same item is also moved: review it as one
        self.assertEqual(self.qty(self.riz), 2)

    def test_an_unreadable_habits_file_means_review_only(self) -> None:
        p = self.root / ".hq-inventoria" / "habits.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{broken", encoding="utf-8")
        code, out = self.turn([adjust(self.lait, -1)])
        self.assertEqual((code, "applied" in out), (200, False))
        self.assertEqual(p.read_text(encoding="utf-8"), "{broken")     # never overwritten

    def test_raw_proposals_posted_to_message_are_never_auto_applied(self) -> None:
        code, out = ivo.http_post(f"/api/inventoria/sessions/{self.sid}/message", {"proposals": [adjust(self.lait, -1)]})
        self.assertEqual((code, "applied" in out, self.qty(self.lait)), (200, False, 3))

    def test_ticked_off_purchases_apply_with_undo(self) -> None:
        code, out = ivo.http_post("/api/inventoria/purchased", {"session_id": self.sid, "items": [{"id": self.riz, "qty": 2}]})
        self.assertEqual(code, 200, out)
        self.assertEqual(self.qty(self.riz), 4)
        self.assertEqual(len(out["applied"]), 1)

    def test_status_and_prompt_reflect_the_apply_mode(self) -> None:
        st = ivo.status()
        self.assertTrue(st["prefs"]["auto_apply"])
        self.assertIn("APPLY MODE: AUTO", iai.build_system("lait"))
        code, out = ivo.http_post("/api/inventoria/prefs", {"auto_apply": False})
        self.assertEqual((code, out["prefs"]["auto_apply"]), (200, False))
        self.assertIn("APPLY MODE: REVIEW", iai.build_system("lait"))
        self.assertEqual(ivo.http_post("/api/inventoria/prefs", {"auto_apply": "yes"})[0], 400)


class QuickAndBarcodeTests(_Base):
    def test_quick_adjust_logs_one_item_without_the_model(self) -> None:
        code, out = ivo.http_post("/api/inventoria/quick", {"session_id": self.sid, "item_id": self.lait, "delta": -1})
        self.assertEqual(code, 200, out)
        self.assertEqual(self.qty(self.lait), 2)
        self.assertEqual(ivo.http_post("/api/inventoria/quick", {"session_id": self.sid, "item_id": "itm-nope", "delta": 1})[0], 404)
        self.assertEqual(ivo.http_post("/api/inventoria/quick", {"session_id": self.sid, "item_id": self.lait, "delta": 0})[0], 400)
        self.assertEqual(ivo.http_post("/api/inventoria/quick", {"item_id": self.lait, "delta": 1})[0], 400)

    def test_a_barcode_is_linked_once_then_looked_up(self) -> None:
        code, out = ivo.http_post("/api/inventoria/barcode", {"action": "lookup", "code": "0123456789012"})
        self.assertEqual((code, out["item"]), (200, None))
        code, out = ivo.http_post("/api/inventoria/barcode", {"action": "link", "code": "0123456789012", "item_id": self.lait})
        self.assertEqual((code, out["item"]["id"]), (200, self.lait))
        code, out = ivo.http_post("/api/inventoria/barcode", {"action": "lookup", "code": "0123456789012"})
        self.assertEqual(out["item"]["name"], "Lait")
        self.assertEqual(ivo.http_post("/api/inventoria/barcode", {"action": "lookup", "code": "<script>"})[0], 400)
        self.assertEqual(ivo.http_post("/api/inventoria/barcode", {"action": "link", "code": "0123", "item_id": "itm-x"})[0], 404)
        self.assertTrue(ivo.http_post("/api/inventoria/barcode", {"action": "unlink", "code": "0123456789012"})[1]["removed"])


class HabitTests(_Base):
    def test_nicknames_resolve_items_everywhere_and_can_be_forgotten(self) -> None:
        code, out = ivo.http_post("/api/inventoria/alias", {"action": "set", "alias": "Lolo", "item_id": self.lait})
        self.assertEqual((code, out["aliases"][0]["item_name"]), (200, "Lait"))
        snap = inv.snapshot()
        self.assertEqual(iai.resolve_item(snap, None, "lolo")["id"], self.lait)
        prop = {"op": "item.adjust", "refs": {"name_hint": "LOLO"}, "resolved": {}, "payload": {"id": self.lait, "delta": 1}, "label_fr": "x"}
        rp, issues = ivo._resolve_proposal(prop, snap)
        self.assertEqual((rp["resolved"]["item_id"], rp["resolved"]["confidence"], issues), (self.lait, "high", []))
        match = iai.Toolbox().match_items({"names": ["lolo"]})
        self.assertEqual(match["results"][0]["matches"][0]["id"], self.lait)
        self.assertIn("Lolo -> Lait", iai.build_system("lolo"))
        self.assertIn({"alias": "Lolo", "item_id": self.lait, "item_name": "Lait"}, ivo.status()["aliases"])
        self.assertEqual(ivo.http_post("/api/inventoria/alias", {"action": "remove", "alias": "lolo"})[0], 200)
        self.assertIsNone(habits.alias_item(self.root, "lolo"))

    def test_the_model_can_learn_a_nickname_as_a_side_effect(self) -> None:
        tb = iai.Toolbox()
        res = tb.run("learn_alias", {"alias": "PQ", "item_id": self.riz, "item_name": "Riz"})
        self.assertTrue(res["saved"])
        self.assertEqual(tb.side_effects, 1)
        self.assertEqual(habits.alias_item(self.root, "pq"), self.riz)

    def test_usual_amounts_are_learned_from_commits_and_shown_to_the_model(self) -> None:
        for _ in range(2):
            ivo.http_post("/api/inventoria/quick", {"session_id": self.sid, "item_id": self.lait, "delta": 2})
        self.assertEqual(habits.usual(self.root, self.lait), {"add": 2, "use": None})
        row = iai.Toolbox().get_item({"id": self.lait})
        self.assertEqual(row["usual_add"], 2)
        self.assertIn("USUAL AMOUNTS", iai.build_system("lait"))

    def test_a_new_item_gets_the_shelf_and_unit_its_name_had_before(self) -> None:
        habits.record_commit(self.root, [{"op": "item.create", "payload": {"name": "Colle", "place": self.place, "unit": "tubes"}}], inv.snapshot())
        built = iai.Toolbox()._build({"op": "create", "name": "colle", "qty": 1}, inv.snapshot())
        self.assertEqual((built["payload"].get("place"), built["payload"].get("unit")), (self.place, "tubes"))
        self.assertIn("dans Atelier", built["label_fr"])
        filled = ivo._fill_create_defaults(create("Colle"), inv.snapshot())
        self.assertEqual(filled["payload"]["place"], self.place)


class NotificationButtonTests(_Base):
    def setUp(self) -> None:
        super().setUp()
        import hq_inventoria_feel as feel
        feel.asks_set(self.root, quiet_start=0, quiet_end=0)       # these ticks use a fixed clock: no dependence on the machine's time zone

    def test_one_fresh_alert_carries_a_deep_link_and_an_add_to_list_button(self) -> None:
        notify.save_settings(self.root, enabled=True, inv=inv.snapshot())
        lait = next(i for i in inv.snapshot()["items"] if i["id"] == self.lait)
        inv.apply({"action": "item.adjust", "id": self.lait, "delta": -lait["qty"]})
        sent: list[tuple] = []

        def send(title, body, *, url="/", actions=None):
            sent.append((title, body, url, actions))
        notify.tick(self.root, send, inv=inv.snapshot(), now=1_000_000.0)
        (title, body, url, actions) = sent[0]
        self.assertEqual(url, "/#inventoria-low=" + self.lait)
        self.assertEqual([a["action"] for a in actions], ["grocery", "ignore"])
        line = actions[0]["post"]["body"]["lines"][0]
        self.assertEqual((actions[0]["post"]["url"], line["name"]), ("/api/inventoria/to-grocery", "Lait"))
        code, out = ivo.http_post("/api/inventoria/to-grocery", actions[0]["post"]["body"])   # the button's POST is a valid request
        self.assertEqual(code, 200, out)

    def test_a_plain_two_argument_sender_still_works(self) -> None:
        notify.save_settings(self.root, enabled=True, inv=inv.snapshot())
        inv.apply({"action": "item.adjust", "id": self.riz, "delta": -2})
        sent = []
        notify.tick(self.root, lambda t, b: sent.append((t, b)), inv=inv.snapshot(), now=1_000_000.0)
        self.assertTrue(sent)

    def test_push_buttons_only_keep_allowlisted_posts(self) -> None:
        out = hq_automation._push_actions([
            {"action": "grocery", "title": "Add", "post": {"url": "/api/inventoria/to-grocery", "body": {"lines": []}}},
            {"action": "evil", "title": "X", "post": {"url": "/api/settings", "body": {}}},
            {"action": "third", "title": "Y"}])
        self.assertEqual(len(out), 2)
        self.assertIn("post", out[0])
        self.assertNotIn("post", out[1])


class ClientWiringTests(unittest.TestCase):
    JS = (Path(__file__).resolve().parent.parent / "assets" / "hq-inventoria-chip.js").read_text(encoding="utf-8")
    SW = (Path(__file__).resolve().parent.parent / "assets" / "hq-sw.js").read_text(encoding="utf-8")

    def test_chip_handles_deep_links_toast_scan_and_labels(self) -> None:
        for needle in ('#inventoria-(say|place|low|open|shop)', 'opUrl(ids[i], "undo"), { apply: true }', "/api/inventoria/quick",
                       "/api/inventoria/barcode", "/assets/vendor-zxing.min.js", "/#inventoria-place=", "/api/inventoria/prefs",
                       "win.history.replaceState"):
            self.assertIn(needle, self.JS)

    def test_service_worker_allowlists_its_one_post(self) -> None:
        self.assertIn('const ACTION_POSTS = ["/api/inventoria/to-grocery"];', self.SW)
        self.assertIn("ACTION_POSTS.includes(action.post.url)", self.SW)
        self.assertIn('credentials: "same-origin"', self.SW)

    def test_vendored_decoder_is_the_pinned_file(self) -> None:
        import base64
        import hashlib
        data = (Path(__file__).resolve().parent.parent / "assets" / "vendor-zxing.min.js").read_bytes()
        self.assertEqual(base64.b64encode(hashlib.sha256(data).digest()).decode(), "18yPad1wvc86wAya5XK/KsufQTK6N5xy34QuTbkYZS0=")


if __name__ == "__main__":
    unittest.main()
