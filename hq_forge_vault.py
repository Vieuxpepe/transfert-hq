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
import shutil
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

_LOCK = threading.Lock()
_sessions: dict[str, dict] = {}
_failures: dict[str, tuple[int, float]] = {}
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
    _disk = False
    with _LOCK:
        for entry in _sessions.values():
            _wipe(entry.get("key"))
        _sessions.clear()
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


def _reparse(path: Path) -> bool:
    if path.is_symlink():
        return True
    if os.name != "nt" or not path.exists():
        return False
    attrs = ctypes_attributes(str(path))
    return attrs is not None and bool(attrs & 0x400)


def ctypes_attributes(path: str):
    import ctypes
    value = ctypes.windll.kernel32.GetFileAttributesW(path)
    if value == 0xFFFFFFFF:
        return None
    return value


def _root(hq_root: Path, *, create: bool = False) -> Path:
    path = _default_dir()
    _outside_hq(path, hq_root)
    if _reparse(path):
        raise VaultError("bad_root")
    if create:
        path.mkdir(parents=True, exist_ok=True)
        if _reparse(path):
            raise VaultError("bad_root")
    return path


def _header_path(root: Path) -> Path:
    return root / "vault.json"


def _read_header(root: Path) -> dict | None:
    path = _header_path(root)
    if not path.is_file() or path.is_symlink() or _reparse(path):
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
    temporary = path.with_suffix(path.suffix + ".partial")
    try:
        with temporary.open("wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        winerror = getattr(exc, "winerror", None)
        if getattr(exc, "errno", None) in (28, 112) or winerror == 112:
            raise VaultError("disk") from None
        raise VaultError("disk") from None


def cleanup_partials(hq_root: Path) -> None:
    try:
        root = _root(hq_root)
    except VaultError:
        return
    if not root.is_dir():
        return
    for path in root.rglob("*.partial"):
        if path.is_symlink() or _reparse(path):
            continue
        path.unlink(missing_ok=True)


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


def _throttle(token: str) -> None:
    count, until = _failures.get(token, (0, 0.0))
    if count >= FAILS_BEFORE_THROTTLE and time.monotonic() < until:
        raise VaultError("throttled")


def _fail(token: str) -> None:
    count, _until = _failures.get(token, (0, 0.0))
    count += 1
    until = time.monotonic() + THROTTLE_SEC if count >= FAILS_BEFORE_THROTTLE else 0.0
    _failures[token] = (count, until)


def _succeed(token: str) -> None:
    _failures.pop(token, None)


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
    if not isinstance(token, str):
        return
    with _LOCK:
        previous = _sessions.pop(token, None)
        _failures.pop(token, None)
    if previous:
        _wipe(previous.get("key"))


def lock_all() -> None:
    with _LOCK:
        entries = list(_sessions.values())
        _sessions.clear()
    for entry in entries:
        _wipe(entry.get("key"))


def _master(hq_root: Path, token: str | None) -> tuple[Path, bytearray, dict]:
    key_token = _token(token)
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


def unlock(hq_root: Path, token: str | None, passphrase: str) -> dict:
    key_token = _token(token)
    _throttle(key_token)
    root = _root(hq_root)
    header = _read_header(root)
    if header is None:
        raise VaultError("missing")
    secret = _passphrase_bytes(passphrase) if isinstance(passphrase, str) and len(passphrase) <= 128 else b""
    try:
        master = _unwrap(header, secret, "passphrase")
    except VaultError:
        _fail(key_token)
        raise VaultError("passphrase") from None
    _succeed(key_token)
    _install(key_token, master, int(header.get("epoch") or 0))
    _wipe(bytearray(master))
    return {"unlocked": True}


def unlock_with_recovery(hq_root: Path, token: str | None, recovery_key: str) -> dict:
    key_token = _token(token)
    _throttle(key_token)
    raw = _recovery_bytes(recovery_key)
    header = _read_header(_root(hq_root))
    if header is None:
        raise VaultError("missing")
    if raw is None:
        _fail(key_token)
        raise VaultError("passphrase")
    try:
        master = _unwrap(header, raw, "recovery")
    except VaultError:
        _fail(key_token)
        raise VaultError("passphrase") from None
    _succeed(key_token)
    _install(key_token, master, int(header.get("epoch") or 0))
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
    return {"changed": True, "unlocked": False}


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
    if path.is_symlink() or _reparse(path):
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
    if path.exists() and (path.is_symlink() or _reparse(path)):
        raise VaultError("bad_id")
    resolved = path.resolve()
    if resolved.parent != folder.resolve():
        raise VaultError("bad_id")
    return path


def _read_index(root: Path, master: bytes) -> list:
    path = root / "index.bin"
    if not path.is_file():
        return []
    if path.is_symlink() or _reparse(path):
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
            if path.is_file() and not path.is_symlink():
                archive.write(path, name)
        folder = root / "objects"
        if folder.is_dir() and not folder.is_symlink():
            for child in sorted(folder.iterdir()):
                if child.is_file() and not child.is_symlink() and ID_RE.fullmatch(child.stem):
                    archive.write(child, "objects/" + child.name)
    return buffer.getvalue()


def restore_backup(hq_root: Path, token: str | None, payload: bytes, passphrase: str) -> dict:
    _token(token)
    if not isinstance(payload, (bytes, bytearray)) or not payload or len(payload) > BACKUP_MAX:
        raise VaultError("validation")
    if not passphrase_acceptable(passphrase):
        raise VaultError("passphrase")
    root = _root(hq_root, create=True)
    staging = root.with_name(root.name + ".restore")
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir()
    try:
        with zipfile.ZipFile(io.BytesIO(bytes(payload))) as archive:
            names = archive.namelist()
            if any(name.startswith("/") or ".." in name.replace("\\", "/") or name.endswith(":") for name in names):
                raise VaultError("validation")
            allowed = {"vault.json", "index.bin"}
            for name in names:
                clean = name.replace("\\", "/")
                if clean in allowed or (clean.startswith("objects/pvt-") and clean.endswith(".bin") and ID_RE.fullmatch(Path(clean).stem)):
                    continue
                raise VaultError("validation")
            archive.extractall(staging)
        header = _read_header(staging)
        if header is None:
            raise VaultError("corrupt")
        master = _unwrap(header, _passphrase_bytes(passphrase), "passphrase")
        _wipe(bytearray(master))
        previous = root.with_name(root.name + ".previous")
        if previous.exists():
            shutil.rmtree(previous, ignore_errors=True)
        if _header_path(root).is_file():
            os.replace(root, previous)
        os.replace(staging, root)
        if previous.exists():
            shutil.rmtree(previous, ignore_errors=True)
    except VaultError:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    except (OSError, zipfile.BadZipFile, ValueError):
        shutil.rmtree(staging, ignore_errors=True)
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
        "disabled": "La génération privée reste désactivée tant que Forge n'a pas prouvé qu'il n'écrit pas de copie en clair.",
    }.get(code, "Le coffre a refusé l'opération.")
