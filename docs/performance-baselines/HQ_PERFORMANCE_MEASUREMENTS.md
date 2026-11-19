# Transfert HQ — performance measurements (consolidated)

Single reference for **measured** baselines and **static** audit findings gathered during the November 2026 performance pass. This document does not replace the code audit roadmap; it groups numbers, methodology, and gaps.

**Canonical live baseline (v2 collector):** [`hq-baseline-latest.json`](hq-baseline-latest.json) — see **§4 Phase 2**  
**Prior v1 baseline (archived):** [`hq-baseline-archived-2026-11-18T011608Z.json`](hq-baseline-archived-2026-11-18T011608Z.json)  
**Atelier mesh benchmarks:** [`atelier-mesh-benchmark-latest.json`](atelier-mesh-benchmark-latest.json)  
**Collectors:** [`scripts/profile_hq_performance_baseline.py`](../../scripts/profile_hq_performance_baseline.py), [`scripts/benchmark_atelier_models.py`](../../scripts/benchmark_atelier_models.py) (shim: `collect_atelier_mesh_report.py`)  
**FPS stats tests:** [`tests/test_hq_perf_fps_stats.py`](../../tests/test_hq_perf_fps_stats.py)  
**Repository:** `a3a8301` unless noted.

---

## 1. How to reproduce

```bash
python -m playwright install chromium
python scripts/profile_hq_performance_baseline.py --repeats 3
python scripts/profile_hq_performance_baseline.py --skip-atelier --headed
python scripts/collect_atelier_mesh_report.py
python -m unittest tests.test_hq_perf_fps_stats -v
```

- Admin PIN is read from `bridge_config.json` only (never printed or logged).
- Playwright uses a **fresh browser context** per scenario batch (no cookie files on disk).
- Optional CI-style motion gate (isolated test server, not live bridge):

  ```bash
  python tests/visual_hq_motion_fps_playwright.py
  python scripts/verify_animation_pipeline.py
  ```

---

## 2. Measurement methodology

| Instrument | What it captures |
|------------|------------------|
| **4 s rAF sample** | Interval FPS, median/p95/p99/max gap, gap counts >16.7/33.3/50 ms, long tasks **during sample only** |
| **30 s idle tail** | Idle long tasks, delta of `/api/*` resource entries (after the 4 s window) |
| **`performance.memory`** | Chromium `usedJSHeapSize` / `totalJSHeapSize` (when available) |
| **`HqMotion.getState()`** | Tier (`lite` / `full` / `parked`), auto-lite reason, EMAs |
| **DOM** | `companionMinimal` (`is-minimal`), `companionExpanded` (`is-expanded`) |
| **Atelier** | `setView('atelier3d')` wall time; model open or synthetic STL path |

**Accueil companion states**

| Scenario | `localStorage` / effect |
|----------|-------------------------|
| **Minimal (collapsed orb)** | `hq_companion_on=1`, `hq_companion_collapsed=1`, NSFW/layered keys removed |
| **Portrait (expanded storage)** | `collapsed=0`, `hq_companion_nsfw=1`, `hq_companion_layered_portrait=1`, `persona=warm` |

**Atelier model path**

- Primary: first STL/GLB from `GET /api/print3d/models` → UI `openModel()`.
- **Fallback (current machine):** 12-triangle binary STL → `HQModel.parse` + `HQModel.viewer` on Atelier view (same code as model sheet; library index returned **0** models).

### 2.1 Phase 2 — FPS collector verification (v2 schema)

**Root cause of the old ~12.5 FPS Accueil numbers:** v1 computed  
`fps = rafCallbacks × 1000 / wallElapsed`, where `wallElapsed` included the **full idle tail** (4 s sample + 15–30 s `setTimeout`) after rAF sampling stopped. Gap statistics used only the 4 s rAF window — so **~60 Hz gaps and ~12 FPS were both “correct” for different denominators**.

**Fix (profiling only):** [`scripts/hq_perf_fps_stats.py`](../../scripts/hq_perf_fps_stats.py) + updated [`SAMPLE_JS`](../../scripts/profile_hq_performance_baseline.py) (schema `transfert-hq-perf-baseline/v2`).

