"""ElevenLabs text-to-speech for Musica's DJ lines (opt-in: ``voice_engine = "elevenlabs"``).

Stdlib only. The key lives in the gitignored ``.hq-music/elevenlabs.json`` (or ``ELEVENLABS_API_KEY``) and is never
returned by any API. Every failure (no key, quota low, network, HTTP error) returns None so the caller falls back
to the local voices. Credits are spent per character, so a line is skipped when it is longer than ``max_chars`` and
the engine is skipped when the account's remaining credits drop under ``min_credits_left``.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

API = "https://api.elevenlabs.io/v1"
DEFAULTS: dict[str, Any] = {
    "voice_id": "n7Wi4g1bhpw4Bs8HK5ph",
    "model_id": "eleven_v4_turbo",
    "output_format": "mp3_44100_128",  # Starter's best MP3; 192 kbps needs Creator, pcm_44100 needs Pro
    "voice_settings": {"stability": 0.7, "similarity_boost": 0.9, "style": 0.0, "use_speaker_boost": True},
    "min_credits_left": 1500,
    "max_chars": 500,
}
QUOTA_TTL = 120.0
_MOOD_TAG_RE = re.compile(r"\[(?:neutral|warm|hype|playful|tender|mysterious)\]\s*", re.I)
_VOICE_ID_RE = re.compile(r"^[A-Za-z0-9]{10,40}$")
_quota: dict[str, Any] = {"at": 0.0, "left": None}
_lock = threading.Lock()


def load_config(path: Path) -> Optional[dict[str, Any]]:
    """The merged config, or None when there is no usable key. A config file that cannot be read is treated as absent."""
    raw: dict[str, Any] = {}
    try:
        if path.is_file() and not path.is_symlink():
            data = json.loads(path.read_text(encoding="utf-8"))
            raw = data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        raw = {}
    key = str(raw.get("api_key") or os.environ.get("ELEVENLABS_API_KEY") or "").strip()
    if not key.startswith("sk_"):
        return None
    cfg = json.loads(json.dumps(DEFAULTS))
    voice = raw.get("voice_id")
    if isinstance(voice, str) and _VOICE_ID_RE.fullmatch(voice):
        cfg["voice_id"] = voice
    for name in ("model_id", "output_format"):
        if isinstance(raw.get(name), str) and re.fullmatch(r"[a-z0-9_]{3,40}", raw[name]):
            cfg[name] = raw[name]
    if isinstance(raw.get("voice_settings"), dict):
        cfg["voice_settings"].update({k: v for k, v in raw["voice_settings"].items() if k in cfg["voice_settings"]})
    for name in ("min_credits_left", "max_chars"):
        if isinstance(raw.get(name), int) and not isinstance(raw.get(name), bool) and raw[name] >= 0:
            cfg[name] = raw[name]
    cfg["api_key"] = key
    return cfg


def stamp(cfg: dict[str, Any]) -> str:
    """Changes whenever the voice, model or settings do, so cached drops are not replayed in the old voice."""
    raw = json.dumps([cfg["voice_id"], cfg["model_id"], cfg["voice_settings"]], sort_keys=True)
    return hashlib.sha1(raw.encode()).hexdigest()[:8]


def clean(text: Any) -> str:
    """Mood tags are Chatterbox stage directions; ElevenLabs gets the plain line (its own [sound] tags are kept)."""
    return " ".join(_MOOD_TAG_RE.sub("", str(text or "")).split())


def _request(cfg: dict[str, Any], url: str, body: Optional[dict[str, Any]], timeout: float) -> bytes:
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"xi-api-key": cfg["api_key"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def credits_left(cfg: dict[str, Any], *, refresh: bool = True) -> Optional[int]:
    """Remaining credits (cached for QUOTA_TTL). None = unknown; ``refresh=False`` never touches the network."""
    now = time.monotonic()
    with _lock:
        if _quota["left"] is not None and (not refresh or now - _quota["at"] < QUOTA_TTL):
            return _quota["left"]
    if not refresh:
        return None
    try:
        data = json.loads(_request(cfg, f"{API}/user/subscription", None, 6.0))
        left = int(data["character_limit"]) - int(data["character_count"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    with _lock:
        _quota.update(at=now, left=left)
    return left


def usable(cfg: Optional[dict[str, Any]], *, refresh: bool = True) -> bool:
    """Configured and not running low on credits (an unknown balance does not block: the call itself may still work)."""
    if not cfg:
        return False
    left = credits_left(cfg, refresh=refresh)
    return left is None or left >= cfg["min_credits_left"]


def synthesize(text: str, cfg: dict[str, Any], out: Path, *, timeout_sec: float = 40.0) -> Optional[Path]:
    """Write the MP3 of ``text`` to ``out`` (an existing file is a cache hit). None on any failure."""
    text = clean(text)
    if len(text) < 2 or len(text) > int(cfg["max_chars"]):
        return None
    if out.is_file() and not out.is_symlink():
        return out
    if not usable(cfg):
        return None
    try:
        data = _request(cfg, f"{API}/text-to-speech/{cfg['voice_id']}?output_format={cfg['output_format']}",
                        {"text": text, "model_id": cfg["model_id"], "voice_settings": cfg["voice_settings"]}, timeout_sec)
    except (OSError, ValueError):
        return None
    if not data:
        return None
    tmp = out.with_name(out.name + ".tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, out)
    except OSError:
        tmp.unlink(missing_ok=True)
        return None
    with _lock:  # keep the cached balance roughly right until the next refresh
        if _quota["left"] is not None:
            _quota["left"] = max(0, _quota["left"] - len(text))
    return out
