"""Rename reaction OGGs to content-fingerprinted filenames and rewrite manifest URLs."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from elevenlabs_sound_design_common import BANK, ROOT  # noqa: E402
from reaction_ogg_preset import collect_manifest_urls, rewrite_manifest_urls  # noqa: E402
from slim_reaction_manifest import write_runtime_manifest  # noqa: E402

HASH_LEN = 8
FINGERPRINT_RE = re.compile(r"^(.+)\.[0-9a-f]{8}\.ogg$", re.I)
PREFIX = "/assets/companion/chat/reactions/"


def file_fingerprint(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:HASH_LEN]


def base_stem(filename: str) -> str:
    name = filename[:-4] if filename.lower().endswith(".ogg") else filename
    m = re.match(rf"^(.+)\.[0-9a-f]{{{HASH_LEN}}}$", name, re.I)
    return m.group(1) if m else name


def fingerprinted_name(path: Path) -> str:
    stem = base_stem(path.name)
    return f"{stem}.{file_fingerprint(path)}.ogg"


def url_for_path(path: Path) -> str:
    rel = path.relative_to(BANK).as_posix()
    return PREFIX + rel


def apply_url_map(obj, mapping: dict[str, str]) -> None:
    rewrite_manifest_urls(obj, mapping)


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


def apply_fingerprints(revision: str = "2026-11-04-fp", *, dry_run: bool = False) -> int:
    manifest_path = BANK / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    urls = sorted(u for u in collect_manifest_urls(manifest) if u.endswith(".ogg"))
    url_map: dict[str, str] = {}
    renamed = 0

    for url in urls:
        src = ROOT / url.lstrip("/")
        if not src.is_file():
            continue
        target_name = fingerprinted_name(src)
        dest = src.with_name(target_name)
        new_url = url_for_path(dest)
        if src.name == target_name and url == new_url:
            continue
        url_map[url] = new_url
        if dry_run:
            renamed += 1
            continue
        if dest.resolve() != src.resolve():
            if dest.exists() and dest.resolve() != src.resolve():
                dest.unlink()
            src.rename(dest)
        renamed += 1

    if url_map and not dry_run:
        apply_url_map(manifest, url_map)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        write_runtime_manifest()
        bump_revision(revision)
        live = set(collect_manifest_urls(json.loads(manifest_path.read_text(encoding="utf-8"))))
        for path in BANK.rglob("*.ogg"):
            if "elevenlabs_" not in str(path):
                continue
            old_url = url_for_path(path)
            if old_url not in live and not FINGERPRINT_RE.match(path.name):
                path.unlink(missing_ok=True)
    return renamed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", default="2026-11-04-fp")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    renamed = apply_fingerprints(args.revision, dry_run=args.dry_run)
    print(f"renamed={renamed}")


if __name__ == "__main__":
    main()
