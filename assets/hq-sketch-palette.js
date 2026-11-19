/* Transfert HQ — palette de couleurs de « Forge peint ». The paint panel already owns the prompt and the
 * Forge request; this module decorates its mount and adds a small colour palette that writes an explicit
 * « dominante … » phrase into that same prompt. It never talks to the bridge itself: the existing
 * `input` listener in hq-sketch-paint.js versions the prompt and schedules the next painting, exactly as
 * a typed change would. Kept separate from the verified paint asset so its tests and hash stay untouched. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root && !root.HqSketchPaintPalette) root.HqSketchPaintPalette = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const COLORS = Object.freeze([
    { id: "bleu", label: "Bleu", phrase: "dominante bleue", swatch: "#3b6ea5", ink: "#ffffff" },
    { id: "vert", label: "Vert", phrase: "dominante verte", swatch: "#4e7a4a", ink: "#ffffff" },
    { id: "ocre", label: "Ocre", phrase: "dominante ocre", swatch: "#b07a2a", ink: "#1d1a14" },
    { id: "rouge", label: "Rouge", phrase: "dominante rouge", swatch: "#a63d3d", ink: "#ffffff" },
    { id: "violet", label: "Violet", phrase: "dominante violette", swatch: "#6b4b8a", ink: "#ffffff" },
    { id: "neutre", label: "Neutre", phrase: "dominante neutre", swatch: "#8a8f98", ink: "#ffffff" },
  ]);

  function colorById(id) {
    return COLORS.find((c) => c.id === id) || null;
  }

  function suffixFor(color) {
    return color ? " · " + color.phrase : "";
  }

  /** Replace the previously selected colour phrase, preserving everything the user typed. */
  function withColor(text, previousId, nextId) {
    const previous = colorById(previousId);
    let body = String(text == null ? "" : text);
    if (previous) {
      const old = suffixFor(previous);
      if (body === previous.phrase) body = "";
      else if (body.endsWith(old)) body = body.slice(0, -old.length).replace(/\s+$/, "");
    }
    const chosen = colorById(nextId);
    if (!chosen) return { text: body, id: "" };
    if (!body.trim()) body = "";
    const suffix = suffixFor(chosen);
    const addition = body.trim() ? suffix : suffix.replace(/^ · /, "");
    return { text: body + addition, id: chosen.id };
  }

  function decorate(doc, panel, prompt, win) {
    if (!doc || !panel || !prompt || panel.querySelector(".sk-paint-palette")) return;
    const row = doc.createElement("div");
    row.className = "sk-paint-row sk-paint-palette";
    row.style.flexWrap = "wrap";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Palette de couleurs");
    const label = doc.createElement("span");
    label.textContent = "Palette";
    row.appendChild(label);

    let selected = "";
    const buttons = COLORS.map((c) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "sk-paint-alt";
      b.dataset.color = c.id;
      b.textContent = c.label;
      b.title = "Dominante " + c.label.toLowerCase() + " dans la peinture";
      b.setAttribute("aria-label", "Palette : " + c.phrase);
      b.setAttribute("aria-pressed", "false");
      b.style.background = c.swatch;
      b.style.color = c.ink;
      b.style.borderColor = "transparent";
      b.style.padding = "0 10px";
      b.style.minWidth = "0";
      b.addEventListener("click", () => {
        const next = selected === c.id ? "" : c.id;
        const applied = withColor(prompt.value, selected, next);
        selected = applied.id;
        prompt.value = applied.text;
        prompt.dispatchEvent(new win.Event("input", { bubbles: true }));
        sync();
      });
      row.appendChild(b);
      return b;
    });

    function sync() {
      for (const b of buttons) {
        const on = b.dataset.color === selected;
        b.setAttribute("aria-pressed", on ? "true" : "false");
        b.style.outline = on ? "2px solid var(--accent)" : "";
        b.style.outlineOffset = on ? "2px" : "";
      }
    }

    // If the user edits or erases the phrase, the matching chip stops looking active.
    prompt.addEventListener("input", () => {
      if (!selected) return;
      const chosen = colorById(selected);
      if (chosen && !prompt.value.endsWith(chosen.phrase)) {
        selected = "";
        sync();
      }
    });

    prompt.insertAdjacentElement("afterend", row);
    sync();
  }

  /** Patch the paint factory once; every later mount gets the palette. */
  function install(win) {
    const Paint = win && win.HqSketchPaint;
    if (!Paint || Paint.__paletteInstalled) return false;
    const mount = Paint.mount;
    if (typeof mount !== "function") return false;
    Paint.mount = function (w, host) {
      const api = mount.call(this, w, host);
      try {
        const panel = host && host.querySelector(".sk-paint");
        const prompt = panel && panel.querySelector(".sk-paint-prompt");
        decorate((w && w.document) || win.document, panel, prompt, w || win);
      } catch (e) {
        if (win.console && win.console.warn) win.console.warn("palette Forge indisponible", e);
      }
      return api;
    };
    Paint.__paletteInstalled = true;
    return true;
  }

  if (typeof window !== "undefined") install(window);

  return { COLORS, withColor, install, decorate };
});
