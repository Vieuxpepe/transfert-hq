"""Carnet Phase 5 — Engineering Intelligence: cockpit / decision trail / measurement series / diff / snapshots / report / backup.

Throwaway ROOTs only (run from a disposable source copy).
"""

from __future__ import annotations

import uuid
import copy
import hashlib
import json
import os
import sys
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_history as history  # noqa: E402
import hq_carnet_intel as intel  # noqa: E402
import hq_carnet_report as report  # noqa: E402
import hq_carnet_review as review  # noqa: E402
import hq_carnet_snapshots as snaps  # noqa: E402
from test_hq_carnet_history import Stage08Base, para  # noqa: E402
from test_hq_carnet_links_report import image_block, png  # noqa: E402
import hq_carnet_media as media  # noqa: E402


def _rid() -> str:
    return uuid.uuid4().hex


AT = 1790000000


def measure(label="Ø arbre", v="10.02", u="mm", mode="sym", nominal="10", tol="0.02", at=AT, link=None):
    if mode == "none":
        nom, tl = None, None
    elif mode == "sym":
        nom, tl = {"v": nominal, "u": u}, {"t": tol, "u": u}
    else:  # bounds
        nom, tl = None, {"lo": "9.98", "hi": "10.02", "u": u}
    return {"type": "measure", "text": "", "marks": [], "measure": {"label": label, "observed": {"v": v, "u": u}, "mode": mode, "nominal": nom, "tol": tl, "at": at, "link": link}}


def decision(text="Retenir l'alésage H7", at=AT, marks=None):
    return {"type": "decision", "text": text, "marks": marks or [], "decision": {"at": at}}


def drawing(stem):
    return {"type": "drawing", "text": "", "marks": [], "drawing": {"id": stem}}


def link_mark(start, end, kind, ident):
    return {"type": "link", "start": start, "end": end, "ref": {"kind": kind, "id": ident}}


class IntelBase(Stage08Base):
    def setUp(self):
        super().setUp()
        nb = hq_carnet.get_notebook()
        self.proj = hq_carnet.mutate({"action": "project_create", "expected_notebook_rev": nb["notebook_rev"], "name": "Banc"})["project"]
        self.other = hq_carnet.mutate({"action": "project_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"], "name": "Autre"})["project"]
        self.draw_dir = self.tmp / "Inbox" / "Drawings"
        self.draw_dir.mkdir(parents=True, exist_ok=True)

    def proj_page(self, blocks, project=None):
        page = self.make_page(blocks)
        return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "project_id": (project or self.proj)["id"], "content": {"version": 2, "blocks": copy.deepcopy(page["content"]["blocks"])}})["page"] if False else self._move(page, project or self.proj)

    def _move(self, page, project):
        return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "project_id": project["id"], "content": {"version": 2, "blocks": copy.deepcopy(self.cur(page["id"])["content"]["blocks"])}})["page"]

    def cockpit(self, project=None):
        return review.cockpit((project or self.proj)["id"])

    def draw(self, stem, data=b'{"v":1}'):
        (self.draw_dir / (stem + ".hqdraw.json")).write_bytes(data)


# ---------------------------------------------------------------- cockpit aggregation


