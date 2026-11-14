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
import io
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request

import hq_state
import socket
import subprocess

STATE_FOLDER = ".hq-music"
TOKEN_FILE = "spotify_tokens.json"
OAUTH_PENDING_FILE = "oauth_pending.json"
API_BASE = "https://api.spotify.com/v1"
SEARCH_MAX_LIMIT = 10
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
# HQ CSP is img-src 'self' — covers must be same-origin proxied.
SPOTIFY_IMAGE_HOSTS = frozenset({
    "i.scdn.co",
    "mosaic.scdn.co",
    "charts-images.scdn.co",
    "lineup-images.scdn.co",
    "newjams-images.scdn.co",
    "daily-mix.scdn.co",
    "image-cdn-ak.spotifycdn.com",
    "image-cdn-fa.spotifycdn.com",
    "wrapped-images.spotifycdn.com",
    "seeded-session-images.spotifycdn.com",
    "thisis-images.spotifycdn.com",
    "mixed-media-images.spotifycdn.com",
    "pickasso.spotifycdn.com",
})
_IMAGE_CACHE: dict[str, tuple[float, str, bytes]] = {}
_IMAGE_CACHE_LOCK = threading.Lock()
_IMAGE_CACHE_MAX = 96
_IMAGE_CACHE_TTL_S = 6 * 60 * 60
_bound_root: Path | None = None
_config_getter: Callable[[], dict[str, Any]] | None = None
_oauth_lock = threading.RLock()
_memory_oauth: dict[str, Any] | None = None


class SpotifyError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "validation_error",
                 *, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after


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
            "local": local_spotify_probe(),
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
        "local": local_spotify_probe(),
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


def is_allowed_spotify_image_url(url: str) -> bool:
    try:
        from urllib.parse import urlparse as _urlparse
        parsed = _urlparse(url)
    except Exception:
        return False
    if parsed.scheme != "https" or not parsed.netloc:
        return False
    host = parsed.netloc.split("@")[-1].split(":")[0].casefold()
    return host in SPOTIFY_IMAGE_HOSTS


def proxied_image_url(url: str | None) -> str | None:
    """Rewrite Spotify CDN URLs to the same-origin cover proxy (CSP-safe)."""
    if not isinstance(url, str) or not url.strip():
        return None
    raw = url.strip()
    if raw.startswith("/api/spotify/image?"):
        return raw
    if not is_allowed_spotify_image_url(raw):
        return None
    return "/api/spotify/image?url=" + quote(raw, safe="")


def _resize_cover(raw: bytes, width: int) -> bytes | None:
    """Return a smaller JPEG cover, or None when Pillow is unavailable/no resize is needed."""
    try:
        from PIL import Image
    except Exception:
        return None
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        if image.width <= width and image.height <= width:
            return None
        image.thumbnail((width, width), Image.LANCZOS)
        out = io.BytesIO()
        image.save(out, "JPEG", quality=82, optimize=True, progressive=True)
        return out.getvalue()
    except Exception:
        return None


