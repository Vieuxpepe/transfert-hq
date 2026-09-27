"""Controller-side companion registry, HMAC auth, and admin API.

Secrets live in hq_agents.json (gitignored). Client capability claims never
grant privilege. iOS and other phone OS values are refused at enrollment.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable

import hq_agent_ops as ops
import hq_agent_protocol as proto
import hq_devices
import hq_jobs
import hq_state

AGENTS_NAME = "hq_agents.json"
TOKEN_TTL_SEC = 15 * 60
ONLINE_SEC = 45
MAX_DEVICES = 32
MAX_TOKENS = 20
ENROLL_WINDOW_SEC = 60
ENROLL_MAX_HITS = 8
SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")

_lock = threading.RLock()
_root: Path | None = None
_tokens: list[dict] = []
_devices: list[dict] = []
_malformed = False
_now: Callable[[], float] = time.time
_journal: Callable[..., None] | None = None
_disk_free: Callable[[Path], dict] | None = None
_reserve_bytes: Callable[[], int] | None = None
_nonces: dict[str, dict[str, float]] = {}
_enroll_hits: dict[str, list[float]] = {}
_dummy_secret = secrets.token_hex(32)
DISK_RESERVE_DEFAULT = 2 * 1024**3
DEVICE_ARTIFACT_MAX_FILES = 32
DEVICE_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024


def bind(
    root: Path | str,
    *,
    journal: Callable[..., None] | None = None,
    now: Callable[[], float] | None = None,
    disk_free: Callable[[Path], dict] | None = None,
    reserve_bytes: Callable[[], int] | None = None,
) -> None:
    global _root, _journal, _now, _dummy_secret, _disk_free, _reserve_bytes
    _root = Path(root)
    _root.mkdir(parents=True, exist_ok=True)
    _journal = journal
    _now = now or time.time
    _disk_free = disk_free
    _reserve_bytes = reserve_bytes
    _dummy_secret = secrets.token_hex(32)
    with _lock:
        _nonces.clear()
        _enroll_hits.clear()
    hq_state.prepare_agent_state(_root)
    hq_jobs.bind(_root, journal=journal, now=_now)
    _load()


def bound() -> bool:
    return _root is not None


def malformed() -> bool:
    return _malformed


def _clock() -> float:
    return float(_now())


def _path() -> Path:
    if _root is None:
        raise RuntimeError("hq_companion non initialisé")
    return hq_state.agent_state_dir(_root) / AGENTS_NAME


def _require_writable() -> None:
    if _root is None:
        raise RuntimeError("hq_companion non initialisé")
    if _malformed:
        raise RuntimeError("hq_agents.json illisible — fichier conservé")


def _load() -> None:
    global _tokens, _devices, _malformed
    path = _path()
    if not path.is_file():
        with _lock:
            _tokens = []
            _devices = []
            _malformed = False
        return
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        with _lock:
            _tokens = []
            _devices = []
            _malformed = True
        return
    if not isinstance(raw, dict):
        with _lock:
            _tokens = []
            _devices = []
            _malformed = True
        return
    tokens = raw.get("tokens")
    devices = raw.get("devices")
    if not isinstance(tokens, list) or not isinstance(devices, list):
        with _lock:
            _tokens = []
            _devices = []
            _malformed = True
        return
    with _lock:
        _tokens = [row for row in tokens if isinstance(row, dict)][:MAX_TOKENS]
        _devices = [row for row in devices if isinstance(row, dict) and row.get("id")][:MAX_DEVICES]
        _malformed = False


def _persist() -> None:
    global _malformed
    _require_writable()
    payload = {"version": 1, "tokens": _tokens[:MAX_TOKENS], "devices": _devices[:MAX_DEVICES]}
    path = _path()
    try:
        hq_state.write_json_atomic(path, payload)
    except RuntimeError:
        _malformed = True
        raise
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _audit(kind: str, message: str, meta: dict | None = None) -> None:
    if _journal is None:
        return
    try:
        _journal(kind, message, level="info", source="agent", meta=meta or {})
    except Exception:
        return


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _header(headers: Any, name: str) -> str:
    if headers is None:
        return ""
    getter = getattr(headers, "get", None)
    if getter is None:
        return ""
    for candidate in (name, name.lower(), name.upper()):
        value = getter(candidate)
        if value:
            return str(value).strip()
    return ""


def _granted(device: dict) -> list[str]:
    return hq_devices.intersect_capabilities(device.get("support"), device.get("policy"))


def _online(device: dict, now: float | None = None) -> bool:
    if device.get("revoked"):
        return False
    try:
        seen = float(device.get("last_seen") or 0)
    except (TypeError, ValueError):
        return False
    moment = _clock() if now is None else now
    return seen > 0 and (moment - seen) <= ONLINE_SEC


def public_device(device: dict) -> dict:
    granted = _granted(device)
    return {
        "id": device.get("id"),
        "name": device.get("name") or "",
        "hostname": device.get("hostname") or "",
        "os": device.get("os") or "",
        "created_at": device.get("created_at"),
        "last_seen": device.get("last_seen") or 0,
        "online": _online(device),
        "revoked": bool(device.get("revoked")),
        "protocol_version": proto.PROTOCOL_VERSION,
        "support": list(device.get("support") or []),
        "policy": list(device.get("policy") or []),
        "granted": granted,
        "reported_hostname": device.get("reported_hostname") or "",
        "reported_ips": list(device.get("reported_ips") or [])[:8],
        "tailscale_ips": list(device.get("reported_ips") or device.get("tailscale_ips") or [])[:8],
        "linked_peer_id": device.get("linked_peer_id") or "",
        "status": _bounded_status(device.get("status")),
    }


def _bounded_status(raw: Any) -> dict:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key in ("cpu_pct", "mem_pct", "free_bytes", "total_bytes", "battery"):
        if key not in raw:
            continue
        value = raw.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        out[key] = value
    return out


def _find_device(device_id: str) -> dict | None:
    for device in _devices:
        if device.get("id") == device_id:
            return device
    return None


def list_devices() -> list[dict]:
    with _lock:
        return [public_device(device) for device in _devices]


def granted_for(device_id: str) -> list[str] | None:
    with _lock:
        device = _find_device(str(device_id or ""))
        if device is None or device.get("revoked"):
            return None
        return _granted(device)


def summary() -> dict:
    if not bound():
        return {
            "protocol_version": proto.PROTOCOL_VERSION,
            "enrolled": 0,
            "online": 0,
            "pending_approvals": 0,
            "malformed": False,
        }
    try:
        devices = list_devices()
        active = [device for device in devices if not device.get("revoked")]
        return {
            "protocol_version": proto.PROTOCOL_VERSION,
            "enrolled": len(active),
            "online": sum(1 for device in active if device.get("online")),
            "pending_approvals": hq_jobs.pending_count() if hq_jobs.bound() else 0,
            "malformed": _malformed or hq_jobs.malformed(),
        }
    except Exception:
        return {
            "protocol_version": proto.PROTOCOL_VERSION,
            "enrolled": 0,
            "online": 0,
            "pending_approvals": 0,
            "malformed": True,
        }


def create_enroll_token(*, label: str = "") -> dict:
    _require_writable()
    now = _clock()
    token = secrets.token_urlsafe(32)
    row = {
        "id": "tok_" + secrets.token_hex(4),
        "hash": _token_hash(token),
        "expires_at": now + TOKEN_TTL_SEC,
        "created_at": now,
        "label": str(label or "")[:40],
    }
    with _lock:
        _tokens[:] = [item for item in _tokens if float(item.get("expires_at") or 0) > now]
        if len(_tokens) >= MAX_TOKENS:
            raise ops.AgentOpError("trop de jetons en attente")
        _tokens.append(row)
        _persist()
    return {
        "ok": True,
        "token": token,
        "token_id": row["id"],
        "expires_at": row["expires_at"],
        "protocol_version": proto.PROTOCOL_VERSION,
    }


def _rate_limit(ip: str) -> None:
    now = _clock()
    with _lock:
        hits = [stamp for stamp in _enroll_hits.get(ip, []) if now - stamp < ENROLL_WINDOW_SEC]
        if len(hits) >= ENROLL_MAX_HITS:
            _enroll_hits[ip] = hits
            raise ops.AgentOpError("trop d'essais d'enrôlement")
        hits.append(now)
        _enroll_hits[ip] = hits


def _clean_support(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        raise ops.AgentOpError("support invalide")
    found = []
    for item in raw[:40]:
        if not isinstance(item, str):
            continue
        if item in hq_devices.AGENT_CAPS and item not in found:
            found.append(item)
    return found


def _clean_ips(raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ops.AgentOpError("adresses invalides")
    out = []
    for item in raw[:8]:
        text = str(item or "").strip()
        if text and len(text) <= 64 and text not in out:
            out.append(text)
    return out


def enroll(*, token: str, body: dict, client_ip: str = "") -> dict:
    _require_writable()
    _rate_limit(client_ip or "?")
    if not isinstance(body, dict):
        raise ops.AgentOpError("JSON invalide")
    try:
        version = int(body.get("protocol_version") or 0)
    except (TypeError, ValueError):
        version = 0
    if version != proto.PROTOCOL_VERSION:
        raise ops.AgentOpError("protocole incompatible")
    os_name = str(body.get("os") or "")[:40]
    if hq_devices.is_phone_os(os_name):
        raise ops.AgentOpError("les appareils iOS et téléphones ne peuvent pas être des companions")
    name = str(body.get("name") or body.get("hostname") or "Companion")[:80].strip() or "Companion"
    hostname = str(body.get("hostname") or "")[:80]
    support = _clean_support(body.get("support") if body.get("support") is not None else list(hq_devices.DEFAULT_AGENT_POLICY))
    ips = _clean_ips(body.get("tailscale_ips"))
    digest = _token_hash(str(token or ""))
    now = _clock()
    secret = secrets.token_hex(32)
    device_id = "ag_" + secrets.token_hex(8)
    policy = [cap for cap in hq_devices.DEFAULT_AGENT_POLICY if cap in hq_devices.CONTROLLER_ALLOWED]
    with _lock:
        match = None
        for item in _tokens:
            if hmac_digest_eq(str(item.get("hash") or ""), digest) and float(item.get("expires_at") or 0) > now:
                match = item
                break
        if match is None:
            raise ops.AgentOpError("jeton invalide")
        if len(_devices) >= MAX_DEVICES:
            raise ops.AgentOpError("trop de companions")
        _tokens[:] = [item for item in _tokens if item.get("id") != match.get("id")]
        device = {
            "id": device_id,
            "name": name,
            "hostname": hostname,
            "os": os_name,
            "secret": secret,
            "created_at": now,
            "last_seen": now,
            "revoked": False,
            "protocol_version": proto.PROTOCOL_VERSION,
            "support": support,
            "policy": policy,
            "tailscale_ips": ips,
            "reported_ips": ips,
            "reported_hostname": hostname,
            "linked_peer_id": "",
            "status": {},
        }
        _devices.append(device)
        _persist()
        granted = _granted(device)
    _audit("agent_enroll", f"Companion enrôlé · {name}", {"device": device_id, "os": os_name})
    return {
        "ok": True,
        "device_id": device_id,
        "device_secret": secret,
        "protocol_version": proto.PROTOCOL_VERSION,
        "granted": granted,
        "poll_sec": proto.POLL_SEC,
        "idle_poll_sec": proto.IDLE_POLL_SEC,
    }


def hmac_digest_eq(stored: str, presented: str) -> bool:
    import hmac

    left = hashlib.sha256((stored or "").encode("utf-8")).digest()
    right = hashlib.sha256((presented or "").encode("utf-8")).digest()
    return bool(hmac.compare_digest(left, right) and len(stored or "") == len(presented or "") == 64)


def revoke(device_id: str) -> dict:
    _require_writable()
    with _lock:
        device = _find_device(str(device_id or ""))
        if device is None:
            raise ops.AgentOpError("appareil introuvable")
        device["revoked"] = True
        device["secret"] = ""
        device["updated_at"] = _clock()
        _persist()
        snapshot = public_device(device)
    _cancel_open_jobs(device_id)
    _audit("agent_revoke", f"Companion révoqué · {snapshot['name']}", {"device": device_id})
    return {"ok": True, "device": snapshot}


def _cancel_open_jobs(device_id: str) -> None:
    if not hq_jobs.bound() or hq_jobs.malformed():
        return
    try:
        hq_jobs.cancel_device(device_id, actor="human")
    except (ops.AgentOpError, RuntimeError, PermissionError):
        return


def set_policy(device_id: str, policy: Any) -> dict:
    _require_writable()
    if not isinstance(policy, list):
        raise ops.AgentOpError("politique invalide")
    cleaned: list[str] = []
    for item in policy:
        if not isinstance(item, str):
            raise ops.AgentOpError("politique invalide")
        if item in hq_devices.FORBIDDEN_CAPS or item == "terminal_interactive":
            raise ops.AgentOpError("capacité interdite")
        if item not in hq_devices.CONTROLLER_ALLOWED:
            raise ops.AgentOpError("capacité inconnue")
        if item not in cleaned:
            cleaned.append(item)
    with _lock:
        device = _find_device(str(device_id or ""))
        if device is None:
            raise ops.AgentOpError("appareil introuvable")
        if device.get("revoked"):
            raise ops.AgentOpError("appareil révoqué")
        device["policy"] = cleaned
        _persist()
        snapshot = public_device(device)
    return {"ok": True, "device": snapshot}


def _remember_nonce(device_id: str, nonce: str, now: float) -> bool:
    """Return False when the nonce was already seen inside the replay window."""
    bucket = _nonces.setdefault(device_id, {})
    stale = [key for key, seen in bucket.items() if now - seen > proto.NONCE_TTL_SEC]
    for key in stale:
        bucket.pop(key, None)
    if nonce in bucket:
        return False
    if len(bucket) > 256:
        oldest = sorted(bucket.items(), key=lambda item: item[1])[:64]
        for key, _seen in oldest:
            bucket.pop(key, None)
    bucket[nonce] = now
    return True


def authenticate(method: str, path: str, headers: Any, body: bytes) -> dict | None:
    """Return the device row when the HMAC headers are valid. Otherwise None.

    The nonce cache is process-local. After a controller restart, a captured
    signed request can be replayed while its timestamp is still inside the
    ±90s skew. TLS protects ordinary traffic. This is not a durable counter.
    """
    device_id = _header(headers, proto.HEADER_DEVICE)
    stamp = proto.parse_timestamp(_header(headers, proto.HEADER_TIME))
    nonce = _header(headers, proto.HEADER_NONCE)
    presented = _header(headers, proto.HEADER_SIGNATURE).lower()
    now = _clock()
    with _lock:
        device = _find_device(device_id) if proto.DEVICE_ID_RE.fullmatch(device_id or "") else None
        secret = str(device.get("secret") or "") if device and not device.get("revoked") else ""
        if not secret or (device and hq_devices.is_phone_os(str(device.get("os") or ""))):
            secret = ""
        expected = proto.sign(secret or _dummy_secret, method, path, stamp or 0, nonce, body or b"")
        # Always compare, even when the device is unknown.
        mac_ok = proto.signatures_equal(presented, expected)
        if not device or not secret or not mac_ok or stamp is None:
            return None
        if abs(now - stamp) > proto.SKEW_SEC:
            return None
        if not proto.NONCE_RE.fullmatch(nonce or ""):
            return None
        if not _remember_nonce(device_id, nonce, now):
            return None
        return device


def _touch(device: dict, body: dict) -> dict:
    os_name = body.get("os")
    if isinstance(os_name, str) and os_name.strip() and hq_devices.is_phone_os(os_name):
        raise ops.AgentOpError("les appareils iOS et téléphones ne peuvent pas être des companions")
    try:
        version = int(body.get("protocol_version") or proto.PROTOCOL_VERSION)
    except (TypeError, ValueError):
        version = 0
    if version != proto.PROTOCOL_VERSION:
        raise ops.AgentOpError("protocole incompatible")
    if isinstance(body.get("hostname"), str):
        device["reported_hostname"] = body["hostname"][:80]
    if isinstance(os_name, str) and os_name.strip():
        device["os"] = os_name[:40]
    if "support" in body:
        device["support"] = _clean_support(body.get("support"))
    if "tailscale_ips" in body:
        device["reported_ips"] = _clean_ips(body.get("tailscale_ips"))
    if isinstance(body.get("status"), dict):
        device["status"] = _bounded_status(body.get("status"))
    device["last_seen"] = _clock()
    return device


def _json_body(body: bytes, limit: int) -> dict:
    if len(body or b"") > limit:
        raise ops.AgentOpError("corps trop volumineux")
    if not body:
        return {}
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ops.AgentOpError("JSON invalide") from exc
    if not isinstance(data, dict):
        raise ops.AgentOpError("JSON invalide")
    return data


def handle_device(*, method: str, path: str, headers: Any, body: bytes, client_ip: str = "") -> tuple[int, dict]:
    if (method or "").upper() != "POST":
        return 405, {"error": "POST requis"}
    if path == "/agent/v1/enroll":
        try:
            data = _json_body(body or b"", proto.ENROLL_MAX)
            token = str(data.get("token") or "")
            # Do not keep the token in the stored body path; pass it through and drop it from logs.
            result = enroll(token=token, body=data, client_ip=client_ip)
            return 200, result
        except ops.AgentOpError as exc:
            return 400, {"error": str(exc)}
        except RuntimeError as exc:
            return 409, {"error": str(exc)}
    device = authenticate(method, path, headers, body or b"")
    if device is None:
        return 401, {"error": "authentification companion refusée"}
    try:
        if path == "/agent/v1/heartbeat":
            data = _json_body(body or b"", proto.HEARTBEAT_MAX)
            with _lock:
                current = _find_device(str(device.get("id")))
                if current is None or current.get("revoked"):
                    return 401, {"error": "authentification companion refusée"}
                _touch(current, data)
                _persist()
                granted = _granted(current)
            return 200, {
                "ok": True,
                "protocol_version": proto.PROTOCOL_VERSION,
                "granted": granted,
                "poll_sec": proto.POLL_SEC,
                "idle_poll_sec": proto.IDLE_POLL_SEC,
            }
        if path in ("/agent/v1/poll", "/agent/v1/start", "/agent/v1/result", "/agent/v1/artifact") and hq_jobs.malformed():
            return 409, {"error": "hq_agent_jobs.json illisible — fichier conservé"}
        if path == "/agent/v1/poll":
            granted = _granted(device)
            job = None
            if "jobs" in granted and not hq_jobs.malformed():
                job = hq_jobs.take_next(str(device.get("id")))
            return 200, {
                "ok": True,
                "protocol_version": proto.PROTOCOL_VERSION,
                "granted": granted,
                "poll_sec": proto.POLL_SEC,
                "idle_poll_sec": proto.IDLE_POLL_SEC,
                "job": job,
            }
        if path == "/agent/v1/start":
            data = _json_body(body or b"", proto.JSON_BODY_MAX)
            snapshot = hq_jobs.acknowledge_start(
                str(device.get("id")),
                str(data.get("id") or ""),
                str(data.get("dispatch_token") or ""),
            )
            return 200, {"ok": True, "job": snapshot}
        if path == "/agent/v1/result":
            data = _json_body(body or b"", proto.RESULT_MAX)
            snapshot = hq_jobs.complete(
                str(device.get("id")),
                str(data.get("id") or ""),
                ok=data.get("ok") is True,
                summary=str(data.get("summary") or ""),
                output=str(data.get("output") or ""),
                error=str(data.get("error") or ""),
                dispatch_token=str(data.get("dispatch_token") or ""),
            )
            return 200, {"ok": True, "job": snapshot}
        if path == "/agent/v1/artifact":
            return _accept_artifact(device, headers, body or b"")
    except ops.AgentOpError as exc:
        return 400, {"error": str(exc)}
    except RuntimeError as exc:
        return 409, {"error": str(exc)}
    return 404, {"error": "route inconnue"}


def max_body_for(path: str) -> int:
    if path == "/agent/v1/artifact":
        return proto.ARTIFACT_MAX
    if path == "/agent/v1/result":
        return proto.RESULT_MAX
    if path == "/agent/v1/enroll":
        return proto.ENROLL_MAX
    return proto.JSON_BODY_MAX


def _reserve_limit() -> int:
    if _reserve_bytes is None:
        return DISK_RESERVE_DEFAULT
    try:
        return max(0, int(_reserve_bytes()))
    except (TypeError, ValueError):
        return DISK_RESERVE_DEFAULT


def _free_bytes() -> int | None:
    if _root is None:
        return None
    if _disk_free is not None:
        try:
            info = _disk_free(_root)
        except OSError:
            return None
        if not isinstance(info, dict) or info.get("error") or "free" not in info:
            return None
        try:
            return int(info["free"])
        except (TypeError, ValueError):
            return None
    try:
        import shutil

        return int(shutil.disk_usage(_root).free)
    except OSError:
        return None


def _artifact_usage(device_id: str) -> tuple[int, int]:
    if _root is None:
        return 0, 0
    root = _root / "Inbox" / "AgentArtifacts" / device_id
    if not root.is_dir():
        return 0, 0
    files = 0
    total = 0
    for path in root.rglob("*"):
        if not path.is_file() or path.name.endswith(".partial"):
            continue
        files += 1
        try:
            total += path.stat().st_size
        except OSError:
            continue
    return files, total


def _accept_artifact(device: dict, headers: Any, body: bytes) -> tuple[int, dict]:
    """Authorize, then reserve disk, then write. A refusal creates no file."""
    if "artifacts" not in _granted(device):
        raise ops.AgentOpError("capacité refusée")
    if len(body) > proto.ARTIFACT_MAX:
        raise ops.AgentOpError("artifact trop volumineux")
    if not body:
        raise ops.AgentOpError("artifact vide")
    job_id = _header(headers, proto.HEADER_JOB)
    name = _header(headers, proto.HEADER_ARTIFACT_NAME)
    dispatch = _header(headers, proto.HEADER_DISPATCH)
    if not proto.JOB_ID_RE.fullmatch(job_id or ""):
        raise ops.AgentOpError("travail introuvable")
    if not SAFE_NAME_RE.fullmatch(name or ""):
        raise ops.AgentOpError("nom d'artifact refusé")
    if _root is None:
        raise RuntimeError("hq_companion non initialisé")
    device_id = str(device.get("id"))
    dest: Path | None = None
    reserved = False
    try:
        hq_jobs.authorize_artifact(device_id, job_id, name, len(body), dispatch)
        reserved = True
        free = _free_bytes()
        if free is None or free < _reserve_limit() + len(body):
            raise ops.AgentOpError("espace disque insuffisant")
        used_files, used_bytes = _artifact_usage(device_id)
        if used_files >= DEVICE_ARTIFACT_MAX_FILES or used_bytes + len(body) > DEVICE_ARTIFACT_MAX_BYTES:
            raise ops.AgentOpError("quota d'artifacts atteint")
        dest_dir = _root / "Inbox" / "AgentArtifacts" / device_id / job_id
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / name
        try:
            dest.resolve().relative_to((_root / "Inbox" / "AgentArtifacts").resolve())
        except ValueError as exc:
            raise ops.AgentOpError("nom d'artifact refusé") from exc
        partial = dest.with_name(dest.name + ".partial")
        with partial.open("wb") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(partial, dest)
        digest = hashlib.sha256(body).hexdigest()
        rel = "/".join(dest.relative_to(_root).parts)
        snapshot = hq_jobs.attach_artifact(
            device_id,
            job_id,
            {"rel": rel, "name": name, "size": len(body), "sha256": digest},
            dispatch_token=dispatch,
        )
        reserved = False
        return 200, {"ok": True, "artifact": snapshot.get("artifact"), "job": snapshot["id"]}
    except Exception:
        if dest is not None:
            for path in (dest, dest.with_name(dest.name + ".partial")):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
        if reserved:
            hq_jobs.release_artifact_reservation(device_id, job_id)
        raise


def overlay_roster(devices: list[dict] | None) -> list[dict]:
    """Annotate Tailscale peers that enrolled a companion. Phones stay browsers."""
    rows = [dict(item) for item in (devices or []) if isinstance(item, dict)]
    if not bound() or _malformed:
        return rows
    try:
        agents = [device for device in list_devices() if not device.get("revoked")]
    except Exception:
        return rows
    used: set[str] = set()
    out: list[dict] = []
    for device in rows:
        merged = dict(device)
        if _matchable(merged):
            match = _match_agent(merged, agents)
            if match:
                used.add(str(match["id"]))
                merged["_agent_id"] = match["id"]
                merged["_granted"] = list(match.get("granted") or [])
                if match.get("online"):
                    merged["agent_online"] = True
        out.append(merged)
    for agent in agents:
        if str(agent.get("id")) in used:
            continue
        out.append(
            {
                "id": agent.get("id"),
                "name": agent.get("name") or agent.get("id"),
                "kind": "agent",
                "source": "agent",
                "os": agent.get("os") or "",
                "online": bool(agent.get("online")),
                "ip": (agent.get("reported_ips") or agent.get("tailscale_ips") or [""])[0],
                "path": "tailscale",
                "last_seen": agent.get("last_seen") or 0,
                "_agent_id": agent.get("id"),
                "_granted": list(agent.get("granted") or []),
            }
        )
    return out


def _matchable(device: dict) -> bool:
    if hq_devices.is_phone_device(device):
        return False
    return str(device.get("source") or "") in ("tailscale", "host")


def _match_agent(device: dict, agents: list[dict]) -> dict | None:
    """Link only when a human stored linked_peer_id. Reports are not identity."""
    peer_id = str(device.get("id") or "")
    if not peer_id:
        return None
    for agent in agents:
        if str(agent.get("linked_peer_id") or "") == peer_id:
            return agent
    return None


def link_agent(device_id: str, peer_id: str) -> dict:
    """Record an explicit controller-side link. Heartbeat data cannot do this."""
    _require_writable()
    peer = str(peer_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", peer):
        raise ops.AgentOpError("pair invalide")
    with _lock:
        device = _find_device(str(device_id or ""))
        if device is None or device.get("revoked"):
            raise ops.AgentOpError("appareil introuvable")
        device["linked_peer_id"] = peer
        _persist()
        snapshot = public_device(device)
    _audit("agent_link", f"Lien companion · {peer}", {"device": device_id, "peer": peer})
    return {"ok": True, "device": snapshot}


def create_job_for_admin(data: dict) -> dict:
    """Browser/admin jobs are always human-origin. The client cannot pick planner."""
    device_id = str(data.get("device_id") or "")
    with _lock:
        device = _find_device(device_id)
        if device is None or device.get("revoked"):
            raise ops.AgentOpError("appareil introuvable")
        granted = _granted(device)
    job = hq_jobs.create_job(
        device_id=device_id,
        op=str(data.get("op") or ""),
        args=data.get("args") if isinstance(data.get("args"), dict) else {},
        origin="human",
        ttl_sec=data.get("ttl_sec"),
        timeout_sec=data.get("timeout_sec"),
        granted=granted,
        confirm=data.get("confirm"),
    )
    return {"ok": True, "job": job}


def import_artifact(*, rel: str, dest: str) -> dict:
    if _root is None:
        raise RuntimeError("hq_companion non initialisé")
    folder = str(dest or "")
    if folder not in ("Inbox", "Uni", "Print"):
        raise ops.AgentOpError("dossier refusé")
    text = str(rel or "").replace("\\", "/").strip()
    if not text.startswith("Inbox/AgentArtifacts/") or ".." in text.split("/"):
        raise ops.AgentOpError("artifact refusé")
    src = (_root / Path(*text.split("/"))).resolve()
    base = (_root / "Inbox" / "AgentArtifacts").resolve()
    try:
        src.relative_to(base)
    except ValueError as exc:
        raise ops.AgentOpError("artifact refusé") from exc
    if not src.is_file():
        raise ops.AgentOpError("artifact introuvable")
    target_dir = _root / folder
    target_dir.mkdir(parents=True, exist_ok=True)
    name = src.name
    target = target_dir / name
    counter = 2
    while target.exists():
        target = target_dir / f"{src.stem}-{counter}{src.suffix}"
        counter += 1
        if counter > 50:
            raise ops.AgentOpError("nom déjà utilisé")
    target.write_bytes(src.read_bytes())
    stored = "/".join(target.relative_to(_root).parts)
    return {"ok": True, "rel": stored, "size": target.stat().st_size}


def admin_get(path: str, query: dict) -> tuple[int, dict]:
    try:
        if path == "/api/agent":
            return 200, {
                "ok": not (_malformed or hq_jobs.malformed()),
                "malformed": _malformed or hq_jobs.malformed(),
                "protocol_version": proto.PROTOCOL_VERSION,
                "devices": list_devices(),
                "summary": summary(),
            }
        if path == "/api/agent/jobs":
            device_id = str((query.get("device") or [""])[0] or "")
            state = str((query.get("state") or [""])[0] or "")
            try:
                limit = int((query.get("limit") or ["50"])[0] or 50)
                offset = int((query.get("offset") or ["0"])[0] or 0)
            except ValueError as exc:
                raise ops.AgentOpError("limite invalide") from exc
            return 200, hq_jobs.list_jobs(device_id=device_id, state=state, limit=limit, offset=offset)
    except ops.AgentOpError as exc:
        return 400, {"error": str(exc)}
    except RuntimeError as exc:
        return 409, {"error": str(exc)}
    return 404, {"error": "route inconnue"}


def admin_post(data: dict) -> tuple[int, dict]:
    try:
        if not isinstance(data, dict):
            raise ops.AgentOpError("JSON invalide")
        action = str(data.get("action") or "")
        if action == "enroll-token":
            return 200, create_enroll_token(label=str(data.get("label") or ""))
        if action == "revoke":
            return 200, revoke(str(data.get("device_id") or ""))
        if action == "policy":
            return 200, set_policy(str(data.get("device_id") or ""), data.get("policy"))
        if action == "job":
            return 200, create_job_for_admin(data)
        if action == "approve":
            return 200, {"ok": True, "job": hq_jobs.approve(str(data.get("id") or ""), actor="human")}
        if action == "reject":
            return 200, {"ok": True, "job": hq_jobs.reject(str(data.get("id") or ""), actor="human")}
        if action == "cancel":
            return 200, {"ok": True, "job": hq_jobs.cancel(str(data.get("id") or ""), actor="human")}
        if action == "link":
            return 200, link_agent(str(data.get("device_id") or ""), str(data.get("peer_id") or ""))
        if action == "import":
            return 200, import_artifact(rel=str(data.get("rel") or ""), dest=str(data.get("dest") or ""))
        raise ops.AgentOpError("action invalide")
    except PermissionError as exc:
        return 403, {"error": str(exc)}
    except ops.AgentOpError as exc:
        return 400, {"error": str(exc)}
    except RuntimeError as exc:
        return 409, {"error": str(exc)}


def validate_controller_url(url: str, *, dev: bool) -> str:
    try:
        return proto.validate_controller_url(url, dev=dev)
    except ValueError as exc:
        raise ops.AgentOpError(str(exc)) from exc
