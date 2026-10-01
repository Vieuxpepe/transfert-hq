"""Carnet Stage 07 — engineering blocks (calc / measure / decision), task extraction, parity vectors.

Throwaway ROOTs only (run from a disposable source copy). Browser behaviour: tests/visual_carnet_eng_playwright.mjs;
the pure JS model (calculator grammar, conversions, parity with the vectors below): tests/check_hq_carnet_eng.mjs.
The vectors in tests/fixtures_carnet_eng.json are shared with the JS check: both engines must agree on every line.
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cc_ext  # noqa: E402
import hq_carnet  # noqa: E402
import hq_carnet_eng as eng  # noqa: E402
import hq_carnet_rich as rich  # noqa: E402
import test_hq_carnet as _base  # noqa: E402  (module import: its TestCase classes are NOT re-collected here)
from test_hq_carnet import CarnetBase, _fixture, _http  # noqa: E402

VECTORS = json.loads((Path(__file__).resolve().parent / "fixtures_carnet_eng.json").read_text(encoding="utf-8"))
AT = VECTORS["at"]


def para(text="x", **extra):
    return {"type": "paragraph", "text": text, "marks": [], **extra}


def calc_block(**over):
    payload = {"expr": "1 + 2", "result": "3", "unit": None, "at": AT, "v": 1}
    payload.update(over)
    return {"type": "calc", "text": "", "marks": [], "calc": payload}


def measure_block(payload=None):
    return {"type": "measure", "text": "", "marks": [], "measure": copy.deepcopy(payload or VECTORS["measure_ok"][0])}


def decision_block(text="Go", at=AT):
    return {"type": "decision", "text": text, "marks": [], "decision": {"at": at}}


def clean(kind, payload, folders=("Inbox", "Uni", "Print")):
    return rich.check_eng(kind, payload, folders)


# ---------------------------------------------------------------- payload validation (shared vectors)


class VectorTests(unittest.TestCase):
    def test_calc_accept_reject(self):
        for p in VECTORS["calc_ok"]:
            self.assertEqual(eng.check_calc(p), p)
        for case in VECTORS["calc_bad"]:
            with self.assertRaises(eng.EngError, msg=case["label"]):
                eng.check_calc(case["payload"])

    def test_measure_accept_reject(self):
        for p in VECTORS["measure_ok"]:
            self.assertEqual(clean("measure", p), p)
        for case in VECTORS["measure_bad"]:
            with self.assertRaises(rich.ContentError, msg=case["label"]):
                clean("measure", case["payload"])
        for case in VECTORS["measure_bad_link"]:
            with self.assertRaises(rich.ContentError, msg=case["label"]):
                clean("measure", case["payload"])

    def test_integral_floats_are_not_integers(self):
        # JSON "1.0" is a float for the server (JavaScript cannot tell it from 1): refused for v and at
        for over in ({"v": 1.0}, {"at": float(AT)}):
            with self.assertRaises(eng.EngError):
                eng.check_calc({**VECTORS["calc_ok"][0], **over})
        with self.assertRaises(eng.EngError):
            eng.check_decision({"at": float(AT)})

    def test_decision_accept_reject(self):
        for p in VECTORS["decision_ok"]:
            self.assertEqual(eng.check_decision(p), p)
        for p in VECTORS["decision_bad"]:
            with self.assertRaises(eng.EngError, msg=repr(p)):
                eng.check_decision(p)

    def test_evaluate_vectors(self):
        for case in VECTORS["evaluate"]:
            got = eng.evaluate(case["measure"])
            self.assertEqual(got, case["expect"], case["label"])

    def test_describe_vectors(self):
        for case in VECTORS["describe"]:
            p = case["payload"]
            text = eng.describe_calc(p) if case["kind"] == "calc" else eng.describe_measure(p) if case["kind"] == "measure" else eng.decision_label(p)
            self.assertEqual(text, case["text"])

    def test_no_float_anywhere_in_the_verdict(self):
        src = Path(eng.__file__).read_text(encoding="utf-8")
        body = src[src.index("def evaluate") : src.index("STATUS_TEXT")]
        self.assertNotIn("float(", body)
        self.assertNotIn("Decimal", body)

    def test_tolerance_semantics_are_documented_units(self):
        # nominal 10 mm +/- 0.02 mm: observed 10.02 inside, 10.020001 outside (exact decimal, inclusive bounds)
        m = copy.deepcopy(VECTORS["measure_ok"][0])
        self.assertEqual(eng.evaluate(m)["status"], "in")
        m["observed"]["v"] = "10.020001"
        self.assertEqual(eng.evaluate(m)["status"], "out")


# ---------------------------------------------------------------- content model (parse / store / strip / valid / export)


def parse(blocks, existing=None):
    return rich.parse_content({"version": 2, "blocks": blocks}, existing=existing, folders=("Inbox", "Uni", "Print"), text_limit=48 * 1024)


class ContentTests(unittest.TestCase):
    def test_round_trip_keeps_payloads_exactly(self):
        blocks = [para("a"), calc_block(unit="mm"), measure_block(), decision_block("Choisir 316L"), para("fin")]
        parsed = parse(blocks)
        stored = rich.store_content(parsed, {"version": 2, "blocks": []})
        self.assertTrue(rich.valid_v2(stored))
        types = [b["type"] for b in stored["blocks"]]
        self.assertEqual(types, ["paragraph", "calc", "measure", "decision", "paragraph"])
        self.assertEqual(stored["blocks"][1]["calc"]["unit"], "mm")
        self.assertEqual(stored["blocks"][2]["measure"], VECTORS["measure_ok"][0])
        self.assertEqual(stored["blocks"][3]["decision"], {"at": AT})
        self.assertEqual(stored["blocks"][3]["text"], "Choisir 316L")
        for b in stored["blocks"]:
            self.assertTrue(rich.is_block_id(b["id"]) if hasattr(rich, "is_block_id") else b["id"].startswith("block-"))

    def test_store_does_not_alias_the_input(self):
        src = [calc_block(), para("x")]
        parsed = parse(src)
        stored = rich.store_content(parsed, {"version": 2, "blocks": []})
        stored["blocks"][0]["calc"]["result"] = "999"
        self.assertEqual(parsed["blocks"][0]["calc"]["result"], "3")

    def test_atoms_reject_text_and_marks(self):
        bad = calc_block()
        bad["text"] = "x"
        with self.assertRaises(rich.ContentError):
            parse([bad])
        bad = measure_block()
        bad["marks"] = [{"type": "bold", "start": 0, "end": 0}]
        with self.assertRaises(rich.ContentError):
            parse([bad])

    def test_payload_key_must_match_type(self):
        wrong = {"type": "calc", "text": "", "marks": [], "measure": VECTORS["measure_ok"][0]}
        with self.assertRaises(rich.ContentError):
            parse([wrong])
        stray = para("x", calc=VECTORS["calc_ok"][0])
        with self.assertRaises(rich.ContentError):
            parse([stray])
        both = calc_block()
        both["decision"] = {"at": AT}
        with self.assertRaises(rich.ContentError):
            parse([both])
        missing = {"type": "calc", "text": "", "marks": []}
        with self.assertRaises(rich.ContentError):
            parse([missing])

    def test_unknown_payload_keys_rejected(self):
        b = calc_block()
        b["calc"]["extra"] = 1
        with self.assertRaises(rich.ContentError):
            parse([b])
        d = decision_block()
        d["decision"]["note"] = "x"
        with self.assertRaises(rich.ContentError):
            parse([d])

    def test_caps_per_page(self):
        ok = [calc_block() for _ in range(rich.ENG_ATOMS_PER_PAGE_MAX)]
        parse(ok)
        with self.assertRaises(rich.ContentError):
            parse(ok + [measure_block()])
        decisions = [decision_block(f"d{i}") for i in range(rich.DECISIONS_PER_PAGE_MAX)]
        parse(decisions)
        with self.assertRaises(rich.ContentError):
            parse(decisions + [decision_block("one more")])

    def test_decision_text_is_one_safe_line(self):
        for bad in ("a\nb", "a\u0000b"):  # same one-line text rules as any paragraph
            with self.assertRaises(rich.ContentError):
                parse([decision_block(bad)])
        parse([decision_block("")])  # an empty decision line is still a valid text block (status only)

    def test_decision_rules_for_marks(self):
        d = decision_block("Go tout de suite")
        d["marks"] = [{"type": "bold", "start": 0, "end": 2}]
        parsed = parse([d])
        self.assertEqual(parsed["blocks"][0]["marks"][0]["type"], "bold")

    def test_strip_ids_rows_carry_the_payload(self):
        stored = rich.store_content(parse([para("a"), calc_block(), decision_block("Go")]), {"version": 2, "blocks": []})
        rows = rich.strip_ids(stored)
        self.assertEqual(len(rows), 3)
        self.assertNotIn("id", json.dumps(rows))
        self.assertEqual(rows[1][0], "calc")
        self.assertEqual(json.loads(rows[1][4]), calc_block()["calc"])  # canonical JSON row: the payload is part of the content identity

    def test_valid_v2_rejects_malformed_persisted_payloads(self):
        stored = rich.store_content(parse([calc_block(), measure_block(), decision_block("Go")]), {"version": 2, "blocks": []})
        self.assertTrue(rich.valid_v2(stored))
        for mutate in (
            lambda c: c["blocks"][0]["calc"].update(result="three"),
            lambda c: c["blocks"][0]["calc"].update(extra=1),
            lambda c: c["blocks"][1]["measure"].update(mode="??"),
            lambda c: c["blocks"][1]["measure"]["observed"].update(v="1e3"),
            lambda c: c["blocks"][2]["decision"].update(at=True),
            lambda c: c["blocks"][0].update(text="x"),
        ):
            broken = copy.deepcopy(stored)
            mutate(broken)
            self.assertFalse(rich.valid_v2(broken))

    def test_title_and_preview_ignore_atoms(self):
        stored = rich.store_content(parse([calc_block(), measure_block(), decision_block("Choisir 316L"), para("suite")]), {"version": 2, "blocks": []})
        flat = rich.flat_text(stored)
        self.assertEqual(hq_carnet.derive_title(flat), "Choisir 316L")
        only_atoms = rich.store_content(parse([calc_block()]), {"version": 2, "blocks": []})
        self.assertEqual(hq_carnet.derive_title(rich.flat_text(only_atoms)), hq_carnet.UNTITLED)

    def test_link_exports_carry_no_path_or_url(self):
        block = para("projet fichier", marks=[
            {"type": "link", "start": 0, "end": 6, "ref": {"kind": "project", "id": "proj-abc"}},
            {"type": "link", "start": 7, "end": 14, "ref": {"kind": "file", "id": "Inbox/sub/plan.pdf"}},
        ])
        stored = rich.store_content(parse([block]), {"version": 2, "blocks": []})
        for out in (rich.render_txt(stored), rich.render_markdown(stored)):
            self.assertEqual(out, "projet fichier\n")

    def test_project_ref_kind(self):
        ok = rich.check_ref({"kind": "project", "id": "proj-abc123"}, ("Inbox",))
        self.assertEqual(ok, {"kind": "project", "id": "proj-abc123"})
        for bad in ("proj-", "proj-../x", "page-a", "proj-" + "a" * 65, "Proj-abc"):
            with self.assertRaises(rich.ContentError, msg=bad):
                rich.check_ref({"kind": "project", "id": bad}, ("Inbox",))

    def test_exports_are_deterministic_utc(self):
        stored = rich.store_content(parse([para("avant"), calc_block(unit="mm", result="612.5", expr="12.5*(3+4)^2"), measure_block(), decision_block("Go")]), {"version": 2, "blocks": []})
        txt = rich.render_txt(stored)
        self.assertIn("[Calcul : 12.5*(3+4)^2 = 612.5 mm — 2026-09-21 14:13 UTC]", txt)
        self.assertIn("non certifié", txt)
        self.assertIn("DÉCISION · 2026-09-21 14:13 UTC — Go", txt)
        md = rich.render_markdown(stored)
        self.assertIn("**DÉCISION · 2026-09-21 14:13 UTC** — Go", md)
        self.assertEqual(rich.render_txt(stored), txt)
        for marker in ("<script", "javascript:"):
            self.assertNotIn(marker, md)


# ---------------------------------------------------------------- persistence through the real mutate path


class PersistTests(CarnetBase):
    def new_page(self):
        nb = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        return nb["page"]

    def save(self, page, blocks):
        return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": blocks}})["page"]

    def test_save_load_round_trip_and_ids_stay_stable(self):
        page = self.new_page()
        saved = self.save(page, [para("a"), calc_block(), measure_block(), decision_block("Go")])
        ids = [b["id"] for b in saved["content"]["blocks"]]
        self.assertEqual(len(set(ids)), 4)
        again = self.save(saved, saved["content"]["blocks"])
        self.assertEqual([b["id"] for b in again["content"]["blocks"]], ids)
        disk = self.page(page["id"])["content"]["blocks"]
        self.assertEqual(disk[1]["calc"], calc_block()["calc"])
        self.assertEqual(disk[2]["measure"], VECTORS["measure_ok"][0])

    def test_invalid_payload_is_refused_and_nothing_is_written(self):
        page = self.new_page()
        before = self.path.read_bytes()
        with self.assertRaises(hq_carnet.CarnetError):
            self.save(page, [calc_block(result="NaN")])
        with self.assertRaises(hq_carnet.CarnetError):
            self.save(page, [measure_block({**VECTORS["measure_ok"][0], "verdict": "in"})])
        self.assertEqual(self.path.read_bytes(), before)

    def test_verdict_is_never_stored(self):
        page = self.new_page()
        self.save(page, [measure_block()])
        stored = self.page(page["id"])["content"]["blocks"][0]
        self.assertEqual(sorted(stored), ["id", "marks", "measure", "text", "type"])
        self.assertEqual(sorted(stored["measure"]), ["at", "label", "link", "mode", "nominal", "observed", "tol"])
        self.assertNotIn("status", json.dumps(stored))
        self.assertNotIn("deviation", json.dumps(stored))

    def test_malformed_persisted_payload_is_preserved_byte_for_byte(self):
        page = self.new_page()
        saved = self.save(page, [calc_block()])
        state = self.disk()
        state["pages"][-1]["content"]["blocks"][0]["calc"]["result"] = "not-a-number"
        raw = json.dumps(state, ensure_ascii=False).encode("utf-8")
        self.path.write_bytes(raw)
        with self.assertRaises((hq_carnet.CarnetStorageError, hq_carnet.CarnetError)):
            hq_carnet.get_notebook()
            hq_carnet.mutate({"action": "page_save", "id": saved["id"], "expected_rev": saved["rev"], "content": {"version": 2, "blocks": [para("x")]}})
        self.assertEqual(self.path.read_bytes(), raw)

    def test_limits_expose_stage07_caps(self):
        lim = hq_carnet.limits()
        self.assertEqual(lim["eng_atoms_per_page"], rich.ENG_ATOMS_PER_PAGE_MAX)
        self.assertEqual(lim["decisions_per_page"], rich.DECISIONS_PER_PAGE_MAX)
        self.assertEqual(lim["task_title_chars"], hq_carnet.TASK_TITLE_MAX)

    def test_conflict_on_stale_revision_keeps_both_versions(self):
        page = self.new_page()
        first = self.save(page, [calc_block()])
        with self.assertRaises(hq_carnet.CarnetConflict):
            hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [para("late")]}})
        self.assertEqual(self.page(page["id"])["content"]["blocks"][0]["type"], "calc")
        self.assertEqual(first["rev"], self.page(page["id"])["rev"])


# ---------------------------------------------------------------- task extraction (existing Kanban system)


class TaskBase(CarnetBase):
    def setUp(self):
        super().setUp()
        self.saved_root = cc_ext.ROOT
        self.addCleanup(lambda: setattr(cc_ext, "ROOT", self.saved_root))
        cc_ext.ROOT = self.tmp
        self.addCleanup(hq_carnet._task_seen.clear)
        hq_carnet._task_seen.clear()
        hq_carnet.bind(root=self.tmp, now=lambda: self.clock[0], task_add=cc_ext.kanban_add, task_path=cc_ext.kanban_path)
        nb = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        page = nb["page"]
        self.page0 = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [para("Commander les joints 😀 toriques"), para("deuxième ligne")]}})["page"]
        self.block = self.page0["content"]["blocks"][0]["id"]
        self.kanban = self.tmp / "kanban.json"

    def req(self, **over):
        data = {
            "action": "task_extract", "page_id": self.page0["id"], "expected_rev": self.page0["rev"], "block_id": self.block,
            "start": 0, "end": 9, "text": "Commander", "title": "Commander joints", "request_id": "tk-" + "a" * 16,
        }
        data.update(over)
        return data

    def cards(self):
        if not self.kanban.exists():
            return []
        return next(c for c in json.loads(self.kanban.read_text(encoding="utf-8"))["columns"] if c["id"] == "todo")["cards"]


class TaskExtractTests(TaskBase):
    def test_creates_one_card_in_todo_and_never_touches_the_note(self):
        before = self.path.read_bytes()
        status, out = hq_carnet.http_post(self.req())
        self.assertEqual(status, 200)
        self.assertEqual(out["task"]["title"], "Commander joints")
        self.assertEqual(out["task"]["column"], "todo")
        self.assertFalse(out["duplicate"])
        self.assertEqual([c["title"] for c in self.cards()], ["Commander joints"])
        self.assertEqual(self.path.read_bytes(), before, "the notebook is never written by task extraction")
        self.assertNotIn(self.page0["id"], self.kanban.read_text(encoding="utf-8"), "no backlink (the board has no such field)")

    def test_double_submit_with_the_same_request_id_creates_one_card(self):
        a = hq_carnet.http_post(self.req())[1]
        status, b = hq_carnet.http_post(self.req())
        self.assertEqual(status, 200)
        self.assertTrue(b["duplicate"])
        self.assertEqual(a["task"]["id"], b["task"]["id"])
        self.assertEqual(len(self.cards()), 1)

    def test_concurrent_double_submit_creates_one_card(self):
        results = []
        barrier = threading.Barrier(6)

        def go():
            barrier.wait()
            results.append(hq_carnet.http_post(self.req())[0])

        threads = [threading.Thread(target=go) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results, [200] * 6)
        self.assertEqual(len(self.cards()), 1)

    def test_distinct_request_ids_create_distinct_cards(self):
        hq_carnet.http_post(self.req())
        hq_carnet.http_post(self.req(request_id="tk-" + "b" * 16, title="Autre"))
        self.assertEqual(len(self.cards()), 2)

    def test_utf16_range_and_astral_text(self):
        start = len("Commander les joints ".encode("utf-16-le")) // 2
        status, out = hq_carnet.http_post(self.req(start=start, end=start + 2, text="😀", title="emoji"))
        self.assertEqual(status, 200)
        # range cutting the surrogate pair, or text mismatch: refused
        status, out = hq_carnet.http_post(self.req(start=start, end=start + 1, text="\ud83d", title="cut", request_id="tk-" + "c" * 16))
        self.assertIn(status, (400, 409))
        self.assertEqual(len(self.cards()), 1)

    def test_stale_text_range_page_block_and_revision_fail_closed(self):
        cases = [
            ({"text": "Commandé"}, 409),
            ({"start": 1, "end": 10}, 409),
            ({"block_id": self.page0["content"]["blocks"][1]["id"]}, 409),
            ({"expected_rev": self.page0["rev"] + 1}, 409),
            ({"end": 500, "text": "Commander"}, 409),
            ({"page_id": "page-nope"}, 404),
            ({"block_id": "block-" + "0" * 24}, 409),
        ]
        for i, (over, want) in enumerate(cases):
            status, out = hq_carnet.http_post(self.req(request_id=f"tk-stale{i:03d}", **over))
            self.assertEqual(status, want, (over, out))
        self.assertEqual(self.cards(), [])
        stale = hq_carnet.http_post(self.req(text="nope", request_id="tk-stale-x"))[1]
        self.assertEqual(stale["code"], "stale_selection")

    def test_edited_note_makes_the_request_stale(self):
        hq_carnet.mutate({"action": "page_save", "id": self.page0["id"], "expected_rev": self.page0["rev"], "content": {"version": 2, "blocks": [{**para("Modifié"), "id": self.block}, para("deuxième ligne")]}})
        status, out = hq_carnet.http_post(self.req())
        self.assertEqual(status, 409)
        self.assertEqual(self.cards(), [])

    def test_trashed_page_refused(self):
        nb = hq_carnet.get_notebook()["notebook_rev"]
        hq_carnet.mutate({"action": "page_trash", "id": self.page0["id"], "expected_notebook_rev": nb, "expected_rev": self.page0["rev"]})
        page = self.page(self.page0["id"])
        self.assertIsNotNone(page["deleted_at"])
        status, _ = hq_carnet.http_post(self.req(expected_rev=page["rev"]))
        self.assertIn(status, (400, 409))
        self.assertEqual(self.cards(), [])

    def test_validation(self):
        bad = [
            {"title": ""}, {"title": "   "}, {"title": "x" * 121}, {"title": "a\nb"}, {"title": "a\u0000b"}, {"title": 5},
            {"text": ""}, {"text": "a\nb"}, {"text": "x" * 501}, {"start": 5, "end": 5}, {"start": 6, "end": 2}, {"start": -1}, {"start": True},
            {"request_id": ""}, {"request_id": "x y"}, {"request_id": "a" * 100}, {"request_id": 7},
            {"page_id": "../etc"}, {"block_id": "nope"},
        ]
        for over in bad:
            status, out = hq_carnet.http_post(self.req(**over))
            self.assertIn(status, (400, 404), over)
        status, _ = hq_carnet.http_post({**self.req(), "extra": 1})
        self.assertEqual(status, 400)
        status, _ = hq_carnet.http_post({k: v for k, v in self.req().items() if k != "title"})
        self.assertEqual(status, 400)
        self.assertEqual(self.cards(), [])

    def test_title_limit_boundary(self):
        status, out = hq_carnet.http_post(self.req(title="t" * 120))
        self.assertEqual(status, 200)
        self.assertEqual(len(out["task"]["title"]), 120)

    def test_non_text_blocks_cannot_be_the_source(self):
        page = self.page(self.page0["id"])
        saved = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [para("x"), calc_block()]}})["page"]
        status, _ = hq_carnet.http_post(self.req(expected_rev=saved["rev"], block_id=saved["content"]["blocks"][1]["id"], start=0, end=1, text="x", request_id="tk-atom-0001"))
        self.assertEqual(status, 409)


class TaskUnavailableTests(TaskBase):
    def test_malformed_board_is_preserved_and_refused(self):
        self.kanban.write_bytes(b"{not json")
        status, out = hq_carnet.http_post(self.req())
        self.assertEqual(status, 503)
        self.assertEqual(out["code"], "tasks_unavailable")
        self.assertEqual(self.kanban.read_bytes(), b"{not json")

    def test_structurally_malformed_boards_are_preserved_and_refused(self):
        boards = [
            {"columns": [{"id": "todo", "title": "À faire", "cards": []}, 42]},
            {"columns": [{"id": "todo", "cards": "broken"}]},
            {"columns": [{"id": "todo", "cards": [1]}]},
            {"columns": [{"id": "todo", "cards": []}, {"id": "done", "cards": None}]},
            {"columns": [{"id": "todo", "cards": []}, {"cards": []}]},
            {"columns": [{"id": "todo", "cards": []}, {"id": 7, "cards": []}]},
            {"columns": [{"id": "todo", "cards": []}, {"id": "", "cards": []}]},
            {"columns": []},
            {"columns": "x"},
            [],
        ]
        for board in boards:
            raw = json.dumps(board).encode()
            self.kanban.write_bytes(raw)
            status, out = hq_carnet.http_post(self.req(request_id="tk-shape-%04d" % boards.index(board)))
            self.assertEqual((status, out.get("code")), (503, "tasks_unavailable"), board)
            self.assertEqual(self.kanban.read_bytes(), raw, board)

    def test_writer_raising_attribute_error_is_a_controlled_503(self):
        def boom(column, title):
            raise AttributeError("x")
        hq_carnet.bind(task_add=boom)
        status, out = hq_carnet.http_post(self.req())
        self.assertEqual((status, out.get("code")), (503, "tasks_unavailable"))
        self.assertEqual(hq_carnet._task_seen, {})

    def test_notebook_cannot_change_between_validation_and_card_creation(self):
        import threading
        import time
        seen = {}
        done = threading.Event()

        def slow_add(column, title):
            def save():
                try:
                    hq_carnet.mutate({"action": "page_save", "id": self.page0["id"], "expected_rev": self.page0["rev"], "content": {"version": 2, "blocks": [{**para("Modifié"), "id": self.block}, para("deuxième ligne")]}})
                except Exception as e:  # the save loses or wins AFTER the card exists; never in between
                    seen["err"] = e
                finally:
                    done.set()
            t = threading.Thread(target=save)
            t.start()
            seen["thread"] = t
            time.sleep(0.4)
            seen["blocked_during_add"] = not done.is_set()
            return cc_ext.kanban_add(column, title)

        hq_carnet.bind(task_add=slow_add)
        status, out = hq_carnet.http_post(self.req())
        seen["thread"].join(5)
        self.assertEqual(status, 200)
        self.assertTrue(seen["blocked_during_add"], "a concurrent save must wait until the card is created and confirmed")
        self.assertEqual([c["title"] for c in self.cards()], ["Commander joints"])
        # the save that waited is now applied on top of the task: a later request for the old text is stale
        status, _ = hq_carnet.http_post(self.req(request_id="tk-" + "b" * 16, expected_rev=self.page(self.page0["id"])["rev"]))
        self.assertEqual(status, 409)
        self.assertEqual(len(self.cards()), 1)

    def test_board_without_todo_column_is_preserved_and_refused(self):
        raw = json.dumps({"columns": [{"id": "done", "title": "x", "cards": []}]}).encode()
        self.kanban.write_bytes(raw)
        self.assertEqual(hq_carnet.http_post(self.req())[0], 503)
        self.assertEqual(self.kanban.read_bytes(), raw)

    def test_board_not_utf8_is_preserved_and_refused(self):
        self.kanban.write_bytes(b"\xff\xfe\x00")
        self.assertEqual(hq_carnet.http_post(self.req())[0], 503)
        self.assertEqual(self.kanban.read_bytes(), b"\xff\xfe\x00")

    def test_board_is_a_directory(self):
        self.kanban.mkdir()
        self.assertEqual(hq_carnet.http_post(self.req())[0], 503)

    def test_no_task_system_bound(self):
        hq_carnet._cb.pop("task_add", None)
        status, out = hq_carnet.http_post(self.req())
        self.assertEqual(status, 503)
        self.assertEqual(out["code"], "tasks_unavailable")

    def test_task_system_raising_is_a_clean_503_and_nothing_is_remembered(self):
        def boom(column, title):
            raise OSError("C:\\secret\\path denied")

        hq_carnet.bind(task_add=boom)
        status, out = hq_carnet.http_post(self.req())
        self.assertEqual(status, 503)
        self.assertNotIn("secret", json.dumps(out))
        hq_carnet.bind(task_add=cc_ext.kanban_add)
        status, out = hq_carnet.http_post(self.req())
        self.assertEqual(status, 200, "a failed attempt is not remembered as a success")
        self.assertFalse(out["duplicate"])

    def test_unconfirmed_card_is_refused(self):
        hq_carnet.bind(task_add=lambda column, title: {"columns": [{"id": "todo", "title": "À faire", "cards": []}]})
        status, out = hq_carnet.http_post(self.req())
        self.assertEqual(status, 503)

    def test_board_missing_is_created_with_defaults(self):
        self.assertFalse(self.kanban.exists())
        self.assertEqual(hq_carnet.http_post(self.req())[0], 200)
        cols = [c["id"] for c in json.loads(self.kanban.read_text(encoding="utf-8"))["columns"]]
        self.assertEqual(cols, ["todo", "doing", "done"])

    def test_idempotency_memory_is_bounded(self):
        for i in range(hq_carnet.TASK_SEEN_MAX + 5):
            hq_carnet._task_seen[f"tk-{i:08d}"] = {"id": "c", "title": "t", "column": "todo"}
            while len(hq_carnet._task_seen) > hq_carnet.TASK_SEEN_MAX:
                hq_carnet._task_seen.popitem(last=False)
        self.assertLessEqual(len(hq_carnet._task_seen), hq_carnet.TASK_SEEN_MAX)

    def test_readonly_hq_files_untouched(self):
        # the extraction must not create files other than the board (no temp residue next to the notebook)
        hq_carnet.http_post(self.req())
        self.assertEqual(sorted(os.listdir(self.path.parent)), ["notebook.json"])


# ---------------------------------------------------------------- export / backup on the production path


class ExportBackupTests(CarnetBase):
    def setUp(self):
        super().setUp()
        import iphone_bridge as B

        for name in ("Inbox", "Uni", "Print"):
            (self.tmp / name).mkdir()
        saved = dict(hq_carnet._cb)
        self.addCleanup(lambda: (hq_carnet._cb.clear(), hq_carnet._cb.update(saved)))
        hq_carnet.bind(root=self.tmp, now=lambda: self.clock[0], folders=lambda: ["Inbox", "Uni", "Print"],
                       system_names=B.SYSTEM_NAMES, safe_leaf_name=B.safe_leaf_name)
        nb = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        page = nb["page"]
        blocks = [para("Essai banc"), calc_block(unit="mm", result="612.5", expr="12.5*(3+4)^2"), measure_block(), decision_block("Go")]
        self.page0 = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": blocks}})["page"]

    def export(self, fmt):
        before = self.path.read_bytes()
        out = hq_carnet.export_copy({"action": "page_export", "id": self.page0["id"], "expected_rev": self.page0["rev"], "format": fmt, "dir": "Inbox", "filename": "essai"})
        self.assertEqual(self.path.read_bytes(), before, "export never mutates the notebook")
        return (self.tmp / "Inbox" / ("essai." + fmt)).read_text(encoding="utf-8"), out

    def test_txt_export_is_readable_labelled_and_path_free(self):
        text, out = self.export("txt")
        self.assertIn("[Calcul : 12.5*(3+4)^2 = 612.5 mm — 2026-09-21 14:13 UTC]", text)
        self.assertIn("Mesure : a — observé 10.02 mm", text)
        self.assertIn("aide de carnet, non certifié", text)
        self.assertIn("DÉCISION · 2026-09-21 14:13 UTC — Go", text)
        self.assertNotIn(str(self.tmp), text)

    def test_markdown_export(self):
        text, out = self.export("md")
        self.assertIn("**DÉCISION · 2026-09-21 14:13 UTC** — Go", text)
        self.assertIn("non certifié", text)

    def test_snapshot_copies_a_valid_notebook_byte_for_byte(self):
        dest = self.tmp / "snap"
        dest.mkdir()
        out = hq_carnet.snapshot_to(self.tmp, dest)
        self.assertTrue(out.get("valid"), out)
        self.assertEqual((dest / "notebook.json").read_bytes(), self.path.read_bytes())

    def test_snapshot_flags_a_malformed_engineering_payload_but_copies_the_bytes(self):
        state = self.disk()
        state["pages"][-1]["content"]["blocks"][1]["calc"]["result"] = "zzz"
        raw = json.dumps(state, ensure_ascii=False).encode("utf-8")
        self.path.write_bytes(raw)
        dest = self.tmp / "snap"
        dest.mkdir()
        out = hq_carnet.snapshot_to(self.tmp, dest)
        self.assertFalse(out.get("valid"), out)
        self.assertEqual((dest / "notebook.json").read_bytes(), raw, "malformed bytes are preserved, never repaired")


# ---------------------------------------------------------------- real HTTP handler: auth, CSRF, role, no path leaks


class EngApiTests(unittest.TestCase):
    setUpClass = _base.ApiTests.__dict__["setUpClass"]
    tearDownClass = _base.ApiTests.__dict__["tearDownClass"]
    _login = _base.ApiTests.__dict__["_login"]
    _get = _base.ApiTests._get
    _post = _base.ApiTests._post

    def setUp(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(_fixture(), ensure_ascii=False), encoding="utf-8")
        hq_carnet._task_seen.clear()
        self.kanban = self.tmp / "kanban.json"
        if self.kanban.exists():
            self.kanban.unlink()

    def create_page(self, blocks):
        nb = json.loads(self._get("/api/carnet")[2])["notebook_rev"]
        status, _h, body = self._post({"action": "page_create", "expected_notebook_rev": nb})
        self.assertEqual(status, 200, body)
        page = json.loads(body)["page"]
        status, _h, body = self._post({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": blocks}})
        return status, json.loads(body)

    def test_admin_saves_and_reads_engineering_blocks(self):
        status, out = self.create_page([para("x"), calc_block(), measure_block(), decision_block("Go")])
        self.assertEqual(status, 200, out)
        page = out["page"]
        self.assertEqual([b["type"] for b in page["content"]["blocks"]], ["paragraph", "calc", "measure", "decision"])
        got = json.loads(self._get("/api/carnet")[2])
        stored = next(p for p in got["pages"] if p["id"] == page["id"])
        self.assertEqual(stored["content"]["blocks"][1]["calc"], calc_block()["calc"])

    def test_invalid_payload_is_a_path_free_400(self):
        status, out = self.create_page([calc_block(result="NaN")])
        self.assertEqual(status, 400)
        self.assertNotIn(str(self.tmp), json.dumps(out))

    def test_task_extract_auth_csrf_role_and_method(self):
        status, out = self.create_page([para("Commander les joints")])
        page = out["page"]
        block = page["content"]["blocks"][0]["id"]
        req = {"action": "task_extract", "page_id": page["id"], "expected_rev": page["rev"], "block_id": block, "start": 0, "end": 9,
               "text": "Commander", "title": "Commander joints", "request_id": "tk-api-000001"}
        self.assertEqual(self._post(req, cookie="")[0], 401)
        self.assertEqual(self._post(req, cookie=self.upload)[0], 403)
        self.assertEqual(self._post(req, origin=False)[0], 403)
        self.assertFalse(self.kanban.exists())
        status, _h, body = self._post(req)
        self.assertEqual(status, 200, body)
        data = json.loads(body)
        self.assertEqual(data["task"]["column"], "todo")
        again = json.loads(self._post(req)[2])
        self.assertTrue(again["duplicate"])
        cards = next(c for c in json.loads(self.kanban.read_text(encoding="utf-8"))["columns"] if c["id"] == "todo")["cards"]
        self.assertEqual(len(cards), 1)

    def test_task_extract_stale_and_unavailable_are_path_free(self):
        status, out = self.create_page([para("Commander les joints")])
        page = out["page"]
        block = page["content"]["blocks"][0]["id"]
        req = {"action": "task_extract", "page_id": page["id"], "expected_rev": page["rev"], "block_id": block, "start": 0, "end": 9,
               "text": "Commander", "title": "t", "request_id": "tk-api-000002"}
        status, _h, body = self._post({**req, "text": "Commandé"})
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)["code"], "stale_selection")
        self.kanban.write_bytes(b"{broken")
        status, _h, body = self._post(req)
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["code"], "tasks_unavailable")
        self.assertNotIn(str(self.tmp).encode(), body)
        self.assertEqual(self.kanban.read_bytes(), b"{broken")

    def test_no_new_route_was_added(self):
        src = Path(_base.__file__).resolve().parents[1].joinpath("iphone_bridge.py").read_text(encoding="utf-8")
        self.assertNotIn("/api/carnet/task", src)
        self.assertNotIn("/api/carnet/eng", src)


if __name__ == "__main__":
    unittest.main()
