"""Extract all vein centerlines from dangling-member.png (texture space).

Preferred: hand-drawn red centerlines in assets/dangling-member-veins-drawn.png
(same dimensions as dangling-member.png, transparent BG, bright red strokes ~2–4 px).

Fallback: automatic multi_ridge (noisy on mesh-like art).

Legacy left/right (+ dense) = longest DP ridge per side for palm trace.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]
PNG = ROOT / "assets" / "dangling-member.png"
# Optional: same pixel size as PNG (153×486). Transparent background, red centerlines only.
ANNOTATION = ROOT / "assets" / "dangling-member-veins-drawn.png"
OUT = ROOT / "assets" / "dangling-member-vein-paths.json"
JS_OUT = ROOT / "assets" / "dangling-member-vein-paths.js"
OVERLAY = ROOT / "docs" / "dangling-vein-paths-overlay.png"
VIEWER_HTML = ROOT / "docs" / "dangling-vein-paths-viewer.html"

ROW_STEP = 2
CONTINUITY = 2.75
KNOTS_UI = 24
KNOTS_DENSE = 80

# Multi-ridge peak linking
PEAK_MIN_SCORE = 28.0
LANE_BINS = 64
MAX_LANE_STEP = 0.24
MAX_MISS_ROWS = 5
MIN_TRACK_KNOTS = 8
MIN_T_SPAN = 0.10
DEDUPE_LANE = 0.055
PEAK_MERGE_LANE = 0.045


def vein_score(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    return (r - g) * 0.55 + (r - b) * 0.2 + np.clip(118.0 - lum, 0.0, 55.0) * 0.65


def decimate(path: list[tuple[float, float]], knots: int) -> list[list[float]]:
    if len(path) <= knots:
        return [[round(t, 4), round(l, 4)] for t, l in path]
    idx = np.linspace(0, len(path) - 1, knots).astype(int)
    return [[round(float(path[i][0]), 4), round(float(path[i][1]), 4)] for i in idx]


def score_at_lane(
    y: int,
    lane: float,
    center: np.ndarray,
    half: np.ndarray,
    scores: np.ndarray,
    mask: np.ndarray,
    w: int,
) -> float:
    if y < 0 or y >= scores.shape[0] or half[y] < 1.0:
        return -1e6
    x = center[y] + lane * half[y]
    xi = int(round(x))
    best = -1e6
    for dx in range(-3, 4):
        x2 = xi + dx
        if 0 <= x2 < w and mask[y, x2]:
            best = max(best, float(scores[y, x2]))
    return best


def trace_ridge_dp(
    y_rows: np.ndarray,
    lane_bins: np.ndarray,
    center: np.ndarray,
    half: np.ndarray,
    scores: np.ndarray,
    mask: np.ndarray,
    w: int,
    h: int,
    continuity: float,
) -> list[tuple[float, float]]:
    n = len(y_rows)
    m = len(lane_bins)
    if n < 2 or m < 2:
        return []

    cost = np.zeros((n, m), dtype=np.float64)
    for i, y in enumerate(y_rows):
        yi = int(y)
        for j, lane in enumerate(lane_bins):
            s = score_at_lane(yi, float(lane), center, half, scores, mask, w)
            cost[i, j] = 120.0 - s if s > -1e5 else 1e4

    dp = np.full((n, m), np.inf, dtype=np.float64)
    par = np.zeros((n, m), dtype=np.int32)
    dp[0] = cost[0]
    lane_bins_f = lane_bins.astype(np.float64)
    for i in range(1, n):
        prev = dp[i - 1]
        for j in range(m):
            dif = lane_bins_f[j] - lane_bins_f
            trans = prev + continuity * (dif * dif)
            k = int(np.argmin(trans))
            dp[i, j] = trans[k] + cost[i, j]
            par[i, j] = k

    j = int(np.argmin(dp[-1]))
    path_rev: list[tuple[float, float]] = []
    for i in range(n - 1, -1, -1):
        t = float(y_rows[i]) / (h - 1)
        path_rev.append((t, float(lane_bins[j])))
        j = int(par[i, j])
    path_rev.reverse()
    return path_rev


def peaks_at_row(
    y: int,
    center: np.ndarray,
    half: np.ndarray,
    scores: np.ndarray,
    mask: np.ndarray,
    w: int,
) -> list[tuple[float, float]]:
    if half[y] < 1.0:
        return []
    xs = np.where(mask[y])[0]
    if xs.size < 8:
        return []
    row_s = scores[y, xs]
    raw: list[tuple[float, float]] = []
    for i in range(1, len(xs) - 1):
        s = float(row_s[i])
        if s < PEAK_MIN_SCORE:
            continue
        if s < row_s[i - 1] or s < row_s[i + 1]:
            continue
        x = float(xs[i])
        lane = (x - center[y]) / half[y]
        if abs(lane) > 0.96:
            continue
        raw.append((lane, s))
    if not raw:
        return []
    raw.sort(key=lambda p: p[0])
    merged: list[tuple[float, float]] = []
    for lane, sc in raw:
        if merged and abs(lane - merged[-1][0]) < PEAK_MERGE_LANE:
            if sc > merged[-1][1]:
                merged[-1] = (lane, sc)
        else:
            merged.append((lane, sc))
    return merged


def trace_all_ridges(
    y_rows: np.ndarray,
    center: np.ndarray,
    half: np.ndarray,
    scores: np.ndarray,
    mask: np.ndarray,
    w: int,
    h: int,
) -> list[list[tuple[float, float]]]:
    active: list[dict] = []
    finished: list[list[tuple[float, float]]] = []

    for y in y_rows:
        t = float(y) / (h - 1)
        peaks = peaks_at_row(int(y), center, half, scores, mask, w)
        used: set[int] = set()

        active.sort(key=lambda tr: tr["last_score"], reverse=True)
        for tr in active:
            best_j = -1
            best_cost = 1e18
            tr_sign = tr.get("sign", -1 if tr["last_lane"] < 0 else 1)
            for j, (lane, sc) in enumerate(peaks):
                if j in used:
                    continue
                if tr_sign < 0 and lane > 0.04:
                    continue
                if tr_sign > 0 and lane < -0.04:
                    continue
                dl = lane - tr["last_lane"]
                if abs(dl) > MAX_LANE_STEP:
                    continue
                cost = abs(dl) * CONTINUITY * 4.0 - sc
                if cost < best_cost:
                    best_cost = cost
                    best_j = j
            if best_j >= 0:
                lane, sc = peaks[best_j]
                if "sign" not in tr:
                    tr["sign"] = -1 if lane < 0 else 1
                tr["knots"].append((t, lane))
                tr["last_lane"] = lane
                tr["last_score"] = sc
                tr["miss"] = 0
                used.add(best_j)
            else:
                tr["miss"] += 1

        still: list[dict] = []
        for tr in active:
            if tr["miss"] > MAX_MISS_ROWS:
                if len(tr["knots"]) >= MIN_TRACK_KNOTS:
                    finished.append(tr["knots"])
            else:
                still.append(tr)
        active = still

        for j, (lane, sc) in enumerate(peaks):
            if j in used:
                continue
            active.append(
                {
                    "knots": [(t, lane)],
                    "last_lane": lane,
                    "last_score": sc,
                    "miss": 0,
                    "sign": -1 if lane < 0 else 1,
                }
            )

    for tr in active:
        if len(tr["knots"]) >= MIN_TRACK_KNOTS:
            finished.append(tr["knots"])

    return finished


def path_mean_score(
    knots: list[tuple[float, float]],
    center: np.ndarray,
    half: np.ndarray,
    scores: np.ndarray,
    mask: np.ndarray,
    w: int,
    h: int,
) -> float:
    if not knots:
        return -1e6
    vals = []
    for t, lane in knots:
        y = int(round(t * (h - 1)))
        vals.append(score_at_lane(y, lane, center, half, scores, mask, w))
    return float(np.mean(vals))


def filter_and_dedupe_paths(
    raw: list[list[tuple[float, float]]],
    center: np.ndarray,
    half: np.ndarray,
    scores: np.ndarray,
    mask: np.ndarray,
    w: int,
    h: int,
) -> list[list[tuple[float, float]]]:
    kept: list[tuple[list[tuple[float, float]], float, float]] = []
    for knots in raw:
        if len(knots) < MIN_TRACK_KNOTS:
            continue
        t0, t1 = knots[0][0], knots[-1][0]
        if t1 - t0 < MIN_T_SPAN:
            continue
        ms = path_mean_score(knots, center, half, scores, mask, w, h)
        if ms < PEAK_MIN_SCORE - 4:
            continue
        mean_lane = float(np.mean([k[1] for k in knots]))
        kept.append((knots, ms, mean_lane))

    kept.sort(key=lambda x: -x[1])
    out: list[list[tuple[float, float]]] = []
    for knots, ms, mean_lane in kept:
        dup = False
        for ok in out:
            ol = float(np.mean([k[1] for k in ok]))
            ot0, ot1 = ok[0][0], ok[-1][0]
            nt0, nt1 = knots[0][0], knots[-1][0]
            overlap = max(0.0, min(ot1, nt1) - max(ot0, nt0))
            if overlap > 0.06 and abs(ol - mean_lane) < DEDUPE_LANE:
                dup = True
                break
        if not dup:
            out.append(knots)
    out.sort(key=lambda k: (float(np.mean([p[1] for p in k])), k[0][0]))
    return out


def path_records(
    paths: list[list[tuple[float, float]]],
    tiers: list[str] | None = None,
) -> list[dict]:
    recs = []
    left_i = 0
    right_i = 0
    sec_l = 0
    sec_r = 0
    for idx, knots in enumerate(paths):
        mean_lane = float(np.mean([k[1] for k in knots]))
        tier = tiers[idx] if tiers and idx < len(tiers) else "primary"
        if mean_lane < -0.04:
            side = "left"
            if tier == "secondary":
                pid = f"SL{sec_l}"
                sec_l += 1
            else:
                pid = f"L{left_i}"
                left_i += 1
        elif mean_lane > 0.04:
            side = "right"
            if tier == "secondary":
                pid = f"SR{sec_r}"
                sec_r += 1
            else:
                pid = f"R{right_i}"
                right_i += 1
        else:
            side = "center"
            pid = f"C{len(recs)}"
        dense = decimate(knots, min(KNOTS_DENSE, len(knots)))
        sparse = decimate(knots, KNOTS_UI)
        recs.append(
            {
                "id": pid,
                "side": side,
                "tier": tier,
                "lane_mean": round(mean_lane, 4),
                "t_span": [round(knots[0][0], 4), round(knots[-1][0], 4)],
                "sparse": sparse,
                "dense": dense,
            }
        )
    return recs


def skeletonize_binary(mask: np.ndarray, max_iter: int = 128) -> np.ndarray:
    """Morphological skeleton (thin foreground to ~1 px centerlines)."""
    cur = mask.astype(bool)
    skel = np.zeros_like(cur, dtype=bool)
    struct = np.ones((3, 3), dtype=bool)
    for _ in range(max_iter):
        if not cur.any():
            break
        eroded = ndimage.binary_erosion(cur, structure=struct)
        opened = ndimage.binary_dilation(eroded, structure=struct)
        skel |= cur & ~opened
        cur = eroded
    return skel | cur


def guide_thick_masks(
    rgba: np.ndarray,
    shaft_mask: np.ndarray,
    base_rgb: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    rgb = rgba[..., :3].astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    a = rgba[..., 3] > 12 if rgba.shape[2] >= 4 else np.ones(rgba.shape[:2], dtype=bool)
    vivid_red = (r > 200.0) & (g < 82.0) & (b < 82.0)
    vivid_blue = (b > 198.0) & (r < 92.0) & (g < 125.0)
    guide = (vivid_red | vivid_blue) & a & shaft_mask
    if base_rgb is not None and base_rgb.shape == rgb.shape:
        diff = np.abs(rgb - base_rgb.astype(np.float32)).max(axis=2)
        guide &= diff > 8.0
    guide = ndimage.binary_opening(guide, structure=np.ones((2, 2), dtype=bool))
    return guide & vivid_red, guide & vivid_blue


def ridge_of_component(comp: np.ndarray) -> np.ndarray:
    if not comp.any():
        return comp
    dist = ndimage.distance_transform_edt(comp)
    maxf = ndimage.maximum_filter(dist, size=5)
    ridge = comp & (dist >= maxf - 1e-3) & (dist > 0.42)
    return prune_skeleton_spurs(ridge, max_spur=6)


def extract_branches_from_ridge(
    ridge: np.ndarray,
    h: int,
    w: int,
) -> list[list[tuple[int, int]]]:
    ys, xs = np.where(ridge)
    if ys.size == 0:
        return []
    pix_set = set(zip(ys.tolist(), xs.tolist()))

    def nbs(p: tuple[int, int]) -> list[tuple[int, int]]:
        y, x = p
        return [q for q in _neighbors8(y, x, h, w) if q in pix_set]

    def edge_key(a: tuple[int, int], b: tuple[int, int]) -> tuple[tuple[int, int], tuple[int, int]]:
        return (a, b) if a < b else (b, a)

    visited_edges: set[tuple[tuple[int, int], tuple[int, int]]] = set()
    nodes = {p for p in pix_set if len(nbs(p)) != 2}
    if not nodes:
        nodes = pix_set

    def walk_branch(start: tuple[int, int], nxt: tuple[int, int]) -> list[tuple[int, int]]:
        ek = edge_key(start, nxt)
        if ek in visited_edges:
            return []
        visited_edges.add(ek)
        chain = [start, nxt]
        prev, cur = start, nxt
        while len(nbs(cur)) == 2:
            cand = [q for q in nbs(cur) if q != prev]
            if len(cand) != 1:
                break
            nxt2 = cand[0]
            ek2 = edge_key(cur, nxt2)
            if ek2 in visited_edges:
                break
            visited_edges.add(ek2)
            chain.append(nxt2)
            prev, cur = cur, nxt2
        if cur not in chain:
            chain.append(cur)
        return chain

    pixel_paths: list[list[tuple[int, int]]] = []
    for node in nodes:
        for q in nbs(node):
            branch = walk_branch(node, q)
            if len(branch) >= 2:
                pixel_paths.append(branch)
    return pixel_paths


def chain_to_texture(
    chain: list[tuple[int, int]],
    center: np.ndarray,
    half: np.ndarray,
    h: int,
) -> list[tuple[float, float]]:
    tl: list[tuple[float, float]] = []
    for y, x in chain:
        if half[y] < 1.0:
            continue
        t = float(y) / (h - 1)
        lane = float((x - center[y]) / half[y])
        if abs(lane) > 0.985:
            continue
        if tl and abs(t - tl[-1][0]) < 1e-6 and abs(lane - tl[-1][1]) < 1e-4:
            continue
        tl.append((t, lane))
    return tl


MAX_TRACK_LANE_STEP = 0.18
MAX_TRACK_MISS = 4
MIN_TRACK_POINTS = 6


def trace_thick_strokes(
    thick: np.ndarray,
    tier: str,
    center: np.ndarray,
    half: np.ndarray,
    h: int,
    y0_ratio: float = 0.08,
    y1_ratio: float = 0.96,
    cluster_gap_px: int = 5,
) -> tuple[list[list[tuple[float, float]]], list[str]]:
    y0 = int(h * y0_ratio)
    y1 = int(h * y1_ratio)
    active: list[dict] = []
    finished: list[list[tuple[float, float]]] = []

    def finish(tr: dict) -> None:
        pts = tr["pts"]
        if len(pts) >= MIN_TRACK_POINTS:
            finished.append(pts)

    for y in range(y0, y1):
        if half[y] < 1.0:
            for tr in active:
                tr["miss"] += 1
            still = []
            for tr in active:
                if tr["miss"] <= MAX_TRACK_MISS:
                    still.append(tr)
                else:
                    finish(tr)
            active = still
            continue

        xs = np.where(thick[y])[0]
        if xs.size == 0:
            for tr in active:
                tr["miss"] += 1
            still = []
            for tr in active:
                if tr["miss"] <= MAX_TRACK_MISS:
                    still.append(tr)
                else:
                    finish(tr)
            active = still
            continue

        clusters: list[list[int]] = [[int(xs[0])]]
        for x in xs[1:]:
            if x - clusters[-1][-1] > cluster_gap_px:
                clusters.append([int(x)])
            else:
                clusters[-1].append(int(x))
        row_lanes = [
            float((float(np.mean(c)) - center[y]) / half[y])
            for c in clusters
            if len(c) >= 1
        ]
        t = float(y) / (h - 1)
        used: set[int] = set()

        for tr in sorted(active, key=lambda z: -len(z["pts"])):
            best_j = -1
            best_d = 1e9
            for j, lane in enumerate(row_lanes):
                if j in used:
                    continue
                d = abs(lane - tr["last_lane"])
                if d > MAX_TRACK_LANE_STEP:
                    continue
                if d < best_d:
                    best_d = d
                    best_j = j
            if best_j >= 0:
                lane = row_lanes[best_j]
                tr["pts"].append((t, lane))
                tr["last_lane"] = lane
                tr["miss"] = 0
                used.add(best_j)
            else:
                tr["miss"] += 1

        still = []
        for tr in active:
            if tr["miss"] <= MAX_TRACK_MISS:
                still.append(tr)
            else:
                finish(tr)
        active = still

        for j, lane in enumerate(row_lanes):
            if j in used:
                continue
            if abs(lane) > 0.985:
                continue
            active.append({"pts": [(t, lane)], "last_lane": lane, "miss": 0})

    for tr in active:
        finish(tr)

    tiers = [tier] * len(finished)
    return finished, tiers


def paths_from_thick_mask(
    thick: np.ndarray,
    tier: str,
    center: np.ndarray,
    half: np.ndarray,
    h: int,
    w: int,
    min_component_px: int = 24,
    min_branch_px: int = 5,
    min_branch_len_px: float = 8.0,
) -> tuple[list[list[tuple[float, float]]], list[str]]:
    _ = w, min_component_px, min_branch_px, min_branch_len_px
    return trace_thick_strokes(thick, tier, center, half, h)


def trace_red_annotation_paths(
    red_thick: np.ndarray,
    blue_thick: np.ndarray,
    center: np.ndarray,
    half: np.ndarray,
    h: int,
    w: int,
) -> tuple[list[list[tuple[float, float]]], list[str]]:
    paths: list[list[tuple[float, float]]] = []
    tiers: list[str] = []
    p, t = paths_from_thick_mask(red_thick, "primary", center, half, h, w)
    paths.extend(p)
    tiers.extend(t)
    p, t = paths_from_thick_mask(blue_thick, "secondary", center, half, h, w)
    paths.extend(p)
    tiers.extend(t)
    return paths, tiers


def prune_skeleton_spurs(skel: np.ndarray, max_spur: int = 7) -> np.ndarray:
    cur = skel.copy()
    h, w = cur.shape
    for _ in range(64):
        changed = False
        ys, xs = np.where(cur)
        pix = set(zip(ys.tolist(), xs.tolist()))

        def nbs(p: tuple[int, int]) -> list[tuple[int, int]]:
            y, x = p
            out = []
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dy == 0 and dx == 0:
                        continue
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and cur[ny, nx]:
                        out.append((ny, nx))
            return out

        remove: set[tuple[int, int]] = set()
        for p in pix:
            if len(nbs(p)) != 1:
                continue
            chain = [p]
            prev = None
            curp = p
            while len(nbs(curp)) == 2 or (len(nbs(curp)) == 1 and curp == p):
                nxt_list = [q for q in nbs(curp) if q != prev]
                if not nxt_list:
                    break
                nxt = nxt_list[0]
                chain.append(nxt)
                if len(nbs(nxt)) != 2:
                    break
                prev, curp = curp, nxt
            if 2 <= len(chain) <= max_spur:
                remove.update(chain)
                changed = True
        if not changed:
            break
        for y, x in remove:
            cur[y, x] = False
    return cur


def polyline_arc(tl: list[tuple[float, float]]) -> float:
    if len(tl) < 2:
        return 0.0
    arc = 0.0
    for i in range(1, len(tl)):
        dt = tl[i][0] - tl[i - 1][0]
        dl = tl[i][1] - tl[i - 1][1]
        arc += float(np.hypot(dt, dl))
    return arc


def _neighbors8(y: int, x: int, h: int, w: int) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w:
                out.append((ny, nx))
    return out


def dedupe_texture_paths(
    paths: list[list[tuple[float, float]]],
    tiers: list[str],
) -> tuple[list[list[tuple[float, float]]], list[str]]:
    kept: list[list[tuple[float, float]]] = []
    kept_t: list[str] = []
    keys: set[tuple] = set()
    for path, tier in zip(paths, tiers):
        if len(path) < 2:
            continue
        a, b = path[0], path[-1]
        key = (
            round(a[0], 3),
            round(a[1], 3),
            round(b[0], 3),
            round(b[1], 3),
            len(path),
        )
        rev = (
            round(b[0], 3),
            round(b[1], 3),
            round(a[0], 3),
            round(a[1], 3),
            len(path),
        )
        if key in keys or rev in keys:
            continue
        keys.add(key)
        kept.append(path)
        kept_t.append(tier)
    return kept, kept_t


def extract_from_red_annotation(
    im: Image.Image,
    ann: Image.Image,
) -> tuple[list[dict], str, list[list[float]], list[list[float]], list[list[float]], list[list[float]]]:
    arr = np.array(im.convert("RGBA"))
    h, w = arr.shape[:2]
    ann_arr = np.array(ann.convert("RGBA"))
    if ann_arr.shape[0] != h or ann_arr.shape[1] != w:
        ann = ann.convert("RGBA").resize((w, h), Image.Resampling.NEAREST)
        ann_arr = np.array(ann)
        print(f"resized annotation to {w}x{h}")

    shaft_mask = arr[..., 3] > 22
    center = np.zeros(h, dtype=np.float64)
    half = np.zeros(h, dtype=np.float64)
    for y in range(h):
        xs = np.where(shaft_mask[y])[0]
        if xs.size < 8:
            continue
        center[y] = (xs[0] + xs[-1]) * 0.5
        half[y] = max(6.0, (xs[-1] - xs[0]) * 0.5)

    red_thick, blue_thick = guide_thick_masks(ann_arr, shaft_mask, arr[..., :3])
    paths_knots, tiers = trace_red_annotation_paths(red_thick, blue_thick, center, half, h, w)
    paths_knots.sort(key=lambda k: (float(np.mean([p[1] for p in k])), k[0][0]))
    # keep tiers aligned after sort — sort by index pairs
    paired = sorted(
        zip(paths_knots, tiers),
        key=lambda z: (float(np.mean([p[1] for p in z[0]])), z[0][0]),
    )
    paths_knots = [p for p, _ in paired]
    tiers = [t for _, t in paired]
    path_recs = path_records(paths_knots, tiers)

    y_rows = np.arange(int(h * 0.12), int(h * 0.94), ROW_STEP, dtype=np.int32)
    scores = vein_score(arr[..., :3].astype(np.float32))
    left_bins = np.linspace(-0.92, -0.14, 36)
    right_bins = np.linspace(0.14, 0.92, 36)
    left_dense_path = trace_ridge_dp(y_rows, left_bins, center, half, scores, shaft_mask, w, h, CONTINUITY)
    right_dense_path = trace_ridge_dp(y_rows, right_bins, center, half, scores, shaft_mask, w, h, CONTINUITY)
    left_dense = decimate(left_dense_path, min(KNOTS_DENSE, len(left_dense_path)))
    right_dense = decimate(right_dense_path, min(KNOTS_DENSE, len(right_dense_path)))
    left = decimate(left_dense_path, KNOTS_UI)
    right = decimate(right_dense_path, KNOTS_UI)
    return path_recs, "red_annotation", left, right, left_dense, right_dense


def knots_to_image_xy(
    knots: list[list[float]] | list[tuple[float, float]],
    center: np.ndarray,
    half: np.ndarray,
    h: int,
) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for knot in knots:
        t = float(knot[0])
        lane = float(knot[1])
        yi = int(round(t * (h - 1)))
        if half[yi] < 1.0:
            continue
        x = center[yi] + lane * half[yi]
        out.append((float(x), t * (h - 1)))
    return out


def write_overlay(
    im: Image.Image,
    path_recs: list[dict],
    center: np.ndarray,
    half: np.ndarray,
    w: int,
    h: int,
    annotation: Path | None = None,
) -> None:
    from PIL import ImageDraw, ImageEnhance

    scale = 3
    if annotation and annotation.is_file():
        base = Image.open(annotation).convert("RGBA")
        if base.size != (w, h):
            base = base.resize((w, h), Image.Resampling.NEAREST)
    else:
        base = im.copy().convert("RGBA")
    base = ImageEnhance.Brightness(base).enhance(0.92)
    overlay = base.copy()
    draw = ImageDraw.Draw(overlay)

    for rec in path_recs:
        tier = rec.get("tier", "primary")
        col = (255, 70, 90, 255) if tier == "primary" else (80, 180, 255, 255)
        p = knots_to_image_xy(rec["dense"], center, half, h)
        if len(p) < 2:
            p = knots_to_image_xy(rec["sparse"], center, half, h)
        if len(p) >= 2:
            draw.line(p, fill=col, width=3)
            for pt in (p[0], p[-1]):
                draw.ellipse((pt[0] - 3, pt[1] - 3, pt[0] + 3, pt[1] + 3), fill=col)
            mid = p[len(p) // 2]
            draw.text((mid[0] + 4, mid[1] - 6), rec["id"], fill=(255, 255, 255, 255))

    big = overlay.resize((w * scale, h * scale), Image.Resampling.NEAREST)
    OVERLAY.parent.mkdir(parents=True, exist_ok=True)
    big.save(OVERLAY)


def write_viewer_html(
    path_recs: list[dict],
    center: np.ndarray,
    half: np.ndarray,
    w: int,
    h: int,
    method: str,
) -> None:
    ann_rel = "../assets/dangling-member-veins-drawn.png"
    member_rel = "../assets/dangling-member.png"
    bg = ann_rel if ANNOTATION.is_file() else member_rel
    paths_js = []
    for rec in path_recs:
        xy = knots_to_image_xy(rec["dense"], center, half, h)
        if len(xy) < 2:
            xy = knots_to_image_xy(rec["sparse"], center, half, h)
        paths_js.append(
            {
                "id": rec["id"],
                "tier": rec.get("tier", "primary"),
                "side": rec["side"],
                "xy": [[round(a, 2), round(b, 2)] for a, b in xy],
            }
        )
    paths_blob = json.dumps(paths_js, separators=(",", ":"))
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Vein paths — viewer</title>
  <style>
    body {{ font-family: system-ui, sans-serif; background: #1a1a1a; color: #ddd; margin: 20px; }}
    h1 {{ font-size: 1.05rem; font-weight: 600; }}
    p {{ max-width: 42rem; line-height: 1.5; font-size: 0.92rem; }}
    .wrap {{ position: relative; display: inline-block; margin: 12px 0; }}
    .wrap img {{ display: block; width: 459px; height: 1458px; image-rendering: pixelated; }}
    svg {{ position: absolute; left: 0; top: 0; width: 459px; height: 1458px; pointer-events: none; }}
    .legend span {{ margin-right: 18px; }}
    .sw {{ display: inline-block; width: 16px; height: 4px; vertical-align: middle; margin-right: 6px; }}
    ul {{ font-size: 0.85rem; columns: 2; max-width: 460px; }}
  </style>
</head>
<body>
  <h1>Extracted vein paths ({method})</h1>
  <p>Background: your guide art. <strong>Magenta</strong> = primary (red strokes), <strong>cyan</strong> = secondary (blue). Labels = path ids in JSON.</p>
  <p class="legend">
    <span><i class="sw" style="background:#ff465a"></i>primary</span>
    <span><i class="sw" style="background:#50b4ff"></i>secondary</span>
  </p>
  <div class="wrap">
    <img src="{bg}" width="459" height="1458" alt="guide">
    <svg viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg" id="svg"></svg>
  </div>
  <p>{len(path_recs)} path(s). Regenerate: <code>python scripts/extract_dangling_vein_paths.py</code></p>
  <ul id="list"></ul>
  <script>
    const W = {w}, H = {h}, SCALE = 3;
    const paths = {paths_blob};
    const svg = document.getElementById("svg");
    const list = document.getElementById("list");
    paths.forEach(p => {{
      const col = p.tier === "secondary" ? "#50b4ff" : "#ff465a";
      if (p.xy.length < 2) return;
      const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      pl.setAttribute("fill", "none");
      pl.setAttribute("stroke", col);
      pl.setAttribute("stroke-width", "2.2");
      pl.setAttribute("stroke-linecap", "round");
      pl.setAttribute("stroke-linejoin", "round");
      pl.setAttribute("points", p.xy.map(pt => pt[0] + "," + pt[1]).join(" "));
      svg.appendChild(pl);
      const mid = p.xy[Math.floor(p.xy.length / 2)];
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", mid[0] + 2);
      t.setAttribute("y", mid[1] - 2);
      t.setAttribute("fill", "#fff");
      t.setAttribute("font-size", "9");
      t.textContent = p.id;
      svg.appendChild(t);
      const li = document.createElement("li");
      li.textContent = p.id + " (" + p.tier + ", " + p.side + ", " + p.xy.length + " pts)";
      list.appendChild(li);
    }});
  </script>
</body>
</html>
"""
    VIEWER_HTML.write_text(html, encoding="utf-8")


