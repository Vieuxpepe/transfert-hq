/* Forge Plateau: Le Casting and the character sheet.
   Casting cards are normal-gallery prompt bricks with kind="cast": a name, prompt
   DNA, trigger words, normal reference images and an optional preferred seed.
   Their references are labels for the owner, not image conditioning: Forge never
   receives vault data, and this module refuses private mode for every saved or
   launched action. No new route, no new storage file. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const H = window.hqForgeHooks;
  const anchor = $("forge-bricks");
  if (!H || !anchor || $("forge-casting")) return;

  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const clip = (value, size) => { const text = String(value == null ? "" : value).trim(); return text.length > size ? text.slice(0, size - 1) + "…" : text; };
  const privateMode = () => { try { return !!H.sweepContext().privateMode; } catch (_) { return false; } };
  const currentSeance = () => { try { return window.hqForgeStudio && window.hqForgeStudio.current(); } catch (_) { return null; } };

  const section = document.createElement("details");
  section.id = "forge-casting";
  section.className = "forge-casting";
  section.innerHTML = `
    <summary>Le Casting <span id="forge-cast-count" class="forge-cast-count" hidden></span></summary>
    <div class="forge-label-row">
      <span class="forge-note">Des visages, des décors, des costumes à retrouver. Tout vient de la galerie normale, jamais du coffre.</span>
      <span class="forge-help-wrap"><button data-help="Ouvre l'aide du casting." type="button" class="forge-help" aria-expanded="false" aria-controls="forge-help-casting">Aide</button><p id="forge-help-casting" class="forge-help-pop" role="tooltip">Une carte de casting garde un nom, une description réutilisable, ses mots-clés, ses images de référence et une graine préférée. « Prompt » l'ajoute au brief, « Réfs » l'ajoute à la séance ouverte, « Fiche » lance une planche de personnage.</p></span>
    </div>
    <div id="forge-cast-list" class="forge-cast-list" role="list" aria-label="Cartes de casting"></div>
    <p id="forge-cast-empty" class="forge-cast-empty">Aucun personnage ou décor pour l’instant. Crée une carte pour retrouver un visage, un lieu ou un costume.</p>
    <div class="forge-actions">
      <button type="button" id="forge-cast-new" class="secondary">Nouveau personnage</button>
    </div>
    <div id="forge-cast-editor" class="forge-cast-editor" hidden aria-labelledby="forge-cast-editor-title">
      <div class="forge-cast-editor-head"><strong id="forge-cast-editor-title">Nouvelle carte</strong><span class="forge-note">Un nom, une description, un portrait : la carte reste dans la galerie normale.</span></div>
      <div class="forge-cast-editor-grid">
        <div class="field"><label for="forge-cast-name">Nom</label><input id="forge-cast-name" maxlength="60" autocomplete="off" placeholder="Mina, le phare, la cuisine…"/></div>
        <div class="field"><label for="forge-cast-seed">Graine préférée</label><input id="forge-cast-seed" type="number" min="0" max="4294967295" step="1" inputmode="numeric" placeholder="auto"/><small>facultatif</small></div>
        <div class="field forge-cast-wide"><label for="forge-cast-text">Description réutilisable</label><textarea id="forge-cast-text" rows="3" maxlength="400" placeholder="cheveux courts roux, manteau gris, regard direct"></textarea></div>
        <div class="field forge-cast-wide"><label for="forge-cast-words">Mots-clés</label><input id="forge-cast-words" maxlength="500" autocomplete="off" spellcheck="false" placeholder="séparés par des virgules"/></div>
      </div>
      <div class="forge-cast-refs-head"><span>Références</span><button type="button" id="forge-cast-pick" class="secondary">Choisir</button></div>
      <div id="forge-cast-refs" class="forge-cast-refs" aria-label="Références du casting"></div>
      <p id="forge-cast-note" class="forge-note" role="status" aria-live="polite"></p>
      <div class="forge-actions">
        <button type="button" id="forge-cast-save">Enregistrer la carte</button>
        <button type="button" id="forge-cast-delete" class="secondary" hidden>Supprimer</button>
        <button type="button" id="forge-cast-cancel" class="secondary">Annuler</button>
      </div>
    </div>
    <p id="forge-cast-status" class="forge-note" role="status" aria-live="polite"></p>`;
  anchor.parentNode.insertBefore(section, anchor);

  const list = $("forge-cast-list");
  const empty = $("forge-cast-empty");
  const editor = $("forge-cast-editor");
  const nameEl = $("forge-cast-name");
  const textEl = $("forge-cast-text");
  const wordsEl = $("forge-cast-words");
  const seedEl = $("forge-cast-seed");
  const refsBox = $("forge-cast-refs");
  const note = $("forge-cast-note");
  const status = $("forge-cast-status");
  const saveBtn = $("forge-cast-save");
  const deleteBtn = $("forge-cast-delete");
  let cards = [];
  let refs = [];
  let editing = null;
  let loaded = false;

  const words = () => wordsEl.value.split(",").map((word) => word.trim()).filter(Boolean);
  const cardRefs = (card) => (Array.isArray(card.reference_ids) ? card.reference_ids : []);
  const cardText = (card) => {
    const parts = [];
    if (card.text) parts.push(card.text);
    for (const word of card.triggers || []) parts.push(word);
    return parts.join(", ");
  };

  function setStatus(text) { status.textContent = text || ""; }
  function setNote(text) { note.textContent = text || ""; }

  function renderRefs() {
    refsBox.replaceChildren();
    if (!refs.length) {
      const hint = document.createElement("span");
      hint.className = "forge-note";
      hint.textContent = "Aucune référence. La fiche utilisera seulement la description.";
      refsBox.append(hint);
      return;
    }
    for (const id of refs) {
      const figure = document.createElement("figure");
      figure.className = "forge-cast-ref";
      const image = document.createElement("img");
      image.loading = "lazy";
      image.src = "/api/forge/gallery/" + encodeURIComponent(id) + "/thumb";
      image.alt = "";
      const caption = document.createElement("figcaption");
      caption.textContent = clip(id.replace(/^img-/, ""), 8);
      figure.append(image, caption);
      refsBox.append(figure);
    }
  }

  function initials(name) {
    return String(name || "").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "?";
  }

  function render() {
    list.replaceChildren();
    const count = $("forge-cast-count");
    if (count) {
      count.hidden = !cards.length;
      count.textContent = cards.length > 1 ? cards.length + " cartes" : cards.length + " carte";
    }
    for (const card of cards) {
      const article = document.createElement("article");
      article.className = "forge-cast-card";
      article.setAttribute("role", "listitem");
      const visual = document.createElement("div");
      visual.className = "forge-cast-visual";
      const cover = cardRefs(card)[0];
      if (cover) {
        visual.classList.add("has-image");
        const image = document.createElement("img");
        image.loading = "lazy";
        image.src = "/api/forge/gallery/" + encodeURIComponent(cover) + "/thumb";
        image.alt = "";
        visual.append(image);
      } else {
        const monogram = document.createElement("span");
        monogram.className = "forge-cast-monogram";
        monogram.setAttribute("aria-hidden", "true");
        monogram.textContent = initials(card.name);
        const hint = document.createElement("span");
        hint.className = "forge-cast-visual-hint";
        hint.textContent = "Portrait à choisir";
        visual.append(monogram, hint);
      }
      const tag = document.createElement("span");
      tag.className = "forge-cast-tag";
      tag.textContent = "Casting";
      visual.append(tag);
      const body = document.createElement("div");
      body.className = "forge-cast-body";
      const head = document.createElement("div");
      head.className = "forge-cast-card-head";
      const title = document.createElement("h3");
      title.textContent = card.name;
      const seed = document.createElement("span");
      seed.className = "forge-cast-seed";
      seed.textContent = card.seed == null ? "graine du formulaire" : "graine " + card.seed;
      head.append(title, seed);
      const dna = document.createElement("p");
      dna.className = "forge-cast-dna";
      dna.textContent = cardText(card) || "Description à compléter.";
      const refsRow = document.createElement("div");
      refsRow.className = "forge-cast-card-refs";
      const strip = cardRefs(card).slice(cover ? 1 : 0, cover ? 5 : 4);
      for (const id of strip) {
        const image = document.createElement("img");
        image.loading = "lazy";
        image.src = "/api/forge/gallery/" + encodeURIComponent(id) + "/thumb";
        image.alt = "";
        refsRow.append(image);
      }
      if (!refsRow.childElementCount) {
        const hint = document.createElement("span");
        hint.className = "forge-note";
        hint.textContent = cover ? "1 référence" : "Sans référence";
        refsRow.append(hint);
      } else if (cardRefs(card).length > strip.length + (cover ? 1 : 0)) {
        const more = document.createElement("span");
        more.className = "forge-cast-more";
        more.textContent = "+" + (cardRefs(card).length - strip.length - (cover ? 1 : 0));
        refsRow.append(more);
      }
      const actions = document.createElement("div");
      actions.className = "forge-cast-card-actions";
      const promptBtn = document.createElement("button");
      promptBtn.type = "button";
      promptBtn.textContent = "Prompt";
      promptBtn.addEventListener("click", () => insertPrompt(card));
      const refsBtn = document.createElement("button");
      refsBtn.type = "button";
      refsBtn.className = "secondary";
      refsBtn.textContent = "Réfs";
      refsBtn.disabled = !cardRefs(card).length;
      refsBtn.addEventListener("click", () => addReferences(card));
      const sheetBtn = document.createElement("button");
      sheetBtn.type = "button";
      sheetBtn.className = "secondary";
      sheetBtn.textContent = "Fiche";
      sheetBtn.addEventListener("click", () => characterSheet(card));
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "secondary";
      editBtn.textContent = "Modifier";
      editBtn.addEventListener("click", () => openEditor(card));
      actions.append(promptBtn, refsBtn, sheetBtn, editBtn);
      body.append(head, dna, refsRow, actions);
      article.append(visual, body);
      list.append(article);
    }
    empty.hidden = cards.length > 0;
  }

  async function load() {
    try {
      const out = await H.api("/api/forge/bricks", { cache: "no-store" });
      cards = (out.bricks || []).filter((brick) => brick.kind === "cast");
      if (out.storage === "malformed") setStatus(out.message);
      loaded = true;
    } catch (_) {
      cards = [];
    }
    render();
  }

  function closeEditor() {
    editor.hidden = true;
    editing = null;
    refs = [];
    setNote("");
  }

  function openEditor(card) {
    editing = card ? card.id : "";
    nameEl.value = card ? card.name : "";
    textEl.value = card ? (card.text || "") : "";
    wordsEl.value = card ? (card.triggers || []).join(", ") : "";
    seedEl.value = card && card.seed != null ? String(card.seed) : "";
    refs = card ? cardRefs(card).slice(0, 8) : [];
    deleteBtn.hidden = !card;
    const title = $("forge-cast-editor-title");
    if (title) title.textContent = card ? "Modifier « " + card.name + " »" : "Nouvelle carte";
    editor.hidden = false;
    renderRefs();
    const blocked = privateMode();
    saveBtn.disabled = blocked;
    setNote(blocked ? "Mode privé : une carte de casting ne peut pas être enregistrée." : "");
    nameEl.focus();
  }

  function insertPrompt(card) {
    const prompt = $("forge-prompt");
    if (!prompt) return;
    const piece = cardText(card);
    if (!piece) { setStatus("Cette carte n'a pas encore de description."); return; }
    const current = prompt.value.replace(/[\s,]+$/, "");
    const next = current ? current + ", " + piece : piece;
    if (next.length > 2000) { setStatus("Le prompt dépasserait 2000 caractères : carte non ajoutée."); return; }
    prompt.value = next;
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    setStatus("« " + card.name + " » ajouté au prompt. Rien n'est lancé.");
  }

  async function addReferences(card) {
    if (!window.hqForgeStudio || typeof window.hqForgeStudio.addReferences !== "function") {
      setStatus("Ouvre une séance pour y ajouter les références.");
      return;
    }
    if (!currentSeance()) { setStatus("Ouvre une séance pour y ajouter les références."); return; }
    const ok = await window.hqForgeStudio.addReferences(cardRefs(card));
    setStatus(ok ? "Références ajoutées à la séance « " + currentSeance().name + " »." : "Ces références sont déjà dans la séance.");
  }

  function sheetPrompt(card) {
    const base = "character reference sheet, same character across four separate views: front view, three-quarter view, side profile, back view, neutral standing pose, full body, plain light background, consistent face, hair, outfit and proportions, model sheet";
    const dna = cardText(card);
    return (base + (dna ? ", " + dna : "") + ", no text, no watermark").slice(0, 2000);
  }

  function characterSheet(card) {
    if (privateMode()) { setStatus("La fiche personnage reste en mode Galerie."); return; }
    if (!H.runNormalSettings) { setStatus("La fiche n'est pas disponible dans cette version de Forge."); return; }
    let ctx;
    try { ctx = H.sweepContext(); } catch (_) { ctx = { settings: {}, privateMode: false }; }
    const settings = Object.assign({}, ctx.settings || {}, {
      prompt: sheetPrompt(card),
      negative_prompt: "multiple characters, different face, different outfit, cropped, text, watermark",
      n_iter: 1,
      batch_size: 1
    });
    if (card.seed != null) settings.seed = card.seed;
    if (H.runNormalSettings(settings)) {
      setStatus("Fiche de « " + card.name + " » lancée en mode Galerie. Les références restent dans la carte.");
    } else {
      setStatus("Forge termine ou refuse une génération : la fiche n'est pas partie.");
    }
  }

  async function save() {
    if (privateMode()) { setNote("Mode privé : une carte de casting ne peut pas être enregistrée."); return; }
    const name = nameEl.value.trim();
    if (!name) { setNote("Donne un nom à cette carte."); return; }
    const body = {
      action: editing ? "update" : "create",
      kind: "cast",
      name,
      text: textEl.value,
      triggers: words(),
      reference_ids: refs.slice(0, 8),
      seed: seedEl.value === "" ? null : Number(seedEl.value)
    };
    if (editing) body.id = editing;
    try {
      const out = await H.api("/api/forge/bricks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      cards = (out.bricks || []).filter((brick) => brick.kind === "cast");
      render();
      closeEditor();
      setStatus("Carte de casting enregistrée.");
      if (window.hqForgeBricks && typeof window.hqForgeBricks.reload === "function") window.hqForgeBricks.reload();
    } catch (error) {
      setNote(error.message || "La carte n'a pas été enregistrée.");
    }
  }

  async function remove() {
    if (!editing || privateMode()) return;
    if (!window.confirm("Supprimer cette carte de casting ? Les images de la galerie restent en place.")) return;
    try {
      const out = await H.api("/api/forge/bricks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id: editing }) });
      cards = (out.bricks || []).filter((brick) => brick.kind === "cast");
      render();
      closeEditor();
      setStatus("Carte supprimée. Les images restent dans la galerie.");
      if (window.hqForgeBricks && typeof window.hqForgeBricks.reload === "function") window.hqForgeBricks.reload();
    } catch (error) { setNote(error.message || "La carte n'a pas été supprimée."); }
  }

  async function chooseRefs() {
    if (!window.hqForgeStudio || typeof window.hqForgeStudio.pickImages !== "function") {
      setNote("Le sélecteur d'images n'est pas disponible.");
      return;
    }
    const picked = await window.hqForgeStudio.pickImages("Références du casting", 8, refs);
    if (picked === null) return;
    refs = picked.slice(0, 8);
    renderRefs();
  }

  saveBtn.addEventListener("click", save);
  deleteBtn.addEventListener("click", remove);
  $("forge-cast-cancel").addEventListener("click", closeEditor);
  $("forge-cast-new").addEventListener("click", () => openEditor(null));
  $("forge-cast-pick").addEventListener("click", chooseRefs);
  section.addEventListener("toggle", () => { if (section.open && !loaded) load(); });
  if (section.open) load();
})();
