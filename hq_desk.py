"""Second screen: the phone and the PC exchange small live messages through the bridge (drawing pad, Lecteur remote,
flick-to-send). In memory only: nothing is written to disk, and a restart simply empties the relay.

Two mailboxes, one per role (``pc``, ``phone``). A client long-polls its role's mailbox and receives the messages sent to
that role after the cursor it holds. Every open HQ tab is a client with its own random id; a tab publishes a small state
(what view is open, the drawing canvas size, what the Lecteur plays) so the other side knows what it can offer.

Bounded everywhere: message types are an allowlist, a message is at most ``MSG_BYTES`` of JSON, a mailbox keeps the last
``QUEUE_MAX`` messages for at most ``MSG_TTL`` seconds, a poll waits at most ``WAIT_MAX`` seconds, and at most ``CLIENTS_MAX``
clients are remembered per role. Auth, the admin role and CSRF are the bridge's job (every route here is admin-only).
"""

from __future__ import annotations

import json
import re
import threading
import time
from collections import deque

ROLES = ("pc", "phone")
TYPES = ("pad", "remote", "player", "flick", "ping", "ack")
MSG_BYTES = 16 * 1024
STATE_BYTES = 4 * 1024
SNAP_BYTES = 512 * 1024
SNAP_INTERVAL = 0.08  # one image per client at most ~12/s; the PC debounces at 150 ms
SNAP_MIMES = ("image/jpeg", "image/webp")
QUEUE_MAX = 400
MSG_TTL = 60.0
WAIT_MAX = 20.0
PEER_TTL = 35.0  # a client that has not polled for this long is gone (a poll lasts WAIT_MAX at most)
CLIENTS_MAX = 16
_CLIENT_RE = re.compile(r"^[0-9a-f]{8,32}$")
_MSG_ID_RE = re.compile(r"^[0-9a-z]{1,16}\Z")
SEEN_MAX = 800

_cond = threading.Condition()
_seq = 0
_snap_rev = 0
_queues: dict[str, deque] = {role: deque(maxlen=QUEUE_MAX) for role in ROLES}
_clients: dict[str, dict[str, dict]] = {role: {} for role in ROLES}  # role -> client id -> {seen, state}
_snaps: dict[str, dict] = {}  # pc client id -> {rev, mime, body, at}; one slot, replaced on each upload
_snap_next: dict[str, float] = {}
_seen: dict[tuple[str, str], float] = {}  # (sender, message id) -> time; retries are not delivered twice


