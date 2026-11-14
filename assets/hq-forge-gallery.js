/* Forge galerie + préréglages : le rendu seulement. hq-forge.js garde les images, le curseur, l'état
   des préréglages et toutes les actions ; ce fichier reconstruit les cartes, les rangées et la liste
   des préréglages à partir des valeurs vivantes que le coeur passe par ctx, donc rien ici ne peut
   garder une copie périmée. Il est chargé après le générateur, quand la vue est déjà utilisable. */
(function () {
  "use strict";

  function create(ctx) {
    const $ = ctx.$;
    const option = ctx.option;

    // Préréglages : l'état, l'éditeur et les actions ont quitté le coeur avec le rendu.
    let presets = [];
    let loadedPreset = null;
    let cleanSnapshot = "";
    let editorMode = "create";
    const presetList = ctx.presetList;
    const presetState = ctx.presetState;
    const presetEditor = ctx.presetEditor;


    function galleryLabel(image, mode) {
      const base = mode === "private" ? "Image du coffre privé" : "Image générée";
      const parts = [base];
      const created = image.created ? new Date(image.created) : null;
      if (created && !Number.isNaN(created.getTime())) {
        parts.push(created.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }));
      }
      if (image.width && image.height) parts.push(image.width + " × " + image.height);
      const ref = String(image.id || "").replace(/^img-/, "").slice(0, 8);
      if (ref) parts.push("réf. " + ref);
      return parts.join(" · ");
    }

    function galleryCaption(image, withModel) {
      /* Size and steps only on the dense contact sheet: a five-column grid cut the
         model name mid-word. Search results get wider cards, so they show it. */
      const bits = [];
      const settings = image.settings || {};
      if (image.width && image.height) bits.push(image.width + " \u00d7 " + image.height);
      if (settings.steps) bits.push(settings.steps + " pas");
      if (withModel && settings.checkpoint) bits.push(ctx.shortModel(settings.checkpoint));
      return bits.join(" \u00b7 ");
    }

    function card(image, mode) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "forge-card";
      button.dataset.id = image.id;
      button.setAttribute("aria-label", galleryLabel(image, mode));
      const img = document.createElement("img");
      img.alt = "";
      button.appendChild(img);
      if (image.triage && image.triage !== "none") {
        button.dataset.triage = image.triage;
        const badge = document.createElement("span");
        badge.className = "forge-card-badge";
        badge.textContent = { keep: "Gard\u00e9e", favorite: "Favori", reject: "Rejet\u00e9e" }[image.triage] || "";
        button.appendChild(badge);
      }
      if (image.settings && image.settings.checkpoint) button.title = image.settings.checkpoint;
      const caption = galleryCaption(image, Boolean(image.settings && image.settings.prompt));
      if (caption) {
        const line = document.createElement("span");
        line.className = "forge-card-caption";
        line.textContent = caption;
        button.appendChild(line);
      }
      if (mode !== "private" && image.settings && image.settings.prompt) {
        const line = document.createElement("span");
        line.className = "forge-card-prompt";
        line.textContent = image.settings.prompt;
        button.appendChild(line);
      }
      if (mode === "private") {
        ctx.privateThumb(image.id).then((url) => { img.src = url; }).catch(() => { img.alt = "Image indisponible"; });
        button.addEventListener("click", () => ctx.openPrivate(image.id, button));
      } else {
        img.src = image.thumb;
        button.addEventListener("click", () => ctx.openViewer(image.id, button));
      }
      return button;
    }

    function galleryRows(rows, reset) {
      if (reset) ctx.gallery.replaceChildren();
      rows.forEach((row) => ctx.gallery.appendChild(card(row)));
      const empty = $("forge-gallery-empty");
      if (!empty) return;
      /* An empty search is not an empty gallery: say which one it is, and drop the
         first-run steps when they no longer apply. */
      const searching = Boolean(ctx.gallerySearching);
      const lead = empty.querySelector("p");
      const steps = empty.querySelector("ol");
      if (lead) lead.textContent = searching
        ? "Aucune image ne correspond à cette recherche."
        : "La galerie HQ est vide. Les images de Forge ne sont pas copiées ici toutes seules.";
      if (steps) steps.hidden = searching;
      empty.hidden = ctx.gallery.children.length > 0;
    }

    function renderPresetList() {
      const current = presetList.value;
      presetList.replaceChildren();
      option(presetList, "", "Aucun");
      presets.forEach((item) => option(presetList, item.id, item.name + (item.kind === "creative" ? " · créatif" : " · technique")));
      if ([...presetList.options].some((item) => item.value === current)) presetList.value = current;
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

      function presetKind() {
        const chosen = document.querySelector('input[name="forge-preset-kind"]:checked');
        return chosen && chosen.value === "creative" ? "creative" : "technical";
      }
      function currentSettings(kind) {
        return {
          kind: kind,
          prompt: kind === "creative" ? ctx.promptEl.value : "",
          negative_prompt: ctx.negativeEl.value,
          checkpoint: ctx.checkpointEl.value,
          sampler_name: ctx.samplerEl.value,
          scheduler: ctx.schedulerEl.value,
          width: Number($("forge-width").value),
          height: Number($("forge-height").value),
          steps: Number($("forge-steps").value),
          cfg_scale: Number($("forge-cfg").value),
          seed: ctx.forgeSeed(),
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
      function selectedPreset() {
        return presets.find((item) => item.id === presetList.value) || null;
      }
      async function loadPresetList() {
        const data = await ctx.api("/api/forge/presets");
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
        take(ctx.checkpointEl, preset.checkpoint, "modèle");
        take(ctx.samplerEl, preset.sampler_name, "échantillonneur");
        take(ctx.schedulerEl, preset.scheduler, "planificateur");
        if (preset.include_prompt) ctx.promptEl.value = preset.prompt || "";
        if (window.hqForgeTaint) window.hqForgeTaint();
        ctx.negativeEl.value = preset.negative_prompt || "";
        $("forge-width").value = String(preset.width);
        $("forge-height").value = String(preset.height);
        $("forge-steps").value = String(preset.steps);
        $("forge-cfg").value = String(preset.cfg_scale);
        ctx.applySeed(preset.seed);
        $("forge-iter").value = String(preset.n_iter);
        ctx.applyHires(preset);
        if (preset.enable_hr) take($("forge-hr-upscaler"), preset.hr_upscaler, "agrandisseur");
        ctx.describeChoices(false);
        ctx.syncActions();
        loadedPreset = preset;
        cleanSnapshot = snapshotOf(currentSettings(preset.kind));
        presetState.dataset.partial = missing.length ? "Introuvable : " + missing.join(", ") + "." : "";
        presetList.value = preset.id;
        refreshPresetState();
      }
      function syncPresetPrivacy() {
        const creative = editorMode === "create" && presetKind() === "creative";
        $("forge-preset-privacy").hidden = !creative;
        $("forge-preset-privacy-vault").hidden = !creative || ctx.destination() !== "private";
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
        const data = await ctx.api("/api/forge/presets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        presets = data.presets || [];
        renderPresetList();
        return data;
      }

    function init() {
      if (!presetList) return;
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
              $("forge-preset-update-vault").hidden = ctx.destination() !== "private";
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
            $("forge-preset-export-vault").hidden = ctx.destination() !== "private";
          });
          $("forge-preset-export-cancel").addEventListener("click", () => { $("forge-preset-export-gate").hidden = true; });
          $("forge-preset-export-confirm").addEventListener("click", async () => {
            if ($("forge-preset-export-gate").hidden) return;
            const data = await ctx.api("/api/forge/presets");
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
              $("forge-preset-privacy-vault").hidden = ctx.destination() !== "private" || $("forge-preset-privacy").hidden;
              $("forge-preset-export-vault").hidden = ctx.destination() !== "private";
              $("forge-preset-update-vault").hidden = ctx.destination() !== "private";
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
    }

    return { galleryLabel, galleryCaption, card, galleryRows, renderPresetList, refreshPresetState, loadPresetList, applyPreset, syncPresetPrivacy,
            openPresetEditor, postPreset, init };
  }

  window.hqForgeGallery = { create };
})();
