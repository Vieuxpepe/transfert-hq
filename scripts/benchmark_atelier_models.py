#!/usr/bin/env python3
"""Benchmark HQModel.parse + viewer on deterministic synthetic STL sizes.

Uses production atelier3d scripts (HQModel) in-browser via Playwright.
Writes docs/performance-baselines/atelier-mesh-benchmark-latest.json

  python scripts/benchmark_atelier_models.py
  python scripts/benchmark_atelier_models.py --cycles 10 --headed
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from hq_perf_fps_stats import SAMPLE_STATS_JS_FUNCTION  # noqa: E402

FIXTURE_DIR = ROOT / "docs" / "performance-baselines" / "fixtures"


def load_pin() -> str:
    cfg_path = ROOT / "bridge_config.json"
    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    pin = str(data.get("pin") or "").strip()
    if not pin:
        raise SystemExit("benchmark_atelier_models: missing pin in bridge_config.json")
    return pin


def write_binary_stl(path: Path, triangles: int, *, seed: int = 0) -> dict:
    """Deterministic-ish sphere-like mesh: triangles ~= requested count."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rings = max(8, int(math.sqrt(triangles / 2)))
    segs = max(8, triangles // max(1, rings * 2))
    verts: list[tuple[float, float, float]] = []
    for r in range(rings + 1):
        v = r / rings
        theta = v * math.pi
        for s in range(segs):
            phi = (s / segs) * 2 * math.pi
            x = math.sin(theta) * math.cos(phi)
            y = math.sin(theta) * math.sin(phi)
            z = math.cos(theta)
            verts.append((x, y, z))
    tris: list[tuple[tuple[float, float, float], ...]] = []
    for r in range(rings):
        for s in range(segs):
            i0 = r * segs + s
            i1 = r * segs + ((s + 1) % segs)
            i2 = (r + 1) * segs + s
            i3 = (r + 1) * segs + ((s + 1) % segs)
            a, b, c, d = verts[i0], verts[i1], verts[i2], verts[i3]
            tris.append((a, b, c))
            tris.append((b, d, c))
    if len(tris) > triangles:
        tris = tris[:triangles]
    while len(tris) < triangles:
        tris.append(tris[len(tris) % max(1, len(tris) - 1)])
    with path.open("wb") as fh:
        fh.write(b"\0" * 80)
        fh.write(struct.pack("<I", len(tris)))
        for tri in tris:
            # flat facet normal placeholder
            fh.write(struct.pack("<3f", 0.0, 0.0, 1.0))
            for p in tri:
                fh.write(struct.pack("<3f", float(p[0]), float(p[1]), float(p[2])))
            fh.write(struct.pack("<H", 0))
    size = path.stat().st_size
    return {"path": str(path.relative_to(ROOT)), "triangles": len(tris), "bytes": size, "seed": seed}


MESH_TARGETS = [
    ("small_10k", 10_000),
    ("medium_100k", 100_000),
    ("large_300k", 300_000),
]


BENCH_JS = (
    "async ({ url, name, sampleMs }) => {\n"
    + SAMPLE_STATS_JS_FUNCTION
    + """
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) return { ok: false, reason: 'fetch-failed', status: res.status };
  const buf = await res.arrayBuffer();
  let longTasks = 0;
  let longTaskMs = 0;
  let obs = null;
  if (typeof PerformanceObserver !== 'undefined') {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { longTasks += 1; longTaskMs += e.duration; }
    });
    try { obs.observe({ entryTypes: ['longtask'] }); } catch (_) {}
  }
  const tParse0 = performance.now();
  const parsed = await window.HQModel.parseAsync(name, buf);
  const parseMs = performance.now() - tParse0;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:12% 10%;z-index:9999;background:#111';
  const canvas = document.createElement('canvas');
  canvas.className = 'p3d-canvas';
  canvas.style.width = '100%'; canvas.style.height = '100%';
  wrap.appendChild(canvas);
  document.body.appendChild(wrap);
  const tViewer0 = performance.now();
  const viewer = window.HQModel.viewer(canvas);
  viewer.setModel(parsed);
  const viewerInitMs = performance.now() - tViewer0;
  const tFirst0 = performance.now();
  let firstFrameMs = null;
  await new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        firstFrameMs = performance.now() - tFirst0;
        resolve();
      });
    });
  });
  const frames = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    function tick(now) {
      frames.push(now);
      if (performance.now() - t0 < sampleMs) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });
  const sampleElapsedMs = performance.now() - t0;
  const stats = hqPerfStatsFromFrames(frames, sampleElapsedMs, sampleElapsedMs);
  if (obs) obs.disconnect();
  const heapPeak = performance.memory ? performance.memory.usedJSHeapSize : null;
  try { viewer.dispose && viewer.dispose(); } catch (_) {}
  try { wrap.remove(); } catch (_) {}
  const heapAfterDispose = performance.memory ? performance.memory.usedJSHeapSize : null;
  return {
    ok: true,
    parseMs: Math.round(parseMs),
    viewerInitMs: Math.round(viewerInitMs),
    firstFrameMs: Math.round(firstFrameMs || 0),
    longTasksDuringOpen: longTasks,
    longTaskMsDuringOpen: Math.round(longTaskMs),
    trianglesReported: parsed.triangles,
    rotation: stats,
    heapPeak,
    heapAfterDispose,
  };
}"""
)


def main() -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise SystemExit("pip install playwright && playwright install chromium")

    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8765")
    ap.add_argument("--sample-ms", type=int, default=3000)
    ap.add_argument("--cycles", type=int, default=10, help="Open/dispose cycles for medium mesh")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    pin = load_pin()

    meshes = []
    for label, tri_target in MESH_TARGETS:
        p = FIXTURE_DIR / f"bench-{label}.stl"
        meshes.append({"label": label, "targetTriangles": tri_target, **write_binary_stl(p, tri_target)})

    report = {
        "schema": "transfert-hq-atelier-mesh-benchmark/v1",
        "capturedAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ"),
        "baseUrl": base,
        "meshes": meshes,
        "results": {},
        "memoryStability": {},
    }

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed)
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        status = ctx.request.post(
            f"{base}/login", form={"pin": pin}, headers={"origin": base}, max_redirects=0
        ).status
        if status not in (302, 303):
            raise SystemExit(f"login failed HTTP {status}")
        page = ctx.new_page()
        page.goto(f"{base}/", wait_until="domcontentloaded", timeout=60000)

        def bench_route(stl_path: Path):
            def handler(route, _request):
                route.fulfill(path=str(stl_path), content_type="application/octet-stream")

            return handler

        page.evaluate(
            """async () => {
          await Promise.resolve(window.setView('atelier3d'));
          while ((document.body.dataset.view || '') !== 'atelier3d') {
            await new Promise((r) => setTimeout(r, 25));
          }
          const deadline = performance.now() + 30000;
          while (performance.now() < deadline) {
            if (window.HQModel) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          return !!window.HQModel;
        }"""
        )

        for mesh in meshes:
            print(f"benchmark_atelier_models: mesh {mesh['label']} ...", flush=True)
            stl_path = ROOT / mesh["path"]
            url = f"{base}/hq-perf-bench/{mesh['label']}.stl"
            page.route(url, bench_route(stl_path))
            name = stl_path.name
            res = page.evaluate(
                BENCH_JS,
                {"url": url, "name": name, "sampleMs": args.sample_ms},
            )
            page.unroute(url)
            report["results"][mesh["label"]] = res

        medium = FIXTURE_DIR / "bench-medium_100k.stl"
        medium_url = f"{base}/hq-perf-bench/medium-cycle.stl"
        page.route(medium_url, bench_route(medium))
        cycles = []
        heap0 = page.evaluate("() => (performance.memory && performance.memory.usedJSHeapSize) || null")
        for c in range(args.cycles):
            print(f"benchmark_atelier_models: stability cycle {c + 1}/{args.cycles}", flush=True)
            page.evaluate("() => { try { window.gc && window.gc(); } catch (_) {} }")
            page.wait_for_timeout(200)
            r = page.evaluate(
                BENCH_JS,
                {"url": medium_url, "name": medium.name, "sampleMs": 500},
            )
            cycles.append({"cycle": c + 1, "parseMs": r["parseMs"], "heapAfterDispose": r["heapAfterDispose"]})
        heapN = page.evaluate("() => (performance.memory && performance.memory.usedJSHeapSize) || null")
        report["memoryStability"] = {
            "mesh": "medium_100k",
            "cycles": args.cycles,
            "heapBefore": heap0,
            "heapAfter": heapN,
            "perCycle": cycles,
        }

        ctx.close()
        browser.close()

    out_dir = ROOT / "docs" / "performance-baselines"
    stamp = report["capturedAtUtc"]
    out_path = out_dir / f"atelier-mesh-benchmark-{stamp}.json"
    latest = out_dir / "atelier-mesh-benchmark-latest.json"
    if latest.is_file():
        prev = json.loads(latest.read_text(encoding="utf-8"))
        arch = out_dir / f"atelier-mesh-benchmark-archived-{prev.get('capturedAtUtc', 'unknown')}.json"
        if not arch.is_file():
            arch.write_text(latest.read_text(encoding="utf-8"), encoding="utf-8")
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    latest.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"benchmark_atelier_models: wrote {out_path.relative_to(ROOT)}")
    for label, res in report["results"].items():
        print(
            f"  {label}: parseMs={res.get('parseMs')} viewerInitMs={res.get('viewerInitMs')} "
            f"rotFps={((res.get('rotation') or {}).get('fps'))} tris={res.get('trianglesReported')}"
        )


if __name__ == "__main__":
    main()