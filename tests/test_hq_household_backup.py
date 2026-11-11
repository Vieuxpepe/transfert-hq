"""Household integration into HQ run_backup (Gate B).

Offline only: temp dirs, isolated cc_ext / hq_automation state. Never touches
production backup_dir or live Household storage.
"""

from __future__ import annotations

import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import cc_ext
import hq_finances as fin
import hq_household_store as store
import tests.test_backup_retention as _retention


class HouseholdBackupTests(_retention.RetentionBase):
    def setUp(self):
        super().setUp()
        store.set_acl_for_tests(False)
        self.addCleanup(store.set_acl_for_tests, True)
        fin.reset_for_tests()
        self.addCleanup(fin.reset_for_tests)

    def _entry(self, backup_id: str) -> dict:
        return next(e for e in self.index() if e["id"] == backup_id)

    def test_backup_absent_household_is_safe(self):
        info = cc_ext.run_backup(force=True)
        self.assertEqual(info["folders"], 1)
        self.assertEqual(info["household"], {"ok": True, "included": False, "status": "absent"})
        self.assertFalse((Path(info["path"]) / "Household").exists())
        self.assertFalse(store.household_dir(self.root).exists())
        self.assertFalse((self.root / ".hq-inventory").exists())
        self.assertEqual(
            self._entry(info["id"])["household"],
            {"status": "absent", "ok": True, "included": False},
        )

    def test_backup_includes_household_sqlite(self):
        fin.bind(root=self.root, actor=lambda: "tester")
        with store.open_store(self.root) as st:
            with st.transaction():
                hid = fin.ensure_default_household(st.conn)
                fin.create_account(
                    st.conn,
                    hid,
                    {
                        "name": "CAD",
                        "kind": "checking",
                        "currency": "CAD",
                        "opening_balance_cents": 1000,
                    },
                )
        info = cc_ext.run_backup(force=True)
        self.assertEqual(info["folders"], 1)
        hh = info["household"]
        self.assertTrue(hh["ok"] and hh["included"] and hh["valid"])
        self.assertEqual(hh["schema_version"], 7)
        dest = Path(info["path"]) / "Household"
        self.assertTrue((dest / "household.sqlite").is_file())
        self.assertTrue((dest / "household.sqlite.manifest.json").is_file())
        # no sessions / config leakage into Household package
        names = sorted(p.name for p in dest.iterdir())
        self.assertTrue(all(n.startswith("household") or n == "schema_meta.json" for n in names))
        entry = self._entry(info["id"])["household"]
        self.assertEqual(entry["status"], "included")
        self.assertTrue(entry["ok"] and entry["included"] and entry["valid"])
        self.assertEqual(entry["schema_version"], 7)

    def test_retention_runs_when_household_absent(self):
        old = [self.make_backup(_retention.stamp(d)) for d in (100, 200, 300, 400, 500)]
        info = cc_ext.run_backup(force=True)
        self.assertEqual(info["household"]["status"], "absent")
        self.assertNotIn("purge_skipped", info["purge"])
        self.assertEqual(len(info["purge"]["deleted"]), 3)
        self.assertFalse(os.path.lexists(old[-1]))

    def test_household_failure_skips_retention(self):
        old = [self.make_backup(_retention.stamp(d)) for d in (100, 200, 300, 400, 500)]
        with store.open_store(self.root) as st:
            st.set_meta("k", "v")
        with mock.patch.object(store, "snapshot_to", side_effect=OSError("boom")):
            info = cc_ext.run_backup(force=True)
        self.assertTrue(info["ok"])
        self.assertEqual(info["household"]["status"], "failed")
        self.assertEqual(
            info["purge"],
            {"ok": True, "purge_skipped": True, "reason": "household_snapshot_failed", "deleted": []},
        )
        self.assertTrue(all(p.is_dir() for p in old))
        self.assertFalse((Path(info["path"]) / "Household").exists())

    def test_invalid_household_skips_retention_without_publish(self):
        old = [self.make_backup(_retention.stamp(d)) for d in (100, 200, 300)]
        with store.open_store(self.root) as st:
            st.set_meta("k", "v")
        with mock.patch.object(store, "integrity_check", return_value="not ok"):
            info = cc_ext.run_backup(force=True)
        self.assertEqual(info["household"]["status"], "invalid")
        self.assertFalse(info["household"]["valid"])
        self.assertFalse((Path(info["path"]) / "Household").exists())
        self.assertEqual(info["purge"]["reason"], "household_invalid")
        self.assertTrue(all(p.is_dir() for p in old))

    def test_restore_rehearsal_from_hq_backup_package(self):
        with store.open_store(self.root) as st:
            st.set_meta("restore-me", "yes")
        info = cc_ext.run_backup(force=True)
        snap = Path(info["path"]) / "Household" / "household.sqlite"
        dest = self.tmp / "hh-restore-root"
        dest.mkdir()
        restored = store.restore_to_temp(snap, dest_root=dest)
        try:
            self.assertEqual(store.integrity_check(restored.conn), "ok")
            self.assertEqual(restored.get_meta("restore-me"), "yes")
        finally:
            restored.close()
        # never replaces the live root
        with store.open_store(self.root, create=False) as live:
            self.assertEqual(live.get_meta("restore-me"), "yes")


class HouseholdInitSafetyTests(unittest.TestCase):
    """Disposable first-write init path — no production POST."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-hh-init-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "tester", now=lambda: 1_900_000_000.0)

    def tearDown(self):
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def test_get_summary_absent_no_files(self):
        code, body = fin.http_get("/api/finances/summary")
        self.assertEqual(code, 404)
        self.assertEqual(body.get("code"), "store_absent")
        self.assertFalse(store.household_dir(self.root).exists())
        self.assertFalse((self.root / ".hq-inventory").exists())

    def test_first_account_post_inits_v7_without_inventory(self):
        code, body = fin.http_post(
            "/api/finances/accounts",
            {
                "name": "Compte CAD",
                "kind": "checking",
                "currency": "CAD",
                "opening_balance_cents": 5000,
            },
        )
        self.assertEqual(code, 200, body)
        with store.open_store(self.root, create=False) as st:
            self.assertEqual(st.schema_version, 7)
            self.assertEqual(store.integrity_check(st.conn), "ok")
            self.assertEqual(st.conn.execute("SELECT COUNT(*) FROM households").fetchone()[0], 1)
            row = st.conn.execute("SELECT name, currency FROM households").fetchone()
            self.assertEqual((row[0], row[1]), ("Foyer", "CAD"))
            self.assertEqual(st.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0], 0)
            self.assertEqual(st.conn.execute("SELECT COUNT(*) FROM inventoria_sessions").fetchone()[0], 0)
        self.assertFalse((self.root / ".hq-inventory" / "inventory.json").is_file())

    def test_lock_contention_busy_timeout(self):
        with store.open_store(self.root) as st:
            st.set_meta("c", "1")
        errors: list[BaseException] = []

        def worker():
            try:
                with store.open_store(self.root, create=False) as s:
                    s.get_meta("c")
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
