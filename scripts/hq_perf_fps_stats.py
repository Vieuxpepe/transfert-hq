"""Deterministic FPS / frame-gap statistics for HQ profiling scripts.

Used by unittest and by profile_hq_performance_baseline.py (Python-side checks).
"""

from __future__ import annotations

import math
from typing import Iterable, Sequence


def percentile_sorted(sorted_values: Sequence[float], p: float) -> float:
    """Nearest-rank percentile on a pre-sorted sequence (p in 0..1)."""
    if not sorted_values:
        return 0.0
    if p <= 0:
        return float(sorted_values[0])
    if p >= 1:
        return float(sorted_values[-1])
    idx = min(len(sorted_values) - 1, max(0, int(math.floor(len(sorted_values) * p))))
    return float(sorted_values[idx])


def gaps_from_timestamps(timestamps_ms: Sequence[float]) -> list[float]:
    return [timestamps_ms[i] - timestamps_ms[i - 1] for i in range(1, len(timestamps_ms))]


def count_gaps_over(gaps: Iterable[float], threshold_ms: float) -> int:
    return sum(1 for g in gaps if g > threshold_ms)


def compute_frame_metrics(
    timestamps_ms: Sequence[float],
    *,
    sample_elapsed_ms: float,
    wall_elapsed_ms: float | None = None,
) -> dict:
    """Compute FPS and gap distribution from rAF timestamps (performance.now())."""
    n = len(timestamps_ms)
    gaps = gaps_from_timestamps(timestamps_ms)
    gaps_sorted = sorted(gaps)
    span_ms = (timestamps_ms[-1] - timestamps_ms[0]) if n >= 2 else 0.0
    wall = wall_elapsed_ms if wall_elapsed_ms is not None else sample_elapsed_ms

    fps_interval = round((n - 1) * 1000.0 / span_ms, 1) if span_ms > 0 else 0.0
    fps_sample_elapsed = round(n * 1000.0 / sample_elapsed_ms, 1) if sample_elapsed_ms > 0 else 0.0
    # Legacy (incorrect when idle tail included in denominator):
    fps_legacy_wall = round(n * 1000.0 / wall, 1) if wall > 0 else 0.0

    return {
        "rafCallbacks": n,
        "sampleElapsedMs": round(sample_elapsed_ms, 2),
        "wallElapsedMs": round(wall, 2),
        "sampleSpanMs": round(span_ms, 2),
        "fps": fps_interval,
        "fpsFromSampleElapsed": fps_sample_elapsed,
        "fpsLegacyIncludingIdle": fps_legacy_wall,
        "medianGapMs": round(percentile_sorted(gaps_sorted, 0.5), 2) if gaps_sorted else 0.0,
        "p95GapMs": round(percentile_sorted(gaps_sorted, 0.95), 2) if gaps_sorted else 0.0,
        "p99GapMs": round(percentile_sorted(gaps_sorted, 0.99), 2) if gaps_sorted else 0.0,
        "maxGapMs": round(gaps_sorted[-1], 2) if gaps_sorted else 0.0,
        "gapsOver16_7ms": count_gaps_over(gaps, 16.7),
        "gapsOver33_3ms": count_gaps_over(gaps, 33.3),
        "gapsOver50ms": count_gaps_over(gaps, 50.0),
        "gapCount": len(gaps),
    }


# Shared in-page stats helper (injected into Playwright evaluate strings).
SAMPLE_STATS_JS_FUNCTION = """
function hqPerfStatsFromFrames(frames, sampleElapsedMs, wallElapsedMs) {
  const gaps = [];
  for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i] - frames[i - 1]);
  gaps.sort((a, b) => a - b);
  const n = frames.length;
  const span = n >= 2 ? frames[n - 1] - frames[0] : 0;
  const pct = (p) => {
    if (!gaps.length) return 0;
    const idx = Math.min(gaps.length - 1, Math.max(0, Math.floor(gaps.length * p)));
    return gaps[idx];
  };
  const over = (t) => gaps.filter((g) => g > t).length;
  const sampleElapsed = sampleElapsedMs;
  const wall = wallElapsedMs != null ? wallElapsedMs : sampleElapsed;
  return {
    rafCallbacks: n,
    sampleElapsedMs: Number(sampleElapsed.toFixed(2)),
    wallElapsedMs: Number(wall.toFixed(2)),
    sampleSpanMs: Number(span.toFixed(2)),
    fps: span > 0 ? Number(((n - 1) * 1000 / span).toFixed(1)) : 0,
    fpsFromSampleElapsed: sampleElapsed > 0 ? Number((n * 1000 / sampleElapsed).toFixed(1)) : 0,
    fpsLegacyIncludingIdle: wall > 0 ? Number((n * 1000 / wall).toFixed(1)) : 0,
    medianGapMs: Number(pct(0.5).toFixed(2)),
    p95GapMs: Number(pct(0.95).toFixed(2)),
    p99GapMs: Number(pct(0.99).toFixed(2)),
    maxGapMs: Number((gaps[gaps.length - 1] || 0).toFixed(2)),
    gapsOver16_7ms: over(16.7),
    gapsOver33_3ms: over(33.3),
    gapsOver50ms: over(50),
    gapCount: gaps.length,
  };
}
"""