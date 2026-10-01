"""Carnet Stage 01 — storage, domain, HTTP API, backup.

Offline only: throwaway temp ROOTs, no live C:\\Transfert, no live :8765.
Fixtures come from docs/carnet-agents/FIXTURES.md.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

import cc_ext
import hq_carnet
import hq_carnet_rich
import hq_state
import iphone_bridge

NOW = 1790690000.0

FIXTURE = {
    "version": 1,
    "notebook_rev": 4,
    "projects": [
        {
            "id": "proj-fixture",
            "name": "Fixture redesign",
            "archived": False,
            "created_at": 1790680000.0,
            "updated_at": 1790680000.0,
        }
    ],
    "categories": [
        {
            "id": "cat-measures",
            "name": "Mesures",
            "color": "amber",
            "created_at": 1790680000.0,
            "updated_at": 1790680000.0,
        }
    ],
    "pages": [
        {
            "id": "page-shaft",
            "rev": 3,
            "project_id": "proj-fixture",
            "category_id": "cat-measures",
            "pinned": True,
            "deleted_at": None,
            "created_at": 1790680010.0,
            "updated_at": 1790680300.0,
            "content": {
                "version": 1,
                "blocks": [
                    {
                        "id": "block-shaft",
                        "type": "text",
                        "text": "Shaft inspection\nØ12.034 mm\nCheck bearing preload",
                        "marks": [],
                    }
                ],
            },
        },
        {
            "id": "page-idea",
            "rev": 1,
            "project_id": None,
            "category_id": None,
            "pinned": False,
            "deleted_at": None,
            "created_at": 1790680400.0,
            "updated_at": 1790680400.0,
            "content": {
                "version": 1,
                "blocks": [{"id": "block-idea", "type": "text", "text": "Try a split clamp instead", "marks": []}],
            },
        },
    ],
}

MALFORMED = b"{ this is not valid json"


def _file_symlink(target: Path, link: Path) -> None:
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError, AttributeError) as e:
        raise unittest.SkipTest(f"file symlinks unavailable here ({type(e).__name__}: needs privilege/Developer Mode on Windows)")


def _dir_symlink(target: Path, link: Path) -> None:
    try:
        os.symlink(target, link, target_is_directory=True)
    except (OSError, NotImplementedError, AttributeError) as e:
        raise unittest.SkipTest(f"directory symlinks unavailable here ({type(e).__name__})")


def _fixture() -> dict:
    return json.loads(json.dumps(FIXTURE))


def _content(text: str, block_id: str | None = None) -> dict:
    block = {"type": "text", "text": text, "marks": []}
    if block_id:
        block["id"] = block_id
    return {"version": 1, "blocks": [block]}


def _page(page_id: str, text: str = "", *, deleted_at=None) -> dict:
    return {
        "id": page_id,
        "rev": 1,
        "project_id": None,
        "category_id": None,
        "pinned": False,
        "deleted_at": deleted_at,
        "created_at": 1.0,
        "updated_at": 1.0,
        "content": {"version": 1, "blocks": [{"id": "block-" + page_id[5:], "type": "text", "text": text, "marks": []}]},
    }


class CarnetBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-carnet-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        saved_cb, saved_ready = dict(hq_carnet._cb), hq_carnet._ready

        def restore():
            hq_carnet._cb.clear()
            hq_carnet._cb.update(saved_cb)
            hq_carnet._ready = saved_ready

        self.addCleanup(restore)
        self.clock = [NOW]
        hq_carnet.bind(root=self.tmp, now=lambda: self.clock[0])
        self.path = self.tmp / ".hq-carnet" / "notebook.json"

    def seed(self, state: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")

    def disk(self) -> dict:
        return json.loads(self.path.read_text(encoding="utf-8"))

    def page(self, page_id: str) -> dict:
        return next(p for p in self.disk()["pages"] if p["id"] == page_id)

    def save(self, page_id: str, rev: int, text: str, **extra) -> dict:
        return hq_carnet.mutate({"action": "page_save", "id": page_id, "expected_rev": rev, "content": _content(text), **extra})

    def assert_no_residue(self):
        # Stage 08: a trash/restore/delete also appends a metadata-only lifecycle event to history.json (never a temp file)
        self.assertEqual([f for f in sorted(os.listdir(self.path.parent)) if f != "history.json"], ["notebook.json"])


class InitTests(CarnetBase):
    def test_init_path_and_default_page(self):
        self.assertFalse(self.path.exists())
        data = hq_carnet.get_notebook()
        self.assertTrue(self.path.is_file())
        self.assertEqual(hq_carnet.notebook_path(self.tmp), Path(os.path.abspath(self.tmp)) / ".hq-carnet" / "notebook.json")
        self.assertEqual(data["version"], 1)
        self.assertEqual(data["notebook_rev"], 1)
        self.assertEqual(len(data["pages"]), 1)
        page = data["pages"][0]
        self.assertRegex(page["id"], r"^page-[0-9a-f]{24}$")
        self.assertRegex(page["content"]["blocks"][0]["id"], r"^block-[0-9a-f]{24}$")
        self.assertEqual(page["content"]["blocks"][0]["text"], "")
        self.assertEqual((page["created_at"], page["updated_at"], page["deleted_at"]), (NOW, NOW, None))
        self.assertEqual(data["limits"]["page_text_bytes"], 49152)
        self.assertEqual(data["limits"]["notebook_text_bytes"], 1048576)
        self.assertEqual(data["limits"]["categories"], 24)
        self.assertNotIn("title", page)  # derived title is never persisted
        self.assertNotIn("title", self.disk()["pages"][0])
        again = hq_carnet.get_notebook()
        self.assertEqual(again["pages"][0]["id"], page["id"])
        meta = hq_carnet.get_notebook(meta=True)
        self.assertEqual(meta["pages"][0]["title"], "Page sans titre")
        self.assert_no_residue()

    def test_meta_titles_and_no_body(self):
        self.seed(_fixture())
        meta = hq_carnet.get_notebook(meta=True)
        titles = {p["id"]: p["title"] for p in meta["pages"]}
        self.assertEqual(titles, {"page-shaft": "Shaft inspection", "page-idea": "Try a split clamp instead"})
        for item in meta["pages"]:
            self.assertNotIn("content", item)
            self.assertEqual(
                set(item),
                {"id", "rev", "project_id", "category_id", "pinned", "deleted_at", "created_at", "updated_at", "title", "preview"},
            )
        shaft = next(p for p in meta["pages"] if p["id"] == "page-shaft")
        self.assertEqual(shaft["preview"], "Ø12.034 mm Check bearing preload")
        self.assertEqual(hq_carnet.derive_title("\n  \n  Ébauche moteur \nx"), "Ébauche moteur")
        self.assertLessEqual(len(hq_carnet.derive_preview("t\n" + "x" * 5000)), hq_carnet.PREVIEW_MAX)


class PageTests(CarnetBase):
    def setUp(self):
        super().setUp()
        self.seed(_fixture())

    def test_create_order_and_server_fields(self):
        out = hq_carnet.mutate(
            {"action": "page_create", "expected_notebook_rev": 4, "after_id": "page-shaft", "category_id": "cat-measures"}
        )
        self.assertEqual(out["notebook_rev"], 5)
        page = out["page"]
        self.assertRegex(page["id"], r"^page-[0-9a-f]{24}$")
        self.assertEqual((page["rev"], page["created_at"], page["category_id"]), (1, NOW, "cat-measures"))
        self.assertEqual([p["id"] for p in self.disk()["pages"]], ["page-shaft", page["id"], "page-idea"])
        out = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 5})
        self.assertEqual(self.disk()["pages"][-1]["id"], out["page"]["id"])
        with self.assertRaises(hq_carnet.CarnetNotFound):
            hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 6, "after_id": "page-nope"})

    def test_save_bumps_page_rev_only(self):
        self.clock[0] = NOW + 5
        out = self.save("page-idea", 1, "Split clamp v2", pinned=True)
        self.assertEqual(out["notebook_rev"], 4)
        self.assertEqual((out["page"]["rev"], out["page"]["updated_at"], out["page"]["pinned"]), (2, NOW + 5, True))
        self.assertEqual(out["page"]["created_at"], 1790680400.0)
        self.assertEqual(self.page("page-idea")["content"]["blocks"][0]["text"], "Split clamp v2")
        # block id may be sent and must match
        out = hq_carnet.mutate(
            {"action": "page_save", "id": "page-idea", "expected_rev": 2, "content": _content("v3", "block-idea")}
        )
        self.assertEqual(out["page"]["rev"], 3)
        # identical save is a no-op: no rev bump
        out = self.save("page-idea", 3, "v3")
        self.assertEqual(out["page"]["rev"], 3)

    def test_stale_save_conflict_no_disk_change(self):
        self.save("page-shaft", 3, "Shaft inspection\nclient B")
        before = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetConflict) as ctx:
            self.save("page-shaft", 3, "client A text")
        payload = ctx.exception.payload
        self.assertEqual(payload["code"], "revision_conflict")
        self.assertEqual(payload["error"], "Page modifiée ailleurs")
        self.assertEqual(payload["page"]["id"], "page-shaft")
        self.assertEqual(payload["page"]["rev"], 4)
        self.assertEqual(hq_carnet_rich.flat_text(payload["page"]["content"]), "Shaft inspection\nclient B")
        self.assertEqual(payload["notebook_rev"], 4)
        self.assertEqual(self.path.read_bytes(), before)

    def test_different_pages_independent(self):
        a = self.save("page-shaft", 3, "A edit")
        b = self.save("page-idea", 1, "B edit")
        self.assertEqual((a["page"]["rev"], b["page"]["rev"]), (4, 2))
        # a structural change does not make an ordinary page save stale
        hq_carnet.mutate({"action": "category_create", "expected_notebook_rev": 4, "name": "Idées", "color": "teal"})
        self.assertEqual(self.save("page-idea", 2, "B again")["page"]["rev"], 3)

    def test_trash_restore_delete_and_final_page_invariant(self):
        out = hq_carnet.mutate({"action": "page_trash", "id": "page-idea", "expected_rev": 1, "expected_notebook_rev": 4})
        self.assertEqual((out["page"]["deleted_at"], out["page"]["rev"], out["notebook_rev"]), (NOW, 2, 5))
        self.assertNotIn("replacement_page", out)
        with self.assertRaises(hq_carnet.CarnetError):  # trashed notes are read-only
            self.save("page-idea", 2, "edit in trash")
        with self.assertRaises(hq_carnet.CarnetConflict) as ctx:  # stale structural rev
            hq_carnet.mutate({"action": "page_trash", "id": "page-shaft", "expected_rev": 3, "expected_notebook_rev": 4})
        self.assertEqual(ctx.exception.payload, {"error": "Carnet modifié ailleurs", "code": "notebook_revision_conflict", "notebook_rev": 5})
        out = hq_carnet.mutate({"action": "page_trash", "id": "page-shaft", "expected_rev": 3, "expected_notebook_rev": 5})
        blank = out["replacement_page"]
        self.assertEqual(blank["content"]["blocks"][0]["text"], "")
        active = [p for p in self.disk()["pages"] if p["deleted_at"] is None]
        self.assertEqual([p["id"] for p in active], [blank["id"]])
        with self.assertRaises(hq_carnet.CarnetError):  # permanent delete needs trash first
            hq_carnet.mutate({"action": "page_delete_permanent", "id": blank["id"], "expected_rev": 1, "expected_notebook_rev": 6})
        out = hq_carnet.mutate({"action": "page_restore", "id": "page-idea", "expected_rev": 2, "expected_notebook_rev": 6})
        self.assertEqual((out["page"]["deleted_at"], out["page"]["rev"]), (None, 3))
        self.assertEqual(self.page("page-idea")["content"]["blocks"][0]["text"], "Try a split clamp instead")
        out = hq_carnet.mutate({"action": "page_delete_permanent", "id": "page-shaft", "expected_rev": 4, "expected_notebook_rev": 7})
        self.assertEqual(out, {"ok": True, "notebook_rev": 8, "id": "page-shaft"})
        self.assertNotIn("page-shaft", [p["id"] for p in self.disk()["pages"]])
        self.assert_no_residue()

    def test_client_forgery_rejected(self):
        before = self.path.read_bytes()
        forged = [
            {"action": "page_save", "id": "page-idea", "expected_rev": 1, "rev": 99},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1, "updated_at": 1.0},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1, "created_at": 1.0},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1, "deleted_at": 1.0},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1, "notebook_rev": 9},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1, "title": "x"},
            {"action": "page_create", "expected_notebook_rev": 4, "id": "page-mine"},
            {"action": "page_create", "expected_notebook_rev": 4, "created_at": 1.0},
            {"action": "category_create", "expected_notebook_rev": 4, "name": "X", "color": "blue", "id": "cat-mine"},
            {"action": "project_create", "expected_notebook_rev": 4, "name": "X", "archived": True},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": _content("x", "block-shaft")},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1,
             "content": {"version": 1, "blocks": [_content("a")["blocks"][0], _content("b")["blocks"][0]]}},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1,
             "content": {"version": 1, "blocks": [{"type": "text", "text": "x", "marks": [{"b": 1}]}]}},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1,
             "content": {"version": 1, "blocks": [{"type": "html", "text": "<b>x</b>", "marks": []}]}},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": {"version": 2, "blocks": []}},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": {"version": 1, "blocks": [], "html": "<p>"}},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1, "pinned": "yes"},
            {"action": "page_save", "id": "page-idea", "expected_rev": True},
            {"action": "page_save", "id": "page-idea"},
            {"action": "page_save", "id": "../etc", "expected_rev": 1},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": _content("nul\x00byte")},
            {"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": _content("\ud800")},
            {"action": "page_save", "id": "page-idea\n", "expected_rev": 1},
            {"action": "category_create", "expected_notebook_rev": 4, "name": "a\ud800", "color": "blue"},
            {"action": "project_create", "expected_notebook_rev": 4, "name": "a\ud800"},
            {"action": "nope"},
            {},
            [],
        ]
        for payload in forged:
            with self.subTest(payload=payload), self.assertRaises(hq_carnet.CarnetError):
                hq_carnet.mutate(payload)
        self.assertEqual(self.path.read_bytes(), before)

    def test_active_page_limit(self):
        state = _fixture()
        state["pages"] = [_page(f"page-p{i}") for i in range(128)] + [_page("page-old", "x", deleted_at=5.0)]
        self.seed(state)
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 4})
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "page_restore", "id": "page-old", "expected_rev": 1, "expected_notebook_rev": 4})

    def test_trash_is_bounded(self):
        state = _fixture()
        state["pages"] = [_page("page-live")] + [_page(f"page-t{i}", deleted_at=5.0) for i in range(128)]
        self.seed(state)
        before = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "page_trash", "id": "page-live", "expected_rev": 1, "expected_notebook_rev": 4})
        self.assertEqual(self.path.read_bytes(), before)


class TaxonomyTests(CarnetBase):
    def setUp(self):
        super().setUp()
        self.seed(_fixture())

    def test_category_validation(self):
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "category_create", "expected_notebook_rev": 4, "name": "mesures", "color": "blue"})
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "category_create", "expected_notebook_rev": 4, "name": "X", "color": "red"})
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "category_create", "expected_notebook_rev": 4, "name": "é" * 41, "color": "blue"})
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "category_create", "expected_notebook_rev": 4, "name": "  ", "color": "blue"})
        out = hq_carnet.mutate({"action": "category_create", "expected_notebook_rev": 4, "name": "é" * 40, "color": "violet"})
        self.assertRegex(out["category"]["id"], r"^cat-[0-9a-f]{24}$")
        self.assertEqual(out["notebook_rev"], 5)
        with self.assertRaises(hq_carnet.CarnetError):  # rename into a duplicate
            hq_carnet.mutate({"action": "category_update", "id": out["category"]["id"], "expected_notebook_rev": 5, "name": "MESURES"})
        out = hq_carnet.mutate({"action": "category_update", "id": "cat-measures", "expected_notebook_rev": 5, "color": "teal"})
        self.assertEqual(out["category"]["color"], "teal")
        for color in hq_carnet.CATEGORY_COLORS:
            self.assertIn(color, ("blue", "green", "amber", "coral", "violet", "pink", "teal", "graphite"))

    def test_category_limit(self):
        state = _fixture()
        state["categories"] = [
            {"id": f"cat-c{i}", "name": f"C{i}", "color": "blue", "created_at": 1.0, "updated_at": 1.0} for i in range(24)
        ]
        state["pages"][0]["category_id"] = None
        self.seed(state)
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "category_create", "expected_notebook_rev": 4, "name": "More", "color": "blue"})

    def test_category_delete_clears_and_bumps_pages(self):
        self.clock[0] = NOW + 9
        out = hq_carnet.mutate({"action": "category_delete", "id": "cat-measures", "expected_notebook_rev": 4})
        self.assertEqual((out["notebook_rev"], out["affected_pages"]), (5, ["page-shaft"]))
        shaft = self.page("page-shaft")
        self.assertEqual((shaft["category_id"], shaft["rev"], shaft["updated_at"]), (None, 4, NOW + 9))
        self.assertEqual(shaft["content"]["blocks"][0]["text"], FIXTURE["pages"][0]["content"]["blocks"][0]["text"])
        self.assertEqual(self.page("page-idea")["rev"], 1)
        self.assertEqual(self.disk()["categories"], [])

    def test_stale_client_cannot_resurrect_deleted_category(self):
        hq_carnet.mutate({"action": "category_delete", "id": "cat-measures", "expected_notebook_rev": 4})
        before = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetConflict) as ctx:
            self.save("page-shaft", 3, "stale", category_id="cat-measures")
        self.assertEqual(ctx.exception.payload["page"]["category_id"], None)
        with self.assertRaises(hq_carnet.CarnetNotFound):
            self.save("page-shaft", 4, "fresh rev, dead category", category_id="cat-measures")
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.disk()["categories"], [])

    def test_project_semantics(self):
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "project_create", "expected_notebook_rev": 4, "name": "p" * 61})
        out = hq_carnet.mutate({"action": "project_create", "expected_notebook_rev": 4, "name": "é" * 60})
        self.assertRegex(out["project"]["id"], r"^proj-[0-9a-f]{24}$")
        self.assertFalse(out["project"]["archived"])
        out = hq_carnet.mutate({"action": "project_update", "id": "proj-fixture", "expected_notebook_rev": 5, "name": "Fixture v2"})
        self.assertEqual(out["project"]["name"], "Fixture v2")
        out = hq_carnet.mutate({"action": "project_archive", "id": "proj-fixture", "expected_notebook_rev": 6, "archived": True})
        self.assertTrue(out["project"]["archived"])
        # notes keep project_id; page rev untouched
        shaft = self.page("page-shaft")
        self.assertEqual((shaft["project_id"], shaft["rev"]), ("proj-fixture", 3))
        # a note already in the archived project can still be saved
        self.assertEqual(self.save("page-shaft", 3, "still here", project_id="proj-fixture")["page"]["project_id"], "proj-fixture")
        # archived project not offered for new assignments
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 7, "project_id": "proj-fixture"})
        with self.assertRaises(hq_carnet.CarnetError):
            self.save("page-idea", 1, "x", project_id="proj-fixture")
        with self.assertRaises(hq_carnet.CarnetNotFound):
            self.save("page-idea", 1, "x", project_id="proj-unknown")
        with self.assertRaises(hq_carnet.CarnetNotFound):
            self.save("page-idea", 1, "x", category_id="cat-unknown")
        with self.assertRaises(hq_carnet.CarnetConflict):
            hq_carnet.mutate({"action": "project_archive", "id": "proj-fixture", "expected_notebook_rev": 1, "archived": False})


class LimitTests(CarnetBase):
    def test_page_limit_counts_utf8_bytes(self):
        self.seed(_fixture())
        exact = "é" * (49152 // 2)
        self.assertEqual(len(exact.encode("utf-8")), 49152)
        self.assertEqual(self.save("page-idea", 1, exact)["page"]["rev"], 2)
        before = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetError):
            self.save("page-idea", 2, exact + "a")
        with self.assertRaises(hq_carnet.CarnetError):  # 24577 chars < 49152, bytes > limit
            self.save("page-idea", 2, exact[:-1] + "éé")
        self.assertEqual(self.path.read_bytes(), before)

    def test_notebook_limit_counts_active_utf8_bytes(self):
        state = _fixture()
        full = "é" * (49152 // 2)
        pages = [_page(f"page-f{i}", full) for i in range(21)]  # 1 032 192 bytes
        pages.append(_page("page-rest", "é" * (16384 // 2)))  # total exactly 1 MiB
        pages.append(_page("page-small", ""))
        pages.append(_page("page-trashed", full, deleted_at=5.0))  # trash does not count
        state["pages"] = pages
        state["categories"], state["projects"] = [], []
        self.seed(state)
        self.assertEqual(self.save("page-rest", 1, "é" * (16384 // 2) )["page"]["rev"], 1)  # unchanged no-op
        with self.assertRaises(hq_carnet.CarnetError):
            self.save("page-small", 1, "a")
        self.assertEqual(self.save("page-rest", 1, "é" * (16384 // 2 - 1) + "a")["page"]["rev"], 2)
        self.assertEqual(self.save("page-small", 1, "a")["page"]["rev"], 2)  # exactly at limit again
        with self.assertRaises(hq_carnet.CarnetError):  # restoring would exceed active total
            hq_carnet.mutate({"action": "page_restore", "id": "page-trashed", "expected_rev": 1, "expected_notebook_rev": 4})


class StorageTests(CarnetBase):
    def test_malformed_bytes_preserved(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_bytes(MALFORMED)
        actions = [
            {"action": "page_create", "expected_notebook_rev": 1},
            {"action": "page_save", "id": "page-shaft", "expected_rev": 3, "content": _content("x")},
            {"action": "category_create", "expected_notebook_rev": 1, "name": "X", "color": "blue"},
            {"action": "project_create", "expected_notebook_rev": 1, "name": "X"},
        ]
        for payload in actions:
            with self.subTest(action=payload["action"]), self.assertRaises(hq_carnet.CarnetStorageError):
                hq_carnet.mutate(payload)
        with self.assertRaises(hq_carnet.CarnetStorageError):
            hq_carnet.get_notebook()
        status, body = hq_carnet.http_post({"action": "page_create", "expected_notebook_rev": 1})
        self.assertEqual((status, body["code"]), (409, "storage_error"))
        self.assertEqual(self.path.read_bytes(), MALFORMED)
        self.assert_no_residue()
        self.assertTrue(hq_carnet.malformed())

    def test_unsupported_or_invalid_shape_preserved(self):
        for raw in (
            {**_fixture(), "version": 2},
            {**_fixture(), "extra": 1},
            [1, 2],
            {**_fixture(), "pages": [{**_fixture()["pages"][0], "content": {"version": 1, "blocks": []}}]},
        ):
            data = json.dumps(raw).encode("utf-8")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_bytes(data)
            with self.subTest(raw=str(raw)[:60]):
                with self.assertRaises(hq_carnet.CarnetStorageError):
                    hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 4})
                with self.assertRaises(hq_carnet.CarnetStorageError):
                    hq_carnet.get_notebook(meta=True)
                self.assertEqual(self.path.read_bytes(), data)

    def test_atomic_writer_used(self):
        self.seed(_fixture())
        with mock.patch.object(hq_state, "write_json_atomic", wraps=hq_state.write_json_atomic) as writer:
            self.save("page-idea", 1, "atomic")
        writer.assert_called_once()
        self.assertEqual(Path(writer.call_args.args[0]), hq_carnet.notebook_path(self.tmp))
        self.assert_no_residue()

    def test_write_failure_preserves_last_good(self):
        self.seed(_fixture())
        before = self.path.read_bytes()
        with mock.patch("os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(hq_carnet.CarnetStorageError) as ctx:
                self.save("page-idea", 1, "lost")
        self.assertEqual(ctx.exception.status, 503)
        self.assertEqual(self.path.read_bytes(), before)
        self.assert_no_residue()
        self.assertEqual(self.save("page-idea", 1, "retry")["page"]["rev"], 2)

    def _outside(self, data: bytes) -> Path:
        other = Path(tempfile.mkdtemp(prefix="hq-carnet-outside-"))
        self.addCleanup(shutil.rmtree, other, ignore_errors=True)
        target = other / "notebook.json"
        target.write_bytes(data)
        return target

    def _assert_refused(self, *, secret_paths: tuple[str, ...]):
        with self.assertRaises(hq_carnet.CarnetStorageError):
            hq_carnet.get_notebook()
        with self.assertRaises(hq_carnet.CarnetStorageError):
            self.save("page-idea", 1, "escape")
        for status, body in (
            hq_carnet.http_get({}),
            hq_carnet.http_post({"action": "page_create", "expected_notebook_rev": 4}),
            hq_carnet.http_post({"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": _content("x")}),
        ):
            self.assertEqual((status, body["code"]), (409, "storage_error"))
            text = json.dumps(body, ensure_ascii=False)
            for secret in secret_paths:
                self.assertNotIn(secret, text)
            self.assertNotIn(os.sep + "tmp", text)

    def test_notebook_symlink_outside_root_rejected(self):
        payload = json.dumps(_fixture()).encode("utf-8")  # valid: would be accepted if followed
        target = self._outside(payload)
        self.path.parent.mkdir(parents=True)
        _file_symlink(target, self.path)
        self._assert_refused(secret_paths=(str(target.parent), str(self.tmp)))
        self.assertEqual(target.read_bytes(), payload)
        self.assertTrue(self.path.is_symlink())
        self.assertEqual(sorted(os.listdir(target.parent)), ["notebook.json"])
        # Stage 08: a trash/restore/delete also appends a metadata-only lifecycle event to history.json (never a temp file)
        self.assertEqual([f for f in sorted(os.listdir(self.path.parent)) if f != "history.json"], ["notebook.json"])

    def test_carnet_dir_symlink_rejected(self):
        payload = json.dumps(_fixture()).encode("utf-8")
        target = self._outside(payload)
        _dir_symlink(target.parent, self.path.parent)
        self._assert_refused(secret_paths=(str(target.parent), str(self.tmp)))
        self.assertEqual(target.read_bytes(), payload)
        self.assertEqual(sorted(os.listdir(target.parent)), ["notebook.json"])

    def test_dangling_carnet_dir_symlink_not_initialised(self):
        other = Path(tempfile.mkdtemp(prefix="hq-carnet-outside-"))
        self.addCleanup(shutil.rmtree, other, ignore_errors=True)
        _dir_symlink(other / "missing", self.path.parent)
        status, body = hq_carnet.http_get({})
        self.assertEqual((status, body["code"]), (409, "storage_error"))
        self.assertFalse((other / "missing").exists())

    def test_tmp_symlink_is_never_written_through(self):
        self.seed(_fixture())
        before = self.path.read_bytes()
        target = self._outside(b"outside bytes")
        _file_symlink(target, self.path.parent / "notebook.json.tmp")
        with self.assertRaises(hq_carnet.CarnetStorageError):
            self.save("page-idea", 1, "would be written through the link")
        self.assertEqual(target.read_bytes(), b"outside bytes")
        self.assertEqual(self.path.read_bytes(), before)

    def test_os_error_text_never_reaches_http(self):
        secret = os.path.join(str(self.tmp), "Users", "secret-owner", "notebook.json")
        err = PermissionError(13, "Access is denied", secret)
        with mock.patch.object(hq_carnet, "get_notebook", side_effect=err):
            status, body = hq_carnet.http_get({})
        self.assertEqual((status, body), (503, {"error": "Carnet inaccessible", "code": "storage_error"}))
        with mock.patch.object(hq_carnet, "mutate", side_effect=err):
            status, body = hq_carnet.http_post({"action": "page_create"})
        self.assertEqual((status, body), (503, {"error": "Carnet inaccessible", "code": "storage_error"}))

    def test_concurrent_threads(self):
        state = _fixture()
        state["pages"] = [_page(f"page-t{i}") for i in range(6)]
        self.seed(state)
        errors: list[BaseException] = []

        def writer(i):
            try:
                rev = 1
                for n in range(8):
                    rev = self.save(f"page-t{i}", rev, f"thread {i} edit {n}")["page"]["rev"]
            except BaseException as e:  # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        self.assertEqual(errors, [])
        for i in range(6):
            page = self.page(f"page-t{i}")
            self.assertEqual((page["rev"], page["content"]["blocks"][0]["text"]), (9, f"thread {i} edit 7"))
        # same page, same expected rev: exactly one wins
        results: list[str] = []
        barrier = threading.Barrier(5)

        def racer(i):
            barrier.wait()
            try:
                self.save("page-t0", 9, f"racer {i}")
                results.append("ok")
            except hq_carnet.CarnetConflict:
                results.append("conflict")

        threads = [threading.Thread(target=racer, args=(i,)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        self.assertEqual(sorted(results), ["conflict"] * 4 + ["ok"])
        self.assertEqual(self.page("page-t0")["rev"], 10)
        self.assert_no_residue()


def _http(port, method, path, *, body=None, headers=None, cookie=None):
    import http.client

    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
    hdrs = {"Host": f"127.0.0.1:{port}"}
    if headers:
        hdrs.update(headers)
    if cookie:
        hdrs["Cookie"] = cookie
    if body is not None and "Content-Length" not in hdrs:
        hdrs["Content-Length"] = str(len(body))
    conn.request(method, path, body=body, headers=hdrs)
    resp = conn.getresponse()
    payload = resp.read()
    conn.close()
    return resp.status, dict(resp.getheaders()), payload


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-carnet-api-"))
        cls._root = iphone_bridge.ROOT
        cls._config = json.loads(json.dumps(iphone_bridge.CONFIG))
        cls._carnet_cb, cls._carnet_ready = dict(hq_carnet._cb), hq_carnet._ready
        # Logins persist sessions: keep them in the temp ROOT, never the live file.
        cls._sessions_path = iphone_bridge.SESSIONS_PATH
        iphone_bridge.SESSIONS_PATH = cls.tmp / "bridge_sessions.json"
        iphone_bridge.ROOT = cls.tmp
        for name in ("Inbox", "Uni", "Print"):
            (cls.tmp / name).mkdir()
        iphone_bridge.CONFIG["pin"] = ""
        iphone_bridge.CONFIG["discord_webhook_url"] = ""
        iphone_bridge.CONFIG["users"] = [
            {"name": "admin-test", "pin": "424242", "role": "admin"},
            {"name": "upload-test", "pin": "111111", "role": "upload"},
        ]
        iphone_bridge.bind_cc_ext()
        iphone_bridge.bind_hq()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), iphone_bridge.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.admin = cls._login("424242")
        cls.upload = cls._login("111111")
        cls.path = cls.tmp / ".hq-carnet" / "notebook.json"

    @classmethod
    def _login(cls, pin: str) -> str:
        status, headers, _body = _http(
            cls.port,
            "POST",
            "/login",
            body=urlencode({"pin": pin}).encode(),
            headers={"Origin": f"http://127.0.0.1:{cls.port}", "Content-Type": "application/x-www-form-urlencoded"},
        )
        if status != 303:
            raise AssertionError(status)
        raw = headers.get("Set-Cookie") or headers.get("set-cookie") or ""
        return raw.split(";", 1)[0]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        iphone_bridge.ROOT = cls._root
        iphone_bridge.SESSIONS_PATH = cls._sessions_path
        iphone_bridge.CONFIG.clear()
        iphone_bridge.CONFIG.update(cls._config)
        iphone_bridge.bind_cc_ext()
        iphone_bridge.bind_hq()
        hq_carnet._cb.clear()
        hq_carnet._cb.update(cls._carnet_cb)
        hq_carnet._ready = cls._carnet_ready
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(_fixture(), ensure_ascii=False), encoding="utf-8")

    def _get(self, path, cookie=None):
        return _http(self.port, "GET", path, cookie=self.admin if cookie is None else cookie)

    def _post(self, payload, *, cookie=None, origin=True, raw=None):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = f"http://127.0.0.1:{self.port}"
        body = raw if raw is not None else json.dumps(payload).encode()
        return _http(self.port, "POST", "/api/carnet", body=body, headers=headers,
                     cookie=self.admin if cookie is None else cookie)

    def test_sessions_stay_in_temp_root(self):
        self.assertTrue(str(iphone_bridge.SESSIONS_PATH).startswith(str(self.tmp)))
        self.assertTrue((self.tmp / "bridge_sessions.json").is_file())

    def test_upload_allowlists_unchanged(self):
        for route in ("/api/carnet",):
            self.assertNotIn(route, iphone_bridge.UPLOAD_GET_EXACT)
            self.assertNotIn(route, iphone_bridge.UPLOAD_POST_EXACT)
            self.assertFalse(any(route.startswith(p) for p in iphone_bridge.UPLOAD_GET_PREFIX))
            self.assertFalse(any(route.startswith(p) for p in iphone_bridge.UPLOAD_POST_PREFIX))
        self.assertEqual(
            iphone_bridge.UPLOAD_GET_EXACT,
            {"/", "/login", "/logout", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/wallboard",
             "/api/me", "/api/upload/status"},
        )
        self.assertEqual(
            iphone_bridge.UPLOAD_POST_EXACT,
            {"/login", "/logout", "/api/me", "/api/presence", "/api/upload", "/api/upload/init",
             "/api/upload/chunk", "/api/upload/complete"},
        )
        self.assertEqual(iphone_bridge.UPLOAD_GET_PREFIX, ("/assets/",))
        self.assertEqual(iphone_bridge.UPLOAD_POST_PREFIX, ())

    def test_auth_role_and_csrf(self):
        before = self.path.read_bytes()
        status, _h, _b = _http(self.port, "GET", "/api/carnet")
        self.assertEqual(status, 401)
        status, _h, _b = _http(self.port, "GET", "/api/carnet?meta=1")
        self.assertEqual(status, 401)
        status, _h, _b = self._post({"action": "page_create", "expected_notebook_rev": 4}, cookie="")
        self.assertEqual(status, 401)
        status, _h, _b = self._get("/api/carnet", cookie=self.upload)
        self.assertEqual(status, 403)
        status, _h, _b = self._get("/api/carnet?meta=1", cookie=self.upload)
        self.assertEqual(status, 403)
        status, _h, _b = self._post({"action": "page_create", "expected_notebook_rev": 4}, cookie=self.upload)
        self.assertEqual(status, 403)
        status, _h, body = self._post({"action": "page_create", "expected_notebook_rev": 4}, origin=False)
        self.assertEqual(status, 403)
        self.assertIn("CSRF", body.decode())
        status, _h, _b = _http(
            self.port, "POST", "/api/carnet", body=b'{"action":"page_create","expected_notebook_rev":4}',
            headers={"Content-Type": "application/json", "Origin": "http://evil.example"}, cookie=self.admin,
        )
        self.assertEqual(status, 403)
        self.assertEqual(self.path.read_bytes(), before)

    def test_admin_get_full_and_meta(self):
        status, headers, body = self._get("/api/carnet")
        self.assertEqual(status, 200, body)
        data = json.loads(body)
        self.assertTrue(data["ok"])
        self.assertEqual((data["version"], data["notebook_rev"]), (1, 4))
        self.assertEqual(data["pages"], FIXTURE["pages"], "Stage 04: untouched V1 pages are served as-is (lazy migration)")
        self.assertEqual(data["limits"]["page_text_bytes"], 49152)
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertIn("default-src 'self'", headers.get("Content-Security-Policy", ""))
        self.assertIn("application/json", headers.get("Content-Type", ""))
        status, _h, body = self._get("/api/carnet?meta=1")
        self.assertEqual(status, 200)
        meta = json.loads(body)
        self.assertNotIn(b'"blocks"', body)
        self.assertNotIn(b'"text"', body)
        self.assertTrue(all("content" not in p for p in meta["pages"]))
        self.assertEqual(meta["pages"][0]["title"], "Shaft inspection")
        for bad in ("/api/carnet?meta=2", "/api/carnet?meta=", "/api/carnet?meta=1&meta=1", "/api/carnet?full=1"):
            status, _h, body = self._get(bad)
            self.assertEqual(status, 400, bad)
            self.assertEqual(json.loads(body)["code"], "validation_error")

    def test_post_success_and_error_codes(self):
        status, _h, body = self._post({"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": _content("Edited")})
        self.assertEqual(status, 200, body)
        data = json.loads(body)
        self.assertEqual((data["ok"], data["notebook_rev"], data["page"]["rev"]), (True, 4, 2))
        status, _h, body = self._post({"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": _content("Stale")})
        self.assertEqual(status, 409)
        data = json.loads(body)
        self.assertEqual((data["code"], data["page"]["rev"], data["notebook_rev"]), ("revision_conflict", 2, 4))
        self.assertEqual(data["page"]["content"]["blocks"][0]["text"], "Edited")
        status, _h, body = self._post({"action": "category_create", "expected_notebook_rev": 1, "name": "X", "color": "blue"})
        self.assertEqual((status, json.loads(body)["code"]), (409, "notebook_revision_conflict"))
        status, _h, body = self._post({"action": "page_save", "id": "page-missing", "expected_rev": 1})
        self.assertEqual((status, json.loads(body)["code"]), (404, "not_found"))
        status, _h, body = self._post({"action": "explode"})
        self.assertEqual((status, json.loads(body)["code"]), (400, "validation_error"))
        status, _h, body = self._post(None, raw=b"{not json")
        self.assertEqual((status, json.loads(body)["code"]), (400, "validation_error"))
        status, _h, body = self._post(None, raw=b"[1]")
        self.assertEqual(status, 400)
        status, _h, body = self._post({"action": "category_create", "expected_notebook_rev": 4, "name": "Idées", "color": "teal"})
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["notebook_rev"], 5)
        self.assertIn("category", json.loads(body))

    def test_malformed_http_is_controlled(self):
        self.path.write_bytes(MALFORMED)
        status, _h, body = self._get("/api/carnet")
        self.assertEqual((status, json.loads(body)["code"]), (409, "storage_error"))
        status, _h, body = self._post({"action": "page_create", "expected_notebook_rev": 4})
        self.assertEqual((status, json.loads(body)["code"]), (409, "storage_error"))
        self.assertEqual(self.path.read_bytes(), MALFORMED)

    def test_no_content_in_logs_or_urls(self):
        secret = "SECRET-NOTE-7f3a Ø12 préload"
        buf = io.StringIO()
        activity_before = json.dumps(cc_ext._activity, ensure_ascii=False)
        with mock.patch.object(sys, "stderr", buf):
            status, _h, body = self._post({"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": _content(secret)})
            self.assertEqual(status, 200, body)
            status, _h, _b = self._post({"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": _content(secret)})
            self.assertEqual(status, 409)
            status, _h, _b = self._post({"action": "page_save", "id": "page-idea", "expected_rev": 2, "content": _content(secret + "\x00")})
            self.assertEqual(status, 400)
            status, _h, _b = self._get("/api/carnet?meta=1")
            self.assertEqual(status, 200)
        logged = buf.getvalue()
        self.assertIn("/api/carnet", logged)  # request lines are logged...
        self.assertNotIn("SECRET-NOTE", logged)  # ...never note contents
        self.assertNotIn("SECRET-NOTE", json.dumps(cc_ext._activity, ensure_ascii=False).replace(activity_before, ""))
        events = self.tmp / "hq_events.json"
        if events.is_file():
            self.assertNotIn("SECRET-NOTE", events.read_text(encoding="utf-8"))


try:
    import test_backup_retention as _retention
except ImportError:  # pragma: no cover - run from repository root
    from tests import test_backup_retention as _retention


class BackupTests(_retention.RetentionBase):
    def _carnet_file(self) -> Path:
        return self.root / ".hq-carnet" / "notebook.json"

    def test_backup_includes_carnet_without_changing_folders(self):
        (self.root / "Uni").mkdir()
        src = self._carnet_file()
        src.parent.mkdir(parents=True)
        payload = json.dumps(_fixture(), ensure_ascii=False, indent=2).encode("utf-8")
        src.write_bytes(payload)
        (src.parent / "notebook.json.tmp").write_bytes(b"partial temp")
        info = cc_ext.run_backup(force=True)
        self.assertEqual(info["folders"], 2)  # Inbox + Uni; Carnet never counted
        self.assertEqual(
            info["carnet"], {"ok": True, "included": True, "status": "included", "bytes": len(payload), "valid": True}
        )
        dest = Path(info["path"])
        self.assertEqual((dest / "Carnet" / "notebook.json").read_bytes(), payload)
        self.assertEqual(sorted(os.listdir(dest / "Carnet")), ["notebook.json"])
        self.assertEqual(self.index()[-1]["folders"], 2)
        self.assertEqual(src.read_bytes(), payload)

    def test_backup_missing_carnet_is_safe(self):
        info = cc_ext.run_backup(force=True)
        self.assertEqual(info["folders"], 1)
        self.assertEqual(info["carnet"], {"ok": True, "included": False, "status": "absent"})
        self.assertFalse((Path(info["path"]) / "Carnet").exists())
        self.assertFalse((self.root / ".hq-carnet").exists())

    def test_backup_malformed_copies_bytes_untouched(self):
        src = self._carnet_file()
        src.parent.mkdir(parents=True)
        src.write_bytes(MALFORMED)
        info = cc_ext.run_backup(force=True)
        self.assertEqual(info["folders"], 1)
        self.assertEqual((info["carnet"]["included"], info["carnet"]["valid"]), (True, False))
        self.assertEqual((Path(info["path"]) / "Carnet" / "notebook.json").read_bytes(), MALFORMED)
        self.assertEqual(src.read_bytes(), MALFORMED)
        # an unusable copy is not a recovery point: older backups are kept
        self.assertEqual(info["purge"], {"ok": True, "purge_skipped": True, "reason": "carnet_invalid", "deleted": []})

    def test_backup_snapshot_waits_for_notebook_lock(self):
        src = self._carnet_file()
        src.parent.mkdir(parents=True)
        src.write_bytes(b'{"v": "old"}')
        lock = hq_state.path_lock(hq_carnet.notebook_path(self.root))
        result: dict = {}
        with lock:
            worker = threading.Thread(target=lambda: result.update(cc_ext.run_backup(force=True)))
            worker.start()
            time.sleep(0.3)
            self.assertTrue(worker.is_alive())  # blocked on the notebook lock
            src.write_bytes(b'{"v": "committed"}')
        worker.join(10)
        self.assertEqual((Path(result["path"]) / "Carnet" / "notebook.json").read_bytes(), b'{"v": "committed"}')

    def test_snapshot_never_deletes_existing_snapshot(self):
        # Two backups in the same second share one stamp directory.
        src = self._carnet_file()
        src.parent.mkdir(parents=True)
        src.write_bytes(b'{"v": "first"}')
        dest = self.tmp / "same-stamp" / "Carnet"
        self.assertTrue(hq_carnet.snapshot_to(self.root, dest)["included"])
        src.write_bytes(b'{"v": "second"}')
        with self.assertRaises(FileExistsError):
            hq_carnet.snapshot_to(self.root, dest)
        self.assertEqual((dest / "notebook.json").read_bytes(), b'{"v": "first"}')

    def test_backup_carnet_failure_does_not_break_legacy(self):
        src = self._carnet_file()
        src.parent.mkdir(parents=True)
        src.write_bytes(b"{}")
        with mock.patch.object(hq_carnet, "snapshot_to", side_effect=OSError("boom")):
            info = cc_ext.run_backup(force=True)
        self.assertEqual((info["ok"], info["folders"]), (True, 1))
        self.assertEqual(
            info["carnet"], {"ok": False, "included": False, "status": "failed", "error": "Carnet non sauvegardé"}
        )

    # -- retention / catalog integrity --
    def _old_backups(self) -> list[Path]:
        return [self.make_backup(_retention.stamp(d)) for d in (100, 200, 300, 400, 500)]

    def _entry(self, backup_id: str) -> dict:
        return next(e for e in self.index() if e["id"] == backup_id)

    def test_retention_runs_when_carnet_absent(self):
        old = self._old_backups()
        info = cc_ext.run_backup(force=True)
        self.assertEqual(info["carnet"]["status"], "absent")
        self.assertNotIn("purge_skipped", info["purge"])
        self.assertEqual(len(info["purge"]["deleted"]), 3)  # keep_min=3 incl. the new one
        self.assertFalse(os.path.lexists(old[-1]))
        self.assertEqual(self._entry(info["id"])["carnet"], {"status": "absent", "ok": True, "included": False})
        self.assertEqual(self._entry(info["id"])["folders"], 1)

    def test_retention_runs_when_carnet_included(self):
        old = self._old_backups()
        src = self._carnet_file()
        src.parent.mkdir(parents=True)
        src.write_bytes(json.dumps(_fixture()).encode("utf-8"))
        info = cc_ext.run_backup(force=True)
        self.assertTrue(info["carnet"]["included"])
        self.assertNotIn("purge_skipped", info["purge"])
        self.assertEqual(len(info["purge"]["deleted"]), 3)
        self.assertFalse(os.path.lexists(old[-1]))
        self.assertEqual(
            self._entry(info["id"])["carnet"], {"status": "included", "ok": True, "included": True, "valid": True}
        )
        self.assertEqual(self._entry(info["id"])["folders"], 1)

    def test_carnet_failure_skips_retention_and_is_catalogued(self):
        old = self._old_backups()
        src = self._carnet_file()
        src.parent.mkdir(parents=True)
        src.write_bytes(json.dumps(_fixture()).encode("utf-8"))
        with mock.patch.object(hq_carnet, "snapshot_to", side_effect=OSError("boom")):
            info = cc_ext.run_backup(force=True)
        self.assertEqual((info["ok"], info["folders"]), (True, 1))  # legacy backup kept
        self.assertFalse(info["carnet"]["included"])
        self.assertEqual(info["purge"], {"ok": True, "purge_skipped": True, "reason": "carnet_snapshot_failed", "deleted": []})
        for p in old:  # previous backups (possible recovery points) all remain
            self.assertTrue(p.is_dir())
        self.assertFalse((Path(info["path"]) / "Carnet" / "notebook.json").exists())
        entry = self._entry(info["id"])
        self.assertEqual(entry["carnet"], {"status": "failed", "ok": False, "included": False})
        self.assertEqual(entry["folders"], 1)

    def test_backup_does_not_follow_escaped_notebook(self):
        old = self._old_backups()
        outside = self.tmp / "outside-notebook.json"
        payload = json.dumps(_fixture()).encode("utf-8")
        outside.write_bytes(payload)
        src = self._carnet_file()
        src.parent.mkdir(parents=True)
        _file_symlink(outside, src)
        info = cc_ext.run_backup(force=True)
        self.assertEqual(info["carnet"]["status"], "failed")
        self.assertFalse((Path(info["path"]) / "Carnet" / "notebook.json").exists())
        self.assertEqual(info["purge"]["reason"], "carnet_snapshot_failed")
        self.assertTrue(all(p.is_dir() for p in old))
        self.assertEqual(outside.read_bytes(), payload)
        self.assertTrue(src.is_symlink())
        self.assertNotIn(str(outside), json.dumps(info, ensure_ascii=False).replace(str(info["path"]), ""))


if __name__ == "__main__":
    unittest.main()
