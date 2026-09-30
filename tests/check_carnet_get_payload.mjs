// Feeds a REAL server GET payload (produced by hq_carnet.get_notebook, passed on stdin) to the browser
// state machine: every page must exist, text exact, editable. Used by tests/test_hq_carnet_rich.py.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../assets/hq-carnet.js");
const input = JSON.parse(readFileSync(0, "utf8")); // {notebook, texts:{id:text}}
const store = new Map();
const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const saves = [];
const core = C.createCore({
  request: (payload) => {
    saves.push(payload);
    return Promise.reject(Object.assign(new Error("offline"), {}));
  },
  fetchNotebook: () => Promise.resolve(JSON.parse(JSON.stringify(input.notebook))),
  drafts: C.createDraftStore(storage, "admin-test"),
  timers: { set: () => 1, clear: () => {} },
  now: () => 1,
  onChange: () => {},
});
await core.load();
const out = {};
for (const [id, text] of Object.entries(input.texts)) {
  const e = core.entry(id);
  assert.ok(e, "page exists after load: " + id);
  assert.equal(e.local.text, text, "text exact: " + id);
  assert.equal(core.libraryItems().some((x) => x.id === id), true);
  const lines = C.Rich.linesFromTextFmt(e.local.text, e.local.fmt, e.local.ids);
  const next = C.Rich.replaceRange(lines, text.length, text.length, "!").lines;
  assert.equal(core.edit(id, { text: C.Rich.flat(next), fmt: C.Rich.fmtOf(next), ids: C.Rich.idsOf(C.Rich.ensureKeys(next)) }), true, "editable: " + id);
  assert.equal(core.isDirty(e), true);
  out[id] = { pages: core.st.order.length, lines: lines.length };
}
console.log(JSON.stringify(out));
