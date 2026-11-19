/* Transfert HQ « Dessiner » — touch / stylus / mouse sketch UI.
 * Geometry + model: assets/hq-sketch-core.js (window.HQSketch).
 * Server: GET/POST /api/drawings (admin session, CSRF by Origin, size-capped).
 */
(function () {
  "use strict";
  // Injected again by the page's « Réessayer »: never register handlers twice.
  if (window.hqSketchShow) return;
  const fail = (reason, kind) => {
    if (typeof window.hqSketchFail === "function") { window.hqSketchFail(reason, kind); return; }
    const app = document.getElementById("hq-sk-app");
    if (app) app.textContent = "Dessiner n'a pas pu démarrer. " + reason;
  };
  const S = window.HQSketch;
  if (!S) { fail("module de dessin non chargé (hq-sketch-core.js)", "load"); return; }
  const $ = (sel, el) => (el || document).querySelector(sel);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (msg, kind) => { if (typeof window.toast === "function") window.toast(msg, kind || "ok"); };
  const skMotion = (kind, detail) => {
    const app = document.getElementById("hq-sk-app");
    if (!app) return;
    try { app.dispatchEvent(new CustomEvent("hq-sk-motion", { detail: Object.assign({ kind }, detail || {}) })); } catch (_) {}
  };
  // [tool, label, icon key, group]: the group drives the hairline separators in the strip. Drafting notation
  // (⌀, R, ∠) stays inside the labels; the picture itself is always one of the drawn icons below.
  const TOOLS = {
    quick: [["select", "Sélection", "select", "select"], ["pen", "Stylo", "pen", "draw"], ["eraser", "Gomme", "eraser", "draw"], ["text", "Texte", "text", "draw"],
      ["dimlin", "Cote", "dimlin", "dim"], ["dimang", "Cote ∠", "dimang", "dim"], ["pan", "Main", "pan", "nav"]],
    construction: [["select", "Sélection", "select", "select"],
      ["line", "Ligne", "line", "draw"], ["rect", "Rect.", "rect", "draw"], ["circle", "Cercle", "circle", "draw"], ["arc", "Arc", "arc", "draw"],
      ["slot", "Rainure", "slot", "draw"], ["ellipse", "Ellipse", "ellipse", "draw"], ["spline", "Spline", "spline", "draw"], ["polygon", "Polygone", "polygon", "draw"],
      ["centerline", "Axe", "centerline", "draw"], ["trim", "Rogner", "trim", "edit"], ["extend", "Prolonger", "extend", "edit"],
      ["dimlin", "Cote", "dimlin", "dim"], ["dimdia", "Cote ⌀", "dimdia", "dim"], ["dimrad", "Cote R", "dimrad", "dim"], ["pan", "Main", "pan", "nav"]],
  };
  const TOOL_GROUP = { select: "Sélection", draw: "Dessin", edit: "Modification", dim: "Cotation", nav: "Navigation" };
  const HINTS = {
    select: "Touche un objet pour le sélectionner, glisse pour le déplacer. Glisse dans le vide pour te déplacer.",
    pen: "Dessine à main levée. Deux doigts : zoom / déplacement.",
    eraser: "Passe sur un objet pour l'effacer (annulable).",
    text: "Touche l'endroit de la note, puis tape au clavier.",
    dimlin: "Glisse d'un point à l'autre. Le libellé est libre et ne modifie jamais la géométrie.",
    dimang: "Touche le sommet, puis un point sur chaque côté.",
    dimdia: "Touche un cercle ou un arc : la cote de diamètre se pose du côté touché.",
    dimrad: "Touche un cercle ou un arc : la cote de rayon pointe vers le côté touché.",
    pan: "Glisse pour te déplacer, pince pour zoomer.",
    line: "Glisse du début à la fin. Accroche aux extrémités, à la grille et aux angles.",
    rect: "Glisse d'un coin au coin opposé.",
    circle: "Glisse du centre vers le rayon.",
    arc: "Glisse du centre vers le début de l'arc, puis touche sa fin (sens inverse des aiguilles d'une montre).",
    slot: "Glisse d'un centre à l'autre, puis touche pour régler la largeur.",
    ellipse: "Glisse du centre vers le coin de l'ellipse (largeur et hauteur).",
    spline: "Touche chaque point de la courbe ; touche le premier point pour fermer la spline, ou deux fois au même endroit pour la laisser ouverte.",
    polygon: "Glisse du centre vers un sommet. Le nombre de côtés se règle sous l'outil.",
    trim: "Touche la portion de ligne, d'arc ou de cercle à retirer (entre deux intersections).",
    extend: "Touche l'extrémité d'une ligne à prolonger : elle rejoint la première arête rencontrée.",
    centerline: "Glisse pour tracer un axe (trait mixte).",
  };

  const st = {
    doc: null, name: "", stem: "", dirty: false, tool: "select", sel: [], multi: false,
    hist: S.createHistory(100), view: null, W: 0, H: 0, dpr: 1, ptrs: new Map(), gesture: null, action: null,
    penSeen: false, fixedEnd: "p1", swapAngle: false, angleTaps: [], built: false, draftTimer: 0, hudMsg: "",
    tab3d: false, solidDepth: 20, cutDepth: 5, cutThrough: false, solidBusy: false, mesh: [], edges: [], meshVersion: 0, meshLoadedVersion: -1, meshTimer: 0, faceSelection: null, edgeSelection: null, edgeMode: false, roundRadius: 2,
    hole: { standard: "M3", fit: "clearance", extent: "throughAll", depth: 5 }, shell: { t: 2, open: true },
    pat: { mode: "linear", count: 4, dx: "", dy: 0, cx: "", cy: "", angle: 360, source: "" }, revAngle: 360,
    preview3d: null, histMesh: new Map(),
    sketch: "", caps: { exact: false }, newSketch: false, arcPending: null, arcHover: null,
    edgePick: null, sweepProfile: null, loftProfiles: [], boss: { depth: 5, op: "add" }, rf: { radius: 2, distance: 1 }, mass: null,
  };
  Object.assign(st, { atelier: "tree", featSel: "", pendingOp: "", treeClosed: {}, renaming: "", dragFeat: "", measureMode: false, measurePicks: [], section: false, clip: null, actionToast: "", toastTimer: 0,
    coach: (() => { try { return localStorage.getItem("tf_hq_3d_coach_v1") ? null : 0; } catch (_) { return null; } })() });
  /** The active sketch's view of the drawing (same ids): what the 2D editor draws and hit-tests. */
  const vdoc = () => S.inSketch(st.doc, st.sketch);
  let I = window.HqSketchInput; // refreshed at build: the helper may load after this file
  Object.assign(st, { typed: null, guides: null, autoRules: true, lastFloat: null, split: false, pushPull: null, previewT: 0, previewSeq: 0, previewing: false, pressT: 0, ringOpen: null,
    slotPending: null, splinePts: [], polySides: 6,
    inkColor: "", inkWidth: 2, stylusOnly: false, pressure: 1, autoDims: true, draftFailed: false, lastDraftDoc: null, histPick: null });
  Object.assign(st, { recognize: true, live: null, liveClient: "", livePeers: [], liveConflict: null, lastPointer: null });
  // render harness state: a frame ring buffer, the static layer's key, the hit-test index, and the last
  // snap/selection signatures a motion cue was armed for
  Object.assign(st, { docRev: 0, perf: [], perfHud: /[?&]perfhud=1/.test(String(typeof location !== "undefined" ? location.search : "")), baseKey: "", boxes: new Map(), hit: null, snapKey: "", selKey: "" });

  // ------------------------------------------------------------ 2D presentation motion
  // One clock for short, one-shot cues drawn on the transparent layer. The document and the ink
  // never pass through here: pointer drawing, panning and snapping stay immediate. A cue is armed
  // by a state transition (selection signature, commit, undo, validate, command), never per frame.
  const MOTION = { SNAP_IN: 100, SNAP_HOLD: 140, SNAP_OUT: 110, SELECT: 150, COTE: 160, UNDO: 150, VALIDATE: 160, REMOTE_FADE: 180, FIT: 200 };
  // Only live cues live here. The signatures that decide whether a cue fires (st.snapKey, st.selKey)
  // are render state, so they survive the cue and are not wiped by a redraw or an expiry.
  const anim = { frame: 0, snap: null, sel: null, cote: null, undo: null, validate: null, fit: null, remote: 0 };
  function motionAllowed() { return !reducedMotion(); }
  function motionClamp(v) { return Math.max(0, Math.min(1, v)); }
  function motionPending() { return !!(anim.snap || anim.sel || anim.cote || anim.undo || anim.validate || anim.fit || anim.remote); }
  function motionActive() { return !!(anim.frame || motionPending()); }
  function motionStop() {
    if (anim.frame) cancelAnimationFrame(anim.frame);
    const hadCote = !!anim.cote;
    anim.frame = 0; anim.snap = null; anim.sel = null; anim.cote = null; anim.undo = null; anim.validate = null; anim.fit = null; anim.remote = 0;
    st.snapKey = ""; // a full stop also resets the pointer dedupe: the next gesture may re-acquire the same target
    clearTimeout(st.remoteHoverT); st.remoteHoverT = 0; st.remoteHover = null; st.hoverGoal = null;
    if (hadCote) st.baseKey = "";
  }
  function motionSchedule() {
    if (anim.frame || !motionAllowed() || !st.built || !motionPending()) return;
    anim.frame = requestAnimationFrame(motionFrame);
  }
  function motionExpire(now) {
    if (anim.snap && now - anim.snap.at >= MOTION.SNAP_IN + MOTION.SNAP_HOLD + MOTION.SNAP_OUT) anim.snap = null;
    if (anim.sel && now - anim.sel.at >= MOTION.SELECT) anim.sel = null;
    if (anim.undo && now - anim.undo.at >= MOTION.UNDO) anim.undo = null;
    if (anim.validate && now - anim.validate.at >= MOTION.VALIDATE) anim.validate = null;
    if (anim.cote) {
      // One start per cote: a second commit never replays the first. A cote removed by undo/redo or any
      // other document replacement drops out at once instead of lingering as a stale cue.
      for (const [id, at] of anim.cote) if (now - at >= MOTION.COTE || !st.doc || !S.getObj(st.doc, id)) anim.cote.delete(id);
      if (!anim.cote.size) { anim.cote = null; st.baseKey = ""; }
    }
    if (anim.fit && now - anim.fit.at >= MOTION.FIT) { st.view = Object.assign({}, anim.fit.to); anim.fit = null; st.baseKey = ""; scheduleDraft(); }
    if (anim.remote && now - anim.remote >= MOTION.REMOTE_FADE) { st.remoteHover = null; st.hoverGoal = null; anim.remote = 0; }
  }
  function motionFrame() {
    anim.frame = 0;
    if (!st.built) return;
    if (!motionAllowed()) { // a live preference flip finishes the camera move, then drops every cue
      const target = anim.fit && anim.fit.to;
      motionStop();
      if (target) { st.view = Object.assign({}, target); scheduleDraft(); }
      draw(); return;
    }
    const now = nowMs();
    if (anim.fit) {
      const f = anim.fit, k = motionClamp((now - f.at) / MOTION.FIT);
      // Ease-out on the camera only: fit is a command, never a pointer gesture.
      const e = 1 - Math.pow(1 - k, 3);
      st.view = { x0: f.from.x0 + (f.to.x0 - f.from.x0) * e, y0: f.from.y0 + (f.to.y0 - f.from.y0) * e,
        ppu: f.from.ppu * Math.pow(f.to.ppu / f.from.ppu, e) };
    }
    motionExpire(now);
    draw();
    motionSchedule();
  }

  const PREFS_KEY = "tf_hq_sketch_prefs_v1";
  /** Last height, hole and fillet values, and the automatic-constraint switch: remembered on this device. */
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      if (p.solidDepth > 0) st.solidDepth = p.solidDepth;
      if (p.bossDepth > 0) st.boss.depth = p.bossDepth;
      if (S.HOLE_STANDARDS.includes(p.holeStd)) st.hole.standard = p.holeStd;
      if (S.HOLE_FITS[p.holeFit]) st.hole.fit = p.holeFit;
      if (p.radius > 0) st.rf.radius = p.radius;
      if (p.distance > 0) st.rf.distance = p.distance;
      st.autoRules = p.autoRules !== false;
      st.inkColor = typeof p.inkColor === "string" && /^#[0-9a-f]{6}$/i.test(p.inkColor) ? p.inkColor.toLowerCase() : "";
      if (p.inkWidth > 0) st.inkWidth = Number(p.inkWidth);
      st.stylusOnly = p.stylusOnly === true;
      if (p.pressure > 0) st.pressure = Number(p.pressure);
      st.autoDims = p.autoDims !== false;
      st.recognize = p.recognize !== false;
    } catch (_) { st.autoRules = true; }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ solidDepth: Number(st.solidDepth) || undefined, bossDepth: Number(st.boss.depth) || undefined,
        holeStd: st.hole.standard, holeFit: st.hole.fit, radius: Number(st.rf.radius) || undefined, distance: Number(st.rf.distance) || undefined, autoRules: st.autoRules,
        inkColor: st.inkColor || "", inkWidth: Number(st.inkWidth) || undefined, stylusOnly: !!st.stylusOnly, pressure: Number(st.pressure) || 1, autoDims: !!st.autoDims, recognize: !!st.recognize }));
    } catch (_) {}
  }
  const inV6 = () => !!(st.caps && st.caps.exact);
  let root, canvas, ctx, baseCanvas, baseCtx, hud, props, textIn, empty2d, solidView, faceSketch, bubble2d, bubble3d;
  // Held here on purpose: an observer nothing references can be collected before it ever fires.
  let roStage = null, roFit = null;

  // ------------------------------------------------------------ Phase 3: underlay image + link back to the caller (Carnet)
  // The underlay is ONE Carnet Stage-06 asset shown beneath the strokes (fixed "contain" placement, see hq-sketch-core.js). It is
  // loaded from the confined same-origin asset route; the document stores only the asset id.
  const UL = { id: "", img: null, ok: false, failed: false, fitOnLoad: false };
  function syncUnderlay() {
    const u = st.doc && st.doc.underlay;
    if (!u) { UL.id = ""; UL.img = null; UL.ok = false; UL.failed = false; UL.fitOnLoad = false; return; }
    if (UL.id === u.asset_id) return;
    UL.id = u.asset_id; UL.ok = false; UL.failed = false;
    const img = new Image();
    UL.img = img;
    img.decoding = "async";
    img.onload = () => {
      if (UL.img !== img) return;
      UL.ok = true;
      if (UL.fitOnLoad) { UL.fitOnLoad = false; if (st.W) st.view = S.fitView(st.doc, st.W, st.H, 40, underlayRect()); }
      draw();
      notePicture();
    };
    img.onerror = () => { if (UL.img === img) { UL.failed = true; say("Image du fond introuvable", "err"); } };
    img.src = "/api/carnet/asset/" + encodeURIComponent(u.asset_id);
  }
  function underlayRect() {
    return UL.ok && st.doc && st.doc.underlay ? S.underlayRect(st.doc.units, UL.img.naturalWidth, UL.img.naturalHeight) : null;
  }
  function drawUnderlay(c, view, H) {
    const r = underlayRect();
    if (!r) return;
    const a = S.toScreen(view, H, r.x0, r.y1), b = S.toScreen(view, H, r.x1, r.y0);
    c.drawImage(UL.img, a.x, a.y, b.x - a.x, b.y - a.y);
  }
  // The caller (Carnet) may link the editor: a « Retour au carnet » bar and a saved callback. Dessiner knows nothing else about it.
  function setLink(opts) {
    st.link = opts && typeof opts.ret === "function" ? { ret: opts.ret, onSaved: typeof opts.onSaved === "function" ? opts.onSaved : null, label: String(opts.label || "Croquis lié au carnet").slice(0, 80) } : null;
    const bar = $(".sk-return", root);
    if (!bar) return;
    bar.hidden = !st.link;
    $(".sk-return-msg", root).textContent = st.link ? st.link.label : "";
  }

  // ------------------------------------------------------------ doc helpers
  function isCote(o) { return !!o && (o.type === "dim_linear" || o.type === "dim_angle" || S.isRadialDim(o)); }
  /** Newly committed cotations get one reveal; redraws and pans only paint the already-revealed result. */
  function startCoteReveal(next, previous) {
    if (!next || !previous || !Array.isArray(previous.objects) || !motionAllowed() || !st.built) return;
    const old = new Set(previous.objects.map(o => o.id));
    const fresh = (next.objects || []).filter(o => isCote(o) && !old.has(o.id));
    if (!fresh.length) return;
    const cues = anim.cote || (anim.cote = new Map()), at = nowMs();
    for (const o of fresh) cues.set(o.id, at);
    st.baseKey = ""; // skip them in the cached base while the overlay reveals them
    motionSchedule();
  }
  function objectRefsPoint(o, points) {
    for (const k of ["p1", "p2", "center"]) if (typeof o[k] === "string" && points.has(o[k])) return true;
    return Array.isArray(o.pts) && o.pts.some(id => points.has(id));
  }
  function changedObjectIds(a, b) {
    const am = new Map((a && a.objects || []).map(o => [o.id, o])), bm = new Map((b && b.objects || []).map(o => [o.id, o]));
    const ap = new Map((a && a.points || []).map(p => [p.id, p])), bp = new Map((b && b.points || []).map(p => [p.id, p]));
    const changedPts = new Set();
    for (const [id, p] of ap) { const n = bp.get(id); if (!n || n.x !== p.x || n.y !== p.y || n.z !== p.z) changedPts.add(id); }
    for (const id of bp.keys()) if (!ap.has(id)) changedPts.add(id);
    const ids = new Set();
    for (const [id, o] of am) { const n = bm.get(id); if (!n || JSON.stringify(n) !== JSON.stringify(o) || objectRefsPoint(o, changedPts)) ids.add(id); }
    for (const [id, o] of bm) if (!am.has(id) || objectRefsPoint(o, changedPts)) ids.add(id);
    return [...ids];
  }
  /** Outline only the geometry restored or removed by history; the rest of the sheet is untouched. */
  function startUndoCue(before, after) {
    if (!motionAllowed() || !st.built) return;
    const ids = changedObjectIds(before, after);
    if (!ids.length) return;
    const oldIds = new Set((before && before.objects || []).map(o => o.id)), newIds = new Set((after && after.objects || []).map(o => o.id));
    anim.undo = { oldDoc: before, newDoc: after, oldIds: ids.filter(id => oldIds.has(id)), newIds: ids.filter(id => newIds.has(id)), at: nowMs() };
    motionSchedule();
  }
  function commit(next, opts) {
    st.preview3d = null; // any change ends a 3D history preview
    if (!(opts && opts.noHistory)) st.hist.push(st.doc);
    const previous = st.doc;
    st.doc = next;
    startCoteReveal(next, previous);
    st.meshVersion++;
    st.doc.view = st.view;
    st.dirty = true;
    const alive = new Set(st.doc.objects.map(o => o.id));
    st.sel = st.sel.filter(id => alive.has(id));
    scheduleDraft();
    bumpDoc();
    refreshAll();
    livePublish();
  }
  /** The document was replaced: the static canvas must repaint and the hit index is stale. */
  function bumpDoc() { st.docRev++; st.baseKey = ""; st.hit = null; st.boxes.clear(); }
  /** Replace the document. The static layer, the hit index and the culling boxes all key on the revision, so no code
   * may write `st.doc =` directly: an undo or a drag that skipped this would leave the old drawing on screen. */
  function setDoc(next) { st.doc = next; bumpDoc(); }
  function tryCommit(res) {
    if (!res || !res.ok) { say((res && res.error) || "Opération refusée", "err"); flashHud((res && res.error) || "Refusé"); return false; }
    commit(res.doc);
    return true;
  }
  function mutate(fn) { const d = S.clone(st.doc); const r = fn(d); if (r === false) return null; commit(d); return r; }
  function notePicture() {
    if (typeof window.hqDeskSnapshotSoon === "function") window.hqDeskSnapshotSoon();
    if (typeof window.hqSketchChanged === "function") window.hqSketchChanged(); // « Forge peint » repaints live
  }
  /** The sketch as Forge should see it: what is on screen, black ink on white paper, no grid, no photo underlay,
   * at a Forge-friendly size (hq-sketch-paint.js sizeFor). Null when there is nothing to paint. */
  window.hqSketchPaintSource = () => {
    if (!st.doc || !st.W || !st.H || !st.view || !st.doc.objects.length || !window.HqSketchPaint) return null;
    const sz = window.HqSketchPaint.sizeFor(st.W, st.H);
    const k = Math.min(sz.w / st.W, sz.h / st.H), ppu = st.view.ppu * k;
    const cx = st.view.x0 + st.W / 2 / st.view.ppu, cy = st.view.y0 + st.H / 2 / st.view.ppu;
    const view = { x0: cx - sz.w / 2 / ppu, y0: cy - sz.h / 2 / ppu, ppu: ppu };
    const cv = document.createElement("canvas");
    cv.width = sz.w; cv.height = sz.h;
    const c = cv.getContext("2d");
    if (!c) return null;
    const ink = "#000000", paper = "#ffffff";
    const T = { bg: paper, grid: paper, gridMajor: paper, ink, axis: ink, ref: ink, note: ink, dim: ink, accent: ink, sel: ink, axisX: paper, axisY: paper };
    const d = S.clone(S.inSketch(st.doc, st.sketch)); d.grid = Object.assign({}, d.grid, { visible: false });
    drawScene(c, d, view, sz.w, sz.h, T, { sel: [], noUnderlay: true, preview: function () {} });
    const url = cv.toDataURL("image/png");
    cv.width = 0; cv.height = 0;
    return url;
  };
  function scheduleDraft() {
    notePicture();
    clearTimeout(st.draftTimer);
    st.draftTimer = setTimeout(flushDraft, 300);
  }
  function flushDraft() {
    clearTimeout(st.draftTimer);
    if (!st.doc) return;
    st.doc.view = st.view;
    let saved = false;
    try { saved = S.saveDraft(window.localStorage, { doc: st.doc, name: st.name, stem: st.stem, dirty: st.dirty, baseObjects: st.savedObjects || 0 }); } catch (_) { saved = false; }
    if (saved) { if (st.draftFailed) { st.draftFailed = false; updateButtons(); } return; }
    // A full localStorage must never swallow work silently: say it once, and make the save button say it too.
    if (st.draftFailed) return;
    st.draftFailed = true;
    say("Brouillon local plein : enregistre le dessin pour ne rien perdre", "err");
    flashHud("Brouillon local non sauvegardé");
    updateButtons();
  }
  // ---- server-side scratch copy: the durable fallback when localStorage is full (or the browser clears it)
  function clearServerDraft(key) {
    st.lastDraftDoc = null;
    window.api("/api/drawings/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clear: true, key: key || "" }), timeoutMs: 15000 }).catch(() => {});
  }
  function serverDraft() {
    if (!st.doc || !st.dirty || st.lastDraftDoc === st.doc) return;
    const doc = st.doc;
    st.lastDraftDoc = doc;
    window.api("/api/drawings/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stem: st.stem || "", name: st.name || "", doc: doc }), timeoutMs: 30000 })
      .catch(() => { if (st.lastDraftDoc === doc) st.lastDraftDoc = null; }); // silent: the local draft stays the primary copy
  }
  /** Leaving the page: a small document can still go out as a beacon, a big one waits for the periodic flush. */
  function beaconDraft() {
    if (!st.doc || !st.dirty || !navigator.sendBeacon) return;
    try {
      const body = JSON.stringify({ stem: st.stem || "", name: st.name || "", doc: st.doc });
      if (body.length > 48 * 1024) return; // beacons are capped; never silently drop a half-sent document
      navigator.sendBeacon("/api/drawings/draft", new Blob([body], { type: "application/json" }));
    } catch (_) {}
  }
  function sourceHint() {
    const mm = q => { try { return window.matchMedia(q).matches; } catch (_) { return false; } };
    return S.sourceHint({ coarse: mm("(pointer: coarse)"), finePointer: mm("(any-pointer: fine)"), touchPoints: navigator.maxTouchPoints || 0,
      width: window.innerWidth, height: window.innerHeight });
  }

  // ------------------------------------------------------------ build
  // One drawing vocabulary for the whole page: every icon is a 24×24 stroke drawing (no emoji, no font glyph),
  // so the action bar, the tool strip and the feature tree keep the same optical weight on every platform.
  const art = inner => '<svg class="sk-i" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + inner + "</svg>";
  const ICON = {
    undo: art('<path d="M8 7 3 12l5 5"/><path d="M3 12h10a6 6 0 0 1 6 6v1"/>'),
    redo: art('<path d="m16 7 5 5-5 5"/><path d="M21 12H11a6 6 0 0 0-6 6v1"/>'),
    trash: art('<path d="M4 7h16"/><path d="M10 4h4"/><path d="m6 7 1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>'),
    fit: art('<path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5"/>'),
    settings: art('<path d="M4 7h8M18 7h2M4 17h2M10 17h10"/><circle cx="15" cy="7" r="2.5"/><circle cx="7" cy="17" r="2.5"/>'),
    check: art('<path d="M20 11.2V12a8 8 0 1 1-4.7-7.3"/><path d="m8.5 12 3 3 8.5-8.5"/>'),
    symmetry: art('<path d="M12 3v18" stroke-dasharray="2 2.4"/><path d="m8.5 7.5-4 4.5 4 4.5"/><path d="m15.5 7.5 4 4.5-4 4.5"/>'),
    folder: art('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
    plus: art('<path d="M12 5v14M5 12h14"/>'),
    minus: art('<path d="M5 12h14"/>'),
    paint: art('<path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/>'),
    save: art('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 15h8v6H8z"/>'),
    close: art('<path d="m6 6 12 12M18 6 6 18"/>'),
    back: art('<path d="m14 6-6 6 6 6"/>'),
    grip: art('<circle cx="9" cy="6" r="1.1"/><circle cx="15" cy="6" r="1.1"/><circle cx="9" cy="12" r="1.1"/><circle cx="15" cy="12" r="1.1"/><circle cx="9" cy="18" r="1.1"/><circle cx="15" cy="18" r="1.1"/>'),
    eye: art('<path d="M2.5 12S6.2 6.2 12 6.2 21.5 12 21.5 12 17.8 17.8 12 17.8 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.6"/>'),
    eyeOff: art('<path d="M4 4.5 20 19.5"/><path d="M9.6 6.7A9.6 9.6 0 0 1 12 6.2c5.8 0 9.5 5.8 9.5 5.8a17 17 0 0 1-3.4 4"/><path d="M6 8.2A17 17 0 0 0 2.5 12S6.2 17.8 12 17.8a9 9 0 0 0 3.2-.6"/><path d="M10 10a2.8 2.8 0 0 0 4 4"/>'),
    warn: art('<path d="M12 3 22 20H2Z"/><path d="M12 9.5v4.5M12 17.2v.01"/>'),
    chevronDown: art('<path d="m6 9 6 6 6-6"/>'),
    chevronRight: art('<path d="m9 6 6 6-6 6"/>'),
    chevronUp: art('<path d="m6 15 6-6 6 6"/>'),
    driven: art('<path d="M14.5 3.5c-2.6 0-3.5 1.4-3.5 3.6V20"/><path d="M8.5 10.5h6"/>'),
    select: art('<path d="M6 3.5 19 12l-5.2.9-2.4 5.1z"/>'),
    pen: art('<path d="M4 20l4.2-1.1L19.9 7.2a1.7 1.7 0 0 0 0-2.4l-.7-.7a1.7 1.7 0 0 0-2.4 0L5.1 15.8z"/><path d="m14.6 5.7 3.7 3.7"/>'),
    eraser: art('<path d="m7 20.5-4-4a2 2 0 0 1 0-2.8l8.9-8.9a2 2 0 0 1 2.8 0l5.1 5.1a2 2 0 0 1 0 2.8l-7.6 7.8Z"/><path d="M5 11.2 12.8 19"/><path d="M3.5 20.5h17"/>'),
    text: art('<path d="M5 6.5V4h14v2.5M12 4v16M9 20h6"/>'),
    line: art('<path d="M5 19 19 5"/><circle cx="5" cy="19" r="1.3"/><circle cx="19" cy="5" r="1.3"/>'),
    rect: art('<rect x="4" y="6" width="16" height="12" rx="1.2"/>'),
    circle: art('<circle cx="12" cy="12" r="8"/>'),
    arc: art('<path d="M3.5 17.5a11 11 0 0 1 17 0"/><path d="M2.6 19.2h1.8M19.6 19.2h1.8"/>'),
    slot: art('<rect x="4" y="8" width="16" height="8" rx="4"/>'),
    ellipse: art('<ellipse cx="12" cy="12" rx="8.5" ry="6"/>'),
    spline: art('<path d="M3 17c4.5 0 4.5-10 9-10s4.5 10 9 10"/><circle cx="3" cy="17" r="1.2"/><circle cx="21" cy="17" r="1.2"/><circle cx="12" cy="7" r="1.2"/>'),
    polygon: art('<path d="M12 3.2 20.2 9.1 17.1 18.8H6.9L3.8 9.1Z"/>'),
    trim: art('<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><path d="m8.1 7.6 11.9 10.8M8.1 16.4 20 5.6"/>'),
    extend: art('<path d="M3 12h10.5"/><path d="m10.5 8 4 4-4 4"/><path d="M19 4.5v15"/>'),
    centerline: art('<path d="M3 12h5M10.5 12h1.5M14.5 12h4M20 12h1"/>'),
    dimlin: art('<path d="M4 6.5v11M20 6.5v11M4 12h16"/><path d="m7.2 9-3 3 3 3M16.8 9l3 3-3 3"/>'),
    dimang: art('<path d="M4 19.5h16M4 19.5 17 5.5"/><path d="M11 19.5a7.5 7.5 0 0 0-1.6-4.6"/>'),
    dimdia: art('<circle cx="12" cy="12" r="7.5"/><path d="M6.7 17.3 17.3 6.7"/><path d="M13.4 6.7h3.9v3.9"/>'),
    dimrad: art('<circle cx="12" cy="12" r="7.5"/><path d="m12 12 5.3-5.3"/><path d="M14 6.7h3.3v3.3"/>'),
    pan: art('<path d="M8 12V7a1.5 1.5 0 0 1 3 0v4M11 11V6a1.5 1.5 0 0 1 3 0v5M14 11V7.5a1.5 1.5 0 0 1 3 0V15a5.5 5.5 0 0 1-5.5 5.5h-1A5 5 0 0 1 7 18.8l-3-3.1a1.6 1.6 0 0 1 2.3-2.2L8 15.3"/>'),
    multi: art('<rect x="3.5" y="3.5" width="9" height="9" rx="1.2"/><rect x="11.5" y="11.5" width="9" height="9" rx="1.2"/>'),
    newSketch: art('<rect x="3.5" y="3.5" width="11" height="11" rx="1.2"/><path d="M18 13.5v7M14.5 17h7"/>'),
    extrude: art('<path d="M4.5 14.5h8v7h-8z"/><path d="M8.5 11.5v-8M5.8 6.2l2.7-2.7 2.7 2.7"/>'),
    revolve: art('<path d="M12 2.5v19"/><path d="M7.2 8.4A5.5 5.5 0 0 1 17 7.2"/><path d="m16.8 3.9.5 3.5-3.4.5"/><path d="M8 15.4a4 4 0 0 0 7.6-.8"/>'),
    cut: art('<path d="M4 4.5h16v10h-6v5H4Z"/>'),
    hole: art('<ellipse cx="12" cy="6.5" rx="6" ry="2.5"/><path d="M6 6.5v6.2c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6.5"/><path d="M12 15.2V21M9.5 18.5 12 21l2.5-2.5"/>'),
    shell: art('<path d="M4 8.5h16v12H4Z"/><path d="M8 8.5v8h8v-8"/>'),
    pattern: art('<rect x="3" y="4" width="5" height="5" rx="1"/><rect x="9.5" y="4" width="5" height="5" rx="1"/><rect x="16" y="4" width="5" height="5" rx="1"/><rect x="3" y="11" width="5" height="5" rx="1"/><rect x="9.5" y="11" width="5" height="5" rx="1"/><rect x="16" y="11" width="5" height="5" rx="1"/>'),
    fillet: art('<path d="M4 20V10a6 6 0 0 1 6-6h10"/><path d="M4 4h4M20 20v-4"/>'),
    chamfer: art('<path d="M4 20V9l5-5h11"/><path d="M4 4h5M20 20v-5"/>'),
    sweep: art('<rect x="3.5" y="14.5" width="6" height="6" rx="1"/><path d="M9.5 17.5c4.5 0 4.5-9 10.5-9"/><path d="m17 5.5 3.5 3-3.5 3"/>'),
    loft: art('<path d="M5 4.5h14v3.5H5z"/><path d="M8 16h8v3.5H8z"/><path d="M5 8l3 8M19 8l-3 8"/>'),
  };
  function build() {
    root = $("#hq-sk-app");
    if (!root) return false;
    root.innerHTML = `
<div class="sk" data-mode="quick">
  <div class="sk-return" role="region" aria-label="Retour au carnet" hidden><span class="sk-return-msg"></span><button type="button" class="sk-btn sk-return-btn" data-act="return">${ICON.back}<span>Retour au carnet</span></button></div>
  <div class="sk-bar">
    <div class="sk-seg" role="tablist" aria-label="Mode de dessin">
      <button type="button" role="tab" data-mode="quick">Croquis rapide</button>
      <button type="button" role="tab" data-mode="construction">Construction</button>
    </div>
    <div class="sk-acts">
      <div class="sk-actgroup" role="group" aria-label="Historique et sélection">
        <button type="button" class="sk-btn" data-act="undo" aria-label="Annuler" title="Annuler (Ctrl+Z)">${ICON.undo}</button>
        <button type="button" class="sk-btn" data-act="redo" aria-label="Rétablir" title="Rétablir (Ctrl+Y)">${ICON.redo}</button>
        <button type="button" class="sk-btn" data-act="delete" aria-label="Supprimer la sélection" title="Supprimer">${ICON.trash}</button>
      </div>
      <div class="sk-actgroup" role="group" aria-label="Vue et validation">
        <button type="button" class="sk-btn" data-act="fit" aria-label="Tout afficher" title="Tout afficher">${ICON.fit}</button>
        <button type="button" class="sk-btn" data-act="settings" aria-label="Réglages grille et unités" aria-expanded="false" title="Réglages">${ICON.settings}</button>
        <button type="button" class="sk-btn" data-act="validate" aria-label="Valider le dessin" title="Valider le dessin">${ICON.check}</button>
      </div>
      <div class="sk-actgroup" role="group" aria-label="Fichier et Forge">
        <button type="button" class="sk-btn" data-act="open" aria-label="Ouvrir un dessin" title="Ouvrir">${ICON.folder}</button>
        <button type="button" class="sk-btn" data-act="new" aria-label="Nouveau dessin" title="Nouveau">${ICON.plus}</button>
        <button type="button" class="sk-btn sk-paint-btn" data-act="paint" aria-label="Forge peint le croquis" aria-expanded="false" title="Forge peint le croquis">${ICON.paint}</button>
      </div>
      <button type="button" class="sk-btn sk-save" data-act="save"><span class="sk-save-ico" aria-hidden="true">${ICON.save}</span><span>Enregistrer</span></button><span class="sk-dirty-chip" hidden>Non enregistré</span>
    </div>
  </div>
  <div class="sk-tools" role="toolbar" aria-label="Outils"></div>
  <div class="sk-view-tabs" role="tablist" aria-label="Vue du dessin">
    <button type="button" data-act="view2d" role="tab" aria-selected="true">Dessin 2D</button>
    <button type="button" data-act="view3d" role="tab" aria-selected="false">Aperçu 3D</button>
    <button type="button" data-act="viewSplit" role="tab" aria-selected="false" class="sk-split-tab" title="Esquisse et pièce côte à côte">2D + 3D</button>
  </div>
  <div class="sk-settings" hidden>
    <label>Unités <select data-set="units"><option value="mm">mm</option><option value="cm">cm</option><option value="m">m</option><option value="in">po (in)</option></select></label>
    <label>Grille <input data-set="spacing" type="number" inputmode="decimal" min="0.001" step="any"/></label>
    <label class="sk-chk"><input data-set="visible" type="checkbox"/> Grille visible</label>
    <label class="sk-chk"><input data-set="gsnap" type="checkbox"/> Accroche grille</label>
    <label class="sk-chk"><input data-set="asnap" type="checkbox"/> Accroche angle</label>
    <label class="sk-chk"><input data-pref="autoRules" type="checkbox"/> Contraintes automatiques</label>
    <label class="sk-chk"><input data-pref="autoDims" type="checkbox"/> Cotes automatiques</label>
    <label class="sk-chk" title="Un tracé à main levée devient une ligne, un cercle ou un arc propre"><input data-pref="recognize" type="checkbox"/> Tracés reconnus</label>
    <span class="sk-swatches" role="group" aria-label="Couleur d'encre">
      <button type="button" class="sk-swatch" data-ink="" aria-pressed="false">Encre</button>
      <button type="button" class="sk-swatch" data-ink="#c62828" aria-pressed="false">Rouge</button>
      <button type="button" class="sk-swatch" data-ink="#1b7f3b" aria-pressed="false">Vert</button>
      <button type="button" class="sk-swatch" data-ink="#1d4ed8" aria-pressed="false">Bleu</button>
      <button type="button" class="sk-swatch" data-ink="#f2b705" data-ink-w="8" aria-pressed="false">Surligneur</button>
    </span>
    <label>Trait <select data-pref="inkWidth"><option value="1.2">Fin</option><option value="2">Normal</option><option value="3.5">Épais</option><option value="8">Large</option></select></label>
    <label class="sk-chk"><input data-pref="stylusOnly" type="checkbox"/> Stylet seulement</label>
    <label>Pression <select data-pref="pressure"><option value="0.6">Souple</option><option value="1">Linéaire</option><option value="1.6">Ferme</option></select></label>
    <label>Pas <select data-set="astep"><option>5</option><option>7.5</option><option>10</option><option>15</option><option>22.5</option><option>30</option><option>45</option><option>90</option></select> °</label>
  </div>
  <div class="sk-stages">
  <div class="sk-stage">
    <canvas class="sk-base" aria-hidden="true"></canvas>
    <canvas class="sk-canvas" aria-label="Zone de dessin" role="application" tabindex="0" aria-describedby="sk-kbd-hint"></canvas>
    <p id="sk-kbd-hint" class="visually-hidden">Zone de dessin interactive. Les outils et commandes se pilotent au clavier depuis la page ; « ? » affiche les raccourcis, Échap annule l'action en cours.</p>
    <input class="sk-textin" type="text" maxlength="500" enterkeyhint="done" autocomplete="off" aria-label="Texte de la note" hidden/>
    <div class="sk-hud"></div>
    <p class="sk-status visually-hidden" role="status" aria-live="polite"></p>
    <div class="sk-empty2d" aria-hidden="true">
      <span class="sk-empty2d-mark"></span>
      <strong>La feuille est prête</strong>
      <span class="sk-empty2d-copy">Pose un premier trait, ou choisis un outil pour commencer.</span>
    </div>
    <div class="sk-float"><button type="button" class="sk-btn" data-act="undo" aria-label="Annuler">${ICON.undo}</button><button type="button" class="sk-btn" data-act="redo" aria-label="Rétablir">${ICON.redo}</button></div>
  </div>
  <div class="sk-3d-stage" hidden data-atelier="tree">
    <div class="sk-3d-viewport">
      <canvas class="sk-3d-canvas" aria-label="Aperçu 3D interactif" role="img"></canvas>
      <div class="sk-empty" hidden>
        <div class="sk-empty-card">
          <svg class="sk-empty-glyph" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path class="sk-empty-fill" d="M6.5 15 24 5.5l17.5 9.5L24 24.5z"/><path d="M6.5 15v18L24 42.5l17.5-9.5V15M24 24.5v18M6.5 15 24 5.5l17.5 9.5L24 24.5 6.5 15"/></svg>
          <p class="sk-empty-kicker">Atelier 3D</p>
          <strong class="sk-empty-title">Aucune pièce pour l'instant</strong>
          <p>Sélectionne un contour fermé, touche Bossage, ou démarre avec une pièce type.</p>
          <div class="sk-empty-acts"><button type="button" class="sk-empty-go" data-starter="plate">Créer une plaque</button><button type="button" class="sk-empty-2d" data-act="view2d">Dessiner en 2D</button></div>
        </div>
      </div>
      <div class="sk-3d-overlay"><span class="sk-3d-status" aria-live="polite"></span><button type="button" data-act="faceSketch" class="sk-face-start" hidden>Dessiner sur cette face</button><button type="button" data-act="roundMode" class="sk-round-mode" aria-pressed="false">Arrondir une arête</button><button type="button" data-act="ar3d" class="sk-ar">Voir en AR</button><button type="button" data-act="reset3d">Recentrer</button></div>
      <div class="sk-view-pad" role="group" aria-label="Vues et outils de la pièce">
        <span class="sk-3d-history"><button type="button" data-act="undo" aria-label="Annuler" title="Annuler">${ICON.undo}</button><button type="button" data-act="redo" aria-label="Rétablir" title="Rétablir">${ICON.redo}</button></span>
        <div class="sk-pad-group" role="group" aria-label="Vues">
          <button type="button" data-view="iso">Iso</button><button type="button" data-view="face">Face</button><button type="button" data-view="top">Dessus</button><button type="button" data-view="right">Droite</button>
          <button type="button" data-act="fit3d" aria-label="Ajuster la vue" title="Ajuster la vue">${ICON.fit}</button>
        </div>
        <div class="sk-pad-group" role="group" aria-label="Zoom et mesure">
          <button type="button" data-act="zoomIn" aria-label="Zoom avant" title="Zoom avant">${ICON.plus}</button><button type="button" data-act="zoomOut" aria-label="Zoom arrière" title="Zoom arrière">${ICON.minus}</button>
          <button type="button" data-act="measure" aria-pressed="false">Mesurer</button><button type="button" data-act="section" aria-pressed="false">Coupe</button>
        </div>
      </div>
      <p class="sk-measure" hidden aria-live="polite"></p>
      <div class="sk-clip" hidden><label>Coupe Z<input type="range" min="0" max="100" step="1" value="100" data-clip aria-label="Hauteur de coupe"/></label><span class="sk-clip-val">toute la pièce</span><button type="button" data-act="clipOff" aria-label="Retirer la coupe">${ICON.close}</button></div>
      <div class="sk-coach" hidden></div>
      <div class="sk-face-editor" hidden></div>
    </div>
    <aside class="sk-atelier" aria-label="Atelier de la pièce">
      <button type="button" class="sk-3d-exit" data-act="view2d" aria-label="Revenir au dessin 2D" title="Revenir au dessin 2D">2D</button>
      <div class="sk-atelier-tabs" role="tablist" aria-label="Sections de l'atelier">
        <button type="button" role="tab" data-atelier="tree" aria-selected="true">Pièce</button>
        <button type="button" role="tab" data-atelier="ops" aria-selected="false">Opération</button>
        <button type="button" role="tab" data-atelier="props" aria-selected="false">Propriétés</button>
      </div>
      <div class="sk-solid"></div>
    </aside>
  </div>
  </div>
  <div class="sk-paint-host" hidden></div>
  <div class="sk-props"></div>
  <dialog class="sk-dlg" id="sk-save-dlg" aria-labelledby="sk-save-title">
    <form method="dialog">
      <header><strong id="sk-save-title">Enregistrer le dessin</strong></header>
      <label for="sk-save-name">Nom de base</label>
      <input id="sk-save-name" type="text" maxlength="60" autocomplete="off" placeholder="support-moteur"/>
      <p class="hint" id="sk-save-preview"></p>
      <div class="row"><button type="button" class="secondary" data-close="cancel">Annuler</button><button value="ok" id="sk-save-go">Enregistrer</button></div>
    </form>
  </dialog>
  <dialog class="sk-dlg" id="sk-open-dlg" aria-labelledby="sk-open-title">
    <form method="dialog">
      <header><strong id="sk-open-title">Dessins enregistrés</strong> <span class="hint">Inbox/Drawings</span></header>
      <div class="sk-lib-bar">
        <input id="sk-lib-search" type="search" placeholder="Chercher un dessin" aria-label="Chercher un dessin" autocomplete="off"/>
        <select id="sk-lib-sort" aria-label="Trier les dessins">
          <option value="recent">Plus récents d'abord</option>
          <option value="old">Plus anciens d'abord</option>
          <option value="name">Nom (A → Z)</option>
        </select>
      </div>
      <p class="hint sk-lib-count" aria-live="polite"></p>
      <div class="sk-row sk-dxf-row"><label class="sk-dxf-in">Importer un DXF<input type="file" id="sk-dxf-file" accept=".dxf,text/plain"/></label><span class="hint">ligne, cercle, arc, polyligne · calques conservés</span></div>
      <div class="sk-list"><p class="hint">Chargement…</p></div>
      <div class="row"><button value="cancel" class="secondary">Fermer</button></div>
    </form>
  </dialog>
  <dialog class="sk-dlg" id="sk-compare-dlg" aria-labelledby="sk-compare-title">
    <form method="dialog">
      <header><strong id="sk-compare-title">Comparer à l'origine</strong> <span class="hint">images et compte d'objets</span></header>
      <div class="sk-cmp-body"><p class="hint">Choisis un dessin et « Comparer » dans la liste.</p></div>
      <div class="row"><button value="cancel" class="secondary">Fermer</button></div>
    </form>
  </dialog>
  <dialog class="sk-dlg" id="sk-validate-dlg" aria-labelledby="sk-validate-title">
    <form method="dialog">
      <header><strong id="sk-validate-title">Valider le dessin</strong> <span class="hint">lecture seule</span></header>
      <p class="sk-validate-summary" aria-live="polite"></p>
      <ul class="sk-validate-list"></ul>
      <p class="hint">Le rapport ne modifie rien ; « Réparer » n'enlève que ce qui pointe dans le vide, et Annuler le défait.</p>
      <div class="row"><button type="button" class="sk-validate-fix" data-act="repair">Réparer</button><button value="cancel" class="secondary">Fermer</button></div>
    </form>
  </dialog>
</div>`;
    canvas = $(".sk-canvas", root);
    ctx = canvas.getContext("2d");
    empty2d = $(".sk-empty2d", root);
    canvas.addEventListener("pointerdown", () => { if (empty2d) empty2d.classList.add("is-gone"); }, { passive: true });
    baseCanvas = $(".sk-base", root);
    baseCtx = baseCanvas ? baseCanvas.getContext("2d") : null;
    hud = $(".sk-hud", root);
    props = $(".sk-props", root);
    textIn = $(".sk-textin", root);
    if (window.HQSolidView) {
      solidView = window.HQSolidView($(".sk-3d-canvas", root));
      solidView.onFaceSelect(face => {
        restorePreview();
        if (st.measureMode) {
          if (face && face.point) {
            st.measurePicks.push(face.point);
            if (st.measurePicks.length > 2) st.measurePicks = [face.point];
            status3d(st.measurePicks.length < 2 ? "Mesure : touche le second point" : "Mesure prête");
            renderSolid();
          }
          return;
        }
        st.pushPull = face && I ? I.capFeature(st.doc, face.plane) : null;
        st.faceSelection = face; st.faceAt = st.meshVersion;
        updateFloat();
        $(".sk-face-start", root).hidden = !face;
        if (face) $(".sk-3d-status", root).textContent = st.pushPull ? "Face sélectionnée · glisse-la pour la pousser ou la tirer" : "Face sélectionnée";
      });
      solidView.onFaceDrag(ppDragHandler());
      window.hqSolidView = solidView; // read-only handle for diagnosis and browser checks, like hqSketchState()
      solidView.onFaceDblClick(face => { if (face && face.plane && solidView.alignTo(face.plane.normal)) status3d("Vue alignée sur la face"); });
      solidView.onEdgeSelect(edge => {
        if (st.edgePick) { // several edges for one congé / chanfrein (exact part)
          const i = edge ? st.edges.indexOf(edge) : -1;
          if (i >= 0) { const at = st.edgePick.picks.indexOf(i); if (at >= 0) st.edgePick.picks.splice(at, 1); else st.edgePick.picks.push(i); }
          solidView.setMarked(st.edgePick.picks, true);
          $(".sk-3d-status", root).textContent = st.edgePick.picks.length + " arête(s) choisie(s) · touche-en d'autres ou applique";
          renderSolid(); updateFloat();
          return;
        }
        st.edgeSelection = edge;
        $(".sk-3d-status", root).textContent = edge ? "Arête sélectionnée · choisis un rayon" : "Touche une arête droite convexe de la pièce";
        renderSolid();
      });
    }
    if (window.HQFaceSketch) faceSketch = window.HQFaceSketch($(".sk-face-editor", root), createFaceSolid);
    if (window.HqSketchFloat) {
      bubble2d = window.HqSketchFloat.mount(window, $(".sk-stage", root), { onAction: floatAction, onInput: floatInput });
      bubble3d = window.HqSketchFloat.mount(window, $(".sk-3d-stage", root), { onAction: floatAction, onInput: floatInput });
    }
    wire();
    return true;
  }

  function wire() {
    wireAtelier();
    root.addEventListener("click", e => {
      const m = e.target.closest("[data-mode]");
      if (m && m.tagName === "BUTTON") { setMode(m.dataset.mode); return; }
      // a BUTTON only: .sk itself carries data-tool for the cursor styles, so a bare closest() would swallow every data-act click
      const t = e.target.closest("[data-tool]");
      if (t && t.tagName === "BUTTON") { setTool(t.dataset.tool); return; }
      const a = e.target.closest("[data-act]");
      if (a) act(a.dataset.act, a);
    });
    const setEl = $(".sk-settings", root);
    setEl.addEventListener("change", e => {
      const k = e.target.dataset.set;
      if (!k) return;
      if (k === "units") {
        st.doc.view = st.view;
        const r = S.convertUnits(st.doc, e.target.value);
        if (r.ok && r.doc.view) st.view = Object.assign({}, r.doc.view);
        if (tryCommit(r)) say("Unités : " + e.target.value + " (taille réelle conservée)");
        return;
      }
      mutate(d => {
        if (k === "spacing") { const v = Number(String(e.target.value).replace(",", ".")); if (!(v > 0)) { say("Pas de grille invalide", "err"); return false; } d.grid.spacing = v; }
        if (k === "visible") d.grid.visible = e.target.checked;
        if (k === "gsnap") d.grid.snap = e.target.checked;
        if (k === "asnap") d.snap.angle = e.target.checked;
        if (k === "astep") d.snap.angleStep = Number(e.target.value);
      });
    });
    props.addEventListener("click", onPropsClick);
    props.addEventListener("input", e => { if (e.target.matches("[data-hist2d]")) updateHist2d(); if (e.target.dataset.toolOpt === "polySides") { st.polySides = Math.max(3, Math.min(12, Math.round(Number(e.target.value) || 6))); draw(); } });
    props.addEventListener("change", onPropsChange);
    props.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("input[data-apply]")) { e.preventDefault(); applyProp(e.target.dataset.apply); } });
    props.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      if (e.target.matches("input[data-param]")) { e.preventDefault(); paramEdit(e.target, true); }
      else if (e.target.matches("input[data-drive]")) { e.preventDefault(); applyDrive(e.target, true); }
    });
    $(".sk-solid", root).addEventListener("change", onSolidChange);
    $(".sk-tools", root).addEventListener("change", e => { if (e.target.matches(".sk-sketch-sel")) setSketch(e.target.value); });
    // device preferences: automatic constraints and cotes, ink, stylus
    $(".sk-settings", root).addEventListener("change", e => {
      const p = e.target.dataset.pref;
      if (!p) return;
      if (p === "autoRules") st.autoRules = e.target.checked;
      else if (p === "autoDims") st.autoDims = e.target.checked;
      else if (p === "recognize") st.recognize = e.target.checked;
      else if (p === "stylusOnly") st.stylusOnly = e.target.checked;
      else if (p === "pressure") st.pressure = Number(e.target.value) || 1;
      else if (p === "inkWidth") st.inkWidth = Number(String(e.target.value).replace(",", ".")) || 2;
      else return;
      savePrefs(); syncInk();
    });
    $(".sk-settings", root).addEventListener("click", e => {
      const b = e.target.closest("[data-ink]");
      if (!b) return;
      st.inkColor = b.dataset.ink || "";
      if (b.dataset.inkW) st.inkWidth = Number(b.dataset.inkW) || st.inkWidth;
      savePrefs(); syncInk();
    });
    $(".sk-solid", root).addEventListener("input", e => {
      const key = e.target.dataset.solid || "";
      if (key.includes(".")) { const [o, k] = key.split("."); st[o][k] = e.target.type === "checkbox" ? e.target.checked : e.target.value; }
      if (key === "revAngle") st.revAngle = e.target.value;
      if (e.target.dataset.hist3d != null) previewStep(Number(e.target.value));
      if (e.target.dataset.solid === "base-depth") st.solidDepth = e.target.value;
      if (e.target.dataset.solid === "cut-depth") st.cutDepth = e.target.value;
      if (e.target.dataset.solid === "round-radius") st.roundRadius = e.target.value;
      if (e.target.dataset.solid === "through") {
        st.cutThrough = e.target.checked;
        const depthInput = $('[data-solid="cut-depth"]', root);
        if (depthInput) depthInput.disabled = st.cutThrough;
      }
      if (e.target.dataset.solid) updateGhost();
    });

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("lostpointercapture", e => { if (st.ptrs.has(e.pointerId)) onCancel(e); });
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    canvas.addEventListener("dblclick", onDouble);
    ["gesturestart", "gesturechange"].forEach(n => canvas.addEventListener(n, e => e.preventDefault()));
    textIn.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); finishText(true); }
      else if (e.key === "Escape") { e.preventDefault(); finishText(false); }
    });
    textIn.addEventListener("blur", () => finishText(true));
    document.addEventListener("keydown", onKey);
    // while building a selection (Shift held, or the Multi toggle) the bubble lets clicks through to what is under it
    const shiftPass = e => { if (e.key !== "Shift") return; const s = $(".sk-stage", root); if (s) s.classList.toggle("is-shift", e.type === "keydown"); };
    document.addEventListener("keydown", shiftPass); document.addEventListener("keyup", shiftPass);
    window.addEventListener("blur", () => { const s = $(".sk-stage", root); if (s) s.classList.remove("is-shift"); });
    window.addEventListener("pagehide", () => { motionStop(); flushDraft(); beaconDraft(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { motionStop(); flushDraft(); beaconDraft(); } });
    // every minute while it has unsaved work: the latest scratch copy on the server (+ the replaced one kept as a dated
    // snapshot, bounded by DRAFT_KEEP / DRAFT_TTL_DAYS)
    setInterval(() => { if (document.body.dataset.view === "dessiner") serverDraft(); }, 60000);
    if (window.ResizeObserver) roStage = new ResizeObserver(resize);
    if (roStage) [$(".sk-stage", root), $(".sk-3d-stage", root)].forEach(el => el && roStage.observe(el));
    // The height the canvas gets depends on what sits above it: a mode switch, a loaded drawing or a late stylesheet can
    // wrap the tool rows and move the fold. These boxes report that themselves, so it is the only fit besides show/resize.
    if (window.ResizeObserver) roFit = new ResizeObserver(() => fitStage());
    if (roFit) [$(".sk-bar", root), $(".sk-tools", root), $(".sk-view-tabs", root), $(".sk-settings", root), $(".hq-sk .sec-head")]
      .forEach(el => el && roFit.observe(el));
    window.addEventListener("resize", resize);
    // The 3D stage is a full-screen workshop under 900px; follow that breakpoint and the 2D/3D switch.
    const mqPhone3d = window.matchMedia ? window.matchMedia("(max-width: 899px)") : null;
    if (mqPhone3d) { const onPhone3d = () => syncPhone3d(); if (mqPhone3d.addEventListener) mqPhone3d.addEventListener("change", onPhone3d); else if (mqPhone3d.addListener) mqPhone3d.addListener(onPhone3d); }
    syncPhone3d();
    // Phone: dragging the sheet's tab bar down closes the atelier, like a real bottom sheet.
    const sheetBar = $(".sk-atelier-tabs", root), sheetEl = $(".sk-atelier", root);
    const SHEET_CLOSE_DY = 56;
    // A release can go missing (pointer outside the window, cancelled touch, suspended tab): never leave the
    // sheet translated under a finger that no longer exists. Blur/visibility end the drag, and a drag that sees
    // no event for this long springs back instead of staying half-open.
    const SHEET_STALL_MS = 5000;
    let sheetSwipe = null, sheetWatchdog = 0;
    if (sheetBar && sheetEl) {
      const sheetRelease = () => {
        window.removeEventListener("pointermove", sheetMove);
        window.removeEventListener("pointerup", sheetStop);
        window.removeEventListener("pointercancel", sheetAbort);
        window.removeEventListener("blur", sheetAbort);
        window.removeEventListener("pagehide", sheetAbort);
        document.removeEventListener("visibilitychange", sheetOnVisibility);
        clearTimeout(sheetWatchdog);
        sheetWatchdog = 0;
      };
      const sheetSettle = close => {
        if (!sheetSwipe) return;
        const dy = sheetSwipe.dy || 0;
        sheetSwipe = null;
        sheetRelease();
        sheetEl.style.transition = "transform .16s ease";
        sheetEl.style.transform = "";
        if (close && dy >= SHEET_CLOSE_DY) {
          // The sheet disappears under the finger: don't let the release click whatever was behind it.
          const swallow = ev => { ev.preventDefault(); ev.stopPropagation(); };
          document.addEventListener("click", swallow, true);
          setTimeout(() => document.removeEventListener("click", swallow, true), 350);
          setView3d(false);
          sheetEl.style.transition = "";
        } else setTimeout(() => { sheetEl.style.transition = ""; }, 180);
      };
      const sheetWatch = () => {
        clearTimeout(sheetWatchdog);
        sheetWatchdog = setTimeout(() => sheetSettle(false), SHEET_STALL_MS);
      };
      const sheetMove = e => {
        if (!sheetSwipe || e.pointerId !== sheetSwipe.id) return;
        const dy = e.clientY - sheetSwipe.y;
        sheetSwipe.dy = dy;
        sheetWatch();
        if (dy <= 0) { sheetEl.style.transform = ""; return; }
        sheetEl.style.transition = "none";
        sheetEl.style.transform = "translateY(" + Math.min(dy, 220) + "px)";
      };
      const sheetStop = e => {
        if (!sheetSwipe || e.pointerId !== sheetSwipe.id) return;
        sheetSettle(true);
      };
      const sheetAbort = e => {
        if (!sheetSwipe) return;
        if (e && e.pointerId !== undefined && e.pointerId !== sheetSwipe.id) return;
        sheetSettle(false);
      };
      const sheetOnVisibility = () => { if (document.visibilityState === "hidden" && sheetSwipe) sheetSettle(false); };
      sheetBar.addEventListener("pointerdown", e => {
        if (e.button !== undefined && e.button !== 0) return;
        if (e.target.closest("[data-act=view2d]")) return;
        if (!st.tab3d || !window.matchMedia("(max-width: 899px)").matches) return;
        // A previous drag whose release went missing must be settled, not stacked onto.
        if (sheetSwipe) sheetSettle(false);
        sheetSwipe = { id: e.pointerId, y: e.clientY, dy: 0 };
        window.addEventListener("pointermove", sheetMove);
        window.addEventListener("pointerup", sheetStop);
        window.addEventListener("pointercancel", sheetAbort);
        window.addEventListener("blur", sheetAbort);
        window.addEventListener("pagehide", sheetAbort);
        document.addEventListener("visibilitychange", sheetOnVisibility);
        sheetWatch();
      });
    }

    const dlg = $("#sk-save-dlg", root);
    const nameIn = $("#sk-save-name", root);
    nameIn.addEventListener("input", updateSavePreview);
    dlg.addEventListener("close", () => { if (dlg.returnValue === "ok") doSave(nameIn.value); });
    // « Annuler » is not a submit button: « Enregistrer » is the dialog's default, and Enter in the name field saves.
    dlg.addEventListener("click", e => { const b = e.target.closest("[data-close]"); if (b) { e.preventDefault(); dlg.close("cancel"); } });
    nameIn.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); if (dlg.open) dlg.close("ok"); } });
    const odlg = $("#sk-open-dlg", root);
    const libSearch = $("#sk-lib-search", root), libSort = $("#sk-lib-sort", root);
    if (libSearch) {
      libSearch.addEventListener("input", renderList);
      libSearch.addEventListener("keydown", e => { if (e.key === "Enter") e.preventDefault(); }); // a search never closes the dialog
    }
    if (libSort) libSort.addEventListener("change", renderList);
    const dxfIn = $("#sk-dxf-file", root);
    if (dxfIn) dxfIn.addEventListener("change", () => importDxfFile(dxfIn.files && dxfIn.files[0]));
    if (odlg) odlg.addEventListener("close", () => { if (libSearch) libSearch.value = ""; if (libSort) libSort.value = "recent"; });
  }

  function refreshAll() { syncUnderlay(); renderToolbar(); renderProps(); syncSettings(); draw(); updateButtons(); if (st.tab3d) scheduleMesh(); }

  function setMode(mode) {
    if (!TOOLS[mode] || !st.doc) return;
    st.doc.mode = mode; // same doc, same objects: switching never drops geometry
    st.dirty = true;
    if (!TOOLS[mode].some(t => t[0] === st.tool)) st.tool = "select";
    cancelAction();
    scheduleDraft();
    refreshAll();
    skMotion("mode", { mode });
  }
  function setSketch(id) {
    st.sketch = id || ""; st.sel = []; st.arcPending = null; cancelAction();
    renderToolbar(); renderProps(); draw(); updateButtons();
  }
  function setTool(tool) {
    st.tool = tool; st.angleTaps = []; st.arcPending = null; st.arcHover = null; st.typed = null; st.guides = null; st.slotPending = null; st.splinePts = []; cancelAction();
    if (tool !== "select") st.multi = false;
    refreshAll();
    skMotion("tool", { tool });
  }

  function renderToolbar() {
    const mode = st.doc.mode;
    root.querySelector(".sk").dataset.mode = mode;
    root.querySelector(".sk").dataset.tool = st.tool;
    root.querySelectorAll(".sk-seg [data-mode]").forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
    const bar = $(".sk-tools", root);
    let h = "", group = "";
    for (const [id, label, ico, g] of TOOLS[mode]) {
      if (g !== group) {
        if (group) h += "</div>";
        h += `<div class="sk-toolset" role="group" aria-label="${TOOL_GROUP[g]}">`;
        group = g;
      }
      h += `<button type="button" class="sk-tool${st.tool === id ? " on" : ""}" data-tool="${id}" aria-pressed="${st.tool === id}"><span class="sk-ico" aria-hidden="true">${ICON[ico] || ""}</span><span>${label}</span></button>`;
      // Multi-select belongs to the selection tool, not to a group of its own.
      if (id === "select" && st.tool === "select") h += `<button type="button" class="sk-tool sk-multi${st.multi ? " on" : ""}" data-act="multi" aria-pressed="${st.multi}"><span class="sk-ico" aria-hidden="true">${ICON.multi}</span><span>Multi</span></button>`;
    }
    if (group) h += "</div>";
    h += `<div class="sk-toolset sk-symmetry-group" role="group" aria-label="Transformation">
      <button type="button" class="sk-tool" data-act="symmetry" aria-label="Symétrie (miroir haut/bas)" title="Symétrie : miroir haut/bas de la sélection" disabled><span class="sk-ico" aria-hidden="true">${ICON.symmetry}</span><span>Symétrie</span></button></div>`;
    if (mode === "construction" && inV6()) {
      const sks = st.doc.sketches || [];
      if (st.sketch && !sks.some(x => x.id === st.sketch)) st.sketch = "";
      // The picker and « Nouvelle » travel as one unit; the button no longer repeats the select's own label.
      h += `<div class="sk-toolset sk-sketch-group" role="group" aria-label="Esquisse"><label class="sk-sketch"><span>Esquisse</span><select class="sk-sketch-sel" aria-label="Esquisse active">
        <option value=""${st.sketch ? "" : " selected"}>Base · plan XY</option>
        ${sks.map(x => `<option value="${esc(x.id)}"${x.id === st.sketch ? " selected" : ""}>${esc(x.name)} · ${esc(x.plane)}${x.offset ? " " + (x.offset > 0 ? "+" : "") + S.fmt(x.offset) : ""}</option>`).join("")}
      </select></label><button type="button" class="sk-tool" data-act="newSketch" aria-label="Nouvelle esquisse" title="Nouvelle esquisse" aria-expanded="${st.newSketch}"><span class="sk-ico" aria-hidden="true">${ICON.newSketch}</span><span>Nouvelle</span></button></div>`;
    }
    bar.innerHTML = h;
  }
  function syncSettings() {
    const s = $(".sk-settings", root), d = st.doc;
    const set = (k, v, prop) => { const el = s.querySelector(`[data-set="${k}"]`); if (el && document.activeElement !== el) el[prop || "value"] = v; };
    set("units", d.units); set("spacing", S.fmt(d.grid.spacing, 6)); set("visible", d.grid.visible, "checked");
    set("gsnap", d.grid.snap, "checked"); set("asnap", d.snap.angle, "checked"); set("astep", String(d.snap.angleStep));
    const ar = s.querySelector('[data-pref="autoRules"]');
    if (ar) { ar.checked = !!st.autoRules; ar.closest("label").hidden = !inV6(); }
    const pv = (k, v, prop) => { const el = s.querySelector(`[data-pref="${k}"]`); if (el && document.activeElement !== el) el[prop || "value"] = v; };
    pv("autoDims", !!st.autoDims, "checked"); pv("recognize", !!st.recognize, "checked"); pv("stylusOnly", !!st.stylusOnly, "checked");
    pv("pressure", String(st.pressure)); pv("inkWidth", String(st.inkWidth));
    syncInk();
  }
  /** The ink presets: which swatch is active, and the width the pen will use. */
  function syncInk() {
    if (!root) return;
    root.querySelectorAll("[data-ink]").forEach(b => {
      const on = (b.dataset.ink || "") === (st.inkColor || "");
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  function updateButtons() {
    const set = (n, off) => root.querySelectorAll(`[data-act="${n}"]`).forEach(el => { el.disabled = off; });
    set("undo", !st.hist.canUndo());
    set("redo", !st.hist.canRedo());
    set("delete", !st.sel.length);
    set("symmetry", !st.sel.length);
    // The save button carries the only unsaved-work signal: a dot while the document differs from the saved one,
    // red when the local draft could not be written either (the work is then only in memory).
    const save = root.querySelector(".sk-save");
    if (save) {
      const warn = !!st.draftFailed, dirty = !!st.dirty || warn;
      save.classList.toggle("is-dirty", dirty);
      save.classList.toggle("is-warn", warn);
      save.setAttribute("aria-label", warn ? "Enregistrer (brouillon local non sauvegardé)" : dirty ? "Enregistrer (modifications non enregistrées)" : "Enregistrer");
      save.title = warn ? "Brouillon local non sauvegardé — enregistre pour ne rien perdre" : dirty ? "Modifications non enregistrées" : "Tout est enregistré";
      const chip = root.querySelector(".sk-dirty-chip");
      if (chip) { chip.hidden = !dirty; chip.textContent = warn ? "Non sauvegardé" : "Non enregistré"; chip.title = save.title; }
    }
  }

  function selectedProfile() { return profileFrom(st.sel); }
  /** A profile from picked objects: one picked line grows to its whole rectangle (group) or connected outline. */
  function profileFrom(ids) {
    if (!ids.length) return [];
    const chosen = ids.map(id => S.getObj(st.doc, id)).filter(o => S.profileObject(o));
    if (!chosen.length) return [];
    if (chosen.length !== 1 || (chosen[0].type !== "line" && chosen[0].type !== "arc")) return chosen.map(o => o.id);
    const first = chosen[0];
    if (first.group) return st.doc.objects.filter(o => S.profileObject(o) && o.group === first.group).map(o => o.id);
    const seen = new Set(), queue = [first], chain = o => !o.construction && (o.type === "line" || o.type === "arc");
    while (queue.length) {
      const line = queue.pop(); if (seen.has(line.id)) continue; seen.add(line.id);
      for (const o of st.doc.objects) if (chain(o) && !seen.has(o.id) && (o.sketch || "") === (line.sketch || "") && [o.p1, o.p2].some(p => p === line.p1 || p === line.p2)) queue.push(o);
    }
    return [...seen];
  }

  // ------------------------------------------------------------ 3D atelier
  // The picture keeps the direct manipulations (orbit, zoom, face and edge picks); everything that changes the part
  // lives beside it, on three tabs: the part's functions, the next operation, the selected function's values. On a
  // phone the same panel becomes a bottom sheet, so the model keeps most of the screen.

  const ATELIER_ICON = { extrude: ICON.extrude, revolve: ICON.revolve, cut: ICON.cut, hole: ICON.hole, shell: ICON.shell,
    pattern: ICON.pattern, fillet: ICON.fillet, chamfer: ICON.chamfer, sweep: ICON.sweep, loft: ICON.loft };
  const GROUP_NAMES = { base: "Base", add: "Ajouts", cut: "Enlèvements", trim: "Finitions" };
  const DRIVE_KEYS = ["depth", "thickness", "radius", "distance", "angle", "dx", "dy", "cx", "cy"];
  const readNum = v => { const n = Number(String(v == null ? "" : v).replace(",", ".")); return isFinite(n) ? n : 0; };
  const narrow = () => { try { return window.matchMedia("(max-width: 900px)").matches; } catch (_) { return false; } };
  function status3d(text) { const el = $(".sk-3d-status", root); if (el) el.textContent = text; }
  function selectedFeature() { const fs = st.doc.features || []; return st.featSel ? fs.find(f => f.id === st.featSel) || null : null; }
  function toastAction(msg) {
    st.actionToast = msg;
    clearTimeout(st.toastTimer);
    st.toastTimer = setTimeout(() => { st.actionToast = ""; renderSolid(); }, 8000);
  }

  /** One entry per operation: `ok` is what the sheet would accept as a press right now, `why` is the missing piece.
   * `starts` means the operation can still build the FIRST body from what the atelier holds, which keeps the
   * Opération grid on screen — it stays true while a retained sweep/loft profile waits for its path or 2nd profile,
   * even then `ok` is false. Congé and Chanfrein only ever work on edges of a part that already exists. */
  function opList() {
    const feats = st.doc.features || [];
    const closed = selectedProfile().length > 0, circles = selectedCircles().length > 0, v6 = inV6();
    const revolve = revolveSelection(), revolveReady = !!(revolve.axis && revolve.profile.length);
    // Balayage and Lissage ask for their profile first, then what the run needs: a path for one, a 2nd profile
    // for the other. Mirroring that here is what keeps a pressable button from being refused by its own sheet.
    const sweepProfile = !!st.sweepProfile, loftProfiles = st.loftProfiles.length, picked = profileFrom(st.sel).length > 0;
    const v6Only = "version 6 (OpenCascade) requise sur ce poste";
    return [
      { id: "boss", label: "Bossage", icon: "extrude", ok: closed, starts: closed, why: "sélectionne un contour fermé" },
      { id: "cut", label: "Enlèvement", icon: "cut", ok: feats.length > 0 && closed, why: feats.length ? "sélectionne un contour fermé" : "crée d'abord une pièce" },
      { id: "hole", label: "Trou", icon: "hole", ok: feats.length > 0 && circles, why: feats.length ? "touche un cercle du dessin" : "crée d'abord une pièce" },
      { id: "revolve", label: "Révolution", icon: "revolve", ok: revolveReady, starts: revolveReady, why: "sélectionne un demi-profil et un trait d'axe" },
      { id: "shell", label: "Évider", icon: "shell", ok: feats.length > 0 && !feats.some(f => f.type === "shell"), why: feats.length ? "une seule coque par pièce" : "crée d'abord une pièce" },
      { id: "pattern", label: "Répéter", icon: "pattern", ok: feats.some(f => f.type === "cut" || f.type === "hole"), why: "ajoute d'abord un trou ou une coupe" },
      { id: "fillet", label: "Congé", icon: "fillet", ok: v6, why: v6Only },
      { id: "chamfer", label: "Chanfrein", icon: "chamfer", ok: v6, why: v6Only },
      // A retained sweep/loft profile is a first body in the making: the grid has to stay reachable to apply it.
      { id: "sweep", label: "Balayage", icon: "sweep", ok: v6 && (sweepProfile ? st.sel.length > 0 : picked), starts: v6 && sweepProfile,
        why: !v6 ? v6Only : sweepProfile ? "sélectionne le chemin du balayage" : "sélectionne le profil à balayer" },
      { id: "loft", label: "Lissage", icon: "loft", ok: v6 && (loftProfiles >= 2 || picked), starts: v6 && loftProfiles > 0,
        why: !v6 ? v6Only : loftProfiles >= 2 ? "" : loftProfiles ? "sélectionne un deuxième profil" : "sélectionne un profil à lisser" },
    ];
  }

  function startOp(id) {
    const op = opList().find(o => o.id === id);
    if (!op || !op.ok) { const why = op ? op.label + " : " + op.why : "Opération inconnue"; say(why, "err"); flashHud(why); return; }
    st.boss.op = id === "cut" ? "cut" : "add";
    st.pendingOp = id;
    st.atelier = "ops";
    if (id === "fillet" || id === "chamfer") { st.edgePick = { picks: [] }; pickEdges(); }
    renderSolid();
  }
  function pickEdges() {
    st.edgePick = st.edgePick || { picks: [] };
    if (solidView) { solidView.setEdgeMode(true); solidView.setMarked(st.edgePick.picks, false); }
    setView3d(true);
    status3d("Touche les arêtes dans la vue, puis applique");
  }
  function runOp(id) {
    if (id === "boss" || id === "cut") {
      st.boss.op = id === "cut" ? "cut" : "add";
      st.pendingOp = "";
      if (inV6()) createV6Step("boss"); else createSolid(id === "cut" ? "cut" : "extrude");
      renderSolid();
      return;
    }
    if (id === "fillet" || id === "chamfer") {
      if (!st.edgePick || !st.edgePick.picks.length) { pickEdges(); return; }
      st.pendingOp = "";
      createV6Step(id);
      st.edgePick = null;
      if (solidView) { solidView.setEdgeMode(false); solidView.setMarked([], false); }
      renderSolid();
      return;
    }
    if (id === "sweep") {
      if (!st.sweepProfile) {
        st.sweepProfile = profileFrom(st.sel);
        if (!st.sweepProfile.length) { st.sweepProfile = null; say("Sélectionne d'abord le profil à balayer", "err"); return; }
        st.sel = []; refreshAll();
        say("Profil retenu · sélectionne le chemin");
        renderSolid();
        return;
      }
      if (!st.sel.length) { say("Sélectionne le chemin du balayage", "err"); return; }
      st.pendingOp = ""; createV6Step("sweep"); renderSolid();
      return;
    }
    if (id === "loft") {
      if (st.loftProfiles.length >= 2) { st.pendingOp = ""; createV6Step("loft"); renderSolid(); return; }
      const prof = profileFrom(st.sel);
      if (!prof.length) { say("Sélectionne un profil à ajouter", "err"); return; }
      st.loftProfiles.push(prof);
      st.sel = []; refreshAll();
      say("Profil " + st.loftProfiles.length + " retenu · il en faut 2");
      renderSolid();
      return;
    }
    st.pendingOp = "";
    createStep(id); // trou, coque, répétition, révolution
    renderSolid();
  }

  function selectFeature(id) { st.featSel = id; if (narrow()) st.atelier = "props"; renderSolid(); }
  function toggleFeature(id) {
    const f = (st.doc.features || []).find(x => x.id === id);
    if (!f) return;
    const res = S.updateFeature(st.doc, id, { suppressed: !f.suppressed });
    if (!res.ok) { say(res.error, "err"); return; }
    applySolidDoc(res.doc, f.suppressed ? "Fonction réactivée" : "Fonction désactivée");
  }
  function setRollbackAt(n) {
    const len = (st.doc.features || []).length;
    const res = S.setRollback(st.doc, n >= len ? null : Math.max(1, n));
    if (!res.ok) { say(res.error, "err"); return; }
    applySolidDoc(res.doc, n >= len ? "Toute la pièce" : "Construite jusqu'à la fonction " + n);
  }
  function commitRename(input) {
    const id = input.dataset.rename;
    st.renaming = "";
    const res = S.updateFeature(st.doc, id, { name: String(input.value || "").trim() });
    if (!res.ok) { say(res.error, "err"); renderSolid(); return; }
    commit(res.doc);
  }
  function drivenAction(kind, field) {
    const f = selectedFeature();
    if (!f) { say("Sélectionne une fonction", "err"); return; }
    const map = Object.assign({}, f.driven || {});
    if (kind === "add") {
      const sel = root.querySelector('[data-driven="field"]'), inp = root.querySelector('[data-driven="new"]');
      const key = sel ? sel.value : "", expr = inp ? String(inp.value || "").trim() : "";
      if (!key || !expr) { say("Choisis un champ et une expression", "err"); return; }
      map[key] = expr;
    } else if (kind === "off") delete map[field];
    applyDriven(f, map);
  }
  function applyDriven(f, map) {
    const res = S.updateFeature(st.doc, f.id, { driven: map });
    if (!res.ok) { say(res.error, "err"); renderSolid(); return; }
    const rebuilt = S.applyParameters(res.doc);
    if (!rebuilt.ok) { commit(res.doc); say("Expression enregistrée · " + rebuilt.error, "err"); renderSolid(); return; }
    applySolidDoc(rebuilt.doc, "Valeur pilotée mise à jour");
  }
  function drivenFromInput(t) {
    const f = selectedFeature();
    const key = t.dataset.field;
    if (!f || !key) return;
    const map = Object.assign({}, f.driven || {});
    const expr = String(t.value || "").trim();
    if (expr) map[key] = expr; else delete map[key];
    applyDriven(f, map);
  }

  /** Closed outlines around the picked profile, in millimetres: circles and line chains that come back to their start. */
  function profileLoops() {
    const ids = selectedProfile().slice(0, 64), pm = S.pointMap(st.doc), loops = [];
    for (const id of ids) {
      const o = S.getObj(st.doc, id);
      if (o && o.type === "circle") {
        const c = pm.get(o.center); if (!c) continue;
        const pts = [];
        for (let i = 0; i < 32; i++) { const a = i / 32 * Math.PI * 2; pts.push([c.x + o.r * Math.cos(a), c.y + o.r * Math.sin(a)]); }
        loops.push(pts);
      }
    }
    const lines = ids.map(id => S.getObj(st.doc, id)).filter(o => o && o.type === "line");
    const adj = new Map();
    for (const l of lines) for (const p of [l.p1, l.p2]) { if (!adj.has(p)) adj.set(p, []); adj.get(p).push(l); }
    const used = new Set();
    for (const l of lines) {
      if (used.has(l.id)) continue;
      const loop = []; let cur = l, from = l.p1, start = l.p1, closed = false;
      while (cur) {
        used.add(cur.id); loop.push(from);
        const next = cur.p1 === from ? cur.p2 : cur.p1;
        if (next === start) { closed = true; break; }
        from = next;
        cur = (adj.get(next) || []).find(x => !used.has(x.id)) || null;
      }
      if (closed && loop.length >= 3) loops.push(loop.map(pid => { const p = pm.get(pid); return [p.x, p.y]; }));
    }
    return loops;
  }
  function opDepth() { return inV6() ? readNum(st.boss.depth) : (st.boss.op === "cut" ? readNum(st.cutDepth) : readNum(st.solidDepth)); }
  function ghostPolys() {
    const depth = opDepth();
    if (!(depth > 0)) return [];
    const out = [];
    for (const loop of profileLoops()) {
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const a = loop[i], b = loop[(i + 1) % n];
        out.push([[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], depth], [a[0], a[1], depth]]);
      }
    }
    return out;
  }
  function updateGhost() {
    if (!solidView) return;
    const live = (st.pendingOp === "boss" || st.pendingOp === "cut") && profileLoops().length > 0;
    solidView.setGhost(live ? ghostPolys() : []);
  }

  function meshZRange() {
    let lo = Infinity, hi = -Infinity;
    for (const t of st.mesh) for (const p of t) { lo = Math.min(lo, p[2]); hi = Math.max(hi, p[2]); }
    return isFinite(lo) && hi > lo ? [lo, hi] : null;
  }
  function onClipInput(e) {
    const range = meshZRange();
    if (!range || !solidView) return;
    const t = Number(e.target.value) / 100;
    st.clip = t >= 0.999 ? null : range[0] + (range[1] - range[0]) * t;
    solidView.setClip(st.clip);
    const lab = $(".sk-clip-val", root);
    if (lab) lab.textContent = st.clip == null ? "toute la pièce" : "Z ≤ " + S.fmt(st.clip, 2) + " " + st.doc.units;
  }
  function toggleMeasure(on) {
    st.measureMode = on == null ? !st.measureMode : !!on;
    st.measurePicks = [];
    if (st.measureMode) { st.edgePick = null; if (solidView) { solidView.setEdgeMode(false); solidView.setMarked([], false); } }
    const b = root.querySelector('[data-act="measure"]');
    if (b) b.setAttribute("aria-pressed", String(st.measureMode));
    status3d(st.measureMode ? "Touche deux points de la pièce pour mesurer" : "");
    renderSolid();
  }
  function toggleSection(on) {
    st.section = on == null ? !st.section : !!on;
    if (!st.section) { st.clip = null; if (solidView) solidView.setClip(null); }
    const b = root.querySelector('[data-act="section"]');
    if (b) b.setAttribute("aria-pressed", String(st.section));
    renderSolid();
  }
  function measureText() {
    const picks = st.measurePicks || [];
    if (st.measureMode && picks.length < 2) return picks.length ? "Mesure : touche le second point" : "Mesure : touche deux points de la pièce";
    if (picks.length < 2) return "";
    const a = picks[0], b = picks[1], d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    return `L ${S.fmt(Math.hypot(d[0], d[1], d[2]), 2)} ${st.doc.units} · ΔX ${S.fmt(Math.abs(d[0]), 2)} · ΔY ${S.fmt(Math.abs(d[1]), 2)} · ΔZ ${S.fmt(Math.abs(d[2]), 2)}`;
  }

  function treeRow(r) {
    const cur = st.featSel === r.id, renaming = st.renaming === r.id;
    return `<div class="sk-frow${cur ? " is-cur" : ""}${r.suppressed ? " is-off" : ""}${r.active ? "" : " is-past"}" data-frow="${esc(r.id)}" data-findex="${r.index}">
      <span class="sk-grip" data-grip="1" title="Glisser pour réordonner" aria-hidden="true">${ICON.grip}</span>
      <button type="button" class="sk-roll" data-roll="${r.index + 1}" title="Construire jusqu'ici" aria-label="Construire jusqu'à ${esc(r.name)}"></button>
      <span class="sk-fico" aria-hidden="true">${ATELIER_ICON[r.type] || ""}</span>
      ${renaming ? `<input class="sk-frename" data-rename="${esc(r.id)}" type="text" maxlength="40" value="${esc(r.name)}" aria-label="Nom de la fonction"/>`
        : `<button type="button" class="sk-fname" data-fselect="${esc(r.id)}" title="${esc(r.detail || r.name)} — double-clique pour renommer">${esc(r.name)}</button>`}
      <span class="sk-fval" title="${esc(r.detail || "")}">${esc(r.value)}</span>
      ${r.driven ? `<span class="sk-fdrv" title="Valeurs pilotées par des paramètres">${ICON.driven}</span>` : ""}
      ${r.errors.length ? `<span class="sk-ferr" role="img" aria-label="${esc(r.errors.join(" · "))}" title="${esc(r.errors.join(" · "))}">${ICON.warn}</span>` : ""}
      <button type="button" class="sk-feye" data-feye="${esc(r.id)}" aria-pressed="${r.suppressed ? "false" : "true"}" aria-label="${r.suppressed ? "Réactiver" : "Désactiver"} ${esc(r.name)}">${r.suppressed ? ICON.eyeOff : ICON.eye}</button>
    </div>`;
  }
  function starters() {
    const u = esc(st.doc.units);
    return `<p class="sk-hint">Sélectionne un contour puis touche Bossage, ou pars d'une pièce type.</p><div class="sk-starters">
      <button type="button" data-starter="plate"><strong>Plaque</strong><span>100 × 60 × 6 ${u}</span></button>
      <button type="button" data-starter="bracket"><strong>Équerre</strong><span>60 × 40 × 6 ${u}, 30 ${u} de haut</span></button>
      <button type="button" data-starter="spacer"><strong>Entretoise</strong><span>Ø24 × 10 ${u}, trou M8</span></button></div>`;
  }
  function treeSection(rows) {
    const n = rows.length;
    let h = `<section class="sk-at-sec" data-sec="tree" aria-label="Fonctions de la pièce"><header class="sk-at-head"><strong>Pièce</strong><span>${n ? n + (n > 1 ? " fonctions" : " fonction") : "vide"}</span></header>`;
    if (!n) return h + starters() + `</section>`;
    const steps = history3d();
    if (steps.length > 1) h += `<div class="sk-film" role="group" aria-label="Historique de la pièce">${steps.map((s, i) => `<button type="button" class="sk-film-step${(st.preview3d == null ? i === steps.length - 1 : i === st.preview3d) ? " on" : ""}" data-hist3d-step="${i}" title="${esc(s.label)}">${i + 1}</button>`).join("")}</div>`;
    for (const g of ["base", "add", "cut", "trim"]) {
      const list = rows.filter(r => r.family === g);
      if (!list.length) continue;
      const closed = !!st.treeClosed[g];
      h += `<div class="sk-tgroup"><button type="button" class="sk-tgroup-head" data-tgroup="${g}" aria-expanded="${!closed}">${closed ? ICON.chevronRight : ICON.chevronDown}<span>${GROUP_NAMES[g]}</span></button>`;
      if (!closed) h += list.map(r => treeRow(r)).join("");
      h += `</div>`;
    }
    h += massLine(esc(st.doc.units));
    h += rollbackBar(st.doc.features || []);
    // Undo already lives in the action bar and on the canvas: the tree footer only offers the next operation.
    h += `<div class="sk-row sk-at-tools"><button type="button" class="secondary sk-with-i" data-atelier="ops">${ICON.plus}<span>Opération</span></button></div>`;
    return h + `</section>`;
  }

  function opSheet(id) {
    const u = esc(st.doc.units);
    const field = (label, inner) => `<label class="sk-pfield">${label}${inner}</label>`;
    const run = label => `<button type="button" class="sk-primary" data-op-run="${id}">${label}</button>`;
    if (id === "boss" || id === "cut") {
      return `<div class="sk-op-sheet">${field("Profondeur (" + u + ")", `<input type="number" inputmode="decimal" min="0.001" step="any" data-solid="boss.depth" value="${esc(st.boss.depth)}"/>`)}
        <p class="sk-hint">Les pointillés montrent la matière ${id === "cut" ? "enlevée" : "ajoutée"}.</p>${run(id === "cut" ? "Enlever" : "Extruder")}</div>`;
    }
    if (id === "hole") {
      return `<div class="sk-op-sheet">${field("Vis", `<select data-solid="hole.standard">${S.HOLE_STANDARDS.map(x => `<option${x === st.hole.standard ? " selected" : ""}>${esc(x)}</option>`).join("")}</select>`)}
        ${field("Jeu", `<select data-solid="hole.fit">${Object.entries(S.HOLE_FITS).map(([k, t]) => `<option value="${esc(k)}"${k === st.hole.fit ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>`)}
        ${field("Étendue", `<select data-solid="hole.extent"><option value="throughAll"${st.hole.extent === "throughAll" ? " selected" : ""}>Traversant</option><option value="blind"${st.hole.extent === "blind" ? " selected" : ""}>Borgne</option></select>`)}
        ${st.hole.extent === "blind" ? field("Profondeur (" + u + ")", `<input type="number" inputmode="decimal" min="0" step="any" data-solid="hole.depth" value="${esc(st.hole.depth)}"/>`) : ""}
        ${run("Percer " + selectedCircles().length + " trou(s)")}</div>`;
    }
    if (id === "shell") return `<div class="sk-op-sheet">${field("Paroi (" + u + ")", `<input type="number" inputmode="decimal" min="0.001" step="any" data-solid="shell.t" value="${esc(st.shell.t)}"/>`)}
      <label class="sk-chk"><input type="checkbox" data-solid="shell.open"${st.shell.open ? " checked" : ""}/> Ouverte sur le dessus</label>${run("Évider")}</div>`;
    if (id === "pattern") {
      const src = (st.doc.features || []).filter(f => f.type === "cut" || f.type === "hole");
      if (!st.pat.source || !src.some(f => f.id === st.pat.source)) st.pat.source = src.length ? src[src.length - 1].id : "";
      return `<div class="sk-op-sheet">${field("Motif à répéter", `<select data-solid="pat.source">${src.map(f => `<option value="${esc(f.id)}"${f.id === st.pat.source ? " selected" : ""}>${esc(f.name || featureTitle(f, 1))}</option>`).join("")}</select>`)}
        ${field("Disposition", `<select data-solid="pat.mode"><option value="linear"${st.pat.mode === "linear" ? " selected" : ""}>Ligne</option><option value="circular"${st.pat.mode === "circular" ? " selected" : ""}>Cercle</option></select>`)}
        ${field("Nombre", `<input type="number" inputmode="numeric" min="2" max="50" step="1" data-solid="pat.count" value="${esc(st.pat.count)}"/>`)}
        ${st.pat.mode === "linear"
          ? field("Pas X", `<input type="number" step="any" data-solid="pat.dx" value="${esc(st.pat.dx)}" placeholder="${esc(S.fmt(st.doc.grid.spacing * 2))}"/>`) + field("Pas Y", `<input type="number" step="any" data-solid="pat.dy" value="${esc(st.pat.dy)}"/>`)
          : field("Centre X", `<input type="number" step="any" data-solid="pat.cx" value="${esc(st.pat.cx)}"/>`) + field("Centre Y", `<input type="number" step="any" data-solid="pat.cy" value="${esc(st.pat.cy)}"/>`) + field("Angle (°)", `<input type="number" min="1" max="360" step="any" data-solid="pat.angle" value="${esc(st.pat.angle)}"/>`)}
        ${run("Répéter")}</div>`;
    }
    if (id === "revolve") return `<div class="sk-op-sheet">${field("Angle (°)", `<input type="number" inputmode="decimal" min="1" max="360" step="any" data-solid="revAngle" value="${esc(st.revAngle)}"/>`)}<p class="sk-hint">Le profil tourne autour du trait d'axe sélectionné.</p>${run("Tourner")}</div>`;
    if (id === "fillet" || id === "chamfer") {
      const picks = st.edgePick ? st.edgePick.picks.length : 0;
      return `<div class="sk-op-sheet">${field(id === "fillet" ? "Rayon (" + u + ")" : "Distance (" + u + ")", `<input type="number" inputmode="decimal" min="0.001" step="any" data-solid="${id === "fillet" ? "rf.radius" : "rf.distance"}" value="${esc(id === "fillet" ? st.rf.radius : st.rf.distance)}"/>`)}
        <p class="sk-hint">${picks ? picks + " arête(s) choisie(s) · touche la vue pour en ajouter ou en retirer" : "Choisis des arêtes dans la vue : touche-les une à une."}</p>
        ${run(picks ? (id === "fillet" ? "Arrondir" : "Chanfreiner") : "Choisir des arêtes")}</div>`;
    }
    if (id === "sweep") return `<div class="sk-op-sheet"><p class="sk-hint">${st.sweepProfile ? st.sweepProfile.length + " objet(s) retenus comme profil · le chemin est la sélection courante." : "Sélectionne le profil à balayer, puis le chemin."}</p>${run(st.sweepProfile ? "Balayer" : "Retenir le profil")}</div>`;
    return `<div class="sk-op-sheet"><p class="sk-hint">${st.loftProfiles.length} profil(s) retenus · il en faut 2 ou plus, sélectionnés l'un après l'autre.</p>${run(st.loftProfiles.length >= 2 ? "Lisser" : "Ajouter le profil")}</div>`;
  }
  /** A tab with nothing to act on yet: one quiet card that names the first step, instead of a grid of
   * disabled operations or a hint about features that do not exist. */
  function atelierEmpty(title, text) {
    return `<div class="sk-at-empty"><strong>${esc(title)}</strong><p>${esc(text)}</p></div>`;
  }
  function opsSection() {
    const ops = opList();
    // No part and nothing that could still start one (no closed profile, no axis, no retained sweep/loft
    // profile): every operation would be refused, so the grid would only read as leftovers.
    const canStartPart = ops.some(o => o.starts);
    if (!(st.doc.features || []).length && !canStartPart) {
      return `<section class="sk-at-sec" data-sec="ops" aria-label="Opérations"><header class="sk-at-head"><strong>Opération</strong><span>aucune pièce</span></header>
        ${atelierEmpty("Rien à opérer", "La pièce d'abord : sélectionne un contour fermé, touche Bossage, ou pars d'une pièce type dans l'onglet Pièce.")}</section>`;
    }
    let h = `<section class="sk-at-sec" data-sec="ops" aria-label="Opérations"><header class="sk-at-head"><strong>Opération</strong><span>${st.pendingOp ? esc((ops.find(o => o.id === st.pendingOp) || {}).label || "") : "sélection → opération"}</span></header>
      <div class="sk-ops" role="group" aria-label="Opérations possibles">${ops.map(o => `<button type="button" class="sk-op${o.ok ? "" : " is-off"}${st.pendingOp === o.id ? " on" : ""}" data-op="${o.id}" aria-disabled="${!o.ok}" title="${esc(o.ok ? o.label : o.label + " : " + o.why)}"><span aria-hidden="true">${ICON[o.icon] || ""}</span>${esc(o.label)}</button>`).join("")}</div>`;
    if (st.pendingOp) h += opSheet(st.pendingOp);
    else {
      const blocked = ops.filter(o => !o.ok).slice(0, 4);
      h += `<p class="sk-hint">${blocked.length ? blocked.map(o => esc(o.label) + " : " + esc(o.why)).join(" · ") : "Toutes les opérations sont disponibles."}</p>`;
    }
    return h + `</section>`;
  }

  function featureFields(f, i) {
    const u = esc(st.doc.units), id = esc(f.id);
    const num = (key, label, extra) => `<label class="sk-pfield">${label}<input type="number" inputmode="decimal" step="any" data-edit="${key}" data-feature="${id}" value="${esc(f[key] == null ? "" : S.fmt(Number(f[key])))}" ${extra || ""}/></label>`;
    const pick = (key, opts, label) => `<label class="sk-pfield">${label}<select data-edit="${key}" data-feature="${id}">${opts.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(f[key]) ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;
    const extent = () => pick("extent", [["throughAll", "Traversant"], ["blind", "Profondeur"]], "Étendue");
    let body = "";
    if (f.type === "extrude") body = num("depth", "Hauteur (" + u + ")", 'min="0.001"');
    else if (f.type === "cut") body = extent() + (f.extent === "blind" ? num("depth", "Profondeur (" + u + ")", 'min="0.001"') : "");
    else if (f.type === "revolve") body = num("angle", "Angle (°)", 'min="1" max="360"');
    else if (f.type === "hole") body = pick("standard", S.HOLE_STANDARDS.map(x => [x, x]), "Vis") + pick("fit", Object.entries(S.HOLE_FITS), "Type") + extent() + (f.extent === "blind" ? num("depth", "Profondeur (" + u + ")", 'min="0"') : "");
    else if (f.type === "shell") body = num("thickness", "Paroi (" + u + ")", 'min="0.001"') + `<label class="sk-chk"><input type="checkbox" data-edit="open" data-feature="${id}"${f.open ? " checked" : ""}/> Ouverte sur le dessus</label>`;
    else if (f.type === "fillet") body = num("radius", "Rayon (" + u + ")", 'min="0.001"');
    else if (f.type === "chamfer") body = num("distance", "Distance (" + u + ")", 'min="0.001"');
    else if (f.type === "pattern") body = num("count", "Nombre", 'min="2" max="50" step="1"') + (f.mode === "linear" ? num("dx", "Pas X", "") + num("dy", "Pas Y", "") : num("cx", "Centre X", "") + num("cy", "Centre Y", "") + num("angle", "Angle (°)", 'min="1" max="360"'));
    else if (f.type === "sweep") body = `<p class="sk-hint">${f.profile.length} objet(s) de profil · ${f.path.length} segment(s) de chemin</p>`;
    else if (f.type === "loft") body = `<p class="sk-hint">${f.profiles.length} profils</p>`;
    if (i > 0 && ["extrude", "revolve", "sweep", "loft"].includes(f.type)) body = pick("op", [["add", "Ajoute"], ["cut", "Enlève"]], "Opération") + body;
    return body;
  }
  function drivenBox(f) {
    const driven = f.driven || {};
    const keys = Object.keys(f).filter(k => typeof f[k] === "number" && DRIVE_KEYS.includes(k));
    if (!keys.length) return "";
    const used = keys.filter(k => driven[k] != null), free = keys.filter(k => driven[k] == null);
    return `<div class="sk-driven"><div class="sk-at-head"><strong>Valeurs pilotées</strong><span>un paramètre à la place d'un nombre</span></div>
      ${used.map(k => `<div class="sk-drow"><span>${esc(k)}</span>        <input type="text" maxlength="120" data-driven="expr" data-field="${esc(k)}" value="${esc(driven[k])}" aria-label="Expression de ${esc(k)}"/><button type="button" class="sk-mini" data-driven="off" data-field="${esc(k)}" aria-label="Détacher ${esc(k)}">${ICON.close}</button></div>`).join("")}
      ${free.length ? `<div class="sk-dadd"><select data-driven="field" aria-label="Champ à piloter">${free.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join("")}</select><input type="text" maxlength="120" data-driven="new" placeholder="épaisseur * 2" aria-label="Expression"/><button type="button" class="sk-mini" data-driven="add" aria-label="Piloter">ƒ</button></div>` : ""}
      <p class="sk-hint">Les paramètres se règlent dans « Paramètres » : l'expression est calculée ici, la pièce reçoit un nombre.</p></div>`;
  }
  function propsSection() {
    const hasPart = (st.doc.features || []).length > 0;
    const f = hasPart ? selectedFeature() : null, idx = f ? st.doc.features.indexOf(f) : -1;
    let h = `<section class="sk-at-sec" data-sec="props" aria-label="Propriétés"><header class="sk-at-head"><strong>Propriétés</strong><span>${!hasPart ? "aucune pièce" : f ? esc(featureTitle(f, idx)) : "rien de sélectionné"}</span></header>`;
    if (!hasPart) h += atelierEmpty("Aucune valeur à régler", "Les réglages d'une fonction apparaissent dès qu'elle existe. Commence par l'onglet Pièce.");
    else if (!f) h += `<p class="sk-hint">Touche une fonction pour régler ses valeurs. Double-clique une face de la pièce pour la regarder en face.</p>`;
    else {
      const id = esc(f.id);
      h += `<label class="sk-pfield">Nom<input type="text" maxlength="40" data-edit="name" data-feature="${id}" value="${esc(f.name || "")}" placeholder="${esc(featureTitle(f, idx))}"/></label>`;
      h += featureFields(f, idx) + drivenBox(f);
      h += `<div class="sk-row"><button type="button" class="secondary" data-act="remove3d" data-feature="${id}">Retirer</button></div>`;
      h += profileDims((st.doc.features || [])[0]);
    }
    if ((st.measurePicks || []).length) h += `<div class="sk-row"><button type="button" class="secondary" data-mclear="1">Effacer la mesure</button></div>`;
    return h + `</section>`;
  }

  function coachHtml() {
    if (!st.tab3d || st.coach == null) return "";
    const steps = [
      "Sélectionne un contour fermé dans le dessin 2D : un rectangle, un cercle, ou des lignes qui se touchent.",
      "Choisis « Bossage » : la pièce apparaît dans l'aperçu 3D, en pointillés d'abord.",
      "Règle la hauteur à droite ou dans l'onglet Propriétés : chaque nombre reconstruit la pièce.",
    ];
    const i = Math.min(st.coach, steps.length - 1);
    return `<div class="sk-coach-box" role="status"><strong>Atelier 3D · ${i + 1}/${steps.length}</strong><p>${esc(steps[i])}</p>
      <div class="sk-coach-acts">${i ? `<button type="button" class="secondary" data-coach="back">Précédent</button>` : ""}<button type="button" data-coach="${i === steps.length - 1 ? "done" : "next"}">${i === steps.length - 1 ? "Terminé" : "Suivant"}</button><button type="button" class="secondary" data-coach="off">Ne plus montrer</button></div></div>`;
  }
  function coachStep(action) {
    if (action === "off" || action === "done") {
      try { localStorage.setItem("tf_hq_3d_coach_v1", "1"); } catch (_) {}
      st.coach = null;
    } else if (action === "next") st.coach = Math.min(2, (st.coach || 0) + 1);
    else if (action === "back") st.coach = Math.max(0, (st.coach || 0) - 1);
    renderSolid();
  }

  function renderSolid() {
    const box = $(".sk-solid", root);
    if (!box) return;
    const where = st.atelier || "tree";
    const stage = $(".sk-3d-stage", root);
    if (stage) stage.dataset.atelier = where;
    root.querySelectorAll(".sk-atelier-tabs button[data-atelier]").forEach(b => {
      const on = b.dataset.atelier === where;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    const rows = S.featureRows(st.doc);
    if (st.featSel && !rows.some(r => r.id === st.featSel)) st.featSel = "";
    // A retained sweep/loft profile whose geometry was deleted or undone is nothing to build from: drop it here, so
    // the grid cannot offer a run over objects that no longer exist and the step does not linger in the draft.
    const alive = ids => (ids || []).some(id => !!S.getObj(st.doc, id));
    if (st.sweepProfile && !alive(st.sweepProfile)) { st.sweepProfile = null; if (st.pendingOp === "sweep") st.pendingOp = ""; }
    if ((st.loftProfiles || []).length && st.loftProfiles.some(p => !alive(p))) {
      st.loftProfiles = st.loftProfiles.filter(alive);
      if (st.pendingOp === "loft" && !st.loftProfiles.length) st.pendingOp = "";
    }
    // no feature yet: the viewport introduces itself and the view tools stay out of the way
    const empty = $(".sk-empty", root);
    if (empty) empty.hidden = rows.length > 0;
    if (stage) stage.toggleAttribute("data-empty", !rows.length);
    box.innerHTML = `${st.actionToast ? `<div class="sk-undo-toast" role="status">${esc(st.actionToast)}<button type="button" class="sk-mini" data-act="undo">Annuler</button></div>` : ""}${treeSection(rows)}${opsSection()}${propsSection()}`;
    const chip = $(".sk-measure", root);
    if (chip) { const m = measureText(); chip.textContent = m; chip.hidden = !m; }
    const coach = $(".sk-coach", root);
    if (coach) { coach.innerHTML = coachHtml(); coach.hidden = !coach.innerHTML; }
    const clipBox = $(".sk-clip", root);
    if (clipBox) clipBox.hidden = !st.section;
    const clipIn = clipBox && clipBox.querySelector("input[data-clip]");
    if (clipIn) clipIn.disabled = !st.mesh.length;
    updateGhost();
    if (solidView) solidView.setClip(st.section ? st.clip : null);
  }

  /** A starter part: a few primitives and one extrusion, built without a drawing. */
  function startPart(kind) {
    const d = S.createDoc({ units: st.doc.units, spacing: st.doc.grid.spacing, mode: st.doc.mode });
    let res = null, note = "Pièce de départ créée";
    if (kind === "plate") {
      const rect = S.addRect(d, { x: 0, y: 0 }, { x: 100, y: 60 });
      res = rect ? S.addFeature(d, "extrude", rect.lines, 6, "blind") : null;
    } else if (kind === "bracket") {
      const pts = [[0, 0], [60, 0], [60, 6], [6, 6], [6, 40], [0, 40]];
      const lines = [];
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; const l = S.addLine(d, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }); if (l) lines.push(l); }
      res = lines.length >= 3 ? S.addFeature(d, "extrude", lines, 30, "blind") : null;
    } else {
      const circle = S.addCircle(d, { x: 0, y: 0 }, 12);
      const base = circle ? S.addFeature(d, "extrude", [circle], 10, "blind") : null;
      if (base && base.ok) {
        const holed = S.addSolidStep(base.doc, { type: "hole", at: [circle], standard: "M8", fit: "clearance", extent: "throughAll", depth: 0 });
        if (holed.ok) res = holed; else { res = base; note = "Entretoise sans trou : noyau de perçage absent"; }
      }
    }
    if (!res || !res.ok) { say((res && res.error) || "Pièce impossible", "err"); return; }
    st.sel = []; st.featSel = (res.doc.features || [])[0].id; st.atelier = "props"; st.pendingOp = "";
    applySolidDoc(res.doc, note).then(ok => { if (ok) setView3d(true); });
  }

  function onAtelierClick(e) {
    const tab = e.target.closest("button[data-atelier]"); // the stage itself carries data-atelier: buttons only
    if (tab) { st.atelier = tab.dataset.atelier; renderSolid(); return; }
    const op = e.target.closest("[data-op]");
    if (op) { startOp(op.dataset.op); return; }
    const run = e.target.closest("[data-op-run]");
    if (run) { runOp(run.dataset.opRun); return; }
    const part = e.target.closest("[data-starter]");
    if (part) { startPart(part.dataset.starter); return; }
    const sel = e.target.closest("[data-fselect]");
    if (sel) { selectFeature(sel.dataset.fselect); return; }
    const eye = e.target.closest("[data-feye]");
    if (eye) { toggleFeature(eye.dataset.feye); return; }
    const roll = e.target.closest("[data-roll]");
    if (roll) { setRollbackAt(Number(roll.dataset.roll)); return; }
    const group = e.target.closest("[data-tgroup]");
    if (group) { st.treeClosed[group.dataset.tgroup] = !st.treeClosed[group.dataset.tgroup]; renderSolid(); return; }
    const step = e.target.closest("[data-hist3d-step]");
    if (step) { previewStep(Number(step.dataset.hist3dStep)); return; }
    const view = e.target.closest("button[data-view]"); // the page body carries data-view: buttons only
    if (view) { if (solidView) solidView.setView(view.dataset.view); return; }
    const coach = e.target.closest("[data-coach]");
    if (coach) { coachStep(coach.dataset.coach); return; }
    const driven = e.target.closest("[data-driven]");
    if (driven && driven.tagName === "BUTTON") { drivenAction(driven.dataset.driven, driven.dataset.field); return; }
    if (e.target.closest("[data-mclear]")) { st.measurePicks = []; renderSolid(); return; }
    const row = e.target.closest("[data-frow]");
    if (row && !e.target.closest("button, input, select")) selectFeature(row.dataset.frow);
  }
  function onAtelierDblClick(e) {
    const name = e.target.closest("[data-fselect]");
    if (!name) return;
    st.renaming = name.dataset.fselect;
    renderSolid();
    const inp = root.querySelector("[data-rename]");
    if (inp) { inp.focus(); inp.select(); }
  }
  function wireAtelier() {
    const stage = $(".sk-3d-stage", root);
    if (!stage) return;
    stage.addEventListener("click", onAtelierClick);
    stage.addEventListener("dblclick", onAtelierDblClick);
    const solid = $(".sk-solid", root);
    solid.addEventListener("change", e => {
      if (e.target.matches("[data-rename]")) commitRename(e.target);
      else if (e.target.matches("[data-driven=\"expr\"]")) drivenFromInput(e.target);
    });
    solid.addEventListener("keydown", e => {
      if (e.target.matches("[data-rename]")) {
        if (e.key === "Enter") { e.preventDefault(); commitRename(e.target); }
        else if (e.key === "Escape") { e.preventDefault(); st.renaming = ""; renderSolid(); }
      } else if (e.target.matches("[data-driven=\"new\"]") && e.key === "Enter") { e.preventDefault(); drivenAction("add"); }
    });
    // Reordering by the grip: pointer events, so it works with a mouse, a pen and a finger (a phone has no HTML5 drag).
    solid.addEventListener("pointerdown", e => {
      const grip = e.target.closest("[data-grip]");
      const row = grip && grip.closest("[data-frow]");
      if (!row) return;
      e.preventDefault();
      const from = row.dataset.frow, startY = e.clientY;
      let moved = false;
      const aim = ev => {
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        return under && under.closest ? under.closest("[data-frow]") : null;
      };
      const move = ev => {
        if (!moved && Math.abs(ev.clientY - startY) < 4) return;
        moved = true; st.dragFeat = from;
        row.classList.add("is-drag");
        const target = aim(ev);
        solid.querySelectorAll(".is-drop").forEach(x => x.classList.remove("is-drop"));
        if (target && target !== row) target.classList.add("is-drop");
      };
      const up = ev => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        const target = moved ? aim(ev) : null;
        row.classList.remove("is-drag");
        solid.querySelectorAll(".is-drop").forEach(x => x.classList.remove("is-drop"));
        st.dragFeat = "";
        if (!target || target === row) return;
        const res = S.moveFeatureTo(st.doc, from, Number(target.dataset.findex));
        if (!res.ok) { say(res.error, "err"); return; }
        st.featSel = from;
        applySolidDoc(res.doc, "Fonction déplacée");
      };
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
    const clip = root.querySelector(".sk-clip input[data-clip]");
    if (clip) clip.addEventListener("input", onClipInput);
  }

  const FEATURE_NAMES = { extrude: "Extrusion", revolve: "Révolution", cut: "Enlèvement", hole: "Trou", shell: "Coque", pattern: "Répétition",
    fillet: "Congé", chamfer: "Chanfrein", sweep: "Balayage", loft: "Lissage" };
  function featureTitle(f, i) {
    if (i > 0 && ["extrude", "revolve", "sweep", "loft"].includes(f.type)) return (f.op === "cut" ? "Enlèvement · " : "Bossage · ") + FEATURE_NAMES[f.type].toLowerCase();
    return FEATURE_NAMES[f.type] || f.type;
  }
  /** The base profile's own dimensions, editable: a line's length or a circle's radius rebuilds the part. */
  function profileDims(base) {
    if (!base || !base.profile) return "";
    const pm = S.pointMap(st.doc), u = esc(st.doc.units), rows = [];
    for (const id of base.profile.slice(0, 16)) {
      const o = S.getObj(st.doc, id); if (!o) continue;
      if (o.type === "circle") rows.push(`<label class="sk-feat-num">Rayon <input type="number" inputmode="decimal" step="any" min="0.001" data-dim-circle="${esc(id)}" value="${esc(S.fmt(o.r))}"/> ${u}</label>`);
      else if (o.p1 && o.p2) {
        const a = pm.get(o.p1), b = pm.get(o.p2);
        if (a && b) rows.push(`<label class="sk-feat-num">Côté ${rows.length + 1} <input type="number" inputmode="decimal" step="any" min="0.001" data-dim-line="${esc(id)}" value="${esc(S.fmt(Math.hypot(b.x - a.x, b.y - a.y)))}"/> ${u}</label>`);
      }
    }
    return rows.length ? `<div class="sk-dims"><span class="hint">Cotes du profil de base (le côté s'allonge depuis son premier point) :</span>${rows.join("")}</div>` : "";
  }
  function partCenter() {
    const base = (st.doc.features || [])[0];
    const pm = S.pointMap(st.doc);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of (base && base.profile) || []) {
      const o = S.getObj(st.doc, id); if (!o) continue;
      const pts = o.type === "circle" ? [pm.get(o.center)].filter(Boolean).flatMap(c => [{ x: c.x - o.r, y: c.y - o.r }, { x: c.x + o.r, y: c.y + o.r }]) : [pm.get(o.p1), pm.get(o.p2)].filter(Boolean);
      for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    }
    return isFinite(x0) ? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } : { x: 0, y: 0 };
  }
  function selectedCircles() { return st.sel.filter(id => { const o = S.getObj(st.doc, id); return o && o.type === "circle" && !o.construction; }); }
  function revolveSelection() {
    const axes = st.sel.filter(id => (S.getObj(st.doc, id) || {}).type === "centerline");
    return { axis: axes.length === 1 ? axes[0] : null, profile: profileFrom(st.sel.filter(id => !axes.includes(id))) };
  }

  function rollbackBar(features) {
    if (!inV6() || (Number(st.doc.version) || 1) < 6 || features.length < 2) return "";
    const at = st.doc.rollback == null ? features.length : st.doc.rollback;
    return `<div class="sk-rollback"><label>Point de retour <input type="range" min="1" max="${features.length}" step="1" value="${at}" data-rollback aria-label="Construire jusqu'à la fonction"/></label>
      <span class="hint">${at >= features.length ? "toutes les fonctions" : "jusqu'à la fonction " + at + " (les suivantes sont ignorées)"}</span></div>`;
  }
  function massLine(u) {
    const m = st.mass;
    if (!m || !(m.volume > 0)) return "";
    const f = v => S.fmt(v, 2);
    return `<div class="sk-mass"><span>Volume ${f(m.volume)} ${u}³ · surface ${f(m.area)} ${u}² · encombrement ${m.size.map(f).join(" × ")} ${u} · centre (${m.center.map(f).join(", ")})</span>
      <button type="button" data-act="step3d">Exporter STEP</button></div>`;
  }
  // ---- floating action bubble (hq-sketch-float.js): the useful fields next to the selection, no scrolling
  /** Selection box in stage pixels (the canvas fills its stage from the top-left corner). */
  function selectionBox() {
    const pm = S.pointMap(st.doc);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { const q = S.toScreen(st.view, st.H, x, y); x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); };
    for (const id of st.sel) {
      const o = S.getObj(st.doc, id); if (!o) continue;
      if (S.isLine(o)) { const a = pm.get(o.p1), b = pm.get(o.p2); if (a) add(a.x, a.y); if (b) add(b.x, b.y); }
      else if (o.type === "circle" || o.type === "arc") {
        const c = pm.get(o.center), r = o.type === "circle" ? o.r : S.arcGeom(o, pm).r;
        if (c) { add(c.x - r, c.y - r); add(c.x + r, c.y + r); }
      }
    }
    return isFinite(x0) ? { x0: x0, y0: y0, x1: x1, y1: y1 } : null;
  }
  /** A picked face parallel to a base plane → the sketch plane, offset and outward side that match it. */
  function faceFrame(plane) {
    const n = plane.normal, o = plane.origin, T = 1e-4;
    if (Math.abs(Math.abs(n[2]) - 1) < T) return { plane: "XY", offset: o[2], face: n[2] > 0 ? 1 : -1, map: p => [p[0], p[1]] };
    if (Math.abs(Math.abs(n[1]) - 1) < T) return { plane: "XZ", offset: -o[1], face: n[1] < 0 ? 1 : -1, map: p => [p[0], p[2]] };
    if (Math.abs(Math.abs(n[0]) - 1) < T) return { plane: "YZ", offset: o[0], face: n[0] > 0 ? 1 : -1, map: p => [p[1], p[2]] };
    return null;
  }
  /** « Esquisser sur la face »: a real, editable sketch on the picked face, with the face's outline as a faint guide. */
  function startFaceSketch() {
    const face = st.faceSelection, fr = face && faceFrame(face.plane);
    if (!fr) { say("Cette face est inclinée : utilise « Dessiner sur cette face » (rapide)", "err"); return; }
    const r = S.addSketch(st.doc, fr.plane, fr.offset, "Face " + fr.plane + " " + S.fmt(fr.offset), fr.face);
    if (!r.ok) { say(r.error, "err"); return; }
    const pl = face.plane;
    const made = r.doc.sketches.find(x => x.id === r.id);
    st.faceRef = { sketch: r.id, plane: made.plane, offset: made.offset, face: made.face, tris: face.triangles.map(t => t.map(q => fr.map([0, 1, 2].map(k => pl.origin[k] + pl.u[k] * q[0] + pl.v[k] * q[1])))) };
    commit(r.doc);
    st.faceSelection = null; st.pushPull = null; $(".sk-face-start", root).hidden = true;
    if (st.doc.mode !== "construction") setMode("construction");
    if (st.tab3d && !st.split) setView3d(false);
    setSketch(r.id);
    setTool("rect");
    say("Esquisse sur la face : dessine un contour, puis « Extruder » (Ajouter ou Enlever)");
  }
  /** « Rattacher l'esquisse »: the active sketch moves onto the picked face (same 2D coordinates, new plane/offset).
   * The other half of a face attachment that a feature edit or an undo left pointing at nothing. */
  /** « Convertir le contour »: the picked face's boundary (its UV triangulation) becomes construction lines in the
   * sketch that already lives on that face — the CAD "convert entities" that a bracket needs. */
  function convertFaceOutline() {
    const face = st.faceSelection, sk = (st.doc.sketches || []).find(x => x.id === st.sketch);
    if (!face || !sk || !(face.triangles || []).length) { say("Choisis une face et son esquisse", "err"); return; }
    const ring = S.outlineFromTriangles(face.triangles);
    if (!ring.ok) { say(ring.error, "err"); return; }
    const r = S.convertRing(st.doc, ring.pts, { sketch: st.sketch, construction: true });
    if (!r.ok) { say(r.error, "err"); return; }
    commit(r.doc); st.sel = r.ids.slice(); refreshAll();
    say("Contour de face converti · " + r.ids.length + " arêtes de construction");
  }
  function attachSketchToFace() {
    const face = st.faceSelection, fr = face && faceFrame(face.plane);
    const sk = (st.doc.sketches || []).find(x => x.id === st.sketch);
    if (!fr || !sk) { say("Choisis une face, puis l'esquisse à rattacher", "err"); return; }
    if (sk.plane === fr.plane && Math.abs((sk.offset || 0) - fr.offset) < 1e-6 && sk.face === fr.face) { say("Cette esquisse est déjà sur cette face"); return; }
    const d = S.clone(st.doc);
    const t = d.sketches.find(x => x.id === sk.id);
    t.plane = fr.plane; t.offset = fr.offset; t.face = fr.face;
    const v = S.validateDoc(d);
    if (!v.ok) { say(v.error, "err"); return; }
    st.faceRef = { sketch: t.id, plane: t.plane, offset: t.offset, face: t.face, tris: face.triangles.map(tri => tri.map(q => fr.map([0, 1, 2].map(k => face.plane.origin[k] + face.plane.u[k] * q[0] + face.plane.v[k] * q[1])))) };
    commit(d);
    say("Esquisse « " + t.name + " » rattachée à la face " + fr.plane + " " + S.fmt(fr.offset) + " " + st.doc.units);
  }
  function drawFaceRef() {
    const ref = st.faceRef;
    // only on the sketch it was made for: an undone sketch's id can be reused by another one
    const sk = ref && (st.doc.sketches || []).find(x => x.id === ref.sketch);
    if (!ref || ref.sketch !== st.sketch || !sk || sk.plane !== ref.plane || sk.offset !== ref.offset || sk.face !== ref.face) return;
    ctx.save();
    ctx.fillStyle = "rgba(61,140,255,.10)"; ctx.strokeStyle = "rgba(61,140,255,.45)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (const t of ref.tris) { t.forEach((p, i) => { const q = S.toScreen(st.view, st.H, p[0], p[1]); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); ctx.closePath(); }
    ctx.fill(); ctx.restore();
  }
  function floatSpec3d() {
    const u = st.doc.units;
    if (st.edgePick) {
      const n = st.edgePick.picks.length;
      return { sig: "edges:" + n, title: n ? n + " arête(s) choisie(s)" : "Touche des arêtes dans la vue",
        fields: [{ key: "r", label: "Rayon", type: "number", value: st.rf.radius, unit: u, min: "0", action: "fillet", live: true },
                 { key: "d", label: "Distance", type: "number", value: st.rf.distance, unit: u, min: "0", action: "chamfer", live: true }],
        actions: [{ key: "fillet", label: "Congé", primary: true, disabled: !n }, { key: "chamfer", label: "Chanfrein", disabled: !n }, { key: "edgesDone", label: "Terminer", kind: "quiet" }] };
    }
    const pp = st.pushPull;
    const fr = st.faceSelection && inV6() && faceFrame(st.faceSelection.plane);
    if (fr && !pp) {
      const sk = (st.doc.sketches || []).find(x => x.id === st.sketch);
      const onFace = !!(sk && sk.face === fr.face && sk.plane === fr.plane && Math.abs((sk.offset || 0) - fr.offset) < 1e-6);
      return { sig: "face:" + fr.plane + ":" + fr.offset + ":" + (onFace ? st.sketch : ""), title: "Face " + fr.plane + " · " + S.fmt(fr.offset) + " " + u, fields: [],
        actions: [{ key: "faceSketch", label: "Esquisser sur la face", primary: true },
          onFace ? { key: "faceConvert", label: "Convertir le contour", kind: "quiet" } : null,
          { key: "faceAttach", label: "Rattacher l'esquisse", kind: "quiet" }, { key: "faceClose", label: "Fermer", kind: "quiet" }].filter(Boolean),
        note: onFace ? "Le contour de la face peut être copié en arêtes de construction dans l'esquisse active." : "Dessine un contour sur la face, puis ajoute ou enlève de la matière." };
    }
    if (pp) {
      const step = st.doc.grid.spacing / 2, hi = Math.max(pp.depth * 3, pp.depth + st.doc.grid.spacing * 10);
      const f = (st.doc.features || [])[pp.index];
      return { sig: "pp:" + pp.id + ":" + pp.depth, title: (pp.index === 0 ? "Extrusion" : pp.op === "cut" ? "Enlèvement" : "Bossage") + " " + (pp.index + 1) + (f ? "" : ""),
        fields: [{ key: "pp", label: "Hauteur", type: "number", value: S.fmt(pp.depth), unit: u, min: "0", action: "pp", live: true },
                 { key: "ppr", label: "", type: "range", value: pp.depth, min: String(step), max: String(Math.round(hi * 1000) / 1000), step: String(step), action: "pp", live: true }],
        actions: [{ key: "pp", label: "Appliquer", primary: true }].concat(fr ? [{ key: "faceSketch", label: "Esquisser sur la face" }] : [], [{ key: "ppDone", label: "Fermer", kind: "quiet" }]),
        note: "Glisse la face elle-même, ou règle la hauteur ici ; la pièce exacte suit au relâché." };
    }
    return null;
  }
  function floatSpec() { return st.tab3d && !st.split ? floatSpec3d() : floatSpec2d(); }
  function floatSpec2d() {
    const u = st.doc.units, features = st.doc.features || [], hasPart = features.length > 0;
    if (st.tool !== "select" || st.action || !st.sel.length) return null;
    const sel = st.sel.map(id => S.getObj(st.doc, id)).filter(Boolean);
    const lines = sel.filter(o => S.isLine(o)), rounds = sel.filter(o => o.type === "circle" || o.type === "arc");
    const v6 = inV6() && st.doc.mode === "construction";
    const fields = [], actions = [];
    let title = "";
    const geo = (type, label) => v6 && actions.push({ key: "geo:" + type, label: label, kind: "chip" });
    const profile = selectedProfile();
    const singleLoop = profile.length === 1 && S.closedCurve(S.getObj(st.doc, profile[0]));
    const closed = singleLoop || (profile.length && profile.every(id => { const o = S.getObj(st.doc, id); return o && (S.isLine(o) || o.type === "circle" || o.type === "arc"); }) &&
      (profile.length > 1 || (S.getObj(st.doc, profile[0]) || {}).type === "circle"));
    if (sel.length === 1 && lines.length === 1) {
      const L = lineInfo(lines[0].id).L;
      title = (lines[0].type === "centerline" ? "Axe" : "Ligne") + " · " + S.fmt(L) + " " + u;
      fields.push({ key: "len", label: "Longueur", type: "number", value: S.fmt(L), unit: u, min: "0", action: "len" });
      actions.push({ key: "len", label: "Appliquer", primary: true });
      geo("horizontal", "H"); geo("vertical", "V"); geo("fixed", "Fixer");
    } else if (sel.length === 1 && rounds.length === 1) {
      const o = rounds[0], r = o.type === "circle" ? o.r : S.arcGeom(o, S.pointMap(st.doc)).r;
      title = (o.type === "circle" ? "Cercle · Ø " + S.fmt(2 * r) : "Arc · R " + S.fmt(r)) + " " + u;
      fields.push({ key: "rad", label: "Rayon", type: "number", value: S.fmt(r), unit: u, min: "0", action: "rad" });
      actions.push({ key: "rad", label: "Appliquer", primary: true });
      geo("fixed", "Fixer");
    } else if (sel.length === 2 && lines.length === 2) {
      const v = S.sharedVertex(st.doc, lines[0].id, lines[1].id);
      title = "Deux lignes";
      if (v) {
        fields.push({ key: "ang", label: "Angle", type: "number", value: S.fmt(S.angleBetween(st.doc, lines[0].id, lines[1].id).deg, 3), unit: "°", min: "0", max: "180", action: "ang" });
        actions.push({ key: "ang", label: "Appliquer", primary: true });
      }
      geo("parallel", "∥"); geo("perpendicular", "⊥"); geo("equal", "="); geo("collinear", "—");
    } else if (sel.length === 2 && lines.length === 1 && rounds.length === 1) { title = "Ligne et arrondi"; geo("tangent", "Tangentes"); geo("point_on_curve", "• courbe"); geo("midpoint", "M milieu"); geo("point_on_line", "Centre/ligne"); }
    else if (sel.length === 2 && rounds.length === 2) { title = "Deux arrondis"; geo("tangent", "Tangents"); geo("equal", "Même rayon"); geo("concentric", "Concentriques"); }
    else if (sel.length === 3 && rounds.length === 2 && lines.length === 1) { title = "Symétrie"; geo("symmetric", "⇋ axe"); }
    else if (rounds.length === sel.length && sel.every(o => o.type === "circle")) title = sel.length + " cercles";
    else if (!closed) return null;
    // 3D straight from the selection: extrude a closed shape, drill circles
    const circles = sel.filter(o => o.type === "circle").length;
    if (hasPart && circles && circles === sel.length) {
      fields.push({ key: "std", label: "Trou", type: "select", value: st.hole.standard, options: S.HOLE_STANDARDS.map(x => [x, x]), action: "hole" });
      actions.push({ key: "hole", label: "Percer" + (circles > 1 ? " ×" + circles : ""), primary: !fields.some(f => f.action !== "hole") });
    }
    if (closed && !(hasPart && circles && circles === sel.length && sel.length > 1)) {
      if (!title) title = "Contour fermé";
      const depth = hasPart ? st.boss.depth : st.solidDepth;
      fields.push({ key: "h", label: hasPart ? "Hauteur" : "Extrusion", type: "number", value: depth, unit: u, min: "0", action: "extrude", live: true });
      if (hasPart && inV6()) fields.push({ key: "op", label: "", type: "select", value: st.boss.op, options: [["add", "Ajouter"], ["cut", "Enlever"]], action: "extrude" });
      actions.push({ key: "extrude", label: hasPart ? (inV6() ? "Extruder" : "Enlever") : "Extruder", primary: !actions.some(a => a.primary) });
    }
    if (!fields.length && !actions.length) return null;
    const sig = ["2d", st.sel.join(","), title, hasPart, v6, st.doc.objects.length, features.length].join("|");
    return { sig: sig, title: title, fields: fields, actions: actions };
  }
  function updateFloat() {
    if (!bubble2d || !st.doc || !canvas) return;
    const stage2d = $(".sk-stage", root); if (stage2d) stage2d.classList.toggle("is-multi", !!st.multi);
    if ((st.faceSelection || st.pushPull) && st.faceAt !== st.meshVersion) { // the part changed (edit, undo, load): the picked face is stale
      st.faceSelection = null; st.pushPull = null; restorePreview();
      const b = $(".sk-face-start", root); if (b) b.hidden = true;
    }
    const show2d = !st.tab3d || st.split, show3d = st.tab3d;
    const s2 = show2d ? floatSpec2d() : null, s3 = show3d ? floatSpec3d() : null;
    if (show2d) bubble2d.show(s2, s2 ? selectionBox() : null); else bubble2d.hide();
    if (bubble3d) { if (show3d) bubble3d.show(s3, null); else bubble3d.hide(); }
    if (st.previewing && !s3 && !(s2 && s2.fields.some(f => f.key === "h"))) restorePreview(); // nothing left to preview
  }
  // ---- instant previews: the shown part changes while a value is typed or dragged; Enter / release applies
  function restorePreview() {
    if (!st.previewing) return;
    st.previewing = false; st.previewSeq++; clearTimeout(st.previewT);
    if (solidView) { solidView.setTriangles(st.mesh); solidView.setEdges(st.edges); }
    const status = $(".sk-3d-status", root);
    if (status && st.mesh.length) status.textContent = st.mesh.length + " triangles";
  }
  function previewCandidate(doc) {
    if (!st.tab3d || !doc) return;
    clearTimeout(st.previewT);
    const seq = ++st.previewSeq;
    st.previewT = setTimeout(async () => {
      try {
        const res = await window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: doc }), timeoutMs: 30000 });
        if (seq !== st.previewSeq) return;
        st.previewing = true;
        if (solidView) solidView.setTriangles(res.triangles || []);
        $(".sk-3d-status", root).textContent = "Aperçu" + (res.mass && res.mass.volume ? " · volume " + S.fmt(res.mass.volume, 2) + " " + st.doc.units + "³" : "") + " · Entrée pour appliquer";
      } catch (e) {
        if (seq === st.previewSeq) $(".sk-3d-status", root).textContent = "Aperçu impossible : " + ((e && e.message) || "valeur refusée");
      }
    }, 200);
  }
  /** Push / pull by hand: a drag that starts on the picked end face moves it along its normal (the camera does not
   * orbit). The part stretches live; releasing rebuilds it exactly. Anywhere else a drag still orbits. */
  function ppDragHandler() {
    let drag = null;
    const sameFace = (a, b) => {
      const n = a.normal, m = b.normal, d = [0, 1, 2].map(k => a.origin[k] - b.origin[k]);
      const scale = Math.max(1, Math.abs(b.origin[0]) + Math.abs(b.origin[1]) + Math.abs(b.origin[2]));
      return n[0] * m[0] + n[1] * m[1] + n[2] * m[2] > 0.9999 && Math.abs(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) < 1e-6 * scale;
    };
    return {
      start(face) {
        const pp = st.pushPull, c = $(".sk-3d-canvas", root);
        if (!pp || !st.faceSelection || st.solidBusy || !c || !c.hqSolidProject || !sameFace(face.plane, st.faceSelection.plane)) return false;
        const o = face.plane.origin, n = pp.normal, L = Math.max(1, pp.depth), r = c.getBoundingClientRect();
        const px = p => { const q = c.hqSolidProject(p); return [(q[0] + 1) / 2 * r.width, (1 - q[1]) / 2 * r.height]; };
        const a = px(o), b = px([o[0] + n[0] * L, o[1] + n[1] * L, o[2] + n[2] * L]);
        let v = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; // screen pixels per model unit along the normal
        const len = Math.hypot(v[0], v[1]);
        if (len < 1.5) v = len > 1e-9 ? [v[0] / len * 1.5, v[1] / len * 1.5] : [0, -1.5]; // seen end-on: fall back to a vertical drag
        drag = { depth0: pp.depth, v: v, val: pp.depth, q: Math.max(1e-3, st.doc.grid.spacing / 10) };
        if (solidView) solidView.lockFrame(st.mesh); // the framing stays put while the part grows
        return true;
      },
      move(dx, dy) {
        if (!drag) return;
        const k = (dx * drag.v[0] + dy * drag.v[1]) / (drag.v[0] * drag.v[0] + drag.v[1] * drag.v[1]);
        let val = Math.round((drag.depth0 + k) / drag.q) * drag.q;
        val = Math.max(drag.q, Math.round(val * 1e6) / 1e6);
        if (val === drag.val) return;
        drag.val = val;
        floatInput("ppr", { ppr: val });
      },
      end(moved) {
        const d = drag; drag = null;
        if (solidView) solidView.lockFrame(null);
        if (!d || !moved) return;
        if (d.val === d.depth0) { restorePreview(); return; }
        floatAction("pp", { pp: String(d.val) });
      },
      cancel() { drag = null; if (solidView) solidView.lockFrame(null); restorePreview(); },
    };
  }
  function floatInput(key, v) {
    const num = x => Number(String(x == null ? "" : x).replace(",", "."));
    if (key === "pp" || key === "ppr") {
      const pp = st.pushPull; if (!pp) return;
      const val = num(v[key]);
      if (!(val > 0)) return;
      if (bubble3d) bubble3d.setValue(key === "pp" ? "ppr" : "pp", key === "pp" ? val : S.fmt(val));
      st.previewing = true;
      if (solidView && I) solidView.setTriangles(I.stretch(st.mesh, pp.normal, pp.level, val - pp.depth, 1e-6 * Math.max(1, Math.abs(pp.level))));
      $(".sk-3d-status", root).textContent = "Hauteur " + S.fmt(val) + " " + st.doc.units + " · relâche ou Entrée pour appliquer";
      const res = S.updateFeature(st.doc, pp.id, { depth: val });
      if (res.ok && key === "pp") previewCandidate(res.doc); // typed: the exact part a moment later
      return;
    }
    if (key === "h") {
      const depth = num(v.h), profile = selectedProfile();
      if (!(depth > 0) || !profile.length) return;
      const res = (st.doc.features || []).length
        ? (inV6() ? S.addSolidStep(st.doc, { type: "boss", profile: profile, depth: depth, op: v.op === "cut" ? "cut" : "add" }) : S.addFeature(st.doc, "cut", profile, depth, "blind"))
        : S.addFeature(st.doc, "extrude", profile, depth, "blind");
      if (res.ok) previewCandidate(res.doc);
      return;
    }
    if (key === "r" || key === "d") {
      const val = num(v[key]);
      const edges = (st.edgePick ? st.edgePick.picks : []).map(i => st.edges[i]).filter(Boolean).map(e => ({ a: e.a, b: e.b, m: e.m || [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2, (e.a[2] + e.b[2]) / 2] }));
      if (!(val > 0) || !edges.length) return;
      const res = S.addSolidStep(st.doc, key === "r" ? { type: "fillet", edges: edges, radius: val } : { type: "chamfer", edges: edges, distance: val });
      if (res.ok) previewCandidate(res.doc);
    }
  }
  function floatAction(key, v) {
    const num = x => Number(String(x == null ? "" : x).replace(",", "."));
    if (["extrude", "hole", "fillet", "chamfer", "len", "rad"].includes(key)) st.lastFloat = { key: key, v: Object.assign({}, v) };
    setTimeout(savePrefs, 0);
    if (key === "pp") {
      const pp = st.pushPull; if (!pp) return;
      const val = num(v.pp);
      const res = S.updateFeature(st.doc, pp.id, { depth: val });
      if (!res.ok) { say(res.error, "err"); restorePreview(); return; }
      st.previewSeq++; st.previewing = false;
      applySolidDoc(res.doc, "Hauteur " + S.fmt(val) + " " + st.doc.units).then(ok => { if (!ok) restorePreview(); st.pushPull = null; updateFloat(); });
      return;
    }
    if (key === "faceSketch") { restorePreview(); startFaceSketch(); return; }
    if (key === "faceConvert") { convertFaceOutline(); return; }
    if (key === "faceAttach") { attachSketchToFace(); return; }
    if (key === "faceClose") { st.faceSelection = null; $(".sk-face-start", root).hidden = true; updateFloat(); return; }
    if (key === "ppDone") { st.pushPull = null; restorePreview(); updateFloat(); return; }
    if (key === "len") {
      const o = S.getObj(st.doc, st.sel[0]); if (!o) return;
      if (tryCommit(S.setLineLength(st.doc, o.id, o[st.fixedEnd], num(v.len)))) say("Longueur " + S.fmt(num(v.len)) + " " + st.doc.units + " appliquée");
      return;
    }
    if (key === "ang") {
      const [a, b] = st.sel; const [ref, mv] = st.swapAngle ? [b, a] : [a, b];
      if (tryCommit(S.setAngle(st.doc, mv, ref, num(v.ang)))) say("Angle " + S.fmt(num(v.ang), 3) + "° appliqué");
      return;
    }
    if (key === "rad") {
      const o = S.getObj(st.doc, st.sel[0]); if (!o) return;
      if (o.type === "arc") { applyGeo("radius", num(v.rad)); return; }
      if (tryCommit(S.updateObject(st.doc, o.id, { r: num(v.rad) }))) say("Rayon " + S.fmt(num(v.rad)) + " " + st.doc.units);
      return;
    }
    if (key.startsWith("geo:")) { applyGeo(key.slice(4)); return; }
    if (key === "hole") { if (v.std) st.hole.standard = v.std; createStep("hole"); return; }
    if (key === "extrude") {
      const depth = num(v.h), profile = selectedProfile();
      if (!(depth > 0)) { say("Hauteur invalide", "err"); return; }
      if (!(st.doc.features || []).length) { st.solidDepth = depth; createSolid("extrude", { profile: profile, depth: depth }); return; }
      if (inV6()) { st.boss.depth = depth; st.boss.op = v.op === "cut" ? "cut" : "add"; createV6Step("boss"); return; }
      st.cutDepth = depth; createSolid("cut", { profile: profile, depth: depth });
      return;
    }
    if (key === "fillet" || key === "chamfer") {
      if (key === "fillet") st.rf.radius = num(v.r); else st.rf.distance = num(v.d);
      createV6Step(key);
      return;
    }
    if (key === "edgesDone") {
      st.edgePick = null;
      if (solidView) { solidView.setEdgeMode(false); solidView.setMarked([], false); }
      renderSolid(); updateFloat();
    }
  }

  // ---- edits: every change is built by the server first; a value that breaks the part is refused, the old one stays
  async function applySolidDoc(next, okMsg) {
    if (st.solidBusy) { st.solidQueue = { doc: next, msg: okMsg }; return false; } // one rebuild at a time: the last edit wins
    const version = st.meshVersion;
    st.solidBusy = true;
    try {
      let tris = [], edges = [], mass = null;
      if ((next.features || []).length) {
        const check = await window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: rebuildDoc(next) }), timeoutMs: 45000 });
        tris = check.triangles; edges = check.edges || []; mass = check.mass || null;
      }
      if (version !== st.meshVersion) throw new Error("Le dessin a changé pendant le calcul : réessaie");
      st.preview3d = null;
      commit(next); st.mesh = tris; st.edges = edges; st.mass = mass; st.meshLoadedVersion = st.meshVersion;
      clearTimeout(st.meshTimer);
      st.faceSelection = null; st.edgeSelection = null; $(".sk-face-start", root).hidden = true;
      if (solidView) { solidView.setTriangles(tris); solidView.setEdges(edges); }
      $(".sk-3d-status", root).textContent = tris.length ? `${tris.length} triangles · glisse pour tourner · deux doigts ou clic droit pour déplacer · pince ou molette pour zoomer` : "Crée une extrusion pour voir la pièce.";
      if (okMsg) { say(okMsg); toastAction(okMsg); }
      return true;
    } catch (e) { say((e && e.message) || "Refusé", "err"); flashHud((e && e.message) || "Refusé"); return false; }
    finally {
      st.solidBusy = false; renderSolid();
      const queued = st.solidQueue; st.solidQueue = null;
      if (queued) setTimeout(() => applySolidDoc(queued.doc, queued.msg), 0);
    }
  }
  function onSolidChange(e) {
    const t = e.target, d = t.dataset;
    if (d.active) {
      const res = S.updateFeature(st.doc, d.active, { suppressed: !t.checked });
      if (!res.ok) { say(res.error, "err"); renderSolid(); return; }
      applySolidDoc(res.doc, t.checked ? "Fonction réactivée" : "Fonction désactivée");
      return;
    }
    if (d.rollback != null && t.type === "range") {
      const n = Number(t.value), len = (st.doc.features || []).length;
      const res = S.setRollback(st.doc, n >= len ? null : n);
      if (!res.ok) { say(res.error, "err"); renderSolid(); return; }
      applySolidDoc(res.doc, n >= len ? "Toutes les fonctions" : "Pièce construite jusqu'à la fonction " + n);
      return;
    }
    if (d.edit && d.feature) {
      const v = t.type === "checkbox" ? t.checked : t.value;
      if (t.type === "number" && !(t.value !== "" && isFinite(Number(t.value)))) { renderSolid(); return; }
      const res = S.updateFeature(st.doc, d.feature, { [d.edit]: v });
      if (!res.ok) { say(res.error, "err"); renderSolid(); return; }
      if (d.edit === "name") { commit(res.doc); return; } // a name never changes the part: no rebuild
      applySolidDoc(res.doc, "Pièce mise à jour");
      return;
    }
    if (d.dimLine || d.dimCircle) {
      const v = Number(t.value);
      const res = d.dimCircle ? S.setCircleRadius(st.doc, d.dimCircle, v) : (() => { const o = S.getObj(st.doc, d.dimLine); return o ? S.setLineLength(st.doc, d.dimLine, o.p1, v) : { ok: false, error: "Ligne introuvable" }; })();
      if (!res.ok) { say(res.error, "err"); renderSolid(); return; }
      applySolidDoc(res.doc, d.dimCircle ? "Rayon " + S.fmt(v) + " " + st.doc.units : "Côté " + S.fmt(v) + " " + st.doc.units);
      return;
    }
    if (d.solid && t.tagName === "SELECT") renderSolid(); // a different hole extent or pattern layout shows other fields
    if (d.solid) updateGhost(); // the pending operation's dashed outline follows the depth as it is typed
  }
  function createStep(kind) {
    let step;
    if (kind === "revolve") {
      const rv = revolveSelection();
      if (!rv.axis) { say("Sélectionne aussi un trait d'axe (outil « Axe »)", "err"); return; }
      step = { type: "revolve", profile: rv.profile, axis: rv.axis, angle: Number(String(st.revAngle).replace(",", ".")) || 360 };
    } else if (kind === "hole") {
      step = { type: "hole", at: selectedCircles(), standard: st.hole.standard, fit: st.hole.fit, extent: st.hole.extent, depth: Number(String(st.hole.depth).replace(",", ".")) || 0 };
    } else if (kind === "shell") {
      step = { type: "shell", thickness: Number(String(st.shell.t).replace(",", ".")), open: !!st.shell.open };
    } else {
      const c = partCenter(), P = st.pat;
      const n = (v, dflt) => (v === "" || v == null ? dflt : Number(String(v).replace(",", ".")));
      step = { type: "pattern", source: P.source, mode: P.mode, count: n(P.count, 4),
        dx: n(P.dx, st.doc.grid.spacing * 2), dy: n(P.dy, 0), cx: n(P.cx, c.x), cy: n(P.cy, c.y), angle: n(P.angle, 360) };
    }
    const res = S.addSolidStep(st.doc, step);
    if (!res.ok) { say(res.error, "err"); return; }
    const names = { revolve: "Pièce tournée", hole: "Trou percé", shell: "Pièce évidée", pattern: "Répétition ajoutée" };
    applySolidDoc(res.doc, names[kind]).then(ok => { if (ok) setView3d(true); });
  }

  function createV6Step(kind) {
    let step;
    if (kind === "boss") step = { type: "boss", profile: selectedProfile(), depth: Number(String(st.boss.depth).replace(",", ".")), op: st.boss.op };
    else if (kind === "fillet" || kind === "chamfer") {
      const edges = (st.edgePick ? st.edgePick.picks : []).map(i => st.edges[i]).filter(Boolean).map(e => ({ a: e.a, b: e.b, m: e.m || [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2, (e.a[2] + e.b[2]) / 2] }));
      if (!edges.length) { say("Choisis au moins une arête", "err"); return; }
      step = kind === "fillet" ? { type: "fillet", edges: edges, radius: Number(String(st.rf.radius).replace(",", ".")) } : { type: "chamfer", edges: edges, distance: Number(String(st.rf.distance).replace(",", ".")) };
    } else if (kind === "sweep") {
      if (!st.sweepProfile) { say("Retiens d'abord un profil", "err"); return; }
      step = { type: "sweep", profile: st.sweepProfile, path: st.sel.slice(), op: (st.doc.features || []).length ? st.boss.op : "add" };
    } else step = { type: "loft", profiles: st.loftProfiles.map(p => p.slice()), op: (st.doc.features || []).length ? st.boss.op : "add" };
    const res = S.addSolidStep(st.doc, step);
    if (!res.ok) { say(res.error, "err"); return; }
    const names = { boss: step.op === "cut" ? "Matière enlevée" : "Bossage ajouté", fillet: "Congé appliqué", chamfer: "Chanfrein appliqué", sweep: "Balayage créé", loft: "Lissage créé" };
    applySolidDoc(res.doc, names[kind]).then(ok => {
      if (!ok) return;
      if (kind === "fillet" || kind === "chamfer") { st.edgePick = null; if (solidView) { solidView.setEdgeMode(false); solidView.setMarked([], false); } updateFloat(); }
      if (kind === "sweep") st.sweepProfile = null;
      if (kind === "loft") st.loftProfiles = [];
      setView3d(true); renderSolid();
    });
  }
  async function exportStep(btn) {
    btn.disabled = true;
    try {
      const res = await window.api("/api/drawings/step", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: st.doc, name: st.name || "piece" }), timeoutMs: 60000 });
      const blob = res && typeof res.blob === "function" ? await res.blob() : null;
      if (!blob || !blob.size) throw new Error("Export STEP impossible");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = (st.name || "piece") + ".step";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      say("Fichier STEP exporté (millimètres)");
    } catch (e) { say((e && e.message) || "Export STEP impossible", "err"); }
    finally { btn.disabled = false; }
  }

  // ---- 3D history: every past state of the part (from undo history), previewed without changing anything
  function history3d() {
    const key = st.hist.past.length + ":" + st.meshVersion;
    if (st.hist3dKey === key && st.hist3d) return st.hist3d;
    const docs = st.hist.past.map(j => { try { return JSON.parse(j); } catch (_) { return null; } }).filter(Boolean).concat([st.doc]);
    const sig = d => JSON.stringify([d.features || [], d.faceFeatures || [], d.roundFeatures || []]);
    const out = [];
    let last = null;
    for (const d of docs) {
      if (!(d.features || []).length) { last = null; continue; }
      const sg = sig(d);
      if (sg === last) { out[out.length - 1].doc = d; continue; }
      last = sg;
      const fs = d.features, lf = fs[fs.length - 1];
      const extra = (d.faceFeatures || []).length + (d.roundFeatures || []).length;
      out.push({ doc: d, sig: sg, label: fs.length + " fonction(s)" + (extra ? " + " + extra : "") + " · " + (FEATURE_NAMES[lf.type] || lf.type) });
    }
    if (out.length) out[out.length - 1].doc = st.doc;
    st.hist3dKey = key; st.hist3d = out;
    return out;
  }
  async function previewStep(i) {
    const steps = history3d();
    if (!steps[i]) return;
    st.preview3d = i === steps.length - 1 ? null : i;
    const label = $(".sk-hist3d-label", root);
    if (label) label.textContent = "Étape " + (i + 1) + "/" + steps.length + " · " + steps[i].label;
    const go = $('[data-act="hist3dGo"]', root);
    if (go) go.hidden = st.preview3d == null; // the slider itself is never re-rendered while it is being dragged
    const at = st.preview3d == null ? steps.length - 1 : st.preview3d;
    root.querySelectorAll("[data-hist3d-step]").forEach(b => b.classList.toggle("on", Number(b.dataset.hist3dStep) === at));
    if (!st.tab3d) setView3d(true);
    if (st.preview3d == null) {
      if (solidView) { solidView.setTriangles(st.mesh); solidView.setEdges(st.edges); }
      $(".sk-3d-status", root).textContent = st.mesh.length + " triangles" + massNote(st.mass) + " · état actuel";
      return;
    }
    let entry = st.histMesh.get(steps[i].sig);
    if (Array.isArray(entry)) entry = { tris: entry, mass: null, count: entry.length }; // older cache shape
    if (!entry) {
      try {
        const res = await window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: steps[i].doc }), timeoutMs: 45000 });
        const tris = res.triangles || [];
        entry = { tris, mass: res.mass || null, count: res.count || tris.length };
        if (st.histMesh.size > 30) st.histMesh.clear();
        st.histMesh.set(steps[i].sig, entry);
      } catch (e) { say((e && e.message) || "Étape illisible", "err"); return; }
    }
    if (st.preview3d !== i) return; // the slider moved on meanwhile
    if (solidView) { solidView.setTriangles(entry.tris); solidView.setEdges([]); }
    $(".sk-3d-status", root).textContent = "Aperçu de l'étape " + (i + 1) + "/" + steps.length + " · " + entry.count + " triangles" + massNote(entry.mass) + " — rien n'est modifié tant que tu ne reviens pas à cette étape";
  }
  function massNote(m) {
    return m && m.volume > 0 ? " · volume " + S.fmt(m.volume, 2) + " " + st.doc.units + "³" : "";
  }

  // ---- AR Quick Look (iPhone / iPad): the part at real size on the table
  async function arModel() {
    if (!(st.doc.features || []).length) return { ok: false, text: "Crée d'abord une pièce 3D" };
    try {
      const r = await window.api("/api/drawings/usdz", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: st.doc, name: st.name || "Piece" }), timeoutMs: 45000 });
      return r && typeof r.url === "string" && r.url.startsWith("/api/drawings/usdz/") ? { ok: true, url: r.url, text: "Modèle AR prêt" } : { ok: false, text: "Modèle AR indisponible" };
    } catch (e) { return { ok: false, text: (e && e.message) || "Modèle AR indisponible" }; }
  }
  function openAr(url) {
    const a = document.createElement("a");
    a.href = url;
    const quickLook = a.relList && a.relList.supports && a.relList.supports("ar");
    if (quickLook) { a.rel = "ar"; a.appendChild(document.createElement("img")); }
    else a.download = (st.name || "piece") + ".usdz";
    document.body.appendChild(a); a.click(); a.remove();
    if (!quickLook) say("Modèle AR téléchargé (.usdz) : ouvre-le sur un iPhone ou un iPad, ou « Voir en AR » depuis le 2e écran.");
  }

  // The full-screen focus layout pins the page to 100dvh, which clamps the 2D scroll to 0. Remember where the
  // drawing was and put it back once the sheet closes, so the 2D/3D switch keeps the reader's place.
  let phoneFocus = false, phoneReturnScroll = null, phoneSheetEntry = false, phoneSheetPopped = false;
  function syncPhone3d() {
    let on = false;
    try { on = !!(st && st.tab3d && window.matchMedia("(max-width: 899px)").matches); } catch (_) {}
    if (on && !phoneFocus) {
      phoneReturnScroll = Math.max(0, Math.round(window.scrollY || 0));
      document.body.classList.add("sk-3d-focus");
      // One entry per focus episode: Android back or a browser back-gesture closes the sheet, not Dessiner.
      if (history.pushState) {
        try {
          const prev = history.state && typeof history.state === "object" ? history.state : {};
          history.pushState(Object.assign({}, prev, { hqPhoneSheet: 1 }), "");
          phoneSheetEntry = true;
        } catch (_) {}
      }
    } else if (!on) {
      const wasFocused = phoneFocus;
      document.body.classList.remove("sk-3d-focus");
      const top = phoneReturnScroll;
      phoneReturnScroll = null;
      // the 2D document has to grow back to its full height before the browser accepts the scroll again
      if (wasFocused && top) requestAnimationFrame(() => {
        if (!document.body.classList.contains("sk-3d-focus") && (document.body.dataset.view || "") === "dessiner") window.scrollTo(0, top);
      });
      // Closing by button, swipe or Escape: consume the pushed entry so the next back is a normal navigation.
      if (phoneSheetEntry) {
        const consume = !phoneSheetPopped && (document.body.dataset.view || "") === "dessiner";
        phoneSheetEntry = false;
        if (consume) { try { history.back(); } catch (_) {} }
      }
    }
    phoneFocus = on;
    if (!on) { const sh = $(".sk-atelier", root); if (sh) sh.style.transform = ""; }
  }
  // Back (Android gesture or hardware button) and Escape close the full-screen atelier instead of leaving the drawing.
  window.addEventListener("popstate", () => {
    if (!phoneSheetEntry) return;
    phoneSheetEntry = false;
    if (!phoneFocus || (document.body.dataset.view || "") !== "dessiner") return;
    phoneSheetPopped = true;
    try { setView3d(false); } finally { phoneSheetPopped = false; }
  });
  // Capture: the page's own Escape handling runs later and would otherwise swallow the key first.
  window.addEventListener("keydown", e => {
    if (e.key !== "Escape" || e.defaultPrevented || !phoneFocus) return;
    if ((document.body.dataset.view || "") !== "dessiner") return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    // The face editor lives in the DOM even when closed: only a visible one owns Escape.
    const face = document.querySelector(".sk-face-editor");
    if (document.querySelector("dialog[open]") || (face && !face.hidden && face.getClientRects().length)) return;
    e.preventDefault();
    setView3d(false);
  }, true);
  function setSplit(on) {
    st.split = !!on;
    root.querySelector(".sk").classList.toggle("is-split", st.split);
    st.tab3d = st.split || st.tab3d;
    $(".sk-stage", root).hidden = false; $(".sk-3d-stage", root).hidden = !st.tab3d;
    root.querySelector('[data-act="viewSplit"]').setAttribute("aria-selected", String(st.split));
    root.querySelector('[data-act="view2d"]').setAttribute("aria-selected", String(!st.split && !st.tab3d));
    root.querySelector('[data-act="view3d"]').setAttribute("aria-selected", String(!st.split && st.tab3d));
    resize(); if (st.tab3d) scheduleMesh(); if (solidView) solidView.draw();
    updateFloat();
    syncPhone3d();
  }
  function setView3d(on) {
    if (on) motionStop();
    if (st.split) { if (on) { scheduleMesh(); return; } st.split = false; root.querySelector(".sk").classList.remove("is-split"); root.querySelector('[data-act="viewSplit"]').setAttribute("aria-selected", "false"); }
    if (!on) { if (faceSketch) faceSketch.close(); st.pendingOp = ""; if (solidView) solidView.setGhost([]); } // leaving the atelier drops an unapplied operation
    if (bubble2d && on) bubble2d.hide();
    st.tab3d = on;
    $(".sk-stage", root).hidden = on; $(".sk-3d-stage", root).hidden = !on;
    root.querySelector('[data-act="view2d"]').setAttribute("aria-selected", on ? "false" : "true");
    root.querySelector('[data-act="view3d"]').setAttribute("aria-selected", on ? "true" : "false");
    if (on) { renderSolid(); scheduleMesh(); } else resize(); // the atelier re-measures the room it gets
    skMotion("view", { tab3d: on });
    syncPhone3d();
  }

  function scheduleMesh() {
    clearTimeout(st.meshTimer);
    if (!st.tab3d || !st.doc) return;
    if (st.meshLoadedVersion === st.meshVersion) {
      if (solidView) solidView.draw();
      $(".sk-3d-status", root).textContent = st.mesh.length ? `${st.mesh.length} triangles · glisse pour tourner · deux doigts ou clic droit pour déplacer · pince ou molette pour zoomer` : "Crée une extrusion pour voir la pièce.";
      return;
    }
    st.meshTimer = setTimeout(loadMesh, 180);
  }

  async function loadMesh() {
    if (st.lift || st.preview3d != null) return; // a live lift or a history preview owns the 3D view meanwhile
    const version = st.meshVersion, status = $(".sk-3d-status", root);
    if (!(st.doc.features || []).length) { st.mesh = []; st.edges = []; st.meshLoadedVersion = version; if (solidView) { solidView.setTriangles([]); solidView.setEdges([]); } status.textContent = "Crée une extrusion pour voir la pièce."; return; }
    status.textContent = "Calcul du modèle…";
    try {
      const res = await window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: rebuildDoc(st.doc) }), timeoutMs: 45000 });
      if (version !== st.meshVersion) return;
      st.mesh = res.triangles; st.edges = res.edges || []; st.meshLoadedVersion = version; st.mass = res.mass || null;
      st.faceSelection = null; st.edgeSelection = null; $(".sk-face-start", root).hidden = true;
      if (solidView) { solidView.setTriangles(st.mesh); solidView.setEdges(st.edges); }
      renderSolid();
      status.textContent = `${res.count} triangles · glisse pour tourner · deux doigts ou clic droit pour déplacer · pince ou molette pour zoomer`;
    } catch (e) {
      // the last good mesh stays on screen: a refused rebuild must never leave a blank view
      if (version === st.meshVersion) { st.meshLoadedVersion = -1; status.textContent = "Modèle non recalculé : " + e.message; }
    }
  }

  async function createSolid(kind, given) {
    if (st.solidBusy) return;
    const profile = given ? given.profile : selectedProfile();
    const depth = given ? given.depth : Number(String(kind === "extrude" ? st.solidDepth : st.cutDepth).replace(",", "."));
    const result = S.addFeature(st.doc, kind, profile, kind === "cut" && st.cutThrough ? 0 : depth, kind === "cut" && st.cutThrough ? "throughAll" : "blind");
    if (!result.ok) { say(result.error, "err"); return; }
    const version = st.meshVersion;
    st.solidBusy = true; renderSolid();
    try {
      const check = await window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: result.doc }), timeoutMs: 45000 });
      if (version !== st.meshVersion) throw new Error("Le dessin a changé pendant le calcul : réessaie");
      commit(result.doc); st.mesh = check.triangles; st.edges = check.edges || []; st.meshLoadedVersion = st.meshVersion;
      clearTimeout(st.meshTimer);
      if (solidView) { solidView.setTriangles(st.mesh); solidView.setEdges(st.edges); }
      $(".sk-3d-status", root).textContent = `${check.count} triangles · glisse pour tourner · deux doigts ou clic droit pour déplacer · pince ou molette pour zoomer`;
      setView3d(true); say(kind === "extrude" ? "Pièce extrudée" : "Matière enlevée");
    } catch (e) { say("Profil 3D refusé : " + e.message, "err"); flashHud(e.message); }
    finally { st.solidBusy = false; renderSolid(); }
  }

  async function createFaceSolid(kind, plane, profile, depth, extent) {
    if (st.solidBusy) throw new Error("Calcul déjà en cours");
    const result = S.addFaceFeature(st.doc, kind, plane, profile, depth, extent);
    if (!result.ok) throw new Error(result.error);
    const version = st.meshVersion;
    st.solidBusy = true;
    try {
      const check = await window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: result.doc }), timeoutMs: 45000 });
      if (version !== st.meshVersion) throw new Error("Le dessin a changé pendant le calcul : réessaie");
      commit(result.doc); st.mesh = check.triangles; st.edges = check.edges || []; st.meshLoadedVersion = st.meshVersion;
      clearTimeout(st.meshTimer);
      st.faceSelection = null; st.edgeSelection = null; $(".sk-face-start", root).hidden = true;
      if (solidView) { solidView.setTriangles(st.mesh); solidView.setEdges(st.edges); }
      $(".sk-3d-status", root).textContent = `${check.count} triangles · glisse pour tourner · deux doigts ou clic droit pour déplacer · pince ou molette pour zoomer`;
      setView3d(true); say(kind === "extrude" ? "Matière ajoutée sur la face" : "Matière enlevée sur la face");
    } finally { st.solidBusy = false; renderSolid(); }
  }

  async function createRound() {
    if (st.solidBusy || !st.edgeSelection) return;
    const edge = st.edgeSelection;
    const radius = Number(String(st.roundRadius).replace(",", "."));
    const result = S.addRoundFeature(st.doc, edge.a, edge.b, radius);
    if (!result.ok) { say(result.error, "err"); return; }
    const version = st.meshVersion;
    st.solidBusy = true; renderSolid();
    try {
      const check = await window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: result.doc }), timeoutMs: 45000 });
      if (version !== st.meshVersion) throw new Error("Le dessin a changé pendant le calcul : réessaie");
      commit(result.doc); st.mesh = check.triangles; st.edges = check.edges || []; st.meshLoadedVersion = st.meshVersion;
      clearTimeout(st.meshTimer);
      st.edgeSelection = null;
      if (solidView) { solidView.setTriangles(st.mesh); solidView.setEdges(st.edges); }
      $(".sk-3d-status", root).textContent = `${check.count} triangles · touche une autre arête ou termine l'arrondi`;
      say("Arête arrondie");
    } catch (e) { say("Arrondi refusé : " + e.message, "err"); flashHud(e.message); }
    finally { st.solidBusy = false; renderSolid(); }
  }

  async function removeSolidFeature(id, type) {
    if (st.solidBusy) return;
    // the sketches drawn on a face lose their face when the base function goes: say which ones before removing it
    const base = (st.doc.features || [])[0];
    const dependents = (st.doc.sketches || []).filter(s => s.face != null);
    if (type === "legacy" && base && base.id === id && dependents.length &&
        !window.confirm("Cette fonction porte " + dependents.length + " esquisse(s) posée(s) sur une face : " +
          dependents.map(s => s.name || s.id).join(", ") + ". Les retirer les détachera de leur face. Continuer ?")) return;
    const result = type === "face" ? S.removeFaceFeature(st.doc, id) : type === "round" ? S.removeRoundFeature(st.doc, id) : S.removeFeature(st.doc, id);
    if (!result.ok) { say(result.error, "err"); return; }
    const version = st.meshVersion;
    st.solidBusy = true;
    try {
      let triangles = [], edges = [];
      if ((result.doc.features || []).length) {
        const check = await window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: result.doc }), timeoutMs: 45000 });
        triangles = check.triangles; edges = check.edges || [];
      }
      if (version !== st.meshVersion) throw new Error("Le dessin a changé pendant le calcul : réessaie");
      commit(result.doc); st.mesh = triangles; st.edges = edges; st.meshLoadedVersion = st.meshVersion;
      clearTimeout(st.meshTimer);
      st.faceSelection = null; st.edgeSelection = null; $(".sk-face-start", root).hidden = true;
      if (solidView) { solidView.setTriangles(triangles); solidView.setEdges(edges); }
      $(".sk-3d-status", root).textContent = triangles.length ? `${triangles.length} triangles · glisse pour tourner · deux doigts ou clic droit pour déplacer · pince ou molette pour zoomer` : "Crée une extrusion pour voir la pièce.";
      say("Fonction retirée");
    } catch (e) { say("Retrait refusé : " + e.message, "err"); }
    finally { st.solidBusy = false; renderSolid(); }
  }

  // ------------------------------------------------------------ actions
  function cancelFit() { anim.fit = null; }
  /** « Tout afficher » is the one camera move that glides; a touch or wheel cancels it at once. */
  function fitViewAnimated() {
    cancelFit();
    if (!st.doc || !st.W || !st.H) return;
    const target = S.fitView(st.doc, st.W, st.H, 40, underlayRect());
    if (!target) return;
    if (!motionAllowed() || !st.view) { st.view = target; scheduleDraft(); draw(); return; }
    anim.fit = { from: Object.assign({}, st.view), to: target, at: nowMs() };
    motionSchedule();
  }
  function act(name, el) {
    if (name === "return") { if (st.link) st.link.ret(); return; }
    if (name === "view2d" || name === "view3d") { if (st.split) { st.split = false; root.querySelector(".sk").classList.remove("is-split"); root.querySelector('[data-act="viewSplit"]').setAttribute("aria-selected", "false"); } setView3d(name === "view3d"); return; }
    if (name === "viewSplit") { if (st.split) { setSplit(false); setView3d(false); } else setSplit(true); return; }
    if (name === "reset3d") { if (solidView) solidView.reset(); return; }
    if (name === "fit3d") { if (solidView) solidView.fit(); return; }
    if (name === "zoomIn") { if (solidView) solidView.zoomBy(1.2); return; }
    if (name === "zoomOut") { if (solidView) solidView.zoomBy(1 / 1.2); return; }
    if (name === "measure") { toggleMeasure(); return; }
    if (name === "section") { toggleSection(); return; }
    if (name === "clipOff") { toggleSection(false); return; }
    if (name === "paint") {
      if (!window.HqSketchPaint) { say("« Forge peint » n'est pas chargé", "err"); return; }
      if (!st.paint) st.paint = window.HqSketchPaint.mount(window, $(".sk-paint-host", root));
      const on = st.paint.toggle();
      root.querySelector('[data-act="paint"]').setAttribute("aria-expanded", String(on));
      if (on) st.paint.changed();
      return;
    }
    if (name === "roundMode") {
      st.edgeMode = !st.edgeMode; st.edgeSelection = null; st.faceSelection = null;
      $(".sk-face-start", root).hidden = true;
      $(".sk-round-mode", root).setAttribute("aria-pressed", String(st.edgeMode));
      $(".sk-round-mode", root).textContent = st.edgeMode ? "Finir l'arrondi" : "Arrondir une arête";
      if (solidView) solidView.setEdgeMode(st.edgeMode);
      $(".sk-3d-status", root).textContent = st.edgeMode ? "Touche une arête droite convexe de la pièce" : "Touche une face pour y dessiner";
      renderSolid(); return;
    }
    if (name === "roundApply") { createRound(); return; }
    if (name === "faceSketch") { if (faceSketch && st.faceSelection) faceSketch.open(st.faceSelection); return; }
    if (name === "faceAttach") { attachSketchToFace(); return; }
    if (name === "solid-extrude" || name === "solid-cut") { createSolid(name === "solid-extrude" ? "extrude" : "cut"); return; }
    if (name === "solid-revolve" || name === "solid-hole" || name === "solid-shell" || name === "solid-pattern") { createStep(name.slice(6)); return; }
    if (name === "solid-boss" || name === "solid-fillet" || name === "solid-chamfer" || name === "solid-sweep" || name === "solid-loft") { createV6Step(name.slice(6)); return; }
    if (name === "featUp" || name === "featDown") {
      const res = S.moveFeature(st.doc, el.dataset.feature, name === "featUp" ? -1 : 1);
      if (!res.ok) { say(res.error, "err"); return; }
      applySolidDoc(res.doc, "Ordre des fonctions changé");
      return;
    }
    if (name === "edgePick") {
      st.edgePick = st.edgePick ? null : { picks: [] };
      if (st.edgePick && !st.tab3d) setView3d(true);
      if (solidView) { solidView.setEdgeMode(!!st.edgePick); solidView.setMarked([], !!st.edgePick); }
      $(".sk-3d-status", root).textContent = st.edgePick ? "Touche les arêtes à arrondir ou chanfreiner" : "";
      renderSolid(); updateFloat(); return;
    }
    if (name === "sweepProfile") { st.sweepProfile = selectedProfile(); say("Profil retenu : sélectionne le chemin"); renderSolid(); return; }
    if (name === "sweepReset") { st.sweepProfile = null; renderSolid(); return; }
    if (name === "loftAdd") {
      const prof = selectedProfile();
      if (!prof.length) return;
      st.loftProfiles.push(prof); st.sel = []; refreshAll(); say("Profil " + st.loftProfiles.length + " ajouté au lissage"); return;
    }
    if (name === "loftReset") { st.loftProfiles = []; renderSolid(); return; }
    if (name === "step3d") { exportStep(el); return; }
    if (name === "hist3dGo") {
      const steps = history3d(), i = st.preview3d;
      if (i == null || !steps[i]) return;
      const back = S.clone(steps[i].doc);
      applySolidDoc(back, "Dessin remis à l'étape " + (i + 1) + " (Annuler pour revenir)");
      return;
    }
    if (name === "ar3d") {
      el.disabled = true;
      arModel().then(r => { el.disabled = false; if (r.ok) openAr(r.url); else say(r.text, "err"); });
      return;
    }
    if (name === "remove3d") { removeSolidFeature(el.dataset.feature, "legacy"); return; }
    if (name === "removeFace3d") { removeSolidFeature(el.dataset.feature, "face"); return; }
    if (name === "removeRound3d") { removeSolidFeature(el.dataset.feature, "round"); return; }
    if (name === "undo") { const before = st.doc, p = st.hist.undo(st.doc); if (p) { startUndoCue(before, p); st.preview3d = null; setDoc(p); st.meshVersion++; st.dirty = true; scheduleDraft(); refreshAll(); } return; }
    if (name === "redo") { const before = st.doc, p = st.hist.redo(st.doc); if (p) { startUndoCue(before, p); st.preview3d = null; setDoc(p); st.meshVersion++; st.dirty = true; scheduleDraft(); refreshAll(); } return; }
    if (name === "delete") { deleteSel(); return; }
    if (name === "symmetry") { mirrorSelection("h"); return; }
    if (name === "fit") { fitViewAnimated(); return; }
    if (name === "multi") { st.multi = !st.multi; renderToolbar(); updateFloat(); return; }
    if (name === "newSketch") { st.newSketch = !st.newSketch; renderToolbar(); renderProps(); return; }
    if (name === "settings") {
      const s = $(".sk-settings", root); s.hidden = !s.hidden; el.setAttribute("aria-expanded", s.hidden ? "false" : "true"); syncSettings(); return;
    }
    if (name === "save") { openSave(); return; }
    if (name === "validate") { openValidate(); return; }
    if (name === "repair") { repairDoc(); return; }
    if (name === "open") { openList(); return; }
    if (name === "new") {
      if (st.dirty && st.doc.objects.length && !window.confirm("Commencer un nouveau dessin ? Le dessin actuel non enregistré sera remplacé (Annuler reste possible).")) return;
      const fresh = S.createDoc({ units: st.doc.units, spacing: st.doc.grid.spacing, mode: st.doc.mode });
      fresh.grid = Object.assign({}, st.doc.grid); fresh.snap = Object.assign({}, st.doc.snap);
      st.name = ""; st.stem = ""; st.sel = [];
      liveStop();
      commit(fresh);
      st.view = S.fitView(st.doc, st.W, st.H); st.dirty = false; flushDraft(); updateButtons(); draw();
    }
  }
  function mirrorSelection(axis) {
    if (!st.sel.length) { say("Sélectionne une géométrie à mettre en symétrie", "err"); return; }
    const r = S.transformObjects(st.doc, st.sel.slice(), { kind: "mirror", axis: axis || "h" });
    if (!r || !r.ok) { say((r && r.error) || "Symétrie refusée", "err"); return; }
    commit(r.doc);
    refreshAll();
    say("Symétrie appliquée");
  }
  function deleteSel() {
    if (!st.sel.length) return;
    const ids = st.sel.slice();
    st.sel = [];
    commit(S.deleteObjects(st.doc, ids));
  }

  // ------------------------------------------------------------ geometry input helpers
  function tolPx(e) { return e && e.pointerType === "touch" ? 16 : e && e.pointerType === "pen" ? 10 : 7; }
  function modelAt(e) { const r = canvas.getBoundingClientRect(); return S.toModel(st.view, st.H, e.clientX - r.left, e.clientY - r.top); }
  function screenAt(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  // snap: existing point > grid; returns { x, y, id? }
  function snapStart(m, e) {
    const pid = S.findPointNear(vdoc(), m.x, m.y, tolPx(e) / st.view.ppu);
    if (pid) { st.guides = null; const p = S.pointMap(st.doc).get(pid); return noteSnap({ x: p.x, y: p.y, id: pid }, "point"); }
    const grid = !!st.doc.grid.snap;
    const p = aligned(m, e, grid ? S.snapGrid(m, st.doc.grid.spacing) : { x: m.x, y: m.y });
    return noteSnap(p, p.id ? "point" : st.guides ? "align" : grid ? "grid" : "");
  }
  function snapEnd(from, m, e) {
    const pid = S.findPointNear(vdoc(), m.x, m.y, tolPx(e) / st.view.ppu);
    if (pid && pid !== from.id) { st.guides = null; const p = S.pointMap(st.doc).get(pid); return noteSnap({ x: p.x, y: p.y, id: pid }, "point"); }
    const angle = !!st.doc.snap.angle, grid = !!st.doc.grid.snap;
    const p = aligned(m, e, S.snapSegmentEnd(from, m, { angle: angle, angleStep: st.doc.snap.angleStep, grid: grid, spacing: st.doc.grid.spacing }));
    return noteSnap(p, p.id ? "point" : st.guides ? "align" : angle ? "angle" : grid ? "grid" : "");
  }
  function annotSnap(m, e) {
    const pid = S.findPointNear(vdoc(), m.x, m.y, tolPx(e) / st.view.ppu);
    if (pid) { const p = S.pointMap(st.doc).get(pid); return noteSnap({ x: p.x, y: p.y, id: pid }, "point"); }
    const grid = !!st.doc.grid.snap;
    return noteSnap(grid ? S.snapGrid(m, st.doc.grid.spacing / 2) : m, grid ? "grid" : "");
  }
  /** A snap cue fires once per snap target, not once per pointermove. */
  function noteSnap(point, kind) {
    if (!point || !kind || !motionAllowed()) { anim.snap = null; st.snapKey = ""; return point; }
    const key = kind + "|" + (point.id || "") + "|" + S.fmt(point.x, 3) + "|" + S.fmt(point.y, 3);
    if (key === st.snapKey) return point;
    st.snapKey = key;
    anim.snap = { x: point.x, y: point.y, kind: kind, at: nowMs() };
    motionSchedule();
    return point;
  }

  // ------------------------------------------------------------ pointer handling
  function onDown(e) {
    cancelFit(); // direct manipulation always wins over a fit tween
    st.snapKey = "";
    if (!textIn.hidden) finishText(true);
    if (e.pointerType === "pen") st.penSeen = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer, or one the OS already released */ }
    st.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    e.preventDefault();
    const touches = [...st.ptrs.values()].filter(p => p.type === "touch");
    if (touches.length >= 2) { startGesture(); return; }
    if (st.gesture) return;
    // « Stylet seulement »: a palm on the glass pans instead of drawing (the pen keeps drawing)
    if (st.stylusOnly && e.pointerType === "touch" && st.tool !== "select" && st.tool !== "pan") {
      st.action = { kind: "pan", last: screenAt(e), id: e.pointerId, button: 0, start: screenAt(e) };
      return;
    }
    const panOnly = e.button === 1 || e.button === 2 || st.tool === "pan" || (e.pointerType === "touch" && st.penSeen && st.tool !== "select");
    if (panOnly) { st.action = { kind: "pan", last: screenAt(e), id: e.pointerId, button: e.button, start: screenAt(e) }; return; }
    if (e.button && e.button !== 0) return;
    if (st.action && st.action.click) { // second click: the end of a click-click shape
      const a = st.action;
      toolMove(e, [e]);
      st.action = null; st.hudMsg = "";
      createShape(a);
      return;
    }
    toolDown(e);
  }
  function onMove(e) {
    if (!st.ptrs.has(e.pointerId)) { if (e.pointerType === "mouse") hover(e); return; }
    st.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (st.gesture) { moveGesture(); return; }
    if (!st.action || st.action.id !== e.pointerId) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    if (st.pressT && st.pressAt && Math.hypot(e.clientX - st.pressAt.x, e.clientY - st.pressAt.y) > 8) { clearTimeout(st.pressT); st.pressT = 0; }
    if (st.action.kind === "pan") {
      const s = screenAt(e);
      if (st.action.start && Math.hypot(s.x - st.action.start.x, s.y - st.action.start.y) > 4) st.action.moved = true;
      st.view = { x0: st.view.x0 - (s.x - st.action.last.x) / st.view.ppu, y0: st.view.y0 + (s.y - st.action.last.y) / st.view.ppu, ppu: st.view.ppu };
      st.action.last = s; draw(); return;
    }
    toolMove(e, events);
  }
  function onUp(e) {
    const had = st.ptrs.has(e.pointerId);
    st.ptrs.delete(e.pointerId);
    if (st.gesture) {
      if (![...st.ptrs.values()].some(p => p.type === "touch")) { st.gesture = null; scheduleDraft(); }
      else startGesture();
      return;
    }
    if (!had || !st.action || st.action.id !== e.pointerId) return;
    if (st.pressT) { clearTimeout(st.pressT); st.pressT = 0; }
    if (st.action.kind === "pan") {
      const a = st.action; st.action = null; scheduleDraft();
      if (a.button === 2 && !a.moved) openRing(e); // a right click (no drag) opens the action ring
      return;
    }
    toolUp(e);
  }
  function armLongPress(e, hit) {
    clearTimeout(st.pressT);
    st.pressAt = { x: e.clientX, y: e.clientY };
    const ev = { clientX: e.clientX, clientY: e.clientY };
    st.pressT = setTimeout(() => { st.pressT = 0; if (st.action && st.action.kind === "move" && !st.action.moved) { st.action = null; openRing(ev); } }, 550);
  }
  /** The action ring: the bubble's actions around the pointer (right click, long press). */
  function openRing(e) {
    if (!window.HqSketchFloat || !window.HqSketchFloat.ring) return;
    const m = modelAt(e);
          const hit = hitAt(m, tolPx(e));
    if (hit && !st.sel.includes(hit)) { st.sel = [hit]; renderProps(); draw(); updateButtons(); }
    const spec = floatSpec2d();
    const items = (spec ? spec.actions.filter(a => !a.disabled).map(a => ({ key: a.key, label: a.label })) : []);
    if (st.sel.length) items.push({ key: "ring:delete", label: "Supprimer" });
    items.push({ key: "ring:fit", label: "Tout afficher" });
    const values = {};
    (spec ? spec.fields : []).forEach(f => { values[f.key] = f.value; });
    const r = canvas.getBoundingClientRect();
    if (bubble2d) bubble2d.hide(); // the ring carries the same actions; it returns with the next selection change
    st.ringOpen = window.HqSketchFloat.ring(window, $(".sk-stage", root), { x: e.clientX - r.left, y: e.clientY - r.top }, items, key => {
      st.ringOpen = null;
      if (key === "ring:delete") deleteSel();
      else if (key === "ring:fit") act("fit");
      else floatAction(key, values);
    });
  }
  function onCancel(e) {
    st.ptrs.delete(e.pointerId);
    if (st.gesture && ![...st.ptrs.values()].some(p => p.type === "touch")) st.gesture = null;
    if (st.action && st.action.id === e.pointerId) cancelAction();
  }
  function cancelAction() { st.action = null; st.hudMsg = ""; st.slotPending = null; st.splinePts = []; if (canvas) draw(); }

  function startGesture() {
    // a pinch cancels any in-progress single-finger tool action (e.g. a stray stroke)
    st.action = null;
    const pts = [...st.ptrs.values()].filter(p => p.type === "touch").slice(0, 2);
    // one finger left after a pinch: stay in a residual gesture (no drawing) until all fingers lift
    if (pts.length < 2) { st.gesture = { residual: true }; return; }
    const r = canvas.getBoundingClientRect();
    const c = { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top };
    st.gesture = { c: c, d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, view: Object.assign({}, st.view) };
    draw();
  }
  function moveGesture() {
    const pts = [...st.ptrs.values()].filter(p => p.type === "touch").slice(0, 2);
    if (pts.length < 2) return;
    const r = canvas.getBoundingClientRect();
    const c = { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top };
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const g = st.gesture;
    if (!g || g.residual) return startGesture();
    let v = S.zoomAt(g.view, st.H, g.c.x, g.c.y, d / g.d, minPpu(), maxPpu());
    v = { x0: v.x0 - (c.x - g.c.x) / v.ppu, y0: v.y0 + (c.y - g.c.y) / v.ppu, ppu: v.ppu };
    st.view = v; draw();
  }
  function minPpu() { return 2 / (st.doc.grid.spacing * 50); }
  function maxPpu() { return 400 / st.doc.grid.spacing; }
  function onWheel(e) {
    e.preventDefault();
    cancelFit();
    const s = screenAt(e);
    if (e.ctrlKey || !e.shiftKey) {
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
      st.view = S.zoomAt(st.view, st.H, s.x, s.y, f, minPpu(), maxPpu());
    } else {
      st.view = { x0: st.view.x0 + e.deltaY / st.view.ppu, y0: st.view.y0, ppu: st.view.ppu };
    }
    scheduleDraft(); draw();
  }
  /** The hit-test grid of the document on screen, rebuilt only when the document or the zoom decade changes. */
  function hitIndexFor(doc) {
    const key = st.docRev + "|" + Math.round(Math.log10(Math.max(1e-6, st.view.ppu)));
    if (!st.hit || st.hit.key !== key || st.hit.doc !== doc) {
      st.hit = { key: key, doc: doc, index: S.buildHitIndex(doc, Math.max(1e-3, 40 / st.view.ppu)) }; // ~40 screen px cells
    }
    return st.hit.index;
  }
  function hitAt(m, tol) {
    const doc = vdoc();
    return S.hitTestIndexed(doc, hitIndexFor(doc), m.x, m.y, tol / st.view.ppu);
  }
  function hitAllAt(m, tol) {
    const doc = vdoc();
    return S.hitAllIndexed(doc, hitIndexFor(doc), m.x, m.y, tol / st.view.ppu);
  }
  function hover(e) {
    if (st.action) { if (st.action.click) toolMove(e, [e]); return; } // click-click shapes follow the pointer
    const m = modelAt(e);
    st.lastPointer = m; // the pending slot / spline preview follows the finger
    if (st.arcPending || st.slotPending || st.tool === "spline") { st.arcHover = m; draw(); }
    setHud(m);
  }

  // ------------------------------------------------------------ tools
  function toolDown(e) {
    const m = modelAt(e), id = e.pointerId, tool = st.tool;
    if (st.doc && st.doc.mode === "construction") { // a locked sketch keeps its geometry
      const lock = (st.doc.sketches || []).find(x => x.id === st.sketch);
      if (lock && lock.locked && !["select", "pan", "text", "dimlin", "dimang"].includes(tool)) {
        say("Esquisse verrouillée : déverrouille-la pour la modifier", "err");
        return;
      }
    }
    if (tool === "select") {
      const tol = tolPx(e) / st.view.ppu;
      // endpoint handle of a single selected line/centerline?
      if (st.sel.length === 1) {
        const o = S.getObj(st.doc, st.sel[0]);
        if (S.isLine(o)) {
          const pm = S.pointMap(st.doc);
          for (const k of ["p1", "p2"]) { const p = pm.get(o[k]); if (Math.hypot(p.x - m.x, p.y - m.y) <= tol) { st.action = { kind: "point", id: id, pid: o[k], base: st.doc, res: null }; return; } }
        }
      }
      const hit = S.hitTest(vdoc(), m.x, m.y, tol);
      if (!hit) {
        if (!st.multi && !e.shiftKey) st.sel = [];
        // a mouse or pen drag on empty space selects a box of objects; a finger still pans
        st.action = e.pointerType === "touch" ? { kind: "pan", last: screenAt(e), id: id } : { kind: "box", id: id, a: m, b: m, add: st.multi || e.shiftKey };
        renderProps(); draw(); updateButtons(); return;
      }
      if (e.pointerType === "touch") armLongPress(e, hit);
      if (st.multi || e.shiftKey) {
        st.sel = st.sel.includes(hit) ? st.sel.filter(x => x !== hit) : st.sel.concat(hit);
      } else if (!st.sel.includes(hit)) st.sel = [hit];
      st.action = { kind: "move", id: id, start: m, base: st.doc, res: null, moved: false };
      renderProps(); draw(); updateButtons();
      return;
    }
    if (tool === "pen") { st.action = { kind: "pen", id: id, pts: [[m.x, m.y]] }; draw(); return; }
    if (tool === "eraser") { st.action = { kind: "erase", id: id, pushed: false }; eraseAt(m, e); return; }
    if (tool === "text") { st.action = { kind: "text", id: id, at: st.doc.grid.snap ? S.snapGrid(m, st.doc.grid.spacing / 2) : m }; return; }
    if (tool === "dimang") { st.action = { kind: "tap", id: id }; return; }
    if (tool === "dimlin") { const a = annotSnap(m, e); st.action = { kind: "dimlin", id: id, a: a, b: a }; draw(); return; }
    if (tool === "dimdia" || tool === "dimrad") {
      // Ø / R: touch the circle or arc; the leader points the way the pointer came from (the 3D/Marker pick order)
      const hit = hitAt(m, tolPx(e));
      const target = hit && S.getObj(st.doc, hit);
      if (!target || (target.type !== "circle" && target.type !== "arc")) { say("Touche un cercle ou un arc pour le coter", "err"); return; }
      const pm = S.pointMap(st.doc);
      const c = target.type === "circle" ? pm.get(target.center) : S.arcGeom(target, pm).c;
      const ang = Math.atan2(m.y - c.y, m.x - c.x);
      const idDim = mutate(d => S.withSketch(d, st.sketch, x => (tool === "dimdia" ? S.addDimDiameter(x, target.id, ang) : S.addDimRadius(x, target.id, ang))));
      if (idDim) { st.sel = [idDim]; refreshAll(); }
      return;
    }
    if (tool === "line" || tool === "centerline" || tool === "rect" || tool === "circle") {
      const a = snapStart(m, e);
      st.action = { kind: tool, id: id, a: a, b: a }; draw(); return;
    }
    if (tool === "arc") {
      if (st.arcPending) { st.action = { kind: "arcEnd", id: id }; st.arcHover = m; draw(); return; }
      const a = snapStart(m, e);
      st.action = { kind: "arc", id: id, a: a, b: null }; draw(); return;
    }
    if (tool === "slot") {
      if (st.slotPending) {
        const P = st.slotPending; st.slotPending = null;
        const L = Math.hypot(P.b.x - P.a.x, P.b.y - P.a.y);
        const r = L > 1e-9 ? Math.abs((m.x - P.a.x) * (P.b.y - P.a.y) - (m.y - P.a.y) * (P.b.x - P.a.x)) / L : 0;
        if (!(r * st.view.ppu > 3)) { say("Rainure trop étroite", "err"); draw(); return; }
        const slot = mutate(d => S.withSketch(d, st.sketch, x => S.addSlot(x, P.a, P.b, r)));
        if (slot) { st.sel = slot.ids.slice(); refreshAll(); say("Rainure créée · largeur " + S.fmt(2 * r)); } else { say("Rainure invalide", "err"); draw(); }
        return;
      }
      const a = snapStart(m, e);
      st.action = { kind: "slot", id: id, a: a, b: null }; draw(); return;
    }
    if (tool === "ellipse" || tool === "polygon") {
      const a = snapStart(m, e);
      st.action = { kind: tool, id: id, a: a, b: a }; draw(); return;
    }
    if (tool === "spline") {
      const pts = st.splinePts;
      const last = pts[pts.length - 1];
      if (pts.length >= 3 && Math.hypot(m.x - pts[0].x, m.y - pts[0].y) * st.view.ppu < 10) { finishSpline(true); return; }
      if (pts.length >= 2 && last && Math.hypot(m.x - last.x, m.y - last.y) * st.view.ppu < 6) { finishSpline(false); return; }
      if (pts.length >= 200) { say("Spline : 200 points au maximum", "err"); return; }
      pts.push({ x: m.x, y: m.y }); draw(); return;
    }
    if (tool === "trim" || tool === "extend") {
      const hit = S.hitTest(vdoc(), m.x, m.y, tolPx(e) / st.view.ppu);
      if (!hit) { say(tool === "trim" ? "Touche l'objet à rogner" : "Touche l'extrémité à prolonger", "err"); return; }
      const r = tool === "trim" ? S.trimObject(st.doc, hit, m) : S.extendObject(st.doc, hit, m);
      if (!r.ok) { say(r.error, "err"); draw(); return; }
      const ids = r.ids || [];
      commit(r.doc); st.sel = ids.slice(); refreshAll();
      say(tool === "trim" ? "Objet rogné" : "Objet prolongé");
      return;
    }
  }
  /** Spline: taps add control points; tapping the first point closes the curve, twice on the last one leaves it open. */
  function finishSpline(closed) {
    const pts = st.splinePts.slice(); st.splinePts = [];
    if (pts.length < 2 || (closed && pts.length < 3)) { draw(); return null; }
    const id = mutate(d => S.withSketch(d, st.sketch, x => S.addSpline(x, pts, !!closed)) || false);
    if (id) { st.sel = [id]; refreshAll(); say((closed ? "Spline fermée" : "Spline ouverte") + " · " + pts.length + " points"); } else { say("Spline invalide", "err"); draw(); }
    return id;
  }

  function toolMove(e, events) {
    const a = st.action, m = modelAt(e);
    st.lastPointer = m; // what the other device draws as the peer cursor
    if (a.kind === "pen") {
      const minD = 1.5 / st.view.ppu;
      for (const ev of events) {
        const p = modelAt(ev), last = a.pts[a.pts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) >= minD && a.pts.length < S.LIMITS.strokePts * 4) {
          const raw = ev.pointerType === "pen" && ev.pressure > 0 ? ev.pressure : 0;
          const pressure = raw > 0 ? Math.pow(Math.min(1, raw), Number(st.pressure) || 1) : 0; // the device's pressure curve
          if (pressure) a.pressure = true;
          a.pts.push(pressure ? [p.x, p.y, Math.round((0.35 + 0.65 * Math.min(1, pressure)) * 100) / 100] : [p.x, p.y]);
        }
      }
      drawSoon(); return;
    }
    if (a.kind === "erase") { eraseAt(m, e); return; }
    if (a.kind === "move") {
      let dx = m.x - a.start.x, dy = m.y - a.start.y;
      if (st.doc.grid.snap) { const g = st.doc.grid.spacing; dx = Math.round(dx / g) * g; dy = Math.round(dy / g) * g; }
      if (Math.hypot(m.x - a.start.x, m.y - a.start.y) * st.view.ppu > 3) a.moved = true;
      if (!a.moved) return;
      a.res = S.moveObjects(a.base, st.sel, dx, dy);
      st.hudMsg = a.res.ok ? "Δ " + S.fmt(dx) + ", " + S.fmt(dy) + " " + st.doc.units : a.res.error; st.hudErr = !a.res.ok;
      drawSoon(a.res.ok ? a.res.doc : null); setHud(m); return;
    }
    if (a.kind === "point") {
      const o = S.getObj(a.base, st.sel[0]);
      const other = S.pointMap(a.base).get(S.otherEnd(o, a.pid));
      const p = snapEnd({ x: other.x, y: other.y, id: other.id }, m, e);
      a.res = S.movePoint(a.base, a.pid, p.x, p.y);
      st.hudMsg = a.res.ok ? "L " + S.fmt(Math.hypot(p.x - other.x, p.y - other.y)) + " " + st.doc.units : a.res.error; st.hudErr = !a.res.ok;
      drawSoon(a.res.ok ? a.res.doc : null); setHud(m); return;
    }
    if (a.kind === "dimlin") { a.b = annotSnap(m, e); drawSoon(); setHud(m, a.a, a.b); return; }
    if (a.kind === "box") { a.b = m; drawSoon(); return; }
    if (a.kind === "line" || a.kind === "centerline") { a.b = a.pointer = snapEnd(a.a, m, e); applyTyped(a); drawSoon(); if (st.typed) setHud(); else setHud(m, a.a, a.b); return; }
    if (a.kind === "rect") { a.b = a.pointer = snapStart(m, e); applyTyped(a); drawSoon(); if (st.typed) setHud(); else setHud(m, a.a, a.b, true); return; }
    if (a.kind === "arc") { a.b = snapStart(m, e); st.hudMsg = "R " + S.fmt(Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y)) + " " + st.doc.units; drawSoon(); setHud(m); return; }
    if (a.kind === "slot") { a.b = m; st.hudMsg = "L " + S.fmt(Math.hypot(m.x - a.a.x, m.y - a.a.y)) + " " + st.doc.units; drawSoon(); setHud(m); return; }
    if (a.kind === "ellipse") { a.b = m; st.hudMsg = "L " + S.fmt(2 * Math.abs(m.x - a.a.x)) + " × " + S.fmt(2 * Math.abs(m.y - a.a.y)); drawSoon(); setHud(m); return; }
    if (a.kind === "polygon") { a.b = m; st.hudMsg = "R " + S.fmt(Math.hypot(m.x - a.a.x, m.y - a.a.y)) + " · " + (Math.round(Number(st.polySides) || 6)) + " côtés"; drawSoon(); setHud(m); return; }
    if (a.kind === "arcEnd") { st.arcHover = m; drawSoon(); return; }
    if (a.kind === "circle") {
      let r = Math.hypot(m.x - a.a.x, m.y - a.a.y);
      if (st.doc.grid.snap) r = Math.max(st.doc.grid.spacing / 2, Math.round(r / (st.doc.grid.spacing / 2)) * (st.doc.grid.spacing / 2));
      a.r = r; a.b = a.pointer = m; applyTyped(a); drawSoon(); if (!st.typed) st.hudMsg = "R " + S.fmt(a.r) + " " + st.doc.units + " · Ø " + S.fmt(2 * a.r); setHud(m); return;
    }
  }

  function toolUp(e) {
    const a = st.action; st.action = null; st.hudMsg = ""; st.hudErr = false;
    const m = modelAt(e);
    if (a.kind === "pen") {
      const base = (Number(st.inkWidth) || 2) / st.view.ppu;
      const ink = st.inkColor || "";
      // Construction: a freehand stroke is a proposal. When it obviously is a line, a circle or an arc, the clean shape
      // replaces it — with its implicit horizontal/vertical constraint and its end snapped to an existing point.
      const prop = st.recognize ? S.recognizeStroke(a.pts, { tol: 3 / st.view.ppu }) : { ok: false };
      if (prop.ok && prop.kind !== "polyline" && prop.confidence >= 0.55) {
        const shaped = S.applyStrokeShape(st.doc, prop, { snapTol: 12 / st.view.ppu, sketch: st.sketch });
        if (shaped.ok) {
          const what = prop.kind === "line" ? (prop.horizontal ? "ligne horizontale" : prop.vertical ? "ligne verticale" : "ligne")
            : prop.kind === "circle" ? "cercle" : "arc";
          commit(shaped.doc);
          st.sel = shaped.ids.slice();
          refreshAll();
          say("Tracé reconnu : " + what);
          flashHud("Tracé reconnu : " + what);
          return;
        }
      }
      if (a.pressure) {
        const ks = a.pts.map(p => p.length > 2 ? p[2] : 1);
        mutate(d => { S.withSketch(d, st.sketch, x => S.addStroke(x, a.pts, 0.6 / st.view.ppu, { w: Math.max(base, 1.6 / st.view.ppu), k: ks, color: ink })); });
      } else mutate(d => { S.withSketch(d, st.sketch, x => S.addStroke(x, a.pts, 0.6 / st.view.ppu, { w: base, color: ink })); });
      return;
    }
    if (a.kind === "erase") { draw(); return; }
    if (a.kind === "move") {
      if (!a.moved || !a.res) { draw(); return; }
      if (a.res.ok) { st.hist.push(a.base); setDoc(a.res.doc); st.doc.view = st.view; st.dirty = true; scheduleDraft(); refreshAll(); }
      else { say(a.res.error, "err"); draw(); }
      return;
    }
    if (a.kind === "point") {
      if (a.res && a.res.ok) { st.hist.push(a.base); setDoc(a.res.doc); st.dirty = true; scheduleDraft(); refreshAll(); }
      else { if (a.res) say(a.res.error, "err"); draw(); }
      return;
    }
    if (a.kind === "text") { openTextInput(a.at, null); return; }
    if (a.kind === "tap" && st.tool === "dimang") {
      st.angleTaps.push(annotSnap(m, e));
      if (st.angleTaps.length === 3) {
        const [c, p1, p2] = st.angleTaps.map(p => [p.x, p.y]);
        st.angleTaps = [];
        const r = Math.min(S.measureLinear(c, p1), S.measureLinear(c, p2)) * 0.6 || st.doc.grid.spacing * 2;
        const id = mutate(d => S.withSketch(d, st.sketch, x => S.addDimAngle(x, c, p1, p2, r, st.autoDims ? "" : S.fmt(S.measureAngle(c, p1, p2), 2) + "°")));
        if (id) { st.sel = [id]; refreshAll(); }
      } else draw();
      return;
    }
    if (a.kind === "dimlin") {
      if (S.measureLinear([a.a.x, a.a.y], [a.b.x, a.b.y]) * st.view.ppu < 6) { draw(); return; }
      const id = mutate(d => S.withSketch(d, st.sketch, x => S.addDimLinear(x, [a.a.x, a.a.y], [a.b.x, a.b.y], st.doc.grid.spacing,
        st.autoDims ? "" : S.fmt(S.measureLinear([a.a.x, a.a.y], [a.b.x, a.b.y])) + " " + st.doc.units)));
      if (id) { st.sel = [id]; refreshAll(); }
      return;
    }
    if (a.kind === "line" || a.kind === "centerline" || a.kind === "rect" || a.kind === "circle") {
      st.guides = null;
      if (st.typed) { finishTyped(a); return; } // values typed while dragging win over the pointer
      if (tinyShape(a)) { // a click, not a drag: the shape waits for a second click or typed dimensions
        st.action = Object.assign(a, { id: null, click: true });
        st.hudMsg = "Clique la fin, ou tape la dimension (Tab passe au champ suivant, Entrée valide)"; setHud(m); draw();
        return;
      }
      createShape(a);
      return;
    }
    if (a.kind === "box") { boxSelect(a); return; }
    if (a.kind === "slot") {
      if (!a.b || Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) * st.view.ppu < 4) { draw(); return; }
      st.slotPending = { a: a.a, b: a.b }; st.hudMsg = "Touche pour régler la largeur de la rainure"; setHud(m); draw();
      return;
    }
    if (a.kind === "ellipse") {
      if (!a.b || Math.abs(a.b.x - a.a.x) * st.view.ppu < 3 || Math.abs(a.b.y - a.a.y) * st.view.ppu < 3) { draw(); return; }
      const id = mutate(d => S.withSketch(d, st.sketch, x => S.addEllipse(x, a.a, Math.abs(a.b.x - a.a.x), Math.abs(a.b.y - a.a.y))) || false);
      if (id) { st.sel = [id]; refreshAll(); say("Ellipse créée"); } else { say("Ellipse invalide", "err"); draw(); }
      return;
    }
    if (a.kind === "polygon") {
      const sides = Math.max(3, Math.min(12, Math.round(Number(st.polySides) || 6)));
      if (!a.b || Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) * st.view.ppu < 4) { draw(); return; }
      const poly = mutate(d => S.withSketch(d, st.sketch, x => S.addPolygon(x, a.a, a.b, sides)));
      if (poly) { st.sel = poly.lines.slice(); refreshAll(); say("Polygone créé · " + sides + " côtés"); } else { say("Polygone invalide", "err"); draw(); }
      return;
    }
    if (a.kind === "arc") {
      if (!a.b || Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) * st.view.ppu < 4) { draw(); return; }
      st.arcPending = { c: a.a, s: a.b };
      st.hudMsg = "Touche la fin de l'arc"; setHud(m); draw();
      return;
    }
    if (a.kind === "arcEnd") {
      const P = st.arcPending; st.arcPending = null; st.arcHover = null;
      const end = snapStart(m, e);
      const id = mutate(d => S.withSketch(d, st.sketch, x => S.addArc(x, P.c, P.s, end)) || false);
      if (id) { st.sel = [id]; refreshAll(); } else { say("Arc trop petit", "err"); draw(); }
    }
  }

  function tinyShape(a) {
    if (a.kind === "circle") return !(a.r > 0) || a.r * st.view.ppu < 3;
    return !a.b || Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) * st.view.ppu < 4;
  }
  /** Lines, rectangles and circles are made here, whatever the input (drag, two clicks, typed sizes). With the
   * exact engine, what is exactly horizontal or vertical also gets its constraint (« Contraintes automatiques »). */
  function createShape(a) {
    st.typed = null; st.guides = null;
    if (tinyShape(a)) { draw(); return null; }
    const auto = inV6() && st.autoRules && st.doc.mode === "construction";
    if (a.kind === "line" || a.kind === "centerline") {
      const id = mutate(d => { const r = S.withSketch(d, st.sketch, x => S.addLine(x, a.a, a.b, a.kind)); if (r && auto && a.kind === "line") autoConstrain(d, [r]); return r || false; });
      if (id) { st.sel = [id]; st.fixedEnd = "p1"; refreshAll(); }
      return id;
    }
    if (a.kind === "rect") {
      const r = mutate(d => { const res = S.withSketch(d, st.sketch, x => S.addRect(x, a.a, { x: a.b.x, y: a.b.y, id: a.b.id })); if (res && auto) autoConstrain(d, res.lines); return res || false; });
      if (!r) draw();
      return r;
    }
    const id = mutate(d => S.withSketch(d, st.sketch, x => S.addCircle(x, a.a, a.r)) || false);
    if (id) { st.sel = [id]; refreshAll(); }
    return id;
  }
  function autoConstrain(d, lineIds) {
    if (!I) return;
    const pm = S.pointMap(d);
    const lines = lineIds.map(id => S.getObj(d, id)).filter(Boolean).map(o => ({ id: o.id, a: pm.get(o.p1), b: pm.get(o.p2) }));
    let cur = d;
    for (const k of I.autoRules(lines)) { const r = S.addConstraint(cur, k); if (r.ok) cur = r.doc; }
    if (cur !== d) for (const key of ["constraints", "points", "objects", "version", "sketches", "nextId"]) if (cur[key] !== undefined) d[key] = cur[key];
  }
  // ---- typed dimensions: digits while drawing fill L / ∠, l / h or R; Tab moves on, Enter places the shape
  function applyTyped(a) {
    if (!st.typed || !I) return;
    const sh = I.typedShape(a.kind, a.a, a.pointer || a.b || a.a, st.typed.fields);
    if (sh.b) a.b = sh.b;
    if (sh.r != null) a.r = sh.r;
  }
  function typedHud() {
    const T = st.typed;
    return T.fields.map((f, i) => f.label + " " + (f.text || "…") + (i === T.idx ? "▌" : "")).join("   ·   ") + "   (Tab · Entrée)";
  }
  function finishTyped(a) {
    applyTyped(a);
    st.action = null; st.hudMsg = "";
    const id = createShape(a);
    if (!id) say("Dimension trop petite", "err");
  }
  function typedKey(e) {
    const a = st.action;
    const k = e.key;
    if (!(/^[0-9.,+\-*/()]$/.test(k) || k === "Backspace" || k === "Tab" || k === "Enter" || k === "Escape")) return false;
    e.preventDefault();
    if (k === "Escape") { if (st.typed) { st.typed = null; st.hudMsg = ""; if (a.pointer) a.b = a.pointer; draw(); setHud(); } else { st.guides = null; cancelAction(); } return true; }
    if (!st.typed) { if (k === "Tab" || k === "Enter" || k === "Backspace") { if (k === "Enter" && a.click) { st.action = null; createShape(a); } return true; } st.typed = { fields: I.fieldsFor(a.kind), idx: 0 }; if (!a.pointer) a.pointer = a.b; }
    const T = st.typed, f = T.fields[T.idx];
    if (k === "Tab") T.idx = (T.idx + (e.shiftKey ? T.fields.length - 1 : 1)) % T.fields.length;
    else if (k === "Backspace") f.text = f.text.slice(0, -1);
    else if (k === "Enter") { st.action = null; finishTyped(a); return true; }
    else f.text += k;
    applyTyped(a);
    st.hudMsg = typedHud(); setHud(); draw();
    return true;
  }
  // ---- box selection (mouse or pen dragged on empty space)
  function objectBox(o, pm) {
    const pts = [];
    if (S.isLine(o)) pts.push(pm.get(o.p1), pm.get(o.p2));
    else if (o.type === "circle") { const c = pm.get(o.center); pts.push({ x: c.x - o.r, y: c.y - o.r }, { x: c.x + o.r, y: c.y + o.r }); }
    else if (o.type === "arc") { const g = S.arcGeom(o, pm); pts.push({ x: g.c.x - g.r, y: g.c.y - g.r }, { x: g.c.x + g.r, y: g.c.y + g.r }); }
    else if (o.type === "stroke") o.pts.forEach(p => pts.push({ x: p[0], y: p[1] }));
    else if (o.type === "text") pts.push({ x: o.x, y: o.y });
    const ok = pts.filter(Boolean);
    if (!ok.length) return null;
    return { x0: Math.min(...ok.map(p => p.x)), y0: Math.min(...ok.map(p => p.y)), x1: Math.max(...ok.map(p => p.x)), y1: Math.max(...ok.map(p => p.y)) };
  }
  function boxSelect(a) {
    if (!a.b || Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) * st.view.ppu < 4) { renderProps(); draw(); updateButtons(); return; }
    const x0 = Math.min(a.a.x, a.b.x), x1 = Math.max(a.a.x, a.b.x), y0 = Math.min(a.a.y, a.b.y), y1 = Math.max(a.a.y, a.b.y);
    const v = vdoc(), pm = S.pointMap(v);
    const inside = v.objects.filter(o => { const b = objectBox(o, pm); return b && b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1; }).map(o => o.id);
    st.sel = a.add ? [...new Set(st.sel.concat(inside))] : inside;
    renderProps(); draw(); updateButtons();
  }
  // ---- alignment guides: the pointer lines up with another point's X or Y
  function aligned(m, e, base) {
    if (!I) return base;
    const ali = I.alignSnap(vdoc().points, m, tolPx(e) / st.view.ppu);
    st.guides = ali.gx != null || ali.gy != null ? { x: ali.gx, y: ali.gy } : null;
    if (!st.guides) return base;
    return Object.assign({}, base, { x: ali.gx != null ? ali.gx : base.x, y: ali.gy != null ? ali.gy : base.y, id: undefined });
  }

  function eraseModel(m, tol) {
    const hits = hitAllAt(m, tol * st.view.ppu);
    if (!hits.length) return false;
    const a = st.action;
    const next = S.deleteObjects(st.doc, hits);
    if (a && a.kind === "erase" && !a.pushed) { st.hist.push(st.doc); a.pushed = true; }
    else if (st.remote && st.remote.erase && !st.remote.pushed) { st.hist.push(st.doc); st.remote.pushed = true; }
    setDoc(next); st.dirty = true; st.sel = st.sel.filter(id => !hits.includes(id));
    scheduleDraft(); updateButtons(); drawSoon();
    return true;
  }
  function eraseAt(m, e) { eraseModel(m, tolPx(e) / st.view.ppu); }

  function onDouble(e) {
    const m = modelAt(e);
          const hit = hitAt(m, tolPx(e));
    const o = hit && S.getObj(st.doc, hit);
    if (o && o.type === "text") { openTextInput({ x: o.x, y: o.y }, o.id); return; }
    if (o && (o.type === "line" || o.type === "arc")) { st.sel = profileFrom([o.id]); renderProps(); draw(); updateButtons(); } // the whole outline
  }

  // ------------------------------------------------------------ text notes
  function openTextInput(at, editId) {
    const s = S.toScreen(st.view, st.H, at.x, at.y);
    textIn.hidden = false;
    textIn.dataset.x = at.x; textIn.dataset.y = at.y; textIn.dataset.edit = editId || "";
    textIn.value = editId ? S.getObj(st.doc, editId).text : "";
    textIn.style.left = Math.max(4, Math.min(st.W - 180, s.x)) + "px";
    textIn.style.top = Math.max(4, Math.min(st.H - 44, s.y - 36)) + "px";
    textIn.focus();
    st.hudMsg = "Tape la note puis Entrée";
    setHud();
  }
  function finishText(keep) {
    if (textIn.hidden) return;
    const v = textIn.value.trim(), editId = textIn.dataset.edit, x = Number(textIn.dataset.x), y = Number(textIn.dataset.y);
    textIn.hidden = true; textIn.value = ""; st.hudMsg = "";
    if (!keep || !v) { draw(); return; }
    if (editId) { tryCommit(S.updateObject(st.doc, editId, { text: v })); return; }
    const id = mutate(d => S.withSketch(d, st.sketch, z => S.addText(z, x, y, v, niceHeight(16 / st.view.ppu))) || false);
    if (id) { st.sel = [id]; refreshAll(); }
  }

  function niceHeight(h) {
    const p = Math.pow(10, Math.floor(Math.log10(h)));
    const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 7, 10];
    let best = steps[0] * p;
    for (const k of steps) if (Math.abs(k * p - h) < Math.abs(best - h)) best = k * p;
    return Math.round(best * 1e6) / 1e6;
  }

  // ------------------------------------------------------------ properties panel
  function lineInfo(id) {
    const o = S.getObj(st.doc, id), pm = S.pointMap(st.doc), a = pm.get(o.p1), b = pm.get(o.p2);
    return { o: o, L: S.lineLength(st.doc, id), ang: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI };
  }
  // ------------------------------------------------------------ parameters: named values that drive the drawing
  /** One row per parameter: name, expression, the number it resolves to. Editing a row rebuilds in one step. */
  function paramsPanel() {
    const list = S.paramList(st.doc);
    // parameters drive 2D geometry: they do not need the exact-solid engine, only a version-6 document
    if (!list.length && !inV6() && (Number(st.doc.version) || 1) < 6) return "";
    const ev = S.evalParams(st.doc);
    const rows = list.map(p => {
      const bad = ev.errors.find(x => x.id === p.id);
      return `<div class="sk-param${bad ? " is-bad" : ""}">
        <input class="sk-param-name" data-param="name" data-pid="${esc(p.id)}" type="text" maxlength="31" value="${esc(p.name)}" aria-label="Nom du paramètre ${esc(p.name)}"/>
        <span class="sk-param-eq" aria-hidden="true">=</span>
        <input class="sk-param-expr" data-param="expr" data-pid="${esc(p.id)}" type="text" maxlength="120" value="${esc(p.expr)}" aria-label="Expression de ${esc(p.name)}"/>
        <span class="sk-param-val" title="${bad ? esc(bad.message) : "valeur calculée"}">${bad ? esc(bad.message) : S.fmt(ev.values[p.name]) + " " + esc(st.doc.units)}</span>
        <button type="button" class="sk-mini sk-param-del" data-param-act="del" data-pid="${esc(p.id)}" aria-label="Supprimer le paramètre ${esc(p.name)}">${ICON.trash}</button></div>`;
    }).join("");
    const driven = (st.doc.objects || []).filter(S.dimDrive).length;
    return `<div class="sk-params"><div class="sk-prop-head"><strong>Paramètres</strong> · ${list.length}${driven ? " · " + driven + " cote(s) pilotée(s)" : ""}</div>
      ${rows || `<p class="sk-hint">Aucun paramètre. Ajoute « largeur = 120 », puis pilote une cote avec « largeur ».</p>`}
      <div class="sk-row"><input class="sk-param-name" data-param="new-name" type="text" maxlength="31" placeholder="largeur" aria-label="Nouveau paramètre"/>
      <span class="sk-param-eq" aria-hidden="true">=</span>
      <input class="sk-grow" data-param="new-expr" type="text" maxlength="120" placeholder="120 ou 2*marge" aria-label="Expression du nouveau paramètre"/>
      <button type="button" data-param-act="add">Ajouter</button>${list.length ? `<button type="button" class="secondary" data-param-act="rebuild">Reconstruire</button>` : ""}</div>
      <p class="sk-hint">Un nom, une expression, et la géométrie suit : 12,5 et les fonctions abs, round, sqrt, min, max, sin… sont acceptées.</p></div>`;
  }
  /** The shared-drawing strip: who else is here, and the way out when two devices saved at once. */
  function livePanel() {
    const L = st.live;
    if (!L) return "";
    const peers = st.livePeers || [], c = st.liveConflict;
    return `<div class="sk-live"><div class="sk-prop-head"><strong>Partagé</strong> · ${L.rev ? "rév. " + L.rev : "en attente"}</div>
      <div class="sk-row sk-live-row"><span class="sk-live-peers">${peers.length ? "Aussi : " + peers.map(p => esc(p.name || p.client)).join(", ") : "Aucun autre appareil"}</span>
      ${c ? `<button type="button" data-do="liveTake">Reprendre la version de ${esc(c.by || "l'autre appareil")}</button>` : ""}</div></div>`;
  }
  /** A parameter changed: store it, then solve the driven cotes once so the drawing follows the number. */
  function rebuildParams(doc, msg) {
    const res = S.applyParameters(doc);
    if (!res.ok) { commit(doc); say("Paramètre enregistré, géométrie non reconstruite : " + res.error, "err"); return; }
    commit(res.doc);
    if (msg) say(msg + (res.applied ? " · " + res.applied + " cote(s) reconstruite(s)" : ""));
    if (st.tab3d) scheduleMesh();
  }
  function paramEdit(el, final) {
    const kind = el.dataset.param || "";
    if (kind === "new-name" || kind === "new-expr") {
      if (!final) return;
      const name = (props.querySelector('[data-param="new-name"]') || {}).value || "";
      const expr = (props.querySelector('[data-param="new-expr"]') || {}).value || "";
      const r = S.addParam(st.doc, name, expr);
      if (!r.ok) { say(r.error, "err"); return; }
      rebuildParams(r.doc, "Paramètre « " + name + " » ajouté");
      return;
    }
    const pid = el.dataset.pid || "";
    const p = S.paramList(st.doc).find(x => x.id === pid);
    if (!p) return;
    const v = String(el.value || "").trim();
    if (kind === "name" && v !== p.name) {
      const r = S.updateParam(st.doc, pid, { name: v });
      if (!r.ok) { say(r.error, "err"); renderProps(); return; }
      rebuildParams(r.doc, "Paramètre renommé");
    } else if (kind === "expr" && v !== p.expr) {
      const r = S.updateParam(st.doc, pid, { expr: v });
      if (!r.ok) { say(r.error, "err"); renderProps(); return; }
      rebuildParams(r.doc, "Paramètre mis à jour");
    }
  }
  /** What a cote measures, matched back to the sketch's points (or lines): a drive needs those ids. */
  function driveTarget(o) {
    const pm = S.pointMap(st.doc), tol = Math.max(st.doc.grid.spacing / 2, 1e-6);
    const near = (x, y) => S.findPointNear(st.doc, x, y, tol);
    if (o.type === "dim_linear") {
      const a = near(o.a[0], o.a[1]), b = near(o.b[0], o.b[1]);
      return a && b && a !== b ? { points: [a, b] } : null;
    }
    const v = near(o.c[0], o.c[1]);
    if (!v) return null;
    const lines = st.doc.objects.filter(x => S.isLine(x) && (x.p1 === v || x.p2 === v));
    const pick = (x, y) => {
      let best = null, bestD = Infinity;
      for (const l of lines) {
        const other = pm.get(l.p1 === v ? l.p2 : l.p1);
        if (!other) continue;
        const d = Math.hypot(other.x - x, other.y - y);
        if (d < bestD) { bestD = d; best = l.id; }
      }
      return best;
    };
    const l1 = pick(o.a[0], o.a[1]), l2 = pick(o.b[0], o.b[1]);
    return l1 && l2 && l1 !== l2 ? { lines: [l1, l2], vertex: v } : null;
  }
  function dimDrivePanel(o, u) {
    if (S.dimDrive(o)) {
      const v = S.evalExpr(o.drive.expr, S.evalParams(st.doc).values);
      return `<div class="sk-drive"><div class="sk-prop-head"><strong>Cote pilotante</strong> · ${v.ok ? S.fmt(v.value) + (o.type === "dim_angle" ? "°" : " " + u) : esc(v.error)}</div>
        <div class="sk-row"><label class="sk-grow">Expression<input data-drive="expr" type="text" maxlength="120" value="${esc(o.drive.expr)}"/></label>
        <label class="sk-chk"><input data-drive="keep" type="checkbox"${o.drive.keepLabel ? " checked" : ""}/> Libellé libre</label>
        <button type="button" class="secondary" data-do="driveOff">Libérer</button></div>
        <p class="sk-hint">La reconstruction résout la géométrie sur cette valeur, puis la cote affiche le nombre obtenu.</p></div>`;
    }
    if (!driveTarget(o)) return `<p class="sk-hint">Pour piloter cette cote, elle doit relier deux points de l'esquisse.</p>`;
    return `<div class="sk-row"><label class="sk-grow">Piloter par<input data-drive="expr" type="text" maxlength="120" placeholder="largeur"/></label><button type="button" data-do="driveOn">Piloter cette cote</button></div>`;
  }
  function applyDrive(el, final) {
    if (!final) return;
    const o = st.sel.length === 1 ? S.getObj(st.doc, st.sel[0]) : null;
    if (!o || !(o.type === "dim_linear" || o.type === "dim_angle")) return;
    const target = driveTarget(o);
    if (!target) { say("Cette cote doit relier deux points de l'esquisse", "err"); return; }
    if (el.dataset.drive === "keep") {
      if (!S.dimDrive(o)) return;
      const r = S.setDimDrive(st.doc, o.id, Object.assign({ expr: o.drive.expr, keepLabel: !!el.checked }, target));
      if (r.ok) commit(r.doc); else say(r.error, "err");
      return;
    }
    const expr = String(el.value || "").trim();
    if (!expr) return;
    const r = S.setDimDrive(st.doc, o.id, Object.assign({ expr: expr }, target));
    if (!r.ok) { say(r.error, "err"); return; }
    rebuildParams(r.doc, "Cote pilotée par « " + expr + " »");
  }

  function renderProps() {
    if (!props || !st.doc) return;
    const u = esc(st.doc.units), sel = st.sel.map(id => S.getObj(st.doc, id)).filter(Boolean);
    let h = "";
    if (!sel.length) {
      const tip = st.tool === "dimang" && st.angleTaps.length ? `Point ${st.angleTaps.length + 1} / 3…` : HINTS[st.tool] || "";
      h = `<p class="sk-hint">${esc(tip)}</p>`;
    } else if (sel.length === 1 && S.isLine(sel[0])) {
      const i = lineInfo(sel[0].id), k = st.doc.constraints.find(c => c.type === "length" && c.line === sel[0].id);
      if (k) st.fixedEnd = k.fixed === sel[0].p1 ? "p1" : "p2";
      h = `<div class="sk-prop-head"><strong>${sel[0].type === "centerline" ? "Axe" : "Ligne"} ${esc(sel[0].id)}</strong> · L ${S.fmt(i.L)} ${u} · ${S.fmt(i.ang, 2)}°${k ? ' <span class="badge">cote pilotante</span>' : ""}</div>
      <div class="sk-row"><label>Longueur (${u})<input data-apply="length" type="number" inputmode="decimal" step="any" min="0" value="${S.fmt(k ? k.value : i.L)}"/></label>
      <div class="sk-fixed" role="group" aria-label="Extrémité fixe"><span>Fixe :</span>
        <button type="button" class="sk-chip${st.fixedEnd === "p1" ? " on" : ""}" data-fixed="p1" aria-pressed="${st.fixedEnd === "p1"}">■ Début</button>
        <button type="button" class="sk-chip${st.fixedEnd === "p2" ? " on" : ""}" data-fixed="p2" aria-pressed="${st.fixedEnd === "p2"}">■ Fin</button></div>
      <button type="button" data-do="length">Appliquer</button>${k ? `<button type="button" class="secondary" data-unlock="${esc(k.id)}">Libérer</button>` : ""}</div>
      <p class="sk-hint">L'extrémité fixe (■ sur le dessin) ne bouge pas ; l'autre glisse sur la ligne jusqu'à la longueur réelle saisie.</p>`;
    } else if (sel.length === 2 && S.isLine(sel[0]) && S.isLine(sel[1])) {
      const v = S.sharedVertex(st.doc, sel[0].id, sel[1].id);
      if (!v) h = `<p class="sk-hint">Ces deux lignes ne partagent pas d'extrémité : impossible de coter l'angle entre elles.</p>`;
      else {
        const [ref, mv] = st.swapAngle ? [sel[1], sel[0]] : [sel[0], sel[1]];
        const cur = S.angleBetween(st.doc, ref.id, mv.id).deg;
        const k = st.doc.constraints.find(c => c.type === "angle" && c.vertex === v && c.lines.includes(ref.id) && c.lines.includes(mv.id));
        h = `<div class="sk-prop-head"><strong>Angle ${esc(ref.id)} / ${esc(mv.id)}</strong> · ${S.fmt(cur, 3)}°${k ? ' <span class="badge">cote pilotante</span>' : ""}</div>
        <div class="sk-row"><label>Angle (°)<input data-apply="angle" type="number" inputmode="decimal" step="any" min="0" max="180" value="${S.fmt(k ? k.value : cur, 3)}"/></label>
        <span class="sk-hint">Pivote : <strong>${esc(mv.id)}</strong></span><button type="button" class="secondary" data-do="swap">Inverser</button>
        <button type="button" data-do="angle">Appliquer</button>${k ? `<button type="button" class="secondary" data-unlock="${esc(k.id)}">Libérer</button>` : ""}</div>
        <p class="sk-hint">La ligne qui pivote tourne autour du sommet commun en gardant sa longueur.</p>`;
      }
    } else if (sel.length === 1 && sel[0].type === "text") {
      h = `<div class="sk-prop-head"><strong>Note</strong></div><div class="sk-row"><label class="sk-grow">Texte<input data-edit="text" type="text" maxlength="500" value="${esc(sel[0].text)}"/></label>
        <label>Hauteur (${u})<input data-edit="h" type="number" inputmode="decimal" step="any" min="0" value="${S.fmt(sel[0].h)}"/></label></div>`;
    } else if (sel.length === 1 && (sel[0].type === "dim_linear" || sel[0].type === "dim_angle")) {
      const o = sel[0], meas = o.type === "dim_linear" ? S.fmt(S.measureLinear(o.a, o.b)) + " " + u : S.fmt(S.measureAngle(o.c, o.a, o.b), 2) + "°";
      h = `<div class="sk-prop-head"><strong>Cote manuelle</strong> · mesurée ${esc(meas)} <span class="badge">annotation</span></div>
        <div class="sk-row"><label class="sk-grow">Libellé (vide = valeur mesurée)<input data-edit="label" type="text" maxlength="500" value="${esc(o.label)}" placeholder="${esc(meas)}"/></label>
        ${o.type === "dim_linear" ? `<label>Décalage (${u})<input data-edit="offset" type="number" inputmode="decimal" step="any" value="${S.fmt(o.offset)}"/></label>` : ""}</div>
        <p class="sk-hint">Une cote manuelle ne pilote jamais la géométrie (calque COTATIONS du DXF).</p>`;
      h += dimDrivePanel(o, u);
    } else if (sel.length === 1 && S.isRadialDim(sel[0])) {
      const o = sel[0], g = S.dimRadialGeom(st.doc, o);
      const meas = g ? (o.type === "dim_diameter" ? "\u2300" : "R") + S.fmt(g.value) : "cercle introuvable";
      h = `<div class="sk-prop-head"><strong>Cote ${o.type === "dim_diameter" ? "de diamètre" : "de rayon"}</strong> · mesurée ${esc(meas)} <span class="badge">annotation</span></div>
        <div class="sk-row"><label class="sk-grow">Libellé (vide = valeur mesurée)<input data-edit="label" type="text" maxlength="500" value="${esc(o.label || "")}" placeholder="${esc(meas)}"/></label>
        <label>Tolérance<input data-edit="tol" type="text" maxlength="24" value="${esc(o.tol || "")}" placeholder="±0,1"/></label></div>
        <div class="sk-row"><label class="sk-chk"><input data-edit="ref" type="checkbox"${o.ref ? " checked" : ""}/> Cote de référence (entre parenthèses)</label></div>
        <p class="sk-hint">La cote suit son cercle ou son arc ; elle ne pilote jamais la géométrie (calque COTATIONS du DXF).</p>`;
    } else if (sel.length === 1 && sel[0].type === "circle") {
      h = `<div class="sk-prop-head"><strong>Cercle ${esc(sel[0].id)}</strong> · Ø ${S.fmt(sel[0].r * 2)} ${u}</div>
        <div class="sk-row"><label>Rayon (${u})<input data-edit="r" type="number" inputmode="decimal" step="any" min="0" value="${S.fmt(sel[0].r)}"/></label></div>`;
    } else {
      h = `<div class="sk-prop-head"><strong>${sel.length} objet(s)</strong></div><p class="sk-hint">Glisse pour déplacer, puis la corbeille pour supprimer. Sélectionne deux lignes reliées pour coter leur angle.</p>`;
    }
    if (st.newSketch && inV6()) {
      h = `<div class="sk-prop-head"><strong>Nouvelle esquisse</strong></div>
        <div class="sk-row"><label>Plan <select data-ns="plane">${Object.entries(S.SKETCH_PLANES).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join("")}</select></label>
        <label>Décalage (${u})<input data-ns="offset" type="number" inputmode="decimal" step="any" value="0"/></label>
        <label class="sk-grow">Nom<input data-ns="name" type="text" maxlength="40" placeholder="Face avant"/></label>
        <button type="button" data-do="createSketch">Créer</button><button type="button" class="secondary" data-do="cancelSketch">Annuler</button></div>
        <p class="sk-hint">L'esquisse se dessine à plat ; sa pièce 3D se place sur ce plan (XZ : vue de face, YZ : vue de côté).</p>` + h;
    }
    if (st.tool === "polygon") h = `<div class="sk-row"><label>Côtés<input data-tool-opt="polySides" type="number" inputmode="numeric" min="3" max="12" step="1" value="${Math.round(Number(st.polySides) || 6)}"/></label></div>` + h;
    if (st.tool === "spline" && st.splinePts.length) h = `<div class="sk-row"><button type="button" data-do="splineDone">Terminer la spline (${st.splinePts.length} points)</button></div>` + h;
    if (sel.some(o => o.construction)) h = `<p class="sk-hint">Géométrie de construction : référence seulement, jamais dans un profil 3D.</p>` + h;
    if (inV6() && st.doc.mode === "construction" && sel.length) h += constraintPanel(sel, u);
    if (inV6() && st.doc.mode === "construction" && (st.doc.sketches || []).length) h += sketchPanel() + `<div class="sk-row"><button type="button" class="sk-chip" data-do="selSketch">Tout sélectionner dans cette esquisse</button></div>`;
    h += transformPanel(sel) + paramsPanel() + livePanel();
    if (st.hist.past.length) {
      const n = st.hist.past.length;
      h += `<div class="sk-hist2d"><label>Historique <input type="range" min="0" max="${n}" step="1" value="${n}" data-hist2d aria-label="Étape de l'historique"/></label>
        <span class="sk-hist2d-label">Étape ${n + 1}/${n + 1} · maintenant</span>
        <button type="button" class="secondary" data-do="histJump" disabled>Revenir à cette étape</button></div>`;
    }
    props.innerHTML = h;
    renderSolid();
    updateFloat();
  }
  /** Geometric constraints offered for the selection, and those already holding it (✕ removes one). */
  function constraintPanel(sel, u) {
    const lines = sel.filter(o => S.isLine(o)), rounds = sel.filter(o => o.type === "circle" || o.type === "arc");
    const b = (type, label, extra) => `<button type="button" class="sk-chip" data-geo="${type}"${extra || ""}>${label}</button>`;
    let opts = "";
    if (lines.length === 1 && sel.length === 1) opts += b("horizontal", "Horizontale") + b("vertical", "Verticale");
    if (lines.length === 2 && sel.length === 2) opts += b("parallel", "Parallèles") + b("perpendicular", "Perpendiculaires") + b("equal", "Égales") + b("collinear", "Colinéaires");
    if (rounds.length === 2 && sel.length === 2) opts += b("tangent", "Tangents") + b("equal", "Même rayon") + b("concentric", "Concentriques");
    if (lines.length === 1 && rounds.length === 1 && sel.length === 2) opts += b("tangent", "Tangentes") + b("point_on_curve", "Point sur la courbe") + b("midpoint", "Centre au milieu") + b("point_on_line", "Centre sur la ligne");
    if (rounds.length === 2 && lines.length === 1 && sel.length === 3) opts += b("symmetric", "Symétriques / axe");
    if (rounds.length === 1 && sel.length === 1) opts += `<label>Rayon (${u})<input data-geo-val type="number" inputmode="decimal" step="any" min="0" value="${S.fmt(rounds[0].type === "circle" ? rounds[0].r : S.arcGeom(rounds[0], S.pointMap(st.doc)).r)}"/></label>` + b("radius", "Imposer le rayon");
    if (sel.some(o => S.isLine(o) || o.type === "circle" || o.type === "arc" || o.type === "ellipse" || o.type === "spline")) opts += b("fixed", "Fixer");
    const ids = new Set(sel.map(o => o.id)), pts = new Set();
    sel.forEach(o => ["p1", "p2", "center"].forEach(k => o[k] && pts.add(o[k])));
    for (const o of sel) if (o.type === "spline") for (const p of o.pts || []) pts.add(p);
    const held = st.doc.constraints.filter(k => S.GEO_CONSTRAINTS.includes(k.type) && (ids.has(k.line) || ids.has(k.item) || (k.items || []).some(x => ids.has(x)) || pts.has(k.point) || (k.points || []).some(p => pts.has(p))));
    const NAMES = { horizontal: "Horizontale", vertical: "Verticale", parallel: "Parallèles", perpendicular: "Perpendiculaires", equal: "Égales", tangent: "Tangentes", radius: "Rayon", fixed: "Fixe",
      concentric: "Concentriques", collinear: "Colinéaires", symmetric: "Symétriques", midpoint: "Milieu", point_on_curve: "Point sur courbe" };
    const rep = S.sketchReport(st.doc);
    const label = k => NAMES[k.type] + (k.type === "radius" ? " " + S.fmt(k.value) : "");
    const clash = (rep.conflicts.length ? rep.conflicts : rep.redundant).map(id => st.doc.constraints.find(k => k.id === id)).filter(Boolean).map(label);
    return `<div class="sk-geo"><div class="sk-prop-head"><strong>Contraintes</strong> · ${rep.dof ? rep.dof + " degré(s) de liberté (bleu = encore libre)" : "esquisse entièrement définie"}</div>
      ${clash.length ? `<p class="sk-hint sk-with-i" role="status">${ICON.warn}<span>${rep.conflicts.length ? "Relations en conflit" : "Relations redondantes"} : ${esc(clash.join(", "))}</span></p>` : ""}
      ${opts ? `<div class="sk-row sk-geo-opts">${opts}</div>` : ""}
      ${held.length ? `<div class="sk-row sk-geo-held">${held.map(k => `<span class="sk-chip on">${esc(label(k))} <button type="button" class="sk-x" data-unlock="${esc(k.id)}" aria-label="Retirer la contrainte ${esc(NAMES[k.type])}">${ICON.close}</button></span>`).join("")}</div>` : ""}</div>`;
  }
  /** Rotate / mirror / scale, and repeat a selection in 2D — the daily CAD moves that moving a selection never covered. */
  function transformPanel(sel) {
    if (!sel.length) return "";
    const axes = sel.filter(o => S.isLine(o)), allCon = sel.every(o => o.construction);
    return `<div class="sk-row sk-xform">
      <label>Rotation (°)<input data-xf="angle" type="number" inputmode="decimal" step="any" value="90"/></label>
      <button type="button" class="sk-chip" data-do="xrotate">Tourner</button>
      <button type="button" class="sk-chip" data-do="xmirror-h" title="Miroir haut/bas">Miroir H</button>
      <button type="button" class="sk-chip" data-do="xmirror-v" title="Miroir gauche/droite">Miroir V</button>
      <label>Échelle<input data-xf="factor" type="number" inputmode="decimal" step="any" min="0.01" value="2"/></label>
      <button type="button" class="sk-chip" data-do="xscale">Appliquer</button></div>
      <div class="sk-row sk-xform">
      <label>Décaler<input data-xf="dist" type="number" inputmode="decimal" step="any" value="2"/></label>
      <button type="button" class="sk-chip" data-do="xoffset">Offset</button>
      <button type="button" class="sk-chip" data-do="construction" aria-pressed="${allCon}">${allCon ? "Géométrie normale" : "Construction"}</button></div>
      ${axes.length && sel.length > axes.length ? `<div class="sk-row sk-xform">
      <label>Axe<select data-xf="axis">${axes.map(o => `<option value="${esc(o.id)}">${esc(o.id)}</option>`).join("")}</select></label>
      <button type="button" class="sk-chip" data-do="xmirror-axis">Miroir / axe</button></div>` : ""}
      <div class="sk-row sk-xform">
      <label>Répéter<input data-xf="count" type="number" min="2" max="50" step="1" value="3"/></label>
      <label>Pas X<input data-xf="dx" type="number" step="any" value="0"/></label>
      <label>Pas Y<input data-xf="dy" type="number" step="any" value="0"/></label>
      <button type="button" class="sk-chip" data-do="xarray">En ligne</button>
      <button type="button" class="sk-chip" data-do="xarray-circ">En cercle</button></div>`;
  }
  /** The v6 sketch list: activate, lock, rename, reorder, delete — instead of the single select in the toolbar. */
  function sketchPanel() {
    const list = st.doc.sketches || [];
    const rows = list.map((sk, i) => `<div class="sk-sk-row${sk.id === st.sketch ? " is-active" : ""}${sk.hidden ? " is-hidden" : ""}">
      <span class="sk-sk-name">${esc(sk.name)} · ${esc(sk.plane)}${sk.offset ? " " + (sk.offset > 0 ? "+" : "") + S.fmt(sk.offset) : ""}${sk.locked ? " · verrouillée" : ""}${sk.hidden ? " · masquée" : ""}</span>
      <button type="button" class="sk-mini" data-sk-act="use" data-sk="${esc(sk.id)}"${sk.id === st.sketch ? " disabled" : ""}>Activer</button>
      <button type="button" class="sk-mini" data-sk-act="hide" data-sk="${esc(sk.id)}" aria-pressed="${!!sk.hidden}">${sk.hidden ? "Afficher" : "Masquer"}</button>
      <button type="button" class="sk-mini" data-sk-act="lock" data-sk="${esc(sk.id)}" aria-pressed="${!!sk.locked}">${sk.locked ? "Déverrouiller" : "Verrouiller"}</button>
      <button type="button" class="sk-mini" data-sk-act="rename" data-sk="${esc(sk.id)}">Renommer</button>
      <button type="button" class="sk-mini" data-sk-act="up" data-sk="${esc(sk.id)}" aria-label="Monter l'esquisse"${i === 0 ? " disabled" : ""}>${ICON.chevronUp}</button>
      <button type="button" class="sk-mini" data-sk-act="down" data-sk="${esc(sk.id)}" aria-label="Descendre l'esquisse"${i === list.length - 1 ? " disabled" : ""}>${ICON.chevronDown}</button>
      <button type="button" class="sk-mini" data-sk-act="del" data-sk="${esc(sk.id)}" aria-label="Supprimer l'esquisse">${ICON.trash}</button>
    </div>`).join("");
    return `<div class="sk-sketches"><div class="sk-prop-head"><strong>Esquisses</strong> · ${list.length}</div>${rows}
      ${st.sketch ? `<div class="sk-row"><button type="button" class="sk-chip" data-do="convertVisible" title="Copie les arêtes visibles des autres esquisses en construction dans celle-ci">Convertir les arêtes visibles</button></div>` : ""}</div>`;
  }
  function sketchAction(what, id) {
    if (!id) return;
    if (what === "use") { setSketch(id); return; }
    if (what === "rename") {
      const cur = (st.doc.sketches || []).find(x => x.id === id);
      const name = window.prompt("Nom de l'esquisse", cur ? cur.name : "");
      if (name == null) return;
      const r = S.updateSketch(st.doc, id, { name: name });
      if (!r.ok) { say(r.error, "err"); return; }
      commit(r.doc); return;
    }
    if (what === "hide") {
      const sk = (st.doc.sketches || []).find(x => x.id === id);
      const hide = !(sk && sk.hidden);
      const r = S.updateSketch(st.doc, id, { hidden: hide });
      if (!r.ok) { say(r.error, "err"); return; }
      if (hide && st.sketch === id) st.sketch = ""; // an invisible sketch is never the one being edited
      commit(r.doc); setSketch(st.sketch); say(hide ? "Esquisse masquée" : "Esquisse affichée");
      return;
    }
    if (what === "lock") {
      const sk = (st.doc.sketches || []).find(x => x.id === id);
      const r = S.updateSketch(st.doc, id, { locked: !(sk && sk.locked) });
      if (!r.ok) { say(r.error, "err"); return; }
      commit(r.doc); say(sk && sk.locked ? "Esquisse déverrouillée" : "Esquisse verrouillée"); return;
    }
    if (what === "up" || what === "down") {
      const r = S.moveSketch(st.doc, id, what === "up" ? -1 : 1);
      if (!r.ok) { say(r.error, "err"); return; }
      commit(r.doc); renderToolbar(); return;
    }
    if (what === "del") {
      if (!window.confirm("Supprimer cette esquisse et ce qu'elle contient ?")) return;
      const r = S.removeSketch(st.doc, id);
      if (!r.ok) { say(r.error, "err"); return; }
      if (st.sketch === id) st.sketch = "";
      commit(r.doc); setSketch(st.sketch); say("Esquisse supprimée"); return;
    }
  }
  function updateHist2d() {
    const r = props.querySelector("[data-hist2d]");
    if (!r) return;
    const n = st.hist.past.length, i = Number(r.value);
    st.histPick = i;
    const lab = props.querySelector(".sk-hist2d-label");
    const go = props.querySelector('[data-do="histJump"]');
    if (lab) lab.textContent = i >= n ? "Étape " + (n + 1) + "/" + (n + 1) + " · maintenant" : "Étape " + (i + 1) + "/" + (n + 1);
    if (go) go.disabled = i >= n;
  }
  /** Back to an earlier step in one move (the 3D history slider's twin for the 2D sketch). */
  function jumpHistory(i) {
    const n = st.hist.past.length;
    if (!n) return;
    const target = Math.max(0, Math.min(Math.floor(Number(i)), n - 1));
    st.hist.future.push(JSON.stringify(st.doc));
    while (st.hist.past.length > target + 1) st.hist.future.push(st.hist.past.pop());
    setDoc(JSON.parse(st.hist.past.pop()));
    st.doc.view = st.view;
    st.preview3d = null; st.meshVersion++; st.dirty = true; st.sel = [];
    scheduleDraft(); refreshAll();
    say("Revenu à l'étape " + (target + 1));
  }
  function applyGeo(type, given) {
    const sel = st.sel.map(id => S.getObj(st.doc, id)).filter(Boolean);
    let doc = st.doc, err = null;
    const add = k => { const r = S.addConstraint(doc, k); if (r.ok) doc = r.doc; else err = r.error; };
    if (type === "horizontal" || type === "vertical") add({ type: type, line: sel[0].id });
    else if (type === "radius") {
      const v = given != null ? Number(given) : Number(String((props.querySelector("[data-geo-val]") || {}).value || "").replace(",", "."));
      if (!(v > 0)) { say("Rayon invalide", "err"); return; }
      add({ type: "radius", item: sel[0].id, value: v });
    } else if (type === "fixed") {
      const pts = new Set();
      sel.forEach(o => ["p1", "p2", "center"].forEach(k => o[k] && pts.add(o[k])));
      for (const pid of pts) if (!err && !doc.constraints.some(k => k.type === "fixed" && k.point === pid)) add({ type: "fixed", point: pid });
    } else if (type === "concentric" || type === "collinear") add({ type: type, items: [sel[0].id, sel[1].id] });
    else if (type === "symmetric") {
      const axis = sel.find(o => S.isLine(o)), centers = sel.filter(o => o.type === "circle" || o.type === "arc").map(o => o.center);
      if (!axis || centers.length !== 2) { say("Sélectionne deux cercles/arcs et la ligne d'axe", "err"); return; }
      add({ type: "symmetric", points: [centers[0], centers[1]], line: axis.id });
    } else if (type === "midpoint" || type === "point_on_line") {
      const round = sel.find(o => o.type === "circle" || o.type === "arc"), line = sel.find(o => S.isLine(o));
      if (!round || !line) { say("Sélectionne un cercle/arc et une ligne", "err"); return; }
      add(type === "midpoint" ? { type: "midpoint", point: round.center, line: line.id } : { type: "point_on_curve", point: round.center, item: line.id });
    } else if (type === "point_on_curve") {
      const round = sel.find(o => o.type === "circle" || o.type === "arc"), line = sel.find(o => S.isLine(o));
      if (!round || !line) { say("Sélectionne une ligne et un cercle/arc", "err"); return; }
      const pm = S.pointMap(st.doc), c = pm.get(round.center), p1 = pm.get(line.p1), p2 = pm.get(line.p2);
      const pid = Math.hypot(p1.x - c.x, p1.y - c.y) <= Math.hypot(p2.x - c.x, p2.y - c.y) ? line.p1 : line.p2;
      add({ type: "point_on_curve", point: pid, item: round.id });
    } else add({ type: type, items: [sel[0].id, sel[1].id] });
    if (err) { say(err, "err"); return; }
    commit(doc);
    say("Contrainte appliquée");
  }
  function onPropsClick(e) {
    const paramBtn = e.target.closest("[data-param-act]");
    if (paramBtn) {
      const what = paramBtn.dataset.paramAct, pid = paramBtn.dataset.pid || "";
      if (what === "add") {
        const name = (props.querySelector('[data-param="new-name"]') || {}).value || "";
        const expr = (props.querySelector('[data-param="new-expr"]') || {}).value || "";
        const r = S.addParam(st.doc, name, expr);
        if (!r.ok) { say(r.error, "err"); return; }
        rebuildParams(r.doc, "Paramètre « " + name + " » ajouté");
      } else if (what === "del") {
        const p = S.paramList(st.doc).find(x => x.id === pid);
        if (!p) return;
        if (!window.confirm("Supprimer le paramètre « " + p.name + " » ? Les cotes qui l'utilisent resteront en erreur.")) return;
        const r = S.removeParam(st.doc, pid);
        if (!r.ok) { say(r.error, "err"); return; }
        rebuildParams(r.doc, "Paramètre supprimé");
      } else if (what === "rebuild") rebuildParams(st.doc, "Reconstruction");
      return;
    }
    const driveBtn = e.target.closest("[data-do]");
    if (driveBtn && ["driveOn", "driveOff", "liveTake"].includes(driveBtn.dataset.do)) {
      const what = driveBtn.dataset.do;
      if (what === "liveTake") { liveTake(); return; }
      const o = st.sel.length === 1 ? S.getObj(st.doc, st.sel[0]) : null;
      if (!o || !(o.type === "dim_linear" || o.type === "dim_angle")) return;
      if (what === "driveOff") {
        const r = S.clearDimDrive(st.doc, o.id);
        if (!r.ok) { say(r.error, "err"); return; }
        commit(r.doc); say("Cote de nouveau manuelle"); return;
      }
      const expr = String(((props.querySelector('[data-drive="expr"]') || {}).value) || "").trim();
      const target = driveTarget(o);
      if (!target) { say("Cette cote doit relier deux points de l'esquisse", "err"); return; }
      if (!expr) { say("Tape d'abord une expression ou un nom de paramètre", "err"); return; }
      const r = S.setDimDrive(st.doc, o.id, Object.assign({ expr: expr }, target));
      if (!r.ok) { say(r.error, "err"); return; }
      rebuildParams(r.doc, "Cote pilotée par « " + expr + " »");
      return;
    }
    const skBtn = e.target.closest("[data-sk-act]");
    if (skBtn) { sketchAction(skBtn.dataset.skAct, skBtn.dataset.sk); return; }
    const early = e.target.closest("[data-do]");
    if (early && early.dataset.do === "splineDone") { finishSpline(); return; }
    if (early && early.dataset.do === "convertVisible") {
      if (!st.sketch) { say("Active une esquisse cible", "err"); return; }
      const hidden = new Set((st.doc.sketches || []).filter(x => x.hidden).map(x => x.id));
      const src = st.doc.objects.filter(o => S.sketchOf(o) !== st.sketch && !hidden.has(S.sketchOf(o))).map(o => o.id);
      if (!src.length) { say("Aucune arête visible à convertir", "err"); return; }
      const r = S.convertToSketch(st.doc, src, st.sketch, { construction: true });
      if (!r.ok) { say(r.error, "err"); return; }
      commit(r.doc); st.sel = r.ids.slice(); refreshAll();
      say(r.ids.length + " arête(s) converties en construction");
      return;
    }
    const doBtn = e.target.closest("[data-do]");
    if (doBtn && ["histJump", "xrotate", "xmirror-h", "xmirror-v", "xscale", "xarray", "xarray-circ", "xoffset", "xmirror-axis", "construction"].includes(doBtn.dataset.do)) {
      const kind = doBtn.dataset.do;
      if (kind === "histJump") { jumpHistory(st.histPick == null ? 0 : st.histPick); return; }
      const xf = k => Number(String((props.querySelector(`[data-xf="${k}"]`) || {}).value || "").replace(",", "."));
      const ids = st.sel.slice();
      let r;
      if (kind === "xrotate") r = S.transformObjects(st.doc, ids, { kind: "rotate", angle: xf("angle") });
      else if (kind === "xmirror-h") r = S.transformObjects(st.doc, ids, { kind: "mirror", axis: "h" });
      else if (kind === "xmirror-v") r = S.transformObjects(st.doc, ids, { kind: "mirror", axis: "v" });
      else if (kind === "xscale") r = S.transformObjects(st.doc, ids, { kind: "scale", factor: xf("factor") });
      else if (kind === "xarray") r = S.arrayObjects(st.doc, ids, { mode: "linear", count: xf("count"), dx: xf("dx"), dy: xf("dy") });
      else if (kind === "xoffset") r = S.offsetObjects(st.doc, ids, xf("dist"));
      else if (kind === "xmirror-axis") r = S.mirrorObjects(st.doc, ids, String((props.querySelector('[data-xf="axis"]') || {}).value || ""));
      else if (kind === "construction") {
        const on = !ids.every(id => (S.getObj(st.doc, id) || {}).construction);
        r = S.setConstruction(st.doc, ids, on);
        if (r.ok) { commit(r.doc); say(on ? "Géométrie de construction" : "Géométrie normale"); }
        else say(r.error, "err");
        return;
      }
      else r = S.arrayObjects(st.doc, ids, { mode: "circular", count: xf("count"), angle: 360 });
      if (!r || !r.ok) { say((r && r.error) || "Transformation refusée", "err"); return; }
      const label = kind === "xoffset" ? "Offset créé" : kind === "xmirror-axis" ? "Miroir créé" : kind.indexOf("xarray") === 0 ? "Copies créées" : "Transformation appliquée";
      commit(r.doc); if (r.ids) st.sel = r.ids.slice(); refreshAll(); say(label); return;
    }
    const f = e.target.closest("[data-fixed]");
    if (f) {
      // toggle in place: never re-render (it would wipe a length the user already typed)
      st.fixedEnd = f.dataset.fixed;
      props.querySelectorAll("[data-fixed]").forEach(b => { const on = b.dataset.fixed === st.fixedEnd; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
      draw(); return;
    }
    const u = e.target.closest("[data-unlock]");
    if (u) { commit(S.removeConstraint(st.doc, u.dataset.unlock)); return; }
    const g = e.target.closest("[data-geo]");
    if (g) { applyGeo(g.dataset.geo); return; }
    const d = e.target.closest("[data-do]");
    if (!d) return;
    if (d.dataset.do === "createSketch") {
      const plane = props.querySelector('[data-ns="plane"]').value, off = Number(String(props.querySelector('[data-ns="offset"]').value).replace(",", ".")) || 0;
      const r = S.addSketch(st.doc, plane, off, props.querySelector('[data-ns="name"]').value);
      if (!r.ok) { say(r.error, "err"); return; }
      st.newSketch = false; commit(r.doc); setSketch(r.id); say("Esquisse créée : dessine-la à plat"); return;
    }
    if (d.dataset.do === "cancelSketch") { st.newSketch = false; renderProps(); renderToolbar(); return; }
    if (d.dataset.do === "selSketch") {
      const view = vdoc();
      st.sel = view.objects.map(o => o.id);
      renderProps(); draw(); updateButtons();
      say(st.sel.length + " objet(s) dans cette esquisse");
      return;
    }
    if (d.dataset.do === "swap") {
      const typed = props.querySelector('input[data-apply="angle"]');
      const keep = typed && typed.value;
      st.swapAngle = !st.swapAngle; renderProps(); draw();
      const again = props.querySelector('input[data-apply="angle"]');
      if (again && keep) again.value = keep;
      return;
    }
    applyProp(d.dataset.do);
  }
  function applyProp(kind) {
    const inp = props.querySelector(`input[data-apply="${kind}"]`);
    const v = Number(String(inp ? inp.value : "").replace(",", "."));
    if (kind === "length") {
      const o = S.getObj(st.doc, st.sel[0]);
      if (tryCommit(S.setLineLength(st.doc, o.id, o[st.fixedEnd], v))) say("Longueur " + S.fmt(v) + " " + st.doc.units + " appliquée");
    } else if (kind === "angle") {
      const [a, b] = st.sel; const [ref, mv] = st.swapAngle ? [b, a] : [a, b];
      if (tryCommit(S.setAngle(st.doc, mv, ref, v))) say("Angle " + S.fmt(v, 3) + "° appliqué");
    }
  }
  function onPropsChange(e) {
    if (e.target.matches("input[data-param]")) {
      // the empty « new parameter » row is submitted on Enter or « Ajouter », not by leaving the field
      if (!String(e.target.dataset.param || "").startsWith("new-")) paramEdit(e.target, true);
      return;
    }
    if (e.target.matches("input[data-drive]")) { applyDrive(e.target, true); return; }
    const k = e.target.dataset.edit;
    if (!k || st.sel.length !== 1) return;
    const raw = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    const patch = {}; patch[k] = k === "text" || k === "label" || k === "tol" ? String(raw) : (k === "ref" ? !!raw : Number(String(raw).replace(",", ".")));
    tryCommit(S.updateObject(st.doc, st.sel[0], patch));
  }

  // ------------------------------------------------------------ HUD
  function setHud(m, a, b, rect) {
    if (!hud) return;
    const u = st.doc.units;
    let t = "";
    if (a && b) {
      if (rect) t = "▭ " + S.fmt(Math.abs(b.x - a.x)) + " × " + S.fmt(Math.abs(b.y - a.y)) + " " + u;
      else t = "L " + S.fmt(Math.hypot(b.x - a.x, b.y - a.y)) + " " + u + " · " + S.fmt(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI, 1) + "°";
    } else if (st.hudMsg) t = st.hudMsg;
    hud.classList.toggle("err", !!st.hudErr && !!st.hudMsg && !(a && b));
    const pos = m ? "X " + S.fmt(m.x, 2) + " Y " + S.fmt(m.y, 2) : "";
    const modeName = st.doc.mode === "construction" ? "Construction" : "Croquis rapide";
    let perf = "";
    if (st.perfHud && st.perf.length) {
      const last = st.perf[st.perf.length - 1], p = S.perfStats(st.perf.slice(-90).map(f => f.ms));
      const drawn = last.drawn == null || last.drawn === last.objects ? "" : ` (${last.drawn} dessinés)`;
      perf = `<span class="sk-perf" title="Coût JS du dernier rendu (base + calque) · p95 sur 90 images · objets après élimination hors champ">${last.objects} obj${drawn} · ${S.fmt(p.median, 1)} ms · p95 ${S.fmt(p.p95, 1)}${S.budgetOk(p, last.objects) ? "" : " ⚠"}</span>`;
    }
    hud.innerHTML = `<span>${esc(modeName)}</span><span>Grille ${esc(S.fmt(st.doc.grid.spacing))} ${esc(u)}</span>${pos ? `<span>${esc(pos)}</span>` : ""}${t ? `<strong>${esc(t)}</strong>` : ""}${perf}`;
  }
  function flashHud(msg) { st.hudMsg = msg; st.hudErr = true; setHud(); const live = $(".sk-status", root); if (live) live.textContent = String(msg || ""); setTimeout(() => { if (st.hudMsg === msg) { st.hudMsg = ""; st.hudErr = false; setHud(); } }, 4000); }

  // ------------------------------------------------------------ live: the same drawing on the pad and on the PC
  const LIVE_POLL_MS = 1500, LIVE_PUBLISH_MS = 700;
  function liveId() {
    if (!st.liveClient) {
      const raw = window.crypto && crypto.randomUUID ? crypto.randomUUID() : "c" + Date.now().toString(36) + Math.random().toString(36).slice(2);
      st.liveClient = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    }
    return st.liveClient;
  }
  function liveDevice() {
    const ua = navigator.userAgent || "";
    if (/iPad|Tablet/i.test(ua)) return "Pad";
    if (/iPhone|Android|Mobile/i.test(ua)) return "Téléphone";
    return "PC";
  }
  /** The document the 3D builder sees: rebuilt up to the rollback point, without the suppressed features. */
  function rebuildDoc(doc) {
    const fs = Array.isArray(doc.features) ? doc.features : [];
    if (!fs.length) return doc;
    return Object.assign({}, doc, { features: S.activeFeatures(doc) });
  }
  /** Follow the saved drawing: its head comes from the bridge, local commits go back to it. */
  function liveStart() {
    liveStop();
    if (!st.stem || !window.api) return;
    st.live = { key: st.stem, rev: 0, timer: 0, pub: 0 };
    st.live.timer = setInterval(livePoll, LIVE_POLL_MS);
    livePoll();
  }
  function liveStop() {
    if (st.live) { clearInterval(st.live.timer); clearTimeout(st.live.pub); }
    st.live = null; st.livePeers = []; st.liveConflict = null; st.liveSig = "";
  }
  async function livePoll() {
    const L = st.live;
    if (!L || !st.doc || document.hidden) return;
    const q = "/api/drawings/live?key=" + encodeURIComponent(L.key) + "&client=" + encodeURIComponent(liveId()) +
      "&name=" + encodeURIComponent(liveDevice()) + "&rev=" + L.rev + (st.sel.length ? "&sel=" + encodeURIComponent(st.sel.slice(0, 12).join(",")) : "") +
      (st.lastPointer ? "&cursor=" + encodeURIComponent(S.fmt(st.lastPointer.x, 3) + "," + S.fmt(st.lastPointer.y, 3)) : "");
    let res;
    try { res = await window.api(q, { timeoutMs: 8000 }); } catch (_) { return; } // offline: the draft holds the work
    if (st.live !== L) return;
    st.livePeers = res.peers || [];
    L.rev = res.rev;
    if (res.changed && res.doc) {
      if (!st.dirty && !st.action) {
        setDoc(res.doc); st.sel = []; scheduleDraft(); refreshAll();
        say("Mis à jour depuis « " + (res.by || "un autre appareil") + " »");
      } else {
        st.liveConflict = { doc: res.doc, by: res.by, rev: res.rev };
        say("Un autre appareil a modifié ce dessin : « Reprendre » pour sa version", "err");
      }
    }
    // only redraw the panel when what it shows actually changed: a poll every 1.5 s must not steal the keyboard
    const sig = JSON.stringify(st.livePeers) + "|" + (st.liveConflict ? st.liveConflict.rev + "|" + (st.liveConflict.by || "") : "");
    if (sig !== st.liveSig) { st.liveSig = sig; renderProps(); }
  }
  /** Publish the local head, debounced: a drag that commits three times still sends once. */
  function livePublish() {
    const L = st.live;
    if (!L || !st.doc) return;
    clearTimeout(L.pub);
    L.pub = setTimeout(async () => {
      if (st.live !== L || document.hidden) return; // the next edit or poll picks it up
      try {
        const res = await window.api("/api/drawings/live", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: L.key, doc: st.doc, client: liveId(), name: liveDevice(), rev: L.rev }), timeoutMs: 20000 });
        if (st.live === L) { L.rev = res.rev; st.liveConflict = null; }
      } catch (e) {
        if (st.live !== L) return;
        if (e && e.status === 409 && e.data && e.data.doc) {
          L.rev = e.data.rev;
          st.liveConflict = { doc: e.data.doc, by: e.data.by, rev: e.data.rev };
          flushDraft(); // the local version is already in the draft: say it out loud
          say("Ce dessin a changé ailleurs : ton travail est dans le brouillon", "err");
          flashHud("Conflit : brouillon local gardé");
          renderProps();
        }
      }
    }, LIVE_PUBLISH_MS);
  }
  /** Adopt the other device's head on purpose (the local version stays in the draft). */
  function liveTake() {
    const c = st.liveConflict;
    if (!c || !c.doc) return;
    flushDraft();
    st.liveConflict = null;
    setDoc(c.doc); st.sel = []; st.dirty = true; scheduleDraft(); refreshAll();
    say("Version de « " + (c.by || "l'autre appareil") + " » reprise");
  }
  /** Where the other device's stylus is, without touching the drawing. */
  function drawLiveCursors() {
    const peers = (st.live && st.livePeers) || [];
    const live = peers.filter(p => Array.isArray(p.cursor));
    if (!live.length || !ctx) return;
    ctx.save();
    ctx.font = "600 11px system-ui, -apple-system, sans-serif";
    for (const p of live) {
      const s = S.toScreen(st.view, st.H, p.cursor[0], p.cursor[1]);
      ctx.fillStyle = "#c25e00"; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + 9, s.y + 3.5); ctx.lineTo(s.x + 3.5, s.y + 9); ctx.closePath();
      ctx.fill(); ctx.stroke();
      const label = String(p.name || p.client || "pair").slice(0, 24);
      const w = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.fillRect(s.x + 11, s.y + 8, w + 10, 16);
      ctx.fillStyle = "#8a4400"; ctx.fillText(label, s.x + 16, s.y + 20);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ rendering
  let themeCache = null;
  function luminance(color) {
    try {
      const c = document.createElement("canvas").getContext("2d");
      c.fillStyle = "#000"; c.fillStyle = color;
      const v = c.fillStyle;
      let r, g, b;
      if (v[0] === "#") { r = parseInt(v.slice(1, 3), 16); g = parseInt(v.slice(3, 5), 16); b = parseInt(v.slice(5, 7), 16); }
      else { const m = v.match(/\d+(\.\d+)?/g) || [0, 0, 0]; [r, g, b] = m.map(Number); }
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    } catch (_) { return 0; }
  }
  function theme(forExport) {
    if (forExport) return { bg: "#ffffff", grid: "#e6e9ee", gridMajor: "#c9ced6", ink: "#111418", axis: "#b3261e", ref: "#5b6573", note: "#0b5d1e", dim: "#0b4f8a", accent: "#c25e00", sel: "#c25e00", axisX: "#c62828", axisY: "#2e7d32" };
    const cs = getComputedStyle(document.body);
    const v = (n, f) => (cs.getPropertyValue(n) || "").trim() || f;
    const bg = v("--panel-2", "#141a21"), accent = v("--accent", "#39c2ff");
    const key = bg + "|" + accent;
    if (themeCache && themeCache.key === key) return themeCache.t;
    const light = luminance(bg) > 0.55; // follow the HQ theme (light or dark) for contrast
    const t = light
      ? { bg: bg, grid: "rgba(0,0,0,.07)", gridMajor: "rgba(0,0,0,.16)", ink: "#1b232c", axis: "#c62828", ref: "#5f6b7a", note: "#0b6b2e", dim: "#0b5cab", accent: accent, sel: accent, axisX: "#d32f2f", axisY: "#2e7d32" }
      : { bg: bg, grid: "rgba(255,255,255,.06)", gridMajor: "rgba(255,255,255,.14)", ink: v("--text", "#e8eef4"), axis: "#ff8a80", ref: "#9fb0c3", note: "#9ee6a8", dim: "#8cc8ff", accent: accent, sel: accent, axisX: "#ff6b6b", axisY: "#6bdc7b" };
    themeCache = { key: key, t: t };
    return t;
  }

  let FK = 1; // annotation size factor (1 on screen, larger for the PNG export)
  const FREE_INK = "#2f6fd6";
  const GLYPH = { horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥", equal: "=", tangent: "T", radius: "R", fixed: "⚓",
    concentric: "◎", symmetric: "⇋", midpoint: "M", collinear: "—", point_on_curve: "•" };
  /** Which objects are fully defined (v6 sketches only), cached per document object. */
  const definedCache = new WeakMap();
  function definedSet(doc) {
    if (!doc || (Number(doc.version) || 1) < 6 || doc.mode !== "construction") return null;
    if (!definedCache.has(doc)) { try { definedCache.set(doc, S.freedom(doc).defined); } catch (_) { definedCache.set(doc, null); } }
    return definedCache.get(doc);
  }
  /** A small mark next to what a geometric constraint holds: H, V, ∥, ⊥, =, T, R…, ⚓. */
  function geoGlyph(c, doc, k, pm, ts, T) {
    const mid = id => {
      const o = S.getObj(doc, id); if (!o) return null;
      if (S.isLine(o)) { const a = pm.get(o.p1), b = pm.get(o.p2); return ts((a.x + b.x) / 2, (a.y + b.y) / 2); }
      if (o.type === "circle") { const ce = pm.get(o.center); return ts(ce.x + o.r * 0.71, ce.y + o.r * 0.71); }
      if (o.type === "arc") { const g = S.arcGeom(o, pm), t = g.t0 + g.sweep / 2; return ts(g.c.x + g.r * Math.cos(t), g.c.y + g.r * Math.sin(t)); }
      return null;
    };
    const label = k.type === "radius" ? "R" + S.fmt(k.value) : GLYPH[k.type];
    const at = k.type === "fixed" ? (pm.get(k.point) ? ts(pm.get(k.point).x, pm.get(k.point).y) : null) : mid(k.line || k.item || (k.items || [])[0]);
    if (!at) return;
    const dx = k.type === "fixed" ? 10 : 12, dy = k.type === "fixed" ? 12 : -12;
    c.save(); c.font = "600 11px system-ui, sans-serif";
    const w = c.measureText(label).width + 8;
    c.fillStyle = "rgba(255,255,255,.85)"; c.strokeStyle = FREE_INK; c.lineWidth = 1;
    c.fillRect(at.x + dx - 4, at.y + dy - 10, w, 14); c.strokeRect(at.x + dx - 4, at.y + dy - 10, w, 14);
    c.fillStyle = FREE_INK; c.fillText(label, at.x + dx, at.y + dy + 1);
    c.restore();
  }

  function drawScene(c, doc, view, W, H, T, opts) {
    const o = opts || {};
    FK = o.k || 1;
    const ts = (x, y) => S.toScreen(view, H, x, y);
    if (!o.noBg) { c.fillStyle = T.bg; c.fillRect(0, 0, W, H); }
    if (doc.underlay && !o.noUnderlay) drawUnderlay(c, view, H);
    // grid (real-world spacing; adaptive density so it never turns into noise)
    if (doc.grid.visible && !o.noGrid) {
      let step = doc.grid.spacing, k = 0;
      while (step * view.ppu < 8 && k++ < 12) step *= (k % 2 ? 5 : 2);
      const major = step * 5;
      const x0 = Math.floor(view.x0 / step) * step, x1 = view.x0 + W / view.ppu, y0 = Math.floor(view.y0 / step) * step, y1 = view.y0 + H / view.ppu;
      c.lineWidth = 1;
      for (let pass = 0; pass < 2; pass++) {
        c.strokeStyle = pass ? T.gridMajor : T.grid;
        c.beginPath();
        for (let x = x0; x <= x1; x += step) { const isMaj = Math.abs(Math.round(x / major) * major - x) < step * 1e-3; if (isMaj !== !!pass) continue; const sx = Math.round(ts(x, 0).x) + 0.5; c.moveTo(sx, 0); c.lineTo(sx, H); }
        for (let y = y0; y <= y1; y += step) { const isMaj = Math.abs(Math.round(y / major) * major - y) < step * 1e-3; if (isMaj !== !!pass) continue; const sy = Math.round(ts(0, y).y) + 0.5; c.moveTo(0, sy); c.lineTo(W, sy); }
        c.stroke();
      }
    }
    // model origin
    if (!o.noGrid) {
      const O = ts(0, 0);
      c.strokeStyle = T.gridMajor; c.lineWidth = 1; c.beginPath(); c.moveTo(O.x - 8, O.y); c.lineTo(O.x + 8, O.y); c.moveTo(O.x, O.y - 8); c.lineTo(O.x, O.y + 8); c.stroke();
    }

    const pm = S.pointMap(doc), sel = new Set(o.sel || []);
    st.cull = { considered: doc.objects.length, drawn: 0 }; // what the viewport test let through: the culling number
    const font = px => `${Math.max(9, Math.min(200, px))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    // culling: a zoomed-in view only walks and rasterises what it can see (plus 40 px of margin)
    const mg = 40 / view.ppu;
    const vx0 = view.x0 - mg, vy0 = view.y0 - mg, vx1 = view.x0 + W / view.ppu + mg, vy1 = view.y0 + H / view.ppu + mg;
    const boxAt = ob => {
      const c0 = st.boxes.get(ob.id);
      if (c0 && c0.ref === ob) return c0.box;
      const b = S.objectBox(doc, ob, pm);
      st.boxes.set(ob.id, { ref: ob, box: b });
      return b;
    };
    for (const ob of doc.objects) {
      if (o.skipDims && o.skipDims.has(ob.id)) continue;
      if (o.onlySel && !sel.has(ob.id)) continue;
      const bb = boxAt(ob);
      if (!bb) continue; // its references are gone: nothing to draw until « Réparer » clears it
      if (bb[2] < vx0 || bb[0] > vx1 || bb[3] < vy0 || bb[1] > vy1) continue;
      if (st.cull) st.cull.drawn++;
      const isSel = sel.has(ob.id);
      c.setLineDash([]);
      c.lineCap = "round"; c.lineJoin = "round";
      const free = o.defined && !o.defined.has(ob.id); // v6: blue while it can still move, black once fully defined
      const con = !!ob.construction; // reference only: dashed and never part of a 3D profile
      if (S.isLine(ob)) {
        const a = ts(pm.get(ob.p1).x, pm.get(ob.p1).y), b = ts(pm.get(ob.p2).x, pm.get(ob.p2).y);
        c.strokeStyle = isSel ? T.sel : con ? T.ref : (ob.type === "centerline" ? T.axis : free ? FREE_INK : T.ink);
        c.lineWidth = isSel ? 3 : (ob.type === "centerline" || con ? 1.4 : 2);
        if (ob.type === "centerline") c.setLineDash([14, 4, 3, 4]);
        else if (con) c.setLineDash([8, 4]);
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      } else if (ob.type === "circle") {
        if (ob.r * view.ppu < 0.8) continue; // sub-pixel LOD
        const ce = ts(pm.get(ob.center).x, pm.get(ob.center).y);
        c.strokeStyle = isSel ? T.sel : con ? T.ref : free ? FREE_INK : T.ink; c.lineWidth = isSel ? 3 : 2;
        if (con) c.setLineDash([8, 4]);
        c.beginPath(); c.arc(ce.x, ce.y, ob.r * view.ppu, 0, Math.PI * 2); c.stroke();
        c.lineWidth = 1; c.beginPath(); c.moveTo(ce.x - 4, ce.y); c.lineTo(ce.x + 4, ce.y); c.moveTo(ce.x, ce.y - 4); c.lineTo(ce.x, ce.y + 4); c.stroke();
      } else if (ob.type === "arc") {
        const g = S.arcGeom(ob, pm);
        if (!(g.r * view.ppu >= 0.8)) continue; // sub-pixel LOD
        const ce = ts(g.c.x, g.c.y);
        c.strokeStyle = isSel ? T.sel : con ? T.ref : free ? FREE_INK : T.ink; c.lineWidth = isSel ? 3 : 2;
        if (con) c.setLineDash([8, 4]);
        c.beginPath(); c.arc(ce.x, ce.y, g.r * view.ppu, -g.t0, -(g.t0 + g.sweep), true); c.stroke();
        c.lineWidth = 1; c.beginPath(); c.moveTo(ce.x - 3, ce.y); c.lineTo(ce.x + 3, ce.y); c.moveTo(ce.x, ce.y - 3); c.lineTo(ce.x, ce.y + 3); c.stroke();
      } else if (ob.type === "ellipse") {
        const ce = pm.get(ob.center); if (!ce || !(ob.rx > 0) || !(ob.ry > 0)) continue;
        const s = ts(ce.x, ce.y), rx = ob.rx * view.ppu, ry = ob.ry * view.ppu;
        if (rx < 0.8 && ry < 0.8) continue;
        c.strokeStyle = isSel ? T.sel : con ? T.ref : free ? FREE_INK : T.ink; c.lineWidth = isSel ? 3 : 2;
        if (con) c.setLineDash([8, 4]);
        c.beginPath(); c.ellipse(s.x, s.y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2); c.stroke();
        c.lineWidth = 1; c.beginPath(); c.moveTo(s.x - 4, s.y); c.lineTo(s.x + 4, s.y); c.moveTo(s.x, s.y - 4); c.lineTo(s.x, s.y + 4); c.stroke();
      } else if (ob.type === "spline") {
        const pts = (ob.pts || []).map(id => pm.get(id)).filter(Boolean).map(p => ts(p.x, p.y));
        if (pts.length < 2) continue;
        c.strokeStyle = isSel ? T.sel : con ? T.ref : free ? FREE_INK : T.ink; c.lineWidth = isSel ? 3 : 2;
        if (con) c.setLineDash([8, 4]);
        c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
          c.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
        }
        if (ob.closed) { // close with the wrap span, not a straight chord
          const p0 = pts[pts.length - 2] || pts[pts.length - 1], p1 = pts[pts.length - 1], p2 = pts[0], p3 = pts[1] || pts[0];
          c.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
          c.closePath();
        }
        c.stroke();
        if (isSel) { c.setLineDash([]); c.fillStyle = T.sel; for (const q of pts) { c.beginPath(); c.arc(q.x, q.y, 3.5, 0, Math.PI * 2); c.fill(); } }
      } else if (ob.type === "stroke") {
        const basePx = ob.w > 0 ? ob.w * view.ppu : (isSel ? 3 : 2);
        c.strokeStyle = isSel ? T.sel : (ob.color || T.ref); // the stroke's own ink (annotations), theme ink otherwise
        c.lineCap = "round"; c.lineJoin = "round";
        if (!ob.k || ob.k.length !== ob.pts.length) {
          c.lineWidth = isSel && !(ob.w > 0) ? 3 : Math.max(0.6, basePx);
          c.beginPath();
          let lx = 0, ly = 0, first = true; // sub-pixel LOD: a dense stroke does not need a point every 0.2 px
          for (const p of ob.pts) {
            const s = ts(p[0], p[1]);
            if (!first && ob.pts.length > 120 && Math.hypot(s.x - lx, s.y - ly) < 0.5) continue;
            if (first) c.moveTo(s.x, s.y); else c.lineTo(s.x, s.y);
            first = false; lx = s.x; ly = s.y;
          }
          if (ob.pts.length === 1) { const s = ts(ob.pts[0][0], ob.pts[0][1]); c.lineTo(s.x + 0.1, s.y); }
          c.stroke();
        } else if (window.HqInk) {
          // pen strokes from the pad: the same smooth, tapered outline the pad and the live preview draw (hq-ink.js)
          c.fillStyle = c.strokeStyle;
          window.HqInk.fill(c, ob.pts.map((p, i) => { const q = ts(p[0], p[1]); return { x: q.x, y: q.y, w: Math.max(0.6, basePx * (ob.k[i] || 1)) }; }));
        } else if (ob.pts.length === 1) {
          const s = ts(ob.pts[0][0], ob.pts[0][1]);
          c.fillStyle = c.strokeStyle; c.beginPath(); c.arc(s.x, s.y, Math.max(0.6, basePx * (ob.k[0] || 1)) / 2, 0, Math.PI * 2); c.fill();
        } else {
          for (let i = 1; i < ob.pts.length; i++) {
            const s0 = ts(ob.pts[i - 1][0], ob.pts[i - 1][1]), s1 = ts(ob.pts[i][0], ob.pts[i][1]);
            c.lineWidth = Math.max(0.6, basePx * (((ob.k[i - 1] || 1) + (ob.k[i] || 1)) / 2));
            c.beginPath(); c.moveTo(s0.x, s0.y); c.lineTo(s1.x, s1.y); c.stroke();
          }
        }
      } else if (ob.type === "text") {
        if (ob.h * view.ppu < 4) continue; // unreadable at this zoom
        const s = ts(ob.x, ob.y);
        c.fillStyle = isSel ? T.sel : T.note; c.font = font(ob.h * view.ppu); c.textBaseline = "alphabetic";
        c.fillText(ob.text, s.x, s.y);
        if (isSel) { const b = S.textBox(ob), p0 = ts(b[0], b[3]), p1 = ts(b[2], b[1]); c.strokeStyle = T.sel; c.lineWidth = 1; c.setLineDash([4, 3]); c.strokeRect(p0.x - 3, p0.y - 3, p1.x - p0.x + 6, p1.y - p0.y + 6); }
      } else if (ob.type === "dim_linear") drawDimLinear(c, ob, ts, view, T, isSel, doc);
      else if (ob.type === "dim_angle") drawDimAngle(c, ob, ts, view, T, isSel);
      else if (S.isRadialDim(ob)) drawDimRadial(c, ob, ts, view, T, isSel, doc);
    }
    c.setLineDash([]);
    // driving constraints (shown, never exported as CAD constraints)
    if (!o.noConstraints) for (const k of doc.constraints) {
      if (GLYPH[k.type]) { geoGlyph(c, doc, k, pm, ts, T); continue; }
      if (k.type === "length") {
        const l = S.getObj(doc, k.line); if (!l) continue;
        const a = pm.get(l.p1), b = pm.get(l.p2), m = ts((a.x + b.x) / 2, (a.y + b.y) / 2);
        const ang = Math.atan2(-(b.y - a.y), b.x - a.x);
        const nx = Math.sin(ang), ny = -Math.cos(ang);
        tag(c, m.x + nx * 14 * FK, m.y + ny * 14 * FK, S.fmt(k.value), T);
      } else {
        const v = pm.get(k.vertex), l1 = S.getObj(doc, k.lines[0]), l2 = S.getObj(doc, k.lines[1]); if (!v || !l1 || !l2) continue;
        const A = pm.get(S.otherEnd(l1, k.vertex)), B = pm.get(S.otherEnd(l2, k.vertex)), V = ts(v.x, v.y);
        let a1 = Math.atan2(-(A.y - v.y), A.x - v.x), a2 = Math.atan2(-(B.y - v.y), B.x - v.x);
        let sw = a2 - a1; while (sw > Math.PI) sw -= 2 * Math.PI; while (sw < -Math.PI) sw += 2 * Math.PI;
        c.strokeStyle = T.accent; c.lineWidth = 1.5; c.beginPath(); c.arc(V.x, V.y, 22 * FK, a1, a1 + sw, sw < 0); c.stroke();
        tag(c, V.x + Math.cos(a1 + sw / 2) * 38 * FK, V.y + Math.sin(a1 + sw / 2) * 38 * FK, S.fmt(k.value, 3) + "°", T);
      }
    }
    // selection handles / fixed endpoint marker
    if (!o.noHandles && o.sel && o.sel.length === 1) {
      const ob = S.getObj(doc, o.sel[0]);
      if (S.isLine(ob)) {
        for (const kk of ["p1", "p2"]) {
          const p = ts(pm.get(ob[kk]).x, pm.get(ob[kk]).y);
          c.fillStyle = T.sel; c.strokeStyle = T.bg; c.lineWidth = 2;
          if (kk === o.fixedEnd) { c.fillRect(p.x - 6, p.y - 6, 12, 12); c.strokeRect(p.x - 6, p.y - 6, 12, 12); }
          else { c.beginPath(); c.arc(p.x, p.y, 6, 0, Math.PI * 2); c.fill(); c.stroke(); }
        }
      }
    }
    if (o.preview) o.preview(c, ts);
    if (!o.noTriad) triad(c, H, T);
    FK = 1;
  }

  function tag(c, x, y, text, T) {
    c.font = `600 ${12 * FK}px system-ui, sans-serif`;
    const w = c.measureText(text).width + 10 * FK;
    c.fillStyle = T.bg; c.strokeStyle = T.accent; c.lineWidth = 1.2;
    c.beginPath(); if (c.roundRect) c.roundRect(x - w / 2, y - 9 * FK, w, 18 * FK, 5); else c.rect(x - w / 2, y - 9 * FK, w, 18 * FK); c.fill(); c.stroke();
    c.fillStyle = T.accent; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(text, x, y + 0.5);
    c.textAlign = "start"; c.textBaseline = "alphabetic";
  }
  function arrow(c, x, y, ang, size) {
    c.beginPath(); c.moveTo(x, y);
    c.lineTo(x - Math.cos(ang - 0.35) * size, y - Math.sin(ang - 0.35) * size);
    c.lineTo(x - Math.cos(ang + 0.35) * size, y - Math.sin(ang + 0.35) * size);
    c.closePath(); c.fill();
  }
  function drawCoteReveal(c, shown, now) {
    if (!anim.cote) return;
    const T = theme(false);
    const ts = (x, y) => S.toScreen(st.view, st.H, x, y);
    for (const ob of shown.objects) {
      const at = anim.cote.get(ob.id);
      if (at == null) continue;
      const k = motionClamp((now - at) / MOTION.COTE);
      if (ob.type === "dim_linear") drawDimLinear(c, ob, ts, st.view, T, false, shown, k);
      else if (ob.type === "dim_angle") drawDimAngle(c, ob, ts, st.view, T, false, k);
      else if (S.isRadialDim(ob)) drawDimRadial(c, ob, ts, st.view, T, false, shown, k);
    }
    c.globalAlpha = 1;
  }
  function drawDimLinear(c, o, ts, view, T, isSel, doc, reveal) {
    const g = S.dimLinearGeom(o); if (!g) return;
    const k = reveal == null ? 1 : motionClamp(reveal);
    const col = isSel ? T.sel : T.dim;
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1.2; c.globalAlpha = 1;
    const A = ts(o.a[0], o.a[1]), B = ts(o.b[0], o.b[1]), A2 = ts(g.a2[0], g.a2[1]), B2 = ts(g.b2[0], g.b2[1]);
    const ext = Math.sign(o.offset || 1) * 6;
    const nsx = -(B2.y - A2.y), nsy = B2.x - A2.x, nl = Math.hypot(nsx, nsy) || 1;
    const sgn = ((A2.x - A.x) * nsx + (A2.y - A.y) * nsy) >= 0 ? 1 : -1;
    const AE = { x: A2.x + nsx / nl * Math.abs(ext) * sgn, y: A2.y + nsy / nl * Math.abs(ext) * sgn };
    const BE = { x: B2.x + nsx / nl * Math.abs(ext) * sgn, y: B2.y + nsy / nl * Math.abs(ext) * sgn };
    // The extension lines grow out of the measured points; the value arrives last.
    c.globalAlpha = Math.min(1, k * 1.8);
    c.beginPath();
    c.moveTo(A.x, A.y); c.lineTo(A.x + (AE.x - A.x) * k, A.y + (AE.y - A.y) * k);
    c.moveTo(B.x, B.y); c.lineTo(B.x + (BE.x - B.x) * k, B.y + (BE.y - B.y) * k);
    c.stroke();
    c.globalAlpha = Math.min(1, Math.max(0, (k - 0.2) / 0.8));
    c.beginPath(); c.moveTo(A2.x, A2.y); c.lineTo(B2.x, B2.y); c.stroke();
    const ang = Math.atan2(B2.y - A2.y, B2.x - A2.x);
    arrow(c, B2.x, B2.y, ang, 9 * FK); arrow(c, A2.x, A2.y, ang + Math.PI, 9 * FK);
    let rot = ang; if (rot > Math.PI / 2 || rot < -Math.PI / 2) rot += Math.PI;
    const label = o.label || S.fmt(g.L);
    const M = ts(g.mid[0], g.mid[1]);
    c.globalAlpha = Math.min(1, Math.max(0, (k - 0.45) / 0.55));
    c.save(); c.translate(M.x, M.y + 3 * (1 - k)); c.rotate(rot);
    c.font = `600 ${13 * FK}px system-ui, sans-serif`; c.textAlign = "center"; c.textBaseline = "bottom";
    c.fillText(label, 0, -3 * FK); c.restore(); c.globalAlpha = 1;
  }
  function drawDimAngle(c, o, ts, view, T, isSel, reveal) {
    const k = reveal == null ? 1 : motionClamp(reveal);
    const col = isSel ? T.sel : T.dim;
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1.2; c.globalAlpha = 1;
    const C = ts(o.c[0], o.c[1]);
    const a1 = Math.atan2(-(o.a[1] - o.c[1]), o.a[0] - o.c[0]), a2 = Math.atan2(-(o.b[1] - o.c[1]), o.b[0] - o.c[0]);
    let sw = a2 - a1; while (sw > Math.PI) sw -= 2 * Math.PI; while (sw < -Math.PI) sw += 2 * Math.PI;
    const r = o.r * view.ppu;
    c.globalAlpha = Math.min(1, k * 1.6);
    c.beginPath(); c.moveTo(C.x, C.y); c.lineTo(C.x + Math.cos(a1) * r * 1.1 * k, C.y + Math.sin(a1) * r * 1.1 * k);
    c.moveTo(C.x, C.y); c.lineTo(C.x + Math.cos(a2) * r * 1.1 * k, C.y + Math.sin(a2) * r * 1.1 * k); c.stroke();
    c.beginPath(); c.arc(C.x, C.y, r, a1, a1 + sw * k, sw < 0); c.stroke();
    const mid = a1 + sw / 2, label = o.label || (S.fmt(S.measureAngle(o.c, o.a, o.b), 2) + "°");
    c.globalAlpha = Math.min(1, Math.max(0, (k - 0.45) / 0.55));
    c.font = `600 ${13 * FK}px system-ui, sans-serif`; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(label, C.x + Math.cos(mid) * (r + 14 * FK), C.y + Math.sin(mid) * (r + 14 * FK) + 3 * (1 - k));
    c.textAlign = "start"; c.textBaseline = "alphabetic"; c.globalAlpha = 1;
  }
  /** Ø / R cote: leader through the centre (diameter) or from it (radius), arrows on the edge, label outside. */
  function drawDimRadial(c, o, ts, view, T, isSel, doc, reveal) {
    const g = S.dimRadialGeom(doc, o); if (!g) return;
    const k = reveal == null ? 1 : motionClamp(reveal);
    const col = isSel ? T.sel : T.dim;
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1.2; c.setLineDash([]); c.globalAlpha = 1;
    const FAR = ts(g.far[0], g.far[1]), EDGE = ts(g.edge[0], g.edge[1]), C = ts(g.c[0], g.c[1]);
    // The leader leaves the centre on both sides at once (a radius: one side), then the label rises in.
    const grow = p => ({ x: C.x + (p.x - C.x) * k, y: C.y + (p.y - C.y) * k });
    const far = grow(FAR), edge = grow(EDGE);
    c.globalAlpha = Math.min(1, k * 1.8);
    c.beginPath(); c.moveTo(far.x, far.y); c.lineTo(edge.x, edge.y); c.stroke();
    if (o.type === "dim_diameter") {
      const back = Math.atan2(FAR.y - EDGE.y, FAR.x - EDGE.x);
      arrow(c, far.x, far.y, back, 8 * FK); arrow(c, edge.x, edge.y, back + Math.PI, 8 * FK);
    } else {
      const back = Math.atan2(C.y - EDGE.y, C.x - EDGE.x);
      arrow(c, edge.x, edge.y, back, 8 * FK);
    }
    const label = S.dimRadialLabel(doc, o);
    const ang = Math.atan2(EDGE.y - C.y, EDGE.x - C.x), off = 16 * FK;
    c.globalAlpha = Math.min(1, Math.max(0, (k - 0.45) / 0.55));
    c.font = `600 ${13 * FK}px system-ui, sans-serif`;
    c.textAlign = Math.cos(ang) >= 0 ? "left" : "right"; c.textBaseline = "middle";
    c.fillText(label, EDGE.x + Math.cos(ang) * off, EDGE.y + Math.sin(ang) * off + 3 * (1 - k));
    c.textAlign = "start"; c.textBaseline = "alphabetic"; c.globalAlpha = 1;
  }
  function triad(c, H, T) {
    const x = 18, y = H - 18, L = 42;
    c.lineWidth = 2; c.setLineDash([]);
    c.strokeStyle = T.axisX; c.fillStyle = T.axisX;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + L, y); c.stroke(); arrow(c, x + L + 4, y, 0, 10);
    c.font = "700 12px system-ui, sans-serif"; c.fillText("X", x + L + 8, y + 4);
    c.strokeStyle = T.axisY; c.fillStyle = T.axisY;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - L); c.stroke(); arrow(c, x, y - L - 4, -Math.PI / 2, 10);
    c.fillText("Y", x - 4, y - L - 14);
  }

  function drawCueDoc(c, doc, ids, tint, alpha) {
    if (!doc || !ids.length) return;
    const T = theme(false); T.sel = tint; T.accent = tint;
    const cull = st.cull;
    c.save(); c.globalAlpha = alpha;
    drawScene(c, doc, st.view, st.W, st.H, T, { noBg: true, noGrid: true, noUnderlay: true, noConstraints: true, noTriad: true, noHandles: true, onlySel: true, sel: ids, preview: function () {} });
    c.restore();
    st.cull = cull;
  }
  /** The selected objects' hardware stays still; only a short halo and corner ticks enter around them. */
  function drawSelectionCue(c, shown, now) {
    const s = anim.sel; if (!s) return;
    const age = now - s.at; if (age < 0 || age >= MOTION.SELECT) return;
    const k = motionClamp(age / MOTION.SELECT), a = 0.55 * (1 - k);
    const T = theme(false), pm = S.pointMap(shown);
    const e = 1 - Math.pow(1 - k, 3);
    c.save(); c.strokeStyle = T.accent; c.fillStyle = T.accent;
    for (const id of s.ids) {
      const ob = S.getObj(shown, id); if (!ob) continue;
      const b = S.objectBox(shown, ob, pm); if (!b) continue;
      const p0 = S.toScreen(st.view, st.H, b[0], b[1]), p1 = S.toScreen(st.view, st.H, b[2], b[3]);
      const x = Math.min(p0.x, p1.x) - 5, y = Math.min(p0.y, p1.y) - 5, w = Math.abs(p1.x - p0.x) + 10, h = Math.abs(p1.y - p0.y) + 10;
      c.globalAlpha = a * 0.45; c.lineWidth = 4; c.strokeRect(x, y, w, h);
      c.globalAlpha = a; c.lineWidth = 1.2; c.setLineDash([5, 4]); c.strokeRect(x, y, w, h); c.setLineDash([]);
      const tick = 2.5 * e + 0.5;
      for (const q of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) c.fillRect(q[0] - tick, q[1] - tick, tick * 2, tick * 2);
    }
    c.restore();
  }
  function drawSnapCue(c, now) {
    const s = anim.snap; if (!s) return;
    const age = now - s.at; if (age < 0 || age >= MOTION.SNAP_IN + MOTION.SNAP_HOLD + MOTION.SNAP_OUT) return;
    const alpha = age < MOTION.SNAP_IN ? age / MOTION.SNAP_IN : age < MOTION.SNAP_IN + MOTION.SNAP_HOLD ? 1 :
      1 - (age - MOTION.SNAP_IN - MOTION.SNAP_HOLD) / MOTION.SNAP_OUT;
    if (!(alpha > 0)) return;
    const p = S.toScreen(st.view, st.H, s.x, s.y), T = theme(false);
    c.save(); c.globalAlpha = alpha; c.strokeStyle = T.accent; c.fillStyle = T.accent; c.lineWidth = 1.8;
    c.beginPath(); c.arc(p.x, p.y, 8 + (1 - alpha) * 3, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(p.x, p.y, 1.8, 0, Math.PI * 2); c.fill();
    // A tiny type badge, kept out of the geometry: point, grid, angle or alignment.
    const bx = p.x + 12, by = p.y - 26;
    c.globalAlpha = alpha * .96; c.fillStyle = T.bg; c.strokeStyle = T.accent; c.lineWidth = 1;
    if (c.roundRect) { c.beginPath(); c.roundRect(bx, by, 15, 15, 4); c.fill(); c.stroke(); }
    else { c.fillRect(bx, by, 15, 15); c.strokeRect(bx, by, 15, 15); }
    c.fillStyle = T.accent; c.strokeStyle = T.accent; c.lineWidth = 1.25;
    if (s.kind === "angle") { c.beginPath(); c.moveTo(bx + 4, by + 11); c.lineTo(bx + 7, by + 4); c.lineTo(bx + 11, by + 11); c.stroke(); }
    else if (s.kind === "grid") { c.beginPath(); c.moveTo(bx + 7.5, by + 3); c.lineTo(bx + 7.5, by + 12); c.moveTo(bx + 3, by + 7.5); c.lineTo(bx + 12, by + 7.5); c.stroke(); }
    else if (s.kind === "align") { c.beginPath(); c.moveTo(bx + 3, by + 7.5); c.lineTo(bx + 12, by + 7.5); c.moveTo(bx + 7.5, by + 3); c.lineTo(bx + 7.5, by + 12); c.stroke(); c.beginPath(); c.arc(bx + 7.5, by + 7.5, 2, 0, Math.PI * 2); c.fill(); }
    else { c.beginPath(); c.arc(bx + 7.5, by + 7.5, 2.8, 0, Math.PI * 2); c.fill(); }
    c.restore();
  }
  function drawMotionCues(c, shown, now) {
    if (anim.cote) drawCoteReveal(c, shown, now);
    if (anim.undo) {
      const u = anim.undo, age = now - u.at, a = age < 0 || age >= MOTION.UNDO ? 0 : .7 * (1 - age / MOTION.UNDO);
      if (a > 0) {
        const tint = theme(false).accent;
        drawCueDoc(c, u.oldDoc, u.oldIds, tint, a);
        drawCueDoc(c, u.newDoc, u.newIds, tint, a);
      }
    }
    if (anim.validate) {
      const v = anim.validate, age = now - v.at, a = age < 0 || age >= MOTION.VALIDATE ? 0 : .75 * (1 - age / MOTION.VALIDATE);
      if (a > 0) drawCueDoc(c, st.doc, v.ids, "#d33a3a", a);
    }
    drawSelectionCue(c, shown, now);
    drawSnapCue(c, now);
  }

  function previewFn() {
    const a = st.action, T = theme(false);
    return (c, ts) => {
      c.setLineDash([]);
      if (a && a.kind === "pen" && a.pts.length) {
        c.strokeStyle = st.inkColor || T.ref; c.lineWidth = Math.max(1.5, Number(st.inkWidth) || 2); c.lineCap = "round"; c.lineJoin = "round";
        c.beginPath(); a.pts.forEach((p, i) => { const s = ts(p[0], p[1]); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); }); c.stroke();
      }
      const hv = st.remoteHover;
      if (hv && !st.remote) {
        const fade = anim.remote ? Math.max(0, 1 - (nowMs() - anim.remote) / MOTION.REMOTE_FADE) : 1;
        if (fade > 0) {
          const h = ts(hv.x, hv.y); c.strokeStyle = T.accent; c.lineWidth = 1.5; c.globalAlpha = 0.8 * fade;
          c.beginPath(); c.arc(h.x, h.y, 7, 0, Math.PI * 2); c.stroke(); c.globalAlpha = 1;
          c.fillStyle = T.accent; c.globalAlpha = fade; c.beginPath(); c.arc(h.x, h.y, 1.8, 0, Math.PI * 2); c.fill(); c.globalAlpha = 1;
        }
      }
      const rip = st.remoteRipple;
      if (rip && !reducedMotion()) {
        const age = nowMs() - rip.at;
        if (age >= 0 && age < 400) {
          const p = ts(rip.x, rip.y), k = age / 400;
          c.save(); c.globalAlpha = 0.45 * (1 - k); c.strokeStyle = T.accent; c.lineWidth = 2;
          c.beginPath(); c.arc(p.x, p.y, 8 + k * 26, 0, Math.PI * 2); c.stroke(); c.restore();
        }
      }
      const rm = st.remote; // a stroke arriving live from the phone pad (hq-desk.js); omitted from snapshots
      if (rm && !rm.erase && rm.pts.length) {
        // drawn exactly as it will be saved (colour, width, outline), so nothing changes when the pen lifts
        c.strokeStyle = T.ref; c.lineCap = "round"; c.lineJoin = "round";
        const box = canvas ? canvas.getBoundingClientRect() : null;
        const short = box ? Math.min(box.width, box.height) : 0;
        if (window.HqInk && rm.wn && rm.wn.length === rm.pts.length && short > 0) {
          c.fillStyle = T.ref;
          window.HqInk.fill(c, rm.pts.map((p, i) => { const q = ts(p[0], p[1]); return { x: q.x, y: q.y, w: Math.max(0.6, (rm.wn[i] || 0.009) * short) }; }));
        } else if (rm.wn && rm.wn.length === rm.pts.length && short > 0 && rm.pts.length > 1) {
          for (let i = 1; i < rm.pts.length; i++) {
            const s0 = ts(rm.pts[i - 1][0], rm.pts[i - 1][1]), s1 = ts(rm.pts[i][0], rm.pts[i][1]);
            c.lineWidth = Math.max(0.8, ((rm.wn[i - 1] || 0.009) + (rm.wn[i] || 0.009)) / 2 * short);
            c.beginPath(); c.moveTo(s0.x, s0.y); c.lineTo(s1.x, s1.y); c.stroke();
          }
        } else {
          c.lineWidth = 2.5;
          c.beginPath(); rm.pts.forEach((p, i) => { const s = ts(p[0], p[1]); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); }); c.stroke();
        }
        const last = ts(rm.pts[rm.pts.length - 1][0], rm.pts[rm.pts.length - 1][1]);
        c.fillStyle = T.accent; c.globalAlpha = 0.35; c.beginPath(); c.arc(last.x, last.y, 9, 0, Math.PI * 2); c.fill(); c.globalAlpha = 1;
      }
      const ring = p => { if (p && p.id) { const s = ts(p.x, p.y); c.strokeStyle = T.accent; c.lineWidth = 2; c.beginPath(); c.arc(s.x, s.y, 9, 0, Math.PI * 2); c.stroke(); } };
      if (a && (a.kind === "line" || a.kind === "centerline" || a.kind === "dimlin")) {
        const s1 = ts(a.a.x, a.a.y), s2 = ts(a.b.x, a.b.y);
        c.strokeStyle = T.accent; c.lineWidth = 2; if (a.kind === "centerline") c.setLineDash([14, 4, 3, 4]); if (a.kind === "dimlin") c.setLineDash([5, 4]);
        c.beginPath(); c.moveTo(s1.x, s1.y); c.lineTo(s2.x, s2.y); c.stroke(); c.setLineDash([]); ring(a.a); ring(a.b);
      }
      if (a && a.kind === "rect") {
        const s1 = ts(a.a.x, a.a.y), s2 = ts(a.b.x, a.b.y);
        c.strokeStyle = T.accent; c.lineWidth = 2; c.strokeRect(Math.min(s1.x, s2.x), Math.min(s1.y, s2.y), Math.abs(s2.x - s1.x), Math.abs(s2.y - s1.y)); ring(a.a);
      }
      if (a && a.kind === "box" && a.b) {
        const s1 = ts(a.a.x, a.a.y), s2 = ts(a.b.x, a.b.y);
        c.save(); c.strokeStyle = T.accent; c.fillStyle = "rgba(61,140,255,.08)"; c.lineWidth = 1; c.setLineDash([5, 4]);
        c.fillRect(Math.min(s1.x, s2.x), Math.min(s1.y, s2.y), Math.abs(s2.x - s1.x), Math.abs(s2.y - s1.y));
        c.strokeRect(Math.min(s1.x, s2.x), Math.min(s1.y, s2.y), Math.abs(s2.x - s1.x), Math.abs(s2.y - s1.y)); c.restore();
      }
      if (st.guides && a && a.kind !== "box") {
        c.save(); c.strokeStyle = "rgba(47,111,214,.75)"; c.lineWidth = 1; c.setLineDash([3, 5]);
        if (st.guides.x != null) { const g = ts(st.guides.x, 0); c.beginPath(); c.moveTo(g.x, 0); c.lineTo(g.x, st.H); c.stroke(); }
        if (st.guides.y != null) { const g = ts(0, st.guides.y); c.beginPath(); c.moveTo(0, g.y); c.lineTo(st.W, g.y); c.stroke(); }
        c.restore();
      }
      if (a && a.kind === "arc" && a.b) {
        const s0 = ts(a.a.x, a.a.y); c.strokeStyle = T.accent; c.lineWidth = 1.5; c.setLineDash([6, 4]);
        c.beginPath(); c.arc(s0.x, s0.y, Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) * st.view.ppu, 0, Math.PI * 2); c.stroke(); c.setLineDash([]); ring(a.a);
      }
      if (st.arcPending && st.arcHover) {
        const P = st.arcPending, cc = ts(P.c.x, P.c.y), r = Math.hypot(P.s.x - P.c.x, P.s.y - P.c.y);
        const t0 = Math.atan2(P.s.y - P.c.y, P.s.x - P.c.x), t1 = Math.atan2(st.arcHover.y - P.c.y, st.arcHover.x - P.c.x);
        c.strokeStyle = T.accent; c.lineWidth = 2;
        c.beginPath(); c.arc(cc.x, cc.y, r * st.view.ppu, -t0, -t1, true); c.stroke();
      }
      if (a && a.kind === "circle" && a.r) {
        const s = ts(a.a.x, a.a.y); c.strokeStyle = T.accent; c.lineWidth = 2; c.beginPath(); c.arc(s.x, s.y, a.r * st.view.ppu, 0, Math.PI * 2); c.stroke(); ring(a.a);
      }
      const stadium = (A, B, r) => {
        const L = Math.hypot(B.x - A.x, B.y - A.y); if (!(L > 0.5) || !(r > 0.5)) return;
        const ang = Math.atan2(B.y - A.y, B.x - A.x), nx = -Math.sin(ang), ny = Math.cos(ang);
        c.beginPath(); c.moveTo(A.x + nx * r, A.y + ny * r); c.lineTo(B.x + nx * r, B.y + ny * r);
        c.moveTo(A.x - nx * r, A.y - ny * r); c.lineTo(B.x - nx * r, B.y - ny * r); c.stroke();
        c.beginPath(); c.arc(A.x, A.y, r, ang + Math.PI / 2, ang + Math.PI * 1.5); c.stroke();
        c.beginPath(); c.arc(B.x, B.y, r, ang - Math.PI / 2, ang + Math.PI / 2); c.stroke();
      };
      if (a && a.kind === "slot" && a.b) {
        c.strokeStyle = T.accent; c.lineWidth = 2; c.setLineDash([6, 4]);
        const A = ts(a.a.x, a.a.y), B = ts(a.b.x, a.b.y);
        c.beginPath(); c.moveTo(A.x, A.y); c.lineTo(B.x, B.y); c.stroke(); c.setLineDash([]);
        ring(a.a); ring(a.b);
      }
      if (st.slotPending && st.lastPointer) {
        const P = st.slotPending, A = ts(P.a.x, P.a.y), B = ts(P.b.x, P.b.y), M = ts(st.lastPointer.x, st.lastPointer.y);
        const Lm = Math.hypot(P.b.x - P.a.x, P.b.y - P.a.y), r = Lm > 1e-9 ? Math.abs((st.lastPointer.x - P.a.x) * (P.b.y - P.a.y) - (st.lastPointer.y - P.a.y) * (P.b.x - P.a.x)) / Lm : 0;
        c.strokeStyle = T.accent; c.lineWidth = 2; stadium(A, B, r * st.view.ppu);
        c.fillStyle = T.accent; c.beginPath(); c.arc(M.x, M.y, 4, 0, Math.PI * 2); c.fill();
      }
      if (a && a.kind === "ellipse" && a.b) {
        const A = ts(a.a.x, a.a.y), B = ts(a.b.x, a.b.y), rx = Math.abs(B.x - A.x), ry = Math.abs(B.y - A.y);
        c.strokeStyle = T.accent; c.lineWidth = 2;
        c.beginPath(); c.ellipse(A.x, A.y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2); c.stroke();
        c.setLineDash([5, 4]); c.lineWidth = 1; c.strokeRect(Math.min(A.x, B.x), Math.min(A.y, B.y), Math.abs(B.x - A.x), Math.abs(B.y - A.y)); c.setLineDash([]); ring(a.a);
      }
      if (a && a.kind === "polygon" && a.b) {
        const A = ts(a.a.x, a.a.y), B = ts(a.b.x, a.b.y), n = Math.max(3, Math.min(12, Math.round(Number(st.polySides) || 6)));
        const a0 = Math.atan2(B.y - A.y, B.x - A.x), R = Math.hypot(B.x - A.x, B.y - A.y);
        c.strokeStyle = T.accent; c.lineWidth = 2; c.beginPath();
        for (let i = 0; i < n; i++) { const t = a0 + i * Math.PI * 2 / n; const q = { x: A.x + R * Math.cos(t), y: A.y + R * Math.sin(t) }; if (i) c.lineTo(q.x, q.y); else c.moveTo(q.x, q.y); }
        c.closePath(); c.stroke(); ring(a.a);
      }
      if (st.tool === "spline" && st.splinePts.length) {
        const pts = st.splinePts.map(p => ts(p.x, p.y));
        if (st.lastPointer && !st.action) pts.push(ts(st.lastPointer.x, st.lastPointer.y));
        c.strokeStyle = T.accent; c.lineWidth = 2;
        c.beginPath(); pts.forEach((q, i) => { if (i) c.lineTo(q.x, q.y); else c.moveTo(q.x, q.y); }); c.stroke();
        c.fillStyle = T.accent;
        for (const q of pts) { c.beginPath(); c.arc(q.x, q.y, 3.5, 0, Math.PI * 2); c.fill(); }
        c.beginPath(); c.arc(pts[0].x, pts[0].y, 7, 0, Math.PI * 2); c.strokeStyle = T.accent; c.lineWidth = 1; c.stroke();
      }
      if (st.tool === "dimang") st.angleTaps.forEach((p, i) => { const s = ts(p.x, p.y); c.fillStyle = T.accent; c.beginPath(); c.arc(s.x, s.y, 5, 0, Math.PI * 2); c.fill(); c.fillText(String(i + 1), s.x + 8, s.y - 8); });
    };
  }

  /** At most one redraw per frame for live input (the pad can deliver many points per frame). */
  function drawSoon(previewDoc) {
    if (previewDoc !== undefined) st.drawArg = previewDoc;
    if (st.drawRaf) return;
    st.drawRaf = requestAnimationFrame(() => {
      st.drawRaf = 0;
      const pending = st.drawArg; st.drawArg = undefined;
      draw(pending);
    });
  }
  function nowMs() { return window.performance && performance.now ? performance.now() : Date.now(); }
  function themeKey() {
    const b = document.body;
    return String((b && b.dataset && (b.dataset.theme || b.dataset.mode)) || "") + (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "d" : "l");
  }
  /** The static layer: background, underlay, grid, objects, constraints. Repainted only when the document, the view,
   * the size, the theme or the active sketch change — never for a hover, a selection or a pen stroke. */
  function drawBase(shown) {
    if (!baseCtx) return false;
    const coteKey = anim.cote ? "|cote:" + [...anim.cote.keys()].sort().join(",") : "";
    const key = [st.docRev, st.W, st.H, st.dpr, st.view.ppu, st.view.x0, st.view.y0, st.sketch, themeKey()].join("|") + coteKey;
    if (key === st.baseKey) return false;
    st.baseKey = key;
    baseCtx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    drawScene(baseCtx, shown, st.view, st.W, st.H, theme(false), { defined: definedSet(shown), noHandles: true, skipDims: anim.cote });
    st.drawnBase = st.cull ? st.cull.drawn : shown.objects.length;
    return true;
  }
  function perfFrame(shown, t0) {
    let pts = 0;
    for (const o of shown.objects) if (o.type === "stroke" && o.pts) pts += o.pts.length;
    st.perf.push({ ms: nowMs() - t0, objects: shown.objects.length, pts: pts,
      drawn: st.drawnBase == null ? shown.objects.length : st.drawnBase });
    if (st.perf.length > 240) st.perf.splice(0, st.perf.length - 240);
  }
  function syncEmpty2d(shown) {
    if (!empty2d) return;
    const empty = !shown.objects.length && !(shown.points || []).length && !(st.doc && st.doc.underlay) && !st.action;
    // CSS owns the 160 ms fade; reduced motion turns the transition off. No hidden attribute, so the
    // layer can fade back when the last object is undone.
    empty2d.classList.toggle("is-gone", !empty);
    empty2d.setAttribute("aria-hidden", empty ? "false" : "true");
  }
  /** A selection change is a state transition: arm its one-shot halo once, never on each redraw. */
  function syncSelectionCue() {
    const key = st.sel.slice().sort().join("|");
    if (key === st.selKey) return;
    st.selKey = key;
    anim.sel = key && motionAllowed() ? { ids: st.sel.slice(), at: nowMs() } : null;
    if (anim.sel) motionSchedule();
  }
  function draw(previewDoc) {
    if (!ctx || !st.doc || !st.W) return;
    if (st.drawRaf) { cancelAnimationFrame(st.drawRaf); st.drawRaf = 0; st.drawArg = undefined; } // this frame wins
    const t0 = nowMs();
    const shown = S.visibleView(previewDoc || st.doc, st.sketch); // active sketch + every other visible one
    syncSelectionCue();
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    const hideDims = anim.cote;
    if (!baseCtx) {
      // no static layer in the markup (an older cached HTML): one canvas has to carry the whole drawing
      drawScene(ctx, shown, st.view, st.W, st.H, theme(false), { defined: definedSet(shown), noHandles: true, skipDims: hideDims });
    } else {
      drawBase(shown);
      ctx.clearRect(0, 0, st.W, st.H);
    }
    drawScene(ctx, shown, st.view, st.W, st.H, theme(false), {
      noBg: true, noGrid: true, noUnderlay: true, noConstraints: true, noTriad: true,
      sel: st.sel, onlySel: true, fixedEnd: st.fixedEnd, preview: previewFn(), defined: definedSet(previewDoc || st.doc), skipDims: hideDims,
    });
    drawFaceRef(); drawLiveCursors(); updateFloat(); syncEmpty2d(shown);
    perfFrame(shown, t0);
    drawMotionCues(ctx, shown, nowMs());
    if (!st.action) setHud();
  }
  /** One frame through the real draw path, for the harness and for scripts (returns the frame it just measured). */
  window.hqDessinerDraw = function () { draw(); return st.perf[st.perf.length - 1] || null; };
  /** The measured render path, for the diagnostics HUD and for scripts: JS ms per frame and the drawing's size. */
  window.hqDessinerMotionState = function () {
    return { calm: !motionAllowed(), active: motionActive(), snap: anim.snap && anim.snap.kind, snapKey: st.snapKey, selKey: st.selKey,
      selection: !!anim.sel, cote: !!anim.cote, undo: !!anim.undo, validate: !!anim.validate, fit: !!anim.fit, remoteFade: !!anim.remote, remoteFadeAt: anim.remote };
  };
  window.hqDessinerPerf = function () {
    const s = S.perfStats(st.perf.map(f => f.ms)), last = st.perf[st.perf.length - 1] || { objects: 0, pts: 0, drawn: 0 };
    return { frames: s.n, median: s.median, p95: s.p95, max: s.max, objects: last.objects, drawn: last.drawn,
      strokePoints: last.pts, budget: S.DRAW_BUDGET, withinBudget: S.budgetOk(s, last.objects) };
  };

  /** The canvas takes the height the page has left under the tool rows, measured here rather than assumed: the old
   *  fixed offset left the bottom 57 px past the fold on 1366×768 once the tool rows wrapped. */
  function fitStage() {
    if (!root) return;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const stage = [$(".sk-stage", root), $(".sk-3d-stage", root)].filter(el => el && el.getClientRects().length)[0];
    if (!stage) return; // other view or hidden panel: nothing to measure
    if (window.matchMedia && !window.matchMedia("(min-width: 900px)").matches) { root.style.removeProperty("--sk-fit"); return; }
    const top = stage.getBoundingClientRect().top + (window.scrollY || 0);
    const room = Math.round(vh - top - 8); // 8 px of air under the canvas
    if (room > 0) root.style.setProperty("--sk-fit", room + "px");
  }
  function resize() {
    cancelFit();
    fitStage();
    const stage = $(".sk-stage", root);
    if (!stage) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    st.dpr = Math.min(3, window.devicePixelRatio || 1);
    if (W !== st.W || H !== st.H) {
      canvas.width = Math.round(W * st.dpr); canvas.height = Math.round(H * st.dpr);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      if (baseCanvas) { baseCanvas.width = canvas.width; baseCanvas.height = canvas.height; baseCanvas.style.width = W + "px"; baseCanvas.style.height = H + "px"; }
      st.baseKey = "";
      st.W = W; st.H = H;
      if (!st.view) st.view = st.doc.view && st.doc.view.ppu > 0 ? Object.assign({}, st.doc.view) : initialView();
      notePicture();
    }
    draw();
  }
  function initialView() {
    // origin near the bottom-left, like the axis triad
    const g = st.doc.grid.spacing;
    if (st.doc.objects.length) return S.fitView(st.doc, st.W, st.H, 40);
    const ppu = Math.max(minPpu(), Math.min(maxPpu(), 28 / g));
    return { x0: -70 / ppu, y0: -70 / ppu, ppu: ppu };
  }

  // ------------------------------------------------------------ export PNG
  function renderPng(title) {
    const e = S.extentsWith(st.doc, underlayRect());
    const maxSide = 1800, margin = 60, footer = 72;
    let W = 1200, H = 800, view;
    if (e) {
      const w = Math.max(e.x1 - e.x0, st.doc.grid.spacing), h = Math.max(e.y1 - e.y0, st.doc.grid.spacing);
      const ppu = Math.min((maxSide - 2 * margin) / w, (maxSide - 2 * margin) / h);
      W = Math.max(600, Math.ceil(w * ppu + 2 * margin)); H = Math.max(400, Math.ceil(h * ppu + 2 * margin + footer));
      // drawing area is [0, H - footer]; center the extents in it
      view = { x0: (e.x0 + e.x1) / 2 - W / 2 / ppu, y0: (e.y0 + e.y1) / 2 - (H + footer) / 2 / ppu, ppu: ppu };
    } else view = { x0: -st.doc.grid.spacing * 2, y0: -st.doc.grid.spacing * 2, ppu: 28 / st.doc.grid.spacing };
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const c = cv.getContext("2d"), T = theme(true);
    const k = Math.max(1, Math.min(2.2, Math.max(W, H) / 900));
    drawScene(c, st.doc, view, W, H, T, { noConstraints: false, noTriad: true, k: k });
    // scale bar + title block (real-world units)
    const u = st.doc.units;
    let bar = st.doc.grid.spacing; while (bar * view.ppu < 120) bar *= (String(bar).startsWith("2") ? 2.5 : 2); while (bar * view.ppu > 360) bar /= 2;
    const bx = 110, by = H - 20;
    c.fillStyle = "#ffffff"; c.fillRect(0, H - footer, W, footer);
    c.strokeStyle = T.ink; c.fillStyle = T.ink; c.lineWidth = 2;
    c.beginPath(); c.moveTo(bx, by); c.lineTo(bx + bar * view.ppu, by); c.moveTo(bx, by - 6); c.lineTo(bx, by + 6); c.moveTo(bx + bar * view.ppu, by - 6); c.lineTo(bx + bar * view.ppu, by + 6); c.stroke();
    c.font = "15px system-ui, sans-serif"; c.fillText(S.fmt(bar) + " " + u, bx + bar * view.ppu + 8, by + 5);
    const label = (title || st.name || "croquis") + " · unités " + u + " · grille " + S.fmt(st.doc.grid.spacing) + " " + u + " · Y vers le haut";
    c.textAlign = "right"; c.fillText(label, W - 14, by + 5); c.textAlign = "start";
    triad(c, H - 2, T); // axis triad lives in the footer, never over the geometry
    return cv.toDataURL("image/png");
  }

  // ------------------------------------------------------------ save / open
  function openSave() {
    const dlg = $("#sk-save-dlg", root), inp = $("#sk-save-name", root);
    if (dlg.open) { inp.focus(); return; }
    inp.value = st.name || "";
    updateSavePreview();
    if (dlg.showModal) dlg.showModal(); else doSave(window.prompt("Nom du dessin", st.name || "croquis"));
    setTimeout(() => inp.focus(), 30);
  }
  function previewStem(name) {
    let t = String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-_.]+|[-_.]+$/g, "").slice(0, 60);
    return (t || "croquis") + (sourceHint() === "mobile" ? "_HQWeb-Mobile" : "_HQWeb-Desktop");
  }
  function updateSavePreview() {
    const stem = previewStem($("#sk-save-name", root).value);
    $("#sk-save-preview", root).textContent = "→ Inbox/Drawings/" + stem + " (.hqdraw.json, .png, .dxf" + ((st.doc.features || []).length || (st.doc.faceFeatures || []).length ? ", .stl" : "") + "). Un suffixe -2, -3… est ajouté si le nom existe déjà. Source estimée d'après le type de pointeur et la taille d'écran.";
  }
  async function doSave(name) {
    if (name == null) return false;
    const btn = root.querySelector('[data-act="save"]');
    btn.disabled = true; btn.textContent = "Envoi…";
    try {
      st.doc.view = st.view;
      const png = renderPng(String(name).trim().slice(0, 60));
      const send = base => {
        const body = JSON.stringify(Object.assign({ name: String(name).slice(0, 120), source: sourceHint(), doc: st.doc, png: png }, base ? { base: base } : {}));
        if (body.length > 6 * 1024 * 1024) throw new Error("Dessin trop volumineux pour l'envoi");
        return window.api("/api/drawings", { method: "POST", headers: { "Content-Type": "application/json" }, body: body, timeoutMs: 45000 });
      };
      // Phase 3: a save is ALWAYS a new immutable stem; the stem we started from is recorded as its parent (lineage only, never overwritten).
      let res;
      try { res = await send(st.stem); }
      catch (e) {
        if (st.stem && /Version précédente/.test(String(e && e.message))) res = await send(""); // the parent was removed meanwhile: save without lineage
        else throw e;
      }
      const prevStem = st.stem;
      st.stem = res.stem; st.name = String(name).trim() || "croquis"; st.dirty = false; st.draftFailed = false; st.savedObjects = st.doc.objects.length; flushDraft(); updateButtons();
      liveStart();
      clearServerDraft(prevStem);
      say("Enregistré : " + res.stem);
      skMotion("save");
      showSaved(res);
      if (st.link && st.link.onSaved) { try { st.link.onSaved({ stem: res.stem, parent: res.parent || "" }); } catch (_) {} }
      return true;
    } catch (e) { say("Échec de l'enregistrement : " + e.message, "err"); return false; }
    finally { btn.disabled = false; btn.textContent = "Enregistrer"; }
  }
  function fileUrl(stem, kind) { return "/api/drawings/file?stem=" + encodeURIComponent(stem) + "&kind=" + kind; }
  function showSaved(res) {
    props.innerHTML = `<div class="sk-prop-head"><strong>Enregistré</strong> · Inbox/Drawings/${esc(res.stem)}</div>
      <div class="sk-row"><a class="sk-link" href="${fileUrl(res.stem, "pdf")}" target="_blank" rel="noopener">Fiche d'atelier (PDF)</a><a class="sk-link" href="${fileUrl(res.stem, "dxf")}" download>DXF (SolidWorks)</a>${res.files.stl ? `<a class="sk-link" href="${fileUrl(res.stem, "stl")}" download>STL 3D (mm)</a>` : ""}<a class="sk-link" href="${fileUrl(res.stem, "png")}" target="_blank" rel="noopener">PNG</a><a class="sk-link" href="${fileUrl(res.stem, "json")}" download>Document</a></div>`;
  }
  // ---- library: search, sort and delete without leaving the dialog
  const LIB = { items: [] };
  function libSorted(items, how) {
    const out = items.slice();
    if (how === "name") out.sort((a, b) => String(a.stem).localeCompare(String(b.stem), "fr"));
    else if (how === "old") out.sort((a, b) => a.mtime - b.mtime);
    else out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }
  function renderList() {
    const dlg = $("#sk-open-dlg", root);
    if (!dlg || !dlg.open) return;
    const list = $(".sk-list", dlg);
    const q = String(($("#sk-lib-search", root) || {}).value || "").trim().toLowerCase();
    const how = ($("#sk-lib-sort", root) || {}).value || "recent";
    const shown = libSorted(LIB.items.filter(it => !q || String(it.stem).toLowerCase().includes(q) || String(it.root || "").toLowerCase() === q), how);
    const count = $(".sk-lib-count", dlg);
    if (count) count.textContent = LIB.items.length ? (q ? shown.length + " sur " + LIB.items.length + " dessin(s)" : LIB.items.length + " dessin(s)") : "";
    if (!LIB.items.length) { list.innerHTML = '<p class="hint">Aucun dessin dans Inbox/Drawings.</p>'; return; }
    if (!shown.length) { list.innerHTML = '<p class="hint">Aucun dessin ne correspond à « ' + esc(q) + ' ».</p>'; return; }
    list.innerHTML = shown.map(it => `<div class="sk-item">
        ${it.png ? `<img alt="" loading="lazy" decoding="async" width="84" height="60" src="${esc(fileUrl(it.stem, "png"))}"/>` : '<div class="sk-noimg"></div>'}
        <div class="sk-item-body"><strong>${esc(it.stem)}</strong><span class="hint">${esc(new Date(it.mtime * 1000).toLocaleString("fr-CA"))}${it.source ? " · " + esc(it.source) : ""}${it.parent ? ` · <span class="sk-lineage" title="Copie d'un dessin sauvegardé">version de ${esc(it.root || it.parent)}</span>` : ""}</span>
        <div class="sk-row"><button type="button" data-open="${esc(it.stem)}">Ouvrir</button>${it.parent || it.root ? `<button type="button" class="secondary sk-cmp" data-cmp="${esc(it.stem)}" title="Compter les objets et voir les deux images">Comparer</button>` : ""}${it.versions ? `<button type="button" class="sk-link sk-family" data-family="${esc(it.root)}" title="Ne garder que cette famille">${it.versions} versions</button>` : ""}${it.dxf ? `<a class="sk-link" href="${esc(fileUrl(it.stem, "dxf"))}" download>DXF</a>` : ""}${it.png ? `<a class="sk-link" href="${esc(fileUrl(it.stem, "pdf"))}" target="_blank" rel="noopener" title="Fiche d'atelier A4 : dessin, échelle, date">PDF</a>` : ""}${it.stl ? `<a class="sk-link" href="${esc(fileUrl(it.stem, "stl"))}" download>STL</a>` : ""}<button type="button" class="secondary sk-dup" data-dup="${esc(it.stem)}">Dupliquer</button><button type="button" class="secondary sk-del" data-del="${esc(it.stem)}">Supprimer</button></div></div></div>`).join("");
    list.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => { dlg.close(); reopen(b.dataset.open); }));
    list.querySelectorAll("[data-cmp]").forEach(b => b.addEventListener("click", () => compareSaved(b.dataset.cmp)));
    list.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => removeSaved(b.dataset.del, b)));
    list.querySelectorAll("[data-dup]").forEach(b => b.addEventListener("click", () => duplicateSaved(b.dataset.dup, b)));
    list.querySelectorAll("[data-family]").forEach(b => b.addEventListener("click", () => {
      const box = $("#sk-lib-search", root);
      if (!box) return;
      box.value = b.dataset.family; // the family root also matches every copy (see the filter above)
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }));
  }
  async function duplicateSaved(stem, btn) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(String(stem || ""))) return;
    if (btn) btn.disabled = true;
    try {
      const res = await window.api("/api/drawings/duplicate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stem: stem }), timeoutMs: 30000 });
      const src = LIB.items.find(x => x.stem === stem);
      const root = (src && (src.root || src.stem)) || stem;
      if (src) src.root = root;
      LIB.items.push({ stem: res.stem, mtime: res.mtime || Math.floor(Date.now() / 1000), png: true, source: src ? src.source : "desktop", name: res.name, parent: stem, root: root });
      const fam = LIB.items.filter(x => x.root === root); // the new copy joins its family without another listing
      fam.forEach(x => { x.versions = fam.length; });
      renderList();
      say("Copie créée : " + res.stem);
    } catch (e) {
      say((e && e.message) || "Duplication impossible", "err");
    } finally { if (btn) btn.disabled = false; }
  }
  async function removeSaved(stem, btn) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(String(stem || ""))) return;
    if (!window.confirm("Supprimer définitivement « " + stem + " » (document, PNG, DXF, STL) ?")) return;
    if (btn) btn.disabled = true;
    try {
      await window.api("/api/drawings/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stem: stem }), timeoutMs: 20000 });
      LIB.items = LIB.items.filter(it => it.stem !== stem);
      if (st.stem === stem) { st.stem = ""; st.dirty = true; } // the open drawing lost its saved version: save it again
      renderList(); updateButtons();
      say("Dessin supprimé : " + stem);
    } catch (e) {
      say((e && e.message) || "Suppression impossible", "err");
      if (btn) btn.disabled = false;
    }
  }
  async function openList() {
    const dlg = $("#sk-open-dlg", root), list = $(".sk-list", dlg);
    if (dlg.open) { const s = $("#sk-lib-search", root); if (s) s.focus(); return; }
    list.innerHTML = '<p class="hint">Chargement…</p>';
    if (dlg.showModal) dlg.showModal();
    try {
      const res = await window.api("/api/drawings");
      LIB.items = Array.isArray(res.items) ? res.items : [];
      renderList();
    } catch (e) { list.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
  }
  const VALID_LABEL = {
    "object.point": "Points manquants", "point.sketch": "Points d'une esquisse disparue",
    "object.sketch": "Objets d'une esquisse disparue", "constraint.ref": "Contraintes dans le vide",
    "line.zero": "Lignes de longueur nulle", "arc.degenerate": "Arcs dégénérés", "circle.degenerate": "Cercles sans rayon",
    "sketch.face": "Esquisses sur une face disparue", "feature.ref": "Fonctions 3D dans le vide", "feature.source": "Répétitions sans source",
    "dim.item": "Cotes sans cercle",
  };
  function startValidateCue(issues) {
    if (!motionAllowed()) return;
    const ids = [...new Set((issues || []).map(it => it.id).filter(id => id && S.getObj(st.doc, id)))];
    if (!ids.length) { anim.validate = null; return; }
    anim.validate = { ids: ids, at: nowMs() };
    motionSchedule();
  }
  /** « Valider le dessin »: lists what is broken in the document on screen. Read-only by design — S.diagnose never
   * returns a document, so nothing here can repair, delete or move anything. */
  function openValidate() {
    const dlg = $("#sk-validate-dlg", root);
    if (!dlg) return;
    const rep = S.diagnose(st.doc);
    startValidateCue(rep.issues);
    const sum = $(".sk-validate-summary", dlg), list = $(".sk-validate-list", dlg);
    const counts = new Map();
    for (const it of rep.issues) counts.set(it.kind, (counts.get(it.kind) || 0) + 1);
    if (sum) {
      sum.classList.toggle("is-ok", rep.ok);
      sum.classList.toggle("is-bad", !rep.ok);
      sum.textContent = rep.ok
        ? "Aucun problème détecté : références et formes tiennent."
        : rep.total + " problème(s) · " + [...counts.entries()].map(([k, n]) => (VALID_LABEL[k] || k) + " : " + n).join(" · ");
    }
    if (list) {
      const shown = rep.issues.slice(0, 200);
      list.innerHTML = shown.map(it => `<li><code>${esc(it.id)}</code> ${esc(it.message)}</li>`).join("")
        + (rep.issues.length > shown.length ? `<li class="hint">… et ${rep.issues.length - shown.length} autre(s)</li>` : "");
    }
    if (!dlg.open) dlg.showModal();
  }
  /** « Réparer »: applies S.repair through commit(), so Annuler brings the drawing back exactly as it was. */
  function repairDoc() {
    const res = S.repair(st.doc);
    if (!res.actions.length) {
      say(res.ok ? "Rien à réparer" : "Rien de réparable automatiquement : " + res.error, res.ok ? "" : "err");
      openValidate();
      return;
    }
    commit(res.doc);
    say(res.actions.length + " réparation(s)" + (res.ok ? "" : " · reste : " + res.error) + " · Annuler pour revenir", res.ok ? "" : "err");
    openValidate();
  }

  /** DXF import: the file is parsed in the browser, then lands in a new sketch of the current drawing. */
  async function importDxfFile(file) {
    if (!file) return;
    try {
      const parsed = S.parseDXF(await file.text());
      const unit = parsed.units && S.UNIT_MM[parsed.units] ? parsed.units : st.doc.units;
      const res = S.importDXF(st.doc, parsed, { name: String(file.name || "DXF").replace(/\.dxf$/i, "").slice(0, 40), units: unit });
      if (!res.ok) { say(res.error, "err"); return; }
      commit(res.doc);
      if (res.sketch) setSketch(res.sketch);
      st.view = S.fitView(st.doc, st.W, st.H, 40);
      const dlg = $("#sk-open-dlg", root); if (dlg && dlg.open) dlg.close();
      refreshAll();
      say("DXF importé : " + res.added + " objet(s)" + (res.skipped ? " · " + res.skipped + " entité(s) ignorée(s)" : ""));
    } catch (e) { say((e && e.message) || "DXF illisible", "err"); }
    finally { const box = $("#sk-dxf-file", root); if (box) box.value = ""; }
  }

  /** « Comparer à l'origine »: the stored lineage (parent) against this copy, in numbers and in images. */
  async function compareSaved(stem) {
    const row = LIB.items.find(x => x.stem === stem), parent = row && (row.parent || row.root);
    const dlg = $("#sk-compare-dlg", root);
    if (!parent || !dlg) return;
    const body = $(".sk-cmp-body", dlg), title = $("#sk-compare-title", dlg);
    if (title) title.textContent = "« " + stem + " » / « " + parent + " »";
    if (!dlg.open) dlg.showModal();
    body.innerHTML = '<p class="hint">Comparaison…</p>';
    const load = async s => { const r = await window.api("/api/drawings/open?stem=" + encodeURIComponent(s)); const d = r.doc || {}; delete d.meta; return d; };
    try {
      const a = await load(parent), b = await load(stem);
      const idsA = new Set((a.objects || []).map(o => o.id)), idsB = new Set((b.objects || []).map(o => o.id));
      const added = [...idsB].filter(id => !idsA.has(id)), removed = [...idsA].filter(id => !idsB.has(id));
      const ea = S.extents(a), eb = S.extents(b);
      const size = e => e ? S.fmt(e.x1 - e.x0) + " × " + S.fmt(e.y1 - e.y0) : "—";
      const delta = (p, q) => (p && q) ? (q.x1 - q.x0 - (p.x1 - p.x0) >= 0 ? "+" : "") + S.fmt(q.x1 - q.x0 - (p.x1 - p.x0)) + " × " +
        (q.y1 - q.y0 - (p.y1 - p.y0) >= 0 ? "+" : "") + S.fmt(q.y1 - q.y0 - (p.y1 - p.y0)) : "—";
      const u = esc(b.units || a.units || "");
      const count = k => [(a[k] || []).length, (b[k] || []).length];
      const rowHtml = (label, k) => { const c = count(k); return `<tr><th>${label}</th><td>${c[0]}</td><td>${c[1]}</td></tr>`; };
      body.innerHTML = `<div class="sk-cmp-grid">
          <figure><img alt="" loading="lazy" src="${esc(fileUrl(parent, "png"))}"/><figcaption>${esc(parent)} · ${esc(size(ea))} ${u}</figcaption></figure>
          <figure><img alt="" loading="lazy" src="${esc(fileUrl(stem, "png"))}"/><figcaption>${esc(stem)} · ${esc(size(eb))} ${u}</figcaption></figure>
        </div>
        <table class="sk-cmp-tab"><tbody>
          ${rowHtml("Objets", "objects")}${rowHtml("Points", "points")}${rowHtml("Contraintes", "constraints")}${rowHtml("Fonctions 3D", "features")}
          <tr><th>Objets + / −</th><td colspan="2">+${added.length} / −${removed.length}${added.length ? " · ajoutés " + esc(added.slice(0, 8).join(", ")) : ""}${removed.length ? " · retirés " + esc(removed.slice(0, 8).join(", ")) : ""}</td></tr>
          <tr><th>Encombrement</th><td>${esc(size(ea))} ${u}</td><td>${esc(size(eb))} ${u} · Δ ${esc(delta(ea, eb))}</td></tr>
        </tbody></table>`;
    } catch (e) { body.innerHTML = `<p class="hint">${esc((e && e.message) || "Comparaison impossible")}</p>`; }
  }
  async function reopen(stem) {
    if (st.dirty && st.doc.objects.length && !window.confirm("Remplacer le dessin en cours (non enregistré) ? Le brouillon actuel sera perdu.")) return false;
    try {
      const res = await window.api("/api/drawings/open?stem=" + encodeURIComponent(stem));
      const doc = res.doc; const meta = doc.meta || {}; delete doc.meta;
      const ok = S.validateDoc(doc); if (!ok.ok) throw new Error(ok.error);
      setDoc(doc); st.hist.clear(); st.sel = []; st.stem = stem; st.name = meta.name || stem; st.dirty = false; st.savedObjects = doc.objects.length;
      liveStart();
      st.meshVersion++;
      st.view = doc.view && doc.view.ppu > 0 ? Object.assign({}, doc.view) : S.fitView(doc, st.W, st.H);
      UL.fitOnLoad = !!doc.underlay && !(doc.view && doc.view.ppu > 0);
      flushDraft(); refreshAll();
      say("Ouvert : " + stem);
      return true;
    } catch (e) { say("Ouverture impossible : " + e.message, "err"); return false; }
  }

  // ------------------------------------------------------------ Phase 3: exact entry points for the caller (Carnet)
  // Identity is the stem, nothing else: no name guessing, no « latest drawing ». Each returns {ok, error?}. A link (return bar + saved
  // callback) is installed only after the drawing is actually in the editor.
  async function openExact(stem, opts) {
    if (!init()) return { ok: false, error: "Dessiner indisponible" };
    if (typeof stem !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(stem)) return { ok: false, error: "Dessin invalide" };
    const ok = await reopen(stem);
    if (!ok) return { ok: false, error: "Dessin introuvable ou ouverture annulée" };
    setLink(opts);
    return { ok: true, stem: stem };
  }
  function startFresh(opts, underlay) {
    if (!init()) return { ok: false, error: "Dessiner indisponible" };
    if (st.dirty && st.doc.objects.length && !window.confirm("Commencer un nouveau dessin ? Le dessin actuel non enregistré sera remplacé.")) return { ok: false, error: "Annulé" };
    const fresh = S.createDoc({ units: "mm", spacing: 10, mode: "quick" });
    if (underlay) { fresh.version = 3; fresh.underlay = { asset_id: underlay, fit: "contain" }; } // the underlay key only exists from document version 3
    st.hist.clear(); st.name = ""; st.stem = ""; st.sel = []; setDoc(fresh); st.meshVersion++;
    st.view = S.fitView(fresh, st.W || 800, st.H || 600);
    UL.fitOnLoad = !!underlay; st.dirty = false;
    flushDraft(); refreshAll(); setLink(opts);
    return { ok: true };
  }
  window.hqSketchOpenExact = (stem, opts) => openExact(stem, opts);
  window.hqSketchStartBlank = opts => startFresh(opts, "");
  window.hqSketchStartUnderlay = (assetId, opts) => /^asset-[0-9a-f]{24}$/.test(String(assetId)) ? startFresh(opts, String(assetId)) : { ok: false, error: "Image invalide" };
  window.hqSketchClearLink = () => setLink(null);
  const ASSET_RE = /^asset-[0-9a-f]{24}$/;
  function ipadStamp(date) {
    const d = date || new Date(), p = (n) => String(n).padStart(2, "0");
    return "iPad " + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + "h" + p(d.getMinutes());
  }
  function boxOf() { return canvas ? canvas.getBoundingClientRect() : null; }
  function normPoint(p, r) {
    if (!Array.isArray(p) || !isFinite(p[0]) || !isFinite(p[1])) return null;
    return {
      x: Math.min(1, Math.max(0, p[0])) * r.width,
      y: Math.min(1, Math.max(0, p[1])) * r.height,
      w: isFinite(p[2]) && p[2] > 0 ? Math.min(0.2, p[2]) : 0,
    };
  }
  // The pad sends view steps ~30 times a second. They move a goal; the shown view eases toward it on each frame, so a
  // pinch on the iPad glides on the PC instead of stepping. Anything else that sets st.view cancels the glide.
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  function viewBase() { return st.viewGoal && st.view === st.viewShown ? st.viewGoal : st.view; }
  function setViewGoal(v) {
    cancelFit();
    if (reducedMotion()) { st.viewGoal = null; st.view = v; scheduleDraft(); draw(); return; }
    st.viewGoal = v;
    if (st.view !== st.viewShown) st.viewShown = st.view;
    glide();
  }
  function glide() {
    if (st.glideRaf) return;
    st.glideRaf = requestAnimationFrame(() => {
      st.glideRaf = 0;
      let again = false;
      const g = st.viewGoal;
      if (g && st.view !== st.viewShown) st.viewGoal = null; // the user moved the view on the PC: theirs wins
      else if (g) {
        const v = st.view, k = 0.45;
        const ppu = v.ppu * Math.pow(g.ppu / v.ppu, k);
        const next = { x0: v.x0 + (g.x0 - v.x0) * k, y0: v.y0 + (g.y0 - v.y0) * k, ppu: ppu };
        const done = Math.abs(g.ppu / ppu - 1) < 0.002 && Math.hypot(g.x0 - next.x0, g.y0 - next.y0) * ppu < 0.3;
        st.view = done ? g : next;
        st.viewShown = st.view;
        if (done) { st.viewGoal = null; scheduleDraft(); } else again = true;
      }
      const hg = st.hoverGoal, hv = st.remoteHover;
      if (hg && hv) {
        const nx = hv.x + (hg.x - hv.x) * 0.5, ny = hv.y + (hg.y - hv.y) * 0.5;
        if (Math.hypot(hg.x - nx, hg.y - ny) * st.view.ppu < 0.3) { st.remoteHover = hg; st.hoverGoal = null; }
        else { st.remoteHover = { x: nx, y: ny }; again = true; }
      } else st.hoverGoal = null;
      draw();
      if (again) glide();
    });
  }
  function applyView(dx, dy) {
    if (!st.view) return;
    const r = boxOf(); if (!r) return;
    const v = viewBase();
    setViewGoal({ x0: v.x0 - (dx * r.width) / v.ppu, y0: v.y0 + (dy * r.height) / v.ppu, ppu: v.ppu });
  }
  function applyZoom(factor, cx, cy) {
    if (!st.view || !(factor > 0) || factor === 1) return;
    const r = boxOf(); if (!r) return;
    const sx = Math.min(1, Math.max(0, cx)) * r.width, sy = Math.min(1, Math.max(0, cy)) * r.height;
    setViewGoal(S.zoomAt(viewBase(), st.H, sx, sy, factor, minPpu(), maxPpu()));
  }
  // ---- sketch to 3D (the pad's lift gesture)
  function profileSize(ids) {
    const pm = S.pointMap(st.doc);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const id of ids) {
      const o = S.getObj(st.doc, id); if (!o) continue;
      if (o.type === "circle") { const c = pm.get(o.center); if (c) { add(c.x - o.r, c.y - o.r); add(c.x + o.r, c.y + o.r); } }
      else if (o.p1 && o.p2) { const a = pm.get(o.p1), b = pm.get(o.p2); if (a) add(a.x, a.y); if (b) add(b.x, b.y); }
    }
    return isFinite(x0) ? Math.max(x1 - x0, y1 - y0) : 0;
  }
  /** Height for a lift of h (0..1 of the pad): up to 1.5x the shape's size, on a tidy step (1, 2 or 5 x 10^n). */
  function liftDepth(L, h) {
    const raw = h * L.size * 1.5;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(L.size / 60, 1e-6))));
    const step = [1, 2, 5, 10].map(k => k * mag).find(v => v >= L.size / 60) || mag;
    const d = Math.round(raw / step) * step;
    return d >= step ? Math.round(d * 1e6) / 1e6 : 0;
  }
  function liftLabel(depth) { return "Hauteur " + S.fmt(depth) + " " + st.doc.units; }
  function liftStart() {
    if (st.lift) return { ok: true, text: "Glisse vers le haut" };
    let lc = st.lastClosed;
    if (!lc || !lc.profile.length || !lc.profile.every(id => S.getObj(st.doc, id))) {
      const sel = selectedProfile(); // or the closed shape selected on the PC
      lc = sel.length ? { profile: sel } : null;
    }
    if (!lc) return { ok: false, text: "Dessine d'abord un cercle ou un rectangle (garde le stylo immobile à la fin)" };
    if ((st.doc.features || []).length) return { ok: false, text: "Ce dessin a déjà une pièce 3D" };
    if (st.solidBusy) return { ok: false, text: "Calcul 3D en cours" };
    const size = profileSize(lc.profile);
    if (!(size > 0)) return { ok: false, text: "Forme trop petite" };
    // one mesh at a reference height, computed once by the server, then stretched live on each move
    const probe = S.addFeature(st.doc, "extrude", lc.profile, size, "blind");
    if (!probe.ok) return { ok: false, text: probe.error };
    const L = st.lift = { profile: lc.profile.slice(), size: size, h: 0, base: null, was3d: !!st.tab3d };
    setView3d(true);
    $(".sk-3d-status", root).textContent = "Pièce en préparation…";
    window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: probe.doc }), timeoutMs: 45000 })
      .then(res => {
        if (st.lift !== L) return;
        const tris = res.triangles || [];
        let z0 = Infinity, z1 = -Infinity;
        for (const t of tris) for (const p of t) { z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
        L.base = tris; L.z0 = z0; L.ref = z1 - z0 || size;
        if (solidView && solidView.lockFrame) solidView.lockFrame(liftTris(L, size * 1.5));
        liftShow();
      })
      .catch(e => { if (st.lift === L) $(".sk-3d-status", root).textContent = (e && e.message) || "Aperçu 3D indisponible"; });
    return { ok: true, text: "Glisse vers le haut" };
  }
  /** The reference mesh stretched along its height to `depth` (a prism scales exactly). */
  function liftTris(L, depth) {
    const k = Math.max(depth, L.ref * 0.002) / L.ref;
    return L.base.map(t => t.map(p => [p[0], p[1], L.z0 + (p[2] - L.z0) * k]));
  }
  function liftShow() {
    const L = st.lift;
    if (!L || !L.base || L.raf) return;
    L.raf = requestAnimationFrame(() => {
      L.raf = 0;
      if (st.lift !== L) return;
      const depth = liftDepth(L, L.h);
      if (solidView) { solidView.setTriangles(liftTris(L, depth)); solidView.setEdges([]); }
      $(".sk-3d-status", root).textContent = depth > 0 ? liftLabel(depth) + " · lâche pour extruder" : "Glisse vers le haut pour donner de la hauteur";
    });
  }
  function liftStop(keep, depth) {
    const L = st.lift;
    if (!L) return;
    st.lift = null;
    if (L.raf) cancelAnimationFrame(L.raf);
    if (solidView && solidView.lockFrame) solidView.lockFrame(null);
    if (keep) { createSolid("extrude", { profile: L.profile, depth: depth }); return; }
    if (solidView) { solidView.setTriangles([]); solidView.setEdges([]); }
    if (L.was3d) scheduleMesh(); else setView3d(false);
  }

  function commitSnap(snap) {
    st.remote = null;
    const r = boxOf();
    if (!snap || !r || !st.view) return { ok: false, text: "Forme ignorée" };
    const pt = (p) => S.toModel(st.view, st.H, p[0] * r.width, p[1] * r.height);
    let id = null;
    if (snap.kind === "line" && snap.params && snap.params.a && snap.params.b) {
      id = mutate(d => S.withSketch(d, st.sketch, x => S.addLine(x, pt(snap.params.a), pt(snap.params.b), "line")) || false);
      if (id) return { ok: true, text: "Ligne" };
    } else if (snap.kind === "circle" && snap.params && snap.params.c && snap.params.r > 0) {
      const c = pt(snap.params.c), radius = snap.params.r * r.width / st.view.ppu;
      id = mutate(d => S.withSketch(d, st.sketch, x => S.addCircle(x, c, radius)) || false);
      if (id) { st.lastClosed = { profile: [id], at: Date.now() }; return { ok: true, text: "Cercle", closed: true }; }
    } else if (snap.kind === "rect" && snap.params && snap.params.a && snap.params.b) {
      id = mutate(d => S.withSketch(d, st.sketch, x => S.addRect(x, pt(snap.params.a), pt(snap.params.b))) || false);
      if (id && id.lines) { st.lastClosed = { profile: id.lines.slice(), at: Date.now() }; return { ok: true, text: "Rectangle", closed: true }; }
    }
    return { ok: false, text: "Trait libre" };
  }
  function snapshotBlob() {
    if (!canvas || !st.doc || !st.W || !st.view) return Promise.resolve(null);
    const long = Math.max(st.W, st.H), scale = Math.min(1, 1280 / long);
    const W = Math.max(1, Math.round(st.W * scale)), H = Math.max(1, Math.round(st.H * scale));
    const view = { x0: st.view.x0, y0: st.view.y0, ppu: st.view.ppu * scale };
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    if (!c) return Promise.resolve(null);
    const saved = st.remote; st.remote = null; const savedH = st.remoteHover; st.remoteHover = null;
    try { drawScene(c, S.inSketch(st.doc, st.sketch), view, W, H, theme(false), { sel: [], preview: function () {} }); }
    finally { st.remote = saved; st.remoteHover = savedH; }
    const grab = (type, q) => new Promise((res) => { try { cv.toBlob(res, type, q); } catch (_) { res(null); } });
    return grab("image/webp", 0.6).then((b) => {
      if (b && b.size && b.size <= 512 * 1024 && (b.type === "image/webp" || b.type === "image/jpeg")) return b;
      return grab("image/jpeg", 0.6);
    }).then((b) => {
      if (b && b.size > 512 * 1024) return grab("image/jpeg", 0.4);
      return b;
    }).then((b) => { cv.width = 0; cv.height = 0; return b && b.size && b.size <= 512 * 1024 ? b : null; });
  }
  // Phone as a drawing pad (hq-desk.js). hqSketchRemote stays as the sketch target; hqPadTargets may hold others.
  const remote = {
    id: "sketch",
    label: "Dessiner",
    ready: () => !!(st.built && st.doc && canvas && document.body.dataset.view === "dessiner"),
    size: () => (canvas ? { w: Math.round(canvas.clientWidth), h: Math.round(canvas.clientHeight) } : null),
    history: () => ({ undo: !!(st.hist && st.hist.canUndo()), redo: !!(st.hist && st.hist.canRedo()) }),
    begin(pts, meta) {
      if (!this.ready()) return false;
      st.remoteHover = null;
      const erase = meta && meta.tool === "erase";
      st.remote = erase ? { erase: true, pushed: false, pts: [] } : { pts: [], wn: [] };
      this.add(pts, meta);
      return true;
    },
    add(pts, meta) {
      if (!st.remote || !canvas || !Array.isArray(pts)) return;
      const r = boxOf(); if (!r) return;
      if (st.remote.erase) {
        const tol = (meta && meta.thick === "bold" ? 18 : meta && meta.thick === "fine" ? 8 : 12);
        for (const p of pts) {
          const n = normPoint(p, r); if (!n) continue;
          eraseModel(S.toModel(st.view, st.H, n.x, n.y), tol / st.view.ppu);
        }
        return;
      }
      const out = st.remote.pts;
      for (const p of pts) {
        const n = normPoint(p, r); if (!n) continue;
        const m = S.toModel(st.view, st.H, n.x, n.y), last = out[out.length - 1];
        if (last && Math.hypot(m.x - last[0], m.y - last[1]) < 0.75 / st.view.ppu) continue;
        if (out.length >= S.LIMITS.strokePts * 4) break;
        out.push([m.x, m.y]);
        st.remote.wn.push(n.w || 0.009);
        if (!st.remoteRipple) st.remoteRipple = { x: m.x, y: m.y, at: (window.performance ? performance.now() : Date.now()) };
      }
      drawSoon();
    },
    end(snap) {
      const rm = st.remote;
      if (rm && rm.erase) {
        st.remote = null;
        draw();
        return { ok: true, text: "Effacé" };
      }
      if (snap && snap.kind) {
        const shaped = commitSnap(snap);
        if (shaped.ok) return shaped;
      }
      st.remote = null;
      if (rm && rm.pts.length > 1) {
        const short = boxOf() ? Math.min(boxOf().width, boxOf().height) : 0;
        let width = null;
        if (short > 0 && rm.wn && rm.wn.some((v) => v > 0)) {
          const first = rm.wn.find((v) => v > 0) || 0.009;
          const ks = rm.wn.map((v) => Math.round(Math.min(4, Math.max(0.05, (v || first) / first)) * 100) / 100);
          width = { w: first * short / st.view.ppu, k: ks };
        }
        mutate(d => { S.withSketch(d, st.sketch, x => S.addStroke(x, rm.pts, 0.6 / st.view.ppu, width)); });
        return { ok: true, text: "Trait" };
      }
      draw();
      return { ok: false, text: "Trait trop court" };
    },
    cancel() { st.remote = null; anim.remote = 0; if (canvas) draw(); },
    hover(pt) {
      if (!canvas) return;
      clearTimeout(st.remoteHoverT);
      anim.remote = 0;
      if (!Array.isArray(pt) || !isFinite(pt[0]) || !isFinite(pt[1])) { st.remoteHover = null; draw(); return; }
      const r = boxOf();
      const goal = S.toModel(st.view, st.H, Math.min(1, Math.max(0, pt[0])) * r.width, Math.min(1, Math.max(0, pt[1])) * r.height);
      st.remoteHoverT = setTimeout(() => {
        // The collaborator cursor gets a short fade after its 1.5 s silence; reduced motion removes it at once.
        if (st.remoteHover && motionAllowed()) { anim.remote = nowMs(); motionSchedule(); }
        else { st.remoteHover = null; st.hoverGoal = null; draw(); }
      }, 1500);
      const cur = st.remoteHover;
      // a big jump (pen lifted away and back) lands at once; small moves glide over a few frames
      if (!cur || reducedMotion() || Math.hypot(goal.x - cur.x, goal.y - cur.y) * st.view.ppu > 90) { st.remoteHover = goal; st.hoverGoal = null; draw(); return; }
      st.hoverGoal = goal;
      glide();
    },
    inkColor() { return theme(false).ref; },
    has3d() { return !!(st.doc && (st.doc.features || []).length); },
    ar() { return this.ready() ? arModel() : Promise.resolve({ ok: false, text: "Dessiner n'est pas ouvert" }); },
    /** Sketch to 3D from the pad: "start" lifts the last closed shape the pad snapped, "move" sets the height
     * (h = 0..1 of the pad), "end" saves a normal extrusion, "cancel" puts everything back. */
    lift(phase, h) {
      if (!this.ready()) return { ok: false, text: "Dessiner n'est pas ouvert" };
      const hh = Math.max(0, Math.min(1, Number(h) || 0));
      if (phase === "start") return liftStart();
      const L = st.lift;
      if (!L) return { ok: false, text: "" };
      if (phase === "move") { L.h = hh; liftShow(); return { ok: true, text: liftLabel(liftDepth(L, hh)) }; }
      const depth = liftDepth(L, hh);
      if (phase !== "end" || !(depth > 0)) { liftStop(false); return { ok: true, text: "Extrusion annulée" }; }
      liftStop(true, depth);
      return { ok: true, text: "Extrusion · " + liftLabel(depth).replace("Hauteur ", "") };
    },
    undo() { if (this.ready()) act("undo"); },
    redo() { if (this.ready()) act("redo"); },
    pan(dx, dy) { if (this.ready()) applyView(Number(dx) || 0, Number(dy) || 0); },
    zoom(factor, cx, cy) { if (this.ready()) applyZoom(Number(factor), Number(cx), Number(cy)); },
    setUnderlay(id) {
      if (!this.ready()) return { ok: false, text: "Dessiner n'est pas ouvert" };
      if (!ASSET_RE.test(String(id || ""))) return { ok: false, text: "Image invalide" };
      const cur = st.doc.underlay && st.doc.underlay.asset_id;
      if (cur === id) return { ok: true, text: "Fond déjà en place" };
      mutate(d => { d.version = Math.max(d.version || 1, 3); d.underlay = { asset_id: String(id), fit: "contain" }; });
      return { ok: true, text: "Photo en fond" };
    },
    async save() {
      if (!this.ready()) return { ok: false, text: "Dessiner n'est pas ouvert" };
      const name = (st.name && String(st.name).trim()) || ipadStamp();
      const ok = await doSave(name);
      return ok ? { ok: true, text: "Enregistré" } : { ok: false, text: "Enregistrement impossible" };
    },
    snapshot: snapshotBlob,
  };
  window.hqSketchRemote = remote;
  if (window.hqPadTargets && typeof window.hqPadTargets.register === "function") window.hqPadTargets.register(remote);

  // ------------------------------------------------------------ keyboard
  function onKey(e) {
    if (document.body.dataset.view !== "dessiner" || !st.doc) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (document.querySelector("dialog[open]")) return; // a modal owns the keyboard: never change the drawing behind it
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (!mod && st.action && ["line", "centerline", "rect", "circle"].includes(st.action.kind) && I && typedKey(e)) return;
    if (mod && k === "z") { e.preventDefault(); act(e.shiftKey ? "redo" : "undo"); return; }
    if (mod && k === "y") { e.preventDefault(); act("redo"); return; }
    if (mod) return;
    if (k === "delete" || k === "backspace") { if (st.sel.length) { e.preventDefault(); deleteSel(); } return; }
    if (k === "escape") { st.sel = []; st.angleTaps = []; st.pushPull = null; cancelAction(); refreshAll(); return; }
    if (e.key === "?") { toggleKeys(); return; }
    if (e.key === " ") { // repeat the last bubble action on the new selection (same height, same hole…)
      e.preventDefault();
      if (st.lastFloat) floatAction(st.lastFloat.key, Object.assign({}, st.lastFloat.v));
      return;
    }
    if (k === "c" && e.shiftKey) { if (st.doc.mode !== "construction") setMode("construction"); setTool("arc"); return; }
    if (k === "x") { const b = st.tab3d && !st.split ? null : bubble2d; if (b && b.focus("h")) e.preventDefault(); return; }
    if (k === "o") { if (bubble2d && (bubble2d.focus("std") || bubble2d.focus("rad"))) e.preventDefault(); return; }
    const map = { v: "select", p: "pen", e: "eraser", t: "text", d: "dimlin", l: "line", r: "rect", c: "circle", a: "centerline", h: "pan" };
    if (map[k]) {
      const tool = map[k];
      if (!TOOLS[st.doc.mode].some(x => x[0] === tool)) setMode(st.doc.mode === "quick" ? "construction" : "quick");
      setTool(tool);
    }
  }

  const KEYS = [["L", "Ligne"], ["R", "Rectangle"], ["C", "Cercle"], ["Maj+C", "Arc"], ["A", "Axe"], ["D", "Cote"], ["V", "Sélection"], ["H", "Main"],
    ["X", "Extruder la sélection (bulle)"], ["O", "Percer / rayon (bulle)"], ["Espace", "Refaire la dernière action de la bulle"], ["Chiffres", "Cote pendant le tracé (Tab, Entrée)"],
    ["Double-clic", "Tout le contour"], ["Glisser dans le vide", "Sélection par cadre"], ["Clic droit / appui long", "Anneau d'actions"], ["Échap", "Annuler / désélectionner"], ["Ctrl+Z / Y", "Annuler / rétablir"]];
  function toggleKeys() {
    const stage = $(".sk-stage", root);
    let box = stage.querySelector(".sk-keys");
    if (box) { box.remove(); return; }
    box = document.createElement("div");
    box.className = "sk-keys"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Raccourcis clavier");
    const h = document.createElement("strong"); h.textContent = "Raccourcis (? pour fermer)"; box.appendChild(h);
    const dl = document.createElement("dl");
    for (const [k, t] of KEYS) { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = t; dl.append(dt, dd); }
    box.appendChild(dl);
    box.addEventListener("pointerdown", ev => { ev.stopPropagation(); box.remove(); });
    box.tabIndex = -1;
    box.addEventListener("keydown", ev => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); box.remove(); } });
    stage.appendChild(box);
    box.focus(); // Échap must close it for keyboard users too
  }

  // ------------------------------------------------------------ entry
  function init() {
    if (st.built) return true;
    if (!build()) return false;
    st.built = true;
    I = I || window.HqSketchInput;
    loadPrefs();
    // does this HQ build exact parts (OpenCascade)? sketches on planes, arcs, constraints and v6 features need it
    window.api("/api/drawings/caps", { timeoutMs: 15000 }).then(r => { st.caps = r || { exact: false }; if (st.doc) { renderToolbar(); renderProps(); } }).catch(() => {});
    let draft = null;
    try { draft = S.loadDraft(window.localStorage); } catch (_) {}
    if (draft) {
      setDoc(draft.doc); st.name = draft.name; st.stem = draft.stem; st.dirty = draft.dirty;
      if (draft.dirty && draft.doc.objects.length) {
        // what the draft actually holds: when it was written, how big it is, and the delta against the last save
        const hhmm = draft.at ? new Date(draft.at).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" }) : "";
        const diff = draft.baseObjects ? draft.objects - draft.baseObjects : 0;
        say("Brouillon restauré" + (hhmm ? " de " + hhmm : "") + " · " + draft.objects + " objet(s)" +
          (diff ? " (" + (diff > 0 ? "+" : "") + diff + " depuis le dernier enregistrement)" : "") + (st.stem ? " · " + st.stem : ""));
      }
    } else setDoc(S.createDoc({ units: "mm", spacing: 10 }));
    refreshAll();
    requestAnimationFrame(resize);
    return true;
  }

  let scrolledOnce = false;
  let initFailed = false;
  window.hqSketchShow = function () {
    if (initFailed) return;
    try {
      if (!init()) return;
    } catch (err) {
      initFailed = true;  // half-built: keep the error state, « Réessayer » reloads
      console.error(err);
      fail("erreur d'initialisation", "init");
      return;
    }
    fitStage(); // synchronous: the canvas fits the fold even before the first rendered frame
    requestAnimationFrame(resize);
    if (!scrolledOnce && window.innerWidth < 900) {
      scrolledOnce = true;
      requestAnimationFrame(() => { const bar = $(".sk-bar", root); if (bar) window.scrollTo({ top: Math.max(0, bar.getBoundingClientRect().top + window.scrollY - 8) }); });
    }
  };
  window.hqSketchState = () => st; // test/debug hook (read-only use)
  // Late load (retry injection or slow script): initialize if Dessiner is already the view.
  if (document.body && document.body.dataset.view === "dessiner") window.hqSketchShow();
})();
