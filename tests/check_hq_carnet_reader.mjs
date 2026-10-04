// Carnet product phase 9: Reader — pure client contract (no DOM, no network).
// Covers the wire shape (identities only, ≤100 per batch, a frozen context alone), the strict answer sanitizer, the captured / current /
// integrity wording, locator != PDF page, "ok" = location only, the frozen-evidence viewer decision matrix, and the sink-free UI modules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const R = require("../assets/hq-carnet-reader.js");

const SID = "srce-abc123";
const cite = (over = {}) => ({ src: SID, loc: { kind: "clause", text: "304.1.2" }, pdf: null, ok: false, snap: { title: "Machinery" }, from: null, ...over });
const cap = (over = {}) => ({ kind: "citation", metadata: { title: "Machinery" }, locator: { kind: "clause", text: "304.1.2" }, pdf: null, location_verified: false, provenance: null, ...over });
const raw = (over = {}) => ({
  source_id: SID, captured: cap(), current: { state: "available", metadata: { title: "Machinery" }, file: { state: "ok", route: "/files/Uni/a.pdf" } },
  differs: [], integrity: { state: "not_applicable", route: null }, frozen: null, ...over,
});
const result = (over, entry = { source_id: SID }) => R.sanitizeResult(raw(over), entry);

// ---- request: identities only
assert.equal(R.entryFor({ sourceId: "/etc/passwd" }), null);
assert.equal(R.entryFor({ sourceId: "https://evil.example/x.pdf" }), null);
assert.equal(R.entryFor({ sourceId: "file:///etc/passwd" }), null);
assert.equal(R.entryFor({ sourceId: "srce-a/../b" }), null);
assert.equal(R.entryFor({}), null);
assert.deepEqual(R.entryFor({ sourceId: SID }), { source_id: SID });
assert.deepEqual(Object.keys(R.entryFor({ sourceId: SID, citation: cite(), context: { kind: "snapshot", id: "snap-" + "0".repeat(24) } })).sort(), ["citation", "context", "source_id"]);

const many = [];
for (let i = 0; i < 250; i += 1) many.push({ source_id: "srce-" + (i % 150), citation: cite({ src: "srce-" + (i % 150) }) });
const uniq = R.uniqueEntries(many);
assert.equal(uniq.length, 150, "identical entries are sent once");
const bodies = R.batchBodies(uniq);
assert.deepEqual(bodies.map((b) => b.entries.length), [100, 50]);
assert.ok(bodies.every((b) => Object.keys(b).sort().join() === "action,entries" && b.action === "reader_resolve"));
const ctx = { source_id: SID, context: { kind: "snapshot", id: "snap-" + "0".repeat(24) } };
const mixed = R.batchBodies([...uniq.slice(0, 3), ctx]);
assert.equal(mixed.length, 2);
assert.ok(mixed.some((b) => b.entries.length === 1 && b.entries[0].context), "a frozen context travels alone");
assert.equal(R.ENTRIES_MAX, 100);

