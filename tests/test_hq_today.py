"""Accueil 'Aujourd'hui' > 'Depuis hier': the pure builder, the bounded Inbox scan and /api/today.
Disposable root, fake PINs, no Forge; never the live root."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_today as T  # noqa: E402

NOW = 1_800_000_000.0
H = 3600


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class Build(unittest.TestCase):
    def kinds(self, out):
        return [item["kind"] for item in out["items"]]

    def test_empty(self):
        self.assertEqual(T.build(now=NOW)["items"], [])

    def test_each_source_is_counted_newest_first(self):
        out = T.build(
            now=NOW,
            inbox=[NOW - 2 * H, NOW - 3 * H, NOW - 30 * H],
            jobs=[{"state": "completed", "updated": iso(NOW - H), "images": [{}, {}]},
                  {"state": "completed", "updated": iso(NOW - 5 * H), "images": [{}]},
                  {"state": "failed", "updated": iso(NOW - 4 * H), "images": []},
                  {"state": "completed", "updated": iso(NOW - 40 * H), "images": [{}]}],
            pages=[{"updated_at": NOW - 6 * H, "deleted_at": None}, {"updated_at": NOW - 7 * H, "deleted_at": None},
                   {"updated_at": NOW - 6 * H, "deleted_at": NOW - H}, {"updated_at": NOW - 50 * H, "deleted_at": None}],
            devices=[{"name": "Bureau", "online": False, "last_seen": NOW - 8 * H},
                     {"name": "Salon", "online": True, "last_seen": NOW},
                     {"name": "Vieux", "online": False, "last_seen": NOW - 90 * H},
                     {"name": "Retiré", "online": False, "revoked": True, "last_seen": NOW - H}],
            events=[{"kind": "backup", "level": "info", "ts": NOW - 9 * H},
                    {"kind": "alert", "level": "warning", "ts": NOW - 10 * H},
                    {"kind": "alert", "level": "warning", "ts": NOW - 11 * H},
                    {"kind": "alert", "level": "info", "ts": NOW - 11 * H},
                    {"kind": "scene", "level": "info", "ts": NOW - 12 * H},
                    {"kind": "screenshot", "level": "info", "ts": NOW - H}],
        )
        texts = {item["kind"]: item["text"] for item in out["items"]}
        self.assertEqual(self.kinds(out), ["forge", "inbox", "forge_failed", "carnet", "device", "backup", "alert", "runs"])
        self.assertEqual(texts["inbox"], "2 fichiers arrivés dans Inbox")
        self.assertEqual(texts["forge"], "Forge : 3 images terminées")
        self.assertEqual(texts["forge_failed"], "Forge : 1 génération a échoué")
        self.assertEqual(texts["carnet"], "Carnet : 2 pages modifiées")
        self.assertEqual(texts["device"], "Bureau hors ligne")
        self.assertEqual(texts["backup"], "Sauvegarde terminée")
        self.assertEqual(texts["alert"], "2 alertes dans le journal")
        self.assertEqual(texts["runs"], "1 scène ou automatisme lancé")
        levels = {item["kind"]: item["level"] for item in out["items"]}
        self.assertEqual({k for k, v in levels.items() if v == "warn"}, {"forge_failed", "device", "alert"})
        navs = {item["kind"]: item["nav"] for item in out["items"]}
        self.assertEqual((navs["inbox"], navs["forge"], navs["carnet"], navs["device"], navs["backup"]), ("fichiers", "forge", "carnet", "", "ops"))

    def test_private_jobs_never_counted(self):
        out = T.build(now=NOW, jobs=[{"state": "completed", "destination": "private", "updated": iso(NOW - H), "images": [{}]},
                                      {"state": "failed", "destination": "private", "updated": iso(NOW - H)}])
        self.assertEqual(out["items"], [])

    def test_backup_problem_and_singulars(self):
        out = T.build(now=NOW, inbox=[NOW - 1], pages=[{"updated_at": NOW - 1, "deleted_at": None}],
                      events=[{"kind": "backup", "level": "info", "ts": NOW - 5 * H}, {"kind": "backup", "level": "warning", "ts": NOW - H},
                              {"kind": "alert", "level": "error", "ts": NOW - H}])
        texts = {item["kind"]: item["text"] for item in out["items"]}
        self.assertEqual(texts["backup"], "Sauvegarde : problème signalé")
        self.assertEqual(texts["inbox"], "1 fichier arrivé dans Inbox")
        self.assertEqual(texts["carnet"], "Carnet : 1 page modifiée")
        self.assertEqual(texts["alert"], "1 alerte dans le journal")

    def test_bad_rows_are_ignored(self):
        out = T.build(now=NOW, inbox=["x", None, True], jobs=[None, "x", {"state": "completed", "updated": "not a date"}],
                      pages=[None, {"updated_at": "x"}], devices=[None, {"online": False, "last_seen": "x"}], events=[None, {"kind": "alert"}])
        self.assertEqual(out["items"], [])

    def test_iso_with_offset_and_numeric_times(self):
        self.assertAlmostEqual(T._ts("2026-10-28T10:00:00+02:00"), datetime(2026, 10, 28, 8, tzinfo=timezone.utc).timestamp())
        self.assertEqual(T._ts(12.5), 12.5)
        self.assertIsNone(T._ts(True))

    def test_items_are_bounded(self):
        devices = [{"name": "PC%d" % i, "online": False, "last_seen": NOW - i} for i in range(1, 30)]
        self.assertEqual(len(T.build(now=NOW, devices=devices)["items"]), T.MAX_ITEMS)

    def test_no_names_or_text_leak(self):
        out = T.build(now=NOW, pages=[{"updated_at": NOW - 1, "deleted_at": None, "title": "Secret plan", "content": "x"}],
                      jobs=[{"state": "completed", "updated": iso(NOW - 1), "images": [{}], "settings": {"prompt": "a red fox"}}])
        raw = json.dumps(out)
        self.assertNotIn("Secret plan", raw)
        self.assertNotIn("red fox", raw)


class InboxScan(unittest.TestCase):
    def test_top_and_one_level_hidden_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            inbox = Path(tmp)
            (inbox / "a.png").write_bytes(b"x")
            (inbox / ".hidden").write_bytes(b"x")
            (inbox / "_tmp.bin").write_bytes(b"x")
            (inbox / "Captures").mkdir()
            (inbox / "Captures" / "b.png").write_bytes(b"x")
            (inbox / "Captures" / "deep").mkdir()
            (inbox / "Captures" / "deep" / "c.png").write_bytes(b"x")
            (inbox / "_private").mkdir()
            (inbox / "_private" / "d.png").write_bytes(b"x")
            old = inbox / "old.png"
            old.write_bytes(b"x")
            os.utime(old, (time.time() - 3 * 86400,) * 2)
            found = T.inbox_times(inbox, time.time() - 3600)
            self.assertEqual(len(found), 2)  # a.png and Captures/b.png

    def test_limit_and_missing_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(20):
                (Path(tmp) / f"f{i}.txt").write_bytes(b"x")
            self.assertLessEqual(len(T.inbox_times(Path(tmp), 0, limit=5)), 5)
        self.assertEqual(T.inbox_times(Path(tmp) / "nope", 0), [])


try:
    from test_hq_forge_vault_multi_http import MultiHttp  # noqa: E402
    import hq_forge_jobs as J  # noqa: E402
    import iphone_bridge as B  # noqa: E402
except ImportError:  # pragma: no cover
    MultiHttp = None

if MultiHttp is not None:
    class Route(MultiHttp):
        def test_admin_only(self):
            self.assertEqual(self.anon.req("/api/today")[0], 401)
            self.assertEqual(self.upload.req("/api/today")[0], 403)
            status, body = self.admin.json("/api/today")
            self.assertEqual(status, 200, body)
            self.assertEqual(set(body), {"since", "now", "items", "missing"})
            self.assertAlmostEqual(body["now"] - body["since"], T.WINDOW_SEC)

        def test_inbox_file_shows_up_and_a_failing_source_is_left_out(self):
            (B.ROOT / "Inbox" / "photo.jpg").write_bytes(b"x")
            saved = J.summary_rows
            J.summary_rows = lambda root: (_ for _ in ()).throw(RuntimeError("boom"))
            try:
                body = self.admin.json("/api/today")[1]
            finally:
                J.summary_rows = saved
                (B.ROOT / "Inbox" / "photo.jpg").unlink()
            self.assertIn("jobs", body["missing"])
            self.assertIn("1 fichier arrivé dans Inbox", [item["text"] for item in body["items"]])
            self.assertNotIn("photo.jpg", json.dumps(body))

        def test_private_jobs_stay_out_of_the_summary_rows(self):
            store = B.ROOT / ".hq-forge" / "jobs.json"
            store.parent.mkdir(exist_ok=True)
            when = iso(time.time() - 60)
            store.write_text(json.dumps({"idempotency": {}, "jobs": [
                {"id": "a", "state": "completed", "destination": "normal", "updated": when, "images": [{"id": "x"}], "settings": {"prompt": "a red fox"}},
                {"id": "b", "state": "completed", "destination": "private", "updated": when, "images": [{"id": "y"}, {"id": "z"}]},
            ]}), encoding="utf-8")
            try:
                rows = J.summary_rows(B.ROOT)
                body = self.admin.json("/api/today")[1]
            finally:
                store.unlink()
            self.assertEqual(rows, [{"state": "completed", "created": None, "updated": when, "images": [{}]}])
            self.assertIn("Forge : 1 image terminée", [item["text"] for item in body["items"]])
            self.assertNotIn("red fox", json.dumps(body))


if __name__ == "__main__":
    unittest.main()
