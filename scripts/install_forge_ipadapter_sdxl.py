#!/usr/bin/env py3
"""Download SDXL IP-Adapter Face + CLIP vision encoder into local Forge folders."""
from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

FORGE_ROOT = Path(r"C:\AI\stable-diffusion-webui-forge")
CN_DIR = FORGE_ROOT / "models" / "ControlNet"
CLIP_DIR = FORGE_ROOT / "models" / "ControlNetPreprocessor" / "clip_vision"

DOWNLOADS = (
    (
        "https://huggingface.co/h94/IP-Adapter/resolve/main/sdxl_models/ip-adapter-plus-face_sdxl_vit-h.safetensors",
        CN_DIR / "ip-adapter-plus-face_sdxl_vit-h.safetensors",
    ),
    (
        "https://huggingface.co/h94/IP-Adapter/resolve/main/sdxl_models/image_encoder/model.safetensors",
        CLIP_DIR / "CLIP-ViT-bigG.safetensors",
    ),
)


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and dest.stat().st_size > 10_000_000:
        print(f"skip (exists): {dest.name} ({dest.stat().st_size // (1024 * 1024)} MiB)")
        return
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"download: {url}")
    print(f"    -> {dest}")
    req = urllib.request.Request(url, headers={"User-Agent": "TransfertHQ-forge-install/1"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        total = int(resp.headers.get("Content-Length") or 0)
        h = hashlib.sha256()
        done = 0
        with tmp.open("wb") as out:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                h.update(chunk)
                done += len(chunk)
                if total:
                    pct = 100 * done / total
                    print(f"\r    {done // (1024 * 1024)} / {total // (1024 * 1024)} MiB ({pct:.1f}%)", end="", flush=True)
        print()
    tmp.replace(dest)
    print(f"    sha256 {h.hexdigest()[:16]}…")


def main() -> int:
    if not FORGE_ROOT.is_dir():
        print(f"Forge not found at {FORGE_ROOT}", file=sys.stderr)
        return 2
    for url, path in DOWNLOADS:
        try:
            download(url, path)
        except Exception as exc:
            print(f"FAIL {path.name}: {exc}", file=sys.stderr)
            return 1
    print("OK — restart Forge or click ControlNet « Refresh » so model_list updates.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
