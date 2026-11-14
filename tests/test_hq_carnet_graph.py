"""Carnet constellation graph (hq_carnet_links.graph, GET /api/carnet?graph=1): read-only, trashed pages out, bounded.

Throwaway ROOTs only (the Stage 08 fixture)."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import hq_carnet_links as links  # noqa: E402
from test_hq_carnet_history import Stage08Base, para  # noqa: E402
from test_hq_carnet_links_report import link_mark  # noqa: E402


class GraphTests(Stage08Base):
    def project(self, name):
        nb = hq_carnet.get_notebook()
        out = hq_carnet.mutate({"action": "project_create", "name": name, "expected_notebook_rev": nb["notebook_rev"]})
        return out["project"]

    def page_in(self, project_id, blocks):
        page = self.make_page(blocks)
        nb = hq_carnet.get_notebook()
        cur = next(p for p in nb["pages"] if p["id"] == page["id"])
        return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": cur["rev"], "project_id": project_id,
                                 "content": cur["content"]})["page"]

    def base_ids(self):
        return {p["id"] for p in hq_carnet.get_notebook()["pages"] if p["deleted_at"] is None}

    def test_pages_projects_targets_and_edges(self):
        base = self.base_ids()  # a new notebook starts with its own first page
        proj = self.project("Garage")
        target = self.make_page([para("cible")])
        a = self.page_in(proj["id"], [para("voir cible et plan", [link_mark(5, 10, "note", target["id"]), link_mark(14, 18, "file", "Inbox/a.pdf")])])
        lonely = self.make_page([para("seule")])
        before = self.path.read_bytes()
        g = links.graph()
        self.assertEqual(self.path.read_bytes(), before, "viewing never writes")
        ids = {p["id"] for p in g["pages"]}
        self.assertEqual(ids, base | {target["id"], a["id"], lonely["id"]})
        self.assertEqual([p["name"] for p in g["projects"]], ["Garage"])
        self.assertEqual(next(p for p in g["pages"] if p["id"] == a["id"])["project_id"], proj["id"])
        edges = {(e["from"], e["to"]) for e in g["edges"]}
        self.assertIn((a["id"], "note:" + target["id"]), edges)
        self.assertIn((a["id"], "file:Inbox/a.pdf"), edges)
        self.assertEqual([t["label"] for t in g["targets"]], ["a.pdf"])
        self.assertNotIn(str(self.tmp), json.dumps(g), "no absolute path ever leaves")

    def test_trashed_pages_and_links_to_them_are_left_out(self):
        base = self.base_ids()
        target = self.make_page([para("cible")])
        a = self.make_page([para("lien", [link_mark(0, 4, "note", target["id"])])])
        nb = hq_carnet.get_notebook()
        cur = next(p for p in nb["pages"] if p["id"] == target["id"])
        hq_carnet.mutate({"action": "page_trash", "id": target["id"], "expected_rev": cur["rev"], "expected_notebook_rev": nb["notebook_rev"]})
        g = links.graph()
        self.assertEqual({p["id"] for p in g["pages"]}, base | {a["id"]})
        self.assertEqual(g["edges"], [])

    def test_http_query(self):
        self.make_page([para("x")])
        code, body = hq_carnet.http_get({"graph": ["1"]})
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(hq_carnet.http_get({"graph": ["2"]})[0], 400)
        self.assertEqual(hq_carnet.http_get({"graph": ["1"], "meta": ["1"]})[0], 400)

    def test_memo_is_reused(self):
        pages = [self.make_page([para("p%d" % i)]) for i in range(10)]
        links.graph()
        hits = links.stats["hits"]
        links.graph()
        self.assertGreaterEqual(links.stats["hits"] - hits, len(pages), "an unchanged notebook costs one lookup per page")


if __name__ == "__main__":
    unittest.main()