def build_js(data: dict) -> str:
    compact = {
        "version": data["version"],
        "method": data["method"],
        "paths": data["paths"],
        "left": data["left"],
        "right": data["right"],
        "left_dense": data["left_dense"],
        "right_dense": data["right_dense"],
    }
    blob = json.dumps(compact, separators=(",", ":"))
    return (
        "/* Auto-generated by scripts/extract_dangling_vein_paths.py — do not edit. */\n"
        "(function (g) {\n"
        '  "use strict";\n'
        f"  var data = {blob};\n"
        "  g.DanglingVeinPaths = data;\n"
        "  g.DanglingVeinPathApi = {\n"
        "    version: data.version,\n"
        "    method: data.method,\n"
        "    listPaths: function () {\n"
        "      return (data.paths || []).map(function (p) {\n"
        "        return { id: p.id, side: p.side, tier: p.tier, lane_mean: p.lane_mean, t_span: p.t_span };\n"
        "      });\n"
        "    },\n"
        "    getPathById: function (id, density) {\n"
        "      var d = density || 'auto';\n"
        "      var rec = (data.paths || []).find(function (p) { return p.id === id; });\n"
        "      if (!rec) return null;\n"
        "      if (d === 'sparse') return rec.sparse;\n"
        "      if (d === 'dense') return rec.dense;\n"
        "      return rec.dense && rec.dense.length >= 2 ? rec.dense : rec.sparse;\n"
        "    },\n"
        "    getAllPolylines: function (density) {\n"
        "      var d = density || 'auto';\n"
        "      return (data.paths || []).map(function (p) {\n"
        "        if (d === 'sparse') return p.sparse;\n"
        "        if (d === 'dense') return p.dense;\n"
        "        return p.dense && p.dense.length >= 2 ? p.dense : p.sparse;\n"
        "      });\n"
        "    },\n"
        "    getPathsByTier: function (tier, density) {\n"
        "      var d = density || 'auto';\n"
        "      return (data.paths || []).filter(function (p) { return p.tier === tier; }).map(function (p) {\n"
        "        return p.dense && p.dense.length >= 2 ? p.dense : p.sparse;\n"
        "      });\n"
        "    },\n"
        "    /** @param {string} idOrSide path id (L0,R1,…) or legacy 'left'|'right' */\n"
        "    getPolyline: function (idOrSide, density) {\n"
        "      var d = density || 'auto';\n"
        "      if (idOrSide === 'left' || idOrSide === 'right') {\n"
        "        var sparse = idOrSide === 'left' ? data.left : data.right;\n"
        "        var dense = idOrSide === 'left' ? data.left_dense : data.right_dense;\n"
        "        if (d === 'sparse') return sparse;\n"
        "        if (d === 'dense') return dense;\n"
        "        return dense && dense.length >= 2 ? dense : sparse;\n"
        "      }\n"
        "      return this.getPathById(idOrSide, d);\n"
        "    },\n"
        "  };\n"
        "})(typeof globalThis !== \"undefined\" ? globalThis : this);\n"
    )


