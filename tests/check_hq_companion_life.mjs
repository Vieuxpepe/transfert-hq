// Transferania's timing, pacing, gaze and mood (pure helpers of assets/hq-companion.js) + house rules.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const C = require("../assets/hq-companion.js").pure;

const now = 10_000_000;
const st = (o) => Object.assign({ hidden: false, typingAt: 0, navTimes: [], lastSpokeAt: 0, spoke: [], idleStreak: 0, navOnly: true }, o);
// Quiet while clicking around, speaks once settled.
assert.equal(C.decide(st({ navTimes: [now - 3000, now - 9000, now - 20000] }), now, "view").ok, false, "busy clicking → quiet");
assert.equal(C.decide(st({}), now, "view").ok, true, "settled, never spoke → speaks");
assert.equal(C.decide(st({ lastSpokeAt: now - 90_000, spoke: [now - 90_000] }), now, "view").ok, false, "just spoke → quiet");
assert.equal(C.decide(st({ lastSpokeAt: now - 3 * 60_000, spoke: [now - 3 * 60_000] }), now, "view").ok, false, "plain navigation waits 4 min");
assert.equal(C.decide(st({ lastSpokeAt: now - 3 * 60_000, spoke: [now - 3 * 60_000], navOnly: false }), now, "view").ok, true);
const chatty = [1, 2, 3, 4].map((m) => now - m * 60_000 - 30_000);
assert.equal(C.decide(st({ lastSpokeAt: chatty[0], spoke: chatty, navOnly: false }), now, "view").ok, false, "the more she talked, the longer she waits");
// Never while typing; true events get through quickly.
const typing = C.decide(st({ typingAt: now - 1000 }), now, "event");
assert.deepEqual([typing.ok, typing.retry > 0], [false, true], "waits for you to stop typing");
assert.equal(C.decide(st({ lastSpokeAt: now - 30_000 }), now, "event").ok, true, "an event beats the gap");
assert.equal(C.decide(st({ lastSpokeAt: now - 5_000 }), now, "event").ok, false);
assert.equal(C.decide(st({ hidden: true }), now, "event").ok, false, "not in a hidden tab");
assert.equal(C.decide(st({ lastSpokeAt: now - 13 * 60_000, idleStreak: 2 }), now, "idle").ok, false, "doesn't talk to an empty room");
assert.equal(C.decide(st({ lastSpokeAt: now - 13 * 60_000, idleStreak: 1 }), now, "idle").ok, true);
assert.equal(C.decide(st({ typingAt: now - 100, hidden: true }), now, "manual").ok, true, "a tap always answers");
assert.ok(C.DWELL_MS >= 5000);
assert.equal(C.navOnly("Vue : Accueil\nTitre : Bonjour"), true);
assert.equal(C.navOnly("Vue : Accueil\nSélection : 3 fichiers"), false);

// Word by word, longer pauses at punctuation.
const w = C.paceWords("Backup fini, tout est au chaud. Bonne soirée");
assert.equal(w.map((x) => x.t).join(""), "Backup fini, tout est au chaud. Bonne soirée");
const d = Object.fromEntries(w.map((x) => [x.t.trim(), x.d]));
assert.ok(d["fini,"] > d["tout"] + 100 && d["chaud."] > d["fini,"], "comma < full stop");
assert.deepEqual(C.paceWords("  "), []);

// Gaze: towards the cursor, small, capped.
assert.deepEqual(C.glance(0, 0), { x: 0, y: 0 });
assert.deepEqual(C.glance(-1000, 0), { x: -2.4, y: 0 });
const g = C.glance(60, 80);
assert.ok(g.x > 0 && g.y > 0 && g.x < 1 && g.y < 1, "a near cursor is a small glance");

// Mood → orb.
assert.deepEqual(C.orbVars({ soft: 0.9, warm: 0.2 }), { breath: "6.36s", warm: "0.20", soft: true }, "soft = slower breath");
assert.ok(parseFloat(C.orbVars({ soft: 0.1, warm: 0.9 }).breath) < 4.4, "warm = livelier");
assert.equal(C.pickVoice([{ lang: "en-US" }, { lang: "fr-FR" }, { lang: "fr-CA" }]).lang, "fr-CA");
assert.equal(C.pickVoice([{ lang: "fr-FR" }]).lang, "fr-FR");
assert.equal(C.pickVoice([]), null);

const src = readFileSync(new URL("../assets/hq-companion.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../assets/hq-companion.css", import.meta.url), "utf8");
assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(src), "no HTML from strings");
assert.ok(/event_id: S\.pendingEvent \? S\.pendingEvent\.id/.test(src), "the client sends an event id, never event text");
assert.ok(/S\.nsfwOn \|\| win\.document\.hidden/.test(src), "no voice in adult mode or a hidden tab");
const loose = css.split("@media (prefers-reduced-motion:no-preference)");
assert.ok(!/hq-companion-breathe [^;}]*infinite/.test(loose[0]) && loose.slice(1).some((p) => /hq-companion-breathe/.test(p)), "breathing only with motion allowed");
const py = readFileSync(new URL("../hq_ai.py", import.meta.url), "utf8");
assert.ok(py.includes('a == "pulse"') && py.includes("hq_life.find(st, event_id)"));
console.log("check_hq_companion_life: ok");
