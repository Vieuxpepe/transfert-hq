"""Projets store (hq_projects.py): projects, milestones, parts list, links, timeline, and the shared Kanban board."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_inventory as inv  # noqa: E402
import hq_projects as prj  # noqa: E402

ASSET = "asset-" + "a" * 24


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        inv.bind(root=self.root, now=lambda: 1790000000.0, asset_exists=lambda a: a == ASSET)
        prj.bind(root=self.root, now=lambda: 1790000000.0, asset_exists=lambda a: a == ASSET,
                 inventory_adjust=lambda i, d: inv.apply({"action": "item.adjust", "id": i, "delta": d})["item"])
        self.kanban = self.root / "kanban.json"

    def tearDown(self):
        self.tmp.cleanup()

    def new(self, name="Robot", **kw):
        return prj.apply(dict({"action": "project.create", "name": name}, **kw))["project"]

    def act(self, p, action, **kw):
        out = prj.apply(dict({"action": action, "id": p["id"], "rev": p["rev"]}, **kw))
        return out

    def err(self, data):
        with self.assertRaises(prj.ProjectError) as cm:
            prj.apply(data)
        return cm.exception


class ProjectTests(Base):
    def test_create_and_fields(self):
        p = self.new("Bras robot", goal="Un bras 4 axes", start="2026-11-01", due="2027-01-15", status="idea", hue=210)
        self.assertEqual((p["name"], p["status"], p["hue"], p["due"], p["rev"]), ("Bras robot", "idea", 210, "2027-01-15", 1))
        self.assertEqual(self.err({"action": "project.create", "name": "x", "start": "2027-01-02", "due": "2026-01-01"}).status, 400)
        self.assertEqual(self.err({"action": "project.create", "name": "x", "due": "15/01/2027"}).status, 400)
        self.assertEqual(self.err({"action": "project.create", "name": "  "}).status, 400)
        self.assertEqual(self.err({"action": "project.create", "name": "x", "status": "zombie"}).status, 400)

    def test_revisions(self):
        p = self.new()
        q = self.act(p, "project.update", name="Robot 2")["project"]
        self.assertEqual(q["rev"], 2)
        e = self.err({"action": "project.update", "id": p["id"], "rev": 1, "name": "x"})
        self.assertEqual((e.status, e.extra["project"]["name"]), (409, "Robot 2"))

    def test_milestones(self):
        p = self.new()
        out = self.act(p, "milestone.add", milestone={"title": "Châssis", "due": "2026-12-01"})
        m = out["milestone"]
        p = out["project"]
        out = self.act(p, "milestone.update", sub=m["id"], milestone={"done": True})
        self.assertEqual((out["milestone"]["title"], out["milestone"]["done"]), ("Châssis", True))
        p = out["project"]
        p = self.act(p, "milestone.add", milestone={"title": "Électronique"})["project"]
        p = self.act(p, "milestone.move", sub=p["milestones"][1]["id"], index=0)["project"]
        self.assertEqual([x["title"] for x in p["milestones"]], ["Électronique", "Châssis"])

    def test_bom_uses_inventory_stock_once(self):
        item = inv.apply({"action": "item.create", "name": "Servo MG996R", "qty": 6, "unit": "pcs"})["item"]
        p = self.new()
        out = self.act(p, "bom.add", bom={"name": "Servo", "item": item["id"], "qty": 4, "cost": 899})
        line, p = out["bom"], out["project"]
        self.assertEqual((line["status"], line["used"], line["cost"]), ("need", False, 899))
        out = self.act(p, "bom.use", sub=line["id"])
        self.assertEqual(out["inventory_item"]["qty"], 2)
        self.assertEqual((out["bom"]["used"], out["bom"]["status"]), (True, "have"))
        self.assertEqual(self.err({"action": "bom.use", "id": p["id"], "rev": out["project"]["rev"], "sub": line["id"]}).code, "already_used")
        self.assertEqual(inv.snapshot()["items"][0]["qty"], 2, "stock taken once")

    def test_bom_use_with_a_vanished_item_changes_nothing(self):
        item = inv.apply({"action": "item.create", "name": "Vis", "qty": 6})["item"]
        p = self.new()
        out = self.act(p, "bom.add", bom={"name": "Vis", "item": item["id"], "qty": 4})
        inv.apply({"action": "item.delete", "id": item["id"], "rev": item["rev"]})
        code, body = prj.http_post({"action": "bom.use", "id": p["id"], "rev": out["project"]["rev"], "sub": out["bom"]["id"]})
        self.assertEqual(code, 404)
        self.assertFalse(prj.snapshot()["projects"][0]["bom"][0]["used"])

    def test_links(self):
        p = self.new()
        p = self.act(p, "link.add", link={"kind": "carnet", "ref": "page-abc", "title": "Notes de conception"})["project"]
        p = self.act(p, "link.add", link={"kind": "file", "ref": "Uni/GIA1077/plan.pdf"})["project"]
        self.assertEqual(self.err({"action": "link.add", "id": p["id"], "rev": p["rev"], "link": {"kind": "carnet", "ref": "page-abc"}}).code, "exists")
        for bad in ({"kind": "file", "ref": "../secret"}, {"kind": "file", "ref": "/etc/passwd"}, {"kind": "file", "ref": "a/../../b"},
                    {"kind": "web", "ref": "x"}, {"kind": "carnet", "ref": "javascript:alert(1)"}):
            self.assertEqual(self.err({"action": "link.add", "id": p["id"], "rev": p["rev"], "link": bad}).status, 400, bad)

    def test_timeline(self):
        p = self.new()
        p = self.act(p, "entry.add", entry={"text": "Premier montage", "photos": [ASSET]})["project"]
        p = self.act(p, "entry.add", entry={"text": "Avant", "at": 1789000000.0})["project"]
        self.assertEqual([e["text"] for e in p["timeline"]], ["Avant", "Premier montage"], "kept in time order")
        self.assertEqual(self.err({"action": "entry.add", "id": p["id"], "rev": p["rev"], "entry": {}}).status, 400)
        self.assertEqual(self.err({"action": "entry.add", "id": p["id"], "rev": p["rev"], "entry": {"photos": ["asset-" + "b" * 24]}}).code, "missing_photo")

    def test_delete_and_restore(self):
        p = self.new()
        p = self.act(p, "milestone.add", milestone={"title": "A"})["project"]
        gone = self.act(p, "project.delete")["deleted"]
        self.assertEqual(prj.snapshot()["projects"], [])
        back = prj.apply({"action": "project.restore", "project": gone})["project"]
        self.assertEqual(back, gone)

    def test_resume_note(self):
        p = self.new()
        self.assertEqual((p["resume"], p["resume_at"]), ("", None))
        out = prj.apply({"action": "project.resume", "id": p["id"], "text": "  Je câblais l'épaule.\nProchaine étape : ressort.  "})
        self.assertEqual((out["project"]["resume"], out["project"]["resume_at"], out["project"]["rev"]), ("Je câblais l'épaule.\nProchaine étape : ressort.", 1790000000.0, 2))
        out = prj.apply({"action": "project.resume", "id": p["id"], "text": "Encore", "rev": 1})  # no revision needed: last words win
        self.assertEqual(out["project"]["resume"], "Encore")
        self.assertIsNone(prj.apply({"action": "project.resume", "id": p["id"], "text": ""})["project"]["resume_at"])
        self.assertEqual(self.err({"action": "project.resume", "id": p["id"], "text": "x" * 1001}).status, 400)

    def test_older_files_gain_the_resume_note(self):
        p = self.new()
        path = prj.projects_path(self.root)
        doc = json.loads(path.read_text("utf-8"))
        for x in doc["projects"]:
            del x["resume"], x["resume_at"]
        path.write_text(json.dumps(doc), "utf-8")
        self.assertEqual(prj.snapshot()["projects"][0]["resume"], "")
        self.assertEqual(prj.apply({"action": "project.resume", "id": p["id"], "text": "ok"})["project"]["resume"], "ok")

    def test_malformed_file_is_kept(self):
        path = prj.projects_path(self.root)
        path.parent.mkdir(parents=True)
        path.write_bytes(b"[]")
        self.assertEqual(prj.http_post({"action": "project.create", "name": "x"})[0], 503)
        self.assertEqual(path.read_bytes(), b"[]")


class TaskTests(Base):
    def test_cards_live_on_the_existing_board(self):
        p = self.new()
        out = prj.apply({"action": "task.create", "title": "Couper les profilés", "project": p["id"], "due": "2026-11-10"})
        t = out["task"]
        board = json.loads(self.kanban.read_text("utf-8"))
        self.assertEqual([c["id"] for c in board["columns"]], ["todo", "doing", "done"])
        card = board["columns"][0]["cards"][0]
        self.assertEqual((card["title"], card["project"], card["due"]), ("Couper les profilés", p["id"], "2026-11-10"))
        out = prj.apply({"action": "task.move", "id": t["id"], "column": "doing"})
        self.assertEqual(out["task"]["column"], "doing")

    def test_free_tasks_and_unknown_projects(self):
        out = prj.apply({"action": "task.create", "title": "Libre"})
        self.assertNotIn("project", out["task"])
        self.assertEqual(self.err({"action": "task.create", "title": "x", "project": "prj-" + "0" * 16}).status, 404)

    def test_milestone_needs_a_project(self):
        self.assertEqual(self.err({"action": "task.create", "title": "x", "milestone": "mst-" + "0" * 10}).status, 400)

    def test_delete_and_restore_in_place(self):
        a = prj.apply({"action": "task.create", "title": "A"})["task"]
        prj.apply({"action": "task.create", "title": "B"})
        gone = prj.apply({"action": "task.delete", "id": a["id"]})["deleted"]
        self.assertEqual(gone["index"], 1)
        out = prj.apply({"action": "task.restore", "task": gone, "index": gone["index"]})
        self.assertEqual([t["title"] for t in out["tasks"]], ["B", "A"])

    def test_old_cards_without_new_fields_are_read(self):
        self.kanban.write_text(json.dumps({"columns": [{"id": "todo", "title": "À faire", "cards": []},
                                                       {"id": "doing", "title": "En cours", "cards": [{"id": "c-1790395795045", "title": "Test card", "created": 1790395795.04}]},
                                                       {"id": "done", "title": "Fait", "cards": []}]}), "utf-8")
        code, out = prj.http_get({})
        self.assertEqual(out["tasks"], [{"id": "c-1790395795045", "column": "doing", "title": "Test card", "created": 1790395795.04}])

    def test_malformed_board_is_never_rewritten(self):
        for raw in (b"{not json", b'{"columns": []}', b'{"columns": [{"id": "todo", "cards": []}]}', b'{"columns": [{"id": "todo", "cards": [1]}]}'):
            self.kanban.write_bytes(raw)
            code, body = prj.http_post({"action": "task.create", "title": "x"})
            self.assertEqual((code, body["code"]), (503, "board_unreadable"), raw)
            self.assertEqual(self.kanban.read_bytes(), raw)
            code, body = prj.http_get({})
            self.assertEqual((code, body["tasks"]), (200, []))
            self.assertIn("tasks_error", body)


class WiringTests(unittest.TestCase):
    def test_bridge(self):
        src = (Path(__file__).resolve().parents[1] / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertEqual(src.count('raw == "/api/projects"'), 2)
        self.assertIn('<script src="/assets/hq-projects.js"></script>', src)
        self.assertIn('data-nav="projets"', src)
        self.assertIn('data-panel="projets"', src)


if __name__ == "__main__":
    unittest.main()
