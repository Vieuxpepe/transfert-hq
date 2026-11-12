"""Generate audition WAVs for the three Phonon companions into C:\AI\Phonon\samples.
Usage: python scripts/phonon_audition.py [--lang fr|en] [--only <character>]   (needs the warm daemon; French needs HF access)."""
import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import hq_voice_phonon as ph

TEXT = {
 "transferania": "Coucou, mon Maître ! C'est Transferina ! J'ai enfin ma propre voix, et franchement, je suis beaucoup trop contente ! Tu vas pouvoir m'entendre raconter mes petites découvertes, et surtout, répondre beaucoup plus rapidement. Alors, tu en penses quoi ?",
 "inventoria": "Bonjour ! Je suis Inventoria. Je viens de terminer l'analyse de ton inventaire. Nous avons actuellement vingt-quatre articles répertoriés, dont sept nécessitent une vérification. Je peux également t'aider à organiser tes équipements et à suivre tes ressources.",
 "musica": "Salut ! C'est Musica ! Aujourd'hui, j'ai envie de te faire découvrir quelque chose de spécial. Imagine une mélodie douce, quelques notes de piano et une ambiance parfaite pour relaxer. La musique, c'est tellement plus qu'un simple son, tu ne trouves pas ?",
}
TEXT["pistonia"] = ("Morning, Master. Four of five engines are up and steady. Phonon is humming at twelve percent, "
                    "and the GPU is calm. Nothing needs your attention.")
COMMON = "Demain matin, je range vingt-quatre boîtes, trois étagères et douze câbles avant de partir."
lang = sys.argv[sys.argv.index("--lang") + 1] if "--lang" in sys.argv else "fr"
only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None      # e.g. --only pistonia
out = Path(r"C:\AI\Phonon\samples"); out.mkdir(parents=True, exist_ok=True)
if not ph.daemon_ready(lang):
    ph.start_daemon(wait_sec=120)
if not ph.daemon_ready(lang):
    sys.exit(f"Phonon {lang} model not loaded: {ph.status().get('errors')}")
for char, cands in ph.CANDIDATES.items():
    if only and char != only:
        continue
    for v in cands:
        for tag, txt in (("script", TEXT[char]), ("common", COMMON)):
            r = ph.synthesize(txt, character=char, language=lang, voice=v, master=True)
            if not r.get("ok"):
                print("FAIL", char, v, r.get("error")); continue
            dst = out / f"{lang}_{char}_{v}_{tag}.wav"
            dst.write_bytes((ph.CACHE_DIR / Path(r["audio_url"]).name).read_bytes()); print(dst)
