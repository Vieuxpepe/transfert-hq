/* HQ motion coordinator — shared tier, budgets, and perf feedback for canvas/rAF subsystems. */
(function (root) {
  "use strict";

  const STORE = "hq-motion-mode";
  const MODES = ["auto", "lite", "smooth"];

  let mode = "auto";
  try {
    const saved = root.localStorage.getItem(STORE);
    if (saved === "lite" || saved === "smooth") mode = saved;
  } catch (_) {}

  let hidden = true;
  let view = "";
  let companionLooking = false;
  let companionVisible = 1;
  let dangleSeen = true;
  let homeSeen = true;
  let autoLite = false;
  let emaLive2d = 0;
  let emaDangle = 0;

  function reducedMotion() {
    try {
      return root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  function syncDoc() {
    hidden = !!(root.document && root.document.hidden);
    view = (root.document.body && root.document.body.dataset.view) || "";
    const el = root.document && root.document.documentElement;
    if (el) {
      el.dataset.hqMotionView = view || "";
      el.dataset.hqMotionTier = tier();
      el.dataset.hqMotionMode = mode;
    }
  }

  function tier() {
    if (hidden) return "parked";
    if (reducedMotion()) return "parked";
    if (mode === "lite") return "lite";
    if (mode === "smooth") return "full";
    if (autoLite) return "lite";
    return "full";
  }

  function setMode(next) {
    const m = String(next || "auto");
    mode = MODES.indexOf(m) >= 0 ? m : "auto";
    try {
      if (mode === "auto") root.localStorage.removeItem(STORE);
      else root.localStorage.setItem(STORE, mode);
    } catch (_) {}
    syncDoc();
    root.dispatchEvent(new CustomEvent("hq:motion-mode", { detail: { mode: mode, tier: tier() } }));
    return mode;
  }

  function noteCost(subsystem, ms) {
    const n = Number(ms);
    if (!isFinite(n) || n <= 0) return;
    if (subsystem === "live2d" || subsystem === "companion") {
      emaLive2d = emaLive2d ? emaLive2d * 0.9 + n * 0.1 : n;
      if (mode === "auto") {
        if (emaLive2d > 14.2) autoLite = true;
        else if (emaLive2d < 10.5) autoLite = false;
      }
      syncDoc();
    }
    if (subsystem === "dangle") {
      emaDangle = emaDangle ? emaDangle * 0.88 + n * 0.12 : n;
    }
    if (root.hqPerfMark && n >= 18 && subsystem === "dangle") {
      root.hqPerfMark("dangle", { op: "dangle-paint", ms: Math.round(n * 10) / 10, tier: tier() });
    }
  }

  function live2dMinGap(ctx) {
    ctx = ctx || {};
    if (ctx.hot) return 0;
    const t = tier();
    if (t === "parked") return 999;
    if (t === "lite") {
      if (ctx.view === "accueil") return ctx.looking ? 56 : 80;
      return ctx.compact && ctx.collapsed ? 64 : 48;
    }
    if (ctx.view === "accueil" && ctx.perfPressure) return 72;
    if (ctx.view === "accueil" && !ctx.looking && ctx.collapsed) return 88;
    if (ctx.compact && ctx.collapsed) return 48;
    if (ctx.minimal && !ctx.intime) return 40;
    if (ctx.perfPressure) return 50;
    return 32;
  }

  function companionLive2dShouldRun(ctx) {
    ctx = ctx || {};
    if (tier() === "parked") return false;
    if (ctx.hot) return true;
    if (ctx.keepAlive) return true;
    if (ctx.intime) return true;
    if (ctx.view === "intime") return true;
    if (ctx.view === "accueil" && ctx.collapsed && !ctx.looking) return false;
    return true;
  }

  function dangleShouldRun() {
    if (tier() === "parked") return false;
    if (!dangleSeen) return false;
    return true;
  }

  function homeEffectsPaused() {
    if (hidden) return true;
    if (view !== "accueil") return true;
    if (tier() === "parked") return true;
    if (!homeSeen) return true;
    return false;
  }

  function setCompanionAttention(looking, visibleRatio) {
    companionLooking = !!looking;
    if (typeof visibleRatio === "number") companionVisible = visibleRatio;
  }

  function setDangleSeen(seen) {
    dangleSeen = seen !== false;
  }

  function setHomeSeen(seen) {
    homeSeen = seen !== false;
  }

  function getState() {
    return {
      mode: mode,
      tier: tier(),
      view: view,
      hidden: hidden,
      autoLite: autoLite,
      emaLive2d: Math.round(emaLive2d * 10) / 10,
      emaDangle: Math.round(emaDangle * 10) / 10,
      companionLooking: companionLooking,
      dangleSeen: dangleSeen,
      homeSeen: homeSeen,
    };
  }

  syncDoc();
  if (root.document) {
    root.document.addEventListener("visibilitychange", syncDoc);
    if (root.document.body) {
      new root.MutationObserver(syncDoc).observe(root.document.body, {
        attributes: true,
        attributeFilter: ["data-view"],
      });
    } else {
      root.document.addEventListener("DOMContentLoaded", syncDoc, { once: true });
    }
  }

  root.HqMotion = {
    tier: tier,
    getState: getState,
    setMode: setMode,
    getMode: () => mode,
    noteCost: noteCost,
    live2dMinGap: live2dMinGap,
    companionLive2dShouldRun: companionLive2dShouldRun,
    dangleShouldRun: dangleShouldRun,
    homeEffectsPaused: homeEffectsPaused,
    setCompanionAttention: setCompanionAttention,
    setDangleSeen: setDangleSeen,
    setHomeSeen: setHomeSeen,
    sync: syncDoc,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
