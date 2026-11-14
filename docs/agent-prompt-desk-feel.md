# Master prompt — iPad / phone drawing pad, "feel" round

Paste everything below the line into a fresh agent session opened on `C:\Transfert`.

---

You are polishing **Transfert HQ**, a personal home-server web app (Python stdlib bridge `iphone_bridge.py` + plain ES2020
assets, no build step, French UI). An iPad or phone already works as a drawing pad for the PC's **Dessiner** canvas: Apple
Pencil with pressure, palm rejection, hover cursor, pinch / pan of the PC view, two- and three-finger undo / redo, thickness
choice, a live picture of the PC canvas behind the pad, hold-to-snap shapes, save from the pad. It works. This round is about
how it **feels**: smoothness, latency, robustness, and the iPad behaving like a dedicated tablet. Implement **every item
below**, in phase order, cleanly and with tests.

## 0. Read first (do not skip)

1. `docs/agent-conventions.md`, `docs/test-index.md`, and the previous round's brief `docs/agent-prompt-desk-drawing-next.md`
   (its rules, test server and Playwright recipe all still apply).
2. The code you will touch, end to end:
   - `hq_desk.py`: in-memory relay, role mailboxes `pc` / `phone`, long poll, `TYPES` allowlist, `MSG_BYTES`, `QUEUE_MAX`,
     `MSG_TTL`, snapshots (`put_snapshot`, `latest_snapshot`). Routes in `iphone_bridge.py` (`/api/desk/*`, admin-only,
     CSRF-checked). Tests: `tests/test_hq_desk.py`.
   - `assets/hq-desk.js`: the link `L` (`L.send` → `mergeMove` coalescing → `pump()` posts **one at a time** and silently
     drops a failed POST; the poll loop backs off on errors). Phone side: `sample()`, `flush()` every `FLUSH_MS` (40 ms),
     points are `[x, y, w]` normalised 0..1, ops `begin | move | erase | end | cancel | undo | redo | hover | view`.
     Local ink: `ink.trail`, `paintTrail(preds)` (already draws `getPredictedEvents` at 35 % alpha), `fadeInk()` (fixed
     18-frame fade when the pen lifts). Shape snap: `armHold` / `assets/hq-shape-snap.js` (`HqShapeSnap.recognise`).
     Tool toggle `S.tool` pen / erase, thickness `S.thick`, `pointWidth`, `THICK`. Haptics go through `haptic(k)` →
     `window.hqPolishHaptic`. Pure helpers are exported for Node at the bottom (`return { VIEWS, norm, mergeMove, … }`).
   - `assets/hq-desk.css`: pad sizing (`--ar`, the tablet media query), `.desk-snap`, `.desk-ack`.
   - `assets/hq-dessiner.js`: `window.hqSketchRemote` (`begin / add / end / cancel / undo / hover / setUnderlay /
     snapshot`), the live remote stroke `st.remote` drawn in `previewFn()`, `snapshotBlob()`.
   - `assets/hq-radial.js`: the long-press radial menu; its pure `layout()` and `pickIndex()` are reusable.
   - `iphone_bridge.py` `/manifest.webmanifest` handler (search `"start_url"`).
   - Node checks: `tests/check_hq_time_sky_desk.mjs`, `tests/check_hq_pad.mjs`.

**Already built — do not rebuild:** predicted ink, hold-to-snap shapes, local ink fade, haptics, palm rejection, pinch view.
Several items below *improve* these; change them in place.

## 1. Rules

- Smallest clean diff per item, no drive-by refactors. Keep the patterns: UMD modules, pure Node-testable helpers plus DOM
  code, `createElement` (never HTML strings), LF, UTF-8, French UI copy short and warm, `prefers-reduced-motion` respected,
  touch targets ≥ 44 px, works at 375 px wide and on an 11″ iPad in both orientations.
- **Wire compatibility:** an old pad talking to a new PC, and a new pad talking to an old PC, must both still draw. New
  message fields are optional and ignored when absent. Don't rename an op.
- Security: anything new on the server is admin-only, CSRF-checked, bounded (size, count, rate), with stable JSON `code`
  errors and no exception text echoed. Update `docs/hq-api-route-index.md` and `docs/test-index.md`.
- Browser storage: allowed **only** for the per-device pad preferences named below (pressure curve, sound toggle), each
  read and write wrapped in `try/catch`, with sane defaults when storage is unavailable. Nothing else.
- The working tree has many uncommitted changes that are NOT yours: never revert, reformat or commit them. **Do not commit,
  and do not restart the live bridge** unless the Maître asks.
