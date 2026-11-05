"""Carnet Phase 9 — the Reader resolver (``reader_resolve``) and the /files byte-range honesty.

The Reader VIEWS evidence: it never transforms, summarises or reinterprets it. These tests pin the server half: the closed request
schema, read-only behaviour, the captured / current / integrity separation, locator != PDF page, ``ok`` = location only, missing /
archived / unknown source and file states, frozen-file integrity (match / differs / sealed file missing), batching and isolation.
"""

from __future__ import annotations

import copy
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_portals as portals  # noqa: E402
import hq_carnet_reader as reader  # noqa: E402
import hq_carnet_rich as rich  # noqa: E402
import hq_carnet_sources as sources  # noqa: E402
from test_hq_carnet_portals import PBase  # noqa: E402
from test_hq_carnet_reviews import post, rid, tree_digest  # noqa: E402

PDF_A = b"%PDF-1.4 frozen bytes A"
PDF_B = b"%PDF-1.4 other bytes B"


def rd(*entries):
    return hq_carnet.http_post({"action": "reader_resolve", "entries": [copy.deepcopy(e) for e in entries]})


def one(entry):
    status, out = rd(entry)
    assert status == 200, out
    return out["results"][0]


class RBase2(PBase):
    def pdf(self, name="book.pdf", data=PDF_A):
        self.put("Uni/" + name, data)
        return "Uni/" + name

    def ed_with_file(self, title="Machinery", data=PDF_A, **extra):
        ref = self.pdf("b-" + rid()[:6] + ".pdf", data)
        return self.ed(title, file_ref=ref, **extra), ref

    def cite_of(self, ed, kind="clause", text="304.1.2", pdf=None, ok=True, **snap):
        c = self.cite(ed, kind, text, pdf, ok)
        c["snap"] = {**c["snap"], **snap}
        return c

    def rename(self, ed, title):
        rev = self.src_rev(ed)
        return sources.mutate({"action": "source_edition_update", "id": ed["id"], "expected_rev": rev, "title": title})["edition"]


class SchemaTests(RBase2):
    def test_exact_request_schema(self):
        ed = self.ed()
        good = {"source_id": ed["id"]}
        bad = [
            {"action": "reader_resolve"}, {"action": "reader_resolve", "entries": []}, {"action": "reader_resolve", "entries": "x"},
            {"action": "reader_resolve", "entries": [good], "extra": 1}, {"action": "reader_resolve", "entries": [good] * 101},
            {"action": "reader_resolve", "entries": [{}]}, {"action": "reader_resolve", "entries": [{**good, "path": "Uni/a.pdf"}]},
            {"action": "reader_resolve", "entries": [{"source_id": "/etc/passwd"}]}, {"action": "reader_resolve", "entries": [{"source_id": "https://evil.example/x.pdf"}]},
            {"action": "reader_resolve", "entries": [{"source_id": "file:///etc/passwd"}]}, {"action": "reader_resolve", "entries": [{"source_id": "srce-a/../b"}]},
            {"action": "reader_resolve", "entries": [{"source_id": 7}]}, {"action": "reader_resolve", "entries": [None]},
            {"action": "reader_resolve", "entries": [{**good, "url": "https://evil.example"}]},
            {"action": "reader_resolve", "entries": [{**good, "file_ref": "/etc/passwd"}]},
        ]
        for payload in bad:
            status, out = hq_carnet.http_post(payload)
            self.assertEqual(status, 400, payload)
            self.assertEqual(out["code"], "validation_error")
        self.assertEqual(rd(good)[0], 200)
        self.assertEqual(rd(*[good] * 100)[0], 200)

    def test_a_citation_must_be_canonical_and_match_the_source(self):
        ed, other = self.ed(), self.ed("Autre")
        c = self.cite_of(ed)
        for bad in ({**c, "extra": 1}, {**c, "src": other["id"]}, {**c, "ok": "yes"}, {**c, "pdf": 0}, {**c, "snap": {"title": ""}}, "x", None):
            self.assertEqual(rd({"source_id": ed["id"], "citation": bad})[0], 400, bad)
        self.assertEqual(rd({"source_id": ed["id"], "citation": c})[0], 200)

    def test_a_context_is_closed_and_needs_exactly_one_entry(self):
        ed = self.ed()
        sid = "snap-" + "0" * 24
        for ctx in ({"kind": "snapshot"}, {"kind": "snapshot", "id": "x"}, {"kind": "snapshot", "id": sid, "x": 1}, {"kind": "review", "id": "rvw-" + "0" * 24},
                    {"kind": "review", "id": "rvw-" + "0" * 24, "item_id": "zz"}, {"kind": "file", "id": "Uni/a.pdf"}, "snapshot", None):
            self.assertEqual(rd({"source_id": ed["id"], "context": ctx})[0], 400, ctx)
        two = [{"source_id": ed["id"], "context": {"kind": "snapshot", "id": sid}}, {"source_id": ed["id"]}]
        self.assertEqual(rd(*two)[0], 400)

    def test_admin_only_http_and_registered_read_only(self):
        self.assertIn("reader_resolve", hq_carnet._STAGE08)
        out = one({"source_id": self.ed()["id"]})
        self.assertIn("captured", out)
        status, res = rd({"source_id": self.ed()["id"]})
        self.assertTrue(res["read_only"])
        self.assertEqual(res["limits"], {"entries": 100})


