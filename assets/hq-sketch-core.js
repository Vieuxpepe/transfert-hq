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
  const DRAFT_KEY = "tf_hq_sketch_draft_v1";
  const UNIT_MM = { mm: 1, cm: 10, m: 1000, in: 25.4 };
  const LINE_TYPES = { line: 1, centerline: 1 };
  const EPS = 1e-9;
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

  function addStroke(doc, pts, tol) {
    if (!pts || !pts.length) return null;
    let arr = pts.map(p => [round6(p[0]), round6(p[1])]);
    if (tol > 0) arr = simplify(arr, tol);
    if (arr.length > LIMITS.strokePts) arr = simplify(arr, (tol || 0.01) * 4).slice(0, LIMITS.strokePts);
    const id = newId(doc, "s");
    doc.objects.push({ id: id, type: "stroke", pts: arr });
    return id;
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
    const bad = checkConstraints(d);
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
      else if (o.type === "stroke") o.pts = o.pts.map(p => [round6(p[0] + dx), round6(p[1] + dy)]);
      else if (o.type === "text") { o.x = round6(o.x + dx); o.y = round6(o.y + dy); }
      else if (o.type === "dim_linear") { o.a = [o.a[0] + dx, o.a[1] + dy]; o.b = [o.b[0] + dx, o.b[1] + dy]; }
      else if (o.type === "dim_angle") { for (const k of ["c", "a", "b"]) o[k] = [o[k][0] + dx, o[k][1] + dy]; }
    }
    pts.forEach(pid => { const p = pm.get(pid); p.x = p.x + dx; p.y = p.y + dy; });
    return refuseIfBroken(d, "Déplacement");
  }

  function movePoint(doc, pid, x, y) {
    const d = clone(doc), p = pointMap(d).get(pid);
    if (!p) return { ok: false, error: "Point introuvable" };
    p.x = x; p.y = y;
    for (const l of linesAtPoint(d, pid)) {
      const pm = pointMap(d);
      if (dist(pm.get(l.p1), pm.get(l.p2)) < 1e-9) return { ok: false, error: "Refusé : la ligne " + l.id + " deviendrait nulle" };
    }
    return refuseIfBroken(d, "Déplacement");
  }

  function deleteObjects(doc, ids) {
    const d = clone(doc), set = new Set(ids);
    d.objects = d.objects.filter(o => !set.has(o.id));
    const alive = new Set(d.objects.filter(isLine).map(o => o.id));
    d.constraints = d.constraints.filter(k => k.type === "length" ? alive.has(k.line) : k.lines.every(l => alive.has(l)));
    const used = new Set();
    d.objects.forEach(o => { if (isLine(o)) { used.add(o.p1); used.add(o.p2); } else if (o.type === "circle") used.add(o.center); });
    d.points = d.points.filter(p => used.has(p.id));
    d.features = (d.features || []).filter(f => !f.profile.some(id => set.has(id)));
    if (!d.features.length || d.features[0].type !== "extrude") { d.features = []; d.faceFeatures = []; }
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

  function removeFeature(doc, id) {
    const d = clone(doc), at = (d.features || []).findIndex(f => f.id === id);
    if (at < 0) return { ok: false, error: "Fonction introuvable" };
    d.features = at === 0 ? [] : d.features.filter(f => f.id !== id);
    if (at === 0) d.faceFeatures = [];
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
    d.version = 3;
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

  const HIT_ORDER = { text: 0, dim_linear: 1, dim_angle: 1, line: 2, centerline: 2, circle: 3, stroke: 4 };
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
    if (n < 3 || !(tol > 0)) return pts.map(p => [p[0], p[1]]);
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
    return pts.filter((_, i) => keep[i]).map(p => [p[0], p[1]]);
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
      else if (o.type === "stroke") o.pts = o.pts.map(sp);
      else if (o.type === "text") { o.x = s(o.x); o.y = s(o.y); o.h = s(o.h); }
      else if (o.type === "dim_linear") { o.a = sp(o.a); o.b = sp(o.b); o.offset = s(o.offset); }
      else if (o.type === "dim_angle") { o.c = sp(o.c); o.a = sp(o.a); o.b = sp(o.b); o.r = s(o.r); }
    });
    d.constraints.forEach(k => { if (k.type === "length") k.value = s(k.value); });
    (d.features || []).forEach(f => { f.depth = s(f.depth); });
    (d.faceFeatures || []).forEach(f => { f.depth = s(f.depth); f.profile = f.profile.map(sp); f.plane.origin = f.plane.origin.map(s); });
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
  function fitView(doc, W, H, margin) {
    const e = extents(doc), m = margin == null ? 40 : margin;
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

  // ---------------------------------------------------------------- validation (mirror of hq_drawings.validate_document, lighter)
  function validateDoc(doc) {
    try {
      if (!doc || typeof doc !== "object") throw new Error("Document invalide");
      if (doc.format !== FORMAT || ![1, 2, 3].includes(doc.version)) throw new Error("Format/version inconnus");
      if (!UNIT_MM[doc.units]) throw new Error("Unités invalides");
      if (!doc.grid || !(doc.grid.spacing > 0)) throw new Error("Grille invalide");
      for (const k of ["points", "objects", "constraints"]) if (!Array.isArray(doc[k])) throw new Error(k + " invalides");
      if (doc.points.length > LIMITS.points || doc.objects.length > LIMITS.objects || doc.constraints.length > LIMITS.constraints) throw new Error("Dessin trop volumineux");
      const ids = new Set(), pts = new Set(), lines = new Map();
      const idOk = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);
      const num = v => typeof v === "number" && isFinite(v) && Math.abs(v) <= LIMITS.coord;
      const claim = v => { if (!idOk(v) || ids.has(v)) throw new Error("Identifiant invalide : " + v); ids.add(v); };
      for (const p of doc.points) { claim(p.id); if (!num(p.x) || !num(p.y)) throw new Error("Point invalide"); pts.add(p.id); }
      for (const o of doc.objects) {
        claim(o.id);
        if (LINE_TYPES[o.type]) { if (!pts.has(o.p1) || !pts.has(o.p2) || o.p1 === o.p2) throw new Error("Ligne invalide"); lines.set(o.id, [o.p1, o.p2]); }
        else if (o.type === "circle") { if (!pts.has(o.center) || !(o.r > 0)) throw new Error("Cercle invalide"); }
        else if (o.type === "stroke") { if (!Array.isArray(o.pts) || !o.pts.length || o.pts.length > LIMITS.strokePts) throw new Error("Tracé invalide"); }
        else if (o.type === "text") { if (typeof o.text !== "string" || !o.text.trim() || !num(o.x) || !num(o.y)) throw new Error("Texte invalide"); }
        else if (o.type !== "dim_linear" && o.type !== "dim_angle") throw new Error("Type inconnu : " + o.type);
      }
      for (const k of doc.constraints) {
        claim(k.id);
        if (k.type === "length") { if (!lines.has(k.line) || !lines.get(k.line).includes(k.fixed)) throw new Error("Contrainte invalide"); }
        else if (k.type === "angle") { if (!Array.isArray(k.lines) || k.lines.length !== 2 || !k.lines.every(l => lines.has(l) && lines.get(l).includes(k.vertex))) throw new Error("Contrainte invalide"); }
        else throw new Error("Contrainte inconnue");
      }
      const features = doc.features || [];
      if (!Array.isArray(features) || features.length > 50 || (doc.version === 1 && features.length)) throw new Error("Fonctions 3D invalides");
      for (let i = 0; i < features.length; i++) {
        const f = features[i]; claim(f.id);
        if (f.type !== (i === 0 ? "extrude" : "cut") || !Array.isArray(f.profile) || !f.profile.length || f.profile.length > 500 || new Set(f.profile).size !== f.profile.length || f.profile.some(id => !["line", "circle"].includes(doc.objects.find(o => o.id === id)?.type))) throw new Error("Profil 3D invalide");
        if (!num(f.depth) || f.depth < 0 || (f.extent !== "throughAll" && f.depth <= 0) || !["blind", "throughAll"].includes(f.extent) || (f.type === "extrude" && f.extent !== "blind")) throw new Error("Profondeur 3D invalide");
      }
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
    clone, createDoc, newId, pointMap, getObj, isLine, addPoint, findPointNear, addLine, addRect, addCircle, addStroke,
    addText, addDimLinear, addDimAngle, measureLinear, measureAngle, linesAtPoint, otherEnd, sharedVertex, lineLength,
    angleBetween, component, checkConstraints, setLineLength, setAngle, removeConstraint, addFeature, removeFeature, addFaceFeature, removeFaceFeature, moveObjects, movePoint, deleteObjects,
    updateObject, hitTest, hitAll, objectDistance, dimLinearGeom, textBox, snapGrid, snapAngle, snapSegmentEnd, simplify,
    convertUnits, fmt, extents, toScreen, toModel, zoomAt, fitView, sourceHint, validateDoc, createHistory,
    saveDraft, loadDraft, clearDraft,
  };
});
