# HQ performance baselines

Reproducible browser metrics before performance patches.

## Run

```bash
python -m playwright install chromium   # once per machine
python scripts/profile_hq_performance_baseline.py
python scripts/profile_hq_performance_baseline.py --base http://127.0.0.1:8765
```

PIN is read from `bridge_config.json` on disk only (never printed). Playwright uses an isolated context — no cookie files are written.

## Outputs

| File | Purpose |
|------|---------|
| `hq-baseline-latest.json` | Most recent run (overwritten) |
| `hq-baseline-<UTC timestamp>.json` | Archived snapshot |

Schema: `transfert-hq-perf-baseline/v2` — interval FPS (`fps`), gap distribution, split long tasks (sample vs idle), 30 s idle `/api/` delta, optional Atelier path.

Mesh benchmarks: `python scripts/benchmark_atelier_models.py` → `atelier-mesh-benchmark-latest.json`

**Consolidated report (measurements + audit summary):** [HQ_PERFORMANCE_MEASUREMENTS.md](HQ_PERFORMANCE_MEASUREMENTS.md)

## Interpretation

- Use **headless Chromium** consistently; FPS is not comparable to headed or real iPhone Safari.
- `companionMinimal` / `companionExpanded` reflect DOM classes on `.hq-companion` (`is-minimal`, `is-expanded`).
- Re-run after indexing real STL/GLB files to measure full `openModel()` fetch + parse.
