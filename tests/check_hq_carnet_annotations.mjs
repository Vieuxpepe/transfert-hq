// Carnet product phase 10: annotations + Review Pack comments — pure client contract (no DOM, no network).
// Text rule parity with the server, identity-only targets (no client fingerprint), request bodies, answer wording, thread grouping,
// and the sink-free UI modules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const A = require("../assets/hq-carnet-annotations.js");

const SID = "srce-abc123";
const REQ = "a".repeat(32);
const RVW = "rvw-" + "0".repeat(24);
const ITEM = "ri-" + "1".repeat(16);
const cite = { src: SID, loc: { kind: "clause", text: "304.1.2" }, pdf: 417, ok: false, snap: { title: "Machinery" }, from: null };

// ---- body rule (same as the server)
assert.equal(A.BODY_MAX, 4000);
assert.ok(A.validateBody("ok").ok);
assert.ok(A.validateBody("ligne 1\nligne 2\tfin").ok, "newline and tab are allowed");
assert.ok(A.validateBody("x".repeat(4000)).ok);
assert.ok(A.validateBody("😀".repeat(4000)).ok, "4000 CODE POINTS, not UTF-16 units");
assert.ok(!A.validateBody("😀".repeat(4001)).ok);
assert.ok(!A.validateBody("x".repeat(4001)).ok);
for (const bad of ["", "  \n\t ", "a\u0000b", "a\u0007b", "a\rb", "a\u007fb", "a\u0085b", "\ud800", "x\udc00", 5, null, undefined, ["x"], {}]) assert.ok(!A.validateBody(bad).ok, JSON.stringify(bad));
assert.equal(A.validateBody("  gardé tel quel  ").text, "  gardé tel quel  ", "never trimmed or rewritten");
assert.equal(A.remaining("😀😀"), 3998);
assert.equal(A.codePoints("é😀"), 2);

// ---- request ids need a secure source
assert.match(A.newRequestId({ getRandomValues: (b) => b.fill(255) }), /^f{32}$/);
assert.throws(() => A.newRequestId(null));
assert.throws(() => A.newRequestId({}));

// ---- targets: ownership identity only; the server owns the fingerprint
assert.deepEqual(A.sourceTarget(SID), { kind: "source", source_id: SID });
assert.equal(A.sourceTarget("/etc/passwd"), null);
assert.equal(A.sourceTarget("srce-a/../b"), null);
assert.equal(A.sourceTarget(null), null);
const ct = A.citationTarget("page-abc", "block-def", cite);
assert.deepEqual(Object.keys(ct).sort(), ["block_id", "cite", "kind", "page_id"]);
assert.ok(!("citation_fingerprint" in ct), "the client never computes or sends a fingerprint for a new annotation");
assert.equal(A.citationTarget("../x", "block-def", cite), null);
assert.equal(A.citationTarget("page-abc", "block-\n", cite), null);
assert.equal(A.citationTarget("page-abc", "block-def", "x"), null);
assert.equal(A.targetKey({ kind: "source", source_id: SID }), "source:" + SID);
assert.equal(A.targetKey({ kind: "nope" }), "");

// ---- anchors are position, never identity
assert.deepEqual(A.anchorFor(417, "304.1.2"), { loc: "304.1.2", pdf: 417 });
assert.deepEqual(A.anchorFor(null, "x"), { loc: "x", pdf: null });
assert.deepEqual(A.anchorFor(3, null), { loc: null, pdf: 3 });
assert.equal(A.anchorFor(null, null), null);
assert.equal(A.anchorFor(0, ""), null);
assert.equal(A.anchorFor(100001, null), null);
assert.equal(A.anchorFor(1.5, null), null);
assert.equal(A.anchorFor(null, "a\nb"), null);
assert.equal(A.anchorFor(null, "x".repeat(121)), null);
assert.equal(A.anchorText({ loc: "304.1.2", pdf: 417 }), "304.1.2 · page PDF 417");

// ---- request bodies
const lb = A.listBody([{ kind: "source", source_id: SID }, { kind: "source", source_id: SID }, ct]);
assert.equal(lb.action, "annotation_list");
assert.equal(lb.targets.length, 2, "duplicates collapse");
assert.deepEqual(Object.keys(lb).sort(), ["action", "targets"]);
assert.equal(A.listBody([]), null);
assert.equal(A.listBody(Array.from({ length: 11 }, (_, i) => ({ kind: "source", source_id: "srce-" + i }))), null);
assert.equal(A.TARGETS_PER_LIST_MAX, 10);

const cb = A.createBody({ kind: "source", source_id: SID }, null, "note", REQ);
assert.deepEqual(Object.keys(cb).sort(), ["action", "anchor", "body", "request_id", "target"]);
assert.equal(A.createBody({ kind: "source", source_id: SID }, null, "", REQ), null);
assert.equal(A.createBody({ kind: "source", source_id: SID }, null, "x", "short"), null);
assert.equal(A.createBody(null, null, "x", REQ), null);
assert.ok(!("author" in cb) && !("user" in cb), "no author concept");

