/* Forge Studio, phase E: parameter sweep (this file), finish and A/B comparator (added later).
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
  const prevBatch = window.hqForgeOnBatch;
  window.hqForgeOnBatch = (batch) => { if (prevBatch) prevBatch(batch); renderStrip(batch); };
  const prevJob = window.hqForgeOnJob;
  window.hqForgeOnJob = (job) => { if (prevJob) prevJob(job); renderStrip(null); };
})();