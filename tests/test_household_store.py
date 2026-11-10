"""Household SQLite shell — storage, ACL, migrate, backup (PR #31)."""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import hq_household_schemas as schemas
import hq_household_store as store


class ImportSideEffectTests(unittest.TestCase):
    def test_import_creates_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "absent-root"
            self.assertFalse(store.household_dir(root).exists())
            # Re-import path already loaded; assert helpers are pure
            self.assertFalse(store.db_path(root).exists())


class StoreLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-hh-")
        self.root = Path(self.tmp.name)
        if os.name != "nt":
            store.set_acl_for_tests(True)

    def tearDown(self):
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def test_init_blank_root(self):
        with store.open_store(self.root) as st:
            self.assertEqual(st.schema_version, 1)
            self.assertEqual(store.get_schema_version(st.conn), 1)
            self.assertEqual(store.integrity_check(st.conn), "ok")
            st.set_meta("sentinel", "alpha")
            self.assertEqual(st.get_meta("sentinel"), "alpha")
        self.assertTrue((store.household_dir(self.root) / "household.sqlite").is_file())
        meta = json.loads(store.meta_path(self.root).read_text(encoding="utf-8"))
        self.assertEqual(meta["schema_version"], 1)
        self.assertEqual(meta["authority"], "sqlite_user_version")

    def test_reopen_valid(self):
        with store.open_store(self.root) as st:
            st.set_meta("sentinel", "beta")
        with store.open_store(self.root, create=False) as st2:
            self.assertEqual(st2.get_meta("sentinel"), "beta")
            self.assertEqual(st2.schema_version, 1)

    def test_downgrade_refused(self):
        with store.open_store(self.root) as st:
            st.conn.execute("PRAGMA user_version = 99")
            st.conn.commit()
        with self.assertRaises(store.HouseholdStoreError) as ctx:
            store.open_store(self.root, create=False)
        self.assertEqual(ctx.exception.code, "downgrade_refused")

    def test_corrupt_db_preserved(self):
        with store.open_store(self.root) as st:
            path = st.path
        before = path.read_bytes()
        path.write_bytes(b"not-a-sqlite-database!!!!")
        with self.assertRaises(store.HouseholdStoreError):
            store.open_store(self.root, create=False)
        self.assertEqual(path.read_bytes(), b"not-a-sqlite-database!!!!")
        self.assertNotEqual(path.read_bytes(), before)

    def test_migration_failure_rolls_back(self):
        with store.open_store(self.root) as st:
            st.conn.execute("PRAGMA user_version = 0")
            st.conn.commit()
            st.set_meta("keep", "yes")

        def boom(conn):
            # DML only — SQLite DDL would auto-commit and defeat rollback tests.
            conn.execute(
                "INSERT INTO household_meta(key, value, updated_at) VALUES (?, ?, ?)",
                ("boom_row", "x", 1.0),
            )
            raise RuntimeError("inject")

        with mock.patch.dict(store._MIGRATIONS, {1: boom}):
            with self.assertRaises(RuntimeError):
                store.open_store(self.root, create=False)
        conn = sqlite3.connect(str(store.db_path(self.root)))
        try:
            self.assertEqual(int(conn.execute("PRAGMA user_version").fetchone()[0]), 0)
            row = conn.execute(
                "SELECT 1 FROM household_meta WHERE key='boom_row'"
            ).fetchone()
            self.assertIsNone(row)
            keep = conn.execute(
                "SELECT value FROM household_meta WHERE key='keep'"
            ).fetchone()
            self.assertEqual(keep[0], "yes")
        finally:
            conn.close()

    def test_meta_mirror_write_failure_keeps_sqlite(self):
        with store.open_store(self.root) as st:
            st.set_meta("alive", "1")
            path = store.meta_path(self.root)
        # Turn meta into a directory so replace fails / write fails
        path.unlink()
        path.mkdir()
        # Heal path: open should still succeed (sqlite authority)
        with store.open_store(self.root, create=False) as st2:
            self.assertEqual(st2.get_meta("alive"), "1")

    def test_backup_restore_roundtrip(self):
        with store.open_store(self.root) as st:
            st.set_meta("sentinel", "roundtrip-value")
            man = store.backup(self.root, label="test", conn=st.conn)
        self.assertTrue(man["ok"])
        self.assertEqual(len(man["sha256"]), 64)
        snap = store.backups_dir(self.root) / man["file"]
        with tempfile.TemporaryDirectory() as dest:
            restored = store.restore_to_temp(snap, dest_root=dest)
            try:
                self.assertEqual(restored.get_meta("sentinel"), "roundtrip-value")
                self.assertEqual(restored.schema_version, 1)
            finally:
                restored.close()

    def test_backup_failure_leaves_original(self):
        with store.open_store(self.root) as st:
            st.set_meta("safe", "ok")
        with mock.patch.object(store, "_sqlite_backup", side_effect=sqlite3.Error("nope")):
            with self.assertRaises(store.HouseholdStoreError) as ctx:
                store.backup(self.root, label="fail")
            self.assertEqual(ctx.exception.code, "backup_error")
        # Original DB still opens and retains sentinel data (do not compare raw bytes — WAL may rewrite).
        with store.open_store(self.root, create=False) as st2:
            self.assertEqual(st2.get_meta("safe"), "ok")
        # Failed attempt must not leave a usable snapshot file
        snaps = list(store.backups_dir(self.root).glob("household-fail-*.sqlite"))
        self.assertEqual(snaps, [])

    def test_wal_coherent_snapshot(self):
        with store.open_store(self.root) as st:
            mode = st.conn.execute("PRAGMA journal_mode").fetchone()[0]
            st.set_meta("wal", "1")
            man = store.backup(self.root, label="wal", conn=st.conn)
        self.assertTrue(man["ok"])
        # journal_mode may be wal or delete depending on FS; snapshot must still verify
        snap = store.backups_dir(self.root) / man["file"]
        conn = sqlite3.connect(str(snap))
        try:
            self.assertEqual(store.integrity_check(conn), "ok")
            row = conn.execute(
                "SELECT value FROM household_meta WHERE key='wal'"
            ).fetchone()
            self.assertEqual(row[0], "1")
        finally:
            conn.close()
        self.assertIn(str(mode).lower(), {"wal", "delete", "memory", "off", "persist", "truncate"})

    def test_concurrent_open_busy_timeout(self):
        with store.open_store(self.root) as st:
            st.set_meta("c", "1")
        errors: list[BaseException] = []

        def worker():
            try:
                with store.open_store(self.root, create=False) as s:
                    s.get_meta("c")
            except BaseException as exc:  # noqa: BLE001 — collect
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        self.assertEqual(errors, [])


class ConfinementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-hh-link-")
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_symlink_dir_refused(self):
        if os.name == "nt":
            # Creating symlinks often needs admin; skip if OSError
            target = Path(self.tmp.name) / "elsewhere"
            target.mkdir()
            link = Path(self.tmp.name) / "root" / ".hq-household"
            (Path(self.tmp.name) / "root").mkdir()
            try:
                link.symlink_to(target, target_is_directory=True)
            except OSError:
                self.skipTest("symlink privilege unavailable")
            with self.assertRaises(store.HouseholdStoreError) as ctx:
                store.open_store(Path(self.tmp.name) / "root")
            self.assertEqual(ctx.exception.code, "storage_error")
        else:
            target = Path(self.tmp.name) / "elsewhere"
            target.mkdir()
            root = Path(self.tmp.name) / "root"
            root.mkdir()
            link = root / ".hq-household"
            link.symlink_to(target, target_is_directory=True)
            with self.assertRaises(store.HouseholdStoreError):
                store.open_store(root)


@unittest.skipUnless(os.name == "nt", "Windows ACL checks")
class WindowsAclTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-hh-acl-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(True)

    def tearDown(self):
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def test_acl_applied_on_init(self):
        with store.open_store(self.root) as st:
            path = store.household_dir(self.root)
            db = st.path
        import subprocess
        listed = subprocess.run(
            ["icacls", str(path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        self.assertEqual(listed.returncode, 0)
        text = listed.stdout
        self.assertNotIn("Everyone:", text)
        self.assertTrue(db.is_file())


class SchemaUnexpectedTypeTests(unittest.TestCase):
    """Unexpected JSON shapes → SchemaError, never raw TypeError/AttributeError."""

    def test_string_fields_reject_list_and_object(self):
        cases = [
            lambda: schemas.require_id(["itm"], "inventory_item"),
            lambda: schemas.require_id({"id": "x"}, "inventory_item"),
            lambda: schemas.require_iso_date(["2026-01-01"], "d"),
            lambda: schemas.require_iso_date({"d": "2026-01-01"}, "d"),
            lambda: schemas.require_idempotency_key(["abc"]),
            lambda: schemas.require_sha256_hex(["a" * 64]),
            lambda: schemas.require_unit(["g"]),
            lambda: schemas.require_cents([1]),
            lambda: schemas.require_bool("true", "f"),
            lambda: schemas.validate_transaction({
                "id": "tx-" + "1" * 16,
                "household_id": "hhold-" + "1" * 16,
                "account_id": "acct-" + "1" * 16,
                "category_id": "cat-" + "1" * 16,
                "booked_on": ["2026-11-09"],
                "amount_cents": -1,
                "status": "posted",
                "source": "manual",
                "rev": 1,
            }),
            lambda: schemas.validate_inventoria_proposal({
                "op": "item.adjust",
                "refs": {},
                "resolved": {"confidence": "high"},
                "payload": ["not", "a", "dict"],
                "label_fr": "x",
            }),
            lambda: schemas.validate_price_offer({
                "schema_version": 1,
                "id": "off-" + "1" * 16,
                "merchant_id": "mch-" + "1" * 16,
                "merchant_name": {"n": "x"},
                "product_name": "p",
                "price_cents": 1,
                "qty_milli": 1000,
                "unit": "each",
                "unit_price_ratio": {"cents_num": 1, "qty_milli_den": 1000},
                "promo": {"kind": "none"},
                "tax_included": False,
                "deposit_cents": 0,
                "collected_at": 1.0,
                "collected_on": "2026-11-01",
                "provenance": {
                    "kind": "manual",
                    "provider_id": "manual",
                    "source_label": "s",
                    "verifiable": True,
                },
                "reliability": 80,
                "stale_after_days": 14,
                "rev": 1,
            }),
        ]
        for fn in cases:
            with self.subTest(fn=fn):
                with self.assertRaises(schemas.SchemaError):
                    fn()


if __name__ == "__main__":
    unittest.main()
