"""Accueil motion smoke: HqMotion tier, idle long tasks, Outils fluidité select.

python tests/visual_hq_motion_fps_playwright.py

Requires: pip install playwright && playwright install chromium
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent

SAMPLE_MS = 3000
MIN_FPS = 40.0
MIN_FULL_FPS = 24.0
MAX_P95_GAP_MS = 40.0
MAX_FULL_P95_GAP_MS = 55.0
MAX_LONG_TASKS = 2
MAX_API_REQUESTS = 4
MAX_FULL_ANIMATIONS = 45
MAX_LITE_ANIMATIONS = 16
MAX_NAV_COMMIT_MS = 600
MAX_CARNET_READY_MS = 5000
MAX_CARNET_SCRIPTS = 45


def sample_motion(page, label: str) -> dict:
    return page.evaluate(
        """async ({ sampleMs, label }) => {
          const t0 = performance.now();
          const frames = [];
          let longTasks = 0;
          let longTaskMs = 0;
          let obs = null;
          if (typeof PerformanceObserver !== "undefined") {
            obs = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                longTasks += 1;
                longTaskMs += entry.duration;
              }
            });
            try { obs.observe({ entryTypes: ["longtask"] }); } catch (_) {}
          }
          await new Promise((resolve) => {
            function tick(now) {
              frames.push(now);
              if (performance.now() - t0 < sampleMs) requestAnimationFrame(tick);
              else resolve();
            }
            requestAnimationFrame(tick);
          });
          if (obs) obs.disconnect();
          const elapsed = performance.now() - t0;
          const gaps = [];
          for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i] - frames[i - 1]);
          gaps.sort((a, b) => a - b);
          const resources = performance.getEntriesByType("resource").filter((entry) => entry.startTime >= t0);
          const running = document.getAnimations().filter((anim) => anim.playState === "running");
          const homeAnimations = running.filter((anim) => {
            const target = anim.effect && anim.effect.target;
            return target && target.closest && target.closest(".home-bg,.home-hero");
          }).length;
          const motion = window.HqMotion ? window.HqMotion.getState() : null;
          const softbody = document.querySelector(".hq-dangling-member-mount.is-softbody") != null;
          return {
            label,
            frames: frames.length,
            fps: Number((frames.length * 1000 / elapsed).toFixed(1)),
            p95GapMs: Number((gaps[Math.floor(gaps.length * 0.95)] || 0).toFixed(1)),
            maxGapMs: Number((gaps[gaps.length - 1] || 0).toFixed(1)),
            longTasks,
            longTaskMs: Math.round(longTaskMs),
            apiRequests: resources.filter((entry) => entry.name.includes("/api/")).length,
            runningAnimations: running.length,
            homeAnimations,
            motion,
            softbody,
          };
        }""",
        {"sampleMs": SAMPLE_MS, "label": label},
    )


def check_sample(
    problems: list[str],
    sample: dict,
    *,
    min_fps: float = MIN_FPS,
    max_p95_gap_ms: float = MAX_P95_GAP_MS,
    max_animations: int | None = None,
) -> None:
    label = str(sample.get("label") or "sample")
    if float(sample.get("fps") or 0) < min_fps:
        problems.append(f"{label} fps={sample.get('fps')} (min {min_fps})")
    if float(sample.get("p95GapMs") or 0) > max_p95_gap_ms:
        problems.append(f"{label} p95GapMs={sample.get('p95GapMs')} (max {max_p95_gap_ms})")
    if int(sample.get("longTasks") or 0) > MAX_LONG_TASKS:
        problems.append(f"{label} longTasks={sample.get('longTasks')} (max {MAX_LONG_TASKS})")
    if int(sample.get("apiRequests") or 0) > MAX_API_REQUESTS:
        problems.append(f"{label} apiRequests={sample.get('apiRequests')} (max {MAX_API_REQUESTS})")
    if max_animations is not None and int(sample.get("runningAnimations") or 0) > max_animations:
        problems.append(
            f"{label} runningAnimations={sample.get('runningAnimations')} (max {max_animations})"
        )


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-motion-fps-"))
    proc = subprocess.Popen(
        [sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        raw_line = proc.stdout.readline()
        line = raw_line.decode("utf-8") if isinstance(raw_line, (bytes, bytearray)) else raw_line
        if not line or not line.strip():
            ret = proc.poll()
            stderr_out = proc.stderr.read().decode("utf-8", errors="replace") if proc.stderr else ""
            raise RuntimeError(
                f"carnet_test_server.py failed to start (exit code {ret}):\n{stderr_out}"
            )
        info = json.loads(line)
        base = info["base"]
        pin = info["admin_pin"]
        problems: list[str] = []
        with sync_playwright() as pw:
            browser = pw.chromium.launch()

            def ai_status(route):
                if route.request.method == "GET" and "/api/ai" in route.request.url:
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
                    return
                route.continue_()

            ctx = browser.new_context(bypass_csp=True)
            ctx.add_init_script(
                "try{localStorage.setItem('hq_companion_on','1');}catch(e){}"
            )
            assert (
                ctx.request.post(
                    base + "/login", form={"pin": pin}, headers={"origin": base}, max_redirects=0
                ).status
                == 303
            )
            page = ctx.new_page()
            page.route("**/api/ai*", ai_status)
            page.on("pageerror", lambda e: problems.append("pageerror: " + str(e)))
            page.goto(base + "/", wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(500)
            if page.evaluate("() => !!document.querySelector('.hq-dangling-member-mount.is-softbody')"):
                problems.append("dangle softbody within 500ms (expected PNG+CSS idle first)")
            page.wait_for_timeout(1500)
            if not page.evaluate("() => !!window.HqMotion"):
                problems.append("missing window.HqMotion")
            if not page.evaluate("() => !!window.HqKinetic"):
                problems.append("missing window.HqKinetic")
            page.wait_for_selector(".hq-companion", timeout=20000)

            if page.evaluate(
                "() => performance.getEntriesByType('resource').some(e => /hq-carnet(?:\\.js|\\/)/.test(e.name))"
            ):
                problems.append("Carnet scripts loaded before first Carnet navigation")

            page.evaluate("() => window.HqMotion.setMode('smooth')")
            page.wait_for_timeout(500)
            full = sample_motion(page, "accueil-full")
            check_sample(
                problems,
                full,
                min_fps=MIN_FULL_FPS,
                max_p95_gap_ms=MAX_FULL_P95_GAP_MS,
                max_animations=MAX_FULL_ANIMATIONS,
            )
            if full.get("softbody"):
                problems.append("dangle entered softbody without direct interaction")

            page.evaluate("() => window.HqMotion.setMode('lite')")
            page.wait_for_timeout(500)
            lite = sample_motion(page, "accueil-lite")
            check_sample(problems, lite, max_animations=MAX_LITE_ANIMATIONS)
            tier = page.evaluate("() => window.HqMotion.getState().tier")
            if tier not in ("lite", "parked"):
                problems.append("expected lite tier after setMode, got %r" % tier)
            html_tier = page.evaluate("() => document.documentElement.dataset.hqMotionTier")
            if html_tier != tier:
                problems.append("html data-hq-motion-tier mismatch %r vs %r" % (html_tier, tier))
            if int(lite.get("runningAnimations") or 0) >= int(full.get("runningAnimations") or 0):
                problems.append("Lite did not reduce running animations")

            nav = page.evaluate(
                """async () => {
                  const t0 = performance.now();
                  await Promise.resolve(window.setView("calendrier"));
                  while (document.body.dataset.view !== "calendrier") {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                  }
                  return performance.now() - t0;
                }"""
            )
            if nav > MAX_NAV_COMMIT_MS:
                problems.append(f"calendrier navigation={nav:.1f}ms (max {MAX_NAV_COMMIT_MS})")
            page.wait_for_timeout(1800)
            off_view = page.evaluate(
                """() => document.getAnimations().filter((anim) => {
                  if (anim.playState !== "running") return false;
                  const target = anim.effect && anim.effect.target;
                  return target && target.closest && target.closest(".home-bg,.home-hero");
                }).map((anim) => {
                  const target = anim.effect && anim.effect.target;
                  return {
                    type: anim.constructor && anim.constructor.name || "",
                    name: anim.animationName || "",
                    property: anim.transitionProperty || "",
                    className: target && target.className ? String(target.className) : "",
                  };
                })"""
            )
            if off_view:
                problems.append(f"off-view home animations still running={off_view}")

            carnet_start = page.evaluate("() => performance.now()")
            page.evaluate("() => window.setView('carnet')")
            page.wait_for_function("() => document.body.dataset.view === 'carnet'", timeout=MAX_CARNET_READY_MS)
            page.wait_for_function("() => typeof window.hqCarnetShow === 'function'", timeout=MAX_CARNET_READY_MS)
            carnet_ready_ms = page.evaluate("(start) => performance.now() - start", carnet_start)
            if carnet_ready_ms > MAX_CARNET_READY_MS:
                problems.append(
                    f"Carnet cold ready={carnet_ready_ms:.1f}ms (max {MAX_CARNET_READY_MS})"
                )
            carnet_scripts = page.evaluate(
                """(start) => performance.getEntriesByType("resource").filter(
                  (entry) => entry.startTime >= start && entry.initiatorType === "script"
                    && entry.name.includes("hq-carnet")
                ).length""",
                carnet_start,
            )
            if not carnet_scripts or carnet_scripts > MAX_CARNET_SCRIPTS:
                problems.append(
                    f"Carnet cold scripts={carnet_scripts} (expected 1..{MAX_CARNET_SCRIPTS})"
                )

            has_sel = page.evaluate("() => !!document.querySelector('select.hq-companion-motion-perf')")
            if has_sel:
                page.evaluate(
                    """() => {
                      const sel = document.querySelector('select.hq-companion-motion-perf');
                      sel.value = 'auto';
                      sel.dispatchEvent(new Event('change', { bubbles: true }));
                    }"""
                )
                if page.evaluate("() => window.HqMotion.getMode()") != "auto":
                    problems.append("Outils fluidité select did not sync to HqMotion")

            reduced = browser.new_context(bypass_csp=True, reduced_motion="reduce")
            reduced.add_init_script(
                "try{localStorage.setItem('hq_companion_on','1');}catch(e){}"
            )
            assert (
                reduced.request.post(
                    base + "/login", form={"pin": pin}, headers={"origin": base}, max_redirects=0
                ).status
                == 303
            )
            parked_page = reduced.new_page()
            parked_page.route("**/api/ai*", ai_status)
            parked_page.on("pageerror", lambda e: problems.append("parked pageerror: " + str(e)))
            parked_page.goto(base + "/", wait_until="domcontentloaded", timeout=45000)
            parked_page.wait_for_selector(".hq-companion", timeout=20000)
            parked_page.wait_for_timeout(1200)
            parked = sample_motion(parked_page, "accueil-parked")
            check_sample(problems, parked)
            if (parked.get("motion") or {}).get("tier") != "parked":
                problems.append("reduced-motion context did not enter parked tier")
            if int(parked.get("homeAnimations") or 0):
                problems.append(
                    f"parked home animations still running={parked.get('homeAnimations')}"
                )
            kinetic = parked_page.evaluate("() => window.HqKinetic && window.HqKinetic.getState()")
            if kinetic and (kinetic.get("active") or kinetic.get("ticking")):
                problems.append(f"parked kinetic scheduler active={kinetic}")
            reduced.close()

            if problems:
                raise SystemExit("FAIL:\n" + "\n".join(problems))
            print("PASS motion performance gates")
            print(json.dumps({
                "accueil_full": full,
                "accueil_lite": lite,
                "accueil_parked": parked,
                "calendrier_nav_ms": round(nav, 1),
                "carnet_ready_ms": round(carnet_ready_ms, 1),
                "carnet_scripts": carnet_scripts,
            }, indent=2, sort_keys=True))
            ctx.close()
            browser.close()
    finally:
        server_err = ""
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            pass
        try:
            if proc.stderr:
                server_err = proc.stderr.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        if server_err.strip():
            sys.stderr.write(f"\n--- carnet_test_server stderr ---\n{server_err}\n")


if __name__ == "__main__":
    main()
