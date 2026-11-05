/* Independent vector mouth rig. No portrait textures or chest physics changed. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HqCompanionMouth = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
  const MODES = { auto: "Auto", neutral: "Repos", smile: "Sourire", open: "Ouverte",
    wide: "Grande ouverte", laugh: "Rire", surprised: "Surprise", lick: "Langue / léchage" };
  const BROW_MODES = { auto: "Auto", neutral: "Repos", raise: "Lever les deux", left: "Lever le gauche", right: "Lever le droit", frown: "Froncer" };
  let serial = 0;
  const VISEMES = {
    rest: { open: 0, smile: 0, round: 0, bite: 0, seal: 0 },
    M: { open: 0, smile: .08, round: .10, bite: 0, seal: 1 },
    A: { open: .52, smile: .08, round: .02, bite: 0, seal: 1 },
    E: { open: .25, smile: .43, round: 0, bite: 0, seal: 1 },
    I: { open: .14, smile: .62, round: 0, bite: 0, seal: 1 },
    O: { open: .40, smile: .02, round: .78, bite: 0, seal: 1 },
    U: { open: .18, smile: 0, round: .92, bite: 0, seal: 1 },
    F: { open: .13, smile: .35, round: .08, bite: 1, seal: 1 },
    S: { open: .11, smile: .35, round: .02, bite: 0, seal: 1 },
    SH: { open: .18, smile: .02, round: .45, bite: 0, seal: 1 },
    T: { open: .18, smile: .36, round: .04, bite: 0, seal: 1 },
    R: { open: .27, smile: .12, round: .32, bite: 0, seal: 1 }
  };
  const visemeWeight = id => /^(A|E|I|O|U)$/.test(id) ? 1.4 : id === "M" ? 1.6 : .7;
  const textPause = word => /[.!?…]["»)]?\s*$/.test(word) ? 340 : /[,;:]["»)]?\s*$/.test(word) ? 180 : 0;
  const smooth = (a, b, t) => { const u = clamp((t - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };

  function lifeGesture(kind, elapsed, side = 1, strength = 1) {
    if (elapsed < 0) return null;
    const pose = { open: 0, smile: 0, round: 0, seal: 0, asym: 0, press: 0, shift: 0, jaw: 0 };
    let amount;
    if (kind === "smile" || kind === "listen") {
      const listening = kind === "listen", end = listening ? 2400 : 3000;
      if (elapsed >= end) return null;
      amount = smooth(0, listening ? 450 : 650, elapsed) * (1 - smooth(listening ? 1200 : 1700, end, elapsed));
      pose.smile = (listening ? .27 : .43) * amount;
      // One corner leads; the other catches up rather than holding a smirk.
      pose.asym = side * (listening ? .35 : .90) * amount * (1 - smooth(500, 1200, elapsed));
      pose.open = .012 * amount;
    } else if (kind === "press") {
      if (elapsed >= 1150) return null;
      amount = smooth(0, 180, elapsed) * (1 - smooth(420, 1150, elapsed));
      pose.press = .85 * amount; pose.round = .10 * amount; pose.smile = .025 * amount;
    } else if (kind === "exhale") {
      if (elapsed >= 2100) return null;
      amount = smooth(0, 500, elapsed) * (1 - smooth(850, 2100, elapsed));
      pose.open = .095 * amount; pose.round = .32 * amount; pose.smile = .025 * amount;
      pose.jaw = pose.open * .60;
    } else if (kind === "linger") {
      if (elapsed >= 3100) return null;
      amount = 1 - smooth(550, 3100, elapsed);
      pose.smile = .36 * amount; pose.open = .025 * amount; pose.asym = side * .16 * amount;
    } else if (kind === "hmm") {
      if (elapsed >= 1950) return null;
      amount = smooth(0, 300, elapsed) * (1 - smooth(1100, 1950, elapsed));
      pose.press = .30 * amount; pose.round = .20 * amount; pose.smile = .035 * amount;
      pose.shift = side * .72 * amount; pose.asym = side * .42 * amount;
    } else if (kind === "laugh") {
      if (elapsed >= 2800) return null;
      amount = smooth(0, 320, elapsed) * (1 - smooth(1800, 2800, elapsed));
      const parting = smooth(880, 1120, elapsed) * (1 - smooth(1650, 1950, elapsed));
      pose.smile = .55 * amount;
      pose.press = .68 * smooth(250, 520, elapsed) * (1 - smooth(820, 1080, elapsed));
      pose.open = .012 * amount + .12 * parting * (.35 + .65 * Math.abs(Math.sin((elapsed - 1020) * .014)));
      pose.asym = side * .20 * amount; pose.jaw = pose.open * .80;
    } else return null;
    pose.seal = clamp(amount * 1.8, 0, 1);
    for (const key of Object.keys(pose)) pose[key] *= clamp(strength, 0, 1);
    return pose;
  }

  function textWordDuration(word, duration, plan) {
    const base = clamp(duration, 40, 1600);
    if (!plan.length) return base;
    // A short spelling-based interval cannot display a long pronunciation.
    // Give vowels and full lip closures time to read, retaining punctuation.
    const voiced = Math.min(750, plan.reduce((sum, id) => sum + visemeWeight(id), 0) * 30);
    return Math.min(1600, Math.max(base, Math.ceil(voiced + textPause(word))));
  }

  function wordVisemes(word) {
    const text = String(word || "").toLowerCase().normalize("NFC").slice(0, 80);
    const sounds = [];
    const rules = [["eau", "O"], ["oeu", "U"], ["œu", "U"], ["ou", "U"], ["au", "O"],
      ["eu", "U"], ["oi", "U A"], ["ai", "E"], ["ei", "E"], ["on", "O"],
      ["an", "A"], ["en", "A"], ["in", "E"], ["ch", "SH"], ["ph", "F"], ["qu", "T"], ["gn", "T"]];
    for (let i = 0; i < text.length;) {
      const rule = rules.find(([letters]) => text.startsWith(letters, i));
      let sound;
      if (rule) { sound = rule[1]; i += rule[0].length; }
      else {
        const letter = text[i++];
        // Common French silent endings; this is a spelling approximation.
        if (/[stdxz]/.test(letter) && !/\p{L}/u.test(text.slice(i)) && text.replace(/[^\p{L}]/gu, "").length > 2) continue;
        sound = /[bmp]/.test(letter) ? "M" : /[fv]/.test(letter) ? "F" :
          /[aàâä]/.test(letter) ? "A" : /[iîïy]/.test(letter) ? "I" :
          /[oôö]/.test(letter) ? "O" : /[uùûü]/.test(letter) ? "U" :
          /[eéèêë]/.test(letter) ? "E" : letter === "j" ? "SH" : /[sz]/.test(letter) ? "S" :
          letter === "r" ? "R" : /[tdnlkgcq]/.test(letter) ? "T" : null;
      }
      if (sound) for (const id of sound.split(" ")) if (sounds.at(-1) !== id) sounds.push(id);
    }
    return sounds;
  }

  function visemeAt(plan, elapsed, duration, word = "", startPose = VISEMES.M) {
    const pause = textPause(word), punctuated = pause > 0;
    const active = duration - Math.min(pause, duration * .72);
    // Keep the same drawn lips through pauses instead of exposing the
    // differently shaped painted mouth between every displayed word.
    if (!plan.length || elapsed < 0 || elapsed >= active) return { ...VISEMES.M };
    const weights = plan.map(visemeWeight);
    const total = weights.reduce((sum, w) => sum + w, 0);
    const at = elapsed / active * total;
    let index = 0, start = 0;
    while (index < plan.length - 1 && at >= start + weights[index]) start += weights[index++];
    const from = index ? VISEMES[plan[index - 1]] : startPose;
    const to = VISEMES[plan[index]] || VISEMES.M;
    const u = clamp((at - start) / weights[index] / .38, 0, 1), blend = u * u * (3 - 2 * u);
    const release = punctuated ? clamp((active - elapsed) / Math.min(35, active * .15), 0, 1) : 1;
    const pose = {};
    for (const key of ["open", "smile", "round", "bite", "seal"]) {
      const value = from[key] + (to[key] - from[key]) * blend;
      pose[key] = VISEMES.M[key] + (value - VISEMES.M[key]) * release;
    }
    return pose;
  }

  function textEnvelope(word, elapsed, duration) {
    if (elapsed < 0 || elapsed >= duration || !/\p{L}/u.test(word)) return 0;
    const syllables = clamp((word.match(/[aeiouyàâäéèêëîïôöùûüœ]+/gi) || []).length, 1, 4);
    const punctuated = /[,.!?…;:]["»)]?\s*$/.test(word);
    const active = Math.min(duration * (punctuated ? .48 : .90), 100 * syllables + 40);
    if (elapsed >= active) return 0;
    const beats = Math.min(syllables, Math.max(1, Math.floor(active / 120)));
    return Math.pow(Math.abs(Math.sin(Math.PI * elapsed / active * beats)), .85) * (.42 + Math.min(syllables, 3) * .05);
  }

  function browTarget(mode, input = {}) {
    if (mode === "neutral") return { left: 0, right: 0 };
    // Raise, hold, release, then rest. This clock is independent of the mouth.
    const period = mode === "auto" ? (input.speaking ? 3600 : 12000) : 3400;
    const phase = ((input.time || 0) % period + period) % period;
    const start = mode === "auto" ? (input.speaking ? 450 : 2600) : 120;
    const ease = v => { v = clamp(v, 0, 1); return v * v * (3 - 2 * v); };
    const beat = ease((phase - start) / 280) * (1 - ease((phase - start - 1000) / 500));
    const amount = input.reduced ? (mode === "auto" ? 0 : 1) : beat;
    if (mode === "left") return { left: amount, right: 0 };
    if (mode === "right") return { left: 0, right: amount };
    if (mode === "frown") return { left: -amount * .65, right: -amount * .65 };
    return { left: amount * (mode === "auto" ? .75 : 1), right: amount * (mode === "auto" ? .6 : .85) };
  }

  function baseTarget(mode, input = {}) {
    const t = (input.time || 0) / 1000;
    if (mode === "neutral") return { open: 0, smile: 0, round: 0 };
    if (mode === "smile") return { open: .12, smile: .95, round: 0 };
    if (mode === "open") return { open: .48, smile: .08, round: .12 };
    if (mode === "wide") return { open: .98, smile: .12, round: .18 };
    if (mode === "surprised") return { open: .80, smile: 0, round: .9 };
    if (mode === "laugh") return { open: input.reduced ? .68 : .65 + Math.sin(t * 11) * .17, smile: .95, round: 0 };
    const speech = input.speaking ? .16 + .44 * Math.abs(Math.sin(t * 9.1) * Math.cos(t * 3.7)) : 0;
    return { open: clamp(Math.max(speech, input.voice || 0, (input.pull || 0) * .92), 0, 1),
      smile: input.smiling ? .72 : input.speaking ? .12 : 0, round: (input.pull || 0) * .25 };
  }

  function speechJaw(pose, envelope = 0) {
    const open = clamp(pose.open || 0, 0, 1);
    const smile = clamp(pose.smile || 0, 0, 1);
    const seal = clamp(pose.seal || 0, 0, 1);
    const env = clamp(envelope, 0, 1);
    if (open <= 0 && env <= 0) return 0;
    if (seal > .85 && open < .06) return clamp(open * .55, 0, .04);
    return clamp(Math.max(open * .95, smile * .40 + open * .34, open + env * .38), 0, 1.08);
  }

  function speechHeadMotion(pose, envelope = 0, reduced = false) {
    if (reduced) return { headTilt: 0, headNod: 0, browLift: 0, aperture: 0 };
    const open = clamp(pose.open || 0, 0, 1);
    const smile = clamp(pose.smile || 0, 0, 1);
    const round = clamp(pose.round || 0, 0, 1);
    const seal = clamp(pose.seal || 0, 0, 1);
    const env = clamp(envelope, 0, 1);
    if (seal > .85 && open < .06 && env < .04) {
      return { headTilt: 0, headNod: 0, browLift: 0, aperture: 0 };
    }
    const aperture = clamp(Math.max(open, smile * .32, env * .58), 0, 1);
    return {
      headTilt: clamp((round - .18) * .48 + open * .09, -.38, .38),
      headNod: aperture * .016 + env * .024,
      browLift: aperture * .26 + env * .2,
      aperture
    };
  }

  function expressionTarget(mode, input = {}) {
    // Interaction reaction temporarily overrides the selected expression.
    // Keep tongue/head offsets neutral while the pull owns face alignment.
    if (input.pulling) return { open: .96, smile: .10, round: .18,
      extend: 0, curl: 0, sway: 0, jaw: 0, headTilt: 0, headNod: 0 };
    const t = (input.time || 0) / 1000;
    const measuredVoice = input.speaking && Number.isFinite(input.audioLevel);
    if (measuredVoice) {
      const open = input.reduced ? .24 : clamp(input.audioLevel, 0, .85);
      const round = open * (.18 + .16 * Math.sin(t * 4.3));
      const smile = input.smiling ? .40 : .10;
      const head = speechHeadMotion({ open, smile, round, seal: 1 }, open, input.reduced);
      return { open, smile, round,
        extend: 0, curl: 0, sway: 0,
        jaw: input.reduced || open < 0.008 ? 0 : speechJaw({ open, smile, round }, open),
        headTilt: head.headTilt, headNod: head.headNod };
    }
    if (input.textPose) {
      const head = speechHeadMotion(input.textPose, input.textEnvelope || 0, input.reduced);
      return { ...input.textPose, extend: 0, curl: 0, sway: 0,
        jaw: input.reduced ? 0 : speechJaw(input.textPose, input.textEnvelope || 0),
        headTilt: head.headTilt, headNod: head.headNod };
    }
    if (Number.isFinite(input.textLevel)) {
      const open = clamp(input.textLevel, 0, .7);
      const smile = .10, round = open * .22;
      const head = speechHeadMotion({ open, smile, round, seal: 1 }, input.textEnvelope || 0, input.reduced);
      return { open, smile, round, extend: 0, curl: 0, sway: 0,
        jaw: input.reduced ? 0 : speechJaw({ open, smile, round }, input.textEnvelope || 0),
        headTilt: head.headTilt, headNod: head.headNod };
    }
    if (input.speaking) {
      const cadence = Math.pow(Math.abs(Math.sin(t * 9.1) * Math.cos(t * 3.7)), 1.3);
      const open = input.reduced ? .24 : clamp(Math.max(cadence * .66, input.voice || 0), 0, .78);
      const round = open * (.18 + .16 * Math.sin(t * 4.3));
      const smile = input.smiling ? .40 : .10;
      const head = speechHeadMotion({ open, smile, round, seal: 1 }, cadence, input.reduced);
      return { open, smile, round,
        extend: 0, curl: 0, sway: 0,
        jaw: input.reduced || open < 0.008 ? 0 : speechJaw({ open, smile, round }, cadence),
        headTilt: head.headTilt, headNod: head.headNod };
    }
    if (mode === "auto" && input.humming && !input.reduced) {
      const beat = Math.sin((input.time || 0) * .0045);
      return { open: 0, smile: .20, round: .10, press: .24, seal: 1,
        extend: 0, curl: 0, sway: 0, jaw: 0, headTilt: beat * .7, headNod: Math.abs(beat) * .45 };
    }
    if (mode === "auto" && input.kissBlow && !input.reduced) {
      const beat = Math.sin((input.time || 0) * .011);
      return { open: 0, smile: .32, round: .24, press: .48, seal: 1,
        extend: 0, curl: 0, sway: 0, jaw: 0, headTilt: beat * .45, headNod: -.012 };
    }
    if (mode === "auto" && input.lifePose && !input.reduced) return {
      ...input.lifePose, bite: 0, extend: 0, curl: 0, sway: 0, headTilt: 0, headNod: 0
    };
    if (mode !== "lick") return { ...baseTarget(mode, input), extend: 0, curl: 0, sway: 0, jaw: 0, headTilt: 0, headNod: 0 };
    // Prepare the lips, reach, curl the tip, then withdraw and rest.
    // Unequal stages keep the gesture from looking like a pendulum.
    const phase = ((input.time || 0) % 3200 + 3200) % 3200;
    const poses = [
      [0, .18, 0, .08], [300, .34, .03, .08],
      [930, .37, .82, .12], [1310, .33, .88, .84],
      [1640, .31, .70, .91], [2220, .23, 0, .16],
      [3200, .18, 0, .08]
    ];
    let pose = [.34, .70, .55];
    if (!input.reduced) {
      const i = poses.findIndex((p, index) => index > 0 && phase <= p[0]);
      const a = poses[i - 1], b = poses[i];
      const u = (phase - a[0]) / (b[0] - a[0]);
      const ease = u * u * (3 - 2 * u);
      pose = a.slice(1).map((v, k) => v + (b[k + 1] - v) * ease);
    }
    const [open, extend, curl] = pose;
    const reach = clamp((open - .18) / .19, 0, 1);
    return { open, smile: .18 + extend * .06, round: .20 - extend * .08,
      extend, curl, sway: input.reduced ? 0 : Math.sin(phase / 3200 * Math.PI * 2) * .10 * extend,
      jaw: input.reduced ? 0 : reach * .65 + extend * .30,
      headTilt: input.reduced ? 0 : reach * -.65 - extend * .85 + curl * extend * .45,
      headNod: input.reduced ? 0 : reach * -.006 - extend * .010 + curl * extend * .012 };
  }

  function target(mode, input = {}) { return { bite: 0, seal: 0, asym: 0, press: 0, shift: 0, ...expressionTarget(mode, input) }; }

  function measuredVoiceInput(input = {}) {
    return !!(input.speaking && Number.isFinite(input.audioLevel));
  }

  function geometry(open, smile, round, extend = 0, curl = 0, sway = 0, bite = 0, asym = 0, press = 0) {
    open = clamp(open, 0, 1); smile = clamp(smile, 0, 1); round = clamp(round, 0, 1);
    extend = clamp(extend, 0, 1); curl = clamp(curl, 0, 1); sway = clamp(sway, -1, 1);
    const w = 20 + smile * 5 - round * 5;
    const corner = -smile * 4;
    asym = clamp(asym, -1, 1); press = clamp(press, 0, 1);
    const left = corner - Math.max(asym, 0) * 2.8, right = corner - Math.max(-asym, 0) * 2.8;
    const top = -1.3 - open * 2.6 + press * 1.3;
    bite = clamp(bite, 0, 1);
    const bottom = (1.4 + open * 29 + smile * 2 - bite * 2.4) * (1 - press * .85);
    const fullness = 1 - press * .35;
    const cavity = `M ${-w} ${left} Q 0 ${top - 2} ${w} ${right} C ${w * .85} ${bottom * .82} ${w * .4} ${bottom} 0 ${bottom} C ${-w * .4} ${bottom} ${-w * .85} ${bottom * .82} ${-w} ${left} Z`;
    const upper = `M ${-w} ${left} C ${-w * .58} ${(-6 - smile * 2) * fullness} -6 ${-10 * fullness} 0 ${-5.3 * fullness} C 6 ${-11 * fullness} ${w * .5} ${(-5 - smile * 3) * fullness} ${w} ${right} Q 0 ${top - 2} ${-w} ${left} Z`;
    const lower = `M ${-w} ${left} C ${-w * .85} ${bottom * .82} ${-w * .4} ${bottom} 0 ${bottom} C ${w * .4} ${bottom} ${w * .85} ${bottom * .82} ${w} ${right} C ${w * .72} ${bottom + 10 * fullness} ${-w * .58} ${bottom + 11 * fullness} ${-w} ${left} Z`;
    // A narrow curved strip follows the upper cavity edge. Taper its ends
    // inside the lip corners instead of filling the opening with a white bar.
    const toothWidth = w * .88;
    const toothCenter = ((left + right) * .5 + top - 2) * .5;
    const toothLeft = left * .8872 + (top - 2) * .1128, toothRight = right * .8872 + (top - 2) * .1128;
    const toothEdge = (toothLeft + toothRight) * .5;
    const toothDepth = 1.1 + open * 1.25 + smile * .25 + bite * 1.3;
    const teeth = `M ${-toothWidth} ${toothLeft} Q 0 ${2 * toothCenter - toothEdge} ${toothWidth} ${toothRight} L ${toothWidth} ${toothRight + .2} Q 0 ${2 * (toothCenter + toothDepth) - toothEdge - .2} ${-toothWidth} ${toothLeft + .2} Z`;
    // Root stays inside the cavity. Shortening and broadening the curled
    // tip suggests foreshortening instead of stretching a flat hanging strip.
    const base = bottom - 8, length = extend * 22;
    const isLicking = extend > .65;
    const tip = base + 4 + length * (1 - curl * .42), tipX = sway * 4;
    // When flattened against glass, tip spreads outwards for a wider contact pad.
    const rootWidth = w * .40, tipWidth = w * (.28 + curl * .055 + (isLicking ? .10 : 0));
    const shoulder = base + (tip - base) * .60;
    const tipDepth = (4.2 - curl * 2) * (isLicking ? 1.35 : 1);
    return { cavity, upper, lower, teeth, bottom, width: w * 2,
      tongueOut: `M ${-rootWidth} ${base} C ${-rootWidth * 1.04} ${shoulder} ${tipX - tipWidth} ${tip - 3} ${tipX - tipWidth} ${tip} C ${tipX - tipWidth * .80} ${tip + tipDepth} ${tipX + tipWidth * .80} ${tip + tipDepth} ${tipX + tipWidth} ${tip} C ${tipX + tipWidth} ${tip - 3} ${rootWidth * 1.04} ${shoulder} ${rootWidth} ${base} Q 0 ${base - 3} ${-rootWidth} ${base} Z`,
      tongueFold: `M 0 ${base + 2} Q ${tipX * .4} ${shoulder} ${tipX} ${tip - 2.5}`,
      tongueShine: `M ${tipX - tipWidth * .35} ${tip + .4} Q ${tipX} ${tip + tipDepth * .55} ${tipX + tipWidth * .35} ${tip + .4}`,
      tongue: `M ${-w * .64} ${bottom - 1.7} C ${-w * .37} ${bottom - 13 * open} ${w * .37} ${bottom - 13 * open} ${w * .64} ${bottom - 1.7} Q 0 ${bottom - .4} ${-w * .64} ${bottom - 1.7} Z`,
      highlight: `M ${-w * .32} ${bottom + 4.5 * fullness} Q 0 ${bottom + 6.9 * fullness} ${w * .30} ${bottom + 3.9 * fullness}` };
  }

  function eyeGeometry(close, side = "left") {
    close = clamp(close, 0, 1);
    const arc = -18 + close * 44;
    const direction = side === "right" ? 1 : -1;
    const lashes = [0, 1, 2, 3, 4, 5, 6].map(i => {
      const t = side === "right" ? .80 - i * .075 : .20 + i * .075;
      const x = -29 * (1 - t) ** 2 + 26 * t * t;
      const y = -((1 - t) ** 2) + 2 * (1 - t) * t * arc - t * t;
      const length = 17 - i * 1.4;
      return `M ${x - 2.7} ${y} Q ${x + direction * 5} ${y - 4} ${x + direction * length} ${y - 14 + i * 1.1} Q ${x + direction * 3.5} ${y - 1.7} ${x + 2.7} ${y + .7} Z`;
    }).join(" ");
    return {
      lid: `M -29 -1 C -15 -25 12 -26 26 -1 Q 0 ${arc} -29 -1 Z`,
      lash: `M -29 -1 Q 0 ${arc} 26 -1`,
      flick: side === "right" ? `M 26 -1 Q 29 -1 32 -4` : `M -29 -1 Q -32 -1 -34 -4`,
      lashes
    };
  }

  function blinkClosure(progress) {
    const p = clamp(progress, 0, 1);
    const ease = v => v * v * (3 - 2 * v);
    if (p < .32) return ease(p / .32);
    if (p < .46) return 1;
    return 1 - ease((p - .46) / .54);
  }

  function attach(win, wrap, host, wake, reactionAudio = null) {
    const onSpeechPause = typeof reactionAudio?.onSpeechPause === "function" ? reactionAudio.onSpeechPause : null;
    const existing = wrap.querySelector(".hq-expressive-mouth");
    if (existing) return existing.mouthRig;
    const doc = win.document, ns = "http://www.w3.org/2000/svg";
    const id = "hq-mouth-" + ++serial;
    const svg = doc.createElementNS(ns, "svg");
    svg.classList.add("hq-expressive-mouth");
    svg.setAttribute("viewBox", "0 0 512 512");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = `<defs>
      <linearGradient id="${id}-skin" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#e8bba8"/><stop offset="1" stop-color="#e8b5a2"/></linearGradient>
      <radialGradient id="${id}-fade"><stop offset=".68" stop-color="white"/><stop offset="1" stop-color="white" stop-opacity="0"/></radialGradient>
      <mask id="${id}-patch"><ellipse cx="0" cy="5" rx="34" ry="34" fill="url(#${id}-fade)"/></mask>
      <radialGradient id="${id}-inside" cy="25%"><stop stop-color="#200912"/><stop offset="1" stop-color="#571522"/></radialGradient>
      <linearGradient id="${id}-lip" x2="0" y2="1"><stop stop-color="#a22435"/><stop offset="1" stop-color="#d4545c"/></linearGradient>
      <linearGradient id="${id}-teeth" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#a37a6a"/><stop offset=".38" stop-color="#ddc7af"/><stop offset="1" stop-color="#eee1cd"/></linearGradient>
      <radialGradient id="${id}-tongue" cx="50%" cy="35%" r="75%"><stop stop-color="#a85c70"/><stop offset=".5" stop-color="#82394f"/><stop offset="1" stop-color="#4b1d30"/></radialGradient>
      <linearGradient id="${id}-tongue-out" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#6e2b40"/><stop offset=".45" stop-color="#b45f77"/><stop offset="1" stop-color="#cd7d90"/></linearGradient>
      <clipPath id="${id}-clip"><path data-part="clip"/></clipPath></defs>
      <g transform="translate(266 170) rotate(-10)">
        <rect x="-35" y="-30" width="70" height="70" fill="url(#${id}-skin)" mask="url(#${id}-patch)"/>
        <g data-mouth-shape="">
        <path data-part="cavity" fill="url(#${id}-inside)"/>
        <g clip-path="url(#${id}-clip)"><path data-part="teeth" fill="url(#${id}-teeth)"/>
          <path data-part="tongue" fill="url(#${id}-tongue)"/></g>
        <path data-part="upper" fill="#8e1c2d"/>
        <path data-part="lower" fill="url(#${id}-lip)"/>
        <path data-part="tongueOut" fill="url(#${id}-tongue-out)"/>
        <path data-part="tongueFold" fill="none" stroke="#703047" stroke-width=".8" stroke-linecap="round"/>
        <path data-part="tongueShine" fill="none" stroke="#f0b6c0" stroke-width="1" stroke-linecap="round"/>
        <path data-part="highlight" fill="none" stroke="#f4b4ac" stroke-width="1.2" stroke-linecap="round" opacity=".65"/>
      </g></g>`;
    const mouthShape = svg.querySelector("[data-mouth-shape]");
    const parts = {};
    for (const e of svg.querySelectorAll("[data-part]")) parts[e.getAttribute("data-part")] = e;
    const eyeSvg = doc.createElementNS(ns, "svg");
    eyeSvg.classList.add("hq-expressive-eyes");
    eyeSvg.setAttribute("viewBox", "0 0 512 512");
    eyeSvg.setAttribute("aria-hidden", "true");
    eyeSvg.innerHTML = `<defs>
      <linearGradient id="${id}-lid" gradientUnits="userSpaceOnUse" x1="0" y1="-23" x2="0" y2="-10"><stop stop-color="#cf8d7b" stop-opacity="0"/><stop offset=".14" stop-color="#d39783" stop-opacity=".04"/><stop offset=".33" stop-color="#d79b87" stop-opacity=".32"/><stop offset=".52" stop-color="#dba08a" stop-opacity=".88"/><stop offset=".65" stop-color="#dea28c"/><stop offset="1" stop-color="#e1a58e"/></linearGradient>
      <filter id="${id}-lid-soft" x="-15%" y="-25%" width="130%" height="150%"><feGaussianBlur stdDeviation="1.15"/></filter>
      <filter id="${id}-hair-black"><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"/></filter>
      <mask id="${id}-eye-hair" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512" style="mask-type:luminance"><rect width="512" height="512" fill="white"/><image href="/assets/companion/rig-neutral-v1/hair.png" width="512" height="512" filter="url(#${id}-hair-black)"/></mask>
      </defs>
      <g mask="url(#${id}-eye-hair)">
      <g data-eye="left" transform="translate(215 126) rotate(-13)" opacity="0">
        <path data-eye-part="lid" fill="url(#${id}-lid)" filter="url(#${id}-lid-soft)"/>
        <path data-eye-part="lash" fill="none" stroke="#19090f" stroke-width="3.8" stroke-linecap="round"/>
        <path data-eye-part="flick" fill="none" stroke="#351319" stroke-width="1.6" stroke-linecap="round"/>
        <path data-eye-part="lashes" fill="#19090f"/>
      </g>
      <g data-eye="right" transform="translate(299 110) rotate(-13)" opacity="0">
        <path data-eye-part="lid" fill="url(#${id}-lid)" filter="url(#${id}-lid-soft)"/>
        <path data-eye-part="lash" fill="none" stroke="#19090f" stroke-width="3.8" stroke-linecap="round"/>
        <path data-eye-part="flick" fill="none" stroke="#351319" stroke-width="1.6" stroke-linecap="round"/>
        <path data-eye-part="lashes" fill="#19090f"/>
      </g></g>`;
    const eyeGroups = Array.from(eyeSvg.querySelectorAll("[data-eye]"));
    let blinkAt = -Infinity, blinkDuration = 245, blinkAsym = false, eyeShape = "";
    const paintEyes = time => {
      const pull = host.classList.contains("is-bust-pull");
      const elapsed = time - blinkAt;
      const look = clamp(parseFloat(eyeSvg.style.getPropertyValue("--rig-lid-down")) || 0, 0, 0.45);
      const amounts = eyeGroups.map((_, i) => {
        const blinkAmt = pull ? 1 : elapsed < 0 || elapsed >= blinkDuration ? 0 :
          blinkClosure(elapsed / (blinkDuration * (blinkAsym && i === 1 ? .96 : 1)));
        return clamp(Math.max(blinkAmt, look), 0, 1);
      });
      const signature = amounts.map(v => Math.round(v * 1000)).join(",");
      if (signature === eyeShape) return;
      eyeShape = signature;
      eyeGroups.forEach((group, i) => {
        const g = eyeGeometry(amounts[i], i === 1 ? "right" : "left");
        group.setAttribute("opacity", String(clamp(amounts[i] * 6, 0, 1)));
        for (const part of group.querySelectorAll("[data-eye-part]")) part.setAttribute("d", g[part.getAttribute("data-eye-part")]);
      });
    };
    wrap.appendChild(eyeSvg);
    host.classList.add("has-expressive-eyes");
    // Reuse the portrait's cached face texture for a feathered chin layer.
    // Only the lower face stretches; eyes, brows and the nose stay in place.
    const face = wrap.querySelector(".hq-companion-rig-face-lower");
    const jaw = face ? face.cloneNode(false) : null;
    if (jaw) {
      jaw.className = "hq-companion-rig-layer hq-mouth-jaw";
      jaw.removeAttribute("id");
      jaw.setAttribute("aria-hidden", "true");
      wrap.insertBefore(jaw, face.nextSibling);
    }
    const keys = ["open", "smile", "round", "extend", "curl", "sway", "jaw", "headTilt", "headNod", "bite", "seal", "asym", "press", "shift"];
    let mode = "auto", current = Object.fromEntries(keys.map(key => [key, 0])), lastPaint = -Infinity, lastShape = "", modeStart = 0;
    let browMode = "auto", browStart = 0, brows = { left: 0, right: 0 }, wasPulling = false;
    let textBeat = null;
    let gesture = null, anticipation = null, lifePose = null, nextSide = 1, lastWarm = false, lastPlayful = false;
    let thinkingCount = 0, nextLaughAt = 0, lastPreparedAt = -Infinity;
    let nextIdleAt = win.performance.now() + 9000 + Math.random() * 7000, nextListenAt = 0;
    let wasThinking = false, wasTyping = false, wasVoice = false, wasTickled = false;
    let nextSpeechBlinkAt = 0;
    const postponeIdle = time => { nextIdleAt = time + 9500 + Math.random() * 10000; };
    const clearGesture = () => { if (gesture?.audioOwned) reactionAudio?.stop(gesture.kind); gesture = null; };
    const beginGesture = (kind, time, strength = 1) => {
      clearGesture();
      const audioMs = reactionAudio?.start(kind) || 0, baseMs = { hmm: 1950, laugh: 2800, exhale: 2100 }[kind];
      const rate = audioMs && baseMs ? baseMs / audioMs : 1;
      gesture = { kind, at: time, strength, side: nextSide, rate, audioOwned: audioMs > 0 };
      if (["smile", "listen", "linger", "hmm", "laugh"].includes(kind)) nextSide *= -1;
      postponeIdle(time);
    };
    const afterSpeech = (time, warm, playful) => {
      if (playful && time >= nextLaughAt) { beginGesture("laugh", time); nextLaughAt = time + 12000; }
      else beginGesture("linger", time, warm ? 1 : .55);
    };
    try { const saved = win.localStorage.getItem("hq_companion_mouth_mode"); if (saved in MODES) mode = saved; } catch (_) {}
    try { const saved = win.localStorage.getItem("hq_companion_brow_mode"); if (saved in BROW_MODES) browMode = saved; } catch (_) {}
    const reduced = () => !!win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const advanceLife = time => {
      const voice = host.classList.contains("is-speaking") || host.classList.contains("is-voice-lipsync");
      const thinking = host.classList.contains("hq-companion-listening") || host.classList.contains("is-chat-thinking");
      const typing = host.classList.contains("is-user-typing"), pulling = host.classList.contains("is-bust-pull");
      const tickled = host.classList.contains("is-tickled") || !!host.querySelector(".hq-companion-avatar")?.classList.contains("is-tickled");
      const voiceEnded = wasVoice && !voice, thinkingStarted = thinking && !wasThinking, typingStarted = typing && !wasTyping;
      const tickleStarted = tickled && !wasTickled;
      wasVoice = voice; wasThinking = thinking; wasTyping = typing; wasTickled = tickled;
      lifePose = null;
      let label = "rest";
      if (mode !== "auto" || reduced()) { clearGesture(); anticipation = null; nextIdleAt = Math.max(nextIdleAt, time + 9500); }
      else if (pulling || voice || textBeat || host.classList.contains("is-idle-humming") ||
          host.classList.contains("is-idle-kiss-blow")) {
        clearGesture();
        if (pulling || voice) anticipation = null;
        nextIdleAt = Math.max(nextIdleAt, time + 9500);
        label = pulling ? "interaction" : "speech";
      } else {
        if (voiceEnded) afterSpeech(time, lastWarm, lastPlayful && time - lastPreparedAt < 30000);
        if (thinkingStarted) beginGesture(thinkingCount++ % 2 === 0 ? "press" : "hmm", time);
        if (tickleStarted && !thinking && time >= nextLaughAt) { beginGesture("laugh", time); nextLaughAt = time + 12000; }
        if (typing && !thinking && !gesture && (typingStarted || time >= nextListenAt)) {
          beginGesture("listen", time); nextListenAt = time + 8000 + Math.random() * 4000;
        }
        if (anticipation && time - anticipation.at < 180) {
          const amount = smooth(0, 120, time - anticipation.at), shape = VISEMES[anticipation.first];
          const open = Math.min(.10, shape.open * .35) * amount;
          lifePose = { open, smile: Math.min(.18, shape.smile) * amount, round: shape.round * .55 * amount,
            press: anticipation.first === "M" ? .20 * amount : 0, asym: 0, seal: amount, jaw: open * .5 };
          label = "anticipate";
        } else {
          if (anticipation && time - anticipation.at >= 180) anticipation = null;
          if (gesture) {
            lifePose = lifeGesture(gesture.kind, (time - gesture.at) * gesture.rate, gesture.side, gesture.strength);
            if (lifePose) label = gesture.kind;
            else { clearGesture(); postponeIdle(time); }
          }
          if (!gesture && !thinking && !typing && time >= nextIdleAt) {
            beginGesture(Math.random() < .60 ? "smile" : "exhale", time);
            lifePose = lifeGesture(gesture.kind, 0, gesture.side); label = gesture.kind;
          }
        }
      }
      if (svg.getAttribute("data-mouth-gesture") !== label) svg.setAttribute("data-mouth-gesture", label);
    };
    const paint = () => {
      const shape = keys.map(key => Math.round(current[key] * 10000)).join(",");
      if (shape === lastShape) return;
      lastShape = shape;
      mouthShape.setAttribute("transform", "translate(" + (current.shift * 2.2).toFixed(3) + " 0)");
      wrap.classList.toggle("has-tongue-jaw", !!jaw && current.jaw > .001);
      wrap.style.setProperty("--mouth-jaw", current.jaw.toFixed(4));
      const g = geometry(current.open, current.smile, current.round, current.extend, current.curl, current.sway, current.bite, current.asym, current.press);
      for (const name of ["cavity", "upper", "lower", "teeth", "tongue", "highlight", "tongueOut", "tongueFold", "tongueShine"]) parts[name].setAttribute("d", g[name]);
      parts.clip.setAttribute("d", g.cavity);
      parts.teeth.style.opacity = String(clamp(current.open * 5 + current.smile * .8, 0, 1) * (1 - current.press));
      parts.tongue.style.opacity = String(clamp((current.open - .12) * 3, 0, 1));
      parts.tongueOut.style.opacity = String(clamp(current.extend * 7, 0, 1));
      parts.tongueFold.style.opacity = String(clamp(current.extend * 7, 0, 1) * .45);
      parts.tongueShine.style.opacity = String(clamp(current.extend * 7, 0, 1) * .35);
      host.classList.toggle("is-glass-licking", current.extend > .62);
      // At rest, show the original painted mouth exactly as before.
      svg.style.opacity = String(clamp(Math.max(current.open * 25, current.smile * 5, current.seal), 0, 1));
    };
    const inputs = time => ({ time: mode === "lick" ? Math.max(0, time - modeStart) : time, reduced: reduced(),
      lifePose,
      textPose: textBeat ? visemeAt(textBeat.plan, time - textBeat.at, textBeat.duration, textBeat.word, textBeat.startPose) : null,
      pulling: host.classList.contains("is-bust-pull"),
      humming: host.classList.contains("is-idle-humming"),
      kissBlow: host.classList.contains("is-idle-kiss-blow"),
      speaking: host.classList.contains("is-speaking") || host.classList.contains("is-voice-lipsync"),
      audioLevel: (() => { const level = parseFloat(host.style.getPropertyValue("--rig-voice-level")); return Number.isFinite(level) ? level : null; })(),
      voice: host.classList.contains("is-voice-lipsync") ? clamp((parseFloat(host.style.getPropertyValue("--rig-voice-nod")) - 1) * 12, 0, .9) : 0,
      pull: host.classList.contains("is-bust-pull") ? parseFloat(host.style.getPropertyValue("--pull-tension")) || 0 : 0,
      smiling: host.classList.contains("is-tickled"),
      textEnvelope: textBeat && time >= textBeat.at && time < textBeat.at + textBeat.duration ?
        textEnvelope(textBeat.word, time - textBeat.at, textBeat.duration) : 0 });
    const rig = {
      get motion() {
        const now = win.performance.now();
        let env = 0;
        if (textBeat && now >= textBeat.at && now < textBeat.at + textBeat.duration) {
          env = textEnvelope(textBeat.word, now - textBeat.at, textBeat.duration);
        }
        const head = speechHeadMotion(
          { open: current.open, smile: current.smile, round: current.round, seal: current.seal },
          env,
          reduced());
        return {
          headTilt: current.headTilt,
          headNod: current.headNod,
          browLeft: brows.left,
          browRight: brows.right,
          browAuto: browMode === "auto",
          open: current.open,
          jaw: current.jaw,
          envelope: env,
          browLift: head.browLift,
          aperture: head.aperture
        };
      },
      prepareSpeech(word, owner, phonemes, warm = false, playful = false) {
        if (reduced() || !/\p{L}/u.test(String(word || ""))) return;
        const first = (Array.isArray(phonemes) ? phonemes.find(id => Object.hasOwn(VISEMES, id)) : wordVisemes(word)[0]) || "M";
        anticipation = { first, owner, at: win.performance.now(), warm: !!warm, playful: !!playful };
        lastWarm = !!warm; lastPlayful = !!playful; lastPreparedAt = anticipation.at;
        clearGesture(); lifePose = null; postponeIdle(anticipation.at);
        if (wake) wake();
      },
      textWord(word, duration, owner, phonemes) {
        if (reduced()) return;
        let plan = Array.isArray(phonemes) ? phonemes.filter(id => Object.hasOwn(VISEMES, id)).slice(0, 80) : null;
        if (Array.isArray(phonemes) && phonemes.length && !plan.length) plan = null;
        svg.setAttribute("data-pronunciation-source", plan ? "phonemes" : "spelling");
        const sequence = plan || wordVisemes(word);
        const pacedDuration = textWordDuration(String(word || ""), duration, sequence);
        const startPose = Object.fromEntries(["open", "smile", "round", "bite", "seal"].map(key => [key, current[key]]));
        const warm = anticipation?.owner === owner ? anticipation.warm : textBeat?.owner === owner ? textBeat.warm : lastWarm;
        const playful = anticipation?.owner === owner ? anticipation.playful : textBeat?.owner === owner ? textBeat.playful : lastPlayful;
        if (anticipation?.owner === owner) anticipation = null;
        clearGesture(); lifePose = null;
        const pauseMs = textPause(String(word || ""));
        textBeat = {
          word: String(word || ""), plan: sequence, duration: pacedDuration, owner,
          at: win.performance.now(), startPose, warm, playful, pauseMs, pauseBreathDone: !pauseMs
        };
        lastPaint = -Infinity;
        if (wake) wake();
        return pacedDuration;
      },
      endTextSpeech(owner, completed = false) {
        const ownText = textBeat?.owner === owner && !!textBeat, ownPreparation = anticipation?.owner === owner && !!anticipation;
        if (!ownText && !ownPreparation) return;
        const warm = ownText ? textBeat.warm : anticipation.warm;
        const playful = ownText ? textBeat.playful : anticipation.playful;
        if (ownText) textBeat = null;
        if (ownPreparation) anticipation = null;
        lifePose = null; postponeIdle(win.performance.now());
        if (completed && ownText && mode === "auto" && !reduced() && !host.classList.contains("is-bust-pull") &&
            !host.classList.contains("is-speaking") && !host.classList.contains("is-voice-lipsync")) afterSpeech(win.performance.now(), warm, playful);
        lastPaint = -Infinity;
        if (wake) wake();
      },
      syncInteraction() {
        const pulling = host.classList.contains("is-bust-pull");
        if (pulling === wasPulling) return;
        wasPulling = pulling;
        if (pulling) clearGesture();
        paintEyes(win.performance.now());
        // Pull events must also update the expression with reduced motion,
        // where the main idle loop deliberately does not run.
        const to = target(mode, inputs(win.performance.now()));
        if (reduced() || !wake) current = to;
        else if (pulling) for (const key of keys) current[key] += (to[key] - current[key]) * .45;
        lastPaint = -Infinity;
        paint();
        if (wake) wake();
      },
      tick(dt, time) {
        if (reduced() && textBeat) textBeat = null;
        const articulating = textBeat && time < textBeat.at + textBeat.duration;
        if (doc.hidden || time - lastPaint < (time - blinkAt < blinkDuration || articulating ? 16 : 32)) return;
        const elapsed = Math.min(.12, lastPaint < 0 ? .04 : (time - lastPaint) / 1000);
        lastPaint = time;
        paintEyes(time);
        advanceLife(time);
        const input = inputs(time), to = target(mode, input);
        const speakingNow = input.speaking;
        host.classList.toggle("is-speech-articulating", !!(speakingNow || articulating));
        if ((speakingNow || articulating) && !reduced() && time >= nextSpeechBlinkAt) {
          rig.blink(165 + Math.random() * 55, Math.random() < .28);
          nextSpeechBlinkAt = time + 1900 + Math.random() * 2100;
        } else if (!speakingNow && !textBeat) nextSpeechBlinkAt = time + 1200;
        if (textBeat?.pauseMs && !textBeat.pauseBreathDone) {
          const elapsedWord = time - textBeat.at;
          const active = textBeat.duration - Math.min(textBeat.pauseMs, textBeat.duration * .72);
          if (elapsedWord >= active - 4) {
            textBeat.pauseBreathDone = true;
            if (onSpeechPause) onSpeechPause(textBeat.word);
          }
        }
        const visemeDrive = !!input.textPose && !measuredVoiceInput(input);
        const closingLips = input.textPose && input.textPose.seal > .9 && input.textPose.open < .025;
        const follow = reduced() ? 1 : 1 - Math.exp(-elapsed * (visemeDrive ? closingLips ? 75 : 40 : 16));
        const jawFollow = reduced() ? 1 : 1 - Math.exp(-elapsed * (visemeDrive ? 58 : input.speaking ? 26 : 16));
        for (const key of keys) {
          const rate = key === "jaw" ? jawFollow : follow;
          current[key] += (to[key] - current[key]) * rate;
        }
        const browPose = browTarget(browMode, { ...inputs(time), time: Math.max(0, time - browStart) });
        for (const key of ["left", "right"]) brows[key] += (browPose[key] - brows[key]) * follow;
        paint();
      },
      blink(duration, asym = false) {
        if (reduced()) return;
        blinkAt = win.performance.now();
        blinkDuration = clamp(duration, 160, 980);
        blinkAsym = asym;
        lastPaint = -Infinity;
        if (wake) wake();
      },
      setBrowMode(next, persist = true) {
        browMode = next in BROW_MODES ? next : "auto";
        browStart = win.performance.now();
        if (persist) try { win.localStorage.setItem("hq_companion_brow_mode", browMode); } catch (_) {}
        if (reduced() || !wake) brows = browTarget(browMode, { reduced: reduced(), time: 0 });
        lastPaint = -Infinity;
        if (wake) wake();
      },
      setMode(next, persist = true) {
        mode = next in MODES ? next : "auto";
        clearGesture(); anticipation = null; lifePose = null; postponeIdle(win.performance.now());
        modeStart = win.performance.now();
        if (persist) try { win.localStorage.setItem("hq_companion_mouth_mode", mode); } catch (_) {}
        if (reduced() || !wake) current = target(mode, inputs(win.performance.now()));
        lastPaint = -Infinity;
        paint();
        if (wake) wake();
      },
      triggerLick(durationMs = 3800, onDone = null) {
        if (reduced()) return;
        const prevMode = mode;
        rig.setMode("lick", false);
        win.clearTimeout(rig._lickTimer);
        rig._lickTimer = win.setTimeout(() => {
          rig.setMode(prevMode === "lick" ? "auto" : prevMode, false);
          if (typeof onDone === "function") onDone();
        }, Math.max(1200, durationMs));
      }
    };
    svg.mouthRig = rig;
    wrap.appendChild(svg);
    if (!wrap.querySelector(".hq-companion-glass-saliva")) {
      const saliva = doc.createElement("div");
      saliva.className = "hq-companion-glass-saliva";
      saliva.setAttribute("aria-hidden", "true");
      wrap.appendChild(saliva);
    }
    host.classList.add("has-expressive-mouth");
    if (!doc.querySelector("link[data-hq-mouth-style]")) {
      const css = doc.createElement("link"); css.rel = "stylesheet"; css.href = "/assets/hq-companion-mouth.css";
      css.setAttribute("data-hq-mouth-style", ""); doc.head.appendChild(css);
    }
    const menu = host.querySelector(".hq-companion-fx-debug-opts") || host.querySelector(".hq-companion-fx-debug");
    if (menu && !menu.querySelector("[data-mouth-control]")) {
      const label = doc.createElement("label"); label.className = "hq-mouth-control";
      label.setAttribute("data-mouth-control", ""); label.appendChild(doc.createTextNode("Bouche "));
      const select = doc.createElement("select"); select.setAttribute("aria-label", "Expression de la bouche");
      for (const [value, text] of Object.entries(MODES)) { const opt = doc.createElement("option"); opt.value = value; opt.textContent = text; select.appendChild(opt); }
      select.value = mode; select.addEventListener("change", () => rig.setMode(select.value));
      label.appendChild(select); menu.prepend(label);
    }
    if (menu && !menu.querySelector("[data-brow-control]")) {
      const label = doc.createElement("label"); label.className = "hq-mouth-control";
      label.setAttribute("data-brow-control", ""); label.appendChild(doc.createTextNode("Sourcils "));
      const select = doc.createElement("select"); select.setAttribute("aria-label", "Expression des sourcils");
      for (const [value, text] of Object.entries(BROW_MODES)) { const opt = doc.createElement("option"); opt.value = value; opt.textContent = text; select.appendChild(opt); }
      select.value = browMode; select.addEventListener("change", () => rig.setBrowMode(select.value));
      label.appendChild(select); menu.prepend(label);
    }
    if (menu && !menu.querySelector("[data-pronunciation-control]")) {
      const label = doc.createElement("label"); label.className = "hq-mouth-control";
      label.setAttribute("data-pronunciation-control", ""); label.appendChild(doc.createTextNode("Prononciation "));
      const select = doc.createElement("select"); select.setAttribute("aria-label", "Langue de prononciation");
      for (const [value, text] of [["auto", "Auto"], ["fr", "Français"], ["en", "English"]]) {
        const opt = doc.createElement("option"); opt.value = value; opt.textContent = text; select.appendChild(opt);
      }
      try { select.value = win.localStorage.getItem("hq_companion_pronunciation_language") || "auto"; } catch (_) {}
      select.addEventListener("change", () => { try { win.localStorage.setItem("hq_companion_pronunciation_language", select.value); } catch (_) {} });
      label.appendChild(select); menu.prepend(label);
    }
    rig.setMode(mode, false);
    rig.setBrowMode(browMode, false);
    rig.syncInteraction();
    return rig;
  }
  return { attach, geometry, target, browTarget, eyeGeometry, blinkClosure, textEnvelope, wordVisemes, visemeAt, textWordDuration, lifeGesture, speechJaw, speechHeadMotion, VISEMES, MODES, BROW_MODES };
});
