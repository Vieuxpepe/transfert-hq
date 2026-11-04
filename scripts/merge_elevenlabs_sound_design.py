"""Merge generated MP3s into manifest.json (additive; does not wipe existing pools)."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from datetime import date
from pathlib import Path
import sys

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from elevenlabs_sound_design_common import (
    BANK,
    PREFIX,
    ROOT,
    as_list,
    audio_hash,
    load_catalog,
    load_mastering_profile,
    sample_key,
)
from reaction_ogg_preset import encode_reaction_ogg, mastering_metadata


def merge_pool(existing, additions: list[dict], replace_legacy: bool) -> list[dict]:
    pool = as_list(existing)
    if replace_legacy:
        pool = [item for item in pool if "elevenlabs_" in sample_key(item)]
    seen = {sample_key(item) for item in pool}
    for sample in additions:
        key = sample_key(sample)
        if key and key not in seen:
            pool.append(sample)
            seen.add(key)
    return pool


def strip_bank(manifest: dict, bank_folder: str) -> int:
    needle = f"/{bank_folder}/"
    removed = 0

    def scrub_pool(pool):
        nonlocal removed
        kept = []
        for item in as_list(pool):
            if needle in sample_key(item):
                removed += 1
            else:
                kept.append(item)
        return kept

    for section in ("samples", "phases", "impacts"):
        groups = manifest.get(section) or {}
        for key in list(groups.keys()):
            kept = scrub_pool(groups[key])
            if not kept:
                del groups[key]
            elif len(kept) == 1 and not isinstance(groups[key], list):
                groups[key] = kept[0]
            else:
                groups[key] = kept

    prior = manifest.get("import") or {}
    sources = prior.get("sources") or []
    filtered = [entry for entry in sources if needle not in str(entry.get("url") or "")]
    removed += len(sources) - len(filtered)
    prior["sources"] = filtered
    manifest["import"] = prior
    return removed


def main(source: Path, replace_bank: bool, skip_missing: bool = False) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is required")

    catalog = load_catalog()
    profile = load_mastering_profile()
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise SystemExit("ffprobe is required")
    bank_folder = catalog.get("bank_folder") or "elevenlabs_20261104"
    replace_kinds = set(catalog.get("replace_legacy_samples") or [])
    dest_dir = BANK / bank_folder
    dest_dir.mkdir(parents=True, exist_ok=True)

    manifest = json.loads((BANK / "manifest.json").read_text(encoding="utf-8"))
    if replace_bank:
        n = strip_bank(manifest, bank_folder)
        print(f"Removed {n} prior entries for {bank_folder}")

    by_target: dict[tuple[str, str], list[dict]] = {}
    imported_sources = []
    seen_audio: dict[str, dict] = {}

    for clip in catalog["clips"]:
        mp3 = source / clip["file"]
        if not mp3.exists():
            if skip_missing:
                print(f"skip missing: {clip['file']}")
                continue
            raise SystemExit(f"Missing source MP3: {mp3}")
        section = clip["section"]
        event = clip["event"]
        impact = bool(clip.get("impact")) or section == "impacts"
        digest = audio_hash(mp3)
        if digest not in seen_audio:
            ogg_name = mp3.stem.lower().replace("_-_", "_") + ".ogg"
            ogg_path = dest_dir / ogg_name
            mastering = encode_reaction_ogg(
                ffmpeg,
                mp3,
                ogg_path,
                ffprobe=ffprobe,
                loudness_class="impact" if impact else "voice",
            )
            duration = mastering.pop("duration_ms")
            mastering.pop("source", None)
            sample = {
                "url": PREFIX + bank_folder + "/" + ogg_name,
                "duration_ms": duration,
                "natural": True,
                "model": "eleven_v4",
                "mastering": mastering,
            }
            seen_audio[digest] = sample
        sample = seen_audio[digest]
        by_target.setdefault((section, event), []).append(sample)
        imported_sources.append(
            {
                "source": clip["file"],
                "source_sha256": hashlib.sha256(mp3.read_bytes()).hexdigest(),
                "audio_sha256": digest,
                "section": section,
                "event": event,
                "url": sample["url"],
                "context": f"{section}.{event}",
                "match_method": "Sound design catalog 2026-11-04 (Creative stability, High similarity)",
                "prompt": clip.get("text"),
            }
        )

    for (section, event), additions in by_target.items():
        replace = section == "samples" and event in replace_kinds
        if section == "samples":
            merged = merge_pool(manifest.setdefault("samples", {}).get(event), additions, replace)
            manifest["samples"][event] = merged
        elif section == "phases":
            merged = merge_pool(manifest.setdefault("phases", {}).get(event), additions, False)
            manifest["phases"][event] = merged
        elif section == "impacts":
            merged = merge_pool(manifest.setdefault("impacts", {}).get(event), additions, False)
            manifest["impacts"][event] = merged

    manifest["samples"]["laugh"] = manifest["samples"].get("giggle", manifest["samples"].get("laugh"))
    manifest["samples"]["exhale"] = manifest["samples"].get("contented", manifest["samples"].get("exhale"))
    for key in list(manifest.get("samples", {})):
        if key.startswith("pleasure_grunt") or key == "slap":
            del manifest["samples"][key]

    prior = manifest.get("import") or {}
    prior_sources = prior.get("sources") or []
    all_sources = prior_sources + imported_sources
    unique_urls = {entry["url"] for entry in all_sources if entry.get("url")}
    manifest["contexts"] = {
        **(manifest.get("contexts") or {}),
        **(catalog.get("contexts") or {}),
        "samples.hmm": "Thoughtful pause, idle acknowledgment and soft throat clears",
        "samples.questioning": "Curious or puzzled chat reactions",
        "samples.thinking": "Processing a tricky request before answering",
        "samples.sympathetic": "Comfort, empathy and gentle support",
    }
    manifest["import"] = {
        **prior,
        "date": date.today().isoformat(),
        "model": "eleven_v4",
        "files": len(all_sources),
        "unique_audio": len(unique_urls),
        "sound_design_batch": "2026-11-04-expressive",
        "sources": all_sources,
    }
    manifest["mastering"] = {
        **profile,
        **mastering_metadata(),
        "source": "original MP3 via arcade_soft30 OGG encode",
    }

    (BANK / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    batch_tag = manifest["import"].get("sound_design_batch") or date.today().isoformat()
    from slim_reaction_manifest import write_runtime_manifest

    runtime_bytes = write_runtime_manifest()
    print(f"manifest.runtime.json bytes={runtime_bytes}")
    from fingerprint_reaction_oggs import apply_fingerprints

    apply_fingerprints(batch_tag.strip())
    (BANK / "manifest.revision").write_text(batch_tag.strip() + "\n", encoding="utf-8")
    reaction_js = ROOT / "assets/hq-companion-reaction-audio.js"
    text = reaction_js.read_text(encoding="utf-8")
    text = re.sub(
        r"const MANIFEST_REVISION='[^']*';",
        f"const MANIFEST_REVISION='{batch_tag}';",
        text,
        count=1,
    )
    reaction_js.write_text(text, encoding="utf-8")
    print(f"Merged {len(imported_sources)} clips into {dest_dir.name}")
    for (section, event), additions in sorted(by_target.items()):
        print(f"  {section}.{event}: +{len(additions)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source",
        type=Path,
        nargs="?",
        default=Path(__file__).resolve().parents[1] / "artifacts" / "elevenlabs-sound-design-src",
    )
    parser.add_argument(
        "--replace-bank",
        action="store_true",
        help="Drop existing manifest entries and import rows for catalog bank_folder before merge",
    )
    parser.add_argument(
        "--skip-missing",
        action="store_true",
        help="Skip catalog clips whose MP3 is not in source (partial merge)",
    )
    args = parser.parse_args()
    main(args.source, replace_bank=args.replace_bank, skip_missing=args.skip_missing)
