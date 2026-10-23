/* Forge Studio, phase I: retouch a zone with a finger. The mask is drawn on a canvas at the
   image's natural size and sent once, as a POST body, to this PC's Forge (img2img, never a
   worker). Nothing goes to browser storage; for a private image the prompt and mask live only
   in this page's memory and everything here is wiped when the dialog closes or the vault locks. */
(function () {
  const $ = (id) => document.getElementById(id);
  const H = window.hqForgeHooks;
  const dialog = $("forge-inpaint");
  if (!H || !dialog) return;
  const img = $("forge-inpaint-img");
  const canvas = $("forge-inpaint-canvas");
  const ctx = canvas.getContext("2d");
  const brush = $("forge-inpaint-brush");
  const undoBtn = $("forge-inpaint-undo");
  const clearBtn = $("forge-inpaint-clear");
  const invert = $("forge-inpaint-invert");
  const prompt = $("forge-inpaint-prompt");
  const denoise = $("forge-inpaint-denoise");
  const blur = $("forge-inpaint-blur");
  const fill = $("forge-inpaint-fill");
  const fullRes = $("forge-inpaint-fullres");
  const send = $("forge-inpaint-send");
  const note = $("forge-inpaint-note");
  const where = $("forge-inpaint-where");
  const modelNote = $("forge-inpaint-model");
  const HINT = note.textContent;
  let source = null; /* {kind, id} */
  let stored = {}; /* the source image's settings, in memory only */
  let strokes = [];
  let drawing = null;
  let polling = 0;
  let busy = false;

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#ff3b3b";
    ctx.fillStyle = "#ff3b3b";
    for (const s of strokes) {
      ctx.lineWidth = s.size;
      if (s.points.length === 1) {
        ctx.beginPath();
        ctx.arc(s.points[0][0], s.points[0][1], s.size / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(s.points[0][0], s.points[0][1]);
      for (const p of s.points.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
    canvas.classList.toggle("is-inverted", invert.checked);
    sync();
  }

  function sync() {
    undoBtn.disabled = busy || !strokes.length;
    clearBtn.disabled = busy || !strokes.length;
    send.disabled = busy || !strokes.length;
  }

  function point(event) {
    const box = canvas.getBoundingClientRect();
    const sx = canvas.width / box.width;
    const sy = canvas.height / box.height;
    return [Math.round((event.clientX - box.left) * sx), Math.round((event.clientY - box.top) * sy)];
  }

  function scale() {
    const box = canvas.getBoundingClientRect();
    return box.width ? canvas.width / box.width : 1;
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (busy || !event.isPrimary) return;
    event.preventDefault();
    try { canvas.setPointerCapture(event.pointerId); } catch (_error) { /* synthetic pointer */ }
    drawing = { size: Math.max(2, Math.round(Number(brush.value) * scale())), points: [point(event)] };
    strokes.push(drawing);
    redraw();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drawing || !event.isPrimary) return;
    event.preventDefault();
    drawing.points.push(point(event));
    redraw();
  });
  const end = () => { drawing = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("lostpointercapture", end);

  undoBtn.addEventListener("click", () => { strokes.pop(); redraw(); });
  clearBtn.addEventListener("click", () => { strokes = []; redraw(); });
  invert.addEventListener("change", redraw);

  function maskDataUrl() {
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const o = out.getContext("2d");
    if (invert.checked) {
      o.fillStyle = "#ffffff";
      o.fillRect(0, 0, out.width, out.height);
      o.globalCompositeOperation = "destination-out";
      o.drawImage(canvas, 0, 0);
    } else {
      o.drawImage(canvas, 0, 0);
      o.globalCompositeOperation = "source-in";
      o.fillStyle = "#ffffff";
      o.fillRect(0, 0, out.width, out.height);
    }
    const url = out.toDataURL("image/png");
    out.width = 0;
    out.height = 0;
    return url;
  }

  function stopPolling() { if (polling) clearTimeout(polling); polling = 0; }

  function wipe() {
    stopPolling();
    strokes = [];
    drawing = null;
    busy = false;
    source = null;
    stored = {};
    prompt.value = "";
    note.textContent = HINT;
    img.removeAttribute("src");
    canvas.width = 1;
    canvas.height = 1;
    ctx.clearRect(0, 0, 1, 1);
    sync();
  }

  function close() { if (dialog.open) dialog.close(); }
  dialog.addEventListener("close", wipe);
  $("forge-inpaint-close").addEventListener("click", close);

  /* The retouch uses the model Forge has loaded (it never switches); say which, from the status read. */
  function showModel() {
    if (!modelNote) return;
    modelNote.textContent = "";
    H.api("/api/forge/status", { cache: "no-store" }).then((s) => {
      if (!dialog.open) return;
      modelNote.textContent = s && s.model ? "Utilise le mod\u00e8le charg\u00e9 dans Forge : " + s.model : "Mod\u00e8le charg\u00e9 dans Forge : inconnu.";
    }).catch(() => { if (dialog.open) modelNote.textContent = "Mod\u00e8le charg\u00e9 dans Forge : inconnu."; });
  }

  function open(kind, viewerImg, settings) {
    if (!viewerImg || !viewerImg.src || !viewerImg.naturalWidth) return;
    source = { kind, id: kind === "private" ? currentPrivate : currentNormal };
    if (!source.id) return;
    img.src = viewerImg.src;
    canvas.width = viewerImg.naturalWidth;
    canvas.height = viewerImg.naturalHeight;
    strokes = [];
    invert.checked = false;
    stored = settings || {};
    prompt.value = stored.prompt || "";
    where.textContent = kind === "private" ? "R\u00e9sultat rang\u00e9 dans le coffre, rien dans l'historique." : "R\u00e9sultat ajout\u00e9 \u00e0 la galerie.";
    note.textContent = HINT;
    showModel();
    redraw();
    dialog.showModal();
    $("forge-inpaint-close").focus();
  }

  let currentNormal = "";
  let currentPrivate = "";
  const prevViewer = window.hqForgeOnViewer;
  window.hqForgeOnViewer = (kind, id, current) => {
    if (prevViewer) prevViewer(kind, id, current);
    if (kind === "private") currentPrivate = id; else currentNormal = id;
  };
  const normalBtn = $("forge-viewer-inpaint");
  const privateBtn = $("forge-vault-viewer-inpaint");
  if (normalBtn) normalBtn.addEventListener("click", () => {
    const detail = H.currentDetail();
    open("normal", $("forge-viewer-img"), detail && detail.settings);
  });
  if (privateBtn) privateBtn.addEventListener("click", () => {
    if (!H.vaultUnlocked()) return;
    const detail = H.privateDetail ? H.privateDetail() : null;
    open("private", $("forge-vault-viewer-img"), detail && detail.settings);
  });

  async function poll(id, kind) {
    polling = 0;
    if (!dialog.open || !source) return;
    try {
      const out = await H.api("/api/forge/inpaint/" + id, { cache: "no-store" });
      const entry = out.inpaint;
      if (!dialog.open || !source) return;
      if (entry.state === "completed" && entry.image_id) {
        const imageId = entry.image_id;
        close();
        if (kind === "private") {
          await H.reloadVault();
          if (H.openPrivate && H.vaultUnlocked()) { H.closePrivateViewer && H.closePrivateViewer(); await H.openPrivate(imageId); }
        } else {
          await H.loadGallery();
          H.closeViewer();
          await H.openImage(imageId);
        }
        return;
      }
      if (entry.state === "failed") {
        busy = false;
        note.textContent = entry.message || "La retouche n'a pas abouti.";
        sync();
        return;
      }
      const pct = Math.round((Number(entry.progress) || 0) * 100);
      note.textContent = entry.steps ? "Retouche en cours\u2026 " + pct + " %" : "Retouche en cours\u2026";
    } catch (error) {
      if (error.status === 404 || error.status === 401) { busy = false; note.textContent = error.message || "Retouche interrompue."; sync(); return; }
    }
    polling = setTimeout(() => poll(id, kind), 1000);
  }

  send.addEventListener("click", async () => {
    if (busy || !source || !strokes.length) return;
    busy = true;
    sync();
    note.textContent = "Envoi \u00e0 Forge (ce PC)\u2026";
    const kind = source.kind;
    let body = {
      source: { kind, id: source.id },
      mask: maskDataUrl(),
      prompt: prompt.value,
      denoising_strength: Number(denoise.value),
      mask_blur: Number(blur.value),
      inpainting_fill: Number(fill.value),
      inpaint_full_res: fullRes.checked,
      inpaint_full_res_padding: 32
    };
    /* An imported image may carry no settings: fill only what it lacks from the current form. */
    const form = H.sweepContext ? H.sweepContext().settings : {};
    for (const key of ["sampler_name", "scheduler", "steps", "cfg_scale"]) {
      if (!stored[key] && form[key] != null && form[key] !== "") body[key] = form[key];
    }
    try {
      const payload = JSON.stringify(body);
      body = null;
      const out = await H.api("/api/forge/inpaint", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
      poll(out.inpaint.id, kind);
    } catch (error) {
      busy = false;
      note.textContent = error.message || "La retouche n'a pas pu partir.";
      sync();
    }
  });

  const prevScrub = window.hqForgeScrubPrivate;
  window.hqForgeScrubPrivate = function () {
    currentPrivate = "";
    if (source && source.kind === "private") close();
    return prevScrub ? prevScrub.apply(this, arguments) : undefined;
  };
  sync();
})();