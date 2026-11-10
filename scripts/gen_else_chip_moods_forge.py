#!/usr/bin/env python3
"""Generate Else chip mood portraits via local Forge img2img (127.0.0.1:7860).

Goal: vivid expression + energy per mood — not rigid geometric head locks.
Mild post-pose only; life comes from prompt/denoise, CSS handles living motion.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "companion"
SRC = OUT / "else-chip@2x.webp"
DEFAULT_FORGE = "http://127.0.0.1:7860"

BASE_PROMPT = (
    "masterpiece, best quality, anime portrait, same character identity, "
    "dark brown skin, long bubblegum pink hair flowing dynamically, "
    "black flower hair clips, glowing cyan blue eyes with bright highlights, "
    "black futuristic bodysuit with vivid pink circuit lines, "
    "purple diamond emblem on collarbone, dramatic pink energy aura, "
    "rich saturated colors, dynamic lighting, highly detailed face"
)
NEG = (
    "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, "
    "fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, "
    "watermark, username, blurry, deformed, ugly, different person, race change, "
    "pale skin, blonde, different outfit, dull colors, flat lighting, lifeless expression, "
    "stiff pose, mannequin face, vacant stare"
)

MOODS = {
    "listening": {
        "prompt": BASE_PROMPT + ", soft half-lidded eyes, gentle attentive smile, "
        "warm blush, head softly inclined, calm teal rim light, quiet intimate mood",
        "denoising": 0.62,
        "seed": 91011,
        "pose": {"rotate": -5, "pan_x": -0.03, "pan_y": 0.02, "zoom": 1.06},
    },
    "speaking": {
        "prompt": BASE_PROMPT + ", (mouth open mid-speech:1.45), lively sparkling eyes, "
        "animated talking expression, bright key light, energetic hair motion, vivid glow",
        "denoising": 0.66,
        "seed": 92022,
        "pose": {"rotate": 4, "pan_x": 0.03, "pan_y": -0.05, "zoom": 1.08},
    },
    "proactive": {
        "prompt": BASE_PROMPT + ", (playful smirk:1.45), (sparkling eyes:1.3), raised eyebrow, "
        "cheeky teasing vibe, wind-swept hair, explosive magenta energy streaks, high contrast",
        "denoising": 0.68,
        "seed": 93033,
        "pose": {"rotate": 6, "pan_x": 0.05, "pan_y": -0.02, "zoom": 1.05},
    },
    "sister": {
        "prompt": BASE_PROMPT + ", (warm genuine smile:1.5), soft blush, affectionate eyes, "
        "leaning closer, tender glow, soft magenta bloom, inviting warmth",
        "denoising": 0.64,
        "seed": 94044,
        "pose": {"rotate": -4, "pan_x": 0.01, "pan_y": 0.0, "zoom": 1.12},
    },
    "busy": {
        "prompt": BASE_PROMPT + ", focused narrowed eyes, slight frown of concentration, "
        "looking down at work, cooler violet lighting, dense swirling energy, intense mood",
        "denoising": 0.62,
        "seed": 95055,
        "pose": {"rotate": 5, "pan_x": -0.04, "pan_y": 0.08, "zoom": 1.05},
    },
}


def post_json(forge: str, path: str, payload: dict, timeout: int = 300) -> dict:
    raw = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        forge.rstrip("/") + path,
        data=raw,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def image_to_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def decode_image(b64: str) -> Image.Image:
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def bake_pose(
    img: Image.Image,
    rotate: float = 0.0,
    pan_x: float = 0.0,
    pan_y: float = 0.0,
    zoom: float = 1.0,
) -> Image.Image:
    w, h = img.size
    pad = int(max(w, h) * 0.4)
    canvas = Image.new("RGB", (w + 2 * pad, h + 2 * pad), (18, 8, 28))
    canvas.paste(img, (pad, pad))
    rotated = canvas.rotate(rotate, resample=Image.Resampling.BICUBIC, expand=False)
    cw, ch = rotated.size
    side = max(32, int(min(w, h) / max(zoom, 1.0)))
    cx = cw // 2 + int(pan_x * w)
    cy = ch // 2 + int(pan_y * h)
    left = min(max(0, cx - side // 2), cw - side)
    top = min(max(0, cy - side // 2), ch - side)
    cropped = rotated.crop((left, top, left + side, top + side))
    return cropped.resize((w, h), Image.Resampling.LANCZOS)


def save_pair(mood: str, img: Image.Image, size1: tuple[int, int], size2: tuple[int, int]) -> None:
    a = img.resize(size1, Image.Resampling.LANCZOS)
    b = img.resize(size2, Image.Resampling.LANCZOS)
    a.save(OUT / f"else-chip-{mood}.webp", "WEBP", quality=88, method=6)
    b.save(OUT / f"else-chip-{mood}@2x.webp", "WEBP", quality=88, method=6)
    print(f"  wrote else-chip-{mood}.webp + @2x ({a.size} / {b.size})")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--forge", default=DEFAULT_FORGE)
    parser.add_argument("--moods", nargs="*", default=list(MOODS))
    parser.add_argument("--steps", type=int, default=32)
    parser.add_argument("--cfg", type=float, default=7.0)
    args = parser.parse_args()
    forge = args.forge

    if not SRC.is_file():
        print("missing source", SRC, file=sys.stderr)
        return 1

    try:
        with urllib.request.urlopen(forge.rstrip("/") + "/sdapi/v1/options", timeout=8) as r:
            opts = json.loads(r.read().decode())
        print("Forge OK · model:", opts.get("sd_model_checkpoint"))
    except Exception as exc:
        print("Forge unreachable:", exc, file=sys.stderr)
        return 1

    base = Image.open(OUT / "else-chip.webp").convert("RGB")
    base2 = Image.open(SRC).convert("RGB")
    w, h = base2.size
    side = 1024 if max(w, h) >= 1024 else 768
    init_b64 = image_to_b64(SRC)

    for mood in args.moods:
        spec = MOODS.get(mood)
        if not spec:
            print("skip unknown mood", mood)
            continue
        pose = dict(spec.get("pose") or {})
        print(f"img2img · {mood} · denoise={spec['denoising']} · soft pose rot={pose.get('rotate', 0)}")
        payload = {
            "init_images": [init_b64],
            "resize_mode": 0,
            "denoising_strength": spec["denoising"],
            "prompt": spec["prompt"],
            "negative_prompt": NEG,
            "steps": args.steps,
            "cfg_scale": args.cfg,
            "width": side,
            "height": side,
            "sampler_name": "Euler a",
            "scheduler": "Automatic",
            "seed": int(spec.get("seed", -1)),
            "n_iter": 1,
            "batch_size": 1,
            "restore_faces": False,
            "do_not_save_samples": True,
            "do_not_save_grid": True,
        }
        try:
            out = post_json(forge, "/sdapi/v1/img2img", payload, timeout=420)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:500]
            print(f"  FAIL {mood}: HTTP {exc.code} {body}", file=sys.stderr)
            return 1
        except Exception as exc:
            print(f"  FAIL {mood}: {exc}", file=sys.stderr)
            return 1
        images = out.get("images") or []
        if not images:
            print(f"  FAIL {mood}: no images", file=sys.stderr)
            return 1
        img = bake_pose(decode_image(images[0]), **pose)
        save_pair(mood, img, base.size, base2.size)
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
