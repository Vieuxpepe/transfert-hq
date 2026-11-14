/* Seed constellation: nine cheap local previews in one Forge batch, then choose
   one exact seed. The previews are normal-mode only and exist in the server's
   memory. This controller never writes a prompt, seed or image to storage. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const H = window.hqForgeHooks;
  const seedInput = $("forge-seed");
  const seedNote = $("forge-seed-note");
  if (!H || !seedInput || !seedNote || $("forge-preview")) return;

  const section = document.createElement("section");
  section.id = "forge-preview";
  section.className = "forge-preview";
  section.setAttribute("aria-labelledby", "forge-preview-title");
  section.innerHTML = `
    <div class="forge-preview-head">
      <div>
        <h3 id="forge-preview-title">Constellation de graines</h3>
        <p class="forge-note">Neuf aperçus locaux, six pas, jamais conservés.</p>
      </div>
      <button type="button" id="forge-preview-run" class="secondary">Explorer neuf graines</button>
    </div>
    <div id="forge-preview-grid" class="forge-preview-grid" role="group" aria-label="Aperçus de graines"></div>
    <p id="forge-preview-status" class="forge-note" role="status" aria-live="polite"></p>`;
  seedNote.parentNode.insertBefore(section, seedNote.nextSibling);

  const grid = $("forge-preview-grid");
  const runButton = $("forge-preview-run");
  const status = $("forge-preview-status");
  const COUNT = 9;
  let running = false;
  let selected = null;

  function randomSeed() {
    if (window.crypto && window.crypto.getRandomValues) {
      const value = new Uint32Array(1);
      window.crypto.getRandomValues(value);
      return value[0];
    }
    return Math.floor(Math.random() * 4294967296);
  }

  function currentSeed() {
    if (seedInput.disabled) return null;
    const value = Number(seedInput.value);
    return Number.isInteger(value) && value >= 0 && value < 4294967296 ? value : null;
  }

  function seedsFromBase(base) {
    return Array.from({ length: COUNT }, (_, index) => (base + index) % 4294967296);
  }

  function settingsForRun() {
    let context;
    try { context = H.sweepContext(); } catch (_) { context = null; }
    if (!context || context.privateMode) {
      status.textContent = "Les aperçus sont disponibles en mode Galerie seulement.";
      return null;
    }
    const settings = context.settings || {};
    if (!settings.prompt || !String(settings.prompt).trim()) {
      status.textContent = "Écris un prompt avant d'explorer les graines.";
      return null;
    }
    if (!settings.checkpoint || !settings.sampler_name || !settings.width || !settings.height) {
      status.textContent = "Choisis un modèle et un format avant l'aperçu.";
      return null;
    }
    return settings;
  }

  function setStatus(text) {
    status.textContent = text || "";
  }

  function setTileSeed(tile, seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed >= 4294967296) return;
    tile.dataset.seed = String(seed);
    const label = tile.querySelector(".forge-preview-seed");
    if (label) label.textContent = String(seed);
    tile.setAttribute("aria-label", "Choisir la graine " + seed);
  }

  function makeTile(seed) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "forge-preview-tile is-empty";
    tile.dataset.seed = String(seed);
    tile.setAttribute("aria-label", "Choisir la graine " + seed);
    tile.setAttribute("aria-pressed", "false");
    const placeholder = document.createElement("span");
    placeholder.className = "forge-preview-progress";
    placeholder.textContent = "…";
    placeholder.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "forge-preview-seed";
    label.textContent = String(seed);
    tile.append(placeholder, label);
    tile.addEventListener("click", () => choose(Number(tile.dataset.seed), tile));
    return tile;
  }

  function choose(seed, tile) {
    selected = seed;
    grid.querySelectorAll(".forge-preview-tile").forEach((item) => {
      item.classList.toggle("is-selected", item === tile);
      item.setAttribute("aria-pressed", item === tile ? "true" : "false");
    });
    try { H.applySeed(seed); } catch (_) { /* the field is still the source of truth */ }
    seedInput.dispatchEvent(new Event("input", { bubbles: true }));
    setStatus("Graine " + seed + " choisie. Rien n'est lancé.");
  }

  function finishTile(tile, preview) {
    setTileSeed(tile, preview.seed);
    tile.classList.remove("is-empty");
    tile.classList.add("is-complete");
    const image = document.createElement("img");
    image.loading = "lazy";
    image.alt = "";
    image.src = "/api/forge/preview/" + encodeURIComponent(preview.id) + "/image?t=" + Date.now();
    const placeholder = tile.querySelector(".forge-preview-progress");
    if (placeholder) placeholder.remove();
    tile.insertBefore(image, tile.firstChild);
    if (preview.seed === selected) {
      tile.classList.add("is-selected");
      tile.setAttribute("aria-pressed", "true");
    }
  }

  function failTile(tile, message) {
    tile.classList.remove("is-empty");
    tile.classList.add("is-failed");
    tile.disabled = true;
    const placeholder = tile.querySelector(".forge-preview-progress");
    if (placeholder) placeholder.textContent = "!";
    if (message) setStatus(message);
  }

  async function waitForPreview(id, tile) {
    for (let attempt = 0; attempt < 480; attempt += 1) {
      const payload = await H.api("/api/forge/preview/" + encodeURIComponent(id), { cache: "no-store" });
      const preview = payload && payload.preview;
      if (!preview) throw new Error("Aperçu introuvable.");
      if (preview.state === "completed") {
        finishTile(tile, preview);
        return preview;
      }
      if (preview.state === "failed") throw new Error(preview.message || "Aperçu impossible.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("L'aperçu dure plus longtemps que prévu.");
  }

  async function run() {
    if (running) return;
    const settings = settingsForRun();
    if (!settings) return;
    running = true;
    runButton.disabled = true;
    runButton.setAttribute("aria-busy", "true");
    grid.replaceChildren();
    selected = null;
    const base = currentSeed();
    const start = base == null ? randomSeed() : base;
    const tiles = seedsFromBase(start).map((seed) => {
      const tile = makeTile(seed);
      grid.append(tile);
      return tile;
    });
    setStatus("Forge esquisse neuf graines en un seul lot…");
    let failures = 0;
    try {
      let previews;
      try {
        const payload = await H.api("/api/forge/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: settings.prompt,
            negative_prompt: settings.negative_prompt || "",
            checkpoint: settings.checkpoint,
            sampler_name: settings.sampler_name,
            scheduler: settings.scheduler || "automatic",
            width: Number(settings.width),
            height: Number(settings.height),
            cfg_scale: Number(settings.cfg_scale),
            seed: start,
            count: COUNT
          })
        });
        const list = payload && payload.previews;
        previews = Array.isArray(list) ? list.slice(0, COUNT) : (payload && payload.preview ? [payload.preview] : []);
      } catch (error) {
        failures = COUNT;
        tiles.forEach((tile) => failTile(tile, error.message || "Aperçu impossible."));
        return;
      }
      if (!previews.length) {
        failures = COUNT;
        tiles.forEach((tile) => failTile(tile, "Aperçu introuvable."));
        return;
      }
      previews.forEach((preview, index) => {
        if (preview && preview.id) setTileSeed(tiles[index], preview.seed);
      });
      if (previews.length < tiles.length) {
        failures += tiles.length - previews.length;
        for (let index = previews.length; index < tiles.length; index += 1) {
          failTile(tiles[index], "Aperçu manquant.");
        }
      }
      await Promise.all(previews.map((preview, index) => {
        if (!preview || !preview.id) {
          failures += 1;
          failTile(tiles[index], "Aperçu introuvable.");
          return false;
        }
        return waitForPreview(preview.id, tiles[index]).then(() => true).catch((error) => {
          failures += 1;
          failTile(tiles[index], error.message || "Aperçu impossible.");
          return false;
        });
      }));
      if (!selected && !failures) setStatus("Clique une graine pour la choisir. Rien n'est lancé.");
    } finally {
      running = false;
      runButton.disabled = false;
      runButton.removeAttribute("aria-busy");
      runButton.textContent = "Nouvelle constellation";
    }
  }

  runButton.addEventListener("click", run);
})();
