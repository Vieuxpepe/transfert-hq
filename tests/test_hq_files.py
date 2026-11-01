"""Fichiers helpers (hq_files.py): recycle bin with restore, folder peek."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_files as hf  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for d in ("Inbox", "Uni", "Print"):
            (self.root / d).mkdir()
        self.clock = [1790000000.0]
        root = self.root

        def parse_rel(rel):
            parts = [p for p in str(rel).replace("\\", "/").split("/") if p]
            if not parts or parts[0] not in ("Inbox", "Uni", "Print") or any(p in (".", "..") for p in parts):
                return None
            return parts

        def resolve_rel(rel):
            parts = parse_rel(rel)
            if not parts:
                return None
            p = root.joinpath(*parts)
            return p if p.exists() else None

        def writable(rel, create=False):
            parts = parse_rel(rel)
            if not parts:
                return None
            p = root.joinpath(*parts)
            if create:
                p.mkdir(parents=True, exist_ok=True)
            return p if p.is_dir() else None

        def unique(d, name):
            stem, ext = os.path.splitext(name)
            n = 1
            while (d / f"{stem} ({n}){ext}").exists():
                n += 1
            return d / f"{stem} ({n}){ext}"

        hf.bind(root=root, parse_rel=parse_rel, resolve_rel=resolve_rel, resolve_writable_dir=writable, unique_in_dir=unique,
                system_names={"thumbs.db"}, now=lambda: self.clock[0])

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, rel, data=b"x"):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p


class TrashTests(Base):
    def test_trash_and_restore_a_file(self):
        self.put("Uni/Cours/plan.pdf", b"pdf!")
        code, out = hf.http_post({"action": "trash", "rels": ["Uni/Cours/plan.pdf"]})
        self.assertEqual(code, 200)
        item = out["trashed"][0]
        self.assertEqual((item["name"], item["orig"], item["type"], item["size"]), ("plan.pdf", "Uni/Cours/plan.pdf", "file", 4))
        self.assertFalse((self.root / "Uni/Cours/plan.pdf").exists())
        self.assertEqual([i["id"] for i in hf.listing()["items"]], [item["id"]])
        code, out = hf.http_post({"action": "restore", "ids": [item["id"]]})
        self.assertEqual((code, out["restored"][0]["rel"]), (200, "Uni/Cours/plan.pdf"))
        self.assertEqual((self.root / "Uni/Cours/plan.pdf").read_bytes(), b"pdf!")
        self.assertEqual(hf.listing()["items"], [])

    def test_folders_go_whole_and_come_back_whole(self):
        self.put("Inbox/Photos/a.jpg")
        self.put("Inbox/Photos/sous/b.jpg", b"12345")
        out = hf.http_post({"action": "trash", "rels": ["Inbox/Photos"]})[1]["trashed"][0]
        self.assertEqual((out["type"], out["size"]), ("dir", 6))
        hf.http_post({"action": "restore", "ids": [out["id"]]})
        self.assertTrue((self.root / "Inbox/Photos/sous/b.jpg").is_file())

    def test_restore_never_overwrites_and_recreates_missing_folders(self):
        self.put("Uni/A/notes.txt", b"old")
        t = hf.trash("Uni/A/notes.txt")
        self.put("Uni/A/notes.txt", b"new")
        out = hf.restore(t["id"])
        self.assertEqual(out["rel"], "Uni/A/notes (1).txt")
        self.assertEqual((self.root / "Uni/A/notes.txt").read_bytes(), b"new")
        self.put("Uni/B/x.txt")
        t = hf.trash("Uni/B/x.txt")
        os.rmdir(self.root / "Uni/B")
        self.assertEqual(hf.restore(t["id"])["rel"], "Uni/B/x.txt")

    def test_roots_and_bad_paths_are_refused(self):
        for rel in ("Uni", "../etc", "", "Autre/x"):
            code, out = hf.http_post({"action": "trash", "rels": [rel]})
            self.assertEqual(code, 400, rel)
        self.assertEqual(hf.http_post({"action": "trash", "rels": ["Uni/absent.txt"]})[0], 400)
        self.assertEqual(hf.http_post({"action": "restore", "ids": ["../../x"]})[0], 400)

    def test_partial_batches_report_each_item(self):
        self.put("Inbox/a.txt")
        code, out = hf.http_post({"action": "trash", "rels": ["Inbox/a.txt", "Inbox/missing.txt"]})
        self.assertEqual((code, len(out["trashed"]), len(out["failed"])), (200, 1, 1))

    def test_purge_one_and_empty(self):
        self.put("Inbox/a.txt")
        self.put("Inbox/b.txt")
        a = hf.trash("Inbox/a.txt")
        hf.trash("Inbox/b.txt")
        self.assertEqual(hf.http_post({"action": "purge"})[0], 400, "purge needs an id: it never empties the bin")
        self.assertEqual(hf.http_post({"action": "purge", "id": a["id"]})[1]["removed"], 1)
        self.assertFalse((self.root / hf.TRASH_DIR / a["id"]).exists())
        self.assertEqual(hf.http_post({"action": "empty"})[1]["removed"], 1)
        self.assertEqual(hf.listing()["items"], [])

    def test_old_items_expire(self):
        self.put("Inbox/old.txt")
        t = hf.trash("Inbox/old.txt")
        self.clock[0] += (hf.KEEP_DAYS + 1) * 86400
        self.assertEqual(hf.listing()["items"], [])
        self.assertFalse((self.root / hf.TRASH_DIR / t["id"]).exists())

    def test_a_broken_index_is_kept(self):
        self.put("Inbox/a.txt")
        hf.trash("Inbox/a.txt")
        idx = self.root / hf.TRASH_DIR / hf.INDEX
        idx.write_text("{nope", "utf-8")
        self.assertEqual(hf.http_get("/api/files/trash", {})[0], 503)
        self.assertEqual(idx.read_text("utf-8"), "{nope")

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks")
    def test_a_redirected_bin_is_refused(self):
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        try:
            os.symlink(elsewhere, self.root / hf.TRASH_DIR, target_is_directory=True)
        except OSError:
            self.skipTest("no symlink permission")
        self.put("Inbox/a.txt")
        self.assertEqual(hf.http_post({"action": "trash", "rels": ["Inbox/a.txt"]})[0], 400)
        self.assertTrue((self.root / "Inbox/a.txt").exists())
        self.assertEqual(list(elsewhere.iterdir()), [])


class PeekTests(Base):
    def test_counts_and_pictures(self):
        for n in ("a.jpg", "b.PNG", "c.txt", "d.webp", "e.gif", "f.jpeg", ".hidden.jpg", "Thumbs.db"):
            self.put("Inbox/Photos/" + n)
        (self.root / "Inbox/Photos/sous").mkdir()
        code, out = hf.http_get("/api/files/peek", {"rel": ["Inbox/Photos", "Uni", "../x", "Inbox/absent"]})
        self.assertEqual(code, 200)
        ph = out["folders"]["Inbox/Photos"]
        self.assertEqual((ph["files"], ph["dirs"], len(ph["pics"])), (6, 1, 4))
        self.assertTrue(all(p.startswith("Inbox/Photos/") for p in ph["pics"]))
        self.assertEqual(out["folders"]["Uni"], {"files": 0, "dirs": 0, "pics": []})
        self.assertEqual(set(out["folders"]), {"Inbox/Photos", "Uni"})


class WiringTests(unittest.TestCase):
    def test_bridge(self):
        src = (Path(__file__).resolve().parents[1] / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertIn('raw in ("/api/files/trash", "/api/files/peek")', src)
        self.assertIn('raw == "/api/files"', src)
        self.assertIn('<script src="/assets/hq-files.js"></script>', src)


if __name__ == "__main__":
    unittest.main()
