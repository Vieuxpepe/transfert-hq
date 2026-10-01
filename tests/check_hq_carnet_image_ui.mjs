// Pure checks for the image gesture maths (assets/hq-carnet-image-ui.js). No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const U = require("../assets/hq-carnet-image-ui.js");

// widthFromDrag: snapped to 5, clamped to 30..100, never NaN
assert.equal(U.widthFromDrag(100, 0, 800, 1), 100);
assert.equal(U.widthFromDrag(100, -80, 800, 1), 90);
assert.equal(U.widthFromDrag(100, -37, 800, 1), 95, "-4.6% snaps to the nearest 5");
assert.equal(U.widthFromDrag(60, 4000, 800, 1), 100, "upper clamp");
assert.equal(U.widthFromDrag(60, -4000, 800, 1), 30, "lower clamp");
assert.equal(U.widthFromDrag(60, -40, 800, 2), 50, "centered images move both edges");
for (const bad of [NaN, Infinity, -Infinity]) {
  assert.equal(U.widthFromDrag(60, bad, 800, 1), 60, "bad pointer travel keeps the width: " + bad);
  assert.equal(U.widthFromDrag(bad, 10, 800, 1), 100, "bad start width falls to the max");
}
assert.equal(U.widthFromDrag(60, 10, 0, 1), 60, "zero container keeps the width");
for (let w = 30; w <= 100; w += 5) for (let dx = -900; dx <= 900; dx += 37) {
  const r = U.widthFromDrag(w, dx, 700, 1);
  assert.ok(Number.isInteger(r) && r >= 30 && r <= 100 && r % 5 === 0, `bounded 5% step: ${w}/${dx} -> ${r}`);
}
// slots and final index
assert.equal(U.slotFromY(5, [10, 30, 50]), 0);
assert.equal(U.slotFromY(35, [10, 30, 50]), 2);
assert.equal(U.slotFromY(500, [10, 30, 50]), 3);
assert.equal(U.targetIndex(1, 1), 1, "dropping on its own slot is a no-op");
assert.equal(U.targetIndex(1, 2), 1, "the slot right below it is also a no-op");
assert.equal(U.targetIndex(1, 3), 2);
assert.equal(U.targetIndex(2, 0), 0);
assert.equal(U.targetIndex(2, 1), 1);
// source hygiene
import { readFileSync } from "node:fs";
const code = readFileSync(new URL("../assets/hq-carnet-image-ui.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "localStorage", "sessionStorage", "fetch(", "XMLHttpRequest", "sendBeacon", "style.transform", "style.left"]) {
  assert.ok(!code.includes(bad), "no " + bad);
}
console.log("hq carnet image ui checks ok");

// ---- gesture finalisation with a frame callback that NEVER runs before pointer-up (reviewer finding)
{
  const listeners = new Map();
  class Node {
    constructor(tag) { this.tag = tag; this.attrs = {}; this.kids = []; this.parentNode = null; this.style = {}; this.rect = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; this.l = {}; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(n) { n.parentNode = this; this.kids.push(n); return n; }
    removeChild(n) { this.kids = this.kids.filter((k) => k !== n); n.parentNode = null; return n; }
    contains(n) { return n === this || this.kids.some((k) => k.contains(n)); }
    querySelector(sel) { return sel === "figure" ? this.kids.find((k) => k.tag === "figure") || null : null; }
    get children() { return this.kids; }
    get firstChild() { return null; }
    set textContent(v) { this.text = v; }
    getBoundingClientRect() { return this.rect; }
    setPointerCapture() {}
    addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); }
    removeEventListener(t, f) { this.l[t] = (this.l[t] || []).filter((x) => x !== f); }
    fire(t, ev) { for (const f of this.l[t] || []) f(ev); }
    get scrollTop() { return 0; }
  }
  const mk = (startWidth = 100) => {
    const doc = new Node("doc");
    doc.createElement = (tag) => new Node(tag);
    const editor = new Node("editor");
    editor.rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
    const lines = [0, 1, 2, 3].map((i) => { const n = new Node("div"); n.rect = { left: 0, top: i * 100, right: 800, bottom: i * 100 + 100, width: 800, height: 100 }; editor.appendChild(n); return n; });
    const line = lines[1];
    line.rect = { left: 0, top: 100, right: 800, bottom: 200, width: 800, height: 100 };
    const fig = new Node("figure");
    line.appendChild(fig);
    const calls = [];
    const pending = [];
    const host = {
      doc, editor: () => editor, token: () => ({ ok: true }), valid: () => true, widthOf: () => startWidth, layoutOf: () => "inline",
      status: () => {}, nudge: () => {}, raf: (fn) => { pending.push(fn); return pending.length; }, cancelRaf: () => {},
      commitWidth: (t, w) => calls.push(["width", w]), commitMove: (t, to) => calls.push(["move", to]),
    };
    return { U: U.mount(host), doc, line, fig, calls, pending, lines };
  };
  const ptr = (x, y, id = 1) => ({ pointerId: id, clientX: x, clientY: y, button: 0, pointerType: "mouse", preventDefault() {}, stopPropagation() {} });
  const handleOf = (fig, kind) => fig.kids.find((k) => k.attrs["data-carnet-handle"] === kind);

  // quick RESIZE: one move then release; the frame callback never runs
  {
    const t = mk();
    t.U.decorate(t.line, "inline");
    const h = handleOf(t.fig, "size-e");
    assert.ok(h && !handleOf(t.fig, "size-w"), "inline: only the right handle exists");
    h.fire("pointerdown", ptr(700, 150));
    h.fire("pointermove", ptr(700 - 80, 150)); // schedules a frame that never executes
    assert.equal(t.pending.length, 1);
    h.fire("pointerup", ptr(700 - 80, 150));
    assert.deepEqual(t.calls, [["width", 90]], "quick resize commits the final snapped width exactly once");
  }
  // quick MOVE: an early frame ran, then a fast final move + release with no frame
  {
    const t = mk();
    t.U.decorate(t.line, "inline");
    const h = handleOf(t.fig, "move");
    h.fire("pointerdown", ptr(10, 150));
    h.fire("pointermove", ptr(10, 160));
    t.pending.shift()(); // the first frame runs: slot under y=160 is 1 (own slot)
    h.fire("pointermove", ptr(10, 380)); // fast final move, frame pending
    h.fire("pointerup", ptr(10, 380)); // release below block 3's midpoint (350): slot 4 -> final index 3
    assert.deepEqual(t.calls, [["move", 3]], "reorder uses the release position, not the previous slot, and commits once");
  }
  // quick move with NO frame at all
  {
    const t = mk();
    t.U.decorate(t.line, "inline");
    const h = handleOf(t.fig, "move");
    h.fire("pointerdown", ptr(10, 150));
    h.fire("pointermove", ptr(10, 20)); // above block 0's midpoint (50): slot 0
    h.fire("pointerup", ptr(10, 20));
    assert.deepEqual(t.calls, [["move", 0]]);
  }
  // a tap without travel commits nothing; Escape/cancel commits nothing
  {
    const t = mk();
    t.U.decorate(t.line, "inline");
    const h = handleOf(t.fig, "size-e");
    h.fire("pointerdown", ptr(700, 150));
    h.fire("pointerup", ptr(700, 150));
    assert.deepEqual(t.calls, []);
    h.fire("pointerdown", ptr(700, 150));
    h.fire("pointermove", ptr(600, 150));
    h.fire("pointercancel", ptr(600, 150));
    assert.deepEqual(t.calls, [], "cancel commits nothing");
  }
  // handles follow the anchored edge: inline -> east only, right -> west only, center -> both (x2)
  {
    const t = mk(60);
    t.U.decorate(t.line, "right");
    assert.ok(handleOf(t.fig, "size-w") && !handleOf(t.fig, "size-e"), "right: only the left handle exists");
    const w = handleOf(t.fig, "size-w");
    w.fire("pointerdown", ptr(300, 150));
    w.fire("pointermove", ptr(300 - 80, 150));
    w.fire("pointerup", ptr(300 - 80, 150));
    assert.deepEqual(t.calls, [["width", 70]], "dragging the left handle left by 80px of 800px grows a right-aligned image by 10%");
    t.U.decorate(t.line, "center");
    assert.ok(handleOf(t.fig, "size-w") && handleOf(t.fig, "size-e"), "center: both handles");
    t.U.decorate(t.line, "inline");
    assert.ok(!handleOf(t.fig, "size-w") && handleOf(t.fig, "size-e") && t.fig.kids.filter((k) => k.attrs["data-carnet-handle"]).length === 2, "re-decorating swaps handles without leaking old ones");
  }
}
console.log("hq carnet image ui gesture-finalisation checks ok");
