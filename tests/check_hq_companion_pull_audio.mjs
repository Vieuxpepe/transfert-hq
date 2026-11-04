import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Expose the closed-over state only in this test VM, without adding a debug
// interface to the shipped app or requiring a live speaker/audio device.
const source = readFileSync(new URL("../assets/hq-companion.js", import.meta.url), "utf8")
  .replace("const S = {", "const S = global.pullTestState = {")
  .replace("return { start, pure,", "return { testCry: bustPullCry, testStop: stopBustPullVoice, start, pure,");
const sandbox = { module: { exports: {} } };
vm.runInNewContext(source, sandbox);
const api = sandbox.module.exports, state = sandbox.pullTestState;

class Param {
  value = 1;
  events = [];
  setValueAtTime(value, time) { this.events.push({ type: "value", value, time }); }
  setTargetAtTime(value, time, smoothing) { this.events.push({ type: "target", value, time, smoothing }); }
  cancelScheduledValues(time) { this.events = this.events.filter(e => e.time < time); }
}
class Audio {
  currentTime = 0;
  state = "running";
  destination = {};
  oscillators = [];
  gains = [];
  createGain() {
    const node = { gain: new Param(), connect() {}, disconnect() { this.disconnected = true; } };
    this.gains.push(node);
    return node;
  }
  createOscillator() {
    const node = { frequency: new Param(), connect() {}, start(time) { this.startTime = time; },
      stop(time) { this.stopTime = time; }, disconnect() { this.disconnected = true; } };
    this.oscillators.push(node);
    return node;
  }
}
const audio = new Audio();
state.audioCtx = audio;
let soundEnabled = false, muteUntil = 0;
const win = { AudioContext: Audio, localStorage: { getItem(key) {
  return key === 'hq_companion_forge_sound' ? (soundEnabled ? '1' : '0') : key === 'hq_companion_mute_until' ? String(muteUntil) : null;
} } };
api.testCry(win, 50, .8);
assert.equal(audio.oscillators.length, 0, 'explicit sound off stays silent');
soundEnabled = true; muteUntil = Date.now() + 60000;
api.testCry(win, 50, .8);
assert.equal(audio.oscillators.length, 0, 'mute overrides sound preference');
muteUntil = 0;
api.testCry(win, 10, .1);
assert.equal(audio.oscillators.length, 0, "incidental movement stays silent");
for (let i = 0; i < 90; i++) {
  audio.currentTime = i / 100;
  api.testCry(win, 20 + i, i / 100);
}
assert.equal(audio.oscillators.length, 2, "pointermove updates one two-partial voice, without stacking");
assert.equal(audio.gains[0].gain.value, 0, "the voice starts silent, avoiding an initial gain spike");
const targets = audio.gains[0].gain.events.filter(e => e.type === "target" && e.value > 0);
assert.ok(targets.length > 2, "sound tracks intermediate depths");
assert.ok(targets.at(-1).value > targets[0].value);
assert.ok(targets.every(e => e.smoothing >= .08 && e.value < .03), "updates are smoothed and gain stays bounded");
assert.ok(audio.oscillators.every(o => o.stopTime <= 1.9), "a held gesture cannot drone indefinitely");
audio.currentTime = .95;
api.testStop();
assert.ok(audio.oscillators.every(o => o.stopTime <= 1.2), "release schedules a short fade and stops both oscillators");
const stopTimes = audio.oscillators.map(o => o.stopTime);
api.testStop();
assert.deepEqual(audio.oscillators.map(o => o.stopTime), stopTimes, "duplicate cancellation is harmless");
audio.currentTime = 1.7;
api.testCry(win, 150, 1);
assert.equal(audio.oscillators.length, 2, "a released voice cannot restart within the same gesture");
audio.oscillators[1].onended();
assert.ok(audio.oscillators.every(o => o.disconnected) && audio.gains[0].disconnected,
  "finished voices release their audio connections");
state.pullVoice = null;
audio.currentTime = 2;
api.testCry(win, 35, .4);
assert.equal(audio.oscillators.length, 4, "a fresh gesture gets one fresh voice");
assert.ok(state.pullVoice.variation >= .98 && state.pullVoice.variation <= 1.02);
audio.currentTime = 3.7;
api.testCry(win, 150, 1);
assert.equal(audio.oscillators.length, 4, "a long-held gesture cannot restart its expired voice");
state.audioCtx = { createGain() { throw new Error("audio device unavailable"); } };
state.pullVoice = null;
assert.doesNotThrow(() => api.testCry(win, 45, .5), "audio failures never break a captured drag");
console.log("check_hq_companion_pull_audio: smooth gain, voice limit, fade and cleanup ok");
