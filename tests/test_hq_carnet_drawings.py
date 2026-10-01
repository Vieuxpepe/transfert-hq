"""Carnet Product Phase 3 — native Dessiner integration (server side).

Ownership: Dessiner owns the drawing (immutable stems, ``meta.parent`` lineage, optional fixed underlay); Carnet stores only
``{"drawing": {"id": <stem>}}``. Throwaway ROOTs only. Browser behaviour: tests/visual_carnet_dessiner_playwright.mjs.
"""

from __future__ import annotations

import copy
import io
import json
import os
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import carnet_media_fixtures as F  # noqa: E402
import cc_ext  # noqa: E402
import hq_carnet  # noqa: E402
import hq_carnet_links as links  # noqa: E402
import hq_carnet_media as media  # noqa: E402
import hq_carnet_report as report  # noqa: E402
import hq_carnet_rich as rich  # noqa: E402
import hq_drawings as D  # noqa: E402
import iphone_bridge  # noqa: E402
from test_hq_carnet_media import MediaBase, para, upload  # noqa: E402
from test_hq_carnet_structured import StructBase, v2  # noqa: E402
from test_hq_drawings import make_png, png_url  # noqa: E402

try:
    import test_backup_retention as _retention
except ImportError:  # pragma: no cover
    from tests import test_backup_retention as _retention


def drawing(stem, **extra):
    return {"type": "drawing", "text": "", "marks": [], "drawing": {"id": stem}, **extra}


def doc3(underlay=None):
    doc = {
        "format": "transfert-hq-sketch", "version": 3, "units": "mm", "mode": "quick",
        "grid": {"spacing": 10, "visible": True, "snap": True}, "snap": {"angle": True, "angleStep": 15}, "nextId": 5,
        "points": [{"id": "p1", "x": 0, "y": 0}, {"id": "p2", "x": 20, "y": 0}],
        "objects": [{"id": "l1", "type": "line", "p1": "p1", "p2": "p2"}],
    }
    if underlay is not None:
        doc["underlay"] = underlay
    return doc


def save(root, name="plan", *, base=None, underlay=None, exists=None, source="desktop"):
    payload = {"name": name, "source": source, "doc": doc3(underlay), "png": png_url()}
    if base is not None:
        payload["base"] = base
    return D.save_drawing(Path(root), payload, asset_exists=exists)


class DrawBase(StructBase):
    def save_drawing(self, *args, **kw):
        kw.setdefault("exists", media.asset_exists)
        return save(self.tmp, *args, **kw)


# ---------------------------------------------------------------- Dessiner: lineage + underlay


