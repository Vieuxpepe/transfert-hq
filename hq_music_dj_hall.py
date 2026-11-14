"""DJ Musica — Le Tournoi's memory: hall of fame, all-time ranking and the rivalry with Musica.

Local only (``.hq-music/tournament-hall.json``). Every bracket match feeds the per-song record, every finished
tournament the hall of champions, and her secret pick against the Master's champion feeds the rivalry
(whoever wins it picks the theme of the next tournament).
"""
from __future__ import annotations

import threading
from datetime import datetime
from typing import Any

import hq_music as music

FILE = "tournament-hall.json"  # video game music (the original hall); other kinds have their own file
KINDS = ("games", "decade", "artists", "albums", "library", "daily")
KEEP_CHAMPIONS = 30
KEEP_RIVALRY = 12
_lock = threading.RLock()
_EMPTY: dict[str, Any] = {"played": 0, "songs": {}, "artists": {}, "champions": [],
                          "rivalry": {"musica": 0, "master": 0, "streak": {"who": None, "n": 0}, "history": [], "owner": None}}


def _file(kind: str) -> str:
    if kind not in KINDS:
        raise ValueError("Type de tournoi inconnu")
    return FILE if kind == "games" else f"tournament-hall-{kind}.json"


def _load(kind: str = "games") -> dict[str, Any]:
    doc = music._load(_file(kind), _EMPTY)
    for key, default in _EMPTY.items():
        if not isinstance(doc.get(key), type(default)):
            doc[key] = type(default)() if not isinstance(default, dict) else dict(default)
    rivalry = doc["rivalry"]
    for key, default in _EMPTY["rivalry"].items():
        rivalry.setdefault(key, default if not isinstance(default, (dict, list)) else type(default)(default))
    return doc


def _song(doc: dict[str, Any], key: str, name: str, artist: str, uri: str) -> dict[str, Any]:
    rec = doc["songs"].setdefault(key, {"name": name, "artist": artist, "uri": uri, "wins": 0, "losses": 0, "titles": 0, "finals": 0})
    rec.update(name=name, artist=artist, uri=uri)
    if len(doc["songs"]) > 600:  # keep the file bounded: forget the least significant songs
        weakest = sorted(doc["songs"], key=lambda k: _score(doc["songs"][k]))[:100]
        for k in weakest:
            doc["songs"].pop(k, None)
    return rec


def _artist(doc: dict[str, Any], artist: str) -> dict[str, Any] | None:
    if not artist:
        return None
    return doc["artists"].setdefault(artist.casefold(), {"name": artist, "finals": 0, "titles": 0})


def _score(rec: dict[str, Any]) -> float:
    return rec["wins"] - 0.5 * rec["losses"] + 3 * rec["titles"] + rec["finals"]


def record_match(winner: dict[str, Any], loser: dict[str, Any], *, final: bool, kind: str = "games") -> dict[str, Any]:
    """One bracket match: the songs' records, and in a final each artist's final count (returned for her comment)."""
    with _lock:
        doc = _load(kind)
        won = _song(doc, winner["key"], winner["name"], winner["artist"], winner["uri"])
        lost = _song(doc, loser["key"], loser["name"], loser["artist"], loser["uri"])
        won["wins"] += 1
        lost["losses"] += 1
        counts: dict[str, int] = {}
        if final:
            for rec, row in ((won, winner), (lost, loser)):
                rec["finals"] += 1
                art = _artist(doc, row["artist"])
                if art:
                    art["finals"] += 1
                    counts[row["artist"]] = art["finals"]
        music._write(_file(kind), doc)
        return {"finals": counts}


def artist_note(artist: str, kind: str = "games") -> dict[str, int]:
    """Finals reached and titles won by this composer/artist in earlier tournaments (for her commentary)."""
    with _lock:
        rec = _load(kind)["artists"].get((artist or "").casefold()) or {}
    return {"finals": int(rec.get("finals") or 0), "titles": int(rec.get("titles") or 0)}


def record_tournament(champion: dict[str, Any], *, angle: str, same_pick: bool, kind: str = "games") -> dict[str, Any]:
    """A finished tournament: the title, and the rivalry round (her secret pick won = a point for Musica)."""
    with _lock:
        doc = _load(kind)
        rec = _song(doc, champion["key"], champion["name"], champion["artist"], champion["uri"])
        rec["titles"] += 1
        art = _artist(doc, champion["artist"])
        if art:
            art["titles"] += 1
        doc["played"] += 1
        doc["champions"] = (doc["champions"] + [{"at": datetime.now().isoformat(timespec="minutes"), "angle": angle,
                                                 "name": champion["name"], "artist": champion["artist"], "uri": champion["uri"],
                                                 "pick_same": bool(same_pick)}])[-KEEP_CHAMPIONS:]
        rival = doc["rivalry"]
        who = "musica" if same_pick else "master"
        rival[who] = int(rival.get(who) or 0) + 1
        streak = rival.get("streak") or {}
        rival["streak"] = {"who": who, "n": int(streak.get("n") or 0) + 1 if streak.get("who") == who else 1}
        rival["history"] = (list(rival.get("history") or []) + [{"who": who, "name": champion["name"], "angle": angle}])[-KEEP_RIVALRY:]
        rival["owner"] = who  # the winner picks the theme of the next tournament
        music._write(_file(kind), doc)
        return rivalry_view(doc, kind)


def theme_owner(kind: str = "games") -> str | None:
    with _lock:
        return _load(kind)["rivalry"].get("owner")


def clear_owner(kind: str = "games") -> None:
    with _lock:
        doc = _load(kind)
        if doc["rivalry"].get("owner"):
            doc["rivalry"]["owner"] = None
            music._write(_file(kind), doc)


def rivalry_view(doc: dict[str, Any] | None = None, kind: str = "games") -> dict[str, Any]:
    rival = (doc or _load(kind))["rivalry"]
    return {"musica": int(rival.get("musica") or 0), "master": int(rival.get("master") or 0),
            "streak": rival.get("streak") or {"who": None, "n": 0}, "owner": rival.get("owner"),
            "recent": list(rival.get("history") or [])[-5:][::-1]}


def view(kind: str = "games") -> dict[str, Any]:
    with _lock:
        doc = _load(kind)
    songs = sorted(doc["songs"].values(), key=lambda r: (-_score(r), r["name"]))
    slim = lambda r: {k: r.get(k) for k in ("name", "artist", "uri", "wins", "losses", "titles", "finals")}
    out_most = sorted((r for r in doc["songs"].values() if r["losses"] >= 2), key=lambda r: (-r["losses"], r["name"]))
    artists = sorted((a for a in doc["artists"].values() if a["finals"]), key=lambda a: (-a["titles"], -a["finals"], a["name"]))
    return {"ok": True, "played": doc["played"], "champions": doc["champions"][-8:][::-1],
            "ranking": [slim(r) for r in songs[:10] if r["wins"] or r["titles"]],
            "most_eliminated": [slim(r) for r in out_most[:5]], "artists": artists[:5],
            "rivalry": rivalry_view(doc, kind), "kind": kind}
