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
import sqlite3
import stat
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

# Durable authority — bump only with a migration step + backup.
SCHEMA_VERSION = 1
BUSY_TIMEOUT_MS = 5_000
APP_REV = "household-shell-v1"

_APPLY_ACL = True
_guard = threading.Lock()


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


# ---------------------------------------------------------------- confinement

def _is_link(path: Path | str) -> bool:
    if os.path.islink(path):
        return True
    is_junction = getattr(os.path, "isjunction", None)
    return bool(is_junction and is_junction(path))


def _same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def confined_household_dir(root: Path | str) -> Path:
    """Refuse symlink/junction redirection of the household folder or DB siblings."""
    base = household_dir(root)
    parent = base.parent
    try:
        real_parent = os.path.realpath(parent)
        expected = os.path.join(real_parent, DIR_NAME)
        if os.path.lexists(base) and (_is_link(base) or not _same(os.path.realpath(base), expected)):
            raise HouseholdStoreError(
                "Emplacement household redirigé — refusé, fichiers conservés",
                code="storage_error",
            )
        for name in (DB_NAME, DB_NAME + "-wal", DB_NAME + "-shm", META_NAME, DB_NAME + ".tmp"):
            item = base / name
            if os.path.lexists(item) and (
                _is_link(item) or not _same(os.path.realpath(item), os.path.join(expected, name))
            ):
                raise HouseholdStoreError(
                    "Fichier household redirigé — refusé, octets conservés",
                    code="storage_error",
                )
    except OSError as exc:
        raise HouseholdStoreError("Household inaccessible", code="storage_error") from exc
    return base


# ---------------------------------------------------------------- ACL / modes

def _posix_secure(path: Path, *, directory: bool) -> None:
    mode = 0o700 if directory else 0o600
    os.chmod(path, mode)


def _windows_restrict(path: Path) -> str:
    """Owner + SYSTEM only; inheritance removed. Fail-closed on unverified."""
    if not _APPLY_ACL or os.name != "nt":
        return "skipped"
    user = os.environ.get("USERNAME") or ""
    if not user or any(ch in user for ch in '\\"/&|<>'):
        raise HouseholdStoreError(
            "ACL household impossible — USERNAME invalide, ouverture refusée",
            code="acl_error",
            status=503,
        )
    # Directory ACEs must propagate; files need explicit (F).
    if path.is_dir():
        grants = [f"{user}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"]
    else:
        grants = [f"{user}:(F)", "*S-1-5-18:(F)"]
    try:
        inherit = subprocess.run(
            ["icacls", str(path), "/inheritance:r"],
            capture_output=True,
            timeout=20,
            check=False,
        )
        if inherit.returncode != 0:
            raise HouseholdStoreError(
                "ACL household : héritage non retiré — ouverture refusée",
                code="acl_error",
            )
        for grant in grants:
            granted = subprocess.run(
                ["icacls", str(path), "/grant:r", grant],
                capture_output=True,
                timeout=20,
                check=False,
            )
            if granted.returncode != 0:
                raise HouseholdStoreError(
                    "ACL household : grant échoué — ouverture refusée",
                    code="acl_error",
                )
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
    elif not base.is_dir():
        raise HouseholdStoreError("Chemin household n'est pas un dossier", code="storage_error")
    _secure_path(base, directory=True)
    for sub in (BACKUPS_DIR, IMPORTS_DIR):
        d = base / sub
        if not d.exists():
            d.mkdir(parents=True, exist_ok=False)
        _secure_path(d, directory=True)
    return base


# ---------------------------------------------------------------- schema SQL

_V1_DDL = """
CREATE TABLE IF NOT EXISTS household_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  applied_at REAL NOT NULL,
  note TEXT NOT NULL
);
-- Domain tables (finances / grocery / meals / inventoria / cross_store_ops)
-- arrive in later PRs. This shell only owns versioning + meta.
"""