class DeskError(ValueError):
    def __init__(self, message: str, code: str = "bad_request", status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def reset_for_tests() -> None:
    global _seq, _snap_rev
    with _cond:
        _seq = 0
        _snap_rev = 0
        for role in ROLES:
            _queues[role].clear()
            _clients[role].clear()
        _snaps.clear()
        _snap_next.clear()
        _seen.clear()
        _cond.notify_all()


def _role(value) -> str:
    if value not in ROLES:
        raise DeskError("Rôle invalide", "bad_role")
    return value


def _client(value) -> str:
    if not isinstance(value, str) or not _CLIENT_RE.match(value):
        raise DeskError("Client invalide", "bad_client")
    return value


def _size(obj) -> int:
    return len(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _prune(now: float) -> None:
    """Caller holds the lock."""
    for role in ROLES:
        q = _queues[role]
        while q and now - q[0]["t"] > MSG_TTL:
            q.popleft()
        clients = _clients[role]
        for cid in [c for c, v in clients.items() if now - v["seen"] > PEER_TTL]:
            del clients[cid]
    for key in [k for k, t in _seen.items() if now - t > MSG_TTL]:
        del _seen[key]


def _touch(role: str, client: str, now: float) -> None:
    clients = _clients[role]
    if client not in clients:
        if len(clients) >= CLIENTS_MAX:
            oldest = min(clients, key=lambda c: clients[c]["seen"])
            del clients[oldest]
        clients[client] = {"seen": now, "state": None}
    else:
        clients[client]["seen"] = now


def _peers(role: str, now: float) -> dict:
    """What the OTHER role looks like: online flag and the freshest published state."""
    other = "phone" if role == "pc" else "pc"
    live = [v for v in _clients[other].values() if now - v["seen"] <= PEER_TTL]
    states = [v for v in live if v["state"] is not None]
    best = max(states, key=lambda v: v["state_at"])["state"] if states else None
    return {"role": other, "online": bool(live), "count": len(live), "state": best}


def send(to, mtype, data, client) -> dict:
    to, client = _role(to), _client(client)
    if mtype not in TYPES:
        raise DeskError("Type inconnu", "bad_type")
    if not isinstance(data, dict):
        raise DeskError("data invalide", "bad_data")
    if _size(data) > MSG_BYTES:
        raise DeskError("Message trop grand", "too_large", 413)
    mid = data.get("id")
    if mid is not None and (not isinstance(mid, str) or not _MSG_ID_RE.match(mid)):
        raise DeskError("Identifiant invalide", "bad_id")
    global _seq
    now = time.time()
    with _cond:
        _prune(now)
        if isinstance(mid, str):
            key = (client, mid)
            if key in _seen and now - _seen[key] <= MSG_TTL:
                return {"ok": True, "seq": _seq, "dup": True}
            if len(_seen) >= SEEN_MAX:
                oldest = min(_seen, key=lambda k: _seen[k])
                del _seen[oldest]
            _seen[key] = now
        _seq += 1
        _queues[to].append({"seq": _seq, "t": now, "type": mtype, "data": data, "from": client})
        _cond.notify_all()
        return {"ok": True, "seq": _seq}


def publish(role, client, state) -> dict:
    role, client = _role(role), _client(client)
    if state is not None and not isinstance(state, dict):
        raise DeskError("state invalide", "bad_state")
    if state is not None and _size(state) > STATE_BYTES:
        raise DeskError("État trop grand", "too_large", 413)
    now = time.time()
    with _cond:
        _prune(now)
        _touch(role, client, now)
        _clients[role][client]["state"] = state
        _clients[role][client]["state_at"] = now
        _cond.notify_all()  # pollers of the other side learn the new peer state now
        return {"ok": True, "peer": _peers(role, now)}


def leave(role, client) -> dict:
    role, client = _role(role), _client(client)
    with _cond:
        _clients[role].pop(client, None)
        if role == "pc":
            _snaps.pop(client, None)
            _snap_next.pop(client, None)
        _cond.notify_all()
    return {"ok": True}


def _image_ok(mime: str, body: bytes) -> bool:
    if mime == "image/jpeg":
        return len(body) >= 3 and body.startswith(b"\xff\xd8\xff")
    if mime == "image/webp":
        return len(body) >= 12 and body.startswith(b"RIFF") and body[8:12] == b"WEBP"
    return False


def put_snapshot(client, mime, body, *, now=None) -> dict:
    """Replace this PC client's one in-memory image. ``rev`` increments globally so a pad can tell a new frame."""
    client = _client(client)
    if not isinstance(mime, str) or mime.split(";", 1)[0].strip().lower() not in SNAP_MIMES:
        raise DeskError("Type d'image invalide", "bad_type")
    mime = mime.split(";", 1)[0].strip().lower()
    if not isinstance(body, (bytes, bytearray)):
        raise DeskError("Image invalide", "bad_image")
    raw = bytes(body)
    if len(raw) > SNAP_BYTES:
        raise DeskError("Image trop grande", "too_large", 413)
    if not _image_ok(mime, raw):
        raise DeskError("Image invalide", "bad_image")
    global _snap_rev
    ts = time.time() if now is None else float(now)
    with _cond:
        prev = _snap_next.get(client, 0.0)
        if SNAP_INTERVAL and ts - prev < SNAP_INTERVAL:
            raise DeskError("Trop d'images", "rate", 429)
        if client not in _snaps and len(_snaps) >= CLIENTS_MAX:
            oldest = min(_snaps, key=lambda c: _snaps[c]["at"])
            _snaps.pop(oldest, None)
            _snap_next.pop(oldest, None)
        _snap_next[client] = ts
        _snap_rev += 1
        _snaps[client] = {"rev": _snap_rev, "mime": mime, "body": raw, "at": ts}
        return {"ok": True, "rev": _snap_rev}


def latest_snapshot() -> dict | None:
    with _cond:
        if not _snaps:
            return None
        best = max(_snaps.values(), key=lambda s: s["rev"])
        return {"rev": best["rev"], "mime": best["mime"], "body": best["body"]}


def poll(role, client, after, wait: float = WAIT_MAX, *, clock=time.time) -> dict:
    """Messages for ``role`` with seq > ``after``. ``after < 0`` starts fresh: no backlog, only the current cursor.
    Returns early when a message arrives or the peer's presence/state changes."""
    role, client = _role(role), _client(client)
    if isinstance(after, bool) or not isinstance(after, int):
        raise DeskError("after invalide", "bad_after")
    wait = max(0.0, min(float(wait), WAIT_MAX))
    with _cond:
        now = clock()
        _prune(now)
        _touch(role, client, now)
        if after < 0:
            return {"ok": True, "seq": _seq, "messages": [], "peer": _peers(role, now)}
        start_peer = _peers(role, now)
        deadline = now + wait
        while True:
            msgs = [m for m in _queues[role] if m["seq"] > after and m["from"] != client]
            peer = _peers(role, clock())
            if msgs or peer != start_peer:
                break
            left = deadline - clock()
            if left <= 0:
                break
            _cond.wait(timeout=min(left, 5.0))
            _touch(role, client, clock())
        out = [{"seq": m["seq"], "type": m["type"], "data": m["data"]} for m in msgs]
        # Under the lock every message of this mailbox up to _seq is either in `out` or not for this client: _seq is the cursor.
        return {"ok": True, "seq": _seq, "messages": out, "peer": peer}


def _int(qs, key, default):
    raw = (qs.get(key) or [None])[0]
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise DeskError(f"{key} invalide", "bad_" + key) from e


def http_get(raw: str, qs: dict) -> tuple[int, dict]:
    try:
        if raw == "/api/desk/poll":
            role = (qs.get("role") or [""])[0]
            client = (qs.get("client") or [""])[0]
            return 200, poll(role, client, _int(qs, "after", -1), float(_int(qs, "wait", int(WAIT_MAX))))
        if raw == "/api/desk/peer":
            role = _role((qs.get("role") or [""])[0])
            with _cond:
                now = time.time()
                _prune(now)
                return 200, {"ok": True, "peer": _peers(role, now)}
        return 404, {"error": "Inconnu", "code": "not_found"}
    except DeskError as e:
        return e.status, {"error": str(e), "code": e.code}


def http_post(raw: str, data: dict) -> tuple[int, dict]:
    try:
        if raw == "/api/desk/send":
            if set(data) - {"to", "type", "data", "client"}:
                raise DeskError("Champ inconnu", "bad_field")
            return 200, send(data.get("to"), data.get("type"), data.get("data"), data.get("client"))
        if raw == "/api/desk/state":
            if set(data) - {"role", "client", "state"}:
                raise DeskError("Champ inconnu", "bad_field")
            return 200, publish(data.get("role"), data.get("client"), data.get("state"))
        if raw == "/api/desk/leave":
            return 200, leave(data.get("role"), data.get("client"))
        return 404, {"error": "Inconnu", "code": "not_found"}
    except DeskError as e:
        return e.status, {"error": str(e), "code": e.code}
