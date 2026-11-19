// The shipped scheduler, not a test hook: the panel's own timer chain picks two
// mounted chips, fetches the real exchange, stages the visitor and paints. The
// only way in is window.hqAssistantVisitNow (the panel's manual trigger) and the
// only observation is the event the panel dispatches when it paints.
//
//   node tests/check_hq_visit_scheduler.mjs culinia pistonia
//
// HQ_COOKIE comes from the environment and is never printed.
import assert from "node:assert/strict";
import { loadChip, tick, all } from "./hq_dom_stub.mjs";

const host = String(process.argv[2] || "culinia").toLowerCase();
const guest = String(process.argv[3] || "pistonia").toLowerCase();
const base = String(process.env.HQ_BRIDGE || "http://127.0.0.1:8765");
const cookie = String(process.env.HQ_COOKIE || "");
assert.ok(cookie, "HQ_COOKIE must be set by the caller");

const h = loadChip("hq-assistant-visits.js", {
  view: "accueil",
  // No glance, and a clock that moves so the panel's idle guard releases.
  mutate: (source) => ("Math.random = function () { return 0.6; };\n"
    + "var __t = Date.now(); Date.now = function () { __t += 60000; return __t; };\n"
    // Same origin, like a real tab: the panel's own fetch carries the cookie and
    // an Origin header. The house heartbeat answers "nothing new" so this test
    // observes the timer that stages a visit in this tab.
    + "var __f = window.fetch; window.fetch = function (u, o) {\n"
    + "  o = o || {};\n"
    + "  if (String(u).indexOf('/api/assistant-visits') !== -1) {\n"
    + "    return Promise.resolve(new Response(JSON.stringify({ ok: true, events: [] }),\n"
    + "      { status: 200, headers: { 'Content-Type': 'application/json' } }));\n"
    + "  }\n"
    + "  o.headers = Object.assign({}, o.headers || {}, { Origin: " + JSON.stringify(base) + ",\n"
    + "    Cookie: " + JSON.stringify(cookie) + ", 'Content-Type': 'application/json' });\n"
    + "  return __f.call(this, u, o);\n"
    + "};\n"
    // Count the panel's own attempts and keep a failure reason, nothing else.
    + source.replace("function attempt() {",
                    "function attempt() { window.__attempts = (window.__attempts || 0) + 1;")
            .replace("var reason = generated ? \"\" :", "window.__map = { n: (result && result.lines || []).length, ok: !!generated, shape: shape }; var reason = generated ? \"\" :")
            .replace("var next = queued;", "window.__finishes = (window.__finishes || 0) + 1; var next = queued;")
            .replace("function run(hostPick",
                     "function run(hostPick")
            .replace("if (!visitorButton || !hostRect.width)",
                     "window.__guard = { visitor: !!visitorButton, width: hostRect.width, host: !!hostEl }; if (!visitorButton || !hostRect.width)")
            .replace(/} catch \(e\) \{ schedule\(/g,
                     "} catch (e) { (window.__errs = window.__errs || []).push(String((e && e.stack) || e)); schedule(")),
  setup(net) {
    net.on("*", async (call) => {
      // The house heartbeat would put an already-generated pair on screen and hold
      // the stage; the scheduler under test here is the timer that stages a visit
      // of this tab's own, so the heartbeat answers "nothing new".
      if (call.url.indexOf("/api/assistant-visits") !== -1) {
        return { status: 200, body: { ok: true, events: [] } };
      }
      const target = String(call.url).startsWith("http") ? String(call.url) : base + call.url;
      win.__hits = (win.__hits || 0) + 1;
      const response = await fetch(target, {
        method: call.method,
        headers: { "Content-Type": "application/json",
                   "Cookie": "transfert_session=" + cookie, "Origin": base },
        body: call.method === "GET" ? undefined : JSON.stringify(call.body || {}),
      });
      const raw = await response.text();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { win.__raw = raw.slice(0, 120); }
      if (String(call.url).indexOf("assistant-visit-banter") !== -1) {
        win.__lastBanter = Object.assign({ status: response.status }, body);
      }
      return { status: response.status, body };
    });
  },
});
const { doc, win } = h;

doc.body.innerHTML =
  `<button class="hq-${host}-chip" type="button"></button>` +
  `<button class="hq-${guest}-chip" type="button"></button>`;
for (const el of [doc.querySelector(`.hq-${host}-chip`), doc.querySelector(`.hq-${guest}-chip`)]) {
  assert.ok(el, "chip missing from the harness markup");
  el.offsetWidth = 54;
  el.offsetHeight = 54;
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 54, bottom: 54, width: 54, height: 54, x: 0, y: 0 });
}

