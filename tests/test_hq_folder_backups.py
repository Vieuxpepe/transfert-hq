"""Automatic folder backups (hq_folder_backups.py): rolling window, unchanged skip, safe purge, restore, schedule."""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_folder_backups as fb  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.root = base / "Transfert"
        self.drive = base / "Backups"
        for d in ("Inbox", "Uni", "Print"):
            (self.root / d).mkdir(parents=True)
        self.clock = [1790000000.0]
        self.target = {"ok": True, "dir": str(self.drive)}
        self.paused = [False]
        self.alerts = []
        root = self.root

        def parse_rel(rel):
            parts = [p for p in str(rel).replace("\\", "/").split("/") if p]
            if not parts or parts[0] not in ("Inbox", "Uni", "Print") or any(p in (".", "..") for p in parts):
                return None
            return parts

        def resolve_dir(rel):
            parts = parse_rel(rel)
            p = root.joinpath(*parts) if parts else None
            return p if p and p.is_dir() else None

        def writable(rel, create=False):
            parts = parse_rel(rel)
            if not parts:
                return None
            p = root.joinpath(*parts)
            if create:
                p.mkdir(parents=True, exist_ok=True)
            return p if p.is_dir() else None

        def unique(d, name):
            n = 1
            while (d / f"{name} ({n})").exists():
                n += 1
            return d / f"{name} ({n})"

        def remove(path):
            for dp, dn, fn in os.walk(path):
                for n in dn + fn:
                    if os.path.islink(os.path.join(dp, n)):
                        return "lien"
            shutil.rmtree(path)
            return None

        fb._queued.clear()
        fb._running.clear()
        fb.bind(root=root, parse_rel=parse_rel, resolve_dir=resolve_dir, resolve_writable_dir=writable, unique_in_dir=unique,
                target=lambda: dict(self.target), paused=lambda: self.paused[0], remove_folder=remove, system_names={"thumbs.db"},
                alert=lambda t, d: self.alerts.append(d), log=lambda *a: None, now=lambda: self.clock[0], sync=True)

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, rel, data=b"x"):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p

    def create(self, rel="Uni/GIA1077", **kw):
        code, out = fb.http_post({"action": "create", "rel": rel, **kw})
        self.assertEqual(code, 200, out)
        return out["job"]

    def job(self, jid):
        return next(j for j in fb.listing()["jobs"] if j["id"] == jid)

    def tick_after(self, seconds, change=None):
        self.clock[0] += seconds
        if change:
            change()
        return fb.tick()


