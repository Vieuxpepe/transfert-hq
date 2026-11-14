/* Transfert HQ — « Forge peint » : this PC's Forge paints the Dessiner sketch (POST /api/forge/sketch, unmasked img2img
 * of the sketch, local Forge only, never queued: refused while the GPU is busy). In « En direct » mode the painting
 * is redone a moment after each change, at most one request at a time; nothing reaches the gallery unless « Garder ».
 * Dessiner provides window.hqSketchPaintSource() (the sketch, black on white, as a PNG data URL) and calls
 * window.hqSketchChanged() when the drawing changes. Pure helpers are exported for Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.HqSketchPaint = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const LONG = 768; // a size both SD 1.5 and SDXL models handle without wasting the GPU
  const LIVE_DELAY_MS = 1400; // after the last change, wait this long before repainting live

  /** Target size for Forge: the sketch's aspect, long side 768, both sides multiples of 64 within 384..1024. */
  function sizeFor(w, h) {
    const W = Math.max(1, w || 1), H = Math.max(1, h || 1);
    const r = Math.min(W, H) / Math.max(W, H);
    const short = Math.max(384, Math.min(LONG, Math.round((LONG * r) / 64) * 64));
    return W >= H ? { w: LONG, h: short } : { w: short, h: LONG };
  }

  /** Live scheduling. state: {live, prompt, inFlight, dirtyAt, sentVersion, version}. Returns "paint", "wait" or "idle". */
  function nextStep(state, now) {
    const s = state || {};
    if (!s.live || !String(s.prompt || "").trim() || s.version === s.sentVersion) return "idle";
    if (s.inFlight) return "wait"; // one at a time: the newest change is painted when this one is done
    return now - (s.dirtyAt || 0) >= LIVE_DELAY_MS ? "paint" : "wait";
  }

  function el(doc, tag, attrs, kids) {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids || []) if (kid) n.appendChild(kid);
    return n;
  }

  /** Build the panel inside `host` (once). Returns {toggle, open, close, changed, state}. */
  function mount(win, host) {
    const doc = win.document;
    const S = { open: false, live: true, prompt: "", fidelity: 0.6, seed: Math.floor(Math.random() * 2147483647), version: 0, sentVersion: -1,
      dirtyAt: 0, inFlight: false, id: null, timer: 0, poll: 0 };
    const title = el(doc, "strong", { text: "Forge peint ton croquis" });
    const closeBtn = el(doc, "button", { type: "button", class: "sk-paint-x", "aria-label": "Fermer « Forge peint »", text: "✕" });
    const prompt = el(doc, "textarea", { class: "sk-paint-prompt", rows: "2", maxlength: "400",
      placeholder: "Ce que représente le croquis : une cabane dans les bois au crépuscule", "aria-label": "Ce que représente le croquis" });
    const fid = el(doc, "input", { type: "range", min: "0", max: "100", value: "60", class: "sk-paint-fid", "aria-label": "Fidélité au croquis" });
    const fidRow = el(doc, "label", { class: "sk-paint-row" }, [el(doc, "span", { text: "Libre" }), fid, el(doc, "span", { text: "Fidèle au trait" })]);
    const live = el(doc, "input", { type: "checkbox", checked: true });
    const liveRow = el(doc, "label", { class: "sk-paint-live" }, [live, el(doc, "span", { text: "En direct (repeint après chaque trait)" })]);
    const go = el(doc, "button", { type: "button", class: "sk-paint-go", text: "Peindre" });
    const reroll = el(doc, "button", { type: "button", class: "sk-paint-alt", text: "Autre idée" });
    const keep = el(doc, "button", { type: "button", class: "sk-paint-alt", text: "Garder dans la galerie", disabled: true });
    const status = el(doc, "p", { class: "sk-paint-status", role: "status", "aria-live": "polite", text: "Décris le croquis, puis dessine : Forge le peint sur ce PC." });
    const bar = el(doc, "div", { class: "sk-paint-bar", "aria-hidden": "true" }, [el(doc, "i")]);
    const img = el(doc, "img", { class: "sk-paint-img", alt: "Peinture de Forge d'après le croquis", hidden: true });
    const frame = el(doc, "figure", { class: "sk-paint-frame" }, [img, bar]);
    const note = el(doc, "p", { class: "sk-paint-note", text: "Avec le modèle chargé dans Forge, sur ce PC. Rien n'est gardé sans « Garder »." });
    const panel = el(doc, "section", { class: "sk-paint", "aria-label": "Forge peint ton croquis" }, [
      el(doc, "header", { class: "sk-paint-head" }, [title, closeBtn]),
      prompt, fidRow, liveRow,
      el(doc, "div", { class: "sk-paint-acts" }, [go, reroll, keep]),
      status, frame, note,
    ]);
    host.replaceChildren(panel);

    function say(t, err) { status.textContent = t; status.classList.toggle("is-err", !!err); }
    function progress(v) { bar.firstChild.style.width = Math.round(Math.max(0, Math.min(1, v)) * 100) + "%"; frame.classList.toggle("is-busy", v < 1 && S.inFlight); }

    async function paint() {
      if (S.inFlight) return;
      if (!S.prompt.trim()) { say("Décris d'abord ce que représente le croquis.", true); prompt.focus(); return; }
      const src = typeof win.hqSketchPaintSource === "function" ? win.hqSketchPaintSource() : null;
      if (!src) { say("Dessine quelque chose d'abord.", true); return; }
      S.inFlight = true; S.sentVersion = S.version; keep.disabled = true; progress(0.02);
      say("Forge peint…");
      try {
        const res = await win.api("/api/forge/sketch", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sketch: src, prompt: S.prompt, fidelity: S.fidelity, seed: S.seed, steps: 16 }), timeoutMs: 30000 });
        S.id = res && res.sketch && res.sketch.id;
        if (!S.id) throw new Error("Réponse inattendue");
        await follow(S.id);
      } catch (e) {
        S.inFlight = false; progress(0);
        say((e && e.message) || "Forge n'a pas pu peindre.", true);
        if (e && (e.status === 409) && S.live) { S.sentVersion = -1; S.dirtyAt = Date.now() + 4000; schedule(); } // busy: try again later
        return;
      }
      S.inFlight = false;
      schedule(); // a change made meanwhile is painted next
    }
    async function follow(id) {
      for (;;) {
        await new Promise((r) => win.setTimeout(r, 600));
        if (S.id !== id) return;
        let res;
        try { res = await win.api("/api/forge/sketch/" + id, { timeoutMs: 15000 }); } catch (_) { continue; }
        const sk = res && res.sketch;
        if (!sk) return;
        if (sk.state === "completed") {
          img.src = "/api/forge/sketch/" + id + "/image?t=" + Date.now();
          img.hidden = false; keep.disabled = false; progress(1);
          say("Peinture prête" + (S.live ? " · elle suivra tes prochains traits." : "."));
          return;
        }
        if (sk.state === "failed") { progress(0); say(sk.message || "Forge n'a pas pu peindre.", true); return; }
        progress(Math.max(0.05, Number(sk.progress) || 0));
        say(sk.steps ? "Forge peint… " + (sk.step || 0) + "/" + sk.steps : "Forge peint…");
      }
    }
    function schedule() {
      if (S.timer) { win.clearTimeout(S.timer); S.timer = 0; }
      if (!S.open) return;
      const step = nextStep(S, Date.now());
      if (step === "paint") paint();
      else if (step === "wait" && !S.inFlight) S.timer = win.setTimeout(schedule, Math.max(80, LIVE_DELAY_MS - (Date.now() - S.dirtyAt)));
    }
    function changed() { S.version++; S.dirtyAt = Date.now(); schedule(); }

    prompt.addEventListener("input", () => { S.prompt = prompt.value; changed(); });
    fid.addEventListener("change", () => { S.fidelity = Number(fid.value) / 100; changed(); });
    live.addEventListener("change", () => { S.live = live.checked; schedule(); });
    go.addEventListener("click", () => { S.sentVersion = -1; paint(); });
    reroll.addEventListener("click", () => { S.seed = Math.floor(Math.random() * 2147483647); S.sentVersion = -1; paint(); });
    keep.addEventListener("click", async () => {
      if (!S.id) return;
      keep.disabled = true;
      try {
        await win.api("/api/forge/sketch/" + S.id + "/keep", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        say("Gardée dans la galerie de Forge.");
      } catch (e) { keep.disabled = false; say((e && e.message) || "Impossible de garder cette peinture.", true); }
    });
    closeBtn.addEventListener("click", () => close());

    function open() { S.open = true; host.hidden = false; win.hqSketchChanged = changed; if (!S.prompt) prompt.focus(); }
    function close() { S.open = false; host.hidden = true; if (S.timer) { win.clearTimeout(S.timer); S.timer = 0; } if (win.hqSketchChanged === changed) win.hqSketchChanged = null; }
    return { open, close, toggle() { if (S.open) close(); else open(); return S.open; }, changed, state: S };
  }

  return { sizeFor, nextStep, mount, LIVE_DELAY_MS };
});
