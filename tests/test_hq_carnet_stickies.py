"""Carnet Phase 16D — sticky notes store (hq_carnet_stickies.py): validation, limits, revisions, page checks, file safety,
backup inclusion and the HTTP routes. Throwaway ROOTs only. Browser behaviour: tests/visual_carnet_16c_playwright.py."""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_carnet  # noqa: E402
import hq_carnet_stickies as stk  # noqa: E402
from test_hq_carnet import CarnetBase  # noqa: E402


class StickiesBase(CarnetBase):
    def setUp(self):
        super().setUp()
        saved = dict(stk._cb)
        self.addCleanup(lambda: (stk._cb.clear(), stk._cb.update(saved)))
        hq_carnet.bind(root=self.tmp, now=lambda: self.clock[0])
        nb = hq_carnet.get_notebook()
        self.page_id = nb["pages"][0]["id"]
        self.file = self.tmp / ".hq-carnet" / "stickies.json"

    def post(self, **data):
        return stk.http_post(data)

    def make(self, **extra):
        code, out = self.post(action="create", page_id=self.page_id, **extra)
        self.assertEqual(code, 200, out)
        return out["note"]


class CreateTests(StickiesBase):
    def test_create_defaults_and_file(self):
        n = self.make(text="Rappel : couple 25 N·m")
        self.assertRegex(n["id"], r"^stk-[0-9a-f]{24}$")
        self.assertEqual((n["color"], n["x"], n["y"], n["w"], n["z"], n["rev"], n["collapsed"]), ("yellow", 0.5, 40, 230, 1, 1, False))
        disk = json.loads(self.file.read_text(encoding="utf-8"))
        self.assertEqual(disk["rev"], 1)
        self.assertEqual(disk["notes"][0]["text"], "Rappel : couple 25 N·m")
        self.assertNotIn("stickies", self.disk(), "never written into notebook.json")

    def test_z_stacks_on_page(self):
        a, b = self.make(), self.make()
        self.assertEqual((a["z"], b["z"]), (1, 2))

    def test_validation(self):
        for bad in ({"x": 1.5}, {"x": -0.1}, {"y": -1}, {"w": 50}, {"color": "red"}, {"text": 3}, {"collapsed": "no"},
                    {"text": "x" * (stk.TEXT_MAX + 1)}, {"evil": 1}, {"x": float("nan")}, {"x": True}):
            code, out = self.post(action="create", page_id=self.page_id, **bad)
            self.assertEqual(code, 400, (bad, out))
        self.assertFalse(self.file.exists(), "nothing written on refusal")

    def test_control_chars_stripped_newlines_kept(self):
        n = self.make(text="a\x00b\r\nc\td\x1b")
        self.assertEqual(n["text"], "ab\nc\td")

    def test_unknown_and_trashed_page(self):
        code, out = self.post(action="create", page_id="page-nope")
        self.assertEqual((code, out["code"]), (404, "not_found"))
        code, _ = self.post(action="create", page_id="../x")
        self.assertEqual(code, 400)
        nb = hq_carnet.get_notebook()
        page = nb["pages"][0]
        hq_carnet.mutate({"action": "page_trash", "id": page["id"], "expected_rev": page["rev"], "expected_notebook_rev": nb["notebook_rev"]})
        code, out = self.post(action="create", page_id=page["id"])
        self.assertEqual((code, out["code"]), (409, "trashed"))

    def test_per_page_limit(self):
        for _ in range(stk.PER_PAGE_MAX):
            self.make()
        code, out = self.post(action="create", page_id=self.page_id)
        self.assertEqual((code, out["code"]), (409, "limit"))


