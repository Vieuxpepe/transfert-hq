"""Integrate sound_expansion_catalog.json, merge available MP3s, refresh manifest contexts."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
CATALOG = SCRIPTS / "elevenlabs_sound_design_catalog.json"
EXPANSION = SCRIPTS / "sound_expansion_catalog.json"
MANIFEST = ROOT / "assets/companion/chat/reactions/manifest.json"

CONTEXTS = {
    "samples.purr": "Treat caress, purr synth fallback and contented contact",
    "samples.clink": "Champagne toast, crystal treat and UI clink synth fallback",
    "samples.pop": "Bubble pop, cupid board and playful pop synth fallback",
    "samples.pounce": "Playful pounce and cat-chirp synth fallback",
    "samples.dizzy": "Dizzy warble synth fallback",
    "samples.cupid": "Cupid sparkle and romantic treat synth fallback",
    "samples.ack": "Message received and lightweight acknowledgment",
    "samples.typing_backchannel": "Rare listening breath while the user types",
    "samples.celebrate": "Toast success and avatar celebrate moments",
    "samples.mock_scandal": "Flirt faux-shock and playful scandal reactions",
    "samples.booty_breath": "Low breath layer under booty grind phase gestures",
    "samples.gulp": "Oral depth swallow and throat gulp one-shots (dangle oral)",
    "samples.treat_coffee": "Coffee treat sip",
    "samples.treat_strawberry": "Strawberry treat bite",
    "samples.treat_rose": "Rose treat rustle",
    "samples.treat_champagne": "Champagne treat sip and clink",
    "impacts.grab": "Fabric grab and squeeze contact impacts",
    "impacts.tit_pull": "Breast pull / stretch grab foley (bust pull gesture)",
    "impacts.hair_pat": "Soft hair tuck and head pat impacts",
    "impacts.muffled": "Muffled clothing slaps (lighter than open slap pool)",
    "phases.afterglow_cooldown": "Post-climax cooldown spoken lines after warm tiers",
    "phases.tease_deny": "Edging tease without climax payoff lines",
    "phases.whisper_ear": "Whisper-in-ear phase and close breath lines",
}


def merge_catalog() -> int:
    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    extra = json.loads(EXPANSION.read_text(encoding="utf-8"))
    existing = {(c["file"], c["section"], c["event"]) for c in cat["clips"]}
    added = 0
    for clip in extra:
        key = (clip["file"], clip["section"], clip["event"])
        if key in existing:
            continue
        cat["clips"].append(clip)
        existing.add(key)
        added += 1
    CATALOG.write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return added


def patch_contexts() -> None:
    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    ctx = man.setdefault("contexts", {})
    ctx.update(CONTEXTS)
    MANIFEST.write_text(json.dumps(man, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def dedupe_muffled_from_slap() -> None:
    """Keep muffled takes in impacts.muffled only (also merged into slap via old catalog row)."""
    man = json.loads(MANIFEST.read_text(encoding="utf-8"))
    impacts = man.setdefault("impacts", {})
    slap = impacts.get("slap")
    muffled = impacts.get("muffled")
    if not slap:
        return
    slap_list = slap if isinstance(slap, list) else [slap]
    muffled_urls = {item["url"] for item in (muffled if isinstance(muffled, list) else [muffled] if muffled else [])}
    filtered = [item for item in slap_list if "muffled_slap" not in item.get("url", "")]
    if len(filtered) != len(slap_list):
        impacts["slap"] = filtered if len(filtered) != 1 else filtered[0]
        MANIFEST.write_text(json.dumps(man, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    added = merge_catalog()
    print(f"catalog_clips_added={added}")
    patch_contexts()
    src = ROOT / "artifacts" / "elevenlabs-sound-design-src"
    merge = SCRIPTS / "merge_elevenlabs_sound_design.py"
    if src.is_dir() and merge.is_file():
        rc = subprocess.call(
            [sys.executable, str(merge), str(src), "--skip-missing"],
            cwd=str(ROOT),
        )
        if rc != 0:
            print("merge_elevenlabs_sound_design failed (missing MP3s are ok until generated)")
    dedupe_muffled_from_slap()
    slim = SCRIPTS / "slim_reaction_manifest.py"
    fp = SCRIPTS / "fingerprint_reaction_oggs.py"
    if slim.is_file():
        subprocess.check_call([sys.executable, str(slim)], cwd=str(ROOT))
    if fp.is_file():
        subprocess.call([sys.executable, str(fp)], cwd=str(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
