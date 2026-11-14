# Master prompt — iPad / phone drawing pad, next round

Paste everything below the line into a fresh agent session opened on `C:\Transfert`.

---

You are extending **Transfert HQ**, a personal home-server web app (Python stdlib bridge `iphone_bridge.py` + plain ES2020
assets, no build step, French UI). A "second screen" feature already exists: an iPad or phone draws with a finger or an
Apple Pencil and the strokes appear live on the PC's **Dessiner** canvas. Your job is to make it feel like a real drawing
tablet. Implement **every item below**, in the phase order given, cleanly and with tests.

## 0. Read first (do not skip)

1. `docs/agent-conventions.md` (global contract, maps, stop rules) and `docs/test-index.md`.
2. The existing feature, end to end:
   - `hq_desk.py`: in-memory relay. Mailboxes per role (`pc`, `phone`), long poll ≤ 20 s, message `TYPES` allowlist
     (`pad`, `remote`, `player`, `flick`, `ping`), `MSG_BYTES` 16 KiB, `STATE_BYTES` 4 KiB, `CLIENTS_MAX`, `MSG_TTL`.
     Routes (admin only, wired in `iphone_bridge.py` `_hq_get` / `_hq_post`): `GET /api/desk/poll|peer`,
     `POST /api/desk/send|state|leave`. Tests: `tests/test_hq_desk.py`.
   - `assets/hq-desk.js`: `host(win)` runs on computers, `phone(win)` on any device whose PRIMARY pointer is coarse (phones,
     iPads). Pure helpers exported for Node: `norm`, `mergeMove`, `isPhoneLike`, `penGate`, `flickOk`. Pad messages are
     `{type:"pad", data:{op, s, pts}}` with `op` ∈ `begin | move | end | cancel | undo | hover`; points are `[x, y]`
     normalised 0..1 to the visible PC canvas (y down). A send queue serialises POSTs and coalesces `move` / `hover`.
     Palm rejection: once a pen is seen, touch does not draw unless « Pencil + doigt » is on (`penGate`).
   - `assets/hq-desk.css`: pad sizing uses `--ar` (PC canvas aspect) and fills the sheet on tablets.
   - `assets/hq-dessiner.js`: `window.hqSketchRemote = { ready, size, begin, add, end, cancel, undo, hover }`. A remote
     stroke previews in `previewFn()` (`st.remote`, `st.remoteHover`) and commits through `mutate(d => S.addStroke(...))`,
     so it is undoable like a local pen stroke. View state: `st.view = {x0, y0, ppu}`, `st.H`; conversions
     `S.toModel(view, H, sx, sy)` / `S.toScreen(...)` in `assets/hq-sketch-core.js`, which also has `addLine`, `addRect`,
     `addCircle`, `addStroke`, `fitView`, `LIMITS`. Dessiner's own pinch / pan code is around the pointer handlers
     (`onDown` / `onMove`, "a pinch cancels…"). Eraser: `eraseAt(m, e)`. Save: a name dialog then `doSave(name)`.
   - `hq_drawings.py`: the server-side validator / renderer (PNG, DXF, STL) that mirrors the sketch model. Any change to the
     document model MUST be mirrored here, with a document `version` bump and backward-compatible reading of old versions.
   - Dessiner underlays: a doc of `version: 3` may carry `underlay: {asset_id, fit:"contain"}` where `asset_id` is a Carnet
     Stage-06 asset (`asset-[0-9a-f]{24}`). `hqSketchStartUnderlay(assetId, opts)` starts a fresh drawing on one (the Carnet
     already uses it, see `assets/hq-carnet.js` around `hqSketchOpenExact`). Quick Capture
     (`assets/hq-carnet-capture.js`) shows how a photo becomes a Carnet asset (`HqCarnetMedia.prepare` + `/api/carnet/asset`).
   - Forge inpaint (`assets/hq-forge-inpaint.js`, `hq_forge_inpaint.py`): a mask painted with a finger on a canvas.
   - Node checks: `tests/check_hq_time_sky_desk.mjs` (desk helpers live here; extend it or add a sibling file).

## 1. Rules

- Smallest clean diff per item; no drive-by refactors. Keep the existing patterns: UMD modules with pure, Node-testable
  helpers + a DOM `mount`; DOM built with `createElement`, never HTML strings; LF line endings; UTF-8.
- French UI copy, short and warm, matching the existing sheet («Pad», «Annuler», «Pencil seul»…). Respect
  `prefers-reduced-motion`. Touch targets ≥ 44 px. Works at 375 px wide and on an 11″ iPad in landscape.
