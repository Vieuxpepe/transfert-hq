// Offline proof of the Personnalité panel: the real browser file runs in a small
// DOM (tests/hq_dom_stub.mjs) against the real payloads the server returns for
// two assistants whose stored history differs. No browser, no server, no network.
//
//   HQ_PERSONHOOD_FIXTURES=<json file> node tests/check_personhood_panel.mjs
//
// The fixture is `{ "<key>": <snapshot payload>, "<key>": <snapshot payload> }`
// written by tests/test_hq_family_state.py from real hq_personhood.snapshot calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadChip, tick, byId } from "./hq_dom_stub.mjs";

const fixturePath = process.env.HQ_PERSONHOOD_FIXTURES;
assert.ok(fixturePath, "HQ_PERSONHOOD_FIXTURES must point at the payload file");
const payloads = JSON.parse(readFileSync(fixturePath, "utf8"));
const keys = Object.keys(payloads);
assert.ok(keys.length >= 2, "two payloads are needed to compare two assistants");

const h = loadChip("hq-personhood.js", { view: "accueil" });
const { doc, win, net } = h;

net.on("*", (call) => {
  const key = new URL(call.url, "http://localhost").searchParams.get("key");
  const payload = payloads[key];
  return payload ? { body: payload } : { status: 404, body: { ok: false, error: "no fixture for " + key } };
});

assert.ok(win.hqPersonhoodOpen, "the panel exposes its opener");
win.hqPersonhoodOpen();
await tick();

const select = byId(doc, "hq-self-key");
assert.ok(select, "the panel has the assistant picker");
const body = byId(doc, "hq-self-body");
assert.ok(body, "the panel has a body");

// The stub's innerHTML parser keeps character entities verbatim; a browser decodes
// them. Compare against the same escaping so both readings agree on the words.
const plain = (text) => String(text)
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");

const rendered = {};
for (const key of keys) {
  select.value = key;
  select.dispatchEvent({ type: "change", bubbles: true });
  await tick();
  const text = plain(body.textContent);
  assert.ok(text.length > 200, key + ": the panel renders sections, not an error");
  for (const title of ["Lien au Maître", "Cœur caché", "Famille", "TICS ET GOÛTS"]) {
    assert.ok(text.toUpperCase().includes(title.toUpperCase()), key + ": renders « " + title + " »");
  }
  // The hidden undercurrent is on the panel, with its rung, its counts and her own
  // wording — and it must not read like any other assistant's.
  const heart = payloads[key].heart;
  assert.ok(heart && heart.hidden === true, key + ": the payload carries a hidden heart");
  assert.ok(text.includes(plain(heart.line)), key + ": shows her own hidden-heart line");
  assert.ok(text.includes(plain(heart.stage_label)), key + ": names the hidden-heart rung");
  assert.ok(text.includes("Visible pour toi seul"), key + ": says it is only for the Master");
  const payload = payloads[key];
  const opinion = plain(payload.voice.opinion).replace(/^(AVIS|OPINION) — /, "");
  assert.ok(text.includes(opinion), key + ": her opinion is on screen");
  assert.ok(!text.includes("hq-self-error"), key + ": no error box");
  rendered[key] = text;
}

// Different substance, not a different label: each panel carries its own voice,
// opinion, bond sentence and family rung, and no sibling's opinion.
for (const key of keys) {
  for (const other of keys) {
    if (other === key) continue;
    const mine = plain(payloads[key].voice.opinion).replace(/^(AVIS|OPINION) — /, "");
    const theirs = plain(payloads[other].voice.opinion).replace(/^(AVIS|OPINION) — /, "");
    assert.ok(rendered[key].includes(mine), key + ": keeps her own opinion");
    assert.ok(!rendered[key].includes(theirs), key + ": never shows " + other + "'s opinion");
  }
}

const [a, b] = keys;
assert.notEqual(rendered[a], rendered[b], "the two panels are not the same page under two names");

// The hidden heart is hers alone: no sibling's line ever appears on her panel.
for (const key of keys) {
  for (const other of keys) {
    if (other === key) continue;
    const theirs = plain(payloads[other].heart.line);
    assert.ok(!rendered[key].includes(theirs), key + ": never shows " + other + "'s hidden heart");
  }
}

// A bonded assistant shows her sentence and the rung of a pair she has lived;
// a fresh one says so plainly instead of inventing a link.
for (const key of keys) {
  const payload = payloads[key];
  const text = rendered[key];
  if (Number(payload.bond.days) >= 2) {
    assert.ok(text.includes(plain(payload.bond.line).replace(/^LIEN AU MAÎTRE — /, "")),
      key + ": shows her own bond sentence");
    assert.ok(!text.includes("aucun lien revendiqué"), key + ": does not claim to be a stranger");
  } else {
    // Under two days nothing about closeness is claimed — but the link is still
    // hers: her own wording for the stage she is at, and her real counts.
    const stageLine = plain(payload.bond.stage_line).replace(/^(LIEN AU MAÎTRE|BOND WITH THE MASTER) — /, "");
    assert.ok(stageLine && text.includes(stageLine), key + ": says where the link stands in her own words");
    assert.ok(text.includes(String(payload.bond.days) + " jour(s) distinct(s)"), key + ": states the real day count");
    if (payload.bond.line) {
      assert.ok(!text.includes(plain(payload.bond.line).replace(/^LIEN AU MAÎTRE — /, "")),
        key + ": does not borrow the closeness sentence it has not earned");
    }
  }
  // Every pair is on screen as itself: her line for the rung it reached, the real
  // counts, and no closeness sentence before two distinct days justify one.
  for (const row of payload.family) {
    const days = Number(row.days) || 0;
    assert.ok(text.includes(plain(row.other_name)), key + ": names " + row.other_name);
    assert.ok(text.includes(days + " jour(s) distinct(s)"), key + ": truthful day count for " + row.other_name);
    assert.ok(text.includes(plain(row.stage_label)), key + ": stage label for " + row.other_name);
    const stageLine = plain(row.stage_line || "");
    assert.ok(stageLine && text.includes(stageLine), key + ": own pair line for " + row.other_name);
    // The echo of the shared secret, where the API says it applies — and its own
    // wish must never be part of it.
    if (row.echo) {
      assert.ok(text.includes(plain(row.echo)), key + ": pair echo for " + row.other_name);
      for (const who of [key, row.other]) {
        const want = plain((payloads[who] && payloads[who].heart || {}).want || "");
        assert.ok(!want || !plain(row.echo).includes(want), key + ": echo must not carry a wish");
      }
    }
    if (days < 2) {
      assert.ok(!row.line, key + ": no closeness sentence before two days for " + row.other_name);
    } else {
      assert.ok(text.includes("habitude") || text.includes(plain(row.tier_label)), key + ": rung shown for " + row.other_name);
    }
  }
}

console.log("personhood panel: OK (" + keys.join(", ") + ")");
