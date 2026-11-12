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
- Ids are stripped from replies; model replies are untrusted text (HTML/markdown removed, 900 characters max).
- Tests: `tests/test_hq_inventoria_ai.py` (tool validation, loop bounds, draft to real preview/commit, history,
  failure modes).
