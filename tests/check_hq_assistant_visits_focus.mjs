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

console.log("check_hq_assistant_visits_focus: ok");
