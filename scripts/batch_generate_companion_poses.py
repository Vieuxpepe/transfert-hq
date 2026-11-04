#!/usr/bin/env py3
"""Generate missing companion JPGs for every POSE_DEFAULT_DEST entry."""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hq_companion_art as art


def main() -> int:
    force = "--force" in sys.argv
    prefixes: tuple[str, ...] = ()
    for arg in sys.argv[1:]:
        if arg.startswith("--prefix="):
            prefixes = tuple(p.strip() for p in arg.split("=", 1)[1].split(",") if p.strip())

    todo: list[tuple[str, str]] = []
    for pid in sorted(art.POSE_DEFAULT_DEST):
        if prefixes and not pid.startswith(prefixes):
            continue
        dest = art.default_dest(pid)
        if not dest:
            continue
        path = ROOT / "assets" / "companion" / dest
        if path.is_file() and not force:
            continue
        todo.append((pid, dest))

    if not todo:
        print("Nothing to generate (all dest files present).")
        return 0

    print(f"Generating {len(todo)} pose(s) via Forge…", flush=True)
    failed: list[str] = []
    t0 = time.time()
    for i, (pid, dest) in enumerate(todo, 1):
        intensity = 4 if pid.startswith(("hc-", "hx-")) else 3
        ctx = {"intensity": intensity, "hour": 22, "variations": 1}
        print(f"[{i}/{len(todo)}] {pid} -> {dest} (Picante {intensity})", flush=True)
        try:
            gen = art.generate_pose(pid, root=ROOT, ctx=ctx)
            saved = art.save_generation(ROOT, dest, gen["bytes"])
            print(
                f"  ok seed={gen.get('seed')} {saved['bytes']} bytes -> {saved['href']}",
                flush=True,
            )
        except art.CompanionArtError as exc:
            print(f"  FAIL ({exc.code}): {exc.message}", flush=True)
            failed.append(pid)
        except Exception as exc:
            print(f"  FAIL: {exc}", flush=True)
            failed.append(pid)

    elapsed = int(time.time() - t0)
    print(f"Done in {elapsed}s. failed={len(failed)}", flush=True)
    if failed:
        print("Failed poses:", ", ".join(failed), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
