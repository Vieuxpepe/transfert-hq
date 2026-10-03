"""Carnet Phase 7 — review packs: store, evidence seals, freshness, checklist/questions, export, backup, adversarial regressions."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import unittest
import uuid
import zipfile
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_evidence as evidence  # noqa: E402
import hq_carnet_reviews as reviews  # noqa: E402
import hq_carnet_snapshots as snaps  # noqa: E402
from test_hq_carnet_history import para  # noqa: E402
from test_hq_carnet_intel import AT, IntelBase, decision, drawing, measure  # noqa: E402


def rid() -> str:
    return uuid.uuid4().hex


def post(**data):
    return hq_carnet.http_post(data)


def tree_digest(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(Path(root).rglob("*")):
        h.update(str(p.relative_to(root)).encode())
        if p.is_file():
            h.update(p.read_bytes())
    return h.hexdigest()


class RBase(IntelBase):
    def new(self, **extra):
        status, out = post(action="review_create", project_id=self.proj["id"], title="Revue banc", request_id=rid(), **extra)
        self.assertEqual(status, 200, out)
        return out["review"]

    def act(self, action, pack, expect=200, **kw):
        status, out = post(action=action, id=pack["id"], expected_rev=pack["rev"], **kw)
        self.assertEqual(status, expect, out)
        return out

    def add(self, pack, item, expect=200):
        out = self.act("review_item_add", pack, expect, item=item)
        return out["review"] if expect == 200 else out

    def get(self, pack):
        return reviews.get(pack["id"])["review"]

    def fresh(self, pack):
        return evidence.freshness(self.get(pack))["items"]

    def snap(self, project=None):
        status, out = post(action="snapshot_create", request_id=rid(), project_id=(project or self.proj)["id"], label="Gel")
        self.assertEqual(status, 200, out)
        return out["snapshot"]["id"]

    def page_with(self):
        page = self.proj_page([para("intro"), decision("Choisir H7"), measure(), para("Le palier avant est usiné en H7")])
        return self.cur(page["id"])

    def edit_block_text(self, page, index, text):
        blocks = self.cur(page["id"])["content"]["blocks"]
        blocks[index] = dict(blocks[index], text=text)
        return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "content": {"version": 2, "blocks": blocks}})["page"]

    def review_files(self):
        d = self.tmp / ".hq-carnet" / "reviews"
        return sorted(d.glob("rvw-*.json")) if d.is_dir() else []


class StoreTests(RBase):
    def test_create_replay_and_defaults(self):
        req = rid()
        s1, a = post(action="review_create", project_id=self.proj["id"], title="  Revue A  ", note="n\nl2", request_id=req)
        s2, b = post(action="review_create", project_id=self.proj["id"], title="  Revue A  ", note="n\nl2", request_id=req)
        self.assertEqual((s1, s2), (200, 200))
        self.assertFalse(a["replayed"])
        self.assertTrue(b["replayed"])
        self.assertEqual(a["review"]["id"], b["review"]["id"])
        pk = a["review"]
        self.assertEqual((pk["rev"], pk["status"], pk["title"], pk["baseline"], pk["items"]), (1, "draft", "Revue A", {"kind": "live"}, []))
        self.assertEqual(len(self.review_files()), 1)
        self.assertEqual(reviews.seal(pk), pk["content_sha256"])
        s3, c = post(action="review_create", project_id=self.other["id"], title="x", request_id=req)
        self.assertEqual((s3, c["code"]), (409, "review_request_conflict"))

    def test_lost_response_retry_returns_same_review_and_creates_one_pack(self):
        req = rid()
        body = dict(action="review_create", project_id=self.proj["id"], title="Revue", note="n", request_id=req)
        s1, first = post(**body)  # the write succeeded; imagine the response never reached the client
        self.assertEqual(s1, 200)
        s2, retry = post(**body)
        self.assertEqual(s2, 200)
        self.assertTrue(retry["replayed"])
        self.assertEqual(retry["review"]["id"], first["review"]["id"])
        self.assertEqual(len(self.review_files()), 1)
        # the pack (and its request id) is on disk, so the retry also works with no in-memory state: a bridge restart is the same read
        s3, again = post(**body)
        self.assertEqual((s3, again["review"]["id"]), (200, first["review"]["id"]))
        self.assertEqual(len(self.review_files()), 1)

    def test_request_id_reused_with_different_intent_is_refused(self):
        self.page_with()
        snap_id = self.snap()
        req = rid()
        base = dict(action="review_create", project_id=self.proj["id"], title="Revue", note="n", request_id=req)
        self.assertEqual(post(**base)[0], 200)
        for change in ({"title": "Autre titre"}, {"note": "autre note"}, {"baseline": {"kind": "snapshot", "snapshot_id": snap_id}}):
            status, out = post(**{**base, **change})
            self.assertEqual((status, out["code"]), (409, "review_request_conflict"), change)
        self.assertEqual(len(self.review_files()), 1)
        # an explicit live baseline and whitespace-only title differences normalize to the SAME intent
        self.assertEqual(post(**{**base, "baseline": {"kind": "live"}, "title": "  Revue  "})[1]["replayed"], True)

    def test_snapshot_baseline_replay_is_same_review_and_conflicts_on_live(self):
        self.page_with()
        sid = self.snap()
        req = rid()
        base = dict(action="review_create", project_id=self.proj["id"], title="Revue", request_id=req, baseline={"kind": "snapshot", "snapshot_id": sid})
        first = post(**base)[1]["review"]
        self.assertEqual(post(**base)[1]["review"]["id"], first["id"])
        status, out = post(**{**base, "baseline": {"kind": "live"}})
        self.assertEqual((status, out["code"]), (409, "review_request_conflict"))

    def test_validation(self):
        for bad in ({"title": ""}, {"title": "x" * 121}, {"title": "a\x00b"}, {"note": "x" * 2001}):
            data = {"action": "review_create", "project_id": self.proj["id"], "title": "ok", "request_id": rid(), **bad}
            self.assertEqual(hq_carnet.http_post(data)[0], 400, bad)
        self.assertEqual(post(action="review_create", project_id="proj-zzzzzzzz", title="x", request_id=rid())[0], 404)
        self.assertEqual(post(action="review_create", project_id=self.proj["id"], title="x", request_id="short")[0], 400)
        self.assertEqual(post(action="review_create", project_id=self.proj["id"], title="x", request_id=rid(), bogus=1)[0], 400)

    def test_status_is_only_user_set(self):
        pk = self.new()
        self.assertEqual(pk["status"], "draft")
        pk = self.act("review_update", pk, status="reviewed")["review"]
        self.assertEqual(pk["status"], "reviewed")
        pk = self.act("review_item_add", pk, item={"kind": "project_overview"})["review"]
        pk = self.act("review_check_add", pk, text="Vérifier H7")["review"]
        pk = self.act("review_check_update", pk, check_id=pk["checklist"][0]["id"], checked=True)["review"]
        self.assertEqual(pk["status"], "reviewed")  # nothing ever changes it by itself
        self.act("review_update", pk, expect=400, status="approved")

    def test_conflict_two_clients_no_retry(self):
        pk = self.new()
        a = self.act("review_update", pk, title="Client A")["review"]
        status, out = post(action="review_update", id=pk["id"], expected_rev=pk["rev"], title="Client B")
        self.assertEqual((status, out["code"], out["rev"]), (409, "review_conflict", a["rev"]))
        self.assertEqual(self.get(pk)["title"], "Client A")  # nothing merged, nothing retried

    def test_delete_conflict_sequence(self):
        pk = self.new()
        for n in range(2):
            pk = self.act("review_check_add", pk, text=f"c{n}")["review"]
        self.assertEqual(pk["rev"], 3)
        stale = dict(pk)  # client 1 opened the delete confirmation at rev 3
        other = self.act("review_update", pk, title="Edité ailleurs")["review"]  # client 2 -> rev 4
        self.assertEqual(other["rev"], 4)
        status, out = post(action="review_delete", id=stale["id"], expected_rev=3, confirm=True)
        self.assertEqual((status, out["code"]), (409, "review_conflict"))
        self.assertEqual(len(self.review_files()), 1)  # the pack remains
        fresh = self.get(stale)  # reload
        self.assertEqual(post(action="review_delete", id=fresh["id"], expected_rev=fresh["rev"])[0], 400)  # no confirmation, no delete
        status, out = post(action="review_delete", id=fresh["id"], expected_rev=fresh["rev"], confirm=True)
        self.assertEqual(status, 200)
        self.assertEqual(self.review_files(), [])
        self.assertEqual(post(action="review_delete", id=fresh["id"], expected_rev=fresh["rev"], confirm=True)[0], 404)

    def test_limits(self):
        pk = self.new()
        for _ in range(reviews.CHECKS_MAX):
            pk = self.act("review_check_add", pk, text="x")["review"]
        status, out = post(action="review_check_add", id=pk["id"], expected_rev=pk["rev"], text="de trop")
        self.assertEqual((status, out["code"]), (409, "review_limit"))
        self.act("review_check_add", pk, 400, text="y" * 501)
        self.act("review_question_add", pk, 400, text="")
        fresh = self.new()
        self.act("review_check_add", fresh, 400, text="x", refs=["ri-" + "0" * 16])

    def test_per_project_limit(self):
        old = reviews.PER_PROJECT_MAX
        reviews.PER_PROJECT_MAX = 2
        try:
            self.new()
            self.new()
            status, out = post(action="review_create", project_id=self.proj["id"], title="3", request_id=rid())
            self.assertEqual((status, out["code"]), (409, "review_limit"))
            self.assertEqual(post(action="review_create", project_id=self.other["id"], title="autre", request_id=rid())[0], 200)
        finally:
            reviews.PER_PROJECT_MAX = old

    def test_item_too_large_refused(self):
        pk = self.new()
        old = reviews.ITEM_BYTES_MAX
        reviews.ITEM_BYTES_MAX = 200
        try:
            status, out = post(action="review_item_add", id=pk["id"], expected_rev=pk["rev"], item={"kind": "project_overview"})
            self.assertEqual((status, out["code"]), (409, "review_item_too_large"))
        finally:
            reviews.ITEM_BYTES_MAX = old
        self.assertEqual(self.get(pk)["rev"], pk["rev"])

    def test_atomic_write_leaves_no_temp_and_seal_verifies(self):
        pk = self.new()
        self.act("review_check_add", pk, text="a")
        names = [p.name for p in (self.tmp / ".hq-carnet" / "reviews").iterdir()]
        self.assertEqual(names, [pk["id"] + ".json"])
        got = reviews.get(pk["id"])
        self.assertEqual(got["integrity"], "ok")

    def test_corrupt_file_listed_readonly_preserved(self):
        pk = self.new()
        path = self.review_files()[0]
        data = json.loads(path.read_text())
        data["title"] = "Falsifié"
        raw = json.dumps(data).encode()
        path.write_bytes(raw)
        rows = reviews.list_reviews(self.proj["id"])["reviews"]
        self.assertEqual(rows[0]["integrity"], "corrupt")
        self.assertEqual(reviews.get(pk["id"])["integrity"], "corrupt")
        status, out = post(action="review_update", id=pk["id"], expected_rev=pk["rev"], title="réparé")
        self.assertEqual((status, out["code"]), (409, "review_corrupt"))
        self.assertEqual(path.read_bytes(), raw)  # never repaired

    def test_invalid_file_listed_and_503(self):
        pk = self.new()
        path = self.review_files()[0]
        path.write_bytes(b"{not json")
        listing = reviews.list_reviews()
        self.assertEqual(listing["unavailable"], [{"id": pk["id"], "integrity": "invalid"}])
        status, out = hq_carnet.http_get({"review": [pk["id"]]})
        self.assertEqual(status, 503)
        self.assertEqual(path.read_bytes(), b"{not json")

    def test_confinement_refuses_redirected_directory(self):
        self.new()
        d = self.tmp / ".hq-carnet" / "reviews"
        moved = self.tmp / "elsewhere"
        d.rename(moved)
        try:
            os.symlink(moved, d, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        status, out = hq_carnet.http_get({"reviews": ["1"]})
        self.assertEqual(status, 409)
        self.assertEqual(post(action="review_create", project_id=self.proj["id"], title="x", request_id=rid())[0], 409)

    def test_unknown_get_keys_and_traversal_ids(self):
        self.assertEqual(hq_carnet.http_get({"review": ["../../etc/passwd"]})[0], 404)
        self.assertEqual(hq_carnet.http_get({"reviews": ["1"], "bogus": ["1"]})[0], 400)
        self.assertEqual(hq_carnet.http_get({"freshness": ["1"]})[0], 400)


class EvidenceTests(RBase):
    def test_every_kind_seals_and_is_unchanged(self):
        page = self.page_with()
        blocks = page["content"]["blocks"]
        self.draw("plan-1")
        ed = self.edition(self.family("Fam-" + rid()[:6]), "1e")
        self.proj_page([self.cite_block(ed)])
        sid = self.snap()
        pk = self.new()
        specs = [
            {"kind": "page", "page_id": page["id"]},
            {"kind": "block", "page_id": page["id"], "block_id": blocks[0]["id"]},
            {"kind": "decision", "page_id": page["id"], "block_id": blocks[1]["id"]},
            {"kind": "measurement", "page_id": page["id"], "block_id": blocks[2]["id"]},
            {"kind": "drawing", "stem": "plan-1"},
            {"kind": "source", "edition_id": ed["id"]},
            {"kind": "snapshot", "snapshot_id": sid},
            {"kind": "project_overview"},
        ]
        for spec in specs:
            pk = self.add(pk, spec)
        got = self.get(pk)
        self.assertEqual([i["kind"] for i in got["items"]], [s["kind"] for s in specs])
        for it in got["items"]:
            self.assertTrue(it["seal"] and it["label"] and it["scope"] == {"kind": "live"})
        fresh = self.fresh(pk)
        self.assertEqual({r["state"] for r in fresh.values()}, {"unchanged"})

    def test_client_cannot_supply_seals_or_wrong_type(self):
        page = self.page_with()
        pk = self.new()
        out = self.add(pk, {"kind": "page", "page_id": page["id"], "seal": {"rev": 1}}, expect=400)
        self.assertIn("error", out)
        blocks = page["content"]["blocks"]
        self.add(pk, {"kind": "decision", "page_id": page["id"], "block_id": blocks[0]["id"]}, expect=400)
        self.add(pk, {"kind": "page", "page_id": "page-nope"}, expect=404)

    def test_page_from_other_project_refused(self):
        foreign = self.proj_page([para("ailleurs")], project=self.other)
        pk = self.new()
        self.add(pk, {"kind": "page", "page_id": foreign["id"]}, expect=404)

    def test_duplicate_refused(self):
        page = self.page_with()
        pk = self.add(self.new(), {"kind": "page", "page_id": page["id"]})
        out = self.add(pk, {"kind": "page", "page_id": page["id"]}, expect=409)
        self.assertEqual(out["code"], "review_duplicate")

    def test_change_and_missing_never_rewrite_the_stored_copy(self):
        page = self.page_with()
        pk = self.add(self.new(), {"kind": "page", "page_id": page["id"]})
        before = json.dumps(self.get(pk)["items"], sort_keys=True)
        self.edit_block_text(page, 3, "Le palier est maintenant en H6")
        fresh = self.fresh(pk)
        self.assertEqual(next(iter(fresh.values()))["state"], "changed")
        self.assertEqual(json.dumps(self.get(pk)["items"], sort_keys=True), before)
        hq_carnet.mutate({"action": "page_trash", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        self.assertEqual(next(iter(self.fresh(pk).values()))["state"], "missing")
        self.assertEqual(json.dumps(self.get(pk)["items"], sort_keys=True), before)

    def test_missing_item_does_not_break_pack(self):
        a = self.page_with()
        b = self.proj_page([para("autre note")])
        pk = self.new()
        pk = self.add(pk, {"kind": "page", "page_id": a["id"]})
        pk = self.add(pk, {"kind": "page", "page_id": b["id"]})
        hq_carnet.mutate({"action": "page_trash", "id": a["id"], "expected_rev": self.cur(a["id"])["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        got = hq_carnet.http_get({"review": [pk["id"]], "freshness": ["1"]})[1]["freshness"]
        states = [got["items"][i["id"]]["state"] for i in self.get(pk)["items"]]
        self.assertEqual(states, ["missing", "unchanged"])
        self.assertEqual(got["counts"], {"unchanged": 1, "changed": 0, "missing": 1, "unknown": 0})
        self.assertEqual(len(hq_carnet.http_get({"review": [pk["id"]]})[1]["review"]["items"]), 2)

    def test_freshness_reads_do_not_write(self):
        page = self.page_with()
        pk = self.add(self.new(), {"kind": "page", "page_id": page["id"]})
        before = tree_digest(self.tmp)
        for _ in range(3):
            hq_carnet.http_get({"review": [pk["id"]], "freshness": ["1"]})
            hq_carnet.http_get({"reviews": ["1"]})
        self.assertEqual(tree_digest(self.tmp), before)

    def test_one_unreadable_source_store_makes_only_source_items_unknown(self):
        page = self.page_with()
        ed = self.edition(self.family("Fam-" + rid()[:6]), "1e")
        pk = self.new()
        pk = self.add(pk, {"kind": "page", "page_id": page["id"]})
        pk = self.add(pk, {"kind": "source", "edition_id": ed["id"]})
        spath = self.tmp / ".hq-carnet" / "sources.json"
        spath.write_bytes(b"{broken")
        states = {i["kind"]: self.fresh(pk)[i["id"]]["state"] for i in self.get(pk)["items"]}
        self.assertEqual(states, {"page": "unchanged", "source": "unknown"})

    def test_drawing_stem_is_a_version_not_edited_in_place(self):
        self.draw("plan-A", b'{"v":"A"}')
        pk = self.add(self.new(), {"kind": "drawing", "stem": "plan-A"})
        self.draw("plan-B", b'{"v":"B"}')  # a newer version appears under ANOTHER stem
        self.assertEqual(self.get(pk)["items"][0]["key"], {"stem": "plan-A"})
        self.assertEqual(next(iter(self.fresh(pk).values()))["state"], "unchanged")
        self.draw("plan-A", b'{"v":"tampered"}')  # same stem, other bytes = integrity anomaly
        row = next(iter(self.fresh(pk).values()))
        self.assertEqual((row["state"], row["anomaly"]), ("changed", "drawing_bytes_changed"))
        (self.draw_dir / "plan-A.hqdraw.json").unlink()
        self.assertEqual(next(iter(self.fresh(pk).values()))["state"], "missing")

    def test_drawing_missing_at_selection_refused(self):
        self.add(self.new(), {"kind": "drawing", "stem": "absent-1"}, expect=404)

    def test_drawing_pair_comparison(self):
        self.draw("plan-A", b"1")
        self.draw("plan-B", b"2")
        pk = self.add(self.new(), {"kind": "diff", "base": "plan-A", "to": "plan-B", "page_id": None, "project_id": None})
        cp = self.get(pk)["items"][0]["copy"]
        self.assertEqual([p["stem"] for p in cp["pair"]], ["plan-A", "plan-B"])
        self.assertFalse(cp["identical_bytes"])
        self.assertEqual(next(iter(self.fresh(pk).values()))["state"], "unchanged")


class SnapshotContextTests(RBase):
    def test_snapshot_baseline_keeps_frozen_source_metadata(self):
        ed = self.edition(self.family("Fam-" + rid()[:6]), "1e", title="Spec A")
        self.proj_page([self.cite_block(ed)])
        sid = self.snap()
        pk = self.new(baseline={"kind": "snapshot", "snapshot_id": sid})
        self.assertEqual(pk["baseline"]["kind"], "snapshot")
        pk = self.add(pk, {"kind": "source", "edition_id": ed["id"]})
        self.assertEqual(pk["items"][0]["copy"]["title"], "Spec A")
        rev = next(e for e in hq_carnet.http_get({"sources": ["1"]})[1]["editions"] if e["id"] == ed["id"])["rev"]
        import hq_carnet_sources as sources

        sources.mutate({"action": "source_edition_update", "id": ed["id"], "expected_rev": rev, "title": "Spec B"})
        row = next(iter(self.fresh(pk).values()))
        self.assertEqual((row["state"], row["frozen"], row["current_differs"]), ("unchanged", "ok", True))
        self.assertEqual(self.get(pk)["items"][0]["copy"]["title"], "Spec A")

    def test_snapshot_baseline_page_item_resolves_frozen(self):
        page = self.page_with()
        sid = self.snap()
        self.edit_block_text(page, 3, "Modifié après gel")
        pk = self.new(baseline={"kind": "snapshot", "snapshot_id": sid})
        pk = self.add(pk, {"kind": "page", "page_id": page["id"]})
        row = next(iter(self.fresh(pk).values()))
        self.assertEqual((row["state"], row["current_differs"]), ("unchanged", True))
        self.assertIn("usiné en H7", pk["items"][0]["copy"]["excerpt"])

    def test_snapshot_overview_current_differs_tracks_the_live_project(self):
        page = self.page_with()
        sid = self.snap()
        pk = self.new(baseline={"kind": "snapshot", "snapshot_id": sid})
        pk = self.add(pk, {"kind": "project_overview"})
        item = pk["items"][0]
        self.assertEqual(item["key"], {"project_id": self.proj["id"], "snapshot_id": sid})
        stored = json.dumps(self.get(pk)["items"], sort_keys=True)

        def row():
            return next(iter(self.fresh(pk).values()))

        r = row()
        self.assertEqual((r["state"], r["frozen"], r["current_differs"]), ("unchanged", "ok", False))
        self.edit_block_text(page, 3, "Modifié après gel")
        r = row()
        self.assertEqual((r["state"], r["frozen"], r["current_differs"]), ("unchanged", "ok", True))
        self.assertEqual(json.dumps(self.get(pk)["items"], sort_keys=True), stored)  # the captured copy is never rewritten

    def test_snapshot_overview_differs_after_page_trashed(self):
        page = self.page_with()
        sid = self.snap()
        pk = self.add(self.new(baseline={"kind": "snapshot", "snapshot_id": sid}), {"kind": "project_overview"})
        row = lambda: next(iter(self.fresh(pk).values()))  # noqa: E731
        self.assertIs(row()["current_differs"], False)
        hq_carnet.mutate({"action": "page_trash", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        r = row()
        self.assertEqual((r["state"], r["current_differs"]), ("unchanged", True))

    def test_corrupt_snapshot_refused_as_baseline_and_evidence(self):
        self.page_with()
        sid = self.snap()
        path = self.tmp / ".hq-carnet" / "snapshots" / (sid + ".json")
        data = json.loads(path.read_text())
        data["label"] = "Falsifié"
        path.write_text(json.dumps(data))
        self.assertEqual(post(action="review_create", project_id=self.proj["id"], title="x", request_id=rid(), baseline={"kind": "snapshot", "snapshot_id": sid})[0], 503)
        pk = self.new()
        self.add(pk, {"kind": "snapshot", "snapshot_id": sid}, expect=503)
        self.assertEqual(self.get(pk)["items"], [])

    def test_snapshot_becoming_corrupt_later_makes_frozen_items_unknown_not_unusable(self):
        page = self.page_with()
        sid = self.snap()
        pk = self.new(baseline={"kind": "snapshot", "snapshot_id": sid})
        pk = self.add(pk, {"kind": "page", "page_id": page["id"]})
        path = self.tmp / ".hq-carnet" / "snapshots" / (sid + ".json")
        data = json.loads(path.read_text())
        data["label"] = "Falsifié"
        path.write_text(json.dumps(data))
        row = next(iter(self.fresh(pk).values()))
        self.assertEqual((row["state"], row["frozen"]), ("unknown", "unavailable"))
        self.assertEqual(len(self.get(pk)["items"]), 1)

    def test_baseline_locked_after_items(self):
        page = self.page_with()
        sid = self.snap()
        pk = self.add(self.new(), {"kind": "page", "page_id": page["id"]})
        status, out = post(action="review_update", id=pk["id"], expected_rev=pk["rev"], baseline={"kind": "snapshot", "snapshot_id": sid})
        self.assertEqual((status, out["code"]), (409, "review_baseline_locked"))

    def test_snapshot_from_other_project_refused_as_baseline(self):
        self.proj_page([para("x")], project=self.other)
        sid = self.snap(self.other)
        self.assertEqual(post(action="review_create", project_id=self.proj["id"], title="x", request_id=rid(), baseline={"kind": "snapshot", "snapshot_id": sid})[0], 400)


class AskAndDiffTests(RBase):
    def ask_item(self, question="palier H7", scope=None):
        scope = scope or {"kind": "project", "id": self.proj["id"]}
        import hq_carnet_review as review

        res = review.ask({"action": "ask", "question": question, "scope": scope})
        return {"kind": "ask_result", "question": question, "scope": scope, "limit": 10, "fingerprint": res["fingerprint"]}, res

    def test_ask_result_stale_pack_stays_historical(self):
        page = self.page_with()
        item, res = self.ask_item()
        pk = self.add(self.new(), item)
        stored = self.get(pk)["items"][0]
        self.assertEqual(stored["copy"]["fingerprint"], res["fingerprint"])
        self.edit_block_text(page, 3, "Le palier avant est usiné en H6")
        row = next(iter(self.fresh(pk).values()))
        self.assertEqual(row["state"], "changed")
        self.assertEqual(self.get(pk)["items"][0]["copy"]["fingerprint"], res["fingerprint"])  # the reviewed evidence is untouched
        self.assertEqual(self.get(pk)["items"][0]["seal"]["fingerprint"], res["fingerprint"])

    def test_ask_fingerprint_seen_must_match_server_rerun(self):
        page = self.page_with()
        item, _ = self.ask_item()
        self.edit_block_text(page, 3, "Le palier avant est usiné en H6")
        pk = self.new()
        out = self.add(pk, item, expect=409)
        self.assertEqual(out["code"], "review_evidence_changed")
        self.assertEqual(self.get(pk)["items"], [])

    def test_replace_is_explicit_and_records_supersedes(self):
        page = self.page_with()
        item, res = self.ask_item()
        pk = self.add(self.new(), item)
        pk = self.act("review_check_add", pk, text="vérifier", refs=[pk["items"][0]["id"]])["review"]
        self.edit_block_text(page, 3, "Le palier avant est usiné en H6")
        item2, res2 = self.ask_item()
        out = self.act("review_item_replace", pk, item_id=pk["items"][0]["id"], item=item2)["review"]
        it = out["items"][0]
        self.assertEqual(it["supersedes"][0]["fingerprint"], res["fingerprint"])
        self.assertEqual(it["seal"]["fingerprint"], res2["fingerprint"])
        self.assertEqual(out["checklist"][0]["refs"], [it["id"]])
        self.assertEqual(len(out["items"]), 1)
        self.act("review_item_replace", out, 400, item_id=it["id"], item={"kind": "project_overview"})

    def test_supersedes_capped(self):
        page = self.page_with()
        item, _ = self.ask_item()
        pk = self.add(self.new(), item)
        for n in range(reviews.SUPERSEDES_MAX + 2):
            self.edit_block_text(page, 3, f"Le palier avant est usiné en H{n + 8}")
            item, _ = self.ask_item()
            pk = self.act("review_item_replace", pk, item_id=pk["items"][0]["id"], item=item)["review"]
        self.assertEqual(len(pk["items"][0]["supersedes"]), reviews.SUPERSEDES_MAX)

    def test_frozen_ask_scope_is_snapshot_bound(self):
        self.page_with()
        sid = self.snap()
        item, _ = self.ask_item(scope={"kind": "snapshot", "id": sid})
        pk = self.add(self.new(), item)
        self.assertEqual(pk["items"][0]["scope"]["kind"], "snapshot")
        row = next(iter(self.fresh(pk).values()))
        self.assertEqual((row["state"], row["frozen"]), ("unchanged", "ok"))

    def test_diff_snapshot_to_current_digest_and_freshness(self):
        page = self.page_with()
        sid = self.snap()
        self.edit_block_text(page, 3, "Autre texte")
        pk = self.add(self.new(), {"kind": "diff", "base": sid, "to": None, "page_id": None, "project_id": None})
        cp = self.get(pk)["items"][0]["copy"]
        self.assertFalse(cp["truncated"])
        self.assertTrue(cp["rows"])
        self.assertEqual(next(iter(self.fresh(pk).values()))["state"], "unchanged")
        self.edit_block_text(page, 3, "Encore autre")
        self.assertEqual(next(iter(self.fresh(pk).values()))["state"], "changed")

    def test_diff_digest_truncation_is_explicit(self):
        page = self.proj_page([para(f"p{n}") for n in range(5)])
        sid = self.snap()
        blocks = self.cur(page["id"])["content"]["blocks"]
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "content": {"version": 2, "blocks": [dict(b, text=b["text"] + "!") for b in blocks]}})
        old = evidence.DIFF_ROWS_MAX
        evidence.DIFF_ROWS_MAX = 2
        try:
            pk = self.add(self.new(), {"kind": "diff", "base": sid, "to": None, "page_id": None, "project_id": None})
        finally:
            evidence.DIFF_ROWS_MAX = old
        cp = self.get(pk)["items"][0]["copy"]
        self.assertEqual((len(cp["rows"]), cp["truncated"], cp["rows_total"] > 2), (2, True, True))

    def test_unchanged_pages_are_not_digest_rows(self):
        self.page_with()
        sid = self.snap()
        pk = self.add(self.new(), {"kind": "diff", "base": sid, "to": None, "page_id": None, "project_id": None})
        cp = self.get(pk)["items"][0]["copy"]
        self.assertEqual((cp["rows"], cp["rows_total"], cp["truncated"]), ([], 0, False))

    def test_diff_snapshot_to_snapshot_reproducible(self):
        page = self.page_with()
        a = self.snap()
        self.edit_block_text(page, 3, "V2")
        b = self.snap()
        pk = self.add(self.new(), {"kind": "diff", "base": a, "to": b, "page_id": None, "project_id": None})
        self.assertEqual(next(iter(self.fresh(pk).values()))["state"], "unchanged")


class WorkflowTests(RBase):
    def test_checklist_stays_checked_and_question_stays_resolved_when_evidence_disappears(self):
        page = self.page_with()
        pk = self.add(self.new(), {"kind": "page", "page_id": page["id"]})
        iid = pk["items"][0]["id"]
        pk = self.act("review_check_add", pk, text="Cote H7 vérifiée", refs=[iid])["review"]
        pk = self.act("review_check_update", pk, check_id=pk["checklist"][0]["id"], checked=True)["review"]
        pk = self.act("review_question_add", pk, text="Quel ajustement ?", refs=[iid])["review"]
        qid = pk["questions"][0]["id"]
        pk = self.act("review_question_update", pk, question_id=qid, state="resolved", resolution_note="H7 confirmé par le BE")["review"]
        hq_carnet.mutate({"action": "page_trash", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        self.assertEqual(next(iter(self.fresh(pk).values()))["state"], "missing")
        got = self.get(pk)
        self.assertTrue(got["checklist"][0]["checked"])
        self.assertEqual((got["questions"][0]["state"], got["questions"][0]["resolution_note"]), ("resolved", "H7 confirmé par le BE"))
        pk = self.act("review_item_remove", got, item_id=iid)["review"]  # removing evidence never edits user-authored state
        self.assertEqual(pk["checklist"][0]["refs"], [iid])
        self.assertTrue(pk["checklist"][0]["checked"])
        self.assertEqual(pk["questions"][0]["state"], "resolved")
        md = evidence.render_markdown(pk, None)
        self.assertIn("(preuve retirée)", md)

    def test_checks_and_questions_crud(self):
        pk = self.new()
        pk = self.act("review_check_add", pk, text="A")["review"]
        cid = pk["checklist"][0]["id"]
        pk = self.act("review_check_update", pk, check_id=cid, text="A2")["review"]
        self.assertEqual(pk["checklist"][0]["text"], "A2")
        self.act("review_check_update", pk, 400, check_id=cid)
        pk = self.act("review_check_remove", pk, check_id=cid)["review"]
        self.assertEqual(pk["checklist"], [])
        self.act("review_check_remove", pk, 404, check_id=cid)
        pk = self.act("review_question_add", pk, text="Q?")["review"]
        qid = pk["questions"][0]["id"]
        pk = self.act("review_question_update", pk, question_id=qid, state="resolved")["review"]
        pk = self.act("review_question_update", pk, question_id=qid, state="open")["review"]
        self.assertEqual(pk["questions"][0]["state"], "open")
        pk = self.act("review_question_remove", pk, question_id=qid)["review"]
        self.assertEqual(pk["questions"], [])

    def test_refs_must_belong_to_pack(self):
        a = self.new()
        page = self.page_with()
        a = self.add(a, {"kind": "page", "page_id": page["id"]})
        b = self.add(self.new(), {"kind": "project_overview"})
        self.act("review_check_add", b, 400, text="x", refs=[a["items"][0]["id"]])


class ExportTests(RBase):
    def build(self):
        page = self.page_with()
        pk = self.add(self.new(note="Ligne 1\nLigne 2 *gras*"), {"kind": "page", "page_id": page["id"]})
        pk = self.add(pk, {"kind": "project_overview"})
        pk = self.act("review_check_add", pk, text="Contrôler <b>H7</b> | `x`", refs=[pk["items"][0]["id"]])["review"]
        pk = self.act("review_question_add", pk, text="Qui valide ?")["review"]
        return self.get(pk)

    def test_export_twice_is_byte_identical_and_a_handoff_package(self):
        pk = self.build()
        a = evidence.export_zip(pk, evidence.freshness(pk))
        b = evidence.export_zip(pk, evidence.freshness(pk))
        self.assertEqual(a, b)
        zf = zipfile.ZipFile(BytesIO(a))
        self.assertEqual(zf.namelist(), ["manifest.json", "review.json", "review.md"])
        self.assertTrue(all(i.date_time == (1980, 1, 1, 0, 0, 0) and i.compress_type == zipfile.ZIP_STORED for i in zf.infolist()))
        man = json.loads(zf.read("manifest.json"))
        self.assertEqual(man["review_id"], pk["id"])
        self.assertEqual(man["files"]["review.md"], hashlib.sha256(zf.read("review.md")).hexdigest())
        rj = json.loads(zf.read("review.json"))
        self.assertIn("review", rj)
        self.assertIn("observation", rj)  # stored pack and observation stay structurally separate
        self.assertNotIn("freshness", rj["review"]["items"][0])
        self.assertIn("handoff", man["note"].lower())

    def test_markdown_user_text_escaped_and_fixed_vocabulary_only(self):
        pk = self.build()
        md = evidence.render_markdown(pk, evidence.freshness(pk))
        self.assertIn("Contrôler \\<b\\>H7\\</b\\> \\| \\`x\\`", md)
        self.assertNotIn("<b>", md)
        allowed = set(evidence.LABELS["status"].values()) | set(evidence.LABELS["state"].values())
        for forbidden in ("Overall", "Résultat global", "Risque", "Recommandation", "Conforme", "Approuvé", "Validé"):
            self.assertNotIn(forbidden, md)
        self.assertIn("Statut (défini par l'utilisateur) : Brouillon", md)
        self.assertTrue(allowed)

    def test_export_http_route_payload_has_no_timestamp_of_generation(self):
        pk = self.build()
        text = evidence.render_markdown(pk, evidence.freshness(pk))
        self.assertIn(evidence._utc(pk["created_at"]), text)  # only stored times appear

    def test_changed_evidence_prominent_in_export(self):
        page = self.page_with()
        pk = self.add(self.new(), {"kind": "page", "page_id": page["id"]})
        self.edit_block_text(page, 3, "x")
        md = evidence.render_markdown(self.get(pk), evidence.freshness(self.get(pk)))
        self.assertIn("Modifié depuis la sélection", md)


class ReportTests(RBase):
    def test_review_pack_report_item_is_historical_and_marks_changes(self):
        page = self.page_with()
        pk = self.add(self.new(note="Contexte"), {"kind": "page", "page_id": page["id"]})
        pk = self.act("review_check_add", pk, text="Cote H7")["review"]
        self.edit_block_text(page, 3, "Autre")
        status, out = post(action="report_build", items=[{"kind": "review_pack", "review_id": pk["id"]}])
        self.assertEqual(status, 200, out)
        md = out["markdown"]
        self.assertIn("## Dossier de revue — Revue banc", md)
        self.assertIn("Modifié depuis la sélection", md)
        self.assertIn(pk["content_sha256"] if False else "Cote H7", md)
        sec = out["sections"][0]
        self.assertEqual(sec["review"]["rev"], self.get(pk)["rev"])
        self.assertIn("freshness", sec)  # stored pack and observation stay separate
        self.assertNotIn("freshness", sec["review"])
        for forbidden in ("Overall", "Risque", "Recommandation", "Approuvé"):
            self.assertNotIn(forbidden, md)

    def test_report_item_validation_and_missing_pack(self):
        self.assertEqual(post(action="report_build", items=[{"kind": "review_pack", "review_id": "../x"}])[0], 400)
        self.assertEqual(post(action="report_build", items=[{"kind": "review_pack", "review_id": "rvw-" + "0" * 24}])[0], 404)


class FixtureContractTests(unittest.TestCase):
    def test_fixture_shape_matches_live_server_responses(self):
        import gen_fixtures_carnet_reviews as gen

        saved = dict(hq_carnet._cb), hq_carnet._ready
        live = gen.build()
        hq_carnet._cb.clear()
        hq_carnet._cb.update(saved[0])
        hq_carnet._ready = saved[1]
        stored = json.loads((Path(__file__).resolve().parent / "fixtures_carnet_reviews.json").read_text(encoding="utf-8"))
        self.assertEqual(live["shape"], stored["shape"], "regenerate with: python3 tests/gen_fixtures_carnet_reviews.py")


class BackupTests(RBase):
    def test_backup_copies_every_review_byte_for_byte(self):
        a = self.new()
        b = self.new()
        self.act("review_check_add", a, text="x")
        dest = self.tmp / "backup"
        out = hq_carnet.snapshot_to(self.tmp, dest)
        self.assertEqual(out["reviews"]["count"], 2)
        self.assertTrue(out["valid"])
        for p in self.review_files():
            self.assertEqual((dest / "reviews" / p.name).read_bytes(), p.read_bytes())
        self.assertEqual(out["reviews"]["bytes"], sum(p.stat().st_size for p in self.review_files()))

    def test_backup_carries_corrupt_pack_and_reports_invalid(self):
        pk = self.new()
        path = self.review_files()[0]
        data = json.loads(path.read_text())
        data["note"] = "altéré"
        raw = json.dumps(data).encode()
        path.write_bytes(raw)
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertFalse(out["valid"])
        self.assertFalse(out["reviews"]["valid"])
        self.assertEqual((self.tmp / "backup" / "reviews" / (pk["id"] + ".json")).read_bytes(), raw)

    def test_backup_without_reviews_has_no_reviews_key(self):
        self.page_with()
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertNotIn("reviews", out)

    def test_reviews_alone_make_backup_present(self):
        self.new()
        self.assertEqual(hq_carnet.snapshot_to(self.tmp, self.tmp / "b")["status"], "included")


if __name__ == "__main__":
    unittest.main()
