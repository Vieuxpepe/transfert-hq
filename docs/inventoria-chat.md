# Inventoria chat (Gemini, tools, drafts)

`hq_inventoria_ai.py` is bound as `llm_adapter` of `hq_inventoria` (see `iphone_bridge.py`). One user message runs a
bounded loop (max 4 model calls, 8 tool calls, 10 drafts) through `hq_ai.generate` (same Gemini key, quota ledger and
fallback chain as the other companions).

- **Context sent each turn:** persona, language directive (English when her saved Phonon voice is English-only), a *partial*
  inventory summary (totals, places with ids, low stock, name matches), and the last 12 session messages.
- **Read tools (run automatically):** `search_items`, `get_item`, `list_places`, `list_place`, `list_low_stock`. Place arguments
  accept an id or an exact place name.
- **Draft tool:** `propose_changes` (`adjust`, `create`, `update`, `move`). Each change is built into a schema proposal,
  validated, resolved and batch-simulated against the live inventory; accepted ones are stored as a draft operation.
  Deletes are refused.
- **Nothing is applied from the chat.** The chip shows a review card (validate, then an unconfirmed preview with
  before/after numbers; *Appliquer* = confirmed preview + commit with an idempotency key; *Annuler* cancels). The
  existing pipeline guards every commit.
- **More tools:** `list_alerts`, `match_items` (batch fuzzy matcher + catalog for translations), `watch` / `unwatch`. Drafts allow up to 20
  changes; duplicate adjusts/creates inside one draft are refused. `POST /api/inventoria/watch` (set/remove) and the `alerts` and
  `watches` fields of `GET /api/inventoria/status` feed the chip.
- **Memory:** `remember` / `forget` tools and `/api/inventoria/memory`; notes live in `.hq-inventoria/memory.json` (30 max, secrets
  refused), are sent to the model as data, and are listed with delete buttons in the chip. See `docs/inventoria-persona.md`.
- **Greeting / status:** `GET /api/inventoria/status` builds a deterministic opening line from the live inventory (no model call).
- Ids are stripped from replies; model replies are untrusted text (HTML/markdown removed, 900 characters max).
- Tests: `tests/test_hq_inventoria_ai.py` (tool validation, loop bounds, draft to real preview/commit, history,
  failure modes).
- **Extra routes:** `POST /api/inventoria/purchased` (tick-off to an adjust draft, no model call), `POST /api/inventoria/ops/{id}/undo`
  (inverse draft), `POST /api/inventoria/to-grocery`, `POST /api/inventoria/notify`, and `image` (a data URL, 1.5 MB max after base64) on
  `/sessions/{id}/message` for photo intake. Transport cap 3 MB; every request without an image is capped at 1 MB.
- **More tools:** `set_store`, `meal_needs` (read-only), `list_alerts` rows may carry `days_left` (an estimate).
- **Photo routing:** `image` messages may carry `intent` (`stock` | `grocery`). The response can contain `grocery: {lines: [{name, qty, unit, store}]}`
  next to `operation(s)`; nothing reaches the grocery module until the chip posts the lines to `/to-grocery`, which appends to the newest open
  non-meal-plan list (max of existing/new quantity per name+unit) or creates one. Tool: `propose_grocery` (queue only).
