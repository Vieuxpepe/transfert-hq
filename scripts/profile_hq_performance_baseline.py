#!/usr/bin/env python3
"""Collect reproducible HQ performance baselines (Accueil + Atelier 3D).

Reads admin PIN from bridge_config.json locally — never prints secrets.
Writes JSON under docs/performance-baselines/.

  python scripts/profile_hq_performance_baseline.py
  python scripts/profile_hq_performance_baseline.py --base http://127.0.0.1:8765
"""

from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from hq_perf_fps_stats import SAMPLE_STATS_JS_FUNCTION  # noqa: E402


def load_pin() -> str:
    cfg_path = ROOT / "bridge_config.json"
    if not cfg_path.is_file():
        raise SystemExit("profile_hq_performance_baseline: bridge_config.json missing")
    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    pin = str(data.get("pin") or "").strip()
    if not pin:
        raise SystemExit("profile_hq_performance_baseline: no pin in bridge_config.json")
    return pin


SAMPLE_JS = (
    "async ({ sampleMs, label, idleMs }) => {\n"
    + SAMPLE_STATS_JS_FUNCTION
    + """
  const heap = (performance.memory)
    ? {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
      }
    : null;
  const t0 = performance.now();
  const apiAtStart = performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/")).length;
  const frames = [];
  let longTasksSample = 0;
  let longTaskMsSample = 0;
  let obsSample = null;
  if (typeof PerformanceObserver !== "undefined") {
    obsSample = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasksSample += 1;
        longTaskMsSample += entry.duration;
      }
    });
    try { obsSample.observe({ entryTypes: ["longtask"] }); } catch (_) {}
  }
  await new Promise((resolve) => {
    function tick(now) {
      frames.push(now);
      if (performance.now() - t0 < sampleMs) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });
  const sampleElapsedMs = performance.now() - t0;
  if (obsSample) obsSample.disconnect();

  let idleApi = 0;
  let longTasksIdle = 0;
  let longTaskMsIdle = 0;
  let obsIdle = null;
  if (idleMs > 0) {
    const idleApi0 = performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/")).length;
    if (typeof PerformanceObserver !== "undefined") {
      obsIdle = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasksIdle += 1;
          longTaskMsIdle += entry.duration;
        }
      });
      try { obsIdle.observe({ entryTypes: ["longtask"] }); } catch (_) {}
    }
    await new Promise((r) => setTimeout(r, idleMs));
    idleApi = performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/")).length - idleApi0;
    if (obsIdle) obsIdle.disconnect();
  }
  const wallElapsedMs = performance.now() - t0;
  const frameStatsFinal = hqPerfStatsFromFrames(frames, sampleElapsedMs, wallElapsedMs);
  const motion = window.HqMotion ? window.HqMotion.getState() : null;
  const companion = document.querySelector(".hq-companion");
  const companionMinimal = !!(companion && companion.classList.contains("is-minimal"));
  const companionExpanded = !!(companion && companion.classList.contains("is-expanded"));
  const running = document.getAnimations().filter((a) => a.playState === "running");
  const heapAfter = (performance.memory)
    ? {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
      }
    : null;
  return {
    label,
    sampleMs,
    idleMs,
    frames: frames.length,
    ...frameStatsFinal,
    longTasks: longTasksSample,
    longTaskMs: Math.round(longTaskMsSample),
    longTasksIdle,
    longTaskMsIdle: Math.round(longTaskMsIdle),
    runningAnimations: running.length,
    motion,
    companionMinimal,
    companionExpanded,
    heapAtStart: heap,
    heapAfterSample: heapAfter,
    idleApiRequests: idleApi,
    view: (document.body && document.body.dataset.view) || "",
    hidden: !!document.hidden,
  };
}"""
)


