"""Carnet Stage 08 — backlinks ("Liée depuis…"), report assembly, backup integration, HTTP surface, concurrency, budgets.

Throwaway ROOTs only (run from a disposable source copy).
"""

from __future__ import annotations

import copy
import io
import json
import struct
import sys
import threading
import time
import unittest
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_history as history  # noqa: E402
import hq_carnet_links as links  # noqa: E402
import hq_carnet_media as media  # noqa: E402
import hq_carnet_sources as sources  # noqa: E402
import hq_carnet_report as report  # noqa: E402
import test_hq_carnet as _base  # noqa: E402
from test_hq_carnet_history import Stage08Base, bold, para  # noqa: E402

MEASURE = {"label": "a", "observed": {"v": "10.02", "u": "mm"}, "mode": "sym", "nominal": {"v": "10", "u": "mm"}, "tol": {"t": "0.02", "u": "mm"}, "at": 1790000000, "link": None}


def png(w=2, h=2) -> bytes:
    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x7f\x20\x20" * w for _ in range(h))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def image_block(asset, caption=""):
    return {"type": "image", "text": "", "marks": [], "asset": {"id": asset["id"], "mime": asset["mime"], "w": asset["w"], "h": asset["h"], "width": 60, "layout": "inline", "caption": caption}}


def link_mark(start, end, kind, ident):
    return {"type": "link", "start": start, "end": end, "ref": {"kind": kind, "id": ident}}


