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
TASTE_FILE = "musica_taste.json"
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


_notify: Any = None
_calendar: Any = None


def bind(*, root: str | Path, notify: Any = None, calendar: Any = None) -> None:
    """Trusted server-side filesystem root. Does not create state.

    ``notify(title, body)`` is HQ's opt-in notifier (Discord + web push); used only for release alerts the
    Master switched on. ``calendar(start, end)`` returns manual calendar events (read-only) for mood picks.
    Both are callbacks so this module never imports the bridge."""
    global _bound_root, _notify, _calendar
    _bound_root = Path(os.path.abspath(os.fspath(root)))
    if notify is not None:
        _notify = notify
    if calendar is not None:
        _calendar = calendar


def reset_for_tests() -> None:
    global _bound_root, _notify, _calendar
    _bound_root = None
    _notify = None
    _calendar = None


ALERTS_FILE = "alerts.json"


def get_alerts() -> dict[str, Any]:
    raw = _load(ALERTS_FILE, {})
    return {"releases": raw.get("releases") is True}


def set_alerts(body: dict[str, Any]) -> dict[str, Any]:
    releases = body.get("releases")
    if type(releases) is not bool:
        raise MusicError("Choix requis pour les alertes de sorties")
    raw = _load(ALERTS_FILE, {})
    raw["releases"] = releases
    _write(ALERTS_FILE, raw)
    return get_alerts()


def notify(title: str, body: str) -> bool:
    """Send through HQ's notifier when bound. Never raises."""
    if _notify is None:
        return False
    try:
        _notify(str(title)[:120], str(body)[:300])
        return True
    except Exception:  # noqa: BLE001
        return False