def main() -> None:
    im = Image.open(PNG).convert("RGBA")
    arr = np.array(im)
    h, w = arr.shape[:2]
    mask = arr[..., 3] > 22
    scores = vein_score(arr[..., :3].astype(np.float32))

    center = np.zeros(h, dtype=np.float64)
    half = np.zeros(h, dtype=np.float64)
    for y in range(h):
        xs = np.where(mask[y])[0]
        if xs.size < 8:
            continue
        center[y] = (xs[0] + xs[-1]) * 0.5
        half[y] = max(6.0, (xs[-1] - xs[0]) * 0.5)

    if ANNOTATION.is_file():
        ann = Image.open(ANNOTATION)
        path_recs, method, left, right, left_dense, right_dense = extract_from_red_annotation(im, ann)
        print(f"using {ANNOTATION.name} ({method})")
    else:
        method = "multi_ridge"
        y_rows = np.arange(int(h * 0.12), int(h * 0.94), ROW_STEP, dtype=np.int32)
        left_bins = np.linspace(-0.92, -0.14, 36)
        right_bins = np.linspace(0.14, 0.92, 36)

        raw_tracks = trace_all_ridges(y_rows, center, half, scores, mask, w, h)
        paths_knots = filter_and_dedupe_paths(raw_tracks, center, half, scores, mask, w, h)
        path_recs = path_records(paths_knots)

        left_dense_path = trace_ridge_dp(y_rows, left_bins, center, half, scores, mask, w, h, CONTINUITY)
        right_dense_path = trace_ridge_dp(y_rows, right_bins, center, half, scores, mask, w, h, CONTINUITY)

        left_dense = decimate(left_dense_path, min(KNOTS_DENSE, len(left_dense_path)))
        right_dense = decimate(right_dense_path, min(KNOTS_DENSE, len(right_dense_path)))
        left = decimate(left_dense_path, KNOTS_UI)
        right = decimate(right_dense_path, KNOTS_UI)

    payload = {
        "version": 3,
        "method": method,
        "source": "assets/dangling-member.png",
        "annotation": str(ANNOTATION.relative_to(ROOT)).replace("\\", "/") if method == "red_annotation" else None,
        "size": [w, h],
        "params": {
            "row_step_px": ROW_STEP,
            "continuity": CONTINUITY,
            "annotation_file": ANNOTATION.name,
        },
        "units": {"t": "0=base 1=tip (image Y)", "lane": "offset / half-width from centerline"},
        "paths": path_recs,
        "left": left,
        "right": right,
        "left_dense": left_dense,
        "right_dense": right_dense,
    }
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    JS_OUT.write_text(build_js(payload), encoding="utf-8")

    write_overlay(
        im,
        path_recs,
        center,
        half,
        w,
        h,
        ANNOTATION if method == "red_annotation" else None,
    )
    write_viewer_html(path_recs, center, half, w, h, method)

    print(f"wrote {OUT} paths={len(path_recs)} left={len(left)} right={len(right)}")
    print(f"wrote {JS_OUT}")
    print(f"wrote {OVERLAY}")
    print(f"wrote {VIEWER_HTML}  (open in a browser)")


if __name__ == "__main__":
    main()