| Field | Meaning |
|-------|---------|
| `fps` | **Primary metric:** \((N-1) \times 1000 / (t_{last}-t_{first})\) over the rAF sample window |
| `fpsFromSampleElapsed` | \(N \times 1000 / sampleElapsedMs\) |
| `fpsLegacyIncludingIdle` | Reproduces v1 bug for regression comparison |
| `sampleElapsedMs` / `wallElapsedMs` | Sample vs sample+idle wall time |
| `longTasks` / `longTasksIdle` | Long tasks during sample vs idle tail |

Deterministic unit proof: `tests/test_hq_perf_fps_stats.py` (237 frames @ 16.7 ms + 15 s idle → `fps≈60`, `fpsLegacyIncludingIdle≈12.5`).

---

## 3. Environment (all Playwright baselines)

| Field | Value |
|-------|--------|
| Bridge | `http://127.0.0.1:8765` |
| Browser | Chromium 134 (Playwright build), **headless** |
| Viewport | 1280 × 900, `deviceScaleFactor` 1 |
| OS | Windows 10.0.26200 |
| Python | 3.10.9 |

**Important:** Headless Chromium often limits rAF rate and differs from headed desktop Chrome and from **physical iPhone Safari**. Compare numbers only across runs with the same script and browser mode.

---

## 4. Phase 2 canonical baselines

### 4.1 Accueil v2 (2026-11-18T013914Z)

**File:** `hq-baseline-2026-11-18T013914Z.json` (= `hq-baseline-latest.json` after Phase 2)  
**Command:** `python scripts/profile_hq_performance_baseline.py --repeats 3 --skip-atelier`  
**Mode:** headless Chromium, 4 s sample, **30 s idle**, 3 repeats per scenario.

| Scenario | FPS (v2 interval) per run | Median | p95 gap (ms) | Sample long tasks | Idle long tasks (30 s) | `HqMotion.tier` |
|----------|---------------------------|--------|--------------|-------------------|----------------------|-----------------|
| Collapsed minimal | 50.3, 50.5, **31.1** | **50.3** | 16.8–66.7 | 0–2 | 0–7 | lite (auto) |
| Expanded portrait | **17**, 50.3, 59.5 | **50.3** | 16.8–149.9 | varies | 0–17 | lite (auto) |
| Expanded + `hq_motion_mode=full` storage | 42, 57.5, **60** | **57.5** | 16.7–50 | low | 0–1 | **still `lite`** (auto coordinator overrides) |

**Interpretation:** Accueil effectively tracks **~50–60 FPS** in healthy 4 s windows (not ~12 FPS). Outlier repeats (17–31 FPS) correlate with **wider p95 gaps**, **sample long tasks** (up to ~445 ms total in one collapsed run), and **heavy idle long-task counts** on expanded portrait — headless jitter and live2d/home work, not a broken rAF counter.

**v1 comparison (same machine, archived):** 237 rAF ticks in 4 s with reported **12.5 FPS** ⇒ `fpsLegacyIncludingIdle` on v2 replay ≈ **5.9–6.0** for 30 s idle (ratio matches v1 math).

### 4.2 Atelier synthetic path (v1 file, unchanged)

See `hq-baseline-archived-2026-11-18T011608Z.json` — 12-triangle STL, rotation ~60 FPS; library still empty on bridge.

### 4.3 Atelier real geometry (synthetic fixtures, production `HQModel`)

**Fixtures:** `docs/performance-baselines/fixtures/bench-{small_10k,medium_100k,large_300k}.stl`  
(labeled **synthetic sphere tessellation**; no untrusted downloads.)

**File:** `atelier-mesh-benchmark-2026-11-18T025838Z.json`  
**Command:** `python scripts/collect_atelier_mesh_report.py`  
**Path:** Playwright route → `fetch` → `HQModel.parse` + `HQModel.viewer` on **atelier3d** (same code as production).

| Tier | Triangles | File size | `parseMs` | `viewerInitMs` | `firstFrameMs` | Long tasks (open) | Rotation FPS (2 s) |
|------|-----------|-----------|-----------|------------------|----------------|-------------------|---------------------|
| small_10k | 10 000 | 500 084 B | 6 | 18 | 66 | 1 | 59.5 |
| medium_100k | 100 000 | 5 000 084 B | 63 | 40 | 113 | 3 | 59.5 |
| large_300k | 300 000 | 15 000 084 B | 116 | 54 | 166 | 3 | 60 |

**10× open/dispose (medium, 100k):** `heapBefore` = `heapAfter` = **15.2 MB**; per-cycle `heapAfterDispose` flat — **no JS heap leak demonstrated** (Chromium cache not isolated; GC not forced except 150 ms pauses).

