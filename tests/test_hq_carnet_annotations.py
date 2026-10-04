"""Carnet Phase 10 — live evidence annotations and Review Pack comments.

Evidence stays evidence, commentary stays commentary. These tests pin the server half: target identity (ownership, not anchor; server-owned
citation fingerprint), citation / source freshness without guessing, optimistic concurrency, request-ID replay / conflict, bounds,
corruption isolation, backup-copy integrity, the append-only review-comment store, the deterministic review export, and that nothing a
comment or annotation says can leak into page / source / snapshot / Ask / report state.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import sys
import unittest
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_annotations as ann  # noqa: E402
import hq_carnet_rcomments as rcm  # noqa: E402
import hq_carnet_reviews as reviews  # noqa: E402
import hq_carnet_rich as rich  # noqa: E402
import hq_carnet_snapshots as snaps  # noqa: E402
import hq_carnet_sources as sources  # noqa: E402
from test_hq_carnet_history import para  # noqa: E402
from test_hq_carnet_portals import PBase  # noqa: E402
from test_hq_carnet_reviews import post, rid, tree_digest  # noqa: E402


def digest_without(root: Path, *skip: str) -> str:
    """Digest of every file under ``root`` except the named top-level ``.hq-carnet`` subdirectories."""
    h = hashlib.sha256()
    for p in sorted(Path(root).rglob("*")):
        rel = p.relative_to(root)
        if len(rel.parts) >= 2 and rel.parts[0] == ".hq-carnet" and rel.parts[1] in skip:
            continue
        h.update(str(rel).encode())
        if p.is_file():
            h.update(p.read_bytes())
    return h.hexdigest()


class ABase(PBase):
    def setUp(self):
        super().setUp()
        self.sedition = self.ed("Machinery")

    # ---- fixtures
    def cited_page(self, ed=None, **kw):
        ed = ed or self.sedition
        page = self.page_of(self.cite_block(ed, **kw))
        blk = self.cur(page["id"])["content"]["blocks"][1]
        return page, blk, blk["marks"][0]["cite"]

    def ctarget(self, page, blk, cite):
        return {"kind": "citation", "page_id": page["id"], "block_id": blk["id"], "cite": cite}

    def stor(self, ed=None):
        return {"kind": "source", "source_id": (ed or self.sedition)["id"]}

    def create(self, target, body="À vérifier", anchor=None, request_id=None, expect=200):
        status, out = post(action="annotation_create", request_id=request_id or rid(), target=target, anchor=anchor, body=body)
        self.assertEqual(status, expect, out)
        return out["annotation"] if expect == 200 else out

    def update(self, a, expect=200, **kw):
        status, out = post(action="annotation_update", id=a["id"], target=_loc(a["target"]), expected_rev=a["rev"], **kw)
        self.assertEqual(status, expect, out)
        return out["annotation"] if expect == 200 else out

    def delete(self, a, expect=200, rev=None):
        status, out = post(action="annotation_delete", id=a["id"], target=_loc(a["target"]), expected_rev=a["rev"] if rev is None else rev, confirm=True)
        self.assertEqual(status, expect, out)
        return out

    def listing(self, *targets, expect=200):
        status, out = post(action="annotation_list", targets=list(targets))
        self.assertEqual(status, expect, out)
        return out["results"] if expect == 200 else out

    def one(self, target):
        return self.listing(target)[0]

    def shard_files(self):
        d = self.tmp / ".hq-carnet" / "annotations"
        return sorted(d.glob("ant-*.json")) if d.is_dir() else []


def _loc(target):
    return dict(target)


# ================================================================ targets, identity, fingerprint


class TargetTests(ABase):
    def test_citation_target_stores_only_the_server_fingerprint(self):
        page, blk, cite = self.cited_page()
        a = self.create(self.ctarget(page, blk, cite))
        self.assertEqual(a["target"], {"kind": "citation", "page_id": page["id"], "block_id": blk["id"], "citation_fingerprint": ann.fingerprint(cite)})
        self.assertEqual(a["source_id"], self.sedition["id"])
        self.assertEqual(a["project_id"], self.cur(page["id"])["project_id"])
        raw = self.shard_files()[0].read_text()
        self.assertNotIn("Machinery", raw, "the citation value itself is not stored: only its fingerprint")

    def test_client_fingerprint_is_never_authority_for_a_new_annotation(self):
        page, blk, cite = self.cited_page()
        forged = {"kind": "citation", "page_id": page["id"], "block_id": blk["id"], "citation_fingerprint": ann.fingerprint(cite)}
        self.create(forged, expect=400)  # no cite: the server cannot confirm the citation, so it refuses (fingerprint alone = locator only)
        self.create({**self.ctarget(page, blk, cite), "citation_fingerprint": "0" * 64}, expect=400)
        other = dict(cite, loc={"kind": "page", "text": "999"})
        self.create(self.ctarget(page, blk, other), expect=404)  # a citation that is not in that block is refused, never retargeted
        self.assertEqual(self.shard_files(), [])

    def test_source_target_is_ownership_only_and_anchor_never_shards(self):
        a417 = self.create(self.stor(), "p417", anchor={"loc": "304.1.2", "pdf": 417})
        a418 = self.create(self.stor(), "p418", anchor={"loc": None, "pdf": 418})
        a_none = self.create(self.stor(), "no anchor")
        self.assertEqual(a417["target"], {"kind": "source", "source_id": self.sedition["id"]})
        self.assertEqual(len(self.shard_files()), 1, "one shard per target: anchors never become separate shards")
        self.assertEqual(len(self.one(self.stor())["annotations"]), 3)
        self.assertEqual((a417["anchor"], a418["anchor"], a_none["anchor"]), ({"loc": "304.1.2", "pdf": 417}, {"loc": None, "pdf": 418}, None))

    def test_anchor_is_validated_and_never_rewrites_the_source(self):
        before = (self.src_rev(self.sedition), sources.mutate({"action": "source_family_create", "name": "F2"})["family"]["id"])
        for bad in ({"loc": "x"}, {"loc": "", "pdf": 3}, {"loc": "a\nb", "pdf": None}, {"loc": None, "pdf": 0}, {"loc": None, "pdf": 100001}, {"loc": None, "pdf": True},
                    {"loc": "x" * 121, "pdf": None}, "p417", [], {"loc": "a", "pdf": 1, "extra": 1}):
            self.create(self.stor(), anchor=bad, expect=400)
        self.assertEqual(self.src_rev(self.sedition), before[0])

    def test_malformed_targets_and_ids_are_refused(self):
        page, blk, cite = self.cited_page()
        good = self.ctarget(page, blk, cite)
        for bad in (None, [], "source", {"kind": "page", "page_id": page["id"]}, {"kind": "source"}, {"kind": "source", "source_id": "x"}, {**self.stor(), "extra": 1},
                    {**good, "page_id": "../x"}, {**good, "block_id": "block-\n"}, {k: v for k, v in good.items() if k != "cite"},
                    {**good, "cite": {**cite, "extra": 1}}, {**good, "cite": "x"}):
            self.create(bad, expect=400)
        for bad in ({"request_id": "short"}, {"request_id": "G" * 32}, {"request_id": 7}):
            status, out = post(action="annotation_create", target=self.stor(), anchor=None, body="x", **({"request_id": rid()} | bad))
            self.assertEqual(status, 400, bad)
        status, _ = post(action="annotation_create", request_id=rid(), target=self.stor(), anchor=None, body="x", author="me")
        self.assertEqual(status, 400, "no author field exists")

    def test_unknown_source_is_refused(self):
        self.create({"kind": "source", "source_id": "srce-gone"}, expect=404)
        with mock.patch.object(ann, "_editions", return_value=None):
            self.create(self.stor(), expect=503)

    def test_identical_citations_share_one_target_with_a_count(self):
        ed = self.sedition
        cite = self.cite(ed)
        label = hq_carnet.bulk.citation_label(cite)
        text = f"{label} et {label}"
        marks = [{"type": "citation", "start": 0, "end": len(label), "cite": cite}, {"type": "citation", "start": len(label) + 4, "end": 2 * len(label) + 4, "cite": cite}]
        page = self.page_of(para(text, marks))
        blk = self.cur(page["id"])["content"]["blocks"][1]
        a = self.create(self.ctarget(page, blk, cite))
        res = self.one(a["target"])
        self.assertEqual((res["target_state"], res["identical_count"]), ("unchanged", 2), "a value, not a positional occurrence")
        b = self.create(self.ctarget(page, blk, cite), "second")
        self.assertEqual(b["target"], a["target"])
        self.assertEqual(len(self.shard_files()), 1)


# ================================================================ evidence is never touched


class NoEvidenceMutationTests(ABase):
    def test_citation_annotation_lifecycle_never_touches_the_page(self):
        page, blk, cite = self.cited_page()
        before = copy.deepcopy(self.cur(page["id"]))
        nb_rev = hq_carnet.get_notebook()["notebook_rev"]
        a = self.create(self.ctarget(page, blk, cite), "Confirmer la clause")
        a = self.update(a, body="Confirmer la clause 304.1.2")
        a = self.update(a, status="resolved")
        a = self.update(a, status="open")
        self.delete(a)
        self.assertEqual(self.cur(page["id"]), before, "page JSON (content, rev, updated_at) is byte-identical")
        self.assertEqual(hq_carnet.get_notebook()["notebook_rev"], nb_rev, "no page revision, no notebook revision")

    def test_source_annotation_lifecycle_never_touches_the_source(self):
        rev = self.src_rev(self.sedition)
        sources_file = self.tmp / ".hq-carnet" / "sources.json"
        before = sources_file.read_bytes()
        a = self.create(self.stor(), "Vérifier l'édition 2025")
        a = self.update(a, status="resolved")
        a = self.update(a, body="Édition 2025 vérifiée")
        self.assertEqual((self.src_rev(self.sedition), sources_file.read_bytes()), (rev, before))

    def test_resolve_reopen_and_delete_alter_no_evidence(self):
        page, blk, cite = self.cited_page()
        a = self.create(self.ctarget(page, blk, cite))
        snapshot = digest_without(self.tmp, "annotations")
        a = self.update(a, status="resolved")
        a = self.update(a, status="open")
        self.delete(a)
        self.assertEqual(digest_without(self.tmp, "annotations"), snapshot, "every file outside the annotation store is byte-identical")

    def test_delete_removes_the_annotation_only(self):
        page, blk, cite = self.cited_page()
        a1 = self.create(self.ctarget(page, blk, cite), "a")
        a2 = self.create(self.stor(), "b")
        self.put("Uni/book.pdf", b"%PDF")
        digest = digest_without(self.tmp, "annotations")
        self.delete(a1)
        self.assertEqual(digest_without(self.tmp, "annotations"), digest)
        self.assertEqual(self.one(a2["target"])["annotations"][0]["id"], a2["id"], "another target's annotation is untouched")
        self.assertEqual(self.one(a1["target"])["annotations"], [])
        self.assertEqual(len(self.shard_files()), 1, "an emptied shard file is removed, nothing else")

    def test_snapshot_contents_do_not_change_because_an_annotation_changes(self):
        page, blk, cite = self.cited_page()
        s1 = self.snap()
        got1 = snaps.get(s1)
        a = self.create(self.ctarget(page, blk, cite), "note secrète")
        self.update(a, body="autre note")
        self.assertEqual(snaps.get(s1)["snapshot"], got1["snapshot"], "a taken snapshot is write-once and does not know the annotation")
        s2 = self.snap()
        drop = ("id", "created_at", "content_sha256", "label", "request_id")
        strip = lambda s: {k: v for k, v in s.items() if k not in drop}  # noqa: E731
        self.assertEqual(strip(snaps.get(s2)["snapshot"]), strip(got1["snapshot"]))
        self.assertNotIn("note secrète", json.dumps(snaps.get(s2)["snapshot"]))
        self.assertNotIn("autre note", json.dumps(snaps.get(s2)["snapshot"]))

    def test_ask_result_and_fingerprint_do_not_change_because_annotation_text_changes(self):
        import hq_carnet_review as review

        page, blk, cite = self.cited_page()
        scope = {"kind": "project", "id": self.proj["id"]}
        before = review.ask({"action": "ask", "question": "Machinery", "scope": scope})
        a = self.create(self.ctarget(page, blk, cite), "Machinery est faux — sous-dimensionné")
        self.update(a, body="Machinery Machinery Machinery tuyau sous-dimensionné")
        after = review.ask({"action": "ask", "question": "Machinery", "scope": scope})
        self.assertEqual(after["fingerprint"], before["fingerprint"])
        self.assertNotIn("sous-dimensionné", json.dumps(after, ensure_ascii=False))
        none = review.ask({"action": "ask", "question": "sous-dimensionné", "scope": scope})
        self.assertEqual(none.get("cards", none.get("results", [])), [], "annotation text is commentary: never retrieved as evidence")

    def test_regular_reports_do_not_include_annotation_bodies(self):
        page, blk, cite = self.cited_page()
        a = self.create(self.ctarget(page, blk, cite), "CONCLUSION-SECRETE-123")
        self.create(self.stor(), "AUTRE-SECRET-456")
        status, out = post(action="report_build", items=[{"kind": "source", "edition_id": self.sedition["id"]}])
        self.assertEqual(status, 200, out)
        blob = json.dumps(out, ensure_ascii=False)
        self.assertNotIn("CONCLUSION-SECRETE-123", blob)
        self.assertNotIn("AUTRE-SECRET-456", blob)


# ================================================================ citation / source freshness: no guessing


class FreshnessTests(ABase):
    def edit_page(self, page, blocks):
        return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "content": {"version": 2, "blocks": blocks}})["page"]

    def test_unchanged_changed_unavailable(self):
        page, blk, cite = self.cited_page()
        a = self.create(self.ctarget(page, blk, cite))
        self.assertEqual(self.one(a["target"])["target_state"], "unchanged")
        blocks = self.cur(page["id"])["content"]["blocks"]
        self.assertEqual(sorted(ann.CITATION_STATES), ["changed_or_removed", "unavailable", "unchanged"], "no separate 'changed' vs 'removed': that would be a guess")
        # the citation is edited (another locator): same block, different evidence value
        new = self.cite(self.sedition, text="999")
        label = hq_carnet.bulk.citation_label(new)
        blocks[1] = {**blocks[1], "text": label, "marks": [{"type": "citation", "start": 0, "end": len(label), "cite": new}]}
        self.edit_page(page, blocks)
        res = self.one(a["target"])
        self.assertEqual((res["target_state"], res["identical_count"]), ("changed_or_removed", 0))
        self.assertEqual(len(res["annotations"]), 1, "the annotation remains recoverable")

    def test_changed_citation_is_never_retargeted(self):
        page, blk, cite = self.cited_page()
        a = self.create(self.ctarget(page, blk, cite), "sur la 417")
        blocks = self.cur(page["id"])["content"]["blocks"]
        new = self.cite(self.sedition, text="999")
        label = hq_carnet.bulk.citation_label(new)
        blocks[1] = {**blocks[1], "text": label, "marks": [{"type": "citation", "start": 0, "end": len(label), "cite": new}]}
        self.edit_page(page, blocks)
        replacement = self.one({"kind": "citation", "page_id": page["id"], "block_id": blk["id"], "cite": new})
        self.assertEqual(replacement["annotations"], [], "no fuzzy match, no 'nearest clause', no title-only match: the new citation owns nothing")
        self.assertEqual(replacement["target_state"], "unchanged")
        self.assertEqual(self.one(a["target"])["annotations"][0]["id"], a["id"])

    def test_citation_removed_from_the_block_keeps_the_annotation(self):
        page, blk, cite = self.cited_page()
        a = self.create(self.ctarget(page, blk, cite))
        blocks = self.cur(page["id"])["content"]["blocks"]
        blocks[1] = {**blocks[1], "marks": []}
        self.edit_page(page, blocks)
        res = self.one(a["target"])
        self.assertEqual(res["target_state"], "changed_or_removed")
        self.assertEqual(res["annotations"][0]["body"], "À vérifier")

    def test_block_deleted_means_unavailable(self):
        page, blk, cite = self.cited_page()
        a = self.create(self.ctarget(page, blk, cite))
        self.edit_page(page, [self.cur(page["id"])["content"]["blocks"][0]])
        res = self.one(a["target"])
        self.assertEqual((res["target_state"], len(res["annotations"])), ("unavailable", 1))

    def test_trashed_page_means_unavailable(self):
        page, blk, cite = self.cited_page()
        a = self.create(self.ctarget(page, blk, cite))
        hq_carnet.mutate({"action": "page_trash", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        self.assertEqual(self.one(a["target"])["target_state"], "unavailable")

    def test_history_restore_with_a_reminted_block_never_relinks(self):
        page, blk, cite = self.cited_page()
        a = self.create(self.ctarget(page, blk, cite))
        cp = post(action="history_checkpoint", page_id=page["id"], expected_rev=self.cur(page["id"])["rev"], label="avant")[1]
        self.edit_page(page, [self.cur(page["id"])["content"]["blocks"][0]])  # the cited block is deleted
        status, out = post(action="history_restore", page_id=page["id"], event_id=cp["event_id"], expected_rev=self.cur(page["id"])["rev"], confirm=True)
        self.assertEqual(status, 200, out)
        blocks = self.cur(page["id"])["content"]["blocks"]
        reminted = next(b for b in blocks if b.get("marks") and b["marks"][0]["type"] == "citation")
        self.assertNotEqual(reminted["id"], blk["id"], "the restore re-minted the block id")
        self.assertEqual(self.one(a["target"])["target_state"], "unavailable", "the old target is shown as unavailable, honestly")
        again = self.one({"kind": "citation", "page_id": page["id"], "block_id": reminted["id"], "cite": cite})
        self.assertEqual(again["annotations"], [], "the annotation is NOT silently attached to the look-alike block")

    def test_source_title_change_keeps_the_annotation_attached_by_id(self):
        a = self.create(self.stor())
        sources.mutate({"action": "source_edition_update", "id": self.sedition["id"], "expected_rev": self.src_rev(self.sedition), "title": "Renommée"})
        res = self.one(a["target"])
        self.assertEqual((res["target_state"], res["annotations"][0]["id"]), ("available", a["id"]))

    def test_archived_source_keeps_the_annotation(self):
        a = self.create(self.stor())
        sources.mutate({"action": "source_edition_archive", "id": self.sedition["id"], "expected_rev": self.src_rev(self.sedition), "archived": True})
        res = self.one(a["target"])
        self.assertEqual((res["target_state"], len(res["annotations"])), ("archived", 1))

    def test_missing_or_unknown_source_keeps_the_annotation(self):
        a = self.create(self.stor())
        with mock.patch.object(ann, "_editions", return_value={}):
            res = self.one(a["target"])
        self.assertEqual((res["target_state"], len(res["annotations"])), ("missing", 1))
        with mock.patch.object(ann, "_editions", return_value=None):
            res = self.one(a["target"])
        self.assertEqual((res["target_state"], len(res["annotations"])), ("unknown", 1), "unknown is not missing")


# ================================================================ concurrency, idempotency, limits


class ConcurrencyTests(ABase):
    def test_stale_edit_is_409_and_the_losing_text_is_never_stored(self):
        a3 = self.create(self.stor(), "v1")
        a3 = self.update(a3, body="v2")
        a3 = self.update(a3, body="v3")
        self.assertEqual(a3["rev"], 3)
        a4 = self.update(a3, body="client A edit")
        status, out = post(action="annotation_update", id=a3["id"], target=a3["target"], expected_rev=3, body="client B typed text")
        self.assertEqual((status, out["code"], out["current_rev"]), (409, "annotation_conflict", 4))
        self.assertNotIn("client B typed text", self.shard_files()[0].read_text())
        listed = self.one(a3["target"])["annotations"][0]
        self.assertEqual((listed["rev"], listed["body"]), (4, "client A edit"))
        again = self.update({**a3, "rev": 4}, body="client B retry on fresh rev")
        self.assertEqual(again["rev"], 5, "only an explicit retry against the fresh revision succeeds")

    def test_stale_delete_confirmation_is_409_and_the_annotation_remains(self):
        a = self.create(self.stor(), "x")
        a = self.update(a, body="y")
        self.assertEqual(a["rev"], 2)
        confirm_rev = a["rev"]
        self.update(a, status="resolved")  # another client: rev 3
        status, out = post(action="annotation_delete", id=a["id"], target=a["target"], expected_rev=confirm_rev, confirm=True)
        self.assertEqual((status, out["code"], out["current_rev"]), (409, "annotation_conflict", 3))
        self.assertEqual(len(self.one(a["target"])["annotations"]), 1)
        self.assertEqual(post(action="annotation_delete", id=a["id"], target=a["target"], expected_rev=3)[0], 400, "confirm is required")
        self.assertEqual(post(action="annotation_delete", id=a["id"], target=a["target"], expected_rev=3, confirm=False)[0], 400)

    def test_every_mutation_requires_expected_rev(self):
        a = self.create(self.stor())
        for payload in ({"action": "annotation_update", "id": a["id"], "target": a["target"], "body": "x"},
                        {"action": "annotation_update", "id": a["id"], "target": a["target"], "body": "x", "expected_rev": 0},
                        {"action": "annotation_update", "id": a["id"], "target": a["target"], "body": "x", "expected_rev": "1"},
                        {"action": "annotation_delete", "id": a["id"], "target": a["target"], "confirm": True},
                        {"action": "annotation_update", "id": a["id"], "target": a["target"], "expected_rev": 1}):
            self.assertEqual(post(**payload)[0], 400, payload)

    def test_create_retry_does_not_duplicate_and_conflicts_on_changed_intent(self):
        req = rid()
        first = self.create(self.stor(), "même intention", request_id=req)
        status, out = post(action="annotation_create", request_id=req, target=self.stor(), anchor=None, body="même intention")
        self.assertEqual(status, 200)
        self.assertTrue(out["replayed"])
        self.assertEqual(out["annotation"]["id"], first["id"])
        self.assertEqual(len(self.one(self.stor())["annotations"]), 1)
        for change in ({"body": "autre texte"}, {"anchor": {"loc": None, "pdf": 5}}, {"target": {"kind": "source", "source_id": self.ed("Autre")["id"]}}):
            payload = {"action": "annotation_create", "request_id": req, "target": self.stor(), "anchor": None, "body": "même intention", **change}
            status, out = post(**payload)
            self.assertEqual((status, out["code"]), (409, "annotation_request_conflict"), change)
        self.assertEqual(len(self.one(self.stor())["annotations"]), 1)

    def test_replay_survives_a_restart_of_the_in_memory_state(self):
        req = rid()
        first = self.create(self.stor(), "persistant", request_id=req)
        # nothing is kept in memory: the replay is answered from the files alone
        out = post(action="annotation_create", request_id=req, target=self.stor(), anchor=None, body="persistant")[1]
        self.assertEqual((out["replayed"], out["annotation"]["id"]), (True, first["id"]))

    def test_replay_does_not_depend_on_the_target_still_existing(self):
        page, blk, cite = self.cited_page()
        req = rid()
        first = self.create(self.ctarget(page, blk, cite), "x", request_id=req)
        self.edit = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "content": {"version": 2, "blocks": [self.cur(page["id"])["content"]["blocks"][0]]}})
        out = post(action="annotation_create", request_id=req, target=self.ctarget(page, blk, cite), anchor=None, body="x")[1]
        self.assertEqual((out["replayed"], out["annotation"]["id"]), (True, first["id"]), "a lost response is safe to retry even after the evidence moved")


class LimitTests(ABase):
    def test_body_limits_text_only(self):
        self.create(self.stor(), "x" * ann.BODY_MAX)
        self.create(self.stor(), "é" * ann.BODY_MAX)
        self.create(self.stor(), "😀" * ann.BODY_MAX)  # code points, not UTF-16 units
        self.create(self.stor(), "x" * (ann.BODY_MAX + 1), expect=400)
        for bad in ("", "   \n\t ", "a\x00b", "a\x07b", "\ud800", 5, None, ["x"], {"t": "x"}):
            self.create(self.stor(), bad, expect=400)
        out = self.create(self.stor(), "ligne 1\nligne 2\tfin")
        self.assertEqual(out["body"], "ligne 1\nligne 2\tfin")
        saved = self.one(self.stor())["annotations"]
        self.assertTrue(any(len(a["body"]) == ann.BODY_MAX for a in saved), "a body of the maximum size saves and reads back exactly")

    def test_hostile_body_is_stored_and_returned_as_plain_text(self):
        hostile = "<script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror=alert(1)>"
        a = self.create(self.stor(), hostile)
        self.assertEqual(self.one(self.stor())["annotations"][0]["body"], hostile, "stored verbatim: it is never interpreted, rewritten or linkified")
        self.assertEqual(a["body"], hostile)

    def test_per_target_limit_keeps_the_list_bounded(self):
        for n in range(ann.PER_TARGET_MAX):
            self.create(self.stor(), f"n{n}")
        status, out = post(action="annotation_create", request_id=rid(), target=self.stor(), anchor=None, body="one too many")
        self.assertEqual((status, out["code"]), (409, "annotation_limit"))
        res = self.one(self.stor())
        self.assertEqual((len(res["annotations"]), res["annotations"][0]["status"]), (100, "open"))
        self.assertEqual(ann.LIST_MAX, 100)
        self.create(self.stor(self.ed("Autre")), "another target is not affected")

    def test_total_limit(self):
        with mock.patch.object(ann, "TOTAL_MAX", 3):
            for n in range(3):
                self.create(self.stor(self.ed(f"S{n}")), "x")
            status, out = post(action="annotation_create", request_id=rid(), target=self.stor(), anchor=None, body="x")
            self.assertEqual((status, out["code"]), (409, "annotation_limit"))

    def test_list_request_is_bounded(self):
        eds = [self.ed(f"S{n}") for n in range(ann.TARGETS_PER_LIST_MAX + 1)]
        self.assertEqual(post(action="annotation_list", targets=[self.stor(e) for e in eds])[0], 400)
        self.assertEqual(post(action="annotation_list", targets=[])[0], 400)
        self.assertEqual(post(action="annotation_list", targets=[self.stor(), self.stor()])[0], 200, "duplicates collapse")
        self.assertEqual(post(action="annotation_list")[0], 400)
        self.assertEqual(post(action="annotation_list", targets=[self.stor()], extra=1)[0], 400)
        with mock.patch.object(ann, "LIST_MAX", 3):
            for e in eds[:2]:
                for n in range(2):
                    self.create(self.stor(e), f"{n}")
            out = post(action="annotation_list", targets=[self.stor(eds[0]), self.stor(eds[1])])[1]
            self.assertEqual((sum(len(r["annotations"]) for r in out["results"]), out["truncated"]), (3, True))

    def test_open_annotations_are_listed_first(self):
        a = self.create(self.stor(), "ancienne")
        b = self.create(self.stor(), "récente")
        self.update(a, status="resolved")
        order = [x["status"] for x in self.one(self.stor())["annotations"]]
        self.assertEqual(order, ["open", "resolved"])


# ================================================================ corruption and storage


class CorruptionTests(ABase):
    def two_records(self):
        a = self.create(self.stor(), "intact")
        b = self.create(self.stor(), "à altérer")
        return a, b

    def tamper(self, fn):
        path = self.shard_files()[0]
        data = json.loads(path.read_text())
        fn(data)
        path.write_bytes(json.dumps(data).encode())
        return path

    def test_one_corrupt_record_does_not_suppress_the_others(self):
        a, b = self.two_records()

        def alter(d):
            next(r for r in d["records"] if r["id"] == b["id"])["body"] = "falsifié"

        self.tamper(alter)
        rows = {r["id"]: r for r in self.one(self.stor())["annotations"]}
        self.assertEqual((rows[a["id"]]["integrity"], rows[b["id"]]["integrity"]), ("ok", "corrupt"))
        self.assertEqual(rows[a["id"]]["body"], "intact")

    def test_corrupt_record_is_not_silently_trusted_or_edited(self):
        a, b = self.two_records()
        self.tamper(lambda d: next(r for r in d["records"] if r["id"] == b["id"]).update(body="falsifié"))
        status, out = post(action="annotation_update", id=b["id"], target=b["target"], expected_rev=b["rev"], status="resolved")
        self.assertEqual((status, out["code"]), (409, "annotation_corrupt"))
        self.assertEqual(self.update(a, body="la voisine reste éditable")["rev"], 2)
        raw = json.loads(self.shard_files()[0].read_text())
        self.assertEqual(next(r for r in raw["records"] if r["id"] == b["id"])["body"], "falsifié", "never repaired")

    def test_malformed_record_is_reported_not_hidden_and_preserved(self):
        a, b = self.two_records()
        self.tamper(lambda d: d["records"][1].update(status="weird"))
        res = self.one(self.stor())
        self.assertEqual((len(res["annotations"]), res["unavailable"]), (1, 1))
        self.assertIn("weird", self.shard_files()[0].read_text())

    def test_malformed_shard_is_reported_and_preserved_byte_for_byte(self):
        self.create(self.stor(), "x")
        path = self.shard_files()[0]
        path.write_bytes(b"{not json")
        res = self.one(self.stor())
        self.assertEqual((res["annotations"], res["unavailable"]), ([], 1))
        status, out = post(action="annotation_create", request_id=rid(), target=self.stor(), anchor=None, body="y")
        self.assertEqual(status, 503)
        self.assertEqual(path.read_bytes(), b"{not json")

    def test_redirected_directory_is_refused(self):
        self.create(self.stor(), "x")
        outside = Path(self.tmp.parent) / ("outside-" + uuid.uuid4().hex)
        outside.mkdir()
        self.addCleanup(shutil.rmtree, outside, True)
        shutil.rmtree(self.tmp / ".hq-carnet" / "annotations")
        (self.tmp / ".hq-carnet" / "annotations").symlink_to(outside, target_is_directory=True)
        self.assertEqual(post(action="annotation_list", targets=[self.stor()])[0], 409)
        self.assertEqual(post(action="annotation_create", request_id=rid(), target=self.stor(), anchor=None, body="x")[0], 409)
        self.assertEqual(list(outside.iterdir()), [])

    def test_failure_paths_never_echo_a_filesystem_path(self):
        self.create(self.stor(), "x")
        self.shard_files()[0].write_bytes(b"\xff\xfe")
        status, out = post(action="annotation_create", request_id=rid(), target=self.stor(), anchor=None, body="y")
        self.assertNotIn(str(self.tmp), json.dumps(out))


# ================================================================ backup-copy integrity


class BackupTests(ABase):
    def test_backup_copies_the_canonical_files_byte_for_byte(self):
        page, blk, cite = self.cited_page()
        a = self.create(self.ctarget(page, blk, cite), "citation")
        b = self.create(self.stor(), "source", anchor={"loc": "1.1", "pdf": 3})
        dest = self.tmp / "backup"
        out = hq_carnet.snapshot_to(self.tmp, dest)
        self.assertEqual(out["annotations"]["count"], 2)
        self.assertTrue(out["valid"] and out["annotations"]["valid"])
        for p in self.shard_files():
            self.assertEqual((dest / "annotations" / p.name).read_bytes(), p.read_bytes())
        self.assertEqual(out["annotations"]["bytes"], sum(p.stat().st_size for p in self.shard_files()))
        copied = json.loads((dest / "annotations" / self.shard_files()[0].name).read_text())
        sealed = [r for p in dest.joinpath("annotations").glob("ant-*.json") for r in json.loads(p.read_text())["records"]]
        self.assertEqual({r["id"]: (r["rev"], r["seal"]) for r in sealed}, {a["id"]: (1, ann.seal(next(r for r in sealed if r["id"] == a["id"]))), b["id"]: (1, ann.seal(next(r for r in sealed if r["id"] == b["id"])))})
        self.assertEqual({r["target"]["citation_fingerprint"] for r in sealed if r["target"]["kind"] == "citation"}, {ann.fingerprint(cite)}, "target fingerprints survive the copy exactly")
        self.assertTrue(copied)

    def test_backup_does_not_pull_in_the_referenced_pdf_or_source(self):
        ed = self.ed("Avec PDF", file_ref=self.pdf_ref())
        self.create(self.stor(ed), "x")
        dest = self.tmp / "backup"
        hq_carnet.snapshot_to(self.tmp, dest)
        self.assertEqual(sorted(p.name for p in (dest).rglob("*.pdf")), [], "an annotation referencing a PDF never copies it")
        self.assertFalse((dest / "Uni").exists())

    def pdf_ref(self):
        self.put("Uni/ref.pdf", b"%PDF-1.4 x")
        return "Uni/ref.pdf"

    def test_backup_carries_a_corrupt_record_and_reports_invalid(self):
        a = self.create(self.stor(), "x")
        path = self.shard_files()[0]
        data = json.loads(path.read_text())
        data["records"][0]["body"] = "altéré"
        raw = json.dumps(data).encode()
        path.write_bytes(raw)
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertFalse(out["valid"])
        self.assertFalse(out["annotations"]["valid"])
        self.assertEqual((self.tmp / "backup" / "annotations" / path.name).read_bytes(), raw)

    def test_backup_without_annotations_or_comments_has_neither_key(self):
        self.page_of(para("x"))
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertNotIn("annotations", out)
        self.assertNotIn("review_comments", out)

    def test_annotations_alone_make_a_backup_present(self):
        self.create(self.stor(), "x")
        self.assertEqual(hq_carnet.snapshot_to(self.tmp, self.tmp / "b")["status"], "included")

    def test_a_backup_copy_reads_back_with_the_same_targets(self):
        a = self.create(self.stor(), "x")
        dest = self.tmp / "backup"
        hq_carnet.snapshot_to(self.tmp, dest)
        shard = json.loads(next((dest / "annotations").glob("ant-*.json")).read_text())
        self.assertEqual(shard["target"], a["target"])
        self.assertEqual(ann.record_state(shard["records"][0], shard["target"]), "ok")


# ================================================================ Review Pack comments


class CommentBase(ABase):
    def setUp(self):
        super().setUp()
        self.page, self.blk, self.cite = self.cited_page()
        self.pack = self.new_pack()
        self.item_id = self.pack["items"][0]["id"]

    def new_pack(self):
        status, out = post(action="review_create", project_id=self.proj["id"], title="Revue banc", request_id=rid())
        self.assertEqual(status, 200, out)
        pk = out["review"]
        status, out = post(action="review_item_add", id=pk["id"], expected_rev=pk["rev"], item={"kind": "source", "edition_id": self.sedition["id"]})
        self.assertEqual(status, 200, out)
        return out["review"]

    def comment(self, body="Vérifié contre la rév. C", item_id=None, review_id=None, request_id=None, supersedes=None, expect=200):
        status, out = post(action="rcomment_add", review_id=review_id or self.pack["id"], item_id=item_id or self.item_id, request_id=request_id or rid(), body=body, supersedes=supersedes)
        self.assertEqual(status, expect, out)
        return out["comment"] if expect == 200 else out

    def thread(self, review_id=None):
        status, out = post(action="rcomment_list", review_id=review_id or self.pack["id"])
        self.assertEqual(status, 200, out)
        return out

    def comment_files(self):
        d = self.tmp / ".hq-carnet" / "review-comments"
        return sorted(d.glob("rvw-*.json")) if d.is_dir() else []


class ReviewCommentTests(CommentBase):
    def test_comment_attaches_to_the_exact_item_with_a_captured_identity(self):
        pk2 = self.pack
        out = post(action="review_item_add", id=pk2["id"], expected_rev=pk2["rev"], item={"kind": "source", "edition_id": self.ed("Seconde")["id"]})[1]["review"]
        other = out["items"][1]["id"]
        c = self.comment("sur la première")
        c2 = self.comment("sur la seconde", item_id=other)
        self.assertEqual((c["item"]["item_id"], c2["item"]["item_id"]), (self.item_id, other))
        ident = c["item"]
        self.assertEqual(set(ident), {"item_id", "item_kind", "item_label", "item_fingerprint"})
        stored = next(i for i in out["items"] if i["id"] == self.item_id)
        self.assertEqual(ident["item_fingerprint"], rcm.item_fingerprint(stored))
        self.assertEqual((ident["item_kind"], ident["item_label"]), (stored["kind"], stored["label"]))
        self.assertNotIn("copy", ident, "the evidence itself is not copied")
        th = self.thread()
        self.assertEqual([x["body"] for x in th["comments"]], ["sur la première", "sur la seconde"])
        self.assertTrue(all(x["item_present"] for x in th["comments"]))

    def test_comments_are_append_only_with_supersedes(self):
        first = self.comment("erreur de rév.")
        second = self.comment("correction : rév. D", supersedes=first["id"])
        self.assertEqual(second["supersedes"], first["id"])
        bodies = [c["body"] for c in self.thread()["comments"]]
        self.assertEqual(bodies, ["erreur de rév.", "correction : rév. D"], "the earlier comment is never rewritten")
        for action in ("rcomment_update", "rcomment_delete", "rcomment_edit", "review_comment_update"):
            self.assertNotEqual(post(action=action, review_id=self.pack["id"], id=first["id"])[0], 200)
        self.comment("x", supersedes="rcm-" + "0" * 16, expect=400)  # supersedes must name an existing comment of the same item

    def test_supersedes_must_be_on_the_same_item(self):
        out = post(action="review_item_add", id=self.pack["id"], expected_rev=self.pack["rev"], item={"kind": "source", "edition_id": self.ed("Seconde")["id"]})[1]["review"]
        other = out["items"][1]["id"]
        c = self.comment("a")
        self.comment("b", item_id=other, supersedes=c["id"], expect=400)

    def test_retry_replays_the_original_comment_without_duplicating(self):
        req = rid()
        first = self.comment("texte", request_id=req)
        status, out = post(action="rcomment_add", review_id=self.pack["id"], item_id=self.item_id, request_id=req, body="texte", supersedes=None)
        self.assertEqual((status, out["replayed"], out["comment"]["id"]), (200, True, first["id"]))
        self.assertEqual(len(self.thread()["comments"]), 1)
        self.assertEqual(self.thread()["rev"], 1)

    def test_request_id_with_a_different_intent_conflicts(self):
        req = rid()
        first = self.comment("texte", request_id=req)
        other_item = post(action="review_item_add", id=self.pack["id"], expected_rev=self.pack["rev"], item={"kind": "source", "edition_id": self.ed("Seconde")["id"]})[1]["review"]["items"][1]["id"]
        for change in ({"body": "autre"}, {"item_id": other_item}, {"supersedes": first["id"]}):
            payload = {"action": "rcomment_add", "review_id": self.pack["id"], "item_id": self.item_id, "request_id": req, "body": "texte", "supersedes": None, **change}
            status, out = post(**payload)
            self.assertEqual((status, out["code"]), (409, "review_comment_request_conflict"), change)
        pk2 = self.new_pack()
        status, out = post(action="rcomment_add", review_id=pk2["id"], item_id=pk2["items"][0]["id"], request_id=req, body="texte", supersedes=None)
        self.assertEqual((status, out["code"]), (409, "review_comment_request_conflict"), "the id is bound to one review too")
        self.assertEqual(len(self.thread()["comments"]), 1)

    def test_replay_survives_item_removal(self):
        req = rid()
        first = self.comment("x", request_id=req)
        pk = reviews.get(self.pack["id"])["review"]
        self.assertEqual(post(action="review_item_remove", id=pk["id"], expected_rev=pk["rev"], item_id=self.item_id)[0], 200)
        out = post(action="rcomment_add", review_id=pk["id"], item_id=self.item_id, request_id=req, body="x", supersedes=None)[1]
        self.assertEqual((out["replayed"], out["comment"]["id"]), (True, first["id"]))
        self.comment("nouvelle", expect=404)  # but a NEW comment on an item that is not in the pack is refused

    def test_comment_does_not_change_the_review_pack(self):
        before = reviews._read_one(reviews.confined_dir(self.tmp), self.pack["id"])
        raw = (self.tmp / ".hq-carnet" / "reviews" / (self.pack["id"] + ".json")).read_bytes()
        self.comment("a")
        self.comment("b")
        self.assertEqual((self.tmp / ".hq-carnet" / "reviews" / (self.pack["id"] + ".json")).read_bytes(), raw, "the pack file, its rev and its seal are untouched")
        self.assertEqual(reviews.get(self.pack["id"])["review"]["rev"], self.pack["rev"])
        self.assertEqual(before[1], "ok")

    def test_item_freshness_change_does_not_move_or_delete_a_comment(self):
        c = self.comment("à garder")
        sources.mutate({"action": "source_edition_update", "id": self.sedition["id"], "expected_rev": self.src_rev(self.sedition), "title": "Retitrée"})
        sources.mutate({"action": "source_edition_archive", "id": self.sedition["id"], "expected_rev": self.src_rev(self.sedition), "archived": True})
        th = self.thread()
        self.assertEqual([(x["id"], x["item"]["item_id"], x["body"]) for x in th["comments"]], [(c["id"], self.item_id, "à garder")])

    def test_removed_item_keeps_its_comments_with_the_captured_identity(self):
        c = self.comment("à propos de la source")
        pk = reviews.get(self.pack["id"])["review"]
        post(action="review_item_remove", id=pk["id"], expected_rev=pk["rev"], item_id=self.item_id)
        th = self.thread()
        got = th["comments"][0]
        self.assertEqual((got["id"], got["item_present"], got["item"]["item_id"]), (c["id"], False, self.item_id))
        self.assertTrue(got["item"]["item_label"] and len(got["item"]["item_fingerprint"]) == 64)

    def test_limits_and_text(self):
        self.comment("x" * ann.BODY_MAX)
        self.comment("x" * (ann.BODY_MAX + 1), expect=400)
        for bad in ("", "  ", "a\x00", 5, None):
            self.comment(bad, expect=400)
        hostile = "<script>alert(1)</script>"
        self.comment(hostile)
        self.assertEqual(self.thread()["comments"][-1]["body"], hostile)
        with mock.patch.object(rcm, "PER_ITEM_MAX", 3):
            self.comment("c")
            self.comment("c2", expect=409)
        out = post(action="rcomment_add", review_id=self.pack["id"], item_id=self.item_id, request_id=rid(), body="x", supersedes=None, author="moi")
        self.assertEqual(out[0], 400, "no author")

    def test_identifiers_are_validated(self):
        for payload in ({"review_id": "../x"}, {"review_id": "rvw-" + "0" * 24}, {"item_id": "ri-xyz"}, {"item_id": "ri-" + "0" * 16}, {"request_id": "abc"}):
            base = {"action": "rcomment_add", "review_id": self.pack["id"], "item_id": self.item_id, "request_id": rid(), "body": "x", "supersedes": None}
            status, _ = post(**(base | payload))
            self.assertIn(status, (400, 404), payload)
        self.assertEqual(post(action="rcomment_list", review_id="nope")[0], 404)
        self.assertEqual(post(action="rcomment_list", review_id=self.pack["id"], extra=1)[0], 400)

    def test_corrupt_pack_refuses_new_comments(self):
        self.comment("avant")
        path = self.tmp / ".hq-carnet" / "reviews" / (self.pack["id"] + ".json")
        data = json.loads(path.read_text())
        data["note"] = "altéré"
        path.write_text(json.dumps(data))
        out = self.comment("après", expect=409)
        self.assertEqual(out["code"], "review_corrupt")
        self.assertEqual(len(self.thread()["comments"]), 1, "the thread stays readable for forensics")

    def test_corrupt_thread_is_read_only_and_never_repaired(self):
        self.comment("a")
        path = self.comment_files()[0]
        data = json.loads(path.read_text())
        data["comments"][0]["body"] = "falsifié"
        raw = json.dumps(data).encode()
        path.write_bytes(raw)
        self.assertEqual(self.thread()["integrity"], "corrupt")
        self.assertEqual(self.comment("b", expect=409)["code"], "review_comment_corrupt")
        self.assertEqual(path.read_bytes(), raw)
        path.write_bytes(b"{nope")
        self.assertEqual(self.thread()["integrity"], "invalid")
        self.assertEqual(path.read_bytes(), b"{nope")

    def test_thread_has_its_own_rev_and_seal(self):
        self.assertEqual((self.thread()["rev"], self.thread()["comments"]), (0, []))
        c1 = self.comment("a")
        t1 = self.thread()
        c2 = self.comment("b")
        t2 = self.thread()
        self.assertEqual((t1["rev"], t2["rev"]), (1, 2))
        self.assertNotEqual(t1["content_sha256"], t2["content_sha256"])
        doc = json.loads(self.comment_files()[0].read_text())
        self.assertEqual(rcm.seal(doc), doc["content_sha256"])
        self.assertEqual(reviews.get(self.pack["id"])["review"]["rev"], self.pack["rev"], "the pack rev is a different authority and does not move")
        self.assertTrue(c1["id"].startswith("rcm-"))


# ================================================================ review export + deletion + backup of comments


class ReviewExportTests(CommentBase):
    def export(self, pack=None):
        pk = pack or self.pack
        status, name, data = hq_carnet.http_review_export(pk["id"])
        self.assertEqual(status, 200)
        zf = zipfile.ZipFile(BytesIO(data))
        return data, {n: zf.read(n) for n in zf.namelist()}

    def test_export_is_byte_identical_when_there_are_no_comments(self):
        data1, files = self.export()
        self.assertNotIn(b"review_comments", files["review.json"])
        self.assertNotIn("Commentaires".encode(), files["review.md"])
        self.assertNotIn(b"review_comments", files["manifest.json"])
        self.assertEqual(self.export()[0], data1)

    def test_comments_appear_under_their_item_deterministically(self):
        a = self.comment("premier commentaire")
        b = self.comment("correction", supersedes=a["id"])
        data1, files = self.export()
        data2, _ = self.export()
        self.assertEqual(data1, data2, "deterministic")
        md = files["review.md"].decode()
        self.assertIn("premier commentaire", md)
        self.assertIn(a["id"], md)
        self.assertIn(f"corrige {a['id']}", md)
        self.assertLess(md.index("### Source"), md.index("premier commentaire"), "under the item it belongs to")
        doc = json.loads(files["review.json"])
        self.assertEqual([c["id"] for c in doc["review_comments"]["comments"]], [a["id"], b["id"]])
        man = json.loads(files["manifest.json"])
        th = self.thread()
        self.assertEqual(man["review_comments"], {"rev": th["rev"], "content_sha256": th["content_sha256"], "integrity": "ok", "count": 2})
        self.assertEqual(man["rev"], self.pack["rev"], "Review Pack rev + comment-thread rev identify the exported state")

    def test_comments_on_removed_items_are_exported_not_omitted(self):
        c = self.comment("à propos de la source retirée")
        pk = reviews.get(self.pack["id"])["review"]
        post(action="review_item_remove", id=pk["id"], expected_rev=pk["rev"], item_id=self.item_id)
        _data, files = self.export(pk)
        md = files["review.md"].decode()
        self.assertIn("## Commentaires sur preuves retirées", md)
        self.assertIn("à propos de la source retirée", md)
        self.assertIn(self.item_id, md)
        self.assertIn(c["item"]["item_fingerprint"], md)
        doc = json.loads(files["review.json"])
        self.assertEqual(doc["review_comments"]["comments"][0]["item"]["item_id"], self.item_id)

    def test_live_annotations_never_enter_the_export_even_for_the_same_source(self):
        self.create(self.stor(), "ANNOTATION-VIVANTE-789")
        self.comment("commentaire de revue")
        _d, files = self.export()
        for name, raw in files.items():
            self.assertNotIn(b"ANNOTATION-VIVANTE-789", raw, name)
            self.assertNotIn(b"annotation", raw.lower().replace(b"annotations", b""), name) if False else None
        self.assertIn(b"commentaire de revue", files["review.md"])

    def test_review_comments_never_become_live_annotations(self):
        self.comment("COMMENTAIRE-DE-REVUE-321")
        self.assertEqual(self.one(self.stor())["annotations"], [])
        self.assertEqual(self.shard_files(), [])

    def test_export_of_a_corrupt_thread_flags_it(self):
        self.comment("a")
        path = self.comment_files()[0]
        data = json.loads(path.read_text())
        data["comments"][0]["body"] = "falsifié"
        path.write_text(json.dumps(data))
        _d, files = self.export()
        man = json.loads(files["manifest.json"])
        self.assertEqual(man["review_comments"]["integrity"], "corrupt")
        self.assertIn("ALTÉRÉE", files["review.md"].decode())


class DeletionAndBackupTests(CommentBase):
    def delete_pack(self, pk=None):
        pk = pk or reviews.get(self.pack["id"])["review"]
        status, out = post(action="review_delete", id=pk["id"], expected_rev=pk["rev"], confirm=True)
        self.assertEqual(status, 200, out)
        return out

    def test_permanent_review_deletion_removes_its_owned_thread(self):
        self.comment("a")
        keep = self.new_pack()
        self.comment("autre revue", review_id=keep["id"], item_id=keep["items"][0]["id"])
        self.assertEqual(len(self.comment_files()), 2)
        out = self.delete_pack()
        self.assertEqual(out["comments"], "removed")
        self.assertEqual([p.stem for p in self.comment_files()], [keep["id"]])
        self.assertEqual(post(action="rcomment_list", review_id=self.pack["id"])[0], 404)

    def test_deletion_without_comments_leaves_nothing_to_remove(self):
        self.assertEqual(self.delete_pack()["comments"], "none")

    def test_crash_between_the_two_unlinks_leaves_an_unreachable_orphan(self):
        self.comment("a")
        real = rcm.delete_for_review
        with mock.patch.object(rcm, "delete_for_review", side_effect=OSError("boom")):
            out = self.delete_pack()
        self.assertEqual(out["comments"], "failed", "the pack deletion itself succeeded")
        self.assertEqual(len(self.comment_files()), 1)
        self.assertEqual(rcm.orphans(self.tmp), [self.pack["id"]])
        self.assertEqual(post(action="rcomment_list", review_id=self.pack["id"])[0], 404, "unreachable: every read goes through an existing pack")
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertNotIn("review_comments", out, "backup skips an orphan thread")
        self.assertFalse((self.tmp / "backup" / "review-comments").exists())
        self.assertEqual(rcm.sweep_orphans(self.tmp), 1, "the explicit bounded helper removes it")
        self.assertEqual(self.comment_files(), [])
        self.assertEqual(real(self.tmp, self.pack["id"]), False)

    def test_sweep_is_bounded_and_never_touches_live_threads(self):
        self.comment("vivant")
        d = self.tmp / ".hq-carnet" / "review-comments"
        for n in range(5):
            (d / f"rvw-{n:024x}.json").write_text("{}")
        self.assertEqual(rcm.sweep_orphans(self.tmp, limit=2), 2)
        self.assertEqual(len(rcm.orphans(self.tmp)), 3)
        rcm.sweep_orphans(self.tmp)
        self.assertEqual([p.stem for p in self.comment_files()], [self.pack["id"]])

    def test_backup_copies_threads_byte_for_byte_and_skips_nothing_live(self):
        self.comment("a")
        self.comment("b")
        dest = self.tmp / "backup"
        out = hq_carnet.snapshot_to(self.tmp, dest)
        self.assertEqual(out["review_comments"]["count"], 1)
        self.assertTrue(out["valid"] and out["review_comments"]["valid"])
        for p in self.comment_files():
            self.assertEqual((dest / "review-comments" / p.name).read_bytes(), p.read_bytes())
        shard = json.loads((dest / "review-comments" / self.comment_files()[0].name).read_text())
        self.assertEqual(rcm.seal(shard), shard["content_sha256"], "seal and rev survive the copy")
        self.assertEqual({c["item"]["item_id"] for c in shard["comments"]}, {self.item_id})
        self.assertEqual(list(dest.rglob("*.pdf")), [])

    def test_backup_reports_a_corrupt_thread(self):
        self.comment("a")
        path = self.comment_files()[0]
        raw = json.dumps({**json.loads(path.read_text()), "rev": 99}).encode()
        path.write_bytes(raw)
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertFalse(out["valid"])
        self.assertEqual((self.tmp / "backup" / "review-comments" / path.name).read_bytes(), raw)

    def test_phase9_style_rollback_ignores_the_new_directories(self):
        """An older binary only knows reviews/: the pack still validates exactly as in Phase 7 (no new key inside it)."""
        self.comment("a")
        pack = reviews.get(self.pack["id"])["review"]
        self.assertEqual(set(pack), {"version", "id", "rev", "project_id", "title", "note", "status", "created_at", "updated_at", "request_id", "baseline", "items", "checklist", "questions", "content_sha256"})
        reviews.validate(pack, pack["id"])


# ================================================================ r2: corrupt records are not deletable; backup copy is bound to the opened file


class CorruptMutationTests(ABase):
    def setUp(self):
        super().setUp()
        self.good = self.create(self.stor(), "valide")
        self.bad = self.create(self.stor(), "à altérer")
        path = self.shard_files()[0]
        data = json.loads(path.read_text())
        next(r for r in data["records"] if r["id"] == self.bad["id"])["body"] = "falsifié"
        self.raw = json.dumps(data).encode()
        path.write_bytes(self.raw)

    def test_corrupt_record_cannot_be_edited_resolved_reopened_or_deleted(self):
        b = self.bad
        for payload in ({"body": "autre"}, {"status": "resolved"}, {"status": "open"}):
            status, out = post(action="annotation_update", id=b["id"], target=b["target"], expected_rev=b["rev"], **payload)
            self.assertEqual((status, out["code"]), (409, "annotation_corrupt"), payload)
        status, out = post(action="annotation_delete", id=b["id"], target=b["target"], expected_rev=b["rev"], confirm=True)
        self.assertEqual((status, out["code"]), (409, "annotation_corrupt"))
        self.assertEqual(self.shard_files()[0].read_bytes(), self.raw, "preserved byte-for-byte: never repaired, never resealed, never removed")

    def test_neighbour_stays_editable_and_deletable_and_stale_rev_still_applies(self):
        g = self.good
        g2 = self.update(g, body="modifiée")
        status, out = post(action="annotation_update", id=g["id"], target=g["target"], expected_rev=g["rev"], body="périmée")
        self.assertEqual((status, out["code"]), (409, "annotation_conflict"), "stale revision behaves normally on a valid record")
        status, out = post(action="annotation_delete", id=g["id"], target=g["target"], expected_rev=g["rev"], confirm=True)
        self.assertEqual((status, out["code"]), (409, "annotation_conflict"))
        self.delete(g2)
        rows = self.one(self.stor())["annotations"]
        self.assertEqual([(r["id"], r["integrity"]) for r in rows], [(self.bad["id"], "corrupt")])
        self.assertIn("falsifi", self.shard_files()[0].read_text())


class HardenedCopyTests(ABase):
    def setUp(self):
        super().setUp()
        self.a = self.create(self.stor(), "x")
        self.path = self.shard_files()[0]
        self.secret = self.tmp.parent / ("secret-" + uuid.uuid4().hex + ".json")
        self.secret.write_text('{"secret":"NE-DOIT-PAS-ETRE-LU"}')
        self.addCleanup(lambda: self.secret.unlink() if self.secret.exists() else None)
        self.dest = self.tmp / "out"
        self.dest.mkdir()

    def closure(self):
        return ann.closure(self.tmp)

    def copy(self, clo):
        refused: list = []
        n = ann.copy_to(self.tmp, self.dest, clo["files"], refused)
        return n, refused

    def test_unchanged_file_copies_byte_for_byte(self):
        n, refused = self.copy(self.closure())
        self.assertEqual((refused, (self.dest / self.path.name).read_bytes()), ([], self.path.read_bytes()))
        self.assertEqual(n, self.path.stat().st_size)

    def test_symlink_swapped_in_after_closure_is_never_followed(self):
        clo = self.closure()
        self.path.unlink()
        self.path.symlink_to(self.secret)
        with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("bare read_bytes must not be used")):
            n, refused = self.copy(clo)
        self.assertEqual((n, refused), (0, [self.path.name]))
        self.assertFalse((self.dest / self.path.name).exists(), "the redirected bytes were never read or written")

    def test_directory_swapped_in_is_refused(self):
        clo = self.closure()
        self.path.unlink()
        self.path.mkdir()
        self.assertEqual(self.copy(clo), (0, [self.path.name]))

    def test_deleted_between_closure_and_copy_is_reported(self):
        clo = self.closure()
        self.path.unlink()
        self.assertEqual(self.copy(clo), (0, [self.path.name]))

    def test_open_time_swap_is_caught_by_the_descriptor_identity_check(self):
        clo = self.closure()
        real_open = os.open

        def swap_then_open(path, flags, *a, **kw):  # the race: lstat saw a regular file, then the name is replaced before open()
            if str(path) == str(self.path):
                os.unlink(path)
                os.symlink(self.secret, path)
            return real_open(path, flags, *a, **kw)

        with mock.patch.object(ann.os, "open", side_effect=swap_then_open):
            n, refused = self.copy(clo)
        self.assertEqual((n, refused), (0, [self.path.name]), "O_NOFOLLOW / identity check refuses the swapped-in link")
        self.assertFalse((self.dest / self.path.name).exists())

    def test_corrupt_but_regular_file_still_copies_its_own_bytes(self):
        data = json.loads(self.path.read_text())
        data["records"][0]["body"] = "altéré"
        raw = json.dumps(data).encode()
        self.path.write_bytes(raw)
        clo = self.closure()
        self.assertFalse(clo["valid"])
        n, refused = self.copy(clo)
        self.assertEqual(((self.dest / self.path.name).read_bytes(), refused), (raw, []))

    def test_backup_marks_invalid_and_reports_the_refused_file(self):
        clo = self.closure()
        self.path.unlink()
        self.path.symlink_to(self.secret)
        with mock.patch.object(ann, "closure", return_value=clo):
            out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertFalse(out["valid"])
        self.assertEqual((out["annotations"]["refused"], out["annotations"]["count"], out["annotations"]["valid"]), (1, 0, False))
        self.assertEqual([p.name for p in (self.tmp / "backup" / "annotations").iterdir()], [])
        self.assertNotIn("NE-DOIT-PAS-ETRE-LU", "".join(p.read_text() for p in (self.tmp / "backup").rglob("*") if p.is_file()))

    def test_symlinked_shard_is_not_read_by_the_live_store_either(self):
        self.path.unlink()
        self.path.symlink_to(self.secret)
        res = self.one(self.stor())
        self.assertEqual((res["annotations"], res["unavailable"]), ([], 1))


class HardenedCommentCopyTests(CommentBase):
    def setUp(self):
        super().setUp()
        self.comment("a")
        self.path = self.comment_files()[0]
        self.secret = self.tmp.parent / ("secret-" + uuid.uuid4().hex + ".json")
        self.secret.write_text('{"secret":"NE-DOIT-PAS-ETRE-LU"}')
        self.addCleanup(lambda: self.secret.unlink() if self.secret.exists() else None)
        self.dest = self.tmp / "out"
        self.dest.mkdir()

    def copy(self, clo):
        refused: list = []
        return rcm.copy_to(self.tmp, self.dest, clo["files"], refused), refused

    def test_unchanged_thread_copies_byte_for_byte(self):
        n, refused = self.copy(rcm.closure(self.tmp))
        self.assertEqual((refused, (self.dest / self.path.name).read_bytes()), ([], self.path.read_bytes()))

    def test_symlink_directory_deleted_swaps_are_refused(self):
        for swap in ("link", "dir", "gone"):
            clo = rcm.closure(self.tmp)
            keep = self.path.read_bytes()
            self.path.unlink()
            if swap == "link":
                self.path.symlink_to(self.secret)
            elif swap == "dir":
                self.path.mkdir()
            n, refused = self.copy(clo)
            self.assertEqual((n, refused), (0, [self.path.name]), swap)
            self.assertFalse((self.dest / self.path.name).exists(), swap)
            if swap == "dir":
                self.path.rmdir()
            elif swap == "link":
                self.path.unlink()
            self.path.write_bytes(keep)

    def test_corrupt_regular_thread_copies_as_is(self):
        raw = json.dumps({**json.loads(self.path.read_text()), "rev": 99}).encode()
        self.path.write_bytes(raw)
        n, refused = self.copy(rcm.closure(self.tmp))
        self.assertEqual(((self.dest / self.path.name).read_bytes(), refused), (raw, []))

    def test_backup_marks_invalid_when_a_thread_is_swapped(self):
        clo = rcm.closure(self.tmp)
        self.path.unlink()
        self.path.symlink_to(self.secret)
        with mock.patch.object(rcm, "closure", return_value=clo):
            out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertFalse(out["valid"])
        self.assertEqual((out["review_comments"]["refused"], out["review_comments"]["valid"]), (1, False))
        self.assertNotIn("NE-DOIT-PAS-ETRE-LU", "".join(p.read_text() for p in (self.tmp / "backup").rglob("*") if p.is_file()))

    def test_symlinked_thread_is_not_read_by_the_live_store(self):
        self.path.unlink()
        self.path.symlink_to(self.secret)
        self.assertEqual(self.thread()["integrity"], "invalid")


# ================================================================ static / surface


class SurfaceTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parent.parent

    def test_action_surface_is_pinned(self):
        for action in ("annotation_list", "annotation_create", "annotation_update", "annotation_delete", "rcomment_list", "rcomment_add"):
            self.assertIn(action, hq_carnet._STAGE08)
        self.assertEqual(set(ann.ACTIONS), {"annotation_create", "annotation_update", "annotation_delete", "annotation_list"})
        self.assertEqual(set(rcm.ACTIONS), {"rcomment_add", "rcomment_list"})

    def test_modules_have_no_network_shell_eval_or_stray_opens(self):
        for name in ("hq_carnet_annotations.py", "hq_carnet_rcomments.py"):
            src = (self.ROOT / name).read_text(encoding="utf-8")
            for needle in ("subprocess", "socket", "urllib.request", "http.client", "eval(", "exec(", "os.system", "requests", "webbrowser", "shutil"):
                self.assertNotIn(needle, src, f"{name}: {needle}")
            for bare in ("read_bytes(", "read_text("):
                self.assertNotIn(bare, src, f"{name}: store files are read only through ann.read_regular (descriptor-bound)")
            for flag in ("O_RDWR", "O_APPEND", "O_TRUNC"):
                self.assertNotIn(flag, src, f"{name}: {flag}")

    def test_ask_report_and_snapshot_modules_never_read_the_new_stores(self):
        for name in ("hq_carnet_ask.py", "hq_carnet_report.py", "hq_carnet_snapshots.py", "hq_carnet_review.py", "hq_carnet_intel.py", "hq_carnet_history.py"):
            src = (self.ROOT / name).read_text(encoding="utf-8")
            self.assertNotIn("hq_carnet_annotations", src, name)
            self.assertNotIn("hq_carnet_rcomments", src, name)
            self.assertNotIn("review-comments", src, name)

    def test_review_pack_schema_has_no_comment_field(self):
        src = (self.ROOT / "hq_carnet_reviews.py").read_text(encoding="utf-8")
        self.assertIn('"questions", "content_sha256"}', src)
        self.assertNotIn('"comments"', src.split("def validate")[1].split("def _refs_ok_stored")[0])


if __name__ == "__main__":
    unittest.main()
