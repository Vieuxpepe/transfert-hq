// Carnet product phase 12: decisions & assumptions register — pure client contract (no DOM, no network).
// Text rule parity with the server, namespaced kinds (never the bare word "decision"), identity-only refs, request bodies (superseded is NEVER requestable by
// status; supersession has its own action), legal targets per kind, delete gating, grouping / filters, wording (procedural, non-evaluative), error mapping and
// the sink-free UI modules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const R = require("../assets/hq-carnet-reasoning.js");

const DID = "dec-" + "0".repeat(24);
const AID = "asm-" + "1".repeat(24);
const VID = "ver-" + "2".repeat(24);
const EVID = "re-" + "3".repeat(16);
const REQ = "a".repeat(32);
const PROJ = "proj-abc123";
const SID = "srce-abc123";
const rec = (over) => Object.assign({ id: DID, kind: R.KIND_DECISION, rev: 3, integrity: "ok", status: "active", effective_status: "active", project_id: PROJ, statement: "x", rationale: "", evidence: [], verification_ids: [], history: [], supersedes: null, superseded_by: null }, over);
const asm = (over) => rec(Object.assign({ id: AID, kind: R.KIND_ASSUMPTION }, over));

// ---- namespacing: the bare word is never a kind here
assert.deepEqual(R.KINDS, ["reasoning_decision", "reasoning_assumption"]);
assert.ok(!R.KINDS.includes("decision") && !R.KINDS.includes("assumption"));
assert.equal(R.listBody({ kind: "decision" }), null);
assert.equal(R.createBody("decision", PROJ, "x", "", REQ), null);
assert.equal(R.createBody("assumption", PROJ, "x", "", REQ), null);
assert.deepEqual(R.STATUSES.reasoning_decision, ["active", "superseded", "withdrawn"]);
assert.deepEqual(R.STATUSES.reasoning_assumption, ["active", "confirmed", "invalidated", "retired", "superseded"]);
for (const banned of ["approved", "verified", "compliant", "safe"]) assert.ok(!R.ALL_STATUSES.includes(banned), banned);

// ---- text rules (same as the server): statement 4000, rationale 8000 CODE POINTS
assert.equal(R.STATEMENT_MAX, 4000);
assert.equal(R.RATIONALE_MAX, 8000);
assert.ok(R.validateStatement("😀".repeat(4000)).ok);
assert.ok(!R.validateStatement("😀".repeat(4001)).ok);
assert.ok(R.validateRationale("😀".repeat(8000)).ok);
assert.ok(!R.validateRationale("😀".repeat(8001)).ok);
for (const bad of ["", "  \n ", "a\u0000b", "a\u0007b", "a\rb", "a\u007fb", "a\u0085b", "\ud800", "x\udc00", 5, null, undefined, ["x"], {}]) assert.ok(!R.validateStatement(bad).ok, JSON.stringify(bad));
assert.deepEqual(R.validateRationale(""), { ok: true, text: "" }, "a rationale may be empty");
assert.equal(R.validateStatement("  gardé tel quel  ").text, "  gardé tel quel  ", "never trimmed or rewritten");
assert.equal(R.remaining("😀😀"), 3998);
assert.equal(R.remaining("😀😀", R.RATIONALE_MAX), 7998);

// ---- request ids need a secure source
assert.match(R.newRequestId({ getRandomValues: (b) => b.fill(255) }), /^f{32}$/);
assert.throws(() => R.newRequestId(null));
assert.throws(() => R.newRequestId({}));

// ---- identities
assert.deepEqual(R.ref.source(SID), { kind: "source", source_id: SID });
assert.equal(R.ref.source("/etc/passwd"), null);
assert.equal(R.ref.page("x"), null);
assert.equal(R.ref.citation("page-a", "block-b", "notobject"), null);
assert.deepEqual(R.EVIDENCE_KINDS, ["page", "block", "source", "citation", "drawing", "snapshot", "review_item"]);
for (const k of ["verification", "review_comment", "decision", "measurement", "reasoning_decision"]) assert.ok(!R.EVIDENCE_KINDS.includes(k), "never evidence: " + k);