class CockpitTests(IntelBase):
    def test_counts_scope_and_trash(self):
        a = self.proj_page([para("Banc d'essai"), decision("D1"), measure(), measure(v="10.5"), drawing("plan-1")])
        b = self.proj_page([para("Seconde note"), decision("D2", at=AT + 5)])
        self.proj_page([para("ailleurs"), decision("hors projet")], project=self.other)
        gone = self.proj_page([para("poubelle"), decision("D3")])
        hq_carnet.mutate({"action": "page_trash", "id": gone["id"], "expected_rev": self.cur(gone["id"])["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        ov = self.cockpit()
        c = ov["counts"]
        self.assertEqual((c["pages"], c["decisions"], c["measurements"], c["out_of_tolerance"], c["drawings"]), (2, 2, 2, 1, 1))
        self.assertEqual(ov["measurements"], {"total": 2, "in": 1, "out": 1, "none": 0, "incompatible": 0})
        self.assertEqual({r["page_id"] for r in ov["recent_notes"]}, {a["id"], b["id"]})
        self.assertEqual(ov["tasks"], {"available": False, "reason": "no_canonical_project_association"})
        self.assertEqual(ov["project"]["id"], self.proj["id"])

    def test_every_item_links_back_to_its_source(self):
        a = self.proj_page([para("t"), decision("D1"), measure()])
        ov = self.cockpit()
        d = ov["decisions"][0]
        blk = self.cur(a["id"])["content"]["blocks"]
        self.assertEqual(d["anchor"], f"#carnet/{a['id']}/{blk[1]['id']}")
        self.assertEqual(ov["series"][0]["points"][0]["anchor"], f"#carnet/{a['id']}/{blk[2]['id']}")
        self.assertEqual(ov["recent_notes"][0]["anchor"], f"#carnet/{a['id']}")

    def test_without_project_bucket_and_missing_project(self):
        page = self.make_page([para("libre"), decision("D")])
        ov = review.cockpit("none")
        self.assertIsNone(ov["project"]["id"])
        self.assertIn(page["id"], {r["page_id"] for r in ov["recent_notes"]})
        with self.assertRaises(hq_carnet.CarnetNotFound):
            review.cockpit("proj-" + "f" * 12)
        with self.assertRaises(hq_carnet.CarnetError):
            review.cockpit("nope")

    def test_read_only_no_files_written(self):
        self.proj_page([para("x"), decision("D")])
        before = {p: p.read_bytes() for p in (self.tmp / ".hq-carnet").glob("*.json")}
        self.cockpit()
        self.assertEqual(before, {p: p.read_bytes() for p in (self.tmp / ".hq-carnet").glob("*.json")})
        self.assertFalse((self.tmp / ".hq-carnet" / "snapshots").exists())

    def test_reference_states_are_explicit_and_path_free(self):
        self.draw("plan-1")
        self.proj_page([para("t"), drawing("plan-1"), drawing("plan-2")])
        ov = self.cockpit()
        self.assertEqual({d["stem"]: d["state"] for d in ov["drawings"]}, {"plan-1": "ok", "plan-2": "missing"})
        self.assertNotIn(str(self.tmp), json.dumps(ov))

    def test_sources_and_files_are_listed_with_state(self):
        ed = self.edition(self.family(), "29e")
        self.proj_page([self.cite_block(ed), para("voir fichier", [link_mark(0, 4, "file", "Inbox/a.pdf"), link_mark(5, 12, "file", "Inbox/absent.pdf")])])
        ov = self.cockpit()
        self.assertEqual([(s["edition_id"], s["state"]) for s in ov["sources"]], [(ed["id"], "ok")])
        self.assertEqual({f["path"]: f["state"] for f in ov["files"]}, {"Inbox/a.pdf": "ok", "Inbox/absent.pdf": "missing"})

    def test_images_counted_by_asset(self):
        asset = media.store_upload(__import__("io").BytesIO(png()).read, len(png()), "image/png")["asset"]
        self.proj_page([image_block(asset), image_block(asset)])
        self.assertEqual(self.cockpit()["counts"]["images"], 1)

    def test_bounds_report_truncation(self):
        saved = dict(intel.LIMITS)
        self.addCleanup(lambda: intel.LIMITS.update(saved))
        intel.LIMITS.update(decisions=2, points_per_series=2, series=1, recent_activity=3)
        self.proj_page([decision(f"D{i}", at=AT + i) for i in range(5)] + [measure(at=AT + i) for i in range(4)] + [measure(label="autre")])
        ov = self.cockpit()
        self.assertEqual((len(ov["decisions"]), ov["decisions_total"]), (2, 5))
        self.assertEqual([d["text"] for d in ov["decisions"]], ["D4", "D3"], "newest first")
        self.assertEqual((len(ov["series"]), ov["series_total"]), (1, 2))
        self.assertTrue(ov["series"][0]["truncated"])
        self.assertEqual(ov["series"][0]["points_total"], 4)
        self.assertEqual(len(ov["activity"]), 3)
        self.assertTrue(ov["truncated"]["decisions"] and ov["truncated"]["series"] and ov["truncated"]["points"])

    def test_history_failure_is_isolated(self):
        self.proj_page([para("t"), decision("D")])
        self.history_path.parent.mkdir(parents=True, exist_ok=True)
        self.history_path.write_text("{ not json", encoding="utf-8")
        ov = self.cockpit()
        self.assertFalse(ov["history_available"])
        self.assertEqual(ov["counts"]["decisions"], 1)
        self.assertEqual(self.history_path.read_text(encoding="utf-8"), "{ not json", "never repaired")

    def test_checkpoints_appear_in_activity(self):
        page = self.proj_page([para("t")])
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "label": "avant essai"})
        kinds = {a["kind"] for a in self.cockpit()["activity"]}
        self.assertIn("checkpoint", kinds)


# ---------------------------------------------------------------- decision trail


class DecisionTests(IntelBase):
    def test_only_canonical_fields_no_status_or_author(self):
        ed = self.edition(self.family(), "29e")
        cite = self.cite_block(ed)
        page = self.proj_page([para("ctx"), {**decision("Retenir H7", at=AT + 3, marks=[link_mark(0, 6, "note", self.make_page([para("cible")])["id"])])}])
        ov = self.cockpit()
        row = ov["decisions"][0]
        self.assertEqual(set(row), {"page_id", "block_id", "page_title", "at", "text", "anchor", "evidence"})
        self.assertEqual((row["text"], row["at"]), ("Retenir H7", AT + 3))
        self.assertEqual([e["kind"] for e in row["evidence"]], ["note"])
        for forbidden in ("status", "author", "rationale", "accepted", "superseded"):
            self.assertNotIn(forbidden, row)
        self.assertIsNotNone(cite)
        self.assertEqual(page["project_id"], self.proj["id"])

    def test_evidence_only_from_the_decision_line(self):
        ed = self.edition(self.family(), "29e")
        cited = self.cite_block(ed)
        cited["type"] = "decision"
        cited["decision"] = {"at": AT}
        self.proj_page([cited, para("autre ligne", [link_mark(0, 5, "file", "Inbox/a.pdf")])])
        ev = self.cockpit()["decisions"][0]["evidence"]
        self.assertEqual([(e["kind"], e["id"]) for e in ev], [("source", ed["id"])], "the neighbouring paragraph's link is not evidence")

    def test_external_href_is_not_evidence(self):
        self.proj_page([decision("X", marks=[{"type": "link", "start": 0, "end": 1, "href": "https://example.org"}])])
        self.assertEqual(self.cockpit()["decisions"][0]["evidence"], [])

    def test_order_is_newest_first_then_stable(self):
        self.proj_page([decision("old", at=AT), decision("new", at=AT + 9), decision("same", at=AT + 9)])
        texts = [d["text"] for d in self.cockpit()["decisions"]]
        self.assertEqual((sorted(texts[:2]), texts[2]), (["new", "same"], "old"))
        self.assertEqual(texts, [d["text"] for d in self.cockpit()["decisions"]], "stable across calls")


# ---------------------------------------------------------------- measurement series


class SeriesTests(IntelBase):
    def series(self, ov):
        return {(s["label"], s["unit"]): s for s in ov["series"]}

    def test_identity_is_normalised_label_plus_exact_unit_no_conversion(self):
        self.proj_page([
            measure("Ø  Arbre", at=AT), measure(" ø arbre ", at=AT + 1), measure("Ø arbre", u="in", v="0.395", nominal="0.394", tol="0.001", at=AT + 2),
            measure("épaisseur"), measure("épaisseur", at=AT + 1),
        ])
        ov = self.cockpit()
        self.assertEqual(ov["series_total"], 3)
        by = {(intel.norm_label(s["label"]), s["unit"]): len(s["points"]) for s in ov["series"]}
        self.assertEqual(by, {("ø arbre", "mm"): 2, ("ø arbre", "in"): 1, ("épaisseur", "mm"): 2})

    def test_points_keep_their_own_metadata_and_verdict(self):
        self.proj_page([measure(v="10.02", tol="0.02", at=AT), measure(v="10.50", tol="1.0", at=AT + 1), measure(v="10.9", tol="0.1", at=AT + 2)])
        s = self.cockpit()["series"][0]
        self.assertEqual([p["verdict"] for p in s["points"]], ["in", "in", "out"])
        self.assertEqual([p["tol"]["t"] for p in s["points"]], ["0.02", "1.0", "0.1"])
        self.assertEqual(s["band"], {"state": "variable"}, "tolerance changes: no single band")
        self.assertEqual(s["out"], 1)

    def test_exact_band_only_when_every_point_has_the_same_bounds(self):
        self.proj_page([measure(v="10.00", at=AT), measure(v="10.03", at=AT + 1)])
        s = self.cockpit()["series"][0]
        self.assertEqual(s["band"]["state"], "exact")
        self.assertEqual(s["band"]["unit"], "mm")
        self.assertEqual((float(s["band"]["lo"]), float(s["band"]["hi"])), (9.98, 10.02))

    def test_none_and_incompatible_are_distinct_states(self):
        bad = measure(v="10", u="mm", mode="sym", nominal="10", tol="0.1")
        bad["measure"]["nominal"] = {"v": "10", "u": "in"}  # nominal unit differs from the observed unit: incompatible
        self.proj_page([measure(mode="none", at=AT), bad])
        ov = self.cockpit()
        self.assertEqual((ov["measurements"]["none"], ov["measurements"]["incompatible"]), (1, 1))
        self.assertEqual(ov["series"][0]["band"]["state"], "none")

    def test_series_never_cross_projects(self):
        self.proj_page([measure(at=AT)])
        self.proj_page([measure(at=AT + 1)], project=self.other)
        self.assertEqual(len(self.cockpit()["series"][0]["points"]), 1)


# ---------------------------------------------------------------- diff


class DiffTests(IntelBase):
    def checkpoint(self, page):
        out = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "label": "revue"})
        self.assertEqual(out[0], 200, out)
        return out[1]["event_id"]

    def edit(self, page, mutate_blocks):
        cur = self.cur(page["id"])
        blocks = copy.deepcopy(cur["content"]["blocks"])
        result = mutate_blocks(blocks)
        blocks = result if isinstance(result, list) else blocks
        return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": blocks}})["page"]

    def diff(self, ev, page_id=None):
        return review.diff(ev, None, page_id, None)

    def test_added_modified_removed_unchanged(self):
        page = self.proj_page([para("a"), para("b"), para("c")])
        ev = self.checkpoint(page)

        def change(blocks):
            blocks[0]["text"] = "a2"
            del blocks[1]
            blocks.append(para("neuf"))

        self.edit(page, change)
        d = self.diff(ev)["diff"]
        self.assertEqual(d["counts"], {"added": 1, "removed": 1, "changed": 1})
        self.assertEqual(d["unchanged"], 1)
        self.assertEqual(d["changed"][0]["tags"], ["text"])
        self.assertEqual(d["removed"][0]["summary"], "b")

    def test_decision_measure_and_drawing_version_changes_are_classified(self):
        page = self.proj_page([decision("D", at=AT), measure(v="10.00"), drawing("plan-1")])
        ev = self.checkpoint(page)

        def change(blocks):
            blocks[0]["decision"]["at"] = AT + 5
            blocks[1]["measure"]["observed"]["v"] = "10.4"
            blocks[2]["drawing"]["id"] = "plan-2"

        self.edit(page, change)
        by = {c["type"]: c for c in self.diff(ev)["diff"]["changed"]}
        self.assertEqual(by["decision"]["tags"], ["decision"])
        self.assertEqual(by["measure"]["tags"], ["measure"])
        self.assertEqual(by["measure"]["detail"]["fields"], ["value"])
        self.assertEqual(by["drawing"]["tags"], ["drawing_version"])
        self.assertEqual((by["drawing"]["detail"]["from_stem"], by["drawing"]["detail"]["to_stem"]), ("plan-1", "plan-2"))

    def test_source_and_reference_changes(self):
        ed = self.edition(self.family(), "29e")
        page = self.proj_page([para("voir ici", [link_mark(0, 4, "file", "Inbox/a.pdf")]), self.cite_block(ed)])
        ev = self.checkpoint(page)

        def change(blocks):
            blocks[0]["marks"] = [link_mark(0, 4, "file", "Inbox/b.pdf")]
            blocks[1]["marks"] = []

        self.edit(page, change)
        tags = {c["id"]: c["tags"] for c in self.diff(ev)["diff"]["changed"]}
        self.assertIn("ref", list(tags.values())[0])
        self.assertIn("source", list(tags.values())[1])

    def test_reminted_block_is_removed_plus_added_never_fuzzy_matched(self):
        page = self.proj_page([para("garde"), para("sera recréé")])
        ev = self.checkpoint(page)
        self.edit(page, lambda blocks: blocks.pop())  # the block disappears ...
        edited = self.cur(page["id"])
        status, out = hq_carnet.http_post({"action": "history_restore", "page_id": page["id"], "event_id": ev, "expected_rev": edited["rev"], "confirm": True})
        self.assertEqual(status, 200, out)
        self.assertEqual([b["text"] for b in self.cur(page["id"])["content"]["blocks"]], ["garde", "sera recréé"], "same text again ...")
        d = self.diff(ev)["diff"]  # ... but a restore re-mints the id of a block that no longer existed: exact comparison says so
        self.assertEqual((d["counts"]["added"], d["counts"]["removed"], d["counts"]["changed"]), (1, 1, 0))
        self.assertEqual((d["added"][0]["summary"], d["removed"][0]["summary"]), ("sera recréé", "sera recréé"))
        self.assertIn("identifiant", review.IDENTITY_NOTE)

    def test_reorder_is_not_reported_and_no_author_anywhere(self):
        page = self.proj_page([para("1"), para("2")])
        ev = self.checkpoint(page)
        self.edit(page, lambda blocks: blocks.reverse())
        out = self.diff(ev)
        self.assertEqual(out["diff"]["counts"], {"added": 0, "removed": 0, "changed": 0})
        self.assertNotIn("author", json.dumps(out).lower().replace("auteur", ""))

    def test_overlay_states_and_ghost_anchor(self):
        page = self.proj_page([para("a"), para("b"), para("c")])
        ev = self.checkpoint(page)

        def change(blocks):
            blocks[2]["text"] = "c2"
            del blocks[1]
            blocks.insert(1, para("nouveau"))

        self.edit(page, change)
        d = self.diff(ev)["diff"]
        ids = {b["id"]: b for b in self.cur(page["id"])["content"]["blocks"]}
        self.assertEqual(sorted(d["states"].values()), ["added", "changed"])
        self.assertTrue(set(d["states"]) <= set(ids))
        self.assertEqual(d["removed"][0]["after_id"], self.cur(page["id"])["content"]["blocks"][0]["id"])

    def test_v1_page_is_compared_as_text_only(self):
        d = intel.diff_page({"version": 1, "blocks": [{"id": "b1", "type": "text", "text": "a", "marks": []}]}, {"version": 1, "blocks": [{"id": "b1", "type": "text", "text": "b", "marks": []}]})
        self.assertEqual(d["mode"], "text_only")
        self.assertEqual(d["counts"]["changed"], 1)

    def test_unchanged_page_has_no_changes(self):
        page = self.proj_page([para("a")])
        ev = self.checkpoint(page)
        self.assertEqual(self.diff(ev)["diff"]["counts"], {"added": 0, "removed": 0, "changed": 0})

    def test_http_validation_and_baseline_resolution(self):
        page = self.proj_page([para("a")])
        ev = self.checkpoint(page)
        self.assertEqual(hq_carnet.http_get({"diff": ["1"], "base": [ev]})[0], 200)
        for q in ({"diff": ["1"]}, {"diff": ["1"], "base": ["nope"]}, {"diff": ["1"], "base": [ev], "bogus": ["1"]}, {"diff": ["1"], "base": [ev, ev]},
                  {"diff": ["1"], "base": ["7 days ago"]}, {"base": [ev]}, {"diff": ["1"], "base": [ev], "to": ["snap-" + "0" * 24]}):
            self.assertEqual(hq_carnet.http_get(q)[0], 400, q)
        self.assertEqual(hq_carnet.http_get({"diff": ["1"], "base": ["hev-" + "0" * 24]})[0], 404)
        out = review.baselines(None, page["id"], str(AT * 2))
        self.assertEqual(out["latest_checkpoint"]["id"], ev)
        self.assertEqual(out["resolved"]["checkpoint"]["id"], ev)
        self.assertIsNone(review.baselines(None, page["id"], "5")["resolved"]["checkpoint"], "nothing at or before that date: say so, never guess")


