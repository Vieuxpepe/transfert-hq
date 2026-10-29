"""Global search (Ctrl+K palette): Carnet pages, Forge prompts, calendar titles, Inbox file names.
Disposable root, fake PINs, no Forge; never the live root or the vault."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_search as S  # noqa: E402


class Matching(unittest.TestCase):
    def test_fold_ignores_case_and_accents(self):
        self.assertEqual(S.fold("Réunion ÉTÉ"), "reunion ete")
        self.assertEqual(S.words("  Café   crème "), ["cafe", "creme"])
        self.assertEqual(S.fold(None), "")

    def test_every_word_must_match_and_titles_rank_first(self):
        pages = [
            {"id": "p1", "title": "Liste de courses", "text": "pain lait café", "updated_at": 1},
            {"id": "p2", "title": "Café du matin", "text": "notes", "updated_at": 2},
            {"id": "p3", "title": "Voyage", "text": "réserver un café à Lyon", "updated_at": 3},
            {"id": "p4", "title": "Café supprimé", "text": "", "updated_at": 9, "deleted_at": 5},
        ]
        hits = S.search_pages(S.words("cafe"), pages)
        self.assertEqual([h["id"] for h in hits], ["p2", "p3", "p1"])  # title first, then newest body match
        self.assertEqual(S.search_pages(S.words("cafe lyon"), pages)[0]["id"], "p3")
        self.assertEqual(S.search_pages(S.words("cafe paris"), pages), [])

    def test_page_hint_shows_a_snippet_only_for_body_matches(self):
        pages = [{"id": "p1", "title": "Voyage", "text": "x " * 60 + "réserver un café à Lyon " + "y " * 60, "updated_at": 1},
                 {"id": "p2", "title": "Café", "text": "rien", "updated_at": 1}]
        hits = {h["id"]: h for h in S.search_pages(S.words("café"), pages)}
        self.assertEqual(hits["p2"]["hint"], "Carnet")
        self.assertTrue(hits["p1"]["hint"].startswith("Carnet · …") and "café" in hits["p1"]["hint"])
        self.assertLessEqual(len(hits["p1"]["hint"]), 160)

    def test_groups_are_capped(self):
        pages = [{"id": "p%d" % i, "title": "note %d" % i, "text": "", "updated_at": i} for i in range(20)]
        hits = S.search_pages(S.words("note"), pages)
        self.assertEqual(len(hits), S.PER_GROUP)
        self.assertEqual(hits[0]["id"], "p19")

    def test_prompts_events_files(self):
        images = [{"id": "img-1", "prompt": "un renard roux dans la neige", "created": "2026-10-01T10:00:00Z"},
                  {"id": "img-2", "prompt": "un renard bleu", "created": "2026-10-20T10:00:00Z"}]
        self.assertEqual([h["id"] for h in S.search_prompts(S.words("renard"), images)], ["img-2", "img-1"])
        self.assertEqual(S.search_prompts(S.words("renard"), images)[0]["hint"], "Forge · 2026-10-20")
        events = [{"id": "e1", "title": "Dentiste", "start": "2026-11-12T14:00", "all_day": False, "notes": "dent cassée"},
                  {"id": "e2", "title": "Anniversaire", "start": "2026-12-01", "all_day": True}]
        ev = S.search_events(S.words("dentiste"), events)
        self.assertEqual((ev[0]["hint"], ev[0]["at"]), ("Calendrier · 2026-11-12 · 14:00", "2026-11-12"))
        self.assertEqual(S.search_events(S.words("cassee"), events), [], "notes are never searched")
        self.assertEqual(S.search_events(S.words("anniv"), events)[0]["hint"], "Calendrier · 2026-12-01")
        files = [{"rel": "Inbox/Captures/facture-edf.pdf", "name": "facture-edf.pdf", "mtime": 1},
                 {"rel": "Inbox/photo.jpg", "name": "photo.jpg", "mtime": 2}]
        f = S.search_files(S.words("facture"), files)
        self.assertEqual((f[0]["id"], f[0]["dir"], f[0]["hint"]), ("Inbox/Captures/facture-edf.pdf", "Inbox/Captures", "Inbox/Captures"))

    def test_short_queries_return_nothing(self):
        self.assertEqual(S.search("a", pages=[{"id": "p", "title": "a", "text": ""}]), [])
        self.assertEqual(S.search("   "), [])
        self.assertEqual(len(S.search("ab", pages=[{"id": "p", "title": "abc", "text": ""}])), 1)

    def test_bad_rows_are_ignored(self):
        self.assertEqual(S.search("note", pages=[None, {"title": "note"}], images=["x", {"prompt": "note"}],
                                  events=[None, {"title": "note"}], files=[None, {"name": "note"}]), [])

    def test_inbox_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            inbox = Path(tmp) / "Inbox"
            (inbox / "Captures" / "deep").mkdir(parents=True)
            (inbox / "a.txt").write_bytes(b"x")
            (inbox / ".hidden").write_bytes(b"x")
            (inbox / "_tmp").write_bytes(b"x")
            (inbox / "Captures" / "b.png").write_bytes(b"x")
            (inbox / "Captures" / "deep" / "c.png").write_bytes(b"x")
            rels = sorted(item["rel"] for item in S.inbox_files(Path(tmp)))
            self.assertEqual(rels, ["Inbox/Captures/b.png", "Inbox/a.txt"])
            self.assertLessEqual(len(S.inbox_files(Path(tmp), limit=1)), 1)
        self.assertEqual(S.inbox_files(Path(tmp)), [])


try:
    from test_hq_forge_vault_multi_http import JSON, MultiHttp  # noqa: E402
    import hq_carnet as C  # noqa: E402
    import iphone_bridge as B  # noqa: E402
except ImportError:  # pragma: no cover
    MultiHttp = None

if MultiHttp is not None:
    class Palette(MultiHttp):
        def seed(self):
            (B.ROOT / "Inbox" / "facture-edf.pdf").write_bytes(b"%PDF")
            folder = B.ROOT / ".hq-forge" / "gallery" / ("img-" + "a" * 24)
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "meta.json").write_text(json.dumps({"id": "img-" + "a" * 24, "created": "2026-10-20T10:00:00Z",
                                                          "settings": {"prompt": "un renard roux"}}), encoding="utf-8")
            self.addCleanup(lambda: (B.ROOT / "Inbox" / "facture-edf.pdf").unlink(missing_ok=True))
            self.addCleanup(lambda: __import__("shutil").rmtree(B.ROOT / ".hq-forge" / "gallery", ignore_errors=True))

        def hits(self, q):
            from urllib.parse import quote
            status, body = self.admin.json("/api/palette?q=" + quote(q))
            self.assertEqual(status, 200, body)
            return body["hits"]

        def test_content_hits_follow_catalog_hits(self):
            self.seed()
            self.assertEqual([(h["kind"], h["label"]) for h in self.hits("facture")], [("file", "facture-edf.pdf")])
            prompt = self.hits("renard")
            self.assertEqual([(h["kind"], h["id"]) for h in prompt], [("prompt", "img-" + "a" * 24)])
            content = ("page", "prompt", "event", "file")
            self.assertEqual([h for h in self.hits("f") if h["kind"] in content], [], "one letter: no content search")

        def test_calendar_titles(self):
            from datetime import date, timedelta
            day = (date.today() + timedelta(days=3)).isoformat()
            event = {"title": "Dentiste Martin", "all_day": True, "category": "other",
                     "start": day, "end": (date.today() + timedelta(days=4)).isoformat()}
            status, made = self.post(self.admin, "/api/calendar", {"action": "save", "expected_rev": 0, "event": event})
            self.assertIn(status, (200, 201), made)
            hits = [h for h in self.hits("dentiste") if h["kind"] == "event"]
            self.assertEqual((hits[0]["label"], hits[0]["at"]), ("Dentiste Martin", day))

        def test_carnet_pages_and_a_failing_source(self):
            saved = (C.ready, C.get_notebook)
            C.ready = lambda: True
            C.get_notebook = lambda **kw: {"pages": [{"id": "pg-1", "updated_at": 1, "deleted_at": None,
                                                      "content": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Plan du potager\nsemer les tomates"}]}]}}]}
            original_text = C._text
            C._text = lambda page: "Plan du potager\nsemer les tomates"
            try:
                hits = self.hits("tomates")
                self.assertEqual([(h["kind"], h["id"]) for h in hits], [("page", "pg-1")])
                C.get_notebook = lambda **kw: (_ for _ in ()).throw(RuntimeError("boom"))
                self.seed()
                self.assertEqual([h["kind"] for h in self.hits("facture")], ["file"], "a failing source is skipped")
            finally:
                C.ready, C.get_notebook = saved
                C._text = original_text

        def test_admin_only(self):
            self.assertEqual(self.anon.req("/api/palette?q=facture")[0], 401)
            self.assertEqual(self.upload.req("/api/palette?q=facture")[0], 403)


if __name__ == "__main__":
    unittest.main()