class ReadOnlyTests(RBase2):
    def test_resolving_changes_nothing_on_disk(self):
        ed, ref = self.ed_with_file()
        self.page_of(self.cite_block(ed))
        before = tree_digest(self.tmp)
        rd({"source_id": ed["id"], "citation": self.cite_of(ed)}, {"source_id": ed["id"]}, {"source_id": "srce-gone"})
        self.assertEqual(tree_digest(self.tmp), before, "no notebook, source, review, snapshot or file moved")

    def test_no_raw_path_url_or_file_scheme_in_any_answer(self):
        ed, ref = self.ed_with_file(url="https://example.com/spec")
        res = one({"source_id": ed["id"]})
        route = res["current"]["file"]["route"]
        self.assertEqual(route, "/files/" + ref)  # the only file reference is the confined route
        out = json.dumps(res).replace(route, "")
        for forbidden in (str(self.tmp), "file://", "https://example.com", ref):
            self.assertNotIn(forbidden, out)


class CapturedVsCurrentTests(RBase2):
    def test_locator_and_pdf_page_are_separate_and_never_derived(self):
        ed = self.ed()
        both = one({"source_id": ed["id"], "citation": self.cite_of(ed, "page", "417", 429)})["captured"]
        self.assertEqual((both["locator"], both["pdf"]), ({"kind": "page", "text": "417"}, 429))
        loc_only = one({"source_id": ed["id"], "citation": self.cite_of(ed, "clause", "304.1.2", None)})["captured"]
        self.assertEqual((loc_only["locator"], loc_only["pdf"]), ({"kind": "clause", "text": "304.1.2"}, None))
        pdf_only = one({"source_id": ed["id"], "citation": self.cite_of(ed, "page", "", 417, ok=False)})["captured"]
        self.assertEqual((pdf_only["locator"], pdf_only["pdf"]), (None, 417))

    def test_a_calibrated_edition_never_makes_the_server_guess_a_pdf_page(self):
        ed = self.ed()
        sources.mutate({"action": "source_edition_calibrate", "id": ed["id"], "expected_rev": self.src_rev(ed), "calibration": {"printed": 1, "pdf": 13}})
        out = one({"source_id": ed["id"], "citation": self.cite_of(ed, "page", "417", None)})
        self.assertIsNone(out["captured"]["pdf"])
        self.assertNotIn("calibration", json.dumps(out))

    def test_ok_is_a_location_flag_and_nothing_else(self):
        ed = self.ed()
        yes = one({"source_id": ed["id"], "citation": self.cite_of(ed, ok=True)})["captured"]
        no = one({"source_id": ed["id"], "citation": self.cite_of(ed, ok=False)})["captured"]
        self.assertEqual((yes["location_verified"], no["location_verified"]), (True, False))
        self.assertNotIn("verified", [k for k in yes if k != "location_verified"])

    def test_title_change_keeps_the_captured_snapshot_and_shows_current_separately(self):
        ed = self.ed("Spec A")
        cite = self.cite_of(ed)
        self.rename(ed, "Spec B")
        out = one({"source_id": ed["id"], "citation": cite})
        self.assertEqual(out["captured"]["metadata"]["title"], "Spec A")
        self.assertEqual(out["current"]["metadata"]["title"], "Spec B")
        self.assertIn("title", out["differs"])
        self.assertEqual(one({"source_id": ed["id"], "citation": self.cite_of(self.rename(ed, "Spec B"))})["differs"], [])

    def test_source_gone_keeps_the_citation_and_its_snapshot(self):
        ed = self.ed("Spec A")
        cite = self.cite_of(ed)
        path = sources.confined_path()
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        data["editions"] = [e for e in data["editions"] if e["id"] != ed["id"]]
        Path(path).write_text(json.dumps(data), encoding="utf-8")
        out = one({"source_id": ed["id"], "citation": cite})
        self.assertEqual(out["current"], {"state": "missing", "metadata": None, "file": {"state": "none", "route": None}})
        self.assertEqual(out["captured"]["metadata"]["title"], "Spec A")
        self.assertEqual(out["captured"]["locator"], {"kind": "clause", "text": "304.1.2"})

    def test_archived_source_is_still_inspectable_when_its_file_exists(self):
        ed, ref = self.ed_with_file("Old")
        sources.mutate({"action": "source_edition_archive", "id": ed["id"], "expected_rev": self.src_rev(ed), "archived": True})
        cur = one({"source_id": ed["id"]})["current"]
        self.assertEqual(cur["state"], "archived")
        self.assertEqual(cur["file"]["state"], "ok")
        self.assertTrue(cur["file"]["route"].startswith("/files/Uni/"))

    def test_missing_file_is_not_a_missing_source(self):
        ed, ref = self.ed_with_file()
        (self.tmp / ref).unlink()
        cur = one({"source_id": ed["id"]})["current"]
        self.assertEqual((cur["state"], cur["file"]), ("available", {"state": "missing", "route": None}))

    def test_unknown_file_state_is_not_missing(self):
        ed, ref = self.ed_with_file()
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        (self.tmp / ref).unlink()
        (self.tmp / "Uni" / "Redir").symlink_to(outside, target_is_directory=True)
        path = sources.confined_path()
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        for e in data["editions"]:
            if e["id"] == ed["id"]:
                e["file_ref"] = "Uni/Redir/x.pdf"
        Path(path).write_text(json.dumps(data), encoding="utf-8")
        cur = one({"source_id": ed["id"]})["current"]
        self.assertEqual((cur["state"], cur["file"]["state"]), ("available", "unknown"))
        self.assertNotEqual(cur["file"]["state"], "missing")

    def test_unreadable_source_store_is_unknown_never_missing(self):
        ed = self.ed()
        with mock.patch.object(portals, "_sources_by_id", return_value=None):
            out = one({"source_id": ed["id"], "citation": self.cite_of(ed)})
        self.assertEqual(out["current"]["state"], "unknown")
        self.assertEqual(out["captured"]["metadata"]["title"], ed["title"])

    def test_migration_provenance_is_separate(self):
        old, new = self.ed("Old"), self.ed("New")
        cite = self.cite_of(new)
        cite["from"] = {"src": old["id"], "loc": {"kind": "page", "text": "12"}, "pdf": 20, "ok": True}
        cap = one({"source_id": new["id"], "citation": cite})["captured"]
        self.assertEqual(cap["provenance"], {"source_id": old["id"], "locator": {"kind": "page", "text": "12"}, "pdf": 20, "location_verified": True})
        self.assertEqual(cap["locator"], {"kind": "clause", "text": "304.1.2"})
        self.assertIsNone(one({"source_id": new["id"], "citation": self.cite_of(new)})["captured"]["provenance"])

    def test_hostile_titles_travel_as_inert_data(self):
        evil = "<script>alert(1)</script>"
        ed = self.ed(evil)
        out = one({"source_id": ed["id"], "citation": self.cite_of(ed)})
        self.assertEqual(out["current"]["metadata"]["title"], evil)
        self.assertEqual(out["captured"]["metadata"]["title"], evil)


