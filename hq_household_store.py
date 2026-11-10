"""Transfert HQ — Household SQLite shell (PR #31 foundations).

Local-first store under ``<ROOT>/.hq-household/``. No HTTP routes, no bridge
wiring, no domain Finances/Grocery/Meals/Inventoria tables yet — only the
engine: confinement, ACL, versioned schema, WAL, backup/restore.

``PRAGMA user_version`` is the durable schema authority. ``schema_meta.json``
is a healable mirror. Importing this module never creates files.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

DIR_NAME = ".hq-household"
DB_NAME = "household.sqlite"
META_NAME = "schema_meta.json"
BACKUPS_DIR = "backups"
IMPORTS_DIR = "imports"

SCHEMA_VERSION = 6
BUSY_TIMEOUT_MS = 5_000
APP_REV = "household-purchases-v6"

SYSTEM_SID = "S-1-5-18"
# Broad identities that must not remain on a sealed household path.
_FORBIDDEN_SIDS = frozenset({
    "S-1-1-0",       # Everyone
    "S-1-5-11",      # Authenticated Users
    "S-1-5-32-545",  # Users
    "S-1-5-32-546",  # Guests
})

_APPLY_ACL = True
_guard = threading.Lock()
_WHOAMI_SID = re.compile(r"(S-1(?:-\d+)+)")


class HouseholdStoreError(RuntimeError):
    """Fail-closed household storage error."""

    def __init__(self, msg: str, *, code: str = "storage_error", status: int = 503):
        super().__init__(msg)
        self.code = code
        self.status = status


def set_acl_for_tests(enabled: bool) -> None:
    """Tests may disable Windows ACL sealing (e.g. restricted runners)."""
    global _APPLY_ACL
    with _guard:
        _APPLY_ACL = bool(enabled)


def household_dir(root: Path | str) -> Path:
    return Path(os.path.abspath(os.fspath(root))) / DIR_NAME


def db_path(root: Path | str) -> Path:
    return household_dir(root) / DB_NAME


def meta_path(root: Path | str) -> Path:
    return household_dir(root) / META_NAME


def backups_dir(root: Path | str) -> Path:
    return household_dir(root) / BACKUPS_DIR


def imports_dir(root: Path | str) -> Path:
    return household_dir(root) / IMPORTS_DIR


# ---------------------------------------------------------------- confinement

def _is_link(path: Path | str) -> bool:
    if os.path.islink(path):
        return True
    is_junction = getattr(os.path, "isjunction", None)
    return bool(is_junction and is_junction(path))


def _same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def _refuse_redirected(path: Path, expected: str, *, what: str) -> None:
    if not os.path.lexists(path):
        return
    if _is_link(path) or not _same(os.path.realpath(path), expected):
        raise HouseholdStoreError(
            f"{what} redirigé — refusé, fichiers conservés",
            code="storage_error",
        )


def confined_household_dir(root: Path | str) -> Path:
    """Refuse symlink/junction redirection of household tree (incl. backups/imports)."""
    base = household_dir(root)
    parent = base.parent
    try:
        real_parent = os.path.realpath(parent)
        expected_base = os.path.join(real_parent, DIR_NAME)
        _refuse_redirected(base, expected_base, what="Emplacement household")
        for name in (
            DB_NAME,
            DB_NAME + "-wal",
            DB_NAME + "-shm",
            META_NAME,
            DB_NAME + ".tmp",
            BACKUPS_DIR,
            IMPORTS_DIR,
        ):
            _refuse_redirected(
                base / name,
                os.path.join(expected_base, name),
                what=f"Chemin household ({name})",
            )
    except OSError as exc:
        raise HouseholdStoreError("Household inaccessible", code="storage_error") from exc
    return base


def _iter_path_prefixes(path: Path) -> list[Path]:
    """Absolute path prefixes from filesystem root down to ``path`` (inclusive)."""
    cur = Path(os.path.abspath(os.fspath(path)))
    chain: list[Path] = []
    while True:
        chain.append(cur)
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    chain.reverse()
    return chain


def _refuse_link_components(path: Path, *, label: str) -> None:
    """Refuse if ``path`` or any existing ancestor is a symlink/junction."""
    try:
        for node in _iter_path_prefixes(path):
            if os.path.lexists(node) and _is_link(node):
                raise HouseholdStoreError(f"{label} redirigé — refusé", code="storage_error")
    except OSError as exc:
        raise HouseholdStoreError(f"{label} inaccessible", code="storage_error") from exc


def _confined_file(path: Path, *, label: str, under: Path | str | None = None) -> Path:
    """Refuse redirected files (self or parent components) used as I/O paths.

    ``realpath`` vs ``resolve`` alone misses intermediate parent symlinks because
    both APIs follow them. Walk lexically and optionally require anchoring under
    an expected root directory.
    """
    abs_path = Path(os.path.abspath(os.fspath(path)))
    _refuse_link_components(abs_path, label=label)
    if abs_path.exists() and not abs_path.is_file():
        raise HouseholdStoreError(f"{label} n'est pas un fichier", code="storage_error")
    if under is not None:
        abs_under = Path(os.path.abspath(os.fspath(under)))
        _refuse_link_components(abs_under, label=f"{label} (racine)")
        try:
            real_file = os.path.realpath(abs_path) if os.path.lexists(abs_path) else str(abs_path)
            real_under = os.path.realpath(abs_under)
        except OSError as exc:
            raise HouseholdStoreError(f"{label} inaccessible", code="storage_error") from exc
        try:
            Path(real_file).relative_to(Path(real_under))
        except ValueError as exc:
            raise HouseholdStoreError(
                f"{label} hors racine attendue — refusé",
                code="storage_error",
            ) from exc
    return abs_path


# ---------------------------------------------------------------- ACL / modes

def _posix_secure(path: Path, *, directory: bool) -> None:
    mode = 0o700 if directory else 0o600
    os.chmod(path, mode)


def _current_user_sid() -> str:
    try:
        result = subprocess.run(
            ["whoami", "/user", "/fo", "csv", "/nh"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HouseholdStoreError("SID utilisateur indisponible", code="acl_error") from exc
    if result.returncode != 0:
        raise HouseholdStoreError("SID utilisateur indisponible", code="acl_error")
    match = _WHOAMI_SID.search(result.stdout or "")
    if not match:
        raise HouseholdStoreError("SID utilisateur illisible", code="acl_error")
    return match.group(1)


def _icacls(path: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["icacls", str(path), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
        check=False,
    )


def describe_path_acl(path: Path) -> dict[str, Any]:
    """Parse ``icacls`` listing into SID-ish tokens (best-effort, for verification)."""
    listed = _icacls(path, [])
    text = listed.stdout or ""
    lower = text.lower()
    sids = set(_WHOAMI_SID.findall(text))
    broad_names = []
    for token in ("Everyone", "Authenticated Users", "BUILTIN\\Users", "Guests"):
        if token.lower() in lower:
            broad_names.append(token)
    has_system = SYSTEM_SID in sids or "nt authority\\system" in lower or "(system)" in lower
    # After /grant:r *SID, icacls may print the SID or the resolved account name.
    return {
        "ok": listed.returncode == 0,
        "text": text,
        "sids": sorted(sids),
        "broad_names": broad_names,
        "has_system": has_system,
        "acceptable": listed.returncode == 0
        and not broad_names
        and not (sids & _FORBIDDEN_SIDS)
        and has_system,
    }


def _windows_restrict(path: Path) -> str:
    """Replace DACL with bridge-user SID + SYSTEM only. Fail-closed if unverifiable."""
    if not _APPLY_ACL or os.name != "nt":
        return "skipped"
    user_sid = _current_user_sid()
    if path.is_dir():
        user_grant = f"*{user_sid}:(OI)(CI)F"
        system_grant = f"*{SYSTEM_SID}:(OI)(CI)F"
    else:
        user_grant = f"*{user_sid}:(F)"
        system_grant = f"*{SYSTEM_SID}:(F)"
    # Strip inheritance, then reset explicit ACEs so we do not layer on Everyone/Users.
    steps = [
        ["/inheritance:r"],
        ["/reset"],
        ["/inheritance:r"],
        ["/grant:r", user_grant, system_grant],
    ]
    # Explicitly remove leftover broad SIDs if reset left anything odd on the parent chain.
    remove = ["/remove:g", *[f"*{sid}" for sid in sorted(_FORBIDDEN_SIDS)]]
    try:
        for args in steps:
            result = _icacls(path, args)
            if result.returncode != 0:
                raise HouseholdStoreError(
                    "ACL household : scellement échoué — ouverture refusée",
                    code="acl_error",
                )
        _icacls(path, remove)  # best-effort; verified below
        facts = describe_path_acl(path)
        user_ok = user_sid in facts["sids"] or (os.environ.get("USERNAME") or "").lower() in facts["text"].lower()
        if not facts["acceptable"] or not user_ok:
            raise HouseholdStoreError(
                "ACL household : DACL effective non conforme — ouverture refusée",
                code="acl_error",
            )
    except HouseholdStoreError:
        raise
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HouseholdStoreError(
            "ACL household indisponible — ouverture refusée",
            code="acl_error",
        ) from exc
    return "restricted"


def _secure_path(path: Path, *, directory: bool) -> None:
    if os.name == "nt":
        _windows_restrict(path)
    else:
        _posix_secure(path, directory=directory)


def _secure_sqlite_sidecars(base: Path) -> None:
    for name in (DB_NAME, DB_NAME + "-wal", DB_NAME + "-shm", META_NAME):
        item = base / name
        if item.is_file() and not _is_link(item):
            _secure_path(item, directory=False)


def prepare_household_dirs(root: Path | str) -> Path:
    """Create ``.hq-household/`` (+ backups/imports) with fail-closed protections."""
    base = confined_household_dir(root)
    if not base.exists():
        base.mkdir(parents=True, exist_ok=False)
    elif not base.is_dir() or _is_link(base):
        raise HouseholdStoreError("Chemin household n'est pas un dossier sûr", code="storage_error")
    _secure_path(base, directory=True)
    for sub in (BACKUPS_DIR, IMPORTS_DIR):
        d = base / sub
        expected = os.path.join(os.path.realpath(base), sub)
        if d.exists():
            _refuse_redirected(d, expected, what=f"Dossier {sub}")
            if not d.is_dir():
                raise HouseholdStoreError(f"{sub} n'est pas un dossier", code="storage_error")
        else:
            d.mkdir(parents=True, exist_ok=False)
        _secure_path(d, directory=True)
    return base


# ---------------------------------------------------------------- schema SQL (no executescript)

_V1_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS household_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at REAL NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at REAL NOT NULL,
      note TEXT NOT NULL
    )
    """,
)


