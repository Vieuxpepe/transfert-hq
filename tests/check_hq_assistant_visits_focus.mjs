// Pure focus-policy checks for the assistant visits (assets/hq-assistant-visits.js).
// No browser, no server, no live state.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const V = require("../assets/hq-assistant-visits.js");

assert.equal(V.isField({ tagName: "TEXTAREA" }), true);
assert.equal(V.isField({ tagName: "select" }), true);
assert.equal(V.isField({ tagName: "DIV", isContentEditable: true }), true);
assert.equal(V.isField({ tagName: "BUTTON" }), false);
assert.equal(V.isField(null), false);

const policy = V.createFocusPolicy();
const composer = { tagName: "TEXTAREA" };

policy.noteInitialAuto(composer);
assert.equal(policy.isAuto(composer), true);
assert.equal(policy.blocks(composer), false, "page autofocus alone is passive");

policy.engage(composer);
assert.equal(policy.isAuto(composer), false);
assert.equal(policy.isEngaged(composer), true);
assert.equal(policy.blocks(composer), true, "a user-engaged field blocks visits");

policy.noteAuto(composer);
assert.equal(policy.blocks(composer), true, "programmatic focus cannot downgrade a user engagement");

const fresh = V.createFocusPolicy();
const search = { tagName: "INPUT" };
assert.equal(fresh.blocks(search), true, "an untracked focused field is treated as user-engaged");
fresh.noteAuto(search);
assert.equal(fresh.blocks(search), false, "a programmatic focus can be marked passive");
fresh.engage(search);
assert.equal(fresh.blocks(search), true, "pointer or keyboard interaction engages it");

const passive = V.createFocusPolicy();
const content = { tagName: "DIV", isContentEditable: true };
passive.noteAuto(content);
assert.equal(passive.blocks(content), false);
passive.engage(content);
assert.equal(passive.blocks(content), true);

// ---- rhythm: visits follow a life, not a clock
function seeded(seed) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const rnd = seeded(7);
const day = Array.from({ length: 20000 }, () => V.gapFor(rnd, 14, 120000));
const night = Array.from({ length: 20000 }, () => V.gapFor(rnd, 3, 120000));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
assert.ok(Math.min(...day) >= 45000 && Math.max(...day) <= 2400000, "gaps stay in the 45 s to 40 min band");
assert.ok(day.filter((g) => g < 90000).length / day.length > 0.08, "some quick second crossings");
assert.ok(day.filter((g) => g > 1200000).length / day.length > 0.05, "some long quiets");
assert.ok(mean(day) > 300000, "mostly minutes apart, not the old two-minute metronome");
assert.ok(mean(night) > mean(day) * 2.3, "the night is slower");
const busy = Array.from({ length: 5000 }, () => V.gapFor(rnd, 14, 1000));
const away = Array.from({ length: 5000 }, () => V.gapFor(rnd, 14, 600000));
assert.ok(mean(busy) > mean(away) * 1.8, "a Master away makes visits likelier than a busy one");
assert.equal(new Set(day.slice(0, 200)).size > 150, true, "no fixed period");

const picks = { a: 0, b: 0, c: 0 };
const rp = seeded(11);
for (let i = 0; i < 6000; i++) picks[V.pickWeighted(["a", "b", "c"], [1, 5, 0], rp)]++;
assert.equal(picks.c, 0, "a zero weight is never picked");
assert.ok(picks.b > picks.a * 3, "a larger weight is picked more");
assert.equal(V.pickWeighted([], [], rp), null);
assert.ok(["x", "y"].includes(V.pickWeighted(["x", "y"], [0, 0], rp)), "all-zero weights still pick");

// ---- body language for a private want: direction follows the other sister / the screen
assert.deepEqual(V.moodFor("regard", { toward: 1, centre: 1 }), { dx: 6, dy: -1, rot: 0 });
assert.equal(V.moodFor("regard", { toward: 1, centre: -1 }).dx, -6, "leans toward the middle of the screen");
assert.equal(V.moodFor("taquiner", { toward: -1, centre: 1 }).rot, -3, "tilts toward the other sister");
assert.equal(V.moodFor("nouvelles", { toward: 1, centre: 1 }).dx, 4, "draws closer");
assert.equal(V.moodFor("aveu", { toward: 1, centre: 1 }).dx, -3, "steps back, away from her");
assert.equal(V.moodFor("glance", { toward: 1, centre: 1 }).rot, 4);
assert.equal(V.moodFor("service", { toward: 1, centre: 1 }), null, "the shuffle is a loop, not a held pose");
assert.equal(V.moodFor("nonsense", {}), null);
for (const key of ["regard", "fierte", "taquiner", "nouvelles", "aveu", "service", "glance"]) {
  assert.ok(V.MOOD_KEYS[key], key + " is an allowed mood");
}
assert.ok(!V.MOOD_KEYS.constructor || !V.MOOD_KEYS.hasOwnProperty("constructor"), "no prototype keys");

