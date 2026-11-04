/* Shared companion SFX master bus: room EQ, gentle compression, speech/media ducking, impact path. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HqCompanionSfxBus = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function create(ctx) {
    if (!ctx || !ctx.createGain) return null;
    const t = ctx.currentTime;
    const duck = ctx.createGain();
    duck.gain.setValueAtTime(1, t);
    const roomLow = ctx.createBiquadFilter();
    roomLow.type = "lowshelf";
    roomLow.frequency.setValueAtTime(180, t);
    roomLow.gain.setValueAtTime(1.15, t);
    const roomHigh = ctx.createBiquadFilter();
    roomHigh.type = "highshelf";
    roomHigh.frequency.setValueAtTime(9200, t);
    roomHigh.gain.setValueAtTime(-0.9, t);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.setValueAtTime(-18, t);
    comp.knee.setValueAtTime(9, t);
    comp.ratio.setValueAtTime(2.4, t);
    comp.attack.setValueAtTime(0.005, t);
    comp.release.setValueAtTime(0.16, t);
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.94, t);
    duck.connect(roomLow);
    roomLow.connect(roomHigh);
    roomHigh.connect(comp);
    comp.connect(master);
    master.connect(ctx.destination);

    const voiceIn = ctx.createGain();
    voiceIn.gain.setValueAtTime(1, t);
    voiceIn.connect(duck);

    const impactIn = ctx.createGain();
    impactIn.gain.setValueAtTime(0.88, t);
    if (ctx.createStereoPanner) {
      const narrow = ctx.createStereoPanner();
      narrow.pan.setValueAtTime(0, t);
      impactIn.connect(narrow);
      narrow.connect(duck);
    } else {
      impactIn.connect(duck);
    }

    let duckTarget = 1;
    return {
      voiceIn,
      impactIn,
      duckGain: duck,
      connectVoice(node) {
        if (node) node.connect(voiceIn);
      },
      connectImpact(node) {
        if (node) node.connect(impactIn);
      },
      setDuck(level) {
        const v = Math.max(0.38, Math.min(1, Number(level) || 1));
        if (Math.abs(v - duckTarget) < 0.015) return;
        duckTarget = v;
        const n = ctx.currentTime;
        duck.gain.cancelScheduledValues(n);
        duck.gain.setValueAtTime(duck.gain.value, n);
        duck.gain.linearRampToValueAtTime(v, n + 0.085);
      },
    };
  }

  return { create };
});
