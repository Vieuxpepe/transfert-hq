import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function bootKinetic(tier = "full") {
  let now = 1000;
  const rafQueue = [];
  let rafSerial = 0;
  const events = [];
  const ctx = {
    performance: { now: () => now },
    requestAnimationFrame(fn) {
      rafSerial += 1;
      rafQueue.push(fn);
      return rafSerial;
    },
    cancelAnimationFrame() {},
    addEventListener() {},
    dispatchEvent(ev) {
      events.push(ev);
    },
    CustomEvent: function CustomEvent(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    },
    HqMotion: { tier: () => tier },
    HqKinetic: null,
  };
  const code = readFileSync(join(root, "assets", "hq-kinetic-score.js"), "utf8");
  vm.runInNewContext(code, ctx, { filename: "hq-kinetic-score.js" });
  function flushRaf(steps = 8) {
    for (let i = 0; i < steps && rafQueue.length; i += 1) {
      const fn = rafQueue.shift();
      fn(now);
    }
  }
  function advance(ms) {
    now += ms;
    flushRaf(12);
  }
  return { ctx, advance, flushRaf, events };
}

const pulses = [];
const { ctx, advance } = bootKinetic("full");
ctx.HqKinetic.subscribe("test", (ev) => {
  if (ev.phase === "pulse" || ev.phase === "start") pulses.push(ev.energy);
});
const id = ctx.HqKinetic.emit({
  kind: "uiPulse",
  source: "accueil",
  intensity: 1,
  durationMs: 200,
  delayMs: 0,
});
assert.ok(id);
assert.ok(pulses.length >= 1);
advance(400);
assert.equal(ctx.HqKinetic.getState().active, 0);
assert.equal(ctx.HqKinetic.getState().ticking, false);

const order = [];
const b = bootKinetic("full");
b.ctx.HqKinetic.subscribe("order", (ev) => {
  order.push(ev.phase);
});
b.ctx.HqKinetic.emit({ kind: "contact", source: "member", intensity: 0.8, durationMs: 160 });
for (let i = 0; i < 20; i += 1) b.advance(40);
assert.ok(order.includes("start"));
assert.ok(order.includes("end") || b.ctx.HqKinetic.getState().active === 0);

const parked = bootKinetic("parked");
assert.equal(parked.ctx.HqKinetic.emit({ kind: "uiPulse", source: "accueil" }), null);

const manip = bootKinetic("full");
let memberHits = 0;
manip.ctx.HqKinetic.subscribe("manip", (ev) => {
  if (ev.source === "member" && ev.kind === "contact") memberHits += 1;
});
manip.ctx.HqKinetic.setManipulating(true);
manip.ctx.HqKinetic.emit({ kind: "contact", source: "member", intensity: 1, durationMs: 200 });
manip.advance(250);
assert.equal(memberHits, 0);

manip.ctx.HqKinetic.setManipulating(false);
manip.ctx.HqKinetic.emit({ kind: "contact", source: "member", intensity: 1, durationMs: 200 });
manip.advance(250);
assert.ok(memberHits > 0);

console.log("test_hq_kinetic_score.mjs: ok");
