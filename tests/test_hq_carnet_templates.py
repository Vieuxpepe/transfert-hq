"""Carnet product phase 1 — server side of templates / Quick Capture: ``page_create`` with ``content``.

Offline only: throwaway temp ROOTs. The new field is an additive, optional, server-validated part of the EXISTING action:
the page is born with its content or not at all.
"""

from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_rich as rich  # noqa: E402
from test_hq_carnet import CarnetBase, _fixture, _page  # noqa: E402


def b(kind="paragraph", text="", **extra):
    out = {"type": kind, "text": text, "marks": []}
    out.update(extra)
    return out


def v2(*blocks):
    return {"version": 2, "blocks": list(blocks)}


TEMPLATE = v2(b("heading", "Inspection — 2026-10-01"), b("heading", "Objet"), b(), b("heading", "Observations"), b("bullet"), b("check"))


class PageCreateContentTests(CarnetBase):
    def setUp(self):
        super().setUp()
        self.seed(_fixture())
        self.rev = self.disk()["notebook_rev"]

    def create(self, **over):
        payload = {"action": "page_create", "expected_notebook_rev": self.rev}
        payload.update(over)
        return hq_carnet.mutate(payload)

    def test_page_is_born_with_content_and_fresh_unique_ids(self):
        out = self.create(content=TEMPLATE)
        page = self.page(out["page"]["id"])
        self.assertEqual([x["type"] for x in page["content"]["blocks"]], [x["type"] for x in TEMPLATE["blocks"]])
        ids = [x["id"] for x in page["content"]["blocks"]]
        self.assertTrue(all(i.startswith("block-") for i in ids))
        self.assertEqual(len(set(ids)), len(ids))
        every = [x["id"] for p in self.disk()["pages"] for x in p["content"]["blocks"]]
        self.assertEqual(len(set(every)), len(every), "unique across the notebook")
        self.assertEqual(self.disk()["notebook_rev"], self.rev + 1)
        self.assertEqual(page["rev"], 1)
        self.assertEqual(hq_carnet.derive_title(rich.flat_text(page["content"])), "Inspection — 2026-10-01")
        self.assert_no_residue()

    def test_two_creations_never_share_ids(self):
        a = self.create(content=TEMPLATE)
        self.rev += 1
        c = self.create(content=TEMPLATE)
        ia = {x["id"] for x in self.page(a["page"]["id"])["content"]["blocks"]}
        ic = {x["id"] for x in self.page(c["page"]["id"])["content"]["blocks"]}
        self.assertFalse(ia & ic)

    def test_without_content_behaviour_is_unchanged(self):
        out = self.create()
        self.assertEqual(len(self.page(out["page"]["id"])["content"]["blocks"]), 1)
        self.assertEqual(self.page(out["page"]["id"])["content"]["blocks"][0]["text"], "")

    def test_project_category_and_position_are_honoured(self):
        out = self.create(content=TEMPLATE, project_id="proj-fixture", category_id="cat-measures", after_id="page-shaft")
        page = self.page(out["page"]["id"])
        self.assertEqual((page["project_id"], page["category_id"]), ("proj-fixture", "cat-measures"))
        ids = [p["id"] for p in self.disk()["pages"]]
        self.assertEqual(ids.index(page["id"]), ids.index("page-shaft") + 1)

    def assert_untouched(self, raw):
        self.assertEqual(self.path.read_bytes(), raw, "a refused creation writes nothing")
        self.assert_no_residue()

    def test_invalid_content_creates_nothing_and_does_not_bump_the_revision(self):
        raw = self.path.read_bytes()
        bad = [
            "text",
            {},
            {"version": 2},
            {"version": 2, "blocks": []},
            v2(b("nope", "x")),
            v2(b("paragraph", "a\nb")),
            v2(b("paragraph", "x", marks=[{"type": "bold", "start": 0, "end": 9}])),
            v2(b("image", "", asset={"id": "asset-" + "0" * 24, "mime": "image/jpeg", "w": 1, "h": 1, "width": 100, "layout": "inline", "caption": ""})),  # unknown asset
            v2(dict(b(), extra=1)),
        ]
        for content in bad:
            with self.subTest(content=str(content)[:60]):
                with self.assertRaises(hq_carnet.CarnetError):
                    self.create(content=content)
                self.assert_untouched(raw)

    def test_stale_revision_and_unknown_neighbours_create_nothing(self):
        raw = self.path.read_bytes()
        with self.assertRaises((hq_carnet.CarnetError, hq_carnet.CarnetConflict)):
            self.create(content=TEMPLATE, expected_notebook_rev=self.rev + 5)
        with self.assertRaises(hq_carnet.CarnetError):
            self.create(content=TEMPLATE, after_id="page-nope")
        with self.assertRaises(hq_carnet.CarnetError):
            self.create(content=TEMPLATE, project_id="proj-nope")
        self.assert_untouched(raw)

    def test_page_limit_is_enforced_with_content(self):
        state = _fixture()
        state["pages"] = [_page(f"page-p{i:03d}", f"t{i}") for i in range(hq_carnet.PAGES_ACTIVE_MAX)]
        self.seed(state)
        raw = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetError):
            self.create(content=TEMPLATE)
        self.assert_untouched(raw)

    def test_per_page_block_limit(self):
        raw = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetError):
            self.create(content=v2(*[b() for _ in range(rich.BLOCKS_MAX + 1)]))
        self.assert_untouched(raw)

    def test_notebook_block_budget_counts_the_blank_block_and_the_new_content(self):
        raw = self.path.read_bytes()
        total = hq_carnet._total_blocks(self.disk())
        # room for the blank block only (+1): the six template blocks must not fit
        with mock.patch.object(rich, "NOTEBOOK_BLOCKS_MAX", total + 1 + (len(TEMPLATE["blocks"]) - 2)):
            with self.assertRaises(hq_carnet.CarnetError):
                self.create(content=TEMPLATE)
        with mock.patch.object(rich, "NOTEBOOK_BLOCKS_MAX", total + len(TEMPLATE["blocks"])):
            self.create(content=TEMPLATE)  # exactly fits
        self.path.write_bytes(raw)
        self.assert_untouched(raw)

    def test_page_text_and_notebook_text_byte_limits(self):
        raw = self.path.read_bytes()
        big = v2(*[b("paragraph", "é" * 1000) for _ in range(30)])  # > 48 KiB of UTF-8
        with self.assertRaises(hq_carnet.CarnetError):
            self.create(content=big)
        self.assert_untouched(raw)
        with mock.patch.object(hq_carnet, "NOTEBOOK_TEXT_BYTES", 10):
            with self.assertRaises(hq_carnet.CarnetError):
                self.create(content=v2(b("paragraph", "x" * 50)))
        self.assert_untouched(raw)

    def test_export_of_a_template_page_is_deterministic(self):
        (self.tmp / "Inbox").mkdir()
        out = self.create(content=TEMPLATE)
        pid = out["page"]["id"]
        rev = self.page(pid)["rev"]
        res = hq_carnet.export_copy({"action": "page_export", "id": pid, "expected_rev": rev, "format": "md", "dir": "Inbox", "filename": "insp.md"})
        text = (self.tmp / res["path"]).read_text(encoding="utf-8")
        self.assertTrue(text.startswith("## Inspection — 2026-10-01\n"))
        self.assertIn("- [ ]", text)
        self.assertNotIn(str(self.tmp), json.dumps(res), "no absolute path exposed")

    def test_http_round_trip_and_unknown_keys(self):
        code, payload = hq_carnet.http_post({"action": "page_create", "expected_notebook_rev": self.rev, "content": TEMPLATE})
        self.assertEqual(code, 200, payload)
        code, payload = hq_carnet.http_post({"action": "page_create", "expected_notebook_rev": self.rev + 1, "content": TEMPLATE, "rev": 7})
        self.assertEqual(code, 400)
        code, payload = hq_carnet.http_post({"action": "page_create", "expected_notebook_rev": self.rev + 1, "content": "x" * 10})
        self.assertEqual(code, 400)
        self.assertEqual(len(self.disk()["pages"]), len(_fixture()["pages"]) + 1)

    def test_request_id_makes_a_retry_return_the_original_page(self):
        first = self.create(content=TEMPLATE, request_id="cap-0123456789abcdef")
        self.assertNotIn("duplicate", first)
        pages = len(self.disk()["pages"])
        rev = self.disk()["notebook_rev"]
        raw = self.path.read_bytes()
        # the retry carries a STALE notebook_rev (it was read before the lost response) — still answered, never a second page
        again = self.create(content=TEMPLATE, request_id="cap-0123456789abcdef", expected_notebook_rev=self.rev)
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["page"]["id"], first["page"]["id"])
        self.assertEqual(again["notebook_rev"], rev)
        self.assertEqual(len(self.disk()["pages"]), pages)
        self.assertEqual(self.path.read_bytes(), raw, "a duplicate request writes nothing")

    def test_request_id_is_bound_to_the_exact_request(self):
        self.create(content=TEMPLATE, request_id="cap-bound-0001")
        rev = self.disk()["notebook_rev"]
        for over in ({"content": v2(b("paragraph", "autre"))}, {"project_id": "proj-fixture"}, {"category_id": "cat-measures"}):
            with self.subTest(over=list(over)):
                payload = {"content": TEMPLATE, "request_id": "cap-bound-0001", "expected_notebook_rev": rev}
                payload.update(over)
                with self.assertRaises(hq_carnet.CarnetError):
                    self.create(**payload)
        self.assertEqual(self.disk()["notebook_rev"], rev)

    def test_two_concurrent_same_title_captures_stay_distinct(self):
        a = self.create(content=TEMPLATE, request_id="cap-same-title-A1")
        b2 = self.create(content=TEMPLATE, request_id="cap-same-title-B1", expected_notebook_rev=self.rev + 1)
        self.assertNotEqual(a["page"]["id"], b2["page"]["id"])
        self.assertTrue(self.create(content=TEMPLATE, request_id="cap-same-title-A1", expected_notebook_rev=self.rev)["duplicate"])
        self.assertEqual(self.create(content=TEMPLATE, request_id="cap-same-title-B1", expected_notebook_rev=self.rev)["page"]["id"], b2["page"]["id"])

    def test_request_id_validation_and_refused_requests_are_not_remembered(self):
        for bad in ("short", "x" * 65, "has space!!", 5, ""):
            with self.subTest(bad=bad):
                with self.assertRaises(hq_carnet.CarnetError):
                    self.create(content=TEMPLATE, request_id=bad)
        with self.assertRaises(hq_carnet.CarnetError):
            self.create(content=v2(b("nope")), request_id="cap-refused-0001")
        # the refused id is free: the same id with valid content now creates exactly one page
        ok = self.create(content=v2(b("paragraph", "ok")), request_id="cap-refused-0001")
        self.assertNotIn("duplicate", ok)

    def test_committed_id_never_recreates_after_permanent_delete(self):
        first = self.create(content=TEMPLATE, request_id="cap-gone-00001")
        pid = first["page"]["id"]
        rev = self.page(pid)["rev"]
        hq_carnet.mutate({"action": "page_trash", "id": pid, "expected_rev": rev, "expected_notebook_rev": self.disk()["notebook_rev"]})
        hq_carnet.mutate({"action": "page_delete_permanent", "id": pid, "expected_rev": self.page(pid)["rev"], "expected_notebook_rev": self.disk()["notebook_rev"]})
        self.assertFalse(any(p["id"] == pid for p in self.disk()["pages"]))
        raw = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetConflict) as cm:
            self.create(content=TEMPLATE, request_id="cap-gone-00001", expected_notebook_rev=self.disk()["notebook_rev"])
        self.assertEqual(cm.exception.payload["code"], "request_result_gone")
        self.assertEqual(self.path.read_bytes(), raw, "nothing resurrected, nothing written")
        # the HTTP layer reports a controlled 409
        code, payload = hq_carnet.http_post({"action": "page_create", "expected_notebook_rev": self.disk()["notebook_rev"], "content": TEMPLATE, "request_id": "cap-gone-00001"})
        self.assertEqual((code, payload.get("code")), (409, "request_result_gone"))
        # an explicit NEW attempt (new id) still works
        self.assertNotIn("duplicate", self.create(content=TEMPLATE, request_id="cap-gone-00002", expected_notebook_rev=self.disk()["notebook_rev"]))

    def test_trashed_page_retry_returns_the_same_trashed_page(self):
        first = self.create(content=TEMPLATE, request_id="cap-trash-0001")
        pid = first["page"]["id"]
        hq_carnet.mutate({"action": "page_trash", "id": pid, "expected_rev": self.page(pid)["rev"], "expected_notebook_rev": self.disk()["notebook_rev"]})
        pages = len(self.disk()["pages"])
        again = self.create(content=TEMPLATE, request_id="cap-trash-0001", expected_notebook_rev=self.disk()["notebook_rev"])
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["page"]["id"], pid)
        self.assertIsNotNone(again["page"]["deleted_at"])
        self.assertEqual(len(self.disk()["pages"]), pages)

    def test_failed_write_releases_the_request_id(self):
        with mock.patch.object(hq_carnet, "_write", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.create(content=TEMPLATE, request_id="cap-wfail-0001")
        self.assertNotIn("cap-wfail-0001", hq_carnet._create_seen)
        self.assertEqual(len(self.disk()["pages"]), len(_fixture()["pages"]), "nothing persisted")
        ok = self.create(content=TEMPLATE, request_id="cap-wfail-0001")  # the SAME id may legitimately create now
        self.assertNotIn("duplicate", ok)
        self.assertIn("cap-wfail-0001", hq_carnet._create_seen)

    def test_page_save_behaviour_unchanged_by_the_refactor(self):
        out = self.create()
        pid = out["page"]["id"]
        saved = hq_carnet.mutate({"action": "page_save", "id": pid, "expected_rev": 1, "content": TEMPLATE})
        self.assertEqual(saved["page"]["rev"], 2)
        same = hq_carnet.mutate({"action": "page_save", "id": pid, "expected_rev": 2, "content": copy.deepcopy(self.page(pid)["content"])})
        self.assertEqual(same["page"]["rev"], 2, "an identical save stays a no-op")


if __name__ == "__main__":
    unittest.main()
