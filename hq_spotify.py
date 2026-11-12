"""Transfert HQ Spotify Web API client (OAuth + playback + playlists).

Server-side only. Tokens never enter frontend assets, Git, or music profile JSON.
Does not call deprecated /v1/recommendations or /v1/audio-features endpoints.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode, quote
import base64
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request

import hq_state

STATE_FOLDER = ".hq-music"
TOKEN_FILE = "spotify_tokens.json"
OAUTH_PENDING_FILE = "oauth_pending.json"
API_BASE = "https://api.spotify.com/v1"
AUTH_BASE = "https://accounts.spotify.com"
DEFAULT_REDIRECT = "http://127.0.0.1:8765/api/spotify/callback"
SCOPES = (
    "user-read-playback-state "
    "user-modify-playback-state "
    "user-read-currently-playing "
    "playlist-read-private "
    "playlist-read-collaborative "
    "playlist-modify-public "
    "playlist-modify-private "
    "user-read-email "
    "user-read-private "
    "user-read-recently-played "
    "user-library-read "
    "user-top-read"
)
PLAYLIST_ID_RE = re.compile(r"^[A-Za-z0-9]{10,32}$")
_bound_root: Path | None = None
_config_getter: Callable[[], dict[str, Any]] | None = None
_oauth_lock = threading.RLock()
_memory_oauth: dict[str, Any] | None = None


class SpotifyError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "validation_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def bind(*, root: str | Path, config_getter: Callable[[], dict[str, Any]] | None = None) -> None:
    global _bound_root, _config_getter
    _bound_root = Path(os.path.abspath(os.fspath(root)))
    _config_getter = config_getter


def reset_for_tests() -> None:
    global _bound_root, _config_getter, _memory_oauth
    _bound_root = None
    _config_getter = None
    _memory_oauth = None


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _is_link(path: Path) -> bool:
    is_junction = getattr(os.path, "isjunction", None)
    return path.is_symlink() or bool(is_junction and is_junction(path))


def _path(filename: str) -> Path:
    if _bound_root is None:
        raise SpotifyError("Module Spotify non initialisé", 503, "storage_error")
    base = _bound_root / STATE_FOLDER
    file = base / filename
    if _is_link(base) or _is_link(file):
        raise SpotifyError("Emplacement Spotify redirigé — accès refusé", 503, "storage_error")
    if base.exists() and not base.is_dir():
        raise SpotifyError("Répertoire Musique invalide", 503, "storage_error")
    if file.exists() and not file.is_file():
        raise SpotifyError("Fichier Spotify invalide", 503, "storage_error")
    return file


def _cfg() -> dict[str, Any]:
    raw = _config_getter() if _config_getter else {}
    if not isinstance(raw, dict):
        raw = {}
    client_id = (
        os.environ.get("SPOTIFY_CLIENT_ID")
        or raw.get("spotify_client_id")
        or raw.get("SPOTIFY_CLIENT_ID")
        or ""
    )
    client_secret = (
        os.environ.get("SPOTIFY_CLIENT_SECRET")
        or raw.get("spotify_client_secret")
        or raw.get("SPOTIFY_CLIENT_SECRET")
        or ""
    )
    redirect = (
        os.environ.get("SPOTIFY_REDIRECT_URI")
        or raw.get("spotify_redirect_uri")
        or raw.get("SPOTIFY_REDIRECT_URI")
        or DEFAULT_REDIRECT
    )
    return {
        "client_id": str(client_id).strip(),
        "client_secret": str(client_secret).strip(),
        "redirect_uri": str(redirect).strip(),
    }


def configured() -> dict[str, Any]:
    cfg = _cfg()
    missing = []
    if not cfg["client_id"]:
        missing.append("spotify_client_id")
    if not cfg["redirect_uri"]:
        missing.append("spotify_redirect_uri")
    return {
        "configured": not missing,
        "missing": missing,
        "redirect_uri": cfg["redirect_uri"] if cfg["client_id"] else None,
        "has_client_secret": bool(cfg["client_secret"]),
        "pkce": True,
    }


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:128]
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


def _load_tokens() -> dict[str, Any] | None:
    file = _path(TOKEN_FILE)
    with hq_state.path_lock(file):
        if not file.exists():
            return None
        try:
            obj = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as exc:
            raise SpotifyError("Jetons Spotify illisibles — fichier conservé", 503, "storage_error") from exc
        if not isinstance(obj, dict):
            raise SpotifyError("Jetons Spotify invalides — fichier conservé", 503, "storage_error")
        return obj


def _write_tokens(value: dict[str, Any]) -> None:
    file = _path(TOKEN_FILE)
    file.parent.mkdir(parents=True, exist_ok=True)
    file = _path(TOKEN_FILE)
    hq_state.write_json_atomic(file, value)


def _clear_tokens() -> None:
    file = _path(TOKEN_FILE)
    with hq_state.path_lock(file):
        if file.exists():
            try:
                file.unlink()
            except OSError as exc:
                raise SpotifyError("Impossible de supprimer les jetons", 503, "storage_error") from exc


def _redact_email(email: str | None) -> str | None:
    if not isinstance(email, str) or "@" not in email:
        return None
    local, _, domain = email.partition("@")
    if not local:
        return f"***@{domain}"
    return f"{local[:1]}***@{domain}"


def _public_status(tokens: dict[str, Any] | None = None) -> dict[str, Any]:
    conf = configured()
    tokens = tokens if tokens is not None else _load_tokens()
    if not tokens or not tokens.get("access_token"):
        return {
            "ok": True,
            "connected": False,
            "configured": conf["configured"],
            "missing_config": conf["missing"],
            "redirect_uri": conf["redirect_uri"],
            "has_client_secret": conf["has_client_secret"],
            "scopes_requested": SCOPES,
        }
    profile = tokens.get("profile") if isinstance(tokens.get("profile"), dict) else {}
    return {
        "ok": True,
        "connected": True,
        "configured": conf["configured"],
        "missing_config": conf["missing"],
        "redirect_uri": conf["redirect_uri"],
        "display_name": profile.get("display_name"),
        "product": profile.get("product"),
        "email": _redact_email(profile.get("email")),
        "user_id": profile.get("id"),
        "scope": tokens.get("scope") or "",
        "expires_at": tokens.get("expires_at"),
        "connected_utc": tokens.get("connected_utc"),
    }


def status() -> dict[str, Any]:
    return _public_status()


def begin_auth() -> dict[str, Any]:
    conf = configured()
    if not conf["configured"]:
        raise SpotifyError(
            "Spotify non configuré — définir spotify_client_id (et redirect URI)",
            503,
            "not_configured",
        )
    cfg = _cfg()
    verifier, challenge = _pkce_pair()
    state = secrets.token_urlsafe(24)
    pending = {
        "state": state,
        "code_verifier": verifier,
        "created_at": time.time(),
        "redirect_uri": cfg["redirect_uri"],
    }
    with _oauth_lock:
        global _memory_oauth
        _memory_oauth = pending
        file = _path(OAUTH_PENDING_FILE)
        file.parent.mkdir(parents=True, exist_ok=True)
        hq_state.write_json_atomic(file, {"state": state, "code_verifier": verifier, "created_at": pending["created_at"], "redirect_uri": cfg["redirect_uri"]})
    params = {
        "client_id": cfg["client_id"],
        "response_type": "code",
        "redirect_uri": cfg["redirect_uri"],
        "scope": SCOPES,
        "state": state,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
    }
    return {
        "ok": True,
        "authorize_url": f"{AUTH_BASE}/authorize?{urlencode(params)}",
        "state": state,
        "redirect_uri": cfg["redirect_uri"],
    }


def _consume_pending(state: str) -> dict[str, Any]:
    if not isinstance(state, str) or not state:
        raise SpotifyError("État OAuth manquant", 400, "oauth_state_invalid")
    with _oauth_lock:
        global _memory_oauth
        pending = None
        if _memory_oauth and _memory_oauth.get("state") == state:
            pending = _memory_oauth
            _memory_oauth = None
        file = _path(OAUTH_PENDING_FILE)
        if pending is None and file.exists():
            try:
                obj = json.loads(file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                obj = None
            if isinstance(obj, dict) and obj.get("state") == state:
                pending = obj
        if file.exists():
            try:
                file.unlink()
            except OSError:
                pass
        if not pending:
            raise SpotifyError("État OAuth invalide ou expiré", 400, "oauth_state_invalid")
        age = time.time() - float(pending.get("created_at") or 0)
        if age > 600:
            raise SpotifyError("État OAuth expiré", 400, "oauth_state_expired")
        return pending


def _token_request(form: dict[str, str]) -> dict[str, Any]:
    cfg = _cfg()
    data = urlencode(form).encode("utf-8")
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    if cfg["client_secret"]:
        basic = base64.b64encode(f"{cfg['client_id']}:{cfg['client_secret']}".encode("utf-8")).decode("ascii")
        headers["Authorization"] = f"Basic {basic}"
    req = urllib.request.Request(f"{AUTH_BASE}/api/token", data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:400]
        raise SpotifyError(f"Échange de jeton Spotify échoué ({exc.code})", 502, "spotify_token_error") from exc
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        raise SpotifyError("Spotify inaccessible pour l'authentification", 502, "spotify_unreachable") from exc
    if not isinstance(payload, dict) or not payload.get("access_token"):
        raise SpotifyError("Réponse jeton Spotify invalide", 502, "spotify_token_error")
    return payload


def complete_auth(code: str, state: str) -> dict[str, Any]:
    if not isinstance(code, str) or not code.strip():
        raise SpotifyError("Code d'autorisation manquant", 400, "oauth_code_missing")
    pending = _consume_pending(state)
    cfg = _cfg()
    form = {
        "grant_type": "authorization_code",
        "code": code.strip(),
        "redirect_uri": pending.get("redirect_uri") or cfg["redirect_uri"],
        "client_id": cfg["client_id"],
        "code_verifier": str(pending.get("code_verifier") or ""),
    }
    payload = _token_request(form)
    expires_in = int(payload.get("expires_in") or 3600)
    tokens = {
        "access_token": payload["access_token"],
        "refresh_token": payload.get("refresh_token"),
        "token_type": payload.get("token_type") or "Bearer",
        "scope": payload.get("scope") or SCOPES,
        "expires_at": time.time() + max(30, expires_in - 30),
        "connected_utc": _utcnow(),
        "profile": {},
    }
    _write_tokens(tokens)
    try:
        profile = api_request("GET", "/me")
        if isinstance(profile, dict) and profile.get("ok") is not False:
            tokens = _load_tokens() or tokens
            tokens["profile"] = {
                "id": profile.get("id"),
                "display_name": profile.get("display_name"),
                "email": profile.get("email"),
                "product": profile.get("product"),
                "country": profile.get("country"),
            }
            _write_tokens(tokens)
    except SpotifyError:
        pass
    return _public_status()


def disconnect() -> dict[str, Any]:
    _clear_tokens()
    with _oauth_lock:
        global _memory_oauth
        _memory_oauth = None
        file = _path(OAUTH_PENDING_FILE)
        if file.exists():
            try:
                file.unlink()
            except OSError:
                pass
    return {"ok": True, "connected": False}


def _refresh_tokens(tokens: dict[str, Any]) -> dict[str, Any]:
    refresh = tokens.get("refresh_token")
    if not isinstance(refresh, str) or not refresh:
        raise SpotifyError("Session Spotify expirée — reconnecte-toi", 401, "spotify_reauth_required")
    cfg = _cfg()
    form = {
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": cfg["client_id"],
    }
    payload = _token_request(form)
    expires_in = int(payload.get("expires_in") or 3600)
    updated = dict(tokens)
    updated["access_token"] = payload["access_token"]
    if payload.get("refresh_token"):
        updated["refresh_token"] = payload["refresh_token"]
    updated["scope"] = payload.get("scope") or tokens.get("scope")
    updated["expires_at"] = time.time() + max(30, expires_in - 30)
    updated["refreshed_utc"] = _utcnow()
    _write_tokens(updated)
    return updated


def _access_token() -> str:
    tokens = _load_tokens()
    if not tokens or not tokens.get("access_token"):
        raise SpotifyError("Spotify non connecté", 401, "spotify_not_connected")
    expires_at = float(tokens.get("expires_at") or 0)
    if expires_at and time.time() >= expires_at:
        tokens = _refresh_tokens(tokens)
    return str(tokens["access_token"])


def api_request(
    method: str,
    path: str,
    *,
    query: dict[str, Any] | None = None,
    body: dict[str, Any] | list[Any] | None = None,
    retry_429: bool = True,
    _retried_auth: bool = False,
) -> Any:
    if not path.startswith("/"):
        path = "/" + path
    token = _access_token()
    url = API_BASE + path
    if query:
        clean = {k: v for k, v in query.items() if v is not None and v != ""}
        if clean:
            url += "?" + urlencode({k: str(v) for k, v in clean.items()})
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read()
            if resp.status == 204 or not raw:
                return {"ok": True}
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read().decode("utf-8", errors="replace")
        except Exception:
            raw = ""
        detail = ""
        try:
            err_obj = json.loads(raw) if raw else {}
            if isinstance(err_obj, dict):
                error = err_obj.get("error")
                if isinstance(error, dict):
                    detail = str(error.get("message") or "")[:240]
                elif isinstance(error, str):
                    detail = error[:240]
        except ValueError:
            detail = raw[:240]
        if exc.code == 401 and not _retried_auth:
            tokens = _load_tokens()
            if tokens:
                _refresh_tokens(tokens)
                return api_request(method, path, query=query, body=body, retry_429=retry_429, _retried_auth=True)
        if exc.code == 429 and retry_429:
            retry_after = exc.headers.get("Retry-After")
            try:
                wait = min(2.0, max(0.2, float(retry_after or "1")))
            except ValueError:
                wait = 1.0
            time.sleep(wait)
            return api_request(method, path, query=query, body=body, retry_429=False, _retried_auth=_retried_auth)
        code = {
            401: "spotify_unauthorized",
            403: "spotify_forbidden",
            404: "spotify_not_found",
            429: "spotify_rate_limited",
        }.get(exc.code, "spotify_api_error")
        message = detail or f"Erreur Spotify ({exc.code})"
        if exc.code == 403 and "premium" in message.lower():
            code = "spotify_premium_required"
        raise SpotifyError(message, exc.code if exc.code in (401, 403, 404, 429) else 502, code) from exc
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise SpotifyError("Spotify inaccessible", 502, "spotify_unreachable") from exc


def get_player() -> dict[str, Any]:
    data = api_request("GET", "/me/player")
    if data == {"ok": True} or data is None or data == {}:
        return {"ok": True, "playing": False, "item": None, "device": None}
    item = data.get("item") if isinstance(data, dict) else None
    track = None
    if isinstance(item, dict):
        artists = [a.get("name") for a in (item.get("artists") or []) if isinstance(a, dict)]
        images = (item.get("album") or {}).get("images") if isinstance(item.get("album"), dict) else []
        image = images[0].get("url") if isinstance(images, list) and images and isinstance(images[0], dict) else None
        track = {
            "id": item.get("id"),
            "uri": item.get("uri"),
            "name": item.get("name"),
            "artists": [a for a in artists if a],
            "album": (item.get("album") or {}).get("name") if isinstance(item.get("album"), dict) else None,
            "duration_ms": item.get("duration_ms"),
            "image": image,
        }
    device = data.get("device") if isinstance(data.get("device"), dict) else None
    return {
        "ok": True,
        "playing": bool(data.get("is_playing")),
        "progress_ms": data.get("progress_ms"),
        "shuffle_state": data.get("shuffle_state"),
        "repeat_state": data.get("repeat_state"),
        "item": track,
        "device": {
            "id": device.get("id"),
            "name": device.get("name"),
            "type": device.get("type"),
            "is_active": device.get("is_active"),
            "volume_percent": device.get("volume_percent"),
        } if device else None,
        "raw_context": data.get("context"),
    }


def list_devices() -> dict[str, Any]:
    data = api_request("GET", "/me/player/devices")
    devices = data.get("devices") if isinstance(data, dict) else []
    out = []
    for d in devices or []:
        if not isinstance(d, dict):
            continue
        out.append({
            "id": d.get("id"),
            "name": d.get("name"),
            "type": d.get("type"),
            "is_active": d.get("is_active"),
            "is_restricted": d.get("is_restricted"),
            "volume_percent": d.get("volume_percent"),
            "supports_volume": d.get("supports_volume"),
        })
    return {"ok": True, "devices": out}


def get_queue() -> dict[str, Any]:
    data = api_request("GET", "/me/player/queue")
    def slim(item: Any) -> dict[str, Any] | None:
        if not isinstance(item, dict):
            return None
        artists = [a.get("name") for a in (item.get("artists") or []) if isinstance(a, dict)]
        return {
            "id": item.get("id"),
            "uri": item.get("uri"),
            "name": item.get("name"),
            "artists": [a for a in artists if a],
        }
    currently = slim(data.get("currently_playing")) if isinstance(data, dict) else None
    queue = []
    for item in (data.get("queue") if isinstance(data, dict) else []) or []:
        row = slim(item)
        if row:
            queue.append(row)
    return {"ok": True, "currently_playing": currently, "queue": queue[:50], "note": "Spotify n'autorise pas la réorganisation libre de la file via l'API publique."}


def player_action(action: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    params = params if isinstance(params, dict) else {}
    action = str(action or "").strip().lower()
    device_id = params.get("device_id")
    q = {"device_id": device_id} if device_id else None

    if action == "play":
        body: dict[str, Any] = {}
        if params.get("uris"):
            body["uris"] = list(params["uris"])[:100]
        elif params.get("context_uri"):
            body["context_uri"] = params["context_uri"]
            if params.get("offset") is not None:
                body["offset"] = params["offset"]
        if params.get("position_ms") is not None:
            body["position_ms"] = int(params["position_ms"])
        api_request("PUT", "/me/player/play", query=q, body=body or None)
    elif action == "pause":
        api_request("PUT", "/me/player/pause", query=q)
    elif action == "next":
        api_request("POST", "/me/player/next", query=q)
    elif action == "previous":
        api_request("POST", "/me/player/previous", query=q)
    elif action == "seek":
        position_ms = int(params.get("position_ms", 0))
        api_request("PUT", "/me/player/seek", query={**(q or {}), "position_ms": position_ms})
    elif action == "volume":
        volume = max(0, min(100, int(params.get("volume_percent", 50))))
        api_request("PUT", "/me/player/volume", query={**(q or {}), "volume_percent": volume})
    elif action == "shuffle":
        state = "true" if params.get("state", True) else "false"
        api_request("PUT", "/me/player/shuffle", query={**(q or {}), "state": state})
    elif action == "repeat":
        state = str(params.get("state") or "off")
        if state not in ("off", "track", "context"):
            raise SpotifyError("Mode repeat invalide")
        api_request("PUT", "/me/player/repeat", query={**(q or {}), "state": state})
    elif action == "transfer":
        if not device_id:
            raise SpotifyError("device_id requis pour le transfert")
        api_request("PUT", "/me/player", body={"device_ids": [device_id], "play": bool(params.get("play", False))})
    elif action in ("queue", "queue_add"):
        uri = params.get("uri")
        if not isinstance(uri, str) or not uri.startswith("spotify:"):
            raise SpotifyError("URI Spotify requis pour la file")
        api_request("POST", "/me/player/queue", query={**(q or {}), "uri": uri})
    else:
        raise SpotifyError(f"Action lecteur inconnue: {action}")
    return {"ok": True, "action": action}


def list_playlists(*, limit: int = 50, offset: int = 0, q: str | None = None) -> dict[str, Any]:
    limit = max(1, min(50, int(limit)))
    offset = max(0, int(offset))
    data = api_request("GET", "/me/playlists", query={"limit": limit, "offset": offset})
    items = []
    needle = (q or "").strip().casefold()
    for pl in (data.get("items") if isinstance(data, dict) else []) or []:
        if not isinstance(pl, dict):
            continue
        name = pl.get("name") or ""
        if needle and needle not in str(name).casefold() and needle not in str(pl.get("description") or "").casefold():
            continue
        images = pl.get("images") if isinstance(pl.get("images"), list) else []
        image = images[0].get("url") if images and isinstance(images[0], dict) else None
        owner = pl.get("owner") if isinstance(pl.get("owner"), dict) else {}
        items.append({
            "id": pl.get("id"),
            "name": name,
            "description": pl.get("description") or "",
            "tracks_total": (pl.get("tracks") or {}).get("total") if isinstance(pl.get("tracks"), dict) else None,
            "image": image,
            "uri": pl.get("uri"),
            "owner": owner.get("display_name") or owner.get("id"),
            "public": pl.get("public"),
            "collaborative": pl.get("collaborative"),
        })
    return {
        "ok": True,
        "items": items,
        "limit": limit,
        "offset": offset,
        "total": data.get("total") if isinstance(data, dict) else len(items),
        "next": data.get("next") if isinstance(data, dict) else None,
    }


def _playlist_id(value: str) -> str:
    pid = str(value or "").strip()
    if pid.startswith("spotify:playlist:"):
        pid = pid.split(":")[-1]
    if not PLAYLIST_ID_RE.match(pid):
        raise SpotifyError("Identifiant de playlist invalide")
    return pid


def _playlist_total(data: dict[str, Any]) -> int | None:
    for key in ("items", "tracks"):
        block = data.get(key)
        if isinstance(block, dict) and block.get("total") is not None:
            try:
                return int(block["total"])
            except (TypeError, ValueError):
                return None
    return None


def _row_track_object(row: dict[str, Any]) -> dict[str, Any] | None:
    """Support legacy PlaylistTrackObject.track and Feb-2026 items.items.item shapes."""
    legacy = row.get("track")
    if isinstance(legacy, dict):
        return legacy
    item = row.get("item")
    if isinstance(item, dict):
        nested = item.get("track")
        if isinstance(nested, dict):
            return nested
        # Development-mode schema: track metadata lives on `item`, with track=true flag.
        if nested is True or item.get("type") == "track" or str(item.get("uri") or "").startswith("spotify:track:"):
            return item
    return None


def get_playlist(playlist_id: str) -> dict[str, Any]:
    pid = _playlist_id(playlist_id)
    data = api_request("GET", f"/playlists/{pid}")
    images = data.get("images") if isinstance(data.get("images"), list) else []
    image = images[0].get("url") if images and isinstance(images[0], dict) else None
    return {
        "ok": True,
        "playlist": {
            "id": data.get("id"),
            "name": data.get("name"),
            "description": data.get("description") or "",
            "uri": data.get("uri"),
            "image": image,
            "tracks_total": _playlist_total(data) if isinstance(data, dict) else None,
            "owner": (data.get("owner") or {}).get("display_name"),
            "public": data.get("public"),
            "collaborative": data.get("collaborative"),
            "snapshot_id": data.get("snapshot_id"),
        },
    }


def get_playlist_tracks(playlist_id: str, *, limit: int = 50, offset: int = 0) -> dict[str, Any]:
    """Fetch playlist contents via /items (legacy /tracks is removed for new apps)."""
    pid = _playlist_id(playlist_id)
    limit = max(1, min(50, int(limit)))
    offset = max(0, int(offset))
    query = {"limit": limit, "offset": offset, "additional_types": "track"}
    try:
        data = api_request("GET", f"/playlists/{pid}/items", query=query)
    except SpotifyError as exc:
        # Older extended-quota apps may still only expose /tracks.
        if exc.status in (404, 405) or exc.code in {"spotify_not_found", "spotify_api_error"}:
            try:
                data = api_request("GET", f"/playlists/{pid}/tracks", query={"limit": limit, "offset": offset})
            except SpotifyError:
                raise exc from None
        elif exc.code == "spotify_forbidden":
            raise SpotifyError(
                "Playlist inaccessible — Spotify n'autorise le contenu que pour tes playlists "
                "(propriétaire ou collaborateur), pas les playlists publiques tierces.",
                403,
                "spotify_forbidden",
            ) from exc
        else:
            raise
    items = []
    for row in (data.get("items") if isinstance(data, dict) else []) or []:
        if not isinstance(row, dict):
            continue
        track = _row_track_object(row)
        if not isinstance(track, dict) or track.get("is_local"):
            continue
        if track.get("type") and track.get("type") != "track":
            continue
        artists = [a.get("name") for a in (track.get("artists") or []) if isinstance(a, dict)]
        artist_ids = [a.get("id") for a in (track.get("artists") or []) if isinstance(a, dict) and a.get("id")]
        images = (track.get("album") or {}).get("images") if isinstance(track.get("album"), dict) else []
        image = images[-1].get("url") if isinstance(images, list) and images and isinstance(images[-1], dict) else None
        items.append({
            "id": track.get("id"),
            "uri": track.get("uri"),
            "name": track.get("name"),
            "artists": [a for a in artists if a],
            "artist_ids": artist_ids,
            "album": (track.get("album") or {}).get("name") if isinstance(track.get("album"), dict) else None,
            "duration_ms": track.get("duration_ms"),
            "image": image,
            "added_at": row.get("added_at"),
        })
    return {
        "ok": True,
        "items": items,
        "limit": limit,
        "offset": offset,
        "total": data.get("total") if isinstance(data, dict) else len(items),
        "next": data.get("next") if isinstance(data, dict) else None,
    }


def create_playlist(name: str, *, description: str = "", public: bool = False) -> dict[str, Any]:
    if not isinstance(name, str) or not (1 <= len(name.strip()) <= 120):
        raise SpotifyError("Nom de playlist invalide")
    body = {"name": name.strip(), "description": str(description or "")[:300], "public": bool(public)}
    try:
        data = api_request("POST", "/me/playlists", body=body)
    except SpotifyError:
        # Fallback for older apps still on /users/{id}/playlists.
        me = api_request("GET", "/me")
        user_id = me.get("id")
        if not user_id:
            raise SpotifyError("Profil Spotify indisponible", 502, "spotify_api_error")
        data = api_request("POST", f"/users/{quote(str(user_id))}/playlists", body=body)
    return {"ok": True, "playlist": {"id": data.get("id"), "uri": data.get("uri"), "name": data.get("name")}}


def update_playlist(playlist_id: str, *, name: str | None = None, description: str | None = None, public: bool | None = None) -> dict[str, Any]:
    pid = _playlist_id(playlist_id)
    body: dict[str, Any] = {}
    if name is not None:
        if not isinstance(name, str) or not (1 <= len(name.strip()) <= 120):
            raise SpotifyError("Nom de playlist invalide")
        body["name"] = name.strip()
    if description is not None:
        body["description"] = str(description)[:300]
    if public is not None:
        body["public"] = bool(public)
    if not body:
        raise SpotifyError("Aucune modification")
    api_request("PUT", f"/playlists/{pid}", body=body)
    return {"ok": True, "playlist_id": pid}


def _playlist_mutate(method: str, playlist_id: str, *, body: dict[str, Any], legacy_body: dict[str, Any] | None = None) -> Any:
    """Prefer /items (current), fall back to /tracks for older Spotify apps."""
    pid = _playlist_id(playlist_id)
    try:
        return api_request(method, f"/playlists/{pid}/items", body=body)
    except SpotifyError as exc:
        if exc.status in (404, 405) or exc.code in {"spotify_not_found", "spotify_api_error"}:
            return api_request(method, f"/playlists/{pid}/tracks", body=legacy_body or body)
        raise


def add_tracks(playlist_id: str, uris: list[str], *, position: int | None = None) -> dict[str, Any]:
    if not isinstance(uris, list) or not uris:
        raise SpotifyError("URIs requis")
    clean = [u for u in uris if isinstance(u, str) and u.startswith("spotify:track:")][:100]
    if not clean:
        raise SpotifyError("Aucun URI de piste valide")
    body: dict[str, Any] = {"uris": clean}
    if position is not None:
        body["position"] = int(position)
    data = _playlist_mutate("POST", playlist_id, body=body)
    return {"ok": True, "snapshot_id": data.get("snapshot_id") if isinstance(data, dict) else None, "added": len(clean)}


def remove_tracks(playlist_id: str, tracks: list[dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(tracks, list) or not tracks:
        raise SpotifyError("Pistes à retirer requises")
    payload = []
    for item in tracks[:100]:
        if not isinstance(item, dict):
            continue
        uri = item.get("uri")
        if isinstance(uri, str) and uri.startswith("spotify:"):
            entry: dict[str, Any] = {"uri": uri}
            if isinstance(item.get("positions"), list):
                entry["positions"] = [int(p) for p in item["positions"][:100]]
            payload.append(entry)
    if not payload:
        raise SpotifyError("Aucune piste valide à retirer")
    data = _playlist_mutate(
        "DELETE",
        playlist_id,
        body={"tracks": payload},
        legacy_body={"tracks": payload},
    )
    return {"ok": True, "snapshot_id": data.get("snapshot_id") if isinstance(data, dict) else None}


def reorder_tracks(playlist_id: str, *, range_start: int, insert_before: int, range_length: int = 1) -> dict[str, Any]:
    data = _playlist_mutate(
        "PUT",
        playlist_id,
        body={
            "range_start": int(range_start),
            "insert_before": int(insert_before),
            "range_length": max(1, int(range_length)),
        },
    )
    return {"ok": True, "snapshot_id": data.get("snapshot_id") if isinstance(data, dict) else None}


def search(q: str, *, types: str = "track,artist,album,playlist", limit: int = 20, offset: int = 0) -> dict[str, Any]:
    if not isinstance(q, str) or not q.strip():
        raise SpotifyError("Requête de recherche requise")
    limit = max(1, min(50, int(limit)))
    offset = max(0, int(offset))
    data = api_request(
        "GET",
        "/search",
        query={"q": q.strip()[:200], "type": types, "limit": limit, "offset": offset},
    )
    def tracks(block: Any) -> list[dict[str, Any]]:
        out = []
        for item in (block.get("items") if isinstance(block, dict) else []) or []:
            if not isinstance(item, dict):
                continue
            artists = [a.get("name") for a in (item.get("artists") or []) if isinstance(a, dict)]
            out.append({
                "id": item.get("id"),
                "uri": item.get("uri"),
                "name": item.get("name"),
                "artists": [a for a in artists if a],
                "album": (item.get("album") or {}).get("name") if isinstance(item.get("album"), dict) else None,
            })
        return out

    def named(block: Any) -> list[dict[str, Any]]:
        out = []
        for item in (block.get("items") if isinstance(block, dict) else []) or []:
            if not isinstance(item, dict):
                continue
            images = item.get("images") if isinstance(item.get("images"), list) else []
            image = images[0].get("url") if images and isinstance(images[0], dict) else None
            out.append({
                "id": item.get("id"),
                "uri": item.get("uri"),
                "name": item.get("name"),
                "image": image,
                "type": item.get("type"),
            })
        return out

    return {
        "ok": True,
        "query": q.strip(),
        "tracks": tracks(data.get("tracks")) if isinstance(data, dict) else [],
        "artists": named(data.get("artists")) if isinstance(data, dict) else [],
        "albums": named(data.get("albums")) if isinstance(data, dict) else [],
        "playlists": named(data.get("playlists")) if isinstance(data, dict) else [],
    }


def collect_playlist_tracks(playlist_id: str, *, max_tracks: int = 400) -> list[dict[str, Any]]:
    """Paginated fetch for mixer assembly. Bounded to avoid runaway loads."""
    max_tracks = max(1, min(1000, int(max_tracks)))
    offset = 0
    out: list[dict[str, Any]] = []
    while len(out) < max_tracks:
        batch = get_playlist_tracks(playlist_id, limit=min(50, max_tracks - len(out)), offset=offset)
        items = batch.get("items") or []
        if not items:
            break
        out.extend(items)
        offset += len(items)
        total = batch.get("total")
        if total is not None and offset >= int(total):
            break
        if not batch.get("next"):
            break
    return out[:max_tracks]


def _first_qs(qs: dict[str, list[str]], key: str, default: str | None = None) -> str | None:
    values = qs.get(key) if isinstance(qs, dict) else None
    if not values:
        return default
    return values[0]


def http_get(path: str, query: dict[str, list[str]] | None = None) -> tuple[int, dict[str, Any]]:
    """Bridge must enforce admin session before dispatching."""
    qs = query or {}
    try:
        if path == "/api/spotify/status":
            return 200, status()
        if path == "/api/spotify/connect":
            return 200, begin_auth()
        if path == "/api/spotify/callback":
            code = _first_qs(qs, "code")
            state = _first_qs(qs, "state")
            error = _first_qs(qs, "error")
            if error:
                return 400, {"ok": False, "code": "oauth_denied", "error": error}
            result = complete_auth(str(code or ""), str(state or ""))
            result["redirect_hq"] = "/#musique"
            return 200, result
        if path == "/api/spotify/player":
            return 200, get_player()
        if path == "/api/spotify/devices":
            return 200, list_devices()
        if path == "/api/spotify/queue":
            return 200, get_queue()
        if path == "/api/spotify/playlists":
            return 200, list_playlists(
                limit=int(_first_qs(qs, "limit", "50") or 50),
                offset=int(_first_qs(qs, "offset", "0") or 0),
                q=_first_qs(qs, "q"),
            )
        if path.startswith("/api/spotify/playlists/") and path.endswith("/tracks"):
            pid = path[len("/api/spotify/playlists/"):-len("/tracks")]
            return 200, get_playlist_tracks(
                pid,
                limit=int(_first_qs(qs, "limit", "50") or 50),
                offset=int(_first_qs(qs, "offset", "0") or 0),
            )
        if path.startswith("/api/spotify/playlists/"):
            pid = path[len("/api/spotify/playlists/"):]
            if "/" in pid:
                return 404, {"ok": False, "code": "not_found", "error": "Route introuvable"}
            return 200, get_playlist(pid)
        if path == "/api/spotify/search":
            return 200, search(
                str(_first_qs(qs, "q") or ""),
                types=str(_first_qs(qs, "type", "track,artist,album,playlist")),
                limit=int(_first_qs(qs, "limit", "20") or 20),
                offset=int(_first_qs(qs, "offset", "0") or 0),
            )
        return 404, {"ok": False, "code": "not_found", "error": "Route introuvable"}
    except SpotifyError as exc:
        return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}
    except (TypeError, ValueError) as exc:
        return 400, {"ok": False, "code": "validation_error", "error": str(exc)[:200]}


def http_post(path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """Bridge MUST enforce admin session + CSRF."""
    try:
        if not isinstance(body, dict):
            raise SpotifyError("Corps JSON invalide")
        if path == "/api/spotify/disconnect":
            return 200, disconnect()
        if path == "/api/spotify/player":
            action = body.get("action")
            return 200, player_action(str(action or ""), body)
        if path == "/api/spotify/playlists":
            return 200, create_playlist(
                str(body.get("name") or ""),
                description=str(body.get("description") or ""),
                public=bool(body.get("public", False)),
            )
        if path.startswith("/api/spotify/playlists/") and path.endswith("/tracks"):
            pid = path[len("/api/spotify/playlists/"):-len("/tracks")]
            op = str(body.get("op") or body.get("action") or "add").lower()
            if op == "add":
                return 200, add_tracks(pid, body.get("uris") or [], position=body.get("position"))
            if op == "remove":
                return 200, remove_tracks(pid, body.get("tracks") or [])
            if op == "reorder":
                return 200, reorder_tracks(
                    pid,
                    range_start=int(body.get("range_start", 0)),
                    insert_before=int(body.get("insert_before", 0)),
                    range_length=int(body.get("range_length", 1) or 1),
                )
            raise SpotifyError("Opération tracks invalide")
        if path.startswith("/api/spotify/playlists/"):
            pid = path[len("/api/spotify/playlists/"):]
            if "/" in pid:
                return 404, {"ok": False, "code": "not_found", "error": "Route introuvable"}
            return 200, update_playlist(
                pid,
                name=body.get("name"),
                description=body.get("description"),
                public=body.get("public"),
            )
        if path == "/api/spotify/search":
            return 200, search(
                str(body.get("q") or ""),
                types=str(body.get("type") or "track,artist,album,playlist"),
                limit=int(body.get("limit") or 20),
                offset=int(body.get("offset") or 0),
            )
        return 404, {"ok": False, "code": "not_found", "error": "Route introuvable"}
    except SpotifyError as exc:
        return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}
    except (TypeError, ValueError) as exc:
        return 400, {"ok": False, "code": "validation_error", "error": str(exc)[:200]}
