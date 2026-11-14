"""Chatterbox TTS (expressive English voice) for DJ Musica.

Same shape as hq_voice_phonon: an isolated venv (C:\\AI\\Chatterbox) runs scripts/chatterbox_daemon.py on a
loopback port; HQ only talks to 127.0.0.1. The voice is cloned from a reference clip in
C:\\AI\\Chatterbox\\voices\\<character>.wav, recorded once from the character's own Phonon voice so she keeps the
voice the Master chose. ``mood`` maps to Chatterbox's emotion controls (exaggeration, cfg_weight, temperature).
Any failure returns None so callers fall back to Phonon.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

PROJECT_ROOT = Path(__file__).resolve().parent
CACHE_DIR = PROJECT_ROOT / "assets" / "companion" / "chat" / "voice_cache"
CB_ROOT = Path(os.environ.get("HQ_CHATTERBOX_ROOT", r"C:\AI\Chatterbox"))
CB_PYTHON = CB_ROOT / "venv" / "Scripts" / "python.exe"
CB_DAEMON_SCRIPT = PROJECT_ROOT / "scripts" / "chatterbox_daemon.py"
CB_HOST = "127.0.0.1"
CB_PORT = int(os.environ.get("HQ_CHATTERBOX_PORT", "8059"))
CB_URL = f"http://{CB_HOST}:{CB_PORT}"
CB_LOG = PROJECT_ROOT / ".tmp" / "chatterbox_daemon.log"
VOICES_DIR = CB_ROOT / "voices"
REV = "cb3"  # bump when the delivery mapping or mastering changes (part of the cache key)

# Chatterbox guidance: more exaggeration = more emotion; lower cfg_weight = slower, more deliberate pacing
# (it compensates for the speed-up that high exaggeration brings).
MOODS: dict[str, dict[str, float]] = {
    "neutral": {"exaggeration": 0.5, "cfg_weight": 0.5, "temperature": 0.8},
    "warm": {"exaggeration": 0.65, "cfg_weight": 0.42, "temperature": 0.8},
    # Artifacts came mostly from temperature > 0.8: emotion now comes from exaggeration, pacing from cfg_weight.
    "hype": {"exaggeration": 0.85, "cfg_weight": 0.35, "temperature": 0.8},
    "playful": {"exaggeration": 0.75, "cfg_weight": 0.38, "temperature": 0.8},
    "tender": {"exaggeration": 0.45, "cfg_weight": 0.55, "temperature": 0.75},
    "mysterious": {"exaggeration": 0.55, "cfg_weight": 0.6, "temperature": 0.75},
}
# ~30 s of calm, varied sentences: a longer, even reference gives Chatterbox a steadier, cleaner clone.
REFERENCE_TEXT = (
    "Hello, Master. It's Musica, and I'm right here with you in the studio. "
    "Tonight I picked a few songs I think you'll enjoy, some old favourites and a couple of new ones. "
    "I like to listen closely: the first notes, the way a chorus opens up, the quiet moment before the drop. "
    "When a song really works, you can feel the whole room change. "
    "So take a breath, settle in, and let the music carry you for a while. "
    "I'll be here between the tracks, telling you a little about each one."
)
MASTER_FILTER = "highpass=f=60,loudnorm=I=-19:TP=-2:LRA=11,aresample=48000"  # same chain as Phonon's voices
FFMPEG_BIN = r"C:\ffmpeg-7.1.1-essentials_build\bin\ffmpeg.exe"
_proc: Optional[subprocess.Popen] = None
_daemon_lock = threading.Lock()
_synth_lock = threading.Lock()


def installed() -> bool:
    return CB_PYTHON.is_file() and CB_DAEMON_SCRIPT.is_file()


def _health(timeout: float = 1.5) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(f"{CB_URL}/health", timeout=timeout) as r:
            data = json.loads(r.read() or b"{}")
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def daemon_ready() -> bool:
    return bool(_health().get("ready"))


def status() -> dict[str, Any]:
    h = _health()
    return {"installed": installed(), "daemon": bool(h), "ready": bool(h.get("ready")), "device": h.get("device"),
            "error": h.get("error"), "voices": h.get("voices") or [], "vram_mb": h.get("vram_mb"),
            "load_s": h.get("load_s")}


def start_daemon(wait_sec: float = 0.0) -> bool:
    """Start detached and hidden; the model loads in the background so no request path blocks on it."""
    global _proc
    if _health():
        return True
    if not installed():
        return False
    if not _daemon_lock.acquire(blocking=False):
        return False
    try:
        if _proc is None or _proc.poll() is not None:
            CB_LOG.parent.mkdir(parents=True, exist_ok=True)
            VOICES_DIR.mkdir(parents=True, exist_ok=True)
            env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1", HF_HOME=str(CB_ROOT / "hf_cache"))
            args = [str(CB_PYTHON), "-I", str(CB_DAEMON_SCRIPT), "--host", CB_HOST, "--port", str(CB_PORT),
                    "--root", str(CB_ROOT)]
            flags, extra = 0, {}
            if os.name == "nt":
                flags = subprocess.CREATE_NEW_PROCESS_GROUP | 0x08000000  # hidden console (see hq_voice_phonon)
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                si.wShowWindow = 0
                extra["startupinfo"] = si
            with open(CB_LOG, "ab") as log:
                _proc = subprocess.Popen(args, cwd=str(CB_ROOT), env=env, stdout=log, stderr=log,
                                         stdin=subprocess.DEVNULL, creationflags=flags, close_fds=True, **extra)
    finally:
        _daemon_lock.release()
    end = time.time() + wait_sec
    while time.time() < end:
        if daemon_ready():
            return True
        time.sleep(1.0)
    return daemon_ready()


def stop_daemon(wait_sec: float = 5.0) -> bool:
    """Stop the daemon answering on our port (PID from its own /health, never an unrelated process)."""
    h = _health(1.5)
    if not h:
        return True
    pid = h.get("pid")
    if isinstance(pid, int) and pid > 0 and pid != os.getpid():
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=10)
            else:
                os.kill(pid, 15)
        except Exception:
            pass
    end = time.time() + wait_sec
    while time.time() < end:
        if not _health(0.5):
            return True
        time.sleep(0.2)
    return not _health(0.5)


def has_voice(character: str) -> bool:
    path = VOICES_DIR / f"{character}.wav"
    return path.is_file() and not path.is_symlink()


def voice_stamp(character: str) -> int:
    """Changes when the reference clip is re-recorded, so cached lines in the old voice are not reused."""
    try:
        return int((VOICES_DIR / f"{character}.wav").stat().st_mtime)
    except OSError:
        return 0


def _ffmpeg() -> str:
    return FFMPEG_BIN if os.path.exists(FFMPEG_BIN) else (shutil.which("ffmpeg") or "")


def make_reference(character: str = "musica", *, force: bool = False) -> dict[str, Any]:
    """Record a ~30 s clip of the character's current Phonon voice as Chatterbox's voice reference."""
    import hq_voice_phonon

    dest = VOICES_DIR / f"{character}.wav"
    if dest.is_file() and not force:
        return {"ok": True, "voice": character, "created": False}
    result = hq_voice_phonon.synthesize(REFERENCE_TEXT, character=character, language="en", style="neutral",
                                        timeout_sec=90)
    url = (result or {}).get("audio_url") if (result or {}).get("ok") else None
    if not isinstance(url, str) or not url.startswith("/assets/companion/chat/voice_cache/"):
        return {"ok": False, "error": "Voix Phonon indisponible pour créer la référence"}
    source = PROJECT_ROOT / url.lstrip("/")
    if not source.is_file():
        return {"ok": False, "error": "Fichier de référence introuvable"}
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    shutil.copyfile(source, tmp)
    os.replace(tmp, dest)
    return {"ok": True, "voice": character, "created": True}


TAG_RE = re.compile(r"\[(neutral|warm|hype|playful|tender|mysterious)\]\s*", re.I)
SENTENCE_RE = re.compile(r"(?<=[.!?…])\s+")
GAP_SEC = 0.22  # breath between sentences when a line is spoken in pieces


def strip_tags(text: str) -> str:
    return " ".join(TAG_RE.sub("", str(text or "")).split())


def plan_chunks(text: str, mood: str) -> list[tuple[str, str]]:
    """Split a line into (sentence, mood): an inline tag « [tender] » switches mood until the next tag.
    Shorter generations are also cleaner, and the mood can change mid-line like a real host's."""
    chunks: list[tuple[str, str]] = []
    current = mood if mood in MOODS else "neutral"
    pos = 0
    pieces = []
    for match in TAG_RE.finditer(text):
        pieces.append((text[pos:match.start()], current))
        current = match.group(1).lower()
        pos = match.end()
    pieces.append((text[pos:], current))
    for part, part_mood in pieces:
        part = " ".join(part.split())
        if len(part) < 2:
            continue
        if len(part) <= 260:  # one recording per mood: every extra piece costs a fixed few seconds on the GPU
            chunks.append((part, part_mood))
            continue
        for sentence in SENTENCE_RE.split(part):
            if len(sentence.strip()) >= 2:
                chunks.append((sentence.strip(), part_mood))
    merged: list[tuple[str, str]] = []
    for sentence, part_mood in chunks:  # keep very short bits with their neighbour (same mood) to avoid choppy audio
        if merged and merged[-1][1] == part_mood and (len(sentence) < 25 or len(merged[-1][0]) < 25):
            merged[-1] = (merged[-1][0] + " " + sentence, part_mood)
        else:
            merged.append((sentence, part_mood))
    return merged[:8]