def _apply_v1(conn: sqlite3.Connection) -> None:
    conn.executescript(_V1_DDL)
    now = time.time()
    conn.execute(
        "INSERT OR REPLACE INTO household_meta(key, value, updated_at) VALUES (?, ?, ?)",
        ("bootstrap", APP_REV, now),
    )
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version, applied_at, note) VALUES (?, ?, ?)",
        (1, now, "household shell v1"),
    )
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


_MIGRATIONS: dict[int, Any] = {
    1: _apply_v1,
}


# ---------------------------------------------------------------- meta mirror

def _utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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
    try:
        _secure_path(path, directory=False)
    except HouseholdStoreError:
        # Meta written; ACL failure still fail-closed for subsequent opens.
        raise


def _heal_meta(root: Path | str, schema_version: int) -> None:
    """Rewrite mirror from SQLite authority without changing the DB."""
    path = meta_path(root)
    try:
        _write_meta(path, schema_version=schema_version)
    except HouseholdStoreError:
        # Opening remains allowed: SQLite is authority. Caller may surface warning via return.
        raise


# ---------------------------------------------------------------- connection

def _connect(path: Path, *, readonly: bool = False) -> sqlite3.Connection:
    if readonly:
        uri = path.resolve().as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=BUSY_TIMEOUT_MS / 1000.0)
    else:
        conn = sqlite3.connect(str(path), timeout=BUSY_TIMEOUT_MS / 1000.0)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.Error:
        # Some filesystems reject WAL — continue with default journal.
        pass
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def get_schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("PRAGMA user_version").fetchone()
    return int(row[0])


def integrity_check(conn: sqlite3.Connection) -> str:
    row = conn.execute("PRAGMA integrity_check").fetchone()
    return str(row[0])


# ---------------------------------------------------------------- open / migrate

def _db_bytes_unchanged(path: Path, before: bytes | None) -> bool:
    if before is None:
        return not path.exists()
    if not path.exists():
        return False
    return path.read_bytes() == before


def migrate(conn: sqlite3.Connection, *, target: int = SCHEMA_VERSION) -> int:
    """Apply migrations inside a transaction. On failure, rollback; DB untouched."""
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
                raise HouseholdStoreError(
                    f"Migration {nxt} absente",
                    code="schema_error",
                )
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

    def __init__(self, root: Path | str, conn: sqlite3.Connection, *, schema_version: int):
        self.root = Path(os.path.abspath(os.fspath(root)))
        self.conn = conn
        self.schema_version = schema_version
        self.path = db_path(self.root)

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
        try:
            yield self.conn
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    def set_meta(self, key: str, value: str) -> None:
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
    base = prepare_household_dirs(root) if create or household_dir(root).exists() else confined_household_dir(root)
    path = base / DB_NAME
    existed = path.is_file()
    before = path.read_bytes() if existed else None

    if not existed:
        if not create or readonly:
            raise HouseholdStoreError("Base household absente", code="not_found", status=404)
        conn = _connect(path, readonly=False)
        try:
            migrate(conn, target=SCHEMA_VERSION)
            check = integrity_check(conn)
            if check != "ok":
                raise HouseholdStoreError(f"intégrité échec: {check}", code="corrupt")
            ver = get_schema_version(conn)
        except Exception:
            conn.close()
            # New file — remove only if we created a broken empty DB
            if path.is_file() and (before is None):
                try:
                    path.unlink()
                except OSError:
                    pass
            raise
        try:
            _write_meta(meta_path(root), schema_version=ver)
        except HouseholdStoreError:
            # SQLite is valid; leave store open but surface by healing attempt logged via exception
            # Re-raise: caller must know meta failed — yet we keep DB. Policy: fail-closed on first create
            # if meta cannot be written (no half-initialized install).
            conn.close()
            raise
        _secure_sqlite_sidecars(base)
        return HouseholdStore(root, conn, schema_version=ver)

    # Existing DB
    try:
        conn = _connect(path, readonly=readonly)
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
            raise HouseholdStoreError(
                "Base household corrompue — octets conservés",
                code="corrupt",
            )
        current = get_schema_version(conn)
        if current > SCHEMA_VERSION:
            raise HouseholdStoreError(
                f"Downgrade refusé (db={current} > code={SCHEMA_VERSION})",
                code="downgrade_refused",
                status=500,
            )
        if current < SCHEMA_VERSION:
            if readonly:
                raise HouseholdStoreError(
                    "Migration requise — ouverture lecture seule refusée",
                    code="migrate_required",
                    status=503,
                )
            # Backup before migrating an existing DB
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
        # Heal / reconcile mirror — SQLite wins
        meta = None
        try:
            meta = _read_meta(meta_path(root))
        except HouseholdStoreError:
            meta = None
        if meta is None or int(meta.get("schema_version") or -1) != current:
            try:
                _write_meta(meta_path(root), schema_version=current)
            except HouseholdStoreError:
                # DB is valid; allow open if mirror temporarily unwritable after heal attempt
                pass
        if not readonly:
            _secure_sqlite_sidecars(base)
        return HouseholdStore(root, conn, schema_version=current)
    except Exception:
        conn.close()
        if existed and before is not None and not _db_bytes_unchanged(path, before):
            # Should not happen on fail-closed paths; leave diagnostics
            pass
        raise


