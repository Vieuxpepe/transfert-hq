/* Transfert HQ — hold-to-snap recogniser (pad + PC). Pure: points in, {kind, params} out.
 *
 * Points are normalised to the visible canvas (x / width, y / height, y down). Pass the canvas
 * aspect (width / height) so a circle on a wide sheet is judged in isotropic units. Params come
 * back in the same normalised space; a circle radius is a fraction of the width.
 * Line: max distance to the chord < 4 % of its length. Circle: closed, radius CV < 0.12.
 * Rectangle: closed, four corners near 90° and edges near the axes (the sketch model has no rotated rect).
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.HqShapeSnap = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const r4 = (v) => Math.round(v * 10000) / 10000;
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    if (l2 < 1e-12) return dist(p, a);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  function decimate(pts, eps) {
    const n = pts.length;
    if (n < 3) return pts.map((p) => p.slice());
    const keep = new Array(n).fill(false);
    keep[0] = keep[n - 1] = true;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const pair = stack.pop(), i0 = pair[0], i1 = pair[1];
      let best = -1, idx = -1;
      for (let i = i0 + 1; i < i1; i++) {
        const dd = segDist(pts[i], pts[i0], pts[i1]);
        if (dd > best) { best = dd; idx = i; }
      }
      if (idx >= 0 && best > eps) { keep[idx] = true; stack.push([i0, idx], [idx, i1]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function turn(a, b, c) {
    const ux = a[0] - b[0], uy = a[1] - b[1], vx = c[0] - b[0], vy = c[1] - b[1];
    const nu = Math.hypot(ux, uy), nv = Math.hypot(vx, vy);
    if (nu < 1e-9 || nv < 1e-9) return 0;
    const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (nu * nv)));
    return Math.acos(cos) * 180 / Math.PI;
  }

  function axisOff(a, b) {
    const deg = Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI) % 90;
    return Math.min(deg, 90 - deg);
  }

  function recognise(pts, aspect) {
    if (!Array.isArray(pts) || pts.length < 2) return null;
    const clean = [];
    for (const p of pts) {
      if (!Array.isArray(p) || !isFinite(p[0]) || !isFinite(p[1])) continue;
      clean.push([p[0], p[1]]);
    }
    if (clean.length < 2) return null;
    const ar = aspect > 0 && isFinite(aspect) ? aspect : 1;
    const iso = clean.map((p) => [p[0], p[1] / ar]);
    const back = (p) => [r4(p[0]), r4(p[1] * ar)];
    const a = iso[0], b = iso[iso.length - 1];
    const chord = dist(a, b);
    let path = 0;
    for (let i = 1; i < iso.length; i++) path += dist(iso[i - 1], iso[i]);
    if (!(path > 1e-4)) return null;

    if (chord > 0.02) {
      let maxDev = 0;
      for (const p of iso) maxDev = Math.max(maxDev, segDist(p, a, b));
      if (maxDev < 0.04 * chord) {
        const p0 = clean[0], p1 = clean[clean.length - 1];
        return { kind: "line", params: { a: [r4(p0[0]), r4(p0[1])], b: [r4(p1[0]), r4(p1[1])] } };
      }
    }

    const closed = chord < Math.max(0.025, 0.12 * path);
    if (!closed || clean.length < 8) return null;

    let cx = 0, cy = 0;
    for (const p of iso) { cx += p[0]; cy += p[1]; }
    cx /= iso.length; cy /= iso.length;
    const rs = iso.map((p) => dist(p, [cx, cy]));
    const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
    if (mean > 0.02) {
      const variance = rs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / rs.length;
      const cv = Math.sqrt(variance) / mean;
      if (cv < 0.12 && path > Math.PI * mean) {
        return { kind: "circle", params: { c: back([cx, cy]), r: r4(mean) } };
      }
    }

    let box = 0;
    for (const p of iso) box = Math.max(box, dist(p, a));
    const corners = decimate(iso, Math.max(0.012, box * 0.04));
    let cs = corners.slice();
    if (cs.length >= 2 && dist(cs[0], cs[cs.length - 1]) < 0.03) cs.pop();
    if (cs.length === 5) {
      let flat = 0, ang = -1;
      for (let i = 0; i < cs.length; i++) {
        const deg = turn(cs[(i + 4) % 5], cs[i], cs[(i + 1) % 5]);
        if (deg > ang) { ang = deg; flat = i; }
      }
      if (ang >= 150) cs = cs.filter((_, i) => i !== flat);
    }
    if (cs.length !== 4) return null;
    for (let i = 0; i < 4; i++) {
      const deg = turn(cs[(i + 3) % 4], cs[i], cs[(i + 1) % 4]);
      if (Math.abs(deg - 90) > 18) return null;
      if (axisOff(cs[i], cs[(i + 1) % 4]) > 15) return null;
    }
    const xs = cs.map((p) => p[0]), ys = cs.map((p) => p[1]);
    return { kind: "rect", params: { a: back([Math.min.apply(null, xs), Math.min.apply(null, ys)]), b: back([Math.max.apply(null, xs), Math.max.apply(null, ys)]) } };
  }

  return { recognise };
});
