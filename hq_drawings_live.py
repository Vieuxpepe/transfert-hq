"""Édition partagée d'un dessin entre le pad et le PC : tête de document, révisions, présence.

Le hub ne remplace ni le fichier ni les brouillons : il garde en mémoire, par dessin ouvert, la dernière version
publiée et qui la regarde. Les règles tiennent en trois lignes :

* `publish` refuse une révision périmée (409) et renvoie la tête du serveur, pour que celui qui a édité hors ligne
  puisse mettre son travail de côté puis reprendre la version commune ;
* `poll` ne renvoie le document que si la révision a changé, donc l'appel de routine reste vide ;
* la présence (périphérique, sélection, curseur) expire d'elle-même : un pad endormi ne laisse pas de fantôme.

Rien n'est écrit sur disque ici : la sauvegarde du dessin et l'autosave restent les routes existantes.
"""

from __future__ import annotations

import json
import re
import threading
import time

PEER_TTL = 12.0  # secondes sans nouvelle d'un pair avant de le retirer de la présence
ROOM_TTL = 1800.0  # secondes sans personne avant d'oublier complètement un dessin
MAX_PEERS = 12
MAX_DOC_BYTES = 2_000_000
MAX_KEY = 120

KEY_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}")
CLIENT_RE = re.compile(r"[A-Za-z0-9_-]{1,40}")
ID_RE = re.compile(r"[A-Za-z0-9:_-]{1,40}")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")


class LiveError(Exception):
    def __init__(self, message: str, status: int = 400, payload: dict | None = None):
        super().__init__(message)
        self.status = status
        self.payload = payload or {}


def _now() -> float:
    return time.monotonic()


def clean_key(value) -> str:
    """A drawing key: the stem the rest of Dessiner already uses. No paths, no traversal."""
    if not isinstance(value, str):
        raise LiveError("Clé de dessin invalide")
    key = value.strip()
    if not KEY_RE.fullmatch(key) or ".." in key or key != key.strip():
        raise LiveError("Clé de dessin invalide")
    return key


def _client(value) -> str:
    if not isinstance(value, str) or not CLIENT_RE.fullmatch(value):
        raise LiveError("Identifiant de client invalide")
    return value