# ---------------------------------------------------------------- backup / restore

def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def backup(
    root: Path | str,
    *,
    label: str = "manual",
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Coherent SQLite snapshot via Connection.backup() into private backups/."""
    base = confined_household_dir(root)
    bdir = base / BACKUPS_DIR
    if not bdir.is_dir():
        prepare_household_dirs(root)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_label = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in label)[:40] or "snap"
    snap_name = f"household-{safe_label}-{stamp}.sqlite"
    dest = bdir / snap_name
    own = False
    src = conn
    if src is None:
        if not (base / DB_NAME).is_file():
            raise HouseholdStoreError("Rien à sauvegarder", code="not_found", status=404)
        src = _connect(base / DB_NAME, readonly=False)
        own = True
    try:
        # Ensure destination does not follow a link
        if dest.exists() or _is_link(dest):
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
        man_path = dest.with_suffix(dest.suffix + ".manifest.json")
        man_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        _secure_path(dest, directory=False)
        _secure_path(man_path, directory=False)
        return manifest
    except HouseholdStoreError:
        raise
    except (OSError, sqlite3.Error) as exc:
        if dest.exists():
            try:
                dest.unlink()
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
    """Restore a verified snapshot into an isolated ROOT (never the live prod root auto)."""
    snap = Path(snapshot)
    if not snap.is_file() or _is_link(snap):
        raise HouseholdStoreError("Snapshot introuvable", code="not_found", status=404)
    check = sqlite3.connect(str(snap))
    try:
        if integrity_check(check) != "ok":
            raise HouseholdStoreError("Snapshot corrompu", code="corrupt")
        ver = get_schema_version(check)
    finally:
        check.close()
    man = snap.with_suffix(snap.suffix + ".manifest.json")
    if man.is_file():
        meta = json.loads(man.read_text(encoding="utf-8"))
        if meta.get("sha256") and meta["sha256"] != _sha256_file(snap):
            raise HouseholdStoreError("Checksum snapshot invalide", code="corrupt")
        if int(meta.get("schema_version", ver)) != ver:
            raise HouseholdStoreError("Manifeste / snapshot incohérents", code="corrupt")
    dest = Path(os.path.abspath(os.fspath(dest_root)))
    if dest.exists() and any(dest.iterdir()):
        # Only allow empty or missing household
        hh = dest / DIR_NAME
        if hh.exists():
            raise HouseholdStoreError(
                "ROOT temporaire déjà peuplé — restauration refusée",
                code="restore_error",
            )
    prepare_household_dirs(dest)
    target = db_path(dest)
    if target.exists():
        raise HouseholdStoreError("Cible DB existe déjà", code="restore_error")
    # Copy via backup API from snapshot into new file
    src = sqlite3.connect(str(snap))
    try:
        dst = sqlite3.connect(str(target))
        try:
            _sqlite_backup(src, dst)
            dst.commit()
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
