"""Carnet Phase 8 — portal blocks & the read-only resolver.

A portal block stores ONLY ``{ref:{kind,id}, view}``. These tests pin: the closed schema, the read-only/batched/deduplicated/isolated
resolver, explicit states (unknown != missing), live-vs-frozen semantics, history/restore, snapshot closure honesty, report, Ask
(stored identity only), review-pack two-layer observation, backup (no recursive closure) and the security properties.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_ask as ask  # noqa: E402
import hq_carnet_evidence as evidence  # noqa: E402
import hq_carnet_intel as intel  # noqa: E402
import hq_carnet_portals as portals  # noqa: E402
import hq_carnet_report as report  # noqa: E402
import hq_carnet_reviews as reviews  # noqa: E402
import hq_carnet_rich as rich  # noqa: E402
import hq_carnet_snapshots as snaps  # noqa: E402
import hq_carnet_sources as sources  # noqa: E402
from test_hq_carnet_history import para  # noqa: E402
from test_hq_carnet_reviews import RBase, post, rid, tree_digest  # noqa: E402

ZERO24 = "0" * 24


def portal(kind, ident, view="card", bid=None):
    block = {"type": "portal", "text": "", "marks": [], "portal": {"ref": {"kind": kind, "id": ident}, "view": view}}
    if bid:
        block["id"] = bid
    return block


def resolve(*refs, **extra):
    status, out = hq_carnet.http_post({"action": "portal_resolve", "refs": [dict(r) for r in refs], **extra})
    return status, out


def one(kind, ident, **extra):
    status, out = resolve({"kind": kind, "id": ident}, **extra)
    assert status == 200, out
    return out["results"][0]


class PBase(RBase):
    def put(self, path_rel: str, data: bytes = b"x") -> Path:
        p = self.tmp / path_rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p

    def page_of(self, *blocks):
        return self.proj_page([para("intro"), *blocks])

    def ed(self, title="ASME B31.3", **extra):
        return self.edition(self.family("Fam-" + rid()[:6]), "1e", title=title, **extra)

    def src_rev(self, ed):
        return next(e for e in hq_carnet.http_get({"sources": ["1"]})[1]["editions"] if e["id"] == ed["id"])["rev"]


# ================================================================ schema


class SchemaTests(PBase):
    def test_every_kind_is_accepted_and_stored_exactly(self):
        refs = [("source", "srce-abc"), ("file", "Inbox/Docs/a.pdf"), ("model", "Inbox/Models/a.glb"), ("media", "Inbox/Photos/a.png"), ("snapshot", "snap-" + ZERO24), ("review", "rvw-" + ZERO24)]
        page = self.page_of(*[portal(k, i, "compact" if n % 2 else "card") for n, (k, i) in enumerate(refs)])
        blocks = self.cur(page["id"])["content"]["blocks"][1:]
        self.assertEqual([b["portal"]["ref"] for b in blocks], [{"kind": k, "id": i} for k, i in refs])
        for b in blocks:
            self.assertEqual(set(b), {"id", "type", "text", "marks", "portal"})
            self.assertEqual(set(b["portal"]), {"ref", "view"})
            self.assertEqual((b["text"], b["marks"]), ("", []))
        self.assertTrue(rich.valid_v2(self.cur(page["id"])["content"]))

    def test_closed_kind_set_and_no_ref_kinds_extension(self):
        self.assertEqual(rich.PORTAL_KINDS, ("source", "file", "model", "media", "snapshot", "review"))
        self.assertEqual(rich.REF_KINDS, ("note", "file", "drawing", "model", "media", "project"))  # link marks are a different contract
        for kind in ("drawing", "note", "project", "url", "web", "dashboard", "task"):
            with self.assertRaises(rich.ContentError, msg=kind):
                rich.check_portal({"ref": {"kind": kind, "id": "x"}, "view": "card"})

    def test_hostile_and_malformed_payloads_are_refused(self):
        good = {"ref": {"kind": "source", "id": "srce-abc"}, "view": "card"}
        bad = [
            {**good, "extra": 1}, {"ref": good["ref"]}, {"view": "card"}, {**good, "view": "big"}, {**good, "view": "compact ", },
            {"ref": {"kind": "source", "id": "srce-abc", "title": "x"}, "view": "card"},
            {"ref": {"kind": "source", "id": "x"}, "view": "card"}, {"ref": {"kind": "source", "id": 7}, "view": "card"},
            {"ref": {"kind": "file", "id": "/etc/passwd"}, "view": "card"}, {"ref": {"kind": "file", "id": "Inbox/../x.pdf"}, "view": "card"},
            {"ref": {"kind": "file", "id": "C:\\x\\y.pdf"}, "view": "card"}, {"ref": {"kind": "file", "id": "https://evil.example/a.pdf"}, "view": "card"},
            {"ref": {"kind": "file", "id": "Inbox/a%2e%2e/x"}, "view": "card"}, {"ref": {"kind": "file", "id": "Inbox/.hidden/x.pdf"}, "view": "card"},
            {"ref": {"kind": "model", "id": "Inbox/Models/a.txt"}, "view": "card"}, {"ref": {"kind": "media", "id": "Inbox/Photos/a.exe"}, "view": "card"},
            {"ref": {"kind": "snapshot", "id": "snap-xyz"}, "view": "card"}, {"ref": {"kind": "review", "id": "rvw-12"}, "view": "card"},
            {"ref": {"kind": "snapshot", "id": "snap-" + ZERO24 + "\n"}, "view": "card"},
            {"ref": good["ref"], "view": {"w": 100}}, {"ref": good["ref"], "view": "card", "portal": good}, "<script>", None, [], "srce-abc",
            {"ref": {"kind": "source", "id": "srce-abc", "ref": {"kind": "source", "id": "srce-abc"}}, "view": "card"},  # no nesting
        ]
        for payload in bad:
            with self.assertRaises(rich.ContentError, msg=repr(payload)):
                rich.check_portal(payload)

    def test_block_envelope_is_strict_on_save_and_on_stored_validation(self):
        page = self.make_page([para("a")])

        def save(block):
            return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "content": {"version": 2, "blocks": [block]}})

        save(portal("source", "srce-abc"))
        for bad in ({**portal("source", "srce-abc"), "text": "hi"}, {**portal("source", "srce-abc"), "marks": [{"type": "bold", "start": 0, "end": 0}]},
                    {**portal("source", "srce-abc"), "asset": {}}, {**portal("source", "srce-abc"), "drawing": {"id": "x"}}, {**portal("source", "srce-abc"), "checked": False},
                    {"type": "portal", "text": "", "marks": []}):
            with self.assertRaises(hq_carnet.CarnetError, msg=repr(bad)):
                save(bad)
        # a stored page with an extra field is malformed to valid_v2 (never silently accepted)
        content = {"version": 2, "blocks": [{"id": "block-a", "type": "portal", "text": "", "marks": [], "portal": {"ref": {"kind": "source", "id": "srce-abc"}, "view": "card", "cache": "x"}}]}
        self.assertFalse(rich.valid_v2(content))

    def test_portals_per_page_limit(self):
        page = self.make_page([para("a")])
        ok = [portal("file", f"Inbox/Docs/f{n}.pdf") for n in range(rich.PORTALS_PER_PAGE_MAX)]
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": ok}})
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "content": {"version": 2, "blocks": ok + [portal("file", "Inbox/Docs/more.pdf")]}})
        self.assertEqual(rich.PORTALS_PER_PAGE_MAX, 100)

    def test_owner_id_patterns_are_mirrored_exactly(self):
        self.assertEqual(rich._SNAPSHOT_ID_RE.pattern, snaps.ID_RE.pattern)
        self.assertEqual(rich._REVIEW_ID_RE.pattern, reviews.ID_RE.pattern)
        self.assertEqual(rich._EDITION_ID_RE.pattern, sources._ID_RE["srce"].pattern)

    def test_portal_text_is_never_part_of_page_budget_or_flat_search(self):
        page = self.page_of(portal("file", "Inbox/Docs/" + "x" * 80 + ".pdf"))
        content = self.cur(page["id"])["content"]
        self.assertEqual(rich.structured_strings(content["blocks"][1]), [])
        self.assertNotIn("Inbox", rich.search_text(content))
        self.assertEqual(rich.portals_of(content), [{"kind": "file", "id": "Inbox/Docs/" + "x" * 80 + ".pdf"}])

    def test_stored_block_has_no_resolved_data_after_resolution_and_refresh(self):
        ed = self.ed()
        page = self.page_of(portal("source", ed["id"]))
        before = json.dumps(self.cur(page["id"]), sort_keys=True)
        self.assertEqual(one("source", ed["id"])["title"], "ASME B31.3")
        one("source", ed["id"])
        self.assertEqual(json.dumps(self.cur(page["id"]), sort_keys=True), before)  # refresh never modifies the block or bumps the page


# ================================================================ resolver contract


class ResolverContractTests(PBase):
    def test_request_schema_is_exact_and_bounded(self):
        r = {"kind": "file", "id": "Inbox/Docs/a.pdf"}
        for bad in ({"refs": []}, {"refs": [r] * 101}, {"refs": "x"}, {"refs": [{"kind": "file"}]}, {"refs": [{**r, "extra": 1}]},
                    {"refs": [{"kind": "note", "id": "page-x"}]}, {"refs": [{"kind": "project", "id": "proj-x"}]}, {"refs": [{"kind": "file", "id": "../x"}]},
                    {"refs": [r], "detail": "yes"}, {"refs": [r, r], "detail": True}, {"refs": [r], "bogus": 1},
                    {"refs": [{**r, "expect_sha256": "0" * 64}]}, {"refs": [{"kind": "drawing", "id": "a", "expect_sha256": "zz"}]}):
            status, out = hq_carnet.http_post({"action": "portal_resolve", **bad})
            self.assertEqual((status, out["code"]), (400, "validation_error"), bad)
        self.assertEqual(hq_carnet.http_post({"action": "portal_resolve"})[0], 400)
        self.assertEqual(resolve(*[{"kind": "file", "id": f"Inbox/Docs/f{n}.pdf"} for n in range(100)])[0], 200)

    def test_it_is_read_only_by_contract_and_in_effect(self):
        ed = self.ed()
        self.put("Inbox/Docs/a.pdf")
        pk = self.new()
        sid = self.page_with() and self.snap()
        refs = [{"kind": "source", "id": ed["id"]}, {"kind": "file", "id": "Inbox/Docs/a.pdf"}, {"kind": "snapshot", "id": sid}, {"kind": "review", "id": pk["id"]}]
        before = tree_digest(self.tmp)
        status, out = resolve(*refs)
        self.assertEqual(status, 200)
        self.assertIs(out["read_only"], True)
        self.assertEqual(tree_digest(self.tmp), before, "nothing in the Carnet root changed")
        self.assertEqual(reviews.get(pk["id"])["review"]["rev"], pk["rev"])

    def test_results_follow_request_order_and_duplicates_are_resolved_once(self):
        self.put("Inbox/Docs/a.pdf")
        self.put("Inbox/Docs/b.pdf")
        refs = [{"kind": "file", "id": "Inbox/Docs/a.pdf"}, {"kind": "file", "id": "Inbox/Docs/b.pdf"}] * 50
        with mock.patch.object(portals, "_file_like", wraps=portals._file_like) as spy:
            status, out = resolve(*refs)
        self.assertEqual(status, 200)
        self.assertEqual(len(out["results"]), 100)
        self.assertEqual(spy.call_count, 2, "100 requested refs, 2 distinct: only 2 lookups")
        self.assertEqual(out["resolved"], 2)
        self.assertEqual([r["ref"]["id"] for r in out["results"]], ["Inbox/Docs/a.pdf", "Inbox/Docs/b.pdf"] * 50)

    def test_one_failing_resolution_does_not_suppress_the_other_99(self):
        for n in range(100):
            self.put(f"Inbox/Docs/f{n}.pdf")
        real = portals._file_like

        def flaky(ref, root):
            if ref["id"].endswith("f42.pdf"):
                raise RuntimeError("boom")
            return real(ref, root)

        with mock.patch.object(portals, "_file_like", flaky):
            status, out = resolve(*[{"kind": "file", "id": f"Inbox/Docs/f{n}.pdf"} for n in range(100)])
        self.assertEqual(status, 200)
        states = [r["state"] for r in out["results"]]
        self.assertEqual(states.count("available"), 99)
        self.assertEqual(out["results"][42]["state"], "unknown")
        self.assertNotIn("boom", json.dumps(out["results"][42]))  # no internals leak

    def test_titles_and_values_are_bounded_text(self):
        long = self.ed(identifier="Z" * 60, title="T" * 200)
        row = one("source", long["id"])
        self.assertTrue(all(len(m["value"]) <= portals.VALUE_MAX for m in row["metadata"] if m["type"] == "text"))
        self.assertLessEqual(len(row["title"]), portals.TITLE_MAX)

    def test_a_hundred_portals_are_one_request_not_a_hundred(self):
        refs = [{"kind": "file", "id": f"Inbox/Docs/f{n}.pdf"} for n in range(100)]
        counting = mock.Mock(wraps=portals.resolve)
        with mock.patch.dict(hq_carnet._STAGE08, {"portal_resolve": counting}):
            status, out = hq_carnet.http_post({"action": "portal_resolve", "refs": refs})
        self.assertEqual((status, counting.call_count, len(out["results"])), (200, 1, 100))


# ================================================================ per kind


class SourceTests(PBase):
    def test_metadata_changes_refresh_the_portal_but_not_the_page(self):
        ed = self.ed()
        page = self.page_of(portal("source", ed["id"]))
        rev = self.cur(page["id"])["rev"]
        blob = json.dumps(self.cur(page["id"])["content"], sort_keys=True)
        a = one("source", ed["id"])
        self.assertEqual((a["state"], a["state_label"], a["title"]), ("available", "Disponible", "ASME B31.3"))
        sources.mutate({"action": "source_edition_update", "id": ed["id"], "expected_rev": self.src_rev(ed), "title": "ASME B31.3 (2024)"})
        b = one("source", ed["id"])
        self.assertEqual(b["title"], "ASME B31.3 (2024)")
        self.assertEqual((self.cur(page["id"])["rev"], json.dumps(self.cur(page["id"])["content"], sort_keys=True)), (rev, blob))

    def test_archived_and_missing_and_unknown_are_three_different_states(self):
        ed = self.ed()
        sources.mutate({"action": "source_edition_archive", "id": ed["id"], "expected_rev": self.src_rev(ed), "archived": True})
        arch = one("source", ed["id"])
        self.assertEqual((arch["state"], arch["state_label"]), ("archived", "Archivée"))
        gone = one("source", "srce-gone")
        self.assertEqual((gone["state"], gone["state_label"], gone["actions"]), ("missing", "Introuvable", []))
        with mock.patch("hq_carnet_review._editions", return_value=None):
            unk = one("source", ed["id"])
        self.assertEqual((unk["state"], unk["state_label"]), ("unknown", "État inconnu"))
        self.assertNotEqual(unk["state"], gone["state"])

    def test_source_pdf_line_under_a_redirected_parent_is_unknown_not_introuvable(self):
        import tempfile

        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        (self.tmp / "Uni").mkdir(exist_ok=True)
        (self.tmp / "Uni" / "Redir").symlink_to(outside, target_is_directory=True)
        for ref, want in (("Uni/Redir/missing.pdf", "État inconnu"), ("Uni/Plain/missing.pdf", "Introuvable")):
            ed = {"id": "srce-x", "title": "T", "file_ref": ref}
            with mock.patch.object(portals, "_sources_by_id", return_value={"srce-x": ed}):
                row = one("source", "srce-x")
            self.assertIn({"label": "Fichier PDF", "value": want, "type": "text"}, row["metadata"], ref)

    def test_source_removed_from_the_store_leaves_the_block_and_says_missing(self):
        ed = self.ed()
        page = self.page_of(portal("source", ed["id"]))
        path = sources.confined_path()
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        data["editions"] = [e for e in data["editions"] if e["id"] != ed["id"]]
        Path(path).write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(one("source", ed["id"])["state"], "missing")
        self.assertEqual(self.cur(page["id"])["content"]["blocks"][1]["portal"]["ref"]["id"], ed["id"])  # the block stays


class FileLikeTests(PBase):
    def test_file_model_media_metadata_only_and_existence_states(self):
        self.put("Inbox/Docs/spec.pdf", b"%PDF-secret-content")
        self.put("Inbox/Models/part.glb", b"glTF")
        self.put("Inbox/Photos/p.png", b"\x89PNG")
        self.put("Inbox/Photos/v.mp4", b"mp4")
        f = one("file", "Inbox/Docs/spec.pdf")
        self.assertEqual((f["state"], f["title"], f["kind_label"]), ("available", "spec.pdf", "Fichier"))
        self.assertIn({"label": "Taille", "value": len(b"%PDF-secret-content"), "type": "bytes"}, f["metadata"])
        self.assertNotIn("secret", json.dumps(f), "file contents are never read into the portal")
        self.assertEqual(one("model", "Inbox/Models/part.glb")["kind_label"], "Modèle")
        img, vid = one("media", "Inbox/Photos/p.png"), one("media", "Inbox/Photos/v.mp4")
        self.assertEqual(img["thumb_url"], "/files/Inbox/Photos/p.png")
        self.assertIsNone(vid["thumb_url"])  # video/audio/unsupported: a metadata card
        self.assertEqual(vid["open_url"], "/files/Inbox/Photos/v.mp4")

    def test_deleted_target_is_missing_and_the_page_stays_editable(self):
        p = self.put("Inbox/Docs/a.pdf")
        page = self.page_of(portal("file", "Inbox/Docs/a.pdf"))
        p.unlink()
        row = one("file", "Inbox/Docs/a.pdf")
        self.assertEqual((row["state"], row["actions"]), ("missing", []))
        saved = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "content": {"version": 2, "blocks": copy.deepcopy(self.cur(page["id"])["content"]["blocks"]) + [para("encore")]}})["page"]
        self.assertEqual(saved["content"]["blocks"][1]["portal"]["ref"]["id"], "Inbox/Docs/a.pdf")

    def test_non_canonical_targets_are_unknown_never_missing_and_never_followed(self):
        """r2: absent -> missing; symlink / directory / redirected parent (inside or outside the root) -> unknown (non-canonical)."""
        import tempfile

        real = self.put("Inbox/Docs/real.pdf")
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / "secret.pdf").write_bytes(b"OUTSIDE-SECRET")
        docs = self.tmp / "Inbox" / "Docs"
        (docs / "link.pdf").symlink_to(real)
        (docs / "escape.pdf").symlink_to(outside / "secret.pdf")
        (docs / "dir.pdf").mkdir()
        (self.tmp / "Inbox" / "Redir").symlink_to(outside, target_is_directory=True)  # parent redirected OUTSIDE the root
        (self.tmp / "Inbox" / "Inner").symlink_to(docs, target_is_directory=True)  # parent redirected INSIDE the root
        (self.tmp / "Inbox" / "Broken").symlink_to(outside / "does-not-exist", target_is_directory=True)  # broken parent symlink
        (self.tmp / "Inbox" / "AFile").write_bytes(b"not a dir")  # a file where a directory is expected
        opened = []
        real_open = open

        def spy(file, *a, **k):
            opened.append(str(file))
            return real_open(file, *a, **k)

        with mock.patch("builtins.open", spy):
            rows = {n: one("file", "Inbox/" + n) for n in ("Docs/link.pdf", "Docs/escape.pdf", "Docs/dir.pdf", "Redir/secret.pdf", "Inner/real.pdf", "Docs/gone.pdf", "Nope/gone.pdf", "Docs/real.pdf", "Redir/missing.pdf", "Inner/missing.pdf", "Broken/missing.pdf", "AFile/missing.pdf", "Redir/sub/deeper/missing.pdf")}
        for n in ("Docs/link.pdf", "Docs/escape.pdf", "Docs/dir.pdf", "Redir/secret.pdf", "Inner/real.pdf", "Redir/missing.pdf", "Inner/missing.pdf", "Broken/missing.pdf", "AFile/missing.pdf", "Redir/sub/deeper/missing.pdf"):
            self.assertEqual((rows[n]["state"], rows[n]["state_label"], rows[n]["actions"]), ("unknown", "État inconnu", []), n)
            self.assertNotIn("OUTSIDE", json.dumps(rows[n]))
        for n in ("Redir/missing.pdf", "Inner/missing.pdf", "Broken/missing.pdf", "AFile/missing.pdf", "Redir/sub/deeper/missing.pdf"):
            self.assertNotEqual(rows[n]["state"], "missing", "a missing leaf under a non-canonical parent is not genuine absence: " + n)
        self.assertEqual(rows["Docs/gone.pdf"]["state"], "missing")  # genuine absence
        self.assertEqual(rows["Nope/gone.pdf"]["state"], "missing")  # missing parent is genuine absence too
        self.assertEqual(rows["Docs/real.pdf"]["state"], "available")
        self.assertFalse([o for o in opened if "secret" in o or str(outside) in o], "the redirected target is never opened")

    def test_lookup_failure_is_unknown_not_missing(self):
        self.put("Inbox/Docs/a.pdf")
        with mock.patch.object(portals, "_plain_regular", side_effect=PermissionError("denied")):
            row = one("file", "Inbox/Docs/a.pdf")
        self.assertEqual((row["state"], row["state_label"]), ("unknown", "État inconnu"))

    def test_hostile_file_name_is_data_in_json_never_markup_on_the_wire(self):
        name = "Inbox/Docs/<img src=x onerror=alert(1)>.pdf"
        self.put(name)
        row = one("file", name)
        self.assertEqual(row["title"], "<img src=x onerror=alert(1)>.pdf")  # a plain string: the UI renders text nodes only
        self.assertIn("%3Cimg", row["open_url"])


class SnapshotAndReviewTests(PBase):
    def test_snapshot_valid_then_altered_is_not_trusted(self):
        self.page_with()
        sid = self.snap()
        ok = one("snapshot", sid)
        self.assertEqual((ok["state"], ok["state_label"], ok["integrity"]), ("available", "Valide", "ok"))
        self.assertIn("Pages", [m["label"] for m in ok["metadata"]])
        path = self.tmp / ".hq-carnet" / "snapshots" / (sid + ".json")
        raw = json.loads(path.read_text())
        raw["label"] = "falsifié"
        path.write_text(json.dumps(raw))
        bad = one("snapshot", sid)
        self.assertEqual((bad["state"], bad["state_label"], bad["integrity"]), ("corrupt", "Altéré", "corrupt"))
        self.assertNotIn("Pages", [m["label"] for m in bad["metadata"]])  # no summary of an untrusted record
        self.assertNotIn("falsifié", json.dumps(bad))

    def test_snapshot_missing_invalid_and_unreadable_are_distinct(self):
        self.page_with()
        sid = self.snap()
        self.assertEqual(one("snapshot", "snap-" + ZERO24)["state"], "missing")
        path = self.tmp / ".hq-carnet" / "snapshots" / (sid + ".json")
        path.write_text("{not json")
        inv = one("snapshot", sid)
        self.assertEqual((inv["state"], inv["state_label"], inv["integrity"]), ("corrupt", "Invalide", "invalid"))
        with mock.patch.object(snaps, "get", side_effect=snaps.SnapshotStorageError("Jalon illisible")):
            unk = one("snapshot", sid)
        self.assertEqual((unk["state"], unk["state_label"]), ("unknown", "État inconnu"))

    def test_review_status_change_shows_up_and_the_page_does_not_move(self):
        pk = self.new()
        page = self.page_of(portal("review", pk["id"]))
        rev = self.cur(page["id"])["rev"]
        self.assertEqual(one("review", pk["id"])["subtitle"], "Brouillon")
        out = self.act("review_update", pk, status="in_review")
        row = one("review", pk["id"])
        self.assertEqual((row["subtitle"], row["state"]), ("En revue", "available"))
        self.assertIn({"label": "Révision", "value": str(out["review"]["rev"]), "type": "text"}, row["metadata"])
        self.assertEqual(self.cur(page["id"])["rev"], rev)

    def test_review_missing_corrupt_invalid(self):
        self.assertEqual(one("review", "rvw-" + ZERO24)["state"], "missing")
        pk = self.new()
        path = self.review_files()[0]
        raw = json.loads(path.read_text())
        raw["note"] = "altéré"
        path.write_text(json.dumps(raw))
        c = one("review", pk["id"])
        self.assertEqual((c["state"], c["state_label"]), ("corrupt", "Altéré"))
        self.assertNotIn("altéré", json.dumps(c))  # the pack's contents are not presented
        path.write_text("{broken")
        i = one("review", pk["id"])
        self.assertEqual((i["state"], i["state_label"]), ("corrupt", "Invalide"))

    def test_review_inspection_adds_a_live_freshness_summary_and_still_writes_nothing(self):
        page = self.page_with()
        pk = self.add(self.new(), {"kind": "page", "page_id": page["id"]})
        before = tree_digest(self.tmp / ".hq-carnet" / "reviews")
        row = one("review", pk["id"], detail=True)
        self.assertEqual(row["freshness"], {"unchanged": 1, "changed": 0, "missing": 0, "unknown": 0})
        self.assertNotIn("freshness", one("review", pk["id"]))  # batch rows never pay for it
        self.assertEqual(tree_digest(self.tmp / ".hq-carnet" / "reviews"), before)


class DrawingResolverTests(PBase):
    def test_drawing_is_understood_by_the_resolver_but_is_not_a_portal_kind(self):
        self.draw("pump-a")
        a = one("drawing", "pump-a")
        self.assertEqual((a["state"], a["state_label"], a["kind_label"]), ("available", "Disponible", "Croquis"))
        self.assertEqual(one("drawing", "pump-gone")["state"], "missing")
        with self.assertRaises(rich.ContentError):
            rich.check_portal({"ref": {"kind": "drawing", "id": "pump-a"}, "view": "card"})

    def test_drawing_swapped_for_a_symlink_is_unknown_and_never_read(self):
        import tempfile

        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / "x.json").write_bytes(b"OUTSIDE")
        self.draw("pump-a", b'{"v":1}')
        path = self.tmp / "Inbox" / "Drawings" / "pump-a.hqdraw.json"
        path.unlink()
        path.symlink_to(outside / "x.json")
        sealed = hashlib.sha256(b'{"v":1}').hexdigest()
        with mock.patch.object(portals.snaps, "hash_file", side_effect=AssertionError("must not hash a redirected target")):
            self.assertEqual(one("drawing", "pump-a")["state"], "unknown")
            status, out = resolve({"kind": "drawing", "id": "pump-a", "expect_sha256": sealed})
        self.assertEqual(out["results"][0]["state"], "unknown")
        self.assertEqual(one("drawing", "pump-gone")["state"], "missing")

    def test_missing_drawing_under_a_redirected_drawings_folder_is_unknown(self):
        import tempfile

        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        (self.tmp / "Inbox").mkdir(exist_ok=True)
        d = self.tmp / "Inbox" / "Drawings"
        if d.exists():
            shutil.rmtree(d)
        d.symlink_to(outside, target_is_directory=True)
        with mock.patch.object(portals.snaps, "hash_file", side_effect=AssertionError("must not hash")):
            self.assertEqual(one("drawing", "pump-gone")["state"], "unknown")
            status, out = resolve({"kind": "drawing", "id": "pump-gone", "expect_sha256": "0" * 64})
        self.assertEqual(out["results"][0]["state"], "unknown")

    def _gap_swap(self, mutate, expect_sha):
        """Forces `mutate()` to run AFTER the safe probe succeeded and BEFORE the integrity hash starts."""
        real = portals._plain_regular
        fired = []

        def probe(root, rel):
            st = real(root, rel)
            if st is not None and not fired and rel.endswith(".hqdraw.json"):
                fired.append(1)
                mutate()
            return st

        with mock.patch.object(portals, "_plain_regular", probe):
            status, out = resolve({"kind": "drawing", "id": "pump-a", "expect_sha256": expect_sha})
        self.assertTrue(fired, "the mutation hook ran in the validation/hash gap")
        return out["results"][0]

    def test_parent_swapped_for_a_redirect_between_validation_and_hash_is_unknown_and_never_read(self):
        import tempfile

        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        self.draw("pump-a", b'{"v":1}')
        sealed = hashlib.sha256(b'{"v":1}').hexdigest()
        (outside / "pump-a.hqdraw.json").write_bytes(b'{"v":1}')  # the redirected copy would even MATCH the seal
        opened = []
        real_open, real_os_open = open, os.open

        def spy_os_open(path, *a, **k):
            if str(path).startswith(str(outside)):
                opened.append(str(path))
            return real_os_open(path, *a, **k)

        def swap():
            d = self.tmp / "Inbox" / "Drawings"
            d.rename(self.tmp / "Inbox" / "Drawings.moved")
            d.symlink_to(outside, target_is_directory=True)

        with mock.patch("os.open", spy_os_open):
            row = self._gap_swap(swap, sealed)
        self.assertEqual(row["state"], "unknown", row)
        self.assertNotIn(row["state"], ("available", "anomaly"))
        self.assertFalse(opened, "nothing beyond the redirected parent is opened")
        _ = real_open

    def test_drawing_file_replaced_by_a_symlink_or_deleted_in_the_gap(self):
        import tempfile

        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / "x.json").write_bytes(b'{"v":1}')
        self.draw("pump-a", b'{"v":1}')
        sealed = hashlib.sha256(b'{"v":1}').hexdigest()
        path = self.tmp / "Inbox" / "Drawings" / "pump-a.hqdraw.json"

        def to_symlink():
            path.unlink()
            path.symlink_to(outside / "x.json")

        row = self._gap_swap(to_symlink, sealed)
        self.assertEqual(row["state"], "unknown", row)
        path.unlink()
        self.draw("pump-a", b'{"v":1}')
        row = self._gap_swap(lambda: path.unlink(), sealed)
        self.assertEqual(row["state"], "missing", row)  # genuinely deleted in the gap: absence, never available / anomaly

    def test_fallback_without_dir_fd_revalidates_and_a_change_is_unknown(self):
        self.draw("pump-a", b'{"v":1}')
        sealed = hashlib.sha256(b'{"v":1}').hexdigest()
        path = self.tmp / "Inbox" / "Drawings" / "pump-a.hqdraw.json"
        with mock.patch.object(portals, "_CONFINED", False):
            self.assertEqual(resolve({"kind": "drawing", "id": "pump-a", "expect_sha256": sealed})[1]["results"][0]["state"], "available")
            real_hash = portals.snaps.hash_file

            def hash_then_touch(p, *a, **k):
                got = real_hash(p, *a, **k)
                path.write_bytes(b'{"v":"changed during the read"}')
                return got

            with mock.patch.object(portals.snaps, "hash_file", hash_then_touch):
                row = resolve({"kind": "drawing", "id": "pump-a", "expect_sha256": sealed})[1]["results"][0]
        self.assertEqual(row["state"], "unknown", row)

    def test_confined_hash_matches_the_regular_hash(self):
        self.draw("pump-a", b'{"v":1}' * 1000)
        self.assertEqual(portals._hash_confined(self.tmp, "Inbox/Drawings/pump-a.hqdraw.json"), snaps.hash_file(self.tmp / "Inbox" / "Drawings" / "pump-a.hqdraw.json"))
        self.assertIsNone(portals._hash_confined(self.tmp, "Inbox/Drawings/none.hqdraw.json"))
        self.assertIsNone(portals._hash_confined(self.tmp, "Inbox/NoDir/none.hqdraw.json"))

    def test_new_stem_never_changes_the_old_one_and_plain_blocks_make_no_integrity_claim(self):
        self.draw("pump-a", b'{"v":1}')
        before = one("drawing", "pump-a")
        self.draw("pump-b", b'{"v":2}')
        self.assertEqual(one("drawing", "pump-a"), before)
        self.draw("pump-a", b'{"v":"changed"}')  # same stem, other bytes
        self.assertEqual(one("drawing", "pump-a")["state"], "available")  # NO baseline, NO claim
        self.assertIsNone(one("drawing", "pump-a")["integrity"])

    def test_anomaly_only_against_a_seal_that_something_else_owns(self):
        self.draw("pump-a", b'{"v":1}')
        sealed = hashlib.sha256(b'{"v":1}').hexdigest()
        self.assertEqual(one("drawing", "pump-a", **{}) ["state"], "available")
        status, out = resolve({"kind": "drawing", "id": "pump-a", "expect_sha256": sealed})
        self.assertEqual(out["results"][0]["state"], "available")
        self.draw("pump-a", b'{"v":"tampered"}')
        status, out = resolve({"kind": "drawing", "id": "pump-a", "expect_sha256": sealed})
        row = out["results"][0]
        self.assertEqual((row["state"], row["state_label"]), ("anomaly", "Anomalie d’intégrité"))
        self.assertNotIn("mise à jour", json.dumps(row).lower())  # never described as a new version or an update

    def test_review_evidence_reports_changed_same_stem_bytes_as_an_integrity_anomaly(self):
        self.draw("pump-a", b'{"v":1}')
        pk = self.add(self.new(), {"kind": "drawing", "stem": "pump-a"})
        self.draw("pump-a", b'{"v":"tampered"}')
        row = next(iter(evidence.freshness(self.get(pk))["items"].values()))
        self.assertEqual((row["state"], row["anomaly"]), ("changed", "drawing_bytes_changed"))


# ================================================================ history / restore / diff / snapshot


class HistoryTests(PBase):
    def test_replace_ref_is_an_ordinary_revision_and_restore_brings_the_exact_old_ref_back(self):
        page = self.page_of(portal("file", "Inbox/Docs/a.pdf", "card"))
        block = self.cur(page["id"])["content"]["blocks"][1]
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": self.cur(page["id"])["rev"]})[1]["event_id"]
        rev = self.cur(page["id"])["rev"]
        blocks = copy.deepcopy(self.cur(page["id"])["content"]["blocks"])
        blocks[1]["portal"] = {"ref": {"kind": "file", "id": "Inbox/Docs/b.pdf"}, "view": "compact"}
        edited = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": rev, "content": {"version": 2, "blocks": blocks}})["page"]
        self.assertEqual(edited["rev"], rev + 1)  # an ordinary page mutation
        self.assertEqual(edited["content"]["blocks"][1]["id"], block["id"])
        status, out = hq_carnet.http_post({"action": "history_restore", "page_id": page["id"], "event_id": cp, "expected_rev": edited["rev"], "confirm": True})
        self.assertEqual(status, 200, out)
        restored = self.cur(page["id"])["content"]["blocks"][1]
        self.assertEqual(restored["portal"], {"ref": {"kind": "file", "id": "Inbox/Docs/a.pdf"}, "view": "card"})
        self.assertEqual((restored["id"], restored["type"]), (block["id"], "portal"))
        self.assertEqual(self.cur(page["id"])["rev"], edited["rev"] + 1)

    def test_diff_labels_a_portal_retarget_exactly(self):
        old = {"id": "block-a", "type": "portal", "text": "", "marks": [], "portal": {"ref": {"kind": "file", "id": "Inbox/Docs/a.pdf"}, "view": "card"}}
        new = copy.deepcopy(old)
        new["portal"]["ref"]["id"] = "Inbox/Docs/b.pdf"
        tags, detail = intel.classify_change(old, new)
        self.assertEqual(tags, ["portal_ref"])
        self.assertEqual((detail["from_ref"]["id"], detail["to_ref"]["id"]), ("Inbox/Docs/a.pdf", "Inbox/Docs/b.pdf"))
        view = copy.deepcopy(old)
        view["portal"]["view"] = "compact"
        self.assertEqual(intel.classify_change(old, view)[0], ["portal_view"])
        self.assertFalse(intel._same_block(old, new))
        self.assertIn("Inbox/Docs/a.pdf", intel.block_summary(old))

    def test_deleting_a_portal_block_never_touches_the_target(self):
        p = self.put("Inbox/Docs/a.pdf", b"keep")
        ed = self.ed()
        pk = self.new()
        page = self.page_of(portal("file", "Inbox/Docs/a.pdf"), portal("source", ed["id"]), portal("review", pk["id"]))
        before = (p.read_bytes(), self.src_rev(ed), self.review_files()[0].read_bytes())
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "content": {"version": 2, "blocks": [self.cur(page["id"])["content"]["blocks"][0]]}})
        self.assertEqual((p.read_bytes(), self.src_rev(ed), self.review_files()[0].read_bytes()), before)
        self.assertEqual(one("review", pk["id"])["state"], "available")


class SnapshotSemanticsTests(PBase):
    def test_sealed_kinds_enter_the_snapshot_closure_review_and_snapshot_portals_do_not(self):
        ed = self.ed()
        self.put("Inbox/Docs/a.pdf", b"A")
        self.put("Inbox/Models/m.glb", b"M")
        self.put("Inbox/Photos/p.png", b"P")
        pk = self.new()
        sid0 = self.page_with() and self.snap()
        self.page_of(portal("source", ed["id"]), portal("file", "Inbox/Docs/a.pdf"), portal("model", "Inbox/Models/m.glb"), portal("media", "Inbox/Photos/p.png"),
                     portal("review", pk["id"]), portal("snapshot", sid0))
        sid = self.snap()
        snap = snaps.get(sid)["snapshot"]
        files = {(f["kind"], f["path"]): f for f in snap["refs"]["files"]}
        self.assertEqual(set(files), {("file", "Inbox/Docs/a.pdf"), ("model", "Inbox/Models/m.glb"), ("media", "Inbox/Photos/p.png")})
        self.assertTrue(all(f["state"] == "ok" and len(f["sha256"]) == 64 for f in files.values()))
        self.assertEqual([s["id"] for s in snap["refs"]["sources"]], [ed["id"]])
        blob = json.dumps(snap["refs"])
        self.assertNotIn(pk["id"], blob)  # a Review Pack target is NOT frozen: Phase 5 closure is not expanded
        self.assertNotIn(sid0, blob)
        stored = [b["portal"]["ref"] for p in snap["pages"] for b in p["content"]["blocks"] if b["type"] == "portal"]
        self.assertIn({"kind": "review", "id": pk["id"]}, stored)  # the REFERENCE is frozen with the page content

    def test_frozen_file_target_change_is_reported_by_the_existing_verify_not_by_the_portal(self):
        p = self.put("Inbox/Docs/a.pdf", b"v1")
        self.page_of(portal("file", "Inbox/Docs/a.pdf"))
        sid = self.snap()
        p.write_bytes(b"v2")
        verdict = snaps.verify(sid)
        self.assertEqual(verdict["counts"]["modified"], 1)  # the SNAPSHOT's own verify seals/compares the file bytes (Phase 5 behaviour)
        self.assertEqual(verdict["refs"]["files"][0]["status"], "modified")
        self.assertEqual(one("file", "Inbox/Docs/a.pdf")["state"], "available")  # the portal says "exists"; sealing is the snapshot's job

    def test_portal_source_is_not_a_citation(self):
        ed = self.ed()
        blk = portal("source", ed["id"], bid="block-pp")
        self.assertEqual(intel.block_refs(blk), [])
        self.assertEqual(intel.portal_refs(blk), [{"kind": "source", "id": ed["id"]}])
        self.assertEqual(intel.portal_refs(portal("review", "rvw-" + ZERO24)), [])
        self.assertEqual(intel.portal_refs(portal("snapshot", "snap-" + ZERO24)), [])


# ================================================================ Ask Carnet (stored identity only)


class AskTests(PBase):
    def ask(self, question, **extra):
        status, out = post(action="ask", question=question, scope={"kind": "project", "id": self.proj["id"]}, **extra)
        self.assertEqual(status, 200, out)
        return out

    def test_unit_is_the_stored_identity_and_nothing_else(self):
        ed = self.ed()
        page = self.page_of(portal("source", ed["id"]))
        units = [u for u in ask.units_of(self.cur(page["id"])) if u["kind"] == "portal"]
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["text"], f"Portail Source {ed['id']}")
        self.assertNotIn("ASME", units[0]["text"])  # the current title is not read

    def test_portal_card_is_a_reference_never_primary_evidence_and_ignores_target_changes(self):
        ed = self.ed()
        self.page_of(portal("source", ed["id"]))
        r1 = self.ask(f"portail {ed['id']}")
        card = next(c for c in r1["cards"] if c["kind"] == "portal")
        self.assertEqual((card["class"], card["portal"]), ("reference", {"kind": "source", "id": ed["id"]}))
        self.assertEqual(r1["counts"]["evidence"], 0)
        self.assertNotEqual(r1["status"], "evidence")
        sources.mutate({"action": "source_edition_update", "id": ed["id"], "expected_rev": self.src_rev(ed), "title": "Tout autre titre ZZZ"})
        r2 = self.ask(f"portail {ed['id']}")
        self.assertEqual(json.dumps(r1["cards"], sort_keys=True), json.dumps(r2["cards"], sort_keys=True))
        self.assertEqual(r1["fingerprint"], r2["fingerprint"])  # changes only when the stored portal block changes
        self.assertEqual(self.ask("ASME B31.3")["cards"], [])  # the target's title is not searchable through the portal

    def test_portal_never_ingests_the_target_contents(self):
        self.put("Inbox/Docs/secret.pdf", b"CONFIDENTIALCONTENT")
        pk = self.add(self.new(), {"kind": "page", "page_id": self.page_with()["id"]})
        self.page_of(portal("file", "Inbox/Docs/secret.pdf"), portal("review", pk["id"]))
        for q in ("CONFIDENTIALCONTENT", "intro"):
            out = self.ask(q)
            self.assertNotIn("CONFIDENTIALCONTENT", json.dumps(out)) if q != "CONFIDENTIALCONTENT" else self.assertEqual([c for c in out["cards"] if c["kind"] == "portal"], [])

    def test_frozen_page_search_never_mixes_the_frozen_reference_with_live_metadata(self):
        ed = self.ed()
        self.page_of(portal("source", ed["id"]))
        sid = self.snap()
        sources.mutate({"action": "source_edition_update", "id": ed["id"], "expected_rev": self.src_rev(ed), "title": "Nouveau titre LIVE"})
        status, out = post(action="ask", question=f"portail {ed['id']}", scope={"kind": "snapshot", "id": sid})
        self.assertEqual(status, 200, out)
        blob = json.dumps(out["cards"])
        self.assertIn(ed["id"], blob)
        self.assertNotIn("LIVE", blob)
        self.assertNotIn("ASME", blob)


# ================================================================ report


class ReportTests(PBase):
    def build(self, page):
        return report.build({"action": "report_build", "items": [{"kind": "note", "page_id": page["id"], "rev": self.cur(page["id"])["rev"]}]})

    def test_report_renders_stored_identity_with_the_state_resolved_at_build_time(self):
        ed = self.ed()
        self.put("Inbox/Docs/a.pdf")
        pk = self.act("review_update", self.new(), title="Inspection pompe")["review"]
        page = self.page_of(portal("source", ed["id"]), portal("file", "Inbox/Docs/a.pdf"), portal("file", "Inbox/Docs/gone.pdf"), portal("review", pk["id"]))
        out = self.build(page)
        md = out["markdown"]
        self.assertIn("Portail Source : " + ed["id"], md)
        self.assertIn("ASME B31.3", md)
        self.assertIn("Disponible", md)
        self.assertRegex(md, r"gone\.pdf.*Introuvable")
        self.assertIn("Inspection pompe", md)
        sec = out["sections"][0]
        self.assertEqual(len(sec["portals"]), 4)
        self.assertEqual({p["state"] for p in sec["portals"]}, {"available", "missing"})
        self.assertEqual(self.build(page)["markdown"], md, "deterministic for an unchanged world")

    def test_report_marks_corrupt_targets_and_adds_no_interpretation(self):
        pk = self.new()
        page = self.page_of(portal("review", pk["id"]))
        path = self.review_files()[0]
        raw = json.loads(path.read_text())
        raw["note"] = "x"
        path.write_text(json.dumps(raw))
        md = self.build(page)["markdown"]
        self.assertIn("Altéré", md)
        for word in ("conforme", "approuvé", "risque", "recommand"):
            self.assertNotIn(word, md.lower())

    def test_report_does_not_modify_the_page_and_markup_in_titles_is_escaped(self):
        ed = self.ed(title="<img src=x onerror=alert(1)> *gras*")
        page = self.page_of(portal("source", ed["id"]))
        rev = self.cur(page["id"])["rev"]
        md = self.build(page)["markdown"]
        self.assertNotRegex(md, r"(?<!\\)<img")
        self.assertIn("\\<img", md)
        self.assertEqual(self.cur(page["id"])["rev"], rev)

    def test_report_resolves_in_bounded_batches(self):
        page = self.make_page([para("a")])
        blocks = [para("a")] + [portal("file", f"Inbox/Docs/f{n}.pdf") for n in range(100)]
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "project_id": self.proj["id"], "content": {"version": 2, "blocks": blocks}})
        with mock.patch.object(portals, "resolve", wraps=portals.resolve) as spy:
            self.build(self.cur(page["id"]))
        self.assertEqual(spy.call_count, 1)
        self.assertLessEqual(len(spy.call_args[0][0]["refs"]), portals.REFS_MAX)


# ================================================================ review packs: two-layer observation


class ReviewEvidenceTests(PBase):
    def setup_pack(self):
        ed = self.ed()
        page = self.page_of(portal("source", ed["id"]))
        block = self.cur(page["id"])["content"]["blocks"][1]
        pk = self.add(self.new(), {"kind": "block", "page_id": page["id"], "block_id": block["id"]})
        return ed, page, block, pk

    def row(self, pk):
        return next(iter(evidence.freshness(self.get(pk))["items"].values()))

    def test_capture_stores_identity_only_and_observation_has_two_separate_layers(self):
        ed, page, block, pk = self.setup_pack()
        item = pk["items"][0]
        self.assertEqual(item["copy"]["portal"], {"kind": "source", "id": ed["id"]})
        self.assertNotIn("ASME", json.dumps(item))  # no resolved title in the stored layer
        row = self.row(pk)
        self.assertEqual(row["state"], "unchanged")
        self.assertEqual((row["target"]["state"], row["target"]["state_label"]), ("available", "Disponible"))

    def test_block_unchanged_while_the_target_is_missing(self):
        ed, page, block, pk = self.setup_pack()
        path = sources.confined_path()
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        data["editions"] = [e for e in data["editions"] if e["id"] != ed["id"]]
        Path(path).write_text(json.dumps(data), encoding="utf-8")
        row = self.row(pk)
        self.assertEqual(row["state"], "unchanged")  # the portal BLOCK did not change…
        self.assertEqual(row["target"]["state"], "missing")  # …its TARGET is gone: two distinct facts
        self.assertEqual(self.get(pk)["items"][0]["copy"]["portal"]["id"], ed["id"])  # never rewritten

    def test_block_changed_while_the_captured_target_is_still_available(self):
        ed, page, block, pk = self.setup_pack()
        blocks = copy.deepcopy(self.cur(page["id"])["content"]["blocks"])
        blocks[1]["portal"]["view"] = "compact"
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "content": {"version": 2, "blocks": blocks}})
        row = self.row(pk)
        self.assertEqual(row["state"], "changed")
        self.assertEqual(row["target"]["state"], "available")

    def test_non_portal_items_have_no_target_layer_and_export_names_it(self):
        page = self.page_with()
        pk = self.add(self.new(), {"kind": "page", "page_id": page["id"]})
        self.assertIsNone(self.row(pk)["target"])
        ed, page2, block, pk2 = self.setup_pack()
        md = evidence.render_markdown(self.get(pk2), evidence.freshness(self.get(pk2)))
        self.assertIn("Cible du portail (état actuel, distinct du bloc) : Disponible", md)

    def test_freshness_never_writes(self):
        ed, page, block, pk = self.setup_pack()
        before = tree_digest(self.tmp / ".hq-carnet" / "reviews")
        evidence.freshness(self.get(pk))
        self.assertEqual(tree_digest(self.tmp / ".hq-carnet" / "reviews"), before)


# ================================================================ backup: no recursive closure


class BackupTests(PBase):
    def test_portals_do_not_widen_the_backup_into_an_object_graph(self):
        ed = self.ed()
        self.put("Inbox/Docs/a.pdf", b"A")
        pk = self.add(self.new(), {"kind": "page", "page_id": self.page_with()["id"]})
        sid = self.snap()
        base = hq_carnet.snapshot_to(self.tmp, self.tmp / "b0")
        self.page_of(portal("source", ed["id"]), portal("file", "Inbox/Docs/a.pdf"), portal("review", pk["id"]), portal("snapshot", sid))
        out = hq_carnet.snapshot_to(self.tmp, self.tmp / "b1")
        self.assertTrue(out["valid"])
        self.assertEqual(out["reviews"]["count"], base["reviews"]["count"])  # the same bounded review store, nothing extra
        self.assertEqual(sorted(p.name for p in (self.tmp / "b1" / "reviews").iterdir()), sorted(p.name for p in (self.tmp / "b0" / "reviews").iterdir()))
        self.assertEqual(sorted(p.name for p in (self.tmp / "b1" / "snapshots").iterdir()), sorted(p.name for p in (self.tmp / "b0" / "snapshots").iterdir()))
        self.assertFalse((self.tmp / "b1" / "Inbox").exists(), "no target binary is copied because a portal points at it")
        self.assertEqual(set(out) - {"notebook", "page_count"}, set(base) - {"notebook", "page_count"} | set(out) & set(base))


# ================================================================ security / transport


class SecurityTests(unittest.TestCase):
    def test_the_resolver_module_has_no_network_shell_or_eval_primitives(self):
        src = (Path(__file__).resolve().parent.parent / "hq_carnet_portals.py").read_text(encoding="utf-8")
        for needle in ("subprocess", "socket", "urllib.request", "http.client", "eval(", "exec(", "os.system", "shutil", "requests", "webbrowser", "write_text", "write_bytes", ".unlink(", "os.remove", "os.replace"):
            self.assertNotIn(needle, src, needle)
        # the ONLY file opens are read-only descriptors: no bare open(), no Path.open, never a write / create / truncate flag
        self.assertNotRegex(src, r"(?<![\w.])open\(")
        self.assertNotIn(".open(", src.replace("os.open(", ""))
        for flag in ("O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC", "O_APPEND"):
            self.assertNotIn(flag, src, flag)

    def test_portal_resolve_is_post_only_and_routes_through_the_normal_dispatch(self):
        self.assertIn("portal_resolve", hq_carnet._STAGE08)
        extra = hq_carnet.http_get({"portals": ["1"]})
        self.assertNotEqual(extra[0], 200)

    def test_client_assets_never_embed_a_frame_or_html_passthrough(self):
        root = Path(__file__).resolve().parent.parent / "assets"
        for name in ("hq-carnet-portals.js", "hq-carnet-portals-ui.js"):
            text = (root / name).read_text(encoding="utf-8")
            for needle in ("iframe", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "srcdoc", "dangerouslySet"):
                self.assertNotIn(needle, text, f"{name}: {needle}")


if __name__ == "__main__":
    unittest.main()
