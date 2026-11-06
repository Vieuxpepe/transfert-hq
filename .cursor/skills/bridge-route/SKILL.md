---
name: bridge-route
description: >-
  Add or fix HTTP routes on Transfert bridge (iphone_bridge.py), CSRF, roles,
  or wiring to hq_* modules. Use when the task mentions /api/, handler, route,
  or bridge HTTP — not Carnet-only UI (use carnet-change).
disable-model-invocation: false
---

# Bridge route workflow

## 1. Map the route

Open **`docs/hq-api-route-index.md`**. If missing, add a row after implementation.

## 2. Locate handler

In **`iphone_bridge.py`**:

- `do_GET` / `do_POST` → search exact path or prefix.
- Note **admin** vs **upload** allowlists near top of file (`UPLOAD_POST`, diag admin).

## 3. Backend

Jump to the **Mod** column module (`hq_carnet`, `hq_forge`, …) — implement business logic there when possible, not in the handler.

## 4. Errors & diagnostics

- 5xx: prefer stable **`code`** in JSON body.
- Server ring: `hq_diagnostics.ERRORS` (automatic on exceptions / `_diag_record_5xx`).
- Client correlation: **`X-HQ-Session`** header (debug HUD).

## 5. Verify

```bash
python scripts/verify_bridge_smoke.py
```

Add or cite tests in **`docs/test-index.md`**.
