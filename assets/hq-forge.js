/* Forge Studio workspace. Talks only to same-origin HQ routes. */
(function () {
  const $ = (id) => document.getElementById(id);
  const form = $("forge-form");
  if (!form) return;
  const statusEl = $("forge-status");
  const promptEl = $("forge-prompt");
  const negativeEl = $("forge-negative");
  const checkpointEl = $("forge-checkpoint");
  const samplerEl = $("forge-sampler");
  const schedulerEl = $("forge-scheduler");
  const generateBtn = $("forge-generate");
  const cancelBtn = $("forge-cancel");
  const progressBox = $("forge-progress");
  const progressBar = $("forge-progress-bar");
  const progressLabel = $("forge-progress-label");
  const results = $("forge-results");
  const gallery = $("forge-gallery");
  const moreBtn = $("forge-more");
  const viewer = $("forge-viewer");
  const viewerImg = $("forge-viewer-img");
  const viewerMeta = $("forge-viewer-meta");
  const downloadLink = $("forge-download");
  const reuseBtn = $("forge-reuse");
  const deleteBtn = $("forge-delete");
  const closeBtn = $("forge-viewer-close");
  let pollTimer = 0;
  let cursor = null;
  let openFrom = null;
  let currentDetail = null;
  let forgeState = "offline";

  function key() {
    let value = sessionStorage.getItem("hqForgeKey");
    if (!value) {
      value = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      if (value.length < 8) value = "hqforge" + value;
      sessionStorage.setItem("hqForgeKey", value);
    }
    return value;
  }

  function freshKey() {
    sessionStorage.removeItem("hqForgeKey");
    return key();
  }

  async function api(path, options) {
    const response = await fetch(path, Object.assign({ credentials: "same-origin", headers: {} }, options || {}));
    const type = response.headers.get("content-type") || "";
    const data = type.includes("json") ? await response.json() : null;
    if (!response.ok) {
      const error = new Error((data && (data.message || data.error)) || "Erreur");
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function option(select, value, label) {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = label;
    select.appendChild(node);
  }

  function fillSelect(select, items, pick) {
    const current = select.value;
    select.replaceChildren();
    items.forEach((item) => {
      const chosen = pick(item);
      if (chosen) option(select, chosen.value, chosen.label);
    });
    if ([...select.options].some((item) => item.value === current)) select.value = current;
  }

  function setStatus(payload) {
    forgeState = payload && payload.forge || "error";
    statusEl.dataset.state = forgeState;
    const model = payload && payload.model ? " Modèle chargé : " + payload.model + "." : "";
    statusEl.textContent = ((payload && payload.message) || "Forge est indisponible.") + model;
    generateBtn.disabled = forgeState !== "ready";
  }

  async function refreshStatus() {
    try {
      setStatus(await api("/api/forge/status"));
      const catalog = await api("/api/forge/catalog");
      if (catalog.forge === "ready") {
        fillSelect(checkpointEl, catalog.models || [], (item) => item.title ? { value: item.title, label: item.title } : null);
        fillSelect(samplerEl, catalog.samplers || [], (item) => item.name ? { value: item.name, label: item.name } : null);
        fillSelect(schedulerEl, catalog.schedulers || [], (item) => item.name ? { value: item.name, label: item.label || item.name } : null);
      }
    } catch (error) {
      statusEl.dataset.state = "error";
      statusEl.textContent = error.message || "Forge est indisponible.";
      generateBtn.disabled = true;
    }
  }

  function card(image) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "forge-card";
    button.dataset.id = image.id;
    const img = document.createElement("img");
    img.src = image.thumb;
    img.alt = "Image générée";
    button.appendChild(img);
    button.addEventListener("click", () => openViewer(image.id, button));
    return button;
  }

  async function loadGallery(reset) {
    if (reset) {
      cursor = null;
      gallery.replaceChildren();
    }
    const path = "/api/forge/gallery?limit=24" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const page = await api(path);
    (page.images || []).forEach((image) => gallery.appendChild(card(image)));
    cursor = page.next_cursor || null;
    moreBtn.hidden = !cursor;
  }

  function showJob(job) {
    const active = job && ["queued", "starting", "generating", "saving"].includes(job.state);
    cancelBtn.disabled = !active || job.cancel === "deferred";
    progressBox.hidden = !active && !(job && job.state === "unknown");
    if (job) {
      progressBar.value = Number(job.progress || 0);
      progressLabel.textContent = job.message || job.state || "";
      if (job.images && job.images.length) {
        results.replaceChildren();
        job.images.forEach((image) => results.appendChild(card({ id: image.id, thumb: "/api/forge/gallery/" + image.id + "/thumb" })));
      }
    }
    generateBtn.disabled = active || forgeState !== "ready";
    if (active) {
      sessionStorage.setItem("hqForgeJob", job.job_id);
      clearTimeout(pollTimer);
      pollTimer = setTimeout(() => poll(job.job_id), 2000);
    } else if (job && job.job_id) {
      clearTimeout(pollTimer);
      sessionStorage.removeItem("hqForgeJob");
      freshKey();
    }
  }

  async function poll(jobId) {
    try {
      const payload = await api("/api/forge/jobs/" + jobId);
      showJob(payload.job);
      if (payload.job.state === "completed") loadGallery(true).catch(() => {});
    } catch (error) {
      progressLabel.textContent = error.message || "Le suivi a été interrompu. Le travail peut continuer.";
    }
  }

  async function resume() {
    const jobId = sessionStorage.getItem("hqForgeJob");
    if (!jobId) return;
    try { await poll(jobId); } catch (_) { /* the job row is gone */ }
  }

  function settingsFromForm() {
    const seed = forgeSeed();
    return {
      prompt: promptEl.value,
      negative_prompt: negativeEl.value,
      checkpoint: checkpointEl.value,
      sampler_name: samplerEl.value,
      scheduler: schedulerEl.value,
      width: Number($("forge-width").value),
      height: Number($("forge-height").value),
      steps: Number($("forge-steps").value),
      cfg_scale: Number($("forge-cfg").value),
      seed: seed,
      n_iter: Number($("forge-iter").value),
      batch_size: 1
    };
  }

  function forgeSeed() {
    const raw = $("forge-seed").value.trim();
    if (raw === "") return -1;
    return Number(raw);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    generateBtn.disabled = true;
    progressBox.hidden = false;
    progressLabel.textContent = "Envoi…";
    try {
      const payload = await api("/api/forge/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
        body: JSON.stringify(settingsFromForm())
      });
      showJob(payload.job);
    } catch (error) {
      if (error && error.status === 409 && error.data && error.data.active_job_id) {
        sessionStorage.setItem("hqForgeJob", error.data.active_job_id);
        poll(error.data.active_job_id);
        return;
      }
      try {
        const existing = await api("/api/forge/jobs?idempotency_key=" + encodeURIComponent(key()));
        showJob(existing.job);
        return;
      } catch (_) { /* the POST itself failed */ }
      progressLabel.textContent = error.message || "La génération n'a pas pu démarrer.";
      generateBtn.disabled = forgeState !== "ready";
    }
  });

  cancelBtn.addEventListener("click", async () => {
    const jobId = sessionStorage.getItem("hqForgeJob");
    if (!jobId) return;
    try {
      const payload = await api("/api/forge/jobs/" + jobId + "/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      progressLabel.textContent = payload.message || "";
      showJob(payload.job);
    } catch (error) {
      progressLabel.textContent = error.message || "Annulation impossible.";
    }
  });

  function focusable() {
    return [...viewer.querySelectorAll("button, a, input, select, textarea")].filter((node) => !node.disabled && node.offsetParent !== null);
  }

  function closeViewer() {
    if (viewer.open) viewer.close();
    if (openFrom) openFrom.focus();
    openFrom = null;
  }

  async function openViewer(id, from) {
    openFrom = from || document.activeElement;
    const detail = await api("/api/forge/gallery/" + id);
    currentDetail = detail;
    viewerImg.src = detail.original;
    viewerImg.alt = detail.settings && detail.settings.prompt ? detail.settings.prompt : "Image générée";
    const settings = detail.settings || {};
    viewerMeta.textContent = [
      settings.prompt || "",
      settings.negative_prompt ? "Négatif : " + settings.negative_prompt : "",
      settings.checkpoint || "",
      [settings.width, settings.height].filter(Boolean).join("×"),
      settings.seed != null ? "Graine " + settings.seed : ""
    ].filter(Boolean).join("\n");
    downloadLink.href = detail.original;
    viewer.showModal();
    closeBtn.focus();
  }

  viewer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeViewer();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = focusable();
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  closeBtn.addEventListener("click", closeViewer);
  viewer.addEventListener("close", () => { if (openFrom) openFrom.focus(); });
  reuseBtn.addEventListener("click", () => {
    const settings = currentDetail && currentDetail.settings || {};
    if (settings.prompt) promptEl.value = settings.prompt;
    negativeEl.value = settings.negative_prompt || "";
    if (settings.checkpoint) checkpointEl.value = settings.checkpoint;
    if (settings.sampler_name) samplerEl.value = settings.sampler_name;
    if (settings.scheduler) schedulerEl.value = settings.scheduler;
    if (settings.width) $("forge-width").value = settings.width;
    if (settings.height) $("forge-height").value = settings.height;
    if (settings.steps) $("forge-steps").value = settings.steps;
    if (settings.cfg_scale) $("forge-cfg").value = settings.cfg_scale;
    if (settings.seed != null) $("forge-seed").value = settings.seed;
    if (settings.n_iter) $("forge-iter").value = String(settings.n_iter);
    closeViewer();
    promptEl.focus();
  });
  deleteBtn.addEventListener("click", async () => {
    if (!currentDetail || !window.confirm("Supprimer cette copie HQ ? Le fichier de Forge, s'il existe, n'est pas touché.")) return;
    await api("/api/forge/gallery/" + currentDetail.id + "/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    closeViewer();
    loadGallery(true).catch(() => {});
  });
  moreBtn.addEventListener("click", () => loadGallery(false).catch((error) => { statusEl.textContent = error.message; }));

  window.hqForgeShow = function () {
    refreshStatus().then(() => Promise.all([resume(), loadGallery(true)])).catch(() => {});
  };
  window.hqForgeHide = function () {
    clearTimeout(pollTimer);
    if (viewer.open) viewer.close();
  };
})();
