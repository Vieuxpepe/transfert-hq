"""Carnet Product Phase 2 — structured blocks (table, callout, toggle, image group): schema, limits, fail-closed storage,
export, report, history, bulk, backup and clean-root recovery.

Throwaway ROOTs only. Browser behaviour: tests/visual_carnet_structured_playwright.mjs; Python/JS parity: tests/check_hq_carnet_structured.mjs.
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import carnet_media_fixtures as F  # noqa: E402
import cc_ext  # noqa: E402
import hq_carnet  # noqa: E402
import hq_carnet_history as history  # noqa: E402
import hq_carnet_media as media  # noqa: E402
import hq_carnet_report as report  # noqa: E402
import hq_carnet_rich as rich  # noqa: E402
import iphone_bridge  # noqa: E402
from test_hq_carnet import _fixture  # noqa: E402
from test_hq_carnet_history import Stage08Base  # noqa: E402
from test_hq_carnet_media import BackupMediaTests as _BackupBase  # noqa: E402,F401
from test_hq_carnet_media import MediaBase, para, upload  # noqa: E402

try:
    import test_backup_retention as _retention
except ImportError:  # pragma: no cover
    from tests import test_backup_retention as _retention


def table(rows, header=True, **extra):
    return {"type": "table", "text": "", "marks": [], "table": {"header": header, "rows": rows}, **extra}


def callout(kind="note", title="", body="", **extra):
    return {"type": "callout", "text": "", "marks": [], "callout": {"kind": kind, "title": title, "body": body}, **extra}


def toggle(summary="Détails", body="", **extra):
    return {"type": "toggle", "text": "", "marks": [], "toggle": {"summary": summary, "body": body}, **extra}


def child(asset, caption=""):
    return {"id": asset["id"], "mime": asset["mime"], "w": asset["w"], "h": asset["h"], "caption": caption}


def group(layout, *assets, captions=None, **extra):
    caps = captions or [""] * len(assets)
    return {"type": "imagegroup", "text": "", "marks": [], "group": {"layout": layout, "items": [child(a, c) for a, c in zip(assets, caps)]}, **extra}


def v2(*blocks):
    return {"version": 2, "blocks": list(blocks)}


class StructBase(MediaBase):
    def setUp(self):
        super().setUp()
        self.page = self.new_page()
        self.a1 = upload(F.png(10, 8))
        self.a2 = upload(F.jpeg(16, 12))
        self.a3 = upload(F.webp_vp8l())

    def save(self, *blocks, page=None):
        page = page or self.page
        out = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": v2(*blocks)})["page"]
        if page is self.page:
            self.page = out
        return out

    def refuse(self, *blocks, msg=None):
        raw = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetError) as cm:
            hq_carnet.mutate({"action": "page_save", "id": self.page["id"], "expected_rev": self.page["rev"], "content": v2(*blocks)})
        self.assertEqual(self.path.read_bytes(), raw, "a refused save writes nothing")
        if msg:
            self.assertIn(msg, str(cm.exception))


class SchemaTests(StructBase):
    def test_all_four_blocks_round_trip_with_server_ids(self):
        page = self.save(
            para("Titre"), table([["A", "B"], ["1", "2,5"]]), callout("warning", "Chaud", "ligne 1\nligne 2"),
            toggle("Détails", "a\n\nb"), group("two", self.a1, self.a2, captions=["avant", ""]),
        )
        blocks = page["content"]["blocks"]
        self.assertEqual([b["type"] for b in blocks], ["paragraph", "table", "callout", "toggle", "imagegroup"])
        self.assertTrue(all(b["id"].startswith("block-") for b in blocks))
        self.assertEqual(len({b["id"] for b in blocks}), 5)
        self.assertTrue(all(b["text"] == "" and b["marks"] == [] for b in blocks[1:]))
        again = hq_carnet.get_notebook()["pages"]
        self.assertEqual(next(p for p in again if p["id"] == page["id"])["content"], page["content"])
        self.assertTrue(rich.valid_v2(page["content"]))

    def test_identical_resave_is_a_noop_and_ids_are_stable(self):
        page = self.save(para("t"), table([["a"]], header=False), callout("info", "", "x"))
        ids = [b["id"] for b in page["content"]["blocks"]]
        same = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": copy.deepcopy(page["content"]["blocks"])}})["page"]
        self.assertEqual(same["rev"], page["rev"])
        edited = copy.deepcopy(page["content"]["blocks"])
        edited[1]["table"]["rows"][0][0] = "b"
        out = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": edited}})["page"]
        self.assertEqual([b["id"] for b in out["content"]["blocks"]], ids, "block ids stay stable across a cell edit")
        self.assertEqual(out["rev"], page["rev"] + 1)

    def test_table_rejections(self):
        bad = {
            "no rows": [],
            "21 rows": [["x"]] * 21,
            "11 cols": [["x"] * 11],
            "ragged": [["a", "b"], ["c"]],
            "empty row": [[]],
            "row not list": ["ab"],
            "int cell": [[1]],
            "bool cell": [[True]],
            "null cell": [[None]],
            "newline": [["a\nb"]],
            "tab": [["a\tb"]],
            "NEL": [["a\x85b"]],
            "line separator": [["a b"]],
            "201 units": [["x" * 201]],
            "astral counts 2": [["\U0001F600" * 101]],
            "lone surrogate": [["a\ud800"]],
            "html is plain text but control bytes are not": [["\x00"]],
            "table over 16 KiB": [["x" * 100] * 10 for _ in range(20)],
        }
        for name, rows in bad.items():
            with self.subTest(name):
                self.refuse(table(rows))
        self.refuse(table([["a"]], header=1))
        self.refuse(table([["a"]], header="true"))
        self.refuse({**table([["a"]]), "table": {"header": True, "rows": [["a"]], "cols": 1}})
        self.refuse({**table([["a"]]), "table": {"rows": [["a"]]}})
        self.refuse({**table([["a"]]), "table": []})

    def test_table_limits_are_inclusive_and_cells_may_be_numeric_text(self):
        ok = self.save(table([[str(r * 10 + c) for c in range(10)] for r in range(20)]))
        self.assertEqual(len(ok["content"]["blocks"][0]["table"]["rows"]), 20)
        self.save(table([["x" * 200]]))
        self.save(table([["\U0001F600" * 100]]))
        self.save(table([["12,5", "-3.0", "1e3", "=A1+B1"]]))  # numeric / formula-looking text is just text

    def test_callout_rejections_and_limits(self):
        self.save(callout("note", "t" * 120, "x" * 2000))
        self.save(callout("info", "", "\n".join(["l"] * 20)))
        for name, block in {
            "kind": callout("danger", "", ""), "kind int": callout(1, "", ""), "title 121": callout("note", "t" * 121, ""), "title newline": callout("note", "a\nb", ""),
            "body 2001": callout("note", "", "x" * 2001), "21 lines": callout("note", "", "\n".join(["l"] * 21)), "CR": callout("note", "", "a\rb"),
            "tab in body": callout("note", "", "a\tb"), "line sep": callout("note", "", "a b"), "title not str": callout("note", None, ""),
        }.items():
            with self.subTest(name):
                self.refuse(block)
        self.refuse({**callout(), "callout": {"kind": "note", "title": "", "body": "", "color": "red"}})
        self.refuse({**callout(), "callout": {"kind": "note", "title": ""}})

    def test_toggle_rejections_and_nesting_is_impossible(self):
        self.save(toggle("s" * 160, "\n".join(["l"] * 50)))
        self.refuse(toggle("", "x"))
        self.refuse(toggle("s" * 161, ""))
        self.refuse(toggle("a\nb", ""))
        self.refuse(toggle("s", "\n".join(["l"] * 51)))
        self.refuse(toggle("s", "x" * 4001))
        self.refuse({**toggle(), "toggle": {"summary": "s", "body": "", "children": []}})
        self.refuse({**toggle(), "toggle": {"summary": "s", "body": "", "blocks": [para("x")]}})

    def test_group_rules(self):
        self.save(group("two", self.a1, self.a2), group("three", self.a1, self.a2, self.a3), group("compare", self.a2, self.a3))
        self.refuse(group("two", self.a1))
        self.refuse(group("two", self.a1, self.a2, self.a3))
        self.refuse(group("three", self.a1, self.a2))
        self.refuse(group("compare", self.a1, self.a2, self.a3))
        self.refuse(group("grid", self.a1, self.a2))
        self.refuse(group("two", self.a1, self.a1), msg="double")
        g = group("two", self.a1, self.a2)
        g["group"]["items"][0]["width"] = 50
        self.refuse(g)
        g = group("two", self.a1, self.a2)
        g["group"]["items"][0]["layout"] = "right"
        self.refuse(g)
        g = group("two", self.a1, self.a2)
        del g["group"]["items"][1]["caption"]
        self.refuse(g)
        g = group("two", self.a1, self.a2, captions=["x" * 301, ""])
        self.refuse(g)
        g = group("two", self.a1, self.a2, captions=["a\nb", ""])
        self.refuse(g)
        g = group("two", self.a1, self.a2)
        g["group"]["items"][0]["id"] = "asset-../../etc"
        self.refuse(g)
        g = group("two", self.a1, self.a2)
        g["group"]["items"][0]["mime"] = "image/gif"
        self.refuse(g)
        self.refuse({**group("two", self.a1, self.a2), "group": {"layout": "two", "items": [child(self.a1), child(self.a2)], "extra": 1}})

    def test_group_children_are_verified_against_the_real_files(self):
        ghost = {"id": "asset-" + "0" * 24, "mime": "image/png", "w": 10, "h": 8}
        self.refuse(group("two", self.a1, ghost))
        lying = {**self.a2, "mime": "image/png"}
        self.refuse(group("two", self.a1, lying))
        wrong_dims = {**self.a2, "w": self.a2["w"] + 1}
        self.refuse(group("two", self.a1, wrong_dims))
        # an already stored reference is never re-verified (a missing file there is preserved state, not a reason to block other edits)
        page = self.save(group("two", self.a1, self.a2))
        for f in os.listdir(self.adir):
            if f.startswith(self.a2["id"]):
                os.remove(self.adir / f)
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [*copy.deepcopy(page["content"]["blocks"]), para("edit")]}})

    def test_block_shape_rules(self):
        base = table([["a"]])
        for name, block in {
            "text": {**base, "text": "x"}, "marks": {**base, "marks": [{"type": "bold", "start": 0, "end": 1}]}, "checked": {**base, "checked": False},
            "asset key": {**base, "asset": {}}, "second payload": {**base, "callout": {"kind": "note", "title": "", "body": ""}},
            "eng payload": {**base, "calc": {}}, "payload without its type": {"type": "paragraph", "text": "", "marks": [], "table": base["table"]},
            "callout type with table key": {"type": "callout", "text": "", "marks": [], "table": base["table"]},
            "group type with callout key": {"type": "imagegroup", "text": "", "marks": [], "callout": {"kind": "note", "title": "", "body": ""}},
            "no payload": {"type": "toggle", "text": "", "marks": []},
        }.items():
            with self.subTest(name):
                self.refuse(block)
        self.refuse({"type": "image", "text": "", "marks": [], "table": base["table"], "asset": {}})

    def test_per_page_counts(self):
        self.save(*[table([["a"]]) for _ in range(20)])
        self.refuse(*[table([["a"]]) for _ in range(21)], msg="tableaux")
        self.save(*[callout("note", "", "x") for _ in range(50)], *[toggle("s", "") for _ in range(50)])
        self.refuse(*[callout("note", "", "x") for _ in range(51)], *[toggle("s", "") for _ in range(50)], msg="encadrés")
        gs = [group("two", self.a1, self.a2) for _ in range(16)]
        self.save(*gs)
        self.refuse(*[group("two", self.a1, self.a2) for _ in range(17)], msg="groupes")
        # group children count toward the existing 32-image cap
        self.refuse(*[group("two", self.a1, self.a2) for _ in range(16)], {"type": "image", "text": "", "marks": [], "asset": {"id": self.a3["id"], "mime": self.a3["mime"], "w": self.a3["w"], "h": self.a3["h"], "width": 60, "layout": "inline", "caption": ""}}, msg="images")

    def test_structured_bytes_page_cap_counts_visible_text_not_json(self):
        body = "x" * 2000
        self.save(*[callout("note", "", body) for _ in range(48)])  # 96,000 B < 98,304
        self.refuse(*[callout("note", "", body) for _ in range(50)], msg="structuré")
        self.assertEqual(rich.structured_bytes(v2(table([["é", "\U0001F600"]]))), 2 + 4, "UTF-8 bytes of the visible strings only")
        self.assertEqual(rich.structured_bytes(v2(callout("note", "", ""), toggle("s", ""))), 1, "empty strings and keys cost nothing")

    def test_notebook_text_budget_includes_structured_text(self):
        with mock.patch.object(hq_carnet, "NOTEBOOK_TEXT_BYTES", 40):
            self.refuse(table([["x" * 60]]))
            self.save(table([["x" * 10]]))

    def test_title_and_preview_never_come_from_structured_blocks(self):
        page = self.save(table([["Tableau"]]), callout("info", "Titre d'encadré", "corps"), toggle("Résumé", "corps"), group("two", self.a1, self.a2, captions=["légende", ""]))
        meta = next(p for p in hq_carnet.get_notebook(meta=True)["pages"] if p["id"] == page["id"])
        self.assertEqual((meta["title"], meta["preview"]), ("Page sans titre", ""))
        page = self.save(table([["Tableau"]]), para("Vrai titre"), callout("info", "t", "b"), para("suite"), page=page)
        meta = next(p for p in hq_carnet.get_notebook(meta=True)["pages"] if p["id"] == page["id"])
        self.assertEqual((meta["title"], meta["preview"]), ("Vrai titre", "suite"))

    def test_search_text_includes_visible_strings_only(self):
        c = v2(para("p"), table([["cellA", "cellB"]]), callout("warning", "titreC", "corpsC"), toggle("sumT", "bodyT"), group("compare", self.a1, self.a2, captions=["capG", ""]))
        c["blocks"] = [{**b, "id": f"block-{i}"} for i, b in enumerate(c["blocks"])]
        text = rich.search_text(c)
        for want in ("cellA", "cellB", "titreC", "corpsC", "sumT", "bodyT", "capG"):
            self.assertIn(want, text)
        for hidden in ("warning", "compare", "header", "asset-", "image/", "rows"):
            self.assertNotIn(hidden, text)
        self.assertEqual(rich.search_text(v2(para("seul"))), "seul")


class SharedVectorTests(unittest.TestCase):
    def test_fixture_is_exactly_what_python_produces(self):
        """The Node parity check consumes this file: if Python changes, the fixture MUST be regenerated (never hand-edited)."""
        import gen_fixtures_carnet_structured as gen

        want = json.loads((Path(__file__).resolve().parent / "fixtures_carnet_structured.json").read_text(encoding="utf-8"))
        self.assertEqual(json.loads(json.dumps(gen.build())), want)
        self.assertGreaterEqual(len(want["payload"]), 70)
        self.assertTrue(any(c["out"] is None for c in want["payload"]) and any(c["out"] is not None for c in want["payload"]))


class MalformedStoredStateTests(StructBase):
    def test_malformed_persisted_structured_bytes_fail_closed_and_are_never_rewritten(self):
        good = {"id": "block-t1", **table([["a"]])}
        mutations = {
            "ragged": lambda b: b["table"]["rows"].append(["a", "b"]),
            "extra key": lambda b: b["table"].update(cols=1),
            "header int": lambda b: b["table"].update(header=1),
            "cell int": lambda b: b["table"]["rows"][0].__setitem__(0, 5),
            "text not empty": lambda b: b.update(text="x"),
            "extra block key": lambda b: b.update(foo=1),
            "missing payload": lambda b: b.pop("table"),
            "20+ rows": lambda b: b["table"].update(rows=[["a"]] * 21),
        }
        for name, mut in mutations.items():
            with self.subTest(name):
                state = _fixture()
                block = copy.deepcopy(good)
                mut(block)
                state["pages"][1]["content"] = {"version": 2, "blocks": [block]}
                self.seed(state)
                raw = self.path.read_bytes()
                with self.assertRaises(hq_carnet.CarnetStorageError):
                    hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 4})
                with self.assertRaises(hq_carnet.CarnetStorageError):
                    hq_carnet.get_notebook()
                self.assertEqual(self.path.read_bytes(), raw)

    def test_non_canonical_group_in_storage_fails_closed(self):
        for name, mut in {
            "one child": lambda b: b["group"]["items"].pop(),
            "duplicate child": lambda b: b["group"]["items"].__setitem__(1, dict(b["group"]["items"][0])),
            "width key": lambda b: b["group"]["items"][0].update(width=60),
            "layout": lambda b: b["group"].update(layout="grid"),
        }.items():
            with self.subTest(name):
                state = _fixture()
                block = {"id": "block-g1", **group("two", self.a1, self.a2)}
                mut(block)
                state["pages"][1]["content"] = {"version": 2, "blocks": [block]}
                self.seed(state)
                raw = self.path.read_bytes()
                with self.assertRaises(hq_carnet.CarnetStorageError):
                    hq_carnet.get_notebook()
                self.assertEqual(self.path.read_bytes(), raw)

    def test_phase1_pages_are_byte_identical_when_viewed_and_never_migrated(self):
        self.seed(_fixture())
        raw = self.path.read_bytes()
        hq_carnet.get_notebook()
        hq_carnet.get_notebook(meta=True)
        self.assertEqual(self.path.read_bytes(), raw)


class ExportTests(StructBase):
    def setUp(self):
        super().setUp()
        self.page = self.save(
            para("Rapport"), table([["Nom", "Val|x"], ["a", "1"]]), table([["A", "B"], ["C", "D"]], header=False),
            callout("warning", "Chaud", "ligne1\n\nligne2"), callout("note", "", "seul"), toggle("Détails", "un\ndeux"),
            group("compare", self.a1, self.a2, captions=["avant", ""]), group("three", self.a1, self.a2, self.a3),
        )

    def export(self, fmt, **kw):
        return hq_carnet.export_copy({"action": "page_export", "id": self.page["id"], "expected_rev": self.page["rev"], "format": fmt, "dir": "Inbox", **kw})

    def test_txt_is_readable_rows_and_labels(self):
        out = self.export("txt", filename="n")
        txt = (self.tmp / "Inbox" / "n.txt").read_text(encoding="utf-8")
        self.assertEqual(txt, "\n".join([
            "Rapport", "[Tableau]", "Nom | Val|x", "a | 1", "[Tableau]", "A | B", "C | D", "[Attention] Chaud", "ligne1", "", "ligne2", "[Note]", "seul",
            "[Section] Détails", "un", "deux", "[Avant : avant]", "[Après]", "[Image]", "[Image]", "[Image]",
        ]) + "\n")
        self.assertNotIn(str(self.tmp), txt)
        self.assertEqual(out["format"], "txt")

    def test_markdown_tables_callouts_toggles_groups(self):
        out = self.export("md", filename="n")
        md = (self.tmp / "Inbox" / "n.md").read_text(encoding="utf-8")
        self.assertIn("| Nom | Val\\|x |\n|---|---|\n| a | 1 |", md)
        self.assertIn("|  |  |\n|---|---|\n| A | B |\n| C | D |", md, "headerless table: synthetic EMPTY header, row 0 stays data")
        self.assertIn("> **Attention** — Chaud\n>\n> ligne1\n>\n> ligne2", md)
        self.assertIn("> **Note**\n>\n> seul", md)
        self.assertIn("**Détails**\n\nun\n\ndeux", md, "a toggle exports its FULL content")
        self.assertIn("**Avant**\n\n![avant](n.assets/figure-01.png)\n\n*avant*\n\n**Après**\n\n![](n.assets/figure-02.jpg)", md)
        self.assertEqual(out["assets"], 3)
        pkg = self.tmp / "Inbox" / "n.assets"
        self.assertEqual(sorted(os.listdir(pkg)), ["figure-01.png", "figure-02.jpg", "figure-03.webp"])
        self.assertNotRegex(md, r"\]\((/|[A-Za-z]:|\\|file:)")
        self.assertNotIn(str(self.tmp), md)
        self.assertNotIn(".hq-carnet", md)
        self.assertEqual((pkg / "figure-01.png").read_bytes(), F.png(10, 8), "no duplicate binary: one packaged copy per asset")

    def test_markdown_without_asset_paths_uses_text_placeholders(self):
        md = rich.render_markdown(self.page["content"], None)
        self.assertIn("*\\[Avant : avant\\]*", md)
        self.assertNotIn("![", md)

    def test_html_in_structured_text_is_escaped_not_interpreted(self):
        page = self.save(para("t"), table([["<script>x</script>", "*b*"]]), callout("info", "<b>", "[l](http://x)"), toggle("<i>", "`c`"), page=self.page)
        md = rich.render_markdown(page["content"], None)
        self.assertNotIn("<script>", md)
        self.assertIn("\\<script\\>", md)
        self.assertIn("\\*b\\*", md)
        self.assertIn("\\[l\\]", md)


class ReportTests(StructBase):
    def test_note_report_renders_new_blocks_and_packages_group_assets(self):
        page = self.save(para("Note"), table([["A"], ["1"]]), callout("info", "T", "B"), toggle("S", "x"), group("two", self.a1, self.a2))
        out = report.build({"action": "report_build", "title": "R", "items": [{"kind": "note", "page_id": page["id"], "rev": page["rev"]}], "include_sources": False}) if hasattr(report, "build") else None
        if out is None:
            self.skipTest("report API differs")
        md = out["markdown"]
        self.assertIn("| A |", md)
        self.assertIn("> **Info** — T", md)
        self.assertEqual(sorted(a["id"] for a in out["assets"]), sorted([self.a1["id"], self.a2["id"]]))
        self.assertNotIn(str(self.tmp), md)

    def test_photo_item_may_be_an_image_group_and_other_blocks_are_still_refused(self):
        page = self.save(para("Note"), table([["A"]]), group("compare", self.a1, self.a2))
        gid = page["content"]["blocks"][2]["id"]
        tid = page["content"]["blocks"][1]["id"]
        ok = report.build({"action": "report_build", "title": "R", "items": [{"kind": "photo", "page_id": page["id"], "rev": page["rev"], "block_id": gid}], "include_sources": False})
        self.assertEqual(len(ok["assets"]), 2)
        with self.assertRaises(hq_carnet.CarnetNotFound):
            report.build({"action": "report_build", "title": "R", "items": [{"kind": "photo", "page_id": page["id"], "rev": page["rev"], "block_id": tid}], "include_sources": False})


class HistoryBulkTests(Stage08Base):
    def setUp(self):
        super().setUp()
        saved = dict(media._cb)
        self.addCleanup(lambda: (media._cb.clear(), media._cb.update(saved)))
        hq_carnet.bind(root=self.tmp, now=lambda: self.clock[0], folders=lambda: ["Inbox", "Uni", "Print"],
                       system_names=iphone_bridge.SYSTEM_NAMES, safe_leaf_name=iphone_bridge.safe_leaf_name)
        self.a1, self.a2 = upload(F.png(10, 8)), upload(F.jpeg(16, 12))

    def blocks(self):
        return [para("avant avec alpha"), table([["A", "B"], ["alpha", "2"]]), callout("warning", "alpha", "alpha"), toggle("alpha", "alpha"), group("compare", self.a1, self.a2, captions=["alpha", ""])]

    def test_checkpoint_and_restore_return_every_structured_block_exactly(self):
        page = self.make_page(self.blocks())
        want = copy.deepcopy(page["content"]["blocks"])
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})[1]["event_id"]
        edited = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [para("autre")]}})["page"]
        status, out = hq_carnet.http_post({"action": "history_restore", "page_id": page["id"], "event_id": cp, "expected_rev": edited["rev"], "confirm": True})
        self.assertEqual(status, 200, out)
        strip = lambda bs: [{k: v for k, v in b.items() if k != "id"} for b in bs]  # restore re-ids blocks, as for every other block type
        self.assertEqual(strip(self.cur(page["id"])["content"]["blocks"]), strip(want))

    def test_bulk_replace_never_touches_structured_fields(self):
        page = self.make_page(self.blocks())
        before = copy.deepcopy(page["content"]["blocks"][1:])
        pv = self.preview("replace", {"find": "alpha", "replace": "OMEGA"}, [page["id"]])
        out = self.apply("replace", pv["params"], [{"id": page["id"], "rev": page["rev"]}], expected=1)
        self.assertEqual(out["outcome"], "complete", out)
        blocks = self.cur(page["id"])["content"]["blocks"]
        self.assertEqual(blocks[0]["text"], "avant avec OMEGA")
        self.assertEqual(blocks[1:], before, "table / callout / toggle / group payloads are untouched")
        undo = self.undo(out["event_id"])
        self.assertTrue(undo.get("ok"), undo)
        self.assertEqual(self.cur(page["id"])["content"]["blocks"][1:], before)

    def test_history_asset_closure_sees_group_children(self):
        page = self.make_page(self.blocks())
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})
        data = json.loads(self.history_path.read_text(encoding="utf-8"))
        self.assertEqual(history.referenced_assets(data), {self.a1["id"], self.a2["id"]})


class BackupRecoveryTests(_retention.RetentionBase):
    def setUp(self):
        super().setUp()
        saved, saved_ready = dict(hq_carnet._cb), hq_carnet._ready
        saved_media = dict(media._cb)

        def restore():
            hq_carnet._cb.clear()
            hq_carnet._cb.update(saved)
            hq_carnet._ready = saved_ready
            media._cb.clear()
            media._cb.update(saved_media)

        self.addCleanup(restore)
        hq_carnet.bind(root=self.root, now=lambda: 1790690000.0, folders=lambda: ["Inbox", "Uni", "Print"],
                       system_names=iphone_bridge.SYSTEM_NAMES, safe_leaf_name=iphone_bridge.safe_leaf_name)
        self.adir = self.root / ".hq-carnet" / "assets"

    def page_with(self, *blocks):
        nb = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})["page"]
        return hq_carnet.mutate({"action": "page_save", "id": nb["id"], "expected_rev": nb["rev"], "content": v2(*blocks)})["page"]

    def backup(self):
        info = cc_ext.run_backup(force=True)
        return info, Path(info["path"]) / "Carnet"

    def test_backup_includes_every_group_child_and_nothing_else(self):
        a1, a2, a3, orphan = upload(F.png(9, 9)), upload(F.jpeg(10, 10)), upload(F.webp_vp8l()), upload(F.png(7, 7))
        self.page_with(para("t"), table([["x"]]), group("three", a1, a2, a3))
        info, dest = self.backup()
        self.assertTrue(info["carnet"]["valid"])
        got = sorted(os.listdir(dest / "assets"))
        self.assertEqual(got, sorted(f for f in os.listdir(self.adir) if f.split(".")[0] in {a1["id"], a2["id"], a3["id"]}))
        self.assertFalse(any(orphan["id"] in n for n in got), "an unreferenced asset is not backed up")

    def test_history_only_group_children_stay_in_the_backup(self):
        a1, a2 = upload(F.png(9, 9)), upload(F.jpeg(10, 10))
        page = self.page_with(para("t"), group("two", a1, a2))
        status, cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})
        self.assertEqual(status, 200, cp)
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": v2(para("plus de groupe"))})
        self.assertEqual(hq_carnet.referenced_assets(json.loads((self.root / ".hq-carnet" / "notebook.json").read_text(encoding="utf-8"))), set())
        info, dest = self.backup()
        names = os.listdir(dest / "assets")
        self.assertTrue(any(n.startswith(a1["id"]) for n in names) and any(n.startswith(a2["id"]) for n in names), "closure keeps what a restore could bring back")

    def test_clean_root_recovery_from_the_backup(self):
        a1, a2 = upload(F.png(9, 9)), upload(F.jpeg(10, 10))
        page = self.page_with(para("Titre"), table([["A", "B"], ["1", "2"]]), callout("info", "t", "b"), toggle("s", "x"), group("compare", a1, a2, captions=["avant", "après"]))
        want = copy.deepcopy(page["content"])
        _info, dest = self.backup()
        fresh = self.tmp / "Recovered"
        (fresh / ".hq-carnet").mkdir(parents=True)
        (fresh / "Inbox").mkdir()
        shutil.copy2(dest / "notebook.json", fresh / ".hq-carnet" / "notebook.json")
        shutil.copytree(dest / "assets", fresh / ".hq-carnet" / "assets")
        hq_carnet.bind(root=fresh, now=lambda: 1790690000.0, folders=lambda: ["Inbox", "Uni", "Print"],
                       system_names=iphone_bridge.SYSTEM_NAMES, safe_leaf_name=iphone_bridge.safe_leaf_name)
        got = hq_carnet.get_notebook()["pages"]
        recovered = next(p for p in got if p["id"] == page["id"])
        self.assertEqual(recovered["content"], want)
        for a in rich.assets_of(recovered["content"]):
            media.verify_asset(a)  # the real files are present and match their metadata


if __name__ == "__main__":
    unittest.main()
