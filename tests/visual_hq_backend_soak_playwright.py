"""Live HQ navigation/idle soak with latency, error, tier, and heap guards."""

from __future__ import annotations

import argparse
import json
import statistics
import time

from playwright.sync_api import sync_playwright

VIEWS = ("accueil", "calendrier", "fichiers", "carnet", "intime")


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * ratio))]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8765")
    parser.add_argument("--pin", required=True)
    parser.add_argument("--minutes", type=float, default=15.0)
    parser.add_argument("--cycle-seconds", type=float, default=10.0)
    args = parser.parse_args()
    cycles = max(1, int(args.minutes * 60 / args.cycle_seconds))
    problems: list[str] = []
    nav_ms: list[float] = []
    api_ms: list[float] = []
    api_by_route: dict[str, list[float]] = {}
    api_per_cycle: list[int] = []
    heaps: list[int] = []
    page_errors: list[str] = []
    server_5xx: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(bypass_csp=True)
        login = ctx.request.post(
            args.base + "/login",
            form={"pin": args.pin},
            headers={"Origin": args.base},
            max_redirects=0,
        )
        if login.status != 303:
            raise SystemExit(f"login failed: HTTP {login.status}")
        before_errors = ctx.request.get(args.base + "/api/diag/errors?limit=100").json()
        before_ids = {
            str(row.get("request_id") or "")
            for row in before_errors.get("errors", [])
            if row.get("request_id")
        }

        page = ctx.new_page()
        page.add_init_script(
            """window.__hqSoak = { tiers: [], lastTier: "" };
            addEventListener("hq:motion-mode", (event) => {
              const tier = event.detail && event.detail.tier || "";
              if (tier && tier !== window.__hqSoak.lastTier) {
                window.__hqSoak.lastTier = tier;
                window.__hqSoak.tiers.push({ tier, at: performance.now() });
              }
            });"""
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "response",
            lambda response: server_5xx.append(f"{response.status} {response.url}")
            if response.status >= 500
            else None,
        )
        page.goto(args.base + "/", wait_until="domcontentloaded", timeout=45000)
        page.wait_for_function("() => !!window.HqMotion && !!window.HqKinetic", timeout=30000)
        page.evaluate("() => window.HqMotion.setMode('auto')")

        for index in range(cycles):
            cycle_started = time.perf_counter()
            view = VIEWS[index % len(VIEWS)]
            start_mark = page.evaluate(
                "() => { performance.clearResourceTimings(); return performance.now(); }"
            )
            page.evaluate("(target) => window.setView(target)", view)
            page.wait_for_function(
                "(target) => document.body.dataset.view === target",
                arg=view,
                timeout=10000,
            )
            nav = page.evaluate("(start) => performance.now() - start", start_mark)
            nav_ms.append(float(nav))
            page.wait_for_timeout(5000)
            sample = page.evaluate(
                """(start) => {
                  const resources = performance.getEntriesByType("resource").filter(
                    (entry) => entry.startTime >= start && entry.name.includes("/api/")
                  );
                  const running = document.getAnimations().filter((anim) => anim.playState === "running");
                  const homeRunning = running.filter((anim) => {
                    const target = anim.effect && anim.effect.target;
                    return target && target.closest && target.closest(".home-bg,.home-hero");
                  }).length;
                  return {
                    apiRows: resources.map((entry) => ({
                      path: new URL(entry.name).pathname,
                      duration: entry.duration,
                    })),
                    apiCount: resources.length,
                    heap: performance.memory ? performance.memory.usedJSHeapSize : 0,
                    motion: HqMotion.getState(),
                    kinetic: HqKinetic.getState(),
                    homeRunning,
                  };
                }""",
                start_mark,
            )
            for row in sample["apiRows"]:
                duration = float(row["duration"])
                api_ms.append(duration)
                api_by_route.setdefault(str(row["path"]), []).append(duration)
            api_per_cycle.append(int(sample["apiCount"]))
            if sample["heap"]:
                heaps.append(int(sample["heap"]))
            if view != "accueil" and sample["homeRunning"]:
                problems.append(f"{view}: {sample['homeRunning']} home animations after settle")
            if sample["kinetic"]["active"] or sample["kinetic"]["ticking"]:
                problems.append(f"{view}: kinetic scheduler did not settle")
            print(
                json.dumps(
                    {
                        "cycle": index + 1,
                        "view": view,
                        "nav_ms": round(nav, 1),
                        "api_count": sample["apiCount"],
                        "api_slowest": sorted(
                            (
                                {"path": row["path"], "ms": round(float(row["duration"]), 1)}
                                for row in sample["apiRows"]
                            ),
                            key=lambda row: row["ms"],
                            reverse=True,
                        )[:3],
                        "heap_mb": round(sample["heap"] / 1048576, 1) if sample["heap"] else None,
                        "tier": sample["motion"]["tier"],
                    }
                ),
                flush=True,
            )
            remaining = args.cycle_seconds - (time.perf_counter() - cycle_started)
            if remaining > 0:
                page.wait_for_timeout(remaining * 1000)

        after_errors = ctx.request.get(args.base + "/api/diag/errors?limit=100").json()
        new_errors = [
            row
            for row in after_errors.get("errors", [])
            if row.get("request_id") and str(row.get("request_id")) not in before_ids
        ]
        tiers = page.evaluate("() => window.__hqSoak.tiers")
        if new_errors:
            problems.append(f"new server errors={len(new_errors)}")
        if server_5xx:
            problems.append(f"HTTP 5xx responses={len(server_5xx)}")
        if page_errors:
            problems.append(f"page errors={len(page_errors)}")
        if percentile(nav_ms, 0.95) > 1000 or max(nav_ms, default=0) > 3000:
            problems.append(
                f"navigation latency p95={percentile(nav_ms, 0.95):.0f}ms max={max(nav_ms):.0f}ms"
            )
        if percentile(api_ms, 0.95) > 1000 or max(api_ms, default=0) > 3000:
            problems.append(
                f"API latency p95={percentile(api_ms, 0.95):.0f}ms max={max(api_ms):.0f}ms"
            )
        if max(api_per_cycle, default=0) > 20:
            problems.append(f"API burst max={max(api_per_cycle)} requests/cycle")
        if len(tiers) > 6:
            problems.append(f"motion tier oscillation changes={len(tiers)}")
        heap_growth = 0
        if len(heaps) >= 10:
            width = min(10, len(heaps) // 2)
            first = statistics.median(heaps[:width])
            last = statistics.median(heaps[-width:])
            heap_growth = int(last - first)
            if heap_growth > max(48 * 1024 * 1024, first * 0.5):
                problems.append(f"heap growth={heap_growth / 1048576:.1f}MB")

        summary = {
            "cycles": cycles,
            "minutes": args.minutes,
            "nav_p95_ms": round(percentile(nav_ms, 0.95), 1),
            "nav_max_ms": round(max(nav_ms, default=0), 1),
            "api_requests": len(api_ms),
            "api_p95_ms": round(percentile(api_ms, 0.95), 1),
            "api_max_ms": round(max(api_ms, default=0), 1),
            "api_burst_max": max(api_per_cycle, default=0),
            "api_routes": {
                path: {
                    "count": len(values),
                    "p95_ms": round(percentile(values, 0.95), 1),
                    "max_ms": round(max(values), 1),
                }
                for path, values in sorted(api_by_route.items())
            },
            "tier_changes": tiers,
            "heap_growth_mb": round(heap_growth / 1048576, 1),
            "new_server_errors": new_errors,
            "page_errors": page_errors,
            "http_5xx": server_5xx,
        }
        print(json.dumps(summary, indent=2), flush=True)
        browser.close()
    if problems:
        raise SystemExit("FAIL:\n" + "\n".join(problems))
    print("PASS HQ backend soak", flush=True)


if __name__ == "__main__":
    main()