def _exec_sql(conn: sqlite3.Connection, sql: str) -> None:
    conn.execute(sql)


def _apply_v1(conn: sqlite3.Connection) -> None:
    """Apply v1 DDL/DML/user_version with plain execute (transaction-safe)."""
    for stmt in _V1_STATEMENTS:
        _exec_sql(conn, stmt)
    now = time.time()
    conn.execute(
        "INSERT OR REPLACE INTO household_meta(key, value, updated_at) VALUES (?, ?, ?)",
        ("bootstrap", APP_REV, now),
    )
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at, note) VALUES (?, ?, ?)",
        (1, now, "household shell v1"),
    )
    conn.execute("PRAGMA user_version = 1")


_V2_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      currency TEXT NOT NULL CHECK(currency IN ('CAD','USD','EUR')),
      locale TEXT NOT NULL DEFAULT 'fr-CA',
      timezone TEXT NOT NULL DEFAULT 'America/Toronto',
      week_starts TEXT NOT NULL DEFAULT 'mon' CHECK(week_starts IN ('mon','sun')),
      prefs_json TEXT NOT NULL DEFAULT '{}',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL DEFAULT 1 CHECK(rev >= 1)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('cash','checking','credit','savings','other')),
      opening_balance_cents INTEGER NOT NULL,
      currency TEXT NOT NULL CHECK(currency IN ('CAD','USD','EUR')),
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_accounts_household ON accounts(household_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS budget_categories (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('income','expense','transfer')),
      parent_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id),
      FOREIGN KEY (parent_id) REFERENCES budget_categories(id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_categories_household ON budget_categories(household_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      booked_on TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      category_id TEXT NOT NULL,
      payee TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      transfer_pair_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('posted','pending','void')),
      source TEXT NOT NULL CHECK(source IN ('manual','import','grocery_purchase','inventoria','correction')),
      external_fingerprint TEXT,
      correction_of TEXT,
      idempotency_key TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (category_id) REFERENCES budget_categories(id),
      FOREIGN KEY (correction_of) REFERENCES transactions(id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_tx_account_status ON transactions(account_id, status, booked_on)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_tx_household_booked ON transactions(household_id, booked_on, id)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_tx_category_booked ON transactions(category_id, booked_on, status)
    """,
    """
    CREATE TABLE IF NOT EXISTS budget_envelopes (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      allocated_cents INTEGER NOT NULL CHECK(allocated_cents >= 0),
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id),
      FOREIGN KEY (category_id) REFERENCES budget_categories(id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_envelopes_category_period ON budget_envelopes(category_id, period_start, period_end)
    """,
    """
    CREATE TABLE IF NOT EXISTS recurring_payments (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL CHECK(currency IN ('CAD','USD','EUR')),
      cadence TEXT NOT NULL CHECK(cadence IN ('weekly','biweekly','monthly','yearly')),
      next_on TEXT NOT NULL,
      auto_post INTEGER NOT NULL DEFAULT 0 CHECK(auto_post IN (0,1)),
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (category_id) REFERENCES budget_categories(id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_recurring_household ON recurring_payments(household_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      name TEXT NOT NULL,
      target_cents INTEGER NOT NULL CHECK(target_cents >= 0),
      saved_cents INTEGER NOT NULL DEFAULT 0 CHECK(saved_cents >= 0),
      due_on TEXT,
      account_id TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_goals_household ON goals(household_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS ledger_audit (
      id TEXT PRIMARY KEY NOT NULL,
      at REAL NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      reason TEXT,
      ref TEXT
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_ledger_audit_entity ON ledger_audit(entity_type, entity_id, at)
    """,
    """
    CREATE TABLE IF NOT EXISTS finance_idempotency (
      idempotency_key TEXT PRIMARY KEY NOT NULL,
      operation TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at REAL NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1))
    )
    """,
)


def _apply_v2(conn: sqlite3.Connection) -> None:
    """Finances domain tables (v2). Each migration sets its own user_version."""
    for stmt in _V2_STATEMENTS:
        _exec_sql(conn, stmt)
    now = time.time()
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at, note) VALUES (?, ?, ?)",
        (2, now, "household finances core v2"),
    )
    conn.execute("PRAGMA user_version = 2")


def _backfill_envelope_currency_from_households(conn: sqlite3.Connection) -> None:
    """v2 envelopes had no currency — inherit household reference at migration."""
    conn.execute(
        """
        UPDATE budget_envelopes
        SET currency = (
            SELECT h.currency FROM households h WHERE h.id = budget_envelopes.household_id
        )
        """
    )
    bad = int(
        conn.execute(
            "SELECT COUNT(*) FROM budget_envelopes "
            "WHERE currency IS NULL OR currency = '' "
            "OR currency NOT IN ('CAD', 'USD', 'EUR')"
        ).fetchone()[0]
    )
    if bad:
        raise HouseholdStoreError(
            "Backfill devise enveloppe incomplet",
            code="schema_error",
        )


def _backfill_envelope_currency_nulls_only(conn: sqlite3.Connection) -> None:
    """Set currency only when absent — never overwrite an explicit envelope currency."""
    conn.execute(
        """
        UPDATE budget_envelopes
        SET currency = (
            SELECT h.currency FROM households h WHERE h.id = budget_envelopes.household_id
        )
        WHERE currency IS NULL OR currency = ''
        """
    )
    bad = int(
        conn.execute(
            "SELECT COUNT(*) FROM budget_envelopes "
            "WHERE currency IS NULL OR currency = '' "
            "OR currency NOT IN ('CAD', 'USD', 'EUR')"
        ).fetchone()[0]
    )
    if bad:
        raise HouseholdStoreError(
            "Backfill devise enveloppe incomplet",
            code="schema_error",
        )


def _apply_v3(conn: sqlite3.Connection) -> None:
    """Envelope reference currency (no cross-currency spend rollups)."""
    info = {str(r[1]) for r in conn.execute("PRAGMA table_info(budget_envelopes)")}
    if "currency" not in info:
        _exec_sql(conn, "ALTER TABLE budget_envelopes ADD COLUMN currency TEXT")
        _backfill_envelope_currency_from_households(conn)
    else:
        _backfill_envelope_currency_nulls_only(conn)
    now = time.time()
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at, note) VALUES (?, ?, ?)",
        (3, now, "envelope currency v3 household backfill"),
    )
    conn.execute("PRAGMA user_version = 3")


_V4_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT,
      barcode TEXT,
      canonical_unit TEXT NOT NULL CHECK(canonical_unit IN ('g','ml','each','serving')),
      default_qty_milli INTEGER NOT NULL CHECK(default_qty_milli >= 0),
      category_tags_json TEXT NOT NULL DEFAULT '[]',
      inventory_item_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id)
    )
    """,
    """
    CREATE UNIQUE INDEX IF NOT EXISTS idx_products_household_barcode
      ON products(household_id, barcode)
      WHERE barcode IS NOT NULL AND barcode != ''
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_products_household_name ON products(household_id, name, id)
    """,
    """
    CREATE TABLE IF NOT EXISTS food_lots (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      item_id TEXT,
      place_id TEXT,
      qty_milli INTEGER NOT NULL CHECK(qty_milli >= 0),
      usable_qty_milli INTEGER NOT NULL CHECK(usable_qty_milli >= 0),
      canonical_unit TEXT NOT NULL CHECK(canonical_unit IN ('g','ml','each','serving')),
      expires_on TEXT,
      opened_on TEXT,
      source_purchase_id TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      CHECK (usable_qty_milli <= qty_milli)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_food_lots_product ON food_lots(product_id, expires_on, id)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_food_lots_household ON food_lots(household_id, id)
    """,
    """
    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      name TEXT NOT NULL,
      location_label TEXT,
      provider_id TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_merchants_household_name ON merchants(household_id, name, id)
    """,
)


def _apply_v4(conn: sqlite3.Connection) -> None:
    """Grocery catalogue, food lots, merchants (v4)."""
    for stmt in _V4_STATEMENTS:
        _exec_sql(conn, stmt)
    now = time.time()
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at, note) VALUES (?, ?, ?)",
        (4, now, "household grocery core v4"),
    )
    conn.execute("PRAGMA user_version = 4")


_V5_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      title TEXT NOT NULL,
      servings INTEGER NOT NULL CHECK(servings >= 1 AND servings <= 100),
      ingredients_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      leftover_policy TEXT NOT NULL CHECK(leftover_policy IN ('none','freeze','plan_next')),
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_recipes_household_title ON recipes(household_id, title, id)
    """,
    """
    CREATE TABLE IF NOT EXISTS meal_plans (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      slots_json TEXT NOT NULL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_meal_plans_household_period ON meal_plans(household_id, period_start, id)
    """,
    """
    CREATE TABLE IF NOT EXISTS grocery_lists (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      meal_plan_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('open','shopping','closed')),
      lines_json TEXT NOT NULL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id),
      FOREIGN KEY (meal_plan_id) REFERENCES meal_plans(id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_grocery_lists_household_status ON grocery_lists(household_id, status, id)
    """,
    """
    CREATE TABLE IF NOT EXISTS grocery_list_build_idempotency (
      household_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      preview_digest TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at REAL NOT NULL,
      PRIMARY KEY (household_id, idempotency_key),
      FOREIGN KEY (household_id) REFERENCES households(id)
    )
    """,
)


def _apply_v5(conn: sqlite3.Connection) -> None:
    """Meals recipes, plans, grocery lists (v5)."""
    for stmt in _V5_STATEMENTS:
        _exec_sql(conn, stmt)
    now = time.time()
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at, note) VALUES (?, ?, ?)",
        (5, now, "household meals core v5"),
    )
    conn.execute("PRAGMA user_version = 5")


_V6_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS actual_purchases (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      planned_id TEXT,
      product_id TEXT,
      merchant_id TEXT NOT NULL,
      qty_milli INTEGER NOT NULL CHECK(qty_milli >= 1),
      unit TEXT NOT NULL,
      paid_cents INTEGER NOT NULL CHECK(paid_cents >= 0),
      taxed_cents INTEGER NOT NULL DEFAULT 0 CHECK(taxed_cents >= 0),
      deposit_cents INTEGER NOT NULL DEFAULT 0 CHECK(deposit_cents >= 0),
      purchased_on TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      finance_tx_id TEXT,
      food_lot_id TEXT,
      idempotency_key TEXT NOT NULL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      rev INTEGER NOT NULL CHECK(rev >= 1),
      FOREIGN KEY (household_id) REFERENCES households(id),
      FOREIGN KEY (merchant_id) REFERENCES merchants(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    )
    """,
    """
    CREATE UNIQUE INDEX IF NOT EXISTS idx_actual_purchases_fingerprint
      ON actual_purchases(household_id, fingerprint)
    """,
    """
    CREATE UNIQUE INDEX IF NOT EXISTS idx_actual_purchases_idempotency
      ON actual_purchases(household_id, idempotency_key)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_actual_purchases_household_date
      ON actual_purchases(household_id, purchased_on, id)
    """,
    """
    CREATE TABLE IF NOT EXISTS purchase_idempotency (
      household_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at REAL NOT NULL,
      PRIMARY KEY (household_id, idempotency_key),
      FOREIGN KEY (household_id) REFERENCES households(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS cross_store_ops (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      planned_steps_json TEXT NOT NULL,
      step_index INTEGER NOT NULL CHECK(step_index >= 0),
      step_results_json TEXT NOT NULL DEFAULT '[]',
      inventory_rev_before INTEGER,
      inventory_rev_after INTEGER,
      uncertain_inventory INTEGER NOT NULL DEFAULT 0 CHECK(uncertain_inventory IN (0, 1)),
      reconcile_plan_json TEXT,
      error_code TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      closed_at REAL,
      FOREIGN KEY (household_id) REFERENCES households(id),
      UNIQUE (household_id, idempotency_key)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_cross_store_ops_household_status
      ON cross_store_ops(household_id, status, id)
    """,
)


def _apply_v6(conn: sqlite3.Connection) -> None:
    """Actual purchases, purchase idempotency, cross-store journal (v6)."""
    for stmt in _V6_STATEMENTS:
        _exec_sql(conn, stmt)
    now = time.time()
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at, note) VALUES (?, ?, ?)",
        (6, now, "household actual purchases core v6"),
    )
    conn.execute("PRAGMA user_version = 6")


_MIGRATIONS: dict[int, Any] = {
    1: _apply_v1,
    2: _apply_v2,
    3: _apply_v3,
    4: _apply_v4,
    5: _apply_v5,
    6: _apply_v6,
}


# ---------------------------------------------------------------- meta mirror

def _utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _meta_schema_version(meta: dict) -> int | None:
    """Return mirror schema_version only when it is a real int (not bool/list/object)."""
    raw = meta.get("schema_version", None)
    if type(raw) is not int:  # bool is int subclass — reject it too
        return None
    return raw


def _read_meta(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HouseholdStoreError(
            "schema_meta.json illisible — miroir refusé, SQLite non écrasé",
            code="meta_error",
        ) from exc
    if not isinstance(data, dict):
        raise HouseholdStoreError("schema_meta.json invalide", code="meta_error")
    return data


def _write_meta(path: Path, *, schema_version: int) -> None:
    if path.exists():
        _confined_file(path, label="schema_meta", under=path.parent)
    payload = {
        "schema_version": schema_version,
        "applied_at": _utc_iso(),
        "app_rev": APP_REV,
        "authority": "sqlite_user_version",
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except OSError as exc:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        raise HouseholdStoreError(
            "Écriture schema_meta.json impossible — SQLite reste l'autorité",
            code="meta_error",
        ) from exc
    _secure_path(path, directory=False)


# ---------------------------------------------------------------- connection

def _connect(path: Path, *, readonly: bool = False, wal: bool | None = None) -> sqlite3.Connection:
    """Open SQLite. WAL is opt-in so version gates can run without side files."""
    if readonly:
        uri = path.resolve().as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=BUSY_TIMEOUT_MS / 1000.0)
    else:
        conn = sqlite3.connect(str(path), timeout=BUSY_TIMEOUT_MS / 1000.0)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    use_wal = (not readonly) if wal is None else bool(wal)
    if use_wal:
        _enable_wal(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _enable_wal(conn: sqlite3.Connection) -> None:
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.Error:
        pass


def get_schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("PRAGMA user_version").fetchone()
    return int(row[0])


def integrity_check(conn: sqlite3.Connection) -> str:
    row = conn.execute("PRAGMA integrity_check").fetchone()
    return str(row[0])


_V1_REQUIRED: dict[str, tuple[str, ...]] = {
    "household_meta": ("key", "value", "updated_at"),
    "schema_migrations": ("version", "applied_at", "note"),
}


_V2_REQUIRED: dict[str, tuple[str, ...]] = {
    "households": ("id", "name", "currency", "locale", "timezone", "week_starts", "prefs_json", "created_at", "updated_at", "rev"),
    "accounts": ("id", "household_id", "name", "kind", "opening_balance_cents", "currency", "archived", "created_at", "updated_at", "rev"),
    "budget_categories": ("id", "household_id", "name", "kind", "parent_id", "archived", "created_at", "updated_at", "rev"),
    "transactions": ("id", "household_id", "account_id", "booked_on", "amount_cents", "category_id", "payee", "memo", "transfer_pair_id", "status", "source", "correction_of", "rev"),
    "budget_envelopes": ("id", "household_id", "category_id", "period_start", "period_end", "allocated_cents", "created_at", "updated_at", "rev"),
    "recurring_payments": ("id", "household_id", "account_id", "category_id", "amount_cents", "currency", "cadence", "next_on", "auto_post", "created_at", "updated_at", "rev"),
    "goals": ("id", "household_id", "name", "target_cents", "saved_cents", "due_on", "account_id", "created_at", "updated_at", "rev"),
    "ledger_audit": ("id", "at", "actor", "action", "entity_type", "entity_id", "before_json", "after_json", "reason", "ref"),
    "finance_idempotency": ("idempotency_key", "operation", "request_hash", "entity_type", "entity_id", "response_json", "created_at", "pinned"),
}


def _validate_schema_tables(conn: sqlite3.Connection, required: dict[str, tuple[str, ...]], *, label: str) -> None:
    for table, cols in required.items():
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        ).fetchone()
        if row is None:
            raise HouseholdStoreError(
                f"Schéma {label} incomplet — table {table} absente",
                code="schema_error",
            )
        info = {str(r[1]) for r in conn.execute(f"PRAGMA table_info({table})")}
        missing = set(cols) - info
        if missing:
            raise HouseholdStoreError(
                f"Schéma {label} incomplet — colonnes manquantes ({table})",
                code="schema_error",
            )


def validate_schema_v1(conn: sqlite3.Connection) -> None:
    """Fail closed when user_version claims v1 but essential structures are missing."""
    _validate_schema_tables(conn, _V1_REQUIRED, label="v1")


def validate_schema_v2(conn: sqlite3.Connection) -> None:
    """Fail closed when user_version claims v2 but finance tables are missing."""
    _validate_schema_tables(conn, _V2_REQUIRED, label="v2")


_V3_EXTRA_COLS: dict[str, tuple[str, ...]] = {
    "budget_envelopes": ("currency",),
}


def validate_schema_v3(conn: sqlite3.Connection) -> None:
    validate_schema_v2(conn)
    for table, cols in _V3_EXTRA_COLS.items():
        info = {str(r[1]) for r in conn.execute(f"PRAGMA table_info({table})")}
        missing = set(cols) - info
        if missing:
            raise HouseholdStoreError(
                f"Schéma v3 incomplet — colonnes manquantes ({table})",
                code="schema_error",
            )


_V4_REQUIRED: dict[str, tuple[str, ...]] = {
    "products": (
        "id", "household_id", "name", "canonical_unit", "default_qty_milli",
        "category_tags_json", "archived", "created_at", "updated_at", "rev",
    ),
    "food_lots": (
        "id", "household_id", "product_id", "qty_milli", "usable_qty_milli",
        "canonical_unit", "created_at", "updated_at", "rev",
    ),
    "merchants": (
        "id", "household_id", "name", "created_at", "updated_at", "rev",
    ),
}


def validate_schema_v4(conn: sqlite3.Connection) -> None:
    validate_schema_v3(conn)
    _validate_schema_tables(conn, _V4_REQUIRED, label="v4")


_V5_REQUIRED: dict[str, tuple[str, ...]] = {
    "recipes": (
        "id", "household_id", "title", "servings", "ingredients_json", "steps_json",
        "leftover_policy", "created_at", "updated_at", "rev",
    ),
    "meal_plans": (
        "id", "household_id", "period_start", "period_end", "slots_json",
        "created_at", "updated_at", "rev",
    ),
    "grocery_lists": (
        "id", "household_id", "status", "lines_json",
        "created_at", "updated_at", "rev",
    ),
    "grocery_list_build_idempotency": (
        "household_id", "idempotency_key", "operation", "request_hash", "preview_digest",
        "entity_type", "entity_id", "response_json", "created_at",
    ),
}


def validate_schema_v5(conn: sqlite3.Connection) -> None:
    validate_schema_v4(conn)
    _validate_schema_tables(conn, _V5_REQUIRED, label="v5")


_V6_REQUIRED: dict[str, tuple[str, ...]] = {
    "actual_purchases": (
        "id", "household_id", "merchant_id", "qty_milli", "unit", "paid_cents",
        "purchased_on", "fingerprint", "idempotency_key", "created_at", "updated_at", "rev",
    ),
    "purchase_idempotency": (
        "household_id", "idempotency_key", "operation", "request_hash",
        "entity_type", "entity_id", "response_json", "created_at",
    ),
    "cross_store_ops": (
        "id", "household_id", "kind", "idempotency_key", "status", "request_hash",
        "planned_steps_json", "step_index", "step_results_json", "uncertain_inventory",
        "created_at", "updated_at",
    ),
}


def validate_schema_v6(conn: sqlite3.Connection) -> None:
    validate_schema_v5(conn)
    _validate_schema_tables(conn, _V6_REQUIRED, label="v6")


def _repair_additive_v6_indexes(conn: sqlite3.Connection) -> None:
    """Idempotent index for DBs created before idempotency uniqueness was added to v6."""
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_actual_purchases_idempotency "
        "ON actual_purchases(household_id, idempotency_key)"
    )


def _validate_schema_for_version(conn: sqlite3.Connection, version: int) -> None:
    validate_schema_v1(conn)
    if version >= 2:
        validate_schema_v2(conn)
    if version >= 3:
        validate_schema_v3(conn)
    if version >= 4:
        validate_schema_v4(conn)
    if version >= 5:
        validate_schema_v5(conn)
    if version >= 6:
        validate_schema_v6(conn)


# ---------------------------------------------------------------- open / migrate

def migrate(conn: sqlite3.Connection, *, target: int = SCHEMA_VERSION) -> int:
    """Apply migrations inside one IMMEDIATE transaction (no executescript)."""
    current = get_schema_version(conn)
    if current > target:
        raise HouseholdStoreError(
            f"Downgrade refusé (db={current} > code={target})",
            code="downgrade_refused",
            status=500,
        )
    if current == target:
        return current
    if current < 0:
        raise HouseholdStoreError("user_version invalide", code="schema_error")
    try:
        conn.execute("BEGIN IMMEDIATE")
        while current < target:
            nxt = current + 1
            fn = _MIGRATIONS.get(nxt)
            if fn is None:
                raise HouseholdStoreError(f"Migration {nxt} absente", code="schema_error")
            fn(conn)
            current = get_schema_version(conn)
            if current != nxt:
                raise HouseholdStoreError(
                    f"Migration {nxt} n'a pas posé user_version",
                    code="schema_error",
                )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        raise
    return current


class HouseholdStore:
    """Opened household store handle (explicit close)."""

    def __init__(
        self,
        root: Path | str,
        conn: sqlite3.Connection,
        *,
        schema_version: int,
        readonly: bool = False,
    ):
        self.root = Path(os.path.abspath(os.fspath(root)))
        self.conn = conn
        self.schema_version = schema_version
        self.path = db_path(self.root)
        self.readonly = readonly

    def close(self) -> None:
        try:
            self.conn.close()
        except sqlite3.Error:
            pass

    def __enter__(self) -> "HouseholdStore":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        if self.readonly:
            raise HouseholdStoreError("transaction refusée en lecture seule", code="readonly", status=400)
        try:
            yield self.conn
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    def set_meta(self, key: str, value: str) -> None:
        if self.readonly:
            raise HouseholdStoreError("écriture refusée en lecture seule", code="readonly", status=400)
        if not isinstance(key, str) or not key or len(key) > 128:
            raise HouseholdStoreError("clé meta invalide", code="validation_error", status=400)
        if not isinstance(value, str) or len(value) > 4000:
            raise HouseholdStoreError("valeur meta invalide", code="validation_error", status=400)
        with self.transaction():
            self.conn.execute(
                "INSERT OR REPLACE INTO household_meta(key, value, updated_at) VALUES (?, ?, ?)",
                (key, value, time.time()),
            )

    def get_meta(self, key: str) -> str | None:
        row = self.conn.execute(
            "SELECT value FROM household_meta WHERE key = ?", (key,)
        ).fetchone()
        return None if row is None else str(row[0])


def open_store(
    root: Path | str,
    *,
    create: bool = True,
    readonly: bool = False,
) -> HouseholdStore:
    """Open or initialize the household SQLite DB. Never called on import."""
    if readonly and create:
        create = False

    if readonly:
        # No mkdir / ACL rewrite / meta heal on readonly opens.
        base = confined_household_dir(root)
        path = base / DB_NAME
        if not path.is_file() or _is_link(path):
            raise HouseholdStoreError("Base household absente", code="not_found", status=404)
        try:
            conn = _connect(path, readonly=True)
        except sqlite3.Error as exc:
            raise HouseholdStoreError("Base household illisible — octets conservés", code="corrupt") from exc
        try:
            try:
                check = integrity_check(conn)
            except sqlite3.Error as exc:
                raise HouseholdStoreError(
                    "Base household corrompue — octets conservés",
                    code="corrupt",
                ) from exc
            if check != "ok":
                raise HouseholdStoreError("Base household corrompue — octets conservés", code="corrupt")
            current = get_schema_version(conn)
            if current > SCHEMA_VERSION:
                raise HouseholdStoreError(
                    f"Downgrade refusé (db={current} > code={SCHEMA_VERSION})",
                    code="downgrade_refused",
                    status=500,
                )
            if current < SCHEMA_VERSION:
                raise HouseholdStoreError(
                    "Migration requise — ouverture lecture seule refusée",
                    code="migrate_required",
                    status=503,
                )
            if current == SCHEMA_VERSION:
                _validate_schema_for_version(conn, current)
            return HouseholdStore(root, conn, schema_version=current, readonly=True)
        except Exception:
            conn.close()
            raise

    base = prepare_household_dirs(root) if create or household_dir(root).exists() else confined_household_dir(root)
    path = base / DB_NAME
    existed = path.is_file()

    if not existed:
        if not create:
            raise HouseholdStoreError("Base household absente", code="not_found", status=404)
        # New DB: WAL only after a successful migrate + schema gate.
        conn = _connect(path, readonly=False, wal=False)
        try:
            migrate(conn, target=SCHEMA_VERSION)
            check = integrity_check(conn)
            if check != "ok":
                raise HouseholdStoreError(f"intégrité échec: {check}", code="corrupt")
            ver = get_schema_version(conn)
            if ver >= 6:
                _repair_additive_v6_indexes(conn)
            _validate_schema_for_version(conn, ver)
            _enable_wal(conn)
        except Exception:
            conn.close()
            if path.is_file():
                try:
                    path.unlink()
                except OSError:
                    pass
            for side in (path.with_name(DB_NAME + "-wal"), path.with_name(DB_NAME + "-shm")):
                try:
                    if side.is_file():
                        side.unlink()
                except OSError:
                    pass
            raise
        try:
            _write_meta(meta_path(root), schema_version=ver)
        except HouseholdStoreError:
            conn.close()
            raise
        _secure_sqlite_sidecars(base)
        return HouseholdStore(root, conn, schema_version=ver, readonly=False)

    # Existing DB: never flip WAL before version / compatibility gates.
    try:
        conn = _connect(path, readonly=False, wal=False)
    except sqlite3.Error as exc:
        raise HouseholdStoreError("Base household illisible — octets conservés", code="corrupt") from exc
    try:
        try:
            check = integrity_check(conn)
        except sqlite3.Error as exc:
            raise HouseholdStoreError(
                "Base household corrompue — octets conservés",
                code="corrupt",
            ) from exc
        if check != "ok":
            raise HouseholdStoreError("Base household corrompue — octets conservés", code="corrupt")
        current = get_schema_version(conn)
        if current > SCHEMA_VERSION:
            raise HouseholdStoreError(
                f"Downgrade refusé (db={current} > code={SCHEMA_VERSION})",
                code="downgrade_refused",
                status=500,
            )
        if current < SCHEMA_VERSION:
            if current >= 1:
                validate_schema_v1(conn)
            snap = backup(root, label="pre-migrate", conn=conn)
            if not snap.get("ok"):
                raise HouseholdStoreError(
                    "Sauvegarde pré-migration échouée — migration refusée",
                    code="backup_error",
                )
            migrate(conn, target=SCHEMA_VERSION)
            check2 = integrity_check(conn)
            if check2 != "ok":
                raise HouseholdStoreError("intégrité post-migration échec", code="corrupt")
            current = get_schema_version(conn)
        if current >= 6:
            _repair_additive_v6_indexes(conn)
        if current == SCHEMA_VERSION:
            _validate_schema_for_version(conn, current)
        _enable_wal(conn)
        meta = None
        try:
            meta = _read_meta(meta_path(root))
        except HouseholdStoreError:
            meta = None
        mirror_ver = None if meta is None else _meta_schema_version(meta)
        if mirror_ver != current:
            try:
                _write_meta(meta_path(root), schema_version=current)
            except HouseholdStoreError:
                pass
        _secure_sqlite_sidecars(base)
        return HouseholdStore(root, conn, schema_version=current, readonly=False)
    except Exception:
        conn.close()
        raise


# ---------------------------------------------------------------- backup / restore

def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_manifest(man: Path) -> dict[str, Any]:
    _confined_file(man, label="manifeste")
    if not man.is_file():
        raise HouseholdStoreError("Manifeste SHA-256 requis", code="manifest_error", status=400)
    try:
        meta = json.loads(man.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HouseholdStoreError("Manifeste malformé", code="manifest_error", status=400) from exc
    if not isinstance(meta, dict):
        raise HouseholdStoreError("Manifeste malformé", code="manifest_error", status=400)
    digest = meta.get("sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise HouseholdStoreError("Manifeste sans SHA-256 valide", code="manifest_error", status=400)
    if "schema_version" not in meta or not isinstance(meta["schema_version"], int):
        raise HouseholdStoreError("Manifeste sans schema_version", code="manifest_error", status=400)
    return meta


def backup(
    root: Path | str,
    *,
    label: str = "manual",
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Coherent SQLite snapshot via Connection.backup() into private backups/."""
    base = confined_household_dir(root)
    bdir = base / BACKUPS_DIR
    expected_bdir = os.path.join(os.path.realpath(base), BACKUPS_DIR)
    if bdir.exists():
        _refuse_redirected(bdir, expected_bdir, what="Dossier backups")
    if not bdir.is_dir():
        prepare_household_dirs(root)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_label = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in label)[:40] or "snap"
    snap_name = f"household-{safe_label}-{stamp}.sqlite"
    dest = bdir / snap_name
    man_path = dest.with_suffix(dest.suffix + ".manifest.json")
    own = False
    src = conn
    if src is None:
        if not (base / DB_NAME).is_file():
            raise HouseholdStoreError("Rien à sauvegarder", code="not_found", status=404)
        src = _connect(base / DB_NAME, readonly=False)
        own = True
    try:
        if dest.exists() or _is_link(dest) or man_path.exists() or _is_link(man_path):
            raise HouseholdStoreError("Cible de sauvegarde invalide", code="backup_error")
        dest_conn = sqlite3.connect(str(dest))
        try:
            _sqlite_backup(src, dest_conn)
            dest_conn.commit()
        finally:
            dest_conn.close()
        check_conn = sqlite3.connect(str(dest))
        try:
            ok = integrity_check(check_conn) == "ok"
            ver = get_schema_version(check_conn)
        finally:
            check_conn.close()
        if not ok:
            try:
                dest.unlink()
            except OSError:
                pass
            raise HouseholdStoreError("Snapshot invalide — original intact", code="backup_error")
        digest = _sha256_file(dest)
        manifest = {
            "schema_version": ver,
            "sha256": digest,
            "taken_at": _utc_iso(),
            "label": safe_label,
            "file": snap_name,
            "bytes": dest.stat().st_size,
            "ok": True,
        }
        man_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        _secure_path(dest, directory=False)
        _secure_path(man_path, directory=False)
        return manifest
    except HouseholdStoreError:
        raise
    except (OSError, sqlite3.Error) as exc:
        for p in (dest, man_path):
            if p.exists():
                try:
                    p.unlink()
                except OSError:
                    pass
        raise HouseholdStoreError(
            "Sauvegarde échouée — original intact",
            code="backup_error",
        ) from exc
    finally:
        if own and src is not None:
            src.close()


def restore_to_temp(
    snapshot: Path | str,
    *,
    dest_root: Path | str,
) -> HouseholdStore:
    """Restore a verified snapshot + mandatory manifest into an isolated ROOT."""
    snap = _confined_file(Path(snapshot), label="Snapshot")
    if not snap.is_file():
        raise HouseholdStoreError("Snapshot introuvable", code="not_found", status=404)
    man = _confined_file(snap.with_suffix(snap.suffix + ".manifest.json"), label="Manifeste")
    meta = _load_manifest(man)
    digest = _sha256_file(snap)
    if digest != meta["sha256"]:
        raise HouseholdStoreError("Checksum snapshot invalide", code="corrupt")
    check = sqlite3.connect(str(snap))
    try:
        if integrity_check(check) != "ok":
            raise HouseholdStoreError("Snapshot corrompu", code="corrupt")
        ver = get_schema_version(check)
    finally:
        check.close()
    if int(meta["schema_version"]) != ver:
        raise HouseholdStoreError("Manifeste / snapshot incohérents", code="corrupt")

    dest = Path(os.path.abspath(os.fspath(dest_root)))
    hh = dest / DIR_NAME
    if hh.exists():
        raise HouseholdStoreError(
            "ROOT temporaire déjà peuplé — restauration refusée",
            code="restore_error",
        )
    prepare_household_dirs(dest)
    target = db_path(dest)
    if target.exists() or _is_link(target):
        raise HouseholdStoreError("Cible DB existe déjà", code="restore_error")

    src = sqlite3.connect(str(snap))
    try:
        dst = sqlite3.connect(str(target))
        try:
            _sqlite_backup(src, dst)
            dst.commit()
            if integrity_check(dst) != "ok":
                raise HouseholdStoreError("Destination restaurée corrompue", code="corrupt")
            if get_schema_version(dst) != ver:
                raise HouseholdStoreError("Destination restaurée incohérente", code="corrupt")
        finally:
            dst.close()
    finally:
        src.close()
    _write_meta(meta_path(dest), schema_version=ver)
    _secure_sqlite_sidecars(household_dir(dest))
    return open_store(dest, create=False)


def _sqlite_backup(src: sqlite3.Connection, dest: sqlite3.Connection) -> None:
    """Indirection so tests can inject backup failures without patching C types."""
    src.backup(dest)


def schema_version_constant() -> int:
    return SCHEMA_VERSION