// ---- request bodies
assert.deepEqual(R.listBody({ project_id: PROJ, kind: R.KIND_ASSUMPTION, status: "supersession_pending" }), { action: "reasoning_list", project_id: PROJ, kind: "reasoning_assumption", status: "supersession_pending" });
assert.equal(R.listBody({ status: "approved" }), null);
assert.equal(R.listBody({ project_id: "../x" }), null);
assert.deepEqual(R.getBody(DID), { action: "reasoning_get", id: DID });
assert.equal(R.getBody("ver-" + "0".repeat(24)), null);
assert.deepEqual(R.resolveBody(DID), { action: "reasoning_resolve", id: DID });
assert.deepEqual(R.resolveBody([DID, AID, DID]), { action: "reasoning_resolve", ids: [DID, AID] });
assert.equal(R.resolveBody(Array.from({ length: 26 }, (_, i) => "dec-" + String(i).padStart(24, "0"))), null);
assert.equal(R.resolveBody([]), null);
assert.equal(R.relatedBody([]), null);
assert.equal(R.relatedBody(Array.from({ length: 11 }, (_, i) => ({ kind: "page", page_id: "page-" + i }))), null);
assert.equal(R.relatedBody([{ kind: "page", page_id: "page-a" }, { kind: "page", page_id: "page-a" }]).targets.length, 1, "deduplicated");

const c = R.createBody(R.KIND_DECISION, PROJ, "Choix", "Parce que", REQ);
assert.deepEqual(c, { action: "reasoning_create", request_id: REQ, kind: "reasoning_decision", project_id: PROJ, statement: "Choix", rationale: "Parce que" });
assert.ok(!("evidence" in c), "no evidence key unless attached");
const withEv = R.createBody(R.KIND_ASSUMPTION, PROJ, "Hyp", "", REQ, [{ kind: "source", source_id: SID }]);
assert.deepEqual(withEv.evidence, [{ kind: "source", source_id: SID }]);
assert.equal(R.createBody(R.KIND_DECISION, "", "x", "", REQ), null, "project is required");
assert.equal(R.createBody(R.KIND_DECISION, PROJ, "", "", REQ), null);
assert.equal(R.createBody(R.KIND_DECISION, PROJ, "x", "", "short"), null);
assert.equal(R.createBody(R.KIND_DECISION, PROJ, "x", "", REQ, new Array(11).fill({ kind: "page", page_id: "page-a" })), null);
for (const extra of ["supersedes", "status", "author", "confidence"]) assert.ok(!(extra in c), extra);

assert.deepEqual(R.updateBody(rec(), { statement: "n" }), { action: "reasoning_update", id: DID, expected_rev: 3, statement: "n" });
assert.equal(R.updateBody(rec(), {}), null);
assert.equal(R.updateBody(rec(), { statement: "" }), null);
assert.equal(R.updateBody(rec({ rev: 0 }), { statement: "n" }), null);
assert.deepEqual(R.evidenceAddBody(rec(), { kind: "page", page_id: "page-a" }).action, "reasoning_evidence_add");
assert.equal(R.evidenceRemoveBody(rec(), "nope"), null);
assert.equal(R.evidenceRemoveBody(rec(), EVID).evidence_id, EVID);
assert.equal(R.linkBody(rec(), VID).verification_id, VID);
assert.equal(R.linkBody(rec(), "x"), null);
assert.equal(R.unlinkBody(rec(), VID).action, "reasoning_verification_unlink");

