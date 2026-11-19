"""Atelier 3D slice for profile_hq_performance_baseline (keeps main script readable)."""

from __future__ import annotations

from typing import Any, Callable


def collect_atelier3d(
    browser,
    base: str,
    args: Any,
    report: dict,
    ai_route: Callable,
    login_ctx: Callable,
    sample: Callable,
) -> dict:
    ctx = login_ctx(browser)
    ctx.add_init_script("try{localStorage.setItem('hq_companion_on','0');}catch(e){}")
    page = ctx.new_page()
    page.route("**/api/ai*", ai_route)
    page.goto(f"{base}/", wait_until="domcontentloaded", timeout=60000)
    atelier: dict = {"label": "atelier3d-model-cycle"}

    nav_ms = page.evaluate(
        """async () => {
      const t0 = performance.now();
      await Promise.resolve(window.setView('atelier3d'));
      while ((document.body.dataset.view || '') !== 'atelier3d') {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 100));
      const deadline = t0 + 30000;
      while (performance.now() < deadline) {
        if (window.HqPrint3d && document.querySelector('#p3d-tab-models')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return { navMs: Math.round(performance.now() - t0), hasPrint3d: !!window.HqPrint3d };
    }"""
    )
    atelier["navigation"] = nav_ms

    model_pick = page.evaluate(
        """async () => {
      const res = await fetch('/api/print3d/models', { credentials: 'same-origin' });
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      const list = (data && data.models) || data || [];
      const arr = Array.isArray(list) ? list : (list.items || []);
      const stl = arr.filter((m) => {
        const ext = String(m.ext || '').toLowerCase();
        return (ext === 'stl' || ext === 'glb') && (m.size || 0) > 0;
      });
      stl.sort((a, b) => (a.size || 0) - (b.size || 0));
      const pick = stl[0];
      if (!pick) return { ok: false, reason: 'no-stl-glb-in-library' };
      return { ok: true, id: pick.id, name: pick.name, size: pick.size, ext: pick.ext };
    }"""
    )
    atelier["modelPick"] = model_pick

    if model_pick.get("ok"):
        page.click("#p3d-tab-models")
        page.wait_for_selector(f'button.p3d-model[data-id="{model_pick["id"]}"]', timeout=30000)
        open_metrics = page.evaluate(
            """async (id) => {
          const t0 = performance.now();
          let longTasks = 0;
          let obs = null;
          if (typeof PerformanceObserver !== 'undefined') {
            obs = new PerformanceObserver((list) => {
              for (const e of list.getEntries()) longTasks += 1;
            });
            try { obs.observe({ entryTypes: ['longtask'] }); } catch (_) {}
          }
          const btn = document.querySelector('button.p3d-model[data-id="' + id + '"]');
          if (!btn) return { ok: false, reason: 'tile-missing' };
          btn.click();
          let ready = false;
          const deadline = t0 + 120000;
          while (performance.now() < deadline) {
            const canvas = document.querySelector('.p3d-overlay .p3d-canvas');
            const note = document.querySelector('.p3d-overlay .p3d-meta');
            const noteText = note ? note.textContent : '';
            if (canvas && noteText && !/Chargement/i.test(noteText)) { ready = true; break; }
            await new Promise((r) => setTimeout(r, 40));
          }
          if (obs) obs.disconnect();
          return {
            ok: ready,
            openMs: Math.round(performance.now() - t0),
            longTasksDuringOpen: longTasks,
            heapAfterOpen: performance.memory ? performance.memory.usedJSHeapSize : null,
          };
        }""",
            model_pick["id"],
        )
        atelier["open"] = open_metrics
        canvas = page.locator(".p3d-overlay .p3d-canvas")
        if canvas.count():
            box = canvas.first.bounding_box()
            if box:
                cx = box["x"] + box["width"] / 2
                cy = box["y"] + box["height"] / 2
                page.mouse.move(cx, cy)
                page.mouse.down()
                for i in range(args.rotations):
                    page.mouse.move(cx + 40 + i * 8, cy - 20 - i * 4, steps=3)
                page.mouse.up()
        atelier["rotationSample"] = sample(page, "atelier-model-rotation", idle_ms=0)
        heaps: list[dict] = []
        for cycle in range(3):
            page.click(".p3d-overlay .p3d-close", timeout=10000)
            page.wait_for_timeout(400)
            h = page.evaluate(
                "() => performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize } : null"
            )
            heaps.append({"cycleAfterClose": cycle + 1, "heap": h})
            if cycle < 2:
                page.click(f'button.p3d-model[data-id="{model_pick["id"]}"]')
                page.wait_for_selector(".p3d-overlay .p3d-canvas", timeout=60000)
                page.wait_for_timeout(800)
        atelier["closeCycles"] = heaps
    else:
        report["notes"].append(
            "Print3D library empty — synthetic 12-triangle STL via HQModel on atelier3d view."
        )
        synth = page.evaluate(_SYNTH_VIEWER_JS)
        atelier["syntheticViewer"] = synth
        if synth.get("ok"):
            canvas = page.locator(".p3d-canvas").last
            box = canvas.bounding_box()
            if box:
                cx = box["x"] + box["width"] / 2
                cy = box["y"] + box["height"] / 2
                page.mouse.move(cx, cy)
                page.mouse.down()
                for i in range(args.rotations):
                    page.mouse.move(cx + 40 + i * 8, cy - 20 - i * 4, steps=3)
                page.mouse.up()
            atelier["rotationSample"] = sample(page, "atelier-synthetic-rotation", idle_ms=0)
            heaps = []
            for cycle in range(3):
                page.evaluate(_DISPOSE_JS)
                page.wait_for_timeout(300)
                h = page.evaluate(
                    "() => performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize } : null"
                )
                heaps.append({"cycleAfterClose": cycle + 1, "heap": h})
                if cycle < 2:
                    page.evaluate(_REMOUNT_JS)
                    page.wait_for_timeout(500)
            atelier["closeCycles"] = heaps

    ctx.close()
    return atelier


