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
    busy: "Génération en cours", idle: "Au repos", warn: "À surveiller",
    start: "Démarrer", stop: "Arrêter", restart: "Redémarrer", confirm: "Confirmer ?", logs: "Journal", hideLogs: "Masquer le journal",
    open: "Ouvrir", port: "Port", pid: "PID", mem: "Mémoire", vram: "VRAM", up: "Actif depuis", models: "Modèles",
    summary: function (r, t) { return r + " / " + t + " prêt" + (r > 1 ? "s" : ""); },
    problems: function (n) { return n + " à vérifier"; },
    empty: "Aucun moteur déclaré.", noLog: "Pas encore de journal.", events: "Dernières actions",
    noEvents: "Aucune action depuis le démarrage du serveur.", offline: "Statut indisponible. Nouvelle tentative…",
    foreignNote: "Un autre programme occupe ce port : HQ ne l'arrêtera pas.",
    observe: "Géré ailleurs", self: "Ce serveur", failed: "Échec", done: "Fait", working: "En cours…",
    cpu: "Processeur", ram: "Mémoire", gpu: "GPU", disk: "Disque", thisPc: "Cet ordinateur", others: "Autres ordinateurs",
    othersHint: "Les autres PC qui font tourner l'agent Engine envoient ici leur état toutes les 10 secondes.",
    addPc: "Ajouter un ordinateur", online: "En ligne", offlineM: "Hors ligne", never: "Jamais vu", seen: function (a) { return "vu il y a " + a; },
    rename: "Renommer", remove: "Retirer", save: "Enregistrer", cancel: "Annuler", noMachines: "Aucun autre ordinateur pour l'instant.",
    codeTitle: "Code d'appairage (valable 10 min, usage unique)", codeHelp: "Sur l'autre PC, copie hq_engine.py, hq_forge_worker.py et scripts\\engine_agent.py, puis :",
    codeRun: "Ensuite, laisse tourner :", codeFail: "Impossible de créer un code.", copy: "Copier", copied: "Copié",
    noDaemons: "Aucun moteur signalé.", temp: "Température", cores: "cœurs",
    autostop: "Arrêt auto", autostop_on: "Arrêt auto activé", autostop_off: "Arrêt auto désactivé",
    autoLabel: "Arrêt auto si inactif", after: "après", minutes: function (n) { return n >= 60 && n % 60 === 0 ? (n / 60) + " h" : n + " min"; },
    stopsIn: function (t) { return "s'arrête dans " + t; }, idleFor: function (t) { return "inactif depuis " + t; },
    autoHint: "Libère la mémoire. La première phrase après l'arrêt passe par la voix du navigateur pendant que le moteur se relance tout seul."
  };
  var GROUP = { core: "Serveur", voice: "Voix", music: "Musique", apps: "Comptes et services", image: "Images", service: "Services" };
  var ORDER = ["core", "voice", "music", "apps", "image", "service"];

  var state = { data: null, timer: null, active: false, openLogs: {}, logText: {}, busy: {}, armed: {}, err: "", inflight: false,
                pair: null, renaming: {} };

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
  function jpost(url, body) {
    return win.fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  }
  function panel() { return doc.getElementById(PANEL_ID); }

  /* ---------------- usage widgets ---------------- */
  function pctOf(used, total) { return total > 0 && used != null ? Math.max(0, Math.min(100, (used / total) * 100)) : null; }
  function level(p) { return p == null ? "" : (p >= 90 ? " is-hot" : (p >= 70 ? " is-warm" : "")); }

  function meter(label, pct, text) {
    var m = el("div", "hq-eng-meter" + level(pct));
    var top = el("div", "hq-eng-meter-top");
    top.appendChild(el("span", "hq-eng-meter-label", label));
    top.appendChild(el("span", "hq-eng-meter-val", text));
    m.appendChild(top);
    var bar = el("div", "hq-eng-bar");
    var fill = el("div", "hq-eng-fill");
    fill.style.width = (pct == null ? 0 : Math.max(pct > 0 ? 2 : 0, pct)).toFixed(1) + "%";
    bar.appendChild(fill);
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", label + " " + text);
    m.appendChild(bar);
    return m;
  }

  function spark(values, max) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 24");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "hq-eng-spark");
    svg.setAttribute("aria-hidden", "true");
    if (!values || values.length < 2) return svg;
    var top = max || Math.max.apply(null, values.concat([1]));
    var pts = values.map(function (v, i) {
      return (i / (values.length - 1) * 100).toFixed(1) + "," + (23 - Math.max(0, Math.min(1, v / top)) * 22).toFixed(1);
    }).join(" ");
    var area = doc.createElementNS(NS, "polygon");
    area.setAttribute("points", "0,24 " + pts + " 100,24");
    area.setAttribute("class", "hq-eng-spark-area");
    var line = doc.createElementNS(NS, "polyline");
    line.setAttribute("points", pts);
    line.setAttribute("class", "hq-eng-spark-line");
    svg.appendChild(area);
    svg.appendChild(line);
    return svg;
  }

  /* Meters for one computer's totals (this PC or a paired one). */
  function systemMeters(sys) {
    var box = el("div", "hq-eng-meters");
    if (!sys) return box;
    if (sys.cpu_pct != null) box.appendChild(meter(T.cpu, sys.cpu_pct, Math.round(sys.cpu_pct) + " %" + (sys.cpu_count ? " · " + sys.cpu_count + " " + T.cores : "")));
    if (sys.ram_total_mb) box.appendChild(meter(T.ram, pctOf(sys.ram_used_mb, sys.ram_total_mb), fmtMem(sys.ram_used_mb) + " / " + fmtMem(sys.ram_total_mb)));
    (sys.gpus || []).slice(0, 2).forEach(function (g) {
      if (g.util_pct != null) box.appendChild(meter(T.gpu + (g.name ? " · " + g.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "") : ""), g.util_pct,
        g.util_pct + " %" + (g.temp_c != null ? " · " + g.temp_c + " °C" : "")));
      if (g.vram_total_mb) box.appendChild(meter(T.vram, pctOf(g.vram_used_mb, g.vram_total_mb), fmtMem(g.vram_used_mb) + " / " + fmtMem(g.vram_total_mb)));
    });
    if (sys.disk_total_gb) box.appendChild(meter(T.disk, pctOf(sys.disk_total_gb - sys.disk_free_gb, sys.disk_total_gb), sys.disk_free_gb + " Go libres"));
    return box;
  }

  /* What one daemon consumes: CPU, memory and VRAM against the machine's totals, plus a short history. */
  function usageBlock(d, sys) {
    var has = d.cpu_pct != null || d.rss_mb != null || d.vram_mb != null;
    if (!has) return null;
    var box = el("div", "hq-eng-usage");
    var meters = el("div", "hq-eng-meters is-compact");
    if (d.cpu_pct != null) meters.appendChild(meter(T.cpu, d.cpu_pct, d.cpu_pct.toFixed(d.cpu_pct < 10 ? 1 : 0) + " %"));
    if (d.rss_mb != null) meters.appendChild(meter(T.mem, pctOf(d.rss_mb, sys && sys.ram_total_mb), fmtMem(d.rss_mb)));
    if (d.vram_mb != null) {
      var total = sys && sys.gpus && sys.gpus[0] && sys.gpus[0].vram_total_mb;
      meters.appendChild(meter(T.vram, pctOf(d.vram_mb, total), fmtMem(d.vram_mb)));
    }
    box.appendChild(meters);
    var h = d.history;
    if (h && h.cpu && h.cpu.length > 2) {
      var sp = el("div", "hq-eng-spark-wrap");
      sp.title = T.cpu + " / " + T.mem;
      sp.appendChild(spark(h.mem, sys && sys.ram_total_mb ? sys.ram_total_mb : null));
      sp.appendChild(spark(h.cpu, 100));
      box.appendChild(sp);
    }
    return box;
  }

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

  function fmtSpan(s) {
    if (s < 90) return s + " s";
    if (s < 5400) return Math.round(s / 60) + " min";
    return (s / 3600).toFixed(1).replace(/\.0$/, "") + " h";
  }

  function autoStopRow(d) {
    var a = d.auto_stop;
    var row = el("div", "hq-eng-auto" + (a.enabled ? " is-on" : ""));
    var lab = el("label", "hq-eng-switch");
    var cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!a.enabled;
    cb.disabled = !!state.busy[d.id];
    lab.appendChild(cb);
    lab.appendChild(el("span", null, T.autoLabel));
    row.appendChild(lab);
    var sel = el("select", "hq-eng-select");
    sel.setAttribute("aria-label", T.autoLabel + " : " + T.after);
    var choices = (a.choices || []).slice();
    if (choices.indexOf(a.idle_min) < 0) choices.push(a.idle_min);
    choices.sort(function (x, y) { return x - y; }).forEach(function (n) {
      var o = el("option", null, T.after + " " + T.minutes(n));
      o.value = String(n);
      if (n === a.idle_min) o.selected = true;
      sel.appendChild(o);
    });
    row.appendChild(sel);
    var send = function () {
      jpost("/api/engine/daemons/" + encodeURIComponent(d.id) + "/autostop", { enabled: cb.checked, idle_min: parseInt(sel.value, 10) }).then(function (r) {
        if (r.data && r.data.events && state.data) state.data.events = r.data.events;
        if (r.ok && r.data && r.data.auto_stop && state.data) {
          state.data.daemons = state.data.daemons.map(function (x) { if (x.id === d.id) x.auto_stop = r.data.auto_stop; return x; });
        } else if (typeof win.toast === "function") { try { win.toast((r.data && r.data.error) || T.failed); } catch (_) {} }
        render();
      }).catch(function () { render(); });
    };
    cb.addEventListener("change", send);
    sel.addEventListener("change", send);
    if (a.enabled && a.stops_in_s != null) row.appendChild(el("span", "hq-eng-auto-state", T.stopsIn(fmtSpan(a.stops_in_s))));
    else if (a.idle_for_s != null && d.state === "ready") row.appendChild(el("span", "hq-eng-auto-state", T.idleFor(fmtSpan(a.idle_for_s))));
    if (a.enabled) row.appendChild(el("p", "hq-eng-auto-hint", T.autoHint));
    return row;
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
    var st = el("span", "hq-eng-state", state.busy[d.id] ? T.working : (T[d.state] || d.state));
    st.setAttribute("role", "status");
    head.appendChild(st);
    c.appendChild(head);

    var facts = el("dl", "hq-eng-facts");
    if (d.port) facts.appendChild(fact(T.port, d.port));
    if (d.pid) facts.appendChild(fact(T.pid, d.pid));
    if (d.uptime_s != null) facts.appendChild(fact(T.up, fmtUp(d.uptime_s)));
    var det = d.details || {};
    Object.keys(det).forEach(function (k) {
      if (k === "errors") return;
      var label = k === "models" ? T.models : k;
      if (det[k] != null && det[k] !== "") facts.appendChild(fact(label, det[k]));
    });
    if (facts.childNodes.length) c.appendChild(facts);
    var usage = usageBlock(d, state.data && state.data.system);
    if (usage) c.appendChild(usage);
    if (d.auto_stop) c.appendChild(autoStopRow(d));

    if (det.errors) {
      var ul = el("ul", "hq-eng-errors");
      Object.keys(det.errors).forEach(function (k) { ul.appendChild(el("li", null, k + " — " + det.errors[k])); });
      c.appendChild(ul);
    }
    if (d.rows && d.rows.length) {
      var rows = el("ul", "hq-eng-rows");
      d.rows.forEach(function (r) {
        var li = el("li", "is-" + (r.state || "off"));
        li.appendChild(el("span", "hq-eng-rdot"));
        li.appendChild(el("strong", null, r.label));
        li.appendChild(el("span", "hq-eng-rtext", r.text || ""));
        rows.appendChild(li);
      });
      c.appendChild(rows);
    }
    if (d.note) c.appendChild(el("p", "hq-eng-note", d.note));
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

  function systemPanel(sys) {
    var sec = el("section", "hq-eng-sys");
    var head = el("div", "hq-eng-sys-head");
    head.appendChild(el("h3", "hq-eng-group-title", T.thisPc + (sys.host ? " · " + sys.host : "")));
    sec.appendChild(head);
    var body = el("div", "hq-eng-sys-body");
    body.appendChild(systemMeters(sys));
    var h = sys.history;
    if (h && h.cpu && h.cpu.length > 2) {
      var sp = el("div", "hq-eng-spark-wrap is-big");
      sp.title = T.cpu + " / " + T.ram;
      sp.appendChild(spark(h.mem, sys.ram_total_mb || null));
      sp.appendChild(spark(h.cpu, 100));
      body.appendChild(sp);
    }
    sec.appendChild(body);
    return sec;
  }

  function codeBox() {
    var p = state.pair;
    var box = el("div", "hq-eng-pair");
    box.appendChild(el("h4", null, T.codeTitle));
    if (p.error) { box.appendChild(el("p", "hq-eng-note", p.error)); return box; }
    box.appendChild(el("p", "hq-eng-code", p.code));
    box.appendChild(el("p", "hq-eng-rtext", T.codeHelp));
    var origin = win.location.origin;
    var pairCmd = 'py -3 scripts\\engine_agent.py pair --hq ' + origin + ' --name "NOM DU PC"';
    var runCmd = "py -3 scripts\\engine_agent.py run";
    [pairCmd, runCmd].forEach(function (cmd, i) {
      if (i === 1) box.appendChild(el("p", "hq-eng-rtext", T.codeRun));
      var row = el("div", "hq-eng-cmd");
      row.appendChild(el("code", null, cmd));
      var b = el("button", "hq-eng-btn is-ghost", T.copy);
      b.type = "button";
      b.addEventListener("click", function () {
        var done = function () { b.textContent = T.copied; setTimeout(function () { b.textContent = T.copy; }, 1500); };
        if (win.navigator.clipboard && win.navigator.clipboard.writeText) win.navigator.clipboard.writeText(cmd).then(done, function () {});
      });
      row.appendChild(b);
      box.appendChild(row);
    });
    return box;
  }

  function machineCard(m) {
    var c = el("article", "hq-eng-card hq-eng-machine is-" + (m.online ? "ready" : "down"));
    c.dataset.machine = m.id;
    var head = el("header", "hq-eng-card-head");
    head.appendChild(el("span", "hq-eng-dot"));
    var titles = el("div", "hq-eng-titles");
    if (state.renaming[m.id] != null) {
      var inp = el("input", "hq-eng-input");
      inp.type = "text"; inp.maxLength = 40; inp.value = state.renaming[m.id];
      inp.setAttribute("aria-label", T.rename);
      inp.addEventListener("input", function () { state.renaming[m.id] = inp.value; });
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") saveName(m.id); if (e.key === "Escape") { delete state.renaming[m.id]; render(); } });
      titles.appendChild(inp);
      win.setTimeout(function () { inp.focus(); inp.select(); }, 0);
    } else {
      titles.appendChild(el("h3", "hq-eng-name", m.name));
    }
    var sub = [m.host && m.host !== m.name ? m.host : null, m.os].filter(Boolean).join(" · ");
    if (sub) titles.appendChild(el("p", "hq-eng-desc", sub));
    head.appendChild(titles);
    head.appendChild(el("span", "hq-eng-state", m.online ? T.online : T.offlineM));
    c.appendChild(head);
    if (!m.online) c.appendChild(el("p", "hq-eng-note", m.seen_ago == null ? T.never : T.offlineM + " · " + T.seen(fmtUp(m.seen_ago))));

    if (m.online) {
      c.appendChild(systemMeters(m.system));
      var h = m.history;
      if (h && h.cpu && h.cpu.length > 2) {
        var sp = el("div", "hq-eng-spark-wrap");
        sp.appendChild(spark(h.ram, 100));
        sp.appendChild(spark(h.cpu, 100));
        c.appendChild(sp);
      }
      var list = el("ul", "hq-eng-mdaemons");
      (m.daemons || []).forEach(function (d) {
        var li = el("li", "is-" + d.state);
        li.appendChild(el("span", "hq-eng-rdot"));
        li.appendChild(el("strong", null, d.label));
        li.appendChild(el("span", "hq-eng-mstate", T[d.state] || d.state));
        var bits = [];
        if (d.port) bits.push(":" + d.port);
        if (d.cpu_pct != null) bits.push(d.cpu_pct + " %");
        if (d.rss_mb != null) bits.push(fmtMem(d.rss_mb));
        if (d.vram_mb != null) bits.push(T.vram + " " + fmtMem(d.vram_mb));
        if (bits.length) li.appendChild(el("span", "hq-eng-rtext", bits.join(" · ")));
        list.appendChild(li);
      });
      if (!(m.daemons || []).length) list.appendChild(el("li", "is-empty", T.noDaemons));
      c.appendChild(list);
    }

    var bar = el("div", "hq-eng-actions");
    if (state.renaming[m.id] != null) {
      var sv = el("button", "hq-eng-btn is-primary", T.save);
      sv.type = "button";
      sv.addEventListener("click", function () { saveName(m.id); });
      var cn = el("button", "hq-eng-btn is-ghost", T.cancel);
      cn.type = "button";
      cn.addEventListener("click", function () { delete state.renaming[m.id]; render(); });
      bar.appendChild(sv); bar.appendChild(cn);
    } else {
      var rn = el("button", "hq-eng-btn is-ghost", T.rename);
      rn.type = "button";
      rn.addEventListener("click", function () { state.renaming[m.id] = m.name; render(); });
      bar.appendChild(rn);
      var key = m.id + ":remove";
      var rm = el("button", "hq-eng-btn is-danger" + (state.armed[key] ? " is-armed" : ""), state.armed[key] ? T.confirm : T.remove);
      rm.type = "button";
      rm.addEventListener("click", function () {
        if (!state.armed[key]) {
          state.armed[key] = true; render();
          setTimeout(function () { if (state.armed[key]) { delete state.armed[key]; render(); } }, 3500);
          return;
        }
        delete state.armed[key];
        jpost("/api/engine/machines/" + encodeURIComponent(m.id) + "/remove").then(function () { refresh(); });
      });
      bar.appendChild(rm);
    }
    c.appendChild(bar);
    return c;
  }

  function saveName(id) {
    var name = (state.renaming[id] || "").trim();
    if (!name) return;
    jpost("/api/engine/machines/" + encodeURIComponent(id) + "/rename", { name: name }).then(function () {
      delete state.renaming[id];
      refresh();
    });
  }

  function newCode() {
    jpost("/api/engine/machines/code").then(function (r) {
      state.pair = r.ok && r.data && r.data.code ? { code: r.data.code } : { error: T.codeFail };
      render();
    }).catch(function () { state.pair = { error: T.codeFail }; render(); });
  }

  function machinesSection(d) {
    var g = el("section", "hq-eng-group hq-eng-machines");
    var head = el("div", "hq-eng-group-head");
    head.appendChild(el("h3", "hq-eng-group-title", T.others));
    if (d.fleet) {
      var add = el("button", "hq-eng-btn is-ghost", T.addPc);
      add.type = "button";
      add.addEventListener("click", newCode);
      head.appendChild(add);
    }
    g.appendChild(head);
    g.appendChild(el("p", "hq-eng-rtext", T.othersHint));
    if (state.pair) g.appendChild(codeBox());
    var list = d.machines || [];
    if (!list.length) { g.appendChild(el("p", "hq-eng-empty", T.noMachines)); return g; }
    var grid = el("div", "hq-eng-grid");
    list.forEach(function (m) { grid.appendChild(machineCard(m)); });
    g.appendChild(grid);
    return g;
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
    if (d && d.system) sec.appendChild(systemPanel(d.system));

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
      sec.appendChild(machinesSection(d));
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

  function editing() {
    var a = doc.activeElement, root = panel();
    return !!(a && root && root.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== "checkbox");
  }

  function refresh() {
    if (state.inflight) return Promise.resolve();
    state.inflight = true;
    return jget("/api/engine/status").then(function (r) {
      if (r.ok && r.data && r.data.daemons) { state.data = r.data; state.err = ""; }
      else state.err = T.offline;
    }).catch(function () { state.err = T.offline; }).then(function () {
      state.inflight = false;
      if (state.active && !editing()) render();
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
