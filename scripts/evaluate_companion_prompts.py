"""Offline prompt-contract evaluation; no live profile or model calls.

This evaluates assembly/grounding contracts, not generated response quality.
Run: python scripts/evaluate_companion_prompts.py [--output report.json]
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tests.companion_prompt_eval import CASES, evaluate_case


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/companion-prompt-evaluation.json")
    args = parser.parse_args()
    results = []
    for case in CASES:
        try:
            results.append(evaluate_case(case))
        except AssertionError as error:
            results.append({"id":case["id"], "passed":False, "failure":str(error)})
    report = {"evaluation":"offline prompt contracts, not model output quality", "model_calls":0,
              "estimate_method":"utf8_bytes_plus_overhead", "results":results}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(f"Prompt evaluations: {sum(r['passed'] for r in results)}/{len(results)} passed; 0 model calls; {args.output}")
    for row in results:
        if not row["passed"]:
            print(row["id"], row["failure"])
    raise SystemExit(any(not r["passed"] for r in results))


if __name__ == "__main__":
    main()
