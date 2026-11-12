/* Transfert HQ — Pistonia, the Engine tab's assistant (assets/hq-pistonia-chip.js).
 *
 * A floating chip you can DRAG anywhere (mouse, touch, or arrow keys), RESIZE (pinch / Ctrl+wheel / menu, shared with the other chips)
 * and a chat window you can resize from its corner grip. She only appears on the Engine tab, for an admin session.
 *
 * Backend: GET /api/engine/pistonia/greeting, POST /api/engine/pistonia/message (see hq_pistonia.py). She can only PROPOSE actions: each
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
  var LS_OPEN = "hq_pistonia_open_v1", LS_HIDDEN = "hq_pistonia_hidden_v1", LS_HISTORY = "hq_pistonia_history_v1";
  var CHIP_BASE = 72, DRAG_PX = 8, LONG_MS = 650, KEY_STEP = 12, EDGE = 6;
  var MIN_W = 300, MIN_H = 300, MAX_W = 760, MAX_H = 860, DEF_W = 400, DEF_H = 520;
  var HISTORY_KEEP = 24;
  var ACTION_URL = /^\/api\/engine\/daemons\/[a-z0-9][a-z0-9_-]{0,31}\/(start|stop|restart|autostop)$/;

  var T = {
    name: "Pistonia", sub: "Salle des machines", open: "Ouvrir Pistonia", close: "Fermer", clear: "Effacer la conversation",
    placeholder: "Demande-moi quelque chose sur les moteurs…", send: "Envoyer", grip: "Redimensionner la fenêtre",
    thinking: "Pistonia réfléchit…", apply: "Appliquer", dismiss: "Ignorer", done: "Fait", failed: "Échec",
    smaller: "Plus petite", larger: "Plus grande", resetSize: "Taille normale", resetPos: "Position d'origine", resetWin: "Fenêtre normale",
    hide: "Masquer Pistonia", retry: "Réessayer", offline: "Réseau indisponible.", errorGeneric: "Pistonia n'a pas pu répondre.",
    proposal: "Proposition", stopT: "Arrêter", startT: "Démarrer", restartT: "Redémarrer", autoOn: "Arrêt auto activé", autoOff: "Arrêt auto désactivé",
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
  var clearBtn = el("button", "hq-pistonia-hbtn", "↺");
  clearBtn.type = "button"; clearBtn.title = T.clear; clearBtn.setAttribute("aria-label", T.clear);
  var closeBtn = el("button", "hq-pistonia-hbtn", "×");
  closeBtn.type = "button"; closeBtn.title = T.close; closeBtn.setAttribute("aria-label", T.close);
  head.appendChild(clearBtn);
  head.appendChild(closeBtn);
  bubble.appendChild(head);

  var logEl = el("div", "hq-pistonia-log");
  logEl.setAttribute("role", "log");
  logEl.setAttribute("aria-live", "polite");
  bubble.appendChild(logEl);

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
  chip.appendChild(dot);

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
  var history = readJSON(LS_HISTORY, []);
  if (!Array.isArray(history)) history = [];
  var busy = false, greeted = false, typingRow = null, lastText = "";

  function saveHistory() { lsSet(LS_HISTORY, JSON.stringify(history.slice(-HISTORY_KEEP))); }
  function scrollDown() { logEl.scrollTop = logEl.scrollHeight; }

  function addMsg(role, text) {
    var row = el("div", "hq-pistonia-msg is-" + role);
    row.textContent = text;
    logEl.appendChild(row);
    scrollDown();
    return row;
  }

  function describe(p) {
    var verb = { stop: T.stopT, start: T.startT, restart: T.restartT }[p.action];
    if (p.kind === "autostop") return (p.enabled ? T.autoOn + " · " + p.idle_min + " min" : T.autoOff) + " — " + p.label;
    return (verb || p.action) + " — " + p.label;
  }

  function proposalCard(p) {
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
    no.addEventListener("click", function () { card.remove(); });
    ok.addEventListener("click", function () {
      // Only the Engine's own daemon endpoints are ever called, whatever the server sent.
      if (typeof p.url !== "string" || !ACTION_URL.test(p.url)) { status.textContent = T.failed; return; }
      ok.disabled = no.disabled = true;
      status.textContent = "…";
      win.fetch(p.url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p.body || {}) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (r) {
          if (r.ok) { status.textContent = "✓ " + T.done; card.classList.add("is-done"); if (typeof win.hqEngineRefresh === "function") win.hqEngineRefresh(); }
          else { status.textContent = T.failed + (r.data && (r.data.message || r.data.error) ? " : " + String(r.data.message || r.data.error).slice(0, 100) : ""); ok.disabled = no.disabled = false; card.classList.add("is-failed"); }
        })
        .catch(function () { status.textContent = T.offline; ok.disabled = no.disabled = false; });
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
    } else if (typingRow) { typingRow.remove(); typingRow = null; }
  }

  function post(url, body) {
    return win.fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }, function () { return { ok: false, status: r.status, data: {} }; }); });
  }

  function send(text, shown) {
    text = String(text || "").trim();
    if (!text || busy) return;
    lastText = text;
    addMsg("user", shown || text);
    var sent = history.slice(-12).map(function (m) { return { role: m.role, text: m.text }; });
    history.push({ role: "user", text: text });
    saveHistory();
    input.value = "";
    setBusy(true);
    setMood("busy");
    post("/api/engine/pistonia/message", { text: text, history: sent }).then(function (r) {
      setBusy(false);
      if (r.ok && r.data && r.data.reply) {
        addMsg("assistant", r.data.reply);
        history.push({ role: "assistant", text: r.data.reply });
        saveHistory();
        (r.data.proposals || []).forEach(function (p) { logEl.appendChild(proposalCard(p)); });
        scrollDown();
      } else {
        history.pop(); saveHistory();
        showError((r.data && r.data.error) || T.errorGeneric, !!(r.data && r.data.retryable));
      }
      refreshMood();
    }).catch(function () {
      setBusy(false); history.pop(); saveHistory();
      showError(T.offline, true);
      refreshMood();
    });
  }

  function showError(msg, retryable) {
    var row = el("div", "hq-pistonia-msg is-error", msg);
    if (retryable && lastText) {
      var b = el("button", "hq-pistonia-pbtn", T.retry);
      b.type = "button";
      b.addEventListener("click", function () { row.remove(); send(lastText); });
      row.appendChild(b);
    }
    logEl.appendChild(row);
    scrollDown();
  }

  function restore() {
    logEl.textContent = "";
    history.forEach(function (m) { addMsg(m.role === "user" ? "user" : "assistant", m.text); });
  }

  function greet() {
    if (greeted) return;
    greeted = true;
    win.fetch("/api/engine/pistonia/greeting", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (g) { if (g && g.line) { addMsg("assistant", g.line); if (g.mood) setMood(g.mood); } })
      .catch(function () {});
  }

  form.addEventListener("submit", function (ev) { ev.preventDefault(); send(input.value); });
  clearBtn.addEventListener("click", function () { history = []; saveHistory(); logEl.textContent = ""; greeted = false; greet(); });
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
  win.addEventListener("hq:engine-status", function (ev) { lastStatus = ev.detail; refreshMood(); });

  /* ---------------- open / close / visibility ---------------- */
  var isOpen = false;
  function setOpen(on) {
    isOpen = !!on;
    bubble.hidden = !isOpen;
    root.classList.toggle("is-open", isOpen);
    chip.setAttribute("aria-expanded", isOpen ? "true" : "false");
    lsSet(LS_OPEN, isOpen ? "1" : "0");
    if (isOpen) {
      bubble.classList.remove("is-pop");
      void bubble.offsetWidth;
      bubble.classList.add("is-pop");
      layoutBubble();
      if (!logEl.childNodes.length) { restore(); }
      if (!history.length || !greeted) greet();
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