class BatchTests(RBase2):
    def test_100_entries_are_one_batch_deduplicated_with_one_store_read(self):
        eds = [self.ed("T%d" % i) for i in range(5)]
        entries = [{"source_id": eds[i % 5]["id"], "citation": self.cite_of(eds[i % 5], text=str(i % 10))} for i in range(100)]
        with mock.patch.object(portals, "_sources_by_id", wraps=portals._sources_by_id) as spy:
            status, out = rd(*entries)
        self.assertEqual(status, 200)
        self.assertEqual(len(out["results"]), 100)
        self.assertEqual(out["resolved"], 10)  # 5 editions x 2 distinct locators
        self.assertLessEqual(spy.call_count, 10)
        self.assertEqual([r["source_id"] for r in out["results"]], [e["source_id"] for e in entries])

    def test_one_broken_source_does_not_suppress_the_other_cards(self):
        a, b, c = self.ed("A"), self.ed("B"), self.ed("C")
        real = reader._current

        def flaky(sid, root, cache):
            if sid == b["id"]:
                raise RuntimeError("boom /secret/path")
            return real(sid, root, cache)

        with mock.patch.object(reader, "_current", flaky):
            status, out = rd({"source_id": a["id"]}, {"source_id": b["id"]}, {"source_id": c["id"]})
        self.assertEqual(status, 200)
        states = [r["current"]["state"] for r in out["results"]]
        self.assertEqual(states, ["available", "unknown", "available"])
        self.assertNotIn("secret", json.dumps(out))

    def test_a_missing_source_in_a_batch_leaves_the_rest(self):
        a = self.ed("A")
        out = rd({"source_id": "srce-gone"}, {"source_id": a["id"]})[1]["results"]
        self.assertEqual([r["current"]["state"] for r in out], ["missing", "available"])