- Known pre-existing failures to ignore: `tests.test_media_viewer.LecteurTabStaticTests.test_tab_and_panel` and
  `tests.test_dessiner_bootstrap.BootstrapPageTests.test_show_hooks_cannot_abort_startup`.

## 2. What to build

### Phase A — smoothness (the biggest win)

**A1. Timed replay on the PC.** Points arrive in bursts (one batch per 40 ms flush, more when the network hiccups), so a
fast stroke grows on the PC in jumps.
- Phone: add an optional 4th element to each point, `t` = whole milliseconds since that stroke's `begin` (clamped
  0..600000), so points become `[x, y, w, t]`. Keep it inside `MSG_BYTES`.
- PC (`hq-desk.js` host side, feeding `hqSketchRemote.add`): a small per-stroke **replay buffer** played on
  `requestAnimationFrame` that releases points when `now ≥ strokeStartLocal + t + delay`. Start `delay` at ~40 ms and adapt
  it (within 20–150 ms) to the observed burst jitter, so playback rarely stalls. Points without `t` are added at once, as
  today.
- `end` / `cancel` / `undo` must wait behind the points still in the buffer (an `end` never commits a half-replayed stroke).
  A new `begin` flushes any previous buffer at once. Reduced motion → no delay, add at once.
- Put the scheduling logic in a pure helper (e.g. `replayStep(buffer, now) → {release, wait}`) and unit-test it: ordering,
  adaptive delay bounds, end-after-points, missing `t`, a 2-second gap.

**A2. Ink handoff on the pad.** Today the local trail fades on a fixed timer, so it can vanish before the PC picture shows
the stroke, or linger doubled next to it.
- Keep the finished stroke's local ink until the PC has it: either a newer snapshot rev (the PC already publishes
  `snapshot_rev`) taken after that stroke's `end`, or a short ack from the PC. Then crossfade over ~150 ms. Fallback: fade
  after 1.5 s whatever happens.
- Several finished strokes may be waiting at once; keep them as a short list of paths, not one canvas you can't untangle.
- Check alignment: the local ink and the underlay must line up within ~1 px at every pad size. If they don't, fix the
  mapping, not the symptom.

**A3. Measure before you tune.** Add an end-to-end latency figure (pad `pointermove` → PC `add`) to the existing debug HUD
only (`client_debug_hud`), using the replay timestamps. Report the numbers you saw on the throwaway server. Do **not**
change the transport (no WebSocket / SSE) in this round; if the numbers say it's needed, write that down as a
recommendation.

### Phase B — the iPad behaves like a tablet

**B1. Stay awake.** While the pad tab is open and visible, hold a Screen Wake Lock (`navigator.wakeLock.request("screen")`),
re-acquire it on `visibilitychange`, release it when leaving the pad or closing the sheet. Feature-detect; no error if
unsupported.

**B2. Home Screen pad.** Make "open straight onto the pad" possible:
- A deep link (e.g. `/?desk=pad`) that, on a phone-like device, opens the desk sheet on the Pad tab after boot.
- Add a manifest `shortcuts` entry to it, and a « Ajouter à l'écran d'accueil » hint on the pad explaining the Safari Share
  → Add to Home Screen step (shown once per sheet open at most, dismissible, only when not already standalone —
  `navigator.standalone` / `display-mode: standalone`).
- Login and auth flow unchanged: the deep link must survive the login redirect or degrade to the normal home.

**B3. No accidental exits.** While a stroke is in progress (or the pad has a pointer down), prevent the edge back-swipe,
pull-to-refresh and text selection / callout from stealing it. Use CSS (`overscroll-behavior`, `touch-action`,
`-webkit-touch-callout`) and `preventDefault` on the relevant touch events only on the pad, never page-wide.

**B4. Follow rotation.** On rotate or resize, the pad must re-fit to the PC canvas aspect at once, the underlay and local
ink re-map correctly, and a stroke in progress is cancelled cleanly (not drawn skewed). Verify portrait and landscape.

### Phase C — robustness

**C1. Survive a Wi-Fi blip.** Today `pump()` drops a failed POST, so a dropout loses part of a stroke.
- Pad messages (`pad` type only) get a short client message id. On a network error (not a 4xx), keep the message at the
  head of the queue and retry with short backoff (e.g. 250 ms → 2 s), still in order, while `mergeMove` keeps coalescing
  behind it. Give up and drop the stroke after ~20 s, telling the user.