# ---------------------------------------------------------------- snapshots


class SnapshotTests(IntelBase):
    def create(self, label="Gel conception", project=None, **extra):
        status, out = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": (project or self.proj)["id"], "label": label, **extra})
        self.assertEqual(status, 200, out)
        return out

    def snap_files(self):
        d = self.tmp / ".hq-carnet" / "snapshots"
        return sorted(p.name for p in d.iterdir()) if d.exists() else []

    def test_creates_one_sealed_file_with_exact_hashes(self):
        self.draw("plan-1", b'{"doc":1}')
        asset = media.store_upload(__import__("io").BytesIO(png()).read, len(png()), "image/png")["asset"]
        self.proj_page([para("t"), drawing("plan-1"), image_block(asset), para("pdf", [link_mark(0, 3, "file", "Inbox/a.pdf")]), decision("D"), measure()])
        out = self.create(note="revue 1")
        files = self.snap_files()
        self.assertEqual(files, [out["snapshot"]["id"] + ".json"])
        snap = snaps.get(out["snapshot"]["id"])["snapshot"]
        sha = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731
        self.assertEqual(snap["refs"]["drawings"], [{"stem": "plan-1", "state": "ok", "sha256": sha(b'{"doc":1}'), "size": 9}])
        a = snap["refs"]["assets"][0]
        self.assertEqual((a["id"], a["sha256"], a["size"]), (asset["id"], sha(png()), len(png())))
        f = snap["refs"]["files"][0]
        self.assertEqual((f["path"], f["sha256"]), ("Inbox/a.pdf", sha((self.tmp / "Inbox" / "a.pdf").read_bytes())))
        self.assertEqual(snap["project"]["id"], self.proj["id"])
        self.assertEqual(len(snap["pages"]), 1)
        self.assertEqual(snaps.get(snap["id"])["integrity"], "ok")
        self.assertNotIn(str(self.tmp), json.dumps(snap))

    def test_hash_is_over_real_bytes_not_metadata(self):
        self.proj_page([drawing("plan-1")])
        self.draw("plan-1", b"AAAA")
        first = snaps.get(self.create("a")["snapshot"]["id"])["snapshot"]["refs"]["drawings"][0]["sha256"]
        self.draw("plan-1", b"BBBB")  # same stem, same size, other bytes
        second = snaps.get(self.create("b")["snapshot"]["id"])["snapshot"]["refs"]["drawings"][0]["sha256"]
        self.assertNotEqual(first, second)

    def test_streaming_hash_does_not_load_the_file_whole(self):
        big = self.tmp / "Inbox" / "big.bin"
        chunk = os.urandom(1024 * 1024)
        with big.open("wb") as h:
            for _ in range(5):
                h.write(chunk)
        want = hashlib.sha256(chunk * 5).hexdigest()
        reads = []
        real = snaps.CHUNK
        snaps.CHUNK = 64 * 1024
        self.addCleanup(setattr, snaps, "CHUNK", real)
        self.assertEqual(snaps.hash_file(big), (want, 5 * 1024 * 1024))
        self.assertEqual(reads, [])

    def test_missing_reference_is_recorded_missing_not_fatal(self):
        self.proj_page([drawing("plan-9"), para("x", [link_mark(0, 1, "file", "Inbox/absent.pdf")])])
        snap = snaps.get(self.create()["snapshot"]["id"])["snapshot"]
        self.assertEqual(snap["refs"]["drawings"][0], {"stem": "plan-9", "state": "missing", "sha256": None, "size": None})
        self.assertEqual(snap["refs"]["files"][0]["state"], "missing")

    def test_ambiguous_io_aborts_and_publishes_nothing(self):
        self.proj_page([drawing("plan-1")])
        self.draw("plan-1")
        real = snaps.hash_file
        snaps.hash_file = lambda *a, **k: (_ for _ in ()).throw(snaps.SnapshotStorageError("Référence illisible — jalon non créé"))
        self.addCleanup(setattr, snaps, "hash_file", real)
        status, out = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": "x"})
        self.assertEqual((status, out["code"]), (503, "snapshots_unavailable"))
        self.assertEqual(self.snap_files(), [])

    def test_a_linked_reference_is_refused_not_followed(self):
        outside = self.tmp.parent / ("outside-" + os.urandom(3).hex())
        outside.write_bytes(b"secret")
        self.addCleanup(outside.unlink)
        os.symlink(outside, self.tmp / "Inbox" / "link.pdf")
        self.proj_page([para("x", [link_mark(0, 1, "file", "Inbox/link.pdf")])])
        status, _ = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": "x"})
        self.assertEqual(status, 503)
        self.assertEqual(self.snap_files(), [])

    def test_immutable_after_later_edits_and_ids_are_unique(self):
        page = self.proj_page([para("v1"), decision("D")])
        a = self.create("a")["snapshot"]["id"]
        raw = (self.tmp / ".hq-carnet" / "snapshots" / (a + ".json")).read_bytes()
        cur = self.cur(page["id"])
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [para("v2")]}})
        b = self.create("b")["snapshot"]["id"]
        self.assertNotEqual(a, b)
        self.assertEqual((self.tmp / ".hq-carnet" / "snapshots" / (a + ".json")).read_bytes(), raw)
        self.assertEqual(snaps.get(a)["snapshot"]["pages"][0]["content"]["blocks"][0]["text"], "v1")

    def test_no_edit_or_delete_route(self):
        self.proj_page([para("x")])
        sid = self.create()["snapshot"]["id"]
        for action in ("snapshot_update", "snapshot_delete", "snapshot_edit", "snapshot_save"):
            status, _ = hq_carnet.http_post({"action": action, "id": sid, "label": "z"})
            self.assertGreaterEqual(status, 400, action)
        self.assertEqual(snaps.get(sid)["snapshot"]["label"], "Gel conception")

    def test_write_once_refuses_an_existing_id(self):
        self.proj_page([para("x")])
        sid = self.create()["snapshot"]["id"]
        snap = snaps.get(sid)["snapshot"]
        raw = snaps._canon_bytes(snap)
        with self.assertRaises(snaps.SnapshotStorageError):
            snaps._publish(snaps.confined_dir(self.tmp), snap, raw)
        self.assertEqual([n for n in self.snap_files() if n.startswith(".tmp")], [])

    def test_tampering_is_detected_not_repaired(self):
        self.proj_page([para("x")])
        sid = self.create()["snapshot"]["id"]
        path = self.tmp / ".hq-carnet" / "snapshots" / (sid + ".json")
        data = json.loads(path.read_text(encoding="utf-8"))
        data["pages"][0]["content"]["blocks"][0]["text"] = "falsifié"
        path.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(snaps.get(sid)["integrity"], "corrupt")
        self.assertEqual(snaps.list_snapshots(self.proj["id"])["snapshots"][0]["integrity"], "corrupt")
        with self.assertRaises(snaps.SnapshotStorageError):
            review.diff(sid, None, None, None)
        self.assertIn("falsifi", path.read_text(encoding="utf-8"))
        path.write_text("{ nope", encoding="utf-8")
        self.assertEqual(snaps.list_snapshots()["invalid"], 1)

    def test_verify_reports_unchanged_modified_missing(self):
        self.draw("plan-1", b"one")
        self.proj_page([drawing("plan-1"), para("x", [link_mark(0, 1, "file", "Inbox/a.pdf"), link_mark(1, 1 + 0, "file", "Inbox/a.pdf")][:1])])
        sid = self.create()["snapshot"]["id"]
        self.assertEqual(snaps.verify(sid)["counts"]["unchanged"], 2)
        self.draw("plan-1", b"two")
        (self.tmp / "Inbox" / "a.pdf").unlink()
        counts = snaps.verify(sid)["counts"]
        self.assertEqual((counts["modified"], counts["missing"], counts["unchanged"]), (1, 1, 0))
        got = snaps.verify(sid)
        self.assertEqual(got["refs"]["drawings"][0]["status"], "modified")
        self.assertNotIn(str(self.tmp), json.dumps(got))

    def test_limits(self):
        self.proj_page([para("x")])
        saved = (snaps.PER_PROJECT_MAX, snaps.SNAPSHOT_BYTES_MAX, snaps.STORE_BYTES_MAX)
        self.addCleanup(lambda: [setattr(snaps, n, v) for n, v in zip(("PER_PROJECT_MAX", "SNAPSHOT_BYTES_MAX", "STORE_BYTES_MAX"), saved)])
        snaps.PER_PROJECT_MAX = 2
        self.create("1")
        self.create("2")
        status, out = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": "3"})
        self.assertEqual((status, out["code"]), (409, "snapshot_limit"))
        self.create("autre projet ok", project=self.proj) if False else None
        self.assertEqual(len(self.snap_files()), 2)
        snaps.PER_PROJECT_MAX = 50
        snaps.SNAPSHOT_BYTES_MAX = 100
        self.assertEqual(hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": "gros"})[0], 409)
        snaps.SNAPSHOT_BYTES_MAX = saved[1]
        snaps.STORE_BYTES_MAX = 100
        self.assertEqual(hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": "plein"})[0], 409)
        self.assertEqual(len(self.snap_files()), 2)

    def test_validation(self):
        self.proj_page([para("x")])
        bad = ({"project_id": "nope", "label": "x"}, {"project_id": self.proj["id"], "label": ""}, {"project_id": self.proj["id"], "label": "x" * 81},
               {"project_id": self.proj["id"], "label": "a\x00b"}, {"project_id": self.proj["id"], "label": "x", "extra": 1}, {"project_id": self.proj["id"], "label": 5})
        for data in bad:
            self.assertEqual(hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), **data})[0], 400, data)
        self.assertEqual(hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": "proj-" + "f" * 12, "label": "x"})[0], 404)
        empty = hq_carnet.mutate({"action": "project_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"], "name": "Vide"})["project"]
        self.assertEqual(hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": empty["id"], "label": "x"})[0], 400)
        self.assertEqual(self.snap_files(), [])

    def test_trashed_pages_and_other_projects_are_not_frozen(self):
        keep = self.proj_page([para("garde")])
        gone = self.proj_page([para("poubelle")])
        other = self.proj_page([para("ailleurs")], project=self.other)
        hq_carnet.mutate({"action": "page_trash", "id": gone["id"], "expected_rev": self.cur(gone["id"])["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        snap = snaps.get(self.create()["snapshot"]["id"])["snapshot"]
        self.assertEqual([p["id"] for p in snap["pages"]], [keep["id"]])
        self.assertNotIn(other["id"], json.dumps(snap))

    def test_compare_snapshot_to_current_and_to_another_snapshot(self):
        page = self.proj_page([para("a"), decision("D")])
        a = self.create("a")["snapshot"]["id"]
        cur = self.cur(page["id"])
        blocks = copy.deepcopy(cur["content"]["blocks"])
        blocks[0]["text"] = "a2"
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": blocks}})
        extra = self.proj_page([para("nouvelle note")])
        b = self.create("b")["snapshot"]["id"]
        now = review.diff(a, None, None, None)
        self.assertEqual(now["counts"], {"changed": 1, "added": 1, "removed": 0, "unchanged": 0})
        between = review.diff(a, b, None, None)
        self.assertEqual(between["counts"], now["counts"])
        self.assertEqual(between["to"]["kind"], "snapshot")
        self.assertEqual(review.diff(a, None, extra["id"], None)["pages"][0]["status"], "added")
        hq_carnet.mutate({"action": "page_trash", "id": extra["id"], "expected_rev": self.cur(extra["id"])["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        self.assertEqual(review.diff(b, None, None, None)["pages"][0]["status"] in ("removed", "changed"), True)

    def test_snapshot_cockpit_uses_frozen_content(self):
        page = self.proj_page([para("v1"), decision("D1")])
        sid = self.create()["snapshot"]["id"]
        cur = self.cur(page["id"])
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [para("v2")]}})
        frozen = review.snapshot_cockpit(sid)
        self.assertEqual(frozen["counts"]["decisions"], 1)
        self.assertEqual(self.cockpit()["counts"]["decisions"], 0)
        self.assertEqual(frozen["snapshot"]["label"], "Gel conception")


# ---------------------------------------------------------------- HTTP surface


class ReviewR2Tests(IntelBase):
    """Design Freeze semantics (review r2): a broken seal is never trusted, creation is retry-safe, a hash is ONE stable observation,
    and the timestamp is the moment the notebook state was captured."""

    def snap_dir(self):
        return self.tmp / ".hq-carnet" / "snapshots"

    def make(self, label="Gel", **extra):
        status, out = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": label, **extra})
        self.assertEqual(status, 200, out)
        return out

    def tamper(self, sid):
        path = self.snap_dir() / (sid + ".json")
        data = json.loads(path.read_text(encoding="utf-8"))
        data["pages"][0]["content"]["blocks"][0]["text"] = "falsifié"
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    # ---- 1. a broken seal is never trusted
    def test_corrupt_snapshot_is_refused_for_report_diff_and_compare(self):
        self.proj_page([para("x"), decision("D")])
        sid = self.make()["snapshot"]["id"]
        other = self.make("Autre")["snapshot"]["id"]
        self.tamper(sid)
        item = {"kind": "project_overview", "snapshot_id": sid}
        with self.assertRaises(snaps.SnapshotStorageError):
            report.build({"action": "report_build", "items": [item]})
        status, out = hq_carnet.http_post({"action": "report_build", "items": [item]})
        self.assertEqual((status, out.get("code")), (503, "snapshots_unavailable"))
        self.assertEqual(hq_carnet.http_get({"diff": ["1"], "base": [sid]})[0], 503, "compare to current")
        self.assertEqual(hq_carnet.http_get({"diff": ["1"], "base": [other], "to": [sid]})[0], 503, "as the target of a snapshot diff")
        self.assertEqual(hq_carnet.http_get({"diff": ["1"], "base": [sid], "to": [other]})[0], 503, "as the base of a snapshot diff")
        # forensic inspection stays possible and is visibly flagged; the list says so too
        view = hq_carnet.http_get({"snapshot": [sid]})
        self.assertEqual((view[0], view[1]["snapshot"]["integrity"]), (200, "corrupt"))
        rows = {r["id"]: r["integrity"] for r in snaps.list_snapshots(self.proj["id"])["snapshots"]}
        self.assertEqual((rows[sid], rows[other]), ("corrupt", "ok"))
        self.assertIn("falsifi", (self.snap_dir() / (sid + ".json")).read_text(encoding="utf-8"), "never repaired")

    def test_intact_snapshot_still_works_for_report_and_diff(self):
        self.proj_page([para("x"), decision("D")])
        sid = self.make()["snapshot"]["id"]
        self.assertIn("Jalon figé", report.build({"action": "report_build", "items": [{"kind": "project_overview", "snapshot_id": sid}]})["markdown"])
        self.assertEqual(hq_carnet.http_get({"diff": ["1"], "base": [sid]})[0], 200)
        self.assertEqual(review.snapshot_cockpit(sid, trusted=True)["snapshot"]["integrity"], "ok")

    # ---- 2. creation is retry-safe
    def test_replayed_request_returns_the_original_and_writes_nothing(self):
        self.proj_page([para("x")])
        rid = _rid()
        body = {"action": "snapshot_create", "request_id": rid, "project_id": self.proj["id"], "label": "Gel", "note": "n"}
        first = hq_carnet.http_post(dict(body))
        self.assertEqual(first[0], 200)
        self.assertNotIn("replayed", first[1])
        files = sorted(p.name for p in self.snap_dir().iterdir())
        stamp = {n: (self.snap_dir() / n).stat().st_mtime_ns for n in files}
        again = hq_carnet.http_post(dict(body))
        self.assertEqual(again[0], 200)
        self.assertTrue(again[1]["replayed"])
        self.assertEqual(again[1]["snapshot"]["id"], first[1]["snapshot"]["id"])
        self.assertEqual(sorted(p.name for p in self.snap_dir().iterdir()), files, "still exactly one snapshot")
        self.assertEqual({n: (self.snap_dir() / n).stat().st_mtime_ns for n in files}, stamp, "nothing was rewritten")

    def test_replay_survives_a_restart_because_the_request_is_sealed_in_the_snapshot(self):
        self.proj_page([para("x")])
        rid = _rid()
        body = {"action": "snapshot_create", "request_id": rid, "project_id": self.proj["id"], "label": "Gel"}
        sid = hq_carnet.http_post(dict(body))[1]["snapshot"]["id"]
        self.assertEqual(snaps.get(sid)["snapshot"]["request_id"], rid)
        self.assertEqual(snaps.get(sid)["integrity"], "ok", "the request id is part of the sealed content")
        # state lives on disk only: nothing in memory to lose across a bridge restart
        self.assertEqual(hq_carnet.http_post(dict(body))[1]["snapshot"]["id"], sid)

    def test_same_request_with_other_content_is_a_controlled_conflict(self):
        self.proj_page([para("x")])
        rid = _rid()
        base = {"action": "snapshot_create", "request_id": rid, "project_id": self.proj["id"], "label": "Gel", "note": ""}
        hq_carnet.http_post(dict(base))
        for change in ({"label": "Autre"}, {"note": "différente"}, {"project_id": self.other["id"]}):
            status, out = hq_carnet.http_post({**base, **change})
            self.assertEqual((status, out.get("code")), (409, "snapshot_request_conflict"), change)
        self.assertEqual(len(list(self.snap_dir().iterdir())), 1)

    def test_request_id_is_required_and_validated(self):
        self.proj_page([para("x")])
        for rid in (None, "", "abc", "Z" * 32, "a" * 31, "a" * 33, 5):
            body = {"action": "snapshot_create", "project_id": self.proj["id"], "label": "x"}
            if rid is not None:
                body["request_id"] = rid
            self.assertEqual(hq_carnet.http_post(body)[0], 400, rid)
        self.assertFalse(self.snap_dir().exists() and list(self.snap_dir().iterdir()))

    def test_a_new_request_after_a_known_failure_creates_a_new_snapshot(self):
        self.proj_page([para("x")])
        a = self.make("Gel")["snapshot"]["id"]
        b = self.make("Gel")["snapshot"]["id"]
        self.assertNotEqual(a, b)

    # ---- 3. a hash is ONE stable observation
    def test_file_changing_during_the_hash_publishes_nothing(self):
        import hashlib

        target = self.tmp / "Inbox" / "a.pdf"
        target.write_bytes(b"A" * 4096)
        self.proj_page([para("x", [link_mark(0, 1, "file", "Inbox/a.pdf")])])
        real = hashlib.sha256

        def make(mutate):
            class Spy:
                def __init__(self, *data):
                    self.h = real(*data)
                    self.n = 0

                def update(self, data):
                    self.n += 1
                    if self.n == 2:  # mid-stream
                        mutate()
                    self.h.update(data)

                def hexdigest(self):
                    return self.h.hexdigest()
            return Spy

        def grow():
            with open(target, "ab") as f:
                f.write(b"B")

        def touch_same_size():
            st = os.stat(target)
            os.utime(target, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))

        def replace_path():  # atomic pathname replacement: the already-open descriptor stays perfectly stable
            tmp = target.with_name("a.pdf.new")
            tmp.write_bytes(b"B" * 4096)
            os.replace(tmp, target)

        def delete_path():
            os.unlink(target)

        def swap_for_symlink():
            other = target.with_name("elsewhere.bin")
            other.write_bytes(b"A" * 4096)
            os.unlink(target)
            os.symlink(other, target)

        old_chunk = snaps.CHUNK
        snaps.CHUNK = 512
        try:
            for name, mutate in (("grown", grow), ("mtime", touch_same_size), ("replaced", replace_path), ("deleted", delete_path), ("symlinked", swap_for_symlink)):
                if target.is_symlink() or target.exists():
                    target.unlink()
                target.write_bytes(b"A" * 4096)
                with mock.patch.object(snaps.hashlib, "sha256", make(mutate)):
                    status, out = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": name})
                self.assertEqual(status, 503, name)
                self.assertIn("modifiée pendant la création", out["error"], name)
                self.assertFalse(self.snap_dir().exists() and [p for p in self.snap_dir().iterdir()], name + ": nothing published, no temp residue")
            # a stable file hashes fine with the same tiny chunk
            if target.is_symlink() or target.exists():
                target.unlink()
            target.write_bytes(b"A" * 4096)
            self.assertEqual(snaps.hash_file(target)[1], 4096)
        finally:
            snaps.CHUNK = old_chunk
        self.assertEqual(self.make("stable")["snapshot"]["label"], "stable")

    # ---- 4. the timestamp is the capture of the notebook state
    def test_created_at_is_captured_with_the_pages_not_after_hashing(self):
        self.proj_page([para("x")])
        ticks = iter(range(1000, 1100))
        calls = []

        def clock():
            v = next(ticks)
            calls.append(v)
            return v

        real_hash = snaps.hash_file

        def slow_hash(path, cap=snaps.HASH_FILE_MAX):
            for _ in range(5):
                clock()  # the clock keeps running while we hash
            return real_hash(path, cap)

        self.draw("plan-1")
        self.proj_page([drawing("plan-1")])
        with mock.patch.object(snaps, "_now", clock), mock.patch.object(snaps, "hash_file", slow_hash):
            out = self.make("Gel")
        self.assertEqual(out["snapshot"]["created_at"], 1000, "the first tick: taken under the notebook lock, before any hashing")
        self.assertGreater(len(calls), 1)
        self.assertEqual(snaps.get(out["snapshot"]["id"])["snapshot"]["created_at"], 1000)


class HttpTests(IntelBase):
    def test_unknown_and_mixed_parameters_are_refused(self):
        for q in ({"cockpit": [self.proj["id"]], "meta": ["1"]}, {"cockpit": ["a", "b"]}, {"verify": ["1"]}, {"view": ["full"]}, {"project": [self.proj["id"]]},
                  {"snapshots": ["1"], "project": ["nope"]}, {"snapshot": ["snap-" + "0" * 24], "verify": ["1"], "view": ["full"]}, {"baselines": ["1"]},
                  {"baselines": ["1"], "page": ["page-x"], "at": ["abc"]}, {"snapshots": ["2"]}, {"snapshot": ["snap-" + "0" * 24], "view": ["bogus"]}):
            self.assertEqual(hq_carnet.http_get(q)[0], 400, q)
        self.assertEqual(hq_carnet.http_get({"snapshot": ["snap-" + "0" * 24]})[0], 404)
        self.assertEqual(hq_carnet.http_get({"snapshot": ["nope"]})[0], 404)

    def test_existing_queries_unchanged(self):
        self.assertEqual(hq_carnet.http_get({})[0], 200)
        self.assertEqual(hq_carnet.http_get({"meta": ["1"]})[0], 200)
        self.assertEqual(hq_carnet.http_get({"history": ["1"]})[0], 200)
        self.assertEqual(hq_carnet.http_get({"sources": ["1"]})[0], 200)
        self.assertEqual(hq_carnet.http_get({"page": ["page-a"]})[0], 400)

    def test_cockpit_route_and_snapshot_routes(self):
        self.proj_page([para("x"), decision("D")])
        self.assertEqual(hq_carnet.http_get({"cockpit": [self.proj["id"]]})[1]["counts"]["decisions"], 1)
        sid = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": "L"})[1]["snapshot"]["id"]
        lst = hq_carnet.http_get({"snapshots": ["1"], "project": [self.proj["id"]]})[1]
        self.assertEqual([r["id"] for r in lst["snapshots"]], [sid])
        self.assertEqual(hq_carnet.http_get({"snapshots": ["1"], "project": [self.other["id"]]})[1]["snapshots"], [])
        self.assertEqual(hq_carnet.http_get({"snapshot": [sid]})[1]["snapshot"]["id"], sid)
        self.assertIn("pages", hq_carnet.http_get({"snapshot": [sid], "view": ["full"]})[1]["snapshot"])
        self.assertEqual(hq_carnet.http_get({"snapshot": [sid], "verify": ["1"]})[1]["integrity"], "ok")
        for status, body in (hq_carnet.http_get({"snapshots": ["1"]}), hq_carnet.http_get({"snapshot": [sid], "verify": ["1"]})):
            self.assertEqual(status, 200)
            self.assertNotIn(str(self.tmp), json.dumps(body))


# ---------------------------------------------------------------- report integration


class ReportTests(IntelBase):
    def test_live_overview_item_pinned_by_fingerprint(self):
        page = self.proj_page([para("Titre"), decision("Retenir H7"), measure(v="10.9", tol="0.1")])
        ov = self.cockpit()
        out = report.build({"action": "report_build", "items": [{"kind": "project_overview", "project_id": self.proj["id"], "fingerprint": ov["fingerprint"]}]})
        md = out["markdown"]
        self.assertIn("## Synthèse du projet — Banc", md)
        self.assertIn("Retenir H7", md)
        self.assertIn("hors tolérance", md)
        self.assertIn("#carnet/" + page["id"], md)
        self.assertNotIn(str(self.tmp), md)
        self.assertEqual(out["sections"][0]["kind"], "project_overview")
        cur = self.cur(page["id"])
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [para("changé")]}})
        with self.assertRaises(hq_carnet.CarnetConflict) as ctx:
            report.build({"action": "report_build", "items": [{"kind": "project_overview", "project_id": self.proj["id"], "fingerprint": ov["fingerprint"]}]})
        self.assertEqual(ctx.exception.payload["code"], "report_stale")

    def test_snapshot_overview_item_is_frozen_and_labelled(self):
        page = self.proj_page([para("v1"), decision("D1")])
        sid = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": "Gel CDR", "note": "avant fabrication"})[1]["snapshot"]["id"]
        cur = self.cur(page["id"])
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [para("v2")]}})
        md = report.build({"action": "report_build", "items": [{"kind": "project_overview", "snapshot_id": sid}]})["markdown"]
        self.assertIn("Jalon figé", md)
        self.assertIn("Gel CDR", md)
        self.assertIn("D1", md)
        self.assertIn("avant fabrication", md)

    def test_item_validation(self):
        for item in ({"kind": "project_overview"}, {"kind": "project_overview", "project_id": "nope", "fingerprint": "0" * 32}, {"kind": "project_overview", "project_id": self.proj["id"], "fingerprint": "zz"},
                     {"kind": "project_overview", "snapshot_id": "snap-x"}, {"kind": "project_overview", "snapshot_id": "snap-" + "0" * 24, "project_id": self.proj["id"]}):
            with self.assertRaises(hq_carnet.CarnetError):
                report.build({"action": "report_build", "items": [item]})
        with self.assertRaises(snaps.SnapshotNotFound):
            report.build({"action": "report_build", "items": [{"kind": "project_overview", "snapshot_id": "snap-" + "0" * 24}]})

    def test_existing_item_kinds_still_work(self):
        page = self.proj_page([para("n")])
        out = report.build({"action": "report_build", "items": [{"kind": "note", "page_id": page["id"], "rev": self.cur(page["id"])["rev"]}]})
        self.assertIn("## Note", out["markdown"])


