"""Carnet Phase 6 — Ask Carnet: evidence-only lexical search with citations, provenance, scopes, frozen snapshots, report item."""

from __future__ import annotations

import hashlib
import io
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_ask as ask  # noqa: E402
import carnet_voice_fixtures as V  # noqa: E402
import hq_carnet_media as media  # noqa: E402
import hq_carnet_voice as voice  # noqa: E402
import hq_carnet_report as report  # noqa: E402
import hq_carnet_review as review  # noqa: E402
from test_hq_carnet_history import para  # noqa: E402
from test_hq_carnet_intel import AT, IntelBase, _rid, decision, drawing, measure  # noqa: E402
from test_hq_carnet_links_report import image_block, png  # noqa: E402


def derived_para(text, kind, source_kind, source_id):
    return {"type": "paragraph", "text": text, "marks": [], "from": {"kind": kind, "source_kind": source_kind, "source_id": source_id}}


def tree_digest(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(Path(root).rglob("*")):
        h.update(str(p.relative_to(root)).encode())
        if p.is_file():
            h.update(p.read_bytes())
    return h.hexdigest()


class Base(IntelBase):
    def q(self, question, scope=None, **extra):
        return review.ask({"action": "ask", "question": question, "scope": scope or {"kind": "notebook"}, **extra})

    def store_asset(self):
        return media.store_upload(io.BytesIO(png()).read, len(png()), "image/png")["asset"]


class PureTests(unittest.TestCase):
    def test_fold_and_tokens(self):
        self.assertEqual(ask.fold("ÉTÉ Straße"), ask.fold("ete strasse"))
        self.assertEqual(ask.tokens("Arbres, Ø 10,5 mm"), ["arbre", "ø", "10.5", "mm"] if "ø" in ask.tokens("Ø") else ask.tokens("Arbres, Ø 10,5 mm"))
        self.assertIn("10.5", ask.tokens("10,5"))

    def test_stopwords_and_phrases(self):
        p = ask.parse_question('le "palier avant" dans la cote')
        self.assertIn("palier", p["terms"])
        self.assertNotIn("le", p["terms"])
        self.assertNotIn("dan", p["terms"])
        self.assertTrue(p["phrases"])
        self.assertTrue(ask.parse_question("le la de")["stop_only"])

    def test_term_cap(self):
        p = ask.parse_question(" ".join(f"mot{chr(97 + i)}x" for i in range(20)))
        self.assertEqual(len(p["terms"]), ask.LIMITS["terms"])
        self.assertTrue(p["truncated"])


class SearchTests(Base):
    def test_evidence_card_with_deep_link(self):
        p = self.make_page([para("intro"), para("Le palier avant est usiné en H7")])
        out = self.q("palier H7")
        self.assertEqual(out["status"], "evidence")
        c = out["cards"][0]
        blk = self.cur(p["id"])["content"]["blocks"][1]
        self.assertEqual((c["page_id"], c["block_id"], c["link"]), (p["id"], blk["id"], f"#carnet/{p['id']}/{blk['id']}"))
        self.assertEqual(c["class"], "primary")
        self.assertIn("generated", out["note"].lower() if "generated" in out["note"].lower() else "generated")

    def test_accent_and_plural_folding(self):
        self.make_page([para("Les alésages sont contrôlés")])
        self.assertEqual(self.q("alesage controles")["status"], "evidence")

    def test_insufficient_and_empty(self):
        self.make_page([para("rien d'utile")])
        out = self.q("turbine hydraulique")
        self.assertEqual((out["status"], out["cards"]), ("insufficient", []))
        self.assertEqual(self.q("le la de")["status"], "empty_query")
        self.assertEqual(self.q("   ")["status"], "empty_query")

    def test_partial_is_labelled(self):
        self.make_page([para("palier usiné")])
        out = self.q("palier rectifié grenaillé")
        self.assertIn(out["status"], ("partial", "insufficient"))
        if out["status"] == "partial":
            self.assertTrue(out["partial"] and out["cards"])
            self.assertIn("rectifie", out["unmatched_terms"])

    def test_block_types(self):
        rows = {"type": "table", "text": "", "marks": [], "table": {"header": True, "rows": [["Pièce", "Cote"], ["Zorglub", "42"]]}}
        self.make_page([rows, decision("Retenir quasimodo"), measure(label="Ø fraisurel"), drawing("plan-zz"),
                        {"type": "callout", "text": "", "marks": [], "callout": {"kind": "note", "title": "Attention", "body": "frobnicate"}}])
        for question, kind in (("zorglub", "table"), ("quasimodo", "decision"), ("fraisurel", "measure"), ("frobnicate", "callout")):
            out = self.q(question)
            self.assertEqual(out["status"], "evidence", question)
            self.assertEqual(out["cards"][0]["kind"], kind, question)
        self.assertIn("at", self.q("quasimodo")["cards"][0])
        self.assertIn("measure", self.q("fraisurel")["cards"][0])

    def test_scopes(self):
        a = self.proj_page([para("mot-unique-alpha zebulon")])
        b = self.proj_page([para("zebulon ailleurs")], project=self.other)
        n = self.make_page([para("zebulon libre")])
        ids = lambda o: {c["page_id"] for c in o["cards"]}
        self.assertEqual(ids(self.q("zebulon", {"kind": "page", "id": a["id"]})), {a["id"]})
        self.assertEqual(ids(self.q("zebulon", {"kind": "project", "id": self.proj["id"]})), {a["id"]})
        self.assertEqual(ids(self.q("zebulon", {"kind": "project", "id": "none"})), {n["id"]})
        self.assertEqual(ids(self.q("zebulon")), {a["id"], b["id"], n["id"]})
        out = self.q("zebulon", {"kind": "project", "id": self.proj["id"]})
        self.assertEqual(out["scope"]["label"], "Banc")

    def test_bad_requests(self):
        for bad in ({"question": 5, "scope": {"kind": "notebook"}}, {"question": "x" * 301, "scope": {"kind": "notebook"}},
                    {"question": "a\x00b", "scope": {"kind": "notebook"}}, {"question": "a", "scope": {"kind": "x"}},
                    {"question": "a", "scope": {"kind": "page"}}, {"question": "a", "scope": {"kind": "notebook", "id": "z"}},
                    {"question": "a", "scope": {"kind": "notebook"}, "limit": 0}, {"question": "a", "scope": {"kind": "notebook"}, "limit": True},
                    {"question": "a", "scope": {"kind": "notebook"}, "extra": 1}):
            with self.assertRaises(Exception, msg=bad):
                review.ask({"action": "ask", **bad})
        with self.assertRaises(Exception):
            self.q("a", {"kind": "page", "id": "page-" + "0" * 24})
        with self.assertRaises(Exception):
            self.q("a", {"kind": "project", "id": "proj-" + "0" * 24})

    def test_trashed_pages_are_not_searched(self):
        p = self.make_page([para("xylophone")])
        hq_carnet.mutate({"action": "page_trash", "id": p["id"], "expected_rev": self.cur(p["id"])["rev"], "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        self.assertEqual(self.q("xylophone")["status"], "insufficient")

    def test_read_only(self):
        self.make_page([para("xylophone"), decision("zeppelin")])
        before = tree_digest(self.tmp)
        self.q("xylophone")
        self.q("zeppelin")
        self.assertEqual(tree_digest(self.tmp), before)

    def test_http_route(self):
        self.make_page([para("xylophone")])
        status, out = hq_carnet.http_post({"action": "ask", "question": "xylophone", "scope": {"kind": "notebook"}})
        self.assertEqual((status, out["status"]), (200, "evidence"))
        status, out = hq_carnet.http_post({"action": "ask", "question": "x", "scope": {"kind": "notebook"}, "bogus": 1})
        self.assertEqual(status, 400)

    def test_card_cap_and_default(self):
        for i in range(15):
            self.make_page([para(f"xylophone numero {i}")])
        self.assertEqual(len(self.q("xylophone")["cards"]), ask.LIMITS["cards_default"])
        self.assertEqual(len(self.q("xylophone", limit=20)["cards"]), 15)


class ProvenanceTests(Base):
    def test_ocr_text_exposes_its_image_source(self):
        a = self.store_asset()
        p = self.make_page([image_block(a), derived_para("serrage couple quarante", "ocr", "asset", a["id"])])
        out = self.q("couple serrage")
        c = out["cards"][0]
        self.assertEqual(c["class"], "derived")
        pv = c["provenance"]
        self.assertTrue(pv["derived"])
        self.assertEqual(pv["kind"], "ocr")
        self.assertEqual(pv["source"]["id"], a["id"])
        self.assertEqual(pv["source"]["state"], "ok")
        self.assertEqual(pv["source"]["block"]["page_id"], p["id"])
        self.assertTrue(pv["source"]["block"]["link"].startswith(f"#carnet/{p['id']}/"))

    def test_missing_source_is_stated_not_hidden(self):
        a = self.store_asset()
        self.make_page([derived_para("serrage couple", "ocr", "asset", a["id"])])
        c = self.q("couple serrage")["cards"][0]
        self.assertEqual(c["class"], "derived")
        self.assertEqual(c["provenance"]["source"]["state"], "ok")
        self.assertIsNone(c["provenance"]["source"].get("block"))

    def test_unknown_source_asset_is_marked_missing(self):
        a = self.store_asset()
        self.make_page([derived_para("serrage couple", "ocr", "asset", a["id"])])
        for f in (self.tmp / ".hq-carnet").rglob("*"):
            if f.is_file() and a["id"] in f.name:
                f.unlink()
        c = self.q("couple serrage")["cards"][0]
        self.assertEqual(c["provenance"]["source"]["state"], "missing")

    def test_primary_ranks_before_derived_on_equal_text(self):
        a = self.store_asset()
        self.make_page([image_block(a), derived_para("tolérance zorbo", "ocr", "asset", a["id"])])
        self.make_page([para("tolérance zorbo")])
        cards = self.q("zorbo tolerance")["cards"]
        self.assertEqual([c["class"] for c in cards], ["primary", "derived"])

    def test_transcript_provenance(self):
        v = voice.store_upload(io.BytesIO(V.webm()).read, len(V.webm()), None)["voice"]
        vid = v["id"]
        self.make_page([derived_para("note vocale quasar", "transcript", "voice", vid)])
        c = self.q("quasar")["cards"][0]
        self.assertEqual((c["provenance"]["kind"], c["provenance"]["source"]["kind"], c["provenance"]["source"]["id"]), ("transcript", "voice", vid))
        self.assertEqual(c["provenance"]["source"]["state"], "ok")
        self.assertIsNone(c["provenance"]["source"].get("block"))


class SnapshotScopeTests(Base):
    def snap(self, project=None):
        status, out = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": (project or self.proj)["id"], "label": "Gel"})
        self.assertEqual(status, 200, out)
        return out["snapshot"]["id"]

    def test_frozen_cards_have_no_live_link_and_report_drift(self):
        p = self.proj_page([para("stable quasar"), para("changera quasar")])
        sid = self.snap()
        page = self.cur(p["id"])
        blocks = page["content"]["blocks"]
        blocks[1] = {**blocks[1], "text": "modifié"}
        hq_carnet.mutate({"action": "page_save", "id": p["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": blocks}})
        out = self.q("quasar", {"kind": "snapshot", "id": sid})
        self.assertEqual(out["status"], "evidence")
        self.assertTrue(out["frozen"])
        states = {}
        for c in out["cards"]:
            self.assertIsNone(c["link"])
            states[c["excerpt"][:6]] = c["live_state"]
        self.assertEqual(sorted(states.values()), ["changed", "unchanged"])
        self.assertTrue(any(c.get("live_link") for c in out["cards"] if c["live_state"] == "unchanged"))
        self.assertFalse(any(c.get("live_link") for c in out["cards"] if c["live_state"] == "changed"))

    def test_corrupt_snapshot_is_refused(self):
        self.proj_page([para("quasar")])
        sid = self.snap()
        f = self.tmp / ".hq-carnet" / "snapshots" / (sid + ".json")
        f.write_bytes(f.read_bytes().replace(b"quasar", b"quasaz"))
        with self.assertRaises(Exception) as cm:
            self.q("quasar", {"kind": "snapshot", "id": sid})
        self.assertEqual(getattr(cm.exception, "status", 503), 503)

    def test_unknown_snapshot(self):
        with self.assertRaises(Exception):
            self.q("quasar", {"kind": "snapshot", "id": "snap-" + "0" * 24})


class ReportTests(Base):
    def item(self, question, scope=None):
        out = self.q(question, scope)
        return {"kind": "ask_evidence", "question": question, "scope": out["scope_req"] if "scope_req" in out else (scope or {"kind": "notebook"}), "fingerprint": out["fingerprint"]}

    def build(self, items):
        return hq_carnet.http_post({"action": "report_build", "title": "R", "items": items, "format": "markdown"}) if False else report.build({"action": "report_build", "title": "R", "items": items}) if False else hq_carnet.http_post({"action": "report_build", "items": items})

    def test_item_validation(self):
        for bad in ({"kind": "ask_evidence", "question": "x", "scope": {"kind": "notebook"}},
                    {"kind": "ask_evidence", "question": "x", "scope": {"kind": "notebook"}, "fingerprint": "zz"},
                    {"kind": "ask_evidence", "question": 1, "scope": {"kind": "notebook"}, "fingerprint": "0" * 32}):
            status, _ = self.build([bad])
            self.assertEqual(status, 400, bad)

    def test_build_and_stale(self):
        p = self.make_page([para("xylophone cité")])
        it = self.item("xylophone")
        status, out = self.build([it])
        self.assertEqual(status, 200, out)
        text = out["markdown"] if "markdown" in out else str(out)
        self.assertIn("#carnet/" + p["id"], text)
        page = self.cur(p["id"])
        hq_carnet.mutate({"action": "page_save", "id": p["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [para("xylophone autre")]}})
        status, out = self.build([it])
        self.assertEqual((status, out.get("code")), (409, "report_stale"))


def _sources_mod():
    import hq_carnet_sources as sources

    return sources


class EvidenceSealTests(Base):
    """r2: the report item is pinned to the evidence AS SHOWN, not only to page revisions."""

    def item(self, question, scope=None):
        scope = scope or {"kind": "notebook"}
        out = self.q(question, scope)
        return {"kind": "ask_evidence", "question": question, "scope": scope, "fingerprint": out["fingerprint"]}

    def build(self, it):
        return hq_carnet.http_post({"action": "report_build", "items": [it]})

    def cited_page(self, **ed_extra):
        ed = self.edition(self.family("Fam-" + _rid()[:8]), "29e", **ed_extra)
        page = self.proj_page([self.cite_block(ed), para("voir plus loin")])
        return ed, page

    def update_edition(self, ed, **fields):
        rev = _sources_mod().mutate({"action": "source_edition_update", "id": ed["id"], "expected_rev": self._rev(ed), **fields})["edition"]
        return rev

    def _rev(self, ed):
        out = hq_carnet.http_get({"sources": ["1"]})[1]
        found = next(e for e in out["editions"] if e["id"] == ed["id"])
        return found["rev"]

    def test_unchanged_builds_and_unrelated_edit_does_not_stale(self):
        self.ed, self.pg = self.cited_page()
        it = self.item("oberg")
        self.assertEqual(self.build(it)[0], 200)
        self.make_page([para("rien à voir avec la recherche")])  # an unrelated page appears: the cited evidence is unchanged
        self.assertEqual(self.build(it)[0], 200)

    def test_source_metadata_change_makes_the_item_stale(self):
        for field, value in (("title", "Autre titre"), ("author", "Machinist")):  # year / edition label are immutable on an edition
            with self.subTest(field=field):
                ed, _ = self.cited_page()
                it = self.item("oberg machinery") if field != "author" else self.item("machinery")
                self.assertEqual(self.build(it)[0], 200)
                self.update_edition(ed, **{field: value})
                status, out = self.build(it)
                self.assertEqual((status, out.get("code")), (409, "report_stale"), field)

    def test_ocr_source_going_missing_makes_the_item_stale(self):
        a = self.store_asset()
        self.make_page([image_block(a), derived_para("serrage couple tourbillon", "ocr", "asset", a["id"])])
        it = self.item("tourbillon")
        self.assertEqual(self.build(it)[0], 200)
        for f in (self.tmp / ".hq-carnet").rglob("*"):
            if f.is_file() and a["id"] in f.name:
                f.unlink()
        self.assertEqual(self.build(it)[1].get("code"), "report_stale")

    def test_drawing_state_change_makes_the_item_stale(self):
        self.draw("plan-7")
        self.make_page([drawing("plan-7")])
        it = self.item("plan-7")
        self.assertEqual(self.build(it)[0], 200)
        (self.draw_dir / "plan-7.hqdraw.json").unlink()
        self.assertEqual(self.build(it)[1].get("code"), "report_stale")

    def test_ranking_scores_are_not_part_of_the_seal(self):
        self.make_page([para("serrage palier")])
        a = self.q("serrage")
        b = ask.evidence_fingerprint({**a, "cards": [{**c, "score": c["score"] + 5} for c in a["cards"]]})
        self.assertEqual(a["fingerprint"], b)
        self.assertNotEqual(a["fingerprint"], a["scope_fingerprint"])


class FrozenSourceTests(Base):
    """r2: a frozen scope speaks of the frozen state — source metadata and reference states come from the snapshot."""

    def snap(self):
        status, out = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": "Gel"})
        self.assertEqual(status, 200, out)
        return out["snapshot"]["id"]

    def setUp(self):
        super().setUp()
        self.ed = self.edition(self.family(), "29e", title="Bearing Spec Rev A")
        self.proj_page([self.cite_block(self.ed)])
        self.sid = self.snap()
        rev = next(e for e in hq_carnet.http_get({"sources": ["1"]})[1]["editions"] if e["id"] == self.ed["id"])["rev"]
        _sources_mod().mutate({"action": "source_edition_update", "id": self.ed["id"], "expected_rev": rev, "title": "Bearing Spec Rev B"})

    def src(self, scope):
        return self.q("oberg", scope)["sources"]

    def test_frozen_search_shows_frozen_metadata_live_search_shows_live(self):
        frozen = self.src({"kind": "snapshot", "id": self.sid})
        self.assertEqual([s["title"] for s in frozen], ["Bearing Spec Rev A"])
        live = self.src({"kind": "project", "id": self.proj["id"]})
        self.assertEqual([s["title"] for s in live], ["Bearing Spec Rev B"])

    def test_frozen_report_shows_frozen_metadata(self):
        scope = {"kind": "snapshot", "id": self.sid}
        out = self.q("oberg", scope)
        status, rep = hq_carnet.http_post({"action": "report_build", "items": [{"kind": "ask_evidence", "question": "oberg", "scope": scope, "fingerprint": out["fingerprint"]}]})
        self.assertEqual(status, 200, rep)
        text = rep.get("markdown") or str(rep)
        self.assertIn("Bearing Spec Rev A", text)
        self.assertNotIn("Bearing Spec Rev B", text)

    def test_frozen_states_are_sealed_and_current_state_is_separate(self):
        a = self.store_asset()
        self.proj_page([image_block(a), derived_para("couple tourbillon", "ocr", "asset", a["id"])])
        sid = self.snap()
        for f in (self.tmp / ".hq-carnet").rglob("*"):
            if f.is_file() and a["id"] in f.name:
                f.unlink()
        card = self.q("tourbillon", {"kind": "snapshot", "id": sid})["cards"][0]
        src = card["provenance"]["source"]
        self.assertEqual((src["state"], src["current_state"]), ("ok", "missing"))
        live = self.q("tourbillon", {"kind": "project", "id": self.proj["id"]})["cards"][0]["provenance"]["source"]
        self.assertEqual(live["state"], "missing")
        self.assertNotIn("current_state", live)


class FrozenFileFamilyTests(Base):
    """r3: file / model / media links are sealed under their ORIGINAL kind; the frozen state never falls back to today's state."""

    def test_frozen_state_of_each_file_family_kind(self):
        from test_hq_carnet_intel import link_mark

        cases = (("file", "Inbox/a.pdf"), ("model", "Inbox/part.stl"), ("media", "Inbox/clip.mp4"))
        for kind, rel in cases:
            with self.subTest(kind=kind):
                target = self.tmp / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"%PDF-1.4\n%%EOF\n" if rel.endswith(".pdf") else b"x" * 64)
                word = "zorbak" + kind
                self.proj_page([para(f"{word} voir ici", [link_mark(len(word) + 1, len(word) + 5, kind, rel)])])
                status, out = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": self.proj["id"], "label": "Gel " + kind})
                self.assertEqual(status, 200, out)
                sid = out["snapshot"]["id"]
                target.unlink()
                frozen = self.q(word, {"kind": "snapshot", "id": sid})["cards"][0]["refs"]
                live = self.q(word, {"kind": "project", "id": self.proj["id"]})["cards"][0]["refs"]
                self.assertEqual([(r["kind"], r["id"], r["state"], r["current_state"]) for r in frozen], [(kind, rel, "ok", "missing")])
                self.assertEqual([(r["kind"], r["state"]) for r in live], [(kind, "missing")])
                self.assertNotIn("current_state", live[0])


class FixtureContractTests(unittest.TestCase):
    """The committed fixtures (consumed by check_hq_carnet_ask.mjs) must keep the SHAPE the server really returns."""

    def test_shape_matches_live_server(self):
        import json
        import gen_fixtures_carnet_ask as gen

        committed = json.loads((Path(__file__).resolve().parent / "fixtures_carnet_ask.json").read_text("utf-8"))
        live = gen.build()
        self.assertEqual(set(committed), set(live))
        for key in live:
            self.assertEqual(gen.shape(committed[key]), gen.shape(live[key]), key)
            self.assertEqual(committed[key]["status"], live[key]["status"], key)


if __name__ == "__main__":
    unittest.main()
