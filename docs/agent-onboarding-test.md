# New agent smoke test

Use this to check that a **fresh agent** follows maps/brief before grepping. Full handoff (PIN, UAC): **[agent-conventions.md](agent-conventions.md#maître-handoff-agents)**.

---

## Prep

```bash
python scripts/verify_all_agent_maps.py
```

Optional HQ capture: `client_debug_hud: true` or `HQ_CLIENT_DEBUG=1`, restart bridge, hard-refresh.

---

## Scenario A — HQ incident

First message:

> Carnet stays blank after I tap Carnet. HUD is on. Follow AGENTS.md and agent-conventions (PIN is in the doc). Don’t search the repo until you’ve fetched agent-brief or packet.

**Pass:** `agent-brief` / `agent_triage` / `capture_hint` first, then symptom index + `recommended_files`.  
**Fail:** repo-wide grep or “please paste your PIN.”

Agent can run:

```bash
python scripts/agent_hq_brief.py --pin 1427785 --packet
```

---

## Scenario B — Carnet (no full JS read)

> Where are page save conflicts handled? Use carnet-agent-anchors; don’t read all of hq-carnet.js.

**Pass:** anchors + `hq_carnet.py` grep.  
**Fail:** read entire `hq-carnet.js`.

---

## Scenario C — API map

> Where is POST /api/carnet handled? Use hq-api-route-index only.

**Pass:** index → `hq_carnet.py` + targeted search in `iphone_bridge.py`.  
**Fail:** read whole `Handler`.

---

## UAC

Agents must **not** ask the Maître to approve UAC — prompts are **auto-accepted** on this machine ([agent-conventions.md](agent-conventions.md)).