- Server: make `send` idempotent for a recently seen `(client, id)` pair (small bounded LRU, TTL ≈ `MSG_TTL`), so a retry
  that actually got through the first time is not delivered twice. The `id` field is optional and validated
  (short `[0-9a-z]` string); old clients without it behave exactly as today.
- UI: a « Reconnexion… » state on the pad's status dot and ack line while retrying, cleared on success. The pad keeps
  inking locally during the outage.
- Tests: Python for dedupe and bounds; Node for the retry-queue helper (order kept, coalescing still works, give-up timer).

### Phase D — tools at your fingertip

**D1. Tool ring.** One finger held still ~450 ms on the pad opens a small ring: Stylo, Gomme, Fin / Moyen / Épais, and
Annuler. Lift on an item to pick it (marking-menu style), lift in the dead zone to close. Reuse `hq-radial.js`'s pure
`layout()` / `pickIndex()`; draw the ring inside the desk sheet.
- **Palm safety is the hard part:** never open the ring while a Pencil is down or within ~600 ms after a Pencil stroke,
  never for a contact whose reported width / height is palm-sized, never if a second finger lands, never if the finger
  moved more than a few px. When « Pencil + doigt » is off, a finger's ink is not drawn anyway, so the ring cannot conflict
  with a finger stroke; when it is on, a finger stroke that moves cancels the ring timer.
- Keep the existing toolbar buttons; the ring is a shortcut, not a replacement. Haptic tick on open and on pick.

### Phase E — small touches

- **E1. Pressure curve.** A « Réglage du Pencil » link on the pad: draw one stroke from light to heavy, and fit a gamma
  (clamped 0.5–2.0) that `pointWidth` applies to `pressure`. Stored per device (see storage rule). A reset button.
  Pure `fitGamma(samples)` helper with tests.
- **E2. Landing ripple on the PC.** A soft ring at the model point where a remote stroke begins (~400 ms), drawn in the
  preview layer, never in the document or in snapshots. Off with reduced motion.
- **E3. Pencil sound.** Optional, **off by default**: a faint paper-scratch from Web Audio (filtered noise, gain from stroke
  speed and pressure), started only after a user gesture, toggled from the pad, stored per device.
- **E4. Copy pass.** Every new string French, short, consistent with the sheet. Check every new control has an accessible
  name.

## 3. How to verify (mandatory)

- Unit: `python -m unittest tests.test_hq_desk tests.test_hq_drawings -v` plus your new tests; `node tests/check_hq_pad.mjs`,
  `node tests/check_hq_time_sky_desk.mjs`, `node tests/check_hq_sketch.mjs`, `node tests/check_hq_dessiner_motion.mjs`,
  `python scripts/verify_bridge_smoke.py`.
- Browser, on a THROWAWAY server only (never the live root, never ports 8765/8766/8776/7860):
  `tail -f /dev/null | python tests/carnet_test_server.py <fresh-empty-temp-dir>`, fake admin PIN `424242`. Hide
  `#hq-debug-panel` before clicking (except when checking A3), never wait for `networkidle` (wait for `#btn-timemachine`).
- Two Playwright contexts at once: 1440×900 desktop on Dessiner, `devices["iPad Pro 11 landscape"]` (and portrait for B4).
  Pencil = CDP `Input.dispatchMouseEvent` with `pointerType: "pen"` and `force`; fingers / palm = `Input.dispatchTouchEvent`
  (with `radiusX/Y` for a palm-sized contact in D1).
- Specific proofs:
  - A1: record the PC's `st.remote.pts` growth over time for a fast synthetic stroke sent in deliberate bursts; it must
    grow in many small steps, not a few jumps, and the committed stroke must equal the sent one.
  - A2: screenshot the pad right after a stroke ends: no doubled line, no blank gap.
  - C1: block `/api/desk/send` with `page.route` for 3 s mid-stroke, then release: the committed stroke on the PC is
    complete, with no duplicated points; the « Reconnexion… » state was shown.
  - D1: a palm-sized still contact and a touch during a Pencil stroke never open the ring; a small still finger does.
  - B2: `/?desk=pad` on the iPad context lands on the Pad tab; the manifest lists the shortcut.
- Look at your screenshots. Report honestly what was proven in a browser, what only by unit tests, and what needs a real
  iPad (wake lock, Home Screen shortcut, back-swipe, sound, how A1/A2 actually feel).

## 4. Deliverable

A short report: what each item does, files touched, tests added and their results, the A3 latency numbers, screenshots
taken (paths), anything skipped or deferred with the reason. No commit, no live-bridge restart.