- Security: every new route is admin-only and CSRF-checked like the existing `/api/desk/*`; bound every size, count and
  rate; never accept a filesystem path from the client; never echo exception text; stable JSON `code` on errors.
  Add rows to `docs/hq-api-route-index.md` and `docs/test-index.md`.
- Nothing persistent goes in browser storage. The relay stays in memory.
- The working tree has many uncommitted changes that are NOT yours: never revert, reformat or commit them. Touch only the
  files your items need. **Do not commit, and do not restart the live bridge** unless the Maître asks.
- Known pre-existing failures to ignore (unrelated `setView` signature change):
  `tests.test_media_viewer.LecteurTabStaticTests.test_tab_and_panel` and
  `tests.test_dessiner_bootstrap.BootstrapPageTests.test_show_hooks_cannot_abort_startup`.

## 2. What to build

### Phase A — the pad becomes a window onto the drawing

**A1. Show the PC's drawing on the pad.** The pad is blank today, so you draw blind.
- On the PC, after any change to what the canvas shows (commit, undo/redo, view pan/zoom, resize, underlay load), debounce
  ~150 ms, render the visible canvas to a WebP/JPEG (longest side ≤ 1280 px, quality ~0.6) and upload it.
- Relay: add a snapshot slot (`POST /api/desk/snapshot` raw image body ≤ 512 KiB, `GET /api/desk/snapshot?rev=N` returns
  the latest image with `Cache-Control: no-store`; 404 when none). One slot per PC client, in memory, replaced on each
  upload; `rev` increments. Publish `{snapshot_rev}` in the PC desk state so the pad knows when to fetch.
- Pad: show the snapshot under the local ink, dimmed (~55 % opacity), aligned to the same `--ar` box. Remote strokes in
  flight must not be baked into a snapshot (render without `st.remote` / `st.remoteHover`).
- Tests: Python for size/type bounds, rev, replacement, admin-only; Playwright check that a stroke drawn on the PC shows
  up in the pad's background image.

**A2. Fingers navigate, the Pencil draws** (Procreate-style), active once a Pencil has been seen and « Pencil + doigt » is
off. Two fingers on the pad pan and pinch-zoom the PC view; one finger does nothing.
- New pad op `view` carrying a normalised pan delta and a zoom factor around a normalised centre; throttle to ~30/s and
  coalesce in the send queue like `hover`.
- New `hqSketchRemote.pan(dx, dy)` / `zoom(factor, cx, cy)` reusing Dessiner's own view maths (anchored zoom, same
  `ppu` limits), then `scheduleDraft()`-style persistence like a local pan.
- Instant local feedback: CSS-transform the snapshot during the gesture, swap in the fresh snapshot when it arrives.
- Pure helper for the two-finger maths (centre, distance ratio), Node-tested.

### Phase B — drawing quality

**B1. Hold to snap into a real shape.** At the end of a Pencil (or finger) stroke, if the tip stays still (< 4 px) for
≥ 450 ms while still down, recognise the stroke and, on release, replace it with a true Dessiner entity:
line → `S.addLine`, circle → `S.addCircle`, rectangle → `S.addRect` (axis-aligned, or rotated only if the model supports
it — check first). Unrecognised → keep the freehand stroke.
- Put the recogniser in a new pure module (e.g. `assets/hq-shape-snap.js`, loaded on both sides): line = max deviation
  from the chord < 4 % of its length; circle = closed path, radius coefficient of variation < 0.12; rectangle = closed path
  with 4 corners near 90°. Return `{kind, params}` in normalised coordinates.
- The pad previews the snapped shape (a quick morph + haptic) during the hold; `end` carries `snap: {kind, params}`; the
  PC converts the params to model space and commits ONE undoable mutation.
- Node tests with synthetic noisy lines / circles / rectangles / scribbles (true and false positives).

**B2. Pressure and thickness, saved.** Strokes get a width. Pencil pressure modulates it along the stroke; fingers use the
chosen thickness.
- Extend the stroke object in `hq-sketch-core.js` with an optional per-point width (or per-stroke base width + per-point
  factor, whichever keeps documents small). Bump the document version, keep reading older versions, mirror the validation
  and the PNG rendering in `hq_drawings.py` (DXF keeps plain polylines; say so in a comment). Respect `LIMITS`.
- Pad messages carry the width per point (rounded, compact). Local pen strokes on the PC with a pressure-capable device
  should use the same field.