// ---- statuses: explicit, legal targets per kind; "superseded" is never a status request; no reopen
assert.deepEqual(R.targetsFor(rec()), ["withdrawn"]);
assert.deepEqual(R.targetsFor(asm()), ["confirmed", "invalidated", "retired"]);
assert.deepEqual(R.targetsFor(asm({ status: "confirmed", effective_status: "confirmed" })), ["invalidated", "retired"]);
for (const s of ["invalidated", "retired", "superseded", "withdrawn"]) assert.deepEqual(R.targetsFor(asm({ status: s, effective_status: s })), [], s);
for (const s of ["withdrawn", "superseded"]) assert.deepEqual(R.targetsFor(rec({ status: s, effective_status: s })), [], s);
assert.deepEqual(R.targetsFor(asm({ integrity: "corrupt" })), []);
assert.deepEqual(R.targetsFor(asm({ effective_status: "supersession_pending" })), []);
assert.deepEqual(R.targetsFor(asm({ effective_status: "supersession_indeterminate" })), []);
assert.equal(R.statusBody(asm(), "superseded"), null);
assert.equal(R.statusBody(asm(), "active"), null);
assert.equal(R.statusBody(asm(), "approved"), null);
assert.equal(R.statusBody(rec(), "confirmed"), null, "a decision cannot be confirmed");
assert.equal(R.statusBody(asm(), "confirmed").status, "confirmed");
assert.equal(R.statusBody(rec(), "withdrawn").expected_rev, 3);
assert.equal(R.statusBody(asm({ status: "retired", effective_status: "retired" }), "confirmed"), null, "no reopen");

// ---- supersession: its own action with the predecessor's revision
const sup = R.supersedeBody(rec(), "Nouveau", "Pourquoi", REQ);
assert.deepEqual(sup, { action: "reasoning_supersede", predecessor_id: DID, expected_rev: 3, request_id: REQ, statement: "Nouveau", rationale: "Pourquoi" });
assert.equal(R.supersedeBody(rec({ status: "withdrawn", effective_status: "withdrawn" }), "N", "", REQ), null);
assert.equal(R.supersedeBody(rec({ superseded_by: AID }), "N", "", REQ), null);
assert.equal(R.supersedeBody(rec({ effective_status: "supersession_pending" }), "N", "", REQ), null);
assert.equal(R.supersedeBody(rec({ integrity: "corrupt" }), "N", "", REQ), null);
assert.equal(R.supersedeBody(asm({ status: "confirmed", effective_status: "confirmed" }), "N", "", REQ).action, "reasoning_supersede");
assert.equal(R.supersedeBody(rec(), "", "", REQ), null);
assert.equal(R.supersedeBody(rec(), "N", "", "bad"), null);

// ---- delete only while active with no history / links; revision-bound + confirmed
assert.equal(R.canDelete(rec()), true);
assert.equal(R.canDelete(rec({ history: [{ event: "withdrawn" }] })), false);
assert.equal(R.canDelete(rec({ supersedes: AID })), false);
assert.equal(R.canDelete(rec({ superseded_by: AID })), false);
assert.equal(R.canDelete(rec({ claimed_by: [AID] })), false);
assert.equal(R.canDelete(rec({ status: "withdrawn", effective_status: "withdrawn" })), false);
assert.equal(R.canDelete(rec({ integrity: "corrupt" })), false);
assert.equal(R.canDelete(rec({ evidence: [1], verification_ids: [1] })), true, "evidence and wording edits do not block deletion");
assert.equal(R.deleteBody(rec(), false), null);
assert.equal(R.deleteBody(rec(), "yes"), null);
assert.deepEqual(R.deleteBody(rec(), true), { action: "reasoning_delete", id: DID, expected_rev: 3, confirm: true });

// ---- historical = read only
for (const s of ["confirmed", "invalidated", "retired", "withdrawn", "superseded"]) assert.ok(R.isHistorical({ status: s }), s);
assert.ok(!R.isHistorical({ status: "active" }));

// ---- grouping: corrupt first / apart; pending apart; no Kanban, no priority
const rows = [
  rec({ id: DID }),
  rec({ id: "dec-" + "4".repeat(24), status: "withdrawn", effective_status: "withdrawn" }),
  asm({ id: "asm-" + "5".repeat(24) }),
  asm({ id: "asm-" + "6".repeat(24), status: "confirmed", effective_status: "confirmed" }),
  asm({ id: "asm-" + "7".repeat(24), status: "invalidated", effective_status: "invalidated" }),
  asm({ id: "asm-" + "8".repeat(24), status: "retired", effective_status: "retired" }),
  asm({ id: "asm-" + "9".repeat(24), status: "superseded", effective_status: "superseded" }),
  rec({ id: "dec-" + "a".repeat(24), effective_status: "supersession_pending" }),
  rec({ id: "dec-" + "b".repeat(24), integrity: "corrupt", status: null }),
  asm({ id: "asm-" + "c".repeat(24), integrity: "invalid", status: null }),
];
const g = R.group(rows);
const by = Object.fromEntries(g.groups.map((x) => [x.id, x.rows.length]));
assert.deepEqual(by, { "dec-active": 1, "dec-history": 1, "asm-active": 1, "asm-confirmed": 1, "asm-invalidated": 1, "asm-retired": 1, "asm-superseded": 1 });
assert.equal(g.pending.length, 1);
assert.equal(g.other.length, 2, "corrupt and invalid files are listed apart");
assert.deepEqual(g.groups.map((x) => x.label).slice(0, 2), ["Décisions actives", "Décisions historiques"]);
assert.ok(!R.GROUPS.some((x) => /kanban|priorit|assign|échéance/i.test(x.label)));

