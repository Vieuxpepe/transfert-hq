"""Carnet Stage 05 — engineering sources, citations, confined PDF references, calibration (server side).

Throwaway ROOTs only. Browser behaviour: tests/check_hq_carnet_sources.mjs (pure model + state machine)
and tests/visual_carnet_sources_playwright.mjs (Chromium).
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
import hq_carnet_sources as src  # noqa: E402
import iphone_bridge  # noqa: E402
from test_hq_carnet import CarnetBase, NOW, _dir_symlink, _file_symlink, _fixture, _http  # noqa: E402

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def cite(edition="srce-aaa", kind="page", text="417", pdf=439, ok=False, title="Shigley's Mechanical Engineering Design", edition_label="12e", origin=None, **snap):
    snapshot = {"title": title}
    if edition_label:
        snapshot["edition"] = edition_label
    snapshot.update(snap)
    return {"src": edition, "loc": {"kind": kind, "text": text}, "pdf": pdf, "ok": ok, "snap": snapshot, "from": origin}


def mark(start, end, c, **extra):
    return {"type": "citation", "start": start, "end": end, "cite": c, **extra}


def v2(*blocks):
    return {"version": 2, "blocks": list(blocks)}


def blk(text, marks=None, kind="paragraph", **extra):
    return {"type": kind, "text": text, "marks": marks or [], **extra}


class SourcesBase(CarnetBase):
    def setUp(self):
        super().setUp()
        for name in ("Inbox", "Uni", "Print"):
            (self.tmp / name).mkdir()
        hq_carnet.bind(
            root=self.tmp, now=lambda: self.clock[0], folders=lambda: ["Inbox", "Uni", "Print"],
            system_names=iphone_bridge.SYSTEM_NAMES, safe_leaf_name=iphone_bridge.safe_leaf_name,
        )
        self.spath = self.tmp / ".hq-carnet" / "sources.json"
        (self.tmp / "Uni" / "Shigley").mkdir()
        (self.tmp / "Uni" / "Shigley" / "12e.pdf").write_bytes(PDF)

    def m(self, **data):
        return src.mutate(data)

    def family(self, name="Shigley's Mechanical Engineering Design"):
        return self.m(action="source_family_create", name=name)["family"]

    def edition(self, fam, label="12e", **extra):
        payload = {"action": "source_edition_create", "family_id": fam["id"], "edition": label, "title": fam["name"], "type": "book", "year": 2026}
        payload.update(extra)
        return src.mutate(payload)["edition"]

    def sdisk(self):
        return json.loads(self.spath.read_text(encoding="utf-8"))


class SourceModelTests(SourcesBase):
    def test_empty_read_creates_nothing(self):
        data = src.get_sources()
        self.assertEqual((data["sources_rev"], data["families"], data["editions"]), (1, [], []))
        self.assertFalse(self.spath.exists(), "a read never writes")

    def test_family_create_update_archive_and_duplicates(self):
        fam = self.family("Machinery's Handbook")
        self.assertRegex(fam["id"], r"^srcf-[0-9a-f]{24}$")
        self.assertEqual((fam["rev"], fam["archived"]), (1, False))
        with self.assertRaises(src.SourceError):
            self.family("machinery's  handbook")  # case/space-insensitive duplicate
        with self.assertRaises(src.SourceError):
            self.family("MACHINERY’S HANDBOOK".replace("’", "'"))
        upd = self.m(action="source_family_update", id=fam["id"], expected_rev=1, name="Machinery's Handbook (Industrial Press)")["family"]
        self.assertEqual((upd["rev"], upd["name"]), (2, "Machinery's Handbook (Industrial Press)"))
        with self.assertRaises(src.SourceConflict) as ctx:
            self.m(action="source_family_update", id=fam["id"], expected_rev=1, name="Other")
        self.assertEqual(ctx.exception.payload["code"], "source_revision_conflict")
        self.assertEqual(ctx.exception.payload["record"]["name"], "Machinery's Handbook (Industrial Press)")
        arch = self.m(action="source_family_archive", id=fam["id"], expected_rev=2, archived=True)["family"]
        self.assertTrue(arch["archived"])
        for bad in ("", "   ", "a" * 121, "x\x00y", 5, None):
            with self.assertRaises(src.SourceError, msg=repr(bad)):
                self.m(action="source_family_create", name=bad)
        self.assertEqual(sorted(os.listdir(self.spath.parent)), ["sources.json"])

    def test_multiple_editions_and_old_edition_preserved(self):
        fam = self.family()
        a = self.edition(fam, "11e", year=2020, title="Shigley 11th", author="Budynas", identifier="ISBN 978-1", url="https://example.com/11e")
        rev_before = self.sdisk()["sources_rev"]
        b = self.edition(fam, "12e", year=2026, title="Shigley 12th")
        self.assertEqual((a["edition"], a["year"], a["title"], a["author"], a["identifier"]), ("11e", 2020, "Shigley 11th", "Budynas", "ISBN 978-1"))
        old = next(e for e in src.get_sources()["editions"] if e["id"] == a["id"])
        self.assertEqual((old["edition"], old["year"], old["title"], old["rev"]), ("11e", 2020, "Shigley 11th", 1), "creating a newer edition never touches the old one")
        self.assertGreater(self.sdisk()["sources_rev"], rev_before)
        with self.assertRaises(src.SourceError):
            self.edition(fam, "12E")  # same label in the family
        # edition label / year / family are immutable: a "new edition" is a new record
        for key, value in (("edition", "13e"), ("year", 2030), ("family_id", fam["id"])):
            with self.assertRaises(src.SourceError, msg=key):
                self.m(action="source_edition_update", id=a["id"], expected_rev=1, **{key: value})
        upd = self.m(action="source_edition_update", id=a["id"], expected_rev=1, title="Shigley 11th ed.", notes="  first line\nsecond ", type="standard", project_ids=["proj-x", "proj-x"])["edition"]
        self.assertEqual((upd["rev"], upd["title"], upd["notes"], upd["type"], upd["project_ids"], upd["edition"]), (2, "Shigley 11th ed.", "first line\nsecond", "standard", ["proj-x"], "11e"))
        self.assertEqual(b["id"] != a["id"], True)
        self.assertRegex(b["id"], r"^srce-[0-9a-f]{24}$")

    def test_supersession_is_an_annotation_never_a_rewrite(self):
        fam = self.family()
        a, b, c = self.edition(fam, "11e"), self.edition(fam, "12e"), self.edition(fam, "13e")
        out = self.m(action="source_edition_supersede", id=a["id"], expected_rev=1, newer_id=b["id"])["edition"]
        self.assertEqual((out["superseded_by"], out["rev"], out["edition"]), (b["id"], 2, "11e"))
        new = next(e for e in src.get_sources()["editions"] if e["id"] == b["id"])
        self.assertEqual((new["rev"], new["superseded_by"], new["calibration"], new["file_ref"]), (1, None, None, ""), "the newer edition inherits nothing and is untouched")
        with self.assertRaises(src.SourceError):
            self.m(action="source_edition_supersede", id=b["id"], expected_rev=1, newer_id=a["id"])  # a -> b -> a cycle
        with self.assertRaises(src.SourceError):
            self.m(action="source_edition_supersede", id=b["id"], expected_rev=1, newer_id=b["id"])
        other = self.edition(self.family("Other family"), "1e", title="Other")
        with self.assertRaises(src.SourceError):
            self.m(action="source_edition_supersede", id=b["id"], expected_rev=1, newer_id=other["id"])  # different family
        self.m(action="source_edition_archive", id=c["id"], expected_rev=1, archived=True)
        with self.assertRaises(src.SourceError):
            self.m(action="source_edition_supersede", id=b["id"], expected_rev=1, newer_id=c["id"])  # archived target
        with self.assertRaises(src.SourceConflict):
            self.m(action="source_edition_supersede", id=a["id"], expected_rev=1, newer_id=b["id"])
        cleared = self.m(action="source_edition_supersede", id=a["id"], expected_rev=2, newer_id=None)["edition"]
        self.assertIsNone(cleared["superseded_by"])

    def test_archive_is_a_tombstone_and_nothing_is_deleted(self):
        fam = self.family()
        ed = self.edition(fam)
        arch = self.m(action="source_edition_archive", id=ed["id"], expected_rev=1, archived=True)["edition"]
        self.assertTrue(arch["archived"])
        got = next(e for e in src.get_sources()["editions"] if e["id"] == ed["id"])
        self.assertEqual((got["id"], got["title"], got["archived"]), (ed["id"], ed["title"], True), "still listed, still addressable")
        back = self.m(action="source_edition_archive", id=ed["id"], expected_rev=2, archived=False)["edition"]
        self.assertFalse(back["archived"])
        self.assertFalse(any(a.endswith("delete") for a in src.ACTIONS), "there is no delete action")

    def test_field_bounds_types_urls_and_unknown_keys(self):
        fam = self.family()
        base = {"action": "source_edition_create", "family_id": fam["id"], "edition": "x", "title": "T"}
        for extra in (
            {"title": ""}, {"title": "t" * 201}, {"author": "a" * 121}, {"edition": "e" * 41}, {"year": 1300}, {"year": 2300}, {"year": "2026"},
            {"year": True}, {"type": "magazine"}, {"notes": "n" * 2001}, {"identifier": "i" * 61}, {"project_ids": ["bad"]}, {"project_ids": "proj-a"},
            {"project_ids": [f"proj-{i}" for i in range(33)]}, {"bogus": 1}, {"id": "srce-x"}, {"calibration": {"printed": 1, "pdf": 2}},
        ):
            with self.assertRaises(src.SourceError, msg=repr(extra)):
                src.mutate({**base, **extra})
        for t in src.TYPES:
            self.edition(self.family(f"F-{t}"), "1", type=t)
        for good in ("http://example.com/a", "https://example.com/x?y=1#z"):
            self.edition(self.family(f"U-{good[:12]}-{len(good)}"), "1", url=good)
        for bad in ("javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "blob:https://x/y", "ftp://x.y", "//x.y", "example.com", "https://user:pw@x.y", "https://" + "a" * 2100):
            with self.assertRaises(src.SourceError, msg=bad):
                src.mutate({**base, "edition": "u" + str(abs(hash(bad)) % 9999), "url": bad})
        with self.assertRaises(src.SourceNotFound):
            src.mutate({**base, "family_id": "srcf-nope"})
        with self.assertRaises(src.SourceError):
            src.mutate({**base, "family_id": "bad"})

    def test_limits_are_enforced(self):
        from unittest import mock

        with mock.patch.object(src, "FAMILIES_MAX", 2), mock.patch.object(src, "EDITIONS_MAX", 1):
            f1 = self.family("A")
            f2 = self.family("B")
            with self.assertRaises(src.SourceError):
                self.family("C")
            self.edition(f1, "1")
            with self.assertRaises(src.SourceError):
                self.edition(f2, "1")

    def test_optimistic_concurrency_between_two_clients(self):
        fam = self.family()
        ed = self.edition(fam)
        # A: two clients edit the same edition
        first = self.m(action="source_edition_update", id=ed["id"], expected_rev=1, title="Client A title")["edition"]
        with self.assertRaises(src.SourceConflict) as ctx:
            self.m(action="source_edition_update", id=ed["id"], expected_rev=1, notes="Client B notes")
        payload = ctx.exception.payload
        self.assertEqual((payload["code"], payload["kind"], payload["record"]["title"], payload["record"]["rev"]), ("source_revision_conflict", "edition", "Client A title", first["rev"]))
        self.assertEqual(self.sdisk()["editions"][0]["notes"], "", "the stale write changed nothing")
        # I: calibration edited concurrently
        self.m(action="source_edition_calibrate", id=ed["id"], expected_rev=2, calibration={"printed": 1, "pdf": 17})
        with self.assertRaises(src.SourceConflict):
            self.m(action="source_edition_calibrate", id=ed["id"], expected_rev=2, calibration={"printed": 1, "pdf": 19})
        self.assertEqual(self.sdisk()["editions"][0]["calibration"], {"printed": 1, "pdf": 17})
        # archive vs update
        self.m(action="source_edition_archive", id=ed["id"], expected_rev=3, archived=True)
        with self.assertRaises(src.SourceConflict):
            self.m(action="source_edition_update", id=ed["id"], expected_rev=3, title="late")
        # sources never touch the notebook's revisions
        self.seed(_fixture())
        self.assertEqual(hq_carnet.get_notebook()["notebook_rev"], 4)
        self.assertEqual(next(p for p in hq_carnet.get_notebook()["pages"] if p["id"] == "page-shaft")["rev"], 3)
        self.m(action="source_family_update", id=fam["id"], expected_rev=1, name="Renamed")
        self.assertEqual(hq_carnet.get_notebook()["notebook_rev"], 4, "source edits never bump notebook_rev or any page rev")


class ConfinedPdfTests(SourcesBase):
    def setUp(self):
        super().setUp()
        self.fam = self.family()

    def make(self, ref):
        return self.edition(self.fam, "e" + str(abs(hash(ref)) % 99999), file_ref=ref)

    def test_valid_confined_relative_pdf(self):
        ed = self.edition(self.fam, "12e", file_ref="Uni/Shigley/12e.pdf")
        self.assertEqual((ed["file_ref"], ed["file_state"]), ("Uni/Shigley/12e.pdf", "ok"))
        got = next(e for e in src.get_sources()["editions"] if e["id"] == ed["id"])
        self.assertEqual(got["file_state"], "ok")
        (self.tmp / "Uni" / "Shigley" / "12e.pdf").unlink()
        gone = next(e for e in src.get_sources()["editions"] if e["id"] == ed["id"])
        self.assertEqual((gone["file_ref"], gone["file_state"]), ("Uni/Shigley/12e.pdf", "missing"), "a later missing file is reported, the reference is kept")
        upper = (self.tmp / "Print" / "A.PDF")
        upper.write_bytes(PDF)
        self.assertEqual(self.edition(self.fam, "x2", file_ref="Print/A.PDF")["file_state"], "ok")

    def test_structurally_unsafe_references_are_refused(self):
        bad = [
            "../secret.pdf", "Uni/../../secret.pdf", "/etc/passwd.pdf", "/Uni/Shigley/12e.pdf", "C:/Windows/x.pdf", "C:\\x.pdf", "\\\\server\\share\\x.pdf",
            "//server/share/x.pdf", "Uni\\Shigley\\12e.pdf", "Uni/Shigley/%2e%2e/12e.pdf", "Elsewhere/x.pdf", "Uni", "Uni/Shigley", "Uni/.hidden/x.pdf",
            "Uni/Shigley/12e.txt", "Uni/Shigley/12e", "Uni/Shigley/12e.pdf ", "Uni/Shigley//12e.pdf", "Uni/./Shigley/12e.pdf", "Uni/Shigley/a:b.pdf",
            "Uni/readme.txt.pdf/../x.pdf", "x" * 401 + ".pdf", 5, ["Uni/Shigley/12e.pdf"], {"a": 1},
        ]
        for ref in bad:
            with self.assertRaises(src.SourceError, msg=repr(ref)):
                self.edition(self.fam, "b" + str(abs(hash(repr(ref))) % 99999), file_ref=ref)
        self.assertEqual(self.sdisk()["editions"] if self.spath.exists() else [], [])

    def test_missing_file_is_refused_at_set_time_without_leaking_a_path(self):
        with self.assertRaises(src.SourceError) as ctx:
            self.edition(self.fam, "m", file_ref="Uni/Shigley/nope.pdf")
        message = str(ctx.exception)
        self.assertNotIn(str(self.tmp), message)
        self.assertNotIn("nope", message)
        with self.assertRaises(src.SourceError):
            self.edition(self.fam, "m2", file_ref="Uni/Shigley")  # a directory that even ends like nothing pdf
        (self.tmp / "Uni" / "dir.pdf").mkdir()
        with self.assertRaises(src.SourceError):
            self.edition(self.fam, "m3", file_ref="Uni/dir.pdf")  # a directory named *.pdf is not a file

    def test_symlinks_and_junction_style_escapes_are_refused(self):
        outside = Path(self.tmp.parent) / (self.tmp.name + "-outside")
        outside.mkdir()
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        (outside / "secret.pdf").write_bytes(PDF)
        _dir_symlink(outside, self.tmp / "Uni" / "linkdir")
        for ref in ("Uni/linkdir/secret.pdf",):
            with self.assertRaises(src.SourceError, msg=ref):
                self.edition(self.fam, "s1", file_ref=ref)
        _file_symlink(outside / "secret.pdf", self.tmp / "Uni" / "linkfile.pdf")
        with self.assertRaises(src.SourceError):
            self.edition(self.fam, "s2", file_ref="Uni/linkfile.pdf")
        # a stored reference that later turns into a link is reported unsafe, never followed
        ok = self.edition(self.fam, "s3", file_ref="Uni/Shigley/12e.pdf")
        (self.tmp / "Uni" / "Shigley" / "12e.pdf").unlink()
        os.symlink(outside / "secret.pdf", self.tmp / "Uni" / "Shigley" / "12e.pdf")
        got = next(e for e in src.get_sources()["editions"] if e["id"] == ok["id"])
        self.assertEqual(got["file_state"], "unsafe")
        self.assertNotIn(str(outside), json.dumps(src.get_sources()))

    def test_system_names_and_unconfigured_roots(self):
        (self.tmp / "Uni" / "bridge_config.json.pdf").write_bytes(PDF)
        self.edition(self.fam, "n1", file_ref="Uni/bridge_config.json.pdf")  # a real pdf whose name merely looks odd is fine
        (self.tmp / "Uni" / "design.md").write_bytes(b"x")
        with self.assertRaises(src.SourceError):
            self.edition(self.fam, "n2", file_ref="Uni/design.md")
        hq_carnet.bind(folders=lambda: ["Inbox"])
        with self.assertRaises(src.SourceError):
            self.edition(self.fam, "n3", file_ref="Uni/Shigley/12e.pdf")
        # a stored reference survives a later change of the configured roots (structural validation on read)
        hq_carnet.bind(folders=lambda: ["Inbox", "Uni", "Print"])


class CalibrationTests(SourcesBase):
    def setUp(self):
        super().setUp()
        self.ed = self.edition(self.family(), "12e")

    def test_calibration_pair_is_explicit_and_validated(self):
        out = self.m(action="source_edition_calibrate", id=self.ed["id"], expected_rev=1, calibration={"printed": 1, "pdf": 17})["edition"]
        self.assertEqual(out["calibration"], {"printed": 1, "pdf": 17})
        for bad in ({"printed": 0, "pdf": 1}, {"printed": 1, "pdf": 0}, {"printed": 1}, {"printed": "1", "pdf": 17}, {"printed": 1.0, "pdf": 17},
                    {"printed": True, "pdf": 17}, {"printed": 1, "pdf": 17, "x": 1}, {"printed": 1, "pdf": 100001}, "1:17", [1, 17]):
            with self.assertRaises(src.SourceError, msg=repr(bad)):
                self.m(action="source_edition_calibrate", id=self.ed["id"], expected_rev=2, calibration=bad)
        cleared = self.m(action="source_edition_calibrate", id=self.ed["id"], expected_rev=2, calibration=None)["edition"]
        self.assertIsNone(cleared["calibration"])

    def test_resolution_never_assumes_printed_equals_pdf(self):
        ed = dict(self.ed)
        page = lambda t, **k: src.resolve_pdf_page(ed, {"kind": "page", "text": t}, **k)  # noqa: E731
        self.assertIsNone(page("417"), "no calibration -> unresolved, never printed == PDF")
        ed["calibration"] = {"printed": 1, "pdf": 17}  # front matter: PDF page 17 is printed page 1
        self.assertEqual(page("1"), 17)
        self.assertEqual(page("417"), 433)
        self.assertEqual(page("417", pdf=439), 439, "an explicit PDF index always wins")
        self.assertIsNone(page("xii"), "roman/non-numeric printed pages are not mapped")
        self.assertIsNone(page("4.2"))
        self.assertIsNone(page(""))
        self.assertIsNone(src.resolve_pdf_page(ed, {"kind": "section", "text": "417"}), "only page locators map")
        self.assertIsNone(src.resolve_pdf_page(ed, {"kind": "figure", "text": "3"}))
        ed["calibration"] = {"printed": 30, "pdf": 5}  # would map printed 1 to a page before the first
        self.assertIsNone(page("1"))
        self.assertEqual(page("30"), 5)
        ed["calibration"] = {"printed": 1, "pdf": 99999}
        self.assertIsNone(page("999999"), "results beyond the supported range are unresolved")


class MalformedStorageTests(SourcesBase):
    def seed_bytes(self, raw: bytes):
        self.spath.parent.mkdir(parents=True, exist_ok=True)
        self.spath.write_bytes(raw)

    def test_malformed_bytes_are_preserved_and_refused(self):
        cases = [
            b"{ this is not valid json",
            json.dumps({"version": 2, "sources_rev": 1, "families": [], "editions": []}).encode(),
            json.dumps({"version": 1, "sources_rev": 0, "families": [], "editions": []}).encode(),
            json.dumps({"version": 1, "sources_rev": 1, "families": [], "editions": [], "extra": 1}).encode(),
            b"[]",
        ]
        for raw in cases:
            self.seed_bytes(raw)
            with self.assertRaises(src.SourceStorageError):
                src.get_sources()
            with self.assertRaises(src.SourceStorageError):
                src.mutate({"action": "source_family_create", "name": "X"})
            self.assertEqual(self.spath.read_bytes(), raw, "the exact bytes are preserved, never repaired")
        self.assertEqual(sorted(os.listdir(self.spath.parent)), ["sources.json"])

    def test_one_malformed_record_makes_the_file_unusable_and_untouched(self):
        fam = {"id": "srcf-a", "name": "F", "rev": 1, "archived": False, "created_at": 1.0, "updated_at": 1.0}
        ed = {"id": "srce-a", "family_id": "srcf-a", "rev": 1, "type": "book", "title": "T", "author": "", "edition": "1", "year": None, "publisher": "",
              "identifier": "", "url": "", "file_ref": "", "notes": "", "archived": False, "superseded_by": None, "project_ids": [], "calibration": None,
              "created_at": 1.0, "updated_at": 1.0}
        good = {"version": 1, "sources_rev": 1, "families": [fam], "editions": [ed]}
        self.seed_bytes(json.dumps(good).encode())
        self.assertEqual(len(src.get_sources()["editions"]), 1)
        broken = [
            lambda d: d["editions"][0].update(family_id="srcf-none"), lambda d: d["editions"][0].update(type="magazine"),
            lambda d: d["editions"][0].update(superseded_by="srce-none"), lambda d: d["editions"][0].update(superseded_by="srce-a"),
            lambda d: d["editions"][0].update(url="javascript:x"), lambda d: d["editions"][0].update(file_ref="../x.pdf"),
            lambda d: d["editions"][0].update(calibration={"printed": 0, "pdf": 1}), lambda d: d["editions"][0].pop("notes"),
            lambda d: d["editions"].append(dict(ed)), lambda d: d["families"].append(dict(fam)), lambda d: d["editions"][0].update(rev=0),
            lambda d: d["editions"][0].update(year=1),
        ]
        for i, fn in enumerate(broken):
            data = json.loads(json.dumps(good))
            fn(data)
            raw = json.dumps(data).encode()
            self.seed_bytes(raw)
            with self.assertRaises(src.SourceStorageError, msg=i):
                src.get_sources()
            with self.assertRaises(src.SourceStorageError):
                src.mutate({"action": "source_family_create", "name": "New"})
            self.assertEqual(self.spath.read_bytes(), raw, i)

    def test_malformed_sources_never_break_the_notebook(self):
        self.seed(_fixture())
        self.seed_bytes(b"{ broken")
        self.assertEqual(hq_carnet.get_notebook()["notebook_rev"], 4)
        out = hq_carnet.mutate({"action": "page_save", "id": "page-idea", "expected_rev": 1, "content": v2(blk("ok"))})
        self.assertEqual(out["page"]["rev"], 2)
        self.assertEqual(self.spath.read_bytes(), b"{ broken")

    def test_symlinked_sources_path_is_refused(self):
        self.spath.parent.mkdir(parents=True, exist_ok=True)
        target = self.tmp / "elsewhere.json"
        target.write_text("{}", encoding="utf-8")
        _file_symlink(target, self.spath)
        with self.assertRaises(src.SourceStorageError) as ctx:
            src.get_sources()
        self.assertNotIn(str(self.tmp), str(ctx.exception))


class CitationNoteTests(SourcesBase):
    def setUp(self):
        super().setUp()
        self.seed(_fixture())

    def save(self, blocks, rev=1, page="page-idea"):
        return hq_carnet.mutate({"action": "page_save", "id": page, "expected_rev": rev, "content": v2(*blocks) if not isinstance(blocks, dict) else blocks})

    def test_every_locator_kind_persists_with_its_snapshot(self):
        text = "see [x]"
        for i, kind in enumerate(rich.LOCATOR_KINDS):
            c = cite(kind=kind, text=f"{kind}-1", pdf=None if kind != "page" else 439)
            out = self.save([blk(text, [mark(4, 7, c)])], rev=1 + i)
            got = out["page"]["content"]["blocks"][0]["marks"][0]["cite"]
            self.assertEqual(got["loc"], {"kind": kind, "text": f"{kind}-1"})
            self.assertEqual(got["snap"], {"title": "Shigley's Mechanical Engineering Design", "edition": "12e"})
            self.assertEqual(got["src"], "srce-aaa")
        for bad in ("bibliography", "", None, 3):
            with self.assertRaises(hq_carnet.CarnetError, msg=repr(bad)):
                self.save([blk(text, [mark(4, 7, cite(kind=bad))])], rev=1 + len(rich.LOCATOR_KINDS))

    def test_semantic_locator_and_pdf_page_are_different_things(self):
        out = self.save([blk("[c]", [mark(0, 3, cite(kind="page", text="417", pdf=439))])])
        c = out["page"]["content"]["blocks"][0]["marks"][0]["cite"]
        self.assertEqual((c["loc"]["text"], c["pdf"]), ("417", 439))
        again = self.save([blk("[c]", [mark(0, 3, cite(kind="page", text="417", pdf=None))])], rev=2)
        self.assertIsNone(again["page"]["content"]["blocks"][0]["marks"][0]["cite"]["pdf"], "printed 417 does not imply a PDF page")

    def test_same_visible_text_different_citation_metadata_is_not_equal(self):
        base = cite()
        first = self.save([blk("[Shigley 12e, p. 417]", [mark(0, 21, base)])])
        rev = first["page"]["rev"]
        same = self.save([blk("[Shigley 12e, p. 417]", [mark(0, 21, dict(reversed(list(base.items()))))])], rev=rev)
        self.assertEqual(same["page"]["rev"], rev, "identical canonical citation (key order irrelevant) is no change")
        variants = [
            cite(edition="srce-bbb"), cite(kind="section", text="417"), cite(text="418"), cite(pdf=440), cite(pdf=None), cite(ok=True),
            cite(origin={"src": "srce-old", "loc": {"kind": "page", "text": "394"}, "pdf": 416, "ok": True}), cite(title="Other title"), cite(edition_label="11e"),
        ]
        for i, v in enumerate(variants):
            out = self.save([blk("[Shigley 12e, p. 417]", [mark(0, 21, v)])], rev=rev)
            self.assertEqual(out["page"]["rev"], rev + 1, f"variant {i} is a real change")
            rev = out["page"]["rev"]
            back = self.save([blk("[Shigley 12e, p. 417]", [mark(0, 21, base)])], rev=rev)
            rev = back["page"]["rev"]

    def test_invalid_citations_are_rejected_without_writing(self):
        raw = self.path.read_bytes()
        good = cite()
        bad = {
            "edition id": cite(edition="srcf-aaa"), "edition text": cite(edition="Shigley 12e"), "edition none": cite(edition=None),
            "page string": cite(pdf="439"), "page zero": cite(pdf=0), "page big": cite(pdf=100001), "page bool": cite(pdf=True),
            "ok not bool": {**good, "ok": 1}, "verified without location": cite(text="", pdf=None, ok=True),
            "locator text ctrl": cite(text="4\x001"), "locator text long": cite(text="x" * 121), "locator newline": cite(text="a\nb"),
            "no title": {**good, "snap": {"edition": "12e"}}, "snap extra": {**good, "snap": {"title": "T", "html": "<b>"}}, "snap year": {**good, "snap": {"title": "T", "year": "2026"}},
            "snap long": {**good, "snap": {"title": "t" * 201}}, "extra key": {**good, "note": "x"}, "missing key": {k: v for k, v in good.items() if k != "from"},
            "from shape": {**good, "from": {"src": "srce-x"}}, "from bad src": {**good, "from": {"src": "bad", "loc": {"kind": "page", "text": "1"}, "pdf": None, "ok": False}},
            "not dict": "cite", "loc kind": {**good, "loc": {"kind": "page"}},
        }
        for label, c in bad.items():
            with self.assertRaises(hq_carnet.CarnetError, msg=label):
                self.save([blk("[c]", [mark(0, 3, c)])])
            self.assertEqual(self.path.read_bytes(), raw, label)
        for extra in ({"href": "https://a.b"}, {"ref": {"kind": "note", "id": "page-a"}}):
            with self.assertRaises(hq_carnet.CarnetError):
                self.save([blk("[c]", [mark(0, 3, good, **extra)])])
        with self.assertRaises(hq_carnet.CarnetError):
            self.save([blk("[c]", [{"type": "citation", "start": 0, "end": 3}])])

    def test_citations_are_atoms_never_merged_never_overlapping(self):
        a, b = cite(text="1"), cite(text="1")
        out = self.save([blk("[a][a]", [mark(0, 3, a), mark(3, 6, b)])])
        self.assertEqual([(m["start"], m["end"]) for m in out["page"]["content"]["blocks"][0]["marks"]], [(0, 3), (3, 6)], "two identical adjacent citations stay two")
        with self.assertRaises(hq_carnet.CarnetError):
            self.save([blk("[a][a]", [mark(0, 4, a), mark(3, 6, b)])], rev=2)
        with self.assertRaises(hq_carnet.CarnetError):
            self.save([blk("[a]", [mark(0, 3, a), {"type": "link", "start": 1, "end": 2, "href": "https://a.b"}])], rev=2)

    def test_citation_and_formatting_on_the_same_range(self):
        c = cite()
        marks = [{"type": "bold", "start": 0, "end": 6}, mark(2, 8, c), {"type": "italic", "start": 2, "end": 8}, {"type": "highlight", "start": 7, "end": 9}]
        out = self.save([blk("ab[c1234]zz", marks)])
        kinds = [(m["type"], m["start"], m["end"]) for m in out["page"]["content"]["blocks"][0]["marks"]]
        self.assertEqual(kinds, [("bold", 0, 6), ("italic", 2, 8), ("citation", 2, 8), ("highlight", 7, 9)])
        self.assertTrue(rich.valid_v2(self.page("page-idea")["content"]))
        self.assertEqual(self.page("page-idea")["content"]["blocks"][0]["marks"][2]["cite"], c)

    def test_archive_or_missing_source_never_breaks_a_note(self):
        fam = src.mutate({"action": "source_family_create", "name": "Fam"})["family"]
        ed = src.mutate({"action": "source_edition_create", "family_id": fam["id"], "edition": "1", "title": "Manual"})["edition"]
        c = cite(edition=ed["id"], title="Manual", edition_label="1")
        self.save([blk("[Manual 1, p. 3]", [mark(0, 16, c)])])
        src.mutate({"action": "source_edition_archive", "id": ed["id"], "expected_rev": 1, "archived": True})
        out = self.save([blk("[Manual 1, p. 3] more", [mark(0, 16, c)])], rev=2)  # B: archived while a client inserts a citation
        self.assertEqual(out["page"]["content"]["blocks"][0]["marks"][0]["cite"]["src"], ed["id"])
        ghost = cite(edition="srce-doesnotexist")
        self.save([blk("[g]", [mark(0, 3, ghost)])], rev=3)  # a note never depends on the source file being present

    def test_stale_note_save_with_a_citation_is_a_normal_conflict(self):
        remote = self.save([blk("remote", [mark(0, 3, cite())])])
        with self.assertRaises(hq_carnet.CarnetConflict) as ctx:
            self.save([blk("local", [mark(0, 3, cite(text="9"))])], rev=1)
        self.assertEqual(ctx.exception.payload["code"], "revision_conflict")
        self.assertEqual(ctx.exception.payload["page"]["content"], remote["page"]["content"])

    def test_migration_provenance_round_trips(self):
        old = {"src": "srce-11e", "loc": {"kind": "page", "text": "394"}, "pdf": 416, "ok": True}
        new = cite(edition="srce-12e", text="", pdf=None, ok=False, edition_label="12e", origin=old)
        out = self.save([blk("[Shigley 12e, à vérifier]", [mark(0, 25, new)])])
        got = out["page"]["content"]["blocks"][0]["marks"][0]["cite"]
        self.assertEqual(got["from"], old, "old edition + old locator + old PDF page + old verification are preserved")
        self.assertEqual((got["loc"]["text"], got["ok"], got["pdf"]), ("", False, None), "no page is carried over automatically")

    def test_exports_are_meaningful_snapshots(self):
        c = cite()
        label = "[Shigley 12e, p. 417]"
        self.save([blk("Voir " + label + " ok", [mark(5, 5 + len(label), c), {"type": "bold", "start": 0, "end": 4}])])
        content = self.page("page-idea")["content"]
        self.assertEqual(rich.render_txt(content), "Voir " + label + " ok\n")
        md = rich.render_markdown(content)
        self.assertEqual(md, "**Voir** \\[Shigley 12e, p. 417\\] ok\n", "deterministic Markdown: the label, escaped, no invented syntax")
        self.assertEqual(rich.render_markdown(content), md)
        # the same after the source is archived (nothing is read from the source file)
        self.assertEqual(hq_carnet.get_notebook()["pages"][1]["content"]["blocks"][0]["marks"][1]["cite"], c)


class SourceHttpTests(unittest.TestCase):
    """Admin-only, CSRF-protected, no path leaks, PDF frame policy limited to the confined PDF route."""

    @classmethod
    def setUpClass(cls):
        import shutil
        import tempfile
        import threading
        from http.server import ThreadingHTTPServer
        from urllib.parse import urlencode

        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-carnet-src-"))
        cls._shutil = shutil
        cls._root = iphone_bridge.ROOT
        cls._config = json.loads(json.dumps(iphone_bridge.CONFIG))
        cls._carnet_cb, cls._carnet_ready = dict(hq_carnet._cb), hq_carnet._ready
        cls._src_cb = dict(src._cb)
        cls._sessions_path = iphone_bridge.SESSIONS_PATH
        iphone_bridge.SESSIONS_PATH = cls.tmp / "bridge_sessions.json"
        iphone_bridge.ROOT = cls.tmp
        for name in ("Inbox", "Uni", "Print"):
            (cls.tmp / name).mkdir()
        (cls.tmp / "Uni" / "book.pdf").write_bytes(PDF)
        (cls.tmp / "Uni" / "note.txt").write_bytes(b"hello")
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
        src._cb.clear()
        src._cb.update(cls._src_cb)
        cls._shutil.rmtree(cls.tmp, ignore_errors=True)

    def post(self, payload, *, cookie=None, origin=True):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = f"http://127.0.0.1:{self.port}"
        return _http(self.port, "POST", "/api/carnet", body=json.dumps(payload).encode(), headers=headers, cookie=self.admin if cookie is None else cookie)

    def get(self, path, cookie=None):
        return _http(self.port, "GET", path, cookie=self.admin if cookie is None else cookie)

    def test_admin_crud_over_http_with_confined_pdf(self):
        status, _h, body = self.post({"action": "source_family_create", "name": "HTTP family"})
        self.assertEqual(status, 200, body)
        fam = json.loads(body)["family"]
        status, _h, body = self.post({"action": "source_edition_create", "family_id": fam["id"], "edition": "1e", "title": "Book", "file_ref": "Uni/book.pdf"})
        self.assertEqual(status, 200, body)
        ed = json.loads(body)["edition"]
        self.assertEqual(ed["file_state"], "ok")
        status, _h, body = self.get("/api/carnet?sources=1")
        data = json.loads(body)
        self.assertEqual((status, [e["id"] for e in data["editions"]]), (200, [ed["id"]]))
        self.assertNotIn(str(self.tmp), body.decode())
        for ref in ("../x.pdf", "/etc/passwd.pdf", "C:/x.pdf", "Uni/missing.pdf"):
            status, _h, body = self.post({"action": "source_edition_create", "family_id": fam["id"], "edition": "z" + str(len(ref)), "title": "T", "file_ref": ref})
            self.assertEqual(status, 400, ref)
            self.assertNotIn(str(self.tmp), body.decode())
        status, _h, body = self.post({"action": "source_edition_update", "id": ed["id"], "expected_rev": 99, "title": "stale"})
        self.assertEqual((status, json.loads(body)["code"]), (409, "source_revision_conflict"))
        for bad in ("/api/carnet?sources=2", "/api/carnet?sources=1&meta=1", "/api/carnet?sources="):
            self.assertEqual(self.get(bad)[0], 400, bad)

    def test_upload_role_csrf_and_auth_unchanged(self):
        for payload in ({"action": "source_family_create", "name": "Nope"},):
            self.assertEqual(self.post(payload, cookie=self.upload)[0], 403)
            self.assertIn(self.post(payload, origin=False)[0], (401, 403))
            self.assertIn(self.post(payload, cookie="")[0], (401, 403))
        self.assertEqual(self.get("/api/carnet?sources=1", cookie=self.upload)[0], 403)
        self.assertIn(self.get("/api/carnet?sources=1", cookie="")[0], (401, 403))
        self.assertEqual(self.get("/files/Uni/book.pdf", cookie=self.upload)[0], 403, "a PDF existing on disk gives the upload role nothing")
        self.assertFalse((self.tmp / ".hq-carnet" / "sources.json").exists() and b"Nope" in (self.tmp / ".hq-carnet" / "sources.json").read_bytes())

    def test_pdf_is_frameable_same_origin_only_and_nothing_else_is(self):
        status, headers, body = self.get("/files/Uni/book.pdf")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("X-Frame-Options"), "SAMEORIGIN")
        csp = headers.get("Content-Security-Policy", "")
        self.assertIn("frame-ancestors 'self'", csp)
        self.assertIn("default-src 'self'", csp)
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(headers.get("Content-Type"), "application/pdf")
        status, headers, _b = self.get("/download/Uni/book.pdf")
        self.assertEqual(headers.get("X-Frame-Options"), "DENY", "a download is never frameable")
        status, headers, _b = self.get("/files/Uni/note.txt")
        self.assertEqual((headers.get("X-Frame-Options"), "frame-ancestors 'none'" in headers.get("Content-Security-Policy", "")), ("DENY", True))
        status, headers, _b = self.get("/api/carnet?meta=1")
        self.assertEqual((headers.get("X-Frame-Options"), "frame-ancestors 'none'" in headers.get("Content-Security-Policy", "")), ("DENY", True))
        status, headers, _b = self.get("/")
        self.assertEqual(headers.get("X-Frame-Options"), "DENY")
        self.assertEqual(self.get("/files/Uni/../../etc/passwd")[0], 404)
        self.assertEqual(self.get("/files/..%2f..%2fetc/passwd.pdf")[0], 404)


class BackupSourcesTests(SourcesBase):
    def test_snapshot_includes_sources_without_changing_the_accepted_shape(self):
        self.seed(_fixture())
        dest = self.tmp / "bk1"
        plain = hq_carnet.snapshot_to(self.tmp, dest)
        self.assertEqual(plain, {"ok": True, "included": True, "status": "included", "bytes": plain["bytes"], "valid": True})
        self.assertFalse((dest / "sources.json").exists())
        fam = self.family()
        self.edition(fam, "1", file_ref="Uni/Shigley/12e.pdf")
        dest2 = self.tmp / "bk2"
        out = hq_carnet.snapshot_to(self.tmp, dest2)
        self.assertEqual((out["status"], out["valid"], out["sources"]["valid"]), ("included", True, True))
        self.assertEqual((dest2 / "sources.json").read_bytes(), self.spath.read_bytes())
        self.assertEqual((dest2 / "notebook.json").read_bytes(), self.path.read_bytes())
        self.assertFalse(list(dest2.rglob("*.pdf")), "PDFs live under Inbox/Uni/Print and are covered by the legacy folder backup")

    def test_malformed_or_redirected_sources_are_reported_not_hidden(self):
        self.seed(_fixture())
        self.spath.parent.mkdir(parents=True, exist_ok=True)
        self.spath.write_bytes(b"{ broken")
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "bk3")
        self.assertEqual((out["status"], out["valid"], out["sources"]["valid"]), ("included", False, False))
        self.assertEqual((self.tmp / "bk3" / "sources.json").read_bytes(), b"{ broken")
        self.spath.unlink()
        target = self.tmp / "elsewhere.json"
        target.write_text("{}", encoding="utf-8")
        _file_symlink(target, self.spath)
        with self.assertRaises(hq_carnet.CarnetStorageError):
            hq_carnet.snapshot_to(self.tmp, self.tmp / "bk4")

    def test_sources_only_notebook_absent(self):
        self.family()
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "bk5")
        self.assertEqual((out["status"], out["included"], out["valid"]), ("included", True, True))
        self.assertTrue((self.tmp / "bk5" / "sources.json").is_file())
        self.assertFalse((self.tmp / "bk5" / "notebook.json").exists())
        empty = self.tmp / "empty-root"
        empty.mkdir()
        self.assertEqual(hq_carnet.snapshot_to(empty, self.tmp / "bk6"), {"ok": True, "included": False, "status": "absent"})


class StaticAndParityTests(unittest.TestCase):
    """Static guarantees of the Stage-05 client + JS/Python parity of the citation rules."""

    ROOT = Path(__file__).resolve().parent.parent

    def test_sources_client_has_no_dangerous_sinks_or_network_beyond_same_origin(self):
        import re

        for name in ("hq-carnet-sources.js", "hq-carnet-rich.js"):
            text = (self.ROOT / "assets" / name).read_text(encoding="utf-8")
            for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "importScripts", "XMLHttpRequest", "sendBeacon", "WebSocket", "localStorage", "sessionStorage"):
                self.assertNotIn(bad, text, f"{name}: {bad}")
            self.assertFalse(re.search(r"\bfetch\(", text), f"{name}: no direct fetch (the shared api() helper is the only transport)")
            self.assertFalse(re.search(r"https?://(?!example\.com)[a-z0-9.-]+", text, re.I) and "cdn" in text.lower(), "no CDN")
        src_js = (self.ROOT / "assets" / "hq-carnet-sources.js").read_text(encoding="utf-8")
        self.assertIn('"/files/"', src_js)
        self.assertNotIn("srcdoc", src_js)
        self.assertNotIn("sandbox", src_js, "a sandboxed iframe cannot show the PDF viewer; the frame is same-origin PDF only")

    def test_page_loads_modules_in_dependency_order(self):
        text = (self.ROOT / "iphone_bridge.py").read_text(encoding="utf-8")
        rich = text.index('<script src="/assets/hq-carnet-rich.js"></script>')
        srcs = text.index('<script src="/assets/hq-carnet-sources.js"></script>')
        core = text.index('<script src="/assets/hq-carnet.js"></script>')
        self.assertLess(rich, srcs)
        self.assertLess(srcs, core)
        # Stage 07: the lazy engineering UI module loads between the sources module and the editor
        self.assertIn("load('/assets/hq-carnet-struct.js', () => load('/assets/hq-carnet-rich.js', () => load('/assets/hq-carnet-sources.js', () => load('/assets/hq-carnet-eng-ui.js', () => load('/assets/hq-carnet-history-ui.js', () => load('/assets/hq-carnet-image-ui.js', () => load('/assets/hq-carnet-structured-ui.js', () => load('/assets/hq-carnet-nav.js', () => load('/assets/hq-carnet-polish-ui.js', () => load('/assets/hq-carnet-dessiner.js', () => load('/assets/hq-carnet-commands.js', () => load('/assets/hq-carnet-templates.js', () => load('/assets/hq-carnet-editor-ui.js', () => load('/assets/hq-carnet.js'", text)

    def test_editor_hooks_use_the_single_state_machine(self):
        js = (self.ROOT / "assets" / "hq-carnet.js").read_text(encoding="utf-8")
        self.assertIn("data-carnet-citation", js)
        self.assertIn("sourcesUi()", js)
        self.assertIn("commit: commitLines", js, "citations are written through commitLines like every other structural edit")

    def test_js_and_python_agree_on_citations(self):
        import shutil
        import subprocess

        node = shutil.which("node")
        if not node:
            self.skipTest("node not available")
        good = cite()
        vectors = [good, cite(pdf=None), cite(ok=True), cite(kind="custom", text="Annexe B"), cite(text="", pdf=None, ok=True), cite(pdf=0), cite(pdf=100001),
                   cite(kind="nope"), cite(edition="srcf-x"), {**good, "extra": 1}, cite(text="a\nb"), cite(text="x" * 121), cite(text="  4   17 "),
                   cite(title="t" * 201), {**good, "snap": {"title": "T", "year": 1399}}, {**good, "snap": {"title": "T", "year": 2200}},
                   cite(origin={"src": "srce-old", "loc": {"kind": "page", "text": "394"}, "pdf": 416, "ok": True}),
                   cite(origin={"src": "bad", "loc": {"kind": "page", "text": "394"}, "pdf": 416, "ok": True}), "x", None, cite(pdf=True),
                   cite(title="\U0001F600" * 100), cite(title="\U0001F600" * 101), cite(title="\U0001F600" * 200), cite(text="\U0001F600" * 60), cite(text="\U0001F600" * 61)]
        for ch in ("\u0085", "\ufeff", "\u00a0", "\u2028", "\u2029", "\u200b", "\u180e", "\u1680", "\u3000", "\x1c", "\x1f", "\x7f", "\x9f", "\u2007", "\u202f", "\u205f"):
            vectors.append(cite(text=f"A{ch}B"))
            vectors.append(cite(text=f"A{ch}{ch}B "))
            vectors.append(cite(title=f"{ch}T{ch}"))
            vectors.append(cite(title=ch))
        for t in ("\ud800", "\udc00", "A\ud800B", "A\udc00B", "\U0001F600", "\U0001F600\ud800", "\udc00\U0001F600", "\ude00\ud83d", "A\ud83d", "\ud83d"):
            vectors.append(cite(text=t))
            vectors.append(cite(title=t))
        expected = []
        for v in vectors:
            try:
                expected.append(rich.check_cite(json.loads(json.dumps(v))))
            except rich.ContentError:
                expected.append(None)
        script = (
            "const R=require(process.argv[1]);const v=JSON.parse(require('fs').readFileSync(0,'utf8'));"
            "process.stdout.write(JSON.stringify(v.map(x=>R.checkCite(x))))"
        )
        out = subprocess.run([node, "-e", script, str(self.ROOT / "assets" / "hq-carnet-rich.js")], input=json.dumps(vectors), capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        got = json.loads(out.stdout)
        self.assertEqual(got, expected)
        self.assertTrue(any(g is None for g in got) and any(g is not None for g in got))
        # the explicit whitespace set: folded on both sides; C1 controls refused on both sides
        self.assertEqual(rich.check_cite(cite(text="A\ufeffB"))["loc"]["text"], "A B")
        self.assertEqual(rich.check_cite(cite(text="A\u00a0\u3000B"))["loc"]["text"], "A B")
        for bad in ("A\u0085B", "A\x1cB", "A\x9fB"):
            with self.assertRaises(rich.ContentError, msg=repr(bad)):
                rich.check_cite(cite(text=bad))

    def test_calibration_resolution_parity(self):
        import shutil
        import subprocess

        node = shutil.which("node")
        if not node:
            self.skipTest("node not available")
        cases = []
        for cal in (None, {"printed": 1, "pdf": 17}, {"printed": 30, "pdf": 5}, {"printed": 1, "pdf": 99999}):
            for kind in ("page", "section"):
                for text in ("1", "417", "xii", "4.2", "", "\u00b2", "99999999", " 7 "):
                    for pdf in (None, 12):
                        cases.append({"ed": {"calibration": cal}, "loc": {"kind": kind, "text": text}, "pdf": pdf})
        expected = [src.resolve_pdf_page(c["ed"], c["loc"], c["pdf"]) for c in cases]
        script = (
            "const S=require(process.argv[1]);const v=JSON.parse(require('fs').readFileSync(0,'utf8'));"
            "process.stdout.write(JSON.stringify(v.map(c=>S.resolvePdf(c.ed,c.loc,c.pdf))))"
        )
        out = subprocess.run([node, "-e", script, str(self.ROOT / "assets" / "hq-carnet-sources.js")], input=json.dumps(cases), capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout), expected)


class AuditRegressionTests(SourcesBase):
    """Findings of the independent Stage-05 audit: each one is pinned here."""

    def test_a_supersession_target_cannot_be_archived_while_referenced(self):
        fam = self.family()
        a, b = self.edition(fam, "11e"), self.edition(fam, "12e")
        self.m(action="source_edition_supersede", id=a["id"], expected_rev=1, newer_id=b["id"])
        with self.assertRaises(src.SourceError):
            self.m(action="source_edition_archive", id=b["id"], expected_rev=1, archived=True)
        self.assertFalse(self.sdisk()["editions"][1]["archived"])
        # archiving the OLD edition stays fine; removing the edge frees the target
        self.m(action="source_edition_archive", id=a["id"], expected_rev=2, archived=True)
        self.m(action="source_edition_supersede", id=a["id"], expected_rev=3, newer_id=None)
        self.m(action="source_edition_archive", id=b["id"], expected_rev=1, archived=True)

    def _state(self, editions):
        fam = lambda i: {"id": f"srcf-f{i}", "name": f"F{i}", "rev": 1, "archived": False, "created_at": 1.0, "updated_at": 1.0}  # noqa: E731
        base = {"type": "book", "title": "T", "author": "", "year": None, "publisher": "", "identifier": "", "url": "", "file_ref": "", "notes": "",
                "archived": False, "superseded_by": None, "project_ids": [], "calibration": None, "rev": 1, "created_at": 1.0, "updated_at": 1.0}
        eds = [{**base, "id": eid, "family_id": f, "edition": eid, **extra} for eid, f, extra in editions]
        return {"version": 1, "sources_rev": 1, "families": [fam(1), fam(2)], "editions": eds}

    def test_persisted_supersession_graph_is_validated(self):
        good = self._state([("srce-a", "srcf-f1", {"superseded_by": "srce-b"}), ("srce-b", "srcf-f1", {})])
        self.assertTrue(src._usable(good))
        bad = {
            "cross family": [("srce-a", "srcf-f1", {"superseded_by": "srce-b"}), ("srce-b", "srcf-f2", {})],
            "cycle": [("srce-a", "srcf-f1", {"superseded_by": "srce-b"}), ("srce-b", "srcf-f1", {"superseded_by": "srce-a"})],
            "archived target": [("srce-a", "srcf-f1", {"superseded_by": "srce-b"}), ("srce-b", "srcf-f1", {"archived": True})],
            "long cycle": [("srce-a", "srcf-f1", {"superseded_by": "srce-b"}), ("srce-b", "srcf-f1", {"superseded_by": "srce-c"}), ("srce-c", "srcf-f1", {"superseded_by": "srce-b"})],
        }
        for label, eds in bad.items():
            state = self._state(eds)
            self.assertFalse(src._usable(state), label)
            raw = json.dumps(state).encode()
            self.spath.parent.mkdir(parents=True, exist_ok=True)
            self.spath.write_bytes(raw)
            with self.assertRaises(src.SourceStorageError, msg=label):
                src.get_sources()
            self.assertEqual(self.spath.read_bytes(), raw, label)

    def test_citation_text_bounds_count_utf16_units_on_both_sides(self):
        emoji = "\U0001F600"
        ok = cite(title=emoji * 100)  # 200 UTF-16 units
        self.assertEqual(rich.check_cite(ok)["snap"]["title"], emoji * 100)
        with self.assertRaises(rich.ContentError):
            rich.check_cite(cite(title=emoji * 101))
        with self.assertRaises(rich.ContentError):
            rich.check_cite(cite(title=emoji * 200))  # 400 units: rejected, like the browser
        # a source title that fits the source limit always fits the snapshot limit
        fam = self.family()
        edn = self.edition(fam, "e1", title=emoji * 100)
        rich.check_cite({"src": edn["id"], "loc": {"kind": "page", "text": "1"}, "pdf": None, "ok": False, "snap": {"title": edn["title"]}, "from": None})
        with self.assertRaises(src.SourceError):
            self.edition(fam, "e2", title=emoji * 101)

    def test_stale_writes_are_conflicts_even_with_an_invalid_body(self):
        fam = self.family()
        ed = self.edition(fam)
        cases = [
            dict(action="source_family_update", id=fam["id"], expected_rev=999, name=""),
            dict(action="source_family_archive", id=fam["id"], expected_rev=999, archived="yes"),
            dict(action="source_edition_archive", id=ed["id"], expected_rev=999, archived="yes"),
            dict(action="source_edition_calibrate", id=ed["id"], expected_rev=999, calibration={"printed": 0, "pdf": 0}),
            dict(action="source_edition_update", id=ed["id"], expected_rev=999, title=""),
            dict(action="source_edition_supersede", id=ed["id"], expected_rev=999, newer_id="bogus"),
        ]
        for c in cases:
            with self.assertRaises(src.SourceConflict, msg=c["action"]) as ctx:
                self.m(**c)
            self.assertEqual(ctx.exception.payload["code"], "source_revision_conflict")
        # with the CURRENT revision the same bodies are plain validation errors
        with self.assertRaises(src.SourceError):
            self.m(action="source_family_update", id=fam["id"], expected_rev=1, name="")

    def test_oversized_json_integers_are_controlled_malformed_storage(self):
        raw = b'{"version":1,"sources_rev":' + b"9" * 6000 + b',"families":[],"editions":[]}'
        self.spath.parent.mkdir(parents=True, exist_ok=True)
        self.spath.write_bytes(raw)
        with self.assertRaises(src.SourceStorageError):
            src.get_sources()
        with self.assertRaises(src.SourceStorageError):
            src.mutate({"action": "source_family_create", "name": "X"})
        payload, valid = src.snapshot_bytes(self.tmp)
        self.assertEqual((payload, valid), (raw, False))
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "bk-big")
        self.assertEqual(out["sources"]["valid"], False)
        self.assertEqual(self.spath.read_bytes(), raw)


if __name__ == "__main__":
    unittest.main()
