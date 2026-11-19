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
  const fmtBytes = (bytes) => {
    const value = Number(bytes) || 0;
    if (value >= 1073741824) return (Math.round(value / 107374182.4) / 10).toFixed(1).replace(".", ",") + " Go";
    return (value <= 0 ? 0 : Math.max(1, Math.round(value / 1048576))) + " Mo";
  };
  /* Above this size the page stops copying the ZIP through a Blob (which holds the whole
     archive in page memory) and lets the browser write it straight to disk. */
  const DIRECT_DOWNLOAD_BYTES = 64 * 1024 * 1024;
  const usageText = (usage) => !usage || !usage.quota_images ? "" :
    usage.images + " / " + usage.quota_images + " images \u00b7 " + fmtBytes(usage.bytes) + " / " + fmtBytes(usage.quota_bytes) +
    (usage.images >= usage.quota_images ? " \u00b7 galerie pleine" : "");

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

  // Bin: rejected images, with Remettre and an explicit permanent Supprimer.
  const trash = $("forge-trash");
  let trashMode = "normal";
  const trashUrls = [];
  function dropTrashUrls() {
    while (trashUrls.length) URL.revokeObjectURL(trashUrls.pop());
  }
  async function openTrash(kind) {
    trashMode = kind;
    $("forge-trash-title").textContent = kind === "private" ? "Corbeille du coffre" : "Corbeille";
    const note = $("forge-trash-note");
    if (note) note.textContent = "";  // a note from the previous visit must not describe this one
    await fillTrash();
    trash.showModal();
    $("forge-trash-close").focus();
  }
  async function fillTrash() {
    const grid = $("forge-trash-grid");
    dropTrashUrls();
    grid.replaceChildren();
    let page = { images: [] };
    try { page = (await H.api(listPath(trashMode, "trash"))) || page; } catch (_) { page = { images: [] }; }
    const images = page.images || [];
    const usage = $("forge-trash-usage");
    if (usage) usage.textContent = usageText(page.usage);
    $("forge-trash-empty").hidden = images.length > 0;
    const emptyAll = $("forge-trash-empty-all");
    if (emptyAll) emptyAll.hidden = trashMode === "private" || images.length === 0;
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
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "secondary forge-danger";
      drop.textContent = "Supprimer";
      drop.dataset.id = image.id;
      drop.addEventListener("click", () => { removeForever(image, cell, back, drop); });
      cell.append(pic, back, drop);
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
  /* The only permanent delete of the normal gallery: it frees the image's slot in
     the quota, and the backend route refuses every id outside the gallery. */
  const TRASH_ASK = {
    normal: "Supprimer d\u00e9finitivement cette image ? Elle quittera la galerie, lib\u00e9rera sa place dans le quota et ne pourra pas \u00eatre r\u00e9cup\u00e9r\u00e9e. Les autres images ne sont pas touch\u00e9es.",
    private: "Supprimer d\u00e9finitivement cette image du coffre ? Elle ne pourra pas \u00eatre r\u00e9cup\u00e9r\u00e9e."
  };
  async function removeForever(image, cell, back, drop) {
    const note = $("forge-trash-note");
    if (!window.confirm(TRASH_ASK[trashMode] || TRASH_ASK.normal)) return;
    back.disabled = true;
    drop.disabled = true;
    try {
      await post(base(trashMode) + image.id + "/delete", {});
      cell.remove();
      if (note) note.textContent = "Image supprim\u00e9e d\u00e9finitivement.";
      await (trashMode === "private" ? H.loadVault() : H.loadGallery());
      await fillTrash();
      if (note) note.textContent = "Image supprim\u00e9e d\u00e9finitivement.";
    } catch (error) {
      back.disabled = false;
      drop.disabled = false;
      if (note) note.textContent = error.message || "La suppression a \u00e9chou\u00e9.";
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
  const emptyAllButton = $("forge-trash-empty-all");
  if (emptyAllButton) emptyAllButton.addEventListener("click", async () => {
    if (trashMode !== "normal") return;
    const count = $("forge-trash-grid").children.length;
    if (!count) return;
    if (!window.confirm("Supprimer d\u00e9finitivement les " + count + " image(s) de la corbeille ? Cette action ne peut pas \u00eatre annul\u00e9e.")) return;
    emptyAllButton.disabled = true;
    try {
      const result = await post("/api/forge/gallery/trash/empty", {});
      await fillTrash();
      await H.loadGallery();
      const note = $("forge-trash-note");
      if (note) note.textContent = (result.deleted || 0) + " image(s) supprim\u00e9e(s) d\u00e9finitivement.";
    } catch (error) {
      const note = $("forge-trash-note");
      if (note) note.textContent = error.message || "La corbeille n\u2019a pas pu \u00eatre vid\u00e9e.";
    } finally {
      emptyAllButton.disabled = false;
    }
  });
  trash.addEventListener("cancel", (event) => { event.preventDefault(); closeTrash(); });

  // ---------------------------------------------- Galerie: sauvegarde et restauration
  function backupNote(text) {
    const note = $("forge-gallery-backup-note");
    if (note) note.textContent = text;
  }
  async function backupGallery() {
    const button = $("forge-gallery-backup");
    if (button) button.disabled = true;
    backupNote("V\u00e9rification de la place\u2026");
    try {
      /* Ask first: the limit is free disk space, so the owner learns it before a 2 GiB
         archive starts instead of after a refusal. */
      const plan = await H.api("/api/forge/gallery/export/plan", { cache: "no-store" });
      if (!plan || !plan.images) {
        backupNote("La galerie est vide : rien \u00e0 sauvegarder.");
        return;
      }
      const needed = fmtBytes(plan.bytes);
      const limit = fmtBytes(plan.limit_bytes);
      if (!plan.allowed) {
        backupNote("Sauvegarde impossible : " + needed + " \u00e0 \u00e9crire, limite " + limit +
          " d\u2019espace libre. Supprime des images (la Corbeille lib\u00e8re leur place) puis r\u00e9essaie.");
        return;
      }
      if (plan.bytes > DIRECT_DOWNLOAD_BYTES) {
        backupNote("Sauvegarde de " + plan.images + " image(s), " + needed + " (limite " + limit +
          ") \u2014 t\u00e9l\u00e9chargement direct : le navigateur \u00e9crit le fichier sur le disque.");
        const anchor = document.createElement("a");
        anchor.href = "/api/forge/gallery/export";
        anchor.download = "hq-forge-galerie.zip";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        return;
      }
      backupNote("Sauvegarde de " + plan.images + " image(s), " + needed + " (limite " + limit + ") \u2014 pr\u00e9paration du ZIP\u2026");
      const response = await fetch("/api/forge/gallery/export", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        let detail = "";
        try { detail = (await response.json()).error || ""; } catch (_) { detail = ""; }
        throw new Error(detail || "L\u2019export a \u00e9chou\u00e9.");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "hq-forge-galerie.zip";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      backupNote("ZIP t\u00e9l\u00e9charg\u00e9 : les images et leurs r\u00e9glages. Les miniatures sont reconstruites \u00e0 la restauration.");
      /* The marker now exists on the server: refresh the line that says how fresh it is. */
      H.loadGallery().catch(() => {});
    } catch (error) {
      backupNote(error.message || "L\u2019export a \u00e9chou\u00e9.");
    } finally {
      if (button) button.disabled = false;
    }
  }
  async function restoreGallery(file) {
    if (!file) return;
    const size = Math.max(1, Math.round(file.size / 1048576));
    if (!window.confirm("Restaurer \u00ab " + file.name + " \u00bb (" + size + " Mo) dans la galerie ? Les images sont ajout\u00e9es ; rien n\u2019est remplac\u00e9 ni supprim\u00e9.")) return;
    const button = $("forge-gallery-restore");
    if (button) button.disabled = true;
    backupNote("Restauration en cours\u2026");
    try {
      const result = await H.api("/api/forge/gallery/import", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: file
      });
      await H.loadGallery();
      backupNote((result.imported || 0) + " image(s) restaur\u00e9e(s)" +
        (result.duplicates ? ", " + result.duplicates + " d\u00e9j\u00e0 pr\u00e9sente(s) ignor\u00e9e(s)" : "") +
        (result.skipped ? ", " + result.skipped + " ignor\u00e9e(s)" : "") +
        (result.quota ? ". Galerie pleine : le reste du ZIP n\u2019a pas \u00e9t\u00e9 import\u00e9. Rien n\u2019a \u00e9t\u00e9 supprim\u00e9." : "."));
    } catch (error) {
      backupNote(error.message || "La restauration a \u00e9chou\u00e9.");
    } finally {
      if (button) button.disabled = false;
      const input = $("forge-gallery-restore-file");
      if (input) input.value = "";
    }
  }
  const backupButton = $("forge-gallery-backup");
  if (backupButton) backupButton.addEventListener("click", () => { backupGallery(); });
  const restoreButton = $("forge-gallery-restore");
  const restoreFile = $("forge-gallery-restore-file");
  if (restoreButton && restoreFile) {
    restoreButton.addEventListener("click", () => restoreFile.click());
    restoreFile.addEventListener("change", () => { restoreGallery(restoreFile.files && restoreFile.files[0]); });
  }

  /* Verify a backup without touching the gallery: every member is read (so its CRC is
     checked) and only counts come back. */
  const verifyButton = $("forge-gallery-verify");
  const verifyFile = $("forge-gallery-verify-file");
  async function verifyGallery(file) {
    if (!file) return;
    if (verifyButton) verifyButton.disabled = true;
    backupNote("V\u00e9rification du ZIP\u2026");
    try {
      const result = await H.api("/api/forge/gallery/restore/verify", {
        method: "POST", headers: { "Content-Type": "application/zip" }, body: file
      });
      backupNote("ZIP v\u00e9rifi\u00e9 : " + (result.verified || 0) + " image(s) lisible(s)" +
        (result.skipped ? ", " + result.skipped + " ignor\u00e9e(s)" : "") + ". Rien n\u2019a \u00e9t\u00e9 restaur\u00e9.");
    } catch (error) {
      backupNote(error.message || "Ce ZIP n\u2019a pas pu \u00eatre v\u00e9rifi\u00e9.");
    } finally {
      if (verifyButton) verifyButton.disabled = false;
      if (verifyFile) verifyFile.value = "";
    }
  }
  if (verifyButton && verifyFile) {
    verifyButton.addEventListener("click", () => verifyFile.click());
    verifyFile.addEventListener("change", () => verifyGallery(verifyFile.files && verifyFile.files[0]));
  }

  /* Galerie: selection mode. The cards stay the gallery's own buttons; in selection
     mode a capture listener takes the tap before it can open the viewer. */
  const galleryGrid = $("forge-gallery");
  const selection = { on: false, ids: new Set() };
  const selectNote = $("forge-gallery-select-note");
  function selectedCards() { return galleryGrid ? [...galleryGrid.querySelectorAll(".forge-card")] : []; }
  function syncSelection() {
    const count = selection.ids.size;
    const label = $("forge-gallery-select-count");
    if (label) label.textContent = count + " image(s) s\u00e9lectionn\u00e9e(s)";
    ["forge-gallery-archive", "forge-gallery-keep", "forge-gallery-fav", "forge-gallery-reject"].forEach((id) => {
      const button = $(id);
      if (button) button.disabled = count === 0;
    });
    selectedCards().forEach((card) => card.classList.toggle("is-selected", selection.ids.has(card.dataset.id)));
  }
  function setSelecting(on) {
    selection.on = Boolean(on);
    selection.ids.clear();
    if (galleryGrid) galleryGrid.dataset.select = selection.on ? "on" : "";
    const toggle = $("forge-gallery-select");
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(selection.on));
      toggle.textContent = selection.on ? "Terminer la s\u00e9lection" : "S\u00e9lectionner";
    }
    const bar = $("forge-gallery-selectbar");
    if (bar) bar.hidden = !selection.on;
    if (selectNote) selectNote.textContent = "";
    syncSelection();
  }
  if (galleryGrid) {
    galleryGrid.addEventListener("click", (event) => {
      if (!selection.on) return;
      const card = event.target.closest(".forge-card");
      if (!card || !card.dataset.id) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = card.dataset.id;
      if (selection.ids.has(id)) selection.ids.delete(id); else selection.ids.add(id);
      syncSelection();
    }, true);
    /* A reload replaces every card: re-apply the selected outline to the new nodes. */
    new MutationObserver(() => { if (selection.on) syncSelection(); }).observe(galleryGrid, { childList: true });
  }
  $("forge-gallery-select")?.addEventListener("click", () => setSelecting(!selection.on));
  $("forge-gallery-select-cancel")?.addEventListener("click", () => setSelecting(false));
  $("forge-gallery-select-all")?.addEventListener("click", () => {
    const cards = selectedCards();
    const all = cards.length > 0 && cards.every((card) => selection.ids.has(card.dataset.id));
    selection.ids.clear();
    if (!all) cards.forEach((card) => { if (card.dataset.id) selection.ids.add(card.dataset.id); });
    syncSelection();
  });
  async function bulkTriage(state) {
    const ids = [...selection.ids];
    if (!ids.length) return;
    if (!window.confirm({ keep: "Garder", favorite: "Marquer favorite", reject: "Rejeter" }[state] +
      " " + ids.length + " image(s) ? Toutes gardent leur place tant qu\u2019elles ne sont pas supprim\u00e9es.")) return;
    if (selectNote) selectNote.textContent = "Enregistrement\u2026";
    try {
      for (const id of ids) await post("/api/forge/gallery/" + encodeURIComponent(id) + "/triage", { state });
      await H.loadGallery();
      setSelecting(false);
    } catch (error) {
      if (selectNote) selectNote.textContent = error.message || "Le tri a \u00e9chou\u00e9 pour une image.";
    }
  }
  $("forge-gallery-keep")?.addEventListener("click", () => bulkTriage("keep"));
  $("forge-gallery-fav")?.addEventListener("click", () => bulkTriage("favorite"));
  $("forge-gallery-reject")?.addEventListener("click", () => bulkTriage("reject"));
  $("forge-gallery-archive")?.addEventListener("click", async () => {
    const ids = [...selection.ids];
    if (!ids.length) return;
    const query = ids.map((id) => encodeURIComponent(id)).join(",");
    try {
      const plan = await H.api("/api/forge/gallery/export/plan?ids=" + query, { cache: "no-store" });
      if (!plan.images) { if (selectNote) selectNote.textContent = "La s\u00e9lection est vide."; return; }
      if (!plan.allowed) {
        if (selectNote) selectNote.textContent = "Sauvegarde impossible : " + fmtBytes(plan.bytes) + " \u00e0 \u00e9crire, limite " +
          fmtBytes(plan.limit_bytes) + " d\u2019espace libre.";
        return;
      }
      if (!window.confirm("Archiver " + ids.length + " image(s) (" + fmtBytes(plan.bytes) +
        ") puis les d\u00e9placer dans la corbeille ? Le ZIP est t\u00e9l\u00e9charg\u00e9 d\u2019abord ; rien n\u2019est effac\u00e9.")) return;
      if (plan.bytes > DIRECT_DOWNLOAD_BYTES) {
        const anchor = document.createElement("a");
        anchor.href = "/api/forge/gallery/export?ids=" + query;
        anchor.download = "hq-forge-selection.zip";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        if (selectNote) selectNote.textContent = "T\u00e9l\u00e9chargement direct de " + fmtBytes(plan.bytes) +
          " : les images restent dans la galerie. Rejette-les apr\u00e8s v\u00e9rification.";
        return;
      }
      if (selectNote) selectNote.textContent = "Pr\u00e9paration du ZIP\u2026";
      const response = await fetch("/api/forge/gallery/export?ids=" + query, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("L\u2019export a \u00e9chou\u00e9.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "hq-forge-selection.zip";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      for (const id of ids) await post("/api/forge/gallery/" + encodeURIComponent(id) + "/triage", { state: "reject" });
      await H.loadGallery();
      setSelecting(false);
      backupNote(ids.length + " image(s) archiv\u00e9e(s) puis d\u00e9plac\u00e9e(s) dans la corbeille.");
    } catch (error) {
      if (selectNote) selectNote.textContent = error.message || "L\u2019archivage a \u00e9chou\u00e9.";
    }
  });

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
    const sig = JSON.stringify([batch.paused, batch.state, batch.tasks.map((t) => [t.id, t.state, t.worker_id, t.dispatched_at, t.finished_at, t.resolution, t.retried, t.step, t.cancel_deferred])]);
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.replaceChildren();
    /* One line answers "what is the GPU doing now" for the whole batch: the images on
       devices, or the next queued one, so the journal is not the only place to look. */
    const live = batch.tasks.filter((t) => ["dispatched", "running", "saving"].includes(t.state));
    const next = batch.tasks.slice().sort((a, b) => a.index - b.index).find((t) => t.state === "queued");
    const now = el("li", "forge-journal-item forge-journal-now");
    if (live.length) {
      now.textContent = "Maintenant : " + live.map((t) => "image " + (t.index + 1) +
        (t.worker_name ? " sur " + t.worker_name : "") + (t.steps ? " \u00b7 pas " + (t.step || 0) + " / " + t.steps : "")).join(" \u00b7 ");
    } else if (next) {
      now.textContent = "Rien sur le GPU : l\u2019image " + (next.index + 1) + " attend un appareil.";
    } else {
      now.textContent = "Rien sur le GPU pour ce lot.";
    }
    list.append(now);
    const pause = $("forge-fleet-batch-pause");
    if (pause) {
      const live = batch.state === "running" || batch.state === "cancelling";
      pause.hidden = !batch.paused && !(live && !batch.cancelled && batch.counts.pending > 0);
      pause.textContent = batch.paused ? "Reprendre le lot" : "Mettre en pause";
      pause.dataset.paused = batch.paused ? "1" : "";
      pause.onclick = async () => {
        pause.disabled = true;
        try {
          const payload = await post("/api/forge/batches/" + encodeURIComponent(batch.batch_id) +
            (batch.paused ? "/resume" : "/pause"), {});
          if (payload && payload.batch) H.showBatch(payload.batch);
        } catch (error) {
          const note = $("forge-fleet-batch-note");
          if (note) note.textContent = error.message || "La pause n\u2019a pas pu \u00eatre enregistr\u00e9e.";
        } finally {
          pause.disabled = false;
        }
      };
    }
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
      /* One copyable line per failed image: device, code, seed and configuration, never
         a prompt (fleet batches are normal-gallery only). */
      if (["failed", "uncertain"].includes(t.state)) {
        const diag = el("button", "secondary forge-journal-diagnostic", "Copier le diagnostic");
        diag.type = "button";
        diag.addEventListener("click", async () => {
          const s = batch.settings || {};
          const text = [
            "Forge \u00b7 lot " + batch.batch_id,
            "image " + (t.index + 1) + " \u00b7 " + (TASK_STATE[t.state] || t.state),
            "appareil " + (t.worker_name || "aucun") + (t.worker_id ? " (" + t.worker_id + ")" : ""),
            "essai " + (t.attempt || 1) + " \u00b7 graine " + (t.seed == null ? "-" : t.seed),
            t.error ? "code " + t.error : "",
            t.message ? "message " + t.message : "",
            "mod\u00e8le " + (s.checkpoint || "-") + " \u00b7 " + (s.width || "?") + "\u00d7" + (s.height || "?") + " \u00b7 " + (s.steps || "?") + " pas"
          ].filter(Boolean).join(" \u00b7 ");
          try {
            await navigator.clipboard.writeText(text);
            diag.textContent = "Copi\u00e9";
          } catch (_) {
            diag.textContent = "Copie impossible";
          }
          setTimeout(() => { diag.textContent = "Copier le diagnostic"; }, 2000);
        });
        li.append(diag);
      }
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
      const cancellable = ["queued", "dispatched", "running", "saving"].includes(t.state) && !t.cancel_deferred;
      if (cancellable) {
        const row = el("div", "forge-actions forge-journal-choice");
        const stop = el("button", "secondary", t.state === "queued" ? "Retirer cette image" : "Annuler cette image");
        stop.type = "button";
        stop.addEventListener("click", async () => {
          stop.disabled = true;
          try {
            const payload = await post("/api/forge/batches/" + encodeURIComponent(batch.batch_id) +
              "/tasks/" + encodeURIComponent(t.id) + "/cancel", {});
            if (payload && payload.batch) H.showBatch(payload.batch);
          } catch (error) {
            stop.disabled = false;
            li.append(el("p", "forge-note", error.message || "L\u2019annulation a \u00e9chou\u00e9."));
          }
        });
        row.append(stop);
        li.append(row);
      } else if (t.cancel_deferred) {
        li.append(el("span", "forge-note", "Annulation demand\u00e9e : l\u2019appareil termine cette image, Forge n\u2019est pas interrompu."));
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