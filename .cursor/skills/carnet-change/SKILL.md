---
name: carnet-change
description: >-
  Carnet notebook, pages, editor, poll, or hq-carnet JS/API work. Use when the
  task mentions Carnet, notebook, pages, stickies, reader, or hq_carnet — not
  for generic HQ lag (use hq-incident first if browser-only).
disable-model-invocation: false
---

# Carnet change workflow

## 1. Classify

| Layer | Start here |
|-------|------------|
| Browser UI | `docs/carnet-agent-anchors.md` + grep in `assets/hq-carnet*.js` |
| API / storage | `hq_carnet.py` + `docs/hq-api-route-index.md` |
| Lazy load / blank panel | `iphone_bridge.py` → `hqCarnetLoad`, `hqCarnetShow` |
| HQ + errors in HUD | `agent-brief` then Carnet row in `docs/hq-symptom-index.md` |

## 2. Stop rules

- **No** full read of `assets/hq-carnet.js`.
- **No** repo-wide grep for “carnet” — use anchor symbols.

## 3. Implement

- Match existing patterns in the **smallest** file that owns the feature (`hq-carnet-ask.js` vs monolith).
- Stable API errors: use existing **`code`** values; document in `docs/hq-error-codes.md` if new.

## 4. Verify

```bash
python scripts/verify_carnet_smoke.py
```

See **`docs/test-index.md#carnet`** for feature-specific tests.
