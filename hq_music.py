"""Transfert HQ portable music foundation (adapted from Else-Static concepts).

NOT a Spotify API client. No OAuth, playback mutations, external search or LLM.
Import creates no files. Bind a trusted HQ root before use; enforce HQ session/CSRF
in the bridge BEFORE exposing http_post(). Uses Transfert's existing hq_state.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import copy
import json
import os
import re
import secrets
from urllib.parse import urlparse

import hq_state

STATE_FOLDER = ".hq-music"
PROFILE_FILE = "profile.json"
DISCOVERIES_FILE = "discoveries.json"
PRESETS_FILE = "presets.json"
FAVORITES_FILE = "favorites.json"
LAST_SESSION_FILE = "last_session.json"
MUSIC_KEYS = ("preferred_genres", "favorite_artists", "musical_patterns")
MUSIC_PROFILE_DEFAULT = {
    "preferred_genres": [],
    "favorite_artists": [],
    "musical_patterns": [],
    "feedback_history": [],
    "last_recommendation_utc": None,
}
DISCOVERY_STATUSES = {"new", "saved", "dismissed", "liked", "disliked"}
_bound_root: Path | None = None


class MusicError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "validation_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def bind(*, root: str | Path) -> None:
    """Trusted server-side filesystem root. Does not create state."""
    global _bound_root
    _bound_root = Path(os.path.abspath(os.fspath(root)))


def reset_for_tests() -> None:
    global _bound_root
    _bound_root = None


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _is_link(path: Path) -> bool:
    is_junction = getattr(os.path, "isjunction", None)
    return path.is_symlink() or bool(is_junction and is_junction(path))


def _path(filename: str) -> Path:
    if _bound_root is None:
        raise MusicError("Module Musique non initialisé", 503, "storage_error")
    base = _bound_root / STATE_FOLDER
    file = base / filename
    if _is_link(base) or _is_link(file):
        raise MusicError("Emplacement Musique redirigé — accès refusé", 503, "storage_error")
    if base.exists() and not base.is_dir():
        raise MusicError("Répertoire Musique invalide", 503, "storage_error")
    if file.exists() and not file.is_file():
        raise MusicError("Fichier Musique invalide", 503, "storage_error")
    return file


def _load(filename: str, default: dict[str, Any]) -> dict[str, Any]:
    file = _path(filename)
    with hq_state.path_lock(file):
        if not file.exists():
            return copy.deepcopy(default)
        try:
            obj = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as exc:
            raise MusicError("État Musique illisible — fichier conservé", 503, "storage_error") from exc
        if not isinstance(obj, dict):
            raise MusicError("État Musique invalide — fichier conservé", 503, "storage_error")
        return obj


def _write(filename: str, value: dict[str, Any]) -> None:
    file = _path(filename)
    file.parent.mkdir(parents=True, exist_ok=True)
    file = _path(filename)  # recheck after mkdir
    hq_state.write_json_atomic(file, value)


def _clean_list(raw: Any, name: str, max_items: int = 40) -> list[str]:
    if not isinstance(raw, list):
        raise MusicError(f"{name} doit être une liste")
    out, seen = [], set()
    for item in raw:
        if not isinstance(item, str):
            raise MusicError(f"{name}: valeur non textuelle")
        value = " ".join(item.strip().split())
        if not value or len(value) > 80 or any(ord(ch) < 32 for ch in value):
            raise MusicError(f"{name}: valeur invalide (1–80 caractères)")
        key = value.casefold()
        if key not in seen:
            seen.add(key)
            out.append(value)
    if len(out) > max_items:
        raise MusicError(f"{name}: maximum {max_items} éléments")
    return out


def normalize_music_profile(raw: Any) -> dict[str, Any]:
    """Else-Static's 5 music-profile fields, validated for HQ use."""
    if not isinstance(raw, dict):
        raw = {}
    result = copy.deepcopy(MUSIC_PROFILE_DEFAULT)
    for key in MUSIC_KEYS:
        result[key] = _clean_list(raw.get(key, []), key)
    history = raw.get("feedback_history", [])
    if not isinstance(history, list):
        raise MusicError("feedback_history doit être une liste")
    result["feedback_history"] = [x for x in history[-100:] if isinstance(x, dict)]
    last = raw.get("last_recommendation_utc")
    result["last_recommendation_utc"] = last if isinstance(last, str) and len(last) <= 40 else None
    return result