_SYNTH_VIEWER_JS = """async () => {
  if (!window.HQModel) return { ok: false, reason: 'HQModel-missing' };
  const count = 12;
  const buf = new ArrayBuffer(84 + count * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, count, true);
  let o = 84;
  const tris = [
    [[0,0,0],[1,0,0],[1,1,0]],[[0,0,0],[1,1,0],[0,1,0]],
    [[0,0,1],[1,0,1],[1,1,1]],[[0,0,1],[1,1,1],[0,1,1]],
    [[0,0,0],[1,0,0],[1,0,1]],[[0,0,0],[1,0,1],[0,0,1]],
    [[1,1,0],[1,1,1],[1,0,1]],[[1,1,0],[1,0,1],[1,0,0]],
    [[0,0,0],[0,1,0],[0,1,1]],[[0,0,0],[0,1,1],[0,0,1]],
    [[0,1,0],[1,1,0],[1,1,1]],[[0,1,0],[1,1,1],[0,1,1]]
  ];
  for (let f = 0; f < count; f++) {
    for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, 0, true);
    o += 12;
    for (const p of tris[f]) for (let k = 0; k < 3; k++) dv.setFloat32(o++, p[k], true);
    o += 2;
  }
  let longTasks = 0;
  let obs = null;
  if (typeof PerformanceObserver !== 'undefined') {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks += 1;
    });
    try { obs.observe({ entryTypes: ['longtask'] }); } catch (_) {}
  }
  const t0 = performance.now();
  const parsed = window.HQModel.parse('baseline-cube.stl', buf);
  const parseMs = Math.round(performance.now() - t0);
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:20% 15%;z-index:9999;background:#111;padding:8px';
  const canvas = document.createElement('canvas');
  canvas.className = 'p3d-canvas';
  canvas.style.width = '100%'; canvas.style.height = '100%';
  wrap.appendChild(canvas);
  document.body.appendChild(wrap);
  const viewer = window.HQModel.viewer(canvas);
  viewer.setModel(parsed);
  window.__hqBaselineViewer = viewer;
  window.__hqBaselineMount = wrap;
  const openMs = Math.round(performance.now() - t0);
  if (obs) obs.disconnect();
  return {
    ok: true, synthetic: true, parseMs, openMs,
    longTasksDuringOpen: longTasks, triangles: parsed.triangles,
    webgl: !!viewer.webgl,
    heapAfterOpen: performance.memory ? performance.memory.usedJSHeapSize : null,
  };
}"""

_DISPOSE_JS = """() => {
  try { window.__hqBaselineViewer && window.__hqBaselineViewer.dispose(); } catch (_) {}
  if (window.__hqBaselineMount) try { window.__hqBaselineMount.remove(); } catch (_) {}
  window.__hqBaselineViewer = null;
  window.__hqBaselineMount = null;
}"""

_REMOUNT_JS = """() => {
  if (!window.HQModel) return;
  const count = 12;
  const buf = new ArrayBuffer(84 + count * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, count, true);
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:20% 15%;z-index:9999;background:#111;padding:8px';
  const canvas = document.createElement('canvas');
  canvas.className = 'p3d-canvas';
  canvas.style.width = '100%'; canvas.style.height = '100%';
  wrap.appendChild(canvas);
  document.body.appendChild(wrap);
  const parsed = window.HQModel.parse('baseline-cube.stl', buf);
  const viewer = window.HQModel.viewer(canvas);
  viewer.setModel(parsed);
  window.__hqBaselineViewer = viewer;
  window.__hqBaselineMount = wrap;
}"""