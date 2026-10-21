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
  let submitGuard = false;
  let justSubmitted = false;
  let cursor = null;
  let openFrom = null;
  let currentDetail = null;
  let forgeState = "offline";
  let catalogState = "offline";
  let vaultState = { configured: false, unlocked: false, private_generation: false };
  const choiceNote = $("forge-choice-note");
  const reasonEl = $("forge-generate-reason");
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

  function fillSelect(select, items, pick, prefer) {
    const previous = select.value;
    select.replaceChildren();
    items.forEach((item) => {
      const chosen = pick(item);
      if (chosen) option(select, chosen.value, chosen.label);
    });
    const values = [...select.options].map((item) => item.value);
    if (previous && values.includes(previous)) {
      select.value = previous;
      return false;
    }
    if (prefer && values.includes(prefer)) select.value = prefer;
    else if (select.options.length) select.value = select.options[0].value;
    return !!previous;
  }

  function fillUpscalers(items) {
    const select = $("forge-hr-upscaler");
    const previous = select.value;
    select.replaceChildren();
    items.forEach((item) => {
      if (item && item.name) option(select, item.name, item.name);
    });
    const values = [...select.options].map((item) => item.value);
    $("forge-hr").disabled = !values.length;
    if (!values.length) {
      option(select, "", "Indisponible");
      select.value = "";
      $("forge-hr").checked = false;
      return;
    }
    if (previous && values.includes(previous)) {
      select.value = previous;
      return;
    }
    if (previous) {
      option(select, "", "Indisponible");
      select.value = "";
      return;
    }
    if (values.includes("R-ESRGAN 4x+")) select.value = "R-ESRGAN 4x+";
    else select.value = select.options[0].value;
  }

  function clearChoices(text) {
    [checkpointEl, samplerEl, schedulerEl, $("forge-hr-upscaler")].forEach((select) => {
      select.replaceChildren();
      option(select, "", "Indisponible");
      select.value = "";
    });
    if (choiceNote) choiceNote.textContent = text || "";
    syncHiresNote();
  }

  function describeChoices(stale) {
    if (!choiceNote) return;
    const parts = [];
    const model = checkpointEl.selectedOptions[0];
    const sampler = samplerEl.selectedOptions[0];
    const scheduler = schedulerEl.selectedOptions[0];
    if (model && model.value) parts.push("Modèle : " + model.textContent);
    if (sampler && sampler.value) parts.push("Échantillonneur : " + sampler.textContent);
    if (scheduler && scheduler.value) parts.push("Planificateur : " + scheduler.textContent);
    const dropped = stale ? " Le choix précédent n'est plus proposé." : "";
    choiceNote.textContent = parts.length ? parts.join(". ") + "." + dropped : "";
  }

  function statusCopy(payload) {
    const code = payload && payload.code || "";
    if (code === "forge_offline" || (payload && payload.forge === "offline")) {
      return "Forge n'est pas démarré. Ouvrez-le avec le lanceur API de ce compte. Le lanceur habituel ne l'active pas.";
    }
    if (code === "api_disabled" || (payload && payload.forge === "api_disabled")) {
      return "Forge est ouvert, mais son API n'est pas activée.";
    }
    const model = payload && payload.model ? " Modèle chargé : " + payload.model + "." : "";
    return ((payload && payload.message) || "Forge est indisponible.") + model;
  }

  function setStatus(payload) {
    forgeState = payload && payload.forge || "error";
    statusEl.dataset.state = forgeState === "loading" ? "busy" : forgeState;
    statusEl.textContent = statusCopy(payload);
    syncActions();
  }

  function destination() {
    const chosen = document.querySelector('input[name="forge-destination"]:checked');
    return chosen && chosen.value === "private" ? "private" : "normal";
  }

  function hiresOn() {
    return $("forge-hr").checked;
  }

  function hiresFits() {
    const scale = Number($("forge-hr-scale").value);
    return Number($("forge-width").value) * scale <= 2048 && Number($("forge-height").value) * scale <= 2048;
  }

  function syncHiresNote() {
    const note = $("forge-hr-note");
    const upscaler = $("forge-hr-upscaler");
    if (!note || !upscaler) return;
    const unavailable = !upscaler.options.length || (upscaler.options.length === 1 && !upscaler.value);
    if (unavailable) {
      note.textContent = "Aucun agrandisseur n'est proposé. Hires. fix reste indisponible.";
      return;
    }
    if (hiresOn() && !hiresFits()) {
      note.textContent = "Cette échelle dépasse 2048 pixels. Choisissez 1,5 ou une image plus petite.";
      return;
    }
    note.textContent = "";
  }

  function syncActions(active) {
    const privateMode = destination() === "private";
    generateBtn.hidden = privateMode;
    privateBtn.hidden = !privateMode;
    const hiresPrivate = hiresOn() && privateMode;
    const hiresMissing = hiresOn() && !$("forge-hr-upscaler").value;
    const hiresLarge = hiresOn() && !hiresFits();
    const ready = !active && !hiresPrivate && !hiresMissing && !hiresLarge && forgeState === "ready" && catalogState === "ready" && checkpointEl.value && samplerEl.value && schedulerEl.value;
    generateBtn.disabled = !ready;
    privateBtn.disabled = !ready || !vaultState.private_generation;
    if (reasonEl) {
      if (active) reasonEl.textContent = "Générer est désactivé : une génération est déjà en cours.";
      else if (forgeState === "offline") reasonEl.textContent = "Générer est désactivé : Forge n'est pas démarré.";
      else if (forgeState === "api_disabled") reasonEl.textContent = "Générer est désactivé : l'API Forge n'est pas activée.";
      else if (forgeUnreachable) reasonEl.textContent = "Générer est désactivé : Forge n'a pas répondu.";
      else if (forgeState !== "ready" || catalogState !== "ready") reasonEl.textContent = "Générer est désactivé : le catalogue n'est pas disponible.";
      else if (!checkpointEl.value) reasonEl.textContent = "Générer est désactivé : aucun modèle n'est choisi.";
      else if (!samplerEl.value) reasonEl.textContent = "Générer est désactivé : aucun échantillonneur n'est choisi.";
      else if (!schedulerEl.value) reasonEl.textContent = "Générer est désactivé : aucun planificateur n'est choisi.";
      else if (hiresPrivate) reasonEl.textContent = "Générer est désactivé : Hires. fix n'est pas disponible en génération privée.";
      else if (hiresMissing) reasonEl.textContent = "Générer est désactivé : l'agrandisseur n'est pas disponible.";
      else if (hiresLarge) reasonEl.textContent = "Générer est désactivé : le second passage dépasserait 2048 pixels.";
      else reasonEl.textContent = "";
    }
    $("forge-normal-results").hidden = privateMode;
    $("forge-normal-gallery").hidden = privateMode;
    studio.classList.toggle("forge-private", privateMode);
  }

  let forgeUnreachable = false;

  async function refreshStatus() {
    const first = catalogState === "offline" && forgeState === "offline" && !checkpointEl.options.length;
    if (first) {
      statusEl.dataset.state = "busy";
      statusEl.textContent = "Connexion à Forge…";
    }
    try {
      const status = await api("/api/forge/status");
      const catalog = await api("/api/forge/catalog");
      forgeUnreachable = false;
      catalogState = catalog && catalog.forge === "ready" ? "ready" : (catalog && catalog.code) || "error";
      setStatus(status);
      if (catalog && catalog.forge === "ready") {
        const staleModel = fillSelect(checkpointEl, catalog.models || [], (item) => item.title ? { value: item.title, label: item.title } : null, "");
        const staleSampler = fillSelect(samplerEl, catalog.samplers || [], (item) => item.name ? { value: item.name, label: item.name } : null, "Euler a");
        const stalePlan = fillSelect(schedulerEl, catalog.schedulers || [], (item) => item.name ? { value: item.name, label: item.label || item.name } : null, "automatic");
        fillUpscalers(catalog.upscalers || []);
        describeChoices(staleModel || staleSampler || stalePlan);
        syncHiresNote();
      } else if (catalog && catalog.code === "catalog_empty") {
        clearChoices("Forge répond, mais le catalogue utilisable est vide. Ce n'est pas une API absente.");
      } else if (catalog && (catalog.code === "forge_malformed" || catalog.code === "forge_schema")) {
        clearChoices("Le catalogue renvoyé par Forge est illisible. Les menus ne sont pas remplis.");
      } else if (status && (status.code === "forge_offline" || status.forge === "offline")) {
        clearChoices("Forge n'est pas démarré. Les menus se rempliront quand le lanceur API sera prêt.");
      } else if (status && (status.code === "api_disabled" || status.forge === "api_disabled")) {
        clearChoices("Forge est ouvert, mais son API n'est pas activée.");
      } else {
        clearChoices("Le catalogue n'est pas disponible. Les menus restent vides.");
      }
      syncActions();
    } catch (error) {
      forgeUnreachable = true;
      catalogState = "error";
      forgeState = "error";
      statusEl.dataset.state = "error";
      statusEl.textContent = error.message || "Forge est indisponible.";
      clearChoices("La lecture de Forge a échoué.");
      syncActions();
      generateBtn.disabled = true;
      privateBtn.disabled = true;
      if (reasonEl) reasonEl.textContent = "Générer est désactivé : Forge n'a pas répondu.";
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
      historyLoaded = false;
    }
    const path = "/api/forge/gallery?limit=24" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const page = await api(path);
    (page.images || []).forEach((image) => gallery.appendChild(card(image)));
    const galleryEmpty = $("forge-gallery-empty");
    if (galleryEmpty) galleryEmpty.hidden = gallery.children.length > 0;
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
        const resultsEmpty = $("forge-results-empty");
        if (resultsEmpty) resultsEmpty.hidden = true;
      }
    }
    syncActions(active);
    if (!active) submitGuard = false;
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
      if (payload.job.state === "completed" && payload.job.destination !== "private") {
        loadGallery(true).catch(() => {});
        if (justSubmitted && window.matchMedia && window.matchMedia("(max-width: 899px)").matches) {
          const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          $("forge-normal-results").scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
        }
      }
      if (payload.job.state !== "queued" && !["starting", "generating", "saving"].includes(payload.job.state)) justSubmitted = false;
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
      batch_size: 1,
      enable_hr: $("forge-hr").checked,
      hr_scale: Number($("forge-hr-scale").value),
      hr_upscaler: $("forge-hr-upscaler").value,
      hr_second_pass_steps: Number($("forge-hr-steps").value),
      denoising_strength: Number($("forge-hr-denoise").value)
    };
  }

  function seedMode() {
    const chosen = document.querySelector('input[name="forge-seed-mode"]:checked');
    return chosen && chosen.value === "fixed" ? "fixed" : "random";
  }

  function forgeSeed() {
    if (seedMode() !== "fixed") return -1;
    const raw = $("forge-seed").value.trim();
    if (raw === "") return -1;
    return Number(raw);
  }

  function syncSeedMode() {
    $("forge-seed").disabled = seedMode() !== "fixed";
  }

  function applySeed(seed) {
    const fixed = Number(seed) >= 0;
    document.querySelector('input[name="forge-seed-mode"][value="' + (fixed ? "fixed" : "random") + '"]').checked = true;
    if (fixed) $("forge-seed").value = String(Math.trunc(Number(seed)));
    syncSeedMode();
  }

  function syncRanges() {
    $("forge-steps-range").value = $("forge-steps").value;
    $("forge-cfg-range").value = $("forge-cfg").value;
    $("forge-hr-denoise-range").value = $("forge-hr-denoise").value;
    $("forge-steps-live").textContent = $("forge-steps").value;
    $("forge-cfg-live").textContent = $("forge-cfg").value;
    $("forge-hr-denoise-live").textContent = String($("forge-hr-denoise").value).replace(".", ",");
    document.querySelectorAll(".forge-ratio").forEach((button) => {
      const selected = button.dataset.width === String($("forge-width").value) && button.dataset.height === String($("forge-height").value);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  }

  function applyHires(settings) {
    $("forge-hr").checked = !!(settings && settings.enable_hr);
    if (settings && settings.hr_scale) $("forge-hr-scale").value = String(settings.hr_scale);
    if (settings && settings.hr_second_pass_steps != null) $("forge-hr-steps").value = String(settings.hr_second_pass_steps);
    if (settings && settings.denoising_strength != null) $("forge-hr-denoise").value = String(settings.denoising_strength);
    syncRanges();
    syncHiresNote();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitGuard || generateBtn.disabled) return;
    submitGuard = true;
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
      submitGuard = false;
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
    if (!vaultState.private_generation || privateBtn.disabled) return;
    if (submitGuard) return;
    submitGuard = true;
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
      submitGuard = false;
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
    closeViewer();
    requestRestore(settings, "all", "image de la galerie");
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
    if (!vaultState.private_generation) {
      note.textContent = vaultState.acl === "unverified"
        ? "La génération privée attend un coffre limité à ce compte Windows."
        : disabledCopy;
    }
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
    input.addEventListener("change", () => {
      syncActions();
      syncHiresNote();
      refreshVault().catch((error) => { statusEl.textContent = error.message; });
    });
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
    if (settings.seed != null) applySeed(settings.seed);
    if (settings.n_iter) $("forge-iter").value = String(settings.n_iter);
    applyHires(settings);
    const upscaler = $("forge-hr-upscaler");
    if (settings.enable_hr && settings.hr_upscaler && [...upscaler.options].some((item) => item.value === settings.hr_upscaler)) {
      upscaler.value = settings.hr_upscaler;
    }
    syncActions();
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

  let presets = [];
  let loadedPreset = null;
  let cleanSnapshot = "";
  let editorMode = "create";
  const presetList = $("forge-preset-list");
  const presetState = $("forge-preset-state");
  const presetEditor = $("forge-preset-editor");

  function presetKind() {
    const chosen = document.querySelector('input[name="forge-preset-kind"]:checked');
    return chosen && chosen.value === "creative" ? "creative" : "technical";
  }

  function currentSettings(kind) {
    return {
      kind: kind,
      prompt: kind === "creative" ? promptEl.value : "",
      negative_prompt: negativeEl.value,
      checkpoint: checkpointEl.value,
      sampler_name: samplerEl.value,
      scheduler: schedulerEl.value,
      width: Number($("forge-width").value),
      height: Number($("forge-height").value),
      steps: Number($("forge-steps").value),
      cfg_scale: Number($("forge-cfg").value),
      seed: forgeSeed(),
      n_iter: Number($("forge-iter").value),
      batch_size: 1,
      enable_hr: $("forge-hr").checked,
      hr_scale: Number($("forge-hr-scale").value),
      hr_upscaler: $("forge-hr-upscaler").value,
      hr_second_pass_steps: Number($("forge-hr-steps").value),
      denoising_strength: Number($("forge-hr-denoise").value)
    };
  }

  function snapshotOf(settings) {
    const copy = Object.assign({}, settings);
    if (copy.kind !== "creative") copy.prompt = "";
    return JSON.stringify(copy);
  }

  function renderPresetList() {
    const current = presetList.value;
    presetList.replaceChildren();
    option(presetList, "", "Aucun");
    presets.forEach((item) => option(presetList, item.id, item.name + (item.kind === "creative" ? " · créatif" : " · technique")));
    if ([...presetList.options].some((item) => item.value === current)) presetList.value = current;
  }

  function selectedPreset() {
    return presets.find((item) => item.id === presetList.value) || null;
  }

  function refreshPresetState() {
    $("forge-preset-update").disabled = !loadedPreset;
    $("forge-preset-rename").disabled = !selectedPreset();
    $("forge-preset-duplicate").disabled = !selectedPreset();
    $("forge-preset-delete").disabled = !selectedPreset();
    if (!loadedPreset) return;
    const dirty = snapshotOf(currentSettings(loadedPreset.kind)) !== cleanSnapshot;
    const partial = presetState.dataset.partial || "";
    presetState.textContent = (dirty ? "Modifié par rapport à « " + loadedPreset.name + " ». " : "Correspond à « " + loadedPreset.name + " ». ") + partial;
  }

  async function loadPresetList() {
    const data = await api("/api/forge/presets");
    presets = data.presets || [];
    renderPresetList();
    if (data.storage === "malformed") presetState.textContent = data.message || "Le fichier de préréglages est illisible.";
    else if (!loadedPreset) presetState.textContent = presets.length ? "" : "Aucun préréglage enregistré.";
    refreshPresetState();
  }

  function applyPreset(preset) {
    const missing = [];
    const take = (select, value, label) => {
      if ([...select.options].some((item) => item.value === value)) {
        select.value = value;
        return;
      }
      let empty = [...select.options].find((item) => item.value === "");
      if (!empty) {
        empty = document.createElement("option");
        empty.value = "";
        select.prepend(empty);
      }
      empty.textContent = "Indisponible";
      select.value = "";
      missing.push(label + " « " + value + " »");
    };
    take(checkpointEl, preset.checkpoint, "modèle");
    take(samplerEl, preset.sampler_name, "échantillonneur");
    take(schedulerEl, preset.scheduler, "planificateur");
    if (preset.include_prompt) promptEl.value = preset.prompt || "";
    negativeEl.value = preset.negative_prompt || "";
    $("forge-width").value = String(preset.width);
    $("forge-height").value = String(preset.height);
    $("forge-steps").value = String(preset.steps);
    $("forge-cfg").value = String(preset.cfg_scale);
    applySeed(preset.seed);
    $("forge-iter").value = String(preset.n_iter);
    applyHires(preset);
    if (preset.enable_hr) take($("forge-hr-upscaler"), preset.hr_upscaler, "agrandisseur");
    describeChoices(false);
    syncActions();
    loadedPreset = preset;
    cleanSnapshot = snapshotOf(currentSettings(preset.kind));
    presetState.dataset.partial = missing.length ? "Introuvable : " + missing.join(", ") + "." : "";
    presetList.value = preset.id;
    refreshPresetState();
  }

  function syncPresetPrivacy() {
    const creative = editorMode === "create" && presetKind() === "creative";
    $("forge-preset-privacy").hidden = !creative;
    $("forge-preset-privacy-vault").hidden = !creative || destination() !== "private";
    const ack = $("forge-preset-privacy-ack");
    if (!creative) ack.checked = false;
    $("forge-preset-confirm").disabled = creative && !ack.checked;
  }

  function openPresetEditor(mode) {
    editorMode = mode;
    const current = mode === "rename" ? selectedPreset() : null;
    $("forge-preset-name").value = current ? current.name : "";
    const kind = current && current.kind === "creative" ? "creative" : "technical";
    document.querySelector('input[name="forge-preset-kind"][value="' + kind + '"]').checked = true;
    document.querySelectorAll('input[name="forge-preset-kind"]').forEach((input) => { input.disabled = mode === "rename"; });
    $("forge-preset-privacy-ack").checked = false;
    presetEditor.hidden = false;
    syncPresetPrivacy();
    $("forge-preset-name").focus();
  }

  async function commitPresetUpdate() {
    await postPreset(Object.assign({ action: "update", id: loadedPreset.id }, currentSettings(loadedPreset.kind)));
    const fresh = presets.find((item) => item.id === loadedPreset.id);
    if (fresh) applyPreset(fresh);
  }

  async function postPreset(body) {
    const data = await api("/api/forge/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    presets = data.presets || [];
    renderPresetList();
    return data;
  }

  if (presetList) {
    [checkpointEl, samplerEl, schedulerEl].forEach((select) => {
      select.addEventListener("change", () => {
        describeChoices(false);
        syncActions();
        refreshPresetState();
      });
    });
    [promptEl, negativeEl, $("forge-width"), $("forge-height"), $("forge-steps"), $("forge-cfg"), $("forge-seed"), $("forge-iter"), $("forge-hr"), $("forge-hr-scale"), $("forge-hr-upscaler"), $("forge-hr-steps"), $("forge-hr-denoise")].forEach((field) => {
      field.addEventListener("input", () => { syncRanges(); syncHiresNote(); if (progressBox.hidden) syncActions(false); refreshPresetState(); });
      field.addEventListener("change", () => { syncRanges(); syncHiresNote(); if (progressBox.hidden) syncActions(false); refreshPresetState(); });
    });
    document.querySelectorAll('input[name="forge-seed-mode"]').forEach((input) => {
      input.addEventListener("change", () => { syncSeedMode(); syncActions(); refreshPresetState(); });
    });
    document.querySelectorAll(".forge-ratio").forEach((button) => {
      button.addEventListener("click", () => {
        $("forge-width").value = button.dataset.width;
        $("forge-height").value = button.dataset.height;
        syncRanges();
        syncHiresNote();
        if (progressBox.hidden) syncActions(false);
        refreshPresetState();
      });
    });
    const bindPair = (rangeId, numberId) => {
      $(rangeId).addEventListener("input", () => {
        $(numberId).value = $(rangeId).value;
        $(numberId).dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    bindPair("forge-steps-range", "forge-steps");
    bindPair("forge-cfg-range", "forge-cfg");
    bindPair("forge-hr-denoise-range", "forge-hr-denoise");
    $("forge-seed-reuse").addEventListener("click", async () => {
      const note = $("forge-seed-note");
      try {
        const payload = await api("/api/forge/jobs");
        const found = (payload.jobs || []).find((job) => job.destination !== "private" && Number.isInteger(job.seed_used) && job.seed_used >= 0);
        if (!found) {
          note.textContent = "Aucune graine de la galerie normale à réutiliser.";
          return;
        }
        applySeed(found.seed_used);
        note.textContent = "Graine reprise : " + found.seed_used + ".";
        $("forge-seed-fold").open = true;
        $("forge-seed").focus();
        refreshPresetState();
      } catch (_) {
        note.textContent = "La liste des travaux n'a pas répondu.";
      }
    });
    presetList.addEventListener("change", refreshPresetState);
    $("forge-preset-load").addEventListener("click", () => {
      const item = selectedPreset();
      if (item) applyPreset(item);
    });
    $("forge-preset-save").addEventListener("click", () => openPresetEditor("create"));
    $("forge-preset-rename").addEventListener("click", () => { if (selectedPreset()) openPresetEditor("rename"); });
    $("forge-preset-cancel").addEventListener("click", () => { presetEditor.hidden = true; });
    document.querySelectorAll('input[name="forge-preset-kind"]').forEach((input) => {
      input.addEventListener("change", () => {
        $("forge-preset-privacy-ack").checked = false;
        syncPresetPrivacy();
      });
    });
    $("forge-preset-privacy-ack").addEventListener("change", syncPresetPrivacy);
    presetEditor.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (editorMode === "create" && presetKind() === "creative" && !$("forge-preset-privacy-ack").checked) {
        syncPresetPrivacy();
        return;
      }
      const name = $("forge-preset-name").value.trim();
      try {
        if (editorMode === "rename") {
          await postPreset({ action: "rename", id: selectedPreset().id, name: name });
          if (loadedPreset && loadedPreset.id === presetList.value) loadedPreset.name = name;
        } else {
          await postPreset(Object.assign({ action: "create", name: name }, currentSettings(presetKind())));
          const created = presets.find((item) => item.name === name);
          if (created) applyPreset(created);
        }
        presetEditor.hidden = true;
        refreshPresetState();
      } catch (error) {
        presetState.textContent = error.message || "Le préréglage n'a pas été enregistré.";
      }
    });
    $("forge-preset-update").addEventListener("click", async () => {
      if (!loadedPreset) return;
      if (loadedPreset.kind === "creative") {
        $("forge-preset-update-gate").hidden = false;
        $("forge-preset-update-vault").hidden = destination() !== "private";
        $("forge-preset-update-ack").checked = false;
        $("forge-preset-update-confirm").disabled = true;
        return;
      }
      try {
        await commitPresetUpdate();
      } catch (error) {
        presetState.textContent = error.message || "La mise à jour a échoué.";
      }
    });
    $("forge-preset-update-ack").addEventListener("change", () => {
      $("forge-preset-update-confirm").disabled = !$("forge-preset-update-ack").checked;
    });
    $("forge-preset-update-cancel").addEventListener("click", () => { $("forge-preset-update-gate").hidden = true; });
    $("forge-preset-update-confirm").addEventListener("click", async () => {
      if (!loadedPreset || loadedPreset.kind !== "creative" || !$("forge-preset-update-ack").checked) return;
      try {
        await commitPresetUpdate();
        $("forge-preset-update-gate").hidden = true;
      } catch (error) {
        presetState.textContent = error.message || "La mise à jour a échoué.";
      }
    });
    $("forge-preset-duplicate").addEventListener("click", async () => {
      const item = selectedPreset();
      if (!item) return;
      try {
        await postPreset({ action: "duplicate", id: item.id });
        refreshPresetState();
      } catch (error) {
        presetState.textContent = error.message || "La copie a échoué.";
      }
    });
    $("forge-preset-delete").addEventListener("click", async () => {
      const item = selectedPreset();
      if (!item || !window.confirm("Supprimer le préréglage « " + item.name + " » ?")) return;
      try {
        await postPreset({ action: "delete", id: item.id });
        if (loadedPreset && loadedPreset.id === item.id) loadedPreset = null;
        presetState.dataset.partial = "";
        presetState.textContent = "Préréglage supprimé.";
        refreshPresetState();
      } catch (error) {
        presetState.textContent = error.message || "La suppression a échoué.";
      }
    });
    $("forge-preset-export").addEventListener("click", () => {
      $("forge-preset-export-gate").hidden = false;
      $("forge-preset-export-vault").hidden = destination() !== "private";
    });
    $("forge-preset-export-cancel").addEventListener("click", () => { $("forge-preset-export-gate").hidden = true; });
    $("forge-preset-export-confirm").addEventListener("click", async () => {
      if ($("forge-preset-export-gate").hidden) return;
      const data = await api("/api/forge/presets");
      const blob = new Blob([JSON.stringify({ version: data.version, presets: data.presets }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "forge-presets.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      $("forge-preset-export-gate").hidden = true;
    });
    document.querySelectorAll('input[name="forge-destination"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (!$("forge-preset-privacy").hidden) $("forge-preset-privacy-ack").checked = false;
        if (!$("forge-preset-update-gate").hidden) {
          $("forge-preset-update-ack").checked = false;
          $("forge-preset-update-confirm").disabled = true;
        }
        syncPresetPrivacy();
        $("forge-preset-privacy-vault").hidden = destination() !== "private" || $("forge-preset-privacy").hidden;
        $("forge-preset-export-vault").hidden = destination() !== "private";
        $("forge-preset-update-vault").hidden = destination() !== "private";
      });
    });
    $("forge-preset-import").addEventListener("change", async () => {
      const file = $("forge-preset-import").files && $("forge-preset-import").files[0];
      $("forge-preset-import").value = "";
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        await postPreset({ action: "import", version: parsed.version, presets: parsed.presets });
        presetState.textContent = "Import terminé.";
      } catch (error) {
        presetState.textContent = error.message || "L'import a été refusé.";
      }
    });
    document.querySelectorAll("#forge-studio .forge-help").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const wrap = button.closest(".forge-help-wrap");
        const open = wrap.classList.contains("is-open");
        document.querySelectorAll("#forge-studio .forge-help-wrap.is-open").forEach((item) => {
          item.classList.remove("is-open");
          const control = item.querySelector(".forge-help");
          if (control) control.setAttribute("aria-expanded", "false");
        });
        if (!open) {
          wrap.classList.add("is-open");
          button.setAttribute("aria-expanded", "true");
        }
      });
    });
    refreshPresetState();
  }


  /* ---- Prompt reuse and history (t85u) ----
     History is the HQ gallery itself (normal destination only), read through the
     existing authenticated routes. Nothing about prompts is written to
     localStorage or sessionStorage; the cache below lives in memory and is
     dropped when Forge Studio is hidden. Private prompts never enter it. */
  const lastBtn = $("forge-last-prompt");
  const historyBtn = $("forge-history-open");
  const historyDlg = $("forge-history");
  const historyList = $("forge-history-list");
  const historySearch = $("forge-history-search");
  const historyState = $("forge-history-state");
  const historyMore = $("forge-history-more");
  const historyNote = $("forge-history-note");
  const restoreBox = $("forge-restore-confirm");
  const countEl = $("forge-prompt-count");
  const PRIVATE_HISTORY = "Dernier prompt et Historique sont désactivés en génération privée : les prompts du coffre ne sont jamais listés ni gardés hors du coffre.";
  let historyItems = [];
  let historyCursor = null;
  let historyLoaded = false;
  let historyFrom = null;
  let pendingRestore = null;
  let lastApplied = { prompt: "", negative: "" };
  let lastSubmitted = null;

  function syncCount() {
    if (countEl) countEl.textContent = promptEl.value.length + " / " + (promptEl.maxLength > 0 ? promptEl.maxLength : 2000);
  }

  function pickOption(select, value) {
    if (value == null || value === "") return true;
    const text = String(value);
    if (![...select.options].some((item) => item.value === text)) return false;
    select.value = text;
    return true;
  }

  function clampInto(id, value) {
    const el = $(id);
    const number = Number(value);
    if (!el || value == null || value === "" || !Number.isFinite(number)) return;
    const min = el.min === "" ? -Infinity : Number(el.min);
    const max = el.max === "" ? Infinity : Number(el.max);
    el.value = String(Math.min(max, Math.max(min, number)));
  }

  function settled() {
    syncRanges();
    syncHiresNote();
    describeChoices(false);
    if (progressBox.hidden) syncActions(false);
    refreshPresetState();
    syncCount();
  }

  /* Technical settings only; the prompt text is left alone. Returns what this
     HQ cannot offer any more, so the caller can say so instead of guessing. */
  function applyParameters(settings) {
    const missing = [];
    if (settings.checkpoint && !pickOption(checkpointEl, settings.checkpoint)) missing.push("modèle « " + settings.checkpoint + " »");
    if (settings.sampler_name && !pickOption(samplerEl, settings.sampler_name)) missing.push("échantillonneur « " + settings.sampler_name + " »");
    if (settings.scheduler && !pickOption(schedulerEl, settings.scheduler)) missing.push("planificateur « " + settings.scheduler + " »");
    clampInto("forge-width", settings.width);
    clampInto("forge-height", settings.height);
    clampInto("forge-steps", settings.steps);
    clampInto("forge-cfg", settings.cfg_scale);
    if (settings.seed != null) applySeed(settings.seed);
    if (settings.n_iter) pickOption($("forge-iter"), String(settings.n_iter));
    applyHires(settings);
    if (settings.enable_hr && settings.hr_upscaler && !pickOption($("forge-hr-upscaler"), settings.hr_upscaler)) missing.push("agrandisseur « " + settings.hr_upscaler + " »");
    settled();
    return missing;
  }

  function applyPromptText(settings) {
    promptEl.value = settings.prompt || "";
    negativeEl.value = settings.negative_prompt || "";
    if (negativeEl.value) $("forge-negative-fold").open = true;
    lastApplied = { prompt: promptEl.value, negative: negativeEl.value };
    settled();
  }

  function unsaved(next) {
    const prompt = promptEl.value;
    const negative = negativeEl.value;
    if (!prompt.trim() && !negative.trim()) return false;
    if (prompt === (next.prompt || "") && negative === (next.negative_prompt || "")) return false;
    return prompt !== lastApplied.prompt || negative !== lastApplied.negative;
  }

  function say(text) {
    if (historyNote) historyNote.textContent = text;
  }

  function finishRestore(settings, mode, label) {
    let missing = [];
    if (mode !== "params") applyPromptText(settings);
    if (mode !== "prompt") missing = applyParameters(settings);
    const what = mode === "params" ? "Paramètres repris" : mode === "prompt" ? "Prompt repris" : "Prompt et paramètres repris";
    say(what + (label ? " (" + label + ")" : "") + ". Rien n'est lancé : appuyez sur Générer quand vous êtes prêt." + (missing.length ? " Indisponible ici, réglage actuel gardé : " + missing.join(", ") + "." : ""));
    promptEl.focus();
    try { promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length); } catch (_) { /* not a text field */ }
  }

  function requestRestore(settings, mode, label) {
    if (!settings) return;
    pendingRestore = null;
    restoreBox.hidden = true;
    if (mode !== "params" && unsaved(settings)) {
      pendingRestore = { settings: settings, mode: mode, label: label };
      restoreBox.hidden = false;
      $("forge-restore-replace").focus();
      return;
    }
    finishRestore(settings, mode, label);
  }

  $("forge-restore-replace").addEventListener("click", () => {
    const next = pendingRestore;
    pendingRestore = null;
    restoreBox.hidden = true;
    if (next) finishRestore(next.settings, next.mode, next.label);
  });
  $("forge-restore-keep").addEventListener("click", () => {
    pendingRestore = null;
    restoreBox.hidden = true;
    say("Votre texte est gardé.");
    promptEl.focus();
  });

  let historyTotal = 0;
  let historyQuery = "";
  let historyTicket = 0;

  /* One authenticated listing call per page. The server searches every retained
     gallery image (view=history&q=…) so a match on an old page is still found. */
  async function loadHistory(reset) {
    const ticket = ++historyTicket;
    const query = historySearch ? historySearch.value.trim().slice(0, 200) : "";
    if (reset) {
      historyItems = [];
      historyCursor = null;
    }
    const page = await api("/api/forge/gallery?view=history&limit=24" + (query ? "&q=" + encodeURIComponent(query) : "") + (historyCursor ? "&cursor=" + encodeURIComponent(historyCursor) : ""));
    if (ticket !== historyTicket) return false;
    const seen = new Set(historyItems.map((item) => (item.settings.prompt || "") + "\u0000" + (item.settings.negative_prompt || "")));
    (page.entries || []).forEach((entry) => {
      const settings = entry.settings || {};
      if (!settings.prompt) return;
      const signature = settings.prompt + "\u0000" + (settings.negative_prompt || "");
      if (seen.has(signature)) return;
      seen.add(signature);
      historyItems.push({ id: entry.id, created: entry.created, thumb: entry.thumb, settings: settings });
    });
    historyCursor = page.next_cursor || null;
    historyTotal = Number(page.total) || 0;
    historyQuery = query;
    historyLoaded = true;
    return true;
  }

  function when(stamp) {
    const date = new Date(stamp || "");
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("fr-CA", { dateStyle: "medium", timeStyle: "short" });
  }

  function renderHistory() {
    const query = historyQuery;
    const shown = historyItems;
    historyList.replaceChildren();
    shown.forEach((item) => {
      const s = item.settings;
      const li = document.createElement("li");
      li.className = "forge-history-item";
      const img = document.createElement("img");
      img.src = item.thumb;
      img.alt = "";
      img.loading = "lazy";
      const body = document.createElement("div");
      const text = document.createElement("p");
      text.className = "forge-history-text";
      text.textContent = s.prompt;
      const meta = document.createElement("p");
      meta.className = "forge-history-meta";
      meta.textContent = [when(item.created), s.checkpoint ? String(s.checkpoint).replace(/\s*\[[^\]]*\]$/, "") : "", s.width && s.height ? s.width + "×" + s.height : "", s.steps ? s.steps + " pas" : "", s.negative_prompt ? "avec négatif" : ""].filter(Boolean).join(" · ");
      body.append(text, meta);
      const actions = document.createElement("div");
      actions.className = "forge-actions";
      const usePrompt = document.createElement("button");
      usePrompt.type = "button";
      usePrompt.textContent = "Réutiliser le prompt";
      usePrompt.setAttribute("aria-label", "Réutiliser le prompt : " + String(s.prompt).slice(0, 80));
      usePrompt.addEventListener("click", () => { closeHistory(false); requestRestore(s, "prompt", "historique"); });
      const useParams = document.createElement("button");
      useParams.type = "button";
      useParams.className = "secondary";
      useParams.textContent = "Réutiliser les paramètres";
      useParams.setAttribute("aria-label", "Réutiliser les paramètres de : " + String(s.prompt).slice(0, 80));
      useParams.addEventListener("click", () => { closeHistory(false); requestRestore(s, "params", "historique"); });
      actions.append(usePrompt, useParams);
      li.append(img, body, actions);
      historyList.appendChild(li);
    });
    historyMore.hidden = !historyCursor;
    if (!shown.length) historyState.textContent = query ? "Aucun prompt ne contient « " + query + " »." : "Aucun prompt dans la galerie HQ pour l'instant.";
    else historyState.textContent = (query ? historyTotal + (historyTotal > 1 ? " images correspondent" : " image correspond") + " dans toute la galerie." : shown.length + (shown.length > 1 ? " prompts" : " prompt") + ", du plus récent au plus ancien.") + (historyCursor ? " Plus d'entrées disponibles." : "");
  }

  function historyNodes() {
    return [...historyDlg.querySelectorAll("button, input, a")].filter((node) => !node.disabled && node.offsetParent !== null);
  }

  async function openHistory(trigger) {
    if (destination() === "private") {
      say(PRIVATE_HISTORY);
      return;
    }
    // Safari does not focus a clicked button, so remember the trigger itself.
    historyFrom = trigger || document.activeElement;
    historyDlg.showModal();
    historySearch.focus();
    if (historyLoaded && historyQuery === historySearch.value.trim().slice(0, 200)) {
      renderHistory();
      return;
    }
    historyState.textContent = "Chargement de l'historique…";
    try {
      await loadHistory(true);
      renderHistory();
    } catch (error) {
      historyList.replaceChildren();
      historyMore.hidden = true;
      historyState.textContent = error.message || "L'historique n'a pas répondu.";
    }
  }

  function closeHistory(refocus) {
    if (historyDlg.open) historyDlg.close();
    if (refocus !== false && historyFrom && historyFrom.focus) historyFrom.focus();
    historyFrom = null;
  }

  historyBtn.addEventListener("click", () => { openHistory(historyBtn); });
  $("forge-history-close").addEventListener("click", () => closeHistory());
  historyDlg.addEventListener("cancel", (event) => { event.preventDefault(); closeHistory(); });
  historyDlg.addEventListener("click", (event) => { if (event.target === historyDlg) closeHistory(); });
  historyDlg.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const nodes = historyNodes();
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
  let searchTimer = 0;
  historySearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      historyState.textContent = "Recherche…";
      try {
        if (await loadHistory(true)) renderHistory();
      } catch (error) {
        historyList.replaceChildren();
        historyMore.hidden = true;
        historyState.textContent = error.message || "La recherche n'a pas répondu.";
      }
    }, 250);
  });
  historyMore.addEventListener("click", async () => {
    try {
      await loadHistory(false);
      renderHistory();
    } catch (error) {
      historyState.textContent = error.message || "La suite n'a pas répondu.";
    }
  });

  lastBtn.addEventListener("click", async () => {
    if (destination() === "private") {
      say(PRIVATE_HISTORY);
      return;
    }
    if (lastSubmitted) {
      requestRestore(lastSubmitted, "prompt", "dernier envoi");
      return;
    }
    try {
      // HQ's own job records: every accepted submission, including failed,
      // cancelled or imageless ones. Private jobs come back without settings
      // and are skipped here as well.
      const payload = await api("/api/forge/jobs");
      const job = (payload.jobs || []).find((item) => item.destination === "normal" && item.settings && typeof item.settings.prompt === "string" && item.settings.prompt);
      if (job) {
        requestRestore(job.settings, "prompt", "dernier envoi");
        return;
      }
      if (!historyLoaded || historyQuery) {
        if (historySearch) historySearch.value = "";
        await loadHistory(true);
      }
      const newest = historyItems[0];
      if (!newest) {
        say("Aucun prompt précédent.");
        return;
      }
      requestRestore(newest.settings, "prompt", "dernière image de la galerie");
    } catch (error) {
      say(error.message || "HQ n'a pas répondu.");
    }
  });

  function syncHistoryAvailability() {
    const privateMode = destination() === "private";
    lastBtn.disabled = privateMode;
    historyBtn.disabled = privateMode;
    lastBtn.title = privateMode ? PRIVATE_HISTORY : "";
    historyBtn.title = privateMode ? PRIVATE_HISTORY : "";
    if (privateMode) {
      if (historyDlg.open) closeHistory(false);
      say(PRIVATE_HISTORY);
    } else if (historyNote && historyNote.textContent === PRIVATE_HISTORY) {
      say("");
    }
  }

  document.querySelectorAll('input[name="forge-destination"]').forEach((input) => {
    input.addEventListener("change", syncHistoryAvailability);
  });
  form.addEventListener("submit", () => {
    if (destination() === "private" || submitGuard || generateBtn.disabled) return;
    const snapshot = settingsFromForm();
    lastSubmitted = snapshot;
    lastApplied = { prompt: snapshot.prompt, negative: snapshot.negative_prompt };
    justSubmitted = true;
  }, true);
  promptEl.addEventListener("input", syncCount);

  /* Layout preference: a presentation choice only, so it may live in localStorage. */
  const layoutEl = $("forge-layout");
  function applyLayout(value) {
    const chosen = ["auto", "compact", "expanded"].includes(value) ? value : "auto";
    studio.dataset.layout = chosen;
    layoutEl.value = chosen;
  }
  try { applyLayout(localStorage.getItem("hqForgeLayout")); } catch (_) { applyLayout("auto"); }
  layoutEl.addEventListener("change", () => {
    applyLayout(layoutEl.value);
    try { localStorage.setItem("hqForgeLayout", studio.dataset.layout); } catch (_) { /* storage off */ }
  });

  /* On-screen keyboard: let the action bar scroll with the page so it never
     sits on top of the field being typed in. */
  if (window.visualViewport) {
    const viewport = window.visualViewport;
    const syncKeyboard = () => {
      const active = document.activeElement;
      const typing = active && /^(TEXTAREA|INPUT|SELECT)$/.test(active.tagName) && studio.contains(active);
      studio.classList.toggle("forge-kb", !!typing && window.innerHeight - viewport.height > 140);
    };
    viewport.addEventListener("resize", syncKeyboard);
    studio.addEventListener("focusout", () => setTimeout(syncKeyboard, 50));
  }

  const presetFold = $("forge-presets");
  if (presetFold && window.matchMedia && window.matchMedia("(max-width: 599px)").matches) presetFold.open = false;
  const presetHint = $("forge-preset-current");
  if (presetHint && presetList) {
    const syncHint = () => {
      const chosen = presetList.selectedOptions && presetList.selectedOptions[0];
      presetHint.textContent = chosen && chosen.value ? chosen.textContent : "";
    };
    presetList.addEventListener("change", syncHint);
    new MutationObserver(syncHint).observe(presetList, { childList: true });
  }

  const actionbar = $("forge-actionbar");
  if (actionbar && window.ResizeObserver) {
    new ResizeObserver(() => {
      document.documentElement.style.setProperty("--forge-bar-h", Math.ceil(actionbar.getBoundingClientRect().height) + "px");
    }).observe(actionbar);
  }

  /* Capturer: the floating HQ launcher is hidden in Forge Studio (CSS), so this
     header button calls the very same capture open() through window.hqCapture.
     Wired once here; view switches add no listener. The capture module boots
     asynchronously (admins only), so the button appears once its launcher exists. */
  const captureBtn = $("forge-capture");
  if (captureBtn) {
    const linkCapture = () => {
      const fab = document.getElementById("hq-capture-fab");
      if (!fab || !window.hqCapture || typeof window.hqCapture.open !== "function") return false;
      captureBtn.hidden = false;
      const mirror = () => captureBtn.setAttribute("aria-expanded", fab.getAttribute("aria-expanded") === "true" ? "true" : "false");
      mirror();
      if (window.MutationObserver) new MutationObserver(mirror).observe(fab, { attributes: true, attributeFilter: ["aria-expanded"] });
      return true;
    };
    captureBtn.addEventListener("click", () => {
      if (!window.hqCapture || typeof window.hqCapture.open !== "function") return;
      // Safari does not focus a clicked button; focus it so closing the sheet returns here, not to the hidden launcher.
      if (document.activeElement !== captureBtn) captureBtn.focus({ preventScroll: true });
      window.hqCapture.open();
    });
    if (!linkCapture()) {
      // hqCapture is set just after its launcher is appended to <body>: poll briefly, then give up (non-admins never get it).
      let tries = 0;
      const timer = setInterval(() => {
        if (linkCapture() || ++tries > 120) clearInterval(timer);
      }, 250);
    }
  }

  syncCount();
  syncHistoryAvailability();

  syncSeedMode();
  syncRanges();

  window.hqForgeShow = function () {
    refreshStatus().then(() => refreshVault()).then(() => Promise.all([resume(), loadGallery(true), loadPresetList()])).catch(() => {});
  };
  window.hqForgeHide = function () {
    if (historyDlg && historyDlg.open) historyDlg.close();
    historyItems = [];
    historyLoaded = false;
    clearTimeout(pollTimer);
    clearTimeout(idleTimer);
    if (viewer.open) viewer.close();
    clearPrivateUi();
  };
})();
