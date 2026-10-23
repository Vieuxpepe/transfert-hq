/* Forge Studio, phase G: night workshop. Normal mode only: in private mode nothing is queued
   and the panel says why. Same-origin HQ routes through hq-forge.js hooks; no browser storage,
   no notification, no sound. The morning summary is one quiet card, shown until "Vu". */
(function () {
  const $ = (id) => document.getElementById(id);
  const H = window.hqForgeHooks;
  const panel = $("forge-night");
  if (!H || !panel) return;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const note = $("forge-night-note");
  const list = $("forge-night-list");
  const buttons = [$("forge-night-tonight"), $("forge-night-idle"), $("forge-night-finish")];
  const cancelAll = $("forge-night-cancel-all");
  const summary = $("forge-night-summary");
  const post = (path, body) => H.api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const STATE = { queued: "En attente", running: "En cours", done: "Termin\u00e9e", failed: "\u00c9chec", cancelled: "Annul\u00e9e", expired: "Expir\u00e9e" };
  const PRIVATE = "Mode priv\u00e9 : rien n'est mis en file la nuit, le prompt ne doit pas rester sur le disque. Repassez en mode normal pour utiliser l'atelier.";

  function privateMode() { return !!H.sweepContext().privateMode; }

  function syncMode() {
    const priv = privateMode();
    buttons.forEach((b) => { b.disabled = priv; });
    if (priv) note.textContent = PRIVATE;
    else if (note.textContent === PRIVATE) note.textContent = "";
    return priv;
  }

  function render(data) {
    const live = data.entries.filter((e) => e.state === "queued" || e.state === "running");
    const recent = data.entries.filter((e) => !(e.state === "queued" || e.state === "running")).slice(-3);
    list.replaceChildren(...[...live, ...recent].map((e) => {
      const li = el("li", "forge-night-entry");
      li.dataset.state = e.state;
      const text = el("span", "forge-night-label", (e.kind === "finish" ? "Finition \u00b7 " : "") + (e.label || "(sans prompt)"));
      text.title = e.label || "";
      const meta = el("span", "forge-night-meta", STATE[e.state] + " \u00b7 " + (e.when === "tonight" ? "ce soir" : "quand libre") + (e.message && e.state !== "queued" ? " \u00b7 " + e.message : ""));
      li.append(text, meta);
      if (e.state === "queued") {
        const b = el("button", "secondary forge-night-cancel", "Annuler");
        b.type = "button";
        b.setAttribute("aria-label", "Annuler " + (e.label || "cette entr\u00e9e"));
        b.addEventListener("click", async () => {
          try { await post("/api/forge/night/" + encodeURIComponent(e.id) + "/cancel"); note.textContent = "Entr\u00e9e annul\u00e9e."; }
          catch (err) { note.textContent = err.message || "Annulation impossible."; }
          refresh();
        });
        li.append(b);
      }
      return li;
    }));
    cancelAll.hidden = !data.entries.some((e) => e.state === "queued");
    showSummary(data.summary);
  }

  function showSummary(s) {
    if (!s) { summary.hidden = true; return; }
    const c = s.counts;
    const parts = [];
    if (c.done) parts.push(c.done + " termin\u00e9e" + (c.done > 1 ? "s" : ""));
    if (c.failed) parts.push(c.failed + " en \u00e9chec");
    if (c.expired) parts.push(c.expired + " non atteinte" + (c.expired > 1 ? "s" : ""));
    $("forge-night-summary-text").textContent = "Cette nuit : " + (parts.join(", ") || "rien \u00e0 signaler") + ".";
    const box = $("forge-night-summary-images");
    box.replaceChildren(...s.images.slice(0, 8).map((id) => {
      const b = el("button", "forge-night-thumb");
      b.type = "button";
      b.setAttribute("aria-label", "Ouvrir l'image");
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = "/api/forge/gallery/" + encodeURIComponent(id) + "/thumb";
      b.append(img);
      b.addEventListener("click", () => H.openImage(id));
      return b;
    }));
    summary.hidden = false;
  }

  async function refresh() {
    try { render(await H.api("/api/forge/night")); } catch (_e) { /* quiet: the panel stays as it was */ }
  }

  async function queue(when) {
    if (syncMode()) return;
    const ctx = H.sweepContext();
    try {
      await post("/api/forge/night", { when, settings: ctx.settings });
      note.textContent = when === "tonight" ? "Mis en file pour ce soir (22 h \u2013 7 h)." : "Mis en file : part d\u00e8s que Forge est libre.";
    } catch (err) { note.textContent = err.message || "Mise en file impossible."; }
    refresh();
  }

  $("forge-night-tonight").addEventListener("click", () => queue("tonight"));
  $("forge-night-idle").addEventListener("click", () => queue("idle"));
  $("forge-night-finish").addEventListener("click", async () => {
    if (syncMode()) return;
    const upscaler = H.preferredUpscaler() && H.preferredUpscaler() !== "None" ? H.preferredUpscaler() : (H.upscalers()[0] || "");
    try {
      const out = await post("/api/forge/night/finish-kept", { when: "tonight", scale: 2, upscaler });
      note.textContent = out.added + " finition" + (out.added > 1 ? "s" : "") + " en file pour ce soir (\u00d72, une \u00e0 la fois). Une finition n'est pas une copie identique.";
    } catch (err) { note.textContent = err.message || "Mise en file impossible."; }
    refresh();
  });
  cancelAll.addEventListener("click", async () => {
    try { const out = await post("/api/forge/night/cancel-all"); note.textContent = out.cancelled + " entr\u00e9e(s) annul\u00e9e(s). Celle en cours se termine seule."; }
    catch (err) { note.textContent = err.message || "Annulation impossible."; }
    refresh();
  });
  $("forge-night-summary-ok").addEventListener("click", async () => {
    summary.hidden = true;
    try { await post("/api/forge/night/ack"); } catch (_e) { /* shown again next time */ }
  });
  panel.addEventListener("toggle", () => { if (panel.open) { syncMode(); refresh(); } });
  document.addEventListener("change", (event) => { if (event.target && event.target.name === "forge-destination") syncMode(); });
  document.addEventListener("click", (event) => { if (event.target && event.target.closest && event.target.closest("[data-destination]")) setTimeout(syncMode, 0); });
  setInterval(() => { if (!document.hidden && (panel.open || summary.hidden === false)) refresh(); }, 30000);
  refresh();
})();