- Python + Node tests for validation, limits, version compatibility and rendering.

**B3. Eraser and thickness picker (small touch).** In the pad's button row: a pen / eraser toggle and 3 thickness dots
(fine, medium, bold) that feed B2. Eraser mode sends an `erase` op with points; the PC applies it through the same path as
`eraseAt`, grouped into one undo step per gesture.

### Phase C — new sources and targets

**C1. Photo → tracing background.** In the pad's Pad tab, a « Photo à décalquer » button: take or pick a photo, upload it
as a Carnet asset through the existing media pipeline (load the Carnet scripts lazily like the radial menu does with
`hqCarnetLoad`), then send a `remote` command `underlay` with the asset id. On the PC add `hqSketchRemote.setUnderlay(id)`
that sets the underlay on the CURRENT drawing as one undoable change (no `window.confirm` on the PC — it can't be answered
from the iPad; upgrade the doc to version 3 if needed). Validate the id format on both sides.

**C2. One pad, many targets.** Generalise `hqSketchRemote` into a small registry (`window.hqPadTargets`), each target
implementing `{id, label, ready(), size(), begin, add, end, cancel, undo, hover?, snapshot?}`. The PC desk state publishes
the active target (`sketch` when Dessiner is shown, `inpaint` when the Forge inpaint editor is open). Implement:
- `sketch`: today's behaviour (move the existing hook behind the registry; keep `hqSketchRemote` as an alias).
- `inpaint`: paint the Forge inpaint mask from the pad, with the image as the snapshot; pen = add, eraser = remove.
- Carnet: confirm that « annotate this image » already opens Dessiner on the image (the underlay flow); if it does, the pad
  works there for free — add an obvious entry point if one is missing, nothing more.
The pad's header shows which target it is drawing on.

### Phase D — small touches

- **Two-finger tap = Annuler**, three-finger tap = Rétablir (both distinguished from the A2 gestures: lift within 250 ms,
  movement < 10 px).
- **Save from the pad**: an « Enregistrer » button sends `remote` `save`. On the PC, `hqSketchRemote.save()` saves without
  the name dialog when the drawing is unnamed (auto name « iPad AAAA-MM-JJ HHhMM »), otherwise saves under its name.
- **Acknowledgements**: add a relay message type `ack` (PC → pad) so save, underlay, snap and errors give feedback on the
  pad (short status line + haptic). Keep the type allowlist strict.
- **Latency polish**: draw the local ink with `getPredictedEvents()` when available (discard predictions on the next
  real event); keep `FLUSH_MS` at 40 ms unless measurements say otherwise.
- **Undo / redo buttons** on the pad, with the PC's history state (can undo / can redo) published in desk state so the
  buttons enable correctly.

## 3. How to verify (mandatory)

- Unit: `python -m unittest tests.test_hq_desk tests.test_hq_timeline tests.test_hq_carnet_graph -v`, your new Python
  tests, the drawings tests (`tests/test_hq_drawings.py`), `node tests/check_hq_time_sky_desk.mjs`,
  `node tests/check_hq_dessiner_motion.mjs`, `node tests/check_hq_3d_nav.mjs`, `python scripts/verify_bridge_smoke.py`.
- Browser, on a THROWAWAY server only (never the live root, never ports 8765/8766/8776/7860):
  `tail -f /dev/null | python tests/carnet_test_server.py <fresh-empty-temp-dir>` (it waits on stdin; fake PINs
  `424242` admin). Its config inherits `client_debug_hud: true`, so hide `#hq-debug-panel` in every page before clicking,
  and never wait for `networkidle` (the desk long poll keeps the network busy) — wait for `#btn-timemachine` instead.
- Drive two Playwright contexts at once: a 1440×900 desktop on Dessiner and `devices["iPad Pro 11 landscape"]`.
  Pencil input = CDP `Input.dispatchMouseEvent` with `pointerType: "pen"` and `force` (pressure); palm / fingers =
  `Input.dispatchTouchEvent`. Check each item by its effect on the PC (`hqSketchState().doc.objects`, entity types,
  widths, underlay, view) and take screenshots of both screens. Look at the screenshots.
- Report honestly what was verified in a browser, what only by unit tests, and what needs a real iPad (feel, Safari
  quirks).

## 4. Deliverable

A short report: what each item does, files touched, tests added and their results, screenshots taken, anything skipped
or deferred with the reason. No commit, no live-bridge restart.
