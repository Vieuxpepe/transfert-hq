# ATELIER 3D — PHASE 1: CORE SLICING & PRINTER PROFILE INTEGRATION

**Branch / Repo:** `feat/atelier3d-phase1-slicer` at `C:\Transfert` (reconciled alongside Lecteur changes in `iphone_bridge.py`; intentionally uncommitted)  
**Target Slicer Verified:** OrcaSlicer `2.5.1.0` (`orca-slicer.exe`) + installed Bambu Studio (`BBL`) & Flashforge / `OrcaFilamentLibrary` vendor profile JSONs  
**Hardware Safety Policy:** Strictly offline slicing and validation; zero physical printer commands, heating, movement, uploads-to-printer, or AMS/IFS operations executed.

---

## 1. Root Causes Resolved (Including Counter-Audit P0 & P1 Fixes)

1. **P0 Fixed — Geometric arc-path bounds validation (`hq_print3d_models.py` `_arc_extrema_and_length`, `preflight_gcode`):**
   - Previous endpoint-only checking let a major clockwise/CCW `G2`/`G3` arc (`G1 X10 Y10 Z0.2` → `G2 X10 Y20 I-15 J5 E2`) sweep outside the bed (`X = -20.81 mm`) while both endpoints stayed inside bounds.
   - `preflight_gcode()` now enforces `plane == "G17"` (`G18`/`G19`/`G90.1` fail closed), rejects duplicate axis parameters on `G2`/`G3`, rejects non-zero `K`, rejects mixed or missing `I/J` vs `R`, rejects zero-chord `R` or impossible `R` chords and radius mismatches, handles relative `G91` movements and helical Z bounds (`ex_min_z..ex_max_z`), and evaluates exact cardinal extrema (`0`, `π/2`, `π`, `-π/2`) across partial arcs (`G2` CW / `G3` CCW / `R > 0` minor / `R < 0` major) and full/helical circles (`P >= 1` or zero-chord `I/J`). Extruding arcs check all path extrema against the printable bed; non-extruding arcs check against `travel_box`.
2. **P1 + Phase 1.2 Fixed — Immutable, atomic & tamper-checked sliced artifacts (`hq_print3d_models.py` `_publish_immutable_slice`, `_record_slice_meta`, `get_slice_provenance`; `hq_print3d.py` `plan_print` / `_start_print`):**
   - `_publish_immutable_slice()` writes and `os.fsync()`s the complete validated output into a hidden dot-temp file (`.hq-slice-<sha8>-<suffix>.tmp`, ignored by `Library._walk()`), **re-hashes the synced `.tmp` file** and asserts it matches the source digest, then atomically publishes via `os.link` (on filesystems without hardlinks, acquires a cross-process `_interprocess_file_lock` in `tempfile.gettempdir()`, verifies non-existence, and performs a single-step `os.replace` — zero empty-file window and zero lockfile clutter in `Print/`).
   - **H1 & H2 Fixed — Durable transactional provenance (`slice_provenance.db`):** `_record_slice_meta()` stores provenance authoritatively in SQLite (`.hq-print3d/slice_provenance.db`, `PRAGMA busy_timeout=5000`, `PRAGMA synchronous=FULL`, `BEGIN IMMEDIATE` .. `COMMIT`), preventing cross-process lost updates. Persistence errors raise `ModelError(..., 503, "slice_registration_failed")` without ever being swallowed, and `slice_model()` / `assemble_and_slice_plate()` unlink the unregistered `.gcode.3mf` before propagating the error.
   - **Explicit `plan_print()` Provenance Policy (`hq_print3d.py`):** During `start_print()`, `_stage_model_file()` snapshots to a `0600` temp file. `plan_print()` verifies `file_sha256(staged_path)` against `slice_provenance.db`. Internal sliced artifacts (`is_internal_sliced_name`, `*_sliced*` / `*_studio*`) MUST have a valid `slice_sha256` (`422 missing_slice_provenance` if missing; `422 slice_tampered` if altered; sets `provenance_policy="verified_slice_sha256"`), whereas external user-imported files without provenance proceed under explicit `provenance_policy="external_preflight_only"` (`preflight_gcode`, model match, and pre-upload `staged_path` SHA-256 re-check).
3. **P1 Fixed — Canonical bed ceiling & centered origin preservation (`hq_print3d.py`, `hq_print3d_slicer.py`):**
   - `Controller.save_printer()` rejects user-configured beds exceeding the canonical model volume (`422 out_of_bounds`).
   - `resolve_slicer_config()` validates `bed_override` against `profile_base["bed"]` (`20 <= dim <= canon`), rejecting inflated dimensions and automatically keeping centered origins (`-bx/2, -by/2`) consistent when a user narrows `AD5M` dimensions.
   - `_resolve_slice_printer()` also clamps any legacy oversized config entries to canonical dimensions before slicing.
