/* Transfert HQ — Else image chip + speech bubble (sister of Transferania). No Live2D. */
(function () {
  "use strict";

  const PORTRAIT = "/assets/companion/else-chip.webp";
  const PORTRAIT_2X = "/assets/companion/else-chip@2x.webp";
  // Chip renders at 120–136 CSS px: 208 px covers 1x–1.5x, 416 px covers 2x–3x.
  // The 1280 px masters (else-chip-body.jpg, else-chip-breast-*.png) are sources only.
  const PORTRAIT_BODY = "/assets/companion/else-chip-body@1x.jpg";
  const PORTRAIT_BODY_2X = "/assets/companion/else-chip-body@2x.jpg";
  const BUST_LEFT = "/assets/companion/else-chip-breast-left@1x.png";
  const BUST_LEFT_2X = "/assets/companion/else-chip-breast-left@2x.png";
  const BUST_RIGHT = "/assets/companion/else-chip-breast-right@1x.png";
  const BUST_RIGHT_2X = "/assets/companion/else-chip-breast-right@2x.png";
  const PORTRAIT_BY_MOOD = {
    // Idle uses underpainted body + live bust layers.
    idle: { src: PORTRAIT_BODY, srcset: PORTRAIT_BODY + " 1x, " + PORTRAIT_BODY_2X + " 2x", bust: true },
    listening: {
      src: "/assets/companion/else-chip-listening.webp",
      srcset: "/assets/companion/else-chip-listening.webp 1x, /assets/companion/else-chip-listening@2x.webp 2x",
    },
    speaking: {
      src: "/assets/companion/else-chip-speaking.webp",
      srcset: "/assets/companion/else-chip-speaking.webp 1x, /assets/companion/else-chip-speaking@2x.webp 2x",
    },
    proactive: {
      src: "/assets/companion/else-chip-proactive.webp",
      srcset: "/assets/companion/else-chip-proactive.webp 1x, /assets/companion/else-chip-proactive@2x.webp 2x",
    },
    sister: {
      src: "/assets/companion/else-chip-sister.webp",
      srcset: "/assets/companion/else-chip-sister.webp 1x, /assets/companion/else-chip-sister@2x.webp 2x",
    },
    busy: {
      src: "/assets/companion/else-chip-busy.webp",
      srcset: "/assets/companion/else-chip-busy.webp 1x, /assets/companion/else-chip-busy@2x.webp 2x",
    },
  };
  const PORTRAIT_SFW_BY_MOOD = {
    idle: {
      src: "/assets/companion/else-chip-sfw.webp",
      srcset: "/assets/companion/else-chip-sfw.webp 1x, /assets/companion/else-chip-sfw@2x.webp 2x",
    },
    listening: {
      src: "/assets/companion/else-chip-listening-sfw.webp",
      srcset: "/assets/companion/else-chip-listening-sfw.webp 1x, /assets/companion/else-chip-listening-sfw@2x.webp 2x",
    },
    speaking: {
      src: "/assets/companion/else-chip-speaking-sfw.webp",
      srcset: "/assets/companion/else-chip-speaking-sfw.webp 1x, /assets/companion/else-chip-speaking-sfw@2x.webp 2x",
    },
    proactive: {
      src: "/assets/companion/else-chip-proactive-sfw.webp",
      srcset: "/assets/companion/else-chip-proactive-sfw.webp 1x, /assets/companion/else-chip-proactive-sfw@2x.webp 2x",
    },
    sister: {
      src: "/assets/companion/else-chip-sister-sfw.webp",
      srcset: "/assets/companion/else-chip-sister-sfw.webp 1x, /assets/companion/else-chip-sister-sfw@2x.webp 2x",
    },
    busy: {
      src: "/assets/companion/else-chip-busy-sfw.webp",
      srcset: "/assets/companion/else-chip-busy-sfw.webp 1x, /assets/companion/else-chip-busy-sfw@2x.webp 2x",
    },
  };
  const LS_OPEN = "hq_else_chip_open_v1";
  const LS_EXPANDED = "hq_else_chip_expanded_v1";
  const LS_FLOAT = "hq_else_chip_float_v1";
  const LS_VISIBLE = "hq_else_chip_visible_v1";
  const LS_TOGGLE_FLOAT = "hq_else_toggle_float_v1";
  const LS_CHIP_SCALE = "hq_else_chip_scale_v1";
  const LS_PROACTIVE = "hq_else_proactive_v1";
  const LS_VOICE = "hq_else_voice_v1";
  const LS_CADENCE = "hq_else_cadence_v1";
  const LS_MUTE_UNTIL = "hq_else_mute_until_v1";
  const IDLE_LINE = "Else est là — touche pour parler.";
  const AMBIENT_MIN_MS = 7 * 60 * 1000;
  const AMBIENT_SPAN_MS = 8 * 60 * 1000;
  const AMBIENT_FIRST_MS = 75 * 1000;
  const PROACTIVE_BY_CADENCE = {
    quiet: { min: 18 * 60 * 1000, span: 12 * 60 * 1000, first: 4 * 60 * 1000 },
    normal: { min: 11 * 60 * 1000, span: 10 * 60 * 1000, first: 2.5 * 60 * 1000 },
    often: { min: 6 * 60 * 1000, span: 6 * 60 * 1000, first: 90 * 1000 },
  };
  const DRAG_THRESHOLD_PX = 8;
  const LONG_PRESS_RESET_MS = 700;
  const MOODS = ["idle", "listening", "speaking", "proactive", "sister", "busy"];
  const DND_VIEWS = { forge: 1, projets: 1 };

  function clampNum(n, lo, hi) {
    const v = Number(n);
    if (!Number.isFinite(v)) return lo;
    return Math.max(lo, Math.min(hi, v));
  }

  function readXY(win, key) {
    try {
      const raw = win.localStorage.getItem(key);
      if (!raw) return { x: 0, y: 0 };
      const parsed = JSON.parse(raw);
      return {
        x: clampNum(parsed && parsed.x, -1600, 120),
        y: clampNum(parsed && parsed.y, -1600, 120),
      };
    } catch (_) {
      return { x: 0, y: 0 };
    }
  }

  function persistXY(win, key, pos) {
    try {
      win.localStorage.setItem(key, JSON.stringify({
        x: Math.round((pos && pos.x) || 0),
        y: Math.round((pos && pos.y) || 0),
      }));
    } catch (_) {}
  }

  function clampFloat(win, x, y, minVisible) {
    const vw = win.innerWidth || 800;
    const vh = win.innerHeight || 640;
    const pad = Math.max(28, Number(minVisible) || 48);
    // Elements are fixed to bottom-right; keep them mostly on-screen.
    return {
      x: clampNum(x, -(vw - pad), 28),
      y: clampNum(y, -(vh - pad), 48),
    };
  }

  function bindFloatDrag(win, opts) {
    const el = opts.el;
    const host = opts.host || el;
    const key = opts.storageKey;
    const draggingClass = opts.draggingClass || "is-dragging";
    const minVisible = opts.minVisible || 48;
    let pos = readXY(win, key);
    let drag = null;
    let suppressClick = false;

    function apply() {
      const next = clampFloat(win, pos.x, pos.y, minVisible);
      pos.x = next.x;
      pos.y = next.y;
      host.style.transform = "translate3d(" + next.x.toFixed(1) + "px," + next.y.toFixed(1) + "px,0)";
      host.classList.toggle("is-floated", Math.hypot(next.x, next.y) > 2);
    }

    function reset(resetOpts) {
      if (drag && drag.longTimer) {
        win.clearTimeout(drag.longTimer);
        drag.longTimer = null;
      }
      drag = null;
      host.classList.remove(draggingClass);
      pos = { x: 0, y: 0 };
      if (resetOpts && resetOpts.animate === false) {
        const prev = host.style.transition;
        host.style.transition = "none";
        apply();
        persistXY(win, key, pos);
        win.requestAnimationFrame(() => { host.style.transition = prev || ""; });
        return;
      }
      apply();
      persistXY(win, key, pos);
    }

    apply();
    win.addEventListener("resize", apply);

    el.addEventListener("pointerdown", (ev) => {
      if (ev.button && ev.button !== 0) return;
      if (drag) return;
      if (typeof opts.isBlocked === "function" && opts.isBlocked()) return;
      if (typeof opts.canStart === "function" && opts.canStart(ev) === false) return;
      drag = {
        id: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        origX: pos.x,
        origY: pos.y,
        moved: false,
        longTimer: win.setTimeout(() => {
          if (!drag || drag.moved) return;
          suppressClick = true;
          drag = null;
          try { el.releasePointerCapture(ev.pointerId); } catch (_) {}
          if (typeof opts.onLongPress === "function") opts.onLongPress();
          else reset();
        }, LONG_PRESS_RESET_MS),
      };
      try { el.setPointerCapture(ev.pointerId); } catch (_) {}
    });

    el.addEventListener("pointermove", (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (!drag.moved) {
        drag.moved = true;
        suppressClick = true;
        host.classList.add(draggingClass);
        if (drag.longTimer) {
          win.clearTimeout(drag.longTimer);
          drag.longTimer = null;
        }
      }
      const prevX = pos.x;
      const prevY = pos.y;
      pos.x = drag.origX + dx;
      pos.y = drag.origY + dy;
      apply();
      if (typeof opts.onMove === "function") {
        opts.onMove(pos.x - prevX, pos.y - prevY, pos);
      }
      if (ev.cancelable) ev.preventDefault();
    });

    function endPointer(ev) {
      if (!drag || (ev && ev.pointerId !== drag.id)) return;
      if (drag.longTimer) {
        win.clearTimeout(drag.longTimer);
        drag.longTimer = null;
      }
      const moved = drag.moved;
      drag = null;
      host.classList.remove(draggingClass);
      if (moved) {
        apply();
        persistXY(win, key, pos);
        win.setTimeout(() => { suppressClick = false; }, 0);
      }
    }

    el.addEventListener("pointerup", endPointer);
    el.addEventListener("pointercancel", endPointer);

    function cancelActiveDrag() {
      if (drag && drag.longTimer) {
        win.clearTimeout(drag.longTimer);
        drag.longTimer = null;
      }
      drag = null;
      host.classList.remove(draggingClass);
    }

    return {
      apply,
      reset,
      cancelActiveDrag,
      getPos: () => ({ x: pos.x, y: pos.y }),
      consumeClickSuppressed: () => {
        if (!suppressClick) return false;
        suppressClick = false;
        return true;
      },
    };
  }

  function deviceId(win) {
    try {
      if (typeof win.hqDeviceId === "function") return String(win.hqDeviceId() || "");
      return String(win.localStorage.getItem("hq_device_id") || "");
    } catch (_) {
      return "";
    }
  }

  function withDevice(win, payload) {
    const did = deviceId(win);
    return did ? Object.assign({ device_id: did }, payload) : payload;
  }

  async function fetchJson(win, url, body) {
    if (typeof win.fetchJson === "function") return win.fetchJson(url, body);
    const opts = body == null
      ? { credentials: "same-origin" }
      : {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };
    const res = await win.fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText || "Erreur");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function aiUrl(win, extra) {
    const did = deviceId(win);
    const q = [];
    if (did) q.push("device_id=" + encodeURIComponent(did));
    if (extra) q.push(extra);
    return "/api/ai" + (q.length ? "?" + q.join("&") : "");
  }

  function reducedMotion(win) {
    try {
      return !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (_) {
      return false;
    }
  }

  function typewriter(win, el, text, done) {
    const full = String(text || "");
    if (!el) {
      if (done) done();
      return;
    }
    if (reducedMotion(win) || full.length < 3) {
      el.textContent = full;
      if (done) done();
      return;
    }
    let i = 0;
    el.textContent = "";
    const tick = () => {
      i += 1;
      el.textContent = full.slice(0, i);
      if (i >= full.length) {
        if (done) done();
        return;
      }
      win.setTimeout(tick, i < 24 ? 18 : 12);
    };
    tick();
  }

  function sisterApi(win) {
    if (win.HqSisterCore && typeof win.HqSisterCore.ensureSister === "function") {
      return win.HqSisterCore.ensureSister(win);
    }
    return (win.HqSister && win.HqSister.__ready) ? win.HqSister : null;
  }

  function mount(win) {
    const doc = win.document;
    if (doc.getElementById("hq-else")) return;
    if (doc.getElementById("hq-else-toggle")) return;
    const sis = sisterApi(win);

    const root = doc.createElement("div");
    root.id = "hq-else";
    root.className = "hq-else";

    const bubble = doc.createElement("div");
    bubble.className = "hq-else-bubble";
    bubble.setAttribute("role", "dialog");
    bubble.setAttribute("aria-label", "Else");

    const head = doc.createElement("div");
    head.className = "hq-else-head";
    const title = doc.createElement("span");
    title.className = "hq-else-title";
    title.textContent = "Else";

    const prefsBtn = doc.createElement("button");
    prefsBtn.type = "button";
    prefsBtn.className = "hq-else-head-btn hq-else-prefs-btn";
    prefsBtn.textContent = "Prefs";
    prefsBtn.title = "Préférences Else";
    prefsBtn.setAttribute("aria-label", "Préférences Else");

    const sisterBtn = doc.createElement("button");
    sisterBtn.type = "button";
    sisterBtn.className = "hq-else-head-btn hq-else-sister-btn";
    sisterBtn.textContent = "Sœurs";
    sisterBtn.title = "Sœurs — sujet manuel";
    sisterBtn.setAttribute("aria-label", "Dialogue entre sœurs");
    const expandBtn = doc.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "hq-else-head-btn";
    expandBtn.textContent = "⤢";
    expandBtn.title = "Agrandir le chat";
    expandBtn.setAttribute("aria-label", "Agrandir le chat");
    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "hq-else-head-btn";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Fermer");
    head.append(title, prefsBtn, sisterBtn, expandBtn, closeBtn);

    const line = doc.createElement("p");
    line.className = "hq-else-line";
    line.textContent = IDLE_LINE;

    const peek = doc.createElement("div");
    peek.className = "hq-else-peek";
    peek.hidden = true;
    peek.setAttribute("aria-live", "polite");

    const sisterMeter = doc.createElement("div");
    sisterMeter.className = "hq-else-sister-meter";
    sisterMeter.hidden = true;
    sisterMeter.setAttribute("aria-live", "polite");

    const sisterEventChip = doc.createElement("div");
    sisterEventChip.className = "hq-else-sister-event";
    sisterEventChip.hidden = true;
    sisterEventChip.setAttribute("aria-live", "polite");

    const sisterStrip = doc.createElement("div");
    sisterStrip.className = "hq-else-sister-strip";
    sisterStrip.hidden = true;
    sisterStrip.setAttribute("aria-label", "Transcript sœurs");

    const memoryPanel = doc.createElement("div");
    memoryPanel.className = "hq-else-memory";
    memoryPanel.hidden = true;
    memoryPanel.setAttribute("aria-label", "Souvenirs Else");
    const memoryHead = doc.createElement("div");
    memoryHead.className = "hq-else-memory-head";
    memoryHead.textContent = "Mémoire Else";
    const memoryList = doc.createElement("div");
    memoryList.className = "hq-else-memory-list";
    const memoryForm = doc.createElement("form");
    memoryForm.className = "hq-else-memory-form";
    const memoryInput = doc.createElement("input");
    memoryInput.type = "text";
    memoryInput.maxLength = 200;
    memoryInput.placeholder = "Retiens que…";
    memoryInput.autocomplete = "off";
    const memoryAdd = doc.createElement("button");
    memoryAdd.type = "submit";
    memoryAdd.textContent = "Retiens";
    memoryForm.append(memoryInput, memoryAdd);
    memoryPanel.append(memoryHead, memoryList, memoryForm);

    const prefsPanel = doc.createElement("div");
    prefsPanel.className = "hq-else-prefs";
    prefsPanel.hidden = true;
    prefsPanel.setAttribute("aria-label", "Préférences Else");
    prefsPanel.innerHTML = [
      '<label class="hq-else-prefs-row hq-else-prefs-check"><input type="checkbox" data-else-pref="ambient"/> Banter sœurs</label>',
      '<label class="hq-else-prefs-row hq-else-prefs-check"><input type="checkbox" data-else-pref="react"/> Réactions sœur</label>',
      '<label class="hq-else-prefs-row hq-else-prefs-check"><input type="checkbox" data-else-pref="proactive"/> Else proactive</label>',
      '<label class="hq-else-prefs-row">Cadence',
      '<select data-else-pref="cadence">',
      '<option value="quiet">Discrète</option>',
      '<option value="normal" selected>Normale</option>',
      '<option value="often">Souvent</option>',
      "</select></label>",
      '<label class="hq-else-prefs-row">Adresse',
      '<select data-else-pref="address">',
      '<option value="">(partagée)</option>',
      '<option value="tu">tu</option>',
      '<option value="vous">vous</option>',
      "</select></label>",
      '<label class="hq-else-prefs-row hq-else-prefs-check"><input type="checkbox" data-else-pref="voice"/> Voix douce (HQ)</label>',
      '<label class="hq-else-prefs-row">Silence',
      '<select data-else-pref="mute">',
      '<option value="0">Off</option>',
      '<option value="15">15 min</option>',
      '<option value="60">1 h</option>',
      '<option value="240">4 h</option>',
      "</select></label>",
      '<label class="hq-else-prefs-row">Sujets off',
      '<textarea data-else-pref="topics" rows="2" maxlength="400" placeholder="Un sujet par ligne…"></textarea></label>',
    ].join("");

    const log = doc.createElement("div");
    log.className = "hq-else-log";

    const form = doc.createElement("form");
    form.className = "hq-else-compose";
    const input = doc.createElement("input");
    input.type = "text";
    input.maxLength = 1600;
    input.placeholder = "Parler à Else…";
    input.autocomplete = "off";
    const send = doc.createElement("button");
    send.type = "submit";
    send.textContent = "Envoyer";
    form.append(input, send);

    const sisterBar = doc.createElement("div");
    sisterBar.className = "hq-else-sister-bar";
    sisterBar.hidden = true;
    const sisterTopic = doc.createElement("input");
    sisterTopic.type = "text";
    sisterTopic.maxLength = 200;
    sisterTopic.placeholder = "Sujet pour les sœurs (optionnel)…";
    sisterTopic.autocomplete = "off";
    const sisterGo = doc.createElement("button");
    sisterGo.type = "button";
    sisterGo.textContent = "Parler";
    const sisterNudge = doc.createElement("button");
    sisterNudge.type = "button";
    sisterNudge.className = "hq-else-sister-nudge";
    sisterNudge.textContent = "↔";
    sisterNudge.title = "Pousser un peu les sœurs (2× = banter)";
    sisterNudge.setAttribute("aria-label", "Nudge entre sœurs");
    sisterBar.append(sisterTopic, sisterGo, sisterNudge);

    bubble.append(head, line, peek, sisterMeter, sisterEventChip, sisterStrip, sisterBar, memoryPanel, prefsPanel, log, form);

    const chipMenu = doc.createElement("div");
    chipMenu.className = "hq-else-chip-menu";
    chipMenu.hidden = true;
    chipMenu.setAttribute("role", "menu");
    const menuItems = [
      { id: "hide", label: "Masquer" },
      { id: "bigger", label: "Agrandir" },
      { id: "smaller", label: "Réduire" },
      { id: "scale_reset", label: "Taille normale" },
      { id: "nudge", label: "Nudge sœur" },
      { id: "reset", label: "Reset position" },
      { id: "memory", label: "Mémoire" },
    ];
    menuItems.forEach((item) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "hq-else-chip-menu-item";
      btn.dataset.action = item.id;
      btn.textContent = item.label;
      btn.setAttribute("role", "menuitem");
      chipMenu.appendChild(btn);
    });

    const chip = doc.createElement("button");
    chip.type = "button";
    chip.className = "hq-else-chip";
    chip.title = "Else — glisser · pincement ou Ctrl+molette = taille · appui long = menu";
    chip.setAttribute("aria-label", "Else — glisser, menu, ou ouvrir");
    const ring = doc.createElement("span");
    ring.className = "hq-else-chip-ring";
    ring.setAttribute("aria-hidden", "true");
    const bustStage = doc.createElement("span");
    bustStage.className = "hq-else-chip-bust";
    bustStage.setAttribute("aria-hidden", "true");
    const img = doc.createElement("img");
    img.className = "hq-else-chip-avatar";
    img.src = PORTRAIT_BODY;
    img.srcset = PORTRAIT_BODY + " 1x, " + PORTRAIT_BODY_2X + " 2x";
    img.alt = "Else";
    img.decoding = "async";
    img.loading = "lazy";
    img.draggable = false;
    const bustL = doc.createElement("img");
    bustL.className = "hq-else-bust hq-else-bust-left";
    bustL.src = BUST_LEFT;
    bustL.srcset = BUST_LEFT + " 1x, " + BUST_LEFT_2X + " 2x";
    bustL.alt = "";
    bustL.decoding = "async";
    bustL.draggable = false;
    const bustR = doc.createElement("img");
    bustR.className = "hq-else-bust hq-else-bust-right";
    bustR.src = BUST_RIGHT;
    bustR.srcset = BUST_RIGHT + " 1x, " + BUST_RIGHT_2X + " 2x";
    bustR.alt = "";
    bustR.decoding = "async";
    bustR.draggable = false;
    bustStage.append(img, bustL, bustR);
    const fx = doc.createElement("span");
    fx.className = "hq-else-chip-fx";
    fx.setAttribute("aria-hidden", "true");
    const fxBlink = doc.createElement("span");
    fxBlink.className = "hq-else-fx-blink";
    const fxBlush = doc.createElement("span");
    fxBlush.className = "hq-else-fx-blush";
    fx.append(fxBlink, fxBlush);
    chip.append(ring, bustStage, fx);

    root.append(bubble, chip, chipMenu);
    doc.body.appendChild(root);

    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.id = "hq-else-toggle";
    toggle.className = "hq-else-toggle";
    toggle.title = "Replier / afficher Else · glisser · appui long = menu";
    toggle.setAttribute("aria-label", "Replier ou afficher Else");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-controls", "hq-else");
    const toggleGrip = doc.createElement("span");
    toggleGrip.className = "hq-else-toggle-grip";
    toggleGrip.setAttribute("aria-hidden", "true");
    toggleGrip.textContent = "⋮⋮";
    const toggleLabel = doc.createElement("span");
    toggleLabel.className = "hq-else-toggle-label";
    toggleLabel.textContent = "Else";
    const toggleChevron = doc.createElement("span");
    toggleChevron.className = "hq-else-toggle-chevron";
    toggleChevron.setAttribute("aria-hidden", "true");
    toggleChevron.textContent = "▾";
    toggle.append(toggleGrip, toggleLabel, toggleChevron);
    doc.body.appendChild(toggle);

    let chatBusy = false;
    let messages = [];
    let open = false;
    let expanded = false;
    let chipVisible = true;
    let proactiveOn = true;
    let voiceOn = false;
    let cadence = "normal";
    let elseAddress = "";
    let elseTopics = "";
    let listenPulse = null;
    let peekTimer = null;
    let togglePulseTimer = null;
    let moodTimer = null;
    let currentMood = "idle";
    let memoryRows = [];
    let sisterFavor = "tie";
    let prevSisterFavor = "tie";
    let favorPrimed = false;
    let muteUntil = 0;
    let lastSisterEvent = null;
    let speechAudio = null;
    let speechRequest = 0;
    let lipTimer = null;
    let aliveTimer = null;
    let microTimer = null;
    let speechActive = false;
    const moodHolds = {
      busy: null,
      speech: null,
      typing: null,
      sister: null,
      context: null,
      flash: null,
    };
    const HOLD_ORDER = ["busy", "speech", "typing", "sister", "context", "flash"];

    try {
      if (win.localStorage.getItem(LS_PROACTIVE) === "0") proactiveOn = false;
      if (win.localStorage.getItem(LS_VOICE) === "1") voiceOn = true;
      const cad = win.localStorage.getItem(LS_CADENCE);
      if (cad === "quiet" || cad === "normal" || cad === "often") cadence = cad;
      muteUntil = Number(win.localStorage.getItem(LS_MUTE_UNTIL) || 0) || 0;
    } catch (_) {}

    function sisterBusy() {
      return !!(sis && sis.isBusy && sis.isBusy());
    }

    function syncChromeBusy(on) {
      const busy = !!on || sisterBusy() || chatBusy;
      root.classList.toggle("is-busy", busy);
      if (busy) {
        setHold("busy", "busy", null);
        clearHold("typing");
      } else {
        clearHold("busy");
      }
      paintMood();
      send.disabled = busy;
      input.disabled = busy;
      sisterGo.disabled = busy;
      sisterNudge.disabled = busy;
      sisterBtn.disabled = busy;
      sisterTopic.disabled = busy;
      prefsBtn.disabled = busy;
      memoryAdd.disabled = busy;
    }

    function muteRemainingMin() {
      const left = muteUntil - Date.now();
      if (left <= 0) return 0;
      return Math.max(1, Math.ceil(left / 60000));
    }

    function setMuteMinutes(mins) {
      const m = Math.max(0, Number(mins) || 0);
      muteUntil = m > 0 ? Date.now() + m * 60000 : 0;
      try {
        if (muteUntil) win.localStorage.setItem(LS_MUTE_UNTIL, String(muteUntil));
        else win.localStorage.removeItem(LS_MUTE_UNTIL);
      } catch (_) {}
      syncPrefsPanel();
      return muteUntil;
    }

    function syncPrefToggles() {
      syncPrefsPanel();
    }

    function setProactive(on) {
      proactiveOn = on !== false;
      try { win.localStorage.setItem(LS_PROACTIVE, proactiveOn ? "1" : "0"); } catch (_) {}
      syncPrefToggles();
      queueElsePrefs({ else_proactive: proactiveOn });
      return proactiveOn;
    }

    function setVoice(on) {
      voiceOn = on === true;
      try { win.localStorage.setItem(LS_VOICE, voiceOn ? "1" : "0"); } catch (_) {}
      if (!voiceOn) {
        speechRequest += 1;
        try { if (win.speechSynthesis) win.speechSynthesis.cancel(); } catch (_) {}
        try { if (speechAudio) { speechAudio.pause(); speechAudio = null; } } catch (_) {}
        endSpeakingVisual();
      }
      syncPrefsPanel();
      queueElsePrefs({ else_voice: voiceOn });
      return voiceOn;
    }

    function setCadence(next) {
      const c = (next === "quiet" || next === "often") ? next : "normal";
      cadence = c;
      try { win.localStorage.setItem(LS_CADENCE, cadence); } catch (_) {}
      syncPrefsPanel();
      queueElsePrefs({ else_proactive_cadence: cadence });
      return cadence;
    }

    function toggleMemoryPanel(force) {
      const show = force == null ? memoryPanel.hidden : !!force;
      memoryPanel.hidden = !show;
      if (show) {
        prefsPanel.hidden = true;
        if (!open) setOpen(true);
        if (!expanded) setExpanded(true);
        loadMemory();
      }
    }

    function togglePrefsPanel(force) {
      const show = force == null ? prefsPanel.hidden : !!force;
      prefsPanel.hidden = !show;
      if (show) {
        memoryPanel.hidden = true;
        if (!open) setOpen(true);
        syncPrefsPanel();
      }
    }

    function applySisterEventChip(detail) {
      const d = detail || lastSisterEvent || (sis && sis.__lastEvent) || null;
      if (!d || (!d.label && !d.id && !d.kind)) {
        sisterEventChip.hidden = true;
        sisterEventChip.textContent = "";
        return;
      }
      lastSisterEvent = {
        id: d.id || "",
        kind: d.kind || "",
        label: d.label || d.id || d.kind || "événement",
      };
      if (sis) sis.__lastEvent = lastSisterEvent;
      const kind = String(lastSisterEvent.kind || "observe");
      sisterEventChip.hidden = !expanded;
      sisterEventChip.className = "hq-else-sister-event is-" + kind.replace(/[^a-z0-9_-]/gi, "");
      sisterEventChip.textContent = String(lastSisterEvent.label);
      sisterEventChip.title = lastSisterEvent.id ? ("événement · " + lastSisterEvent.id) : "événement sœurs";
    }

    function renderSisterStrip() {
      const core = win.HqSisterCore || {};
      const rows = sis
        ? sis.stripRows(6)
        : (core.stripRows ? core.stripRows(messages, 6) : []);
      const label = (sis && sis.labelSpeaker) || core.labelSpeaker || ((s) => s);
      sisterStrip.replaceChildren();
      sisterStrip.hidden = !expanded || !rows.length;
      applySisterEventChip();
      rows.forEach((m) => {
        const row = doc.createElement("button");
        row.type = "button";
        row.className = "hq-else-sister-row is-" + m.speaker;
        row.textContent = label(m.speaker) + " · " + String(m.text);
        row.title = "Faire réagir l'autre sœur";
        row.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (!sis || sis.isBusy() || !sis.reactEnabled()) return;
          const speaker = m.speaker === "else" ? "transferania" : "else";
          sis.runReact(String(m.text || ""), speaker);
        });
        sisterStrip.appendChild(row);
      });
      sisterStrip.scrollTop = sisterStrip.scrollHeight;
    }

    function portraitPath(url) {
      try {
        return new URL(String(url || ""), win.location.origin).pathname;
      } catch (_) {
        return String(url || "");
      }
    }

    function applyPortrait(mood) {
      const adult = win.HqImageChipScale && win.HqImageChipScale.adultChipPortraits
        ? win.HqImageChipScale.adultChipPortraits(win)
        : false;
      const table = adult ? PORTRAIT_BY_MOOD : PORTRAIT_SFW_BY_MOOD;
      const pack = table[mood] || table.idle;
      const bustOn = adult && !!(pack && pack.bust);
      root.classList.toggle("is-bust", bustOn);
      bustL.hidden = !bustOn;
      bustR.hidden = !bustOn;
      if (!bustOn) resetBustPose();
      if (portraitPath(img.src) === pack.src) return;
      img.src = pack.src;
      img.srcset = pack.srcset;
    }

    const bustPhys = {
      l: { x: 0, y: 0, vx: 0, vy: 0 },
      r: { x: 0, y: 0, vx: 0, vy: 0 },
      raf: 0,
      lastT: 0,
      impulseX: 0,
      impulseY: 0,
    };

    function resetBustPose() {
      bustPhys.l.x = bustPhys.l.y = bustPhys.l.vx = bustPhys.l.vy = 0;
      bustPhys.r.x = bustPhys.r.y = bustPhys.r.vx = bustPhys.r.vy = 0;
      bustL.style.transform = "";
      bustR.style.transform = "";
    }

    function bustAmp() {
      if (!root.classList.contains("is-bust")) return 0;
      if (!motionAllowsFx()) return 0;
      return root.classList.contains("is-motion-lite") ? 0.45 : 1;
    }

    function paintBust() {
      const a = bustAmp();
      if (!a) {
        bustL.style.transform = "";
        bustR.style.transform = "";
        return;
      }
      const l = bustPhys.l;
      const r = bustPhys.r;
      bustL.style.transform = "translate3d(" + (l.x * a).toFixed(2) + "px," + (l.y * a).toFixed(2) + "px,0) rotate(" + (l.x * 0.35 * a).toFixed(2) + "deg)";
      bustR.style.transform = "translate3d(" + (r.x * a).toFixed(2) + "px," + (r.y * a).toFixed(2) + "px,0) rotate(" + (r.x * 0.35 * a).toFixed(2) + "deg)";
    }

    function stepBustSide(side, mirror, ix, iy, dt) {
      const targetX = ix * (0.55 + 0.12 * mirror);
      const targetY = iy * 0.7;
      const ax = (targetX - side.x) * 58 - side.vx * 9.5;
      const ay = (targetY - side.y) * 58 - side.vy * 9.5;
      side.vx += ax * dt;
      side.vy += ay * dt;
      side.x = Math.max(-7, Math.min(7, side.x + side.vx * dt));
      side.y = Math.max(-5, Math.min(8, side.y + side.vy * dt));
    }

    function bustSideAtRest(side) {
      return Math.abs(side.x) < 0.03 && Math.abs(side.y) < 0.03
        && Math.abs(side.vx) < 0.4 && Math.abs(side.vy) < 0.4;
    }

    function bustHasEnergy() {
      return Math.abs(bustPhys.impulseX) > 0.02 || Math.abs(bustPhys.impulseY) > 0.02
        || !bustSideAtRest(bustPhys.l) || !bustSideAtRest(bustPhys.r);
    }

    // Idle breathing is a CSS keyframe on `translate` (see .hq-else-bust). This loop only runs
    // while a drag impulse is decaying, then stops itself — no permanent per-frame work.
    function stepBust(now) {
      const dt = Math.min(0.033, Math.max(0.008, (now - (bustPhys.lastT || now)) / 1000));
      bustPhys.lastT = now;
      if (!bustAmp()) {
        bustPhys.raf = 0;
        bustPhys.impulseX = bustPhys.impulseY = 0;
        resetBustPose();
        return;
      }
      // Drag impulse decays into both lobes with slight phase lag.
      const ix = bustPhys.impulseX;
      const iy = bustPhys.impulseY;
      const decay = Math.pow(0.12, dt);
      bustPhys.impulseX *= decay;
      bustPhys.impulseY *= decay;
      stepBustSide(bustPhys.l, 1, ix, iy, dt);
      stepBustSide(bustPhys.r, -1, ix, iy, dt);
      if (!bustHasEnergy()) {
        bustPhys.raf = 0;
        bustPhys.impulseX = bustPhys.impulseY = 0;
        resetBustPose();
        return;
      }
      paintBust();
      bustPhys.raf = win.requestAnimationFrame(stepBust);
    }

    function ensureBustLoop() {
      if (bustPhys.raf) return;
      if (!bustAmp() || !bustHasEnergy()) return;
      bustPhys.lastT = 0;
      bustPhys.raf = win.requestAnimationFrame(stepBust);
    }

    function nudgeBust(dx, dy) {
      if (!bustAmp()) return;
      bustPhys.impulseX += Math.max(-14, Math.min(14, dx * 0.08));
      bustPhys.impulseY += Math.max(-10, Math.min(12, dy * 0.06));
      ensureBustLoop();
    }

    function clearHold(key) {
      if (Object.prototype.hasOwnProperty.call(moodHolds, key)) moodHolds[key] = null;
    }

    function setHold(key, mood, until) {
      if (!Object.prototype.hasOwnProperty.call(moodHolds, key)) return;
      const next = MOODS.indexOf(mood) >= 0 ? mood : "idle";
      moodHolds[key] = { mood: next, until: until == null ? null : Number(until) };
    }

    function resolveMood() {
      const now = Date.now();
      for (let i = 0; i < HOLD_ORDER.length; i++) {
        const key = HOLD_ORDER[i];
        const h = moodHolds[key];
        if (!h) continue;
        if (h.until != null && now >= h.until) {
          moodHolds[key] = null;
          continue;
        }
        return h.mood;
      }
      return "idle";
    }

    function armMoodExpiry() {
      if (moodTimer) win.clearTimeout(moodTimer);
      moodTimer = null;
      let soonest = 0;
      const now = Date.now();
      HOLD_ORDER.forEach((key) => {
        const h = moodHolds[key];
        if (h && h.until != null && h.until > now) {
          if (!soonest || h.until < soonest) soonest = h.until;
        }
      });
      if (soonest) {
        moodTimer = win.setTimeout(() => {
          moodTimer = null;
          paintMood();
        }, Math.max(80, soonest - Date.now()));
      }
    }

    function paintMood() {
      const next = resolveMood();
      if (next === currentMood) {
        armMoodExpiry();
        return;
      }
      MOODS.forEach((m) => root.classList.toggle("is-mood-" + m, m === next));
      currentMood = next;
      applyPortrait(next);
      armMoodExpiry();
    }

    function setMood(mood, ms) {
      const next = MOODS.indexOf(mood) >= 0 ? mood : "idle";
      if (next === "idle") {
        clearHold("flash");
        paintMood();
        return;
      }
      // Sticky busy is owned by syncChromeBusy — setMood only flashes.
      if (next === "busy") {
        const dur = Math.max(900, Number(ms) || 1800);
        setHold("flash", "busy", Date.now() + dur);
        paintMood();
        return;
      }
      if (next === "sister") {
        holdSister(ms);
        return;
      }
      const dur = Math.max(900, Number(ms) || 1800);
      setHold("flash", next, Date.now() + dur);
      paintMood();
    }

    function holdSister(ms) {
      const dur = Math.max(2800, Number(ms) || 4500);
      setHold("sister", "sister", Date.now() + dur);
      paintMood();
      fireMicro("blush");
    }

    function motionAllowsFx() {
      if (doc.hidden || !chipVisible) return false;
      if (root.classList.contains("is-anim-paused")) return false;
      return motionTier() !== "parked";
    }

    function fireMicro(kind) {
      if (!motionAllowsFx()) return;
      if (root.classList.contains("is-motion-lite") && kind !== "blink") return;
      const k = String(kind || "");
      if (!k) return;
      const cls = "is-fx-" + k;
      ["blink", "blush", "glance", "think"].forEach((n) => root.classList.remove("is-fx-" + n));
      // Restart CSS without sync layout flush (offsetWidth).
      win.requestAnimationFrame(() => {
        root.classList.add(cls);
      });
      if (microTimer) win.clearTimeout(microTimer);
      const ms = k === "blink" ? 170 : (k === "think" ? 900 : 650);
      microTimer = win.setTimeout(() => {
        root.classList.remove(cls);
        microTimer = null;
      }, ms);
    }

    function scheduleAliveIdle() {
      if (aliveTimer) win.clearTimeout(aliveTimer);
      const arm = () => {
        const paused = !motionAllowsFx();
        // Parked/hidden: wake rarely. Full: soft presence cadence.
        const delay = paused
          ? 20000 + Math.floor(Math.random() * 20000)
          : 4800 + Math.floor(Math.random() * 8000);
        aliveTimer = win.setTimeout(() => {
          aliveTimer = null;
          if (currentMood === "idle" && motionAllowsFx()) {
            const roll = Math.random();
            if (roll < 0.62) fireMicro("blink");
            else if (root.classList.contains("is-motion-lite")) fireMicro("blink");
            else if (roll < 0.80) fireMicro("glance");
            else if (roll < 0.93) fireMicro("think");
            else fireMicro("blush");
          }
          arm();
        }, delay);
      };
      arm();
    }

    function stopLipSync() {
      if (lipTimer) {
        win.clearTimeout(lipTimer);
        lipTimer = null;
      }
      root.classList.remove("is-lip-open", "is-lip-pulse");
    }

    function startLipSync(mode) {
      stopLipSync();
      const tier = motionTier();
      if (tier === "parked" || doc.hidden) return;
      root.classList.add("is-speaking");
      if (mode !== "pulse") return;
      // CSS pulse — no setInterval class thrash. Lite: ring only, no avatar work.
      root.classList.add("is-lip-pulse");
      if (tier === "lite") root.classList.add("is-motion-lite");
    }

    function beginSpeakingVisual() {
      speechActive = true;
      setHold("speech", "speaking", null);
      root.classList.add("is-speaking");
      paintMood();
    }

    function endSpeakingVisual() {
      speechActive = false;
      stopLipSync();
      clearHold("speech");
      root.classList.remove("is-speaking");
      paintMood();
    }

    function bindSpeechAudio(audio, req) {
      const onDone = () => {
        if (req !== speechRequest) return;
        if (speechAudio === audio) speechAudio = null;
        endSpeakingVisual();
      };
      audio.addEventListener("play", () => {
        if (req !== speechRequest) return;
        beginSpeakingVisual();
        startLipSync("pulse");
      });
      audio.addEventListener("ended", onDone);
      audio.addEventListener("pause", () => {
        if (req !== speechRequest) return;
        // Treat intentional pause/stop as end; mid-swap is guarded by speechRequest bump.
        onDone();
      });
      audio.addEventListener("error", onDone);
    }

    function syncContextMood() {
      const view = (doc.body && doc.body.dataset.view) || "accueil";
      root.classList.toggle("is-ctx-carnet", view === "carnet");
      root.classList.toggle("is-ctx-forge", view === "forge");
      // CSS-only context tint — do not pin busy hold (keeps idle breathe alive).
      clearHold("context");
      paintMood();
    }

    let cachedFrVoice = null;
    let voicesHooked = false;

    function pickElseVoice() {
      try {
        if (!win.speechSynthesis) return null;
        if (cachedFrVoice) return cachedFrVoice;
        const voices = win.speechSynthesis.getVoices() || [];
        if (!voices.length) {
          if (!voicesHooked && typeof win.speechSynthesis.addEventListener === "function") {
            voicesHooked = true;
            win.speechSynthesis.addEventListener("voiceschanged", () => { cachedFrVoice = null; }, { once: true });
          }
          return null;
        }
        cachedFrVoice = voices.find((v) => /fr(-|_|$)/i.test(v.lang) && /female|google|hortense|Denise|Julie/i.test(v.name))
          || voices.find((v) => /fr(-|_|$)/i.test(v.lang))
          || null;
        return cachedFrVoice;
      } catch (_) {
        return null;
      }
    }

    function fallbackBrowserSpeech(t) {
      try {
        if (!win.speechSynthesis) {
          endSpeakingVisual();
          return;
        }
        win.speechSynthesis.cancel();
        const u = new win.SpeechSynthesisUtterance(t.slice(0, 280));
        u.lang = "fr-FR";
        u.rate = 0.9;
        u.pitch = 1.02;
        u.volume = 0.42;
        const fr = pickElseVoice();
        if (fr) u.voice = fr;
        u.onstart = () => {
          beginSpeakingVisual();
          startLipSync("pulse");
        };
        u.onboundary = (ev) => {
          if (ev && ev.name === "word") root.classList.toggle("is-lip-open");
        };
        u.onend = () => endSpeakingVisual();
        u.onerror = () => endSpeakingVisual();
        beginSpeakingVisual();
        startLipSync("pulse");
        win.speechSynthesis.speak(u);
      } catch (_) {
        endSpeakingVisual();
      }
    }

    function speakElseQuiet(text) {
      if (!voiceOn) return;
      const t = String(text || "").replace(/[♥✨🔥💋]/g, "").trim();
      if (!t || doc.hidden) return;
      const req = ++speechRequest;
      beginSpeakingVisual();
      startLipSync("pulse");
      try { if (speechAudio) { speechAudio.pause(); speechAudio = null; } } catch (_) {}
      try { if (win.speechSynthesis) win.speechSynthesis.cancel(); } catch (_) {}
      fetchJson(win, "/api/ai", withDevice(win, {
        action: "else",
        op: "voice",
        text: t.slice(0, 400),
        style: "thoughtful",
      })).then((data) => {
        if (req !== speechRequest || !voiceOn || doc.hidden) {
          if (req === speechRequest) endSpeakingVisual();
          return;
        }
        if (data && data.ok && data.audio_url) {
          try {
            const audio = new win.Audio(data.audio_url);
            speechAudio = audio;
            audio.volume = 0.55;
            bindSpeechAudio(audio, req);
            audio.play().catch(() => {
              if (req === speechRequest) fallbackBrowserSpeech(t);
            });
            return;
          } catch (_) {}
        }
        fallbackBrowserSpeech(t);
      }).catch(() => {
        if (req === speechRequest && voiceOn && !doc.hidden) fallbackBrowserSpeech(t);
        else if (req === speechRequest) endSpeakingVisual();
      });
    }

    function motionTier() {
      try {
        if (win.HqMotion && typeof win.HqMotion.tier === "function") return String(win.HqMotion.tier() || "full");
      } catch (_) {}
      return "full";
    }

    let motionPerfTimer = null;
    function syncMotionPerf() {
      const tier = motionTier();
      const parked = tier === "parked" || !!doc.hidden || !chipVisible
        || !!(doc.body && doc.body.classList.contains("hq-ai-open"));
      const lite = !parked && tier === "lite";
      root.classList.toggle("is-anim-paused", parked);
      root.classList.toggle("is-motion-lite", lite);
      toggle.classList.toggle("is-anim-paused", parked);
      toggle.classList.toggle("is-motion-lite", lite);
      if (parked) {
        stopLipSync();
        if (bustPhys.raf) {
          win.cancelAnimationFrame(bustPhys.raf);
          bustPhys.raf = 0;
        }
        paintBust();
      } else {
        ensureBustLoop();
      }
    }
    function scheduleSyncMotionPerf() {
      if (motionPerfTimer) return;
      motionPerfTimer = win.setTimeout(() => {
        motionPerfTimer = null;
        syncMotionPerf();
      }, 48);
    }

    function pulseToggle(ms, preview) {
      toggle.classList.add("is-pulse");
      const tip = String(preview || "").trim();
      if (tip) {
        toggle.title = tip.length > 90 ? tip.slice(0, 87) + "…" : tip;
        toggle.dataset.preview = tip;
        toggle.classList.add("has-preview");
      }
      if (togglePulseTimer) win.clearTimeout(togglePulseTimer);
      togglePulseTimer = win.setTimeout(() => {
        toggle.classList.remove("is-pulse");
        toggle.classList.remove("has-preview");
        delete toggle.dataset.preview;
        toggle.title = chipVisible
          ? "Replier Else · glisser pour déplacer · appui long = menu"
          : "Afficher Else · glisser pour déplacer · appui long = menu";
        togglePulseTimer = null;
      }, Math.max(900, Number(ms) || 1600));
    }

    function setChipVisible(on, opts) {
      const next = on !== false;
      const force = !!(opts && opts.force);
      if (next === chipVisible && !force) return chipVisible;
      chipVisible = next;
      root.hidden = !chipVisible;
      toggle.classList.toggle("is-collapsed", !chipVisible);
      toggle.setAttribute("aria-expanded", chipVisible ? "true" : "false");
      toggleChevron.textContent = chipVisible ? "▾" : "▸";
      toggle.title = chipVisible
        ? "Replier Else · glisser pour déplacer · appui long = menu"
        : "Afficher Else · glisser pour déplacer · appui long = menu";
      try { win.localStorage.setItem(LS_VISIBLE, chipVisible ? "1" : "0"); } catch (_) {}
      if (!chipVisible) {
        setOpen(false);
        chipMenu.hidden = true;
      }
      syncMotionPerf();
      return chipVisible;
    }

    function ensureChipVisible() {
      if (!chipVisible) setChipVisible(true);
    }

    function showPeek(text) {
      const t = String(text || "").trim();
      if (!chipVisible) {
        pulseToggle(2200, t);
        return;
      }
      root.classList.add("is-peek");
      setMood("proactive", 2200);
      pulseListening(2200, { keepMood: true });
      if (t) {
        peek.hidden = false;
        peek.textContent = t.length > 90 ? t.slice(0, 87) + "…" : t;
      }
      if (peekTimer) win.clearTimeout(peekTimer);
      peekTimer = win.setTimeout(() => {
        root.classList.remove("is-peek");
        peek.hidden = true;
      }, 4200);
    }

    function pulseListening(ms, opts) {
      root.classList.add("is-listening");
      if (!(opts && opts.keepMood)) setMood("listening", ms);
      if (listenPulse) win.clearTimeout(listenPulse);
      listenPulse = win.setTimeout(() => root.classList.remove("is-listening"), Math.max(900, Number(ms) || 1600));
    }

    function markSpeaking(on) {
      root.classList.toggle("is-speaking", !!on);
      try {
        doc.documentElement.classList.toggle("hq-sister-speaking", !!on);
      } catch (_) {}
      if (on) {
        setHold("speech", "speaking", null);
        paintMood();
      } else if (!speechActive) {
        clearHold("speech");
        paintMood();
      }
    }

    function setLine(text, animate, opts) {
      const t = String(text || "").trim() || IDLE_LINE;
      const o = opts || {};
      // speakVisual: typewriter / voice path only — ambient peeks must not steal speaking hold.
      const speakVisual = o.speakVisual != null ? !!o.speakVisual : !!animate;
      root.classList.add("is-typing");
      if (speakVisual) {
        markSpeaking(true);
        startLipSync(animate ? "pulse" : null);
      }
      const finish = () => {
        root.classList.remove("is-typing");
        if (!speakVisual) return;
        win.setTimeout(() => {
          if (speechActive) return;
          stopLipSync();
          markSpeaking(false);
        }, voiceOn ? 120 : 400);
      };
      if (animate) typewriter(win, line, t, finish);
      else {
        line.textContent = t;
        finish();
      }
    }

    function renderMemory() {
      memoryList.replaceChildren();
      const rows = Array.isArray(memoryRows) ? memoryRows.slice(0, 8) : [];
      if (!rows.length) {
        const empty = doc.createElement("div");
        empty.className = "hq-else-memory-empty";
        empty.textContent = "Rien d'ancré encore.";
        memoryList.appendChild(empty);
        return;
      }
      rows.forEach((m) => {
        const row = doc.createElement("div");
        row.className = "hq-else-memory-row";
        const txt = doc.createElement("span");
        txt.textContent = String((m && (m.text || m)) || "");
        const forget = doc.createElement("button");
        forget.type = "button";
        forget.textContent = "Oublie";
        forget.title = "Oublier ce souvenir";
        forget.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (!m || !m.id) return;
          try {
            await fetchJson(win, "/api/ai", withDevice(win, {
              action: "else",
              op: "memory_forget",
              id: m.id,
            }));
            await loadMemory();
          } catch (_) {}
        });
        row.append(txt, forget);
        memoryList.appendChild(row);
      });
    }

    async function loadMemory() {
      try {
        const out = await fetchJson(win, "/api/ai", withDevice(win, { action: "else", op: "memory" }));
        const mems = Array.isArray(out.memories) ? out.memories : [];
        memoryRows = mems.filter((m) => m && m.text).slice(0, 8);
        renderMemory();
      } catch (_) {
        memoryRows = [];
        renderMemory();
      }
    }

    function syncPrefsPanel() {
      const amb = sis ? sis.ambientEnabled() : true;
      const rea = sis ? sis.reactEnabled() : true;
      const elAmb = prefsPanel.querySelector('[data-else-pref="ambient"]');
      const elRea = prefsPanel.querySelector('[data-else-pref="react"]');
      const elPro = prefsPanel.querySelector('[data-else-pref="proactive"]');
      const cad = prefsPanel.querySelector('[data-else-pref="cadence"]');
      const addr = prefsPanel.querySelector('[data-else-pref="address"]');
      const voice = prefsPanel.querySelector('[data-else-pref="voice"]');
      const mute = prefsPanel.querySelector('[data-else-pref="mute"]');
      const topics = prefsPanel.querySelector('[data-else-pref="topics"]');
      if (elAmb) elAmb.checked = !!amb;
      if (elRea) elRea.checked = !!rea;
      if (elPro) elPro.checked = !!proactiveOn;
      if (cad) cad.value = cadence;
      if (addr) addr.value = elseAddress || "";
      if (voice) voice.checked = !!voiceOn;
      if (mute) {
        const left = muteRemainingMin();
        if (!left) mute.value = "0";
        else if (left <= 15) mute.value = "15";
        else if (left <= 60) mute.value = "60";
        else mute.value = "240";
      }
      if (topics) topics.value = elseTopics || "";
      prefsBtn.classList.toggle("is-on", !prefsPanel.hidden || !!muteRemainingMin());
    }

    let prefsSaveTimer = null;
    let prefsPatchPending = {};

    function queueElsePrefs(patch) {
      Object.assign(prefsPatchPending, patch || {});
      if (prefsSaveTimer) win.clearTimeout(prefsSaveTimer);
      prefsSaveTimer = win.setTimeout(() => {
        prefsSaveTimer = null;
        const pending = prefsPatchPending;
        prefsPatchPending = {};
        persistElsePrefs(pending);
      }, 160);
    }

    async function persistElsePrefs(patch) {
      const payload = Object.assign({
        else_proactive: proactiveOn,
        else_proactive_cadence: cadence,
        else_voice: voiceOn,
        else_address: elseAddress || "",
        else_topics_off: String(elseTopics || "").split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 5),
      }, patch || {});
      try {
        win.localStorage.setItem(LS_PROACTIVE, proactiveOn ? "1" : "0");
        win.localStorage.setItem(LS_VOICE, voiceOn ? "1" : "0");
        win.localStorage.setItem(LS_CADENCE, cadence);
      } catch (_) {}
      try {
        const out = await fetchJson(win, "/api/ai", withDevice(win, {
          action: "else",
          op: "prefs",
          save: true,
          prefs: payload,
        }));
        if (out && out.prefs) applyServerPrefs(out.prefs);
      } catch (_) {}
      syncPrefToggles();
      syncPrefsPanel();
    }

    function applyServerPrefs(prefs) {
      if (!prefs || typeof prefs !== "object") return;
      if ("else_proactive" in prefs) proactiveOn = prefs.else_proactive !== false;
      if (prefs.else_proactive_cadence === "quiet" || prefs.else_proactive_cadence === "normal" || prefs.else_proactive_cadence === "often") {
        cadence = prefs.else_proactive_cadence;
      }
      if ("else_voice" in prefs) voiceOn = prefs.else_voice === true;
      if ("else_address" in prefs) elseAddress = String(prefs.else_address || "");
      if (Array.isArray(prefs.else_topics_off)) elseTopics = prefs.else_topics_off.join("\n");
    }

    function publishMeter(meter) {
      if (!meter || typeof meter !== "object") return;
      if (sis && typeof sis.applyMeter === "function") {
        sis.applyMeter(meter);
        return;
      }
      updateSisterMeter({ meter });
    }

    function updateSisterMeter(detail) {
      const meter = (detail && detail.meter) || (sis && sis.__meter) || null;
      const tease = meter && meter.tease ? String(meter.tease) : "";
      sisterFavor = (meter && meter.favor) || "tie";
      sisterMeter.classList.toggle("is-else", sisterFavor === "else");
      sisterMeter.classList.toggle("is-transferania", sisterFavor === "transferania");
      sisterMeter.classList.toggle("is-tie", sisterFavor === "tie");
      if (favorPrimed && sisterFavor !== prevSisterFavor && sisterFavor !== "tie") {
        holdSister(5200);
        root.classList.add("is-favor-spike");
        win.setTimeout(() => root.classList.remove("is-favor-spike"), 1600);
      }
      prevSisterFavor = sisterFavor;
      favorPrimed = true;
      if (!tease || (!expanded && sisterBar.hidden)) {
        sisterMeter.hidden = true;
        return;
      }
      sisterMeter.hidden = false;
      sisterMeter.textContent = tease;
    }

    function openChipMenu(forceOpen) {
      if (!chipVisible) setChipVisible(true);
      if (forceOpen === true) chipMenu.hidden = false;
      else chipMenu.hidden = !chipMenu.hidden;
      if (!chipMenu.hidden) setMood("sister", 1200);
    }

    function closeChipMenu() {
      chipMenu.hidden = true;
    }

    async function handleChipMenu(action) {
      closeChipMenu();
      if (action === "hide") {
        setChipVisible(false);
        return;
      }
      if (action === "reset") {
        chipFloat.reset();
        toggleFloat.reset();
        return;
      }
      if (action === "bigger" && chipScale) {
        chipScale.bump(chipScale.menuStep || 0.08);
        return;
      }
      if (action === "smaller" && chipScale) {
        chipScale.bump(-(chipScale.menuStep || 0.08));
        return;
      }
      if (action === "scale_reset" && chipScale) {
        chipScale.resetScale();
        return;
      }
      if (action === "nudge") {
        if (sis && typeof sis.runNudge === "function" && !sisterBusy()) {
          setMood("sister", 1400);
          sis.runNudge({ toward: "transferania" });
        }
        return;
      }
      if (action === "memory") {
        toggleMemoryPanel(true);
      }
    }

    async function loadServerPrefs() {
      try {
        const out = await fetchJson(win, "/api/ai", withDevice(win, { action: "else", op: "prefs" }));
        if (out && out.prefs) applyServerPrefs(out.prefs);
        syncPrefToggles();
        syncPrefsPanel();
      } catch (_) {}
    }

    function lastHerLine() {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === "assistant" && m.text) return String(m.text);
      }
      return IDLE_LINE;
    }

    function renderLog() {
      log.replaceChildren();
      messages.forEach((m) => {
        if (!m || !m.text) return;
        const row = doc.createElement("div");
        const isUser = m.role === "user";
        row.className = "hq-else-msg " + (isUser ? "is-user" : "is-her");
        const body = doc.createElement("div");
        body.textContent = String(m.text);
        row.appendChild(body);
        if (!isUser && (m.model_label || m.model)) {
          const meta = doc.createElement("span");
          meta.className = "hq-else-msg-model";
          meta.textContent = String(m.model_label || m.model);
          meta.title = String(m.model || m.model_label || "");
          row.appendChild(meta);
        }
        log.appendChild(row);
      });
      log.scrollTop = log.scrollHeight;
    }

    function setExpanded(next) {
      expanded = !!next;
      root.classList.toggle("is-expanded", expanded);
      expandBtn.textContent = expanded ? "⤡" : "⤢";
      expandBtn.title = expanded ? "Réduire" : "Agrandir le chat";
      try { win.localStorage.setItem(LS_EXPANDED, expanded ? "1" : "0"); } catch (_) {}
      if (expanded) {
        renderLog();
        renderSisterStrip();
        if (sis) sis.loadHistory().then(() => renderSisterStrip()).catch(() => {});
        win.setTimeout(() => input.focus(), 30);
      } else {
        sisterStrip.hidden = true;
      }
    }

    function setOpen(next) {
      open = !!next;
      root.classList.toggle("is-open", open);
      try { win.localStorage.setItem(LS_OPEN, open ? "1" : "0"); } catch (_) {}
      if (open) {
        loadHistory().catch(() => {});
        if (expanded) {
          if (sis) sis.loadHistory().then(() => renderSisterStrip()).catch(() => {});
          win.setTimeout(() => input.focus(), 30);
        }
      }
    }

    async function loadHistory() {
      const out = await fetchJson(win, aiUrl(win, "else=1"));
      if (Array.isArray(out.messages)) {
        messages = out.messages.filter((m) => m && (m.role === "user" || m.role === "assistant"));
        renderLog();
        setLine(lastHerLine(), false);
      }
    }

    async function runSister(opts) {
      const o = opts || {};
      if (!sis) return { ok: false, error: "no_sister" };
      if (o.ambient) return sis.runAmbient();
      return sis.runExchange({
        topic: o.topic != null ? o.topic : (sisterTopic.value || "").trim(),
        openExpanded: !!o.openExpanded,
      });
    }

    function scheduleAmbientSister() {
      const jitter = () => AMBIENT_MIN_MS + Math.floor(Math.random() * AMBIENT_SPAN_MS);
      let timer = null;
      const arm = (delay) => {
        win.clearTimeout(timer);
        timer = win.setTimeout(tick, delay);
      };
      const tick = async () => {
        if (sis && !sis.ambientEnabled()) {
          arm(jitter());
          return;
        }
        const blocked = win.HqSisterCore && win.HqSisterCore.attentionBlocksBanter
          ? win.HqSisterCore.attentionBlocksBanter(win)
          : false;
        if (!doc.hidden && !blocked && !(sis && sis.isBusy())) {
          await runSister({ ambient: true });
        }
        arm(jitter());
      };
      arm(AMBIENT_FIRST_MS + Math.floor(Math.random() * 45000));
      doc.addEventListener("visibilitychange", () => {
        if (!doc.hidden) arm(45000 + Math.floor(Math.random() * 60000));
      });
    }

    function shortDigest() {
      try {
        if (win.HqCompanion && typeof win.HqCompanion.digest === "function") {
          return String(win.HqCompanion.digest(win) || "").replace(/\s+/g, " ").trim().slice(0, 120);
        }
      } catch (_) {}
      return "";
    }

    function attentionBlocksElse() {
      if (doc.hidden || !chipVisible || chatBusy || sisterBusy()) return true;
      if (muteUntil && Date.now() < muteUntil) return true;
      if (muteUntil && Date.now() >= muteUntil) setMuteMinutes(0);
      const view = (doc.body && doc.body.dataset.view) || "accueil";
      if (DND_VIEWS[view]) return true;
      try {
        const st = win.HqCompanion && win.HqCompanion.testIdle && win.HqCompanion.testIdle.state;
        if (st) {
          if (st.nsfwOn && st.expanded) return true;
          if (st.chatBusy || st.busy) return true;
        }
      } catch (_) {}
      if (win.HqSisterCore && win.HqSisterCore.attentionBlocksBanter
        && win.HqSisterCore.attentionBlocksBanter(win)) return true;
      return false;
    }

    async function runProactiveAside() {
      if (!proactiveOn || attentionBlocksElse()) return { skipped: true };
      const view = (doc.body && doc.body.dataset.view) || "accueil";
      try {
        const out = await fetchJson(win, "/api/ai", withDevice(win, {
          action: "else",
          op: "ambient",
          view,
          persona: "warm",
          digest: shortDigest() || undefined,
        }));
        if (out && out.skipped) return out;
        const line = String((out && (out.line || out.reply)) || "").trim();
        if (!line) return out || { ok: false };
        if (Array.isArray(out.messages)) {
          messages = out.messages.filter((m) => m && (m.role === "user" || m.role === "assistant"));
          renderLog();
        }
        // Presence only — peek the chip, don't force the bubble open.
        showPeek(line);
        setLine(line, false);
        speakElseQuiet(line);
        if (sis && typeof sis.handleElseLine === "function") {
          const sisterCue = /transferania|transferina|sœur|soeur|sister/i.test(line);
          sis.handleElseLine({ text: line, sister_cue: sisterCue, ambient: true, nsfw: !!(out && out.nsfw) });
        }
        return out;
      } catch (_) {
        return { ok: false };
      }
    }

    function scheduleProactiveElse() {
      const cadenceCfg = () => PROACTIVE_BY_CADENCE[cadence] || PROACTIVE_BY_CADENCE.normal;
      const jitter = () => {
        const cfg = cadenceCfg();
        return cfg.min + Math.floor(Math.random() * cfg.span);
      };
      let timer = null;
      const arm = (delay) => {
        win.clearTimeout(timer);
        timer = win.setTimeout(tick, delay);
      };
      const tick = async () => {
        if (proactiveOn && !attentionBlocksElse()) {
          await runProactiveAside();
        }
        arm(jitter());
      };
      const first = cadenceCfg().first;
      arm(first + Math.floor(Math.random() * Math.max(30000, first)));
      doc.addEventListener("visibilitychange", () => {
        if (!doc.hidden) arm(90000 + Math.floor(Math.random() * 120000));
      });
    }

    async function sendChat(ev) {
      if (ev) ev.preventDefault();
      if (chatBusy || sisterBusy()) return;
      const text = (input.value || "").trim();
      if (!text) return;
      if (!open) setOpen(true);
      if (!expanded) setExpanded(true);
      const view = (doc.body && doc.body.dataset.view) || "accueil";
      chatBusy = true;
      syncChromeBusy(true);
      messages.push({ role: "user", text });
      renderLog();
      input.value = "";
      try {
        const out = await fetchJson(win, "/api/ai", withDevice(win, {
          action: "else",
          op: "send",
          message: text,
          view,
          persona: "warm",
        }));
        if (Array.isArray(out.messages)) messages = out.messages;
        else if (out.reply) messages.push({ role: "assistant", text: out.reply });
        renderLog();
        const reply = out.reply || lastHerLine();
        setLine(reply, true);
        speakElseQuiet(reply);
        if (out && out.meter) publishMeter(out.meter);
        else updateSisterMeter(out);
        if (reply && sis && typeof sis.handleElseLine === "function") {
          const sisterCue = /transferania|transferina|sœur|soeur|sister/i.test(String(reply));
          sis.handleElseLine({ text: String(reply), sister_cue: sisterCue, nsfw: !!out.nsfw });
        }
      } catch (e) {
        messages.pop();
        renderLog();
        if (typeof win.hqToast === "function") {
          win.hqToast((e && e.message) || "Else indisponible", "err");
        }
      } finally {
        chatBusy = false;
        syncChromeBusy(false);
      }
    }

    let lastChipTap = 0;
    let chipPinchBlock = false;
    let chipScale = null;
    const chipFloat = bindFloatDrag(win, {
      el: chip,
      host: root,
      storageKey: LS_FLOAT,
      minVisible: 72,
      isBlocked: () => chipPinchBlock,
      onLongPress: () => openChipMenu(true),
      onMove: (dx, dy) => nudgeBust(dx, dy),
    });
    if (win.HqImageChipScale && typeof win.HqImageChipScale.bind === "function") {
      chipScale = win.HqImageChipScale.bind(win, {
        root,
        chip,
        storageKey: LS_CHIP_SCALE,
        setBlocked: (on) => { chipPinchBlock = !!on; },
        cancelDrag: () => chipFloat.cancelActiveDrag(),
      });
    }
    const toggleFloat = bindFloatDrag(win, {
      el: toggle,
      host: toggle,
      storageKey: LS_TOGGLE_FLOAT,
      minVisible: 36,
      onLongPress: () => openChipMenu(true),
    });

    chip.addEventListener("click", (ev) => {
      if (chipFloat.consumeClickSuppressed()) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      closeChipMenu();
      if (!open) {
        setOpen(true);
        return;
      }
      const now = Date.now();
      // Double-tap chip: soft sister nudge toward Transferania.
      if (now - lastChipTap < 550 && sis && typeof sis.runNudge === "function" && !sisterBusy()) {
        lastChipTap = 0;
        setMood("sister", 1400);
        sis.runNudge({ toward: "transferania" });
        return;
      }
      lastChipTap = now;
      setExpanded(!expanded);
    });

    toggle.addEventListener("click", (ev) => {
      if (toggleFloat.consumeClickSuppressed()) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      closeChipMenu();
      setChipVisible(!chipVisible);
    });
    chipMenu.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest("[data-action]") : null;
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      handleChipMenu(btn.dataset.action);
    });
    doc.addEventListener("pointerdown", (ev) => {
      if (chipMenu.hidden) return;
      if (chipMenu.contains(ev.target) || chip.contains(ev.target) || toggle.contains(ev.target)) return;
      closeChipMenu();
    });
    closeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setOpen(false);
    });
    expandBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setExpanded(!expanded);
      if (expanded) updateSisterMeter();
    });
    prefsBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeChipMenu();
      togglePrefsPanel();
      prefsBtn.classList.toggle("is-on", !prefsPanel.hidden || !!muteRemainingMin());
    });
    prefsPanel.addEventListener("change", (ev) => {
      const t = ev.target;
      if (!t || !t.getAttribute) return;
      const key = t.getAttribute("data-else-pref");
      if (!key) return;
      if (key === "ambient") {
        if (sis) sis.setAmbient(!!t.checked, true);
        syncPrefToggles();
      } else if (key === "react") {
        if (sis) sis.setReact(!!t.checked, true);
        syncPrefToggles();
      } else if (key === "proactive") setProactive(!!t.checked);
      else if (key === "cadence") setCadence(t.value);
      else if (key === "voice") setVoice(!!t.checked);
      else if (key === "mute") setMuteMinutes(t.value);
      else if (key === "address") {
        elseAddress = String(t.value || "");
        queueElsePrefs({ else_address: elseAddress });
      }
    });
    prefsPanel.addEventListener("focusout", (ev) => {
      if (!prefsPanel.contains(ev.relatedTarget)) {
        const topics = prefsPanel.querySelector('[data-else-pref="topics"]');
        if (topics && String(topics.value || "") !== elseTopics) {
          elseTopics = String(topics.value || "");
          queueElsePrefs({});
        }
      }
    });
    memoryForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const text = (memoryInput.value || "").trim();
      if (!text) return;
      memoryAdd.disabled = true;
      try {
        await fetchJson(win, "/api/ai", withDevice(win, {
          action: "else",
          op: "memory_remember",
          text,
        }));
        memoryInput.value = "";
        await loadMemory();
        setMood("listening", 1200);
      } catch (e) {
        if (typeof win.hqToast === "function") {
          win.hqToast((e && e.message) || "Mémoire indisponible", "err");
        }
      } finally {
        memoryAdd.disabled = false;
      }
    });
    sisterBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeChipMenu();
      sisterBar.hidden = !sisterBar.hidden;
      sisterBtn.classList.toggle("is-on", !sisterBar.hidden);
      if (!sisterBar.hidden) {
        if (!open) setOpen(true);
        updateSisterMeter();
        sisterTopic.focus();
      } else {
        updateSisterMeter();
      }
    });
    sisterGo.addEventListener("click", (ev) => {
      ev.stopPropagation();
      runSister({ ambient: false }).then((out) => updateSisterMeter(out));
    });
    sisterNudge.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!sis || typeof sis.runNudge !== "function" || sisterBusy()) return;
      setMood("sister", 1200);
      sis.runNudge({ toward: "else" });
    });
    form.addEventListener("submit", sendChat);

    let typingHoldTimer = null;
    function refreshTypingHold(immediate) {
      const run = () => {
        typingHoldTimer = null;
        if (doc.activeElement === input || (input.value || "").trim()) {
          setHold("typing", "listening", Date.now() + 5000);
        } else {
          clearHold("typing");
        }
        paintMood();
      };
      if (immediate) {
        if (typingHoldTimer) win.clearTimeout(typingHoldTimer);
        typingHoldTimer = null;
        run();
        return;
      }
      if (typingHoldTimer) return;
      typingHoldTimer = win.setTimeout(run, 120);
    }
    input.addEventListener("focus", () => {
      setHold("typing", "listening", null);
      paintMood();
      fireMicro("think");
    });
    input.addEventListener("blur", () => {
      refreshTypingHold(true);
    });
    input.addEventListener("input", () => {
      refreshTypingHold(false);
      if ((input.value || "").trim().length === 1) fireMicro("glance");
    });

    if (!win.__hqElseBusBound) {
      win.__hqElseBusBound = true;
      win.addEventListener("hq-sister-open", (ev) => {
        const detail = (ev && ev.detail) || {};
        ensureChipVisible();
        setOpen(true);
        if (detail.expanded) setExpanded(true);
      });
      win.addEventListener("hq-sister-line", (ev) => {
        const detail = (ev && ev.detail) || {};
        if (detail.speaker === "else" && detail.text) {
          if (!chipVisible) {
            if (!detail.ambient) ensureChipVisible();
            else pulseToggle(1600, String(detail.text));
          }
          if (!open) {
            // Ambient/react: keep bubble closed; chip peek carries presence.
            if (detail.ambient) {
              showPeek(String(detail.text));
              if (chipVisible) setLine(String(detail.text), false, { speakVisual: false });
            } else {
              ensureChipVisible();
              setOpen(true);
              setLine(String(detail.text), true, { speakVisual: true });
              speakElseQuiet(detail.text);
            }
          } else if (chipVisible) {
            if (detail.ambient) {
              setLine(String(detail.text), false, { speakVisual: false });
            } else {
              setLine(String(detail.text), true, { speakVisual: true });
              speakElseQuiet(detail.text);
            }
          }
          // Speech hold already owns speaking; ambient must land as proactive flash.
          if (detail.ambient) setMood("proactive", 2200);
        } else if (detail.speaker === "transferania") {
          setMood("sister", 1400);
        }
        renderSisterStrip();
        updateSisterMeter(detail);
      });
      win.addEventListener("hq-sister-peek", (ev) => {
        const detail = (ev && ev.detail) || {};
        if (!detail.text) return;
        showPeek(String(detail.text));
      });
      win.addEventListener("hq-sister-history", (ev) => {
        renderSisterStrip();
        updateSisterMeter(ev && ev.detail);
      });
      win.addEventListener("hq-sister-meter", (ev) => updateSisterMeter(ev && ev.detail));
      win.addEventListener("hq-sister-prefs", () => syncPrefToggles());
      win.addEventListener("hq-transferania-line", () => pulseListening(1800));
      win.addEventListener("hq-sister-glance", (ev) => {
        const to = ev && ev.detail && ev.detail.to;
        if (to && to !== "else") return;
        if (!chipVisible) {
          pulseToggle(900);
          return;
        }
        root.classList.add("is-glance");
        pulseListening(ev && ev.detail && ev.detail.soft ? 900 : 1400);
        win.setTimeout(() => root.classList.remove("is-glance"), 900);
      });
      win.addEventListener("hq-sister-event", (ev) => {
        const detail = (ev && ev.detail) || {};
        applySisterEventChip(detail);
        if (!chipVisible) {
          pulseToggle(1600, detail.label || detail.id || "");
        } else {
          root.classList.add("is-event");
          setMood("sister", 1800);
          pulseListening(1600);
          win.setTimeout(() => root.classList.remove("is-event"), 1800);
        }
        // Soft glance toward Transferania so both chips feel the beat.
        try {
          win.dispatchEvent(new CustomEvent("hq-sister-glance", {
            detail: { from: "else", to: "transferania", event: true, soft: true, id: detail.id },
          }));
        } catch (_) {}
      });
      win.addEventListener("hq-sister-nudge", (ev) => {
        const detail = (ev && ev.detail) || {};
        if (!chipVisible) {
          pulseToggle(1200, detail.peek && detail.peek.text);
          return;
        }
        root.classList.add("is-nudge");
        setMood("sister", 1200);
        pulseListening(1200);
        if (detail.peek && detail.peek.speaker === "else" && detail.peek.text) {
          showPeek(String(detail.peek.text));
        }
        win.setTimeout(() => root.classList.remove("is-nudge"), 1200);
      });
      win.addEventListener("hq-sister-busy", (ev) => {
        syncChromeBusy(!!(ev && ev.detail && ev.detail.busy));
      });
    }

    win.HqElse = {
      open: (opts) => {
        ensureChipVisible();
        setOpen(true);
        if (opts && opts.expanded) setExpanded(true);
      },
      setLine: (text, animate) => setLine(text, animate !== false),
      runSister: (opts) => runSister(opts || {}),
      nudge: (opts) => (sis && sis.runNudge ? sis.runNudge(opts || {}) : Promise.resolve({ ok: false })),
      setAmbient: (on) => {
        if (sis) sis.setAmbient(on, true);
        syncPrefToggles();
      },
      setReact: (on) => {
        if (sis) sis.setReact(on, true);
        syncPrefToggles();
      },
      setProactive: (on) => setProactive(on),
      proactiveEnabled: () => proactiveOn,
      setVoice: (on) => setVoice(on),
      voiceEnabled: () => voiceOn,
      setCadence: (c) => setCadence(c),
      cadence: () => cadence,
      setMood: (m, ms) => setMood(m, ms),
      mood: () => currentMood,
      runProactive: () => runProactiveAside(),
      react: (trigger, speaker) => (sis ? sis.runReact(trigger, speaker) : Promise.resolve({ ok: false })),
      resetFloat: (opts) => chipFloat.reset(opts || {}),
      resetToggleFloat: (opts) => toggleFloat.reset(opts || {}),
      setChipScale: (s) => (chipScale ? chipScale.setScale(s) : 1),
      chipScale: () => (chipScale ? chipScale.getScale() : 1),
      resetChipScale: () => (chipScale ? chipScale.resetScale() : 1),
      getFloat: () => chipFloat.getPos(),
      getToggleFloat: () => toggleFloat.getPos(),
      setVisible: (on) => setChipVisible(on !== false),
      isVisible: () => chipVisible,
      isOpen: () => open,
      peek: showPeek,
      speakQuiet: speakElseQuiet,
      updateMeter: updateSisterMeter,
      openMenu: (force) => openChipMenu(force !== false),
      setMuteMinutes: (m) => setMuteMinutes(m),
      muteRemainingMin: () => muteRemainingMin(),
      root,
      toggle,
    };

    try {
      if (win.localStorage.getItem(LS_VISIBLE) === "0") setChipVisible(false, { force: true });
      else setChipVisible(true, { force: true });
      if (chipVisible && win.localStorage.getItem(LS_EXPANDED) === "1") setExpanded(true);
      if (chipVisible && win.localStorage.getItem(LS_OPEN) === "1") setOpen(true);
    } catch (_) {}
    syncPrefToggles();
    syncPrefsPanel();
    if (win.HqImageChipScale && typeof win.HqImageChipScale.bindPortraitMode === "function") {
      win.HqImageChipScale.bindPortraitMode(win, {
        root,
        onRefresh: () => applyPortrait(currentMood),
      });
    }
    setMood("idle");
    syncContextMood();
    syncMotionPerf();
    ensureBustLoop();
    scheduleAliveIdle();
    win.addEventListener("hq:motion-mode", scheduleSyncMotionPerf);
    doc.addEventListener("visibilitychange", () => {
      syncMotionPerf();
      if (doc.hidden) {
        stopLipSync();
        if (!speechActive) clearHold("speech");
      }
    });
    try {
      new win.MutationObserver((muts) => {
        let view = false;
        let cls = false;
        for (let i = 0; i < muts.length; i++) {
          const a = muts[i] && muts[i].attributeName;
          if (a === "data-view") view = true;
          else if (a === "class") cls = true;
        }
        if (cls) scheduleSyncMotionPerf();
        if (view) syncContextMood();
      }).observe(doc.body, {
        attributes: true,
        attributeFilter: ["class", "data-view"],
      });
    } catch (_) {}
    loadServerPrefs();
    updateSisterMeter();
    scheduleAmbientSister();
    scheduleProactiveElse();
  }

  function boot() {
    const win = window;
    const start = () => mount(win);
    if (win.document.readyState === "loading") {
      win.document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  boot();
})();
