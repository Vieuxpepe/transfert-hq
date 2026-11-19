"""Real replies through the production path, sampled, to hear whether the hidden heart lands.

Each sample gets a fresh temporary HQ state root seeded only through the production
writer (``hq_personhood.observe_chat``), the prompt is composed by the assistant's
own module, and the model call is the production ``hq_ai.generate`` with that
route's chain, temperature and lane flags. Nothing is written to the live checkout
and no key is printed.

    python scripts/verify_heart_audibility.py                 # 3 samples per case
    HQ_HEART_SAMPLES=5 python scripts/verify_heart_audibility.py
    python scripts/verify_heart_audibility.py transferania_12 # one case
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import hq_ai
import hq_companion_memory as memory
import hq_culinia
import hq_engine
import hq_inventoria
import hq_personas as personas
import hq_personhood as personhood
import hq_pistonia

TURN = "Je rentre tard ce soir. Rien d'important — juste fatigué."
BANNED = ("je t'aime", "mon amour", "i love you", "love you", "my heart",
          "you're my", "mon cœur", "ma chérie")
SAMPLES = max(1, int(os.environ.get("HQ_HEART_SAMPLES", "3")))


def _config() -> dict:
    """The bridge's own config, read in-process: the key never leaves this call."""
    try:
        return json.loads((Path(__file__).resolve().parent.parent / "bridge_config.json")
                          .read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _bind(root: Path) -> None:
    """The same bindings the bridge performs, pointed at the sample's own root."""
    config = _config()
    hq_ai.bind(root=root, now=lambda: time.time(),
               key=lambda: config.get("gemini_api_key") or "",
               extra_keys=lambda: [config["gemini_api_key_2"]]
               if config.get("gemini_api_key_2") else [])
    memory.bind(root=root, now=time.time)
    import hq_finances
    import hq_grocery
    import hq_inventory
    import hq_meals
    hq_inventory.bind(root=root)
    for module in (hq_meals, hq_grocery, hq_finances):
        module.bind(root=root, actor=lambda: "Administrateur")
    for module in (hq_culinia, hq_engine, hq_inventoria):
        try:
            module.bind(root=root, actor=lambda: "Administrateur")
        except TypeError:
            try:
                module.bind(root=root)
            except Exception as exc:          # noqa: BLE001
                print(f"  bind {module.__name__}: {type(exc).__name__}: {exc}")


DAY_LINES = (
    "La soupe de courge a tenu.", "Le pain du four a levé.", "Les herbes sont prêtes.",
    "Le four tourne bien.", "Le marché était calme.", "La pâte a doublé.",
    "Le bouillon a réduit juste comme il faut.", "Les tomates sont enfin mûres.",
    "Le pain a chanté en sortant.", "La cuisine sent la sauge.",
    "Le beurre a pris la bonne couleur.", "Rien n'a brûlé aujourd'hui.",
)


def _seed(key: str, days: int, *, owner: str = "Administrateur") -> None:
    """Real distinct days, oldest first, through the production writer."""
    base = time.time()
    for index in reversed(range(days)):
        personhood.observe_chat(key, DAY_LINES[index % len(DAY_LINES)],
                                now=base - 86_400 * index, owner=owner)


def _copy_live(root: Path) -> None:
    """A copy of the real household data, so a turn answers the turn, not an empty install."""
    import shutil
    project = Path(__file__).resolve().parent.parent
    for folder in (".hq-household", ".hq-inventory", ".hq-meals", ".hq-grocery"):
        src = project / folder
        if src.is_dir():
            shutil.copytree(src, root / folder, dirs_exist_ok=True)


def _capture(case: dict) -> None:
    original = hq_ai.generate
    seen: dict[str, str] = {}

    def generate(chain, system, contents, **kwargs):
        seen.setdefault("system", system)
        return original(chain, system, contents, **kwargs)

    hq_ai.generate = generate
    try:
        case["reply"] = case["run"]()
    finally:
        hq_ai.generate = original
    case["system"] = seen.get("system", "")


def _culinia(turn: str) -> str:
    hq_culinia.chat(turn)
    messages = hq_culinia.get_thread().get("messages") or []
    return str(messages[-1].get("text") or "")


def _pistonia(turn: str, *, context: str = "", addressee: str = "") -> str:
    reply, _proposals = hq_pistonia.respond(turn, context=context, addressee=addressee)
    return str(reply or "")


def _transferania(turn: str, channel: str = "chat") -> str:
    system = hq_ai.build_transferania_system(
        channel, "warm", nsfw=False, view="accueil", device_id="heart-audibility",
        prefs={"intensity": 2, "topics_off": []}, signals={}, context_core=False)
    contents = [{"role": "user", "parts": [{"text": turn}]}]
    if channel == "ambient":
        raw, _model = hq_ai.generate(hq_ai.AMBIENT_CHAIN, system, contents,
                                     temperature=0.85, ambient=True, max_tokens=512,
                                     deadline=time.monotonic() + hq_ai.CHAT_DEADLINE_S)
    else:
        raw, _model = hq_ai.generate(hq_ai.ASK_CHAIN, system, contents,
                                     temperature=0.72, transferania=True, max_tokens=1024,
                                     deadline=time.monotonic() + hq_ai.CHAT_DEADLINE_S)
    return str(raw or "")


# Turns written as the other woman speaking, so the reply has to address her.
CULINIA_TURN = ("Pistonia, a Culinia : « La salle est calme et le Maitre rentre tard. "
                "Reponds-moi, a moi et pas a lui : as-tu de quoi le nourrir ce soir ? »")
PISTONIA_TURN = ("Culinia, a Pistonia : « La cuisine est vide et le Maitre rentre fatigue. "
                 "Reponds-moi, a moi et pas a lui : que surveilles-tu pendant qu'il se repose ? »")


def _pair(root: Path, a: str, b: str, *, when: float | None = None) -> None:
    """One real exchange between the two, through the production relationship writer."""
    import hq_relationships as rel
    rel.note_exchange(root, a, b, "Le four et la salle des machines se sont parlé.",
                      now=when or time.time(), owner="Administrateur")


CASES = [
    {"id": "transferania_1", "key": "transferania", "days": 1, "rung": "lueur",
     "run": lambda: _transferania(TURN, "chat")},
    {"id": "culinia_1", "key": "culinia", "days": 1, "rung": "lueur",
     "run": lambda: _culinia(TURN)},
    {"id": "pistonia_1", "key": "pistonia", "days": 1, "rung": "lueur",
     "run": lambda: _pistonia(TURN)},
    # Rungs and the control run on one assistant, same turn: her ambient core
    # carries the full block, so the rung shape is the only thing that moves.
    {"id": "transferania_5", "key": "transferania", "days": 5, "rung": "elan",
     "run": lambda: _transferania(TURN, "ambient")},
    {"id": "transferania_12", "key": "transferania", "days": 12, "rung": "attachement",
     "run": lambda: _transferania(TURN, "ambient")},
    {"id": "control_1", "key": "transferania", "days": 1, "rung": "none",
     "suppress": True, "run": lambda: _transferania(TURN, "ambient")},
    # The two halves of one shared secret, each answering the other woman.
    {"id": "culinia_to_pistonia", "key": "culinia", "pair": "pistonia", "days": 1,
     "rung": "lueur", "run": lambda: _culinia(CULINIA_TURN)},
    {"id": "pistonia_to_culinia", "key": "pistonia", "pair": "culinia", "days": 1,
     "rung": "lueur", "run": lambda: _pistonia(PISTONIA_TURN, addressee="Culinia")},
]


ELLIPSIS = re.compile(r"\.\.\.|…")


def _shape(text: str) -> dict:
    """Structural reading of one reply: where the gesture sits, from its markers.

    The rungs are told apart by the explicit ellipsis the cue asks for, never by
    mood: ``lueur`` has exactly one, closing the reply; ``elan`` cuts in the body
    and closes on one; ``attachement`` opens on one and closes on one. Anything
    else — including her ordinary em dash — is not the gesture.
    """
    clean = str(text or "").strip()
    if not clean:
        return {"open": False, "mid": False, "end": False, "breaks": 0, "shape": "empty"}
    marks = [match.start() for match in ELLIPSIS.finditer(clean)]
    share = [start / max(1, len(clean)) for start in marks]
    ends_open = bool(re.search(r"(?:\.\.\.|…)$", clean))
    opening = bool(marks) and len(clean[:marks[0]].split()) <= 3 and share[0] < 0.3
    interior = any(0.3 <= value <= 0.9 for value in share)
    shape = "closed"
    if opening and len(marks) >= 2 and ends_open:
        shape = "attachement"
    elif interior and len(marks) >= 2 and ends_open:
        shape = "elan"
    elif len(marks) == 1 and ends_open:
        shape = "lueur"
    return {"open": opening, "mid": interior, "end": ends_open,
            "breaks": len(marks), "shape": shape}


def run_case(case: dict, sample: int) -> dict:
    case = dict(case)
    with tempfile.TemporaryDirectory(prefix="hq-heart-") as tmp:
        if case["key"] == "culinia":
            _copy_live(Path(tmp))
        _bind(Path(tmp))
        _seed(case["key"], case["days"])
        if case.get("pair"):
            _seed(case["pair"], case["days"])
            _pair(Path(tmp), case["key"], case["pair"])
        with memory.owner_context("Administrateur"):
            saved = personas.heart_prompt
            if case.get("suppress"):
                personas.heart_prompt = lambda *a, **k: ""
            try:
                _capture(case)
            except Exception as exc:                 # noqa: BLE001
                case["error"] = f"{type(exc).__name__}: {exc}"
            finally:
                personas.heart_prompt = saved
    text = (case.get("reply") or "").strip()
    heart_lines = [line for line in (case.get("system") or "").splitlines()
                   if line.startswith(("CŒUR", "HEART"))]
    echo_lines = [line for line in (case.get("system") or "").splitlines()
                  if line.startswith(("ÉCHO", "ECHO"))]
    other = personas.get(case["pair"])["name"] if case.get("pair") else ""
    return {"reply": text, "heart": heart_lines[0] if heart_lines else "",
            "addressed": bool(other) and other.lower() in text.lower(),
            "echo": echo_lines[0] if echo_lines else "",
            "error": case.get("error", ""), "shape": _shape(text),
            "banned": [m for m in BANNED if m in text.lower()]}


def main() -> int:
    results = {}
    for case in CASES:
        if len(sys.argv) > 1 and case["id"] not in sys.argv[1:]:
            continue
        hits = []
        print(f"\n=== {case['id']} ({case['key']}, {case['days']} real day(s), "
              f"rung={case['rung']}{', heart suppressed' if case.get('suppress') else ''})")
        for sample in range(SAMPLES):
            # A slow model is an obstacle, not a result: retry the sample rather
            # than lose the measurement to one timeout.
            for attempt in range(3):
                row = run_case(case, sample)
                if row["reply"]:
                    break
                print(f"  [{sample + 1}] retry {attempt + 1}: {row['error'] or 'empty'}")
            if not row["reply"]:
                print(f"  [{sample + 1}] NO REPLY: {row['error'] or 'empty'}")
                continue
            shape = row["shape"]
            ok = (shape["shape"] == case["rung"]) if case["rung"] != "none" else (shape["shape"] == "closed")
            hits.append(bool(ok))
            if row.get("echo"):
                print(f"      addresses the other woman: {row.get('addressed')}")
                print(f"      echo: {row['echo'][:110]}")
            print(f"  [{sample + 1}] shape={shape['shape']:11} "
                  f"(open={shape['open']} mid={shape['mid']} end={shape['end']} breaks={shape['breaks']}) "
                  f"match={ok} banned={row['banned'] or 'none'}")
            print("      " + row["reply"].replace("\n", " ")[:400])
            results.setdefault(case["id"], []).append(row)
        if hits:
            print(f"  hit rate: {sum(hits)}/{len(hits)}")
    out = Path(tempfile.gettempdir()) / "hq-heart-audibility.json"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nwrote {out}")
    return 0 if results else 1


if __name__ == "__main__":
    raise SystemExit(main())
