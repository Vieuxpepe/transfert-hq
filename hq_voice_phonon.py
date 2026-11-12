"""Phonon TTS engine + per-character voice profiles for Transfert HQ.

Phonon runs in an isolated venv (C:\\AI\\Phonon) behind a loopback daemon
(scripts/phonon_daemon.py) so the HQ interpreter, the XTTS daemon in
C:\\Gemini-Test and this module never share state. The shared model is loaded once by
the daemon; characters differ only by voice name + rate. Nothing here talks to the
network beyond 127.0.0.1.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
import time
import unicodedata
import urllib.error
import urllib.request
import wave
from pathlib import Path
from typing import Any, Optional

import hq_state

PROJECT_ROOT = Path(__file__).resolve().parent
CACHE_DIR = PROJECT_ROOT / "assets" / "companion" / "chat" / "voice_cache"
PROFILES_FILE = PROJECT_ROOT / "hq_voice_profiles.json"  # git-ignored, user choices only

PHONON_ROOT = Path(os.environ.get("HQ_PHONON_ROOT", r"C:\AI\Phonon"))
PHONON_PYTHON = PHONON_ROOT / "venv" / "Scripts" / "python.exe"
PHONON_DAEMON_SCRIPT = PROJECT_ROOT / "scripts" / "phonon_daemon.py"
PHONON_HOST = "127.0.0.1"
PHONON_PORT = int(os.environ.get("HQ_PHONON_PORT", "8058"))
PHONON_URL = f"http://{PHONON_HOST}:{PHONON_PORT}"
PHONON_LOG = PROJECT_ROOT / ".tmp" / "phonon_daemon.log"
MODELS = {  # lang -> checkpoint. French is gated on Hugging Face (CC BY-NC 4.0).
    "fr": "hf://gradium/phonon-40m-fr",
    "en": "hf://gradium/phonon-31m-en",
}
MASTER_REV = "ph-m1"  # bump when the mastering chain changes (part of the cache key)
FFMPEG_BIN = r"C:\ffmpeg-7.1.1-essentials_build\bin\ffmpeg.exe"
# Light chain only: no EQ, denoise, exciter or reverb.
MASTER_FILTER = "highpass=f=60,loudnorm=I=-19:TP=-2:LRA=11,aresample=48000"

CHARACTERS = ("else", "transferania", "inventoria", "musica")
ALIASES = {"transferina": "transferania", "transferania": "transferania", "else": "else",
           "inventoria": "inventoria", "musica": "musica"}
ENGINES = ("xtts", "phonon", "browser")

# Audition shortlists picked from catalog *descriptions*; NOT verified by listening.
# No permanent voice is assigned until the user saves one.
CANDIDATES = {
    "transferania": ["Coralie", "Maëlys", "Solène"],
    "inventoria": ["Tiphaine", "Orianne", "Hélène"],
    "musica": ["Noémie", "Lilou", "Ninon"],
}
# Delivery style -> duration_delta (negative = faster). Phonon only exposes duration.
STYLE_DELTA = {"neutral": 0.0, "warm": 0.05, "thoughtful": 0.08, "deadpan": 0.03,
               "playful": -0.08, "expressive": 0.0}
RATE_LIMITS = (-0.4, 0.4)
PITCH_LIMITS = (-6.0, 6.0)  # semitones, applied after synthesis (needs ffmpeg)

_cfg_lock = threading.Lock()
_daemon_lock = threading.Lock()
_proc = None


def character_key(name: Any) -> Optional[str]:
    return ALIASES.get(str(name or "").strip().lower())


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def default_profile(char: str) -> dict[str, Any]:
    if char == "else":
        return {"engine": "xtts", "voice": None, "rate": 0.0, "pitch": 0.0, "selected": True, "fallback": ["browser"]}
    return {"engine": "phonon", "voice": None, "rate": 0.0, "pitch": 0.0, "selected": False,
            "fallback": ["browser"], "preview_voice": (CANDIDATES.get(char) or [None])[0]}


def load_profiles() -> dict[str, dict[str, Any]]:
    stored: Any = {}
    try:
        stored = json.loads(PROFILES_FILE.read_text(encoding="utf-8")).get("profiles", {})
    except Exception:
        stored = {}
    out: dict[str, dict[str, Any]] = {}
    for c in CHARACTERS:
        p = default_profile(c)
        s = stored.get(c) if isinstance(stored, dict) else None
        if isinstance(s, dict):
            if s.get("engine") in ENGINES and not (c != "else" and s["engine"] == "xtts"):
                p["engine"] = s["engine"]
            if isinstance(s.get("voice"), str) and s["voice"]:
                p["voice"] = s["voice"][:40]
            if isinstance(s.get("rate"), (int, float)):
                p["rate"] = max(RATE_LIMITS[0], min(RATE_LIMITS[1], float(s["rate"])))
            if isinstance(s.get("pitch"), (int, float)):
                p["pitch"] = max(PITCH_LIMITS[0], min(PITCH_LIMITS[1], float(s["pitch"])))
            p["selected"] = bool(p["voice"]) or c == "else" or p["engine"] == "browser"
        out[c] = p
    return out


def save_profile(char: str, engine: str, voice: Optional[str], rate: float, pitch: float = 0.0) -> dict[str, Any]:
    c = character_key(char)
    if c is None or engine not in ENGINES:
        raise ValueError("personnage ou moteur inconnu")
    if c != "else" and engine == "xtts":
        raise ValueError("XTTS est réservé à Else (voix de référence)")
    if engine == "phonon":
        found = voice and (resolve_voice(voice, "fr") or resolve_voice(voice, "en"))
        if not found:
            raise ValueError("voix inconnue")
        voice = found
    rate = max(RATE_LIMITS[0], min(RATE_LIMITS[1], float(rate or 0)))
    pitch = max(PITCH_LIMITS[0], min(PITCH_LIMITS[1], float(pitch or 0)))
    with _cfg_lock:
        profiles = load_profiles()
        profiles[c].update(engine=engine, voice=voice if engine == "phonon" else None,
                           rate=rate, pitch=pitch, selected=True)
        keep = {k: {f: v[f] for f in ("engine", "voice", "rate", "pitch")} for k, v in profiles.items()}
        hq_state.write_json_atomic(PROFILES_FILE, {"version": 1, "profiles": keep})
        return profiles[c]


def reset_profile(char: str) -> dict[str, Any]:
    """Restore the shipped default for one character (used by 'restore previous voice')."""
    c = character_key(char)
    if c is None:
        raise ValueError("personnage inconnu")
    with _cfg_lock:
        profiles = load_profiles()
        profiles[c] = default_profile(c)
        keep = {k: {f: v[f] for f in ("engine", "voice", "rate", "pitch")} for k, v in profiles.items()}
        hq_state.write_json_atomic(PROFILES_FILE, {"version": 1, "profiles": keep})
        return profiles[c]


_catalog_cache: Optional[list] = None


def catalog() -> list[dict[str, Any]]:
    """Catalog voices (name, language, description), read once via the Phonon venv."""
    global _catalog_cache
    if _catalog_cache is not None:
        return _catalog_cache
    if not PHONON_PYTHON.exists():
        return []
    try:
        r = subprocess.run(
            [str(PHONON_PYTHON), "-I", "-c",
             "import ptts,json,sys;sys.stdout.buffer.write(json.dumps(ptts.catalog_voices()).encode())"],
            capture_output=True, timeout=30)
        _catalog_cache = [v for v in json.loads(r.stdout) if isinstance(v, dict)]
    except Exception:
        _catalog_cache = []
    return _catalog_cache


def resolve_voice(name: str, lang: str = "fr") -> Optional[str]:
    f = _fold(name or "")
    for v in catalog():
        if v.get("language") == lang and _fold(v.get("name", "")) == f:
            return v["name"]
    return None


def valid_voice(name: str, lang: str = "fr") -> bool:
    return resolve_voice(name, lang) is not None


def voices(lang: str = "fr") -> list[dict[str, Any]]:
    return [{"name": v["name"], "description": v.get("description", "")}
            for v in catalog() if v.get("language") == lang]


# ---- daemon ---------------------------------------------------------------

def _health(timeout: float = 1.0) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(f"{PHONON_URL}/health", timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except Exception:
        return {}


def daemon_ready(lang: Optional[str] = None, timeout: float = 1.0) -> bool:
    h = _health(timeout)
    return bool(h.get("ready")) and (lang is None or lang in (h.get("models") or {}))


def status() -> dict[str, Any]:
    h = _health()
    return {"installed": PHONON_PYTHON.exists(), "daemon": bool(h), "ready": bool(h.get("ready")),
            "models": h.get("models") or {}, "errors": h.get("errors") or {}}


def start_daemon(wait_sec: float = 0.0) -> bool:
    """Start detached; models load in the background so no request path blocks on it."""
    global _proc
    if _health():
        return True
    if not (PHONON_PYTHON.exists() and PHONON_DAEMON_SCRIPT.exists()):
        return False
    if not _daemon_lock.acquire(blocking=False):
        return False
    try:
        if _proc is None or _proc.poll() is not None:
            PHONON_LOG.parent.mkdir(parents=True, exist_ok=True)
            env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
            args = [str(PHONON_PYTHON), "-I", str(PHONON_DAEMON_SCRIPT), "--host", PHONON_HOST,
                    "--port", str(PHONON_PORT)]
            for lang, repo in MODELS.items():
                args += ["--model", f"{lang}={repo}"]
            flags = 0
            if os.name == "nt":
                flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | 0x08000000
            with open(PHONON_LOG, "ab") as log:
                _proc = subprocess.Popen(args, cwd=str(PHONON_ROOT), env=env, stdout=log, stderr=log,
                                         stdin=subprocess.DEVNULL, creationflags=flags, close_fds=True)
    finally:
        _daemon_lock.release()
    end = time.time() + wait_sec
    while time.time() < end:
        if daemon_ready():
            return True
        time.sleep(1.0)
    return daemon_ready()


def _post(text: str, lang: str, voice: Optional[str], delta: float, out: Path,
          timeout: float) -> tuple[bool, str]:
    payload = {"text": text, "lang": lang, "voice": voice, "duration_delta": delta}
    req = urllib.request.Request(f"{PHONON_URL}/synthesize", json.dumps(payload).encode(),
                                 {"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out.write_bytes(r.read())
        return True, ""
    except urllib.error.HTTPError as e:
        return False, "busy" if e.code == 429 else f"http_{e.code}"
    except Exception:
        return False, "unreachable"


def wav_ok(path: Path) -> bool:
    """True if the file is a playable 16/24-bit PCM WAV with non-silent audio."""
    try:
        with wave.open(str(path), "rb") as w:
            n, width, rate = w.getnframes(), w.getsampwidth(), w.getframerate()
            if n < rate // 10 or width not in (2, 3):
                return False
            raw = w.readframes(min(n, rate * 2))
        peak = max((abs(int.from_bytes(raw[i:i + width], "little", signed=True))
                    for i in range(0, len(raw) - width, width * 8)), default=0)
        return peak > (1 << (8 * width - 1)) * 0.005
    except Exception:
        return False


def cache_key(text: str, lang: str, voice: str, style: str, delta: float, model: str, pitch: float = 0.0) -> str:
    raw = "|".join(["phonon", model, voice, lang, style, f"{delta:.3f}", f"p{pitch:.2f}", MASTER_REV, text.strip()])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def synthesize(text: str, *, character: str, language: str = "fr", style: str = "neutral",
               voice: Optional[str] = None, rate: Optional[float] = None, pitch: Optional[float] = None,
               master: bool = True, timeout_sec: float = 60.0) -> dict[str, Any]:
    """Standard hq_voice result dict. Never substitutes another engine's voice."""
    from hq_voice_prosody import normalize_style
    from hq_voice import compute_viseme_envelope
    c = character_key(character)
    prof = load_profiles().get(c or "", {})
    style = normalize_style(style)
    lang = "en" if language == "en" else "fr"
    chosen = voice or prof.get("voice") or prof.get("preview_voice")
    if not chosen:
        return {"ok": False, "engine": "phonon", "code": "no_voice", "error": "Aucune voix Phonon choisie"}
    voice_name = resolve_voice(chosen, lang)
    if not voice_name:  # a voice's native language wins (e.g. English-only Lottie)
        other = "en" if lang == "fr" else "fr"
        if resolve_voice(chosen, other) and (voice is None or voice == prof.get("voice")):
            lang, voice_name = other, resolve_voice(chosen, other)
    if not voice_name:
        return {"ok": False, "engine": "phonon", "code": "bad_voice",
                "error": "Voix Phonon inconnue pour cette langue"}
    delta = STYLE_DELTA.get(style, 0.0) + (prof.get("rate", 0.0) if rate is None else float(rate))
    delta = max(-0.6, min(0.6, delta))
    model = MODELS[lang]
    semis = max(PITCH_LIMITS[0], min(PITCH_LIMITS[1], float(prof.get("pitch", 0.0) if pitch is None else pitch)))
    if not (master and os.path.exists(FFMPEG_BIN)):
        semis = 0.0  # pitch shifting needs the ffmpeg pass
    name = f"voice_ph{cache_key(text, lang, voice_name, style, delta, model, semis)}.wav"
    final = CACHE_DIR / name
    url = f"/assets/companion/chat/voice_cache/{name}"
    meta = {"engine": "phonon", "model": model, "voice": voice_name, "language": lang,
            "delivery": style, "preview": not prof.get("selected", False), "text": text}
    if final.exists() and wav_ok(final):
        return {"ok": True, "cached": True, "audio_url": url, "wav_url": url,
                "visemes": compute_viseme_envelope(final), **meta}
    if not daemon_ready(lang):
        start_daemon(0)
        return {"ok": False, "engine": "phonon", "code": "preparing",
                "error": "Voix Phonon en préparation; lecture navigateur disponible."}
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    raw = final.with_name(f"raw_{name}")
    ok, why = _post(text, lang, voice_name, delta, raw, timeout_sec)
    if not ok:
        return {"ok": False, "engine": "phonon", "code": why,
                "error": ("Voix Phonon occupée; lecture navigateur disponible." if why == "busy"
                          else "Synthèse Phonon indisponible")}
    try:
        if master and os.path.exists(FFMPEG_BIN):
            chain = MASTER_FILTER
            if semis:
                with wave.open(str(raw), "rb") as rw:
                    sr = rw.getframerate()
                f = 2 ** (semis / 12)  # raises pitch and formants, tempo restored
                chain = f"asetrate={sr}*{f:.5f},aresample=48000,atempo={1 / f:.5f}," + MASTER_FILTER
            subprocess.run([FFMPEG_BIN, "-y", "-i", str(raw), "-af", chain,
                            "-c:a", "pcm_s16le", str(final)],
                           capture_output=True, check=True, timeout=30)
            raw.unlink(missing_ok=True)
        else:
            os.replace(raw, final)
    except Exception:
        if raw.exists():
            os.replace(raw, final)
    if not wav_ok(final):
        final.unlink(missing_ok=True)
        return {"ok": False, "engine": "phonon", "code": "bad_audio", "error": "Audio Phonon invalide"}
    return {"ok": True, "cached": False, "audio_url": url, "wav_url": url,
            "visemes": compute_viseme_envelope(final), **meta}


