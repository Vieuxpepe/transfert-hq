// Carnet product phase 8: portal blocks — pure client contract (no DOM, no network).
// Covers the strict schema mirror (hq-carnet-struct.js), the batching / dedup wire shape and the strict row sanitizer
// (hq-carnet-portals.js), the "Dernier état chargé" wording, and that the UI modules have no dangerous sinks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const S = require("../assets/hq-carnet-struct.js");
const P = require("../assets/hq-carnet-portals.js");
const okRef = (r) => /^Inbox\/[A-Za-z0-9_./ -]+$/.test(r.id) && !r.id.includes("..");

// ---- schema mirror
const good = { ref: { kind: "source", id: "srce-abc123" }, view: "card" };
assert.deepEqual(S.checkPortal(good, okRef), good);
for (const [k, id] of [["snapshot", "snap-" + "0".repeat(24)], ["review", "rvw-" + "0".repeat(24)]]) assert.ok(S.checkPortal({ ref: { kind: k, id }, view: "compact" }, okRef), k);
assert.ok(S.checkPortal({ ref: { kind: "file", id: "Inbox/Docs/a.pdf" }, view: "card" }, okRef));
assert.equal(S.checkPortal({ ref: { kind: "file", id: "../etc/passwd" }, view: "card" }, okRef), null, "path escape refused by the injected ref check");
assert.equal(S.checkPortal({ ref: { kind: "file", id: "Inbox/a.pdf" }, view: "card" }, null), null, "file refs need the ref checker");
for (const kind of ["drawing", "note", "project", "page", ""]) assert.equal(S.checkPortal({ ref: { kind, id: "x" }, view: "card" }, okRef), null, "kind refused: " + kind);
assert.equal(S.checkPortal({ ref: good.ref, view: "huge" }, okRef), null);
assert.equal(S.checkPortal({ ref: good.ref, view: "card", title: "cached" }, okRef), null, "no cached title");
assert.equal(S.checkPortal({ ref: { kind: "source", id: "srce-abc", extra: 1 }, view: "card" }, okRef), null);
assert.equal(S.PORTALS_PER_PAGE_MAX, 100);
assert.equal(S.portalLabel(good), "[Portail Source : srce-abc123]");
assert.deepEqual(S.searchStrings("portal", good), ["Portail", "Source", "srce-abc123"]);

// ---- request shape
const many = [];
for (let i = 0; i < 250; i += 1) many.push({ ref: { kind: "file", id: "Inbox/f" + (i % 150) + ".pdf" }, view: "card" });
const uniq = P.uniqueRefs(many);
assert.equal(uniq.length, 150, "duplicates collapse");
const bodies = P.batchBodies(uniq);
assert.deepEqual(bodies.map((b) => b.refs.length), [100, 50]);
assert.ok(bodies.every((b) => Object.keys(b).sort().join() === "action,refs" && b.action === "portal_resolve"));
assert.deepEqual(P.uniqueRefs([{ ref: { kind: "drawing", id: "x" } }, null, { ref: { kind: "file" } }]), [], "off-schema refs never go on the wire");

// ---- row sanitizer: a malformed answer is "unknown" for the STORED reference
const ref = { kind: "source", id: "srce-abc" };
for (const bad of [null, "x", {}, { ref, state: "weird" }, { ref: { kind: "source", id: "srce-OTHER" }, state: "available" }]) {
  const row = P.sanitizeRow(bad, ref);
  assert.equal(row.state, "unknown");
  assert.deepEqual(row.ref, ref);
}
const row = P.sanitizeRow({ ref, state: "available", state_label: "Disponible", title: "<script>x</script>", subtitle: "s", metadata: [{ label: "A", value: 5, type: "bytes" }, { nope: 1 }], actions: ["open", "delete"], thumb_url: "https://evil/x.png", open_url: "/files/a" }, ref);
assert.equal(row.title, "<script>x</script>", "text is kept as text");
assert.deepEqual(row.actions, ["open"], "unknown actions dropped");
assert.equal(row.thumb_url, null, "only same-origin /files/ thumbnails");
assert.equal(row.open_url, "/files/a");
assert.equal(row.metadata.length, 1);
const long = P.sanitizeRow({ ref, state: "available", title: "x".repeat(1000) }, ref);
assert.equal(long.title.length, 240);

// ---- response correspondence is by identity, not position
const refs = [{ kind: "file", id: "Inbox/a.pdf" }, { kind: "file", id: "Inbox/b.pdf" }];
const rows = P.rowsFor(refs, { results: [{ ref: refs[1], state: "missing" }, { ref: refs[0], state: "available" }] });
assert.deepEqual(rows.map((r) => r.state), ["available", "missing"]);
assert.equal(P.rowsFor(refs, null)[0].state, "unknown");

// ---- card model: never falsely fresh
const payload = { ref: refs[0], view: "card" };
assert.equal(P.cardModel(payload, null, {}).state, "loading");
assert.equal(P.cardModel(payload, null, { failed: true }).state, "unknown");
const fresh = P.cardModel(payload, rows[0], {});
assert.equal(fresh.stateLabel, "Disponible");
const stale = P.cardModel(payload, rows[0], { stale: true });
assert.ok(stale.stateLabel.startsWith("Dernier état chargé"), stale.stateLabel);
assert.equal(P.cardModel({ ref: refs[0], view: "compact" }, rows[0], {}).metadata.length, 0);

// ---- no dangerous sinks in the new UI modules
for (const f of ["../assets/hq-carnet-portals.js", "../assets/hq-carnet-portals-ui.js"]) {
  const t = readFileSync(new URL(f, import.meta.url), "utf8");
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "localStorage", "sessionStorage", "iframe", "srcdoc"]) assert.ok(!t.includes(bad), f + " must not use " + bad);
}
console.log("check_hq_carnet_portals: ok");
