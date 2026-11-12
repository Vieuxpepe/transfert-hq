"""Interleaved warm-vs-warm benchmark, same text/language, warmup discarded, no cache hits."""
import json, statistics, sys, tempfile, time, wave, subprocess
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import hq_voice, hq_voice_phonon as ph
LANG = sys.argv[1] if len(sys.argv) > 1 else "en"
BASE = {"en": "Hello, I am here to help you organise your inventory and follow your resources every day with calm and precision. ",
        "fr": "Bonjour, je suis là pour t'aider à organiser ton inventaire et suivre tes ressources au quotidien avec calme et précision. "}[LANG]
def words(n): w = BASE.split(); return " ".join((w * (n // len(w) + 1))[:n]) + "."
def dur(p):
    with wave.open(str(p)) as w: return w.getnframes() / w.getframerate()
voice = ph.voices(LANG)[0]["name"]
def x(t, o): return hq_voice._daemon_synthesize(t, LANG, [hq_voice.DEFAULT_SPEAKER_WAV], 0.7, 0.85, o, 180)
def p(t, o): return ph._post(t, LANG, voice, 0.0, o, 180)[0]
def peak_vram():
    return int(subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"]).split()[0])
res = {"lang": LANG, "phonon_voice": voice, "vram_mb_idle": peak_vram()}
for n in (10, 40, 120):
    t = words(n); T = {"xtts": [], "phonon": []}; D = {"xtts": [], "phonon": []}
    for i in range(6):  # run 0 = warmup, discarded
        for name, fn in (("xtts", x), ("phonon", p)) if i % 2 == 0 else (("phonon", p), ("xtts", x)):
            o = Path(tempfile.mkdtemp()) / "o.wav"; s = time.time(); ok = fn(t, o); e = time.time() - s
            if i and ok: T[name].append(e); D[name].append(dur(o))
    for k in T:
        m, d = statistics.median(T[k]), statistics.median(D[k])
        res[f"{k}_{n}w"] = {"median_s": round(m, 2), "min_s": round(min(T[k]), 2), "max_s": round(max(T[k]), 2), "audio_s": round(d, 2), "rtf": round(m / d, 2)}
res["vram_mb_after"] = peak_vram()
print(json.dumps(res, indent=1))
