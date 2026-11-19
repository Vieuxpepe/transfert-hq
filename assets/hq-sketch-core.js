/* Transfert HQ « Dessiner » — pure sketch model + geometry. No DOM, no network.
 * Model space is Y-up, in real-world units (doc.units). Screen conversion lives
 * in toScreen/toModel only. Every mutating helper works on a copy and returns
 * { ok, doc } or { ok:false, error } so the UI can refuse visibly.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.HQSketch = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";
  const FORMAT = "transfert-hq-sketch";
  const VERSION = 2;
  const SOLID_V5_VERSION = 5; // revolve base, holes, shell, patterns (built by hq_solid_ops on the server)
  const HOLE_STANDARDS = ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8"]; // mirrors hq_solid_ops.HOLES_MM
  const HOLE_FITS = { clearance: "Passage", countersunk: "Fraisé", insert: "Insert à chaud", tap: "Taraudage" };
  const V5_TYPES = ["revolve", "hole", "shell", "pattern"];
  const STROKE_WIDTH_VERSION = 4; // a stroke may carry w (model units) + k (per-point factors); older versions stay readable
  const DRAFT_KEY = "tf_hq_sketch_draft_v1";
  const UNIT_MM = { mm: 1, cm: 10, m: 1000, in: 25.4 };
  const LINE_TYPES = { line: 1, centerline: 1 };
  const EPS = 1e-9;
  // Phase 3 underlay (mirror of hq_drawings.py): ONE Carnet Stage-06 asset id + the word "contain", nothing else. Placement is a
  // permanent contract: uniform scale into the square of UNDERLAY_BOX_MM millimetres centred on the origin; no x / y / scale / crop.
  const UNDERLAY_BOX_MM = 1000;
  const UNDERLAY_ASSET_RE = /^asset-[0-9a-f]{24}$/;
  function checkUnderlay(u, version) {
    if (version < 3 || !u || typeof u !== "object" || Array.isArray(u) || Object.keys(u).sort().join(",") !== "asset_id,fit") return null;
    return typeof u.asset_id === "string" && UNDERLAY_ASSET_RE.test(u.asset_id) && u.fit === "contain" ? { asset_id: u.asset_id, fit: "contain" } : null;
  }
  /** Document-space rectangle of an underlay image of w x h pixels, or null. */
  function underlayRect(units, w, h) {
    if (!UNIT_MM[units] || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return null;
    const k = (UNDERLAY_BOX_MM / UNIT_MM[units]) / Math.max(w, h);
    return { x0: -w * k / 2, y0: -h * k / 2, x1: w * k / 2, y1: h * k / 2 };
  }
  const LIMITS = { points: 20000, objects: 5000, constraints: 2000, strokePts: 4000, text: 500, coord: 1e6 };

  function clone(doc) { return JSON.parse(JSON.stringify(doc)); }
  function round6(v) { return Math.round(v * 1e6) / 1e6; }

  function createDoc(opts) {
    const o = opts || {};
    const units = UNIT_MM[o.units] ? o.units : "mm";
    return {
      format: FORMAT, version: VERSION, units: units, mode: o.mode === "construction" ? "construction" : "quick",
      grid: { spacing: Number(o.spacing) > 0 ? Number(o.spacing) : (units === "mm" ? 10 : units === "cm" ? 1 : units === "m" ? 0.01 : 0.5), visible: true, snap: true },
      snap: { angle: true, angleStep: 15 },
      nextId: 1, points: [], objects: [], constraints: [], features: [],
    };
  }

  function newId(doc, prefix) {
    const used = new Set();
    doc.points.forEach(p => used.add(p.id));
    doc.objects.forEach(p => used.add(p.id));
    doc.constraints.forEach(p => used.add(p.id));
    (doc.features || []).forEach(p => used.add(p.id));
    (doc.faceFeatures || []).forEach(p => used.add(p.id));
    (doc.roundFeatures || []).forEach(p => used.add(p.id));
    let n = Math.max(1, Number(doc.nextId) || 1);
    while (used.has(prefix + n)) n++;
    doc.nextId = n + 1;
    return prefix + n;
  }

  function pointMap(doc) { const m = new Map(); doc.points.forEach(p => m.set(p.id, p)); return m; }
  function getObj(doc, id) { return doc.objects.find(o => o.id === id) || null; }
  function isLine(o) { return !!o && !!LINE_TYPES[o.type]; }
  function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

  function addPoint(doc, x, y) {
    const id = newId(doc, "p");
    doc.points.push({ id: id, x: round6(x), y: round6(y) });
    return id;
  }

  function findPointNear(doc, x, y, tol) {
    let best = null, bd = tol;
    for (const p of doc.points) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bd) { bd = d; best = p.id; }
    }
    return best;
  }

  // a / b: { id } (existing point) or { x, y }
  function ensurePoint(doc, spec) {
    if (spec && spec.id && pointMap(doc).has(spec.id)) return spec.id;
    return addPoint(doc, spec.x, spec.y);
  }

  function addLine(doc, a, b, type) {
    const p1 = ensurePoint(doc, a), p2 = ensurePoint(doc, b);
    if (p1 === p2) return null;
    const pm = pointMap(doc);
    if (dist(pm.get(p1), pm.get(p2)) < EPS) return null;
    const id = newId(doc, type === "centerline" ? "a" : "l");
    doc.objects.push({ id: id, type: type === "centerline" ? "centerline" : "line", p1: p1, p2: p2 });
    return id;
  }

  function addRect(doc, a, b) {
    if (Math.abs(a.x - b.x) < EPS || Math.abs(a.y - b.y) < EPS) return null;
    const g = newId(doc, "g");
    const c = [ensurePoint(doc, a), addPoint(doc, b.x, a.y), ensurePoint(doc, b), addPoint(doc, a.x, b.y)];
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const id = newId(doc, "l");
      doc.objects.push({ id: id, type: "line", p1: c[i], p2: c[(i + 1) % 4], group: g });
      ids.push(id);
    }
    return { group: g, lines: ids, points: c };
  }

  function addCircle(doc, c, r) {
    if (!(r > EPS)) return null;
    const center = ensurePoint(doc, c);
    const id = newId(doc, "c");
    doc.objects.push({ id: id, type: "circle", center: center, r: round6(r) });
    return id;
  }

  function addStroke(doc, pts, tol, width) {
    if (!pts || !pts.length) return null;
    const tagged = pts.map((p, i) => [p[0], p[1], i]);
    const wk = width && Array.isArray(width.k) && width.k.length === pts.length ? width.k : null;
    // with per-point widths, a point that only changes the width is kept too: otherwise the pressure a pen gave a
    // straight run would vanish when the stroke is saved
    let kept = tol > 0 ? (wk ? simplifyWidth(tagged, tol, wk, 0.08) : simplify(tagged, tol)) : tagged;
    if (kept.length > LIMITS.strokePts) kept = simplify(tagged, (tol || 0.01) * 4).slice(0, LIMITS.strokePts);
    const arr = kept.map(p => [round6(p[0]), round6(p[1])]);
    if (!arr.length) return null;
    const id = newId(doc, "s");
    const obj = { id: id, type: "stroke", pts: arr };
    const ink = width && typeof width.color === "string" ? width.color : "";
    if (/^#[0-9a-fA-F]{6}$/.test(ink)) obj.color = ink.toLowerCase(); // annotation ink, optional (theme ink when absent)
    const base = typeof width === "number" ? width : width && width.w;
    if (base > 0 && base <= LIMITS.coord) {
      obj.w = round6(base);
      const ks = width && Array.isArray(width.k) ? width.k : null;
      if (ks && ks.length === pts.length) {
        const picked = kept.map(p => {
          const v = Number(ks[p[2]]);
          return Math.round(Math.min(4, Math.max(0.05, isFinite(v) && v > 0 ? v : 1)) * 100) / 100;
        });
        if (picked.some(v => v !== 1)) obj.k = picked;
      }
      doc.version = Math.max(Number(doc.version) || 1, STROKE_WIDTH_VERSION);
    }
    doc.objects.push(obj);
    return id;
  }

  /** Screen pixels for one sample of a stroke. Missing w keeps the historical 2 px hairline. */
  function strokePx(w, k, ppu) {
    const base = w > 0 && ppu > 0 ? w * ppu : 2;
    const f = k > 0 ? k : 1;
    return base * f;
  }

  function addText(doc, x, y, text, h) {
    const t = String(text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, LIMITS.text);
    if (!t) return null;
    const id = newId(doc, "t");
    doc.objects.push({ id: id, type: "text", x: round6(x), y: round6(y), text: t, h: round6(h > 0 ? h : doc.grid.spacing * 0.5) });
    return id;
  }

  function addDimLinear(doc, a, b, offset, label) {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < EPS) return null;
    const id = newId(doc, "d");
    doc.objects.push({ id: id, type: "dim_linear", a: [round6(a[0]), round6(a[1])], b: [round6(b[0]), round6(b[1])],
      offset: round6(offset || 0), label: String(label == null ? "" : label).slice(0, LIMITS.text) });
    return id;
  }

  function addDimAngle(doc, c, a, b, r, label) {
    const id = newId(doc, "d");
    doc.objects.push({ id: id, type: "dim_angle", c: [round6(c[0]), round6(c[1])], a: [round6(a[0]), round6(a[1])],
      b: [round6(b[0]), round6(b[1])], r: round6(r > 0 ? r : doc.grid.spacing * 2), label: String(label == null ? "" : label).slice(0, LIMITS.text) });
    return id;
  }

  /** Ø / R dimension on a circle or an arc: one leader, a real value, an optional reference flag and tolerance text. */
  function addDimRadial(doc, item, type, ang, label) {
    const it = getObj(doc, item);
    if (!it || (it.type !== "circle" && it.type !== "arc")) return null;
    const id = newId(doc, "d");
    doc.objects.push({ id: id, type: type === "radius" ? "dim_radius" : "dim_diameter", item: item,
      ang: round6(isFinite(Number(ang)) ? Number(ang) : 0.6), label: String(label == null ? "" : label).slice(0, LIMITS.text),
      ref: false, tol: "" });
    return id;
  }
  function addDimDiameter(doc, item, ang, label) { return addDimRadial(doc, item, "diameter", ang, label); }
  function addDimRadius(doc, item, ang, label) { return addDimRadial(doc, item, "radius", ang, label); }
  const isRadialDim = o => !!o && (o.type === "dim_diameter" || o.type === "dim_radius");

  /** Centre, radius, leader direction and measured value of a Ø/R dimension; null when its item is gone. */
  function dimRadialGeom(doc, o) {
    if (!isRadialDim(o)) return null;
    const it = getObj(doc, o.item);
    if (!it) return null;
    const pm = pointMap(doc);
    let c = null, r = 0;
    if (it.type === "circle") { const q = pm.get(it.center); if (!q) return null; c = [q.x, q.y]; r = it.r; }
    else if (it.type === "arc") { const g = arcGeom(it, pm); c = [g.c.x, g.c.y]; r = g.r; }
    else return null;
    if (!(r > EPS) || !c) return null;
    const a = isFinite(o.ang) ? o.ang : 0.6;
    const dir = [Math.cos(a), Math.sin(a)];
    const edge = [c[0] + dir[0] * r, c[1] + dir[1] * r];
    const far = o.type === "dim_diameter" ? [c[0] - dir[0] * r, c[1] - dir[1] * r] : c;
    return { c: c, r: r, edge: edge, far: far, dir: dir, value: o.type === "dim_diameter" ? 2 * r : r };
  }
  /** What the drawing shows for a Ø/R dimension: ⌀/R + value, tolerance, and parentheses for a reference cote. */
  function dimRadialLabel(doc, o) {
    const g = dimRadialGeom(doc, o);
    if (!g) return "—";
    const body = (o.label && String(o.label).trim()) || ((o.type === "dim_diameter" ? "⌀" : "R") + fmt(g.value));
    const txt = body + (o.tol ? " " + String(o.tol) : "");
    return o.ref ? "(" + txt + ")" : txt;
  }

  function measureLinear(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
  function measureAngle(c, a, b) {
    const v1x = a[0] - c[0], v1y = a[1] - c[1], v2x = b[0] - c[0], v2y = b[1] - c[1];
    const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (n < EPS) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / n))) * 180 / Math.PI;
  }

  // ---------------------------------------------------------------- topology
  function linesAtPoint(doc, pid) { return doc.objects.filter(o => isLine(o) && (o.p1 === pid || o.p2 === pid)); }
  function otherEnd(line, pid) { return line.p1 === pid ? line.p2 : line.p1; }
  function sharedVertex(doc, l1, l2) {
    const a = getObj(doc, l1), b = getObj(doc, l2);
    if (!isLine(a) || !isLine(b)) return null;
    for (const p of [a.p1, a.p2]) if (p === b.p1 || p === b.p2) return p;
    return null;
  }
  function lineLength(doc, id) {
    const l = getObj(doc, id); if (!isLine(l)) return NaN;
    const pm = pointMap(doc); return dist(pm.get(l.p1), pm.get(l.p2));
  }
  function angleBetween(doc, l1, l2) {
    const v = sharedVertex(doc, l1, l2); if (!v) return null;
    const pm = pointMap(doc), a = getObj(doc, l1), b = getObj(doc, l2);
    const P = pm.get(v), A = pm.get(otherEnd(a, v)), B = pm.get(otherEnd(b, v));
    return { vertex: v, deg: measureAngle([P.x, P.y], [A.x, A.y], [B.x, B.y]) };
  }

  // points reachable from start through line-like objects, never traversing `excludeLine`
  function component(doc, start, excludeLine) {
    const seen = new Set([start]); const q = [start];
    while (q.length) {
      const p = q.pop();
      for (const l of linesAtPoint(doc, p)) {
        if (l.id === excludeLine) continue;
        const o = otherEnd(l, p);
        if (!seen.has(o)) { seen.add(o); q.push(o); }
      }
    }
    return seen;
  }

  function checkConstraints(doc) {
    const bad = [];
    for (const k of doc.constraints) {
      if (k.type === "length") {
        const L = lineLength(doc, k.line);
        if (!(Math.abs(L - k.value) <= 1e-6 * Math.max(1, k.value))) bad.push(k.id);
      } else if (k.type === "angle") {
        const a = angleBetween(doc, k.lines[0], k.lines[1]);
        if (!a || a.vertex !== k.vertex || Math.abs(a.deg - k.value) > 1e-4) bad.push(k.id);
      }
    }
    return bad;
  }

  function describeConstraint(doc, id) {
    const k = doc.constraints.find(c => c.id === id);
    if (!k) return id;
    // every type: a refused transform can break a horizontal / radius / fixed constraint too, and the message must name it
    if (k.type === "length") return "longueur " + k.line + " = " + fmt(k.value) + " " + doc.units;
    if (k.type === "angle") return "angle " + (k.lines || []).join("/") + " = " + fmt(k.value) + "°";
    if (k.type === "radius") return "rayon " + k.item + " = " + fmt(k.value);
    if (k.type === "fixed") return "point fixe " + k.point;
    if (k.type === "concentric") return "concentriques " + (k.items || []).join("/");
    if (k.type === "symmetric") return "symétrie " + (k.points || []).join("/") + " / " + k.line;
    if (k.type === "midpoint") return "milieu " + k.point + " / " + k.line;
    if (k.type === "collinear") return "colinéaires " + (k.items || []).join("/");
    if (k.type === "point_on_curve") return "point sur " + k.item;
    return k.type + " " + (k.line || k.item || (k.items || []).join("/"));
  }

  function refuseIfBroken(d, what) {
    const bad = checkConstraints(d).concat((Number(d.version) || 1) >= SKETCH_VERSION ? geometricResiduals(d).filter(id => !d.constraints.some(k => k.id === id && (k.type === "length" || k.type === "angle"))) : []);
    if (bad.length) return { ok: false, error: what + " refusé : casserait " + bad.map(id => describeConstraint(d, id)).join(", ") };
    return { ok: true, doc: d };
  }

  function upsertConstraint(d, match, fresh) {
    const i = d.constraints.findIndex(match);
    if (i >= 0) { fresh.id = d.constraints[i].id; d.constraints[i] = fresh; }
    else { fresh.id = newId(d, "k"); d.constraints.push(fresh); }
  }

  // ---------------------------------------------------------------- driving edits
  function setLineLength(doc, lineId, fixedPid, length) {
    const L = Number(length);
    if (!(L > 0) || !isFinite(L) || L > LIMITS.coord) return { ok: false, error: "Longueur invalide" };
    const d = clone(doc);
    const line = getObj(d, lineId);
    if (!isLine(line)) return { ok: false, error: "Sélectionne une ligne" };
    if (fixedPid !== line.p1 && fixedPid !== line.p2) return { ok: false, error: "Extrémité fixe invalide" };
    const moving = otherEnd(line, fixedPid);
    const pm = pointMap(d), A = pm.get(fixedPid), B = pm.get(moving);
    const cur = dist(A, B);
    if (cur < EPS) return { ok: false, error: "Ligne de longueur nulle" };
    const ux = (B.x - A.x) / cur, uy = (B.y - A.y) / cur;
    const dx = A.x + ux * L - B.x, dy = A.y + uy * L - B.y;
    if (Math.hypot(dx, dy) > EPS) {
      const comp = component(d, moving, lineId);
      let S;
      let stretched = [];
      if (!comp.has(fixedPid)) {
        S = comp; // open chain: translate everything attached to the moving end rigidly
      } else {
        // closed loop: move only what must move; lines parallel to the edit direction may stretch
        S = new Set([moving]); const q = [moving];
        const dn = Math.hypot(dx, dy), ex = dx / dn, ey = dy / dn;
        while (q.length) {
          const p = q.pop();
          for (const m of linesAtPoint(d, p)) {
            if (m.id === lineId) continue;
            const o = otherEnd(m, p);
            if (S.has(o)) continue;
            const P1 = pm.get(m.p1), P2 = pm.get(m.p2);
            const ml = dist(P1, P2);
            const cross = ml < EPS ? 1 : Math.abs(((P2.x - P1.x) * ey - (P2.y - P1.y) * ex) / ml);
            if (cross < 1e-9) { stretched.push(m); continue; }
            if (o === fixedPid) return { ok: false, error: "Géométrie connectée non résoluble : la cote déformerait le contour. Détache ou supprime une ligne d'abord." };
            S.add(o); q.push(o);
          }
        }
        stretched = stretched.filter(m => !(S.has(m.p1) && S.has(m.p2)));
      }
      const before = new Map(stretched.map(m => [m.id, [pm.get(m.p1).x, pm.get(m.p1).y, pm.get(m.p2).x, pm.get(m.p2).y]]));
      S.forEach(pid => { const p = pm.get(pid); p.x += dx; p.y += dy; });
      for (const m of stretched) {
        const o = before.get(m.id), P1 = pm.get(m.p1), P2 = pm.get(m.p2);
        const ox = o[2] - o[0], oy = o[3] - o[1], nx = P2.x - P1.x, ny = P2.y - P1.y;
        if (Math.hypot(nx, ny) < 1e-6 || ox * nx + oy * ny <= 0) return { ok: false, error: "Refusé : la ligne connectée " + m.id + " s'inverserait ou disparaîtrait" };
      }
      // snap the moving point exactly (rounding) to keep the constraint exact
      const Bn = pm.get(moving); Bn.x = A.x + ux * L; Bn.y = A.y + uy * L;
    }
    upsertConstraint(d, k => k.type === "length" && k.line === lineId, { type: "length", line: lineId, fixed: fixedPid, value: round6(L) });
    return refuseIfBroken(d, "Cote de longueur");
  }

  function setAngle(doc, movingLine, refLine, deg) {
    const D = Number(deg);
    if (!(D > 0 && D < 180) || !isFinite(D)) return { ok: false, error: "Angle invalide (0 < angle < 180)" };
    const d = clone(doc);
    const mv = getObj(d, movingLine), rf = getObj(d, refLine);
    if (!isLine(mv) || !isLine(rf) || movingLine === refLine) return { ok: false, error: "Sélectionne deux lignes" };
    const v = sharedVertex(d, movingLine, refLine);
    if (!v) return { ok: false, error: "Les deux lignes doivent partager une extrémité" };
    const pm = pointMap(d), P = pm.get(v), R = pm.get(otherEnd(rf, v)), Qid = otherEnd(mv, v), Q = pm.get(Qid);
    const rx = R.x - P.x, ry = R.y - P.y, mx = Q.x - P.x, my = Q.y - P.y;
    const rl = Math.hypot(rx, ry), ml = Math.hypot(mx, my);
    if (rl < EPS || ml < EPS) return { ok: false, error: "Ligne de longueur nulle" };
    const cross = rx * my - ry * mx;
    const sign = cross < -EPS * rl * ml ? -1 : 1;
    const target = Math.atan2(ry, rx) + sign * D * Math.PI / 180;
    const theta = target - Math.atan2(my, mx);
    const comp = component(d, Qid, movingLine);
    if (comp.has(v)) return { ok: false, error: "Refusé : la ligne fait partie d'un contour fermé, la pivoter déformerait la géométrie connectée." };
    const c = Math.cos(theta), s = Math.sin(theta);
    comp.forEach(pid => {
      const p = pm.get(pid), x = p.x - P.x, y = p.y - P.y;
      p.x = P.x + x * c - y * s; p.y = P.y + x * s + y * c;
    });
    Q.x = P.x + Math.cos(target) * ml; Q.y = P.y + Math.sin(target) * ml;
    const pair = [refLine, movingLine];
    upsertConstraint(d, k => k.type === "angle" && k.vertex === v && k.lines.includes(refLine) && k.lines.includes(movingLine),
      { type: "angle", lines: pair, vertex: v, value: round6(D) });
    return refuseIfBroken(d, "Cote d'angle");
  }

  function removeConstraint(doc, id) {
    const d = clone(doc); d.constraints = d.constraints.filter(k => k.id !== id); return d;
  }

  // ---------------------------------------------------------------- edit
  function moveObjects(doc, ids, dx, dy) {
    const d = clone(doc), pm = pointMap(d), set = new Set(ids), pts = new Set();
    for (const o of d.objects) {
      if (!set.has(o.id)) continue;
      if (isLine(o)) { pts.add(o.p1); pts.add(o.p2); }
      else if (o.type === "circle") pts.add(o.center);
      else if (o.type === "arc") { pts.add(o.center); pts.add(o.p1); pts.add(o.p2); }
      else if (o.type === "stroke") o.pts = o.pts.map(p => [round6(p[0] + dx), round6(p[1] + dy)]);
      else if (o.type === "text") { o.x = round6(o.x + dx); o.y = round6(o.y + dy); }
      else if (o.type === "dim_linear") { o.a = [o.a[0] + dx, o.a[1] + dy]; o.b = [o.b[0] + dx, o.b[1] + dy]; }
      else if (o.type === "dim_angle") { for (const k of ["c", "a", "b"]) o[k] = [o[k][0] + dx, o[k][1] + dy]; }
    }
    pts.forEach(pid => { const p = pm.get(pid); p.x = p.x + dx; p.y = p.y + dy; });
    return settle(d, [...pts].map(pid => ({ pid: pid, x: pm.get(pid).x, y: pm.get(pid).y })), "Déplacement");
  }

  function movePoint(doc, pid, x, y) {
    const d = clone(doc), p = pointMap(d).get(pid);
    if (!p) return { ok: false, error: "Point introuvable" };
    p.x = x; p.y = y;
    for (const l of linesAtPoint(d, pid)) {
      const pm = pointMap(d);
      if (dist(pm.get(l.p1), pm.get(l.p2)) < 1e-9) return { ok: false, error: "Refusé : la ligne " + l.id + " deviendrait nulle" };
    }
    return settle(d, [{ pid: pid, x: x, y: y }], "Déplacement");
  }

  function deleteObjects(doc, ids) {
    const d = clone(doc), set = new Set(ids);
    d.objects = d.objects.filter(o => !set.has(o.id));
    const alive = new Set(d.objects.map(o => o.id));
    d.constraints = d.constraints.filter(k => {
      if (k.type === "fixed") return true;
      const refs = [k.line, k.item].concat(k.lines || [], k.items || []).filter(Boolean);
      return refs.every(r => alive.has(r));
    });
    const used = new Set();
    d.objects.forEach(o => {
      if (isLine(o)) { used.add(o.p1); used.add(o.p2); }
      else if (o.type === "circle") used.add(o.center);
      else if (o.type === "arc") { used.add(o.center); used.add(o.p1); used.add(o.p2); }
    });
    d.points = d.points.filter(p => used.has(p.id));
    d.constraints = d.constraints.filter(k => k.type !== "fixed" || used.has(k.point));
    const refsOf = f => [].concat(f.profile || [], f.path || [], f.at || [], f.axis ? [f.axis] : [], ...(f.profiles || []));
    const kept = [];
    for (const f of d.features || []) {
      if (refsOf(f).some(id => set.has(id))) continue;
      if (f.type === "pattern" && !kept.some(x => x.id === f.source)) continue;
      kept.push(f);
    }
    d.features = kept;
    if (!d.features.length || !["extrude", "revolve", "sweep", "loft"].includes(d.features[0].type) || d.features[0].op === "cut") { d.features = []; d.faceFeatures = []; d.roundFeatures = []; }
    if (d.rollback != null && d.rollback >= d.features.length) delete d.rollback;
    return d;
  }

  function addFeature(doc, type, profile, depth, extent) {
    const d = clone(doc), features = d.features || [];
    if (type !== "extrude" && type !== "cut") return { ok: false, error: "Fonction 3D inconnue" };
    if ((type === "extrude") !== (features.length === 0)) return { ok: false, error: "Crée d'abord une extrusion de base" };
    const known = new Map(d.objects.map(o => [o.id, o]));
    const issue = profileIssue(profile, id => known.get(id), true);
    if (issue) return { ok: false, error: issue };
    if (profile.some(id => { const o = known.get(id); return o.type === "arc" || o.type === "ellipse" || o.type === "spline"; })) toV6(d);
    const dep = Number(depth), ext = type === "cut" && extent === "throughAll" ? "throughAll" : "blind";
    if (!isFinite(dep) || dep < 0 || (ext === "blind" && dep <= 0) || dep > LIMITS.coord) return { ok: false, error: "Profondeur invalide" };
    d.version = Math.max(d.version, VERSION);
    d.features = features;
    d.features.push({ id: newId(d, "f"), type, profile: profile.slice(), depth: round6(dep), extent: ext });
    return { ok: true, doc: d };
  }

  /** v5 steps: a revolve base, then holes, a shell, repetitions. Returns {ok, doc} or {ok:false, error}. */
  /** A sketch drawn on a part's face: matter grows outward, a pocket goes into the part. Returns whether the extrusion
   * must be reversed along the sketch normal, or null when its sketch is not on a face (the direction stays the user's). */
  function faceReverse(d, f) {
    const o0 = getObj(d, (f.profile || [])[0]), sk = o0 && (d.sketches || []).find(x => x.id === sketchOf(o0));
    if (!sk || !sk.face) return null;
    return f.op === "cut" ? sk.face > 0 : sk.face < 0;
  }
  function addSolidStep(doc, step) {
    const d = clone(doc), features = d.features || [];
    const s = step || {};
    let f;
    const v6Step = V6_FEATURES.includes(s.type) || s.type === "boss" || (s.type === "revolve" && features.length) || (s.op && s.op !== "add");
    if (s.type === "revolve") {
      if (features.length && !v6Step) return { ok: false, error: "La révolution est une fonction de base : retire d'abord la pièce" };
      f = { type: "revolve", profile: (s.profile || []).slice(), axis: s.axis, angle: Number(s.angle) || 360 };
      if (features.length) f.op = s.op === "cut" ? "cut" : "add";
    } else if (!features.length && !["sweep", "loft"].includes(s.type)) return { ok: false, error: "Crée d'abord une pièce de base" };
    else if (s.type === "hole") f = { type: "hole", at: (s.at || []).slice(), standard: s.standard, fit: s.fit, extent: s.extent || "throughAll", depth: Number(s.depth) || 0 };
    else if (s.type === "shell") f = { type: "shell", thickness: Number(s.thickness), open: s.open !== false };
    else if (s.type === "fillet" || s.type === "chamfer") {
      f = { type: s.type, edges: (s.edges || []).map(e => ({ a: e.a.slice(), b: e.b.slice(), m: e.m.slice() })) };
      f[s.type === "fillet" ? "radius" : "distance"] = Number(s.type === "fillet" ? s.radius : s.distance);
    } else if (s.type === "sweep") f = { type: "sweep", profile: (s.profile || []).slice(), path: (s.path || []).slice(), op: s.op === "cut" ? "cut" : "add" };
    else if (s.type === "loft") f = { type: "loft", profiles: (s.profiles || []).map(p => p.slice()), op: s.op === "cut" ? "cut" : "add" };
    else if (s.type === "boss") {
      f = { type: "extrude", profile: (s.profile || []).slice(), depth: Number(s.depth), extent: "blind", op: s.op === "cut" ? "cut" : "add" };
      if (faceReverse(d, f)) f.reverse = true;
    }
    else if (s.type === "pattern") {
      f = { type: "pattern", source: s.source, mode: s.mode, count: Math.round(Number(s.count)) };
      if (s.mode === "linear") { f.dx = Number(s.dx) || 0; f.dy = Number(s.dy) || 0; }
      else { f.cx = Number(s.cx) || 0; f.cy = Number(s.cy) || 0; f.angle = Number(s.angle) || 360; }
    }
    if (!f) return { ok: false, error: "Fonction 3D inconnue" };
    f.id = newId(d, "f");
    d.version = Math.max(Number(d.version) || 1, SOLID_V5_VERSION);
    if (v6Step || (d.sketches || []).length || d.objects.some(o => o.type === "arc")) toV6(d);
    d.features = features.concat([f]);
    const v = validateDoc(d);
    return v.ok ? { ok: true, doc: d, id: f.id } : { ok: false, error: v.error };
  }

  const EDITABLE = {
    extrude: ["depth"], cut: ["depth", "extent"], revolve: ["angle"],
    hole: ["standard", "fit", "extent", "depth"], shell: ["thickness", "open"],
    pattern: ["count", "dx", "dy", "cx", "cy", "angle"],
    fillet: ["radius"], chamfer: ["distance"], sweep: ["op"], loft: ["op"],
  };
  const EDITABLE_V6 = ["suppressed", "reverse", "both", "op"];
  /** Change a feature's numbers in place (« change a number, the part updates »). Validated; the caller rebuilds. */
  function updateFeature(doc, id, patch) {
    const d = clone(doc);
    const f = (d.features || []).find(x => x.id === id);
    if (!f) return { ok: false, error: "Fonction introuvable" };
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === "name") {
        if (v != null && typeof v !== "string") return { ok: false, error: "Nom invalide" };
        const nm = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 40);
        if (nm) f.name = nm; else delete f.name;
        continue;
      }
      if (k === "driven") {
        if (v == null) { delete f.driven; continue; }
        if (typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "Valeur pilotée invalide" };
        const map = {};
        for (const [field, ex] of Object.entries(v)) {
          if (!DRIVABLE.includes(field) || !(EDITABLE[f.type] || []).includes(field)) return { ok: false, error: "Champ non pilotable" };
          const e = cleanExpr(ex);
          if (!e) return { ok: false, error: "Expression vide" };
          map[field] = e;
        }
        if (Object.keys(map).length) { toV6(d); f.driven = map; } else delete f.driven;
        continue;
      }
      const v6key = EDITABLE_V6.includes(k);
      if (!(EDITABLE[f.type] || []).includes(k) && !v6key) return { ok: false, error: "Valeur non modifiable" };
      if (v6key) {
        toV6(d);
        if (k === "op") { if (d.features[0].id === f.id) return { ok: false, error: "La pièce de base ajoute de la matière" }; f.op = v === "cut" ? "cut" : "add"; const rev = faceReverse(d, f); if (rev === true) f.reverse = true; else if (rev === false) delete f.reverse; }
        else if (v) f[k] = true; else delete f[k];
        continue;
      }
      f[k] = ["standard", "fit", "extent"].includes(k) ? v : k === "open" ? !!v : k === "count" ? Math.round(Number(v)) : Number(v);
    }
    if (f.depth != null) f.depth = round6(f.depth);
    const v = validateDoc(d);
    return v.ok ? { ok: true, doc: d } : { ok: false, error: v.error };
  }

  function setCircleRadius(doc, id, r) {
    const R = Number(r);
    if (!(R > 0) || !isFinite(R) || R > LIMITS.coord) return { ok: false, error: "Rayon invalide" };
    const d = clone(doc), o = getObj(d, id);
    if (!o || o.type !== "circle") return { ok: false, error: "Cercle introuvable" };
    o.r = round6(R);
    return { ok: true, doc: d };
  }

  function removeFeature(doc, id) {
    const d = clone(doc), at = (d.features || []).findIndex(f => f.id === id);
    if (at < 0) return { ok: false, error: "Fonction introuvable" };
    d.features = at === 0 ? [] : d.features.filter(f => f.id !== id && !(f.type === "pattern" && f.source === id));
    if (at === 0) { d.faceFeatures = []; d.roundFeatures = []; }
    return { ok: true, doc: d };
  }

  function addFaceFeature(doc, type, plane, profile, depth, extent) {
    const d = clone(doc);
    if (!(d.features || []).length) return { ok: false, error: "Crée d'abord une extrusion de base" };
    if (!["extrude", "cut"].includes(type) || !Array.isArray(profile) || profile.length < 3 || profile.length > 500 ||
        profile.some(p => !Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v) || Math.abs(v) > LIMITS.coord)))
      return { ok: false, error: "Contour de face invalide" };
    if (!plane || ["origin", "u", "v", "normal"].some(k => !Array.isArray(plane[k]) || plane[k].length !== 3 || plane[k].some(v => !Number.isFinite(v))))
      return { ok: false, error: "Plan de face invalide" };
    const dep = Number(depth), ext = type === "cut" && extent === "throughAll" ? "throughAll" : "blind";
    if (!(dep > 0 && dep <= LIMITS.coord)) return { ok: false, error: "Profondeur invalide" };
    d.version = Math.max(d.version || 1, 3); // never downgrade: a version-4 drawing may hold stroke widths
    d.faceFeatures = d.faceFeatures || [];
    if (d.faceFeatures.length >= 50) return { ok: false, error: "Trop de fonctions sur face" };
    d.faceFeatures.push({ id: newId(d, "ff"), type, extent: ext, depth: round6(dep),
      plane: clone(plane), profile: profile.map(p => p.map(round6)) });
    return { ok: true, doc: d };
  }

  function removeFaceFeature(doc, id) {
    const d = clone(doc), count = (d.faceFeatures || []).length;
    d.faceFeatures = (d.faceFeatures || []).filter(f => f.id !== id);
    return count === d.faceFeatures.length ? { ok: false, error: "Fonction introuvable" } : { ok: true, doc: d };
  }

  function addRoundFeature(doc, a, b, radius) {
    const d = clone(doc), r = Number(radius);
    if (!(d.features || []).length) return { ok: false, error: "Crée d'abord une pièce 3D" };
    if (![a, b].every(p => Array.isArray(p) && p.length === 3 && p.every(v => Number.isFinite(v) && Math.abs(v) <= LIMITS.coord)) ||
        !(r > 1e-6 && r <= LIMITS.coord)) return { ok: false, error: "Arête ou rayon invalide" };
    d.version = Math.max(d.version || 1, 3); // never downgrade: a version-4 drawing may hold stroke widths
    d.roundFeatures = d.roundFeatures || [];
    if (d.roundFeatures.length >= 50) return { ok: false, error: "Trop d'arrondis" };
    d.roundFeatures.push({ id: newId(d, "rf"), a: a.map(round6), b: b.map(round6), radius: round6(r) });
    return { ok: true, doc: d };
  }

  function removeRoundFeature(doc, id) {
    const d = clone(doc), count = (d.roundFeatures || []).length;
    d.roundFeatures = (d.roundFeatures || []).filter(f => f.id !== id);
    return count === d.roundFeatures.length ? { ok: false, error: "Arrondi introuvable" } : { ok: true, doc: d };
  }

  function updateObject(doc, id, patch) {
    const d = clone(doc), o = getObj(d, id);
    if (!o) return { ok: false, error: "Objet introuvable" };
    if ("text" in patch && o.type === "text") {
      const t = String(patch.text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, LIMITS.text);
      if (!t) return { ok: false, error: "Texte vide" };
      o.text = t;
    }
    if ("label" in patch && (o.type === "dim_linear" || o.type === "dim_angle" || isRadialDim(o))) o.label = String(patch.label || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, LIMITS.text);
    if (isRadialDim(o)) {
      // a fabrication cote: which way the leader points, whether it is a reference cote, and its tolerance text
      if ("ang" in patch && isFinite(Number(patch.ang))) o.ang = Number(patch.ang);
      if ("ref" in patch) o.ref = patch.ref === true || patch.ref === "true" || patch.ref === 1 || patch.ref === "1";
      if ("tol" in patch) o.tol = String(patch.tol == null ? "" : patch.tol).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 24);
    }
    if ("h" in patch && o.type === "text" && Number(patch.h) > 0) o.h = round6(Number(patch.h));
    if ("offset" in patch && o.type === "dim_linear" && isFinite(Number(patch.offset))) o.offset = round6(Number(patch.offset));
    if ("r" in patch && o.type === "circle") {
      if (!(Number(patch.r) > 0)) return { ok: false, error: "Rayon invalide" };
      o.r = round6(Number(patch.r));
    }
    return { ok: true, doc: d };
  }

  // ---------------------------------------------------------------- hit testing
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function textBox(o) { const w = Math.max(1, o.text.length) * o.h * 0.6; return [o.x, o.y - o.h * 0.25, o.x + w, o.y + o.h]; }

  function objectDistance(doc, o, x, y, pm) {
    pm = pm || pointMap(doc);
    // an object whose references are gone is nowhere near the pointer (it stays selectable for « Réparer » by id, not by click)
    if (isLine(o)) { const a = pm.get(o.p1), b = pm.get(o.p2); return a && b ? segDist(x, y, a.x, a.y, b.x, b.y) : Infinity; }
    if (o.type === "circle") { const c = pm.get(o.center); return c ? Math.abs(Math.hypot(x - c.x, y - c.y) - o.r) : Infinity; }
    if (o.type === "arc") return arcDistance(o, pm, x, y);
    if (o.type === "ellipse") {
      const c = pm.get(o.center); if (!c) return Infinity;
      const q = Math.hypot((x - c.x) / o.rx, (y - c.y) / o.ry);
      return Math.abs(q - 1) * Math.min(o.rx, o.ry);
    }
    if (o.type === "spline") {
      if (!Array.isArray(o.pts) || o.pts.length < 2) return Infinity;
      let m = Infinity;
      for (let i = 1; i < o.pts.length; i++) { const a = pm.get(o.pts[i - 1]), b = pm.get(o.pts[i]); if (a && b) m = Math.min(m, segDist(x, y, a.x, a.y, b.x, b.y)); }
      return m;
    }
    if (o.type === "stroke") {
      if (o.pts.length === 1) return Math.hypot(x - o.pts[0][0], y - o.pts[0][1]);
      let m = Infinity;
      for (let i = 1; i < o.pts.length; i++) m = Math.min(m, segDist(x, y, o.pts[i - 1][0], o.pts[i - 1][1], o.pts[i][0], o.pts[i][1]));
      return m;
    }
    if (o.type === "text") { const b = textBox(o); return Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3])); }
    if (o.type === "dim_linear") {
      const g = dimLinearGeom(o); if (!g) return Infinity;
      return Math.min(segDist(x, y, g.a2[0], g.a2[1], g.b2[0], g.b2[1]), Math.hypot(x - g.mid[0], y - g.mid[1]));
    }
    if (o.type === "dim_angle") {
      const r = Math.hypot(x - o.c[0], y - o.c[1]);
      return Math.abs(r - o.r);
    }
    if (isRadialDim(o)) {
      const g = dimRadialGeom(doc, o); if (!g) return Infinity;
      return Math.min(segDist(x, y, g.far[0], g.far[1], g.edge[0], g.edge[1]), Math.hypot(x - g.edge[0], y - g.edge[1]));
    }
    return Infinity;
  }

  const HIT_ORDER = { text: 0, dim_linear: 1, dim_angle: 1, line: 2, centerline: 2, circle: 3, arc: 3, ellipse: 3, spline: 3, stroke: 4 };
  function hitTest(doc, x, y, tol) {
    const pm = pointMap(doc);
    let best = null;
    for (let i = doc.objects.length - 1; i >= 0; i--) {
      const o = doc.objects[i];
      const dd = objectDistance(doc, o, x, y, pm);
      if (dd > tol) continue;
      const score = [HIT_ORDER[o.type], dd];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) best = { id: o.id, score: score };
    }
    return best ? best.id : null;
  }

  function hitAll(doc, x, y, tol) {
    const pm = pointMap(doc);
    return doc.objects.filter(o => objectDistance(doc, o, x, y, pm) <= tol).map(o => o.id);
  }

  /** Model-space bounding box of one object; null when its references are gone. Never throws. */
  function objectBox(doc, o, pm) {
    if (!o) return null;
    pm = pm || pointMap(doc);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const put = (x, y) => { if (!isFinite(x) || !isFinite(y)) return; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
    if (isLine(o)) { const a = pm.get(o.p1), b = pm.get(o.p2); if (!a || !b) return null; put(a.x, a.y); put(b.x, b.y); }
    else if (o.type === "circle") { const c = pm.get(o.center); if (!c || !(o.r > 0)) return null; put(c.x - o.r, c.y - o.r); put(c.x + o.r, c.y + o.r); }
    else if (o.type === "arc") {
      if (!pm.get(o.center) || !pm.get(o.p1) || !pm.get(o.p2)) return null;
      const g = arcGeom(o, pm); if (!g || !(g.r > 0)) return null; put(g.c.x - g.r, g.c.y - g.r); put(g.c.x + g.r, g.c.y + g.r);
    }
    else if (o.type === "ellipse") { const c = pm.get(o.center); if (!c || !(o.rx > 0) || !(o.ry > 0)) return null; put(c.x - o.rx, c.y - o.ry); put(c.x + o.rx, c.y + o.ry); }
    else if (o.type === "spline") { if (!Array.isArray(o.pts) || o.pts.length < 2) return null; for (const pid of o.pts) { const p = pm.get(pid); if (!p) return null; put(p.x, p.y); } }
    else if (o.type === "stroke") { if (!Array.isArray(o.pts) || !o.pts.length) return null; for (const p of o.pts) put(p[0], p[1]); }
    else if (o.type === "text") { const b = textBox(o); put(b[0], b[1]); put(b[2], b[3]); }
    else if (o.type === "dim_linear") { const g = dimLinearGeom(o); if (!g) return null; put(o.a[0], o.a[1]); put(o.b[0], o.b[1]); put(g.a2[0], g.a2[1]); put(g.b2[0], g.b2[1]); }
    else if (o.type === "dim_angle") { put(o.c[0] - o.r, o.c[1] - o.r); put(o.c[0] + o.r, o.c[1] + o.r); }
    else if (isRadialDim(o)) { const g = dimRadialGeom(doc, o); if (!g) return null; put(g.c[0] - g.r, g.c[1] - g.r); put(g.c[0] + g.r, g.c[1] + g.r); put(g.edge[0], g.edge[1]); }
    else return null;
    return isFinite(x0) ? [x0, y0, x1, y1] : null;
  }

  /** Uniform grid (model units) of object ids by bounding box, so a pointer move only tests what is nearby.
   * Objects too large for the grid (a long pen stroke) go into a spill list tested every time. */
  function buildHitIndex(doc, cell) {
    const size = cell > 0 ? cell : 10;
    const pm = pointMap(doc), cells = new Map(), order = new Map();
    const put = (key, id) => { const a = cells.get(key); if (a) a.push(id); else cells.set(key, [id]); };
    for (let i = 0; i < doc.objects.length; i++) {
      const o = doc.objects[i], b = objectBox(doc, o, pm);
      order.set(o.id, i);
      if (!b) continue;
      const gx0 = Math.floor(b[0] / size), gx1 = Math.floor(b[2] / size);
      const gy0 = Math.floor(b[1] / size), gy1 = Math.floor(b[3] / size);
      if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 400) { put("*", o.id); continue; }
      for (let x = gx0; x <= gx1; x++) for (let y = gy0; y <= gy1; y++) put(x + "," + y, o.id);
    }
    return { size: size, cells: cells, order: order };
  }
  function indexCandidates(index, x, y, tol) {
    const out = new Set(index.cells.get("*") || []);
    const t = Math.max(0, Number(tol) || 0), s = index.size;
    const gx0 = Math.floor((x - t) / s), gx1 = Math.floor((x + t) / s);
    const gy0 = Math.floor((y - t) / s), gy1 = Math.floor((y + t) / s);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const a = index.cells.get(gx + "," + gy);
      if (a) for (const id of a) out.add(id);
    }
    return out;
  }
  /** Same answer as hitTest (nearest in HIT_ORDER, last object wins a tie) but only over the grid's candidates. */
  function hitTestIndexed(doc, index, x, y, tol) {
    if (!index || !index.cells) return hitTest(doc, x, y, tol);
    const pm = pointMap(doc), cand = indexCandidates(index, x, y, tol);
    let best = null;
    for (const o of doc.objects) {
      if (!cand.has(o.id)) continue;
      const dd = objectDistance(doc, o, x, y, pm);
      if (dd > tol) continue;
      const score = [HIT_ORDER[o.type], dd], ord = index.order.get(o.id) || 0;
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1]) ||
          (score[0] === best.score[0] && score[1] === best.score[1] && ord > best.ord)) best = { id: o.id, score: score, ord: ord };
    }
    return best ? best.id : null;
  }
  function hitAllIndexed(doc, index, x, y, tol) {
    if (!index || !index.cells) return hitAll(doc, x, y, tol);
    const pm = pointMap(doc), cand = indexCandidates(index, x, y, tol);
    return doc.objects.filter(o => cand.has(o.id) && objectDistance(doc, o, x, y, pm) <= tol).map(o => o.id);
  }

  /** A 500-object redraw at 1440×900 stays under 6 ms of JS on the reference machine (median and p95 over 90 frames). */
  const DRAW_BUDGET = { objects: 500, ms: 6 };
  /** True while a frame's p95 fits the budget. Above `objects` the budget does not apply: p95 is then informational. */
  function budgetOk(stats, objects, budget) {
    const b = budget || DRAW_BUDGET;
    if (!stats || !stats.n) return true;
    if (Number(objects) > b.objects) return true;
    return stats.p95 <= b.ms;
  }

  /** Median / p95 / max of a frame-time ring buffer, in ms. Pure: the budget check can run in Node. */
  function perfStats(samples) {
    const a = (samples || []).filter(v => typeof v === "number" && isFinite(v) && v >= 0).slice().sort((x, y) => x - y);
    if (!a.length) return { n: 0, median: 0, p95: 0, max: 0 };
    const at = q => a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)))];
    return { n: a.length, median: at(0.5), p95: at(0.95), max: a[a.length - 1] };
  }

  function dimLinearGeom(o) {
    const dx = o.b[0] - o.a[0], dy = o.b[1] - o.a[1], L = Math.hypot(dx, dy);
    if (L < EPS) return null;
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const a2 = [o.a[0] + nx * o.offset, o.a[1] + ny * o.offset], b2 = [o.b[0] + nx * o.offset, o.b[1] + ny * o.offset];
    return { L: L, u: [ux, uy], n: [nx, ny], a2: a2, b2: b2, mid: [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2] };
  }

  // ---------------------------------------------------------------- parameters: named values that drive dimensions
  const PARAM_RESERVED = ["__proto__", "constructor", "prototype"];
  const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/;
  const EXPR_CONSTS = { pi: Math.PI };
  const EXPR_FNS = {
    abs: Math.abs, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt, min: Math.min, max: Math.max,
    round: (v, n) => { const k = Math.pow(10, n || 0); return Math.round(v * k) / k; },
    sin: d => Math.sin(d * Math.PI / 180), cos: d => Math.cos(d * Math.PI / 180), tan: d => Math.tan(d * Math.PI / 180),
  };

  /** Tokens of a small arithmetic language: numbers, names, + - * / ^ ( ) , and the functions above. A French decimal
   * comma between two digits reads as a decimal point, so « 12,5 » is 12.5. */
  function tokenizeExpr(src) {
    const text = String(src == null ? "" : src).replace(/(\d),(\d)/g, "$1.$2").trim();
    const out = [];
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t") { i++; continue; }
      if (/[0-9.]/.test(c)) {
        const m = /^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/.exec(text.slice(i));
        if (!m || !m[0]) throw new Error("Nombre invalide");
        out.push({ k: "num", v: Number(m[0]) });
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
        out.push({ k: "name", v: m[0] });
        i += m[0].length;
        continue;
      }
      if ("+-*/^(),".includes(c)) { out.push({ k: c }); i++; continue; }
      throw new Error("Caractère invalide : " + c);
    }
    return out;
  }

  /** Evaluate one expression against a scope of parameter values. `unknown` names the first identifier the scope does
   * not know yet, so the caller can wait for it or report it instead of silently using zero. */
  function evalExpr(src, scope) {
    let toks, pos = 0;
    try { toks = tokenizeExpr(src); } catch (e) { return { ok: false, error: e.message }; }
    if (!toks.length) return { ok: false, error: "Expression vide" };
    const peek = () => toks[pos] || null;
    const eat = k => { const t = peek(); if (!t || t.k !== k) throw new Error("Expression invalide"); pos++; return t; };
    const expr = () => { let v = term(); while (peek() && (peek().k === "+" || peek().k === "-")) { const op = toks[pos++].k; const r = term(); v = op === "+" ? v + r : v - r; } return v; };
    const term = () => { let v = power(); while (peek() && (peek().k === "*" || peek().k === "/")) { const op = toks[pos++].k; const r = power(); if (op === "/" && Math.abs(r) < 1e-12) throw new Error("Division par zéro"); v = op === "*" ? v * r : v / r; } return v; };
    const power = () => { const v = unary(); if (peek() && peek().k === "^") { pos++; return Math.pow(v, power()); } return v; };
    const unary = () => { const t = peek(); if (t && t.k === "-") { pos++; return -unary(); } if (t && t.k === "+") { pos++; return unary(); } return primary(); };
    const primary = () => {
      const t = peek();
      if (!t) throw new Error("Expression incomplète");
      if (t.k === "num") { pos++; return t.v; }
      if (t.k === "(") { pos++; const v = expr(); eat(")"); return v; }
      if (t.k === "name") {
        pos++;
        const name = t.v;
        if (peek() && peek().k === "(") {
          pos++;
          const args = [];
          if (peek() && peek().k !== ")") { args.push(expr()); while (peek() && peek().k === ",") { pos++; args.push(expr()); } }
          eat(")");
          const fn = EXPR_FNS[name];
          if (!fn) throw new Error("Fonction inconnue : " + name);
          return fn.apply(null, args);
        }
        if (name in EXPR_CONSTS) return EXPR_CONSTS[name];
        if (scope && typeof scope[name] === "number" && isFinite(scope[name])) return scope[name];
        const e = new Error("Nom inconnu : " + name);
        e.unknown = name;
        throw e;
      }
      throw new Error("Expression invalide");
    };
    try {
      const value = expr();
      if (peek()) return { ok: false, error: "Expression invalide" };
      if (!isFinite(value)) return { ok: false, error: "Résultat infini" };
      if (Math.abs(value) > LIMITS.coord) return { ok: false, error: "Résultat hors limites" };
      return { ok: true, value: Math.round(value * 1e6) / 1e6 };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e), unknown: e && e.unknown }; }
  }

  function paramList(doc) { return Array.isArray(doc.params) ? doc.params : []; }
  function paramNameOk(name) { return PARAM_NAME.test(String(name || "")) && !PARAM_RESERVED.includes(String(name)); }
  function cleanExpr(v) { return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120); }

  /** Every parameter, evaluated in dependency order. A parameter waiting on another is retried next pass; names that
   * never resolve are reported as a circular dependency rather than valued at zero. */
  function evalParams(doc) {
    const list = paramList(doc), scope = Object.create(null), errors = [], order = [];
    const names = new Set();
    for (const p of list) if (!names.has(p.name)) names.add(p.name);
    const pending = new Map();
    for (const p of list) if (!pending.has(p.id)) pending.set(p.id, p);
    for (let pass = 0; pass <= list.length && pending.size; pass++) {
      let progress = false;
      for (const [id, p] of [...pending]) {
        const r = evalExpr(p.expr, scope);
        if (r.ok) { scope[p.name] = r.value; order.push(p.name); pending.delete(id); progress = true; continue; }
        if (r.unknown && names.has(r.unknown) && pending.size > 1) continue; // it names another pending parameter
        errors.push({ id: id, name: p.name, message: r.error });
        pending.delete(id);
        progress = true;
      }
      if (!progress) break;
    }
    for (const [, p] of pending) errors.push({ id: p.id, name: p.name, message: "dépendance circulaire" });
    return { ok: errors.length === 0, values: Object.assign({}, scope), errors: errors, order: order };
  }

  function addParam(doc, name, expr) {
    const d = clone(doc);
    if (Number(d.version) < SKETCH_VERSION) toV6(d); // a parameter is a version-6 field: the document says so
    d.params = paramList(d).slice();
    const nm = String(name || "").trim();
    if (!paramNameOk(nm)) return { ok: false, error: "Nom invalide : lettres, chiffres, _ (sans espace)" };
    if (d.params.some(p => p.name === nm)) return { ok: false, error: "Ce nom existe déjà" };
    const ex = cleanExpr(expr);
    if (!ex) return { ok: false, error: "Expression vide" };
    const id = newId(d, "v");
    d.params.push({ id: id, name: nm, expr: ex });
    const ev = evalParams(d);
    if (!ev.ok) return { ok: false, error: ev.errors[0].name + " : " + ev.errors[0].message };
    return { ok: true, doc: d, id: id, values: ev.values };
  }

  function updateParam(doc, id, patch) {
    const d = clone(doc);
    const p = paramList(d).find(x => x.id === id) || paramList(d).find(x => x.name === id);
    if (!p) return { ok: false, error: "Paramètre introuvable" };
    if (patch && "name" in patch) {
      const nm = String(patch.name || "").trim();
      if (!paramNameOk(nm)) return { ok: false, error: "Nom invalide" };
      if (paramList(d).some(x => x.id !== p.id && x.name === nm)) return { ok: false, error: "Ce nom existe déjà" };
      p.name = nm;
    }
    if (patch && "expr" in patch) {
      const ex = cleanExpr(patch.expr);
      if (!ex) return { ok: false, error: "Expression vide" };
      p.expr = ex;
    }
    const ev = evalParams(d);
    if (!ev.ok) return { ok: false, error: ev.errors[0].name + " : " + ev.errors[0].message };
    return { ok: true, doc: d, values: ev.values };
  }

  function removeParam(doc, id) {
    const d = clone(doc);
    const before = paramList(d).length;
    d.params = paramList(d).filter(p => p.id !== id && p.name !== id);
    if (d.params.length === before) return { ok: false, error: "Paramètre introuvable" };
    if (!d.params.length) delete d.params;
    const ev = evalParams(d);
    if (!ev.ok) return { ok: false, error: ev.errors[0].name + " : " + ev.errors[0].message };
    return { ok: true, doc: d };
  }

  /** A cote that drives geometry: `expr` is the wanted value, `points` (or `lines` + `vertex`) is what it measures. */
  function dimDrive(o) { return !!o && !!o.drive && typeof o.drive.expr === "string"; }
  function resolveDrive(o, values) {
    if (!dimDrive(o)) return null;
    const r = evalExpr(o.drive.expr, values || {});
    return r.ok && r.value > 0 ? r.value : null;
  }

  function setDimDrive(doc, id, drive) {
    const d = clone(doc);
    const o = getObj(d, id);
    if (!o) return { ok: false, error: "Objet introuvable" };
    if (o.type !== "dim_linear" && o.type !== "dim_angle") return { ok: false, error: "Seules les cotes pilotent la géométrie" };
    if (!drive || drive.off) { delete o.drive; return { ok: true, doc: d } }
    if (Number(d.version) < SKETCH_VERSION) toV6(d);;
    const ex = cleanExpr(drive.expr);
    if (!ex) return { ok: false, error: "Expression vide" };
    const wanted = evalExpr(ex, evalParams(d).values);
    if (!wanted.ok) return { ok: false, error: wanted.error };
    if (!(wanted.value > 0)) return { ok: false, error: "La valeur doit être positive" };
    if (o.type === "dim_linear") {
      const pts = Array.isArray(o.drive && o.drive.points) ? o.drive.points : (Array.isArray(drive.points) ? drive.points : null);
      if (!pts || pts.length !== 2 || pts[0] === pts[1]) return { ok: false, error: "Cette cote ne mesure pas deux points" };
      const pm = pointMap(d);
      if (!pm.get(pts[0]) || !pm.get(pts[1])) return { ok: false, error: "Point introuvable" };
      o.drive = { expr: ex, points: [pts[0], pts[1]] };
      if (drive.keepLabel === true) o.drive.keepLabel = true;
    } else {
      const lines = Array.isArray(o.drive && o.drive.lines) ? o.drive.lines : (Array.isArray(drive.lines) ? drive.lines : null);
      const vertex = (o.drive && o.drive.vertex) || drive.vertex;
      if (!lines || lines.length !== 2 || !vertex) return { ok: false, error: "Cette cote d'angle n'a pas ses deux lignes" };
      const objs = new Set(d.objects.map(x => x.id));
      if (!lines.every(l => objs.has(l)) || !pointMap(d).has(vertex)) return { ok: false, error: "Lignes introuvables" };
      o.drive = { expr: ex, lines: [lines[0], lines[1]], vertex: vertex };
      if (drive.keepLabel === true) o.drive.keepLabel = true;
    }
    return { ok: true, doc: d };
  }
  function clearDimDrive(doc, id) { return setDimDrive(doc, id, null); }

  /** Refresh a driven cote's geometry and label from the live points, so the number shown is the solved one. */
  function syncDrivenDims(doc, values) {
    const pm = pointMap(doc);
    let n = 0;
    const objs = new Map((doc.objects || []).map(x => [x.id, x]));
    for (const o of doc.objects || []) {
      if (!dimDrive(o)) continue;
      const v = resolveDrive(o, values);
      if (!(v > 0)) continue;
      if (o.type === "dim_linear" && Array.isArray(o.drive.points)) {
        const a = pm.get(o.drive.points[0]), b = pm.get(o.drive.points[1]);
        if (!a || !b) continue;
        o.a = [round6(a.x), round6(a.y)];
        o.b = [round6(b.x), round6(b.y)];
        if (!(o.drive.keepLabel && o.label)) o.label = fmt(v);
        n++;
      } else if (o.type === "dim_angle" && Array.isArray(o.drive.lines)) {
        const vtx = pm.get(o.drive.vertex);
        const ends = o.drive.lines.map(lid => {
          const ob = objs.get(lid);
          if (!ob) return null;
          return pm.get(ob.p1 === o.drive.vertex ? ob.p2 : ob.p1);
        });
        if (!vtx || ends.some(x => !x)) continue;
        o.c = [round6(vtx.x), round6(vtx.y)];
        o.a = [round6(ends[0].x), round6(ends[0].y)];
        o.b = [round6(ends[1].x), round6(ends[1].y)];
        if (!(o.drive.keepLabel && o.label)) o.label = fmt(v) + "\u00b0";
        n++;
      }
    }
    return n;
  }

  /** The whole parametric rebuild: evaluate the parameters, turn every driven cote into a temporary constraint, solve
   * once, then refresh those cotes. Returns the new document plus what could not be resolved. */
  function applyParameters(doc, opts) {
    const ev = evalParams(doc);
    const base = clone(doc);
    if (!ev.ok) return { ok: false, error: ev.errors[0].name + " : " + ev.errors[0].message, values: ev.values, errors: ev.errors, doc: base };
    const fv = applyFeatureValues(base, ev.values);
    const d = fv.doc;
    if (!fv.ok) return { ok: false, error: "Fonction " + fv.errors[0].id + " : " + fv.errors[0].message, values: ev.values, errors: ev.errors, doc: base };
    const driven = (d.objects || []).filter(dimDrive);
    if (!driven.length) return { ok: true, doc: d, values: ev.values, errors: [], applied: 0 };
    const extra = [];
    for (const o of driven) {
      const v = resolveDrive(o, ev.values);
      if (!(v > 0)) return { ok: false, error: "Cote " + o.id + " : valeur introuvable", values: ev.values, errors: ev.errors, doc: d };
      if (o.type === "dim_linear") extra.push({ id: "pdrive:" + o.id, type: "distance", a: o.drive.points[0], b: o.drive.points[1], value: v });
      else extra.push({ id: "pdrive:" + o.id, type: "angle", lines: o.drive.lines.slice(), vertex: o.drive.vertex, value: v });
    }
    const solved = solve(Object.assign({}, d, { constraints: (d.constraints || []).concat(extra) }), opts);
    if (!solved.ok) return { ok: false, error: solved.error, values: ev.values, errors: ev.errors, doc: d };
    const out = solved.doc;
    out.constraints = (out.constraints || []).filter(k => !String(k.id).startsWith("pdrive:"));
    syncDrivenDims(out, ev.values);
    const v = validateDoc(out);
    if (!v.ok) return { ok: false, error: v.error, values: ev.values, errors: ev.errors, doc: d };
    return { ok: true, doc: out, values: ev.values, errors: [], applied: extra.length };
  }

  // ---------------------------------------------------------------- snapping
  function snapGrid(p, spacing) {
    return { x: round6(Math.round(p.x / spacing) * spacing), y: round6(Math.round(p.y / spacing) * spacing) };
  }
  function snapAngle(from, to, stepDeg) {
    const dx = to.x - from.x, dy = to.y - from.y, L = Math.hypot(dx, dy);
    if (L < EPS || !(stepDeg > 0)) return { x: to.x, y: to.y };
    const step = stepDeg * Math.PI / 180;
    const a = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: from.x + Math.cos(a) * L, y: from.y + Math.sin(a) * L };
  }
  // angle snap keeps the direction, then grid snap rounds the length to the grid spacing
  function snapSegmentEnd(from, to, opts) {
    let p = { x: to.x, y: to.y };
    if (opts.angle && from) {
      p = snapAngle(from, p, opts.angleStep);
      if (opts.grid) {
        const L = Math.hypot(p.x - from.x, p.y - from.y), Ls = Math.max(opts.spacing, Math.round(L / opts.spacing) * opts.spacing);
        const a = Math.atan2(p.y - from.y, p.x - from.x);
        p = { x: round6(from.x + Math.cos(a) * Ls), y: round6(from.y + Math.sin(a) * Ls) };
      }
      return p;
    }
    if (opts.grid) p = snapGrid(p, opts.spacing);
    return p;
  }

  // ---------------------------------------------------------------- misc
  function simplify(pts, tol) {
    const n = pts.length;
    const pack = p => p.length > 2 && isFinite(p[2]) ? [p[0], p[1], p[2]] : [p[0], p[1]];
    if (n < 3 || !(tol > 0)) return pts.map(pack);
    const keep = new Array(n).fill(false); keep[0] = keep[n - 1] = true;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop();
      const [ax, ay] = pts[i0], [bx, by] = pts[i1];
      let best = -1, idx = -1;
      for (let i = i0 + 1; i < i1; i++) {
        const dd = segDist(pts[i][0], pts[i][1], ax, ay, bx, by);
        if (dd > best) { best = dd; idx = i; }
      }
      if (idx >= 0 && best > tol) { keep[idx] = true; stack.push([i0, idx], [idx, i1]); }
    }
    return pts.filter((_, i) => keep[i]).map(p => p.length > 2 && isFinite(p[2]) ? [p[0], p[1], p[2]] : [p[0], p[1]]);
  }

  /** RDP over position AND width: a point stays when it is off the chord by more than `tol` or its width factor is off
   * the chord's interpolated width by more than `ktol`. Points are [x, y, index]; `ks` is indexed by that index. */
  function simplifyWidth(pts, tol, ks, ktol) {
    const n = pts.length;
    if (n < 3) return pts.map(p => [p[0], p[1], p[2]]);
    const kv = i => { const v = Number(ks[pts[i][2]]); return isFinite(v) && v > 0 ? v : 1; };
    const keep = new Array(n).fill(false); keep[0] = keep[n - 1] = true;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop();
      const [ax, ay] = pts[i0], [bx, by] = pts[i1];
      const k0 = kv(i0), k1 = kv(i1);
      let best = -1, idx = -1;
      for (let i = i0 + 1; i < i1; i++) {
        const t = (i - i0) / (i1 - i0);
        const err = Math.max(segDist(pts[i][0], pts[i][1], ax, ay, bx, by) / tol, Math.abs(kv(i) - (k0 + (k1 - k0) * t)) / ktol);
        if (err > best) { best = err; idx = i; }
      }
      if (idx >= 0 && best > 1) { keep[idx] = true; stack.push([i0, idx], [idx, i1]); }
    }
    return pts.filter((_, i) => keep[i]).map(p => [p[0], p[1], p[2]]);
  }

  function convertUnits(doc, units) {
    if (!UNIT_MM[units]) return { ok: false, error: "Unités inconnues" };
    const d = clone(doc), f = UNIT_MM[doc.units] / UNIT_MM[units];
    const s = v => round6(v * f), sp = p => [s(p[0]), s(p[1])];
    d.units = units;
    d.grid.spacing = s(d.grid.spacing);
    d.points.forEach(p => { p.x = s(p.x); p.y = s(p.y); });
    d.objects.forEach(o => {
      if (o.type === "circle") o.r = s(o.r);
      else if (o.type === "stroke") { o.pts = o.pts.map(sp); if (o.w > 0) o.w = s(o.w); }
      else if (o.type === "text") { o.x = s(o.x); o.y = s(o.y); o.h = s(o.h); }
      else if (o.type === "dim_linear") { o.a = sp(o.a); o.b = sp(o.b); o.offset = s(o.offset); }
      else if (o.type === "dim_angle") { o.c = sp(o.c); o.a = sp(o.a); o.b = sp(o.b); o.r = s(o.r); }
    });
    d.constraints.forEach(k => { if (k.type === "length") k.value = s(k.value); });
    (d.features || []).forEach(f => { f.depth = s(f.depth); });
    (d.faceFeatures || []).forEach(f => { f.depth = s(f.depth); f.profile = f.profile.map(sp); f.plane.origin = f.plane.origin.map(s); });
    (d.roundFeatures || []).forEach(f => { f.a = f.a.map(s); f.b = f.b.map(s); f.radius = s(f.radius); });
    if (d.view) { d.view.x0 = s(d.view.x0); d.view.y0 = s(d.view.y0); d.view.ppu = d.view.ppu / f; }
    return { ok: true, doc: d };
  }

  function fmt(v, digits) {
    const n = Number(v); if (!isFinite(n)) return "—";
    return String(Math.round(n * Math.pow(10, digits == null ? 3 : digits)) / Math.pow(10, digits == null ? 3 : digits));
  }

  function extents(doc) {
    const pm = pointMap(doc); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const o of doc.objects) {
      // a missing point must not make the whole reading crash: « Tout afficher » and the compare view run on a
      // document that may still be broken (that is what « Valider » is for)
      if (isLine(o)) { const a = pm.get(o.p1), b = pm.get(o.p2); if (a && b) { add(a.x, a.y); add(b.x, b.y); } }
      else if (o.type === "circle") { const c = pm.get(o.center); if (c && o.r > 0) { add(c.x - o.r, c.y - o.r); add(c.x + o.r, c.y + o.r); } }
      else if (o.type === "arc") { if (!pm.get(o.center) || !pm.get(o.p1) || !pm.get(o.p2)) continue; const g = arcGeom(o, pm); if (g && g.r > 0) { add(g.c.x - g.r, g.c.y - g.r); add(g.c.x + g.r, g.c.y + g.r); } }
      else if (o.type === "ellipse") { const c = pm.get(o.center); if (c && o.rx > 0 && o.ry > 0) { add(c.x - o.rx, c.y - o.ry); add(c.x + o.rx, c.y + o.ry); } }
      else if (o.type === "spline") (o.pts || []).forEach(pid => { const p = pm.get(pid); if (p) add(p.x, p.y); });
      else if (o.type === "stroke") o.pts.forEach(p => add(p[0], p[1]));
      else if (o.type === "text") { const b = textBox(o); add(b[0], b[1]); add(b[2], b[3]); }
      else if (o.type === "dim_linear") { const g = dimLinearGeom(o); add(o.a[0], o.a[1]); add(o.b[0], o.b[1]); if (g) { add(g.a2[0], g.a2[1]); add(g.b2[0], g.b2[1]); } }
      else if (o.type === "dim_angle") { add(o.c[0] - o.r, o.c[1] - o.r); add(o.c[0] + o.r, o.c[1] + o.r); }
      else if (isRadialDim(o)) { const g = dimRadialGeom(doc, o); if (g) { add(g.c[0] - g.r, g.c[1] - g.r); add(g.c[0] + g.r, g.c[1] + g.r); } }
    }
    return isFinite(x0) ? { x0: x0, y0: y0, x1: x1, y1: y1 } : null;
  }

  // view: { x0, y0, ppu } — model coordinate at the canvas bottom-left, pixels per unit
  function toScreen(view, H, x, y) { return { x: (x - view.x0) * view.ppu, y: H - (y - view.y0) * view.ppu }; }
  function toModel(view, H, sx, sy) { return { x: view.x0 + sx / view.ppu, y: view.y0 + (H - sy) / view.ppu }; }
  function zoomAt(view, H, sx, sy, factor, minPpu, maxPpu) {
    const m = toModel(view, H, sx, sy);
    const ppu = Math.max(minPpu || 1e-4, Math.min(maxPpu || 1e5, view.ppu * factor));
    return { x0: m.x - sx / ppu, y0: m.y - (H - sy) / ppu, ppu: ppu };
  }
  /** Union of the drawing extents and an extra rectangle (the underlay), or whichever exists. */
  function extentsWith(doc, extra) {
    const e = extents(doc);
    if (!extra) return e;
    return e ? { x0: Math.min(e.x0, extra.x0), y0: Math.min(e.y0, extra.y0), x1: Math.max(e.x1, extra.x1), y1: Math.max(e.y1, extra.y1) } : { x0: extra.x0, y0: extra.y0, x1: extra.x1, y1: extra.y1 };
  }
  function fitView(doc, W, H, margin, extra) {
    const e = extentsWith(doc, extra), m = margin == null ? 40 : margin;
    if (!e) return { x0: -doc.grid.spacing * 2, y0: -doc.grid.spacing * 2, ppu: Math.max(0.01, 24 / doc.grid.spacing) };
    const w = Math.max(e.x1 - e.x0, doc.grid.spacing), h = Math.max(e.y1 - e.y0, doc.grid.spacing);
    const ppu = Math.max(1e-4, Math.min((W - 2 * m) / w, (H - 2 * m) / h));
    return { x0: (e.x0 + e.x1) / 2 - W / 2 / ppu, y0: (e.y0 + e.y1) / 2 - H / 2 / ppu, ppu: ppu };
  }

  // Coarse hint only (pointer + touch capability + viewport). Never a device name.
  function sourceHint(env) {
    const e = env || {};
    const small = Math.min(Number(e.width) || 9999, Number(e.height) || 9999) <= 820;
    const touch = Number(e.touchPoints) > 0;
    return ((e.coarse && (small || !e.finePointer)) || (touch && small)) ? "mobile" : "desktop";
  }

  // ---------------------------------------------------------------- v6: sketches on planes, arcs, solver
  const SKETCH_VERSION = 6;
  const SKETCH_PLANES = { XY: "Plan XY (dessus)", XZ: "Plan XZ (face)", YZ: "Plan YZ (côté)" };
  const GEO_CONSTRAINTS = ["horizontal", "vertical", "parallel", "perpendicular", "equal", "tangent", "radius", "fixed",
    "concentric", "symmetric", "midpoint", "collinear", "point_on_curve"];
  const V6_FEATURES = ["fillet", "chamfer", "sweep", "loft"];
  const sketchOf = o => (o && o.sketch) || "";
  const toV6 = d => { d.version = Math.max(Number(d.version) || 1, SKETCH_VERSION); if (!Array.isArray(d.sketches)) d.sketches = []; return d; };

  /** A shallow view of the drawing holding only one sketch's points and objects (same ids): what the 2D editor
   * draws and hit-tests while that sketch is active. Cached per document object. */
  const sketchViews = new WeakMap();
  function inSketch(doc, sid) {
    const key = sid || "";
    let per = sketchViews.get(doc);
    if (!per) { per = new Map(); sketchViews.set(doc, per); }
    if (per.has(key)) return per.get(key);
    if (!key && !(doc.sketches || []).length) { per.set(key, doc); return doc; }
    const view = Object.assign({}, doc, { points: doc.points.filter(p => sketchOf(p) === key), objects: doc.objects.filter(o => sketchOf(o) === key) });
    per.set(key, view);
    return view;
  }
  /** What the 2D editor DRAWS: the active sketch plus every other visible one (a hidden sketch is left out).
   * Hit-testing keeps using inSketch, so only the active sketch stays editable. Cached per document like inSketch. */
  const visibleViews = new WeakMap();
  function visibleView(doc, active) {
    const key0 = active || "";
    const visible = (doc.sketches || []).filter(s => !s.hidden).map(s => s.id);
    const ids = new Set(visible);
    if (!key0 && !ids.size) return inSketch(doc, key0);
    if (key0 && (ids.size === 0 || (ids.size === 1 && ids.has(key0)))) return inSketch(doc, key0);
    const sig = key0 + "|" + visible.slice().sort().join(",") + (key0 ? "" : "|base");
    let per = visibleViews.get(doc);
    if (!per) { per = new Map(); visibleViews.set(doc, per); }
    if (per.has(sig)) return per.get(sig);
    const keep = new Set([key0].concat(visible));
    const view = Object.assign({}, doc, {
      points: doc.points.filter(p => keep.has(sketchOf(p))),
      objects: doc.objects.filter(o => keep.has(sketchOf(o))),
    });
    per.set(sig, view);
    return view;
  }

  /** Run fn(d) and put every point and object it created on sketch sid. */
  function withSketch(d, sid, fn) {
    const pts = new Set(d.points.map(p => p.id)), objs = new Set(d.objects.map(o => o.id));
    const r = fn(d);
    if (sid) {
      toV6(d);
      for (const p of d.points) if (!pts.has(p.id)) p.sketch = sid;
      for (const o of d.objects) if (!objs.has(o.id)) o.sketch = sid;
    }
    return r;
  }
  function addSketch(doc, plane, offset, name, face) {
    if (!SKETCH_PLANES[plane]) return { ok: false, error: "Plan inconnu" };
    const off = Number(offset) || 0;
    if (!isFinite(off) || Math.abs(off) > LIMITS.coord) return { ok: false, error: "Décalage invalide" };
    const d = toV6(clone(doc));
    if (d.sketches.length >= 20) return { ok: false, error: "Trop d'esquisses" };
    const id = newId(d, "sk");
    d.sketches.push({ id: id, name: String(name || "").slice(0, 40) || (plane + (off ? " +" + fmt(off) : "")), plane: plane, offset: round6(off) });
    if (face === 1 || face === -1) d.sketches[d.sketches.length - 1].face = face; // sketch on a part's face: which way is outward
    return { ok: true, doc: d, id: id };
  }

  /** Arc: centre c, from a counter-clockwise to b. b is put back on the circle through a, so the radius is exact. */
  function addArc(doc, c, a, b) {
    const r = Math.hypot(a.x - c.x, a.y - c.y), rb = Math.hypot(b.x - c.x, b.y - c.y);
    if (r < EPS || rb < EPS) return null;
    const bx = c.x + (b.x - c.x) * r / rb, by = c.y + (b.y - c.y) * r / rb;
    if (Math.hypot(bx - a.x, by - a.y) < EPS) return null;
    const cid = ensurePoint(doc, c), aid = ensurePoint(doc, a);
    const bid = b.id && Math.abs(rb - r) < 1e-9 ? b.id : addPoint(doc, bx, by);
    if (new Set([cid, aid, bid]).size !== 3) return null;
    const id = newId(doc, "c");
    doc.objects.push({ id: id, type: "arc", center: cid, p1: aid, p2: bid });
    toV6(doc);
    return id;
  }
  /** A parametric, axis-aligned ellipse: centre point plus two radii (the solver owns the centre and the radii). */
  function addEllipse(doc, c, rx, ry) {
    const a = Math.abs(Number(rx)), b = Math.abs(Number(ry));
    if (!(a > EPS) || !(b > EPS) || a > LIMITS.coord || b > LIMITS.coord) return null;
    const center = ensurePoint(doc, c);
    const id = newId(doc, "e");
    doc.objects.push({ id: id, type: "ellipse", center: center, rx: round6(a), ry: round6(b) });
    toV6(doc);
    return id;
  }
  /** A smooth curve through point references (Catmull-Rom display), so the solver can move every control point. */
  function addSpline(doc, pts, closed) {
    if (!Array.isArray(pts) || pts.length < 2 || (closed && pts.length < 3)) return null;
    const ids = pts.map(p => ensurePoint(doc, p));
    if (new Set(ids).size !== ids.length || ids.length > 500) return null;
    const id = newId(doc, "u");
    doc.objects.push({ id: id, type: "spline", pts: ids, closed: !!closed });
    toV6(doc);
    return id;
  }
  /** A slot: two parallel sides closed by two tangent semicircles. a / b are the end centres, r the radius. */
  function addSlot(doc, a, b, r) {
    const L = Math.hypot(b.x - a.x, b.y - a.y), rad = Math.abs(Number(r));
    if (!(L > EPS) || !(rad > EPS)) return null;
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L, nx = -uy, ny = ux;
    const A = ensurePoint(doc, a), B = ensurePoint(doc, b), pm = pointMap(doc);
    const pa = pm.get(A), pb = pm.get(B);
    const at = (c, sx, sy) => addPoint(doc, c.x + sx * rad, c.y + sy * rad);
    const a1 = at(pa, nx, ny), a2 = at(pa, -nx, -ny), b1 = at(pb, nx, ny), b2 = at(pb, -nx, -ny);
    const g = newId(doc, "g");
    const top = newId(doc, "l"), bottom = newId(doc, "l"), arcB = newId(doc, "c"), arcA = newId(doc, "c");
    doc.objects.push({ id: top, type: "line", p1: a1, p2: b1, group: g });
    doc.objects.push({ id: arcB, type: "arc", center: B, p1: b2, p2: b1, group: g });
    doc.objects.push({ id: bottom, type: "line", p1: b2, p2: a2, group: g });
    doc.objects.push({ id: arcA, type: "arc", center: A, p1: a2, p2: a1, group: g });
    toV6(doc);
    return { group: g, ids: [top, arcB, bottom, arcA], lines: [top, bottom], arcs: [arcA, arcB], points: [a1, a2, b1, b2] };
  }
  /** A regular polygon (3..12 sides) centred on c through the pointer vertex. */
  function addPolygon(doc, c, v, sides) {
    const n = Math.max(3, Math.min(12, Math.round(Number(sides) || 6)));
    const R = Math.hypot(v.x - c.x, v.y - c.y);
    if (!(R > EPS)) return null;
    const a0 = Math.atan2(v.y - c.y, v.x - c.x), g = newId(doc, "g"), ring = [];
    for (let i = 0; i < n; i++) { const t = a0 + i * 2 * Math.PI / n; ring.push(addPoint(doc, c.x + R * Math.cos(t), c.y + R * Math.sin(t))); }
    const ids = [];
    for (let i = 0; i < n; i++) {
      const id = newId(doc, "l");
      doc.objects.push({ id: id, type: "line", p1: ring[i], p2: ring[(i + 1) % n], group: g });
      ids.push(id);
    }
    return { group: g, lines: ids, points: ring };
  }
  /** Construction geometry is reference only: profiles never include it. */
  function setConstruction(doc, ids, on) {
    const d = clone(doc), wanted = new Set(ids || []);
    let changed = 0;
    for (const o of d.objects) if (wanted.has(o.id)) { if (on) o.construction = true; else delete o.construction; changed++; }
    if (!changed) return { ok: false, error: "Aucun objet sélectionné" };
    return { ok: true, doc: d };
  }
  /** A curve that closes on itself: an ellipse, or a spline flagged closed with at least three points. */
  function closedCurve(o) {
    return !!o && (o.type === "ellipse" || (o.type === "spline" && !!o.closed && (o.pts || []).length >= 3));
  }
  /** Objects that may form a 3D profile: construction geometry and annotations never do. */
  function profileObject(o) {
    if (!o || o.construction) return false;
    return LINE_TYPES[o.type] || o.type === "circle" || o.type === "arc" || closedCurve(o);
  }
  /** Why a feature profile would be refused; "" when its parts may form a closed contour. */
  function profileIssue(p, objOf, v6) {
    if (!Array.isArray(p) || !p.length || p.length > 500 || new Set(p).size !== p.length) return "Sélectionne un contour fermé";
    const kinds = v6 ? ["line", "circle", "arc", "ellipse", "spline"] : ["line", "circle"];
    const objs = p.map(objOf);
    if (objs.some(o => !o || !kinds.includes(o.type))) return v6 ? "Seules les lignes, cercles, arcs, ellipses et splines fermées forment un profil" : "Seules les lignes et les cercles forment un profil";
    if (objs.some(o => o.construction)) return "La géométrie de construction ne forme pas un profil";
    if (p.length === 1) {
      const o = objs[0];
      if (o.type === "spline" && !o.closed) return "Une spline ouverte ne forme pas un profil fermé";
      if (o.type === "spline" && (o.pts || []).length < 3) return "Une spline fermée demande au moins trois points";
      if (o.type === "ellipse" && (!(o.rx > 0) || !(o.ry > 0))) return "Ellipse invalide";
    }
    if (p.length > 1 && objs.some(o => o.type === "ellipse" || o.type === "spline")) return "Une ellipse ou une spline fermée forme seule son contour";
    return "";
  }

  // ---------------------------------------------------------------- sketch editing: offset, trim, extend, mirror, convert
  function lineHitParams(a, b, c, d) { // intersection of the infinite line a-b with the segment c-d, as t on a-b
    const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
    const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
    return u >= -1e-9 && u <= 1 + 1e-9 ? t : null;
  }
  function lineCircleParams(a, b, c, r) {
    const dx = b.x - a.x, dy = b.y - a.y, fx = a.x - c.x, fy = a.y - c.y;
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * A * C;
    if (A < 1e-18 || disc < 0) return [];
    const s = Math.sqrt(disc), t1 = (-B - s) / (2 * A), t2 = (-B + s) / (2 * A);
    return t1 === t2 ? [t1] : [t1, t2];
  }
  function onArc(o, pm, p) {
    const g = arcGeom(o, pm); if (!g) return false;
    let t = Math.atan2(p.y - g.c.y, p.x - g.c.x) - g.t0; t = (t % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    return t <= g.sweep + 1e-7;
  }
  /** Where object `id` meets any other line/circle/arc of the sketch. */
  function intersectionsOn(doc, id) {
    const pm = pointMap(doc), o = getObj(doc, id), out = [];
    if (!o) return out;
    const gOf = x => x.type === "circle" ? { c: pm.get(x.center), r: x.r } : arcGeom(x, pm);
    for (const other of doc.objects) {
      if (other.id === id || !(LINE_TYPES[other.type] || other.type === "circle" || other.type === "arc")) continue;
      if (isLine(o)) {
        const a = pm.get(o.p1), b = pm.get(o.p2); if (!a || !b) continue;
        if (isLine(other)) {
          const c = pm.get(other.p1), d = pm.get(other.p2), t = c && d ? lineHitParams(a, b, c, d) : null;
          if (t != null) out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), t: t });
        } else {
          const g = gOf(other); if (!g || !g.c || !(g.r > 0)) continue;
          for (const t of lineCircleParams(a, b, g.c, g.r)) {
            const p = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
            if (other.type === "arc" && !onArc(other, pm, p)) continue;
            out.push({ x: p.x, y: p.y, t: t });
          }
        }
      } else if (o.type === "circle" || o.type === "arc") {
        const G = gOf(o); if (!G || !G.c || !(G.r > 0)) continue;
        if (isLine(other)) {
          const a = pm.get(other.p1), b = pm.get(other.p2); if (!a || !b) continue;
          for (const t of lineCircleParams(a, b, G.c, G.r)) {
            const p = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
            if (o.type === "arc" && !onArc(o, pm, p)) continue;
            out.push(p);
          }
        } else {
          const H = gOf(other); if (!H || !H.c || !(H.r > 0)) continue;
          const dx = H.c.x - G.c.x, dy = H.c.y - G.c.y, dd = Math.hypot(dx, dy);
          if (dd < 1e-12 || dd > G.r + H.r || dd < Math.abs(G.r - H.r)) continue;
          const a = (G.r * G.r - H.r * H.r + dd * dd) / (2 * dd), h = Math.sqrt(Math.max(0, G.r * G.r - a * a));
          const mx = G.c.x + a * dx / dd, my = G.c.y + a * dy / dd;
          for (const p of [{ x: mx + h * dy / dd, y: my - h * dx / dd }, { x: mx - h * dy / dd, y: my + h * dx / dd }]) {
            if (o.type === "arc" && !onArc(o, pm, p)) continue;
            if (other.type === "arc" && !onArc(other, pm, p)) continue;
            out.push(p);
          }
        }
      }
    }
    return out;
  }
  /** Parallel copy of each selected object, at a signed distance (left of a line's direction, outward for arcs). */
  function offsetObjects(doc, ids, dist) {
    const delta = Number(dist), d = clone(doc), pm = pointMap(d), out = [];
    if (!isFinite(delta) || !delta) return { ok: false, error: "Distance d'offset invalide" };
    for (const id of ids || []) {
      const o = getObj(d, id); if (!o) return { ok: false, error: "Objet introuvable" };
      let copy;
      if (isLine(o)) {
        const a = pm.get(o.p1), b = pm.get(o.p2), L = Math.hypot(b.x - a.x, b.y - a.y);
        if (!(L > EPS)) return { ok: false, error: "Ligne dégénérée" };
        const nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
        copy = { id: newId(d, "l"), type: o.type, p1: addPoint(d, a.x + nx * delta, a.y + ny * delta), p2: addPoint(d, b.x + nx * delta, b.y + ny * delta) };
      } else if (o.type === "circle") {
        if (!(o.r + delta > EPS)) return { ok: false, error: "Offset trop grand" };
        copy = { id: newId(d, "c"), type: "circle", center: o.center, r: round6(o.r + delta) };
      } else if (o.type === "arc") {
        const g = arcGeom(o, pm), r2 = g.r + delta;
        if (!(r2 > EPS)) return { ok: false, error: "Offset trop grand" };
        copy = { id: newId(d, "c"), type: "arc", center: o.center,
          p1: addPoint(d, g.c.x + Math.cos(g.t0) * r2, g.c.y + Math.sin(g.t0) * r2),
          p2: addPoint(d, g.c.x + Math.cos(g.t0 + g.sweep) * r2, g.c.y + Math.sin(g.t0 + g.sweep) * r2) };
      } else if (o.type === "ellipse") {
        if (!(o.rx + delta > EPS) || !(o.ry + delta > EPS)) return { ok: false, error: "Offset trop grand" };
        copy = { id: newId(d, "e"), type: "ellipse", center: o.center, rx: round6(o.rx + delta), ry: round6(o.ry + delta) };
      } else return { ok: false, error: "Offset possible sur lignes, cercles, arcs et ellipses" };
      if (o.sketch) copy.sketch = o.sketch;
      if (o.construction) copy.construction = true;
      d.objects.push(copy); out.push(copy.id);
    }
    if (!out.length) return { ok: false, error: "Aucun objet sélectionné" };
    toV6(d); const v = validateDoc(d);
    return v.ok ? { ok: true, doc: d, ids: out } : { ok: false, error: v.error };
  }
  /** Mirror the selected objects about a line/centerline. Arcs flip their endpoints so the mirrored sweep stays exact. */
  function mirrorObjects(doc, ids, axisId) {
    const d = clone(doc), pm = pointMap(d), axis = getObj(d, axisId);
    if (!isLine(axis)) return { ok: false, error: "Sélectionne un axe (ligne ou axe)" };
    const A = pm.get(axis.p1), B = pm.get(axis.p2), dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
    if (!(l2 > EPS)) return { ok: false, error: "Axe dégénéré" };
    const refl = p => { const t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / l2, fx = A.x + t * dx, fy = A.y + t * dy; return { x: 2 * fx - p.x, y: 2 * fy - p.y }; };
    const pt = p => addPoint(d, refl(p).x, refl(p).y), out = [];
    for (const id of ids || []) {
      const o = getObj(d, id);
      if (!o || o.id === axisId) continue;
      let copy;
      if (isLine(o)) copy = { id: newId(d, "l"), type: o.type, p1: pt(pm.get(o.p1)), p2: pt(pm.get(o.p2)) };
      else if (o.type === "circle") copy = { id: newId(d, "c"), type: "circle", center: pt(pm.get(o.center)), r: o.r };
      else if (o.type === "arc") { const g = arcGeom(o, pm); copy = { id: newId(d, "c"), type: "arc", center: pt(g.c), p1: pt(g.b), p2: pt(g.a) }; }
      else if (o.type === "ellipse") {
        if (Math.abs(dx) > 1e-9 && Math.abs(dy) > 1e-9) return { ok: false, error: "Miroir d'une ellipse : axe horizontal ou vertical requis" };
        copy = { id: newId(d, "e"), type: "ellipse", center: pt(pm.get(o.center)), rx: o.rx, ry: o.ry };
      } else if (o.type === "spline") copy = { id: newId(d, "u"), type: "spline", pts: o.pts.map(pid => pt(pm.get(pid))), closed: !!o.closed };
      else continue;
      if (o.sketch) copy.sketch = o.sketch;
      if (o.construction) copy.construction = true;
      d.objects.push(copy); out.push(copy.id);
    }
    if (!out.length) return { ok: false, error: "Rien à mettre en miroir" };
    toV6(d); const v = validateDoc(d);
    return v.ok ? { ok: true, doc: d, ids: out } : { ok: false, error: v.error };
  }
  const TWO_PI = 2 * Math.PI;
  const normAng = a => (a % TWO_PI + TWO_PI) % TWO_PI;
  /** Remove the clicked piece of a line/circle/arc between its neighbouring intersections. */
  function trimObject(doc, id, at) {
    const d = clone(doc), o = getObj(d, id), pm = pointMap(d);
    if (!o) return { ok: false, error: "Objet introuvable" };
    if (!(isLine(o) || o.type === "circle" || o.type === "arc")) return { ok: false, error: "Rognage possible sur lignes, cercles et arcs" };
    const hits = intersectionsOn(d, id);
    if (!hits.length) return { ok: false, error: "Aucune intersection : rien à rogner" };
    if (isLine(o)) {
      const a = pm.get(o.p1), b = pm.get(o.p2), L = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(L > EPS)) return { ok: false, error: "Ligne dégénérée" };
      const t0 = ((at.x - a.x) * (b.x - a.x) + (at.y - a.y) * (b.y - a.y)) / (L * L);
      const ts = [...new Set(hits.map(h => h.t).filter(t => t > 1e-9 && t < 1 - 1e-9))].sort((x, y) => x - y);
      if (!ts.length) return { ok: false, error: "Les intersections sont aux extrémités" };
      const lo = Math.max(0, ...ts.filter(t => t < t0)), hi = Math.min(1, ...ts.filter(t => t > t0));
      if (lo <= 1e-9 && hi >= 1 - 1e-9) return { ok: false, error: "Le clic n'est pas entre deux intersections" };
      const keep = [];
      if (lo > 1e-9) keep.push([a, { x: a.x + (b.x - a.x) * lo, y: a.y + (b.y - a.y) * lo }]);
      if (hi < 1 - 1e-9) keep.push([{ x: a.x + (b.x - a.x) * hi, y: a.y + (b.y - a.y) * hi }, b]);
      if (!keep.length) return { ok: false, error: "Rognage retirerait toute la ligne" };
      d.objects = d.objects.filter(x => x.id !== id);
      d.constraints = (d.constraints || []).filter(k => k.line !== id && k.item !== id && !(k.items || []).includes(id) && !(k.lines || []).includes(id));
      const ids = [];
      for (const [p, q] of keep) {
        if (Math.hypot(q.x - p.x, q.y - p.y) < 1e-9) continue;
        const obj = { id: newId(d, "l"), type: o.type, p1: addPoint(d, p.x, p.y), p2: addPoint(d, q.x, q.y) };
        if (o.sketch) obj.sketch = o.sketch;
        if (o.group) obj.group = o.group;
        if (o.construction) obj.construction = true;
        d.objects.push(obj); ids.push(obj.id);
      }
      toV6(d); const v = validateDoc(d);
      return v.ok ? { ok: true, doc: d, ids: ids } : { ok: false, error: v.error };
    }
    const g = o.type === "circle" ? { c: pm.get(o.center), r: o.r, t0: 0, sweep: TWO_PI } : arcGeom(o, pm);
    if (!g || !g.c || !(g.r > 0)) return { ok: false, error: "Arc dégénéré" };
    const click = normAng(Math.atan2(at.y - g.c.y, at.x - g.c.x));
    const angs = hits.map(h => normAng(Math.atan2(h.y - g.c.y, h.x - g.c.x))).sort((x, y) => x - y);
    const uniq = angs.filter((a, i) => i === 0 || Math.abs(a - angs[i - 1]) > 1e-9);
    if (uniq.length < 2) return { ok: false, error: "Deux intersections sont nécessaires" };
    // the gap containing the click (circular), then keep everything else
    let keepFrom = 0, keepTo = 0, found = false;
    for (let i = 0; i < uniq.length; i++) {
      const a0 = uniq[i], a1 = uniq[(i + 1) % uniq.length];
      let inside = a1 > a0 ? (click >= a0 && click <= a1) : (click >= a0 || click <= a1);
      if (inside) { keepFrom = a1; keepTo = a0; found = true; break; }
    }
    if (!found) return { ok: false, error: "Le clic n'est pas sur l'arc" };
    let sweep = normAng(keepTo - keepFrom);
    if (o.type === "arc") {
      // never keep more than the original arc, and honor its direction
      const dt = normAng(keepFrom - g.t0);
      sweep = Math.min(dt >= g.sweep - 1e-9 ? g.sweep : sweep, g.sweep);
    }
    if (sweep < 1e-9) return { ok: false, error: "Rognage retirerait tout l'arc" };
    const p1 = addPoint(d, g.c.x + g.r * Math.cos(keepFrom), g.c.y + g.r * Math.sin(keepFrom));
    const p2 = addPoint(d, g.c.x + g.r * Math.cos(keepFrom + sweep), g.c.y + g.r * Math.sin(keepFrom + sweep));
    d.objects = d.objects.filter(x => x.id !== id);
    d.constraints = (d.constraints || []).filter(k => k.line !== id && k.item !== id && !(k.items || []).includes(id) && !(k.lines || []).includes(id));
    const obj = { id: newId(d, "c"), type: "arc", center: o.center, p1: p1, p2: p2 };
    if (o.sketch) obj.sketch = o.sketch;
    if (o.construction) obj.construction = true;
    d.objects.push(obj);
    toV6(d); const v = validateDoc(d);
    return v.ok ? { ok: true, doc: d, ids: [obj.id] } : { ok: false, error: v.error };
  }
  /** Lengthen the end of a line nearest the click until it reaches another object. */
  function extendObject(doc, id, at) {
    const d = clone(doc), o = getObj(d, id), pm = pointMap(d);
    if (!isLine(o)) return { ok: false, error: "Prolongement possible sur une ligne" };
    const a = pm.get(o.p1), b = pm.get(o.p2), L = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(L > EPS)) return { ok: false, error: "Ligne dégénérée" };
    const endP1 = Math.hypot(at.x - a.x, at.y - a.y) <= Math.hypot(at.x - b.x, at.y - b.y);
    const fixed = endP1 ? b : a, moving = endP1 ? a : b;
    const ux = (moving.x - fixed.x) / L, uy = (moving.y - fixed.y) / L, far = 1e6;
    let best = Infinity;
    for (const other of d.objects) {
      if (other.id === id || !(LINE_TYPES[other.type] || other.type === "circle" || other.type === "arc")) continue;
      let ts = [];
      if (isLine(other)) {
        const c = pm.get(other.p1), e = pm.get(other.p2), t = c && e ? lineHitParams(fixed, { x: fixed.x + ux * far, y: fixed.y + uy * far }, c, e) : null;
        if (t != null) ts = [t];
      } else {
        const G = other.type === "circle" ? { c: pm.get(other.center), r: other.r } : arcGeom(other, pm);
        if (!G || !G.c || !(G.r > 0)) continue;
        ts = lineCircleParams(fixed, { x: fixed.x + ux * far, y: fixed.y + uy * far }, G.c, G.r).filter(t => t > 0);
        ts = ts.filter(t => { const p = { x: fixed.x + ux * far * t, y: fixed.y + uy * far * t }; return other.type === "circle" || onArc(other, pm, p); });
      }
      for (const t of ts) { const dist = t * far; if (dist > L + 1e-7 && dist < best) best = dist; }
    }
    if (!isFinite(best)) return { ok: false, error: "Aucune arête à atteindre dans cette direction" };
    const p = pm.get(endP1 ? o.p1 : o.p2);
    p.x = round6(fixed.x + ux * best); p.y = round6(fixed.y + uy * best);
    const v = validateDoc(d);
    return v.ok ? { ok: true, doc: d, ids: [o.id] } : { ok: false, error: v.error };
  }
  /** Copy edges into a sketch ("convert entities"): new points and objects, optionally construction-only. */
  function convertToSketch(doc, ids, sketch, opts) {
    const o = opts || {}, d = clone(doc), pm = pointMap(d), out = [], map = new Map();
    const point = pid => {
      if (map.has(pid)) return map.get(pid);
      const p = pm.get(pid); if (!p) return null;
      const np = { id: newId(d, "p"), x: round6(p.x), y: round6(p.y) };
      if (sketch) np.sketch = sketch;
      d.points.push(np); map.set(pid, np.id); return np.id;
    };
    for (const id of ids || []) {
      const src = getObj(d, id);
      if (!src || src.id === undefined) continue;
      const c = clone(src);
      c.id = newId(d, String(src.id)[0] || "o");
      delete c.group;
      if (c.p1) c.p1 = point(src.p1);
      if (c.p2) c.p2 = point(src.p2);
      if (c.center) c.center = point(src.center);
      if (c.type === "spline") c.pts = (src.pts || []).map(point);
      if (sketch) c.sketch = sketch;
      if (o.construction) c.construction = true;
      d.objects.push(c); out.push(c.id);
    }
    if (!out.length) return { ok: false, error: "Aucune arête à convertir" };
    toV6(d); const v = validateDoc(d);
    return v.ok ? { ok: true, doc: d, ids: out } : { ok: false, error: v.error };
  }
  /** Convert a closed ring of 2D points (a projected face outline) into sketch lines. */
  function convertRing(doc, pts, opts) {
    if (!Array.isArray(pts) || pts.length < 3) return { ok: false, error: "Contour invalide" };
    const d = clone(doc), o = opts || {};
    let ring = pts.map(p => [Number(p[0]), Number(p[1])]).filter(p => isFinite(p[0]) && isFinite(p[1]));
    if (ring.length > 1 && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 1e-9) ring.pop();
    if (ring.length < 3) return { ok: false, error: "Contour invalide" };
    if (ring.length > 200) { const step = Math.ceil(ring.length / 200); ring = ring.filter((_, i) => i % step === 0); }
    const g = newId(d, "g"), pids = ring.map(p => addPoint(d, p[0], p[1])), ids = [];
    for (let i = 0; i < pids.length; i++) {
      const obj = { id: newId(d, "l"), type: "line", p1: pids[i], p2: pids[(i + 1) % pids.length], group: g };
      if (o.construction) obj.construction = true;
      if (o.sketch) obj.sketch = o.sketch;
      d.objects.push(obj); ids.push(obj.id);
    }
    if (o.sketch) for (const p of d.points) if (pids.includes(p.id)) p.sketch = o.sketch;
    toV6(d); const v = validateDoc(d);
    return v.ok ? { ok: true, doc: d, ids: ids, points: pids, group: g } : { ok: false, error: v.error };
  }
  /** Sample a spline's Catmull-Rom curve (the exact curve the canvas draws) into a polyline.
   * A closed spline includes its wrap span, and the first point is not repeated at the end. */
  function splineSamples(o, pm, perSpan) {
    const pts = ((o && o.pts) || []).map(id => pm.get(id)).filter(Boolean);
    if (pts.length < 2) return [];
    const n = pts.length, closed = !!o.closed && n >= 3, spans = closed ? n : n - 1, steps = Math.max(1, perSpan || 12), out = [];
    const at = i => pts[((i % n) + n) % n];
    for (let i = 0; i < spans; i++) {
      const p1 = at(i), p2 = at(i + 1);
      const p0 = closed ? at(i - 1) : (i > 0 ? at(i - 1) : p1);
      const p3 = closed ? at(i + 2) : (i + 2 < n ? at(i + 2) : p2);
      for (let k = 0; k < steps; k++) {
        const t = k / steps, t2 = t * t, t3 = t2 * t;
        const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
      }
    }
    if (!closed) out.push({ x: pts[n - 1].x, y: pts[n - 1].y });
    return out;
  }
  /** Boundary of a face picked in the 3D view (its UV triangulation) as one ordered closed ring. */
  function outlineFromTriangles(tris) {
    if (!Array.isArray(tris) || !tris.length) return { ok: false, error: "Contour de face introuvable" };
    const key = p => Math.round(p[0] * 1e6) + "," + Math.round(p[1] * 1e6), count = new Map(), pts = new Map();
    for (const tri of tris) {
      if (!Array.isArray(tri) || tri.length !== 3) continue;
      for (let i = 0; i < 3; i++) {
        const a = tri[i], b = tri[(i + 1) % 3], ka = key(a), kb = key(b);
        if (ka === kb) continue;
        pts.set(ka, a); pts.set(kb, b);
        const edge = ka < kb ? ka + "|" + kb : kb + "|" + ka;
        count.set(edge, (count.get(edge) || 0) + 1);
      }
    }
    const adj = new Map();
    for (const [edge, n] of count) if (n === 1) {
      const [a, b] = edge.split("|");
      if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b); adj.get(b).push(a);
    }
    const seen = new Set(); let best = [];
    for (const start of adj.keys()) {
      if (seen.has(start)) continue;
      const loop = [start]; seen.add(start);
      let cur = start, prev = null;
      for (;;) {
        const nxt = (adj.get(cur) || []).find(x => x !== prev && !seen.has(x));
        if (!nxt) break;
        loop.push(nxt); seen.add(nxt); prev = cur; cur = nxt;
      }
      if (loop.length > best.length) best = loop;
    }
    return best.length >= 3 ? { ok: true, pts: best.map(k => pts.get(k)) } : { ok: false, error: "Contour de face introuvable" };
  }
  function arcGeom(o, pm) {
    const c = pm.get(o.center), a = pm.get(o.p1), b = pm.get(o.p2);
    const r = Math.hypot(a.x - c.x, a.y - c.y);
    const t0 = Math.atan2(a.y - c.y, a.x - c.x), t1 = Math.atan2(b.y - c.y, b.x - c.x);
    let sweep = (t1 - t0) % (2 * Math.PI); if (sweep <= 0) sweep += 2 * Math.PI;
    return { c: c, r: r, t0: t0, sweep: sweep, a: a, b: b };
  }
  function arcDistance(o, pm, x, y) {
    if (!pm.get(o.center) || !pm.get(o.p1) || !pm.get(o.p2)) return Infinity; // a broken arc is nowhere
    const g = arcGeom(o, pm);
    let t = Math.atan2(y - g.c.y, x - g.c.x) - g.t0;
    t = ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (t <= g.sweep) return Math.abs(Math.hypot(x - g.c.x, y - g.c.y) - g.r);
    return Math.min(Math.hypot(x - g.a.x, y - g.a.y), Math.hypot(x - g.b.x, y - g.b.y));
  }

  /** The geometric model the solver works on: variables (free point coordinates, circle radii) and residuals (zero
   * when a constraint holds). Residuals read the live point objects of `doc`, which the solver moves in place. */
  function solverModel(doc, pinned) {
    const pm = pointMap(doc), objs = new Map(doc.objects.map(o => [o.id, o]));
    const fixed = new Set(doc.constraints.filter(k => k.type === "fixed").map(k => k.point));
    (pinned || []).forEach(p => fixed.add(p));
    const geomPts = [];
    const seen = new Set();
    const usePt = id => { if (!seen.has(id)) { seen.add(id); geomPts.push(id); } };
    for (const o of doc.objects) {
      if (LINE_TYPES[o.type]) { usePt(o.p1); usePt(o.p2); }
      else if (o.type === "arc") { usePt(o.center); usePt(o.p1); usePt(o.p2); }
      else if (o.type === "circle") usePt(o.center);
      else if (o.type === "ellipse") usePt(o.center);
      else if (o.type === "spline") for (const p of o.pts || []) usePt(p);
    }
    const vars = [];
    for (const pid of geomPts) {
      const p = pm.get(pid);
      if (!p || fixed.has(pid)) continue;
      vars.push({ key: pid, axis: "x", get: () => p.x, set: v => { p.x = v; } });
      vars.push({ key: pid, axis: "y", get: () => p.y, set: v => { p.y = v; } });
    }
    for (const o of doc.objects) if (o.type === "circle") vars.push({ key: o.id, axis: "r", get: () => o.r, set: v => { o.r = v; } });
    for (const o of doc.objects) if (o.type === "ellipse") {
      vars.push({ key: o.id, axis: "rx", get: () => o.rx, set: v => { o.rx = Math.max(1e-9, v); } });
      vars.push({ key: o.id, axis: "ry", get: () => o.ry, set: v => { o.ry = Math.max(1e-9, v); } });
    }
    const P = id => pm.get(id);
    const ends = id => { const o = objs.get(id); return [P(o.p1), P(o.p2)]; };
    const vec = id => { const [a, b] = ends(id); return [b.x - a.x, b.y - a.y]; };
    const round = id => { const o = objs.get(id); const c = P(o.center); return { c: c, r: o.type === "circle" ? o.r : Math.hypot(P(o.p1).x - c.x, P(o.p1).y - c.y) }; };
    const res = [];
    for (const o of doc.objects) if (o.type === "arc") res.push({ id: o.id, f: () => { const c = P(o.center), a = P(o.p1), b = P(o.p2); return Math.hypot(b.x - c.x, b.y - c.y) - Math.hypot(a.x - c.x, a.y - c.y); } });
    for (const k of doc.constraints) {
      let f = null;
      if (k.type === "length") f = () => { const [a, b] = ends(k.line); return Math.hypot(b.x - a.x, b.y - a.y) - k.value; };
      else if (k.type === "angle") f = () => {
        const dirs = k.lines.map(l => { const o = objs.get(l); const v = P(k.vertex), w = P(otherEnd(o, k.vertex)); return [w.x - v.x, w.y - v.y]; });
        const [u, w] = dirs, nu = Math.hypot(u[0], u[1]), nw = Math.hypot(w[0], w[1]);
        return (Math.atan2(Math.abs(u[0] * w[1] - u[1] * w[0]), u[0] * w[0] + u[1] * w[1]) - k.value * Math.PI / 180) * (nu + nw) / 2;
      };
      else if (k.type === "horizontal") f = () => { const [a, b] = ends(k.line); return b.y - a.y; };
      else if (k.type === "vertical") f = () => { const [a, b] = ends(k.line); return b.x - a.x; };
      else if (k.type === "concentric") {
        const A = () => round(k.items[0]), B = () => round(k.items[1]);
        res.push({ id: k.id, f: () => A().c.x - B().c.x });
        res.push({ id: k.id, f: () => A().c.y - B().c.y });
      }
      else if (k.type === "collinear") {
        const u = () => vec(k.items[0]), w = () => vec(k.items[1]), a = () => ends(k.items[0])[0], c = () => ends(k.items[1])[0];
        res.push({ id: k.id, f: () => { const v = u(), q = w(); return (v[0] * q[1] - v[1] * q[0]) / (Math.hypot(v[0], v[1]) || 1); } });
        res.push({ id: k.id, f: () => { const v = u(), p = a(), q = c(); return (v[0] * (q.y - p.y) - v[1] * (q.x - p.x)) / (Math.hypot(v[0], v[1]) || 1); } });
      }
      else if (k.type === "symmetric") {
        const A = P(k.points[0]), B = P(k.points[1]), L = k.line;
        const reflect = () => {
          const [p, q] = ends(L), dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy || 1;
          const t = ((B.x - p.x) * dx + (B.y - p.y) * dy) / l2;
          const fx = p.x + t * dx, fy = p.y + t * dy;
          return [2 * fx - B.x, 2 * fy - B.y];
        };
        res.push({ id: k.id, f: () => A.x - reflect()[0] });
        res.push({ id: k.id, f: () => A.y - reflect()[1] });
      }
      else if (k.type === "midpoint") {
        const [a, b] = ends(k.line), p = P(k.point);
        res.push({ id: k.id, f: () => p.x - (a.x + b.x) / 2 });
        res.push({ id: k.id, f: () => p.y - (a.y + b.y) / 2 });
      }
      else if (k.type === "point_on_curve") {
        const o = objs.get(k.item), p = P(k.point);
        if (o && LINE_TYPES[o.type]) f = () => { const [a, b] = ends(k.item), dx = b.x - a.x, dy = b.y - a.y; return (dx * (p.y - a.y) - dy * (p.x - a.x)) / (Math.hypot(dx, dy) || 1); };
        else if (o && (o.type === "circle" || o.type === "arc")) f = () => { const R = round(k.item); return Math.hypot(p.x - R.c.x, p.y - R.c.y) - R.r; };
        else if (o && o.type === "ellipse") f = () => { const c = P(o.center); return Math.hypot((p.x - c.x) / o.rx, (p.y - c.y) / o.ry) - 1; };
      }
      else if (k.type === "parallel" || k.type === "perpendicular") f = () => {
        const u = vec(k.items[0]), w = vec(k.items[1]), nu = Math.hypot(u[0], u[1]) || 1, nw = Math.hypot(w[0], w[1]) || 1, s = (nu + nw) / 2;
        return (k.type === "parallel" ? (u[0] * w[1] - u[1] * w[0]) : (u[0] * w[0] + u[1] * w[1])) / (nu * nw) * s;
      };
      else if (k.type === "equal") f = () => {
        const [a, b] = k.items;
        if (LINE_TYPES[(objs.get(a) || {}).type]) { const u = vec(a), w = vec(b); return Math.hypot(u[0], u[1]) - Math.hypot(w[0], w[1]); }
        return round(a).r - round(b).r;
      };
      else if (k.type === "distance") f = () => { const a = P(k.a), b = P(k.b); return Math.hypot(b.x - a.x, b.y - a.y) - k.value; };
      else if (k.type === "tangent") {
        const [a, b] = k.items;
        const isLineA = LINE_TYPES[(objs.get(a) || {}).type], isLineB = LINE_TYPES[(objs.get(b) || {}).type];
        if (isLineA || isLineB) {
          const lid = isLineA ? a : b, rid = isLineA ? b : a;
          f = () => { const [p, q] = ends(lid), R = round(rid), dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1; return Math.abs((R.c.x - p.x) * dy - (R.c.y - p.y) * dx) / L - R.r; };
        } else {
          const A = round(a), B = round(b), d0 = Math.hypot(A.c.x - B.c.x, A.c.y - B.c.y);
          const outside = d0 >= Math.max(A.r, B.r);
          f = () => { const A1 = round(a), B1 = round(b), dd = Math.hypot(A1.c.x - B1.c.x, A1.c.y - B1.c.y); return outside ? dd - (A1.r + B1.r) : dd - Math.abs(A1.r - B1.r); };
        }
      } else if (k.type === "radius") f = () => round(k.item).r - k.value;
      if (f) res.push({ id: k.id, f: f });
    }
    return { vars: vars, res: res, pm: pm, objs: objs };
  }

  function jacobian(M, h) {
    const m = M.res.length, n = M.vars.length, J = Array.from({ length: m }, () => new Float64Array(n));
    for (let j = 0; j < n; j++) {
      const v = M.vars[j], x0 = v.get();
      v.set(x0 + h); const plus = M.res.map(r => r.f());
      v.set(x0 - h); const minus = M.res.map(r => r.f());
      v.set(x0);
      for (let i = 0; i < m; i++) J[i][j] = (plus[i] - minus[i]) / (2 * h);
    }
    return J;
  }
  function gaussSolve(A, b) { // in place, partial pivoting; returns x or null
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      if (Math.abs(A[p][i]) < 1e-300) return null;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r++) { const k = A[r][i] / A[i][i]; if (!k) continue; for (let c = i; c < n; c++) A[r][c] -= k * A[i][c]; b[r] -= k * b[i]; }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
    return x;
  }
  function sketchScale(doc) { const e = extents(doc); return e ? Math.max(1, e.x1 - e.x0, e.y1 - e.y0) : Math.max(1, doc.grid.spacing * 10); }
  /** Damped minimum-norm Gauss-Newton: each step moves the geometry as little as possible to satisfy the
   * constraints, which is what makes dragging feel natural. */
  function iterate(M, scale) {
    const tol = 1e-9 * scale, h = 1e-7 * scale;
    if (!M.res.length) return true;
    if (!M.vars.length) return M.res.every(r => Math.abs(r.f()) <= tol);
    let lambda = 1e-9 * scale * scale;
    let r = M.res.map(x => x.f()), norm = Math.max(...r.map(Math.abs));
    for (let it = 0; it < 80 && norm > tol; it++) {
      const J = jacobian(M, h), m = r.length, n = M.vars.length;
      const A = Array.from({ length: m }, (_, i) => { const row = new Array(m); for (let k = 0; k < m; k++) { let s = 0; const Ji = J[i], Jk = J[k]; for (let j = 0; j < n; j++) s += Ji[j] * Jk[j]; row[k] = s + (i === k ? lambda : 0); } return row; });
      const y = gaussSolve(A, r.slice());
      if (!y) { lambda = lambda * 10 + 1e-12; continue; }
      const dx = new Array(n).fill(0);
      for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) dx[j] -= J[i][j] * y[i];
      const old = M.vars.map(v => v.get());
      M.vars.forEach((v, j) => v.set(old[j] + dx[j]));
      const r2 = M.res.map(x => x.f()), n2 = Math.max(...r2.map(Math.abs));
      if (!isFinite(n2) || n2 >= norm) { M.vars.forEach((v, j) => v.set(old[j])); lambda = lambda * 10 + 1e-12 * scale * scale; if (lambda > 1e12 * scale * scale) break; continue; }
      r = r2; norm = n2; lambda = Math.max(lambda / 10, 1e-15);
    }
    return norm <= tol * 10;
  }
  /** Satisfy every constraint, moving the geometry as little as possible. drag: [{pid, x, y}] points that try to
   * stay where the pointer put them. Returns {ok, doc} or {ok:false, error}. */
  function solve(doc, opts) {
    const o = opts || {};
    const d = clone(doc);
    const hasArc = d.objects.some(x => x.type === "arc");
    if (!d.constraints.length && !hasArc) return { ok: true, doc: d };
    const pm = pointMap(d);
    for (const t of o.drag || []) { const p = pm.get(t.pid); if (p) { p.x = t.x; p.y = t.y; } }
    const scale = sketchScale(d);
    const snapshot = JSON.stringify(d.points.map(p => [p.x, p.y]).concat(d.objects.filter(x => x.type === "circle").map(x => x.r)));
    const restore = () => { const v = JSON.parse(snapshot); d.points.forEach((p, i) => { p.x = v[i][0]; p.y = v[i][1]; }); d.objects.filter(x => x.type === "circle").forEach((x, i) => { x.r = v[d.points.length + i]; }); };
    let ok = false;
    if ((o.drag || []).length) ok = iterate(solverModel(d, o.drag.map(t => t.pid)), scale);
    if (!ok) { restore(); ok = iterate(solverModel(d, []), scale); }
    if (!ok) return { ok: false, error: "Contraintes impossibles à satisfaire ensemble" };
    for (const p of d.points) { p.x = Math.round(p.x * 1e9) / 1e9; p.y = Math.round(p.y * 1e9) / 1e9; }
    for (const x of d.objects) if (x.type === "circle") x.r = Math.round(x.r * 1e9) / 1e9;
    return { ok: true, doc: d };
  }
  /** Degrees of freedom left in the sketch, and which objects are fully defined (cannot move without breaking a
   * constraint): SolidWorks' black versus blue. */
  function freedom(doc) {
    const d = clone(doc), M = solverModel(d, []);
    const n = M.vars.length, scale = sketchScale(d);
    const defined = new Set();
    const rows = M.res.length ? jacobian(M, 1e-7 * scale).map(r => Array.from(r)) : [];
    // reduced row echelon form: pivot columns are determined unless a free column touches their row
    const pivots = [], tol = 1e-7;
    let row = 0;
    for (let c = 0; c < n && row < rows.length; c++) {
      let p = row;
      for (let r = row + 1; r < rows.length; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[p][c])) p = r;
      if (Math.abs(rows[p][c]) < tol) continue;
      [rows[row], rows[p]] = [rows[p], rows[row]];
      const piv = rows[row][c];
      for (let k = c; k < n; k++) rows[row][k] /= piv;
      for (let r = 0; r < rows.length; r++) if (r !== row && Math.abs(rows[r][c]) > 0) { const f = rows[r][c]; for (let k = c; k < n; k++) rows[r][k] -= f * rows[row][k]; }
      pivots.push(c); row++;
    }
    const isPivot = new Set(pivots), determined = new Set();
    pivots.forEach((c, i) => { let free = false; for (let k = 0; k < n; k++) if (!isPivot.has(k) && Math.abs(rows[i][k]) > tol) { free = true; break; } if (!free) determined.add(c); });
    const varOk = new Map();
    M.vars.forEach((v, j) => { const key = v.key + "." + v.axis; varOk.set(key, determined.has(j)); });
    const fixedPts = new Set(d.constraints.filter(k => k.type === "fixed").map(k => k.point));
    const ptOk = pid => fixedPts.has(pid) || (varOk.get(pid + ".x") && varOk.get(pid + ".y"));
    for (const o of d.objects) {
      if (LINE_TYPES[o.type] && ptOk(o.p1) && ptOk(o.p2)) defined.add(o.id);
      else if (o.type === "arc" && ptOk(o.center) && ptOk(o.p1) && ptOk(o.p2)) defined.add(o.id);
      else if (o.type === "circle" && ptOk(o.center) && varOk.get(o.id + ".r")) defined.add(o.id);
      else if (o.type === "ellipse" && ptOk(o.center) && varOk.get(o.id + ".rx") && varOk.get(o.id + ".ry")) defined.add(o.id);
      else if (o.type === "spline" && (o.pts || []).every(ptOk)) defined.add(o.id);
    }
    return { dof: n - pivots.length, defined: defined };
  }
  /** Solver health: remaining degrees of freedom, redundant relations, and the relations that cannot hold together.
   * Redundancy is found by rank: a row that adds nothing to the Jacobian is already implied by the others. */
  function sketchReport(doc) {
    const s = solve(doc);
    const d = s.ok ? s.doc : clone(doc);
    const M = solverModel(d, []), scale = sketchScale(d), n = M.vars.length, tol = 1e-7;
    if (!n) return { ok: s.ok, dof: 0, redundant: [], conflicts: [], error: s.ok ? "" : s.error };
    const rows = M.res.length ? jacobian(M, 1e-7 * scale).map(r => Array.from(r)) : [];
    const ids = M.res.map(r => r.id), basis = [], redundant = new Set();
    rows.forEach((row, i) => {
      const v = row.slice(), n0 = Math.hypot(...v);
      for (const b of basis) { const k = v.reduce((s, x, j) => s + x * b[j], 0) / b.reduce((s, x) => s + x * x, 0); for (let j = 0; j < v.length; j++) v[j] -= k * b[j]; }
      if (Math.hypot(...v) <= tol * Math.max(n0, 1)) redundant.add(ids[i]);
      else basis.push(v);
    });
    const isRelation = id => d.constraints.some(k => k.id === id);
    const redundantIds = [...redundant].filter(isRelation);
    const residualOf = id => { const i = ids.indexOf(id); return i < 0 ? 0 : Math.abs(M.res[i].f()); };
    const conflicts = redundantIds.filter(id => residualOf(id) > 1e-6 * scale);
    return { ok: s.ok, dof: Math.max(0, n - basis.length), redundant: redundantIds, conflicts: conflicts, error: s.ok ? "" : s.error };
  }
  function geometricResiduals(doc) {
    const d = clone(doc), M = solverModel(d, []), scale = sketchScale(d), bad = [];
    for (const r of M.res) if (Math.abs(r.f()) > 1e-6 * scale) bad.push(r.id);
    return bad;
  }
  /** Add a constraint and solve; refused when the sketch cannot satisfy it together with the others. */
  function addConstraint(doc, k) {
    if (!GEO_CONSTRAINTS.includes(k.type)) return { ok: false, error: "Contrainte inconnue" };
    const d = toV6(clone(doc));
    const item = Object.assign({}, k, { id: newId(d, "k") });
    d.constraints.push(item);
    const v = validateDoc(d);
    if (!v.ok) return { ok: false, error: v.error };
    const s = solve(d);
    if (!s.ok) {
      // Name the relations that clash instead of a generic failure: the new row, plus whatever shares its geometry.
      const rep = sketchReport(d), clash = new Set(rep.redundant.length ? rep.redundant : [item.id]);
      for (const id of [...clash]) {
        const c = d.constraints.find(k => k.id === id); if (!c) continue;
        const refs = new Set([c.line, c.item, c.point, ...(c.items || []), ...(c.points || [])].filter(Boolean));
        for (const k of d.constraints) if (k.id !== id && [k.line, k.item, k.point, ...(k.items || []), ...(k.points || [])].some(r => refs.has(r))) clash.add(k.id);
      }
      return { ok: false, error: "Relation refusée : conflit avec " + [...clash].map(id => describeConstraint(d, id)).join(", ") };
    }
    const dead = degenerateItem(s.doc);
    if (dead) return { ok: false, error: "Contrainte refusée : elle replierait " + dead + " sur lui-même" };
    return { ok: true, doc: s.doc, id: item.id };
  }
  /** The first object a solve would fold onto itself (a line whose ends meet, a circle without a radius), or "". */
  function degenerateItem(doc) {
    const pm = pointMap(doc);
    for (const o of doc.objects) {
      if (isLine(o)) { const a = pm.get(o.p1), b = pm.get(o.p2); if (a && b && Math.hypot(b.x - a.x, b.y - a.y) <= 1e-6) return o.id; }
      if (o.type === "circle" && !(o.r > 1e-6)) return o.id;
    }
    return "";
  }
  /** Points moved by a drag, then the constraints re-satisfied around them (v6 sketches). */
  function settle(d, drag, what) {
    if ((Number(d.version) || 1) >= SKETCH_VERSION && (d.constraints.length || d.objects.some(o => o.type === "arc"))) {
      const s = solve(d, { drag: drag });
      if (!s.ok) return { ok: false, error: what + " refusé : " + s.error.toLowerCase() };
      return refuseIfBroken(s.doc, what);
    }
    return refuseIfBroken(d, what);
  }

  // ---- v6 feature tree helpers
  function moveFeature(doc, id, delta) {
    const d = clone(doc), fs = d.features || [], i = fs.findIndex(f => f.id === id), j = i + delta;
    if (i < 1 || j < 1 || j >= fs.length) return { ok: false, error: "Déplacement impossible (la pièce de base reste en premier)" };
    [fs[i], fs[j]] = [fs[j], fs[i]];
    toV6(d);
    const v = validateDoc(d);
    return v.ok ? { ok: true, doc: d } : { ok: false, error: v.error };
  }
  function setRollback(doc, n) {
    const d = toV6(clone(doc)), len = (d.features || []).length;
    if (n == null || n >= len) delete d.rollback;
    else if (Number.isInteger(n) && n >= 1) d.rollback = n;
    else return { ok: false, error: "Point de retour invalide" };
    return { ok: true, doc: d };
  }

  // ---------------------------------------------------------------- feature tree
  const FEATURE_LABEL = { extrude: "Bossage", cut: "Enlèvement", revolve: "Révolution", sweep: "Balayage",
    loft: "Lissage", hole: "Trou", shell: "Évidement", pattern: "Répétition", fillet: "Congé", chamfer: "Chanfrein" };
  // How the tree groups a feature, so a long part reads as base / additions / removals / finishing.
  const FEATURE_FAMILY = { extrude: "add", revolve: "add", sweep: "add", loft: "add", cut: "cut", hole: "cut",
    pattern: "cut", shell: "trim", fillet: "trim", chamfer: "trim" };
  // Numeric feature fields a parameter expression may drive (resolved before the part is rebuilt).
  const DRIVABLE = ["depth", "thickness", "radius", "distance", "angle", "dx", "dy", "cx", "cy"];

  /** One row per feature, in rebuild order, with what would stop it: missing profile objects, a pattern without its
   * source, a base feature that is not a boss. `active` follows the rollback point; `suppressed` is what the eye
   * toggles. Read-only: the tree never mutates the document. */
  function featureRows(doc) {
    const fs = Array.isArray(doc.features) ? doc.features : [];
    const objs = new Map((doc.objects || []).map(o => [o.id, o]));
    const rollback = Number.isInteger(doc.rollback) ? doc.rollback : fs.length;
    return fs.map((f, i) => {
      const problems = [];
      const profile = Array.isArray(f.profile) ? f.profile : (Array.isArray(f.profiles) ? f.profiles.flat() : []);
      if (["extrude", "cut", "revolve", "sweep", "loft"].includes(f.type)) {
        if (!profile.length) problems.push("profil vide");
        for (const id of profile) if (!objs.has(id)) problems.push("objet " + id + " introuvable");
        if (f.type === "revolve" && !objs.has(f.axis)) problems.push("axe " + f.axis + " introuvable");
        if (f.type === "sweep" && (f.path || []).some(id => !objs.has(id))) problems.push("chemin incomplet");
      }
      if (f.type === "hole" && (f.at || []).some(id => !objs.has(id))) problems.push("cercle introuvable");
      if (f.type === "pattern" && !fs.slice(0, i).some(x => x.id === f.source)) problems.push("source absente ou placée après");
      if (i === 0 && f.op === "cut") problems.push("la pièce de base ne peut pas être une coupe");
      const label = f.op === "cut" && f.type === "extrude" ? "Enlèvement" : (FEATURE_LABEL[f.type] || f.type);
      const detail = f.type === "hole" ? (f.standard || "") + (f.fit ? " · " + f.fit : "") : (f.type === "extrude" || f.type === "cut" ? (f.extent === "throughAll" ? "traversant" : fmt(f.depth)) : "");
      const u = doc.units || "mm";
      let value = "";
      if (f.type === "extrude" || f.type === "cut") value = f.extent === "throughAll" ? "traversant" : fmt(f.depth) + " " + u;
      else if (f.type === "revolve") value = fmt(f.angle) + "°";
      else if (f.type === "hole") value = (f.standard || "") + (f.extent === "throughAll" ? " traversant" : " " + fmt(f.depth || 0));
      else if (f.type === "shell") value = fmt(f.thickness) + " " + u;
      else if (f.type === "fillet") value = "R " + fmt(f.radius);
      else if (f.type === "chamfer") value = fmt(f.distance);
      else if (f.type === "pattern") value = "\u00d7" + f.count;
      return { id: f.id, index: i, type: f.type, op: f.op === "cut" ? "cut" : "add", label: label,
        name: f.name || label, family: i === 0 ? "base" : (FEATURE_FAMILY[f.type] || "add"), value: value,
        driven: f.driven || null, detail: detail, suppressed: f.suppressed === true, active: i < rollback, errors: problems };
    });
  }
  /** Kept features in rebuild order, honouring the rollback point: what the solid is made of right now. */
  function activeFeatures(doc) {
    const fs = Array.isArray(doc.features) ? doc.features : [];
    const rollback = Number.isInteger(doc.rollback) ? doc.rollback : fs.length;
    return fs.slice(0, Math.max(0, Math.min(rollback, fs.length))).filter(f => !f.suppressed);
  }
  function setFeatureSuppressed(doc, id, on) { return updateFeature(doc, id, { suppressed: !!on }); }
  /** Move a feature to an exact slot (drag and drop in the tree). The base stays first. */
  function moveFeatureTo(doc, id, to) {
    const d = toV6(clone(doc)), fs = d.features || [];
    const at = fs.findIndex(f => f.id === id);
    if (at < 0) return { ok: false, error: "Fonction introuvable" };
    const slot = Number(to);
    if (!isFinite(slot)) return { ok: false, error: "Position invalide" };
    const target = Math.max(0, Math.min(fs.length - 1, Math.round(slot)));
    if (target === at) return { ok: true, doc: d };
    if (target === 0 || at === 0) return { ok: false, error: "La pièce de base reste en premier" };
    fs.splice(target, 0, fs.splice(at, 1)[0]);
    const v = validateDoc(d);
    return v.ok ? { ok: true, doc: d } : { ok: false, error: v.error };
  }
  /** Resolve every driven feature value from the parameters, before the part is rebuilt. A field whose expression
   * no longer resolves keeps its last number and is reported, so the tree can show it instead of failing silently. */
  function applyFeatureValues(doc, values) {
    const d = clone(doc), errors = [];
    for (const f of d.features || []) {
      if (!f.driven) continue;
      for (const [field, expr] of Object.entries(f.driven)) {
        if (!DRIVABLE.includes(field)) continue;
        const r = evalExpr(expr, values || {});
        if (!r.ok) { errors.push({ id: f.id, field: field, message: r.error }); continue; }
        const v = Math.round(r.value * 1e6) / 1e6;
        if (field === "angle") f.angle = Math.max(1, Math.min(360, v));
        else if (field === "depth") f.depth = Math.max(0, v);
        else if (field === "thickness" || field === "radius" || field === "distance") f[field] = Math.max(1e-6, v);
        else f[field] = v;
      }
    }
    return { ok: !errors.length, doc: d, errors: errors };
  }
  function setFeatureRollback(doc, n) { return setRollback(doc, n); }

  // ---------------------------------------------------------------- stroke recognition: freehand in, real geometry out
  function fitLinePts(pts) {
    const n = pts.length;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(th), uy = Math.sin(th);
    let t0 = Infinity, t1 = -Infinity, maxDev = 0;
    for (const p of pts) {
      const dx = p[0] - mx, dy = p[1] - my;
      const t = dx * ux + dy * uy;
      t0 = Math.min(t0, t); t1 = Math.max(t1, t);
      maxDev = Math.max(maxDev, Math.abs(-dx * uy + dy * ux));
    }
    return { a: [mx + ux * t0, my + uy * t0], b: [mx + ux * t1, my + uy * t1], maxDev: maxDev, len: t1 - t0, u: [ux, uy] };
  }
  function fitCirclePts(pts) {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
    for (const p of pts) {
      const x = p[0], y = p[1], z = x * x + y * y;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
    }
    const n = pts.length;
    const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], b = [-sxz, -syz, -sz];
    for (let i = 0; i < 3; i++) {
      let p = i;
      for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      if (Math.abs(A[p][i]) < 1e-12) return null;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < 3; r++) { const k = A[r][i] / A[i][i]; for (let c = i; c < 3; c++) A[r][c] -= k * A[i][c]; b[r] -= k * b[i]; }
    }
    const sol = [0, 0, 0];
    for (let i = 2; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < 3; c++) s -= A[i][c] * sol[c]; sol[i] = s / A[i][i]; }
    const cx = -sol[0] / 2, cy = -sol[1] / 2, r2 = cx * cx + cy * cy - sol[2];
    if (!(r2 > 0)) return null;
    const r = Math.sqrt(r2);
    let maxDev = 0;
    const ang = [];
    for (const p of pts) {
      const dx = p[0] - cx, dy = p[1] - cy;
      maxDev = Math.max(maxDev, Math.abs(Math.hypot(dx, dy) - r));
      ang.push(Math.atan2(dy, dx));
    }
    const sorted = ang.slice().sort((a, b) => a - b);
    let gap = sorted[0] + 2 * Math.PI - sorted[sorted.length - 1];
    for (let i = 1; i < sorted.length; i++) gap = Math.max(gap, sorted[i] - sorted[i - 1]);
    return { c: [cx, cy], r: r, maxDev: maxDev, coverage: 2 * Math.PI - gap, ang: ang };
  }
  /** Turn a freehand stroke into the shape it obviously is. Returns a proposal the caller may accept or ignore:
   * a proposal never touches the document, so keeping the raw stroke stays a one-click decision. */
  function recognizeStroke(points, opts) {
    const o = opts || {};
    const raw = (points || []).filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]));
    const pts = [];
    for (const p of raw) {
      const q = [Number(p[0]), Number(p[1])];
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-9) pts.push(q);
    }
    if (pts.length < 4) return { ok: false, reason: "trop court" };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const span = Math.hypot(x1 - x0, y1 - y0);
    if (!(span > EPS)) return { ok: false, reason: "tracé minuscule" };
    const tol = Math.max(span * 0.03, Number(o.tol) || 0);
    const gap = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
    const closed = gap < span * 0.2 && span > tol * 3;
    const line = fitLinePts(pts);
    if (!closed && line.len > span * 0.4 && line.maxDev <= tol * 0.55) {
      const deg = Math.atan2(line.u[1], line.u[0]) * 180 / Math.PI;
      let horizontal = false, vertical = false;
      const near = (a, b) => Math.abs(((a - b + 540) % 360) - 180) <= 5;
      if (near(deg, 0) || near(deg, 180)) horizontal = true;
      else if (near(deg, 90) || near(deg, 270)) vertical = true;
      let a = line.a.slice(), b = line.b.slice();
      if (horizontal) { const y = (a[1] + b[1]) / 2; a = [Math.min(a[0], b[0]), y]; b = [Math.max(a[0], b[0]), y]; }
      if (vertical) { const x = (a[0] + b[0]) / 2; a = [x, Math.min(a[1], b[1])]; b = [x, Math.max(a[1], b[1])]; }
      return { ok: true, kind: "line", a: a, b: b, horizontal: horizontal, vertical: vertical,
        constraints: horizontal ? ["horizontal"] : (vertical ? ["vertical"] : []), length: Math.hypot(b[0] - a[0], b[1] - a[1]),
        confidence: Math.max(0, 1 - line.maxDev / Math.max(tol, EPS)) };
    }
    const circ = fitCirclePts(pts);
    if (circ && circ.r > span * 0.1 && circ.maxDev <= tol * 0.7) {
      const confidence = Math.max(0, 1 - circ.maxDev / Math.max(tol, EPS));
      if (circ.coverage >= 4.9) {
        return { ok: true, kind: "circle", c: [round6(circ.c[0]), round6(circ.c[1])], r: round6(circ.r), confidence: confidence };
      }
      const first = pts[0], last = pts[pts.length - 1];
      const on = (p) => { const dx = p[0] - circ.c[0], dy = p[1] - circ.c[1], L = Math.hypot(dx, dy) || 1; return [round6(circ.c[0] + dx / L * circ.r), round6(circ.c[1] + dy / L * circ.r)]; };
      const p1 = on(first), p2 = on(last);
      if (Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) < EPS) return { ok: false, reason: "arc ambigu" };
      // direction of travel: a clockwise stroke is stored as the same arc with its ends swapped
      let total = 0;
      for (let i = 1; i < circ.ang.length; i++) { let d = circ.ang[i] - circ.ang[i - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; total += d; }
      const ends = total < 0 ? [p2, p1] : [p1, p2];
      return { ok: true, kind: "arc", c: [round6(circ.c[0]), round6(circ.c[1])], r: round6(circ.r), p1: ends[0], p2: ends[1],
        confidence: confidence };
    }
    const pts2 = simplify(pts, tol);
    if (pts2.length < 2) return { ok: false, reason: "tracé illisible" };
    return { ok: true, kind: "polyline", points: pts2.map(p => [round6(p[0]), round6(p[1])]), confidence: 0.2 };
  }
  /** Materialise a recognition proposal. `snapTol` reuses an existing point when the shape lands on one, so a
   * straightened line joins the drawing instead of floating next to it. */
  function applyStrokeShape(doc, proposal, opts) {
    const o = opts || {};
    if (!proposal || !proposal.ok) return { ok: false, error: (proposal && proposal.reason) || "Forme non reconnue" };
    let d = clone(doc);
    const snapTol = Number(o.snapTol) || 0;
    const at = (x, y) => { const id = snapTol > 0 ? findPointNear(d, x, y, snapTol) : null; return id ? { id: id } : { x: x, y: y }; };
    const ids = [], warn = [];
    if (proposal.kind === "line") {
      const a = at(proposal.a[0], proposal.a[1]), b = at(proposal.b[0], proposal.b[1]);
      const id = addLine(d, a, b);
      if (!id) return { ok: false, error: "Ligne dégénérée" };
      ids.push(id);
      for (const type of proposal.constraints || []) {
        const k = addConstraint(d, { type: type, line: id });
        if (k.ok) d = k.doc; else warn.push(k.error);
      }
    } else if (proposal.kind === "circle") {
      const c = at(proposal.c[0], proposal.c[1]);
      const id = addCircle(d, c, proposal.r);
      if (!id) return { ok: false, error: "Cercle dégénéré" };
      ids.push(id);
    } else if (proposal.kind === "arc") {
      const id = addArc(d, { x: proposal.c[0], y: proposal.c[1] }, { x: proposal.p1[0], y: proposal.p1[1] }, { x: proposal.p2[0], y: proposal.p2[1] });
      if (!id) return { ok: false, error: "Arc dégénéré" };
      ids.push(id);
    } else if (proposal.kind === "polyline") {
      const pts = proposal.points || [];
      for (let i = 1; i < pts.length; i++) {
        const id = addLine(d, at(pts[i - 1][0], pts[i - 1][1]), at(pts[i][0], pts[i][1]));
        if (id) ids.push(id);
      }
      if (!ids.length) return { ok: false, error: "Tracé dégénéré" };
    } else return { ok: false, error: "Forme inconnue" };
    if (o.sketch) {
      toV6(d);
      const pts = new Set();
      for (const id of ids) { const ob = getObj(d, id); if (ob) for (const k of ["p1", "p2", "center"]) if (ob[k]) pts.add(ob[k]); }
      for (const id of ids) { const ob = getObj(d, id); if (ob) ob.sketch = o.sketch; }
      for (const p of d.points) if (pts.has(p.id)) p.sketch = o.sketch;
    }
    const v = validateDoc(d);
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, doc: d, ids: ids, warnings: warn };
  }

  // ---------------------------------------------------------------- validation (mirror of hq_drawings.validate_document, lighter)
  function validateDoc(doc) {
    try {
      if (!doc || typeof doc !== "object") throw new Error("Document invalide");
      if (doc.format !== FORMAT || ![1, 2, 3, 4, 5, 6].includes(doc.version)) throw new Error("Format/version inconnus");
      const v6 = doc.version >= SKETCH_VERSION;
      const sketches = doc.sketches || [];
      if (!Array.isArray(sketches) || sketches.length > 20 || (sketches.length && !v6)) throw new Error("Esquisses invalides");
      if (!UNIT_MM[doc.units]) throw new Error("Unités invalides");
      if (!doc.grid || !(doc.grid.spacing > 0)) throw new Error("Grille invalide");
      for (const k of ["points", "objects", "constraints"]) if (!Array.isArray(doc[k])) throw new Error(k + " invalides");
      if (doc.underlay !== undefined && !checkUnderlay(doc.underlay, doc.version)) throw new Error("Fond de dessin invalide");
      if (doc.points.length > LIMITS.points || doc.objects.length > LIMITS.objects || doc.constraints.length > LIMITS.constraints) throw new Error("Dessin trop volumineux");
      const ids = new Set(), pts = new Set(), lines = new Map();
      const idOk = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);
      const num = v => typeof v === "number" && isFinite(v) && Math.abs(v) <= LIMITS.coord;
      const claim = v => { if (!idOk(v) || ids.has(v)) throw new Error("Identifiant invalide : " + v); ids.add(v); };
      const sketchIds = new Set();
      for (const sk of sketches) { claim(sk.id); if (!SKETCH_PLANES[sk.plane] || !num(sk.offset || 0) || (sk.face != null && sk.face !== 1 && sk.face !== -1)) throw new Error("Esquisse invalide"); sketchIds.add(sk.id); }
      const skOk = x => x.sketch == null || (v6 && sketchIds.has(x.sketch));
      const ptSketch = new Map();
      for (const p of doc.points) { claim(p.id); if (!num(p.x) || !num(p.y) || !skOk(p)) throw new Error("Point invalide"); pts.add(p.id); ptSketch.set(p.id, sketchOf(p)); }
      const pm = pointMap(doc), kinds = new Map(), types = new Map();
      for (const o of doc.objects) types.set(o.id, o.type); // a cote may name an object declared later
      for (const o of doc.objects) {
        claim(o.id);
        kinds.set(o.id, o.type);
        if (o.construction != null && typeof o.construction !== "boolean") throw new Error("Géométrie de construction invalide");
        if (!skOk(o)) throw new Error("Esquisse inconnue : " + o.id);
        const same = (...ps) => { if (ps.some(x => ptSketch.get(x) !== sketchOf(o))) throw new Error("Points d'une autre esquisse : " + o.id); };
        if (o.type === "arc") {
          if (!v6 || ![o.center, o.p1, o.p2].every(x => pts.has(x)) || new Set([o.center, o.p1, o.p2]).size !== 3) throw new Error("Arc invalide");
          same(o.center, o.p1, o.p2);
          const g = arcGeom(o, pm), rb = Math.hypot(g.b.x - g.c.x, g.b.y - g.c.y);
          if (!(g.r > 1e-9) || Math.abs(g.r - rb) > 1e-6 * Math.max(1, g.r)) throw new Error("Arc invalide : extrémités à des rayons différents");
          lines.set(o.id, [o.p1, o.p2]);
          continue;
        }
        if (LINE_TYPES[o.type] && pts.has(o.p1) && pts.has(o.p2)) same(o.p1, o.p2);
        if (o.type === "circle" && pts.has(o.center)) same(o.center);
        if (LINE_TYPES[o.type]) { if (!pts.has(o.p1) || !pts.has(o.p2) || o.p1 === o.p2) throw new Error("Ligne invalide"); lines.set(o.id, [o.p1, o.p2]); }
        else if (o.type === "circle") { if (!pts.has(o.center) || !(o.r > 0)) throw new Error("Cercle invalide"); }
        else if (o.type === "ellipse") {
          if (!v6 || !pts.has(o.center) || !(o.rx > 0) || !(o.ry > 0) || o.rx > LIMITS.coord || o.ry > LIMITS.coord) throw new Error("Ellipse invalide");
          same(o.center);
        }
        else if (o.type === "spline") {
          if (!v6 || !Array.isArray(o.pts) || o.pts.length < 2 || o.pts.length > 500 || new Set(o.pts).size !== o.pts.length || o.pts.some(id => !pts.has(id))) throw new Error("Spline invalide");
          if (o.closed != null && typeof o.closed !== "boolean") throw new Error("Spline invalide");
          if (o.closed && o.pts.length < 3) throw new Error("Une spline fermée demande au moins trois points");
          same(...o.pts);
        }
        else if (o.type === "stroke") {
          if (!Array.isArray(o.pts) || !o.pts.length || o.pts.length > LIMITS.strokePts) throw new Error("Tracé invalide");
          for (const p of o.pts) if (!Array.isArray(p) || p.length !== 2 || !num(p[0]) || !num(p[1])) throw new Error("Tracé invalide");
          if (o.w != null || o.k != null) {
            if (doc.version < STROKE_WIDTH_VERSION) throw new Error("Épaisseur invalide");
            if (!num(o.w) || !(o.w > 0)) throw new Error("Épaisseur invalide");
            if (o.k != null && (!Array.isArray(o.k) || o.k.length !== o.pts.length || o.k.some(v => typeof v !== "number" || !isFinite(v) || v < 0.05 || v > 4))) throw new Error("Épaisseur invalide");
          }
        }
        else if (o.type === "text") { if (typeof o.text !== "string" || !o.text.trim() || !num(o.x) || !num(o.y)) throw new Error("Texte invalide"); }
        else if (isRadialDim(o)) {
          if (!(types.get(o.item) === "circle" || types.get(o.item) === "arc")) throw new Error("Cote de rayon invalide");
          if (o.ang != null && !num(o.ang)) throw new Error("Cote de rayon invalide");
          if (o.ref != null && typeof o.ref !== "boolean") throw new Error("Cote de rayon invalide");
          if (o.tol != null && (typeof o.tol !== "string" || o.tol.length > 24)) throw new Error("Cote de rayon invalide");
          if (o.label != null && (typeof o.label !== "string" || o.label.length > LIMITS.text)) throw new Error("Cote de rayon invalide");
        }
        else if (o.type !== "dim_linear" && o.type !== "dim_angle") throw new Error("Type inconnu : " + o.type);
        if (o.drive != null) {
          if (!v6) throw new Error("Cote pilotée : version 6 requise");
          if (typeof o.drive !== "object" || typeof o.drive.expr !== "string" || !o.drive.expr.trim() || o.drive.expr.length > 120) throw new Error("Cote pilotée invalide");
          if (o.type === "dim_linear") {
            if (!Array.isArray(o.drive.points) || o.drive.points.length !== 2 || o.drive.points[0] === o.drive.points[1] || o.drive.points.some(id => !pts.has(id))) throw new Error("Cote pilotée invalide");
          } else if (o.type === "dim_angle") {
            if (!Array.isArray(o.drive.lines) || o.drive.lines.length !== 2 || !o.drive.lines.every(l => lines.has(l)) || !pts.has(o.drive.vertex)) throw new Error("Cote pilotée invalide");
          } else throw new Error("Cote pilotée invalide");
          if (o.drive.keepLabel != null && typeof o.drive.keepLabel !== "boolean") throw new Error("Cote pilotée invalide");
        }
      }
      for (const k of doc.constraints) {
        claim(k.id);
        if (k.type === "length") { if (!lines.has(k.line) || !lines.get(k.line).includes(k.fixed)) throw new Error("Contrainte invalide"); }
        else if (k.type === "angle") { if (!Array.isArray(k.lines) || k.lines.length !== 2 || !k.lines.every(l => lines.has(l) && lines.get(l).includes(k.vertex))) throw new Error("Contrainte invalide"); }
        else if (v6 && GEO_CONSTRAINTS.includes(k.type)) {
          const isL = id => LINE_TYPES[kinds.get(id)], isR = id => kinds.get(id) === "circle" || kinds.get(id) === "arc";
          const two = Array.isArray(k.items) && k.items.length === 2 && k.items[0] !== k.items[1];
          let ok;
          if (k.type === "horizontal" || k.type === "vertical") ok = isL(k.line);
          else if (k.type === "fixed") ok = pts.has(k.point);
          else if (k.type === "radius") ok = isR(k.item) && num(k.value) && k.value > 0;
          else if (k.type === "parallel" || k.type === "perpendicular") ok = two && k.items.every(isL);
          else if (k.type === "concentric") ok = two && k.items.every(isR);
          else if (k.type === "collinear") ok = two && k.items.every(isL);
          else if (k.type === "symmetric") ok = Array.isArray(k.points) && k.points.length === 2 && k.points[0] !== k.points[1] && k.points.every(p => pts.has(p)) && lines.has(k.line);
          else if (k.type === "midpoint") ok = pts.has(k.point) && lines.has(k.line);
          else if (k.type === "point_on_curve") ok = pts.has(k.point) && ["line", "centerline", "circle", "arc", "ellipse"].includes(kinds.get(k.item));
          else if (k.type === "equal") ok = two && (k.items.every(isL) || k.items.every(isR));
          else ok = two && ((isL(k.items[0]) && isR(k.items[1])) || (isR(k.items[0]) && isL(k.items[1])) || k.items.every(isR));
          if (!ok) throw new Error("Contrainte invalide : " + k.type);
        }
        else throw new Error("Contrainte inconnue");
      }
      const params = doc.params || [];
      if (!Array.isArray(params) || params.length > 40 || (params.length && !v6)) throw new Error("Paramètres invalides");
      const paramNames = new Set();
      for (const p of params) {
        if (!p || typeof p !== "object") throw new Error("Paramètre invalide");
        claim(p.id);
        if (!paramNameOk(p.name)) throw new Error("Nom de paramètre invalide");
        if (paramNames.has(p.name)) throw new Error("Paramètre en double : " + p.name);
        paramNames.add(p.name);
        if (typeof p.expr !== "string" || !p.expr.trim() || p.expr.length > 120) throw new Error("Expression de paramètre invalide");
      }
      const features = doc.features || [];
      if (!Array.isArray(features) || features.length > 50 || (doc.version === 1 && features.length)) throw new Error("Fonctions 3D invalides");
      const objOf = id => doc.objects.find(o => o.id === id);
      const typeOf = id => (objOf(id) || {}).type;
      const featureProfileIssue = p => profileIssue(p, objOf, v6);
      const refOk = e => e && ["a", "b", "m"].every(k => Array.isArray(e[k]) && e[k].length === 3 && e[k].every(num));
      let shells = 0;
      for (let i = 0; i < features.length; i++) {
        const f = features[i]; claim(f.id);
        const allowed = v6 ? (i === 0 ? ["extrude", "revolve", "sweep", "loft"] : ["extrude", "revolve", "sweep", "loft", "cut", "hole", "shell", "pattern", "fillet", "chamfer"])
          : (i === 0 ? ["extrude", "revolve"] : ["cut", "hole", "shell", "pattern"]);
        if (!allowed.includes(f.type)) throw new Error("Une pièce de base, puis des coupes, trous, coques ou répétitions");
        if (!v6 && ["op", "reverse", "both", "suppressed"].some(k => f[k] != null)) throw new Error("Option de la version 6");
        if (v6 && f.op != null && (!["add", "cut"].includes(f.op) || (i === 0 && f.op !== "add"))) throw new Error("Opération invalide");
        if (f.name != null && (typeof f.name !== "string" || !f.name.trim() || f.name.length > 40 || /[\u0000-\u001f\u007f]/.test(f.name))) throw new Error("Nom de fonction invalide");
        if (f.driven != null) {
          if (!v6) throw new Error("Valeur pilotée en version 6 requise");
          if (typeof f.driven !== "object" || Array.isArray(f.driven)) throw new Error("Valeur pilotée invalide");
          for (const [field, ex] of Object.entries(f.driven)) {
            if (!DRIVABLE.includes(field) || typeof ex !== "string" || !ex.trim() || ex.length > 120) throw new Error("Valeur pilotée invalide");
          }
        }
        if (V5_TYPES.includes(f.type) && doc.version < SOLID_V5_VERSION) throw new Error("Fonction 3D de version 5");
        if (f.type === "extrude" || f.type === "cut") {
          const pe = featureProfileIssue(f.profile);
          if (pe) throw new Error(pe);
          if (["reverse", "both", "suppressed"].some(k => f[k] != null && typeof f[k] !== "boolean")) throw new Error("Option invalide");
          if (!num(f.depth) || f.depth < 0 || (f.extent !== "throughAll" && f.depth <= 0) || !["blind", "throughAll"].includes(f.extent) || (f.type === "extrude" && f.extent !== "blind")) throw new Error("Profondeur 3D invalide");
        } else if (f.type === "revolve") {
          const pe = featureProfileIssue(f.profile);
          if (pe) throw new Error(pe);
          if (!["line", "centerline"].includes(typeOf(f.axis)) || f.profile.includes(f.axis)) throw new Error("Axe de révolution invalide");
          if (!num(f.angle) || f.angle < 1 || f.angle > 360) throw new Error("Angle de révolution invalide");
        } else if (f.type === "hole") {
          if (!Array.isArray(f.at) || !f.at.length || f.at.length > 50 || new Set(f.at).size !== f.at.length || f.at.some(id => typeOf(id) !== "circle")) throw new Error("Un trou se place au centre d'un cercle");
          if (!HOLE_STANDARDS.includes(f.standard) || !HOLE_FITS[f.fit] || !["blind", "throughAll"].includes(f.extent)) throw new Error("Trou invalide");
          if (!num(f.depth) || f.depth < 0 || (f.extent === "blind" && f.depth <= 0 && f.fit !== "insert")) throw new Error("Profondeur de trou invalide");
        } else if (f.type === "shell") {
          if (++shells > 1) throw new Error("Une seule coque par pièce");
          if (!num(f.thickness) || f.thickness <= 0 || typeof f.open !== "boolean") throw new Error("Coque invalide");
        } else if (f.type === "fillet" || f.type === "chamfer") {
          if (!Array.isArray(f.edges) || !f.edges.length || f.edges.length > 100 || !f.edges.every(refOk)) throw new Error("Arêtes invalides");
          const val = f.type === "fillet" ? f.radius : f.distance;
          if (!num(val) || val <= 0) throw new Error(f.type === "fillet" ? "Rayon invalide" : "Distance invalide");
        } else if (f.type === "sweep") {
          const pe = featureProfileIssue(f.profile);
          if (pe || !Array.isArray(f.path) || !f.path.length || f.path.some(id => !["line", "arc"].includes(typeOf(id)))) throw new Error("Balayage invalide" + (pe ? " : " + pe : ""));
        } else if (f.type === "loft") {
          if (!Array.isArray(f.profiles) || f.profiles.length < 2 || f.profiles.length > 10) throw new Error("Lissage invalide");
          const bad = f.profiles.map(featureProfileIssue).find(Boolean);
          if (bad) throw new Error("Lissage invalide : " + bad);
        } else {
          const src = features.slice(1, i).find(x => x.id === f.source);
          const repeatable = v6 ? ["cut", "hole", "extrude", "revolve", "sweep", "loft"] : ["cut", "hole"];
          if (!src || !repeatable.includes(src.type)) throw new Error("La répétition reprend une fonction placée avant elle");
          if (!["linear", "circular"].includes(f.mode) || !Number.isInteger(f.count) || f.count < 2 || f.count > 50) throw new Error("Répétition invalide");
          if (f.mode === "linear" && (!num(f.dx) || !num(f.dy) || (f.dx === 0 && f.dy === 0))) throw new Error("Pas de répétition invalide");
          if (f.mode === "circular" && (!num(f.cx) || !num(f.cy) || !num(f.angle) || f.angle < 1 || f.angle > 360)) throw new Error("Répétition circulaire invalide");
        }
      }
      if (doc.rollback != null && (!v6 || !Number.isInteger(doc.rollback) || doc.rollback < 0 || doc.rollback > features.length)) throw new Error("Point de retour invalide");
      const faceFeatures = doc.faceFeatures || [];
      if (!Array.isArray(faceFeatures) || faceFeatures.length > 50 || (doc.version < 3 && faceFeatures.length)) throw new Error("Fonctions sur face invalides");
      for (const f of faceFeatures) {
        claim(f.id);
        if (!["extrude", "cut"].includes(f.type) || !["blind", "throughAll"].includes(f.extent) || (f.type === "extrude" && f.extent !== "blind") ||
            !num(f.depth) || f.depth <= 0 || !Array.isArray(f.profile) || f.profile.length < 3 || f.profile.length > 500 ||
            f.profile.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(num)) ||
            !f.plane || ["origin", "u", "v", "normal"].some(k => !Array.isArray(f.plane[k]) || f.plane[k].length !== 3 || !f.plane[k].every(num)))
          throw new Error("Fonction sur face invalide");
      }
      const rounds = doc.roundFeatures || [];
      if (!Array.isArray(rounds) || rounds.length > 50 || (doc.version < 3 && rounds.length)) throw new Error("Arrondis invalides");
      for (const f of rounds) {
        claim(f.id);
        if (![f.a, f.b].every(p => Array.isArray(p) && p.length === 3 && p.every(num)) || !num(f.radius) || f.radius <= 1e-6)
          throw new Error("Arrondi invalide");
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  const DIAG_LABEL = { line: "Ligne", centerline: "Axe", circle: "Cercle", arc: "Arc", stroke: "Tracé", text: "Texte", dim_linear: "Cote", dim_angle: "Cote d'angle", dim_diameter: "Cote ⌀", dim_radius: "Cote R" };
  /** Read-only health check: dangling point / object / constraint references, sketches left on a face that no longer
   * exists, and degenerate shapes (zero-length lines, arcs with coincident points, circles without a radius).
   * It lists every finding with its id and never touches the document: no clone, no repair, the caller decides. */
  function diagnose(doc) {
    const issues = [];
    const add = (kind, id, message) => issues.push({ kind: kind, id: String(id || ""), message: message });
    const pts = new Map(), objs = new Map(), sks = new Map();
    for (const p of doc.points || []) if (!pts.has(p.id)) pts.set(p.id, p);
    for (const o of doc.objects || []) if (!objs.has(o.id)) objs.set(o.id, o);
    for (const s of doc.sketches || []) if (!sks.has(s.id)) sks.set(s.id, s);
    for (const p of doc.points || []) if (p.sketch && !sks.has(p.sketch)) add("point.sketch", p.id, "esquisse " + p.sketch + " introuvable");
    for (const o of doc.objects || []) {
      if (o.sketch && !sks.has(o.sketch)) add("object.sketch", o.id, "esquisse " + o.sketch + " introuvable");
      const need = o.type === "arc" ? ["center", "p1", "p2"] : (LINE_TYPES[o.type] ? ["p1", "p2"] : (o.type === "circle" || o.type === "ellipse" ? ["center"] : (o.type === "spline" ? (o.pts || []) : [])));
      const seen = new Set(); // p1 and p2 pointing at the same deleted point is one finding, not two
      for (const key of need) {
        const pid = o[key];
        if (pts.has(pid) || seen.has(pid)) continue;
        seen.add(pid);
        add("object.point", o.id, (DIAG_LABEL[o.type] || o.type) + " : point " + (pid == null ? "?" : pid) + " introuvable");
      }
      if (LINE_TYPES[o.type]) {
        const a = pts.get(o.p1), b = pts.get(o.p2);
        if (o.p1 != null && o.p1 === o.p2) add("line.zero", o.id, "longueur nulle : les deux extrémités sont le même point");
        else if (a && b && Math.hypot(b.x - a.x, b.y - a.y) <= 1e-6) add("line.zero", o.id, "longueur nulle : les deux extrémités sont au même endroit");
      } else if (o.type === "arc") {
        if (o.center === o.p1 || o.center === o.p2 || o.p1 === o.p2) add("arc.degenerate", o.id, "points confondus");
      } else if (o.type === "circle" && !(o.r > 0)) add("circle.degenerate", o.id, "rayon nul ou négatif");
      if (isRadialDim(o) && !objs.has(o.item)) add("dim.item", o.id, "cercle " + (o.item == null ? "?" : o.item) + " introuvable");
    }
    for (const k of doc.constraints || []) {
      const refs = [];
      if (k.line != null) refs.push(["ligne", k.line, objs]);
      if (k.item != null) refs.push(["objet", k.item, objs]);
      if (k.point != null) refs.push(["point", k.point, pts]);
      if (k.vertex != null) refs.push(["sommet", k.vertex, pts]);
      for (const l of k.lines || []) refs.push(["ligne", l, objs]);
      for (const i of k.items || []) refs.push(["objet", i, objs]);
      for (const ref of refs) if (!ref[2].has(ref[1])) add("constraint.ref", k.id, "contrainte " + k.type + " : " + ref[0] + " " + ref[1] + " introuvable");
    }
    const features = doc.features || [], base = features[0];
    // A sketch drawn on a picked face (sk.face = ±1) has no meaning once its part is gone.
    for (const s of doc.sketches || []) if (s.face != null && (!base || base.op === "cut")) add("sketch.face", s.id, "esquisse posée sur une face, mais la pièce a disparu");
    for (const f of features) {
      const groups = [];
      if (Array.isArray(f.profile)) groups.push(f.profile);
      for (const p of f.profiles || []) if (Array.isArray(p)) groups.push(p);
      if (Array.isArray(f.at)) groups.push(f.at);
      if (Array.isArray(f.path)) groups.push(f.path);
      if (f.axis != null) groups.push([f.axis]);
      for (const g of groups) for (const id of g) if (!objs.has(id)) add("feature.ref", f.id, "fonction " + f.type + " : objet " + id + " introuvable");
      if (f.type === "pattern" && !features.some(x => x.id === f.source)) add("feature.source", f.id, "répétition : fonction source " + (f.source || "?") + " introuvable");
    }
    return { ok: !issues.length, total: issues.length, issues: issues };
  }

  /** The repair S.diagnose can apply without guessing geometry: drop what points at nothing, drop zero-length lines
   * and degenerate circles/arcs, detach sketches from a face whose part is gone, forget dangling sketch tags.
   * Returns a NEW document, the list of what changed, and what it could not fix safely (`left`, e.g. a 3D feature
   * whose profile disappeared stays untouched: removing it would destroy the part). */
  function repair(doc) {
    const d = clone(doc);
    d.sketches = d.sketches || [];
    const actions = [];
    const skIds = new Set(d.sketches.map(s => s.id));
    const base = (d.features || [])[0];
    if (!base || base.op === "cut") {
      for (const s of d.sketches) if (s.face != null) {
        actions.push({ kind: "sketch.face", id: s.id, message: "esquisse « " + (s.name || s.id) + " » détachée de la face disparue" });
        delete s.face;
      }
    }
    for (const p of d.points) if (p.sketch && !skIds.has(p.sketch)) delete p.sketch;
    // objects: repeat until stable, since dropping a circle can leave a Ø cote pointing at nothing
    for (let pass = 0; pass < 4; pass++) {
      const pts = new Map(d.points.map(p => [p.id, p]));
      const n0 = d.objects.length;
      d.objects = d.objects.filter(o => {
        if (o.sketch && !skIds.has(o.sketch)) { actions.push({ kind: "object.sketch", id: o.id, message: (DIAG_LABEL[o.type] || o.type) + " " + o.id + " retiré (esquisse " + o.sketch + " disparue)" }); return false; }
        const need = o.type === "arc" ? ["center", "p1", "p2"] : (LINE_TYPES[o.type] ? ["p1", "p2"] : (o.type === "circle" || o.type === "ellipse" ? ["center"] : (o.type === "spline" ? (o.pts || []) : [])));
        const miss = need.filter(k => !pts.has(o[k]));
        if (miss.length) { actions.push({ kind: "object.point", id: o.id, message: (DIAG_LABEL[o.type] || o.type) + " " + o.id + " retiré (point " + miss[0] + " introuvable)" }); return false; }
        if (LINE_TYPES[o.type]) {
          const a = pts.get(o.p1), b = pts.get(o.p2);
          if (o.p1 === o.p2 || (a && b && Math.hypot(b.x - a.x, b.y - a.y) <= 1e-6)) { actions.push({ kind: "line.zero", id: o.id, message: (DIAG_LABEL[o.type] || o.type) + " " + o.id + " retiré (longueur nulle)" }); return false; }
        }
        if (o.type === "arc" && (o.center === o.p1 || o.center === o.p2 || o.p1 === o.p2)) { actions.push({ kind: "arc.degenerate", id: o.id, message: "Arc " + o.id + " retiré (points confondus)" }); return false; }
        if (o.type === "circle" && !(o.r > 0)) { actions.push({ kind: "circle.degenerate", id: o.id, message: "Cercle " + o.id + " retiré (rayon nul)" }); return false; }
        if (isRadialDim(o) && !d.objects.some(x => x.id === o.item)) { actions.push({ kind: "dim.item", id: o.id, message: "Cote " + o.id + " retirée (cercle " + o.item + " introuvable)" }); return false; }
        return true;
      });
      if (d.objects.length === n0) break;
    }
    const objs = new Set(d.objects.map(o => o.id)), pts2 = new Set(d.points.map(p => p.id));
    d.constraints = d.constraints.filter(k => {
      const refs = [];
      if (k.line != null) refs.push(["ligne", k.line, objs]);
      if (k.item != null) refs.push(["objet", k.item, objs]);
      if (k.point != null) refs.push(["point", k.point, pts2]);
      if (k.vertex != null) refs.push(["sommet", k.vertex, pts2]);
      for (const l of k.lines || []) refs.push(["ligne", l, objs]);
      for (const i of k.items || []) refs.push(["objet", i, objs]);
      const bad = refs.find(r => !r[2].has(r[1]));
      if (!bad) return true;
      actions.push({ kind: "constraint.ref", id: k.id, message: "Contrainte " + k.type + " " + k.id + " retirée (" + bad[0] + " " + bad[1] + " introuvable)" });
      return false;
    });
    const v = validateDoc(d);
    return { ok: v.ok, error: v.ok ? "" : v.error, doc: d, actions: actions, left: diagnose(d).issues };
  }

  /** Minimal DXF reader for the ENTITIES section: LINE, CIRCLE, ARC and LWPOLYLINE with their layers.
   * Anything else is counted in `skipped`; malformed pairs are ignored rather than trusted. */
  function parseDXF(text) {
    const raw = String(text || "").split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const code = Number(raw[i].trim());
      if (!isFinite(code)) continue;
      pairs.push([code, raw[i + 1]]);
    }
    const out = { entities: [], layers: [], units: "", skipped: 0 };
    const num = v => Number(String(v == null ? "" : v).trim());
    const seenLayer = new Set();
    let inEntities = false;
    for (let i = 0; i < pairs.length; i++) {
      const [code, value] = pairs[i];
      if (code === 9 && String(value).trim() === "$INSUNITS") {
        const next = pairs[i + 1];
        const unit = next && next[0] === 70 ? { 1: "in", 2: "ft", 4: "mm", 5: "cm", 6: "m" }[num(next[1])] : "";
        if (unit && unit !== "ft") out.units = out.units || unit;
        continue;
      }
      if (code !== 0) continue;
      const name = String(value || "").trim().toUpperCase();
      if (name === "SECTION") {
        const next = pairs[i + 1];
        inEntities = !!(next && next[0] === 2 && String(next[1]).trim().toUpperCase() === "ENTITIES");
        i += 1;
        continue;
      }
      if (name === "ENDSEC") { inEntities = false; continue; }
      if (!inEntities) continue;
      if (name !== "LINE" && name !== "CIRCLE" && name !== "ARC" && name !== "LWPOLYLINE") { out.skipped++; continue; }
      const layerOf = "0";
      let layer = layerOf;
      const xs = [], ys = [], g = {};
      let j = i + 1;
      for (; j < pairs.length && pairs[j][0] !== 0; j++) {
        const c = pairs[j][0], v = pairs[j][1];
        if (c === 8) layer = String(v || "").trim() || layerOf;
        else if (c === 10) xs.push(num(v));
        else if (c === 20) ys.push(num(v));
        else if (c === 11) xs.push(num(v)); // LINE second point (DXF 11/21), read like a polyline vertex
        else if (c === 21) ys.push(num(v));
        else if (c === 40) g.r = num(v);
        else if (c === 50) g.a0 = num(v);
        else if (c === 51) g.a1 = num(v);
        else if (c === 70) g.flags = num(v);
      }
      i = j - 1;
      if (!seenLayer.has(layer)) { seenLayer.add(layer); out.layers.push(layer); }
      const fin = v => typeof v === "number" && isFinite(v);
      if (name === "LINE") {
        if (!(xs.length >= 2 && ys.length >= 2) || !fin(xs[0]) || !fin(ys[0]) || !fin(xs[1]) || !fin(ys[1])) { out.skipped++; continue; }
        out.entities.push({ type: "line", layer: layer, a: [xs[0], ys[0]], b: [xs[1], ys[1]] });
      } else if (name === "CIRCLE") {
        if (!fin(xs[0]) || !fin(ys[0]) || !fin(g.r) || !(g.r > 0)) { out.skipped++; continue; }
        out.entities.push({ type: "circle", layer: layer, c: [xs[0], ys[0]], r: g.r });
      } else if (name === "ARC") {
        if (!fin(xs[0]) || !fin(ys[0]) || !fin(g.r) || !(g.r > 0) || !fin(g.a0) || !fin(g.a1)) { out.skipped++; continue; }
        out.entities.push({ type: "arc", layer: layer, c: [xs[0], ys[0]], r: g.r, a0: g.a0, a1: g.a1 });
      } else {
        const pts = [];
        for (let k = 0; k < Math.min(xs.length, ys.length); k++) if (fin(xs[k]) && fin(ys[k])) pts.push([xs[k], ys[k]]);
        if (pts.length < 2) { out.skipped++; continue; }
        out.entities.push({ type: "poly", layer: layer, pts: pts, closed: !!(Number(g.flags) & 1) });
      }
    }
    return out;
  }

  /** Put parsed DXF geometry into a new sketch of `doc` (fresh points, same ids rule as the editor). */
  function importDXF(doc, parsed, opts) {
    const o = opts || {};
    if (!parsed || !Array.isArray(parsed.entities) || !parsed.entities.length) return { ok: false, error: "Aucune forme DXF reconnue" };
    const made = addSketch(doc, o.plane && SKETCH_PLANES[o.plane] ? o.plane : "XY", Number(o.offset) || 0, String(o.name || "DXF"));
    if (!made.ok) return made;
    const d = made.doc, sk = made.id;
    const scale = o.units && UNIT_MM[o.units] && UNIT_MM[d.units] ? UNIT_MM[o.units] / UNIT_MM[d.units] : 1;
    const created = new Set([sk]); // what THIS import added: only that may refuse the import (see the end)
    const mk = (x, y) => { const id = newId(d, "p"); created.add(id); d.points.push({ id: id, x: round6(x * scale), y: round6(y * scale), sketch: sk }); return id; };
    const put = ob => { created.add(ob.id); d.objects.push(ob); };
    let added = 0;
    const seg = (a, b) => {
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.abs(scale) < EPS) return;
      const p1 = mk(a[0], a[1]), p2 = mk(b[0], b[1]);
      put({ id: newId(d, "l"), type: "line", p1: p1, p2: p2, sketch: sk });
      added++;
    };
    for (const e of parsed.entities) {
      if (e.type === "line") seg(e.a, e.b);
      else if (e.type === "circle") {
        if (!(e.r * Math.abs(scale) > EPS)) continue;
        const c = mk(e.c[0], e.c[1]);
        put({ id: newId(d, "c"), type: "circle", center: c, r: round6(Math.abs(e.r * scale)), sketch: sk });
        added++;
      } else if (e.type === "arc") {
        if (!(e.r * Math.abs(scale) > EPS)) continue;
        const a0 = e.a0 * Math.PI / 180, a1 = e.a1 * Math.PI / 180;
        if (Math.abs(((a1 - a0) % (Math.PI * 2))) < 1e-9) continue; // a full turn is a circle, not an arc
        const p1 = mk(e.c[0] + Math.cos(a0) * e.r, e.c[1] + Math.sin(a0) * e.r);
        const p2 = mk(e.c[0] + Math.cos(a1) * e.r, e.c[1] + Math.sin(a1) * e.r);
        const c = mk(e.c[0], e.c[1]);
        put({ id: newId(d, "c"), type: "arc", center: c, p1: p1, p2: p2, sketch: sk });
        added++;
      } else if (e.type === "poly") {
        for (let i = 1; i < e.pts.length; i++) seg(e.pts[i - 1], e.pts[i]);
        if (e.closed && e.pts.length > 2) seg(e.pts[e.pts.length - 1], e.pts[0]);
      }
    }
    d.version = Math.max(Number(d.version) || 1, SKETCH_VERSION);
    if (!added) return { ok: false, error: "Aucune forme DXF reconnue" };
    const v = validateDoc(d);
    if (!v.ok) {
      // a drawing that is already damaged must not make a good import fail: only the imported geometry may refuse it
      const mine = diagnose(d).issues.find(i => created.has(i.id));
      if (mine) return { ok: false, error: "DXF importé refusé : " + mine.message };
    }
    return { ok: true, doc: d, sketch: sk, added: added, skipped: parsed.skipped || 0 };
  }

  // ---------------------------------------------------------------- transforms, arrays, sketches
  /** Bounding box of a set of objects, in model units. */
  function selectionBox(doc, objs) {
    const pm = pointMap(doc);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const see = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
    for (const o of objs) {
      if (isLine(o)) { const a = pm.get(o.p1), b = pm.get(o.p2); if (a && b) { see(a.x, a.y); see(b.x, b.y); } }
      else if (o.type === "circle" || o.type === "arc") {
        const c = pm.get(o.center); if (!c) continue;
        const r = o.type === "circle" ? o.r : arcGeom(o, pm).r;
        see(c.x - r, c.y - r); see(c.x + r, c.y + r);
      } else if (o.type === "stroke") o.pts.forEach(p => see(p[0], p[1]));
      else if (o.type === "text") see(o.x, o.y);
      else if (o.type === "dim_linear" || o.type === "dim_angle") { see(o.a[0], o.a[1]); see(o.b[0], o.b[1]); if (o.c) see(o.c[0], o.c[1]); }
      else if (isRadialDim(o)) { const g = dimRadialGeom(doc, o); if (g) { see(g.c[0] - g.r, g.c[1] - g.r); see(g.c[0] + g.r, g.c[1] + g.r); } }
    }
    return isFinite(x0) ? { x0: x0, y0: y0, x1: x1, y1: y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 } : null;
  }

  /** Rigid / uniform transforms on a selection: rotate, mirror, scale. Points shared with other objects move with it
   * (the same rule as dragging a point), a mirrored arc keeps its visible span, and a scale that would break a
   * driving constraint is refused like any other edit. */
  function transformObjects(doc, ids, op) {
    const list = (ids || []).filter(id => getObj(doc, id));
    if (!list.length) return { ok: false, error: "Sélectionne un objet" };
    const kind = op && op.kind;
    if (kind !== "rotate" && kind !== "mirror" && kind !== "scale") return { ok: false, error: "Transformation inconnue" };
    const d = clone(doc);
    const objs = list.map(id => getObj(d, id)).filter(Boolean);
    const box = selectionBox(d, objs);
    if (!box) return { ok: false, error: "Rien à transformer" };
    const cx = isFinite(Number(op.cx)) ? Number(op.cx) : box.cx;
    const cy = isFinite(Number(op.cy)) ? Number(op.cy) : box.cy;
    let map, k = 1;
    if (kind === "rotate") {
      const deg = Number(op.angle);
      if (!isFinite(deg)) return { ok: false, error: "Angle invalide" };
      const a = deg * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
      map = (x, y) => [cx + (x - cx) * co - (y - cy) * si, cy + (x - cx) * si + (y - cy) * co];
    } else if (kind === "mirror") {
      map = op.axis === "h" ? (x, y) => [x, 2 * cy - y] : (x, y) => [2 * cx - x, y];
    } else {
      k = Number(op.factor);
      if (!(k > 0) || !isFinite(k)) return { ok: false, error: "Facteur d'échelle invalide" };
      map = (x, y) => [cx + (x - cx) * k, cy + (y - cy) * k];
    }
    const pm = pointMap(d), pts = new Set();
    for (const o of objs) for (const key of ["p1", "p2", "center"]) if (o[key]) pts.add(o[key]);
    for (const pid of pts) {
      const p = pm.get(pid); if (!p) continue;
      const q = map(p.x, p.y);
      p.x = round6(q[0]); p.y = round6(q[1]);
    }
    for (const o of objs) {
      if (o.type === "circle") { if (kind === "scale") o.r = round6(o.r * k); }
      else if (o.type === "stroke") o.pts = o.pts.map(p => { const q = map(p[0], p[1]); return [round6(q[0]), round6(q[1])]; });
      else if (o.type === "text") { const q = map(o.x, o.y); o.x = round6(q[0]); o.y = round6(q[1]); if (kind === "scale") o.h = round6(o.h * k); }
      else if (o.type === "dim_linear") {
        const a = map(o.a[0], o.a[1]), b = map(o.b[0], o.b[1]);
        o.a = [round6(a[0]), round6(a[1])]; o.b = [round6(b[0]), round6(b[1])];
        if (kind === "scale") o.offset = round6((Number(o.offset) || 0) * k);
      } else if (o.type === "dim_angle") {
        const a = map(o.a[0], o.a[1]), b = map(o.b[0], o.b[1]), c = map(o.c[0], o.c[1]);
        o.a = [round6(a[0]), round6(a[1])]; o.b = [round6(b[0]), round6(b[1])]; o.c = [round6(c[0]), round6(c[1])];
        if (kind === "scale") o.r = round6(o.r * k);
      }
      if (kind === "mirror" && o.type === "arc") { const t = o.p1; o.p1 = o.p2; o.p2 = t; } // keep the same visible span
    }
    if (kind === "scale") {
      // shrinking already tiny geometry used to end at two points rounded onto each other: a line of length zero that
      // still validates. Refuse it instead of writing a degenerate drawing.
      for (const o of objs) {
        if (isLine(o)) { const a = pm.get(o.p1), b = pm.get(o.p2); if (a && b && Math.hypot(b.x - a.x, b.y - a.y) <= 1e-6) return { ok: false, error: "Échelle refusée : une ligne deviendrait de longueur nulle" }; }
        if (o.type === "circle" && !(o.r > 1e-6)) return { ok: false, error: "Échelle refusée : un cercle perdrait son rayon" };
      }
    }
    return refuseIfBroken(d, "Transformation");
  }

  /** Copies of a selection along a step (linear) or around its centre (circular). Copies never share points, so editing
   * one copy never deforms another; groups get a per-copy suffix so they stay separate. */
  function arrayObjects(doc, ids, op) {
    const list = (ids || []).filter(id => getObj(doc, id));
    if (!list.length) return { ok: false, error: "Sélectionne un objet" };
    const count = Math.floor(Number(op && op.count));
    if (!(count >= 2 && count <= 50)) return { ok: false, error: "Nombre entre 2 et 50" };
    const mode = op && op.mode === "circular" ? "circular" : "linear";
    const src = list.map(id => getObj(doc, id)).filter(Boolean);
    const box = selectionBox(doc, src);
    if (!box) return { ok: false, error: "Rien à répéter" };
    const d = clone(doc), pm = pointMap(d);
    const cx = isFinite(Number(op.cx)) ? Number(op.cx) : box.cx;
    const cy = isFinite(Number(op.cy)) ? Number(op.cy) : box.cy;
    const total = mode === "circular" ? (Number(op.angle) || 360) : 0;
    const dx = Number(op.dx) || 0, dy = Number(op.dy) || 0;
    if (mode === "linear" && !dx && !dy) return { ok: false, error: "Indique un pas X ou Y" };
    for (let n = 1; n < count; n++) {
      let map;
      if (mode === "circular") {
        const a = (total / count) * n * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
        map = (x, y) => [cx + (x - cx) * co - (y - cy) * si, cy + (x - cx) * si + (y - cy) * co];
      } else map = (x, y) => [x + dx * n, y + dy * n];
      const remap = new Map();
      const point = pid => {
        if (remap.has(pid)) return remap.get(pid);
        const p = pm.get(pid);
        if (!p) return null;
        const q = map(p.x, p.y);
        const np = { id: newId(d, "p"), x: round6(q[0]), y: round6(q[1]) };
        if (p.sketch) np.sketch = p.sketch;
        d.points.push(np);
        remap.set(pid, np.id);
        return np.id;
      };
      for (const o of src) {
        const c = clone(o);
        c.id = newId(d, String(o.id)[0] || "o");
        if (c.p1) c.p1 = point(c.p1);
        if (c.p2) c.p2 = point(c.p2);
        if (c.center) c.center = point(c.center);
        if (c.type === "stroke") c.pts = c.pts.map(p => { const q = map(p[0], p[1]); return [round6(q[0]), round6(q[1])]; });
        if (c.type === "text") { const q = map(c.x, c.y); c.x = round6(q[0]); c.y = round6(q[1]); }
        if (c.type === "dim_linear") {
          const a = map(c.a[0], c.a[1]), b = map(c.b[0], c.b[1]);
          c.a = [round6(a[0]), round6(a[1])]; c.b = [round6(b[0]), round6(b[1])];
        }
        if (c.type === "dim_angle") {
          const a = map(c.a[0], c.a[1]), b = map(c.b[0], c.b[1]), q = map(c.c[0], c.c[1]);
          c.a = [round6(a[0]), round6(a[1])]; c.b = [round6(b[0]), round6(b[1])]; c.c = [round6(q[0]), round6(q[1])];
        }
        if (c.group) c.group = c.group + "-" + n;
        d.objects.push(c);
      }
    }
    return { ok: true, doc: d };
  }

  /** Rename or lock a sketch. A locked sketch keeps its geometry: the editor refuses to draw in it. */
  function updateSketch(doc, id, patch) {
    const d = clone(doc), list = d.sketches || [];
    const sk = list.find(x => x.id === id);
    if (!sk) return { ok: false, error: "Esquisse introuvable" };
    if (patch && patch.name != null) {
      const name = String(patch.name).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 40);
      if (name) sk.name = name;
    }
    if (patch && patch.locked != null) { if (patch.locked) sk.locked = true; else delete sk.locked; }
    if (patch && patch.hidden != null) { if (patch.hidden) sk.hidden = true; else delete sk.hidden; }
    return { ok: true, doc: d };
  }

  function moveSketch(doc, id, dir) {
    const d = clone(doc), list = d.sketches || [];
    const i = list.findIndex(x => x.id === id), j = i + (dir < 0 ? -1 : 1);
    if (i < 0) return { ok: false, error: "Esquisse introuvable" };
    if (j < 0 || j >= list.length) return { ok: false, error: "Déjà en bout de liste" };
    const t = list[i]; list[i] = list[j]; list[j] = t;
    return { ok: true, doc: d };
  }

  /** Remove a sketch with its geometry. Refused while a 3D function is built on one of its objects. */
  function removeSketch(doc, id) {
    const d = clone(doc), list = d.sketches || [];
    if (!list.some(x => x.id === id)) return { ok: false, error: "Esquisse introuvable" };
    const objs = d.objects.filter(o => sketchOf(o) === id).map(o => o.id);
    const mine = new Set(objs);
    const used = (d.features || []).some(f => (f.profile || []).concat(f.at || [], f.path || []).some(x => mine.has(x)));
    if (used) return { ok: false, error: "Une fonction 3D utilise cette esquisse : retire la fonction d'abord" };
    const next = objs.length ? deleteObjects(d, objs) : d;
    next.sketches = (next.sketches || []).filter(x => x.id !== id);
    const alive = new Set(next.objects.map(o => o.id));
    next.constraints = next.constraints.filter(k => !(k.line && !alive.has(k.line)) && !(k.lines && k.lines.some(x => !alive.has(x))));
    return { ok: true, doc: next };
  }

  // ---------------------------------------------------------------- history + drafts
  function createHistory(limit) {
    const max = limit || 100;
    const h = { past: [], future: [] };
    h.push = doc => { h.past.push(JSON.stringify(doc)); if (h.past.length > max) h.past.shift(); h.future = []; };
    h.undo = cur => { if (!h.past.length) return null; h.future.push(JSON.stringify(cur)); return JSON.parse(h.past.pop()); };
    h.redo = cur => { if (!h.future.length) return null; h.past.push(JSON.stringify(cur)); return JSON.parse(h.future.pop()); };
    h.canUndo = () => h.past.length > 0;
    h.canRedo = () => h.future.length > 0;
    h.clear = () => { h.past = []; h.future = []; };
    return h;
  }

  function saveDraft(storage, state, key) {
    try {
      storage.setItem(key || DRAFT_KEY, JSON.stringify({ v: 1, at: Date.now(), name: state.name || "", stem: state.stem || "", dirty: !!state.dirty,
        objects: state.doc && state.doc.objects ? state.doc.objects.length : 0, baseObjects: Number(state.baseObjects) || 0, doc: state.doc }));
      return true;
    } catch (_) { return false; }
  }
  function loadDraft(storage, key) {
    let raw;
    try { raw = storage.getItem(key || DRAFT_KEY); } catch (_) { return null; }
    if (!raw) return null;
    try {
      const d = JSON.parse(raw);
      if (!d || d.v !== 1 || !validateDoc(d.doc).ok) return null;
      return { doc: d.doc, name: String(d.name || ""), stem: String(d.stem || ""), dirty: !!d.dirty, at: Number(d.at) || 0,
        objects: Number(d.objects) || (d.doc.objects ? d.doc.objects.length : 0), baseObjects: Number(d.baseObjects) || 0 };
    } catch (_) { return null; }
  }
  function clearDraft(storage, key) { try { storage.removeItem(key || DRAFT_KEY); } catch (_) {} }

  return {
    FORMAT, VERSION, DRAFT_KEY, UNIT_MM, LIMITS,
    clone, createDoc, newId, pointMap, getObj, isLine, addPoint, findPointNear, addLine, addRect, addCircle, addStroke, strokePx, STROKE_WIDTH_VERSION,
    addSolidStep, updateFeature, setCircleRadius, SOLID_V5_VERSION, HOLE_STANDARDS, HOLE_FITS,
    SKETCH_VERSION, SKETCH_PLANES, GEO_CONSTRAINTS, diagnose, repair, perfStats, budgetOk, DRAW_BUDGET, parseDXF, importDXF, inSketch, visibleView, withSketch, addSketch, addArc, arcGeom, solve, freedom, sketchReport,
    addEllipse, addSpline, addSlot, addPolygon, setConstruction, closedCurve, profileObject, offsetObjects, mirrorObjects, trimObject, extendObject, convertRing, convertToSketch, describeConstraint, splineSamples, outlineFromTriangles,
    addDimDiameter, addDimRadius, dimRadialGeom, dimRadialLabel, isRadialDim, objectBox, buildHitIndex, hitTestIndexed, hitAllIndexed,
    addConstraint, moveFeature, setRollback, sketchOf,
    transformObjects, arrayObjects, updateSketch, moveSketch, removeSketch, selectionBox,
    addText, addDimLinear, addDimAngle, measureLinear, measureAngle, linesAtPoint, otherEnd, sharedVertex, lineLength,
    angleBetween, component, checkConstraints, setLineLength, setAngle, removeConstraint, addFeature, removeFeature, addFaceFeature, removeFaceFeature, addRoundFeature, removeRoundFeature, moveObjects, movePoint, deleteObjects,
    updateObject, hitTest, hitAll, objectDistance, dimLinearGeom, textBox, snapGrid, snapAngle, snapSegmentEnd, simplify,
    convertUnits, fmt, extents, extentsWith, underlayRect, checkUnderlay, UNDERLAY_BOX_MM, toScreen, toModel, zoomAt, fitView, sourceHint, validateDoc, createHistory,
    evalExpr, evalParams, addParam, updateParam, removeParam, paramList, setDimDrive, clearDimDrive, syncDrivenDims, applyParameters, dimDrive,
    featureRows, activeFeatures, setFeatureSuppressed, setFeatureRollback, moveFeatureTo, applyFeatureValues,
    recognizeStroke, applyStrokeShape,
    saveDraft, loadDraft, clearDraft,
  };
});
