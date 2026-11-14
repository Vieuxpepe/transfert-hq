// Drives the SSE reader Pistonia's chip uses (assets/hq-pistonia-stream.js) without a browser or a server: the same
// body split at every byte, the way a fetch stream really arrives, must always yield the same events in the same order.
// Used by tests/test_hq_pistonia_stream.py.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-pistonia-stream.js");

const DELTA = { type: "delta", text: "Bon" };
const DONE = { type: "done", ok: true, id: "msg-1", reply: "Bonjour", trace: [] };

function body(evs, sep = "\n\n") {
  return evs.map((e) => "data: " + JSON.stringify(e) + sep).join("");
}

// ---- one block at a time -----------------------------------------------------------------------------------------
assert.deepEqual(S.frame('data: {"type":"delta","text":"a"}'), { type: "delta", text: "a" });
assert.deepEqual(S.frame('data:{"type":"reset"}'), { type: "reset" }, "no space after the colon");
assert.deepEqual(S.frame('data: {"a":\ndata: 1}'), { a: 1 }, "two data lines join with a newline");
assert.equal(S.frame(": ping"), null, "a comment carries no data");
assert.equal(S.frame("event: done"), null, "an unknown field carries no data");
assert.equal(S.frame("data: {broken"), null, "a malformed payload is dropped, not thrown");
assert.equal(S.frame("data: [DONE]"), null, "[DONE] is not JSON we handle");
assert.equal(S.frame(""), null);

// ---- a whole body in one push ------------------------------------------------------------------------------------
let feed = new S.Feed();
assert.deepEqual(feed.push(body([DELTA, DONE])), [DELTA, DONE]);
assert.equal(feed.buf, "", "a complete body leaves nothing buffered");

// ---- the same body split at EVERY byte ---------------------------------------------------------------------------
// This is what a real stream does: the split can land inside "data:", inside the JSON, or between \r and \n.
const text = body([DELTA, { type: "delta", text: "jour" }, DONE]);
const flat = JSON.stringify([DELTA, { type: "delta", text: "jour" }, DONE]);
for (let cut = 1; cut < text.length; cut++) {
  feed = new S.Feed();
  const got = [...feed.push(text.slice(0, cut)), ...feed.push(text.slice(cut))];
  assert.deepEqual(got, JSON.parse(flat), "split at " + cut + " must give the same events");
}

// ---- one byte at a time ------------------------------------------------------------------------------------------
feed = new S.Feed();
const got = [];
for (const ch of text) got.push(...feed.push(ch));
assert.deepEqual(got, JSON.parse(flat), "byte-by-byte decoding must reassemble every event");

// ---- CRLF, including a split between \r and \n --------------------------------------------------------------------
const crlf = body([DELTA, DONE], "\r\n\r\n");
feed = new S.Feed();
assert.deepEqual(feed.push(crlf), [DELTA, DONE]);
const atCR = crlf.indexOf("\r");
feed = new S.Feed();
assert.deepEqual([...feed.push(crlf.slice(0, atCR + 1)), ...feed.push(crlf.slice(atCR + 1))], [DELTA, DONE],
  "a chunk ending on the \\r must wait for its \\n instead of splitting the event");

// ---- a half-received event is not emitted early ------------------------------------------------------------------
feed = new S.Feed();
assert.deepEqual(feed.push('data: {"type":"delta","text":"Bon"'), [], "no separator yet: nothing to emit");
assert.notEqual(feed.buf, "", "the tail stays buffered");
assert.deepEqual(feed.push('}'), [] , "still nothing without the blank line");
assert.deepEqual(feed.push("\n\n"), [DELTA], "the blank line completes it");

// ---- junk bytes between events do not derail the ones after -------------------------------------------------------
feed = new S.Feed();
assert.deepEqual(feed.push("data: {broken\n\ndata: {\"type\":\"reset\"}\n\n"), [{ type: "reset" }]);

// ---- an empty chunk (a keep-alive read) changes nothing ------------------------------------------------------------
feed = new S.Feed();
feed.push("data: {\"type\":");
assert.deepEqual(feed.push(""), []);
assert.deepEqual(feed.push('"reset"}\n\n'), [{ type: "reset" }]);

console.log("check_hq_pistonia_stream: ok");
