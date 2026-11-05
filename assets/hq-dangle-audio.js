/* Dangling-member SFX: manifest OGG pools + shared companion SFX bus (forge sound toggle). */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HqDangleAudio = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const LS_FORGE_SOUND = "hq_companion_forge_sound";
  const LS_MUTE = "hq_companion_mute_until";
  const IMPACT_KINDS = new Set(["slap", "muffled", "grab", "hair_pat", "tit_pull"]);

  const TIT_PULL_ELASTIC_RE = /else_tit_pull_(01|07)\./i;
  const TIT_PULL_SLOSH_RE = /else_tit_pull_(10|13)\./i;

  function titPullStemPool(pool, kind, stemId) {
    if (!pool?.length) return pool;
    const urls = pool.map(String);
    if (stemId) {
      const stem = String(stemId).padStart(2, "0");
      const one = urls.filter(u => new RegExp(`else_tit_pull_${stem}\\.`, "i").test(u));
      if (one.length) return one;
    }
    if (kind === "slosh") {
      const slosh = urls.filter(u => TIT_PULL_SLOSH_RE.test(u));
      return slosh.length ? slosh : pool;
    }
    if (kind === "elastic") {
      const elastic = urls.filter(u => TIT_PULL_ELASTIC_RE.test(u));
      return elastic.length ? elastic : pool;
    }
    return pool;
  }
  const SAMPLE_KINDS = new Set([
    "giggle", "laugh", "lipsmack", "wet_mouth", "gulp", "pleasure", "whimper", "moan", "exhale", "pop", "booty_breath"
  ]);

  let winRef = null;
  let player = null;
  let ready = null;
  let audioCtx = null;
  let sfxBus = null;
  let scriptLoad = null;
  let lastAt = {};
  let oralDepthMark = 0;
  let oralPhaseLast = "idle";
  let oralDepthLast = 0;

  function muted(win) {
    try {
      return Number(win.localStorage.getItem(LS_MUTE) || 0) > Date.now();
    } catch (_) {
      return false;
    }
  }

  function enabled(win) {
    if (!win || win.document.hidden || muted(win)) return false;
    try {
      const v = win.localStorage.getItem(LS_FORGE_SOUND);
      if (v === null) return true;
      return v === "1";
    } catch (_) {
      return true;
    }
  }

  function gap(kind, ms) {
    const now = Date.now();
    const wait = lastAt[kind] || 0;
    if (now < wait) return false;
    lastAt[kind] = now + ms;
    return true;
  }

  function ensureScripts(win) {
    if (win.HqCompanionReactionAudio && win.HqCompanionSfxBus) return Promise.resolve();
    if (scriptLoad) return scriptLoad;
    scriptLoad = new Promise((resolve) => {
      const chain = (src, attr) =>
        new Promise((res) => {
          let el = attr ? win.document.querySelector(`script[${attr}]`) : null;
          if (!el) {
            el = win.document.createElement("script");
            el.src = src;
            if (attr) el.setAttribute(attr, "");
            el.addEventListener("load", () => res(), { once: true });
            el.addEventListener("error", () => res(), { once: true });
            win.document.head.appendChild(el);
          } else {
            el.addEventListener("load", () => res(), { once: true });
            el.addEventListener("error", () => res(), { once: true });
          }
        });
      chain("/assets/hq-companion-sfx-bus.js", "data-hq-sfx-bus")
        .then(() => chain("/assets/hq-companion-reaction-audio.js", "data-hq-reaction-audio"))
        .then(() => resolve());
    });
    return scriptLoad;
  }

  function ensureCtx(win) {
    const AC = win.AudioContext || win.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    if (win.HqCompanionSfxBus && !sfxBus) sfxBus = win.HqCompanionSfxBus.create(audioCtx);
    return audioCtx;
  }

  function connectImpact(gain) {
    if (sfxBus) sfxBus.connectImpact(gain);
    else if (audioCtx) gain.connect(audioCtx.destination);
  }

  function playImpactPool(win, poolKey, strength, opts) {
    if (!enabled(win) || !player?.impactUrls) return false;
    let pool = player.impactUrls(poolKey);
    if (poolKey === "tit_pull" && pool?.length) {
      const kind = opts?.release || opts?.slosh ? "slosh" : "elastic";
      pool = titPullStemPool(pool, kind, opts?.stem);
    }
    if (!pool?.length) return false;
    const ctx = ensureCtx(win);
    if (!ctx) return false;
    const pick = root.HqCompanionReactionAudio?.pickVariant;
    if (!pick) return false;
    if (!playImpactPool.selection) playImpactPool.selection = {};
    const url = pick(pool, playImpactPool.selection);
    const load = player.ensureDecodedBuffer?.(url) || player.getDecodedBuffer?.(url);
    const run = (buf) => {
      if (!buf) return false;
      const str = Math.max(0, Math.min(1, Number(strength) || 0.5));
      const impactDb = Number(player.impactGainDb?.());
      const impactMul = Number.isFinite(impactDb) ? 10 ** (impactDb / 20) : 10 ** (3.5 / 20);
      const volMul = opts?.volumeMul ?? 1;
      const softPull = poolKey === "tit_pull";
      let vol;
      if (softPull) {
        const pullStr = Math.min(0.7, str * 0.58);
        vol = (0.022 + pullStr * 0.032) * volMul;
      } else {
        vol = (0.1 + str * 0.075) * impactMul * volMul;
      }
      const now = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = softPull ? 0.94 + Math.random() * 0.05 : 1;
      const g = ctx.createGain();
      const tail = buf.duration / src.playbackRate.value;
      const attack = softPull ? 0.05 : 0.012;
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(vol, now + attack);
      g.gain.exponentialRampToValueAtTime(0.001, now + tail);
      if (softPull) {
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = 65;
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 3100;
        src.connect(hp);
        hp.connect(lp);
        lp.connect(g);
        if (sfxBus) sfxBus.connectVoice(g);
        else if (audioCtx) g.connect(audioCtx.destination);
      } else {
        src.connect(g);
        connectImpact(g);
      }
      src.start(now);
      src.stop(now + tail);
      return true;
    };
    if (load && typeof load.then === "function") {
      load.then(run).catch(() => {});
      return true;
    }
    return run(load);
  }

  function playSample(win, kind, opts) {
    if (!enabled(win) || !SAMPLE_KINDS.has(kind) || !player?.has?.(kind)) return false;
    if (!gap("sample:" + kind, opts?.gap ?? 900)) return false;
    const dur = player.start(kind, {
      interrupt: false,
      priority: opts?.priority ?? 1,
      ...(opts?.interrupt === true ? { interrupt: true } : {})
    });
    return dur > 0;
  }

  function bind(win) {
    winRef = win;
    if (ready) return ready;
    ready = ensureScripts(win).then(() => {
      if (!win.HqCompanionReactionAudio) return false;
      player = win.HqCompanionReactionAudio.create(
        win,
        () => enabled(win),
        Math.random,
        () => ({
          smoothStops: true,
          paceReactions: false,
          audioContext: audioCtx,
          sfxBus,
          connectVoiceOut: (node) => {
            if (sfxBus) sfxBus.connectVoice(node);
            else if (audioCtx) node.connect(audioCtx.destination);
          }
        })
      );
      return player.ready.then((ok) => {
        if (ok) {
          ensureCtx(win);
          const warm = [];
          if (player.sampleUrls) {
            warm.push(...player.sampleUrls("gulp", 3));
            warm.push(...player.sampleUrls("wet_mouth", 2));
          }
          if (player.impactUrls) {
            warm.push(...player.impactUrls("tit_pull").slice(0, 2));
          }
          const slap = player.impactUrls?.("slap")?.slice(0, 2) || [];
          warm.push(...slap);
          // Decode these on the first gesture, not at page load (nothing can play before one anyway).
          if (warm.length && player.warmSamples) {
            const run = () => { try { player.warmSamples(warm).catch(() => {}); } catch (_) {} };
            win.addEventListener("pointerdown", run, { once: true, capture: true });
            win.addEventListener("keydown", run, { once: true, capture: true });
          }
        }
        return ok;
      });
    });
    return ready;
  }

  function prime(win) {
    bind(win || winRef);
  }

  function playFlickSlap(win, strength) {
    win = win || winRef;
    if (!win || !gap("flick_slap", 320)) return false;
    bind(win);
    if (player?.impactUrls?.("slap")?.length) {
      return playImpactPool(win, "slap", strength ?? 0.82, { volumeMul: 1 });
    }
    return playImpactPool(win, "muffled", strength ?? 0.7, { volumeMul: 0.9 });
  }

  function playFlickJiggle(win) {
    win = win || winRef;
    if (!win || !gap("flick_jiggle", 1200)) return false;
    bind(win);
    return playSample(win, "giggle", { gap: 0 }) || playSample(win, "laugh", { gap: 0 });
  }

  function playZoneTouch(win, zone, depth) {
    win = win || winRef;
    if (!win || !zone) return false;
    const d = Number(depth) || 0;
    if (zone === "tit") {
      if (!gap("zone_tit", 620)) return false;
      bind(win);
      if (playImpactPool(win, "tit_pull", 0.22 + d * 0.04, { volumeMul: 0.42 })) return true;
      if (playImpactPool(win, "grab", 0.32 + d * 0.04, { volumeMul: 0.58 })) return true;
      if (playImpactPool(win, "muffled", 0.35 + d * 0.02, { volumeMul: 0.65 })) return true;
      return playSample(win, "booty_breath", { gap: 0, priority: 0 });
    }
    if (zone === "face" || zone === "head") {
      if (!gap("zone_face", 550)) return false;
      bind(win);
      return playSample(win, "lipsmack", { gap: 0 }) || playSample(win, "pop", { gap: 0 });
    }
    return false;
  }

  function playTitPull(win, give) {
    win = win || winRef;
    if (!win || !enabled(win)) return false;
    const g = Number(give) || 0;
    if (g < 0.2) return false;
    bind(win);
    if (!gap("tit_pull", g > 0.55 ? 680 : 880)) return false;
    const slosh = g > 0.5 && Math.random() < 0.38;
    if (playImpactPool(win, "tit_pull", 0.16 + g * 0.28, { volumeMul: slosh ? 0.38 : 0.4, slosh })) return true;
    if (playImpactPool(win, "grab", 0.26 + g * 0.38, { volumeMul: 0.56 })) return true;
    return playImpactPool(win, "muffled", 0.3 + g * 0.22, { volumeMul: 0.6 });
  }

  function playOralPhase(win, phase, depthSm) {
    win = win || winRef;
    if (!win || !enabled(win)) return false;
    bind(win);
    const depth = Number(depthSm) || 0;
    const prev = oralPhaseLast;
    if (phase !== prev) {
      oralPhaseLast = phase;
      if (phase === "near") {
        oralDepthMark = 0;
        return playSample(win, "lipsmack", { gap: 0 });
      }
      if (phase === "active" && prev !== "active") {
        playSample(win, "wet_mouth", { gap: 0 }) || playSample(win, "lipsmack", { gap: 0 });
      }
      if (phase === "idle") oralDepthMark = 0;
    }
    if (phase === "active") {
      const marks = [10, 18, 26];
      for (let i = 0; i < marks.length; i += 1) {
        const m = marks[i];
        if (depth >= m && oralDepthMark < m) {
          oralDepthMark = m;
          if (m >= 26) return playSample(win, "whimper", { gap: 0 });
          if (m >= 18) {
            playSample(win, "gulp", { gap: 0, priority: 0 });
            playSample(win, "wet_mouth", { gap: 0, priority: 0 });
            return playSample(win, "moan", { gap: 0, priority: 1 });
          }
          playSample(win, "gulp", { gap: 0, priority: 0 });
          playSample(win, "wet_mouth", { gap: 0, priority: 0 });
          return playSample(win, "pleasure", { gap: 0, priority: 1 });
        }
      }
      if (depth >= 6 && Math.abs(depth - oralDepthLast) >= 1.2) {
        oralDepthLast = depth;
        const gapMs = depth >= 20 ? 340 : depth >= 12 ? 480 : 640;
        if (gap("oral_suction_depth", gapMs)) {
          playSample(win, "wet_mouth", { gap: 0, priority: 0 });
        }
        if (depth >= 12 && gap("oral_gulp_depth", depth >= 22 ? 480 : depth >= 16 ? 620 : 820)) {
          playSample(win, "gulp", { gap: 0, priority: 0 });
        }
      }
    }
    return false;
  }

  function playOralMotion(win, depthSm, dAlong, dPerp) {
    win = win || winRef;
    if (!win || !enabled(win) || oralPhaseLast !== "active") return false;
    bind(win);
    const depth = Number(depthSm) || 0;
    if (depth < 4) return false;
    const along = Math.abs(Number(dAlong) || 0);
    const perp = Math.abs(Number(dPerp) || 0);
    const motion = along + perp * 0.55;
    if (motion < 1.1 && perp < 2.5) return false;
    const gapMs = depth >= 22 ? 320 : depth >= 14 ? 440 : 620;
    if (!gap("oral_suction_motion", gapMs)) return false;
    if (depth >= 12 && along > perp * 0.95) {
      return (
        playSample(win, "gulp", { gap: 0, priority: 0 }) ||
        playSample(win, "wet_mouth", { gap: 0, priority: 0 }) ||
        playSample(win, "lipsmack", { gap: 0 })
      );
    }
    if (along > perp * 1.4 && depth >= 10) {
      return playSample(win, "wet_mouth", { gap: 0, priority: 0 }) || playSample(win, "lipsmack", { gap: 0 });
    }
    return playSample(win, "wet_mouth", { gap: 0, priority: 0 }) || playSample(win, "lipsmack", { gap: 0 });
  }

  function playOralRelease(win, depthSm) {
    win = win || winRef;
    if (!win || !enabled(win)) return false;
    const depth = Number(depthSm) || 0;
    if (depth < 3) return false;
    bind(win);
    if (!gap("oral_release", 180)) return false;
    return (
      playSample(win, "pop", { gap: 0, priority: 1, interrupt: true }) ||
      playSample(win, "wet_mouth", { gap: 0, priority: 0 })
    );
  }

  function playThrob(win) {
    win = win || winRef;
    if (!win || !gap("throb", 2200)) return false;
    bind(win);
    return playSample(win, "pleasure", { gap: 0, priority: 0 });
  }

  function playDragSnap(win, speed) {
    win = win || winRef;
    if (!win || Math.abs(Number(speed) || 0) < 420 || !gap("drag_snap", 400)) return false;
    bind(win);
    return playImpactPool(win, "grab", 0.28, { volumeMul: 0.55, bodyThud: false });
  }

  function clearOralAudio(opts) {
    oralDepthMark = 0;
    oralDepthLast = 0;
    oralPhaseLast = "idle";
  }

  return {
    bind,
    prime,
    enabled,
    playFlickSlap,
    playFlickJiggle,
    playZoneTouch,
    playTitPull,
    playOralPhase,
    playOralMotion,
    playOralRelease,
    playThrob,
    playDragSnap,
    clearOralAudio,
    IMPACT_KINDS,
    SAMPLE_KINDS
  };
});
