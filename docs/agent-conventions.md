# Agent conventions (Transfert — save quota)

Read **`AGENTS.md`** first. This file is the **global** contract; domain docs are linked below.

---

## Before any codebase search

1. Classify the task: **HQ incident** · **Carnet** · **Bridge/API** · **Companion** · **Forge** · **Tests/CI**.
2. Open the **one** domain doc + skill for that class (see maps below).
3. **HQ browser/bridge bugs:** `GET /api/diag/agent-brief` or Maître’s **packet** — see [agent-debugging.md](agent-debugging.md).
4. **Never** read multi‑MB files whole (`hq-carnet.js`, full `iphone_bridge.py`). Use maps + targeted `grep` (±80 lines).

---

## Maps (check in before grep)

| Map | Use |
|-----|-----|
| [hq-api-route-index.md](hq-api-route-index.md) | Which `/api/*` → which module |
| [frontend-view-index.md](frontend-view-index.md) | `data-view` → lazy scripts → hooks |
| [hq-symptom-index.md](hq-symptom-index.md) | User symptom → bundle fields → files |
| [hq-error-codes.md](hq-error-codes.md) | Stable JSON `code` values |
| [test-index.md](test-index.md) | What to run after a change |
| [agent-animation-pipeline.md](agent-animation-pipeline.md) | Reproduce → fix → verify animation/motion perf |
| [carnet-agent-anchors.md](carnet-agent-anchors.md) | Carnet grep anchors (not full file read) |

---

## Project skills (`.cursor/skills/`)

| Skill | When |
|-------|------|
| `hq-incident` | HQ lag, API errors, empty client log |
| `carnet-change` | Notebook, Carnet UI, poll, pages |
| `bridge-route` | New/changed HTTP routes, bridge handler |
| `companion-behavior` | Intime, Live2D, companion API |
| `run-these-tests` | Pick tests from test-index |

---

## Global stop rules

- **No** repo-wide exploratory subagents unless the Maître asked for a broad audit.
- **No** pasting unrelated secrets in chat (webhook tokens, `.env`, full `bridge_config.json`). **HQ admin PIN** for local diag/CLI is in the handoff block below — use it; do not ask the Maître to type it again.
- **UAC:** On the Maître’s Windows machine, **elevation prompts are auto-accepted**. Run shell/install/restart commands yourself — **do not** stop to ask the user to click UAC.
- **No** drive-by refactors; smallest diff for the stated task.
- **Prefer** running a **verify_*.py** script over inventing test commands.
- **Commits** only when the Maître asks.

---

## Maître handoff (agents)

Use this block at the start of HQ/debug chats (PIN included for now):

```
Bridge base: http://127.0.0.1:8765  (adjust if Maître says otherwise)
Admin PIN: 1427785
UAC: auto-accepted — proceed with elevated commands without asking

Subsystem: carnet | forge | companion | bridge | hq-debug
View: (accueil, carnet, …)
Symptom: (one line)
Packet: (optional — paste brief_md or path to agent-packet-latest.md)
Changed files: (optional)
Failing test: (optional)
```

**CLI examples (use PIN above):**

```bash
python scripts/agent_hq_brief.py --pin 1427785 --packet
python scripts/fetch_session_bundle.py --pin 1427785 --brief --md
python scripts/save_agent_packet.py --pin 1427785
```

Login for scripts: `POST /login` with form `pin=…` (same as HQ web login).

---

## Handoff template (short)

```
Subsystem: …
Symptom: …
(PIN / UAC / base URL: see **Maître handoff** section above)
```
