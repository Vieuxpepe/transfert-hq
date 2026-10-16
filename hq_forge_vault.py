"""Encrypted Forge Studio private vault.

The HQ PIN is not the vault secret. A separate passphrase wraps a random
master key with Argon2id and AES-256-GCM. Each image uses its own data key.
Unlock state is kept in process memory, one entry per HQ session token.
"""

from __future__ import annotations

import base64
import hmac
import io
import json
import os
import re
import stat
import struct
import subprocess
import threading
import time
import unicodedata
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id

import hq_forge_gallery as gallery

MAGIC = b"HQFV1"
ID_RE = re.compile(r"^pvt-[0-9a-f]{24}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
QUOTA_BYTES = 2 * 1024 * 1024 * 1024
QUOTA_IMAGES = 400
UNLOCK_TTL_SEC = 300.0
FAILS_BEFORE_THROTTLE = 5
THROTTLE_SEC = 60.0
KDF_MEMORY = 19456
KDF_TIME = 2
KDF_LANES = 1
KDF_LENGTH = 32
PAGE_MAX = 48
IMPORT_MAX = 8 * 1024 * 1024
BACKUP_MAX = 64 * 1024 * 1024
MAX_ZIP_ENTRIES = QUOTA_IMAGES + 2
MAX_ZIP_MEMBER = 32 * 1024 * 1024
MAX_ZIP_UNCOMPRESSED = BACKUP_MAX * 2
MAX_ZIP_RATIO = 64
MAX_INDEX_BYTES = 256 * 1024
MAX_FAILURE_SLOTS = 32
_REPARSE = 0x400

_LOCK = threading.Lock()
_FAIL_LOCK = threading.Lock()
_sessions: dict[str, dict] = {}
_failures: dict[str, tuple[int, float]] = {}
_global_fails = 0
_global_until = 0.0
_inflight = 0
_session_alive = None
_write_fault = None
_restore_fault = None
_test_dir: Path | None = None
_disk = True
_ttl = UNLOCK_TTL_SEC
_quota_bytes = QUOTA_BYTES
_quota_images = QUOTA_IMAGES
_apply_acl = True
_private_generation = False

_AAD_PASS = b"hq-forge-vault-v1-passphrase"
_AAD_RECOVERY = b"hq-forge-vault-v1-recovery"
_AAD_INDEX = b"hq-forge-vault-v1-index"


class VaultError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def reset_for_tests() -> None:
    global _test_dir, _ttl, _quota_bytes, _quota_images, _apply_acl, _private_generation, _disk
    global _global_fails, _global_until, _inflight, _write_fault, _restore_fault
    _disk = False
    _global_fails = 0
    _global_until = 0.0
    _inflight = 0
    _write_fault = None
    _restore_fault = None
    with _LOCK:
        for entry in _sessions.values():
            _wipe(entry.get("key"))
        _sessions.clear()
    with _FAIL_LOCK:
        _failures.clear()
    _test_dir = None
    _ttl = UNLOCK_TTL_SEC
    _quota_bytes = QUOTA_BYTES
    _quota_images = QUOTA_IMAGES
    _apply_acl = True
    _private_generation = False


def set_root_for_tests(path: Path | None) -> None:
    global _test_dir, _disk
    _disk = path is not None
    _test_dir = None if path is None else Path(path)


def set_ttl_for_tests(seconds: float | None) -> None:
    global _ttl
    _ttl = UNLOCK_TTL_SEC if seconds is None else float(seconds)


def set_quota_for_tests(byte_cap: int | None = None, image_cap: int | None = None) -> None:
    global _quota_bytes, _quota_images
    _quota_bytes = QUOTA_BYTES if byte_cap is None else int(byte_cap)
    _quota_images = QUOTA_IMAGES if image_cap is None else int(image_cap)


def set_acl_for_tests(enabled: bool) -> None:
    global _apply_acl
    _apply_acl = bool(enabled)


def set_write_fault_for_tests(kind: str | None) -> None:
    """'fsync' or 'replace'. The next encrypted write raises before that step."""
    global _write_fault
    _write_fault = kind


def set_restore_fault_for_tests(kind: str | None) -> None:
    """'before_retire', 'after_retire', or 'after_promote'."""
    global _restore_fault
    _restore_fault = kind


def bind_session_checker(fn) -> None:
    """HQ installs session_valid. Unit tests leave this unset."""
    global _session_alive
    _session_alive = fn


def failure_slots_for_tests() -> int:
    with _FAIL_LOCK:
        return len(_failures)


def retain_only(live: set[str]) -> None:
    """Drop unlock keys whose HQ session is gone."""
    with _LOCK:
        stale = [token for token in _sessions if token not in live]
        removed = [_sessions.pop(token) for token in stale]
    for entry in removed:
        _wipe(entry.get("key"))


def set_private_generation_for_tests(enabled: bool) -> None:
    """Tests may exercise the pipeline. Production stays disabled."""
    global _private_generation
    _private_generation = bool(enabled)


def private_generation_enabled() -> bool:
    return _private_generation


def _wipe(buf) -> None:
    if isinstance(buf, bytearray):
        for index in range(len(buf)):
            buf[index] = 0


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _unb64(value, size: int | None = None) -> bytes:
    if not isinstance(value, str):
        raise VaultError("corrupt")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise VaultError("corrupt") from None
    if size is not None and len(raw) != size:
        raise VaultError("corrupt")
    return raw


def _kdf_params(salt: bytes) -> dict:
    return {
        "name": "argon2id",
        "salt": _b64(salt),
        "length": KDF_LENGTH,
        "iterations": KDF_TIME,
        "lanes": KDF_LANES,
        "memory_cost": KDF_MEMORY,
    }


def _derive(params: dict, secret: bytes) -> bytes:
    if not isinstance(params, dict) or params.get("name") != "argon2id":
        raise VaultError("corrupt")
    salt = _unb64(params.get("salt"), 16)
    if int(params.get("iterations") or 0) != KDF_TIME or int(params.get("lanes") or 0) != KDF_LANES:
        raise VaultError("corrupt")
    if int(params.get("memory_cost") or 0) != KDF_MEMORY or int(params.get("length") or 0) != KDF_LENGTH:
        raise VaultError("corrupt")
    try:
        return Argon2id(
            salt=salt,
            length=KDF_LENGTH,
            iterations=int(params.get("iterations") or 0),
            lanes=int(params.get("lanes") or 0),
            memory_cost=int(params.get("memory_cost") or 0),
        ).derive(secret)
    except Exception:
        raise VaultError("corrupt") from None


def _seal(key: bytes, plaintext: bytes, aad: bytes) -> bytes:
    nonce = os.urandom(12)
    return nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def _open(key: bytes, blob: bytes, aad: bytes) -> bytes:
    if not isinstance(blob, (bytes, bytearray)) or len(blob) < 12 + 16:
        raise VaultError("corrupt")
    try:
        return AESGCM(bytes(key)).decrypt(bytes(blob[:12]), bytes(blob[12:]), aad)
    except Exception:
        raise VaultError("corrupt") from None


def _passphrase_bytes(value: str) -> bytes:
    return unicodedata.normalize("NFKC", value).encode("utf-8")


def passphrase_acceptable(value) -> bool:
    if not isinstance(value, str) or len(value) > 128:
        return False
    text = unicodedata.normalize("NFKC", value).strip()
    if len(text) < 12 or len(text) > 128:
        return False
    if any(ord(ch) < 32 for ch in text):
        return False
    if text.isdigit():
        return False
    return True


def _recovery_text(raw: bytes) -> str:
    text = base64.b32encode(raw).decode("ascii").rstrip("=").lower()
    return " ".join(text[index:index + 4] for index in range(0, len(text), 4))


def _recovery_bytes(value) -> bytes | None:
    if not isinstance(value, str):
        return None
    compact = "".join(value.split()).upper()
    pad = "=" * ((8 - len(compact) % 8) % 8)
    try:
        raw = base64.b32decode(compact + pad, casefold=True)
    except (ValueError, TypeError):
        return None
    if len(raw) != 32:
        return None
    return raw


def _default_dir() -> Path:
    if not _disk:
        raise VaultError("missing")
    if _test_dir is not None:
        return _test_dir
    override = os.environ.get("HQ_FORGE_VAULT_DIR")
    if override:
        path = Path(override)
        if not path.is_absolute():
            raise VaultError("bad_root")
        return path
    local = os.environ.get("LOCALAPPDATA")
    base = Path(local) if local else Path.home() / "AppData" / "Local"
    return base / "TransfertHQ" / "forge-vault"


def _outside_hq(path: Path, hq_root: Path) -> None:
    try:
        path.resolve().relative_to(Path(hq_root).resolve())
    except ValueError:
        return
    raise VaultError("bad_root")


def _is_reparse(path: Path) -> bool:
    try:
        info = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    attrs = getattr(info, "st_file_attributes", 0) or 0
    if attrs & _REPARSE:
        return True
    if os.name == "nt":
        extra = ctypes_attributes(str(path))
        if extra is not None and extra & _REPARSE:
            return True
    return False


def _refuse_reparse_chain(path: Path) -> None:
    current = path
    for _ in range(80):
        if _is_reparse(current):
            raise VaultError("bad_root")
        parent = current.parent
        if parent == current:
            return
        current = parent


def ctypes_attributes(path: str):
    import ctypes
    value = ctypes.windll.kernel32.GetFileAttributesW(path)
    if value == 0xFFFFFFFF:
        return None
    return value


def _root(hq_root: Path, *, create: bool = False) -> Path:
    path = _default_dir()
    anchor = path if path.exists() else path.parent
    _refuse_reparse_chain(anchor)
    _outside_hq(path, hq_root)
    if path.exists() and _is_reparse(path):
        raise VaultError("bad_root")
    if create:
        parent = path.parent
        if not parent.exists():
            parent.mkdir(parents=True)
        _refuse_reparse_chain(parent)
        if not path.exists():
            path.mkdir()
        if _is_reparse(path):
            raise VaultError("bad_root")
    return path


def _header_path(root: Path) -> Path:
    return root / "vault.json"


def _read_header(root: Path) -> dict | None:
    path = _header_path(root)
    if not path.is_file() or _is_reparse(path):
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise VaultError("corrupt") from None
    if not isinstance(data, dict) or data.get("version") != 1:
        raise VaultError("corrupt")
    return data


def _write_header(root: Path, data: dict) -> None:
    _atomic(root / "vault.json", json.dumps(data, separators=(",", ":")).encode("utf-8"))


def _atomic(path: Path, payload: bytes) -> None:
    if _is_reparse(path.parent) or (path.exists() and _is_reparse(path)):
        raise VaultError("bad_root")
    temporary = path.with_suffix(path.suffix + ".partial")
    if temporary.exists() and _is_reparse(temporary):
        raise VaultError("bad_root")
    try:
        with temporary.open("wb") as handle:
            handle.write(payload)
            handle.flush()
            if _write_fault == "fsync":
                raise OSError("injected")
            os.fsync(handle.fileno())
        if _write_fault == "replace":
            raise OSError("injected")
        os.replace(temporary, path)
    except OSError as exc:
        if temporary.exists() and not _is_reparse(temporary):
            temporary.unlink(missing_ok=True)
        winerror = getattr(exc, "winerror", None)
        if getattr(exc, "errno", None) in (28, 112) or winerror == 112 or str(exc) == "injected":
            raise VaultError("disk") from None
        raise VaultError("disk") from None


def _delete_partials(folder: Path) -> None:
    if _is_reparse(folder):
        raise VaultError("bad_root")
    for child in list(folder.iterdir()):
        if _is_reparse(child) or not child.is_file():
            continue
        if child.name.endswith(".partial"):
            child.unlink()


def _remove_tree_nofollow(path: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if _is_reparse(path):
        raise VaultError("bad_root")
    if not path.is_dir():
        path.unlink()
        return
    for child in list(path.iterdir()):
        if _is_reparse(child):
            raise VaultError("bad_root")
        if child.is_dir():
            _remove_tree_nofollow(child)
        else:
            child.unlink()
    path.rmdir()


def cleanup_partials(hq_root: Path) -> None:
    try:
        root = _root(hq_root)
    except VaultError:
        return
    if not root.is_dir() or _is_reparse(root):
        return
    try:
        _delete_partials(root)
        objects = root / "objects"
        if objects.is_dir() and not _is_reparse(objects):
            _delete_partials(objects)
        staging = root.with_name(root.name + ".restore")
        if staging.exists() or staging.is_symlink():
            _remove_tree_nofollow(staging)
        previous = root.with_name(root.name + ".previous")
        if _header_path(root).is_file() and (previous.exists() or previous.is_symlink()):
            _remove_tree_nofollow(previous)
    except VaultError:
        return


def _restrict(path: Path) -> str:
    if not _apply_acl or os.name != "nt":
        return "skipped"
    user = os.environ.get("USERNAME") or ""
    if not user or any(ch in user for ch in '\\"/&|<>'):
        return "unverified"
    try:
        result = subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", user + ":(OI)(CI)F"],
            capture_output=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unverified"
    return "restricted" if result.returncode == 0 else "unverified"


def _token(token: str | None) -> str:
    if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
        raise VaultError("locked")
    return token


def _sweep_failures_locked(now: float) -> None:
    stale = [token for token, (_count, until) in _failures.items() if until and until <= now]
    for token in stale:
        _failures.pop(token, None)
    overflow = len(_failures) - MAX_FAILURE_SLOTS
    if overflow > 0:
        ordered = sorted(_failures, key=lambda token: _failures[token][1])
        for token in ordered[:overflow]:
            _failures.pop(token, None)


def _record_failure_locked(token: str) -> None:
    global _global_fails, _global_until
    count, _until = _failures.get(token, (0, 0.0))
    count += 1
    until = time.monotonic() + THROTTLE_SEC if count >= FAILS_BEFORE_THROTTLE else 0.0
    _failures[token] = (count, until)
    _global_fails += 1
    if _global_fails >= FAILS_BEFORE_THROTTLE:
        _global_until = time.monotonic() + THROTTLE_SEC
    _sweep_failures_locked(time.monotonic())


def _expire_global_locked(now: float) -> None:
    global _global_fails, _global_until
    if _global_until and now >= _global_until:
        _global_fails = 0
        _global_until = 0.0


def _begin_attempt(token: str) -> None:
    global _inflight
    with _FAIL_LOCK:
        now = time.monotonic()
        _expire_global_locked(now)
        _sweep_failures_locked(now)
        if now < _global_until:
            raise VaultError("throttled")
        count, until = _failures.get(token, (0, 0.0))
        if count >= FAILS_BEFORE_THROTTLE and now < until:
            raise VaultError("throttled")
        if _global_fails + _inflight >= FAILS_BEFORE_THROTTLE:
            raise VaultError("throttled")
        _inflight += 1


def _finish_attempt(token: str, ok: bool, *, count_failure: bool = True) -> None:
    global _inflight, _global_fails, _global_until
    with _FAIL_LOCK:
        _inflight = max(0, _inflight - 1)
        if ok:
            _failures.pop(token, None)
            _global_fails = 0
            _global_until = 0.0
            return
        if count_failure:
            _record_failure_locked(token)


def _fail(token: str) -> None:
    with _FAIL_LOCK:
        _record_failure_locked(token)


def _install(token: str, master: bytes, epoch: int) -> None:
    with _LOCK:
        previous = _sessions.pop(token, None)
        if previous:
            _wipe(previous.get("key"))
        _sessions[token] = {
            "key": bytearray(master),
            "epoch": epoch,
            "expires": time.monotonic() + _ttl,
        }


def drop_session(token: str | None) -> None:
    """Forget the unlock key. Failure counts stay, so logout does not reset guessing."""
    if not isinstance(token, str):
        return
    with _LOCK:
        previous = _sessions.pop(token, None)
    if previous:
        _wipe(previous.get("key"))


def lock_all() -> None:
    with _LOCK:
        entries = list(_sessions.values())
        _sessions.clear()
    for entry in entries:
        _wipe(entry.get("key"))


def _require_live(token: str | None) -> str:
    key = _token(token)
    checker = _session_alive
    if checker is not None and not checker(key):
        drop_session(key)
        raise VaultError("locked")
    return key


def _master(hq_root: Path, token: str | None) -> tuple[Path, bytes, dict]:
    key_token = _require_live(token)
    root = _root(hq_root)
    header = _read_header(root)
    if header is None:
        raise VaultError("missing")
    with _LOCK:
        entry = _sessions.get(key_token)
        if entry is None or time.monotonic() >= float(entry["expires"]):
            if entry is not None:
                _wipe(entry.get("key"))
                _sessions.pop(key_token, None)
            raise VaultError("locked")
        if int(entry["epoch"]) != int(header.get("epoch") or 0):
            _wipe(entry.get("key"))
            _sessions.pop(key_token, None)
            raise VaultError("locked")
        entry["expires"] = time.monotonic() + _ttl
        return root, bytes(entry["key"]), header


def _unwrap(header: dict, secret: bytes, kind: str) -> bytes:
    if kind == "passphrase":
        params = header.get("kdf")
        wrapped = _unb64(header.get("passphrase_wrap"))
        aad = _AAD_PASS
    else:
        recovery = header.get("recovery")
        if not isinstance(recovery, dict):
            raise VaultError("corrupt")
        params = recovery.get("kdf")
        wrapped = _unb64(recovery.get("wrap"))
        aad = _AAD_RECOVERY
    kek = _derive(params, secret)
    try:
        return _open(kek, wrapped, aad)
    finally:
        _wipe(bytearray(kek))


def setup(hq_root: Path, passphrase: str, confirm: str) -> dict:
    if passphrase != confirm or not passphrase_acceptable(passphrase):
        raise VaultError("validation")
    root = _root(hq_root, create=True)
    if _read_header(root) is not None:
        raise VaultError("exists")
    master = os.urandom(32)
    recovery = os.urandom(32)
    pass_salt = os.urandom(16)
    recovery_salt = os.urandom(16)
    pass_params = _kdf_params(pass_salt)
    recovery_params = _kdf_params(recovery_salt)
    header = {
        "version": 1,
        "epoch": 1,
        "kdf": pass_params,
        "passphrase_wrap": _b64(_seal(_derive(pass_params, _passphrase_bytes(passphrase)), master, _AAD_PASS)),
        "recovery": {
            "kdf": recovery_params,
            "wrap": _b64(_seal(_derive(recovery_params, recovery), master, _AAD_RECOVERY)),
        },
        "acl": _restrict(root),
    }
    _write_header(root, header)
    (root / "objects").mkdir(exist_ok=True)
    _write_index(root, master, [])
    shown = _recovery_text(recovery)
    _wipe(bytearray(master))
    _wipe(bytearray(recovery))
    return {"configured": True, "recovery_key": shown, "acl": header["acl"]}


def _open_with_budget(token: str | None, opener):
    key_token = _require_live(token)
    _begin_attempt(key_token)
    ok = False
    count_failure = True
    try:
        master, epoch, extra = opener()
        ok = True
        return key_token, master, epoch, extra
    except VaultError as exc:
        count_failure = exc.code not in ("missing", "bad_root")
        if exc.code in ("corrupt", "passphrase"):
            raise VaultError("passphrase") from None
        raise
    finally:
        _finish_attempt(key_token, ok, count_failure=count_failure)


def unlock(hq_root: Path, token: str | None, passphrase: str) -> dict:
    def opener():
        header = _read_header(_root(hq_root))
        if header is None:
            raise VaultError("missing")
        secret = _passphrase_bytes(passphrase) if isinstance(passphrase, str) and len(passphrase) <= 128 else b""
        master = _unwrap(header, secret, "passphrase")
        return master, int(header.get("epoch") or 0), None

    _key, master, epoch, _extra = _open_with_budget(token, opener)
    _install(_key, master, epoch)
    _wipe(bytearray(master))
    return {"unlocked": True}


def unlock_with_recovery(hq_root: Path, token: str | None, recovery_key: str) -> dict:
    def opener():
        header = _read_header(_root(hq_root))
        if header is None:
            raise VaultError("missing")
        raw = _recovery_bytes(recovery_key)
        if raw is None:
            raise VaultError("passphrase")
        master = _unwrap(header, raw, "recovery")
        return master, int(header.get("epoch") or 0), None

    _key, master, epoch, _extra = _open_with_budget(token, opener)
    _install(_key, master, epoch)
    _wipe(bytearray(master))
    return {"unlocked": True, "recovery": True}


def lock(token: str | None) -> dict:
    drop_session(token)
    return {"unlocked": False}


def change_passphrase(hq_root: Path, token: str | None, current: str, new_value: str, confirm: str, *, recovery_key: str | None = None) -> dict:
    root, master, header = _master(hq_root, token)
    if new_value != confirm or not passphrase_acceptable(new_value):
        raise VaultError("validation")
    if recovery_key:
        raw = _recovery_bytes(recovery_key)
        if raw is None:
            raise VaultError("passphrase")
        check = _unwrap(header, raw, "recovery")
        if not hmac.compare_digest(check, bytes(master)):
            _wipe(bytearray(check))
            raise VaultError("passphrase")
        _wipe(bytearray(check))
    else:
        try:
            check = _unwrap(header, _passphrase_bytes(current or ""), "passphrase")
        except VaultError:
            _fail(_token(token))
            raise VaultError("passphrase") from None
        if not hmac.compare_digest(check, bytes(master)):
            _wipe(bytearray(check))
            _fail(_token(token))
            raise VaultError("passphrase")
        _wipe(bytearray(check))
    salt = os.urandom(16)
    params = _kdf_params(salt)
    header["kdf"] = params
    header["passphrase_wrap"] = _b64(_seal(_derive(params, _passphrase_bytes(new_value)), bytes(master), _AAD_PASS))
    header["epoch"] = int(header.get("epoch") or 1) + 1
    _write_header(root, header)
    lock_all()
    return {"changed": True, "unlocked": False, "recovery_key_unchanged": True}


def rotate_recovery(hq_root: Path, token: str | None, passphrase: str) -> dict:
    """Replace the recovery wrap. The previous recovery key stops working.

    Changing the passphrase does not call this and does not revoke the recovery key.
    """
    root, master, header = _master(hq_root, token)
    try:
        check = _unwrap(header, _passphrase_bytes(passphrase or ""), "passphrase")
    except VaultError:
        _fail(_token(token))
        raise VaultError("passphrase") from None
    if not hmac.compare_digest(check, bytes(master)):
        _wipe(bytearray(check))
        _fail(_token(token))
        raise VaultError("passphrase")
    _wipe(bytearray(check))
    recovery = os.urandom(32)
    params = _kdf_params(os.urandom(16))
    header["recovery"] = {
        "kdf": params,
        "wrap": _b64(_seal(_derive(params, recovery), bytes(master), _AAD_RECOVERY)),
    }
    header["epoch"] = int(header.get("epoch") or 1) + 1
    _write_header(root, header)
    shown = _recovery_text(recovery)
    _wipe(bytearray(recovery))
    lock_all()
    return {"rotated": True, "unlocked": False, "recovery_key": shown, "previous_recovery_key": "revoked"}


def status(hq_root: Path, token: str | None) -> dict:
    if not _disk and _test_dir is None:
        return {"configured": False, "unlocked": False, "private_generation": _private_generation, "acl": "skipped"}
    cleanup_partials(hq_root)
    try:
        root = _root(hq_root)
        header = _read_header(root) if root.is_dir() else None
    except VaultError as exc:
        return {"configured": False, "unlocked": False, "private_generation": _private_generation, "code": exc.code}
    unlocked = False
    if header is not None and isinstance(token, str) and TOKEN_RE.fullmatch(token):
        try:
            _master(hq_root, token)
            unlocked = True
        except VaultError:
            unlocked = False
    return {
        "configured": header is not None,
        "unlocked": unlocked,
        "private_generation": _private_generation,
        "acl": (header or {}).get("acl") or "unverified",
    }


def _objects(root: Path) -> Path:
    path = root / "objects"
    if _is_reparse(path):
        raise VaultError("bad_root")
    path.mkdir(exist_ok=True)
    return path


def _object_path(root: Path, image_id: str) -> Path:
    if not ID_RE.fullmatch(image_id):
        raise VaultError("bad_id")
    folder = _objects(root)
    path = folder / (image_id + ".bin")
    if path.name != image_id + ".bin" or ":" in path.name:
        raise VaultError("bad_id")
    if path.exists() and _is_reparse(path):
        raise VaultError("bad_id")
    resolved = path.resolve()
    if resolved.parent != folder.resolve():
        raise VaultError("bad_id")
    return path


def _read_index(root: Path, master: bytes) -> list:
    path = root / "index.bin"
    if not path.is_file():
        return []
    if _is_reparse(path):
        raise VaultError("corrupt")
    try:
        raw = _open(master, path.read_bytes(), _AAD_INDEX)
        data = json.loads(raw.decode("utf-8"))
    except (OSError, json.JSONDecodeError, VaultError):
        raise VaultError("corrupt") from None
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise VaultError("corrupt")
    return [item for item in items if isinstance(item, dict) and ID_RE.fullmatch(str(item.get("id") or ""))]


def _authenticate_restored_objects(root: Path, master: bytes) -> None:
    """Decrypt every indexed object before the live vault is replaced.

    Plaintext is discarded one image at a time. The index and each ciphertext
    stay within the zip and quota caps.
    """
    path = root / "index.bin"
    if not path.is_file() or _is_reparse(path):
        raise VaultError("corrupt")
    try:
        index_size = path.stat().st_size
    except OSError:
        raise VaultError("corrupt") from None
    if index_size > MAX_INDEX_BYTES or index_size > MAX_ZIP_MEMBER:
        raise VaultError("validation")
    try:
        raw = _open(master, path.read_bytes(), _AAD_INDEX)
        data = json.loads(raw.decode("utf-8"))
    except (OSError, json.JSONDecodeError, VaultError):
        raise VaultError("corrupt") from None
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list) or len(items) > _quota_images:
        raise VaultError("validation" if isinstance(items, list) else "corrupt")
    known: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise VaultError("corrupt")
        image_id = item.get("id")
        if not isinstance(image_id, str) or not ID_RE.fullmatch(image_id) or image_id in known:
            raise VaultError("corrupt")
        known.add(image_id)
    folder = root / "objects"
    if not folder.is_dir() or _is_reparse(folder):
        raise VaultError("corrupt")
    files: dict[str, Path] = {}
    total = 0
    for child in folder.iterdir():
        if _is_reparse(child) or not child.is_file() or not ID_RE.fullmatch(child.stem):
            raise VaultError("corrupt")
        if child.stem in files:
            raise VaultError("corrupt")
        try:
            size = child.stat().st_size
        except OSError:
            raise VaultError("corrupt") from None
        if size > MAX_ZIP_MEMBER:
            raise VaultError("validation")
        total += size
        if total > _quota_bytes or total > MAX_ZIP_UNCOMPRESSED:
            raise VaultError("validation")
        files[child.stem] = child
    if set(files) != known or len(files) > _quota_images:
        raise VaultError("corrupt" if set(files) != known else "validation")
    for item in items:
        image_id = str(item.get("id"))
        try:
            meta, png, thumb = _read_object(root, master, image_id)
        except VaultError:
            raise VaultError("corrupt") from None
        try:
            if meta.get("id") != image_id:
                raise VaultError("corrupt")
            declared = item.get("bytes")
            if isinstance(declared, bool) or (declared is not None and not isinstance(declared, int)):
                raise VaultError("corrupt")
            if isinstance(declared, int) and declared != len(png):
                raise VaultError("corrupt")
            meta_bytes = meta.get("bytes")
            if isinstance(meta_bytes, int) and not isinstance(meta_bytes, bool) and meta_bytes != len(png):
                raise VaultError("corrupt")
            if len(png) > IMPORT_MAX or len(thumb) > IMPORT_MAX:
                raise VaultError("validation")
        finally:
            del png, thumb, meta


def _write_index(root: Path, master: bytes, items: list) -> None:
    payload = json.dumps({"items": items}, separators=(",", ":")).encode("utf-8")
    _atomic(root / "index.bin", _seal(bytes(master), payload, _AAD_INDEX))


def _usage(root: Path) -> tuple[int, int]:
    folder = root / "objects"
    if not folder.is_dir() or folder.is_symlink():
        return 0, 0
    count = 0
    total = 0
    for child in folder.iterdir():
        if child.is_symlink() or not child.is_file() or not child.name.endswith(".bin"):
            continue
        count += 1
        try:
            total += child.stat().st_size
        except OSError:
            continue
    return count, total


def _pack(png: bytes, thumb: bytes, meta: dict) -> bytes:
    encoded = json.dumps(meta, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return b"".join((
        struct.pack(">I", len(encoded)), encoded,
        struct.pack(">I", len(png)), png,
        struct.pack(">I", len(thumb)), thumb,
    ))


def _unpack(blob: bytes) -> tuple[dict, bytes, bytes]:
    def take(buf: bytes) -> tuple[bytes, bytes]:
        if len(buf) < 4:
            raise VaultError("corrupt")
        size = struct.unpack(">I", buf[:4])[0]
        if size > IMPORT_MAX or 4 + size > len(buf):
            raise VaultError("corrupt")
        return buf[4:4 + size], buf[4 + size:]
    try:
        meta_raw, rest = take(blob)
        png, rest = take(rest)
        thumb, rest = take(rest)
        meta = json.loads(meta_raw.decode("utf-8"))
    except (VaultError, UnicodeError, json.JSONDecodeError, struct.error):
        raise VaultError("corrupt") from None
    if rest or not isinstance(meta, dict):
        raise VaultError("corrupt")
    return meta, png, thumb


def _write_object(root: Path, master: bytes, image_id: str, png: bytes, thumb: bytes, meta: dict) -> None:
    dek = os.urandom(32)
    wrapped = _seal(bytes(master), dek, b"hq-forge-vault-v1-dek:" + image_id.encode("ascii"))
    payload = _seal(dek, _pack(png, thumb, meta), b"hq-forge-vault-v1-object:" + image_id.encode("ascii"))
    _wipe(bytearray(dek))
    frame = MAGIC + struct.pack(">H", len(wrapped)) + wrapped + payload
    _atomic(_object_path(root, image_id), frame)


def _read_object(root: Path, master: bytes, image_id: str) -> tuple[dict, bytes, bytes]:
    path = _object_path(root, image_id)
    if not path.is_file():
        raise VaultError("bad_id")
    blob = path.read_bytes()
    if not blob.startswith(MAGIC) or len(blob) < len(MAGIC) + 2:
        raise VaultError("corrupt")
    size = struct.unpack(">H", blob[len(MAGIC):len(MAGIC) + 2])[0]
    start = len(MAGIC) + 2
    if size < 28 or start + size >= len(blob):
        raise VaultError("corrupt")
    wrapped = blob[start:start + size]
    payload = blob[start + size:]
    dek = _open(master, wrapped, b"hq-forge-vault-v1-dek:" + image_id.encode("ascii"))
    try:
        plain = _open(dek, payload, b"hq-forge-vault-v1-object:" + image_id.encode("ascii"))
    finally:
        _wipe(bytearray(dek))
    return _unpack(plain)


def store_image(hq_root: Path, token: str | None, raw: bytes, settings: dict) -> dict:
    if not isinstance(raw, (bytes, bytearray)) or len(raw) > IMPORT_MAX:
        raise VaultError("bad_image")
    try:
        png, thumb, width, height = gallery.prepare_image(bytes(raw))
    except gallery.GalleryError as exc:
        raise VaultError(exc.code if exc.code in ("bad_image", "no_pillow") else "bad_image") from None
    if settings:
        try:
            safe = gallery._settings(settings)
        except gallery.GalleryError:
            raise VaultError("validation") from None
    else:
        safe = {
            "prompt": "",
            "negative_prompt": "",
            "checkpoint": "",
            "sampler_name": "",
            "scheduler": "",
            "width": width,
            "height": height,
            "steps": 0,
            "n_iter": 1,
            "batch_size": 1,
            "seed": -1,
            "cfg_scale": 0.0,
            "source": "import",
        }
    root, master, _header = _master(hq_root, token)
    with _LOCK:
        count, used = _usage(root)
        incoming = len(png) + len(thumb) + 1024
        if count >= _quota_images or used + incoming > _quota_bytes:
            raise VaultError("quota")
        image_id = "pvt-" + os.urandom(12).hex()
        meta = {
            "id": image_id,
            "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "width": width,
            "height": height,
            "bytes": len(png),
            "settings": safe,
        }
        try:
            _write_object(root, master, image_id, png, thumb, meta)
            items = _read_index(root, master)
            items.append({"id": image_id, "created": meta["created"], "width": width, "height": height, "bytes": len(png)})
            _write_index(root, master, items)
        except Exception:
            path = root / "objects" / (image_id + ".bin")
            path.unlink(missing_ok=True)
            raise
    return {"id": image_id, "width": width, "height": height}


def page(hq_root: Path, token: str | None, *, limit: int = 24, cursor: str | None = None) -> dict:
    root, master, _header = _master(hq_root, token)
    limit = 24 if not isinstance(limit, int) else max(1, min(PAGE_MAX, limit))
    items = _read_index(root, master)
    items.sort(key=lambda item: (str(item.get("created") or ""), item.get("id") or ""), reverse=True)
    if cursor:
        if not ID_RE.fullmatch(cursor):
            raise VaultError("bad_id")
        ids = [item.get("id") for item in items]
        if cursor in ids:
            items = items[ids.index(cursor) + 1:]
    chosen = items[:limit]
    public = [{
        "id": item["id"],
        "created": item.get("created"),
        "width": item.get("width"),
        "height": item.get("height"),
    } for item in chosen]
    next_cursor = public[-1]["id"] if len(items) > limit and public else None
    return {"images": public, "next_cursor": next_cursor}


def detail(hq_root: Path, token: str | None, image_id: str) -> dict:
    root, master, _header = _master(hq_root, token)
    meta, _png, _thumb = _read_object(root, master, image_id)
    return {
        "id": image_id,
        "created": meta.get("created"),
        "width": meta.get("width"),
        "height": meta.get("height"),
        "settings": meta.get("settings") if isinstance(meta.get("settings"), dict) else {},
    }


def file_bytes(hq_root: Path, token: str | None, image_id: str, kind: str) -> tuple[bytes, str, str]:
    root, master, _header = _master(hq_root, token)
    _meta, png, thumb = _read_object(root, master, image_id)
    if kind == "original":
        return png, "image/png", 'attachment; filename="coffre.png"'
    if kind == "thumb":
        return thumb, "image/jpeg", 'inline; filename="coffre.jpg"'
    raise VaultError("bad_id")


def delete(hq_root: Path, token: str | None, image_id: str) -> dict:
    root, master, _header = _master(hq_root, token)
    path = _object_path(root, image_id)
    if not path.is_file():
        raise VaultError("bad_id")
    path.unlink()
    items = [item for item in _read_index(root, master) if item.get("id") != image_id]
    _write_index(root, master, items)
    return {"deleted": True}


def backup_bytes(hq_root: Path, token: str | None) -> bytes:
    root, _master_key, _header = _master(hq_root, token)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in ("vault.json", "index.bin"):
            path = root / name
            if path.is_file() and not _is_reparse(path):
                archive.write(path, name)
        folder = root / "objects"
        if folder.is_dir() and not _is_reparse(folder):
            for child in sorted(folder.iterdir()):
                if child.is_file() and not _is_reparse(child) and ID_RE.fullmatch(child.stem):
                    archive.write(child, "objects/" + child.name)
    return buffer.getvalue()


def _zip_member_ok(name: str) -> bool:
    if not name or "\x00" in name or ":" in name:
        return False
    clean = name.replace("\\", "/")
    if clean.startswith("/") or clean.endswith("/") or "//" in clean:
        return False
    parts = clean.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return False
    if clean in ("vault.json", "index.bin"):
        return True
    return (
        len(parts) == 2
        and parts[0] == "objects"
        and parts[1].endswith(".bin")
        and ID_RE.fullmatch(parts[1][:-4]) is not None
    )


def _extract_backup(payload: bytes, staging: Path) -> None:
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except (zipfile.BadZipFile, ValueError, OSError):
        raise VaultError("corrupt") from None
    with archive:
        infos = archive.infolist()
        if not infos or len(infos) > MAX_ZIP_ENTRIES:
            raise VaultError("validation")
        seen: set[str] = set()
        total = 0
        for info in infos:
            if info.is_dir() or not _zip_member_ok(info.filename):
                raise VaultError("validation")
            clean = info.filename.replace("\\", "/")
            if clean in seen:
                raise VaultError("validation")
            seen.add(clean)
            size = int(info.file_size)
            if size < 0 or size > MAX_ZIP_MEMBER:
                raise VaultError("validation")
            total += size
            if total > MAX_ZIP_UNCOMPRESSED:
                raise VaultError("validation")
            compressed = max(int(info.compress_size), 1)
            if size > 1024 * 1024 and size / compressed > MAX_ZIP_RATIO:
                raise VaultError("validation")
        if "vault.json" not in seen:
            raise VaultError("corrupt")
        (staging / "objects").mkdir()
        for info in infos:
            clean = info.filename.replace("\\", "/")
            target = staging / clean
            if _is_reparse(target.parent):
                raise VaultError("bad_root")
            remaining = int(info.file_size)
            try:
                source = archive.open(info, "r")
            except (zipfile.BadZipFile, RuntimeError, ValueError, OSError):
                raise VaultError("corrupt") from None
            with source, target.open("wb") as handle:
                while remaining:
                    chunk = source.read(min(65536, remaining))
                    if not chunk or len(chunk) > remaining:
                        raise VaultError("validation")
                    remaining -= len(chunk)
                    handle.write(chunk)
                if remaining:
                    raise VaultError("corrupt")
                handle.flush()
                os.fsync(handle.fileno())


def _rollback_restore(root: Path, staging: Path, previous: Path) -> None:
    if root.exists() or root.is_symlink():
        if staging.exists() or staging.is_symlink():
            _remove_tree_nofollow(staging)
        return
    if not previous.is_dir() or _is_reparse(previous):
        return
    if staging.exists() or staging.is_symlink():
        _remove_tree_nofollow(staging)
    os.replace(previous, root)


def restore_backup(hq_root: Path, token: str | None, payload: bytes, passphrase: str) -> dict:
    _require_live(token)
    if not isinstance(payload, (bytes, bytearray)) or not payload or len(payload) > BACKUP_MAX:
        raise VaultError("validation")
    if not passphrase_acceptable(passphrase):
        raise VaultError("passphrase")
    root = _root(hq_root, create=True)
    staging = root.with_name(root.name + ".restore")
    previous = root.with_name(root.name + ".previous")
    for sibling in (staging, previous):
        if sibling.exists() or sibling.is_symlink():
            if _is_reparse(sibling):
                raise VaultError("bad_root")
    if staging.exists() or staging.is_symlink():
        _remove_tree_nofollow(staging)
    staging.mkdir()
    promoted = False
    try:
        _extract_backup(bytes(payload), staging)
        header = _read_header(staging)
        if header is None:
            raise VaultError("corrupt")
        master = _unwrap(header, _passphrase_bytes(passphrase), "passphrase")
        try:
            _authenticate_restored_objects(staging, master)
        finally:
            _wipe(bytearray(master))
        if _restore_fault == "before_retire":
            raise OSError("injected")
        if _header_path(root).is_file():
            if previous.exists() or previous.is_symlink():
                _remove_tree_nofollow(previous)
            os.replace(root, previous)
        if _restore_fault == "after_retire":
            raise OSError("injected")
        os.replace(staging, root)
        promoted = True
        try:
            if _restore_fault == "after_promote":
                raise OSError("injected")
            if previous.exists() or previous.is_symlink():
                _remove_tree_nofollow(previous)
        except (OSError, VaultError):
            raise VaultError("cleanup") from None
    except VaultError:
        if not promoted:
            _rollback_restore(root, staging, previous)
        raise
    except (OSError, zipfile.BadZipFile, ValueError):
        if not promoted:
            _rollback_restore(root, staging, previous)
        raise VaultError("corrupt") from None
    lock_all()
    return {"restored": True, "unlocked": False}


def http_status(code: str) -> int:
    return {
        "locked": 401,
        "missing": 409,
        "exists": 409,
        "passphrase": 401,
        "throttled": 429,
        "corrupt": 409,
        "quota": 409,
        "disk": 409,
        "bad_image": 400,
        "bad_id": 404,
        "validation": 400,
        "no_pillow": 503,
        "bad_root": 503,
        "cleanup": 409,
    }.get(code, 400)


def public_error(code: str) -> str:
    return {
        "locked": "Le coffre privé est verrouillé.",
        "missing": "Le coffre privé n'est pas encore créé.",
        "exists": "Le coffre privé existe déjà.",
        "passphrase": "Phrase refusée.",
        "throttled": "Trop d'essais. Réessayez dans un moment.",
        "corrupt": "Le coffre n'a pas pu être lu.",
        "quota": "Le quota du coffre est atteint. Rien n'a été effacé.",
        "disk": "Espace disque insuffisant.",
        "bad_image": "Image inutilisable.",
        "bad_id": "Introuvable.",
        "validation": "Les données ne sont pas acceptées.",
        "no_pillow": "Le traitement d'image n'est pas disponible.",
        "bad_root": "Le dossier du coffre n'est pas utilisable.",
        "cleanup": "La sauvegarde est en place, mais l'ancienne copie n'a pas pu être retirée.",
        "disabled": "La génération privée reste désactivée tant que Forge n'a pas prouvé qu'il n'écrit pas de copie en clair.",
    }.get(code, "Le coffre a refusé l'opération.")
