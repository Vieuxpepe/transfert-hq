/* Transfert HQ — Securia floating sentinel chip & AI chat drawer (assets/hq-securia-chip.js) */
(function () {
  "use strict";

  var ID = "hq-securia-chip";
  if (document.getElementById(ID)) return;

  var LS_POS = "hq_securia_chip_pos_v1";
  var LS_SCALE = "hq_securia_chip_scale_v1";
  var LS_NSFW = "hq_companion_nsfw";
  var PORTRAIT_SFW = "/assets/companion/securia-chip-sfw.webp";
  var PORTRAIT_NSFW = "/assets/companion/securia-chip-nsfw.webp";
  var BODY_SFW = "/assets/companion/securia-body-sfw.webp";
  var BODY_NSFW = "/assets/companion/securia-body-nsfw.webp";
  var DRAG_THRESHOLD = 7;

  var dock = document.createElement("div");
  dock.id = "hq-securia-chip-dock";
  dock.className = "hq-securia-chip-dock";

  var button = document.createElement("button");
  button.type = "button";
  button.id = ID;
  button.className = "hq-securia-chip";
  button.setAttribute("aria-label", "Securia — ouvrir la sentinelle sécurité");
  button.title = "Securia — Sentinelle IA · glisser pour déplacer";

  var frame = document.createElement("span");
  frame.className = "hq-securia-chip-frame";

  var art = document.createElement("img");
  art.className = "hq-securia-chip-art";
  art.alt = "Securia";
  art.decoding = "async";
  art.addEventListener("load", function () {
    button.classList.add("has-art");
  });
  art.addEventListener("error", function () {
    button.classList.remove("has-art");
  });
  frame.appendChild(art);

  var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "hq-securia-chip-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 3s7 3 7 9c0 5-7 9-7 9s-7-4-7-9c0-6 7-9 7-9z"/>' +
    '<circle cx="12" cy="11.5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/>';

  var badge = document.createElement("span");
  badge.className = "hq-securia-chip-badge";
  badge.hidden = true;

  button.append(frame, icon, badge);
  dock.appendChild(button);
  document.body.appendChild(dock);

  // Drawer
  var drawer = document.createElement("aside");
  drawer.id = "hq-securia-drawer";
  drawer.className = "hq-securia-drawer";
  drawer.hidden = true;
  drawer.setAttribute("aria-label", "Securia — Sentinelle Cybersécurité");

  drawer.innerHTML =
    '<div class="hq-securia-drawer-head">' +
      '<div class="hq-securia-drawer-brand">' +
        '<div class="hq-securia-drawer-orb">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3s7 3 7 9c0 5-7 9-7 9s-7-4-7-9c0-6 7-9 7-9z"/></svg>' +
        '</div>' +
        '<div>' +
          '<div class="hq-securia-drawer-title">Securia</div>' +
          '<div class="hq-securia-drawer-sub" id="hq-securia-drawer-sub">Sentinelle HQ · Veille active</div>' +
        '</div>' +
      '</div>' +
      '<div class="hq-securia-drawer-controls">' +
        '<button type="button" class="hq-securia-icon-btn" id="hq-securia-body-toggle" title="Vue corps entier">Corps</button>' +
        '<button type="button" class="hq-securia-icon-btn" id="hq-securia-goto-tab" title="Ouvrir l\'onglet Sécurité">Onglet</button>' +
        '<button type="button" class="hq-securia-icon-btn" id="hq-securia-clear" title="Effacer la conversation">Effacer</button>' +
        '<button type="button" class="hq-securia-icon-btn" id="hq-securia-close" aria-label="Fermer">✕</button>' +
      '</div>' +
    '</div>' +
    '<div class="hq-securia-body-pane" id="hq-securia-body-pane" hidden>' +
      '<img id="hq-securia-body-img" alt="Securia — Vue complète"/>' +
    '</div>' +
    '<div class="hq-securia-messages" id="hq-securia-messages"></div>' +
    '<div class="hq-securia-quick">' +
      '<button type="button" class="hq-securia-quick-btn" data-prompt="Quel est l\'état actuel du trafic ?">État du trafic ?</button>' +
      '<button type="button" class="hq-securia-quick-btn" data-prompt="Y a-t-il des tentatives suspectes ou des rejets récents ?">Rejets / Intrus ?</button>' +
      '<button type="button" class="hq-securia-quick-btn" data-prompt="Quelles sessions sont actives en ce moment ?">Sessions actives ?</button>' +
    '</div>' +
    '<form class="hq-securia-form" id="hq-securia-form">' +
      '<input type="text" class="hq-securia-input" id="hq-securia-input" placeholder="Interroger Securia sur le trafic ou la sécurité…" autocomplete="off" maxlength="4000"/>' +
      '<button type="submit" class="hq-securia-send" id="hq-securia-send">Envoyer</button>' +
    '</form>';

  document.body.appendChild(drawer);

  var messagesEl = document.getElementById("hq-securia-messages");
  var subEl = document.getElementById("hq-securia-drawer-sub");
  var inputEl = document.getElementById("hq-securia-input");
  var sendEl = document.getElementById("hq-securia-send");
  var formEl = document.getElementById("hq-securia-form");

  var state = {
    open: false,
    busy: false,
    messages: [],
    pos: { x: 0, y: 0 },
  };

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

  function renderMessages() {
    messagesEl.innerHTML = "";
    if (!state.messages.length) {
      var welcome = document.createElement("div");
      welcome.className = "hq-securia-msg assistant";
      welcome.textContent = "Je suis Securia, ta sentinelle réseau. Demande-moi un bilan du trafic, la provenance des connexions, ou les sessions actives.";
      messagesEl.appendChild(welcome);
      return;
    }
    state.messages.forEach(function (m) {
      var div = document.createElement("div");
      div.className = "hq-securia-msg " + (m.role === "user" ? "user" : "assistant");
      if (m.role !== "user" && Array.isArray(m.tools_used) && m.tools_used.length) {
        var pills = document.createElement("div");
        pills.className = "hq-securia-tools-pill";
        var uniq = Array.from(new Set(m.tools_used));
        uniq.forEach(function (t) {
          var tag = document.createElement("span");
          tag.className = "hq-securia-tool-tag";
          tag.textContent = "🔍 " + t;
          pills.appendChild(tag);
        });
        div.appendChild(pills);
      }
      var body = document.createElement("div");
      body.textContent = m.text || "";
      div.appendChild(body);
      messagesEl.appendChild(div);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  var SS_ALERT_ID = "hq_securia_last_alert_id";
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

    var old = dock.querySelector(".hq-securia-whisper");
    if (old) old.remove();
    if (whisperTimer) clearTimeout(whisperTimer);

    var box = document.createElement("div");
    box.className = "hq-securia-whisper";
    var title = document.createElement("strong");
    title.textContent = "Securia · Alerte";
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
      var data = await api("/api/securia/status");
      if (data.headline && subEl) {
        subEl.textContent = "Sentinelle HQ · " + data.headline;
      }
      var fails = data.failures_recent || 0;
      if (fails > 0 || data.alert_level === "warning") {
        button.classList.add("is-alert");
        badge.textContent = fails > 0 ? String(fails) : "!";
        badge.hidden = false;
      } else {
        button.classList.remove("is-alert");
        badge.hidden = true;
      }
      if (data.proactive_alert) {
        showWhisper(data.proactive_alert);
      }
      if (Array.isArray(data.thread)) {
        state.messages = data.thread;
        if (state.open) renderMessages();
      }
    } catch (_) {}
  }

  function openDrawer() {
    state.open = true;
    drawer.hidden = false;
    renderMessages();
    refreshStatus();
    setTimeout(function () { if (inputEl) inputEl.focus(); }, 60);
  }

  function closeDrawer() {
    state.open = false;
    drawer.hidden = true;
  }

  window.hqSecuriaOpen = openDrawer;

  button.addEventListener("click", function () {
    if (suppressClick) return;
    if (state.open) closeDrawer();
    else openDrawer();
  });

  document.getElementById("hq-securia-close").addEventListener("click", closeDrawer);

  document.getElementById("hq-securia-goto-tab").addEventListener("click", function () {
    if (typeof window.setView === "function") window.setView("securite");
    else location.hash = "#securite";
    closeDrawer();
  });

  document.getElementById("hq-securia-clear").addEventListener("click", async function () {
    try {
      await api("/api/securia/clear", { method: "POST", headers: csrfHeaders(), body: "{}" });
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
    sendEl.disabled = true;
    inputEl.value = "";

    state.messages.push({ role: "user", text: msg });
    var pending = { role: "assistant", text: "Analyse de la télémétrie en cours…", tools_used: [] };
    state.messages.push(pending);
    renderMessages();

    try {
      var res = await api("/api/securia/chat", {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({ message: msg }),
      });
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
    } catch (e) {
      state.messages[state.messages.length - 1] = {
        role: "assistant",
        text: "Erreur Securia : " + e.message,
      };
      renderMessages();
    } finally {
      state.busy = false;
      sendEl.disabled = false;
      inputEl.focus();
    }
  }

  formEl.addEventListener("submit", function (e) {
    e.preventDefault();
    sendPrompt(inputEl.value);
  });

  drawer.querySelectorAll(".hq-securia-quick-btn").forEach(function (btn) {
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

  var bodyPane = document.getElementById("hq-securia-body-pane");
  var bodyImg = document.getElementById("hq-securia-body-img");
  var bodyToggle = document.getElementById("hq-securia-body-toggle");
  if (bodyToggle && bodyPane) {
    bodyToggle.addEventListener("click", function () {
      bodyPane.hidden = !bodyPane.hidden;
    });
  }

  function applyMode() {
    var adult = isNsfwOn();
    button.classList.toggle("is-nsfw", adult);
    button.classList.remove("has-art");
    art.src = adult ? BODY_NSFW : PORTRAIT_SFW;
    if (bodyImg) bodyImg.src = adult ? BODY_NSFW : BODY_SFW;
  }

  applyMode();
  window.addEventListener("hq:companion-nsfw", applyMode);
  window.addEventListener("storage", function (ev) {
    if (!ev.key || ev.key === LS_NSFW) applyMode();
  });

  // Poll gently every 12s when visible
  setInterval(function () {
    if (!document.hidden && document.body.classList.contains("session-admin")) {
      refreshStatus();
    }
  }, 12000);

  // Initial status fetch once role settles
  setTimeout(refreshStatus, 1500);
})();
