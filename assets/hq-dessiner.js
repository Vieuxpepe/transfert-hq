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
  const TOOLS = {
    quick: [["select", "Sélection", "↖"], ["pen", "Stylo", "✎"], ["eraser", "Gomme", "⌫"], ["text", "Texte", "T"],
      ["dimlin", "Cote", "↔"], ["dimang", "Cote ∠", "∠"], ["pan", "Main", "✋"]],
    construction: [["select", "Sélection", "↖"], ["line", "Ligne", "╱"], ["rect", "Rect.", "▭"], ["circle", "Cercle", "◯"], ["arc", "Arc", "◠"],
      ["centerline", "Axe", "┄"], ["dimlin", "Cote", "↔"], ["pan", "Main", "✋"]],
  };
  const HINTS = {
    select: "Touche un objet pour le sélectionner, glisse pour le déplacer. Glisse dans le vide pour te déplacer.",
    pen: "Dessine à main levée. Deux doigts : zoom / déplacement.",
    eraser: "Passe sur un objet pour l'effacer (annulable).",
    text: "Touche l'endroit de la note, puis tape au clavier.",
    dimlin: "Glisse d'un point à l'autre. Le libellé est libre et ne modifie jamais la géométrie.",
    dimang: "Touche le sommet, puis un point sur chaque côté.",
    pan: "Glisse pour te déplacer, pince pour zoomer.",
    line: "Glisse du début à la fin. Accroche aux extrémités, à la grille et aux angles.",
    rect: "Glisse d'un coin au coin opposé.",
    circle: "Glisse du centre vers le rayon.",
    arc: "Glisse du centre vers le début de l'arc, puis touche sa fin (sens inverse des aiguilles d'une montre).",
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
  /** The active sketch's view of the drawing (same ids): what the 2D editor draws and hit-tests. */
  const vdoc = () => S.inSketch(st.doc, st.sketch);
  let I = window.HqSketchInput; // refreshed at build: the helper may load after this file
  Object.assign(st, { typed: null, guides: null, autoRules: true, lastFloat: null, split: false, pushPull: null, previewT: 0, previewSeq: 0, previewing: false, pressT: 0, ringOpen: null });
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
    } catch (_) { st.autoRules = true; }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ solidDepth: Number(st.solidDepth) || undefined, bossDepth: Number(st.boss.depth) || undefined,
        holeStd: st.hole.standard, holeFit: st.hole.fit, radius: Number(st.rf.radius) || undefined, distance: Number(st.rf.distance) || undefined, autoRules: st.autoRules }));
    } catch (_) {}
  }
  const inV6 = () => !!(st.caps && st.caps.exact);
  let root, canvas, ctx, hud, props, textIn, solidView, faceSketch, bubble2d, bubble3d;

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
  function commit(next, opts) {
    st.preview3d = null; // any change ends a 3D history preview
    if (!(opts && opts.noHistory)) st.hist.push(st.doc);
    st.doc = next;
    st.meshVersion++;
    st.doc.view = st.view;
    st.dirty = true;
    const alive = new Set(st.doc.objects.map(o => o.id));
    st.sel = st.sel.filter(id => alive.has(id));
    scheduleDraft();
    refreshAll();
  }
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
    try { S.saveDraft(window.localStorage, { doc: st.doc, name: st.name, stem: st.stem, dirty: st.dirty }); } catch (_) {}
  }
  function sourceHint() {
    const mm = q => { try { return window.matchMedia(q).matches; } catch (_) { return false; } };
    return S.sourceHint({ coarse: mm("(pointer: coarse)"), finePointer: mm("(any-pointer: fine)"), touchPoints: navigator.maxTouchPoints || 0,
      width: window.innerWidth, height: window.innerHeight });
  }

  // ------------------------------------------------------------ build
  function build() {
    root = $("#hq-sk-app");
    if (!root) return false;
    root.innerHTML = `
<div class="sk" data-mode="quick">
  <div class="sk-return" role="region" aria-label="Retour au carnet" hidden><span class="sk-return-msg"></span><button type="button" class="sk-btn sk-return-btn" data-act="return">← Retour au carnet</button></div>
  <div class="sk-bar">
    <div class="sk-seg" role="tablist" aria-label="Mode de dessin">
      <button type="button" role="tab" data-mode="quick">Croquis rapide</button>
      <button type="button" role="tab" data-mode="construction">Construction</button>
    </div>
    <div class="sk-acts">
      <button type="button" class="sk-btn" data-act="undo" aria-label="Annuler" title="Annuler (Ctrl+Z)">↶</button>
      <button type="button" class="sk-btn" data-act="redo" aria-label="Rétablir" title="Rétablir (Ctrl+Y)">↷</button>
      <button type="button" class="sk-btn" data-act="delete" aria-label="Supprimer la sélection" title="Supprimer">🗑</button>
      <button type="button" class="sk-btn" data-act="fit" aria-label="Tout afficher" title="Tout afficher">⤢</button>
      <button type="button" class="sk-btn" data-act="settings" aria-label="Réglages grille et unités" aria-expanded="false" title="Réglages">⚙</button>
      <button type="button" class="sk-btn" data-act="open" aria-label="Ouvrir un dessin" title="Ouvrir">📂</button>
      <button type="button" class="sk-btn" data-act="new" aria-label="Nouveau dessin" title="Nouveau">＋</button>
      <button type="button" class="sk-btn sk-paint-btn" data-act="paint" aria-label="Forge peint le croquis" aria-expanded="false" title="Forge peint le croquis">🎨</button>
      <button type="button" class="sk-btn sk-save" data-act="save">Enregistrer</button>
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
    <label>Pas <select data-set="astep"><option>5</option><option>7.5</option><option>10</option><option>15</option><option>22.5</option><option>30</option><option>45</option><option>90</option></select> °</label>
  </div>
  <div class="sk-stages">
  <div class="sk-stage">
    <canvas class="sk-canvas" aria-label="Zone de dessin" role="img"></canvas>
    <input class="sk-textin" type="text" maxlength="500" enterkeyhint="done" autocomplete="off" aria-label="Texte de la note" hidden/>
    <div class="sk-hud" aria-live="polite"></div>
    <div class="sk-float"><button type="button" class="sk-btn" data-act="undo" aria-label="Annuler">↶</button><button type="button" class="sk-btn" data-act="redo" aria-label="Rétablir">↷</button></div>
  </div>
  <div class="sk-3d-stage" hidden>
    <canvas class="sk-3d-canvas" aria-label="Aperçu 3D interactif" role="img"></canvas>
    <div class="sk-3d-overlay"><span class="sk-3d-status" aria-live="polite"></span><button type="button" data-act="faceSketch" class="sk-face-start" hidden>Dessiner sur cette face</button><button type="button" data-act="roundMode" class="sk-round-mode" aria-pressed="false">Arrondir une arête</button><button type="button" data-act="ar3d" class="sk-ar">Voir en AR</button><button type="button" data-act="reset3d">Recentrer</button></div>
    <div class="sk-face-editor" hidden></div>
  </div>
  </div>
  <div class="sk-paint-host" hidden></div>
  <div class="sk-solid"></div>
  <div class="sk-props"></div>
  <dialog class="sk-dlg" id="sk-save-dlg" aria-labelledby="sk-save-title">
    <form method="dialog">
      <header><strong id="sk-save-title">Enregistrer le dessin</strong></header>
      <label for="sk-save-name">Nom de base</label>
      <input id="sk-save-name" type="text" maxlength="60" autocomplete="off" placeholder="support-moteur"/>
      <p class="hint" id="sk-save-preview"></p>
      <div class="row"><button value="cancel" class="secondary">Annuler</button><button value="ok" id="sk-save-go">Enregistrer</button></div>
    </form>
  </dialog>
  <dialog class="sk-dlg" id="sk-open-dlg" aria-labelledby="sk-open-title">
    <form method="dialog">
      <header><strong id="sk-open-title">Dessins enregistrés</strong> <span class="hint">Inbox/Drawings</span></header>
      <div class="sk-list"><p class="hint">Chargement…</p></div>
      <div class="row"><button value="cancel" class="secondary">Fermer</button></div>
    </form>
  </dialog>
</div>`;
    canvas = $(".sk-canvas", root);
    ctx = canvas.getContext("2d");
    hud = $(".sk-hud", root);
    props = $(".sk-props", root);
    textIn = $(".sk-textin", root);
    if (window.HQSolidView) {
      solidView = window.HQSolidView($(".sk-3d-canvas", root));
      solidView.onFaceSelect(face => {
        restorePreview();
        st.pushPull = face && I ? I.capFeature(st.doc, face.plane) : null;
        st.faceSelection = face; st.faceAt = st.meshVersion;
        updateFloat();
        $(".sk-face-start", root).hidden = !face;
        if (face) $(".sk-3d-status", root).textContent = st.pushPull ? "Face sélectionnée · glisse-la pour la pousser ou la tirer" : "Face sélectionnée";
      });
      solidView.onFaceDrag(ppDragHandler());
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
    root.addEventListener("click", e => {
      const m = e.target.closest("[data-mode]");
      if (m && m.tagName === "BUTTON") { setMode(m.dataset.mode); return; }
      const t = e.target.closest("[data-tool]");
      if (t) { setTool(t.dataset.tool); return; }
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
    props.addEventListener("change", onPropsChange);
    props.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches("input[data-apply]")) { e.preventDefault(); applyProp(e.target.dataset.apply); } });
    $(".sk-solid", root).addEventListener("change", onSolidChange);
    $(".sk-tools", root).addEventListener("change", e => { if (e.target.matches(".sk-sketch-sel")) setSketch(e.target.value); });
    $(".sk-settings", root).addEventListener("change", e => { if (e.target.dataset.pref === "autoRules") { st.autoRules = e.target.checked; savePrefs(); } });
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
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushDraft(); });
    if (window.ResizeObserver) new ResizeObserver(resize).observe($(".sk-stage", root));
    window.addEventListener("resize", resize);

    const dlg = $("#sk-save-dlg", root);
    const nameIn = $("#sk-save-name", root);
    nameIn.addEventListener("input", updateSavePreview);
    dlg.addEventListener("close", () => { if (dlg.returnValue === "ok") doSave(nameIn.value); });
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
    st.tool = tool; st.angleTaps = []; st.arcPending = null; st.arcHover = null; st.typed = null; st.guides = null; cancelAction();
    if (tool !== "select") st.multi = false;
    refreshAll();
    skMotion("tool", { tool });
  }

  function renderToolbar() {
    const mode = st.doc.mode;
    root.querySelector(".sk").dataset.mode = mode;
    root.querySelectorAll(".sk-seg [data-mode]").forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
    const bar = $(".sk-tools", root);
    let h = TOOLS[mode].map(([id, label, ico]) =>
      `<button type="button" class="sk-tool${st.tool === id ? " on" : ""}" data-tool="${id}" aria-pressed="${st.tool === id}"><span class="sk-ico" aria-hidden="true">${ico}</span><span>${label}</span></button>`).join("");
    if (st.tool === "select") h += `<button type="button" class="sk-tool sk-multi${st.multi ? " on" : ""}" data-act="multi" aria-pressed="${st.multi}"><span class="sk-ico" aria-hidden="true">⊕</span><span>Multi</span></button>`;
    if (mode === "construction" && inV6()) {
      const sks = st.doc.sketches || [];
      if (st.sketch && !sks.some(x => x.id === st.sketch)) st.sketch = "";
      h += `<label class="sk-sketch"><span>Esquisse</span><select class="sk-sketch-sel" aria-label="Esquisse active">
        <option value=""${st.sketch ? "" : " selected"}>Base · plan XY</option>
        ${sks.map(x => `<option value="${esc(x.id)}"${x.id === st.sketch ? " selected" : ""}>${esc(x.name)} · ${esc(x.plane)}${x.offset ? " " + (x.offset > 0 ? "+" : "") + S.fmt(x.offset) : ""}</option>`).join("")}
      </select></label><button type="button" class="sk-tool" data-act="newSketch" aria-expanded="${st.newSketch}"><span class="sk-ico" aria-hidden="true">＋</span><span>Esquisse</span></button>`;
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
  }
  function updateButtons() {
    const set = (n, off) => root.querySelectorAll(`[data-act="${n}"]`).forEach(el => { el.disabled = off; });
    set("undo", !st.hist.canUndo());
    set("redo", !st.hist.canRedo());
    set("delete", !st.sel.length);
  }

  function selectedProfile() { return profileFrom(st.sel); }
  /** A profile from picked objects: one picked line grows to its whole rectangle (group) or connected outline. */
  function profileFrom(ids) {
    if (!ids.length) return [];
    const chosen = ids.map(id => S.getObj(st.doc, id)).filter(Boolean);
    if (chosen.length !== 1 || (chosen[0].type !== "line" && chosen[0].type !== "arc")) return chosen.map(o => o.id);
    const first = chosen[0];
    if (first.group) return st.doc.objects.filter(o => o.type === "line" && o.group === first.group).map(o => o.id);
    const seen = new Set(), queue = [first], chain = o => o.type === "line" || o.type === "arc";
    while (queue.length) {
      const line = queue.pop(); if (seen.has(line.id)) continue; seen.add(line.id);
      for (const o of st.doc.objects) if (chain(o) && !seen.has(o.id) && (o.sketch || "") === (line.sketch || "") && [o.p1, o.p2].some(p => p === line.p1 || p === line.p2)) queue.push(o);
    }
    return [...seen];
  }

  const FEATURE_NAMES = { extrude: "Extrusion", revolve: "Révolution", cut: "Enlèvement", hole: "Trou", shell: "Coque", pattern: "Répétition",
    fillet: "Congé", chamfer: "Chanfrein", sweep: "Balayage", loft: "Lissage" };
  function featureTitle(f, i) {
    if (i > 0 && ["extrude", "revolve", "sweep", "loft"].includes(f.type)) return (f.op === "cut" ? "Enlèvement · " : "Bossage · ") + FEATURE_NAMES[f.type].toLowerCase();
    return FEATURE_NAMES[f.type] || f.type;
  }
  function featureRow(f, i, all) {
    const u = esc(st.doc.units), id = esc(f.id);
    const num = (key, val, label, extra) => `<label class="sk-feat-num">${label} <input type="number" inputmode="decimal" step="any" data-edit="${key}" data-feature="${id}" value="${esc(val === "" || val == null ? "" : S.fmt(Number(val)))}" ${extra || ""}/></label>`;
    const pick = (key, val, opts, label) => `<label class="sk-feat-num">${label} <select data-edit="${key}" data-feature="${id}">${opts.map(([v, t]) => `<option value="${esc(v)}"${v === val ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;
    const extent = (f) => pick("extent", f.extent, [["throughAll", "Traversant"], ["blind", "Profondeur"]], "");
    let title = featureTitle(f, i), body = "";
    if (f.type === "extrude") body = num("depth", f.depth, "Hauteur (" + u + ")", 'min="0.001"');
    else if (f.type === "revolve") body = num("angle", f.angle, "Angle (°)", 'min="1" max="360"');
    else if (f.type === "cut") body = extent(f) + (f.extent === "blind" ? num("depth", f.depth, "(" + u + ")", 'min="0.001"') : "");
    else if (f.type === "hole") {
      title += f.at.length > 1 ? " ×" + f.at.length : "";
      body = pick("standard", f.standard, S.HOLE_STANDARDS.map(x => [x, x]), "") + pick("fit", f.fit, Object.entries(S.HOLE_FITS), "") +
        extent(f) + (f.extent === "blind" ? num("depth", f.depth || "", "(" + u + ")", 'min="0"') : "");
    } else if (f.type === "shell") body = num("thickness", f.thickness, "Paroi (" + u + ")", 'min="0.001"') +
      `<label class="sk-chk"><input type="checkbox" data-edit="open" data-feature="${id}"${f.open ? " checked" : ""}/> Ouverte en haut</label>`;
    else if (f.type === "fillet") body = num("radius", f.radius, "Rayon (" + u + ")", 'min="0.001"') + `<span class="hint">${f.edges.length} arête(s)</span>`;
    else if (f.type === "chamfer") body = num("distance", f.distance, "Distance (" + u + ")", 'min="0.001"') + `<span class="hint">${f.edges.length} arête(s)</span>`;
    else if (f.type === "sweep") body = `<span class="hint">profil ${f.profile.length} objet(s) · chemin ${f.path.length} segment(s)</span>`;
    else if (f.type === "loft") body = `<span class="hint">${f.profiles.length} profils</span>`;
    else if (f.type === "pattern") {
      const src = all.findIndex(x => x.id === f.source);
      title += " de " + (src + 1);
      body = num("count", f.count, "Nombre", 'min="2" max="50" step="1"') + (f.mode === "linear"
        ? num("dx", f.dx, "Pas X", "") + num("dy", f.dy, "Pas Y", "")
        : num("cx", f.cx, "Centre X", "") + num("cy", f.cy, "Centre Y", "") + num("angle", f.angle, "Angle (°)", 'min="1" max="360"'));
    }
    if (i > 0 && ["extrude", "revolve", "sweep", "loft"].includes(f.type) && (st.doc.version >= 6 || f.op)) body = pick("op", f.op || "add", [["add", "Ajoute"], ["cut", "Enlève"]], "") + body;
    const v6 = (Number(st.doc.version) || 1) >= 6 && inV6();
    const past = st.doc.rollback != null && i >= st.doc.rollback;
    const tools = v6 && i > 0 ? `<span class="sk-feat-tools"><label class="sk-chk" title="Désactiver sans supprimer"><input type="checkbox" data-active="${id}"${f.suppressed ? "" : " checked"}/> active</label><button type="button" class="sk-mini" data-act="featUp" data-feature="${id}" aria-label="Monter la fonction ${i + 1}"${i < 2 ? " disabled" : ""}>↑</button><button type="button" class="sk-mini" data-act="featDown" data-feature="${id}" aria-label="Descendre la fonction ${i + 1}"${i === all.length - 1 ? " disabled" : ""}>↓</button></span>` : "";
    return `<div class="sk-solid-feature sk-feat${f.suppressed ? " is-off" : ""}${past ? " is-past" : ""}" data-type="${esc(f.type)}"><span class="sk-feat-name">${i + 1}. ${esc(title)}</span><span class="sk-feat-fields">${body}${tools}</span><button type="button" data-act="remove3d" data-feature="${id}" aria-label="Retirer la fonction ${i + 1}">Retirer</button></div>`;
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
  function selectedCircles() { return st.sel.filter(id => (S.getObj(st.doc, id) || {}).type === "circle"); }
  function revolveSelection() {
    const axes = st.sel.filter(id => (S.getObj(st.doc, id) || {}).type === "centerline");
    return { axis: axes.length === 1 ? axes[0] : null, profile: profileFrom(st.sel.filter(id => !axes.includes(id))) };
  }

  function renderSolid() {
    const box = $(".sk-solid", root);
    const features = st.doc.features || [], selected = selectedProfile();
    const u = esc(st.doc.units);
    const busy = st.solidBusy ? " disabled" : "";
    const parts = features.map((f, i) => featureRow(f, i, features)).join("");
    const faceParts = (st.doc.faceFeatures || []).map((f, i) => `<div class="sk-solid-feature"><span>Face ${i + 1}. ${f.type === "extrude" ? "Ajout" : "Enlèvement"} · ${f.extent === "throughAll" ? "traversant" : S.fmt(f.depth) + " " + u}</span><button type="button" data-act="removeFace3d" data-feature="${esc(f.id)}" aria-label="Retirer la fonction sur face ${i + 1}">Retirer</button></div>`).join("");
    const roundParts = (st.doc.roundFeatures || []).map((f, i) => `<div class="sk-solid-feature"><span>Arrondi ${i + 1} · R ${S.fmt(f.radius)} ${u}</span><button type="button" data-act="removeRound3d" data-feature="${esc(f.id)}" aria-label="Retirer l'arrondi ${i + 1}">Retirer</button></div>`).join("");
    const opt = (v, cur, t) => `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(t)}</option>`;
    let add = "";
    if (!features.length) {
      const rv = revolveSelection();
      add = `<div class="sk-solid-controls"><span class="hint">Profil : ${selected.length ? selected.length + " objet(s) sélectionné(s)" : "touche un rectangle, un cercle ou plusieurs lignes fermées"}</span>
        <label>Profondeur (${u}) <input data-solid="base-depth" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(st.solidDepth)}"/></label><button type="button" data-act="solid-extrude"${selected.length && !st.solidBusy ? "" : " disabled"}>Extruder</button></div>
        <div class="sk-solid-controls"><label>Révolution (°) <input data-solid="revAngle" type="number" inputmode="decimal" min="1" max="360" step="any" value="${esc(st.revAngle)}"/></label><button type="button" data-act="solid-revolve"${rv.axis && rv.profile.length && !st.solidBusy ? "" : " disabled"}>Tourner</button>
        <span class="hint">Pour une pièce tournée : sélectionne le demi-profil fermé et un trait d'axe (outil « Axe »).</span></div>`;
    } else {
      const circles = selectedCircles().length;
      const sources = features.filter(f => f.type === "cut" || f.type === "hole");
      if (!sources.some(f => f.id === st.pat.source)) st.pat.source = sources.length ? sources[sources.length - 1].id : "";
      const c = partCenter();
      add = `<div class="sk-solid-add">
        <div class="sk-solid-controls"><strong class="sk-add-title">Enlever</strong><label>Profondeur (${u}) <input data-solid="cut-depth" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(st.cutDepth)}"${st.cutThrough ? " disabled" : ""}/></label><label class="sk-chk"><input data-solid="through" type="checkbox"${st.cutThrough ? " checked" : ""}/> Traversant</label><button type="button" data-act="solid-cut"${selected.length && !st.solidBusy ? "" : " disabled"}>Enlever matière</button></div>
        <div class="sk-solid-controls"><strong class="sk-add-title">Percer</strong>
          <select data-solid="hole.standard" aria-label="Taille de vis">${S.HOLE_STANDARDS.map(x => opt(x, st.hole.standard, x)).join("")}</select>
          <select data-solid="hole.fit" aria-label="Type de trou">${Object.entries(S.HOLE_FITS).map(([k, t]) => opt(k, st.hole.fit, t)).join("")}</select>
          <select data-solid="hole.extent" aria-label="Étendue">${opt("throughAll", st.hole.extent, "Traversant")}${opt("blind", st.hole.extent, "Profondeur")}</select>
          ${st.hole.extent === "blind" ? `<input data-solid="hole.depth" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(st.hole.depth)}" aria-label="Profondeur du trou"/>` : ""}
          <button type="button" data-act="solid-hole"${circles && !st.solidBusy ? "" : " disabled"}>Percer${circles > 1 ? " ×" + circles : ""}</button>
          <span class="hint">Touche un ou plusieurs cercles : le trou se perce en leur centre, depuis le dessus.</span></div>
        ${features.some(f => f.type === "shell") ? "" : `<div class="sk-solid-controls"><strong class="sk-add-title">Évider</strong><label>Paroi (${u}) <input data-solid="shell.t" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(st.shell.t)}"/></label><label class="sk-chk"><input data-solid="shell.open" type="checkbox"${st.shell.open ? " checked" : ""}/> Ouverte en haut</label><button type="button" data-act="solid-shell"${busy}>Évider</button></div>`}
        ${sources.length ? `<div class="sk-solid-controls"><strong class="sk-add-title">Répéter</strong>
          <select data-solid="pat.source" aria-label="Fonction à répéter">${sources.map(f => opt(f.id, st.pat.source, (features.indexOf(f) + 1) + ". " + FEATURE_NAMES[f.type])).join("")}</select>
          <select data-solid="pat.mode" aria-label="Disposition">${opt("linear", st.pat.mode, "En ligne")}${opt("circular", st.pat.mode, "En cercle")}</select>
          <label>Nombre <input data-solid="pat.count" type="number" min="2" max="50" step="1" value="${esc(st.pat.count)}"/></label>
          ${st.pat.mode === "linear"
            ? `<label>Pas X <input data-solid="pat.dx" type="number" step="any" value="${esc(st.pat.dx === "" ? S.fmt(st.doc.grid.spacing * 2) : st.pat.dx)}"/></label><label>Pas Y <input data-solid="pat.dy" type="number" step="any" value="${esc(st.pat.dy)}"/></label>`
            : `<label>Centre X <input data-solid="pat.cx" type="number" step="any" value="${esc(st.pat.cx === "" ? S.fmt(c.x) : st.pat.cx)}"/></label><label>Centre Y <input data-solid="pat.cy" type="number" step="any" value="${esc(st.pat.cy === "" ? S.fmt(c.y) : st.pat.cy)}"/></label><label>Angle <input data-solid="pat.angle" type="number" min="1" max="360" step="any" value="${esc(st.pat.angle)}"/></label>`}
          <button type="button" data-act="solid-pattern"${busy}>Répéter</button></div>` : ""}
      </div>`;
    }
    if (inV6() && st.doc.mode === "construction") add += v6Controls(features, selected, u);
    const steps = history3d();
    const at = st.preview3d == null ? steps.length - 1 : st.preview3d;
    const hist = steps.length > 1 ? `<div class="sk-hist3d"><label>Historique 3D <input type="range" min="0" max="${steps.length - 1}" step="1" value="${at}" data-hist3d="" aria-label="Étape de la pièce 3D"/></label>
      <span class="sk-hist3d-label">Étape ${at + 1}/${steps.length} · ${esc(steps[at].label)}</span>
      <button type="button" data-act="hist3dGo"${busy}${at < steps.length - 1 ? "" : " hidden"}>Revenir à cette étape</button></div>` : "";
    box.innerHTML = `<div class="sk-solid-head"><strong>Pièce 3D</strong><span>${features.length ? features.length + (st.doc.faceFeatures || []).length + (st.doc.roundFeatures || []).length + " fonction(s) · change une valeur, la pièce suit" : "Sélectionne un contour fermé en Construction"}</span></div>
      ${hist}
      ${rollbackBar(features)}
      <div class="sk-solid-features">${parts}${faceParts}${roundParts}</div>
      ${massLine(u)}
      ${profileDims(features[0])}
      ${add}
      ${features.length && st.edgeMode ? `<div class="sk-solid-controls"><label>Rayon (${u}) <input data-solid="round-radius" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(st.roundRadius)}"/></label><button type="button" data-act="roundApply" ${st.edgeSelection && !st.solidBusy ? "" : "disabled"}>Appliquer l'arrondi</button><span class="hint">Sélectionne une arête droite convexe. Le rayon est refusé s'il traverse la pièce ou une autre fonction.</span></div>` : ""}
      <p class="hint">La pièce part du plan Z=0. Pour ajouter ou enlever de la matière sur une face plane, touche la face dans l'aperçu 3D. STL exporté en millimètres.</p>`;
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
  /** v6 steps: bosses / cuts on any sketch, congés / chanfreins on picked edges, sweep, loft. */
  function v6Controls(features, selected, u) {
    const opt = (v, cur, t) => `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(t)}</option>`;
    const busy = st.solidBusy ? " disabled" : "";
    const sk = (st.doc.sketches || []).find(x => x.id === st.sketch);
    const where = sk ? "sur l'esquisse « " + esc(sk.name) + " »" : "sur la base";
    let h = `<div class="sk-solid-add sk-v6"><strong class="sk-add-title">Pièce exacte</strong>`;
    if (features.length) {
      h += `<div class="sk-solid-controls"><span class="sk-add-title">Extrusion</span><select data-solid="boss.op" aria-label="Ajouter ou enlever">${opt("add", st.boss.op, "Bossage (ajoute)")}${opt("cut", st.boss.op, "Enlèvement (retire)")}</select>
        <label>Hauteur (${u}) <input data-solid="boss.depth" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(st.boss.depth)}"/></label>
        <button type="button" data-act="solid-boss"${selected.length && !st.solidBusy ? "" : " disabled"}>Extruder ${where}</button></div>`;
      const ep = st.edgePick;
      h += `<div class="sk-solid-controls"><span class="sk-add-title">Arêtes</span>
        ${ep ? `<span class="hint">${ep.picks.length} arête(s) choisie(s) dans l'aperçu 3D</span>
          <label>Rayon (${u}) <input data-solid="rf.radius" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(st.rf.radius)}"/></label><button type="button" data-act="solid-fillet"${ep.picks.length && !st.solidBusy ? "" : " disabled"}>Congé</button>
          <label>Distance (${u}) <input data-solid="rf.distance" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(st.rf.distance)}"/></label><button type="button" data-act="solid-chamfer"${ep.picks.length && !st.solidBusy ? "" : " disabled"}>Chanfrein</button>
          <button type="button" class="secondary" data-act="edgePick">Terminer</button>`
        : `<button type="button" data-act="edgePick"${busy}>Choisir des arêtes (congé, chanfrein)</button><span class="hint">Toute arête, droite ou courbe.</span>`}</div>`;
    }
    h += `<div class="sk-solid-controls"><span class="sk-add-title">Balayage</span>
      ${st.sweepProfile ? `<span class="hint">Profil retenu (${st.sweepProfile.length} objet(s)). Sélectionne maintenant le chemin (autre esquisse).</span><button type="button" data-act="solid-sweep"${selected.length && !st.solidBusy ? "" : " disabled"}>Balayer le long de la sélection</button><button type="button" class="secondary" data-act="sweepReset">Annuler</button>`
      : `<button type="button" data-act="sweepProfile"${selected.length ? "" : " disabled"}>Retenir ce profil</button><span class="hint">Un profil fermé, puis un chemin de lignes ou d'arcs.</span>`}</div>
      <div class="sk-solid-controls"><span class="sk-add-title">Lissage</span>
      <button type="button" data-act="loftAdd"${selected.length ? "" : " disabled"}>Ajouter ce profil (${st.loftProfiles.length})</button>
      <button type="button" data-act="solid-loft"${st.loftProfiles.length >= 2 && !st.solidBusy ? "" : " disabled"}>Lisser</button>${st.loftProfiles.length ? `<button type="button" class="secondary" data-act="loftReset">Vider</button>` : ""}
      <span class="hint">Des profils fermés sur des esquisses parallèles (par ex. base et plan XY décalé).</span></div></div>`;
    return h;
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
      return { sig: "face:" + fr.plane + ":" + fr.offset, title: "Face " + fr.plane + " · " + S.fmt(fr.offset) + " " + u, fields: [],
        actions: [{ key: "faceSketch", label: "Esquisser sur la face", primary: true }, { key: "faceClose", label: "Fermer", kind: "quiet" }],
        note: "Dessine un contour sur la face, puis ajoute ou enlève de la matière." };
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
    const closed = profile.length && profile.every(id => { const o = S.getObj(st.doc, id); return o && (S.isLine(o) || o.type === "circle" || o.type === "arc"); }) &&
      (profile.length > 1 || (S.getObj(st.doc, profile[0]) || {}).type === "circle");
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
      geo("parallel", "∥"); geo("perpendicular", "⊥"); geo("equal", "=");
    } else if (sel.length === 2 && lines.length === 1 && rounds.length === 1) { title = "Ligne et arrondi"; geo("tangent", "Tangentes"); }
    else if (sel.length === 2 && rounds.length === 2) { title = "Deux arrondis"; geo("tangent", "Tangents"); geo("equal", "Même rayon"); }
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
    if (st.solidBusy) return false;
    const version = st.meshVersion;
    st.solidBusy = true;
    try {
      let tris = [], edges = [], mass = null;
      if ((next.features || []).length) {
        const check = await window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: next }), timeoutMs: 45000 });
        tris = check.triangles; edges = check.edges || []; mass = check.mass || null;
      }
      if (version !== st.meshVersion) throw new Error("Le dessin a changé pendant le calcul : réessaie");
      st.preview3d = null;
      commit(next); st.mesh = tris; st.edges = edges; st.mass = mass; st.meshLoadedVersion = st.meshVersion;
      clearTimeout(st.meshTimer);
      st.faceSelection = null; st.edgeSelection = null; $(".sk-face-start", root).hidden = true;
      if (solidView) { solidView.setTriangles(tris); solidView.setEdges(edges); }
      $(".sk-3d-status", root).textContent = tris.length ? `${tris.length} triangles · glisse pour tourner · deux doigts ou clic droit pour déplacer · pince ou molette pour zoomer` : "Crée une extrusion pour voir la pièce.";
      if (okMsg) say(okMsg);
      return true;
    } catch (e) { say((e && e.message) || "Refusé", "err"); flashHud((e && e.message) || "Refusé"); return false; }
    finally { st.solidBusy = false; renderSolid(); }
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
    if (!st.tab3d) setView3d(true);
    if (st.preview3d == null) {
      if (solidView) { solidView.setTriangles(st.mesh); solidView.setEdges(st.edges); }
      $(".sk-3d-status", root).textContent = st.mesh.length + " triangles · état actuel";
      return;
    }
    let tris = st.histMesh.get(steps[i].sig);
    if (!tris) {
      try {
        const res = await window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: steps[i].doc }), timeoutMs: 45000 });
        tris = res.triangles || [];
        if (st.histMesh.size > 30) st.histMesh.clear();
        st.histMesh.set(steps[i].sig, tris);
      } catch (e) { say((e && e.message) || "Étape illisible", "err"); return; }
    }
    if (st.preview3d !== i) return; // the slider moved on meanwhile
    if (solidView) { solidView.setTriangles(tris); solidView.setEdges([]); }
    $(".sk-3d-status", root).textContent = "Aperçu de l'étape " + (i + 1) + " : rien n'est modifié tant que tu ne reviens pas à cette étape";
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
  }
  function setView3d(on) {
    if (st.split) { if (on) { scheduleMesh(); return; } st.split = false; root.querySelector(".sk").classList.remove("is-split"); root.querySelector('[data-act="viewSplit"]').setAttribute("aria-selected", "false"); }
    if (!on && faceSketch) faceSketch.close();
    if (bubble2d && on) bubble2d.hide();
    st.tab3d = on;
    $(".sk-stage", root).hidden = on; $(".sk-3d-stage", root).hidden = !on;
    root.querySelector('[data-act="view2d"]').setAttribute("aria-selected", on ? "false" : "true");
    root.querySelector('[data-act="view3d"]').setAttribute("aria-selected", on ? "true" : "false");
    if (on) scheduleMesh(); else resize();
    skMotion("view", { tab3d: on });
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
      const res = await window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: st.doc }), timeoutMs: 45000 });
      if (version !== st.meshVersion) return;
      st.mesh = res.triangles; st.edges = res.edges || []; st.meshLoadedVersion = version; st.mass = res.mass || null;
      st.faceSelection = null; st.edgeSelection = null; $(".sk-face-start", root).hidden = true;
      if (solidView) { solidView.setTriangles(st.mesh); solidView.setEdges(st.edges); }
      renderSolid();
      status.textContent = `${res.count} triangles · glisse pour tourner · deux doigts ou clic droit pour déplacer · pince ou molette pour zoomer`;
    } catch (e) { if (version === st.meshVersion) { st.mesh = []; st.edges = []; st.meshLoadedVersion = -1; if (solidView) { solidView.setTriangles([]); solidView.setEdges([]); } status.textContent = e.message; } }
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
  function act(name, el) {
    if (name === "return") { if (st.link) st.link.ret(); return; }
    if (name === "view2d" || name === "view3d") { if (st.split) { st.split = false; root.querySelector(".sk").classList.remove("is-split"); root.querySelector('[data-act="viewSplit"]').setAttribute("aria-selected", "false"); } setView3d(name === "view3d"); return; }
    if (name === "viewSplit") { if (st.split) { setSplit(false); setView3d(false); } else setSplit(true); return; }
    if (name === "reset3d") { if (solidView) solidView.reset(); return; }
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
    if (name === "undo") { const p = st.hist.undo(st.doc); if (p) { st.preview3d = null; st.doc = p; st.meshVersion++; st.dirty = true; scheduleDraft(); refreshAll(); } return; }
    if (name === "redo") { const p = st.hist.redo(st.doc); if (p) { st.preview3d = null; st.doc = p; st.meshVersion++; st.dirty = true; scheduleDraft(); refreshAll(); } return; }
    if (name === "delete") { deleteSel(); return; }
    if (name === "fit") { st.view = S.fitView(st.doc, st.W, st.H, 40, underlayRect()); scheduleDraft(); draw(); return; }
    if (name === "multi") { st.multi = !st.multi; renderToolbar(); updateFloat(); return; }
    if (name === "newSketch") { st.newSketch = !st.newSketch; renderToolbar(); renderProps(); return; }
    if (name === "settings") {
      const s = $(".sk-settings", root); s.hidden = !s.hidden; el.setAttribute("aria-expanded", s.hidden ? "false" : "true"); syncSettings(); return;
    }
    if (name === "save") { openSave(); return; }
    if (name === "open") { openList(); return; }
    if (name === "new") {
      if (st.dirty && st.doc.objects.length && !window.confirm("Commencer un nouveau dessin ? Le dessin actuel non enregistré sera remplacé (Annuler reste possible).")) return;
      const fresh = S.createDoc({ units: st.doc.units, spacing: st.doc.grid.spacing, mode: st.doc.mode });
      fresh.grid = Object.assign({}, st.doc.grid); fresh.snap = Object.assign({}, st.doc.snap);
      st.name = ""; st.stem = ""; st.sel = [];
      commit(fresh);
      st.view = S.fitView(st.doc, st.W, st.H); st.dirty = false; flushDraft(); draw();
    }
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
    if (pid) { st.guides = null; const p = S.pointMap(st.doc).get(pid); return { x: p.x, y: p.y, id: pid }; }
    return aligned(m, e, st.doc.grid.snap ? S.snapGrid(m, st.doc.grid.spacing) : { x: m.x, y: m.y });
  }
  function snapEnd(from, m, e) {
    const pid = S.findPointNear(vdoc(), m.x, m.y, tolPx(e) / st.view.ppu);
    if (pid && pid !== from.id) { st.guides = null; const p = S.pointMap(st.doc).get(pid); return { x: p.x, y: p.y, id: pid }; }
    return aligned(m, e, S.snapSegmentEnd(from, m, { angle: st.doc.snap.angle, angleStep: st.doc.snap.angleStep, grid: st.doc.grid.snap, spacing: st.doc.grid.spacing }));
  }
  function annotSnap(m, e) {
    const pid = S.findPointNear(vdoc(), m.x, m.y, tolPx(e) / st.view.ppu);
    if (pid) { const p = S.pointMap(st.doc).get(pid); return { x: p.x, y: p.y, id: pid }; }
    return st.doc.grid.snap ? S.snapGrid(m, st.doc.grid.spacing / 2) : m;
  }

  // ------------------------------------------------------------ pointer handling
  function onDown(e) {
    if (!textIn.hidden) finishText(true);
    if (e.pointerType === "pen") st.penSeen = true;
    canvas.setPointerCapture(e.pointerId);
    st.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    e.preventDefault();
    const touches = [...st.ptrs.values()].filter(p => p.type === "touch");
    if (touches.length >= 2) { startGesture(); return; }
    if (st.gesture) return;
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
    const hit = S.hitTest(vdoc(), m.x, m.y, tolPx(e) / st.view.ppu);
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
  function cancelAction() { st.action = null; st.hudMsg = ""; if (canvas) draw(); }

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
    const s = screenAt(e);
    if (e.ctrlKey || !e.shiftKey) {
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
      st.view = S.zoomAt(st.view, st.H, s.x, s.y, f, minPpu(), maxPpu());
    } else {
      st.view = { x0: st.view.x0 + e.deltaY / st.view.ppu, y0: st.view.y0, ppu: st.view.ppu };
    }
    scheduleDraft(); draw();
  }
  function hover(e) {
    if (st.action) { if (st.action.click) toolMove(e, [e]); return; } // click-click shapes follow the pointer
    const m = modelAt(e);
    if (st.arcPending) { st.arcHover = m; draw(); }
    setHud(m);
  }

  // ------------------------------------------------------------ tools
  function toolDown(e) {
    const m = modelAt(e), id = e.pointerId, tool = st.tool;
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
    if (tool === "line" || tool === "centerline" || tool === "rect" || tool === "circle") {
      const a = snapStart(m, e);
      st.action = { kind: tool, id: id, a: a, b: a }; draw(); return;
    }
    if (tool === "arc") {
      if (st.arcPending) { st.action = { kind: "arcEnd", id: id }; st.arcHover = m; draw(); return; }
      const a = snapStart(m, e);
      st.action = { kind: "arc", id: id, a: a, b: null }; draw(); return;
    }
  }

  function toolMove(e, events) {
    const a = st.action, m = modelAt(e);
    if (a.kind === "pen") {
      const minD = 1.5 / st.view.ppu;
      for (const ev of events) {
        const p = modelAt(ev), last = a.pts[a.pts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) >= minD && a.pts.length < S.LIMITS.strokePts * 4) {
          const pressure = ev.pointerType === "pen" && ev.pressure > 0 ? ev.pressure : 0;
          if (pressure) a.pressure = true;
          a.pts.push(pressure ? [p.x, p.y, Math.round((0.35 + 0.65 * Math.min(1, pressure)) * 100) / 100] : [p.x, p.y]);
        }
      }
      draw(); return;
    }
    if (a.kind === "erase") { eraseAt(m, e); return; }
    if (a.kind === "move") {
      let dx = m.x - a.start.x, dy = m.y - a.start.y;
      if (st.doc.grid.snap) { const g = st.doc.grid.spacing; dx = Math.round(dx / g) * g; dy = Math.round(dy / g) * g; }
      if (Math.hypot(m.x - a.start.x, m.y - a.start.y) * st.view.ppu > 3) a.moved = true;
      if (!a.moved) return;
      a.res = S.moveObjects(a.base, st.sel, dx, dy);
      st.hudMsg = a.res.ok ? "Δ " + S.fmt(dx) + ", " + S.fmt(dy) + " " + st.doc.units : a.res.error; st.hudErr = !a.res.ok;
      draw(a.res.ok ? a.res.doc : null); setHud(m); return;
    }
    if (a.kind === "point") {
      const o = S.getObj(a.base, st.sel[0]);
      const other = S.pointMap(a.base).get(S.otherEnd(o, a.pid));
      const p = snapEnd({ x: other.x, y: other.y, id: other.id }, m, e);
      a.res = S.movePoint(a.base, a.pid, p.x, p.y);
      st.hudMsg = a.res.ok ? "L " + S.fmt(Math.hypot(p.x - other.x, p.y - other.y)) + " " + st.doc.units : a.res.error; st.hudErr = !a.res.ok;
      draw(a.res.ok ? a.res.doc : null); setHud(m); return;
    }
    if (a.kind === "dimlin") { a.b = annotSnap(m, e); draw(); setHud(m, a.a, a.b); return; }
    if (a.kind === "box") { a.b = m; draw(); return; }
    if (a.kind === "line" || a.kind === "centerline") { a.b = a.pointer = snapEnd(a.a, m, e); applyTyped(a); draw(); if (st.typed) setHud(); else setHud(m, a.a, a.b); return; }
    if (a.kind === "rect") { a.b = a.pointer = snapStart(m, e); applyTyped(a); draw(); if (st.typed) setHud(); else setHud(m, a.a, a.b, true); return; }
    if (a.kind === "arc") { a.b = snapStart(m, e); st.hudMsg = "R " + S.fmt(Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y)) + " " + st.doc.units; draw(); setHud(m); return; }
    if (a.kind === "arcEnd") { st.arcHover = m; draw(); return; }
    if (a.kind === "circle") {
      let r = Math.hypot(m.x - a.a.x, m.y - a.a.y);
      if (st.doc.grid.snap) r = Math.max(st.doc.grid.spacing / 2, Math.round(r / (st.doc.grid.spacing / 2)) * (st.doc.grid.spacing / 2));
      a.r = r; a.b = a.pointer = m; applyTyped(a); draw(); if (!st.typed) st.hudMsg = "R " + S.fmt(a.r) + " " + st.doc.units + " · Ø " + S.fmt(2 * a.r); setHud(m); return;
    }
  }

  function toolUp(e) {
    const a = st.action; st.action = null; st.hudMsg = ""; st.hudErr = false;
    const m = modelAt(e);
    if (a.kind === "pen") {
      if (a.pressure) {
        const ks = a.pts.map(p => p.length > 2 ? p[2] : 1);
        mutate(d => { S.withSketch(d, st.sketch, x => S.addStroke(x, a.pts, 0.6 / st.view.ppu, { w: 2.2 / st.view.ppu, k: ks })); });
      } else mutate(d => { S.withSketch(d, st.sketch, x => S.addStroke(x, a.pts, 0.6 / st.view.ppu)); });
      return;
    }
    if (a.kind === "erase") { draw(); return; }
    if (a.kind === "move") {
      if (!a.moved || !a.res) { draw(); return; }
      if (a.res.ok) { st.hist.push(a.base); st.doc = a.res.doc; st.doc.view = st.view; st.dirty = true; scheduleDraft(); refreshAll(); }
      else { say(a.res.error, "err"); draw(); }
      return;
    }
    if (a.kind === "point") {
      if (a.res && a.res.ok) { st.hist.push(a.base); st.doc = a.res.doc; st.dirty = true; scheduleDraft(); refreshAll(); }
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
        const id = mutate(d => S.withSketch(d, st.sketch, x => S.addDimAngle(x, c, p1, p2, r, "")));
        if (id) { st.sel = [id]; refreshAll(); }
      } else draw();
      return;
    }
    if (a.kind === "dimlin") {
      if (S.measureLinear([a.a.x, a.a.y], [a.b.x, a.b.y]) * st.view.ppu < 6) { draw(); return; }
      const id = mutate(d => S.withSketch(d, st.sketch, x => S.addDimLinear(x, [a.a.x, a.a.y], [a.b.x, a.b.y], st.doc.grid.spacing, "")));
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
    const hits = S.hitAll(vdoc(), m.x, m.y, tol);
    if (!hits.length) return false;
    const a = st.action;
    const next = S.deleteObjects(st.doc, hits);
    if (a && a.kind === "erase" && !a.pushed) { st.hist.push(st.doc); a.pushed = true; }
    else if (st.remote && st.remote.erase && !st.remote.pushed) { st.hist.push(st.doc); st.remote.pushed = true; }
    st.doc = next; st.dirty = true; st.sel = st.sel.filter(id => !hits.includes(id));
    scheduleDraft(); updateButtons(); draw();
    return true;
  }
  function eraseAt(m, e) { eraseModel(m, tolPx(e) / st.view.ppu); }

  function onDouble(e) {
    const m = modelAt(e);
    const hit = S.hitTest(vdoc(), m.x, m.y, tolPx(e) / st.view.ppu);
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
    } else if (sel.length === 1 && sel[0].type === "circle") {
      h = `<div class="sk-prop-head"><strong>Cercle ${esc(sel[0].id)}</strong> · Ø ${S.fmt(sel[0].r * 2)} ${u}</div>
        <div class="sk-row"><label>Rayon (${u})<input data-edit="r" type="number" inputmode="decimal" step="any" min="0" value="${S.fmt(sel[0].r)}"/></label></div>`;
    } else {
      h = `<div class="sk-prop-head"><strong>${sel.length} objet(s)</strong></div><p class="sk-hint">Glisse pour déplacer, 🗑 pour supprimer. Sélectionne deux lignes reliées pour coter leur angle.</p>`;
    }
    if (st.newSketch && inV6()) {
      h = `<div class="sk-prop-head"><strong>Nouvelle esquisse</strong></div>
        <div class="sk-row"><label>Plan <select data-ns="plane">${Object.entries(S.SKETCH_PLANES).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join("")}</select></label>
        <label>Décalage (${u})<input data-ns="offset" type="number" inputmode="decimal" step="any" value="0"/></label>
        <label class="sk-grow">Nom<input data-ns="name" type="text" maxlength="40" placeholder="Face avant"/></label>
        <button type="button" data-do="createSketch">Créer</button><button type="button" class="secondary" data-do="cancelSketch">Annuler</button></div>
        <p class="sk-hint">L'esquisse se dessine à plat ; sa pièce 3D se place sur ce plan (XZ : vue de face, YZ : vue de côté).</p>` + h;
    }
    if (inV6() && st.doc.mode === "construction" && sel.length) h += constraintPanel(sel, u);
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
    if (lines.length === 2 && sel.length === 2) opts += b("parallel", "Parallèles") + b("perpendicular", "Perpendiculaires") + b("equal", "Égales");
    if (lines.length === 1 && rounds.length === 1 && sel.length === 2) opts += b("tangent", "Tangentes");
    if (rounds.length === 2 && sel.length === 2) opts += b("tangent", "Tangents") + b("equal", "Même rayon");
    if (rounds.length === 1 && sel.length === 1) opts += `<label>Rayon (${u})<input data-geo-val type="number" inputmode="decimal" step="any" min="0" value="${S.fmt(rounds[0].type === "circle" ? rounds[0].r : S.arcGeom(rounds[0], S.pointMap(st.doc)).r)}"/></label>` + b("radius", "Imposer le rayon");
    if (sel.some(o => S.isLine(o) || o.type === "circle" || o.type === "arc")) opts += b("fixed", "Fixer");
    const ids = new Set(sel.map(o => o.id)), pts = new Set();
    sel.forEach(o => ["p1", "p2", "center"].forEach(k => o[k] && pts.add(o[k])));
    const held = st.doc.constraints.filter(k => S.GEO_CONSTRAINTS.includes(k.type) && (ids.has(k.line) || ids.has(k.item) || (k.items || []).some(x => ids.has(x)) || pts.has(k.point)));
    const NAMES = { horizontal: "Horizontale", vertical: "Verticale", parallel: "Parallèles", perpendicular: "Perpendiculaires", equal: "Égales", tangent: "Tangentes", radius: "Rayon", fixed: "Fixe" };
    const f = S.freedom(st.doc);
    return `<div class="sk-geo"><div class="sk-prop-head"><strong>Contraintes</strong> · ${f.dof ? f.dof + " degré(s) de liberté (bleu = encore libre)" : "esquisse entièrement définie"}</div>
      ${opts ? `<div class="sk-row sk-geo-opts">${opts}</div>` : ""}
      ${held.length ? `<div class="sk-row sk-geo-held">${held.map(k => `<span class="sk-chip on">${esc(NAMES[k.type] + (k.type === "radius" ? " " + S.fmt(k.value) : ""))} <button type="button" class="sk-x" data-unlock="${esc(k.id)}" aria-label="Retirer la contrainte ${esc(NAMES[k.type])}">✕</button></span>`).join("")}</div>` : ""}</div>`;
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
    } else add({ type: type, items: [sel[0].id, sel[1].id] });
    if (err) { say(err, "err"); return; }
    commit(doc);
    say("Contrainte appliquée");
  }
  function onPropsClick(e) {
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
    const k = e.target.dataset.edit;
    if (!k || st.sel.length !== 1) return;
    const patch = {}; patch[k] = k === "text" || k === "label" ? e.target.value : Number(String(e.target.value).replace(",", "."));
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
    hud.innerHTML = `<span>${esc(modeName)}</span><span>Grille ${esc(S.fmt(st.doc.grid.spacing))} ${esc(u)}</span>${pos ? `<span>${esc(pos)}</span>` : ""}${t ? `<strong>${esc(t)}</strong>` : ""}`;
  }
  function flashHud(msg) { st.hudMsg = msg; st.hudErr = true; setHud(); setTimeout(() => { if (st.hudMsg === msg) { st.hudMsg = ""; st.hudErr = false; setHud(); } }, 4000); }

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
  const GLYPH = { horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥", equal: "=", tangent: "T", radius: "R", fixed: "⚓" };
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
    c.fillStyle = T.bg; c.fillRect(0, 0, W, H);
    if (doc.underlay && !o.noUnderlay) drawUnderlay(c, view, H);
    // grid (real-world spacing; adaptive density so it never turns into noise)
    if (doc.grid.visible) {
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
    const O = ts(0, 0);
    c.strokeStyle = T.gridMajor; c.lineWidth = 1; c.beginPath(); c.moveTo(O.x - 8, O.y); c.lineTo(O.x + 8, O.y); c.moveTo(O.x, O.y - 8); c.lineTo(O.x, O.y + 8); c.stroke();

    const pm = S.pointMap(doc), sel = new Set(o.sel || []);
    const font = px => `${Math.max(9, Math.min(200, px))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    for (const ob of doc.objects) {
      const isSel = sel.has(ob.id);
      c.setLineDash([]);
      c.lineCap = "round"; c.lineJoin = "round";
      const free = o.defined && !o.defined.has(ob.id); // v6: blue while it can still move, black once fully defined
      if (S.isLine(ob)) {
        const a = ts(pm.get(ob.p1).x, pm.get(ob.p1).y), b = ts(pm.get(ob.p2).x, pm.get(ob.p2).y);
        c.strokeStyle = isSel ? T.sel : (ob.type === "centerline" ? T.axis : free ? FREE_INK : T.ink);
        c.lineWidth = isSel ? 3 : (ob.type === "centerline" ? 1.4 : 2);
        if (ob.type === "centerline") c.setLineDash([14, 4, 3, 4]);
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      } else if (ob.type === "circle") {
        const ce = ts(pm.get(ob.center).x, pm.get(ob.center).y);
        c.strokeStyle = isSel ? T.sel : free ? FREE_INK : T.ink; c.lineWidth = isSel ? 3 : 2;
        c.beginPath(); c.arc(ce.x, ce.y, ob.r * view.ppu, 0, Math.PI * 2); c.stroke();
        c.lineWidth = 1; c.beginPath(); c.moveTo(ce.x - 4, ce.y); c.lineTo(ce.x + 4, ce.y); c.moveTo(ce.x, ce.y - 4); c.lineTo(ce.x, ce.y + 4); c.stroke();
      } else if (ob.type === "arc") {
        const g = S.arcGeom(ob, pm), ce = ts(g.c.x, g.c.y);
        c.strokeStyle = isSel ? T.sel : free ? FREE_INK : T.ink; c.lineWidth = isSel ? 3 : 2;
        c.beginPath(); c.arc(ce.x, ce.y, g.r * view.ppu, -g.t0, -(g.t0 + g.sweep), true); c.stroke();
        c.lineWidth = 1; c.beginPath(); c.moveTo(ce.x - 3, ce.y); c.lineTo(ce.x + 3, ce.y); c.moveTo(ce.x, ce.y - 3); c.lineTo(ce.x, ce.y + 3); c.stroke();
      } else if (ob.type === "stroke") {
        const basePx = ob.w > 0 ? ob.w * view.ppu : (isSel ? 3 : 2);
        c.strokeStyle = isSel ? T.sel : T.ref;
        c.lineCap = "round"; c.lineJoin = "round";
        if (!ob.k || ob.k.length !== ob.pts.length) {
          c.lineWidth = isSel && !(ob.w > 0) ? 3 : Math.max(0.6, basePx);
          c.beginPath();
          ob.pts.forEach((p, i) => { const s = ts(p[0], p[1]); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); });
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
        const s = ts(ob.x, ob.y);
        c.fillStyle = isSel ? T.sel : T.note; c.font = font(ob.h * view.ppu); c.textBaseline = "alphabetic";
        c.fillText(ob.text, s.x, s.y);
        if (isSel) { const b = S.textBox(ob), p0 = ts(b[0], b[3]), p1 = ts(b[2], b[1]); c.strokeStyle = T.sel; c.lineWidth = 1; c.setLineDash([4, 3]); c.strokeRect(p0.x - 3, p0.y - 3, p1.x - p0.x + 6, p1.y - p0.y + 6); }
      } else if (ob.type === "dim_linear") drawDimLinear(c, ob, ts, view, T, isSel, doc);
      else if (ob.type === "dim_angle") drawDimAngle(c, ob, ts, view, T, isSel);
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
    if (o.sel && o.sel.length === 1) {
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
  function drawDimLinear(c, o, ts, view, T, isSel, doc) {
    const g = S.dimLinearGeom(o); if (!g) return;
    const col = isSel ? T.sel : T.dim;
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1.2;
    const A = ts(o.a[0], o.a[1]), B = ts(o.b[0], o.b[1]), A2 = ts(g.a2[0], g.a2[1]), B2 = ts(g.b2[0], g.b2[1]);
    const ext = Math.sign(o.offset || 1) * 6;
    const nsx = -(B2.y - A2.y), nsy = B2.x - A2.x, nl = Math.hypot(nsx, nsy) || 1;
    const sgn = ((A2.x - A.x) * nsx + (A2.y - A.y) * nsy) >= 0 ? 1 : -1;
    c.beginPath();
    c.moveTo(A.x, A.y); c.lineTo(A2.x + nsx / nl * Math.abs(ext) * sgn, A2.y + nsy / nl * Math.abs(ext) * sgn);
    c.moveTo(B.x, B.y); c.lineTo(B2.x + nsx / nl * Math.abs(ext) * sgn, B2.y + nsy / nl * Math.abs(ext) * sgn);
    c.moveTo(A2.x, A2.y); c.lineTo(B2.x, B2.y); c.stroke();
    const ang = Math.atan2(B2.y - A2.y, B2.x - A2.x);
    arrow(c, B2.x, B2.y, ang, 9 * FK); arrow(c, A2.x, A2.y, ang + Math.PI, 9 * FK);
    let rot = ang; if (rot > Math.PI / 2 || rot < -Math.PI / 2) rot += Math.PI;
    const label = o.label || S.fmt(g.L);
    const M = ts(g.mid[0], g.mid[1]);
    c.save(); c.translate(M.x, M.y); c.rotate(rot);
    c.font = `600 ${13 * FK}px system-ui, sans-serif`; c.textAlign = "center"; c.textBaseline = "bottom";
    c.fillText(label, 0, -3 * FK); c.restore();
  }
  function drawDimAngle(c, o, ts, view, T, isSel) {
    const col = isSel ? T.sel : T.dim;
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 1.2;
    const C = ts(o.c[0], o.c[1]);
    const a1 = Math.atan2(-(o.a[1] - o.c[1]), o.a[0] - o.c[0]), a2 = Math.atan2(-(o.b[1] - o.c[1]), o.b[0] - o.c[0]);
    let sw = a2 - a1; while (sw > Math.PI) sw -= 2 * Math.PI; while (sw < -Math.PI) sw += 2 * Math.PI;
    const r = o.r * view.ppu;
    c.beginPath(); c.moveTo(C.x, C.y); c.lineTo(C.x + Math.cos(a1) * r * 1.1, C.y + Math.sin(a1) * r * 1.1);
    c.moveTo(C.x, C.y); c.lineTo(C.x + Math.cos(a2) * r * 1.1, C.y + Math.sin(a2) * r * 1.1); c.stroke();
    c.beginPath(); c.arc(C.x, C.y, r, a1, a1 + sw, sw < 0); c.stroke();
    const mid = a1 + sw / 2, label = o.label || (S.fmt(S.measureAngle(o.c, o.a, o.b), 2) + "°");
    c.font = `600 ${13 * FK}px system-ui, sans-serif`; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(label, C.x + Math.cos(mid) * (r + 14 * FK), C.y + Math.sin(mid) * (r + 14 * FK));
    c.textAlign = "start"; c.textBaseline = "alphabetic";
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

  function previewFn() {
    const a = st.action, T = theme(false);
    return (c, ts) => {
      c.setLineDash([]);
      if (a && a.kind === "pen" && a.pts.length) {
        c.strokeStyle = T.ref; c.lineWidth = 2; c.lineCap = "round"; c.lineJoin = "round";
        c.beginPath(); a.pts.forEach((p, i) => { const s = ts(p[0], p[1]); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); }); c.stroke();
      }
      const hv = st.remoteHover;
      if (hv && !st.remote) {
        const h = ts(hv.x, hv.y); c.strokeStyle = T.accent; c.lineWidth = 1.5; c.globalAlpha = 0.8;
        c.beginPath(); c.arc(h.x, h.y, 7, 0, Math.PI * 2); c.stroke(); c.globalAlpha = 1;
        c.fillStyle = T.accent; c.beginPath(); c.arc(h.x, h.y, 1.8, 0, Math.PI * 2); c.fill();
      }
      const rip = st.remoteRipple;
      if (rip && !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
        const age = (window.performance ? performance.now() : Date.now()) - rip.at;
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
      if (st.tool === "dimang") st.angleTaps.forEach((p, i) => { const s = ts(p.x, p.y); c.fillStyle = T.accent; c.beginPath(); c.arc(s.x, s.y, 5, 0, Math.PI * 2); c.fill(); c.fillText(String(i + 1), s.x + 8, s.y - 8); });
    };
  }

  /** At most one redraw per frame for live input (the pad can deliver many points per frame). */
  function drawSoon() {
    if (st.drawRaf) return;
    st.drawRaf = requestAnimationFrame(() => { st.drawRaf = 0; draw(); });
  }
  function draw(previewDoc) {
    if (!ctx || !st.doc || !st.W) return;
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    const shown = S.inSketch(previewDoc || st.doc, st.sketch);
    drawScene(ctx, shown, st.view, st.W, st.H, theme(false), { sel: st.sel, fixedEnd: st.fixedEnd, preview: previewFn(), defined: definedSet(previewDoc || st.doc) });
    drawFaceRef();
    updateFloat();
    if (!st.action) setHud();
  }

  function resize() {
    const stage = $(".sk-stage", root);
    if (!stage) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    st.dpr = Math.min(3, window.devicePixelRatio || 1);
    if (W !== st.W || H !== st.H) {
      canvas.width = Math.round(W * st.dpr); canvas.height = Math.round(H * st.dpr);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
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
      st.stem = res.stem; st.name = String(name).trim() || "croquis"; st.dirty = false; flushDraft();
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
      <div class="sk-row"><a class="sk-link" href="${fileUrl(res.stem, "dxf")}" download>DXF (SolidWorks)</a>${res.files.stl ? `<a class="sk-link" href="${fileUrl(res.stem, "stl")}" download>STL 3D (mm)</a>` : ""}<a class="sk-link" href="${fileUrl(res.stem, "png")}" target="_blank" rel="noopener">PNG</a><a class="sk-link" href="${fileUrl(res.stem, "json")}" download>Document</a></div>`;
  }
  async function openList() {
    const dlg = $("#sk-open-dlg", root), list = $(".sk-list", dlg);
    list.innerHTML = '<p class="hint">Chargement…</p>';
    if (dlg.showModal) dlg.showModal();
    try {
      const res = await window.api("/api/drawings");
      if (!res.items.length) { list.innerHTML = '<p class="hint">Aucun dessin dans Inbox/Drawings.</p>'; return; }
      list.innerHTML = res.items.map(it => `<div class="sk-item">
        ${it.png ? `<img alt="" loading="lazy" src="${fileUrl(it.stem, "png")}"/>` : '<div class="sk-noimg"></div>'}
        <div class="sk-item-body"><strong>${esc(it.stem)}</strong><span class="hint">${esc(new Date(it.mtime * 1000).toLocaleString("fr-CA"))}</span>
        <div class="sk-row"><button type="button" data-open="${esc(it.stem)}">Ouvrir</button>${it.dxf ? `<a class="sk-link" href="${fileUrl(it.stem, "dxf")}" download>DXF</a>` : ""}${it.stl ? `<a class="sk-link" href="${fileUrl(it.stem, "stl")}" download>STL</a>` : ""}</div></div></div>`).join("");
      list.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => { dlg.close(); reopen(b.dataset.open); }));
    } catch (e) { list.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
  }
  async function reopen(stem) {
    if (st.dirty && st.doc.objects.length && !window.confirm("Remplacer le dessin en cours (non enregistré) ? Le brouillon actuel sera perdu.")) return false;
    try {
      const res = await window.api("/api/drawings/open?stem=" + encodeURIComponent(stem));
      const doc = res.doc; const meta = doc.meta || {}; delete doc.meta;
      const ok = S.validateDoc(doc); if (!ok.ok) throw new Error(ok.error);
      st.doc = doc; st.hist.clear(); st.sel = []; st.stem = stem; st.name = meta.name || stem; st.dirty = false;
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
    st.hist.clear(); st.name = ""; st.stem = ""; st.sel = []; st.doc = fresh; st.meshVersion++;
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
    cancel() { st.remote = null; if (canvas) draw(); },
    hover(pt) {
      if (!canvas) return;
      clearTimeout(st.remoteHoverT);
      if (!Array.isArray(pt) || !isFinite(pt[0]) || !isFinite(pt[1])) { st.remoteHover = null; draw(); return; }
      const r = boxOf();
      const goal = S.toModel(st.view, st.H, Math.min(1, Math.max(0, pt[0])) * r.width, Math.min(1, Math.max(0, pt[1])) * r.height);
      st.remoteHoverT = setTimeout(() => { st.remoteHover = null; st.hoverGoal = null; draw(); }, 1500);
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
    stage.appendChild(box);
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
      st.doc = draft.doc; st.name = draft.name; st.stem = draft.stem; st.dirty = draft.dirty;
      if (draft.dirty && draft.doc.objects.length) say("Brouillon restauré (non enregistré)");
    } else st.doc = S.createDoc({ units: "mm", spacing: 10 });
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
