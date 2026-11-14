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

  /* One tuning table for every spring in the chip. The pull is the reference — it is the only one a
     finger feels while it plays — and the reopening pop, the resize settle and the jump pill are all
     drawn from it: one curve, one overshoot point, and durations that grow with the distance moved.
     Change the numbers here, never at a call site. */
  var MOTION = {
    ease: "cubic-bezier(.2,.85,.3,1)",        // slow off the mark, soft landing: the shared curve
    peak: 0.5,                                // where every overshoot keyframe sits (0..1), and the CSS pop's 50%
    bounce: "cubic-bezier(.2,1.35,.35,1)",    // transitions have no keyframe, so the curve itself carries the overshoot
    chip:   { ms: 200, hoverScale: 1.03, dragScale: 1.06 },     // hover lift, and the grip while dragging
    dot:    { pulseMs: 1100, alertMs: 800, scale: 1.3 },        // the busy / alert pulse behind the chip
    ring:   { ms: 1600 },                                       // the unread-alert ring around the chip
    pull:   { basePx: 6, spanPx: 20, gainPx: 9, baseMs: 300, gainMs: 6, maxMs: 560 },   // by release speed, px/ms
    pop:    { scale: 1.012, ms: 340 },                                                 // reopening the chat
    settle: { scale: 1.012, ms: 240, waitMs: 120 },                                    // a window resize
    pill:   { risePx: 8, spanRise: 12, gainRise: 5, basePx: 1.5, spanPx: 8, gainPx: 3.5,
              baseMs: 220, gainMs: 22, maxMs: 420 },                                   // uncovered by a scroll
    card:   { rise: 12, ms: 260 },                                                     // a proposal card landing
    tip:    { deg: -6, ms: 520 },                                                       // the portrait's greeting
    type:   { cps: 1200 },                                                              // how fast she says a reply
    caret:  { ms: 900 },                                                                // the caret while a reply is streaming
    step:   { ms: 220 },                                                                // a tool step printing itself
    stage:  { ms: 240 }                                                                 // one stage line handing over to the next
  };

  /* One timer, set just past the last hot poll and re-set by the next one: an alert cannot outlive the
     evidence for it, so a paused or closed poller leaves nothing glowing. */
  function armExpiry() {
    if (expireTimer) { win.clearTimeout(expireTimer); expireTimer = 0; }
    if (!Spark.seen) return;
    var left = sparkTtl() - (Date.now() - Spark.seen);
    expireTimer = win.setTimeout(function () { expireTimer = 0; Spark.expire(); }, Math.max(0, left) + 20);
  }

  var T = {
    name: "Pistonia", sub: "Salle des machines", open: "Ouvrir Pistonia", close: "Fermer", clear: "Effacer la conversation",
    placeholder: "Demande-moi quelque chose sur les moteurs…", send: "Envoyer", grip: "Redimensionner la fenêtre",
    thinking: "Pistonia réfléchit…", stop: "Arrêter", today: "Aujourd'hui", yesterday: "Hier",
    apply: "Appliquer", dismiss: "Ignorer", done: "Fait", failed: "Échec",
    smaller: "Plus petite", larger: "Plus grande", resetSize: "Taille normale", resetPos: "Position d'origine", resetWin: "Fenêtre normale",
    hide: "Masquer Pistonia", retry: "Réessayer", offline: "Réseau indisponible.", errorGeneric: "Pistonia n'a pas pu répondre.",
    proposal: "Proposition", noted: "Noté", forget: "Oublier", settings: "Réglages", back: "Retour à la conversation", why: "Pourquoi ?",
    jump: "Dernier message ↓", jumpOne: " nouveau message ↓", jumpMany: " nouveaux messages ↓",
    alertTag: "Alerte de Pistonia", clearTag: "Retour à la normale",
    stale: "relevé ancien",     fold: "Parcours", foldOne: "étape", foldN: "étapes", trace: "Ce qu'elle a lu", copy: "Copier", copied: "Copié", queued: "En attente", drop: "Retirer de la file", sparkLabel: "RAM et VRAM",
    stopped: "Arrêtée.", newMark: "Nouveaux messages", undo: "Annuler", moreLogs: "Les dernières lignes",
    shorter: "Plus court", shortAsk: "Plus court, s'il te plaît : trois phrases au maximum.",
    voiceOn: "Voix activée", voiceOff: "Voix coupée", notes: "Ce qu'elle retient", noNotes: "Rien pour l'instant. Dis-lui une préférence durable, elle la notera.",
    notify: "M'avertir aussi par Discord / notification (alertes de Pistonia)", notifyHint: "Désactivé par défaut. Seules ses alertes partent, jamais le contenu des conversations.",
    clearChat: "Effacer la conversation", alertBadge: "alerte(s) non lue(s)", voiceLabel: "Voix", clearDone: "Conversation effacée.", stopT: "Arrêter", startT: "Démarrer", restartT: "Redémarrer", autoOn: "Arrêt auto activé", autoOff: "Arrêt auto désactivé",
  };

  /* The quick chips follow the engine: the useful tap is the one that matches what is wrong
     right now, so the list is rebuilt from the live status instead of being fixed. */
  var QUICK = {
    trouble: ["Un souci ?", "Is anything wrong?"],
    ram: ["Qui mange ma RAM ?", "What is using the most memory right now?"],
    vram: ["Libère de la VRAM", "Help me free some VRAM."],
    busy: ["Qui travaille ?", "Which engine is busy right now, and for how long?"],
    steady: ["Résume la salle des machines", "Give me the state of the engine room in a few lines."],
    autostop: ["Explique l'arrêt auto", "Explain idle auto-stop and when I should use it."]
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
  /* The CSS half of the same table: the opening pop and the pill's fallback transition read their
     curve and duration from here, so the stylesheet cannot drift from the numbers above. */
  root.style.setProperty("--pis-spring", MOTION.ease);
  root.style.setProperty("--pis-pop-ms", MOTION.pop.ms + "ms");
  root.style.setProperty("--pis-pop-scale", String(MOTION.pop.scale));
  root.style.setProperty("--pis-pill-ms", MOTION.pill.baseMs + "ms");
  root.style.setProperty("--pis-bounce", MOTION.bounce);
  root.style.setProperty("--pis-chip-ms", MOTION.chip.ms + "ms");
  root.style.setProperty("--pis-hover-scale", String(MOTION.chip.hoverScale));
  root.style.setProperty("--pis-drag-scale", String(MOTION.chip.dragScale));
  root.style.setProperty("--pis-dot-ms", MOTION.dot.pulseMs + "ms");
  root.style.setProperty("--pis-dot-alert-ms", MOTION.dot.alertMs + "ms");
  root.style.setProperty("--pis-dot-scale", String(MOTION.dot.scale));
  root.style.setProperty("--pis-ring-ms", MOTION.ring.ms + "ms");
  root.style.setProperty("--pis-step-ms", MOTION.step.ms + "ms");
  root.style.setProperty("--pis-stage-ms", MOTION.stage.ms + "ms");
  root.style.setProperty("--pis-caret-ms", MOTION.caret.ms + "ms");
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
  // A live instrument in the header: RAM and VRAM over the last polls, with the exact numbers on hover.
  var sparkWrap = el("span", "hq-pistonia-sparkwrap");
  sparkWrap.tabIndex = 0;                  // reachable by keyboard too: the readout is the accessible version
  sparkWrap.setAttribute("role", "img");
  sparkWrap.setAttribute("aria-label", T.sparkLabel);
  var spark = el("canvas", "hq-pistonia-spark");
  spark.width = 80;
  spark.height = 28;                       // 2x: drawn at 40x14 CSS px
  spark.setAttribute("aria-hidden", "true");
  var readout = el("div", "hq-pistonia-readout");
  readout.hidden = true;
  sparkWrap.appendChild(spark);
  sparkWrap.appendChild(readout);
  head.appendChild(sparkWrap);
  sparkWrap.addEventListener("mouseenter", function () { Spark.update(); readout.hidden = false; });
  sparkWrap.addEventListener("mouseleave", function () { readout.hidden = true; });
  sparkWrap.addEventListener("focus", function () { Spark.update(); readout.hidden = false; });
  sparkWrap.addEventListener("blur", function () { readout.hidden = true; });
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

  // The thread and the jump pill share a positioned box, so the pill floats over the tail of the
  // conversation: neither its arrival nor its departure takes a row away from the messages.
  var logWrap = el("div", "hq-pistonia-logwrap");
  var logEl = el("div", "hq-pistonia-log");
  logEl.setAttribute("role", "log");
  logEl.setAttribute("aria-live", "polite");
  logWrap.appendChild(logEl);
  bubble.appendChild(logWrap);

  var jumpRow = el("div", "hq-pistonia-jumprow");
  var jumpBtn = el("button", "hq-pistonia-jump", T.jump);
  jumpBtn.type = "button";
  jumpBtn.addEventListener("click", function () { scrollDown(true); });
  jumpRow.appendChild(jumpBtn);
  logWrap.appendChild(jumpRow);

  // The stage line changes every second or so: announced once here, never per change.
  var srStatus = el("span", "hq-pistonia-sr");
  srStatus.setAttribute("role", "status");
  bubble.appendChild(srStatus);

  var panelEl = el("div", "hq-pistonia-settings");
  panelEl.hidden = true;
  bubble.appendChild(panelEl);

  var quick = el("div", "hq-pistonia-quick");
  bubble.appendChild(quick);

  function pickQuick(st) {
    var out = [], ds = (st && st.daemons) || [], s = (st && st.system) || {};
    var bad = null, busy = null;
    ds.forEach(function (d) {
      if (!bad && (d.state === "error" || d.state === "foreign" || d.state === "warn")) bad = d;
      if (!busy && d.state === "busy") busy = d;
    });
    if (bad) {
      var label = String(bad.label || bad.id || "").slice(0, 22);
      out.push(["Que faire pour " + label + " ?", label + " shows " + bad.state + ". What should we do?"]);
    }
    var g = (s.gpus || [])[0];
    if (g && g.vram_total_mb && g.vram_used_mb / g.vram_total_mb >= 0.8) out.push(QUICK.vram);
    if (s.ram_total_mb && s.ram_used_mb && s.ram_used_mb / s.ram_total_mb >= 0.8) out.push(QUICK.ram);
    if (busy) out.push(QUICK.busy);
    [QUICK.trouble, QUICK.ram, QUICK.steady, QUICK.autostop].forEach(function (q) {
      if (out.length < 4 && out.indexOf(q) === -1) out.push(q);
    });
    return out.slice(0, 4);
  }

  var quickSig = "";
  function renderQuick(st) {
    var list = pickQuick(st);
    var sig = list.map(function (q) { return q[0]; }).join("|");
    if (sig === quickSig) return;                     // no reshuffle under a finger for an unchanged state
    quickSig = sig;
    quick.textContent = "";
    list.forEach(function (q) {
      var b = el("button", "hq-pistonia-qbtn", q[0]);
      b.type = "button";
      b.title = q[1];                                 // what she will actually be asked, in her language
      b.addEventListener("click", function () { send(q[1], q[0]); });
      quick.appendChild(b);
    });
  }
  renderQuick(null);

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

  function isPhone() { return win.matchMedia("(max-width: 520px)").matches; }

  /* A full-screen chat owns the page: nothing scrolls behind it, and nothing floats over the
     input — HQ's debug overlay sits at z 120000 by design, so the whole chip is lifted above it
     while the chat is open, then put back. */
  var bodyOverflow = "", rootZ = "", screenLocked = false;
  function lockScreen(on) {
    if (on) {
      if (screenLocked) return;
      bodyOverflow = doc.body.style.overflow;          // usually empty: CSS decides, we put it back verbatim
      rootZ = root.style.zIndex;
      doc.body.style.overflow = "hidden";
      root.style.zIndex = "120001";
      screenLocked = true;
    } else if (screenLocked) {
      doc.body.style.overflow = bodyOverflow;
      root.style.zIndex = rootZ;
      bodyOverflow = ""; rootZ = ""; screenLocked = false;
    }
  }

  /* The on-screen keyboard shrinks the *visual* viewport while the layout viewport keeps its size
     (iOS always, Android with the default viewport behaviour), so a 100dvh sheet would leave the
     composer under the keyboard. Fit the chat to the visible area instead, and keep the thread at
     its bottom if it was already there. */
  var vv = win.visualViewport;
  function fitKeyboard() {
    if (!vv) return;
    if (!isPhone()) {                                  // desktop: layoutBubble owns the height
      bubble.style.transform = ""; bubble.classList.remove("is-keyboard");
      return;
    }
    if (!isOpen) {
      bubble.style.height = ""; bubble.style.transform = ""; bubble.classList.remove("is-keyboard");
      return;
    }
    bubble.style.height = Math.round(vv.height) + "px";
    bubble.style.transform = vv.offsetTop > 0 ? "translateY(" + Math.round(vv.offsetTop) + "px)" : "";
    // The keyboard takes a real bite: the quick replies fold away so the conversation keeps the room.
    bubble.classList.toggle("is-keyboard", vv.height < win.innerHeight - 80);
    if (pinned) scrollDown();
  }
  if (vv) { vv.addEventListener("resize", fitKeyboard); vv.addEventListener("scroll", fitKeyboard); }

  function layoutBubble() {
    if (bubble.hidden) return;
    lockScreen(isOpen && isPhone());                 // also follows a resize across the breakpoint
    if (isPhone()) {
      // On a phone the chat is the screen, not a window beside the chip: no geometry to compute,
      // no corner to grow from, nothing to resize.
      bubble.classList.add("is-full");
      bubble.classList.remove("is-above", "is-right");
      ["width", "height", "left", "right", "top", "bottom", "transform"].forEach(function (k) { bubble.style[k] = ""; });
      fitKeyboard();                                 // the keyboard may already be up
      return;
    }
    bubble.classList.remove("is-full");
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
      if (opts.skipWhenPhone && isPhone()) return;             // full screen: there is no window to move
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
      if (!drag.moved && opts.guard && opts.guard(dx, dy)) { cancelDrag(); return; }   // the chat took the gesture
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
  /* The header is a hinge: pull it *down* and the chat goes away — the sheet on a phone, the
     window everywhere. Any other direction still moves the window, so the first few pixels decide
     which gesture this is; a press that starts on one of the header's buttons is never a swipe. */
  var swiping = false, swipeMode = "", swipeFromX = 0, swipeFromY = 0, swipeFromT = 0, swipeDy = 0;
  var swipeVy = 0, swipeLastY = 0, swipeLastT = 0;        // release speed, in px per ms
  // What sits behind the chat grows darker as it is pulled away: the page reads as the target of
  // the dismissal, not as something being dragged over. It never takes the pointer.
  var scrim = el("div", "hq-pistonia-scrim");
  root.insertBefore(scrim, bubble);
  function dimPull(dy) {
    scrim.style.transition = dy === null ? "" : "none";     // the finger drives it, no easing behind
    scrim.style.opacity = dy === null ? "" : Math.min(0.45, dy / 300).toFixed(3);
  }
  function isPull(dx, dy) { return dy > DRAG_PX && dy > Math.abs(dx); }
  bindDrag(head, { ignore: function (t) { return t.closest && t.closest("button"); }, skipWhenPhone: true, guard: isPull });

  head.addEventListener("pointerdown", function (ev) {
    if (!isOpen || (ev.button && ev.button !== 0)) return;
    if (ev.target.closest && ev.target.closest("button")) return;
    swiping = true; swipeMode = "";
    if (win.getSelection) { try { win.getSelection().removeAllRanges(); } catch (_) {} }
    if (ev.cancelable) ev.preventDefault();                  // no text selection under the pull
    swipeFromX = ev.clientX; swipeFromY = ev.clientY; swipeFromT = ev.timeStamp; swipeDy = 0;
    swipeVy = 0; swipeLastY = ev.clientY; swipeLastT = ev.timeStamp;
  });
  win.addEventListener("pointermove", function (ev) {
    if (!swiping) return;
    var dy = ev.clientY - swipeFromY, dx = ev.clientX - swipeFromX;
    if (!swipeMode) {
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      if (!isPull(dx, dy)) { swiping = false; return; }          // the window drag has it
      swipeMode = "pull";
      bubble.style.transition = "none";                         // the finger drives it, no easing down
      root.classList.remove("is-dragging");
    }
    swipeDy = Math.max(0, dy);
    // Smoothed so a single jittery frame does not decide the bounce, and clamped: past ~3 px/ms
    // the gesture is a flick and closes instead of springing.
    var step = ev.timeStamp - swipeLastT;
    if (swipeLastT && step > 0) swipeVy = Math.max(0, Math.min(3, swipeVy * 0.65 + ((ev.clientY - swipeLastY) / step) * 0.35));
    swipeLastY = ev.clientY; swipeLastT = ev.timeStamp;
    bubble.style.transform = swipeDy ? "translateY(" + swipeDy + "px)" : "";
    dimPull(swipeDy);
  });
  function endSwipe(ev) {
    if (!swiping) return;
    var pull = swipeMode === "pull";
    swiping = false; swipeMode = "";
    if (!pull) return;
    dimPull(null);                                              // fades out over the CSS transition
    var flick = swipeDy > 40 && ev.timeStamp - swipeFromT < 400;
    if (swipeDy > 90 || flick) {
      bubble.style.transition = ""; bubble.style.transform = "";
      setOpen(false); chip.focus(); return;
    }
    // Let go short and it springs back with a small overshoot — it reads as a pull that was released,
    // not a drag that was dropped. The resting offset is written first, so the end state is plain CSS.
    var homePx = isPhone() && vv && vv.offsetTop > 0 ? Math.round(vv.offsetTop) : 0;
    var calm = win.matchMedia && win.matchMedia("(prefers-reduced-motion:reduce)").matches;
    // The harder it was pulled, the further it swings past its place: a nudge barely overshoots,
    // a quick pull rebounds by up to ~20 px, and the bigger swing also takes a little longer.
    var P = MOTION.pull;
    var over = Math.round(P.basePx + Math.min(P.spanPx, swipeVy * P.gainPx));
    var dur = Math.round(Math.min(P.maxMs, P.baseMs + over * P.gainMs));
    bubble.style.transition = "none";
    bubble.style.transform = homePx ? "translateY(" + homePx + "px)" : "";
    if (bubble.animate && !calm) {
      var back = bubble.animate([
        { transform: "translateY(" + swipeDy + "px)" },
        { transform: "translateY(" + (homePx - over) + "px)", offset: MOTION.peak },
        { transform: "translateY(" + homePx + "px)" }
      ], { duration: dur, easing: MOTION.ease });
      back.onfinish = function () { bubble.style.transition = ""; };
    } else {
      bubble.style.transition = "";
    }
  }
  win.addEventListener("pointerup", endSwipe);
  win.addEventListener("pointercancel", endSwipe);

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
    if (isPhone()) return;                                  // full-screen: there is no window to size
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
    recheckBottom();                                                // a wider window may fit the whole thread again
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
  var busy = false, typingRow = null, lastText = "", lastContext = "", lastUserRow = null, view = "chat";
  var lastSubject = "", reaskPending = false;     // the line a "why?" quoted, still the subject of the next question

  /* The thread follows the newest message only while the reader is already at the bottom. Scrolled
     up to re-read something, it stays put (a new line is counted, not yanked into view) and the
     jump row offers the way back. */
  var pinned = true, missed = 0;
  var scrollVy = 0, lastTop = 0, lastTick = 0;     // px/ms, smoothed: how hard he was scrolling when it appeared
  function atBottom() { return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40; }
  /* A live trace of RAM and VRAM in the header. Two polylines, the latest value at the right edge:
     when she says "RAM is at 91 %", he can watch it climb. */
  var SPARK_HOT = 90;                      // a pool this full is already worth seeing
  var SPARK_STREAK = 3;                    // ... and this many polls in a row is a state, not a spike
  var SPARK_GAP = 6;                       // silence worth calling stale: this many polls missed in a row
  var SPARK_TTL_MIN = 30 * 1000, SPARK_TTL_MAX = 180 * 1000;
  var SPARK_TTL_FALLBACK = 90 * 1000;      // before two polls have shown us the cadence
  var expireTimer = 0;
  // The Engine tab decides its own rhythm (4 s idle, 1.5 s while a daemon moves), so we learn it from the
  // events instead of hard-coding it: a fixed deadline would be wrong for one of the two speeds.
  function sparkTtl() {
    if (!Spark.gap) return SPARK_TTL_FALLBACK;
    return Math.max(SPARK_TTL_MIN, Math.min(SPARK_TTL_MAX, Spark.gap * SPARK_GAP));
  }
  var Spark = {
    ram: [], vram: [], max: 30, hot: { ram: 0, vram: 0 }, at: 0, seen: 0, gap: 0,
    push: function (st) {
      var s = (st && st.system) || {}, g = (s.gpus || [])[0] || {};
      var ram = s.ram_total_mb ? Math.round(100 * (s.ram_used_mb || 0) / s.ram_total_mb) : null;
      var vram = g.vram_total_mb ? Math.round(100 * (g.vram_used_mb || 0) / g.vram_total_mb) : null;
      if (ram !== null) { this.ram.push(ram); if (this.ram.length > this.max) this.ram.shift(); }
      if (vram !== null) { this.vram.push(vram); if (this.vram.length > this.max) this.vram.shift(); }
      this.hot.ram = ram !== null && ram >= SPARK_HOT ? this.hot.ram + 1 : 0;
      this.hot.vram = vram !== null && vram >= SPARK_HOT ? this.hot.vram + 1 : 0;
      var now = Date.now();
      if (this.seen) {
        var d = now - this.seen;
        if (d > 200 && d < 120000) this.gap = this.gap ? Math.round(this.gap * 0.7 + d * 0.3) : d;   // smoothed cadence
      }
      this.seen = now;
      this.at = this.hot.ram || this.hot.vram ? this.seen : 0;
      armExpiry();
      this.draw();
      this.update();
    },
    update: function () {
      var ram = this.ram.length ? this.ram[this.ram.length - 1] : null;
      var vram = this.vram.length ? this.vram[this.vram.length - 1] : null;
      var say = function (value) { return value === null ? "—" : value + " %"; };
      readout.textContent = "";
      [["RAM", ram], ["VRAM", vram]].forEach(function (pair) {
        var row = el("span", "hq-pistonia-readout-row");
        row.appendChild(el("span", "hq-pistonia-readout-k", pair[0]));
        row.appendChild(el("span", "hq-pistonia-readout-v" + (pair[1] !== null && pair[1] >= SPARK_HOT ? " is-hot" : ""), say(pair[1])));
        readout.appendChild(row);
      });
      var stale = this.seen && Date.now() - this.seen > sparkTtl();
      sparkWrap.classList.toggle("is-stale", !!stale);      // an old reading must not look like a live one
      var loud = [], streaks = [];
      if (!stale && this.hot.ram >= SPARK_STREAK) { loud.push("RAM"); streaks.push(this.hot.ram); }
      if (!stale && this.hot.vram >= SPARK_STREAK) { loud.push("VRAM"); streaks.push(this.hot.vram); }
      var since = streaks.length ? Math.min.apply(null, streaks) : 0;   // true for every pool named
      var alert = loud.length ? loud.join(" et ") + (loud.length > 1 ? " saturées" : " saturée") + " depuis " + since + " relevés" : "";
      sparkWrap.classList.toggle("is-alert", !!alert);
      if (alert) readout.appendChild(el("span", "hq-pistonia-readout-alert", alert));
      sparkWrap.setAttribute("aria-label", T.sparkLabel + " : RAM " + say(ram) + ", VRAM " + say(vram) +
        (stale ? " — " + T.stale : "") + (alert ? " — " + alert : ""));
    },
    /* No poll renews the alert for long enough: it was a claim about now, and now has moved on. */
    expire: function () {
      if (!this.seen || Date.now() - this.seen <= sparkTtl()) return false;
      this.hot.ram = this.hot.vram = 0;
      this.at = 0;
      this.update();
      return true;
    },
    draw: function () {
      var ctx = spark.getContext && spark.getContext("2d");
      if (!ctx) return;
      var w = spark.width, h = spark.height;
      ctx.clearRect(0, 0, w, h);
      var accent = (win.getComputedStyle(root).getPropertyValue("--pis") || "#f59e0b").trim() || "#f59e0b";
      this.line(ctx, this.ram, w, h, "rgba(255,255,255,.30)", 1);
      this.line(ctx, this.vram, w, h, accent, 1.5);
    },
    line: function (ctx, values, w, h, color, width) {
      if (!values.length) return;
      ctx.beginPath();
      for (var i = 0; i < values.length; i++) {
        var x = values.length === 1 ? w - 2 : (i / (this.max - 1)) * (w - 4) + 2;
        var y = h - 3 - Math.max(0, Math.min(100, values[i])) / 100 * (h - 7);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.stroke();
    }
  };

  function syncJump() {
    var show = !logEl.hidden && !pinned;
    jumpRow.hidden = logEl.hidden;                 // the whole thread is away: no fade to play
    var wasOn = jumpRow.classList.contains("is-on");
    jumpRow.classList.toggle("is-on", show);
    if (show && !wasOn) popJump();                 // hand the entrance over to the speed-aware spring
    // Scrolled back down while the spring was still playing: drop it, or its opacity keyframes would
    // hold the pill visible and it could not retreat.
    if (!show) jumpRow.getAnimations().forEach(function (a) { a.cancel(); });
    jumpRow.setAttribute("aria-hidden", show ? "false" : "true");
    jumpBtn.tabIndex = show ? 0 : -1;              // not a tab stop while it is invisible
    jumpBtn.textContent = missed ? missed + (missed > 1 ? T.jumpMany : T.jumpOne) : T.jump;
  }
  /* A flick past a screenful pulls the pill in harder than a slow drag: the entrance's rise, its
     overshoot and its duration all follow the scroll speed that uncovered it. The CSS transition
     stays as the plain fallback (and is the only path under prefers-reduced-motion). */
  function popJump() {
    if (!jumpRow.animate) return;
    if (win.matchMedia && win.matchMedia("(prefers-reduced-motion:reduce)").matches) return;
    var Q = MOTION.pill;
    var over = Q.basePx + Math.min(Q.spanPx, scrollVy * Q.gainPx);       // px past home
    var rise = Q.risePx + Math.min(Q.spanRise, scrollVy * Q.gainRise);   // where it starts from
    var dur = Math.min(Q.maxMs, Q.baseMs + over * Q.gainMs);             // a bigger hop takes longer
    jumpRow.animate([
      { opacity: 0, transform: "translateY(" + rise.toFixed(1) + "px) scale(.94)" },
      { opacity: 1, transform: "translateY(-" + over.toFixed(1) + "px) scale(" + (1 + over / 100).toFixed(3) + ")", offset: MOTION.peak },
      { opacity: 1, transform: "none" }
    ], { duration: dur, easing: MOTION.ease });
  }
  function scrollDown(force) {
    if (force || pinned) {
      logEl.scrollTop = logEl.scrollHeight;
      pinned = true; missed = 0;
      clearNew();
      scrollVy = 0; lastTick = 0;                  // jumping home is not a gesture the pill should inherit
    }
    syncJump();
  }
  function recheckBottom() {
    if (bubble.hidden) return;
    var t = win.performance ? win.performance.now() : Date.now();
    var dt = t - lastTick, moved = Math.abs(logEl.scrollTop - lastTop);
    if (dt > 0 && dt < 220) scrollVy = scrollVy * 0.6 + Math.min(6, moved / dt) * 0.4;
    lastTop = logEl.scrollTop; lastTick = t;
    pinned = atBottom();
    if (pinned) missed = 0;
    syncJump();
  }
  logEl.addEventListener("scroll", recheckBottom, { passive: true });
  // The thread can also change size without scrolling (window resize, the grip, the keyboard fit):
  // a window that now fits the whole conversation leaves the pill nothing to point at.
  if (win.ResizeObserver) new win.ResizeObserver(recheckBottom).observe(logEl);

  function post(url, body, signal) {
    return win.fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}), signal: signal })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }, function () { return { ok: false, status: r.status, data: {} }; }); });
  }
  function getJSON(url) {
    return win.fetch(url, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); });
  }

  /* ----- when things were said: a day divider, and the hour when the thread resumes after a pause ----- */
  var lastStampDay = null, lastStampAt = 0;
  function two(n) { return (n < 10 ? "0" : "") + n; }
  function clockOf(d) { return two(d.getHours()) + ":" + two(d.getMinutes()); }
  function dayOf(d) {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (day === today) return T.today;
    if (day === today - 86400000) return T.yesterday;
    return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  }
  function stamp(at) {
    if (!at) return;
    var d = new Date(at * 1000);
    var key = d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
    if (key !== lastStampDay) {
      lastStampDay = key; lastStampAt = at;
      logEl.appendChild(el("div", "hq-pistonia-stamp is-day", dayOf(d) + " · " + clockOf(d)));
      return;
    }
    if (at - lastStampAt >= 600) {            // a ten-minute pause: worth a time, not the date
      lastStampAt = at;
      logEl.appendChild(el("div", "hq-pistonia-stamp", clockOf(d)));
    }
  }

  /* ----- one message (chat / alert / all-clear / greeting) with its proposal cards and remembered notes ----- */
  var newMark = null;                                  // the "new messages" line, while he reads further up
  function clearNew() {
    if (newMark) { newMark.remove(); newMark = null; }
  }
  function addMsg(role, text, kind, at) {
    stamp(at);
    if (!pinned && !newMark) {                         // what arrived while he was away starts below this line
      newMark = el("div", "hq-pistonia-newmark");
      newMark.appendChild(el("span", null, T.newMark));
      logEl.appendChild(newMark);
    }
    var row = el("div", "hq-pistonia-msg is-" + role + (kind && kind !== "chat" ? " is-" + kind : ""));
    if (kind === "alert") row.appendChild(el("span", "hq-pistonia-msg-tag", "⚠"));
    if (kind === "clear") row.appendChild(el("span", "hq-pistonia-msg-tag", "✓"));
    row.appendChild(doc.createTextNode(text));
    logEl.appendChild(row);
    if (!pinned) missed += 1;                          // arrived while he was reading further up
    scrollDown();
    return row;
  }

  /* The reply lands whole; she still says it. Text arrives at speech-ish speed with the rest of the row
     (trace, chips, cards) following it, which is what makes an answer read as spoken rather than dumped. */
  function typeInto(row, text, done) {
    var calm = win.matchMedia && win.matchMedia("(prefers-reduced-motion:reduce)").matches;
    if (calm || !win.requestAnimationFrame) {
      row.appendChild(doc.createTextNode(text));
      if (done) done();
      return;
    }
    var node = doc.createTextNode("");
    row.appendChild(node);
    var started = 0, perMs = MOTION.type.cps / 1000;
    var step = function (t) {
      if (!started) started = t;
      var n = Math.min(text.length, Math.round((t - started) * perMs) + 1);
      node.nodeValue = text.slice(0, n);
      if (pinned) logEl.scrollTop = logEl.scrollHeight;   // it grows: follow it, unless he scrolled away
      if (n < text.length) win.requestAnimationFrame(step);
      else if (done) done();
    };
    win.requestAnimationFrame(step);
  }

  /* One spring for anything that lands in the thread, so a card arrives like everything else does. */
  function springIn(node, rise) {
    if (!node || !node.animate) return;
    if (win.matchMedia && win.matchMedia("(prefers-reduced-motion:reduce)").matches) return;
    var M = MOTION.card;
    node.animate([
      { opacity: 0, transform: "translateY(" + (rise || M.rise) + "px) scale(.985)" },
      { opacity: 1, transform: "translateY(-2px)", offset: MOTION.peak },
      { opacity: 1, transform: "none" }
    ], { duration: M.ms, easing: MOTION.ease });
  }

  /* She tips her head when the chat opens: one small gesture that makes the entrance hers. */
  function tipPortrait() {
    if (!headImg.animate) return;
    if (win.matchMedia && win.matchMedia("(prefers-reduced-motion:reduce)").matches) return;
    headImg.animate([
      { transform: "rotate(" + MOTION.tip.deg + "deg) scale(.96)" },
      { transform: "rotate(1.5deg) scale(1.02)", offset: MOTION.peak },
      { transform: "none" }
    ], { duration: MOTION.tip.ms, easing: MOTION.ease });
  }

  function renderMessage(m, typed, after) {
    state.shown[m.id] = true;
    state.lastId = m.id;
    var row = addMsg(m.role, typed ? "" : m.text, m.kind, m.at);
    if (typed && m.text) typeInto(row, m.text, function () { decorate(row, m, true); if (after) after(row); });
    else { decorate(row, m, false); if (after) after(row); }
    return row;
  }

  /* The wait is part of the answer: the steps she went through fold into one line under the reply when it lands, instead of
     vanishing with the waiting row. Closed by default — the answer is the answer; the path is there if he wants it. */
  function foldSteps(row) {
    var steps = turnSteps.filter(function (s) { return stepSay(s); });
    if (steps.length < 2 || !row || !row.parentNode) return;
    var det = doc.createElement("details");
    det.className = "hq-pistonia-fold";
    var sum = doc.createElement("summary");
    sum.className = "hq-pistonia-fold-sum";
    sum.textContent = T.fold + " · " + steps.length + " " + (steps.length > 1 ? T.foldN : T.foldOne);
    det.appendChild(sum);
    var list = el("div", "hq-pistonia-fold-list");
    steps.forEach(function (s) {
      var line = el("span", "hq-pistonia-step");
      line.appendChild(doc.createTextNode(stepSay(s)));
      if (stepFound(s)) line.appendChild(el("span", "hq-pistonia-step-found", " — " + stepFound(s)));
      list.appendChild(line);
    });
    det.appendChild(list);
    logEl.insertBefore(det, row.nextSibling);          // under the answer, above anything decorate appended
  }

  function decorate(row, m, fresh) {
    // An alert or an all-clear is a claim about the machines too: it earns the same "why?" as a card.
    if (m.kind === "alert" || m.kind === "clear") {
      var wrap = el("div", "hq-pistonia-why-row");
      wrap.appendChild(whyButton((m.kind === "clear" ? T.clearTag : T.alertTag) + " : " + String(m.text || "").replace(/\s+/g, " ").trim()));
      row.appendChild(wrap);
    }
    if (m.role === "assistant" && m.text && m.kind !== "greeting") {
      var tools = el("div", "hq-pistonia-msg-tools");
      tools.appendChild(copyButton(m.text));
      row.appendChild(tools);
      if (m.kind === "chat") row.appendChild(answersRow(m));   // follow-ups that belong to this answer
    }
    if (m.trace && m.trace.length) row.appendChild(traceBlock(m.trace));
    (m.remembered || []).forEach(function (n) { logEl.appendChild(noteLine(n)); });
    (m.proposals || []).forEach(function (p) {
      var card = proposalCard(p, m.id);
      logEl.appendChild(card);
      if (fresh) springIn(card);
    });
  }

  /* One re-ask, with whatever she said quoted back, so a two-word question has a referent on her side. */
  function whyButton(context) {
    var why = el("button", "hq-pistonia-link hq-pistonia-why", T.why);
    why.type = "button";
    why.title = T.why + " — " + String(context).slice(0, 90);
    why.addEventListener("click", function () { send(T.why, T.why, String(context).slice(0, 400)); });
    return why;
  }

  /* What she actually read, folded away: every claim in the reply can be traced back to a tool call. */
  function traceBlock(trace) {
    var box = el("details", "hq-pistonia-trace");
    box.appendChild(el("summary", null, T.trace + " (" + trace.length + ")"));
    var ul = el("ul", "hq-pistonia-trace-list");
    trace.forEach(function (t) {
      ul.appendChild(el("li", null, String(t && (t.label || t.tool) || "")));
    });
    box.appendChild(ul);
    return box;
  }

  function copyButton(text) {
    var b = el("button", "hq-pistonia-link hq-pistonia-copy", T.copy);
    b.type = "button";
    b.addEventListener("click", function () {
      var done = function () {
        b.textContent = T.copied;
        win.setTimeout(function () { b.textContent = T.copy; }, 1200);
      };
      var fallback = function () {                                     // older engines: a hidden field and execCommand
        var ta = el("textarea", "hq-pistonia-offscreen");
        ta.value = text;
        bubble.appendChild(ta);
        ta.select();
        try { if (doc.execCommand("copy")) done(); } catch (_) {}
        ta.remove();
      };
      if (win.navigator.clipboard && win.navigator.clipboard.writeText) win.navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    });
    return b;
  }

  /* Follow-ups that belong to THIS answer, not to the engine status: the question he is most likely to ask next. */
  function answerChips(m) {
    if (!m || m.role !== "assistant" || !m.text) return [];
    var text = String(m.text), low = text.toLowerCase(), ctx = text.slice(0, 400), out = [];
    if (m.proposals && m.proposals.length) {
      out.push([T.why, T.why]);
      out.push([T.shorter, T.shortAsk]);
      return out;
    }
    if (/log|journal|erreur|error|trace|stack/.test(low)) out.push([T.moreLogs, "Montre-moi les dernières lignes de journal, s'il te plaît."]);
    if (/vram|gpu/.test(low)) out.push(QUICK.ram);
    out.push([T.shorter, T.shortAsk]);
    out.push([T.why, T.why]);
    return out.slice(0, 3).map(function (c) { return [c[0], c[1], ctx]; });
  }

  function answersRow(m) {
    var chips = answerChips(m), row = el("div", "hq-pistonia-chips");
    chips.forEach(function (c) {
      var b = el("button", "hq-pistonia-chipbtn", c[0]);
      b.type = "button";
      b.addEventListener("click", function () { send(c[1], c[0], c[2]); });   // c[2]: this answer stays the subject for one turn
      row.appendChild(b);
    });
    return row;
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

  /* The card the Master is asking about, quoted back so a two-word "why?" has a referent on her side. */
  function cardContext(p) {
    var bits = [T.proposal + " : " + describe(p)];
    if (p.reason) bits.push("raison : " + p.reason);
    if (p.impact) bits.push("impact : " + p.impact);
    if (p.id) bits.push("cible : " + p.id + (p.action ? " · " + p.action : ""));
    return bits.join(" · ").slice(0, 400);
  }

  /* The inverse of an applied daemon action. Restart has none, so it offers nothing rather than a half-undo. */
  function undoFor(p) {
    var back = { start: "stop", stop: "start" }[p.action];
    if (!back || p.kind !== "daemon" || !p.id) return null;
    return { url: "/api/engine/daemons/" + p.id + "/" + back, label: T.undo + " — " + (back === "start" ? T.startT : T.stopT) + " " + p.label };
  }

  function undoButton(inv, status) {
    var b = el("button", "hq-pistonia-pbtn", inv.label);
    b.type = "button";
    b.addEventListener("click", function () {
      if (!ACTION_URL.test(inv.url)) return;                   // same allow-list as Apply, whatever we built here
      b.disabled = true;
      status.textContent = "…";
      post(inv.url, {}).then(function (r) {
        if (r.ok) {
          status.textContent = "✓ " + T.done;
          b.remove();
          if (typeof win.hqEngineRefresh === "function") win.hqEngineRefresh();
        } else {
          status.textContent = T.failed + (r.data && (r.data.message || r.data.error) ? " : " + String(r.data.message || r.data.error).slice(0, 100) : "");
          b.disabled = false;
        }
      }).catch(function () { status.textContent = T.offline; b.disabled = false; });
    });
    return b;
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
    bar.appendChild(ok); bar.appendChild(no); bar.appendChild(whyButton(cardContext(p))); bar.appendChild(status);
    card.appendChild(bar);
    var resolve = function () { if (msgId) post("/api/engine/pistonia/resolve", { id: msgId }); };
    no.addEventListener("click", function () { card.remove(); resolve(); });
    ok.addEventListener("click", function () {
      // Only the Engine's own daemon endpoints are ever called, whatever the server sent.
      if (typeof p.url !== "string" || !ACTION_URL.test(p.url)) { status.textContent = T.failed; return; }
      ok.disabled = no.disabled = true;
      status.textContent = "…";
      post(p.url, p.body || {}).then(function (r) {
        if (r.ok) {
          status.textContent = "✓ " + T.done;
          card.classList.add("is-done");
          card.classList.add("is-ok");                            // the border flashes: the commit is visible
          ok.textContent = "✓";
          ok.setAttribute("aria-label", T.done);
          resolve();
          if (typeof win.hqEngineRefresh === "function") win.hqEngineRefresh();
          var inv = undoFor(p);
          if (inv) {
            var un = undoButton(inv, status);
            bar.appendChild(un);                                  // a quick Apply is not a one-way door
            springIn(un, 6);                                      // and the way back slides in behind it
          }
        }
        else { status.textContent = T.failed + (r.data && (r.data.message || r.data.error) ? " : " + String(r.data.message || r.data.error).slice(0, 100) : ""); ok.disabled = no.disabled = false; card.classList.add("is-failed"); }
      }).catch(function () { status.textContent = T.offline; ok.disabled = no.disabled = false; });
    });
    return card;
  }

  var stageEl = null, stageBox = null, stageGhost = null, ghostTimer = 0;
  var stepsEl = null, stageTimer = 0, stageJob = "", sendAbort = null;
  var stepsShown = 0, lastStep = "", streamRow = null, turnSteps = [];

  function dropGhost() {
    if (ghostTimer) { win.clearTimeout(ghostTimer); ghostTimer = 0; }
    if (stageGhost && stageGhost.parentNode) stageGhost.parentNode.removeChild(stageGhost);
    stageGhost = null;
  }

  /* A new stage hands over to the old one instead of replacing it mid-blink: the outgoing line stays in the same
     grid cell, fading out while the new one fades in — one thought continuing, not a label being swapped. */
  function sayStage(text) {
    if (!stageEl || !text || stageEl.textContent === text) return;
    if (win.matchMedia && win.matchMedia("(prefers-reduced-motion:reduce)").matches) {
      dropGhost();
      stageEl.textContent = text;
      stageEl.style.opacity = "";
      return;
    }
    dropGhost();
    var ghost = stageEl.cloneNode(true);
    ghost.classList.add("is-ghost");
    ghost.setAttribute("aria-hidden", "true");
    stageBox.insertBefore(ghost, stageEl);
    stageGhost = ghost;
    ghost.style.opacity = "1";
    stageEl.textContent = text;
    // the incoming line starts hidden with no transition (it may still be at 1 from the last handover), then fades in
    stageEl.style.transition = "none";
    stageEl.style.opacity = "0";
    void stageBox.offsetHeight;                       // one layout: both ends are real starting points, so it transitions
    stageEl.style.transition = "";
    ghost.style.opacity = "0";
    stageEl.style.opacity = "1";
    ghostTimer = win.setTimeout(dropGhost, MOTION.stage.ms + 80);
  }
  var pending = [];                                  // typed while she answers: it waits its turn instead of vanishing

  /* The steps she has already been through, kept above the current one: the wait shows its own history. */
  /* A step is {say, found}: the label she is at, and what it came back with ("Journal de Forge — 20 lignes"). Older servers
     sent bare strings, so both shapes are read. */
  function stepSay(s) { return typeof s === "string" ? s : (s && s.say) || ""; }
  function stepFound(s) { return typeof s === "string" ? "" : (s && s.found) || ""; }
  function stepKey(s) { return stepSay(s) + "\u0001" + stepFound(s); }

  /* The steps are appended, never rebuilt: a line that is already printed must not blink back into place on the
     next poll, and each new one prints once (CSS animates the insertion). The server keeps the last eight, so when
     its window slides we re-sync instead of duplicating. */
  function renderSteps(steps) {
    if (!typingRow || !stageEl) return;
    turnSteps = (steps || []).slice();                 // the whole path, kept for the folded summary
    var past = (steps || []).slice(0, -1);
    if (!past.length) return;                         // one step only: the single stage line says it all
    if (!stepsEl) {
      stepsEl = el("div", "hq-pistonia-steps");
      stepsEl.setAttribute("aria-hidden", "true");     // the live region above already announces the current one
      typingRow.insertBefore(stepsEl, stageBox);
    }
    if (past.length < stepsShown) {
      stepsEl.textContent = "";               // a new turn, or the server lost its steps: start the list again
      stepsShown = 0;
    } else if (stepsShown && stepKey(past[stepsShown - 1]) !== lastStep) {
      // The server only keeps the last eight, so its window slid: drop the lines that fell off the head instead of
      // reprinting the whole list (that would re-animate seven lines every poll).
      var over = past.length - stepsShown + 1;
      for (var d = 0; d < over && stepsEl.firstChild; d++) stepsEl.removeChild(stepsEl.firstChild);
      stepsShown = stepsEl.childNodes.length;
    }
    for (var i = stepsShown; i < past.length; i++) {
      var node = el("span", "hq-pistonia-step");
      node.appendChild(doc.createTextNode(stepSay(past[i])));
      if (stepFound(past[i])) node.appendChild(el("span", "hq-pistonia-step-found", " — " + stepFound(past[i])));
      stepsEl.appendChild(node);
    }
    stepsShown = past.length;
    lastStep = stepKey(past[past.length - 1]);
    scrollDown();                                     // respects the pin: never drags him back while he reads up
  }

  function enqueue(text, context) {
    if (pending.length >= 3) { input.value = text; return; }   // three is enough of a queue: the rest waits in the box
    var row = el("div", "hq-pistonia-msg is-user is-pending");
    row.appendChild(el("span", "hq-pistonia-msg-tag", T.queued));
    row.appendChild(doc.createTextNode(text));
    var x = el("button", "hq-pistonia-link hq-pistonia-drop", "✕");
    x.type = "button";
    x.title = T.drop;
    x.setAttribute("aria-label", T.drop + " : " + text.slice(0, 60));
    x.addEventListener("click", function () {
      pending = pending.filter(function (p) { return p.row !== row; });
      row.remove();
    });
    row.appendChild(x);
    logEl.appendChild(row);
    pending.push({ text: text, context: context || "", row: row });
    input.value = "";
    scrollDown();
  }

  function flushQueue() {
    if (busy || !pending.length) return;
    var p = pending.shift();
    if (p.row) p.row.remove();
    send(p.text, null, p.context);
  }

  function setBusy(on) {
    busy = on;
    // The send button stays enabled: while she answers, a message is queued instead of lost — and a disabled submit
    // button is also what silently swallowed Enter in the first place.
    sendBtn.disabled = false;
    root.querySelectorAll(".hq-pistonia-why").forEach(function (b) { b.disabled = on; });   // one question at a time
    if (on) {
      stepsEl = null;
      stepsShown = 0;
      lastStep = "";
      turnSteps = [];
      dropGhost();
      stageBox = null;
      typingRow = el("div", "hq-pistonia-msg is-assistant is-typing");
      for (var i = 0; i < 3; i++) typingRow.appendChild(el("i"));
      // What she is doing, in her words, instead of three dots and silence while she reads a log.
      stageEl = el("span", "hq-pistonia-stage", T.thinking);
      stageEl.setAttribute("aria-live", "off");
      // a grid cell so the outgoing line can sit exactly on top of the incoming one for the crossfade
      stageBox = el("span", "hq-pistonia-stagebox");
      stageBox.appendChild(stageEl);
      typingRow.appendChild(stageBox);
      var stop = el("button", "hq-pistonia-link hq-pistonia-stop", T.stop);
      stop.type = "button";
      stop.title = T.stop;
      stop.addEventListener("click", abortSend);
      typingRow.appendChild(stop);
      logEl.appendChild(typingRow);
      srStatus.textContent = T.thinking;         // announced once, not on every stage change
      scrollDown();
    } else {
      if (stageTimer) { win.clearInterval(stageTimer); stageTimer = 0; }
      if (typingRow) { typingRow.remove(); typingRow = null; }
      stageEl = null;
      stepsEl = null;
      stepsShown = 0;
      lastStep = "";
      dropGhost();
      stageBox = null;
      srStatus.textContent = "";
      renderQuick(lastStatus);                      // the engine may have moved while she was answering
      if (isOpen && view === "chat") input.focus({ preventScroll: true });
    }
  }

  /* The model loop runs server-side for a few seconds: ask her own progress channel what she is at. */
  function watchStage(job) {
    stageJob = job;
    if (stageTimer) win.clearInterval(stageTimer);
    stageTimer = win.setInterval(function () {
      if (document.hidden || !busy) return;
      getJSON("/api/engine/pistonia/progress?job=" + encodeURIComponent(job)).then(function (r) {
        if (job !== stageJob || !stageEl) return;
        if (!r.ok || !r.data) return;
        if (typeof r.data.stage === "string" && r.data.stage) {
          sayStage(r.data.stage + (r.data.found ? " — " + r.data.found : ""));   // what this step came back with
        }
        renderSteps(r.data.steps);
      }).catch(function () {});
    }, 700);
  }

  /* Arrêter now means stop: the server drops the turn at its next step and stores nothing, so a dismissed answer
     never turns up later in the thread. (A round already written when the cancel lands is the one exception, and
     the chip would simply show it like any other reply.) */
  function abortSend() {
    if (!busy) return;
    var job = stageJob;
    stageJob = "";
    if (job) post("/api/engine/pistonia/cancel", { job: job });
    if (sendAbort) { try { sendAbort.abort(); } catch (_) {} sendAbort = null; }
    if (streamRow && streamRow.parentNode) streamRow.parentNode.removeChild(streamRow);   // half a sentence is not a reply
    streamRow = null;
    setBusy(false);
    addMsg("assistant", T.stopped);
    refreshMood();
    flushQueue();
  }

  function send(text, shown, context) {
    text = String(text || "").trim();
    if (!text) return;
    if (busy) { enqueue(text, context); return; }       // typed while she is answering: it waits its turn
    if (view !== "chat") showView("chat");
    stopVoice();
    lastText = text;
    // A "why?" leaves the line it quoted as the subject: the next plain question keeps referring to it
    // instead of needing to quote the card again. One turn only, so a change of topic is not haunted by it.
    if (context) { lastSubject = String(context); reaskPending = true; }
    else if (reaskPending) { context = lastSubject; reaskPending = false; }
    lastContext = String(context || "");
    scrollDown(true);                              // his own line: always shown, whatever he was reading
    lastUserRow = addMsg("user", shown || text, null, Date.now() / 1000);
    input.value = "";
    setBusy(true);
    setMood("busy");
    var job = "job-" + Math.random().toString(36).slice(2, 10);
    watchStage(job);
    streamRow = null;
    sendAbort = new win.AbortController();
    var body = lastContext ? { text: text, job: job, context: lastContext } : { text: text, job: job };
    var settled = false;

    /* One answer, two transports: the stream when the bridge offers it, the JSON POST plus the typewriter otherwise. */
    function finish(r) {
      if (settled) return;
      settled = true;
      sendAbort = null;
      setBusy(false);
      if (r.ok && r.data && r.data.reply) {
        var m = { id: r.data.id || ("local-" + Date.now()), role: "assistant", text: r.data.reply, kind: "chat",
                  proposals: r.data.proposals, remembered: r.data.remembered, trace: r.data.trace };
        if (streamRow) {
          // Already on screen, word by word: keep that row and hang the rest of the answer on it.
          var row = streamRow;
          streamRow = null;
          row.classList.remove("is-streaming");
          row.textContent = m.text;                    // the stored text, whatever the stream ended on
          state.shown[m.id] = true;
          state.lastId = m.id;
          decorate(row, m, true);
          foldSteps(row);
          scrollDown();
        } else {
          renderMessage(m, true, foldSteps);           // the fallback says it, the typewriter reveals it
        }
        (r.data.remembered || []).forEach(function (n) { state.notes.push(n); });
        speak(r.data.reply);
      } else if (r.data && r.data.cancelled) {
        dropLiveRow();
        addMsg("assistant", T.stopped);                        // the cancel beat the reply: nothing was stored
      } else {
        dropLiveRow();
        showError((r.data && r.data.error) || T.errorGeneric, !!(r.data && r.data.retryable));
      }
      refreshMood();
      flushQueue();
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      sendAbort = null;
      if (err && err.name === "AbortError") return;          // the Master pressed Arrêter
      dropLiveRow();
      setBusy(false);
      showError(T.offline, true);
      refreshMood();
      flushQueue();
    }

    function postJSON() {
      post("/api/engine/pistonia/message", body, sendAbort ? sendAbort.signal : undefined).then(finish).catch(fail);
    }

    if (canStream()) {
      streamTurn(body, sendAbort.signal).then(function (r) {
        if (r === null) { postJSON(); return; }       // an older bridge or a refused stream: nothing was consumed
        finish(r);
      }).catch(fail);
    } else postJSON();
  }

  /* ----- the reply as she writes it -------------------------------------------------------------------------------- */
  function canStream() {
    return !!(win.fetch && win.ReadableStream && win.TextDecoder);
  }

  function dropLiveRow() {
    if (streamRow && streamRow.parentNode) streamRow.parentNode.removeChild(streamRow);
    streamRow = null;
  }

  /* The answer while it is still being written: one row, its text replaced by each delta (so a reset needs no undo) and
     a caret at the end. The waiting row goes away with the first word: she is no longer looking things up. */
  function liveText(text) {
    if (!text) { dropLiveRow(); return; }
    if (!streamRow) {
      if (typingRow && typingRow.parentNode) typingRow.parentNode.removeChild(typingRow);
      typingRow = null;
      stageEl = null;
      stepsEl = null;
      stageBox = null;
      dropGhost();
      streamRow = addMsg("assistant", "");
      streamRow.classList.add("is-streaming");
    }
    streamRow.textContent = text;
    scrollDown();
  }


  /* Returns null when the bridge does not stream (404, an older build, a non event-stream answer): the caller then falls
     back to .../message. Anything it read before giving up has already been shown, which is why it only gives up before
     the first frame. */
  function streamTurn(body, signal) {
    var Stream = win.HqPistoniaStream;
    if (!Stream || !Stream.Feed) return Promise.resolve(null);   // the reader did not load: .../message still answers
    return win.fetch("/api/engine/pistonia/stream", {
      method: "POST", credentials: "same-origin", signal: signal, cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }).then(function (res) {
      var type = (res.headers && res.headers.get("content-type")) || "";
      if (!res.ok || !res.body || type.indexOf("text/event-stream") < 0) return null;
      var reader = res.body.getReader(), dec = new win.TextDecoder(), feed = new Stream.Feed(), out = null;
      function pump() {
        return reader.read().then(function (step) {
          if (step.done) return out || { ok: false, data: { error: T.errorGeneric, retryable: true } };
          var events = feed.push(dec.decode(step.value, { stream: true })), i, ev;
          for (i = 0; i < events.length; i++) {
            ev = events[i];
            if (ev.type === "delta") liveText(ev.text || "");
            else if (ev.type === "reset") liveText("");
            else if (ev.type === "done") out = { ok: true, data: ev };
            else if (ev.type === "error") out = { ok: false, data: ev };
          }
          return pump();
        });
      }
      return pump();
    });
  }

  function showError(msg, retryable) {
    var row = el("div", "hq-pistonia-msg is-error", msg);
    if (retryable && lastText) {
      var b = el("button", "hq-pistonia-pbtn", T.retry);
      b.type = "button";
      b.addEventListener("click", function () { row.remove(); var t = lastText, c = lastContext;
        if (lastUserRow && lastUserRow.parentNode) lastUserRow.remove();      // exactly his line, never "whatever is last"
        lastUserRow = null;
        send(t, null, c); });
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
        lastStampDay = null; lastStampAt = 0;
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
  /* Her voice, visible: an analyser on the very element that plays it drives --pis-level, so the dot and
     the portrait move with what she is saying. Without WebAudio she simply stays still. */
  var actx = null, meterSrc = null, meterRaf = 0, levels = 0;
  function level(v) {
    v = Math.max(0, Math.min(1, v || 0));
    root.style.setProperty("--pis-level", v.toFixed(3));
  }
  /* The first gesture opens the audio context, not the first reply: a context created outside one is
     blocked, and her voice would stay silent (and warn) for the whole session. */
  function primeAudio() {
    try {
      actx = actx || new (win.AudioContext || win.webkitAudioContext)();
      if (actx && actx.state === "suspended" && actx.resume) actx.resume();
    } catch (_) {}
  }
  doc.addEventListener("pointerdown", primeAudio, { passive: true });
  doc.addEventListener("keydown", primeAudio, { passive: true });

  function meter(a) {
    var Ctx = win.AudioContext || win.webkitAudioContext;
    if (!Ctx) return;
    try {
      if (!actx) primeAudio();          // never create a context outside a gesture: it would only warn
      if (!actx) return;
      if (meterSrc) { try { meterSrc.disconnect(); } catch (_) {} meterSrc = null; }
      meterSrc = actx.createMediaElementSource(a);
      var an = actx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.75;
      meterSrc.connect(an);
      an.connect(actx.destination);
      var buf = new Uint8Array(an.frequencyBinCount);
      if (meterRaf) win.cancelAnimationFrame(meterRaf);
      var tick = function () {
        if (audio !== a) { level(0); return; }
        an.getByteFrequencyData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) sum += buf[i];
        level(sum / buf.length / 140);
        meterRaf = win.requestAnimationFrame(tick);
      };
      meterRaf = win.requestAnimationFrame(tick);
    } catch (_) { level(0); }                          // no WebAudio: silence, not an error
  }
  function stopVoice() {
    voiceSeq++;
    level(0);
    if (meterRaf) { win.cancelAnimationFrame(meterRaf); meterRaf = 0; }
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
        meter(a);
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
    syncJump();
    gearBtn.setAttribute("aria-pressed", chat ? "false" : "true");
    gearBtn.title = chat ? T.settings : T.back;
    gearBtn.textContent = chat ? "⚙" : "←";
    gearBtn.setAttribute("aria-label", chat ? T.settings : T.back);
    if (!chat) renderSettings(); else { scrollDown(true); input.focus({ preventScroll: true }); }
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
    Spark.push(ev.detail);
    refreshMood();
    if (!busy && view === "chat" && !quick.hidden) renderQuick(lastStatus);
    var ps = (ev.detail && ev.detail.pistonia) || {}, un = ps.unseen || 0;
    if (isOpen) { if (state.loaded && ps.last && !state.shown[ps.last] && !busy) loadThread(false); }   // she spoke first: show it (and read it)
    else setUnseen(un);
  });

  /* ---------------- open / close / visibility ---------------- */
  var isOpen = false;
  function setOpen(on) {
    isOpen = !!on;
    if (!isOpen) { stopVoice(); fitKeyboard(); }    // closed: the fitted height is not ours to keep
    bubble.hidden = !isOpen;
    root.classList.toggle("is-open", isOpen);
    lockScreen(isOpen && isPhone());
    chip.setAttribute("aria-expanded", isOpen ? "true" : "false");
    lsSet(LS_OPEN, isOpen ? "1" : "0");
    if (isOpen) {
      bubble.classList.remove("is-pop");
      void bubble.offsetWidth;
      bubble.classList.add("is-pop");
      tipPortrait();
      layoutBubble();
      showView("chat");
      loadThread(true);
      win.setTimeout(function () { input.focus({ preventScroll: true }); scrollDown(true); }, 30);
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
    else if (isOpen) { bubble.hidden = true; root.classList.remove("is-open"); lockScreen(false); isOpen = false; }
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
  /* A resize lands the chat on a new box (clamped height, new edge): a short spring settles it
     there instead of jumping. Debounced so dragging the browser's edge does not retrigger it per
     step, and skipped while a pull is under way so the two never fight over the transform. */
  var settleTimer = 0;
  function settleSpring() {
    if (bubble.hidden || swiping || !bubble.animate) return;
    if (win.matchMedia && win.matchMedia("(prefers-reduced-motion:reduce)").matches) return;
    var S = MOTION.settle, base = bubble.style.transform ? bubble.style.transform + " " : "";
    bubble.animate([
      { transform: base + "scale(1)" },
      { transform: base + "scale(" + S.scale + ")", offset: MOTION.peak },
      { transform: base + "scale(1)" }
    ], { duration: S.ms, easing: MOTION.ease });
  }
  win.addEventListener("resize", function () {
    place(); recheckBottom();
    win.clearTimeout(settleTimer);
    settleTimer = win.setTimeout(settleSpring, MOTION.settle.waitMs);
  });
  syncVisible();
})();
