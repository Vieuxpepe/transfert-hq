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
    return kind === "private" ? "/api/forge/vault/images/" : "/api/forge/gallery/";
  }
  function listPath(kind, view) {
    return (kind === "private" ? "/api/forge/vault/gallery" : "/api/forge/gallery") + "?limit=96&view=" + view;
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

  // The vault lock drops every decrypted view this module opened.
  window.hqForgeNextLock = () => {    if (mode === "private" && dialog.open) close();
    if (trashMode === "private" && trash.open) closeTrash();
    const row = $("forge-vault-viewer-triage");
    if (row) row.replaceChildren();
  };
})();