class UpdateDeleteTests(StickiesBase):
    def test_update_and_rev(self):
        n = self.make()
        code, out = self.post(action="update", id=n["id"], rev=1, text="neuf", x=0.1, y=300, color="blue", w=300, collapsed=True)
        self.assertEqual(code, 200, out)
        m = out["note"]
        self.assertEqual((m["text"], m["x"], m["y"], m["color"], m["w"], m["collapsed"], m["rev"]), ("neuf", 0.1, 300, "blue", 300, True, 2))

    def test_stale_rev_is_refused_and_returns_current(self):
        n = self.make()
        self.post(action="update", id=n["id"], rev=1, text="appareil A")
        code, out = self.post(action="update", id=n["id"], rev=1, text="appareil B")
        self.assertEqual((code, out["code"]), (409, "conflict"))
        self.assertEqual(out["note"]["text"], "appareil A")
        self.assertEqual(json.loads(self.file.read_text(encoding="utf-8"))["notes"][0]["text"], "appareil A")

    def test_rev_required_for_update(self):
        n = self.make()
        code, _ = self.post(action="update", id=n["id"], text="x")
        self.assertEqual(code, 400)

    def test_noop_update_does_not_write(self):
        n = self.make(text="t")
        before = self.file.read_bytes()
        code, out = self.post(action="update", id=n["id"], rev=1, text="t")
        self.assertTrue(out.get("unchanged"))
        self.assertEqual(self.file.read_bytes(), before)

    def test_front(self):
        a, b = self.make(), self.make()
        code, out = self.post(action="update", id=a["id"], rev=1, front=True)
        self.assertEqual(out["note"]["z"], 3)
        code, out = self.post(action="update", id=b["id"], rev=1, front=False)
        self.assertEqual(code, 400)

    def test_delete(self):
        n = self.make(text="bye")
        code, out = self.post(action="delete", id=n["id"], rev=1)
        self.assertEqual((code, out["deleted"], out["note"]["text"]), (200, n["id"], "bye"))
        code, out = self.post(action="delete", id=n["id"])
        self.assertEqual(code, 404)

    def test_delete_stale_rev(self):
        n = self.make()
        self.post(action="update", id=n["id"], rev=1, text="changed")
        code, out = self.post(action="delete", id=n["id"], rev=1)
        self.assertEqual(code, 409)
        self.assertEqual(len(json.loads(self.file.read_text(encoding="utf-8"))["notes"]), 1)


class ReadAndFileTests(StickiesBase):
    def test_list_by_page_and_since(self):
        self.make(text="a")
        code, out = stk.http_get({"page": [self.page_id]})
        self.assertEqual((code, len(out["notes"]), out["rev"]), (200, 1, 1))
        code, out = stk.http_get({"since": ["1"]})
        self.assertTrue(out.get("unchanged"))
        code, out = stk.http_get({"since": ["0"]})
        self.assertEqual(len(out["notes"]), 1)
        for bad in ({"page": ["x"]}, {"since": ["-1"]}, {"what": ["1"]}, {"page": [self.page_id, self.page_id]}):
            self.assertEqual(stk.http_get(bad)[0], 400, bad)

    def test_empty_when_absent(self):
        code, out = stk.http_get({})
        self.assertEqual((code, out["rev"], out["notes"]), (200, 0, []))

    def test_malformed_file_is_never_rewritten(self):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_bytes(b"{broken")
        code, out = self.post(action="create", page_id=self.page_id)
        self.assertEqual(code, 503)
        self.assertEqual(self.file.read_bytes(), b"{broken")
        self.assertEqual(stk.http_get({})[0], 503)

    @unittest.skipIf(os.name == "nt", "symlinks need privileges on Windows")
    def test_redirected_file_refused(self):
        outside = self.tmp / "outside.json"
        outside.write_text(json.dumps({"version": 1, "rev": 0, "notes": []}), encoding="utf-8")
        self.file.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(outside, self.file)
        code, _ = self.post(action="create", page_id=self.page_id)
        self.assertEqual(code, 503)

    def test_unknown_action(self):
        self.assertEqual(self.post(action="nuke")[0], 400)
        self.assertEqual(stk.http_post([1])[0], 400)

    def test_backup_includes_stickies(self):
        self.make(text="garde-moi")
        dest = self.tmp / "bk"
        rep = hq_carnet.snapshot_to(self.tmp, dest)
        self.assertTrue(rep.get("ok"), rep)
        self.assertIn("garde-moi", (dest / "stickies.json").read_text(encoding="utf-8"))


class HttpTests(unittest.TestCase):
    def test_routes_are_wired(self):
        src = (Path(__file__).resolve().parents[1] / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertEqual(src.count('raw == "/api/carnet/stickies"'), 2)
        self.assertIn('<script src="/assets/hq-carnet-stickies.js"></script>', src)
        self.assertIn('<script src="/assets/hq-carnet-sizing.js"></script>', src)
        self.assertIn('<script src="/assets/hq-carnet-feel.js"></script>', src)
        self.assertLess(src.index("hq-carnet-sizing.js"), src.index("hq-carnet-feel.js"))


if __name__ == "__main__":
    unittest.main()