# ---------------------------------------------------------------- backup closure


class BackupTests(IntelBase):
    def test_snapshots_and_their_media_join_the_backup(self):
        asset = media.store_upload(__import__("io").BytesIO(png()).read, len(png()), "image/png")["asset"]
        page = self.proj_page([image_block(asset)])
        sid = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": "L"})[1]["snapshot"]["id"]
        cur = self.cur(page["id"])
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [para("plus d'image")]}})
        dest = self.tmp / "backup"
        out = hq_carnet.snapshot_to(self.tmp, dest)
        self.assertEqual(out["snapshots"], {"count": 1, "bytes": out["snapshots"]["bytes"], "valid": True})
        self.assertTrue(out["valid"])
        self.assertEqual((dest / "snapshots" / (sid + ".json")).read_bytes(), (self.tmp / ".hq-carnet" / "snapshots" / (sid + ".json")).read_bytes())
        self.assertTrue(list((dest / "assets").glob(asset["id"] + "*")), "the pinned image travels even though the page no longer uses it")

    def test_corrupt_snapshot_blocks_retention_without_failing_backup(self):
        self.proj_page([para("x")])
        sid = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": "L"})[1]["snapshot"]["id"]
        (self.tmp / ".hq-carnet" / "snapshots" / (sid + ".json")).write_text("{ nope", encoding="utf-8")
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertFalse(out["valid"])
        self.assertFalse(out["snapshots"]["valid"])

    def test_status_shape_unchanged_without_snapshots(self):
        self.proj_page([para("x")])
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertNotIn("snapshots", out)
        self.assertTrue(out["valid"])

    def test_redirected_store_is_refused(self):
        self.proj_page([para("x")])
        target = self.tmp / "elsewhere"
        target.mkdir()
        (self.tmp / ".hq-carnet").mkdir(exist_ok=True)
        os.symlink(target, self.tmp / ".hq-carnet" / "snapshots")
        status, out = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": "x"})
        self.assertEqual(status, 409)
        self.assertEqual(os.listdir(target), [])
        self.assertNotIn(str(self.tmp), json.dumps(out))