class BacklinkTests(Stage08Base):
    def test_note_links_citations_and_measure_links_are_derived(self):
        target = self.make_page([para("target")])
        fam = self.family()
        ed = self.edition(fam, "29e")
        a = self.make_page([para("see target here", [link_mark(4, 10, "note", target["id"])]), self.cite_block(ed)])
        b = self.make_page([para("x", [link_mark(0, 1, "note", target["id"]), ]), ])
        c = self.make_page([para("unrelated")])
        before = self.path.read_bytes()
        out = links.backlinks("note", target["id"])
        self.assertEqual(self.path.read_bytes(), before, "viewing never mutates")
        self.assertEqual(sorted(r["page_id"] for r in out["items"]), sorted([a["id"], b["id"]]))
        self.assertTrue(out["target_exists"])
        src = links.backlinks("source", ed["id"])
        self.assertEqual([r["page_id"] for r in src["items"]], [a["id"]])
        self.assertEqual(links.backlinks("note", c["id"])["items"], [])
        self.assertFalse(self.history_path.exists())

    def test_trashed_pages_are_listed_apart_and_missing_targets_are_explicit(self):
        target = self.make_page([para("target")])
        a = self.make_page([para("abc", [link_mark(0, 3, "note", target["id"])])])
        hq_carnet.mutate({"action": "page_trash", "id": a["id"], "expected_rev": a["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        out = links.backlinks("note", target["id"])
        self.assertEqual((out["total"], out["trashed_total"]), (0, 1))
        self.assertEqual(out["trashed"][0]["page_id"], a["id"])
        gone = links.backlinks("note", "page-" + "f" * 24)
        self.assertFalse(gone["target_exists"])

    def test_validation_and_no_absolute_paths(self):
        for kind, ident in (("nope", "x"), ("note", 5), ("file", "../x.pdf"), ("file", "C:/x.pdf"), ("source", "bad")):
            self.assertEqual(hq_carnet.http_get({"backlinks": [kind], "id": [str(ident)]})[0], 400, (kind, ident))
        self.assertEqual(hq_carnet.http_get({"backlinks": ["note"]})[0], 400)
        self.assertEqual(hq_carnet.http_get({"backlinks": ["note"], "id": ["a"], "history": ["1"]})[0], 400)
        (self.tmp / "Inbox" / "plan.pdf").write_bytes(b"%PDF-1.4\n")
        self.make_page([para("plan", [link_mark(0, 4, "file", "Inbox/plan.pdf")])])
        out = links.backlinks("file", "Inbox/plan.pdf")
        self.assertEqual(out["total"], 1)
        self.assertNotIn(str(self.tmp), json.dumps(out))

    def test_incremental_memo_extracts_only_changed_pages(self):
        target = self.make_page([para("t")])
        pages = [self.make_page([para("p%d" % i, [link_mark(0, 1, "note", target["id"])])]) for i in range(20)]
        links.backlinks("note", target["id"])
        first = links.stats["extracted"]
        self.assertGreaterEqual(first, 20)
        links.backlinks("note", target["id"])
        self.assertEqual(links.stats["extracted"], first, "an unchanged notebook re-extracts nothing")
        cur = self.cur(pages[0]["id"])
        hq_carnet.mutate({"action": "page_save", "id": pages[0]["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [{**cur["content"]["blocks"][0], "text": "changed"}]}})
        out = links.backlinks("note", target["id"])
        self.assertEqual(links.stats["extracted"], first + 1, "exactly the saved page")
        self.assertEqual(out["total"], 20)

    def test_save_never_triggers_backlink_work(self):
        page = self.make_page([para("a")])
        links.clear()
        for i in range(5):
            cur = self.cur(page["id"])
            hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [{**cur["content"]["blocks"][0], "text": "a" * (i + 2)}]}})
        self.assertEqual(links.stats, {"extracted": 0, "hits": 0}, "no O(all pages) work per keystroke/save")

    def test_backlinks_racing_a_page_save_is_consistent(self):
        target = self.make_page([para("t")])
        page = self.make_page([para("abc", [link_mark(0, 3, "note", target["id"])])])
        errors, stop = [], threading.Event()

        def saver():
            rev = page["rev"]
            for i in range(30):
                cur = self.cur(page["id"])
                try:
                    hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [{**cur["content"]["blocks"][0], "text": "abc" + "d" * (i % 5)}]}})
                except Exception as e:  # pragma: no cover
                    errors.append(e)
            stop.set()

        t = threading.Thread(target=saver)
        t.start()
        while not stop.is_set():
            out = links.backlinks("note", target["id"])
            self.assertEqual(out["total"], 1)
        t.join()
        self.assertEqual(errors, [])


    def test_target_existence_is_resolved_for_every_kind(self):
        fam = self.family()
        ed = self.edition(fam, "29e")
        proj = hq_carnet.mutate({"action": "project_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"], "name": "P"})["project"]
        note = self.make_page([para("n")])
        (self.tmp / "Inbox" / "plan.pdf").write_bytes(b"%PDF-1.4\n")
        (self.tmp / "Inbox" / "clip.mp4").write_bytes(b"x")
        (self.tmp / "Inbox" / "part.stl").write_bytes(b"x")
        (self.tmp / "Inbox" / "Drawings").mkdir()
        (self.tmp / "Inbox" / "Drawings" / "sketch1.hqdraw.json").write_text("{}")
        before = (self.path.read_bytes(), (self.tmp / ".hq-carnet" / "sources.json").read_bytes())
        present = [("note", note["id"]), ("project", proj["id"]), ("source", ed["id"]), ("file", "Inbox/plan.pdf"), ("media", "Inbox/clip.mp4"), ("model", "Inbox/part.stl"), ("drawing", "sketch1")]
        missing = [("note", "page-" + "9" * 24), ("project", "proj-" + "9" * 24), ("source", "srce-" + "9" * 24), ("file", "Inbox/gone.pdf"), ("media", "Inbox/gone.mp4"), ("model", "Inbox/gone.stl"), ("drawing", "nodraw")]
        for kind, ident in present:
            out = links.backlinks(kind, ident)
            self.assertIs(out["target_exists"], True, (kind, ident))
        for kind, ident in missing:
            out = links.backlinks(kind, ident)
            self.assertIs(out["target_exists"], False, (kind, ident))
            self.assertNotIn(str(self.tmp), json.dumps(out))
        self.assertEqual((self.path.read_bytes(), (self.tmp / ".hq-carnet" / "sources.json").read_bytes()), before, "read-only")

    def test_archived_and_unreadable_targets_are_explicit(self):
        fam = self.family()
        ed = self.edition(fam, "29e")
        sources.mutate({"action": "source_edition_archive", "id": ed["id"], "expected_rev": ed["rev"], "archived": True})
        out = links.backlinks("source", ed["id"])
        self.assertEqual((out["target_exists"], out["target_archived"]), (True, True))
        (self.tmp / ".hq-carnet" / "sources.json").write_bytes(b"{broken")
        out = links.backlinks("source", ed["id"])
        self.assertIsNone(out["target_exists"], "unknown is explicit, never a silent present/absent")
        self.assertEqual((self.tmp / ".hq-carnet" / "sources.json").read_bytes(), b"{broken")

    def test_a_linked_file_replaced_by_a_symlink_is_not_reported_present(self):
        (self.tmp / "Inbox" / "real.pdf").write_bytes(b"%PDF-1.4\n")
        try:
            (self.tmp / "Inbox" / "link.pdf").symlink_to(self.tmp / "Inbox" / "real.pdf")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        self.assertIs(links.backlinks("file", "Inbox/link.pdf")["target_exists"], False)

    def test_source_backlink_survives_a_missing_edition(self):
        fam = self.family()
        ed = self.edition(fam, "29e")
        page = self.make_page([self.cite_block(ed)])
        state = json.loads((self.tmp / ".hq-carnet" / "sources.json").read_text())
        state["editions"] = [e for e in state["editions"] if e["id"] != ed["id"]]
        (self.tmp / ".hq-carnet" / "sources.json").write_text(json.dumps(state))
        out = links.backlinks("source", ed["id"])
        self.assertIs(out["target_exists"], False)
        self.assertEqual([r["page_id"] for r in out["items"]], [page["id"]], "the citing note is still listed")

    def test_many_links_are_bounded(self):
        target = self.make_page([para("t")])
        text = "x" * 200
        marks = [link_mark(i, i + 1, "note", target["id"]) for i in range(0, 200, 2)]
        self.make_page([para(text, marks) for _ in range(5)])
        out = links.backlinks("note", target["id"])
        self.assertEqual(out["items"][0]["count"], 500)
        self.assertEqual(len(out["items"]), 1, "one row per page, however many links")


