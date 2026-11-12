// Behavioural check of assets/hq-voice-studio.js with a minimal fake DOM (no jsdom in this repo).
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.value = ""; this.attrs = {}; }
  append(...k) { for (const x of k) this.children.push(typeof x === "string" ? { text: x } : x); }
  replaceChildren(...k) { this.children = []; this.append(...k); if (this.tag === "select" && this.children[0]) this.value = this.children[0].value; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  click() { if (this.disabled) return; for (const f of this.listeners.click || []) f(); }
  removeAttribute() {} 
}
const all = [];
const doc = { createElement: (t) => { const e = new El(t); all.push(e); return e; }, defaultView: null };
const audios = [], calls = [];
class FakeAudio { constructor(u) { this.src = u; this.paused = false; audios.push(this); } play() { return Promise.resolve(); } pause() { this.paused = true; } load() {} removeAttribute() {} }
class FakeAbort { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } }
const profile = (e) => ({ engine: e, voice: null, rate: 0, selected: false, preview_voice: "Coralie" });
const data = { ok: true, profiles: { else: { ...profile("xtts"), selected: true, preview_voice: null }, transferania: profile("phonon"), inventoria: profile("phonon"), musica: profile("phonon") },
  status: { models: { fr: {} } }, candidates: { transferania: ["Coralie", "Maëlys"] }, voices: { fr: [{ name: "Coralie", description: "" }, { name: "Maëlys", description: "" }] },
  engines: { xtts: ["else"], phonon: ["transferania", "inventoria", "musica", "else"], browser: ["else", "transferania", "inventoria", "musica"] } };
let pending = [];
doc.defaultView = { AbortController: FakeAbort, Audio: FakeAudio, speechSynthesis: { cancel() {} },
  fetch: (url, init) => { const b = JSON.parse(init.body); calls.push({ b, signal: init.signal });
    if (b.op === "voice_profiles") return Promise.resolve({ json: async () => data });
    return new Promise((res) => pending.push(() => res({ json: async () => ({ ok: true, audio_url: "/a.wav", engine: "phonon", voice: b.voice }) }))); } };
const ctx = { window: undefined, globalThis: {} }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync("assets/hq-voice-studio.js", "utf8"), ctx);
const box = new El("div");
const h = ctx.HqVoiceStudio.mount(doc, box, { deviceId: "d1", character: "transferania" });
await new Promise((r) => setTimeout(r, 10));
const btn = (t) => all.find((e) => e.tag === "button" && e.textContent === t);
assert.equal(calls[0].b.op, "voice_profiles");
btn("Écouter").click(); btn("Écouter").click(); // second click ignored while disabled
assert.equal(calls.filter((c) => c.b.op === "voice_preview").length, 1);
btn("Arrêter").click(); // cancels in-flight request
assert.equal(calls[1].signal.aborted, true);
pending.shift()(); await new Promise((r) => setTimeout(r, 10));
assert.equal(audios.length, 0, "cancelled preview must not play");
btn("Écouter").click(); pending.shift()(); await new Promise((r) => setTimeout(r, 10));
assert.equal(audios.length, 1); assert.equal(audios[0].paused, false);
btn("Écouter").click(); assert.equal(audios[0].paused, true, "new preview stops previous audio");
pending.shift()(); await new Promise((r) => setTimeout(r, 10));
assert.equal(calls.filter((c) => c.b.op === "voice_save").length, 0, "preview never saves");
h.destroy(); assert.equal(audios[1].paused, true, "destroy releases audio");
console.log("Voice studio: load, cancel, no overlap, no auto-save, cleanup passed");