// The house pulse can also stage a visit it generated on the server (its lines
// are already saved). That path has no exchange of this tab's own, so the
// assertion is on the timer path that fetches and paints here.
let painted = null;
const ignored = [];
win.addEventListener("hq:visit-painted", (event) => {
  const detail = event.detail || {};
  // A glance stages a body with no words; a canned visit is the built-in lines.
  // The scheduler's own exchange is the one that must carry the earned bond.
  detail.via = detail.glance ? "glance" : (detail.source === "canned" ? "canned" : "exchange");
  if (detail.via !== "exchange") { ignored.push(detail); return; }
  detail.stack = (new Error().stack || "").split("\n").slice(2, 5).join(" | ");
  painted = detail;
});

// Real time, not the panel's simulated clock: a generation takes seconds on the
// network, and the panel's own timers must keep running while it is in flight.
// A timer fires when its own delay has really elapsed. Firing a 25 s abort timer
// early would cancel the generation the test is waiting for.
const dueAt = new Map();
async function pump(deadlineMs, until) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (until && until()) return true;
    const now = Date.now();
    const pending = [...win.timers.entries()].filter(([, t]) => !t.interval)
      .sort((a, b) => (a[1].ms - b[1].ms) || (a[0] - b[0]));
    for (const [id, timer] of pending) {
      if (!dueAt.has(id)) dueAt.set(id, now + Number(timer.ms || 0));
    }
    const ready = pending.find(([id]) => dueAt.get(id) <= now);
    if (ready) {
      win.timers.delete(ready[0]);
      dueAt.delete(ready[0]);
      ready[1].fn();
    }
    await tick(25);
  }
  return !!(until && until());
}

await pump(3000);
// The panel refuses a trigger while a visit holds the stage; wait for it to end
// and ask again, which is what a real click would do.
let triggered = false;
for (let attempt = 0; attempt < 40 && !triggered && !painted; attempt++) {
  triggered = win.hqAssistantVisitNow();
  if (!triggered) await pump(500);
}
assert.ok(triggered || painted, "the panel never accepted a trigger");
await pump(60000, () => !!painted);

console.log("DIAG", JSON.stringify({ attempts: win.__attempts || 0, ignored: ignored.slice(0, 2), guard: win.__guard || null, hits: win.__hits || 0, map: win.__map || null, queued: win.__queued || 0, finishes: win.__finishes || 0,
  errors: (win.__errs || []).slice(-2), timers: win.timers.size,
  banter: win.__lastBanter ? { ok: win.__lastBanter.ok, code: win.__lastBanter.code,
                               lines: Array.isArray(win.__lastBanter.lines) ? win.__lastBanter.lines.length : null, status: win.__lastBanter.status, raw: win.__raw || null,
                               provider: win.__lastBanter.provider,
                               bond: win.__lastBanter.bond || null }
                           : null }));
assert.ok(painted, "the scheduler never painted a visit");
assert.deepEqual([painted.host, painted.visitor].sort(), [host, guest].sort(),
                 "the scheduler staged a different pair than the two mounted chips");
const badges = all(doc.body).filter((n) => n.matches && n.matches(".hq-visit-bond"))
  .map((n) => n.textContent.trim()).filter(Boolean);
if (painted.bond) {
  assert.equal(badges.length, 1, "the scheduler painted an earned visit without its badge");
} else {
  assert.equal(badges.length, 0, "the scheduler painted a badge the pair did not earn");
}

// The visit must play out, not be cut off the moment it paints.
const finished = await pump(40000, () => (win.__finishes || 0) > 0);
assert.ok(finished, "the staged visit never reached its end");

console.log(JSON.stringify({
  scheduler: "hqAssistantVisitNow -> panel attempt -> loadBanter -> run",
  painted, badge: badges[0] || null, finished: win.__finishes || 0,
}, null, 2));
