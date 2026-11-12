/* Transfert HQ — Pistonia, the Engine tab's assistant (assets/hq-pistonia-chip.js).
 *
 * A floating chip you can DRAG anywhere (mouse, touch, or arrow keys), RESIZE (pinch / Ctrl+wheel / menu, shared with the other chips)
 * and a chat window you can resize from its corner grip. She only appears on the Engine tab, for an admin session.
 *
 * Backend (hq_pistonia.py): the conversation, her memory notes, settings and alerts live on the SERVER (GET .../thread, POST .../message,
 * .../clear, .../seen, .../resolve, .../memory/delete, .../settings, .../voice). She speaks up first when something is wrong (a badge on the
 * chip and a message in the chat) and can read her replies aloud in her Phonon voice. She can only PROPOSE actions: each
 * proposal is a card with an Apply button, and Apply calls the normal Engine endpoint (admin + CSRF) - nothing happens without the click.
 * Everything is built with createElement + textContent.
 *
 * Portrait: SFW icon by default; in adult mode (hqCompanionNsfwOn, event hq:companion-nsfw) the chip uses
 * /assets/companion/pistonia-chip.webp if that file exists, and quietly keeps the SFW icon if it does not. */
(function () {
  "use strict";
  var win = window, doc = document;
  if (!doc || !doc.body) return;

  var SFW_SRC = "/assets/companion/pistonia-chip-sfw.webp";
  var SFW_SET = SFW_SRC + " 1x, /assets/companion/pistonia-chip-sfw@2x.webp 2x";
  var ADULT_SRC = "/assets/companion/pistonia-chip.webp";
  var ADULT_SET = ADULT_SRC + " 1x, /assets/companion/pistonia-chip@2x.webp 2x";
  var LS_POS = "hq_pistonia_chip_pos_v1", LS_SCALE = "hq_pistonia_chip_scale_v1", LS_SIZE = "hq_pistonia_bubble_size_v1";
  var LS_OPEN = "hq_pistonia_open_v1", LS_HIDDEN = "hq_pistonia_hidden_v1";
  var CHIP_BASE = 72, DRAG_PX = 8, LONG_MS = 650, KEY_STEP = 12, EDGE = 6;
  var MIN_W = 300, MIN_H = 300, MAX_W = 760, MAX_H = 860, DEF_W = 400, DEF_H = 520;
  var ACTION_URL = /^\/api\/engine\/daemons\/[a-z0-9][a-z0-9_-]{0,31}\/(start|stop|restart|autostop)$/;

  var T = {
    name: "Pistonia", sub: "Salle des machines", open: "Ouvrir Pistonia", close: "Fermer", clear: "Effacer la conversation",
    placeholder: "Demande-moi quelque chose sur les moteurs…", send: "Envoyer", grip: "Redimensionner la fenêtre",
    thinking: "Pistonia réfléchit…", apply: "Appliquer", dismiss: "Ignorer", done: "Fait", failed: "Échec",
    smaller: "Plus petite", larger: "Plus grande", resetSize: "Taille normale", resetPos: "Position d'origine", resetWin: "Fenêtre normale",
    hide: "Masquer Pistonia", retry: "Réessayer", offline: "Réseau indisponible.", errorGeneric: "Pistonia n'a pas pu répondre.",
    proposal: "Proposition", noted: "Noté", forget: "Oublier", settings: "Réglages", back: "Retour à la conversation",
    voiceOn: "Voix activée", voiceOff: "Voix coupée", notes: "Ce qu'elle retient", noNotes: "Rien pour l'instant. Dis-lui une préférence durable, elle la notera.",
    notify: "M'avertir aussi par Discord / notification (alertes de Pistonia)", notifyHint: "Désactivé par défaut. Seules ses alertes partent, jamais le contenu des conversations.",
    clearChat: "Effacer la conversation", alertBadge: "alerte(s) non lue(s)", voiceLabel: "Voix", clearDone: "Conversation effacée.", stopT: "Arrêter", startT: "Démarrer", restartT: "Redémarrer", autoOn: "Arrêt auto activé", autoOff: "Arrêt auto désactivé",
    quick: [["Un souci ?", "Is anything wrong?"], ["Qui mange ma RAM ?", "What is using the most memory right now?"],
            ["Libère de la VRAM", "Help me free some VRAM."], ["Explique l'arrêt auto", "Explain idle auto-stop and when I should use it."]]
  };

  function lsGet(k) { try { return win.localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { win.localStorage.setItem(k, v); } catch (_) {} }
  function clamp(n, lo, hi) { n = Number(n); if (!isFinite(n)) return lo; return Math.max(lo, Math.min(hi, n)); }
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function readJSON(k, fallback) { try { var v = JSON.parse(lsGet(k)); return v == null ? fallback : v; } catch (_) { return fallback; } }

  /* ---------------- DOM ---------------- */
  var root = el("div", "hq-pistonia");
  root.id = "hq-pistonia";
  root.hidden = true;
  root.dataset.mood = "idle";

  var bubble = el("div", "hq-pistonia-bubble");
  bubble.setAttribute("role", "dialog");
  bubble.setAttribute("aria-label", T.name);
  bubble.hidden = true;
  bubble.addEventListener("animationend", function () { bubble.classList.remove("is-pop"); });

  var grip = el("div", "hq-pistonia-grip");
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-label", T.grip);
  grip.title = T.grip;
  grip.tabIndex = 0;
  bubble.appendChild(grip);

  var head = el("header", "hq-pistonia-head");
  var headImg = el("img", "hq-pistonia-head-img");
  headImg.alt = "";
  headImg.width = 36; headImg.height = 36;
  head.appendChild(headImg);
  var titles = el("div", "hq-pistonia-titles");
  titles.appendChild(el("strong", "hq-pistonia-name", T.name));
  titles.appendChild(el("span", "hq-pistonia-sub", T.sub));
  head.appendChild(titles);
  var voiceBtn = el("button", "hq-pistonia-hbtn hq-pistonia-voicebtn", "🔊");
  voiceBtn.type = "button"; voiceBtn.setAttribute("aria-pressed", "true");
  var gearBtn = el("button", "hq-pistonia-hbtn", "⚙");
  gearBtn.type = "button"; gearBtn.title = T.settings; gearBtn.setAttribute("aria-label", T.settings); gearBtn.setAttribute("aria-pressed", "false");
  var closeBtn = el("button", "hq-pistonia-hbtn", "×");
  closeBtn.type = "button"; closeBtn.title = T.close; closeBtn.setAttribute("aria-label", T.close);
  head.appendChild(voiceBtn);
  head.appendChild(gearBtn);
  head.appendChild(closeBtn);
  bubble.appendChild(head);

  var logEl = el("div", "hq-pistonia-log");
  logEl.setAttribute("role", "log");
  logEl.setAttribute("aria-live", "polite");
  bubble.appendChild(logEl);

  var panelEl = el("div", "hq-pistonia-settings");
  panelEl.hidden = true;
  bubble.appendChild(panelEl);

  var quick = el("div", "hq-pistonia-quick");
  T.quick.forEach(function (q) {
    var b = el("button", "hq-pistonia-qbtn", q[0]);
    b.type = "button";
    b.addEventListener("click", function () { send(q[1], q[0]); });
    quick.appendChild(b);
  });
  bubble.appendChild(quick);

  var form = el("form", "hq-pistonia-form");
  var input = el("input", "hq-pistonia-input");
  input.type = "text"; input.maxLength = 1200; input.placeholder = T.placeholder; input.autocomplete = "off";
  input.setAttribute("aria-label", T.placeholder);
  var sendBtn = el("button", "hq-pistonia-send", T.send);
  sendBtn.type = "submit";
  form.appendChild(input);
  form.appendChild(sendBtn);
  bubble.appendChild(form);

  var chip = el("button", "hq-pistonia-chip");
  chip.type = "button";
  chip.setAttribute("aria-label", T.open);
  chip.setAttribute("aria-expanded", "false");
  chip.title = T.name;
  var chipImg = el("img", "hq-pistonia-chip-img");
  chipImg.alt = "";
  chipImg.draggable = false;
  var dot = el("span", "hq-pistonia-dot");
  chip.appendChild(chipImg);
  var badge = el("span", "hq-pistonia-badge");
  badge.hidden = true;
  chip.appendChild(dot);
  chip.appendChild(badge);

  var menu = el("div", "hq-pistonia-menu");
  menu.setAttribute("role", "menu");
  menu.hidden = true;

  root.appendChild(bubble);
  root.appendChild(chip);
  root.appendChild(menu);
  doc.body.appendChild(root);

  /* ---------------- portrait (SFW icon / adult image when present) ---------------- */
  var adultState = null;   // null = unknown, true = file exists, false = missing

  function setPortrait(src, set) {
    [chipImg, headImg].forEach(function (img) { img.src = src; img.srcset = set; });
  }
  function applyPortrait() {
    var adult = false;
    try { adult = !!(win.HqImageChipScale && win.HqImageChipScale.adultChipPortraits(win)); } catch (_) {}
    root.classList.toggle("is-adult-portrait", adult && adultState === true);
    if (!adult || adultState === false) { setPortrait(SFW_SRC, SFW_SET); return; }
    if (adultState === true) { setPortrait(ADULT_SRC, ADULT_SET); return; }
    setPortrait(SFW_SRC, SFW_SET);                                    // show the icon while we check the file
    var probe = new win.Image();
    probe.onload = function () { adultState = true; applyPortrait(); };
    probe.onerror = function () { adultState = false; };
    probe.src = ADULT_SRC;
  }
  if (win.HqImageChipScale && win.HqImageChipScale.bindPortraitMode) {
    win.HqImageChipScale.bindPortraitMode(win, { root: root, onRefresh: applyPortrait });
  } else {
    applyPortrait();
  }

  /* ---------------- geometry: position, size, bubble placement ---------------- */
  var pos = readJSON(LS_POS, null);          // {xr, yr}: fractions of the free area, so it survives a different screen
  var bsize = readJSON(LS_SIZE, null) || { w: DEF_W, h: DEF_H };
  var scaleApi = null;

  function chipSize() { return CHIP_BASE * (scaleApi ? scaleApi.getScale() : (parseFloat(lsGet(LS_SCALE)) || 1)); }
  function freeArea() {
    var s = chipSize();
    return { w: Math.max(0, win.innerWidth - s - 2 * EDGE), h: Math.max(0, win.innerHeight - s - 2 * EDGE), s: s };
  }
  function defaultPos() {
    var f = freeArea(), navPad = win.innerWidth < 900 ? 84 : 28;
    return { xr: f.w > 0 ? Math.max(0, f.w - 10) / f.w : 1, yr: f.h > 0 ? Math.max(0, f.h - navPad) / f.h : 1 };
  }
  function place() {
    var f = freeArea(), p = pos || defaultPos();
    var x = EDGE + clamp(p.xr, 0, 1) * f.w, y = EDGE + clamp(p.yr, 0, 1) * f.h;
    root.style.left = x.toFixed(1) + "px";
    root.style.top = y.toFixed(1) + "px";
    layoutBubble();
  }
  function setPosPx(x, y) {
    var f = freeArea();
    pos = { xr: f.w > 0 ? clamp((x - EDGE) / f.w, 0, 1) : 0, yr: f.h > 0 ? clamp((y - EDGE) / f.h, 0, 1) : 0 };
  }
  function savePos() { if (pos) lsSet(LS_POS, JSON.stringify({ xr: +pos.xr.toFixed(4), yr: +pos.yr.toFixed(4) })); }

  var placement = { above: true, alignRight: true };

  function layoutBubble() {
    if (bubble.hidden) return;
    var r = root.getBoundingClientRect(), vw = win.innerWidth, vh = win.innerHeight, gap = 10;   // root has no transform: stable while the chip animates
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    placement.above = cy > vh * 0.5;
    placement.alignRight = cx > vw * 0.5;
    var space = placement.above ? r.top - EDGE - gap : vh - r.bottom - EDGE - gap;
    var maxW = Math.min(MAX_W, vw - 2 * EDGE), maxH = Math.max(220, Math.min(MAX_H, space));
    var w = clamp(bsize.w, Math.min(MIN_W, maxW), maxW), h = clamp(bsize.h, Math.min(MIN_H, maxH), maxH);
    bubble.style.width = w + "px";
    bubble.style.height = h + "px";
    var left = clamp(placement.alignRight ? r.right - w : r.left, EDGE, vw - w - EDGE);
    bubble.style.left = (left - r.left).toFixed(1) + "px";
    bubble.style.right = "auto";
    if (placement.above) { bubble.style.bottom = (r.height + gap) + "px"; bubble.style.top = "auto"; }
    else { bubble.style.top = (r.height + gap) + "px"; bubble.style.bottom = "auto"; }
    bubble.classList.toggle("is-above", placement.above);
    bubble.classList.toggle("is-right", placement.alignRight);
    menu.classList.toggle("is-above", placement.above);
    menu.classList.toggle("is-right", placement.alignRight);
    grip.dataset.corner = (placement.above ? "t" : "b") + (placement.alignRight ? "l" : "r");
  }

  /* ---------------- drag (chip, and the chat header) ---------------- */
  var drag = null, suppressClick = false, longTimer = null;

  function cancelDrag() {
    win.clearTimeout(longTimer);
    drag = null;
    root.classList.remove("is-dragging");
  }

  function bindDrag(handle, opts) {
    handle.addEventListener("pointerdown", function (ev) {
      if (ev.button && ev.button !== 0) return;
      if (opts.ignore && opts.ignore(ev.target)) return;
      if (drag) { cancelDrag(); return; }                       // a second finger: that is a pinch, not a drag
      var r = root.getBoundingClientRect();
      drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, ox: r.left, oy: r.top, moved: false, handle: handle };
      if (opts.longPress) {
        longTimer = win.setTimeout(function () {
          if (drag && !drag.moved) { cancelDrag(); suppressClick = true; openMenu(); }
        }, LONG_MS);
      }
    });
    handle.addEventListener("pointermove", function (ev) {
      if (!drag || drag.id !== ev.pointerId) return;
      var dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_PX) return;
      if (!drag.moved) {
        drag.moved = true;
        win.clearTimeout(longTimer);
        closeMenu();
        root.classList.add("is-dragging");
        try { handle.setPointerCapture(ev.pointerId); } catch (_) {}
      }
      setPosPx(drag.ox + dx, drag.oy + dy);
      place();
      if (ev.cancelable) ev.preventDefault();
    });
    function end(ev) {
      if (!drag || (ev && drag.id !== ev.pointerId)) return;
      var moved = drag.moved;
      cancelDrag();
      if (moved) { suppressClick = true; savePos(); win.setTimeout(function () { suppressClick = false; }, 60); }
    }
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  bindDrag(chip, { longPress: true });
  bindDrag(head, { ignore: function (t) { return t.closest && t.closest("button"); } });

  chip.addEventListener("click", function (ev) {
    if (suppressClick) { suppressClick = false; ev.preventDefault(); return; }
    if (!menu.hidden) { closeMenu(); return; }
    toggle();
  });
  chip.addEventListener("contextmenu", function (ev) { ev.preventDefault(); openMenu(); });
  chip.addEventListener("keydown", function (ev) {
    var d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (!d || !ev.altKey && !ev.shiftKey) return;               // plain arrows stay for scrolling; Shift/Alt + arrows move the chip
    ev.preventDefault();
    var r = root.getBoundingClientRect();
    setPosPx(r.left + d[0] * KEY_STEP * (ev.shiftKey ? 3 : 1), r.top + d[1] * KEY_STEP * (ev.shiftKey ? 3 : 1));
    place(); savePos();
  });

  /* ---------------- resize: chip (shared pinch / Ctrl+wheel) and the chat window (corner grip) ---------------- */
  var lastScale = 1;
  function scaleMaybeChanged() {
    if (!scaleApi) return;
    var sc = scaleApi.getScale();
    if (sc !== lastScale) { lastScale = sc; place(); }
  }
  if (win.HqImageChipScale && win.HqImageChipScale.bind) {
    scaleApi = win.HqImageChipScale.bind(win, {
      root: root, chip: chip, storageKey: LS_SCALE,
      cancelDrag: cancelDrag, setBlocked: function () {}
    });
    lastScale = scaleApi.getScale();
    ["pointermove", "pointerup", "pointercancel", "wheel"].forEach(function (t) {
      chip.addEventListener(t, function () { win.setTimeout(scaleMaybeChanged, 0); }, true);
    });
  }

  function changeScale(delta) {
    if (!scaleApi) return;
    if (delta === 0) scaleApi.resetScale(); else scaleApi.bump(delta);
    scaleMaybeChanged();
  }

  var rs = null;
  grip.addEventListener("pointerdown", function (ev) {
    if (ev.button && ev.button !== 0) return;
    rs = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, w: bubble.offsetWidth, h: bubble.offsetHeight };
    try { grip.setPointerCapture(ev.pointerId); } catch (_) {}
    root.classList.add("is-resizing");
    ev.preventDefault();
  });
  grip.addEventListener("pointermove", function (ev) {
    if (!rs || rs.id !== ev.pointerId) return;
    var dx = ev.clientX - rs.sx, dy = ev.clientY - rs.sy;
    bsize = { w: rs.w + (placement.alignRight ? -dx : dx), h: rs.h + (placement.above ? -dy : dy) };
    layoutBubble();
  });
  function endResize() {
    if (!rs) return;
    rs = null;
    root.classList.remove("is-resizing");
    bsize = { w: bubble.offsetWidth, h: bubble.offsetHeight };      // layout size: unaffected by the pop animation's transform
    lsSet(LS_SIZE, JSON.stringify(bsize));
  }
  grip.addEventListener("pointerup", endResize);
  grip.addEventListener("pointercancel", endResize);
  grip.addEventListener("keydown", function (ev) {                   // keyboard resize: arrows grow/shrink toward the free side
    var k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (!k) return;
    ev.preventDefault();
    var step = ev.shiftKey ? 60 : 20;
    bsize = { w: bubble.offsetWidth + (placement.alignRight ? -k[0] : k[0]) * step, h: bubble.offsetHeight + (placement.above ? -k[1] : k[1]) * step };
    layoutBubble();
    lsSet(LS_SIZE, JSON.stringify({ w: Math.round(bsize.w), h: Math.round(bsize.h) }));
  });

  /* ---------------- menu ---------------- */
  function menuItem(label, fn) {
    var b = el("button", "hq-pistonia-mitem", label);
    b.type = "button"; b.setAttribute("role", "menuitem");
    b.addEventListener("click", function () { fn(); closeMenu(); });
    menu.appendChild(b);
  }
  menuItem(T.smaller, function () { changeScale(-(scaleApi ? scaleApi.menuStep : 0.08)); });
  menuItem(T.larger, function () { changeScale(scaleApi ? scaleApi.menuStep : 0.08); });
  menuItem(T.resetSize, function () { changeScale(0); });
  menuItem(T.resetWin, function () { bsize = { w: DEF_W, h: DEF_H }; lsSet(LS_SIZE, JSON.stringify(bsize)); layoutBubble(); });
  menuItem(T.resetPos, function () { pos = null; try { win.localStorage.removeItem(LS_POS); } catch (_) {} place(); });
  menuItem(T.hide, function () { api.hide(); });

  function openMenu() { menu.hidden = false; layoutBubble(); var f = menu.querySelector("button"); if (f) f.focus(); }
  function closeMenu() { menu.hidden = true; }
  doc.addEventListener("pointerdown", function (ev) { if (!menu.hidden && !menu.contains(ev.target) && ev.target !== chip) closeMenu(); }, true);

  /* ---------------- chat ---------------- */
  var state = { notes: [], settings: { notify: false, voice: true }, voice: {}, unseen: 0, loaded: false, shown: {} };
  var busy = false, typingRow = null, lastText = "", view = "chat";

  function scrollDown() { logEl.scrollTop = logEl.scrollHeight; }

  function post(url, body) {
    return win.fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }, function () { return { ok: false, status: r.status, data: {} }; }); });
  }
  function getJSON(url) {
    return win.fetch(url, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); });
  }

  /* ----- one message (chat / alert / all-clear / greeting) with its proposal cards and remembered notes ----- */
  function addMsg(role, text, kind) {
    var row = el("div", "hq-pistonia-msg is-" + role + (kind && kind !== "chat" ? " is-" + kind : ""));
    if (kind === "alert") row.appendChild(el("span", "hq-pistonia-msg-tag", "⚠"));
    if (kind === "clear") row.appendChild(el("span", "hq-pistonia-msg-tag", "✓"));
    row.appendChild(doc.createTextNode(text));
    logEl.appendChild(row);
    scrollDown();
    return row;
  }

  function renderMessage(m) {
    state.shown[m.id] = true;
    state.lastId = m.id;
    addMsg(m.role, m.text, m.kind);
    (m.remembered || []).forEach(function (n) { logEl.appendChild(noteLine(n)); });
    (m.proposals || []).forEach(function (p) { logEl.appendChild(proposalCard(p, m.id)); });
  }

  function noteLine(n) {
    var row = el("div", "hq-pistonia-note");
    row.appendChild(el("span", "hq-pistonia-note-tag", "🧠 " + T.noted + " : "));
    row.appendChild(el("span", "hq-pistonia-note-text", n.text));
    var b = el("button", "hq-pistonia-link", T.forget);
    b.type = "button";
    b.addEventListener("click", function () {
      post("/api/engine/pistonia/memory/delete", { id: n.id }).then(function () {
        state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
        row.classList.add("is-gone");
        b.disabled = true;
        if (view === "settings") renderSettings();
      });
    });
    row.appendChild(b);
    return row;
  }

  function describe(p) {
    var verb = { stop: T.stopT, start: T.startT, restart: T.restartT }[p.action];
    if (p.kind === "autostop") return (p.enabled ? T.autoOn + " · " + p.idle_min + " min" : T.autoOff) + " — " + p.label;
    return (verb || p.action) + " — " + p.label;
  }

  function proposalCard(p, msgId) {
    var card = el("div", "hq-pistonia-prop");
    card.appendChild(el("div", "hq-pistonia-prop-title", describe(p)));
    if (p.reason) card.appendChild(el("div", "hq-pistonia-prop-text", p.reason));
    if (p.impact) card.appendChild(el("div", "hq-pistonia-prop-impact", p.impact));
    var bar = el("div", "hq-pistonia-prop-actions");
    var ok = el("button", "hq-pistonia-pbtn is-primary", T.apply);
    ok.type = "button";
    var no = el("button", "hq-pistonia-pbtn", T.dismiss);
    no.type = "button";
    var status = el("span", "hq-pistonia-prop-status");
    status.setAttribute("role", "status");
    bar.appendChild(ok); bar.appendChild(no); bar.appendChild(status);
    card.appendChild(bar);
    var resolve = function () { if (msgId) post("/api/engine/pistonia/resolve", { id: msgId }); };
    no.addEventListener("click", function () { card.remove(); resolve(); });
    ok.addEventListener("click", function () {
      // Only the Engine's own daemon endpoints are ever called, whatever the server sent.
      if (typeof p.url !== "string" || !ACTION_URL.test(p.url)) { status.textContent = T.failed; return; }
      ok.disabled = no.disabled = true;
      status.textContent = "…";
      post(p.url, p.body || {}).then(function (r) {
        if (r.ok) { status.textContent = "✓ " + T.done; card.classList.add("is-done"); resolve(); if (typeof win.hqEngineRefresh === "function") win.hqEngineRefresh(); }
        else { status.textContent = T.failed + (r.data && (r.data.message || r.data.error) ? " : " + String(r.data.message || r.data.error).slice(0, 100) : ""); ok.disabled = no.disabled = false; card.classList.add("is-failed"); }
      }).catch(function () { status.textContent = T.offline; ok.disabled = no.disabled = false; });
    });
    return card;
  }

  function setBusy(on) {
    busy = on;
    sendBtn.disabled = on;
    input.disabled = on;
    root.classList.toggle("is-busy-chat", on);
    if (on) {
      typingRow = el("div", "hq-pistonia-msg is-assistant is-typing");
      typingRow.setAttribute("aria-label", T.thinking);
      for (var i = 0; i < 3; i++) typingRow.appendChild(el("i"));
      logEl.appendChild(typingRow);
      scrollDown();
    } else {
      if (typingRow) { typingRow.remove(); typingRow = null; }
      if (isOpen && view === "chat") input.focus({ preventScroll: true });
    }
  }

  function send(text, shown) {
    text = String(text || "").trim();
    if (!text || busy) return;
    if (view !== "chat") showView("chat");
    stopVoice();
    lastText = text;
    addMsg("user", shown || text);
    input.value = "";
    setBusy(true);
    setMood("busy");
    post("/api/engine/pistonia/message", { text: text }).then(function (r) {
      setBusy(false);
      if (r.ok && r.data && r.data.reply) {
        var m = { id: r.data.id || ("local-" + Date.now()), role: "assistant", text: r.data.reply, kind: "chat",
                  proposals: r.data.proposals, remembered: r.data.remembered };
        renderMessage(m);
        (r.data.remembered || []).forEach(function (n) { state.notes.push(n); });
        speak(r.data.reply);
      } else {
        showError((r.data && r.data.error) || T.errorGeneric, !!(r.data && r.data.retryable));
      }
      refreshMood();
    }).catch(function () {
      setBusy(false);
      showError(T.offline, true);
      refreshMood();
    });
  }

  function showError(msg, retryable) {
    var row = el("div", "hq-pistonia-msg is-error", msg);
    if (retryable && lastText) {
      var b = el("button", "hq-pistonia-pbtn", T.retry);
      b.type = "button";
      b.addEventListener("click", function () { row.remove(); var t = lastText; logEl.lastChild && logEl.lastChild.classList.contains("is-user") && logEl.lastChild.remove(); send(t); });
      row.appendChild(b);
    }
    logEl.appendChild(row);
    scrollDown();
  }

  /* ----- conversation from the server; new messages (her alerts) are appended and read aloud ----- */
  function loadThread(initial) {
    return getJSON("/api/engine/pistonia/thread").then(function (r) {
      if (!r.ok || !r.data || !r.data.messages) return;
      var d = r.data, fresh = [];
      state.notes = d.notes || [];
      state.settings = d.settings || state.settings;
      state.voice = d.voice || {};
      syncVoiceBtn();
      if (initial || !state.loaded) {
        logEl.textContent = "";
        state.shown = {};
        d.messages.forEach(renderMessage);
      } else {
        // Only what comes AFTER the last message we drew (the user's own lines are drawn locally and have no id here yet).
        var idx = -1;
        d.messages.forEach(function (m, i) { if (m.id === state.lastId) idx = i; });
        (idx >= 0 ? d.messages.slice(idx + 1) : d.messages.filter(function (m) { return !state.shown[m.id]; }))
          .forEach(function (m) { fresh.push(m); renderMessage(m); });
      }
      state.loaded = true;
      fresh.filter(function (m) { return m.role === "assistant" && m.kind !== "clear"; }).slice(-1).forEach(function (m) { speak(m.text); });
      markSeen(d.unseen);
      if (view === "settings") renderSettings();
    }).catch(function () {});
  }

  function markSeen(n) {
    if (n > 0 && isOpen) post("/api/engine/pistonia/seen", {}).then(function () { setUnseen(0); });
  }

  function setUnseen(n) {
    state.unseen = n;
    badge.hidden = !(n > 0);
    badge.textContent = n > 9 ? "9+" : String(n);
    chip.setAttribute("aria-label", T.open + (n > 0 ? " (" + n + " " + T.alertBadge + ")" : ""));
    root.classList.toggle("has-alerts", n > 0);
  }

  /* ----- voice: her replies read aloud in her Phonon voice; a failure is simply silence ----- */
  var audio = null, voiceSeq = 0, voiceAbort = null;
  function stopVoice() {
    voiceSeq++;
    if (voiceAbort) { try { voiceAbort.abort(); } catch (_) {} voiceAbort = null; }
    if (audio) { var a = audio; audio = null; try { a.pause(); a.src = ""; } catch (_) {} }
    if (root.dataset.mood === "speaking") refreshMood();
  }
  function syncVoiceBtn() {
    var on = state.settings.voice !== false;
    voiceBtn.setAttribute("aria-pressed", on ? "true" : "false");
    voiceBtn.textContent = on ? "🔊" : "🔈";
    voiceBtn.title = on ? T.voiceOn : T.voiceOff;
    voiceBtn.setAttribute("aria-label", voiceBtn.title);
    voiceBtn.classList.toggle("is-off", !on);
  }
  function speak(text) {
    if (state.settings.voice === false || !isOpen || !text) return;
    stopVoice();
    var my = voiceSeq;
    voiceAbort = new win.AbortController();
    win.fetch("/api/engine/pistonia/voice", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text }), signal: voiceAbort.signal })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (my !== voiceSeq || !d || !d.ok || typeof d.audio_url !== "string" || d.audio_url.indexOf("/assets/companion/chat/voice_cache/") !== 0) return;
        var a = new win.Audio(d.audio_url);
        audio = a;
        var done = function () { if (audio === a) { audio = null; refreshMood(); } };
        a.addEventListener("ended", done);
        a.addEventListener("error", done);
        setMood("speaking");
        var pr = a.play();
        if (pr && pr.catch) pr.catch(done);            // autoplay can be refused when she speaks first: silence, not an error
      }).catch(function () {});
  }
  voiceBtn.addEventListener("click", function () {
    var on = !(state.settings.voice !== false);
    state.settings.voice = on;
    syncVoiceBtn();
    if (!on) stopVoice();
    post("/api/engine/pistonia/settings", { voice: on });
  });

  /* ----- settings view: notifications, her notes, clear the conversation ----- */
  function showView(v) {
    view = v;
    var chat = v === "chat";
    logEl.hidden = !chat; quick.hidden = !chat; form.hidden = !chat; panelEl.hidden = chat;
    gearBtn.setAttribute("aria-pressed", chat ? "false" : "true");
    gearBtn.title = chat ? T.settings : T.back;
    gearBtn.textContent = chat ? "⚙" : "←";
    gearBtn.setAttribute("aria-label", chat ? T.settings : T.back);
    if (!chat) renderSettings(); else { scrollDown(); input.focus({ preventScroll: true }); }
  }
  function renderSettings() {
    panelEl.textContent = "";
    var sec1 = el("section", "hq-pistonia-sec");
    var lab = el("label", "hq-pistonia-switch");
    var cb = el("input"); cb.type = "checkbox"; cb.checked = !!state.settings.notify;
    cb.addEventListener("change", function () {
      post("/api/engine/pistonia/settings", { notify: cb.checked }).then(function (r) { if (r.ok && r.data.settings) state.settings = r.data.settings; else cb.checked = !cb.checked; });
    });
    lab.appendChild(cb);
    lab.appendChild(el("span", null, T.notify));
    sec1.appendChild(lab);
    sec1.appendChild(el("p", "hq-pistonia-hint", T.notifyHint));
    panelEl.appendChild(sec1);

    var sec2 = el("section", "hq-pistonia-sec");
    sec2.appendChild(el("h4", null, T.notes + " (" + state.notes.length + ")"));
    if (!state.notes.length) sec2.appendChild(el("p", "hq-pistonia-hint", T.noNotes));
    var ul = el("ul", "hq-pistonia-notes");
    state.notes.forEach(function (n) {
      var li = el("li");
      li.appendChild(el("span", null, n.text));
      var b = el("button", "hq-pistonia-link", T.forget);
      b.type = "button";
      b.setAttribute("aria-label", T.forget + " : " + n.text);
      b.addEventListener("click", function () {
        post("/api/engine/pistonia/memory/delete", { id: n.id }).then(function () { state.notes = state.notes.filter(function (x) { return x.id !== n.id; }); renderSettings(); });
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
    sec2.appendChild(ul);
    panelEl.appendChild(sec2);

    var sec3 = el("section", "hq-pistonia-sec");
    var clr = el("button", "hq-pistonia-pbtn", T.clearChat);
    clr.type = "button";
    clr.addEventListener("click", function () {
      stopVoice();
      post("/api/engine/pistonia/clear", {}).then(function () { state.loaded = false; showView("chat"); loadThread(true); });
    });
    sec3.appendChild(clr);
    panelEl.appendChild(sec3);
  }
  gearBtn.addEventListener("click", function () { showView(view === "chat" ? "settings" : "chat"); });

  form.addEventListener("submit", function (ev) { ev.preventDefault(); send(input.value); });
  closeBtn.addEventListener("click", function () { setOpen(false); chip.focus(); });
  bubble.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { setOpen(false); chip.focus(); } });
  doc.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && !menu.hidden) { closeMenu(); chip.focus(); } });

  /* ---------------- mood (from the Engine tab's live status) ---------------- */
  var moodNow = "idle", lastStatus = null;
  function setMood(m) { moodNow = m; root.dataset.mood = m; }
  function moodFromStatus(st) {
    if (!st || !st.daemons) return "idle";
    var s = st.system || {};
    var hot = (s.ram_total_mb && s.ram_used_mb / s.ram_total_mb >= 0.9) ||
      (s.gpus && s.gpus[0] && s.gpus[0].vram_total_mb && s.gpus[0].vram_used_mb / s.gpus[0].vram_total_mb >= 0.9);
    if (hot || st.daemons.some(function (d) { return d.state === "error" || d.state === "foreign" || d.state === "warn"; })) return "alert";
    if (st.daemons.some(function (d) { return d.state === "busy"; })) return "busy";
    return "idle";
  }
  function refreshMood() { if (!busy) setMood(moodFromStatus(lastStatus)); }
  win.addEventListener("hq:engine-status", function (ev) {
    lastStatus = ev.detail;
    refreshMood();
    var ps = (ev.detail && ev.detail.pistonia) || {}, un = ps.unseen || 0;
    if (isOpen) { if (state.loaded && ps.last && !state.shown[ps.last] && !busy) loadThread(false); }   // she spoke first: show it (and read it)
    else setUnseen(un);
  });

  /* ---------------- open / close / visibility ---------------- */
  var isOpen = false;
  function setOpen(on) {
    isOpen = !!on;
    if (!isOpen) stopVoice();
    bubble.hidden = !isOpen;
    root.classList.toggle("is-open", isOpen);
    chip.setAttribute("aria-expanded", isOpen ? "true" : "false");
    lsSet(LS_OPEN, isOpen ? "1" : "0");
    if (isOpen) {
      bubble.classList.remove("is-pop");
      void bubble.offsetWidth;
      bubble.classList.add("is-pop");
      layoutBubble();
      showView("chat");
      loadThread(true);
      win.setTimeout(function () { input.focus({ preventScroll: true }); scrollDown(); }, 30);
    }
  }
  function toggle() { setOpen(!isOpen); }

  function adminOnEngine() {
    return doc.body.dataset.view === "engine" && doc.body.classList.contains("session-admin");
  }
  function syncVisible() {
    var show = adminOnEngine() && lsGet(LS_HIDDEN) !== "1";
    root.hidden = !show;
    if (show) { place(); if (lsGet(LS_OPEN) === "1" && !isOpen) setOpen(true); }
    else if (isOpen) { bubble.hidden = true; root.classList.remove("is-open"); isOpen = false; }
  }

  var api = {
    open: function () { lsSet(LS_HIDDEN, "0"); syncVisible(); if (!root.hidden) setOpen(true); },
    close: function () { setOpen(false); },
    show: function () { lsSet(LS_HIDDEN, "0"); syncVisible(); },
    hide: function () { setOpen(false); lsSet(LS_HIDDEN, "1"); syncVisible(); },
    isHidden: function () { return lsGet(LS_HIDDEN) === "1"; }
  };
  win.HqPistonia = api;

  try {
    new win.MutationObserver(syncVisible).observe(doc.body, { attributes: true, attributeFilter: ["data-view", "class"] });
  } catch (_) {}
  win.addEventListener("hashchange", syncVisible);
  win.addEventListener("resize", function () { place(); });
  syncVisible();
})();
