// Behavioural check of assets/hq-carnet-semantic.js with a minimal fake DOM (no jsdom in this repo).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.parentNode = null; this.listeners = {}; this._text = ""; this.disabled = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  get nextSibling() { const i = this.parentNode.children.indexOf(this); return this.parentNode.children[i + 1] || null; }
  set textContent(v) { this._text = String(v); if (v === "") this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  async click() { for (const fn of this.listeners.click || []) await fn({ target: this }); }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
  querySelector(sel) { const id = sel.replace(/^#/, ""); return this.all().find((n) => n.attrs.id === id) || null; }
}

function run(responses) {
  const dlg = new El("div"); dlg.attrs.id = "hq-carnet-ask";
  const input = new El("input"); input.attrs.id = "hq-carnet-ask-q"; input.value = "vis et couple de serrage";
  const out = new El("div"); out.attrs.id = "hq-carnet-ask-out";
  dlg.appendChild(input); dlg.appendChild(out);
  const calls = [];
  const document = { readyState: "complete", createElement: (t) => new El(t), getElementById: (id) => (id === "hq-carnet-ask" ? dlg : null), addEventListener() {}, body: {} };
  const window = { api: async (path) => { calls.push(path); const r = responses(path); if (r instanceof Error) throw r; return r; } };
  vm.runInNewContext(readFileSync(new URL("../assets/hq-carnet-semantic.js", import.meta.url), "utf8"), { document, window, MutationObserver: class { observe() {} disconnect() {} }, setTimeout });
  return { dlg, input, calls, box: () => dlg.querySelector("#hq-carnet-semantic") };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// 1. Off, absent or failing: the dialog is left exactly as it is.
for (const reply of [{ ok: true, enabled: false }, new Error("403"), null]) {
  const t = run(() => reply); await tick();
  assert.equal(t.box(), null);
  assert.deepEqual(t.calls, ["/api/carnet-semantic"]);
}

// 2. On: a separate section that says what it is, with a search button.
const card = { page_id: "page-1", block_id: "blk-1", kind: "note", score: 0.5678, title: "Vis M3", excerpt: "<img src=x onerror=alert(1)> couple 1,2 Nm", derived: true,
  digest: { summary: "Couple de serrage des vis.", tags: ["vis", "couple"] } };
let reply = (path) => (path.includes("?q=") ? { ok: true, enabled: true, available: true, results: [card], pending: 2 } :
  { ok: true, enabled: true, digests: [{ page_id: "page-9", title: "Robot", summary: "Bras robot et servos.", tags: ["robot"] }], digest_note: "Générés par un modèle local." });
let t = run((p) => reply(p)); await tick();
const box = t.box();
assert.ok(box, "section added");
assert.match(box.textContent, /ce ne sont pas des preuves/);
assert.match(box.textContent, /Résumés générés \(1\)/);
assert.match(box.textContent, /Générés par un modèle local/);
const go = box.all().find((n) => n.tag === "button" && /Chercher par le sens/.test(n.textContent));
await go.click();
assert.equal(t.calls.at(-1), "/api/carnet-semantic?q=vis%20et%20couple%20de%20serrage&k=8");
assert.match(box.textContent, /1 suggestion\(s\) — 2 blocs pas encore lus/);
assert.match(box.textContent, /proche par le sens \(0\.57\)/);
assert.match(box.textContent, /texte extrait d'un scan/);
assert.match(box.textContent, /Résumé généré : Couple de serrage des vis\./);
assert.ok(!box.all().some((n) => n.tag === "img"), "server text is never parsed as markup");
assert.match(box.textContent, /<img src=x onerror=alert\(1\)>/, "it is shown as plain text");
const open = box.all().filter((n) => n.attrs["data-ask"] === "goto");
assert.ok(open.some((n) => n.attrs["data-page"] === "page-1" && n.attrs["data-block"] === "blk-1"), "result opens its block through the dialog's own handler");
assert.ok(open.some((n) => n.attrs["data-page"] === "page-9" && !("data-block" in n.attrs)), "a digest opens its page");

// 3. States the owner can meet: too short, offline, indexing, nothing close, failure.
t.input.value = "a"; await go.click();
assert.match(box.textContent, /Écris une question d'abord/);
t.input.value = "question";
for (const [res, re] of [[{ enabled: true, available: false, indexed: 12 }, /ne répond pas/], [{ enabled: true, available: false, indexed: 0, pending: 40 }, /L'index se prépare en arrière-plan \(40 blocs/],
  [{ enabled: true, available: true, results: [] }, /Rien de proche par le sens/], [{ enabled: false }, /Désactivé/], [new Error("boom"), /a échoué/]]) {
  reply = (p) => (p.includes("?q=") ? res : { enabled: true, digests: [] });
  t = run((p) => reply(p)); await tick();
  t.input.value = "question";
  await t.box().all().find((n) => n.tag === "button").click();
  assert.match(t.box().textContent, re);
}
console.log("check_hq_carnet_semantic: ok");
