"""Generate portrait samples at several character LoRA weights (Forge must be up)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
META = ROOT / ".hq-ai" / "companion_forge.json"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import hq_companion_art as art  # noqa: E402


def main() -> int:
    weights = [0.5, 0.62, 0.75]
    if len(sys.argv) > 1:
        weights = [float(x) for x in sys.argv[1:]]
    backup = META.read_text(encoding="utf-8") if META.is_file() else "{}"
    data = json.loads(backup)
    data["character_lora_name"] = "transferania_char"
    data.setdefault("character_sheet_weight", 0.48)
    data.setdefault("controlnet_weight", 0.88)
    out_paths: list[str] = []
    for w in weights:
        data["character_lora_weight"] = w
        META.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tag = str(w).replace(".", "")
        dest = f"transferania-lora-w{tag}.jpg"
        gen = art.generate_pose("portrait-neutral", root=ROOT, ctx={"intensity": 0, "hour": 18})
        art.save_generation(ROOT, dest, gen["bytes"])
        out_paths.append(str(ROOT / "assets" / "companion" / dest))
        print(f"w={w:.2f} seed={gen.get('seed')} -> {dest}")
    META.write_text(backup, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
