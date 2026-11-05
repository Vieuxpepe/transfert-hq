// eyes1: general eye life. Off-switch equivalence, blink bounds, reduced-motion/hidden/NSFW disable, bounded drift.
import fs from "node:fs";
import assert from "node:assert/strict";
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const JS = fs.readFileSync(process.env.EYES_JS || root + "/assets/hq-companion.js", "utf8");
const CSS = fs.readFileSync(process.env.EYES_CSS || root + "/assets/hq-companion.css", "utf8");
function fn(name) {
  const i = JS.indexOf("function " + name + "(");
  assert.ok(i >= 0, name);
  let k = JS.indexOf("{", i), depth = 0;
  for (; k < JS.length; k++) { if (JS[k] === "{") depth++; else if (JS[k] === "}" && --depth === 0) break; }
  return JS.slice(i, k + 1);
}
const konst = (n) => Number(JS.match(new RegExp("const " + n + " = ([\\d.]+);"))[1]);
assert.match(JS, /const EYES_ALIVE = true;/);
const MIN = konst("EYES_BLINK_MIN_MS"), MAX = konst("EYES_BLINK_MAX_MS"), DRIFT = konst("EYES_DRIFT_MAX_PX");
const PMIN = konst("EYES_PUPIL_MIN"), PMAX = konst("EYES_PUPIL_MAX");
assert.ok(PMIN >= 0.88 && PMAX <= 1.15);
assert.match(CSS, /\.hq-companion\.is-eyes-alive:not\(\.is-nsfw\) \.hq-companion-eye::before\{[^}]*transform:scale\(var\(--eye-pupil,1\)\);transition:transform \.45s/);
assert.equal(MIN, 2500); assert.equal(MAX, 7000); assert.ok(DRIFT <= 2);

// Off-switch / NSFW path keeps the legacy expressions verbatim.
assert.ok(JS.includes("EYES_ALIVE && !S.nsfwOn ? eyesBlinkDelayMs(circ.blinkMul) : (2100 + Math.random() * 5000 + (Math.random() < 0.12 ? 2000 : 0)) * circ.blinkMul"));
assert.ok(JS.includes("(235 + Math.random() * 25) * circ.blinkMul * (EYES_ALIVE && !S.nsfwOn ? eyesBlinkDurMul() : 1)"));
assert.ok(fn("tickEyesAlive").includes("if (!EYES_ALIVE || !S.el) return;"));
// every new CSS rule is gated on .is-eyes-alive:not(.is-nsfw)
const block = CSS.slice(CSS.indexOf("/* eyes1:"));
const rules = block.split("\n").filter((l) => l.startsWith("."));
assert.ok(rules.length >= 6);
for (const r of rules) assert.ok(r.startsWith(".hq-companion.is-eyes-alive:not(.is-nsfw)"), r);
assert.ok(!/blur|backdrop-filter|animation|will-change/.test(block));

function mkClassList(init = []) {
  const s = new Set(init);
  return { contains: (c) => s.has(c), add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)),
    toggle: (c, on) => { (on ?? !s.has(c)) ? s.add(c) : s.delete(c); }, _s: s };
}
function mkStyle() { const m = new Map(); return { setProperty: (k, v) => m.set(k, v), removeProperty: (k) => m.delete(k), _m: m }; }
function build(enabled, env) {
  const src = [fn("clampNum"), fn("eyesAliveMoodKey"), fn("eyesBlinkDelayMs"), fn("eyesBlinkDurMul"), fn("eyesAliveReset"), fn("tickEyesAlive")].join("\n");
  return new Function("S", "calm", "blink", "Date", `const EYES_ALIVE=${enabled},EYES_BLINK_MIN_MS=${MIN},EYES_BLINK_MAX_MS=${MAX},EYES_DRIFT_MAX_PX=${DRIFT},EYES_PUPIL_MIN=${PMIN},EYES_PUPIL_MAX=${PMAX};\n${src}\nreturn {eyesBlinkDelayMs,eyesBlinkDurMul,tickEyesAlive};`)(env.S, env.calm, env.blink, env.Date);
}
function env(opts = {}) {
  let now = 1000;
  const S = { el: { classList: mkClassList(opts.cls), hidden: false, style: mkStyle() }, face: { style: mkStyle() }, nsfwOn: !!opts.nsfw, busy: false };
  const e = { S, blinks: 0, calm: () => !!opts.reduced, blink: () => { e.blinks++; }, Date: { now: () => now }, adv: (ms) => { now += ms; } };
  e.win = { document: { hidden: !!opts.hidden } };
  return e;
}
// Blink interval bounds across moods, circadian multipliers and extreme random values.
for (const cls of [[], ["is-soft"], ["is-mood-celebrate"], ["is-mood-error"]]) for (const mul of [0.9, 1, 1.32]) for (const r of [0, 0.5, 0.999999]) {
  const e = env({ cls }); const f = build(true, e);
  const d = f.eyesBlinkDelayMs(mul, () => r);
  assert.ok(d >= MIN && d <= MAX, `${cls} ${mul} ${r} -> ${d}`);
}
{ const e = env({ cls: ["is-soft"] }); assert.ok(build(true, e).eyesBlinkDurMul() > 1); }
{ const e = env({ cls: ["is-mood-celebrate"] }); assert.ok(build(true, e).eyesBlinkDurMul() < 1); }
// Disabled: tick touches nothing.
{ const e = env(); const f = build(false, e); for (let i = 0; i < 50; i++) { f.tickEyesAlive(e.win); e.adv(200); }
  assert.equal(e.S.el.classList._s.size, 0); assert.equal(e.S.face.style._m.size, 0); assert.equal(e.blinks, 0); }
