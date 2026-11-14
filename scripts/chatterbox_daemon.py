"""Warm Chatterbox TTS daemon (expressive English voice). Run with C:\\AI\\Chatterbox\\venv\\Scripts\\python.exe.

Loopback-only HTTP service, same contract style as phonon_daemon.py. The model loads once at start-up in a
background thread (the port answers while loading); one synthesis at a time, a busy daemon answers 429 so the
caller falls back to Phonon. Reference voices are WAV files in <root>/voices/<name>.wav only — the request names
a voice, it never passes a path.

  GET  /health      -> {"ready", "device", "sample_rate", "voices", "vram_mb", "error", "pid"}
  POST /synthesize  -> {"text", "voice", "exaggeration", "cfg_weight", "temperature"}  => audio/wav (mono 16-bit)
"""
from __future__ import annotations
import argparse, io, json, os, re, threading, time, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE: dict = {"model": None, "device": None, "error": None, "load_s": None}
LOCK = threading.Lock()
MAX_TEXT = 600
VOICE_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
ROOT = os.path.dirname(os.path.abspath(__file__))


def load(device: str) -> None:
    try:
        import torch
        from chatterbox.tts import ChatterboxTTS
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        t0 = time.time()
        STATE["model"] = ChatterboxTTS.from_pretrained(device=device)
        STATE.update(device=device, load_s=round(time.time() - t0, 1))
    except Exception as exc:  # health reports it; HQ keeps using Phonon
        STATE["error"] = str(exc)[:400]


def voices_dir() -> str:
    return os.path.join(STATE.get("root") or ROOT, "voices")


def list_voices() -> list[str]:
    try:
        return sorted(f[:-4] for f in os.listdir(voices_dir()) if f.endswith(".wav") and VOICE_RE.fullmatch(f[:-4]))
    except OSError:
        return []


def wav_bytes(samples, rate: int) -> bytes:
    import numpy as np
    arr = np.clip(np.asarray(samples, dtype="float32").reshape(-1), -1.0, 1.0)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(int(rate)); w.writeframes((arr * 32767.0).astype("<i2").tobytes())
    return buf.getvalue()


def vram_mb():
    try:
        import torch
        if torch.cuda.is_available():
            return round(torch.cuda.memory_allocated() / 2 ** 20)
    except Exception:
        pass
    return None


def clamp(value, low, high, default):
    return max(low, min(high, float(value))) if isinstance(value, (int, float)) and not isinstance(value, bool) else default


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # never log text
        pass

    def _send(self, code, body, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg):
        self._send(code, json.dumps({"ok": False, "error": msg}).encode())

    def do_GET(self):
        if self.path != "/health":
            return self._err(404, "not found")
        m = STATE["model"]
        self._send(200, json.dumps({"ready": m is not None, "device": STATE["device"], "error": STATE["error"],
                                    "sample_rate": getattr(m, "sr", None), "load_s": STATE["load_s"],
                                    "voices": list_voices(), "vram_mb": vram_mb(), "pid": os.getpid()}).encode())

    def do_POST(self):
        if self.path != "/synthesize":
            return self._err(404, "not found")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(min(n, 20000)) or b"{}")
            text = " ".join(str(req.get("text") or "").split())[:MAX_TEXT]
        except Exception:
            return self._err(400, "bad request")
        m = STATE["model"]
        if not text or m is None:
            return self._err(422, "empty text or model not loaded")
        voice = req.get("voice")
        prompt = None
        if voice:
            if not isinstance(voice, str) or not VOICE_RE.fullmatch(voice):
                return self._err(400, "bad voice")
            prompt = os.path.join(voices_dir(), voice + ".wav")
            if not os.path.isfile(prompt) or os.path.islink(prompt):
                return self._err(404, "voice not found")
        if not LOCK.acquire(blocking=False):
            return self._err(429, "busy")
        try:
            t0 = time.time()
            # Analysing the reference clip is the slow part: do it once per voice (or when the file changes);
            # Chatterbox keeps it in model.conds and only swaps the emotion level between requests.
            stamp = (voice, os.path.getmtime(prompt)) if prompt else None
            if stamp and STATE.get("loaded_voice") == stamp and m.conds is not None:
                prompt = None
            STATE["loaded_voice"] = None  # only marked loaded once a generation with it succeeded
            wav = m.generate(text, audio_prompt_path=prompt,
                             exaggeration=clamp(req.get("exaggeration"), 0.25, 1.5, 0.5),
                             cfg_weight=clamp(req.get("cfg_weight"), 0.0, 1.0, 0.5),
                             temperature=clamp(req.get("temperature"), 0.3, 1.2, 0.8))
            STATE["loaded_voice"] = stamp
            samples = wav.squeeze().detach().cpu().numpy()
            self._send(200, wav_bytes(samples, m.sr), "audio/wav",
                       {"X-Sample-Rate": str(m.sr), "X-Synth-Seconds": f"{time.time() - t0:.3f}"})
        except Exception as exc:
            self._err(500, str(exc)[:200])
        finally:
            LOCK.release()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8059)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--root", default=ROOT, help="folder holding voices/")
    a = ap.parse_args()
    if a.host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("loopback only")
    STATE["root"] = a.root
    srv = ThreadingHTTPServer((a.host, a.port), H)
    threading.Thread(target=lambda: load(a.device), daemon=True).start()  # port answers while loading
    srv.serve_forever()
