// Carnet product phase 11: verifications — pure client contract (no DOM, no network).
// Text rule parity with the server, identity-only refs (no client fingerprint), request bodies (verified is NEVER requestable by status),
// grouping / client-side filters, wording (procedural, no identity, no conclusion), error mapping and the sink-free UI modules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const V = require("../assets/hq-carnet-verifications.js");

const SID = "srce-abc123";
const REQ = "a".repeat(32);
const VID = "ver-" + "0".repeat(24);
const EVID = "ve-" + "1".repeat(16);
const RVW = "rvw-" + "0".repeat(24);
const ITEM = "ri-" + "1".repeat(16);
const cite = { src: SID, loc: { kind: "clause", text: "304.1.2" }, pdf: 417, ok: false, snap: { title: "Machinery" }, from: null };
const rec = (over) => Object.assign({ id: VID, rev: 3, verification_fingerprint: "f".repeat(64) }, over);

// ---- text rule (same as the server)
assert.equal(V.TEXT_MAX, 4000);
assert.ok(V.validateText("ok", true).ok);
assert.ok(V.validateText("ligne 1\nligne 2\tfin", true).ok);
assert.ok(V.validateText("😀".repeat(4000), true).ok, "4000 CODE POINTS");
assert.ok(!V.validateText("😀".repeat(4001), true).ok);
for (const bad of ["", "  \n ", "a\u0000b", "a\u0007b", "a\rb", "a\u007fb", "a\u0085b", "\ud800", "x\udc00", 5, null, undefined, ["x"], {}]) assert.ok(!V.validateText(bad, true).ok, JSON.stringify(bad));
assert.deepEqual(V.validateText("", false), { ok: true, text: "" }, "a note may be cleared");
assert.deepEqual(V.validateText("  \n", false), { ok: true, text: "" });
assert.ok(!V.validateText("a\u0000", false).ok);
assert.equal(V.validateText("  gardé tel quel  ", true).text, "  gardé tel quel  ", "never trimmed or rewritten");
assert.equal(V.remaining("😀😀"), 3998);

// ---- request ids need a secure source
assert.match(V.newRequestId({ getRandomValues: (b) => b.fill(255) }), /^f{32}$/);
assert.throws(() => V.newRequestId(null));
assert.throws(() => V.newRequestId({}));

// ---- identities: the client LOCATES, the server completes / fingerprints
assert.deepEqual(V.ref.source(SID), { kind: "source", source_id: SID });
assert.equal(V.ref.source("/etc/passwd"), null);
assert.deepEqual(V.ref.page("page-abc"), { kind: "page", page_id: "page-abc" });
assert.deepEqual(V.ref.block("page-abc", "block-def"), { kind: "block", page_id: "page-abc", block_id: "block-def" });
assert.equal(V.ref.block("page-abc", "block-\n"), null);
assert.deepEqual(V.ref.drawing("plan-1"), { kind: "drawing", stem: "plan-1" });
assert.equal(V.ref.drawing("../x"), null);
assert.equal(V.ref.drawing(".hidden"), null);
assert.deepEqual(V.ref.snapshot("snap-" + "a".repeat(24)), { kind: "snapshot", snapshot_id: "snap-" + "a".repeat(24) });
assert.equal(V.ref.snapshot("snap-xyz"), null);
const ri = V.ref.reviewItem(RVW, ITEM);
assert.deepEqual(ri, { kind: "review_item", review_id: RVW, item_id: ITEM });
assert.ok(!("item_fingerprint" in ri), "the client never supplies a review item fingerprint");
assert.equal(V.ref.reviewItem(RVW, "x"), null);
const ct = V.ref.citation("page-abc", "block-def", cite);
assert.deepEqual(Object.keys(ct).sort(), ["block_id", "cite", "kind", "page_id"]);
assert.ok(!("citation_fingerprint" in ct), "the client never computes a citation fingerprint");
assert.equal(V.ref.citation("../x", "block-def", cite), null);
assert.equal(V.ref.citation("page-abc", "block-def", "x"), null);
assert.equal(V.refKey({ kind: "source", source_id: SID }), "source:" + SID);
assert.equal(V.refKey({ kind: "review_item", review_id: RVW, item_id: ITEM, item_fingerprint: "a".repeat(64) }), "review_item:" + RVW + ":" + ITEM, "related by ids, not by fingerprint");
assert.equal(V.refKey({ kind: "nope" }), "");
for (const k of V.KINDS) assert.ok(V.KIND_LABEL[k], k);

