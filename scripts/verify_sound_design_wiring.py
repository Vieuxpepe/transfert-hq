"""Verify sound-design catalog entries exist on disk and in manifest pools."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
cat = json.loads((ROOT / "scripts/elevenlabs_sound_design_catalog.json").read_text(encoding="utf-8"))
man = json.loads((ROOT / "assets/companion/chat/reactions/manifest.json").read_text(encoding="utf-8"))
bank = cat["bank_folder"]
needle = f"/{bank}/"


def pool_urls(section: str, event: str) -> set[str]:
    pool = (man.get(section) or {}).get(event)
    if not pool:
        return set()
    items = pool if isinstance(pool, list) else [pool]
    return {item["url"] for item in items}


js = (ROOT / "assets/hq-companion-reaction-audio.js").read_text(encoding="utf-8")
kinds = set(re.findall(r"'([^']+)'", re.search(r"const kinds=\[(.*?)\]", js, re.S).group(1)))
phase_kinds = set(re.findall(r"'([^']+)'", re.search(r"const phaseKinds=\[(.*?)\]", js, re.S).group(1)))

missing_files: list[str] = []
unwired: list[tuple] = []
bad_kind: list[tuple] = []

for clip in cat["clips"]:
    stem = Path(clip["file"].replace(".mp3", "").lower().replace("_-_", "_")).stem
    urls = pool_urls(clip["section"], clip["event"])
    matching = [u for u in urls if f"/{bank}/{stem}." in u and re.search(r"\.[0-9a-f]{8}\.ogg$", u)]
    if not matching:
        missing_files.append(f"{bank}/{stem}.*.ogg")
        unwired.append((clip["file"], clip["section"], clip["event"]))
    else:
        url = matching[0]
        path = ROOT / "assets/companion/chat/reactions" / bank / url.split("/")[-1]
        if not path.is_file():
            missing_files.append(url)
    if clip["section"] == "samples" and clip["event"] not in kinds:
        bad_kind.append((clip["file"], clip["event"], "samples"))
    if clip["section"] == "phases" and clip["event"] not in phase_kinds:
        bad_kind.append((clip["file"], clip["event"], "phases"))

ctx_missing = [
    s["source"]
    for s in man.get("import", {}).get("sources", [])
    if needle in s.get("url", "") and s.get("context") not in (man.get("contexts") or {})
]

regex_ok = "elevenlabs_[0-9]+" in js

print(f"catalog_clips={len(cat['clips'])}")
print(f"missing_ogg={len(missing_files)}")
print(f"unwired_manifest={len(unwired)}")
print(f"unknown_kinds={len(bad_kind)}")
print(f"context_gaps={len(ctx_missing)}")
print(f"reaction_url_regex_includes_dated_banks={regex_ok}")
if missing_files:
    print("missing:", missing_files[:5])
if unwired:
    print("unwired:", unwired[:5])
if bad_kind:
    print("bad_kind:", bad_kind[:5])
raise SystemExit(1 if any([missing_files, unwired, bad_kind, ctx_missing]) else 0)
