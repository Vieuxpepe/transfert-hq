"""Carnet Stage 08 — history, restore, bulk operations, Undo, source migration, linked-file replacement.

Throwaway ROOTs only (run from a disposable source copy). Browser behaviour: tests/visual_carnet_history_playwright.mjs.
Backlinks / reports / backup / HTTP live in tests/test_hq_carnet_links_report.py.
"""

from __future__ import annotations

import copy
import json
import os
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_bulk as bulk  # noqa: E402
import hq_carnet_history as history  # noqa: E402
import hq_carnet_links as links  # noqa: E402
import hq_carnet_rich as rich  # noqa: E402
import hq_carnet_sources as sources  # noqa: E402
from test_hq_carnet import CarnetBase  # noqa: E402

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def para(text="x", marks=None):
    return {"type": "paragraph", "text": text, "marks": marks or []}


def bold(start, end):
    return {"type": "bold", "start": start, "end": end}


class Stage08Base(CarnetBase):
    def setUp(self):
        super().setUp()
        for name in ("Inbox", "Uni", "Print"):
            (self.tmp / name).mkdir(exist_ok=True)
        for name in ("a.pdf", "b.pdf"):
            (self.tmp / "Inbox" / name).write_bytes(PDF)
        bulk._seen.clear()
        links.clear()
        self.history_path = self.tmp / ".hq-carnet" / "history.json"

    # ---- notebook helpers
    def make_page(self, blocks, **meta):
        nb = hq_carnet.get_notebook()
        created = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": nb["notebook_rev"]})["page"]
        saved = hq_carnet.mutate({"action": "page_save", "id": created["id"], "expected_rev": created["rev"], "content": {"version": 2, "blocks": copy.deepcopy(blocks)}, **meta})
        return saved["page"]

    def make_v1_page(self, text):
        nb = hq_carnet.get_notebook()
        created = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": nb["notebook_rev"]})["page"]
        return hq_carnet.mutate({"action": "page_save", "id": created["id"], "expected_rev": created["rev"], "content": {"version": 1, "blocks": [{"id": created["content"]["blocks"][0]["id"], "type": "text", "text": text, "marks": []}]}})["page"]

    def cur(self, page_id):
        return self.page(page_id)

    def texts(self, page_id):
        return [b["text"] for b in self.cur(page_id)["content"]["blocks"]]

    def events(self, **kw):
        return history.list_events(**kw)["events"]

    def history_bytes(self):
        return self.history_path.read_bytes() if self.history_path.exists() else b""

    # ---- bulk helpers
    def preview(self, op, params, page_ids=None):
        data = {"action": "bulk_preview", "op": op, "params": params}
        if page_ids is not None:
            data["page_ids"] = page_ids
        out = bulk.preview(data)
        self.last_plan = out.get("plan")
        return out

    def targets_of(self, pv):
        return [{"id": t["id"], "rev": t["rev"]} for t in pv["targets"] if t["status"] == "will_apply"]

    def apply(self, op, params, targets, expected=None, **extra):
        data = {"action": "bulk_apply", "op": op, "params": params, "targets": targets, "confirm": True, "expected_count": len(targets) if expected is None else expected, "request_id": "rq-" + os.urandom(6).hex(), "plan": getattr(self, "last_plan", None)}
        data.update(extra)
        return bulk.apply(data)

    def undo(self, event_id):
        return bulk.undo({"action": "bulk_undo", "event_id": event_id, "confirm": True})

    # ---- sources helpers
    def family(self, name="Handbook"):
        return sources.mutate({"action": "source_family_create", "name": name})["family"]

    def edition(self, family, label, **extra):
        data = {"action": "source_edition_create", "family_id": family["id"], "edition": label, "title": "Machinery", "author": "Oberg", "year": 2012, **extra}
        return sources.mutate(data)["edition"]

    def cite(self, ed, kind="page", text="417", pdf=None, ok=True):
        return {"src": ed["id"], "loc": {"kind": kind, "text": text}, "pdf": pdf, "ok": ok,
                "snap": bulk.edition_snapshot(ed), "from": None}

    def cite_block(self, ed, kind="page", text="417", pdf=None, ok=True, before="Voir ", after=" puis suite", extra_marks=None):
        cite = self.cite(ed, kind, text, pdf, ok)
        label = bulk.citation_label(cite)
        start = len(before)
        marks = [{"type": "citation", "start": start, "end": start + len(label), "cite": cite}] + (extra_marks(start, start + len(label)) if extra_marks else [])
        return para(before + label + after, marks)


# ---------------------------------------------------------------- history store


class HistoryStoreTests(Stage08Base):
    def test_missing_history_is_available_and_empty(self):
        self.assertTrue(history.available())
        out = history.list_events()
        self.assertEqual(out["events"], [])
        self.assertFalse(self.history_path.exists(), "reading never creates the file")

    def test_autosave_never_creates_history(self):
        page = self.make_page([para("a")])
        for i in range(30):  # a long typing session = many saves
            page = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [{**page["content"]["blocks"][0], "text": "a" * (i + 2)}]}})["page"]
        self.assertFalse(self.history_path.exists())
        self.assertEqual(self.events(), [])

    def test_checkpoint_stores_the_persisted_content_and_dedupes(self):
        page = self.make_page([para("first")])
        out = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"], "label": "avant essai"})
        self.assertEqual(out[0], 200)
        event_id = out[1]["event_id"]
        self.assertFalse(out[1]["duplicate"])
        event = history.get_event(event_id)
        self.assertEqual(event["data"]["content"], self.cur(page["id"])["content"])
        self.assertEqual(event["data"]["label"], "avant essai")
        again = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"], "label": "avant essai"})[1]
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["event_id"], event_id)
        self.assertEqual(len(self.events()), 1)

    def test_checkpoint_stale_trashed_and_validation(self):
        page = self.make_page([para("first")])
        status, out = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"] + 5})
        self.assertEqual((status, out["code"]), (409, "revision_conflict"))
        for bad in ({"label": "a\nb"}, {"label": "x" * 81}, {"label": 5}, {"extra": 1}):
            status, _ = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"], **bad})
            self.assertEqual(status, 400, bad)
        nb = hq_carnet.get_notebook()
        hq_carnet.mutate({"action": "page_trash", "id": page["id"], "expected_rev": page["rev"], "expected_notebook_rev": nb["notebook_rev"]})
        status, _ = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": self.cur(page["id"])["rev"]})
        self.assertEqual(status, 400)
        self.assertEqual([e for e in self.events() if e["kind"] == "checkpoint"], [])

    def test_restore_creates_a_new_revision_and_keeps_all_later_history(self):
        page = self.make_page([para("version one")])
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})[1]["event_id"]
        block_id = page["content"]["blocks"][0]["id"]
        edited = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [{**page["content"]["blocks"][0], "text": "version two"}]}})["page"]
        cp2 = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": edited["rev"]})[1]["event_id"]
        status, out = hq_carnet.http_post({"action": "history_restore", "page_id": page["id"], "event_id": cp, "expected_rev": edited["rev"], "confirm": True})
        self.assertEqual(status, 200, out)
        self.assertEqual(self.texts(page["id"]), ["version one"])
        self.assertEqual(self.cur(page["id"])["rev"], edited["rev"] + 1, "a NEW revision, never a rewind")
        self.assertEqual(self.cur(page["id"])["content"]["blocks"][0]["id"], block_id)
        ids = [e["id"] for e in self.events()]
        self.assertIn(cp, ids)
        self.assertIn(cp2, ids, "later history survives the restore")
        restore = next(e for e in self.events() if e["kind"] == "restore")
        self.assertEqual(restore["from_event"], cp)
        self.assertEqual((restore["rev_before"], restore["rev_after"]), (edited["rev"], edited["rev"] + 1))
        self.assertEqual(restore["status"], "applied")
        # the restore is itself restorable: its pre-image (version two) comes back
        back = hq_carnet.http_post({"action": "history_restore", "page_id": page["id"], "event_id": restore["id"], "expected_rev": self.cur(page["id"])["rev"], "confirm": True})
        self.assertEqual(back[0], 200, back)
        self.assertEqual(self.texts(page["id"]), ["version two"])

    def test_restore_fails_closed_on_a_stale_revision(self):
        page = self.make_page([para("one")])
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})[1]["event_id"]
        edited = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [{**page["content"]["blocks"][0], "text": "two"}]}})["page"]
        before = self.path.read_bytes()
        hist_before = self.history_bytes()
        status, out = hq_carnet.http_post({"action": "history_restore", "page_id": page["id"], "event_id": cp, "expected_rev": page["rev"], "confirm": True})
        self.assertEqual((status, out["code"]), (409, "revision_conflict"))
        self.assertEqual(out["page"]["rev"], edited["rev"], "the current page is returned")
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.history_bytes(), hist_before)

    def test_restore_validation(self):
        page = self.make_page([para("one")])
        other = self.make_page([para("other")])
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})[1]["event_id"]
        rev = self.cur(page["id"])["rev"]
        base = {"action": "history_restore", "page_id": page["id"], "event_id": cp, "expected_rev": rev}
        self.assertEqual(hq_carnet.http_post(base)[0], 400, "confirmation is explicit")
        self.assertEqual(hq_carnet.http_post({**base, "confirm": False})[0], 400)
        self.assertEqual(hq_carnet.http_post({**base, "confirm": True, "page_id": other["id"]})[0], 400, "an event of another page is refused")
        self.assertEqual(hq_carnet.http_post({**base, "confirm": True, "event_id": "hev-" + "0" * 24})[0], 404)
        self.assertEqual(hq_carnet.http_post({**base, "confirm": True, "event_id": "nope"})[0], 400)
        self.assertEqual(hq_carnet.http_post({**base, "confirm": True})[0], 400, "restoring the identical version is refused")
        self.assertEqual(self.cur(page["id"])["rev"], rev)

    def test_restore_with_removed_blocks_and_legacy_pages(self):
        page = self.make_page([para("a"), para("b"), para("c")])
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})[1]["event_id"]
        keep = page["content"]["blocks"][0]
        shrunk = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [keep]}})["page"]
        out = hq_carnet.http_post({"action": "history_restore", "page_id": page["id"], "event_id": cp, "expected_rev": shrunk["rev"], "confirm": True})
        self.assertEqual(out[0], 200, out)
        self.assertEqual(self.texts(page["id"]), ["a", "b", "c"])
        ids = [b["id"] for b in self.cur(page["id"])["content"]["blocks"]]
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual(ids[0], keep["id"])
        # a legacy V1 page checkpoint restored onto a V2 page
        v1 = self.make_v1_page("old\nlines")
        cp1 = hq_carnet.http_post({"action": "history_checkpoint", "page_id": v1["id"], "expected_rev": v1["rev"]})[1]["event_id"]
        self.assertEqual(history.get_event(cp1)["data"]["content"]["version"], 2, "the first write already migrated it")

    def test_lifecycle_events_are_metadata_only_and_best_effort(self):
        page = self.make_page([para("secret note text")])
        nb = hq_carnet.get_notebook()["notebook_rev"]
        hq_carnet.mutate({"action": "page_trash", "id": page["id"], "expected_rev": page["rev"], "expected_notebook_rev": nb})
        rev = self.cur(page["id"])["rev"]
        hq_carnet.mutate({"action": "page_restore", "id": page["id"], "expected_rev": rev, "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        rows = [e for e in self.events() if e["kind"] == "lifecycle"]
        self.assertEqual([r["action"] for r in rows], ["restore", "trash"])
        self.assertNotIn(b"secret note text", self.history_bytes())
        # a damaged history never blocks the lifecycle change
        self.history_path.write_bytes(b"{broken")
        hq_carnet.mutate({"action": "page_trash", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        self.assertIsNotNone(self.cur(page["id"])["deleted_at"])
        self.assertEqual(self.history_path.read_bytes(), b"{broken")

    def test_malformed_history_is_preserved_and_history_features_fail_closed(self):
        page = self.make_page([para("one")])
        for raw in (b"{broken", b"[]", b'{"version":1}', b'{"version":2,"history_rev":1,"pruned_total":0,"events":[]}', b"\xff\xfe", json.dumps({"version": 1, "history_rev": 1, "pruned_total": 0, "events": [{"id": "x"}]}).encode()):
            self.history_path.write_bytes(raw)
            self.assertFalse(history.available(), raw)
            status, out = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": self.cur(page["id"])["rev"]})
            self.assertEqual((status, out["code"]), (503, "history_unavailable"))
            self.assertEqual(hq_carnet.http_get({"history": ["1"]})[0], 503)
            self.assertEqual(self.history_path.read_bytes(), raw, "malformed bytes are never repaired")
            self.assertNotIn(str(self.tmp), json.dumps(out))
        # ordinary note editing is unaffected
        saved = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": self.cur(page["id"])["rev"], "content": {"version": 2, "blocks": [{**self.cur(page["id"])["content"]["blocks"][0], "text": "still editable"}]}})
        self.assertEqual(self.texts(page["id"]), ["still editable"])

    def test_history_path_redirection_is_refused(self):
        page = self.make_page([para("one")])
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})
        elsewhere = self.tmp / "elsewhere.json"
        elsewhere.write_bytes(self.history_path.read_bytes())
        self.history_path.unlink()
        try:
            os.symlink(elsewhere, self.history_path)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        status, out = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"], "label": "x"})
        self.assertEqual(status, 503)
        self.assertNotIn(str(self.tmp), json.dumps(out))

    def test_history_holds_no_secret_or_absolute_path(self):
        page = self.make_page([para("plain note")])
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})
        raw = self.history_path.read_text(encoding="utf-8")
        for needle in (str(self.tmp), "csrf", "token", "cookie", "session", "pin", "C:\\", "/home/"):
            self.assertNotIn(needle, raw.lower() if needle.islower() else raw, needle)


