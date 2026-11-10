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

    bubble.append(head, line);

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
      const intime = view === "intime" || doc.body.classList.contains("hq-intime-active");
      root.hidden = intime;
      toggle.hidden = intime;
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

    closeBtn.addEventListener("click", () => setOpen(false));
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

    win.HqInventoria = {
      open: () => { setChipVisible(true); setOpen(true); },
      close: () => setOpen(false),
      setLine: (text, opts) => {
        line.textContent = String(text || IDLE_LINE);
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
    if (win.document.readyState === "loading") {
      win.document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  boot();
})();