def controls(mood: str, intensity: float = 1.0) -> dict[str, float]:
    """Scale a mood: more exaggeration for more emotion, a lower cfg_weight to keep the pacing from rushing."""
    base = MOODS.get(mood, MOODS["neutral"])
    k = max(0.5, min(1.6, float(intensity or 1.0)))
    return {"exaggeration": round(max(0.25, min(1.3, base["exaggeration"] * k)), 3),
            "cfg_weight": round(max(0.2, min(0.7, base["cfg_weight"] - (k - 1.0) * 0.25)), 3),
            "temperature": base["temperature"]}


def cache_key(text: str, voice: str, mood: str, intensity: float = 1.0) -> str:
    raw = "|".join(["chatterbox", REV, voice, str(voice_stamp(voice)), mood,
                    json.dumps(controls(mood, intensity), sort_keys=True), text.strip()])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def _remote_ok() -> bool:
    """Is a paired voice worker (another PC's GPU) answering right now?"""
    try:
        import hq_voice_remote
        return hq_voice_remote.available()
    except Exception:  # noqa: BLE001 — the local path never depends on it
        return False


def _generate(text: str, character: str, mood: str, intensity: float, timeout_sec: float) -> Optional[bytes]:
    payload = {"text": text[:600], "voice": character, **controls(mood, intensity)}
    if _remote_ok():  # the other PC's GPU first; on failure or timeout the local daemon (if any) is still tried
        import hq_voice_remote
        data = hq_voice_remote.generate(payload, voice_stamp(character), min(float(timeout_sec), 45.0))
        if data:
            return data
    req = urllib.request.Request(f"{CB_URL}/synthesize", json.dumps(payload).encode(), {"Content-Type": "application/json"},
                                 method="POST")
    with _synth_lock:
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as r:
                return r.read() or None
        except (urllib.error.URLError, OSError, TimeoutError):
            return None