class FrozenTests(RBase2):
    def frozen_snapshot(self, ed):
        self.page_of(self.cite_block(ed))
        return self.snap()

    def ctx(self, sid):
        return {"kind": "snapshot", "id": sid}

    def test_hash_match_allows_normal_frozen_viewing(self):
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        out = one({"source_id": ed["id"], "context": self.ctx(sid)})
        self.assertEqual(out["integrity"]["state"], "matches_seal")
        self.assertEqual(out["integrity"]["route"], reader.verified_route(self.ctx(sid), ed["id"]))
        self.assertTrue(out["integrity"]["route"].startswith("/api/carnet/reader-pdf?snapshot=snap-"), "a matched seal is served by the verified route, not /files")
        self.assertNotIn(ref, out["integrity"]["route"], "identities only: no path")
        self.assertEqual(out["captured"]["kind"], "snapshot")

    def test_hash_mismatch_is_reported_and_keeps_frozen_metadata(self):
        ed, ref = self.ed_with_file("Frozen title")
        sid = self.frozen_snapshot(ed)
        (self.tmp / ref).write_bytes(PDF_B)
        self.rename(ed, "Renamed")
        out = one({"source_id": ed["id"], "context": self.ctx(sid)})
        self.assertEqual(out["integrity"]["state"], "differs_from_seal")
        self.assertEqual(out["captured"]["metadata"]["title"], "Frozen title")
        self.assertEqual(out["current"]["metadata"]["title"], "Renamed")
        self.assertIn("title", out["differs"])
        self.assertEqual(out["integrity"]["route"], "/files/" + ref, "offered only for the explicit, separately labelled action")

    def test_sealed_file_gone_means_frozen_bytes_unavailable(self):
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        (self.tmp / ref).unlink()
        out = one({"source_id": ed["id"], "context": self.ctx(sid)})
        self.assertEqual((out["integrity"]["state"], out["integrity"]["route"]), ("sealed_file_missing", None))
        self.assertEqual(out["captured"]["metadata"]["title"], ed["title"])

    def test_no_file_reference_or_no_sealed_file_is_not_applicable(self):
        ed = self.ed()
        sid = self.frozen_snapshot(ed)
        self.assertEqual(one({"source_id": ed["id"], "context": self.ctx(sid)})["integrity"]["state"], "not_applicable")
        ed2, ref = self.ed_with_file()
        (self.tmp / ref).unlink()
        sid2 = self.frozen_snapshot(ed2)  # the file was already absent when sealed: there were never bytes to compare
        self.put(ref, PDF_A)
        self.assertEqual(one({"source_id": ed2["id"], "context": self.ctx(sid2)})["integrity"]["state"], "not_applicable")

    def test_redirected_parent_is_unknown_integrity_not_missing(self):
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / Path(ref).name).write_bytes(PDF_A)
        shutil.rmtree(self.tmp / "Uni")
        (self.tmp / "Uni").symlink_to(outside, target_is_directory=True)
        out = one({"source_id": ed["id"], "context": self.ctx(sid)})
        self.assertEqual(out["integrity"]["state"], "unknown")
        self.assertIsNone(out["integrity"]["route"])

    def test_altered_or_unknown_snapshot_is_never_trusted(self):
        ed, ref = self.ed_with_file("Frozen title")
        sid = self.frozen_snapshot(ed)
        path = self.tmp / ".hq-carnet" / "snapshots" / (sid + ".json")
        raw = json.loads(path.read_text())
        raw["label"] = "falsifié"
        path.write_text(json.dumps(raw))
        out = one({"source_id": ed["id"], "context": self.ctx(sid)})
        self.assertEqual((out["integrity"]["state"], out["captured"], out["frozen"]), ("unknown", None, {"kind": "snapshot", "available": False}))
        self.assertEqual(out["current"]["metadata"]["title"], "Frozen title")  # the current side is still reported, separately
        gone = one({"source_id": ed["id"], "context": self.ctx("snap-" + "0" * 24)})
        self.assertEqual((gone["integrity"]["state"], gone["captured"]), ("unknown", None))

    def test_edition_not_in_the_snapshot_is_not_invented(self):
        a, b = self.ed("A"), self.ed("B")
        sid = self.frozen_snapshot(a)
        out = one({"source_id": b["id"], "context": self.ctx(sid)})
        self.assertEqual((out["captured"], out["integrity"]["state"]), (None, "unknown"))

    def _pack_with_source(self, ed, baseline):
        status, out = post(action="review_create", project_id=self.proj["id"], title="Revue", request_id=rid(), baseline=baseline)
        self.assertEqual(status, 200, out)
        pk = out["review"]
        status, out = post(action="review_item_add", id=pk["id"], expected_rev=pk["rev"], item={"kind": "source", "edition_id": ed["id"]})
        self.assertEqual(status, 200, out)
        return out["review"]

    def test_review_item_with_snapshot_scope_compares_the_seal(self):
        ed, ref = self.ed_with_file("Frozen title")
        sid = self.frozen_snapshot(ed)
        pk = self._pack_with_source(ed, {"kind": "snapshot", "snapshot_id": sid})
        ctx = {"kind": "review", "id": pk["id"], "item_id": pk["items"][0]["id"]}
        out = one({"source_id": ed["id"], "context": ctx})
        self.assertEqual((out["integrity"]["state"], out["captured"]["kind"]), ("matches_seal", "review_item"))
        self.assertEqual(out["frozen"], {"kind": "review", "available": True, "scope": "snapshot"})
        (self.tmp / ref).write_bytes(PDF_B)
        self.assertEqual(one({"source_id": ed["id"], "context": ctx})["integrity"]["state"], "differs_from_seal")

    def test_review_item_with_live_scope_pins_metadata_only(self):
        ed, ref = self.ed_with_file("Live title")
        pk = self._pack_with_source(ed, {"kind": "live"})
        ctx = {"kind": "review", "id": pk["id"], "item_id": pk["items"][0]["id"]}
        self.rename(ed, "Later")
        out = one({"source_id": ed["id"], "context": ctx})
        self.assertEqual(out["integrity"]["state"], "not_applicable")
        self.assertEqual(out["frozen"]["scope"], "live")
        self.assertEqual(out["captured"]["metadata"]["title"], "Live title")
        self.assertEqual(out["current"]["metadata"]["title"], "Later")

    def test_review_context_must_name_a_source_item_of_that_edition(self):
        ed, other = self.ed("A"), self.ed("B")
        pk = self._pack_with_source(ed, {"kind": "live"})
        item_id = pk["items"][0]["id"]
        wrong = one({"source_id": other["id"], "context": {"kind": "review", "id": pk["id"], "item_id": item_id}})
        self.assertEqual((wrong["captured"], wrong["integrity"]["state"]), (None, "unknown"))
        absent = one({"source_id": ed["id"], "context": {"kind": "review", "id": pk["id"], "item_id": "ri-" + "0" * 16}})
        self.assertEqual(absent["captured"], None)

    def test_frozen_comparison_is_read_only(self):
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        before = tree_digest(self.tmp)
        one({"source_id": ed["id"], "context": self.ctx(sid)})
        self.assertEqual(tree_digest(self.tmp), before)