class DessinerServerTests(DrawBase):
    def test_base_records_lineage_only_and_never_overwrites(self):
        first = self.save_drawing("plan")
        files_before = {p.name: p.read_bytes() for p in (self.tmp / "Inbox" / "Drawings").iterdir()}
        second = self.save_drawing("plan", base=first["stem"])
        self.assertNotEqual(first["stem"], second["stem"], "a save is always a NEW immutable stem")
        self.assertEqual(second["parent"], first["stem"])
        self.assertNotIn("parent", first)
        for name, data in files_before.items():
            self.assertEqual((self.tmp / "Inbox" / "Drawings" / name).read_bytes(), data, "the parent files are untouched")
        self.assertEqual(D.open_drawing(self.tmp, second["stem"])["doc"]["meta"]["parent"], first["stem"])
        self.assertNotIn("parent", D.open_drawing(self.tmp, first["stem"])["doc"]["meta"])

    def test_base_must_be_a_canonical_existing_stem(self):
        for bad in ("../x", "a/b", "", "x" * 130, "con ", 5, ["a"], {"a": 1}, "nope_HQWeb-Desktop"):
            with self.subTest(base=bad):
                before = sorted(os.listdir(self.tmp / "Inbox" / "Drawings")) if (self.tmp / "Inbox" / "Drawings").is_dir() else []
                if bad == "":
                    continue  # an empty base means "no lineage"
                with self.assertRaises(D.DrawingError):
                    self.save_drawing("plan", base=bad)
                after = sorted(os.listdir(self.tmp / "Inbox" / "Drawings")) if (self.tmp / "Inbox" / "Drawings").is_dir() else []
                self.assertEqual(before, after, "a refused save publishes nothing")

    def test_underlay_schema_is_exact(self):
        a = upload(F.png(12, 9))
        ok = {"asset_id": a["id"], "fit": "contain"}
        got = self.save_drawing("note", underlay=ok)
        self.assertEqual(D.open_drawing(self.tmp, got["stem"])["doc"]["underlay"], ok)
        bad = [
            {"asset_id": a["id"]}, {"asset_id": a["id"], "fit": "cover"}, {"asset_id": a["id"], "fit": "contain", "x": 1},
            {"asset_id": a["id"], "fit": "contain", "scale": 2}, {"asset_id": "../../etc/passwd", "fit": "contain"},
            {"asset_id": "asset-xyz", "fit": "contain"}, {"asset_id": 5, "fit": "contain"}, "asset", [], {"asset_id": a["id"].upper(), "fit": "contain"},
        ]
        for u in bad:
            with self.subTest(u=u):
                with self.assertRaises(D.DrawingError):
                    self.save_drawing("note", underlay=u)

    def test_underlay_asset_must_exist_and_old_versions_cannot_carry_one(self):
        missing = {"asset_id": "asset-" + "0" * 24, "fit": "contain"}
        with self.assertRaises(D.DrawingError) as cm:
            self.save_drawing("note", underlay=missing)
        self.assertEqual(cm.exception.status, 409)
        a = upload(F.png(8, 8))
        with self.assertRaises(D.DrawingError):
            save(self.tmp, "note", underlay={"asset_id": a["id"], "fit": "contain"})  # no asset checker supplied: never trusted
        doc = doc3({"asset_id": a["id"], "fit": "contain"})
        doc["version"] = 2
        with self.assertRaises(D.DrawingError):
            D.validate_document(doc)

    def test_underlay_placement_contract_is_fixed(self):
        self.assertEqual((D.UNDERLAY_FITS, D.UNDERLAY_BOX_MM), (("contain",), 1000.0))
        self.assertEqual(D.underlay_rect("mm", 400, 200), {"x0": -500.0, "y0": -250.0, "x1": 500.0, "y1": 250.0})
        self.assertEqual(D.underlay_rect("m", 100, 400), {"x0": -0.125, "y0": -0.5, "x1": 0.125, "y1": 0.5})
        self.assertEqual(D.underlay_rect("cm", 50, 50), {"x0": -50.0, "y0": -50.0, "x1": 50.0, "y1": 50.0})
        for bad in (("km", 1, 1), ("mm", 0, 5), ("mm", 5, -1), ("mm", 1.5, 2), ("mm", True, 2)):
            with self.assertRaises(D.DrawingError):
                D.underlay_rect(*bad)


# ---------------------------------------------------------------- Carnet block schema


class DrawingBlockSchemaTests(DrawBase):
    def test_round_trip_keeps_exactly_the_reference(self):
        d = self.save_drawing("plan")
        page = self.save(para("Titre"), drawing(d["stem"]))
        block = page["content"]["blocks"][1]
        self.assertEqual({k: v for k, v in block.items() if k != "id"}, {"type": "drawing", "text": "", "marks": [], "drawing": {"id": d["stem"]}})
        self.assertTrue(rich.valid_v2(page["content"]))
        self.assertEqual(hq_carnet.get_notebook()["pages"][-1]["content"], page["content"])

    def test_a_missing_drawing_may_still_be_referenced_and_is_preserved(self):
        page = self.save(para("t"), drawing("fantome_HQWeb-Desktop"))
        self.assertEqual(page["content"]["blocks"][1]["drawing"], {"id": "fantome_HQWeb-Desktop"})

    def test_rejections(self):
        bad = {
            "extra key": {"id": "a", "name": "x"}, "no id": {}, "path": {"id": "../a"}, "slash": {"id": "a/b"}, "abs": {"id": "/etc/passwd"},
            "windows": {"id": "C:\\x"}, "dot": {"id": ".hidden"}, "long": {"id": "a" * 121}, "int": {"id": 5}, "none": {"id": None},
            "url": {"id": "http://evil/x"}, "svg": {"id": "<svg>"}, "list": [], "str": "plan", "space": {"id": "a b"}, "nl": {"id": "a\nb"},
        }
        for name, payload in bad.items():
            with self.subTest(name):
                self.refuse({"type": "drawing", "text": "", "marks": [], "drawing": payload})
        self.refuse(drawing("a", checked=False))
        self.refuse({**drawing("a"), "text": "x"})
        self.refuse({**drawing("a"), "marks": [{"type": "bold", "start": 0, "end": 0}]})
        self.refuse({"type": "drawing", "text": "", "marks": [], "table": {"header": True, "rows": [["a"]]}})
        self.refuse({"type": "drawing", "text": "", "marks": []})
        self.refuse({"type": "paragraph", "text": "x", "marks": [], "drawing": {"id": "a"}})
        self.refuse({**drawing("a"), "svg": "<svg/>"})
        self.refuse({**drawing("a"), "asset": {"id": "asset-" + "0" * 24}})

    def test_per_page_cap_is_inclusive(self):
        self.save(*[drawing(f"d{i}") for i in range(rich.DRAWINGS_PER_PAGE_MAX)])
        self.refuse(*[drawing(f"d{i}") for i in range(rich.DRAWINGS_PER_PAGE_MAX + 1)], msg="croquis")

    def test_drawing_is_an_atom_never_a_title_or_preview_or_search_text(self):
        page = self.save(drawing("secret_HQWeb-Desktop"), para("Vrai titre"))
        self.assertEqual(hq_carnet.derive_title(rich.flat_text(page["content"])), "Vrai titre")
        self.assertNotIn("secret", rich.search_text(page["content"]))
        self.assertEqual(rich.structured_strings(page["content"]["blocks"][0]), [])

    def test_malformed_stored_drawing_fails_closed_and_is_never_rewritten(self):
        page = self.save(para("t"), drawing("plan_HQWeb-Desktop"))
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        raw["pages"][-1]["content"]["blocks"][1]["drawing"]["id"] = "../../x"
        self.path.write_text(json.dumps(raw), encoding="utf-8")
        before = self.path.read_bytes()
        with self.assertRaises((hq_carnet.CarnetError, hq_carnet.CarnetStorageError)):
            hq_carnet.get_notebook()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertTrue(page)


