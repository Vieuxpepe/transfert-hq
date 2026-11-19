/* Musica's beat engine: one clock every dance layer reads, tap tempo, and a live tempo / drop tracker
 * fed by an AnalyserNode spectrum. Pure functions and plain objects, so node tests can drive it. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HqMusicaBeat = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MIN_BEAT = 0.32, MAX_BEAT = 0.82;   // the twerk reads well between ~73 and ~187 bounces a minute
  var TAU = Math.PI * 2;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function frac(v) { return v - Math.floor(v); }

  // Fold a beat period into the dance range by whole halvings or doublings, so it still lands on the music.
  function foldBeat(sec) {
    if (!(sec > 0) || !isFinite(sec)) return 0.5;
    while (sec > MAX_BEAT) sec /= 2;
    while (sec < MIN_BEAT) sec *= 2;
    return sec;
  }

  // ---- Clock -------------------------------------------------------------------------------------------
  // beats counts from the song's beat grid when locked (offset = song time of a downbeat), else free-runs.
  function createClock(guessSec) {
    var b = foldBeat(guessSec || 0.5);
    return { beats: 0, beatSec: b, targetSec: b, offset: null, locked: false, source: "guess", snapped: false, bpm: 60 / b };
  }

  function setGuess(clock, sec) {
    clock.targetSec = foldBeat(sec);
    clock.offset = null;
    clock.locked = false;
    clock.source = "guess";
    clock.bpm = 60 / clock.targetSec;
  }

  function setTempo(clock, bpm, offset, source) {
    if (!(bpm >= 40 && bpm <= 240)) return false;
    var raw = 60 / bpm;
    var folded = foldBeat(raw);
    clock.targetSec = folded;
    clock.bpm = bpm;
    clock.source = source || "grid";
    if (typeof offset === "number" && isFinite(offset)) {
      // Keep the offset on a bar of the folded beat: the raw grid's downbeat is also one of ours when we halve.
      clock.offset = offset;
      clock.locked = true;
    } else {
      clock.offset = null;
      clock.locked = false;
    }
    return true;
  }

  // Advance the clock by dt; returns how many whole beats were crossed (0 after a snap).
  function stepClock(clock, dt, songTime) {
    clock.snapped = false;
    var prev = clock.beats;
    var rate = clock.locked ? 8 : 3;
    clock.beatSec += (clock.targetSec - clock.beatSec) * (1 - Math.exp(-dt * rate));
    clock.beats += dt / clock.beatSec;
    if (clock.locked && typeof songTime === "number" && isFinite(songTime)) {
      var want = (songTime - clock.offset) / clock.targetSec;
      var err = want - clock.beats;
      if (Math.abs(err) > 3) {
        clock.beats = want;            // seek, new song, first lock: jump, and let the dancer catch up softly
        clock.snapped = true;
        return 0;
      }
      clock.beats += err * Math.min(1, dt * 2.5);
    }
    var crossed = Math.floor(clock.beats) - Math.floor(prev);
    return crossed > 0 ? Math.min(crossed, 2) : 0;
  }

  // The first bar line at least minBeats ahead.
  function nextBar(beats, minBeats) {
    return Math.ceil((beats + (minBeats || 0)) / 4 - 1e-6) * 4;
  }

  // Beats left until the next bar line.
  function toBar(beats) {
    var left = 4 - (beats - Math.floor(beats / 4) * 4);
    return left >= 4 - 1e-9 ? 0 : left;
  }

  // Error between the dancer's phase (0..4π, one 2π cycle per bounce) and where the clock says it should be.
  // rate: bounces per beat (0.5 half time, 1, 2 double time). The 4π window keeps the side-to-side sway on bars.
  function phaseError(phase, beats, rate) {
    var want = 2 * TAU * frac(beats * rate / 2);
    var err = want - phase;
    while (err > TAU) err -= 2 * TAU;
    while (err <= -TAU) err += 2 * TAU;
    return err;
  }

  // ---- Tap tempo ---------------------------------------------------------------------------------------
  function createTap() { return { times: [], songs: [] }; }

  // t: wall seconds of the tap; songTime: where the song was (NaN when unknown). Returns {bpm, offset} once
  // four or more steady taps agree, else null.
  function tap(state, t, songTime) {
    var last = state.times[state.times.length - 1];
    if (last != null && (t - last > 2.2 || t - last < 0.18)) {
      if (t - last < 0.18) return null;   // a bounce of the same tap
      state.times = []; state.songs = [];
    }
    state.times.push(t);
    state.songs.push(songTime);
    if (state.times.length > 9) { state.times.shift(); state.songs.shift(); }
    var n = state.times.length;
    if (n < 4) return null;
    var gaps = [];
    for (var i = 1; i < n; i += 1) gaps.push(state.times[i] - state.times[i - 1]);
    var sorted = gaps.slice().sort(function (a, b) { return a - b; });
    var med = sorted[sorted.length >> 1];
    for (var g = 0; g < gaps.length; g += 1) {
      if (Math.abs(gaps[g] - med) > med * 0.16) return null;
    }
    var period = (state.times[n - 1] - state.times[0]) / (n - 1);
    var bpm = 60 / period;
    if (bpm < 40 || bpm > 240) return null;
    var offset = null;
    if (state.songs.every(function (s) { return typeof s === "number" && isFinite(s); })) {
      // Circular mean of each tap's implied downbeat, so one early tap does not shift the grid.
      var sx = 0, sy = 0;
      for (var k = 0; k < n; k += 1) {
        var a = TAU * frac(state.songs[k] / period);
        sx += Math.cos(a); sy += Math.sin(a);
      }
      var ph = Math.atan2(sy, sx) / TAU;
      if (ph < 0) ph += 1;
      // The first tap is his "one": put the bar there.
      var first = state.songs[0];
      var beatAtFirst = Math.round(first / period - ph) + ph;
      offset = beatAtFirst * period;
      while (offset < 0) offset += period * 4;
    }
    return { bpm: Math.round(bpm * 100) / 100, offset: offset };
  }

  // ---- Live tracker ------------------------------------------------------------------------------------
  var ENV_RATE = 50, ENV_SECONDS = 9;

  function createTracker(opts) {
    opts = opts || {};
    var size = ENV_RATE * ENV_SECONDS;
    return {
      sampleRate: opts.sampleRate || 48000,
      fftSize: opts.fftSize || 1024,
      env: new Float32Array(size), envN: 0, envHead: 0, nextT: NaN, pending: 0,
      prev: null, lastT: NaN,
      fluxAvg: 0, lastOnsetT: -1, onset: 0,
      short: 0, long: 0, mean: 0, meanN: 0, bassMean: 0,
      dipFrom: -1, dipLevel: 0, lastDropT: -1e9, drops: [],
      energy: [], energyStep: 1,
      estimates: [], bpm: 0, offset: null, confidence: 0, nextEstimateT: 0, stableSince: -1, anchor: 0, anchorBpm: 0
    };
  }

  function resetTracker(tr) {
    var fresh = createTracker({ sampleRate: tr.sampleRate, fftSize: tr.fftSize });
    for (var k in fresh) if (Object.prototype.hasOwnProperty.call(fresh, k)) tr[k] = fresh[k];
  }

  function envPush(tr, v) {
    tr.env[tr.envHead] = v;
    tr.envHead = (tr.envHead + 1) % tr.env.length;
    if (tr.envN < tr.env.length) tr.envN += 1;
  }

  function envAt(tr, back) {   // back = 0 is the newest sample
    var i = tr.envHead - 1 - back;
    while (i < 0) i += tr.env.length;
    return tr.env[i];
  }

  // spec: byte magnitudes (AnalyserNode.getByteFrequencyData); t: song seconds. Returns this frame's reading.
  function pushSpectrum(tr, spec, t) {
    if (!(typeof t === "number" && isFinite(t))) return null;
    if (isFinite(tr.lastT) && (t < tr.lastT - 0.05 || t - tr.lastT > 1.0)) {
      var keepEnergy = tr.energy, keepDrops = tr.drops, keepMean = tr.mean, keepN = tr.meanN, keepBass = tr.bassMean;
      var keepBpm = tr.bpm, keepOff = tr.offset, keepConf = tr.confidence;
      resetTracker(tr);   // a seek: the onset history no longer lines up with the song
      tr.energy = keepEnergy; tr.drops = keepDrops; tr.mean = keepMean; tr.meanN = keepN; tr.bassMean = keepBass;
      tr.bpm = keepBpm; tr.offset = keepOff; tr.confidence = keepConf;
    }
    var n = spec.length;
    var binHz = tr.sampleRate / tr.fftSize;
    var bassTop = Math.max(2, Math.min(n, Math.round(160 / binHz)));
    var top = Math.min(n, Math.round(9000 / binHz));
    var flux = 0, bass = 0, level = 0;
    var prev = tr.prev;
    for (var i = 1; i < top; i += 1) {
      var v = spec[i] / 255;
      level += v;
      if (i < bassTop) bass += v;
      if (prev) {
        var d = v - prev[i];
        if (d > 0) flux += d * (i < bassTop ? 2.5 : 1);
      }
    }
    if (!prev || prev.length !== n) tr.prev = new Float32Array(n);
    for (var j = 0; j < n; j += 1) tr.prev[j] = spec[j] / 255;
    flux /= Math.max(1, top);
    bass /= Math.max(1, bassTop - 1);
    level /= Math.max(1, top - 1);
    var dtFrame = isFinite(tr.lastT) ? Math.max(0, t - tr.lastT) : 0;
    tr.lastT = t;

    // Onset envelope at a fixed rate, whatever the frame rate.
    tr.pending = Math.max(tr.pending, flux);
    if (!isFinite(tr.nextT)) tr.nextT = t;
    var guard = 0;
    while (tr.nextT <= t && guard < 60) {
      envPush(tr, tr.pending);
      tr.nextT += 1 / ENV_RATE;
      guard += 1;
    }
    if (guard) tr.pending = 0;

    // Onsets: above a running average, with a 110 ms refractory gap.
    var a = 1 - Math.exp(-dtFrame * 4);
    tr.fluxAvg += (flux - tr.fluxAvg) * (tr.fluxAvg ? a : 1);
    var onset = 0;
    if (flux > tr.fluxAvg * 1.6 + 0.004 && t - tr.lastOnsetT > 0.11) {
      onset = clamp((flux - tr.fluxAvg) / (tr.fluxAvg * 3 + 0.01), 0, 1);
      tr.lastOnsetT = t;
    }
    tr.onset = onset;

    // Loudness: short (0.4 s), long (6 s) and whole-track mean.
    var power = 0.6 * level + 0.4 * bass;
    tr.short += (power - tr.short) * (1 - Math.exp(-dtFrame / 0.4));
    tr.long += (power - tr.long) * (1 - Math.exp(-dtFrame / 6));
    if (!tr.meanN) { tr.short = tr.long = power; }
    tr.meanN += 1;
    tr.mean += (power - tr.mean) / Math.min(tr.meanN, 3000);
    tr.bassMean += (bass - tr.bassMean) / Math.min(tr.meanN, 3000);

    // Energy curve: one value per energyStep seconds of song.
    var slot = Math.floor(t / tr.energyStep);
    if (slot >= 0 && slot < 900) {
      while (tr.energy.length < slot) tr.energy.push(null);
      var prevE = tr.energy[slot];
      tr.energy[slot] = prevE == null ? power : Math.max(prevE, power);
    }

    // Drops: a clear dip below the long average, then a return well above where the dip sat.
    var drop = false;
    if (tr.meanN > 120) {
      if (tr.dipFrom < 0 && tr.short < tr.long * 0.62) { tr.dipFrom = t; tr.dipLevel = tr.short; }
      if (tr.dipFrom >= 0) {
        tr.dipLevel = Math.min(tr.dipLevel, tr.short);
        if (tr.short > Math.max(tr.dipLevel * 1.7, tr.mean * 0.95) && t - tr.dipFrom > 1.2 && t - tr.lastDropT > 18) {
          drop = true;
          tr.lastDropT = t;
          tr.dipFrom = -1;
          if (tr.drops.length < 24) tr.drops.push(Math.round(t * 1000) / 1000);
        } else if (t - tr.dipFrom > 14) {
          tr.dipFrom = -1;   // a long quiet part, not a build-up
        }
      }
    }
    return { onset: onset, flux: flux, bass: bass, level: level, drop: drop,
      rel: tr.mean > 0.01 ? clamp(tr.short / tr.mean, 0.2, 2.2) : 1 };
  }

  // Tempo by autocorrelation of the onset envelope (70-180 BPM, mild preference for ~120), phase by a comb.
  function estimate(tr) {
    var N = tr.envN;
    if (N < ENV_RATE * 5) return null;
    var minLag = Math.floor(ENV_RATE * 60 / 180), maxLag = Math.ceil(ENV_RATE * 60 / 70);
    var mean = 0, k;
    for (k = 0; k < N; k += 1) mean += envAt(tr, k);
    mean /= N;
    var x = new Float32Array(N);
    for (k = 0; k < N; k += 1) x[k] = envAt(tr, N - 1 - k) - mean;   // oldest first
    var zero = 0;
    for (k = 0; k < N; k += 1) zero += x[k] * x[k];
    if (zero <= 1e-9) return null;
    var ac = new Float32Array(maxLag + 2);
    for (var lag = minLag - 1; lag <= maxLag + 1; lag += 1) {
      var s = 0;
      for (k = lag; k < N; k += 1) s += x[k] * x[k - lag];
      ac[lag] = s / (N - lag);
    }
    var best = -1, bestScore = -Infinity;
    for (lag = minLag; lag <= maxLag; lag += 1) {
      var bpmL = 60 * ENV_RATE / lag;
      var prior = Math.exp(-0.5 * Math.pow(Math.log2(bpmL / 120) / 0.9, 2));
      // A true beat also echoes at twice its period.
      var echo = 2 * lag <= maxLag + 1 ? Math.max(0, ac[2 * lag] || 0) * 0.5 : 0;
      var score = (ac[lag] + echo) * (0.6 + 0.4 * prior);
      if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1] && score > bestScore) { bestScore = score; best = lag; }
    }
    if (best < 0) return null;
    var y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1];
    var denom = y0 - 2 * y1 + y2;
    var shift = denom !== 0 ? clamp(0.5 * (y0 - y2) / denom, -0.5, 0.5) : 0;
    var period = (best + shift) / ENV_RATE;
    var confidence = clamp(y1 / (zero / N), 0, 1);
    // Phase: which offset inside one period collects the most onset energy, counted back from the newest sample.
    var P = best + shift, bestPh = 0, bestSum = -Infinity;
    for (var ph = 0; ph < Math.ceil(P); ph += 1) {
      var sum = 0;
      for (var m = ph; m < N; m += P) {
        var i0 = Math.floor(m), f = m - i0;
        var v0 = envAt(tr, i0), v1 = i0 + 1 < N ? envAt(tr, i0 + 1) : v0;
        sum += v0 * (1 - f) + v1 * f;
      }
      if (sum > bestSum) { bestSum = sum; bestPh = ph; }
    }
    var newestT = tr.nextT - 1 / ENV_RATE;
    var beatT = newestT - bestPh / ENV_RATE;
    // The offset is a recent beat, not one modded back to zero: a tiny tempo error would drift that far.
    return { bpm: 60 / period, offset: Math.max(0, beatT), confidence: confidence, period: period };
  }

  // Call often; re-estimates every 2 s and reports a tempo only after two agreeing estimates.
  function track(tr, t) {
    if (!(t >= tr.nextEstimateT)) return null;
    tr.nextEstimateT = t + 2;
    var e = estimate(tr);
    if (!e || e.confidence < 0.08) return null;
    tr.estimates.push(e);
    if (tr.estimates.length > 4) tr.estimates.shift();
    var prev = tr.estimates[tr.estimates.length - 2];
    // The long-span anchor survives one odd estimate (a breakdown): it only resets when the tempo really moves.
    if (tr.anchorBpm && Math.abs(e.bpm - tr.anchorBpm) / tr.anchorBpm > 0.03) { tr.anchorBpm = 0; tr.stableSince = -1; }
    if (!prev || Math.abs(prev.bpm - e.bpm) / e.bpm > 0.03) return null;
    if (tr.stableSince < 0) tr.stableSince = t;
    if (!tr.anchorBpm) { tr.anchor = e.offset; tr.anchorBpm = e.bpm; }
    // Refine the tempo from beats many periods apart: far more precise than one autocorrelation window.
    var span = e.offset - tr.anchor;
    var count = Math.round(span / e.period);
    if (count >= 8) {
      var refined = span / count;
      if (Math.abs(refined - e.period) / e.period < 0.03) { e.period = refined; e.bpm = 60 / refined; }
    }
    tr.bpm = e.bpm; tr.offset = e.offset; tr.confidence = e.confidence;
    return e;
  }

  // Normalised curve for storage (0..1, nulls filled from the neighbour).
  function energyCurve(tr) {
    var arr = tr.energy.slice(0, 900), peak = 0, last = 0, k;
    for (k = 0; k < arr.length; k += 1) if (arr[k] != null && arr[k] > peak) peak = arr[k];
    if (peak <= 0) return [];
    for (k = 0; k < arr.length; k += 1) {
      if (arr[k] == null) arr[k] = last; else last = arr[k];
      arr[k] = Math.round(clamp(arr[k] / peak, 0, 1) * 1000) / 1000;
    }
    return arr;
  }

  // How loud this moment is against the track's own average (1 = average), from a stored curve.
  function curveRel(curve, step, t) {
    if (!curve || !curve.length || !(t >= 0)) return 1;
    var i = Math.min(curve.length - 1, Math.floor(t / (step || 1)));
    var mean = curve.__mean;
    if (mean == null) {
      mean = 0;
      for (var k = 0; k < curve.length; k += 1) mean += curve[k];
      mean = curve.length ? mean / curve.length : 0;
      try { Object.defineProperty(curve, "__mean", { value: mean }); } catch (_) {}
    }
    return mean > 0.01 ? clamp(curve[i] / mean, 0.2, 2.2) : 1;
  }

  // A tempo-and-energy intensity (0.38-1.32) for music the chip can hear.
  function liveIntensity(bpm, bassMean) {
    var base = bpm >= 150 ? 1.1 : (bpm >= 125 ? 0.95 : (bpm >= 90 ? 0.8 : 0.58));
    return clamp(base + (bassMean - 0.45) * 0.6, 0.38, 1.32);
  }

  return {
    MIN_BEAT: MIN_BEAT, MAX_BEAT: MAX_BEAT, ENV_RATE: ENV_RATE,
    foldBeat: foldBeat, createClock: createClock, setGuess: setGuess, setTempo: setTempo, stepClock: stepClock,
    nextBar: nextBar, toBar: toBar, phaseError: phaseError,
    createTap: createTap, tap: tap,
    createTracker: createTracker, resetTracker: resetTracker, pushSpectrum: pushSpectrum,
    estimate: estimate, track: track, energyCurve: energyCurve, curveRel: curveRel, liveIntensity: liveIntensity
  };
});
