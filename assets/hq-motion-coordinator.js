/* HQ motion coordinator — shared tier, budgets, and perf feedback for canvas/rAF subsystems. */
(function (root) {
  "use strict";

  const STORE = "hq-motion-mode";
  const MODES = ["auto", "lite", "smooth"];
  const AUTO_LITE_HOLD_MS = 30000;
  const COST_FRESH_MS = 2200;
  const RECOVERY_FRAMES = 450;

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
  let autoLiteReason = "";
  let autoLiteUntil = 0;
  let emaLive2d = 0;
  let emaDangle = 0;
  let emaFrameGap = 16.7;
  let frameBadScore = 0;
  let frameSamples = 0;
  let recoveryFrames = 0;
  let lastLive2dAt = 0;
  let lastDangleAt = 0;
  let frameProbeLast = 0;
  let frameProbeRaf = 0;

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

  function nowMs() {
    try {
      return root.performance.now();
    } catch (_) {
      return Date.now();
    }
  }

  function publishTier(reason) {
    syncDoc();
    root.dispatchEvent(new CustomEvent("hq:motion-mode", {
      detail: { mode: mode, tier: tier(), reason: reason || "" },
    }));
  }

  function setAutoLite(next, reason, now) {
    const on = !!next;
    if (on) {
      autoLiteUntil = Math.max(autoLiteUntil, (now || nowMs()) + AUTO_LITE_HOLD_MS);
      autoLiteReason = reason || autoLiteReason || "pressure";
    }
    if (autoLite === on) return;
    autoLite = on;
    if (!on) {
      autoLiteReason = "";
      autoLiteUntil = 0;
    }
    publishTier(on ? autoLiteReason : "recovered");
  }

  function costFresh(lastAt, now) {
    return lastAt > 0 && now - lastAt <= COST_FRESH_MS;
  }

  function evaluatePressure(now, source) {
    if (mode !== "auto" || hidden || reducedMotion()) return;
    const liveHot = costFresh(lastLive2dAt, now) && emaLive2d > 14.2;
    const dangleHot = costFresh(lastDangleAt, now) && emaDangle > 16.5;
    const frameHot = frameSamples >= 12 && (frameBadScore >= 18 || emaFrameGap > 24);
    if (liveHot || dangleHot || frameHot) {
      recoveryFrames = 0;
      const reason = frameHot ? "frame-gap" : dangleHot ? "dangle" : "live2d";
      setAutoLite(true, source || reason, now);
      return;
    }
    if (!autoLite || now < autoLiteUntil) {
      recoveryFrames = 0;
      return;
    }
    const liveCool = !costFresh(lastLive2dAt, now) || emaLive2d < 11;
    const dangleCool = !costFresh(lastDangleAt, now) || emaDangle < 12;
    const frameCool = frameBadScore <= 2 && emaFrameGap < 20.5;
    recoveryFrames = liveCool && dangleCool && frameCool ? recoveryFrames + 1 : 0;
    if (recoveryFrames >= RECOVERY_FRAMES) setAutoLite(false, "recovered", now);
  }

  function frameProbe(t) {
    frameProbeRaf = 0;
    if (hidden) {
      frameProbeLast = 0;
      return;
    }
    if (frameProbeLast) {
      const gap = t - frameProbeLast;
      if (gap > 0 && gap < 250) {
        emaFrameGap = frameSamples ? emaFrameGap * 0.92 + gap * 0.08 : gap;
        frameSamples = Math.min(600, frameSamples + 1);
        if (gap > 24) frameBadScore = Math.min(120, frameBadScore + 2);
        else if (gap < 21) frameBadScore = Math.max(0, frameBadScore - 1);
        evaluatePressure(t, "");
      }
    }
    frameProbeLast = t;
    frameProbeRaf = root.requestAnimationFrame(frameProbe);
  }

  function startFrameProbe() {
    if (hidden || frameProbeRaf || typeof root.requestAnimationFrame !== "function") return;
    frameProbeLast = 0;
    frameProbeRaf = root.requestAnimationFrame(frameProbe);
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
    if (mode !== "auto") {
      autoLite = false;
      autoLiteReason = "";
      autoLiteUntil = 0;
      recoveryFrames = 0;
    }
    publishTier("mode");
    if (mode === "auto") evaluatePressure(nowMs(), "mode");
    return mode;
  }

  function noteCost(subsystem, ms) {
    const n = Number(ms);
    if (!isFinite(n) || n <= 0) return;
    if (subsystem === "live2d" || subsystem === "companion") {
      emaLive2d = emaLive2d ? emaLive2d * 0.9 + n * 0.1 : n;
      lastLive2dAt = nowMs();
      evaluatePressure(lastLive2dAt, "live2d");
    }
    if (subsystem === "dangle") {
      emaDangle = emaDangle ? emaDangle * 0.88 + n * 0.12 : n;
      lastDangleAt = nowMs();
      evaluatePressure(lastDangleAt, "dangle");
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
      if (ctx.view === "accueil") return ctx.looking ? 34 : 48;
      return ctx.compact && ctx.collapsed ? 42 : 28;
    }
    if (ctx.view === "accueil" && ctx.perfPressure) return 42;
    if (ctx.view === "accueil" && !ctx.looking && ctx.collapsed) return 56;
    if (ctx.compact && ctx.collapsed) return 28;
    if (ctx.minimal && !ctx.intime) return 22;
    if (ctx.perfPressure) return 30;
    return 15;
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
      autoLiteReason: autoLiteReason,
      autoLiteHoldMs: Math.max(0, Math.round(autoLiteUntil - nowMs())),
      emaLive2d: Math.round(emaLive2d * 10) / 10,
      emaDangle: Math.round(emaDangle * 10) / 10,
      emaFrameGap: Math.round(emaFrameGap * 10) / 10,
      frameBadScore: frameBadScore,
      companionLooking: companionLooking,
      dangleSeen: dangleSeen,
      homeSeen: homeSeen,
    };
  }

  syncDoc();
  if (root.document) {
    root.document.addEventListener("visibilitychange", function () {
      syncDoc();
      if (!hidden) startFrameProbe();
      else frameProbeLast = 0;
    });
    if (root.document.body) {
      new root.MutationObserver(syncDoc).observe(root.document.body, {
        attributes: true,
        attributeFilter: ["data-view"],
      });
    } else {
      root.document.addEventListener("DOMContentLoaded", syncDoc, { once: true });
    }
  }
  startFrameProbe();

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