// ---- answer: strict, text only
const unk = R.sanitizeResult("<script>", { source_id: SID });
assert.equal(unk.current.state, "unknown");
assert.equal(unk.captured, null);
assert.equal(R.sanitizeResult(raw({ source_id: "srce-other" }), { source_id: SID }).current.state, "unknown", "an answer for another source is refused");
assert.equal(R.sanitizeResult(raw({ current: { state: "weird", metadata: {}, file: { state: "ok", route: null } } }), { source_id: SID }).current.state, "unknown");
for (const bad of ["https://evil.example/a.pdf", "file:///etc/passwd", "/etc/passwd", "/files/../../etc/passwd", "/files/a\\b.pdf", "/files/a\u0000.pdf", "javascript:alert(1)"]) {
  const r = result({ current: { state: "available", metadata: {}, file: { state: "ok", route: bad } } });
  assert.equal(r.current.file.route, null, "route refused: " + JSON.stringify(bad));
  assert.equal(R.viewerPlan(r).mode, "none");
}
const V = "/api/carnet/reader-pdf?snapshot=snap-0123456789abcdef01234567&source=" + SID;
const VR = "/api/carnet/reader-pdf?review=rvw-0123456789abcdef01234567&item=ri-0123456789abcdef&source=" + SID;
assert.equal(R.viewerUrl(V, 3), V + "#page=3", "the verified snapshot route is accepted, with the stored PDF page");
assert.equal(R.viewerUrl(VR, null), VR);
for (const bad of [V + "&x=1", V.replace("snap-", "snp-"), "/api/carnet/reader-pdf?path=/etc/passwd", "/api/carnet/reader-pdf?snapshot=snap-0123456789abcdef01234567", "/api/carnet/other?snapshot=snap-0123456789abcdef01234567&source=" + SID, "https://evil.example" + V, V + "\n"]) {
  assert.equal(R.viewerUrl(bad, null), null, "verified route refused: " + JSON.stringify(bad));
}
// r3: every verified-route refusal code has its OWN wording; "changed" is never the default
const ref = (c) => R.verifiedRefusal(c);
assert.equal(ref("differs_from_seal").text, R.MSG.sealRefused);
assert.equal(ref("sealed_file_missing").text, R.MSG.sealGone);
for (const c of ["sealed_file_noncanonical", "sealed_file_unreadable", "storage_error"]) assert.equal(ref(c).text, R.MSG.sealUnreadable, c);
assert.equal(ref("sealed_file_too_large").text, R.MSG.sealTooLarge);
for (const c of ["frozen_unavailable", "no_sealed_file"]) assert.equal(ref(c).text, R.MSG.sealUnavailable, c);
for (const c of [null, "", "validation_error", "weird", undefined]) assert.equal(ref(c).text, R.MSG.authError, "unknown / no code is an access failure, not 'changed': " + c);
assert.equal(new Set(["differs_from_seal", "sealed_file_missing", "sealed_file_unreadable", "sealed_file_too_large", "no_sealed_file", "x"].map((c) => ref(c).text)).size, 6, "six distinct messages");
assert.equal(R.refusalCode('{"error":"x","code":"sealed_file_missing"}'), "sealed_file_missing");
assert.equal(R.refusalCode('{"error":"PIN requis"}'), null);
assert.equal(R.refusalCode("<html>"), null);
const evil = result({ captured: cap({ metadata: { title: "<script>alert(1)</script>" } }) });
assert.equal(R.cardModel(evil).title, "<script>alert(1)</script>", "kept as inert text (the UI uses textContent)");
const hostile = result({ differs: ["title", "__proto__", "constructor", "file_ref"] });
assert.deepEqual(hostile.differs, ["title"]);
assert.deepEqual(R.resultsFor([{ source_id: SID }, { source_id: "srce-b" }], { results: [raw()] }).map((r) => r.current.state), ["unknown", "unknown"], "a length mismatch is never mapped by guesswork");
const pair = R.resultsFor([{ source_id: SID }, { source_id: "srce-b" }], { results: [raw(), raw({ source_id: "srce-b" })] });
assert.deepEqual(pair.map((r) => r.source_id), [SID, "srce-b"]);

