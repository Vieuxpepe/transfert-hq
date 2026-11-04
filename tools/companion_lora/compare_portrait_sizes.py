"""Compare portrait resolutions (Illustrious / SDXL)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import hq_companion_art as art

SIZES = (
    (512, 512, "512x512"),
    (512, 712, "512x712"),
    (896, 1152, "896x1152"),
    (832, 1216, "832x1216"),
)


def main() -> int:
    ctx_base = {"intensity": 0, "hour": 18, "locked_seed": 271828182}
    ok = 0
    for w, h, tag in SIZES:
        ctx = dict(ctx_base, width=w, height=h)
        dest = f"transferania-size-{tag}.jpg"
        try:
            gen = art.generate_pose("portrait-neutral", root=ROOT, ctx=ctx)
            art.save_generation(ROOT, dest, gen["bytes"])
            print(f"OK {tag} seed={gen.get('seed')} -> {dest}")
            ok += 1
        except Exception as exc:
            print(f"FAIL {tag}: {exc}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
