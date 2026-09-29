/* A small touch-friendly profile editor in the selected planar face's own UV coordinates. */
(function (root) {
  "use strict";
  // View math in canvas device pixels: view = { x, y, scale } is the face point at the canvas centre and pixels per face unit.
  const M = {
    fit(triangles, w, h) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const tri of triangles) for (const p of tri) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      if (!(x1 >= x0 && y1 >= y0)) return null;
      const m = Math.min(25, w / 4, h / 4); // 25px margin per side (w - 50), smaller on tiny canvases
      const scale = Math.min((w - 2 * m) / Math.max(x1 - x0, 1), (h - 2 * m) / Math.max(y1 - y0, 1));
      return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, scale };
    },
    toScreen(view, w, h, p) { return [w / 2 + (p[0] - view.x) * view.scale, h / 2 - (p[1] - view.y) * view.scale]; },
    toFace(view, w, h, q) { return [view.x + (q[0] - w / 2) / view.scale, view.y - (q[1] - h / 2) / view.scale]; },
    // Drag by (dx, dy) screen pixels: the face moves with the pointer.
    pan(view, dx, dy) { return { x: view.x - dx / view.scale, y: view.y + dy / view.scale, scale: view.scale }; },
    // Zoom by factor around screen point q, keeping the face point under q fixed; scale is clamped to [min, max].
    zoomAt(view, w, h, q, factor, min, max) {
      const scale = Math.min(max, Math.max(min, view.scale * factor)), p = M.toFace(view, w, h, q);
      return { x: p[0] - (q[0] - w / 2) / scale, y: p[1] + (q[1] - h / 2) / scale, scale };
    },
  };
  const HINT = "Trace un contour fermé. Déplacer : deux doigts ou clic droit · zoom : pincer ou molette.";
  function editor(host, submit) {
    host.innerHTML = `<div class="sk-face-bar"><strong>Croquis sur face</strong><span><button type="button" data-face="fit" title="Recadrer la face">Recadrer</button> <button type="button" data-face="cancel">Fermer</button></span></div>
      <div class="sk-face-tools" role="toolbar" aria-label="Profil sur face">
        <button type="button" data-face-tool="rect">Rectangle</button><button type="button" data-face-tool="circle">Cercle</button>
        <button type="button" data-face-tool="polygon">Contour</button><button type="button" data-face="close">Fermer le contour</button>
        <button type="button" data-face="clear">Effacer</button></div>
      <canvas class="sk-face-canvas" aria-label="Dessiner sur la face" role="img"></canvas>
      <div class="sk-face-controls"><label>Profondeur <input data-face-depth type="number" inputmode="decimal" min="0.001" step="any" value="10"></label>
        <label><input data-face-through type="checkbox"> Traversant (coupe)</label>
        <button type="button" data-face="extrude">Ajouter matière</button><button type="button" data-face="cut">Enlever matière</button></div>
      <p class="sk-face-message" role="status">${HINT}</p>`;
    const canvas = host.querySelector("canvas"), ctx = canvas.getContext("2d"), message = host.querySelector(".sk-face-message");
    let face = null, tool = "rect", profile = [], pending = null, view = null, busy = false, closed = false;
    // Navigation: needFit re-frames on open/resize; pointers tracks active pointers; nav is a pan/pinch gesture in progress.
    let needFit = true, fitScale = 1, nav = null, addedBy = null;
    const pointers = new Map();
    function pressed() { host.querySelectorAll('[data-face-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.faceTool === tool ? 'true' : 'false')); }
    const round = x => Math.round(x * 1e6) / 1e6;
    function fit() {
      const v = M.fit(face.triangles, canvas.width, canvas.height);
      if (v) { view = v; fitScale = v.scale; needFit = false; }
    }
    function screen(p) { return M.toScreen(view, canvas.width, canvas.height, p); }
    // Client (CSS px) -> canvas device px; the canvas backing size differs from its CSS size by devicePixelRatio.
    function device(x, y) { const r = canvas.getBoundingClientRect(); return [(x - r.left) * canvas.width / r.width, (y - r.top) * canvas.height / r.height]; }
    function local(e) { return M.toFace(view, canvas.width, canvas.height, device(e.clientX, e.clientY)).map(round); }
    function zoom(q, factor) { view = M.zoomAt(view, canvas.width, canvas.height, q, factor, fitScale / 20, fitScale * 50); }
    function pinchInfo() { const [a, b] = [...pointers.values()]; return { c: device((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), d: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])) }; }
    function draw() {
      if (!face || !host.offsetWidth) return;
      const dpr = Math.min(2, root.devicePixelRatio || 1), w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; needFit = true; }
      if (needFit || !view) fit();
      if (!view) return;
      ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#f7fafc"; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#d8eee6"; ctx.strokeStyle = "#87ab9e"; ctx.lineWidth = 1.5 * dpr;
      for (const tri of face.triangles) { ctx.beginPath(); tri.forEach((p, i) => { const q = screen(p); if (i) ctx.lineTo(...q); else ctx.moveTo(...q); }); ctx.closePath(); ctx.fill(); ctx.stroke(); }
      const ring = pending && pending.ring || profile;
      if (ring.length) { ctx.beginPath(); ring.forEach((p, i) => { const q = screen(p); if (i) ctx.lineTo(...q); else ctx.moveTo(...q); });
        if (tool !== "polygon" || closed || pending) ctx.closePath(); ctx.strokeStyle = "#056d50"; ctx.lineWidth = 3 * dpr; ctx.stroke(); }
      if (tool === "polygon" && profile.length) for (const p of profile) { const q = screen(p); ctx.beginPath(); ctx.arc(q[0], q[1], 5 * dpr, 0, 2 * Math.PI); ctx.fillStyle = "#056d50"; ctx.fill(); }
    }
    function circle(a, b) { const r = Math.hypot(b[0] - a[0], b[1] - a[1]); return Array.from({ length: 96 }, (_, i) => [round(a[0] + r * Math.cos(i * 2 * Math.PI / 96)), round(a[1] + r * Math.sin(i * 2 * Math.PI / 96))]); }
    function rect(a, b) { return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]; }
    function note(text, error) { message.textContent = text; message.classList.toggle("error", !!error); }
    canvas.addEventListener("pointerdown", e => { if (!face || busy || !view) return; canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (e.button === 1 || e.button === 2 || (e.shiftKey && e.pointerType !== "touch")) { e.preventDefault(); pending = null; nav = { kind: "pan", id: e.pointerId }; draw(); return; }
      if (pointers.size === 2 && (!nav || nav.kind === "pinch")) {
        // Second finger: this is navigation, not drawing. Drop the shape or contour point the first finger just started.
        if (addedBy !== null && pointers.has(addedBy) && tool === "polygon" && !closed) profile.pop();
        pending = null; addedBy = null; nav = { kind: "pinch", ...pinchInfo() }; draw(); return; }
      if (pointers.size > 1 || nav) return;
      const p = local(e); addedBy = null;
      if (tool === "polygon") { if (closed) { profile = []; closed = false; }
        if (profile.length >= 3 && Math.hypot(...p.map((x, i) => x - profile[0][i])) < 10 / view.scale) { closed = true; note("Contour fermé"); draw(); return; }
        if (profile.length >= 500) return note("Trop de points", true); profile.push(p); addedBy = e.pointerId; draw(); }
      else pending = { start: p, id: e.pointerId }; });
    canvas.addEventListener("pointermove", e => {
      const last = pointers.get(e.pointerId);
      if (last && nav) { pointers.set(e.pointerId, [e.clientX, e.clientY]);
        if (nav.kind === "pan" && nav.id === e.pointerId) { const r = canvas.getBoundingClientRect(); view = M.pan(view, (e.clientX - last[0]) * canvas.width / r.width, (e.clientY - last[1]) * canvas.height / r.height); draw(); }
        else if (nav.kind === "pinch" && pointers.size >= 2) { const g = pinchInfo(); zoom(nav.c, g.d / nav.d); view = M.pan(view, g.c[0] - nav.c[0], g.c[1] - nav.c[1]); nav.c = g.c; nav.d = g.d; draw(); }
        return; }
      if (last) pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (!pending || pending.id !== e.pointerId) return; const p = local(e), a = pending.start;
      pending.ring = tool === "rect" ? rect(a, p) : circle(a, p); draw(); });
    function release(e) { pointers.delete(e.pointerId); if (addedBy === e.pointerId) addedBy = null;
      // Finish a gesture only when its pointers are gone; a remaining finger must not start drawing.
      if (nav && (nav.kind === "pinch" ? pointers.size === 0 : nav.id === e.pointerId)) { nav = null; return true; }
      return !!nav; }
    canvas.addEventListener("pointerup", e => { if (release(e)) return; if (!pending || pending.id !== e.pointerId) return; const p = local(e), a = pending.start;
      if (Math.hypot(p[0] - a[0], p[1] - a[1]) > 1e-6) profile = tool === "rect" ? rect(a, p) : circle(a, p);
      pending = null; draw(); });
    canvas.addEventListener("pointercancel", e => { release(e); pending = null; draw(); });
    canvas.addEventListener("wheel", e => { if (!face || !view) return; e.preventDefault();
      zoom(device(e.clientX, e.clientY), Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018))); draw(); }, { passive: false });
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    host.addEventListener("click", async e => {
      const t = e.target.closest("[data-face-tool]"); if (t) { tool = t.dataset.faceTool; profile = []; pending = null; closed = false; pressed(); draw(); return; }
      const b = e.target.closest("[data-face]"); if (!b || busy) return;
      const act = b.dataset.face;
      if (act === "cancel") { close(); return; }
      if (act === "clear") { profile = []; pending = null; closed = false; draw(); return; }
      if (act === "fit") { needFit = true; draw(); return; }
      if (act === "close") { if (tool === "polygon" && profile.length >= 3) { closed = true; note("Contour fermé"); draw(); } else note("Ajoute au moins trois points", true); return; }
      if (act !== "extrude" && act !== "cut") return;
      if (profile.length < 3) return note("Trace d'abord un contour fermé", true);
      if (tool === "polygon" && !closed) return note("Ferme le contour avant de créer la fonction", true);
      const depth = Number(String(host.querySelector("[data-face-depth]").value).replace(",", "."));
      if (!(depth > 0)) return note("Profondeur positive requise", true);
      busy = true; note("Calcul de la pièce…");
      try { await submit(act, face.plane, profile, depth, act === "cut" && host.querySelector("[data-face-through]").checked ? "throughAll" : "blind"); close(); }
      catch (err) { note(err.message || String(err), true); }
      finally { busy = false; }
    });
    // Every face has its own UV frame, so a new face is always re-framed (the old view must not be reused).
    function open(value) { face = value; profile = []; pending = null; closed = false; tool = "rect"; view = null; needFit = true; nav = null; addedBy = null; pointers.clear();
      pressed(); host.hidden = false; note(HINT); requestAnimationFrame(draw); }
    function close() { face = null; view = null; nav = null; pointers.clear(); host.hidden = true; }
    // Read-only hook for the visual tests: current view in canvas device pixels.
    canvas.hqFaceView = () => view && { ...view, width: canvas.width, height: canvas.height };
    if (root.ResizeObserver) new ResizeObserver(draw).observe(canvas);
    return { open, close, draw, get active() { return !!face; } };
  }
  editor.math = M;
  root.HQFaceSketch = editor;
})(window);
