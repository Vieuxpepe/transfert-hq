"""Transcode reaction bank to arcade_soft30 OGG; keep manifest URLs and metadata in sync."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from reaction_ogg_preset import (  # noqa: E402
    collect_manifest_urls,
    encode_reaction_ogg,
    mastering_metadata,
    rewrite_manifest_urls,
    wav_url_to_ogg,
)
from elevenlabs_sound_design_common import ROOT, BANK  # noqa: E402

ARTIFACTS = ROOT / "artifacts" / "elevenlabs-sound-design-src"
BACKUP_WAV = ROOT / "artifacts/before-voice-mastering-20261103/recordings"
JIGGLE_MP3 = ROOT / "assets/companion/jiggle"
REVISION = "2026-11-04-ogg"


def source_for_url(url: str, manifest: dict, ogg_path: Path) -> Path | None:
    """Best lossless-ish source for re-encode: MP3 export, backup WAV, then existing OGG."""
    for entry in manifest.get("import", {}).get("sources", []) or []:
        if entry.get("url") != url:
            continue
        src_name = entry.get("source")
        if not src_name:
            break
        for base in (ARTIFACTS, JIGGLE_MP3):
            candidate = base / src_name
            if candidate.is_file():
                return candidate

    backup = BACKUP_WAV / f"{ogg_path.stem}.wav"
    if backup.is_file():
        return backup

    if ogg_path.is_file():
        return ogg_path
    return None


def bump_revision(revision: str) -> None:
    (BANK / "manifest.revision").write_text(revision + "\n", encoding="utf-8")
    reaction_js = ROOT / "assets/hq-companion-reaction-audio.js"
    text = reaction_js.read_text(encoding="utf-8")
    text = re.sub(
        r"const MANIFEST_REVISION='[^']*';",
        f"const MANIFEST_REVISION='{revision}';",
        text,
        count=1,
    )
    reaction_js.write_text(text, encoding="utf-8")


def patch_sample_meta(manifest: dict, url: str, duration_ms: int) -> None:
    meta = mastering_metadata()

    def walk(node):
        if isinstance(node, dict):
            if node.get("url") == url:
                node["duration_ms"] = duration_ms
                node["mastering"] = {**meta, "duration_ms": duration_ms}
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(manifest)


def reencode_manifest_oggs(
    manifest: dict,
    ffmpeg: str,
    ffprobe: str,
    *,
    dry_run: bool,
) -> tuple[int, int, list[str]]:
    urls = sorted(u for u in collect_manifest_urls(manifest) if u.endswith(".ogg"))
    encoded = 0
    failed: list[str] = []
    for url in urls:
        ogg_path = ROOT / url.lstrip("/")
        source = source_for_url(url, manifest, ogg_path)
        if source is None:
            failed.append(url)
            continue
        if dry_run:
            print(f"would reencode: {source.name} -> {ogg_path.name}")
            encoded += 1
            continue
        with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as tmp:
            temp_path = Path(tmp.name)
        try:
            result = encode_reaction_ogg(ffmpeg, source, temp_path, ffprobe=ffprobe)
            temp_path.replace(ogg_path)
            patch_sample_meta(manifest, url, result["duration_ms"])
            encoded += 1
        except (OSError, subprocess.CalledProcessError):
            failed.append(url)
            if temp_path.exists():
                temp_path.unlink(missing_ok=True)
    return encoded, len(urls), failed


def migrate_wav_urls(
    manifest: dict,
    ffmpeg: str,
    ffprobe: str,
    *,
    dry_run: bool,
    keep_wav: bool,
) -> tuple[int, int]:
    urls = sorted(u for u in collect_manifest_urls(manifest) if u.endswith(".wav"))
    url_map: dict[str, str] = {}
    encoded = 0
    skipped = 0
    for url in urls:
        wav_path = ROOT / url.lstrip("/")
        if not wav_path.is_file():
            skipped += 1
            continue
        ogg_url = wav_url_to_ogg(url)
        ogg_path = wav_path.with_suffix(".ogg")
        url_map[url] = ogg_url
        source = source_for_url(ogg_url, manifest, ogg_path) or wav_path
        if ogg_path.is_file() and ogg_path.stat().st_mtime >= wav_path.stat().st_mtime:
            if not keep_wav and not dry_run:
                wav_path.unlink(missing_ok=True)
            skipped += 1
            continue
        if dry_run:
            encoded += 1
            continue
        meta = encode_reaction_ogg(ffmpeg, source, ogg_path, ffprobe=ffprobe)
        patch_sample_meta(manifest, ogg_url, meta["duration_ms"])
        encoded += 1
        if not keep_wav:
            wav_path.unlink(missing_ok=True)
    if url_map and not dry_run:
        rewrite_manifest_urls(manifest, url_map)
    return encoded, skipped


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep-wav", action="store_true", help="Keep WAV files after OGG encode")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--reencode-all",
        action="store_true",
        help="Re-encode every manifest .ogg from MP3/backup WAV (arcade_soft30)",
    )
    parser.add_argument("--revision", default=REVISION)
    args = parser.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise SystemExit("ffmpeg and ffprobe are required")

    manifest_path = BANK / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    if args.reencode_all:
        encoded, total, failed = reencode_manifest_oggs(
            manifest, ffmpeg, ffprobe, dry_run=args.dry_run
        )
        if not args.dry_run:
            manifest.setdefault("mastering", {})
            manifest["mastering"]["delivery"] = "ogg_vorbis_arcade_soft30"
            manifest_path.write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            from slim_reaction_manifest import write_runtime_manifest

            print(f"manifest.runtime.json bytes={write_runtime_manifest()}")
            from fingerprint_reaction_oggs import apply_fingerprints

            apply_fingerprints(args.revision)
        print(f"reencode_total={total} encoded={encoded} failed={len(failed)}")
        if failed:
            print("failed:", failed[:10])
            raise SystemExit(1)
        return

    encoded, skipped = migrate_wav_urls(
        manifest,
        ffmpeg,
        ffprobe,
        dry_run=args.dry_run,
        keep_wav=args.keep_wav,
    )
    if not args.dry_run:
        manifest.setdefault("mastering", {})
        manifest["mastering"]["delivery"] = "ogg_vorbis_arcade_soft30"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        from slim_reaction_manifest import write_runtime_manifest

        print(f"manifest.runtime.json bytes={write_runtime_manifest()}")
        bump_revision(args.revision)
    print(f"wav_migration encoded={encoded} skipped={skipped}")


if __name__ == "__main__":
    main()