# ---------------------------------------------------------------- export / report / links / deletion


class ExportReportTests(DrawBase):
    def setUp(self):
        super().setUp()
        self.d = self.save_drawing("Plan-A")
        self.page = self.save(para("Rapport"), drawing(self.d["stem"]), para("fin"))

    def export(self, fmt, **kw):
        return hq_carnet.export_copy({"action": "page_export", "id": self.page["id"], "expected_rev": self.page["rev"], "format": fmt, "dir": "Inbox", **kw})

    def test_txt_and_markdown_are_readable_and_leak_nothing(self):
        self.export("txt", filename="n")
        self.export("md", filename="n")
        txt = (self.tmp / "Inbox" / "n.txt").read_text(encoding="utf-8")
        md = (self.tmp / "Inbox" / "n.md").read_text(encoding="utf-8")
        self.assertEqual(txt, "Rapport\n[Croquis : Plan-A]\nfin\n")
        self.assertIn("*\\[Croquis : Plan-A\\]*", md)
        for text in (txt, md):
            self.assertNotIn(str(self.tmp), text)
            self.assertNotIn("Drawings", text)
            self.assertNotIn("_HQWeb", text)
            self.assertNotIn(".png", text)
        self.assertFalse((self.tmp / "Inbox" / "n.assets").exists(), "no preview asset is packaged: Dessiner owns the drawing")

    def test_a_missing_drawing_exports_the_same_placeholder(self):
        for p in (self.tmp / "Inbox" / "Drawings").iterdir():
            p.unlink()
        self.export("txt", filename="m")
        self.assertIn("[Croquis : Plan-A]", (self.tmp / "Inbox" / "m.txt").read_text(encoding="utf-8"))

    def _build(self, items):
        return report.build({"action": "report_build", "title": "R", "items": items, "include_sources": False})

    def test_report_has_a_distinct_drawing_kind_and_never_calls_it_a_photo(self):
        bid = self.page["content"]["blocks"][1]["id"]
        out = self._build([{"kind": "drawing", "page_id": self.page["id"], "rev": self.page["rev"], "block_id": bid}])
        self.assertIn("## Croquis — Rapport", out["markdown"])
        self.assertIn("Croquis : Plan", out["markdown"])
        self.assertEqual(out["sections"][0]["kind"], "drawing")
        self.assertEqual(out["assets"], [])
        self.assertNotIn(str(self.tmp), out["markdown"])
        with self.assertRaises(hq_carnet.CarnetNotFound):
            self._build([{"kind": "photo", "page_id": self.page["id"], "rev": self.page["rev"], "block_id": bid}])
        para_id = self.page["content"]["blocks"][0]["id"]
        with self.assertRaises(hq_carnet.CarnetNotFound):
            self._build([{"kind": "drawing", "page_id": self.page["id"], "rev": self.page["rev"], "block_id": para_id}])

    def test_note_report_renders_the_drawing_block(self):
        out = self._build([{"kind": "note", "page_id": self.page["id"], "rev": self.page["rev"]}])
        self.assertIn("Croquis : Plan", out["markdown"])


