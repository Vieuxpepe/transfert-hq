# ATELIER 3D — PHASE 3 / 3.1: FULL INTERACTIVE 3D PREPARE STUDIO

**Branch / Repo:** `feat/atelier3d-phase1-slicer` at `C:\Transfert` (uncommitted working candidate integrating Phases 1 / 1.2, 2 / 2.1, 3, and 3.1 corrective fixes)  
**Hardware Safety Policy:** Zero physical printer commands executed (`printer/start`, heater, motion, filament load, and AMS/IFS routes never triggered; Phase 1.2 SQLite provenance, SHA-256 verification, atomic immutable slice publication, and G-code preflight preserved intact).

---

## 1. Phase 3.1 Counter-Audit Findings Resolved (`NO-GO` → Remediated)

1. **H1 Fixed — Authoritative Source Versioning, Cache Invalidation & Slice Boundary Check (same-ID / equal-triCount file replacement):**
   - **Backend (`hq_print3d_models.py`, `iphone_bridge.py`):**
     - Added `_SOURCE_SHA_CACHE` & `_source_sha256_path()` (`O_NOFOLLOW`, `fstat` keyed by `(path, st_ino, st_size, st_mtime_ns)`).
     - `Library._walk()` attaches `"version": f"{st.st_size}:{mtime_ns}"`; `Library.scan(force=True)` clears both `_STL_BOUNDS_CACHE` and `_SOURCE_SHA_CACHE`.
     - `Library.get()` resolves confined path first and attaches `"source_sha256"` and `"version": sha` alongside `stl_bounds`.
     - Added `Library.open_file_with_sha()` (preserving the 3-tuple `open_file()` contract), hashing directly from the confined open fd before `seek(0)`.
     - `/api/print3d/models/file` (`iphone_bridge.py`) calls `ctl.library.open_file_with_sha()` and returns `Cache-Control: private, no-store`, `X-Model-Sha256`, and `ETag` on `200`/`206`/`416` responses.
     - `assemble_and_slice_plate()` computes authoritative `actual_sha` from the bytes on disk (`raw_bytes`), verifies each item's `expected_sha256` (`409 source_changed` on mismatch across both STL assembly and non-STL `use_direct` paths), and records `"source_hashes"` in SQLite `slice_meta`.
   - **Frontend (`assets/hq-print3d-prepare.js`, `assets/hq-print3d.js`):**
     - `fetchStl` / `fetchFullStl` / `readStlBody` send `cache: "no-store"` and attach response `X-Model-Sha256` / `ETag` onto `buf._hqVersion`.
     - `createMeshStore` tracks `version` + monotonic `meshRev` (`getCached(modelId, expectedVersion)`, `invalidate(modelId)`, `acquire(m, { force, version })`), automatically evicting stale entries when source hash/version changes even if triangle count is unchanged, and bumping `meshRev` so `ensureMeshVBO` re-uploads fresh GPU buffers (`glGen`, `meshRev`, `triCount`).
     - `stlDimsCache` is version-keyed via `getCachedDims` / `setCachedDims`; `syncStudioSourceVersions()` evicts stale cache entries, clears stale slice fingerprint, and re-acquires updated meshes; `"Trancher"` attaches `expected_sha256` on `studio/slice` and recovers cleanly on `409 source_changed`.

2. **H2 Fixed — WebGL Context Loss & Restoration Lifecycle (`assets/hq-print3d-prepare.js`):**
   - `createViewport` tracks monotonic `glGen` across GL resource initialization, context loss, and restoration.
   - `onLost(e)` calls `e.preventDefault()`, sets `contextLost = true`, increments `glGen`, and resets all GPU handle caches (`vbos`, `bedVbos`, `bedKey`, `boxVbo`, `boxWireVbo`, `meshProg`, `lineProg`) via `freeGLResources(true)` **without calling `gl.delete*` on dead context handles**. `drawNow()` short-circuits cleanly if `contextLost || gl.isContextLost()`.
   - `onRestored()` resets `contextLost = false`, increments `glGen` again, clears caches, recompiles shader programs (`initGLResources`), rebuilds bed/cage VBOs (`ensureBedBuffers`), invokes `onContextChange(false)`, and triggers `drawNow()` so every active STL mesh uploads fresh generation-current VBOs (even when `triCount` is unchanged).
   - Verified both deterministically (Fake-GL `glGen` tracking test in `tests/check_hq_print3d.mjs` proving `0` stale `gen-1` binds and `0` deletes while lost) and live in Chromium SwiftShader via `WEBGL_lose_context` (`tests/visual_studio_prepare_playwright.py`, restoring `94,889` rendered composited non-background pixels).

