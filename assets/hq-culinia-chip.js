/* Transfert HQ — Culinia floating kitchen steward chip & AI chat drawer (assets/hq-culinia-chip.js) */
(function () {
  "use strict";

  var ID = "hq-culinia-chip";
  if (document.getElementById(ID)) return;

  var LS_POS = "hq_culinia_chip_pos_v1";
  var LS_SCALE = "hq_culinia_chip_scale_v1";
  var LS_NSFW = "hq_companion_nsfw";
  var PORTRAIT_SFW = "/assets/companion/culinia-chip-sfw.webp";
  var BODY_NSFW = "/assets/companion/culinia-body-nsfw.webp";
  var DRAG_THRESHOLD = 7;

  var dock = document.createElement("div");
  dock.id = "hq-culinia-chip-dock";
  dock.className = "hq-culinia-chip-dock";

  var button = document.createElement("button");
  button.type = "button";
  button.id = ID;
  button.className = "hq-culinia-chip";
  button.setAttribute("aria-label", "Culinia — ouvrir la cheffe des repas");
  button.title = "Culinia — Cheffe Repas · glisser pour déplacer";

  var frame = document.createElement("span");
  frame.className = "hq-culinia-chip-frame";

  var art = document.createElement("img");
  art.className = "hq-culinia-chip-art";
  art.alt = "Culinia";
  art.decoding = "async";
  art.addEventListener("load", function () { button.classList.add("has-art"); });
  art.addEventListener("error", function () { button.classList.remove("has-art"); });
  frame.appendChild(art);

  var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "hq-culinia-chip-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M6 15h12v4a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-4z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M6 15a4 4 0 0 1-1-7.8A4.5 4.5 0 0 1 12 4a4.5 4.5 0 0 1 7 3.2A4 4 0 0 1 18 15"/>';

  button.append(frame, icon);
  dock.appendChild(button);
  document.body.appendChild(dock);

  var drawer = document.createElement("aside");
  drawer.id = "hq-culinia-drawer";
  drawer.className = "hq-culinia-drawer";
  drawer.hidden = true;
  drawer.setAttribute("aria-label", "Culinia — Cheffe Repas");

  drawer.innerHTML =
    '<div class="hq-culinia-drawer-head">' +
      '<div class="hq-culinia-drawer-brand">' +
        '<div class="hq-culinia-drawer-orb">' +
          '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 15h12v4H6z"/><path d="M6 15a4 4 0 0 1-1-7.8A4.5 4.5 0 0 1 12 4a4.5 4.5 0 0 1 7 3.2A4 4 0 0 1 18 15"/></svg>' +
        '</div>' +
        '<div>' +
          '<div class="hq-culinia-drawer-title">Culinia</div>' +
          '<div class="hq-culinia-drawer-sub" id="hq-culinia-drawer-sub">Brigade HQ · En cuisine</div>' +
        '</div>' +
      '</div>' +
      '<div class="hq-culinia-drawer-controls">' +
        '<button type="button" class="hq-culinia-icon-btn" id="hq-culinia-clear" title="Effacer la conversation">Effacer</button>' +
        '<button type="button" class="hq-culinia-icon-btn" id="hq-culinia-close" aria-label="Fermer">✕</button>' +
      '</div>' +
    '</div>' +
    '<div class="hq-culinia-messages" id="hq-culinia-messages"></div>' +
    '<div class="hq-culinia-quick">' +
      '<button type="button" class="hq-culinia-quick-btn" data-prompt="Propose-moi des recettes avec ce que j\'ai en inventaire et dans mes lots.">Recettes inventaire</button>' +
      '<button type="button" class="hq-culinia-quick-btn" data-prompt="Inspecte mes recettes enregistrées et donne-moi ton avis de cheffe sur chacune.">Avis recettes</button>' +
      '<button type="button" class="hq-culinia-quick-btn" data-prompt="Planifie les repas de cette semaine directement dans le calendrier Repas (save_meal_calendar).">Remplir semaine</button>' +
      '<button type="button" class="hq-culinia-quick-btn" data-prompt="Consulte mon budget alimentation (get_food_budget) et prévisualise les courses manquantes de mon plan (build_plan_grocery_list).">Budget & courses</button>' +
    '</div>' +
    '<form class="hq-culinia-form" id="hq-culinia-form">' +
      '<input type="text" class="hq-culinia-input" id="hq-culinia-input" placeholder="Demander un menu, une recette ou les courses à Culinia…" autocomplete="off" maxlength="4000"/>' +
      '<button type="submit" class="hq-culinia-send" id="hq-culinia-send">Envoyer</button>' +
    '</form>';

  document.body.appendChild(drawer);

  var messagesEl = document.getElementById("hq-culinia-messages");
  var subEl = document.getElementById("hq-culinia-drawer-sub");
  var inputEl = document.getElementById("hq-culinia-input");
  var sendEl = document.getElementById("hq-culinia-send");
  var formEl = document.getElementById("hq-culinia-form");

  var state = { open: false, busy: false, messages: [], pos: { x: 0, y: 0 } };

  function clamp(v, min, max) {
    var n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
  }

  try {
    var saved = JSON.parse(localStorage.getItem(LS_POS) || "null");
    if (saved && typeof saved === "object") {
      state.pos.x = clamp(saved.x, -(window.innerWidth - 70), 12);
      state.pos.y = clamp(saved.y, -(window.innerHeight - 100), 12);
    }
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

  function setBlocked(on) { pinchBlocked = !!on; }
  function cancelDrag() {
    if (drag) { dock.classList.remove("is-dragging"); drag = null; }
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
    if (event.key === "+" || event.key === "=") { event.preventDefault(); chipScale.bump(step); }
    else if (event.key === "-") { event.preventDefault(); chipScale.bump(-step); }
    else if (event.key === "0") { event.preventDefault(); chipScale.resetScale(); }
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

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatReplyHtml(text) {
    var lines = escapeHtml(text).split(/\r?\n/);
    var out = [];
    var inList = false;
    function inline(s) {
      return s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
    }
    lines.forEach(function (line) {
      var m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      if (m) {
        if (!inList) { out.push('<ul class="hq-culinia-list">'); inList = true; }
        out.push("<li>" + inline(m[1]) + "</li>");
      } else {
        if (inList) { out.push("</ul>"); inList = false; }
        if (line.trim()) out.push("<div>" + inline(line) + "</div>");
      }
    });
    if (inList) out.push("</ul>");
    return out.join("");
  }

  function renderMessages() {
    messagesEl.innerHTML = "";
    if (!state.messages.length) {
      var welcome = document.createElement("div");
      welcome.className = "hq-culinia-msg is-assistant";
      welcome.textContent = "Les fourneaux sont prêts, Maître. Dis-moi ce que tu as envie de manger ou laisse-moi vérifier tes stocks.";
      messagesEl.appendChild(welcome);
      return;
    }
    state.messages.forEach(function (m) {
      var div = document.createElement("div");
      div.className = "hq-culinia-msg " + (m.role === "user" ? "is-user" : "is-assistant");
      if (m.role !== "user" && Array.isArray(m.tools_used) && m.tools_used.length) {
        var pills = document.createElement("div");
        pills.className = "hq-culinia-msg-tools";
        m.tools_used.forEach(function (t) {
          var tag = document.createElement("span");
          tag.className = "hq-culinia-tool-tag";
          tag.textContent = "🍳 " + t;
          pills.appendChild(tag);
        });
        div.appendChild(pills);
      }
      var body = document.createElement("div");
      if (m.role === "user") body.textContent = m.text || "";
      else body.innerHTML = formatReplyHtml(m.text || "");
      div.appendChild(body);
      if (m.role !== "user" && Array.isArray(m.images) && m.images.length) {
        var gallery = document.createElement("div");
        gallery.className = "hq-culinia-msg-images";
        m.images.forEach(function (im) {
          if (!im || !im.url) return;
          var card = document.createElement("a");
          card.className = "hq-culinia-img-card";
          card.href = im.url;
          card.target = "_blank";
          card.rel = "noopener";
          var pic = document.createElement("img");
          pic.src = im.url;
          pic.alt = im.title || "Recette";
          pic.loading = "lazy";
          card.appendChild(pic);
          if (im.title) {
            var cap = document.createElement("span");
            cap.className = "hq-culinia-img-cap";
            cap.textContent = im.title + (im.source ? " · " + im.source : "");
            card.appendChild(cap);
          }
          gallery.appendChild(card);
        });
        div.appendChild(gallery);
      }
      messagesEl.appendChild(div);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function refreshStatus() {
    if (!document.body.classList.contains("session-admin")) return;
    try {
      var data = await api("/api/culinia/status");
      if (data.headline && subEl) subEl.textContent = "Brigade HQ · " + data.headline;
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
  function closeDrawer() { state.open = false; drawer.hidden = true; }
  window.hqCuliniaOpen = openDrawer;

  button.addEventListener("click", function () {
    if (suppressClick) return;
    if (state.open) closeDrawer();
    else openDrawer();
  });
  document.getElementById("hq-culinia-close").addEventListener("click", closeDrawer);

  document.getElementById("hq-culinia-clear").addEventListener("click", async function () {
    try {
      await api("/api/culinia/clear", { method: "POST", headers: csrfHeaders(), body: "{}" });
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
    state.messages.push({ role: "assistant", text: "Vérification des fourneaux et des stocks…", tools_used: [] });
    renderMessages();

    try {
      var res = await api("/api/culinia/chat", {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify({ message: msg }),
      });
      if (res.cancelled) {
        // The conversation was cleared while this reply was generated: the
        // server did not save it, so never render it in the conversation.
        state.messages = Array.isArray(res.messages) ? res.messages : [];
        renderMessages();
        if (typeof window.toast === "function") window.toast("Conversation effacée — réponse abandonnée", "ok");
        return;
      }
      if (Array.isArray(res.messages)) state.messages = res.messages;
      else state.messages[state.messages.length - 1] = { role: "assistant", text: res.reply || "", tools_used: res.tools_used || [], images: res.images || [] };
      renderMessages();
      if (Array.isArray(res.tools_used) && res.tools_used.some(function (t) {
        return t === "create_meal_recipe" || t === "save_meal_calendar" || t === "scale_recipe_portions" || t === "build_plan_grocery_list";
      })) {
        window.dispatchEvent(new CustomEvent("hq:meals-changed"));
      }
    } catch (e) {
      state.messages[state.messages.length - 1] = { role: "assistant", text: "Erreur Culinia : " + e.message };
      renderMessages();
    } finally {
      state.busy = false;
      sendEl.disabled = false;
      inputEl.focus();
    }
  }

  formEl.addEventListener("submit", function (e) { e.preventDefault(); sendPrompt(inputEl.value); });
  drawer.querySelectorAll(".hq-culinia-quick-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { sendPrompt(btn.dataset.prompt); });
  });

  function isNsfwOn() {
    if (typeof window.hqCompanionNsfwOn === "function") return !!window.hqCompanionNsfwOn();
    try { return localStorage.getItem(LS_NSFW) === "1"; } catch (_) { return false; }
  }

  function applyMode() {
    var adult = isNsfwOn();
    button.classList.toggle("is-nsfw", adult);
    button.classList.remove("has-art");
    art.src = adult ? BODY_NSFW : PORTRAIT_SFW;
  }

  var lastBubbleAt = 0;
  var bubbleTimer = 0;
  var ambientInFlight = false;
  var lastRecipeCommented = "";

  function onRepasPage() {
    return document.body.classList.contains("session-admin") && document.body.dataset.view === "repas";
  }

  function keepBubbleOnScreen(b, dockEl) {
    try {
      var vw = document.documentElement.clientWidth || window.innerWidth || 390;
      var dr = dockEl.getBoundingClientRect();
      var w = b.offsetWidth;
      if (dr.left - 12 - w >= 8) return;
      if (dr.right + 10 + w <= vw - 8) {
        b.style.right = "auto";
        b.style.left = "calc(100% + 10px)";
        return;
      }
      b.style.maxWidth = Math.max(180, vw - 24) + "px";
      b.style.left = "auto";
      b.style.right = "0";
      b.style.top = "auto";
      b.style.bottom = "calc(100% + 10px)";
      b.style.transform = "none";
    } catch (_) {}
  }

  // iOS: the on-screen keyboard shrinks only the *visual* viewport. Expose its size so the
  // drawer can stay above the keyboard instead of hiding the input behind it.
  function syncViewportVars() {
    var vv = window.visualViewport;
    if (!vv) return;
    var kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    var root = document.documentElement.style;
    root.setProperty("--hq-chip-vvh", Math.round(vv.height) + "px");
    root.setProperty("--hq-chip-kb", (kb > 80 ? kb : 0) + "px");
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewportVars);
    window.visualViewport.addEventListener("scroll", syncViewportVars);
    syncViewportVars();
  }

  function clearBubble() {
    if (bubbleTimer) { window.clearTimeout(bubbleTimer); bubbleTimer = 0; }
    var old = dock.querySelector(".hq-culinia-chip-bubble");
    if (old) old.remove();
  }

  function showBubble(text, force) {
    if (!text || state.open || !onRepasPage()) return;
    var now = Date.now();
    if (!force && now - lastBubbleAt < 8000) return;
    lastBubbleAt = now;
    clearBubble();

    var b = document.createElement("div");
    b.className = "hq-culinia-chip-bubble" + (isNsfwOn() ? " is-nsfw" : "");
    b.textContent = text;
    b.title = "Cliquer pour parler à Culinia";
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      clearBubble();
      openDrawer();
    });
    dock.appendChild(b);
    keepBubbleOnScreen(b, dock);
    bubbleTimer = window.setTimeout(clearBubble, 8500);
  }

  async function fetchAmbient(trigger, extra) {
    if (ambientInFlight || drag || document.hidden || state.open || !onRepasPage()) return;
    ambientInFlight = true;
    try {
      var body = Object.assign({ trigger: trigger || "timer", nsfw: isNsfwOn() }, extra || {});
      var data = await api("/api/culinia/ambient", {
        method: "POST",
        headers: csrfHeaders(),
        body: JSON.stringify(body),
      });
      if (data && data.line) showBubble(data.line, trigger === "recipe" || trigger === "enter");
    } catch (_) {
    } finally {
      ambientInFlight = false;
    }
  }

  function extractClickedRecipeContext(target) {
    if (!target || !target.closest) return null;
    var mealsRoot = target.closest("#view-repas, .hq-meals");
    if (!mealsRoot) return null;
    var el = target.closest("[data-recipe-id], .hq-meals-recipe, .hq-meals-card, .hq-meals-slot, button");
    if (!el) return null;
    var titleEl = el.querySelector(".hq-meals-recipe-title, .hq-meals-card-title, h3, h4, strong");
    var txt = (titleEl ? titleEl.textContent : el.textContent || "").trim().replace(/\s+/g, " ");
    if (!txt || txt.length < 3 || txt.length > 90) return null;
    if (/^(‹|›|semaine|\+|ajouter|supprimer|enregistrer|fermer)$/i.test(txt)) return null;
    return txt;
  }

  document.addEventListener("click", function (e) {
    if (!onRepasPage() || state.open) return;
    var recipeTitle = extractClickedRecipeContext(e.target);
    if (!recipeTitle || recipeTitle === lastRecipeCommented) return;
    lastRecipeCommented = recipeTitle;
    window.setTimeout(function () {
      fetchAmbient("recipe", { recipe_title: recipeTitle });
    }, 350);
  });

  var viewObs = new MutationObserver(function () {
    if (onRepasPage()) {
      window.setTimeout(function () { fetchAmbient("enter"); }, 1200);
    } else {
      clearBubble();
    }
  });
  viewObs.observe(document.body, { attributes: true, attributeFilter: ["data-view", "class"] });

  applyMode();
  window.addEventListener("hq:companion-nsfw", function () {
    applyMode();
    if (onRepasPage()) window.setTimeout(function () { fetchAmbient("mode"); }, 700);
  });
  window.addEventListener("storage", function (ev) { if (!ev.key || ev.key === LS_NSFW) applyMode(); });
  setTimeout(refreshStatus, 1800);
  if (onRepasPage()) setTimeout(function () { fetchAmbient("enter"); }, 2200);
  setInterval(function () { fetchAmbient("timer"); }, 60000);
})();
