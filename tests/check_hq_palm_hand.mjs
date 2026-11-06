import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../assets/hq-palm-hand.js", import.meta.url), "utf8");
assert.ok(/PARTICLE_CAP = 4/.test(source), "particle cap constant");
assert.ok(/catch_cursor: 9000/.test(source), "catch cursor cooldown");
assert.ok(/trace_vein: 12000/.test(source), "vein trace cooldown");
assert.ok(/grip_pole: 9000/.test(source), "grip pole cooldown");
assert.ok(/releaseHold/.test(source), "grip release API");
assert.ok(/transferina-hand-grip\.png/.test(source), "grip hand asset path");
assert.ok(/landDeg: 6/.test(source), "grip dorsal land rotation");
assert.ok(/oxMul: 0\.33/.test(source), "grip pole gap anchor");
assert.ok(/runTraceVein\(path, opts\)/.test(source), "trace vein accepts start point");
assert.ok(/GLOBAL_GAP = 3000/.test(source), "global palm floor");

const sandbox = {
  module: { exports: {} },
  Math,
  Date,
  parseFloat,
  parseInt,
  isNaN,
  isFinite,
  Number,
  String,
  Array,
  Object,
  JSON,
  RegExp,
  Error
};
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox);
const { create } = sandbox.module.exports;

let now = 6000;
const bodyChildren = [];
const rafQueue = [];
const timeouts = [];
let jiggleSoftCalls = 0;
let calm = false;

function makeEl(tag) {
  const style = {
    opacity: "0",
    width: "",
    left: "",
    top: "",
    transform: "",
    props: new Map(),
    setProperty(k, v) {
      style.props.set(k, v);
    },
    getPropertyValue(k) {
      return style.props.get(k) || "";
    }
  };
  const el = {
    tagName: tag.toUpperCase(),
    className: "",
    src: "",
    alt: "",
    draggable: false,
    style,
    classList: {
      toggle() {}
    },
    setAttribute() {},
    remove() {
      const i = bodyChildren.indexOf(el);
      if (i >= 0) bodyChildren.splice(i, 1);
    }
  };
  return el;
}

const avatar = {
  getBoundingClientRect: () => ({
    left: 100,
    top: 200,
    width: 80,
    height: 80,
    right: 180,
    bottom: 280
  })
};
const bubble = {
  getBoundingClientRect: () => ({ left: 240, top: 180, width: 120, height: 40 })
};

const doc = {
  hidden: false,
  body: {
    appendChild(el) {
      bodyChildren.push(el);
    }
  },
  querySelector(sel) {
    if (sel === ".hq-companion-avatar") return avatar;
    if (sel === ".hq-companion-bubble") return bubble;
    if (sel === ".hq-companion-compose input") return null;
    return null;
  },
  createElement(tag) {
    return makeEl(tag);
  }
};

const win = {
  document: doc,
  performance: { now: () => now },
  requestAnimationFrame(fn) {
    rafQueue.push(fn);
    return rafQueue.length;
  },
  setTimeout(fn, ms) {
    timeouts.push({ fn, at: now + ms });
    return timeouts.length;
  },
  clearTimeout() {},
  matchMedia: () => ({ matches: false })
};

function drainRaf(stepMs = 16) {
  while (rafQueue.length) {
    now += stepMs;
    const batch = rafQueue.splice(0);
    for (const fn of batch) fn(now);
    while (timeouts.length && timeouts[0].at <= now) {
      const t = timeouts.shift();
      t.fn();
    }
  }
}

function resetDom() {
  bodyChildren.length = 0;
  rafQueue.length = 0;
  timeouts.length = 0;
  now = 6000;
  jiggleSoftCalls = 0;
  calm = false;
  doc.hidden = false;
}

function makePalm(extraCtx) {
  return create(win, {
    calm: () => calm,
    jiggleSoft: () => {
      jiggleSoftCalls += 1;
    },
    cockNear: () => ({ at: { x: 150, y: 240 } }),
    ...extraCtx
  });
}

resetDom();
now = 0;
let palm = makePalm();
assert.equal(palm.ready("catch_cursor"), true, "never-played kinds stay ready at low performance.now()");

now = 6000;
palm = makePalm();
assert.equal(palm.busy(), false);
assert.equal(palm.play("slap"), true, "slap uses cockNear ctx");
assert.equal(palm.play("wave"), false, "single active gesture blocks wave");
drainRaf(24);
now = 8000;
assert.equal(palm.busy(), false, "slap busy window elapsed");

resetDom();
palm = makePalm();
assert.equal(palm.play("catch_cursor", { x: 140, y: 230 }), true);
assert.equal(bodyChildren.filter((n) => n.tagName === "IMG").length, 2, "catch uses both palms");
assert.equal(palm.play("catch_cursor", { x: 140, y: 230 }), false, "no stacked catch");
assert.equal(palm.play("shield"), false, "shield blocked while catch runs");
drainRaf(20);
assert.ok(jiggleSoftCalls >= 1, "catch clasp triggers soft jiggle");
now = 8000;
assert.equal(palm.busy(), false, "catch finishes");
assert.equal(palm.ready("catch_cursor"), false, "catch cooldown after finish");
now = 16000;
assert.equal(palm.ready("catch_cursor"), true, "catch cooldown expires");
assert.equal(palm.ready("wave"), false, "wave waits 45s after any palm");
now = 52000;
assert.equal(palm.ready("wave"), true, "wave allowed after quiet period");

resetDom();
palm = makePalm();
assert.equal(palm.play("celebrate"), true);
assert.equal(palm.ready("catch_cursor"), false, "global floor blocks catch right after celebrate");
drainRaf(20);
now = 9000;
assert.equal(palm.ready("catch_cursor"), true, "global floor elapsed");

resetDom();
palm = makePalm({ cockNear: () => null });
assert.equal(palm.play("slap"), false, "slap needs shaft proximity");
assert.equal(palm.play("celebrate"), true, "screen gestures need no shaft");
drainRaf(20);

resetDom();
palm = makePalm();
assert.equal(palm.play("catch_cursor", { x: 140, y: 230 }), true);
doc.hidden = true;
drainRaf(8);
now = 8000;
assert.equal(palm.busy(), false, "hidden document aborts catch");
assert.equal(bodyChildren.filter((n) => n.tagName === "IMG").every((n) => n.style.opacity === "0"), true);

resetDom();
calm = true;
palm = makePalm();
assert.equal(palm.ready("catch_cursor"), false);
assert.equal(palm.play("catch_cursor", { x: 140, y: 230 }), false);
assert.equal(palm.play("hush"), false);

resetDom();
calm = false;
palm = makePalm();
doc.hidden = true;
assert.equal(palm.play("shield"), false, "play bails when tab hidden");

console.log("check_hq_palm_hand: busy, cooldowns, dual catch, calm and hidden abort ok");
