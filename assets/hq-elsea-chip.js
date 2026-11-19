/* Transfert HQ — Elsea floating Atelier 3D chip & AI chat drawer (assets/hq-elsea-chip.js) */
(function () {
  "use strict";

  var ID = "hq-elsea-chip";
  if (document.getElementById(ID)) return;

  var LS_POS = "hq_elsea_chip_pos_v1";
  var LS_SCALE = "hq_elsea_chip_scale_v1";
  var LS_NSFW = "hq_companion_nsfw";
  // Elsea is strictly SFW: one portrait and one full body, whatever the adult toggle says.
  var PORTRAIT_SFW = "/assets/companion/elsea-chip-sfw.webp";
  var BODY_SFW = "/assets/companion/elsea-body-sfw.webp";
  var DRAG_THRESHOLD = 7;

  var dock = document.createElement("div");
  dock.id = "hq-elsea-chip-dock";
  dock.className = "hq-elsea-chip-dock";

  var button = document.createElement("button");
  button.type = "button";
  button.id = ID;
  function sfx(kind) { try { if (window.HqAssistantSfx) window.HqAssistantSfx.play("elsea", kind); } catch (_) {} }
  try { if (window.HqAssistantSfx) window.HqAssistantSfx.register("elsea", function () { return button; }); } catch (_) {}
  button.className = "hq-elsea-chip";
  button.setAttribute("aria-label", "Elsea — ouvrir l'Atelier 3D");
  button.title = "Elsea — Atelier 3D · glisser pour déplacer";

  var frame = document.createElement("span");
  frame.className = "hq-elsea-chip-frame";

  var art = document.createElement("img");
  art.className = "hq-elsea-chip-art";
  art.alt = "Elsea";
  art.decoding = "async";
  art.addEventListener("load", function () {
    button.classList.add("has-art");
  });
  art.addEventListener("error", function () {
    button.classList.remove("has-art");
  });
  frame.appendChild(art);

  var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "hq-elsea-chip-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 3h16v18H4zM4 7h16M10 7v3h4V7M12 10v2M8 17h8"/>';

  var badge = document.createElement("span");
  badge.className = "hq-elsea-chip-badge";
  badge.hidden = true;

  button.append(frame, icon, badge);
  dock.appendChild(button);
  document.body.appendChild(dock);

  // Drawer
  var drawer = document.createElement("aside");
  drawer.id = "hq-elsea-drawer";
  drawer.className = "hq-elsea-drawer";
  drawer.hidden = true;
  drawer.setAttribute("aria-label", "Elsea — Atelier 3D");

  drawer.innerHTML =
    '<div class="hq-elsea-drawer-head">' +
      '<div class="hq-elsea-drawer-brand">' +
        '<div class="hq-elsea-drawer-orb">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 3h16v18H4zM4 7h16M10 7v3h4V7"/></svg>' +
        '</div>' +
        '<div>' +
          '<div class="hq-elsea-drawer-title">Elsea</div>' +
          '<div class="hq-elsea-drawer-sub" id="hq-elsea-drawer-sub">Atelier 3D · Imprimantes</div>' +
        '</div>' +
      '</div>' +
      '<div class="hq-elsea-drawer-controls">' +
        '<button type="button" class="hq-elsea-icon-btn" id="hq-elsea-body-toggle" title="Vue corps entier">Corps</button>' +
        '<button type="button" class="hq-elsea-icon-btn" id="hq-elsea-goto-tab" title="Ouvrir l\'Atelier 3D">Onglet</button>' +
        '<button type="button" class="hq-elsea-icon-btn" id="hq-elsea-stop" title="Arrêter la réponse en cours" hidden>Arrêter</button>' +
        '<button type="button" class="hq-elsea-icon-btn" id="hq-elsea-clear" title="Effacer la conversation">Effacer</button>' +
        '<button type="button" class="hq-elsea-icon-btn" id="hq-elsea-close" aria-label="Fermer">✕</button>' +
      '</div>' +
    '</div>' +
    '<div class="hq-elsea-body-pane" id="hq-elsea-body-pane" hidden>' +
      '<img id="hq-elsea-body-img" alt="Elsea — Vue complète"/>' +
    '</div>' +
    '<div class="hq-elsea-messages" id="hq-elsea-messages"></div>' +
    '<div class="hq-elsea-quick">' +
      '<button type="button" class="hq-elsea-quick-btn" data-prompt="How are the printers doing right now?">Imprimantes ?</button>' +
      '<button type="button" class="hq-elsea-quick-btn" data-prompt="What did we print lately, and did anything fail?">Derniers prints ?</button>' +
      '<button type="button" class="hq-elsea-quick-btn" data-prompt="How are my MakerWorld stats this week?">MakerWorld ?</button>' +
      '<button type="button" class="hq-elsea-quick-btn" data-prompt="Look at the cameras of the printers that are printing. Is everything going well?">Caméras ?</button>' +
    '</div>' +
    '<form class="hq-elsea-form" id="hq-elsea-form">' +
      '<input type="text" class="hq-elsea-input" id="hq-elsea-input" placeholder="Parler à Elsea de tes imprimantes, modèles ou MakerWorld…" autocomplete="off" maxlength="4000"/>' +
      '<button type="submit" class="hq-elsea-send" id="hq-elsea-send">Envoyer</button>' +
    '</form>';

  document.body.appendChild(drawer);

  var messagesEl = document.getElementById("hq-elsea-messages");
  var subEl = document.getElementById("hq-elsea-drawer-sub");
  var inputEl = document.getElementById("hq-elsea-input");
  var sendEl = document.getElementById("hq-elsea-send");
  var formEl = document.getElementById("hq-elsea-form");
  var stopEl = document.getElementById("hq-elsea-stop");

  var state = {
    open: false,
    busy: false,
    messages: [],
    pos: { x: 0, y: 0 },
    job: "",
  };

  // The turn is stoppable server-side: the cancel route makes it drop at its next
  // round or tool call and store nothing (a stopped answer never comes back later).
  function newJob() {
    try {
      if (window.crypto && typeof crypto.randomUUID === "function") {
        return "el-" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
      }
    } catch (_) {}
    return "el-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function clamp(v, min, max) {
    var n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
  }

  try {
    var saved = JSON.parse(localStorage.getItem(LS_POS) || "{}");
    state.pos = { x: clamp(saved.x, -1600, 12), y: clamp(saved.y, -1600, 12) };
  } catch (_) {}

  function applyPos() {
    dock.style.transform = "translate3d(" + Math.round(state.pos.x) + "px, " + Math.round(state.pos.y) + "px, 0)";
  }
  applyPos();

  function persistPos() {
    try { localStorage.setItem(LS_POS, JSON.stringify({ x: Math.round(state.pos.x), y: Math.round(state.pos.y) })); } catch (_) {}
  }

  var drag = null;
  var suppressClick = false;
  var pinchBlocked = false;

  function setBlocked(on) {
    pinchBlocked = !!on;
  }

  function cancelDrag() {
    if (drag) {
      dock.classList.remove("is-dragging");
      drag = null;
    }
  }

  button.addEventListener("pointerdown", function (e) {
    if (e.button !== 0 || pinchBlocked) return;
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: state.pos.x, oy: state.pos.y, moved: false };
    button.setPointerCapture(e.pointerId);
  });

  button.addEventListener("pointermove", function (e) {
    if (!drag || e.pointerId !== drag.id || pinchBlocked) return;
    var dx = e.clientX - drag.sx;
    var dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      drag.moved = true;
      dock.classList.add("is-dragging");
    }
    if (drag.moved) {
      state.pos.x = clamp(drag.ox + dx, -(window.innerWidth - 70), 12);
      state.pos.y = clamp(drag.oy + dy, -(window.innerHeight - 100), 12);
      applyPos();
    }
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved) {
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 120);
      persistPos();
    }
    dock.classList.remove("is-dragging");
    drag = null;
  }
  button.addEventListener("pointerup", endDrag);
  button.addEventListener("pointercancel", endDrag);

  var chipScale = null;
  if (window.HqImageChipScale && typeof window.HqImageChipScale.bind === "function") {
    chipScale = window.HqImageChipScale.bind(window, {
      root: dock,
      chip: button,
      storageKey: LS_SCALE,
      setBlocked: setBlocked,
      cancelDrag: cancelDrag,
    });
  }

  button.addEventListener("keydown", function (event) {
    if (!chipScale) return;
    var step = chipScale.menuStep || 0.08;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      chipScale.bump(step);
    } else if (event.key === "-") {
      event.preventDefault();
      chipScale.bump(-step);
    } else if (event.key === "0") {
      event.preventDefault();
      chipScale.resetScale();
    }
  });

  function csrfHeaders() {
    var h = { "Content-Type": "application/json" };
    if (typeof window.hqCsrfToken === "function") {
      var tok = window.hqCsrfToken();
      if (tok) h["X-CSRF-Token"] = tok;
    }
    return h;
  }

  async function api(url, opts) {
    opts = opts || {};
    opts.credentials = "same-origin";
    opts.cache = "no-store";
    var res = await fetch(url, opts);
    var data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data.error || "Erreur HTTP " + res.status);
    return data;
  }

  function resolveProposal(id, action) {
    return api("/api/elsea/" + action, {
      method: "POST", headers: csrfHeaders(), body: JSON.stringify({ id: id }),
    }).then(function (res) {
      if (Array.isArray(res.messages)) state.messages = res.messages;
      renderMessages();
      if (typeof window.toast === "function") {
        var msg = action === "dismiss" ? "Proposition annulée"
          : res.ok ? "Action appliquée" : "Action refusée" + (res.error ? " : " + res.error : "");
        window.toast(msg, res.ok === false ? "err" : "ok");
      }
    }).catch(function (e) {
      if (typeof window.toast === "function") window.toast(e.message, "err");
    });
  }

  // A destructive tool never runs from the model's turn: it arrives here as a card
  // and only "Confirmer" reaches POST /api/elsea/confirm.
  function proposalCard(prop) {
    var card = document.createElement("div");
    card.className = "hq-elsea-proposal" + (prop.status && prop.status !== "pending" ? " is-" + prop.status : "");
    var line = document.createElement("div");
    line.className = "hq-elsea-proposal-summary";
    line.textContent = String(prop.summary || prop.name || "Action");
    card.appendChild(line);
    if (prop.status === "pending") {
      var row = document.createElement("div");
      row.className = "hq-elsea-proposal-actions";
      var ok = document.createElement("button");
      ok.type = "button";
      ok.className = "hq-elsea-proposal-btn is-apply";
      ok.textContent = "Confirmer";
      ok.addEventListener("click", function () { ok.disabled = true; resolveProposal(prop.id, "confirm"); });
      var no = document.createElement("button");
      no.type = "button";
      no.className = "hq-elsea-proposal-btn";
      no.textContent = "Annuler";
      no.addEventListener("click", function () { no.disabled = true; resolveProposal(prop.id, "dismiss"); });
      row.append(ok, no);
      card.appendChild(row);
    } else {
      var note = document.createElement("div");
      note.className = "hq-elsea-proposal-note";
      note.textContent = prop.status === "done" ? "Appliquée · " + (prop.result || "")
        : prop.status === "failed" ? "Échouée · " + (prop.result || "")
        : prop.status === "dismissed" ? "Annulée" : "En cours…";
      card.appendChild(note);
    }
    return card;
  }

  function renderMessages() {
    messagesEl.innerHTML = "";
    if (!state.messages.length) {
      var welcome = document.createElement("div");
      welcome.className = "hq-elsea-msg assistant";
      welcome.textContent = "Hi Master! I'm Elsea. Ask me how the printers are doing, look for a model in your library, or check your MakerWorld numbers.";
      messagesEl.appendChild(welcome);
      return;
    }
    state.messages.forEach(function (m) {
      var div = document.createElement("div");
      div.className = "hq-elsea-msg " + (m.role === "user" ? "user" : "assistant");
      if (m.role !== "user" && Array.isArray(m.tools_used) && m.tools_used.length) {
        var pills = document.createElement("div");
        pills.className = "hq-elsea-tools-pill";
        var uniq = Array.from(new Set(m.tools_used));
        uniq.forEach(function (t) {
          var tag = document.createElement("span");
          tag.className = "hq-elsea-tool-tag";
          tag.textContent = "🔍 " + t;
          pills.appendChild(tag);
        });
        div.appendChild(pills);
      }
      var body = document.createElement("div");
      body.textContent = m.text || "";
      div.appendChild(body);
      if (m.role !== "user" && Array.isArray(m.proposals) && m.proposals.length) {
        m.proposals.forEach(function (prop) { div.appendChild(proposalCard(prop)); });
      }
      messagesEl.appendChild(div);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  var SS_ALERT_ID = "hq_elsea_last_alert_id";
  var lastWhisperAt = 0;
  var whisperTimer = null;

  function showWhisper(alertObj) {
    if (!alertObj || !alertObj.message || state.open) return;
    var now = Date.now();
    if (now - lastWhisperAt < 90000) return;
    try {
      if (alertObj.id && sessionStorage.getItem(SS_ALERT_ID) === alertObj.id) return;
      if (alertObj.id) sessionStorage.setItem(SS_ALERT_ID, alertObj.id);
    } catch (_) {}
    lastWhisperAt = now;

    var old = dock.querySelector(".hq-elsea-whisper");
    if (old) old.remove();
    if (whisperTimer) clearTimeout(whisperTimer);

    var box = document.createElement("div");
    box.className = "hq-elsea-whisper";
    var title = document.createElement("strong");
    title.textContent = "Elsea · Atelier 3D";
    var txt = document.createElement("div");
    txt.textContent = alertObj.message;
    box.append(title, txt);
    box.addEventListener("click", function () {
      box.remove();
      openDrawer();
    });
    dock.appendChild(box);
    whisperTimer = setTimeout(function () {
      if (box.parentNode) box.remove();
    }, 8500);
  }

  async function refreshStatus() {
    if (!document.body.classList.contains("session-admin")) return;
    try {
      var data = await api("/api/elsea/status");
      if (data.headline && subEl) {
        subEl.textContent = "Atelier 3D · " + data.headline;
      }
      var fails = data.failed || 0;
      if (fails > 0 || data.alert_level === "warning") {
        button.classList.add("is-alert");
        badge.textContent = "!";
        badge.hidden = false;
      } else if (data.printing > 0) {
        button.classList.remove("is-alert");
        badge.textContent = String(data.printing);
        badge.hidden = false;
      } else {
        button.classList.remove("is-alert");
        badge.hidden = true;
      }
      if (data.proactive_alert) {
        showWhisper(data.proactive_alert);
      }
      // While a turn is pending the local list holds the Master's line and the
      // placeholder; the stored thread does not have them yet.
      if (Array.isArray(data.thread) && !state.busy) {
        state.messages = data.thread;
        if (state.open) renderMessages();
      }
    } catch (_) {}
  }

  function openDrawer() {
    state.open = true;
    sfx("open");
    drawer.hidden = false;
    renderMessages();
    refreshStatus();
    setTimeout(function () { if (inputEl) inputEl.focus(); }, 60);
  }

  function closeDrawer() {
    state.open = false;
    drawer.hidden = true;
  }

  window.hqElseaOpen = openDrawer;

  button.addEventListener("click", function () {
    if (suppressClick) return;
    if (state.open) closeDrawer();
    else openDrawer();
  });

  document.getElementById("hq-elsea-close").addEventListener("click", closeDrawer);

  document.getElementById("hq-elsea-goto-tab").addEventListener("click", function () {
    if (typeof window.setView === "function") window.setView("atelier3d");
    else location.hash = "#atelier3d";
    closeDrawer();
  });

  if (stopEl) stopEl.addEventListener("click", async function () {
    if (!state.busy || !state.job) return;
    stopEl.disabled = true;
    try {
      await api("/api/elsea/cancel", { method: "POST", headers: csrfHeaders(), body: JSON.stringify({ job: state.job }) });
      if (typeof window.toast === "function") window.toast("Arrêt demandé", "ok");
    } catch (e) {
      if (typeof window.toast === "function") window.toast(e.message, "err");
      stopEl.disabled = false;
    }
  });

  document.getElementById("hq-elsea-clear").addEventListener("click", async function () {
    try {
      await api("/api/elsea/clear", { method: "POST", headers: csrfHeaders(), body: "{}" });
      state.messages = [];
      renderMessages();
    } catch (e) {
      if (typeof window.toast === "function") window.toast(e.message, "err");
    }
  });

  async function sendPrompt(text) {
    var msg = (text || "").trim();
    if (!msg || state.busy) return;
    state.busy = true;
    state.job = newJob();
    sfx("think");
    sendEl.disabled = true;
    if (stopEl) { stopEl.hidden = false; stopEl.disabled = false; }
    inputEl.value = "";

    state.messages.push({ role: "user", text: msg });
    var pending = { role: "assistant", text: "Elsea checks the workshop…", tools_used: [] };
    state.messages.push(pending);
    renderMessages();

    try {
      var res = await api("/api/elsea/chat", {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({ message: msg, job: state.job }),
      });
      if (res.cancelled) {
        // Stopped (or the conversation was cleared): nothing was stored server-side.
        state.messages = Array.isArray(res.messages) ? res.messages : [];
        renderMessages();
        if (typeof window.toast === "function") window.toast("Réponse arrêtée", "ok");
        return;
      }
      if (Array.isArray(res.messages)) {
        state.messages = res.messages;
      } else {
        state.messages[state.messages.length - 1] = {
          role: "assistant",
          text: res.reply || "",
          tools_used: res.tools_used || [],
        };
      }
      renderMessages();
      sfx("reply");
    } catch (e) {
      sfx("error");
      state.messages[state.messages.length - 1] = {
        role: "assistant",
        text: "Erreur Elsea : " + e.message,
      };
      renderMessages();
    } finally {
      state.busy = false;
      state.job = "";
      sendEl.disabled = false;
      if (stopEl) stopEl.hidden = true;
      inputEl.focus();
    }
  }

  formEl.addEventListener("submit", function (e) {
    e.preventDefault();
    sendPrompt(inputEl.value);
  });

  drawer.querySelectorAll(".hq-elsea-quick-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      sendPrompt(btn.dataset.prompt);
    });
  });

  function isNsfwOn() {
    if (typeof window.hqCompanionNsfwOn === "function") return !!window.hqCompanionNsfwOn();
    try {
      return localStorage.getItem(LS_NSFW) === "1";
    } catch (_) {
      return false;
    }
  }

  var bodyPane = document.getElementById("hq-elsea-body-pane");
  var bodyImg = document.getElementById("hq-elsea-body-img");
  var bodyToggle = document.getElementById("hq-elsea-body-toggle");
  if (bodyToggle && bodyPane) {
    bodyToggle.addEventListener("click", function () {
      bodyPane.hidden = !bodyPane.hidden;
    });
  }

  function applyMode() {
    // Never an adult variant: the toggle is read only so other chips stay in step.
    isNsfwOn();
    button.classList.remove("is-nsfw");
    if (art.getAttribute("src") !== PORTRAIT_SFW) {
      button.classList.remove("has-art");
      art.src = PORTRAIT_SFW;
    }
    if (bodyImg) bodyImg.src = BODY_SFW;
  }

  applyMode();
  window.addEventListener("hq:companion-nsfw", applyMode);
  window.addEventListener("storage", function (ev) {
    if (!ev.key || ev.key === LS_NSFW) applyMode();
  });

  // Poll gently every 12s when visible
  setInterval(function () {
    if (!document.hidden && document.body.classList.contains("session-admin") && document.body.dataset.view === "atelier3d") {
      refreshStatus();
    }
  }, 12000);

  // Initial status fetch once role settles
  setTimeout(refreshStatus, 1500);
})();