// ---- request bodies
assert.deepEqual(V.listBody({}), { action: "verification_list" });
assert.deepEqual(V.listBody({ status: "ready", target_kind: "drawing", project_id: "proj-a" }), { action: "verification_list", project_id: "proj-a", status: "ready", target_kind: "drawing" });
assert.equal(V.listBody({ status: "done" }), null);
assert.equal(V.listBody({ target_kind: "task" }), null);
assert.deepEqual(V.getBody(VID), { action: "verification_get", id: VID });
assert.equal(V.getBody("ver-x"), null);
assert.deepEqual(V.resolveBody(VID), { action: "verification_resolve", id: VID });
assert.deepEqual(V.resolveBody([VID, VID]), { action: "verification_resolve", ids: [VID] }, "batched form, duplicates collapsed");
assert.equal(V.resolveBody([]), null);
assert.equal(V.resolveBody(Array.from({ length: 26 }, (_, i) => "ver-" + String(i).padStart(24, "0"))), null);
assert.equal(V.relatedBody([]), null);
assert.equal(V.relatedBody(Array.from({ length: 11 }, (_, i) => V.ref.page("page-" + i))), null);
assert.equal(V.relatedBody([V.ref.page("page-a"), V.ref.page("page-a")]).targets.length, 1);
const cb = V.createBody(V.ref.block("page-a", "block-b"), "Question ?", REQ, "proj-a");
assert.deepEqual(Object.keys(cb).sort(), ["action", "project_id", "question", "request_id", "target"]);
assert.equal(V.createBody(V.ref.block("page-a", "block-b"), "  ", REQ), null);
assert.equal(V.createBody(V.ref.block("page-a", "block-b"), "Q", "short"), null);
assert.equal(V.createBody(null, "Q", REQ), null);
for (const k of ["assignee", "due", "priority", "author", "signed_by", "user"]) assert.ok(!(k in cb), k);
assert.deepEqual(V.updateBody(rec(), { note: "n" }), { action: "verification_update", id: VID, expected_rev: 3, note: "n" });
assert.deepEqual(V.updateBody(rec(), { note: "" }), { action: "verification_update", id: VID, expected_rev: 3, note: "" });
assert.equal(V.updateBody(rec(), { question: "" }), null);
assert.equal(V.updateBody(rec(), {}), null);
assert.equal(V.updateBody({ id: VID }, { note: "x" }), null);
assert.equal(V.updateBody(rec(), { target: { kind: "page" } }) , null, "there is no change-target mutation");
assert.deepEqual(V.evidenceAddBody(rec(), V.ref.source(SID)), { action: "verification_evidence_add", id: VID, expected_rev: 3, ref: { kind: "source", source_id: SID } });
assert.equal(V.evidenceAddBody(rec(), null), null);
assert.deepEqual(V.evidenceRemoveBody(rec(), EVID), { action: "verification_evidence_remove", id: VID, expected_rev: 3, evidence_id: EVID });
assert.equal(V.evidenceRemoveBody(rec(), "ve-x"), null);
assert.deepEqual(V.statusBody(rec(), "ready"), { action: "verification_status", id: VID, expected_rev: 3, status: "ready" });
assert.deepEqual(V.statusBody(rec(), "open"), { action: "verification_status", id: VID, expected_rev: 3, status: "open" });
assert.equal(V.statusBody(rec(), "verified"), null, "verified is reachable ONLY through the signoff action");
assert.equal(V.statusBody(rec(), "done"), null);
assert.equal(V.statusBody(rec(), "needs_followup", ""), null, "a follow-up reason is required");
assert.equal(V.statusBody(rec(), "needs_followup", "  "), null);
assert.equal(V.statusBody(rec(), "needs_followup", "x".repeat(4001)), null);
assert.deepEqual(V.statusBody(rec(), "needs_followup", "Mesurer encore"), { action: "verification_status", id: VID, expected_rev: 3, status: "needs_followup", followup_note: "Mesurer encore" });
assert.ok(!("followup_note" in V.statusBody(rec(), "open")));
const sb = V.signoffBody(rec(), REQ);
assert.deepEqual(sb, { action: "verification_signoff", id: VID, expected_rev: 3, request_id: REQ, verification_fingerprint: "f".repeat(64) }, "echoes the SERVER's own fingerprint, never one computed here");
assert.ok(!("verification_fingerprint" in V.signoffBody({ id: VID, rev: 1 }, REQ)));
assert.equal(V.signoffBody(rec(), "bad"), null);
assert.equal(V.deleteBody(rec(), false), null);
assert.equal(V.deleteBody(rec(), undefined), null);
assert.deepEqual(V.deleteBody(rec(), true), { action: "verification_delete", id: VID, expected_rev: 3, confirm: true });

