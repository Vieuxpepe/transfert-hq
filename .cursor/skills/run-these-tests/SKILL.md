---
name: run-these-tests
description: >-
  Pick and run the right Transfert tests after a change. Use when the user asks
  what to test, CI failed, or before claiming a fix — instead of running the
  full test suite.
disable-model-invocation: false
---

# Run these tests

## 1. Open the index

**`docs/test-index.md`** — find the row for what you changed.

## 2. Default verify bundles

| Area | Command |
|------|---------|
| Everything agent-related | `python scripts/verify_all_agent_maps.py` |
| HQ debug pipeline | `python scripts/verify_agent_pipeline.py` |
| Animation / motion perf | `python scripts/verify_animation_pipeline.py` — see `docs/agent-animation-pipeline.md` |
| Bridge HTTP | `python scripts/verify_bridge_smoke.py` |
| Carnet core | `python scripts/verify_carnet_smoke.py` |

## 3. Rules

- Run **one** targeted module from the index before a broad `discover`.
- If a test fails, read **that test file’s docstring** first (often states the contract).
- Do not add tests unless the Maître asked or you fixed untested behavior.

## 4. HQ browser bugs

Reproduce with debug HUD on, then **`python scripts/agent_hq_brief.py --pin …`** — testing is separate from log capture.
