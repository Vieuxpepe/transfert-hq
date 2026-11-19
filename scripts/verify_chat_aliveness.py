"""Print the scripted multi-turn chat aliveness evidence (fake provider).

Runs the real ``transferania`` send path, so every captured payload is exactly
what a provider would receive. Shows, turn after turn, the opening she is told
not to repeat, the shape cue that turn carries, and the reply that was delivered.

  python scripts/verify_chat_aliveness.py [--output artifacts/chat-aliveness.json]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.companion_chat_aliveness import run  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/chat-aliveness.json")
    args = parser.parse_args()
    report = run()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{'turn':<5}{'label':<10}{'mode':<9}{'persona':<8}{'avoid next opening':<22}shape")
    for row in report["turns"]:
        shape = "drop" if "redescends" in row["shape"] else "react" if row["shape"] else "-"
        print(f'{row["turn"]:<5}{row["label"]:<10}{row["mode"]:<9}{row["persona"]:<8}'
              f'{("« " + row["opening"] + " »"):<22}{shape}')
    print("\nopenings fed to the thread (all distinct):", " | ".join(report["openings"]))
    print("openings forbidden turn by turn:", " | ".join(report["avoided"]))
    for row in report["turns"]:
        if row["guidance"]:
            print(f'  payload turn {row["turn"]}: {row["guidance"]}  [{row["mode"]}]')
    print(f"turns: {len(report['turns'])}; model calls: {report['model_calls']}; evidence: {args.output}")
    raise SystemExit(0)


if __name__ == "__main__":
    main()
