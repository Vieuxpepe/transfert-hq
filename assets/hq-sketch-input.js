/* Transfert HQ — Dessiner's fluid-input helpers, all pure (Node-tested): typed dimensions while drawing, alignment
 * guides, automatic constraints, the push/pull stretch preview and the face → feature match. Dessiner wires them. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.HqSketchInput = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // ---- numbers typed by hand: "12,5", "100/3", "2*25+4" (no eval)
  function parseNum(text) {
    const s = String(text == null ? "" : text).replace(/\s+/g, "").replace(/,/g, ".");
    if (!s || !/^[-+*/().0-9]+$/.test(s)) return null;
    let i = 0;
    const peek = () => s[i];
    function num() {
      if (peek() === "(") { i++; const v = expr(); if (peek() !== ")") throw new Error("paren"); i++; return v; }
      if (peek() === "-") { i++; return -num(); }
      if (peek() === "+") { i++; return num(); }
      const m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(i));
      if (!m) throw new Error("num");
      i += m[0].length;
      return parseFloat(m[0]);
    }
    function term() { let v = num(); while (peek() === "*" || peek() === "/") { const op = s[i++]; const w = num(); v = op === "*" ? v * w : v / w; } return v; }
    function expr() { let v = term(); while (peek() === "+" || peek() === "-") { const op = s[i++]; const w = term(); v = op === "+" ? v + w : v - w; } return v; }
    try { const v = expr(); return i === s.length && isFinite(v) ? v : null; } catch (_) { return null; }
  }

  // ---- typed dimensions while drawing
  const FIELDS = {
    line: [{ key: "len", label: "L" }, { key: "ang", label: "∠" }],
    centerline: [{ key: "len", label: "L" }, { key: "ang", label: "∠" }],
    rect: [{ key: "w", label: "l" }, { key: "h", label: "h" }],
    circle: [{ key: "r", label: "R" }],
  };
  function fieldsFor(kind) { return (FIELDS[kind] || []).map((f) => Object.assign({ text: "" }, f)); }
  /** The shape the typed values describe. Missing values keep what the pointer shows; signs follow the drag. */
  function typedShape(kind, a, b, fields) {
    const v = {};
    for (const f of fields || []) { const n = parseNum(f.text); if (n != null) v[f.key] = n; }
    const dx = (b ? b.x : a.x) - a.x, dy = (b ? b.y : a.y) - a.y;
    if (kind === "line" || kind === "centerline") {
      const L = v.len != null ? Math.abs(v.len) : Math.hypot(dx, dy);
      const ang = v.ang != null ? v.ang * Math.PI / 180 : Math.atan2(dy, dx);
      return { b: { x: round(a.x + L * Math.cos(ang)), y: round(a.y + L * Math.sin(ang)) } };
    }
    if (kind === "rect") {
      const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
      const w = v.w != null ? Math.abs(v.w) : Math.abs(dx), h = v.h != null ? Math.abs(v.h) : Math.abs(dy);
      return { b: { x: round(a.x + sx * w), y: round(a.y + sy * h) } };
    }
    if (kind === "circle") {
      const r = v.r != null ? Math.abs(v.r) : Math.hypot(dx, dy);
      return { r: round(r) };
    }
    return {};
  }
  const round = (x) => Math.round(x * 1e6) / 1e6;

  // ---- alignment guides: line up with another point's X or Y
  /** points [{x, y}]; m the pointer (model units). Returns {x, y, gx, gy} — gx / gy the aligned coordinate, or null. */
  function alignSnap(points, m, tol, skip) {
    let bx = null, by = null, dxBest = tol, dyBest = tol;
    for (const p of points || []) {
      if (skip && skip(p)) continue;
      const ex = Math.abs(p.x - m.x), ey = Math.abs(p.y - m.y);
      if (ex <= dxBest && ey > tol) { dxBest = ex; bx = p.x; }
      if (ey <= dyBest && ex > tol) { dyBest = ey; by = p.y; }
    }
    return { x: bx != null ? bx : m.x, y: by != null ? by : m.y, gx: bx, gy: by };
  }

  // ---- automatic constraints for what was just drawn
  /** lines: [{id, a:{x,y}, b:{x,y}}] — horizontal / vertical when exactly so (angle snap, typed angle, rectangle). */
  function autoRules(lines) {
    const out = [];
    for (const l of lines || []) {
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, L = Math.hypot(dx, dy);
      if (L <= 0) continue;
      if (Math.abs(dy) <= 1e-9 * Math.max(1, L)) out.push({ type: "horizontal", line: l.id });
      else if (Math.abs(dx) <= 1e-9 * Math.max(1, L)) out.push({ type: "vertical", line: l.id });
    }
    return out;
  }

  // ---- push / pull: stretch the shown part along a face normal (instant preview, the server confirms after)
  function stretch(tris, normal, level, delta, tol) {
    const t = tol == null ? 1e-6 : tol;
    const [nx, ny, nz] = normal;
    return tris.map((tri) => tri.map((p) => {
      const d = p[0] * nx + p[1] * ny + p[2] * nz;
      return d >= level - t ? [p[0] + nx * delta, p[1] + ny * delta, p[2] + nz * delta] : p;
    }));
  }

  // ---- which extrusion ends on this face?
  const PLANES = { XY: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], XZ: [[1, 0, 0], [0, 0, 1], [0, -1, 0]], YZ: [[0, 1, 0], [0, 0, 1], [1, 0, 0]] };
  function frameOf(doc, sid) {
    const sk = (doc.sketches || []).find((x) => x.id === sid);
    const [u, v, n] = PLANES[sk ? sk.plane : "XY"];
    const off = sk ? sk.offset || 0 : 0;
    return { o: [n[0] * off, n[1] * off, n[2] * off], u, v, n };
  }
  /** The extrude feature (base or boss) whose end cap lies on `plane` {origin, normal}: its id, depth, cap normal
   * and level — so its height can be pushed or pulled from the 3D view. Null when none. */
  function capFeature(doc, plane, tol) {
    const sketchOf = (ids) => { const o = (doc.objects || []).find((x) => x.id === ids[0]); return (o && o.sketch) || ""; };
    const n = plane.normal, o = plane.origin;
    const scale = Math.max(1, Math.abs(o[0]) + Math.abs(o[1]) + Math.abs(o[2]));
    const t = tol == null ? 1e-6 * scale : tol;
    const feats = doc.features || [];
    for (let i = feats.length - 1; i >= 0; i--) {
      const f = feats[i];
      if (f.type !== "extrude" || f.suppressed || f.both || !(f.profile || []).length) continue;
      if (doc.rollback != null && i >= doc.rollback) continue;
      const fr = frameOf(doc, sketchOf(f.profile));
      const dir = f.reverse ? -1 : 1;
      const cn = [fr.n[0] * dir, fr.n[1] * dir, fr.n[2] * dir];
      if (cn[0] * n[0] + cn[1] * n[1] + cn[2] * n[2] < 0.9999) continue;
      const cap = [fr.o[0] + cn[0] * f.depth, fr.o[1] + cn[1] * f.depth, fr.o[2] + cn[2] * f.depth];
      const level = cap[0] * cn[0] + cap[1] * cn[1] + cap[2] * cn[2];
      const faceLevel = o[0] * cn[0] + o[1] * cn[1] + o[2] * cn[2];
      if (Math.abs(level - faceLevel) <= t) return { id: f.id, index: i, depth: f.depth, normal: cn, level: level, op: f.op || "add" };
    }
    return null;
  }

  return { parseNum, fieldsFor, typedShape, alignSnap, autoRules, stretch, capFeature, frameOf };
});
