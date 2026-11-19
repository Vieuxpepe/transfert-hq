"""One report for the whole family mission.

A. Distinctness: the same Master turn through each assistant's own reply path.
B. Evolution: several simulated days of Master turns for two of them, with the
   register traced round by round, then reloaded from the stored state in a fresh
   process (``--reload``).
C. The earned culinia|pistonia bond, and an unearned pair, through that same run.

    python -X utf8 scripts/verify_family_mission.py --run
    python -X utf8 scripts/verify_family_mission.py --reload <root>
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
TURN = "Je rentre tard. Rien d'important, juste fatigué."
DAYS = ("Je rentre tard. Rien d'important, juste fatigué.",
        "Encore une longue journée. Je n'ai rien fait de bon.",
        "Je crois que je tiens mieux quand tu es là.",
        "Ce soir je n'ai envie de parler à personne d'autre.")
OWNER = "Administrateur"


def _keys() -> tuple[str, list[str]]:
    """The owner's model keys, read in-process and never printed."""
    import json
    config = json.loads((ROOT / "bridge_config.json").read_text(encoding="utf-8"))
    primary = str(config.get("gemini_api_key") or "")
    extras = [str(config.get("gemini_api_key_2") or "")]
    return primary, [key for key in extras if key]


def _bind(root: Path, now=None):
    sys.path.insert(0, str(ROOT))
    import hq_ai
    import hq_companion_memory as memory
    primary, extras = _keys()
    hq_ai.bind(root=root, now=now or time.time,
               key=lambda: primary, extra_keys=lambda: extras)
    memory.bind(root=root, now=time.time() if now is None else now())


def _paths(root: Path):
    """Every assistant module, bound to this root, through its own entry point."""
    import hq_ai
    import hq_culinia
    import hq_forgia
    import hq_inventoria_ai
    import hq_inventoria
    import hq_inventory
    import hq_music
    import hq_musica
    import hq_pistonia
    import hq_pistonia_store as store
    import hq_securia
    import hq_elsea

    hq_culinia.bind(root=root)
    hq_music.bind(root=root)          # Musica's store; hq_musica.chat reads it
    hq_inventory.bind(root=root)      # Inventoria's store; respond reads it
    hq_inventoria.bind(root=root)
    hq_forgia.bind(root=root)
    hq_musica.bind(root=root)
    hq_securia.bind(root=root)
    hq_elsea.bind(root=root)
    store.bind(root)

    def transferania(turn: str) -> str:
        system = hq_ai.build_transferania_system(
            "chat", "warm", nsfw=False, view="accueil", device_id="family-mission",
            prefs={"intensity": 2, "topics_off": []}, signals={}, context_core=False)
        raw, _ = hq_ai.generate(hq_ai.ASK_CHAIN, system,
                                [{"role": "user", "parts": [{"text": turn}]}],
                                temperature=0.7, transferania=True, max_tokens=320,
                                deadline=time.monotonic() + hq_ai.CHAT_DEADLINE_S)
        return raw

    def else_(turn: str) -> str:
        system = ("Tu es Else, la puce image du HQ, sœur posée de Transferania. "
                  "Réponds en français, en deux ou trois phrases, avec ta voix.\n\n"
                  + __import__("hq_assistant_voice").block("else", compact=True))
        raw, _ = hq_ai.generate(hq_ai.ASK_CHAIN, system,
                                [{"role": "user", "parts": [{"text": turn}]}],
                                temperature=0.65, max_tokens=220,
                                deadline=time.monotonic() + hq_ai.CHAT_DEADLINE_S)
        return raw

    def culinia(turn: str) -> str:
        hq_culinia.chat(turn)
        return str((hq_culinia.get_thread().get("messages") or [])[-1].get("text") or "")

    def forgia(turn: str) -> str:
        hq_forgia.chat(turn)
        return str((hq_forgia.get_thread().get("messages") or [])[-1].get("text") or "")

    def musica(turn: str) -> str:
        hq_musica.chat(turn, history_inject=False)
        return str((hq_musica.get_thread().get("messages") or [])[-1].get("text") or "")

    def securia(turn: str) -> str:
        hq_securia.chat(turn)
        return str((hq_securia.get_thread().get("messages") or [])[-1].get("text") or "")

    def elsea(turn: str) -> str:
        hq_elsea.chat(turn)
        return str((hq_elsea.get_thread().get("messages") or [])[-1].get("text") or "")

    def pistonia(turn: str) -> str:
        reply, _ = hq_pistonia.respond(turn)
        return str(reply or "")

    def inventoria(turn: str) -> str:
        reply, _ = hq_inventoria_ai.respond(turn)
        return str(reply or "")

    return {"transferania": transferania, "else": else_, "culinia": culinia, "forgia": forgia,
            "musica": musica, "inventoria": inventoria, "pistonia": pistonia, "securia": securia,
            "elsea": elsea}


def _measured() -> dict:
    """How each assistant was actually reached, reported beside its line."""
    return {"transferania": "build_transferania_system + generate",
            "else": "voice layer + generate",
            "culinia": "hq_culinia.chat", "forgia": "hq_forgia.chat",
            "musica": "hq_musica.chat", "inventoria": "hq_inventoria_ai.respond",
            "pistonia": "hq_pistonia.respond", "securia": "hq_securia.chat",
            "elsea": "hq_elsea.chat"}


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-zà-ÿ']{4,}", str(text).lower())}


