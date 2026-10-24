/* Forge Studio, phase J3: house style. Indicatif: the most common technical settings among the
   images kept in the gallery (never the vault). Applying only fills fields; nothing starts and
   the model is never changed. */
(function () {
  const $ = (id) => document.getElementById(id);
  const H = window.hqForgeHooks;
  const box = $("forge-style");
  if (!H || !box) return;
  const list = $("forge-style-list");
  const note = $("forge-style-note");
  const apply = $("forge-style-apply");
  const negBtn = $("forge-style-negative");
  const done = $("forge-style-done");
  let style = null;

  const fr = (n) => String(n).replace(".", ",");
  const share = (p) => " (" + p.count + " sur " + p.of + ")";

  function row(term, value) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }

  async function load() {
    list.replaceChildren();
    done.textContent = "";
    apply.hidden = true;
    negBtn.hidden = true;
    note.textContent = "Calcul\u2026";
    try {
      style = await H.api("/api/forge/house-style", { cache: "no-store" });
    } catch (error) {
      note.textContent = error.message || "Style maison indisponible.";
      return;
    }
    if (!style.enough) {
      note.textContent = "Indicatif. Il faut au moins " + style.minimum + " images gard\u00e9es ; vous en avez " + style.kept + ".";
      return;
    }
    note.textContent = "Indicatif, tir\u00e9 de " + style.kept + " images gard\u00e9es ou favorites.";
    const s = style.style;
    if (s.sampler_name) row("\u00c9chantillonneur", s.sampler_name.value + share(s.sampler_name));
    if (s.scheduler) row("Planificateur", s.scheduler.value + share(s.scheduler));
    if (s.size) row("Taille", s.size.value.width + " \u00d7 " + s.size.value.height + share(s.size));
    if (s.steps) row("Pas", s.steps.value + share(s.steps));
    if (s.cfg_scale) row("Suivi du prompt", fr(s.cfg_scale.value) + share(s.cfg_scale));
    if (style.model) row("Mod\u00e8le le plus gard\u00e9", style.model.value + share(style.model) + " \u2014 affich\u00e9 seulement, jamais appliqu\u00e9");
    if (style.negative_prompt) row("Prompt n\u00e9gatif habituel", style.negative_prompt.value + share(style.negative_prompt));
    apply.hidden = !Object.keys(s).length;
    negBtn.hidden = !style.negative_prompt;
  }

  apply.addEventListener("click", () => {
    if (!style || !style.enough) return;
    const s = style.style;
    const values = {
      sampler_name: s.sampler_name && s.sampler_name.value,
      scheduler: s.scheduler && s.scheduler.value,
      width: s.size && s.size.value.width,
      height: s.size && s.size.value.height,
      steps: s.steps && s.steps.value,
      cfg_scale: s.cfg_scale && s.cfg_scale.value
      /* no checkpoint: the model is never changed */
    };
    const out = H.applyTechnical(values);
    if (H.noteHouseStyle) H.noteHouseStyle(values);  // the finished image gets the soft ripple while these settings stay
    done.textContent = (out.done.length ? "Rempli : " + out.done.join(", ") + ". " : "") +
      (out.missing.length ? "Absent de ce Forge : " + out.missing.join(", ") + ". " : "") + "Rien n'est lanc\u00e9.";
  });

  negBtn.addEventListener("click", () => {
    if (!style || !style.negative_prompt) return;
    const field = $("forge-negative");
    const fold = $("forge-negative-fold");
    if (fold) fold.open = true;
    field.value = style.negative_prompt.value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    done.textContent = "Prompt n\u00e9gatif rempli. Rien n'est lanc\u00e9.";
  });

  box.addEventListener("toggle", () => { if (box.open) load(); });
})();
