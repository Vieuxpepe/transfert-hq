// Offline navigation checks for the Dessiner 3D view and the face-sketch editor (no browser; stub canvas).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const asset = name => readFileSync(new URL(`../assets/${name}`, import.meta.url), "utf8");
const noop = () => {};
const ctx2d = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
function stubCanvas(w, h) {
  const handlers = {};
  return { width: w, height: h, clientWidth: w, clientHeight: h, className: "", style: {}, handlers,
    parentNode: { appendChild: noop, insertBefore: noop }, getContext: kind => (kind === "2d" ? ctx2d() : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
    addEventListener: (type, fn) => { handlers[type] = fn; }, setPointerCapture: noop, releasePointerCapture: noop,
    setAttribute: noop, classList: { add: noop, remove: noop, toggle: noop } };
}
function load(name, extra = {}) {
  const window = { devicePixelRatio: 1, requestAnimationFrame: noop, ...extra };
  const document = { createElement: () => stubCanvas(300, 150) };
  vm.runInNewContext(asset(name), { window, document, console, Math });
  return window;
}

// ---- 3D view: dragging moves the model with the pointer (standard orbit/turntable). ----
{
  const { HQSolidView } = load("hq-solid-view.js");
  const canvas = stubCanvas(400, 300), v = HQSolidView(canvas);
  const c = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const tris = [[c[0], c[1], c[2]], [c[0], c[2], c[3]], [c[4], c[5], c[6]], [c[4], c[6], c[7]]];
  v.setTriangles(tris);
  v.project = canvas.hqSolidProject;
  const nearest = () => c.reduce((best, p) => (v.project(p)[2] < v.project(best)[2] ? p : best));
  const ev = (id, x, y, extra = {}) => ({ pointerId: id, clientX: x, clientY: y, pointerType: "mouse", button: 0, preventDefault: noop, ...extra });
  const drag = (dx, dy) => { const h = canvas.handlers; h.pointerdown(ev(1, 200, 150)); for (let i = 1; i <= 4; i++) h.pointermove(ev(1, 200 + dx * i / 4, 150 + dy * i / 4)); h.pointerup(ev(1, 200 + dx, 150 + dy)); };

  // Horizontal: the point nearest the viewer must move right when dragging right (and left when dragging left).
  for (const dx of [20, -20]) {
    const front = nearest(), before = v.project(front)[0];
    drag(dx, 0);
    const moved = v.project(front)[0] - before;
    assert.ok(Math.sign(moved) === Math.sign(dx), `front of the model must follow a horizontal drag of ${dx}px (moved ${moved.toFixed(4)})`);
  }
  // Vertical: dragging down moves the front of the model down (projected y is up-positive), pitch stays clamped.
  v.reset();
  for (const dy of [20, -20]) {
    const front = nearest(), before = v.project(front)[1];
    drag(0, dy);
    const moved = v.project(front)[1] - before;
    assert.ok(Math.sign(moved) === -Math.sign(dy), `front of the model must follow a vertical drag of ${dy}px (moved ${moved.toFixed(4)})`);
  }
  drag(0, 5000); assert.ok(v.state.pitch <= 1.48 + 1e-9);
  drag(0, -10000); assert.ok(v.state.pitch >= -1.48 - 1e-9);
  // Zoom: wheel up / pinch out zooms in, wheel down zooms out.
  v.reset();
  canvas.handlers.wheel({ deltaY: -100, preventDefault: noop }); assert.ok(v.state.zoom > 1, "wheel up zooms in");
  canvas.handlers.wheel({ deltaY: 100, preventDefault: noop }); canvas.handlers.wheel({ deltaY: 100, preventDefault: noop });
  assert.ok(v.state.zoom < 1, "wheel down zooms out");
  v.reset();
  const h = canvas.handlers, t = (id, x) => ev(id, x, 150, { pointerType: "touch" });
  h.pointerdown(t(1, 180)); h.pointerdown(t(2, 220)); h.pointermove(t(2, 230)); h.pointermove(t(2, 260));
  assert.ok(v.state.zoom > 1, "pinch out zooms in");
  const yawBefore = v.state.yaw; h.pointermove(t(1, 150)); assert.equal(v.state.yaw, yawBefore, "two-finger pinch must not orbit");
  h.pointerup(t(1, 150)); h.pointerup(t(2, 260));
}

// ---- Face sketch view math: fit, screen <-> face mapping, pan and zoom. ----
{
  const { HQFaceSketch } = load("hq-face-sketch.js");
  const M = HQFaceSketch.math;
  const close = (a, b, eps = 1e-9) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${a} ~ ${b}`));
  // An extruded top face whose UV frame is far from the origin (the case that used to land off screen).
  const face = [[[120, -40], [220, -40], [220, 10]], [[120, -40], [220, 10], [120, 10]]];
  for (const [w, h] of [[874, 354], [728, 700], [300, 150], [40, 30]]) {
    const view = M.fit(face, w, h);
    const pts = face.flat().map(p => M.toScreen(view, w, h, p));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const margin = Math.min(25, w / 4, h / 4);
    assert.ok(Math.min(...xs) >= margin - 1e-6 && Math.max(...xs) <= w - margin + 1e-6, `x inside ${w}x${h}`);
    assert.ok(Math.min(...ys) >= margin - 1e-6 && Math.max(...ys) <= h - margin + 1e-6, `y inside ${w}x${h}`);
    close([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2], [w / 2, h / 2], 1e-6);
    assert.ok(Math.max(...xs) - Math.min(...xs) >= w - 2 * margin - 1e-6 || Math.max(...ys) - Math.min(...ys) >= h - 2 * margin - 1e-6, "fit fills one axis");
    for (const p of [[120, -40], [171.25, -3.5], [220, 10]]) close(M.toFace(view, w, h, M.toScreen(view, w, h, p)), p, 1e-9);
  }
  assert.equal(M.fit([], 100, 100), null);
  // Face y is up, screen y is down.
  let view = M.fit(face, 800, 400);
  assert.ok(M.toScreen(view, 800, 400, [170, 10])[1] < M.toScreen(view, 800, 400, [170, -40])[1]);
  // Pan: a drag of (dx, dy) screen px moves every face point by exactly (dx, dy) on screen.
  const p = [150, -20], s0 = M.toScreen(view, 800, 400, p);
  const panned = M.pan(view, 37, -12);
  close(M.toScreen(panned, 800, 400, p), [s0[0] + 37, s0[1] - 12], 1e-9);
  // Screen -> face after panning: the point under the pointer is the panned mapping.
  close(M.toFace(panned, 800, 400, [s0[0] + 37, s0[1] - 12]), p, 1e-9);
  // Zoom keeps the face point under the cursor fixed and scales distances; clamps apply.
  const q = [610, 90], under = M.toFace(panned, 800, 400, q);
  const zoomed = M.zoomAt(panned, 800, 400, q, 2.5, 0.01, 1e6);
  close(M.toFace(zoomed, 800, 400, q), under, 1e-9);
  assert.ok(Math.abs(zoomed.scale - panned.scale * 2.5) < 1e-9);
  assert.equal(M.zoomAt(panned, 800, 400, q, 1e9, 0.01, panned.scale * 3).scale, panned.scale * 3);
  assert.equal(M.zoomAt(panned, 800, 400, q, 1e-9, panned.scale / 3, 1e6).scale, panned.scale / 3);
}
console.log("hq 3d navigation checks ok");