class ReportTests(Stage08Base):
    def test_exact_markdown_order_and_nothing_authored(self):
        fam = self.family()
        ed = self.edition(fam, "29e", publisher="Industrial Press")
        a = self.make_page([para("Titre A"), para("Intro line"), {"type": "measure", "text": "", "marks": [], "measure": copy.deepcopy(MEASURE)}, {"type": "decision", "text": "Go with plan B", "marks": [], "decision": {"at": 1790000000}}])
        b = self.make_page([self.cite_block(ed, before="Voir ", after="")])
        blocks_a = self.cur(a["id"])["content"]["blocks"]
        items = [
            {"kind": "note", "page_id": b["id"], "rev": self.cur(b["id"])["rev"]},
            {"kind": "decision", "page_id": a["id"], "rev": self.cur(a["id"])["rev"], "block_id": blocks_a[3]["id"]},
            {"kind": "measure", "page_id": a["id"], "rev": self.cur(a["id"])["rev"], "block_id": blocks_a[2]["id"]},
            {"kind": "source", "edition_id": ed["id"]},
        ]
        before_nb = self.path.read_bytes()
        out = report.build({"action": "report_build", "title": "Rapport banc", "items": items})
        self.assertEqual(self.path.read_bytes(), before_nb, "read-only wrt notebook content")
        md = out["markdown"]
        self.assertTrue(md.startswith("# Rapport banc\n"))
        positions = [md.index(s) for s in ("## Note —", "## Décision —", "## Mesure —", "## Source —", "## Sources citées")]
        self.assertEqual(positions, sorted(positions), "order is exactly the user's, appendix last")
        self.assertIn("Go with plan B", md)
        self.assertIn("Machinery 29e, p. 417", md)
        self.assertIn("Industrial Press", md)
        self.assertNotIn("Intro line", md, "unselected content is never included")
        self.assertEqual(md.count("## Sources citées"), 1)
        for forbidden in ("conclusion", "Conclusion", "Résumé", "résumé", "Recommandation"):
            self.assertNotIn(forbidden, md)
        self.assertNotIn(str(self.tmp), md)
        self.assertEqual(out["page_revs"][a["id"]], self.cur(a["id"])["rev"])

    def test_stale_page_is_409_and_nothing_is_generated(self):
        a = self.make_page([para("one")])
        item = {"kind": "note", "page_id": a["id"], "rev": a["rev"]}
        cur = self.cur(a["id"])
        hq_carnet.mutate({"action": "page_save", "id": a["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [{**cur["content"]["blocks"][0], "text": "two"}]}})
        status, out = hq_carnet.http_post({"action": "report_build", "items": [item]})
        self.assertEqual((status, out["code"]), (409, "report_stale"))
        self.assertEqual(out["stale"], [a["id"]])
        self.assertNotIn("markdown", out)

    def test_validation(self):
        a = self.make_page([para("one")])
        good = {"kind": "note", "page_id": a["id"], "rev": a["rev"]}
        for bad in ({"items": []}, {"items": [{**good, "extra": 1}]}, {"items": [{"kind": "x"}]}, {"items": [good], "title": "a\nb"}, {"items": [good], "title": "x" * 121},
                    {"items": [good], "include_sources": "yes"}, {"items": [good] * 201}, {"items": [{"kind": "measure", "page_id": a["id"], "rev": 1}]},
                    {"items": [good], "export": {"dir": "../x"}}, {"items": [good], "export": 5}):
            status, _ = hq_carnet.http_post({"action": "report_build", **bad})
            self.assertEqual(status, 400, bad)
        escaped = hq_carnet.http_post({"action": "report_build", "items": [good], "export": {"dir": "Print", "filename": "../../a.md"}})
        if escaped[0] == 200:
            self.assertNotIn("..", escaped[1]["path"])
            self.assertTrue((self.tmp / escaped[1]["path"]).resolve().is_relative_to((self.tmp / "Print").resolve()))
        self.assertEqual(hq_carnet.http_post({"action": "report_build", "items": [{**good, "page_id": "page-" + "e" * 24}]})[0], 404)
        self.assertEqual(hq_carnet.http_post({"action": "report_build", "items": [{"kind": "measure", "page_id": a["id"], "rev": a["rev"], "block_id": "block-" + "e" * 24}]})[0], 404)

    def test_trashed_page_is_refused(self):
        a = self.make_page([para("one")])
        hq_carnet.mutate({"action": "page_trash", "id": a["id"], "expected_rev": a["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        cur = self.cur(a["id"])
        self.assertEqual(hq_carnet.http_post({"action": "report_build", "items": [{"kind": "note", "page_id": a["id"], "rev": cur["rev"]}]})[0], 400)

    def test_images_captions_and_package_export_never_overwrite(self):
        asset = media.store_upload(io.BytesIO(png()).read, len(png()), None)["asset"]
        a = self.make_page([para("avant"), image_block(asset, "Vue du banc")])
        items = [{"kind": "note", "page_id": a["id"], "rev": a["rev"]}]
        inline = report.build({"items": items, "title": "Rapport"})
        self.assertIn("Vue du banc", inline["markdown"])
        self.assertIn("Rapport.assets/figure-01.png", inline["markdown"])
        self.assertEqual(len(inline["assets"]), 1)
        out = report.build({"items": items, "title": "Rapport", "export": {"dir": "Print"}})
        self.assertEqual(out["format"], "md")
        written = self.tmp / out["path"]
        self.assertTrue(written.is_file())
        self.assertTrue((self.tmp / out["assets_dir"]).is_dir())
        self.assertEqual(out["assets_count"], 1)
        text = written.read_text(encoding="utf-8")
        self.assertIn("figure-01.png", text)
        self.assertNotIn(str(self.tmp), text)
        with self.assertRaises(hq_carnet.CarnetConflict):
            report.build({"items": items, "title": "Rapport", "export": {"dir": "Print"}})
        other = report.build({"items": items, "title": "Rapport", "export": {"dir": "Print", "filename": "second"}})
        self.assertNotEqual(other["path"], out["path"])
        self.assertEqual(written.read_text(encoding="utf-8"), text)

    def test_report_while_pages_change_is_one_consistent_snapshot(self):
        a = self.make_page([para("one")])
        errors = []
        stop = threading.Event()

        def saver():
            for i in range(25):
                cur = self.cur(a["id"])
                try:
                    hq_carnet.mutate({"action": "page_save", "id": a["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [{**cur["content"]["blocks"][0], "text": f"v{i}"}]}})
                except Exception as e:  # pragma: no cover
                    errors.append(e)
            stop.set()

        t = threading.Thread(target=saver)
        t.start()
        seen = 0
        while not stop.is_set():
            cur = self.cur(a["id"])
            try:
                out = report.build({"items": [{"kind": "note", "page_id": a["id"], "rev": cur["rev"]}]})
            except hq_carnet.CarnetConflict:
                continue  # the page moved on: nothing generated, never a mixed render
            body = out["sections"][0]["blocks"][0]["text"]
            self.assertIn(body, out["markdown"])
            self.assertEqual(out["page_revs"][a["id"]], cur["rev"])
            seen += 1
        t.join()
        self.assertEqual(errors, [])


class BackupTests(Stage08Base):
    def snap(self, name="bk"):
        dest = self.tmp / name
        return hq_carnet.snapshot_to(self.tmp, dest), dest

    def test_valid_malformed_and_missing_history(self):
        page = self.make_page([para("a")])
        out, dest = self.snap("bk0")
        self.assertNotIn("history", out, "no history file: the accepted status shape is unchanged")
        self.assertFalse((dest / "history.json").exists())
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})
        out, dest = self.snap("bk1")
        self.assertTrue(out["valid"])
        self.assertTrue(out["history"]["valid"])
        self.assertEqual((dest / "history.json").read_bytes(), self.history_path.read_bytes())
        self.history_path.write_bytes(b"{broken")
        out, dest = self.snap("bk2")
        self.assertFalse(out["valid"])
        self.assertFalse(out["history"]["valid"])
        self.assertEqual((dest / "history.json").read_bytes(), b"{broken", "malformed bytes copied as-is")
        self.assertEqual(self.history_path.read_bytes(), b"{broken")

    def test_history_only_root_is_included(self):
        self.history_path.parent.mkdir(parents=True, exist_ok=True)
        history.append("lifecycle", "applied", "x", {"page_id": "page-" + "a" * 24, "action": "trash", "rev_after": 2})
        out, _ = self.snap("bk3")
        self.assertTrue(out["included"])

    def test_history_added_during_backup_is_either_old_or_new_never_torn(self):
        page = self.make_page([para("a")])
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"], "label": "one"})
        stop = threading.Event()

        def writer():
            for i in range(20):
                cur = self.cur(page["id"])
                hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [{**cur["content"]["blocks"][0], "text": f"t{i}"}]}})
                hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "label": f"l{i}"})
            stop.set()

        t = threading.Thread(target=writer)
        t.start()
        n = 0
        while not stop.is_set():
            out, dest = self.snap(f"race{n}")
            n += 1
            self.assertTrue(out["history"]["valid"])
            json.loads((dest / "history.json").read_text(encoding="utf-8"))
        t.join()

    def test_restore_from_backup_and_index_rebuild(self):
        target = self.make_page([para("t")])
        a = self.make_page([para("abc", [link_mark(0, 3, "note", target["id"])])])
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": a["id"], "expected_rev": a["rev"]})
        links.backlinks("note", target["id"])
        out, dest = self.snap("bk4")
        # simulate a restore: copy the backup bytes back over a wiped root
        for f in (self.path, self.history_path):
            f.unlink()
        self.path.write_bytes((dest / "notebook.json").read_bytes())
        self.history_path.write_bytes((dest / "history.json").read_bytes())
        links.clear()
        again = links.backlinks("note", target["id"])
        self.assertEqual(again["total"], 1, "the derived index rebuilds from the restored notebook")
        self.assertEqual(len(history.list_events(page_id=a["id"])["events"]), 1)

    def test_report_assets_are_covered_by_the_notebook_backup(self):
        asset = media.store_upload(io.BytesIO(png()).read, len(png()), None)["asset"]
        a = self.make_page([image_block(asset, "c")])
        report.build({"items": [{"kind": "note", "page_id": a["id"], "rev": a["rev"]}], "export": {"dir": "Print"}})
        out, dest = self.snap("bk5")
        self.assertEqual(out["assets"]["missing"], 0)
        self.assertTrue(any((dest / "assets").iterdir()))

    # -- Stage 08 round 2: the backup must carry the media of every retained restore point ---------------------------
    def _strip_image(self, page, text="plain"):
        cur = self.cur(page["id"])
        return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [para(text)]}})

    def _clean_root_from(self, dest):
        """Wipe the Carnet data of the disposable root, then put back ONLY what the backup contains."""
        import shutil
        for f in (self.path, self.history_path):
            if f.exists():
                f.unlink()
        assets = media.confined_assets_dir(self.tmp)
        shutil.rmtree(assets)
        assets.mkdir()
        self.path.write_bytes((dest / "notebook.json").read_bytes())
        if (dest / "history.json").exists():
            self.history_path.write_bytes((dest / "history.json").read_bytes())
        if (dest / "assets").is_dir():
            for f in (dest / "assets").iterdir():
                shutil.copy2(f, assets / f.name)
        links.clear()

    def test_checkpoint_image_removed_from_page_is_in_the_backup_and_restorable(self):
        asset = media.store_upload(io.BytesIO(png()).read, len(png()), None)["asset"]
        page = self.make_page([image_block(asset, "c")])
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"], "label": "avec image"})
        self.assertEqual(cp[0], 200, cp)
        event_id = cp[1]["event_id"] if "event_id" in cp[1] else cp[1]["event"]["id"]
        self._strip_image(page)
        self.assertNotIn(asset["id"], hq_carnet.referenced_assets(json.loads(self.path.read_text())), "only history references it now")
        out, dest = self.snap("bk6")
        self.assertTrue(out["valid"], out)
        self.assertEqual(out["assets"]["missing"], 0)
        self.assertEqual(out["assets"]["count"], 1, "the historical image is copied")
        self._clean_root_from(dest)
        cur = self.cur(page["id"])
        status, res = hq_carnet.http_post({"action": "history_restore", "page_id": page["id"], "event_id": event_id, "expected_rev": cur["rev"], "confirm": True})
        self.assertEqual(status, 200, res)
        self.assertEqual(self.cur(page["id"])["content"]["blocks"][0]["asset"]["id"], asset["id"])

    def test_restore_pre_image_with_a_no_longer_current_image_is_covered(self):
        asset = media.store_upload(io.BytesIO(png()).read, len(png()), None)["asset"]
        page = self.make_page([image_block(asset, "c")])
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"], "label": "v1"})
        cp_id = cp[1]["event_id"] if "event_id" in cp[1] else cp[1]["event"]["id"]
        self._strip_image(page, "version sans image")
        cur = self.cur(page["id"])
        # restoring the checkpoint stores the CURRENT (image-less) content as pre_content; restoring again stores the image one
        status, res = hq_carnet.http_post({"action": "history_restore", "page_id": page["id"], "event_id": cp_id, "expected_rev": cur["rev"], "confirm": True})
        self.assertEqual(status, 200, res)
        self._strip_image(page, "encore sans image")
        data = json.loads(self.history_path.read_text())
        pre = [e for e in data["events"] if e["kind"] == "restore"]
        self.assertTrue(pre)
        # drop the checkpoint so ONLY the restore pre-image could hold an image: craft by saving an image page then restoring over it
        page2 = self.make_page([image_block(asset, "d")])
        stub = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page2["id"], "expected_rev": page2["rev"], "label": "stub"})
        stub_id = stub[1]["event_id"] if "event_id" in stub[1] else stub[1]["event"]["id"]
        cur2 = self._strip_image(page2, "x")
        cur2 = self.cur(page2["id"])
        hq_carnet.mutate({"action": "page_save", "id": page2["id"], "expected_rev": cur2["rev"], "content": {"version": 2, "blocks": [image_block(asset, "e")]}})
        cur2 = self.cur(page2["id"])
        status, res = hq_carnet.http_post({"action": "history_restore", "page_id": page2["id"], "event_id": stub_id, "expected_rev": cur2["rev"], "confirm": True})
        self.assertEqual(status, 200, res)
        refs = history.referenced_assets(json.loads(self.history_path.read_text()))
        self.assertEqual(refs, {asset["id"]})
        events = json.loads(self.history_path.read_text())["events"]
        self.assertTrue(any(e["kind"] == "restore" and any(b.get("type") == "image" for b in e["data"]["pre_content"]["blocks"]) for e in events), "a restore pre-image carries the image")
        self._strip_image(page2, "final")
        out, dest = self.snap("bk7")
        self.assertEqual((out["assets"]["count"], out["assets"]["missing"]), (1, 0))
        self.assertTrue(out["valid"])

    def test_historical_asset_missing_at_backup_time_marks_the_backup_invalid_and_keeps_bytes(self):
        asset = media.store_upload(io.BytesIO(png()).read, len(png()), None)["asset"]
        page = self.make_page([image_block(asset, "c")])
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})
        self._strip_image(page)
        for f in media.confined_assets_dir(self.tmp).iterdir():
            f.unlink()
        before = self.history_path.read_bytes()
        out, dest = self.snap("bk8")
        self.assertFalse(out["valid"])
        self.assertEqual(out["assets"]["missing"], 1)
        self.assertEqual((dest / "history.json").read_bytes(), before, "history bytes preserved as they are")
        self.assertEqual(self.history_path.read_bytes(), before)

    def test_an_asset_referenced_by_notebook_and_history_is_copied_once(self):
        asset = media.store_upload(io.BytesIO(png()).read, len(png()), None)["asset"]
        page = self.make_page([image_block(asset, "c")])
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"], "label": "again"})
        out, dest = self.snap("bk9")
        self.assertEqual((out["assets"]["count"], out["assets"]["missing"]), (1, 0))
        self.assertEqual(len(list((dest / "assets").iterdir())), 1)

    def test_malformed_history_adds_no_assets_and_is_invalid(self):
        asset = media.store_upload(io.BytesIO(png()).read, len(png()), None)["asset"]
        page = self.make_page([image_block(asset, "c")])
        self.history_path.parent.mkdir(parents=True, exist_ok=True)
        self.history_path.write_bytes(b"{broken")
        out, dest = self.snap("bk10")
        self.assertFalse(out["valid"])
        self.assertEqual(out["assets"]["count"], 1, "the current notebook's image is still covered")


