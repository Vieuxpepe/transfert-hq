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

SAMPLE_MS = 2200
MIN_FRAMES = 18
MAX_LONG_TASKS = 12


def sample_motion(page) -> dict:
    return page.evaluate(
        """async (sampleMs) => {
          const t0 = performance.now();
          let frames = 0;
          let longTasks = 0;
          let obs = null;
          if (typeof PerformanceObserver !== "undefined") {
            obs = new PerformanceObserver((list) => {
              longTasks += list.getEntries().length;
            });
            try { obs.observe({ entryTypes: ["longtask"] }); } catch (_) {}
          }
          await new Promise((resolve) => {
            function tick() {
              frames += 1;
              if (performance.now() - t0 < sampleMs) requestAnimationFrame(tick);
              else resolve();
            }
            requestAnimationFrame(tick);
          });
          if (obs) obs.disconnect();
          const motion = window.HqMotion ? window.HqMotion.getState() : null;
          const softbody = document.querySelector(".hq-dangling-member-mount.is-softbody") != null;
          return { frames, longTasks, motion, softbody };
        }""",
        SAMPLE_MS,
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
        info = json.loads(proc.stdout.readline().decode("utf-8"))
        base = info["base"]
        pin = info["admin_pin"]
        problems: list[str] = []
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
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

            page.route("**/api/ai*", ai_status)
            page.on("pageerror", lambda e: problems.append("pageerror: " + str(e)))
            page.goto(base + "/", wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(500)
            if page.evaluate("() => !!document.querySelector('.hq-dangling-member-mount.is-softbody')"):
                problems.append("dangle softbody within 500ms (expected PNG+CSS idle first)")
            page.wait_for_timeout(1500)
            if not page.evaluate("() => !!window.HqMotion"):
                problems.append("missing window.HqMotion")
            page.wait_for_selector(".hq-companion", timeout=20000)
            idle = sample_motion(page)
            if idle.get("frames", 0) < MIN_FRAMES:
                problems.append("idle frames=%s (min %s)" % (idle.get("frames"), MIN_FRAMES))
            if idle.get("longTasks", 0) > MAX_LONG_TASKS:
                problems.append("idle longTasks=%s (max %s)" % (idle.get("longTasks"), MAX_LONG_TASKS))
            page.evaluate("() => window.HqMotion.setMode('lite')")
            tier = page.evaluate("() => window.HqMotion.getState().tier")
            if tier not in ("lite", "parked"):
                problems.append("expected lite tier after setMode, got %r" % tier)
            html_tier = page.evaluate("() => document.documentElement.dataset.hqMotionTier")
            if html_tier != tier:
                problems.append("html data-hq-motion-tier mismatch %r vs %r" % (html_tier, tier))
            page.evaluate("() => window.HqMotion.setMode('smooth')")
            mode = page.evaluate("() => window.HqMotion.getMode()")
            if mode != "smooth":
                problems.append("HqMotion.setMode(smooth) failed (got %r)" % mode)
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
            if problems:
                raise SystemExit("FAIL:\n" + "\n".join(problems))
            print(
                "PASS motion fps smoke frames=%s longTasks=%s tier=%s"
                % (idle.get("frames"), idle.get("longTasks"), tier)
            )
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=8)


if __name__ == "__main__":
    main()
