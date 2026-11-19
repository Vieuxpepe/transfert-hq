"""Prove the home background's frame budget without changing what it looks like.

The home background used a full-screen `mix-blend-mode` grain. A blend layer makes
the browser re-blend the entire viewport every frame that anything beneath it
animates, which pinned the Full profile near 20-24 fps in software raster while
main-thread work stayed around 3.5 ms/frame. `.bg-grain` is now a normal
composite (same noise, same opacity), so this script checks the two things that
matter, on the gate's own fixture:

  1. paired fps: forcing the old blend back on and sampling again, back to back on
     the same page and host load, so drift cannot be blamed for the difference;
  2. parity: a frozen-animation screenshot of `.home-bg` in both states, and the
     per-pixel difference, in light and dark colour schemes.

Usage:
    python scripts/verify_home_bg_composite_budget.py
    python scripts/verify_home_bg_composite_budget.py --pairs 5 --min-fps 29.5
"""
from __future__ import annotations

import argparse
import json
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "tests"))

from playwright.sync_api import sync_playwright  # noqa: E402

import visual_hq_motion_fps_playwright as harness  # noqa: E402

INJECT = """(css) => {
  document.getElementById('probe-css')?.remove();
  if (!css) return true;
  const s = document.createElement('style');
  s.id = 'probe-css';
  s.textContent = css;
  document.head.appendChild(s);
  return true;
}"""
FREEZE = """() => {
  for (const a of document.getAnimations()) { a.pause(); try { a.currentTime = 2000; } catch (e) {} }
}"""
ANIM_NAMES = """() => [...new Set(document.getAnimations().map(
  (a) => a.animationName || a.transitionProperty || a.constructor.name))].sort()"""
BG_BOX = """() => {
  const r = document.querySelector('.home-bg').getBoundingClientRect();
  return {x: r.x, y: r.y, width: r.width, height: r.height};
}"""