3. **Additional Observations Remediated:**
   - **Obs #1 (Elevated Z > 0 fail-closed):** Because OrcaSlicer CLI auto-drops disconnected single `.stl` parts onto `Z=0`, `assemble_and_slice_plate()` now rejects `z > 0.01` with `422 unsupported_z` (`"Élévation Z > 0 mm non supportée"`), and Studio displays a `Surélevé Z>0` badge/warning, blocks `"Trancher"`, and offers a `"Pose Z = 0"` quick button in `.p3d-studio-obj-acts`. `transform_stl_triangles(z=...)` retains exact `Z >= 0` placement math.
   - **Obs #2 (Tight negative Z threshold `-0.01 mm`):** Both Python (`transform_stl_triangles`, `assemble_and_slice_plate`) and JS (`transformVertices`, `itemBelowPlate` in `hq-print3d-prepare.js` & `hq-print3d.js`) tightened tolerance from `-0.25 mm` to **`-0.01 mm`**, so `z = -0.1 mm` fails closed with `below_plate`.
   - **Obs #3 (`computeTiltedStats` memoization for 300k meshes):** `computeTiltedStats(..., cacheHost)` caches tilted AABB statistics keyed by `scale | rot_x | rot_y` (bounded to `16` entries on `meshData._tiltedCache`), used by both `syncItemTiltedDims()` and `drawNow()`.
   - **Obs #4 (Hidden-object slicing semantics):** Object visibility toggle clarifies `"Masquer dans la vue (toujours tranché)"` / `"Afficher dans la vue (toujours tranché)"` and displays `"· (masqué)"` / `"Masqué (tranché)"` while keeping `it.visible === false` parts in the sliced plate.

---

## 2. Exact Files Changed / Added