// ---- card: locator != PDF page; ok = location only
const both = R.cardModel(result({ captured: cap({ pdf: 417, location_verified: true }) }));
const line = (m, k) => m.lines.find((l) => l.key === k);
assert.equal(line(both, "locator").text, "Article / clause 304.1.2");
assert.equal(line(both, "pdf").text, "417");
assert.equal(line(both, "pdf").announce, "Page PDF 417");
assert.equal(line(both, "locator").announce, "Emplacement source : Article / clause 304.1.2");
assert.equal(both.verified.text, "Emplacement vérifié");
assert.ok(!/source vérifiée|information vérifiée|contenu vérifié|affirmation/i.test(JSON.stringify(both)), "ok never claims the content was verified");
const locOnly = R.cardModel(result({ captured: cap({ pdf: null }) }));
assert.equal(line(locOnly, "pdf").text, R.MSG.noPdfPage, "a locator without a PDF page never invents one");
assert.equal(R.viewerPlan(result({ captured: cap({ pdf: null }) })).page, null);
const pdfOnly = R.cardModel(result({ captured: cap({ locator: null, pdf: 417 }) }));
assert.equal(line(pdfOnly, "locator").text, R.MSG.noLocator, "a PDF page without a locator never invents one");
assert.equal(line(pdfOnly, "pdf").text, "417");
assert.equal(R.cardModel(result({ captured: cap({ location_verified: false }) })).verified.text, "Emplacement non vérifié");
// captured vs current stay in separate columns; the server decides "differs"
const renamed = R.cardModel(result({ captured: cap({ metadata: { title: "Spec A" } }), current: { state: "available", metadata: { title: "Spec B" }, file: { state: "ok", route: "/files/Uni/a.pdf" } }, differs: ["title"] }));
assert.deepEqual(renamed.rows.map((r) => [r.field, r.captured, r.current, r.differs]), [["title", "Spec A", "Spec B", true]]);
assert.equal(renamed.title, "Spec A", "the captured title leads");
// states
const miss = R.cardModel(result({ current: { state: "missing", metadata: null, file: { state: "none", route: null } } }));
assert.equal(miss.source.text, R.MSG.srcMissing);
assert.equal(miss.title, "Machinery", "a missing source keeps the citation visible");
const fileGone = R.cardModel(result({ current: { state: "available", metadata: { title: "Machinery" }, file: { state: "missing", route: null } } }));
assert.deepEqual([fileGone.source.key, fileGone.file.key], ["available", "missing"], "missing file != missing source");
const fileUnk = R.cardModel(result({ current: { state: "available", metadata: { title: "Machinery" }, file: { state: "unknown", route: null } } }));
assert.deepEqual([fileUnk.source.key, fileUnk.file.key], ["available", "unknown"]);
assert.equal(R.cardModel(result({ current: { state: "archived", metadata: { title: "Machinery" }, file: { state: "ok", route: "/files/Uni/a.pdf" } } })).source.text, R.MSG.srcArchived);
assert.equal(R.viewerPlan(result({ current: { state: "archived", metadata: { title: "M" }, file: { state: "ok", route: "/files/Uni/a.pdf" } } })).mode, "auto", "an archived source is still readable when its file exists");
assert.equal(R.cardModel(result({ current: { state: "unknown", metadata: null, file: { state: "unknown", route: null } } })).source.text, R.MSG.srcUnknown);
const migrated = R.cardModel(result({ captured: cap({ provenance: { source_id: "srce-old", locator: { kind: "page", text: "12" }, pdf: 20, location_verified: true } }) }));
assert.equal(migrated.provenance.heading, "Provenance de migration");
assert.match(migrated.provenance.text, /Page 12/);
assert.match(migrated.provenance.text, /Page PDF 20/);
assert.equal(line(migrated, "locator").text, "Article / clause 304.1.2", "provenance never replaces the current locator");

// ---- viewer decisions (frozen evidence)
const frozen = (state, extra = {}, scope = "snapshot", cur = { state: "available", metadata: { title: "M" }, file: { state: "ok", route: "/files/Uni/now.pdf" } }) =>
  result({ captured: { ...cap({ location_verified: null, locator: null }), kind: "snapshot" }, frozen: { kind: "snapshot", available: true, scope }, integrity: { state, route: "/files/Uni/sealed.pdf", ...extra }, current: cur });