// ---- client-side filters over loaded rows
assert.equal(R.filterRows(rows, { kind: R.KIND_ASSUMPTION }).length, 6);
assert.equal(R.filterRows(rows, { status: "withdrawn" }).length, 1);
assert.equal(R.filterRows(rows, { status: "supersession_pending" }).length, 1);
assert.equal(R.filterRows([rec({ statement: "Utiliser un DN80" })], { text: "dn80" }).length, 1);
assert.equal(R.filterRows(rows, { freshness: "changed" }, {}).length, 0, "freshness needs an evaluation first");
assert.equal(R.filterRows(rows, { freshness: "changed" }, { [DID]: "changed" }).length, 1);
assert.equal(R.filterRows([rec({ verification_count: 2 }), rec({ verification_count: 0 })], { verification: "linked" }).length, 1);
assert.equal(R.filterRows([rec({ verification_count: 2 }), rec({ verification_count: 0 })], { verification: "none" }).length, 1);

// ---- wording: procedural, non-evaluative, distinct from the journal; verifications displayed, never gating
assert.equal(R.MSG.title, "Registre des décisions et hypothèses");
assert.ok(/distinct/i.test(R.MSG.journalDistinct) && /journal/.test(R.MSG.journalDistinct));
assert.equal(R.verificationSummaryText({ count: 2, verified: 1 }), "2 vérifications liées · 1 vérifiée");
assert.equal(R.verificationSummaryText({ count: 1, verified: 0 }), "1 vérification liée · 0 vérifiée");
assert.equal(R.verificationSummaryText({ count: 0, verified: 0 }), R.MSG.noVerifications);
assert.equal(R.MSG.indeterminate, "État de supersession indéterminé — successeur altéré");
assert.equal(R.summaryText({}), R.MSG.summaryNone);
assert.match(R.summaryText({ reasoning_decision: { active: 2 }, reasoning_assumption: { confirmed: 1 } }), /2 décisions \(2 actives\) · 1 hypothèse/);
const wording = JSON.stringify(R.MSG).toLowerCase();
for (const banned of ["conforme", "approuv", "compliant", "approved", "safe", "sûr", "certifi", "validé", "validée"]) assert.ok(!wording.includes(banned), "wording: " + banned);
assert.ok(!/signature|\bsigné|relecteur/i.test(wording.replace("aucune identité d'auteur authentifiée", "")), "no identity wording");
assert.equal(R.freshText("not_captured"), "Non capturé lors de la transition");
assert.equal(R.freshText("integrity_anomaly"), "Anomalie d'intégrité : mêmes nom, octets différents");
assert.equal(R.existsText("archived"), "Archivée");

