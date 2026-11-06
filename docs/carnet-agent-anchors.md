# Carnet agent anchors (grep — do not read whole files)

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
