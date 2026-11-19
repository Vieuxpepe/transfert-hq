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
  const progressSegments = document.createElement("div");
  progressSegments.id = "forge-progress-segments";
  progressSegments.className = "forge-progress-segments";
  progressSegments.setAttribute("role", "progressbar");
  progressSegments.setAttribute("aria-label", "Progression du lot");
  progressSegments.setAttribute("aria-valuemin", "0");
  progressSegments.setAttribute("aria-valuemax", "1");
  progressSegments.setAttribute("aria-valuenow", "0");
  progressSegments.hidden = true;
  if (progressBar && progressBar.parentNode) progressBar.insertAdjacentElement("afterend", progressSegments);
  const retryJob = $("forge-retry-job");
  /* Live settings summary: keep the choices that change the result visible next to Generate. */
  const settingsSummary = document.createElement("p");
  settingsSummary.id = "forge-settings-summary";
  settingsSummary.className = "forge-settings-summary";
  /* No aria-live here: this line changes on every slider tick, so announcing it
     would talk over the field the user is actually editing. */
  {
    const usual = $("forge-usual-duration");
    if (usual && usual.parentNode) usual.parentNode.insertBefore(settingsSummary, usual.nextSibling);
  }
  const jobDestination = $("forge-job-destination");
  // Retain the exact submitted settings for this tab, including private jobs.
  let generationAttempt = null;
  let jobDestinationMode = "";
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
  let revealCentered = false; // this submit already centered a finished result: later batch results only animate
  // Soft ripple trigger: the house style (phase J3) was applied and the submitted settings still match it.
  // A new image cannot be a favourite yet (triage is set later), so the house style is the honest signal.
  let houseApplied = null; // in memory only, never stored
  let celebrateSubmit = false;
  function houseInUse() {
    const s = houseApplied;
    if (!s) return false;
    const same = (a, b) => a === undefined || a === null || a === "" || String(a) === String(b) || Number(a) === Number(b);
    const used = ["sampler_name", "scheduler", "width", "height", "steps", "cfg_scale"].filter((k) => s[k] !== undefined && s[k] !== null && s[k] !== "");
    if (!used.length) return false;
    return same(s.sampler_name, samplerEl.value) && same(s.scheduler, schedulerEl.value) && same(s.width, $("forge-width").value) &&
      same(s.height, $("forge-height").value) && same(s.steps, $("forge-steps").value) && same(s.cfg_scale, $("forge-cfg").value);
  }
  let resultIntent = false; // the user typed, changed a setting, focused a field or scrolled since the last submit
  let cursor = null;
  let openFrom = null;
  let currentDetail = null;
  let forgeState = "offline";
  let catalogState = "offline";
  let vaultState = { configured: false, unlocked: false, private_generation: false };
  /* Multi-vault V4: the vault this HQ session has open (one at a time), from GET /api/forge/vaults.
     Names and ids live only in this page's memory; nothing about a vault goes to browser storage. */
  let openVid = null;
  let vaultListing = { layout: "empty", vaults: [], open: null, max: 12 };
  let sheetVid = null;
  let createOpen = false;
  /* V6: the restore form (a ZIP always comes back as a new vault). */
  let restoreOpen = false;
  /* V4.4: the destination of a private generation, chosen by the owner; never guessed. */
  let privateTarget = null;
  /* V4.5: migration of the single pre-migration vault. The server records the backup offer and binds
     it to this unlock; the page only mirrors it to explain the steps. Nothing migrates by itself. */
  const OFFER_MS = 15 * 60 * 1000;
  let legacyOpen = false;
  let migrateOffer = 0;
  let migrateTimer = 0;
  let migrating = false;
  const anyVaultOpen = () => !!vaultState.unlocked || legacyOpen;
  const vaultBase = () => "/api/forge/vaults/" + encodeURIComponent(openVid || "none");
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
    if (model && model.value) parts.push("Modèle sélectionné pour la génération : " + model.textContent);
    if (sampler && sampler.value) parts.push("Échantillonneur : " + sampler.textContent);
    if (scheduler && scheduler.value) parts.push("Planificateur : " + scheduler.textContent);
    const dropped = stale ? " Le choix précédent n'est plus proposé." : "";
    choiceNote.textContent = parts.length ? parts.join(". ") + "." + dropped : "";
    updateSettingsSummary();
  }

  /* The last stretch: within a tenth of the end, or five seconds by Forge's own clock. */
  function nearFinish(pct, payload) {
    const eta = payload && typeof payload.eta === "number" ? payload.eta : 0;
    return pct >= 90 || (eta > 0 && eta <= 5);
  }

  /* Seconds left, as a reader would say it: 45 s, 2 min, 1 h 05. */
  function remainingTime(seconds) {
    const s = Math.round(seconds);
    if (s < 60) return s + " s";
    const m = Math.floor(s / 60);
    const rest = Math.round(s % 60);
    if (m < 60) return rest >= 30 ? m + " min " + rest + " s" : m + " min";
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return h + " h" + (mm ? " " + String(mm).padStart(2, "0") : "");
  }

  function statusCopy(payload) {
    const code = payload && payload.code || "";
    if (code === "forge_offline" || (payload && payload.forge === "offline")) {
      return "Forge n'est pas démarré. Ouvrez-le avec le lanceur API de ce compte. Le lanceur habituel ne l'active pas.";
    }
    if (code === "api_disabled" || (payload && payload.forge === "api_disabled")) {
      return "Forge est ouvert, mais son API n'est pas activée.";
    }
    if (code === "forge_busy" || (payload && payload.forge === "busy")) {
      // The sticky bar already says why Générer is disabled; this line keeps the facts
      // the bar cannot show: the loaded model, and how far the running render has gone.
      const parts = [];
      const ratio = payload && typeof payload.progress === "number" ? payload.progress : null;
      if (ratio !== null) {
        const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
        const eta = payload && typeof payload.eta === "number" && payload.eta > 0 ? remainingTime(payload.eta) : "";
        // The bar carries the number, so the text does not repeat it: it keeps the words,
        // and the one figure the bar cannot show, the remaining time.
        if (pct > 0) {
          const near = nearFinish(pct, payload);
          // At the very end "almost done" is the useful line even if the figure is holding still
          // (Forge reports 100 % while it writes the image); earlier, a figure that does not move
          // is the fact worth stating, and the ETA no longer says anything true.
          const still = near ? 0 : stillFor();
          const head = still ? "Rendu au point mort" : near ? "Rendu presque terminé" : "Rendu en cours";
          const tail = still ? "même étape depuis " + still + " s." : eta ? "encore " + eta + "." : "";
          parts.push(tail ? head + " \u00b7 " + tail : head + ".");
        } else parts.push("Rendu en file d'attente.");
      }
      // Progress first: it is the value that moves, and a long filename then wraps
      // onto the second line instead of orphaning the percentage.
      if (payload && payload.model) parts.push("Modèle actif dans Forge : " + payload.model + ".");
      return parts.join(" ") || "Forge est en ligne.";
    }
    const model = payload && payload.model ? " Modèle actif dans Forge : " + payload.model + "." : "";
    return ((payload && payload.message) || "Forge est indisponible.") + model;
  }

  /* Declared before setStatus runs: the status handler may fire during boot. */
  let busyTimer = 0, nearDone = false;
  let pollMoved = null, stallRun = 0;            // did the last poll's percentage move? how long has it sat still?
  let stillSince = 0;                            // when the percentage last changed (0 = not measured)
  const STALL_SEC = 12;                          // a figure that has not moved this long is worth naming
  let etaTimer = 0, etaStart = 0, etaLeft = 0, lastPayload = null;
  let barAt = 0, barValue = 0, barRate = 0;      // last poll: the fraction, when it came, and the slope it implied

  /* Progress and remaining time only arrive with the status poll, so both run on locally in
     between: the figure falls like a clock and the bar creeps instead of jumping. */
  function stopEta() {
    if (etaTimer) { window.clearInterval(etaTimer); etaTimer = 0; }
    etaLeft = 0; barAt = 0; barRate = 0; barValue = 0;
  }
  /* How long the figure has sat on the same value, in seconds; 0 while it moves or before it has
     been still long enough to be worth a word. */
  function stillFor() {
    if (forgeState !== "busy" || !stillSince) return 0;
    const secs = Math.floor((performance.now() - stillSince) / 1000);
    return secs >= STALL_SEC ? secs : 0;
  }
  function markStall() { statusEl.dataset.stall = !nearDone && stillFor() ? "1" : "0"; }

  function tickLive() {
    if (!lastPayload || document.hidden) return;
    if (etaLeft) {
      // Held at one second when spent, until the poll confirms: dropping the figure made it
      // blink in and out every six seconds when Forge kept reporting a small estimate.
      const left = etaLeft - (performance.now() - etaStart) / 1000;
      statusEl.textContent = statusCopy({ ...lastPayload, eta: Math.max(1, left) });
    } else if (stillFor()) {
      statusEl.textContent = statusCopy(lastPayload);       // the stall counter climbs once a second
    }
    markStall();
    if (barAt) {
      const shown = Math.min(1, barValue + barRate * (performance.now() - barAt) / 1000);
      statusEl.style.setProperty("--forge-status-p", shown.toFixed(4));
    }
  }
  function startLive(seconds) {
    etaLeft = seconds || 0;
    etaStart = performance.now();
    if (!etaTimer) etaTimer = window.setInterval(tickLive, 1000);
  }

  function setStatus(payload) {
    const previousState = forgeState;
    forgeState = payload && payload.forge || "error";
    statusEl.dataset.state = forgeState === "loading" ? "busy" : forgeState;
    statusEl.textContent = statusCopy(payload);
    // The bar is the live signal; a 6 s refresh of the same state should not re-announce
    // the whole line at assistive tech, only a real state change should.
    statusEl.setAttribute("aria-live", previousState === forgeState ? "off" : "polite");
    const ratio = payload && typeof payload.progress === "number" ? Math.max(0, Math.min(1, payload.progress)) : null;
    const eta = payload && typeof payload.eta === "number" && payload.eta > 0 ? payload.eta : 0;
    const now = performance.now();
    if (ratio === null) {
      statusEl.style.removeProperty("--forge-status-p");
      barAt = 0; barRate = 0; barValue = 0;
      pollMoved = null; stallRun = 0; stillSince = 0;
    } else {
      if (barAt) {
        // Slope between the last two polls; a stalled render holds the bar still, and a poll
        // that goes backwards only stops the creep (it never invents motion).
        const dt = (now - barAt) / 1000;
        const moved = ratio - barValue;
        pollMoved = moved > 0.001;               // the poll's pace follows this: moving or stalled
        if (moved > 0.001) stillSince = now;     // the figure moved: the stall clock starts over
        if (moved <= 0.001) barRate = 0;
        else if (dt >= 1) barRate = Math.min(moved / dt, 0.5);
      } else {
        barRate = 0;                             // nothing measured yet: the bar waits for a second poll
        pollMoved = null;
        stillSince = now;
      }
      barValue = ratio;
      barAt = now;
      statusEl.style.setProperty("--forge-status-p", String(ratio));
    }
    lastPayload = payload || null;
    nearDone = forgeState === "busy" && ratio !== null && nearFinish(Math.round(ratio * 100), payload);
    if (forgeState === "busy" && (eta || ratio !== null)) startLive(eta); else stopEta();
    syncPower();
    syncActions();
    watchBusy();
    // The owner's own render just landed: bring it in now, without a manual reload.
    // Written again now that this poll has updated the movement clock: the line drawn at the top
    // still knew the previous value and could call a render stalled one poll after it moved.
    statusEl.textContent = statusCopy(payload);
    markStall();
    if (previousState === "busy" && forgeState === "ready") absorbForeignResult().catch(() => {});
  }

  /* While someone else's render runs, the status line reports its percentage, so it has
     to be refreshed. Only polls on a visible Forge tab, only while Forge is busy, and the
     catalog comes from the server's 60 s cache. */
  const POLL_BASE = 6000, POLL_MOVING = 3000, POLL_NEAR = 2000, POLL_STALL_MAX = 12000;
  function watchBusy() {
    window.clearTimeout(busyTimer);
    busyTimer = 0;
    if (forgeState !== "busy") { stopEta(); pollMoved = null; stallRun = 0; stillSince = 0; return; }
    // The percentage is the only sign of the render's pace: keep up while it climbs, wait longer
    // while it sits on the same figure (a model load or a stuck step), but never past 12 s so a
    // render that ends without a last tick is still noticed promptly. Near the end it can land at
    // any second, and that beat wins over everything. Each refresh reschedules through setStatus.
    let delay = POLL_BASE;
    if (nearDone) delay = POLL_NEAR;
    else if (pollMoved === true) { stallRun = 0; delay = POLL_MOVING; }
    else if (pollMoved === false) { stallRun += 1; delay = Math.min(POLL_BASE * (1 << stallRun), POLL_STALL_MAX); }
    busyTimer = window.setTimeout(function () {
      busyTimer = 0;
      if (document.hidden) { watchBusy(); return; }
      refreshStatus().catch(() => {}).then(() => { if (forgeState === "busy" && !busyTimer) watchBusy(); });
    }, delay);
  }

  // Start / stop WebForge on this PC through the Engine routes (admin only).
  const powerBtn = $("forge-power");
  let powerBusy = false;
  function syncPower() {
    if (!powerBtn || powerBusy) return;
    powerBtn.hidden = false;
    powerBtn.dataset.action = forgeState === "offline" ? "start" : "stop";
    powerBtn.textContent = forgeState === "offline" ? "Démarrer WebForge" : "Arrêter WebForge";
  }
  if (powerBtn) {
    powerBtn.addEventListener("click", async () => {
      const action = powerBtn.dataset.action === "start" ? "start" : "stop";
      if (action === "stop" && !window.confirm("Arrêter WebForge sur ce PC ?")) return;
      powerBusy = true;
      powerBtn.disabled = true;
      powerBtn.textContent = action === "start" ? "Démarrage…" : "Arrêt…";
      try {
        const res = await fetch("/api/engine/daemons/forge/" + action, { method: "POST", credentials: "same-origin" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) statusEl.textContent = data.message || data.error || "Action impossible.";
      } catch (_) {
        statusEl.textContent = "Action impossible.";
      }
      powerBusy = false;
      powerBtn.disabled = false;
      syncPower();
      // Forge takes a while to load: poll status for a minute after a start.
      let tries = 0;
      const timer = setInterval(() => {
        refreshStatus(true).catch(() => {});
        if (++tries >= 30 || (action === "start" ? forgeState !== "offline" : forgeState === "offline")) clearInterval(timer);
      }, 2000);
    });
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
    active = !!active || !!(generationAttempt && !generationAttempt.retry && submitGuard);
    const privateMode = destination() === "private";
    generateBtn.hidden = privateMode;
    privateBtn.hidden = !privateMode;
    const hiresPrivate = hiresOn() && privateMode;
    const hiresMissing = hiresOn() && !$("forge-hr-upscaler").value;
    const hiresLarge = hiresOn() && !hiresFits();
    // B: a busy Forge (someone else's work) does not block a normal job; HQ waits politely.
    const forgeOk = forgeState === "ready" || (forgeState === "busy" && !privateMode);
    /* A full gallery fails only when the finished image is saved, after the GPU work.
       Refuse before dispatch and say how many slots are left. */
    const remaining = galleryUsage && galleryUsage.quota_images
      ? Math.max(0, Number(galleryUsage.quota_images) - Number(galleryUsage.images || 0)) : Infinity;
    const wanted = galleryUsage ? Number((fleetMode() ? $("forge-fleet-count") : $("forge-iter")).value || 1) : 1;
    const quotaFull = !privateMode && galleryFull;
    const quotaShort = !privateMode && !quotaFull && Number.isFinite(remaining) && wanted > remaining;
    const ready = !active && !hiresPrivate && !hiresMissing && !hiresLarge && !quotaFull && !quotaShort && forgeOk && catalogState === "ready" && checkpointEl.value && samplerEl.value && schedulerEl.value;
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
      else if (quotaFull) reasonEl.textContent = "Générer est désactivé : la galerie est pleine. Supprime des images (la Corbeille libère leur place) ou sauvegarde-la.";
      else if (quotaShort) reasonEl.textContent = "Générer est désactivé : " + remaining + " place(s) restante(s) pour " + wanted + " image(s). Réduis le nombre ou libère de la place.";
      else if (hiresPrivate) reasonEl.textContent = "Générer est désactivé : Hires. fix n'est pas disponible en génération privée.";
      else if (hiresMissing) reasonEl.textContent = "Générer est désactivé : l'agrandisseur n'est pas disponible.";
      else if (hiresLarge) reasonEl.textContent = "Générer est désactivé : le second passage dépasserait 2048 pixels.";
      // Busy does not disable Générer in normal mode: HQ queues the job. The line
      // says what HQ will do, not that the button is off.
      else if (forgeState === "busy") reasonEl.textContent = "Forge est occup\u00e9 : HQ attendra la fin de son travail.";
      else reasonEl.textContent = "";
    }
    $("forge-normal-results").hidden = privateMode;
    $("forge-normal-gallery").hidden = privateMode;
    studio.classList.toggle("forge-private", privateMode);
    const shownDestination = jobDestinationMode || destination();
    const destinationLabel = shownDestination === "private" ? "Destination · Coffre privé" : "Destination · Galerie";
    if (jobDestination.textContent !== destinationLabel) jobDestination.textContent = destinationLabel;
    retryJob.hidden = !generationAttempt?.retry || generationAttempt.destination !== destination() || (fleetBooted && fleetMode());
    retryJob.disabled = active || !forgeOk || catalogState !== "ready" || (privateMode
      && (!vaultState.private_generation || !vaultState.unlocked || generationAttempt?.settings.vault !== openVid || privateTarget !== openVid));
    if (fleetBooted) fleetSync(active);
  }

  let forgeUnreachable = false;

  // Concurrent callers (e.g. the two chains in hqForgeShow) share one in-flight refresh,
  // so opening the studio reads status and catalog once and nothing overwrites the result.
  let statusInFlight = null;
  function refreshStatus(fresh = false) {
    if (fresh) return readStatus(true);  // the "start Forge" poll must not read a cached verdict
    if (!statusInFlight) {
      statusInFlight = readStatus().finally(() => { statusInFlight = null; });
    }
    return statusInFlight;
  }

  async function readStatus(fresh = false) {
    const first = catalogState === "offline" && forgeState === "offline" && !checkpointEl.options.length;
    if (first) {
      statusEl.dataset.state = "busy";
      statusEl.textContent = "Connexion à Forge…";
    }
    try {
      // Two probes, one wait: serially they cost the offline verdict twice before anything paints.
      const [status, catalog] = await Promise.all([
        api("/api/forge/status" + (fresh ? "?fresh=1" : "")),
        api("/api/forge/catalog" + (fresh ? "?fresh=1" : "")),
      ]);
      forgeUnreachable = false;
      catalogState = catalog && catalog.forge === "ready" ? "ready" : (catalog && catalog.code) || "error";
      setStatus(status);
      if (catalog && catalog.forge === "ready") {
        const activeModel = status && typeof status.model === "string" ? status.model.trim() : "";
        const activeBase = activeModel.split(" [")[0];
        const matchedModel = activeModel && Array.isArray(catalog.models)
          ? (catalog.models.find((m) => m && m.title && (m.title === activeModel || m.model_name === activeModel || m.title.split(" [")[0] === activeBase)) || {}).title || ""
          : "";
        const staleModel = fillSelect(checkpointEl, catalog.models || [], (item) => item.title ? { value: item.title, label: item.title } : null, matchedModel);
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


  /* A card now says what it is: model, steps, size, and for search results the
     prompt. Before, only the aria-label carried any of it. */


  async function privateThumb(id) {
    const response = await fetch(vaultBase() + "/images/" + id + "/thumb", { credentials: "same-origin", cache: "no-store" });
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
    clearDeleteForm();
    clearDeepCheck();
  }

  /* Galerie: the quota is fixed (400 images, 2 GiB) and the bin counts too, so the
     header states it instead of letting a full gallery fail a generation later. */
  function bytesLabel(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1073741824) return (Math.round(value / 107374182.4) / 10).toFixed(1).replace(".", ",") + " Go";
    return (value <= 0 ? 0 : Math.max(1, Math.round(value / 1048576))) + " Mo";
  }
  let galleryUsage = null;
  let galleryFull = false;
  function renderUsage(usage) {
    const box = $("forge-gallery-usage");
    if (!box) return;
    if (!usage || !usage.quota_images) { galleryUsage = null; galleryFull = false; box.textContent = ""; box.removeAttribute("data-near"); return; }
    galleryUsage = usage;
    const images = Number(usage.images) || 0;
    const share = Math.min(100, Math.round((100 * images) / usage.quota_images));
    const byteShare = usage.quota_bytes ? (Number(usage.bytes) || 0) / usage.quota_bytes : 0;
    box.textContent = images + " / " + usage.quota_images + " images \u00b7 " + bytesLabel(usage.bytes) +
      " / " + bytesLabel(usage.quota_bytes) + " \u00b7 " + share + " % de la place" +
      (images >= usage.quota_images || byteShare >= 1 ? " \u00b7 galerie pleine : supprime ou sauvegarde" : "");
    box.dataset.near = String(share >= 90 || byteShare >= 0.9);
    galleryFull = images >= Number(usage.quota_images) || byteShare >= 1;
    /* The backup limit is stated here, before the owner asks for a ZIP: the archive is
       bounded by free disk space, not by a fixed size that a full gallery cannot meet.
       The last full backup and the images created since answer the other question: is
       this archive recent enough to trust? */
    const backup = $("forge-gallery-backup-limit");
    if (!backup) return;
    if (usage.export_images == null) { backup.textContent = ""; return; }
    if (!usage.export_images) { backup.textContent = "Sauvegarde : la galerie est vide."; return; }
    const fits = Number(usage.export_bytes) <= Number(usage.export_limit_bytes);
    let line = "Sauvegarde : " + usage.export_images + " image(s) \u00b7 \u2248 " + bytesLabel(usage.export_bytes) +
      " \u00b7 limite " + bytesLabel(usage.export_limit_bytes) + " d\u2019espace libre" +
      (fits ? "" : " \u00b7 insuffisant : supprime des images (la Corbeille lib\u00e8re leur place)");
    const status = usage.backup || null;
    const stamp = status && status.at ? Date.parse(status.at) : NaN;
    if (!Number.isNaN(stamp)) {
      const days = Math.max(0, Math.floor((Date.now() - stamp) / 86400000));
      const when = days === 0 ? "aujourd\u2019hui" : days === 1 ? "hier" : "il y a " + days + " jours";
      const since = Number(status.since_images) || 0;
      line += " \u00b7 derni\u00e8re sauvegarde " + when + (since ? " \u00b7 " + since + " image(s) depuis" : " \u00b7 \u00e0 jour");
    } else {
      line += " \u00b7 aucune sauvegarde encore";
    }
    backup.textContent = line;
    backup.dataset.near = String(!fits);
  }

  async function loadGallery(reset) {
    if (!galleryUi) await ensureGalleryUi();
    if (reset) {
      cursor = null;
      gallery.replaceChildren();
      historyLoaded = false;
    }
    const path = "/api/forge/gallery?limit=24" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const page = await api(path);
    renderUsage(page.usage);
    (page.images || []).forEach((image) => { const node = card(image); if (node) gallery.appendChild(node); });
    const galleryEmpty = $("forge-gallery-empty");
    if (galleryEmpty) galleryEmpty.hidden = gallery.children.length > 0;
    cursor = page.next_cursor || null;
    moreBtn.hidden = !cursor;
  }

  /* A render started in Forge's own window just finished: pull the new image in now, the way our
     own jobs do when their poll completes. Skipped on a filtered list (it would be replaced) and
     while one of HQ's jobs is already handling its own reveal. */
  async function absorbForeignResult() {
    if (document.body.dataset.view !== "forge" || gallerySearching) return;
    if (sessionStorage.getItem("hqForgeJob")) return;
    const before = gallery.firstElementChild ? gallery.firstElementChild.dataset.id : "";
    await loadGallery(true);                        // the first page is the newest
    const first = gallery.firstElementChild;
    if (first && first.dataset.id && first.dataset.id !== before) landResult(first, false);
  }

  /* --- Galerie: the one browsing surface -----------------------------------
     Search and the triage views live here now. The Bibliothèque dialog is kept
     as the advanced filter sheet, reached from "Recherche avancée". */
  let galleryView = "";
  let galleryOffset = 0;
  let gallerySearching = false;


  async function searchGallery(reset) {
    const field = $("forge-gallery-q");
    const needle = field ? field.value.trim() : "";
    const count = $("forge-gallery-count");
    const clear = $("forge-gallery-clear");
    if (!needle && !galleryView) {
      gallerySearching = false;
      cursor = null;
      if (count) count.textContent = "";
      if (clear) clear.hidden = true;
      await loadGallery(true);
      moreBtn.hidden = !cursor;
      return;
    }
    gallerySearching = true;
    if (reset) galleryOffset = 0;
    const params = new URLSearchParams();
    params.set("limit", "24");
    params.set("offset", String(galleryOffset));
    if (needle) params.set("q", needle);
    if (galleryView) params.set("view", galleryView);
    const out = await api("/api/forge/library?" + params.toString());
    const rows = Array.isArray(out.images) ? out.images : [];
    galleryRows(rows, reset);
    const total = out.total == null ? rows.length : Number(out.total);
    if (count) {
      count.textContent = rows.length + " / " + total + " image(s)" +
        (needle ? " pour « " + needle + " »" : galleryView === "untriaged" ? " à trier" : "");
    }
    galleryOffset = out.next_offset == null ? 0 : Number(out.next_offset);
    moreBtn.hidden = out.next_offset == null;
    if (clear) clear.hidden = false;
  }

  /* F4: Forge's own estimate, already sanitized by HQ (finite, 0 < s <= 3600). */
  function etaCopy(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) return "";
    if (seconds < 90) return "\u2248 " + Math.max(1, Math.round(seconds)) + " s restantes";
    return "\u2248 " + Math.round(seconds / 60) + " min restantes";
  }

  /* A job's progress must never go backwards: a late or reordered poll would make the bar
     jump back. A new job id starts a fresh measurement. Unknown/queued progress stays
     indeterminate instead of showing a misleading 0 %. */
  let progressJob = "";
  let progressValue = 0;
  let progressStep = 0;
  let progressSteps = 0;
  let progressEta = null;
  function progressFraction(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    return Math.min(1, number);
  }
  function jobStage(job) {
    if (job.waiting) return "En attente de Forge";
    return { queued: "En file", starting: "D\u00e9marrage", generating: "G\u00e9n\u00e9ration", saving: "Enregistrement" }[job.state] || "Travail en cours";
  }
  function syncJobProgress(job, active) {
    const id = String(job.job_id || "");
    if (id !== progressJob) {
      progressJob = id;
      progressValue = 0;
      progressStep = 0;
      progressSteps = 0;
      progressEta = null;
    }
    const raw = progressFraction(job.progress);
    const stale = !!job.progress_stale;
    const waiting = !!job.waiting || job.state === "queued" || job.state === "starting";
    const known = !!active && raw !== null && !stale && (!waiting || raw > 0);
    if (known && raw > progressValue) {
      progressValue = raw;
      progressStep = Number(job.step || 0);
      progressSteps = Number(job.steps || 0);
      progressEta = job.eta;
    } else if (known) {
      progressValue = Math.max(progressValue, raw);
      if (raw === progressValue) progressEta = job.eta;
      if (!progressSteps) {
        progressStep = Number(job.step || 0);
        progressSteps = Number(job.steps || 0);
      }
    }
    const parts = [String(job.message || "").trim() || jobStage(job)];
    if (known) {
      parts.push(Math.round(progressValue * 100) + " %");
      if (progressSteps) parts.push("pas " + progressStep + " / " + progressSteps);
      const eta = etaCopy(progressEta);
      if (eta) parts.push(eta);
      progressBar.max = 1;
      progressBar.value = progressValue;
      progressBar.removeAttribute("data-indeterminate");
    } else {
      if (stale) parts.push("progression indisponible");
      else if (active) parts.push("en attente de progression");
      progressBar.removeAttribute("value");
      progressBar.setAttribute("data-indeterminate", "1");
    }
    progressBox.dataset.stage = job.state || "";
    progressLabel.textContent = parts.join(" \u00b7 ");
    progressBar.setAttribute("aria-valuetext", progressLabel.textContent);
  }
  function shortModel(text) {
    const clean = String(text || "").replace(/\s*\[[^\]]*\]\s*$/, "").replace(/\.safetensors$/i, "").trim();
    return clean.length > 28 ? clean.slice(0, 27) + "\u2026" : clean;
  }
  function updateSettingsSummary() {
    if (!settingsSummary) return;
    const bits = [];
    const width = Number($("forge-width").value);
    const height = Number($("forge-height").value);
    if (width > 0 && height > 0) bits.push(width + " \u00d7 " + height);
    const steps = Number($("forge-steps").value);
    if (steps > 0) bits.push(steps + " pas");
    const count = Math.max(1, Number($("forge-iter").value) || 1);
    bits.push(count > 1 ? count + " images" : "1 image");
    if ($("forge-hr").checked) {
      bits.push("Hires. fix \u00d7" + String($("forge-hr-scale").value).replace(".", ","));
    }
    const model = checkpointEl.selectedOptions && checkpointEl.selectedOptions[0];
    if (model && model.value) bits.push(shortModel(model.textContent));
    /* No "Réglages · " prefix: on the phone the tray's own Réglages button sits
       directly above this line, so the word used to appear twice. */
    const text = bits.length ? bits.join(" \u00b7 ") : "en cours de chargement\u2026";
    if (settingsSummary.textContent !== text) {
      settingsSummary.textContent = text;
      settingsSummary.title = text;
    }
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

  function syncProgressSegments(tasks, total, running) {
    const count = Math.max(0, Number(total) || 0);
    const segmented = !!running && count > 1;
    progressBox.classList.toggle("has-segments", segmented);
    progressSegments.hidden = !segmented;
    if (segmented) progressBar.setAttribute("aria-hidden", "true");
    else progressBar.removeAttribute("aria-hidden");
    if (!segmented) {
      if (progressSegments.childElementCount) progressSegments.replaceChildren();
      return;
    }
    if (progressSegments.childElementCount !== count) {
      progressSegments.replaceChildren(...Array.from({ length: count }, () => {
        const segment = document.createElement("span");
        segment.className = "forge-progress-segment";
        return segment;
      }));
    }
    const rows = Array.isArray(tasks) ? tasks : [];
    let finished = 0;
    [...progressSegments.children].forEach((segment, index) => {
      const state = String((rows[index] && rows[index].state) || "queued");
      segment.dataset.state = state;
      if (["completed", "failed", "uncertain", "cancelled"].includes(state)) finished += 1;
    });
    progressSegments.setAttribute("aria-valuemax", String(count));
    progressSegments.setAttribute("aria-valuenow", String(finished));
    progressSegments.setAttribute("aria-valuetext", finished + " sur " + count + " terminées");
  }

  function setForgeAura(active) {
    const bar = $("forge-actionbar");
    if (bar) bar.classList.toggle("is-forging", !!active);
  }

  function showJob(job) {
    const active = job && ["queued", "starting", "generating", "saving"].includes(job.state);
    const failed = job?.state === "failed";
    if (generationAttempt && generationAttempt.jobId === job?.job_id) {
      generationAttempt.retry = failed ? "new" : "";
      if (!active && !failed) generationAttempt = null;
    }
    jobDestinationMode = active || failed || job?.state === "unknown" ? (job.destination || "normal") : "";
    setWake("job", active);
    cancelBtn.disabled = !active || job.cancel === "deferred";
    $("forge-wait").hidden = !(job && job.waiting);
    $("forge-start-now").disabled = false;
    progressBox.hidden = !active && !failed && job?.state !== "unknown";
    progressBox.classList.toggle("is-error", failed);
    progressBar.hidden = failed;
    progressBox.classList.toggle("is-live", !!active);
    if (progressBar) progressBar.classList.toggle("is-live", !!active);
    syncProgressSegments([], 0, false);
    setForgeAura(!!active);
    if (job) {
      syncJobProgress(job, active);
      if (job.destination === "private") {
        if (job.state === "completed" && vaultState.unlocked) {
          const submitted = justSubmitted;
          const ids = (job.images || []).map((image) => String(image && image.id || "")).filter(Boolean);
          refreshVault().then(() => {
            if (destination() !== "private") return;
            const node = [...vaultGallery.children].find((n) => ids.includes(n.dataset.id)) || vaultGallery.firstElementChild;
            landResult(node, submitted);
          }).catch(() => {});
        }
      } else if (job.images && job.images.length) {
        const signature = job.images.map((image) => String(image && image.id || "")).join(",");
        if (results.dataset.jobReveal !== signature) {
          results.replaceChildren();
          job.images.forEach((image, index) => {
            const node = card({ id: image.id, thumb: "/api/forge/gallery/" + image.id + "/thumb" });
            results.appendChild(node);
            landResult(node, index === 0 ? justSubmitted : false, index * 50);
          });
          results.dataset.jobReveal = signature;
        }
        const resultsEmpty = $("forge-results-empty");
        if (resultsEmpty) resultsEmpty.hidden = true;
      }
    }
    syncActions(active);
    if (window.hqForgeOnJob) window.hqForgeOnJob(job);
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
        landResult(results.firstElementChild);
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
    /* readOnly, not disabled: a disabled field cannot be focused, so a keyboard
       user could not even read the seed that will be reused. */
    const seedField = $("forge-seed");
    seedField.readOnly = seedMode() !== "fixed";
    seedField.setAttribute("aria-disabled", seedField.readOnly ? "true" : "false");
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
    updateSettingsSummary();
  }

  function applyHires(settings) {
    $("forge-hr").checked = !!(settings && settings.enable_hr);
    if (settings && settings.hr_scale) $("forge-hr-scale").value = String(settings.hr_scale);
    if (settings && settings.hr_second_pass_steps != null) $("forge-hr-steps").value = String(settings.hr_second_pass_steps);
    if (settings && settings.denoising_strength != null) $("forge-hr-denoise").value = String(settings.denoising_strength);
    syncRanges();
    syncHiresNote();
  }

  async function submitGeneration(attempt) {
    generationAttempt = attempt;
    attempt.retry = "";
    submitGuard = true;
    jobDestinationMode = attempt.destination;
    syncActions(true);
    progressBox.hidden = false;
    progressBox.classList.remove("is-error", "is-live");
    progressBar.hidden = false;
    progressBar.removeAttribute("value");
    progressLabel.textContent = attempt.destination === "private" ? "Envoi privé…" : "Envoi…";
    function accept(job) {
      attempt.jobId = job.job_id;
      if (window.hqForgeWipeDraft) window.hqForgeWipeDraft();
      showJob(job);
    }
    try {
      const payload = await api("/api/forge/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.key },
        body: JSON.stringify(attempt.settings)
      });
      accept(payload.job);
    } catch (error) {
      if (error && error.status === 409 && error.data && error.data.active_job_id) {
        generationAttempt = null;
        sessionStorage.setItem("hqForgeJob", error.data.active_job_id);
        poll(error.data.active_job_id);
        return;
      }
      try {
        const existing = await api("/api/forge/jobs?idempotency_key=" + encodeURIComponent(attempt.key));
        accept(existing.job);
        return;
      } catch (_) { /* the POST itself failed */ }
      if (generationAttempt === attempt) attempt.retry = "same";
      // A lost response can hide an accepted job. Retrying with this key lets HQ deduplicate it.
      progressBox.classList.add("is-error");
      progressBar.hidden = true;
      progressLabel.textContent = error.message || "La génération n'a pas pu démarrer.";
      submitGuard = false;
      syncActions(false);
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitGuard || generateBtn.disabled) return;
    submitGeneration({ key: key(), destination: "normal", settings: Object.assign(settingsFromForm(), { wait_if_busy: true }) });
  });

  async function privateGenerate() {
    if (!vaultState.unlocked || !openVid || privateTarget !== openVid) {
      // Never a silent choice: the owner names the destination, and a locked one is opened first.
      const wanted = $("forge-private-target").value;
      if (vaultListing.layout === "legacy") {
        migrateStatus("Déplace d'abord ton coffre : ensuite tu choisiras le coffre qui reçoit les images.");
        $("forge-migrate").scrollIntoView({ block: "nearest" });
      } else if (wanted && wanted !== openVid) {
        openSheet(wanted);
        $("forge-vault-error").textContent = "Ouvre ce coffre avant une génération privée.";
      } else {
        $("forge-private-target-note").textContent = "Choisis d'abord le coffre de destination.";
        destSheetOpen = true;
        syncDest();
        $("forge-private-target").focus();
      }
      return;
    }
    if (!vaultState.private_generation || privateBtn.disabled) return;
    if (submitGuard) return;
    // The finished vault image is centered and revealed like a normal one (nothing is stored for it).
    justSubmitted = true; revealCentered = false; celebrateSubmit = houseInUse();
    resultIntent = false;
    hideSeeResult();
    await submitGeneration({ key: key(), destination: "private", settings: Object.assign(settingsFromForm(), { destination: "private", vault: privateTarget }) });
  }

  retryJob.addEventListener("click", () => {
    if (submitGuard || retryJob.hidden || retryJob.disabled || !generationAttempt) return;
    const attempt = generationAttempt;
    justSubmitted = true; revealCentered = false; celebrateSubmit = houseInUse();
    resultIntent = false;
    hideSeeResult();
    submitGeneration({ key: attempt.retry === "new" ? freshKey() : attempt.key, destination: attempt.destination, settings: attempt.settings });
  });

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
  /* Reversible by default: rejected images wait in the Corbeille, where they can be
     put back or deleted for good (with a confirmation, from the bin itself). */
  deleteBtn.addEventListener("click", async () => {
    if (!currentDetail) return;
    try {
      await api("/api/forge/library/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [currentDetail.id], state: "reject" }) });
      closeViewer();
      toast("Image déplacée dans la corbeille. Rien n'est effacé : la Corbeille permet de la remettre.");
      loadGallery(true).catch(() => {});
    } catch (error) {
      toast(error.message || "Cette image n'a pas pu être déplacée.", "error");
    }
  });
  moreBtn.addEventListener("click", () => (gallerySearching ? searchGallery(false) : loadGallery(false)).catch((error) => { statusEl.textContent = error.message; }));

  const galleryForm = $("forge-gallery-search");
  if (galleryForm) {
    galleryForm.addEventListener("submit", (event) => {
      event.preventDefault();
      searchGallery(true).catch((error) => toast(error.message || "La recherche a échoué.", "error"));
    });
  }
  const galleryClear = $("forge-gallery-clear");
  if (galleryClear) galleryClear.addEventListener("click", () => {
    const field = $("forge-gallery-q");
    if (field) field.value = "";
    galleryView = "";
    document.querySelectorAll("#forge-gallery-filters [data-gview]").forEach((chip) => chip.setAttribute("aria-pressed", chip.dataset.gview === "" ? "true" : "false"));
    searchGallery(true).catch((error) => toast(error.message || "La recherche a échoué.", "error"));
  });
  document.querySelectorAll("#forge-gallery-filters [data-gview]").forEach((chip) => {
    chip.addEventListener("click", () => {
      galleryView = chip.dataset.gview || "";
      document.querySelectorAll("#forge-gallery-filters [data-gview]").forEach((item) => item.setAttribute("aria-pressed", item === chip ? "true" : "false"));
      searchGallery(true).catch((error) => toast(error.message || "La recherche a échoué.", "error"));
    });
  });
  const galleryAdvanced = $("forge-gallery-advanced");
  if (galleryAdvanced) galleryAdvanced.addEventListener("click", () => {
    if (window.hqForgeStudio && window.hqForgeStudio.openLibrary) window.hqForgeStudio.openLibrary();
  });

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
    if (!anyVaultOpen()) return;
    idleTimer = setTimeout(() => { lockVault().catch(() => {}); }, 5 * 60 * 1000);
  }

  const GLYPHS = {
    coffre: ["▣", "Coffre"], etoile: ["★", "Étoile"], lune: ["☾", "Lune"], soleil: ["☀", "Soleil"],
    feuille: ["❦", "Feuille"], fleur: ["✿", "Fleur"], vague: ["≈", "Vague"], montagne: ["▲", "Montagne"],
    nuage: ["☁", "Nuage"], flamme: ["♨", "Flamme"], coeur: ["♥", "Cœur"], cle: ["⚿", "Clé"],
    /* V5: eight more, drawn as text symbols (no emoji font needed) */
    maison: ["\u2302", "Maison"], ancre: ["\u2693", "Ancre"], diamant: ["\u25c6", "Diamant"], note: ["\u266a", "Note"],
    plume: ["\u2712", "Plume"], cercle: ["\u25cf", "Cercle"], fleche: ["\u27a4", "Fl\u00e8che"], trefle: ["\u2663", "Tr\u00e8fle"]
  };
  const COLOURS = { ardoise: "Ardoise", bleu: "Bleu", sarcelle: "Sarcelle", vert: "Vert", olive: "Olive", ambre: "Ambre", orange: "Orange", rouge: "Rouge", rose: "Rose", violet: "Violet" };
  const quoted = (text) => "« " + text + " »";
  function vaultById(vid) { return (vaultListing.vaults || []).find((v) => v.id === vid) || null; }
  /* The name a vault may show now: a Discret vault has a name only while it is open here. */
  function vaultName(v) { return v ? (v.label || "Coffre n° " + v.number) : ""; }
  /* For messages that outlive the open state (switching, locking): never a Discret name. */
  function vaultSafeName(v) { return v ? (v.discret ? "Coffre n° " + v.number : vaultName(v)) : ""; }
  function vaultsNote(text) { $("forge-vaults-note").textContent = text || ""; }

  let vaultSort = "manuel";  // display only, kept in memory
  let vaultsAll = false;  // "Tous mes coffres" unfolded
  let currentVid = null;  // the card shown on top
  let destSheetOpen = false;  // the destination chooser under the generator chip
  let destOk = false;
  // The vault panel's rendering lives in hq-forge-vault.js, fetched the first time the coffre becomes the
  // destination: a normal visit to the generator never parses it. Core keeps the state, the vault API and
  // the privacy scrub, and hands its live values over through accessors so nothing can go stale.
  let vaultUi = null;
  let vaultUiLoading = null;
  function vaultUiCtx() {
    return {
      $, api, quoted, glyphs: GLYPHS, colours: COLOURS,
      get openVid() { return openVid; },
      get listing() { return vaultListing; },
      get privateTarget() { return privateTarget; },
      get vaultSort() { return vaultSort; },
      set vaultSort(value) { vaultSort = value; },
      get vaultsAll() { return vaultsAll; },
      set vaultsAll(value) { vaultsAll = value; },
      set currentVid(value) { currentVid = value; },
      vaultName: (v) => vaultName(v),
      vaultSafeName: (v) => vaultSafeName(v),
      vaultsNote: (text) => vaultsNote(text),
      vaultById: (vid) => vaultById(vid),
      syncVaultEdit: () => syncVaultEdit(),
      renderTarget: () => renderTarget(),
      openSheet: (vid) => openSheet(vid),
      refreshVault: () => refreshVault()
    };
  }
  function ensureVaultUi() {
    if (vaultUi || vaultUiLoading) return vaultUiLoading;
    vaultUiLoading = new Promise((resolve) => {
      const el = document.createElement("script");
      // Same build stamp as the gallery module: the coffre panel is fetched on the first unlock, and a
      // repeat visit should read it from cache instead of paying a revalidation mid-interaction.
      el.src = "/assets/hq-forge-vault.js" + (window.HQ_ASSET_BUILD ? "?v=" + window.HQ_ASSET_BUILD : "");
      el.async = false;
      el.onload = () => {
        vaultUi = window.hqForgeVault ? window.hqForgeVault.create(vaultUiCtx()) : null;
        resolve(vaultUi);
      };
      el.onerror = () => { el.remove(); vaultUiLoading = null; resolve(null); };
      document.body.appendChild(el);
    }).then((ui) => { if (ui) renderVaults(); return ui; });
    return vaultUiLoading;
  }
  function renderVaults() {
    if (!vaultUi) { ensureVaultUi(); return; }
    vaultUi.renderVaults();
  }
  function dropIcon() {
    if (vaultUi) vaultUi.dropIcon();
  }

  function renderTarget() {
    const select = $("forge-private-target");
    if (privateTarget && privateTarget !== openVid) privateTarget = null;
    select.replaceChildren();
    option(select, "", "Choisir un coffre");
    (vaultListing.vaults || []).forEach((v) => option(select, v.id, vaultName(v) + (v.id === openVid ? " (ouvert)" : " (verrouillé)")));
    select.value = privateTarget || "";
    const chosen = vaultById(privateTarget);
    $("forge-private-target-note").textContent = chosen
      ? "Les images iront dans " + quoted(vaultName(chosen)) + "."
      : "Choisis le coffre qui recevra les images. Un coffre verrouillé s'ouvre d'abord avec sa phrase.";
    $("forge-dest-chip-text").textContent = chosen ? "Coffre : " + quoted(vaultName(chosen)) : "Coffre : \u00e0 choisir";
    syncDest();
  }
  let destShownFor = null;
  function syncDest() {
    // The chooser stays open while nothing is chosen; once a destination is newly chosen it folds into the chip.
    const chosenId = vaultById(privateTarget) ? privateTarget : null;
    if (chosenId && chosenId !== destShownFor) destSheetOpen = false;
    destShownFor = chosenId;
    const open = destOk && (destSheetOpen || !chosenId);
    $("forge-dest-chip-row").hidden = !destOk;
    $("forge-private-target-row").hidden = !open;
    $("forge-dest-chip").setAttribute("aria-expanded", open ? "true" : "false");
  }

  function openSheet(vid) {
    const v = vaultById(vid);
    if (!v) return;
    sheetVid = vid;
    createOpen = false;
    $("forge-vault-setup").hidden = true;
    closeRestore();
    $("forge-vault-unlock-for").textContent = "Ouvrir " + quoted(vaultName(v));
    const other = openVid && openVid !== vid ? vaultById(openVid) : null;
    const switchNote = $("forge-vault-switch-note");
    switchNote.hidden = !other;
    switchNote.textContent = other ? "Ouvrir ce coffre verrouillera " + quoted(vaultSafeName(other)) + ". Un seul coffre est ouvert à la fois." : "";
    $("forge-vault-error").textContent = "";
    $("forge-vault-unlock").hidden = false;
    $("forge-vault-pass").focus();
  }

  function closeSheet() {
    sheetVid = null;
    $("forge-vault-pass").value = "";
    $("forge-vault-error").textContent = "";
    $("forge-vault-unlock-for").textContent = "";
    $("forge-vault-switch-note").textContent = "";
    $("forge-vault-unlock").hidden = true;
  }

  function scrubVaultViews() {
    clearPrivateUi();
    dropIcon();
    if (window.hqForgeScrubPrivate) window.hqForgeScrubPrivate();
  }

  /* After a lock: forget every open-only detail at once, before any request returns. */
  function forgetOpenVault() {
    if (generationAttempt?.destination === "private") {
      generationAttempt = null;
      retryJob.hidden = true;
    }
    dropIcon();
    openVid = null;
    privateTarget = null;
    vaultState = Object.assign({}, vaultState, { unlocked: false });
    vaultListing = Object.assign({}, vaultListing, {
      open: null,
      vaults: (vaultListing.vaults || []).map((v) => Object.assign({}, v, { label: v.discret ? null : v.label }))
    });
    renderVaults();
  }

  function migrateStatus(text) { $("forge-migrate-status").textContent = text || ""; }
  function dropOffer(message) {
    if (migrateOffer && message) migrateStatus(message);
    migrateOffer = 0;
    clearTimeout(migrateTimer);
    migrateTimer = 0;
    $("forge-migrate-ack").checked = false;
  }
  function syncMigration() {
    $("forge-migrate-unlock").hidden = legacyOpen || migrating;
    $("forge-migrate-offer").hidden = !legacyOpen || migrating;
    $("forge-migrate-confirm").hidden = !legacyOpen || !migrateOffer || migrating;
    $("forge-migrate-lock").hidden = !legacyOpen || migrating;
    $("forge-migrate-go").disabled = migrating || !migrateOffer || !$("forge-migrate-ack").checked;
  }
  async function refreshMigration(privateMode) {
    if (vaultListing.layout !== "legacy") {
      $("forge-migrate").hidden = true;
      legacyOpen = false;
      dropOffer();
      return;
    }
    $("forge-migrate").hidden = !privateMode;
    let info = { unlocked: false };
    try { info = await api("/api/forge/vaults/migration"); } catch (_error) { info = { unlocked: false }; }
    legacyOpen = !!info.unlocked;
    if (!legacyOpen) dropOffer("Le coffre s'est verrouillé : l'offre de sauvegarde est annulée. Rouvre-le et télécharge à nouveau la sauvegarde.");
    syncMigration();
  }
  function offerSeen(message) {
    migrateOffer = Date.now();
    clearTimeout(migrateTimer);
    migrateTimer = setTimeout(() => {
      dropOffer("Plus de 15 minutes ont passé : l'offre de sauvegarde a expiré. Télécharge à nouveau la sauvegarde.");
      syncMigration();
    }, OFFER_MS);
    migrateStatus(message);
    syncMigration();
  }

  // Fix: refreshes overlap when the destination is toggled quickly. Only the newest one may write the
  // page, otherwise a late "normal" refresh hides the vault tools while "private" is selected.
  let vaultRefreshGen = 0;
  async function refreshVault() {
    const gen = ++vaultRefreshGen;
    const stale = () => gen !== vaultRefreshGen;
    const privateMode = destination() === "private";
    vaultBox.hidden = !privateMode;
    let listing;
    try {
      listing = await api("/api/forge/vaults");
    } catch (error) {
      listing = { layout: "unreadable", vaults: [], open: null, max: 12, error: error.message };
    }
    if (stale()) return;
    vaultListing = listing;
    const before = openVid;
    openVid = vaultListing.open || null;
    if (before && before !== openVid) {
      scrubVaultViews();
      vaultsNote("Le coffre s'est verrouillé.");
    }
    if (sheetVid && (!vaultById(sheetVid) || sheetVid === openVid)) closeSheet();
    let nextState;
    if (openVid) {
      nextState = await api(vaultBase() + "/status");
    } else {
      const first = (vaultListing.vaults || [])[0];
      const probe = first ? await api("/api/forge/vaults/" + encodeURIComponent(first.id) + "/status").catch(() => null) : null;
      // No vault yet: nothing is restricted to this Windows account, so private generation waits.
      nextState = { configured: !!first, unlocked: false, private_generation: !!(probe && probe.private_generation), acl: probe ? probe.acl : "unverified" };
    }
    if (stale()) return;
    vaultState = nextState;
    const layout = vaultListing.layout;
    const listed = layout === "multi" || layout === "empty";
    $("forge-vaults").hidden = !privateMode || !listed;
    if (privateMode) renderVaults();  // the panel is only painted when the coffre is the destination
    if (layout === "unreadable") vaultsNote(vaultListing.error || "La liste des coffres est illisible. Aucun coffre n'est ouvert.");
    else if (layout === "migrating") vaultsNote("Un déplacement du coffre a été interrompu. Il reprendra au prochain démarrage de HQ. Rien n'est perdu.");
    await refreshMigration(privateMode);
    if (stale()) return;
    destOk = !!(privateMode && listed && (vaultListing.vaults || []).length);
    syncDest();
    $("forge-vault-setup").hidden = !privateMode || !listed || !createOpen;
    $("forge-vault-restore").hidden = !privateMode || !listed || !restoreOpen;
    $("forge-vault-unlock").hidden = !privateMode || !sheetVid;
    $("forge-vault-open-tools").hidden = !privateMode || !vaultState.unlocked || !openVid;
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
    if (!vaultState.unlocked || !openVid) return;
    const page = await api(vaultBase() + "/gallery?limit=24");
    clearPrivateUi();
    vaultState.unlocked = true;
    (page.images || []).forEach((image) => vaultGallery.appendChild(card(image, "private")));
    $("forge-vault-empty").hidden = (page.images || []).length > 0;
  }

  async function lockVault() {
    const was = vaultById(openVid);
    try {
      await api("/api/forge/vaults/lock", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } finally {
      // Drop decrypted pixels, private text and open-only names even if the lock request failed.
      scrubVaultViews();
      forgetOpenVault();
      closeSheet();
      legacyOpen = false;
      dropOffer("Coffre verrouillé : l'offre de sauvegarde est annulée. Rouvre-le et télécharge à nouveau la sauvegarde.");
    }
    await refreshVault();
    vaultsNote(was ? quoted(vaultSafeName(was)) + " est verrouillé." : "Tous les coffres sont verrouillés.");
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

  function pickGrid(select, kind) {
    const grid = document.querySelector('.forge-pick-grid[data-for="' + select.id + '"]');
    if (!grid) return () => {};
    const cells = [...select.options].map((o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "forge-pick-cell";
      b.dataset.value = o.value;
      b.setAttribute("role", "radio");
      if (kind === "colour") {
        const swatch = document.createElement("span");
        swatch.className = "forge-vault-tile";
        swatch.dataset.colour = o.value;
        swatch.setAttribute("aria-hidden", "true");
        b.appendChild(swatch);
        b.setAttribute("aria-label", COLOURS[o.value] || o.value);
      } else {
        b.textContent = (GLYPHS[o.value] || GLYPHS.coffre)[0];
        b.setAttribute("aria-label", (GLYPHS[o.value] || GLYPHS.coffre)[1]);
      }
      b.addEventListener("click", () => {
        select.value = o.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      grid.appendChild(b);
      return b;
    });
    function sync() {
      cells.forEach((b) => {
        const on = b.dataset.value === select.value;
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      });
      if (!cells.some((b) => b.tabIndex === 0) && cells[0]) cells[0].tabIndex = 0;
    }
    grid.addEventListener("keydown", (event) => {
      const at = cells.indexOf(document.activeElement);
      if (at < 0) return;
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = cells[(at + step + cells.length) % cells.length];
      next.click();
      next.focus();
    });
    select.addEventListener("change", sync);
    sync();
    return sync;
  }

  const glyphPick = $("forge-vault-glyph");
  const colourPick = $("forge-vault-colour");
  Object.keys(GLYPHS).forEach((id) => option(glyphPick, id, GLYPHS[id][0] + " " + GLYPHS[id][1]));
  Object.keys(COLOURS).forEach((id) => option(colourPick, id, COLOURS[id]));
  const syncGlyphGrid = pickGrid(glyphPick, "glyph");
  const syncColourGrid = pickGrid(colourPick, "colour");
  function syncCreatePreview() {
    const tile = $("forge-vault-create-tile");
    tile.dataset.colour = colourPick.value || "ardoise";
    tile.textContent = (GLYPHS[glyphPick.value] || GLYPHS.coffre)[0];
  }
  function syncDiscret() {
    $("forge-vault-label-warn").textContent = $("forge-vault-discret").checked
      ? "Mode Discret : le nom est chiffré dans le coffre. Verrouillé, la liste ne montre qu'un numéro."
      : "Ne mets rien de sensible dans le nom : il reste lisible quand le coffre est verrouillé.";
  }
  function clearCreate() {
    $("forge-vault-label").value = "";
    $("forge-vault-discret").checked = false;
    $("forge-vault-new").value = "";
    $("forge-vault-confirm").value = "";
    $("forge-vault-create-error").textContent = "";
    glyphPick.value = "coffre";
    colourPick.value = "ardoise";
    syncGlyphGrid();
    syncColourGrid();
    syncDiscret();
    syncCreatePreview();
  }
  clearCreate();
  glyphPick.addEventListener("change", syncCreatePreview);
  colourPick.addEventListener("change", syncCreatePreview);
  $("forge-vault-discret").addEventListener("change", syncDiscret);
  $("forge-vaults-new").addEventListener("click", () => {
    closeSheet();
    closeRestore();
    clearCreate();
    createOpen = true;
    $("forge-vault-setup").hidden = false;
    $("forge-vault-label").focus();
  });
  $("forge-vault-create-cancel").addEventListener("click", () => {
    clearCreate();
    createOpen = false;
    $("forge-vault-setup").hidden = true;
  });
  $("forge-vault-setup").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("forge-vault-create-error").textContent = "";
    try {
      const payload = await api("/api/forge/vaults/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: $("forge-vault-label").value,
          glyph: glyphPick.value,
          colour: colourPick.value,
          discret: $("forge-vault-discret").checked,
          passphrase: $("forge-vault-new").value,
          confirm: $("forge-vault-confirm").value
        })
      });
      clearCreate();
      createOpen = false;
      $("forge-vault-recovery-key").value = payload.recovery_key || "";
      $("forge-vault-recovery-extra").hidden = true;
      $("forge-vault-recovery").hidden = false;
      $("forge-vault-setup").hidden = true;
      vaultsNote("Coffre créé. Il reste verrouillé : touche sa carte pour l'ouvrir.");
    } catch (error) {
      $("forge-vault-new").value = "";
      $("forge-vault-confirm").value = "";
      $("forge-vault-create-error").textContent = error.message || "Le coffre n'a pas été créé.";
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
    const target = sheetVid;
    if (!target) return;
    const other = openVid && openVid !== target ? vaultById(openVid) : null;
    try {
      await api("/api/forge/vaults/" + encodeURIComponent(target) + "/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: $("forge-vault-pass").value })
      });
      $("forge-vault-pass").value = "";
      if (other) {
        scrubVaultViews();
        forgetOpenVault();
      }
      closeSheet();
      await refreshVault();
      const opened = quoted(vaultName(vaultById(target)));
      vaultsNote(other ? quoted(vaultSafeName(other)) + " est verrouillé. " + opened + " est ouvert." : opened + " est ouvert.");
      privateTarget = target;  // the owner just opened this vault on purpose: it becomes the destination
      renderTarget();
      if (window.hqForgeOnVaultOpened) window.hqForgeOnVaultOpened(target);
    } catch (error) {
      $("forge-vault-pass").value = "";
      $("forge-vault-error").textContent = error.message || "Phrase refusée.";
    }
  });
  $("forge-vault-unlock-cancel").addEventListener("click", closeSheet);

  /* V5: settings of the open vault (name, icon, colour, Discret), the photo icon and the sort. */
  const editGlyph = $("forge-vault-edit-glyph");
  const editColour = $("forge-vault-edit-colour");
  Object.keys(GLYPHS).forEach((id) => option(editGlyph, id, GLYPHS[id][0] + " " + GLYPHS[id][1]));
  Object.keys(COLOURS).forEach((id) => option(editColour, id, COLOURS[id]));
  const syncEditGlyph = pickGrid(editGlyph, "glyph");
  const syncEditColour = pickGrid(editColour, "colour");
  let editFor = null;
  function honestCopy() {
    const v = vaultById(openVid);
    const want = $("forge-vault-edit-discret").checked;
    const el = $("forge-vault-edit-honest");
    if (!v) { el.textContent = ""; return; }
    if (want && !v.discret) el.textContent = "Le nom quittera la liste en clair et sera chiffr\u00e9 dans ce coffre. Un ancien nom peut subsister dans d'anciennes sauvegardes ou dans l'espace libre du disque : HQ ne peut pas garantir qu'il est effac\u00e9.";
    else if (!want && v.discret) el.textContent = "Le nom redeviendra lisible dans la liste, m\u00eame coffre verrouill\u00e9. Ne mets rien de sensible dans le nom.";
    else if (want) el.textContent = "Ce coffre est Discret : verrouill\u00e9, il s'affiche par son num\u00e9ro.";
    else el.textContent = "Ne mets rien de sensible dans le nom : il reste lisible quand le coffre est verrouill\u00e9.";
  }
  function syncVaultEdit() {
    const v = vaultById(openVid);
    $("forge-vault-icon-row").hidden = !(v && v.icon);
    if (!v) { editFor = null; closeRename(); $("forge-vault-rename-current").textContent = ""; $("forge-vault-rename-status").textContent = ""; $("forge-vault-edit-status").textContent = ""; return; }
    $("forge-vault-rename-current").textContent = v.label || "";
    if (editFor === v.id + "|" + v.glyph + "|" + v.colour + "|" + v.discret + "|" + (v.label || "")) return;
    editFor = v.id + "|" + v.glyph + "|" + v.colour + "|" + v.discret + "|" + (v.label || "");
    editGlyph.value = GLYPHS[v.glyph] ? v.glyph : "coffre";
    editColour.value = COLOURS[v.colour] ? v.colour : "ardoise";
    syncEditGlyph();
    syncEditColour();
    $("forge-vault-edit-discret").checked = !!v.discret;
    honestCopy();
  }
  $("forge-vault-edit-discret").addEventListener("change", honestCopy);
  /* Rename: only for the vault open in this session (the server checks it too). */
  function closeRename() {
    $("forge-vault-rename").hidden = true;
    $("forge-vault-rename-open").hidden = false;
    $("forge-vault-rename-open").setAttribute("aria-expanded", "false");
    $("forge-vault-rename-label").value = "";
  }
  $("forge-vault-rename-open").addEventListener("click", () => {
    const v = vaultById(openVid);
    if (!v) return;
    $("forge-vault-rename-label").value = v.label || "";
    $("forge-vault-rename-honest").textContent = v.discret
      ? "Ce coffre est Discret : le nouveau nom est chiffr\u00e9 dans ce coffre et n'appara\u00eet que coffre ouvert. L'ancien nom peut rester dans d'anciennes sauvegardes."
      : "Le nouveau nom reste lisible dans la liste, m\u00eame coffre verrouill\u00e9. Ne mets rien de sensible.";
    $("forge-vault-rename-status").textContent = "";
    $("forge-vault-rename").hidden = false;
    $("forge-vault-rename-open").hidden = true;
    $("forge-vault-rename-open").setAttribute("aria-expanded", "true");
    $("forge-vault-rename-label").focus();
  });
  $("forge-vault-rename-cancel").addEventListener("click", () => { closeRename(); $("forge-vault-rename-open").focus(); });
  $("forge-vault-rename").addEventListener("submit", async (event) => {
    event.preventDefault();
    const v = vaultById(openVid);
    const status = $("forge-vault-rename-status");
    const label = $("forge-vault-rename-label").value.trim();
    if (!v) return;
    if (!label) { status.textContent = "Le nom ne peut pas \u00eatre vide."; return; }
    try {
      await api("/api/forge/vaults/" + encodeURIComponent(v.id) + "/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: label }) });
      closeRename();
      editFor = null;
      vaultListing = await api("/api/forge/vaults");
      renderVaults();
      status.textContent = "Coffre renomm\u00e9.";
      $("forge-vault-rename-open").focus();
    } catch (error) {
      status.textContent = error.message || "Le nom n'a pas \u00e9t\u00e9 chang\u00e9.";
    }
  });
  $("forge-vault-edit").addEventListener("submit", async (event) => {
    event.preventDefault();
    const v = vaultById(openVid);
    const status = $("forge-vault-edit-status");
    if (!v) return;
    const body = { glyph: editGlyph.value, colour: editColour.value, discret: $("forge-vault-edit-discret").checked };
    try {
      await api("/api/forge/vaults/" + encodeURIComponent(v.id) + "/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      editFor = null;
      await refreshVault();
      status.textContent = "R\u00e9glages enregistr\u00e9s.";
    } catch (error) {
      status.textContent = error.message || "Les r\u00e9glages n'ont pas \u00e9t\u00e9 enregistr\u00e9s.";
    }
  });
  $("forge-vault-icon-use").addEventListener("click", async () => {
    const note = $("forge-vault-icon-note");
    if (!openVid || !privateOpenId) return;
    try {
      await api("/api/forge/vaults/" + encodeURIComponent(openVid) + "/icon", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image_id: privateOpenId }) });
      dropIcon();
      note.textContent = "Ic\u00f4ne enregistr\u00e9e, chiffr\u00e9e dans ce coffre.";
      // Only the list: a full refresh would redraw the vault gallery and close this viewer.
      vaultListing = await api("/api/forge/vaults");
      renderVaults();
    } catch (error) {
      note.textContent = error.message || "L'ic\u00f4ne n'a pas \u00e9t\u00e9 enregistr\u00e9e.";
    }
  });
  $("forge-vault-icon-clear").addEventListener("click", async () => {
    if (!openVid) return;
    try {
      await api("/api/forge/vaults/" + encodeURIComponent(openVid) + "/icon/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      dropIcon();
      await refreshVault();
      vaultsNote("Ic\u00f4ne photo retir\u00e9e. Le glyphe et la couleur reviennent.");
    } catch (error) {
      vaultsNote(error.message || "L'ic\u00f4ne n'a pas \u00e9t\u00e9 retir\u00e9e.");
    }
  });
  $("forge-vaults-sort").addEventListener("change", (event) => {
    vaultSort = ["manuel", "nom", "recent"].includes(event.target.value) ? event.target.value : "manuel";
    renderVaults();
  });
  $("forge-migrate-unlock").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/forge/vaults/migration/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: $("forge-migrate-pass").value })
      });
      $("forge-migrate-pass").value = "";
      migrateStatus("Coffre ouvert. Télécharge d'abord la sauvegarde.");
      await refreshVault();
    } catch (error) {
      $("forge-migrate-pass").value = "";
      migrateStatus(error.message || "Phrase refusée.");
    }
  });
  $("forge-migrate-zip").addEventListener("click", async () => {
    try {
      const response = await fetch("/api/forge/vaults/migration/backup", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error((data && data.error) || "La sauvegarde n'a pas pu être préparée.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "coffre-chiffre.zip";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      offerSeen("Sauvegarde téléchargée (coffre-chiffre.zip). Tu peux maintenant confirmer.");
    } catch (error) {
      migrateStatus(error.message);
      await refreshVault().catch(() => {});
    }
  });
  $("forge-migrate-skip").addEventListener("click", async () => {
    if (!window.confirm("Continuer sans sauvegarde ? Le déplacement ne rechiffre rien, mais sans ZIP une panne serait plus difficile à réparer.")) return;
    try {
      await api("/api/forge/vaults/backup-offer", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      offerSeen("Sauvegarde proposée et laissée de côté. Tu peux maintenant confirmer.");
    } catch (error) {
      migrateStatus(error.message);
      await refreshVault().catch(() => {});
    }
  });
  $("forge-migrate-ack").addEventListener("change", syncMigration);
  $("forge-migrate-lock").addEventListener("click", () => lockVault().catch((error) => { migrateStatus(error.message); }));
  $("forge-migrate-go").addEventListener("click", async () => {
    if (!migrateOffer || !$("forge-migrate-ack").checked || migrating) return;
    if (Date.now() - migrateOffer > OFFER_MS) {
      dropOffer("Plus de 15 minutes ont passé : l'offre de sauvegarde a expiré. Télécharge à nouveau la sauvegarde.");
      syncMigration();
      return;
    }
    migrating = true;
    migrateStatus("Déplacement en cours… Garde l'app ouverte.");
    syncMigration();
    try {
      await api("/api/forge/vaults/migrate", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      migrating = false;
      dropOffer();
      legacyOpen = false;
      scrubVaultViews();
      await refreshVault();
      vaultsNote("Ton coffre a été déplacé. Il est dans Mes coffres : ouvre-le avec ta phrase habituelle.");
    } catch (error) {
      migrating = false;
      dropOffer();
      const code = error.data && error.data.code;
      migrateStatus(code === "backup_first"
        ? "L'offre de sauvegarde n'est plus valable (délai passé ou coffre verrouillé entre-temps). Télécharge à nouveau la sauvegarde."
        : code === "locked"
          ? "Le coffre s'est verrouillé : l'offre est annulée. Rouvre-le pour recommencer."
          : (error.message || "Le déplacement n'a pas abouti. Rien n'est perdu."));
      await refreshVault().catch(() => {});
    }
  });
  $("forge-private-target").addEventListener("change", () => {
    const wanted = $("forge-private-target").value;
    privateTarget = wanted && wanted === openVid ? wanted : null;
    renderTarget();
    if (wanted && wanted !== openVid) openSheet(wanted);  // a locked vault opens with its phrase first
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
  $("forge-vault-current-open").addEventListener("click", () => { if (currentVid) openSheet(currentVid); });
  $("forge-vaults-all").addEventListener("click", () => {
    vaultsAll = !vaultsAll;
    renderVaults();
    $("forge-vaults-all").focus();
  });
  $("forge-dest-chip").addEventListener("click", () => {
    destSheetOpen = $("forge-private-target-row").hidden;
    syncDest();
    if (destSheetOpen) $("forge-private-target").focus();
  });

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
      if (away >= AWAY_MS && awayPref() && anyVaultOpen()) lockVault().catch(() => {});
      return;
    }
    hiddenAt = Date.now();
    if (!awayPref() || !anyVaultOpen()) return;
    awayTimer = setTimeout(() => {
      awayTimer = 0;
      if (document.visibilityState === "hidden" && anyVaultOpen()) lockVault().catch(() => {});
    }, AWAY_MS);
  });
  $("forge-vault-import").addEventListener("change", async () => {
    const file = $("forge-vault-import").files && $("forge-vault-import").files[0];
    $("forge-vault-import").value = "";
    if (!file) return;
    try {
      await api(vaultBase() + "/import", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
      await loadVaultGallery();
    } catch (error) {
      statusEl.textContent = error.message || "Import impossible.";
    }
  });
  $("forge-vault-rotate").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api(vaultBase() + "/passphrase", {
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
      vaultsNote("Phrase changée. Le coffre s'est verrouillé : rouvre-le avec la nouvelle phrase. La clé de récupération reste la même.");
    } catch (error) {
      $("forge-vault-error").textContent = error.message || "La phrase n'a pas changé.";
    }
  });
  $("forge-vault-rekey").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = await api(vaultBase() + "/recovery", {
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

  /* V6: per-vault backup ZIP, restore as a new vault, delete a vault. */
  $("forge-vault-backup-zip").addEventListener("click", async () => {
    const status = $("forge-vault-backup-status");
    status.textContent = "";
    try {
      const response = await fetch(vaultBase() + "/backup", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error((data && data.error) || "La sauvegarde n'a pas pu être préparée.");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "coffre-chiffre.zip";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = "Sauvegarde téléchargée (coffre-chiffre.zip). Garde-la hors de HQ.";
    } catch (error) {
      status.textContent = error.message;
      await refreshVault().catch(() => {});
    }
  });

  function clearRestore() {
    $("forge-vault-restore-file").value = "";
    $("forge-vault-restore-picked").textContent = "";
    $("forge-vault-restore-label").value = "";
    $("forge-vault-restore-pass").value = "";
    $("forge-vault-restore-error").textContent = "";
  }
  function closeRestore() {
    clearRestore();
    restoreOpen = false;
    $("forge-vault-restore").hidden = true;
  }
  $("forge-vaults-restore").addEventListener("click", () => {
    closeSheet();
    clearCreate();
    createOpen = false;
    $("forge-vault-setup").hidden = true;
    clearRestore();
    restoreOpen = true;
    $("forge-vault-restore").hidden = false;
    $("forge-vault-restore-file").focus();
  });
  $("forge-vault-restore-cancel").addEventListener("click", closeRestore);
  $("forge-vault-restore-file").addEventListener("change", () => {
    const file = $("forge-vault-restore-file").files && $("forge-vault-restore-file").files[0];
    $("forge-vault-restore-picked").textContent = file
      ? "ZIP choisi (" + Math.max(1, Math.round(file.size / 1048576)) + " Mo)." : "";
  });
  $("forge-vault-restore").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = $("forge-vault-restore-error");
    error.textContent = "";
    const file = $("forge-vault-restore-file").files && $("forge-vault-restore-file").files[0];
    if (!file) {
      error.textContent = "Choisis d'abord le ZIP de sauvegarde.";
      return;
    }
    const meta = new TextEncoder().encode(JSON.stringify({
      passphrase: $("forge-vault-restore-pass").value,
      label: $("forge-vault-restore-label").value.trim()
    }));
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, meta.length);
    $("forge-vault-restore-go").disabled = true;
    try {
      const payload = await api("/api/forge/vaults/restore", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([head, meta, file])
      });
      closeRestore();
      const v = payload.vault || {};
      const name = v.discret ? "Le coffre Discret" : "Le coffre " + quoted(v.label || "");
      await refreshVault();
      vaultsNote(name + " est restauré. Il reste verrouillé : touche sa carte pour l'ouvrir avec sa phrase."
        + (payload.renamed ? " Ce nom était déjà pris : un numéro a été ajouté." : ""));
    } catch (err) {
      $("forge-vault-restore-pass").value = "";
      error.textContent = err.message || "La sauvegarde n'a pas été restaurée.";
    } finally {
      $("forge-vault-restore-go").disabled = false;
    }
  });

  function clearDeleteForm() {
    const pass = $("forge-vault-destroy-pass");
    if (!pass) return;
    pass.value = "";
    $("forge-vault-destroy-word").value = "";
    $("forge-vault-destroy-go").disabled = true;
    $("forge-vault-destroy-error").textContent = "";
    $("forge-vault-backup-status").textContent = "";
    $("forge-vault-destroy-fold").open = false;
  }
  const deleteWordOk = () => $("forge-vault-destroy-word").value.trim().toUpperCase() === "SUPPRIMER";
  $("forge-vault-destroy-word").addEventListener("input", () => {
    $("forge-vault-destroy-go").disabled = !deleteWordOk();
  });
  $("forge-vault-destroy").addEventListener("submit", async (event) => {
    event.preventDefault();
    const target = openVid;
    const was = vaultById(target);
    if (!target || !deleteWordOk()) return;
    $("forge-vault-destroy-go").disabled = true;
    try {
      const result = await api("/api/forge/vaults/" + encodeURIComponent(target) + "/destroy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: $("forge-vault-destroy-pass").value, confirm: $("forge-vault-destroy-word").value })
      });
      clearDeleteForm();
      scrubVaultViews();
      forgetOpenVault();
      await refreshVault();
      vaultsNote((was ? quoted(vaultSafeName(was)) : "Le coffre") + " est supprimé."
        + (result && result.wiped === false ? " Certains fichiers seront écrasés au prochain démarrage de HQ." : ""));
    } catch (err) {
      $("forge-vault-destroy-pass").value = "";
      $("forge-vault-destroy-go").disabled = !deleteWordOk();
      $("forge-vault-destroy-error").textContent = err.message || "Le coffre n'a pas été supprimé.";
    }
  });

  /* Health check: read-only. The summary works locked (disk facts only); the deep check decrypts
     every image of the open vault. Counts and codes only; vaults are named as in the list. */
  const HEALTH_COPY = {
    missing: "Le dossier du coffre est introuvable.",
    binding: "Le dossier ne correspond pas à ce coffre.",
    header: "L'en-tête du coffre est illisible.",
    index: "L'index chiffré manque.",
    objects: "Le dossier des images manque.",
    partials: "Une écriture interrompue a laissé un fichier partiel. HQ le retire au prochain démarrage.",
    stray: "Un fichier inattendu se trouve dans le dossier des images.",
    leftover: "Une restauration ou une suppression interrompue a laissé un dossier. HQ le termine au prochain démarrage.",
    acl: "Le dossier n'est pas limité à ce compte Windows.",
    never_backed_up: "Pas encore sauvegardé depuis HQ.",
    backup_old: "Dernière sauvegarde il y a plus de 30 jours."
  };
  const HEALTH_STATE = { ok: "Bon état", warn: "À regarder", error: "Problème" };
  const megabytes = (n) => n >= 1073741824
    ? (n / 1073741824).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " Go"
    : (n > 0 && n < 104858 ? "moins de 0,1" : (n / 1048576).toLocaleString("fr-FR", { maximumFractionDigits: 1 })) + " Mo";
  const images = (n) => n + (n > 1 ? " images" : " image");
  function backupLine(row) {
    if (row.backup_age_days == null) return "Jamais sauvegardé depuis HQ";
    if (row.backup_age_days === 0) return "Sauvegardé aujourd'hui";
    return "Sauvegardé il y a " + row.backup_age_days + (row.backup_age_days === 1 ? " jour" : " jours");
  }
  function li(text) {
    const node = document.createElement("li");
    node.textContent = text;
    return node;
  }
  async function loadHealth() {
    const list = $("forge-vaults-health-list");
    const total = $("forge-vaults-health-total");
    total.textContent = "Vérification…";
    let body;
    try {
      body = await api("/api/forge/vaults/health");
    } catch (error) {
      list.replaceChildren();
      total.textContent = error.message || "L'état des coffres n'a pas pu être lu.";
      return;
    }
    list.replaceChildren();
    (body.vaults || []).forEach((row) => {
      const item = document.createElement("li");
      item.className = "forge-health-row";
      item.dataset.state = row.state;
      const head = document.createElement("div");
      head.className = "forge-health-head";
      const name = document.createElement("span");
      const v = vaultById(row.id);
      name.textContent = v ? vaultSafeName(v) : "Coffre n° " + row.number;
      const state = document.createElement("span");
      state.textContent = HEALTH_STATE[row.state] || row.state;
      head.append(name, state);
      const facts = document.createElement("ul");
      facts.appendChild(li(images(row.images) + " sur " + row.quota_images
        + ", " + megabytes(row.bytes) + " · " + backupLine(row)));
      (row.problems || []).filter((p) => p !== "never_backed_up").forEach((p) => facts.appendChild(li(HEALTH_COPY[p] || p)));
      item.append(head, facts);
      list.appendChild(item);
    });
    const t = body.totals;
    if (!t) {
      total.textContent = "Aucun coffre à vérifier.";
      return;
    }
    total.textContent = "Ensemble : " + images(t.images) + " sur " + t.global_images + ", " + megabytes(t.bytes)
      + " sur " + megabytes(t.global_bytes) + ", " + t.vaults + " coffre" + (t.vaults > 1 ? "s" : "") + " sur " + t.max_vaults + "."
      + (t.unlisted_folders ? " " + t.unlisted_folders + " dossier(s) hors de la liste : ils n'ouvrent rien et ne sont pas touchés." : "");
  }
  $("forge-vaults-health-fold").addEventListener("toggle", () => {
    if ($("forge-vaults-health-fold").open) loadHealth();
  });
  $("forge-vaults-health-run").addEventListener("click", loadHealth);

  function clearDeepCheck() {
    const result = $("forge-vault-check-result");
    if (!result) return;
    result.replaceChildren();
    $("forge-vault-check-status").textContent = "";
    $("forge-vault-check-run").disabled = false;
  }
  $("forge-vault-check-run").addEventListener("click", async () => {
    const target = openVid;
    if (!target) return;
    clearDeepCheck();
    $("forge-vault-check-run").disabled = true;
    $("forge-vault-check-status").textContent = "Vérification en cours… Cela peut prendre un moment pour un grand coffre.";
    try {
      const r = await api("/api/forge/vaults/" + encodeURIComponent(target) + "/check", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      });
      if (openVid !== target) return;  // locked or switched meanwhile: show nothing about it
      const out = $("forge-vault-check-result");
      out.appendChild(li(r.ok + " image" + (r.ok > 1 ? "s" : "") + " intacte" + (r.ok > 1 ? "s" : "") + " sur " + r.checked + "."));
      if (r.index !== "ok") out.appendChild(li("L'index chiffré est illisible."));
      if (r.unreadable) out.appendChild(li(r.unreadable + " image(s) illisible(s) : le fichier est abîmé."));
      if (r.missing) out.appendChild(li(r.missing + " image(s) listée(s) sans fichier."));
      if (r.orphans) out.appendChild(li(r.orphans + " fichier(s) chiffré(s) hors de l'index. Ils sont laissés en place."));
      if (r.label === "unreadable") out.appendChild(li("Le nom Discret scellé est illisible."));
      if (r.icon === "unreadable") out.appendChild(li("L'icône photo est illisible."));
      if (r.trash) out.appendChild(li(r.trash + " image(s) dans la corbeille du coffre."));
      $("forge-vault-check-status").textContent = (r.healthy ? "Tout est intact." : "Des éléments demandent attention.")
        + " (" + r.seconds.toLocaleString("fr-FR") + " s)";
    } catch (error) {
      $("forge-vault-check-status").textContent = error.message || "La vérification n'a pas abouti.";
    } finally {
      $("forge-vault-check-run").disabled = false;
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
    vaultUnlocked: () => !!vaultState.unlocked && !!openVid,
    vaultBase: () => vaultBase(),
    openVault: () => openVid,
    trackPrivateUrl: (url) => privateUrls.add(url),
    /* Laboratoire "Appliquer ces r\u00e9glages": technical fields only (never the prompt or the
       negative prompt). Returns what changed and what this HQ cannot apply, so nothing is silent. */
    noteHouseStyle: (s) => { houseApplied = s ? Object.assign({}, s) : null; },
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
    fleetMode: () => fleetMode(),
    showBatch: (batch) => showBatch(batch),
    /* E (hq-forge-explore.js): the form's settings and the devices a batch would use; never in private mode. */
    sweepContext: () => {
      const settings = settingsFromForm();
      delete settings.n_iter;
      delete settings.batch_size;
      const workers = fleetMode() ? devices.filter((device) => selected.has(device.id) && deviceVerdict(device).ok).map((device) => device.id) : ["local"];
      return { settings, workers, privateMode: destination() === "private", samplers: [...samplerEl.options].map((o) => o.value).filter(Boolean) };
    },
    startBatch: (batch) => {
      justSubmitted = true; revealCentered = false; celebrateSubmit = false;
      resultIntent = false;
      results.replaceChildren();
      delete results.dataset.jobReveal;
      shownBatchImages.clear();
      showBatch(batch);
    },
    card: (image) => card(image),
    /* H (hq-forge-vault-search.js): a vault card from a search result, same viewer as the vault grid. */
    privateCard: (image) => card(image, "private"),
    reloadVault: () => loadVaultGallery(),
    currentDetail: () => currentDetail,
    openImage: (id) => openViewer(id),
    /* I (hq-forge-inpaint.js): the private viewer's settings in memory, and reopening a vault image. */
    privateDetail: () => privateDetail,
    openPrivate: (id) => openPrivate(id),
    closePrivateViewer: () => { if (vaultViewer.open) vaultViewer.close(); },
    closeViewer: () => { if (viewer.open) closeViewer(); },
    upscalers: () => [...$("forge-hr-upscaler").options].map((o) => o.value).filter((v) => v && v !== "None"),
    preferredUpscaler: () => $("forge-hr-upscaler").value,
    startJob: (job) => {
      justSubmitted = true; revealCentered = false; celebrateSubmit = false;
      progressBox.hidden = false;
      showJob(job);
    },
    /* A recipe/finish action submits a complete normal job without changing the
       owner's prompt by accident. The existing progress panel and polling do the rest. */
    runNormalSettings: (settings) => {
      if (submitGuard || !settings || typeof settings !== "object") return false;
      const normal = document.querySelector('input[name="forge-destination"][value="normal"]');
      if (normal && !normal.checked) {
        normal.checked = true;
        if (typeof syncDest === "function") syncDest();
      }
      submitGeneration({ key: key(), destination: "normal", settings: Object.assign({}, settings, { wait_if_busy: true }) });
      return true;
    },
    applySeed: (seed) => applySeed(seed),
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
        else body.vault = openVid;  // V4: variations of a vault image go back to that same, open vault
        const payload = await api("/api/forge/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": exploreKey() },
          body: JSON.stringify(body)
        });
        if (privateMode) closePrivate(); else closeViewer();
        justSubmitted = true; revealCentered = false; celebrateSubmit = false;
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

  let privateOpenId = null;
  async function openPrivate(id, from) {
    openFrom = from || document.activeElement;
    privateOpenId = id;
    if ($("forge-vault-icon-note")) $("forge-vault-icon-note").textContent = "";
    privateDetail = await api(vaultBase() + "/images/" + id);
    const response = await fetch(vaultBase() + "/images/" + id + "/original", { credentials: "same-origin", cache: "no-store" });
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
    const response = await fetch(vaultBase() + "/images/" + privateDetail.id + "/original" + (withParams ? "?parameters=1" : ""), { credentials: "same-origin", cache: "no-store" });
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
    await api(vaultBase() + "/images/" + privateDetail.id + "/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    privateDetail = null;
    closePrivate();
    loadVaultGallery().catch(() => {});
  });


  // Le rendu des cartes, des rangées et de la liste des préréglages vit dans hq-forge-gallery.js, chargé
  // dès que la vue est en place : le coeur garde l'état, les appels réseau et les actions, et passe ses
  // valeurs vivantes par des accesseurs, comme pour le coffre.
  let galleryUi = null;
  let galleryUiLoading = null;
  function galleryUiCtx() {
    return {
      $, option, gallery, api,
      presetList: $("forge-preset-list"),
      presetState: $("forge-preset-state"),
      presetEditor: $("forge-preset-editor"),
      promptEl, negativeEl, checkpointEl, samplerEl, schedulerEl,
      forgeSeed: () => forgeSeed(),
      applySeed: (seed) => applySeed(seed),
      applyHires: (settings) => applyHires(settings),
      describeChoices: (stale) => describeChoices(stale),
      syncActions: (active) => syncActions(active),
      destination: () => destination(),
      shortModel: (text) => shortModel(text),
      get gallerySearching() { return gallerySearching; },
      shortModel: (text) => shortModel(text),
      privateThumb: (id) => privateThumb(id),
      openViewer: (id, from) => openViewer(id, from),
      openPrivate: (id, from) => openPrivate(id, from),
    };
  }
  function ensureGalleryUi() {
    if (galleryUi || galleryUiLoading) return galleryUiLoading;
    galleryUiLoading = new Promise((resolve) => {
      const el = document.createElement("script");
      // Same build stamp as the other lazy assets, so a repeat visit reads this from cache instead of
      // revalidating while the first gallery render waits on it.
      el.src = "/assets/hq-forge-gallery.js" + (window.HQ_ASSET_BUILD ? "?v=" + window.HQ_ASSET_BUILD : "");
      el.async = false;
      el.onload = () => {
        galleryUi = window.hqForgeGallery ? window.hqForgeGallery.create(galleryUiCtx()) : null;
        if (galleryUi && galleryUi.init) galleryUi.init();
        resolve(galleryUi);
      };
      el.onerror = () => { el.remove(); galleryUiLoading = null; resolve(null); };
      document.body.appendChild(el);
    }).then((ui) => { if (ui) { renderPresetList(); refreshPresetState(); } return ui; });
    return galleryUiLoading;
  }
  function card(image, mode) { return galleryUi ? galleryUi.card(image, mode) : null; }
  function galleryRows(rows, reset) {
    if (!galleryUi) { ensureGalleryUi().then(() => galleryRows(rows, reset)); return; }
    galleryUi.galleryRows(rows, reset);
  }
  function renderPresetList() { if (galleryUi) galleryUi.renderPresetList(); }
  function refreshPresetState() { if (galleryUi) galleryUi.refreshPresetState(); }
  function loadPresetList() { return ensureGalleryUi().then((ui) => (ui ? ui.loadPresetList() : null)); }












  const presetList = $("forge-preset-list");  // element ref stays: the form wiring and the hint read it
  if (presetList) {
    ensureGalleryUi();
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
    if (!countEl) return;
    const words = promptEl.value.trim().split(/\s+/).filter(Boolean).length;
    const tokens = Math.ceil(words * 1.35);
    countEl.textContent = promptEl.value.length + " / " + (promptEl.maxLength > 0 ? promptEl.maxLength : 2000) + " · ~" + tokens + " jeton" + (tokens > 1 ? "s" : "");
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

  /* One Forge-wide status channel: the panel and the studio sheets share it, so a
     confirmation never depends on which note happens to be on screen. */
  let toastTimer = 0;
  function toast(message, level) {
    let box = document.getElementById("forge-studio-toast");
    if (!box) {
      box = document.createElement("p");
      box.id = "forge-studio-toast";
      box.className = "forge-studio-toast";
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      box.hidden = true;
      document.body.appendChild(box);
    }
    box.textContent = String(message || "");
    if (level) box.dataset.level = level; else delete box.dataset.level;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 6200);
  }
  window.hqForgeToast = toast;

  function say(text) {
    if (historyNote) historyNote.textContent = text;
    if (text) toast(text);
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
    justSubmitted = true; revealCentered = false; celebrateSubmit = houseInUse();
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
  function replaceOpenHelp() {
    helpWraps.forEach((wrap) => {
      if (wrap.classList.contains("is-open") || wrap.matches(":hover") || wrap.matches(":focus-within")) placeHelp(wrap);
    });
  }
  window.addEventListener("resize", replaceOpenHelp);
  /* Some engines scroll a focused control into view after focusin: re-place what is open. */
  window.addEventListener("scroll", replaceOpenHelp, { passive: true });

  /* Finished image: auto-scroll to it only when the user stayed idle. Cheap trusted
     signals while a submitted job runs; programmatic scrolls fire none of them. */
  const seeResult = $("forge-see-result");
  const resultsBox = $("forge-normal-results");
  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  // Result reveal: the target is the newest finished card (normal grid, batch grid or private vault grid).
  let revealTarget = null;
  const revealSeen = window.IntersectionObserver ? new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting && entry.target === revealTarget)) hideSeeResult();
  }, { threshold: 0.6 }) : null;
  function revealNode() {
    return revealTarget && revealTarget.isConnected ? revealTarget : resultsBox;
  }
  function centerOn(node) {
    const box = node.getBoundingClientRect();
    // Already fully on screen: no scroll at all, the reveal animation is the cue.
    if (box.top >= 0 && box.bottom <= window.innerHeight) return;
    node.scrollIntoView({ block: "center", inline: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
  }
  function scrollToResult() {
    hideSeeResult();
    centerOn(revealNode());
  }
  // A finished result: always play the reveal (CSS drops it under reduced motion); center it only for the
  // first result of the current submit and only if the user stayed idle, otherwise offer "Voir le résultat".
  function landResult(node, submitted = justSubmitted, delay = 0) {
    if (!node) return;
    node.style.setProperty("--forge-reveal-delay", Math.max(0, Number(delay) || 0) + "ms");
    node.classList.remove("forge-reveal", "forge-reveal-celebrate");
    void node.offsetWidth;
    node.classList.add("forge-reveal");
    let wash = node.querySelector(".forge-develop-wash");
    const motionTier = document.documentElement.dataset.hqMotionTier;
    const noWetPrint = reduceMotion() || motionTier === "lite" || motionTier === "parked";
    if (!noWetPrint) {
      if (!wash) {
        wash = document.createElement("span");
        wash.className = "forge-develop-wash";
        wash.setAttribute("aria-hidden", "true");
        wash.addEventListener("animationend", () => wash.remove(), { once: true });
        node.appendChild(wash);
      }
      wash.classList.remove("is-playing");
      void wash.offsetWidth;
      wash.classList.add("is-playing");
    } else if (wash) {
      wash.remove();
    }
    if ((submitted && celebrateSubmit) || node.dataset.triage === "favorite") node.classList.add("forge-reveal-celebrate");
    if (node.classList.contains("forge-reveal-celebrate") && typeof window.hqPolishBurst === "function") {
      window.hqPolishBurst(node);
    }
    if (!submitted) return;
    if (revealSeen && revealTarget) revealSeen.unobserve(revealTarget);
    revealTarget = node;
    if (revealSeen) revealSeen.observe(node);
    if (revealCentered) return;
    if (resultIntent) { showSeeResult(); return; }
    revealCentered = true;
    hideSeeResult();
    centerOn(node);
  }
  function hideSeeResult() {
    if (seeResult) seeResult.hidden = true;
  }
  function showSeeResult() {
    if (!seeResult) return;
    // Already on screen (top in view, or at least 35% visible, matching the observer below): no chip.
    const box = revealNode().getBoundingClientRect();
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

  const fleetFxTimers = new Map();
  const fleetTaskStates = new Map();
  const fleetRunningIds = new Set();

  function fleetTaskKey(task) {
    return String(task.id || task.task_id || ((task.worker_id || "?") + ":" + task.index));
  }

  function paintFleetRunning() {
    if (!deviceList) return;
    deviceList.querySelectorAll(".forge-device").forEach((node) => {
      node.classList.toggle("is-batch-running", fleetRunningIds.has(node.dataset.id));
    });
  }

  function pulseDevice(id, kind) {
    const node = deviceList && deviceList.querySelector('.forge-device[data-id="' + CSS.escape(String(id)) + '"]');
    if (!node) return;
    node.classList.remove("is-dispatching", "is-batch-done");
    void node.offsetWidth;
    node.classList.add(kind === "done" ? "is-batch-done" : "is-dispatching");
    clearTimeout(fleetFxTimers.get(id));
    fleetFxTimers.set(id, setTimeout(() => node.classList.remove("is-dispatching", "is-batch-done"), 950));
  }

  function syncFleetFx(batch) {
    fleetRunningIds.clear();
    (batch.workers || []).forEach((row) => {
      if (row.running && row.worker_id) fleetRunningIds.add(String(row.worker_id));
    });
    paintFleetRunning();
    const liveTasks = new Set((batch.tasks || []).map(fleetTaskKey));
    for (const key of fleetTaskStates.keys()) {
      if (!liveTasks.has(key)) fleetTaskStates.delete(key);
    }
    (batch.tasks || []).forEach((task) => {
      const id = task.worker_id && String(task.worker_id);
      if (!id) return;
      const key = fleetTaskKey(task);
      const previous = fleetTaskStates.get(key);
      const state = String(task.state || "");
      if (state !== previous) {
        if (["dispatched", "running", "saving", "sending"].includes(state)) pulseDevice(id, "dispatch");
        else if (state === "completed" && previous) pulseDevice(id, "done");
        fleetTaskStates.set(key, state);
      }
    });
  }

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
    box.append(rename, row, wakeBlock(device));
    return box;
  }

  // Wake-on-LAN: wake only, sent by this HQ on its own local network. The MAC stays server side (only its tail is shown).
  function wakeBlock(device) {
    const info = device.wake || { configured: false, hint: "" };
    const box = document.createElement("div");
    box.className = "forge-device-wake";
    if (info.configured && !device.online) {
      const wakeBtn = document.createElement("button");
      wakeBtn.type = "button";
      wakeBtn.className = "forge-device-wake-btn";
      wakeBtn.textContent = "R\u00e9veiller";
      wakeBtn.addEventListener("click", () => wakeDevice(device.id, wakeBtn));
      box.append(wakeBtn);
    }
    const form = document.createElement("form");
    form.className = "forge-device-wake-form";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 17;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = info.configured ? "MAC enregistr\u00e9e (\u2026" + info.hint + ")" : "Adresse MAC (r\u00e9veil)";
    input.setAttribute("aria-label", "Adresse MAC de " + device.name + " pour le r\u00e9veil");
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "secondary";
    save.textContent = "Enregistrer";
    form.append(input, save);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const mac = input.value.trim();
      input.value = "";
      deviceAction(device.id, "wake-config", { mac });
    });
    const note = document.createElement("p");
    note.className = "forge-device-wake-note";
    note.textContent = "R\u00e9veil uniquement, depuis cet HQ sur le m\u00eame r\u00e9seau local (pas \u00e0 travers Tailscale). Le PC doit avoir \u00ab Wake on LAN \u00bb activ\u00e9 dans le BIOS et la carte r\u00e9seau. Champ vide + Enregistrer : oublie l'adresse.";
    box.append(form, note);
    return box;
  }

  async function wakeDevice(id, button) {
    button.disabled = true;
    try {
      const out = await api("/api/forge/devices/" + encodeURIComponent(id) + "/wake", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      devicesNote.textContent = (out && out.message) || "Paquet de r\u00e9veil envoy\u00e9.";
    } catch (error) {
      devicesNote.textContent = error.message || "R\u00e9veil impossible.";
    }
    setTimeout(() => { button.disabled = false; }, 1500);
  }

  async function deviceAction(id, action, body) {
    try {
      await api("/api/forge/devices/" + encodeURIComponent(id) + "/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (document.activeElement && document.activeElement.closest && document.activeElement.closest(".forge-device-rename")) document.activeElement.blur();
      if (action === "remove") selected.delete(id);
      saveSelection();
      devicesNote.textContent = { rename: "Nom enregistré.", disable: "Appareil désactivé.", enable: "Appareil réactivé.", "wake-config": "R\u00e9glage de r\u00e9veil enregistr\u00e9.", remove: "Appareil retiré. Son accès est révoqué." }[action];
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

  function jobProgressValue(current) {
    if (!current || current.progress_stale) return null;
    return progressFraction(current.progress);
  }
  function jobText(current) {
    const parts = [current.steps ? "Pas " + Number(current.step || 0) + " / " + current.steps : "T\u00e2che en cours"];
    const value = jobProgressValue(current);
    if (value !== null && value > 0) parts.push(Math.round(value * 100) + " %");
    else if (current.progress_stale) parts.push("progression indisponible");
    return parts.join(" \u00b7 ");
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
      const value = jobProgressValue(device.current);
      if (value === null) { bar.removeAttribute("value"); bar.setAttribute("data-indeterminate", "1"); }
      else { bar.value = value; }
      bar.setAttribute("aria-label", "Progression sur " + device.name);
      bar.setAttribute("aria-valuetext", jobText(device.current));
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
    dl.append(specLine("Mod\u00e8le actif dans Forge", device.model || "inconnu"));
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
      const value = jobProgressValue(device.current);
      if (bar) {
        if (value === null) {
          if (bar.hasAttribute("value")) bar.removeAttribute("value");
          bar.setAttribute("data-indeterminate", "1");
        } else if (!bar.hasAttribute("value") || Number(bar.value) !== value) {
          bar.value = value;
          bar.removeAttribute("data-indeterminate");
        }
        bar.setAttribute("aria-valuetext", jobText(device.current));
      }
      if (text && text.textContent !== jobText(device.current)) text.textContent = jobText(device.current);
    });
  }

  function renderDevices(force) {
    const typing = document.activeElement && document.activeElement.matches && document.activeElement.matches(".forge-device-rename input, .forge-device-wake-form input");
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
    paintFleetRunning();
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
      justSubmitted = true; revealCentered = false; celebrateSubmit = houseInUse();
      resultIntent = false;
      results.replaceChildren();
      delete results.dataset.jobReveal;
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
    delete results.dataset.jobReveal;
    batchBox.hidden = false;
    const c = batch.counts;
    const running = batch.state === "running" || batch.state === "cancelling";
    setWake("batch", running);
    syncFleetFx(batch);
    const setText = (id, value) => { const n = $(id); if (n.textContent !== value) n.textContent = value; };
    setText("forge-fleet-batch-state", batch.paused ? "En pause" : ({ running: "En cours", cancelling: "Annulation…", completed: "Terminé", partial: "Terminé en partie", failed: "Échec", cancelled: "Annulé" }[batch.state] || batch.state));
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
    if (window.hqForgeOnBatch) window.hqForgeOnBatch(batch);
    let addedCount = 0;
    batch.tasks.forEach((task) => {
      if (task.image_id && !shownBatchImages.has(task.image_id)) {
        shownBatchImages.add(task.image_id);
        const node = card({ id: task.image_id, thumb: "/api/forge/gallery/" + task.image_id + "/thumb" });
        results.appendChild(node);
        landResult(node, addedCount === 0 ? justSubmitted : false, addedCount * 50);
        addedCount += 1;
      }
    });
    if (addedCount) {
      const resultsEmpty = $("forge-results-empty");
      if (resultsEmpty) resultsEmpty.hidden = true;
    }
    progressBox.hidden = !running;
    progressBox.classList.remove("is-error");
    progressBox.classList.toggle("is-live", running);
    progressBar.hidden = false;
    progressBar.classList.toggle("is-live", running);
    syncProgressSegments(batch.tasks, c.total, running);
    setForgeAura(running);
    const overall = c.total ? (c.done + c.failed + c.uncertain + c.cancelled) / c.total : 0;
    progressBar.removeAttribute("data-indeterminate");
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
      // The first finished image was already centered; a user who moved away since gets the chip, not a jump.
      if (justSubmitted && resultIntent && revealTarget) showSeeResult();
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
      justSubmitted = true; revealCentered = false; celebrateSubmit = false;
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
  studio.addEventListener("change", updateSettingsSummary);
  studio.addEventListener("input", updateSettingsSummary);
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
    const t0 = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    const markDone = () => {
      const ms = Math.round(performance.now() - t0);
      if (window.hqPerfMark) window.hqPerfMark("forge", { op: "forge-show", ms }, { force: ms > 400 });
    };
    // Only the job resume needs the status line. The vault, the presets and the devices no longer
    // wait behind it, and the gallery still comes after the vault it is filtered by.
    const status = refreshStatus();
    status.then(() => resume()).catch(() => {});
    Promise.allSettled([status, refreshVault(), loadPresetList(), loadDevices()])
      .then(() => loadGallery(true))
      .then(() => resumeBatch())
      .catch(() => {})
      .finally(markDone);
    queueUsual();
  };
  window.hqForgeHide = function () {
    if (busyTimer) { window.clearTimeout(busyTimer); busyTimer = 0; }
    stopEta();
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
    closeSheet();
  };
})();