class LinksAndDeletionTests(DrawBase):
    def test_backlinks_count_drawing_blocks_and_mark_missing_targets(self):
        d = self.save_drawing("Plan")
        page = self.save(para("a"), drawing(d["stem"]), drawing(d["stem"]))
        got = links.backlinks("drawing", d["stem"])
        self.assertEqual([(r["page_id"], r["count"]) for r in got["items"]], [(page["id"], 2)])
        self.assertTrue(got["target_exists"])
        for p in (self.tmp / "Inbox" / "Drawings").iterdir():
            p.unlink()
        gone = links.backlinks("drawing", d["stem"])
        self.assertFalse(gone["target_exists"], "an unresolvable drawing is reported, never hidden")
        self.assertEqual(gone["total"], 1, "the Carnet reference is preserved")

    def test_removing_the_block_never_deletes_the_drawing(self):
        d = self.save_drawing("Plan")
        page = self.save(para("a"), drawing(d["stem"]))
        files = sorted(os.listdir(self.tmp / "Inbox" / "Drawings"))
        self.save(para("a"))
        trash = hq_carnet.mutate({"action": "page_trash", "id": page["id"], "expected_rev": hq_carnet.get_notebook()["pages"][-1]["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        self.assertTrue(trash)
        self.assertEqual(sorted(os.listdir(self.tmp / "Inbox" / "Drawings")), files)
        self.assertEqual(D.open_drawing(self.tmp, d["stem"])["stem"], d["stem"])



class HistoryRestoreTests(DrawBase):
    def test_restore_brings_back_only_the_reference_and_never_touches_the_drawing(self):
        d = self.save_drawing("Plan")
        page = self.save(para("v1"), drawing(d["stem"]))
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})[1]["event_id"]
        page = self.save(para("v2"))
        files = {p.name: p.read_bytes() for p in (self.tmp / "Inbox" / "Drawings").iterdir()}
        status, out = hq_carnet.http_post({"action": "history_restore", "page_id": page["id"], "event_id": cp, "expected_rev": page["rev"], "confirm": True})
        self.assertEqual(status, 200, out)
        back = next(p for p in hq_carnet.get_notebook()["pages"] if p["id"] == page["id"])
        self.assertEqual([b["drawing"] for b in back["content"]["blocks"] if b["type"] == "drawing"], [{"id": d["stem"]}])
        self.assertEqual({p.name: p.read_bytes() for p in (self.tmp / "Inbox" / "Drawings").iterdir()}, files, "Dessiner's files are byte-identical: no duplicate, no rollback")
        stored = json.dumps(json.loads(self.path.read_text(encoding="utf-8")))
        self.assertNotIn("hqdraw", stored)
        self.assertNotIn(str(self.tmp), stored)


# ---------------------------------------------------------------- backup closure (one hop) + recovery


class BackupClosureTests(_retention.RetentionBase):
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

    def annotation(self, asset, name="Annot"):
        return save(self.root, name, underlay={"asset_id": asset["id"], "fit": "contain"}, exists=media.asset_exists)

    def names(self, dest):
        return sorted(os.listdir(dest / "assets")) if (dest / "assets").is_dir() else []

    def has(self, dest, asset):
        return any(n.startswith(asset["id"]) for n in self.names(dest))

    def image_block(self, asset):
        return {"type": "image", "text": "", "marks": [], "asset": {"id": asset["id"], "mime": asset["mime"], "w": asset["w"], "h": asset["h"], "width": 60, "layout": "inline", "caption": ""}}

    def test_image_plus_annotation_backs_up_the_underlay(self):
        a = upload(F.png(9, 7))
        d = self.annotation(a)
        self.page_with(para("t"), self.image_block(a), drawing(d["stem"]))
        info, dest = self.backup()
        self.assertTrue(info["carnet"]["valid"])
        self.assertTrue(self.has(dest, a))
        self.assertEqual(info["carnet"]["drawings"], {"referenced": 1, "missing": 0, "invalid": 0, "underlays": 1})
        self.assertTrue((Path(info["path"]) / "Inbox" / "Drawings" / (d["stem"] + ".hqdraw.json")).is_file(), "Dessiner's own files travel with the legacy Inbox backup")

    def test_original_image_block_removed_but_drawing_remains_keeps_the_underlay(self):
        a = upload(F.png(9, 7))
        d = self.annotation(a)
        self.page_with(para("t"), drawing(d["stem"]))
        _info, dest = self.backup()
        self.assertTrue(self.has(dest, a), "the transitive edge page -> drawing -> asset keeps it")

    def test_drawing_block_removed_too_drops_the_underlay(self):
        a = upload(F.png(9, 7))
        d = self.annotation(a)
        self.page_with(para("t"))
        self.assertTrue(d)
        info, dest = self.backup()
        self.assertFalse(self.has(dest, a))
        self.assertNotIn("drawings", info["carnet"])

    def test_history_only_drawing_reference_still_keeps_its_underlay(self):
        a = upload(F.png(9, 7))
        d = self.annotation(a)
        page = self.page_with(para("t"), drawing(d["stem"]))
        status, cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})
        self.assertEqual(status, 200, cp)
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": v2(para("sans croquis"))})
        _info, dest = self.backup()
        self.assertTrue(self.has(dest, a))

    def test_inline_drawing_link_also_keeps_the_underlay(self):
        a = upload(F.png(9, 7))
        d = self.annotation(a)
        link = {"type": "paragraph", "text": "voir", "marks": [{"type": "link", "start": 0, "end": 4, "ref": {"kind": "drawing", "id": d["stem"]}}]}
        self.page_with(link)
        _info, dest = self.backup()
        self.assertTrue(self.has(dest, a))

    def test_malformed_drawing_fails_closed_without_escaping_the_root(self):
        a = upload(F.png(9, 7))
        d = self.annotation(a)
        self.page_with(drawing(d["stem"]))
        doc = self.root / "Inbox" / "Drawings" / (d["stem"] + ".hqdraw.json")
        data = json.loads(doc.read_text(encoding="utf-8"))
        data["underlay"] = {"asset_id": "../../../etc/passwd", "fit": "contain"}
        doc.write_text(json.dumps(data), encoding="utf-8")
        info, dest = self.backup()
        self.assertFalse(info["carnet"]["valid"], "an unreadable drawing blocks retention")
        self.assertEqual(info["carnet"]["drawings"]["invalid"], 1)
        self.assertFalse(self.has(dest, a))
        self.assertFalse(any(".." in n or "passwd" in n for n in self.names(dest)))

    def test_missing_drawing_does_not_crash_the_backup(self):
        self.page_with(drawing("fantome_HQWeb-Desktop"))
        info, _dest = self.backup()
        self.assertTrue(info["carnet"]["valid"])
        self.assertEqual(info["carnet"]["drawings"], {"referenced": 1, "missing": 1, "invalid": 0, "underlays": 0})

    def test_clean_root_recovery_resolves_the_annotation_and_its_preview(self):
        a = upload(F.png(9, 7))
        d = self.annotation(a)
        page = self.page_with(para("Titre"), self.image_block(a), drawing(d["stem"]))
        want = copy.deepcopy(page["content"])
        info, dest = self.backup()
        fresh = self.tmp / "Recovered"
        (fresh / ".hq-carnet").mkdir(parents=True)
        shutil.copytree(Path(info["path"]) / "Inbox", fresh / "Inbox")
        shutil.copy2(dest / "notebook.json", fresh / ".hq-carnet" / "notebook.json")
        shutil.copytree(dest / "assets", fresh / ".hq-carnet" / "assets")
        hq_carnet.bind(root=fresh, now=lambda: 1790690000.0, folders=lambda: ["Inbox", "Uni", "Print"],
                       system_names=iphone_bridge.SYSTEM_NAMES, safe_leaf_name=iphone_bridge.safe_leaf_name)
        got = next(p for p in hq_carnet.get_notebook()["pages"] if p["id"] == page["id"])
        self.assertEqual(got["content"], want)
        body, ctype, _name = D.read_file(fresh, d["stem"], "png")
        self.assertEqual((ctype, body[:8]), ("image/png", D.PNG_SIG), "the preview resolves after recovery")
        under = D.open_drawing(fresh, d["stem"])["doc"]["underlay"]
        media.verify_asset(rich.assets_of(got["content"])[0])
        self.assertTrue(media.asset_exists(under["asset_id"]), "the underlay asset is present after recovery")
        self.assertTrue(links.backlinks("drawing", d["stem"])["target_exists"])


# ---------------------------------------------------------------- HTTP: lineage / underlay through the real handler


class HttpTests(unittest.TestCase):
    def test_the_bridge_passes_the_asset_checker(self):
        src = Path(iphone_bridge.__file__).read_text(encoding="utf-8")
        self.assertIn("save_drawing(ROOT, data, asset_exists=hq_carnet.media.asset_exists)", src)


if __name__ == "__main__":
    unittest.main()
