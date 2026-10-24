"""Encrypted Forge Studio private vault.

The HQ PIN is not the vault secret. A separate passphrase wraps a random
master key with Argon2id and AES-256-GCM. Each image uses its own data key.
Unlock state is kept in process memory, one entry per HQ session token, bound to the one
vault it opened: opening another vault in the same session locks the first (multi-vault V2).
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
import hq_forge_vault_registry as registry

MAGIC = b"HQFV1"
ID_RE = re.compile(r"^pvt-[0-9a-f]{24}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
QUOTA_BYTES = 2 * 1024 * 1024 * 1024
QUOTA_IMAGES = 400
# Global limits for all vaults together, confirmed by Emie (docs/forge-multi-vault-V1-V3.md).
GLOBAL_QUOTA_BYTES = 8 * 1024 * 1024 * 1024  # 8 GiB across every vault
GLOBAL_QUOTA_IMAGES = 1600  # images across every vault
GLOBAL_MAX_VAULTS = registry.MAX_VAULTS  # 12 vaults; the registry enforces it
UNLOCK_TTL_SEC = 300.0
# Browser status may reuse one DACL reading for this long. An external permission
# change can remain unseen by that poll during the interval. A private job does
# not use the cache: it reads the DACL again before it is accepted.
ACL_OBSERVATION_SEC = 15.0
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
_REGISTRY_LOCK = threading.Lock()  # registry writes; never held while _LOCK is wanted by another path
_sessions: dict[str, dict] = {}
_failures: dict[str, tuple[int, float]] = {}
_global_fails = 0
_global_until = 0.0
_global_last = 0.0
_inflight = 0
# Fix 1: HQ session token -> monotonic time the server itself offered the single vault's backup
# (ZIP downloaded, or the offer explicitly acknowledged). Memory only; a client flag never counts.
_backup_offers: dict[str, float] = {}
BACKUP_OFFER_TTL_SEC = 900.0
_session_alive = None
_write_fault = None
_restore_fault = None
_test_dir: Path | None = None
_disk = True
_ttl = UNLOCK_TTL_SEC
_quota_bytes = QUOTA_BYTES
_quota_images = QUOTA_IMAGES
_global_bytes = GLOBAL_QUOTA_BYTES
_global_images = GLOBAL_QUOTA_IMAGES
_apply_acl = True
_private_generation = True

_AAD_PASS = b"hq-forge-vault-v1-passphrase"
_AAD_RECOVERY = b"hq-forge-vault-v1-recovery"
_AAD_INDEX = b"hq-forge-vault-v1-index"
_AAD_LABEL = b"hq-forge-vault-v1-label"
LABEL_FILE = "label.bin"


class VaultError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def reset_for_tests() -> None:
    global _test_dir, _ttl, _quota_bytes, _quota_images, _apply_acl, _private_generation, _disk, _global_bytes, _global_images
    global _global_fails, _global_until, _global_last, _inflight, _write_fault, _restore_fault, _user_sid_bytes, _migration_fault
    _migration_fault = None
    _disk = False
    _global_fails = 0
    _global_until = 0.0
    _global_last = 0.0
    _inflight = 0
    _write_fault = None
    _restore_fault = None
    with _LOCK:
        for entry in _sessions.values():
            _wipe(entry.get("key"))
        _sessions.clear()
    with _FAIL_LOCK:
        _failures.clear()
    _backup_offers.clear()
    _test_dir = None
    _ttl = UNLOCK_TTL_SEC
    _quota_bytes = QUOTA_BYTES
    _quota_images = QUOTA_IMAGES
    _global_bytes = GLOBAL_QUOTA_BYTES
    _global_images = GLOBAL_QUOTA_IMAGES
    _apply_acl = True
    _private_generation = True
    _user_sid_bytes = None
    with _acl_lock:
        _acl_cache.clear()


def set_root_for_tests(path: Path | None) -> None:
    global _test_dir, _disk
    _disk = path is not None
    _test_dir = None if path is None else Path(path)


def set_ttl_for_tests(seconds: float | None) -> None:
    global _ttl
    _ttl = UNLOCK_TTL_SEC if seconds is None else float(seconds)


def set_quota_for_tests(byte_cap: int | None = None, image_cap: int | None = None, *,
                        global_bytes: int | None = None, global_images: int | None = None) -> None:
    global _quota_bytes, _quota_images, _global_bytes, _global_images
    _quota_bytes = QUOTA_BYTES if byte_cap is None else int(byte_cap)
    _quota_images = QUOTA_IMAGES if image_cap is None else int(image_cap)
    _global_bytes = GLOBAL_QUOTA_BYTES if global_bytes is None else int(global_bytes)
    _global_images = GLOBAL_QUOTA_IMAGES if global_images is None else int(global_images)


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
    """Turn the build flag on or off. A Windows vault still has to be restricted to this account."""
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


def _base(hq_root: Path, *, create: bool = False) -> Path:
    """The forge-vault folder: a legacy single vault, or the multi-vault container."""
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


REGISTRY_NAME = "registry.json"
VAULTS_DIR = "vaults"


def _registry_path(base: Path) -> Path:
    return base / REGISTRY_NAME


def _layout(base: Path) -> str:
    """'multi' (registry present), 'legacy' (one vault.json at the top) or 'empty'.

    Both at once is never valid: nothing is opened until it is resolved."""
    reg = _registry_path(base)
    if reg.exists() or reg.is_symlink():
        if _header_path(base).exists():
            raise VaultError("registry")
        return "multi"
    if _header_path(base).is_file():
        return "legacy"
    return "empty"


def _load_registry(base: Path) -> dict:
    path = _registry_path(base)
    if not path.exists() and not path.is_symlink():
        return registry.empty()
    if _is_reparse(path) or not path.is_file():
        raise VaultError("registry")
    try:
        raw = path.read_bytes()
    except OSError:
        raise VaultError("registry") from None
    try:
        return registry.parse(raw)
    except registry.RegistryError:
        raise VaultError("registry") from None


def _save_registry(base: Path, data: dict) -> None:
    try:
        payload = registry.dump(data)
    except registry.RegistryError:
        raise VaultError("registry") from None
    _atomic(_registry_path(base), payload)


def _vault_dir(base: Path, vid: str, *, create: bool = False) -> Path:
    """vaults/<vid>/ under the container. The id is checked twice: by pattern and by name."""
    if not isinstance(vid, str) or not registry.VID_RE.fullmatch(vid):
        raise VaultError("bad_vault")
    folder = base / VAULTS_DIR
    if folder.exists() and _is_reparse(folder):
        raise VaultError("bad_root")
    path = folder / vid
    if path.name != vid or path.parent != folder:
        raise VaultError("bad_vault")
    if path.exists() and _is_reparse(path):
        raise VaultError("bad_root")
    if create:
        folder.mkdir(exist_ok=True)
        if _is_reparse(folder):
            raise VaultError("bad_root")
        path.mkdir()
        if _is_reparse(path):
            raise VaultError("bad_root")
    elif not path.is_dir():
        raise VaultError("missing")
    return path


def _resolve(hq_root: Path, vid: str | None, *, create: bool = False) -> tuple[Path, str]:
    """(folder, identity). identity is the vid, or 'legacy' for the single pre-migration vault.

    vid None is the old /api/forge/vault/* alias: the migrated vault, never 'the last used'."""
    if vid is not None and (not isinstance(vid, str) or not registry.VID_RE.fullmatch(vid)):
        raise VaultError("bad_vault")
    base = _base(hq_root, create=create and vid is None)
    if not base.is_dir():
        if vid is not None:
            raise VaultError("bad_vault")
        return base, "legacy"
    layout = _layout(base)
    if vid is None:
        if layout != "multi":
            return base, "legacy"
        alias = _load_registry(base)["legacy"]
        if alias is None:
            raise VaultError("use_vaults")
        return _checked_vault(base, alias, legacy_alias=alias), alias
    if layout != "multi":
        raise VaultError("bad_vault")
    data = _load_registry(base)
    if registry.find(data, vid) is None:
        raise VaultError("bad_vault")
    return _checked_vault(base, vid, legacy_alias=data["legacy"]), vid


def _checked_vault(base: Path, vid: str, *, legacy_alias: str | None) -> Path:
    path = _vault_dir(base, vid)
    header = _read_header(path)
    if isinstance(header, dict):
        bound = header.get("vid")
        # A vault created here names its own id in its header; only the migrated one may lack it.
        if bound != vid and not (bound is None and vid == legacy_alias):
            raise VaultError("registry")
    return path


def _root(hq_root: Path, *, create: bool = False, vid: str | None = None) -> Path:
    return _resolve(hq_root, vid, create=create)[0]


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
    """Leftover partial writes, in the top folder and in every listed vault. Also finishes a
    migration that was cut off (it never starts one)."""
    try:
        base = _base(hq_root)
    except VaultError:
        return
    try:
        resume_migration(hq_root)
    except (VaultError, OSError):
        pass  # left as it is; status reports it and nothing is opened
    if not base.is_dir() or _is_reparse(base):
        return
    _cleanup_folder(base)
    try:
        if _layout(base) != "multi":
            return
        _delete_partials(base)
        for entry in _load_registry(base)["vaults"]:
            try:
                _cleanup_folder(_vault_dir(base, entry["id"]))
            except VaultError:
                continue
    except VaultError:
        return


def _cleanup_folder(root: Path) -> None:
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
    # Directory ACEs must propagate. The same inherit-only flags on a file grant nothing to that file.
    grant = user + (":(OI)(CI)F" if path.is_dir() else ":(F)")
    try:
        result = subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", grant],
            capture_output=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unverified"
    return "restricted" if result.returncode == 0 else "unverified"


def _seal_acl(root: Path) -> str:
    """Remove inherited ACEs from the vault tree, including files a restore already created."""
    if not _apply_acl or os.name != "nt":
        return "skipped"
    paths = [root]
    objects = root / "objects"
    if objects.is_dir() and not _is_reparse(objects):
        paths.append(objects)
        paths.extend(child for child in objects.iterdir() if child.is_file() and not _is_reparse(child))
    paths.extend(child for child in root.iterdir() if child.is_file() and not _is_reparse(child))
    states = [_restrict(path) for path in paths]
    state = "restricted" if states and all(item == "restricted" for item in states) else "unverified"
    header = _read_header(root)
    if isinstance(header, dict) and header.get("acl") != state:
        header["acl"] = state
        _write_header(root, header)
    return state


def private_generation_ready(header) -> bool:
    if not _private_generation:
        return False
    if os.name != "nt" or not _apply_acl:
        return True
    return isinstance(header, dict) and header.get("acl") == "restricted"


_acl_lock = threading.Lock()
_acl_cache: dict[str, tuple[float, bool]] = {}
_user_sid_bytes: bytes | None = None
_FILE_ALL_ACCESS = 0x001F01FF
_INHERIT_ONLY_ACE = 0x08
_ACCESS_ALLOWED_ACE_TYPE = 0


def _status_private_generation(root: Path, header) -> bool:
    """Header gate plus a cached DACL reading. Polls skip the reading until ACL_OBSERVATION_SEC elapses."""
    if not private_generation_ready(header):
        return False
    if os.name != "nt" or not _apply_acl:
        return True
    return _acl_restricted(root, fresh=False)


def confirm_private_generation(hq_root: Path, *, vid: str | None = None) -> bool:
    """Read the live DACL before a private job is accepted. Status polls do not call this."""
    if not _private_generation:
        return False
    if os.name != "nt" or not _apply_acl:
        return True
    try:
        root = _root(hq_root, vid=vid)
        header = _read_header(root) if root.is_dir() else None
    except VaultError:
        return False
    if not private_generation_ready(header):
        return False
    return _acl_restricted(root, fresh=True)


def _acl_restricted(root: Path, *, fresh: bool) -> bool:
    try:
        key = os.path.normcase(str(root.resolve()))
    except OSError:
        return False
    now = time.monotonic()
    with _acl_lock:
        cached = _acl_cache.get(key)
        if not fresh and cached is not None and now - cached[0] < ACL_OBSERVATION_SEC:
            return cached[1]
        ok = _dacl_is_restricted(root)
        _acl_cache[key] = (now, ok)
        if len(_acl_cache) > 8:
            oldest = min(_acl_cache, key=lambda item: _acl_cache[item][0])
            _acl_cache.pop(oldest, None)
        return ok


def _current_user_sid() -> bytes | None:
    global _user_sid_bytes
    if _user_sid_bytes:
        return _user_sid_bytes
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    advapi.OpenProcessToken.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.OpenProcessToken.restype = wintypes.BOOL
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.GetTokenInformation.restype = wintypes.BOOL
    advapi.GetLengthSid.argtypes = [ctypes.c_void_p]
    advapi.GetLengthSid.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]

    class SidAndAttributes(ctypes.Structure):
        _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]

    class TokenUser(ctypes.Structure):
        _fields_ = [("User", SidAndAttributes)]

    token = wintypes.HANDLE()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
        return None
    try:
        needed = wintypes.DWORD(0)
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        if needed.value <= 0 or needed.value > 1024:
            return None
        buffer = ctypes.create_string_buffer(needed.value)
        if not advapi.GetTokenInformation(token, 1, buffer, needed, ctypes.byref(needed)):
            return None
        user = ctypes.cast(buffer, ctypes.POINTER(TokenUser)).contents
        length = advapi.GetLengthSid(user.User.Sid)
        if length <= 0 or length > 256:
            return None
        raw = ctypes.string_at(user.User.Sid, length)
    finally:
        kernel.CloseHandle(token)
    _user_sid_bytes = raw
    return raw


def _dacl_is_restricted(root: Path) -> bool:
    """True only when every vault object is owned by this user and grants only this user full control."""
    sid = _current_user_sid()
    paths = _acl_targets(root)
    if sid is None or paths is None:
        return False
    return all(_dacl_only_user(path, sid) for path in paths)


def _acl_targets(root: Path) -> list[Path] | None:
    objects = root / "objects"
    required = [root, objects, root / "vault.json", root / "index.bin"]
    for path in required:
        if _is_reparse(path):
            return None
        if path in (root, objects):
            if not path.is_dir():
                return None
        elif not path.is_file():
            return None
    try:
        children = list(objects.iterdir())
    except OSError:
        return None
    if len(children) > QUOTA_IMAGES:
        return None
    files: list[Path] = []
    for child in children:
        if _is_reparse(child) or not child.is_file() or child.suffix != ".bin" or not ID_RE.fullmatch(child.stem):
            return None
        files.append(child)
    return required + files


def _dacl_only_user(path: Path, sid: bytes) -> bool:
    import ctypes
    from ctypes import wintypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi.GetNamedSecurityInfoW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    advapi.GetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi.EqualSid.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    advapi.EqualSid.restype = wintypes.BOOL
    advapi.GetAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    advapi.GetAce.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]

    class Acl(ctypes.Structure):
        _fields_ = [
            ("AclRevision", ctypes.c_byte),
            ("Sbz1", ctypes.c_byte),
            ("AclSize", wintypes.WORD),
            ("AceCount", wintypes.WORD),
            ("Sbz2", wintypes.WORD),
        ]

    class AceHeader(ctypes.Structure):
        _fields_ = [("AceType", ctypes.c_byte), ("AceFlags", ctypes.c_byte), ("AceSize", wintypes.WORD)]

    class AllowAce(ctypes.Structure):
        _fields_ = [("Header", AceHeader), ("Mask", wintypes.DWORD), ("SidStart", wintypes.DWORD)]

    owner = ctypes.c_void_p()
    group = ctypes.c_void_p()
    dacl = ctypes.c_void_p()
    sacl = ctypes.c_void_p()
    descriptor = ctypes.c_void_p()
    try:
        status = advapi.GetNamedSecurityInfoW(
            str(path),
            1,
            0x00000001 | 0x00000004,
            ctypes.byref(owner),
            ctypes.byref(group),
            ctypes.byref(dacl),
            ctypes.byref(sacl),
            ctypes.byref(descriptor),
        )
        if status != 0 or not descriptor.value or not owner.value or not dacl.value:
            return False
        user = ctypes.create_string_buffer(sid)
        if not advapi.EqualSid(owner, user):
            return False
        acl = ctypes.cast(dacl, ctypes.POINTER(Acl)).contents
        if acl.AceCount != 1:
            return False
        ace = ctypes.c_void_p()
        if not advapi.GetAce(dacl, 0, ctypes.byref(ace)) or not ace.value:
            return False
        header = ctypes.cast(ace, ctypes.POINTER(AceHeader)).contents
        if header.AceType != _ACCESS_ALLOWED_ACE_TYPE or header.AceFlags & _INHERIT_ONLY_ACE:
            return False
        mask = ctypes.cast(ace, ctypes.POINTER(AllowAce)).contents.Mask
        if mask & _FILE_ALL_ACCESS != _FILE_ALL_ACCESS:
            return False
        return bool(advapi.EqualSid(ctypes.c_void_p(ace.value + 8), user))
    except (OSError, AttributeError, ValueError, OverflowError):
        return False
    finally:
        if descriptor.value:
            kernel.LocalFree(descriptor)


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
    global _global_fails, _global_until, _global_last
    count, _until = _failures.get(token, (0, 0.0))
    count += 1
    until = time.monotonic() + THROTTLE_SEC if count >= FAILS_BEFORE_THROTTLE else 0.0
    _failures[token] = (count, until)
    _global_fails += 1
    _global_last = time.monotonic()
    if _global_fails >= FAILS_BEFORE_THROTTLE:
        _global_until = time.monotonic() + THROTTLE_SEC
    _sweep_failures_locked(time.monotonic())


def _expire_global_locked(now: float) -> None:
    global _global_fails, _global_until
    if _global_until and now >= _global_until:
        _global_fails = 0
        _global_until = 0.0
    elif not _global_until and _global_fails and now - _global_last >= THROTTLE_SEC:
        _global_fails = 0  # a quiet minute forgets earlier typos


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
            # Only this (session, vault) slot is cleared. Knowing one vault's phrase must not
            # reset the global count that slows guessing on the others; it decays on its own.
            _failures.pop(token, None)
            return
        if count_failure:
            _record_failure_locked(token)


def _fail(token: str) -> None:
    with _FAIL_LOCK:
        _record_failure_locked(token)


def _install(token: str, master: bytes, epoch: int, vault: str = "legacy") -> None:
    """One unlock entry per HQ session, bound to the vault it opened ('legacy' or a vid).
    Installing replaces (and wipes) whatever this session had open: one vault at a time."""
    with _LOCK:
        previous = _sessions.pop(token, None)
        if previous:
            _wipe(previous.get("key"))
        _sessions[token] = {
            "key": bytearray(master),
            "epoch": epoch,
            "expires": time.monotonic() + _ttl,
            "vault": vault,
        }


def drop_session(token: str | None) -> None:
    """Forget the unlock key. Failure counts stay, so logout does not reset guessing."""
    if not isinstance(token, str):
        return
    with _LOCK:
        previous = _sessions.pop(token, None)
        _backup_offers.pop(token, None)
    if previous:
        _wipe(previous.get("key"))


def _close_vault(identity: str) -> None:
    """Fix 3: close every session that has this one vault open; other vaults stay open."""
    with _LOCK:
        tokens = [t for t, e in _sessions.items() if e.get("vault") == identity]
        entries = [_sessions.pop(t) for t in tokens]
    for entry in entries:
        _wipe(entry.get("key"))


def _record_backup_offer(token: str) -> None:
    with _LOCK:
        _backup_offers[token] = time.monotonic()


def _take_backup_offer(token: str) -> bool:
    with _LOCK:
        when = _backup_offers.pop(token, None)
    return when is not None and time.monotonic() - when <= BACKUP_OFFER_TTL_SEC


def acknowledge_backup_offer(hq_root: Path, token: str | None) -> dict:
    """Fix 1: the panel showed the backup offer and the owner explicitly declined or deferred it.
    Recorded server-side for this HQ session only; only meaningful while the layout is 'legacy'."""
    key = _require_live(token)
    if layout(hq_root) != "legacy":
        raise VaultError("validation")
    _record_backup_offer(key)
    return {"offered": True}


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


def _master(hq_root: Path, token: str | None, vid: str | None = None) -> tuple[Path, bytes, dict]:
    key_token = _require_live(token)
    root, identity = _resolve(hq_root, vid)
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
        if entry.get("vault") != identity:
            raise VaultError("locked")  # another vault is open in this session; its key never serves this one
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
    return _initialise(root, passphrase)


def _initialise(root: Path, passphrase: str, *, vid: str | None = None, discret_label: str | None = None) -> dict:
    """Fresh keys in an empty vault folder. Unchanged from the single-vault setup, plus the
    header naming its own vid and, for a Discret vault, its sealed name."""
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
        "acl": "unverified",
    }
    if vid is not None:
        header["vid"] = vid
    (root / "objects").mkdir(exist_ok=True)
    root_acl = _restrict(root)
    object_acl = _restrict(root / "objects")
    header["acl"] = "restricted" if root_acl == "restricted" and object_acl == "restricted" else "unverified"
    _write_header(root, header)
    _write_index(root, master, [])
    if discret_label is not None:
        _write_label(root, master, discret_label)
    shown = _recovery_text(recovery)
    _wipe(bytearray(master))
    _wipe(bytearray(recovery))
    return {"configured": True, "recovery_key": shown, "acl": header["acl"]}


def create_vault(hq_root: Path, token: str | None, passphrase: str, confirm: str, *, label=None,
                 glyph=registry.DEFAULT_GLYPH, colour=registry.DEFAULT_COLOUR, discret=False, order=None) -> dict:
    """A new vault with its own keys in vaults/<random vid>/. It is not opened.

    The registry is written last: a crash before that leaves an unlisted folder that opens nothing."""
    _require_live(token)
    if passphrase != confirm or not passphrase_acceptable(passphrase):
        raise VaultError("validation")
    name = registry.clean_label(label)
    if name is None:
        raise VaultError("validation")
    base = _base(hq_root, create=True)
    if _layout(base) == "legacy":
        raise VaultError("migration")
    with _REGISTRY_LOCK:
        data = _load_registry(base)
        if len(data["vaults"]) >= registry.MAX_VAULTS:
            raise VaultError("too_many")
        if order is None:
            order = 1 + max((entry["order"] for entry in data["vaults"]), default=-1)
        vid = registry.new_vid()
        while registry.find(data, vid) is not None or (base / VAULTS_DIR / vid).exists():
            vid = registry.new_vid()
        try:
            entry = registry.make_entry(vid, label=name, glyph=glyph, colour=colour, discret=discret, order=order)
        except ValueError:
            raise VaultError("validation") from None
        folder = _vault_dir(base, vid, create=True)
        try:
            result = _initialise(folder, passphrase, vid=vid, discret_label=name if discret else None)
            data["vaults"].append(entry)
            _save_registry(base, data)
        except Exception:
            _remove_tree_nofollow(folder)
            raise
        for path in (base, base / VAULTS_DIR):
            _restrict(path)
    return {"vault": _public_entry(entry, len(data["vaults"])), "recovery_key": result["recovery_key"], "acl": result["acl"]}


def _public_entry(entry: dict, number: int, label: str | None = None) -> dict:
    """What the list may show. A Discret vault shows its number, and its name only while this session has it open."""
    return {
        "id": entry["id"],
        "label": entry["label"] if not entry["discret"] else label,
        "number": number,
        "glyph": entry["glyph"],
        "colour": entry["colour"],
        "discret": entry["discret"],
        "order": entry["order"],
        "created": entry["created"],
        "last_used_day": entry["last_used_day"],
    }


def _slot(token: str, vault: str) -> str:
    """Failure counts are kept per (session, vault); the global count covers every vault."""
    return token + "|" + vault


def list_vaults(hq_root: Path, token: str | None) -> dict:
    """Read-only list, only what the registry allows: glyph, colour, number, order, days, and the
    name unless Discret. A Discret name shows only while this session has that vault open."""
    _require_live(token)
    state = layout(hq_root)
    if state == "unreadable":
        raise VaultError("registry")
    if state != "multi":
        # 'legacy': the panel offers the migration (after a ZIP backup); 'migrating': it resumes at the next start.
        return {"layout": state, "vaults": [], "max": registry.MAX_VAULTS, "open": None}
    base = _base(hq_root)
    data = _load_registry(base)  # VaultError("registry") on any oddity: no partial list
    entries = sorted(data["vaults"], key=lambda e: (e["order"], e["created"], e["id"]))
    opened = None
    with _LOCK:
        entry = _sessions.get(token)
        if entry is not None and time.monotonic() < float(entry["expires"]):
            opened = entry.get("vault")
    rows = []
    for number, item in enumerate(entries, start=1):
        label = None
        if item["discret"] and opened == item["id"]:
            try:
                root, master, _header = _master(hq_root, token, item["id"])
                label = _read_label(root, master)
            except VaultError:
                label = None
        rows.append(_public_entry(item, number, label))
    return {"layout": "multi", "vaults": rows, "max": registry.MAX_VAULTS,
            "open": opened if opened in {e["id"] for e in entries} else None}


UPDATE_KEYS = ("label", "glyph", "colour", "discret", "order")


def update_vault(hq_root: Path, token: str | None, vid, data) -> dict:
    """Name, glyph, colour, Discret and order. A Discret name (setting, changing or revealing it)
    needs this vault open in this session, since it is sealed with the vault's key."""
    _require_live(token)
    if not isinstance(data, dict) or not data or set(data) - set(UPDATE_KEYS):
        raise VaultError("validation")
    if not isinstance(vid, str) or not registry.VID_RE.fullmatch(vid):
        raise VaultError("bad_vault")
    base = _base(hq_root)
    if _layout(base) != "multi":
        raise VaultError("bad_vault")
    with _REGISTRY_LOCK:
        reg = _load_registry(base)
        entry = registry.find(reg, vid)
        if entry is None:
            raise VaultError("bad_vault")
        discret = data.get("discret", entry["discret"])
        if not isinstance(discret, bool):
            raise VaultError("validation")
        label = None
        if "label" in data:
            label = registry.clean_label(data["label"])
            if label is None:
                raise VaultError("validation")
        glyph = data.get("glyph", entry["glyph"])
        colour = data.get("colour", entry["colour"])
        order = data.get("order", entry["order"])
        if glyph not in registry.GLYPHS or colour not in registry.COLOURS or not registry._order(order):
            raise VaultError("validation")
        root = master = None
        if discret or entry["discret"]:
            root, master, _header = _master(hq_root, token, vid)  # locked unless open here
        if discret:
            name = label if label is not None else (entry["label"] if not entry["discret"] else None)
            if name is not None:
                _write_label(root, master, name)  # sealed first, then the clear name leaves the registry
            elif _read_label(root, master) is None:
                raise VaultError("validation")
            shown = None
        else:
            shown = label if label is not None else entry["label"]
            if entry["discret"] and shown is None:
                shown = _read_label(root, master)
            if shown is None:
                raise VaultError("validation")
        updated = dict(entry, label=shown, glyph=glyph, colour=colour, discret=discret, order=order)
        try:
            registry.validate_entry(updated)
        except registry.RegistryError:
            raise VaultError("validation") from None
        reg["vaults"] = [updated if item["id"] == vid else item for item in reg["vaults"]]
        _save_registry(base, reg)
        if entry["discret"] and not discret:
            _drop_label(root)
        number = 1 + sorted(reg["vaults"], key=lambda e: (e["order"], e["created"], e["id"])).index(updated)
        visible = _read_label(root, master) if discret and master is not None else None
    return _public_entry(updated, number, visible)


def _open_with_budget(token: str | None, opener, vault: str = "legacy"):
    key_token = _require_live(token)
    slot = _slot(key_token, vault)
    _begin_attempt(slot)
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
        _finish_attempt(slot, ok, count_failure=count_failure)


def unlock(hq_root: Path, token: str | None, passphrase: str, *, vid: str | None = None) -> dict:
    def opener():
        header = _read_header(_root(hq_root, vid=vid))
        if header is None:
            raise VaultError("missing")
        secret = _passphrase_bytes(passphrase) if isinstance(passphrase, str) and len(passphrase) <= 128 else b""
        master = _unwrap(header, secret, "passphrase")
        return master, int(header.get("epoch") or 0), None

    identity = _resolve(hq_root, vid)[1]
    _key, master, epoch, _extra = _open_with_budget(token, opener, identity)
    _install(_key, master, epoch, identity)
    _wipe(bytearray(master))
    _touch(hq_root, identity)
    return {"unlocked": True}


def unlock_with_recovery(hq_root: Path, token: str | None, recovery_key: str, *, vid: str | None = None) -> dict:
    def opener():
        header = _read_header(_root(hq_root, vid=vid))
        if header is None:
            raise VaultError("missing")
        raw = _recovery_bytes(recovery_key)
        if raw is None:
            raise VaultError("passphrase")
        master = _unwrap(header, raw, "recovery")
        return master, int(header.get("epoch") or 0), None

    identity = _resolve(hq_root, vid)[1]
    _key, master, epoch, _extra = _open_with_budget(token, opener, identity)
    _install(_key, master, epoch, identity)
    _wipe(bytearray(master))
    _touch(hq_root, identity)
    return {"unlocked": True, "recovery": True}


def _touch(hq_root: Path, identity: str) -> None:
    """last_used_day (a day, never a time) for a listed vault. Visible while locked, by design."""
    if identity == "legacy":
        return
    try:
        base = _base(hq_root)
        with _REGISTRY_LOCK:
            data = _load_registry(base)
            entry = registry.find(data, identity)
            day = registry.today()
            if entry is None or entry["last_used_day"] == day:
                return
            entry["last_used_day"] = day
            _save_registry(base, data)
    except VaultError:
        return  # the unlock stands; only the day is not recorded


def lock(token: str | None) -> dict:
    drop_session(token)
    return {"unlocked": False}


def change_passphrase(hq_root: Path, token: str | None, current: str, new_value: str, confirm: str, *, vid: str | None = None, recovery_key: str | None = None) -> dict:
    root, master, header = _master(hq_root, token, vid)
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
            _fail(_slot(_token(token), _resolve(hq_root, vid)[1]))
            raise VaultError("passphrase") from None
        if not hmac.compare_digest(check, bytes(master)):
            _wipe(bytearray(check))
            _fail(_slot(_token(token), _resolve(hq_root, vid)[1]))
            raise VaultError("passphrase")
        _wipe(bytearray(check))
    salt = os.urandom(16)
    params = _kdf_params(salt)
    header["kdf"] = params
    header["passphrase_wrap"] = _b64(_seal(_derive(params, _passphrase_bytes(new_value)), bytes(master), _AAD_PASS))
    header["epoch"] = int(header.get("epoch") or 1) + 1
    _write_header(root, header)
    _close_vault(_resolve(hq_root, vid)[1])  # fix 3: only this vault's sessions; other vaults stay open
    return {"changed": True, "unlocked": False, "recovery_key_unchanged": True}


def rotate_recovery(hq_root: Path, token: str | None, passphrase: str, *, vid: str | None = None) -> dict:
    """Replace the recovery wrap. The previous recovery key stops working.

    Changing the passphrase does not call this and does not revoke the recovery key.
    """
    root, master, header = _master(hq_root, token, vid)
    try:
        check = _unwrap(header, _passphrase_bytes(passphrase or ""), "passphrase")
    except VaultError:
        _fail(_slot(_token(token), _resolve(hq_root, vid)[1]))
        raise VaultError("passphrase") from None
    if not hmac.compare_digest(check, bytes(master)):
        _wipe(bytearray(check))
        _fail(_slot(_token(token), _resolve(hq_root, vid)[1]))
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
    _close_vault(_resolve(hq_root, vid)[1])  # fix 3: only this vault's sessions; other vaults stay open
    return {"rotated": True, "unlocked": False, "recovery_key": shown, "previous_recovery_key": "revoked"}


def status(hq_root: Path, token: str | None, *, vid: str | None = None) -> dict:
    if not _disk and _test_dir is None:
        return {"configured": False, "unlocked": False, "private_generation": private_generation_ready(None), "acl": "skipped"}
    cleanup_partials(hq_root)
    try:
        root = _root(hq_root, vid=vid)
        header = _read_header(root) if root.is_dir() else None
    except VaultError as exc:
        return {"configured": False, "unlocked": False, "private_generation": False, "acl": "unverified", "code": exc.code}
    unlocked = False
    if header is not None and isinstance(token, str) and TOKEN_RE.fullmatch(token):
        try:
            _master(hq_root, token, vid)
            unlocked = True
        except VaultError:
            unlocked = False
    return {
        "configured": header is not None,
        "unlocked": unlocked,
        "private_generation": _status_private_generation(root, header),
        "acl": "skipped" if os.name != "nt" or not _apply_acl else ((header or {}).get("acl") or "unverified"),
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


def _write_label(root: Path, master: bytes, label: str) -> None:
    """Discret: the name lives only here, sealed with this vault's master key."""
    payload = json.dumps({"label": label}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    _atomic(root / LABEL_FILE, _seal(bytes(master), payload, _AAD_LABEL))


def _read_label(root: Path, master: bytes) -> str | None:
    path = root / LABEL_FILE
    if not path.is_file():
        return None
    if _is_reparse(path):
        raise VaultError("corrupt")
    try:
        data = json.loads(_open(bytes(master), path.read_bytes(), _AAD_LABEL).decode("utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError, VaultError):
        raise VaultError("corrupt") from None
    label = data.get("label") if isinstance(data, dict) else None
    return registry.clean_label(label)


def _drop_label(root: Path) -> None:
    path = root / LABEL_FILE
    if path.exists() and _is_reparse(path):
        raise VaultError("bad_root")
    path.unlink(missing_ok=True)


def _usage_all(hq_root: Path) -> tuple[int, int]:
    """Every vault on this PC counted together, for the global cap. File sizes only, no key needed."""
    base = _base(hq_root)
    if not base.is_dir() or _layout(base) != "multi":
        return _usage(base) if base.is_dir() else (0, 0)
    count = total = 0
    for entry in _load_registry(base)["vaults"]:
        try:
            folder = _vault_dir(base, entry["id"])
        except VaultError:
            continue
        c, t = _usage(folder)
        count += c
        total += t
    return count, total


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


def store_image(hq_root: Path, token: str | None, raw: bytes, settings: dict, *, vid: str | None = None) -> dict:
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
    root, master, _header = _master(hq_root, token, vid)
    with _LOCK:
        count, used = _usage(root)
        incoming = len(png) + len(thumb) + 1024
        if count >= _quota_images or used + incoming > _quota_bytes:
            raise VaultError("quota")
        all_count, all_used = _usage_all(hq_root)
        if all_count >= _global_images or all_used + incoming > _global_bytes:
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
        for entry in _sessions.values():
            entry.pop("search", None)  # H: rebuilt on the next search
    return {"id": image_id, "width": width, "height": height}


def _triage(item: dict) -> str:
    value = item.get("triage") if isinstance(item, dict) else None
    return value if value in gallery.TRIAGE else "none"


def page(hq_root: Path, token: str | None, *, vid: str | None = None, limit: int = 24, cursor: str | None = None, view: str = "") -> dict:
    root, master, _header = _master(hq_root, token, vid)
    limit = 24 if not isinstance(limit, int) else max(1, min(PAGE_MAX, limit))
    items = _read_index(root, master)
    # Same views as the normal gallery. The flag lives in the encrypted index only.
    if view == "trash":
        items = [item for item in items if _triage(item) == "reject"]
    elif view == "untriaged":
        items = [item for item in items if _triage(item) == "none"]
    else:
        items = [item for item in items if _triage(item) != "reject"]
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
        "triage": _triage(item),
        "tags": item.get("tags") or [],
        "collection": item.get("collection") or "",
    } for item in chosen]
    next_cursor = public[-1]["id"] if len(items) > limit and public else None
    return {"images": public, "next_cursor": next_cursor}


def detail(hq_root: Path, token: str | None, image_id: str, *, vid: str | None = None) -> dict:
    root, master, _header = _master(hq_root, token, vid)
    meta, _png, _thumb = _read_object(root, master, image_id)
    row = next((item for item in _read_index(root, master) if item.get("id") == image_id), {})
    return {
        "id": image_id,
        "created": meta.get("created"),
        "width": meta.get("width"),
        "height": meta.get("height"),
        "settings": meta.get("settings") if isinstance(meta.get("settings"), dict) else {},
        "tags": row.get("tags") or [],
        "collection": row.get("collection") or "",
    }


def file_bytes(hq_root: Path, token: str | None, image_id: str, kind: str, *, vid: str | None = None, include_parameters: bool = False) -> tuple[bytes, str, str]:
    """Vault originals carry no generation text unless the owner explicitly asks
    for it on one export (include_parameters). Stored objects never do."""
    root, master, _header = _master(hq_root, token, vid)
    meta, png, thumb = _read_object(root, master, image_id)
    if kind == "original":
        if include_parameters is True:
            settings = meta.get("settings") if isinstance(meta.get("settings"), dict) else {}
            try:
                png = gallery.with_parameters(png, settings)
            except gallery.GalleryError:
                raise VaultError("bad_image") from None
        return png, "image/png", 'attachment; filename="coffre.png"'
    if kind == "thumb":
        return thumb, "image/jpeg", 'inline; filename="coffre.jpg"'
    raise VaultError("bad_id")


def delete(hq_root: Path, token: str | None, image_id: str, *, vid: str | None = None) -> dict:
    root, master, _header = _master(hq_root, token, vid)
    path = _object_path(root, image_id)
    if not path.is_file():
        raise VaultError("bad_id")
    path.unlink()
    items = [item for item in _read_index(root, master) if item.get("id") != image_id]
    _write_index(root, master, items)
    _forget_all_searches()
    return {"deleted": True}


def set_triage(hq_root: Path, token: str | None, image_id: str, state, *, vid: str | None = None) -> dict:
    """Reversible sort flag for a vault image, stored inside the encrypted index.
    'reject' only moves it to the vault bin; nothing is deleted."""
    if state not in gallery.TRIAGE:
        raise VaultError("bad_triage")
    root, master, _header = _master(hq_root, token, vid)
    with _LOCK:
        items = _read_index(root, master)
        for item in items:
            if item.get("id") == image_id:
                before = _triage(item)
                if state == "none":
                    item.pop("triage", None)
                else:
                    item["triage"] = state
                _write_index(root, master, items)
                return {"id": image_id, "triage": state, "previous": before}
    raise VaultError("bad_id")


# ---------------------------------------------------------------- H: searchable vault
# Tags and the collection live in the encrypted index (index.bin, sealed with the vault key).
# The prompt search index is built in memory from the encrypted objects on first search and
# is kept on the unlock session itself: locking, logout, the idle auto-lock, a passphrase
# change (epoch) or any vault write drops it. It is never written anywhere.
TAGS_MAX = 12
TAG_LEN = 32
COLLECTION_LEN = 48
QUERY_LEN = 120


def _fold(text) -> str:
    import unicodedata
    value = unicodedata.normalize("NFKD", str(text or "")).casefold()
    return "".join(ch for ch in value if not unicodedata.combining(ch))


def _label(value, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    if not value or len(value) > limit or any(ord(ch) < 32 for ch in value):
        return None
    return value


def _clean_tags(raw) -> list | None:
    if not isinstance(raw, list) or len(raw) > TAGS_MAX:
        return None
    out = []
    for value in raw:
        label = _label(value, TAG_LEN)
        if label is None:
            return None
        if _fold(label) not in {_fold(t) for t in out}:
            out.append(label)
    return out


def _forget_search(token: str | None) -> None:
    with _LOCK:
        entry = _sessions.get(token) if isinstance(token, str) else None
        if entry is not None:
            entry.pop("search", None)


def _forget_all_searches() -> None:
    with _LOCK:
        for entry in _sessions.values():
            entry.pop("search", None)


def search_cache_size_for_tests() -> int:
    with _LOCK:
        return sum(len(entry.get("search") or {}) for entry in _sessions.values())


def set_labels(hq_root: Path, token: str | None, image_id: str, tags, collection, *, vid: str | None = None) -> dict:
    clean = _clean_tags(tags if tags is not None else [])
    coll = "" if collection in (None, "") else _label(collection, COLLECTION_LEN)
    if clean is None or coll is None:
        raise VaultError("validation")
    root, master, _header = _master(hq_root, token, vid)
    with _LOCK:
        items = _read_index(root, master)
        for item in items:
            if item.get("id") == image_id:
                if clean:
                    item["tags"] = clean
                else:
                    item.pop("tags", None)
                if coll:
                    item["collection"] = coll
                else:
                    item.pop("collection", None)
                _write_index(root, master, items)
                break
        else:
            raise VaultError("bad_id")
    _forget_all_searches()
    return {"id": image_id, "tags": clean, "collection": coll}


def _search_rows(root: Path, master: bytes, token: str, items: list) -> dict:
    with _LOCK:
        entry = _sessions.get(token)
        cached = entry.get("search") if entry is not None else None
    if cached is not None:
        return cached
    rows = {}
    for item in items:
        try:
            meta, _png, _thumb = _read_object(root, master, item["id"])
        except VaultError:
            continue
        settings = meta.get("settings") if isinstance(meta.get("settings"), dict) else {}
        rows[item["id"]] = _fold(settings.get("prompt") or "")
    with _LOCK:
        entry = _sessions.get(token)
        if entry is not None:
            entry["search"] = rows
    return rows


def search(hq_root: Path, token: str | None, data: dict, *, vid: str | None = None) -> dict:
    """POST-only (the words never travel in a URL). Prompt words, a tag and/or a collection."""
    query = data.get("q", "") if isinstance(data, dict) else None
    tag = data.get("tag") or "" if isinstance(data, dict) else None
    collection = data.get("collection") or "" if isinstance(data, dict) else None
    if not isinstance(query, str) or len(query) > QUERY_LEN or not isinstance(tag, str) or not isinstance(collection, str) \
            or len(tag) > TAG_LEN or len(collection) > COLLECTION_LEN:
        raise VaultError("validation")
    root, master, _header = _master(hq_root, token, vid)
    key = _token(token)
    items = [item for item in _read_index(root, master) if _triage(item) != "reject"]
    words = [w for w in _fold(query).split() if w]
    rows = _search_rows(root, master, key, items) if words else {}
    found = []
    for item in items:
        if tag and _fold(tag) not in {_fold(t) for t in item.get("tags") or []}:
            continue
        if collection and _fold(collection) != _fold(item.get("collection") or ""):
            continue
        if words:
            hay = rows.get(item["id"], "") + " " + " ".join(_fold(t) for t in item.get("tags") or []) + " " + _fold(item.get("collection") or "")
            if not all(w in hay for w in words):
                continue
        found.append(item)
    found.sort(key=lambda item: (str(item.get("created") or ""), item.get("id") or ""), reverse=True)
    tags, collections = {}, {}
    for item in items:
        for t in item.get("tags") or []:
            tags[t] = tags.get(t, 0) + 1
        if item.get("collection"):
            collections[item["collection"]] = collections.get(item["collection"], 0) + 1
    return {
        "images": [{"id": i["id"], "created": i.get("created"), "width": i.get("width"), "height": i.get("height"),
                    "triage": _triage(i), "tags": i.get("tags") or [], "collection": i.get("collection") or ""} for i in found[:PAGE_MAX]],
        "total": len(found),
        "tags": sorted(tags.items(), key=lambda kv: (-kv[1], _fold(kv[0])))[:64],
        "collections": sorted(collections.items(), key=lambda kv: _fold(kv[0]))[:64],
    }


def backup_bytes(hq_root: Path, token: str | None, *, vid: str | None = None) -> bytes:
    root, _master_key, _header = _master(hq_root, token, vid)
    offered_single = vid is None and layout(hq_root) == "legacy"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in ("vault.json", "index.bin", LABEL_FILE):  # label.bin: the Discret name, still sealed
            path = root / name
            if path.is_file() and not _is_reparse(path):
                archive.write(path, name)
        folder = root / "objects"
        if folder.is_dir() and not _is_reparse(folder):
            for child in sorted(folder.iterdir()):
                if child.is_file() and not _is_reparse(child) and ID_RE.fullmatch(child.stem):
                    archive.write(child, "objects/" + child.name)
    if offered_single:
        _record_backup_offer(_token(token))  # the single vault's ZIP was really handed out
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
    if clean in ("vault.json", "index.bin", LABEL_FILE):
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


def restore_backup(hq_root: Path, token: str | None, payload: bytes, passphrase: str, *, vid: str | None = None) -> dict:
    _require_live(token)
    if not isinstance(payload, (bytes, bytearray)) or not payload or len(payload) > BACKUP_MAX:
        raise VaultError("validation")
    if not passphrase_acceptable(passphrase):
        raise VaultError("passphrase")
    root = _root(hq_root, create=True, vid=vid)
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
            if (staging / LABEL_FILE).exists():
                _read_label(staging, master)  # a sealed name that this key cannot open is refused
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
        _seal_acl(root)
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


# ---- V1.5: migration of the single vault into vaults/<vid>/ (rename only) ----------------------
# Two renames, never a copy and never a re-encryption:
#   forge-vault/            -> forge-vault.migrating/       (the vault itself, untouched)
#   (new) forge-vault/vaults/
#   forge-vault.migrating/  -> forge-vault/vaults/<vid>/
# A journal beside the folder names the vid before the first rename. The registry is written
# only after the second rename. resume_migration() finishes a cut-off run; cancel_migration()
# puts the single vault back where it was.

_migration_fault = None


def set_migration_fault_for_tests(kind: str | None) -> None:
    """'after_journal', 'after_move', 'after_container', 'after_place' or 'after_registry'."""
    global _migration_fault
    _migration_fault = kind


def _migration_step(name: str) -> None:
    if _migration_fault == name:
        raise OSError("injected")


def _journal_path(base: Path) -> Path:
    return base.with_name(base.name + ".migration.json")


def _staging_path(base: Path) -> Path:
    return base.with_name(base.name + ".migrating")


def _read_journal(base: Path) -> str | None:
    path = _journal_path(base)
    if not path.exists() and not path.is_symlink():
        return None
    if _is_reparse(path) or not path.is_file():
        raise VaultError("bad_root")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        raise VaultError("registry") from None
    vid = data.get("vid") if isinstance(data, dict) and data.get("version") == 1 else None
    if not isinstance(vid, str) or not registry.VID_RE.fullmatch(vid):
        raise VaultError("registry")
    return vid


def _seal_container(base: Path, folder: Path) -> str:
    """Re-check links and re-apply the owner-only ACL at the new place."""
    _refuse_reparse_chain(folder)
    for path in (base, base / VAULTS_DIR):
        if _is_reparse(path):
            raise VaultError("bad_root")
        _restrict(path)
    return _seal_acl(folder)


def _finish_migration(base: Path, vid: str) -> dict:
    folder = _vault_dir(base, vid)
    if _read_header(folder) is None:
        raise VaultError("missing")
    data = _load_registry(base)
    if registry.find(data, vid) is None:
        if data["vaults"]:
            raise VaultError("registry")  # migration only ever starts from no registry
        entry = registry.make_entry(vid, label=registry.MIGRATED_LABEL, glyph=registry.DEFAULT_GLYPH,
                                    colour=registry.DEFAULT_COLOUR, discret=False, order=0)
        _save_registry(base, {"version": registry.VERSION, "legacy": vid, "vaults": [entry]})
    _migration_step("after_registry")
    acl = _seal_container(base, folder)
    _journal_path(base).unlink(missing_ok=True)
    return {"migrated": True, "vid": vid, "acl": acl}


def _migrate(hq_root: Path) -> dict:
    base = _base(hq_root)
    if not base.is_dir():
        raise VaultError("missing")
    if _read_journal(base) is not None:
        return resume_migration(hq_root)
    layout = _layout(base)
    if layout == "multi":
        return {"migrated": False, "vid": _load_registry(base)["legacy"]}  # replay: nothing to do
    if layout != "legacy" or _read_header(base) is None:
        raise VaultError("missing")
    staging = _staging_path(base)
    if staging.exists() or staging.is_symlink():
        raise VaultError("bad_root")
    _refuse_reparse_chain(base)
    lock_all()
    vid = registry.new_vid()
    _atomic(_journal_path(base), json.dumps({"version": 1, "vid": vid}).encode("utf-8"))
    _migration_step("after_journal")
    os.replace(base, staging)
    _migration_step("after_move")
    base.mkdir()
    (base / VAULTS_DIR).mkdir()
    _migration_step("after_container")
    os.replace(staging, base / VAULTS_DIR / vid)
    _migration_step("after_place")
    return _finish_migration(base, vid)


def migrate_legacy(hq_root: Path, token: str | None, *, backup_offered=None) -> dict:
    """V1.6: only on the owner's explicit first opening of the vault panel, after the backup offer.
    Fix 1: the server decides. This HQ session must have downloaded the single vault's ZIP or
    acknowledged the offer (acknowledge_backup_offer) within BACKUP_OFFER_TTL_SEC; the record is
    used up. backup_offered from the client is ignored. Never called at start-up, by status, by
    jobs or by cleanup."""
    key = _require_live(token)
    if layout(hq_root) == "multi":
        return _migrate(hq_root)  # replay: nothing to do, no offer needed
    if not _take_backup_offer(key):
        raise VaultError("backup_first")
    try:
        return _migrate(hq_root)
    except OSError:
        try:
            resume_migration(hq_root)
        except (VaultError, OSError):
            pass
        raise VaultError("migration_failed") from None


def layout(hq_root: Path) -> str:
    """'legacy' means a migration will be offered at the panel's next explicit opening."""
    if not _disk and _test_dir is None:
        return "empty"
    try:
        base = _base(hq_root)
        journal = _journal_path(base)
        if journal.exists() or journal.is_symlink():
            return "migrating"  # whenever a journal exists, even while the folder itself is moved away
        if not base.is_dir():
            return "empty"
        return _layout(base)
    except VaultError:
        return "unreadable"


def resume_migration(hq_root: Path) -> dict:
    """Finish a cut-off migration. Nothing is deleted; an unclear state is left as it is."""
    base = _base(hq_root)
    vid = _read_journal(base)
    if vid is None:
        return {"migrated": False}
    staging = _staging_path(base)
    target = base / VAULTS_DIR / vid
    if staging.is_dir() and not _is_reparse(staging):
        if _header_path(base).exists() or target.exists():
            raise VaultError("registry")  # two copies: never guess which one is right
        if not base.exists():
            base.mkdir()
        (base / VAULTS_DIR).mkdir(exist_ok=True)
        os.replace(staging, target)
        return _finish_migration(base, vid)
    if target.is_dir() and _read_header(target) is not None:
        return _finish_migration(base, vid)
    if _header_path(base).is_file():
        _journal_path(base).unlink(missing_ok=True)  # cut before the first rename: nothing moved
        return {"migrated": False}
    raise VaultError("registry")


def cancel_migration(hq_root: Path) -> dict:
    """Put the single vault back at the top. Refused once any other vault exists."""
    base = _base(hq_root)
    vid = _read_journal(base)
    staging = _staging_path(base)
    lock_all()
    if vid is None:
        if _layout(base) != "multi":
            return {"cancelled": False}
        data = _load_registry(base)
        vid = data["legacy"]
        if vid is None or len(data["vaults"]) != 1:
            raise VaultError("registry")
        _atomic(_journal_path(base), json.dumps({"version": 1, "vid": vid}).encode("utf-8"))
    target = base / VAULTS_DIR / vid
    if not staging.exists() and not staging.is_symlink() and not target.exists() and _header_path(base).is_file():
        # Cut right after the journal was written: nothing moved, so only the journal goes.
        _journal_path(base).unlink(missing_ok=True)
        return {"cancelled": True}
    if not staging.exists():
        if not target.is_dir() or _is_reparse(target):
            raise VaultError("registry")
        others = [child for child in (base / VAULTS_DIR).iterdir() if child.name != vid]
        if others:
            raise VaultError("registry")
        os.replace(target, staging)
    elif _is_reparse(staging):
        raise VaultError("bad_root")
    if base.exists():
        _registry_path(base).unlink(missing_ok=True)
        vaults = base / VAULTS_DIR
        if vaults.exists():
            vaults.rmdir()  # empty by now; refuses otherwise
        base.rmdir()
    os.replace(staging, base)
    _journal_path(base).unlink(missing_ok=True)
    return {"cancelled": True}


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
        "bad_triage": 400,
        "registry": 409,
        "bad_vault": 404,
        "use_vaults": 409,
        "migration": 409,
        "too_many": 409,
        "migration_failed": 409,
        "backup_first": 409,
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
        "bad_triage": "\u00c9tat de tri inconnu.",
        "registry": "La liste des coffres est illisible. Aucun coffre n'est ouvert.",
        "bad_vault": "Coffre introuvable.",
        "use_vaults": "Choisissez un coffre dans la liste.",
        "migration": "Le coffre doit d'abord passer au nouveau rangement.",
        "too_many": "Nombre maximal de coffres atteint.",
        "migration_failed": "Le nouveau rangement n'a pas abouti. Rien n'est perdu.",
        "backup_first": "Proposez d'abord la sauvegarde du coffre.",
        "disabled": "La génération privée reste désactivée tant que Forge n'a pas prouvé qu'il n'écrit pas de copie en clair.",
    }.get(code, "Le coffre a refusé l'opération.")
