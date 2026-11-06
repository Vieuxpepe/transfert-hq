---
name: companion-behavior
description: >-
  Intime view, hq-companion.js, Live2D, companion art API, voice, or presence.
  Use when the task mentions companion, intime, Transferania UI, or
  /api/companion — not Else persona rules in .cursorrules.
disable-model-invocation: false
---

# Companion behavior workflow

## 1. Scope

- **Product UI:** `assets/hq-companion.js`, view **`intime`** (admin session).
- **Art / poses API:** `hq_companion_art.py`, **`GET/POST /api/companion/art`**.
- **Canon / persona:** `docs/companion-family.md`, `docs/companion-memory.md` — not bridge routes.

## 2. HQ lag

Read **`agent-brief`** → filter **`slowest_marks`** for `subsystem: companion` / `live2d-frame`.

## 3. Code navigation

| Topic | Where |
|-------|--------|
| Frame cost marks | `noteLive2dFrameCost` in `hq-companion.js` |
| Art actions | `hq_companion_art.py` |
| View gating | `setView('intime')`, `hqSessionIsAdmin()` in bridge inline JS |

## 4. Verify

```bash
python -m unittest tests.test_hq_companion_art -v
```

More: **`docs/test-index.md`** (Companion section).

Persona copy is **not** verified by unit tests — follow existing docs and Maître preferences.
