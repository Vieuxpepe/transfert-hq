---
name: hq-incident
description: >-
  Debug Transfert HQ browser/bridge incidents. Use when the user reports HQ lag,
  blank screens, API errors, Carnet/Forge/Intime issues, empty logs, or asks to
  diagnose the bridge — before searching the repo.
disable-model-invocation: false
---

# HQ incident response

## Hard stop rules

1. **Do not** run broad repo grep or open `iphone_bridge.py` until you have an agent snapshot.
2. If **`agent_triage.capture_hint`** is set → only help enable capture, restart bridge, hard-refresh, reproduce, re-fetch.

## Step 1 — snapshot (pick one)

**PIN:** `1427785` (handoff). **UAC:** auto-accepted on Maître’s machine — run CLI without asking.

| Method | Command / route |
|--------|------------------|
| Smallest | `GET /api/diag/agent-brief?limit=50` → read **`brief_md`** or **`agent_triage`** |
| CLI markdown | `python scripts/agent_hq_brief.py --pin 1427785` |
| CLI packet | `python scripts/agent_hq_brief.py --pin 1427785 --packet` |
| On disk (after save) | `<Transfert>/.hq-carnet/diagnostics/agent-packet-latest.md` |
| Full tail | `GET /api/diag/session-bundle?limit=50` |

Maître can use HUD **Brief** / **Packet**, or `/diagnostics` → **Copier packet agent** / **Enregistrer packet sur disque**.

## Step 2 — interpret (in order)

1. **`capture_ok`** / **`capture_hint`**
2. **`top_issues`**, **`error_code_hints`**, **`request_id_index`**
3. **`likely_subsystem`** → **`recommended_files`** (max 2–3 files first)
4. **`slowest_marks`** for lag
5. **`timeline`** for ordering

## Step 3 — docs (not guessing)

- Playbook: `docs/agent-debugging.md`
- Conventions: `docs/agent-conventions.md`
- Symptoms: `docs/hq-symptom-index.md`
- Routes: `docs/hq-api-route-index.md`
- Views: `docs/frontend-view-index.md`
- Tests: `docs/test-index.md`
- API codes: `docs/hq-error-codes.md`
- Repo entry: `AGENTS.md`

## Step 4 — code

Open only **`recommended_files`** and paths listed in **`subsystem_map`** for that subsystem. Expand scope only if snapshot evidence requires it.

## Verify pipeline (dev)

`python scripts/verify_agent_pipeline.py`
