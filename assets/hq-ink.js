/* Transfert HQ — one ink look for a hand-drawn stroke, shared by the iPad pad (hq-desk.js) and the PC canvas
 * (hq-dessiner.js), so a stroke looks the same live, after the pen lifts, and once saved.
 *
 * A stroke is a list of screen points {x, y, w} (w = full width in px). It is drawn as ONE filled outline: a smoothed
 * centre line (Chaikin), widths that change gradually, short tapers at both ends, round caps. One fill per stroke means
 * no beads where widths change, no facets on fast curves, and correct translucency.
 * Pure helpers are exported for Node; nothing here touches the DOM. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.HqInk = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const TAPER_WIDTHS = 2.2; // a taper runs over this many stroke widths
  const TAPER_MIN = 0.3; // the very tip keeps this share of the width

  /** Chaikin corner cutting, `n` rounds; keeps both ends, interpolates widths. */
  function smooth(pts, n) {
    let cur = (pts || []).filter((p) => p && isFinite(p.x) && isFinite(p.y));
    const rounds = n == null ? 2 : n;
    for (let r = 0; r < rounds && cur.length > 2; r++) {
      const out = [cur[0]];
      for (let i = 0; i < cur.length - 1; i++) {
        const a = cur[i], b = cur[i + 1];
        out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, w: a.w * 0.75 + b.w * 0.25 });
        out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, w: a.w * 0.25 + b.w * 0.75 });
      }
      out.push(cur[cur.length - 1]);
      cur = out;
    }
    return cur;
  }

  /** Narrow both ends. Each point's factor depends only on its own width and its distance to each end, so the
   * start of a stroke never changes while the stroke grows (the pad can cache it). `ends` = {start, end}. */
  function taper(pts, ends) {
    const n = (pts || []).length;
    if (n < 2) return (pts || []).slice();
    const e = ends || { start: true, end: true };
    const d = new Array(n);
    d[0] = 0;
    for (let i = 1; i < n; i++) d[i] = d[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const total = d[n - 1];
    return pts.map((p, i) => {
      const len = Math.max(1, (p.w || 1) * TAPER_WIDTHS);
      let f = 1;
      if (e.start !== false) f = Math.min(f, ease(d[i] / len));
      if (e.end !== false) f = Math.min(f, ease((total - d[i]) / len));
      return { x: p.x, y: p.y, w: (p.w || 1) * f };
    });
  }
  function ease(t) {
    const u = Math.max(0, Math.min(1, t));
    return TAPER_MIN + (1 - TAPER_MIN) * u * (2 - u); // ease-out: thin tip, quickly full
  }

  /** Left and right edges of the outline (pure, for tests and drawing). Drops repeated points. */
  function edges(pts) {
    const p = [];
    for (const q of pts || []) {
      const last = p[p.length - 1];
      if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 0.05) p.push(q);
      else if (q.w > last.w) last.w = q.w;
    }
    const n = p.length;
    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      const a = p[Math.max(0, i - 1)], b = p[Math.min(n - 1, i + 1)];
      let tx = b.x - a.x, ty = b.y - a.y;
      const l = Math.hypot(tx, ty) || 1;
      tx /= l; ty /= l;
      const r = Math.max(0.3, (p[i].w || 1) / 2);
      left.push({ x: p[i].x - ty * r, y: p[i].y + tx * r });
      right.push({ x: p[i].x + ty * r, y: p[i].y - tx * r });
    }
    return { pts: p, left, right };
  }

  /** Add the stroke's outline to the current path of `c` (a 2D context or Path2D). */
  function trace(c, pts) {
    const E = edges(pts);
    traceEdges(c, E, 0, E.pts.length - 1);
  }
  /** Outline of E.pts[i0..i1], using edges computed over the whole of E: a piece of a stroke keeps the exact edge
   * directions it has in the whole, so two pieces drawn side by side meet without a jog. */
  function traceEdges(c, E, i0, i1) {
    const P = E.pts;
    if (!P.length) return;
    const a = Math.max(0, Math.min(P.length - 1, i0)), b = Math.max(a, Math.min(P.length - 1, i1));
    const p = P.slice(a, b + 1), L = E.left.slice(a, b + 1), R = E.right.slice(a, b + 1), n = p.length;
    if (n === 1) {
      const r = Math.max(0.3, (p[0].w || 1) / 2);
      c.moveTo(p[0].x + r, p[0].y);
      c.arc(p[0].x, p[0].y, r, 0, Math.PI * 2);
      return;
    }
    const ang = (i, q) => Math.atan2(q.y - p[i].y, q.x - p[i].x);
    c.moveTo(L[0].x, L[0].y);
    for (let i = 1; i < n - 1; i++) c.quadraticCurveTo(L[i].x, L[i].y, (L[i].x + L[i + 1].x) / 2, (L[i].y + L[i + 1].y) / 2);
    c.lineTo(L[n - 1].x, L[n - 1].y);
    c.arc(p[n - 1].x, p[n - 1].y, Math.max(0.3, (p[n - 1].w || 1) / 2), ang(n - 1, L[n - 1]), ang(n - 1, R[n - 1]), true);
    for (let i = n - 2; i > 0; i--) c.quadraticCurveTo(R[i].x, R[i].y, (R[i].x + R[i - 1].x) / 2, (R[i].y + R[i - 1].y) / 2);
    c.lineTo(R[0].x, R[0].y);
    c.arc(p[0].x, p[0].y, Math.max(0.3, (p[0].w || 1) / 2), ang(0, R[0]), ang(0, L[0]), true);
    c.closePath();
  }

  /** The full look: smooth, taper, outline. `opts.ends` limits the tapers (the pad caches a stroke's start). */
  function shape(pts, opts) {
    const o = opts || {};
    return smooth(taper(pts, o.ends), o.rounds);
  }

  /** Fill only pts[from..to] of a longer stroke, smoothed with its neighbours as context: two pieces drawn this way meet
   * without a seam (the pad caches a stroke in pieces). `ends` as in shape(); `start` should only be on for a piece
   * that begins the stroke. */
  function fillRange(c, pts, from, to, opts) {
    const n = (pts || []).length;
    if (!n) return;
    const a = Math.max(0, Math.min(n - 1, from)), b = Math.max(a, Math.min(n - 1, to));
    const lo = Math.max(0, a - 6), hi = Math.min(n - 1, b + 6);
    const o = opts || {};
    const ends = { start: (o.ends ? o.ends.start !== false : true) && lo === 0, end: (o.ends ? o.ends.end !== false : true) && hi === n - 1 };
    const E = edges(shape(pts.slice(lo, hi + 1), { ends: ends, rounds: o.rounds }));
    const sm = E.pts;
    if (!sm.length) return;
    const near = (q) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < sm.length; i++) { const d = Math.hypot(sm[i].x - q.x, sm[i].y - q.y); if (d < bd) { bd = d; best = i; } }
      return best;
    };
    const ia = a === lo ? 0 : near(pts[a]), ib = b === hi ? sm.length - 1 : near(pts[b]);
    c.beginPath();
    traceEdges(c, E, Math.min(ia, ib), Math.max(ia, ib));
    c.fill("nonzero");
  }

  /** Fill one stroke on a 2D context with the current fillStyle. */
  function fill(c, pts, opts) {
    const s = shape(pts, opts);
    if (!s.length) return;
    c.beginPath();
    trace(c, s);
    c.fill("nonzero");
  }

  return { smooth, taper, edges, trace, shape, fill, fillRange, TAPER_WIDTHS, TAPER_MIN };
});
