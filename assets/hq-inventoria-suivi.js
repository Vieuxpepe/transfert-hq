/* Transfert HQ — Inventoria: the "Suivi" tab (history, can I cook / build, spending, filament, barcodes) and the item sheet.
   Loaded after hq-inventoria-chip.js; it only talks to the chip through window.HqInventoria.ui and to /api/inventoria/*.
   Nothing here changes stock by itself: undo goes through the existing undo route, a cooked recipe through /cooked (trusted adjusts with Undo). */
(function () {
  "use strict";
  const win = window;

  function start(ui) {
    const doc = ui.doc;
    let lang = ui.lang();
    const L = (fr, en) => (ui.lang() === "en" ? en : fr);
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const button = (label, icon, fn, cls) => {
      const b = el("button", cls || "");
      b.type = "button"; b.textContent = label;
      if (icon) ui.decorate(b, icon);
      if (fn) b.addEventListener("click", fn);
      return b;
    };
    const money = (cents) => (cents / 100).toLocaleString(ui.lang() === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" });
    const fail = (r, fr, en) => ui.failNote(r, L(fr, en));
    const offlineNote = () => el("p", "hq-inventoria-copy-note", L("Connexion requise pour cette section.", "This section needs a connection."));
    const post = (url, body) => ui.jsonPost(url, body || {});
    const dayLabel = (t) => {
      const d = new Date(t * 1000), now = new Date();
      const key = (x) => x.getFullYear() * 400 + x.getMonth() * 32 + x.getDate();
      if (key(d) === key(now)) return L("Aujourd'hui", "Today");
      const y = new Date(now.getTime() - 86400000);
      if (key(d) === key(y)) return L("Hier", "Yesterday");
      return d.toLocaleDateString(ui.lang() === "en" ? "en-CA" : "fr-CA", { weekday: "short", day: "numeric", month: "short" });
    };
    const hhmm = (t) => new Date(t * 1000).toLocaleTimeString(ui.lang() === "en" ? "en-CA" : "fr-CA", { hour: "2-digit", minute: "2-digit" });
    const GRAM_UNIT = /^(g|gr|gramme|grammes|kg|kilo|kilos|kilogramme|kilogrammes)$/i;

    // ------------------------------------------------------------------ pane + accordion
    const pane = ui.addTab("suivi", "Suivi", "trend");
    const sections = [];
    const makeSection = (id, title, icon, onOpen) => {
      const d = el("details", "hq-inventoria-fast hq-inventoria-suivi-sec");
      d.dataset.sec = id;
      const sum = el("summary");
      sum.textContent = title;
      ui.decorate(sum, icon);
      const body = el("div", "hq-inventoria-suivi-body");
      d.append(sum, body);
      d.addEventListener("toggle", () => {
        if (d.open) { sections.forEach((o) => { if (o.d !== d && o.d.open) o.d.open = false; }); onOpen(body); }
      });
      sections.push({ d, body, onOpen });
      return { d, body };
    };
    const refreshOpen = () => { const s = sections.find((x) => x.d.open); if (s) s.onOpen(s.body); };

    // ------------------------------------------------------------------ history
    const renderHistory = (body) => {
      body.replaceChildren(el("p", "hq-inventoria-copy-note", L("Chargement…", "Loading…")));
      ui.getJson("/api/inventoria/history?limit=40").then((r) => {
        if (!r.ok || !r.data) throw r;
        body.replaceChildren();
        const rows = r.data.items || [];
        if (!rows.length) { body.appendChild(el("p", "hq-inventoria-copy-note", L("Rien d'appliqué pour l'instant.", "Nothing applied yet."))); return; }
        let last = "";
        const ul = el("ul", "hq-inventoria-history");
        rows.forEach((h) => {
          const day = dayLabel(h.at);
          if (day !== last) { last = day; ul.appendChild(el("li", "hq-inventoria-history-day", day)); }
          const li = el("li", "hq-inventoria-history-row" + (h.undone ? " is-undone" : ""));
          li.appendChild(el("span", "hq-inventoria-history-time", hhmm(h.at)));
          const what = el("span", "hq-inventoria-history-what");
          what.textContent = h.labels.slice(0, 2).map(ui.T).join(" · ") + (h.count > 2 ? " +" + (h.count - 2) : "");
          li.appendChild(what);
          const tags = el("span", "hq-inventoria-history-tags");
          if (h.auto) tags.appendChild(el("span", "hq-inventoria-tag", L("auto", "auto")));
          if (h.is_undo) tags.appendChild(el("span", "hq-inventoria-tag", L("annulation", "undo")));
          if (h.undone) tags.appendChild(el("span", "hq-inventoria-tag", L("annulé", "undone")));
          li.appendChild(tags);
          if (h.undoable) {
            const undo = button(L("Annuler", "Undo"), "undo", () => {
              undo.disabled = true;
              post(ui.opUrl(h.id, "undo"), { apply: true }).then((res) => {
                if (!res.ok || !res.data) throw res;
                if (res.data.applied && res.data.applied.length) { ui.feedback("undone"); ui.inventoryChanged(); }
                else if (res.data.operation) { ui.selectTab("chat"); ui.showDraft([res.data.operation], { undo: true }); }
                renderHistory(body);
              }).catch((e) => { undo.disabled = false; fail(e, "Annulation impossible.", "Could not undo."); });
            }, "hq-inventoria-history-undo");
            li.appendChild(undo);
          }
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }).catch(() => body.replaceChildren(offlineNote()));
    };

    // ------------------------------------------------------------------ can I cook / build
    const STATUS_ICON = { have: "check", short: "alert", missing: "x", unclear: "search", unit_mismatch: "alert" };
    const renderRows = (host, rows, ok) => {
      host.replaceChildren();
      const en = ui.lang() === "en";
      host.appendChild(el("p", "hq-inventoria-can " + (ok ? "is-ok" : "is-no"), ok ? L("Oui, tu as tout ce qu'il faut.", "Yes, you have everything it takes.")
        : L("Pas encore : il manque quelque chose.", "Not yet: something is missing.")));
      const ul = el("ul", "hq-inventoria-parts");
      rows.forEach((r) => {
        const li = el("li", "hq-inventoria-part is-" + r.status + (r.optional ? " is-optional" : ""));
        li.appendChild(ui.ico(STATUS_ICON[r.status] || "alert", "hq-inventoria-part-ico"));
        const t = el("span", "hq-inventoria-part-text");
        const need = (r.need != null ? r.need : "") + (r.unit ? " " + r.unit : "");
        let note = "";
        if (r.status === "have") note = L("en stock", "in stock") + (r.where ? " · " + r.where : "");
        else if (r.status === "short") note = L("il manque ", "short by ") + r.missing + (r.item_unit ? " " + r.item_unit : "") + " (" + L("tu as ", "you have ") + r.have + ")";
        else if (r.status === "missing") note = L("introuvable dans le stock", "not in the stock");
        else if (r.status === "unit_mismatch") note = L("unité incompatible avec ", "unit does not match ") + (r.item_unit || "");
        else note = L("plusieurs articles possibles", "several items possible") + (r.candidates ? " : " + r.candidates.map((c) => c.name).join(", ") : "");
        t.textContent = (r.item || r.name) + " — " + need + " · " + note + (r.optional ? " (" + L("facultatif", "optional") + ")" : "");
        li.appendChild(t);
        ul.appendChild(li);
      });
      host.appendChild(ul);
      const lacking = rows.filter((r) => !r.optional && (r.status === "short" || r.status === "missing"));
      if (lacking.length) {
        const add = button(L("Ajouter ce qui manque aux courses", "Add what is missing to groceries"), "cart", () => {
          add.disabled = true;
          const lines = lacking.map((r) => ({ name: r.item || r.name, qty: Math.max(1, Math.ceil(r.status === "short" ? r.missing : (r.need_in_item_unit || r.need || 1))), unit: (r.status === "short" ? r.item_unit : r.unit) || "" }));
          post("/api/inventoria/to-grocery", { lines }).then((res) => {
            if (!res.ok) throw res;
            add.textContent = L("Ajouté (" + res.data.count + ")", "Added (" + res.data.count + ")");
          }).catch((e) => { add.disabled = false; fail(e, "Ajout impossible.", "Could not add it."); });
        });
        host.appendChild(add);
      }
    };
    const parseParts = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 80).map((line) => {
      const m = /^(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml|cl|dl)?\s+(.+)$/i.exec(line);
      return m ? { qty: parseFloat(m[1].replace(",", ".")), unit: m[2] || "", name: m[3].trim() } : { qty: 1, unit: "", name: line };
    });
    const renderCan = (body) => {
      body.replaceChildren();
      // cook
      body.appendChild(el("p", "hq-inventoria-fast-title", L("Une recette enregistrée", "A saved recipe")));
      const sel = el("select", "hq-inventoria-suivi-field");
      sel.setAttribute("aria-label", L("Recette", "Recipe"));
      const serv = el("input", "hq-inventoria-suivi-field is-short");
      serv.type = "number"; serv.min = "1"; serv.max = "100"; serv.step = "1";
      serv.setAttribute("aria-label", L("Portions", "Servings"));
      const out = el("div", "hq-inventoria-can-out");
      const row = el("div", "hq-inventoria-suivi-row");
      const check = button(L("Vérifier le stock", "Check the stock"), "search", () => {
        if (!sel.value) return;
        check.disabled = true;
        post("/api/inventoria/cook-check", { recipe_id: sel.value, servings: parseInt(serv.value, 10) || undefined }).then((r) => {
          if (!r.ok || !r.data) throw r;
          renderRows(out, r.data.rows || [], !!r.data.ok);
          const done = button(L("J'ai cuisiné", "I cooked it"), "check", () => {
            done.disabled = true;
            const rec = recipes.find((x) => x.id === sel.value);
            ui.oneTap("cooked", { recipe_id: sel.value, servings: parseInt(serv.value, 10) || undefined }, (rec ? rec.title : "") + " " + L("cuisiné", "cooked")).then((res) => {
              if (res.queued) return;
              if (!res.ok || !res.data) throw res;
              ui.handleTurnResult(res.data);
              const sk = res.data.skipped || [];
              if (sk.length) ui.showNotice(L("Non retiré du stock : ", "Not removed from the stock: ") + sk.map((x) => x.name + " (" + x.why + ")").join(", "), [{ label: "OK", icon: "check" }]);
            }).catch((e) => { done.disabled = false; fail(e, "Impossible de retirer les ingrédients.", "Could not remove the ingredients."); });
          }, "hq-inventoria-draft-apply");
          out.appendChild(done);
        }).catch((e) => fail(e, "Vérification impossible.", "Check failed.")).finally(() => { check.disabled = false; });
      });
      const servWrap = el("label", "hq-inventoria-can-servings", L("Portions", "Servings"));
      servWrap.appendChild(serv);
      row.append(sel, servWrap, check);
      body.append(row, out);
      let recipes = [];
      ui.getJson("/api/inventoria/recipes").then((r) => {
        recipes = (r.ok && r.data && r.data.items) || [];
        sel.replaceChildren();
        if (!recipes.length) { const o = el("option", "", L("Aucune recette enregistrée (module Repas)", "No saved recipe (Meals module)")); o.value = ""; sel.appendChild(o); check.disabled = true; servWrap.hidden = true; return; }
        recipes.forEach((x) => { const o = el("option", "", x.title); o.value = x.id; o.dataset.servings = x.servings; sel.appendChild(o); });
        serv.value = String(recipes[0].servings || 2);
        sel.addEventListener("change", () => { const x = recipes.find((y) => y.id === sel.value); if (x) serv.value = String(x.servings || 2); out.replaceChildren(); });
      }).catch(() => { sel.replaceChildren(); check.disabled = true; });
      // build
      body.appendChild(el("p", "hq-inventoria-fast-title", L("Une liste de pièces", "A parts list")));
      const ta = el("textarea", "hq-inventoria-suivi-field");
      ta.rows = 4;
      ta.placeholder = L("Une pièce par ligne : « 12 Vis M3 », « 2 kg Plâtre »", "One part per line: “12 M3 screws”, “2 kg Plaster”");
      ta.setAttribute("aria-label", L("Liste de pièces", "Parts list"));
      const out2 = el("div", "hq-inventoria-can-out");
      const go = button(L("Puis-je le construire ?", "Can I build it?"), "search", () => {
        const parts = parseParts(ta.value);
        if (!parts.length) return;
        go.disabled = true;
        post("/api/inventoria/parts", { parts }).then((r) => {
          if (!r.ok || !r.data) throw r;
          renderRows(out2, r.data.rows || [], !!r.data.ok);
        }).catch((e) => fail(e, "Vérification impossible.", "Check failed.")).finally(() => { go.disabled = false; });
      });
      body.append(ta, go, out2);
    };

    // ------------------------------------------------------------------ spending
    const renderSpending = (body, month) => {
      body.replaceChildren(el("p", "hq-inventoria-copy-note", L("Chargement…", "Loading…")));
      ui.getJson("/api/inventoria/spending" + (month ? "?month=" + encodeURIComponent(month) : "")).then((r) => {
        if (!r.ok || !r.data) throw r;
        const d = r.data;
        body.replaceChildren();
        if (!d.months.length) { body.appendChild(el("p", "hq-inventoria-copy-note", L("Aucun prix noté. Photographie un ticket de caisse : elle relève le prix de chaque ligne reconnue.", "No prices yet. Photograph a receipt: she reads the price of each recognised line."))); return; }
        const head = el("div", "hq-inventoria-suivi-row");
        const sel = el("select", "hq-inventoria-suivi-field");
        sel.setAttribute("aria-label", L("Mois", "Month"));
        d.months.forEach((m) => { const o = el("option", "", m); o.value = m; if (m === d.month) o.selected = true; sel.appendChild(o); });
        sel.addEventListener("change", () => renderSpending(body, sel.value));
        head.append(sel, el("strong", "hq-inventoria-money", money(d.total_cents)));
        body.appendChild(head);
        const bars = (title, obj) => {
          const keys = Object.keys(obj);
          if (!keys.length) return;
          body.appendChild(el("p", "hq-inventoria-fast-title", title));
          const max = Math.max(...keys.map((k) => obj[k]), 1);
          const ul = el("ul", "hq-inventoria-bars");
          keys.forEach((k) => {
            const li = el("li", "hq-inventoria-bar");
            const bar = el("span", "hq-inventoria-bar-fill");
            bar.style.setProperty("--w", Math.max(4, Math.round(obj[k] / max * 100)) + "%");
            li.append(el("span", "hq-inventoria-bar-label", k), bar, el("span", "hq-inventoria-bar-val", money(obj[k])));
            ul.appendChild(li);
          });
          body.appendChild(ul);
        };
        bars(L("Par catégorie", "By category"), d.by_category);
        bars(L("Par magasin", "By store"), d.by_store);
        body.appendChild(el("p", "hq-inventoria-copy-note", L("Seulement les tickets lus par Inventoria ; le registre Finances est séparé.", "Only receipts Inventoria read; the Finances ledger is separate.")));
      }).catch(() => body.replaceChildren(offlineNote()));
    };

    // ------------------------------------------------------------------ filament
    const filamentForm = (host, onDone, fixedItemId) => {
      const row = el("div", "hq-inventoria-suivi-row");
      const mat = el("input", "hq-inventoria-suivi-field is-short");
      mat.type = "text"; mat.maxLength = 24; mat.placeholder = "PLA"; mat.setAttribute("list", "hq-inv-materials");
      mat.setAttribute("aria-label", L("Matière", "Material"));
      if (!doc.getElementById("hq-inv-materials")) {
        const dl = el("datalist"); dl.id = "hq-inv-materials";
        ["PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC"].forEach((m) => { const o = el("option"); o.value = m; dl.appendChild(o); });
        host.appendChild(dl);
      }
      const sel = el("select", "hq-inventoria-suivi-field");
      sel.setAttribute("aria-label", L("Article de filament", "Filament item"));
      const link = button(L("Lier", "Link"), "check", () => {
        if (!mat.value.trim() || !sel.value) return;
        link.disabled = true;
        post("/api/inventoria/filament", { material: mat.value.trim(), item_id: sel.value }).then((r) => {
          if (!r.ok) throw r;
          mat.value = "";
          ui.refreshStatus({ force: true }).then(onDone);
        }).catch((e) => { link.disabled = false; fail(e, "Lien impossible (article compté en g ou kg).", "Could not link (the item must be counted in g or kg)."); });
      });
      ui.loadInventory().then((inv) => {
        const items = (inv.items || []).filter((i) => GRAM_UNIT.test(String(i.unit || "").trim())).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        sel.replaceChildren();
        if (!items.length) { const o = el("option", "", L("Aucun article compté en g ou kg", "No item counted in g or kg")); o.value = ""; sel.appendChild(o); link.disabled = true; return; }
        items.forEach((i) => { const o = el("option", "", i.name + " (" + i.unit + ")"); o.value = i.id; if (i.id === fixedItemId) o.selected = true; sel.appendChild(o); });
      }).catch(() => { link.disabled = true; });
      row.append(mat, sel, link);
      host.appendChild(row);
    };
    const renderFilament = (body) => {
      body.replaceChildren();
      const st = ui.status() || {};
      const links = st.filament || [];
      body.appendChild(el("p", "hq-inventoria-copy-note", L("Relie une matière à un article de filament : chaque impression terminée ensuite en retire les grammes, une seule fois.", "Link a material to a filament item: each print that finishes afterwards removes its grams, once.")));
      if (links.length) {
        const ul = el("ul", "hq-inventoria-memory");
        links.forEach((f) => {
          const li = el("li");
          li.appendChild(doc.createTextNode(f.material + " → " + (f.item_name || "?") + " "));
          const x = button(L("Délier", "Unlink"), "x", () => {
            x.disabled = true;
            post("/api/inventoria/filament", { material: f.material, item_id: null }).then((r) => { if (!r.ok) throw r; ui.refreshStatus({ force: true }).then(() => renderFilament(body)); })
              .catch((e) => { x.disabled = false; fail(e, "Impossible de délier.", "Could not unlink."); });
          }, "hq-inventoria-memory-del");
          x.setAttribute("aria-label", L("Délier ", "Unlink ") + f.material);
          li.appendChild(x);
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
      filamentForm(body, () => renderFilament(body));
      const ev = st.events || [];
      body.appendChild(el("p", "hq-inventoria-fast-title", L("Dernières impressions retirées du stock", "Latest prints taken out of the stock")));
      if (!ev.length) body.appendChild(el("p", "hq-inventoria-copy-note", L("Aucune pour l'instant.", "None yet.")));
      else {
        const ul = el("ul", "hq-inventoria-history");
        ev.slice().reverse().forEach((e) => {
          const li = el("li", "hq-inventoria-history-row");
          li.appendChild(el("span", "hq-inventoria-history-time", dayLabel(e.at) + " " + hhmm(e.at)));
          li.appendChild(el("span", "hq-inventoria-history-what", e.delta + " " + L("de ", "of ") + (e.item || "?") + " (" + e.material + ") — " + (e.job || "")));
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
    };

    // ------------------------------------------------------------------ barcodes
    const renderCodes = (body) => {
      body.replaceChildren();
      const codes = (ui.status() || {}).barcodes || [];
      body.appendChild(el("p", "hq-inventoria-copy-note", L("Un code lié à un article : chaque scan propose −/+ tout de suite. Un code inconnu te demande l'article la première fois.", "A code linked to an item: each scan offers −/+ at once. An unknown code asks for the item the first time.")));
      if (!codes.length) body.appendChild(el("p", "hq-inventoria-copy-note", L("Aucun code lié.", "No linked code.")));
      else {
        const ul = el("ul", "hq-inventoria-memory");
        codes.forEach((c) => {
          const li = el("li");
          const name = el("span", "hq-inventoria-sheetlink", (c.item_name || "?"));
          name.setAttribute("role", "button"); name.tabIndex = 0;
          name.addEventListener("click", () => openItem(c.item_id));
          name.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openItem(c.item_id); } });
          li.append(el("code", "hq-inventoria-code", c.code), doc.createTextNode(" → "), name, doc.createTextNode(" "));
          const x = button(L("Délier", "Unlink"), "x", () => {
            x.disabled = true;
            post("/api/inventoria/barcode", { action: "unlink", code: c.code }).then((r) => { if (!r.ok) throw r; ui.refreshStatus({ force: true }).then(() => renderCodes(body)); })
              .catch((e) => { x.disabled = false; fail(e, "Impossible de délier ce code.", "Could not unlink this code."); });
          }, "hq-inventoria-memory-del");
          x.setAttribute("aria-label", L("Délier le code ", "Unlink code ") + c.code);
          li.appendChild(x);
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
      const row = el("div", "hq-inventoria-suivi-row");
      const code = el("input", "hq-inventoria-suivi-field");
      code.type = "text"; code.inputMode = "numeric"; code.maxLength = 48; code.placeholder = L("Code-barres", "Barcode");
      code.setAttribute("aria-label", L("Code-barres", "Barcode"));
      const sel = el("select", "hq-inventoria-suivi-field");
      sel.setAttribute("aria-label", L("Article", "Item"));
      ui.loadInventory().then((inv) => { sel.replaceChildren(); (inv.items || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach((i) => { const o = el("option", "", i.name); o.value = i.id; sel.appendChild(o); }); }).catch(() => {});
      const link = button(L("Lier", "Link"), "check", () => {
        if (!code.value.trim() || !sel.value) return;
        link.disabled = true;
        post("/api/inventoria/barcode", { action: "link", code: code.value.trim(), item_id: sel.value }).then((r) => { if (!r.ok) throw r; ui.refreshStatus({ force: true }).then(() => renderCodes(body)); })
          .catch((e) => { link.disabled = false; fail(e, "Code invalide.", "Invalid code."); });
      });
      row.append(code, sel, link);
      body.appendChild(row);
    };

    // ------------------------------------------------------------------ sections
    const sHist = makeSection("history", L("Historique", "History"), "clock", renderHistory);
    const sCan = makeSection("can", L("Pouvoir faire", "Can I make it?"), "sparkle", renderCan);
    const sSpend = makeSection("spend", L("Dépenses", "Spending"), "cart", (b) => renderSpending(b));
    const sFil = makeSection("filament", L("Filament 3D", "3D filament"), "box", renderFilament);
    const sCodes = makeSection("codes", L("Codes-barres", "Barcodes"), "scan", renderCodes);
    pane.append(sHist.d, sCan.d, sSpend.d, sFil.d, sCodes.d);
    sHist.d.open = true;                                   // the first thing you want: what just changed
    renderHistory(sHist.body);

    // ------------------------------------------------------------------ item sheet
    let sheet = null, opener = null;
    // Escape is heard on the document while the sheet is open: a re-render (after a save) drops focus to the page, and it must still close
    const onEscape = (ev) => { if (ev.key === "Escape" && sheet) { ev.stopPropagation(); closeSheet(); } };
    const closeSheet = () => {
      if (!sheet) return;
      doc.removeEventListener("keydown", onEscape, true);
      sheet.remove();
      sheet = null;
      if (opener && opener.focus) { try { opener.focus(); } catch (_) {} }
      opener = null;
    };
    function openItem(id) {
      if (!id) return;
      closeSheet();
      opener = doc.activeElement;
      const bubble = doc.querySelector("#hq-inventoria .hq-inventoria-bubble");
      if (!bubble) return;
      sheet = el("div", "hq-inventoria-sheet");
      sheet.setAttribute("role", "dialog");
      sheet.setAttribute("aria-modal", "true");
      sheet.setAttribute("aria-label", L("Fiche de l'article", "Item sheet"));
      doc.addEventListener("keydown", onEscape, true);
      const back = button(L("Retour", "Back"), "undo", closeSheet, "hq-inventoria-sheet-back");
      const content = el("div", "hq-inventoria-sheet-body");
      content.appendChild(el("p", "hq-inventoria-copy-note", L("Chargement…", "Loading…")));
      sheet.append(back, content);
      bubble.appendChild(sheet);
      try { back.focus(); } catch (_) {}
      load();

      function load() {
        ui.getJson("/api/inventoria/item/" + encodeURIComponent(id)).then((r) => {
          if (!r.ok || !r.data) throw r;
          render(r.data);
        }).catch((r) => { content.replaceChildren(el("p", "hq-inventoria-copy-note", (r && r.data && r.data.error) || L("Fiche indisponible.", "Sheet unavailable."))); });
      }
      function field(labelText, node) { const w = el("div", "hq-inventoria-sheet-field"); w.append(el("label", "hq-inventoria-sheet-label", labelText), node); return w; }
      function render(d) {
        const it = d.item;
        content.replaceChildren();
        const head = el("div", "hq-inventoria-sheet-head");
        if (it.photo) { const img = el("img", "hq-inventoria-sheet-photo"); img.src = "/api/carnet/asset/" + encodeURIComponent(it.photo); img.alt = ""; img.loading = "lazy"; head.appendChild(img); }
        const titles = el("div");
        titles.append(el("h3", "hq-inventoria-sheet-title", it.name), el("p", "hq-inventoria-copy-note", (it.where || L("Sans emplacement", "No place")) + " · " + it.qty + (it.unit ? " " + it.unit : "")));
        head.appendChild(titles);
        content.appendChild(head);

        // quantity
        const qrow = el("div", "hq-inventoria-suivi-row");
        qrow.append(button("−1", "minus", () => ui.quickAdjust(it.id, -1, it.name + " −1").then(load)), button("+1", "plus", () => ui.quickAdjust(it.id, 1, it.name + " +1").then(load)));
        content.appendChild(field(L("Quantité", "Quantity"), qrow));

        // minimum
        const min = el("input", "hq-inventoria-suivi-field is-short");
        min.type = "number"; min.min = "0"; min.step = "1"; min.inputMode = "numeric"; min.value = it.min == null ? "" : String(it.min);
        min.placeholder = L("aucun", "none");
        const saveMin = (val) => post("/api/inventoria/min", { item_id: it.id, min: val }).then((r) => { if (!r.ok || !r.data) throw r; ui.feedback("applied"); ui.inventoryChanged(); ui.refreshStatus({ force: true }); render(r.data); })
          .catch((e) => fail(e, "Seuil non enregistré.", "Threshold not saved."));
        const mrow = el("div", "hq-inventoria-suivi-row");
        mrow.append(min, button(L("Enregistrer", "Save"), "check", () => { const v = min.value.trim(); saveMin(v === "" ? null : parseInt(v, 10)); }),
          button(L("Aucun seuil", "No threshold"), "x", () => saveMin(null)));
        content.appendChild(field(L("Seuil minimum (alerte stock bas)", "Minimum (low-stock alert)"), mrow));

        // expiry
        const exp = el("input", "hq-inventoria-suivi-field");
        exp.type = "date"; exp.value = d.expiry || "";
        const erow = el("div", "hq-inventoria-suivi-row");
        const saveExp = (val) => post("/api/inventoria/expiry", { item_id: it.id, date: val }).then((r) => { if (!r.ok) throw r; ui.refreshStatus({ force: true }); load(); })
          .catch((e) => fail(e, "Date non enregistrée.", "Date not saved."));
        erow.append(exp, button(L("Enregistrer", "Save"), "check", () => { if (exp.value) saveExp(exp.value); }), button(L("Effacer", "Clear"), "x", () => saveExp("")));
        const fieldExp = field(L("À consommer avant", "Use by"), erow);
        if (d.expiry) {
          const days = d.expiry_days;
          const note = el("p", "hq-inventoria-copy-note" + (days <= 0 ? " is-due" : ""), days < 0 ? L("Périmé depuis " + (-days) + " j", "Expired " + (-days) + " d ago") : days === 0 ? L("Expire aujourd'hui", "Expires today") : L("Dans " + days + " j", "In " + days + " d"));
          fieldExp.appendChild(note);
        }
        content.appendChild(fieldExp);

        // barcodes
        const codes = el("div", "hq-inventoria-sheet-chips");
        (d.barcodes || []).forEach((c) => {
          const chip = el("span", "hq-inventoria-chipbtn");
          chip.appendChild(el("code", "hq-inventoria-code", c));
          const x = button("", "x", () => post("/api/inventoria/barcode", { action: "unlink", code: c }).then((r) => { if (!r.ok) throw r; ui.refreshStatus({ force: true }); load(); }).catch((e) => fail(e, "Impossible de délier.", "Could not unlink.")), "hq-inventoria-memory-del");
          x.setAttribute("aria-label", L("Délier le code ", "Unlink code ") + c);
          chip.appendChild(x);
          codes.appendChild(chip);
        });
        const code = el("input", "hq-inventoria-suivi-field");
        code.type = "text"; code.inputMode = "numeric"; code.maxLength = 48; code.placeholder = L("Ajouter un code", "Add a code");
        const crow = el("div", "hq-inventoria-suivi-row");
        crow.append(code, button(L("Lier", "Link"), "check", () => { if (!code.value.trim()) return; post("/api/inventoria/barcode", { action: "link", code: code.value.trim(), item_id: it.id }).then((r) => { if (!r.ok) throw r; ui.refreshStatus({ force: true }); load(); }).catch((e) => fail(e, "Code invalide.", "Invalid code.")); }));
        const codesField = field(L("Codes-barres", "Barcodes"), codes);
        codesField.appendChild(crow);
        content.appendChild(codesField);

        // nicknames + usual amounts
        if ((d.aliases || []).length) content.appendChild(field(L("Surnoms", "Nicknames"), el("span", "hq-inventoria-copy-note", d.aliases.join(", "))));
        const u = d.usual || {};
        if (u.add || u.use) content.appendChild(field(L("Quantités habituelles", "Usual amounts"), el("span", "hq-inventoria-copy-note",
          (u.add ? L("ajoute ", "adds ") + u.add : "") + (u.add && u.use ? " · " : "") + (u.use ? L("retire ", "uses ") + u.use : ""))));

        // learned/verified marks: a counted item says so, quietly
        if (typeof d.checked_days === "number") content.appendChild(field(L("Vérification", "Check"), el("span", "hq-inventoria-mark",
          (L("Vérifié ✓", "Checked ✓")) + " · " + (d.checked_days === 0 ? L("aujourd'hui", "today") : L("il y a ", "") + d.checked_days + L(" j", " d ago")))));

        // prices
        const pr = d.price || {};
        const priceBox = el("div");
        if (!pr.count) priceBox.appendChild(el("p", "hq-inventoria-copy-note", L("Aucun prix noté (photographie un ticket).", "No price yet (photograph a receipt).")));
        else {
          priceBox.appendChild(el("p", "hq-inventoria-copy-note", L("Le moins cher : ", "Cheapest: ") + pr.cheapest.store + " — " + money(pr.cheapest.avg_unit_cents) + (d.item.unit ? " / " + d.item.unit : "")));
          const ul = el("ul", "hq-inventoria-history");
          (pr.history || []).slice().reverse().slice(0, 8).forEach((h) => {
            const li = el("li", "hq-inventoria-history-row");
            li.append(el("span", "hq-inventoria-history-time", h.date), el("span", "hq-inventoria-history-what", h.store + " — " + money(h.unit_cents)));
            ul.appendChild(li);
          });
          priceBox.appendChild(ul);
        }
        content.appendChild(field(L("Prix", "Prices"), priceBox));

        // filament
        if (d.unit_dim === "g") {
          const fbox = el("div");
          if (d.filament) fbox.appendChild(el("p", "hq-inventoria-copy-note", L("Lié à la matière ", "Linked to material ") + d.filament));
          filamentForm(fbox, load, it.id);
          content.appendChild(field(L("Filament 3D", "3D filament"), fbox));
        }
        // jump to the main inventory
        if (it.place_id) {
          const a = el("a", "hq-inventoria-sheet-open", L("Ouvrir dans l'Inventaire", "Open in Inventory"));
          a.href = "#inventaire/" + it.place_id;
          a.addEventListener("click", () => { closeSheet(); ui.win.HqInventoria && ui.win.HqInventoria.close && ui.win.HqInventoria.close(); });
          content.appendChild(a);
        }
      }
    }

    // ------------------------------------------------------------------ keep it fresh
    ui.onStatus(() => {
      if (ui.lang() !== lang) { lang = ui.lang(); }
      const open = sections.find((s) => s.d.open);
      if (open && (open.d.dataset.sec === "filament" || open.d.dataset.sec === "codes" || open.d.dataset.sec === "history")) open.onOpen(open.body);
    });
    win.addEventListener("hq:inventory-changed", () => { if (sHist.d.open) renderHistory(sHist.body); });
    const api = win.HqInventoria;
    api.openItem = openItem;
    api.closeItem = closeSheet;
  }

  let started = false;
  function boot() {
    const a = win.HqInventoria;
    if (started || !(a && a.ui)) return started;
    started = true;
    win.removeEventListener("hq:inventoria-ready", boot);
    start(a.ui);
    return true;
  }
  // the chip may announce itself a moment before it publishes its API: keep listening until it is there
  if (!boot()) win.addEventListener("hq:inventoria-ready", boot);
})();
