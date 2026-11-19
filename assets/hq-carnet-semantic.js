/* Carnet "by meaning": a separate section under the Ask Carnet dialog (opt-in: carnet_semantic).
 *
 * It is NOT Ask Carnet: that dialog stays evidence-only (no model, no fuzziness). This section asks the bridge for blocks whose
 * meaning is close to the question, found by an embedding model on the voice-worker PC, and for the page digests that a small
 * model wrote in the background. Every line here says it is a suggestion or generated text, never a proof or a note's content.
 *
 * Nothing is added to the page unless GET /api/carnet-semantic says the feature is on. Text from the server is only ever set with
 * textContent. "Ouvrir" buttons carry data-ask="goto", which the dialog's own click handler already turns into a jump to the
 * block (and closes the dialog), so no navigation code lives here. */
(function () {
  "use strict";
  const API = "/api/carnet-semantic";
  let done = false;

  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => {
      if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach((c) => n.appendChild(c));
    return n;
  }

  function openBtn(pageId, blockId) {
    const attrs = { type: "button", class: "carnet-btn", "data-ask": "goto", "data-page": pageId, text: "Ouvrir" };
    if (blockId) attrs["data-block"] = blockId;
    return el("button", attrs);
  }

  function tagLine(tags) {
    return Array.isArray(tags) && tags.length ? el("span", { class: "hint", text: " · " + tags.join(", ") }) : null;
  }

  function digestNode(d) {
    if (!d || typeof d.summary !== "string") return null;
    const row = el("p", { class: "hint" }, [el("span", { text: "Résumé généré : " + d.summary })]);
    const tags = tagLine(d.tags);
    if (tags) row.appendChild(tags);
    return row;
  }

  function cardNode(c) {
    const head = el("strong", { text: c.title || "Note" });
    const meta = el("span", { class: "hint", text: " · proche par le sens (" + Number(c.score).toFixed(2) + ")" + (c.derived ? " · texte extrait d'un scan ou d'une note vocale" : "") });
    const kids = [el("p", {}, [head, meta]), el("p", { text: String(c.excerpt || "") })];
    const dn = digestNode(c.digest);
    if (dn) kids.push(dn);
    kids.push(openBtn(c.page_id, c.block_id));
    return el("li", { class: "carnet-ask-card" }, kids);
  }

  async function call(query) {
    if (typeof window.api !== "function") throw new Error("api");
    return window.api(API + (query || ""), { timeoutMs: 20000 });
  }

  function enhance(dlg) {
    if (done) return;
    const out = dlg.querySelector("#hq-carnet-ask-out");
    const input = dlg.querySelector("#hq-carnet-ask-q");
    if (!out || !input || !out.parentNode) return;
    done = true;
    call("").then((info) => {
      if (!info || info.enabled !== true) return; // off: the dialog stays exactly as it is
      const msg = el("p", { class: "carnet-msg", role: "status", "aria-live": "polite" });
      const list = el("ul", { class: "carnet-ask-list" });
      const go = el("button", { type: "button", class: "carnet-btn", text: "Chercher par le sens" });
      const intro = el("p", { class: "hint", text: "Suggestions calculées par un modèle sur le portable : ce ne sont pas des preuves. Ouvre le bloc pour vérifier ce qu'il dit. La recherche exacte ci-dessus reste la seule qui cite des preuves." });
      const box = el("section", { id: "hq-carnet-semantic", class: "carnet-hx-body" }, [el("h4", { text: "Par le sens" }), intro, go, msg, list]);
      const rows = Array.isArray(info.digests) ? info.digests : [];
      let digests = null;
      if (rows.length) {
        const items = rows.map((r) => el("li", {}, [el("strong", { text: r.title || "Note" }), el("span", { class: "hint", text: " — " + r.summary }), tagLine(r.tags) || el("span"), openBtn(r.page_id, null)]));
        digests = el("details", { id: "hq-carnet-digests" }, [
          el("summary", { text: "Résumés générés (" + rows.length + ")" }),
          el("p", { class: "hint", text: info.digest_note || "Générés par un modèle local : ils ne font pas partie des notes." }),
          el("ul", { class: "carnet-ask-list" }, items),
        ]);
      }
      go.addEventListener("click", async () => {
        const q = String(input.value || "").trim();
        list.textContent = "";
        if (q.length < 2) { msg.textContent = "Écris une question d'abord."; return; }
        go.disabled = true;
        msg.textContent = "Recherche par le sens…";
        try {
          const res = await call("?q=" + encodeURIComponent(q.slice(0, 300)) + "&k=8");
          if (!res || res.enabled !== true) msg.textContent = "Désactivé.";
          else if (!res.available) msg.textContent = res.indexed ? "Le portable ne répond pas : la recherche par le sens est indisponible pour l'instant." : "L'index se prépare en arrière-plan (" + (res.pending || 0) + " blocs à lire). Réessaie dans quelques minutes.";
          else if (!res.results.length) msg.textContent = "Rien de proche par le sens." + (res.pending ? " (" + res.pending + " blocs pas encore lus.)" : "");
          else {
            msg.textContent = res.results.length + " suggestion(s)" + (res.pending ? " — " + res.pending + " blocs pas encore lus." : ".");
            res.results.forEach((c) => list.appendChild(cardNode(c)));
          }
        } catch (_) {
          msg.textContent = "La recherche par le sens a échoué.";
        } finally {
          go.disabled = false;
        }
      });
      out.parentNode.insertBefore(box, out.nextSibling);
      if (digests) box.appendChild(digests);
    }).catch(() => { /* upload role, offline, or the route is absent: nothing is added */ });
  }

  function watch() {
    const existing = document.getElementById("hq-carnet-ask");
    if (existing) return enhance(existing);
    // The Ask dialog is built lazily: until then, one cheap read still lets the server start its background indexing.
    call("").catch(() => { /* off, upload role or offline */ });
    const mo = new MutationObserver(() => {
      const dlg = document.getElementById("hq-carnet-ask");
      if (dlg) { mo.disconnect(); enhance(dlg); }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
})();
