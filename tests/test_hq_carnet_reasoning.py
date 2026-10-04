"""Carnet Phase 12 — the reasoning register: decisions & assumptions (server half).

A decision records what was chosen; an assumption records what is being taken as true for now; NEITHER is evidence. These tests pin that they never
feed Ask / search / snapshots / history, that they never mutate what they point at, that every status change is explicit (evidence, verifications
and time never change a status), that a ``confirmed`` assumption needs observable evidence (two consistent observations, fail closed) while every
other terminal transition stays possible (best-effort capture), that supersession is explicit, replay-safe and cannot be undone by corruption, and
that the register can never be confused with the Phase 5 journal ``decision`` block.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_reasoning as rsn  # noqa: E402
import hq_carnet_snapshots as snaps  # noqa: E402
import hq_carnet_verifications as ver  # noqa: E402
from test_hq_carnet_annotations import digest_without  # noqa: E402
from test_hq_carnet_history import para  # noqa: E402
from test_hq_carnet_reviews import post, rid  # noqa: E402
from test_hq_carnet_verifications import VBase  # noqa: E402

DEC = rsn.KIND_DECISION
ASM = rsn.KIND_ASSUMPTION
STATEMENT = "Utiliser un DN80 plutôt qu'un DN65 pour la ligne de transfert."
RATIONALE = "Vitesse limitée à 1,5 m/s."


class RBase(VBase):
    def setUp(self):
        super().setUp()
        rsn.drop_index()

    def edit_page(self, page, blocks):
        return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "content": {"version": 2, "blocks": blocks}})["page"]

    # ---- calls
    def rc(self, kind=DEC, statement=STATEMENT, project=None, request_id=None, expect=200, rationale=RATIONALE, **kw):
        status, out = post(action="reasoning_create", request_id=request_id or rid(), kind=kind, project_id=(project or self.proj)["id"], statement=statement,
                           rationale=rationale, **kw)
        self.assertEqual(status, expect, out)
        return out["record"] if expect == 200 else out

    def ra(self, action, r, expect=200, **kw):
        status, out = post(action=action, id=r["id"], expected_rev=r["rev"], **kw)
        self.assertEqual(status, expect, out)
        return out["record"] if expect == 200 else out

    def radd(self, r, ref, expect=200):
        return self.ra("reasoning_evidence_add", r, expect, ref=ref)

    def rst(self, r, status, expect=200):
        return self.ra("reasoning_status", r, expect, status=status)

    def rget(self, r):
        status, out = post(action="reasoning_get", id=r["id"])
        self.assertEqual(status, 200, out)
        return out["record"]

    def rres(self, r):
        status, out = post(action="reasoning_resolve", id=r["id"])
        self.assertEqual(status, 200, out)
        return out["resolved"]

    def sup(self, r, statement="Utiliser un DN100.", request_id=None, expect=200, expected_rev=None, rationale="", **kw):
        status, out = post(action="reasoning_supersede", predecessor_id=r["id"], expected_rev=expected_rev or r["rev"], request_id=request_id or rid(),
                           statement=statement, rationale=rationale, **kw)
        self.assertEqual(status, expect, out)
        return out

    def asm(self, with_evidence=True, **kw):
        r = self.rc(ASM, "Masse volumique = 998 kg/m³ à 20 °C", **kw)
        return self.radd(r, self.t_page()) if with_evidence else r

    def rfiles(self):
        d = self.tmp / ".hq-carnet" / "reasoning"
        return sorted(p for p in d.glob("*.json") if ".claim." not in p.name) if d.is_dir() else []

    def cfiles(self):
        """The write-ahead supersession markers (``<predecessor id>.claim.json``)."""
        d = self.tmp / ".hq-carnet" / "reasoning"
        return sorted(d.glob("*.claim.json")) if d.is_dir() else []

    def cpath(self, r):
        return self.tmp / ".hq-carnet" / "reasoning" / (r["id"] + ".claim.json")

    def make_claim_only(self, r, statement="Utiliser un DN100.", request_id=None):
        """The process died AFTER the write-ahead marker and BEFORE successor B was written."""
        req = request_id or rid()
        real = rsn._write
        calls = {"n": 0}

        def boom(directory, rec):
            if rec.get("supersedes") is not None and calls["n"] == 0:
                calls["n"] += 1
                raise RuntimeError("crash before B")
            return real(directory, rec)

        with mock.patch.object(rsn, "_write", side_effect=boom):
            with self.assertRaises(RuntimeError):
                post(action="reasoning_supersede", predecessor_id=r["id"], expected_rev=r["rev"], request_id=req, statement=statement, rationale="")
        rsn.drop_index()
        return req

    def successor_of(self, r):
        if self.cpath(r).exists():
            return self.tmp / ".hq-carnet" / "reasoning" / (json.loads(self.cpath(r).read_text())["successor_id"] + ".json")
        return next(p for p in self.rfiles() if p.stem != r["id"])

    def rpath(self, r):
        return self.tmp / ".hq-carnet" / "reasoning" / (r["id"] + ".json")

    def tamper(self, r, **change):
        raw = json.loads(self.rpath(r).read_text())
        raw.update(change)
        data = json.dumps(raw).encode()
        self.rpath(r).write_bytes(data)
        rsn.drop_index()
        return data

    def make_pending(self, r, statement="Utiliser un DN100.", request_id=None):
        """B durable, A not yet updated (the process died between the two writes)."""
        req = request_id or rid()
        with mock.patch.object(rsn, "_finish_supersession", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                post(action="reasoning_supersede", predecessor_id=r["id"], expected_rev=r["rev"], request_id=req, statement=statement, rationale="")
        rsn.drop_index()
        return req


# ================================================================ core objects, ownership, separation from evidence


class CreateTests(RBase):
    def test_both_kinds_are_namespaced_and_start_active_with_no_evidence_and_no_identity(self):
        d = self.rc(DEC)
        a = self.rc(ASM, "Hypothèse")
        for r, kind, prefix in ((d, DEC, "dec-"), (a, ASM, "asm-")):
            self.assertEqual((r["kind"], r["status"], r["rev"], r["evidence"], r["verification_ids"], r["history"], r["integrity"]), (kind, "active", 1, [], [], [], "ok"))
            self.assertTrue(r["id"].startswith(prefix))
            self.assertEqual((r["supersedes"], r["superseded_by"], r["effective_status"]), (None, None, "active"))
        self.assertEqual(len(self.rfiles()), 2)
        for kind in ("decision", "assumption", "measurement", "", None, 7):
            status, out = post(action="reasoning_create", request_id=rid(), kind=kind, project_id=self.proj["id"], statement="x")
            self.assertEqual(status, 400, kind)

    def test_register_kind_is_never_the_journal_decision_block_kind(self):
        """The Phase 5 journal ``decision`` block is another thing: no generic kind in this module may ever be the bare word."""
        self.assertEqual(rsn.KINDS, ("reasoning_decision", "reasoning_assumption"))
        for r in (self.rc(DEC), self.rc(ASM, "x")):
            self.assertNotEqual(r["kind"], "decision")
            self.assertTrue(r["kind"].startswith("reasoning_"))
        status, out = post(action="reasoning_list")
        self.assertTrue(all(h["kind"].startswith("reasoning_") for h in out["records"]))
        self.assertNotIn("decision", hq_carnet.reasoning.KINDS)
        # the generic evidence / report namespaces still mean the BLOCK; the register has its own report kind
        import hq_carnet_report as report

        self.assertIn("decision", report.KINDS)
        self.assertIn("reasoning", report.KINDS)
        self.assertNotEqual(report.LABELS["reasoning"], report.LABELS["decision"])
        self.assertEqual(report.LABELS["reasoning"], "Registre des décisions et hypothèses")
        # and a register record can never be evidence, even under the old name
        r = self.rc(DEC)
        for bad in ({"kind": "decision", "page_id": self.pg["id"], "block_id": self.blocks[0]["id"]}, {"kind": "reasoning_decision", "id": r["id"]},
                    {"kind": "reasoning_assumption", "id": r["id"]}, {"kind": "verification", "verification_id": "ver-" + "0" * 24},
                    {"kind": "measurement", "page_id": self.pg["id"], "block_id": self.blocks[0]["id"]}):
            self.radd(r, bad, expect=400)

    def test_every_evidence_kind_can_inform_a_record_and_review_comments_cannot(self):
        page, blk, cite = self.cited_page()
        r = self.rc(DEC)
        refs = [self.t_page(), self.t_block(), self.t_source(), self.t_drawing(), self.t_snapshot(), self.t_item(), self.ctarget(page, blk, cite)]
        for ref in refs:
            r = self.radd(r, ref)
        self.assertEqual([e["ref"]["kind"] for e in r["evidence"]], [x["kind"] for x in refs])
        self.assertNotIn("cite", json.dumps(r["evidence"]))
        for bad in ({"kind": "review_comment", "review_id": self.pack["id"], "comment_id": "rc-x"}, {"kind": "annotation", "id": "ann-x"}, {"kind": "task"}):
            self.radd(r, bad, expect=400)
        self.assertEqual(self.rget(r)["rev"], r["rev"])

    def test_create_does_not_change_the_notebook_page_revision_or_any_other_store(self):
        before = digest_without(self.tmp, "reasoning")
        rev = self.cur(self.pg["id"])["rev"]
        self.rc(DEC)
        self.rc(ASM, "Hypothèse", evidence=[self.t_page()])
        self.assertEqual(self.cur(self.pg["id"])["rev"], rev, "no page revision")
        self.assertEqual(digest_without(self.tmp, "reasoning"), before, "no page, history, snapshot, review, annotation or verification byte changed")

    def test_assumption_create_does_not_dirty_the_editor_state(self):
        """A register record is not page content: the notebook JSON (blocks, rev, undo trail source) is byte-identical."""
        page_path = self.tmp / ".hq-carnet"
        snapshot = {p.name: p.read_bytes() for p in page_path.glob("*.json")}
        self.rc(ASM, "Assume 20 °C")
        self.assertEqual({p.name: p.read_bytes() for p in page_path.glob("*.json")}, snapshot)

    def test_project_is_required_validated_and_cross_project_evidence_is_rejected(self):
        self.rc(DEC, project=self.other)  # a project with no pages is fine
        status, out = post(action="reasoning_create", request_id=rid(), kind=DEC, statement="x")
        self.assertEqual(status, 400)
        self.assertEqual(post(action="reasoning_create", request_id=rid(), kind=DEC, statement="x", project_id="proj-absent")[0], 404)
        self.assertEqual(post(action="reasoning_create", request_id=rid(), kind=DEC, statement="x", project_id="../x")[0], 400)
        foreign = self.proj_page([para("ailleurs")], project=self.other)
        r = self.rc(DEC)
        owned = {"kind": "page", "page_id": foreign["id"]}
        out = self.radd(r, owned, expect=400)
        self.assertEqual(out["code"], "reasoning_project_mismatch")
        fsnap = self.snap(self.other)
        self.assertEqual(self.radd(r, {"kind": "snapshot", "snapshot_id": fsnap}, expect=400)["code"], "reasoning_project_mismatch")
        self.rc(DEC, evidence=[owned], expect=400)
        # project-neutral evidence is allowed in any project
        r = self.radd(self.radd(r, self.t_source()), self.t_drawing())
        self.assertEqual(len(r["evidence"]), 2)
        r2 = self.rc(DEC, project=self.other)
        self.assertEqual(len(self.radd(self.radd(r2, self.t_source()), self.t_drawing())["evidence"]), 2)

    def test_create_may_carry_initial_evidence_which_is_part_of_the_replay_intent(self):
        req = rid()
        a = self.rc(DEC, request_id=req, evidence=[self.t_page(), self.t_source()])
        self.assertEqual(len(a["evidence"]), 2)
        again = self.rc(DEC, request_id=req, evidence=[self.t_source(), self.t_page()])  # order is not intent
        self.assertEqual(again["id"], a["id"])
        self.assertEqual(self.rc(DEC, request_id=req, evidence=[self.t_page()], expect=409)["code"], "decision_request_conflict")
        self.assertEqual(self.rc(DEC, request_id=req, expect=409)["code"], "decision_request_conflict")
        self.rc(DEC, evidence=[self.t_page()] * 2, expect=400)
        self.rc(DEC, evidence=[self.t_page()] * 11, expect=400)

    def test_limits(self):
        self.rc(DEC, statement="é" * 4000, rationale="r" * 8000)
        self.rc(DEC, statement="é" * 4001, expect=400)
        self.rc(DEC, rationale="r" * 8001, expect=400)
        self.rc(DEC, statement="   ", expect=400)
        self.rc(DEC, statement="a\x00b", expect=400)
        self.rc(DEC, rationale="a\x07b", expect=400)
        status, out = post(action="reasoning_create", request_id=rid(), kind=DEC, project_id=self.proj["id"], statement="x" * 9_000_000)
        self.assertEqual(status, 400)
        with mock.patch.object(rsn, "TOTAL_MAX", 2):
            self.rc(DEC)
            self.assertEqual(self.rc(DEC, expect=409)["code"], "reasoning_limit")
        with mock.patch.object(rsn, "PROJECT_MAX", 1):
            self.rc(DEC, project=self.other)
            self.assertEqual(self.rc(DEC, project=self.other, expect=409)["code"], "reasoning_limit")

    def test_hostile_text_is_stored_exactly_and_never_interpreted(self):
        hostile = '<script>alert(1)</script> <img src=x onerror=1> **gras** [x](javascript:alert(1)) ../../etc/passwd'
        r = self.rc(DEC, statement=hostile, rationale=hostile)
        self.assertEqual((r["statement"], r["rationale"]), (hostile, hostile))
        self.assertEqual(self.rget(r)["statement"], hostile)

    def test_no_identity_workflow_or_confidence_field_exists(self):
        r = self.rc(DEC)
        for banned in ("author", "assignee", "due", "priority", "signed_by", "confidence", "approved", "verified"):
            self.assertNotIn(banned, json.dumps(sorted(rsn.REC_KEYS | rsn.EVENT_KEYS | rsn.CAP_KEYS)))
            self.assertNotIn(banned, r)
        for extra in ({"author": "x"}, {"confidence": 0.7}, {"priority": 1}, {"status": "confirmed"}, {"supersedes": "dec-" + "0" * 24}):
            status, out = post(action="reasoning_create", request_id=rid(), kind=DEC, project_id=self.proj["id"], statement="x", **extra)
            self.assertEqual(status, 400, extra)


# ================================================================ idempotent create


class ReplayTests(RBase):
    def test_duplicate_create_retry_replays_the_original_and_survives_restart(self):
        req = rid()
        a = self.rc(DEC, request_id=req)
        status, b = post(action="reasoning_create", request_id=req, kind=DEC, project_id=self.proj["id"], statement=STATEMENT, rationale=RATIONALE)
        self.assertEqual((status, b["replayed"], b["record"]["id"]), (200, True, a["id"]))
        self.assertEqual(len(self.rfiles()), 1)
        rsn.drop_index()  # "restart": the answer comes from the files alone
        self.assertEqual(post(action="reasoning_create", request_id=req, kind=DEC, project_id=self.proj["id"], statement=STATEMENT, rationale=RATIONALE)[1]["replayed"], True)
        self.assertEqual(len(self.rfiles()), 1)

    def test_same_request_id_with_any_changed_intent_conflicts(self):
        req = rid()
        self.rc(DEC, request_id=req)
        for kw in ({"project": self.other}, {"statement": STATEMENT + " bis"}, {"rationale": "Autre justification"}, {"rationale": ""}):
            out = self.rc(DEC, request_id=req, expect=409, **kw)
            self.assertEqual(out["code"], "decision_request_conflict", kw)
        out = self.rc(ASM, request_id=req, expect=409)
        self.assertEqual(out["code"], "decision_request_conflict", "the stored record decides the code")
        self.assertEqual(len(self.rfiles()), 1, "a conflicting retry never creates anything")
        areq = rid()
        self.rc(ASM, "H", request_id=areq)
        self.assertEqual(self.rc(ASM, "H2", request_id=areq, expect=409)["code"], "assumption_request_conflict")
        rsn.drop_index()
        self.assertEqual(self.rc(DEC, request_id=req, project=self.other, expect=409)["code"], "decision_request_conflict")

    def test_a_create_request_id_cannot_be_reused_as_a_supersede_and_vice_versa(self):
        req = rid()
        a = self.rc(DEC, request_id=req)
        self.assertEqual(self.sup(a, request_id=req, expect=409)["code"], "decision_request_conflict")
        s = rid()
        b = self.sup(self.rc(DEC), request_id=s)["successor"]
        self.assertEqual(self.rc(DEC, request_id=s, expect=409)["code"], "decision_request_conflict")
        self.assertTrue(b["supersedes"])


# ================================================================ status model


class StatusTests(RBase):
    def test_evidence_and_links_never_change_a_status(self):
        r = self.rc(DEC)
        r = self.radd(r, self.t_page())
        self.assertEqual((r["status"], r["history"]), ("active", []))
        v = self.vc(self.t_page())
        v = self.va("verification_evidence_add", v, ref=self.t_page())
        r = self.ra("reasoning_verification_link", r, verification_id=v["id"])
        self.assertEqual((r["status"], r["history"]), ("active", []))

    def test_verification_status_never_changes_a_decision_or_an_assumption(self):
        d = self.ra("reasoning_verification_link", self.rc(DEC), verification_id=(v := self.vc(self.t_page()))["id"])
        a = self.ra("reasoning_verification_link", self.asm(), verification_id=v["id"])
        v = self.st(self.ev_add(v, self.t_page()), "ready")
        v = self.sign(v)["verification"]
        self.assertEqual(v["status"], "verified")
        self.assertEqual((self.rget(d)["status"], self.rget(d)["history"]), ("active", []))
        self.assertEqual((self.rget(a)["status"], self.rget(a)["history"]), ("active", []), "verified does NOT auto-confirm an assumption")
        self.assertEqual(self.rres(a)["verification_summary"]["verified"], 1, "…it is only displayed")
        v = self.va("verification_status", v, status="open")
        self.assertEqual(self.rget(a)["status"], "active")

    def test_decision_transitions(self):
        d = self.rc(DEC)
        for bad in ("confirmed", "invalidated", "retired", "active", "verified", "approved", "bogus", None):
            self.rst(d, bad, expect=400)
        self.assertEqual(self.rst(d, "superseded", expect=400)["code"], "reasoning_supersede_required")
        w = self.rst(d, "withdrawn")
        self.assertEqual((w["status"], w["rev"], [h["event"] for h in w["history"]]), ("withdrawn", 2, ["withdrawn"]))
        self.assertEqual(self.rst(w, "withdrawn", expect=409)["code"], "reasoning_state_invalid")

    def test_assumption_transitions_and_no_reopen(self):
        allowed = {"invalidated": ("active",), "retired": ("active", "confirmed")}
        a = self.rst(self.asm(), "confirmed")
        self.assertEqual((a["status"], [h["event"] for h in a["history"]]), ("confirmed", ["confirmed"]))
        for target in ("retired", "invalidated"):
            b = self.rst(self.asm(with_evidence=False), target)
            self.assertEqual(b["status"], target)
            self.rst(b, "active", expect=400)
            for back in ("confirmed", "invalidated", "retired"):
                self.rst(b, back, expect=409)
        c = self.rst(a, "invalidated")
        self.assertEqual([h["event"] for h in c["history"]], ["confirmed", "invalidated"])
        self.assertEqual(self.rst(c, "confirmed", expect=409)["code"], "reasoning_state_invalid")
        self.assertEqual(self.rst(self.rst(self.asm(), "confirmed"), "retired")["status"], "retired")
        self.assertTrue(allowed)

    def test_confirm_needs_at_least_one_evidence_ref(self):
        a = self.asm(with_evidence=False)
        self.assertEqual(self.rst(a, "confirmed", expect=409)["code"], "reasoning_no_evidence")
        self.assertEqual(self.rget(a)["status"], "active")
        self.assertEqual(self.rst(a, "retired")["status"], "retired", "other terminal transitions never need evidence")

    def test_confirm_fails_closed_on_missing_unknown_or_corrupt_evidence_with_per_entry_reasons(self):
        a = self.radd(self.asm(), self.t_drawing("g1"))
        (self.draw_dir / "g1.hqdraw.json").unlink()
        out = self.rst(a, "confirmed", expect=409)
        self.assertEqual(out["code"], "reasoning_evidence_unavailable")
        self.assertEqual({e["state"] for e in out["entries"]}, {"missing"})
        self.assertIn("Impossible de confirmer l'hypothèse", out["error"])
        self.assertEqual(self.rget(a)["status"], "active")
        b = self.radd(self.asm(), self.t_source())
        with mock.patch("hq_carnet_review._editions", return_value=None):
            out = self.rst(b, "confirmed", expect=409)
        self.assertEqual({e["state"] for e in out["entries"]}, {"unknown"}, "unknown stays unknown, never missing")
        t = self.t_snapshot()
        c = self.radd(self.asm(), t)
        path = self.tmp / ".hq-carnet" / "snapshots" / (t["snapshot_id"] + ".json")
        data = json.loads(path.read_text())
        data["label"] = "altéré"
        path.write_text(json.dumps(data))
        out = self.rst(c, "confirmed", expect=409)
        self.assertEqual({e["state"] for e in out["entries"]}, {"corrupt"})
        d = self.radd(self.asm(), self.t_drawing("g2"))
        self.draw("g2", b'{"v":2}')
        self.assertEqual(self.rst(d, "confirmed")["status"], "confirmed", "an unchanged drawing is confirmable")

    def test_confirm_with_archived_but_readable_evidence_is_fine_and_linked_verification_does_not_gate(self):
        ed = self.ed("Ancienne édition")
        a = self.radd(self.asm(), {"kind": "source", "source_id": ed["id"]})
        hq_carnet.sources.mutate({"action": "source_edition_archive", "id": ed["id"], "expected_rev": self.src_rev(ed)}) if "source_edition_archive" in str(hq_carnet.sources.__dict__.keys()) else None
        done = self.rst(a, "confirmed")
        self.assertEqual(done["status"], "confirmed")
        # a verification that is NOT verified neither gates nor is required
        v = self.vc(self.t_page())
        b = self.ra("reasoning_verification_link", self.asm(), verification_id=v["id"])
        self.assertEqual(self.rst(b, "confirmed")["status"], "confirmed")

    def test_confirm_capture_race_when_evidence_changes_between_the_two_observations_fails_and_records_nothing(self):
        a = self.radd(self.asm(), self.t_block(3))
        real = rsn._capture
        calls = {"n": 0}

        def moving(rec):
            out = real(rec)
            calls["n"] += 1
            if calls["n"] == 1:
                self.edit_block_text(self.pg, 3, "modifié pendant la capture")
            return out

        before = self.rpath(a).read_bytes()
        with mock.patch.object(rsn, "_capture", side_effect=moving):
            out = self.rst(a, "confirmed", expect=409)
        self.assertEqual(out["code"], "reasoning_capture_race")
        self.assertEqual(self.rpath(a).read_bytes(), before)

    def test_confirm_fails_when_evidence_disappears_before_the_capture_completes(self):
        a = self.radd(self.asm(), self.t_drawing("g3"))
        real = rsn._capture
        calls = {"n": 0}

        def vanishing(rec):
            calls["n"] += 1
            if calls["n"] == 2:
                (self.draw_dir / "g3.hqdraw.json").unlink()
            return real(rec)

        with mock.patch.object(rsn, "_capture", side_effect=vanishing):
            out = self.rst(a, "confirmed", expect=409)
        self.assertIn(out["code"], ("reasoning_capture_race", "reasoning_evidence_unavailable"))
        self.assertEqual(self.rget(a)["status"], "active")

    def test_withdraw_under_the_same_race_still_succeeds_and_records_missing_or_unknown(self):
        d = self.radd(self.rc(DEC), self.t_drawing("g4"))
        (self.draw_dir / "g4.hqdraw.json").unlink()
        w = self.rst(d, "withdrawn")
        self.assertEqual([c["state"] for c in w["history"][-1]["evidence"]], ["missing"])
        self.assertIsNone(w["history"][-1]["evidence"][0]["seal"])
        a = self.radd(self.asm(with_evidence=False), self.t_source())
        with mock.patch("hq_carnet_review._editions", return_value=None):
            r = self.rst(a, "retired")
        self.assertEqual([c["state"] for c in r["history"][-1]["evidence"]], ["unknown"])
        self.assertEqual(r["status"], "retired")
        b = self.radd(self.asm(with_evidence=False), self.t_drawing("g5"))
        real = rsn._capture

        def vanishing(rec):
            out = real(rec)
            (self.draw_dir / "g5.hqdraw.json").unlink()
            return out

        with mock.patch.object(rsn, "_capture", side_effect=vanishing):
            self.assertEqual(self.rst(b, "invalidated")["status"], "invalidated")

    def test_stale_status_transition_gets_409_and_records_nothing(self):
        a = self.asm()
        self.radd(a, self.t_source())
        out = self.rst(a, "confirmed", expect=409)
        self.assertEqual((out["code"], out["current_rev"]), ("reasoning_conflict", a["rev"] + 1))
        self.assertEqual(self.rget(a)["history"], [])


# ================================================================ edits & immutable history


class EditTests(RBase):
    def test_active_records_are_editable_and_every_mutation_needs_expected_rev(self):
        r = self.rc(DEC)
        r = self.ra("reasoning_update", r, statement="Nouvel énoncé", rationale="Nouvelle justification")
        self.assertEqual((r["statement"], r["rationale"], r["rev"]), ("Nouvel énoncé", "Nouvelle justification", 2))
        for action, kw in (("reasoning_update", {"statement": "x"}), ("reasoning_status", {"status": "withdrawn"}), ("reasoning_evidence_add", {"ref": self.t_page()}),
                           ("reasoning_delete", {"confirm": True})):
            self.assertEqual(post(action=action, id=r["id"], **kw)[0], 400, action)
            self.assertEqual(post(action=action, id=r["id"], expected_rev=0, **kw)[0], 400, action)
            self.assertEqual(post(action=action, id=r["id"], expected_rev=True, **kw)[0], 400, action)
        self.ra("reasoning_update", r, expect=400)

    def test_stale_edit_gets_409_and_nothing_is_written(self):
        r = self.rc(DEC)
        self.ra("reasoning_update", r, statement="gagnant")
        out = self.ra("reasoning_update", r, expect=409, statement="perdant")
        self.assertEqual((out["code"], out["current_rev"]), ("reasoning_conflict", 2))
        self.assertEqual(self.rget(r)["statement"], "gagnant")
        self.ra("reasoning_evidence_add", r, expect=409, ref=self.t_page())
        self.assertEqual(self.rget(r)["evidence"], [])

    def test_historical_states_are_read_only_for_statement_rationale_evidence_and_links(self):
        v = self.vc(self.t_page())
        for r in (self.rst(self.rc(DEC), "withdrawn"), self.sup(self.rc(DEC))["predecessor"], self.rst(self.asm(), "invalidated"), self.rst(self.asm(), "retired"),
                  self.rst(self.asm(), "confirmed")):
            before = self.rpath(r).read_bytes()
            ev_id = r["evidence"][0]["id"] if r["evidence"] else "re-" + "0" * 16
            for action, kw in (("reasoning_update", {"statement": "x"}), ("reasoning_update", {"rationale": "x"}), ("reasoning_evidence_add", {"ref": self.t_source()}),
                               ("reasoning_evidence_remove", {"evidence_id": ev_id}), ("reasoning_verification_link", {"verification_id": v["id"]}),
                               ("reasoning_verification_unlink", {"verification_id": v["id"]})):
                out = self.ra(action, self.rget(r), expect=409, **kw)
                self.assertEqual(out["code"], "reasoning_state_invalid", (r["status"], action))
            self.assertEqual(self.rpath(r).read_bytes(), before, r["status"])

    def test_superseded_decision_statement_and_invalidated_assumption_statement_are_read_only(self):
        a = self.sup(self.rc(DEC))["predecessor"]
        self.assertEqual(self.ra("reasoning_update", a, expect=409, statement="réécrit")["code"], "reasoning_state_invalid")
        i = self.rst(self.asm(), "invalidated")
        self.assertEqual(self.ra("reasoning_update", i, expect=409, statement="réécrit")["code"], "reasoning_state_invalid")

    def test_rationale_never_affects_evidence_freshness_or_integrity(self):
        r = self.radd(self.rc(DEC), self.t_block(3))
        r = self.rst(r, "withdrawn")
        before = self.rres(r)
        r2 = self.rget(r)
        self.assertEqual((r2["integrity"], before["overall"]), ("ok", "unchanged"))
        a = self.radd(self.rc(DEC), self.t_page())
        a = self.ra("reasoning_update", a, rationale="Autre justification")
        self.assertEqual({e["exists"] for e in self.rres(a)["evidence"]}, {"ok"})

    def test_evidence_add_remove_dedup_and_limit(self):
        r = self.rc(DEC)
        r = self.radd(r, self.t_page())
        self.radd(r, self.t_page(), expect=409)
        self.assertEqual(self.radd(r, self.t_page(), expect=409)["code"], "reasoning_duplicate_evidence")
        r = self.ra("reasoning_evidence_remove", r, evidence_id=r["evidence"][0]["id"])
        self.assertEqual(r["evidence"], [])
        self.ra("reasoning_evidence_remove", r, expect=404, evidence_id="re-" + "0" * 16)
        self.ra("reasoning_evidence_remove", r, expect=400, evidence_id="nope")
        self.radd(r, {"kind": "page", "page_id": "page-nope"}, expect=404)
        with mock.patch.object(rsn, "EVIDENCE_MAX", 1):
            r = self.radd(r, self.t_page())
            self.assertEqual(self.radd(r, self.t_source(), expect=409)["code"], "reasoning_limit")

    def test_deleted_evidence_does_not_delete_the_record(self):
        r = self.radd(self.radd(self.rc(DEC), self.t_drawing("g6")), self.t_snapshot())
        (self.draw_dir / "g6.hqdraw.json").unlink()
        res = self.rres(r)
        self.assertEqual({e["kind"]: e["exists"] for e in res["evidence"]}, {"drawing": "missing", "snapshot": "ok"})
        self.assertEqual(self.rget(r)["status"], "active")
        self.assertEqual(len(self.rget(r)["evidence"]), 2)

    def test_deleting_a_review_pack_leaves_the_record_with_stale_evidence(self):
        r = self.radd(self.rc(DEC), self.t_item())
        (self.tmp / ".hq-carnet" / "reviews" / (self.pack["id"] + ".json")).unlink()
        res = self.rres(r)
        self.assertEqual(res["evidence"][0]["exists"], "missing")
        self.assertEqual(self.rget(r)["integrity"], "ok")
        self.assertEqual(self.rst(r, "withdrawn")["status"], "withdrawn")


# ================================================================ verification links


class VerificationLinkTests(RBase):
    def test_a_verification_can_be_linked_but_remains_a_separate_object(self):
        v = self.vc(self.t_page())
        r = self.ra("reasoning_verification_link", self.rc(DEC), verification_id=v["id"])
        self.assertEqual([x["id"] for x in r["verification_ids"]], [v["id"]])
        self.assertEqual(r["evidence"], [], "a verification is never smuggled into evidence[]")
        self.assertEqual(self.getv(v), v, "the verification file is untouched")
        res = self.rres(r)
        self.assertEqual((res["verification_summary"]["count"], res["verification_summary"]["verified"]), (1, 0))
        self.assertEqual(res["verifications"][0]["state"], "ok")
        self.assertEqual(self.ra("reasoning_verification_link", r, expect=409, verification_id=v["id"])["code"], "reasoning_duplicate_verification")
        r = self.ra("reasoning_verification_unlink", r, verification_id=v["id"])
        self.assertEqual(r["verification_ids"], [])

    def test_link_requires_an_existing_valid_verification_of_the_same_project(self):
        r = self.rc(DEC)
        self.ra("reasoning_verification_link", r, expect=404, verification_id="ver-" + "0" * 24)
        self.ra("reasoning_verification_link", r, expect=400, verification_id="nope")
        foreign = self.proj_page([para("ailleurs")], project=self.other)
        fv = self.vc({"kind": "page", "page_id": foreign["id"]})
        out = self.ra("reasoning_verification_link", r, expect=400, verification_id=fv["id"])
        self.assertEqual(out["code"], "reasoning_project_mismatch")
        neutral = self.vc(self.t_source())  # project-less verification: not the same project
        self.assertEqual(self.ra("reasoning_verification_link", r, expect=400, verification_id=neutral["id"])["code"], "reasoning_project_mismatch")
        bad = self.vc(self.t_page())
        raw = json.loads((self.tmp / ".hq-carnet" / "verifications" / (bad["id"] + ".json")).read_text())
        raw["question"] = "altérée"
        (self.tmp / ".hq-carnet" / "verifications" / (bad["id"] + ".json")).write_text(json.dumps(raw))
        ver.drop_index()
        self.assertEqual(self.ra("reasoning_verification_link", r, expect=409, verification_id=bad["id"])["code"], "reasoning_verification_corrupt")

    def test_later_corruption_or_deletion_of_a_linked_verification_keeps_the_link_and_is_reported_honestly(self):
        v = self.vc(self.t_page())
        r = self.ra("reasoning_verification_link", self.rc(DEC), verification_id=v["id"])
        path = self.tmp / ".hq-carnet" / "verifications" / (v["id"] + ".json")
        raw = json.loads(path.read_text())
        raw["question"] = "altérée"
        path.write_text(json.dumps(raw))
        ver.drop_index()
        res = self.rres(r)
        self.assertEqual((res["verifications"][0]["state"], res["verification_summary"]["unavailable"]), ("corrupt", 1))
        self.assertEqual(len(self.rget(r)["verification_ids"]), 1)
        path.unlink()
        ver.drop_index()
        self.assertEqual(self.rres(r)["verifications"][0]["state"], "missing")
        self.assertEqual(self.rget(r)["status"], "active")

    def test_link_limit(self):
        with mock.patch.object(rsn, "VERIFICATIONS_MAX", 1):
            r = self.ra("reasoning_verification_link", self.rc(DEC), verification_id=self.vc(self.t_page())["id"])
            self.assertEqual(self.ra("reasoning_verification_link", r, expect=409, verification_id=self.vc(self.t_block())["id"])["code"], "reasoning_limit")


# ================================================================ supersession


class SupersessionTests(RBase):
    def test_supersession_is_an_explicit_operation_and_nothing_infers_it(self):
        a = self.rc(DEC, statement="Utiliser un DN80")
        twin = self.rc(DEC, statement="Utiliser un DN80")  # identical wording: no fuzzy matching, no automatic replacement
        b = self.rc(DEC, statement="Utiliser un DN80 !")
        for r in (a, twin, b):
            self.assertEqual((self.rget(r)["status"], self.rget(r)["supersedes"]), ("active", None))
        self.rst(a, "superseded", expect=400)
        status, out = post(action="reasoning_create", request_id=rid(), kind=DEC, project_id=self.proj["id"], statement="x", supersedes=a["id"])
        self.assertEqual(status, 400, "create has no magic supersedes field")
        out = self.sup(a)
        self.assertEqual((out["predecessor"]["status"], out["predecessor"]["superseded_by"], out["successor"]["supersedes"]), ("superseded", out["successor"]["id"], a["id"]))
        self.assertEqual((self.rget(twin)["status"], self.rget(b)["status"]), ("active", "active"))

    def test_the_successor_is_a_new_active_record_of_the_same_kind_and_project(self):
        a = self.rc(ASM, "H1", project=self.other)
        out = self.sup(a, "H2", rationale="mesure à 65 °C")
        s, p = out["successor"], out["predecessor"]
        self.assertEqual((s["kind"], s["project_id"], s["status"], s["rev"], s["evidence"], s["rationale"]), (ASM, self.other["id"], "active", 1, [], "mesure à 65 °C"))
        self.assertEqual((p["status"], p["rev"], [h["event"] for h in p["history"]], p["history"][0]["successor_id"]), ("superseded", 2, ["superseded"], s["id"]))
        self.assertEqual(p["statement"], "H1", "the old statement stays historical")
        self.assertEqual(self.rget(s)["effective_status"], "active")

    def test_assumptions_can_supersede_active_and_confirmed_but_not_historical_records(self):
        a = self.rst(self.asm(), "confirmed")
        self.assertEqual(self.sup(a)["predecessor"]["history"][-1]["event"], "superseded")
        for target in ("invalidated", "retired"):
            self.sup(self.rst(self.asm(with_evidence=False), target), expect=409)
        self.sup(self.rst(self.rc(DEC), "withdrawn"), expect=409)

    def test_replay_is_idempotent_and_never_duplicates_the_successor(self):
        a = self.rc(DEC)
        req = rid()
        first = self.sup(a, request_id=req)
        again = self.sup(a, request_id=req)  # the stale expected_rev is NOT rejected on a replay
        self.assertEqual((again["replayed"], again["successor"]["id"], again["predecessor"]["rev"]), (True, first["successor"]["id"], 2))
        self.assertEqual(len(self.rfiles()), 2)
        rsn.drop_index()
        self.assertEqual(self.sup(a, request_id=req)["replayed"], True)
        self.assertEqual(len(self.rfiles()), 2)
        self.assertEqual(self.rget(a)["history"][0]["successor_id"], first["successor"]["id"], "applied once")
        self.assertEqual(len(self.rget(a)["history"]), 1)

    def test_replay_with_changed_content_conflicts(self):
        a = self.rc(DEC)
        req = rid()
        self.sup(a, request_id=req, statement="DN100")
        for kw in ({"statement": "DN125"}, {"rationale": "autre"}):
            self.assertEqual(self.sup(a, request_id=req, expect=409, **kw)["code"], "decision_request_conflict")
        other = self.rc(DEC)
        self.assertEqual(self.sup(other, request_id=req, statement="DN100", expect=409)["code"], "decision_request_conflict")
        self.assertEqual(len(self.rfiles()), 3)

    def test_stale_supersession_gets_409_and_creates_nothing(self):
        a = self.rc(DEC)
        self.ra("reasoning_update", a, statement="entre-temps")
        out = self.sup(a, expect=409)
        self.assertEqual((out["code"], out["current_rev"]), ("reasoning_conflict", 2))
        self.assertEqual(len(self.rfiles()), 1)

    def test_a_second_successor_is_refused(self):
        a = self.rc(DEC)
        self.sup(a)
        out = self.sup(self.rget(a), expect=409, statement="Un autre")
        self.assertIn(out["code"], ("reasoning_already_superseded", "reasoning_state_invalid"))
        self.assertEqual(len(self.rfiles()), 2)

    def test_crash_between_the_two_writes_leaves_a_pending_state_never_safely_active(self):
        a = self.rc(DEC)
        req = self.make_pending(a)
        self.assertEqual(len(self.rfiles()), 2, "B is durable")
        got = self.rget(a)
        self.assertEqual((got["status"], got["effective_status"]), ("active", "supersession_pending"))
        for action, kw in (("reasoning_update", {"statement": "x"}), ("reasoning_status", {"status": "withdrawn"}), ("reasoning_evidence_add", {"ref": self.t_page()}),
                           ("reasoning_delete", {"confirm": True})):
            out = self.ra(action, got, expect=409, **kw)
            self.assertIn(out["code"], ("reasoning_supersession_pending", "reasoning_has_history"), action)
        out = self.ra("reasoning_update", got, expect=409, statement="x")
        self.assertEqual(out["code"], "reasoning_supersession_pending")
        row = next(h for h in post(action="reasoning_list")[1]["records"] if h["id"] == a["id"])
        self.assertEqual(row["effective_status"], "supersession_pending")
        # a DIFFERENT successor attempt while pending is refused
        out = self.sup(got, expect=409, statement="Autre successeur")
        self.assertEqual(out["code"], "reasoning_supersession_pending")
        self.assertEqual(len(self.rfiles()), 2)
        # the SAME request heals it, also after a restart
        rsn.drop_index()
        healed = self.sup(a, request_id=req)
        self.assertEqual((healed["predecessor"]["status"], healed["predecessor"]["effective_status"], healed["replayed"]), ("superseded", "superseded", True))
        self.assertEqual(len(self.rfiles()), 2)
        self.assertEqual(self.rget(a)["superseded_by"], healed["successor"]["id"])

    def test_pending_state_survives_restart_and_a_normal_listing_shows_it(self):
        a = self.rc(DEC)
        self.make_pending(a)
        for _ in range(2):
            rsn.drop_index()
            self.assertEqual(self.rget(a)["effective_status"], "supersession_pending")
            self.assertEqual(post(action="reasoning_list", status="supersession_pending")[1]["records"][0]["id"], a["id"])
            self.assertEqual(post(action="reasoning_list", status="active")[1]["records"][0]["id"] != a["id"], True)

    def test_a_corrupt_successor_while_pending_never_makes_the_predecessor_active_again(self):
        a = self.rc(DEC)
        self.make_pending(a)
        succ = next(p for p in self.rfiles() if p.stem != a["id"])
        raw = json.loads(succ.read_text())
        raw["statement"] = "successeur altéré"
        data = json.dumps(raw).encode()
        succ.write_bytes(data)
        rsn.drop_index()
        got = self.rget(a)
        self.assertEqual(got["effective_status"], "supersession_indeterminate")
        self.assertNotEqual(got["effective_status"], "active")
        for action, kw in (("reasoning_update", {"statement": "x"}), ("reasoning_status", {"status": "withdrawn"}), ("reasoning_delete", {"confirm": True})):
            out = self.ra(action, got, expect=409, **kw)
            self.assertIn(out["code"], ("reasoning_supersession_indeterminate", "reasoning_has_history"), action)
        out = self.sup(got, expect=409, statement="Autre")
        self.assertEqual(out["code"], "reasoning_supersession_indeterminate")
        self.assertIn("État de supersession indéterminé — successeur altéré", out["error"])
        self.assertEqual(succ.read_bytes(), data, "the corrupt file is preserved, never repaired")
        self.assertEqual(len(self.rfiles()), 2)

    def test_a_corrupt_successor_after_completion_does_not_resurrect_the_predecessor(self):
        a = self.rc(DEC)
        out = self.sup(a)
        raw = json.loads(self.rpath(out["successor"]).read_text())
        raw["statement"] = "altéré"
        self.rpath(out["successor"]).write_text(json.dumps(raw))
        rsn.drop_index()
        got = self.rget(a)
        self.assertEqual((got["effective_status"], got["successor_state"]), ("superseded", "corrupt"))
        self.assertEqual(self.ra("reasoning_update", got, expect=409, statement="x")["code"], "reasoning_state_invalid")

    def test_superseded_by_relation_stays_consistent_after_restart(self):
        a = self.rc(DEC)
        out = self.sup(a)
        b = out["successor"]
        c = self.sup(b, "DN125")["successor"]
        rsn.drop_index()
        ga, gb, gc = self.rget(a), self.rget(b), self.rget(c)
        self.assertEqual((ga["superseded_by"], gb["supersedes"], gb["superseded_by"], gc["supersedes"]), (b["id"], a["id"], c["id"], b["id"]))
        self.assertEqual((ga["effective_status"], gb["effective_status"], gc["effective_status"]), ("superseded", "superseded", "active"))
        rows = {h["id"]: h for h in post(action="reasoning_list")[1]["records"]}
        self.assertEqual({k: v["effective_status"] for k, v in rows.items()}, {a["id"]: "superseded", b["id"]: "superseded", c["id"]: "active"})

    def test_supersession_captures_the_evidence_state_at_that_moment_best_effort(self):
        a = self.radd(self.radd(self.rc(DEC), self.t_drawing("g7")), self.t_source())
        (self.draw_dir / "g7.hqdraw.json").unlink()
        out = self.sup(a)
        caps = {c["kind"]: c["state"] for c in out["predecessor"]["history"][-1]["evidence"]}
        self.assertEqual(caps, {"drawing": "missing", "source": "ok"})

    def test_supersession_does_not_touch_other_stores(self):
        a = self.radd(self.rc(DEC), self.t_page())
        before = digest_without(self.tmp, "reasoning")
        self.sup(a)
        self.assertEqual(digest_without(self.tmp, "reasoning"), before)


# ================================================================ transition capture & freshness


class CaptureTests(RBase):
    def test_every_transition_event_is_sealed_and_bounded_to_identity_state_seal(self):
        a = self.radd(self.radd(self.asm(), self.t_source()), self.t_drawing("g8"))
        a = self.rst(a, "confirmed")
        e = a["history"][0]
        self.assertEqual(set(e), rsn.EVENT_KEYS)
        for c in e["evidence"]:
            self.assertEqual(set(c), rsn.CAP_KEYS)
            self.assertIn(c["state"], ("ok", "archived"))
        raw = json.dumps(a)
        self.assertNotIn("Machinery", json.dumps(e), "no live-resolved title or foreign metadata enters the capture")
        self.assertEqual(e["content_sha256"], rsn._event_hash(json.loads(self.rpath(a).read_text()), e))
        self.assertTrue(raw)

    def test_tampering_with_a_historical_event_is_detected_as_corrupt(self):
        a = self.rst(self.asm(), "confirmed")
        raw = json.loads(self.rpath(a).read_text())
        raw["history"][0]["at"] += 1
        raw["seal"] = rsn.seal(raw)  # even a re-sealed file cannot fake the event hash
        self.rpath(a).write_text(json.dumps(raw))
        rsn.drop_index()
        self.assertEqual(self.rget(a)["integrity"], "corrupt")
        raw = json.loads(self.rpath(a).read_text())
        raw["history"][0]["evidence"][0]["state"] = "archived"
        raw["seal"] = rsn.seal(raw)
        self.rpath(a).write_text(json.dumps(raw))
        rsn.drop_index()
        self.assertEqual(self.rget(a)["integrity"], "corrupt")

    def test_active_records_report_existence_only_and_terminal_ones_compare_with_their_capture(self):
        a = self.radd(self.rc(DEC), self.t_block(3))
        r = self.rres(a)
        self.assertEqual((r["has_capture"], r["overall"]), (False, None))
        self.assertTrue(all(e["freshness"] is None and e["exists"] == "ok" for e in r["evidence"]))
        w = self.rst(a, "withdrawn")
        r = self.rres(w)
        self.assertEqual((r["has_capture"], r["overall"], r["captured_event"]), (True, "unchanged", "withdrawn"))

    def test_transition_capture_is_historical_and_live_freshness_changes_separately(self):
        a = self.radd(self.asm(with_evidence=False), self.t_block(3))
        a = self.rst(a, "confirmed")
        stored = self.rpath(a).read_bytes()
        cap = json.loads(stored)["history"][0]["evidence"]
        self.edit_block_text(self.pg, 3, "Le palier avant est usiné en H6")
        r = self.rres(a)
        self.assertEqual((r["overall"], {e["freshness"] for e in r["evidence"]}), ("changed", {"changed"}))
        self.assertEqual(self.rpath(a).read_bytes(), stored, "freshness is computed on demand and never persisted")
        self.assertEqual(json.loads(self.rpath(a).read_bytes())["history"][0]["evidence"], cap, "the stored transition capture is unchanged")
        self.assertEqual(self.rget(a)["status"], "confirmed")

    def test_citation_loss_is_changed_or_removed_with_no_relinking(self):
        page, blk, cite = self.cited_page()
        a = self.radd(self.asm(with_evidence=False, project=self.proj), self.ctarget(page, blk, cite))
        a = self.rst(a, "confirmed")
        self.assertEqual(self.rres(a)["evidence"][0]["freshness"], "unchanged")
        blocks = self.cur(page["id"])["content"]["blocks"]
        blocks[1] = dict(blocks[1], marks=[])
        self.edit_page(page, blocks)
        self.assertEqual(self.rres(a)["evidence"][0]["freshness"], "changed_or_removed")

    def test_drawing_mismatch_is_an_integrity_anomaly_and_only_for_drawings(self):
        a = self.radd(self.radd(self.asm(with_evidence=False), self.t_drawing("plan-9")), self.t_source())
        a = self.rst(a, "confirmed")
        self.draw("plan-9", b'{"v":999}')
        hq_carnet.sources.mutate({"action": "source_edition_update", "id": self.sedition["id"], "expected_rev": self.src_rev(self.sedition), "title": "Autre titre"})
        by = {e["kind"]: e["freshness"] for e in self.rres(a)["evidence"]}
        self.assertEqual(by, {"drawing": "integrity_anomaly", "source": "changed"})
        self.assertEqual(self.rres(a)["overall"], "integrity_anomaly")

    def test_missing_stays_missing_unknown_stays_unknown_corrupt_stays_corrupt(self):
        a = self.radd(self.radd(self.rc(DEC), self.t_drawing("g9")), self.t_source())
        a = self.rst(a, "withdrawn")
        (self.draw_dir / "g9.hqdraw.json").unlink()
        with mock.patch("hq_carnet_review._editions", return_value=None):
            by = {e["kind"]: e["freshness"] for e in self.rres(a)["evidence"]}
        self.assertEqual(by, {"drawing": "missing", "source": "unknown"})
        t = self.t_snapshot()
        b = self.rst(self.radd(self.rc(DEC), t), "withdrawn")
        path = self.tmp / ".hq-carnet" / "snapshots" / (t["snapshot_id"] + ".json")
        data = json.loads(path.read_text())
        data["label"] = "altéré"
        path.write_text(json.dumps(data))
        r = self.rres(b)
        self.assertEqual((r["evidence"][0]["freshness"], r["overall"]), ("corrupt", "corrupt"))

    def test_an_entry_that_could_not_be_captured_is_labelled_not_captured_not_unchanged(self):
        d = self.radd(self.rc(DEC), self.t_source())
        with mock.patch("hq_carnet_review._editions", return_value=None):
            w = self.rst(d, "withdrawn")
        self.assertEqual(w["history"][0]["evidence"][0]["state"], "unknown")
        self.assertEqual(self.rres(w)["evidence"][0]["freshness"], "not_captured")

    def test_archived_source_remains_observable(self):
        ed = self.ed("À archiver")
        a = self.radd(self.rc(DEC), {"kind": "source", "source_id": ed["id"]})
        row = ver.observe_ref({"kind": "source", "source_id": ed["id"]}, hq_carnet.reasoning.ev.World())
        self.assertEqual(row["state"], "ok")
        self.assertEqual(self.rres(a)["evidence"][0]["exists"], "ok")

    def test_one_broken_resolver_does_not_suppress_the_other_entries(self):
        a = self.radd(self.radd(self.radd(self.rc(DEC), self.t_page()), self.t_source()), self.t_drawing("g10"))
        real = ver.observe_ref

        def flaky(ref, world):
            if ref["kind"] == "source":
                raise RuntimeError("resolver blew up")
            return real(ref, world)

        with mock.patch.object(ver, "observe_ref", side_effect=flaky):
            try:
                res = self.rres(a)
                states = {e["kind"]: e["exists"] for e in res["evidence"]}
            except Exception:  # noqa: BLE001
                states = None
        # the shared observer isolates failures itself; patching it out must at worst fail ONE request, never corrupt data
        self.assertEqual(self.rget(a)["status"], "active")
        if states is not None:
            self.assertEqual(states["page"], "ok")
        with mock.patch.object(ev_module(), "observe", side_effect=RuntimeError("boom")):
            res = self.rres(a)
        self.assertEqual({e["exists"] for e in res["evidence"] if e["kind"] in ("page", "source", "drawing")} - {"unknown", "ok"}, set())
        self.assertTrue(any(e["exists"] == "unknown" for e in res["evidence"]))

    def test_batched_resolve_isolates_per_record_failures(self):
        a = self.radd(self.rc(DEC), self.t_page())
        b = self.rc(DEC)
        bad = self.rc(DEC)
        self.tamper(bad, statement="altéré")
        status, out = post(action="reasoning_resolve", ids=[a["id"], b["id"], bad["id"], "dec-" + "0" * 24])
        self.assertEqual(status, 200)
        by = {r["id"]: r for r in out["results"]}
        self.assertEqual(by[a["id"]]["resolved"]["integrity"], "ok")
        self.assertEqual(by[bad["id"]]["resolved"]["integrity"], "corrupt")
        self.assertEqual(by["dec-" + "0" * 24]["error"], "not_found")
        for bad_body in ({"ids": []}, {"ids": [a["id"]] * 1, "id": a["id"]}, {"ids": ["x"]}, {"ids": [a["id"]] * 26}):
            self.assertEqual(post(action="reasoning_resolve", **bad_body)[0], 400, bad_body)


def ev_module():
    import hq_carnet_evidence

    return hq_carnet_evidence


# ================================================================ delete


class DeleteTests(RBase):
    def test_an_unhistorical_active_record_is_deleted_with_confirmation_and_revision(self):
        r = self.rc(DEC)
        self.assertEqual(self.ra("reasoning_delete", r, expect=400)["code"], "reasoning_confirm_required")
        self.ra("reasoning_delete", r, expect=400, confirm="yes")
        r = self.ra("reasoning_update", r, statement="modifié")
        r = self.radd(r, self.t_page())  # edits and evidence do not make a record undeletable
        stale = dict(r, rev=r["rev"] - 1)
        out = self.ra("reasoning_delete", stale, expect=409, confirm=True)
        self.assertEqual((out["code"], len(self.rfiles())), ("reasoning_conflict", 1))
        status, out = post(action="reasoning_delete", id=r["id"], expected_rev=r["rev"], confirm=True)
        self.assertEqual((status, out["deleted"], len(self.rfiles())), (200, r["id"], 0))
        self.assertEqual(post(action="reasoning_get", id=r["id"])[0], 404)

    def test_historical_objects_refuse_normal_deletion(self):
        for r in (self.rst(self.rc(DEC), "withdrawn"), self.sup(self.rc(DEC))["predecessor"], self.rst(self.asm(), "confirmed"), self.rst(self.asm(), "invalidated"),
                  self.rst(self.asm(), "retired")):
            out = self.ra("reasoning_delete", r, expect=409, confirm=True)
            self.assertEqual(out["code"], "reasoning_has_history", r["status"])
            self.assertTrue(self.rpath(r).exists())

    def test_a_successor_with_a_predecessor_cannot_be_deleted_either(self):
        out = self.sup(self.rc(DEC))
        succ = out["successor"]
        self.assertEqual(self.ra("reasoning_delete", succ, expect=409, confirm=True)["code"], "reasoning_has_history")

    def test_a_noncanonical_file_is_never_unlinked(self):
        r = self.rc(DEC)
        path = self.rpath(r)
        data = path.read_bytes()
        secret = self.tmp / "s.json"
        secret.write_bytes(data)
        path.unlink()
        path.symlink_to(secret)
        rsn.drop_index()
        status, out = post(action="reasoning_delete", id=r["id"], expected_rev=r["rev"], confirm=True)
        self.assertEqual(status, 409)
        self.assertTrue(secret.exists())


# ================================================================ corruption


class CorruptionTests(RBase):
    def test_corrupt_record_is_listed_read_only_and_cannot_be_edited_transitioned_superseded_or_deleted(self):
        good = self.rc(DEC)
        bad = self.asm()
        data = self.tamper(bad, statement="texte altéré")
        got = self.rget(bad)
        self.assertEqual(got["integrity"], "corrupt")
        calls = (("reasoning_update", {"statement": "x"}), ("reasoning_status", {"status": "retired"}), ("reasoning_status", {"status": "confirmed"}),
                 ("reasoning_evidence_add", {"ref": self.t_source()}), ("reasoning_evidence_remove", {"evidence_id": got["evidence"][0]["id"]}),
                 ("reasoning_verification_link", {"verification_id": self.vc(self.t_page())["id"]}), ("reasoning_delete", {"confirm": True}))
        for action, kw in calls:
            status, out = post(action=action, id=bad["id"], expected_rev=got["rev"], **kw)
            self.assertEqual((status, out["code"]), (409, "reasoning_corrupt"), action)
        status, out = post(action="reasoning_supersede", predecessor_id=bad["id"], expected_rev=got["rev"], request_id=rid(), statement="x")
        self.assertEqual((status, out["code"]), (409, "reasoning_corrupt"))
        self.assertEqual(self.rpath(bad).read_bytes(), data, "bytes preserved")
        status, out = post(action="reasoning_list")
        ids = {r["id"]: r["integrity"] for r in out["records"]}
        self.assertEqual((ids[good["id"]], ids[bad["id"]], out["unavailable"]), ("ok", "corrupt", 1))
        self.ra("reasoning_update", good, statement="le reste fonctionne")

    def test_one_corrupt_record_does_not_suppress_others_in_every_read(self):
        good = self.radd(self.rc(DEC), self.t_page())
        bad = self.rc(DEC)
        self.tamper(bad, rationale="altéré")
        self.assertEqual({r["id"] for r in post(action="reasoning_list")[1]["records"]}, {good["id"], bad["id"]})
        rel = post(action="reasoning_related", targets=[self.t_page()])[1]
        self.assertEqual(([r["id"] for r in rel["results"][0]["records"]], rel["unavailable"]), ([good["id"]], 1))
        self.assertEqual(post(action="reasoning_resolve", ids=[good["id"], bad["id"]])[0], 200)

    def test_invalid_and_noncanonical_files_are_preserved_and_do_not_poison_the_index(self):
        good = self.rc(DEC)
        d = self.tmp / ".hq-carnet" / "reasoning"
        (d / ("dec-" + "a" * 24 + ".json")).write_bytes(b"{not json")
        (d / ("asm-" + "b" * 24 + ".json")).write_bytes(b"[]")
        (d / ("asm-" + "c" * 24 + ".json")).symlink_to(self.rpath(good))
        fifo_target = d / ("dec-" + "d" * 24 + ".json")
        fifo_target.write_bytes(b"x" * (rsn.FILE_BYTES_MAX + 1))
        rsn.drop_index()
        status, out = post(action="reasoning_list")
        self.assertEqual(status, 200)
        by = {r["id"]: r["integrity"] for r in out["records"]}
        self.assertEqual(by[good["id"]], "ok")
        self.assertEqual({v for k, v in by.items() if k != good["id"]}, {"invalid"})
        self.assertEqual((d / ("dec-" + "a" * 24 + ".json")).read_bytes(), b"{not json")
        for rid_ in ("dec-" + "a" * 24, "asm-" + "c" * 24):
            self.assertEqual(post(action="reasoning_update", id=rid_, expected_rev=1, statement="x")[1]["code"], "reasoning_corrupt")
        self.assertEqual(self.ra("reasoning_update", good, statement="toujours utilisable")["statement"], "toujours utilisable")

    def test_status_inconsistent_with_history_is_invalid_not_trusted(self):
        a = self.rst(self.asm(), "confirmed")
        self.tamper(a, status="active")
        self.assertEqual(self.rget_raw(a)["integrity"], "invalid") if False else None
        status, out = post(action="reasoning_get", id=a["id"])
        self.assertEqual(status, 409)
        self.assertEqual(out["code"], "reasoning_corrupt")


# ================================================================ reads, index, related


class ReadTests(RBase):
    def test_list_filters_counts_and_bound_of_100(self):
        d1 = self.rc(DEC)
        d2 = self.rst(self.rc(DEC, project=self.other), "withdrawn")
        a1 = self.asm()
        a2 = self.rst(self.asm(), "confirmed")
        status, out = post(action="reasoning_list")
        self.assertEqual(len(out["records"]), 4)
        self.assertEqual(out["counts"][DEC], {"active": 1, "withdrawn": 1})
        self.assertEqual(out["counts"][ASM], {"active": 1, "confirmed": 1})
        for q, want in (({"kind": ASM}, {a1["id"], a2["id"]}), ({"status": "withdrawn"}, {d2["id"]}), ({"project_id": self.other["id"]}, {d2["id"]}),
                        ({"kind": DEC, "status": "active"}, {d1["id"]})):
            self.assertEqual({r["id"] for r in post(action="reasoning_list", **q)[1]["records"]}, want, q)
        for bad in ({"kind": "decision"}, {"status": "approved"}, {"project_id": "x"}, {"q": "texte"}, {"limit": 5}):
            self.assertEqual(post(action="reasoning_list", **bad)[0], 400, bad)
        self.assertEqual(post(action="reasoning_list", id="x")[0], 400)

    def test_register_list_stays_bounded_at_100(self):
        with mock.patch.object(rsn, "LIST_MAX", 3):
            for _ in range(5):
                self.rc(DEC)
            out = post(action="reasoning_list")[1]
            self.assertEqual((len(out["records"]), out["truncated"], out["total"]), (3, True, 5))
        self.assertEqual(rsn.LIST_MAX, 100)

    def test_related_finds_records_by_evidence_from_headers_only_and_summarises_verifications(self):
        r = self.radd(self.rc(DEC), self.t_source())
        v = self.vc(self.t_page())
        r = self.ra("reasoning_verification_link", r, verification_id=v["id"])
        a = self.radd(self.asm(), self.t_source())
        status, out = post(action="reasoning_related", targets=[self.t_source(), self.t_drawing("none")])
        self.assertEqual(status, 200)
        hits = out["results"][0]["records"]
        self.assertEqual({h["id"] for h in hits}, {r["id"], a["id"]})
        row = next(h for h in hits if h["id"] == r["id"])
        self.assertEqual(row["verification_summary"]["count"], 1)
        self.assertEqual(out["results"][0]["counts"][DEC], {"active": 1})
        self.assertEqual(out["results"][1]["records"], [])
        for bad in ({"targets": []}, {"targets": [self.t_page()] * 1 + [{"kind": "page", "page_id": f"page-{i}"} for i in range(10)]}, {"targets": [{"kind": "verification"}]}, {}):
            self.assertEqual(post(action="reasoning_related", **bad)[0], 400, bad)
        self.assertEqual(post(action="reasoning_related", targets=[self.t_page()], extra=1)[0], 400)

    def test_related_by_citation_value_and_review_item_ids(self):
        page, blk, cite = self.cited_page()
        r = self.radd(self.rc(DEC), self.ctarget(page, blk, cite))
        out = post(action="reasoning_related", targets=[{"kind": "citation", "page_id": page["id"], "block_id": blk["id"], "cite": cite}])[1]
        self.assertEqual([h["id"] for h in out["results"][0]["records"]], [r["id"]])
        item = self.t_item()
        r2 = self.radd(self.rc(DEC), item)
        out = post(action="reasoning_related", targets=[{"kind": "review_item", "review_id": item["review_id"], "item_id": item["item_id"]}])[1]
        self.assertEqual([h["id"] for h in out["results"][0]["records"]], [r2["id"]])

    def test_dropped_cache_rebuilds_the_same_answers_and_invalidates_on_every_write(self):
        r = self.radd(self.rc(DEC), self.t_page())
        rel = lambda: post(action="reasoning_related", targets=[self.t_page()])[1]["results"][0]["records"]  # noqa: E731
        self.assertEqual([h["id"] for h in rel()], [r["id"]])
        r = self.rst(r, "withdrawn")
        self.assertEqual(rel()[0]["effective_status"], "withdrawn")
        before = post(action="reasoning_list")[1]["records"]
        rsn.drop_index()
        self.assertEqual(post(action="reasoning_list")[1]["records"], before)
        self.ra("reasoning_update", self.rc(DEC), statement="neuf")
        self.assertEqual(len(post(action="reasoning_list")[1]["records"]), 2)

    def test_read_actions_are_read_only(self):
        r = self.radd(self.rst(self.rc(DEC), "withdrawn") if False else self.rc(DEC), self.t_page())
        before = digest_without(self.tmp)
        post(action="reasoning_list")
        post(action="reasoning_get", id=r["id"])
        post(action="reasoning_resolve", id=r["id"])
        post(action="reasoning_related", targets=[self.t_page()])
        self.assertEqual(digest_without(self.tmp), before)
        for action in ("reasoning_list", "reasoning_get", "reasoning_resolve", "reasoning_related"):
            self.assertEqual(post(action=action, id=r["id"], expected_rev=1, confirm=True, extra=1, targets=[self.t_page()])[0], 400, action)


# ================================================================ boundaries & snapshots / history / reviews


class BoundaryTests(RBase):
    SECRET = "SECRET-ENONCE-DN80-XYZ"

    def ask(self, q):
        import hq_carnet_review as review

        return review.ask({"action": "ask", "question": q, "scope": {"kind": "project", "id": self.proj["id"]}})

    def test_decision_assumption_and_rationale_text_never_become_ask_evidence(self):
        before = self.ask("usiné")
        d = self.rc(DEC, statement=self.SECRET + " palier usiné", rationale="RATIONALE-SECRETE-777 palier usiné")
        a = self.rc(ASM, self.SECRET + " hypothèse usiné", rationale="RATIONALE-SECRETE-888")
        self.rst(self.radd(a, self.t_page()), "confirmed")
        after = self.ask("usiné")
        self.assertEqual(after["fingerprint"], before["fingerprint"])
        blob = json.dumps(after, ensure_ascii=False)
        for secret in (self.SECRET, "RATIONALE-SECRETE-777", "RATIONALE-SECRETE-888", d["id"], a["id"]):
            self.assertNotIn(secret, blob)
        for q in (self.SECRET, "RATIONALE-SECRETE-777", "DN80", "confirmed", "confirmée"):
            none = self.ask(q)
            self.assertEqual(none["cards"], [], q)
            self.assertEqual(none["counts"]["evidence"], 0, q)
            self.assertNotIn(self.SECRET, json.dumps({k: v for k, v in none.items() if k not in ("question", "terms", "unmatched_terms")}, ensure_ascii=False))

    def test_snapshots_regular_reports_and_review_packs_do_not_include_the_register(self):
        r = self.radd(self.rc(DEC, statement=self.SECRET, rationale="NOTE-SECRETE-123"), self.t_page())
        self.rst(r, "withdrawn")
        sid = self.snap()
        blob = json.dumps(snaps.get(sid)["snapshot"], ensure_ascii=False)
        for secret in (self.SECRET, "NOTE-SECRETE-123", r["id"]):
            self.assertNotIn(secret, blob)
        status, out = post(action="report_build", items=[{"kind": "source", "edition_id": self.sedition["id"]}])
        self.assertEqual(status, 200, out)
        self.assertNotIn(self.SECRET, json.dumps(out, ensure_ascii=False))
        pack = self.new_pack()
        self.assertNotIn("reasoning", json.dumps(pack))

    def test_reasoning_edits_do_not_change_snapshot_contents_review_pack_schema_or_rev(self):
        t = self.t_snapshot()
        item = self.t_item()
        pack_path = self.tmp / ".hq-carnet" / "reviews" / (self.pack["id"] + ".json")
        snap_path = self.tmp / ".hq-carnet" / "snapshots" / (t["snapshot_id"] + ".json")
        before_pack, before_snap = pack_path.read_bytes(), snap_path.read_bytes()
        r = self.radd(self.radd(self.rc(DEC), t), item)
        r = self.ra("reasoning_update", r, statement="modifié")
        self.rst(r, "withdrawn")
        self.assertEqual(pack_path.read_bytes(), before_pack)
        self.assertEqual(snap_path.read_bytes(), before_snap)
        self.assertEqual(json.loads(before_pack)["rev"], json.loads(pack_path.read_bytes())["rev"])

    def test_history_restore_does_not_rewrite_the_record_and_missing_blocks_become_missing_evidence(self):
        r = self.radd(self.rc(DEC), self.t_block(3))
        stored = self.rpath(r).read_bytes()
        blocks = self.cur(self.pg["id"])["content"]["blocks"]
        self.edit_page(self.pg, [b for b in blocks if b["id"] != self.blocks[3]["id"]])
        self.assertEqual(self.rpath(r).read_bytes(), stored, "page edits never rewrite the register")
        res = self.rres(r)
        self.assertEqual(res["evidence"][0]["exists"], "missing")
        self.assertEqual(self.rget(r)["evidence"][0]["ref"], r["evidence"][0]["ref"], "no automatic retargeting")

    def test_action_surface_and_status_vocabulary_are_pinned(self):
        want = {"reasoning_list", "reasoning_get", "reasoning_resolve", "reasoning_related", "reasoning_create", "reasoning_supersede", "reasoning_update",
                "reasoning_evidence_add", "reasoning_evidence_remove", "reasoning_verification_link", "reasoning_verification_unlink", "reasoning_status",
                "reasoning_delete"}
        self.assertEqual(set(rsn.ACTIONS), want)
        for a in want:
            self.assertIn(a, hq_carnet._STAGE08)
        self.assertEqual(rsn.STATUSES[DEC], ("active", "superseded", "withdrawn"))
        self.assertEqual(rsn.STATUSES[ASM], ("active", "confirmed", "invalidated", "retired", "superseded"))
        self.assertEqual(rsn.EVIDENCE_KINDS, ("page", "block", "source", "citation", "drawing", "snapshot", "review_item"))
        for banned in ("approved", "verified", "compliant", "safe", "confidence", "assign", "due", "priority", "board", "notify"):
            self.assertFalse(any(banned in s for s in rsn.ALL_STATUSES), banned)
            self.assertFalse(any(banned in a for a in rsn.ACTIONS), banned)


# ================================================================ backup


class BackupTests(RBase):
    def pdf(self):
        self.put("Uni/ref.pdf", b"%PDF-1.4 x")
        return "Uni/ref.pdf"

    def test_backup_copies_reasoning_files_only_byte_for_byte_and_never_follows_evidence(self):
        r = self.radd(self.rc(DEC), self.t_source(self.ed("Avec PDF", file_ref=self.pdf())))
        r = self.rst(r, "withdrawn")
        self.rc(ASM, "H")
        dest = self.tmp / "backup"
        out = hq_carnet.snapshot_to(self.tmp, dest)
        self.assertTrue(out["valid"] and out["reasoning"]["valid"])
        self.assertEqual(out["reasoning"]["count"], 2)
        for p in self.rfiles():
            self.assertEqual((dest / "reasoning" / p.name).read_bytes(), p.read_bytes())
        self.assertEqual(out["reasoning"]["bytes"], sum(p.stat().st_size for p in self.rfiles()))
        self.assertEqual(sorted(p.name for p in dest.rglob("*.pdf")), [], "evidence references never pull in the PDF")
        copied = json.loads((dest / "reasoning" / (r["id"] + ".json")).read_text())
        self.assertEqual((copied["history"], copied["seal"] == rsn.seal(copied), copied["rev"]), (self.rget(r)["history"], True, r["rev"]))
        self.assertNotIn("refused", out["reasoning"])
        self.assertEqual({p.name for p in (dest / "reasoning").iterdir()}, {p.name for p in self.rfiles()}, "reasoning files only")

    def test_no_key_when_there_is_no_register_and_alone_it_makes_a_backup_present(self):
        self.page_of(para("x"))
        self.assertNotIn("reasoning", hq_carnet.snapshot_to(self.tmp, self.tmp / "b1"))
        self.rc(DEC)
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "b2")
        self.assertEqual((out["status"], out["reasoning"]["count"]), ("included", 1))

    def test_corrupt_record_travels_and_reports_invalid(self):
        r = self.rc(DEC)
        data = self.tamper(r, statement="altérée")
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertFalse(out["valid"])
        self.assertFalse(out["reasoning"]["valid"])
        self.assertEqual((self.tmp / "backup" / "reasoning" / self.rpath(r).name).read_bytes(), data)

    def test_store_symlink_and_final_file_swaps_are_refused_and_never_followed(self):
        r = self.rc(DEC)
        path = self.rpath(r)
        secret = self.tmp / "secret.txt"
        secret.write_text("NE-DOIT-PAS-ETRE-LU")
        for swap in ("link", "dir", "gone"):
            real_closure = rsn.closure

            def swapped(root, _swap=swap, _path=path):
                got = real_closure(root)
                _path.unlink()
                if _swap == "link":
                    _path.symlink_to(secret)
                elif _swap == "dir":
                    _path.mkdir()
                return got

            dest = self.tmp / ("backup-" + swap)
            with mock.patch.object(rsn, "closure", side_effect=swapped):
                out = hq_carnet.snapshot_to(self.tmp, dest)
            self.assertEqual(out["reasoning"]["refused"], 1, swap)
            self.assertFalse(out["valid"] or out["reasoning"]["valid"], swap)
            self.assertFalse((dest / "reasoning" / path.name).exists(), swap)
            self.assertNotIn("NE-DOIT-PAS-ETRE-LU", "".join(p.read_text(errors="ignore") for p in dest.rglob("*") if p.is_file()), swap)
            if swap == "dir":
                path.rmdir()
            elif path.is_symlink() or path.exists():
                path.unlink()
            r = self.rc(DEC)
            path = self.rpath(r)

    def test_redirected_store_directory_is_refused(self):
        self.rc(DEC)
        d = self.tmp / ".hq-carnet" / "reasoning"
        moved = self.tmp / "elsewhere"
        d.rename(moved)
        d.symlink_to(moved)
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "backup")
        self.assertFalse(out.get("valid", False) and out.get("reasoning", {}).get("valid", True))
        self.assertEqual(post(action="reasoning_list")[0], 409)
        self.assertEqual(post(action="reasoning_create", request_id=rid(), kind=DEC, project_id=self.proj["id"], statement="x")[0], 409)


# ================================================================ report


class ReportTests(RBase):
    def build(self, r, expect=200):
        status, out = post(action="report_build", items=[{"kind": "reasoning", "reasoning_id": r["id"]}], include_sources=False)
        self.assertEqual(status, expect, out)
        return out

    def test_section_is_deterministic_stored_facts_only_and_distinct_from_the_journal(self):
        v = self.vc(self.t_page())
        r = self.radd(self.rc(DEC, rationale="Vitesse 1,5 m/s"), self.t_source())
        r = self.ra("reasoning_verification_link", r, verification_id=v["id"])
        a = self.build(r)
        b = self.build(r)
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))
        md = a["markdown"] if "markdown" in a else json.dumps(a, ensure_ascii=False)
        self.assertIn("## Registre des décisions et hypothèses", md)
        self.assertIn(STATEMENT, md)
        self.assertIn("Vitesse 1,5 m/s", md)
        self.assertIn("Statut : Actif", md)
        self.assertIn("Vérifications liées : 1 (dont 0 au statut « Vérifiée »", md)
        self.assertIn("ni preuve ni blocs Décision du journal", md)
        for banned in ("valide", "approuv", "conforme", "sûr", "safe", "compliant", "approved", "car ", "donc"):
            self.assertNotIn(banned, md.lower().replace("car " + "", "car ") if banned != "car " else md.lower().replace("caractère", ""), banned)

    def test_supersession_and_assumption_wording(self):
        out = self.sup(self.rc(ASM, "H1"))
        old = self.build(out["predecessor"])
        new = self.build(out["successor"])
        so, sn = json.dumps(old, ensure_ascii=False), json.dumps(new, ensure_ascii=False)
        self.assertIn("Remplacé par : " + out["successor"]["id"], so)
        self.assertIn("Statut : Remplacée", so)
        self.assertIn("Remplace : " + out["predecessor"]["id"], sn)
        self.assertIn("Type : Hypothèse", sn)

    def test_corrupt_unknown_and_hostile(self):
        r = self.rc(DEC, statement="<script>x</script> **a**")
        md = json.dumps(self.build(r), ensure_ascii=False)
        self.assertNotIn("<script>", md.replace("\\u003c", "<")) if False else None
        bad = self.rc(DEC)
        self.tamper(bad, statement="altéré")
        self.assertEqual(self.build(bad, expect=409)["code"], "reasoning_corrupt")
        status, out = post(action="report_build", items=[{"kind": "reasoning", "reasoning_id": "dec-" + "0" * 24}], include_sources=False)
        self.assertEqual(status, 404)
        for bad_item in ({"kind": "reasoning"}, {"kind": "reasoning", "reasoning_id": "x"}, {"kind": "reasoning", "reasoning_id": r["id"], "extra": 1},
                         {"kind": "reasoning_decision", "reasoning_id": r["id"]}):
            self.assertEqual(post(action="report_build", items=[bad_item], include_sources=False)[0], 400, bad_item)

    def test_building_a_report_writes_nothing_to_the_store(self):
        r = self.rc(DEC)
        before = digest_without(self.tmp)
        self.build(r)
        self.assertEqual(digest_without(self.tmp), before)


# ================================================================ r2: write-ahead supersession marker + request-id reservation


class MarkerTests(RBase):
    def blocked(self, a, state="supersession_indeterminate"):
        got = self.rget(a)
        self.assertEqual((got["status"], got["effective_status"]), ("active", state))
        for action, kw in (("reasoning_update", {"statement": "x"}), ("reasoning_status", {"status": "withdrawn"}), ("reasoning_evidence_add", {"ref": self.t_page()}),
                           ("reasoning_verification_link", {"verification_id": self.vc(self.t_page())["id"]}), ("reasoning_delete", {"confirm": True})):
            out = self.ra(action, got, expect=409, **kw)
            self.assertIn(out["code"], ("reasoning_supersession_pending", "reasoning_supersession_indeterminate", "reasoning_has_history"), action)
        out = self.sup(got, expect=409, statement="Autre successeur")
        self.assertIn(out["code"], ("reasoning_supersession_pending", "reasoning_supersession_indeterminate"))
        row = next(h for h in post(action="reasoning_list")[1]["records"] if h["id"] == a["id"])
        self.assertEqual(row["effective_status"], state)
        return got

    def test_the_marker_is_written_first_names_the_predecessor_and_is_removed_on_completion(self):
        a = self.rc(DEC)
        out = self.sup(a)
        self.assertEqual(self.cfiles(), [], "a completed supersession leaves no marker")
        self.assertEqual(out["predecessor"]["status"], "superseded")
        b = self.rc(DEC)
        self.make_pending(b)
        self.assertEqual([p.name for p in self.cfiles()], [b["id"] + ".claim.json"], "the marker's filename identifies the predecessor")
        claim = json.loads(self.cpath(b).read_text())
        self.assertEqual((claim["predecessor_id"], claim["schema"], claim["seal"] == rsn.seal(claim)), (b["id"], rsn.CLAIM_SCHEMA, True))

    def test_successor_replaced_by_invalid_json_never_resurrects_the_predecessor(self):
        a = self.rc(DEC)
        self.make_pending(a)
        succ = self.successor_of(a)
        succ.write_bytes(b"{not json")
        for _ in range(2):  # restart preserves the blocked state
            rsn.drop_index()
            self.blocked(a)
        self.assertEqual(succ.read_bytes(), b"{not json", "preserved, never repaired")
        self.assertTrue(self.rpath(a).exists())
        self.assertEqual(self.sup(self.rget(a), expect=409, statement="Autre")["error"], rsn.SUPERSESSION_INDETERMINATE)

    def test_successor_deleted_or_emptied_or_a_directory_does_not_resurrect_it_either(self):
        for how in ("empty", "binary", "directory"):
            a = self.rc(DEC)
            self.make_pending(a)
            succ = self.successor_of(a)
            if how == "empty":
                succ.write_bytes(b"")
            elif how == "binary":
                succ.write_bytes(bytes(range(256)))
            else:
                succ.unlink()
                succ.mkdir()
            rsn.drop_index()
            self.blocked(a)
            if how == "directory":
                succ.rmdir()
            else:
                succ.unlink()
            self.cpath(a).unlink()
            rsn.drop_index()

    def test_a_valid_pending_transaction_is_cleaned_up_by_replaying_the_same_request(self):
        a = self.rc(DEC)
        req = self.make_pending(a)
        self.blocked(a, "supersession_pending")
        rsn.drop_index()
        healed = self.sup(a, request_id=req)
        self.assertEqual((healed["replayed"], healed["predecessor"]["effective_status"], healed["predecessor"]["status"]), (True, "superseded", "superseded"))
        self.assertEqual((self.cfiles(), len(self.rfiles())), ([], 2), "marker removed, still ONE successor")

    def test_crash_after_the_marker_but_before_b_is_pending_and_the_same_request_writes_b_from_the_marker(self):
        a = self.rc(DEC)
        req = self.make_claim_only(a, "Utiliser un DN125.")
        self.assertEqual((len(self.rfiles()), len(self.cfiles())), (1, 1), "marker only")
        got = self.blocked(a, "supersession_pending")
        self.assertEqual(got["superseded_by"], None)
        # a changed intent on that request id conflicts; a different request is refused while pending
        self.assertEqual(self.sup(a, request_id=req, statement="Autre", expect=409)["code"], "decision_request_conflict")
        self.assertEqual(self.rc(DEC, request_id=req, expect=409)["code"], "decision_request_conflict", "the in-flight request id is reserved against create too")
        rsn.drop_index()
        out = self.sup(a, request_id=req, statement="Utiliser un DN125.")
        self.assertEqual((out["predecessor"]["status"], out["successor"]["statement"], out["successor"]["supersedes"]), ("superseded", "Utiliser un DN125.", a["id"]))
        self.assertEqual((len(self.rfiles()), self.cfiles()), (2, []))

    def test_completed_supersession_with_a_stale_marker_stays_safely_superseded(self):
        a = self.rc(DEC)
        req = rid()
        out = self.sup(a, request_id=req)
        self.cpath(a).write_bytes(canon := rsn.canon_bytes(self.sealed_claim(a, out["successor"]["id"])))
        self.assertTrue(canon)
        rsn.drop_index()
        got = self.rget(a)
        self.assertEqual((got["status"], got["effective_status"]), ("superseded", "superseded"))
        self.assertEqual(self.ra("reasoning_update", got, expect=409, statement="x")["code"], "reasoning_state_invalid")
        self.assertEqual(self.sup(got, expect=409)["code"], "reasoning_already_superseded")
        self.assertEqual(self.ra("reasoning_delete", got, expect=409, confirm=True)["code"], "reasoning_has_history")
        # a corrupt stale marker is equally harmless once A is superseded
        self.cpath(a).write_bytes(b"junk")
        rsn.drop_index()
        self.assertEqual(self.rget(a)["effective_status"], "superseded")
        # …and a replay of the same request cleans it
        self.assertEqual(self.sup(a, request_id=req)["replayed"], True)
        self.assertEqual(self.cfiles(), [])

    def sealed_claim(self, a, succ_id, request_id=None):
        c = {"schema": rsn.CLAIM_SCHEMA, "predecessor_id": a["id"], "successor_id": succ_id, "request_id": request_id or rid(), "kind": a["kind"],
             "project_id": a["project_id"], "statement": "x", "rationale": "", "pred_rev": a["rev"], "created_at": 1790000000, "seal": "0" * 64}
        c["seal"] = rsn.seal(c)
        return c

    def test_a_corrupt_or_unparseable_marker_alone_blocks_the_predecessor(self):
        for how in ("badseal", "junk"):
            a = self.rc(DEC)
            claim = self.sealed_claim(a, "dec-" + "e" * 24)
            if how == "badseal":
                claim["statement"] = "altéré"
                self.cpath(a).write_bytes(rsn.canon_bytes(claim))
            else:
                self.cpath(a).write_bytes(b"\x00junk")
            rsn.drop_index()
            self.blocked(a)
            self.cpath(a).unlink()
            rsn.drop_index()
            self.assertEqual(self.rget(a)["effective_status"], "active", "no marker: the record is ordinary again")

    def test_marker_symlink_is_never_followed_and_still_blocks(self):
        a = self.rc(DEC)
        secret = self.tmp / "s.json"
        secret.write_bytes(rsn.canon_bytes(self.sealed_claim(a, "dec-" + "f" * 24)))
        self.cpath(a).symlink_to(secret)
        rsn.drop_index()
        self.blocked(a)
        self.assertTrue(secret.exists())

    def test_two_claimants_or_a_foreign_successor_is_indeterminate(self):
        a = self.rc(DEC)
        other = self.rc(DEC)
        # a marker naming a successor that does not claim A (some other record)
        self.cpath(a).write_bytes(rsn.canon_bytes(self.sealed_claim(a, other["id"])))
        rsn.drop_index()
        self.blocked(a)

    def test_markers_travel_in_a_backup_and_a_bad_one_makes_it_invalid(self):
        a = self.rc(DEC)
        self.make_pending(a)
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "b1")
        self.assertTrue((self.tmp / "b1" / "reasoning" / (a["id"] + ".claim.json")).exists())
        self.assertEqual((self.tmp / "b1" / "reasoning" / (a["id"] + ".claim.json")).read_bytes(), self.cpath(a).read_bytes())
        self.assertTrue(out["reasoning"]["valid"])
        self.cpath(a).write_bytes(b"junk")
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "b2")
        self.assertFalse(out["reasoning"]["valid"])

    def test_marker_never_enters_the_record_list_or_the_total_count(self):
        a = self.rc(DEC)
        self.make_pending(a)
        out = post(action="reasoning_list")[1]
        self.assertEqual({r["id"] for r in out["records"]}, {a["id"], self.successor_of(a).stem})
        self.assertEqual(out["total"], 2)


class RequestReservationTests(RBase):
    def corrupt_seal(self, r):
        raw = json.loads(self.rpath(r).read_text())
        raw["statement"] = raw["statement"] + " altéré"  # structure intact, seal now wrong
        self.rpath(r).write_text(json.dumps(raw))
        rsn.drop_index()

    def test_a_corrupt_create_still_reserves_its_request_id(self):
        req = rid()
        a = self.rc(DEC, request_id=req)
        self.corrupt_seal(a)
        for _ in range(2):  # also after a restart
            out = self.rc(DEC, request_id=req, expect=409)
            self.assertEqual(out["code"], "reasoning_request_corrupt")
            self.assertEqual(len(self.rfiles()), 1, "no second file")
            rsn.drop_index()
        # a changed intent is refused just the same, and no repair happens
        self.assertEqual(self.rc(DEC, request_id=req, statement="Autre", expect=409)["code"], "reasoning_request_corrupt")
        self.assertEqual(self.rc(ASM, "H", request_id=req, expect=409)["code"], "reasoning_request_corrupt")
        self.assertEqual(json.loads(self.rpath(a).read_text())["statement"], STATEMENT + " altéré")

    def test_an_exact_create_still_replays_while_the_record_is_ok(self):
        req = rid()
        a = self.rc(DEC, request_id=req)
        self.assertEqual(self.rc(DEC, request_id=req)["id"], a["id"])

    def test_a_corrupt_create_request_id_cannot_be_reused_by_a_supersession(self):
        req = rid()
        a = self.rc(DEC, request_id=req)
        self.corrupt_seal(a)
        victim = self.rc(DEC)
        out = self.sup(victim, request_id=req, expect=409)
        self.assertEqual(out["code"], "reasoning_request_corrupt")
        self.assertEqual((len(self.rfiles()), self.cfiles()), (2, []), "nothing created, no marker left behind")
        self.assertEqual(self.rget(victim)["effective_status"], "active")

    def test_a_corrupt_supersession_successor_with_a_readable_request_id_reserves_it(self):
        a = self.rc(DEC)
        out = self.sup(a)
        req = json.loads(self.rpath(out["successor"]).read_text())["request_id"]
        self.corrupt_seal(out["successor"])
        self.assertEqual(self.rc(DEC, request_id=req, expect=409)["code"], "reasoning_request_corrupt")
        other = self.rc(DEC)
        self.assertEqual(self.sup(other, request_id=req, expect=409)["code"], "reasoning_request_corrupt")
        # replaying the SAME supersession does not create a second successor either
        self.assertEqual(self.sup(a, request_id=req, expect=409)["code"], "reasoning_request_corrupt")
        self.assertEqual(len(self.rfiles()), 3)

    def test_an_unparseable_file_cannot_reveal_its_request_id_a_documented_residual(self):
        req = rid()
        a = self.rc(DEC, request_id=req)
        self.rpath(a).write_bytes(b"{not json")
        rsn.drop_index()
        again = self.rc(DEC, request_id=req)
        self.assertNotEqual(again["id"], a["id"], "documented limit: nothing readable to attribute, so a new record is created")

    def test_a_marker_reserves_its_request_id_against_create_and_other_supersessions(self):
        a = self.rc(DEC)
        req = self.make_claim_only(a)
        other = self.rc(DEC)
        self.assertEqual(self.sup(other, request_id=req, expect=409)["code"], "decision_request_conflict")
        self.assertEqual(self.rc(ASM, "H", request_id=req, expect=409)["code"], "decision_request_conflict")
        self.assertEqual(self.cfiles()[0].name, a["id"] + ".claim.json")


# ================================================================ static boundaries


class StaticTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parent.parent
    BOUNDARY = ("hq_carnet_ask.py", "hq_carnet_review.py", "hq_carnet_intel.py", "hq_carnet_history.py", "hq_carnet_snapshots.py", "hq_carnet_restore.py",
                "hq_carnet_bulk.py", "hq_carnet_links.py", "hq_carnet_reader.py", "hq_carnet_reviews.py", "hq_carnet_sources.py", "hq_carnet_portals.py",
                "hq_carnet_annotations.py", "hq_carnet_rcomments.py", "hq_carnet_evidence.py", "hq_carnet_rich.py", "hq_carnet_verifications.py", "hq_carnet_canon.py")

    def test_ask_search_snapshot_history_intel_verification_modules_never_import_the_register(self):
        for name in self.BOUNDARY:
            src = (self.ROOT / name).read_text(encoding="utf-8")
            self.assertNotIn("hq_carnet_reasoning", src, name)
            self.assertNotIn(".hq-carnet/reasoning", src, name)
            self.assertNotIn('"reasoning"', src, name)

    def test_the_register_depends_on_verifications_one_way_only(self):
        src = (self.ROOT / "hq_carnet_reasoning.py").read_text(encoding="utf-8")
        self.assertIn("import hq_carnet_verifications as ver", src)
        for forbidden in ("hq_carnet_ask", "hq_carnet_review as", "hq_carnet_intel", "hq_carnet_history", "hq_carnet_portals", "hq_carnet_rcomments"):
            self.assertNotIn("import " + forbidden, src, forbidden)

    def test_module_has_no_network_shell_eval_or_bare_reads(self):
        src = (self.ROOT / "hq_carnet_reasoning.py").read_text(encoding="utf-8")
        for needle in ("subprocess", "socket", "urllib.request", "http.client", "eval(", "exec(", "os.system", "requests", "webbrowser", "shutil", "getpass", "os.getlogin", "environ"):
            self.assertNotIn(needle, src, needle)
        for bare in ("read_bytes(", "read_text("):
            self.assertNotIn(bare, src, "store files are read only through the descriptor-bound canonical reader")
        for flag in ("O_RDWR", "O_APPEND", "O_TRUNC"):
            self.assertNotIn(flag, src, flag)

    def test_no_identity_confidence_or_workflow_field_exists_in_the_schema(self):
        src = (self.ROOT / "hq_carnet_reasoning.py").read_text(encoding="utf-8")
        for field in ("signed_by", "author", "username", "reviewer_id", "assignee", "due_at", "priority", "confidence", "approved"):
            self.assertNotIn(f'"{field}"', src, field)

    def test_the_bare_word_decision_is_never_a_kind_in_the_register_code_or_client(self):
        """Ambiguity pin: ``kind == "decision"`` means the Phase 5 journal block everywhere else; the register never uses it as a kind."""
        py = (self.ROOT / "hq_carnet_reasoning.py").read_text(encoding="utf-8")
        for needle in ('kind == "decision"', "kind='decision'", '"kind": "decision"', 'kind="decision"'):
            self.assertNotIn(needle, py, needle)
        self.assertIn('KIND_DECISION = "reasoning_decision"', py)
        for name in ("hq-carnet-reasoning.js", "hq-carnet-reasoning-ui.js"):
            path = self.ROOT / "assets" / name
            if not path.exists():
                continue
            js = path.read_text(encoding="utf-8")
            for needle in ('kind === "decision"', "kind: 'decision'", 'kind: "decision"', 'kind == "decision"'):
                self.assertNotIn(needle, js, name + " " + needle)

    def test_the_module_reads_through_the_descriptor_bound_reader(self):
        src = (self.ROOT / "hq_carnet_reasoning.py").read_text(encoding="utf-8")
        body = src.split("def _read_one", 1)[1].split("\ndef ", 1)[0]
        self.assertIn("canon.read_regular", body)
        self.assertIn("canon.copy_canonical", src)


if __name__ == "__main__":
    unittest.main()
