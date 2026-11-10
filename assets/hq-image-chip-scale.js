/* Shared pinch / Ctrl+wheel scale for Else + Inventoria image chips (companion-aligned range). */
(function () {
  "use strict";

  const SCALE_MIN = 0.72;
  const SCALE_MAX = 1.42;
  const WHEEL_STEP = 0.055;
  const MENU_STEP = 0.08;

  function clampNum(n, lo, hi) {
    const v = Number(n);
    if (!Number.isFinite(v)) return lo;
    return Math.max(lo, Math.min(hi, v));
  }

  function readScale(win, storageKey) {
    try {
      const v = parseFloat(win.localStorage.getItem(storageKey));
      if (!Number.isFinite(v)) return 1;
      return clampNum(v, SCALE_MIN, SCALE_MAX);
    } catch (_) {
      return 1;
    }
  }

  function applyScale(root, scale) {
    if (!root) return;
    root.style.setProperty("--image-chip-user-scale", scale.toFixed(3));
    root.classList.add("is-chip-scaled");
    if (scale > 1.001 || scale < 0.999) root.classList.add("is-chip-user-scaled");
    else root.classList.remove("is-chip-user-scaled");
  }

  function bind(win, opts) {
    const root = opts.root;
    const chip = opts.chip;
    const storageKey = opts.storageKey;
    const setBlocked = typeof opts.setBlocked === "function" ? opts.setBlocked : function () {};
    const cancelDrag = typeof opts.cancelDrag === "function" ? opts.cancelDrag : function () {};
    let scale = readScale(win, storageKey);
    applyScale(root, scale);

    function persist() {
      try {
        win.localStorage.setItem(storageKey, scale.toFixed(3));
      } catch (_) {}
    }

    function setScale(next) {
      scale = clampNum(next, SCALE_MIN, SCALE_MAX);
      applyScale(root, scale);
      persist();
      return scale;
    }

    const pointers = new Map();
    let session = null;

    const pinchDist = () => {
      const pts = [...pointers.values()];
      if (pts.length < 2) return 0;
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    };

    const endPinch = () => {
      if (session) {
        persist();
        root.classList.remove("is-chip-scale-pop");
        void root.offsetWidth;
        root.classList.add("is-chip-scale-pop");
        win.setTimeout(() => root && root.classList.remove("is-chip-scale-pop"), 480);
      }
      session = null;
      chip.classList.remove("is-chip-pinching");
      setBlocked(false);
    };

    chip.addEventListener(
      "pointerdown",
      (ev) => {
        if (ev.button && ev.button !== 0) return;
        pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (pointers.size === 2) {
          const d = pinchDist();
          if (d < 10) return;
          cancelDrag();
          setBlocked(true);
          session = { startDist: d, startScale: scale };
          chip.classList.add("is-chip-pinching");
        }
      },
      { capture: true, passive: true }
    );

    chip.addEventListener(
      "pointermove",
      (ev) => {
        if (!pointers.has(ev.pointerId)) return;
        pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (!session || pointers.size < 2) return;
        const dist = pinchDist();
        if (dist < 12 || session.startDist < 12) return;
        const ratio = dist / session.startDist;
        setScale(session.startScale * ratio);
        if (ev.cancelable) ev.preventDefault();
      },
      { capture: true, passive: false }
    );

    const onUp = (ev) => {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) endPinch();
    };
    chip.addEventListener("pointerup", onUp, { capture: true });
    chip.addEventListener("pointercancel", onUp, { capture: true });
    chip.addEventListener("pointerleave", (ev) => {
      if (pointers.has(ev.pointerId)) onUp(ev);
    });

    chip.addEventListener(
      "wheel",
      (ev) => {
        if (!ev.ctrlKey && !ev.altKey) return;
        ev.preventDefault();
        const step = ev.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
        setScale(scale + step);
      },
      { passive: false }
    );

    return {
      getScale: () => scale,
      setScale,
      bump: (delta) => setScale(scale + (Number(delta) || 0)),
      resetScale: () => setScale(1),
      min: SCALE_MIN,
      max: SCALE_MAX,
      menuStep: MENU_STEP,
    };
  }

  const LS_COMPANION_NSFW = "hq_companion_nsfw";

  function adultChipPortraits(win) {
    try {
      if (typeof win.hqCompanionNsfwOn === "function") {
        return !!win.hqCompanionNsfwOn();
      }
    } catch (_) {}
    return false;
  }

  function bindPortraitMode(win, opts) {
    const root = opts && opts.root;
    const onRefresh = opts && opts.onRefresh;
    if (!win || !root) return { sync: function () {}, adultActive: function () { return false; } };

    function sync() {
      const adult = adultChipPortraits(win);
      root.classList.toggle("is-chip-adult-portraits", adult);
      root.classList.toggle("is-chip-sfw-portraits", !adult);
      if (typeof onRefresh === "function") onRefresh(adult);
    }

    sync();
    win.addEventListener("hq:companion-nsfw", sync);
    win.addEventListener("storage", (ev) => {
      if (ev && ev.key === LS_COMPANION_NSFW) sync();
    });

    return { sync, adultActive: () => adultChipPortraits(win) };
  }

  window.HqImageChipScale = {
    bind,
    bindPortraitMode,
    adultChipPortraits,
    SCALE_MIN,
    SCALE_MAX,
    MENU_STEP,
  };
})();