### Modified
- `hq_print3d_models.py` — Authoritative `_source_sha256_path`, `Library.open_file_with_sha()`, versioned `Library.get()` / `_walk()` / `scan()`, `assemble_and_slice_plate()` disk SHA-256 verification (`409 source_changed`) + `"source_hashes"` in `slice_meta`, tightened `z < -0.01` (`below_plate`), fail-closed `z > 0.01` (`422 unsupported_z`).
- `iphone_bridge.py` — Lazy-loads `hq-print3d-prepare.js` before `hq-print3d.js`; `/api/print3d/models/file` uses `open_file_with_sha()` and emits `Cache-Control: private, no-store`, `X-Model-Sha256`, and `ETag`.
- `assets/hq-model-view.js` — Strict per-facet ASCII STL validation matching Python `_iter_ascii_stl_facets()`.
- `assets/hq-print3d-prepare.js` — Canonical transforms, lay-flat solver, Möller–Trumbore picker, versioned `createMeshStore` (`meshRev`, `invalidate`, `getCached`), memoized `computeTiltedStats`, strict `-0.01`/`+0.01` Z checks, `glGen`-tracked WebGL `onLost`/`onRestored` + 2D software fallback.
- `assets/hq-print3d.js` — Integrated `HQPrepare` 3D viewport, response `X-Model-Sha256` extraction onto `buf._hqVersion`, versioned `stlDimsCache`, `syncStudioSourceVersions()`, `expected_sha256` slice propagation + `409 source_changed` recovery, elevated `Z > 0` banner & `"Pose Z = 0"`, hidden-item `(masqué)` / `toujours tranché` labels, `Undo/Redo`, keyboard shortcuts.
- `assets/hq-print3d.css` — 3-column desktop Studio workspace + mobile drawers (`>= 44×44 px` touch targets, `16px` inputs).
- `tests/test_hq_print3d_slicer.py` — Added `test_same_path_replacement_updates_sha_bounds_and_rejects_stale_expected_sha256`, `test_elevated_z_and_tight_negative_z_fail_closed`, canonical transform & OrcaSlicer `2.5.1.0` tilted tests.
- `tests/test_hq_print3d_http.py` — Added `test_file_route_emits_fresh_sha256_on_overwrite_and_studio_slice_rejects_stale_hash`.
- `tests/check_hq_print3d.mjs` — Expanded to `74` checks (Phase 3 `#67–#71` + Phase 3.1 H1, H2 fake-GL generation test, Obs #1–4).
- `tests/visual_studio_prepare_playwright.py` — Expanded with Scenario 13 (live Chromium `WEBGL_lose_context` restore + stdlib PNG compositor pixel check) and Scenario 14 (live HTTP `m_wedge` STL swap under same ID / equal triangle count).

### Added
- `assets/hq-print3d-prepare.js`
- `tests/visual_studio_prepare_playwright.py`
- `ATELIER3D_PHASE3_INTERACTIVE_STUDIO_IMPLEMENTATION.md`
- `review/atelier3d-phase3-implementation-review.zip`

---

## 3. Canonical Transform & Parity Proof

Cross-language transform parity between Python `hq_print3d_models.transform_stl_triangles()` and JS `HQPrepare.transformVertices()` (`scale=1.35, rot_x=37.0°, rot_y=-22.5°, rot_z=118.0°, x=92.5, y=141.2, z=3.4`): **`max_diff_mm = 0.000007`**.

---

## 4. Chromium Desktop / Mobile Measurements & Benchmarks (Phase 3.1)

Executed in Playwright Headless Chromium (ANGLE/SwiftShader WebGL) via `tests/visual_studio_prepare_playwright.py`:

| Viewport | Layout / Stage First | Touch Targets (Toolbar / Cam / Obj / Input) | Horizontal Overflow |
|---|---|---|---|
| Desktop `1440×900` | 3-column grid (`Objects \| 3D \| Settings`) | Desktop sizing (`longTasks`: `[57, 116]` ms) | `False` |
| Mobile Portrait `390×844` | Stage first (`top: 418 < side: 1791`) | `44 px` / `44 px` / `44 px` / `44 px` | `False` |
| Mobile Landscape `844×390` | Side-by-side (`stage: 407, side: 407`) | `44 px` / `44 px` / `44 px` / `44 px` | `False` |
| Tablet `768×1024` | Stage first (`top: 264 < side: 1278`) | `44 px` / `44 px` / `44 px` / `44 px` | `False` |

| Synthetic Binary STL | Main-Thread Parse | Worker Parse | First WebGL Frame | Avg Orbit/Drag Frame (12 draws) | JS Heap |
|---|---|---|---|---|---|
| `10,000` triangles | `15.2 ms` | `60 ms` | `13.8 ms` | `0.13 ms` | `9.5 MB` |
| `100,000` triangles | `50.4 ms` | `49.2 ms` | `7.6 ms` | `0.08 ms` | `9.5 MB` |
| `300,000` triangles | `73.5 ms` | `78 ms` | `21.5 ms` | `0.05 ms` | `9.5 MB` |

- **Idle Rendering:** `idle_extra_draws = 0` (`rafPending = false`, `drawCount = 3`).
- **Live WebGL Context Recovery (`WEBGL_lose_context`):** `contextLost = false`, `glGen = 3`, `bedReady = true`, `vboCount = 1`, `nonBgSamples = 94,889` (`pngBytes = 13,236`).
- **Live Same-ID Source Replacement (`m_wedge` 40 mm → 80 mm, equal 8-tri count):** `dx = 80`, `sourceVersion = 621086c2d689ec480e4e3cd036a12446fa5b66723901f57b1cde4d503d664beb`.

---

## 5. Complete Verification Summary (Executed Post-Final Code Edit)

- `node --check assets/hq-print3d.js assets/hq-print3d-prepare.js` → **PASS**
- `node tests/check_hq_script_deps.mjs` → **PASS** (`4 load-time dependencies, 2 from lazy modules`)
- `node tests/check_hq_model.mjs` → **PASS** (`hq model (STL/GLB) checks ok`)
- `node tests/check_hq_gcode_view.mjs` → **PASS** (`13/13`)
- `node tests/check_hq_print3d.mjs` → **PASS** (`74/74`)
- `python -m py_compile hq_print3d.py hq_print3d_models.py hq_print3d_slicer.py hq_print3d_watch.py hq_print3d_filament.py iphone_bridge.py tests/test_hq_print3d_slicer.py tests/test_hq_print3d_http.py tests/visual_studio_prepare_playwright.py` → **PASS**
- Cross-language parity check → **`max_diff_mm=0.000007`** (**PASS**)
- Playwright Chromium E2E + Benchmarks (`python -m unittest tests.visual_studio_prepare_playwright -v`) → **`Ran 1 test in 152.650s — OK`**
- Python + Live OrcaSlicer `2.5.1.0` + HTTP + Lecteur Suite:
  `python -m unittest tests.test_hq_print3d tests.test_hq_print3d_http tests.test_hq_print3d_slicer tests.test_hq_print3d_errors tests.test_hq_print3d_filament tests.test_hq_print3d_watch tests.test_lecteur -v`
  → **`Ran 191 tests in 56.994s — OK (skipped=1)`** (`test_symlinks_are_skipped`, non-admin Windows account lacks symlink creation privilege).

---

## 6. Remaining Scope / Limitations

1. `.glb`, `.obj`, `.step`, and unsliced `.3mf` remain blocked for multi-object 3D Studio editing/slicing (`422 unsupported`); `.stl` is the supported editable format.
2. Collision checks evaluate 2D rotated bounding footprints rather than concave mesh-vs-mesh intersection; `Auto-placer` is a deterministic shelf heuristic.
3. Standalone elevated Z (`z > 0.01`) is explicitly rejected (`422 unsupported_z`) rather than silently dropped to `Z=0` by OrcaSlicer CLI.
4. Mobile touch testing used Playwright Chromium emulation (`hasTouch=True`); hardware iOS Safari testing remains an external manual check.
5. Working tree changes in `C:\Transfert` remain uncommitted pending merge review approval.