const live = R.viewerPlan(result({}));
assert.deepEqual([live.mode, live.route, live.label], ["auto", "/files/Uni/a.pdf", null]);
const same = R.viewerPlan(frozen("matches_seal"));
assert.deepEqual([same.mode, same.route, same.label], ["auto", "/files/Uni/sealed.pdf", null], "a hash match allows normal frozen viewing");
assert.equal(R.cardModel(frozen("matches_seal")).banner.text, "Fichier actuel identique au fichier scellé");
const diff = R.viewerPlan(frozen("differs_from_seal"));
assert.equal(diff.mode, "explicit", "a different live PDF is NEVER loaded on its own");
assert.equal(diff.action, "Ouvrir le fichier actuel (différent)");
assert.equal(diff.label, "Fichier actuel — différent de l’évidence figée");
assert.equal(R.cardModel(frozen("differs_from_seal")).banner.text, "Le fichier actuel diffère du fichier scellé lors de cette revue / de ce jalon.");
const gone = R.viewerPlan(frozen("sealed_file_missing", { route: null }));
assert.deepEqual([gone.mode, gone.route], ["none", null]);
assert.match(R.cardModel(frozen("sealed_file_missing", { route: null })).banner.text, /octets figés ne sont plus disponibles/);
assert.ok(!/reconstru/i.test(JSON.stringify(R.cardModel(frozen("sealed_file_missing", { route: null })))), "never implies frozen bytes can be rebuilt");
const unkn = R.viewerPlan(frozen("unknown", { route: null }));
assert.equal(unkn.mode, "explicit");
assert.equal(unkn.route, "/files/Uni/now.pdf");
assert.match(unkn.label, /non comparé/);
assert.equal(R.viewerPlan(frozen("unknown", { route: null }, "snapshot", { state: "available", metadata: {}, file: { state: "missing", route: null } })).mode, "none");
const unsealed = R.viewerPlan(frozen("not_applicable", { route: null }));
assert.equal(unsealed.mode, "explicit");
assert.match(unsealed.label, /non scellé/);
assert.equal(R.viewerPlan(frozen("not_applicable", { route: null }, "live")).mode, "auto", "a live-scope review item reads the current file");
assert.equal(R.viewerPlan(result({ frozen: { kind: "snapshot", available: false, scope: "snapshot" }, captured: null })).mode, "none", "an untrusted frozen record shows nothing");
assert.equal(R.cardModel(result({ frozen: { kind: "snapshot", available: false, scope: "snapshot" }, captured: null })).banner.text, R.MSG.frozenUnavailable);

// ---- viewer url / paging: PDF page index only, never the locator
assert.equal(R.viewerUrl("/files/Uni/a.pdf", 417), "/files/Uni/a.pdf#page=417", "page 417 opens 417, no off-by-one");
assert.equal(R.viewerUrl("/files/Uni/a.pdf", null), "/files/Uni/a.pdf");
for (const bad of [0, -1, 1.5, 100001, "417", NaN]) assert.equal(R.viewerUrl("/files/Uni/a.pdf", bad), "/files/Uni/a.pdf", "invalid page ignored: " + bad);
assert.equal(R.viewerUrl("https://evil.example/a.pdf", 3), null);
assert.equal(R.stepPage(417, 1), 418);
assert.equal(R.stepPage(1, -1), 1);
assert.equal(R.stepPage(R.PAGE_MAX, 1), R.PAGE_MAX);
assert.equal(R.stepPage(null, 1), 2);

// ---- offline: the citation as stored is still readable; the current side is unknown, never missing
const off = R.offlineResult({ sourceId: SID, citation: cite({ pdf: 417, ok: true, snap: { title: "Machinery", edition: "3e", year: 2012, ident: "ISBN" } }) });
assert.equal(off.current.state, "unknown");
const offm = R.cardModel(off);
assert.equal(offm.title, "Machinery");
assert.equal(line(offm, "pdf").text, "417");
assert.equal(offm.verified.text, "Emplacement vérifié");
assert.equal(R.viewerPlan(off).mode, "none");
assert.equal(offm.reason, R.MSG.failed);

// ---- no dangerous sinks in the new modules (the PDF iframe is the one allowed embed: same-origin /files only, built from R.viewerUrl)
for (const f of ["../assets/hq-carnet-reader.js", "../assets/hq-carnet-reader-ui.js", "../assets/hq-carnet-modal.js"]) {
  const t = readFileSync(new URL(f, import.meta.url), "utf8");
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "localStorage", "sessionStorage", "indexedDB", "srcdoc", "XMLHttpRequest", "fetch(", "window.open", "serviceWorker", "file://"]) assert.ok(!t.includes(bad), f + " must not use " + bad);
}
const ui = readFileSync(new URL("../assets/hq-carnet-reader-ui.js", import.meta.url), "utf8");
assert.equal((ui.match(/"iframe"/g) || []).length, 1, "exactly one embed");
assert.ok(ui.includes("src: url"), "the iframe src is the model-built /files url");
console.log("check_hq_carnet_reader: ok");
