/* Forge Studio, next features: quick triage and bin (B), lab (B), planner (C), journal (D).
   Talks only to same-origin HQ routes through hq-forge.js hooks. Vault images and their
   flags never touch browser storage: decrypted pixels live in blob URLs that the vault
   lock revokes. */
(function () {
  const $ = (id) => document.getElementById(id);
  const H = window.hqForgeHooks;
  if (!H || !$("forge-form")) return;
  const post = (path, body) => H.api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const LABELS = { keep: "Garder", reject: "Rejeter", favorite: "Favori", none: "Non tri\u00e9" };

  // ------------------------------------------------------------------ B: quick triage
  const dialog = $("forge-triage");
  const img = $("forge-triage-img");
  const stage = $("forge-triage-stage");
  let mode = "normal";
  let queue = [];
  let index = 0;
  let undo = [];
  let busy = false;
  let changed = false;
  let blobUrl = "";

  function base(kind) {
    return kind === "private" ? H.vaultBase() + "/images/" : "/api/forge/gallery/";
  }
  function listPath(kind, view) {
    return (kind === "private" ? H.vaultBase() + "/gallery" : "/api/forge/gallery") + "?limit=96&view=" + view;
  }
  function dropBlob() {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = "";
  }
  async function show() {
    dropBlob();
    const empty = index >= queue.length;
    $("forge-triage-empty").hidden = !empty;
    stage.hidden = empty;
    ["forge-triage-reject", "forge-triage-favorite", "forge-triage-keep"].forEach((id) => { $(id).disabled = empty || busy; });
    $("forge-triage-undo").disabled = !undo.length || busy;
    $("forge-triage-count").textContent = queue.length ? Math.min(index + 1, queue.length) + " / " + queue.length : "";
    img.removeAttribute("src");
    if (empty) return;
    const item = queue[index];
    img.alt = mode === "private" ? "Image du coffre \u00e0 trier" : "Image \u00e0 trier";
    if (mode === "private") {
      const response = await fetch(base("private") + item.id + "/thumb", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) { close(); return; }
      blobUrl = URL.createObjectURL(await response.blob());
      H.trackPrivateUrl(blobUrl);
      if (queue[index] === item) img.src = blobUrl;
    } else {
      img.src = item.thumb || (base("normal") + item.id + "/thumb");
    }
  }
  async function open(kind) {
    mode = kind;
    queue = [];
    index = 0;
    undo = [];
    changed = false;
    $("forge-triage-title").textContent = kind === "private" ? "Tri rapide du coffre" : "Tri rapide";
    try {
      const page = await H.api(listPath(kind, "untriaged"));
      queue = page.images || [];
    } catch (error) {
      queue = [];
    }
    dialog.showModal();
    await show();
    $("forge-triage-close").focus();
  }
  function close() {
    dropBlob();
    img.removeAttribute("src");
    if (dialog.open) dialog.close();
    queue = [];
    if (changed) {
      (mode === "private" ? H.loadVault() : H.loadGallery()).catch(() => {});
      changed = false;
    }
  }
  async function decide(state) {
    if (busy || index >= queue.length) return;
    busy = true;
    const item = queue[index];
    try {
      const result = await post(base(mode) + item.id + "/triage", { state });
      undo.push({ id: item.id, previous: result.previous || "none", at: index });
      index += 1;
      changed = true;
      $("forge-triage-note").textContent = LABELS[state] + " \u00b7 " + (state === "reject" ? "dans la corbeille, rien n\u2019est effac\u00e9." : "enregistr\u00e9.");
    } catch (error) {
      $("forge-triage-note").textContent = error.message || "Le choix n\u2019a pas \u00e9t\u00e9 enregistr\u00e9.";
    }
    busy = false;
    await show();
  }
  async function undoLast() {
    const last = undo[undo.length - 1];
    if (!last || busy) return;
    busy = true;
    try {
      await post(base(mode) + last.id + "/triage", { state: last.previous });
      undo.pop();
      index = last.at;
      $("forge-triage-note").textContent = "Dernier choix annul\u00e9.";
    } catch (error) {
      $("forge-triage-note").textContent = error.message || "L\u2019annulation a \u00e9chou\u00e9.";
    }
    busy = false;
    await show();
  }
  $("forge-triage-open").addEventListener("click", () => { open("normal"); });
  $("forge-vault-triage-open").addEventListener("click", () => { if (H.vaultUnlocked()) open("private"); });
  $("forge-triage-close").addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  $("forge-triage-keep").addEventListener("click", () => { decide("keep"); });
  $("forge-triage-reject").addEventListener("click", () => { decide("reject"); });
  $("forge-triage-favorite").addEventListener("click", () => { decide("favorite"); });
  $("forge-triage-undo").addEventListener("click", undoLast);
  dialog.addEventListener("keydown", (event) => {
    if (event.target && event.target.tagName === "BUTTON" && (event.key === "Enter" || event.key === " ")) return;
    if (event.key === "ArrowRight") { event.preventDefault(); decide("keep"); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); decide("reject"); }
    else if (event.key === "ArrowUp") { event.preventDefault(); decide("favorite"); }
  });
  // Swipe: pointer events cover touch, pen and mouse; a short tap does nothing.
  let start = null;
  stage.addEventListener("pointerdown", (event) => { start = { x: event.clientX, y: event.clientY }; });
  stage.addEventListener("pointerup", (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 60) return;
    if (Math.abs(dx) > Math.abs(dy)) decide(dx > 0 ? "keep" : "reject");
    else if (dy < 0) decide("favorite");
  });
  stage.addEventListener("pointercancel", () => { start = null; });

  // Bin: rejected images, with Remettre. Nothing is deleted from here.
  const trash = $("forge-trash");
  let trashMode = "normal";
  const trashUrls = [];
  function dropTrashUrls() {
    while (trashUrls.length) URL.revokeObjectURL(trashUrls.pop());
  }
  async function openTrash(kind) {
    trashMode = kind;
    $("forge-trash-title").textContent = kind === "private" ? "Corbeille du coffre" : "Corbeille";
    await fillTrash();
    trash.showModal();
    $("forge-trash-close").focus();
  }
  async function fillTrash() {
    const grid = $("forge-trash-grid");
    dropTrashUrls();
    grid.replaceChildren();
    let images = [];
    try { images = (await H.api(listPath(trashMode, "trash"))).images || []; } catch (_) { images = []; }
    $("forge-trash-empty").hidden = images.length > 0;
    for (const image of images) {
      const cell = document.createElement("div");
      cell.className = "forge-trash-item";
      const pic = document.createElement("img");
      pic.alt = trashMode === "private" ? "Image rejet\u00e9e du coffre" : "Image rejet\u00e9e";
      const back = document.createElement("button");
      back.type = "button";
      back.className = "secondary";
      back.textContent = "Remettre";
      back.dataset.id = image.id;
      back.addEventListener("click", async () => {
        back.disabled = true;
        try {
          await post(base(trashMode) + image.id + "/triage", { state: "none" });
          cell.remove();
          $("forge-trash-empty").hidden = $("forge-trash-grid").children.length > 0;
          (trashMode === "private" ? H.loadVault() : H.loadGallery()).catch(() => {});
        } catch (_) { back.disabled = false; }
      });
      cell.append(pic, back);
      grid.append(cell);
      if (trashMode === "private") {
        fetch(base("private") + image.id + "/thumb", { credentials: "same-origin", cache: "no-store" })
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("locked"))))
          .then((blob) => { const url = URL.createObjectURL(blob); trashUrls.push(url); H.trackPrivateUrl(url); pic.src = url; })
          .catch(() => { pic.alt = "Image indisponible"; });
      } else {
        pic.src = image.thumb;
      }
    }
  }
  function closeTrash() {
    dropTrashUrls();
    $("forge-trash-grid").replaceChildren();
    if (trash.open) trash.close();
  }
  $("forge-trash-open").addEventListener("click", () => { openTrash("normal"); });
  $("forge-vault-trash-open").addEventListener("click", () => { if (H.vaultUnlocked()) openTrash("private"); });
  $("forge-trash-close").addEventListener("click", closeTrash);
  trash.addEventListener("cancel", (event) => { event.preventDefault(); closeTrash(); });

  // Viewer row: change the flag of one image at any time (reversible).
  function viewerRow(kind, id, current) {
    const row = $(kind === "private" ? "forge-vault-viewer-triage" : "forge-viewer-triage");
    if (!row) return;
    row.replaceChildren();
    ["keep", "favorite", "reject", "none"].forEach((state) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary forge-triage-chip";
      button.textContent = LABELS[state];
      button.dataset.state = state;
      button.setAttribute("aria-pressed", String(state === (current || "none")));
      button.addEventListener("click", async () => {
        try {
          await post(base(kind) + id + "/triage", { state });
          row.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.state === state)));
          const cardSel = (kind === "private" ? "#forge-vault-gallery" : "#forge-gallery") + ' .forge-card[data-id="' + CSS.escape(id) + '"]';
          const card = document.querySelector(cardSel);
          if (card) card.dataset.triage = state;
          (kind === "private" ? H.loadVault() : H.loadGallery()).catch(() => {});
        } catch (_) { /* the flag stays as it was */ }
      });
      row.append(button);
    });
  }
  window.hqForgeOnViewer = viewerRow;

  // ------------------------------------------------------------------ B: Laboratoire
  const lab = $("forge-lab");
  const ERRORS = { forge_oom: "m\u00e9moire GPU", forge_timeout: "d\u00e9lai d\u00e9pass\u00e9", stopped: "Forge arr\u00eat\u00e9", forge_error: "erreur Forge",
    forge_http: "erreur Forge", uncertain_lease: "appareil muet", uncertain_lost: "appareil perdu", hq_restart: "HQ red\u00e9marr\u00e9",
    worker_removed: "appareil retir\u00e9", model_mismatch: "autre version du mod\u00e8le", bad_image: "image illisible" };
  let labData = null;
  let labView = "speed";
  const fmt = (n) => String(Math.round(n * 10) / 10).replace(".", ",");
  const secs = (n) => (n < 90 ? fmt(n) + " s" : fmt(n / 60) + " min");
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0) + " %";
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function groupTitle(group) {
    return [group.checkpoint, group.width + "\u00d7" + group.height, group.hires ? "haute r\u00e9solution" : ""].filter(Boolean).join(" \u00b7 ");
  }
  function rowLabel(item) {
    return item.device + " \u00b7 " + item.sampler + " \u00b7 " + item.steps + " pas";
  }
  function applyButton(item) {
    const button = el("button", "secondary forge-lab-apply", "Appliquer ces r\u00e9glages");
    button.type = "button";
    button.addEventListener("click", () => {
      const result = H.applyTechnical(item.settings || {});
      const note = $("forge-lab-applied");
      note.textContent = "Formulaire mis \u00e0 jour : " + (result.done.join(", ") || "rien") + "." +
        (result.missing.length ? " Absent de cet HQ, laiss\u00e9 tel quel : " + result.missing.join(", ") + "." : "") +
        " Le prompt n\u2019a pas chang\u00e9 et rien n\u2019est lanc\u00e9.";
      note.focus();
    });
    return button;
  }
  function renderLab() {
    const panel = $("forge-lab-panel");
    panel.replaceChildren();
    document.querySelectorAll(".forge-lab-tabs [role=tab]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.view === labView)));
    if (!labData) return;
    const min = labData.min_samples;
    const groups = labData[labView] || [];
    if (labView === "keep") panel.append(el("p", "forge-note", "Ce que tu gardes : part des images tri\u00e9es marqu\u00e9es Garder ou Favori. Les images non tri\u00e9es ne comptent pas."));
    if (!groups.length) {
      panel.append(el("p", "forge-note forge-lab-empty", labView === "keep" ? "Pas encore d\u2019image tri\u00e9e. Utilisez Trier dans la galerie." : "Pas encore de mesure. Les prochaines g\u00e9n\u00e9rations de la galerie s\u2019afficheront ici."));
      return;
    }
    groups.forEach((group) => {
      const box = el("section", "forge-lab-group");
      box.append(el("h3", "forge-lab-group-title", groupTitle(group)));
      const comparable = group.rows.filter((item) => item.enough);
      const top = labView === "speed" ? Math.max(...comparable.map((item) => item.high_s || item.median_s || 0), 1) : 1;
      group.rows.forEach((item) => {
        const line = el("div", "forge-lab-row");
        line.dataset.enough = String(item.enough);
        line.append(el("span", "forge-lab-label", rowLabel(item)));
        if (!item.enough) {
          line.append(el("span", "forge-lab-value forge-lab-few", "Pas assez de donn\u00e9es (" + item.samples + " / " + min + ")"));
          box.append(line);
          return;
        }
        const meter = document.createElement("meter");
        meter.min = 0;
        let text = "";
        if (labView === "speed") {
          meter.max = top;
          meter.value = item.median_s;
          meter.setAttribute("aria-label", "Dur\u00e9e par image, " + rowLabel(item));
          text = "\u2248 " + secs(item.median_s) + " par image (" + secs(item.low_s) + " \u2013 " + secs(item.high_s) + ", " + item.samples + " mesures)";
        } else if (labView === "reliability") {
          meter.max = item.samples;
          meter.value = item.completed;
          meter.setAttribute("aria-label", "Images r\u00e9ussies, " + rowLabel(item));
          const bits = [pct(item.completed, item.samples) + " r\u00e9ussies sur " + item.samples];
          if (item.failed) bits.push(item.failed + " en \u00e9chec");
          if (item.uncertain) bits.push(item.uncertain + " incertaine" + (item.uncertain > 1 ? "s" : ""));
          if (item.errors.length) bits.push(item.errors.map((e) => (ERRORS[e.code] || e.code) + " \u00d7" + e.count).join(", "));
          text = bits.join(" \u00b7 ");
        } else {
          meter.max = item.samples;
          meter.value = item.kept;
          meter.setAttribute("aria-label", "Images gard\u00e9es, " + rowLabel(item));
          text = item.kept + " gard\u00e9es sur " + item.samples + " tri\u00e9es (" + pct(item.kept, item.samples) + ")" + (item.favorite ? ", dont " + item.favorite + " favori" + (item.favorite > 1 ? "s" : "") : "");
        }
        line.append(meter, el("span", "forge-lab-value", text), applyButton(item));
        box.append(line);
      });
      if (comparable.length < 2 && group.rows.length > 1) box.append(el("p", "forge-note", "Une comparaison demande au moins deux r\u00e9glages avec " + min + " images chacun."));
      panel.append(box);
    });
    const mixed = $("forge-lab-mixed");
    mixed.replaceChildren();
    const KIND = { device: "L\u2019appareil", sampler: "L\u2019\u00e9chantillonneur", checkpoint: "le mod\u00e8le", size: "la taille" };
    (labData.confounded || []).forEach((m) => {
      mixed.append(el("p", "forge-note", (KIND[m.kind] || m.kind) + " \u00ab " + m.value + " \u00bb n\u2019a \u00e9t\u00e9 mesur\u00e9 qu\u2019avec " + (KIND[m.with_kind] || m.with_kind).replace(/^L/, "l") + " \u00ab " + m.with + " \u00bb : leurs effets ne se s\u00e9parent pas."));
    });
    if (mixed.children.length) mixed.prepend(el("h3", "forge-lab-group-title", "R\u00e9glages m\u00eal\u00e9s"));
    mixed.hidden = !mixed.children.length;
  }
  async function loadLab() {
    try {
      labData = await H.api("/api/forge/lab");
    } catch (error) {
      labData = null;
      $("forge-lab-panel").replaceChildren(el("p", "forge-note", error.message || "Le laboratoire n\u2019a pas pu \u00eatre lu."));
      return;
    }
    renderLab();
  }
  lab.addEventListener("toggle", () => { if (lab.open) loadLab(); });
  $("forge-lab-refresh").addEventListener("click", loadLab);
  document.querySelectorAll(".forge-lab-tabs [role=tab]").forEach((tab) => {
    tab.addEventListener("click", () => { labView = tab.dataset.view; renderLab(); });
  });
  window.hqForgeLabData = () => labData;

  // ------------------------------------------------------------------ C: honest planner
  let planTimer = 0;
  let planAsked = "";
  function planQuery() {
    const fleet = H.fleetMode();
    const count = Number((fleet ? $("forge-fleet-count") : $("forge-iter")).value || 1);
    return "plan=1&width=" + Number($("forge-width").value) + "&height=" + Number($("forge-height").value) + "&steps=" + Number($("forge-steps").value) +
      "&hires=" + ($("forge-hr").checked ? "1" : "0") + "&count=" + count + "&checkpoint=" + encodeURIComponent($("forge-checkpoint").value || "");
  }
  function renderPlan(plan) {
    const box = $("forge-plan");
    box.replaceChildren();
    if (!plan) { box.hidden = true; return; }
    const ready = plan.devices.filter((d) => d.enough);
    const n = plan.count + " image" + (plan.count > 1 ? "s" : "");
    if (!ready.length) {
      box.append(el("p", "forge-note", "Dur\u00e9e par appareil : pas assez de donn\u00e9es pour " + plan.width + "\u00d7" + plan.height + ", " + plan.steps + " pas" +
        (plan.devices.length ? " (" + plan.devices.map((d) => d.device + " " + d.samples + " / " + plan.min_samples).join(", ") + ")" : "") + "."));
    } else {
      box.append(el("p", "forge-note forge-plan-title", "Dur\u00e9e mesur\u00e9e pour " + n + " :"));
      const list = el("ul", "forge-plan-list");
      plan.devices.forEach((d) => {
        list.append(el("li", "", d.enough
          ? d.device + " : " + secs(d.low_s) + " \u2013 " + secs(d.high_s) + " (" + d.samples + " mesures)"
          : d.device + " : pas assez de donn\u00e9es (" + d.samples + " / " + plan.min_samples + ")"));
      });
      box.append(list);
      if (plan.split) {
        box.append(el("p", "forge-note", "Partage sugg\u00e9r\u00e9 : " + plan.split.shares.map((s) => s.device + " " + s.count).join(", ") +
          " \u00b7 \u2248 " + secs(plan.split.low_s) + " \u2013 " + secs(plan.split.high_s) + ". Indicatif : HQ r\u00e9partit le lot lui-m\u00eame."));
      }
    }
    plan.memory.forEach((m) => {
      box.append(el("p", "forge-note forge-plan-warn", "Attention : " + plan.width + "\u00d7" + plan.height + (plan.hires ? " en haute r\u00e9solution" : "") +
        " a d\u00e9j\u00e0 manqu\u00e9 de m\u00e9moire GPU sur " + m.device + " (" + m.times + " fois" + (m.batch > 1 ? ", par " + m.batch + " images" : "") + ")."));
    });
    box.hidden = false;
  }
  async function refreshPlan() {
    const query = planQuery();
    planAsked = query;
    try {
      const data = await H.api("/api/forge/lab?" + query);
      if (planAsked === query) renderPlan(data.plan);
    } catch (_) { $("forge-plan").hidden = true; }
  }
  function queuePlan() {
    clearTimeout(planTimer);
    planTimer = setTimeout(() => { refreshPlan(); }, 500);
  }
  // Size, steps, hires and counts live in several panels; listen at the studio level.
  const PLAN_IDS = new Set(["forge-width", "forge-height", "forge-steps", "forge-steps-range", "forge-hr", "forge-iter", "forge-fleet-count", "forge-checkpoint"]);
  ["input", "change"].forEach((type) => document.addEventListener(type, (event) => {
    const t = event.target;
    if (t && (PLAN_IDS.has(t.id) || (t.closest && t.closest(".forge-device")))) queuePlan();
  }));
  document.addEventListener("click", (event) => { if (event.target && event.target.closest && event.target.closest(".forge-ratio, .forge-lab-apply")) queuePlan(); });
  queuePlan();
  // ------------------------------------------------------------------ D: journal and explicit choices
  const clock = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleTimeString("fr-FR") : ""; };
  const span = (a, b) => { const x = new Date(a), y = new Date(b); return isNaN(x) || isNaN(y) || y < x ? "" : secs((y - x) / 1000); };
  const TASK_STATE = { queued: "en attente", dispatched: "envoy\u00e9e", running: "en cours", saving: "enregistrement", completed: "termin\u00e9e",
    failed: "en \u00e9chec", uncertain: "incertaine", cancelled: "annul\u00e9e", lost: "perdue" };
  function choiceButtons(onPick, canRetry) {
    const row = el("div", "forge-actions forge-journal-choice");
    [["retry", "Relancer"], ["lost", "Marquer perdue"], ["keep", "Garder tel quel"]].forEach(([action, label]) => {
      if (action === "retry" && !canRetry) return;
      const b = el("button", action === "retry" ? "" : "secondary", label);
      b.type = "button";
      b.dataset.action = action;
      b.addEventListener("click", () => { row.querySelectorAll("button").forEach((x) => { x.disabled = true; }); onPick(action).catch((error) => {
        row.querySelectorAll("button").forEach((x) => { x.disabled = false; });
        row.append(el("p", "forge-note", error.message || "Le choix n\u2019a pas \u00e9t\u00e9 enregistr\u00e9."));
      }); });
      row.append(b);
    });
    return row;
  }
  function batchJournal(batch) {
    const list = $("forge-fleet-journal-list");
    if (!list) return;
    const sig = JSON.stringify(batch.tasks.map((t) => [t.id, t.state, t.worker_id, t.dispatched_at, t.finished_at, t.resolution, t.retried]));
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.replaceChildren();
    const tasks = batch.tasks.slice().sort((a, b) => String(a.dispatched_at || "~").localeCompare(String(b.dispatched_at || "~")) || a.index - b.index);
    tasks.forEach((t) => {
      const li = el("li", "forge-journal-item");
      li.dataset.state = t.state;
      const bits = ["Image " + (t.index + 1)];
      if (t.attempt > 1) bits.push("essai " + t.attempt);
      bits.push(t.worker_name || "aucun appareil");
      if (t.dispatched_at) bits.push("envoy\u00e9e " + clock(t.dispatched_at));
      if (t.finished_at) bits.push(TASK_STATE[t.state] + " " + clock(t.finished_at) + (t.state === "completed" && t.dispatched_at ? " (" + span(t.dispatched_at, t.finished_at) + ")" : ""));
      else bits.push(TASK_STATE[t.state] || t.state);
      if (t.resolution) bits.push(t.resolution === "lost" ? "marqu\u00e9e perdue" : "gard\u00e9e telle quelle");
      if (t.retried) bits.push("relanc\u00e9e");
      li.append(el("span", "", bits.join(" \u00b7 ")));
      if (t.message && ["failed", "uncertain"].includes(t.state)) li.append(el("span", "forge-note", t.message));
      if (t.state === "uncertain" && !t.resolution && !t.retried && batch.state !== "running" && batch.state !== "cancelling") {
        li.append(choiceButtons(async (action) => {
          const path = "/api/forge/batches/" + encodeURIComponent(batch.batch_id);
          let payload;
          if (action === "retry") {
            const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
            payload = await H.api(path + "/retry", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ tasks: [t.id] }) });
          } else {
            payload = await post(path + "/tasks/" + encodeURIComponent(t.id) + "/resolve", { action });
          }
          if (payload && payload.batch) H.showBatch(payload.batch);
        }, !t.retry_of_task));
      }
      list.append(li);
    });
  }
  window.hqForgeOnBatch = batchJournal;

  function jobJournal(job) {
    const box = $("forge-job-journal");
    const choice = $("forge-job-choice");
    if (!box || !job || !job.job_id) return;
    const list = $("forge-job-journal-list");
    list.replaceChildren();
    const add = (text) => list.append(el("li", "forge-journal-item", text));
    add("Cr\u00e9\u00e9 " + clock(job.created) + " \u00b7 Cet HQ" + (job.destination === "private" ? " \u00b7 coffre" : ""));
    if (job.started_at) add("Envoy\u00e9 \u00e0 Forge " + clock(job.started_at));
    if (job.finished_at) add((job.state === "completed" ? "Termin\u00e9 " : "Fin " ) + clock(job.finished_at) + (job.duration_ms ? " (" + secs(job.duration_ms / 1000) + ")" : ""));
    add("\u00c9tat : " + (job.state === "unknown" ? "incertain" : job.message || job.state) + (job.resolution ? (job.resolution === "lost" ? " \u00b7 marqu\u00e9 perdu" : " \u00b7 gard\u00e9 tel quel") : ""));
    box.hidden = false;
    choice.replaceChildren();
    choice.hidden = !(job.state === "unknown" && !job.resolution);
    if (choice.hidden) return;
    choice.append(el("p", "forge-note", "Forge n\u2019a pas confirm\u00e9 ce travail. Rien n\u2019est relanc\u00e9 sans vous."));
    const settings = job.settings && Object.keys(job.settings).length ? job.settings : null;
    choice.append(choiceButtons(async (action) => {
      if (action === "retry") {
        H.applySettings(settings);
        choice.replaceChildren(el("p", "forge-note", "R\u00e9glages remis dans le formulaire. Touchez G\u00e9n\u00e9rer pour relancer."));
        return;
      }
      const payload = await post("/api/forge/jobs/" + encodeURIComponent(job.job_id) + "/resolve", { action });
      jobJournal(payload.job);
    }, !!settings));
  }
  window.hqForgeOnJob = jobJournal;
  // The vault lock drops every decrypted view this module opened.
  window.hqForgeNextLock = () => {
    if (mode === "private" && dialog.open) close();
    if (trashMode === "private" && trash.open) closeTrash();
    const row = $("forge-vault-viewer-triage");
    if (row) row.replaceChildren();
  };
})();