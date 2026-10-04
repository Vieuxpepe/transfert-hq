"""Carnet Phase 11 — verification tasks & evidence-backed signoff (server half).

A verification says that a human performed a check against a specific evidence state. These tests pin that it never becomes evidence, never
mutates what it points at, that ``verified`` is only ever an explicit signoff, that a signoff captures two consistent observations (and fails
closed on anything unobservable), that freshness is computed separately and never rewrites history, and that the trust path through the
snapshot / review readers cannot be redirected.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_evidence as evidence  # noqa: E402
import hq_carnet_reviews as reviews  # noqa: E402
import hq_carnet_snapshots as snaps  # noqa: E402
import hq_carnet_verifications as ver  # noqa: E402
from test_hq_carnet_annotations import ABase, digest_without  # noqa: E402
from test_hq_carnet_history import para  # noqa: E402
from test_hq_carnet_reviews import post, rid  # noqa: E402

QUESTION = "Le palier avant est-il usiné en H7 ?"


class VBase(ABase):
    def setUp(self):
        super().setUp()
        ver.drop_index()
        self.pg = self.page_with()
        self.blocks = self.pg["content"]["blocks"]

    # ---- identities
    def t_page(self):
        return {"kind": "page", "page_id": self.pg["id"]}

    def t_block(self, i=3):
        return {"kind": "block", "page_id": self.pg["id"], "block_id": self.blocks[i]["id"]}

    def t_source(self, ed=None):
        return {"kind": "source", "source_id": (ed or self.sedition)["id"]}

    def t_drawing(self, stem="plan-1"):
        self.draw(stem)
        return {"kind": "drawing", "stem": stem}

    def t_snapshot(self):
        return {"kind": "snapshot", "snapshot_id": self.snap()}

    def t_item(self):
        pk = self.new_pack()
        self.pack = pk
        return {"kind": "review_item", "review_id": pk["id"], "item_id": pk["items"][0]["id"]}

    def full(self, ref):
        return ver.complete_ref(ref, evidence.World())[0]

    def new_pack(self):
        status, out = post(action="review_create", project_id=self.proj["id"], title="Revue banc", request_id=rid())
        self.assertEqual(status, 200, out)
        pk = out["review"]
        status, out = post(action="review_item_add", id=pk["id"], expected_rev=pk["rev"], item={"kind": "source", "edition_id": self.sedition["id"]})
        self.assertEqual(status, 200, out)
        return out["review"]

    # ---- calls
    def vc(self, target=None, question=QUESTION, request_id=None, expect=200, **kw):
        status, out = post(action="verification_create", request_id=request_id or rid(), question=question, target=target or self.t_block(), **kw)
        self.assertEqual(status, expect, out)
        return out["verification"] if expect == 200 else out

    def va(self, action, v, expect=200, **kw):
        status, out = post(action=action, id=v["id"], expected_rev=v["rev"], **kw)
        self.assertEqual(status, expect, out)
        return out["verification"] if expect == 200 else out

    def ev_add(self, v, ref, expect=200):
        return self.va("verification_evidence_add", v, expect, ref=ref)

    def st(self, v, status, expect=200, **kw):
        return self.va("verification_status", v, expect, status=status, **kw)

    def sign(self, v, expect=200, request_id=None, **kw):
        status, out = post(action="verification_signoff", id=v["id"], expected_rev=v["rev"], request_id=request_id or rid(), **kw)
        self.assertEqual(status, expect, out)
        return out

    def ready(self, target=None, evidence_refs=None):
        v = self.vc(target)
        for ref in evidence_refs if evidence_refs is not None else [self.t_page()]:
            v = self.ev_add(v, ref)
        return self.st(v, "ready")

    def getv(self, v):
        status, out = post(action="verification_get", id=v["id"])
        self.assertEqual(status, 200, out)
        return out["verification"]

    def resolved(self, v):
        status, out = post(action="verification_resolve", id=v["id"])
        self.assertEqual(status, 200, out)
        return out["resolved"]

    def files(self):
        d = self.tmp / ".hq-carnet" / "verifications"
        return sorted(d.glob("ver-*.json")) if d.is_dir() else []

    def path_of(self, v):
        return self.tmp / ".hq-carnet" / "verifications" / (v["id"] + ".json")

    def fresh_of(self, v):
        r = self.resolved(v)
        return {e["evidence_id"]: e["freshness"] for e in r["evidence"]}, r


# ================================================================ core object, ownership, immutability


class CreateTests(VBase):
    def test_create_defaults_and_every_target_kind(self):
        targets = [self.t_page(), self.t_block(), self.t_source(), self.t_drawing(), self.t_snapshot(), self.t_item(),
                   {"kind": "citation", "page_id": "x", "block_id": "y"}]
        page, blk, cite = self.cited_page()
        targets[-1] = self.ctarget(page, blk, cite)
        for t in targets:
            v = self.vc(t)
            self.assertEqual((v["status"], v["rev"], v["evidence"], v["signoffs"], v["note"], v["followup_note"], v["integrity"]), ("open", 1, [], [], "", "", "ok"), t["kind"])
            self.assertEqual(v["target"]["kind"], t["kind"])
            self.assertNotIn("cite", v["target"])
        self.assertEqual(len(self.files()), len(targets))

    def test_review_item_target_captures_the_item_fingerprint_server_side(self):
        t = self.t_item()
        v = self.vc(t)
        import hq_carnet_rcomments as rcm

        self.assertEqual(v["target"]["item_fingerprint"], rcm.item_fingerprint(self.pack["items"][0]))
        bad = self.vc({**t, "item_fingerprint": "0" * 64}, expect=400)
        self.assertIn("error", bad)

    def test_citation_fingerprint_is_server_owned(self):
        page, blk, cite = self.cited_page()
        v = self.vc(self.ctarget(page, blk, cite))
        import hq_carnet_annotations as ann

        self.assertEqual(v["target"], {"kind": "citation", "page_id": page["id"], "block_id": blk["id"], "citation_fingerprint": ann.fingerprint(cite)})
        self.vc({"kind": "citation", "page_id": page["id"], "block_id": blk["id"], "citation_fingerprint": ann.fingerprint(cite)}, expect=400)
        self.vc(self.ctarget(page, blk, self.cite(self.sedition, "page", "999", None, True)), expect=404)

    def test_replay_conflict_and_restart(self):
        req = rid()
        a = self.vc(request_id=req)
        status, b = post(action="verification_create", request_id=req, question=QUESTION, target=self.t_block())
        self.assertEqual((status, b["replayed"], b["verification"]["id"]), (200, True, a["id"]))
        self.assertEqual(len(self.files()), 1)
        self.vc(request_id=req, question="Autre question", expect=409)
        self.assertEqual(self.vc(request_id=req, question="Autre question", expect=409)["code"], "verification_request_conflict")
        self.assertEqual(self.vc(request_id=req, target=self.t_page(), expect=409)["code"], "verification_request_conflict")
        ver.drop_index()  # "restart": the replay is answered from the files alone
        status, c = post(action="verification_create", request_id=req, question=QUESTION, target=self.t_block())
        self.assertEqual((status, c["replayed"], c["verification"]["id"]), (200, True, a["id"]))

    def _replay_project_cases(self, target, projects_a, projects_b):
        """same request id: same effective project -> replay; changed / added / dropped project -> 409 verification_request_conflict; survives drop_index()."""
        def create(req, **kw):
            return post(action="verification_create", request_id=req, question=QUESTION, target=target, **kw)

        # project A -> same id + A replays; + B conflicts; + omitted conflicts
        req = rid()
        status, a = create(req, project_id=projects_a)
        self.assertEqual(status, 200, a)
        self.assertEqual(a["verification"]["project_id"], projects_a)
        status, again = create(req, project_id=projects_a)
        self.assertEqual((status, again["replayed"], again["verification"]["id"]), (200, True, a["verification"]["id"]))
        for kw in ({"project_id": projects_b}, {}):
            status, out = create(req, **kw)
            self.assertEqual((status, out["code"]), (409, "verification_request_conflict"), kw)
        ver.drop_index()  # restart simulation: the decision is made from the files alone
        self.assertEqual(create(req, project_id=projects_a)[1]["replayed"], True)
        self.assertEqual(create(req, project_id=projects_b)[1]["code"], "verification_request_conflict")
        # no project -> same id + A conflicts; same id + none replays
        req2 = rid()
        status, n = create(req2)
        self.assertEqual((status, n["verification"]["project_id"]), (200, None))
        status, out = create(req2, project_id=projects_a)
        self.assertEqual((status, out["code"]), (409, "verification_request_conflict"))
        self.assertEqual(create(req2)[1]["replayed"], True)
        ver.drop_index()
        self.assertEqual(create(req2, project_id=projects_a)[1]["code"], "verification_request_conflict")
        self.assertEqual(len(self.files()), 2, "a conflicting retry never creates anything")

    def test_create_replay_binds_project_for_source(self):
        self._replay_project_cases(self.t_source(), self.proj["id"], self.other["id"])

    def test_create_replay_binds_project_for_drawing(self):
        self._replay_project_cases(self.t_drawing(), self.proj["id"], self.other["id"])

    def test_create_replay_with_derived_project_stays_consistent(self):
        for target in (self.t_block(), self.t_page()):
            req = rid()
            status, a = post(action="verification_create", request_id=req, question=QUESTION, target=target)
            self.assertEqual((status, a["verification"]["project_id"]), (200, self.proj["id"]))
            # omitted and the canonical project both replay; a different project conflicts (never a silent replay of another project's object)
            for kw in ({}, {"project_id": self.proj["id"]}):
                status, b = post(action="verification_create", request_id=req, question=QUESTION, target=target, **kw)
                self.assertEqual((status, b["replayed"], b["verification"]["id"]), (200, True, a["verification"]["id"]), kw)
            status, c = post(action="verification_create", request_id=req, question=QUESTION, target=target, project_id=self.other["id"])
            self.assertEqual((status, c["code"]), (409, "verification_request_conflict"))
            ver.drop_index()
            status, d = post(action="verification_create", request_id=req, question=QUESTION, target=target)
            self.assertEqual((status, d["replayed"]), (200, True))

    def test_unknown_target_creates_nothing(self):
        self.vc({"kind": "page", "page_id": "page-nope"}, expect=404)
        self.vc({"kind": "drawing", "stem": "absent"}, expect=404)
        self.vc({"kind": "snapshot", "snapshot_id": "snap-" + "0" * 24}, expect=404)
        self.vc({"kind": "source", "source_id": "srce-nope"}, expect=404)
        self.assertEqual(self.files(), [])

    def test_hostile_payloads_are_refused(self):
        for q in ("", "   ", "x" * 4001, "a\x00b", "a\x07b", 7, None):
            self.vc(question=q, expect=400)
        for t in ({"kind": "task"}, {"kind": "block", "page_id": self.pg["id"]}, {**self.t_block(), "extra": 1}, "page", None, {"kind": "page", "page_id": "../x"}):
            status, out = post(action="verification_create", request_id=rid(), question=QUESTION, target=t)
            self.assertEqual(status, 400, t)
        for extra in ({"assignee": "x"}, {"due": "2026-01-01"}, {"priority": 1}, {"author": "me"}, {"status": "verified"}):
            status, out = post(action="verification_create", request_id=rid(), question=QUESTION, target=self.t_block(), **extra)
            self.assertEqual(status, 400, extra)
        self.assertEqual(self.files(), [])

    def test_target_is_immutable_there_is_no_change_target_action(self):
        v = self.vc()
        status, out = post(action="verification_update", id=v["id"], expected_rev=v["rev"], target=self.t_page())
        self.assertEqual(status, 400, out)
        self.assertEqual(post(action="verification_retarget", id=v["id"], expected_rev=1, target=self.t_page())[0] // 100, 4)
        self.assertEqual(self.getv(v)["target"], v["target"])
        self.assertFalse(any("retarget" in a or "change_target" in a for a in ver.ACTIONS))

    def test_project_is_derived_for_pages_and_supplied_for_sources(self):
        self.assertEqual(self.vc(self.t_block())["project_id"], self.proj["id"])
        self.assertEqual(self.vc(self.t_source())["project_id"], None)
        self.assertEqual(self.vc(self.t_source(), project_id=self.proj["id"])["project_id"], self.proj["id"])
        self.vc(self.t_block(), project_id=self.other["id"], expect=400)
        self.vc(self.t_source(), project_id="proj-absent", expect=404)

    def test_page_revision_and_editor_state_are_untouched(self):
        before_rev = self.cur(self.pg["id"])["rev"]
        before = digest_without(self.tmp, "verifications")
        v = self.vc()
        v = self.ev_add(v, self.t_page())
        v = self.st(v, "ready")
        self.sign(v)
        self.assertEqual(self.cur(self.pg["id"])["rev"], before_rev)
        self.assertEqual(digest_without(self.tmp, "verifications"), before, "nothing outside the verification store changed")


# ================================================================ state machine


class StateTests(VBase):
    def test_attaching_evidence_never_changes_status(self):
        v = self.vc()
        v = self.ev_add(v, self.t_page())
        self.assertEqual(v["status"], "open")
        v = self.ev_add(v, self.t_source())
        self.assertEqual((v["status"], len(v["evidence"])), ("open", 2))

    def test_target_is_not_implicitly_evidence(self):
        v = self.vc(self.t_block())
        self.assertEqual(v["evidence"], [])
        self.st(v, "ready", expect=409)

    def test_ready_needs_evidence_and_never_auto_verifies(self):
        v = self.vc()
        self.assertEqual(self.st(v, "ready", expect=409)["code"], "verification_no_evidence")
        v = self.ev_add(v, self.t_page())
        v = self.st(v, "ready")
        self.assertEqual((v["status"], v["signoffs"]), ("ready", []))
        self.assertEqual(self.getv(v)["status"], "ready")

    def test_verified_is_reachable_only_through_signoff(self):
        v = self.ready()
        out = self.st(v, "verified", expect=400)
        self.assertEqual(out["code"], "verification_signoff_required")
        self.assertEqual(self.getv(v)["status"], "ready")
        for action in ("verification_update", "verification_evidence_add", "verification_status"):
            status, out = post(action=action, id=v["id"], expected_rev=v["rev"], status="verified", ref=self.t_source(), note="x")
            self.assertEqual(self.getv(v)["status"], "ready", action)
        out = self.sign(v)
        self.assertEqual(out["verification"]["status"], "verified")

    def test_transitions(self):
        v = self.ready()
        v = self.st(v, "open")
        v = self.st(v, "ready")
        v = self.st(v, "needs_followup", followup_note="Mesurer à nouveau")
        self.assertEqual((v["status"], v["followup_note"]), ("needs_followup", "Mesurer à nouveau"))
        self.st(v, "ready", expect=409)  # reopen first
        v = self.st(v, "needs_followup", followup_note="Nouveau motif")
        self.assertEqual(v["followup_note"], "Nouveau motif")
        v = self.st(v, "open")
        self.assertEqual(v["followup_note"], "Nouveau motif", "returning to open never erases the historical reason")
        v = self.st(v, "ready")
        v = self.sign(v)["verification"]
        self.st(v, "ready", expect=409)
        self.st(v, "verified", expect=400)
        v = self.st(v, "needs_followup", followup_note="Revoir")
        v = self.st(v, "open")
        self.assertEqual(v["status"], "open")

    def test_followup_note_belongs_to_the_needs_followup_transition(self):
        v = self.vc()
        self.st(v, "needs_followup", expect=400)
        self.st(v, "needs_followup", expect=400, followup_note="  ")
        self.st(v, "needs_followup", expect=400, followup_note="x" * 4001)
        self.st(v, "ready", expect=409)
        status, out = post(action="verification_status", id=v["id"], expected_rev=v["rev"], status="open", followup_note="x")
        self.assertEqual(status, 400)
        status, out = post(action="verification_update", id=v["id"], expected_rev=v["rev"], followup_note="x")
        self.assertEqual(status, 400)

    def test_question_and_evidence_are_frozen_outside_open(self):
        v = self.ready()
        self.assertEqual(self.va("verification_update", v, 409, question="Autre ?")["code"], "verification_state_invalid")
        self.assertEqual(self.ev_add(v, self.t_source(), expect=409)["code"], "verification_state_invalid")
        self.va("verification_evidence_remove", v, 409, evidence_id=v["evidence"][0]["id"])
        v = self.sign(v)["verification"]
        self.va("verification_update", v, 409, question="Autre ?")
        self.ev_add(v, self.t_source(), expect=409)
        v = self.st(v, "open")
        v = self.va("verification_update", v, question="Autre ?")
        v = self.ev_add(v, self.t_source())
        self.assertEqual((v["question"], len(v["evidence"])), ("Autre ?", 2))

    def test_note_is_editable_in_every_status_and_may_be_cleared(self):
        v = self.ready()
        v = self.va("verification_update", v, note="remarque en prêt")
        v = self.sign(v)["verification"]
        v = self.va("verification_update", v, note="remarque après vérification")
        self.assertEqual((v["status"], v["note"]), ("verified", "remarque après vérification"))
        v = self.va("verification_update", v, note="")
        self.assertEqual(v["note"], "")

    def test_stale_revisions_are_409_and_change_nothing(self):
        v = self.vc()
        v2 = self.va("verification_update", v, note="a")
        raw = self.path_of(v).read_bytes()
        for action, extra in (("verification_update", {"note": "b"}), ("verification_evidence_add", {"ref": self.t_page()}), ("verification_status", {"status": "needs_followup", "followup_note": "x"})):
            status, out = post(action=action, id=v["id"], expected_rev=v["rev"], **extra)
            self.assertEqual((status, out["code"], out["current_rev"]), (409, "verification_conflict", v2["rev"]), action)
        status, out = post(action="verification_signoff", id=v["id"], expected_rev=v["rev"], request_id=rid())
        self.assertEqual(status, 409)
        self.assertEqual(self.path_of(v).read_bytes(), raw)

    def test_duplicate_evidence_and_bounds(self):
        v = self.vc()
        v = self.ev_add(v, self.t_page())
        self.assertEqual(self.ev_add(v, self.t_page(), expect=409)["code"], "verification_duplicate_evidence")
        for n in range(3):
            v = self.ev_add(v, self.t_drawing(f"d-{n}"))
        self.assertEqual(len(v["evidence"]), 4)
        removed = self.va("verification_evidence_remove", v, evidence_id=v["evidence"][0]["id"])
        self.assertEqual(len(removed["evidence"]), 3)
        self.va("verification_evidence_remove", removed, 404, evidence_id="ve-" + "0" * 16)

    def test_hundred_evidence_refs_are_the_bound(self):
        v = self.vc()
        with mock.patch.object(ver, "EVIDENCE_MAX", 5):
            for n in range(5):
                v = self.ev_add(v, self.t_drawing(f"d-{n}"))
            self.assertEqual(self.ev_add(v, self.t_drawing("d-x"), expect=409)["code"], "verification_limit")
        self.assertEqual(ver.EVIDENCE_MAX, 100)

    def test_review_comment_is_not_evidence_and_annotation_does_not_become_verification(self):
        t = self.t_item()
        status, out = post(action="rcomment_add", review_id=t["review_id"], item_id=t["item_id"], request_id=rid(), body="commentaire", supersedes=None)
        self.assertEqual(status, 200, out)
        v = self.vc(self.t_block())
        status, out = post(action="verification_evidence_add", id=v["id"], expected_rev=v["rev"], ref={"kind": "review_comment", "id": out["comment"]["id"]})
        self.assertEqual(status, 400)
        a = self.create(self.stor(), "annotation")
        self.assertEqual(post(action="verification_evidence_add", id=v["id"], expected_rev=v["rev"], ref={"kind": "annotation", "id": a["id"]})[0], 400)
        self.assertEqual(self.files()[0].name, v["id"] + ".json")
        self.assertEqual(len(self.files()), 1, "an annotation never becomes a verification")


# ================================================================ signoff


class SignoffTests(VBase):
    def test_signoff_records_the_captured_state_and_no_identity(self):
        page = self.pg
        v = self.ready(self.t_block(3), [self.t_block(1), self.t_source(), self.t_drawing()])
        out = self.sign(v)
        s, rec = out["signoff"], out["verification"]
        self.assertEqual((rec["status"], rec["rev"], len(rec["signoffs"])), ("verified", v["rev"] + 1, 1))
        self.assertEqual(s["verification_rev"], v["rev"])
        self.assertEqual(s["verification_fingerprint"], rec["verification_fingerprint"])
        self.assertEqual(set(s), {"id", "request_id", "signed_at", "verification_rev", "verification_fingerprint", "target_seal", "evidence", "content_sha256"})
        self.assertEqual(s["target_seal"]["kind"], "block")
        self.assertEqual(s["target_seal"]["seal"], evidence.observe("block", {"page_id": page["id"], "block_id": self.blocks[3]["id"]}, evidence.World()))
        self.assertEqual({e["kind"] for e in s["evidence"]}, {"block", "source", "drawing"})
        self.assertTrue(all(e["state"] == "ok" and e["seal"] and e["evidence_id"] for e in s["evidence"]))
        blob = json.dumps(rec)
        for banned in ("signed_by", "author", "username", "user", "reviewer", "email"):
            self.assertNotIn(banned, set(s) | set(rec))
        self.assertNotIn("autm20089501", blob)
        self.assertEqual(ver.DISCLOSURE, "Vérification enregistrée localement ; aucune identité de relecteur authentifiée n'est associée.")

    def test_signoff_is_an_explicit_action_with_requirements(self):
        v = self.vc()
        self.assertEqual(self.sign(v, expect=409)["code"], "verification_not_ready")  # open
        v = self.ev_add(v, self.t_page())
        self.assertEqual(self.sign(v, expect=409)["code"], "verification_not_ready")  # not ready
        v = self.st(v, "ready")
        self.assertEqual(self.sign(v)["verification"]["status"], "verified")

    def test_zero_evidence_ready_record_cannot_be_signed(self):
        v = self.ready()
        raw = json.loads(self.path_of(v).read_text())
        raw["evidence"] = []
        raw["seal"] = ver.seal(raw)
        self.path_of(v).write_text(json.dumps(raw))
        ver.drop_index()
        got = self.getv(v)
        self.assertEqual((got["status"], got["evidence"], got["integrity"]), ("ready", [], "ok"))
        out = self.sign(got, expect=409)
        self.assertEqual(out["code"], "verification_not_ready")
        self.assertEqual(json.loads(self.path_of(v).read_text())["signoffs"], [])

    def test_the_target_itself_is_observed_even_when_it_is_not_evidence(self):
        v = self.ready(self.t_drawing("cible"), [self.t_page()])
        (self.draw_dir / "cible.hqdraw.json").unlink()
        raw = self.path_of(v).read_bytes()
        out = self.sign(v, expect=409)
        self.assertEqual(out["code"], "verification_evidence_unavailable")
        self.assertEqual(out["error"], "Impossible d'enregistrer la vérification : certaines preuves ne peuvent pas être vérifiées actuellement.")
        self.assertEqual([(e["role"], e["state"]) for e in out["entries"]], [("target", "missing")])
        self.assertEqual(self.path_of(v).read_bytes(), raw, "nothing was recorded")

    def test_missing_unknown_and_corrupt_evidence_fail_closed_with_per_entry_reasons(self):
        v = self.ready(self.t_page(), [self.t_drawing("a"), self.t_source(), self.t_page()])
        (self.draw_dir / "a.hqdraw.json").unlink()
        with mock.patch("hq_carnet_review._editions", return_value=None):
            out = self.sign(v, expect=409)
        self.assertEqual(out["code"], "verification_evidence_unavailable")
        got = {(e["state"], e["reason"]) for e in out["entries"]}
        self.assertEqual(got, {("missing", "absent"), ("unknown", "sources_unavailable")})
        self.assertTrue(all(e["role"] == "evidence" and e["evidence_id"] for e in out["entries"]))
        self.assertEqual(self.getv(v)["signoffs"], [])

    def test_archived_but_observable_evidence_is_signable_and_recorded_as_archived(self):
        v = self.ready(self.t_page(), [self.t_source()])
        sources_mod = hq_carnet.sources
        sources_mod.mutate({"action": "source_edition_archive", "id": self.sedition["id"], "expected_rev": self.src_rev(self.sedition), "archived": True})
        out = self.sign(v)
        self.assertEqual([e["state"] for e in out["signoff"]["evidence"]], ["archived"])

    def test_corrupt_snapshot_evidence_blocks_signoff_and_stays_corrupt(self):
        t = self.t_snapshot()
        v = self.ready(self.t_page(), [t])
        path = self.tmp / ".hq-carnet" / "snapshots" / (t["snapshot_id"] + ".json")
        data = json.loads(path.read_text())
        data["label"] = "altéré"
        path.write_text(json.dumps(data))
        obs = ver.observe_ref(t, evidence.World())
        self.assertEqual((obs["state"], obs["reason"]), ("corrupt", "snapshot_corrupt"))
        out = self.sign(v, expect=409)
        self.assertEqual([(e["state"]) for e in out["entries"]], ["corrupt"])

    def test_corrupt_review_item_evidence_blocks_signoff_and_stays_corrupt(self):
        t = self.t_item()
        v = self.vc(self.t_page(), )
        v = self.ev_add(v, t)
        v = self.st(v, "ready")
        path = self.tmp / ".hq-carnet" / "reviews" / (t["review_id"] + ".json")
        data = json.loads(path.read_text())
        data["title"] = "altéré"
        path.write_text(json.dumps(data))
        resolved = self.resolved(v)
        self.assertEqual(resolved["evidence"][0]["exists"], "corrupt")
        self.assertEqual(self.sign(v, expect=409)["entries"][0]["state"], "corrupt")

    def test_two_consistent_observations_a_then_b_must_match_and_b_is_recorded(self):
        v = self.ready(self.t_page(), [self.t_block(3)])
        real = ver._observe_all
        calls = []

        def wrapper(rec):
            calls.append(1)
            got = real(rec)
            if len(calls) == 1:
                self.edit_block_text(self.pg, 3, "Le palier avant est usiné en H6")
            return got

        raw = self.path_of(v).read_bytes()
        with mock.patch.object(ver, "_observe_all", side_effect=wrapper):
            out = self.sign(v, expect=409)
        self.assertEqual((out["code"], len(calls)), ("verification_capture_race", 2))
        self.assertEqual(self.path_of(v).read_bytes(), raw, "a race records nothing")
        out = self.sign(v)  # a quiet retry now observes the new state twice and records it
        newest = evidence.observe("block", {"page_id": self.pg["id"], "block_id": self.blocks[3]["id"]}, evidence.World())
        self.assertEqual(out["signoff"]["evidence"][0]["seal"], newest)

    def test_aba_is_not_claimed(self):
        v = self.ready(self.t_block(1), [self.t_block(3)])
        real = ver._observe_all
        calls = []

        def wrapper(rec):
            calls.append(1)
            got = real(rec)
            if len(calls) == 1:
                self.edit_block_text(self.pg, 3, "autre")
                self.edit_block_text(self.pg, 3, self.blocks[3]["text"])  # 1 -> 2 -> 1 between the two observations
            return got

        with mock.patch.object(ver, "_observe_all", side_effect=wrapper):
            out = self.sign(v)
        self.assertEqual(out["verification"]["status"], "verified", "two consistent observations are recorded; ABA is documented as not detected")
        src = (Path(__file__).resolve().parent.parent / "hq_carnet_verifications.py").read_text(encoding="utf-8")
        self.assertIn("NOT an ABA guarantee", src)

    def test_lost_response_replays_the_original_signoff_before_the_rev_check(self):
        v = self.ready()
        req = rid()
        first = self.sign(v, request_id=req)
        self.assertFalse(first["replayed"])
        status, again = post(action="verification_signoff", id=v["id"], expected_rev=v["rev"], request_id=req)  # stale rev by now
        self.assertEqual(status, 200, again)
        self.assertTrue(again["replayed"])
        self.assertEqual(again["signoff"], first["signoff"])
        self.assertEqual(len(self.getv(v)["signoffs"]), 1)
        # restart: still answered from the file
        ver.drop_index()
        status, third = post(action="verification_signoff", id=v["id"], expected_rev=v["rev"], request_id=req)
        self.assertEqual((status, third["replayed"]), (200, True))

    def test_signoff_request_conflicts(self):
        v = self.ready()
        req = rid()
        first = self.sign(v, request_id=req)
        status, out = post(action="verification_signoff", id=v["id"], expected_rev=v["rev"] + 1, request_id=req)
        self.assertEqual((status, out["code"]), (409, "verification_request_conflict"))
        status, out = post(action="verification_signoff", id=v["id"], expected_rev=v["rev"], request_id=req, verification_fingerprint="0" * 64)
        self.assertEqual((status, out["code"]), (409, "verification_request_conflict"))
        status, ok = post(action="verification_signoff", id=v["id"], expected_rev=v["rev"], request_id=req, verification_fingerprint=first["signoff"]["verification_fingerprint"])
        self.assertEqual((status, ok["replayed"]), (200, True))
        v2 = self.ready()
        status, out = post(action="verification_signoff", id=v2["id"], expected_rev=v2["rev"], request_id=rid(), verification_fingerprint="0" * 64)
        self.assertEqual((status, out["code"]), (409, "verification_request_conflict"))
        self.assertEqual(self.getv(v2)["signoffs"], [])

    def test_note_and_followup_note_and_order_never_change_the_fingerprint(self):
        v = self.ready(self.t_page(), [self.t_source(), self.t_block(1)])
        fp = v["verification_fingerprint"]
        v = self.va("verification_update", v, note="un commentaire")
        self.assertEqual(v["verification_fingerprint"], fp)
        a = self.sign(v)
        s0 = a["signoff"]
        v = a["verification"]
        v = self.va("verification_update", v, note="une note ajoutée après la vérification")
        v = self.st(v, "needs_followup", followup_note="motif")
        self.assertEqual(v["verification_fingerprint"], fp)
        self.assertEqual(v["signoffs"][0], s0, "a historical signoff is never rewritten by commentary")
        self.assertEqual(self.getv(v)["signoffs"][0]["verification_fingerprint"], fp)
        rec = json.loads(self.path_of(v).read_text())
        rec["evidence"].reverse()
        self.assertEqual(ver.fingerprint(rec), fp, "display order of the evidence is not part of the definition")

    def test_question_and_evidence_changes_change_the_fingerprint(self):
        v = self.ready()
        fp = v["verification_fingerprint"]
        v = self.st(v, "open")
        v2 = self.va("verification_update", v, question="Une autre question ?")
        self.assertNotEqual(v2["verification_fingerprint"], fp)
        v3 = self.ev_add(v2, self.t_source())
        self.assertNotEqual(v3["verification_fingerprint"], fp)

    def test_re_verification_appends_history_and_never_edits_it(self):
        v = self.ready()
        a = self.sign(v)
        v = a["verification"]
        v = self.st(v, "open")
        v = self.va("verification_update", v, question="Question reformulée ?")
        v = self.ev_add(v, self.t_source())
        v = self.st(v, "ready")
        b = self.sign(v)
        sig = b["verification"]["signoffs"]
        self.assertEqual([s["id"] for s in sig], [a["signoff"]["id"], b["signoff"]["id"]])
        self.assertEqual(sig[0], a["signoff"])
        self.assertNotEqual(sig[0]["verification_fingerprint"], sig[1]["verification_fingerprint"])
        self.assertEqual(len(sig[1]["evidence"]), 2)

    def test_signoff_limit(self):
        v = self.ready()
        with mock.patch.object(ver, "SIGNOFFS_MAX", 1):
            v = self.sign(v)["verification"]
            v = self.st(v, "open")
            v = self.st(v, "ready")
            self.assertEqual(self.sign(v, expect=409)["code"], "verification_limit")

    def test_signoff_does_not_modify_snapshots_or_review_packs_or_pages(self):
        t = self.t_snapshot()
        r = self.t_item()
        v = self.ready(self.t_page(), [t, r])
        snap_raw = (self.tmp / ".hq-carnet" / "snapshots" / (t["snapshot_id"] + ".json")).read_bytes()
        rev_raw = (self.tmp / ".hq-carnet" / "reviews" / (r["review_id"] + ".json")).read_bytes()
        before = digest_without(self.tmp, "verifications")
        self.sign(v)
        self.assertEqual((self.tmp / ".hq-carnet" / "snapshots" / (t["snapshot_id"] + ".json")).read_bytes(), snap_raw)
        self.assertEqual((self.tmp / ".hq-carnet" / "reviews" / (r["review_id"] + ".json")).read_bytes(), rev_raw)
        self.assertEqual(digest_without(self.tmp, "verifications"), before)


# ================================================================ freshness (computed, never persisted)


class FreshnessTests(VBase):
    def test_before_signoff_only_existence_is_reported(self):
        v = self.ready(self.t_page(), [self.t_block(3), self.t_drawing(), self.t_source()])
        r = self.resolved(v)
        self.assertEqual((r["has_signoff"], r["overall"], r["definition_changed"]), (False, None, False))
        self.assertTrue(all(e["freshness"] is None and e["exists"] == "ok" for e in r["evidence"]))
        self.assertEqual(r["target"]["exists"], "ok")

    def test_unchanged_then_changed_leaves_the_signoff_and_status_intact(self):
        v = self.ready(self.t_page(), [self.t_block(3)])
        s = self.sign(v)
        v = s["verification"]
        before = self.path_of(v).read_bytes()
        fresh, r = self.fresh_of(v)
        self.assertEqual((set(fresh.values()), r["overall"]), ({"unchanged"}, "unchanged"))
        self.edit_block_text(self.pg, 3, "Le palier avant est usiné en H6")
        fresh, r = self.fresh_of(v)
        self.assertEqual((set(fresh.values()), r["overall"]), ({"changed"}, "changed"))
        self.assertEqual(self.path_of(v).read_bytes(), before, "freshness is computed on demand and never persisted")
        got = self.getv(v)
        self.assertEqual((got["status"], got["signoffs"]), ("verified", v["signoffs"]))

    def test_deleted_evidence_is_missing_and_unknown_is_not_missing(self):
        v = self.ready(self.t_page(), [self.t_drawing("g1"), self.t_source()])
        v = self.sign(v)["verification"]
        (self.draw_dir / "g1.hqdraw.json").unlink()
        fresh, r = self.fresh_of(v)
        by = {e["kind"]: e["freshness"] for e in r["evidence"]}
        self.assertEqual(by, {"drawing": "missing", "source": "unchanged"})
        with mock.patch("hq_carnet_review._editions", return_value=None):
            by = {e["kind"]: e["freshness"] for e in self.resolved(v)["evidence"]}
        self.assertEqual(by["source"], "unknown", "an unreadable store is unknown, never missing")
        self.assertEqual(by["drawing"], "missing")

    def test_corrupt_is_never_reported_as_unchanged(self):
        t = self.t_snapshot()
        v = self.ready(self.t_page(), [t])
        v = self.sign(v)["verification"]
        path = self.tmp / ".hq-carnet" / "snapshots" / (t["snapshot_id"] + ".json")
        data = json.loads(path.read_text())
        data["label"] = "altéré"
        path.write_text(json.dumps(data))
        fresh, r = self.fresh_of(v)
        self.assertEqual((set(fresh.values()), r["overall"]), ({"corrupt"}, "corrupt"))

    def test_drawing_seal_mismatch_is_an_integrity_anomaly_and_new_stems_do_not_mutate_old_evidence(self):
        v = self.ready(self.t_page(), [self.t_drawing("plan-9")])
        v = self.sign(v)["verification"]
        self.draw("plan-10", b'{"v":2}')  # a new stem is a different identity: the old evidence is untouched
        self.assertEqual(self.fresh_of(v)[0], {v["evidence"][0]["id"]: "unchanged"})
        self.draw("plan-9", b'{"v":999}')  # same stem, other bytes
        fresh, r = self.fresh_of(v)
        self.assertEqual(set(fresh.values()), {"integrity_anomaly"})
        self.assertEqual(r["overall"], "integrity_anomaly")

    def test_integrity_anomaly_is_only_for_drawings(self):
        v = self.ready(self.t_page(), [self.t_source(), self.t_block(3)])
        v = self.sign(v)["verification"]
        sources_mod = hq_carnet.sources
        sources_mod.mutate({"action": "source_edition_update", "id": self.sedition["id"], "expected_rev": self.src_rev(self.sedition), "title": "Autre titre"})
        self.edit_block_text(self.pg, 3, "modifié")
        states = set(self.fresh_of(v)[0].values())
        self.assertEqual(states, {"changed"})

    def test_citation_disappearance_is_changed_or_removed_and_nothing_is_relinked(self):
        page, blk, cite = self.cited_page()
        v = self.ready(self.ctarget(page, blk, cite), [self.t_page()])
        v = self.ev_add(self.st(self.vc(self.ctarget(page, blk, cite)), "open") if False else self.vc(self.ctarget(page, blk, cite)), self.ctarget(page, blk, cite))
        v = self.st(v, "ready")
        v = self.sign(v)["verification"]
        r = self.resolved(v)
        self.assertEqual((r["target"]["freshness"], r["evidence"][0]["freshness"]), ("unchanged", "unchanged"))
        blocks = self.cur(page["id"])["content"]["blocks"]
        blocks[1] = dict(blocks[1], marks=[])  # the citation mark is gone; the sentence is still there
        self.edit_page(page, blocks)
        r = self.resolved(v)
        self.assertEqual((r["target"]["freshness"], r["evidence"][0]["freshness"], r["overall"]), ("changed_or_removed", "changed_or_removed", "changed"))
        self.assertEqual(r["target"]["ref"], v["target"], "the identity never moves to a similar citation")
        # a similar citation elsewhere in the block does not satisfy the old fingerprint
        other = self.cite(self.sedition, "page", "999", None, True)
        blocks[1] = dict(blocks[1], marks=[{"type": "citation", "start": 0, "end": 3, "cite": other}])
        self.edit_page(page, blocks)
        self.assertEqual(self.resolved(v)["target"]["freshness"], "changed_or_removed")
        self.edit_page(page, [blocks[0]])  # block gone
        self.assertEqual(self.resolved(v)["target"]["freshness"], "unavailable")

    def edit_page(self, page, blocks):
        return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "content": {"version": 2, "blocks": blocks}})["page"]

    def test_review_item_removed_or_replaced_is_missing(self):
        t = self.t_item()
        v = self.vc(self.t_page())
        v = self.ev_add(v, t)
        v = self.sign(self.st(v, "ready"))["verification"]
        self.assertEqual(self.fresh_of(v)[0], {v["evidence"][0]["id"]: "unchanged"})
        pk = reviews.get(t["review_id"])["review"]
        status, out = post(action="review_item_remove", id=pk["id"], expected_rev=pk["rev"], item_id=t["item_id"])
        self.assertEqual(status, 200, out)
        self.assertEqual(set(self.fresh_of(v)[0].values()), {"missing"})

    def test_a_verified_item_whose_evidence_changed_stays_verified(self):
        v = self.ready(self.t_page(), [self.t_block(3)])
        v = self.sign(v)["verification"]
        self.edit_block_text(self.pg, 3, "modifié")
        got = self.getv(v)
        self.assertEqual(got["status"], "verified")
        self.assertEqual(self.resolved(v)["overall"], "changed")

    def test_batched_resolve_isolates_each_record(self):
        a = self.sign(self.ready(self.t_page(), [self.t_block(3)]))["verification"]
        b = self.vc(self.t_source())
        c = self.vc(self.t_block(1))
        raw = json.loads(self.path_of(c).read_text())
        raw["note"] = "x"
        self.path_of(c).write_text(json.dumps(raw))
        ver.drop_index()
        status, out = post(action="verification_resolve", ids=[a["id"], b["id"], c["id"], "ver-" + "0" * 24, a["id"]])
        self.assertEqual(status, 200, out)
        by = {r["id"]: r for r in out["results"]}
        self.assertEqual(len(out["results"]), 4, "duplicates are collapsed")
        self.assertEqual(by[a["id"]]["resolved"]["overall"], "unchanged")
        self.assertEqual(by[b["id"]]["resolved"]["has_signoff"], False)
        self.assertEqual(by[c["id"]]["resolved"]["integrity"], "corrupt", "a corrupt record is still shown read-only")
        self.assertEqual(by["ver-" + "0" * 24]["error"], "not_found")
        self.assertEqual(post(action="verification_resolve", ids=[])[0], 400)
        self.assertEqual(post(action="verification_resolve", ids=[a["id"]] * 0 + [f"ver-{n:024x}" for n in range(26)])[0], 400)
        self.assertEqual(post(action="verification_resolve", id=a["id"], ids=[a["id"]])[0], 400)

    def test_one_broken_resolver_does_not_suppress_the_others(self):
        v = self.ready(self.t_page(), [self.t_block(3), self.t_drawing(), self.t_source()])
        v = self.sign(v)["verification"]
        real = ver.ev.observe

        def flaky(kind, key, world):
            if kind == "drawing":
                raise RuntimeError("boom")
            return real(kind, key, world)

        with mock.patch.object(ver.ev, "observe", side_effect=flaky):
            r = self.resolved(v)
        by = {e["kind"]: e["freshness"] for e in r["evidence"]}
        self.assertEqual(by, {"block": "unchanged", "drawing": "unknown", "source": "unchanged"})
        self.assertEqual(r["overall"], "unknown")

    def test_entries_added_after_the_signoff_are_flagged_not_unchanged(self):
        v = self.ready()
        v = self.sign(v)["verification"]
        v = self.st(v, "open")
        v = self.ev_add(v, self.t_source())
        r = self.resolved(v)
        self.assertEqual({e["freshness"] for e in r["evidence"]}, {"unchanged", "added_since"})
        self.assertTrue(r["definition_changed"])
        self.assertEqual(r["overall"], "changed")


# ================================================================ deletion


class DeleteTests(VBase):
    def delete(self, v, expect=200, **kw):
        status, out = post(action="verification_delete", id=v["id"], expected_rev=v["rev"], confirm=True, **kw)
        self.assertEqual(status, expect, out)
        return out

    def test_unsigned_delete_needs_confirmation_and_revision(self):
        v = self.ready()
        status, out = post(action="verification_delete", id=v["id"], expected_rev=v["rev"])
        self.assertEqual(status, 400)
        status, out = post(action="verification_delete", id=v["id"], expected_rev=v["rev"], confirm="yes")
        self.assertEqual(status, 400)
        stale = dict(v, rev=v["rev"] - 1)
        self.delete(stale, 409)
        self.assertEqual(len(self.files()), 1)
        self.delete(v)
        self.assertEqual(self.files(), [])
        self.assertEqual(post(action="verification_get", id=v["id"])[0], 404)

    def test_any_signoff_makes_normal_delete_refused(self):
        v = self.ready()
        v = self.sign(v)["verification"]
        out = self.delete(v, 409)
        self.assertEqual(out["code"], "verification_has_signoff")
        v = self.st(v, "open")
        self.assertEqual(self.delete(v, 409)["code"], "verification_has_signoff", "reopened or not, the history survives")
        self.assertEqual(len(self.files()), 1)

    def test_missing_target_or_evidence_does_not_make_an_unsigned_verification_undeletable(self):
        v = self.vc(self.t_drawing("temp"))
        v = self.ev_add(v, self.t_drawing("temp2"))
        (self.draw_dir / "temp.hqdraw.json").unlink()
        (self.draw_dir / "temp2.hqdraw.json").unlink()
        self.delete(v)
        self.assertEqual(self.files(), [])

    def test_corrupt_is_refused(self):
        v = self.vc()
        raw = json.loads(self.path_of(v).read_text())
        raw["question"] = "altérée"
        self.path_of(v).write_text(json.dumps(raw))
        ver.drop_index()
        self.delete(self.getv(v), 409)
        self.assertTrue(self.path_of(v).exists())


# ================================================================ corruption isolation


class CorruptionTests(VBase):
    def corrupt(self, v):
        raw = json.loads(self.path_of(v).read_text())
        raw["question"] = "texte altéré"
        data = json.dumps(raw).encode()
        self.path_of(v).write_bytes(data)
        ver.drop_index()
        return data

    def test_corrupt_record_is_listed_read_only_and_cannot_be_edited_signed_or_deleted(self):
        good = self.vc()
        bad = self.ready()
        data = self.corrupt(bad)
        got = self.getv(bad)
        self.assertEqual(got["integrity"], "corrupt")
        for action, kw in (("verification_update", {"note": "x"}), ("verification_evidence_add", {"ref": self.t_source()}), ("verification_status", {"status": "open"}),
                           ("verification_signoff", {"request_id": rid()}), ("verification_delete", {"confirm": True}), ("verification_evidence_remove", {"evidence_id": got["evidence"][0]["id"]})):
            status, out = post(action=action, id=bad["id"], expected_rev=got["rev"], **kw)
            self.assertEqual((status, out["code"]), (409, "verification_corrupt"), action)
        self.assertEqual(self.path_of(bad).read_bytes(), data, "bytes preserved")
        status, out = post(action="verification_list")
        ids = {r["id"]: r["integrity"] for r in out["verifications"]}
        self.assertEqual((ids[good["id"]], ids[bad["id"]], out["unavailable"]), ("ok", "corrupt", 1))
        self.va("verification_update", good, note="le reste fonctionne")

    def test_invalid_and_noncanonical_files_do_not_poison_listing_or_index(self):
        good = self.vc()
        d = self.tmp / ".hq-carnet" / "verifications"
        (d / ("ver-" + "a" * 24 + ".json")).write_text("{not json")
        (d / ("ver-" + "b" * 24 + ".json")).write_text(json.dumps({"schema": 1}))
        (d / ("ver-" + "c" * 24 + ".json")).symlink_to(self.path_of(good))
        (d / ("ver-" + "d" * 24 + ".json")).mkdir()
        (d / "notes.txt").write_text("ignored")
        ver.drop_index()
        status, out = post(action="verification_list")
        self.assertEqual(status, 200, out)
        by = {r["id"]: r["integrity"] for r in out["verifications"]}
        self.assertEqual(by[good["id"]], "ok")
        self.assertEqual(sorted(v for k, v in by.items() if k != good["id"]), ["invalid"] * 4)
        status, rel = post(action="verification_related", targets=[good["target"]])
        self.assertEqual([r["id"] for r in rel["results"][0]["verifications"]], [good["id"]])
        self.assertEqual(rel["unavailable"], 4)

    def test_oversize_file_is_invalid_not_read(self):
        v = self.vc()
        self.path_of(v).write_bytes(b"x" * (ver.FILE_BYTES_MAX + 10000))
        ver.drop_index()
        by = {r["id"]: r["integrity"] for r in post(action="verification_list")[1]["verifications"]}
        self.assertEqual(by[v["id"]], "invalid")

    def test_tampered_signoff_is_corrupt(self):
        v = self.sign(self.ready())["verification"]
        raw = json.loads(self.path_of(v).read_text())
        raw["signoffs"][0]["evidence"][0]["seal"] = {"content_sha256": "f" * 64, "rev": 99}
        raw["seal"] = ver.seal(raw)  # even a re-sealed record cannot hide a signoff whose own hash no longer matches
        self.path_of(v).write_text(json.dumps(raw))
        ver.drop_index()
        self.assertEqual(self.getv(v)["integrity"], "corrupt")


# ================================================================ reads: list / related / index


class IndexTests(VBase):
    def test_list_filters_and_bounds(self):
        a = self.vc(self.t_block(), question="A ?")
        b = self.ready()
        c = self.vc(self.t_source())
        status, out = post(action="verification_list")
        self.assertEqual((len(out["verifications"]), out["counts"], out["total"]), (3, {"open": 2, "ready": 1, "verified": 0, "needs_followup": 0}, 3))
        self.assertEqual([r["id"] for r in post(action="verification_list", status="ready")[1]["verifications"]], [b["id"]])
        self.assertEqual([r["id"] for r in post(action="verification_list", target_kind="source")[1]["verifications"]], [c["id"]])
        self.assertEqual({r["id"] for r in post(action="verification_list", project_id=self.proj["id"])[1]["verifications"]}, {a["id"], b["id"]})
        for bad in ({"status": "done"}, {"target_kind": "task"}, {"project_id": "x"}, {"q": "texte"}):
            self.assertEqual(post(action="verification_list", **bad)[0], 400, bad)
        with mock.patch.object(ver, "LIST_MAX", 2):
            out = post(action="verification_list")[1]
            self.assertEqual((len(out["verifications"]), out["truncated"]), (2, True))
        self.assertNotIn("request_id", out["verifications"][0])
        self.assertNotIn("evidence", out["verifications"][0])

    def test_related_finds_targets_and_evidence_from_headers_only(self):
        tb = self.t_block()
        v1 = self.vc(tb)
        v2 = self.ev_add(self.vc(self.t_page()), tb)
        other = self.vc(self.t_source())
        with mock.patch.object(ver, "observe_ref", side_effect=AssertionError("related must never resolve evidence")):
            status, out = post(action="verification_related", targets=[tb, self.t_source()])
        self.assertEqual(status, 200, out)
        first, second = out["results"]
        self.assertEqual({(r["id"], r["role"]) for r in first["verifications"]}, {(v1["id"], "target"), (v2["id"], "evidence")})
        self.assertEqual([(r["id"], r["role"]) for r in second["verifications"]], [(other["id"], "target")])
        self.assertEqual(first["counts"]["open"], 2)

    def test_related_bounds_and_shapes(self):
        t = self.t_block()
        self.assertEqual(post(action="verification_related", targets=[])[0], 400)
        self.assertEqual(post(action="verification_related", targets=[t] * 0 + [{**t, "block_id": f"block-{n}"} for n in range(11)])[0], 400)
        self.assertEqual(post(action="verification_related", targets=[t], extra=1)[0], 400)
        self.assertEqual(post(action="verification_related", targets=[{"kind": "bogus"}])[0], 400)
        self.assertEqual(post(action="verification_related", targets=[t, t])[1]["results"][0]["verifications"], [])
        self.assertEqual(len(post(action="verification_related", targets=[t, t])[1]["results"]), 1)

    def test_related_by_review_item_ids_ignores_the_fingerprint(self):
        t = self.t_item()
        v = self.vc(t)
        out = post(action="verification_related", targets=[{"kind": "review_item", "review_id": t["review_id"], "item_id": t["item_id"]}])[1]
        self.assertEqual([r["id"] for r in out["results"][0]["verifications"]], [v["id"]])

    def test_related_by_citation_value(self):
        page, blk, cite = self.cited_page()
        v = self.vc(self.ctarget(page, blk, cite))
        out = post(action="verification_related", targets=[self.ctarget(page, blk, cite)])[1]
        self.assertEqual([r["id"] for r in out["results"][0]["verifications"]], [v["id"]])

    def test_dropped_cache_rebuilds_the_same_answers_and_invalidates_on_every_write(self):
        a = self.vc()
        b = self.ready()
        first = post(action="verification_list")[1]
        ver.drop_index()
        self.assertEqual(post(action="verification_list")[1], first)
        a2 = self.va("verification_update", a, note="n")
        self.assertEqual({r["id"]: r["rev"] for r in post(action="verification_list")[1]["verifications"]}[a["id"]], a2["rev"])
        self.st(b, "needs_followup", followup_note="x")
        self.assertEqual(post(action="verification_list", status="needs_followup")[1]["verifications"][0]["id"], b["id"])
        self.assertEqual(post(action="verification_delete", id=a2["id"], expected_rev=a2["rev"], confirm=True)[0], 200)
        self.assertEqual([r["id"] for r in post(action="verification_list")[1]["verifications"]], [b["id"]])
        # an out-of-band edit is seen because the cache is keyed by file identity, not trusted blindly
        raw = json.loads(self.path_of(b).read_text())
        raw["note"] = "modifié hors bande"
        self.path_of(b).write_text(json.dumps(raw))
        self.assertEqual(post(action="verification_list")[1]["verifications"][0]["integrity"], "corrupt")

    def test_cold_start_is_bounded_by_the_file_count_cap(self):
        d = self.tmp / ".hq-carnet" / "verifications"
        d.mkdir(parents=True, exist_ok=True)
        with mock.patch.object(ver, "TOTAL_MAX", 3):
            for n in range(4 + 50):
                (d / f"ver-{n:024x}.json").write_text("{}")
            status, out = post(action="verification_list")
            self.assertEqual(status, 503, out)

    def test_total_limit(self):
        with mock.patch.object(ver, "TOTAL_MAX", 2):
            self.vc()
            self.vc(self.t_page())
            self.assertEqual(self.vc(self.t_source(), expect=409)["code"], "verification_limit")

    def test_project_limit(self):
        with mock.patch.object(ver, "PROJECT_MAX", 1):
            self.vc(self.t_block(1))
            self.assertEqual(self.vc(self.t_block(2), expect=409)["code"], "verification_limit")

    def test_hostile_text_is_stored_exactly_and_never_interpreted(self):
        text = "<img src=x onerror=alert(1)> **gras** [x](javascript:alert(1)) \n\tligne"
        v = self.vc(question=text)
        v = self.va("verification_update", v, note="<script>alert(1)</script>")
        got = self.getv(v)
        self.assertEqual((got["question"], got["note"]), (text, "<script>alert(1)</script>"))


# ================================================================ trust path: snapshot / review reads cannot be redirected


class TrustPathTests(VBase):
    def setUp(self):
        super().setUp()
        self.secret = self.tmp / "outside-secret.json"

    def snap_path(self, sid):
        return self.tmp / ".hq-carnet" / "snapshots" / (sid + ".json")

    def rev_path(self, rid_):
        return self.tmp / ".hq-carnet" / "reviews" / (rid_ + ".json")

    def test_snapshot_swapped_to_a_symlink_before_read_fails_closed_and_signoff_records_nothing(self):
        t = self.t_snapshot()
        v = self.ready(self.t_page(), [t])
        path = self.snap_path(t["snapshot_id"])
        good = path.read_bytes()
        self.secret.write_bytes(good.replace(b"Gel", b"Pir"))  # a perfectly valid-looking redirect target
        path.unlink()
        path.symlink_to(self.secret)
        obs = ver.observe_ref(t, evidence.World())
        self.assertEqual((obs["state"], obs["seal"]), ("unknown", None), "the redirect is never followed")
        raw = self.path_of(v).read_bytes()
        out = self.sign(v, expect=409)
        self.assertEqual(out["code"], "verification_evidence_unavailable")
        self.assertEqual(self.path_of(v).read_bytes(), raw)
        with self.assertRaises(snaps.SnapshotStorageError):
            snaps.get(t["snapshot_id"])

    def test_review_swapped_to_a_symlink_before_read_fails_closed(self):
        t = self.t_item()
        self.full_item = self.full(t)
        v = self.vc(self.t_page())
        v = self.st(self.ev_add(v, t), "ready")
        path = self.rev_path(t["review_id"])
        self.secret.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(self.secret)
        self.assertEqual(ver.observe_ref(self.full_item, evidence.World())["state"], "unknown")
        self.assertEqual(self.sign(v, expect=409)["code"], "verification_evidence_unavailable")
        with self.assertRaises(reviews.ReviewStorageError):
            reviews.get(t["review_id"])
        self.assertEqual(self.getv(v)["signoffs"], [])

    def test_open_time_swap_after_the_lstat_is_caught_by_the_descriptor_check(self):
        import hq_carnet_canon as canon

        t = self.t_snapshot()
        path = self.snap_path(t["snapshot_id"])
        self.secret.write_bytes(b'{"redirected": true}')
        real_open = os.open
        calls = []

        def swap_then_open(p, flags, *a, **kw):
            if str(p) == str(path) and not calls:
                calls.append(1)
                path.unlink()
                path.symlink_to(self.secret)  # the race: lstat saw a regular file, the name is replaced before open()
            return real_open(p, flags, *a, **kw)

        with mock.patch.object(canon.os, "open", side_effect=swap_then_open):
            obs = ver.observe_ref(t, evidence.World())
        self.assertEqual((calls, obs["state"]), ([1], "unknown"))

    def test_deleted_between_probe_and_read_is_missing_not_unknown(self):
        t = self.t_snapshot()
        path = self.snap_path(t["snapshot_id"])
        path.unlink()
        self.assertEqual(ver.observe_ref(t, evidence.World())["state"], "missing")
        ti = self.full(self.t_item())
        self.rev_path(ti["review_id"]).unlink()
        self.assertEqual(ver.observe_ref(ti, evidence.World())["state"], "missing")

    def test_directory_replacement_fails_closed(self):
        t = self.t_snapshot()
        ti = self.full(self.t_item())
        for sub, ref in (("snapshots", t), ("reviews", ti)):
            d = self.tmp / ".hq-carnet" / sub
            moved = self.tmp / (sub + "-real")
            d.rename(moved)
            d.symlink_to(moved)
            try:
                self.assertIn(ver.observe_ref(ref, evidence.World())["state"], ("unknown", "missing"), sub)
                self.assertNotEqual(ver.observe_ref(ref, evidence.World())["state"], "ok", sub)
            finally:
                d.unlink()
                moved.rename(d)
            self.assertEqual(ver.observe_ref(ref, evidence.World())["state"], "ok", sub)

    def test_stable_canonical_files_read_normally(self):
        t = self.t_snapshot()
        ti = self.full(self.t_item())
        a = ver.observe_ref(t, evidence.World())
        b = ver.observe_ref(ti, evidence.World())
        self.assertEqual((a["state"], b["state"]), ("ok", "ok"))
        self.assertEqual(a["seal"], {"content_sha256": snaps.get(t["snapshot_id"])["snapshot"]["content_sha256"]})
        self.assertEqual(snaps.get(t["snapshot_id"])["integrity"], "ok")
        self.assertEqual(reviews.get(ti["review_id"])["integrity"], "ok")

    def test_corrupt_but_canonical_record_stays_corrupt_not_unknown(self):
        t = self.t_snapshot()
        ti = self.full(self.t_item())
        d = json.loads(self.snap_path(t["snapshot_id"]).read_text())
        d["label"] = "x"
        self.snap_path(t["snapshot_id"]).write_text(json.dumps(d))
        d = json.loads(self.rev_path(ti["review_id"]).read_text())
        d["title"] = "x"
        self.rev_path(ti["review_id"]).write_text(json.dumps(d))
        self.assertEqual(snaps.get(t["snapshot_id"])["integrity"], "corrupt")
        self.assertEqual(reviews.get(ti["review_id"])["integrity"], "corrupt")
        self.assertEqual(ver.observe_ref(t, evidence.World())["state"], "corrupt")
        self.assertEqual(ver.observe_ref(ti, evidence.World())["state"], "corrupt")

    def test_a_fifo_or_oversize_substitute_is_refused_without_hanging(self):
        if not hasattr(os, "mkfifo"):
            self.skipTest("no mkfifo")
        t = self.t_snapshot()
        path = self.snap_path(t["snapshot_id"])
        path.unlink()
        os.mkfifo(path)
        self.assertEqual(ver.observe_ref(t, evidence.World())["state"], "unknown")


# ================================================================ backup


class BackupTests(VBase):
    def test_backup_copies_verification_state_but_not_foreign_files(self):
        v = self.sign(self.ready(self.t_page(), [self.t_source(self.ed("Avec PDF", file_ref=self.pdf()))]))["verification"]
        self.vc(self.t_block())
        dest = self.tmp / "backup"
        out = hq_carnet.snapshot_to(self.tmp, dest)
        self.assertTrue(out["valid"] and out["verifications"]["valid"])
        self.assertEqual(out["verifications"]["count"], 2)
        for p in self.files():
            self.assertEqual((dest / "verifications" / p.name).read_bytes(), p.read_bytes())
        self.assertEqual(out["verifications"]["bytes"], sum(p.stat().st_size for p in self.files()))
        self.assertEqual(sorted(p.name for p in dest.rglob("*.pdf")), [], "evidence references never pull in the PDF")
        copied = json.loads((dest / "verifications" / (v["id"] + ".json")).read_text())
        self.assertEqual((copied["signoffs"], copied["seal"] == ver.seal(copied)), (v["signoffs"], True))
        self.assertNotIn("refused", out["verifications"])

    def pdf(self):
        self.put("Uni/ref.pdf", b"%PDF-1.4 x")
        return "Uni/ref.pdf"

    def test_no_key_when_there_are_no_verifications_and_alone_they_make_a_backup_present(self):
        self.page_of(para("x"))
        self.assertNotIn("verifications", hq_carnet.snapshot_to(self.tmp, self.tmp / "b1"))
        self.vc()
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "b2")
        self.assertEqual((out["status"], out["verifications"]["count"]), ("included", 1))

    def test_corrupt_record_travels_and_reports_invalid(self):
        v = self.vc()
        raw = json.loads(self.path_of(v).read_text())
        raw["question"] = "altérée"
        data = json.dumps(raw).encode()
        self.path_of(v).write_bytes(data)
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertFalse(out["valid"])
        self.assertFalse(out["verifications"]["valid"])
        self.assertEqual((self.tmp / "backup" / "verifications" / self.path_of(v).name).read_bytes(), data)

    def test_final_file_swaps_are_refused_and_never_followed(self):
        v = self.vc()
        path = self.path_of(v)
        secret = self.tmp / "secret.txt"
        secret.write_text("NE-DOIT-PAS-ETRE-LU")
        for swap in ("link", "dir", "gone"):
            real_closure = ver.closure

            def swapped(root, _swap=swap):
                got = real_closure(root)
                path.unlink()
                if _swap == "link":
                    path.symlink_to(secret)
                elif _swap == "dir":
                    path.mkdir()
                return got

            dest = self.tmp / ("backup-" + swap)
            with mock.patch.object(ver, "closure", side_effect=swapped):
                out = hq_carnet.snapshot_to(self.tmp, dest)
            self.assertEqual(out["verifications"]["refused"], 1, swap)
            self.assertFalse(out["valid"] or out["verifications"]["valid"], swap)
            self.assertFalse((dest / "verifications" / path.name).exists(), swap)
            self.assertNotIn("NE-DOIT-PAS-ETRE-LU", "".join(p.read_text(errors="ignore") for p in dest.rglob("*") if p.is_file()), swap)
            if swap == "dir":
                path.rmdir()
            elif path.is_symlink() or path.exists():
                path.unlink()
            v = self.vc()
            path = self.path_of(v)

    def test_redirected_store_directory_is_refused(self):
        self.vc()
        d = self.tmp / ".hq-carnet" / "verifications"
        moved = self.tmp / "elsewhere"
        d.rename(moved)
        d.symlink_to(moved)
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertFalse(out.get("valid", False) and out.get("verifications", {}).get("valid", True))
        self.assertEqual(post(action="verification_list")[0], 409)


# ================================================================ Ask / search / report boundaries


class BoundaryTests(VBase):
    def test_the_note_and_status_never_enter_ask(self):
        import hq_carnet_review as review

        scope = {"kind": "project", "id": self.proj["id"]}
        before = review.ask({"action": "ask", "question": "usiné", "scope": scope})
        v = self.ready()
        v = self.va("verification_update", v, note="CONCLUSION-SECRETE-XYZ palier usiné")
        v = self.sign(v)["verification"]
        after = review.ask({"action": "ask", "question": "usiné", "scope": scope})
        self.assertEqual(after["fingerprint"], before["fingerprint"])
        self.assertNotIn("CONCLUSION-SECRETE-XYZ", json.dumps(after, ensure_ascii=False))
        none = review.ask({"action": "ask", "question": "CONCLUSION-SECRETE-XYZ", "scope": scope})
        self.assertEqual(none.get("cards", none.get("results", [])), [])

    def test_regular_reports_and_snapshots_do_not_include_verifications(self):
        v = self.ready()
        v = self.va("verification_update", v, note="NOTE-SECRETE-777")
        self.sign(v)
        status, out = post(action="report_build", items=[{"kind": "source", "edition_id": self.sedition["id"]}])
        self.assertEqual(status, 200, out)
        self.assertNotIn("NOTE-SECRETE-777", json.dumps(out, ensure_ascii=False))
        self.assertNotIn(QUESTION, json.dumps(out, ensure_ascii=False))
        sid = self.snap()
        self.assertNotIn("NOTE-SECRETE-777", json.dumps(snaps.get(sid)["snapshot"], ensure_ascii=False))
        self.assertNotIn(v["id"], json.dumps(snaps.get(sid)["snapshot"]))

    def test_action_surface_is_pinned(self):
        want = {"verification_list", "verification_get", "verification_resolve", "verification_related", "verification_create", "verification_update",
                "verification_evidence_add", "verification_evidence_remove", "verification_status", "verification_signoff", "verification_delete"}
        self.assertEqual(set(ver.ACTIONS), want)
        for a in want:
            self.assertIn(a, hq_carnet._STAGE08)
        self.assertEqual(ver.STATUSES, ("open", "ready", "verified", "needs_followup"))
        self.assertEqual(ver.KINDS, ("page", "block", "source", "citation", "drawing", "snapshot", "review_item"))
        for banned in ("assign", "due", "priority", "board", "notify", "mention", "chat", "author", "signed_by"):
            self.assertFalse(any(banned in a for a in ver.ACTIONS), banned)
            self.assertNotIn(f'"{banned}"', json.dumps(sorted(ver.REC_KEYS | ver.SIGN_KEYS)))

    def test_read_actions_are_read_only(self):
        v = self.sign(self.ready())["verification"]
        before = digest_without(self.tmp)
        post(action="verification_list")
        post(action="verification_get", id=v["id"])
        post(action="verification_resolve", id=v["id"])
        post(action="verification_related", targets=[v["target"]])
        self.assertEqual(digest_without(self.tmp), before)
        for action in ("verification_list", "verification_get", "verification_resolve", "verification_related"):
            self.assertEqual(post(action=action, id=v["id"], expected_rev=1, confirm=True, extra=1, targets=[v["target"]])[0], 400, action)


class ReportTests(VBase):
    def build(self, v, expect=200):
        status, out = post(action="report_build", items=[{"kind": "verification", "verification_id": v["id"]}], include_sources=False)
        self.assertEqual(status, expect, out)
        return out

    def test_section_is_procedural_deterministic_and_note_free(self):
        v = self.ready(self.t_block(3), [self.t_source()])
        v = self.va("verification_update", v, note="NOTE-PRIVEE-999")
        opened = self.build(v)["markdown"]
        self.assertIn("État de vérification : Prête à vérifier", opened)
        self.assertIn("Vérification enregistrée : aucune", opened)
        v = self.sign(v)["verification"]
        md = self.build(v)["markdown"]
        self.assertIn("État de vérification : Vérifiée", md)
        self.assertRegex(md, r"Vérification enregistrée : 20\d\d-")
        self.assertIn("État actuel des preuves : inchangé depuis la vérification", md)
        self.assertIn(QUESTION, md)
        self.assertEqual(md, self.build(v)["markdown"], "deterministic")
        self.assertNotIn("NOTE-PRIVEE-999", md)
        for banned in ("conforme", "approuvé", "Requirement satisfied", "Compliance", "Design approved", "validé"):
            self.assertNotIn(banned, md)
        self.assertIn("aucune identité de relecteur authentifiée", md)
        self.edit_block_text(self.pg, 3, "modifié")
        self.assertIn("État actuel des preuves : modifié depuis la vérification", self.build(v)["markdown"] if False else self.build(self.getv(v))["markdown"])

    def test_corrupt_unknown_and_hostile(self):
        v = self.vc(question="<script>alert(1)</script> | **x**")
        md = self.build(v)["markdown"]
        self.assertNotIn("<script>", md)
        self.build({"id": "ver-" + "0" * 24}, 404)
        status, out = post(action="report_build", items=[{"kind": "verification", "verification_id": "x"}])
        self.assertEqual(status, 400)
        raw = json.loads(self.path_of(v).read_text())
        raw["note"] = "x"
        self.path_of(v).write_text(json.dumps(raw))
        ver.drop_index()
        self.build(v, 409)

    def test_building_a_report_writes_nothing_to_the_store(self):
        v = self.sign(self.ready())["verification"]
        raw = self.path_of(v).read_bytes()
        self.build(v)
        self.assertEqual(self.path_of(v).read_bytes(), raw)


class StaticTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parent.parent

    def test_ask_search_snapshot_history_modules_never_import_the_verification_store(self):
        for name in ("hq_carnet_ask.py", "hq_carnet_review.py", "hq_carnet_intel.py", "hq_carnet_history.py", "hq_carnet_snapshots.py", "hq_carnet_restore.py",
                     "hq_carnet_bulk.py", "hq_carnet_links.py", "hq_carnet_reader.py", "hq_carnet_reviews.py", "hq_carnet_sources.py", "hq_carnet_portals.py"):
            src = (self.ROOT / name).read_text(encoding="utf-8")
            self.assertNotIn("hq_carnet_verifications", src, name)
            self.assertNotIn(".hq-carnet/verifications", src, name)
            self.assertNotIn('"verifications"', src, name)

    def test_module_has_no_network_shell_eval_or_bare_reads(self):
        src = (self.ROOT / "hq_carnet_verifications.py").read_text(encoding="utf-8")
        for needle in ("subprocess", "socket", "urllib.request", "http.client", "eval(", "exec(", "os.system", "requests", "webbrowser", "shutil", "getpass", "os.getlogin", "environ"):
            self.assertNotIn(needle, src, needle)
        for bare in ("read_bytes(", "read_text("):
            self.assertNotIn(bare, src, "store files are read only through the descriptor-bound canonical reader")
        for flag in ("O_RDWR", "O_APPEND", "O_TRUNC"):
            self.assertNotIn(flag, src, flag)

    def test_no_identity_field_exists_in_the_schema(self):
        src = (self.ROOT / "hq_carnet_verifications.py").read_text(encoding="utf-8")
        for field in ("signed_by", "author", "username", "reviewer_id", "assignee", "due_at", "priority"):
            self.assertNotIn(f'"{field}"', src, field)

    def test_trust_path_readers_use_the_shared_descriptor_bound_reader(self):
        for name in ("hq_carnet_snapshots.py", "hq_carnet_reviews.py"):
            src = (self.ROOT / name).read_text(encoding="utf-8")
            body = src.split("def _read_one", 1)[1].split("\ndef ", 1)[0]
            self.assertIn("canon.read_regular", body, name)
            self.assertNotIn("read_bytes(", body, name)


if __name__ == "__main__":
    unittest.main()