def archive_previous_latest(out_dir: Path) -> None:
    latest = out_dir / "hq-baseline-latest.json"
    if not latest.is_file():
        return
    try:
        prev = json.loads(latest.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return
    stamp = prev.get("capturedAtUtc") or "unknown"
    dest = out_dir / f"hq-baseline-archived-{stamp}.json"
    if not dest.is_file():
        dest.write_text(latest.read_text(encoding="utf-8"), encoding="utf-8")


def print_summary(report: dict, root: Path, out_path: Path) -> None:
    print(f"profile_hq_performance_baseline: wrote {out_path.relative_to(root)}")
    for key, val in report["scenarios"].items():
        if isinstance(val, dict) and "repeats" in val:
            fps_vals = [r.get("fps") for r in val["repeats"] if isinstance(r, dict)]
            print(f"  {key}: fps median~={sorted(fps_vals)[len(fps_vals)//2] if fps_vals else '?'} runs={len(fps_vals)}")
        elif isinstance(val, dict) and "fps" in val:
            print(
                f"  {key}: fps={val.get('fps')} legacy={val.get('fpsLegacyIncludingIdle')} "
                f"p95GapMs={val.get('p95GapMs')} longTasks={val.get('longTasks')}"
            )
        elif key == "atelier3d_model":
            op = (val.get("open") or {})
            rot = val.get("rotationSample") or {}
            print(
                f"  atelier3d: navMs={(val.get('navigation') or {}).get('navMs')} "
                f"openMs={op.get('openMs')} rotFps={rot.get('fps')} rotP95={rot.get('p95GapMs')}"
            )


def git_short() -> str:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=ROOT,
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return out or "unknown"
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return "unknown"


def main() -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise SystemExit("Install playwright: pip install playwright && playwright install chromium")

    ap = argparse.ArgumentParser(description="HQ performance baseline collector")
    ap.add_argument("--base", default="http://127.0.0.1:8765", help="Bridge base URL")
    ap.add_argument("--sample-ms", type=int, default=4000, help="Motion sample duration")
    ap.add_argument("--idle-ms", type=int, default=30000, help="Idle tail per scenario")
    ap.add_argument("--rotations", type=int, default=10, help="Atelier drag steps")
    ap.add_argument("--repeats", type=int, default=1, help="Repeat each Accueil capture N times")
    ap.add_argument("--headed", action="store_true", help="Launch Chromium with UI (less rAF throttling)")
    ap.add_argument("--skip-atelier", action="store_true", help="Accueil-only capture")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    pin = load_pin()

    out_dir = ROOT / "docs" / "performance-baselines"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
    out_path = out_dir / f"hq-baseline-{stamp}.json"

    report: dict = {
        "schema": "transfert-hq-perf-baseline/v2",
        "capturedAtUtc": stamp,
        "gitRev": git_short(),
        "baseUrl": base,
        "environment": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "playwright": "chromium",
            "headless": not args.headed,
            "viewport": {"width": 1280, "height": 900},
            "sampleMs": args.sample_ms,
            "idleMs": args.idle_ms,
            "repeats": args.repeats,
            "note": "fps uses rAF sample window only (v2); fpsLegacyIncludingIdle reproduces v1 bug.",
        },
        "scenarios": {},
        "notes": [],
    }

    ai_route = lambda route: (
        route.fulfill(
            json={
                "ok": True,
                "configured": True,
                "companion_cap": "flirt",
                "nsfw_allowed": True,
                "session_admin": True,
                "messages": [],
            }
        )
        if route.request.method == "GET" and "/api/ai" in route.request.url
        else route.continue_()
    )

    def login_ctx(browser):
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 900},
            device_scale_factor=1,
            bypass_csp=True,
        )
        status = ctx.request.post(
            f"{base}/login",
            form={"pin": pin},
            headers={"origin": base},
            max_redirects=0,
        ).status
        if status not in (303, 302):
            raise SystemExit(f"profile_hq_performance_baseline: login failed HTTP {status}")
        return ctx

    def sample(page, label: str, idle_ms: int | None = None) -> dict:
        return page.evaluate(
            SAMPLE_JS,
            {
                "sampleMs": args.sample_ms,
                "label": label,
                "idleMs": idle_ms if idle_ms is not None else args.idle_ms,
            },
        )

    accueil_specs = [
        (
            "accueil_companion_collapsed",
            "accueil-companion-collapsed",
            """
            try {
              localStorage.setItem('hq_companion_on','1');
              localStorage.setItem('hq_companion_collapsed','1');
              localStorage.removeItem('hq_companion_nsfw');
              localStorage.removeItem('hq_companion_layered_portrait');
              localStorage.setItem('hq_motion_mode','auto');
            } catch (e) {}
            """,
            1200,
        ),
        (
            "accueil_companion_expanded",
            "accueil-companion-expanded",
            """
            try {
              localStorage.setItem('hq_companion_on','1');
              localStorage.setItem('hq_companion_collapsed','0');
              localStorage.setItem('hq_companion_nsfw','1');
              localStorage.setItem('hq_companion_layered_portrait','1');
              localStorage.setItem('hq_companion_persona','warm');
              localStorage.setItem('hq_motion_mode','auto');
            } catch (e) {}
            """,
            2000,
        ),
        (
            "accueil_motion_full_expanded",
            "accueil-motion-full-expanded",
            """
            try {
              localStorage.setItem('hq_companion_on','1');
              localStorage.setItem('hq_companion_collapsed','0');
              localStorage.setItem('hq_companion_nsfw','1');
              localStorage.setItem('hq_companion_layered_portrait','1');
              localStorage.setItem('hq_motion_mode','full');
            } catch (e) {}
            """,
            2500,
        ),
    ]

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed)

        for scenario_key, label, init_script, settle_ms in accueil_specs:
            runs: list[dict] = []
            for rep in range(args.repeats):
                ctx = login_ctx(browser)
                ctx.add_init_script(init_script)
                page = ctx.new_page()
                page.route("**/api/ai*", ai_route)
                page.goto(f"{base}/", wait_until="domcontentloaded", timeout=60000)
                page.wait_for_selector(".hq-companion", state="attached", timeout=30000)
                page.wait_for_timeout(settle_ms)
                runs.append(sample(page, f"{label}-r{rep + 1}"))
                ctx.close()
            report["scenarios"][scenario_key] = runs[0] if len(runs) == 1 else {"repeats": runs}

        if not args.skip_atelier:
            from profile_hq_atelier_collect import collect_atelier3d

            report["scenarios"]["atelier3d_model"] = collect_atelier3d(
                browser, base, args, report, ai_route, login_ctx, sample
            )

        browser.close()

    archive_previous_latest(out_dir)
    archive_previous_latest(out_dir)
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    latest = out_dir / "hq-baseline-latest.json"
    latest.write_text(json.dumps(report, indent=2), encoding="utf-8")
    manifest = out_dir / "README.md"
    if not manifest.is_file():
        manifest.write_text(
            "# HQ performance baselines\n\n"
            "JSON captures from `python scripts/profile_hq_performance_baseline.py`.\n"
            "`hq-baseline-latest.json` is overwritten on each run.\n",
            encoding="utf-8",
        )

    print_summary(report, ROOT, out_path)


if __name__ == "__main__":
    main()