const rec = { id: "ann-" + "0".repeat(24), rev: 3, target: { kind: "source", source_id: SID } };
const ub = A.updateBody(rec, { body: "nouveau" });
assert.equal(ub.expected_rev, 3, "every mutation carries the revision the person saw");
assert.deepEqual(Object.keys(ub).sort(), ["action", "body", "expected_rev", "id", "target"]);
assert.equal(A.updateBody(rec, { status: "resolved" }).status, "resolved");
assert.equal(A.updateBody(rec, { status: "weird" }), null);
assert.equal(A.updateBody(rec, {}), null);
assert.equal(A.updateBody(rec, { body: "" }), null);
assert.equal(A.updateBody({ ...rec, rev: 0 }, { body: "x" }), null);
assert.equal(A.updateBody({ ...rec, rev: undefined }, { body: "x" }), null);

assert.equal(A.deleteBody(rec, false), null, "delete needs an explicit confirmation");
assert.equal(A.deleteBody(rec), null);
const db = A.deleteBody(rec, true);
assert.deepEqual([db.action, db.confirm, db.expected_rev], ["annotation_delete", true, 3]);

// ---- review comments are a different object with a different action
const rb = A.commentBody(RVW, ITEM, "texte", REQ, null);
assert.deepEqual(Object.keys(rb).sort(), ["action", "body", "item_id", "request_id", "review_id", "supersedes"]);
assert.equal(rb.action, "rcomment_add");
assert.equal(rb.supersedes, null);
assert.equal(A.commentBody(RVW, ITEM, "texte", REQ, "rcm-" + "2".repeat(16)).supersedes, "rcm-" + "2".repeat(16));
assert.equal(A.commentBody(RVW, ITEM, "texte", REQ, "rc-" + "2".repeat(16)), null, "a checklist id is not a comment id");
assert.equal(A.commentBody("../x", ITEM, "t", REQ, null), null);
assert.equal(A.commentBody(RVW, "ri-xyz", "t", REQ, null), null);
assert.equal(A.commentBody(RVW, ITEM, "", REQ, null), null);
assert.equal(A.commentListBody(RVW).action, "rcomment_list");
assert.equal(A.commentListBody("nope"), null);
assert.ok(!Object.values(A.commentBody(RVW, ITEM, "t", REQ, null)).some((v) => v && typeof v === "object"), "no evidence is copied into a comment");

// ---- wording: states are never guessed
assert.deepEqual(Object.keys(A.CITATION_STATE).sort(), ["changed_or_removed", "unavailable", "unchanged"]);
assert.match(A.targetStateText({ target: { kind: "citation" }, target_state: "changed_or_removed" }), /modifiée ou retirée/);
assert.match(A.targetStateText({ target: { kind: "source" }, target_state: "archived" }), /archivée/);
assert.notEqual(A.targetStateText({ target: { kind: "source" }, target_state: "unknown" }), A.targetStateText({ target: { kind: "source" }, target_state: "missing" }), "unknown is not missing");
assert.equal(A.targetStateText({ target: { kind: "source" }, target_state: "???" }), "");
assert.equal(A.identicalNote({ identical_count: 2 }), "2 citations identiques dans ce bloc");
assert.equal(A.identicalNote({ identical_count: 1 }), "");
assert.equal(A.identicalNote({ identical_count: null }), "");
assert.match(A.MSG.frozenHeading, /non incluses dans la preuve figée/);

const e409 = A.errorInfo({ status: 409, data: { code: "annotation_conflict", current_rev: 4, error: "x" } });
assert.deepEqual([e409.conflict, e409.currentRev, e409.definite], [true, 4, true]);
assert.equal(A.errorInfo(new Error("network")).definite, false, "a bare network error is not a known outcome: the retry reuses the request id");
assert.ok(A.errorInfo({ data: { code: "annotation_limit" } }).full);
assert.ok(A.errorInfo({ data: { code: "review_comment_corrupt" } }).corrupt);

// ---- thread grouping: removed items keep their captured identity
const mk = (id, item, present) => ({ id, body: id, item: { item_id: item, item_kind: "source", item_label: "L" + item, item_fingerprint: "f".repeat(64) }, item_present: present, supersedes: null });
const g = A.groupThread({ comments: [mk("rcm-1", "ri-a", true), mk("rcm-2", "ri-b", false), mk("rcm-3", "ri-a", true), mk("rcm-4", "ri-b", false)] }, ["ri-a"]);
assert.deepEqual(g.byItem("ri-a").map((c) => c.id), ["rcm-1", "rcm-3"]);
assert.deepEqual(g.byItem("ri-zzz"), []);
assert.equal(g.removed.length, 1);
assert.equal(g.removed[0].item_id, "ri-b");
assert.equal(g.removed[0].comments.length, 2);
assert.equal(g.count, 4);
assert.equal(A.groupThread(null).count, 0);

// ---- UI modules are sink-free
for (const f of ["../assets/hq-carnet-annotations.js", "../assets/hq-carnet-annotations-ui.js"]) {
  const src = readFileSync(new URL(f, import.meta.url), "utf8");
  for (const needle of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /localStorage/, /sessionStorage/, /indexedDB/, /fetch\(/, /XMLHttpRequest/, /sendBeacon/, /Math\.random/, /Date\.now|new Date\(\)/]) assert.ok(!needle.test(src), f + " " + needle);
}
const ui = readFileSync(new URL("../assets/hq-carnet-annotations-ui.js", import.meta.url), "utf8");
assert.ok(/textContent|text:/.test(ui));
assert.ok(!/setAttribute\("(src|href|srcdoc)"/.test(ui));
const reviewsUi = readFileSync(new URL("../assets/hq-carnet-reviews-ui.js", import.meta.url), "utf8");
assert.ok(!/innerHTML/.test(reviewsUi));
console.log("annotations client checks ok");
