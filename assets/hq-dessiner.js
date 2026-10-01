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
  const TOOLS = {
    quick: [["select", "Sélection", "↖"], ["pen", "Stylo", "✎"], ["eraser", "Gomme", "⌫"], ["text", "Texte", "T"],
      ["dimlin", "Cote", "↔"], ["dimang", "Cote ∠", "∠"], ["pan", "Main", "✋"]],
    construction: [["select", "Sélection", "↖"], ["line", "Ligne", "╱"], ["rect", "Rect.", "▭"], ["circle", "Cercle", "◯"],
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
    centerline: "Glisse pour tracer un axe (trait mixte).",
  };

  const st = {
    doc: null, name: "", stem: "", dirty: false, tool: "select", sel: [], multi: false,
    hist: S.createHistory(100), view: null, W: 0, H: 0, dpr: 1, ptrs: new Map(), gesture: null, action: null,
    penSeen: false, fixedEnd: "p1", swapAngle: false, angleTaps: [], built: false, draftTimer: 0, hudMsg: "",
    tab3d: false, solidDepth: 20, cutDepth: 5, cutThrough: false, solidBusy: false, mesh: [], edges: [], meshVersion: 0, meshLoadedVersion: -1, meshTimer: 0, faceSelection: null, edgeSelection: null, edgeMode: false, roundRadius: 2,
  };
  let root, canvas, ctx, hud, props, textIn, solidView, faceSketch;

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
  function scheduleDraft() {
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
      <button type="button" class="sk-btn sk-save" data-act="save">Enregistrer</button>
    </div>
  </div>
  <div class="sk-tools" role="toolbar" aria-label="Outils"></div>
  <div class="sk-view-tabs" role="tablist" aria-label="Vue du dessin">
    <button type="button" data-act="view2d" role="tab" aria-selected="true">Dessin 2D</button>
    <button type="button" data-act="view3d" role="tab" aria-selected="false">Aperçu 3D</button>
  </div>
  <div class="sk-settings" hidden>
    <label>Unités <select data-set="units"><option value="mm">mm</option><option value="cm">cm</option><option value="m">m</option><option value="in">po (in)</option></select></label>
    <label>Grille <input data-set="spacing" type="number" inputmode="decimal" min="0.001" step="any"/></label>
    <label class="sk-chk"><input data-set="visible" type="checkbox"/> Grille visible</label>
    <label class="sk-chk"><input data-set="gsnap" type="checkbox"/> Accroche grille</label>
    <label class="sk-chk"><input data-set="asnap" type="checkbox"/> Accroche angle</label>
    <label>Pas <select data-set="astep"><option>5</option><option>7.5</option><option>10</option><option>15</option><option>22.5</option><option>30</option><option>45</option><option>90</option></select> °</label>
  </div>
  <div class="sk-stage">
    <canvas class="sk-canvas" aria-label="Zone de dessin" role="img"></canvas>
    <input class="sk-textin" type="text" maxlength="500" enterkeyhint="done" autocomplete="off" aria-label="Texte de la note" hidden/>
    <div class="sk-hud" aria-live="polite"></div>
    <div class="sk-float"><button type="button" class="sk-btn" data-act="undo" aria-label="Annuler">↶</button><button type="button" class="sk-btn" data-act="redo" aria-label="Rétablir">↷</button></div>
  </div>
  <div class="sk-3d-stage" hidden>
    <canvas class="sk-3d-canvas" aria-label="Aperçu 3D interactif" role="img"></canvas>
    <div class="sk-3d-overlay"><span class="sk-3d-status" aria-live="polite"></span><button type="button" data-act="faceSketch" class="sk-face-start" hidden>Dessiner sur cette face</button><button type="button" data-act="roundMode" class="sk-round-mode" aria-pressed="false">Arrondir une arête</button><button type="button" data-act="reset3d">Recentrer</button></div>
    <div class="sk-face-editor" hidden></div>
  </div>
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
        st.faceSelection = face;
        $(".sk-face-start", root).hidden = !face;
        if (face) $(".sk-3d-status", root).textContent = "Face sélectionnée";
      });
      solidView.onEdgeSelect(edge => {
        st.edgeSelection = edge;
        $(".sk-3d-status", root).textContent = edge ? "Arête sélectionnée · choisis un rayon" : "Touche une arête droite convexe de la pièce";
        renderSolid();
      });
    }
    if (window.HQFaceSketch) faceSketch = window.HQFaceSketch($(".sk-face-editor", root), createFaceSolid);
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
    $(".sk-solid", root).addEventListener("input", e => {
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
  }
  function setTool(tool) {
    st.tool = tool; st.angleTaps = []; cancelAction();
    if (tool !== "select") st.multi = false;
    refreshAll();
  }

  function renderToolbar() {
    const mode = st.doc.mode;
    root.querySelector(".sk").dataset.mode = mode;
    root.querySelectorAll(".sk-seg [data-mode]").forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
    const bar = $(".sk-tools", root);
    let h = TOOLS[mode].map(([id, label, ico]) =>
      `<button type="button" class="sk-tool${st.tool === id ? " on" : ""}" data-tool="${id}" aria-pressed="${st.tool === id}"><span class="sk-ico" aria-hidden="true">${ico}</span><span>${label}</span></button>`).join("");
    if (st.tool === "select") h += `<button type="button" class="sk-tool sk-multi${st.multi ? " on" : ""}" data-act="multi" aria-pressed="${st.multi}"><span class="sk-ico" aria-hidden="true">⊕</span><span>Multi</span></button>`;
    bar.innerHTML = h;
  }
  function syncSettings() {
    const s = $(".sk-settings", root), d = st.doc;
    const set = (k, v, prop) => { const el = s.querySelector(`[data-set="${k}"]`); if (el && document.activeElement !== el) el[prop || "value"] = v; };
    set("units", d.units); set("spacing", S.fmt(d.grid.spacing, 6)); set("visible", d.grid.visible, "checked");
    set("gsnap", d.grid.snap, "checked"); set("asnap", d.snap.angle, "checked"); set("astep", String(d.snap.angleStep));
  }
  function updateButtons() {
    const set = (n, off) => root.querySelectorAll(`[data-act="${n}"]`).forEach(el => { el.disabled = off; });
    set("undo", !st.hist.canUndo());
    set("redo", !st.hist.canRedo());
    set("delete", !st.sel.length);
  }

  function selectedProfile() {
    if (!st.sel.length) return [];
    const chosen = st.sel.map(id => S.getObj(st.doc, id)).filter(Boolean);
    if (chosen.length !== 1 || chosen[0].type !== "line") return chosen.map(o => o.id);
    const first = chosen[0];
    if (first.group) return st.doc.objects.filter(o => o.type === "line" && o.group === first.group).map(o => o.id);
    const seen = new Set(), queue = [first];
    while (queue.length) {
      const line = queue.pop(); if (seen.has(line.id)) continue; seen.add(line.id);
      for (const o of st.doc.objects) if (o.type === "line" && !seen.has(o.id) && [o.p1, o.p2].some(p => p === line.p1 || p === line.p2)) queue.push(o);
    }
    return [...seen];
  }

  function renderSolid() {
    const box = $(".sk-solid", root);
    const features = st.doc.features || [], selected = selectedProfile();
    const parts = features.map((f, i) => `<div class="sk-solid-feature"><span>${i + 1}. ${f.type === "extrude" ? "Extrusion" : "Enlèvement"} · ${f.extent === "throughAll" ? "traversant" : S.fmt(f.depth) + " " + esc(st.doc.units)} · ${f.profile.length} objet(s)</span><button type="button" data-act="remove3d" data-feature="${esc(f.id)}" aria-label="Retirer la fonction ${i + 1}">Retirer</button></div>`).join("");
    const faceParts = (st.doc.faceFeatures || []).map((f, i) => `<div class="sk-solid-feature"><span>Face ${i + 1}. ${f.type === "extrude" ? "Ajout" : "Enlèvement"} · ${f.extent === "throughAll" ? "traversant" : S.fmt(f.depth) + " " + esc(st.doc.units)}</span><button type="button" data-act="removeFace3d" data-feature="${esc(f.id)}" aria-label="Retirer la fonction sur face ${i + 1}">Retirer</button></div>`).join("");
    const roundParts = (st.doc.roundFeatures || []).map((f, i) => `<div class="sk-solid-feature"><span>Arrondi ${i + 1} · R ${S.fmt(f.radius)} ${esc(st.doc.units)}</span><button type="button" data-act="removeRound3d" data-feature="${esc(f.id)}" aria-label="Retirer l'arrondi ${i + 1}">Retirer</button></div>`).join("");
    box.innerHTML = `<div class="sk-solid-head"><strong>Pièce 3D</strong><span>${features.length ? features.length + (st.doc.faceFeatures || []).length + (st.doc.roundFeatures || []).length + " fonction(s)" : "Sélectionne un contour fermé en Construction"}</span></div>
      <div class="sk-solid-features">${parts}${faceParts}${roundParts}</div>
      <div class="sk-solid-controls"><span class="hint">Profil : ${selected.length ? selected.length + " objet(s) sélectionné(s)" : "touche un rectangle, un cercle ou plusieurs lignes fermées"}</span>
      ${!features.length ? `<label>Profondeur (${esc(st.doc.units)}) <input data-solid="base-depth" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(st.solidDepth)}"/></label><button type="button" data-act="solid-extrude" ${selected.length && !st.solidBusy ? "" : "disabled"}>Extruder</button>`
      : `<label>Profondeur de coupe (${esc(st.doc.units)}) <input data-solid="cut-depth" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(st.cutDepth)}" ${st.cutThrough ? "disabled" : ""}/></label><label class="sk-chk"><input data-solid="through" type="checkbox" ${st.cutThrough ? "checked" : ""}/> Traversant</label><button type="button" data-act="solid-cut" ${selected.length && !st.solidBusy ? "" : "disabled"}>Enlever matière</button>`}</div>
      ${features.length && st.edgeMode ? `<div class="sk-solid-controls"><label>Rayon (${esc(st.doc.units)}) <input data-solid="round-radius" type="number" inputmode="decimal" min="0.001" step="any" value="${esc(st.roundRadius)}"/></label><button type="button" data-act="roundApply" ${st.edgeSelection && !st.solidBusy ? "" : "disabled"}>Appliquer l'arrondi</button><span class="hint">Sélectionne une arête droite convexe. Le rayon est refusé s'il traverse la pièce ou une autre fonction.</span></div>` : ""}
      <p class="hint">La pièce part du plan Z=0. Pour ajouter ou enlever de la matière sur une face plane, touche la face dans l'aperçu 3D. STL exporté en millimètres.</p>`;
  }

  function setView3d(on) {
    if (!on && faceSketch) faceSketch.close();
    st.tab3d = on;
    $(".sk-stage", root).hidden = on; $(".sk-3d-stage", root).hidden = !on;
    root.querySelector('[data-act="view2d"]').setAttribute("aria-selected", on ? "false" : "true");
    root.querySelector('[data-act="view3d"]').setAttribute("aria-selected", on ? "true" : "false");
    if (on) scheduleMesh(); else resize();
  }

  function scheduleMesh() {
    clearTimeout(st.meshTimer);
    if (!st.tab3d || !st.doc) return;
    if (st.meshLoadedVersion === st.meshVersion) {
      if (solidView) solidView.draw();
      $(".sk-3d-status", root).textContent = st.mesh.length ? `${st.mesh.length} triangles · glisse pour tourner · pince ou molette pour zoomer` : "Crée une extrusion pour voir la pièce.";
      return;
    }
    st.meshTimer = setTimeout(loadMesh, 180);
  }

  async function loadMesh() {
    const version = st.meshVersion, status = $(".sk-3d-status", root);
    if (!(st.doc.features || []).length) { st.mesh = []; st.edges = []; st.meshLoadedVersion = version; if (solidView) { solidView.setTriangles([]); solidView.setEdges([]); } status.textContent = "Crée une extrusion pour voir la pièce."; return; }
    status.textContent = "Calcul du modèle…";
    try {
      const res = await window.api("/api/drawings/mesh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc: st.doc }), timeoutMs: 45000 });
      if (version !== st.meshVersion) return;
      st.mesh = res.triangles; st.edges = res.edges || []; st.meshLoadedVersion = version;
      st.faceSelection = null; st.edgeSelection = null; $(".sk-face-start", root).hidden = true;
      if (solidView) { solidView.setTriangles(st.mesh); solidView.setEdges(st.edges); }
      renderSolid();
      status.textContent = `${res.count} triangles · glisse pour tourner · pince ou molette pour zoomer`;
    } catch (e) { if (version === st.meshVersion) { st.mesh = []; st.edges = []; st.meshLoadedVersion = -1; if (solidView) { solidView.setTriangles([]); solidView.setEdges([]); } status.textContent = e.message; } }
  }

  async function createSolid(kind) {
    if (st.solidBusy) return;
    const profile = selectedProfile();
    const depth = Number(String(kind === "extrude" ? st.solidDepth : st.cutDepth).replace(",", "."));
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
      $(".sk-3d-status", root).textContent = `${check.count} triangles · glisse pour tourner · pince ou molette pour zoomer`;
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
      $(".sk-3d-status", root).textContent = `${check.count} triangles · glisse pour tourner · pince ou molette pour zoomer`;
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
      $(".sk-3d-status", root).textContent = triangles.length ? `${triangles.length} triangles · glisse pour tourner · pince ou molette pour zoomer` : "Crée une extrusion pour voir la pièce.";
      say("Fonction retirée");
    } catch (e) { say("Retrait refusé : " + e.message, "err"); }
    finally { st.solidBusy = false; renderSolid(); }
  }

  // ------------------------------------------------------------ actions
  function act(name, el) {
    if (name === "return") { if (st.link) st.link.ret(); return; }
    if (name === "view2d" || name === "view3d") { setView3d(name === "view3d"); return; }
    if (name === "reset3d") { if (solidView) solidView.reset(); return; }
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
    if (name === "remove3d") { removeSolidFeature(el.dataset.feature, "legacy"); return; }
    if (name === "removeFace3d") { removeSolidFeature(el.dataset.feature, "face"); return; }
    if (name === "removeRound3d") { removeSolidFeature(el.dataset.feature, "round"); return; }
    if (name === "undo") { const p = st.hist.undo(st.doc); if (p) { st.doc = p; st.meshVersion++; st.dirty = true; scheduleDraft(); refreshAll(); } return; }
    if (name === "redo") { const p = st.hist.redo(st.doc); if (p) { st.doc = p; st.meshVersion++; st.dirty = true; scheduleDraft(); refreshAll(); } return; }
    if (name === "delete") { deleteSel(); return; }
    if (name === "fit") { st.view = S.fitView(st.doc, st.W, st.H, 40, underlayRect()); scheduleDraft(); draw(); return; }
    if (name === "multi") { st.multi = !st.multi; renderToolbar(); return; }
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
    const pid = S.findPointNear(st.doc, m.x, m.y, tolPx(e) / st.view.ppu);
    if (pid) { const p = S.pointMap(st.doc).get(pid); return { x: p.x, y: p.y, id: pid }; }
    return st.doc.grid.snap ? S.snapGrid(m, st.doc.grid.spacing) : { x: m.x, y: m.y };
  }
  function snapEnd(from, m, e) {
    const pid = S.findPointNear(st.doc, m.x, m.y, tolPx(e) / st.view.ppu);
    if (pid && pid !== from.id) { const p = S.pointMap(st.doc).get(pid); return { x: p.x, y: p.y, id: pid }; }
    return S.snapSegmentEnd(from, m, { angle: st.doc.snap.angle, angleStep: st.doc.snap.angleStep, grid: st.doc.grid.snap, spacing: st.doc.grid.spacing });
  }
  function annotSnap(m, e) {
    const pid = S.findPointNear(st.doc, m.x, m.y, tolPx(e) / st.view.ppu);
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
    if (panOnly) { st.action = { kind: "pan", last: screenAt(e), id: e.pointerId }; return; }
    if (e.button && e.button !== 0) return;
    toolDown(e);
  }
  function onMove(e) {
    if (!st.ptrs.has(e.pointerId)) { if (e.pointerType === "mouse") hover(e); return; }
    st.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (st.gesture) { moveGesture(); return; }
    if (!st.action || st.action.id !== e.pointerId) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    if (st.action.kind === "pan") {
      const s = screenAt(e);
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
    if (st.action.kind === "pan") { st.action = null; scheduleDraft(); return; }
    toolUp(e);
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
    if (st.action) return;
    const m = modelAt(e);
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
      const hit = S.hitTest(st.doc, m.x, m.y, tol);
      if (!hit) { if (!st.multi && !e.shiftKey) st.sel = []; st.action = { kind: "pan", last: screenAt(e), id: id }; renderProps(); draw(); updateButtons(); return; }
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
  }

  function toolMove(e, events) {
    const a = st.action, m = modelAt(e);
    if (a.kind === "pen") {
      const minD = 1.5 / st.view.ppu;
      for (const ev of events) {
        const p = modelAt(ev), last = a.pts[a.pts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) >= minD && a.pts.length < S.LIMITS.strokePts * 4) a.pts.push([p.x, p.y]);
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
    if (a.kind === "line" || a.kind === "centerline") { a.b = snapEnd(a.a, m, e); draw(); setHud(m, a.a, a.b); return; }
    if (a.kind === "rect") { a.b = snapStart(m, e); draw(); setHud(m, a.a, a.b, true); return; }
    if (a.kind === "circle") {
      let r = Math.hypot(m.x - a.a.x, m.y - a.a.y);
      if (st.doc.grid.snap) r = Math.max(st.doc.grid.spacing / 2, Math.round(r / (st.doc.grid.spacing / 2)) * (st.doc.grid.spacing / 2));
      a.r = r; a.b = m; draw(); st.hudMsg = "R " + S.fmt(r) + " " + st.doc.units + " · Ø " + S.fmt(2 * r); setHud(m); return;
    }
  }

  function toolUp(e) {
    const a = st.action; st.action = null; st.hudMsg = ""; st.hudErr = false;
    const m = modelAt(e);
    if (a.kind === "pen") {
      mutate(d => { S.addStroke(d, a.pts, 0.6 / st.view.ppu); });
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
        const id = mutate(d => S.addDimAngle(d, c, p1, p2, r, ""));
        if (id) { st.sel = [id]; refreshAll(); }
      } else draw();
      return;
    }
    if (a.kind === "dimlin") {
      if (S.measureLinear([a.a.x, a.a.y], [a.b.x, a.b.y]) * st.view.ppu < 6) { draw(); return; }
      const id = mutate(d => S.addDimLinear(d, [a.a.x, a.a.y], [a.b.x, a.b.y], st.doc.grid.spacing, ""));
      if (id) { st.sel = [id]; refreshAll(); }
      return;
    }
    if (a.kind === "line" || a.kind === "centerline") {
      if (Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y) * st.view.ppu < 4) { draw(); return; }
      const id = mutate(d => S.addLine(d, a.a, a.b, a.kind) || false);
      if (id) { st.sel = [id]; st.fixedEnd = "p1"; refreshAll(); }
      return;
    }
    if (a.kind === "rect") {
      const r = mutate(d => S.addRect(d, a.a, { x: a.b.x, y: a.b.y, id: a.b.id }) || false);
      if (!r) draw();
      return;
    }
    if (a.kind === "circle") {
      if (!(a.r > 0) || a.r * st.view.ppu < 3) { draw(); return; }
      const id = mutate(d => S.addCircle(d, a.a, a.r) || false);
      if (id) { st.sel = [id]; refreshAll(); }
    }
  }

  function eraseAt(m, e) {
    const hits = S.hitAll(st.doc, m.x, m.y, tolPx(e) / st.view.ppu);
    if (!hits.length) return;
    const a = st.action;
    const next = S.deleteObjects(st.doc, hits);
    if (a && !a.pushed) { st.hist.push(st.doc); a.pushed = true; }
    st.doc = next; st.dirty = true; st.sel = st.sel.filter(id => !hits.includes(id));
    scheduleDraft(); updateButtons(); draw();
  }

  function onDouble(e) {
    const m = modelAt(e);
    const hit = S.hitTest(st.doc, m.x, m.y, tolPx(e) / st.view.ppu);
    const o = hit && S.getObj(st.doc, hit);
    if (o && o.type === "text") openTextInput({ x: o.x, y: o.y }, o.id);
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
    const id = mutate(d => S.addText(d, x, y, v, niceHeight(16 / st.view.ppu)) || false);
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
    props.innerHTML = h;
    renderSolid();
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
    const d = e.target.closest("[data-do]");
    if (!d) return;
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
      if (S.isLine(ob)) {
        const a = ts(pm.get(ob.p1).x, pm.get(ob.p1).y), b = ts(pm.get(ob.p2).x, pm.get(ob.p2).y);
        c.strokeStyle = isSel ? T.sel : (ob.type === "centerline" ? T.axis : T.ink);
        c.lineWidth = isSel ? 3 : (ob.type === "centerline" ? 1.4 : 2);
        if (ob.type === "centerline") c.setLineDash([14, 4, 3, 4]);
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      } else if (ob.type === "circle") {
        const ce = ts(pm.get(ob.center).x, pm.get(ob.center).y);
        c.strokeStyle = isSel ? T.sel : T.ink; c.lineWidth = isSel ? 3 : 2;
        c.beginPath(); c.arc(ce.x, ce.y, ob.r * view.ppu, 0, Math.PI * 2); c.stroke();
        c.lineWidth = 1; c.beginPath(); c.moveTo(ce.x - 4, ce.y); c.lineTo(ce.x + 4, ce.y); c.moveTo(ce.x, ce.y - 4); c.lineTo(ce.x, ce.y + 4); c.stroke();
      } else if (ob.type === "stroke") {
        c.strokeStyle = isSel ? T.sel : T.ref; c.lineWidth = isSel ? 3 : 2;
        c.beginPath();
        ob.pts.forEach((p, i) => { const s = ts(p[0], p[1]); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); });
        if (ob.pts.length === 1) { const s = ts(ob.pts[0][0], ob.pts[0][1]); c.lineTo(s.x + 0.1, s.y); }
        c.stroke();
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
      if (a && a.kind === "circle" && a.r) {
        const s = ts(a.a.x, a.a.y); c.strokeStyle = T.accent; c.lineWidth = 2; c.beginPath(); c.arc(s.x, s.y, a.r * st.view.ppu, 0, Math.PI * 2); c.stroke(); ring(a.a);
      }
      if (st.tool === "dimang") st.angleTaps.forEach((p, i) => { const s = ts(p.x, p.y); c.fillStyle = T.accent; c.beginPath(); c.arc(s.x, s.y, 5, 0, Math.PI * 2); c.fill(); c.fillText(String(i + 1), s.x + 8, s.y - 8); });
    };
  }

  function draw(previewDoc) {
    if (!ctx || !st.doc || !st.W) return;
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    drawScene(ctx, previewDoc || st.doc, st.view, st.W, st.H, theme(false), { sel: st.sel, fixedEnd: st.fixedEnd, preview: previewFn() });
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
    if (name == null) return;
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
      showSaved(res);
      if (st.link && st.link.onSaved) { try { st.link.onSaved({ stem: res.stem, parent: res.parent || "" }); } catch (_) {} }
    } catch (e) { say("Échec de l'enregistrement : " + e.message, "err"); }
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

  // ------------------------------------------------------------ keyboard
  function onKey(e) {
    if (document.body.dataset.view !== "dessiner" || !st.doc) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === "z") { e.preventDefault(); act(e.shiftKey ? "redo" : "undo"); return; }
    if (mod && k === "y") { e.preventDefault(); act("redo"); return; }
    if (mod) return;
    if (k === "delete" || k === "backspace") { if (st.sel.length) { e.preventDefault(); deleteSel(); } return; }
    if (k === "escape") { st.sel = []; st.angleTaps = []; cancelAction(); refreshAll(); return; }
    const map = { v: "select", p: "pen", e: "eraser", t: "text", d: "dimlin", l: "line", r: "rect", c: "circle", a: "centerline", h: "pan" };
    if (map[k]) {
      const tool = map[k];
      if (!TOOLS[st.doc.mode].some(x => x[0] === tool)) setMode(st.doc.mode === "quick" ? "construction" : "quick");
      setTool(tool);
    }
  }

  // ------------------------------------------------------------ entry
  function init() {
    if (st.built) return true;
    if (!build()) return false;
    st.built = true;
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