**Largest stalls:** **`HQModel.parse` + buffer upload** scale with triangle count (116 + 54 ms ≈ 170 ms main-thread work at 300k); rotation stays ~60 FPS once mounted. **`openModel()` UI path** (network + overlay) still not indexed on this bridge.

---

## 5. Run-to-run variance (same commit, same bridge)

Four captures on 2026-11-18 show headless jitter (especially first load and companion state detection before script fixes).

| Run (UTC) | Accueil minimal FPS | Accueil portrait FPS | Atelier `navMs` | Notes |
|-----------|---------------------|----------------------|-----------------|-------|
| `010842Z` | 11.6 | 9.0 | 5987 | Atelier viewer **not** run; companion flag bug (`companionCollapsed` false) |
| `011210Z` | 7.6 | 12.4 | 1315 | Minimal: 9 long tasks, 24 idle API; synthetic rot 59.7 FPS |
| `011608Z` | **12.5** | **12.4** | **864** | **Canonical** — stable minimal/portrait, synthetic viewer |
| `011608Z` | (latest) | | | Same as canonical row |

Use **`011608Z`** for before/after patches; earlier runs are kept for variance awareness only.

---

## 6. CI / unit gates (not re-run against live bridge here)

### 6.1 `scripts/verify_animation_pipeline.py` — **PASS** (session 2026-11-18)

47 tests including motion coordinator, idle perf, dangle perf15, kinetic score; syntax checks on companion/home/dangle JS.

### 6.2 Documented Playwright budgets (`docs/agent-animation-pipeline.md`)

Targets for **isolated test server** (`visual_hq_motion_fps_playwright.py`), 3 s samples:

| Mode | FPS | p95 gap | Long tasks | Animations | API (4 s) |
|------|-----|---------|------------|------------|-----------|
| Accueil **Full** (`smooth`) | ≥ 24 | ≤ 55 ms | ≤ 2 | ≤ 45 | — |
| Accueil **Lite** | ≥ 40 | ≤ 40 ms | ≤ 2 | ≤ 16 | ≤ 4 |
| Calendrier nav | — | — | — | — | commit ≤ 600 ms |
| Carnet cold | — | — | — | ≤ 45 scripts | ready ≤ 5 s |

**v1 baselines** reported ~12–12.5 FPS — a **collector bug** (§2.1). **v2** headless live Accueil medians **~50 FPS** (Lite CI target ≥40) with outlier runs down to ~17 FPS. Still run `visual_hq_motion_fps_playwright.py` for apples-to-apples CI.

`visual_hq_motion_fps_playwright.py` failed once in this environment until `playwright install chromium` was run; it was **not** executed successfully against live HQ in this pass.

---

## 7. Profiling coverage (MCP / tools)

| Tool | Status this pass |
|------|------------------|
| Serena | OK — code navigation on `C:\Transfert` |
| Context7 | OK |
| Chrome DevTools MCP | Connected; **no authenticated HQ performance trace** |
| Playwright MCP / script | OK after Chromium install; baselines in JSON |
| Live `GET /api/diag/agent-brief` | **Not collected** (auth via config only in approved script paths) |

---

## 8. Static audit highlights (code — not re-profiled numerically)

These explain *where* cost likely lives; pair with §4–6 for validation.

| ID | Severity | Area | Evidence |
|----|----------|------|----------|
| S1 | High | Main-thread **STL/GLB parse** | `assets/hq-model-view.js` (`parseSTL` / `parseGLB`); `hq-print3d.js` `modelDetail` calls `HQModel.parse` after fetch (up to 60 MiB) |
| S2 | High | **Accueil motion stack** | `hq-companion.js` `startLive2DLoop`, `hq-home-fx.js`, `hq-dangling-member.js`, `hq-motion-coordinator.js` |
| S3 | Medium | **WebGL model viewer** | `preserveDrawingBuffer: true`, DPR cap 2 (`hq-model-view.js` ~324–347); draw is event-driven (no idle rAF loop) |
| S4 | Medium | **Global chip polling** | `hq-inventoria-chip.js` (5 min), `hq-musica-moments.js` (5 min), `hq-musica-chip.js` (~52 s ambient) — loaded on admin shell |
| S5 | Medium | **Carnet cold path** | ~41 lazy scripts, 5 s poll while on view (`hq-carnet.js`); poll stops when `view !== carnet` |
| S6 | Low–Med | **Atelier polling** | Printers tab: 4 s/10 s `setTimeout` poll + optional SSE; **stops on hide/hidden** (`hq-print3d.js`) |
| S7 | Medium | **G-code preview** | `hq-gcode-view.js` — worker parse, Three.js renderer; `dispose()` on close |

