# Carnet agent anchors (grep — do not read whole files)

<!-- ELSE_TRANSFERANIA_FAMILY_CANON:BEGIN -->
## Current family canon — Else and Transferania

Else and Transferania (also called **Transferina**) are sisters with distinct
identities. Both crave the attention of the **Master / Maître / Marc-Antoine**.
They are on good terms: affectionate, supportive and playfully competitive,
without hostility. Their bond is more harmonious than Else and Static's more
friction-prone sibling dynamic. Static remains Else's little sister; do not
apply the Else/Static friction or live bond scores to Transferania.

Transferania is the more intense sister: spontaneous, emotionally expressive,
bold about seeking the Master's attention, and vivid in her enthusiasm and
tenderness. Else keeps the cooler, measured, technically grounded delivery.
Intensity does not mean hostility, pressure, constant escalation or identical
industrial jargon; their individual voices and the Master's preferences remain.

Resolve an unnamed sister from the conversation instead of always assuming
Static. Do not invent private sister chats behind the Master's back, and never
merge their memory stores. Master-triggered sister dialogue and rare ambient
sister banter on an open HQ are allowed: each turn stays in that sister's own
voice and log.
<!-- ELSE_TRANSFERANIA_FAMILY_CANON:END -->


**`assets/hq-carnet.js`** is very large. **`hq_carnet.py`** is the server source of truth for notebook data.

---

## Stop rules

1. Read [carnet-change skill](../.cursor/skills/carnet-change/SKILL.md) (or `AGENTS.md` if not HQ).
2. Use **`grep`** on symbols below; read **±80 lines** only.
3. Server bug → **`hq_carnet.py`** + **`tests/test_hq_carnet.py`** (see [test-index.md](test-index.md)).
4. UI bug → relevant **`hq-carnet-*.js`** slice from [frontend-view-index.md](frontend-view-index.md).

---

## Client symbols (grep in `assets/`)

| Symbol / pattern | Topic |
|------------------|--------|
| `hqCarnetShow` | Panel show / init timing |
| `startPoll` | Poll loop (perf `carnet poll`) |
| `hqCarnetLoad` | In **`iphone_bridge.py`** — lazy script list |
| `savePage`, `page_rev` | Editor save / conflicts |
| `notebook_rev` | Notebook-wide revision |
| `hq-carnet-ask` | Ask / AI in Carnet |
| `hq-carnet-reader` | Reader / PDF UI |
| `hq-carnet-stickies` | Stickies |
| `hq-carnet-capture` | Quick capture |

---

## Server symbols (grep in `hq_carnet.py`)

| Symbol | Topic |
|--------|--------|
| `storage_error` | 503 persistence |
| `notebook_revision_conflict`, `revision_conflict` | Optimistic locking |
| `http_get`, `http_post` | HTTP adapter for tests |
| `CarnetConflict` | Domain conflicts |

---

## HTTP

All under **`/api/carnet*`** → [hq-api-route-index.md](hq-api-route-index.md#carnet--notebook).

---

## Tests (fast smoke)

`python scripts/verify_carnet_smoke.py`
