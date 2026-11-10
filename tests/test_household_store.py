"""Household SQLite shell — storage, ACL, migrate, backup (PR #31)."""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import tempfile
import threading
import time
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
            self.assertFalse(store.db_path(root).exists())


class StoreLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-hh-")
        self.root = Path(self.tmp.name)

    def tearDown(self):
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def test_init_blank_root(self):
        with store.open_store(self.root) as st:
            self.assertEqual(st.schema_version, 6)
            self.assertEqual(store.integrity_check(st.conn), "ok")
            st.set_meta("sentinel", "alpha")
            self.assertEqual(st.get_meta("sentinel"), "alpha")
        meta = json.loads(store.meta_path(self.root).read_text(encoding="utf-8"))
        self.assertEqual(meta["schema_version"], 6)

    def test_reopen_valid(self):
        with store.open_store(self.root) as st:
            st.set_meta("sentinel", "beta")
        with store.open_store(self.root, create=False) as st2:
            self.assertEqual(st2.get_meta("sentinel"), "beta")

    def test_open_store_does_not_slurp_db_bytes(self):
        with store.open_store(self.root) as st:
            st.set_meta("x", "1")
        with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("slurp")):
            with store.open_store(self.root, create=False) as st2:
                self.assertEqual(st2.get_meta("x"), "1")

    def test_readonly_no_writes(self):
        with store.open_store(self.root) as st:
            st.set_meta("ro", "1")
        meta = store.meta_path(self.root)
        before_mtime = meta.stat().st_mtime_ns
        time.sleep(0.05)
        with store.open_store(self.root, create=False, readonly=True) as st:
            self.assertTrue(st.readonly)
            self.assertEqual(st.get_meta("ro"), "1")
            with self.assertRaises(store.HouseholdStoreError) as ctx:
                st.set_meta("ro", "2")
            self.assertEqual(ctx.exception.code, "readonly")
        self.assertEqual(meta.stat().st_mtime_ns, before_mtime)
        with store.open_store(self.root, create=False) as st2:
            self.assertEqual(st2.get_meta("ro"), "1")

    def test_downgrade_refused(self):
        with store.open_store(self.root) as st:
            st.conn.execute("PRAGMA user_version = 99")
            st.conn.commit()
        with self.assertRaises(store.HouseholdStoreError) as ctx:
            store.open_store(self.root, create=False)
        self.assertEqual(ctx.exception.code, "downgrade_refused")

    def test_newer_version_refused_without_wal_or_byte_change(self):
        """Version gate must run before journal_mode=WAL (no secondary files / byte edits)."""
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            conn.execute("PRAGMA user_version = 99")
            conn.commit()
        finally:
            conn.close()
        before = path.read_bytes()
        wal = path.with_name(store.DB_NAME + "-wal")
        shm = path.with_name(store.DB_NAME + "-shm")
        self.assertFalse(wal.exists())
        self.assertFalse(shm.exists())
        with self.assertRaises(store.HouseholdStoreError) as ctx:
            store.open_store(self.root, create=False)
        self.assertEqual(ctx.exception.code, "downgrade_refused")
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(wal.exists())
        self.assertFalse(shm.exists())

    def test_user_version_1_without_tables_refused(self):
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            conn.execute("PRAGMA user_version = 1")
            conn.commit()
        finally:
            conn.close()
        with self.assertRaises(store.HouseholdStoreError) as ctx:
            store.open_store(self.root, create=False)
        self.assertEqual(ctx.exception.code, "schema_error")

    def test_user_version_1_missing_columns_refused(self):
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            conn.execute("CREATE TABLE household_meta (key TEXT PRIMARY KEY NOT NULL)")
            conn.execute(
                "CREATE TABLE schema_migrations ("
                "version INTEGER PRIMARY KEY NOT NULL, applied_at REAL NOT NULL, note TEXT NOT NULL)"
            )
            conn.execute("PRAGMA user_version = 1")
            conn.commit()
        finally:
            conn.close()
        with self.assertRaises(store.HouseholdStoreError) as ctx:
            store.open_store(self.root, create=False)
        self.assertEqual(ctx.exception.code, "schema_error")

    def test_meta_schema_version_object_healed_without_typeerror(self):
        with store.open_store(self.root) as st:
            st.set_meta("alive", "1")
        meta = store.meta_path(self.root)
        meta.write_text(
            json.dumps({"schema_version": {"nested": True}, "app_rev": "x"}, ensure_ascii=False),
            encoding="utf-8",
        )
        with store.open_store(self.root, create=False) as st2:
            self.assertEqual(st2.get_meta("alive"), "1")
        healed = json.loads(meta.read_text(encoding="utf-8"))
        self.assertEqual(healed["schema_version"], 6)

    def test_meta_schema_version_array_healed_without_typeerror(self):
        with store.open_store(self.root) as st:
            st.set_meta("alive", "1")
        meta = store.meta_path(self.root)
        meta.write_text(
            json.dumps({"schema_version": [1], "app_rev": "x"}, ensure_ascii=False),
            encoding="utf-8",
        )
        with store.open_store(self.root, create=False) as st2:
            self.assertEqual(st2.get_meta("alive"), "1")
        healed = json.loads(meta.read_text(encoding="utf-8"))
        self.assertEqual(healed["schema_version"], 6)

    def test_v1_snapshot_migrates_to_v2_with_backup(self):
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            store._apply_v1(conn)
            conn.commit()
        finally:
            conn.close()
        self.assertEqual(int(sqlite3.connect(str(path)).execute("PRAGMA user_version").fetchone()[0]), 1)
        with store.open_store(self.root, create=False) as st:
            self.assertEqual(st.schema_version, 6)
            st.set_meta("post-v2", "ok")
        backups = list(store.backups_dir(self.root).glob("household-pre-migrate-*.sqlite"))
        self.assertTrue(backups)

    def test_v2_usd_envelope_migrates_v3_currency_with_backup(self):
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        now = 1_700_000_000.0
        hid = "hhold-usd-v2"
        cat = "cat-groceries"
        env = "env-pre-v3"
        try:
            store._apply_v1(conn)
            store._apply_v2(conn)
            conn.execute(
                "INSERT INTO households("
                "id, name, currency, locale, timezone, week_starts, prefs_json, created_at, updated_at, rev"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (hid, "USD Home", "USD", "en-US", "America/New_York", "sun", "{}", now, now, 1),
            )
            conn.execute(
                "INSERT INTO budget_categories("
                "id, household_id, name, kind, parent_id, archived, created_at, updated_at, rev"
                ") VALUES (?, ?, ?, ?, NULL, 0, ?, ?, 1)",
                (cat, hid, "Groceries", "expense", now, now),
            )
            conn.execute(
                "INSERT INTO budget_envelopes("
                "id, household_id, category_id, period_start, period_end, allocated_cents, "
                "created_at, updated_at, rev"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
                (env, hid, cat, "2026-03-01", "2026-03-31", 75_000, now, now),
            )
            conn.commit()
        finally:
            conn.close()
        self.assertEqual(int(sqlite3.connect(str(path)).execute("PRAGMA user_version").fetchone()[0]), 2)
        with store.open_store(self.root, create=False) as st:
            self.assertEqual(st.schema_version, 6)
            row = st.conn.execute("SELECT currency FROM budget_envelopes WHERE id = ?", (env,)).fetchone()
            self.assertEqual(row[0], "USD")
        backups = list(store.backups_dir(self.root).glob("household-pre-migrate-*.sqlite"))
        self.assertTrue(backups)

    def test_migration_v3_failure_preserves_v2(self):
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            store._apply_v1(conn)
            store._apply_v2(conn)
            conn.commit()
        finally:
            conn.close()

        def boom(conn):
            store._exec_sql(conn, "ALTER TABLE budget_envelopes ADD COLUMN currency TEXT")
            raise RuntimeError("inject-v3")

        with mock.patch.dict(store._MIGRATIONS, {3: boom}):
            with self.assertRaises(RuntimeError):
                store.open_store(self.root, create=False)
        conn = sqlite3.connect(str(path))
        try:
            self.assertEqual(int(conn.execute("PRAGMA user_version").fetchone()[0]), 2)
            info = {r[1] for r in conn.execute("PRAGMA table_info(budget_envelopes)")}
            self.assertNotIn("currency", info)
        finally:
            conn.close()

    def test_v3_finance_tx_survives_v4_migration(self):
        import hq_finances as fin

        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 1.0)
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            store._apply_v1(conn)
            store._apply_v2(conn)
            store._apply_v3(conn)
            conn.commit()
        finally:
            conn.close()

        conn_v3 = sqlite3.connect(str(path))
        conn_v3.row_factory = sqlite3.Row
        try:
            st_v3 = store.HouseholdStore(self.root, conn_v3, schema_version=3)
            with st_v3.transaction():
                hid = fin.ensure_default_household(st_v3.conn)
                acct = fin.create_account(
                    st_v3.conn, hid, {"name": "A", "kind": "cash", "opening_balance_cents": 100, "currency": "CAD"},
                )["id"]
                cat = fin.upsert_category(st_v3.conn, hid, {"name": "x", "kind": "expense"})["id"]
                fin.insert_transaction(
                    st_v3.conn,
                    hid,
                    {
                        "account_id": acct,
                        "category_id": cat,
                        "amount_cents": -10,
                        "booked_on": "2026-09-01",
                        "idempotency_key": "v4-preserve-tx",
                    },
                    pin_idem=True,
                )
            tx_count = int(st_v3.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0])
            audit_count = int(st_v3.conn.execute("SELECT COUNT(*) FROM ledger_audit").fetchone()[0])
            self.assertEqual(tx_count, 1)
            self.assertGreaterEqual(audit_count, 1)
            self.assertEqual(int(st_v3.conn.execute("PRAGMA user_version").fetchone()[0]), 3)
        finally:
            conn_v3.close()

        with store.open_store(self.root, create=False) as st2:
            self.assertEqual(st2.schema_version, 6)
            self.assertEqual(int(st2.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]), tx_count)
            self.assertGreaterEqual(int(st2.conn.execute("SELECT COUNT(*) FROM ledger_audit").fetchone()[0]), audit_count)
            names = {r[0] for r in st2.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("products", names)
            self.assertIn("recipes", names)
        backups = list(store.backups_dir(self.root).glob("household-pre-migrate-*.sqlite"))
        self.assertTrue(backups)
        fin.reset_for_tests()

    def test_v4_grocery_survives_v5_migration(self):
        import hq_finances as fin
        import hq_grocery as gr

        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 1.0)
        gr.bind(root=self.root, actor=lambda: "t", now=lambda: 1.0, inventory_snapshot=lambda: {"version": 1, "rev": 1, "items": [], "places": []})
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            for fn in (store._apply_v1, store._apply_v2, store._apply_v3, store._apply_v4):
                fn(conn)
            conn.commit()
        finally:
            conn.close()

        conn_v4 = sqlite3.connect(str(path))
        conn_v4.row_factory = sqlite3.Row
        prod_id = mch_id = lot_id = acct = None
        try:
            st_v4 = store.HouseholdStore(self.root, conn_v4, schema_version=4)
            with st_v4.transaction():
                hid = fin.ensure_default_household(st_v4.conn)
                prod = gr.create_product(
                    st_v4.conn, hid, {"name": "Rice", "canonical_unit": "g", "default_qty_milli": 1000},
                )
                prod_id = prod["id"]
                lot = gr.create_lot(
                    st_v4.conn, hid,
                    {"product_id": prod_id, "qty_milli": 500_000, "usable_qty_milli": 400_000, "canonical_unit": "g"},
                )
                lot_id = lot["id"]
                mch = gr.create_merchant(st_v4.conn, hid, {"name": "Metro"})
                mch_id = mch["id"]
                acct = fin.create_account(
                    st_v4.conn, hid, {"name": "A", "kind": "cash", "opening_balance_cents": 100, "currency": "CAD"},
                )["id"]
                cat = fin.upsert_category(st_v4.conn, hid, {"name": "x", "kind": "expense"})["id"]
                fin.insert_transaction(
                    st_v4.conn,
                    hid,
                    {
                        "account_id": acct,
                        "category_id": cat,
                        "amount_cents": -10,
                        "booked_on": "2026-09-01",
                        "idempotency_key": "v5-preserve-tx",
                    },
                    pin_idem=True,
                )
            self.assertEqual(int(st_v4.conn.execute("PRAGMA user_version").fetchone()[0]), 4)
        finally:
            conn_v4.close()

        with store.open_store(self.root, create=False) as st2:
            self.assertEqual(st2.schema_version, 6)
            self.assertEqual(st2.conn.execute("SELECT id FROM products WHERE id = ?", (prod_id,)).fetchone()[0], prod_id)
            self.assertEqual(st2.conn.execute("SELECT id FROM food_lots WHERE id = ?", (lot_id,)).fetchone()[0], lot_id)
            self.assertEqual(st2.conn.execute("SELECT id FROM merchants WHERE id = ?", (mch_id,)).fetchone()[0], mch_id)
            self.assertEqual(int(st2.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]), 1)
            names = {r[0] for r in st2.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("recipes", names)
            self.assertIn("grocery_lists", names)
        backups = list(store.backups_dir(self.root).glob("household-pre-migrate-*.sqlite"))
        self.assertTrue(backups)
        gr.reset_for_tests()
        fin.reset_for_tests()

    def test_v5_meals_grocery_finance_survives_v6_migration(self):
        import hq_finances as fin
        import hq_grocery as gr
        import hq_meals as meals

        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 1.0)
        gr.bind(root=self.root, actor=lambda: "t", now=lambda: 1.0, inventory_snapshot=lambda: {"version": 1, "rev": 1, "items": [], "places": []})
        meals.bind(root=self.root, actor=lambda: "t", now=lambda: 1.0)
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            for fn in (store._apply_v1, store._apply_v2, store._apply_v3, store._apply_v4, store._apply_v5):
                fn(conn)
            conn.commit()
        finally:
            conn.close()

        conn_v5 = sqlite3.connect(str(path))
        conn_v5.row_factory = sqlite3.Row
        recipe_id = plan_id = prod_id = None
        try:
            st_v5 = store.HouseholdStore(self.root, conn_v5, schema_version=5)
            with st_v5.transaction():
                hid = fin.ensure_default_household(st_v5.conn)
                prod = gr.create_product(
                    st_v5.conn, hid, {"name": "Beans", "canonical_unit": "g", "default_qty_milli": 500},
                )
                prod_id = prod["id"]
                gr.create_merchant(st_v5.conn, hid, {"name": "IGA"})
                acct = fin.create_account(
                    st_v5.conn, hid, {"name": "A", "kind": "cash", "opening_balance_cents": 100, "currency": "CAD"},
                )["id"]
                cat = fin.upsert_category(st_v5.conn, hid, {"name": "food", "kind": "expense"})["id"]
                fin.insert_transaction(
                    st_v5.conn,
                    hid,
                    {
                        "account_id": acct,
                        "category_id": cat,
                        "amount_cents": -42,
                        "booked_on": "2026-10-01",
                        "idempotency_key": "v6-preserve-tx",
                    },
                    pin_idem=True,
                )
                recipe = meals.create_recipe(
                    st_v5.conn,
                    hid,
                    {
                        "title": "Soup",
                        "servings": 2,
                        "ingredients": [{"name": "Beans", "qty_milli": 100_000, "unit": "g"}],
                        "steps": ["Boil"],
                        "leftover_policy": "none",
                    },
                )
                recipe_id = recipe["id"]
                plan = meals.create_meal_plan(
                    st_v5.conn,
                    hid,
                    {
                        "period_start": "2026-11-10",
                        "period_end": "2026-11-11",
                        "slots": [{"date": "2026-11-10", "meal": "dinner", "recipe_id": recipe_id}],
                    },
                )
                plan_id = plan["id"]
            self.assertEqual(int(st_v5.conn.execute("PRAGMA user_version").fetchone()[0]), 5)
        finally:
            conn_v5.close()

        with store.open_store(self.root, create=False) as st2:
            self.assertEqual(st2.schema_version, 6)
            self.assertEqual(st2.conn.execute("SELECT id FROM products WHERE id = ?", (prod_id,)).fetchone()[0], prod_id)
            self.assertEqual(st2.conn.execute("SELECT id FROM recipes WHERE id = ?", (recipe_id,)).fetchone()[0], recipe_id)
            self.assertEqual(st2.conn.execute("SELECT id FROM meal_plans WHERE id = ?", (plan_id,)).fetchone()[0], plan_id)
            self.assertEqual(int(st2.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]), 1)
            names = {r[0] for r in st2.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("actual_purchases", names)
            self.assertIn("cross_store_ops", names)
            store.validate_schema_v6(st2.conn)
            self.assertTrue(store.is_actual_purchases_idempotency_index_valid(st2.conn))
        backups = list(store.backups_dir(self.root).glob("household-pre-migrate-*.sqlite"))
        self.assertTrue(backups)
        meals.reset_for_tests()
        gr.reset_for_tests()
        fin.reset_for_tests()

    def test_migration_v6_failure_preserves_v5(self):
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            for fn in (store._apply_v1, store._apply_v2, store._apply_v3, store._apply_v4, store._apply_v5):
                fn(conn)
            conn.commit()
        finally:
            conn.close()

        def boom(conn):
            store._exec_sql(conn, store._V6_STATEMENTS[0])
            raise RuntimeError("inject-v6")

        with mock.patch.dict(store._MIGRATIONS, {6: boom}):
            with self.assertRaises(RuntimeError):
                store.open_store(self.root, create=False)
        conn = sqlite3.connect(str(path))
        try:
            self.assertEqual(int(conn.execute("PRAGMA user_version").fetchone()[0]), 5)
            self.assertIsNone(
                conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='actual_purchases'").fetchone(),
            )
        finally:
            conn.close()

    def test_migration_v5_failure_preserves_v4(self):
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            for fn in (store._apply_v1, store._apply_v2, store._apply_v3, store._apply_v4):
                fn(conn)
            conn.commit()
        finally:
            conn.close()

        def boom(conn):
            store._exec_sql(conn, store._V5_STATEMENTS[0])
            raise RuntimeError("inject-v5")

        with mock.patch.dict(store._MIGRATIONS, {5: boom}):
            with self.assertRaises(RuntimeError):
                store.open_store(self.root, create=False)
        conn = sqlite3.connect(str(path))
        try:
            self.assertEqual(int(conn.execute("PRAGMA user_version").fetchone()[0]), 4)
            self.assertIsNone(conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recipes'").fetchone())
        finally:
            conn.close()

    def test_migration_v4_failure_preserves_v3(self):
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            store._apply_v1(conn)
            store._apply_v2(conn)
            store._apply_v3(conn)
            conn.commit()
        finally:
            conn.close()

        def boom(conn):
            store._exec_sql(conn, store._V4_STATEMENTS[0])
            raise RuntimeError("inject-v4")

        with mock.patch.dict(store._MIGRATIONS, {4: boom}):
            with self.assertRaises(RuntimeError):
                store.open_store(self.root, create=False)
        conn = sqlite3.connect(str(path))
        try:
            self.assertEqual(int(conn.execute("PRAGMA user_version").fetchone()[0]), 3)
            self.assertIsNone(conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'").fetchone())
        finally:
            conn.close()

    def test_open_store_preserves_intentional_cad_envelope_in_usd_household(self):
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        now = 1_700_000_200.0
        hid = "hhold-usd-cad"
        cat = "cat-cad-intent"
        env = "env-cad-intent"
        try:
            store._apply_v1(conn)
            store._apply_v2(conn)
            store._apply_v3(conn)
            conn.execute(
                "INSERT INTO households("
                "id, name, currency, locale, timezone, week_starts, prefs_json, created_at, updated_at, rev"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (hid, "USD home", "USD", "en-US", "America/New_York", "sun", "{}", now, now, 1),
            )
            conn.execute(
                "INSERT INTO budget_categories("
                "id, household_id, name, kind, parent_id, archived, created_at, updated_at, rev"
                ") VALUES (?, ?, 'Travel CAD', 'expense', NULL, 0, ?, ?, 1)",
                (cat, hid, now, now),
            )
            conn.execute(
                "INSERT INTO budget_envelopes("
                "id, household_id, category_id, period_start, period_end, allocated_cents, currency, "
                "created_at, updated_at, rev"
                ") VALUES (?, ?, ?, '2026-05-01', '2026-05-31', 5000, 'CAD', ?, ?, 1)",
                (env, hid, cat, now, now),
            )
            conn.execute(
                "UPDATE schema_migrations SET note = ? WHERE version = 3",
                ("envelope currency v3",),
            )
            conn.commit()
        finally:
            conn.close()
        with store.open_store(self.root, create=False) as st:
            row = st.conn.execute("SELECT currency FROM budget_envelopes WHERE id = ?", (env,)).fetchone()
            self.assertEqual(row[0], "CAD")
        with store.open_store(self.root, create=False) as st2:
            row2 = st2.conn.execute("SELECT currency FROM budget_envelopes WHERE id = ?", (env,)).fetchone()
            self.assertEqual(row2[0], "CAD")

    def test_migration_v2_failure_preserves_v1(self):
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            store._apply_v1(conn)
            conn.commit()
        finally:
            conn.close()

        def boom(conn):
            store._exec_sql(conn, store._V2_STATEMENTS[0])
            raise RuntimeError("inject-v2")

        with mock.patch.dict(store._MIGRATIONS, {2: boom}):
            with self.assertRaises(RuntimeError):
                store.open_store(self.root, create=False)
        conn = sqlite3.connect(str(path))
        try:
            self.assertEqual(int(conn.execute("PRAGMA user_version").fetchone()[0]), 1)
            self.assertIsNone(conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='households'").fetchone())
        finally:
            conn.close()

    def test_corrupt_db_preserved(self):
        with store.open_store(self.root) as st:
            path = st.path
        payload = b"not-a-sqlite-database!!!!"
        path.write_bytes(payload)
        with self.assertRaises(store.HouseholdStoreError):
            store.open_store(self.root, create=False)
        self.assertEqual(path.read_bytes(), payload)

    def test_migration_failure_rolls_back_dml(self):
        with store.open_store(self.root) as st:
            st.conn.execute("PRAGMA user_version = 0")
            st.conn.commit()
            st.set_meta("keep", "yes")

        def boom(conn):
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
            self.assertIsNone(conn.execute(
                "SELECT 1 FROM household_meta WHERE key='boom_row'"
            ).fetchone())
            self.assertEqual(conn.execute(
                "SELECT value FROM household_meta WHERE key='keep'"
            ).fetchone()[0], "yes")
        finally:
            conn.close()

    def test_migration_failure_after_ddl_leaves_no_tables(self):
        """executescript-free migrate: DDL+error must roll back inside BEGIN IMMEDIATE."""
        base = store.prepare_household_dirs(self.root)
        path = base / store.DB_NAME
        sqlite3.connect(str(path)).close()

        def boom_after_ddl(conn):
            store._exec_sql(conn, store._V1_STATEMENTS[0])
            raise RuntimeError("inject-ddl")

        with mock.patch.dict(store._MIGRATIONS, {1: boom_after_ddl}):
            with self.assertRaises(RuntimeError):
                store.open_store(self.root, create=False)
        conn = sqlite3.connect(str(path))
        try:
            self.assertEqual(int(conn.execute("PRAGMA user_version").fetchone()[0]), 0)
            names = {
                r[0]
                for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            self.assertNotIn("household_meta", names)
            self.assertNotIn("schema_migrations", names)
        finally:
            conn.close()

    def test_meta_mirror_write_failure_keeps_sqlite(self):
        with store.open_store(self.root) as st:
            st.set_meta("alive", "1")
            path = store.meta_path(self.root)
        path.unlink()
        path.mkdir()
        with store.open_store(self.root, create=False) as st2:
            self.assertEqual(st2.get_meta("alive"), "1")

    def test_backup_restore_roundtrip(self):
        with store.open_store(self.root) as st:
            st.set_meta("sentinel", "roundtrip-value")
            man = store.backup(self.root, label="test", conn=st.conn)
        self.assertTrue(man["ok"])
        snap = store.backups_dir(self.root) / man["file"]
        with tempfile.TemporaryDirectory() as dest:
            restored = store.restore_to_temp(snap, dest_root=dest)
            try:
                self.assertEqual(restored.get_meta("sentinel"), "roundtrip-value")
            finally:
                restored.close()

    def test_restore_requires_valid_manifest(self):
        with store.open_store(self.root) as st:
            st.set_meta("s", "1")
            man = store.backup(self.root, label="m", conn=st.conn)
        snap = store.backups_dir(self.root) / man["file"]
        manifest = snap.with_suffix(snap.suffix + ".manifest.json")

        with tempfile.TemporaryDirectory() as dest:
            manifest.unlink()
            with self.assertRaises(store.HouseholdStoreError) as ctx:
                store.restore_to_temp(snap, dest_root=dest)
            self.assertEqual(ctx.exception.code, "manifest_error")

        # recreate snap+manifest
        with store.open_store(self.root) as st:
            man = store.backup(self.root, label="m2", conn=st.conn)
        snap = store.backups_dir(self.root) / man["file"]
        manifest = snap.with_suffix(snap.suffix + ".manifest.json")
        manifest.write_text("{not-json", encoding="utf-8")
        with tempfile.TemporaryDirectory() as dest:
            with self.assertRaises(store.HouseholdStoreError) as ctx:
                store.restore_to_temp(snap, dest_root=dest)
            self.assertEqual(ctx.exception.code, "manifest_error")

        with store.open_store(self.root) as st:
            man = store.backup(self.root, label="m3", conn=st.conn)
        snap = store.backups_dir(self.root) / man["file"]
        manifest = snap.with_suffix(snap.suffix + ".manifest.json")
        bad = json.loads(manifest.read_text(encoding="utf-8"))
        bad["sha256"] = "0" * 64
        manifest.write_text(json.dumps(bad), encoding="utf-8")
        with tempfile.TemporaryDirectory() as dest:
            with self.assertRaises(store.HouseholdStoreError) as ctx:
                store.restore_to_temp(snap, dest_root=dest)
            self.assertEqual(ctx.exception.code, "corrupt")

    def test_restore_refuses_existing_household(self):
        with store.open_store(self.root) as st:
            st.set_meta("s", "1")
            man = store.backup(self.root, label="ex", conn=st.conn)
        snap = store.backups_dir(self.root) / man["file"]
        with tempfile.TemporaryDirectory() as dest:
            store.prepare_household_dirs(dest)
            with self.assertRaises(store.HouseholdStoreError) as ctx:
                store.restore_to_temp(snap, dest_root=dest)
            self.assertEqual(ctx.exception.code, "restore_error")

    def test_backup_failure_leaves_original(self):
        with store.open_store(self.root) as st:
            st.set_meta("safe", "ok")
        with mock.patch.object(store, "_sqlite_backup", side_effect=sqlite3.Error("nope")):
            with self.assertRaises(store.HouseholdStoreError) as ctx:
                store.backup(self.root, label="fail")
            self.assertEqual(ctx.exception.code, "backup_error")
        with store.open_store(self.root, create=False) as st2:
            self.assertEqual(st2.get_meta("safe"), "ok")
        self.assertEqual(list(store.backups_dir(self.root).glob("household-fail-*.sqlite")), [])

    def test_wal_coherent_snapshot(self):
        with store.open_store(self.root) as st:
            st.set_meta("wal", "1")
            man = store.backup(self.root, label="wal", conn=st.conn)
        snap = store.backups_dir(self.root) / man["file"]
        conn = sqlite3.connect(str(snap))
        try:
            self.assertEqual(store.integrity_check(conn), "ok")
            self.assertEqual(conn.execute(
                "SELECT value FROM household_meta WHERE key='wal'"
            ).fetchone()[0], "1")
        finally:
            conn.close()

    def test_concurrent_open_busy_timeout(self):
        with store.open_store(self.root) as st:
            st.set_meta("c", "1")
        errors: list[BaseException] = []

        def worker():
            try:
                with store.open_store(self.root, create=False) as s:
                    s.get_meta("c")
            except BaseException as exc:  # noqa: BLE001
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

    def _symlink(self, link: Path, target: Path, *, directory: bool) -> bool:
        try:
            link.symlink_to(target, target_is_directory=directory)
            return True
        except OSError:
            return False

    def test_symlink_household_dir_refused(self):
        target = Path(self.tmp.name) / "elsewhere"
        target.mkdir()
        root = Path(self.tmp.name) / "root"
        root.mkdir()
        link = root / ".hq-household"
        if not self._symlink(link, target, directory=True):
            self.skipTest("symlink privilege unavailable")
        with self.assertRaises(store.HouseholdStoreError) as ctx:
            store.open_store(root)
        self.assertEqual(ctx.exception.code, "storage_error")

    def test_symlink_backups_dir_refused(self):
        with store.open_store(self.root) as st:
            st.set_meta("a", "1")
        bdir = store.backups_dir(self.root)
        # replace backups with symlink
        for child in bdir.iterdir():
            child.unlink()
        bdir.rmdir()
        target = Path(self.tmp.name) / "evil-backups"
        target.mkdir()
        if not self._symlink(bdir, target, directory=True):
            self.skipTest("symlink privilege unavailable")
        with self.assertRaises(store.HouseholdStoreError):
            store.open_store(self.root, create=False)

    def test_symlink_imports_dir_refused(self):
        with store.open_store(self.root) as st:
            st.set_meta("a", "1")
        idir = store.imports_dir(self.root)
        idir.rmdir()
        target = Path(self.tmp.name) / "evil-imports"
        target.mkdir()
        if not self._symlink(idir, target, directory=True):
            self.skipTest("symlink privilege unavailable")
        with self.assertRaises(store.HouseholdStoreError):
            store.open_store(self.root, create=False)

    def test_symlink_manifest_refused_on_restore(self):
        with store.open_store(self.root) as st:
            st.set_meta("a", "1")
            man = store.backup(self.root, label="sym", conn=st.conn)
        snap = store.backups_dir(self.root) / man["file"]
        manifest = snap.with_suffix(snap.suffix + ".manifest.json")
        real = Path(self.tmp.name) / "real-manifest.json"
        real.write_text(manifest.read_text(encoding="utf-8"), encoding="utf-8")
        manifest.unlink()
        if not self._symlink(manifest, real, directory=False):
            self.skipTest("symlink privilege unavailable")
        with tempfile.TemporaryDirectory() as dest:
            with self.assertRaises(store.HouseholdStoreError):
                store.restore_to_temp(snap, dest_root=dest)

    def test_confined_file_refuses_symlink_parent(self):
        """realpath/resolve equality misses intermediate parent redirects — walk components."""
        real = Path(self.tmp.name) / "real-dir"
        real.mkdir()
        payload = real / "snap.sqlite"
        payload.write_bytes(b"not-used-for-open")
        via = Path(self.tmp.name) / "via-parent"
        if not self._symlink(via, real, directory=True):
            self.skipTest("symlink privilege unavailable")
        sneaky = via / "snap.sqlite"
        with self.assertRaises(store.HouseholdStoreError) as ctx:
            store._confined_file(sneaky, label="Snapshot")
        self.assertEqual(ctx.exception.code, "storage_error")
        # Direct (non-redirected) path remains acceptable for the confinement helper.
        ok = store._confined_file(payload, label="Snapshot")
        self.assertEqual(ok, Path(os.path.abspath(payload)))


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
            _ = st.path
        facts = store.describe_path_acl(path)
        self.assertTrue(facts["acceptable"], facts["text"])
        self.assertEqual(facts["broad_names"], [])

    def test_preexisting_excessive_acl_is_replaced(self):
        base = store.household_dir(self.root)
        base.mkdir(parents=True)
        # Layer Everyone:F explicitly before sealing
        subprocess.run(
            ["icacls", str(base), "/grant", "*S-1-1-0:(OI)(CI)F"],
            capture_output=True,
            check=False,
        )
        listed_before = subprocess.run(
            ["icacls", str(base)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        ).stdout
        self.assertTrue("Everyone" in listed_before or "S-1-1-0" in listed_before)
        with store.open_store(self.root) as st:
            st.set_meta("sealed", "1")
        facts = store.describe_path_acl(base)
        self.assertTrue(facts["acceptable"], facts["text"])
        self.assertNotIn("Everyone", facts["text"])
        self.assertTrue(
            "S-1-5-18" in facts["text"] or "SYSTEM" in facts["text"].upper(),
            facts["text"],
        )


class V6IdempotencyIndexIntegrityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-v6-idx-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)

    def tearDown(self) -> None:
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def _idem_backups(self) -> list[Path]:
        return list(store.backups_dir(self.root).glob("household-pre-v6-idem-index-*.sqlite"))

    def _merchant_household(self, st: store.HouseholdStore) -> tuple[str, str]:
        import hq_finances as fin
        import hq_grocery as gr

        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 1.0)
        gr.bind(
            root=self.root, actor=lambda: "t", now=lambda: 1.0,
            inventory_snapshot=lambda: {"version": 1, "rev": 1, "items": [], "places": []},
        )
        hid = fin.ensure_default_household(st.conn)
        mch = gr.create_merchant(st.conn, hid, {"name": "M"})["id"]
        return hid, mch

    def _insert_purchase_row(
        self,
        conn: sqlite3.Connection,
        *,
        hid: str,
        mch: str,
        pid: str,
        idem_key: str,
        fingerprint: str,
    ) -> None:
        now = 1.0
        conn.execute(
            "INSERT INTO actual_purchases("
            "id, household_id, planned_id, product_id, merchant_id, qty_milli, unit, "
            "paid_cents, taxed_cents, deposit_cents, purchased_on, fingerprint, "
            "finance_tx_id, food_lot_id, idempotency_key, created_at, updated_at, rev"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                pid, hid, None, None, mch, 1000, "g", 10, 0, 0, "2026-11-10",
                fingerprint, None, None, idem_key, now, now, 1,
            ),
        )

    def test_fresh_v6_index_valid_via_pragma(self) -> None:
        with store.open_store(self.root) as st:
            self.assertTrue(store.is_actual_purchases_idempotency_index_valid(st.conn))

    def test_repair_missing_index_backup_and_transaction(self) -> None:
        with store.open_store(self.root) as st:
            st.conn.execute(f"DROP INDEX {store._ACTUAL_PURCHASES_IDEM_INDEX}")
            st.conn.commit()
        before = len(self._idem_backups())
        with store.open_store(self.root, create=False) as st:
            self.assertTrue(store.is_actual_purchases_idempotency_index_valid(st.conn))
        self.assertEqual(len(self._idem_backups()), before + 1)

    def test_repair_non_unique_same_name(self) -> None:
        with store.open_store(self.root) as st:
            st.conn.execute(f"DROP INDEX {store._ACTUAL_PURCHASES_IDEM_INDEX}")
            st.conn.execute(
                f"CREATE INDEX {store._ACTUAL_PURCHASES_IDEM_INDEX} "
                "ON actual_purchases(household_id, idempotency_key)",
            )
            st.conn.commit()
            self.assertFalse(store.is_actual_purchases_idempotency_index_valid(st.conn))
        before = len(self._idem_backups())
        with store.open_store(self.root, create=False) as st:
            self.assertTrue(store.is_actual_purchases_idempotency_index_valid(st.conn))
        self.assertEqual(len(self._idem_backups()), before + 1)

    def test_duplicates_refuse_writable_open(self) -> None:
        import hq_finances as fin
        import hq_grocery as gr

        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 1.0)
        gr.bind(root=self.root, actor=lambda: "t", now=lambda: 1.0, inventory_snapshot=lambda: {"version": 1, "rev": 1, "items": [], "places": []})
        with store.open_store(self.root) as st:
            st.conn.execute(f"DROP INDEX {store._ACTUAL_PURCHASES_IDEM_INDEX}")
            hid = fin.ensure_default_household(st.conn)
            mch = gr.create_merchant(st.conn, hid, {"name": "M"})["id"]
            now = 1.0
            for pid in ("pur-1111111111111111", "pur-2222222222222222"):
                st.conn.execute(
                    "INSERT INTO actual_purchases("
                    "id, household_id, planned_id, product_id, merchant_id, qty_milli, unit, "
                    "paid_cents, taxed_cents, deposit_cents, purchased_on, fingerprint, "
                    "finance_tx_id, food_lot_id, idempotency_key, created_at, updated_at, rev"
                    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        pid, hid, None, None, mch, 1000, "g", 10, 0, 0, "2026-11-10",
                        f"fp-{pid}", None, None, "dup-key", now, now, 1,
                    ),
                )
            st.conn.commit()
        with self.assertRaises(store.HouseholdStoreError) as ctx:
            store.open_store(self.root, create=False)
        self.assertEqual(ctx.exception.code, "schema_error")
        fin.reset_for_tests()
        gr.reset_for_tests()

    def test_readonly_no_repair_no_backup(self) -> None:
        with store.open_store(self.root) as st:
            st.conn.execute(f"DROP INDEX {store._ACTUAL_PURCHASES_IDEM_INDEX}")
            st.conn.commit()
        bcount = len(self._idem_backups())
        with self.assertRaises(store.HouseholdStoreError):
            store.open_store(self.root, create=False, readonly=True)
        self.assertEqual(len(self._idem_backups()), bcount)

    def test_repeat_open_no_extra_repair_backups(self) -> None:
        with store.open_store(self.root) as st:
            st.conn.execute(f"DROP INDEX {store._ACTUAL_PURCHASES_IDEM_INDEX}")
            st.conn.commit()
        store.open_store(self.root, create=False).close()
        n = len(self._idem_backups())
        store.open_store(self.root, create=False).close()
        self.assertEqual(len(self._idem_backups()), n)

    def test_reject_partial_unique_index_repair_enforces_uniqueness(self) -> None:
        import hq_finances as fin
        import hq_grocery as gr

        with store.open_store(self.root) as st:
            st.conn.execute(f"DROP INDEX {store._ACTUAL_PURCHASES_IDEM_INDEX}")
            st.conn.execute(
                f"CREATE UNIQUE INDEX {store._ACTUAL_PURCHASES_IDEM_INDEX} "
                "ON actual_purchases(household_id, idempotency_key) WHERE paid_cents >= 0",
            )
            st.conn.commit()
            self.assertFalse(store.is_actual_purchases_idempotency_index_valid(st.conn))
        bcount = len(self._idem_backups())
        with self.assertRaises(store.HouseholdStoreError):
            store.open_store(self.root, create=False, readonly=True)
        self.assertEqual(len(self._idem_backups()), bcount)
        before = len(self._idem_backups())
        with store.open_store(self.root, create=False) as st:
            self.assertTrue(store.is_actual_purchases_idempotency_index_valid(st.conn))
            hid, mch = self._merchant_household(st)
            self._insert_purchase_row(
                st.conn, hid=hid, mch=mch, pid="pur-aaaaaaaaaaaaaaaa", idem_key="idem-x", fingerprint="fp-a",
            )
            with self.assertRaises(sqlite3.IntegrityError):
                self._insert_purchase_row(
                    st.conn, hid=hid, mch=mch, pid="pur-bbbbbbbbbbbbbbbb", idem_key="idem-x", fingerprint="fp-b",
                )
        self.assertEqual(len(self._idem_backups()), before + 1)
        fin.reset_for_tests()
        gr.reset_for_tests()

    def test_reject_extra_expression_key_repair_enforces_uniqueness(self) -> None:
        import hq_finances as fin
        import hq_grocery as gr

        with store.open_store(self.root) as st:
            st.conn.execute(f"DROP INDEX {store._ACTUAL_PURCHASES_IDEM_INDEX}")
            st.conn.execute(
                f"CREATE UNIQUE INDEX {store._ACTUAL_PURCHASES_IDEM_INDEX} "
                "ON actual_purchases(household_id, idempotency_key, (NULL))",
            )
            st.conn.commit()
            self.assertFalse(store.is_actual_purchases_idempotency_index_valid(st.conn))
        bcount = len(self._idem_backups())
        with self.assertRaises(store.HouseholdStoreError):
            store.open_store(self.root, create=False, readonly=True)
        self.assertEqual(len(self._idem_backups()), bcount)
        before = len(self._idem_backups())
        with store.open_store(self.root, create=False) as st:
            self.assertTrue(store.is_actual_purchases_idempotency_index_valid(st.conn))
            hid, mch = self._merchant_household(st)
            self._insert_purchase_row(
                st.conn, hid=hid, mch=mch, pid="pur-cccccccccccccccc", idem_key="idem-y", fingerprint="fp-c",
            )
            with self.assertRaises(sqlite3.IntegrityError):
                self._insert_purchase_row(
                    st.conn, hid=hid, mch=mch, pid="pur-dddddddddddddddd", idem_key="idem-y", fingerprint="fp-d",
                )
        self.assertEqual(len(self._idem_backups()), before + 1)
        fin.reset_for_tests()
        gr.reset_for_tests()


class SchemaUnexpectedTypeTests(unittest.TestCase):
    def test_string_fields_reject_list_and_object(self):
        cases = [
            lambda: schemas.require_id(["itm"], "inventory_item"),
            lambda: schemas.require_iso_date(["2026-01-01"], "d"),
            lambda: schemas.require_bool("true", "f"),
            lambda: schemas.validate_inventoria_proposal({
                "op": "item.adjust",
                "refs": {},
                "resolved": {"confidence": "high"},
                "payload": ["not", "a", "dict"],
                "label_fr": "x",
            }),
        ]
        for fn in cases:
            with self.subTest(fn=fn):
                with self.assertRaises(schemas.SchemaError):
                    fn()


if __name__ == "__main__":
    unittest.main()
