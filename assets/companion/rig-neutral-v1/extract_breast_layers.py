"""Anatomical breast masks from source.jpg (512×512). Hand-traced lobe boundaries."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "source.jpg"
OUT_LEFT = ROOT / "breast-left.png"
OUT_RIGHT = ROOT / "breast-right.png"
OUT_PREVIEW = ROOT / "breast-preview.png"
OUT_OFFSET = ROOT / "breast-offset-preview.png"
OUT_CHECKER = ROOT / "breast-checker-preview.png"
OUT_CHECKER_LEFT = ROOT / "breast-checker-left.png"
OUT_CHECKER_RIGHT = ROOT / "breast-checker-right.png"
OUT_NOTES = ROOT / "breast-extraction-notes.txt"

# Traced on source.jpg — canvas-left lobe (rig bust-left / ~34% pivot).
# Inner edge follows cleavage (convex toward center); outer edge follows rib/bras.
LEFT_POLY = [
    # Follow the user's red reference from the outer shoulder round the whole
    # visible lobe and cup. Pixels occluded by hair cannot be reconstructed.
    (68.0, 332.0), (82.0, 317.0), (100.0, 304.0), (124.0, 293.0),
    (137.0, 280.0), (168.0, 278.0),     (199.0, 280.0),     (230.0, 285.0), (248.0, 288.0), (258.0, 296.0), (265.0, 312.0),
    (262.0, 322.0), (252.0, 332.0), (245.0, 324.0), (238.0, 347.0),
    (230.0, 382.0), (226.0, 412.0), (236.0, 442.0), (218.0, 462.0),
    (194.0, 476.0), (165.0, 486.0), (133.0, 490.0), (100.0, 486.0),
    (71.0, 472.0), (50.0, 448.0), (41.0, 409.0), (42.0, 379.0),
    (48.0, 354.0),
]

RIGHT_POLY = [
    (246.0, 327.0), (252.0, 332.0), (238.0, 325.0), (234.0, 308.0), (242.0, 296.0), (254.0, 288.0),
    (279.0, 286.0), (313.0, 285.0), (344.0, 282.0), (372.0, 289.0), (392.0, 306.0), (406.0, 326.0),
    (418.0, 351.0), (429.0, 380.0), (432.0, 408.0), (425.0, 438.0),
    (409.0, 466.0), (383.0, 482.0), (354.0, 490.0), (322.0, 488.0),
    (291.0, 478.0), (267.0, 458.0), (249.0, 436.0), (244.0, 399.0), (247.0, 369.0),
]


def _densify(points: list[tuple[float, float]], steps: int = 6) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    n = len(points)
    for i in range(n):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % n]
        for s in range(steps):
            t = s / steps
            out.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
    return out


def _poly_mask(size: int, polygon: list[tuple[float, float]]) -> np.ndarray:
    img = Image.new("L", (size, size), 0)
    ImageDraw.Draw(img).polygon(_densify(polygon, 8), fill=255)
    arr = np.asarray(img, dtype=np.float32) / 255.0
    img = Image.fromarray((arr * 255).astype(np.uint8), mode="L")
    img = img.filter(ImageFilter.GaussianBlur(radius=4.0))
    return np.asarray(img, dtype=np.float32) / 255.0


def _anisotropic_refeather_rgba(
    rgba: np.ndarray,
    top_blur: float = 2.8,
    side_harden: float = 0.8,
) -> np.ndarray:
    """Soft blend at the upper root only; keep cleavage/outer/under edges crisp."""
    h, w = rgba.shape[:2]
    a = rgba[:, :, 3].astype(np.float32) / 255.0
    mask = a > 0.04
    if not mask.any():
        return rgba
    ys_m, xs_m = np.where(mask)
    y0, y1 = float(ys_m.min()), float(ys_m.max())
    x0, x1 = float(xs_m.min()), float(xs_m.max())
    cy = (y0 + y1) * 0.5
    cx = (x0 + x1) * 0.5
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    top = np.clip((cy - ys) / max(18.0, (y1 - y0) * 0.28), 0.0, 1.0)
    outer = np.clip(np.abs(xs - cx) / max(12.0, (x1 - x0) * 0.42), 0.0, 1.0)
    under = np.clip((ys - cy) / max(14.0, (y1 - y0) * 0.35), 0.0, 1.0)
    soft_w = np.clip(top * (1.0 - outer * 0.85) * (1.0 - under * 0.9), 0.0, 1.0)
    soft_a = np.asarray(
        Image.fromarray((a * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.GaussianBlur(radius=top_blur)
        ),
        dtype=np.float32,
    ) / 255.0
    hard_a = np.clip((a - 0.22) / 0.55, 0.0, 1.0) ** 0.72
    mixed = soft_a * soft_w + (a * (1.0 - side_harden) + hard_a * side_harden) * (1.0 - soft_w)
    mixed = np.maximum(mixed * (a > 0.01), a * 0.15 * (a > 0.01))
    out = rgba.copy()
    out[:, :, 3] = np.clip(mixed * 255.0, 0, 255).astype(np.uint8)
    return out


def _feather_alpha_edges_box(
    rgba: np.ndarray,
    box_radius: float = 4.2,
    passes: int = 5,
    under_boost: float = 2.35,
) -> np.ndarray:
    """Box-blurred alpha on lobe edges (not Gaussian); stronger under the curve."""
    h, w = rgba.shape[:2]
    a = rgba[:, :, 3].astype(np.float32) / 255.0
    vis = a > 0.03
    if not vis.any():
        return rgba

    blurred = np.clip(a, 0.0, 1.0)
    for _ in range(passes):
        blurred = np.asarray(
            Image.fromarray((blurred * 255.0).astype(np.uint8), mode="L").filter(
                ImageFilter.BoxBlur(box_radius)
            ),
            dtype=np.float32,
        ) / 255.0

    ys_idx = np.where(vis)[0]
    xs_idx = np.where(vis)[1]
    y0, y1 = float(ys_idx.min()), float(ys_idx.max())
    x0, x1 = float(xs_idx.min()), float(xs_idx.max())
    ys = np.mgrid[0:h, 0:w].astype(np.float32)[0]
    xs = np.mgrid[0:h, 0:w].astype(np.float32)[1]
    cx = float(xs_idx.mean())
    outer_left = cx < w * 0.5

    rim = ((a > 0.04) & (a < 0.97)).astype(np.float32)
    rim *= np.clip((a - 0.04) / 0.22, 0.0, 1.0) * np.clip((0.97 - a) / 0.28, 0.0, 1.0)
    rim = np.maximum(rim, ((a > 0.55) & (a < 1.0)).astype(np.float32) * 0.35)

    under = np.clip((ys - (y1 - 28.0)) / 20.0, 0.0, 1.0) ** 1.05
    under *= np.clip((y1 - ys) / 16.0, 0.0, 1.0)
    if outer_left:
        lateral = np.clip((x0 + 26.0 - xs) / 22.0, 0.0, 1.0)
    else:
        lateral = np.clip((xs - (x1 - 26.0)) / 22.0, 0.0, 1.0)
    lateral *= np.clip((ys - (y0 + 12.0)) / 20.0, 0.0, 1.0) * np.clip((y1 - ys) / 18.0, 0.0, 1.0)
    lateral_wide = np.zeros_like(lateral)
    if outer_left:
        lateral_wide = np.clip((x0 + 40.0 - xs) / 26.0, 0.0, 1.0)
        lateral_wide *= np.clip((ys - (y0 + 8.0)) / 18.0, 0.0, 1.0) * np.clip((y1 - ys) / 14.0, 0.0, 1.0)
    else:
        lateral = lateral * 0.82

    w = np.clip(rim * (1.0 + under * (under_boost - 1.0)), 0.0, 1.0)
    w = np.maximum(w, (under * (a > 0.02).astype(np.float32) * 0.92))
    w = np.maximum(w, lateral * (a > 0.02).astype(np.float32) * (0.9 if outer_left else 0.62))
    w = np.maximum(w, lateral_wide * (a > 0.02).astype(np.float32) * 0.76)

    mixed = a * (1.0 - w) + blurred * w
    interior = a > 0.93
    mixed = np.where(interior, a, mixed)
    mixed = np.clip(mixed, 0.0, 1.0)

    out = rgba.copy()
    out[:, :, 3] = (mixed * 255.0).astype(np.uint8)
    return out


def _defringe_edge_slivers(rgba: np.ndarray, src: np.ndarray, *, outer_left: bool) -> np.ndarray:
    """Remove pale spill on lower + outer lobe edges (straight-alpha halos)."""
    h, w = rgba.shape[:2]
    rgb = rgba[:, :, :3].astype(np.float32)
    a = rgba[:, :, 3].astype(np.float32) / 255.0
    ref = src.astype(np.float32)
    vis = a > 0.02
    if not vis.any():
        return rgba
    ys_m, xs_m = np.where(vis)
    y0, y1 = float(ys_m.min()), float(ys_m.max())
    x0, x1 = float(xs_m.min()), float(xs_m.max())
    ys = np.mgrid[0:h, 0:w].astype(np.float32)[0]
    xs = np.mgrid[0:h, 0:w].astype(np.float32)[1]

    bottom = ys >= (y1 - 28.0)
    if outer_left:
        lat_mix = np.clip((x0 + 44.0 - xs) / 24.0, 0.0, 1.0)
        side_zone = (xs <= (x0 + 44.0)) & (ys >= (y0 + 10.0)) & (ys <= (y1 - 26.0))
        # Keep the outer under-curve; only tame the center underboob.
        bottom_zone = bottom & (xs >= (x0 + 22.0))
        protect_bottom_outer = (xs <= (x0 + 52.0)) & (ys >= (y1 - 30.0))
    else:
        lat_mix = np.clip((xs - (x1 - 28.0)) / 20.0, 0.0, 1.0)
        side_zone = (xs >= (x1 - 28.0)) & (ys >= (y0 + 10.0)) & (ys <= (y1 - 22.0))
        bottom_zone = bottom & (xs <= (x1 - 18.0))
        protect_bottom_outer = np.zeros_like(bottom, dtype=bool)

    edge = ((bottom_zone | side_zone) & (a > 0.025) & (a < 0.94))

    bg = np.array([255.0, 246.0, 250.0], dtype=np.float32)
    safe_a = np.clip(a, 0.09, 1.0)
    for c in range(3):
        unspill = (rgb[:, :, c] - (1.0 - a) * bg[c]) / safe_a
        rgb[:, :, c] = np.where(edge, np.clip(unspill, 0.0, 255.0), rgb[:, :, c])

    toward_bottom = np.clip((ys - (y1 - 24.0)) / 12.0, 0.0, 1.0) * (1.0 - np.clip(a, 0.0, 1.0))
    toward_bottom = bottom_zone.astype(np.float32) * toward_bottom * (0.55 if outer_left else 0.78)
    lat_pull = 0.88 if outer_left else 0.62
    toward_lat = side_zone.astype(np.float32) * lat_mix * (1.0 - np.clip(a, 0.0, 1.0)) * lat_pull
    toward_src = np.clip(toward_bottom + toward_lat, 0.0, 1.0)
    for c in range(3):
        rgb[:, :, c] = np.clip(rgb[:, :, c] * (1.0 - toward_src) + ref[:, :, c] * toward_src, 0, 255)

    lum = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]
    a_out = a.copy()

    if outer_left:
        pale = (side_zone & (a < 0.52) & (lum > 128.0)) | (bottom_zone & (a < 0.45) & (lum > 138.0))
        a_out[pale] *= 0.48
    else:
        pale = (side_zone | bottom_zone) & (a < 0.48) & (lum > 132.0)
        a_out[pale] *= 0.55

    warm_outer = side_zone & (a > 0.07) & (a < (0.52 if outer_left else 0.38)) & (lum > 116.0)
    warm_outer &= rgb[:, :, 0] > rgb[:, :, 2] + 10.0
    a_out[warm_outer] *= 0.32 if outer_left else 0.52
    for c in range(3):
        rgb[:, :, c] = np.where(warm_outer, ref[:, :, c] * 0.92 + rgb[:, :, c] * 0.08, rgb[:, :, c])

    if outer_left:
        ghost = side_zone & (a > 0.03) & (a < 0.32) & (lum > 112.0)
        a_out[ghost] = 0.0
        for c in range(3):
            rgb[:, :, c] = np.where(ghost, ref[:, :, c], rgb[:, :, c])
        outer_rim = (xs <= (x0 + 22.0)) & side_zone & (a > 0.12) & (lum > 112.0) & (lum < 220.0)
        rim_w = np.clip((x0 + 22.0 - xs) / 14.0, 0.0, 1.0) * outer_rim.astype(np.float32)
        peach = (rgb[:, :, 0] > rgb[:, :, 1] + 8.0) & outer_rim
        rim_w = np.where(peach, np.minimum(rim_w * 1.15, 1.0), rim_w) * 0.88
        for c in range(3):
            rgb[:, :, c] = np.clip(rgb[:, :, c] * (1.0 - rim_w) + ref[:, :, c] * rim_w, 0, 255)
        wispy = (xs <= (x0 + 16.0)) & side_zone
        wispy &= (a > 0.012) & (a < 0.45) & (lum > 106.0)
        a_out[wispy] = 0.0
        for c in range(3):
            rgb[:, :, c] = np.where(wispy, ref[:, :, c], rgb[:, :, c])
    else:
        ghost = side_zone & (a > 0.04) & (a < 0.15) & (lum > 142.0)
        a_out[ghost] *= 0.35
        for c in range(3):
            rgb[:, :, c] = np.where(ghost, ref[:, :, c] * 0.88 + rgb[:, :, c] * 0.12, rgb[:, :, c])

    if outer_left:
        tail_b = bottom_zone & (ys >= y1 - 8.0) & (a < 0.72)
        a_out[tail_b] = np.minimum(a_out[tail_b], a[tail_b] * 0.86)
    else:
        tail_b = bottom & (ys >= y1 - 9.0) & (a < 0.8)
        a_out[tail_b] = np.minimum(a_out[tail_b], a[tail_b] * 0.72)
    tail_l = side_zone & (lat_mix > 0.3) & (a < (0.78 if outer_left else 0.42))
    a_out[tail_l] = np.minimum(a_out[tail_l], a[tail_l] * (0.68 if outer_left else 0.78))
    a_out[protect_bottom_outer] = a[protect_bottom_outer]

    out = rgba.copy()
    out[:, :, :3] = rgb.astype(np.uint8)
    out[:, :, 3] = np.clip(a_out * 255.0, 0, 255).astype(np.uint8)
    return out


def _harmonize_root_rgb(rgba: np.ndarray, src: np.ndarray) -> np.ndarray:
    """Pull feathered upper-root pixels toward torso source color (removes gray halo)."""
    h, w = rgba.shape[:2]
    rgb = rgba[:, :, :3].astype(np.float32)
    a = rgba[:, :, 3].astype(np.float32) / 255.0
    ref = src.astype(np.float32)
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    mask = a > 0.04
    if not mask.any():
        return rgba
    ys_m = np.where(mask)[0]
    y0, y1 = float(ys_m.min()), float(ys_m.max())
    cy = (y0 + y1) * 0.5
    top = np.clip((cy - ys) / max(16.0, (y1 - y0) * 0.32), 0.0, 1.0)
    soft = (a > 0.05) & (a < 0.92)
    feather = (1.0 - np.abs(a - 0.5) * 2.0) * top * soft.astype(np.float32)
    feather = np.asarray(
        Image.fromarray((np.clip(feather, 0, 1) * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.GaussianBlur(radius=2.2)
        ),
        dtype=np.float32,
    ) / 255.0
    out = rgba.copy()
    for c in range(3):
        out[:, :, c] = np.clip(rgb[:, :, c] * (1.0 - feather * 0.72) + ref[:, :, c] * feather * 0.72, 0, 255).astype(
            np.uint8
        )
    return out


def _lift_skin_midtones(rgba: np.ndarray, gain: float = 1.07) -> np.ndarray:
    """Gentle L/R balance on pale skin only (right lobe tends darker in source)."""
    rgb = rgba[:, :, :3].astype(np.float32)
    a = rgba[:, :, 3].astype(np.float32) / 255.0
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    skin = (r > 150.0) & (g > 98.0) & (b > 72.0) & (r - g < 58.0) & (a > 0.2)
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    mid = skin & (lum > 72.0) & (lum < 210.0)
    w = mid.astype(np.float32) * a
    out = rgba.copy()
    for c in range(3):
        ch = rgb[:, :, c]
        out[:, :, c] = np.clip(ch + (ch * (gain - 1.0)) * w, 0, 255).astype(np.uint8)
    return out


def _apply_lace_contact_rgb(rgba: np.ndarray, strength: float = 0.32) -> np.ndarray:
    """Thin multiply band above lace scallops."""
    rgb = rgba[:, :, :3].astype(np.float32)
    a = rgba[:, :, 3].astype(np.float32) / 255.0
    lum = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]
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
    shade = np.clip(1.0 - band * strength, 0.72, 1.0)
    out = rgba.copy()
    for c in range(3):
        out[:, :, c] = np.clip(rgb[:, :, c] * shade, 0, 255).astype(np.uint8)
    return out


def _checker(size: int, cell: int = 16) -> Image.Image:
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    c1, c2 = (210, 210, 215), (118, 118, 128)
    for y in range(0, size, cell):
        for x in range(0, size, cell):
            draw.rectangle(
                [x, y, x + cell - 1, y + cell - 1],
                fill=c1 if ((x // cell) + (y // cell)) % 2 == 0 else c2,
            )
    return img


def _rgba(source: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    a = (np.clip(alpha, 0, 1) * 255).astype(np.uint8)
    return np.dstack([source, a]).astype(np.uint8)


def _paste_rgba(base: Image.Image, layer_rgba: np.ndarray, ox: int, oy: int) -> None:
    layer = Image.fromarray(layer_rgba, mode="RGBA")
    base.paste(layer, (ox, oy), layer)


def _attenuate_left_wall(src: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Fade set-dressing (wood wall) on the upper-outer lobe without hard geometric holes."""
    h, w = alpha.shape
    rgb = src.astype(np.float32)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    outer = np.clip((112.0 - xs) / 40.0, 0.0, 1.0) * np.clip((362.0 - ys) / 115.0, 0.0, 1.0)
    # Light oak trim near the hair gap.
    wall_hi = (
        (r > 136.0)
        & (g > 84.0)
        & (b < 104.0)
        & (r - b > 48.0)
        & (r - g > 38.0)
    )
    # Darker wall / door frame on the far outer edge.
    wall_lo = (
        (r > 104.0)
        & (r < 152.0)
        & (g > 68.0)
        & (b < 78.0)
        & (r - b > 40.0)
        & (g - b > 6.0)
    )
    skin = (r > 168.0) & (g > 112.0) & (b > 82.0) & (r - g < 52.0)
    lace = (r < 95.0) & (g < 85.0)
    hit = (wall_hi | (wall_lo & (xs < 96.0) & (ys < 332.0))) & ~skin & ~lace & (alpha > 0.04)
    score = hit.astype(np.float32) * outer
    score = np.asarray(
        Image.fromarray((np.clip(score, 0, 1) * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.GaussianBlur(radius=3.0)
        ),
        dtype=np.float32,
    ) / 255.0
    return alpha * (1.0 - score * 0.995)


def _cleavage_masks(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    seam = 256.0 + 5.0 * np.sin((ys - 285.0) * np.pi / 185.0)
    overlap = 24.0
    fade = 6.0
    left_cut = np.clip((xs - (seam + overlap)) / fade, 0.0, 1.0)
    right_cut = np.clip((seam - overlap - xs) / fade, 0.0, 1.0)
    left_m = 1.0 - left_cut
    right_m = 1.0 - right_cut
    return left_m, right_m


def _cleavage_seam_fill(left_a: np.ndarray, right_a: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Keep a soft solid strip on the seam so compositing never shows background."""
    h, w = left_a.shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    seam = 256.0 + 5.0 * np.sin((ys - 285.0) * np.pi / 185.0)
    dx = np.abs(xs - seam)
    band = np.clip(1.0 - dx / 9.0, 0.0, 1.0)
    band *= np.clip((ys - 272.0) / 6.0, 0.0, 1.0) * np.clip((408.0 - ys) / 10.0, 0.0, 1.0)
    band = np.asarray(
        Image.fromarray((band * 255).astype(np.uint8), mode="L").filter(
            ImageFilter.GaussianBlur(radius=1.4)
        ),
        dtype=np.float32,
    ) / 255.0
    need = 0.992 * band
    pair = np.maximum(left_a, right_a)
    lift = np.maximum(need, pair * band)
    left = np.maximum(left_a, lift)
    right = np.maximum(right_a, lift)
    return left, right


def main() -> None:
    src = np.asarray(Image.open(SOURCE).convert("RGB"))
    assert src.shape == (512, 512, 3)

    left_a = _poly_mask(512, LEFT_POLY)
    left_a = _attenuate_left_wall(src, left_a)
    right_a = _poly_mask(512, RIGHT_POLY)
    left_m, right_m = _cleavage_masks(*left_a.shape)
    left_a *= left_m
    right_a *= right_m
    left_a, right_a = _cleavage_seam_fill(left_a, right_a)
    left_rgba = _rgba(src, left_a)
    right_rgba = _rgba(src, right_a)
    left_rgba = _anisotropic_refeather_rgba(left_rgba)
    right_rgba = _anisotropic_refeather_rgba(right_rgba)
    left_rgba = _feather_alpha_edges_box(left_rgba)
    right_rgba = _feather_alpha_edges_box(right_rgba)
    left_rgba = _defringe_edge_slivers(left_rgba, src, outer_left=True)
    right_rgba = _defringe_edge_slivers(right_rgba, src, outer_left=False)
    left_rgba = _harmonize_root_rgb(left_rgba, src)
    right_rgba = _harmonize_root_rgb(right_rgba, src)
    left_rgba = _apply_lace_contact_rgb(left_rgba)
    right_rgba = _apply_lace_contact_rgb(right_rgba)
    right_rgba = _lift_skin_midtones(right_rgba, 1.08)

    Image.fromarray(left_rgba, mode="RGBA").save(OUT_LEFT)
    Image.fromarray(right_rgba, mode="RGBA").save(OUT_RIGHT)

    checker = _checker(512)
    left_chk = checker.copy()
    right_chk = checker.copy()
    _paste_rgba(left_chk, left_rgba, 0, 0)
    _paste_rgba(right_chk, right_rgba, 0, 0)
    left_chk.save(OUT_CHECKER_LEFT)
    right_chk.save(OUT_CHECKER_RIGHT)
    combo = Image.new("RGB", (1024, 512), (32, 28, 36))
    combo.paste(left_chk, (0, 0))
    combo.paste(right_chk, (512, 0))
    combo.save(OUT_CHECKER)

    off_dx, off_dy = 8, 6
    offset = Image.fromarray(src.copy())
    _paste_rgba(offset, left_rgba, off_dx, off_dy)
    _paste_rgba(offset, right_rgba, -off_dx, off_dy)
    offset.save(OUT_OFFSET)

    stack = Image.fromarray(src.copy())
    _paste_rgba(stack, left_rgba, 0, 0)
    _paste_rgba(stack, right_rgba, 0, 0)

    preview = Image.new("RGB", (1024, 1024), (32, 28, 36))
    preview.paste(Image.fromarray(src), (0, 0))
    preview.paste(left_chk, (512, 0))
    preview.paste(right_chk, (0, 512))
    preview.paste(stack, (512, 512))
    preview.save(OUT_PREVIEW)

    overlap = (left_a > 0.05) & (right_a > 0.05)
    notes = [
        "Découpe seins v9 — bottom + outer-side pale spill removal on PNG edges.",
        "Découpe seins v8 — stronger box edge feather + bottom pale spill removal.",
        "Découpe seins v7 — box-blurred alpha edges (extra under curve; not Gaussian).",
        "Découpe seins v6 — tighter poly blur, root color harmonize, right skin lift.",
        "Découpe seins v5 — anisotropic alpha feather + lace rim contact (extract_breast_layers.py).",
        "Découpe seins v4 — contours calés sur le tracé rouge fourni, sur source.jpg (512×512).",
        "Pas de contour garment-front.svg ; pas de Voronoi comme frontière finale.",
        "",
        "Fichiers : breast-left.png, breast-right.png.",
        "Aperçus :",
        "  • breast-checker-preview.png — gauche | droite sur damier contrasté",
        "  • breast-preview.png — grille (source | gauche damier | droite damier | superposition)",
        "  • breast-offset-preview.png — calques décalés ±8 px / ±6 px (test fuites)",
        "",
        f"Chevauchement L∩R (alpha>0.05) : {int(overlap.sum())} px",
        "",
        "Mouvement propre (translate / slosh modéré) :",
        "  • Ces découpes suivent le contour demandé ; tester sur le rig avant tout slosh ample.",
        "  • Léger scale autour du pivot rig (~34% / ~67% à ~76% hauteur).",
        "",
        "Limites sans inpainting :",
        "  • Le contour rouge traverse des cheveux, un peu de fond et l'épaule déjà visibles dans la photo plate.",
        "    Ces pixels restent dans les PNG ; les retirer laisserait des trous sans peinture du volume caché.",
        "  • Haut : peau sous les cheveux hors masque → pull vers le haut = gap.",
        "  • Sillon : seulement pixels visibles ; pas de volume caché sous le nœud central.",
        "  • Flanc externe : bord adouci ~1.35 px ; grand écart latéral expose le fond.",
        "  • Bas : le bonnet est coupé avant le corsage ; stretch vertical ample peut montrer une couture.",
        "",
        "Utiliser breast-offset-preview.png pour juger ; recomposite = source ne suffit pas.",
        "",
        "Lecture du test décalé (±8 px H, ±6 px V) :",
        "  • Double peau / dentelle au sillon → frontières internes à affiner.",
        "  • Trou en damier dans un lobe → bord coupé trop court (peau ou bonnet manquant).",
        "  • Halo blanc ou cheveux qui glissent seuls → pixels hors lobe à retirer du masque.",
        "  • Gap vertical au centre après décalage → normal si les lobes sont disjoints ;",
        "    agrandir le slosh si la couture devient visible en usage normal.",
    ]
    OUT_NOTES.write_text("\n".join(notes) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_LEFT.name}, {OUT_RIGHT.name}, and previews in {ROOT}")


if __name__ == "__main__":
    main()