def _start_fixture():
    root = Path(tempfile.mkdtemp(prefix="hq-bg-budget-"))
    proc = subprocess.Popen(
        [sys.executable, str(harness.HERE / "carnet_test_server.py"), str(root)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    line = proc.stdout.readline().decode("utf-8")
    if not line.strip():
        proc.kill()
        shutil.rmtree(root, ignore_errors=True)
        stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        raise RuntimeError("carnet_test_server.py failed to start:\n" + stderr)
    return root, proc, json.loads(line)


def _diff(path_a: Path, path_b: Path) -> dict:
    import numpy as np
    from PIL import Image

    a = np.asarray(Image.open(path_a).convert("RGB")).astype(np.int16)
    b = np.asarray(Image.open(path_b).convert("RGB")).astype(np.int16)
    d = np.abs(a - b).max(axis=2)
    total = d.size
    return {
        "mean": float(d.mean()),
        "max": int(d.max()),
        "over1": 100.0 * float((d > 1).sum()) / total,
        "over3": 100.0 * float((d > 3).sum()) / total,
        "over8": 100.0 * float((d > 8).sum()) / total,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", type=int, default=3)
    ap.add_argument("--min-fps", type=float, default=29.5)
    ap.add_argument("--min-gain", type=float, default=1.25)
    # A normal composite of the same mid-grey noise cannot reproduce multiply/overlay
    # exactly: the noise tile re-snaps to the pixel grid when it stops participating in
    # blending, so a mottled few percent of pixels move by a couple of levels. What must
    # stay imperceptible is the average shift and any hard edge, hence the mean and the
    # >8 tail; the >3 share is reported as a diagnostic with a loose ceiling.
    ap.add_argument("--max-mean-diff", type=float, default=1.0)
    ap.add_argument("--max-over3-pct", type=float, default=1.5)
    ap.add_argument("--max-over8-pct", type=float, default=0.02)
    ap.add_argument("--schemes", default="light,dark")
    ap.add_argument("--no-parity", action="store_true")
    args = ap.parse_args()

    problems: list[str] = []
    root, proc, info = _start_fixture()
    base, pin = info["base"], info["admin_pin"]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for scheme in [s.strip() for s in args.schemes.split(",") if s.strip()]:
                old_blend = "multiply" if scheme == "light" else "overlay"
                ctx = browser.new_context(
                    bypass_csp=True, color_scheme=scheme, viewport={"width": 1280, "height": 900}
                )
                ctx.add_init_script("try{localStorage.setItem('hq_companion_on','1');}catch(e){}")
                assert (
                    ctx.request.post(
                        base + "/login", form={"pin": pin}, headers={"origin": base}, max_redirects=0
                    ).status
                    == 303
                )
                page = ctx.new_page()
                page.route(
                    "**/api/ai*",
                    lambda r: r.fulfill(
                        json={
                            "ok": True,
                            "configured": True,
                            "companion_cap": "flirt",
                            "nsfw_allowed": True,
                            "session_admin": True,
                            "messages": [],
                        }
                    )
                    if r.request.method == "GET"
                    else r.continue_(),
                )
                page.goto(base + "/", wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(2300)
                page.wait_for_selector(".hq-companion", state="attached", timeout=20000)
                page.evaluate("() => window.HqMotion.setMode('smooth')")
                page.wait_for_timeout(1300)

                before_fps: list[float] = []
                after_fps: list[float] = []
                before_p95: list[float] = []
                after_p95: list[float] = []
                before_names: set[str] = set()
                after_names: set[str] = set()
                for i in range(args.pairs):
                    page.evaluate(INJECT, ".bg-grain{mix-blend-mode:%s!important}" % old_blend)
                    page.wait_for_timeout(300)
                    before = harness.sample_motion(page, "blend")
                    page.evaluate(INJECT, "")
                    page.wait_for_timeout(300)
                    after = harness.sample_motion(page, "composited")
                    before_fps.append(before["fps"])
                    after_fps.append(after["fps"])
                    before_p95.append(before["p95GapMs"])
                    after_p95.append(after["p95GapMs"])
                    before_names.update(page.evaluate(ANIM_NAMES))
                    after_names.update(page.evaluate(ANIM_NAMES))
                    print(
                        "  %-5s pair %d  blend %5.1f fps (p95 %5.1f)  →  composited %5.1f fps (p95 %5.1f)  anims %d/%d"
                        % (
                            scheme,
                            i + 1,
                            before["fps"],
                            before["p95GapMs"],
                            after["fps"],
                            after["p95GapMs"],
                            before["runningAnimations"],
                            after["runningAnimations"],
                        ),
                        flush=True,
                    )
                med_before = statistics.median(before_fps)
                med_after = statistics.median(after_fps)
                gain = med_after / med_before if med_before else 0.0
                print(
                    "  %-5s median %.1f → %.1f fps (x%.2f), p95 %.1f → %.1f ms"
                    % (
                        scheme,
                        med_before,
                        med_after,
                        gain,
                        statistics.median(before_p95),
                        statistics.median(after_p95),
                    )
                )
                if gain < args.min_gain:
                    problems.append("scheme %s: composited/ blended median gain %.2fx < %.2fx"
                                    % (scheme, gain, args.min_gain))
                if med_after < args.min_fps:
                    problems.append("scheme %s: composited median %.1f fps < %.1f"
                                    % (scheme, med_after, args.min_fps))
                lost = sorted(before_names - after_names)
                if lost:
                    problems.append("scheme %s: composited arm lost animations %s" % (scheme, lost))

                if not args.no_parity:
                    page.evaluate(FREEZE)
                    page.wait_for_timeout(600)
                    box = page.evaluate(BG_BOX)
                    page.evaluate(INJECT, ".bg-grain{mix-blend-mode:%s!important}" % old_blend)
                    page.wait_for_timeout(350)
                    shot_a = root / ("bg_%s_blend.png" % scheme)
                    page.screenshot(path=str(shot_a), clip=box)
                    page.evaluate(INJECT, "")
                    page.wait_for_timeout(350)
                    shot_b = root / ("bg_%s_composited.png" % scheme)
                    page.screenshot(path=str(shot_b), clip=box)
                    d = _diff(shot_a, shot_b)
                    print(
                        "  %-5s parity  mean %.3f level · max %d · >1: %.2f%% · >3: %.3f%% · >8: %.3f%%"
                        % (scheme, d["mean"], d["max"], d["over1"], d["over3"], d["over8"])
                    )
                    if d["mean"] > args.max_mean_diff:
                        problems.append("scheme %s: mean pixel diff %.3f > %.3f"
                                        % (scheme, d["mean"], args.max_mean_diff))
                    if d["over3"] > args.max_over3_pct:
                        problems.append("scheme %s: %.3f%% of pixels differ by >3 levels (max %.2f%%)"
                                        % (scheme, d["over3"], args.max_over3_pct))
                    if d["over8"] > args.max_over8_pct:
                        problems.append("scheme %s: %.3f%% of pixels differ by >8 levels (max %.2f%%)"
                                        % (scheme, d["over8"], args.max_over8_pct))
                ctx.close()
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        shutil.rmtree(root, ignore_errors=True)

    if problems:
        print("\nFAIL:")
        for p in problems:
            print("  " + p)
        return 1
    print("verify_home_bg_composite_budget: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
