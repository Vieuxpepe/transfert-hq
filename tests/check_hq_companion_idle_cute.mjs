import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../assets/hq-companion.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} }, Math, Date, parseFloat, parseInt, isNaN, isFinite, Number, String, Array, Object, JSON, RegExp, Error, Set, Map, Promise, Symbol, Reflect };
vm.runInNewContext(source, sandbox);
const {
  playIdleAnim,
  pickIdleAnimKind,
  stripIdleBurstClasses,
  IDLE_ANIM_STRIP,
  CUTE_NSFW_IDLE_KINDS,
  startIdleHumming,
  stopIdleHumming,
  state: S
} = sandbox.module.exports.testIdle;

const classes = new Set();
const timers = [];
const intervals = [];
const classList = {
  contains: (k) => classes.has(k),
  add: (k) => classes.add(k),
  remove: (...keys) => keys.forEach((k) => classes.delete(k)),
  toggle(k, on) { if (on) classes.add(k); else classes.delete(k); }
};
const style = { props: new Map(), setProperty(k, v) { style.props.set(k, v); }, removeProperty(k) { style.props.delete(k); },
  getPropertyValue(k) { return style.props.get(k) || ''; } };
const avatar = {
  getBoundingClientRect: () => ({ left: 100, top: 200, width: 80, height: 80 })
};
const avRow = {
  getBoundingClientRect: () => ({ left: 90, top: 190, width: 100, height: 100 }),
  appendChild(el) { avRow.children.push(el); },
  children: [],
  querySelector: () => null
};
const bubble = { querySelector: () => null, appendChild() {} };

const win = {
  document: { hidden: false, body: { dataset: { view: '' } }, createElement: (tag) => ({ tagName: tag, className: '', textContent: '', style: { props: new Map(),
    set left(v) { this._l = v; }, get left() { return this._l; },
    set top(v) { this._t = v; }, get top() { return this._t; },
    setProperty(k, v) { this.props.set(k, v); } }, setAttribute() {}, appendChild() {}, remove() {} }) },
  matchMedia: () => ({ matches: false }),
  setTimeout(fn, ms) { const t = { fn, ms }; timers.push(t); return timers.length; },
  clearTimeout() {},
  setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
  clearInterval() { intervals.length = 0; },
  performance: { now: () => 0 }
};

S.win = win;
S.nsfwOn = true;
S.lastActAt = Date.now() - 30000;
S.el = {
  hidden: false,
  classList,
  style,
  querySelector(sel) {
    if (sel === '.hq-companion-avatar') return avatar;
    if (sel === '.hq-companion-av-row') return avRow;
    return null;
  }
};
S.bubble = bubble;
S.busy = false;
S.chatBusy = false;
S.companionDragActive = false;

const origRandom = Math.random;
try {
  Math.random = () => 0.805;
  S.nsfwOn = false;
  const sfPick = pickIdleAnimKind();
  assert.equal(CUTE_NSFW_IDLE_KINDS.has(sfPick), false, 'cute kinds stay off when adult mode is off');
  S.nsfwOn = true;
  assert.equal(pickIdleAnimKind(), 'grooveSway', 'groove sway draws in adult mode');

  for (const kind of CUTE_NSFW_IDLE_KINDS) {
    classes.clear();
    style.props.clear();
    avRow.children.length = 0;
    playIdleAnim(win, kind);
    const cls = {
      grooveSway: 'is-idle-groove-sway',
      kissBlow: 'is-idle-kiss-blow',
      shyWiggle: 'is-idle-shy-wiggle',
      cuteWink: 'is-idle-cute-wink',
      heartFlutter: 'is-idle-heart-flutter',
      sparkleShimmy: 'is-idle-sparkle-shimmy'
    }[kind];
    assert.equal(classes.has(cls), true, kind + ' adds its burst class');
    stripIdleBurstClasses();
    assert.equal(classes.has(cls), false, kind + ' strips with idle pack');
  }

  for (const cls of IDLE_ANIM_STRIP) {
    assert.ok(typeof cls === 'string' && cls.startsWith('is-idle-'), 'strip lists ' + cls);
  }

  S.nsfwOn = false;
  classes.clear();
  playIdleAnim(win, 'kissBlow');
  assert.equal(classes.has('is-idle-kiss-blow'), false, 'kiss blow blocked without adult mode');

  S.nsfwOn = true;
  classes.clear();
  S.reactionAudio = null;
  S.lastIdleHummingAt = 0;
  assert.equal(startIdleHumming(win), true, 'idle humming starts');
  assert.equal(classes.has('is-idle-humming'), true);
  assert.ok(intervals.length >= 1, 'humming schedules floating notes');
  assert.ok(style.getPropertyValue('--rig-hum-beat').endsWith('s'), 'humming sets beat var');
  stopIdleHumming(win);
  assert.equal(classes.has('is-idle-humming'), false);
  assert.equal(intervals.length, 0, 'humming clears note interval');
  S.idleHummingNoteI = win.setInterval(() => {}, 500);
  assert.equal(intervals.length, 1);
  stopIdleHumming(win);
  assert.equal(intervals.length, 0, 'stopIdleHumming clears orphaned note timers');
} finally {
  Math.random = origRandom;
}

console.log('check_hq_companion_idle_cute: ok');
