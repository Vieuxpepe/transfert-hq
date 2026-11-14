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
    return k.type === "length" ? "longueur " + k.line + " = " + fmt(k.value) + " " + doc.units
      : "angle " + k.lines.join("/") + " = " + fmt(k.value) + "°";
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
    if (!Array.isArray(profile) || !profile.length || profile.length > 500 || new Set(profile).size !== profile.length) return { ok: false, error: "Sélectionne un contour fermé" };
    const known = new Map(d.objects.map(o => [o.id, o.type]));
    if (profile.some(id => !["line", "circle"].includes(known.get(id)))) return { ok: false, error: "Seules les lignes et les cercles forment un solide" };
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
    if ("label" in patch && (o.type === "dim_linear" || o.type === "dim_angle")) o.label = String(patch.label || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, LIMITS.text);
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
    if (isLine(o)) { const a = pm.get(o.p1), b = pm.get(o.p2); return segDist(x, y, a.x, a.y, b.x, b.y); }
    if (o.type === "circle") { const c = pm.get(o.center); return Math.abs(Math.hypot(x - c.x, y - c.y) - o.r); }
    if (o.type === "arc") return arcDistance(o, pm, x, y);
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
    return Infinity;
  }

  const HIT_ORDER = { text: 0, dim_linear: 1, dim_angle: 1, line: 2, centerline: 2, circle: 3, arc: 3, stroke: 4 };
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

  function dimLinearGeom(o) {
    const dx = o.b[0] - o.a[0], dy = o.b[1] - o.a[1], L = Math.hypot(dx, dy);
    if (L < EPS) return null;
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const a2 = [o.a[0] + nx * o.offset, o.a[1] + ny * o.offset], b2 = [o.b[0] + nx * o.offset, o.b[1] + ny * o.offset];
    return { L: L, u: [ux, uy], n: [nx, ny], a2: a2, b2: b2, mid: [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2] };
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
      if (isLine(o)) { const a = pm.get(o.p1), b = pm.get(o.p2); add(a.x, a.y); add(b.x, b.y); }
      else if (o.type === "circle") { const c = pm.get(o.center); add(c.x - o.r, c.y - o.r); add(c.x + o.r, c.y + o.r); }
      else if (o.type === "stroke") o.pts.forEach(p => add(p[0], p[1]));
      else if (o.type === "text") { const b = textBox(o); add(b[0], b[1]); add(b[2], b[3]); }
      else if (o.type === "dim_linear") { const g = dimLinearGeom(o); add(o.a[0], o.a[1]); add(o.b[0], o.b[1]); if (g) { add(g.a2[0], g.a2[1]); add(g.b2[0], g.b2[1]); } }
      else if (o.type === "dim_angle") { add(o.c[0] - o.r, o.c[1] - o.r); add(o.c[0] + o.r, o.c[1] + o.r); }
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
  const GEO_CONSTRAINTS = ["horizontal", "vertical", "parallel", "perpendicular", "equal", "tangent", "radius", "fixed"];
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
  function arcGeom(o, pm) {
    const c = pm.get(o.center), a = pm.get(o.p1), b = pm.get(o.p2);
    const r = Math.hypot(a.x - c.x, a.y - c.y);
    const t0 = Math.atan2(a.y - c.y, a.x - c.x), t1 = Math.atan2(b.y - c.y, b.x - c.x);
    let sweep = (t1 - t0) % (2 * Math.PI); if (sweep <= 0) sweep += 2 * Math.PI;
    return { c: c, r: r, t0: t0, sweep: sweep, a: a, b: b };
  }
  function arcDistance(o, pm, x, y) {
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
    }
    const vars = [];
    for (const pid of geomPts) {
      const p = pm.get(pid);
      if (!p || fixed.has(pid)) continue;
      vars.push({ key: pid, axis: "x", get: () => p.x, set: v => { p.x = v; } });
      vars.push({ key: pid, axis: "y", get: () => p.y, set: v => { p.y = v; } });
    }
    for (const o of doc.objects) if (o.type === "circle") vars.push({ key: o.id, axis: "r", get: () => o.r, set: v => { o.r = v; } });
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
      else if (k.type === "parallel" || k.type === "perpendicular") f = () => {
        const u = vec(k.items[0]), w = vec(k.items[1]), nu = Math.hypot(u[0], u[1]) || 1, nw = Math.hypot(w[0], w[1]) || 1, s = (nu + nw) / 2;
        return (k.type === "parallel" ? (u[0] * w[1] - u[1] * w[0]) : (u[0] * w[0] + u[1] * w[1])) / (nu * nw) * s;
      };
      else if (k.type === "equal") f = () => {
        const [a, b] = k.items;
        if (LINE_TYPES[(objs.get(a) || {}).type]) { const u = vec(a), w = vec(b); return Math.hypot(u[0], u[1]) - Math.hypot(w[0], w[1]); }
        return round(a).r - round(b).r;
      };
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
    }
    return { dof: n - pivots.length, defined: defined };
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
    if (!s.ok) return { ok: false, error: "Contrainte refusée : " + s.error.toLowerCase() };
    return { ok: true, doc: s.doc, id: item.id };
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
      const pm = pointMap(doc), kinds = new Map();
      for (const o of doc.objects) {
        claim(o.id);
        kinds.set(o.id, o.type);
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
        else if (o.type !== "dim_linear" && o.type !== "dim_angle") throw new Error("Type inconnu : " + o.type);
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
          else if (k.type === "equal") ok = two && (k.items.every(isL) || k.items.every(isR));
          else ok = two && ((isL(k.items[0]) && isR(k.items[1])) || (isR(k.items[0]) && isL(k.items[1])) || k.items.every(isR));
          if (!ok) throw new Error("Contrainte invalide : " + k.type);
        }
        else throw new Error("Contrainte inconnue");
      }
      const features = doc.features || [];
      if (!Array.isArray(features) || features.length > 50 || (doc.version === 1 && features.length)) throw new Error("Fonctions 3D invalides");
      const typeOf = id => doc.objects.find(o => o.id === id)?.type;
      const profileKinds = v6 ? ["line", "circle", "arc"] : ["line", "circle"];
      const profileOk = p => Array.isArray(p) && p.length && p.length <= 500 && new Set(p).size === p.length && p.every(id => profileKinds.includes(typeOf(id)));
      const refOk = e => e && ["a", "b", "m"].every(k => Array.isArray(e[k]) && e[k].length === 3 && e[k].every(num));
      let shells = 0;
      for (let i = 0; i < features.length; i++) {
        const f = features[i]; claim(f.id);
        const allowed = v6 ? (i === 0 ? ["extrude", "revolve", "sweep", "loft"] : ["extrude", "revolve", "sweep", "loft", "cut", "hole", "shell", "pattern", "fillet", "chamfer"])
          : (i === 0 ? ["extrude", "revolve"] : ["cut", "hole", "shell", "pattern"]);
        if (!allowed.includes(f.type)) throw new Error("Une pièce de base, puis des coupes, trous, coques ou répétitions");
        if (!v6 && ["op", "reverse", "both", "suppressed"].some(k => f[k] != null)) throw new Error("Option de la version 6");
        if (v6 && f.op != null && (!["add", "cut"].includes(f.op) || (i === 0 && f.op !== "add"))) throw new Error("Opération invalide");
        if (V5_TYPES.includes(f.type) && doc.version < SOLID_V5_VERSION) throw new Error("Fonction 3D de version 5");
        if (f.type === "extrude" || f.type === "cut") {
          if (!profileOk(f.profile)) throw new Error("Profil 3D invalide");
          if (["reverse", "both", "suppressed"].some(k => f[k] != null && typeof f[k] !== "boolean")) throw new Error("Option invalide");
          if (!num(f.depth) || f.depth < 0 || (f.extent !== "throughAll" && f.depth <= 0) || !["blind", "throughAll"].includes(f.extent) || (f.type === "extrude" && f.extent !== "blind")) throw new Error("Profondeur 3D invalide");
        } else if (f.type === "revolve") {
          if (!profileOk(f.profile)) throw new Error("Profil 3D invalide");
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
          if (!profileOk(f.profile) || !Array.isArray(f.path) || !f.path.length || f.path.some(id => !["line", "arc"].includes(typeOf(id)))) throw new Error("Balayage invalide");
        } else if (f.type === "loft") {
          if (!Array.isArray(f.profiles) || f.profiles.length < 2 || f.profiles.length > 10 || !f.profiles.every(profileOk)) throw new Error("Lissage invalide");
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
      storage.setItem(key || DRAFT_KEY, JSON.stringify({ v: 1, at: Date.now(), name: state.name || "", stem: state.stem || "", dirty: !!state.dirty, doc: state.doc }));
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
      return { doc: d.doc, name: String(d.name || ""), stem: String(d.stem || ""), dirty: !!d.dirty, at: Number(d.at) || 0 };
    } catch (_) { return null; }
  }
  function clearDraft(storage, key) { try { storage.removeItem(key || DRAFT_KEY); } catch (_) {} }

  return {
    FORMAT, VERSION, DRAFT_KEY, UNIT_MM, LIMITS,
    clone, createDoc, newId, pointMap, getObj, isLine, addPoint, findPointNear, addLine, addRect, addCircle, addStroke, strokePx, STROKE_WIDTH_VERSION,
    addSolidStep, updateFeature, setCircleRadius, SOLID_V5_VERSION, HOLE_STANDARDS, HOLE_FITS,
    SKETCH_VERSION, SKETCH_PLANES, GEO_CONSTRAINTS, inSketch, withSketch, addSketch, addArc, arcGeom, solve, freedom,
    addConstraint, moveFeature, setRollback, sketchOf,
    addText, addDimLinear, addDimAngle, measureLinear, measureAngle, linesAtPoint, otherEnd, sharedVertex, lineLength,
    angleBetween, component, checkConstraints, setLineLength, setAngle, removeConstraint, addFeature, removeFeature, addFaceFeature, removeFaceFeature, addRoundFeature, removeRoundFeature, moveObjects, movePoint, deleteObjects,
    updateObject, hitTest, hitAll, objectDistance, dimLinearGeom, textBox, snapGrid, snapAngle, snapSegmentEnd, simplify,
    convertUnits, fmt, extents, extentsWith, underlayRect, checkUnderlay, UNDERLAY_BOX_MM, toScreen, toModel, zoomAt, fitView, sourceHint, validateDoc, createHistory,
    saveDraft, loadDraft, clearDraft,
  };
});
