"""
Non-destructive bust "pop" preview for rig-neutral-v1.

Writes comparison strips under ./audit-previews/ without touching production PNGs.
Run:
  python audit_bust_pop_preview.py
Optional:
  python audit_bust_pop_preview.py --alpha-blur 3.5 --contact 0.42 --spec 0.55
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "audit-previews"
SOURCE = ROOT / "source.jpg"
LEFT = ROOT / "breast-left.png"
RIGHT = ROOT / "breast-right.png"


def _rgba(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGBA"), dtype=np.uint8)


def _composite(base_rgb: np.ndarray, *layers: np.ndarray) -> np.ndarray:
    out = base_rgb.astype(np.float32)
    for layer in layers:
        a = layer[:, :, 3:4].astype(np.float32) / 255.0
        out = out * (1.0 - a) + layer[:, :, :3].astype(np.float32) * a
    return np.clip(out, 0, 255).astype(np.uint8)


def anisotropic_refeather(
    rgba: np.ndarray,
    top_blur: float = 3.5,
    side_harden: float = 0.72,
) -> np.ndarray:
    """Keep soft blend on the upper root; restore contour on outer + cleavage edges."""
    h, w = rgba.shape[:2]
    a = rgba[:, :, 3].astype(np.float32) / 255.0
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)

    # Approximate lobe bbox from opaque pixels.
    mask = a > 0.04
    if not mask.any():
        return rgba
    ys_m, xs_m = np.where(mask)
    y0, y1 = float(ys_m.min()), float(ys_m.max())
    x0, x1 = float(xs_m.min()), float(xs_m.max())
    cy = (y0 + y1) * 0.5
    cx = (x0 + x1) * 0.5

    # Softness weight: high near top root, low on underside / outer curve / cleavage.
    top = np.clip((cy - ys) / max(18.0, (y1 - y0) * 0.28), 0.0, 1.0)
    outer = np.clip(np.abs(xs - cx) / max(12.0, (x1 - x0) * 0.42), 0.0, 1.0)
    under = np.clip((ys - cy) / max(14.0, (y1 - y0) * 0.35), 0.0, 1.0)
    soft_w = np.clip(top * (1.0 - outer * 0.85) * (1.0 - under * 0.9), 0.0, 1.0)

    soft = Image.fromarray((a * 255).astype(np.uint8), mode="L").filter(
        ImageFilter.GaussianBlur(radius=top_blur)
    )
    soft_a = np.asarray(soft, dtype=np.float32) / 255.0
    # Harden contour by pushing mid-alphas toward binary where soft_w is low.
    hard_a = np.clip((a - 0.22) / 0.55, 0.0, 1.0)
    hard_a = np.power(hard_a, 0.72)
    mixed = soft_a * soft_w + (a * (1.0 - side_harden) + hard_a * side_harden) * (1.0 - soft_w)
    mixed = np.maximum(mixed * (a > 0.01), a * 0.15 * (a > 0.01))

    out = rgba.copy()
    out[:, :, 3] = np.clip(mixed * 255.0, 0, 255).astype(np.uint8)
    return out


def contact_shadow_layer(
    left: np.ndarray,
    right: np.ndarray,
    strength: float = 0.42,
) -> np.ndarray:
    """Soft AO under cups + cleavage cleft (multiply candidate)."""
    a = np.maximum(left[:, :, 3], right[:, :, 3]).astype(np.float32) / 255.0
    h, w = a.shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    under = np.clip((ys - 390.0) / 70.0, 0.0, 1.0) * np.clip((470.0 - ys) / 40.0, 0.0, 1.0)
    cleft = np.exp(-((xs - 256.0) ** 2) / (2 * 14.0**2)) * np.clip((ys - 300.0) / 40.0, 0.0, 1.0)
    cleft *= np.clip((430.0 - ys) / 30.0, 0.0, 1.0)
    shade = np.clip(under * 0.75 + cleft * 1.15, 0.0, 1.0) * a
    shade = np.asarray(
        Image.fromarray((shade * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.GaussianBlur(radius=4.5)
        ),
        dtype=np.float32,
    ) / 255.0
    # Deep wine AO matching hair/shadow family in source.
    rgb = np.zeros((h, w, 3), dtype=np.float32)
    rgb[:, :, 0] = 45
    rgb[:, :, 1] = 12
    rgb[:, :, 2] = 24
    alpha = np.clip(shade * strength * 255.0, 0, 255)
    return np.dstack([rgb, alpha]).astype(np.uint8)


def specular_screen_overlay(
    left: np.ndarray,
    right: np.ndarray,
    strength: float = 0.55,
    lag_px: tuple[int, int] = (0, -2),
) -> np.ndarray:
    """Soft warm specular discs that can lag the lobes during pull previews."""
    h, w = 512, 512
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas, "RGBA")
    # Apex guesses from current lobe registration.
    hotspots = [(168, 348), (336, 352)]
    for cx, cy in hotspots:
        x = cx + lag_px[0]
        y = cy + lag_px[1]
        for r, a in ((18, 55), (10, 110), (5, 180)):
            col = (255, 236, 220, int(a * strength))
            draw.ellipse([x - r, y - r, x + r, y + r], fill=col)
    overlay = np.asarray(canvas.filter(ImageFilter.GaussianBlur(radius=2.2)), dtype=np.float32)
    # Mask to lobe coverage so highlights never float on jacket.
    cover = np.maximum(left[:, :, 3], right[:, :, 3]).astype(np.float32) / 255.0
    overlay[:, :, 3] *= cover
    return np.clip(overlay, 0, 255).astype(np.uint8)


def lace_contact_hint(left: np.ndarray, right: np.ndarray, strength: float = 0.35) -> np.ndarray:
    """Thin multiply band just above lace scallops (heuristic on luminance cliff)."""
    h, w = 512, 512
    out_a = np.zeros((h, w), dtype=np.float32)
    for lobe in (left, right):
        rgb = lobe[:, :, :3].astype(np.float32)
        a = lobe[:, :, 3].astype(np.float32) / 255.0
        lum = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]
        # Vertical luminance drop ≈ lace rim.
        d = np.zeros_like(lum)
        d[1:, :] = lum[:-1, :] - lum[1:, :]
        rim = (d > 28.0) & (a > 0.35) & (lum > 70.0)
        band = rim.astype(np.float32)
        band = np.asarray(
            Image.fromarray((band * 255).astype(np.uint8), mode="L").filter(
                ImageFilter.GaussianBlur(radius=1.6)
            ),
            dtype=np.float32,
        ) / 255.0
        out_a = np.maximum(out_a, band * a)
    rgb = np.zeros((h, w, 3), dtype=np.float32)
    rgb[:] = (52, 18, 28)
    return np.dstack([rgb, np.clip(out_a * strength * 255.0, 0, 255)]).astype(np.uint8)


def screen_blend(base: np.ndarray, overlay: np.ndarray) -> np.ndarray:
    b = base.astype(np.float32)
    o = overlay.astype(np.float32)
    a = o[:, :, 3:4] / 255.0
    screened = 255.0 - (255.0 - b) * (255.0 - o[:, :, :3]) / 255.0
    return np.clip(b * (1.0 - a) + screened * a, 0, 255).astype(np.uint8)


def multiply_blend(base: np.ndarray, overlay: np.ndarray) -> np.ndarray:
    b = base.astype(np.float32)
    o = overlay.astype(np.float32)
    a = o[:, :, 3:4] / 255.0
    mul = b * o[:, :, :3] / 255.0
    return np.clip(b * (1.0 - a) + mul * a, 0, 255).astype(np.uint8)


def label_strip(images: list[Image.Image], titles: list[str]) -> Image.Image:
    cell = 512
    pad = 28
    strip = Image.new("RGB", (cell * len(images), cell + pad), (28, 24, 32))
    draw = ImageDraw.Draw(strip)
    for i, (im, title) in enumerate(zip(images, titles)):
        strip.paste(im.convert("RGB"), (i * cell, pad))
        draw.text((i * cell + 12, 6), title, fill=(230, 220, 228))
    return strip


def main() -> None:
    ap = argparse.ArgumentParser(description="Non-destructive bust pop audit previews")
    ap.add_argument("--alpha-blur", type=float, default=3.5)
    ap.add_argument("--contact", type=float, default=0.42)
    ap.add_argument("--spec", type=float, default=0.55)
    ap.add_argument("--lace", type=float, default=0.35)
    args = ap.parse_args()

    OUT.mkdir(exist_ok=True)
    src = np.asarray(Image.open(SOURCE).convert("RGB"), dtype=np.uint8)
    left = _rgba(LEFT)
    right = _rgba(RIGHT)

    baseline = _composite(src, left, right)

    left_f = anisotropic_refeather(left, top_blur=args.alpha_blur)
    right_f = anisotropic_refeather(right, top_blur=args.alpha_blur)
    refeathered = _composite(src, left_f, right_f)

    contact = contact_shadow_layer(left_f, right_f, strength=args.contact)
    with_contact = multiply_blend(refeathered, contact)

    lace = lace_contact_hint(left_f, right_f, strength=args.lace)
    with_lace = multiply_blend(with_contact, lace)

    spec = specular_screen_overlay(left_f, right_f, strength=args.spec, lag_px=(0, -2))
    with_spec = screen_blend(with_lace, spec)

    # Offset stress test (same as breast-offset-preview deltas).
    offset = Image.fromarray(src.copy())
    for layer, ox, oy in ((left_f, 8, 6), (right_f, -8, 6)):
        offset.paste(Image.fromarray(layer, "RGBA"), (ox, oy), Image.fromarray(layer, "RGBA"))

    Image.fromarray(left_f, "RGBA").save(OUT / "breast-left-aniso.png")
    Image.fromarray(right_f, "RGBA").save(OUT / "breast-right-aniso.png")
    Image.fromarray(baseline).save(OUT / "01-baseline.jpg", quality=92)
    Image.fromarray(refeathered).save(OUT / "02-aniso-feather.jpg", quality=92)
    Image.fromarray(with_contact).save(OUT / "03-contact-ao.jpg", quality=92)
    Image.fromarray(with_lace).save(OUT / "04-lace-microshadow.jpg", quality=92)
    Image.fromarray(with_spec).save(OUT / "05-specular-screen.jpg", quality=92)
    offset.save(OUT / "06-offset-aniso.jpg", quality=92)

    strip = label_strip(
        [
            Image.fromarray(baseline),
            Image.fromarray(refeathered),
            Image.fromarray(with_contact),
            Image.fromarray(with_spec),
        ],
        ["baseline", "aniso feather", "+ contact AO", "+ lace + specular"],
    )
    strip.save(OUT / "compare-strip.jpg", quality=92)

    css_snippet = OUT / "suggested-css-snippet.txt"
    css_snippet.write_text(
        """/* Paste into DevTools on .hq-companion-rig-bust-left/right for live A/B */