class HttpSurfaceTests(unittest.TestCase):
    setUpClass = _base.ApiTests.__dict__["setUpClass"]
    tearDownClass = _base.ApiTests.__dict__["tearDownClass"]
    _login = _base.ApiTests.__dict__["_login"]
    _get = _base.ApiTests._get
    _post = _base.ApiTests._post

    def setUp(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(_base._fixture(), ensure_ascii=False), encoding="utf-8")
        hp = self.path.parent / "history.json"
        if hp.exists():
            hp.unlink()

    def first_page(self):
        return json.loads(self._get("/api/carnet")[2])["pages"][0]

    def test_admin_only_csrf_and_method_for_every_new_action(self):
        page = self.first_page()
        bodies = [
            {"action": "bulk_preview", "op": "replace", "params": {"find": "x"}, "page_ids": [page["id"]]},
            {"action": "bulk_apply", "op": "replace", "params": {"find": "x"}, "targets": [], "confirm": True, "expected_count": 0},
            {"action": "bulk_undo", "event_id": "hev-" + "0" * 24, "confirm": True},
            {"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]},
            {"action": "history_restore", "page_id": page["id"], "event_id": "hev-" + "0" * 24, "expected_rev": page["rev"], "confirm": True},
            {"action": "report_build", "items": [{"kind": "note", "page_id": page["id"], "rev": page["rev"]}]},
        ]
        for body in bodies:
            self.assertEqual(self._post(body, cookie=self.upload)[0], 403, body["action"])
            self.assertIn(self._post(body, cookie="")[0], (401, 403), "no session")
            self.assertIn(self._post(body, origin=False)[0], (401, 403), "CSRF/Origin required")
            status, headers, raw = self._post(body)
            self.assertNotIn(str(self.tmp), raw.decode() if isinstance(raw, bytes) else raw)
            self.assertEqual(headers.get("X-Content-Type-Options") or headers.get("x-content-type-options"), "nosniff")
        for q in ("history=1", "history=1&page=" + page["id"], "backlinks=note&id=" + page["id"]):
            self.assertEqual(self._get("/api/carnet?" + q, cookie=self.upload)[0], 403, q)
            self.assertEqual(self._get("/api/carnet?" + q)[0], 200, q)

    def test_get_history_shape_and_param_strictness(self):
        status, _h, body = self._get("/api/carnet?history=1")
        out = json.loads(body)
        self.assertEqual(out["events"], [])
        self.assertIn("limits", out)
        for bad in ("history=2", "history=1&x=1", "history=1&page=nope", "backlinks=note", "backlinks=note&id=a&id=b"):
            self.assertEqual(self._get("/api/carnet?" + bad)[0], 400, bad)

    def test_full_http_flow_checkpoint_bulk_undo(self):
        page = self.first_page()
        status, _h, body = self._post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"], "label": "t"})
        self.assertEqual(status, 200, body)
        status, _h, body = self._post({"action": "bulk_preview", "op": "replace", "params": {"find": page["content"]["blocks"][0]["text"][:1], "replace": "Z"}, "page_ids": [page["id"]]})
        self.assertEqual(status, 200, body)
        pv = json.loads(body)
        self.assertNotIn(str(self.tmp), body.decode() if isinstance(body, bytes) else body)
        self.assertIn("targets", pv)


class BudgetTests(Stage08Base):
    def test_128_pages_near_1mib_bulk_replace_undo_report_backlinks(self):
        target = self.make_page([para("t")])
        hc_max = 64
        pages = []
        for i in range(100):  # ~950 KB of note text over 100 pages (the notebook cap is 1 MiB)
            pages.append(self.make_page([para(("lorem ipsum dolor " * 60)[:950], [link_mark(0, 5, "note", target["id"])]) for _ in range(10)]))
        ids = [p["id"] for p in pages[:hc_max]]
        t0 = time.perf_counter()
        pv = self.preview("replace", {"find": "ipsum", "replace": "IPSUM"}, ids)
        t_prev = time.perf_counter() - t0
        t0 = time.perf_counter()
        out = self.apply("replace", pv["params"], self.targets_of(pv), expected=pv["count"])
        t_apply = time.perf_counter() - t0
        t0 = time.perf_counter()
        self.undo(out["event_id"])
        t_undo = time.perf_counter() - t0
        t0 = time.perf_counter()
        links.backlinks("note", target["id"])
        t_back = time.perf_counter() - t0
        t0 = time.perf_counter()
        report.build({"items": [{"kind": "note", "page_id": p["id"], "rev": self.cur(p["id"])["rev"]} for p in pages[:40]]})
        t_rep = time.perf_counter() - t0
        print(f"\n[budget] preview={t_prev:.3f}s apply={t_apply:.3f}s undo={t_undo:.3f}s backlinks={t_back:.3f}s report40={t_rep:.3f}s", file=sys.stderr)
        for name, value in (("preview", t_prev), ("apply", t_apply), ("undo", t_undo), ("backlinks", t_back), ("report", t_rep)):
            self.assertLess(value, 5.0, name)
        self.assertEqual(out["counts"]["applied"], pv["count"])


    def test_many_citations_migration_and_undo_budget(self):
        fam = self.family()
        old = self.edition(fam, "29e")
        new = self.edition(fam, "30e")
        for _ in range(60):
            self.make_page([self.cite_block(old, text=str(i), before="a ", after=" b") for i in range(20)])
        before = self.path.read_bytes()
        t0 = time.perf_counter()
        pv = self.preview("source_migrate", {"from_edition": old["id"], "to_edition": new["id"]})
        t_prev = time.perf_counter() - t0
        self.assertEqual(pv["count"], 60)
        t0 = time.perf_counter()
        out = self.apply("source_migrate", pv["params"], self.targets_of(pv), expected=60)
        t_apply = time.perf_counter() - t0
        t0 = time.perf_counter()
        self.undo(out["event_id"])
        t_undo = time.perf_counter() - t0
        print(f"\n[budget] migrate 60 pages x 20 citations: preview={t_prev:.3f}s apply={t_apply:.3f}s undo={t_undo:.3f}s", file=sys.stderr)
        for value in (t_prev, t_apply, t_undo):
            self.assertLess(value, 5.0)
        for page in self.disk()["pages"][1:]:
            for block in page["content"]["blocks"]:
                for mark in block["marks"]:
                    self.assertEqual(mark["cite"]["src"], old["id"])

    def test_history_retention_stress(self):
        page = self.make_page([para("v")])
        t0 = time.perf_counter()
        for i in range(60):
            cur = self.cur(page["id"])
            hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [{**cur["content"]["blocks"][0], "text": "v" * (i + 2)}]}})
            hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": self.cur(page["id"])["rev"]})
        self.assertLess(time.perf_counter() - t0, 10)
        self.assertLessEqual(len(self.history_bytes()), history.HISTORY_BYTES_MAX)


if __name__ == "__main__":
    unittest.main()
