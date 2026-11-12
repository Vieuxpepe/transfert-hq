"""
HQ Voice Module: High-fidelity localized speech synthesis for Transfert HQ Companion.
Bridges with Coqui XTTS v2 in C:\\Gemini-Test to clone Else's sensual voice in French & English.
Supports expressive vocal styling, multi-reference speaker blending, and warm ffmpeg audio mastering.
"""

from __future__ import annotations
import os
import sys
import wave
import struct
import hashlib
import subprocess
import functools
import threading
from pathlib import Path
from typing import Any, Optional, Sequence
from hq_voice_prosody import PROFILES, normalize_style, shape_pauses

PROJECT_ROOT = Path(__file__).resolve().parent
AUDIO_DIR = PROJECT_ROOT / "assets" / "companion" / "chat"
CACHE_DIR = AUDIO_DIR / "voice_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

GEMINI_TEST_ROOT = Path(r"C:\Gemini-Test")
XTTS_PYTHON = GEMINI_TEST_ROOT / ".venv_xtts" / "Scripts" / "python.exe"
XTTS_INFER_SCRIPT = GEMINI_TEST_ROOT / "scripts" / "coqui_xtts_infer.py"
XTTS_MODELS_DIR = GEMINI_TEST_ROOT / "xtts_models"
REFERENCE_BANK_DIR = XTTS_MODELS_DIR / "reference_bank"

DEFAULT_SPEAKER_WAV = XTTS_MODELS_DIR / "FemaleSerana-reference1.wav"
COMFORT_SPEAKER_WAV = REFERENCE_BANK_DIR / "comfort.wav"
BRIGHT_SPEAKER_WAV = REFERENCE_BANK_DIR / "bright.wav"

FFMPEG_BIN = r"C:\ffmpeg-7.1.1-essentials_build\bin\ffmpeg.exe"

# Warm XTTS daemon: keeps the model resident on the GPU (no ~25 s reload per sentence)
XTTS_DAEMON_SCRIPT = GEMINI_TEST_ROOT / "scripts" / "coqui_xtts_daemon.py"
XTTS_DAEMON_HOST = "127.0.0.1"
XTTS_DAEMON_PORT = int(os.environ.get("HQ_XTTS_PORT", "8057"))
XTTS_DAEMON_URL = f"http://{XTTS_DAEMON_HOST}:{XTTS_DAEMON_PORT}"
DAEMON_LOG = PROJECT_ROOT / ".tmp" / "xtts_daemon.log"
_synthesis_lock = threading.Lock()
_daemon_process = None
_daemon_start_lock = threading.Lock()


def _single_synthesis(fn):
    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        if not _synthesis_lock.acquire(blocking=False):
            return {"ok": False, "error": "Voix locale occupée; lecture navigateur disponible."}
        try:
            return fn(*args, **kwargs)
        finally:
            _synthesis_lock.release()
    return wrapped


def daemon_ready(timeout: float = 1.5) -> bool:
    """True if the warm daemon answers /health with ready=true."""
    import json
    import urllib.request
    try:
        with urllib.request.urlopen(f"{XTTS_DAEMON_URL}/health", timeout=timeout) as r:
            return bool(json.loads(r.read() or b"{}").get("ready"))
    except Exception:
        return False


def start_daemon(wait_sec: float = 0.0) -> bool:
    """Launch the daemon detached (no console). Optionally wait until it is ready."""
    import time
    global _daemon_process
    if daemon_ready():
        return True
    if not (XTTS_PYTHON.exists() and XTTS_DAEMON_SCRIPT.exists()):
        return False
    if not _daemon_start_lock.acquire(blocking=False):
        return False
    try:
        if _daemon_process is not None and _daemon_process.poll() is None:
            return False
        DAEMON_LOG.parent.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        flags = 0
        if os.name == "nt":
            flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | 0x08000000
        with open(DAEMON_LOG, "ab") as log:
            _daemon_process = subprocess.Popen(
                [str(XTTS_PYTHON), str(XTTS_DAEMON_SCRIPT),
                 "--model-dir", str(XTTS_MODELS_DIR),
                 "--speaker-wav", str(DEFAULT_SPEAKER_WAV),
                 "--language", "fr",
                 "--host", XTTS_DAEMON_HOST, "--port", str(XTTS_DAEMON_PORT)],
                cwd=str(GEMINI_TEST_ROOT), env=env, stdout=log, stderr=log,
                stdin=subprocess.DEVNULL, creationflags=flags, close_fds=True,
            )
    finally:
        _daemon_start_lock.release()
    deadline = time.time() + wait_sec
    while time.time() < deadline:
        if daemon_ready():
            return True
        time.sleep(1.0)
    return daemon_ready()