class BackupTests(Base):
    def test_first_copy_is_made_right_away_with_the_folder_inside(self):
        self.put("Uni/GIA1077/notes.md", b"chapitre 4")
        self.put("Uni/GIA1077/Labos/lab1.xlsx", b"12345")
        self.put("Uni/GIA1077/Thumbs.db")
        self.put("Uni/GIA1077/.hq-cache/x")
        job = self.create(keep=10)
        self.assertEqual((job["every"], job["keep"]), ("day", 10))
        snaps = self.job(job["id"])["snapshots"]
        self.assertEqual(len(snaps), 1)
        copy = self.drive / "Dossiers" / job["dir"] / snaps[0]["id"] / "GIA1077"
        self.assertEqual((copy / "notes.md").read_bytes(), b"chapitre 4")
        self.assertEqual((copy / "Labos" / "lab1.xlsx").read_bytes(), b"12345")
        self.assertFalse((copy / "Thumbs.db").exists())
        self.assertFalse((copy / ".hq-cache").exists())
        self.assertEqual((snaps[0]["files"], snaps[0]["bytes"]), (2, 15))
        self.assertTrue(job["dir"].startswith("GIA1077 (bk-"))

    def test_rolling_window_keeps_the_newest_ten(self):
        self.put("Inbox/Cours/a.txt", b"0")
        job = self.create("Inbox/Cours", every="hour")
        for i in range(1, 14):
            self.assertEqual(self.tick_after(3600, lambda: self.put("Inbox/Cours/a.txt", str(i).encode())), 1)
        snaps = self.job(job["id"])["snapshots"]
        self.assertEqual(len(snaps), 10)
        newest = self.drive / "Dossiers" / job["dir"] / snaps[0]["id"] / "Cours" / "a.txt"
        self.assertEqual(newest.read_bytes(), b"13")
        oldest = self.drive / "Dossiers" / job["dir"] / snaps[-1]["id"] / "Cours" / "a.txt"
        self.assertEqual(oldest.read_bytes(), b"4")
        self.assertEqual(sorted(p.name for p in (self.drive / "Dossiers" / job["dir"]).iterdir()), sorted(s["id"] for s in snaps))

    def test_unchanged_folders_are_not_copied_again(self):
        self.put("Uni/GIA1077/a.txt")
        job = self.create(every="hour")
        for _ in range(3):
            self.tick_after(3600)
        j = self.job(job["id"])
        self.assertEqual((len(j["snapshots"]), j["last_result"]), (1, "unchanged"))
        self.tick_after(3600, lambda: self.put("Uni/GIA1077/b.txt"))
        self.assertEqual(len(self.job(job["id"])["snapshots"]), 2)

    def test_schedule(self):
        self.put("Uni/GIA1077/a.txt")
        job = self.create(every="day")
        self.assertEqual(self.tick_after(3600 * 23, lambda: self.put("Uni/GIA1077/b.txt")), 0, "not due yet")
        self.assertEqual(self.tick_after(3600 * 2), 1)
        self.assertEqual(len(self.job(job["id"])["snapshots"]), 2)
        self.paused[0] = True
        self.assertEqual(self.tick_after(86400 * 3, lambda: self.put("Uni/GIA1077/c.txt")), 0, "backup_auto_paused stops automatic runs")
        self.assertEqual(fb.http_post({"action": "run", "id": job["id"]})[0], 202, "« Sauvegarder maintenant » still runs")
        self.assertEqual(len(self.job(job["id"])["snapshots"]), 3)
        self.paused[0] = False
        fb.http_post({"action": "update", "id": job["id"], "enabled": False})
        self.assertEqual(self.tick_after(86400 * 9), 0, "a paused job never runs")

    def test_lowering_keep_trims_at_once(self):
        self.put("Uni/GIA1077/a.txt")
        job = self.create(every="hour")
        for i in range(5):
            self.tick_after(3600, lambda: self.put("Uni/GIA1077/a.txt", str(i).encode()))
        self.assertEqual(len(self.job(job["id"])["snapshots"]), 6)
        code, _ = fb.http_post({"action": "update", "id": job["id"], "keep": 2})
        self.assertEqual(code, 200)
        self.assertEqual(len(self.job(job["id"])["snapshots"]), 2)

    def test_the_purge_touches_only_this_jobs_marked_copies(self):
        self.put("Uni/GIA1077/a.txt")
        job = self.create(every="hour", keep=1)
        jdir = self.drive / "Dossiers" / job["dir"]
        stranger = jdir / "20200101_000000"  # stamp name but no marker
        stranger.mkdir()
        (stranger / "mine.txt").write_text("keep me")
        foreign = jdir / "20200102_000000"
        foreign.mkdir()
        (foreign / fb.MARKER).write_text(json.dumps({"job": "bk-00000000", "id": "20200102_000000"}))
        (jdir / "notes perso").mkdir()
        self.tick_after(3600, lambda: self.put("Uni/GIA1077/a.txt", b"2"))
        self.assertEqual(len(self.job(job["id"])["snapshots"]), 1)
        self.assertTrue((stranger / "mine.txt").exists() and foreign.exists() and (jdir / "notes perso").exists())

    def test_a_half_copy_never_counts_and_is_cleaned(self):
        self.put("Uni/GIA1077/a.txt")
        job = self.create(every="hour")
        jdir = self.drive / "Dossiers" / job["dir"]
        (jdir / "20200101_000000.partial" / "GIA1077").mkdir(parents=True)
        self.assertEqual(len(self.job(job["id"])["snapshots"]), 1)
        self.tick_after(3600, lambda: self.put("Uni/GIA1077/a.txt", b"2"))
        self.assertFalse((jdir / "20200101_000000.partial").exists())

    def test_failures_are_recorded_alert_once_and_retry_hourly(self):
        self.put("Uni/GIA1077/a.txt")
        job = self.create(every="hour")
        self.target.update(ok=False, error="Lecteur D: introuvable")
        self.tick_after(3600, lambda: self.put("Uni/GIA1077/b.txt"))
        self.tick_after(3600)
        j = self.job(job["id"])
        self.assertIn("introuvable", j["last_error"])
        self.assertEqual(len(self.alerts), 1, "one alert until it works again")
        self.target.update(ok=True, error=None)
        self.tick_after(3600)
        j = self.job(job["id"])
        self.assertIsNone(j["last_error"])
        self.assertEqual(len(j["snapshots"]), 2)

    def test_missing_folder(self):
        self.put("Uni/GIA1077/a.txt")
        job = self.create(every="hour")
        shutil.rmtree(self.root / "Uni/GIA1077")
        self.tick_after(3600)
        j = self.job(job["id"])
        self.assertTrue(j["missing"])
        self.assertIn("introuvable", j["last_error"])
        self.assertEqual(len(j["snapshots"]), 1, "old copies are never touched when the folder is gone")

    def test_destination_inside_the_folder_is_refused(self):
        self.put("Uni/a.txt")
        self.target["dir"] = str(self.root / "Uni" / "Backups")
        code, out = fb.http_post({"action": "create", "rel": "Uni"})
        self.assertEqual(code, 200)
        j = self.job(out["job"]["id"])
        self.assertIn("refusé", j["last_error"])

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks")
    def test_links_are_not_followed(self):
        outside = Path(self.tmp.name) / "secret"
        outside.mkdir()
        (outside / "s.txt").write_text("secret")
        self.put("Uni/GIA1077/a.txt")
        try:
            os.symlink(outside, self.root / "Uni/GIA1077/lien", target_is_directory=True)
        except OSError:
            self.skipTest("no symlink permission")
        job = self.create()
        snap = self.job(job["id"])["snapshots"][0]
        self.assertFalse((self.drive / "Dossiers" / job["dir"] / snap["id"] / "GIA1077" / "lien").exists())
        self.assertEqual(snap["files"], 1)


