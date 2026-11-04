"""Punch transparent mouth cavity in transferina open-profile head PNG."""
from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets" / "transferina-head-open-profile.png"
OUT = ROOT / "assets" / "transferina-head-open-profile-mouth.png"


def main() -> None:
    im = Image.open(SRC).convert("RGBA")
    a = np.asarray(im)
    h, w = a.shape[:2]
    rgb = a[:, :, :3].astype(np.int16)
    y0, y1 = int(h * 0.48), int(h * 0.64)
    x0, x1 = int(w * 0.04), int(w * 0.28)
    visited = np.zeros((h, w), dtype=bool)
    hole = np.zeros((h, w), dtype=bool)

    def in_mouth_box(y: int, x: int) -> bool:
        return y0 <= y < y1 and x0 <= x < x1

    def is_cavity(y: int, x: int) -> bool:
        if not in_mouth_box(y, x):
            return False
        if a[y, x, 3] < 40:
            return False
        r, g, b = rgb[y, x]
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        if lum > 108:
            return False
        if r > 210 and g > 155:
            return False
        if max(r, g, b) < 12:
            return False
        return True

    seeds: list[tuple[int, int]] = []
    for y in range(y0, y1):
        for x in range(x0, x1):
            if is_cavity(y, x) and x0 + (x1 - x0) * 0.22 <= x <= x0 + (x1 - x0) * 0.78:
                seeds.append((y, x))
    if not seeds:
        seeds = [(570, 70), (514, 80)]

    for sy, sx in seeds[:48]:
        if visited[sy, sx]:
            continue
        q: deque[tuple[int, int]] = deque([(sy, sx)])
        while q:
            y, x = q.popleft()
            if visited[y, x] or not is_cavity(y, x):
                continue
            visited[y, x] = True
            hole[y, x] = True
            for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                q.append((y + dy, x + dx))

    a2 = a.copy()
    a2[hole, 3] = 0
    Image.fromarray(a2).save(OUT)
    print(f"hole pixels {int(hole.sum())} -> {OUT}")


if __name__ == "__main__":
    main()
