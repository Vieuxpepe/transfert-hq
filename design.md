# Design notes

## Planned: 3D view translation pan

**Status:** implemented (`feat/dessiner-3d-pan`). Right, middle or Shift + left drag pans with a mouse; two fingers pan and pinch on touch (solved from the gesture start, so it does not drift); wheel and pinch zoom stay anchored under the cursor or the fingers; Recentrer clears the pan; a pan never selects. Tests: `tests/check_hq_3d_nav.mjs` and `tests/visual_dessiner_3d_playwright.py`.

**Current behavior** (`assets/hq-solid-view.js`):
- One-finger / mouse drag orbits the model. The yaw direction was fixed so the model follows the drag horizontally; pitch already followed it vertically (clamped to ±1.48 rad).
- Wheel and two-finger pinch zoom (0.15×–10×).
- `state.panX` / `state.panY` exist and are applied in `projectPoint`, but no gesture changes them, so the model can't be moved sideways. `reset()` already zeroes them.

**Proposed gestures** (same vocabulary as 2D Dessiner and the face sketch):
- Touch: two-finger drag pans (combined with the existing pinch zoom, as in the face sketch). One finger keeps orbiting.
- Mouse: right-button or middle-button drag, or Shift + left drag, pans. Plain left drag keeps orbiting. Suppress the context menu on the canvas.
- Wheel keeps zooming.

**Behavior:**
- The model follows the pointer: a drag of (dx, dy) CSS px moves the projected model by exactly (dx, dy) on screen, whatever the orbit angle or zoom. Pan is in screen space: convert the pixel delta to clip space (account for the aspect divisor on x and the canvas CSS size vs backing size) and add it to `panX` / `panY`.
- Zoom should stay anchored sensibly with a pan applied (ideally zoom around the pinch centre or the cursor).
- A fit / "Recadrer" action (and the existing reset) sets `panX = panY = 0` and re-frames the model.
- Taps under 6 px must still select faces or edges, and a pan gesture must never select.

**What to test:**
- Offline (`tests/check_hq_3d_nav.mjs` style, stub canvas): after a pan drag, a projected vertex moves by the drag delta in screen pixels, in both axes, at several yaw/pitch/zoom values; orbit and zoom directions are unchanged; reset/Recadrer clears the pan.
- Browser (`tests/visual_dessiner_3d_playwright.py`): right-drag and Shift+drag on desktop, and a two-finger CDP touch drag on the iPhone profile, move the model with the pointer; one-finger drag still orbits; face and edge picking still hit the right element after panning (`faceAt` / `edgeAt` go through the same projection).
