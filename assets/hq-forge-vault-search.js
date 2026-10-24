/* Forge Studio, phase H: searchable vault. The words, tags and results live only in this page's
   memory while the vault is unlocked: searches are POST bodies (never a URL), nothing goes to
   browser storage, and everything here is wiped when the vault locks (button, auto-lock, logout). */
(function () {
  const $ = (id) => document.getElementById(id);
  const H = window.hqForgeHooks;
  const form = $("forge-vault-search");
  if (!H || !form || !H.privateCard) return;
  const q = $("forge-vault-q");
  const filters = $("forge-vault-filters");
  const note = $("forge-vault-search-note");
  const grid = $("forge-vault-gallery");
  const tagsEl = $("forge-vault-tags");
  const collEl = $("forge-vault-collection");
  const labelNote = $("forge-vault-labels-note");
  const LABEL_HINT = labelNote.textContent;
  const post = (path, body) => H.api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  let filter = { tag: "", collection: "" };
  let active = false;
  let viewing = null;

  function wipe() {
    q.value = "";
    filter = { tag: "", collection: "" };
    active = false;
    viewing = null;
    filters.replaceChildren();
    note.textContent = "";
    tagsEl.value = "";
    collEl.value = "";
    labelNote.textContent = LABEL_HINT;
  }

  function chip(text, kind, value) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "forge-vault-chip";
    b.textContent = text;
    const on = filter[kind] === value;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.addEventListener("click", () => { filter = { tag: "", collection: "" }; if (!on) filter[kind] = value; run(); });
    return b;
  }

  async function run() {
    if (!H.vaultUnlocked()) { wipe(); return; }
    const words = q.value.trim();
    if (!words && !filter.tag && !filter.collection) {
      active = false;
      note.textContent = "";
      await H.reloadVault();
      await refreshChips();
      return;
    }
    try {
      const out = await post(H.vaultBase() + "/search", { q: words, tag: filter.tag, collection: filter.collection });
      active = true;
      grid.replaceChildren(...out.images.map((image) => H.privateCard(image)));
      $("forge-vault-empty").hidden = true;
      note.textContent = out.total ? out.total + " image" + (out.total > 1 ? "s" : "") + " trouv\u00e9e" + (out.total > 1 ? "s" : "") + (out.total > out.images.length ? " (les " + out.images.length + " plus r\u00e9centes affich\u00e9es)" : "") + "." : "Aucune image ne correspond.";
      renderChips(out);
    } catch (err) {
      note.textContent = err.message || "Recherche impossible.";
    }
  }

  function renderChips(out) {
    const nodes = [];
    out.collections.forEach(([name, n]) => nodes.push(chip("\u25a6 " + name + " (" + n + ")", "collection", name)));
    out.tags.forEach(([name, n]) => nodes.push(chip("#" + name + " (" + n + ")", "tag", name)));
    filters.replaceChildren(...nodes);
  }

  async function refreshChips() {
    if (!H.vaultUnlocked()) return;
    try { renderChips(await post(H.vaultBase() + "/search", { q: "" })); } catch (_e) { filters.replaceChildren(); }
  }

  form.addEventListener("submit", (event) => { event.preventDefault(); run(); });
  q.addEventListener("search", () => { if (!q.value) run(); });

  // Viewer: tags and collection of the open vault image.
  const prev = window.hqForgeOnViewer;
  window.hqForgeOnViewer = (kind, id, current) => {
    if (prev) prev(kind, id, current);
    if (kind !== "private") return;
    viewing = id;
    tagsEl.value = "";
    collEl.value = "";
    labelNote.textContent = LABEL_HINT;
    H.api(H.vaultBase() + "/images/" + encodeURIComponent(id)).then((d) => {
      if (viewing !== id) return;
      tagsEl.value = (d.tags || []).join(", ");
      collEl.value = d.collection || "";
    }).catch(() => {});
  };
  $("forge-vault-labels-save").addEventListener("click", async () => {
    if (!viewing) return;
    const tags = tagsEl.value.split(",").map((t) => t.trim()).filter(Boolean);
    try {
      const out = await post(H.vaultBase() + "/images/" + encodeURIComponent(viewing) + "/labels", { tags, collection: collEl.value.trim() });
      tagsEl.value = out.tags.join(", ");
      labelNote.textContent = "Enregistr\u00e9 dans le coffre.";
      if (active) run(); else refreshChips();
    } catch (err) {
      labelNote.textContent = err.message || "Enregistrement impossible.";
    }
  });

  // Lock (button, idle auto-lock, logout) empties the vault grid: wipe our memory with it.
  const prevScrub = window.hqForgeScrubPrivate;
  window.hqForgeScrubPrivate = function () { wipe(); return prevScrub ? prevScrub.apply(this, arguments) : undefined; };
  new MutationObserver(() => { if (!H.vaultUnlocked()) wipe(); else if (!active && !filters.childElementCount && grid.childElementCount) refreshChips(); })
    .observe(grid, { childList: true });
})();