def get_profile() -> dict[str, Any]:
    obj = _load(PROFILE_FILE, {"version": 1, "music_profile": MUSIC_PROFILE_DEFAULT})
    return normalize_music_profile(obj.get("music_profile", {}))


def update_preferences(updates: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(updates, dict) or not updates:
        raise MusicError("Préférences requises")
    if any(key not in MUSIC_KEYS for key in updates):
        raise MusicError("Champs non autorisés")
    file = _path(PROFILE_FILE)
    with hq_state.path_lock(file):
        current = get_profile()
        for key, value in updates.items():
            current[key] = _clean_list(value, key)
        _write(PROFILE_FILE, {"version": 1, "updated_utc": _utcnow(), "music_profile": current})
    return current


def discovery_query(year: int | None = None) -> dict[str, Any]:
    """Portable counterpart of Else's daily music research query; no network request."""
    profile = get_profile()
    artists = profile["favorite_artists"]
    genres = profile["preferred_genres"]
    if not artists and not genres:
        return {"ready": False, "reason": "no_music_preferences"}
    year = year or datetime.now(timezone.utc).year
    target = artists[0] if artists else genres[0]
    query = (f"new tracks new release by {target} music {year}" if artists
             else f"new releases in {target} music {year} tracks")
    return {"ready": True, "target": target, "query": query,
            "original_cooldown_hours": 24, "original_max_search_results": 5}


def _validate_discovery(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise MusicError("Découverte invalide")
    title = item.get("title")
    artist = item.get("artist")
    if not isinstance(title, str) or not isinstance(artist, str):
        raise MusicError("Titre et artiste requis")
    title, artist = title.strip(), artist.strip()
    if not (1 <= len(title) <= 160 and 1 <= len(artist) <= 120):
        raise MusicError("Titre ou artiste invalide")
    url = item.get("source_url", "")
    if not isinstance(url, str) or len(url) > 1000:
        raise MusicError("URL source invalide")
    if url:
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
            raise MusicError("Lien source HTTPS requis")
    confidence = item.get("confidence", 0.5)
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        raise MusicError("Confiance invalide")
    confidence = float(confidence)
    if not 0 <= confidence <= 1:
        raise MusicError("Confiance hors plage")
    reason = item.get("reason", "")
    if not isinstance(reason, str) or len(reason) > 1000:
        raise MusicError("Raison invalide")
    date = item.get("release_date", "unknown")
    if not isinstance(date, str) or (date != "unknown" and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date)):
        raise MusicError("Date invalide")
    return {"id": "song-" + secrets.token_hex(8), "title": title, "artist": artist,
            "source_url": url, "confidence": round(confidence, 3),
            "reason": reason.strip(), "release_date": date, "status": "new",
            "discovered_utc": _utcnow()}


def get_discoveries() -> list[dict[str, Any]]:
    doc = _load(DISCOVERIES_FILE, {"version": 1, "discoveries": []})
    items = doc.get("discoveries", [])
    if not isinstance(items, list):
        raise MusicError("Découvertes corrompues — fichier conservé", 503, "storage_error")
    return items


def add_discoveries(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Stores supplied candidates. Doesn't validate real track existence or use Spotify."""
    if not isinstance(items, list) or len(items) > 8:
        raise MusicError("Maximum 8 découvertes par ajout")
    incoming = [_validate_discovery(x) for x in items]
    file = _path(DISCOVERIES_FILE)
    with hq_state.path_lock(file):
        existing = get_discoveries()
        seen = {(str(x.get("artist", "")).casefold(), str(x.get("title", "")).casefold()) for x in existing if isinstance(x, dict)}
        added = []
        for item in incoming:
            key = (item["artist"].casefold(), item["title"].casefold())
            if key not in seen:
                seen.add(key)
                existing.append(item)
                added.append(item)
        _write(DISCOVERIES_FILE, {"version": 1, "updated_utc": _utcnow(), "discoveries": existing[-120:]})
    return {"added": added, "total": len(existing[-120:])}


def set_discovery_status(song_id: str, status: str) -> dict[str, Any]:
    if not isinstance(song_id, str) or not isinstance(status, str) or status not in DISCOVERY_STATUSES:
        raise MusicError("Statut invalide")
    file = _path(DISCOVERIES_FILE)
    with hq_state.path_lock(file):
        items = get_discoveries()
        item = next((x for x in items if isinstance(x, dict) and x.get("id") == song_id), None)
        if item is None:
            raise MusicError("Découverte introuvable", 404, "not_found")
        item["status"] = status
        _write(DISCOVERIES_FILE, {"version": 1, "updated_utc": _utcnow(), "discoveries": items})
        return item


def record_feedback(artist: str, title: str, liked: bool, *, action: str | None = None) -> dict[str, Any]:
    if not isinstance(liked, bool) and action is None:
        raise MusicError("liked doit être booléen")
    if not all(isinstance(v, str) and 1 <= len(v.strip()) <= 120 for v in (artist, title)):
        raise MusicError("Artiste et titre requis")
    if action is not None:
        if action not in {"like", "dislike", "save", "dismiss"}:
            raise MusicError("Action feedback invalide")
        liked = action in {"like", "save"}
    file = _path(PROFILE_FILE)
    with hq_state.path_lock(file):
        profile = get_profile()
        entry = {
            "artist": artist.strip(),
            "title": title.strip(),
            "liked": bool(liked),
            "action": action or ("like" if liked else "dislike"),
            "at_utc": _utcnow(),
        }
        profile["feedback_history"] = (profile["feedback_history"] + [entry])[-100:]
        if liked and artist.strip() not in profile["favorite_artists"]:
            # Soft learning: liked artists become favorites unless list is full.
            try:
                profile["favorite_artists"] = _clean_list(profile["favorite_artists"] + [artist.strip()], "favorite_artists")
            except MusicError:
                pass
        _write(PROFILE_FILE, {"version": 1, "updated_utc": _utcnow(), "music_profile": profile})
        return entry


def get_favorites() -> dict[str, Any]:
    doc = _load(FAVORITES_FILE, {"version": 1, "tracks": [], "artists": [], "playlists": []})
    return {
        "tracks": [x for x in (doc.get("tracks") or []) if isinstance(x, dict)][-100:],
        "artists": [x for x in (doc.get("artists") or []) if isinstance(x, dict)][-80:],
        "playlists": [x for x in (doc.get("playlists") or []) if isinstance(x, dict)][-80:],
    }


def update_favorites(updates: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(updates, dict):
        raise MusicError("Favoris invalides")
    file = _path(FAVORITES_FILE)
    with hq_state.path_lock(file):
        current = get_favorites()
        for key in ("tracks", "artists", "playlists"):
            if key not in updates:
                continue
            raw = updates[key]
            if not isinstance(raw, list):
                raise MusicError(f"{key} doit être une liste")
            cleaned = []
            seen = set()
            for item in raw[:100]:
                if not isinstance(item, dict):
                    continue
                item_id = str(item.get("id") or item.get("uri") or "").strip()
                if not item_id or item_id in seen:
                    continue
                seen.add(item_id)
                cleaned.append({
                    "id": item_id,
                    "uri": item.get("uri") if isinstance(item.get("uri"), str) else None,
                    "name": str(item.get("name") or item_id)[:160],
                    "artists": item.get("artists") if isinstance(item.get("artists"), list) else [],
                })
            current[key] = cleaned
        _write(FAVORITES_FILE, {"version": 1, "updated_utc": _utcnow(), **current})
        return current


def get_presets() -> list[dict[str, Any]]:
    import hq_music_mixer
    doc = _load(PRESETS_FILE, {"version": 1, "presets": []})
    stored = [x for x in (doc.get("presets") or []) if isinstance(x, dict)]
    if stored:
        return stored
    # Seed defaults on first write only when saving; reads return builtins without writing.
    return hq_music_mixer.list_builtin_presets()


def save_presets(presets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(presets, list) or len(presets) > 40:
        raise MusicError("Liste de préréglages invalide")
    cleaned = []
    seen = set()
    for item in presets:
        if not isinstance(item, dict):
            raise MusicError("Préréglage invalide")
        pid = str(item.get("id") or secrets.token_hex(6)).strip()
        name = str(item.get("name") or "").strip()
        if not name or len(name) > 80 or pid in seen:
            raise MusicError("Préréglage invalide")
        seen.add(pid)
        sources = item.get("sources") if isinstance(item.get("sources"), list) else []
        config = item.get("config") if isinstance(item.get("config"), dict) else {}
        cleaned.append({"id": pid, "name": name, "sources": sources[:20], "config": config})
    _write(PRESETS_FILE, {"version": 1, "updated_utc": _utcnow(), "presets": cleaned})
    return cleaned


def upsert_preset(preset: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(preset, dict):
        raise MusicError("Préréglage invalide")
    presets = get_presets()
    # If still on builtins (no file), materialize them then upsert.
    file = _path(PRESETS_FILE)
    if not file.exists():
        presets = save_presets(presets)
    pid = str(preset.get("id") or secrets.token_hex(6))
    name = str(preset.get("name") or "").strip()
    if not name:
        raise MusicError("Nom de préréglage requis")
    entry = {
        "id": pid,
        "name": name[:80],
        "sources": preset.get("sources") if isinstance(preset.get("sources"), list) else [],
        "config": preset.get("config") if isinstance(preset.get("config"), dict) else {},
    }
    out = []
    replaced = False
    for item in presets:
        if item.get("id") == pid:
            out.append(entry)
            replaced = True
        else:
            out.append(item)
    if not replaced:
        out.append(entry)
    save_presets(out)
    return entry


def delete_preset(preset_id: str) -> dict[str, Any]:
    if not isinstance(preset_id, str) or not preset_id.strip():
        raise MusicError("Identifiant préréglage requis")
    presets = [p for p in get_presets() if p.get("id") != preset_id]
    save_presets(presets)
    return {"deleted": preset_id}


def get_last_session() -> dict[str, Any] | None:
    doc = _load(LAST_SESSION_FILE, {"version": 1, "session": None})
    session = doc.get("session")
    return session if isinstance(session, dict) else None


def store_last_session(session: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(session, dict):
        raise MusicError("Session invalide")
    slim = {
        "seed": session.get("seed"),
        "tracks": (session.get("tracks") or [])[:100],
        "compromises": session.get("compromises") or [],
        "stats": session.get("stats") or {},
        "saved_utc": _utcnow(),
    }
    _write(LAST_SESSION_FILE, {"version": 1, "session": slim})
    return slim


def generate_session_from_body(body: dict[str, Any]) -> dict[str, Any]:
    """Assemble mixer inputs; optional Spotify track fetch via hq_spotify.collect_playlist_tracks."""
    import hq_music_mixer
    sources_in = body.get("sources")
    if not isinstance(sources_in, list) or not sources_in:
        raise MusicError("sources requis")
    assembled = []
    for raw in sources_in[:12]:
        if not isinstance(raw, dict):
            raise MusicError("source invalide")
        tracks = raw.get("tracks")
        playlist_id = raw.get("playlist_id") or raw.get("id")
        if not isinstance(tracks, list) and playlist_id:
            try:
                import hq_spotify
                tracks = hq_spotify.collect_playlist_tracks(str(playlist_id), max_tracks=int(body.get("max_tracks_per_source") or 300))
            except Exception as exc:  # noqa: BLE001 — surface as music error
                raise MusicError(f"Impossible de charger la playlist {playlist_id}: {exc}") from exc
        assembled.append({
            "id": str(playlist_id or raw.get("id") or raw.get("name") or "source"),
            "name": str(raw.get("name") or playlist_id or "Source"),
            "weight": raw.get("weight", 1.0),
            "tracks": tracks if isinstance(tracks, list) else [],
        })
    config = body.get("config") if isinstance(body.get("config"), dict) else {}
    favorites = get_favorites()
    profile = get_profile()
    config = dict(config)
    config.setdefault("favorite_track_ids", [t.get("id") for t in favorites["tracks"] if t.get("id")])
    config.setdefault(
        "favorite_artists",
        list({*(profile.get("favorite_artists") or []), *[a.get("name") for a in favorites["artists"] if a.get("name")]}),
    )
    try:
        session = hq_music_mixer.generate_session(assembled, config)
    except hq_music_mixer.MixerError as exc:
        raise MusicError(str(exc), code=getattr(exc, "code", "validation_error")) from exc
    store_last_session(session)
    return session


def http_get(path: str) -> tuple[int, dict[str, Any]]:
    """Bridge must check session authorization before dispatching."""
    try:
        if path == "/api/music/profile":
            return 200, {"ok": True, "profile": get_profile()}
        if path == "/api/music/discoveries":
            return 200, {"ok": True, "discoveries": get_discoveries()}
        if path == "/api/music/discovery-query":
            return 200, {"ok": True, "suggestion": discovery_query()}
        if path == "/api/music/now-playing":
            from hq_music_smtc import get_now_playing
            return 200, {"ok": True, "system_media": get_now_playing()}
        if path == "/api/music/presets":
            return 200, {"ok": True, "presets": get_presets()}
        if path == "/api/music/favorites":
            return 200, {"ok": True, "favorites": get_favorites()}
        if path == "/api/music/session":
            return 200, {"ok": True, "session": get_last_session()}
        return 404, {"ok": False, "code": "not_found", "error": "Route introuvable"}
    except MusicError as exc:
        return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}


def http_post(path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """Bridge MUST enforce admin session + CSRF on every POST route."""
    try:
        if not isinstance(body, dict):
            raise MusicError("Corps JSON invalide")
        if path == "/api/music/profile":
            return 200, {"ok": True, "profile": update_preferences(body)}
        if path == "/api/music/discoveries":
            return 200, {"ok": True, **add_discoveries(body.get("items"))}
        if path == "/api/music/discovery-status":
            return 200, {"ok": True, "discovery": set_discovery_status(body.get("id"), body.get("status"))}
        if path == "/api/music/feedback":
            return 200, {
                "ok": True,
                "feedback": record_feedback(
                    body.get("artist"),
                    body.get("title"),
                    body.get("liked") if "liked" in body else False,
                    action=body.get("action"),
                ),
            }
        if path == "/api/music/presets":
            op = str(body.get("op") or "upsert").lower()
            if op == "replace":
                return 200, {"ok": True, "presets": save_presets(body.get("presets") or [])}
            if op == "delete":
                return 200, {"ok": True, **delete_preset(str(body.get("id") or ""))}
            return 200, {"ok": True, "preset": upsert_preset(body.get("preset") or body)}
        if path == "/api/music/favorites":
            return 200, {"ok": True, "favorites": update_favorites(body)}
        if path == "/api/music/session/generate":
            return 200, {"ok": True, "session": generate_session_from_body(body)}
        return 404, {"ok": False, "code": "not_found", "error": "Route introuvable"}
    except MusicError as exc:
        return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}

