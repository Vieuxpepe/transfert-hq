/* Transfert HQ — Inventoria image chip (forge portrait; left dock, sister layout to Else). */
(function () {
  "use strict";

  const PORTRAIT = "/assets/companion/inventoria-chip.webp";
  const PORTRAIT_2X = "/assets/companion/inventoria-chip@2x.webp";
  const PORTRAIT_BY_MOOD = {
    idle: { src: PORTRAIT, srcset: PORTRAIT + " 1x, " + PORTRAIT_2X + " 2x" },
    listening: {
      src: "/assets/companion/inventoria-chip-listening.webp",
      srcset: "/assets/companion/inventoria-chip-listening.webp 1x, /assets/companion/inventoria-chip-listening@2x.webp 2x",
    },
    speaking: {
      src: "/assets/companion/inventoria-chip-speaking.webp",
      srcset: "/assets/companion/inventoria-chip-speaking.webp 1x, /assets/companion/inventoria-chip-speaking@2x.webp 2x",
    },
    proactive: {
      src: "/assets/companion/inventoria-chip-proactive.webp",
      srcset: "/assets/companion/inventoria-chip-proactive.webp 1x, /assets/companion/inventoria-chip-proactive@2x.webp 2x",
    },
    busy: {
      src: "/assets/companion/inventoria-chip-busy.webp",
      srcset: "/assets/companion/inventoria-chip-busy.webp 1x, /assets/companion/inventoria-chip-busy@2x.webp 2x",
    },
    sister: {
      src: "/assets/companion/inventoria-chip-sister.webp",
      srcset: "/assets/companion/inventoria-chip-sister.webp 1x, /assets/companion/inventoria-chip-sister@2x.webp 2x",
    },
  };
  const PORTRAIT_SFW_BY_MOOD = {
    idle: {
      src: "/assets/companion/inventoria-chip-sfw.webp",
      srcset: "/assets/companion/inventoria-chip-sfw.webp 1x, /assets/companion/inventoria-chip-sfw@2x.webp 2x",
    },
    listening: {
      src: "/assets/companion/inventoria-chip-listening-sfw.webp",
      srcset: "/assets/companion/inventoria-chip-listening-sfw.webp 1x, /assets/companion/inventoria-chip-listening-sfw@2x.webp 2x",
    },
    speaking: {
      src: "/assets/companion/inventoria-chip-speaking-sfw.webp",
      srcset: "/assets/companion/inventoria-chip-speaking-sfw.webp 1x, /assets/companion/inventoria-chip-speaking-sfw@2x.webp 2x",
    },
    proactive: {
      src: "/assets/companion/inventoria-chip-proactive-sfw.webp",
      srcset: "/assets/companion/inventoria-chip-proactive-sfw.webp 1x, /assets/companion/inventoria-chip-proactive-sfw@2x.webp 2x",
    },
    busy: {
      src: "/assets/companion/inventoria-chip-busy-sfw.webp",
      srcset: "/assets/companion/inventoria-chip-busy-sfw.webp 1x, /assets/companion/inventoria-chip-busy-sfw@2x.webp 2x",
    },
    sister: {
      src: "/assets/companion/inventoria-chip-sister-sfw.webp",
      srcset: "/assets/companion/inventoria-chip-sister-sfw.webp 1x, /assets/companion/inventoria-chip-sister-sfw@2x.webp 2x",
    },
  };
  const MOODS = ["idle", "listening", "speaking", "proactive", "sister", "busy"];
  const LS_OPEN = "hq_inventoria_chip_open_v1";
  const LS_FLOAT = "hq_inventoria_chip_float_v1";
  const LS_VISIBLE = "hq_inventoria_chip_visible_v1";
  const LS_TOGGLE_FLOAT = "hq_inventoria_toggle_float_v1";
  const LS_CHIP_SCALE = "hq_inventoria_chip_scale_v1";
  const IDLE_LINE = "Forge, stocks et courses — prête quand tu ouvres le panneau.";
  const DRAG_THRESHOLD_PX = 8;
  const LONG_PRESS_RESET_MS = 700;

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
        x: clampNum(parsed && parsed.x, -1600, 1600),
        y: clampNum(parsed && parsed.y, -1600, 160),
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

  function clampFloatLeft(win, x, y, minVisible) {
    const vw = win.innerWidth || 800;
    const vh = win.innerHeight || 640;
    const pad = Math.max(28, Number(minVisible) || 48);
    return {
      x: clampNum(x, -28, vw - pad),
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
      const next = clampFloatLeft(win, pos.x, pos.y, minVisible);
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
      pos.x = drag.origX + dx;
      pos.y = drag.origY + dy;
      apply();
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

  function sessionAdmin(win) {
    try {
      if (typeof win.hqSessionIsAdmin === "function") return !!win.hqSessionIsAdmin();
    } catch (_) {}
    return true;
  }

  function mount(win) {
    const doc = win.document;
    if (doc.getElementById("hq-inventoria")) return;
    if (!sessionAdmin(win)) return;

    // --- icons: small stroke set for the chrome (24x24, currentColor); item icons come from HqHouseholdIcons when loaded.
    const ICONS = {
      chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
      cart: "M3 5h2l2.2 10.5h10.3L19.5 8H6.2M9.5 19.5h.01M17 19.5h.01",
      sliders: "M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M8 15v4",
      camera: "M4 8h3l1.5-2h7L17 8h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
      mic: "M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zM6 11a6 6 0 0 0 12 0M12 17v3",
      send: "M4 12l16-8-6 16-2.5-6.5zM11.5 13.5L20 4",
      copy: "M8 8h11v12H8zM5 16V4h11",
      share: "M12 15V4M8 8l4-4 4 4M5 13v7h14v-7",
      check: "M5 12.5l4.5 4.5L19 7.5",
      x: "M6 6l12 12M18 6L6 18",
      undo: "M9 8L4 13l5 5M4 13h9a6 6 0 0 1 0 6h-3",
      alert: "M12 4l9 16H3zM12 10v4M12 17.5h.01",
      trend: "M3 7l6 6 4-4 8 8M21 17v-5M21 17h-5",
      clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
      bell: "M6 17v-6a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4",
      plus: "M12 5v14M5 12h14",
      minus: "M5 12h14",
      arrow: "M5 12h14M13 6l6 6-6 6",
      box: "M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8",
      sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z",
      speaker: "M4 10v4h3l5 4V6L7 10zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11",
      note: "M6 4h9l3 3v13H6zM9 11h6M9 15h6",
      eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
      list: "M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9",
      image: "M4 5h16v14H4zM8.5 10h.01M4 17l5-5 4 4 3-3 4 4",
      store: "M4 9l1-5h14l1 5M4 9v11h16V9M9 20v-6h6v6",
    };
    const ico = (name, cls) => {
      const NS = "http://www.w3.org/2000/svg";
      const svg = doc.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      svg.setAttribute("class", "hq-inv-ico" + (cls ? " " + cls : ""));
      const path = doc.createElementNS(NS, "path");
      path.setAttribute("d", ICONS[name] || ICONS.sparkle);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.8");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
      return svg;
    };
    // Put an icon in front of a button/summary label. Later `el.textContent = ...` assignments keep working (they update the label only).
    const decorate = (el, name, iconOnly) => {
      const text = el.textContent;
      el.textContent = "";
      const lbl = doc.createElement("span");
      lbl.className = "hq-inv-lbl" + (iconOnly ? " is-hidden" : "");
      lbl.textContent = text;
      el.append(ico(name), lbl);
      Object.defineProperty(el, "textContent", {
        configurable: true,
        get() { return lbl.textContent; },
        set(v) { lbl.textContent = v; },
      });
      if (iconOnly) el.classList.add("is-icon");
      return el;
    };
    const lsGet = (k) => { try { return win.localStorage.getItem(k); } catch (_) { return null; } };
    const lsSet = (k, v) => { try { win.localStorage.setItem(k, v); } catch (_) {} };
    const PHOTO_OK = "hq_inventoria_photo_ok", PHOTO_OFF = "hq_inventoria_photos_off", RESOLVED_AT = "hq_inv_resolved_at";
    const photosOn = () => lsGet(PHOTO_OFF) !== "1";
    const itemBadge = (name, size) => {
      const H = win.HqHouseholdIcons;
      if (!H || typeof H.resolveItem !== "function" || typeof H.badge !== "function") return null;
      try {
        const b = H.badge(doc, H.resolveItem(String(name || "")));
        if (!b) return null;
        b.style.setProperty("--hh-ico-size", (size || 26) + "px");
        b.classList.add("hq-inventoria-itemico");
        return b;
      } catch (_) { return null; }
    };

    const root = doc.createElement("div");
    root.id = "hq-inventoria";
    root.className = "hq-inventoria";

    const bubble = doc.createElement("div");
    bubble.className = "hq-inventoria-bubble";
    bubble.setAttribute("role", "dialog");
    bubble.setAttribute("aria-label", "Inventoria");

    const head = doc.createElement("div");
    head.className = "hq-inventoria-head";
    const title = doc.createElement("span");
    title.className = "hq-inventoria-title";
    title.textContent = "Inventoria";
    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "hq-inventoria-head-btn";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Fermer");
    head.append(title, closeBtn);

    const line = doc.createElement("p");
    line.className = "hq-inventoria-line";
    line.textContent = IDLE_LINE;
    const showLine = (t) => { line.textContent = t; line.hidden = false; };

    // Chat with Inventoria (Gemini via the bridge). Session id is kept per browser; history lives server-side.
    const chatForm = doc.createElement("form");
    chatForm.className = "hq-inventoria-chat";
    const chatInput = doc.createElement("input");
    chatInput.type = "text";
    chatInput.className = "hq-inventoria-chat-input";
    chatInput.maxLength = 1000;
    chatInput.placeholder = "Demande à Inventoria…";
    chatInput.setAttribute("aria-label", "Message pour Inventoria");
    const chatSend = doc.createElement("button");
    chatSend.type = "submit";
    chatSend.className = "hq-inventoria-chat-send";
    chatSend.textContent = "Envoyer";
    decorate(chatSend, "send");
    const voiceLabel = doc.createElement("label");
    voiceLabel.className = "hq-inventoria-chat-voice";
    const voiceBox = doc.createElement("input");
    voiceBox.type = "checkbox";
    voiceBox.checked = true;
    try { voiceBox.checked = win.localStorage.getItem("hq_inventoria_voice") !== "0"; } catch (_) {}
    voiceBox.addEventListener("change", () => {
      try { win.localStorage.setItem("hq_inventoria_voice", voiceBox.checked ? "1" : "0"); } catch (_) {}
      if (!voiceBox.checked) stopVoice();
    });
    voiceLabel.append(voiceBox, ico("speaker"), doc.createTextNode(" Voix"));
    chatForm.append(chatInput, chatSend);
    head.insertBefore(voiceLabel, closeBtn);  // header row: the bottom edge is covered by the panel toggle

    const noticeBox = doc.createElement("div");
    noticeBox.className = "hq-inventoria-draft hq-inventoria-notice";
    noticeBox.hidden = true;
    noticeBox.setAttribute("role", "alert");
    const detBox = doc.createElement("div");
    detBox.className = "hq-inventoria-draft hq-inventoria-detect";
    detBox.hidden = true;
    const groceryBox = doc.createElement("div");
    groceryBox.className = "hq-inventoria-draft hq-inventoria-grocery";
    groceryBox.hidden = true;
    const photoSheet = doc.createElement("div");
    photoSheet.className = "hq-inventoria-photo-sheet";
    photoSheet.hidden = true;
    const draftBox = doc.createElement("div");
    draftBox.className = "hq-inventoria-draft";
    draftBox.hidden = true;

    // Her conversation (restored from the session after a reload) and the notes she remembers about the Master.
    const threadBox = doc.createElement("details");
    threadBox.className = "hq-inventoria-thread";
    const threadSum = doc.createElement("summary");
    threadSum.textContent = "Conversation";
    const threadLog = doc.createElement("div");
    threadLog.className = "hq-inventoria-thread-log";
    threadBox.append(threadSum, threadLog);
    const memoryBox = doc.createElement("details");
    memoryBox.className = "hq-inventoria-memory";
    const memorySum = doc.createElement("summary");
    memorySum.textContent = "Ce qu'elle retient";
    decorate(memorySum, "note");
    const memoryList = doc.createElement("ul");
    memoryList.className = "hq-inventoria-memory-list";
    memoryBox.append(memorySum, memoryList);

    const alertBox = doc.createElement("div");
    alertBox.className = "hq-inventoria-alerts";
    alertBox.hidden = true;
    const watchBox = doc.createElement("details");
    watchBox.className = "hq-inventoria-watches";
    const watchSum = doc.createElement("summary");
    watchSum.textContent = "Surveillances";
    decorate(watchSum, "eye");
    const watchList = doc.createElement("ul");
    watchList.className = "hq-inventoria-memory-list";
    watchBox.append(watchSum, watchList);

    // Copy block: everything to buy as plain text, to paste into a note (iPhone Notes) yourself.
    const copyBox = doc.createElement("details");
    copyBox.className = "hq-inventoria-copy";
    copyBox.hidden = true;
    const copySum = doc.createElement("summary");
    copySum.textContent = "Liste à copier";
    decorate(copySum, "list");
    const shopText = doc.createElement("textarea");
    shopText.className = "hq-inventoria-copy-text";
    shopText.readOnly = true;
    shopText.rows = 7;
    shopText.setAttribute("aria-label", "Liste de courses à copier");
    const soonLabel = doc.createElement("label");
    soonLabel.className = "hq-inventoria-copy-soon";
    const soonBox = doc.createElement("input");
    soonBox.type = "checkbox";
    soonBox.checked = true;
    try { soonBox.checked = win.localStorage.getItem("hq_inventoria_copy_soon") !== "0"; } catch (_) {}
    const soonText = doc.createTextNode(" Inclure « bientôt bas »");
    soonLabel.append(soonBox, soonText);
    const copyBtn = doc.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "hq-inventoria-copy-btn";
    copyBtn.textContent = "Copier";
    decorate(copyBtn, "copy");
    const copyNote = doc.createElement("span");
    copyNote.className = "hq-inventoria-copy-note";
    copyNote.setAttribute("role", "status");
    const shareBtn = doc.createElement("button");
    shareBtn.type = "button"; shareBtn.className = "hq-inventoria-copy-btn"; shareBtn.textContent = "Partager";
    decorate(shareBtn, "share");
    shareBtn.hidden = !(win.navigator && typeof win.navigator.share === "function");
    const groceryBtn = doc.createElement("button");
    groceryBtn.type = "button"; groceryBtn.className = "hq-inventoria-copy-btn"; groceryBtn.textContent = "Envoyer vers Courses";
    decorate(groceryBtn, "cart");
    const groupLabel = doc.createElement("label");
    groupLabel.className = "hq-inventoria-copy-soon";
    const groupBox = doc.createElement("input");
    groupBox.type = "checkbox";
    try { groupBox.checked = win.localStorage.getItem("hq_inventoria_copy_group") === "1"; } catch (_) {}
    const groupText = doc.createTextNode(" Grouper par magasin");
    groupLabel.append(groupBox, groupText);
    groupLabel.hidden = true;
    const copyRow = doc.createElement("div");
    copyRow.className = "hq-inventoria-copy-row";
    copyRow.append(copyBtn, shareBtn, groceryBtn, soonLabel, groupLabel, copyNote);
    const checkTitle = doc.createElement("p");
    checkTitle.className = "hq-inventoria-check-title";
    const checkList = doc.createElement("ul");
    checkList.className = "hq-inventoria-checks";
    const boughtBtn = doc.createElement("button");
    boughtBtn.type = "button"; boughtBtn.className = "hq-inventoria-copy-btn is-primary"; boughtBtn.disabled = true;
    decorate(boughtBtn, "check");
    copyBox.append(copySum, shopText, copyRow, checkTitle, checkList, boughtBtn);

    // Offline alerts (morning digest + instant ping through HQ's Discord / push). Off until switched on here.
    const notifyBox = doc.createElement("details");
    notifyBox.className = "hq-inventoria-notify";
    const notifySum = doc.createElement("summary");
    notifySum.textContent = "Alertes hors ligne";
    decorate(notifySum, "bell");
    const notifyOn = doc.createElement("input");
    notifyOn.type = "checkbox";
    const notifyOnLab = doc.createElement("label");
    notifyOnLab.append(notifyOn, doc.createTextNode(" Prévenir même quand HQ est fermé"));
    const notifyInstant = doc.createElement("input");
    notifyInstant.type = "checkbox";
    const notifyInstantLab = doc.createElement("label");
    notifyInstantLab.append(notifyInstant, doc.createTextNode(" Ping dès qu'un article devient bas"));
    const notifyHour = doc.createElement("select");
    notifyHour.setAttribute("aria-label", "Heure du résumé du matin");
    for (let h = 0; h < 24; h++) { const o = doc.createElement("option"); o.value = String(h); o.textContent = (h < 10 ? "0" : "") + h + " h"; notifyHour.appendChild(o); }
    const notifyHourLab = doc.createElement("label");
    notifyHourLab.append(doc.createTextNode("Résumé du matin à "), notifyHour);
    const notifyTest = doc.createElement("button");
    notifyTest.type = "button"; notifyTest.textContent = "Tester";
    decorate(notifyTest, "bell");
    const notifyNote = doc.createElement("p");
    notifyNote.className = "hq-inventoria-copy-note";
    notifyNote.textContent = "Envoyé par le webhook Discord et les notifications push déjà configurés dans HQ.";
    notifyBox.append(notifySum, notifyOnLab, notifyInstantLab, notifyHourLab, notifyTest, notifyNote);

    // --- layout: three tabs. Discuter (thread, quick actions, draft review, input) / À acheter (alerts, list, tick-off) / Réglages.
    const tabsEl = doc.createElement("div");
    tabsEl.className = "hq-inventoria-tabs";
    tabsEl.setAttribute("role", "tablist");
    tabsEl.setAttribute("aria-label", "Sections d'Inventoria");
    const mkTab = (id, label, icon) => {
      const b = doc.createElement("button");
      b.type = "button"; b.id = "hq-inv-tab-" + id; b.className = "hq-inventoria-tab"; b.dataset.tab = id;
      b.setAttribute("role", "tab"); b.setAttribute("aria-controls", "hq-inv-pane-" + id);
      b.textContent = label;
      return decorate(b, icon);
    };
    const mkPane = (id) => {
      const d = doc.createElement("div");
      d.id = "hq-inv-pane-" + id; d.className = "hq-inventoria-pane"; d.dataset.pane = id;
      d.setAttribute("role", "tabpanel"); d.setAttribute("aria-labelledby", "hq-inv-tab-" + id);
      return d;
    };
    const tabChat = mkTab("chat", "Discuter", "chat"), tabShop = mkTab("shop", "À acheter", "cart"), tabSet = mkTab("settings", "Réglages", "sliders");
    const shopBadge = doc.createElement("span");
    shopBadge.className = "hq-inventoria-badge"; shopBadge.hidden = true;
    tabShop.appendChild(shopBadge);
    tabsEl.append(tabChat, tabShop, tabSet);
    const paneChat = mkPane("chat"), paneShop = mkPane("shop"), paneSet = mkPane("settings");
    threadLog.setAttribute("role", "log");
    threadLog.setAttribute("aria-live", "polite");
    threadLog.setAttribute("aria-label", "Conversation");
    const quickBox = doc.createElement("div");
    quickBox.className = "hq-inventoria-quick";
    const shopEmpty = doc.createElement("p");
    shopEmpty.className = "hq-inventoria-shop-empty";
    decorate(shopEmpty, "check");
    shopEmpty.hidden = true;
    copyBox.open = true; watchBox.open = true; notifyBox.open = true; memoryBox.open = true;
    paneChat.append(threadLog, noticeBox, draftBox, detBox, groceryBox, photoSheet, quickBox, chatForm);
    paneShop.append(alertBox, shopEmpty, copyBox);
    // Photos: what leaves the machine, and an off switch.
    const photoSet = doc.createElement("details");
    photoSet.className = "hq-inventoria-photoset";
    photoSet.open = true;
    const photoSetSum = doc.createElement("summary");
    photoSetSum.textContent = "Photos";
    decorate(photoSetSum, "camera");
    const photoOnLab = doc.createElement("label");
    const photoOnBox = doc.createElement("input");
    photoOnBox.type = "checkbox";
    photoOnLab.append(photoOnBox, doc.createTextNode(" Autoriser l'envoi de photos à Inventoria"));
    const photoPriv = doc.createElement("p");
    photoPriv.className = "hq-inventoria-copy-note";
    photoPriv.textContent = "Une photo est envoyée à Google (Gemini, avec ta clé d'API) pour être analysée. HQ ne la conserve pas : seule une empreinte "
      + "non réversible sert à repérer un doublon pendant 30 jours. Les métadonnées (position GPS...) sont retirées avant l'envoi. "
      + "Évite cartes bancaires, adresses et pièces d'identité ; un ticket peut montrer des chiffres de carte : recadre-le au besoin.";
    const photoReset = doc.createElement("button");
    photoReset.type = "button"; photoReset.textContent = "Revoir l'avis au prochain envoi";
    photoSet.append(photoSetSum, photoOnLab, photoPriv, photoReset);
    paneSet.append(watchBox, notifyBox, photoSet, memoryBox);
    bubble.append(head, line, tabsEl, paneChat, paneShop, paneSet);
    const TABS = [["chat", tabChat, paneChat], ["shop", tabShop, paneShop], ["settings", tabSet, paneSet]];
    let activeTab = "chat";
    const selectTab = (id, focus) => {
      if (!TABS.some((t) => t[0] === id)) id = "chat";
      activeTab = id;
      TABS.forEach(([k, tab, pane]) => {
        const on = k === id;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.tabIndex = on ? 0 : -1;
        pane.hidden = !on;
        if (on && focus) tab.focus();
      });
      if (id === "shop") tabShop.classList.remove("is-new");
      if (id === "chat") threadLog.scrollTop = threadLog.scrollHeight;
      try { win.localStorage.setItem("hq_inventoria_tab", id); } catch (_) {}
    };
    tabsEl.addEventListener("click", (ev) => { const b = ev.target.closest("[data-tab]"); if (b) selectTab(b.dataset.tab); });
    tabsEl.addEventListener("keydown", (ev) => {
      const ids = TABS.map((t) => t[0]), i = ids.indexOf(activeTab);
      const to = ev.key === "ArrowRight" ? ids[(i + 1) % ids.length] : ev.key === "ArrowLeft" ? ids[(i + ids.length - 1) % ids.length]
        : ev.key === "Home" ? ids[0] : ev.key === "End" ? ids[ids.length - 1] : null;
      if (to) { ev.preventDefault(); selectTab(to, true); }
    });
    let initialTab = "chat";
    try { initialTab = win.localStorage.getItem("hq_inventoria_tab") || "chat"; } catch (_) {}
    selectTab(initialTab);

    const chipMenu = doc.createElement("div");
    chipMenu.className = "hq-inventoria-chip-menu";
    chipMenu.hidden = true;
    chipMenu.setAttribute("role", "menu");
    [
      { id: "hide", label: "Masquer" },
      { id: "bigger", label: "Agrandir" },
      { id: "smaller", label: "Réduire" },
      { id: "scale_reset", label: "Taille normale" },
      { id: "mood_idle", label: "Humeur · forge" },
      { id: "mood_listening", label: "Humeur · écoute" },
      { id: "mood_speaking", label: "Humeur · parole" },
      { id: "mood_proactive", label: "Humeur · proactive" },
      { id: "mood_busy", label: "Humeur · occupée" },
      { id: "mood_sister", label: "Humeur · accueil" },
      { id: "mood_cycle", label: "Humeur suivante" },
      { id: "reset", label: "Reset position" },
    ].forEach((item) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "hq-inventoria-chip-menu-item";
      btn.dataset.action = item.id;
      btn.textContent = item.label;
      btn.setAttribute("role", "menuitem");
      chipMenu.appendChild(btn);
    });

    const chip = doc.createElement("button");
    chip.type = "button";
    chip.className = "hq-inventoria-chip";
    chip.title = "Inventoria — glisser · pincement ou Ctrl+molette = taille · appui long = menu";
    chip.setAttribute("aria-label", "Inventoria — ouvrir ou déplacer");
    const ring = doc.createElement("span");
    ring.className = "hq-inventoria-chip-ring";
    ring.setAttribute("aria-hidden", "true");
    const img = doc.createElement("img");
    img.className = "hq-inventoria-chip-avatar";
    img.src = PORTRAIT;
    img.srcset = PORTRAIT + " 1x, " + PORTRAIT_2X + " 2x";
    img.alt = "Inventoria";
    img.decoding = "async";
    img.loading = "lazy";
    img.draggable = false;
    chip.append(ring, img);

    root.append(bubble, chip, chipMenu);
    doc.body.appendChild(root);

    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.id = "hq-inventoria-toggle";
    toggle.className = "hq-inventoria-toggle";
    toggle.title = "Replier / afficher Inventoria";
    toggle.setAttribute("aria-label", "Replier ou afficher Inventoria");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-controls", "hq-inventoria");
    const toggleGrip = doc.createElement("span");
    toggleGrip.className = "hq-inventoria-toggle-grip";
    toggleGrip.setAttribute("aria-hidden", "true");
    toggleGrip.textContent = "⋮⋮";
    const toggleLabel = doc.createElement("span");
    toggleLabel.className = "hq-inventoria-toggle-label";
    toggleLabel.textContent = "Inventoria";
    const toggleChevron = doc.createElement("span");
    toggleChevron.className = "hq-inventoria-toggle-chevron";
    toggleChevron.setAttribute("aria-hidden", "true");
    toggleChevron.textContent = "▾";
    toggle.append(toggleGrip, toggleLabel, toggleChevron);
    doc.body.appendChild(toggle);

    let open = false;
    let chipVisible = true;
    let currentMood = "idle";
    let moodTimer = null;
    let moodBusyLatch = false;

    function portraitPath(url) {
      try {
        return new URL(String(url || ""), win.location.origin).pathname;
      } catch (_) {
        return String(url || "");
      }
    }

    function portraitTable(adult) {
      return adult ? PORTRAIT_BY_MOOD : PORTRAIT_SFW_BY_MOOD;
    }

    function applyPortrait(mood) {
      const adult = win.HqImageChipScale && win.HqImageChipScale.adultChipPortraits
        ? win.HqImageChipScale.adultChipPortraits(win)
        : false;
      const table = portraitTable(adult);
      const pack = table[mood] || table.idle;
      if (portraitPath(img.src) === pack.src) return;
      img.src = pack.src;
      img.srcset = pack.srcset;
    }

    function setMood(mood, ms) {
      const next = MOODS.indexOf(mood) >= 0 ? mood : "idle";
      MOODS.forEach((m) => root.classList.toggle("is-mood-" + m, m === next));
      currentMood = next;
      root.classList.toggle("is-busy", next === "busy" || moodBusyLatch);
      applyPortrait(next);
      try {
        win.dispatchEvent(new CustomEvent("hq:inventoria-mood", { detail: { mood: next } }));
      } catch (_) {}
      if (moodTimer) win.clearTimeout(moodTimer);
      moodTimer = null;
      if (next === "idle" || next === "busy" || ms === 0) return;
      const delay = Math.max(900, Number(ms) || 1800);
      moodTimer = win.setTimeout(() => {
        if (moodBusyLatch) setMood("busy", 0);
        else if (open) setMood("listening", 0);
        else setMood("idle");
      }, delay);
    }

    function setBusy(on) {
      moodBusyLatch = !!on;
      root.classList.toggle("is-busy", moodBusyLatch || currentMood === "busy");
      if (moodBusyLatch) setMood("busy", 0);
      else if (open) setMood("listening", 0);
      else setMood("idle");
    }

    function syncView() {
      const view = (doc.body && doc.body.dataset.view) || "accueil";
      const hide = !sessionAdmin(win) || view === "intime" || doc.body.classList.contains("hq-intime-active");
      root.hidden = hide;
      toggle.hidden = hide;
    }

    function setOpen(on) {
      open = !!on;
      root.classList.toggle("is-open", open);
      try { win.localStorage.setItem(LS_OPEN, open ? "1" : "0"); } catch (_) {}
      if (open) {
        setMood("listening", 0);
        try {
          win.dispatchEvent(new CustomEvent("hq:inventoria-open", { detail: { source: "chip" } }));
        } catch (_) {}
      } else {
        setMood("idle");
      }
    }

    function setChipVisible(on, opts) {
      chipVisible = !!on;
      const hide = !chipVisible;
      root.classList.toggle("is-collapsed", hide);
      toggle.classList.toggle("is-collapsed", hide);
      toggle.setAttribute("aria-expanded", hide ? "false" : "true");
      if (!opts || !opts.silent) {
        try { win.localStorage.setItem(LS_VISIBLE, hide ? "0" : "1"); } catch (_) {}
      }
    }

    function syncMotionPerf() {
      const lite = !!(doc.body && (doc.body.classList.contains("hq-motion-lite") || doc.body.classList.contains("is-motion-lite")));
      root.classList.toggle("is-motion-lite", lite);
    }

    function openChipMenu(forceOpen) {
      if (!chipVisible) setChipVisible(true);
      if (forceOpen === true) chipMenu.hidden = false;
      else chipMenu.hidden = !chipMenu.hidden;
    }

    function closeChipMenu() {
      chipMenu.hidden = true;
    }

    function handleChipMenu(action) {
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
      if (action === "mood_cycle") {
        const i = MOODS.indexOf(currentMood);
        const next = MOODS[(i + 1) % MOODS.length];
        setMood(next, 4000);
        return;
      }
      if (action && action.indexOf("mood_") === 0) {
        const pick = action.slice(5);
        if (MOODS.indexOf(pick) >= 0) setMood(pick, pick === "idle" || pick === "busy" ? 0 : 5000);
      }
    }

    let chipPinchBlock = false;
    let chipScale = null;
    const chipFloat = bindFloatDrag(win, {
      el: chip,
      host: root,
      storageKey: LS_FLOAT,
      minVisible: 72,
      isBlocked: () => chipPinchBlock,
      onLongPress: () => openChipMenu(true),
    });
    const toggleFloat = bindFloatDrag(win, { el: toggle, host: toggle, storageKey: LS_TOGGLE_FLOAT, minVisible: 36 });
    if (win.HqImageChipScale && typeof win.HqImageChipScale.bind === "function") {
      chipScale = win.HqImageChipScale.bind(win, {
        root,
        chip,
        storageKey: LS_CHIP_SCALE,
        setBlocked: (on) => { chipPinchBlock = !!on; },
        cancelDrag: () => chipFloat.cancelActiveDrag(),
      });
    }

    chipMenu.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest("[data-action]");
      if (!btn) return;
      handleChipMenu(btn.dataset.action);
    });
    doc.addEventListener("pointerdown", (ev) => {
      if (chipMenu.hidden) return;
      if (chipMenu.contains(ev.target) || chip.contains(ev.target) || toggle.contains(ev.target)) return;
      closeChipMenu();
    });

    chip.addEventListener("click", (ev) => {
      if (chipFloat.consumeClickSuppressed()) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      closeChipMenu();
      setOpen(!open);
    });

    closeBtn.addEventListener("click", () => { stopVoice(); if (rec) { try { rec.abort(); } catch (_) {} } setOpen(false); });
    toggle.addEventListener("click", (ev) => {
      if (toggleFloat.consumeClickSuppressed()) {
        ev.preventDefault();
        return;
      }
      if (chipVisible) setChipVisible(false);
      else {
        setChipVisible(true);
        setOpen(true);
      }
    });

    // Spoken line in Inventoria's saved Phonon voice. One audio element: a new line or close/hide stops the old one.
    let voiceAudio = null, voiceSeq = 0, voiceAbort = null;
    const stopVoice = () => {
      voiceSeq++;
      if (voiceAbort) { try { voiceAbort.abort(); } catch (e) {} voiceAbort = null; }
      if (voiceAudio) {
        const a = voiceAudio; voiceAudio = null;
        a.onended = a.onerror = null;
        try { a.pause(); } catch (e) {}
        a.removeAttribute("src");
        try { a.load(); } catch (e) {}
        setMood(open ? "listening" : "idle", 0);
      }
    };
    const speakLine = (text) => {
      stopVoice();
      const t = String(text || "").trim();
      if (!t || win.document.hidden) return Promise.resolve(false);
      const my = voiceSeq;
      voiceAbort = new win.AbortController();
      return win.fetch("/api/inventoria/voice", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ text: t }), signal: voiceAbort.signal,
      }).then((r) => r.json()).then((d) => {
        if (my !== voiceSeq || !d || !d.ok || !d.audio_url) return false;
        const a = new win.Audio(d.audio_url);
        voiceAudio = a;
        const done = () => { if (voiceAudio === a) { voiceAudio = null; setMood("idle", 0); } };
        a.onended = done; a.onerror = done;
        setMood("speaking", 60000);
        return a.play().then(() => true, () => { done(); return false; });
      }).catch(() => false);
    };
    win.document.addEventListener("visibilitychange", () => { if (win.document.hidden) stopVoice(); });

    const SESSION_KEY = "hq_inventoria_session";
    let chatBusy = false, chatSeq = 0;
    const jsonPost = (url, body, signal) => win.fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify(body), signal,
    }).then((r) => r.json().then((d) => ({ ok: r.ok, status: r.status, data: d })));
    const ensureSession = (fresh) => {
      let sid = "";
      try { sid = fresh ? "" : (win.localStorage.getItem(SESSION_KEY) || ""); } catch (_) {}
      if (sid) return Promise.resolve(sid);
      return jsonPost("/api/inventoria/sessions", { device_id: "chip" }).then((r) => {
        const id = r.ok && r.data && r.data.session && r.data.session.id;
        if (!id) throw new Error((r.data && r.data.error) || "Session indisponible");
        try { win.localStorage.setItem(SESSION_KEY, id); } catch (_) {}
        return id;
      });
    };
    const askInventoria = (text, retried, image, intent, force, signal) => ensureSession(!!retried)
      .then((sid) => jsonPost("/api/inventoria/sessions/" + sid + "/message",
        image ? Object.assign({ text, image }, intent ? { intent } : {}, force ? { force: true } : {}) : { text }, signal))
      .then((r) => {
        if (!r.ok && !retried && (r.status === 404 || r.status === 409)) return askInventoria(text, true, image, intent, force, signal);
        if (!r.ok) {
          const err = new Error((r.data && r.data.error) || "Inventoria indisponible");
          err.retryable = !!(r.data && r.data.retryable);
          throw err;
        }
        const d = r.data || {};
        if (d.duplicate_photo) return { duplicate: d.duplicate_photo };
        const msgs = d.messages || [];
        let reply = "", at = null;
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") { reply = String(msgs[i].text || ""); at = msgs[i].at; break; }
        return { reply, at, operations: d.operations || (d.operation ? [d.operation] : []), grocery: (d.grocery && d.grocery.lines) || [], detections: d.detections || null };
      });

    // Draft review: Inventoria only ever proposes. Apply = confirmed preview + commit through the existing pipeline.
    const opUrl = (id, action) => "/api/inventoria/ops/" + id + "/" + action;
    const clearDraft = () => { draftBox.hidden = true; draftBox.replaceChildren(); clearGrocery(); clearDetect(); clearNotice(); };
    const clearNotice = () => { noticeBox.hidden = true; noticeBox.replaceChildren(); };
    // A message with up to two buttons: [{label, icon, primary, fn}]. Used for "same photo again" and "model busy, retry".
    const showNotice = (text, buttons) => {
      noticeBox.replaceChildren();
      noticeBox.hidden = false;
      const p = doc.createElement("p");
      p.className = "hq-inventoria-draft-title";
      p.textContent = text;
      const row = doc.createElement("div");
      row.className = "hq-inventoria-draft-actions";
      (buttons || []).forEach((b) => {
        const el = doc.createElement("button");
        el.type = "button"; el.textContent = b.label;
        if (b.primary) el.className = "hq-inventoria-draft-apply";
        decorate(el, b.icon || "check");
        el.addEventListener("click", () => { clearNotice(); if (b.fn) b.fn(); });
        row.appendChild(el);
      });
      noticeBox.append(p, row);
    };
    let currentCardAt = null;          // the assistant message the visible photo review / grocery card belongs to
    const resolveCard = () => { if (currentCardAt != null) lsSet(RESOLVED_AT, String(currentCardAt)); };
    let det = null;                    // review state of the last multi-item photo: {mode, rows, places}
    const clearDetect = () => { det = null; detBox.hidden = true; detBox.replaceChildren(); };
    const clearGrocery = () => { groceryBox.hidden = true; groceryBox.replaceChildren(); };
    // Items she recognised in a photo of several physical things: an editable list. Nothing is drafted until you press the button.
    const detKey = (r) => r.item_id || ("n:" + String(r.name).toLowerCase());
    const tagBoxes = (r, photo) => (r.boxes || []).map((b) => ({ p: photo, b }));
    const showDetections = (d, image) => {
      det = { mode: d.mode === "count" ? "count" : "add", places: d.places || [], photos: image ? [image] : [], shown: 0, truncated: d.truncated || 0,
              rows: (d.rows || []).map((r) => Object.assign({ keep: r.confidence !== "low" }, r, { boxes: tagBoxes(r, 0) })) };
      renderDetections();
    };
    // A second photo of the same scan: rows are merged by item; a thing seen in both keeps the larger count and is marked "check".
    const mergeDetections = (d, image) => {
      if (!det) { showDetections(d, image); return; }
      const photo = image ? det.photos.push(image) - 1 : det.photos.length - 1;
      det.shown = Math.max(0, photo);
      det.truncated = (det.truncated || 0) + (d.truncated || 0);
      det.rows.forEach((r) => { r.verify = null; });                      // counts checked per photo: not meaningful once merged
      const idx = {};
      det.rows.forEach((r) => { idx[detKey(r)] = r; });
      (d.rows || []).forEach((r) => {
        const old = idx[detKey(r)];
        if (old) { old.verify = null; old.qty = Math.max(old.qty, r.qty); old.confidence = "low"; old.note = uiLang === "en" ? "seen in 2 photos" : "vu sur 2 photos"; old.keep = true; old.boxes = old.boxes.concat(tagBoxes(r, photo)); }
        else { const row = Object.assign({ keep: r.confidence !== "low" }, r, { boxes: tagBoxes(r, photo), verify: null }); det.rows.push(row); idx[detKey(row)] = row; }
      });
      det.places = d.places && d.places.length ? d.places : det.places;
      renderDetections();
    };
    const boxColor = (i) => "hsl(" + ((i * 67 + 10) % 360) + " 85% 62%)";
    // Draw the numbered boxes of one photo into `host` (percent positions: the host must be exactly the image's size).
    const drawBoxes = (host, photoIdx, onPick) => {
      const map = {};
      host.querySelectorAll(".hq-inventoria-box").forEach((n) => n.remove());
      det.rows.forEach((r, i) => {
        (r.boxes || []).forEach((bx) => {
          if (bx.p !== photoIdx) return;
          const [y1, x1, y2, x2] = bx.b;
          const el = doc.createElement("button");
          el.type = "button";
          el.className = "hq-inventoria-box" + (r.keep ? "" : " is-off");
          el.style.cssText = "left:" + x1 / 10 + "%;top:" + y1 / 10 + "%;width:" + (x2 - x1) / 10 + "%;height:" + (y2 - y1) / 10 + "%;--c:" + boxColor(i);
          el.setAttribute("aria-label", (i + 1) + ". " + r.name);
          const num = doc.createElement("span");
          num.textContent = String(i + 1);
          el.appendChild(num);
          el.addEventListener("click", (ev) => { ev.stopPropagation(); if (onPick) onPick(i); });
          host.appendChild(el);
          (map[i] = map[i] || []).push(el);
        });
      });
      return map;
    };
    const openLightbox = (photoIdx) => {
      if (!det || !det.photos[photoIdx]) return;
      const box = doc.createElement("div");
      box.className = "hq-inventoria-lightbox";
      box.setAttribute("role", "dialog"); box.setAttribute("aria-label", uiLang === "en" ? "Photo with detections" : "Photo avec les détections");
      const wrap = doc.createElement("div");
      wrap.className = "hq-inventoria-lightbox-wrap";
      const img = doc.createElement("img");
      img.alt = ""; img.src = det.photos[photoIdx];
      const fig = doc.createElement("div");
      fig.className = "hq-inventoria-fig is-large";
      fig.appendChild(img);
      drawBoxes(fig, photoIdx, null);
      const legend = doc.createElement("div");
      legend.className = "hq-inventoria-legend";
      det.rows.forEach((r, i) => {
        if (!(r.boxes || []).some((b) => b.p === photoIdx)) return;
        const chip = doc.createElement("span");
        chip.style.setProperty("--c", boxColor(i));
        chip.textContent = (i + 1) + " " + r.name + " ×" + r.qty;
        legend.appendChild(chip);
      });
      const close = doc.createElement("button");
      close.type = "button"; close.className = "hq-inventoria-lightbox-close"; close.textContent = "×";
      close.setAttribute("aria-label", uiLang === "en" ? "Close" : "Fermer");
      const done = () => { doc.removeEventListener("keydown", onKey, true); box.remove(); };
      const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(); } };
      close.addEventListener("click", done);
      box.addEventListener("click", (e) => { if (e.target === box) done(); });
      doc.addEventListener("keydown", onKey, true);
      wrap.append(fig, legend);
      box.append(wrap, close);
      doc.body.appendChild(box);
      close.focus();
    };
    const renderDetections = () => {
      if (!det) return;
      selectTab("chat");
      detBox.replaceChildren();
      detBox.hidden = false;
      const en = uiLang === "en";
      const title = decorate(doc.createElement("p"), "image");
      title.className = "hq-inventoria-draft-title";
      const seg = doc.createElement("div");
      seg.className = "hq-inventoria-seg";
      seg.setAttribute("role", "group");
      const modeBtn = (mode, label) => {
        const b = doc.createElement("button");
        b.type = "button"; b.textContent = label; b.dataset.mode = mode;
        b.setAttribute("aria-pressed", det.mode === mode ? "true" : "false");
        b.addEventListener("click", () => { det.mode = mode; syncRows(); seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.mode === mode ? "true" : "false")); });
        return b;
      };
      seg.append(modeBtn("add", en ? "Add to stock" : "Ajouter au stock"), modeBtn("count", en ? "Count (replaces)" : "Compter (remplace)"));
      const list = doc.createElement("ul");
      list.className = "hq-inventoria-det-list";
      const info = {};
      const syncRow = (r) => {
        const el = info[detKey(r)];
        if (!el) return;
        if (r.item_id) el.textContent = det.mode === "add" ? (r.qty_now + " → " + (r.qty_now + r.qty)) : (r.qty_now + " → " + r.qty);
      };
      let keepSync = () => {};
      const syncRows = () => {
        det.rows.forEach(syncRow);
        keepSync();
        const n = det.rows.filter((r) => r.keep).length;
        title.textContent = (en ? "What I recognised (" : "Ce que j'ai reconnu (") + det.rows.length + ")";
        go.disabled = n === 0;
        goLbl(n);
      };
      det.rows.forEach((r) => {
        const li = doc.createElement("li");
        li.className = "hq-inventoria-det-row" + (r.confidence === "low" ? " is-low" : "");
        const cb = doc.createElement("input");
        cb.type = "checkbox"; cb.checked = !!r.keep; cb.setAttribute("aria-label", r.name);
        cb.addEventListener("change", () => { r.keep = cb.checked; syncRows(); });
        const qty = doc.createElement("input");
        qty.type = "number"; qty.min = r.item_id ? "0" : "1"; qty.max = "100000"; qty.step = "1"; qty.value = String(r.qty);
        qty.className = "hq-inventoria-check-qty"; qty.setAttribute("aria-label", (en ? "Count for " : "Quantité pour ") + r.name);
        qty.addEventListener("input", () => { const n = parseInt(qty.value, 10); if (n >= 0) { r.qty = n; syncRow(r); } });
        const lead = itemBadge(r.name, 24);
        const name = doc.createElement("span");
        name.className = "hq-inventoria-det-name";
        name.textContent = r.name + (r.unit ? " (" + r.unit + ")" : "");
        const num = doc.createElement("span");
        num.className = "hq-inventoria-det-num";
        num.style.setProperty("--c", boxColor(det.rows.indexOf(r)));
        num.textContent = String(det.rows.indexOf(r) + 1);
        li.append(num, cb, qty);
        if (lead) li.appendChild(lead);
        li.appendChild(name);
        const vtext = r.verify === "ok" ? (en ? "✓ " + r.seen_count + " seen" : "✓ " + r.seen_count + " vu" + (r.seen_count > 1 ? "s" : ""))
          : r.verify === "mismatch" ? (en ? "⚠ " + r.seen_count + " seen" : "⚠ " + r.seen_count + " repéré" + (r.seen_count > 1 ? "s" : ""))
          : r.verify === "unseen" ? (en ? "not located" : "non repéré") : r.verify === "grouped" ? (en ? "one box for the group" : "un cadre pour le groupe") : "";
        if (vtext) {
          const tag = doc.createElement("span");
          tag.className = "hq-inventoria-det-tag is-" + r.verify;
          tag.textContent = vtext;
          tag.title = en ? "Independent count: how many separate items were found in the photo (without knowing her count)."
                         : "Compte indépendant : combien d'objets distincts ont été trouvés sur la photo (sans connaître son compte).";
          li.appendChild(tag);
        }
        if (r.confidence === "low" || r.note) {
          const flag = doc.createElement("span");
          flag.className = "hq-inventoria-det-flag";
          flag.textContent = r.note || (en ? "check" : "à vérifier");
          flag.title = en ? "Low confidence: check this count" : "Confiance faible : vérifie ce compte";
          li.appendChild(flag);
        }
        const tail = doc.createElement("span");
        tail.className = "hq-inventoria-det-info";
        if (r.item_id) {
          info[detKey(r)] = tail;
        } else {
          const sel = doc.createElement("select");
          sel.setAttribute("aria-label", (en ? "Place for " : "Emplacement pour ") + r.name);
          const none = doc.createElement("option"); none.value = ""; none.textContent = en ? "— no place —" : "— sans emplacement —"; sel.appendChild(none);
          (det.places || []).forEach((pl) => { const o = doc.createElement("option"); o.value = pl.id; o.textContent = pl.name; sel.appendChild(o); });
          sel.value = r.place_id || "";
          sel.addEventListener("change", () => { r.place_id = sel.value || null; });
          const badge = doc.createElement("span");
          badge.className = "hq-inventoria-det-new"; badge.textContent = en ? "new" : "nouveau";
          tail.append(badge, sel);
        }
        li.appendChild(tail);
        list.appendChild(li);
      });
      const go = doc.createElement("button");
      go.type = "button"; go.className = "hq-inventoria-draft-apply"; go.textContent = "";
      decorate(go, "check");
      const goLbl = (n) => { go.textContent = (en ? "Prepare the draft (" : "Préparer le brouillon (") + n + ")"; };
      const more = doc.createElement("button");
      more.type = "button"; more.textContent = en ? "Add a photo" : "Ajouter une photo";
      decorate(more, "camera");
      more.addEventListener("click", () => { if (chatBusy) return; mergeNext = true; photoInput.click(); });
      const skip = doc.createElement("button");
      skip.type = "button"; skip.className = "hq-inventoria-draft-cancel"; skip.textContent = en ? "Dismiss" : "Ignorer";
      decorate(skip, "x");
      skip.addEventListener("click", () => { resolveCard(); clearDetect(); });
      const actions = doc.createElement("div");
      actions.className = "hq-inventoria-draft-actions";
      actions.append(go, more, skip);
      const hint = doc.createElement("p");
      hint.className = "hq-inventoria-det-hint";
      hint.textContent = en ? "Counts from a photo are estimates: fix anything that looks off, then prepare the draft."
        : "Les comptes d'après une photo sont des estimations : corrige ce qui semble faux, puis prépare le brouillon.";
      // annotated photo: numbered boxes linked to the rows (hover / tap a row or a box to see which is which)
      let boxMap = {};
      const figBlock = doc.createElement("div");
      figBlock.className = "hq-inventoria-figblock";
      const fig = doc.createElement("div");
      fig.className = "hq-inventoria-fig";
      const img = doc.createElement("img");
      img.alt = en ? "Your photo with the detected items" : "Ta photo avec les objets détectés";
      img.draggable = false;
      fig.appendChild(img);
      const sizeFig = () => { if (img.naturalWidth && img.naturalHeight) fig.style.maxWidth = Math.round(210 * img.naturalWidth / img.naturalHeight) + "px"; };
      img.addEventListener("load", sizeFig);
      const showPhoto = (idx) => {
        det.shown = idx;
        img.src = det.photos[idx] || "";
        boxMap = drawBoxes(fig, idx, (i) => { const li = list.children[i]; if (li) { li.scrollIntoView({ block: "nearest" }); li.classList.add("is-flash"); setTimeout(() => li.classList.remove("is-flash"), 900); } });
        if (img.complete) sizeFig();
        photoBtns.forEach((b, k) => b.setAttribute("aria-pressed", k === idx ? "true" : "false"));
      };
      const photoBtns = [];
      const tools = doc.createElement("div");
      tools.className = "hq-inventoria-figtools";
      (det.photos || []).forEach((_, k) => {
        if (det.photos.length < 2) return;
        const b = doc.createElement("button");
        b.type = "button"; b.textContent = (en ? "Photo " : "Photo ") + (k + 1);
        b.addEventListener("click", () => showPhoto(k));
        photoBtns.push(b); tools.appendChild(b);
      });
      const boxesLabel = doc.createElement("label");
      const boxesToggle = doc.createElement("input");
      boxesToggle.type = "checkbox"; boxesToggle.checked = true;
      boxesToggle.addEventListener("change", () => fig.classList.toggle("is-plain", !boxesToggle.checked));
      boxesLabel.append(boxesToggle, doc.createTextNode(en ? " Show boxes" : " Afficher les boîtes"));
      const big = doc.createElement("button");
      big.type = "button"; big.textContent = en ? "Enlarge" : "Agrandir";
      decorate(big, "image");
      big.addEventListener("click", () => openLightbox(det.shown));
      fig.addEventListener("click", () => openLightbox(det.shown));
      tools.append(boxesLabel, big);
      figBlock.append(fig, tools);
      const anyBoxes = det.rows.some((r) => (r.boxes || []).length);
      const figNote = doc.createElement("p");
      figNote.className = "hq-inventoria-det-hint";
      figNote.textContent = anyBoxes
        ? (en ? "Check the boxes: each number is a row below. Wrong box = wrong item, so untick or fix that row."
              : "Vérifie les boîtes : chaque numéro est une ligne ci-dessous. Boîte au mauvais endroit = mauvais objet, décoche ou corrige la ligne.")
        : (en ? "I couldn't mark the items on the photo, so check the list against the picture." : "Je n'ai pas pu repérer les objets sur la photo : vérifie la liste en regardant l'image.");
      detBox.append(title, seg, hint);
      if (det.truncated > 0) {
        const trunc = doc.createElement("p");
        trunc.className = "hq-inventoria-photo-warn";
        trunc.textContent = en ? "⚠ " + det.truncated + " more item(s) could not be listed (limit 60 per photo). Take another photo of the rest with “Add a photo”."
          : "⚠ " + det.truncated + " objet(s) de plus n'ont pas pu être listés (limite : 60 par photo). Prends une autre photo du reste avec « Ajouter une photo ».";
        detBox.append(trunc);
      }
      if (!det.photos.length) {
        const gone = doc.createElement("p");
        gone.className = "hq-inventoria-det-hint";
        gone.textContent = en ? "The photo is not kept by HQ, so it can't be shown again." : "La photo n'est pas conservée par HQ : elle ne peut plus être affichée.";
        detBox.append(gone);
      }
      if (det.photos.length) detBox.append(figBlock, figNote);
      detBox.append(list, actions);
      if (det.photos.length) showPhoto(Math.min(det.shown, det.photos.length - 1));
      syncRows();
      const hi = (i, on) => { (boxMap[i] || []).forEach((el) => el.classList.toggle("is-active", on)); fig.classList.toggle("has-active", on && !!(boxMap[i] || []).length); };
      list.addEventListener("mouseover", (e) => { const li = e.target.closest("li"); if (li) hi(Array.prototype.indexOf.call(list.children, li), true); });
      list.addEventListener("mouseout", (e) => { const li = e.target.closest("li"); if (li) hi(Array.prototype.indexOf.call(list.children, li), false); });
      list.addEventListener("focusin", (e) => { const li = e.target.closest("li"); if (li) hi(Array.prototype.indexOf.call(list.children, li), true); });
      list.addEventListener("focusout", (e) => { const li = e.target.closest("li"); if (li) hi(Array.prototype.indexOf.call(list.children, li), false); });
      det.rows.forEach((r, i) => { r._i = i; });
      keepSync = () => { fig.querySelectorAll(".hq-inventoria-box").forEach((n) => n.remove()); boxMap = drawBoxes(fig, det.shown, null); };
      go.addEventListener("click", () => {
        const rows = det.rows.filter((r) => r.keep).map((r) => ({ item_id: r.item_id || undefined, name: r.name, qty: r.qty, unit: r.unit || "", place_id: r.place_id || undefined }));
        if (!rows.length) return;
        go.disabled = more.disabled = skip.disabled = true;
        const mode = det.mode;
        ensureSession(false).then((sid) => jsonPost("/api/inventoria/detections", { session_id: sid, mode, rows })).then((r) => {
          if (!r.ok || !r.data || !r.data.operation) throw r;
          resolveCard();
          clearDetect();
          showDraft(r.data.operations || [r.data.operation]);
        }).catch((r) => {
          go.disabled = more.disabled = skip.disabled = false;
          const n = doc.createElement("p"); n.className = "hq-inventoria-draft-note";
          n.textContent = (r && r.data && r.data.error) || "Impossible de préparer le brouillon.";
          detBox.insertBefore(n, actions);
        });
      });
    };
    // Items she says you NEED (from a photo of a list, an empty shelf...) wait here until you add them to the grocery list.
    const showGrocery = (lines) => {
      const rows = (lines || []).filter((l) => l && l.name);
      if (!rows.length) return;
      selectTab("chat");
      groceryBox.replaceChildren();
      groceryBox.hidden = false;
      const title = decorate(doc.createElement("p"), "cart");
      title.className = "hq-inventoria-draft-title";
      title.textContent = (uiLang === "en" ? "To add to your grocery list (" : "À ajouter à ta liste de courses (") + rows.length + ")";
      const list = doc.createElement("ul");
      list.className = "hq-inventoria-draft-list";
      rows.forEach((l) => {
        const li = doc.createElement("li");
        li.className = "hq-inventoria-draft-li";
        const lead = itemBadge(l.name, 24);
        if (lead) li.appendChild(lead);
        const tx = doc.createElement("span");
        tx.textContent = l.qty + (l.unit ? " " + l.unit : "") + " × " + l.name + (l.store ? " · " + l.store : "");
        li.appendChild(tx);
        list.appendChild(li);
      });
      const add = doc.createElement("button");
      add.type = "button"; add.className = "hq-inventoria-draft-apply"; add.textContent = uiLang === "en" ? "Add to my list" : "Ajouter à ma liste";
      decorate(add, "cart");
      const skip = doc.createElement("button");
      skip.type = "button"; skip.className = "hq-inventoria-draft-cancel"; skip.textContent = uiLang === "en" ? "Dismiss" : "Ignorer";
      decorate(skip, "x");
      const row = doc.createElement("div");
      row.className = "hq-inventoria-draft-actions";
      row.append(add, skip);
      groceryBox.append(title, list, row);
      const note = (t) => { const n = doc.createElement("p"); n.className = "hq-inventoria-draft-note"; n.textContent = t; groceryBox.replaceChildren(n); };
      skip.addEventListener("click", () => { resolveCard(); clearGrocery(); });
      add.addEventListener("click", () => {
        add.disabled = skip.disabled = true;
        jsonPost("/api/inventoria/to-grocery", { lines: rows.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit || "", store: l.store || "" })) }).then((r) => {
          if (!r.ok) { note((r.data && r.data.error) || "Ajout impossible."); return; }
          resolveCard();
          note(uiLang === "en" ? "Added to your grocery list (" + r.data.count + " lines)." : "Ajouté à ta liste de courses (" + r.data.count + " lignes).");
        }).catch(() => note("Ajout impossible."));
      });
    };
    const draftNote = (text) => { const p = doc.createElement("p"); p.className = "hq-inventoria-draft-note"; p.textContent = text; draftBox.replaceChildren(p); draftBox.hidden = false; };
    const describe = (c) => {
      let s = c.label_fr || c.op;
      const b = c.before && c.before.qty, a = c.after && c.after.qty;
      if (typeof b === "number" && typeof a === "number") s += " (" + b + " → " + a + ")";
      return s;
    };
    let lastApplied = null;
    const undoLast = () => {
      if (!lastApplied || !lastApplied.length) return;
      const ids = lastApplied.slice().reverse().map((o) => o.id);
      draftNote(uiLang === "en" ? "Preparing the undo…" : "Préparation de l'annulation…");
      const drafts = [];
      const next = (i) => (i >= ids.length ? Promise.resolve() : jsonPost(opUrl(ids[i], "undo"), {}).then((r) => {
        if (!r.ok || !r.data || !r.data.operation) throw r;
        drafts.push(r.data.operation);
        return next(i + 1);
      }));
      next(0).then(() => showDraft(drafts, { undo: true })).catch((r) => draftNote((r && r.data && r.data.error) || "Annulation impossible."));
    };
    const showDraft = (operations, opts) => {
      const ops = (operations || []).filter((o) => o && o.id && (o.proposals || []).length);
      if (!ops.length) return;
      selectTab("chat");
      draftBox.replaceChildren();
      draftBox.hidden = false;
      const total = ops.reduce((n, o) => n + o.proposals.length, 0);
      const title = decorate(doc.createElement("p"), "list");
      title.className = "hq-inventoria-draft-title";
      title.textContent = (opts && opts.undo ? "Annulation du lot — rien n'est appliqué (" : "Brouillon à vérifier — rien n'est appliqué (") + total + " changement" + (total > 1 ? "s" : "") + ")";
      const list = doc.createElement("ul");
      list.className = "hq-inventoria-draft-list";
      const opIcon = (t) => /^Annuler/.test(t) ? "undo" : /^Créer/.test(t) ? "sparkle" : /^Déplacer/.test(t) ? "arrow" : /^Modifier/.test(t) ? "list"
        : / de -\d/.test(t) ? "minus" : / de \+\d/.test(t) || /^Acheté/.test(t) ? "plus" : "check";
      const fillList = (labels) => {
        list.replaceChildren();
        labels.forEach((t) => {
          const li = doc.createElement("li");
          li.className = "hq-inventoria-draft-li";
          const name = String(t).replace(/^(Acheté :|Annuler :|Ajuster|Créer|Modifier|Déplacer)\s*/i, "").replace(/\s+de\s+[+-]\d.*$|\s*\(.*$/, "");
          const lead = itemBadge(name, 24);
          li.append(ico(opIcon(String(t)), "hq-inventoria-op-ico"));
          if (lead) li.appendChild(lead);
          const tx = doc.createElement("span");
          tx.textContent = t;
          li.appendChild(tx);
          list.appendChild(li);
        });
      };
      fillList(ops.flatMap((o) => o.proposals.map((p) => p.label_fr || p.op)));
      const apply = doc.createElement("button");
      apply.type = "button"; apply.textContent = "Appliquer"; apply.className = "hq-inventoria-draft-apply";
      decorate(apply, "check");
      const cancel = doc.createElement("button");
      cancel.type = "button"; cancel.textContent = "Annuler"; cancel.className = "hq-inventoria-draft-cancel";
      decorate(cancel, "x");
      const row = doc.createElement("div");
      row.className = "hq-inventoria-draft-actions";
      row.append(apply, cancel);
      draftBox.append(title, list, row);
      const errText = (r) => (r && r.data && r.data.error) || "Brouillon impossible à appliquer";
      // validate + preview (unconfirmed) every operation first, so the list shows real before/after numbers
      Promise.all(ops.map((o) => jsonPost(opUrl(o.id, "validate"), {})
        .then((v) => (v.ok && v.data.validation && v.data.validation.ok ? jsonPost(opUrl(o.id, "preview"), { confirm: false }) : { ok: false, invalid: true, data: v.data }))))
        .then((results) => {
          if (results.some((r) => r.invalid)) {
            apply.disabled = true;
            title.textContent = "Ce brouillon ne passe pas la validation — rien à appliquer";
            return;
          }
          if (results.every((r) => r.ok && r.data.preview)) fillList(results.flatMap((r) => (r.data.preview.changes || []).map(describe)));
        }).catch(() => {});
      cancel.addEventListener("click", () => {
        apply.disabled = cancel.disabled = true;
        Promise.all(ops.map((o) => jsonPost(opUrl(o.id, "cancel"), {})))
          .then(() => draftNote("Brouillon annulé.")).catch(() => draftNote("Annulation impossible."));
      });
      apply.addEventListener("click", () => {
        apply.disabled = cancel.disabled = true;
        const base = "ivo-" + (win.crypto && win.crypto.randomUUID ? win.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
        let done = 0;
        // Operations are applied in order, each with its own confirmed preview and commit (a commit batch holds at most one create).
        const step = (i) => {
          if (i >= ops.length) return Promise.resolve();
          return jsonPost(opUrl(ops[i].id, "preview"), { confirm: true })
            .then((p) => { if (!p.ok) throw p; return jsonPost(opUrl(ops[i].id, "commit"), { idempotency_key: (base + "-" + i).replace(/[^A-Za-z0-9-]/g, "").slice(0, 128) }); })
            .then((c) => { if (!(c.ok && c.data && c.data.ok !== false)) throw c; done++; return step(i + 1); });
        };
        step(0).then(() => {
          chatTouched = true;
          showLine(uiLang === "en" ? "Done. The stock is updated." : "C'est fait. Le stock est à jour.");
          draftNote(opts && opts.undo ? "Annulé." : "Appliqué.");
          lastApplied = opts && opts.undo ? null : ops;
          if (lastApplied) {
            const undoBtn = doc.createElement("button");
            undoBtn.type = "button"; undoBtn.className = "hq-inventoria-draft-undo";
            undoBtn.textContent = uiLang === "en" ? "Undo this batch" : "Annuler ce lot";
            decorate(undoBtn, "undo");
            undoBtn.addEventListener("click", () => { undoBtn.disabled = true; undoLast(); });
            draftBox.appendChild(undoBtn);
          }
        }).catch((r) => {
          draftNote(done ? "Appliqué en partie (" + done + "/" + ops.length + ") : " + errText(r) : errText(r));
          if (!done) { apply.disabled = cancel.disabled = false; draftBox.appendChild(row); }
        }).finally(() => { if (done) { try { win.dispatchEvent(new CustomEvent("hq:inventory-changed")); } catch (_) {} } });
      });
    };
    let mergeNext = false;
    const runChat = (text, image, intent, keep, force) => {
      if ((!text && !image) || chatBusy) return;
      chatBusy = true; chatSend.disabled = true; chatInput.value = "";
      stopVoice();
      const my = ++chatSeq;
      showLine(image ? "📷 …" : "…");
      setBusy(true);
      if (!keep) clearDraft(); else clearNotice();
      chatTouched = true;
      selectTab("chat");
      const lastReq = { text, image, intent, keep, force };
      appendThread("user", (image ? "📷 " : "") + (text || "(photo)"));
      const userRow = threadLog.lastElementChild;
      const ctl = new win.AbortController();
      const finish = () => { typing.remove(); chatBusy = false; chatSend.disabled = false; setBusy(false); };
      const typing = addTyping(() => {                 // cancel: stop waiting (the server may still finish; its result is ignored)
        chatSeq++; ctl.abort(); finish();
        showLine(uiLang === "en" ? "Cancelled." : "Annulé.");
        showNotice(uiLang === "en" ? "Request cancelled. Nothing was applied." : "Demande annulée. Rien n'a été appliqué.",
          [{ label: uiLang === "en" ? "Send again" : "Renvoyer", icon: "send", fn: () => runChat(lastReq.text, lastReq.image, lastReq.intent, lastReq.keep, lastReq.force) },
           { label: uiLang === "en" ? "Close" : "Fermer", icon: "x" }]);
      });
      askInventoria(text, false, image, intent, force, ctl.signal).then((res) => {
        typing.remove();
        if (my !== chatSeq) return;
        if (res.duplicate) {                           // the same picture was analysed before: ask before analysing (and applying) it again
          if (userRow) userRow.remove();
          syncEmpty();
          showLine(IDLE_LINE);
          const when = res.duplicate.at ? new Date(res.duplicate.at * 1000).toLocaleString(uiLang === "en" ? "en-CA" : "fr-CA", { dateStyle: "medium", timeStyle: "short" }) : "";
          const en = uiLang === "en";
          showNotice(en ? "You already sent this photo (" + when + ")." + (res.duplicate.applied ? " It already updated the stock; analysing it again risks counting everything twice." : "")
                        : "Tu as déjà envoyé cette photo (" + when + ")." + (res.duplicate.applied ? " Elle a déjà servi à mettre le stock à jour : l'analyser de nouveau risque de tout compter en double." : ""),
            [{ label: en ? "Analyse anyway" : "Analyser quand même", icon: "sparkle", primary: !res.duplicate.applied, fn: () => runChat(text, image, intent, keep, true) },
             { label: en ? "Cancel" : "Annuler", icon: "x" }]);
          return;
        }
        const { reply, operations, grocery, detections, at } = res;
        currentCardAt = at;
        showLine(reply || IDLE_LINE);
        if (reply) appendThread("assistant", reply);
        refreshStatus({});
        if (operations && operations.length) showDraft(operations);
        if (grocery && grocery.length) showGrocery(grocery);
        if (detections && detections.rows && detections.rows.length) { if (keep) mergeDetections(detections, image); else showDetections(detections, image); }
        if (reply && voiceBox.checked) speakLine(reply); else if (reply) setMood("speaking", 1800);
      }).catch((e) => {
        if (my !== chatSeq || (e && e.name === "AbortError")) return;
        if (userRow && !userRow.nextElementSibling) { /* keep the question visible so a retry makes sense */ }
        showLine(e && e.message ? e.message : "Inventoria indisponible");
        if (e && e.retryable) {
          showNotice(e.message, [{ label: uiLang === "en" ? "Try again" : "Réessayer", icon: "send", primary: true, fn: () => runChat(lastReq.text, lastReq.image, lastReq.intent, lastReq.keep, lastReq.force) },
                                 { label: uiLang === "en" ? "Close" : "Fermer", icon: "x" }]);
        }
      }).finally(() => { if (my === chatSeq) finish(); });
    };
    chatForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      runChat(chatInput.value.trim());
    });

    const syncPhotoUi = () => {
      photoOnBox.checked = photosOn();
      photoBtn.hidden = !photosOn();
      renderChips();
    };
    photoOnBox.addEventListener("change", () => { lsSet(PHOTO_OFF, photoOnBox.checked ? "0" : "1"); closePhotoSheet(); syncPhotoUi(); });
    photoReset.addEventListener("click", () => { lsSet(PHOTO_OK, "0"); photoReset.textContent = "Avis réactivé"; });
    // Photo / receipt: shrunk in the browser (receipts keep more pixels), checked for blur and darkness, sent only after a one-time notice.
    const photoInput = doc.createElement("input");
    photoInput.type = "file"; photoInput.accept = "image/*"; photoInput.hidden = true;
    const photoBtn = doc.createElement("button");
    photoBtn.type = "button"; photoBtn.className = "hq-inventoria-chat-photo"; photoBtn.textContent = "";
    decorate(photoBtn, "camera", true);
    photoBtn.setAttribute("aria-label", "Envoyer une photo (ticket de caisse, étagère)");
    photoBtn.addEventListener("click", () => { if (chatBusy) return; if (lsGet(PHOTO_OK) === "1") photoInput.click(); else showPhotoConsent(); });
    const PHOTO_LIMIT = 2600000;      // base64 characters (the server accepts 2.7 M)
    // Decode honouring EXIF orientation; fall back to an <img> on browsers without the option.
    const decodePhoto = (file) => {
      const viaImg = () => new Promise((resolve, reject) => {
        const url = win.URL.createObjectURL(file);
        const img = new win.Image();
        img.onload = () => { win.URL.revokeObjectURL(url); resolve({ src: img, w: img.naturalWidth, h: img.naturalHeight }); };
        img.onerror = () => { win.URL.revokeObjectURL(url); reject(new Error("Photo illisible")); };
        img.src = url;
      });
      if (!win.createImageBitmap) return viaImg();
      return win.createImageBitmap(file, { imageOrientation: "from-image" }).then((bm) => ({ src: bm, w: bm.width, h: bm.height })).catch(viaImg);
    };
    // Blur / darkness / size check on a small copy: Laplacian variance (sharpness) and mean luma.
    const assessPhoto = (cv, origLong) => {
      const k = 512 / Math.max(cv.width, cv.height);
      const w = Math.max(16, Math.round(cv.width * Math.min(1, k))), h = Math.max(16, Math.round(cv.height * Math.min(1, k)));
      const c2 = doc.createElement("canvas");
      c2.width = w; c2.height = h;
      const g = c2.getContext("2d", { willReadFrequently: true });
      g.drawImage(cv, 0, 0, w, h);
      const px = g.getImageData(0, 0, w, h).data;
      const lum = new Float32Array(w * h);
      let sum = 0, sq = 0;
      for (let i = 0; i < w * h; i++) { const y = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]; lum[i] = y; sum += y; sq += y * y; }
      const mean = sum / (w * h);
      const std = Math.sqrt(Math.max(0, sq / (w * h) - mean * mean));
      let a1 = 0, a2 = 0, n = 0;
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const c = y * w + x, lap = 4 * lum[c] - lum[c - 1] - lum[c + 1] - lum[c - w] - lum[c + w];
        a1 += lap; a2 += lap * lap; n++;
      }
      const sharp = n ? a2 / n - (a1 / n) * (a1 / n) : 0;
      // "Washed out" needs bright AND flat: a white receipt with sparse black text is bright but full of contrast.
      return { mean: Math.round(mean), std: Math.round(std), sharp: Math.round(sharp), dark: mean < 50 && std < 40, washed: mean > 235 && std < 28,
               blurry: sharp < 40, small: origLong < 800 };
    };
    // Receipts and lists are tall and thin: they keep far more pixels than a shelf photo so small text stays readable.
    const shrinkImage = (file) => decodePhoto(file).then(({ src, w, h }) => {
      const long = Math.max(w, h), short = Math.max(1, Math.min(w, h));
      const tall = long / short >= 1.7;
      const maxLong = tall ? 2600 : 1800, maxPx = tall ? 3200000 : 2600000;
      let scale = Math.min(1, maxLong / long, Math.sqrt(maxPx / (w * h)));
      for (let attempt = 0; attempt < 5; attempt++) {
        const cv = doc.createElement("canvas");
        cv.width = Math.max(1, Math.round(w * scale)); cv.height = Math.max(1, Math.round(h * scale));
        cv.getContext("2d").drawImage(src, 0, 0, cv.width, cv.height);     // re-encoding also drops EXIF (GPS, camera, date)
        for (const q of [0.86, 0.78, 0.7, 0.6]) {
          const out = cv.toDataURL("image/jpeg", q);
          if (out.length <= PHOTO_LIMIT) { if (src.close) { try { src.close(); } catch (_) {} } return { url: out, tall, w: cv.width, h: cv.height, quality: assessPhoto(cv, long) }; }
        }
        scale *= 0.85;
      }
      throw new Error("Photo trop lourde");
    });
    const showPhotoConsent = () => {
      selectTab("chat");
      photoSheet.replaceChildren();
      photoSheet.hidden = false;
      const en = uiLang === "en";
      const body = doc.createElement("div");
      body.className = "hq-inventoria-photo-body";
      const t = doc.createElement("p");
      t.className = "hq-inventoria-photo-ask";
      t.textContent = en ? "Before your first photo" : "Avant ta première photo";
      const msg = doc.createElement("p");
      msg.className = "hq-inventoria-det-hint";
      msg.textContent = en
        ? "To analyse a photo, HQ sends it to Google (Gemini) with your API key. HQ does not keep it; only an irreversible fingerprint is stored for 30 days to spot duplicates. Location and camera data are stripped first. Avoid bank cards, addresses and ID documents; a receipt can show card digits, so crop it if needed."
        : "Pour analyser une photo, HQ l'envoie à Google (Gemini) avec ta clé d'API. HQ ne la conserve pas : seule une empreinte non réversible est gardée 30 jours pour repérer les doublons. La position et les données de l'appareil sont retirées avant l'envoi. Évite cartes bancaires, adresses et pièces d'identité ; un ticket peut montrer des chiffres de carte, recadre-le au besoin.";
      const ok = doc.createElement("button");
      ok.type = "button"; ok.className = "is-primary"; ok.textContent = en ? "I understand, continue" : "J'ai compris, continuer";
      decorate(ok, "check");
      ok.addEventListener("click", () => { lsSet(PHOTO_OK, "1"); closePhotoSheet(); photoInput.click(); });
      const no = doc.createElement("button");
      no.type = "button"; no.textContent = en ? "Cancel" : "Annuler";
      decorate(no, "x");
      no.addEventListener("click", closePhotoSheet);
      const row = doc.createElement("div");
      row.className = "hq-inventoria-photo-actions";
      row.append(ok, no);
      body.append(t, msg, row);
      photoSheet.append(body);
    };
    // After choosing a photo: a preview with "what is it?" buttons. The choice is a hint (stock / grocery / let her decide), not a command.
    let pendingPhoto = null;
    const closePhotoSheet = () => { pendingPhoto = null; photoSheet.hidden = true; photoSheet.replaceChildren(); };
    const openPhotoSheet = (dataUrl, info) => {
      pendingPhoto = dataUrl;
      selectTab("chat");
      photoSheet.replaceChildren();
      photoSheet.hidden = false;
      const en = uiLang === "en";
      const thumb = doc.createElement("img");
      thumb.className = "hq-inventoria-photo-thumb"; thumb.alt = en ? "Photo preview" : "Aperçu de la photo"; thumb.src = dataUrl;
      const ask = doc.createElement("p");
      ask.className = "hq-inventoria-photo-ask";
      ask.textContent = en ? "What should I do with this photo?" : "Qu'est-ce que je fais de cette photo ?";
      const mk = (label, icon, intent, primary) => {
        const b = doc.createElement("button");
        b.type = "button"; b.textContent = label;
        if (primary) b.classList.add("is-primary");
        decorate(b, icon);
        b.addEventListener("click", () => { const url = pendingPhoto; closePhotoSheet(); if (url) runChat(chatInput.value.trim(), url, intent); });
        return b;
      };
      const buttons = doc.createElement("div");
      buttons.className = "hq-inventoria-photo-actions";
      const cancel = doc.createElement("button");
      cancel.type = "button"; cancel.textContent = en ? "Cancel" : "Annuler";
      decorate(cancel, "x");
      cancel.addEventListener("click", closePhotoSheet);
      buttons.append(
        mk(en ? "I bought / received it" : "Je l'ai acheté / reçu", "box", "stock"),
        mk(en ? "This is my stock (count)" : "C'est mon stock (compter)", "list", "count"),
        mk(en ? "I need these" : "Il me manque ça", "cart", "grocery"),
        mk(en ? "Let her decide" : "Laisse-la décider", "sparkle", "", true),
        cancel);
      const body = doc.createElement("div");
      body.className = "hq-inventoria-photo-body";
      body.append(ask);
      const q = info && info.quality;
      if (q && (q.blurry || q.dark || q.washed || q.small)) {
        const warn = doc.createElement("p");
        warn.className = "hq-inventoria-photo-warn";
        const bits = [];
        if (q.blurry && q.washed) bits.push(en ? "blurry or overexposed" : "floue ou surexposée");   // a blurred page also looks flat
        else if (q.blurry) bits.push(en ? "blurry" : "floue");
        else if (q.washed) bits.push(en ? "overexposed" : "surexposée");
        if (q.dark) bits.push(en ? "too dark" : "trop sombre");
        if (q.small) bits.push(en ? "low resolution" : "basse résolution");
        warn.textContent = (en ? "This photo looks " : "Cette photo semble ") + bits.join(", ") + (en ? ": text and counts may be misread." : " : le texte et les comptes risquent d'être mal lus.");
        const again = doc.createElement("button");
        again.type = "button"; again.textContent = en ? "Retake" : "Reprendre la photo";
        decorate(again, "camera");
        again.addEventListener("click", () => { closePhotoSheet(); photoInput.click(); });
        body.append(warn, again);
      }
      body.append(buttons);
      photoSheet.append(thumb, body);
    };
    photoInput.addEventListener("change", () => {
      const file = photoInput.files && photoInput.files[0];
      photoInput.value = "";
      if (!file) return;
      const merging = mergeNext && !!det;
      mergeNext = false;
      shrinkImage(file).then((info) => {
        if (merging) runChat("", info.url, det.mode === "count" ? "count" : "stock", true);   // same scan, same hint: no questions
        else openPhotoSheet(info.url, info);
      }).catch((e) => { showLine(e && e.message ? e.message : "Photo impossible"); });
    });
    chatForm.insertBefore(photoBtn, chatSend);
    chatForm.appendChild(photoInput);

    // --- companion life: conversation restore, memory, greeting, dictation (no model call except when chatting)
    let uiLang = "fr", chatTouched = false, rec = null, lastStatus = 0;
    const getJson = (url) => win.fetch(url, { credentials: "same-origin" })
      .then((r) => r.json().then((d) => ({ ok: r.ok, status: r.status, data: d })));
    const avatar = () => {
      const a = doc.createElement("img");
      a.className = "hq-inventoria-avatar"; a.alt = ""; a.src = PORTRAIT; a.decoding = "async"; a.draggable = false;
      return a;
    };
    const addLogLine = (role, text) => {
      const row = doc.createElement("div");
      row.className = "hq-inventoria-row is-" + (role === "user" ? "user" : "assistant");
      const p = doc.createElement("div");
      p.className = "hq-inventoria-msg is-" + (role === "user" ? "user" : "assistant");
      p.textContent = text;
      if (role !== "user") row.appendChild(avatar());
      row.appendChild(p);
      threadLog.appendChild(row);
    };
    const emptyHint = doc.createElement("div");
    emptyHint.className = "hq-inventoria-empty";
    const emptyText = doc.createElement("p");
    emptyHint.append(ico("sparkle", "hq-inventoria-empty-ico"), emptyText);
    const syncEmpty = () => {
      const has = !!threadLog.querySelector(".hq-inventoria-msg");
      emptyText.textContent = uiLang === "en"
        ? "Tell me what you bought, ask about your stock, or send a photo of a receipt or a list."
        : "Dis-moi ce que tu as acheté, demande l'état du stock ou envoie une photo de ticket ou de liste.";
      if (has && emptyHint.parentNode) emptyHint.remove();
      else if (!has && !emptyHint.parentNode) threadLog.prepend(emptyHint);
    };
    const addTyping = (onCancel) => {
      const t = doc.createElement("div");
      t.className = "hq-inventoria-row is-assistant is-typing-row";
      const bub = doc.createElement("div");
      bub.className = "hq-inventoria-msg is-assistant is-typing";
      bub.setAttribute("aria-label", "Inventoria écrit");
      for (let i = 0; i < 3; i++) bub.appendChild(doc.createElement("i"));
      t.append(avatar(), bub);
      if (onCancel) {
        const c = doc.createElement("button");
        c.type = "button"; c.className = "hq-inventoria-typing-cancel"; c.textContent = uiLang === "en" ? "Cancel" : "Annuler";
        c.addEventListener("click", onCancel);
        t.appendChild(c);
      }
      threadLog.appendChild(t);
      threadLog.scrollTop = threadLog.scrollHeight;
      return t;
    };
    const renderThread = (msgs) => {
      threadLog.replaceChildren();
      (msgs || []).slice(-40).forEach((m) => { if (m && typeof m.text === "string") addLogLine(m.role, m.text); });
      syncEmpty();
      threadLog.scrollTop = threadLog.scrollHeight;
      threadSum.textContent = "Conversation (" + (msgs || []).length + ")";
    };
    const appendThread = (role, text) => {
      addLogLine(role, text);
      syncEmpty();
      if (role !== "user") line.hidden = true;   // the reply now lives in the thread; the top line returns for greetings and warnings
      const n = threadLog.childElementCount;
      threadSum.textContent = "Conversation (" + n + ")";
      while (threadLog.childElementCount > 80) threadLog.removeChild(threadLog.firstChild);
      threadLog.scrollTop = threadLog.scrollHeight;
    };
    const renderMemory = (notes) => {
      memoryList.replaceChildren();
      (notes || []).forEach((n) => {
        const li = doc.createElement("li");
        li.append(doc.createTextNode(n.text + " "));
        const del = doc.createElement("button");
        del.type = "button"; del.className = "hq-inventoria-memory-del"; del.textContent = "×";
        del.setAttribute("aria-label", "Oublier cette note");
        del.addEventListener("click", () => {
          del.disabled = true;
          jsonPost("/api/inventoria/memory", { action: "forget", id: n.id })
            .then((r) => { if (r.ok) renderMemory(r.data.memory); else del.disabled = false; })
            .catch(() => { del.disabled = false; });
        });
        li.appendChild(del);
        memoryList.appendChild(li);
      });
      memorySum.textContent = "Ce qu'elle retient (" + (notes || []).length + ")";
    };
    const LEVEL_TEXT = {
      en: { out: (a) => a.name + " is out of stock.", low: (a) => a.name + " is below its minimum (" + a.qty + " of " + a.min + ").", soon: (a) => a.name + " is getting low (" + a.qty + (a.min ? ", minimum " + a.min : ", warning at " + a.warn_at) + ").", trend: (a) => a.name + " may run out in about " + a.days_left + " day(s) (estimate)." },
      fr: { out: (a) => a.name + " est en rupture.", low: (a) => a.name + " est sous son minimum (" + a.qty + " sur " + a.min + ").", soon: (a) => a.name + " devient bas (" + a.qty + (a.min ? ", minimum " + a.min : ", alerte à " + a.warn_at) + ").", trend: (a) => a.name + " sera probablement épuisé dans environ " + a.days_left + " jour(s) (estimation)." },
    };
    const alertText = (a) => (LEVEL_TEXT[uiLang] || LEVEL_TEXT.fr)[a.level](a);
    const sendToChat = (text) => { selectTab("chat"); chatInput.value = text; if (chatForm.requestSubmit) chatForm.requestSubmit(); else chatForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); };
    const renderChips = () => {
      quickBox.replaceChildren();
      const en = uiLang === "en";
      const items = [
        [en ? "What's running low?" : "Qu'est-ce qui est bas ?", "alert", () => sendToChat(en ? "What is running low right now?" : "Qu'est-ce qui est bas en ce moment ?")],
        [en ? "I bought…" : "J'ai acheté…", "plus", () => { selectTab("chat"); chatInput.value = en ? "I bought " : "J'ai acheté "; chatInput.focus(); }],
        [en ? "Prepare a restock" : "Prépare un réappro", "cart", () => sendToChat(en ? "Prepare a restock draft for everything that is low." : "Prépare un brouillon de réapprovisionnement pour tout ce qui est bas.")],
        ...(photosOn() ? [[en ? "Photo" : "Photo", "camera", () => { if (!chatBusy) photoBtn.click(); }]] : []),
      ];
      items.forEach(([label, icon, fn]) => {
        const b = doc.createElement("button");
        b.type = "button"; b.className = "hq-inventoria-quick-btn"; b.textContent = label;
        decorate(b, icon);
        b.addEventListener("click", () => { if (!chatBusy) fn(); });
        quickBox.appendChild(b);
      });
      syncEmpty();
    };
    const renderAlerts = (rows) => {
      alertBox.replaceChildren();
      alertBox.hidden = !(rows && rows.length);
      shopBadge.textContent = String((rows || []).length);
      shopBadge.hidden = !(rows && rows.length);
      (rows || []).slice(0, 5).forEach((a) => {
        const item = doc.createElement("div");
        item.className = "hq-inventoria-alert is-" + a.level;
        const label = doc.createElement("span");
        label.className = "hq-inventoria-alert-text";
        label.append(ico(a.level === "trend" ? "clock" : a.level === "soon" ? "trend" : "alert", "hq-inventoria-alert-status"), doc.createTextNode(alertText(a)));
        const lead = itemBadge(a.name, 30);
        const btn = doc.createElement("button");
        btn.type = "button"; btn.className = "hq-inventoria-alert-act"; btn.textContent = uiLang === "en" ? "Restock?" : "Réappro ?";
        decorate(btn, "cart");
        btn.addEventListener("click", () => { if (!chatBusy) sendToChat(uiLang === "en" ? "Prepare a restock draft for " + a.name + "." : "Prépare un brouillon de réapprovisionnement pour " + a.name + "."); });
        if (lead) item.appendChild(lead);
        item.append(label, btn);
        alertBox.appendChild(item);
      });
    };
    const renderWatches = (rows) => {
      watchList.replaceChildren();
      (rows || []).forEach((w) => {
        const li = doc.createElement("li");
        li.append(doc.createTextNode(w.name + " — alerte à " + w.warn_at + (typeof w.qty === "number" ? " (actuel " + w.qty + ")" : "") + " "));
        const del = doc.createElement("button");
        del.type = "button"; del.className = "hq-inventoria-memory-del"; del.textContent = "×";
        del.setAttribute("aria-label", "Arrêter de surveiller");
        del.addEventListener("click", () => {
          del.disabled = true;
          jsonPost("/api/inventoria/watch", { action: "remove", item_id: w.item_id })
            .then((r) => { if (r.ok) refreshStatus({ force: true }); else del.disabled = false; })
            .catch(() => { del.disabled = false; });
        });
        li.appendChild(del);
        watchList.appendChild(li);
      });
      watchSum.textContent = "Surveillances (" + (rows || []).length + ")";
    };
    let lastShopping = null;
    const checked = {};   // item id -> true while ticked (kept across refreshes)
    const syncBought = () => {
      const n = Object.keys(checked).filter((k) => checked[k]).length;
      boughtBtn.disabled = n === 0;
      boughtBtn.textContent = (uiLang === "en" ? "Mark bought (" : "Marquer acheté (") + n + ")";
    };
    const renderChecks = (items) => {
      checkList.replaceChildren();
      checkTitle.textContent = uiLang === "en" ? "Tick what you bought, then mark it:" : "Coche ce que tu as acheté, puis valide :";
      const live = {};
      (items || []).forEach((it) => {
        live[it.id] = true;
        const li = doc.createElement("li");
        const cb = doc.createElement("input");
        cb.type = "checkbox"; cb.checked = !!checked[it.id];
        cb.setAttribute("aria-label", it.name);
        const qty = doc.createElement("input");
        qty.type = "number"; qty.min = "1"; qty.max = "100000"; qty.step = "1"; qty.value = String(it.buy);
        qty.className = "hq-inventoria-check-qty"; qty.dataset.id = it.id;
        qty.setAttribute("aria-label", "Quantité achetée de " + it.name);
        const lab = doc.createElement("span");
        lab.textContent = it.name + (it.unit ? " (" + it.unit + ")" : "");
        cb.addEventListener("change", () => { checked[it.id] = cb.checked; syncBought(); });
        const lead = itemBadge(it.name, 24);
        li.append(cb, qty);
        if (lead) li.appendChild(lead);
        li.appendChild(lab);
        checkList.appendChild(li);
      });
      Object.keys(checked).forEach((k) => { if (!live[k]) delete checked[k]; });
      syncBought();
    };
    boughtBtn.addEventListener("click", () => {
      const items = [];
      checkList.querySelectorAll("li").forEach((li) => {
        const cb = li.querySelector('input[type="checkbox"]'), qty = li.querySelector(".hq-inventoria-check-qty");
        const n = parseInt(qty.value, 10);
        if (cb.checked && n >= 1) items.push({ id: qty.dataset.id, qty: n });
      });
      if (!items.length) return;
      boughtBtn.disabled = true;
      ensureSession(false).then((sid) => jsonPost("/api/inventoria/purchased", { session_id: sid, items })).then((r) => {
        if (!r.ok || !r.data || !r.data.operation) throw r;
        Object.keys(checked).forEach((k) => delete checked[k]);
        chatTouched = true;
        showDraft([r.data.operation]);
      }).catch((r) => { copyNote.textContent = (r && r.data && r.data.error) || "Impossible de préparer le brouillon."; syncBought(); });
    });
    shareBtn.addEventListener("click", () => {
      const text = shopText.value;
      win.navigator.share({ title: uiLang === "en" ? "Shopping list" : "Liste de courses", text })
        .then(() => { copyNote.textContent = ""; })
        .catch((e) => { if (!e || e.name !== "AbortError") copyNote.textContent = uiLang === "en" ? "Sharing unavailable. Use Copy." : "Partage indisponible. Utilise Copier."; });
    });
    groceryBtn.addEventListener("click", () => {
      groceryBtn.disabled = true;
      jsonPost("/api/inventoria/to-grocery", { include_soon: soonBox.checked }).then((r) => {
        copyNote.textContent = r.ok ? (uiLang === "en" ? "Added to a new grocery list (" + r.data.count + " lines)." : "Ajouté à une nouvelle liste de courses (" + r.data.count + " lignes).")
          : ((r.data && r.data.error) || "Envoi impossible.");
      }).catch(() => { copyNote.textContent = "Envoi impossible."; }).finally(() => { groceryBtn.disabled = false; });
    });
    groupBox.addEventListener("change", () => {
      try { win.localStorage.setItem("hq_inventoria_copy_group", groupBox.checked ? "1" : "0"); } catch (_) {}
      renderShopping();
    });
    const renderShopping = () => {
      if (!lastShopping) return;
      const pick = soonBox.checked ? lastShopping.all : lastShopping.urgent;
      const total = lastShopping.all ? lastShopping.all.count : 0;
      copyBox.hidden = total === 0;
      const canGroup = !!(pick && pick.text_grouped);
      groupLabel.hidden = !canGroup;
      shopText.value = pick ? ((groupBox.checked && canGroup) ? pick.text_grouped : pick.text) : "";
      renderChecks(pick ? pick.items : []);
      shopText.rows = Math.min(14, Math.max(4, (pick ? pick.count : 0) + 2));
      copySum.textContent = (uiLang === "en" ? "List to copy (" : "Liste à copier (") + (pick ? pick.count : 0) + ")";
      soonText.nodeValue = uiLang === "en" ? " Include \"getting low\"" : " Inclure « bientôt bas »";
      groupText.nodeValue = uiLang === "en" ? " Group by store" : " Grouper par magasin";
      copyBtn.textContent = uiLang === "en" ? "Copy" : "Copier";
      shareBtn.textContent = uiLang === "en" ? "Share" : "Partager";
      groceryBtn.textContent = uiLang === "en" ? "Send to grocery list" : "Envoyer vers Courses";
    };
    soonBox.addEventListener("change", () => {
      try { win.localStorage.setItem("hq_inventoria_copy_soon", soonBox.checked ? "1" : "0"); } catch (_) {}
      copyNote.textContent = "";
      renderShopping();
    });
    copyBtn.addEventListener("click", () => {
      const text = shopText.value;
      const done = (ok) => {
        copyNote.textContent = ok ? (uiLang === "en" ? "Copied. Paste it into Notes." : "Copié. Colle-le dans Notes.")
          : (uiLang === "en" ? "Select the text and copy it." : "Sélectionne le texte puis copie-le.");
      };
      const fallback = () => {
        let ok = false;
        try { shopText.focus(); shopText.select(); shopText.setSelectionRange(0, text.length); ok = !!doc.execCommand("copy"); } catch (_) {}
        done(ok);
      };
      if (win.navigator.clipboard && win.navigator.clipboard.writeText) win.navigator.clipboard.writeText(text).then(() => done(true), fallback);
      else fallback();
    });
    const saveNotify = (extra) => jsonPost("/api/inventoria/notify", Object.assign({ enabled: notifyOn.checked, instant: notifyInstant.checked, digest_hour: parseInt(notifyHour.value, 10) }, extra || {}))
      .then((r) => { notifyNote.textContent = r.ok ? (extra && extra.test ? (r.data.test_sent ? "Test envoyé." : "Aucun canal configuré (webhook Discord ou push).") : "Réglages enregistrés.") : ((r.data && r.data.error) || "Échec."); notifySum.textContent = "Alertes hors ligne (" + (r.ok && r.data.notify.enabled ? "activées" : "désactivées") + ")"; })
      .catch(() => { notifyNote.textContent = "Échec."; });
    notifyOn.addEventListener("change", () => saveNotify());
    notifyInstant.addEventListener("change", () => saveNotify());
    notifyHour.addEventListener("change", () => saveNotify());
    notifyTest.addEventListener("click", () => saveNotify({ test: true }));
    const RANK = { trend: 0.5, soon: 1, low: 2, out: 3 };
    let seenAlerts = null;
    const detectNew = (rows) => {
      const cur = {};
      (rows || []).forEach((a) => { cur[a.id] = RANK[a.level] || 0; });
      const fresh = seenAlerts ? (rows || []).filter((a) => !(a.id in seenAlerts) || cur[a.id] > seenAlerts[a.id]) : [];
      seenAlerts = cur;
      return fresh;
    };
    const refreshStatus = (opts) => getJson("/api/inventoria/status").then((r) => {
      if (!r.ok || !r.data) return;
      lastStatus = Date.now();
      uiLang = r.data.language || "fr";
      renderMemory(r.data.memory || []);
      renderAlerts(r.data.alerts || []);
      renderWatches(r.data.watches || []);
      lastShopping = r.data.shopping || null;
      renderShopping();
      const anyAlerts = (r.data.alerts || []).length > 0 || !!(lastShopping && lastShopping.all && lastShopping.all.count);
      shopEmpty.hidden = anyAlerts;
      shopEmpty.textContent = uiLang === "en" ? "Everything is comfortably stocked." : "Tout est bien approvisionné.";
      renderChips();
      const nt = r.data.notify || {};
      notifyOn.checked = !!nt.enabled; notifyInstant.checked = nt.instant !== false;
      if (typeof nt.digest_hour === "number") notifyHour.value = String(nt.digest_hour);
      notifySum.textContent = "Alertes hors ligne (" + (nt.enabled ? "activées" : "désactivées") + ")";
      const fresh = detectNew(r.data.alerts || []);
      if (fresh.length && opts && opts.warn) {
        // A stock item just crossed into (or deeper into) an alert level: warn without a model call.
        if (!chatTouched || !open) { showLine(alertText(fresh[0])); line.dataset.greeting = "1"; }
        setMood("proactive", 6000);
        if (activeTab !== "shop") tabShop.classList.add("is-new");
        try { win.dispatchEvent(new CustomEvent("hq:inventoria-alert", { detail: { alerts: fresh } })); } catch (_) {}
      }
      const g = r.data.greeting || {};
      if (!chatTouched && g.line && (line.textContent === IDLE_LINE || (opts && opts.force) || line.dataset.greeting === "1")) {
        showLine(g.line);
        line.dataset.greeting = "1";
        if (g.mood === "proactive" && opts && opts.announce) setMood("proactive", 5000);
      }
    }).catch(() => {});
    const restoreThread = () => {
      let sid = "";
      try { sid = win.localStorage.getItem(SESSION_KEY) || ""; } catch (_) {}
      if (!sid) return;
      getJson("/api/inventoria/sessions/" + sid).then((r) => {
        if (r.ok && r.data && r.data.session) {
          const msgs = r.data.session.messages || [];
          renderThread(msgs);
          // Whatever she was waiting on comes back: pending drafts (server truth), the photo review and the grocery card.
          const pending = r.data.pending_operations || [];
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant" && last.meta && String(last.at) !== lsGet(RESOLVED_AT)) {
            currentCardAt = last.at;
            if (last.meta.detections && last.meta.detections.rows && last.meta.detections.rows.length) showDetections(last.meta.detections, null);
            if (last.meta.grocery && last.meta.grocery.length) showGrocery(last.meta.grocery);
          }
          if (pending.length) showDraft(pending);
        } else if (r.status === 404) { try { win.localStorage.removeItem(SESSION_KEY); } catch (_) {} }
      }).catch(() => {});
    };
    win.addEventListener("hq:inventoria-open", () => { if (Date.now() - lastStatus > 60000) refreshStatus({ announce: true }); });
    win.addEventListener("hq:inventory-changed", () => refreshStatus({ force: true, announce: true, warn: true }));
    win.setInterval(() => { if (!win.document.hidden) refreshStatus({ announce: true, warn: true }); }, 5 * 60 * 1000);
    win.document.addEventListener("visibilitychange", () => { if (!win.document.hidden && Date.now() - lastStatus > 60000) refreshStatus({ announce: true, warn: true }); });
    const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (SR) {
      const micBtn = doc.createElement("button");
      micBtn.type = "button"; micBtn.className = "hq-inventoria-chat-mic"; micBtn.textContent = "";
      decorate(micBtn, "mic", true);
      micBtn.setAttribute("aria-label", "Dicter un message");
      micBtn.addEventListener("click", () => {
        if (rec) { try { rec.stop(); } catch (_) {} return; }
        stopVoice();
        const r = new SR();
        rec = r;
        r.lang = uiLang === "en" ? "en-US" : "fr-CA";
        r.interimResults = false; r.maxAlternatives = 1;
        r.onresult = (e) => {
          const t = e.results && e.results[0] && e.results[0][0] ? e.results[0][0].transcript : "";
          if (!t) return;
          chatInput.value = t;
          if (chatForm.requestSubmit) chatForm.requestSubmit(); else chatForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        };
        r.onend = r.onerror = () => { if (rec === r) rec = null; micBtn.classList.remove("is-listening"); };
        micBtn.classList.add("is-listening");
        try { r.start(); } catch (_) { rec = null; micBtn.classList.remove("is-listening"); }
      });
      chatForm.insertBefore(micBtn, chatSend);
    }
    syncPhotoUi();
    syncEmpty();
    restoreThread();
    refreshStatus({ announce: false });

    win.HqInventoria = {
      speak: speakLine,
      stopSpeaking: stopVoice,
      open: () => { setChipVisible(true); setOpen(true); },
      close: () => setOpen(false),
      setLine: (text, opts) => {
        showLine(String(text || IDLE_LINE));
        const mood = opts && opts.mood;
        if (mood) setMood(mood, (opts && opts.ms) || 2200);
        else if (text && text !== IDLE_LINE) setMood("speaking", 1800);
      },
      setMood: (m, ms) => setMood(m, ms),
      mood: () => currentMood,
      setBusy: (on) => setBusy(on),
      moods: () => MOODS.slice(),
      portraits: () => Object.assign({}, PORTRAIT_BY_MOOD),
      setVisible: (on) => setChipVisible(on !== false),
      isVisible: () => chipVisible,
      isOpen: () => open,
      resetFloat: (opts) => chipFloat.reset(opts || {}),
      setChipScale: (s) => (chipScale ? chipScale.setScale(s) : 1),
      chipScale: () => (chipScale ? chipScale.getScale() : 1),
      resetChipScale: () => (chipScale ? chipScale.resetScale() : 1),
      root,
      toggle,
    };

    try {
      if (win.localStorage.getItem(LS_VISIBLE) === "0") setChipVisible(false, { silent: true });
      if (chipVisible && win.localStorage.getItem(LS_OPEN) === "1") setOpen(true);
    } catch (_) {}

    if (win.HqImageChipScale && typeof win.HqImageChipScale.bindPortraitMode === "function") {
      win.HqImageChipScale.bindPortraitMode(win, {
        root,
        onRefresh: () => applyPortrait(currentMood),
      });
    }

    setMood("idle");
    syncView();
    syncMotionPerf();
    win.addEventListener("hq:view", syncView);
    win.addEventListener("hq:session-role", syncView);
    win.addEventListener("hq:motion-mode", syncMotionPerf);
    try {
      new win.MutationObserver(() => {
        syncView();
        syncMotionPerf();
      }).observe(doc.body, { attributes: true, attributeFilter: ["class", "data-view"] });
    } catch (_) {}
  }

  function boot() {
    const win = window;
    const start = () => mount(win);
    win.addEventListener("hq:session-role", start);
    if (win.document.readyState === "loading") {
      win.document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  boot();
})();
