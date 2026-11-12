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
- **Multi-item photos:** `intent` may also be `count`. A photo reply can carry `detections: {mode: add|count, rows: [{name, qty, unit, confidence, note,
  item_id?, qty_now?, place_id?, place}], places}`; the chip posts the reviewed rows to `POST /api/inventoria/detections` (`mode`, `rows`), which returns
  the usual `operation(s)` drafts. Tools: `report_detections` (needs `photo_kind: "objects"` and a prior `match_items`), `propose_changes` needs
  `photo_kind: "receipt" | "list"` when a photo is attached.
- **Boxes on the photo:** after `report_detections`, `locate_items` (one extra vision call, best effort) fills `rows[].boxes` with `[ymin, xmin, ymax, xmax]`
  integers 0-1000 (top-left origin, one per visible instance, max 12). The chip draws them over the photo; they are never posted back to `/detections`.

## Photo pipeline hardening

- **Resize / quality (chip):** tall or thin shots (receipts, aspect >= 1.7) keep a 2600 px long side (3.2 MP); others 1800 px (2.6 MP). EXIF is
  stripped by the re-encode. Blurry, dark, washed-out or low-resolution photos show a warning with a *Retake* button (never blocking).
- **Counts are cross-checked:** `locate_items` runs without being told the counts, so its box count is an independent count. Each row gets
  `verify` (`ok | mismatch | grouped | unchecked | unseen | unavailable`) and `seen_count`; a mismatch lowers confidence to `low`. The review card shows
  "N seen" / "not located" tags. Per-photo accuracy on real pictures is measured with `scripts/vision_bench.py` (add `--stress` for degraded variants).
- **Weights and decimals:** `report_detections` accepts decimals; `whole_amount()` converts to whole numbers in a smaller unit (0.85 kg -> 850 g) for new
  items and rounds with a note for existing ones. `propose_changes` adjust accepts `amount` + `unit`.
- **No silent truncation:** over 60 detected kinds, 20 proposals or 40 grocery lines the overflow is reported (`truncated`, per-index errors, a banner).
- **Same photo twice:** a SHA-256 fingerprint (never the image) is kept 30 days in `.hq-inventoria/photos.json`. A repeat returns
  `duplicate_photo: {at, applied}` without calling the model; resend with `force: true` to analyse anyway.
- **Resilience:** vision chain `gemini-3.1-flash-lite -> gemini-3.5-flash-lite -> gemini-3.6-flash`, one automatic retry on transient errors
  (429/5xx/busy), friendly `model_busy` (503, `retryable: true`) / `model_error` (502) replies that never echo provider text. The chip has a Cancel
  button on the typing row and a "Try again" notice.
- **Reviews survive a reload:** assistant messages keep `meta` (detections with places, grocery lines) and `GET /sessions/{id}` returns
  `pending_operations` (draft/validated/previewed, max 10). The photo itself is not kept.
- **Privacy:** photos go to Google (Gemini) for analysis. The chip shows a first-use notice, Settings has an "allow photos" toggle (hides the photo
  button), photo payloads are limited to ~2 MB (`PHOTO_B64_MAX`), and receipts should be cropped so card digits are not visible.