def route(character: Any) -> str:
    """Engine for a character: xtts | phonon | browser (unknown/None -> xtts, legacy)."""
    c = character_key(character)
    return load_profiles()[c]["engine"] if c else "xtts"


MAX_PREVIEW_CHARS = 400
STUDIO_OPS = ("voice_profiles", "voice_preview", "voice_save", "voice_reset", "voice_start")


def studio(op: str, data: dict, *, admin: bool) -> dict[str, Any]:
    """Voice-studio API shared by all companions. Reads are open; writes need admin."""
    import hq_voice
    if op == "voice_profiles":
        profiles = load_profiles()
        return {"ok": True, "profiles": profiles, "status": status(),
                "candidates": CANDIDATES, "voices": {"fr": voices("fr"), "en": voices("en")},
                "engines": {"xtts": ["else"], "phonon": list(CHARACTERS[1:]) + ["else"], "browser": list(CHARACTERS)}}
    if op in ("voice_save", "voice_reset", "voice_start") and not admin:
        return {"ok": False, "error": "Réservé à la session administrateur", "code": "forbidden"}
    if op == "voice_start":
        start_daemon(0)
        return {"ok": True, "status": status()}
    c = character_key(data.get("character"))
    if c is None:
        return {"ok": False, "error": "Personnage inconnu", "code": "bad_character"}
    if op == "voice_reset":
        return {"ok": True, "profile": reset_profile(c)}
    engine = str(data.get("engine") or "phonon")
    try:
        rate = float(data.get("rate") or 0.0)
    except (TypeError, ValueError):
        rate = 0.0
    try:
        pitch = float(data.get("pitch") or 0.0)
    except (TypeError, ValueError):
        pitch = 0.0
    if op == "voice_save":
        try:
            return {"ok": True, "profile": save_profile(c, engine, data.get("voice"), rate, pitch)}
        except ValueError as e:
            return {"ok": False, "error": str(e), "code": "validation"}
    # voice_preview: never persists anything
    text = str(data.get("text") or "")[:MAX_PREVIEW_CHARS]
    lang = "en" if data.get("language") == "en" else "fr"
    style = str(data.get("style") or "neutral")
    if engine == "xtts":
        if c != "else":
            return {"ok": False, "error": "XTTS est réservé à Else", "code": "validation"}
        res = hq_voice._synthesize_xtts(text, language=lang, style=style)
    elif engine == "phonon":
        res = synthesize(hq_voice.clean_text_for_speech(text), character=c, language=lang,
                         style=style, voice=data.get("voice"), rate=rate, pitch=pitch)
    else:
        return {"ok": False, "error": "Aperçu navigateur côté client", "code": "browser_only"}
    return res or {"ok": False, "error": "Texte vide"}