// ---- the built-in lines: a full bank per assistant, each held to her own voice
const WORD_LIMIT = { else: 8, securia: 9, forgia: 10, pistonia: 10, elsea: 11, inventoria: 12, musica: 12, culinia: 14 };
const GENERAL_MIN = { hello: 12, reply: 12, about: 12, ask: 12, answer: 12, extra: 10, bye: 12 };
const PAIR_MIN = { hello: 3, reply: 3, about: 2, answer: 3, bye: 3 };
const names = V.CHIPS.map((c) => c.key).sort();
assert.deepEqual(names, ["culinia", "else", "elsea", "forgia", "inventoria", "musica", "pistonia", "securia"]);
let total = 0;
const bad = [];
function expect(ok, message) { if (!ok) bad.push(message); }
function checkLine(chip, beat, text) {
  const where = `${chip.key}.${beat}: ${text}`;
  expect(typeof text === "string", where);
  expect(text.trim() === text && text.length > 2, "trimmed and not empty: " + where);
  expect(/[.?!…]["”]?$/.test(text), "ends like a sentence: " + where);
  expect(!/[À-ÿ]/.test(text), "English only (no accented letters): " + where);
  expect(!/\b(master|ma[iî]tre)\b/i.test(text), "never names the Master: " + where);
  const words = text.replace(/\{other\}/g, "Name").match(/[\w'’-]+/g) || [];
  expect(words.length <= WORD_LIMIT[chip.key], `over ${WORD_LIMIT[chip.key]} words (${words.length}): ` + where);
  expect(words.length >= 1, where);
  total += 1;
}
function checkPool(chip, beat, pool, min, label) {
  expect(Array.isArray(pool) && pool.length >= min, `${chip.key}.${label} needs at least ${min} lines`);
  const seen = new Set();
  for (const text of pool) {
    checkLine(chip, beat, text);
    const key = text.toLowerCase();
    expect(!seen.has(key), `duplicate in ${chip.key}.${label}: ${text}`);
    seen.add(key);
  }
}
for (const chip of V.CHIPS) {
  expect(WORD_LIMIT[chip.key], chip.key);
  for (const [beat, min] of Object.entries(GENERAL_MIN)) checkPool(chip, beat, chip[beat], min, beat);
  for (const other of V.CHIPS) {
    if (other.key === chip.key) {
      expect(!chip.pair[other.key], chip.key + " has no pair bank with herself");
      continue;
    }
    const bank = chip.pair && chip.pair[other.key];
    expect(bank, `${chip.key} needs lines for ${other.key}`);
    for (const [beat, min] of Object.entries(PAIR_MIN)) {
      checkPool(chip, beat, bank[beat], min, `pair.${other.key}.${beat}`);
      for (const text of bank[beat]) {
        expect(!chip[beat].map((x) => x.toLowerCase()).includes(text.toLowerCase()),
          `${chip.key}.pair.${other.key}.${beat} repeats her general bank: ${text}`);
      }
    }
    expect(JSON.stringify(Object.keys(bank).sort()) === JSON.stringify(Object.keys(PAIR_MIN).sort()), chip.key + " pair " + other.key + ": only the known pair beats");
  }
}
assert.deepEqual(bad, [], bad.length + " problems in the built-in lines:\n" + bad.join("\n"));
assert.ok(total >= 1000, "a massive bank, not a handful: " + total);
// The Master's questions are English and each has two answers.
for (const chip of V.CHIPS) {
  const q = V.MASTER_QUESTIONS[chip.key];
  assert.ok(q && /\?$/.test(q.text) && q.choices.length === 2, chip.key + " asks him one two-choice question");
  assert.ok(!/[À-ÿ]/.test(q.text + q.choices.map((c) => c.label + c.reply).join("")));
}
console.log("check_hq_assistant_visits_focus: " + total + " built-in lines checked");

console.log("check_hq_assistant_visits_focus: ok");
