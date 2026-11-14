/* Forge Studio: Séance workspaces, recipe cards, the normal-gallery library and
   outpaint. Everything here is normal mode except the outpaint entry point in the
   private viewer, which sends the source only to this PC's Forge and keeps the
   result in the same vault. No vault id, prompt or image enters the sessions or
   library JSON files. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const H = window.hqForgeHooks;
  if (!H || !$("forge-studio")) return;

  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const clip = (value, size) => { const text = String(value == null ? "" : value).trim(); return text.length > size ? text.slice(0, size - 1) + "…" : text; };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const key = (prefix) => (prefix || "studio") + "-" + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 38);

  /* One channel: hq-forge.js owns the toast, this file only mirrors messages into
     an open sheet's own status line (a modal sits in the top layer). */
  function toast(message) {
    if (typeof window.hqForgeToast === "function") window.hqForgeToast(message);
    if ($("forge-seance-dialog")?.open && $("forge-seance-status")) $("forge-seance-status").textContent = message;
    if ($("forge-library-dialog")?.open && $("forge-library-note")) $("forge-library-note").textContent = message;
  }

  let seances = [];
  let currentSeance = null;
  let sessionPoll = null;
  let library = [];
  let librarySelection = new Set();
  let libraryNext = null;
  let libraryQuery = {};
  let comparePicks = [];
  let modeGlide = null;
  let briefFirstRender = true;
  const seenLoraChips = new Set();
  const seenRefChips = new Set();

  /* ------------------------------------------------------------------ shell */
  /* The three zones share one DOM: brief and result stay in the reading column,
     while every control worth revisiting lives in the settings rail. Moving the
     existing blocks (instead of rebuilding the form) keeps every listener and
     API hook intact. */
  function composeStudio() {
    const shell = document.querySelector(".forge-shell");
    if (!shell || shell.dataset.composed === "1") return;
    const form = $("forge-form");
    const action = $("forge-actionbar");
    const results = $("forge-normal-results");
    const gallery = $("forge-normal-gallery");
    const aside = $("forge-settings-rail");
    const devices = $("forge-devices");
    const sweep = $("forge-sweep");
    const night = $("forge-night");
    const batch = $("forge-fleet-batch");
    if (aside && devices) {
      const advanced = aside.querySelector(".forge-advanced");
      const presets = $("forge-presets");
      aside.insertBefore(devices, advanced || presets || null);
    }
    if (form && action && results) {
      shell.insertBefore(results, form.nextSibling);
      shell.insertBefore(action, results);
      if (gallery) shell.insertBefore(gallery, results.nextSibling);
      const afterGallery = gallery || results;
      if (sweep) shell.insertBefore(sweep, afterGallery.nextSibling);
      if (night) shell.insertBefore(night, afterGallery.nextSibling);
      if (batch && gallery) shell.insertBefore(batch, gallery.nextSibling);
    }
    shell.dataset.composed = "1";
  }

  /* ------------------------------------------------------------------ modes */
  function modeButtons() {
    return ["forge-mode-generate", "forge-seance-open", "forge-library-open"].map($).filter(Boolean);
  }

  function syncModeGlide() {
    const bar = $("forge-modebar");
    const active = bar && bar.querySelector('.forge-mode[aria-pressed="true"]');
    if (!bar || !active) return;
    if (!modeGlide || !modeGlide.isConnected) {
      modeGlide = document.createElement("span");
      modeGlide.className = "forge-mode-glide";
      modeGlide.setAttribute("aria-hidden", "true");
      bar.insertBefore(modeGlide, bar.firstChild);
      bar.classList.add("has-mode-glide");
    }
    modeGlide.style.width = active.offsetWidth + "px";
    modeGlide.style.transform = "translateX(" + active.offsetLeft + "px)";
  }

  /* Générer is the only view. Séance and Bibliothèque are actions (a workspace
     dialog and a jump to the gallery), so nothing else is ever "pressed" and the
     control no longer promises a tab switch it does not perform. */
  function setMode(name) {
    const studio = $("forge-studio");
    const generate = $("forge-mode-generate");
    if (generate) generate.setAttribute("aria-pressed", "true");
    if (studio) studio.dataset.forgeMode = name || "generate";
    syncModeGlide();
    requestAnimationFrame(syncModeGlide);
  }

  window.addEventListener("resize", () => requestAnimationFrame(syncModeGlide), { passive: true });

  function entryButtons() {
    const seance = $("forge-seance-open");
    const libraryButton = $("forge-library-open");
    const generate = $("forge-mode-generate");
    if (generate) generate.addEventListener("click", () => {
      setMode("generate");
      $("forge-prompt")?.focus();
      $("forge-modebar")?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    if (seance) {
      seance.title = "Une idée, ses brouillons, son contact sheet";
      seance.addEventListener("click", () => openSeance());
    }
    if (libraryButton) {
      libraryButton.title = "Chercher, filtrer et trier la galerie normale";
      libraryButton.addEventListener("click", () => {
        const gallery = $("forge-normal-gallery");
        if (gallery) gallery.scrollIntoView({ block: "start", behavior: "smooth" });
        setTimeout(() => $("forge-gallery-q")?.focus({ preventScroll: true }), 280);
      });
    }
  }

  /* ------------------------------------------------------------- brief card */
  let briefRefs = [];
  const briefRefCache = new Map();

  function markBriefChips(box, seen) {
    if (!box) return 0;
    const nodes = [...box.querySelectorAll("[data-chip-key]")];
    let fresh = 0;
    nodes.forEach((node) => {
      const key = node.dataset.chipKey;
      if (!briefFirstRender && key && !seen.has(key)) {
        node.classList.add("is-new");
        fresh += 1;
        setTimeout(() => node.classList.remove("is-new"), 520);
      }
    });
    seen.clear();
    nodes.forEach((node) => { if (node.dataset.chipKey) seen.add(node.dataset.chipKey); });
    return fresh;
  }

  function renderBrief() {
    const prompt = $("forge-prompt");
    const loras = lorasIn(prompt ? prompt.value : "");
    const loraBox = $("forge-brief-loras");
    if (loraBox) {
      loraBox.hidden = !loras.length;
      loraBox.innerHTML = loras.map((lora) => {
        const key = "lora:" + lora.name + ":" + lora.weight;
        return `<span class="forge-chip forge-chip-lora" data-chip-key="${esc(key)}">LoRA ${esc(lora.name)}${lora.weight !== 1 ? " · " + String(lora.weight).replace(".", ",") : ""}</span>`;
      }).join("");
      const freshLoras = markBriefChips(loraBox, seenLoraChips);
      if (freshLoras) {
        const count = $("forge-prompt-count");
        if (count) {
          count.classList.remove("is-ticking");
          void count.offsetWidth;
          count.classList.add("is-ticking");
          setTimeout(() => count.classList.remove("is-ticking"), 360);
        }
      }
    }
    const refBox = $("forge-brief-refs");
    if (refBox) {
      const shown = briefRefs.filter((id) => briefRefCache.has(id));
      refBox.hidden = !shown.length;
      refBox.innerHTML = shown.map((id) => `<span class="forge-brief-ref" data-chip-key="ref:${esc(id)}"><img src="${esc(briefRefCache.get(id))}" alt=""/><span>${esc(clip(id.replace(/^img-/, ""), 8))}</span></span>`).join("");
      const fresh = markBriefChips(refBox, seenRefChips);
      if (fresh) {
        const count = $("forge-prompt-count");
        if (count) {
          count.classList.remove("is-ticking");
          void count.offsetWidth;
          count.classList.add("is-ticking");
          setTimeout(() => count.classList.remove("is-ticking"), 360);
        }
      }
    }
    briefFirstRender = false;
    const meta = $("forge-brief-meta");
    if (meta) {
      const words = prompt ? prompt.value.trim().split(/\s+/).filter(Boolean).length : 0;
      meta.textContent = (briefRefs.length ? briefRefs.length + " réf. · " : "") + (loras.length ? loras.length + " LoRA · " : "") + words + " mot" + (words > 1 ? "s" : "");
    }
  }

  async function setBriefRefs(ids) {
    briefRefs = Array.isArray(ids) ? ids.slice(0, 6) : [];
    renderBrief();
    for (const id of briefRefs) {
      if (!id || briefRefCache.has(id)) continue;
      try {
        const detail = await H.api("/api/forge/gallery/" + encodeURIComponent(id), { cache: "no-store" });
        if (detail && detail.thumb) { briefRefCache.set(id, detail.thumb); renderBrief(); }
      } catch (_) { /* reference removed: keep the brief quiet */ }
    }
  }

  /* --------------------------------------------------------- generate tray */
  function optionSignature(select) {
    return [...select.options].map((option) => option.value + "\u0000" + option.textContent).join("\u0001");
  }

  function fillBarModel() {
    const source = $("forge-checkpoint");
    const bar = $("forge-bar-model");
    if (!source || !bar) return;
    const signature = optionSignature(source);
    if (bar.dataset.signature !== signature) {
      bar.innerHTML = [...source.options].map((option) => `<option value="${esc(option.value)}">${esc(option.textContent)}</option>`).join("");
      bar.dataset.signature = signature;
    }
    if (document.activeElement !== bar) bar.value = source.value;
  }

  function syncBarFromForm() {
    const format = $("forge-bar-size");
    if (format) {
      const wanted = ($("forge-width")?.value || "") + "x" + ($("forge-height")?.value || "");
      format.value = [...format.options].some((option) => option.value === wanted) ? wanted : "";
    }
    const steps = $("forge-bar-steps");
    if (steps && document.activeElement !== steps && $("forge-steps")) steps.value = $("forge-steps").value;
    const count = $("forge-bar-count");
    if (count && document.activeElement !== count && $("forge-iter")) count.value = $("forge-iter").value;
    fillBarModel();
  }

  function pushToForm(target, value) {
    if (!target) return;
    target.value = value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function initBarControls() {
    const model = $("forge-bar-model");
    const sourceModel = $("forge-checkpoint");
    if (model && sourceModel) {
      model.addEventListener("change", () => pushToForm(sourceModel, model.value));
      new MutationObserver(fillBarModel).observe(sourceModel, { childList: true, subtree: true });
    }
    const format = $("forge-bar-size");
    if (format && ![...format.options].some((option) => option.value === "")) {
      format.insertAdjacentHTML("afterbegin", '<option value="">Libre</option>');
    }
    if (format) format.addEventListener("change", () => {
      if (!format.value) return;
      const [width, height] = format.value.split("x");
      pushToForm($("forge-width"), width);
      pushToForm($("forge-height"), height);
      document.querySelectorAll(".forge-ratio").forEach((button) => {
        button.setAttribute("aria-pressed", button.dataset.width === width && button.dataset.height === height ? "true" : "false");
      });
    });
    const steps = $("forge-bar-steps");
    if (steps) steps.addEventListener("input", () => pushToForm($("forge-steps"), steps.value));
    const count = $("forge-bar-count");
    if (count) count.addEventListener("change", () => pushToForm($("forge-iter"), count.value));
    document.addEventListener("input", (event) => {
      if (event.target && ["forge-steps", "forge-width", "forge-height", "forge-checkpoint", "forge-iter"].includes(event.target.id)) syncBarFromForm();
    });
    document.addEventListener("change", (event) => {
      if (event.target && ["forge-steps", "forge-width", "forge-height", "forge-checkpoint", "forge-iter"].includes(event.target.id)) syncBarFromForm();
    });
    syncBarFromForm();
  }

  /* ------------------------------------------------------- settings sheet */
  function initSettingsSheet() {
    const studio = $("forge-studio");
    const rail = $("forge-settings-rail");
    const open = $("forge-settings-open");
    const close = $("forge-settings-close");
    if (!studio || !rail || !open) return;
    const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
    let scrim = $("forge-settings-scrim");
    if (!scrim) {
      scrim = document.createElement("div");
      scrim.id = "forge-settings-scrim";
      scrim.className = "forge-settings-scrim";
      scrim.hidden = true;
      scrim.setAttribute("aria-hidden", "true");
      studio.appendChild(scrim);
    }
    let lastFocus = null;
    const mobileSheet = () => getComputedStyle(rail).position === "fixed";
    const focusables = () => [...rail.querySelectorAll(FOCUSABLE)].filter((node) => {
      const closed = node.closest("details:not([open])");
      const ownSummary = closed && node.tagName === "SUMMARY" && node.parentElement === closed;
      if (node.offsetParent === null || node.closest("[hidden]") || (closed && !ownSummary) || node.matches('input[type="file"]')) return false;
      const box = node.getBoundingClientRect();
      return box.width > 1 && box.height > 1 && getComputedStyle(node).visibility !== "hidden";
    });

    const setOpen = (state) => {
      if (studio.classList.contains("settings-open") === state) return;
      lastFocus = state ? document.activeElement : lastFocus;
      studio.classList.toggle("settings-open", state);
      open.setAttribute("aria-expanded", state ? "true" : "false");
      const modal = state && mobileSheet();
      scrim.hidden = !modal;
      document.documentElement.classList.toggle("forge-sheet-open", Boolean(modal));
      if (modal) {
        rail.setAttribute("role", "dialog");
        rail.setAttribute("aria-modal", "true");
        rail.setAttribute("tabindex", "-1");
        (close && close.offsetParent !== null ? close : focusables()[0] || rail).focus();
      } else {
        rail.removeAttribute("role");
        rail.removeAttribute("aria-modal");
        rail.removeAttribute("tabindex");
        if (!state) {
          const restore = lastFocus && document.contains(lastFocus) ? lastFocus : open;
          restore.focus();
          lastFocus = null;
        }
      }
    };

    open.addEventListener("click", () => setOpen(!studio.classList.contains("settings-open")));
    close?.addEventListener("click", () => setOpen(false));
    scrim.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (event) => {
      if (!studio.classList.contains("settings-open") || !mobileSheet()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusables();
      if (!nodes.length) {
        event.preventDefault();
        rail.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !rail.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !rail.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  /* ---------------------------------------------------- contact sheet tools */
  let selectMode = false;
  const selectedResults = new Set();

  function resultCards() { return [...document.querySelectorAll("#forge-results .forge-card")]; }

  function renderSelection() {
    const count = selectedResults.size;
    const label = $("forge-select-count");
    if (label) label.textContent = count + " sélectionnée" + (count > 1 ? "s" : "");
    const toggle = $("forge-select-toggle");
    if (toggle) toggle.setAttribute("aria-pressed", selectMode ? "true" : "false");
    const actions = $("forge-contact-actions");
    if (actions) actions.hidden = !selectMode;
    document.querySelectorAll("[data-cact]").forEach((button) => {
      const kind = button.dataset.cact;
      button.disabled = kind === "compare" ? count !== 2 : count === 0;
    });
    resultCards().forEach((card) => {
      const on = selectMode && selectedResults.has(card.dataset.id);
      card.classList.toggle("is-selected", on);
      card.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function selectedIds() { return [...selectedResults].filter((id) => /^img-/.test(id)); }

  async function detailOf(id) { return H.api("/api/forge/gallery/" + encodeURIComponent(id), { cache: "no-store" }); }

  function renderCompareStage(first, second, altA, altB) {
    const stage = $("forge-seance-compare-stage");
    if (!stage) return;
    stage.innerHTML = `
      <div class="forge-wipe-frame forge-wipe-b"><img src="${esc(second.original || second.thumb)}" alt="${esc(altB)}"/></div>
      <div class="forge-wipe-frame forge-wipe-a"><img src="${esc(first.original || first.thumb)}" alt="${esc(altA)}"/></div>
      <span class="forge-wipe-tag forge-wipe-tag-a">A</span><span class="forge-wipe-tag forge-wipe-tag-b">B</span>
      <span class="forge-wipe-line" aria-hidden="true"></span>
      <button type="button" class="forge-wipe-handle" role="slider" aria-label="Comparer A et B" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" aria-valuetext="50 % de A, 50 % de B"><span aria-hidden="true">&#8596;</span></button>`;
    setCompareWipe(50);
    bindCompareWipe();
  }

  function setCompareWipe(value) {
    const stage = $("forge-seance-compare-stage");
    if (!stage) return;
    const pct = Math.max(0, Math.min(100, Number(value) || 0));
    stage.style.setProperty("--wipe", pct + "%");
    const handle = stage.querySelector(".forge-wipe-handle");
    if (handle) {
      handle.setAttribute("aria-valuenow", String(Math.round(pct)));
      handle.setAttribute("aria-valuetext", Math.round(pct) + " % de A, " + Math.round(100 - pct) + " % de B");
    }
  }

  function bindCompareWipe() {
    const stage = $("forge-seance-compare-stage");
    if (!stage || stage.dataset.wipeBound === "1") return;
    stage.dataset.wipeBound = "1";
    let dragging = false;
    const moveTo = (clientX) => {
      const box = stage.getBoundingClientRect();
      if (!box.width) return;
      setCompareWipe(((clientX - box.left) / box.width) * 100);
    };
    stage.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      if (event.target !== stage && !event.target.closest(".forge-wipe-frame, .forge-wipe-handle")) return;
      dragging = true;
      try { stage.setPointerCapture(event.pointerId); } catch (_) { /* older browsers */ }
      moveTo(event.clientX);
      event.preventDefault();
    });
    stage.addEventListener("pointermove", (event) => { if (dragging) moveTo(event.clientX); });
    const stop = () => { dragging = false; };
    stage.addEventListener("pointerup", stop);
    stage.addEventListener("pointercancel", stop);
    stage.addEventListener("keydown", (event) => {
      if (!event.target.closest(".forge-wipe-handle")) return;
      const handle = event.target.closest(".forge-wipe-handle");
      const current = Number(handle.getAttribute("aria-valuenow")) || 50;
      let next = current;
      if (event.key === "ArrowLeft") next -= 5;
      else if (event.key === "ArrowRight") next += 5;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = 100;
      else return;
      event.preventDefault();
      setCompareWipe(next);
    });
  }

  function openComparePair(first, second) {
    renderCompareStage(first, second, "Image A", "Image B");
    $("forge-seance-compare-note").textContent = "Glisse la poignée pour passer de A à B. Les deux images restent dans la galerie. Rien n'est envoyé hors de cet HQ.";
    compareDialog.showModal();
  }

  function initSelection() {
    const toggle = $("forge-select-toggle");
    const grid = $("forge-results");
    if (!toggle || !grid) return;
    toggle.addEventListener("click", () => {
      selectMode = !selectMode;
      if (!selectMode) selectedResults.clear();
      renderSelection();
    });
    grid.addEventListener("click", (event) => {
      if (!selectMode) return;
      const card = event.target.closest(".forge-card");
      if (!card || !card.dataset.id) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (selectedResults.has(card.dataset.id)) selectedResults.delete(card.dataset.id);
      else selectedResults.add(card.dataset.id);
      renderSelection();
    }, true);
    new MutationObserver(() => renderSelection()).observe(grid, { childList: true });
    document.querySelectorAll("[data-cact]").forEach((button) => button.addEventListener("click", async () => {
      const ids = selectedIds();
      const what = button.dataset.cact;
      if (!ids.length) return;
      if (what === "keep") {
        try {
          for (const id of ids) await H.api("/api/forge/gallery/" + encodeURIComponent(id) + "/triage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "keep" }) });
          H.loadGallery();
          toast(ids.length + " image" + (ids.length > 1 ? "s gardées." : " gardée."));
        } catch (error) { toast(error.message || "Le tri n’a pas été enregistré."); }
      }
      if (what === "compare" && ids.length === 2) {
        try { const [a, b] = await Promise.all(ids.map(detailOf)); openComparePair(a, b); }
        catch (error) { toast(error.message || "La comparaison n’a pas pu s’ouvrir."); }
      }
      if (what === "finish") {
        H.openImage(ids[0]).then(() => setTimeout(() => {
          const finish = $("forge-viewer-finish");
          finish?.scrollIntoView({ block: "center", behavior: "smooth" });
          finish?.querySelector("select")?.focus();
        }, 220)).catch((error) => toast(error.message || "L’image n’a pas pu s’ouvrir."));
      }
      if (what === "tag") {
        const tags = window.prompt("Étiquettes à appliquer (séparées par une virgule)", "");
        if (tags === null) return;
        const list = tags.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
        if (!list.length) return;
        try {
          for (const id of ids) await H.api("/api/forge/library/labels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, tags: list, collection: "" }) });
          toast("Étiquettes enregistrées.");
        } catch (error) { toast(error.message || "Les étiquettes n’ont pas été enregistrées."); }
      }
      if (what === "export") {
        try { exportSidecar(await Promise.all(ids.map(detailOf))); }
        catch (error) { toast(error.message || "L’export n’a pas abouti."); }
      }
    }));
    renderSelection();
  }

  function appendDialog(id, className, html) {
    let dialog = $(id);
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = id;
    dialog.className = className;
    dialog.innerHTML = html;
    document.body.appendChild(dialog);
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    return dialog;
  }

  /* --------------------------------------------------------------- séances */
  const seanceDialog = appendDialog("forge-seance-dialog", "forge-sheet forge-studio-dialog", `
    <div class="forge-studio-inner">
      <header class="forge-viewer-bar">
        <div><p class="forge-studio-kicker">Une idée, un espace</p><h2 id="forge-seance-title">Séance</h2></div>
        <button type="button" class="secondary" data-sclose>Fermer</button>
      </header>
      <div class="forge-studio-layout">
        <aside class="forge-studio-aside" aria-label="Séances">
          <button type="button" id="forge-seance-new">Nouvelle séance</button>
          <label for="forge-seance-pick">Mes séances</label>
          <select id="forge-seance-pick"></select>
          <p id="forge-seance-list-note" class="forge-note">Les séances ne contiennent que la galerie normale.</p>
        </aside>
        <section id="forge-seance-workspace" class="forge-seance-workspace" aria-live="polite">
          <p class="forge-note">Choisis une séance, ou crées-en une depuis l’idée en cours.</p>
        </section>
      </div>
      <p id="forge-seance-status" class="forge-note" role="status"></p>
    </div>`);

  const newSeanceDialog = appendDialog("forge-seance-new-dialog", "forge-sheet forge-studio-dialog forge-studio-small", `
    <form method="dialog" id="forge-seance-new-form">
      <header class="forge-viewer-bar"><h2>Nouvelle séance</h2><button type="button" class="secondary" data-close-new>Fermer</button></header>
      <label for="forge-seance-name">Nom</label>
      <input id="forge-seance-name" type="text" maxlength="80" required autocomplete="off"/>
      <label for="forge-seance-note-new">Note de départ</label>
      <textarea id="forge-seance-note-new" rows="3" maxlength="1000" placeholder="Ce que tu cherches, ce qui doit rester"></textarea>
      <div class="forge-label-row"><span>Références (facultatif)</span><button type="button" class="secondary" id="forge-seance-pick-refs">Choisir des images</button></div>
      <div id="forge-seance-ref-list" class="forge-seance-refs"></div>
      <p class="forge-note">La séance garde le prompt et les réglages du formulaire. Aucun contenu du coffre privé.</p>
      <button type="submit" id="forge-seance-create">Créer la séance</button>
    </form>`);

  function closeSeance() { if (seanceDialog.open) seanceDialog.close(); }

  async function loadSeances(selectId) {
    const out = await H.api("/api/forge/seances", { cache: "no-store" });
    seances = Array.isArray(out.sessions) ? out.sessions : [];
    const pick = $("forge-seance-pick");
    if (!pick) return;
    pick.innerHTML = seances.length ? seances.map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${item.image_count || 0}</option>`).join("") : `<option value="">Aucune séance</option>`;
    $("forge-seance-list-note").textContent = seances.length ? "Les séances ne contiennent que la galerie normale." : "Aucune séance. Crée la première depuis l’idée en cours.";
    const wanted = selectId || (currentSeance && currentSeance.id) || (seances[0] && seances[0].id);
    if (wanted) {
      pick.value = wanted;
      await openSeanceById(wanted, false);
    } else {
      currentSeance = null;
      $("forge-seance-workspace").innerHTML = `<div class="forge-studio-empty"><h3>Un espace par idée</h3><p>Prompt, brouillons, notes, contact sheet, finitions. Tout reste dans la galerie normale.</p><button type="button" id="forge-seance-empty-new">Créer une séance</button></div>`;
      const button = $("forge-seance-empty-new");
      if (button) button.addEventListener("click", openNewSeance);
    }
  }

  async function openSeance() {
    seanceDialog.showModal();
    $("forge-seance-status").textContent = "Lecture des séances…";
    try {
      await loadSeances();
      $("forge-seance-status").textContent = "";
    } catch (error) {
      $("forge-seance-status").textContent = error.message || "Les séances n’ont pas pu être lues.";
    }
  }

  async function openSeanceById(id, showDialog) {
    if (!id) return;
    if (showDialog) seanceDialog.showModal();
    if (!currentSeance || currentSeance.id !== id) comparePicks = [];
    const out = await H.api("/api/forge/seances/" + encodeURIComponent(id), { cache: "no-store" });
    currentSeance = out.session;
    setBriefRefs(Array.isArray(currentSeance.reference_ids) ? currentSeance.reference_ids : []);
    renderSeance(currentSeance);
  }

  function openNewSeance() {
    if (H.sweepContext && H.sweepContext().privateMode) {
      toast("Les séances restent en mode Galerie.");
      return;
    }
    const form = $("forge-seance-new-form");
    form.reset();
    $("forge-seance-name").value = clip(document.getElementById("forge-prompt")?.value || "Nouvelle séance", 80);
    $("forge-seance-ref-list").innerHTML = "";
    $("forge-seance-ref-list").dataset.ids = "[]";
    if (!newSeanceDialog.open) newSeanceDialog.showModal();
    $("forge-seance-name").focus();
  }

  async function chooseReferences() {
    const picked = await pickImages("Références de la séance", 8, []);
    if (picked === null) return;
    $("forge-seance-ref-list").innerHTML = picked.map((id) => `<span class="forge-chip">${esc(id)}</span>`).join("");
    $("forge-seance-ref-list").dataset.ids = JSON.stringify(picked);
  }

  $("forge-seance-pick").addEventListener("change", (event) => {
    if (event.target.value) openSeanceById(event.target.value, false).catch((error) => toast(error.message));
  });
  $("forge-seance-new").addEventListener("click", openNewSeance);
  $("forge-seance-pick-refs").addEventListener("click", chooseReferences);
  $("forge-seance-new-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("forge-seance-name").value.trim();
    if (!name) return;
    const ctx = H.sweepContext ? H.sweepContext() : { settings: {}, privateMode: false };
    if (ctx.privateMode) { toast("Les séances restent en mode Galerie."); return; }
    const refs = JSON.parse($("forge-seance-ref-list").dataset.ids || "[]");
    try {
      const out = await H.api("/api/forge/seances", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name, prompt: document.getElementById("forge-prompt")?.value || "", negative_prompt: document.getElementById("forge-negative")?.value || "", note: $("forge-seance-note-new").value, reference_ids: refs, settings: ctx.settings })
      });
      newSeanceDialog.close();
      currentSeance = out.session;
      await loadSeances(currentSeance.id);
      toast("Séance créée.");
    } catch (error) { toast(error.message || "La séance n’a pas pu être créée."); }
  });
  document.querySelectorAll("[data-close-new]").forEach((button) => button.addEventListener("click", () => newSeanceDialog.close()));
  document.querySelectorAll("[data-sclose]").forEach((button) => button.addEventListener("click", closeSeance));

  function triageLabel(value) { return value === "keep" ? "Gardée" : value === "favorite" ? "Favori" : value === "reject" ? "Rejetée" : "À trier"; }

  const CONTINUITY_FIELDS = [
    ["character", "Personnage"], ["setting", "Décor"], ["palette", "Palette"],
    ["light", "Lumière"], ["camera", "Cadrage"]
  ];

  function continuityText(session) {
    const values = (session && session.continuity) || {};
    return CONTINUITY_FIELDS.map(([key, label]) => values[key] ? label + " : " + values[key] : "").filter(Boolean).join(", ");
  }

  function readContinuity() {
    const values = {};
    document.querySelectorAll("[data-continuity]").forEach((input) => { values[input.dataset.continuity] = input.value.trim(); });
    return values;
  }

  function renderSeance(session) {
    if (!session) return;
    const images = Array.isArray(session.images) ? session.images : [];
    const counts = { keep: 0, favorite: 0, reject: 0, none: 0 };
    images.forEach((image) => { counts[image.triage] = (counts[image.triage] || 0) + 1; });
    const settings = session.settings || {};
    const recipe = [settings.checkpoint, settings.steps ? settings.steps + " pas" : "", settings.cfg_scale ? "CFG " + settings.cfg_scale : "", settings.seed != null ? "graine " + settings.seed : ""].filter(Boolean).join(" · ");
    const times = images.map((image) => image.created).filter(Boolean).sort();
    const elapsed = times.length > 1 ? Math.max(0, Math.round((new Date(times[times.length - 1]) - new Date(times[0])) / 60000)) : null;
    const refs = Array.isArray(session.reference_ids) ? session.reference_ids : [];
    const continuity = session.continuity || {};
    $("forge-seance-title").textContent = session.name;
    $("forge-seance-workspace").innerHTML = `
      <div class="forge-seance-head">
        <div><h3>${esc(session.name)}</h3><p class="forge-note">${esc(clip(session.prompt || settings.prompt || "Sans prompt", 180))}</p></div>
        <span class="forge-seance-badge">${session.image_count || images.length} image${(session.image_count || images.length) > 1 ? "s" : ""}</span>
      </div>
      <section class="forge-redline" aria-label="Fil rouge de la séance">
        <div class="forge-redline-head"><div><h3>Fil rouge</h3><p class="forge-note">Ce qui ne change pas d’une prise à l’autre. Le fil est ajouté aux prochains lancements.</p></div><span class="forge-redline-badge">continuité</span></div>
        <div class="forge-redline-fields">${CONTINUITY_FIELDS.map(([key, label]) => `<label>${label}<input data-continuity="${esc(key)}" maxlength="200" value="${esc(continuity[key] || "")}" placeholder="à garder"/></label>`).join("")}</div>
        <div class="forge-actions"><button type="button" data-saction="save-redline">Garder le fil</button><button type="button" class="secondary" data-saction="redline-prompt">Mettre dans le prompt</button></div>
        <p class="forge-note" id="forge-redline-status" role="status" aria-live="polite"></p>
      </section>
      <div class="forge-seance-actions">
        <label class="forge-seance-count">Brouillons <input id="forge-seance-count" type="number" min="4" max="16" step="1" value="4"/></label>
        <button type="button" data-saction="launch">Lancer sur la flotte</button>
        <button type="button" class="secondary" data-saction="refresh">Rafraîchir</button>
        <button type="button" class="secondary" data-saction="refs">Références</button>
        <button type="button" class="secondary" data-saction="compare" ${images.filter((i) => comparePicks.includes(i.id)).length === 2 ? "" : "disabled"}>Comparer</button>
        <button type="button" class="secondary" data-saction="sheet" ${images.length ? "" : "disabled"}>Planche</button>
        <button type="button" class="secondary" data-saction="archive">${session.archived ? "Réactiver" : "Archiver"}</button>
        <button type="button" class="secondary" data-saction="delete">Supprimer</button>
      </div>
      <p class="forge-note" id="forge-seance-launch-note" role="status">Les brouillons utilisent les réglages enregistrés dans la séance. La flotte ne reçoit jamais le coffre.</p>
      <div class="forge-seance-recipe"><strong>Recette de départ</strong><span>${esc(recipe || "Réglages du formulaire")}</span></div>
      <div class="forge-seance-refs">${refs.length ? refs.map((id) => `<span class="forge-chip">${esc(id)}</span>`).join("") : `<span class="forge-note">Aucune référence.</span>`}</div>
      <section class="forge-storyboard" aria-label="Storyboard de la séance">
        <div class="forge-storyboard-head"><h3>Storyboard</h3><span class="forge-note">${images.length ? "Dans l’ordre des prises" : "Les prises apparaîtront ici dans l’ordre"}</span></div>
        ${images.length ? `<ol>${images.slice(0, 12).map((image, index) => `<li><button type="button" class="forge-storyboard-frame" data-sopen="${esc(image.id)}"><img loading="lazy" src="${esc(image.thumb)}" alt="Prise ${index + 1}"/><span>${String(index + 1).padStart(2, "0")}</span></button><small class="forge-triage-tag" data-triage="${esc(image.triage)}">${triageLabel(image.triage)}</small></li>`).join("")}</ol>${images.length > 12 ? `<p class="forge-note">Les 12 premières prises sont ici ; la planche complète reste juste en dessous.</p>` : ""}` : `<div class="forge-storyboard-empty"><div class="forge-storyboard-empty-frames" aria-hidden="true"><span></span><span></span><span></span></div><p>Chaque prise apparaîtra ici dans l’ordre du fil.</p></div>`}
      </section>
      <label for="forge-seance-note">Notes entre les prises</label>
      <textarea id="forge-seance-note" rows="3" maxlength="1000" placeholder="Ce qui a changé, ce qui reste">${esc(session.note || "")}</textarea>
      <button type="button" class="secondary" data-saction="save-note">Enregistrer la note</button>
      <div class="forge-seance-grid">${images.length ? images.map((image) => `
        <figure class="forge-seance-card" data-id="${esc(image.id)}">
          <label class="forge-seance-check"><input type="checkbox" data-scompare="${esc(image.id)}" ${comparePicks.includes(image.id) ? "checked" : ""}/> comparer</label>
          <button type="button" class="forge-seance-image" data-sopen="${esc(image.id)}"><img loading="lazy" src="${esc(image.thumb)}" alt="Prise ${esc(image.id)}"/></button>
          <figcaption><span class="forge-triage-tag" data-triage="${esc(image.triage)}">${triageLabel(image.triage)}</span><span class="forge-note">${esc((image.created || "").slice(0, 16).replace("T", " "))}</span></figcaption>
          <div class="forge-seance-card-actions">
            <button type="button" data-striage="keep" data-sid="${esc(image.id)}">Garder</button>
            <button type="button" class="secondary" data-striage="favorite" data-sid="${esc(image.id)}">Favori</button>
            <button type="button" class="secondary" data-striage="reject" data-sid="${esc(image.id)}">Rejeter</button>
            <button type="button" class="secondary" data-sfinish="${esc(image.id)}">Finir</button>
          </div>
        </figure>`).join("") : `<div class="forge-studio-empty"><p>Le contact sheet est encore vide. Lance les premiers brouillons.</p></div>`}</div>
      <section class="forge-seance-summary" aria-label="Résumé de la séance">
        <h3>Clôture</h3>
        <p><strong>${counts.keep + counts.favorite}</strong> gardée(s) · <strong>${counts.favorite}</strong> favorite(s) · <strong>${counts.reject}</strong> rejetée(s) · <strong>${counts.none}</strong> à trier.</p>
        <p class="forge-note">${elapsed == null ? "Temps : encore trop tôt pour le mesurer." : "Temps entre la première et la dernière prise : " + elapsed + " min."} ${recipe ? "Recette : " + esc(recipe) + "." : ""}</p>
      </section>`;
  }

  seanceDialog.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-saction]");
    const triage = event.target.closest("[data-striage]");
    const open = event.target.closest("[data-sopen]");
    const finish = event.target.closest("[data-sfinish]");
    const compare = event.target.closest("[data-scompare]");
    if (event.target.closest("[data-sclose]")) { closeSeance(); return; }
    if (open) { closeSeance(); H.openImage(open.dataset.sopen).catch((error) => toast(error.message)); return; }
    if (finish) { await finishImage(finish.dataset.sfinish); return; }
    if (compare) {
      const id = compare.dataset.scompare;
      comparePicks = compare.checked ? (comparePicks.includes(id) ? comparePicks : comparePicks.concat(id).slice(-2)) : comparePicks.filter((item) => item !== id);
      if (currentSeance) renderSeance(currentSeance);
      return;
    }
    if (triage) {
      try {
        await H.api("/api/forge/gallery/" + encodeURIComponent(triage.dataset.sid) + "/triage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: triage.dataset.striage }) });
        H.loadGallery();
        await openSeanceById(currentSeance.id, false);
      } catch (error) { toast(error.message || "Le tri n’a pas été enregistré."); }
      return;
    }
    if (!action) return;
    const what = action.dataset.saction;
    if (what === "launch") launchSession();
    if (what === "refresh") openSeanceById(currentSeance.id, false).catch((error) => toast(error.message));
    if (what === "refs") {
      const picked = await pickImages("Références de la séance", 8, currentSeance.reference_ids || []);
      if (picked !== null) H.api("/api/forge/seances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "update", id: currentSeance.id, reference_ids: picked }) }).then(() => openSeanceById(currentSeance.id, false)).catch((error) => toast(error.message));
    }
    if (what === "save-redline") {
      if (H.sweepContext && H.sweepContext().privateMode) { toast("Le fil rouge reste en mode Galerie."); return; }
      try {
        await H.api("/api/forge/seances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "update", id: currentSeance.id, continuity: readContinuity() }) });
        toast("Fil rouge enregistré.");
        await openSeanceById(currentSeance.id, false);
      } catch (error) { toast(error.message || "Le fil rouge n’a pas été enregistré."); }
    }
    if (what === "redline-prompt") {
      const text = continuityText({ continuity: readContinuity() });
      if (!text) { toast("Renseigne au moins un élément du fil rouge."); return; }
      const prompt = $("forge-prompt");
      if (prompt) {
        const current = prompt.value.replace(/[\s,]+$/, "");
        prompt.value = (current ? current + ", " + text : text).slice(0, 2000);
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const line = $("forge-redline-status");
      if (line) line.textContent = "Le fil est dans le prompt. Lance quand tu veux.";
    }
    if (what === "save-note") {
      try {
        await H.api("/api/forge/seances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "update", id: currentSeance.id, note: $("forge-seance-note").value }) });
        toast("Note enregistrée.");
        await openSeanceById(currentSeance.id, false);
      } catch (error) { toast(error.message || "La note n’a pas été enregistrée."); }
    }
    if (what === "archive") {
      try {
        await H.api("/api/forge/seances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "update", id: currentSeance.id, archived: !currentSeance.archived }) });
        await loadSeances(currentSeance.id);
      } catch (error) { toast(error.message); }
    }
    if (what === "delete") {
      if (!window.confirm("Supprimer cette séance ? Les images de la galerie restent en place.")) return;
      try {
        await H.api("/api/forge/seances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id: currentSeance.id }) });
        currentSeance = null;
        comparePicks = [];
        await loadSeances();
        toast("Séance supprimée. Les images restent dans la galerie.");
      } catch (error) { toast(error.message); }
    }
    if (what === "compare") openCompare();
    if (what === "sheet") contactSheet(imagesFromCurrent(), currentSeance.name);
  });

  function imagesFromCurrent() { return currentSeance && Array.isArray(currentSeance.images) ? currentSeance.images : []; }

  /* Le Casting uses the open séance's existing reference channel. The card's
     references are normal-gallery ids only; private mode never reaches this path. */
  async function addReferences(ids) {
    if (!currentSeance || !Array.isArray(ids) || !ids.length) return false;
    if (H.sweepContext && H.sweepContext().privateMode) { toast("Les séances restent en mode Galerie."); return false; }
    const merged = [...new Set([...(currentSeance.reference_ids || []), ...ids])].slice(0, 8);
    if (merged.length === (currentSeance.reference_ids || []).length) return false;
    try {
      await H.api("/api/forge/seances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "update", id: currentSeance.id, reference_ids: merged }) });
      await openSeanceById(currentSeance.id, false);
      return true;
    } catch (error) { toast(error.message || "Les références n'ont pas pu être ajoutées."); return false; }
  }

  async function launchSession() {
    const status = $("forge-seance-launch-note");
    if (!currentSeance || !H.sweepContext) return;
    const ctx = H.sweepContext();
    if (ctx.privateMode) { status.textContent = "Les séances restent en mode Galerie."; return; }
    if (!ctx.workers || !ctx.workers.length) { status.textContent = "Choisis au moins un appareil dans la flotte."; return; }
    const count = Math.max(4, Math.min(16, Number($("forge-seance-count").value) || 4));
    const settings = Object.assign({}, currentSeance.settings && currentSeance.settings.prompt ? currentSeance.settings : ctx.settings);
    delete settings.n_iter; delete settings.batch_size; delete settings.destination;
    if (!settings.prompt && currentSeance.prompt) settings.prompt = currentSeance.prompt;
    if (!settings.negative_prompt && currentSeance.negative_prompt) settings.negative_prompt = currentSeance.negative_prompt;
    const thread = continuityText(currentSeance);
    if (thread) settings.prompt = [settings.prompt, thread].filter(Boolean).join(", ").slice(0, 2000);
    status.textContent = "Envoi de " + count + " brouillons…";
    try {
      const out = await H.api("/api/forge/batches", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key("seance") },
        body: JSON.stringify({ workers: ctx.workers, count, settings, destination: "normal" })
      });
      const batch = out.batch;
      const batchId = batch && (batch.batch_id || batch.id);
      if (!batchId) throw new Error("Le lot n’a pas d’identifiant.");
      status.textContent = "Brouillons en cours. Les images arriveront ici au fil de l’eau.";
      await H.api("/api/forge/seances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "attach", id: currentSeance.id, batch_id: batchId }) });
      H.startBatch(batch);
      pollBatch(batchId, currentSeance.id, null);
    } catch (error) {
      status.textContent = error.message || "Les brouillons n’ont pas pu partir.";
    }
  }

  async function pollBatch(batchId, sessionId, parentId) {
    let last = 0;
    const attached = new Set();
    for (let attempt = 0; attempt < 240; attempt += 1) {
      await sleep(2000);
      let batch;
      try {
        const out = await H.api("/api/forge/batches/" + encodeURIComponent(batchId), { cache: "no-store" });
        batch = out.batch || out;
      } catch (error) { continue; }
      const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
      const ids = tasks.map((task) => task.image_id).filter(Boolean);
      const fresh = ids.filter((id) => !attached.has(id));
      fresh.forEach((id) => attached.add(id));
      if (sessionId && fresh.length) {
        try { await H.api("/api/forge/seances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "attach", id: sessionId, image_ids: fresh, batch_id: batchId }) }); } catch (_) { /* gallery still has them */ }
      }
      if (parentId && fresh.length) {
        for (const id of fresh) {
          try { await H.api("/api/forge/library/labels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, parent: parentId, session: sessionId || "" }) }); } catch (_) { /* branch remains visible by origin */ }
        }
      }
      if (sessionId && fresh.length && currentSeance && currentSeance.id === sessionId) {
        try { await openSeanceById(sessionId, false); } catch (_) { /* refresh later */ }
      }
      if (ids.length > last) last = ids.length;
      const active = tasks.some((task) => ["queued", "dispatched", "running", "saving", "sending"].includes(task.state));
      if (!active) {
        if (sessionId && currentSeance && currentSeance.id === sessionId) {
          await openSeanceById(sessionId, false).catch(() => {});
          const note = $("forge-seance-launch-note");
          if (note) note.textContent = ids.length ? "Séance à jour. Les rejets sont réversibles." : "Le lot est terminé sans image. Ouvre la flotte pour voir le détail.";
        }
        H.loadGallery();
        return;
      }
    }
    if (sessionId) { const note = $("forge-seance-launch-note"); if (note) note.textContent = "Le lot dure plus longtemps que prévu. La séance se mettra à jour au prochain rafraîchissement."; }
  }

  async function finishImage(id) {
    closeSeance();
    try {
      await H.openImage(id);
      const scale = $("forge-finish-scale");
      if (scale) scale.value = "2";
      const button = $("forge-finish");
      if (button && !button.disabled) button.click();
    } catch (error) { toast(error.message || "La finition n’a pas pu démarrer."); }
  }

  /* ---------------------------------------------------------------- pictures */
  const pickerDialog = appendDialog("forge-image-picker", "forge-sheet forge-studio-dialog forge-studio-small", `
    <div class="forge-studio-inner">
      <header class="forge-viewer-bar"><h2 id="forge-picker-title">Choisir des images</h2><button type="button" class="secondary" data-pclose>Fermer</button></header>
      <div id="forge-picker-grid" class="forge-picker-grid"></div>
      <button type="button" id="forge-picker-save">Utiliser ces images</button>
      <p id="forge-picker-note" class="forge-note"></p>
    </div>`);

  function pickImages(title, max, selected) {
    return new Promise(async (resolve) => {
      const grid = $("forge-picker-grid");
      $("forge-picker-title").textContent = title;
      let picked = new Set(selected || []);
      const out = await H.api("/api/forge/gallery?limit=48", { cache: "no-store" });
      const images = Array.isArray(out.images) ? out.images : [];
      grid.innerHTML = images.map((image) => `<label class="forge-picker-card"><input type="checkbox" data-pick="${esc(image.id)}" ${picked.has(image.id) ? "checked" : ""}/><img loading="lazy" src="${esc(image.thumb)}" alt=""/></label>`).join("") || `<p class="forge-note">Aucune image dans la galerie.</p>`;
      $("forge-picker-note").textContent = "Jusqu’à " + max + " image(s). Seules les images normales sont proposées.";
      const close = () => { pickerDialog.close(); resolve(null); };
      $("forge-picker-save").onclick = () => { pickerDialog.close(); resolve([...picked]); };
      document.querySelectorAll("[data-pclose]").forEach((button) => { button.onclick = close; });
      grid.onchange = (event) => {
        const checkbox = event.target.closest("[data-pick]");
        if (!checkbox) return;
        if (checkbox.checked) {
          if (picked.size >= max) { checkbox.checked = false; $("forge-picker-note").textContent = "Maximum " + max + " image(s)."; return; }
          picked.add(checkbox.dataset.pick);
        } else picked.delete(checkbox.dataset.pick);
      };
      pickerDialog.addEventListener("close", () => resolve(null), { once: true });
      pickerDialog.showModal();
    });
  }

  /* --------------------------------------------------------------- library */
  const libraryDialog = appendDialog("forge-library-dialog", "forge-sheet forge-studio-dialog forge-studio-library", `
    <div class="forge-studio-inner">
      <header class="forge-viewer-bar">
        <div><p class="forge-studio-kicker">Archive normale</p><h2>Bibliothèque</h2></div>
        <button type="button" class="secondary" data-lclose>Fermer</button>
      </header>
      <form id="forge-library-search" class="forge-library-search">
        <label>Chercher<input id="forge-lib-q" type="search" placeholder="prompt, modèle, LoRA, appareil, note" autocomplete="off"/></label>
        <details class="forge-lib-more"><summary>Filtres avancés</summary><div class="forge-lib-fields">
        <label>Étiquette<input id="forge-lib-tag" type="text" placeholder="ex. portrait" autocomplete="off"/></label>
        <label>Collection<input id="forge-lib-collection-filter" type="text" placeholder="ex. nuit" autocomplete="off"/></label>
        <label>Modèle<input id="forge-lib-model" type="text" placeholder="checkpoint" autocomplete="off"/></label>
        <label>LoRA<input id="forge-lib-lora" type="text" placeholder="nom du LoRA" autocomplete="off"/></label>
        <label>Échantillonneur<input id="forge-lib-sampler" type="text" placeholder="ex. Euler" autocomplete="off"/></label>
        <label>Pas<input id="forge-lib-steps" type="number" min="1" max="40" placeholder="ex. 28"/></label>
        <label>CFG<input id="forge-lib-cfg" type="number" min="1" max="15" step="0.5" placeholder="ex. 7"/></label>
        <label>Graine<input id="forge-lib-seed" type="text" inputmode="numeric" placeholder="ex. 1234"/></label>
        <label>Largeur<input id="forge-lib-width" type="number" min="256" max="1536" step="64"/></label>
        <label>Hauteur<input id="forge-lib-height" type="number" min="256" max="1536" step="64"/></label>
        <label>Depuis<input id="forge-lib-from" type="date"/></label>
        <label>Jusqu’à<input id="forge-lib-to" type="date"/></label>
        <label>Séance<input id="forge-lib-session-filter" type="text" placeholder="seance-…" autocomplete="off"/></label>
        <label>Vue<select id="forge-lib-view"><option value="">Tout</option><option value="untriaged">À trier</option><option value="trash">Corbeille</option></select></label>
        </div></details>
        <button type="submit">Chercher</button>
      </form>
      <div class="forge-library-tools">
        <button type="button" class="secondary" data-lalbum="model">Même modèle</button>
        <button type="button" class="secondary" data-lalbum="recipe">Même recette</button>
        <button type="button" class="secondary" data-lalbum="session">Même séance</button>
        <button type="button" class="secondary" data-lbulk="keep">Garder</button>
        <button type="button" class="secondary" data-lbulk="favorite">Favori</button>
        <button type="button" class="secondary" data-lbulk="reject">Rejeter</button>
        <button type="button" class="secondary" data-lbulk="none">Neutre</button>
        <button type="button" class="secondary" data-lexport="sidecar">Sidecar JSON</button>
        <button type="button" class="secondary" data-lexport="sheet">Planche</button>
      </div>
      <div class="forge-library-labels">
        <label>Étiquettes à appliquer<input id="forge-lib-tags" type="text" placeholder="séparées par des virgules" autocomplete="off"/></label>
        <label>Collection<input id="forge-lib-collection" type="text" placeholder="une collection" autocomplete="off"/></label>
        <button type="button" class="secondary" id="forge-lib-labels-apply">Appliquer aux sélectionnées</button>
      </div>
      <p id="forge-library-count" class="forge-note" role="status"></p>
      <div id="forge-library-grid" class="forge-library-grid"></div>
      <button type="button" id="forge-library-more" class="secondary" hidden>Charger plus</button>
      <p id="forge-library-note" class="forge-note" role="status"></p>
    </div>`);

  function openLibrary() {
    if (!libraryDialog.open) libraryDialog.showModal();
    searchLibrary(true).catch((error) => { $("forge-library-note").textContent = error.message || "La bibliothèque n’a pas pu être lue."; });
  }

  function libraryParams() {
    const params = new URLSearchParams();
    const fields = { q: "forge-lib-q", tag: "forge-lib-tag", collection: "forge-lib-collection-filter", model: "forge-lib-model", lora: "forge-lib-lora", sampler: "forge-lib-sampler", steps: "forge-lib-steps", cfg: "forge-lib-cfg", seed: "forge-lib-seed", width: "forge-lib-width", height: "forge-lib-height", from: "forge-lib-from", to: "forge-lib-to", session: "forge-lib-session-filter", view: "forge-lib-view" };
    Object.entries(fields).forEach(([name, id]) => { const value = $(id)?.value.trim(); if (value) params.set(name, value); });
    return params;
  }

  async function searchLibrary(reset, more) {
    const params = libraryParams();
    if (!reset) params.set("offset", String(libraryNext || 0));
    const out = await H.api("/api/forge/library?" + params.toString(), { cache: "no-store" });
    const rows = Array.isArray(out.images) ? out.images : [];
    library = reset ? rows : library.concat(rows);
    libraryNext = out.next_offset == null ? null : out.next_offset;
    libraryQuery = Object.fromEntries(params.entries());
    if (reset) librarySelection = new Set();
    renderLibrary(out.total);
    $("forge-library-more").hidden = libraryNext == null;
  }

  function renderLibrary(total) {
    $("forge-library-count").textContent = library.length + " image(s) affichée(s)" + (total != null ? " sur " + total : "") + (librarySelection.size ? " · " + librarySelection.size + " sélectionnée(s)" : "");
    $("forge-library-grid").innerHTML = library.length ? library.map((item) => {
      const settings = item.settings || {};
      const tags = (item.labels && item.labels.tags) || [];
      return `<article class="forge-library-card" data-id="${esc(item.id)}">
        <label class="forge-library-check"><input type="checkbox" data-lcheck="${esc(item.id)}" ${librarySelection.has(item.id) ? "checked" : ""}/></label>
        <button type="button" class="forge-library-image" data-lopen="${esc(item.id)}"><img loading="lazy" src="${esc(item.thumb)}" alt=""/></button>
        <div class="forge-library-copy">
          <p class="forge-library-prompt">${esc(clip(settings.prompt || "Sans prompt", 150))}</p>
          <p class="forge-note">${esc([settings.checkpoint, settings.sampler_name, settings.steps ? settings.steps + " pas" : "", settings.seed != null ? "graine " + settings.seed : "", item.width + "×" + item.height].filter(Boolean).join(" · "))}</p>
          <p class="forge-library-tags">${tags.length ? tags.map((tag) => `<span class="forge-chip">${esc(tag)}</span>`).join("") : ""}${item.labels && item.labels.collection ? `<span class="forge-chip forge-chip-quiet">${esc(item.labels.collection)}</span>` : ""}${item.labels && item.labels.session ? `<button type="button" class="forge-chip forge-chip-link" data-lsession="${esc(item.labels.session)}">séance</button>` : ""}</p>
        </div>
        <span class="forge-triage-tag" data-triage="${esc(item.triage)}">${triageLabel(item.triage)}</span>
      </article>`;
    }).join("") : `<div class="forge-studio-empty"><p>Aucune image ne correspond à ces filtres.</p></div>`;
  }

  libraryDialog.addEventListener("submit", (event) => { event.preventDefault(); searchLibrary(true).catch((error) => toast(error.message)); });
  $("forge-library-more").addEventListener("click", () => searchLibrary(false).catch((error) => toast(error.message)));
  document.querySelectorAll("[data-lclose]").forEach((button) => button.addEventListener("click", () => libraryDialog.close()));

  libraryDialog.addEventListener("change", (event) => {
    const check = event.target.closest("[data-lcheck]");
    if (!check) return;
    if (check.checked) librarySelection.add(check.dataset.lcheck); else librarySelection.delete(check.dataset.lcheck);
    renderLibrary();
  });
  libraryDialog.addEventListener("click", async (event) => {
    const open = event.target.closest("[data-lopen]");
    const album = event.target.closest("[data-lalbum]");
    const bulk = event.target.closest("[data-lbulk]");
    const session = event.target.closest("[data-lsession]");
    const exportButton = event.target.closest("[data-lexport]");
    if (event.target.closest("[data-lclose]")) { libraryDialog.close(); return; }
    if (open) { libraryDialog.close(); H.openImage(open.dataset.lopen).catch((error) => toast(error.message)); return; }
    if (session) { libraryDialog.close(); openSeanceById(session.dataset.lsession, true).catch((error) => toast(error.message)); return; }
    if (album) {
      const chosen = selectedLibraryItem();
      if (!chosen) { toast("Choisis une image dans la bibliothèque."); return; }
      if (album.dataset.lalbum === "model") { $("forge-lib-model").value = chosen.settings.checkpoint || ""; }
      if (album.dataset.lalbum === "session") {
        const sessionValue = chosen.labels?.session || "";
        if (sessionValue) { $("forge-lib-session-filter").value = sessionValue; toast("Filtre de séance appliqué."); }
        else { toast("Cette image n’appartient à aucune séance."); return; }
      }
      if (album.dataset.lalbum === "recipe") {
        const settings = chosen.settings || {};
        $("forge-lib-model").value = settings.checkpoint || "";
        $("forge-lib-sampler").value = settings.sampler_name || "";
        $("forge-lib-steps").value = settings.steps || "";
        $("forge-lib-cfg").value = settings.cfg_scale || "";
        $("forge-lib-seed").value = settings.seed == null ? "" : settings.seed;
        $("forge-lib-width").value = chosen.width || "";
        $("forge-lib-height").value = chosen.height || "";
      }
      searchLibrary(true).catch((error) => toast(error.message));
      return;
    }
    if (bulk) {
      if (!librarySelection.size) { toast("Sélectionne au moins une image."); return; }
      try {
        await H.api("/api/forge/library/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [...librarySelection], state: bulk.dataset.lbulk }) });
        H.loadGallery();
        await searchLibrary(true);
        toast("Tri appliqué. Rien n’est supprimé.");
      } catch (error) { toast(error.message); }
      return;
    }
    if (exportButton) {
      const items = librarySelection.size ? library.filter((item) => librarySelection.has(item.id)) : library;
      if (!items.length) { toast("Aucune image à exporter."); return; }
      if (exportButton.dataset.lexport === "sheet") contactSheet(items, "Galerie");
      else exportSidecar(items);
    }
  });

  $("forge-lib-labels-apply").addEventListener("click", async () => {
    if (!librarySelection.size) { toast("Sélectionne au moins une image."); return; }
    const tags = $("forge-lib-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
    const collection = $("forge-lib-collection").value.trim().slice(0, 40);
    try {
      for (const id of librarySelection) await H.api("/api/forge/library/labels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, tags, collection }) });
      $("forge-lib-tags").value = "";
      $("forge-lib-collection").value = "";
      await searchLibrary(true);
      toast("Étiquettes enregistrées.");
    } catch (error) { toast(error.message); }
  });

  function selectedLibraryItem() {
    const first = librarySelection.size ? [...librarySelection][0] : null;
    return first ? library.find((item) => item.id === first) || null : (library[0] || null);
  }

  function exportSidecar(items) {
    const payload = { exported: new Date().toISOString(), kind: "hq-forge-recipe-sidecar", images: items.map((item) => ({ id: item.id, created: item.created, width: item.width, height: item.height, triage: item.triage, labels: item.labels, origin: item.origin, settings: item.settings })) };
    downloadBlob("hq-forge-recettes-" + new Date().toISOString().slice(0, 10) + ".json", new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  }

  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function loadImage(url) {
    return new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = url; });
  }

  async function contactSheet(items, title) {
    if (!items || !items.length) { toast("Aucune image pour la planche."); return; }
    const columns = Math.min(4, items.length);
    const cell = 320;
    const rows = Math.ceil(items.length / columns);
    const canvas = document.createElement("canvas");
    canvas.width = columns * cell;
    canvas.height = rows * cell + 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f4f0e8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#1f2520";
    ctx.font = "600 24px Georgia, serif";
    ctx.fillText(clip(title || "Planche", 48), 20, 38);
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillStyle = "#5f675e";
    ctx.fillText(items.length + " image(s) · " + new Date().toLocaleDateString("fr-FR"), 20, 58);
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const image = await loadImage(item.thumb);
      const x = (index % columns) * cell + 8;
      const y = Math.floor(index / columns) * cell + 70;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, y, cell - 16, cell - 28);
      if (image) {
        const scale = Math.min((cell - 16) / image.width, (cell - 60) / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        ctx.drawImage(image, x + (cell - 16 - width) / 2, y + (cell - 28 - height) / 2, width, height);
      }
      ctx.fillStyle = "#1f2520";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText(clip((item.settings && item.settings.prompt) || item.id, 34), x + 10, y + cell - 18);
    }
    canvas.toBlob((blob) => { if (blob) downloadBlob("hq-forge-planche-" + new Date().toISOString().slice(0, 10) + ".jpg", blob); }, "image/jpeg", 0.9);
  }

  /* ---------------------------------------------------------------- compare */
  const compareDialog = appendDialog("forge-seance-compare", "forge-sheet forge-compare forge-studio-compare", `
    <div class="forge-sheet-inner">
      <header class="forge-viewer-bar"><h2>Comparer deux prises</h2><button type="button" class="secondary" data-close-compare>Fermer</button></header>
      <div id="forge-seance-compare-stage" class="forge-seance-compare-stage"></div>
      <p id="forge-seance-compare-note" class="forge-note"></p>
    </div>`);

  function openCompare() {
    if (comparePicks.length !== 2 || !currentSeance) { toast("Coche exactement deux images à comparer."); return; }
    const first = currentSeance.images.find((image) => image.id === comparePicks[0]);
    const second = currentSeance.images.find((image) => image.id === comparePicks[1]);
    if (!first || !second) return;
    renderCompareStage(first, second, "Prise A", "Prise B");
    $("forge-seance-compare-note").textContent = "Glisse la poignée ou utilise les flèches pour comparer A et B. Les deux images restent dans la galerie.";
    compareDialog.showModal();
  }
  document.querySelectorAll("[data-close-compare]").forEach((button) => button.addEventListener("click", () => compareDialog.close()));

  /* --------------------------------------------------------------- recipes */
  function lorasIn(prompt) {
    const out = [];
    const re = /<lora:([^:<>]{1,120})(?::([^<>]*))?>/gi;
    let match;
    while ((match = re.exec(String(prompt || "")))) out.push({ name: match[1], weight: match[2] === undefined ? 1 : Number(match[2]) });
    return out;
  }

  function recipeSection() {
    let section = $("forge-recipe");
    if (section) return section;
    section = document.createElement("section");
    section.id = "forge-recipe";
    section.className = "forge-recipe";
    section.setAttribute("aria-label", "Recette de l’image");
    const triage = $("forge-viewer-triage");
    if (triage && triage.parentNode) triage.insertAdjacentElement("afterend", section);
    return section;
  }

  function renderRecipe(id) {
    const section = recipeSection();
    if (!section) return;
    const detail = H.currentDetail ? H.currentDetail() : null;
    if (!detail || detail.id !== id) { section.hidden = true; return; }
    const settings = detail.settings || {};
    const loras = lorasIn(settings.prompt);
    const bits = [
      settings.checkpoint, settings.sampler_name, settings.scheduler, settings.steps ? settings.steps + " pas" : "",
      settings.cfg_scale ? "CFG " + String(settings.cfg_scale).replace(".", ",") : "",
      settings.seed != null ? "graine " + settings.seed : "", detail.width && detail.height ? detail.width + "×" + detail.height : "",
      detail.origin?.worker_name || (detail.origin ? "appareil " + (detail.origin.worker_id || "distant") : "Cet HQ")
    ].filter(Boolean);
    const family = detail.origin ? Object.keys(detail.origin).filter((key) => key.endsWith("_of")).map((key) => key.replace("_of", "")) : [];
    section.hidden = false;
    section.innerHTML = `
      <div class="forge-label-row"><h3>Recette</h3><span class="forge-note">Tout ce qui a produit cette image.</span></div>
      <div class="forge-recipe-chips">${bits.map((bit) => `<span class="forge-chip">${esc(bit)}</span>`).join("")}${loras.map((lora) => `<span class="forge-chip forge-chip-lora">LoRA ${esc(lora.name)}${lora.weight !== 1 ? " · " + lora.weight : ""}</span>`).join("")}${family.map((kind) => `<span class="forge-chip forge-chip-quiet">${esc(kind)}</span>`).join("")}</div>
      <p class="forge-note">Durée : non enregistrée pour cette image. La graine et les réglages sont ceux conservés par HQ.</p>
      <div class="forge-recipe-actions">
        <button type="button" data-raction="redo">Refaire exactement</button>
        <button type="button" class="secondary" data-raction="seed">Verrouiller la graine</button>
        <button type="button" class="secondary" data-raction="finish">Finir cette image</button>
        <button type="button" class="secondary" data-raction="preset">Enregistrer comme préréglage</button>
        <button type="button" class="secondary" data-raction="family">Voir la famille</button>
        ${family.length ? `<button type="button" class="secondary" data-raction="before">Avant / après</button>` : ""}
      </div>
      <div class="forge-recipe-branch">
        <label for="forge-recipe-axis">Varier un seul réglage</label>
        <select id="forge-recipe-axis"><option value="steps">Pas</option><option value="cfg_scale">CFG</option><option value="sampler_name">Échantillonneur</option>${loras.length ? `<option value="lora_weight">Poids d’un LoRA</option>` : ""}</select>
        ${loras.length ? `<select id="forge-recipe-lora">${loras.map((lora) => `<option value="${esc(lora.name)}">${esc(lora.name)}</option>`).join("")}</select>` : ""}
        <button type="button" class="secondary" data-raction="branch">Lancer 4 branches</button>
      </div>
      <p class="forge-note">Une branche garde tout le reste et ne change qu’un réglage. Elle apparaît ensuite dans la famille de l’image.</p>
      <div id="forge-recipe-status" class="forge-note" role="status"></div>`;
  }

  function hideRecipe() { const section = $("forge-recipe"); if (section) section.hidden = true; }

  const prevViewer = window.hqForgeOnViewer;
  window.hqForgeOnViewer = function (kind, id, from, triage) {
    if (prevViewer) prevViewer(kind, id, from, triage);
    if (kind === "normal") renderRecipe(id); else hideRecipe();
  };

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-raction]");
    if (!button) return;
    const action = button.dataset.raction;
    const detail = H.currentDetail ? H.currentDetail() : null;
    if (!detail) return;
    if (action === "redo") {
      H.applySettings(detail.settings);
      H.closeViewer();
      document.getElementById("forge-prompt")?.focus();
      toast("Réglages replacés dans le formulaire.");
    }
    if (action === "seed") {
      H.applySettings(detail.settings);
      if (H.applySeed && detail.settings.seed != null) H.applySeed(detail.settings.seed);
      H.closeViewer();
      document.getElementById("forge-seed")?.focus();
      toast("Graine verrouillée.");
    }
    if (action === "finish") {
      const scale = $("forge-finish-scale");
      if (scale) scale.value = "2";
      $("forge-finish")?.click();
    }
    if (action === "preset") {
      const name = window.prompt("Nom du préréglage", clip(detail.settings.prompt || "Recette", 60));
      if (!name || !name.trim()) return;
      const settings = Object.assign({}, detail.settings, { n_iter: 1, batch_size: 1, enable_hr: !!detail.settings.enable_hr, hr_scale: detail.settings.hr_scale || 2, hr_upscaler: detail.settings.hr_upscaler || "", hr_second_pass_steps: detail.settings.hr_second_pass_steps || 0, denoising_strength: detail.settings.denoising_strength || 0.5 });
      try {
        await H.api("/api/forge/presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ action: "create", name: name.trim(), kind: "creative" }, settings)) });
        $("forge-recipe-status").textContent = "Préréglage enregistré.";
      } catch (error) { $("forge-recipe-status").textContent = error.message || "Le préréglage n’a pas été enregistré."; }
    }
    if (action === "family") openFamily(detail.id);
    if (action === "before") openBeforeAfter(detail);
    if (action === "branch") branchRecipe(detail);
  });

  async function branchRecipe(detail) {
    const status = $("forge-recipe-status");
    if (!H.sweepContext || !detail.settings) return;
    if (H.fleetMode && H.fleetMode() && H.sweepContext().privateMode) { status.textContent = "Une branche reste en mode Galerie."; return; }
    const axis = $("forge-recipe-axis")?.value || "steps";
    const lora = $("forge-recipe-lora")?.value || "";
    H.applySettings(detail.settings);
    if (H.applySeed && detail.settings.seed != null) H.applySeed(detail.settings.seed);
    await sleep(30);
    const ctx = H.sweepContext();
    if (!ctx.workers || !ctx.workers.length) { status.textContent = "Aucun appareil disponible."; return; }
    let values = [];
    if (axis === "steps") {
      const base = Number(detail.settings.steps) || 20;
      values = [Math.max(1, base - 8), Math.max(1, base - 4), Math.min(40, base + 4), Math.min(40, base + 8)];
    } else if (axis === "cfg_scale") {
      const base = Number(detail.settings.cfg_scale) || 7;
      values = [base - 2, base - 1, base + 1, base + 2].map((value) => Math.round(Math.max(1, Math.min(15, value)) * 10) / 10);
    } else if (axis === "sampler_name") {
      const all = (ctx.samplers || []).filter((value) => value && value !== detail.settings.sampler_name);
      values = [detail.settings.sampler_name].concat(all.slice(0, 3)).filter(Boolean);
    } else if (axis === "lora_weight") {
      const found = lorasIn(detail.settings.prompt).find((item) => item.name === lora);
      const base = found && Number.isFinite(found.weight) ? found.weight : 1;
      values = [base - 0.6, base - 0.3, base + 0.3, base + 0.6].map((value) => Math.round(Math.max(-2, Math.min(2, value)) * 100) / 100);
    }
    values = [...new Set(values)];
    if (values.length !== 4) { status.textContent = "Pas assez de valeurs distinctes pour cette branche."; return; }
    const settings = Object.assign({}, ctx.settings);
    delete settings.n_iter; delete settings.batch_size; delete settings.destination; delete settings.subseed; delete settings.subseed_strength;
    status.textContent = "Envoi de quatre branches…";
    try {
      const out = await H.api("/api/forge/batches", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key("branch") },
        body: JSON.stringify({ workers: ctx.workers, count: 4, settings, destination: "normal", sweep: Object.assign({ axis, values }, axis === "lora_weight" ? { lora } : {}) })
      });
      H.closeViewer();
      H.startBatch(out.batch);
      pollBatch(out.batch.id, seanceDialog.open && currentSeance ? currentSeance.id : null, detail.id);
      toast("Branche lancée. Les résultats seront liés à l’image.");
    } catch (error) { status.textContent = error.message || "La branche n’a pas pu partir."; }
  }

  /* ---------------------------------------------------------------- family */
  const familyDialog = appendDialog("forge-family-dialog", "forge-sheet forge-studio-dialog forge-studio-small", `
    <div class="forge-studio-inner">
      <header class="forge-viewer-bar"><h2>Famille de l’image</h2><button type="button" class="secondary" data-fclose>Fermer</button></header>
      <p id="forge-family-note" class="forge-note" role="status"></p>
      <div id="forge-family-grid" class="forge-family-grid"></div>
    </div>`);

  async function openFamily(id) {
    familyDialog.showModal();
    $("forge-family-note").textContent = "Lecture des liens…";
    try {
      const out = await H.api("/api/forge/library/family?id=" + encodeURIComponent(id), { cache: "no-store" });
      const nodes = Array.isArray(out.nodes) ? out.nodes : [];
      $("forge-family-note").textContent = nodes.length > 1 ? "Les liens viennent des finitions, retouches, extensions et branches choisies dans cette image." : "Aucun lien de famille pour l’instant. Une branche ou une finition en créera un.";
      $("forge-family-grid").innerHTML = nodes.map((node) => `<button type="button" class="forge-family-node" data-fopen="${esc(node.id)}"><img loading="lazy" src="${esc(node.thumb)}" alt=""/><span>${esc(node.relation)}</span></button>`).join("");
    } catch (error) { $("forge-family-note").textContent = error.message || "La famille n’a pas pu être lue."; }
  }
  document.querySelectorAll("[data-fclose]").forEach((button) => button.addEventListener("click", () => familyDialog.close()));
  familyDialog.addEventListener("click", (event) => {
    const open = event.target.closest("[data-fopen]");
    if (!open) return;
    familyDialog.close();
    H.openImage(open.dataset.fopen).catch((error) => toast(error.message));
  });

  /* ------------------------------------------------------------ before/after */
  const beforeDialog = appendDialog("forge-before-after", "forge-sheet forge-studio-dialog forge-studio-small", `
    <div class="forge-studio-inner">
      <header class="forge-viewer-bar"><h2>Avant / après</h2><button type="button" class="secondary" data-bclose>Fermer</button></header>
      <div class="forge-before-stage"><img id="forge-before-a" alt="Avant"/><div class="forge-before-clip"><img id="forge-before-b" alt="Après"/></div><span class="forge-before-label">Après</span></div>
      <label for="forge-before-range">Révéler l’après</label>
      <input type="range" id="forge-before-range" min="0" max="100" step="1" value="50"/>
      <p class="forge-note">L’image d’origine et sa descendante restent dans la galerie. Rien n’est envoyé.</p>
    </div>`);

  function openBeforeAfter(detail) {
    const origin = detail.origin || {};
    const source = origin.finish_of || origin.outpaint_of || origin.inpaint_of;
    if (!source) { toast("Pas d’image d’origine pour ce lien."); return; }
    $("forge-before-a").src = "/api/forge/gallery/" + encodeURIComponent(source) + "/original";
    $("forge-before-b").src = "/api/forge/gallery/" + encodeURIComponent(detail.id) + "/original";
    const range = $("forge-before-range");
    const clip = document.querySelector(".forge-before-clip");
    const sync = () => { if (clip) clip.style.width = range.value + "%"; };
    range.oninput = sync;
    sync();
    beforeDialog.showModal();
  }
  document.querySelectorAll("[data-bclose]").forEach((button) => button.addEventListener("click", () => beforeDialog.close()));

  /* ---------------------------------------------------------------- outpaint */
  const outpaintDialog = appendDialog("forge-outpaint", "forge-sheet forge-studio-dialog forge-studio-small", `
    <div class="forge-studio-inner">
      <header class="forge-viewer-bar"><h2>Étendre l’image</h2><button type="button" class="secondary" data-oclose>Fermer</button></header>
      <p class="forge-note" id="forge-outpaint-where">Extension sur ce PC uniquement. Le résultat rejoint la même destination que la source.</p>
      <div class="forge-outpaint-presets" role="group" aria-label="Formats d’extension">
        <button type="button" class="secondary" data-opreset="wide">Plus large</button>
        <button type="button" class="secondary" data-opreset="tall">Plus haut</button>
        <button type="button" class="secondary" data-opreset="square">Carré</button>
      </div>
      <div class="forge-outpaint-edges">
        <label>Gauche<input id="forge-outpaint-left" type="number" min="0" max="1024" step="64" value="0"/></label>
        <label>Droite<input id="forge-outpaint-right" type="number" min="0" max="1024" step="64" value="0"/></label>
        <label>Haut<input id="forge-outpaint-top" type="number" min="0" max="1024" step="64" value="0"/></label>
        <label>Bas<input id="forge-outpaint-bottom" type="number" min="0" max="1024" step="64" value="0"/></label>
      </div>
      <label for="forge-outpaint-prompt">Ce qui doit apparaître dans le cadre</label>
      <textarea id="forge-outpaint-prompt" rows="3" maxlength="2000" autocomplete="off" spellcheck="false"></textarea>
      <details class="forge-inpaint-more"><summary>Réglages de l’extension</summary>
        <label>Force <input type="range" id="forge-outpaint-denoise" min="0.05" max="1" step="0.05" value="0.6"/></label>
        <label>Fondu du bord <input type="range" id="forge-outpaint-blur" min="0" max="32" step="1" value="4"/></label>
        <label for="forge-outpaint-fill">Point de départ</label>
        <select id="forge-outpaint-fill"><option value="1" selected>Image d’origine</option><option value="0">Remplissage</option><option value="2">Bruit latent</option><option value="3">Latent vide</option></select>
        <label class="forge-check"><input type="checkbox" id="forge-outpaint-fullres" checked/> Détailler la zone seule</label>
      </details>
      <p class="forge-note" id="forge-outpaint-model"></p>
      <button type="button" id="forge-outpaint-send">Étendre</button>
      <p class="forge-note" id="forge-outpaint-note" role="status">Le cadre s’agrandit, la zone ajoutée est repeinte par Forge. Côtés multiples de 64, 1536 px au plus.</p>
    </div>`);

  let outpaintSource = null;
  let outpaintStored = {};
  let outpaintBusy = false;
  let outpaintPoll = 0;

  function addOutpaintButtons() {
    const normal = $("forge-viewer-inpaint");
    if (normal && !$("forge-viewer-outpaint")) {
      const button = document.createElement("button");
      button.type = "button";
      button.id = "forge-viewer-outpaint";
      button.className = "secondary forge-inpaint-open";
      button.textContent = "Étendre le cadre";
      button.addEventListener("click", () => openOutpaint("normal"));
      normal.insertAdjacentElement("afterend", button);
    }
    const privateButton = $("forge-vault-viewer-inpaint");
    if (privateButton && !$("forge-vault-outpaint")) {
      const button = document.createElement("button");
      button.type = "button";
      button.id = "forge-vault-outpaint";
      button.className = "secondary forge-inpaint-open";
      button.textContent = "Étendre le cadre";
      button.addEventListener("click", () => { if (H.vaultUnlocked()) openOutpaint("private"); });
      privateButton.insertAdjacentElement("afterend", button);
    }
  }

  function openOutpaint(kind) {
    const detail = kind === "private" ? (H.privateDetail ? H.privateDetail() : null) : H.currentDetail();
    if (!detail) { toast("Ouvre une image d’abord."); return; }
    outpaintSource = kind === "private" ? { kind, id: detail.id, vault: H.openVault ? H.openVault() : null } : { kind, id: detail.id };
    outpaintStored = detail.settings || {};
    outpaintBusy = false;
    $("forge-outpaint-send").disabled = false;
    $("forge-outpaint-prompt").value = outpaintStored.prompt || "";
    ["left", "right", "top", "bottom"].forEach((side) => { $("forge-outpaint-" + side).value = "0"; });
    $("forge-outpaint-where").textContent = kind === "private" ? "Extension sur ce PC uniquement. Le résultat reste dans ce coffre, rien dans l’historique." : "Extension sur ce PC uniquement. Le résultat est ajouté à la galerie normale.";
    $("forge-outpaint-note").textContent = "Le cadre s’agrandit, la zone ajoutée est repeinte par Forge. Côtés multiples de 64, 1536 px au plus.";
    $("forge-outpaint-model").textContent = "Utilise le modèle déjà chargé dans Forge, sans le changer.";
    outpaintDialog.showModal();
    $("forge-outpaint-left").focus();
  }

  document.querySelectorAll("[data-oclose]").forEach((button) => button.addEventListener("click", () => outpaintDialog.close()));
  outpaintDialog.addEventListener("close", () => { if (outpaintPoll) clearTimeout(outpaintPoll); outpaintPoll = 0; outpaintSource = null; outpaintBusy = false; });

  function edge(name) { return Math.max(0, Math.min(1024, Number($("forge-outpaint-" + name).value) || 0)); }

  document.querySelectorAll("[data-opreset]").forEach((button) => button.addEventListener("click", () => {
    const image = outpaintSource?.kind === "private" ? $("forge-vault-viewer-img") : $("forge-viewer-img");
    const width = image?.naturalWidth || 1024;
    const height = image?.naturalHeight || 1024;
    ["left", "right", "top", "bottom"].forEach((side) => { $("forge-outpaint-" + side).value = "0"; });
    if (button.dataset.opreset === "wide") { $("forge-outpaint-left").value = "256"; $("forge-outpaint-right").value = "256"; }
    if (button.dataset.opreset === "tall") { $("forge-outpaint-top").value = "256"; $("forge-outpaint-bottom").value = "256"; }
    if (button.dataset.opreset === "square") {
      const target = Math.max(width, height);
      const pad = Math.ceil((target - Math.min(width, height)) / 128) * 128;
      if (width < height) { $("forge-outpaint-left").value = String(pad / 2); $("forge-outpaint-right").value = String(pad / 2); }
      else { $("forge-outpaint-top").value = String(pad / 2); $("forge-outpaint-bottom").value = String(pad / 2); }
    }
  }));

  $("forge-outpaint-send").addEventListener("click", async () => {
    if (outpaintBusy || !outpaintSource) return;
    const sides = { left: edge("left"), right: edge("right"), top: edge("top"), bottom: edge("bottom") };
    if (!sides.left && !sides.right && !sides.top && !sides.bottom) { $("forge-outpaint-note").textContent = "Choisis au moins un côté à étendre."; return; }
    if (Object.values(sides).some((value) => value % 64)) { $("forge-outpaint-note").textContent = "Chaque côté doit être un multiple de 64."; return; }
    outpaintBusy = true;
    $("forge-outpaint-send").disabled = true;
    $("forge-outpaint-note").textContent = "Envoi à Forge (ce PC)…";
    const body = {
      source: outpaintSource, outpaint: sides, prompt: $("forge-outpaint-prompt").value,
      denoising_strength: Number($("forge-outpaint-denoise").value), mask_blur: Number($("forge-outpaint-blur").value),
      inpainting_fill: Number($("forge-outpaint-fill").value), inpaint_full_res: $("forge-outpaint-fullres").checked,
      inpaint_full_res_padding: 32
    };
    const form = H.sweepContext ? H.sweepContext().settings : {};
    for (const name of ["sampler_name", "scheduler", "steps", "cfg_scale"]) if (!outpaintStored[name] && form[name] != null && form[name] !== "") body[name] = form[name];
    try {
      const out = await H.api("/api/forge/inpaint", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      pollOutpaint(out.inpaint.id, outpaintSource.kind);
    } catch (error) {
      outpaintBusy = false;
      $("forge-outpaint-send").disabled = false;
      $("forge-outpaint-note").textContent = error.message || "L’extension n’a pas pu partir.";
    }
  });

  async function pollOutpaint(id, kind) {
    outpaintPoll = 0;
    if (!outpaintDialog.open) return;
    try {
      const out = await H.api("/api/forge/inpaint/" + encodeURIComponent(id), { cache: "no-store" });
      const entry = out.inpaint || {};
      if (entry.state === "completed" && entry.image_id) {
        outpaintDialog.close();
        if (kind === "private") {
          await H.reloadVault();
          if (H.closePrivateViewer) H.closePrivateViewer();
          if (H.openPrivate && H.vaultUnlocked()) await H.openPrivate(entry.image_id);
        } else {
          await H.loadGallery();
          H.closeViewer();
          await H.openImage(entry.image_id);
        }
        return;
      }
      if (entry.state === "failed") {
        outpaintBusy = false;
        $("forge-outpaint-send").disabled = false;
        $("forge-outpaint-note").textContent = entry.message || "L’extension n’a pas abouti.";
        return;
      }
      const pct = Math.round((Number(entry.progress) || 0) * 100);
      $("forge-outpaint-note").textContent = entry.steps ? "Extension en cours… " + pct + " %" : "Extension en cours…";
    } catch (error) {
      if (error.status === 404 || error.status === 401) {
        outpaintBusy = false;
        $("forge-outpaint-send").disabled = false;
        $("forge-outpaint-note").textContent = error.message || "Extension interrompue.";
        return;
      }
    }
    outpaintPoll = setTimeout(() => pollOutpaint(id, kind), 1000);
  }

  window.hqForgeStudio = {
    current: () => currentSeance,
    pickImages: (title, max, selected) => pickImages(title, max, selected),
    openLibrary,
    addReferences
  };

  /* --------------------------------------------------------------- bootstrap */
  composeStudio();
  entryButtons();
  setMode("generate");
  initBarControls();
  initSettingsSheet();
  initSelection();
  const promptInput = $("forge-prompt");
  if (promptInput) promptInput.addEventListener("input", renderBrief);
  renderBrief();
  addOutpaintButtons();
  /* Reuse the channel hq-forge.js already created: one toast element, not two. */
  if (!$("forge-studio-toast")) {
    const toastBox = document.createElement("p");
    toastBox.id = "forge-studio-toast";
    toastBox.className = "forge-studio-toast";
    toastBox.setAttribute("role", "status");
    toastBox.setAttribute("aria-live", "polite");
    toastBox.hidden = true;
    document.body.appendChild(toastBox);
  }

  /* The private viewer is created after some scripts; retry the two entry points
     once it is shown rather than assuming the DOM order. */
  const observer = new MutationObserver(() => addOutpaintButtons());
  observer.observe(document.body, { childList: true, subtree: true });
})();