4. **P1 Fixed — Studio print-ready invalidation, async race protection & slice-time snapshot (`assets/hq-print3d.js`):**
   - Studio tracks monotonic `studio.sliceSeq`, input `slicedFingerprint`, and captured `slicedSettings` at request launch.
   - Any mid-flight parameter/printer/transform edit invalidates `slicedModel`, increments `sliceSeq`, drops late stale responses, and drops out-of-order responses superseded by newer slice requests. `Imprimer` remains hidden/disabled until re-sliced cleanly; `openStudioPrintConfirm()` re-checks `isSliceReady()` and displays slice-time `slicedSettings` rather than mutable unsliced inputs (`check_hq_print3d.mjs` #63–#64).
5. **OrcaSlicer CLI preset resolution (`hq_print3d_slicer.py`):**
   - Pure-stdlib `resolve_slicer_config(...)` flattens vendor `inherits` chains iteratively (failing closed on cycles, missing ancestors, or malformed JSON), applies `* template *.json` hooks (falling back cleanly to sibling `0.4 nozzle` templates on `A1`/`A1 mini`), clamps/validates nozzle & layer ranges, validates material + plate thermal compatibility, centers `wipe_tower_x`/`wipe_tower_y` when `n_tools > 1`, and writes full `"from": "User"` JSONs.
   - `Library._run_resolved_slice()` captures CLI `stderr`/`stdout` in binary mode with bounded `decode("utf-8", "replace")` and `timeout=180`.
6. **Metadata propagation & Dialect preflight rules:**
   - `read_slice_info()` / `parse_all_plates()` use `_fallback_project_model()` on `Metadata/project_settings.config` strictly when `<plate>` has empty `printer_model_id`.
   - `preflight_gcode()` validates Flashforge `EXCLUDE_OBJECT_{DEFINE,START,END}` (`klipper_ff`/`marlin_ff` only, regex-checked `NAME`/`CENTER`/`POLYGON`) and `M104`/`M109` `N0`/`N1` preheat flags (`klipper_ff`/`marlin_ff` only), rejecting `bambu` cross-dialect usage and malformed parameters.
7. **Portable offline tests (`tests/test_hq_print3d.py`, `tests/test_hq_print3d_slicer.py`):**
   - Offline placement/bounds/invalidation/concurrency tests pass synthetic `profile_roots` so they run deterministically without a local OrcaSlicer install, while `OrcaSlicerLiveIntegrationTests` remains cleanly gated by `@unittest.skipUnless(models.Library.find_slicer(), ...)`.

---

## 2. Verification Status Against Phase 1 Criteria

| Criterion | Verified State | Evidence |
|---|---|---|
| Slicing réel avec OrcaSlicer (`orca-slicer.exe`) | **Pass (live)** | `OrcaSlicerLiveIntegrationTests` passes across `A1`, `A1 mini`, `P1S`, `AD5M`, `AD5X`, and `Creator 5` |
| Validation géométrique des arcs (`G2`/`G3` + `R` + `P` + `G91`) | **Pass (P0)** | `test_preflight_arc_geometry_and_fail_closed`: rejects `G2 X10 Y20 I-15 J5`, `R < 0` escapes, `G91` relative escapes, helical Z OOB, full-circle bed escapes, duplicate axes, `G18`/`K`/mismatch |
| Immutabilité atomique, H1 fail-closed & H2 SQLite | **Pass (P1 + H1/H2)** | `test_immutable_slice_artifacts_and_concurrent_uniqueness`, `test_slice_registration_failure_and_provenance_policy`, `test_multiprocess_slice_provenance_no_lost_updates` (`BEGIN IMMEDIATE`, write-error unlink, `missing_slice_provenance`, `external_preflight_only`, bi-process barrier) |
| Plafonnement plateau canonique & origine | **Pass (P1)** | `test_inflated_custom_bed_rejected_and_centered_origin_preserved`: rejects `2000³` in `save_printer` and `resolve_slicer_config`, preserves `-bx/2, -by/2` on `AD5M`, clamps legacy configs |
| Invalidation Studio, race async & confirmation | **Pass (P1)** | `check_hq_print3d.mjs` #62–#64 (`Imprimer` invalidated on edit, drops late/out-of-order async responses, confirmation shows slice-time settings) |
| Sélection modèle exact / matériau / plateau | **Pass** | `printerForm()` `data-field="model"` + `_resolve_slice_printer()` + UI sync (`check_hq_print3d.mjs` #60–#61 + Python HTTP/live tests) |
| Dimensions réelles STL dans `Préparer` | **Partial (Phase 2)** | `addToStudio()` initializes `dx: 36, dy: 36, dz: 24` and asynchronously updates `.stl` bounds via `HQModel.parse()`; synchronous bounds, rotated bboxes, and collisions remain **Phase 2** (`assemble_and_slice_plate()` parses and bounds real STL triangles server-side before slicing) |
| Cohabitation Lecteur & auth/CSRF (`iphone_bridge.py`) | **Pass** | Disjoint `/api/print3d/*` (`_require_admin()` + `do_POST` `_check_csrf()`) vs `/api/lecteur/*`; `import iphone_bridge` clean; all `19` `tests.test_lecteur` pass |

---

## 3. Verification Results (Executed After Final Edit in `C:\Transfert`)

- **Syntax Checks:**
  - `node --check assets/hq-print3d.js` → **PASS**
  - `python -m py_compile hq_print3d_slicer.py hq_print3d_models.py hq_print3d.py iphone_bridge.py tests/test_hq_print3d_slicer.py tests/test_hq_print3d.py tests/test_hq_print3d_http.py` → **PASS**
- **JavaScript Suites:**
  - `node tests/check_hq_gcode_view.mjs` → **`hq gcode view checks ok (13)`**
  - `node tests/check_hq_print3d.mjs` → **`hq print3d checks ok (64)`**
- **Python Unit, HTTP, Slicer (Live OrcaSlicer) & Lecteur Suites:**
  - `python -m unittest tests.test_hq_print3d tests.test_hq_print3d_http tests.test_hq_print3d_slicer tests.test_hq_print3d_errors tests.test_hq_print3d_filament tests.test_hq_print3d_watch tests.test_lecteur -v`
  - Result: **`Ran 182 tests in 200.453s — OK (skipped=1)`**
  - Single skip: `test_symlinks_are_skipped (symlink privilege unavailable)` on Windows.