def _label(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise LiveError("Nom de périphérique invalide")
    return _CTRL_RE.sub("", value).strip()[:40]


def _sel(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 40:
        raise LiveError("Sélection invalide")
    out = []
    for item in value:
        if not isinstance(item, str) or not ID_RE.fullmatch(item):
            raise LiveError("Sélection invalide")
        out.append(item)
    return out


def _cursor(value):
    if value is None:
        return None
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise LiveError("Curseur invalide")
    x, y = value
    if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        raise LiveError("Curseur invalide")
    if abs(x) > 1e7 or abs(y) > 1e7:
        raise LiveError("Curseur invalide")
    return [float(x), float(y)]


class _Room:
    def __init__(self, key: str):
        self.key = key
        self.rev = 0
        self.doc = None
        self.by = ""
        self.at = _now()
        self.peers: dict[str, dict] = {}

    def prune_peers(self, now: float) -> None:
        for cid, peer in list(self.peers.items()):
            if now - peer["at"] > PEER_TTL:
                del self.peers[cid]

    def peer_list(self, me: str, now: float) -> list[dict]:
        self.prune_peers(now)
        out = []
        for cid, peer in self.peers.items():
            if cid == me:
                continue
            out.append({"client": cid, "name": peer["name"], "at": round(now - peer["at"], 3),
                        "sel": peer["sel"], "cursor": peer["cursor"]})
        out.sort(key=lambda p: p["client"])
        return out


_rooms: dict[str, _Room] = {}
_lock = threading.Lock()


def _room(key: str) -> _Room:
    room = _rooms.get(key)
    if room is None:
        if len(_rooms) >= 200:
            raise LiveError("Trop de dessins ouverts en même temps", 429)
        room = _rooms[key] = _Room(key)
    return room


def _forget_stale(now: float) -> None:
    for key, room in list(_rooms.items()):
        room.prune_peers(now)
        if not room.peers and now - room.at > ROOM_TTL:
            del _rooms[key]


def publish(key, doc, client, rev=None, name=None) -> dict:
    """Publier une nouvelle tête. `rev` est la révision sur laquelle le client a travaillé."""
    key = clean_key(key)
    cid = _client(client)
    label = _label(name)
    if not isinstance(doc, dict):
        raise LiveError("Document invalide")
    try:
        raw = json.dumps(doc, separators=(",", ":"))
    except (TypeError, ValueError):
        raise LiveError("Document invalide")
    if len(raw.encode("utf-8")) > MAX_DOC_BYTES:
        raise LiveError("Document trop volumineux", 413)
    now = _now()
    with _lock:
        _forget_stale(now)
        room = _room(key)
        if rev is not None:
            if isinstance(rev, bool) or not isinstance(rev, int) or rev < 0:
                raise LiveError("Révision invalide")
            if rev != room.rev:
                raise LiveError(
                    "Ce dessin a changé sur un autre appareil",
                    409,
                    {"key": key, "rev": room.rev, "doc": room.doc, "by": room.by,
                     "age": round(now - room.at, 3), "baseRev": rev},
                )
        room.rev += 1
        room.doc = doc
        room.by = label or cid
        room.at = now
        room.peers[cid] = {"name": label, "at": now, "sel": [], "cursor": None}
        return {"ok": True, "key": key, "rev": room.rev, "by": room.by, "peers": room.peer_list(cid, now)}


def poll(key, client, rev=None, name=None, sel=None, cursor=None) -> dict:
    """Sonder un dessin : sa tête si elle a bougé, et qui d'autre le regarde."""
    key = clean_key(key)
    cid = _client(client)
    label = _label(name)
    chosen = _sel(sel)
    point = _cursor(cursor)
    if rev is not None and (isinstance(rev, bool) or not isinstance(rev, int) or rev < 0):
        raise LiveError("Révision invalide")
    now = _now()
    with _lock:
        _forget_stale(now)
        room = _rooms.get(key)
        if room is not None and len(room.peers) >= MAX_PEERS and cid not in room.peers:
            room.prune_peers(now)
            if len(room.peers) >= MAX_PEERS:
                raise LiveError("Trop d'appareils sur ce dessin", 429)
        room = _room(key)
        room.peers[cid] = {"name": label, "at": now, "sel": chosen, "cursor": point}
        fresh = room.rev != (rev if rev is not None else 0)
        return {
            "ok": True,
            "key": key,
            "rev": room.rev,
            "changed": fresh and room.rev > 0,
            "doc": room.doc if fresh and room.rev > 0 else None,
            "by": room.by,
            "age": round(now - room.at, 3),
            "peers": room.peer_list(cid, now),
            "serverTime": round(time.time(), 3),
        }


def leave(key, client) -> dict:
    key = clean_key(key)
    cid = _client(client)
    with _lock:
        room = _rooms.get(key)
        if room is not None:
            room.peers.pop(cid, None)
            if not room.peers:
                room.at = _now()
        return {"ok": True, "key": key}


def status(key=None) -> dict:
    """Ce que le hub garde en mémoire, pour déboguer et pour les tests."""
    now = _now()
    with _lock:
        _forget_stale(now)
        if key is not None:
            room = _rooms.get(clean_key(key))
            if room is None:
                return {"ok": True, "key": key, "rev": 0, "peers": 0, "age": None}
            return {"ok": True, "key": room.key, "rev": room.rev, "by": room.by,
                    "peers": len(room.peers), "age": round(now - room.at, 3)}
        return {"ok": True, "rooms": [{"key": r.key, "rev": r.rev, "peers": len(r.peers)} for r in _rooms.values()]}


def reset() -> None:
    """Vider le hub (tests, ou redémarrage chaud du pont)."""
    with _lock:
        _rooms.clear()


def _error(exc: LiveError) -> tuple[int, dict]:
    """The HTTP body for a refused live request: the message, a stable code, and any recovery payload."""
    code = {400: "bad_request", 409: "conflict", 413: "too_large", 429: "too_many"}.get(exc.status, "error")
    body = {"error": str(exc), "code": code}
    body.update(exc.payload)
    return exc.status, body


def _one(qs: dict, name: str) -> str:
    """One query-string value (parse_qs returns lists); an absent key is the empty string."""
    value = qs.get(name)
    if isinstance(value, list):
        return str(value[0]) if value else ""
    return "" if value is None else str(value)


def _query_rev(qs: dict):
    raw = _one(qs, "rev")
    if not raw:
        return None
    if not re.fullmatch(r"\d{1,9}", raw):
        raise LiveError("Révision invalide")
    return int(raw)


def _query_sel(qs: dict):
    raw = _one(qs, "sel")
    if raw == "":
        return None
    return [part for part in raw.split(",") if part]


def _query_cursor(qs: dict):
    raw = _one(qs, "cursor")
    if raw == "":
        return None
    parts = raw.split(",")
    if len(parts) != 2:
        raise LiveError("Curseur invalide")
    try:
        return [float(parts[0]), float(parts[1])]
    except ValueError:
        raise LiveError("Curseur invalide") from None


def serve_get(qs: dict) -> tuple[int, dict]:
    """HTTP GET /api/drawings/live: parse the query and answer a poll (200) or a LiveError."""
    try:
        body = poll(
            _one(qs, "key"),
            _one(qs, "client"),
            rev=_query_rev(qs),
            name=_one(qs, "name"),
            sel=_query_sel(qs),
            cursor=_query_cursor(qs),
        )
    except LiveError as exc:
        return _error(exc)
    return 200, body


def serve_post(data: dict) -> tuple[int, dict]:
    """HTTP POST /api/drawings/live: publish a head (201) or return the LiveError status/body."""
    if not isinstance(data, dict):
        return 400, {"error": "Corps JSON invalide", "code": "bad_request"}
    try:
        body = publish(data.get("key"), data.get("doc"), data.get("client"), rev=data.get("rev"), name=data.get("name"))
    except LiveError as exc:
        return _error(exc)
    return 201, body
