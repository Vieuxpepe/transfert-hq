/* Transfert HQ — Engine tab (assets/hq-engine.js).
 * Live view of the local daemons the bridge relies on (voice engines, image backend, the bridge itself) with
 * Start / Stop / Restart and a log tail. Data: GET /api/engine/status, GET /api/engine/logs/<id>,
 * POST /api/engine/daemons/<id>/<action> (admin only; see hq_engine.py).
 * Everything is built with createElement + textContent, so nothing a daemon reports can inject markup. */
(function () {
  "use strict";
  var win = window, doc = document;
  var PANEL_ID = "hq-engine-panel";
  var POLL_MS = 4000, POLL_FAST_MS = 1500;

  var T = {
    title: "Engine",
    hint: "Les moteurs locaux dont HQ dépend : voix, images, serveur. Démarre ou arrête-les ici pour libérer la mémoire.",
    ready: "Prêt", loading: "Chargement…", down: "Arrêté", foreign: "Autre programme", error: "Erreur",
    start: "Démarrer", stop: "Arrêter", restart: "Redémarrer", confirm: "Confirmer ?", logs: "Journal", hideLogs: "Masquer le journal",
    open: "Ouvrir", port: "Port", pid: "PID", mem: "Mémoire", vram: "VRAM", up: "Actif depuis", models: "Modèles",
    summary: function (r, t) { return r + " / " + t + " prêt" + (r > 1 ? "s" : ""); },
    problems: function (n) { return n + " à vérifier"; },
    empty: "Aucun moteur déclaré.", noLog: "Pas encore de journal.", events: "Dernières actions",
    noEvents: "Aucune action depuis le démarrage du serveur.", offline: "Statut indisponible. Nouvelle tentative…",
    foreignNote: "Un autre programme occupe ce port : HQ ne l'arrêtera pas.",
    observe: "Géré ailleurs", self: "Ce serveur", failed: "Échec", done: "Fait", busy: "En cours…"
  };
  var GROUP = { core: "Serveur", voice: "Voix", image: "Images", service: "Services" };
  var ORDER = ["core", "voice", "image", "service"];

  var state = { data: null, timer: null, active: false, openLogs: {}, logText: {}, busy: {}, armed: {}, err: "", inflight: false };

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmtMem(mb) {
    if (mb == null) return "";
    return mb >= 1024 ? (mb / 1024).toFixed(1) + " Go" : mb + " Mo";
  }
  function fmtUp(s) {
    if (s == null) return "";
    if (s < 90) return s + " s";
    if (s < 5400) return Math.round(s / 60) + " min";
    if (s < 172800) return (s / 3600).toFixed(1).replace(/\.0$/, "") + " h";
    return Math.round(s / 86400) + " j";
  }
  function fmtClock(ts) {
    try { return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch (_) { return ""; }
  }
  function jget(url) {
    return win.fetch(url, { credentials: "same-origin", cache: "no-store" }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }
  function jpost(url) {
    return win.fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  }
  function panel() { return doc.getElementById(PANEL_ID); }

  /* ---------------- rendering ---------------- */
  function fact(label, value) {
    var d = el("div", "hq-eng-fact");
    d.appendChild(el("dt", null, label));
    d.appendChild(el("dd", null, String(value)));
    return d;
  }

  function actionButton(d, action, primary) {
    var key = d.id + ":" + action;
    var b = el("button", "hq-eng-btn" + (primary ? " is-primary" : "") + (action === "stop" ? " is-danger" : ""), T[action]);
    b.type = "button";
    var needsConfirm = action === "stop" || action === "restart";
    if (state.armed[key]) { b.textContent = T.confirm; b.classList.add("is-armed"); }
    b.disabled = !!state.busy[d.id];
    if (action === "stop" && d.state === "down") b.disabled = true;
    if (action === "start" && (d.state === "ready" || d.state === "loading")) b.disabled = true;
    b.addEventListener("click", function () {
      if (needsConfirm && !state.armed[key]) {
        state.armed[key] = true;
        render();
        setTimeout(function () { if (state.armed[key]) { delete state.armed[key]; render(); } }, 3500);
        return;
      }
      delete state.armed[key];
      runAction(d.id, action);
    });
    return b;
  }

  function card(d) {
    var c = el("article", "hq-eng-card is-" + d.state);
    c.dataset.daemon = d.id;
    var head = el("header", "hq-eng-card-head");
    head.appendChild(el("span", "hq-eng-dot"));
    var titles = el("div", "hq-eng-titles");
    titles.appendChild(el("h3", "hq-eng-name", d.label));
    titles.appendChild(el("p", "hq-eng-desc", d.description || ""));
    head.appendChild(titles);
    var st = el("span", "hq-eng-state", state.busy[d.id] ? T.busy : (T[d.state] || d.state));
    st.setAttribute("role", "status");
    head.appendChild(st);
    c.appendChild(head);

    var facts = el("dl", "hq-eng-facts");
    if (d.port) facts.appendChild(fact(T.port, d.port));
    if (d.pid) facts.appendChild(fact(T.pid, d.pid));
    if (d.rss_mb != null) facts.appendChild(fact(T.mem, fmtMem(d.rss_mb)));
    if (d.vram_mb != null) facts.appendChild(fact(T.vram, fmtMem(d.vram_mb)));
    if (d.uptime_s != null) facts.appendChild(fact(T.up, fmtUp(d.uptime_s)));
    var det = d.details || {};
    Object.keys(det).forEach(function (k) {
      if (k === "errors") return;
      var label = k === "models" ? T.models : k;
      if (det[k] != null && det[k] !== "") facts.appendChild(fact(label, det[k]));
    });
    if (facts.childNodes.length) c.appendChild(facts);

    if (det.errors) {
      var ul = el("ul", "hq-eng-errors");
      Object.keys(det.errors).forEach(function (k) { ul.appendChild(el("li", null, k + " — " + det.errors[k])); });
      c.appendChild(ul);
    }
    if (d.state === "foreign") c.appendChild(el("p", "hq-eng-note", T.foreignNote));

    var bar = el("div", "hq-eng-actions");
    var can = d.can || {};
    // Only the actions that make sense for the current state; a foreign program is never offered a Stop.
    if (d.state === "down") {
      if (can.start) bar.appendChild(actionButton(d, "start", true));
    } else if (d.state !== "foreign") {
      if (can.restart) bar.appendChild(actionButton(d, "restart", false));
      if (can.stop) bar.appendChild(actionButton(d, "stop", false));
    }
    if (d.observe_only && !can.start && !can.stop) bar.appendChild(el("span", "hq-eng-observe", d.self ? T.self : T.observe));
    if (d.link_view) {
      var open = el("button", "hq-eng-btn is-ghost", T.open);
      open.type = "button";
      open.addEventListener("click", function () {
        if (typeof win.setView === "function") win.setView(d.link_view);
        else win.location.hash = "#" + d.link_view;
      });
      bar.appendChild(open);
    }
    if (d.has_log) {
      var lb = el("button", "hq-eng-btn is-ghost", state.openLogs[d.id] ? T.hideLogs : T.logs);
      lb.type = "button";
      lb.setAttribute("aria-expanded", state.openLogs[d.id] ? "true" : "false");
      lb.addEventListener("click", function () {
        state.openLogs[d.id] = !state.openLogs[d.id];
        if (state.openLogs[d.id]) loadLog(d.id);
        render();
      });
      bar.appendChild(lb);
    }
    if (bar.childNodes.length) c.appendChild(bar);

    if (d.has_log && state.openLogs[d.id]) {
      var pre = el("pre", "hq-eng-log", state.logText[d.id] == null ? "…" : (state.logText[d.id] || T.noLog));
      pre.tabIndex = 0;
      pre.setAttribute("aria-label", T.logs + " " + d.label);
      c.appendChild(pre);
      win.requestAnimationFrame(function () { pre.scrollTop = pre.scrollHeight; });
    }
    return c;
  }

  function render() {
    var root = panel();
    if (!root) return;
    var scroll = win.pageYOffset;
    root.textContent = "";
    var sec = el("section", "hq-eng");
    sec.setAttribute("aria-labelledby", "hq-eng-title");
    var head = el("div", "hq-eng-head");
    var h = el("h2", "hq-eng-title", T.title);
    h.id = "hq-eng-title";
    head.appendChild(h);
    var d = state.data;
    if (d) {
      var s = d.summary || {};
      head.appendChild(el("span", "hq-eng-chip" + (s.problems ? " has-problems" : ""),
        T.summary(s.ready || 0, s.total || 0) + (s.problems ? " · " + T.problems(s.problems) : "")));
    }
    sec.appendChild(head);
    sec.appendChild(el("p", "hq-eng-hint", T.hint));
    if (state.err) sec.appendChild(el("p", "hq-eng-offline", state.err));

    if (d && d.daemons && d.daemons.length) {
      ORDER.forEach(function (kind) {
        var items = d.daemons.filter(function (x) { return (GROUP[x.kind] ? x.kind : "service") === kind; });
        if (!items.length) return;
        var g = el("section", "hq-eng-group");
        g.appendChild(el("h3", "hq-eng-group-title", GROUP[kind]));
        var grid = el("div", "hq-eng-grid");
        items.forEach(function (x) { grid.appendChild(card(x)); });
        g.appendChild(grid);
        sec.appendChild(g);
      });
      var ev = el("section", "hq-eng-events");
      ev.appendChild(el("h3", "hq-eng-group-title", T.events));
      var list = el("ul", "hq-eng-event-list");
      (d.events || []).slice(0, 8).forEach(function (e) {
        var li = el("li", e.ok ? "is-ok" : "is-bad");
        li.appendChild(el("time", null, fmtClock(e.at)));
        li.appendChild(el("span", null, " " + e.id + " · " + (T[e.action] || e.action) + " · " + (e.ok ? T.done : T.failed) + (e.message ? " — " + e.message : "")));
        list.appendChild(li);
      });
      if (!(d.events || []).length) list.appendChild(el("li", "is-empty", T.noEvents));
      ev.appendChild(list);
      sec.appendChild(ev);
    } else if (d) {
      sec.appendChild(el("p", "hq-eng-empty", T.empty));
    }
    root.appendChild(sec);
    if (win.pageYOffset !== scroll) win.scrollTo(0, scroll);
  }

  /* ---------------- data ---------------- */
  function anyLoading() {
    var d = state.data;
    return !!(d && d.daemons && d.daemons.some(function (x) { return x.state === "loading"; })) || Object.keys(state.busy).length > 0;
  }

  function refresh() {
    if (state.inflight) return Promise.resolve();
    state.inflight = true;
    return jget("/api/engine/status").then(function (r) {
      if (r.ok && r.data && r.data.daemons) { state.data = r.data; state.err = ""; }
      else state.err = T.offline;
    }).catch(function () { state.err = T.offline; }).then(function () {
      state.inflight = false;
      if (state.active) render();
      Object.keys(state.openLogs).forEach(function (id) { if (state.openLogs[id]) loadLog(id, true); });
    });
  }

  function loadLog(id, quiet) {
    return jget("/api/engine/logs/" + encodeURIComponent(id) + "?lines=80").then(function (r) {
      var text = r.ok && r.data && Array.isArray(r.data.lines) ? r.data.lines.join("\n") : "";
      if (state.logText[id] === text) return;
      state.logText[id] = text;
      if (!state.active) return;
      if (!quiet) { render(); return; }
      var p = panel() && panel().querySelector('[data-daemon="' + id + '"] .hq-eng-log');
      if (p) { p.textContent = text || T.noLog; p.scrollTop = p.scrollHeight; }
    }).catch(function () {});
  }

  function runAction(id, action) {
    state.busy[id] = true;
    render();
    jpost("/api/engine/daemons/" + encodeURIComponent(id) + "/" + encodeURIComponent(action)).then(function (r) {
      delete state.busy[id];
      if (r.data && r.data.events && state.data) state.data.events = r.data.events;
      if (r.data && r.data.daemon && state.data) {
        state.data.daemons = state.data.daemons.map(function (x) { return x.id === id ? r.data.daemon : x; });
      }
      if (!r.ok && typeof win.toast === "function") { try { win.toast((r.data && (r.data.message || r.data.error)) || T.failed); } catch (_) {} }
      render();
      schedule(true);
      refresh();
    }).catch(function () {
      delete state.busy[id];
      render();
    });
  }

  function schedule(fast) {
    win.clearTimeout(state.timer);
    if (!state.active) return;
    state.timer = win.setTimeout(function () {
      if (!state.active) return;
      if (doc.hidden) { schedule(false); return; }
      refresh().then(function () { schedule(anyLoading()); });
    }, fast || anyLoading() ? POLL_FAST_MS : POLL_MS);
  }

  win.hqEngineShow = function () {
    state.active = true;
    render();
    refresh().then(function () { schedule(anyLoading()); });
  };
  win.hqEngineHide = function () {
    state.active = false;
    win.clearTimeout(state.timer);
  };
  doc.addEventListener("visibilitychange", function () { if (state.active && !doc.hidden) { refresh(); schedule(false); } });
})();