**Rust/WASM:** G-code already uses a worker; STL remains the best WASM candidate only if Worker + typed arrays are insufficient.

---

## 9. Optimization hypotheses (Phase 2 evidence)

| Proposal | Verdict | Evidence | Expected mechanism | Difficulty / risk | Priority |
|----------|---------|----------|--------------------|-------------------|----------|
| **A. Worker `HQModel.parse`** | **Confirmed for large meshes, modest at 300k STL** | 300k: **116 ms parse**, **3 long tasks**; rotation 60 FPS after mount | Keeps UI responsive during parse/upload; total CPU similar | Medium; worker + transfer, GLB JSON path | **P1** for UI jank on big models |
| **B. Accueil idle / Live2D policy** | **Mostly sufficient today** | Collapsed median **~50 FPS**, `tier: lite`, idle API **0**; outliers from long tasks / expanded portrait | Further cuts only on outlier runs | Low–medium; UX regression if over-aggressive | **P3** unless headed traces show sustained Full tier |
| **C. `preserveDrawingBuffer` / DPR** | **Unverified numerically** | Production always `preserveDrawingBuffer: true` (`hq-model-view.js` ~324); DPR cap 2 in `size()` — no A/B without prod toggle | Fewer composite copies / lower fill rate | Low code change; screenshot/export paths | **P2** measure with headed toggle first |

**Rust/WASM:** Not justified — STL parse at 300k is **<200 ms** total mount; worker is enough.

---

## 10. Recommended first implementation (post-measurement)

1. **Worker offload for `HQModel.parse`** (Atelier open / model sheet) — measured long tasks on 100k–300k opens.  
2. **Toggle `preserveDrawingBuffer`** only when exporting pixels — needs a small prod change + one headed A/B.  
3. **Accueil:** keep **auto/lite**; tune only if headed Chrome DevTools traces show sustained Full tier cost (not indicated in v2 medians).

---

## 11. Prioritized next measurements

1. Index a real library STL → baseline `openModel()` UI path vs fixture route path.  
2. `visual_hq_motion_fps_playwright.py` + archive beside JSON.  
3. Headed Chrome DevTools Performance: Accueil expanded outlier reproduction (17 FPS run).  
4. GPU: **not measured** — no tool exposed GPU utilization in this pass.

---

## 12. Artifact index

| Path | Description |
|------|-------------|
| `hq-baseline-latest.json` | Latest Accueil v2 capture (`013914Z`) |
| `hq-baseline-2026-11-18T013914Z.json` | Phase 2 Accueil 3× repeats |
| `hq-baseline-archived-2026-11-18T011608Z.json` | v1 canonical preserved on first v2 run |
| `atelier-mesh-benchmark-latest.json` | 10k / 100k / 300k STL benchmarks |
| `fixtures/bench-*.stl` | Deterministic mesh fixtures |
| `hq-baseline-2026-11-18T011608Z.json` | v1 canonical (historical) |
| `hq-baseline-2026-11-18T011210Z.json` | Earlier run (synthetic viewer + jitter) |
| `hq-baseline-2026-11-18T010842Z.json` | First run (Atelier viewer incomplete) |
| [`README.md`](README.md) | Short usage |
| [`../../scripts/profile_hq_performance_baseline.py`](../../scripts/profile_hq_performance_baseline.py) | Collector |
| [`../agent-animation-pipeline.md`](../agent-animation-pipeline.md) | Motion CI budgets |

---

---

## 13. Implemented clean-up (post Phase 2)

| Area | Change |
|------|--------|
| **FPS** | Shared `hq_perf_fps_stats.py`; `visual_hq_motion_fps_playwright.py` aligned; v2 baselines |
| **Mesh bench** | Single entry `benchmark_atelier_models.py` (route fulfill, `parseAsync`) |
| **Atelier parse** | `hq-model-parse.worker.js` + `parseAsync` ≥200 KB; Print3D preview/studio use `parseAsync` |
| **WebGL** | `preserveDrawingBuffer: false`; PNG capture via `readPixels` / offscreen canvas |

*Last updated: Phase 2 + implementation — 2026-11-18.*