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
  let resultIntent = false; // the user typed, changed a setting, focused a field or scrolled since the last submit
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

  // The "no longer offered" note stays until the choice changes; a later refresh
  // with nothing new to say keeps it instead of wiping it.
  let staleSignature = "";
  function describeChoices(stale, fromRefresh) {
    if (!choiceNote) return;
    const signature = [checkpointEl.value, samplerEl.value, schedulerEl.value].join("\n");
    if (stale) staleSignature = signature;
    else if (!fromRefresh || signature !== staleSignature) staleSignature = "";
    stale = stale || (!!staleSignature && signature === staleSignature);
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
    // B: a busy Forge (someone else's work) does not block a normal job; HQ waits politely.
    const forgeOk = forgeState === "ready" || (forgeState === "busy" && !privateMode);
    const ready = !active && !hiresPrivate && !hiresMissing && !hiresLarge && forgeOk && catalogState === "ready" && checkpointEl.value && samplerEl.value && schedulerEl.value;
    generateBtn.disabled = !ready;
    privateBtn.disabled = !ready || !vaultState.private_generation;
    if (reasonEl) {
      if (active) reasonEl.textContent = "Générer est désactivé : une génération est déjà en cours.";
      else if (forgeState === "offline") reasonEl.textContent = "Générer est désactivé : Forge n'est pas démarré.";
      else if (forgeState === "api_disabled") reasonEl.textContent = "Générer est désactivé : l'API Forge n'est pas activée.";
      else if (forgeState === "busy" && privateMode) reasonEl.textContent = "G\u00e9n\u00e9rer est d\u00e9sactiv\u00e9 : Forge est occup\u00e9 par un autre travail.";
      else if (forgeUnreachable) reasonEl.textContent = "Générer est désactivé : Forge n'a pas répondu.";
      else if (!forgeOk || catalogState !== "ready") reasonEl.textContent = "Générer est désactivé : le catalogue n'est pas disponible.";
      else if (!checkpointEl.value) reasonEl.textContent = "Générer est désactivé : aucun modèle n'est choisi.";
      else if (!samplerEl.value) reasonEl.textContent = "Générer est désactivé : aucun échantillonneur n'est choisi.";
      else if (!schedulerEl.value) reasonEl.textContent = "Générer est désactivé : aucun planificateur n'est choisi.";
      else if (hiresPrivate) reasonEl.textContent = "Générer est désactivé : Hires. fix n'est pas disponible en génération privée.";
      else if (hiresMissing) reasonEl.textContent = "Générer est désactivé : l'agrandisseur n'est pas disponible.";
      else if (hiresLarge) reasonEl.textContent = "Générer est désactivé : le second passage dépasserait 2048 pixels.";
      else if (forgeState === "busy") reasonEl.textContent = "Forge est occup\u00e9 : HQ attendra la fin de son travail.";
      else reasonEl.textContent = "";
    }
    $("forge-normal-results").hidden = privateMode;
    $("forge-normal-gallery").hidden = privateMode;
    studio.classList.toggle("forge-private", privateMode);
    if (fleetBooted) fleetSync(active);
  }

  let forgeUnreachable = false;

  // Concurrent callers (e.g. the two chains in hqForgeShow) share one in-flight refresh,
  // so opening the studio reads status and catalog once and nothing overwrites the result.
  let statusInFlight = null;
  function refreshStatus() {
    if (!statusInFlight) {
      statusInFlight = readStatus().finally(() => { statusInFlight = null; });
    }
    return statusInFlight;
  }

  async function readStatus() {
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
        describeChoices(staleModel || staleSampler || stalePlan, true);
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
    if (image.triage && image.triage !== "none") {
      button.dataset.triage = image.triage;
      const badge = document.createElement("span");
      badge.className = "forge-card-badge";
      badge.textContent = { keep: "Gard\u00e9e", favorite: "Favori", reject: "Rejet\u00e9e" }[image.triage] || "";
      button.appendChild(badge);
    }
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
    if (window.hqForgeDropPrivateShare) window.hqForgeDropPrivateShare();
    if (window.hqForgeNextLock) window.hqForgeNextLock();
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

  /* F4: Forge's own estimate, already sanitized by HQ (finite, 0 < s <= 3600). */
  function etaCopy(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) return "";
    if (seconds < 90) return "\u2248 " + Math.max(1, Math.round(seconds)) + " s restantes";
    return "\u2248 " + Math.round(seconds / 60) + " min restantes";
  }

  let usualTimer = 0;
  let usualAsked = "";
  function usualCopy(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    return "Dur\u00e9e habituelle : ~" + (seconds < 90 ? Math.round(seconds) + " s" : Math.round(seconds / 60) + " min");
  }
  async function refreshUsual() {
    const note = $("forge-usual-duration");
    if (!note) return;
    const query = "width=" + Number($("forge-width").value) + "&height=" + Number($("forge-height").value) +
      "&steps=" + Number($("forge-steps").value) + "&hires=" + ($("forge-hr").checked ? "1" : "0") + "&n_iter=" + Number($("forge-iter").value || 1);
    usualAsked = query;
    try {
      const payload = await api("/api/forge/jobs/durations?" + query);
      if (usualAsked !== query) return;
      const text = payload && payload.samples >= 3 ? usualCopy(Number(payload.seconds)) : "";
      note.textContent = text;
      note.hidden = !text;
    } catch (_) {
      note.hidden = true;
    }
  }
  function queueUsual() {
    clearTimeout(usualTimer);
    usualTimer = setTimeout(() => { refreshUsual().catch(() => {}); }, 400);
  }
  window.hqForgeQueueUsual = queueUsual;

  /* F5: opt-in screen wake lock while a job or a batch runs. A presentation
     preference, so it may live in localStorage. Unsupported browsers hide it. */
  const WAKE_KEY = "hqForgeWakeLock";
  const wakeSupported = !!(navigator.wakeLock && typeof navigator.wakeLock.request === "function");
  let wakeSentinel = null;
  let wakeJob = false;
  let wakeBatch = false;
  function wakePref() {
    try { return localStorage.getItem(WAKE_KEY) === "1"; } catch (_) { return false; }
  }
  async function syncWake() {
    const want = wakeSupported && wakePref() && (wakeJob || wakeBatch) && document.visibilityState === "visible";
    if (want && !wakeSentinel) {
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        wakeSentinel = sentinel;
        sentinel.addEventListener("release", () => { if (wakeSentinel === sentinel) wakeSentinel = null; });
        if (!(wakeSupported && wakePref() && (wakeJob || wakeBatch))) syncWake();
      } catch (_) { wakeSentinel = null; /* refused or unsupported: stay quiet */ }
    } else if (!want && wakeSentinel) {
      const sentinel = wakeSentinel;
      wakeSentinel = null;
      try { await sentinel.release(); } catch (_) { /* already gone */ }
    }
  }
  function setWake(kind, on) {
    if (kind === "job") wakeJob = !!on; else wakeBatch = !!on;
    syncWake();
  }

  function showJob(job) {
    const active = job && ["queued", "starting", "generating", "saving"].includes(job.state);
    setWake("job", active);
    cancelBtn.disabled = !active || job.cancel === "deferred";
    $("forge-wait").hidden = !(job && job.waiting);
    $("forge-start-now").disabled = false;
    progressBox.hidden = !active && !(job && job.state === "unknown");
    if (job) {
      progressBar.value = Number(job.progress || 0);
      const eta = active ? etaCopy(job.eta) : "";
      progressLabel.textContent = (job.message || job.state || "") + (eta ? " \u00b7 " + eta : "");
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
        queueUsual();
        if (justSubmitted && window.matchMedia && window.matchMedia("(max-width: 899px)").matches) {
          // The user moved on while it rendered: do not yank the page, offer the jump instead.
          if (resultIntent) showSeeResult();
          else scrollToResult();
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

  // C: the variation the user chose to continue from (seed stays fixed, subseed + strength kept).
  let variationPick = null;

  function syncVariationChip() {
    const chip = $("forge-variation-chip");
    if (!chip) return;
    chip.hidden = !variationPick;
    if (variationPick) {
      $("forge-variation-text").textContent = "Variation " + String(variationPick.strength).replace(".", ",") + " \u00b7 graine de variation " + variationPick.subseed + ".";
    }
  }

  function settingsFromForm() {
    const seed = forgeSeed();
    const out = formSettings(seed);
    if (variationPick && seed >= 0) {
      out.subseed = variationPick.subseed;
      out.subseed_strength = variationPick.strength;
    }
    return out;
  }

  function formSettings(seed) {
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
        body: JSON.stringify(Object.assign(settingsFromForm(), { wait_if_busy: true }))
      });
      if (window.hqForgeWipeDraft) window.hqForgeWipeDraft();
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
      if (window.hqForgeWipeDraft) window.hqForgeWipeDraft();
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

  $("forge-start-now").addEventListener("click", async () => {
    const jobId = sessionStorage.getItem("hqForgeJob");
    if (!jobId) return;
    $("forge-start-now").disabled = true;
    try {
      const payload = await api("/api/forge/jobs/" + jobId + "/start-now", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      showJob(payload.job);
    } catch (error) {
      progressLabel.textContent = error.message || "Envoi impossible.";
      $("forge-start-now").disabled = false;
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
    shareFiles.normal = null;
    if (viewer.open) viewer.close();
    if (openFrom) openFrom.focus();
    openFrom = null;
  }

  /* F14: "Enregistrer dans Photos" through the Web Share API (iOS share sheet).
     The image is fetched while the viewer opens so the tap can call share()
     directly; the bytes stay in memory (a File object) and are dropped on close. */
  function shareProbe() {
    try {
      return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File([new Blob([""], { type: "image/png" })], "image.png", { type: "image/png" })] }));
    } catch (_) { return false; }
  }
  const shareFiles = { normal: null, private: null };
  async function prepareShare(kind, source, name, button) {
    shareFiles[kind] = null;
    if (!button) return;
    button.hidden = true;
    if (!shareProbe()) return;
    try {
      let blob = source;
      if (typeof source === "string") {
        const response = await fetch(source, { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return;
        blob = await response.blob();
      }
      const file = new File([blob], name, { type: "image/png" });
      if (!navigator.canShare({ files: [file] })) return;
      shareFiles[kind] = file;
      button.hidden = false;
    } catch (_) { /* no share for this image */ }
  }
  async function shareNow(kind) {
    const file = shareFiles[kind];
    if (!file) return;
    if (kind === "private" && !window.confirm("Cette image quittera le coffre. Continuer ?")) return;
    try { await navigator.share({ files: [file] }); } catch (_) { /* cancelled or refused: nothing to report */ }
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
      settings.seed == null ? "" : (Number(settings.seed) >= 0 ? "Graine " + settings.seed : "Graine inconnue"),
      Number(settings.subseed_strength) > 0 ? "Variation " + String(settings.subseed_strength).replace(".", ",") + " \u00b7 graine de variation " + settings.subseed : ""
    ].filter(Boolean).join("\n");
    exploreReady("forge-viewer", settings);
    downloadLink.href = detail.original;
    if (window.hqForgeOnViewer) window.hqForgeOnViewer("normal", id, detail.triage || (from && from.dataset ? from.dataset.triage : ""));
    viewer.showModal();
    closeBtn.focus();
    prepareShare("normal", detail.original, "forge-" + id + ".png", $("forge-share"));
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
  window.hqForgeDropPrivateShare = () => {
    shareFiles.private = null;
    privateDetail = null;
    const button = $("forge-vault-share");
    if (button) button.hidden = true;
  };

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
    try {
      await api("/api/forge/vault/lock", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } finally {
      // Drop decrypted pixels and private text even if the lock request failed.
      clearPrivateUi();
      if (window.hqForgeScrubPrivate) window.hqForgeScrubPrivate();
    }
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
    const normal = document.querySelector('input[name="forge-destination"][value="normal"]');
    if (!normal.checked) {
      normal.checked = true;
      normal.dispatchEvent(new Event("change", { bubbles: true }));
    }
    refreshVault().catch(() => {});
    promptEl.focus();
  });
  $("forge-vault-lock").addEventListener("click", () => lockVault().catch((error) => { statusEl.textContent = error.message; }));

  /* F18: optional lock when the app stays in the background for 30 s. The
     server's own unlock TTL (5 min) remains the backstop. Pref: localStorage. */
  const AWAY_KEY = "hqForgeVaultAway";
  const AWAY_MS = 30 * 1000;
  let awayTimer = 0;
  let hiddenAt = 0;
  function awayPref() {
    try { return localStorage.getItem(AWAY_KEY) === "1"; } catch (_) { return false; }
  }
  const awayBox = $("forge-vault-away");
  if (awayBox) {
    awayBox.checked = awayPref();
    awayBox.addEventListener("change", () => {
      try { localStorage.setItem(AWAY_KEY, awayBox.checked ? "1" : "0"); } catch (_) { /* storage off */ }
    });
  }
  document.addEventListener("visibilitychange", () => {
    clearTimeout(awayTimer);
    awayTimer = 0;
    if (document.visibilityState !== "hidden") {
      // iOS freezes timers in the background: judge by wall-clock time on return.
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (away >= AWAY_MS && awayPref() && vaultState.unlocked) lockVault().catch(() => {});
      return;
    }
    hiddenAt = Date.now();
    if (!awayPref() || !vaultState.unlocked) return;
    awayTimer = setTimeout(() => {
      awayTimer = 0;
      if (document.visibilityState === "hidden" && vaultState.unlocked) lockVault().catch(() => {});
    }, AWAY_MS);
  });
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
    variationPick = Number(settings.subseed_strength) > 0 && Number(settings.seed) >= 0 && Number.isInteger(settings.subseed)
      ? { subseed: settings.subseed, strength: Number(settings.subseed_strength) } : null;
    syncVariationChip();
    if (settings.n_iter) $("forge-iter").value = String(settings.n_iter);
    applyHires(settings);
    const upscaler = $("forge-hr-upscaler");
    if (settings.enable_hr && settings.hr_upscaler && [...upscaler.options].some((item) => item.value === settings.hr_upscaler)) {
      upscaler.value = settings.hr_upscaler;
    }
    syncActions();
  }

  // Hooks for hq-forge-next.js (triage, lab, planner, journal). Same-origin calls only.
  window.hqForgeHooks = {
    api,
    applySettings,
    loadGallery: () => loadGallery(true),
    loadVault: () => loadVaultGallery(),
    vaultUnlocked: () => !!vaultState.unlocked,
    trackPrivateUrl: (url) => privateUrls.add(url),
    /* Laboratoire "Appliquer ces r\u00e9glages": technical fields only (never the prompt or the
       negative prompt). Returns what changed and what this HQ cannot apply, so nothing is silent. */
    applyTechnical: (s) => {
      const done = [];
      const missing = [];
      const pick = (select, value, label) => {
        if (!value) return;
        if ([...select.options].some((item) => item.value === value)) { select.value = value; done.push(label); } else missing.push(label + " \u00ab " + value + " \u00bb");
      };
      pick(checkpointEl, s.checkpoint, "mod\u00e8le");
      pick(samplerEl, s.sampler_name, "\u00e9chantillonneur");
      pick(schedulerEl, s.scheduler, "planificateur");
      if (s.width && s.height) { $("forge-width").value = s.width; $("forge-height").value = s.height; done.push("taille " + s.width + "\u00d7" + s.height); }
      if (s.steps) { $("forge-steps").value = s.steps; done.push(s.steps + " pas"); }
      if (s.cfg_scale) { $("forge-cfg").value = s.cfg_scale; done.push("CFG " + String(s.cfg_scale).replace(".", ",")); }
      syncRanges();
      syncActions();
      queueUsual();
      return { done, missing };
    },
    closeViewers: () => { if (viewer.open) closeViewer(); if (vaultViewer && vaultViewer.open) closePrivate(); },
  };

  // ---------------------------------------------------------------- C: Explorer autour
  const EXPLORE_KEYS = ["prompt", "negative_prompt", "checkpoint", "sampler_name", "scheduler", "width", "height", "steps", "cfg_scale", "seed"];
  const HIRES_KEYS = ["enable_hr", "hr_scale", "hr_upscaler", "hr_second_pass_steps", "denoising_strength"];

  function exploreReady(prefix, settings) {
    const button = $(prefix + "-explore");
    if (!button) return;
    const ok = Number(settings && settings.seed) >= 0;
    button.disabled = !ok;
    button.dataset.blocked = ok ? "" : "seed";
    const note = $(prefix + "-explore-note");
    if (note.dataset.base == null) note.dataset.base = note.textContent;
    note.textContent = ok ? note.dataset.base : "Graine inconnue : impossible d'explorer autour de cette image.";
  }

  function exploreLabel(input) {
    const value = Number(input.value);
    input.setAttribute("aria-valuetext", value <= 0.15 ? "proche" : (value >= 0.45 ? "loin" : "interm\u00e9diaire"));
  }

  function exploreKey() {
    return "ex" + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 38);
  }

  async function explore(prefix, settings, privateMode) {
    const button = $(prefix + "-explore");
    const note = $(prefix + "-explore-note");
    if (!settings || !(Number(settings.seed) >= 0) || button.disabled) return;
    const strength = Math.round(Number($(prefix + "-explore-range").value) * 100) / 100;
    const body = {};
    EXPLORE_KEYS.forEach((name) => { if (settings[name] != null) body[name] = settings[name]; });
    if (!privateMode && settings.enable_hr === true) HIRES_KEYS.forEach((name) => { if (settings[name] != null) body[name] = settings[name]; });
    body.batch_size = 1;
    body.subseed = -1;
    body.subseed_strength = strength;
    button.disabled = true;
    try {
      if (!privateMode && fleetMode()) {
        // Normal mode may fan out over the fleet: one image per task, same seed, subseed + index.
        const workers = devices.filter((device) => selected.has(device.id) && deviceVerdict(device).ok).map((device) => device.id);
        const payload = await api("/api/forge/batches", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": exploreKey() },
          body: JSON.stringify({ workers: workers, count: 6, settings: body, destination: "normal" })
        });
        closeViewer();
        results.replaceChildren();
        shownBatchImages.clear();
        showBatch(payload.batch);
      } else {
        body.n_iter = 6;
        body.destination = privateMode ? "private" : "normal";
        if (!privateMode) body.wait_if_busy = true;
        const payload = await api("/api/forge/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": exploreKey() },
          body: JSON.stringify(body)
        });
        if (privateMode) closePrivate(); else closeViewer();
        justSubmitted = true;
        progressBox.hidden = false;
        showJob(payload.job);
      }
    } catch (error) {
      note.textContent = error.message || "Les variations n'ont pas d\u00e9marr\u00e9.";
      button.disabled = false;
      return;
    }
    button.disabled = false;
  }

  ["forge-viewer", "forge-vault"].forEach((prefix) => {
    const input = $(prefix + "-explore-range");
    if (!input) return;
    exploreLabel(input);
    input.addEventListener("input", () => exploreLabel(input));
    $(prefix + "-explore").addEventListener("click", () => {
      if (prefix === "forge-vault") explore(prefix, privateDetail && privateDetail.settings, true);
      else explore(prefix, currentDetail && currentDetail.settings, false);
    });
  });
  $("forge-variation-clear").addEventListener("click", () => {
    variationPick = null;
    syncVariationChip();
  });

  async function openPrivate(id, from) {
    openFrom = from || document.activeElement;
    privateDetail = await api("/api/forge/vault/images/" + id);
    const response = await fetch("/api/forge/vault/images/" + id + "/original", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("locked");
    const privateBlob = await response.blob();
    const url = URL.createObjectURL(privateBlob);
    privateUrls.add(url);
    vaultViewerImg.src = url;
    vaultViewerImg.alt = "Image du coffre";
    const settings = privateDetail.settings || {};
    $("forge-vault-viewer-meta").textContent = [settings.prompt || "", settings.negative_prompt || ""].filter(Boolean).join("\n");
    exploreReady("forge-vault", settings);
    if ($("forge-vault-params")) $("forge-vault-params").checked = false;
    if (window.hqForgeOnViewer) window.hqForgeOnViewer("private", id, from && from.dataset ? from.dataset.triage || "none" : "none");
    vaultViewer.showModal();
    $("forge-vault-viewer-close").focus();
    prepareShare("private", privateBlob, "coffre.png", $("forge-vault-share"));
  }

  function closePrivate() {
    shareFiles.private = null;
    if ($("forge-vault-share")) $("forge-vault-share").hidden = true;
    if (vaultViewer.open) vaultViewer.close();
    if (vaultViewerImg.src) URL.revokeObjectURL(vaultViewerImg.src);
    vaultViewerImg.removeAttribute("src");
    if (openFrom) openFrom.focus();
  }

  $("forge-vault-viewer-close").addEventListener("click", closePrivate);
  $("forge-vault-share").addEventListener("click", () => { shareNow("private"); });
  $("forge-share").addEventListener("click", () => { shareNow("normal"); });
  vaultViewer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePrivate();
    }
  });
  $("forge-vault-download").addEventListener("click", async () => {
    if (!privateDetail) return;
    // Private exports carry no prompt text unless the owner ticks the box for this one export.
    const withParams = $("forge-vault-params") && $("forge-vault-params").checked;
    const response = await fetch("/api/forge/vault/images/" + privateDetail.id + "/original" + (withParams ? "?parameters=1" : ""), { credentials: "same-origin", cache: "no-store" });
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
    if (window.hqForgeTaint) window.hqForgeTaint(true);
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
    if (window.hqForgeTaint) window.hqForgeTaint();
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
    variationPick = Number(settings.subseed_strength) > 0 && Number(settings.seed) >= 0 && Number.isInteger(settings.subseed)
      ? { subseed: settings.subseed, strength: Number(settings.subseed_strength) } : null;
    syncVariationChip();
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
    if (window.hqForgeTaint) window.hqForgeTaint();
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
    resultIntent = false;
    hideSeeResult();
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

  /* Aide tooltips: keep an open one fully visible. The usable box is the viewport (minus
     safe areas), narrowed by any scrolling ancestor that would clip it (the sticky
     settings column on wide screens) and, below the button, by the sticky action bar
     and the bottom nav. Above is preferred; below when above does not fit; as a last
     resort the taller side is used and the text scrolls. Measured on open (hover,
     focus, tap) and on resize; static markup, so wired once. */
  function placeHelp(wrap) {
    const pop = wrap && wrap.querySelector(".forge-help-pop");
    if (!pop) return;
    pop.style.removeProperty("--help-dx");
    pop.style.removeProperty("max-height");
    pop.style.removeProperty("overflow-y");
    pop.classList.remove("is-below");
    const cs = getComputedStyle(pop);
    const de = document.documentElement;
    let left = parseFloat(cs.scrollMarginLeft) || 8;
    let right = de.clientWidth - (parseFloat(cs.scrollMarginRight) || 8);
    let top = parseFloat(cs.scrollMarginTop) || 8;
    let bottom = window.innerHeight - 8;
    for (let a = wrap.parentElement; a && a !== document.body; a = a.parentElement) {
      const o = getComputedStyle(a);
      if (o.overflowX === "visible" && o.overflowY === "visible") continue;
      const k = a.getBoundingClientRect();
      left = Math.max(left, k.left + 4);
      right = Math.min(right, k.right - 4);
      top = Math.max(top, k.top + 4);
      bottom = Math.min(bottom, k.bottom - 4);
    }
    const anchor = wrap.getBoundingClientRect();
    [$("forge-actionbar"), document.querySelector(".bottom-nav")].forEach((n) => {
      if (!n || n.contains(wrap) || !n.getClientRects().length) return;
      const k = n.getBoundingClientRect();
      if (k.top >= anchor.bottom - 1 && k.top < bottom + 8) bottom = Math.min(bottom, k.top - 6);
      else if (k.bottom <= anchor.top + 1 && k.bottom > top - 8) top = Math.max(top, k.bottom + 6);
    });
    pop.style.setProperty("--help-max", Math.max(120, right - left) + "px");
    const r = pop.getBoundingClientRect();
    if (!r.width) return;
    let dx = 0;
    if (r.right > right) dx = right - r.right;
    if (r.left + dx < left) dx = left - r.left;
    pop.style.setProperty("--help-dx", Math.round(dx) + "px");
    const above = anchor.top - 6 - top;
    const below = bottom - (anchor.bottom + 6);
    if (r.height <= above) return;
    if (r.height <= below || below > above) pop.classList.add("is-below");
    const room = Math.max(below, above);
    if (r.height > room) {
      pop.style.maxHeight = Math.max(48, Math.floor(room)) + "px";
      pop.style.overflowY = "auto";
    }
  }
  const helpWraps = document.querySelectorAll("#forge-studio .forge-help-wrap");
  helpWraps.forEach((wrap) => {
    wrap.addEventListener("mouseenter", () => placeHelp(wrap));
    wrap.addEventListener("focusin", () => placeHelp(wrap));
    const button = wrap.querySelector(".forge-help");
    if (button) button.addEventListener("click", () => placeHelp(wrap));
  });
  window.addEventListener("resize", () => {
    helpWraps.forEach((wrap) => {
      if (wrap.classList.contains("is-open") || wrap.matches(":hover") || wrap.matches(":focus-within")) placeHelp(wrap);
    });
  });

  /* Finished image: auto-scroll to it only when the user stayed idle. Cheap trusted
     signals while a submitted job runs; programmatic scrolls fire none of them. */
  const seeResult = $("forge-see-result");
  const resultsBox = $("forge-normal-results");
  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function scrollToResult() {
    hideSeeResult();
    resultsBox.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
  }
  function hideSeeResult() {
    if (seeResult) seeResult.hidden = true;
  }
  function showSeeResult() {
    if (!seeResult) return;
    // Already on screen (top in view, or at least 35% visible, matching the observer below): no chip.
    const box = resultsBox.getBoundingClientRect();
    const seen = Math.max(0, Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0));
    if ((box.top >= 0 && box.top < window.innerHeight * 0.6) || (box.height > 0 && seen / box.height >= 0.35)) return;
    seeResult.hidden = false;
  }
  const noteIntent = (event) => { if (justSubmitted && event.isTrusted) resultIntent = true; };
  studio.addEventListener("input", noteIntent);
  studio.addEventListener("change", noteIntent);
  studio.addEventListener("focusin", (event) => {
    const t = event.target;
    if (t && t.matches && t.matches("input, textarea, select, [contenteditable]")) noteIntent(event);
  });
  window.addEventListener("wheel", noteIntent, { passive: true });
  window.addEventListener("touchmove", noteIntent, { passive: true });
  const SCROLL_KEYS = ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "];
  window.addEventListener("keydown", (event) => {
    const t = event.target;
    if (SCROLL_KEYS.includes(event.key) && !(t && t.closest && t.closest("input, textarea, select, button, [contenteditable]"))) noteIntent(event);
  });
  if (seeResult) {
    seeResult.addEventListener("click", scrollToResult);
    if (window.IntersectionObserver) {
      new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) hideSeeResult();
      }, { threshold: 0.35 }).observe(resultsBox);
    }
  }

  /* ---------- Appareils de génération (multi-device batches) ----------
     HQ coordinates everything server-side; this tab only reads and asks.
     With only "Cet HQ" selected, Générer keeps the single-job path above. */
  var fleetBooted = false; // syncActions runs before this block is initialised
  const deviceList = $("forge-device-list");
  const devicesNote = $("forge-devices-note");
  const devicesCount = $("forge-devices-count");
  const fleetCountField = $("forge-fleet-count-field");
  const fleetCountEl = $("forge-fleet-count");
  const fleetPrivateNote = $("forge-fleet-private");
  const batchBox = $("forge-fleet-batch");
  const deviceDialog = $("forge-device-dialog");
  let devices = [];
  let devicesTimer = 0;
  let batchTimer = 0;
  let codeTimer = 0;
  let fleetGuard = false;
  const shownBatchImages = new Set();
  let selected = new Set((() => {
    try {
      const saved = JSON.parse(localStorage.getItem("hqForgeDevices") || "[]");
      return Array.isArray(saved) && saved.length ? saved.filter((id) => typeof id === "string") : ["local"];
    } catch (_) { return ["local"]; }
  })());

  function saveSelection() {
    try { localStorage.setItem("hqForgeDevices", JSON.stringify([...selected])); } catch (_) { /* private browsing */ }
  }

  function remoteSelected() {
    return devices.some((device) => device.kind === "remote" && selected.has(device.id));
  }

  function fleetMode() {
    return destination() !== "private" && remoteSelected();
  }

  function mb(value) {
    if (!Number.isFinite(value)) return "inconnue";
    return value >= 1024 ? (Math.round(value / 102.4) / 10).toString().replace(".", ",") + " Go" : value + " Mo";
  }

  function compatReasons(device) {
    // Each reason carries a next step. Titles keep "absent" so the card says what is missing.
    const catalog = device.catalog;
    if (!catalog) return [{ title: "Catalogue Forge inconnu.", action: "Attendez que l'appareil envoie son catalogue, ou red\u00e9marrez Forge sur ce PC." }];
    const out = [];
    const has = (list, value) => (list || []).includes(value);
    if (checkpointEl.value && !has(catalog.models, checkpointEl.value)) out.push({ title: "Mod\u00e8le \u00ab " + checkpointEl.value + " \u00bb absent.", action: "Copiez-le dans models\\Stable-diffusion de Forge sur ce PC, ou choisissez un mod\u00e8le pr\u00e9sent." });
    if (samplerEl.value && !has(catalog.samplers, samplerEl.value)) out.push({ title: "\u00c9chantillonneur \u00ab " + samplerEl.value + " \u00bb absent.", action: "Choisissez un autre \u00e9chantillonneur, ou mettez Forge \u00e0 jour sur ce PC." });
    if (schedulerEl.value && !has(catalog.schedulers, schedulerEl.value)) out.push({ title: "Planificateur \u00ab " + schedulerEl.value + " \u00bb absent.", action: "Choisissez un autre planificateur, ou mettez Forge \u00e0 jour sur ce PC." });
    if (hiresOn() && $("forge-hr-upscaler").value && !has(catalog.upscalers, $("forge-hr-upscaler").value)) out.push({ title: "Agrandisseur Hires. fix absent.", action: "Choisissez un agrandisseur pr\u00e9sent sur tous les appareils, ou d\u00e9sactivez Hires. fix." });
    return out;
  }

  function usable(device) {
    return ["available", "busy", "error"].includes(device.state) && device.last_error !== "secret_unprotected";
  }

  function deviceVerdict(device) {
    if (destination() === "private" && device.kind === "remote") return { ok: false, label: "Privé : cet HQ seulement", why: "La génération privée ne quitte pas cet HQ." };
    if (!usable(device)) {
      const why = {
        disabled: "Appareil désactivé par l'admin.",
        offline: "L'appareil ne contacte plus HQ" + (device.last_seen ? " (vu " + when(device.last_seen) + ")." : "."),
        error: device.last_error_label || "Erreur.",
        forge_down: device.online ? "En ligne, mais Forge ne répond pas sur cet appareil." : "Forge ne répond pas."
      }[device.state] || "";
      const first = (device.diagnostics || [])[0];
      return { ok: false, label: device.state_label, why: first ? first.title : why, next: first ? first.action : "", level: first ? first.level : "error" };
    }
    const reasons = compatReasons(device);
    if (reasons.length) return { ok: false, label: "Modèle incompatible", why: reasons.map((r) => r.title).join(" "), next: reasons[0].action, level: "warn" };
    const first = (device.diagnostics || [])[0];
    if (first) return { ok: true, label: device.state_label, why: first.title, next: first.action, level: first.level };
    return { ok: true, label: device.state_label, why: device.state === "error" ? (device.last_error_label || "Dernière tâche en erreur.") : "", next: "", level: "warn" };
  }

  function specLine(label, value) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    row.append(dt, dd);
    return row;
  }

  function adminActions(device) {
    const box = document.createElement("div");
    box.className = "forge-device-admin";
    const rename = document.createElement("form");
    rename.className = "forge-device-rename";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 40;
    input.value = device.name;
    input.setAttribute("aria-label", "Nouveau nom de " + device.name);
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Renommer";
    rename.append(input, save);
    rename.addEventListener("submit", (event) => {
      event.preventDefault();
      deviceAction(device.id, "rename", { name: input.value });
    });
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary";
    toggle.textContent = device.disabled ? "Réactiver" : "Désactiver";
    toggle.addEventListener("click", () => deviceAction(device.id, device.disabled ? "enable" : "disable", {}));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary forge-danger";
    remove.textContent = "Retirer";
    remove.addEventListener("click", () => {
      if (window.confirm("Retirer « " + device.name + " » ? Son accès est révoqué ; il faudra un nouveau code pour l'ajouter.")) deviceAction(device.id, "remove", {});
    });
    const row = document.createElement("div");
    row.className = "forge-actions";
    row.append(toggle, remove);
    box.append(rename, row);
    return box;
  }

  async function deviceAction(id, action, body) {
    try {
      await api("/api/forge/devices/" + encodeURIComponent(id) + "/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (document.activeElement && document.activeElement.closest && document.activeElement.closest(".forge-device-rename")) document.activeElement.blur();
      if (action === "remove") selected.delete(id);
      saveSelection();
      devicesNote.textContent = { rename: "Nom enregistré.", disable: "Appareil désactivé.", enable: "Appareil réactivé.", remove: "Appareil retiré. Son accès est révoqué." }[action];
    } catch (error) {
      devicesNote.textContent = error.message || "Action impossible.";
    }
    loadDevices().catch(() => {});
  }

  function textWithTitle(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    node.title = text; // full text when the card ellipsizes it
    return node;
  }

  function jobText(current) {
    return current.steps ? "Pas " + current.step + " / " + current.steps : "T\u00e2che en cours";
  }

  function deviceCard(device) {
    const verdict = deviceVerdict(device);
    const li = document.createElement("li");
    li.className = "forge-device";
    li.dataset.id = device.id;
    li.dataset.state = verdict.ok ? device.state : (verdict.label === "Mod\u00e8le incompatible" ? "incompatible" : device.state);
    const isOn = selected.has(device.id) && verdict.ok;
    li.classList.toggle("is-selected", isOn);
    const head = document.createElement("label");
    head.className = "forge-device-pick";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "forge-device-input";
    box.checked = isOn;
    box.disabled = !verdict.ok;
    box.setAttribute("aria-describedby", "forge-dev-why-" + device.id);
    box.addEventListener("change", () => {
      if (box.checked) selected.add(device.id); else selected.delete(device.id);
      saveSelection();
      renderDevices(true);
      syncActions();
    });
    const check = document.createElement("span");
    check.className = "forge-device-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = isOn ? "\u2713" : "";
    const name = textWithTitle("span", "forge-device-name", device.name);
    const chosen = document.createElement("span");
    chosen.className = "forge-device-chosen";
    chosen.textContent = isOn ? "Choisi" : (verdict.ok ? "" : "Indisponible");
    head.append(box, check, name, chosen);
    const pills = document.createElement("div");
    pills.className = "forge-device-pills";
    const link = document.createElement("span");
    link.className = "forge-pill";
    link.dataset.kind = device.online ? "on" : "off";
    link.textContent = device.kind === "local" ? "Cet HQ" : (device.online ? "En ligne" : "Hors ligne");
    const state = document.createElement("span");
    state.className = "forge-pill";
    state.dataset.kind = verdict.ok ? (device.state === "busy" ? "busy" : (device.state === "error" ? "warn" : "ok")) : "bad";
    state.textContent = verdict.label;
    pills.append(link, state);
    const first = (device.hardware && device.hardware.gpus || [])[0];
    const gpu = textWithTitle("p", "forge-device-gpu", first ? first.name + " \u00b7 VRAM " + mb(first.vram_mb) : "GPU inconnu");
    li.append(head, pills, gpu);
    const why = document.createElement("div");
    why.className = "forge-device-why";
    why.id = "forge-dev-why-" + device.id;
    why.dataset.level = verdict.level || "";
    if (verdict.why) {
      const title = document.createElement("p");
      title.className = "forge-device-diag";
      title.textContent = verdict.why;
      why.append(title);
      if (verdict.next) {
        const next = document.createElement("p");
        next.className = "forge-device-next";
        next.textContent = "\u00c0 faire : " + verdict.next;
        why.append(next);
      }
    }
    li.append(why);
    if (device.current) {
      const job = document.createElement("div");
      job.className = "forge-device-job";
      const bar = document.createElement("progress");
      bar.max = 1;
      bar.value = Number(device.current.progress || 0);
      bar.setAttribute("aria-label", "Progression sur " + device.name);
      const text = document.createElement("span");
      text.className = "forge-device-job-text";
      text.textContent = jobText(device.current);
      job.append(bar, text);
      li.append(job);
    }
    const more = document.createElement("details");
    more.className = "forge-device-more";
    if (window.matchMedia && window.matchMedia("(min-width: 760px)").matches) more.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "Caract\u00e9ristiques";
    const dl = document.createElement("dl");
    dl.className = "forge-device-specs";
    const gpus = (device.hardware && device.hardware.gpus) || [];
    dl.append(specLine("GPU", gpus.length ? gpus.map((g) => g.name).join(", ") : "inconnu"));
    dl.append(specLine("VRAM", first ? mb(first.vram_mb) : "inconnue"));
    dl.append(specLine("CPU", (device.hardware && device.hardware.cpu) || "inconnu"));
    dl.append(specLine("RAM", mb(device.hardware && device.hardware.ram_mb)));
    dl.append(specLine("Mod\u00e8le charg\u00e9", device.model || "inconnu"));
    if (device.kind === "remote") dl.append(specLine("Vu", device.last_seen ? when(device.last_seen) : "jamais"));
    if (device.last_error_label) dl.append(specLine("Derni\u00e8re erreur", device.last_error_label));
    more.append(summary, dl);
    const diags = device.diagnostics || [];
    if (diags.length > 1) {
      const list = document.createElement("ul");
      list.className = "forge-device-diags";
      diags.forEach((d) => {
        const item = document.createElement("li");
        item.dataset.level = d.level;
        item.dataset.code = d.code;
        item.textContent = d.title + " \u00c0 faire : " + d.action;
        list.append(item);
      });
      more.append(list);
    }
    if (device.kind === "remote") more.append(adminActions(device));
    li.append(more);
    li.addEventListener("click", (event) => {
      if (event.target.closest("input, button, a, details, label, form")) return;
      if (!box.disabled) box.click();
    });
    return li;
  }

  let deviceSig = "";
  function cardSig() {
    // Everything a card shows except live progress, which is patched in place.
    return JSON.stringify([devices.map((d) => Object.assign({}, d, { current: d.current ? d.current.task_id : null, last_seen: d.online ? null : d.last_seen })),
      [...selected], destination(), checkpointEl.value, samplerEl.value, schedulerEl.value, hiresOn(), $("forge-hr-upscaler").value]);
  }

  function patchProgress() {
    devices.forEach((device) => {
      if (!device.current) return;
      const node = deviceList.querySelector('.forge-device[data-id="' + CSS.escape(device.id) + '"]');
      if (!node) return;
      const bar = node.querySelector(".forge-device-job progress");
      const text = node.querySelector(".forge-device-job-text");
      const value = Number(device.current.progress || 0);
      if (bar && bar.value !== value) bar.value = value;
      if (text && text.textContent !== jobText(device.current)) text.textContent = jobText(device.current);
    });
  }

  function renderDevices(force) {
    const typing = document.activeElement && document.activeElement.matches && document.activeElement.matches(".forge-device-rename input");
    if (typing) return; // never rebuild under a rename in progress
    const sig = cardSig();
    if (!force && sig === deviceSig && deviceList.children.length === devices.length) {
      patchProgress(); // in place: no rebuild, focus and scroll untouched
    } else {
      deviceSig = sig;
      const openIds = new Set([...deviceList.querySelectorAll(".forge-device-more[open]")].map((node) => node.closest(".forge-device").dataset.id));
      const closedIds = new Set([...deviceList.querySelectorAll(".forge-device-more:not([open])")].map((node) => node.closest(".forge-device").dataset.id));
      const focusId = document.activeElement && document.activeElement.closest && document.activeElement.closest(".forge-device") ? document.activeElement.closest(".forge-device").dataset.id : null;
      deviceList.replaceChildren(...devices.map(deviceCard));
      deviceList.querySelectorAll(".forge-device").forEach((node) => {
        const more = node.querySelector(".forge-device-more");
        if (openIds.has(node.dataset.id)) more.open = true;
        else if (closedIds.has(node.dataset.id)) more.open = false;
      });
      if (focusId) {
        const back = deviceList.querySelector('.forge-device[data-id="' + CSS.escape(focusId) + '"] input[type="checkbox"]');
        if (back) back.focus({ preventScroll: true });
      }
    }
    const chosen = devices.filter((device) => selected.has(device.id) && deviceVerdict(device).ok);
    const count = chosen.length === 0 ? "Aucun appareil choisi" : chosen.length === 1 ? "1 appareil choisi" : chosen.length + " appareils choisis";
    if (devicesCount.textContent !== count) devicesCount.textContent = count;
    const remote = devices.some((device) => device.kind === "remote");
    $("forge-devices-all").hidden = !remote;
    fleetCountField.hidden = !fleetMode();
    fleetPrivateNote.hidden = !(destination() === "private" && remote);
  }

  async function loadDevices() {
    clearTimeout(devicesTimer);
    try {
      const payload = await api("/api/forge/devices");
      devices = payload.devices || [];
      renderDevices();
      syncActions(submitGuard);
    } catch (error) {
      devicesNote.textContent = error.message || "Les appareils ne sont pas lisibles.";
    }
    if (!document.hidden && document.body.dataset.view === "forge") devicesTimer = setTimeout(() => loadDevices().catch(() => {}), batchTimer ? 2000 : 5000);
  }

  function fleetCatalogFill() {
    // Local Forge down: offer what every selected remote device has in common. Never a substitute model.
    if (catalogState === "ready" || !fleetMode()) return;
    const chosen = devices.filter((device) => device.kind === "remote" && selected.has(device.id) && usable(device) && device.catalog);
    if (!chosen.length) return;
    const common = (key) => chosen.map((d) => d.catalog[key] || []).reduce((a, b) => a.filter((x) => b.includes(x)));
    const same = (select, list) => select.options.length === list.length && list.every((v, i) => select.options[i].value === v);
    const models = common("models");
    const samplers = common("samplers");
    const schedulers = common("schedulers");
    if (!same(checkpointEl, models)) fillSelect(checkpointEl, models, (v) => ({ value: v, label: v }), "");
    if (!same(samplerEl, samplers)) fillSelect(samplerEl, samplers, (v) => ({ value: v, label: v }), "Euler a");
    if (!same(schedulerEl, schedulers)) fillSelect(schedulerEl, schedulers, (v) => ({ value: v, label: v }), "automatic");
    const ups = common("upscalers");
    if ($("forge-hr-upscaler").options.length !== ups.length) fillUpscalers(ups.map((n) => ({ name: n })));
    if (choiceNote) choiceNote.textContent = "Menus issus des appareils choisis : Forge de cet HQ ne répond pas.";
  }

  function fleetSync(active) {
    renderDevicesLight();
    if (!fleetMode()) return;
    fleetCatalogFill();
    const chosen = devices.filter((device) => selected.has(device.id));
    const ok = chosen.filter((device) => deviceVerdict(device).ok);
    const count = Number(fleetCountEl.value);
    const hiresMissing = hiresOn() && !$("forge-hr-upscaler").value;
    const hiresLarge = hiresOn() && !hiresFits();
    let reason = "";
    if (active || fleetGuard) reason = "Générer est désactivé : un lot est en cours d'envoi.";
    else if (!ok.length) reason = "Générer est désactivé : aucun appareil choisi n'est disponible.";
    else if (ok.length < chosen.length) reason = "Générer est désactivé : un appareil choisi n'est pas disponible ou compatible.";
    else if (!checkpointEl.value || !samplerEl.value || !schedulerEl.value) reason = "Générer est désactivé : les menus ne sont pas remplis.";
    else if (!Number.isInteger(count) || count < 1 || count > 16) reason = "Générer est désactivé : choisissez de 1 à 16 images.";
    else if (hiresMissing) reason = "Générer est désactivé : l'agrandisseur n'est pas disponible.";
    else if (hiresLarge) reason = "Générer est désactivé : le second passage dépasserait 2048 pixels.";
    generateBtn.disabled = !!reason;
    if (reasonEl) reasonEl.textContent = reason;
    setGenerateLabel(reason ? "Générer" : "Générer " + count + " sur " + ok.length + (ok.length > 1 ? " appareils" : " appareil"));
  }

  function setGenerateLabel(text) {
    // Only touch the DOM on a real change: WebKit drops a click whose target text node is replaced mid-press.
    if (generateBtn.textContent !== text) generateBtn.textContent = text;
  }

  function renderDevicesLight() {
    if (!fleetMode()) setGenerateLabel("Générer");
    if (deviceList && devices.length) {
      fleetCountField.hidden = !fleetMode();
      fleetPrivateNote.hidden = !(destination() === "private" && devices.some((d) => d.kind === "remote"));
    }
  }

  function batchKey(fresh) {
    if (fresh) sessionStorage.removeItem("hqForgeBatchKey");
    let value = sessionStorage.getItem("hqForgeBatchKey");
    if (!value) {
      value = "bt" + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 38);
      sessionStorage.setItem("hqForgeBatchKey", value);
    }
    return value;
  }

  async function fleetGenerate() {
    if (fleetGuard || generateBtn.disabled) return;
    fleetGuard = true;
    generateBtn.disabled = true;
    const settings = settingsFromForm();
    delete settings.n_iter;
    delete settings.batch_size;
    const workers = devices.filter((device) => selected.has(device.id) && deviceVerdict(device).ok).map((device) => device.id);
    progressBox.hidden = false;
    progressLabel.textContent = "Envoi du lot…";
    try {
      const payload = await api("/api/forge/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": batchKey(false) },
        body: JSON.stringify({ workers: workers, count: Number(fleetCountEl.value), settings: settings, destination: "normal" })
      });
      if (window.hqForgeWipeDraft) window.hqForgeWipeDraft();
      justSubmitted = true;
      resultIntent = false;
      results.replaceChildren();
      shownBatchImages.clear();
      showBatch(payload.batch);
    } catch (error) {
      const problems = error && error.data && error.data.problems;
      progressLabel.textContent = (error.message || "Le lot n'a pas démarré.") + (problems ? " " + problems.map((p) => p.name + " : " + p.reasons.join(" ")).join(" ") : "");
      batchKey(true);
    }
    fleetGuard = false;
    syncActions(false);
  }

  function showBatch(batch) {
    if (!batch) return;
    sessionStorage.setItem("hqForgeBatch", batch.batch_id);
    batchBox.hidden = false;
    const c = batch.counts;
    const running = batch.state === "running" || batch.state === "cancelling";
    setWake("batch", running);
    const setText = (id, value) => { const n = $(id); if (n.textContent !== value) n.textContent = value; };
    setText("forge-fleet-batch-state", { running: "En cours", cancelling: "Annulation…", completed: "Terminé", partial: "Terminé en partie", failed: "Échec", cancelled: "Annulé" }[batch.state] || batch.state);
    setText("forge-fleet-batch-totals", c.done + " / " + c.total + " terminées · " + c.failed + " en échec · " + c.pending + " en attente · " + c.running + " en cours" + (c.uncertain ? " · " + c.uncertain + " incertaines" : "") + (c.cancelled ? " · " + c.cancelled + " annulées" : ""));
    // Parity (A): devices left out of the split are always named, never dropped silently.
    let excludedEl = $("forge-fleet-batch-excluded");
    if (!excludedEl) {
      excludedEl = document.createElement("p");
      excludedEl.id = "forge-fleet-batch-excluded";
      excludedEl.className = "forge-fleet-batch-excluded";
      $("forge-fleet-batch-totals").after(excludedEl);
    }
    const excludedText = (batch.excluded || []).map((row) => row.message).join(" ");
    if (excludedEl.textContent !== excludedText) excludedEl.textContent = excludedText;
    excludedEl.hidden = !excludedText;
    const list = $("forge-fleet-batch-workers");
    const keep = new Set();
    batch.workers.forEach((row) => {
      keep.add(row.worker_id);
      let li = list.querySelector('.forge-fleet-batch-worker[data-worker="' + CSS.escape(row.worker_id) + '"]');
      if (!li) {
        li = document.createElement("li");
        li.className = "forge-fleet-batch-worker";
        li.dataset.worker = row.worker_id;
        const name = document.createElement("span");
        name.className = "forge-device-name";
        const status = document.createElement("span");
        status.className = "forge-fleet-batch-worker-state";
        const bar = document.createElement("progress");
        bar.max = 1;
        const text = document.createElement("span");
        text.className = "forge-fleet-batch-worker-text";
        li.append(name, status, bar, text);
        list.append(li);
      }
      const set = (sel, value) => { const n = li.querySelector(sel); if (n.textContent !== value) n.textContent = value; };
      set(".forge-device-name", row.name);
      li.querySelector(".forge-device-name").title = row.name;
      const uncertain = Number(row.uncertain || 0);
      const failed = Math.max(0, Number(row.failed || 0) - uncertain);
      const status = row.running ? (row.steps ? "En cours \u00b7 pas " + row.step + " / " + row.steps : "En cours") : (running ? "En attente" : "Termin\u00e9");
      li.dataset.state = row.running ? "running" : (running ? "waiting" : "done");
      set(".forge-fleet-batch-worker-state", status);
      const bar = li.querySelector("progress");
      const value = row.running ? Number(row.progress || 0) : (row.done ? 1 : 0);
      if (bar.value !== value) bar.value = value;
      bar.setAttribute("aria-label", "Progression de " + row.name);
      set(".forge-fleet-batch-worker-text", row.done + " termin\u00e9e" + (row.done > 1 ? "s" : "") + (failed ? ", " + failed + " en \u00e9chec" : "") +
        (uncertain ? ", " + uncertain + " incertaine" + (uncertain > 1 ? "s" : "") : "") + (row.running ? ", 1 en cours" : ""));
    });
    [...list.children].forEach((li) => { if (!keep.has(li.dataset.worker)) li.remove(); });
    const issues = batch.tasks.filter((task) => ["failed", "uncertain"].includes(task.state));
    const deferred = batch.tasks.some((task) => task.cancel_deferred && ["dispatched", "running"].includes(task.state));
    setText("forge-fleet-batch-note", (deferred ? "Images déjà envoyées : chaque appareil termine la sienne. Forge n'est jamais interrompu. " : "") +
      (issues.length ? issues.slice(0, 3).map((task) => "Image " + (task.index + 1) + (task.worker_name ? " (" + task.worker_name + ")" : "") + " : " + task.message).join(" ") : "") +
      (batch.seed_mode === "fixed" ? " Graines " + batch.tasks[0].seed + " à " + batch.tasks[batch.tasks.length - 1].seed + "." : ""));
    $("forge-fleet-batch-cancel").hidden = !running;
    $("forge-fleet-batch-cancel").disabled = batch.state === "cancelling";
    const retryBtn = $("forge-fleet-batch-retry");
    const retryable = Number(batch.retryable || 0);
    const retryUncertain = Number(batch.retry_uncertain || 0);
    retryBtn.hidden = running || retryable < 1;
    retryBtn.dataset.batch = batch.batch_id;
    const retryLabel = "Relancer " + (retryable > 1 ? "les " + retryable + " images manquantes" : "l'image manquante");
    if (retryBtn.textContent !== retryLabel) retryBtn.textContent = retryLabel;
    if (!running && retryUncertain) {
      const extra = " " + (retryUncertain > 1 ? retryUncertain + " images incertaines peuvent" : "Une image incertaine peut") +
        " produire un doublon si l'appareil d'origine la termine quand même.";
      const note = $("forge-fleet-batch-note");
      if (!note.textContent.includes("doublon")) note.textContent = (note.textContent + extra).trim();
    }
    $("forge-fleet-batch-close").hidden = running;
    let added = false;
    batch.tasks.forEach((task) => {
      if (task.image_id && !shownBatchImages.has(task.image_id)) {
        shownBatchImages.add(task.image_id);
        results.appendChild(card({ id: task.image_id, thumb: "/api/forge/gallery/" + task.image_id + "/thumb" }));
        added = true;
      }
    });
    if (added) {
      const resultsEmpty = $("forge-results-empty");
      if (resultsEmpty) resultsEmpty.hidden = true;
    }
    progressBox.hidden = !running;
    const overall = c.total ? (c.done + c.failed + c.uncertain + c.cancelled) / c.total : 0;
    if (progressBar.value !== overall) progressBar.value = overall;
    const label = running ? "Lot : " + c.done + " / " + c.total : "";
    if (progressLabel.textContent !== label) progressLabel.textContent = label;
    clearTimeout(batchTimer);
    batchTimer = 0;
    if (running) {
      batchTimer = setTimeout(() => pollBatch(batch.batch_id), 1500);
    } else {
      batchKey(true);
      loadGallery(true).catch(() => {});
      if (justSubmitted && window.matchMedia && window.matchMedia("(max-width: 899px)").matches) {
        if (resultIntent) showSeeResult(); else scrollToResult();
      }
      justSubmitted = false;
    }
  }

  async function pollBatch(id) {
    try {
      const payload = await api("/api/forge/batches/" + encodeURIComponent(id));
      showBatch(payload.batch);
      loadDevices().catch(() => {});
    } catch (error) {
      $("forge-fleet-batch-note").textContent = error.message || "Suivi interrompu. Le lot continue sur HQ.";
      batchTimer = setTimeout(() => pollBatch(id), 4000);
    }
  }

  async function resumeBatch() {
    try {
      const payload = await api("/api/forge/batches");
      const mine = sessionStorage.getItem("hqForgeBatch");
      const live = (payload.batches || []).find((batch) => batch.state === "running" || batch.state === "cancelling") ||
        (payload.batches || []).find((batch) => batch.batch_id === mine);
      if (live) showBatch(live);
    } catch (_) { /* nothing to resume */ }
  }

  form.addEventListener("submit", (event) => {
    if (!fleetMode()) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    fleetGenerate();
  }, true);

  $("forge-devices-all").addEventListener("click", () => {
    devices.forEach((device) => { if (deviceVerdict(device).ok) selected.add(device.id); });
    saveSelection();
    renderDevices();
    syncActions();
  });
  fleetCountEl.addEventListener("input", () => syncActions());
  [checkpointEl, samplerEl, schedulerEl, $("forge-hr"), $("forge-hr-upscaler")].forEach((node) => node.addEventListener("change", () => { renderDevices(true); syncActions(); }));
  document.querySelectorAll('input[name="forge-destination"]').forEach((node) => node.addEventListener("change", () => { renderDevices(true); syncActions(); }));

  $("forge-fleet-batch-cancel").addEventListener("click", async () => {
    const id = sessionStorage.getItem("hqForgeBatch");
    if (!id) return;
    try {
      const payload = await api("/api/forge/batches/" + encodeURIComponent(id) + "/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      showBatch(payload.batch);
    } catch (error) {
      $("forge-fleet-batch-note").textContent = error.message || "Annulation impossible.";
    }
  });
  let retryKey = { batch: "", key: "" };
  $("forge-fleet-batch-retry").addEventListener("click", async () => {
    const btn = $("forge-fleet-batch-retry");
    const id = btn.dataset.batch;
    if (!id || btn.disabled) return;
    if (retryKey.batch !== id) retryKey = { batch: id, key: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "retry").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) };
    btn.disabled = true;
    try {
      const payload = await api("/api/forge/batches/" + encodeURIComponent(id) + "/retry", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": retryKey.key }, body: "{}"
      });
      retryKey = { batch: "", key: "" };
      justSubmitted = true;
      resultIntent = false;
      showBatch(payload.batch);
    } catch (error) {
      const problems = error && error.data && error.data.problems;
      $("forge-fleet-batch-note").textContent = (error.message || "La relance n'a pas démarré.") +
        (problems && problems.length ? " " + problems.map((p) => p.name + " : " + p.reasons.join(" ")).join(" ") : "");
      if (error && error.status !== 409) retryKey = { batch: "", key: "" };
    } finally {
      btn.disabled = false;
    }
  });
  $("forge-fleet-batch-close").addEventListener("click", () => {
    batchBox.hidden = true;
    sessionStorage.removeItem("hqForgeBatch");
  });

  // Copyable commands are built from the page origin only. The pairing code is never part of them.
  function snippet() {
    return "py -3 .\\hq_forge_worker.py pair --hq " + location.origin + ' --name "PC salon"';
  }
  function runSnippet() {
    return "py -3 .\\hq_forge_worker.py run";
  }
  const copyTexts = { pair: snippet, run: runSnippet };

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (_) { /* fall back below */ }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    deviceDialog.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    area.remove();
    return ok;
  }

  deviceDialog.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const make = copyTexts[button.dataset.copy];
      if (!make) return;
      const ok = await copyText(make());
      const label = button.dataset.label || button.textContent;
      button.dataset.label = label;
      button.textContent = ok ? "Copi\u00e9 \u2713" : "Copie impossible : s\u00e9lectionnez le texte";
      setTimeout(() => { button.textContent = label; }, 2000);
    });
  });

  let detectTimer = 0;
  let knownIds = null;
  function setDetect(text, found) {
    const node = $("forge-device-detect");
    if (node.textContent !== text) node.textContent = text;
    node.dataset.found = found ? "1" : "";
  }
  async function detectDevices() {
    clearTimeout(detectTimer);
    if (!deviceDialog.open) return;
    try {
      const payload = await api("/api/forge/devices");
      const list = payload.devices || [];
      if (knownIds === null) knownIds = new Set(list.map((d) => d.id));
      const fresh = list.find((d) => d.kind === "remote" && !knownIds.has(d.id));
      if (fresh) {
        forgetCode(); // the code is spent: stop showing it
        setDetect("Appareil d\u00e9tect\u00e9 \u2713 \u00ab " + fresh.name + " \u00bb" + (fresh.online ? " est en ligne." : " est associ\u00e9 : lancez maintenant la commande \u00ab run \u00bb."), true);
        devices = list;
        renderDevices(true);
        if (fresh.online) return;
      } else if (!$("forge-device-detect").dataset.found) {
        setDetect("En attente d'un nouvel appareil\u2026 Cette liste se met \u00e0 jour toute seule.", false);
      }
    } catch (_) {
      setDetect("La liste des appareils n'est pas lisible pour le moment.", false);
    }
    if (deviceDialog.open) detectTimer = setTimeout(() => detectDevices().catch(() => {}), 2000);
  }

  $("forge-device-add").addEventListener("click", () => {
    $("forge-device-snippet").textContent = snippet();
    $("forge-device-run").textContent = runSnippet();
    $("forge-device-code-box").hidden = true;
    $("forge-device-code").textContent = "";
    knownIds = new Set(devices.map((d) => d.id));
    $("forge-device-detect").dataset.found = "";
    setDetect("En attente d'un nouvel appareil\u2026 Cette liste se met \u00e0 jour toute seule.", false);
    deviceDialog.showModal();
    detectDevices().catch(() => {});
  });
  function forgetCode() {
    clearInterval(codeTimer);
    $("forge-device-code").textContent = "";
    $("forge-device-code-box").hidden = true;
  }
  $("forge-device-dialog-close").addEventListener("click", () => { forgetCode(); deviceDialog.close(); });
  deviceDialog.addEventListener("close", () => {
    forgetCode();
    clearTimeout(detectTimer);
    knownIds = null;
    $("forge-device-add").focus({ preventScroll: true });
    loadDevices().catch(() => {});
  });
  $("forge-device-code-new").addEventListener("click", async () => {
    try {
      const payload = await api("/api/forge/devices/enroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      $("forge-device-code").textContent = payload.code;
      $("forge-device-code-box").hidden = false;
      const end = Date.now() + payload.ttl_sec * 1000;
      const tick = () => {
        const left = Math.max(0, Math.round((end - Date.now()) / 1000));
        $("forge-device-code-ttl").textContent = left ? "Expire dans " + Math.floor(left / 60) + " min " + String(left % 60).padStart(2, "0") + " s." : "Code expir\u00e9. Cr\u00e9ez-en un autre.";
        if (!left) { clearInterval(codeTimer); $("forge-device-code").textContent = ""; }
      };
      clearInterval(codeTimer);
      tick();
      codeTimer = setInterval(tick, 1000);
    } catch (error) {
      $("forge-device-code-ttl").textContent = error.message || "Le code n'a pas pu \u00eatre cr\u00e9\u00e9.";
      $("forge-device-code-box").hidden = false;
    }
  });

  /* Prompt draft (F3). iOS may discard a background tab; the normal prompt and
     negative prompt survive in sessionStorage. Nothing is ever written while the
     destination is the private vault, and switching destination wipes the key
     before any pending save can run (capture phase, ahead of every other handler). */
  const DRAFT_KEY = "hqForgeDraft";
  const SCRUB_NOTE = "Champs vidés : le texte privé n'est pas conservé.";
  let draftTimer = 0;
  // Set while the fields may hold text typed, restored or preset-filled in private mode.
  let privateText = destination() === "private";
  let lastDestination = destination();
  function wipeDraft() {
    clearTimeout(draftTimer);
    draftTimer = 0;
    try { sessionStorage.removeItem(DRAFT_KEY); } catch (_) { /* storage off */ }
  }
  function draftNote(text) {
    const note = $("forge-draft-note");
    if (!note) return;
    note.textContent = text;
    note.hidden = !text;
  }
  function taint(always) {
    if (always === true || destination() === "private") privateText = true;
    if (privateText) wipeDraft();
  }
  function scrubPrivate() {
    if (!privateText && destination() !== "private") return;
    wipeDraft();
    const had = !!(promptEl.value || negativeEl.value);
    promptEl.value = "";
    negativeEl.value = "";
    privateText = destination() === "private";
    if (had) draftNote(SCRUB_NOTE);
  }
  function saveDraft() {
    draftTimer = 0;
    if (destination() !== "normal" || privateText) { wipeDraft(); return; }
    const prompt = promptEl.value;
    const negative = negativeEl.value;
    try {
      if (!prompt.trim() && !negative.trim()) sessionStorage.removeItem(DRAFT_KEY);
      else sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ prompt: prompt.slice(0, 2000), negative_prompt: negative.slice(0, 1000) }));
    } catch (_) { /* storage full or off */ }
  }
  function queueDraft() {
    if (destination() !== "normal") { privateText = true; wipeDraft(); return; }
    clearTimeout(draftTimer);
    if (privateText) { wipeDraft(); return; }
    draftTimer = setTimeout(saveDraft, 400);
  }
  // Capture phase: runs ahead of every other handler, so no pending save survives a switch.
  const onDestination = (event) => {
    if (!event.target || event.target.name !== "forge-destination") return;
    wipeDraft();
    const next = destination();
    if (next === "private") privateText = true;
    if (event.type !== "change") return;
    if (lastDestination === "private" && next === "normal") scrubPrivate();
    lastDestination = next;
  };
  document.addEventListener("input", onDestination, true);
  document.addEventListener("change", onDestination, true);
  document.addEventListener("click", (event) => {
    if (event.target && event.target.closest && event.target.closest('input[name="forge-destination"]')) wipeDraft();
  }, true);
  promptEl.addEventListener("input", queueDraft);
  negativeEl.addEventListener("input", queueDraft);
  function restoreDraft() {
    if (destination() !== "normal") { wipeDraft(); return; }
    let draft = null;
    try { draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); } catch (_) { draft = null; }
    if (!draft || typeof draft.prompt !== "string") return;
    if (promptEl.value.trim() || negativeEl.value.trim()) return;
    promptEl.value = draft.prompt;
    negativeEl.value = typeof draft.negative_prompt === "string" ? draft.negative_prompt : "";
    draftNote("Brouillon repris.");
  }
  promptEl.addEventListener("input", () => { const note = $("forge-draft-note"); if (note && !note.hidden) note.hidden = true; });
  window.hqForgeWipeDraft = wipeDraft;
  window.hqForgeTaint = taint;
  window.hqForgeScrubPrivate = scrubPrivate;
  restoreDraft();

  const usualFields = new Set(["forge-width", "forge-height", "forge-steps", "forge-steps-range", "forge-iter", "forge-hr"]);
  studio.addEventListener("change", (event) => { if (event.target && usualFields.has(event.target.id)) queueUsual(); });
  studio.addEventListener("input", (event) => { if (event.target && usualFields.has(event.target.id)) queueUsual(); });
  document.querySelectorAll(".forge-ratio").forEach((button) => button.addEventListener("click", queueUsual));

  const wakeBox = $("forge-wake");
  if (wakeBox && wakeSupported) {
    $("forge-wake-wrap").hidden = false;
    wakeBox.checked = wakePref();
    wakeBox.addEventListener("change", () => {
      try { localStorage.setItem(WAKE_KEY, wakeBox.checked ? "1" : "0"); } catch (_) { /* storage off */ }
      syncWake();
    });
  }
  /* Coming back to the app: refresh at once instead of waiting for the next tick. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!studio.offsetParent && studio.getClientRects().length === 0) return; // Forge view not shown
    try { resume().catch(() => {}); } catch (_) { /* nothing to resume */ }
    try { if (fleetBooted) resumeBatch().catch(() => {}); } catch (_) { /* nothing to resume */ }
    syncWake();
  });

  fleetBooted = !!deviceList;

  syncCount();
  syncHistoryAvailability();

  syncSeedMode();
  syncRanges();

  window.hqForgeShow = function () {
    refreshStatus().then(() => refreshVault()).then(() => Promise.all([resume(), loadGallery(true), loadPresetList()])).catch(() => {});
    queueUsual();
    refreshStatus().catch(() => {}).then(() => loadDevices()).then(() => resumeBatch()).catch(() => {});
  };
  window.hqForgeHide = function () {
    hideSeeResult();
    if (historyDlg && historyDlg.open) historyDlg.close();
    historyItems = [];
    historyLoaded = false;
    clearTimeout(pollTimer);
    clearTimeout(idleTimer);
    clearTimeout(devicesTimer);
    clearTimeout(batchTimer);
    batchTimer = 0;
    wakeJob = false;
    wakeBatch = false;
    syncWake();
    if (deviceDialog && deviceDialog.open) deviceDialog.close();
    if (viewer.open) viewer.close();
    clearPrivateUi();
  };
})();
