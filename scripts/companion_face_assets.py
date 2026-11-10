"""Keep the companion face runtime image in sync with its source artwork.

Source of truth: assets/companion/rig-neutral-v1/face.svg, a 512x512 wrapper that places the
embedded 1254x1254 face.png at x=25.6 y=-5.12 width=460.8 height=419.84 (not the full box).
Runtime image: face.webp, loaded by hq-companion.js / hq-companion-mouth.js for every face layer.

face.webp must therefore be the *laid out* face (the PNG pasted inside the 512 box, pixels
untouched), not the raw PNG: a raw copy gets stretched to the whole box and the nose slides under
the animated mouth. Tagged images are cached for a day, so the ?v=pxN tag is bumped on every change.

    python scripts/companion_face_assets.py          # rebuild face.webp, bump the tag if it changed
    python scripts/companion_face_assets.py --check  # exit 1 when face.webp is stale
"""
from __future__ import annotations

import base64
import io
import re
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RIG = ROOT / "assets" / "companion" / "rig-neutral-v1"
FACE_PNG = RIG / "face.png"
FACE_SVG = RIG / "face.svg"
FACE_WEBP = RIG / "face.webp"
TAGGED_JS = (ROOT / "assets" / "hq-companion.js", ROOT / "assets" / "hq-companion-mouth.js")
TAG_RE = re.compile(r"\.webp\?v=px(\d+)")
# Placement of face.png inside the 512x512 rig box (shared with eyes-closed.svg).
FACE_PLACEMENT = {"x": "25.6", "y": "-5.12", "width": "460.8", "height": "419.84"}


def write_face_svg(png_path: Path = FACE_PNG, svg_path: Path = FACE_SVG) -> None:
    b64 = base64.b64encode(png_path.read_bytes()).decode("ascii")
    p = FACE_PLACEMENT
    svg_path.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">\n'
        f'<image href="data:image/png;base64,{b64}" x="{p["x"]}" y="{p["y"]}" width="{p["width"]}" '
        f'height="{p["height"]}" preserveAspectRatio="none"/>\n</svg>\n',
        encoding="utf-8", newline="\n",
    )


def read_face_svg(svg_path: Path = FACE_SVG):
    """Return (embedded RGBA image, placement dict of floats, (box_w, box_h))."""
    text = svg_path.read_text(encoding="utf-8")
    tag = re.search(r"<image\b[^>]*>", text)
    if not tag:
        raise ValueError(f"{svg_path}: no <image>")
    attrs = dict(re.findall(r'([\w:-]+)="([^"]*)"', tag.group(0)))
    data = attrs.get("href") or attrs.get("xlink:href") or ""
    if "base64," not in data:
        raise ValueError(f"{svg_path}: <image> has no embedded base64 data")
    image = Image.open(io.BytesIO(base64.b64decode(data.split("base64,", 1)[1]))).convert("RGBA")
    box = re.search(r'viewBox="\s*0[ ,]+0[ ,]+([\d.]+)[ ,]+([\d.]+)', text)
    if not box:
        raise ValueError(f"{svg_path}: expected a viewBox starting at 0 0")
    placement = {k: float(attrs.get(k, 0)) for k in ("x", "y", "width", "height")}
    return image, placement, (float(box.group(1)), float(box.group(2)))


def layout_face(svg_path: Path = FACE_SVG) -> Image.Image:
    """The face as the SVG wrapper draws it: embedded pixels pasted 1:1 into the scaled rig box."""
    image, at, (box_w, box_h) = read_face_svg(svg_path)
    sx, sy = image.width / at["width"], image.height / at["height"]
    canvas = Image.new("RGBA", (round(box_w * sx), round(box_h * sy)), (0, 0, 0, 0))
    canvas.paste(image, (round(at["x"] * sx), round(at["y"] * sy)))
    return canvas


def face_webp_is_current(svg_path: Path = FACE_SVG, webp_path: Path = FACE_WEBP) -> bool:
    if not webp_path.is_file():
        return False
    want = layout_face(svg_path)
    with Image.open(webp_path) as have:
        have = have.convert("RGBA")
        return have.size == want.size and have.tobytes() == want.tobytes()


def current_tag() -> int:
    tags = {int(n) for path in TAGGED_JS for n in TAG_RE.findall(path.read_text(encoding="utf-8"))}
    if len(tags) != 1:
        raise ValueError(f"expected one shared ?v=pxN tag in {[p.name for p in TAGGED_JS]}, found {sorted(tags)}")
    return tags.pop()


def bump_tag() -> int:
    """Bump ?v=pxN in both scripts. Bytes in, bytes out: CRLF line endings are preserved."""
    new = current_tag() + 1
    for path in TAGGED_JS:
        raw = path.read_bytes()
        path.write_bytes(re.sub(rb"\.webp\?v=px\d+", b".webp?v=px%d" % new, raw))
    return new


def sync_face_webp() -> bool:
    """Rebuild face.webp from face.svg when stale and bump the cache tag. True when it changed."""
    if face_webp_is_current():
        return False
    layout_face().save(FACE_WEBP, format="WEBP", lossless=True, exact=True, method=6)
    if not face_webp_is_current():
        raise RuntimeError("face.webp does not round-trip losslessly")
    bump_tag()
    return True


def main(argv: list[str]) -> int:
    if "--check" in argv:
        ok = face_webp_is_current()
        print("face.webp is current" if ok else "face.webp is STALE: run python scripts/companion_face_assets.py")
        return 0 if ok else 1
    if "--from-png" in argv:
        write_face_svg()
        print("face.svg re-encoded from face.png")
    changed = sync_face_webp()
    print(f"face.webp rebuilt, cache tag is now px{current_tag()}" if changed else f"face.webp already current (px{current_tag()})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