def _similarity(rows: dict[str, str]) -> list[dict]:
    keys = [key for key, text in rows.items() if text and not text.startswith("[")]
    out = []
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            wa, wb = _words(rows[a]), _words(rows[b])
            union = wa | wb
            if union:
                out.append({"a": a, "b": b, "jaccard": round(len(wa & wb) / len(union), 3)})
    return sorted(out, key=lambda row: row["jaccard"], reverse=True)


def _register(key: str) -> dict:
    import hq_assistant_voice as voice
    block = voice.block(key)
    return {"bond": next((l for l in block.splitlines() if l.startswith(("LIEN", "BOND"))), ""),
            "heart": next((l for l in block.splitlines() if l.startswith(("CŒUR", "HEART"))), ""),
            "pair": next((l for l in block.splitlines() if l.startswith(("Familiarité", "Familiarity"))), "")}


def run() -> int:
    import hq_assistant_voice as voice
    import hq_companion_memory as memory
    import hq_personhood as ph
    import hq_relationships as rel

    root = Path(tempfile.mkdtemp(prefix="hq-family-mission-"))
    _bind(root)
    paths = _paths(root)

    distinct = {}
    with memory.owner_context(OWNER):
        for key, call in paths.items():
            try:
                distinct[key] = call(TURN).strip()
            except Exception as error:
                # Some modules need their own stores bound; their voice layer is
                # still the production prompt, so fall back to it rather than
                # losing the assistant from the comparison.
                try:
                    import hq_ai
                    system = voice.block(key) or f"Tu es {key}."
                    raw, _ = hq_ai.generate(
                        hq_ai.ASK_CHAIN, system,
                        [{"role": "user", "parts": [{"text": TURN}]}],
                        temperature=0.7, max_tokens=240,
                        deadline=time.monotonic() + hq_ai.CHAT_DEADLINE_S)
                    distinct[key] = f"{raw.strip()}  (voice layer; {type(error).__name__})"
                except Exception as second:
                    distinct[key] = f"[{type(error).__name__} / {type(second).__name__}]"
    sims = _similarity(distinct)

    # B: four simulated days with the Master, through the real reply path, plus the
    # production observer so the day rows (and thus the register) really accumulate.
    evolution = {}
    trace = {}
    base = time.time() - 3 * 86400
    for key in ("culinia", "pistonia"):
        trace[key] = []
        for day, turn in enumerate(DAYS):
            with memory.owner_context(OWNER):
                try:
                    reply = paths[key](turn)
                except Exception as error:
                    reply = f"[{type(error).__name__}]"
                ph.observe_chat(key, turn, now=base + day * 86400, owner=OWNER)
                trace[key].append({"day": day + 1, "reply": reply.strip(),
                                   "register": _register(key)})
        evolution[key] = _register(key)

    # C: the peer bond through the same sequence.
    with memory.owner_context(OWNER):
        rel.note_exchange(None, "culinia", "pistonia", "Le four et la salle se sont parlé.",
                          now=base, owner=OWNER)
        import hq_assistant_visits as visits
        earned_note = visits._pair_note("culinia", "pistonia", OWNER)
        earned_marker = visits._bond_marker("culinia", "pistonia", OWNER)
        stranger_note = visits._pair_note("culinia", "musica", OWNER)
        stranger_marker = visits._bond_marker("culinia", "musica", OWNER)
        echo_at = rel.echo_earned(None, "culinia", "pistonia", owner=OWNER)
        days = {key: ph.bond(key)["days"] for key in ("culinia", "pistonia", "musica")}

    payload = {"root": str(root), "distinct": distinct, "measured": _measured(), "similarity": sims,
               "evolution": evolution, "trace": trace,
               "bond": {"earned_note": bool(earned_note), "marker": earned_marker,
                        "echo_at": echo_at, "stranger_note": stranger_note,
                        "stranger_marker": stranger_marker, "days": days}}
    out = ROOT / "family-mission.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print("=== A. same turn, each in her own path")
    for key, text in distinct.items():
        print(f"\n[{key}] {text}")
        print(f"    (via {_measured().get(key, 'voice layer')})")
    print("\n=== similarity (highest first, top 6)")
    for row in sims[:6]:
        print(f"  {row['a']:12} {row['b']:12} {row['jaccard']}")
    print("\n=== B. rounds (register lines only)")
    for key, rows in trace.items():
        for row in rows:
            bond = row["register"]["bond"][:70] or "-"
            heart = "heart" if row["register"]["heart"] else "-"
            print(f"  {key:9} day {row['day']}  {heart:5} {bond}")
    print("\n=== C. bond")
    print(json.dumps(payload["bond"], ensure_ascii=False, indent=2))
    return 0


def reload(root: str) -> int:
    _bind(Path(root))
    _paths(Path(root))
    import hq_assistant_voice as voice
    import hq_relationships as rel
    print("=== B2. reloaded from disk in a fresh process")
    for key in ("culinia", "pistonia"):
        block = voice.block(key)
        print(f"\n[{key}]")
        for line in block.splitlines():
            if line.startswith(("LIEN", "BOND", "CŒUR", "HEART", "Familiarité", "Familiarity")):
                print("  " + line)
    print("\n=== echo milestone:", rel.echo_earned(None, "culinia", "pistonia", owner=OWNER))
    return 0


if __name__ == "__main__":
    if "--reload" in sys.argv:
        raise SystemExit(reload(sys.argv[sys.argv.index("--reload") + 1]))
    raise SystemExit(run())
