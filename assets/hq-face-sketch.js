/* A small touch-friendly profile editor in the selected planar face's own UV coordinates. */
(function (root) {
  "use strict";
  function editor(host, submit) {
    host.innerHTML = `<div class="sk-face-bar"><strong>Croquis sur face</strong><button type="button" data-face="cancel">Fermer</button></div>
      <div class="sk-face-tools" role="toolbar" aria-label="Profil sur face">
        <button type="button" data-face-tool="rect">Rectangle</button><button type="button" data-face-tool="circle">Cercle</button>
        <button type="button" data-face-tool="polygon">Contour</button><button type="button" data-face="close">Fermer le contour</button>
        <button type="button" data-face="clear">Effacer</button></div>
      <canvas class="sk-face-canvas" aria-label="Dessiner sur la face" role="img"></canvas>
      <div class="sk-face-controls"><label>Profondeur <input data-face-depth type="number" inputmode="decimal" min="0.001" step="any" value="10"></label>
        <label><input data-face-through type="checkbox"> Traversant (coupe)</label>
        <button type="button" data-face="extrude">Ajouter matière</button><button type="button" data-face="cut">Enlever matière</button></div>
      <p class="sk-face-message" role="status">Trace un contour fermé sur la face.</p>`;
    const canvas = host.querySelector("canvas"), ctx = canvas.getContext("2d"), message = host.querySelector(".sk-face-message");
    let face = null, tool = "rect", profile = [], pending = null, view = null, busy = false, closed = false;
    function pressed() { host.querySelectorAll('[data-face-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.faceTool === tool ? 'true' : 'false')); }
    const round = x => Math.round(x * 1e6) / 1e6;
    function fit() {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const tri of face.triangles) for (const p of tri) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      const w = canvas.width, h = canvas.height;
      const scale = Math.min((w - 50) / Math.max(x1 - x0, 1), (h - 50) / Math.max(y1 - y0, 1));
      view = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, scale };
    }
    function screen(p) { return [canvas.width / 2 + (p[0] - view.x) * view.scale, canvas.height / 2 - (p[1] - view.y) * view.scale]; }
    function local(e) {
      const r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) * canvas.width / r.width, y = (e.clientY - r.top) * canvas.height / r.height;
      return [round(view.x + (x - canvas.width / 2) / view.scale), round(view.y - (y - canvas.height / 2) / view.scale)];
    }
    function draw() {
      if (!face || !host.offsetWidth) return;
      const dpr = Math.min(2, root.devicePixelRatio || 1), w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; fit(); }
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
    canvas.addEventListener("pointerdown", e => { if (!face || busy) return; canvas.setPointerCapture(e.pointerId); const p = local(e);
      if (tool === "polygon") { if (closed) { profile = []; closed = false; }
        if (profile.length >= 3 && Math.hypot(...p.map((x, i) => x - profile[0][i])) < 10 / view.scale) { closed = true; note("Contour fermé"); draw(); return; }
        if (profile.length >= 500) return note("Trop de points", true); profile.push(p); draw(); }
      else pending = { start: p, id: e.pointerId }; });
    canvas.addEventListener("pointermove", e => { if (!pending || pending.id !== e.pointerId) return; const p = local(e), a = pending.start;
      pending.ring = tool === "rect" ? rect(a, p) : circle(a, p); draw(); });
    canvas.addEventListener("pointerup", e => { if (!pending || pending.id !== e.pointerId) return; const p = local(e), a = pending.start;
      if (Math.hypot(p[0] - a[0], p[1] - a[1]) > 1e-6) profile = tool === "rect" ? rect(a, p) : circle(a, p);
      pending = null; draw(); });
    canvas.addEventListener("pointercancel", () => { pending = null; draw(); });
    host.addEventListener("click", async e => {
      const t = e.target.closest("[data-face-tool]"); if (t) { tool = t.dataset.faceTool; profile = []; pending = null; closed = false; pressed(); draw(); return; }
      const b = e.target.closest("[data-face]"); if (!b || busy) return;
      const act = b.dataset.face;
      if (act === "cancel") { close(); return; }
      if (act === "clear") { profile = []; pending = null; closed = false; draw(); return; }
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
    function open(value) { face = value; profile = []; pending = null; closed = false; tool = "rect"; pressed(); host.hidden = false; note("Trace un contour fermé sur la face."); requestAnimationFrame(draw); }
    function close() { face = null; host.hidden = true; }
    if (root.ResizeObserver) new ResizeObserver(draw).observe(canvas);
    return { open, close, draw, get active() { return !!face; } };
  }
  root.HQFaceSketch = editor;
})(window);
