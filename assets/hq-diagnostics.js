/* Phase 15 — admin diagnostics page. Read-only views of /api/diag/*; one explicit POST (the write probe). Nothing is parsed as
   markup, no external call, no timers. Every value is shown as text. */
(function () {
  "use strict";
  var root = document.getElementById("root");
  var lastExpected = "";

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "class") n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function status(s) {
    return el("span", { "class": "badge s-" + String(s || "never").replace(/[^a-z_]/g, ""), text: String(s || "never") });
  }
  function row(label, value) {
    var td = el("td");
    if (value && value.nodeType) td.appendChild(value); else td.textContent = value == null ? "—" : String(value);
    return el("tr", null, [el("th", { text: label }), td]);
  }
  function table(rows) { return el("table", null, [el("tbody", null, rows)]); }
  function section(title, content) { return el("section", null, [el("h2", { text: title })].concat(content)); }
  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: "same-origin", cache: "no-store" }, opts || {})).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { j = { error: "réponse illisible" }; }
        return { status: r.status, body: j };
      });
    });
  }
  function fmtBytes(n) {
    if (typeof n !== "number") return "—";
    var u = ["o", "Ko", "Mo", "Go"], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : String(n)) + " " + u[i];
  }
  function fmtUptime(sec) {
    if (typeof sec !== "number") return "—";
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return (d ? d + " j " : "") + h + " h " + m + " min";
  }

  var state = { probe: null, verify: null };

  function renderInstance(info) {
    var rows = [
      row("Build (SHA)", info.build_sha || "unknown"),
      row("Source du SHA", info.build_sha_source),
      row("SHA du dossier (disque)", info.checkout_sha || "unknown"),
      row("Redémarrage nécessaire", info.restart_pending === true ? "OUI — le dossier a changé depuis le démarrage" : info.restart_pending === false ? "non" : "inconnu"),
      row("Version", info.version),
      row("Python", info.python + (info.python_implementation ? " (" + info.python_implementation + ")" : "")),
      row("Système", info.os + " [" + info.platform + "]"),
      row("PID", info.pid),
      row("Démarré (UTC)", info.started_at_utc),
      row("Disponibilité", fmtUptime(info.uptime_sec)),
      row("Dossier de données", info.root_name + " / " + info.data_dir),
      row("Mode", info.run_mode)
    ];
    if (info.last_startup_error) {
      rows.push(row("Dernière erreur de démarrage", info.last_startup_error.at + " " + info.last_startup_error.message +
        (info.last_startup_error.before_current_start ? " (avant le démarrage actuel)" : "")));
    }
    return section("Instance", [table(rows)]);
  }

  function renderHealth(live, ready) {
    var rows = [row("Liveness", status(live.body && live.body.status === "alive" ? "ok" : "error")),
                row("Readiness", status(ready.body && ready.body.status === "ready" ? "ok" : (ready.body && ready.body.status === "degraded" ? "degraded" : "not_ready"))),
                row("Résumé", ready.body && ready.body.summary)];
    var checks = (ready.body && ready.body.checks) || {};
    Object.keys(checks).forEach(function (k) { rows.push(row("  " + k, el("span", null, [status(checks[k].status), el("span", { "class": "muted", text: "  " + checks[k].detail })]))); });
    return section("Santé", [table(rows)]);
  }

  function renderSubs(subs) {
    var rows = [];
    var all = (subs.body && subs.body.subsystems) || {};
    Object.keys(all).forEach(function (k) {
      var v = all[k];
      var extra = v.entries != null ? " (" + v.entries + " entrées)" : "";
      rows.push(row(k, el("span", null, [status(v.status), el("span", { "class": "muted", text: "  " + v.detail + extra })])));
    });
    return section("Sous-systèmes (à la demande)", [table(rows)]);
  }

  function renderStorage() {
    var res = el("div", { "class": "muted", text: "Jamais exécuté dans cette page." });
    if (state.probe) {
      var p = state.probe;
      res = table([row("Résultat", status(p.status)), row("Étape en échec", p.failed_step || "aucune"), row("Durée", p.duration_ms + " ms"),
        row("Étapes", (p.steps || []).map(function (s) { return s.step + (s.ok ? " ✓" : " ✗"); }).join(" → "))]);
    }
    var btn = el("button", { type: "button", text: "Lancer le test d'écriture" });
    btn.addEventListener("click", function () {
      btn.disabled = true;
      api("/api/diag/write-probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(function (r) {
        state.probe = r.body; btn.disabled = false; load();
      });
    });
    return section("Stockage", [el("p", { "class": "muted", text: "Écrit puis supprime un fichier temporaire dans .hq-carnet/diagnostics/ (jamais un enregistrement réel)." }), btn, res]);
  }

  function renderBackup(b) {
    var d = b.body || {};
    var rows = [row("Statut", el("span", null, [status(d.status), el("span", { "class": "muted", text: "  " + (d.detail || "") })])),
      row("Dossier", d.dir_label || "—"), row("Sauvegardes trouvées", d.recent_count), row("Seuil de péremption", d.stale_after_hours + " h"),
      row("Sauvegarde auto en pause", d.auto_paused ? "oui" : "non"), row("Somme de contrôle disponible", d.checksum_available ? "oui" : "non"),
      row("Vérification", typeof d.verified === "string" ? d.verified : JSON.stringify(d.verified))];
    if (d.latest) {
      rows.push(row("Dernière", d.latest.id + " — âge " + d.latest.age_hours + " h — " + fmtBytes(d.latest.size_bytes) + (d.latest.size_truncated ? " (partiel)" : "")));
      rows.push(row("Carnet inclus", d.latest.carnet_included ? "oui" : "non"));
    }
    var dep = d.deployment_backups || {};
    rows.push(row("Sauvegardes de déploiement", dep.count));
    if (dep.latest) {
      rows.push(row("  dernière", dep.latest.name));
      rows.push(row("  SHA de retour arrière", dep.latest.rollback_sha_valid ? dep.latest.rollback_sha : "absent ou invalide"));
      rows.push(row("  empreintes", dep.latest.hashes || "non vérifiées"));
    }
    var btn = el("button", { type: "button", text: "Vérifier la dernière sauvegarde" });
    btn.addEventListener("click", function () { btn.disabled = true; api("/api/diag/backup?verify=1").then(function (r) { state.verify = r.body; btn.disabled = false; load(true); }); });
    return section("Sauvegardes", [table(rows), el("p", { "class": "muted", text: d.note || "" }), btn]);
  }

  function renderErrors(e) {
    var list = (e.body && e.body.errors) || [];
    var s = (e.body && e.body.summary) || {};
    var kids = [el("p", { "class": "muted", text: s.count + " / " + s.capacity + " conservées" + (s.persistent ? " (journal local borné)" : "") })];
    if (!list.length) kids.push(el("p", { text: "Aucune erreur récente." }));
    list.forEach(function (x) {
      kids.push(el("div", { "class": "err" }, [el("code", { text: x.at + "  " + x.subsystem + "  " + (x.status || "") + "  " + x.type + "  #" + x.request_id }),
        el("div", { text: x.message + (x.code ? "  [" + x.code + "]" : "") }),
        x.trace && x.trace.length ? el("div", { "class": "muted", text: x.trace.join("  ←  ") }) : null]));
    });
    return section("Erreurs récentes", kids);
  }

  function renderAgentGuide() {
    return section("Rappel agents", [
      el("p", {
        "class": "muted",
        text:
          "Guide : docs/agent-debugging.md · Symptômes : docs/hq-symptom-index.md · Brief : GET /api/diag/agent-brief · Bundle : GET /api/diag/session-bundle",
      }),
      el("p", {
        text:
          "Ordre : (1) agent-brief / brief_md (2) capture_hint vide (3) top_issues + likely_subsystem (4) request_id ↔ erreurs serveur.",
      }),
    ]);
  }

  function renderAgentBrief(res) {
    var b = res && res.body;
    var st = res && res.status;
    if (st !== 200 || !b) {
      return section("Brief agent", [el("p", { text: "Brief indisponible (session expirée ?)." })]);
    }
    var triage = b.agent_triage || {};
    var kids = [];
    if (triage.capture_hint) {
      kids.push(el("p", { "class": "err", text: String(triage.capture_hint) }));
    } else if (triage.capture_ok) {
      kids.push(el("p", { "class": "muted", text: "Capture client active." }));
    }
    if (triage.likely_subsystem) {
      kids.push(el("p", { text: "Sous-système probable : " + String(triage.likely_subsystem) }));
    }
    (triage.top_issues || []).forEach(function (line) {
      kids.push(el("div", { text: "• " + String(line) }));
    });
    if (!(triage.top_issues || []).length) {
      kids.push(el("p", { text: "Aucun problème résumé dans le tail actuel." }));
    }
    var btn = el("button", { type: "button", text: "Copier brief_md" });
    btn.addEventListener("click", function () {
      var md = b.brief_md;
      if (typeof md !== "string" || !md.trim()) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(md).catch(function () {});
      }
      btn.textContent = "OK";
    });
    var pkt = el("button", { type: "button", text: "Copier packet agent" });
    pkt.addEventListener("click", function () {
      var md = b.packet_md;
      if (typeof md !== "string" || !md.trim()) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(md).catch(function () {});
      }
      pkt.textContent = "OK";
    });
    kids.push(btn);
    kids.push(pkt);
    var save = el("button", { type: "button", text: "Enregistrer packet sur disque" });
    save.addEventListener("click", function () {
      save.disabled = true;
      api("/api/diag/save-agent-packet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 40 }),
      }).then(function (r) {
        save.disabled = false;
        if (r.status === 200 && r.body && r.body.ok) save.textContent = "OK";
        else save.textContent = "Échec";
      });
    });
    kids.push(save);
    if (b.agent_packet_disk && b.agent_packet_disk.relative) {
      kids.push(el("p", { "class": "muted", text: "Fichier : " + b.agent_packet_disk.relative }));
    }
    return section("Brief agent (triage)", kids);
  }

  function renderClientLog(block) {
    var lines = (block && block.lines) || [];
    var s = (block && block.summary) || {};
    var kids = [
      el("p", {
        "class": "muted",
        text:
          (lines.length ? lines.length + " lignes" : "Aucune") +
          " · fichier " +
          (s.file || "client-browser.jsonl") +
          " · " +
          (s.files_max || 2) +
          " fichiers max",
      }),
      el("p", { "class": "muted", text: "Brief : GET /api/diag/agent-brief · Bundle complet : GET /api/diag/session-bundle" }),
    ];
    if (!lines.length) kids.push(el("p", { text: "Aucune entrée navigateur récente." }));
    lines.forEach(function (x) {
      var bits = [x.at, x.view ? "view=" + x.view : "", x.kind ? "kind=" + x.kind : "", x.level, x.message].filter(Boolean).join("  ");
      kids.push(
        el("div", { "class": "err" }, [
          el("code", { text: bits + (x.request_id ? "  #" + x.request_id : "") + (x.session_id ? "  sess=" + x.session_id : "") }),
          x.detail ? el("div", { "class": "muted", text: x.detail }) : null,
          x.data ? el("div", { "class": "muted", text: JSON.stringify(x.data) }) : null,
        ])
      );
    });
    return section("Journal navigateur (client-browser.jsonl)", kids);
  }

  function renderDeploy(info) {
    var inp = el("input", { type: "text", placeholder: "SHA attendu (7–40 hex)", value: lastExpected, autocomplete: "off", spellcheck: "false" });
    var out = el("span", { "class": "muted", text: "" });
    var btn = el("button", { type: "button", text: "Comparer" });
    function show(x) {
      var e = x && x.expected;
      if (!e) { out.textContent = ""; return; }
      if (!e.valid) { out.textContent = "SHA attendu invalide"; return; }
      out.textContent = e.matches === true ? "✓ le build en cours correspond" : e.matches === false ? "✗ NE CORRESPOND PAS au build en cours" : "inconnu (build non déterminé)";
    }
    btn.addEventListener("click", function () {
      lastExpected = inp.value.trim();
      api("/api/diag/info?expect=" + encodeURIComponent(lastExpected)).then(function (r) { show(r.body); });
    });
    return section("Déploiement", [table([row("Build en cours", info.build_sha || "unknown"), row("Dossier sur disque", info.checkout_sha || "unknown")]), inp, btn, out]);
  }

  function renderLagCaptures(res) {
    var files = (res && res.body && res.body.files) || [];
    var kids = [
      el("p", {
        "class": "muted",
        text:
          "Dernières captures lag (WebP/JPEG, max 50 on disk). Agents : GET /api/diag/lag-capture/<name> (admin, basename sûr).",
      }),
    ];
    if (!files.length) {
      kids.push(el("p", { text: "Aucune capture lag enregistrée." }));
      return section("Captures lag (retention)", kids);
    }
    files.forEach(function (f) {
      var name = f.name || f.basename || "";
      var rel = f.relative || f.screenshot_rel || name;
      var link = el("a", {
        href: "/api/diag/lag-capture/" + encodeURIComponent(name),
        text: name,
        target: "_blank",
        rel: "noopener",
      });
      kids.push(
        el("div", { "class": "err" }, [
          link,
          el("span", { "class": "muted", text: "  " + (f.modified_at || f.mtime || f.at || "") + "  " + fmtBytes(f.size || 0) }),
          el("div", { "class": "muted", text: rel }),
        ])
      );
    });
    return section("Captures lag (retention)", kids);
  }

  function load(keepVerify) {
    Promise.all([api("/api/diag/info"), api("/api/diag/live"), api("/api/diag/ready"), api("/api/diag/subsystems"),
                 api(keepVerify && state.verify ? "/api/diag/backup?verify=1" : "/api/diag/backup"), api("/api/diag/errors?limit=30"),
                 api("/api/diag/client-log?limit=40"), api("/api/diag/agent-brief?limit=40"), api("/api/diag/lag-captures?limit=10")]).then(function (r) {
      var info = r[0].body || {};
      root.textContent = "";
      [renderInstance(info), renderHealth(r[1], r[2]), renderSubs(r[3]), renderStorage(), renderBackup(r[4]), renderErrors(r[5]), renderClientLog(r[6].body), renderLagCaptures(r[7]), renderAgentBrief(r[8]), renderAgentGuide(), renderDeploy(info)].forEach(function (n) { root.appendChild(n); });
    }).catch(function () { root.textContent = "Diagnostics indisponibles (session expirée ou accès refusé)."; });
  }

  document.getElementById("refresh").addEventListener("click", function () { load(false); });
  load(false);
})();