// ---- error mapping
const err = (status, data) => ({ status, data });
assert.equal(R.errorInfo(err(409, { code: "reasoning_conflict", current_rev: 5 })).conflict, true);
assert.equal(R.errorInfo(err(409, { code: "reasoning_conflict", current_rev: 5 })).currentRev, 5);
assert.equal(R.errorInfo(err(409, { code: "reasoning_corrupt" })).corrupt, true);
assert.equal(R.errorInfo(err(409, { code: "reasoning_limit" })).full, true);
assert.equal(R.errorInfo(err(409, { code: "decision_request_conflict" })).requestConflict, true);
assert.equal(R.errorInfo(err(409, { code: "assumption_request_conflict" })).requestConflict, true);
assert.equal(R.errorInfo(err(409, { code: "reasoning_evidence_unavailable", entries: [{ state: "missing" }] })).message, R.MSG.unavailable);
assert.equal(R.errorInfo(err(409, { code: "reasoning_evidence_unavailable", entries: [{ state: "missing" }] })).entries.length, 1);
assert.equal(R.errorInfo(err(409, { code: "reasoning_capture_race" })).message, R.MSG.race);
assert.equal(R.errorInfo(err(409, { code: "reasoning_no_evidence" })).message, R.MSG.noEvidenceConfirm);
assert.equal(R.errorInfo(err(409, { code: "reasoning_has_history" })).message, R.MSG.hasHistory);
assert.equal(R.errorInfo(err(409, { code: "reasoning_supersession_pending" })).message, R.MSG.pending);
assert.equal(R.errorInfo(err(409, { code: "reasoning_supersession_indeterminate" })).message, R.MSG.indeterminate);
assert.equal(R.errorInfo(err(400, { code: "reasoning_project_mismatch" })).message, R.MSG.projectMismatch);
assert.equal(R.errorInfo(err(409, { code: "reasoning_request_corrupt" })).message, R.MSG.requestCorrupt);
assert.equal(R.errorInfo(err(409, { code: "reasoning_request_corrupt" })).requestCorrupt, true);
assert.equal(R.errorInfo(err(409, { code: "reasoning_request_corrupt" })).definite, true, "a coded refusal is a known outcome");
assert.equal(R.errorInfo(new Error("réseau")).definite, false, "a bare network error is not a known outcome");
assert.equal(R.errorInfo(err(409, { code: "reasoning_state_invalid" })).definite, true);

// ---- UI modules are sink-free and never use the bare "decision" kind
for (const f of ["../assets/hq-carnet-reasoning.js", "../assets/hq-carnet-reasoning-ui.js"]) {
  const src = readFileSync(new URL(f, import.meta.url), "utf8");
  for (const needle of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /localStorage/, /sessionStorage/, /indexedDB/, /fetch\(/, /XMLHttpRequest/, /sendBeacon/, /Math\.random/, /Date\.now|new Date\(\)/]) assert.ok(!needle.test(src), f + " " + needle);
  for (const k of ["signed_by", "author", "username", "assignee", "due_at", "priority", "confidence", "approved"]) assert.ok(!src.includes('"' + k + '"') && !src.includes(k + ":"), f + " " + k);
  for (const needle of [/kind\s*===?\s*["']decision["']/, /kind:\s*["']decision["']/, /kind:\s*["']assumption["']/]) assert.ok(!needle.test(src), f + " bare kind " + needle);
}
const ui = readFileSync(new URL("../assets/hq-carnet-reasoning-ui.js", import.meta.url), "utf8");
assert.ok(/textContent|text:/.test(ui));
assert.ok(!/setAttribute\("(src|href|srcdoc)"/.test(ui));
assert.ok(!/statusBody\([^)]*"superseded"/.test(ui), "the UI never asks for status superseded");
assert.ok(/supersedeBody/.test(ui) && /M\.open\(/.test(ui), "supersession goes through its own action; the workspace uses the shared modal");
const model = readFileSync(new URL("../assets/hq-carnet-reasoning.js", import.meta.url), "utf8");
assert.ok(!/require\(["']\.\/hq-carnet-(ask|history|sources|verifications)/.test(model + ui.replace('require("./hq-carnet-reasoning.js")', "")), "the register client never imports another domain model");

// ---- the loader chain loads the model before its UI and both before the Reader
const bridge = readFileSync(new URL("../iphone_bridge.py", import.meta.url), "utf8");
const chain = bridge.split("\n").find((l) => l.includes("hq-carnet-modal.js") && l.includes("load("));
assert.ok(chain.indexOf("hq-carnet-reasoning.js") > 0 && chain.indexOf("hq-carnet-reasoning.js") < chain.indexOf("hq-carnet-reasoning-ui.js") && chain.indexOf("hq-carnet-reasoning-ui.js") < chain.indexOf("hq-carnet-reader.js"));
console.log("reasoning client checks ok");