def mood_suggestion(now: datetime | None = None) -> dict[str, Any]:
    """Pick an activity session from today's calendar (local, no model call)."""
    now = now or datetime.now()
    day_end = now.replace(hour=23, minute=59, second=59, microsecond=0)
    events: list[dict[str, Any]] = []
    if _calendar is not None:
        try:
            events = [e for e in (_calendar(now.replace(hour=0, minute=0, second=0, microsecond=0), day_end) or [])
                      if isinstance(e, dict) and not e.get("all_day")]
        except Exception:  # noqa: BLE001 — a calendar problem must not break Musique
            events = []

    def bounds(event: dict[str, Any]) -> tuple[datetime, datetime] | None:
        try:
            start = datetime.fromisoformat(str(event.get("start")))
            end = datetime.fromisoformat(str(event.get("end") or event.get("start")))
        except ValueError:
            return None
        return start.replace(tzinfo=None), end.replace(tzinfo=None)

    timed = [(b, e) for e in events if (b := bounds(e))]
    remaining = [(b, e) for b, e in timed if b[1] > now]
    current = next(((b, e) for b, e in remaining if b[0] <= now), None)
    upcoming = sorted(((b, e) for b, e in remaining if b[0] > now), key=lambda x: x[0][0])
    nxt = upcoming[0] if upcoming else None
    gap = int((nxt[0][0] - now).total_seconds() // 60) if nxt else None
    count = len(timed)
    hour = now.hour
    info = {"events_today": count, "remaining": len(remaining),
            "next_event": {"title": str(nxt[1].get("title") or "")[:80], "start": nxt[0][0].strftime("%H:%M"),
                           "in_min": gap} if nxt else None}
    if current:
        return {**info, "activity": "concentration douce", "minutes": 30, "energy": "calme",
                "label": "Fond calme", "reason": f"« {str(current[1].get('title') or 'Un événement')[:60]} » est en cours."}
    if gap is not None and gap < 20:
        return {**info, "activity": "transition", "minutes": 15, "energy": "calme",
                "label": "Petite transition", "reason": f"Prochain événement dans {gap} min."}
    if count >= 3 and remaining:
        minutes = max(20, min(60, (gap or 45) - 5))
        return {**info, "activity": "coder concentration", "minutes": minutes, "energy": "posé",
                "label": f"Session focus {minutes} min", "reason": f"{count} événements aujourd’hui : garde le cap entre deux."}
    if any("sport" in str(e.get("title") or "").casefold() or e.get("category") == "sport" for _b, e in remaining):
        return {**info, "activity": "sport", "minutes": 45, "energy": "intense",
                "label": "Échauffement sport", "reason": "Une séance de sport est prévue aujourd’hui."}
    if hour < 10:
        return {**info, "activity": "réveil en douceur", "minutes": 30, "energy": "montée",
                "label": "Réveil 30 min", "reason": "Début de journée, agenda léger."}
    if hour >= 21:
        return {**info, "activity": "détente du soir", "minutes": 30, "energy": "calme",
                "label": "Détente du soir", "reason": "Fin de soirée, plus rien à l’agenda." if not remaining else "Soirée calme."}
    minutes = max(20, min(60, gap - 5)) if gap else 45
    return {**info, "activity": "coder", "minutes": minutes, "energy": "posé",
            "label": f"Session libre {minutes} min",
            "reason": "Agenda libre" + (f" jusqu’à {nxt[0][0].strftime('%H:%M')}." if nxt else " pour le reste de la journée.")}


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


def _taste_key(row: dict[str, Any]) -> tuple[str, str, str]:
    return (str(row.get("artist") or "").casefold(), str(row.get("title") or "").casefold(),
            str(row.get("kind") or "track"))


def _apply_taste_feedback(taste: dict[str, Any], row: dict[str, Any]) -> None:
    action = row.get("action")
    if action == "dismiss":
        return
    key = _taste_key(row)
    def same_track(item: dict[str, Any]) -> bool:
        if item.get("uri") and row.get("uri"):
            return item["uri"] == row["uri"]
        return _taste_key(item) == key

    already_rejected = any(same_track(item) for item in taste["rejected"])
    for field in ("loved", "rejected"):
        taste[field] = [item for item in taste[field] if not same_track(item)]
    field = "rejected" if action == "dislike" else "loved"
    taste[field] = (taste[field] + [row])[-500:]
    if action == "dislike" and row.get("kind", "track") == "track" and not already_rejected:
        taste["auto_undo"] = [a for a in taste["auto_undo"] if a != key[0]]


def get_taste() -> dict[str, Any]:
    doc = _load(TASTE_FILE, {})
    raw = doc.get("taste") if isinstance(doc.get("taste"), dict) else {}
    taste = {field: raw.get(field) if isinstance(raw.get(field), list) else [] for field in (
        "banned_artists", "loved", "rejected", "seen", "auto_undo",
    )}
    taste["history_sharing"] = raw.get("history_sharing") is not False
    if doc.get("version") != 2:
        for row in get_profile().get("feedback_history") or []:
            if isinstance(row, dict) and row.get("action") in {"like", "dislike", "save"}:
                _apply_taste_feedback(taste, row)
        for old, new in (("loved_uris", "loved"), ("rejected_uris", "rejected")):
            for uri in raw.get(old) or []:
                if isinstance(uri, str) and re.fullmatch(r"spotify:(track|album):[A-Za-z0-9]+", uri):
                    taste[new].append({"uri": uri, "title": "", "artist": "", "kind": uri.split(":")[1]})
    counts: dict[str, tuple[str, set[str]]] = {}
    for row in taste["rejected"]:
        artist, title, kind = _taste_key(row)
        if artist and title and kind == "track":
            counts.setdefault(artist, (row["artist"], set()))[1].add(row.get("uri") or title)
    taste["auto_excluded"] = [name for key, (name, titles) in counts.items()
                              if len(titles) >= 3 and key not in taste["auto_undo"]]
    return taste


def _save_taste(taste: dict[str, Any]) -> dict[str, Any]:
    _write(TASTE_FILE, {"version": 2, "updated_utc": _utcnow(),
                       "taste": {k: v for k, v in taste.items() if k != "auto_excluded"}})
    return get_taste()


def update_taste(body: dict[str, Any]) -> dict[str, Any]:
    with hq_state.path_lock(_path(TASTE_FILE)):
        taste = get_taste()
        if "history_sharing" in body:
            if not isinstance(body["history_sharing"], bool):
                raise MusicError("Choix de partage invalide")
            taste["history_sharing"] = body["history_sharing"]
        if "migrate_bans" in body:
            taste["banned_artists"] = _clean_list(
                taste["banned_artists"] + _clean_list(body["migrate_bans"], "Artistes bannis", 200),
                "Artistes bannis", 200,
            )
        if "ban" in body or "unban" in body:
            field = "ban" if "ban" in body else "unban"
            name = body[field]
            if not isinstance(name, str) or not name.strip() or len(name) > 120:
                raise MusicError("Nom d’artiste invalide")
            name = name.strip()
            existing = [a for a in taste["banned_artists"] if a.casefold() != name.casefold()]
            taste["banned_artists"] = (existing + [name])[-200:] if field == "ban" else existing
            if field == "unban" and any(a.casefold() == name.casefold() for a in taste["auto_excluded"]):
                taste["auto_undo"] = list(dict.fromkeys([*taste["auto_undo"], name.casefold()]))[-200:]
        if "seen" in body:
            uri = _taste_uri(body["seen"])
            if not uri:
                raise MusicError("Référence Spotify requise")
            taste["seen"] = list(dict.fromkeys([*taste["seen"], uri]))[-2000:]
        return _save_taste(taste)


def _taste_uri(uri: Any) -> str | None:
    if uri is None:
        return None
    if not isinstance(uri, str) or not re.fullmatch(r"spotify:(track|album):[A-Za-z0-9]+", uri):
        raise MusicError("Référence Spotify invalide")
    return uri


def discovery_query(year: int | None = None) -> dict[str, Any]:
    """Portable counterpart of Else's daily music research query; no network request."""
    profile = get_profile()
    artists = profile["favorite_artists"]
    genres = profile["preferred_genres"]
    if not artists and not genres:
        return {"ready": False, "reason": "no_music_preferences"}
    year = year or datetime.now(timezone.utc).year
    target = artists[0] if artists else genres[0]
    from hq_spotify import field_query

    query = f"{field_query('artist', target)} year:{year}" if artists else field_query("genre", target)
    return {"ready": True, "target": target, "query": query, "type": "album" if artists else "artist",
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
    if status in {"saved", "dismissed"}:
        source = urlparse(item.get("source_url") or "")
        parts = source.path.strip("/").split("/")
        if source.hostname == "open.spotify.com" and len(parts) == 2 and parts[0] in {"track", "album"}:
            kind, spotify_id = parts
            if re.fullmatch(r"[A-Za-z0-9]+", spotify_id):
                update_taste({"seen": f"spotify:{kind}:{spotify_id}"})
    return item


def record_feedback(artist: str, title: str, liked: bool, *, action: str | None = None, uri: str | None = None) -> dict[str, Any]:
    if not isinstance(liked, bool) and action is None:
        raise MusicError("liked doit être booléen")
    if not all(isinstance(v, str) and 1 <= len(v.strip()) <= maximum
               for v, maximum in ((artist, 120), (title, 160))):
        raise MusicError("Artiste et titre requis")
    if action is not None:
        if action not in {"like", "dislike", "save", "dismiss"}:
            raise MusicError("Action feedback invalide")
        liked = action in {"like", "save"}
    uri = _taste_uri(uri)
    file = _path(PROFILE_FILE)
    with hq_state.path_lock(_path(TASTE_FILE)), hq_state.path_lock(file):
        taste = get_taste()
        profile = get_profile()
        entry = {
            "uri": uri,
            "kind": uri.split(":")[1] if uri else "track",
            "artist": artist.strip(),
            "title": title.strip(),
            "liked": bool(liked),
            "action": action or ("like" if liked else "dislike"),
            "at_utc": _utcnow(),
        }
        _apply_taste_feedback(taste, entry)
        _save_taste(taste)
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
    energies: dict[str, int] = {}
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
        energy = raw.get("energy", 3)
        energies[assembled[-1]["id"]] = energy if type(energy) is int and 1 <= energy <= 5 else 3
    config = body.get("config") if isinstance(body.get("config"), dict) else {}
    favorites = get_favorites()
    profile = get_profile()
    config = dict(config)
    config.setdefault("favorite_track_ids", [t.get("id") for t in favorites["tracks"] if t.get("id")])
    config.setdefault(
        "favorite_artists",
        list({*(profile.get("favorite_artists") or []), *[a.get("name") for a in favorites["artists"] if a.get("name")]}),
    )
    taste = get_taste()
    existing = [x for x in (config.get("exclude_artists") or []) if isinstance(x, str)]
    config["exclude_artists"] = list(dict.fromkeys(existing + taste["banned_artists"] + taste["auto_excluded"]))
    config["favorite_track_ids"] = list(config["favorite_track_ids"] or []) + [
        row["uri"] for row in taste["loved"] if row.get("uri")
    ]
    config["disliked_tracks"] = taste["rejected"]
    try:
        session = hq_music_mixer.generate_session(assembled, config)
    except hq_music_mixer.MixerError as exc:
        raise MusicError(str(exc), code=getattr(exc, "code", "validation_error")) from exc
    curve = config.get("energy_curve") or "none"
    if curve not in ENERGY_CURVES:
        raise MusicError("Courbe d’énergie invalide")
    if curve != "none":
        session = apply_energy_curve(session, energies, curve, window=int(config.get("artist_window") or 0))
    store_last_session(session)
    return session


ENERGY_CURVES = ("none", "arc", "rise", "fall", "waves", "flat")


def _energy_target(curve: str, x: float) -> float:
    import math
    if curve == "arc":  # warm-up → peak around 65 % → cool-down
        return 1.5 + 3.5 * (x / 0.65) if x <= 0.65 else 5 - 3 * (x - 0.65) / 0.35
    if curve == "rise":
        return 1.5 + 3.5 * x
    if curve == "fall":
        return 5 - 3.5 * x
    if curve == "waves":
        return 3 + 1.8 * math.sin(2 * math.pi * 2 * x)
    return 3.0


def apply_energy_curve(session: dict[str, Any], energies: dict[str, int], curve: str, *, window: int = 0) -> dict[str, Any]:
    """Reorder picked tracks so their source energy (calme 1 → intense 5) follows ``curve``.

    Spotify no longer exposes audio-features to new apps, so energy is the Master's label on each source playlist.
    Greedy: each slot takes the closest remaining energy, avoiding an artist heard in the last ``window`` slots
    when another close candidate exists."""
    tracks = [dict(t) for t in session.get("tracks") or []]
    if len(tracks) < 3:
        return session
    for t in tracks:
        t["energy"] = energies.get(str(t.get("source_id")), 3)
    total = len(tracks)
    targets = [_energy_target(curve, i / max(1, total - 1)) for i in range(total)]
    # Rank matching: the calmest tracks take the lowest points of the curve, wherever they are.
    slots = sorted(range(total), key=lambda i: (targets[i], i))
    pool = sorted(range(total), key=lambda k: (tracks[k]["energy"], k))
    placed: list[dict[str, Any] | None] = [None] * total
    for slot, k in zip(slots, pool):
        placed[slot] = tracks[k]
    ordered = [t for t in placed if t is not None]
    # Within the same energy, keep the Mixer's order, then spread artists when a same-energy swap allows it.
    by_energy: dict[int, list[int]] = {}
    for i, t in enumerate(ordered):
        by_energy.setdefault(t["energy"], []).append(i)
    for energy, positions in by_energy.items():
        group = sorted((ordered[i] for i in positions), key=lambda t: tracks.index(t))
        for i, t in zip(positions, group):
            ordered[i] = t
    if window:
        names = lambda t: {a.casefold() for a in t.get("artists") or []}
        for i in range(total):
            recent = set().union(*(names(t) for t in ordered[max(0, i - window):i])) if i else set()
            if recent & names(ordered[i]):
                swap = next((j for j in range(i + 1, total) if ordered[j]["energy"] == ordered[i]["energy"]
                             and not recent & names(ordered[j])), None)
                if swap is not None:
                    ordered[i], ordered[swap] = ordered[swap], ordered[i]
    for i, t in enumerate(ordered):
        t["target_energy"] = round(targets[i], 2)
    for n, t in enumerate(ordered, start=1):
        t["position"] = n
    return {**session, "tracks": ordered, "energy_curve": curve}


def http_get(path: str) -> tuple[int, dict[str, Any]]:
    """Bridge must check session authorization before dispatching."""
    try:
        if path == "/api/music/studio/gifts":
            import hq_musica_gifts
            return 200, {"ok": True, "gift": hq_musica_gifts.reconcile(_bound_root)}
        if path == "/api/music/studio":
            import hq_music_studio
            try:
                return 200, {"ok": True, "jobs": hq_music_studio.list_jobs(_bound_root)}
            except hq_music_studio.StudioError as exc:
                return exc.status, {"ok": False, "code": "studio_error", "error": str(exc)}
        if path.startswith("/api/music/wrapped/") or path in ("/api/music/on-this-day", "/api/music/taste-map"):
            import hq_music_wrapped as wrapped
            from datetime import date as _date
            try:
                if path == "/api/music/on-this-day":
                    return 200, wrapped.on_this_day()
                if path == "/api/music/taste-map":
                    return 200, wrapped.taste_map()
                parts = path.removeprefix("/api/music/wrapped/").split("/")
                ref = _date.fromisoformat(parts[1]) if len(parts) > 1 and parts[1] else None
                return 200, wrapped.wrapped(parts[0], ref)
            except ValueError as exc:  # WrappedError and a malformed date both land here
                return getattr(exc, "status", 400), {"ok": False, "code": getattr(exc, "code", "validation_error"),
                                                      "error": str(exc)}
        if path.startswith("/api/music/journal-lookup/"):
            import hq_music_journal
            from urllib.parse import unquote
            name = unquote(path.removeprefix("/api/music/journal-lookup/"))[:120]
            return 200, hq_music_journal.lookup(artist=name)
        if path == "/api/music/journal" or path.startswith("/api/music/journal/"):
            import hq_music_journal
            month = path.rsplit("/", 1)[-1] if path.startswith("/api/music/journal/") else None
            return 200, {"ok": True, "recap": hq_music_journal.recap(month)}
        if path == "/api/music/alerts":
            return 200, {"ok": True, "alerts": get_alerts()}
        if path == "/api/music/mood":
            return 200, {"ok": True, "mood": mood_suggestion()}
        if path.startswith("/api/music/quiz/reaction/"):
            import hq_music_quiz
            return 200, hq_music_quiz.reaction_view(path.rsplit("/", 1)[-1])
        if path == "/api/music/quiz":
            import hq_music_quiz
            return 200, hq_music_quiz.status()
        if path == "/api/music/profile":
            return 200, {"ok": True, "profile": get_profile()}
        if path == "/api/music/taste":
            return 200, {"ok": True, "taste": get_taste()}
        if path == "/api/music/discoveries":
            return 200, {"ok": True, "discoveries": get_discoveries()}
        if path == "/api/music/discovery-query":
            return 200, {"ok": True, "suggestion": discovery_query()}
        if path == "/api/music/radar":
            from hq_music_radar import get_radar
            return 200, {"ok": True, **get_radar()}
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
        if path == "/api/music/studio/gift":
            import hq_musica_gifts
            return 202, {"ok": True, "gift": hq_musica_gifts.request(_bound_root)}
        if path == "/api/music/studio/gifts/settings":
            import hq_musica_gifts
            return 200, {"ok": True, "gift": hq_musica_gifts.settings(body.get("enabled"))}
        if path == "/api/music/studio/delete":
            import hq_music_studio
            try:
                return 200, {"ok": True, **hq_music_studio.delete(_bound_root, body.get("id"))}
            except hq_music_studio.StudioError as exc:
                return exc.status, {"ok": False, "code": "studio_error", "error": str(exc)}
        if path in ("/api/music/studio/pick", "/api/music/studio/library"):
            import hq_music_studio
            try:
                if path == "/api/music/studio/pick":
                    return 200, {"ok": True, "job": hq_music_studio.pick(_bound_root, body.get("id"), body.get("variant"))}
                copied = hq_music_studio.copy_to_library(_bound_root, body.get("id"))
                pinged = body.get("notify") is True and notify(
                    "Musica Studio", f"« {copied['title']} » est prêt dans Fichiers › Inbox › Musica Studio.")
                return 200, {"ok": True, **copied, "notified": pinged}
            except hq_music_studio.StudioError as exc:
                return exc.status, {"ok": False, "code": "studio_error", "error": str(exc)}
            except OSError as exc:
                return 503, {"ok": False, "code": "studio_error", "error": "Copie impossible : " + str(exc)[:120]}
        if path == "/api/music/studio/lyrics":
            from hq_musica import MusicaError, draft_lyrics
            try:
                return 200, draft_lyrics(body)
            except MusicaError as exc:
                return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}
        if path == "/api/music/studio/generate":
            import hq_music_studio
            try:
                return 202, {"ok": True, "job": hq_music_studio.start(_bound_root, body)}
            except hq_music_studio.StudioError as exc:
                return exc.status, {"ok": False, "code": "studio_error", "error": str(exc)}
        if path == "/api/music/journal/settings":
            import hq_music_journal
            return 200, {"ok": True, "settings": hq_music_journal.set_enabled(body.get("enabled"))}
        if path == "/api/music/journal/sync":
            import hq_music_journal
            return 200, {"ok": True, "sync": hq_music_journal.sync(force=True)}
        if path == "/api/music/alerts":
            return 200, {"ok": True, "alerts": set_alerts(body)}
        if path == "/api/music/deck":
            from hq_musica import MusicaError, discover_deck
            from hq_spotify import SpotifyError
            try:
                return 200, discover_deck(body.get("unknown_only"))
            except (MusicaError, SpotifyError) as exc:
                return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}
        if path == "/api/music/activity":
            from hq_musica import MusicaError, run_activity
            from hq_spotify import SpotifyError
            try:
                return 200, run_activity(body.get("activity"), body.get("minutes"), body.get("play"))
            except (MusicaError, SpotifyError) as exc:
                return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}
        if path in ("/api/music/quiz/start", "/api/music/quiz/next", "/api/music/quiz/answer"):
            import hq_music_quiz
            from hq_spotify import SpotifyError
            try:
                if path.endswith("/start"):
                    return 200, {"ok": True, **hq_music_quiz.start(body)}
                if path.endswith("/next"):
                    result = hq_music_quiz.next_round(body.get("id"))
                    return (200 if result.get("ok") else 409), result
                return 200, hq_music_quiz.answer(body.get("id"), body.get("choice"))
            except SpotifyError as exc:
                return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}
        if path == "/api/music/profile":
            return 200, {"ok": True, "profile": update_preferences(body)}
        if path == "/api/music/taste":
            if "history_sharing" in body:
                from hq_musica import update_settings
                return 200, {"ok": True, "taste": update_settings(body)}
            return 200, {"ok": True, "taste": update_taste(body)}
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
                    uri=body.get("uri"),
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
        if path == "/api/music/radar/run":
            from hq_music_radar import run
            from hq_spotify import SpotifyError
            try:
                return 200, {"ok": True, **run(force=body.get("force", True) is True)}
            except SpotifyError as exc:
                return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}
        if path == "/api/music/session/generate":
            return 200, {"ok": True, "session": generate_session_from_body(body)}
        return 404, {"ok": False, "code": "not_found", "error": "Route introuvable"}
    except MusicError as exc:
        return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}