class VerifiedPdfTests(FrozenTests):
    """r2: the hash verification and the served bytes are ONE observation (no pathname reopen between them)."""

    def route_qs(self, route):
        from urllib.parse import parse_qs, urlsplit

        return parse_qs(urlsplit(route).query, keep_blank_values=True)

    def fetch(self, route):
        status, name, got = hq_carnet.http_reader_pdf(self.route_qs(route))
        if status != 200:
            return status, got, None
        spool, size = got
        with spool:
            return status, name, spool.read()

    def test_stable_file_serves_exactly_the_verified_bytes(self):
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        route = one({"source_id": ed["id"], "context": self.ctx(sid)})["integrity"]["route"]
        status, name, data = self.fetch(route)
        self.assertEqual((status, data), (200, PDF_A))
        self.assertEqual(name, Path(ref).name)

    def test_file_replaced_between_resolve_and_get_is_refused(self):
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        out = one({"source_id": ed["id"], "context": self.ctx(sid)})
        self.assertEqual(out["integrity"]["state"], "matches_seal")
        (self.tmp / ref).write_bytes(PDF_B)  # replaced after the resolver said "matches", before the browser GET
        status, payload, data = self.fetch(out["integrity"]["route"])
        self.assertEqual((status, payload["code"], data), (409, "differs_from_seal", None))
        self.assertNotIn(str(self.tmp), json.dumps(payload))

    def test_replacement_after_hashing_cannot_reach_the_stream(self):
        """The file is swapped right AFTER the hashing read: the stream is still the hashed bytes (it never reopens the path)."""
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        route = one({"source_id": ed["id"], "context": self.ctx(sid)})["integrity"]["route"]
        real = portals._hash_confined

        def swap(root, rel, **kw):
            got = real(root, rel, **kw)
            (self.tmp / ref).write_bytes(PDF_B)
            return got

        with mock.patch.object(portals, "_hash_confined", swap):
            status, _name, data = self.fetch(route)
        self.assertEqual((status, data), (200, PDF_A))

    def test_review_item_context_is_served_the_same_way(self):
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        pk = self._pack_with_source(ed, {"kind": "snapshot", "snapshot_id": sid})
        ctx = {"kind": "review", "id": pk["id"], "item_id": pk["items"][0]["id"]}
        route = one({"source_id": ed["id"], "context": ctx})["integrity"]["route"]
        self.assertTrue(route.startswith("/api/carnet/reader-pdf?review=rvw-"))
        self.assertEqual(self.fetch(route)[::2], (200, PDF_A))
        (self.tmp / ref).write_bytes(PDF_B)
        self.assertEqual(self.fetch(route)[0], 409)

    def test_refusals_never_serve_and_carry_no_path(self):
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        good = {"snapshot": [sid], "source": [ed["id"]]}
        cases = [
            ({"snapshot": [sid]}, 400), ({**good, "x": ["1"]}, 400), ({"snapshot": [sid, sid], "source": [ed["id"]]}, 400),
            ({"snapshot": ["../x"], "source": [ed["id"]]}, 400), ({"snapshot": [sid], "source": ["srce-../x"]}, 400),
            ({"snapshot": ["snap-" + "0" * 24], "source": [ed["id"]]}, 404),
            ({"snapshot": [sid], "source": ["srce-other"]}, 404),
            ({"review": ["rvw-" + "0" * 24], "item": ["ri-" + "0" * 16], "source": [ed["id"]]}, 404),
        ]
        for qs, want in cases:
            status, _n, got = hq_carnet.http_reader_pdf(qs)
            self.assertEqual(status, want, qs)
            self.assertNotIn(str(self.tmp), json.dumps(got), qs)
        (self.tmp / ref).unlink()
        status, _n, got = hq_carnet.http_reader_pdf(good)
        self.assertEqual((status, got["code"]), (404, "sealed_file_missing"))

    def test_unsealed_and_live_scope_have_no_verified_pdf(self):
        ed = self.ed()
        sid = self.frozen_snapshot(ed)
        self.assertEqual(hq_carnet.http_reader_pdf({"snapshot": [sid], "source": [ed["id"]]})[0], 404)
        ed2, _ref = self.ed_with_file()
        pk = self._pack_with_source(ed2, {"kind": "live"})
        q = {"review": [pk["id"]], "item": [pk["items"][0]["id"]], "source": [ed2["id"]]}
        self.assertEqual(hq_carnet.http_reader_pdf(q)[0], 404)

    def test_oversize_is_refused_not_buffered(self):
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        with mock.patch.object(reader, "PDF_SPOOL_MAX", 4):
            status, _n, got = hq_carnet.http_reader_pdf({"snapshot": [sid], "source": [ed["id"]]})
        self.assertEqual((status, got["code"]), (413, "sealed_file_too_large"), "its own code: not 'unreadable', not 'differs'")

    def test_redirected_parent_is_refused(self):
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / Path(ref).name).write_bytes(PDF_A)
        shutil.rmtree(self.tmp / "Uni")
        (self.tmp / "Uni").symlink_to(outside, target_is_directory=True)
        status, _n, got = hq_carnet.http_reader_pdf({"snapshot": [sid], "source": [ed["id"]]})
        self.assertNotEqual(status, 200)
        self.assertIn(got["code"], ("sealed_file_noncanonical", "sealed_file_unreadable", "sealed_file_missing"))
        self.assertNotEqual(got["code"], "differs_from_seal")

    def test_every_refusal_has_a_distinct_code(self):
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        q = {"snapshot": [sid], "source": [ed["id"]]}
        codes = {}
        (self.tmp / ref).write_bytes(PDF_B)
        codes["differs"] = hq_carnet.http_reader_pdf(q)[2]["code"]
        (self.tmp / ref).unlink()
        codes["missing"] = hq_carnet.http_reader_pdf(q)[2]["code"]
        codes["frozen"] = hq_carnet.http_reader_pdf({"snapshot": ["snap-" + "0" * 24], "source": [ed["id"]]})[2]["code"]
        ed2 = self.ed()
        codes["unsealed"] = hq_carnet.http_reader_pdf({"snapshot": [self.frozen_snapshot(ed2)], "source": [ed2["id"]]})[2]["code"]
        self.assertEqual(codes, {"differs": "differs_from_seal", "missing": "sealed_file_missing", "frozen": "frozen_unavailable", "unsealed": "no_sealed_file"})

    def test_read_only(self):
        ed, ref = self.ed_with_file()
        sid = self.frozen_snapshot(ed)
        before = tree_digest(self.tmp)
        self.fetch(one({"source_id": ed["id"], "context": self.ctx(sid)})["integrity"]["route"])
        self.assertEqual(tree_digest(self.tmp), before)


