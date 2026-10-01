"""Carnet Stage 04 — structured content, migration, safe links, export (server side).

Throwaway ROOTs only (CarnetBase). Browser behaviour lives in tests/check_hq_carnet_rich.mjs
(pure model, draft/concurrency, find/replace mark integrity) and tests/visual_carnet_playwright.py.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_rich as rich  # noqa: E402
import iphone_bridge  # noqa: E402
from test_hq_carnet import (  # noqa: E402
    CarnetBase, NOW, _content, _dir_symlink, _fixture, _http, _page,
)

SHARED = Path(__file__).resolve().parent / "fixtures_carnet_rich.json"


def block(kind="paragraph", text="", marks=None, **extra):
    out = {"type": kind, "text": text, "marks": marks or []}
    out.update(extra)
    return out


def v2(*blocks):
    return {"version": 2, "blocks": list(blocks)}


def flat(page):
    return rich.flat_text(page["content"])


def lines_v1(n, text="l"):
    return "\n".join(text for _ in range(n))


def v1_state(pages):
    state = _fixture()
    state["pages"] = pages
    return state


class MigrationTests(CarnetBase):
    """Lazy, per-page migration: reads and unrelated writes never convert a V1 page."""

    def test_v1_file_is_served_as_is_and_reads_never_write(self):
        self.seed(_fixture())
        raw = self.path.read_bytes()
        data = hq_carnet.get_notebook()
        self.assertEqual(self.path.read_bytes(), raw, "reads never write")
        self.assertEqual(data["pages"], _fixture()["pages"], "untouched V1 pages are returned byte-for-byte as V1")
        meta = hq_carnet.get_notebook(meta=True)
        self.assertEqual(meta["pages"][0]["title"], "Shaft inspection")
        self.assertEqual(meta["pages"][0]["preview"], "Ø12.034 mm Check bearing preload")

    def test_unrelated_mutations_never_convert_untouched_v1_pages_on_disk(self):
        self.seed(_fixture())
        hq_carnet.mutate({"action": "category_create", "expected_notebook_rev": 4, "name": "Idées", "color": "teal"})
        hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 5})
        out = self.save("page-idea", 1, "Try a split clamp instead\nsecond")  # writes ONE page
        self.assertEqual(out["page"]["content"]["version"], 2, "the written page migrates when it fits")
        disk = self.disk()
        shaft = next(p for p in disk["pages"] if p["id"] == "page-shaft")
        self.assertEqual(shaft, _fixture()["pages"][0], "an untouched V1 page is bit-identical on disk (no amplification)")
        self.assertEqual(shaft["rev"], 3)
        self.assertEqual(disk["version"], 1)
        self.assert_no_residue()

    def test_save_of_a_plain_v1_page_migrates_only_that_page_and_only_if_text_changed(self):
        self.seed(_fixture())
        same = self.save("page-idea", 1, "Try a split clamp instead")
        self.assertEqual((same["page"]["rev"], same["page"]["content"]["version"]), (1, 1), "identical content is no change and no migration")
        out = self.save("page-idea", 1, "changed")
        self.assertEqual((out["page"]["rev"], out["page"]["content"]["version"]), (2, 2))
        self.assertEqual(out["page"]["content"]["blocks"][0]["id"], "block-idea", "the legacy block id survives migration")
        self.assertEqual(flat(out["page"]), "changed")

    def test_exact_text_survives_odd_shapes(self):
        cases = ["", "\n", "a\n", "\n\nb", "tabs\tand  spaces  ", "emoji 😀 é\nline", "x" * 3000, "a\r\nb"]
        for text in cases:
            self.seed(v1_state([_page("page-odd", text)]))
            self.assertEqual(flat(hq_carnet.get_notebook()["pages"][0]), text, repr(text))
            out = hq_carnet.mutate({"action": "page_save", "id": "page-odd", "expected_rev": 1, "content": v2(block(text="tail"))})
            back = hq_carnet.mutate({"action": "page_save", "id": "page-odd", "expected_rev": 2, "content": _content(text)})
            self.assertEqual(flat(back["page"]), text, "round trip through V2 and back is exact: " + repr(text))
            self.assertTrue(rich.valid_v2(back["page"]["content"]) or rich.valid_v1(back["page"]["content"]))
            del out

    def test_oversized_plain_v1_page_stays_readable_and_editable_as_compact_v1(self):
        n = rich.BLOCKS_MAX + 1
        text = lines_v1(n)
        self.seed(v1_state([_page("page-big", text), _page("page-small", "s")]))
        got = hq_carnet.get_notebook()["pages"][0]
        self.assertEqual((got["content"]["version"], flat(got)), (1, text), "served as one V1 block, exact")
        # edit through the V2 client shape (many blocks): stored compactly, exact, no text lost
        edited = text + "\nappended"
        blocks = [block(text="l") for _ in range(n)] + [block(text="appended")]
        out = self.save_v2("page-big", 1, v2(*blocks))
        self.assertEqual((out["page"]["content"]["version"], len(out["page"]["content"]["blocks"])), (1, 1))
        self.assertEqual(flat(out["page"]), edited)
        self.assertEqual(out["page"]["content"]["blocks"][0]["id"], got["content"]["blocks"][0]["id"])
        # ... and through the V1 shape a legacy/compact client sends
        out = hq_carnet.mutate({"action": "page_save", "id": "page-big", "expected_rev": 2, "content": _content(edited + "!", got["content"]["blocks"][0]["id"])})
        self.assertEqual((out["page"]["content"]["version"], flat(out["page"])), (1, edited + "!"))

    def test_structured_content_over_the_line_limit_is_refused_not_truncated(self):
        n = rich.BLOCKS_MAX + 1
        self.seed(v1_state([_page("page-big", lines_v1(n))]))
        raw = self.path.read_bytes()
        blocks = [block(text="l") for _ in range(n)]
        blocks[0] = block("heading", "l")
        with self.assertRaises(hq_carnet.CarnetError) as ctx:
            self.save_v2("page-big", 1, v2(*blocks))
        self.assertIn("mise en forme", str(ctx.exception))
        blocks[0] = block(text="l", marks=[{"type": "bold", "start": 0, "end": 1}])
        with self.assertRaises(hq_carnet.CarnetError):
            self.save_v2("page-big", 1, v2(*blocks))
        self.assertEqual(self.path.read_bytes(), raw, "nothing written, nothing lost")

    def test_near_maximum_newline_heavy_page_stays_a_single_stored_block(self):
        limit = hq_carnet.PAGE_TEXT_BYTES
        text = "\n" * (limit)  # exactly limit bytes -> limit + 1 lines
        self.assertEqual(len(text.encode()), limit)
        self.seed(v1_state([_page("page-max", text), _page("page-idea", "hi")]))
        got = hq_carnet.get_notebook()["pages"][0]
        self.assertEqual((got["content"]["version"], len(got["content"]["blocks"]), flat(got)), (1, 1, text))
        hq_carnet.mutate({"action": "category_create", "expected_notebook_rev": 4, "name": "X", "color": "blue"})
        disk_page = self.page("page-max")
        self.assertEqual((disk_page["content"]["version"], len(disk_page["content"]["blocks"])), (1, 1), "an unrelated write does not expand the page")
        self.assertEqual(flat(disk_page), text)
        # one more newline byte is over the page size limit, exactly as before Stage 04
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "page_save", "id": "page-max", "expected_rev": 1, "content": _content(text + "\n")})
        # the page can be edited in place (replace a newline by a letter: same size) and stays compact
        out = hq_carnet.mutate({"action": "page_save", "id": "page-max", "expected_rev": 1, "content": _content("a" + text[1:])})
        self.assertEqual((out["page"]["content"]["version"], flat(out["page"])), (1, "a" + text[1:]))

    def test_notebook_where_v2_expansion_would_exceed_the_budget_stays_safe(self):
        from unittest import mock

        with mock.patch.object(rich, "NOTEBOOK_BLOCKS_MAX", 20):
            self.seed(v1_state([_page("page-a", lines_v1(30)), _page("page-b", lines_v1(30)), _page("page-c", "c")]))
            raw_pages = {p["id"]: p for p in self.disk()["pages"]}
            data = hq_carnet.get_notebook()  # GET stays safe: nothing converted
            self.assertEqual([p["content"]["version"] for p in data["pages"]], [1, 1, 1])
            hq_carnet.mutate({"action": "category_create", "expected_notebook_rev": 4, "name": "X", "color": "blue"})
            self.save("page-c", 1, "c2")  # unrelated save: only page-c is written
            disk = {p["id"]: p for p in self.disk()["pages"]}
            self.assertEqual(disk["page-a"], raw_pages["page-a"])
            self.assertEqual(disk["page-b"], raw_pages["page-b"], "legacy pages are not materialised into oversized V2")
            # a plain edit of a legacy page that would cross the budget stays compact V1 (text exact)
            out = self.save_v2("page-a", 1, v2(*[block(text="l") for _ in range(31)]))
            self.assertEqual((out["page"]["content"]["version"], len(out["page"]["content"]["blocks"])), (1, 1))
            self.assertEqual(flat(out["page"]), lines_v1(31))
            # structured content that would cross it is refused visibly
            with self.assertRaises(hq_carnet.CarnetError) as ctx:
                self.save_v2("page-b", 1, v2(block("heading", "H"), *[block(text="l") for _ in range(30)]))
            self.assertIn("volumineux", str(ctx.exception))
            self.assertEqual(self.page("page-b"), raw_pages["page-b"])

    def test_server_get_payload_loads_in_the_browser_state_machine(self):
        """Complete server -> client path: the real GET payload feeds createCore.load()."""
        import shutil
        import subprocess

        node = shutil.which("node")
        if not node:
            self.skipTest("node unavailable")
        n = rich.BLOCKS_MAX + 1
        pages = [
            _page("page-big", lines_v1(n)),
            _page("page-max", "\n" * hq_carnet.PAGE_TEXT_BYTES),
            _page("page-plain", "plain\ntext"),
        ]
        self.seed(v1_state(pages))
        raw = self.path.read_bytes()
        payload = hq_carnet.get_notebook()
        self.assertEqual(self.path.read_bytes(), raw)
        self.assertEqual([len(p["content"]["blocks"]) for p in payload["pages"]], [1, 1, 1], "the payload is not amplified")
        texts = {p["id"]: p["content"]["blocks"][0]["text"] for p in pages}
        script = Path(__file__).resolve().parent / "check_carnet_get_payload.mjs"
        proc = subprocess.run([node, str(script)], input=json.dumps({"notebook": payload, "texts": texts}), capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        result = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(result["page-big"]["lines"], n)
        self.assertEqual(result["page-max"]["lines"], hq_carnet.PAGE_TEXT_BYTES + 1)
        self.assertEqual(result["page-plain"]["pages"], 3)

    def test_shrinking_an_oversized_legacy_page_permits_normal_v2_migration(self):
        n = rich.BLOCKS_MAX + 500
        self.seed(v1_state([_page("page-big", lines_v1(n))]))
        out = hq_carnet.mutate({"action": "page_save", "id": "page-big", "expected_rev": 1, "content": v2(*[block(text="l") for _ in range(n - 1)])})
        self.assertEqual(out["page"]["content"]["version"], 1, "still over the limit: stays compact")
        out = self.save_v2("page-big", 2, v2(*[block(text=f"line {i}") for i in range(100)]))
        self.assertEqual(out["page"]["content"]["version"], 2, "reduced under the limit: migrated to V2")
        self.assertEqual(len(out["page"]["content"]["blocks"]), 100)
        out = self.save_v2("page-big", 3, v2(block("heading", "now structured"), *out["page"]["content"]["blocks"][1:]))
        self.assertEqual(out["page"]["content"]["blocks"][0]["type"], "heading")
        self.assertTrue(rich.valid_v2(self.page("page-big")["content"]))

    def test_legacy_client_can_still_save_plain_pages(self):
        self.seed(_fixture())
        out = hq_carnet.mutate({"action": "page_save", "id": "page-shaft", "expected_rev": 3, "content": _content("one\ntwo", "block-shaft")})
        self.assertEqual(out["page"]["content"]["version"], 2)
        self.assertEqual(flat(out["page"]), "one\ntwo")
        again = hq_carnet.mutate({"action": "page_save", "id": "page-shaft", "expected_rev": 4, "content": _content("one\ntwo", "block-shaft")})
        self.assertEqual(again["page"]["rev"], 4, "identical legacy content is not a change")
        ids = [b["id"] for b in out["page"]["content"]["blocks"]]
        third = hq_carnet.mutate({"action": "page_save", "id": "page-shaft", "expected_rev": 4, "content": _content("one\ntwo\nthree")})
        self.assertEqual([b["id"] for b in third["page"]["content"]["blocks"]][:2], ids, "a legacy client keeps the page's ids by position")

    def test_legacy_client_never_downgrades_structure(self):
        self.seed(_fixture())
        self.save_v2("page-idea", 1, v2(block("heading", "Try"), block("bullet", "a split clamp")))
        with self.assertRaises(hq_carnet.CarnetError) as ctx:
            hq_carnet.mutate({"action": "page_save", "id": "page-idea", "expected_rev": 2, "content": _content("flattened")})
        self.assertIn("obsolète", str(ctx.exception))
        self.assertEqual(self.page("page-idea")["content"]["blocks"][0]["type"], "heading")

    def test_malformed_v1_and_v2_still_preserved(self):
        for bad in (
            {"version": 1, "blocks": [{"id": "block-x", "type": "text", "text": "a", "marks": [{"type": "bold", "start": 0, "end": 1}]}]},
            {"version": 3, "blocks": []},
            {"version": 2, "blocks": []},
            {"version": 2, "blocks": [{"id": "block-x", "type": "paragraph", "text": "a\nb", "marks": []}]},
            {"version": 2, "blocks": [{"id": "block-x", "type": "paragraph", "text": "a", "marks": [{"type": "bold", "start": 0, "end": 5}]}]},
            {"version": 2, "blocks": [{"id": "block-x", "type": "paragraph", "text": "a", "checked": True, "marks": []}]},
        ):
            state = _fixture()
            state["pages"][1]["content"] = bad
            self.seed(state)
            raw = self.path.read_bytes()
            with self.assertRaises(hq_carnet.CarnetStorageError):
                hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 4})
            self.assertEqual(self.path.read_bytes(), raw, "malformed content is preserved, never rewritten")

    def test_stored_v2_must_already_be_canonical(self):
        state = _fixture()
        state["pages"][1]["content"] = v2({"id": "block-a", **block("paragraph", "hello", [{"type": "bold", "start": 2, "end": 3}, {"type": "bold", "start": 0, "end": 2}])})
        self.seed(state)
        with self.assertRaises(hq_carnet.CarnetStorageError):
            hq_carnet.get_notebook()

    def save_v2(self, page_id, rev, content, **extra):
        return hq_carnet.mutate({"action": "page_save", "id": page_id, "expected_rev": rev, "content": content, **extra})


class NoDowngradeTests(CarnetBase):
    """An existing V2 page is never compacted to V1 (block identity would be lost)."""

    def setUp(self):
        super().setUp()
        self.seed(v1_state([_page("page-a", "x"), _page("page-b", "y")]))

    def v2page(self):
        out = hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 1, "content": v2(block(text="one"), block(text="two"))})
        return out["page"]

    def test_v2_page_at_the_budget_rejects_growth_and_stays_exact_v2_with_ids(self):
        from unittest import mock

        page = self.v2page()
        ids = [b["id"] for b in page["content"]["blocks"]]
        with mock.patch.object(rich, "NOTEBOOK_BLOCKS_MAX", 3):  # a=2 + b=1: full
            raw = self.path.read_bytes()
            with self.assertRaises(hq_carnet.CarnetError) as ctx:
                hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 2, "content": v2(
                    {"id": ids[0], **block(text="one")}, {"id": ids[1], **block(text="two")}, block(text="three"))})
            self.assertIn("volumineux", str(ctx.exception))
            self.assertEqual(self.path.read_bytes(), raw, "existing content untouched")
            kept = self.page("page-a")
            self.assertEqual((kept["content"]["version"], [b["id"] for b in kept["content"]["blocks"]], flat(kept)), (2, ids, "one\ntwo"))
            # shrinking stays possible and keeps identity
            out = hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 2, "content": v2({"id": ids[1], **block(text="two")})})
            self.assertEqual((out["page"]["content"]["version"], [b["id"] for b in out["page"]["content"]["blocks"]]), (2, [ids[1]]))
            # ... and once within limits, normal V2 saves work again
            back = hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 3, "content": v2({"id": ids[1], **block(text="two")}, block(text="three"))})
            self.assertEqual((back["page"]["content"]["version"], back["page"]["content"]["blocks"][0]["id"]), (2, ids[1]))

    def test_v2_page_never_downgrades_to_v1_when_the_page_limit_is_hit(self):
        page = self.v2page()
        base = [{"id": b["id"], **block(text=b["text"])} for b in page["content"]["blocks"]]
        many = base + [block(text="l") for _ in range(rich.BLOCKS_MAX)]  # BLOCKS_MAX + 2 plain lines
        raw = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetError) as ctx:
            hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 2, "content": v2(*many)})
        self.assertIn("Trop de lignes", str(ctx.exception))
        self.assertEqual(self.path.read_bytes(), raw)
        self.assertEqual(self.page("page-a")["content"]["version"], 2)

    def test_legacy_v1_pages_may_still_stay_compact_or_migrate(self):
        from unittest import mock

        big = lines_v1(rich.BLOCKS_MAX + 1)
        self.seed(v1_state([_page("page-big", big), _page("page-b", "y")]))
        out = hq_carnet.mutate({"action": "page_save", "id": "page-big", "expected_rev": 1, "content": v2(*[block(text="l") for _ in range(rich.BLOCKS_MAX + 2)])})
        self.assertEqual((out["page"]["content"]["version"], len(out["page"]["content"]["blocks"])), (1, 1), "legacy oversized plain edit stays compact V1")
        small = hq_carnet.mutate({"action": "page_save", "id": "page-big", "expected_rev": 2, "content": v2(*[block(text=f"s{i}") for i in range(20)])})
        self.assertEqual(small["page"]["content"]["version"], 2, "legacy V1 shrunk within limits migrates to V2")
        with mock.patch.object(rich, "NOTEBOOK_BLOCKS_MAX", 21):  # 20 + b(1)
            hq_carnet.mutate({"action": "page_save", "id": "page-b", "expected_rev": 1, "content": _content("z")})  # V1 -> V2 (delta 0)
            with self.assertRaises(hq_carnet.CarnetError):
                hq_carnet.mutate({"action": "page_save", "id": "page-big", "expected_rev": 3, "content": v2(*[block(text=f"s{i}") for i in range(22)])})


class BlockBudgetTests(CarnetBase):
    """One shared block-budget invariant for every operation that adds stored blocks."""

    def setUp(self):
        super().setUp()
        from unittest import mock

        patcher = mock.patch.object(rich, "NOTEBOOK_BLOCKS_MAX", 6)
        patcher.start()
        self.addCleanup(patcher.stop)

    def blocks(self, n):
        """Structured (a heading first): structured content is refused, never compacted, when over budget."""
        return v2(block("heading", "h"), *[block(text=f"l{i}") for i in range(n - 1)])

    def plain(self, n):
        return v2(*[block(text=f"l{i}") for i in range(n)])

    def test_page_save_cannot_cross_the_budget_but_can_shrink(self):
        self.seed(v1_state([_page("page-a", "a"), _page("page-b", "b")]))  # 2 stored blocks
        out = hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 1, "content": self.blocks(4)})  # 5 total
        self.assertEqual(len(out["page"]["content"]["blocks"]), 4)
        with self.assertRaises(hq_carnet.CarnetError) as ctx:
            hq_carnet.mutate({"action": "page_save", "id": "page-b", "expected_rev": 1, "content": self.blocks(3)})  # 4 + 3 = 7 > 6
        self.assertIn("volumineux", str(ctx.exception))
        exact = hq_carnet.mutate({"action": "page_save", "id": "page-b", "expected_rev": 1, "content": self.blocks(2)})  # 4 + 2 = 6
        self.assertEqual(len(exact["page"]["content"]["blocks"]), 2)
        shrunk = hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 2, "content": self.blocks(1)})
        self.assertEqual(len(shrunk["page"]["content"]["blocks"]), 1, "shrinking is always possible")

    def test_plain_content_over_the_budget_degrades_to_one_compact_block(self):
        self.seed(v1_state([_page("page-a", "a"), _page("page-b", "b")]))
        out = hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 1, "content": self.plain(20)})
        self.assertEqual((out["page"]["content"]["version"], len(out["page"]["content"]["blocks"])), (1, 1))
        self.assertEqual(flat(out["page"]), "\n".join(f"l{i}" for i in range(20)))
        self.assertLessEqual(sum(len(p["content"]["blocks"]) for p in self.disk()["pages"]), rich.NOTEBOOK_BLOCKS_MAX)

    def test_page_create_cannot_cross_the_budget(self):
        self.seed(v1_state([_page("page-a", "a") for _ in range(1)]))
        hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 1, "content": self.blocks(5)})  # 5
        out = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 4})  # 6
        self.assertEqual(out["notebook_rev"], 5)
        raw = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetError) as ctx:
            hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 5})  # 7
        self.assertIn("volumineux", str(ctx.exception))
        self.assertEqual(self.path.read_bytes(), raw)
        hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 2, "content": self.blocks(1)})
        hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 5})  # recovery: room again

    def test_final_active_page_trash_replacement_cannot_cross_the_budget(self):
        self.seed(v1_state([_page("page-a", "a"), _page("page-t", "t", deleted_at=1.0)]))
        hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 1, "content": self.blocks(5)})  # 5 + 1 (trash) = 6
        raw = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetError) as ctx:
            hq_carnet.mutate({"action": "page_trash", "id": "page-a", "expected_rev": 2, "expected_notebook_rev": 4})  # would add a blank page
        self.assertIn("volumineux", str(ctx.exception))
        self.assertEqual(self.path.read_bytes(), raw, "the page is not trashed, no replacement invented")
        hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 2, "content": self.blocks(2)})  # recover: 2 + 1 = 3
        out = hq_carnet.mutate({"action": "page_trash", "id": "page-a", "expected_rev": 3, "expected_notebook_rev": 4})
        self.assertIn("replacement_page", out, "with room the invariant (one usable page) is kept")

    def test_trashing_a_non_final_page_is_never_blocked_by_the_budget(self):
        self.seed(v1_state([_page("page-a", "a"), _page("page-b", "b")]))
        hq_carnet.mutate({"action": "page_save", "id": "page-a", "expected_rev": 1, "content": self.blocks(4)})  # 5 total (a4 + b1)
        out = hq_carnet.mutate({"action": "page_trash", "id": "page-a", "expected_rev": 2, "expected_notebook_rev": 4})
        self.assertNotIn("replacement_page", out)

    def test_over_budget_legacy_state_can_only_recover(self):
        state = v1_state([_page(f"page-{i}", "x") for i in range(3)])
        for page in state["pages"]:
            page["content"] = {"version": 2, "blocks": [{"id": f"block-{page['id'][5:]}{j}", "type": "paragraph", "text": "x", "marks": []} for j in range(4)]}
        self.seed(state)  # 12 stored blocks > 6
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 4})
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "page_save", "id": "page-0", "expected_rev": 1, "content": self.blocks(5)})
        same = hq_carnet.mutate({"action": "page_save", "id": "page-0", "expected_rev": 1, "content": self.blocks(4), "pinned": True})
        self.assertEqual(len(same["page"]["content"]["blocks"]), 4, "same count is allowed")
        smaller = hq_carnet.mutate({"action": "page_save", "id": "page-0", "expected_rev": 2, "content": self.blocks(1)})
        self.assertEqual(len(smaller["page"]["content"]["blocks"]), 1)


class StructureTests(CarnetBase):
    def setUp(self):
        super().setUp()
        self.seed(_fixture())

    def save_v2(self, page_id, rev, content, **extra):
        return hq_carnet.mutate({"action": "page_save", "id": page_id, "expected_rev": rev, "content": content, **extra})

    def test_formatting_persists_in_canonical_form(self):
        marks = [
            {"end": 5, "start": 3, "type": "italic"},  # key order is irrelevant
            {"type": "bold", "start": 0, "end": 3},
            {"type": "bold", "start": 3, "end": 6},  # touches the first bold -> merged
            {"type": "bold", "start": 2, "end": 4},  # overlaps -> merged
            {"type": "code", "start": 6, "end": 9},
        ]
        out = self.save_v2("page-idea", 1, v2(block("check", "abcdefghi", marks, checked=True), block("number", "n"), block("bullet", "b")))
        blocks = out["page"]["content"]["blocks"]
        self.assertEqual(
            blocks[0]["marks"],
            [{"type": "bold", "start": 0, "end": 6}, {"type": "italic", "start": 3, "end": 5}, {"type": "code", "start": 6, "end": 9}],
        )
        self.assertEqual([b["type"] for b in blocks], ["check", "number", "bullet"])
        self.assertIs(blocks[0]["checked"], True)
        self.assertNotIn("checked", blocks[1])
        disk = self.page("page-idea")
        self.assertEqual(disk["content"], out["page"]["content"])
        self.assertTrue(rich.valid_v2(disk["content"]))
        self.assertEqual(hq_carnet.get_notebook(meta=True)["pages"][1]["title"], "abcdefghi")

    def test_limits_expose_the_structure_bounds(self):
        limits = hq_carnet.get_notebook()["limits"]
        self.assertEqual((limits["page_blocks"], limits["notebook_blocks"], limits["marks_per_block"]),
                         (rich.BLOCKS_MAX, rich.NOTEBOOK_BLOCKS_MAX, rich.MARKS_PER_BLOCK_MAX))
        self.assertEqual(limits["page_text_bytes"], 49152)

    def test_block_ids_are_server_owned_and_logical(self):
        # a V1 page carries one legacy id; the client may send it, everything else is new
        first = self.save_v2("page-idea", 1, v2({"id": "block-idea", **block(text="one")}, block(text="two")))
        ids = [b["id"] for b in first["page"]["content"]["blocks"]]
        self.assertEqual(ids[0], "block-idea", "an id the client sent (it belongs to the page) is kept")
        self.assertRegex(ids[1], r"^block-[0-9a-f]{24}$", "a block without id is new: the server generates it")
        A, B = ids
        # insert a NEW first block and send the old ids on their own blocks
        out = self.save_v2("page-idea", 2, v2(block(text="NEW"), {"id": A, **block(text="one")}, {"id": B, **block(text="two")}))
        got = [(b["id"], b["text"]) for b in out["page"]["content"]["blocks"]]
        self.assertEqual(got[1:], [(A, "one"), (B, "two")], "existing blocks keep their identity when a block is inserted before them")
        self.assertNotIn(got[0][0], (A, B))
        self.assertRegex(got[0][0], r"^block-[0-9a-f]{24}$")
        N = got[0][0]
        # split in the middle of a sequence: "one" -> "o" (keeps A) + "ne" (new)
        out = self.save_v2("page-idea", 3, v2({"id": N, **block(text="NEW")}, {"id": A, **block(text="o")}, block(text="ne"), {"id": B, **block(text="two")}))
        got = [(b["id"], b["text"]) for b in out["page"]["content"]["blocks"]]
        self.assertEqual((got[0], got[1], got[3]), ((N, "NEW"), (A, "o"), (B, "two")))
        self.assertNotIn(got[2][0], (N, A, B))
        # deletion keeps the survivors' ids
        out = self.save_v2("page-idea", 4, v2({"id": N, **block(text="NEW")}, {"id": B, **block(text="two")}))
        self.assertEqual([b["id"] for b in out["page"]["content"]["blocks"]], [N, B])
        # formatting keeps ids too
        out = self.save_v2("page-idea", 5, v2({"id": N, **block("heading", "NEW")}, {"id": B, **block(text="two", marks=[{"type": "bold", "start": 0, "end": 1}])}))
        self.assertEqual([b["id"] for b in out["page"]["content"]["blocks"]], [N, B])
        # a text-only edit of the same blocks never renames them
        out = self.save_v2("page-idea", 6, v2({"id": N, **block("heading", "NEW!")}, {"id": B, **block(text="two", marks=[{"type": "bold", "start": 0, "end": 1}])}))
        self.assertEqual([b["id"] for b in out["page"]["content"]["blocks"]], [N, B])

    def test_foreign_duplicate_or_malformed_ids_are_refused(self):
        first = self.save_v2("page-idea", 1, v2({"id": "block-idea", **block(text="one")}, block(text="two")))
        ids = [b["id"] for b in first["page"]["content"]["blocks"]]
        raw = self.path.read_bytes()
        for bad in ("block-evil", "notanid", 5, None, "block-idea ", "page-x"):
            with self.assertRaises(hq_carnet.CarnetError, msg=repr(bad)):
                self.save_v2("page-idea", 2, v2({"id": bad, **block(text="x")}))
        # an id of ANOTHER page's block is foreign here
        shaft_id = self.page("page-shaft")["content"]["blocks"][0]["id"]
        with self.assertRaises(hq_carnet.CarnetError):
            self.save_v2("page-idea", 2, v2({"id": shaft_id, **block(text="x")}))
        with self.assertRaises(hq_carnet.CarnetError):
            self.save_v2("page-idea", 2, v2({"id": ids[0], **block(text="x")}, {"id": ids[0], **block(text="y")}))
        self.assertEqual(self.path.read_bytes(), raw)

    def test_identical_structure_is_not_a_change_but_mark_only_change_is(self):
        first = self.save_v2("page-idea", 1, v2(block(text="abc", marks=[{"type": "bold", "start": 0, "end": 2}])))
        same = self.save_v2("page-idea", 2, v2(block(text="abc", marks=[{"start": 0, "type": "bold", "end": 2}])))
        self.assertEqual((first["page"]["rev"], same["page"]["rev"]), (2, 2))
        changed = self.save_v2("page-idea", 2, v2(block(text="abc", marks=[{"type": "italic", "start": 0, "end": 2}])))
        self.assertEqual(changed["page"]["rev"], 3)
        toggled = self.save_v2("page-idea", 3, v2(block("check", "abc", [{"type": "italic", "start": 0, "end": 2}], checked=True)))
        self.assertEqual(toggled["page"]["rev"], 4, "a checkbox toggle is a real revision")

    def test_invalid_structures_are_rejected_without_writing(self):
        raw = self.path.read_bytes()
        cases = {
            "unknown block type": v2(block("quote", "x")),
            "html-ish type": v2(block("<b>", "x")),
            "newline in line": v2(block(text="a\nb")),
            "control char": v2(block(text="a\x00b")),
            "checked on non-check": v2(block("bullet", "x", checked=True)),
            "checked not bool": v2(block("check", "x", checked="yes")),
            "extra block key": v2({**block(text="x"), "html": "<b>"}),
            "unknown mark": v2(block(text="abc", marks=[{"type": "blink", "start": 0, "end": 1}])),
            "negative start": v2(block(text="abc", marks=[{"type": "bold", "start": -1, "end": 1}])),
            "empty range": v2(block(text="abc", marks=[{"type": "bold", "start": 1, "end": 1}])),
            "reversed range": v2(block(text="abc", marks=[{"type": "bold", "start": 2, "end": 1}])),
            "past end": v2(block(text="abc", marks=[{"type": "bold", "start": 0, "end": 4}])),
            "bool offsets": v2(block(text="abc", marks=[{"type": "bold", "start": False, "end": True}])),
            "float offsets": v2(block(text="abc", marks=[{"type": "bold", "start": 0.0, "end": 2}])),
            "extra mark key": v2(block(text="abc", marks=[{"type": "bold", "start": 0, "end": 1, "style": "x"}])),
            "empty blocks": v2(),
            "not a list": {"version": 2, "blocks": "x"},
            "wrong version": {"version": 9, "blocks": [block(text="x")]},
            "extra content key": {"version": 2, "blocks": [block(text="x")], "html": "<b>"},
            "marks not a list": v2(block(text="abc", marks={"type": "bold"})),
            "too many structured blocks": v2(block("heading", "x"), *[block(text="x") for _ in range(rich.BLOCKS_MAX)]),
            "too many marks in a block": v2(block(text="x" * 400, marks=[{"type": "bold", "start": i * 2, "end": i * 2 + 1} for i in range(rich.MARKS_PER_BLOCK_MAX + 1)])),
        }
        for label, content in cases.items():
            with self.assertRaises(hq_carnet.CarnetError, msg=label):
                self.save_v2("page-idea", 1, content)
            self.assertEqual(self.path.read_bytes(), raw, label)

    def test_marks_never_split_a_surrogate_pair(self):
        text = "a😀b"  # UTF-16: a, D83D, DE00, b
        ok = self.save_v2("page-idea", 1, v2(block(text=text, marks=[{"type": "bold", "start": 1, "end": 3}])))
        self.assertEqual(ok["page"]["content"]["blocks"][0]["marks"], [{"type": "bold", "start": 1, "end": 3}])
        for start, end in ((2, 3), (1, 2), (0, 2), (2, 4)):
            with self.assertRaises(hq_carnet.CarnetError, msg=(start, end)):
                self.save_v2("page-idea", 2, v2(block(text=text, marks=[{"type": "bold", "start": start, "end": end}])))
        with self.assertRaises(hq_carnet.CarnetError):
            self.save_v2("page-idea", 2, v2(block(text=text, marks=[{"type": "bold", "start": 0, "end": 5}])))  # 4 UTF-16 units

    def test_byte_limits_count_the_flat_text(self):
        limit = hq_carnet.PAGE_TEXT_BYTES
        lines = 100
        per = (limit - (lines - 1)) // lines  # bytes per line so that text + newlines == limit
        good = v2(*[block(text="é" * (per // 2)) for _ in range(lines)])
        size = sum(len(b["text"].encode()) for b in good["blocks"]) + lines - 1
        self.assertLessEqual(size, limit)
        self.assertGreater(size, limit - 300)
        self.save_v2("page-idea", 1, good)
        # one more byte in the flat text is refused
        too_big = v2(*[block(text="é" * (per // 2)) for _ in range(lines)], block(text="é" * 300))
        with self.assertRaises(hq_carnet.CarnetError):
            self.save_v2("page-idea", 2, too_big)
        # exact boundary: fill to exactly the limit, then +1 byte
        exact = v2(block(text="a" * limit))
        self.save_v2("page-idea", 2, exact)
        with self.assertRaises(hq_carnet.CarnetError):
            self.save_v2("page-idea", 3, v2(block(text="a" * limit), block(text="")))  # the extra newline is a byte
        with self.assertRaises(hq_carnet.CarnetError):
            self.save_v2("page-idea", 3, v2(block(text="a" * (limit + 1))))

    def test_notebook_total_uses_flat_text(self):
        state = _fixture()
        big = "x" * (hq_carnet.PAGE_TEXT_BYTES - 1)
        state["pages"] = [_page(f"page-b{i}", big) for i in range(21)] + [_page("page-small", "s")]
        self.seed(state)
        with self.assertRaises(hq_carnet.CarnetError) as ctx:
            self.save_v2("page-small", 1, v2(block(text="s" * 20000)))
        self.assertIn("volumineux", str(ctx.exception))

    def test_stale_structured_save_is_a_normal_conflict_with_current_structure(self):
        remote = self.save_v2("page-idea", 1, v2(block("heading", "remote"), block("check", "todo", checked=True)))
        raw = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetConflict) as ctx:
            self.save_v2("page-idea", 1, v2(block("bullet", "local")))
        payload = ctx.exception.payload
        self.assertEqual(payload["code"], "revision_conflict")
        self.assertEqual(payload["page"]["content"], remote["page"]["content"])
        self.assertEqual(self.path.read_bytes(), raw)

    def test_trashed_structured_page_keeps_structure_through_restore(self):
        saved = self.save_v2("page-idea", 1, v2(block("heading", "H"), block("check", "c", [{"type": "bold", "start": 0, "end": 1}], checked=True)))
        rev = saved["page"]["rev"]
        trashed = hq_carnet.mutate({"action": "page_trash", "id": "page-idea", "expected_rev": rev, "expected_notebook_rev": 4})
        with self.assertRaises(hq_carnet.CarnetError):
            self.save_v2("page-idea", trashed["page"]["rev"], v2(block(text="nope")))
        restored = hq_carnet.mutate(
            {"action": "page_restore", "id": "page-idea", "expected_rev": trashed["page"]["rev"], "expected_notebook_rev": trashed["notebook_rev"]}
        )
        self.assertEqual(restored["page"]["content"], saved["page"]["content"])

    def test_title_and_preview_come_from_flat_text(self):
        self.save_v2("page-idea", 1, v2(block(text=""), block("heading", "  Titre  "), block("bullet", "a"), block("check", "b")))
        meta = {p["id"]: p for p in hq_carnet.get_notebook(meta=True)["pages"]}["page-idea"]
        self.assertEqual((meta["title"], meta["preview"]), ("Titre", "a b"))
        self.assertNotIn("marks", json.dumps(meta))


class LinkTests(CarnetBase):
    def setUp(self):
        super().setUp()
        self.seed(_fixture())

    def link(self, **target):
        return v2(block(text="click here", marks=[{"type": "link", "start": 0, "end": 5, **target}]))

    def test_only_http_and_https_external_links(self):
        good = ["http://example.com", "https://example.com/a?b=c#d", "HTTPS://EXAMPLE.COM", "https://user-less.example:8443/p", "http://[::1]:8080/x", "https://例え.jp/パス"]
        for i, href in enumerate(good):
            out = hq_carnet.mutate({"action": "page_save", "id": "page-idea", "expected_rev": 1 + i, "content": self.link(href=href)})
            self.assertEqual(out["page"]["content"]["blocks"][0]["marks"][0]["href"], href)
        bad = [
            "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "blob:https://x/uuid",
            "ftp://example.com", "mailto:a@b.c", "//example.com", "example.com", "http:", "https://", "http:///nohost", "https://user:pw@example.com",
            "https://exa mple.com", "https://example.com/\nx", "https://example.com/\\x", "https://example.com/<x>", 'https://example.com/"x', "http://x:99999999/",
            "https://" + "a" * 3000, "", None, 5, ["https://a.b"], {"u": 1},
        ]
        rev = 1 + len(good)
        for href in bad:
            with self.assertRaises(hq_carnet.CarnetError, msg=repr(href)):
                hq_carnet.mutate({"action": "page_save", "id": "page-idea", "expected_rev": rev, "content": self.link(href=href)})

    def test_link_needs_exactly_one_target(self):
        rev = 1
        for extra in ({}, {"href": "https://a.b", "ref": {"kind": "note", "id": "page-idea"}}):
            with self.assertRaises(hq_carnet.CarnetError):
                hq_carnet.mutate({"action": "page_save", "id": "page-idea", "expected_rev": rev, "content": self.link(**extra)})

    def test_internal_references_use_existing_stable_ids_only(self):
        good = [
            {"kind": "note", "id": "page-shaft"},
            {"kind": "file", "id": "Uni/Cours/notes.pdf"},
            {"kind": "media", "id": "Inbox/Photos/a.jpg"},
            {"kind": "model", "id": "Print/part.stl"},
            {"kind": "drawing", "id": "shaft-v2"},
        ]
        for i, ref in enumerate(good):
            out = hq_carnet.mutate({"action": "page_save", "id": "page-idea", "expected_rev": 1 + i, "content": self.link(ref=ref)})
            self.assertEqual(out["page"]["content"]["blocks"][0]["marks"][0]["ref"], ref)
        bad = [
            {"kind": "note", "id": "shaft"}, {"kind": "note", "id": "page-../x"}, {"kind": "url", "id": "x"},
            {"kind": "file", "id": "../secret.txt"}, {"kind": "file", "id": "Inbox/../../x"}, {"kind": "file", "id": "/etc/passwd"},
            {"kind": "file", "id": "C:/Windows/x"}, {"kind": "file", "id": "Inbox\\x.txt"}, {"kind": "file", "id": "Elsewhere/x.txt"},
            {"kind": "file", "id": "Inbox/.hidden"}, {"kind": "file", "id": "Inbox/%2e%2e/x"}, {"kind": "file", "id": "Inbox"},
            {"kind": "model", "id": "Print/a.pdf"}, {"kind": "media", "id": "Uni/a.pdf"}, {"kind": "drawing", "id": "../x"},
            {"kind": "note"}, {"kind": "note", "id": "page-a", "extra": 1}, "page-a", None,
        ]
        rev = 1 + len(good)
        for ref in bad:
            with self.assertRaises(hq_carnet.CarnetError, msg=repr(ref)):
                hq_carnet.mutate({"action": "page_save", "id": "page-idea", "expected_rev": rev, "content": self.link(ref=ref)})

    def test_links_merge_by_target_and_never_overlap(self):
        out = hq_carnet.mutate({"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": v2(block(text="abcdefgh", marks=[
            {"type": "link", "start": 0, "end": 3, "href": "https://a.b"}, {"type": "link", "start": 3, "end": 5, "href": "https://a.b"},
            {"type": "link", "start": 6, "end": 8, "href": "https://c.d"}]))})
        self.assertEqual([(m["start"], m["end"]) for m in out["page"]["content"]["blocks"][0]["marks"]], [(0, 5), (6, 8)])
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "page_save", "id": "page-idea", "expected_rev": 2, "content": v2(block(text="abcdefgh", marks=[
                {"type": "link", "start": 0, "end": 4, "href": "https://a.b"}, {"type": "link", "start": 3, "end": 6, "href": "https://c.d"}]))})

    def test_no_html_is_stored_or_interpreted(self):
        evil = "<img src=x onerror=alert(1)>&amp;"
        out = hq_carnet.mutate({"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": v2(block(text=evil))})
        self.assertEqual(out["page"]["content"]["blocks"][0]["text"], evil)
        self.assertIn(evil, self.path.read_text(encoding="utf-8").replace("\\u003c", "<"))


class SharedVectorTests(unittest.TestCase):
    """The same vectors run in Node (check_hq_carnet_rich.mjs): both canonicalisers and renderers agree."""

    def setUp(self):
        self.vectors = json.loads(SHARED.read_text(encoding="utf-8"))

    def test_canonical_marks_vectors(self):
        for case in self.vectors["canonical"]:
            self.assertEqual(rich.canonical_marks(case["in"]), case["out"], case["name"])

    def test_txt_and_markdown_vectors(self):
        for case in self.vectors["render"]:
            dummy = {"version": 1, "blocks": [{"id": "block-x", "type": "text", "text": "", "marks": []}]}
            parsed = rich.parse_content({"version": 2, "blocks": case["blocks"]}, existing=dummy, text_limit=10**6)
            content = rich.store_content(parsed, dummy)
            self.assertEqual(rich.render_txt(content), case["txt"], case["name"] + " txt")
            self.assertEqual(rich.render_markdown(content), case["md"], case["name"] + " md")

    def test_filename_vectors(self):
        for case in self.vectors["filename"]:
            self.assertEqual(rich.export_filename(case["given"], case["title"], case["fmt"]), case["out"], case)


class ExportTests(CarnetBase):
    def setUp(self):
        super().setUp()
        for name in ("Inbox", "Uni", "Print"):
            (self.tmp / name).mkdir()
        self.seed(_fixture())
        hq_carnet.bind(
            root=self.tmp,
            now=lambda: self.clock[0],
            folders=lambda: ["Inbox", "Uni", "Print"],
            system_names=iphone_bridge.SYSTEM_NAMES,
            safe_leaf_name=iphone_bridge.safe_leaf_name,
        )
        self.save_rich()

    def save_rich(self):
        content = v2(
            block("heading", "Shaft *notes*"),
            block("check", "measure Ø12", [{"type": "bold", "start": 0, "end": 7}], checked=True),
            block("number", "first"),
            block("number", "second", [{"type": "link", "start": 0, "end": 6, "href": "https://example.com/a(b)"}]),
            block("paragraph", "plain _text_"),
        )
        self.rev = hq_carnet.mutate({"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": content})["page"]["rev"]

    def export(self, **over):
        payload = {"action": "page_export", "id": "page-idea", "expected_rev": self.rev, "format": "md", "dir": "Inbox"}
        payload.update(over)
        return hq_carnet.export_copy(payload)

    def test_snapshot_is_written_deterministically_and_reports_no_absolute_path(self):
        out = self.export(filename="Ma note.md")
        self.assertEqual(out["path"], "Inbox/Ma note.md")
        self.assertEqual((out["rev"], out["format"], out["ok"]), (self.rev, "md", True))
        self.assertNotIn(str(self.tmp), json.dumps(out))
        text = (self.tmp / "Inbox" / "Ma note.md").read_text(encoding="utf-8")
        self.assertEqual(text, rich.render_markdown(self.page("page-idea")["content"]))
        self.assertIn("## Shaft \\*notes\\*", text)
        self.assertIn("- [x] **measure**", text)
        self.assertIn("1. first\n2. [second](https://example.com/a%28b%29)", text)
        txt = self.export(format="txt", filename="Ma note")
        self.assertEqual(txt["name"], "Ma note.txt")
        body = (self.tmp / "Inbox" / "Ma note.txt").read_text(encoding="utf-8")
        self.assertEqual(body, "Shaft *notes*\n[x] measure Ø12\n1. first\n2. second (https://example.com/a(b))\nplain _text_\n")
        self.assertEqual(self.disk()["notebook_rev"], 4, "export never mutates the notebook")

    def test_default_filename_is_derived_and_sanitised(self):
        out = self.export()
        self.assertEqual(out["name"], "Shaft -notes.md")
        self.assertTrue((self.tmp / "Inbox" / out["name"]).is_file())

    def test_noclobber_never_overwrites(self):
        target = self.tmp / "Uni" / "keep.md"
        target.write_text("precious", encoding="utf-8")
        with self.assertRaises(hq_carnet.CarnetConflict) as ctx:
            self.export(dir="Uni", filename="keep.md")
        self.assertEqual(ctx.exception.payload["code"], "export_exists")
        self.assertEqual(target.read_text(encoding="utf-8"), "precious")
        # case variants of the same name are still a distinct explicit choice, never a silent replace
        self.export(dir="Uni", filename="keep2.md")
        with self.assertRaises(hq_carnet.CarnetConflict):
            self.export(dir="Uni", filename="keep2.md")

    def test_directory_confinement(self):
        bad_dirs = [
            "", "..", "../x", "Inbox/..", "Inbox/../Uni", "Inbox/../../x", "/etc", "/Inbox", "C:/x", "C:\\x", "Inbox\\x", "Inbox/../../etc",
            "Other", "inbox2", "Inbox//x", "Inbox/./x", "Inbox/.hidden", "Inbox/ x", "Inbox/x.", "Inbox/con", "Inbox/aux.txt",
            "Inbox/bridge_config.json", "Inbox/" + "a" * 90, "/".join(["Inbox"] + ["d"] * 7), "Inbox/a:b", "Inbox/a\x00b", "Inbox/a|b", None, 5, ["Inbox"],
        ]
        for value in bad_dirs:
            with self.assertRaises(hq_carnet.CarnetError, msg=repr(value)):
                self.export(dir=value)
        self.assertEqual(sorted(os.listdir(self.tmp / "Inbox")), [])
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir() if not p.name.startswith(".")), ["Inbox", "Print", "Uni"])

    def test_subfolders_are_created_inside_roots_only(self):
        out = self.export(dir="Print/Carnet/2026", filename="x.txt", format="txt")
        self.assertEqual(out["path"], "Print/Carnet/2026/x.txt")
        self.assertTrue((self.tmp / "Print" / "Carnet" / "2026" / "x.txt").is_file())
        # the roots themselves are never invented
        (self.tmp / "Uni").rmdir()
        with self.assertRaises(hq_carnet.CarnetError):
            self.export(dir="Uni")
        self.assertFalse((self.tmp / "Uni").exists())

    def test_symlinked_folders_cannot_escape(self):
        outside = Path(self.tmp.parent) / (self.tmp.name + "-outside")
        outside.mkdir()
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        _dir_symlink(outside, self.tmp / "Inbox" / "link")
        with self.assertRaises(hq_carnet.CarnetError):
            self.export(dir="Inbox/link")
        with self.assertRaises(hq_carnet.CarnetError):
            self.export(dir="Inbox/link/deeper")
        self.assertEqual(os.listdir(outside), [])
        # a symlink standing where the FILE would go is never followed either
        try:
            os.symlink(outside / "victim.md", self.tmp / "Inbox" / "trap.md")
        except (OSError, NotImplementedError):
            self.skipTest("file symlinks unavailable")
        with self.assertRaises(hq_carnet.CarnetConflict):
            self.export(filename="trap.md")
        self.assertEqual(os.listdir(outside), [])

    def test_filename_sanitisation(self):
        cases = {
            "../../evil.md": "evil.md", "a/b\\d.md": "a-b-d.md", "CON.md": "_CON.md", "nul": "_nul.md", "  .hidden  ": "hidden.md",
            "name.md.md": "name.md.md", "": "Shaft -notes.md", "x" * 150: "x" * 80 + ".md", "é ü.txt": "é ü.md", "a:b*c?.md": "a-b-c.md",
            "<script>.md": "script.md",
        }
        for given, expected in cases.items():
            out = self.export(filename=given, dir="Inbox/san")
            self.assertEqual(out["name"], expected, given)
            self.assertTrue((self.tmp / "Inbox" / "san" / expected).is_file(), out)
        self.assertEqual(sorted(os.listdir(self.tmp / "Inbox" / "san")), sorted(cases.values()))
        self.assertEqual([p.name for p in self.tmp.iterdir() if p.is_file()], [])

    def test_stale_revision_and_trash_are_refused(self):
        with self.assertRaises(hq_carnet.CarnetConflict) as ctx:
            self.export(expected_rev=self.rev - 1)
        self.assertEqual(ctx.exception.payload["code"], "revision_conflict")
        self.assertEqual(os.listdir(self.tmp / "Inbox"), [])
        trashed = hq_carnet.mutate({"action": "page_trash", "id": "page-idea", "expected_rev": self.rev, "expected_notebook_rev": 4})
        with self.assertRaises(hq_carnet.CarnetError):
            self.export(expected_rev=trashed["page"]["rev"])
        with self.assertRaises(hq_carnet.CarnetNotFound):
            self.export(id="page-none")

    def test_validation_of_request_shape(self):
        for over in ({"format": "pdf"}, {"format": None}, {"filename": 5}, {"filename": "x" * 201}, {"expected_rev": "1"}, {"id": "bad"}):
            with self.assertRaises(hq_carnet.CarnetError, msg=over):
                self.export(**over)
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.export_copy({"action": "page_export", "id": "page-idea", "expected_rev": self.rev, "format": "md", "dir": "Inbox", "text": "smuggled"})

    def test_http_layer_maps_errors_and_never_echoes_paths_or_text(self):
        code, payload = hq_carnet.http_post({"action": "page_export", "id": "page-idea", "expected_rev": self.rev, "format": "md", "dir": "Inbox", "filename": "h.md"})
        self.assertEqual(code, 200)
        code, payload = hq_carnet.http_post({"action": "page_export", "id": "page-idea", "expected_rev": self.rev, "format": "md", "dir": "Inbox", "filename": "h.md"})
        self.assertEqual((code, payload["code"]), (409, "export_exists"))
        self.assertNotIn(str(self.tmp), json.dumps(payload))
        code, payload = hq_carnet.http_post({"action": "page_export", "id": "page-idea", "expected_rev": self.rev, "format": "md", "dir": "../.."})
        self.assertEqual((code, payload["code"]), (400, "validation_error"))
        self.assertNotIn("Shaft", json.dumps(payload))


class StaticSecurityTests(unittest.TestCase):
    """The browser modules stay dependency-free and never turn note text into markup."""

    ROOT = Path(__file__).resolve().parents[1]

    def setUp(self):
        self.files = {n: (self.ROOT / "assets" / n).read_text(encoding="utf-8") for n in ("hq-carnet.js", "hq-carnet-rich.js", "hq-carnet.css")}

    def test_no_html_sinks_eval_or_external_urls(self):
        import re

        for name in ("hq-carnet.js", "hq-carnet-rich.js"):
            text = self.files[name]
            for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "execScript", "setTimeout(\"", "DOMParser", "createContextualFragment"):
                self.assertNotIn(sink, text, f"{name}: {sink}")
            self.assertNotRegex(text, r"https?://(?!www\.w3\.org/2000/svg)", name)
            self.assertNotIn("import(", text)
            self.assertNotIn("XMLHttpRequest", text)
        self.assertNotRegex(self.files["hq-carnet.css"], r"https?://|@import|url\(|@font-face")
        # execCommand is only ever used for plain text insertion and copy (never a formatting command)
        cmds = set(re.findall(r'execCommand\(\s*"([A-Za-z]+)"', self.files["hq-carnet.js"]))
        self.assertLessEqual(cmds, {"insertText", "copy"})

    def test_links_are_built_only_from_validated_targets(self):
        rich_js = self.files["hq-carnet-rich.js"]
        self.assertIn('"noopener noreferrer"', rich_js)
        self.assertIn("safeHref(", rich_js)
        # the only place an href attribute is set goes through link.href of a parsed mark
        self.assertEqual(rich_js.count('setAttribute("href"'), 1)
        self.assertIn('global.open(href, "_blank", "noopener,noreferrer")', self.files["hq-carnet.js"])

    def test_script_order_and_print_only_container(self):
        html = iphone_bridge.render_app().decode("utf-8")
        self.assertLess(html.index('<script src="/assets/hq-carnet-rich.js"></script>'), html.index('<script src="/assets/hq-carnet.js"></script>'))
        css = self.files["hq-carnet.css"]
        self.assertIn("#hq-carnet-print{display:none}", css)
        self.assertIn("@media print", css)
        self.assertIn("body.carnet-printing > *:not(#hq-carnet-print){display:none!important}", css)

    def test_touch_targets_and_focus_chrome(self):
        css = self.files["hq-carnet.css"]
        self.assertIn(".carnet-fmt{flex:0 0 auto;min-width:var(--carnet-tap);min-height:var(--carnet-tap)", css)
        self.assertIn("--carnet-check-w:44px", css)
        self.assertIn(".carnet.is-focus .carnet-format,.carnet.is-focus .carnet-panel,.carnet.is-focus [data-carnet-tool]", css)

    def test_no_new_server_dependencies(self):
        import ast

        stdlib = set(sys.stdlib_module_names)
        for name in ("hq_carnet_rich.py", "hq_carnet.py", "hq_carnet_media.py", "hq_carnet_eng.py"):  # Stage 06 media module, Stage 07 engineering module
            tree = ast.parse((self.ROOT / name).read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                mods = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.module else []
                for mod in mods:
                    top = mod.split(".")[0]
                    self.assertTrue(top in stdlib or top in ("hq_state", "hq_carnet_rich", "hq_carnet_sources", "hq_carnet_media", "hq_carnet_eng", "hq_carnet_bulk", "hq_carnet_history", "hq_carnet_links", "hq_carnet_report", "hq_carnet_restore", "__future__"), f"{name}: {mod}")  # + Stage 08 modules


class ExportHttpTests(unittest.TestCase):
    """Auth/CSRF wrap the export action exactly like every other Carnet action."""

    @classmethod
    def setUpClass(cls):
        import shutil
        import tempfile
        import threading
        from http.server import ThreadingHTTPServer
        from urllib.parse import urlencode

        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-carnet-export-"))
        cls._shutil = shutil
        cls._root = iphone_bridge.ROOT
        cls._config = json.loads(json.dumps(iphone_bridge.CONFIG))
        cls._carnet_cb, cls._carnet_ready = dict(hq_carnet._cb), hq_carnet._ready
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
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

        def login(pin):
            status, headers, _b = _http(
                cls.port, "POST", "/login", body=urlencode({"pin": pin}).encode(),
                headers={"Origin": f"http://127.0.0.1:{cls.port}", "Content-Type": "application/x-www-form-urlencoded"},
            )
            assert status == 303, status
            return (headers.get("Set-Cookie") or headers.get("set-cookie") or "").split(";", 1)[0]

        cls.admin, cls.upload = login("424242"), login("111111")
        path = cls.tmp / ".hq-carnet" / "notebook.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        cls.state = _fixture()
        path.write_text(json.dumps(cls.state, ensure_ascii=False), encoding="utf-8")

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
        cls._shutil.rmtree(cls.tmp, ignore_errors=True)

    def post(self, payload, *, cookie, origin=True):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = f"http://127.0.0.1:{self.port}"
        return _http(self.port, "POST", "/api/carnet", body=json.dumps(payload).encode(), headers=headers, cookie=cookie)

    def payload(self, name):
        return {"action": "page_export", "id": "page-idea", "expected_rev": 1, "format": "txt", "dir": "Inbox", "filename": name}

    def test_admin_exports_with_bridge_confinement(self):
        status, _h, body = self.post(self.payload("via-http.txt"), cookie=self.admin)
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["path"], "Inbox/via-http.txt")
        self.assertEqual((self.tmp / "Inbox" / "via-http.txt").read_text(encoding="utf-8"), "Try a split clamp instead\n")
        status, _h, body = self.post({**self.payload("x.txt"), "dir": "Inbox/../.."}, cookie=self.admin)
        self.assertEqual(status, 400)
        status, _h, body = self.post({**self.payload("bridge_config.json"), "format": "txt"}, cookie=self.admin)
        self.assertEqual(status, 200)  # sanitised into bridge_config.json.txt, never the config name itself
        self.assertEqual(json.loads(body)["name"], "bridge_config.json.txt")
        self.assertFalse((self.tmp / "Inbox" / "bridge_config.json").exists())

    def test_exported_copies_stay_private_from_the_upload_role(self):
        status, _h, _b = self.post(self.payload("private-copy.txt"), cookie=self.admin)
        self.assertEqual(status, 200)
        for path in ("/files/Inbox/private-copy.txt", "/download/Inbox/private-copy.txt", "/media/Inbox/private-copy.txt", "/api/carnet"):
            status, _h, body = _http(self.port, "GET", path, cookie=self.upload)
            self.assertEqual(status, 403, path)
            self.assertNotIn(b"Try a split clamp", body)

    def test_upload_role_and_csrf_are_unchanged(self):
        status, _h, body = self.post(self.payload("nope.txt"), cookie=self.upload)
        self.assertEqual(status, 403)
        self.assertFalse((self.tmp / "Inbox" / "nope.txt").exists())
        status, _h, body = self.post(self.payload("nocsrf.txt"), cookie=self.admin, origin=False)
        self.assertIn(status, (401, 403))
        self.assertFalse((self.tmp / "Inbox" / "nocsrf.txt").exists())
        status, _h, body = self.post(self.payload("noauth.txt"), cookie="")
        self.assertIn(status, (401, 403))
        self.assertFalse((self.tmp / "Inbox" / "noauth.txt").exists())


if __name__ == "__main__":
    unittest.main()
