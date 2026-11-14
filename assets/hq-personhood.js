/* Transfert HQ — bounded personhood review (assets/hq-personhood.js)
 * One admin surface for every assistant. It only reads derived evidence and
 * sends explicit review actions; no model call is made here. */
(function () {
  "use strict";
  if (window.hqPersonhoodReady) return;
  window.hqPersonhoodReady = true;

  var KEYS = ["transferania", "else", "culinia", "forgia", "musica", "inventoria", "pistonia", "securia"];
  var current = "transferania";
  var busy = false;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function when(ts) {
    if (!ts) return "";
    try { return new Date(Number(ts) * 1000).toLocaleString(); } catch (e) { return ""; }
  }
  function csrf() {
    try { return typeof window.hqCsrfToken === "function" ? window.hqCsrfToken() : ""; } catch (e) { return ""; }
  }
  function post(body) {
    var headers = { "Content-Type": "application/json" };
    var token = csrf();
    if (token) headers["X-CSRF-Token"] = token;
    return window.fetch("/api/assistant-personhood", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: headers, body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || "Action refusée");
        return data;
      });
    });
  }

  function build() {
    var button = el("button", "hq-self-open", "Personnalité");
    button.type = "button";
    button.setAttribute("aria-haspopup", "dialog");
    button.addEventListener("click", function () { open(); });
    document.body.appendChild(button);

    var panel = el("section", "hq-self-panel");
    panel.id = "hq-personhood-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Personnalité des assistants");
    panel.innerHTML =
      '<div class="hq-self-head"><h2>Personnalité</h2><button type="button" data-self-close aria-label="Fermer">Fermer</button></div>' +
      '<select id="hq-self-key" aria-label="Choisir un assistant"></select>' +
      '<div id="hq-self-body" class="hq-self-muted">Chargement…</div>';
    document.body.appendChild(panel);

    var select = panel.querySelector("#hq-self-key");
    KEYS.forEach(function (key) {
      var option = document.createElement("option");
      option.value = key;
      option.textContent = key.charAt(0).toUpperCase() + key.slice(1);
      select.appendChild(option);
    });
    select.value = current;
    select.addEventListener("change", function () { current = select.value; load(); });
    panel.querySelector("[data-self-close]").addEventListener("click", close);
    panel.addEventListener("click", function (event) {
      var target = event.target;
      var closeButton = target.closest("[data-self-close]");
      if (closeButton) { close(); return; }
      var action = target.closest("[data-self-action]");
      if (!action || busy) return;
      var body = { key: current, action: action.getAttribute("data-self-action") };
      if (action.getAttribute("data-axis")) body.axis = action.getAttribute("data-axis");
      if (action.getAttribute("data-id")) body.id = action.getAttribute("data-id");
      if (body.action === "reset" && !window.confirm("Rétablir les axes de départ ?")) return;
      busy = true;
      action.disabled = true;
      post(body).then(function (data) {
        if (data.snapshot) render(data.snapshot); else load();
      }).catch(function (error) {
        var bodyNode = panel.querySelector("#hq-self-body");
        bodyNode.innerHTML = '<p class="hq-self-error">' + esc(error.message) + "</p>";
      }).then(function () { busy = false; });
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !panel.hidden) close();
    });
    return panel;
  }

  function open() {
    var panel = document.getElementById("hq-personhood-panel");
    if (!panel) return;
    panel.hidden = false;
    var button = document.querySelector(".hq-self-open");
    if (button) button.setAttribute("aria-expanded", "true");
    load();
  }
  function close() {
    var panel = document.getElementById("hq-personhood-panel");
    if (!panel) return;
    panel.hidden = true;
    var button = document.querySelector(".hq-self-open");
    if (button) button.setAttribute("aria-expanded", "false");
  }

  function load() {
    var body = document.getElementById("hq-self-body");
    if (!body || busy) return;
    body.innerHTML = '<p class="hq-self-muted">Chargement…</p>';
    window.fetch("/api/assistant-personhood?key=" + encodeURIComponent(current), {
      credentials: "same-origin", cache: "no-store"
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok || !data.ok) throw new Error(data.error || "Personnalité indisponible");
        render(data);
      });
    }).catch(function (error) {
      body.innerHTML = '<p class="hq-self-error">' + esc(error.message) + "</p>";
    });
  }

  function section(title, content) {
    var box = el("div", "hq-self-section");
    box.appendChild(el("h3", "", title));
    var inner = el("div");
    inner.innerHTML = content;
    box.appendChild(inner);
    return box;
  }

  function render(data) {
    var body = document.getElementById("hq-self-body");
    if (!body) return;
    body.className = "";
    body.innerHTML = "";
    body.appendChild(section("Disposition de passage",
      '<div class="hq-self-kv"><strong>' + esc(data.disposition.label) + "</strong></div>" +
      '<div class="hq-self-muted">Depuis ' + esc(when(data.disposition.since)) +
      " · phase tenue au moins 30 min, sans réécrire la persona.</div>"));
    body.appendChild(section("Modèle de soi",
      data.values.map(function (value) {
        return '<div class="hq-self-item"><strong>' + esc(value.label) + "</strong> " +
          '<span class="hq-self-chip">' + esc(value.status) + "</span>" +
          '<span class="hq-self-chip">' + Math.round(value.confidence * 100) + "%</span>" +
          '<div class="hq-self-muted">' + esc(value.provenance === "seed" ? "valeur de départ, sans preuve" : "appuyée par " + value.sources.length + " fait(s)") + "</div></div>";
      }).join("") || '<p class="hq-self-muted">Aucune valeur déclarée.</p>'));
    body.appendChild(section("Notes et points contestés",
      (data.self_notes || []).map(function (note) {
        return '<div class="hq-self-item"><strong>' + esc(note.text) + "</strong>" +
          '<div class="hq-self-muted">hypothèse · ' + Math.round(note.confidence * 100) + "% · " + esc(note.provenance) + "</div>" +
          '<div class="hq-self-actions"><button type="button" data-self-action="pin" data-id="' + esc(note.id) + '">Épingler</button>' +
          '<button type="button" data-self-action="forget" data-id="' + esc(note.id) + '">Écarter</button></div></div>';
      }).join("") + (data.contested || []).map(function (item) {
        return '<div class="hq-self-item"><strong>Contesté : ' + esc(item.topic) + "</strong>" +
          '<div class="hq-self-muted">' + esc(item.sides.join(" · ")) + "</div></div>";
      }).join("") || '<p class="hq-self-muted">Pas encore de note stable.</p>'));
    body.appendChild(section("Style — propositions à valider",
      (data.style.axes || []).map(function (axis) {
        return '<div class="hq-self-item"><strong>' + esc(axis.label) + "</strong> " + esc(axis.weight) + "/100" +
          '<div class="hq-self-bar"><i style="width:' + Math.max(0, Math.min(100, Number(axis.weight))) + '%"></i></div>' +
          '<div class="hq-self-actions"><button type="button" data-self-action="pin_axis" data-axis="' + esc(axis.axis) + '">Épingler l’axe</button>' +
          '<button type="button" data-self-action="unpin_axis" data-axis="' + esc(axis.axis) + '">Libérer</button></div></div>';
      }).join("") +
      (data.style.pending || []).map(function (row) {
        return '<div class="hq-self-item"><strong>' + esc(row.label) + " : " + esc(row.before) + " → " + esc(row.after) + "</strong>" +
          '<div class="hq-self-muted">' + esc(row.reason) + " · plafond " + esc(data.style.weekly_cap) + "/semaine</div>" +
          '<div class="hq-self-actions"><button type="button" data-self-action="approve" data-axis="' + esc(row.axis) + '">Approuver</button>' +
          '<button type="button" data-self-action="reject" data-axis="' + esc(row.axis) + '">Refuser</button></div></div>';
      }).join("") +
      '<div class="hq-self-actions"><button type="button" data-self-action="reset">Rétablir les axes</button></div>'));
    body.appendChild(section("Préoccupations ouvertes",
      (data.preoccupations || []).map(function (row) {
        return '<div class="hq-self-item"><strong>' + esc(row.label) + "</strong>" +
          '<div class="hq-self-muted">' + esc(row.capability) + (row.blocker ? " · " + esc(row.blocker) : "") +
          " · expire " + esc(when(row.expires_at)) + "</div></div>";
      }).join("") || '<p class="hq-self-muted">Aucune préoccupation avec source.</p>'));
    body.appendChild(section("Fils avec les autres",
      (data.pair_threads || []).map(function (row) {
        return '<div class="hq-self-item"><strong>' + esc(row.other_name) + "</strong> · " + esc(when(row.at)) +
          '<div class="hq-self-muted">' + esc(row.thread) + "</div></div>";
      }).join("") || '<p class="hq-self-muted">Aucun fil récent.</p>'));
    body.appendChild(section("Journal récent",
      (data.ledger && data.ledger.recent || []).map(function (event) {
        return '<div class="hq-self-item"><span class="hq-self-chip">' + esc(event.kind) + "</span> " +
          esc(event.topic || event.text || "—") + '<div class="hq-self-muted">' + esc(when(event.at)) + "</div></div>";
      }).join("") || '<p class="hq-self-muted">Le journal est vide.</p>'));
  }

  function init() {
    build();
    window.hqPersonhoodOpen = open;
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