// Reduced motion / hidden tab / paused / NSFW: inert, and resets if it was on.
for (const o of [{ reduced: true }, { hidden: true }, { nsfw: true }, { cls: ["is-anim-paused"] }]) {
  const e = env(o); const f = build(true, e); for (let i = 0; i < 20; i++) { f.tickEyesAlive(e.win); e.adv(200); }
  assert.ok(!e.S.el.classList.contains("is-eyes-alive"), JSON.stringify(o)); assert.equal(e.S.face.style._m.size, 0, JSON.stringify(o));
}
{ const e = env(); const f = build(true, e); f.tickEyesAlive(e.win); assert.ok(e.S.el.classList.contains("is-eyes-alive"));
  e.win.document.hidden = true; f.tickEyesAlive(e.win); assert.ok(!e.S.el.classList.contains("is-eyes-alive")); assert.equal(e.S.face.style._m.size, 0); }
// Bounded drift + glint; events.
{ const e = env(); const f = build(true, e); let seeded = 7; const rnd = () => (seeded = (seeded * 16807) % 2147483647) / 2147483647;
  let moved = 0;
  for (let i = 0; i < 2000; i++) {
    f.tickEyesAlive(e.win, rnd); e.adv(200);
    const x = parseFloat(e.S.face.style._m.get("--eye-drift-x")), y = parseFloat(e.S.face.style._m.get("--eye-drift-y")), a = parseFloat(e.S.face.style._m.get("--eye-glint-a"));
    assert.ok(Math.abs(x) <= DRIFT && Math.abs(y) <= DRIFT, `${x},${y}`); assert.ok(a >= 0.66 && a <= 0.9, String(a));
    if (x !== 0) moved++;
  }
  assert.ok(moved > 0);
  e.S.busy = true; f.tickEyesAlive(e.win); assert.ok(e.S.el.classList.contains("is-eyes-narrow"));
  e.S.busy = false; f.tickEyesAlive(e.win); assert.ok(e.S.el.classList.contains("is-eyes-widen")); assert.ok(!e.S.el.classList.contains("is-eyes-narrow"));
  e.adv(500); f.tickEyesAlive(e.win); assert.ok(!e.S.el.classList.contains("is-eyes-widen"));
  const b = e.blinks; e.S.el.classList.add("is-speaking"); f.tickEyesAlive(e.win); e.S.el.classList.remove("is-speaking"); f.tickEyesAlive(e.win); assert.equal(e.blinks, b + 2);
}
// Explicit path untouched by this change.
assert.ok(!fn("tickEyesAlive").includes("warmth") && !fn("tickEyesAlive").includes("arousal"));
// pupils1: bounds, mood direction, reply dilation, off-switch and reduced-motion.
{ const e = env(); const f = build(true, e); let seeded = 11; const rnd = () => (seeded = (seeded * 16807) % 2147483647) / 2147483647;
  const P = () => parseFloat(e.S.face.style._m.get("--eye-pupil")); let lo = 9, hi = 0;
  for (let i = 0; i < 3000; i++) { f.tickEyesAlive(e.win, rnd); e.adv(200); const p = P(); assert.ok(p >= PMIN && p <= PMAX, String(p)); lo = Math.min(lo, p); hi = Math.max(hi, p); }
  assert.ok(hi - lo > 0.04 && hi - lo < 0.12, `${lo}..${hi}`);
  const avg = (cls, busy) => { const g = env({ cls }); const h = build(true, g); g.S.busy = !!busy; let s = 0; for (let i = 0; i < 400; i++) { h.tickEyesAlive(g.win, rnd); g.adv(200); s += parseFloat(g.S.face.style._m.get("--eye-pupil")); } return s / 400; };
  const n = avg([]); assert.ok(avg(["is-soft"]) > n + 0.02); assert.ok(avg([], true) < n - 0.02);
  const g = env(); const h = build(true, g); const fixed = () => 0.5;
  g.S.busy = true; h.tickEyesAlive(g.win, fixed); const pb = parseFloat(g.S.face.style._m.get("--eye-pupil"));
  g.S.busy = false; g.adv(200); h.tickEyesAlive(g.win, fixed); const pd = parseFloat(g.S.face.style._m.get("--eye-pupil")); assert.ok(pd > pb + 0.08, `${pb}->${pd}`);
  g.adv(600); h.tickEyesAlive(g.win, fixed); assert.ok(parseFloat(g.S.face.style._m.get("--eye-pupil")) < pd);
  g.win.document.hidden = true; h.tickEyesAlive(g.win); assert.ok(!g.S.face.style._m.has("--eye-pupil")); }
for (const o of [{ reduced: true }, { nsfw: true }, { cls: ["is-dozing"] }]) { const e = env(o); const f = build(true, e); f.tickEyesAlive(e.win); assert.ok(!e.S.face.style._m.has("--eye-pupil"), JSON.stringify(o)); }
{ const e = env(); const f = build(false, e); f.tickEyesAlive(e.win); assert.ok(!e.S.face.style._m.has("--eye-pupil")); }
console.log("eyes alive OK");