.hq-companion.has-layered-portrait.is-nsfw .hq-companion-rig-bust-left,
.hq-companion.has-layered-portrait.is-nsfw .hq-companion-rig-bust-right {
  --rig-bust-lobe-scale: 1.12; /* was 1.1 — tiny mass bump */
  filter:
    drop-shadow(0 0.5px 0.6px rgba(28, 8, 14, 0.55))   /* sharp contact */
    drop-shadow(0 3px 6px rgba(45, 12, 24, 0.22))      /* soft ambient */
    drop-shadow(0 8px 14px rgba(45, 12, 24, 0.10));    /* far falloff */
}

/* Optional sheen sibling (screen) — lag highlight during pull via JS */
.hq-companion-rig-bust-sheen {
  pointer-events: none;
  mix-blend-mode: screen;
  opacity: calc(0.35 + var(--pull-tension, 0) * 0.25);
  background:
    radial-gradient(circle at 33% 66%, rgba(255,236,220,0.55) 0 2%, transparent 9%),
    radial-gradient(circle at 66% 67%, rgba(255,236,220,0.48) 0 2%, transparent 9%);
  filter: blur(1.2px);
  transform: translate3d(var(--rig-sheen-x, 0px), var(--rig-sheen-y, -1.5px), 0);
}

/* Pull squash/stretch — widen lobe ranges slightly (JS clamps today ~0.9–1.12) */
/* --pull-lobe-sy: 0.88 .. 1.18 ; --pull-lobe-sx: 0.94 .. 1.16 */
""",
        encoding="utf-8",
    )

    print(f"Wrote previews to {OUT}")
    print("Open compare-strip.jpg first, then 01..05 for stepwise deltas.")


if __name__ == "__main__":
    main()
