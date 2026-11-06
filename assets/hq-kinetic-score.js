/* HQ kinetic score — sparse motion phrases shared across companion, member, Accueil.
 * Event-driven envelopes only; no continuous physics. HqMotion sets tier limits. */
(function (root) {
  "use strict";

  let active = [];
  let subs = [];
  let rafId = 0;
  let lastTickAt = 0;
  let seq = 0;
  let manipActive = false;

  function tier() {
    try {
      return root.HqMotion && root.HqMotion.tier ? root.HqMotion.tier() : "full";
    } catch (_) {
      return "full";
    }
  }

  function maxActive() {
    const t = tier();
    if (t === "parked") return 0;
    if (t === "lite") return 3;
    return 8;
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function normDir(d) {
    if (!d || typeof d !== "object") return { x: 0, y: -1 };
    const x = Number(d.x) || 0;
    const y = Number(d.y) || 0;
    const m = Math.hypot(x, y);
    if (m < 1e-6) return { x: 0, y: -1 };
    return { x: x / m, y: y / m };
  }

  function envelopeProgress(p, attack, hold, decay) {
    if (p < 0) return 0;
    if (p < attack) return attack > 0 ? p / attack : 1;
    if (p < attack + hold) return 1;
    const tail = 1 - attack - hold;
    if (tail <= 0) return 0;
    const u = (p - attack - hold) / tail;
    return u >= 1 ? 0 : 1 - u;
  }

  function phraseEnergy(phrase, now) {
    const start = phrase.startAt + phrase.delayMs;
    if (now < start) return 0;
    const dur = phrase.durationMs;
    if (dur <= 0) return 0;
    const p = (now - start) / dur;
    return phrase.intensity * envelopeProgress(p, phrase.attack, phrase.hold, phrase.decay);
  }

  function deliver(phrase, energy, phase, delta) {
    if (manipActive && phrase.source === "member" && phrase.kind !== "release") return;
    const ev = {
      id: phrase.id,
      kind: phrase.kind,
      source: phrase.source,
      direction: phrase.direction,
      energy: energy,
      deltaEnergy: delta,
      phase: phase,
      tier: tier(),
      at: root.performance.now(),
    };
    for (let i = 0; i < subs.length; i += 1) {
      try {
        subs[i].fn(ev);
      } catch (_) {}
    }
  }

  function stopTick() {
    if (rafId) {
      root.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    lastTickAt = 0;
  }

  function tick(now) {
    rafId = 0;
    if (!active.length) return;
    if (tier() === "parked") {
      active = [];
      stopTick();
      return;
    }
    const next = [];
    for (let i = 0; i < active.length; i += 1) {
      const ph = active[i];
      const e = phraseEnergy(ph, now);
      const prev = ph._lastE || 0;
      ph._lastE = e;
      if (e > 0.008) {
        deliver(ph, e, "pulse", e - prev);
        next.push(ph);
      } else if (prev > 0.008) {
        deliver(ph, 0, "end", -prev);
      }
    }
    active = next;
    if (active.length) scheduleTick();
    else lastTickAt = 0;
  }

  function scheduleTick() {
    if (rafId || !active.length) return;
    rafId = root.requestAnimationFrame(function frame(now) {
      if (!lastTickAt) lastTickAt = now;
      tick(now);
    });
  }

  function cancel(filter) {
    const f = filter || {};
    const wantId = f.id != null ? String(f.id) : "";
    const wantSrc = f.source != null ? String(f.source) : "";
    const wantKind = f.kind != null ? String(f.kind) : "";
    const kept = [];
    for (let i = 0; i < active.length; i += 1) {
      const ph = active[i];
      const drop =
        (wantId && ph.id === wantId) ||
        (wantSrc && ph.source === wantSrc && (!wantKind || ph.kind === wantKind));
      if (drop) deliver(ph, 0, "end", -(ph._lastE || 0));
      else kept.push(ph);
    }
    active = kept;
    if (!active.length) stopTick();
  }

  function emit(payload) {
    const p = payload || {};
    const max = maxActive();
    if (max <= 0) return null;
    const kind = String(p.kind || "impulse");
    if (p.replace) cancel({ source: p.source, kind: kind });
    while (active.length >= max) {
      const old = active.shift();
      if (old) deliver(old, 0, "end", -(old._lastE || 0));
    }
    const now = root.performance.now();
    const id = "k" + String(++seq);
    const phrase = {
      id: id,
      kind: kind,
      source: String(p.source || "unknown"),
      intensity: clamp(Number(p.intensity) || 0.5, 0, 1.5),
      direction: normDir(p.direction),
      startAt: now,
      delayMs: Math.max(0, Number(p.delayMs) || 0),
      durationMs: clamp(Number(p.durationMs) || 480, 80, 2400),
      attack: clamp(Number(p.attack) || 0.14, 0.05, 0.55),
      hold: clamp(Number(p.hold) || 0.1, 0, 0.55),
      decay: clamp(Number(p.decay) || 0.76, 0.12, 1),
    };
    phrase._lastE = 0;
    active.push(phrase);
    deliver(phrase, phraseEnergy(phrase, now), "start", 0);
    scheduleTick();
    try {
      root.dispatchEvent(new root.CustomEvent("hq:kinetic", { detail: { phase: "emit", id: id, kind: kind } }));
    } catch (_) {}
    return id;
  }

  function subscribe(subscriberId, fn) {
    const rec = { id: String(subscriberId || "anon"), fn: typeof fn === "function" ? fn : function () {} };
    subs.push(rec);
    return function unsubscribe() {
      subs = subs.filter(function (s) {
        return s !== rec;
      });
    };
  }

  function getState() {
    return {
      active: active.length,
      ticking: !!rafId,
      tier: tier(),
      manipulating: manipActive,
      phrases: active.map(function (ph) {
        return { id: ph.id, kind: ph.kind, source: ph.source };
      }),
    };
  }

  function setManipulating(on) {
    manipActive = !!on;
    if (manipActive) cancel({ source: "member", kind: "contact" });
  }

  function isManipulating() {
    return manipActive;
  }

  root.addEventListener("hq:motion-mode", function () {
    if (tier() === "parked") {
      active = [];
      stopTick();
    }
  });

  root.HqKinetic = {
    emit: emit,
    cancel: cancel,
    subscribe: subscribe,
    getState: getState,
    setManipulating: setManipulating,
    isManipulating: isManipulating,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
