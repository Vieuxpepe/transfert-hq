"""Warm Phonon TTS daemon. Run with the isolated venv: C:\AI\Phonon\venv\Scripts\python.exe.

Loopback-only HTTP service. Models load once at start-up (never in a request path),
one synthesis runs at a time; a busy daemon answers 429 immediately so the caller can
fall back. Fully offline once models are cached (HF_HUB_OFFLINE is honoured by ptts).

  GET  /health      -> {"ready": bool, "models": {lang: {...}}, "errors": {...}}
  POST /synthesize  -> {"text","lang","voice","duration_delta"}  => audio/wav (mono 16-bit)
"""
from __future__ import annotations
import argparse, io, json, os, threading, time, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS: dict = {}
ERRORS: dict = {}
LOCK = threading.Lock()
MAX_TEXT = 1200


def load(specs):
    import ptts
    for spec in specs:
        lang, _, repo = spec.partition("=")
        try:
            t0 = time.time()
            m = ptts.TTS(repo, lang=lang)
            MODELS[lang] = {"tts": m, "repo": repo, "load_s": round(time.time() - t0, 2)}
        except Exception as exc:  # keep serving the other languages
            ERRORS[lang] = str(exc)[:300]


def wav_bytes(pcm, rate):
    import numpy as np
    arr = np.clip(np.asarray(pcm, dtype="float32"), -1.0, 1.0)
    data = (arr * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(int(rate)); w.writeframes(data)
    return buf.getvalue()


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
        info = {l: {"repo": m["repo"], "rate": m["tts"].sample_rate, "quant": m["tts"].quant,
                    "load_s": m["load_s"]} for l, m in MODELS.items()}
        self._send(200, json.dumps({"ready": bool(MODELS), "models": info, "errors": ERRORS}).encode())

    def do_POST(self):
        if self.path != "/synthesize":
            return self._err(404, "not found")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(min(n, 20000)) or b"{}")
            text = str(req.get("text") or "").strip()[:MAX_TEXT]
            lang = str(req.get("lang") or "fr")
        except Exception:
            return self._err(400, "bad request")
        m = MODELS.get(lang)
        if not text or m is None:
            return self._err(422, "empty text or language model not loaded")
        if not LOCK.acquire(blocking=False):
            return self._err(429, "busy")
        try:
            kw = {}
            if req.get("voice"):
                kw["voice"] = str(req["voice"])
            dd = req.get("duration_delta")
            if isinstance(dd, (int, float)) and dd != 0:
                kw["conditions"] = {"duration_delta": max(-0.6, min(0.6, float(dd)))}
            t0 = time.time()
            pcm = m["tts"].synth(text, **kw)
            rate = m["tts"].sample_rate
            self._send(200, wav_bytes(pcm, rate), "audio/wav",
                       {"X-Sample-Rate": str(rate), "X-Synth-Seconds": f"{time.time() - t0:.3f}"})
        except Exception as exc:
            self._err(500, str(exc)[:200])
        finally:
            LOCK.release()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", action="append", required=True, help="lang=hf://repo or lang=/local/dir")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8058)
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()
    if a.host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("loopback only")
    if a.threads:
        import ptts; ptts.set_num_threads(a.threads)
    srv = ThreadingHTTPServer((a.host, a.port), H)
    threading.Thread(target=lambda: load(a.model), daemon=True).start()  # port answers while loading
    srv.serve_forever()
