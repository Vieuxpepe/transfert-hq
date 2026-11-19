// Musica beat engine: tempo folding, the shared clock and its lock, tap tempo, live tempo / phase / drops.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const B = createRequire(import.meta.url)('../assets/hq-musica-beat.js');

// 1) folding keeps whole multiples of the beat inside the dance range
assert.equal(B.foldBeat(60 / 120), 0.5);
assert.ok(Math.abs(B.foldBeat(60 / 70) - 60 / 140) < 1e-9, '70 BPM folds to double time');
assert.ok(Math.abs(B.foldBeat(60 / 200) - 0.6) < 1e-9, '200 BPM folds to half time');
assert.equal(B.foldBeat(NaN), 0.5);

// 2) a locked clock follows song time, snaps on a seek, and counts crossed beats
const c = B.createClock(0.6);
assert.ok(B.setTempo(c, 120, 0.25, 'tap'));
let song = 10, crossedTotal = 0;
B.stepClock(c, 1 / 60, song);
assert.ok(c.snapped, 'first lock snaps to the song');
for (let i = 0; i < 600; i += 1) { song += 1 / 60; crossedTotal += B.stepClock(c, 1 / 60, song); }
assert.ok(Math.abs(c.beats - (song - 0.25) / 0.5) < 0.02, 'locked beats track the grid: ' + c.beats);
assert.ok(crossedTotal >= 19 && crossedTotal <= 21, '10 s at 120 BPM crosses ~20 beats: ' + crossedTotal);
B.stepClock(c, 1 / 60, 100);
assert.ok(c.snapped, 'a seek snaps');
// free-running guess
const g = B.createClock(0.5);
for (let i = 0; i < 120; i += 1) B.stepClock(g, 1 / 60, NaN);
assert.ok(Math.abs(g.beats - 4) < 0.05, 'free clock counts 4 beats in 2 s');

// 3) bars and phase error
assert.equal(B.nextBar(5.1, 0), 8);
assert.equal(B.nextBar(8, 0), 8);
assert.equal(B.nextBar(8, 6), 16);
assert.ok(Math.abs(B.toBar(6.5) - 1.5) < 1e-9);
assert.ok(Math.abs(B.phaseError(0, 2, 1)) < 1e-9, 'beat 2 at rate 1 wants phase 0 (mod 4π)');
assert.ok(Math.abs(B.phaseError(Math.PI * 2, 1, 1)) < 1e-9, 'beat 1 wants 2π');
assert.ok(Math.abs(Math.abs(B.phaseError(0, 0.5, 1)) - Math.PI) < 1e-9);

// 4) tap tempo: steady taps give the tempo and his first tap as the downbeat
const t = B.createTap();
let res = null;
for (let i = 0; i < 6; i += 1) res = B.tap(t, 100 + i * 0.469, 30 + i * 0.469 + (i % 2 ? 0.01 : -0.01)) || res;
assert.ok(res && Math.abs(res.bpm - 128) < 1.5, 'tapped ~128 BPM: ' + (res && res.bpm));
assert.ok(Math.abs(res.offset - 30) < 0.03 || Math.abs(((res.offset - 30) / 0.469) % 1) < 0.07, 'offset on his taps: ' + res.offset);
const t2 = B.createTap();
assert.equal(B.tap(t2, 1, 1), null);
B.tap(t2, 1.5, 1.5); B.tap(t2, 2.3, 2.3);
assert.equal(B.tap(t2, 2.6, 2.6), null, 'uneven taps give nothing');

// 5) live tracker: a synthetic 128 BPM kick track, quiet breakdown, then a drop
function frame(time, bpm, offset, loud) {
  const spec = new Uint8Array(512);
  const period = 60 / bpm;
  const since = ((time - offset) % period + period) % period;
  const kick = Math.exp(-since * 28);
  for (let i = 1; i < 512; i += 1) {
    const base = (i < 4 ? 120 : 60 * Math.exp(-i / 140)) * loud;
    const hit = (i < 4 ? 130 : 40 * Math.exp(-i / 90)) * kick * loud;
    spec[i] = Math.min(255, Math.round(base + hit + ((i * 7919 + Math.floor(time * 60) * 31) % 5)));
  }
  return spec;
}
const tr = B.createTracker({sampleRate: 48000, fftSize: 1024});
let found = null, dropAt = -1;
for (let f = 0; f < 60 * 40; f += 1) {
  const time = 5 + f / 60;
  const loud = time < 25 ? 1 : (time < 29 ? 0.25 : 1);
  const r = B.pushSpectrum(tr, frame(time, 128, 0.12, loud), time);
  if (r.drop && dropAt < 0) dropAt = time;
  found = B.track(tr, time) || found;
}
assert.ok(found, 'a stable tempo was found');
const bpm = found.bpm;
const ratio = bpm / 128;
assert.ok(Math.abs(ratio - 1) < 0.03 || Math.abs(ratio - 0.5) < 0.02 || Math.abs(ratio - 2) < 0.05, 'live tempo ~128 (or octave): ' + bpm);
const beatPeriod = 60 / 128;
// the reported beat lines up with a real kick near the end of the window
const kickPeriod = 60 / 128;
const phaseOff = (((found.offset - 0.12) % kickPeriod) + kickPeriod) % kickPeriod;
assert.ok(Math.min(phaseOff, kickPeriod - phaseOff) < 0.04, 'live phase lands on the kick: ' + phaseOff.toFixed(3));
assert.ok(found.offset > 30, 'offset is a recent beat: ' + found.offset);
assert.ok(dropAt >= 29 && dropAt < 31, 'drop detected right after the breakdown: ' + dropAt.toFixed(2));
const curve = B.energyCurve(tr);
assert.ok(curve.length >= 40 && Math.max(...curve) === 1, 'energy curve normalised, one value a second');
assert.ok(curve[26] < curve[20] * 0.6, 'breakdown is visible in the curve');
assert.ok(B.curveRel(curve, 1, 26) < 0.7 && B.curveRel(curve, 1, 35) > 0.9);
// a seek does not crash or keep stale onsets
B.pushSpectrum(tr, frame(2, 128, 0.12, 1), 2);
assert.equal(tr.envN <= 1, true, 'seek clears the onset history');
assert.ok(B.liveIntensity(128, 0.5) > B.liveIntensity(80, 0.5));

console.log('musica beat ok: live', bpm.toFixed(2), 'BPM, phase err', Math.min(phaseOff, kickPeriod - phaseOff).toFixed(3), 's, drop at', dropAt.toFixed(2), 's');

// 7) the chip's beat-less fallback keeps the surface this module exports: the stub is a copy, and a
// copy that drifts throws exactly where the fallback exists to keep the chip alive.
import { readFileSync } from 'node:fs';
const chipSrc = readFileSync(new URL('../assets/hq-musica-chip.js', import.meta.url), 'utf8');
const stubBlock = chipSrc.split('function beatlessEngine()')[1] || '';
const stubKeys = new Set([...stubBlock.matchAll(/^ {6}([A-Za-z]\w*)\s*:/gm)].map((m) => m[1]));
const apiFunctions = Object.keys(B).filter((k) => typeof B[k] === 'function');
const unprovided = apiFunctions.filter((k) => !stubKeys.has(k));
assert.ok(stubKeys.size > 0, 'beatlessEngine() is present in hq-musica-chip.js');
assert.deepEqual(unprovided, [], 'beatlessEngine() must provide every hq-musica-beat.js function: ' + unprovided.join(', '));
console.log('musica beat ok (beatless fallback covers', apiFunctions.length, 'functions)');
