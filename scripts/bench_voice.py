"""Benchmark Phonon vs XTTS through their warm daemons (no cache hits). Writes JSON to stdout."""
import json, statistics, subprocess, sys, tempfile, time, wave
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import hq_voice, hq_voice_phonon as ph

FR = "Bonjour, je suis là pour t'aider à organiser ton inventaire et suivre tes ressources au quotidien avec calme et précision. "
EN = "Hello, I am here to help you organise your inventory and follow your resources every day with calm and precision. "
def words(base, n): w = base.split(); return " ".join((w * (n // len(w) + 1))[:n]) + "."

def vram():
    try: return int(subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"]).split()[0])
    except Exception: return None

def dur(p):
    with wave.open(str(p)) as w: return w.getnframes() / w.getframerate()

def run(fn, runs=5):
    ts, ds = [], []
    for _ in range(runs):
        out = Path(tempfile.mkdtemp()) / "o.wav"; t = time.time(); ok = fn(out); ts.append(time.time() - t)
        ds.append(dur(out) if ok and out.exists() else 0)
    return {"median_s": round(statistics.median(ts), 2), "audio_s": round(statistics.median(ds), 2),
            "rtf": round(statistics.median(ts) / max(0.01, statistics.median(ds)), 2), "ok": all(ds)}

res = {"vram_before_mb": vram()}
voice_en = ph.voices("en")[0]["name"]
for lang, base in (("en", EN), ("fr", FR)):
    for n in (10, 40, 120):
        txt = words(base, n)
        if ph.daemon_ready(lang):
            v = voice_en if lang == "en" else ph.voices("fr")[0]["name"]
            res[f"phonon_{lang}_{n}w"] = run(lambda o: ph._post(txt, lang, v, 0.0, o, 120)[0])
if "--xtts" in sys.argv:
    t = time.time(); ready = hq_voice.start_daemon(wait_sec=180); res["xtts_cold_start_s"] = round(time.time() - t, 1)
    if ready:
        for n in (10, 40, 120):
            txt = words(FR, n)
            res[f"xtts_fr_{n}w"] = run(lambda o: hq_voice._daemon_synthesize(txt, "fr", [hq_voice.DEFAULT_SPEAKER_WAV], 0.7, 0.85, o, 180))
res["vram_after_mb"] = vram()
print(json.dumps(res, indent=1))