// ---- wording: procedural, prefixed, no identity, no conclusion
assert.equal(V.statusText("needs_followup"), "Vérification : À reprendre");
assert.equal(V.statusText("verified"), "Vérification : Vérifiée");
assert.equal(V.summaryText({ open: 2, verified: 1 }), "2 ouvertes · 1 vérifiée");
assert.equal(V.summaryText({ open: 1, ready: 1, needs_followup: 3, verified: 2 }), "1 ouverte · 1 prête à vérifier · 3 à reprendre · 2 vérifiées");
assert.equal(V.summaryText({}), "Aucune vérification");
assert.equal(V.MSG.disclosure, "Vérification enregistrée localement ; aucune identité de relecteur authentifiée n'est associée.");
assert.equal(V.MSG.unavailable, "Impossible d'enregistrer la vérification : certaines preuves ne peuvent pas être vérifiées actuellement.");
assert.equal(V.MSG.verifiedChanged, "Vérification enregistrée — les preuves actuelles ont changé depuis.");
assert.equal(V.overallText("changed"), V.MSG.verifiedChanged);
assert.equal(V.overallText("unchanged"), V.MSG.verifiedUnchanged);
assert.equal(V.overallText("corrupt"), V.MSG.verifiedCorrupt);
assert.equal(V.overallText(null), V.MSG.verifiedUnknown);
assert.match(V.MSG.frozenHeading, /créé après les preuves figées/);
const all = JSON.stringify(V.MSG) + JSON.stringify(V.FRESH_LABEL) + JSON.stringify(V.STATUS_LABEL);
for (const banned of [/conforme/i, /approuv/i, /Requirement satisfied/, /Compliance/i, /Design approved/, /signé par/i, /signed by/i, /responsable/i, /\bassign/i, /échéance/i, /priorité/i]) assert.ok(!banned.test(all), String(banned));
for (const s of V.STATUSES) assert.ok(V.STATUS_LABEL[s], s);
for (const s of ["unchanged", "changed", "changed_or_removed", "missing", "unavailable", "unknown", "corrupt", "integrity_anomaly", "added_since"]) assert.ok(V.freshText(s), s);
assert.equal(V.freshText("???"), "");
assert.equal(V.existsText("archived"), "Archivée");

