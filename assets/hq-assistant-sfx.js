/* Per-assistant sound-effect stash. Each assistant owns a bank of recorded clips
 * (assets/assistant-sfx/<id>/manifest.json) and plays them at a few moments: open, reply, think, error, done.
 * Silent when: the assistant's chip is hidden/off, that assistant's own mute is active, the tab is hidden,
 * the user switched that assistant's sounds off (hq_asfx_<id>=0), or the bank is empty. */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HqAssistantSfx = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const IDS = ["else", "inventoria", "culinia", "securia", "forgia", "pistonia", "musica", "elsea"];
  const KINDS = { open: 20000, reply: 4000, think: 15000, error: 8000, done: 10000, ack: 3000 };
  // Each assistant is muted by its own key only: muting one must never silence another (Transferania's
  // hq_companion_mute_until is deliberately not read here).
  const LS_MUTE = { else: "hq_else_mute_until_v1" };
  const VOLUME = 0.7;
  const MAX_MS = 6000;
  const MANIFEST_REV = "2";

  const banks = new Map(); // id -> Promise<{kind: sample[]}>
  const cycle = new Map(); // id:kind -> last url
  const nextAt = new Map(); // id:kind -> ms
  const chips = new Map(); // id -> () => element
  let playing = null; // { id, audio }

  function sampleOk(id, s) {
    return s && Number.isFinite(s.duration_ms) && s.duration_ms >= 150 && s.duration_ms <= MAX_MS &&
      new RegExp("^/assets/assistant-sfx/" + id + "/[a-z0-9_-]+(?:\\.[0-9a-f]{8})?\\.(?:ogg|mp3|m4a|wav)$", "i").test(String(s.url || ""));
  }

  function loadBank(win, id) {
    if (!banks.has(id)) {
      banks.set(id, win.fetch("/assets/assistant-sfx/" + id + "/manifest.json?v=" + MANIFEST_REV)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)
        .then((m) => {
          const out = {};
          for (const [kind, list] of Object.entries((m && m.samples) || {})) {
            if (!Object.hasOwn(KINDS, kind)) continue;
            const good = (Array.isArray(list) ? list : [list]).filter((s) => sampleOk(id, s));
            if (good.length) out[kind] = good;
          }
          return out;
        }));
    }
    return banks.get(id);
  }

  function prefOn(win, id) {
    try { return win.localStorage.getItem("hq_asfx_" + id) !== "0" && win.localStorage.getItem("hq_asfx_all") !== "0"; } catch (_) { return true; }
  }
  function muted(win, id) {
    const key = LS_MUTE[id];
    if (!key) return false;
    try { return Number(win.localStorage.getItem(key) || 0) > Date.now(); } catch (_) { return false; }
  }
  function visible(el) {
    if (!el || !el.isConnected || el.hidden) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (n.hidden) return false;
    return true;
  }
  function chipShown(id) {
    const get = chips.get(id);
    if (!get) return true; // not registered: caller vouches for visibility
    try { return visible(get()); } catch (_) { return false; }
  }

  function enabled(win, id) {
    win = win || root;
    return !!(win && win.document && IDS.includes(id) && !win.document.hidden && !muted(win, id) && prefOn(win, id) && chipShown(id));
  }

  function pickSample(id, kind, list) {
    const key = id + ":" + kind;
    const pool = list.length > 1 ? list.filter((s) => s.url !== cycle.get(key)) : list;
    const s = pool[Math.floor(Math.random() * pool.length)];
    cycle.set(key, s.url);
    return s;
  }

  function stopAll(id) {
    if (!playing || (id && playing.id !== id)) return;
    const { audio } = playing;
    playing = null;
    try { audio.onended = audio.onerror = null; audio.pause(); audio.removeAttribute("src"); audio.load(); } catch (_) {}
  }

  function play(id, kind, win) {
    win = win || root;
    if (!win || !Object.hasOwn(KINDS, kind) || !enabled(win, id)) return Promise.resolve(false);
    const key = id + ":" + kind;
    if (Date.now() < (nextAt.get(key) || 0)) return Promise.resolve(false);
    return loadBank(win, id).then((bank) => {
      const list = bank[kind];
      // Re-check after the async load: the user may have toggled the assistant off meanwhile.
      if (!list || !enabled(win, id) || Date.now() < (nextAt.get(key) || 0) || playing) return false;
      const s = pickSample(id, kind, list);
      const audio = new win.Audio(s.url);
      audio.volume = VOLUME;
      const entry = { id, audio };
      playing = entry;
      const done = () => { if (playing === entry) playing = null; };
      audio.onended = done;
      audio.onerror = done;
      nextAt.set(key, Date.now() + KINDS[kind]);
      return audio.play().then(() => true).catch(() => { done(); return false; });
    });
  }

  // Register the element whose visibility means "this assistant is on", and stop sounds when it goes away.
  function register(id, getEl, win) {
    if (!IDS.includes(id) || typeof getEl !== "function") return;
    win = win || root;
    chips.set(id, getEl);
    const el = (() => { try { return getEl(); } catch (_) { return null; } })();
    if (el && win.MutationObserver && !el.__hqAsfx) {
      el.__hqAsfx = true;
      new win.MutationObserver(() => { if (!visible(el)) stopAll(id); })
        .observe(el, { attributes: true, attributeFilter: ["hidden", "class", "style"] });
    }
  }

  function setEnabled(id, on, win) {
    win = win || root;
    try { win.localStorage.setItem("hq_asfx_" + id, on ? "1" : "0"); } catch (_) {}
    if (!on) stopAll(id);
  }

  return { IDS, KINDS: Object.keys(KINDS), play, stopAll, enabled, register, setEnabled, _sampleOk: sampleOk };
});