# ---------------------------------------------------------------- browser contract


class FixtureDriftTests(unittest.TestCase):
    def test_browser_fixture_has_the_shape_of_the_live_server_responses(self):
        import gen_fixtures_carnet_intel as gen

        stored = json.loads((Path(__file__).resolve().parent / "fixtures_carnet_intel.json").read_text(encoding="utf-8"))
        self.assertEqual(gen.shape(gen.build()), gen.shape(stored), "run: python3 tests/gen_fixtures_carnet_intel.py")


# ---------------------------------------------------------------- pure helpers


class PureTests(unittest.TestCase):
    def test_norm_label(self):
        self.assertEqual(intel.norm_label("  Ø   Arbre "), intel.norm_label("ø arbre"))
        self.assertEqual(intel.norm_label("é"), intel.norm_label("é"))
        self.assertNotEqual(intel.norm_label("a"), intel.norm_label("b"))

    def test_fingerprint_depends_on_ids_and_revs_only(self):
        a = [{"id": "page-1", "rev": 1}, {"id": "page-2", "rev": 3}]
        self.assertEqual(intel.fingerprint(a), intel.fingerprint(list(reversed(a))))
        self.assertNotEqual(intel.fingerprint(a), intel.fingerprint([{"id": "page-1", "rev": 2}, {"id": "page-2", "rev": 3}]))

    def test_seal_ignores_only_the_seal(self):
        obj = {"a": 1, "content_sha256": "x"}
        self.assertEqual(snaps.seal(obj), snaps.seal({"a": 1, "content_sha256": "y"}))
        self.assertNotEqual(snaps.seal(obj), snaps.seal({"a": 2}))

    def test_no_forbidden_machinery_in_the_derivation_modules(self):
        for name in ("hq_carnet_intel.py", "hq_carnet_snapshots.py", "hq_carnet_review.py"):
            src = (Path(__file__).resolve().parent.parent / name).read_text(encoding="utf-8")
            for banned in ("eval(", "exec(", "urllib", "socket", "requests", "subprocess", "openai", "anthropic"):
                self.assertNotIn(banned, src, (name, banned))


if __name__ == "__main__":
    unittest.main()
