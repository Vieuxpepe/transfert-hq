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
  const studio = $("forge-studio");
  const privateBtn = $("forge-generate-private");
  const vaultBox = $("forge-vault");
  const vaultGallery = $("forge-vault-gallery");
  const vaultViewer = $("forge-vault-viewer");
  const vaultViewerImg = $("forge-vault-viewer-img");
  let pollTimer = 0;
  let idleTimer = 0;
  let cursor = null;
  let openFrom = null;
  let currentDetail = null;
  let forgeState = "offline";
  let vaultState = { configured: false, unlocked: false, private_generation: false };
  const privateUrls = new Set();

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
    syncActions();
  }

  function destination() {
    const chosen = document.querySelector('input[name="forge-destination"]:checked');
    return chosen && chosen.value === "private" ? "private" : "normal";
  }

  function syncActions(active) {
    const privateMode = destination() === "private";
    generateBtn.hidden = privateMode;
    privateBtn.hidden = !privateMode;
    generateBtn.disabled = !!active || forgeState !== "ready";
    privateBtn.disabled = !!active || forgeState !== "ready" || !vaultState.private_generation;
    $("forge-normal-results").hidden = privateMode;
    $("forge-normal-gallery").hidden = privateMode;
    studio.classList.toggle("forge-private", privateMode);
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

  function card(image, mode) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "forge-card";
    button.dataset.id = image.id;
    const img = document.createElement("img");
    img.alt = mode === "private" ? "Image du coffre" : "Image générée";
    button.appendChild(img);
    if (mode === "private") {
      privateThumb(image.id).then((url) => { img.src = url; }).catch(() => { img.alt = "Image indisponible"; });
      button.addEventListener("click", () => openPrivate(image.id, button));
    } else {
      img.src = image.thumb;
      button.addEventListener("click", () => openViewer(image.id, button));
    }
    return button;
  }

  async function privateThumb(id) {
    const response = await fetch("/api/forge/vault/images/" + id + "/thumb", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("locked");
    const url = URL.createObjectURL(await response.blob());
    privateUrls.add(url);
    return url;
  }

  function clearPrivateUi() {
    privateUrls.forEach((url) => URL.revokeObjectURL(url));
    privateUrls.clear();
    if (vaultGallery) vaultGallery.replaceChildren();
    if (vaultViewerImg) {
      vaultViewerImg.removeAttribute("src");
      vaultViewerImg.alt = "";
    }
    if (vaultViewer && vaultViewer.open) vaultViewer.close();
    const meta = $("forge-vault-viewer-meta");
    if (meta) meta.textContent = "";
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
      if (job.destination === "private") {
        if (job.state === "completed" && vaultState.unlocked) refreshVault().catch(() => {});
      } else if (job.images && job.images.length) {
        results.replaceChildren();
        job.images.forEach((image) => results.appendChild(card({ id: image.id, thumb: "/api/forge/gallery/" + image.id + "/thumb" })));
      }
    }
    syncActions(active);
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
      if (payload.job.state === "completed" && payload.job.destination !== "private") loadGallery(true).catch(() => {});
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
      syncActions(false);
    }
  });

  async function privateGenerate() {
    if (!vaultState.unlocked) {
      const pass = $("forge-vault-pass");
      const error = $("forge-vault-error");
      if (error) error.textContent = "Déverrouillez le coffre avant une génération privée.";
      if (pass) pass.focus();
      return;
    }
    if (!vaultState.private_generation) return;
    privateBtn.disabled = true;
    progressBox.hidden = false;
    progressLabel.textContent = "Envoi privé…";
    try {
      const payload = await api("/api/forge/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
        body: JSON.stringify(Object.assign(settingsFromForm(), { destination: "private" }))
      });
      showJob(payload.job);
    } catch (error) {
      progressLabel.textContent = error.message || "La génération privée n'a pas démarré.";
      syncActions(false);
    }
  }

  form.addEventListener("submit", (event) => {
    if (destination() !== "private") return;
    event.stopImmediatePropagation();
    event.preventDefault();
    privateGenerate();
  }, true);

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

  const disabledCopy = $("forge-private-note") ? $("forge-private-note").textContent : "";
  let privateDetail = null;

  function bumpIdle() {
    clearTimeout(idleTimer);
    if (!vaultState.unlocked) return;
    idleTimer = setTimeout(() => { lockVault().catch(() => {}); }, 5 * 60 * 1000);
  }

  async function refreshVault() {
    vaultState = await api("/api/forge/vault/status");
    const privateMode = destination() === "private";
    vaultBox.hidden = !privateMode;
    $("forge-vault-setup").hidden = !privateMode || vaultState.configured;
    $("forge-vault-unlock").hidden = !privateMode || !vaultState.configured || vaultState.unlocked;
    $("forge-vault-open-tools").hidden = !privateMode || !vaultState.unlocked;
    const note = $("forge-private-note");
    note.hidden = !privateMode || vaultState.private_generation;
    if (!vaultState.private_generation) note.textContent = disabledCopy;
    if (!vaultState.unlocked) clearPrivateUi();
    else if (privateMode) await loadVaultGallery();
    syncActions(false);
    bumpIdle();
  }

  async function loadVaultGallery() {
    if (!vaultState.unlocked) return;
    const page = await api("/api/forge/vault/gallery?limit=24");
    clearPrivateUi();
    vaultState.unlocked = true;
    (page.images || []).forEach((image) => vaultGallery.appendChild(card(image, "private")));
    $("forge-vault-empty").hidden = (page.images || []).length > 0;
  }

  async function lockVault() {
    await api("/api/forge/vault/lock", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    clearPrivateUi();
    await refreshVault();
  }

  document.querySelectorAll('input[name="forge-destination"]').forEach((input) => {
    input.addEventListener("change", () => { refreshVault().catch((error) => { statusEl.textContent = error.message; }); });
  });
  privateBtn.addEventListener("click", () => privateGenerate());
  studio.addEventListener("pointerdown", bumpIdle);
  studio.addEventListener("keydown", bumpIdle);

  $("forge-vault-setup").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = await api("/api/forge/vault/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: $("forge-vault-new").value, confirm: $("forge-vault-confirm").value })
      });
      $("forge-vault-new").value = "";
      $("forge-vault-confirm").value = "";
      $("forge-vault-recovery-key").value = payload.recovery_key || "";
      $("forge-vault-recovery-extra").hidden = true;
      $("forge-vault-recovery").hidden = false;
      $("forge-vault-setup").hidden = true;
    } catch (error) {
      $("forge-private-note").hidden = false;
      $("forge-private-note").textContent = error.message || "Le coffre n'a pas été créé.";
    }
  });
  $("forge-vault-recovery-ok").addEventListener("click", () => {
    $("forge-vault-recovery-key").value = "";
    $("forge-vault-recovery-extra").textContent = "";
    $("forge-vault-recovery-extra").hidden = true;
    $("forge-vault-recovery").hidden = true;
    refreshVault().catch(() => {});
  });
  $("forge-vault-reveal").addEventListener("click", () => {
    const input = $("forge-vault-pass");
    const shown = input.type === "text";
    input.type = shown ? "password" : "text";
    $("forge-vault-reveal").textContent = shown ? "Afficher" : "Masquer";
    $("forge-vault-reveal").setAttribute("aria-pressed", shown ? "false" : "true");
  });
  $("forge-vault-unlock").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/forge/vault/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: $("forge-vault-pass").value })
      });
      $("forge-vault-pass").value = "";
      $("forge-vault-error").textContent = "";
      await refreshVault();
    } catch (error) {
      $("forge-vault-pass").value = "";
      $("forge-vault-error").textContent = error.message || "Phrase refusée.";
    }
  });
  $("forge-vault-back").addEventListener("click", () => {
    document.querySelector('input[name="forge-destination"][value="normal"]').checked = true;
    refreshVault().catch(() => {});
    promptEl.focus();
  });
  $("forge-vault-lock").addEventListener("click", () => lockVault().catch((error) => { statusEl.textContent = error.message; }));
  $("forge-vault-backup").addEventListener("click", async () => {
    const response = await fetch("/api/forge/vault/backup", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "coffre-chiffre.zip";
    link.click();
    URL.revokeObjectURL(url);
  });
  $("forge-vault-import").addEventListener("change", async () => {
    const file = $("forge-vault-import").files && $("forge-vault-import").files[0];
    $("forge-vault-import").value = "";
    if (!file) return;
    try {
      await api("/api/forge/vault/import", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
      await loadVaultGallery();
    } catch (error) {
      statusEl.textContent = error.message || "Import impossible.";
    }
  });
  $("forge-vault-rotate").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/forge/vault/passphrase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current: $("forge-vault-current").value,
          passphrase: $("forge-vault-next").value,
          confirm: $("forge-vault-next-confirm").value
        })
      });
      $("forge-vault-current").value = "";
      $("forge-vault-next").value = "";
      $("forge-vault-next-confirm").value = "";
      await refreshVault();
    } catch (error) {
      $("forge-vault-error").textContent = error.message || "La phrase n'a pas changé.";
    }
  });
  $("forge-vault-rekey").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = await api("/api/forge/vault/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: $("forge-vault-rekey-pass").value })
      });
      $("forge-vault-rekey-pass").value = "";
      $("forge-vault-recovery-key").value = payload.recovery_key || "";
      $("forge-vault-recovery-extra").textContent = "L'ancienne clé de récupération ne fonctionne plus.";
      $("forge-vault-recovery-extra").hidden = false;
      $("forge-vault-recovery").hidden = false;
      $("forge-vault-open-tools").hidden = true;
    } catch (error) {
      $("forge-vault-rekey-pass").value = "";
      $("forge-vault-error").textContent = error.message || "La clé n'a pas été remplacée.";
    }
  });

  function applySettings(settings) {
    if (!settings) return;
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
  }

  async function openPrivate(id, from) {
    openFrom = from || document.activeElement;
    privateDetail = await api("/api/forge/vault/images/" + id);
    const response = await fetch("/api/forge/vault/images/" + id + "/original", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("locked");
    const url = URL.createObjectURL(await response.blob());
    privateUrls.add(url);
    vaultViewerImg.src = url;
    vaultViewerImg.alt = "Image du coffre";
    const settings = privateDetail.settings || {};
    $("forge-vault-viewer-meta").textContent = [settings.prompt || "", settings.negative_prompt || ""].filter(Boolean).join("\n");
    vaultViewer.showModal();
    $("forge-vault-viewer-close").focus();
  }

  function closePrivate() {
    if (vaultViewer.open) vaultViewer.close();
    if (vaultViewerImg.src) URL.revokeObjectURL(vaultViewerImg.src);
    vaultViewerImg.removeAttribute("src");
    if (openFrom) openFrom.focus();
  }

  $("forge-vault-viewer-close").addEventListener("click", closePrivate);
  vaultViewer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePrivate();
    }
  });
  $("forge-vault-download").addEventListener("click", async () => {
    if (!privateDetail) return;
    const response = await fetch("/api/forge/vault/images/" + privateDetail.id + "/original", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "coffre.png";
    link.click();
    URL.revokeObjectURL(url);
  });
  $("forge-vault-reuse").addEventListener("click", () => {
    applySettings(privateDetail && privateDetail.settings);
    closePrivate();
    promptEl.focus();
  });
  $("forge-vault-delete").addEventListener("click", async () => {
    if (!privateDetail || !window.confirm("Supprimer cette image du coffre ?")) return;
    await api("/api/forge/vault/images/" + privateDetail.id + "/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    privateDetail = null;
    closePrivate();
    loadVaultGallery().catch(() => {});
  });

  window.hqForgeShow = function () {
    refreshStatus().then(() => refreshVault()).then(() => Promise.all([resume(), loadGallery(true)])).catch(() => {});
  };
  window.hqForgeHide = function () {
    clearTimeout(pollTimer);
    clearTimeout(idleTimer);
    if (viewer.open) viewer.close();
    clearPrivateUi();
  };
})();
