# Stage 02 accepted handoff

Base checkpoint:
`5ce460ec023219433f2343e509a6dd6679a6dfc4`

Working mode:
- local `C:\Transfert`
- branch `main`
- Stage 02 accepted and currently uncommitted unless the user has subsequently authorized a checkpoint commit

Accepted substantive Stage-02 files:
- `iphone_bridge.py`
- `README.txt`
- `assets/hq-carnet.js` (new)
- `assets/hq-carnet.css` (new)
- `tests/check_hq_carnet.mjs` (new)
- `tests/test_hq_carnet_ui.py` (new)
- `tests/visual_carnet_playwright.py` (new)

Editor contract now true:
- first-class Carnet nav/panel and guarded `hqCarnetShow`
- one responsive editor/state machine for Windows PC, iPad and iPhone
- per-user/per-page dirty drafts read only after admin identity is confirmed
- synchronous draft write before debounce
- one in-flight save per page
- generation + exact editable-state protection against late responses
- 409 preserves local content and pauses only that page
- polling never overwrites dirty/in-flight/conflicted pages
- metadata polling is visible/Carnet-only with one timer/listener set
- localStorage failure remains visible until affected edits are recoverable
- current-page save status is truthful; other-page attention uses a separate quiet indicator
- copy/select, symbol/time insertion, swipe, Alt+Left/Right and reduced-motion behavior accepted
- global mobile nav remains >=44x44; below 360 px full mode scrolls horizontally rather than shrinking targets
- `api()` now attaches `err.status` and JSON `err.data` while preserving 401/403 behavior

Stage-03 prerequisite — IMPORTANT:
- current Stage-02 local page state/drafts may contain stale `project_id` / `category_id`
- Stage 03 MUST adopt authoritative server project/category values during save success, 409 handling, remote refresh and draft recovery BEFORE Stage 03 ever starts sending those fields
- otherwise a stale client could resurrect a deleted category/project assignment

Accepted review tests:
- Node Carnet race/static suite: PASS
- full unittest discover: 346 PASS, 29 skipped
- py_compile/SyntaxWarning: PASS
- Chromium + WebKit Carnet Playwright: PASS, 396 checks
- nav bounding boxes at 320/375/390/430 px, simple/full, Chromium/WebKit: all visible buttons >=44x44
- relevant Dessiner/Model browser suites: PASS
- visual_media remains a pre-existing flaky touch-flow test
- visual_face still requires missing `manifold3d==3.5.4`
- CRLF-safe diff check: PASS

Known residuals:
- combined browser keepalive budget can reject some simultaneous large pagehide saves; drafts persist and retry
- Alt+Left/Right follows frozen page-navigation contract even though Apple Option+Arrow normally moves by word
- no physical iPhone/iPad/Windows-browser test yet
- pre-existing 320 px header status-chip overflow remains unrelated to Carnet nav
- never run Python/runtime imports from live `C:\Transfert`; use isolated source copies