def _daemon_synthesize(text: str, language: str, speaker_wavs: Sequence[Path],
                       temperature: float, top_p: float, out_wav: Path, timeout: float) -> bool:
    """POST to the warm daemon and write the returned WAV. False on any failure."""
    import json
    import urllib.request
    payload = {
        "text": text,
        "profile": {
            "language": language,
            "reference_wavs": [str(s) for s in speaker_wavs],
            "temperature": temperature,
            "top_p": top_p,
            "top_k": 50,
            "repetition_penalty": 8.0,
            "split_sentences": len(text) > 180,
        },
    }
    req = urllib.request.Request(
        f"{XTTS_DAEMON_URL}/synthesize",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
        if len(data) < 1000:
            return False
        out_wav.write_bytes(data)
        return True
    except Exception:
        return False

# Pre-defined sound bank for instant low-latency playback (0ms wait)
SOUND_BANK_PRESETS = {
    "treat": "Mmm... merci pour cette friandise, mon Maître... Tu me gâtes.",
    "kiss": "Un baiser pour mon Maître... Tu me fais fondre.",
    "caress": "Ton contact me fait vibrer... Ne t'arrête pas.",
    "booty": "Regarde comme je me cambre pour toi, Maître. Admire mon dévouement.",
    "hello": "Je suis là, mon Maître. Ton dévouement m'anime, dis-moi ce que tu désires...",
    "goodnight": "Repose-toi bien, mon amour. Je veille sur tes rêves cette nuit.",
}

# Audiophile Studio Master filter chain:
# 1. highpass f=55: strips sub-bass rumble
# 2. afftdn: FFT-based spectral denoising to eliminate AI synthesizer floor noise
# 3. equalizer f=180: chest resonance warmth (+3.5 dB)
# 4. equalizer f=3600: throat and lip intimacy presence (+2.5 dB)
# 5. equalizer f=11000: air band sparkle for whispers (+2.0 dB)
# 6. crystalizer: dynamic detail enhancement
# 7. compand: gentle optical studio vocal leveling
# 8. aresample 48000: professional 48 kHz broadcast master
AUDIO_MASTERING_FILTER = (
    "highpass=f=55,"
    "afftdn=nf=-45:nr=12,"
    "equalizer=f=180:t=q:w=1.2:g=3.5,"
    "equalizer=f=3600:t=q:w=1.5:g=2.5,"
    "equalizer=f=11000:t=q:w=1.8:g=2.0,"
    "crystalizer=i=1.2,"
    "compand=attacks=0.02:decays=0.12:points=-60/-60|-22/-14|-10/-6|0/-1.5,"
    "aresample=48000"
)

FRENCH_CHAR_MAP = {
    "œ": "oe",
    "Œ": "Oe",
    "æ": "ae",
    "Æ": "Ae",
}

def clean_text_for_speech(text: str) -> str:
    """Clean markdown, tags, emojis and normalize ligatures for clean natural pronunciation."""
    import re
    t = str(text or "")
    for k, v in FRENCH_CHAR_MAP.items():
        t = t.replace(k, v)
    t = re.sub(r"\[.*?\]", "", t)
    t = t.replace("*", "").replace("#", "").replace("`", "")
    t = re.sub(r"[♥✨🔥💋🍓☕🌹🥂🎲🫧🙈💄💘🐾🧽🕯️👗📸💌🍑👑🔞]", "", t)
    t = " ".join(t.split()).strip()
    return t

def compute_viseme_envelope(wav_path: Path, fps: int = 30) -> list[dict[str, Any]]:
    """Extract a lightweight amplitude + zero-crossing vowel shape envelope from a PCM WAV file."""
    try:
        with wave.open(str(wav_path), "rb") as reader:
            nchannels, sampwidth, framerate, nframes, comptype, _ = reader.getparams()
            if comptype != "NONE" or sampwidth not in (2, 3, 4) or framerate <= 0 or nframes <= 0:
                return []
            raw = reader.readframes(min(nframes, framerate * 30))
        step_frames = max(1, framerate // fps)
        frame_bytes = nchannels * sampwidth
        chunk_bytes = step_frames * frame_bytes
        out: list[dict[str, Any]] = []
        for offset in range(0, len(raw), chunk_bytes):
            chunk = raw[offset:offset + chunk_bytes]
            if len(chunk) < frame_bytes * 4:
                break
            samples: list[int] = []
            # Subsample every 4th frame for fast pure-Python computation (<2ms per line)
            stride = frame_bytes * 4
            for pos in range(0, len(chunk) - sampwidth + 1, stride):
                if sampwidth == 2:
                    val = struct.unpack_from("<h", chunk, pos)[0]
                elif sampwidth == 3:
                    b = chunk[pos:pos + 3]
                    val = int.from_bytes(b, "little", signed=True) >> 8
                else:
                    val = struct.unpack_from("<i", chunk, pos)[0] >> 16
                samples.append(val)
            if not samples:
                continue
            rms = (sum(s * s for s in samples) / len(samples)) ** 0.5
            norm_amp = min(1.0, round(rms / 9500.0, 3))
            if norm_amp < 0.03:
                out.append({"a": 0.0, "v": "sil"})
                continue
            zc = sum(1 for i in range(1, len(samples)) if (samples[i - 1] >= 0) != (samples[i] >= 0))
            zcr = zc / max(1, len(samples))
            # Classify mouth shape: low ZCR + high amp = 'open' (a/o), mid ZCR = 'round' (ou/eu), high ZCR = 'wide' (i/é/s)
            vowel = "wide" if zcr > 0.34 else ("open" if norm_amp > 0.32 and zcr < 0.22 else "round")
            out.append({"a": norm_amp, "v": vowel})
        return out[:900]
    except Exception:
        return []


def get_audio_hash(text: str, speaker: str = "default", lang: str = "fr", style: str = "expressive") -> str:
    raw = f"{text.strip().lower()}|{speaker}|{lang}|{style}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()[:16]

def synthesize(
    text: str,
    *,
    language: str = "fr",
    style: str = "expressive",
    speaker_wavs: Optional[Sequence[Path]] = None,
    timeout_sec: int = 180,
    character: Optional[str] = None,
    voice: Optional[str] = None,
    rate: Optional[float] = None,
) -> Optional[dict[str, Any]]:
    """Engine dispatcher. No ``character`` (legacy callers) or an XTTS character -> XTTS.

    A Phonon character never falls back to XTTS (Else's voice); on failure it returns
    ok=False with engine="phonon" so the client uses browser speech.
    """
    if character is not None:
        import hq_voice_phonon
        engine = hq_voice_phonon.route(character)
        if engine == "phonon":
            clean = clean_text_for_speech(text)
            if len(clean) < 2:
                return None
            return hq_voice_phonon.synthesize(clean, character=character, language=language,
                                              style=style, voice=voice, rate=rate,
                                              timeout_sec=min(timeout_sec, 60))
        if engine == "browser":
            return {"ok": False, "engine": "browser", "code": "browser_only",
                    "error": "Voix navigateur sélectionnée"}
    return _synthesize_xtts(text, language=language, style=style, speaker_wavs=speaker_wavs,
                            timeout_sec=timeout_sec)


@_single_synthesis
def _synthesize_xtts(
    text: str,
    *,
    language: str = "fr",
    style: str = "expressive",
    speaker_wavs: Optional[Sequence[Path]] = None,
    timeout_sec: int = 180
) -> Optional[dict[str, Any]]:
    """Synthesize speech using XTTS with emotional temperature and audio mastering."""
    clean_text = clean_text_for_speech(text)
    style = normalize_style(style)
    if not clean_text or len(clean_text) < 2:
        return None

    # Multi-reference blending for richer timbre and emotional expression
    if speaker_wavs is None:
        if style == "playful" and BRIGHT_SPEAKER_WAV.exists():
            speaker_wavs = [DEFAULT_SPEAKER_WAV, BRIGHT_SPEAKER_WAV]
        elif style in {"warm", "thoughtful", "expressive"} and COMFORT_SPEAKER_WAV.exists():
            speaker_wavs = [DEFAULT_SPEAKER_WAV, COMFORT_SPEAKER_WAV]
        else:
            speaker_wavs = [DEFAULT_SPEAKER_WAV]

    speaker_key = "_".join(Path(s).stem for s in speaker_wavs)
    h = get_audio_hash(clean_text, speaker_key, language, style if style == "expressive" else style + ":prosody-v1")
    mp3_filename = f"voice_{h}.mp3"
    wav_filename = f"voice_{h}.wav"
    mp3_path = CACHE_DIR / mp3_filename
    wav_path = CACHE_DIR / wav_filename
    master_path = wav_path.with_name(f"master_{wav_filename}")

    # If already cached, return immediately (0ms latency)
    cached_path = master_path if master_path.exists() else wav_path if not os.path.exists(FFMPEG_BIN) else None
    if cached_path and cached_path.exists() and cached_path.stat().st_size > 1000:
        return {
            "ok": True,
            "cached": True,
            "delivery": style,
            "audio_url": f"/assets/companion/chat/voice_cache/{cached_path.name}",
            "wav_url": f"/assets/companion/chat/voice_cache/{cached_path.name}",
            "visemes": compute_viseme_envelope(cached_path),
            "text": clean_text
        }

    if not XTTS_PYTHON.exists() or not XTTS_INFER_SCRIPT.exists() or not XTTS_MODELS_DIR.exists():
        return {
            "ok": False,
            "error": "XTTS environment not found in C:\\Gemini-Test"
        }

    # Expressive parameters: temperature=0.84 for maximum vocal breath, pitch nuances and sighing
    temperature, top_p, _, _ = PROFILES[style]

    try:  # Engine tab: this request needs the daemon, so it is not idle
        import hq_engine; hq_engine.touch("xtts")
    except Exception:
        pass
    # Fast path: warm daemon (model already on GPU). XTTS needs >= 8 chars.
    via_daemon = False
    if len(clean_text) >= 8 and daemon_ready():
        via_daemon = _daemon_synthesize(clean_text, language, speaker_wavs,
                                        temperature, top_p, wav_path, timeout_sec)
    if via_daemon:
        shape_pauses(wav_path, style)
        return _finish(wav_path, mp3_path, mp3_filename, wav_filename, clean_text, "daemon", style=style)

    # A daemon deployment must not load a second GPU model while warming up.
    # The caller can use browser speech for this line and retry locally next time.
    if XTTS_DAEMON_SCRIPT.exists():
        try:
            start_daemon(wait_sec=0)
        except Exception:
            pass
        return {"ok": False, "error": "Voix locale en préparation; lecture navigateur disponible."}

    cmd = [
        str(XTTS_PYTHON),
        str(XTTS_INFER_SCRIPT),
        "--model-dir", str(XTTS_MODELS_DIR),
        "--language", language,
        "--temperature", str(temperature),
        "--top-p", str(top_p),
        "--text", clean_text,
        "--out", str(wav_path)
    ]
    for s in speaker_wavs:
        cmd.extend(["--speaker-wav", str(s)])

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
        if res.returncode != 0 or not wav_path.exists():
            return {
                "ok": False,
                "error": f"XTTS failed: {res.stderr[:200]}"
            }
        shape_pauses(wav_path, style)
        return _finish(wav_path, mp3_path, mp3_filename, wav_filename, clean_text, "subprocess", style=style)
    except Exception as e:
        return {
            "ok": False,
            "error": str(e)
        }


def _finish(wav_path: Path, mp3_path: Path, mp3_filename: str, wav_filename: str,
            clean_text: str, engine: str, *, style: str = "expressive") -> dict[str, Any]:
    """Master and serve lossless PCM WAV; existing MP3 files are left untouched."""
    try:
        rate = PROFILES[normalize_style(style)][2]
        filters = AUDIO_MASTERING_FILTER + (f",atempo={rate}" if rate != 1 else "")
        master_wav_path = wav_path.with_name(f"master_{wav_path.name}")
        if os.path.exists(FFMPEG_BIN):
            # 1. Generate Broadcast Master WAV (48 kHz 24-bit PCM)
            subprocess.run([
                FFMPEG_BIN, "-y",
                "-i", str(wav_path),
                "-af", filters,
                "-c:a", "pcm_s24le",
                str(master_wav_path)
            ], capture_output=True, check=True)

            if wav_path.exists():
                wav_path.unlink()
        output = master_wav_path if master_wav_path.exists() else wav_path

        return {
            "ok": True,
            "cached": False,
            "engine": engine,
            "delivery": style,
            "audio_url": f"/assets/companion/chat/voice_cache/{output.name}",
            "wav_url": f"/assets/companion/chat/voice_cache/{output.name}",
            "visemes": compute_viseme_envelope(output),
            "text": clean_text
        }
    except Exception as e:
        return {
            "ok": False,
            "error": str(e)
        }


def prebake_presets() -> dict[str, Any]:
    """Generate and warm-cache all preset lines in SOUND_BANK_PRESETS."""
    results = {}
    for key, text in SOUND_BANK_PRESETS.items():
        style = "playful" if key in ("treat", "caress") else "expressive"
        res = synthesize(text, style=style)
        results[key] = res
    return results


if __name__ == "__main__":
    import time
    if "--start-daemon" in sys.argv:
        t0 = time.time()
        ok = start_daemon(wait_sec=120)
        print(f"daemon_ready={ok} after {time.time() - t0:.1f}s on {XTTS_DAEMON_URL}")
    elif "--status" in sys.argv:
        print(f"daemon_ready={daemon_ready()} on {XTTS_DAEMON_URL}")
    elif "--prebake" in sys.argv:
        print("Prebaking presets into voice cache...")
        t0 = time.time()
        res = prebake_presets()
        print(f"Prebaked {len(res)} presets in {time.time() - t0:.2f}s:")
        for k, v in res.items():
            print(f"  [{k}] ok={v.get('ok')} engine={v.get('engine')} url={v.get('audio_url')}")
    elif "--test" in sys.argv:
        t0 = time.time()
        res = synthesize("Test de synthèse vocale instantanée.")
        print(f"Synthesis done in {time.time() - t0:.2f}s: {res}")