def _join(parts: list[Path], out: Path) -> bool:
    """Concatenate sentence WAVs with a short breath between them (24 kHz mono from the daemon)."""
    ffmpeg = _ffmpeg()
    if not ffmpeg or not parts:
        return False
    args = [ffmpeg, "-y", "-v", "error"]
    for part in parts:
        args += ["-i", str(part)]
    labels = []
    for i in range(len(parts)):
        pad = f",apad=pad_dur={GAP_SEC}" if i < len(parts) - 1 else ""
        labels.append(f"[{i}:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono{pad}[p{i}]")
    graph = ";".join(labels) + ";" + "".join(f"[p{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=0:a=1[out]"
    try:
        subprocess.run(args + ["-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_s16le", str(out)],
                       capture_output=True, check=True, timeout=45, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return out.is_file()
    except (OSError, subprocess.SubprocessError):
        return False


def synthesize(text: str, *, character: str = "musica", mood: str = "neutral", intensity: float = 1.0,
               timeout_sec: float = 90) -> Optional[dict[str, Any]]:
    """{"ok", "audio_url", "path"} or None (daemon down, busy, no reference, error) -> caller uses Phonon.
    Inline tags like « [tender] » change the mood for the following sentences."""
    text = " ".join(str(text or "").split())
    remote = _remote_ok()
    if len(strip_tags(text)) < 2 or not (remote or installed()):
        return None
    mood = mood if mood in MOODS else "neutral"
    name = f"voice_cb{cache_key(text, character, mood, intensity)}.wav"
    out = CACHE_DIR / name
    if out.is_file():
        return {"ok": True, "audio_url": f"/assets/companion/chat/voice_cache/{name}", "path": str(out), "cached": True}
    if not remote and not daemon_ready():  # with a worker online this PC's GPU is left alone
        start_daemon(wait_sec=0.0)
        return None
    if not has_voice(character) and not make_reference(character).get("ok"):
        return None
    try:
        import hq_engine
        hq_engine.touch("chatterbox")
    except Exception:
        pass
    chunks = plan_chunks(text, mood)
    if not chunks:
        return None
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    raw = out.with_name("raw_" + name)
    if len(chunks) == 1:
        data = _generate(chunks[0][0], character, chunks[0][1], intensity, timeout_sec)
        if not data:
            return None
        raw.write_bytes(data)
    else:
        parts: list[Path] = []
        try:
            for i, (sentence, part_mood) in enumerate(chunks):
                data = _generate(sentence, character, part_mood, intensity, timeout_sec)
                if not data:
                    return None
                part = out.with_name(f"part{i}_{name}")
                part.write_bytes(data)
                parts.append(part)
            if not _join(parts, raw):
                raw.unlink(missing_ok=True)
                return None
        finally:
            for part in parts:
                part.unlink(missing_ok=True)
    if not _master(raw, out):
        os.replace(raw, out)  # unmastered is still better than nothing
    return {"ok": True, "audio_url": f"/assets/companion/chat/voice_cache/{name}", "path": str(out), "cached": False,
            "chunks": len(chunks)}


def _master(raw: Path, out: Path) -> bool:
    """Same polish as Phonon's voices: rumble cut, loudness evened out, 48 kHz — so both engines sit together."""
    ffmpeg = _ffmpeg()
    if not ffmpeg:
        return False
    tmp = out.with_name("mst_" + out.name)
    try:
        subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(raw), "-af", MASTER_FILTER, "-c:a", "pcm_s16le", str(tmp)],
                       capture_output=True, check=True, timeout=45, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        os.replace(tmp, out)
        raw.unlink(missing_ok=True)
        return True
    except (OSError, subprocess.SubprocessError):
        tmp.unlink(missing_ok=True)
        return False