def fetch_cover_image(url: str, width: int | None = None) -> tuple[bytes, str]:
    """Fetch a Spotify CDN image for same-origin embedding. Returns (bytes, content_type)."""
    if not isinstance(url, str) or not is_allowed_spotify_image_url(url):
        raise SpotifyError("URL image Spotify non autorisée", 400, "spotify_image_forbidden")
    try:
        width = max(32, min(640, int(width))) if width else None
    except (TypeError, ValueError):
        width = None
    key = f"{url}|{width or 0}"
    now = time.time()
    with _IMAGE_CACHE_LOCK:
        hit = _IMAGE_CACHE.get(key)
        if hit and (now - hit[0]) < _IMAGE_CACHE_TTL_S:
            return hit[2], hit[1]
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "User-Agent": "TransfertHQ-Musique/1.0",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            raw = resp.read()
            if len(raw) > 2_500_000:
                raise SpotifyError("Image trop volumineuse", 502, "spotify_image_too_large")
            ctype = (resp.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip() or "image/jpeg"
            if not ctype.startswith("image/"):
                raise SpotifyError("Réponse image invalide", 502, "spotify_image_bad_type")
    except SpotifyError:
        raise
    except urllib.error.HTTPError as exc:
        raise SpotifyError(f"Image Spotify indisponible ({exc.code})", 502, "spotify_image_fetch_failed") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SpotifyError("Image Spotify inaccessible", 502, "spotify_image_unreachable") from exc
    if width:
        resized = _resize_cover(raw, width)
        if resized:
            raw = resized
            ctype = "image/jpeg"
    with _IMAGE_CACHE_LOCK:
        if len(_IMAGE_CACHE) >= _IMAGE_CACHE_MAX:
            # Drop oldest entries.
            for old_key, _ in sorted(_IMAGE_CACHE.items(), key=lambda kv: kv[1][0])[: max(1, _IMAGE_CACHE_MAX // 4)]:
                _IMAGE_CACHE.pop(old_key, None)
        _IMAGE_CACHE[key] = (now, ctype, raw)
    return raw, ctype


def api_request(
    method: str,
    path: str,
    *,
    query: dict[str, Any] | None = None,
    body: dict[str, Any] | list[Any] | None = None,
    retry_429: bool = True,
    _retried_auth: bool = False,
    timeout: float = 25,
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
        with urllib.request.urlopen(req, timeout=max(2.0, float(timeout))) as resp:
            raw = resp.read()
            if resp.status == 204 or not raw:
                return {"ok": True}
            try:
                return json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                # Spotify returns some successful write commands with an opaque
                # or empty body; a write that reached 2xx has already succeeded.
                if method.upper() in {"POST", "PUT", "PATCH", "DELETE"}:
                    return {"ok": True}
                raise
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
            403: "spotify_unavailable_endpoint",
            404: "spotify_unavailable_endpoint",
            429: "spotify_rate_limited",
        }.get(exc.code, "spotify_api_error")
        message = detail or f"Erreur Spotify ({exc.code})"
        unavailable = exc.code in (405, 410) or bool(re.search(
            r"endpoint.{0,35}(removed|deprecated|no longer available)|not supported in development mode",
            message, re.I,
        ))
        if unavailable:
            code = "spotify_unavailable_endpoint"
        if exc.code == 403 and "premium" in message.lower():
            code = "spotify_premium_required"
        elif code == "spotify_unavailable_endpoint" and "no active device" not in message.lower():
            message = "Cette fonction Spotify est indisponible pour ce compte ou cette application."
        retry_after = None
        if exc.code == 429:
            try:
                retry_after = max(1, int(exc.headers.get("Retry-After", "60")))
            except ValueError:
                retry_after = 60
        status = exc.code if exc.code in (401, 403, 404, 405, 410, 429) else 404 if unavailable else 502
        raise SpotifyError(message, status, code, retry_after=retry_after) from exc
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise SpotifyError("Spotify inaccessible", 502, "spotify_unreachable") from exc


def get_player() -> dict[str, Any]:
    # Short timeout: Lecture polls often; UI ticks progress locally between syncs.
    data = api_request("GET", "/me/player", timeout=8)
    if data == {"ok": True} or data is None or data == {}:
        return {"ok": True, "playing": False, "item": None, "device": None}
    item = data.get("item") if isinstance(data, dict) else None
    track = None
    if isinstance(item, dict):
        artists = [a.get("name") for a in (item.get("artists") or []) if isinstance(a, dict)]
        images = (item.get("album") or {}).get("images") if isinstance(item.get("album"), dict) else []
        # Keep the largest cover: the proxy downsizes per slot, while a small
        # source (often 300px) gets visibly soft in the 190px hero.
        image = None
        if isinstance(images, list):
            candidates = [x for x in images if isinstance(x, dict) and x.get("url")]
            if candidates:
                pick = max(candidates, key=lambda x: int(x.get("width") or 0))
                image = pick.get("url")
        track = {
            "id": item.get("id"),
            "uri": item.get("uri"),
            "name": item.get("name"),
            "artists": [a for a in artists if a],
            "album": (item.get("album") or {}).get("name") if isinstance(item.get("album"), dict) else None,
            "duration_ms": item.get("duration_ms"),
            "image": proxied_image_url(image if isinstance(image, str) else None),
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


def _hostname_tokens() -> list[str]:
    names = []
    for value in (socket.gethostname(), os.environ.get("COMPUTERNAME"), os.environ.get("HOSTNAME")):
        if isinstance(value, str) and value.strip():
            names.append(value.strip())
    # Deduplicate case-insensitively while keeping original casing for display.
    out: list[str] = []
    seen: set[str] = set()
    for name in names:
        key = name.casefold()
        if key not in seen:
            seen.add(key)
            out.append(name)
    return out


def _spotify_install_candidates() -> list[Path]:
    local = os.environ.get("LOCALAPPDATA") or ""
    appdata = os.environ.get("APPDATA") or ""
    program_files = os.environ.get("ProgramFiles") or r"C:\Program Files"
    program_files_x86 = os.environ.get("ProgramFiles(x86)") or r"C:\Program Files (x86)"
    candidates = [
        Path(appdata) / "Spotify" / "Spotify.exe" if appdata else None,
        Path(local) / "Microsoft" / "WindowsApps" / "Spotify.exe" if local else None,
        Path(program_files) / "Spotify" / "Spotify.exe",
        Path(program_files_x86) / "Spotify" / "Spotify.exe",
    ]
    return [p for p in candidates if p is not None]


def local_spotify_probe() -> dict[str, Any]:
    """Detect Spotify Desktop on this Windows host (process + install path).

    Important: Windows WASAPI/DirectSound endpoints are NOT Spotify Connect targets.
    Only a running Spotify client (or other Connect receiver) appears in /me/player/devices.
    """
    hostnames = _hostname_tokens()
    running = False
    pids: list[int] = []
    if os.name == "nt":
        try:
            completed = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq Spotify.exe", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                timeout=4,
                check=False,
            )
            for line in (completed.stdout or "").splitlines():
                line = line.strip().strip('"')
                if not line or "spotify.exe" not in line.casefold():
                    continue
                parts = [p.strip().strip('"') for p in line.split('","')]
                if len(parts) < 2:
                    parts = [p.strip().strip('"') for p in line.split(",")]
                if len(parts) >= 2 and parts[1].isdigit():
                    pids.append(int(parts[1]))
                    running = True
        except (OSError, subprocess.SubprocessError, ValueError):
            running = False
    else:
        try:
            completed = subprocess.run(
                ["pgrep", "-x", "spotify"],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
            running = completed.returncode == 0 and bool((completed.stdout or "").strip())
        except (OSError, subprocess.SubprocessError):
            running = False

    install_path = None
    for candidate in _spotify_install_candidates():
        try:
            if candidate.is_file():
                install_path = str(candidate)
                break
        except OSError:
            continue

    return {
        "ok": True,
        "platform": os.name,
        "hostname": hostnames[0] if hostnames else None,
        "hostnames": hostnames,
        "spotify_desktop_running": running,
        "spotify_pids": pids[:8],
        "spotify_install_path": install_path,
        "can_wake": bool(install_path) or os.name == "nt",
        "note": (
            "Le pont peut détecter Spotify Desktop sur ce PC et le réveiller, "
            "mais pas router vers un périphérique Windows audio nu (casque/enceinte WASAPI). "
            "Connect exige l'app Spotify (ou un receiver Connect)."
        ),
    }


def wake_local_spotify(*, wait_s: float = 2.5) -> dict[str, Any]:
    """Launch Spotify Desktop if needed so it can register as a Connect device."""
    try:  # opt-in only: Spotify currently refuses audio keys to librespot for many accounts (librespot#1649)
        import hq_librespot
        if os.environ.get("HQ_PREFER_LIBRESPOT") == "1" and hq_librespot.exe_path() is not None:
            was_up = bool(hq_librespot.running_pids())
            hq_librespot.start()
            return {"ok": True, "launched": not was_up, "already_running": was_up, "headless": True,
                    "message": "Lecteur Spotify sans fenêtre (librespot) actif — il apparaît dans Connect sous « %s »."
                               % hq_librespot.device_name()}
    except Exception:
        pass
    probe = local_spotify_probe()
    launched = False
    already = bool(probe.get("spotify_desktop_running"))
    if already:
        return {
            "ok": True,
            "launched": False,
            "already_running": True,
            "local": probe,
            "message": "Spotify Desktop tourne déjà sur ce PC.",
        }

    path = probe.get("spotify_install_path")
    try:
        if isinstance(path, str) and path:
            extra: dict[str, Any] = {}
            if os.name == "nt":  # open minimized without stealing focus (SW_SHOWMINNOACTIVE)
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                si.wShowWindow = 7
                extra["startupinfo"] = si
            subprocess.Popen(  # noqa: S603 — local Spotify binary path only
                [path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                cwd=str(Path(path).parent),
                **extra,
            )
            launched = True
        elif os.name == "nt":
            # Shell protocol / Start Menu alias fallback.
            subprocess.Popen(  # noqa: S603
                ["cmd", "/c", "start", "", "spotify:"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
            )
            launched = True
        else:
            raise SpotifyError(
                "Spotify Desktop introuvable sur ce PC. Installe l'app Spotify, puis réessaie.",
                404,
                "spotify_desktop_missing",
            )
    except SpotifyError:
        raise
    except OSError as exc:
        raise SpotifyError(
            f"Impossible de lancer Spotify Desktop: {exc}",
            502,
            "spotify_desktop_wake_failed",
        ) from exc

    time.sleep(max(0.5, min(8.0, float(wait_s))))
    probe_after = local_spotify_probe()
    return {
        "ok": True,
        "launched": launched,
        "already_running": False,
        "local": probe_after,
        "message": (
            "Spotify Desktop lancé — attends qu'il apparaisse dans Connect, puis actualise."
            if launched
            else "Réveil Spotify demandé."
        ),
    }


def _device_looks_local(device: dict[str, Any], hostnames: list[str] | None = None) -> bool:
    name = str(device.get("name") or "")
    dtype = str(device.get("type") or "").casefold()
    name_cf = name.casefold()
    hosts = [h.casefold() for h in (hostnames or _hostname_tokens())]
    if dtype in {"computer", "pc"}:
        if not hosts:
            return True
        if any(h and h in name_cf for h in hosts):
            return True
        # Desktop clients often just use the machine name or "PC de …".
        if "pc" in name_cf or "desktop" in name_cf or "ordinateur" in name_cf:
            return True
        return dtype == "computer"
    return any(h and h == name_cf for h in hosts)


def list_devices(*, wake_if_empty: bool = False) -> dict[str, Any]:
    local = local_spotify_probe()
    hostnames = list(local.get("hostnames") or [])
    try:
        data = api_request("GET", "/me/player/devices")
    except SpotifyError:
        if wake_if_empty:
            wake_local_spotify()
            data = api_request("GET", "/me/player/devices")
        else:
            raise
    devices = data.get("devices") if isinstance(data, dict) else []
    out = []
    for d in devices or []:
        if not isinstance(d, dict):
            continue
        row = {
            "id": d.get("id"),
            "name": d.get("name"),
            "type": d.get("type"),
            "is_active": d.get("is_active"),
            "is_restricted": d.get("is_restricted"),
            "volume_percent": d.get("volume_percent"),
            "supports_volume": d.get("supports_volume"),
        }
        row["is_local_candidate"] = _device_looks_local(row, hostnames)
        out.append(row)

    if wake_if_empty and not out:
        wake = wake_local_spotify(wait_s=3.0)
        data = api_request("GET", "/me/player/devices")
        devices = data.get("devices") if isinstance(data, dict) else []
        out = []
        for d in devices or []:
            if not isinstance(d, dict):
                continue
            row = {
                "id": d.get("id"),
                "name": d.get("name"),
                "type": d.get("type"),
                "is_active": d.get("is_active"),
                "is_restricted": d.get("is_restricted"),
                "volume_percent": d.get("volume_percent"),
                "supports_volume": d.get("supports_volume"),
            }
            row["is_local_candidate"] = _device_looks_local(row, hostnames)
            out.append(row)
        local = wake.get("local") or local_spotify_probe()
        return {
            "ok": True,
            "devices": out,
            "local": local,
            "woke_local_spotify": True,
            "wake": {"launched": wake.get("launched"), "message": wake.get("message")},
        }

    return {
        "ok": True,
        "devices": out,
        "local": local,
        "woke_local_spotify": False,
    }


def pick_playback_device(preferred_id: str | None = None) -> dict[str, Any]:
    """Choose a usable Connect device. Prefers preferred → local PC → active → first unrestricted."""
    payload = list_devices()
    devices = payload.get("devices") or []
    usable = [d for d in devices if d.get("id") and not d.get("is_restricted")]
    if not usable:
        raise SpotifyError(
            "Aucun appareil Spotify Connect disponible. Ouvre Spotify Desktop sur ce PC "
            "(bouton Réveiller), ou un téléphone / Fire TV, puis actualise.",
            404,
            "spotify_no_device",
        )
    if preferred_id:
        for d in usable:
            if d.get("id") == preferred_id:
                return d
    for d in usable:
        if d.get("is_local_candidate") and d.get("is_active"):
            return d
    for d in usable:
        if d.get("is_local_candidate"):
            return d
    for d in usable:
        if d.get("is_active"):
            return d
    return usable[0]


def ensure_playback_device(preferred_id: str | None = None, *, play: bool = False) -> dict[str, Any]:
    """Make sure Spotify has a target device; wake local Desktop + transfer if needed."""
    try:
        chosen = pick_playback_device(preferred_id)
    except SpotifyError as exc:
        if getattr(exc, "code", None) != "spotify_no_device":
            raise
        wake_local_spotify(wait_s=3.2)
        # Re-list after wake; Connect registration can lag a few seconds.
        for _ in range(4):
            payload = list_devices()
            if payload.get("devices"):
                break
            time.sleep(1.0)
        chosen = pick_playback_device(preferred_id)

    if not chosen.get("is_active") or (preferred_id and chosen.get("id") == preferred_id and not chosen.get("is_active")):
        api_request(
            "PUT",
            "/me/player",
            body={"device_ids": [chosen["id"]], "play": bool(play)},
        )
        time.sleep(0.35)
        chosen = {**chosen, "is_active": True, "activated": True}
    return chosen


def _is_no_active_device(exc: SpotifyError) -> bool:
    msg = str(exc).casefold()
    return exc.code == "spotify_no_device" or "no active device" in msg


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
    auto_device = bool(params.get("auto_device", True))
    activated = None

    def _query(forced_id: str | None = None) -> dict[str, Any] | None:
        did = forced_id or device_id
        return {"device_id": did} if did else None

    def _run(forced_id: str | None = None) -> None:
        q = _query(forced_id)
        if action == "play":
            body: dict[str, Any] = {}
            if params.get("uris") and params.get("direct_uris") is not True:
                # Spotify accepts PUT /me/player/play {uris} on this account but never starts it, while a playlist
                # context plays. Load the tracks into HQ's private playback playlist and play that instead.
                body["context_uri"] = load_playback_playlist(list(params["uris"])[:100])
                body["offset"] = {"position": 0}
            elif params.get("uris"):
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
        elif action in ("queue", "queue_add"):
            uri = params.get("uri")
            if not isinstance(uri, str) or not uri.startswith("spotify:"):
                raise SpotifyError("URI Spotify requis pour la file")
            api_request("POST", "/me/player/queue", query={**(q or {}), "uri": uri})
        else:
            raise SpotifyError(f"Action lecteur inconnue: {action}")

    if action == "transfer":
        if not device_id:
            raise SpotifyError("device_id requis pour le transfert")
        api_request("PUT", "/me/player", body={"device_ids": [device_id], "play": bool(params.get("play", False))})
        return {"ok": True, "action": action, "device_id": device_id}

    try:
        if action == "play" and auto_device:
            # Always land on a concrete Connect target before play (preferred or first usable).
            activated = ensure_playback_device(
                str(device_id) if isinstance(device_id, str) and device_id else None,
                play=False,
            )
            device_id = activated.get("id")
        _run(device_id if isinstance(device_id, str) else None)
    except SpotifyError as exc:
        if action in {"play", "pause", "next", "previous", "queue", "queue_add", "seek", "volume", "shuffle", "repeat"} and auto_device and _is_no_active_device(exc):
            activated = ensure_playback_device(
                str(device_id) if isinstance(device_id, str) and device_id else None,
                play=False,
            )
            device_id = activated.get("id")
            try:
                _run(device_id)
            except SpotifyError as retry_exc:
                if _is_no_active_device(retry_exc):
                    raise SpotifyError(
                        "Aucun appareil Spotify actif. Ouvre l'app Spotify (PC/téléphone/Fire TV), "
                        "appuie sur Transférer dans Lecture, puis réessaie.",
                        404,
                        "spotify_no_device",
                    ) from retry_exc
                raise
        elif _is_no_active_device(exc):
            raise SpotifyError(
                "Aucun appareil Spotify actif. Ouvre l'app Spotify quelque part, puis actualise les appareils.",
                404,
                "spotify_no_device",
            ) from exc
        else:
            raise
    result: dict[str, Any] = {"ok": True, "action": action}
    if device_id:
        result["device_id"] = device_id
    if activated:
        result["device"] = {"id": activated.get("id"), "name": activated.get("name"), "type": activated.get("type")}
    return result


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
            "tracks_total": _playlist_total(pl),
            "image": proxied_image_url(image if isinstance(image, str) else None),
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
            "image": proxied_image_url(image if isinstance(image, str) else None),
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
        elif exc.status == 403 and exc.code != "spotify_premium_required":
            raise SpotifyError(
                "Playlist inaccessible — Spotify n'autorise le contenu que pour tes playlists "
                "(propriétaire ou collaborateur), pas les playlists publiques tierces.",
                403,
                "spotify_unavailable_endpoint",
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
            "image": proxied_image_url(image if isinstance(image, str) else None),
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
    except SpotifyError as exc:
        if exc.status != 404:
            raise
        # Fallback for older apps still on /users/{id}/playlists.
        me = api_request("GET", "/me")
        user_id = me.get("id")
        if not user_id:
            raise SpotifyError("Profil Spotify indisponible", 502, "spotify_api_error")
        data = api_request("POST", f"/users/{quote(str(user_id))}/playlists", body=body)
    return {"ok": True, "playlist": {"id": data.get("id"), "uri": data.get("uri"), "name": data.get("name")}}


PLAYBACK_PLAYLIST_FILE = "playback_playlist.json"
PLAYBACK_PLAYLIST_NAME = "Musica · Lecture"
_playback_lock = threading.Lock()
playback_generation = 0


def _playback_playlist_id(*, create: bool = True) -> str | None:
    file = _path(PLAYBACK_PLAYLIST_FILE)
    try:
        pid = json.loads(file.read_text(encoding="utf-8")).get("id") if file.is_file() else None
    except (OSError, ValueError):
        pid = None
    if pid or not create:
        return pid
    made = create_playlist(PLAYBACK_PLAYLIST_NAME, public=False,
                           description="Lecture HQ : titres lancés depuis Musique et DJ Musica (remplacée à chaque lecture).")
    pid = made["playlist"]["id"]
    file.parent.mkdir(parents=True, exist_ok=True)
    hq_state.write_json_atomic(_path(PLAYBACK_PLAYLIST_FILE), {"id": pid, "uri": made["playlist"].get("uri")})
    return pid


def replace_tracks(playlist_id: str, uris: list[str]) -> dict[str, Any]:
    clean = [u for u in uris if isinstance(u, str) and u.startswith("spotify:track:")][:100]
    if not clean:
        raise SpotifyError("Aucun URI de piste valide")
    data = _playlist_mutate("PUT", playlist_id, body={"uris": clean})
    return {"ok": True, "snapshot_id": data.get("snapshot_id") if isinstance(data, dict) else None}


def load_playback_playlist(uris: list[str]) -> str:
    """Replace HQ's private playback playlist with ``uris`` and return its context URI (recreated if deleted)."""
    global playback_generation
    with _playback_lock:
        playback_generation += 1
        pid = _playback_playlist_id()
        try:
            replace_tracks(pid, uris)
        except SpotifyError as exc:
            if exc.status not in (403, 404) and exc.code != "spotify_not_found":
                raise
            _path(PLAYBACK_PLAYLIST_FILE).unlink(missing_ok=True)
            pid = _playback_playlist_id()
            replace_tracks(pid, uris)
        return f"spotify:playlist:{pid}"


def append_playback_tracks(uris: list[str]) -> dict[str, Any]:
    """Append to the playback playlist (DJ next segment): the playing context simply continues into them."""
    pid = _playback_playlist_id(create=False)
    if not pid:
        raise SpotifyError("Playlist de lecture HQ absente", 404, "spotify_not_found")
    return add_tracks(pid, uris)


def playback_playlist_uri() -> str | None:
    pid = _playback_playlist_id(create=False)
    return f"spotify:playlist:{pid}" if pid else None


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


def catalog_item(item: dict[str, Any], kind: str, *, album: dict[str, Any] | None = None) -> dict[str, Any]:
    release = (album or item.get("album") or {}) if kind == "track" else item
    images = release.get("images") or []
    date = release.get("release_date") or ""
    row = {
        "id": item.get("id"),
        "uri": item.get("uri"),
        "name": item.get("name"),
        "artists": [a["name"] for a in item.get("artists") or [] if isinstance(a, dict) and a.get("name")],
        "image": proxied_image_url(images[0].get("url") if images and isinstance(images[0], dict) else None),
        "type": kind,
    }
    if kind == "track":
        row["album"] = release.get("name")
        row["duration_ms"] = item.get("duration_ms")
    if kind in {"track", "album"} and date:
        row.update(year=date[:4], release_date=date)
    if kind == "album":
        if isinstance(item.get("album_type"), str):
            row["album_type"] = item["album_type"]
        if isinstance(item.get("total_tracks"), int):
            row["total_tracks"] = item["total_tracks"]
    return row


def catalog_rows(block: Any, kind: str, *, album: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    return [catalog_item(item, kind, album=album) for item in (block.get("items") or [])
            if isinstance(item, dict)] if isinstance(block, dict) else []


def field_query(field: str, value: str) -> str:
    return field + ':"' + str(value).replace('"', ' ').strip() + '"'


def search(q: str, *, types: str = "track,artist,album,playlist", limit: int = SEARCH_MAX_LIMIT,
           offset: int = 0, retry_429: bool = True) -> dict[str, Any]:
    if not isinstance(q, str) or not q.strip():
        raise SpotifyError("Requête de recherche requise")
    requested = list(dict.fromkeys(types.split(",")))
    if not set(requested) <= {"track", "artist", "album", "playlist"}:
        raise SpotifyError("Type de recherche invalide")
    limit = max(1, min(SEARCH_MAX_LIMIT, int(limit)))
    offset = max(0, min(1000, int(offset)))
    data = api_request("GET", "/search", query={"q": q.strip()[:200], "type": ",".join(requested),
                       "limit": limit, "offset": offset}, retry_429=retry_429)
    data = data if isinstance(data, dict) else {}
    fields = ("tracks", "artists", "albums", "playlists")
    return {"ok": True, "query": q.strip(),
            **{field: catalog_rows(data.get(field), field[:-1]) for field in fields},
            "next_offset": offset + limit if offset + limit <= 1000 and any(
                isinstance(data.get(field), dict) and data[field].get("next") for field in fields) else None}


def _catalog_id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9]{1,80}", value):
        raise SpotifyError("Identifiant Spotify invalide")
    return value


def get_album(album_id: str, *, offset: int = 0) -> dict[str, Any]:
    album_id = _catalog_id(album_id)
    album = api_request("GET", f"/albums/{album_id}")
    block = album.get("tracks") or {}
    if offset or not block:
        block = api_request("GET", f"/albums/{album_id}/tracks", query={"limit": 50, "offset": offset})
    return {"ok": True, "album": catalog_item(album, "album"), "tracks": catalog_rows(block, "track", album=album),
            "next_offset": offset + len(block.get("items") or []) if block.get("next") else None}


def album_track_uris(album_id: str) -> list[str]:
    uris = []
    offset = 0
    while offset is not None:
        page = get_album(album_id, offset=offset)
        uris.extend(t["uri"] for t in page["tracks"] if t.get("uri"))
        offset = page["next_offset"]
    return uris


def artist_albums(artist_id: str, *, offset: int = 0) -> dict[str, Any]:
    # Development Mode answers « Invalid limit » above 10 for this endpoint (checked 2026-11).
    data = api_request("GET", f"/artists/{_catalog_id(artist_id)}/albums",
                       query={"include_groups": "album,single", "limit": 10, "offset": offset})
    return {"ok": True, "albums": catalog_rows(data, "album"),
            "next_offset": offset + 10 if data.get("next") else None}


TIME_RANGES = {"short": "short_term", "medium": "medium_term", "long": "long_term"}


def _top(kind: str, time_range: str, limit: int, *, retry_429: bool = True) -> dict[str, Any]:
    period = TIME_RANGES.get(time_range, time_range)
    if period not in TIME_RANGES.values():
        raise SpotifyError("Période d’écoute invalide")
    field = kind + "s"
    data = api_request("GET", f"/me/top/{field}", query={"time_range": period, "limit": max(1, min(50, limit))},
                       retry_429=retry_429)
    return {"ok": True, field: catalog_rows(data, kind)}


def top_artists(time_range: str = "short", *, limit: int = 8, retry_429: bool = True) -> dict[str, Any]:
    return _top("artist", time_range, limit, retry_429=retry_429)


def top_tracks(time_range: str = "short", *, limit: int = 10) -> dict[str, Any]:
    return _top("track", time_range, limit)


def recently_played(limit: int = 20, *, retry_429: bool = True) -> dict[str, Any]:
    data = api_request("GET", "/me/player/recently-played", query={"limit": max(1, min(50, limit))},
                       retry_429=retry_429)
    tracks = []
    for entry in data.get("items") or []:
        if isinstance(entry, dict) and isinstance(entry.get("track"), dict):
            tracks.append({**catalog_item(entry["track"], "track"), "played_at": entry.get("played_at")})
    return {"ok": True, "tracks": tracks}


def _saved(kind: str, limit: int, offset: int, *, retry_429: bool = True) -> dict[str, Any]:
    field = kind + "s"
    data = api_request("GET", f"/me/{field}", query={"limit": max(1, min(50, limit)), "offset": max(0, offset)},
                       retry_429=retry_429)
    rows = [catalog_item(row[kind], kind) for row in data.get("items") or []
            if isinstance(row, dict) and isinstance(row.get(kind), dict)]
    return {"ok": True, field: rows, "total": data.get("total"), "next": bool(data.get("next"))}


def saved_tracks(limit: int = 20, offset: int = 0) -> dict[str, Any]:
    return _saved("track", limit, offset)


def saved_albums(limit: int = 20, offset: int = 0, *, retry_429: bool = True) -> dict[str, Any]:
    return _saved("album", limit, offset, retry_429=retry_429)


def followed_artists(limit: int = 20, after: str | None = None) -> dict[str, Any]:
    """Optional helper for clients that already have the user-follow-read scope."""
    data = api_request("GET", "/me/following",
                       query={"type": "artist", "limit": max(1, min(50, limit)), "after": after})
    block = data.get("artists") or {}
    return {"ok": True, "artists": catalog_rows(block, "artist"),
            "after": (block.get("cursors") or {}).get("after") if block.get("next") else None}


def library_contains(uris: list[str], *, retry_429: bool = True) -> list[bool]:
    if not uris:
        return []
    data = api_request("GET", "/me/library/contains", query={"uris": ",".join(uris)}, retry_429=retry_429)
    if not isinstance(data, list) or len(data) != len(uris) or any(not isinstance(value, bool) for value in data):
        raise SpotifyError("Réponse de bibliothèque invalide", 502, "spotify_api_error")
    return data


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
            wake = str(_first_qs(qs, "wake") or "").strip().lower() in {"1", "true", "yes"}
            return 200, list_devices(wake_if_empty=wake)
        if path == "/api/spotify/local":
            return 200, local_spotify_probe()
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
        if path.startswith("/api/spotify/albums/"):
            aid = path.removeprefix("/api/spotify/albums/")
            return 200, get_album(aid, offset=int(_first_qs(qs, "offset", "0")))
        if path.startswith("/api/spotify/artists/") and path.endswith("/albums"):
            aid = path.removeprefix("/api/spotify/artists/").removesuffix("/albums")
            return 200, artist_albums(aid, offset=int(_first_qs(qs, "offset", "0")))
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
        if path == "/api/spotify/devices/wake":
            wake = wake_local_spotify(wait_s=float(body.get("wait_s") or 2.8))
            devices = list_devices()
            return 200, {
                "ok": True,
                "wake": wake,
                "devices": devices.get("devices") or [],
                "local": devices.get("local") or wake.get("local"),
            }
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