class HistoryBoundsTests(Stage08Base):
    def checkpoint_many(self, page, n):
        rev = page["rev"]
        for i in range(n):
            blocks = [{**self.cur(page["id"])["content"]["blocks"][0], "text": f"v{i}"}]
            saved = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": rev, "content": {"version": 2, "blocks": blocks}})["page"]
            rev = saved["rev"]
            self.assertEqual(hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": rev})[0], 200)
        return rev

    def test_per_page_snapshot_bound_prunes_the_oldest_of_that_page(self):
        page = self.make_page([para("v")])
        other = self.make_page([para("o")])
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": other["id"], "expected_rev": other["rev"]})
        self.checkpoint_many(page, history.SNAPSHOTS_PER_PAGE_MAX + 5)
        mine = [e for e in self.events(page_id=page["id"]) if e["kind"] == "checkpoint"]
        self.assertEqual(len(mine), history.SNAPSHOTS_PER_PAGE_MAX)
        self.assertEqual(len([e for e in self.events(page_id=other["id"])]), 1, "another page's snapshot is untouched")
        self.assertEqual(history.list_events()["pruned_total"], 5)
        newest = history.get_event(mine[0]["id"])
        self.assertEqual(newest["data"]["content"]["blocks"][0]["text"], f"v{history.SNAPSHOTS_PER_PAGE_MAX + 4}")

    def test_total_event_bound_and_protected_bulk_events(self):
        page = self.make_page([para("a b c")])
        pv = self.preview("replace", {"find": "b", "replace": "B"}, [page["id"]])
        first = self.apply("replace", pv["params"], self.targets_of(pv))["event_id"]
        # flood the history with lifecycle-like events up to and over the cap
        for i in range(history.EVENTS_MAX + 20):
            history.append("lifecycle", "applied", "x", {"page_id": page["id"], "action": "trash", "rev_after": 2})
        state = json.loads(self.history_path.read_text(encoding="utf-8"))
        self.assertLessEqual(len(state["events"]), history.EVENTS_MAX)
        self.assertIn(first, [e["id"] for e in state["events"]], "the newest undoable bulk event is protected from pruning")
        self.assertGreater(state["pruned_total"], 0)
        self.assertTrue(self.undo(first)["ok"])

    def test_oversized_event_is_refused_and_nothing_is_applied(self):
        blocks = [para(("word " * 2000)[:9000]) for _ in range(40)]
        pages = [self.make_page(blocks[:5]) for _ in range(2)]
        before = self.path.read_bytes()
        monkey = history.EVENT_BYTES_MAX
        history.EVENT_BYTES_MAX = 2000
        self.addCleanup(setattr, history, "EVENT_BYTES_MAX", monkey)
        pv = self.preview("replace", {"find": "word", "replace": "mot"}, [p["id"] for p in pages])
        status, out = hq_carnet.http_post({"action": "bulk_apply", "plan": pv["plan"], "op": "replace", "params": pv["params"], "targets": self.targets_of(pv), "confirm": True, "expected_count": 2, "request_id": "rq-oversize-01"})
        self.assertEqual((status, out["code"]), (409, "history_unavailable"))
        self.assertEqual(self.path.read_bytes(), before, "nothing was applied")

    def test_history_bytes_bound_refuses_when_nothing_can_be_pruned(self):
        page = self.make_page([para("x y")])
        old = history.HISTORY_BYTES_MAX
        history.HISTORY_BYTES_MAX = 250
        self.addCleanup(setattr, history, "HISTORY_BYTES_MAX", old)
        pv = self.preview("replace", {"find": "x", "replace": "z"}, [page["id"]])
        before = self.path.read_bytes()
        status, out = hq_carnet.http_post({"action": "bulk_apply", "plan": pv["plan"], "op": "replace", "params": pv["params"], "targets": self.targets_of(pv), "confirm": True, "expected_count": 1, "request_id": "rq-bytes-0001"})
        self.assertEqual(status, 409, out)
        self.assertEqual(self.path.read_bytes(), before)


# ---------------------------------------------------------------- bulk framework


class BulkReplaceTests(Stage08Base):
    def test_preview_is_read_only_and_exact(self):
        a = self.make_page([para("alpha beta alpha"), para("none here")])
        b = self.make_page([para("Alpha"), para("alpha")])
        c = self.make_page([para("zzz")])
        before = self.path.read_bytes()
        pv = self.preview("replace", {"find": "alpha", "replace": "OMEGA"}, [a["id"], b["id"], c["id"]])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(self.history_path.exists())
        self.assertEqual(pv["count"], 2)
        by_id = {t["id"]: t for t in pv["targets"]}
        self.assertEqual((by_id[a["id"]]["status"], by_id[a["id"]]["changes"]), ("will_apply", 2))
        self.assertEqual((by_id[b["id"]]["status"], by_id[b["id"]]["changes"]), ("will_apply", 2), "case-insensitive by default")
        self.assertEqual(by_id[c["id"]]["status"], "skipped")
        self.assertEqual(pv["total_changes"], 4)
        self.assertTrue(by_id[a["id"]]["samples"][0]["after"].count("OMEGA") >= 1)
        self.assertEqual(by_id[a["id"]]["rev"], a["rev"])
        cs = self.preview("replace", {"find": "alpha", "replace": "O", "case_sensitive": True}, [b["id"]])
        self.assertEqual(cs["targets"][0]["changes"], 1)

    def test_apply_reports_every_target_and_writes_one_event(self):
        a = self.make_page([para("one two one")])
        b = self.make_page([para("one more")])  # previewed as will_apply, then reported skipped (e.g. an unsaved local draft)
        pv = self.preview("replace", {"find": "one", "replace": "1"}, [a["id"], b["id"]])
        out = self.apply("replace", pv["params"], [{"id": a["id"], "rev": a["rev"]}], expected=1, client_skipped=[b["id"]])
        self.assertEqual(out["outcome"], "partial")
        self.assertFalse(out["ok"], "never a global success when one target did not apply")
        self.assertEqual(out["counts"], {"applied": 1, "skipped": 1, "conflicted": 0, "failed": 0})
        self.assertEqual({t["id"]: t["status"] for t in out["targets"]}, {a["id"]: "applied", b["id"]: "skipped"})
        self.assertEqual(self.texts(a["id"]), ["1 two 1"])
        self.assertEqual(self.cur(a["id"])["rev"], a["rev"] + 1)
        self.assertEqual(self.cur(b["id"])["rev"], b["rev"])
        bulk_events = [e for e in self.events() if e["kind"] == "bulk"]
        self.assertEqual(len(bulk_events), 1, "ONE logical event")
        event = history.get_event(out["event_id"])
        self.assertEqual(event["status"], "applied")
        applied = [t for t in event["data"]["targets"] if t["status"] == "applied"]
        self.assertEqual([t["id"] for t in applied], [a["id"]])
        self.assertEqual(applied[0]["before"], {"blocks": [{"id": a["content"]["blocks"][0]["id"], "text": "one two one", "marks": []}]}, "only the changed blocks are kept")
        self.assertEqual((applied[0]["rev_before"], applied[0]["rev_after"]), (a["rev"], a["rev"] + 1))

    def test_marks_shift_and_formatted_occurrences_are_skipped_explicitly(self):
        page = self.make_page([para("cat dog cat", [bold(8, 11)]), para("cat", [bold(0, 3)]), para("a cat")])
        pv = self.preview("replace", {"find": "cat", "replace": "mouse"}, [page["id"]])
        row = pv["targets"][0]
        self.assertEqual(row["changes"], 2, "first 'cat' of line 1 and 'a cat' of line 3")
        self.assertEqual(row["skipped_occurrences"], 2, "the two bold ones are not rewritten")
        out = self.apply("replace", pv["params"], self.targets_of(pv))
        blocks = self.cur(page["id"])["content"]["blocks"]
        self.assertEqual([b["text"] for b in blocks], ["mouse dog cat", "cat", "a mouse"])
        self.assertEqual(blocks[0]["marks"], [bold(10, 13)], "the bold mark moved with its text")
        self.assertEqual(blocks[1]["marks"], [bold(0, 3)])

    def test_astral_characters_and_utf16_offsets(self):
        text = "😀 x 😀 x"
        page = self.make_page([para(text, [bold(8, 9)])])  # the last 'x' (UTF-16 offsets; emoji = 2 units)
        pv = self.preview("replace", {"find": "😀", "replace": "ok"}, [page["id"]])
        out = self.apply("replace", pv["params"], self.targets_of(pv))
        block = self.cur(page["id"])["content"]["blocks"][0]
        self.assertEqual(block["text"], "ok x ok x")
        self.assertTrue(out["counts"]["applied"] == 1)
        self.assertEqual(block["marks"], [bold(8, 9)])

    def test_legacy_v1_page_is_replaced_by_text_and_undone_exactly(self):
        page = self.make_v1_page("a cat\nthe cat")
        # make it legacy again for the test: seed a V1 page directly
        state = self.disk()
        target = next(p for p in state["pages"] if p["id"] == page["id"])
        target["content"] = {"version": 1, "blocks": [{"id": target["content"]["blocks"][0]["id"], "type": "text", "text": "a cat\nthe cat", "marks": []}]}
        self.seed(state)
        pv = self.preview("replace", {"find": "cat", "replace": "dog"}, [page["id"]])
        out = self.apply("replace", pv["params"], self.targets_of(pv))
        self.assertEqual(self.texts(page["id"]), ["a dog", "the dog"])
        self.undo(out["event_id"])
        self.assertEqual(self.texts(page["id"]), ["a cat", "the cat"])

    def test_no_change_replace_is_skipped_not_applied(self):
        page = self.make_page([para("same")])
        pv = self.preview("replace", {"find": "same", "replace": "same"}, [page["id"]])
        self.assertEqual(pv["count"], 0)
        self.assertEqual(pv["targets"][0]["status"], "skipped")

    def test_validation(self):
        page = self.make_page([para("x")])
        for params in ({}, {"find": ""}, {"find": "a\nb"}, {"find": "x" * 201}, {"find": "x", "replace": "y\n"}, {"find": "x", "case_sensitive": "yes"}, {"find": "x", "junk": 1}, {"find": 5}):
            status, _ = hq_carnet.http_post({"action": "bulk_preview", "op": "replace", "params": params, "page_ids": [page["id"]]})
            self.assertEqual(status, 400, params)
        for ids in ([], ["page-" + "a" * 70], ["nope"], [page["id"], page["id"]], list(f"page-{i}" for i in range(65))):
            status, _ = hq_carnet.http_post({"action": "bulk_preview", "op": "replace", "params": {"find": "x"}, "page_ids": ids})
            self.assertEqual(status, 400, ids)
        self.assertEqual(hq_carnet.http_post({"action": "bulk_preview", "op": "nope", "params": {}, "page_ids": [page["id"]]})[0], 400)
        self.assertEqual(hq_carnet.http_post({"action": "bulk_preview", "op": "replace", "params": {"find": "x"}})[0], 400, "scope required")


class BulkConfirmAndConcurrencyTests(Stage08Base):
    def setup_two(self):
        a = self.make_page([para("foo one")])
        b = self.make_page([para("foo two")])
        pv = self.preview("replace", {"find": "foo", "replace": "bar"}, [a["id"], b["id"]])
        return a, b, pv

    def test_confirm_and_expected_count_are_required(self):
        a, b, pv = self.setup_two()
        base = {"action": "bulk_apply", "plan": pv["plan"], "op": "replace", "params": pv["params"], "targets": self.targets_of(pv), "request_id": "rq-confirm-01"}
        self.assertEqual(hq_carnet.http_post({**base, "expected_count": 2})[0], 400, "no confirm")
        self.assertEqual(hq_carnet.http_post({**base, "confirm": False, "expected_count": 2})[0], 400)
        self.assertEqual(hq_carnet.http_post({**base, "confirm": True})[0], 400, "no expected_count")
        self.assertEqual(self.texts(a["id"]), ["foo one"])
        status, out = hq_carnet.http_post({**base, "confirm": True, "expected_count": 1})
        self.assertEqual((status, out["code"]), (409, "plan_mismatch"), "the count must equal the previewed set minus declared skips")
        self.assertEqual(self.texts(a["id"]), ["foo one"])
        self.assertEqual(self.texts(b["id"]), ["foo two"])
        self.assertFalse(self.history_path.exists())

    def test_one_target_edited_after_preview_is_conflicted_and_untouched(self):
        a, b, pv = self.setup_two()
        hq_carnet.mutate({"action": "page_save", "id": b["id"], "expected_rev": b["rev"], "content": {"version": 2, "blocks": [{**b["content"]["blocks"][0], "text": "foo edited elsewhere"}]}})
        out = self.apply("replace", pv["params"], self.targets_of(pv), expected=2)
        self.assertEqual(out["outcome"], "partial")
        self.assertFalse(out["ok"])
        status = {t["id"]: t for t in out["targets"]}
        self.assertEqual(status[a["id"]]["status"], "applied")
        self.assertEqual(status[b["id"]]["status"], "conflicted")
        self.assertEqual(self.texts(b["id"]), ["foo edited elsewhere"], "newer work is never overwritten")
        self.assertEqual(self.texts(a["id"]), ["bar one"])
        counts = history.get_event(out["event_id"])["data"]["counts"]
        self.assertEqual(counts, {"applied": 1, "skipped": 0, "conflicted": 1, "failed": 0})

    def test_every_target_stale_is_a_409_with_per_target_detail_and_no_event(self):
        a, b, pv = self.setup_two()
        for page in (a, b):
            hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [{**page["content"]["blocks"][0], "text": "foo new"}]}})
        before = self.path.read_bytes()
        status, out = hq_carnet.http_post({"action": "bulk_apply", "plan": pv["plan"], "op": "replace", "params": pv["params"], "targets": self.targets_of(pv), "confirm": True, "expected_count": 2, "request_id": "rq-stale-0001"})
        self.assertEqual((status, out["code"]), (409, "bulk_none_applied"))
        self.assertEqual({t["status"] for t in out["targets"]}, {"conflicted"})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual([e for e in self.events() if e["kind"] == "bulk"], [])

    def test_duplicate_request_id_returns_the_first_result_without_a_second_apply(self):
        a, b, pv = self.setup_two()
        data = {"action": "bulk_apply", "plan": pv["plan"], "op": "replace", "params": pv["params"], "targets": self.targets_of(pv), "confirm": True, "expected_count": 2, "request_id": "rq-dup-000001"}
        first = hq_carnet.http_post(data)[1]
        second = hq_carnet.http_post(data)[1]
        self.assertEqual(second["event_id"], first["event_id"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(len([e for e in self.events() if e["kind"] == "bulk"]), 1)
        self.assertEqual(self.cur(a["id"])["rev"], a["rev"] + 1)

    def test_client_skipped_drafts_are_reported_and_never_touched(self):
        a, b, pv = self.setup_two()
        out = self.apply("replace", pv["params"], [{"id": a["id"], "rev": a["rev"]}], expected=1, client_skipped=[b["id"]])
        self.assertEqual(out["outcome"], "partial")
        row = next(t for t in out["targets"] if t["id"] == b["id"])
        self.assertEqual(row["status"], "skipped")
        self.assertIn("Brouillon", row["reason"])
        self.assertEqual(self.texts(b["id"]), ["foo two"])

    def test_history_unavailable_refuses_the_whole_operation(self):
        a, b, pv = self.setup_two()
        self.history_path.parent.mkdir(parents=True, exist_ok=True)
        self.history_path.write_bytes(b"{broken")
        before = self.path.read_bytes()
        status, out = hq_carnet.http_post({"action": "bulk_apply", "plan": pv["plan"], "op": "replace", "params": pv["params"], "targets": self.targets_of(pv), "confirm": True, "expected_count": 2, "request_id": "rq-nohist-001"})
        self.assertEqual((status, out["code"]), (503, "history_unavailable"))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.history_path.read_bytes(), b"{broken")

    def test_a_concurrent_save_waits_for_the_bulk_commit(self):
        a, b, pv = self.setup_two()
        seen = {}
        done = threading.Event()
        real = history.append

        def slow_append(*args, **kwargs):
            def save():
                try:
                    hq_carnet.mutate({"action": "page_save", "id": b["id"], "expected_rev": b["rev"], "content": {"version": 2, "blocks": [{**b["content"]["blocks"][0], "text": "foo racing"}]}})
                except Exception as e:  # stale after the bulk bumped it, or applied after: never in between
                    seen["err"] = e
                finally:
                    done.set()
            t = threading.Thread(target=save)
            t.start()
            seen["thread"] = t
            time.sleep(0.3)
            seen["blocked"] = not done.is_set()
            return real(*args, **kwargs)

        history.append = slow_append
        self.addCleanup(setattr, history, "append", real)
        out = self.apply("replace", pv["params"], self.targets_of(pv), expected=2)
        history.append = real
        seen["thread"].join(5)
        self.assertTrue(seen["blocked"], "the notebook lock is held from validation to the committed write")
        self.assertEqual(out["counts"]["applied"], 2)
        self.assertIn("err", seen, "the racing save started from the pre-bulk revision: it is refused, not merged")
        self.assertEqual(self.texts(b["id"]), ["bar two"])

    def test_notebook_write_failure_marks_the_event_failed_and_leaves_the_notebook(self):
        a, b, pv = self.setup_two()
        before = self.path.read_bytes()
        real = hq_carnet._write

        def boom(state):
            raise hq_carnet.CarnetStorageError("disk", 503)

        hq_carnet._write = boom
        self.addCleanup(setattr, hq_carnet, "_write", real)
        with self.assertRaises(hq_carnet.CarnetStorageError):
            self.apply("replace", pv["params"], self.targets_of(pv), expected=2)
        hq_carnet._write = real
        self.assertEqual(self.path.read_bytes(), before)
        rows = [e for e in self.events() if e["kind"] == "bulk"]
        self.assertEqual([r["status"] for r in rows], ["failed"])
        self.assertFalse(rows[0]["undoable"])


class BulkUndoTests(Stage08Base):
    def test_undo_restores_the_exact_state_and_is_one_event(self):
        a = self.make_page([para("cat dog cat", [bold(4, 7)]), para("x cat")])
        b = self.make_page([para("cat")])
        snap_a, snap_b = copy.deepcopy(self.cur(a["id"])["content"]), copy.deepcopy(self.cur(b["id"])["content"])
        pv = self.preview("replace", {"find": "cat", "replace": "elephant"}, [a["id"], b["id"]])
        applied = self.apply("replace", pv["params"], self.targets_of(pv), expected=2)
        self.assertNotEqual(self.cur(a["id"])["content"], snap_a)
        out = self.undo(applied["event_id"])
        self.assertTrue(out["ok"])
        self.assertEqual(out["counts"]["applied"], 2)
        self.assertEqual(self.cur(a["id"])["content"], snap_a, "content identical to before the bulk operation")
        self.assertEqual(self.cur(b["id"])["content"], snap_b)
        self.assertGreater(self.cur(a["id"])["rev"], a["rev"] + 1, "undo is a new revision")
        kinds = [e["kind"] for e in self.events()]
        self.assertEqual(kinds.count("bulk"), 1)
        self.assertEqual(kinds.count("undo"), 1)
        bulk_row = next(e for e in self.events() if e["kind"] == "bulk")
        self.assertIsNotNone(bulk_row["undone"])
        self.assertFalse(bulk_row["undoable"])
        # once only, no redo
        status, body = hq_carnet.http_post({"action": "bulk_undo", "event_id": applied["event_id"], "confirm": True})
        self.assertEqual((status, body["code"]), (409, "already_undone"))

    def test_undo_never_overwrites_newer_work_and_reports_partial(self):
        a = self.make_page([para("cat one")])
        b = self.make_page([para("cat two")])
        pv = self.preview("replace", {"find": "cat", "replace": "dog"}, [a["id"], b["id"]])
        applied = self.apply("replace", pv["params"], self.targets_of(pv), expected=2)
        page_b = self.cur(b["id"])
        hq_carnet.mutate({"action": "page_save", "id": b["id"], "expected_rev": page_b["rev"], "content": {"version": 2, "blocks": [{**page_b["content"]["blocks"][0], "text": "dog two, edited later"}]}})
        out = self.undo(applied["event_id"])
        self.assertEqual(out["outcome"], "partial")
        self.assertFalse(out["ok"])
        status = {t["id"]: t["status"] for t in out["targets"]}
        self.assertEqual(status, {a["id"]: "applied", b["id"]: "conflicted"})
        self.assertEqual(self.texts(a["id"]), ["cat one"])
        self.assertEqual(self.texts(b["id"]), ["dog two, edited later"], "newer work kept")
        undo_event = next(e for e in self.events() if e["kind"] == "undo")
        self.assertEqual(undo_event["counts"], {"applied": 1, "skipped": 0, "conflicted": 1, "failed": 0})

    def test_undo_with_every_target_changed_is_a_409_and_changes_nothing(self):
        a = self.make_page([para("cat")])
        pv = self.preview("replace", {"find": "cat", "replace": "dog"}, [a["id"]])
        applied = self.apply("replace", pv["params"], self.targets_of(pv))
        cur = self.cur(a["id"])
        hq_carnet.mutate({"action": "page_save", "id": a["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [{**cur["content"]["blocks"][0], "text": "new"}]}})
        before = self.path.read_bytes()
        status, out = hq_carnet.http_post({"action": "bulk_undo", "event_id": applied["event_id"], "confirm": True})
        self.assertEqual((status, out["code"]), (409, "bulk_none_applied"))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual([e for e in self.events() if e["kind"] == "undo"], [])
        # the operation stays undoable-looking but nothing is silently changed; the user sees the conflict
        self.assertEqual(out["targets"][0]["status"], "conflicted")

    def test_undo_window_and_validation(self):
        page = self.make_page([para("a")])
        ids = []
        for i in range(history.UNDO_WINDOW + 2):
            word_from, word_to = ("a" * (i + 1), "a" * (i + 2))
            cur = self.cur(page["id"])
            hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": [{**cur["content"]["blocks"][0], "text": word_from}]}})
            pv = self.preview("replace", {"find": word_from, "replace": word_to, "case_sensitive": True}, [page["id"]])
            ids.append(self.apply("replace", pv["params"], self.targets_of(pv))["event_id"])
        status, out = hq_carnet.http_post({"action": "bulk_undo", "event_id": ids[0], "confirm": True})
        self.assertEqual(status, 400, "older than the undo window")
        self.assertEqual(hq_carnet.http_post({"action": "bulk_undo", "event_id": ids[-1]})[0], 400, "confirmation required")
        self.assertEqual(hq_carnet.http_post({"action": "bulk_undo", "event_id": "x", "confirm": True})[0], 400)
        self.assertEqual(hq_carnet.http_post({"action": "bulk_undo", "event_id": "hev-" + "1" * 24, "confirm": True})[0], 404)
        rows = {e["id"]: e for e in self.events()}
        self.assertTrue(rows[ids[-1]]["undoable"])
        self.assertFalse(rows[ids[0]]["undoable"])

    def test_only_applied_bulk_events_can_be_undone(self):
        page = self.make_page([para("a b")])
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})[1]["event_id"]
        self.assertEqual(hq_carnet.http_post({"action": "bulk_undo", "event_id": cp, "confirm": True})[0], 400)


class BulkContextAndTrashTests(Stage08Base):
    def setUp(self):
        super().setUp()
        nb = hq_carnet.get_notebook()
        self.proj = hq_carnet.mutate({"action": "project_create", "expected_notebook_rev": nb["notebook_rev"], "name": "Bancs"})["project"]
        nb = hq_carnet.get_notebook()
        self.cat = hq_carnet.mutate({"action": "category_create", "expected_notebook_rev": nb["notebook_rev"], "name": "Essais", "color": "blue"})["category"]

    def test_context_move_apply_and_undo(self):
        a, b = self.make_page([para("a")]), self.make_page([para("b")], project_id=self.proj["id"])
        pv = self.preview("context_move", {"project_id": self.proj["id"], "category_id": self.cat["id"]}, [a["id"], b["id"]])
        self.assertEqual(pv["count"], 2)
        out = self.apply("context_move", pv["params"], self.targets_of(pv), expected=2)
        self.assertEqual(out["outcome"], "complete")
        self.assertTrue(out["ok"])
        for p in (a, b):
            self.assertEqual((self.cur(p["id"])["project_id"], self.cur(p["id"])["category_id"]), (self.proj["id"], self.cat["id"]))
        self.undo(out["event_id"])
        self.assertEqual((self.cur(a["id"])["project_id"], self.cur(a["id"])["category_id"]), (None, None))
        self.assertEqual((self.cur(b["id"])["project_id"], self.cur(b["id"])["category_id"]), (self.proj["id"], None))

    def test_context_move_validation_and_noop(self):
        a = self.make_page([para("a")], project_id=self.proj["id"])
        pv = self.preview("context_move", {"project_id": self.proj["id"]}, [a["id"]])
        self.assertEqual(pv["targets"][0]["status"], "skipped")
        for params in ({}, {"project_id": "nope"}, {"category_id": 5}, {"extra": 1}):
            self.assertEqual(hq_carnet.http_post({"action": "bulk_preview", "op": "context_move", "params": params, "page_ids": [a["id"]]})[0], 400, params)
        pv = self.preview("context_move", {"project_id": "proj-missing"}, [a["id"]])
        self.assertEqual(pv["targets"][0]["status"], "failed", "the dry run already shows the failure")

    def test_trash_and_restore_in_bulk_keep_one_active_page(self):
        pages = [self.make_page([para(f"p{i}")]) for i in range(3)]
        active = [p["id"] for p in hq_carnet.get_notebook()["pages"] if p["deleted_at"] is None]
        pv = self.preview("trash", {"mode": "trash"}, active)
        self.assertEqual(pv["count"], len(active) - 1)
        self.assertEqual(pv["targets"][-1]["status"], "skipped")
        self.assertIn("Dernière", pv["targets"][-1]["reason"])
        will = [t for t in pv["targets"] if t["status"] == "will_apply"]
        out = self.apply("trash", pv["params"], [{"id": t["id"], "rev": t["rev"]} for t in will[:-1]], expected=pv["count"] - 1, client_skipped=[will[-1]["id"]])
        self.assertEqual(out["outcome"], "partial", "one page was deliberately skipped: no global success")
        trashed = [t["id"] for t in out["targets"] if t["status"] == "applied"]
        for ident in trashed:
            self.assertIsNotNone(self.cur(ident)["deleted_at"])
        self.assertFalse([e for e in self.events() if e["kind"] == "lifecycle"], "a bulk trash is ONE bulk event, not N lifecycle events")
        undone = self.undo(out["event_id"])
        self.assertTrue(undone["ok"])
        for ident in trashed:
            self.assertIsNone(self.cur(ident)["deleted_at"])

    def test_bulk_trash_with_a_concurrent_restore_reports_it(self):
        a = self.make_page([para("a")])
        b = self.make_page([para("b")])
        nb = hq_carnet.get_notebook()["notebook_rev"]
        hq_carnet.mutate({"action": "page_trash", "id": a["id"], "expected_rev": a["rev"], "expected_notebook_rev": nb})
        trashed_rev = self.cur(a["id"])["rev"]
        pv = self.preview("trash", {"mode": "restore"}, [a["id"]])
        self.assertEqual(pv["targets"][0]["status"], "will_apply")
        # another client restores it first
        hq_carnet.mutate({"action": "page_restore", "id": a["id"], "expected_rev": trashed_rev, "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        status, out = hq_carnet.http_post({"action": "bulk_apply", "plan": pv["plan"], "op": "trash", "params": {"mode": "restore"}, "targets": self.targets_of(pv), "confirm": True, "expected_count": 1, "request_id": "rq-trash-0001"})
        self.assertEqual((status, out["code"]), (409, "bulk_none_applied"))
        self.assertEqual(out["targets"][0]["status"], "conflicted")
        self.assertIsNone(self.cur(a["id"])["deleted_at"])

    def test_undo_of_trash_conflicts_when_the_page_was_touched_since(self):
        pages = [self.make_page([para(f"p{i}")]) for i in range(2)]
        ids = [p["id"] for p in pages]
        pv = self.preview("trash", {"mode": "trash"}, ids)
        out = self.apply("trash", pv["params"], self.targets_of(pv), expected=pv["count"])
        victim = next(t["id"] for t in out["targets"] if t["status"] == "applied")
        rev = self.cur(victim)["rev"]
        hq_carnet.mutate({"action": "page_restore", "id": victim, "expected_rev": rev, "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        status, body = hq_carnet.http_post({"action": "bulk_undo", "event_id": out["event_id"], "confirm": True})
        self.assertEqual(status, 200)
        self.assertEqual(body["outcome"], "partial")
        self.assertEqual(next(t["status"] for t in body["targets"] if t["id"] == victim), "conflicted")


# ---------------------------------------------------------------- source migration (Stage-05 "à vérifier" semantics)


class SourceMigrationTests(Stage08Base):
    def setUp(self):
        super().setUp()
        self.fam = self.family()
        self.old = self.edition(self.fam, "29e", file_ref="Inbox/a.pdf")
        self.new = self.edition(self.fam, "30e", file_ref="Inbox/b.pdf")
        sources.mutate({"action": "source_edition_calibrate", "id": self.new["id"], "expected_rev": self.new["rev"], "calibration": {"printed": 1, "pdf": 21}})
        self.new = next(e for e in sources.get_sources()["editions"] if e["id"] == self.new["id"])

    def migrate_params(self, **over):
        return {"from_edition": self.old["id"], "to_edition": self.new["id"], **over}

    def test_locator_is_never_carried_ok_false_pdf_cleared_no_calibration(self):
        kinds = ["page", "section", "clause", "chapter", "figure", "table", "custom"]
        blocks = [self.cite_block(self.old, kind=k, text=f"{k}-12", pdf=300 + i, ok=True) for i, k in enumerate(kinds)]
        page = self.make_page(blocks)
        pv = self.preview("source_migrate", self.migrate_params())
        self.assertEqual(pv["count"], 1)
        self.assertEqual(pv["targets"][0]["changes"], len(kinds))
        out = self.apply("source_migrate", pv["params"], self.targets_of(pv))
        self.assertEqual(out["outcome"], "complete")
        stored = self.cur(page["id"])["content"]["blocks"]
        for index, block in enumerate(stored):
            cite = next(m["cite"] for m in block["marks"] if m["type"] == "citation")
            kind = kinds[index]
            self.assertEqual(cite["src"], self.new["id"])
            self.assertEqual(cite["loc"], {"kind": kind, "text": ""}, "1. neither page/section/clause/chapter/figure/table/custom text is carried")
            self.assertFalse(cite["ok"], "2. ok becomes false")
            self.assertIsNone(cite["pdf"], "3. the actual PDF page is absent")
            self.assertEqual(cite["from"], {"src": self.old["id"], "loc": {"kind": kind, "text": f"{kind}-12"}, "pdf": 300 + index, "ok": True}, "old citation kept as provenance only")
            self.assertEqual(cite["snap"], bulk.edition_snapshot(self.new))
            self.assertIn("à vérifier", block["text"])
            self.assertNotIn(f"{kind}-12", block["text"], "the visible label no longer shows the old locator")
            self.assertNotIn("p. PDF", block["text"])
            self.assertNotIn("21", json.dumps(cite["pdf"]), "6. the new edition's calibration (printed 1 = pdf 21) is never applied")
        self.assertEqual(self.new["calibration"], {"printed": 1, "pdf": 21})

    def test_matches_the_stage05_todo_citation_exactly(self):
        old = self.cite(self.old, "clause", "4.2.1", 77, True)
        got = bulk.migrate_cite_todo(old, self.new)
        self.assertEqual(got, {"src": self.new["id"], "loc": {"kind": "clause", "text": ""}, "pdf": None, "ok": False,
                               "snap": {"title": "Machinery", "author": "Oberg", "edition": "30e", "year": 2012},
                               "from": {"src": self.old["id"], "loc": {"kind": "clause", "text": "4.2.1"}, "pdf": 77, "ok": True}})
        self.assertEqual(bulk.citation_label(got), "[Machinery 30e, à vérifier]")
        self.assertEqual(bulk.citation_label(old), "[Machinery 29e, art. 4.2.1]")
        self.assertEqual(bulk.citation_label({**old, "loc": {"kind": "page", "text": ""}, "pdf": 9}), "[Machinery 29e, p. PDF 9]")

    def test_undo_restores_the_exact_original_citation_payload(self):
        page = self.make_page([self.cite_block(self.old, text="417", pdf=439), para("tail"), self.cite_block(self.old, kind="section", text="3.2", before="", after="")])
        original = copy.deepcopy(self.cur(page["id"])["content"])
        pv = self.preview("source_migrate", self.migrate_params())
        out = self.apply("source_migrate", pv["params"], self.targets_of(pv))
        self.assertNotEqual(self.cur(page["id"])["content"], original)
        undone = self.undo(out["event_id"])
        self.assertTrue(undone["ok"])
        self.assertEqual(self.cur(page["id"])["content"], original, "4. byte-exact original citation payloads, labels and marks")

    def test_a_conflicted_page_is_not_mutated_while_others_migrate(self):
        a = self.make_page([self.cite_block(self.old)])
        b = self.make_page([self.cite_block(self.old, text="12")])
        pv = self.preview("source_migrate", self.migrate_params())
        self.assertEqual(pv["count"], 2)
        cur = self.cur(b["id"])
        edited = copy.deepcopy(cur["content"]["blocks"])
        edited[0]["text"] = edited[0]["text"] + "!"
        hq_carnet.mutate({"action": "page_save", "id": b["id"], "expected_rev": cur["rev"], "content": {"version": 2, "blocks": edited}})
        snapshot_b = copy.deepcopy(self.cur(b["id"]))
        out = self.apply("source_migrate", pv["params"], self.targets_of(pv), expected=2)
        by = {t["id"]: t["status"] for t in out["targets"]}
        self.assertEqual(by, {a["id"]: "applied", b["id"]: "conflicted"})
        self.assertEqual(self.cur(b["id"]), snapshot_b, "5. the conflicted page is byte-identical")
        self.assertEqual(out["outcome"], "partial")
        cite_b = next(m["cite"] for m in self.cur(b["id"])["content"]["blocks"][0]["marks"] if m["type"] == "citation")
        self.assertEqual(cite_b["src"], self.old["id"])

    def test_formatting_marks_move_with_the_new_label(self):
        page = self.make_page([self.cite_block(self.old, before="a ", after=" end", extra_marks=lambda s, e: [bold(0, 1), {"type": "italic", "start": e + 1, "end": e + 4}])])
        pv = self.preview("source_migrate", self.migrate_params())
        self.apply("source_migrate", pv["params"], self.targets_of(pv))
        block = self.cur(page["id"])["content"]["blocks"][0]
        cite_mark = next(m for m in block["marks"] if m["type"] == "citation")
        self.assertEqual(block["text"][cite_mark["start"] : cite_mark["end"]], bulk.citation_label(cite_mark["cite"]))
        italic = next(m for m in block["marks"] if m["type"] == "italic")
        self.assertEqual(block["text"][italic["start"] : italic["end"]], "end")
        self.assertEqual(next(m for m in block["marks"] if m["type"] == "bold"), bold(0, 1))

    def test_a_partially_formatted_citation_skips_the_whole_page(self):
        page = self.make_page([self.cite_block(self.old, extra_marks=lambda s, e: [bold(s + 2, e - 1)])])
        before = self.path.read_bytes()
        pv = self.preview("source_migrate", self.migrate_params())
        self.assertEqual(pv["targets"][0]["status"], "skipped")
        self.assertIn("partielle", pv["targets"][0]["reason"])
        self.assertEqual(pv["count"], 0)
        self.assertEqual(self.path.read_bytes(), before)

    def test_citations_of_other_editions_and_trashed_pages_are_left_alone(self):
        other = self.edition(self.fam, "28e")
        page = self.make_page([self.cite_block(self.old), self.cite_block(other, text="9")])
        gone = self.make_page([self.cite_block(self.old)])
        hq_carnet.mutate({"action": "page_trash", "id": gone["id"], "expected_rev": gone["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        pv = self.preview("source_migrate", self.migrate_params())
        self.assertEqual([t["id"] for t in pv["targets"]], [page["id"]], "only active pages that cite the old edition")
        self.assertEqual(pv["targets"][0]["changes"], 1)
        self.apply("source_migrate", pv["params"], self.targets_of(pv))
        blocks = self.cur(page["id"])["content"]["blocks"]
        self.assertEqual(next(m["cite"]["src"] for m in blocks[0]["marks"] if m["type"] == "citation"), self.new["id"])
        self.assertEqual(next(m["cite"]["src"] for m in blocks[1]["marks"] if m["type"] == "citation"), other["id"])

    def test_edition_rules_and_drift(self):
        self.make_page([self.cite_block(self.old)])
        other_family = self.family("Other")
        foreign = self.edition(other_family, "1e")
        for params in ({"from_edition": self.old["id"], "to_edition": self.old["id"]}, {"from_edition": self.old["id"], "to_edition": foreign["id"]}, {"from_edition": self.old["id"], "to_edition": "srce-nope"}):
            self.assertEqual(hq_carnet.http_post({"action": "bulk_preview", "op": "source_migrate", "params": params})[0], 400, params)
        sources.mutate({"action": "source_edition_archive", "id": self.new["id"], "expected_rev": self.new["rev"], "archived": True})
        self.assertEqual(hq_carnet.http_post({"action": "bulk_preview", "op": "source_migrate", "params": self.migrate_params()})[0], 400, "archived target edition")
        sources.mutate({"action": "source_edition_archive", "id": self.new["id"], "expected_rev": self.new["rev"] + 1, "archived": False})
        pv = self.preview("source_migrate", self.migrate_params())
        fresh = next(e for e in sources.get_sources()["editions"] if e["id"] == self.new["id"])
        sources.mutate({"action": "source_edition_update", "id": fresh["id"], "expected_rev": fresh["rev"], "title": "Renamed"})
        status, out = hq_carnet.http_post({"action": "bulk_apply", "plan": pv["plan"], "op": "source_migrate", "params": pv["params"], "targets": self.targets_of(pv), "confirm": True, "expected_count": 1, "request_id": "rq-drift-0001"})
        self.assertEqual((status, out["code"]), (409, "source_revision_conflict"), "the target edition changed since the preview")

    def test_preview_shows_the_old_locator_for_context_only(self):
        self.make_page([self.cite_block(self.old, text="417")])
        pv = self.preview("source_migrate", self.migrate_params())
        sample = pv["targets"][0]["samples"][0]
        self.assertIn("p. 417", sample["before"])
        self.assertNotIn("417", sample["after"])
        self.assertIn("rien n'est repris", pv["info"]["rule"].lower())

    def test_no_citation_means_no_targets(self):
        self.make_page([para("nothing cited")])
        pv = self.preview("source_migrate", self.migrate_params())
        self.assertEqual((pv["count"], pv["targets"]), (0, []))


# ---------------------------------------------------------------- linked-file replacement


class FileReplaceTests(Stage08Base):
    def setUp(self):
        super().setUp()
        self.fam = self.family()
        self.ed = self.edition(self.fam, "29e", file_ref="Inbox/a.pdf")
        sources.mutate({"action": "source_edition_calibrate", "id": self.ed["id"], "expected_rev": self.ed["rev"], "calibration": {"printed": 1, "pdf": 12}})
        self.ed = self.live()

    def live(self):
        return next(e for e in sources.get_sources()["editions"] if e["id"] == self.ed["id"])

    def params(self, ref="Inbox/b.pdf"):
        return {"edition_id": self.ed["id"], "file_ref": ref}

    def preview_plan(self, ref="Inbox/b.pdf"):
        return bulk.preview({"action": "bulk_preview", "op": "file_replace", "params": self.params(ref)}).get("plan")

    def apply_file(self, ref="Inbox/b.pdf", rev=None, ack=True, expected=1, plan="auto"):
        if plan == "auto":
            plan = self.preview_plan(ref)
        data = {"plan": plan, "action": "bulk_apply", "op": "file_replace", "params": self.params(ref), "targets": [{"id": self.ed["id"], "rev": self.live()["rev"] if rev is None else rev}], "confirm": True, "expected_count": expected, "request_id": "rq-" + os.urandom(6).hex()}
        if ack is not None:
            data["ack_calibration"] = ack
        return hq_carnet.http_post(data)

    def test_preview_prominently_reports_the_calibration(self):
        self.make_page([self.cite_block(self.ed, pdf=40), self.cite_block(self.ed, text="9")])
        pv = bulk.preview({"action": "bulk_preview", "op": "file_replace", "params": self.params()})
        self.assertTrue(pv["requires_calibration_ack"])
        self.assertEqual(pv["calibration"], {"printed": 1, "pdf": 12})
        codes = [w["code"] for w in pv["warnings"]]
        self.assertEqual(codes[0], "calibration_cleared", "the calibration warning comes first")
        self.assertIn("pdf_pages_to_recheck", codes)
        self.assertEqual(pv["stats"], {"citations": 2, "pdf_page_citations": 1})
        self.assertEqual(pv["count"], 1)
        self.assertEqual(pv["targets"][0]["samples"][0], {"before": "Inbox/a.pdf", "after": "Inbox/b.pdf"})

    def test_apply_requires_the_explicit_acknowledgement(self):
        for ack in (None, False, "yes"):
            status, out = self.apply_file(ack=ack)
            self.assertEqual(status, 400, ack)
        self.assertEqual(self.live()["file_ref"], "Inbox/a.pdf")
        self.assertEqual(self.live()["calibration"], {"printed": 1, "pdf": 12})
        self.assertFalse(self.history_path.exists())

    def test_apply_clears_the_calibration_and_undo_restores_both(self):
        notebook_before = self.path.read_bytes() if self.path.exists() else b""
        status, out = self.apply_file()
        self.assertEqual(status, 200, out)
        self.assertTrue(out["ok"])
        self.assertTrue(out["calibration_cleared"])
        live = self.live()
        self.assertEqual((live["file_ref"], live["calibration"]), ("Inbox/b.pdf", None))
        self.assertEqual(live["rev"], self.ed["rev"] + 1)
        event = history.get_event(out["event_id"])
        self.assertEqual(event["data"]["targets"][0]["before"], {"file_ref": "Inbox/a.pdf", "calibration": {"printed": 1, "pdf": 12}})
        self.assertEqual(event["status"], "applied")
        self.assertEqual(self.path.read_bytes() if self.path.exists() else b"", notebook_before, "the notebook is untouched")
        undone = self.undo(out["event_id"])
        self.assertTrue(undone["ok"])
        live = self.live()
        self.assertEqual((live["file_ref"], live["calibration"]), ("Inbox/a.pdf", {"printed": 1, "pdf": 12}), "the exact old file AND calibration are back")

    def test_citations_are_not_modified_and_no_recalibration_happens(self):
        page = self.make_page([self.cite_block(self.ed, text="9", pdf=21)])
        before = copy.deepcopy(self.cur(page["id"]))
        self.apply_file()
        self.assertEqual(self.cur(page["id"]), before)
        self.assertIsNone(self.live()["calibration"], "no automatic recalibration")

    def test_stale_source_revision_fails_closed(self):
        stale_rev = self.live()["rev"]
        plan = self.preview_plan()  # the user previewed and confirmed at this revision ...
        sources.mutate({"action": "source_edition_update", "id": self.ed["id"], "expected_rev": stale_rev, "notes": "edited elsewhere"})  # ... then it changed
        bytes_before = (self.tmp / ".hq-carnet" / "sources.json").read_bytes()
        status, out = self.apply_file(rev=stale_rev, plan=plan)
        self.assertEqual((status, out["code"]), (409, "bulk_none_applied"))
        self.assertEqual(out["targets"][0]["status"], "conflicted")
        self.assertEqual((self.tmp / ".hq-carnet" / "sources.json").read_bytes(), bytes_before)
        self.assertFalse(self.history_path.exists())

    def test_file_rules(self):
        pv = bulk.preview({"action": "bulk_preview", "op": "file_replace", "params": self.params("Inbox/missing.pdf")})
        self.assertEqual((pv["count"], pv["targets"][0]["status"]), (0, "skipped"))
        self.assertNotIn("plan", pv, "nothing to confirm: no plan")
        self.assertEqual(self.apply_file(ref="Inbox/missing.pdf")[0], 400, "no plan, no apply")
        same = bulk.preview({"action": "bulk_preview", "op": "file_replace", "params": self.params("Inbox/a.pdf")})
        self.assertEqual((same["count"], "plan" in same), (0, False), "the same file is not a replacement")
        plan = self.preview_plan("Inbox/b.pdf")
        (self.tmp / "Inbox" / "b.pdf").unlink()  # vanishes between preview and apply
        status, out = self.apply_file(ref="Inbox/b.pdf", plan=plan)
        self.assertEqual((status, out["targets"][0]["status"]), (409, "failed"))
        for ref in ("../x.pdf", "C:/x.pdf", "/etc/x.pdf", "Inbox/a.txt", "", None, "Other/a.pdf"):
            data = {"action": "bulk_preview", "op": "file_replace", "params": {"edition_id": self.ed["id"], "file_ref": ref}}
            self.assertEqual(hq_carnet.http_post(data)[0], 400, ref)
        self.assertEqual(self.live()["file_ref"], "Inbox/a.pdf")

    def test_an_edition_without_calibration_needs_no_ack(self):
        sources.mutate({"action": "source_edition_calibrate", "id": self.ed["id"], "expected_rev": self.live()["rev"], "calibration": None})
        status, out = self.apply_file(ack=None)
        self.assertEqual(status, 200, out)
        self.assertFalse(out["calibration_cleared"])

    def test_undo_conflicts_when_the_edition_changed_since(self):
        status, out = self.apply_file()
        sources.mutate({"action": "source_edition_update", "id": self.ed["id"], "expected_rev": self.live()["rev"], "notes": "later"})
        status, body = hq_carnet.http_post({"action": "bulk_undo", "event_id": out["event_id"], "confirm": True})
        self.assertEqual((status, body["code"]), (409, "bulk_none_applied"))
        self.assertEqual(self.live()["file_ref"], "Inbox/b.pdf")
        self.assertEqual(self.live()["notes"], "later")


class BulkPlanBindingTests(Stage08Base):
    """Apply must be bound to a live preview of exactly the same operation, parameters, targets and revisions."""

    def setup_pages(self):
        a = self.make_page([para("foo one")])
        b = self.make_page([para("foo two")])
        c = self.make_page([para("foo three")])
        pv = self.preview("replace", {"find": "foo", "replace": "bar"}, [a["id"], b["id"]])
        return a, b, c, pv

    def post(self, pv, **over):
        data = {"action": "bulk_apply", "op": "replace", "params": pv["params"], "targets": self.targets_of(pv), "confirm": True,
                "expected_count": 2, "request_id": "rq-" + os.urandom(6).hex(), "plan": pv["plan"]}
        data.update(over)
        return hq_carnet.http_post(data)

    def assert_untouched(self, *pages):
        for page in pages:
            self.assertEqual(self.cur(page["id"])["rev"], page["rev"])
        self.assertEqual([e for e in self.events() if e["kind"] == "bulk"], [])

    def test_preview_returns_a_plan_only_when_something_would_change(self):
        a, b, c, pv = self.setup_pages()
        self.assertRegex(pv["plan"], r"^plan-[0-9a-f]{24}$")
        none = self.preview("replace", {"find": "nomatch", "replace": "x"}, [a["id"]])
        self.assertNotIn("plan", none)

    def test_apply_without_any_preview_is_refused(self):
        a, b, c, pv = self.setup_pages()
        data = {"action": "bulk_apply", "op": "replace", "params": pv["params"], "targets": self.targets_of(pv), "confirm": True, "expected_count": 2, "request_id": "rq-noplan-0001"}
        self.assertEqual(hq_carnet.http_post(data)[0], 400, "no plan field")
        for bad in (None, 5, "", "plan-xyz", "plan-" + "0" * 24 + "0"):
            self.assertEqual(hq_carnet.http_post({**data, "plan": bad, "request_id": "rq-noplan-0002"})[0], 400, bad)
        status, out = hq_carnet.http_post({**data, "plan": "plan-" + "0" * 24, "request_id": "rq-noplan-0003"})
        self.assertEqual((status, out["code"]), (409, "plan_expired"), "well-formed but never issued")
        self.assert_untouched(a, b)
        self.assertFalse(self.history_path.exists())

    def test_different_parameters_targets_revisions_or_operation_are_refused(self):
        a, b, c, pv = self.setup_pages()
        cases = {
            "other params": dict(params={**pv["params"], "replace": "EVIL"}),
            "other op": dict(op="trash", params={"mode": "trash"}),
            "extra target": dict(targets=self.targets_of(pv) + [{"id": c["id"], "rev": c["rev"]}], expected_count=3),
            "other target": dict(targets=[{"id": c["id"], "rev": c["rev"]}], expected_count=1),
            "other revision": dict(targets=[{"id": a["id"], "rev": a["rev"] + 1}, {"id": b["id"], "rev": b["rev"]}]),
            "skipped not previewed": dict(targets=[{"id": a["id"], "rev": a["rev"]}], client_skipped=[c["id"]], expected_count=1),
            "bigger count": dict(expected_count=3),
        }
        for name, over in cases.items():
            status, out = self.post(pv, **over)
            self.assertEqual((status, out.get("code")), (409, "plan_mismatch"), name)
        self.assert_untouched(a, b, c)
        # a mismatch does not burn the plan: the exact confirmed operation still works
        status, out = self.post(pv)
        self.assertEqual(status, 200, out)
        self.assertEqual(self.texts(a["id"]), ["bar one"])
        self.assertEqual(self.texts(c["id"]), ["foo three"])

    def test_the_confirmation_must_account_for_exactly_the_previewed_set(self):
        a, b, c, pv = self.setup_pages()
        ta, tb = {"id": a["id"], "rev": a["rev"]}, {"id": b["id"], "rev": b["rev"]}
        cases = {
            "omitted target (subset)": dict(targets=[ta], expected_count=1),
            "omitted target even with a matching count": dict(targets=[tb], expected_count=1),
            "target moved to client_skipped but still submitted": dict(targets=[ta, tb], client_skipped=[b["id"]], expected_count=2),
            "changed expected count (low)": dict(expected_count=1),
            "changed expected count (high)": dict(expected_count=3),
            "skipped id not in the plan": dict(targets=[ta, tb], client_skipped=[c["id"]], expected_count=2),
            "skip that leaves an id unaccounted for": dict(targets=[ta], client_skipped=[c["id"]], expected_count=1),
        }
        for name, over in cases.items():
            status, out = self.post(pv, **over)
            self.assertIn(status, (400, 409), name)
            self.assertIn(out.get("code"), ("plan_mismatch", "validation_error"), name)
        self.assertEqual(self.post(pv, targets=[ta, ta])[0], 400, "duplicated target")
        self.assertEqual(self.post(pv, targets=[ta, tb], client_skipped=[b["id"], b["id"]], expected_count=2)[0], 400, "duplicate skip")
        self.assert_untouched(a, b, c)
        status, out = self.post(pv)  # the exact set still works: a mismatch never burns or blocks the plan
        self.assertEqual(status, 200, out)
        self.assertEqual((self.texts(a["id"]), self.texts(b["id"])), (["bar one"], ["bar two"]))

    def test_declared_skips_plus_submitted_targets_equal_the_plan(self):
        a, b, c, pv = self.setup_pages()
        status, out = self.post(pv, targets=[{"id": a["id"], "rev": a["rev"]}], client_skipped=[b["id"]], expected_count=1)
        self.assertEqual(status, 200, out)
        self.assertEqual((self.texts(a["id"]), self.texts(b["id"])), (["bar one"], ["foo two"]))
        self.assertEqual(len([e for e in self.events() if e["kind"] == "bulk"]), 1)

    def test_one_plan_cannot_be_split_into_two_concurrent_subset_applies(self):
        a, b, c, pv = self.setup_pages()
        ta, tb = {"id": a["id"], "rev": a["rev"]}, {"id": b["id"], "rev": b["rev"]}
        reached, release = threading.Event(), threading.Event()
        real = bulk._apply_pages
        first = []

        def gate(*args, **kwargs):  # the first request has validated AND reserved the plan; hold it before it writes
            if not first:
                first.append(1)
                reached.set()
                release.wait(10)
            return real(*args, **kwargs)

        bulk._apply_pages = gate
        self.addCleanup(setattr, bulk, "_apply_pages", real)
        results = {}

        def run(name, **over):
            results[name] = self.post(pv, **over)

        t1 = threading.Thread(target=run, args=("one",), kwargs=dict(targets=[ta], client_skipped=[b["id"]], expected_count=1))
        t1.start()
        self.assertTrue(reached.wait(10))
        run("two", targets=[tb], client_skipped=[a["id"]], expected_count=1)  # same token, disjoint subset, while the first is in flight
        self.assertEqual((results["two"][0], results["two"][1]["code"]), (409, "plan_in_use"))
        run("three")  # even the exact full set is refused while reserved
        self.assertEqual(results["three"][1]["code"], "plan_in_use")
        release.set()
        t1.join(10)
        bulk._apply_pages = real
        self.assertEqual(results["one"][0], 200, results["one"])
        self.assertEqual((self.texts(a["id"]), self.texts(b["id"])), (["bar one"], ["foo two"]))
        status, out = self.post(pv, targets=[tb], client_skipped=[a["id"]], expected_count=1)
        self.assertEqual((status, out["code"]), (409, "plan_expired"), "consumed by the first apply")
        self.assertEqual(len([e for e in self.events() if e["kind"] == "bulk"]), 1, "one preview -> one logical event")

    def test_a_failed_apply_releases_the_plan_for_a_retry(self):
        a, b, c, pv = self.setup_pages()
        real = bulk._apply_pages

        def boom(*args, **kwargs):
            raise hq_carnet.CarnetError("simulated refusal before any write")

        bulk._apply_pages = boom
        try:
            self.assertEqual(self.post(pv)[0], 400)
        finally:
            bulk._apply_pages = real
        self.assert_untouched(a, b, c)
        self.assertEqual(self.post(pv)[0], 200, "released, not burned, because nothing was committed")

    def test_plan_expires_and_is_consumed_after_a_successful_apply(self):
        a, b, c, pv = self.setup_pages()
        real = bulk._clock
        now = [1000.0]
        bulk._clock = lambda: now[0]
        self.addCleanup(setattr, bulk, "_clock", real)
        pv2 = self.preview("replace", {"find": "foo", "replace": "baz"}, [a["id"], b["id"]])
        now[0] += bulk.PLAN_TTL_SECONDS + 1
        status, out = self.post(pv2)
        self.assertEqual((status, out["code"]), (409, "plan_expired"))
        self.assert_untouched(a, b)
        bulk._clock = real
        self.assertEqual(self.post(pv)[0], 200)
        status, out = self.post(pv)  # same plan, fresh request id: the confirmation was used up
        self.assertEqual((status, out["code"]), (409, "plan_expired"))

    def test_the_plan_is_bound_for_every_operation(self):
        a = self.make_page([para("x")])
        nb = hq_carnet.get_notebook()
        proj = hq_carnet.mutate({"action": "project_create", "expected_notebook_rev": nb["notebook_rev"], "name": "P"})["project"]
        pv = self.preview("context_move", {"project_id": proj["id"]}, [a["id"]])
        status, out = hq_carnet.http_post({"action": "bulk_apply", "op": "context_move", "params": {"project_id": None}, "targets": self.targets_of(pv), "confirm": True, "expected_count": 1, "request_id": "rq-ctx-000001", "plan": pv["plan"]})
        self.assertEqual((status, out["code"]), (409, "plan_mismatch"))
        self.assertIsNone(self.cur(a["id"])["project_id"])


class MigrationRaceTests(Stage08Base):
    """source rev validated -> concurrent source update -> notebook migration: deterministic, not merely 'edit before apply'."""

    def test_a_concurrent_source_edit_cannot_slip_between_validation_and_the_notebook_write(self):
        fam = self.family()
        old = self.edition(fam, "29e")
        new = self.edition(fam, "30e")
        page = self.make_page([self.cite_block(old)])
        pv = self.preview("source_migrate", {"from_edition": old["id"], "to_edition": new["id"]})
        seen = {}
        real = bulk._run_pages

        def barrier(state, op, params, targets, now, ctx, skipped):
            if op == "source_migrate" and "thread" not in seen:  # the target edition was validated; the notebook is not written yet
                def edit():
                    fresh = next(e for e in sources.get_sources()["editions"] if e["id"] == new["id"])
                    sources.mutate({"action": "source_edition_update", "id": new["id"], "expected_rev": fresh["rev"], "title": "Renamed concurrently"})
                    seen["edited_at"] = time.monotonic()
                t = threading.Thread(target=edit)
                seen["thread"] = t
                t.start()
                time.sleep(0.4)
                seen["blocked"] = t.is_alive()  # the sources lock is held: the edit must be waiting
            return real(state, op, params, targets, now, ctx, skipped)

        bulk._run_pages = barrier
        self.addCleanup(setattr, bulk, "_run_pages", real)
        out = self.apply("source_migrate", pv["params"], self.targets_of(pv))
        bulk._run_pages = real
        applied_at = time.monotonic()
        seen["thread"].join(5)
        self.assertTrue(seen["blocked"], "the concurrent source edit waits for the migration commit")
        self.assertGreaterEqual(seen["edited_at"], applied_at - 0.05, "the edit lands AFTER the migration, never in the gap")
        self.assertEqual(out["outcome"], "complete")
        cite = next(m["cite"] for m in self.cur(page["id"])["content"]["blocks"][0]["marks"] if m["type"] == "citation")
        self.assertEqual(cite["snap"]["title"], "Machinery", "the snapshot is the validated revision, consistently")
        live = next(e for e in sources.get_sources()["editions"] if e["id"] == new["id"])
        self.assertEqual(live["title"], "Renamed concurrently")
        # a later migration run against the now-changed edition fails closed on the stale plan revision
        pv2 = self.preview("source_migrate", {"from_edition": old["id"], "to_edition": new["id"]})
        self.assertEqual(pv2["count"], 0, "nothing left to migrate")

    def test_a_source_edit_before_apply_still_fails_closed(self):
        fam = self.family()
        old = self.edition(fam, "29e")
        new = self.edition(fam, "30e")
        self.make_page([self.cite_block(old)])
        pv = self.preview("source_migrate", {"from_edition": old["id"], "to_edition": new["id"]})
        sources.mutate({"action": "source_edition_update", "id": new["id"], "expected_rev": new["rev"], "title": "Edited"})
        before = self.path.read_bytes()
        status, out = hq_carnet.http_post({"action": "bulk_apply", "plan": pv["plan"], "op": "source_migrate", "params": pv["params"], "targets": self.targets_of(pv), "confirm": True, "expected_count": 1, "request_id": "rq-race-000001"})
        self.assertEqual((status, out["code"]), (409, "source_revision_conflict"))
        self.assertEqual(self.path.read_bytes(), before)

    def test_lock_order_is_notebook_then_sources_and_cannot_deadlock_with_a_source_writer(self):
        fam = self.family()
        old = self.edition(fam, "29e")
        new = self.edition(fam, "30e")
        for _ in range(8):
            self.make_page([self.cite_block(old)])
        pv = self.preview("source_migrate", {"from_edition": old["id"], "to_edition": new["id"]})
        stop = threading.Event()
        errors = []

        def churn():
            while not stop.is_set():
                try:
                    fresh = next(e for e in sources.get_sources()["editions"] if e["id"] == old["id"])
                    sources.mutate({"action": "source_edition_update", "id": old["id"], "expected_rev": fresh["rev"], "notes": str(time.monotonic())})
                except Exception as e:  # pragma: no cover
                    errors.append(e)

        t = threading.Thread(target=churn)
        t.start()
        try:
            out = self.apply("source_migrate", pv["params"], self.targets_of(pv), expected=pv["count"])
        finally:
            stop.set()
            t.join(10)
        self.assertFalse(t.is_alive(), "no deadlock")
        self.assertEqual(errors, [])
        self.assertEqual(out["outcome"], "complete")


class ParityTests(unittest.TestCase):
    """The server and the browser must agree on citation labels and on the Stage-05 "à vérifier" migration (shared vectors)."""

    def test_shared_vectors_match_the_server_implementation(self):
        fx = json.loads((Path(__file__).resolve().parent / "fixtures_carnet_history.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(fx["cases"]), 16)
        for case in fx["cases"]:
            self.assertEqual(bulk.citation_label(case["old"]), case["old_label"])
            new = bulk.migrate_cite_todo(case["old"], case["edition"])
            self.assertEqual(new, case["new"])
            self.assertEqual(bulk.citation_label(new), case["new_label"])
            self.assertEqual((new["ok"], new["pdf"], new["loc"]["text"]), (False, None, ""))


class FrameworkSurfaceTests(Stage08Base):
    def test_only_the_five_operations_exist_and_share_one_flow(self):
        self.assertEqual(bulk.OPS, ("replace", "context_move", "trash", "source_migrate", "file_replace"))
        self.assertEqual(set(hq_carnet._STAGE08), {"bulk_preview", "bulk_apply", "bulk_undo", "history_checkpoint", "history_restore", "report_build", "snapshot_create", "ask", "portal_resolve", "reader_resolve", "annotation_list", "annotation_create", "annotation_update", "annotation_delete", "rcomment_list", "rcomment_add", "verification_list", "verification_get", "verification_resolve", "verification_related", "verification_create", "verification_update", "verification_evidence_add", "verification_evidence_remove", "verification_status", "verification_signoff", "verification_delete"})

    def test_modules_do_not_use_dangerous_primitives(self):
        root = Path(__file__).resolve().parents[1]
        for name in ("hq_carnet_history.py", "hq_carnet_bulk.py", "hq_carnet_restore.py", "hq_carnet_links.py", "hq_carnet_report.py"):
            text = (root / name).read_text(encoding="utf-8")
            for banned in ("eval(", "exec(", "subprocess", "os.system", "urllib", "socket", "pickle", "shlex"):
                self.assertNotIn(banned, text, f"{name}: {banned}")
            imports = {line.split()[1].split(".")[0] for line in text.splitlines() if line.startswith("import ")}
            imports |= {line.split()[1].split(".")[0] for line in text.splitlines() if line.startswith("from ") and " import " in line}
            self.assertLessEqual(imports, {"__future__", "copy", "json", "os", "re", "secrets", "time", "threading", "collections", "pathlib", "typing", "hq_state", "hq_carnet_rich", "hq_carnet_history", "hq_carnet_sources", "hq_carnet_media", "contextlib", "hq_carnet_intel", "hq_carnet_review", "hq_carnet_snapshots", "hq_carnet_ask", "hq_carnet_reviews", "hq_carnet_evidence", "hq_carnet_portals"}, name)  # + Phase 5 + Phase 6 derivation modules + the Phase 8 read-only resolver

    def test_no_new_route_was_added(self):
        src = (Path(__file__).resolve().parents[1] / "iphone_bridge.py").read_text(encoding="utf-8")
        for needle in ("/api/carnet/history", "/api/carnet/bulk", "/api/carnet/report", "/api/carnet/backlinks"):
            self.assertNotIn(needle, src)


if __name__ == "__main__":
    unittest.main()
