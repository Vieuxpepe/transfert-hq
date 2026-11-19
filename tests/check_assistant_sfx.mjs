// Per-assistant SFX: bank validation, no-repeat, cooldown, and every silence rule.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const sfx = createRequire(import.meta.url)("../assets/hq-assistant-sfx.js");

const store = new Map();
const played = [];
const chipEl = { hidden: false, isConnected: true, parentElement: null, nodeType: 1 };
const manifests = {
  else: { samples: {
    open: [{ url: "/assets/assistant-sfx/else/hi_a.ogg", duration_ms: 900 }, { url: "/assets/assistant-sfx/else/hi_b.ogg", duration_ms: 900 }],
    reply: [{ url: "/assets/companion/chat/reactions/evil.ogg", duration_ms: 900 }, { url: "/assets/assistant-sfx/else/long.ogg", duration_ms: 90000 }],
    bogus: [{ url: "/assets/assistant-sfx/else/x.ogg", duration_ms: 900 }],
  } },
};
const win = {
  document: { hidden: false },
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
  fetch: async (url) => {
    const id = /assistant-sfx\/([a-z]+)\//.exec(url)?.[1];
    return manifests[id] ? { ok: true, json: async () => manifests[id] } : { ok: false };
  },
  Audio: class {
    constructor(url) { this.url = url; this.paused = true; }
    play() { played.push(this.url); return Promise.resolve(); }
    pause() {} removeAttribute() {} load() {}
  },
};
sfx.register("else", () => chipEl, win);

const ids = () => played.splice(0);
assert.equal(await sfx.play("else", "reply", win), false, "foreign-path and over-long clips are rejected, bank stays empty for reply");
assert.equal(await sfx.play("culinia", "open", win), false, "missing manifest is silent");
assert.equal(await sfx.play("else", "bogus", win), false, "unknown kind rejected");
assert.equal(await sfx.play("nobody", "open", win), false, "unknown assistant rejected");

assert.equal(await sfx.play("else", "open", win), true, "valid clip plays");
assert.match(ids()[0], /^\/assets\/assistant-sfx\/else\/hi_[ab]\.ogg$/);
assert.equal(await sfx.play("else", "open", win), false, "per-kind cooldown holds");

// Silence rules (cooldown is per kind, so use a kind that has not fired: add one via a fresh manifest read is cached,
// so check the gate directly).
assert.equal(sfx.enabled(win, "else"), true);
chipEl.hidden = true;
assert.equal(sfx.enabled(win, "else"), false, "hidden chip (assistant off) is silent");
chipEl.hidden = false;
store.set("hq_companion_mute_until", String(Date.now() + 60000));
assert.equal(sfx.enabled(win, "else"), true, "Transferania's mute must not silence another assistant");
store.delete("hq_companion_mute_until");
store.set("hq_else_mute_until_v1", String(Date.now() + 60000));
assert.equal(sfx.enabled(win, "else"), false, "Else's own mute silences Else");
store.delete("hq_else_mute_until_v1");
win.document.hidden = true;
assert.equal(sfx.enabled(win, "else"), false, "hidden tab is silent");
win.document.hidden = false;
sfx.setEnabled("else", false, win);
assert.equal(sfx.enabled(win, "else"), false, "per-assistant sound switch is silent");
sfx.setEnabled("else", true, win);
store.set("hq_asfx_all", "0");
assert.equal(sfx.enabled(win, "else"), false, "global sound switch is silent");
store.delete("hq_asfx_all");
assert.equal(sfx.enabled(win, "else"), true);

assert.equal(sfx._sampleOk("else", { url: "/assets/assistant-sfx/inventoria/a.ogg", duration_ms: 900 }), false, "clip must live in its own assistant's folder");
assert.equal(sfx._sampleOk("else", { url: "/assets/assistant-sfx/else/../../x.ogg", duration_ms: 900 }), false, "no path traversal");
console.log("check_assistant_sfx: bank validation, cooldown and silence rules ok");