class ApiTests(Base):
    def test_validation(self):
        self.put("Uni/GIA1077/a.txt")
        for bad in ({"rel": "../x"}, {"rel": "Uni/absent"}, {"rel": "Uni/GIA1077", "every": "minute"}, {"rel": "Uni/GIA1077", "keep": 0},
                    {"rel": "Uni/GIA1077", "keep": 51}, {"rel": "Uni/GIA1077", "keep": True}, {"rel": "Uni/GIA1077", "keep": 2.5}):
            code, _ = fb.http_post({"action": "create", **bad})
            self.assertIn(code, (400, 404), bad)
        self.create()
        self.assertEqual(fb.http_post({"action": "create", "rel": "Uni/GIA1077"})[0], 409)
        self.assertEqual(fb.http_post({"action": "run", "id": "bk-zz"})[0], 400)
        self.assertEqual(fb.http_post({"action": "nope"})[0], 400)

    def test_delete_keeps_or_drops_copies(self):
        self.put("Uni/GIA1077/a.txt")
        self.put("Uni/MEC/a.txt")
        a = self.create()
        b = self.create("Uni/MEC")
        fb.http_post({"action": "delete", "id": a["id"]})
        self.assertTrue((self.drive / "Dossiers" / a["dir"]).is_dir(), "copies kept by default")
        fb.http_post({"action": "delete", "id": b["id"], "copies": True})
        self.assertFalse((self.drive / "Dossiers" / b["dir"]).exists())
        self.assertEqual(fb.listing()["jobs"], [])

    def test_restore_comes_back_beside_the_folder(self):
        self.put("Uni/GIA1077/notes.md", b"v1")
        job = self.create(every="hour")
        snap = self.job(job["id"])["snapshots"][0]["id"]
        self.put("Uni/GIA1077/notes.md", b"v2 ruined")
        code, _ = fb.http_post({"action": "restore", "id": job["id"], "snap": snap})
        self.assertEqual(code, 202)
        rel = self.job(job["id"])["last_restore"]["rel"]
        self.assertTrue(rel.startswith("Uni/GIA1077 (sauvegarde du "), rel)
        self.assertEqual((self.root / rel / "notes.md").read_bytes(), b"v1")
        self.assertEqual((self.root / "Uni/GIA1077/notes.md").read_bytes(), b"v2 ruined", "never overwrites")
        fb.http_post({"action": "restore", "id": job["id"], "snap": snap})
        self.assertTrue(self.job(job["id"])["last_restore"]["rel"].endswith("(1)"))
        self.assertEqual(fb.http_post({"action": "restore", "id": job["id"], "snap": "20000101_000000"})[0], 404)

    def test_a_root_restores_inside_itself(self):
        self.put("Print/a.pdf", b"%PDF")
        job = self.create("Print")
        snap = self.job(job["id"])["snapshots"][0]["id"]
        fb.http_post({"action": "restore", "id": job["id"], "snap": snap})
        rel = self.job(job["id"])["last_restore"]["rel"]
        self.assertTrue(rel.startswith("Print/Print (sauvegarde du "), rel)

    def test_jobs_follow_renames_and_moves(self):
        self.put("Uni/GIA1077/a.txt")
        self.put("Uni/GIA1077/Labos/b.txt")
        a = self.create()
        b = self.create("Uni/GIA1077/Labos")
        self.assertEqual(fb.moved("Uni/GIA1077", "Uni/2026/GIA1077 - Statique"), 2)
        jobs = {j["id"]: j for j in fb.listing()["jobs"]}
        self.assertEqual(jobs[a["id"]]["rel"], "Uni/2026/GIA1077 - Statique")
        self.assertEqual(jobs[a["id"]]["name"], "GIA1077 - Statique")
        self.assertEqual(jobs[b["id"]]["rel"], "Uni/2026/GIA1077 - Statique/Labos")
        self.assertEqual(jobs[a["id"]]["dir"], a["dir"], "copies stay in the same backup folder")
        self.assertEqual(fb.moved("Uni/GIA", "Uni/X"), 0, "a prefix of a name is not the folder")

    def test_a_broken_jobs_file_is_kept(self):
        self.put("Uni/GIA1077/a.txt")
        self.create()
        p = self.root / fb.STORE_DIR / fb.JOBS
        p.write_text("{oops", "utf-8")
        self.assertEqual(fb.http_get({})[0], 503)
        self.assertEqual(fb.tick(), 0)
        self.assertEqual(fb.moved("Uni/GIA1077", "Uni/X"), 0)
        self.assertEqual(p.read_text("utf-8"), "{oops")

    def test_pure_helpers(self):
        self.assertEqual(fb.stamp_label("20261031_164900"), "31 oct. 2026 16 h 49")
        self.assertEqual(fb.label_for('Plans: v2/"final"'), "Plans_ v2__final_")
        self.assertFalse(fb.due({"enabled": False}, 1e12))
        self.assertTrue(fb.due({"every": "hour", "last_run_at": 0}, 3600))
        self.assertFalse(fb.due({"every": "week", "last_run_at": 0, "last_try_at": 7 * 86400 - 10}, 7 * 86400 + 60), "retry waits an hour")


class WiringTests(unittest.TestCase):
    def test_bridge(self):
        src = (Path(__file__).resolve().parents[1] / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertIn('raw == "/api/backups/folders"', src)
        self.assertIn("hq_folder_backups.tick()", src)
        self.assertIn("hq_folder_backups.moved(", src)


if __name__ == "__main__":
    unittest.main()
