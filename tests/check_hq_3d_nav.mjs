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

// ---- 3D view: translation pan follows the pointer exactly; zoom stays anchored; pan never selects. ----
{
  const { HQSolidView } = load("hq-solid-view.js");
  const c = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const tris = [[c[0], c[1], c[2]], [c[0], c[2], c[3]], [c[4], c[5], c[6]], [c[4], c[6], c[7]]];
  const ev = (id, x, y, extra = {}) => ({ pointerId: id, clientX: x, clientY: y, pointerType: "mouse", button: 0, preventDefault: noop, ...extra });
  // Backing store twice the CSS size (DPR 2) in landscape, portrait and square shapes.
  for (const [w, h] of [[400, 300], [300, 420], [360, 360]]) {
    const canvas = stubCanvas(w * 2, h * 2);
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: w, height: h, right: 10 + w, bottom: 20 + h });
    const v = HQSolidView(canvas);
    v.setTriangles(tris);
    const faces = [];
    v.onFaceSelect(face => faces.push(face));
    const screen = p => { const q = canvas.hqSolidProject(p); return [10 + (q[0] + 1) * w / 2, 20 + (1 - q[1]) * h / 2]; };
    const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps, `${a} ~ ${b} (${w}x${h})`);
    const h0 = canvas.handlers;
    const panDrag = (dx, dy, extra) => {
      h0.pointerdown(ev(1, 150, 120, extra));
      for (let i = 1; i <= 5; i++) h0.pointermove(ev(1, 150 + dx * i / 5, 120 + dy * i / 5, extra));
      h0.pointerup(ev(1, 150 + dx, 120 + dy, extra));
    };
    for (const [yaw, pitch, zoom] of [[-0.72, 0.62, 1], [1.9, -1.2, 3.5], [0.3, 1.4, 0.4]]) {
      Object.assign(v.state, { yaw, pitch, zoom });
      for (const [extra, dx, dy] of [[{ button: 2 }, 37, -12], [{ button: 1 }, -25, 41], [{ button: 0, shiftKey: true }, 18, 9]]) {
        const before = c.map(screen), yawBefore = v.state.yaw, pitchBefore = v.state.pitch;
        panDrag(dx, dy, extra);
        c.forEach((p, i) => near(screen(p), [before[i][0] + dx, before[i][1] + dy]));
        assert.equal(v.state.yaw, yawBefore, "a pan does not orbit");
        assert.equal(v.state.pitch, pitchBefore, "a pan does not tilt");
      }
    }
    // A pan release under 6 px never selects, even over the model; a plain left tap still does.
    const centre = screen([5, 5, 5]);
    for (const extra of [{ button: 2 }, { button: 0, shiftKey: true }]) {
      h0.pointerdown(ev(1, centre[0], centre[1], extra)); h0.pointerup(ev(1, centre[0] + 1, centre[1], extra));
    }
    assert.equal(faces.length, 0, "a pan gesture never selects");
    h0.pointerdown(ev(1, centre[0], centre[1])); h0.pointerup(ev(1, centre[0], centre[1]));
    assert.equal(faces.length, 1, "a plain left tap still selects after panning");
    assert.ok(faces[0], "the tap hits the panned model (picking uses the same projection)");
    // Wheel zoom keeps the model point under the cursor fixed.
    const cursor = screen(c[6]);
    for (const deltaY of [-100, -100, 100]) {
      h0.wheel({ deltaY, clientX: cursor[0], clientY: cursor[1], preventDefault: noop });
      near(screen(c[6]), cursor);
    }
    const zoomBefore = v.state.zoom;
    h0.wheel({ deltaY: -100, clientX: cursor[0], clientY: cursor[1], preventDefault: noop });
    assert.ok(v.state.zoom > zoomBefore, "wheel up still zooms in");
    // Two fingers: moving both by the same amount pans by exactly that amount; spreading zooms around their centre.
    v.reset();
    const t = (id, x, y) => ev(id, x, y, { pointerType: "touch" });
    const before = c.map(screen);
    h0.pointerdown(t(1, 140, 120)); h0.pointerdown(t(2, 200, 120));
    for (let i = 1; i <= 4; i++) { h0.pointermove(t(1, 140 + 8 * i, 120 + 5 * i)); h0.pointermove(t(2, 200 + 8 * i, 120 + 5 * i)); }
    c.forEach((p, i) => near(screen(p), [before[i][0] + 32, before[i][1] + 20], 1e-6));
    // Spread and move: every point keeps its place relative to the fingers (scaled about the centre).
    const c0 = [(172 + 232) / 2, 140], before2 = c.map(screen), z0 = v.state.zoom;
    h0.pointermove(t(2, 262, 150));
    const c1 = [(172 + 262) / 2, 145], k = v.state.zoom / z0;
    assert.ok(k > 1, "pinch out zooms in");
    c.forEach((p, i) => near(screen(p), [c1[0] + k * (before2[i][0] - c0[0]), c1[1] + k * (before2[i][1] - c0[1])], 1e-6));
    // Lifting one finger: the other must neither orbit nor select.
    const yaw = v.state.yaw;
    h0.pointerup(t(1, 172, 140)); h0.pointermove(t(2, 300, 160)); h0.pointerup(t(2, 300, 160));
    assert.equal(v.state.yaw, yaw, "the finger left after a pinch does not orbit");
    assert.equal(faces.length, 1, "nor select");
    // Recentrer (reset) clears the pan.
    v.reset();
    assert.deepEqual([v.state.panX, v.state.panY, v.state.zoom], [0, 0, 1]);
  }
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
