/* Forge Studio, phase E: parameter sweep, drafts then finish, A/B comparator.
   Same-origin HQ routes only, through hq-forge.js hooks. Normal mode only: nothing here ever
   reads or sends a private prompt or a vault image, and nothing is kept in browser storage. */
(function () {
  const $ = (id) => document.getElementById(id);
  const H = window.hqForgeHooks;
  if (!H || !$("forge-form")) return;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const fr = (v) => String(v).replace(".", ",");
  const key = (p) => p + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 38);

  // ------------------------------------------------------------------ E1: parameter sweep
  const axisEl = $("forge-sweep-axis");
  const valuesEl = $("forge-sweep-values");
  const loraField = $("forge-sweep-lora-field");
  const loraEl = $("forge-sweep-lora");
  const noteEl = $("forge-sweep-note");
  const runEl = $("forge-sweep-run");
  const strip = $("forge-sweep-strip");
  const MAX = 8;
  const DEFAULTS = { cfg_scale: "4 ; 6 ; 8 ; 10", steps: "10 ; 20 ; 30", lora_weight: "0,2 ; 0,5 ; 0,8 ; 1" };

  function promptLoras() {
    const prompt = ($("forge-prompt") || {}).value || "";
    const out = [];
    prompt.replace(/<lora:([^:<>]{1,120})(?::[^<>]*)?>/gi, (_m, name) => { if (!out.includes(name)) out.push(name); return _m; });
    return out;
  }
  function syncLoras() {
    const names = promptLoras();
    const current = loraEl.value;
    loraEl.replaceChildren(...names.map((name) => { const o = el("option", "", name); o.value = name; return o; }));
    if (names.includes(current)) loraEl.value = current;
    return names;
  }
  function cellLabel(axis, value, lora) {
    if (axis === "cfg_scale") return "CFG " + fr(value);
    if (axis === "steps") return value + " pas";
    if (axis === "lora_weight") return (lora || "LoRA") + " " + fr(value);
    return String(value);
  }
  function parse(axis) {
    const raw = valuesEl.value.trim();
    const parts = (raw.includes(";") ? raw.split(";") : raw.split(/\s*,\s+|\s+/)).map((s) => s.trim()).filter(Boolean);
    if (axis === "sampler_name") return parts;
    return parts.map((s) => Number(s.replace(",", ".")));
  }
  function check() {
    const axis = axisEl.value;
    loraField.hidden = axis !== "lora_weight";
    const ctx = H.sweepContext();
    if (ctx.privateMode) return "Le balayage reste en mode normal : un prompt priv\u00e9 ne part jamais en lot.";
    if (axis === "lora_weight" && !syncLoras().length) return "Ajoutez d'abord un LoRA au prompt, par exemple <lora:nom:0.6>.";
    const values = parse(axis);
    if (values.length < 2) return "Indiquez au moins deux valeurs.";
    if (values.length > MAX) return "Huit valeurs au plus.";
    if (new Set(values.map(String)).size !== values.length) return "Chaque valeur ne doit appara\u00eetre qu'une fois.";
    if (axis !== "sampler_name" && values.some((v) => !Number.isFinite(v))) return "Une valeur n'est pas un nombre.";
    if (axis === "steps" && values.some((v) => !Number.isInteger(v) || v < 1 || v > 40)) return "Pas : nombres entiers de 1 \u00e0 40.";
    if (axis === "cfg_scale" && values.some((v) => v < 1 || v > 15)) return "CFG : de 1 \u00e0 15.";
    if (axis === "lora_weight" && values.some((v) => v < -2 || v > 2)) return "Poids : de -2 \u00e0 2.";
    if (axis === "sampler_name") {
      const missing = values.filter((v) => !ctx.samplers.includes(v));
      if (missing.length) return "\u00c9chantillonneur inconnu ici : " + missing.join(", ") + ".";
    }
    return "";
  }
  function sync() {
    const problem = check();
    runEl.disabled = !!problem;
    const n = problem ? 0 : parse(axisEl.value).length;
    noteEl.textContent = problem || (n + " images, une par valeur, m\u00eame graine.");
  }
  axisEl.addEventListener("change", () => {
    const axis = axisEl.value;
    if (axis === "sampler_name") valuesEl.value = H.sweepContext().samplers.slice(0, 3).join(" ; ");
    else valuesEl.value = DEFAULTS[axis];
    sync();
  });
  valuesEl.addEventListener("input", sync);
  loraEl.addEventListener("change", sync);
  $("forge-sweep").addEventListener("toggle", () => { if ($("forge-sweep").open) sync(); });
  document.addEventListener("change", (event) => { if (event.target && event.target.name === "forge-destination") sync(); });

  runEl.addEventListener("click", async () => {
    const problem = check();
    if (problem) { sync(); return; }
    const ctx = H.sweepContext();
    const axis = axisEl.value;
    const values = parse(axis);
    const sweep = { axis, values };
    if (axis === "lora_weight") sweep.lora = loraEl.value;
    runEl.disabled = true;
    noteEl.textContent = "Envoi du balayage.";
    try {
      const payload = await H.api("/api/forge/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key("sw") },
        body: JSON.stringify({ workers: ctx.workers, count: values.length, settings: ctx.settings, destination: "normal", sweep })
      });
      noteEl.textContent = values.length + " images lanc\u00e9es, graine " + payload.batch.tasks[0].seed + ".";
      H.startBatch(payload.batch);
    } catch (error) {
      const problems = error && error.data && error.data.problems;
      noteEl.textContent = (error.message || "Le balayage n'a pas d\u00e9marr\u00e9.") + (problems ? " " + problems.map((p) => p.name + " : " + p.reasons.join(" ")).join(" ") : "");
    }
    runEl.disabled = false;
  });

  /* The strip: one cell per value, in the order typed, swiped sideways with a finger. */
  function renderStrip(batch) {
    const results = $("forge-results");
    if (!batch || !batch.sweep) {
      strip.hidden = true;
      strip.replaceChildren();
      delete strip.dataset.batch;
      if (results) results.hidden = false;
      return;
    }
    if (strip.dataset.batch !== batch.batch_id) { strip.replaceChildren(); strip.dataset.batch = batch.batch_id; }
    const tasks = batch.tasks.slice().sort((a, b) => a.index - b.index);
    tasks.forEach((t) => {
      let cell = strip.querySelector('[data-index="' + t.index + '"]');
      if (!cell) {
        cell = el("figure", "forge-sweep-cell");
        cell.setAttribute("role", "listitem");
        cell.dataset.index = String(t.index);
        cell.append(el("div", "forge-sweep-wait"), el("figcaption", "", cellLabel(batch.sweep.axis, t.cell ? t.cell.value : "", batch.sweep.lora)));
        strip.append(cell);
      }
      cell.dataset.state = t.state;
      const slot = cell.firstElementChild;
      if (t.image_id && slot.dataset.image !== t.image_id) {
        const card = H.card({ id: t.image_id, thumb: "/api/forge/gallery/" + t.image_id + "/thumb" });
        card.dataset.image = t.image_id;
        card.setAttribute("aria-label", cellLabel(batch.sweep.axis, t.cell ? t.cell.value : "", batch.sweep.lora));
        slot.replaceWith(card);
      } else if (!t.image_id) {
        const text = { queued: "En attente", dispatched: "Envoy\u00e9e", running: "En cours", saving: "Enregistrement", failed: "\u00c9chec", uncertain: "Incertaine", cancelled: "Annul\u00e9e" }[t.state] || "";
        if (slot.textContent !== text) slot.textContent = text;
      }
    });
    strip.hidden = false;
    if (results) results.hidden = true;
  }
  // ------------------------------------------------------------------ E2: drafts, then finish on this PC
  /* A kept draft is re-rendered by this PC's Forge in high resolution, with the same seed and settings.
     It is labelled "finition", never "identique": a second pass changes details and can change the layout. */
  const finishBox = $("forge-viewer-finish");
  const finishBtn = $("forge-finish");
  const finishScale = $("forge-finish-scale");
  const finishNote = $("forge-finish-note");
  const finishOf = $("forge-finish-of");
  const FINISH_KEYS = ["prompt", "negative_prompt", "checkpoint", "sampler_name", "scheduler", "width", "height", "steps", "cfg_scale", "seed"];
  let finishId = "";
  function syncFinish(kind, id) {
    if (kind !== "normal") return;
    const d = H.currentDetail();
    const s = (d && d.settings) || {};
    const origin = (d && d.origin) || {};
    finishId = d ? id : "";
    finishOf.hidden = !origin.finish_of;
    finishOf.dataset.source = origin.finish_of || "";
    if (finishNote.dataset.base == null) finishNote.dataset.base = finishNote.textContent;
    [...finishScale.options].forEach((o) => { o.disabled = Math.round(Number(s.width) * Number(o.value)) > 2048 || Math.round(Number(s.height) * Number(o.value)) > 2048; });
    const chosen = finishScale.selectedOptions[0];
    if (chosen && chosen.disabled) { const ok = [...finishScale.options].find((o) => !o.disabled); if (ok) finishScale.value = ok.value; }
    let reason = "";
    if (!(Number(s.seed) >= 0)) reason = "Graine inconnue : la finition ne peut pas repartir de cette image.";
    else if (s.enable_hr === true) reason = "Cette image est d\u00e9j\u00e0 en haute r\u00e9solution.";
    else if (!H.upscalers().length) reason = "Aucun agrandisseur n'est disponible sur le Forge de ce PC.";
    else if ([...finishScale.options].every((o) => o.disabled)) reason = "Image trop grande pour une finition (2048 px au plus).";
    finishBox.hidden = !d;
    finishBtn.disabled = !!reason;
    finishBtn.dataset.blocked = reason ? "1" : "";
    finishNote.textContent = reason || finishNote.dataset.base;
  }
  finishBtn.addEventListener("click", async () => {
    const d = H.currentDetail();
    if (!d || !finishId || finishBtn.disabled) return;
    const s = d.settings || {};
    const body = {};
    FINISH_KEYS.forEach((name) => { if (s[name] != null) body[name] = s[name]; });
    if (Number(s.subseed_strength) > 0) { body.subseed = s.subseed; body.subseed_strength = s.subseed_strength; }
    const ups = H.upscalers();
    const preferred = H.preferredUpscaler();
    Object.assign(body, {
      enable_hr: true, hr_scale: Number(finishScale.value), hr_upscaler: ups.includes(preferred) ? preferred : ups[0],
      hr_second_pass_steps: 0, denoising_strength: 0.4, n_iter: 1, batch_size: 1,
      destination: "normal", wait_if_busy: true, finish_of: finishId,
    });
    finishBtn.disabled = true;
    try {
      const payload = await H.api("/api/forge/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key("fi") },
        body: JSON.stringify(body)
      });
      H.closeViewer();
      H.startJob(payload.job);
    } catch (error) {
      finishNote.textContent = error.message || "La finition n'a pas d\u00e9marr\u00e9.";
      finishBtn.disabled = false;
    }
  });
  $("forge-finish-source").addEventListener("click", () => {
    const source = finishOf.dataset.source;
    if (!source) return;
    H.closeViewer();
    H.openImage(source).catch(() => {});
  });
  const prevViewer = window.hqForgeOnViewer;
  window.hqForgeOnViewer = (kind, id, current) => { if (prevViewer) prevViewer(kind, id, current); syncFinish(kind, id); };

  // ------------------------------------------------------------------ E3: A/B comparator (client side only)
  /* Two gallery images stacked in one frame: a reveal slider, one pinch zoom applied to both, and the
     settings that differ. Nothing is uploaded or stored; the decoded originals are dropped on close
     (iOS Safari keeps decoded images in memory while an <img> holds them). Vault images stay out. */
  const cmp = $("forge-compare");
  const stage = $("forge-compare-stage");
  const imgA = $("forge-compare-a");
  const imgB = $("forge-compare-b");
  const reveal = $("forge-compare-reveal");
  const diffEl = $("forge-compare-diff");
  const pickBar = $("forge-compare-pick");
  let pair = null;
  let picking = null;
  let view = { zoom: 1, tx: 0, ty: 0 };
  const pointers = new Map();
  let gesture = null;
  let lastTap = 0;

  function applyView() {
    stage.style.setProperty("--zoom", String(view.zoom));
    stage.style.setProperty("--tx", Math.round(view.tx) + "px");
    stage.style.setProperty("--ty", Math.round(view.ty) + "px");
  }
  function clampView() {
    const w = stage.clientWidth, h = stage.clientHeight;
    view.zoom = Math.min(6, Math.max(1, view.zoom));
    view.tx = Math.min(0, Math.max(w - w * view.zoom, view.tx));
    view.ty = Math.min(0, Math.max(h - h * view.zoom, view.ty));
  }
  function resetView() { view = { zoom: 1, tx: 0, ty: 0 }; applyView(); }
  function setReveal() {
    stage.style.setProperty("--reveal", reveal.value + "%");
    reveal.setAttribute("aria-valuetext", "B visible sur " + reveal.value + " %");
  }
  const local = (event) => { const r = stage.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; };
  stage.addEventListener("pointerdown", (event) => {
    try { stage.setPointerCapture(event.pointerId); } catch (_) { /* pointer already gone */ }
    pointers.set(event.pointerId, local(event));
    const pts = [...pointers.values()];
    if (pts.length === 2) {
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      gesture = { kind: "pinch", dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, mid, zoom: view.zoom, tx: view.tx, ty: view.ty };
    } else if (pts.length === 1) {
      gesture = { kind: "pan", start: pts[0], tx: view.tx, ty: view.ty };
    }
  });
  stage.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, local(event));
    const pts = [...pointers.values()];
    if (gesture && gesture.kind === "pinch" && pts.length >= 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const zoom = Math.min(6, Math.max(1, gesture.zoom * dist / gesture.dist));
      // Keep the point under the fingers where it was: the same transform moves A and B together.
      const cx = (gesture.mid.x - gesture.tx) / gesture.zoom, cy = (gesture.mid.y - gesture.ty) / gesture.zoom;
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      view = { zoom, tx: mid.x - cx * zoom, ty: mid.y - cy * zoom };
    } else if (gesture && gesture.kind === "pan" && view.zoom > 1) {
      view.tx = gesture.tx + pts[0].x - gesture.start.x;
      view.ty = gesture.ty + pts[0].y - gesture.start.y;
    } else {
      return;
    }
    clampView();
    applyView();
  });
  const lift = (event) => {
    if (!pointers.delete(event.pointerId)) return;
    if (event.type === "pointerup" && !pointers.size && gesture && gesture.kind === "pan") {
      const now = Date.now();
      if (now - lastTap < 320) resetView();
      lastTap = now;
    }
    const rest = [...pointers.values()];
    gesture = rest.length === 1 ? { kind: "pan", start: rest[0], tx: view.tx, ty: view.ty } : null;
  };
  stage.addEventListener("pointerup", lift);
  stage.addEventListener("pointercancel", lift);

  const ROWS = [
    ["Prompt", (s) => s.prompt || ""],
    ["N\u00e9gatif", (s) => s.negative_prompt || ""],
    ["Mod\u00e8le", (s) => s.checkpoint || ""],
    ["\u00c9chantillonneur", (s) => s.sampler_name || ""],
    ["Planificateur", (s) => s.scheduler || ""],
    ["Taille", (s) => (s.width && s.height ? s.width + "\u00d7" + s.height : "")],
    ["Pas", (s) => (s.steps == null ? "" : String(s.steps))],
    ["CFG", (s) => (s.cfg_scale == null ? "" : fr(s.cfg_scale))],
    ["Graine", (s) => (s.seed == null ? "" : (Number(s.seed) >= 0 ? String(s.seed) : "inconnue"))],
    ["Variation", (s) => (Number(s.subseed_strength) > 0 ? fr(s.subseed_strength) + " \u00b7 " + s.subseed : "aucune")],
    ["Haute r\u00e9solution", (s) => (s.enable_hr ? "\u00d7" + fr(s.hr_scale) + " \u00b7 " + (s.hr_upscaler || "") : "non")],
  ];
  function renderDiff(a, b) {
    diffEl.replaceChildren();
    let n = 0;
    const row = (label, x, y) => {
      diffEl.append(el("dt", "", label));
      const dd = el("dd");
      dd.append(el("span", "forge-compare-va", "A : " + (x || "\u2014")), el("span", "forge-compare-vb", "B : " + (y || "\u2014")));
      diffEl.append(dd);
      n += 1;
    };
    ROWS.forEach(([label, get]) => { const x = get(a.settings || {}), y = get(b.settings || {}); if (x !== y) row(label, x, y); });
    const da = (a.origin && a.origin.worker_name) || "Cet HQ", db = (b.origin && b.origin.worker_name) || "Cet HQ";
    if (da !== db) row("Appareil", da, db);
    if (!n) diffEl.append(el("dd", "forge-note", "M\u00eames r\u00e9glages."));
  }
  function load(a, b) {
    pair = { a, b };
    imgA.alt = "Image A";
    imgB.alt = "Image B";
    imgA.src = a.original;
    imgB.src = b.original;
    if (a.width && a.height) stage.style.setProperty("--cmp-ratio", a.width + " / " + a.height);
    renderDiff(a, b);
    resetView();
    setReveal();
  }
  function drop() {
    imgA.removeAttribute("src");
    imgB.removeAttribute("src");
    pointers.clear();
    gesture = null;
    pair = null;
  }
  function closeCompare() { if (cmp.open) cmp.close(); drop(); }
  function endPick() { picking = null; pickBar.hidden = true; }

  $("forge-compare-start").addEventListener("click", () => {
    const d = H.currentDetail();
    if (!d || !d.original) return;
    picking = d;
    H.closeViewer();
    pickBar.hidden = false;
  });
  $("forge-compare-pick-cancel").addEventListener("click", endPick);
  document.addEventListener("click", async (event) => {
    if (!picking) return;
    const card = event.target && event.target.closest ? event.target.closest(".forge-card") : null;
    if (!card || !card.closest("#forge-gallery, #forge-results, #forge-sweep-strip") || !/^img-/.test(card.dataset.id || "")) return;
    event.preventDefault();
    event.stopPropagation();
    if (card.dataset.id === picking.id) { pickBar.firstElementChild.textContent = "Choisissez une autre image que A."; return; }
    const first = picking;
    endPick();
    try {
      const second = await H.api("/api/forge/gallery/" + encodeURIComponent(card.dataset.id));
      load(first, second);
      cmp.showModal();
      $("forge-compare-close").focus();
    } catch (_) { /* image gone: nothing to compare */ }
  }, true);
  reveal.addEventListener("input", setReveal);
  $("forge-compare-swap").addEventListener("click", () => { if (pair) load(pair.b, pair.a); });
  $("forge-compare-reset").addEventListener("click", resetView);
  $("forge-compare-close").addEventListener("click", closeCompare);
  cmp.addEventListener("close", drop);
  cmp.addEventListener("cancel", (event) => { event.preventDefault(); closeCompare(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && picking) endPick(); });

  const prevBatch = window.hqForgeOnBatch;
  window.hqForgeOnBatch = (batch) => { if (prevBatch) prevBatch(batch); renderStrip(batch); };
  const prevJob = window.hqForgeOnJob;
  window.hqForgeOnJob = (job) => { if (prevJob) prevJob(job); renderStrip(null); };
})();