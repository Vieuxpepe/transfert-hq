/* Forge Studio, phase J1: prompt bricks. A brick is a reusable piece of prompt (text, and maybe a
   LoRA with its weight and trigger words). Touching a brick only adds it to the prompt field;
   nothing is generated. Bricks live on this HQ (outside the vault) and are never saved in
   private mode. Trigger words are suggested from this PC's LoRA metadata, read-only. */
(function () {
  const $ = (id) => document.getElementById(id);
  const H = window.hqForgeHooks;
  const box = $("forge-bricks");
  if (!H || !box) return;
  const list = $("forge-bricks-list");
  const empty = $("forge-bricks-empty");
  const editor = $("forge-brick-editor");
  const nameEl = $("forge-brick-name");
  const textEl = $("forge-brick-text");
  const loraEl = $("forge-brick-lora");
  const weightField = $("forge-brick-weight-field");
  const weightEl = $("forge-brick-weight");
  const wordsEl = $("forge-brick-words");
  const suggest = $("forge-brick-suggest");
  const note = $("forge-brick-note");
  const saveBtn = $("forge-brick-save");
  const deleteBtn = $("forge-brick-delete");
  const prompt = $("forge-prompt");
  const MAX_PROMPT = 2000;
  let bricks = [];
  let loras = [];
  let editing = null; /* brick id, or "" for a new one */
  let loaded = false;

  const privateMode = () => { try { return !!H.sweepContext().privateMode; } catch (_e) { return false; } };
  const words = () => wordsEl.value.split(",").map((w) => w.trim()).filter(Boolean);
  const weightText = (w) => String(Math.round(Number(w) * 100) / 100);

  function brickText(b) {
    const parts = [];
    if (b.lora) parts.push("<lora:" + b.lora.name + ":" + weightText(b.lora.weight) + ">");
    for (const w of b.triggers || []) parts.push(w);
    if (b.text) parts.push(b.text);
    return parts.join(", ");
  }

  function insert(b) {
    const piece = brickText(b);
    const current = prompt.value.replace(/[\s,]+$/, "");
    const next = current ? current + ", " + piece : piece;
    if (next.length > MAX_PROMPT) { note.textContent = ""; status("Le prompt d\u00e9passerait 2000 caract\u00e8res : brique non ajout\u00e9e."); return; }
    prompt.value = next;
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    status("\u00ab " + b.name + " \u00bb ajout\u00e9e au prompt. Rien n'est lanc\u00e9.");
  }

  function status(text) {
    const target = $("forge-history-note");
    if (target) target.textContent = text;
  }

  function render() {
    list.replaceChildren();
    for (const b of bricks) {
      const row = document.createElement("div");
      row.className = "forge-brick";
      const add = document.createElement("button");
      add.type = "button";
      add.className = "forge-brick-add";
      add.textContent = b.name;
      add.setAttribute("aria-label", "Ajouter la brique " + b.name + " au prompt");
      add.title = brickText(b);
      add.addEventListener("click", () => insert(b));
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "secondary forge-brick-edit";
      edit.textContent = "Modifier";
      edit.setAttribute("aria-label", "Modifier la brique " + b.name);
      edit.addEventListener("click", () => openEditor(b));
      row.append(add, edit);
      list.append(row);
    }
    empty.hidden = bricks.length > 0;
  }

  async function load() {
    try {
      const out = await H.api("/api/forge/bricks", { cache: "no-store" });
      bricks = out.bricks || [];
      if (out.storage === "malformed") status(out.message);
      loaded = true;
    } catch (_e) {
      bricks = [];
    }
    render();
  }

  async function loadLoras() {
    if (loras.length) return;
    try {
      const out = await H.api("/api/forge/bricks/loras", { cache: "no-store" });
      loras = out.loras || [];
    } catch (_e) { loras = []; }
    const keep = loraEl.value;
    loraEl.replaceChildren(new Option("Aucun", ""));
    for (const l of loras) loraEl.append(new Option(l.alias && l.alias !== l.name ? l.alias + " (" + l.name + ")" : l.name, l.name));
    if (keep && ![...loraEl.options].some((o) => o.value === keep)) loraEl.append(new Option(keep + " (absent de ce PC)", keep));
    loraEl.value = keep;
  }

  function showSuggestions() {
    const chosen = loras.find((l) => l.name === loraEl.value);
    weightField.hidden = !loraEl.value;
    suggest.replaceChildren();
    const offered = chosen ? chosen.words.filter((w) => !words().some((x) => x.toLowerCase() === w.toLowerCase())) : [];
    suggest.hidden = !offered.length;
    if (!offered.length) return;
    const label = document.createElement("span");
    label.className = "forge-note";
    label.textContent = "Sugg\u00e9r\u00e9s par les m\u00e9tadonn\u00e9es du LoRA :";
    suggest.append(label);
    for (const w of offered) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "secondary forge-brick-chip";
      chip.textContent = w;
      chip.setAttribute("aria-label", "Ajouter le mot-cl\u00e9 " + w);
      chip.addEventListener("click", () => { wordsEl.value = words().concat([w]).join(", "); showSuggestions(); });
      suggest.append(chip);
    }
  }

  async function openEditor(b) {
    editing = b ? b.id : "";
    nameEl.value = b ? b.name : "";
    textEl.value = b ? b.text : ""; /* never prefilled from the prompt */
    wordsEl.value = b ? (b.triggers || []).join(", ") : "";
    weightEl.value = b && b.lora ? weightText(b.lora.weight) : "0.8";
    loraEl.value = "";
    if (b && b.lora) { loraEl.append(new Option(b.lora.name, b.lora.name)); loraEl.value = b.lora.name; }
    deleteBtn.hidden = !b;
    editor.hidden = false;
    note.textContent = privateMode() ? "Mode priv\u00e9 : aucune brique n'est enregistr\u00e9e." : "";
    saveBtn.disabled = privateMode();
    nameEl.focus();
    await loadLoras();
    if (b && b.lora) loraEl.value = b.lora.name;
    showSuggestions();
  }

  function closeEditor() { editor.hidden = true; editing = null; note.textContent = ""; }

  async function send(body) {
    try {
      const out = await H.api("/api/forge/bricks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      bricks = out.bricks || [];
      render();
      closeEditor();
    } catch (error) {
      note.textContent = error.message || "La brique n'a pas \u00e9t\u00e9 enregistr\u00e9e.";
    }
  }

  saveBtn.addEventListener("click", () => {
    if (privateMode()) { note.textContent = "Mode priv\u00e9 : aucune brique n'est enregistr\u00e9e."; return; }
    const body = { action: editing ? "update" : "create", name: nameEl.value, text: textEl.value, triggers: words() };
    if (editing) body.id = editing;
    if (loraEl.value) body.lora = { name: loraEl.value, weight: Number(String(weightEl.value).replace(",", ".")) };
    send(body);
  });
  deleteBtn.addEventListener("click", () => { if (editing) send({ action: "delete", id: editing }); });
  $("forge-brick-cancel").addEventListener("click", closeEditor);
  $("forge-brick-new").addEventListener("click", () => openEditor(null));
  loraEl.addEventListener("change", showSuggestions);
  wordsEl.addEventListener("input", showSuggestions);
  box.addEventListener("toggle", () => { if (box.open && !loaded) load(); });
  window.hqForgeBricks = { reload: load, text: brickText };
})();