class LoaderTests(unittest.TestCase):
    def test_script_chain_is_balanced_and_loads_modal_and_reader_before_the_editor(self):
        text = (Path(__file__).resolve().parent.parent / "iphone_bridge.py").read_text(encoding="utf-8")
        block = text[text.index("const HQ_CARNET_SCRIPTS"):]
        block = block[: block.index("];")]
        pos = lambda n: block.index("'%s.js'" % n)
        self.assertEqual(block.count("["), 1, "one flat loader list (no nested chain to unbalance)")
        order = [pos(n) for n in ("hq-carnet-modal", "hq-carnet-reader", "hq-carnet-reader-ui", "hq-carnet")]
        self.assertEqual(order, sorted(order))
        order = [pos(n) for n in ("hq-carnet-media", "hq-carnet-sources", "hq-carnet-portals-ui", "hq-carnet")]
        self.assertEqual(order, sorted(order))
        self.assertLess(pos("hq-carnet-media"), pos("hq-carnet-eng"))
        for name in ("hq-carnet-modal", "hq-carnet-reader", "hq-carnet-reader-ui"):
            self.assertIn("'" + name + ".js'", block)


class ReportLineTests(RBase2):
    def build(self, page):
        import hq_carnet_report as report

        return report.build({"action": "report_build", "items": [{"kind": "note", "page_id": page["id"], "rev": self.cur(page["id"])["rev"]}]})["markdown"]

    def test_report_lists_each_citation_deterministically_and_without_judgement(self):
        ed = self.ed("Machinery")
        page = self.page_of(self.cite_block(ed, "clause", "304.1.2", 417, True), self.cite_block(ed, "page", "12", None, False))
        md = self.build(page)
        self.assertIn("  - Citation : Machinery", md)
        self.assertIn("Emplacement : Article / clause 304.1.2 ; Page PDF 417 ; Emplacement vérifié", md)
        self.assertIn("Emplacement : Page 12 ; Page PDF non renseignée ; Emplacement non vérifié", md)
        low = md.lower()
        for word in ("conforme", "valide", "correct", "fiable", "confirmé", "prouvé", "approuvé"):
            self.assertNotIn(word, low)
        self.assertEqual(md, self.build(page), "deterministic")

    def test_report_marks_archived_and_missing_editions_plainly(self):
        ed = self.ed("Old")
        sources.mutate({"action": "source_edition_archive", "id": ed["id"], "expected_rev": self.src_rev(ed), "archived": True})
        page = self.page_of(self.cite_block(ed, "page", "3", 9, True))
        self.assertIn("Statut : archivée", self.build(page))


if __name__ == "__main__":
    unittest.main()