// ---- grouping and client-side filters (loaded rows only)
const rows = [
  { id: "ver-1", status: "verified", question: "Palier H7 ?", target: { kind: "block" }, project_id: "proj-a", integrity: "ok" },
  { id: "ver-2", status: "open", question: "Joint torique ?", target: { kind: "drawing" }, project_id: "proj-b", integrity: "ok" },
  { id: "ver-3", status: "needs_followup", question: "Épaisseur ?", target: { kind: "source" }, project_id: "proj-a", integrity: "ok" },
  { id: "ver-4", status: "ready", question: "Tolérance H7", target: { kind: "block" }, project_id: "proj-a", integrity: "ok" },
  { id: "ver-5", status: null, question: "", target: null, project_id: null, integrity: "invalid" },
];
const g = V.group(rows);
assert.deepEqual(g.groups.map((x) => x.label), ["Ouvertes", "Prêtes à vérifier", "À reprendre", "Vérifiées"]);
assert.deepEqual(g.groups.map((x) => x.rows.map((r) => r.id)), [["ver-2"], ["ver-4"], ["ver-3"], ["ver-1"]]);
assert.deepEqual(g.other.map((r) => r.id), ["ver-5"], "an untrusted row has no status and is listed apart");
assert.deepEqual(V.filterRows(rows, { project_id: "proj-a" }).map((r) => r.id), ["ver-1", "ver-3", "ver-4"]);
assert.deepEqual(V.filterRows(rows, { status: "open" }).map((r) => r.id), ["ver-2"]);
assert.deepEqual(V.filterRows(rows, { target_kind: "block" }).map((r) => r.id), ["ver-1", "ver-4"]);
assert.deepEqual(V.filterRows(rows, { text: "  h7 " }).map((r) => r.id), ["ver-1", "ver-4"], "case-insensitive substring over the loaded questions only");
assert.deepEqual(V.filterRows(rows, { freshness: "changed" }, {}).map((r) => r.id), [], "no freshness is known until it is evaluated: nothing matches, nothing is guessed");
assert.deepEqual(V.filterRows(rows, { freshness: "changed" }, { "ver-1": "changed", "ver-3": "unchanged" }).map((r) => r.id), ["ver-1"]);
assert.equal(V.filterRows(rows, {}).length, 5);

// ---- error mapping
const e1 = V.errorInfo({ status: 409, data: { code: "verification_conflict", error: "x", current_rev: 7 } });
assert.deepEqual([e1.conflict, e1.currentRev, e1.definite], [true, 7, true]);
assert.equal(V.errorInfo({ status: 409, data: { code: "verification_evidence_unavailable", entries: [{ role: "target", state: "missing" }] } }).message, V.MSG.unavailable);
assert.equal(V.errorInfo({ status: 409, data: { code: "verification_evidence_unavailable", entries: [{ role: "target", state: "missing" }] } }).entries.length, 1);
assert.equal(V.errorInfo({ status: 409, data: { code: "verification_capture_race" } }).message, V.MSG.signoffRace);
assert.equal(V.errorInfo({ status: 409, data: { code: "verification_has_signoff" } }).message, V.MSG.hasSignoff);
assert.equal(V.errorInfo({ status: 409, data: { code: "verification_state_invalid" } }).message, V.MSG.stateInvalid);
assert.equal(V.errorInfo({ status: 409, data: { code: "verification_corrupt" } }).corrupt, true);
assert.equal(V.errorInfo({ status: 409, data: { code: "verification_limit" } }).full, true);
assert.equal(V.errorInfo(new Error("network")).definite, false, "a bare network error is not a known outcome: the retry reuses the same request id");
assert.notEqual(V.errorInfo(null).message, "Erreur", "Phase 13: never the bare word");
assert.match(V.errorInfo(null).message, /rien n.est confirmé/, "typed fallback, not a generic word");

// ---- UI modules are sink-free
for (const f of ["../assets/hq-carnet-verifications.js", "../assets/hq-carnet-verifications-ui.js"]) {
  const src = readFileSync(new URL(f, import.meta.url), "utf8");
  for (const needle of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /localStorage/, /sessionStorage/, /indexedDB/, /fetch\(/, /XMLHttpRequest/, /sendBeacon/, /Math\.random/, /Date\.now|new Date\(\)/]) assert.ok(!needle.test(src), f + " " + needle);
  for (const k of ["signed_by", "author", "username", "assignee", "due_at", "priority"]) assert.ok(!src.includes('"' + k + '"') && !src.includes(k + ":"), f + " " + k);
}
const ui = readFileSync(new URL("../assets/hq-carnet-verifications-ui.js", import.meta.url), "utf8");
assert.ok(/textContent|text:/.test(ui));
assert.ok(!/setAttribute\("(src|href|srcdoc)"/.test(ui));
assert.ok(!/statusBody\([^)]*"verified"/.test(ui), "the UI never asks for status verified");
assert.ok(/signoffBody/.test(ui) && /M\.open\(/.test(ui), "signoff goes through its own action; the workspace uses the shared modal");
const model = readFileSync(new URL("../assets/hq-carnet-verifications.js", import.meta.url), "utf8");
assert.ok(!/require\(["']\.\/hq-carnet-(ask|history|sources)/.test(model + ui));
console.log("verifications client checks ok");
