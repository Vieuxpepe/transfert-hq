// Atelier 3D — the client behaviour that the audit fixed, checked against the real module.
//
// Part 1 (STL): a binary STL states its triangle count in the first 84 bytes, so the preview
// streams the file, checks that header, and cancels the transfer when the count exceeds the
// viewer's cap. Driven with a synthetic stream: no 60 MB fixture, no browser, no server.
//
// Part 2 (view): the module runs in the repo's tiny DOM (tests/hq_dom_stub.mjs) with a scripted
// api and fake timers, so polling, in-place updates, empty states and the a11y contract are
// checked without a bridge, a browser or a PIN.

import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { loadChip, tick, deferred } from "./hq_dom_stub.mjs";

const require = createRequire(import.meta.url);

// ── part 1: STL preview ──────────────────────────────────────────────────────
const listeners = {};
const stub = { append() {}, querySelector() { return null; }, addEventListener() {}, setAttribute() {}, contains() { return false; } };
globalThis.document = {
  addEventListener: (kind, fn) => { listeners[kind] = fn; },
  createElement: () => stub, createElementNS: () => stub, body: { append() {} }, hidden: false, activeElement: null,
};
globalThis.window = {};
require("../assets/hq-print3d.js");

const H = window.HqPrint3d && window.HqPrint3d._hooks;
assert.ok(H && typeof H.probeStl === "function" && typeof H.fetchStl === "function" && typeof H.meshPreflight === "function", "test hooks exported");
assert.ok(listeners.visibilitychange && listeners.keydown, "view listeners registered");

const MAX = 300000;                       // keep in step with the module's STL_MAX_TRIANGLES
const HEAD = 84;                          // binary STL header + uint32 triangle count

function binaryHeader(count, prefix = "") {
  const bytes = new Uint8Array(HEAD);
  for (let i = 0; i < prefix.length && i < HEAD; i++) bytes[i] = prefix.charCodeAt(i);
  new DataView(bytes.buffer).setUint32(80, count, true);
  return bytes;
}

function stream(chunks) {
  let index = 0;
  const stats = { reads: 0, cancelled: 0, bytes: 0 };
  const body = {
    getReader() {
      return {
        read() {
          stats.reads += 1;
          if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
          const value = chunks[index++];
          stats.bytes += value.length;
          return Promise.resolve({ done: false, value });
        },
        cancel() { stats.cancelled += 1; return Promise.resolve(); },
      };
    },
  };
  return { body, stats };
}

function serve(s) {
  globalThis.fetch = async () => ({ ok: true, body: s.body });
}

const cases = [];
function check(name, fn) { cases.push([name, fn]); }

check("header over the cap cancels after 84 bytes", async () => {
  const s = stream([binaryHeader(MAX + 1), new Uint8Array(4096)]);
  serve(s);
  await assert.rejects(H.fetchStl("/api/print3d/models/file?id=x"), /triangles/);
  assert.equal(s.stats.reads, 1, "read stops at the header");
  assert.equal(s.stats.bytes, HEAD, "the rest of the file is never pulled");
  assert.equal(s.stats.cancelled, 1, "the transfer is cancelled");
});

check("a huge claim with only the header still cancels", async () => {
  // The old bug: this file would have been downloaded in full before being refused.
  const s = stream([binaryHeader(1_200_000), new Uint8Array(64)]);
  serve(s);
  await assert.rejects(H.fetchStl("/x"), /téléchargement interrompu/);
  assert.deepEqual([s.stats.reads, s.stats.cancelled], [1, 1]);
  assert.equal(s.stats.bytes, HEAD);
});

check("range preflight refuses an oversize STL without fetching its body", async () => {
  const head = binaryHeader(MAX + 1), calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, headers: opts && opts.headers });
    if (calls.length === 1) return { ok: true, status: 206, arrayBuffer: async () => head.buffer.slice(0) };
    throw new Error("the full body was requested");
  };
  await assert.rejects(H.fetchStl("/x"), /triangles/);
  assert.equal(calls.length, 1, "there is no full-body request");
  assert.equal(calls[0].headers.Range, "bytes=0-83", "only the 84-byte header is asked for");
});

check("range preflight downloads the body only after an accepted header", async () => {
  const head = binaryHeader(MAX), tail = new Uint8Array(200), calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, headers: opts && opts.headers });
    if (calls.length === 1) return { ok: true, status: 206, arrayBuffer: async () => head.buffer.slice(0) };
    return { ok: true, status: 200, body: stream([head, tail]).body };
  };
  const buffer = await H.fetchStl("/x");
  assert.equal(calls.length, 2, "header first, body second");
  assert.equal(calls[0].headers.Range, "bytes=0-83");
  assert.equal(calls[1].headers, undefined, "the full request is not ranged");
  assert.equal(buffer.byteLength, HEAD + tail.length);
});

check("a server that ignores Range still stops after 84 bytes", async () => {
  const s = stream([binaryHeader(MAX + 1), new Uint8Array(4096)]), calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, headers: opts && opts.headers });
    return { ok: true, status: 200, body: s.body };
  };
  await assert.rejects(H.fetchStl("/x"), /triangles/);
  assert.equal(calls.length, 1, "one request, no range support");
  assert.equal(s.stats.bytes, HEAD, "only the probe bytes cross the network");
  assert.equal(s.stats.cancelled, 1);
});

check("exactly at the cap is accepted and read in full", async () => {
  const tail = new Uint8Array(500);
  const s = stream([binaryHeader(MAX), tail]);
  serve(s);
  const buffer = await H.fetchStl("/x");
  assert.equal(buffer.byteLength, HEAD + tail.length);
  assert.equal(s.stats.cancelled, 0);
  assert.equal(s.stats.reads, 3, "two chunks then done");
});

check("an ASCII STL header is left to the parser", async () => {
  const text = "solid bracket\n" + "facet normal 0 0 1\n".repeat(6);
  const bytes = new TextEncoder().encode(text.padEnd(120, " "));
  const s = stream([bytes, new Uint8Array(10)]);
  serve(s);
  const buffer = await H.fetchStl("/x");
  assert.equal(buffer.byteLength, bytes.length + 10);
  assert.equal(s.stats.cancelled, 0);
});

check("a failed response is a plain error", async () => {
  globalThis.fetch = async () => ({ ok: false, body: null });
  await assert.rejects(H.fetchStl("/x"), /Fichier illisible/);
});

check("no readable stream falls back to arrayBuffer()", async () => {
  globalThis.fetch = async () => ({ ok: true, body: null, arrayBuffer: async () => new ArrayBuffer(8) });
  assert.equal((await H.fetchStl("/x")).byteLength, 8);
});

check("mesh preflight reports dimensions, bed fit and a priced solid-volume estimate", () => {
  const parsed = { bounds: { min: [0, 0, 0], max: [10, 20, 30] }, volume_mm3: 6000 };
  const info = H.meshPreflight(parsed, { x: 20, y: 20, z: 20 }, { prices: { PLA: 25 }, currency: "$" });
  assert.deepEqual(info.dims, [10, 20, 30]);
  assert.equal(info.fit.ok, false);
  assert.match(info.fit.over, /Z 30 > 20 mm/);
  assert.ok(Math.abs(info.grams - 7.44) < 1e-9, String(info.grams));
  assert.ok(Math.abs(info.cost - 0.186) < 1e-9, String(info.cost));
  assert.equal(info.material, "PLA");

  const turned = H.meshPreflight(parsed, { x: 20, y: 10, z: 30 }, {});
  assert.equal(turned.fit.ok, true, "a 90° turn around Z is allowed");
  assert.equal(turned.fit.rotated, true);
  assert.equal(turned.cost, null, "no configured price means no invented cost");

  const open = H.meshPreflight({ bounds: { min: [0, 0, 0], max: [1, 1, 1] }, volume_mm3: 0 }, { x: 20, y: 20, z: 20 }, {});
  assert.equal(open.grams, null, "an open mesh has no volume estimate");

  assert.deepEqual(H.printerBed({ name: "A1 mini", kind: "bambu" }), { x: 180, y: 180, z: 180 });
  assert.deepEqual(H.printerBed({ name: "Custom", bed: { x: 210, y: 190, z: 200 } }), { x: 210, y: 190, z: 200 });
});

check("probeStl reads the count and refuses only real binaries", () => {
  assert.equal(H.probeStl([binaryHeader(MAX + 1)]), "too-many");
  assert.equal(H.probeStl([binaryHeader(MAX)]), null);
  assert.equal(H.probeStl([new Uint8Array(10)]), null, "truncated header: let the parser decide");
  const ascii = new TextEncoder().encode("solid x".padEnd(HEAD, " "));
  assert.equal(H.probeStl([ascii]), null);
  // Only a real "solid" prefix is treated as text; without the whole file the probe cannot tell
  // a binary STL that happens to start with it, so that one is left to the parser.
  assert.equal(H.probeStl([binaryHeader(MAX + 1, "solid")]), null);
  assert.equal(H.probeStl([binaryHeader(MAX + 1, "sol")]), "too-many");
});

// ── part 2: the view ─────────────────────────────────────────────────────────
// The module builds its URLs with URLSearchParams, which the stub context does not provide.
const SHIM = [
  "var URLSearchParams = function () { this.pairs = []; };",
  "URLSearchParams.prototype.set = function (k, v) { this.pairs.push([k, String(v)]); return this; };",
  "URLSearchParams.prototype.toString = function () {",
  "  return this.pairs.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&');",
  "};",
].join("\n");

function boot() {
  const page = loadChip("hq-print3d.js", { mutate: (src) => SHIM + "\n" + src });
  const host = page.doc.createElement("section");
  page.doc.body.append(host);
  const api = makeApi();
  const view = page.win.HqPrint3d;
  assert.ok(view && typeof view.show === "function" && view._hooks, "the view is exported");
  return Object.assign({ host, api, view }, page);
}

// A scripted api: every call is a deferred the test resolves, like the bridge would.
function makeApi() {
  const calls = [];
  function api(url, opts) {
    const d = deferred();
    calls.push({ url: String(url), opts: opts || {}, d });
    return d.promise;
  }
  api.calls = calls;
  api.of = (frag) => calls.filter((c) => c.url.indexOf(frag) === 0);
  api.last = (frag) => { const list = api.of(frag); return list[list.length - 1]; };
  return api;
}

const NOW = () => Math.floor(Date.now() / 1000);
function printer(over) {
  return Object.assign({
    id: "p1", name: "A1 mini", kind: "bambu",
    link: { online: true, at: NOW() },
    status: { state: "idle", nozzle: 24, bed: 22 },
  }, over || {});
}
function state(printers, extra) {
  return Object.assign({
    printers,
    config: {
      printers: printers.map((p) => ({ name: p.name, kind: p.kind, ip: "10.0.0.9" })),
      makerworld: {}, filament: { currency: "$" },
    },
    makerworld: {}, history: [],
  }, extra || {});
}
function filamentPayload(over) {
  return Object.assign({
    currency: "$",
    totals: { g: 12, m: 4, cost: 0.3, jobs: 1, with_data: 1, wasted_g: 0, wasted_cost: 0 },
    by_material: [], by_printer: [], by_day: [], recent: [],
    settings: { prices: { PLA: 25 }, currency: "$", default_price_kg: 25, spool_g: 1000 },
  }, over || {});
}

function every(root, out = []) {
  for (const child of root.children || []) {
    if (child.nodeType === 1) { out.push(child); every(child, out); }
  }
  return out;
}
const text = (node) => (node ? node.textContent : "");
function byText(root, needle) {
  return every(root).find((n) => n.tagName === "BUTTON" && n.textContent.trim() === needle) || null;
}
function clickTab(page, name) {
  const btn = page.doc.querySelector('[data-tab="' + name + '"]');
  assert.ok(btn, "tab " + name + " exists");
  btn.click();
}
// Fire the pending poll timer (the module owns it, so the test drives time explicitly).
function firePoll(page) {
  const entries = [...page.win.timers.entries()].filter(([, t]) => !t.interval && t.ms >= 1000);
  if (!entries.length) return null;
  const [id, timer] = entries[entries.length - 1];
  page.win.timers.delete(id);
  timer.fn();
  return timer.ms;
}
const settle = () => tick(10);

check("one /state request at a time, and none while one is in flight", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  assert.equal(page.api.calls.length, 1, "show fetches the state once");
  assert.equal(page.api.calls[0].opts.timeoutMs, 12000, "every /state request carries the 12 s timeout");
  // The old 4 s setInterval was armed even while a request was pending: both facts fail it.
  assert.equal([...page.win.timers.values()].filter((t) => t.interval).length, 0, "no fixed interval drives /state");
  assert.equal(page.win.timers.size, 0, "nothing is armed while the request is in flight");
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  assert.equal(page.win.timers.size, 1, "a poll is scheduled after the reply");

  firePoll(page);
  await settle();
  assert.equal(page.api.calls.length, 2, "the timer starts the next poll");
  assert.equal(page.win.timers.size, 0, "no second timer while the request is in flight");

  page.view._hooks.pollOnce();                 // the shape a fixed interval produced
  await settle();
  assert.equal(page.api.calls.length, 2, "an overlapping poll is dropped, not queued");

  page.api.calls[1].d.resolve(state([printer()]));
  await settle();
  assert.equal(page.win.timers.size, 1, "the poll is re-armed once the reply lands");
});

check("a tab return joins an in-flight /state instead of racing it", async () => {
  const page = boot();
  page.view.show(page.host, page.api);          // call 0, left pending
  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [], tags: [], total: 0, indexed: 0 });
  await settle();
  clickTab(page, "printers");                   // returning while call 0 is still pending
  assert.equal(page.api.of("/api/print3d/state").length, 1,
    "the return reuses the request already in flight");
  assert.equal(page.doc.querySelector(".p3d-skeleton").hidden, false, "the skeleton stays up");

  page.api.calls[0].d.resolve(state([printer({ name: "Nouvelle", status: { state: "printing", progress: 43 } })]));
  await settle();
  assert.equal(text(page.doc.querySelector(".p3d-card strong")), "Nouvelle");
  assert.ok(text(page.doc.querySelector(".p3d-card")).includes("43"), "the single reply renders");
  assert.equal(page.win.timers.size, 1, "the poll resumes after that reply");
});

check("no polling on another tab, and an immediate refresh on return", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  assert.ok(page.win.timers.size >= 1, "polling while the printers tab is open");

  clickTab(page, "filament");
  assert.equal(page.win.timers.size, 0, "opening another tab clears the timer");
  assert.equal(firePoll(page), null, "nothing left to fire");
  const states = () => page.api.of("/api/print3d/state").length;
  assert.equal(states(), 1);
  page.view._hooks.pollOnce();                  // even a stray trigger must not fetch off-tab
  await settle();
  assert.equal(states(), 1, "no /state request while another tab is open");
  assert.equal(page.api.of("/api/print3d/filament").length, 1, "only the tab's own fetch");

  clickTab(page, "printers");
  assert.equal(states(), 2, "coming back refreshes at once");
  page.api.last("/api/print3d/state").d.resolve(state([printer()]));
  await settle();
  assert.equal(page.win.timers.size, 1, "the poll resumes");
});

check("returning to the printers tab after a while marks its old data", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer({ status: { state: "printing", progress: 42 } })]));
  await settle();

  const real = Date.now();
  try {
    vm.runInContext("Date.now = () => " + (real + 3600 * 1000), page.ctx);
    clickTab(page, "filament");                 // leaves the printers view
    clickTab(page, "printers");                 // immediate refresh, but the old 42 % is on screen first
    const badge = page.doc.querySelector(".p3d-age");
    assert.equal(badge.hidden, false, "the return shows the data age");
    assert.ok(text(badge).includes("il y a 1\u00A0h"));
    assert.ok(text(page.doc.querySelector(".p3d-card")).includes("42"), "the old number is still marked");

    page.api.last("/api/print3d/state").d.resolve(state([printer({ status: { state: "printing", progress: 43 } })]));
    await settle();
    assert.equal(page.doc.querySelector(".p3d-age").hidden, true, "the fresh reply clears it");
    assert.ok(text(page.doc.querySelector(".p3d-card")).includes("43"));
  } finally {
    vm.runInContext("Date.now = () => " + real, page.ctx);
  }
});

check("a poll updates the card in place: camera, alerts and history keep their nodes", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const job = { id: "j1", job: "Bracket", printer_name: "A1 mini", outcome: "finished", at: NOW() - 60, filament: { g: 12 } };
  const problem = { code: "0700-8010", text: "AMS", severity: "serious" };
  const slot = { slot: 1, material: "PLA", colour: "#ff8fd8", remain: 70, active: true };
  page.api.calls[0].d.resolve(state([printer({
    status: { state: "printing", progress: 10, nozzle: 210, bed: 60, ams: [slot] },
  })], { history: [job] }));
  await settle();

  const card = page.doc.querySelector(".p3d-card");
  const history = page.doc.querySelector(".p3d-history li");
  const chip = page.doc.querySelector(".p3d-slot");
  assert.ok(card && history && chip, "the card, AMS chip and history are rendered");

  byText(card, "📷 En direct").click();
  const img = page.doc.querySelector("img[data-live]");
  assert.ok(img, "the camera is open");
  const src = img.getAttribute("src");
  assert.equal(src, "/api/print3d/camera/p1?fps=5", "the card asks for five frames a second");

  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(state([printer({
    status: { state: "printing", progress: 12, nozzle: 210, bed: 60, ams: [slot], problems: [problem] },
  })], { history: [job] }));
  await settle();

  // Compared by the stub's node id: printing two whole DOM trees on failure is unreadable (and huge).
  assert.equal(page.doc.querySelector(".p3d-card")._uid, card._uid, "the card node is reused, not rebuilt");
  assert.equal(page.doc.querySelector("img[data-live]")._uid, img._uid, "the camera <img> is never re-parented");
  assert.equal(img.getAttribute("src"), src, "so the MJPEG session is not restarted");
  assert.equal(page.doc.querySelector(".p3d-history li")._uid, history._uid, "the history list is untouched");
  assert.equal(page.doc.querySelector(".p3d-slot")._uid, chip._uid, "an unchanged AMS chip is reused");
  assert.equal(page.doc.querySelectorAll(".p3d-card").length, 1, "no duplicate card");
  const alert = page.doc.querySelector(".p3d-problem");
  assert.ok(alert && text(alert).includes("AMS"), "the new problem is shown");

  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(state([printer({
    status: { state: "printing", progress: 14, nozzle: 210, bed: 60, ams: [slot], problems: [problem] },
  })], { history: [job] }));
  await settle();
  assert.equal(page.doc.querySelector(".p3d-problem")._uid, alert._uid, "an unchanged alarm is not re-created (no re-announcement)");
  assert.equal(page.doc.querySelector(".p3d-slot")._uid, chip._uid, "the AMS chip is reused on an identical payload");
  assert.equal(page.doc.querySelector("img[data-live]")._uid, img._uid, "the camera survives every poll");
});

check("no wrong empty state flashes before the first payload", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  assert.equal(page.doc.querySelector(".p3d-skeleton").hidden, false, "a skeleton stands in for the cards");
  assert.equal(page.doc.querySelector(".p3d-empty").hidden, true, "no 'Aucune imprimante' before any payload");

  clickTab(page, "settings");
  const settings = page.doc.querySelector('[data-pane="settings"]');
  assert.equal(settings.querySelector(".p3d-details"), null, "Réglages shows no half-empty form before the payload");
  assert.ok(settings.querySelector(".p3d-skeleton"), "Réglages waits on a skeleton instead");

  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  assert.ok(page.doc.querySelector('[data-pane="settings"] .p3d-details'), "Réglages fills in after the payload");

  clickTab(page, "printers");
  const pane = page.doc.querySelector('[data-pane="printers"]');
  assert.equal(pane.querySelector(".p3d-skeleton").hidden, true, "the skeleton leaves once the cards render");
  assert.ok(pane.querySelector(".p3d-card"));
  assert.equal(pane.querySelector(".p3d-empty").hidden, true);
});

check("the floor strip summarizes the workshop and the activity rail appends transitions", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const t = NOW();
  const job = { id: "j1", job: "Bracket", printer_name: "A1 mini", outcome: "finished", at: t - 60, filament: { g: 12 } };
  const first = state([
    printer({ status: { state: "printing", progress: 20, remaining_sec: 600, job: "Bracket" } }),
    printer({ id: "p2", name: "Creator 5", status: { state: "offline" },
      link: { online: false, since: t - 3600, error: "Connexion refusée" } }),
  ], { history: [job] });
  page.api.calls[0].d.resolve(first);
  await settle();

  const floor = page.doc.querySelector(".p3d-floor");
  assert.equal(floor.hidden, false, "the floor strip is visible once the payload lands");
  assert.equal(floor.querySelectorAll(".p3d-floor-cell").length, 5, "five at-a-glance figures");
  assert.ok(text(floor).includes("1 / 2"), "online count over configured printers");
  assert.ok(text(floor).includes("vers"), "the next finish is a clock time");
  assert.ok(text(floor).includes("12 g"), "today's grams come from history");

  const rail = page.doc.querySelector(".p3d-rail");
  assert.equal(rail.hidden, false);
  const seed = page.doc.querySelectorAll(".p3d-event").length;
  const seedEvent = page.doc.querySelector(".p3d-event");
  const seedEventId = seedEvent._uid;
  assert.equal(seed, 1, "history seeds the rail once");
  assert.ok(text(rail).includes("Bracket") && text(rail).includes("terminé"));

  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(state([
    printer({ status: { state: "printing", progress: 22, remaining_sec: 580, job: "Bracket" } }),
    printer({ id: "p2", name: "Creator 5", status: { state: "idle" } }),
  ], { history: [job] }));
  await settle();
  assert.equal(page.doc.querySelectorAll(".p3d-event").length, seed + 1, "a real transition appends one event");
  assert.ok(text(page.doc.querySelector(".p3d-rail")).includes("reconnectée"));
  assert.equal(page.doc.querySelectorAll(".p3d-event")[1]._uid, seedEventId,
    "the existing event row is reused when a new one arrives");

  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(state([
    printer({ status: { state: "printing", progress: 22, remaining_sec: 580, job: "Bracket" } }),
    printer({ id: "p2", name: "Creator 5", status: { state: "idle" } }),
  ], { history: [job] }));
  await settle();
  assert.equal(page.doc.querySelectorAll(".p3d-event").length, seed + 1, "an unchanged poll does not repeat an event");
});

check("a running card shows its matched plate and opens a live focus room", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const slot = { slot: 1, material: "PLA", colour: "#ff8fd8", remain: 70, active: true };
  const plate = { id: "m1", name: "vase.3mf", ext: "3mf", has_thumb: true };
  const value = printer({ status: { state: "printing", progress: 10, job: "vase.3mf", layer: 10,
    total_layers: 100, remaining_sec: 600, nozzle: 210, nozzle_target: 215, bed: 60, bed_target: 60,
    ams: [slot], problems: [{ code: "0700-8010", text: "AMS", severity: "serious" }] }, plate });
  page.api.calls[0].d.resolve(state([value]));
  await settle();

  const card = page.doc.querySelector(".p3d-card");
  const thumb = card.querySelector(".p3d-plate img");
  assert.equal(thumb.getAttribute("src"), "/api/print3d/models/thumb?id=m1", "the running job's plate is the library thumbnail");
  const focus = byText(card, "Voir le poste");
  assert.ok(focus, "the card opens a focused room");
  focus.click();

  const overlay = page.doc.querySelector(".p3d-overlay");
  assert.equal(overlay.hidden, false, "the room is a modal sheet");
  const room = overlay.querySelector(".p3d-room");
  assert.ok(room && text(room).includes("vase.3mf"), "the room names the current job");
  const spark = room.querySelector(".p3d-room-history path");
  assert.ok(spark && spark.getAttribute("d").startsWith("M"), "the room starts a progress trace");
  const roomId = room._uid;
  assert.ok(room.querySelector(".p3d-plate-btn"), "the plate is a shortcut to the model sheet");
  // A printing printer's room opens with its camera: that is why the sheet was opened.
  const autoImg = room.querySelector("img[data-live]");
  assert.ok(autoImg, "the room opens the camera of a printing printer by itself");
  assert.equal(autoImg.getAttribute("src"), "/api/print3d/camera/p1?fps=5");
  byText(room, "Fermer la caméra").click();
  assert.ok(!room.querySelector("img[data-live]"), "closing the camera drops the stream");
  byText(room, "📷 Ouvrir la caméra").click();
  const roomImg = room.querySelector("img[data-live]");
  assert.ok(roomImg, "the room can reopen its own camera");
  const imgId = roomImg._uid;

  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(state([printer({ status: { state: "printing", progress: 12,
    job: "vase.3mf", layer: 12, total_layers: 100, remaining_sec: 580, nozzle: 211, nozzle_target: 215,
    bed: 60, bed_target: 60, ams: [slot], problems: [{ code: "0700-8010", text: "AMS", severity: "serious" }] }, plate })]));
  await settle();
  assert.equal(overlay.querySelector(".p3d-room")._uid, roomId, "a poll updates the room in place");
  assert.ok(text(room).includes("12 %"), "the progress reaches the room");
  assert.ok(spark.getAttribute("d").includes("L"), "the progress trace grows across polls");
  assert.equal(room.querySelector("img[data-live]")._uid, imgId, "the room camera is not restarted by a poll");

  overlay.querySelector(".p3d-close").click();
  assert.equal(overlay.hidden, true, "closing the room hides the sheet");
  assert.equal(card._uid, page.doc.querySelector(".p3d-card")._uid, "the cards survive the sheet");
});

check("returning to printers before the first payload stays on the skeleton", async () => {
  const page = boot();
  page.view.show(page.host, page.api);          // call 0, left pending
  clickTab(page, "settings");                   // no half-empty form yet
  clickTab(page, "printers");                   // joins call 0; no second request
  const pane = page.doc.querySelector('[data-pane="printers"]');
  assert.equal(page.api.of("/api/print3d/state").length, 1, "the entry joins the in-flight request");
  assert.equal(pane.querySelector(".p3d-empty").hidden, true, "no placeholder empty card");
  assert.equal(pane.querySelector(".p3d-skeleton").hidden, false, "the skeleton still stands in");
  assert.equal(pane.querySelector(".p3d-card"), null, "no card before the first payload");

  page.api.calls[0].d.resolve(state([printer({ name: "Nouvelle" })]));
  await settle();
  assert.equal(text(page.doc.querySelector(".p3d-card strong")), "Nouvelle");
  assert.equal(page.win.timers.size, 1, "the poll resumes after the first payload");
});

check("a configured-but-empty workshop still shows the empty state", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([]));
  await settle();
  assert.equal(page.doc.querySelector(".p3d-empty").hidden, false);
  assert.equal(page.doc.querySelector(".p3d-grid").hidden, true);
  assert.ok(text(page.doc.querySelector(".p3d-empty")).includes("Aucune imprimante"));
});

check("'Retrouver sur MakerWorld' replaces its candidates instead of stacking", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({
    models: [{ id: "m1", name: "Bracket", ext: "3mf", size: 2048, has_thumb: false, tags: [], mtime: 1 }],
    tags: [], total: 1, indexed: 1,
  });
  await settle();
  const opener = page.doc.querySelector(".p3d-model");
  opener.focus();
  opener.click();
  page.api.last("/api/print3d/models/get").d.resolve({
    model: { id: "m1", name: "Bracket", ext: "3mf", size: 2048, tags: [], notes: "n", printed_count: 0, origin: "" },
  });
  await settle();

  const sheet = page.doc.querySelector(".p3d-overlay");
  const candidates = { candidates: [{ id: 11, title: "A", score: 92 }, { id: 12, title: "B", score: 80 }] };
  for (let i = 0; i < 2; i += 1) {
    byText(sheet, "Retrouver sur MakerWorld").click();
    page.api.last("/api/print3d/models/match").d.resolve(candidates);
    await settle();
  }
  assert.equal(page.doc.querySelectorAll(".p3d-mwmatch").length, 1, "one candidate list");
  assert.equal(page.doc.querySelectorAll(".p3d-mwmatch .p3d-tag").length, 2, "two buttons, not four");

  page.doc.dispatchEvent({ type: "keydown", key: "Escape", bubbles: true });
  assert.equal(page.doc.querySelector(".p3d-overlay").hidden, true);
  assert.equal(page.doc.activeElement._uid, opener._uid, "closing the sheet gives focus back to the model card");
});

check("the overlay keeps Tab inside it and reports itself as a modal", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({
    models: [{ id: "m1", name: "Bracket", ext: "3mf", size: 2048, has_thumb: false, tags: [], mtime: 1 }],
    tags: [], total: 1, indexed: 1,
  });
  await settle();
  page.doc.querySelector(".p3d-model").click();
  page.api.last("/api/print3d/models/get").d.resolve({
    model: { id: "m1", name: "Bracket", ext: "3mf", size: 2048, tags: [], notes: "n", printed_count: 0, origin: "" },
  });
  await settle();

  const sheet = page.doc.querySelector(".p3d-overlay");
  assert.ok(sheet.parentNode === page.doc.body, "the overlay is mounted on body, outside .p3d");
  assert.equal(sheet.getAttribute("aria-modal"), "true", "the sheet is modal for assistive tech");
  const box = page.doc.querySelector(".p3d-modal");
  // The same selector trapFocus uses, so both lists are the same by construction.
  const SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
    + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const items = [].slice.call(box.querySelectorAll(SEL));
  assert.ok(items.length >= 3, "the sheet has focusable fields");

  items[items.length - 1].focus();
  page.doc.dispatchEvent({ type: "keydown", key: "Tab", bubbles: true });
  assert.equal(page.doc.activeElement._uid, items[0]._uid, "Tab on the last field wraps to the first");

  items[0].focus();
  page.doc.dispatchEvent({ type: "keydown", key: "Tab", shiftKey: true, bubbles: true });
  assert.equal(page.doc.activeElement._uid, items[items.length - 1]._uid, "Shift+Tab on the first wraps to the last");
});

check("opening another preview disposes the previous viewer", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({
    models: [
      { id: "m1", name: "A.stl", ext: "stl", size: 1000, has_thumb: false, tags: [], mtime: 2 },
      { id: "m2", name: "B.stl", ext: "stl", size: 1000, has_thumb: false, tags: [], mtime: 1 },
    ], tags: [], total: 2, indexed: 2,
  });
  await settle();

  const viewers = [];
  page.win.HQModel = {
    parse: () => ({ triangles: 1 }),
    viewer: () => {
      const v = { disposed: 0, model: null, setModel(m) { this.model = m; }, dispose() { this.disposed += 1; } };
      viewers.push(v);
      return v;
    },
  };
  const fakeFetch = async () => ({ ok: true, status: 200, body: stream([binaryHeader(1), new Uint8Array(50)]).body });
  page.sandbox.fetch = fakeFetch;

  function open(id) {
    page.doc.querySelector('.p3d-model[data-id="' + id + '"]').click();
    page.api.last("/api/print3d/models/get").d.resolve({
      model: { id, name: id + ".stl", ext: "stl", size: 1000, has_thumb: false, tags: [], notes: "",
        printed_count: 0, origin: "", makerworld_design_id: 0 },
    });
  }

  open("m1");
  await tick(40);
  assert.equal(viewers.length, 1, "the first preview builds a viewer");
  open("m2");
  await tick(40);
  assert.equal(viewers.length, 2, "the second model builds its own viewer");
  assert.equal(viewers[0].disposed, 1, "opening another model disposes the previous viewer");

  page.doc.dispatchEvent({ type: "keydown", key: "Escape", bubbles: true });
  assert.equal(viewers[1].disposed, 1, "closing the sheet disposes the live viewer");

  open("m1");
  await tick(40);
  assert.equal(viewers.length, 3, "reopening the same model builds a fresh viewer");
  assert.equal(viewers[2].disposed, 0);
  page.doc.dispatchEvent({ type: "keydown", key: "Escape", bubbles: true });
  assert.equal(viewers[2].disposed, 1);
  assert.ok(viewers.every((v) => v.disposed === 1), "no viewer is left live");
});

check("model detail preflights the parsed mesh and labels the estimate", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const initial = state([printer()]);
  initial.config.printers[0].bed = { x: 20, y: 20, z: 20 };
  initial.config.filament = { currency: "$", prices: { PLA: 25 }, default_price_kg: 25 };
  page.api.calls[0].d.resolve(initial);
  await settle();

  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({
    models: [{ id: "m1", name: "Cube.stl", ext: "stl", size: 1000, has_thumb: false, tags: [], mtime: 1 }],
    tags: [], total: 1, indexed: 1,
  });
  await settle();

  page.win.HQModel = {
    parse: () => ({ triangles: 12,
      bounds: { min: [0, 0, 0], max: [10, 20, 30], center: [5, 10, 15], radius: 18.7 },
      volume_mm3: 6000 }),
    viewer: () => ({ setModel() {}, dispose() {} }),
  };
  page.sandbox.fetch = async (url, opts) => {
    if (opts && opts.headers && opts.headers.Range)
      return { ok: true, status: 206, arrayBuffer: async () => binaryHeader(12).buffer };
    return { ok: true, status: 200, body: stream([binaryHeader(12)]).body };
  };

  page.doc.querySelector('.p3d-model[data-id="m1"]').click();
  page.api.last("/api/print3d/models/get").d.resolve({
    model: { id: "m1", name: "Cube.stl", ext: "stl", size: 1000, has_thumb: false, tags: [], notes: "",
      printed_count: 0, origin: "", makerworld_design_id: 0 },
  });
  await tick(40);

  const box = page.doc.querySelector(".p3d-preflight");
  assert.equal(box.hidden, false, "the preflight appears after the mesh parses");
  const body = text(box);
  assert.match(body, /Encombrement : 10 × 20 × 30 mm/);
  assert.match(body, /Plateau A1 mini .* : dépasse \(Z 30 > 20 mm\)/);
  assert.match(body, /Estimation matière : ≈ 7,4 g PLA \(volume plein, sans supports\)/);
  assert.match(body, /coût ≈ 0,19 \$/);
  assert.match(body, /Estimation seulement/);
});

check("the body-mounted overlay resolves the timing tokens its entry uses", () => {
  const css = readFileSync(new URL("../assets/hq-print3d.css", import.meta.url), "utf8");

  // The sheet is appended to <body>: tokens scoped to .p3d never reach it, so its animation
  // shorthand would be invalid and nothing would fade or rise. They must live on the root.
  const head = css.slice(0, css.indexOf(".p3d {"));
  assert.match(head, /--p3d-fast:\s*180ms/, "the fast timing token resolves outside .p3d");
  assert.match(head, /--p3d-ease:\s*cubic-bezier/, "the easing token resolves outside .p3d");

  assert.match(css, /\.p3d-overlay\s*\{[^}]*animation:\s*p3d-overlay-in\s+var\(--p3d-fast\)\s+var\(--p3d-ease\)/,
    "the overlay fade runs with the shared tokens");
  assert.match(css, /@keyframes p3d-overlay-in\s*\{/, "the overlay fade keyframes exist");
  assert.match(css, /\.p3d-modal\s*\{[^}]*animation:\s*p3d-sheet-in\s+var\(--p3d-fast\)\s+var\(--p3d-ease\)/,
    "the sheet rise runs with the shared tokens");
  assert.match(css, /@keyframes p3d-sheet-in\s*\{/, "the sheet rise keyframes exist");
});

check("the focus room scrolls inside its sheet so the close button cannot leave", () => {
  const css = readFileSync(new URL("../assets/hq-print3d.css", import.meta.url), "utf8");

  // The ✕ is absolutely positioned inside .p3d-modal: if the modal scrolls, it scrolls away with the content.
  assert.match(css, /\.p3d-modal\.is-room\s*\{[^}]*overflow:\s*hidden/, "the room sheet itself does not scroll");
  assert.match(css, /\.p3d-modal\.is-room\s*>\s*\.p3d-room\s*\{[^}]*overflow:\s*auto/, "the room content scrolls inside it");
  assert.match(css, /\.p3d-modal\s*\{[^}]*overflow:\s*auto/, "the other sheets keep scrolling as a whole");
});

check("changing the filament period keeps unsaved prices", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "filament");
  page.api.last("/api/print3d/filament").d.resolve(filamentPayload());
  await settle();

  const priceForm = page.doc.querySelector(".p3d-fil-price");
  const currency = priceForm.querySelector("input");
  assert.ok(currency, "the price form is built");
  currency.value = "CHF";

  const pane = page.doc.querySelector('[data-pane="filament"]');
  byText(pane, "7 jours").click();
  assert.ok(page.api.last("/api/print3d/filament").url.includes("period=7d"));
  page.api.last("/api/print3d/filament").d.resolve(filamentPayload());
  await settle();

  assert.equal(page.doc.querySelector(".p3d-fil-price input")._uid, currency._uid, "the form is not rebuilt on a period change");
  assert.equal(page.doc.querySelectorAll(".p3d-fil-price form").length, 1, "and not appended a second time");
  assert.equal(currency.value, "CHF", "the typed, unsaved value survives");
});

check("a stale models reply cannot win, and the list is reused for a minute", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "models");
  const base = page.api.last("/api/print3d/models");
  base.d.resolve({ models: [{ id: "a", name: "Base", ext: "stl", size: 10, has_thumb: false, tags: [], mtime: 1 }], tags: [], total: 1, indexed: 1 });
  await settle();
  assert.ok(text(page.doc.querySelector('[data-pane="models"]')).includes("Base"));

  const selects = page.doc.querySelectorAll('[data-pane="models"] select');
  assert.ok(selects.length, "the toolbar has its filters");
  selects[0].value = "owned";                    // two queries in flight, the newer answers first
  selects[0].dispatchEvent({ type: "change" });
  const older = page.api.last("/api/print3d/models");
  selects[0].value = "designed";
  selects[0].dispatchEvent({ type: "change" });
  const newer = page.api.last("/api/print3d/models");
  assert.notEqual(newer, older);

  newer.d.resolve({ models: [{ id: "b", name: "Récent", ext: "stl", size: 10, has_thumb: false, tags: [], mtime: 9 }], tags: [], total: 1, indexed: 1 });
  await settle();
  assert.ok(text(page.doc.querySelector('[data-pane="models"]')).includes("Récent"));

  older.d.resolve({ models: [{ id: "c", name: "Vieux", ext: "stl", size: 10, has_thumb: false, tags: [], mtime: 5 }], tags: [], total: 1, indexed: 1 });
  await settle();
  assert.ok(!text(page.doc.querySelector('[data-pane="models"]')).includes("Vieux"), "the older reply is dropped");

  const asked = page.api.of("/api/print3d/models").length;
  clickTab(page, "printers");
  clickTab(page, "models");
  await settle();
  assert.equal(page.api.of("/api/print3d/models").length, asked, "the same query is reused for a minute");
});

check("returning to a cached model query drops an older in-flight reply", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({
    models: [{ id: "a", name: "Base", ext: "stl", size: 10, has_thumb: false, tags: [], mtime: 1 }],
    tags: [], total: 1, indexed: 1,
  });
  await settle();

  const selects = page.doc.querySelectorAll('[data-pane="models"] select');
  selects[0].value = "owned";                    // a query that stays in flight
  selects[0].dispatchEvent({ type: "change" });
  const older = page.api.last("/api/print3d/models");
  assert.ok(older.url.includes("origin=owned"));

  const asked = page.api.of("/api/print3d/models").length;
  selects[0].value = "";                         // cached initial query, no new request
  selects[0].dispatchEvent({ type: "change" });
  await settle();
  assert.equal(page.api.of("/api/print3d/models").length, asked, "the fresh cached query is reused");

  older.d.resolve({ models: [{ id: "old", name: "Vieux", ext: "stl", size: 10, has_thumb: false, tags: [], mtime: 5 }],
    tags: [], total: 1, indexed: 1 });
  await settle();
  const pane = text(page.doc.querySelector('[data-pane="models"]'));
  assert.ok(pane.includes("Base"), "the cached result stays on screen");
  assert.ok(!pane.includes("Vieux"), "the older query's late reply is dropped");
});

check("a job with no filament figure still gets a correction button", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "filament");
  page.api.last("/api/print3d/filament").d.resolve(filamentPayload({
    totals: { g: 0, m: 0, cost: 0, jobs: 1, with_data: 0, wasted_g: 0, wasted_cost: 0 },
    recent: [{ id: "j1", job: "Bracket", printer_name: "A1 mini", outcome: "finished", at: NOW() - 30, filament: null }],
  }));
  await settle();

  const body = page.doc.querySelector(".p3d-fil-body");
  const btn = byText(body, "Saisir");
  assert.ok(btn, "the row without a figure offers a fix");
  btn.click();
  const sheet = page.doc.querySelector(".p3d-overlay");
  assert.equal(sheet.hidden, false, "the weight editor opens");
  assert.ok(text(sheet).includes("Corriger le poids"));
  sheet.id = "p3d-test-sheet";
  page.doc.dispatchEvent({ type: "keydown", key: "Escape", bubbles: true });
  assert.equal(sheet.hidden, true, "Escape closes the sheet");
});

check("tablist and status line meet the a11y contract", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();

  const tabs = page.doc.querySelector(".p3d-tabs");
  const buttons = every(tabs).filter((n) => n.dataset.tab);
  assert.equal(buttons.length, 6);
  for (const b of buttons) {
    assert.equal(b.getAttribute("aria-controls"), "p3d-pane-" + b.dataset.tab, "aria-controls points at its panel");
    assert.ok(page.doc.getElementById("p3d-pane-" + b.dataset.tab).getAttribute("aria-labelledby") === b.id, "panel is labelled by its tab");
  }
  assert.equal(buttons[0].tabIndex, 0, "one roving tab stop");
  assert.equal(buttons[1].tabIndex, -1);

  const sub = page.doc.getElementById("p3d-sub");
  assert.equal(sub.getAttribute("role"), "status");
  assert.equal(sub.getAttribute("aria-live"), "polite");
  assert.equal(page.doc.querySelector(".p3d-overlay").getAttribute("role"), "dialog");

  buttons[0].focus();
  tabs.dispatchEvent({ type: "keydown", key: "ArrowRight", bubbles: true });
  assert.equal(page.doc.activeElement._uid, buttons[1]._uid, "ArrowRight moves focus");
  assert.equal(buttons[1].getAttribute("aria-selected"), "true");
  assert.equal(buttons[0].getAttribute("aria-selected"), "false");
  assert.equal(buttons[1].tabIndex, 0);
});

check("an offline printer says since when, and a failed camera offers a retry", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  const card = page.doc.querySelector(".p3d-card");
  byText(card, "📷 En direct").click();
  const img = page.doc.querySelector("img[data-live]");
  const src = img.getAttribute("src");

  img.dispatchEvent({ type: "error" });
  const retry = byText(card, "Réessayer");
  assert.ok(retry, "a camera failure offers a retry");
  retry.click();
  const retried = page.doc.querySelector("img[data-live]");
  assert.notEqual(retried._uid, img._uid, "the retry reopens the stream");
  assert.equal(retried.getAttribute("src"), src);

  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(state([printer({
    // at is the last retry (just now); since is when the outage began: the card must read since.
    link: { online: false, at: NOW(), since: NOW() - 3600, error: "Connexion refusée" },
  })]));
  await settle();
  const warn = page.doc.querySelector(".p3d-card .p3d-warn");
  assert.equal(warn.hidden, false);
  assert.ok(text(warn).includes("Connexion refusée"));
  assert.ok(text(warn).includes("depuis 1\u00A0h"), "the card says how long it has been offline, without a doubled 'il y a'");
  assert.ok(!text(warn).includes("depuis il y a"), "no 'depuis il y a'");

  // Offline, the room drops the rows that can only hold a dash and keeps the line that explains the silence.
  byText(page.doc.querySelector(".p3d-card"), "Voir le poste").click();
  const room = page.doc.querySelector(".p3d-room");
  const rows = [...room.querySelectorAll(".p3d-room-line")];
  const byLabel = (l) => rows.find((r) => text(r.querySelector("span")) === l);
  assert.equal(byLabel("Progression / fin").hidden, true, "an offline printer has no progress row to show");
  assert.equal(byLabel("Lumière").hidden, true, "nor a light row it cannot read");
  assert.equal(byLabel("Températures").hidden, false, "a reading it does have stays");
  assert.equal(byLabel("Liaison").hidden, false, "the link line always stays");
});

check("a raw offline status is labelled in French, with one offline class", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  // The backend may report state=offline itself, while the link still answers: the two signals
  // describe the same thing and must not be stacked into "p3d-card is-offline is-offline".
  page.api.calls[0].d.resolve(state([printer({ status: { state: "offline" }, link: { online: true } })]));
  await settle();
  const card = page.doc.querySelector(".p3d-card");
  assert.equal(text(card.querySelector(".p3d-pill")), "Hors ligne", "the state label is translated, never the raw key");
  assert.equal((card.className.match(/is-offline/g) || []).length, 1, "the state and the link do not add the class twice");
  assert.equal(card.querySelector(".p3d-warn").hidden, true, "a link that answers is not turned into a warning");

  const offlineCell = [...page.doc.querySelectorAll(".p3d-floor-cell")].find((c) => text(c).includes("Hors ligne"));
  assert.equal(text(offlineCell.querySelector("strong")), "0", "the floor counts the link, not the state");
  assert.equal(offlineCell.classList.contains("is-quiet"), true, "a zero stays neutral, even for a state-only outage");
});

check("a printer with no AMS folds its empty section away in the focus room", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  byText(page.doc.querySelector(".p3d-card"), "Voir le poste").click();

  const room = page.doc.querySelector(".p3d-overlay .p3d-room");
  const title = room.querySelector("h4.p3d-h3");
  assert.ok(title && text(title).includes("AMS / bobines"), "the section title exists");
  assert.equal(title.hidden, true, "the title folds away when there is nothing to list");
  assert.equal(room.querySelector(".p3d-room-slots").hidden, true, "and so does its empty list");

  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(state([printer({
    status: { state: "idle", nozzle: 24, bed: 22, external_spool: { material: "PLA", colour: "#ff8fd8" } },
  })]));
  await settle();
  assert.equal(title.hidden, false, "an external spool brings the section back");
  assert.ok(text(room).includes("PLA"), "and names the spool");
});

check("AMS says what is loaded and warns when the job's material is missing", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer({ status: {
    state: "printing", job: "clip.gcode",
    ams: [{ slot: 1, material: "PETG", colour: "#111111", remain: 50, active: true, loaded: true },
      { slot: 2, material: "", colour: "", remain: null, active: false, loaded: false }],
    required: { job: "clip.gcode", materials: ["PLA"] } } })]));
  await settle();
  const card = page.doc.querySelector(".p3d-card");
  const note = card.querySelector(".p3d-ams-note");
  assert.equal(note.hidden, false, "the missing material is named");
  assert.match(text(note), /PLA/);
  assert.match(text(note), /non chargé/);
  assert.match(text(note), /PETG/);
  const slots = card.querySelector(".p3d-ams");
  assert.ok(!/%/.test(slots.innerHTML), "no percentage anywhere in the slots");
  assert.ok(text(slots).includes("vide"), "an empty slot says so");

  firePoll(page);
  // No `loaded` at all: a named material must count as loaded, never render the whole AMS "vide".
  page.api.last("/api/print3d/state").d.resolve(state([printer({ status: {
    state: "printing", job: "clip.gcode",
    ams: [{ slot: 1, material: "PLA", colour: "#111111", active: true }] } })]));
  await settle();
  assert.equal(note.hidden, true, "the material name is enough: no missing-material warning");
  assert.ok(!text(slots).includes("vide"), "and the slot is not called empty");
});

check("one image grade, the same in both themes, brightens the live view and its still", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer({ status: { state: "printing", job: "clip.gcode", progress: 10 } })]));
  await settle();
  const html = page.doc.documentElement;
  assert.equal(html.style.getPropertyValue("--p3d-look"),
    "brightness(1.110) contrast(1.070) saturate(1.050)", "the default grade is the documented one");
  byText(page.doc.querySelector(".p3d-card"), "Voir le poste").click();
  const range = page.doc.querySelector(".p3d-room .p3d-look-range");
  assert.ok(range, "the room exposes the grade");
  assert.equal(String(range.value), "50", "it starts on the default");
  range.value = "100";
  range.dispatchEvent({ type: "input" });
  assert.equal(html.style.getPropertyValue("--p3d-look"),
    "brightness(1.220) contrast(1.140) saturate(1.100)", "the stronger grade reaches every camera");
  assert.equal(page.win.localStorage.getItem("p3d.look"), "100", "and is remembered");

  const css = readFileSync(new URL("../assets/hq-print3d.css", import.meta.url), "utf8");
  assert.match(css, /\.p3d-cam img\s*\{[^}]*filter:\s*var\(--p3d-look/, "the live frame and its still share the grade");
  assert.match(css, /\.p3d-cam-full img\s*\{[^}]*filter:\s*var\(--p3d-look/, "the fullscreen frame too");
  assert.match(css, /\.p3d-fade-layer\s*\{[^}]*filter:\s*var\(--p3d-look/, "and the crossfade canvases");
});

check("each card says when the watcher last looked and when it looks next", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const t = NOW();
  const watched = state([printer({ status: { state: "printing", progress: 40, watch: {
    verdict: "ok", reason: "", checked: t - 120, looked: t - 120, next: t + 120, checks: 1, alarm: null } } })]);
  watched.config.watch = { enabled: true, interval_sec: 180 };
  page.api.calls[0].d.resolve(watched);
  await settle();

  const line = page.doc.querySelector(".p3d-card .p3d-watch");
  assert.ok(line, "the card carries the watcher line");
  assert.ok(text(line).includes("dernière vérification il y a 2\u00A0min"), "it says when the watcher last looked");
  assert.ok(text(line).includes("prochaine dans 2\u00A0min"), "and when it looks next");
  assert.equal(line.classList.contains("is-overdue"), false);

  firePoll(page);
  const late = state([printer({ status: { state: "printing", progress: 41, watch: {
    verdict: "ok", reason: "", checked: t - 120, looked: t - 120, next: NOW() - 300, checks: 1, alarm: null } } })]);
  late.config.watch = { enabled: true, interval_sec: 180 };
  page.api.last("/api/print3d/state").d.resolve(late);
  await settle();
  const stale = page.doc.querySelector(".p3d-card .p3d-watch");
  assert.ok(stale.classList.contains("is-overdue"), "a next look long past is flagged");
  assert.ok(text(stale).includes("prochaine vérification dépassée depuis 5\u00A0min"));
  assert.equal(text(page.doc.querySelector(".p3d-card .p3d-alerts")), "", "no alarm is needed to see the watcher is stale");

  firePoll(page);
  const idle = state([printer()]);
  idle.config.watch = { enabled: true };
  page.api.last("/api/print3d/state").d.resolve(idle);
  await settle();
  assert.ok(text(page.doc.querySelector(".p3d-card .p3d-watch")).includes("en attente d'une impression"));

  firePoll(page);
  const off = state([printer()]);
  off.config.watch = { enabled: false };
  page.api.last("/api/print3d/state").d.resolve(off);
  await settle();
  assert.ok(text(page.doc.querySelector(".p3d-card .p3d-watch")).includes("Surveillance désactivée"));
});

check("uploads show progress, and a failure stays on screen with its reason", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [], tags: [], total: 0, indexed: 0 });
  await settle();

  page.net.on("/api/upload/chunk", () => ({ status: 507, body: { error: "Disque plein" } }));
  const input = page.doc.querySelector('input[type="file"]');
  assert.ok(input, "the upload input is there");
  input.files = [{ name: "gros.3mf", size: 4, slice: (a, b) => ({ arrayBuffer: async () => new Uint8Array(b - a).buffer }) }];
  input.dispatchEvent({ type: "change" });
  await settle();

  const bar = page.doc.querySelector(".p3d-upload");
  const label = page.doc.querySelector(".p3d-upload .p3d-meta");
  assert.equal(bar.hidden, false, "the progress bar appears");
  assert.ok(text(label).includes("Envoi 1/1"), "it names the file being sent");

  page.api.last("/api/upload/init").d.resolve({ id: "u1", chunk: 2 });
  await settle();
  assert.ok(page.net.callsTo("/api/upload/chunk")[0].body instanceof ArrayBuffer, "the chunk is sent as raw bytes");

  assert.equal(bar.hidden, false, "a failed upload keeps its bar instead of vanishing");
  assert.ok(bar.classList.contains("is-error"), "the bar is marked as failed");
  assert.equal(text(label), "Échec : Disque plein", "the reason is on screen, not only in a toast");
});

check("an upload can be cancelled from its bar", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [], tags: [], total: 0, indexed: 0 });
  await settle();

  const input = page.doc.querySelector('input[type="file"]');
  input.files = [{ name: "gros.3mf", size: 4, slice: (a, b) => ({ arrayBuffer: async () => new Uint8Array(b - a).buffer }) }];
  input.dispatchEvent({ type: "change" });
  await settle();
  page.api.last("/api/upload/init").d.resolve({ id: "u2", chunk: 2 });

  const cancel = byText(page.doc, "Annuler");
  assert.ok(cancel && cancel.hidden === false, "the bar offers Annuler while it sends");
  cancel.click();
  await settle();

  const bar = page.doc.querySelector(".p3d-upload");
  assert.equal(page.net.callsTo("/api/upload/chunk").length, 0, "no chunk is sent after the cancel");
  assert.equal(text(page.doc.querySelector(".p3d-upload .p3d-meta")), "Téléversement annulé");
  assert.equal(bar.classList.contains("is-error"), false, "a cancel is not a failure");
});

check("one gateway blip on a chunk is retried, and the upload finishes", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [], tags: [], total: 0, indexed: 0 });
  await settle();

  let n = 0;
  page.net.on("/api/upload/chunk", () => (++n === 1 ? { status: 503, body: { error: "indisponible" } } : { status: 200, body: {} }));
  const input = page.doc.querySelector('input[type="file"]');
  input.files = [{ name: "gros.3mf", size: 4, slice: (a, b) => ({ arrayBuffer: async () => new Uint8Array(b - a).buffer }) }];
  input.dispatchEvent({ type: "change" });
  await settle();
  page.api.last("/api/upload/init").d.resolve({ id: "u3", chunk: 2 });
  await settle();
  assert.equal(page.net.callsTo("/api/upload/chunk").length, 1, "the first attempt is refused");

  const wait = [...page.win.timers.entries()].find(([, t]) => !t.interval && t.ms === 400);
  assert.ok(wait, "the retry waits before sending again");
  page.win.timers.delete(wait[0]);
  wait[1].fn();
  await settle();
  assert.equal(page.net.callsTo("/api/upload/chunk").length, 3, "the chunk is retried, then the next one goes");

  page.api.last("/api/upload/complete").d.resolve({ ok: true });
  await settle();
  assert.equal(page.doc.querySelector(".p3d-upload").hidden, true, "the bar leaves once everything is sent");
});

check("the poll follows the state: 10 s idle, 4 s printing, 5 s after two failures", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  assert.equal(firePoll(page), 10000, "an idle workshop waits 10 s");

  page.api.last("/api/print3d/state").d.resolve(state([printer({ status: { state: "printing", progress: 3 } })]));
  await settle();
  assert.equal(firePoll(page), 4000, "a running job polls every 4 s");

  page.api.last("/api/print3d/state").d.reject(new Error("boom"));
  await settle();
  assert.equal(firePoll(page), 4000, "one failure keeps the normal delay");

  page.api.last("/api/print3d/state").d.reject(new Error("boom"));
  await settle();
  assert.equal(firePoll(page), 5000, "two failures back off");
});

check("an upload shows its real progress and ends with one toast", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [], tags: [], total: 0, indexed: 0 });
  await settle();

  const pending = [];
  page.net.on("/api/upload/chunk", () => new Promise((resolve) => pending.push(resolve)));
  const input = page.doc.querySelector('input[type="file"]');
  input.files = [{ name: "deux.3mf", size: 4, slice: (a, b) => ({ arrayBuffer: async () => new Uint8Array(b - a).buffer }) }];
  input.dispatchEvent({ type: "change" });
  await settle();
  page.api.last("/api/upload/init").d.resolve({ id: "u4", chunk: 2 });
  await settle();
  assert.equal(pending.length, 1, "the first chunk is sent");

  pending[0]({ status: 200, body: {} });
  await settle();
  assert.ok(text(page.doc.querySelector(".p3d-upload .p3d-meta")).includes("50 %"), "half the file reads as half");
  assert.equal(page.doc.querySelector(".p3d-upload-track span").style.width, "50.0%", "the bar follows the bytes");
  assert.equal(pending.length, 2, "the second chunk follows");

  pending[1]({ status: 200, body: {} });
  await settle();
  const complete = page.api.last("/api/upload/complete");
  assert.ok(complete, "the upload is completed once the bytes are in");
  complete.d.resolve({ ok: true });
  await settle();

  assert.equal(page.doc.querySelector(".p3d-upload").hidden, true, "the bar leaves when it is done");
  const toasts = page.win.toasts.filter((t) => t.message.indexOf("fichier(s) ajouté(s)") >= 0);
  assert.equal(toasts.length, 1, "one toast for the batch, not one per file");
});

check("a running job shows its remaining time and the finish clock", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer({ status: { state: "printing", progress: 40, remaining_sec: 600 } })]));
  await settle();
  const card = page.doc.querySelector(".p3d-card");
  assert.ok(text(card).includes("reste 10\u00A0min"), "the remaining time is on the card, value and unit unbroken");
  assert.ok(/vers \d\d:\d\d/.test(text(card)), "and the wall-clock finish");
});

check("an unchanged state costs a 304 and leaves the cards alone", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(Object.assign(state([printer()]), { etag: '"v1"' }));
  await settle();
  const card = page.doc.querySelector(".p3d-card");

  assert.equal(firePoll(page) >= 1000, true, "the next poll is armed");
  const second = page.api.last("/api/print3d/state");
  assert.equal(second.opts.headers["If-None-Match"], '"v1"', "the poll revalidates");
  const err = new Error("304"); err.status = 304;
  second.d.reject(err);
  await settle();

  assert.equal(page.doc.querySelector(".p3d-card")._uid, card._uid, "a 304 rebuilds nothing");
  assert.ok(!text(page.doc.querySelector("#p3d-sub")).includes("injoignable"), "a 304 is not a failure");
  assert.ok([...page.win.timers.values()].some((t) => !t.interval), "polling goes on");
});

check("an expired session says so and stops polling", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const err = new Error("PIN requis"); err.status = 401;
  page.api.calls[0].d.reject(err);
  await settle();
  assert.ok(text(page.doc.querySelector("#p3d-sub")).includes("Session expirée"), "not 'injoignable'");
  assert.equal([...page.win.timers.values()].filter((t) => !t.interval).length, 0, "no more polls");
  page.view.hide();
  page.view.show(page.host, page.api);
  await settle();
  assert.equal(page.api.of("/api/print3d/state").length, 1, "showing again does not hammer a dead session");
});

check("the library pages instead of hiding rows past the first page", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "models");
  const row = (id, name) => ({ id, name, ext: "stl", size: 10, mtime: 1, folder: "Print", tags: [], origin: "", has_thumb: false });
  page.api.last("/api/print3d/models").d.resolve({ models: [row("a", "A"), row("b", "B")], tags: [], total: 3, indexed: 3 });
  await settle();

  assert.equal(page.doc.querySelectorAll(".p3d-model").length, 2);
  const more = page.doc.querySelector(".p3d-more");
  assert.equal(more.hidden, false, "the rest of the library is reachable");
  assert.equal(text(more), "Afficher plus (1 restant(s))");
  more.click();
  const second = page.api.last("/api/print3d/models");
  assert.ok(second.url.includes("offset=2"), "the next page starts where the first ended");
  second.d.resolve({ models: [row("c", "C")], tags: [], total: 3, indexed: 3 });
  await settle();

  assert.equal(page.doc.querySelectorAll(".p3d-model").length, 3, "the page is appended, not replaced");
  assert.equal(more.hidden, true);
});

check("a re-render reuses the tiles and the toolbar it already has", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "models");
  const row = { id: "a", name: "A", ext: "stl", size: 10, mtime: 1, folder: "Print", tags: [], origin: "", has_thumb: false };
  page.api.last("/api/print3d/models").d.resolve({ models: [row], tags: ["pla", 1], total: 1, indexed: 1 });
  await settle();

  const search = page.doc.querySelector("#p3d-q");
  const tile = page.doc.querySelector(".p3d-model");
  const sort = page.doc.querySelector('[aria-label="Tri"]');
  sort.value = "name";
  sort.dispatchEvent({ type: "change" });
  await settle();

  assert.equal(page.doc.querySelector("#p3d-q")._uid, search._uid, "the toolbar is not rebuilt");
  assert.equal(page.doc.querySelector(".p3d-model")._uid, tile._uid, "the tile is reused");
});

check("the poll budget is reported to the client-debug HUD", async () => {
  const page = boot();
  const marks = [];
  page.win.hqPerfMark = (sub, data) => marks.push({ sub, data });
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(state([printer()]));
  await settle();
  page.view._hooks.flushPollStats();

  const mark = marks.filter((m) => m.data.op === "poll-min").pop();
  assert.ok(mark, "a poll-min mark is emitted");
  assert.equal(mark.sub, "print3d");
  assert.equal(mark.data.polls, 2);
  assert.ok(mark.data.per_min >= 1, "requests per minute are reported");
});

check("a hidden page stops polling and drops the camera, and refreshes on return", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  const card = page.doc.querySelector(".p3d-card");
  byText(card, "📷 En direct").click();

  page.doc.hidden = true;
  page.doc.dispatchEvent({ type: "visibilitychange" });
  assert.equal(page.win.timers.size, 0, "no timer while the page is hidden");
  const img = page.doc.querySelector("img[data-live]");
  assert.ok(!img || !img.getAttribute("src"), "the MJPEG request is dropped while hidden");

  const before = page.api.of("/api/print3d/state").length;
  page.doc.hidden = false;
  page.doc.dispatchEvent({ type: "visibilitychange" });
  assert.equal(page.api.of("/api/print3d/state").length, before + 1, "coming back refreshes at once");
});

check("an old 42 % is flagged after sleep and reconnect", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer({ status: { state: "printing", progress: 42 } })]));
  await settle();
  assert.equal(page.doc.querySelector(".p3d-age").hidden, true, "fresh data has no age badge");

  const real = Date.now();
  const future = real + 3600 * 1000;
  try {
    vm.runInContext("Date.now = () => " + future, page.ctx);
    page.doc.hidden = true;
    page.doc.dispatchEvent({ type: "visibilitychange" });
    page.doc.hidden = false;
    page.doc.dispatchEvent({ type: "visibilitychange" });

    const badge = page.doc.querySelector(".p3d-age");
    assert.equal(page.api.of("/api/print3d/state").length, 2, "coming back fetches");
    assert.equal(badge.hidden, false, "the age badge appears after sleep");
    assert.ok(text(badge).includes("il y a 1\u00A0h"), "it says how old the displayed state is");
    assert.ok(text(page.doc.querySelector(".p3d-card")).includes("42"), "the old value stays visible while it is marked");
    assert.ok(page.doc.querySelector(".p3d").classList.contains("is-stale"));

    page.api.last("/api/print3d/state").d.resolve(state([printer({ status: { state: "printing", progress: 43 } })]));
    await settle();
    assert.equal(page.doc.querySelector(".p3d-age").hidden, true, "fresh data clears the badge");
    assert.ok(!page.doc.querySelector(".p3d").classList.contains("is-stale"));
    assert.ok(text(page.doc.querySelector(".p3d-card")).includes("43"));

    vm.runInContext("Date.now = () => " + (future + 5000), page.ctx);
    page.win.dispatchEvent({ type: "online" });
    assert.equal(page.doc.querySelector(".p3d-age").hidden, false, "a reconnect shows the age");
    page.api.last("/api/print3d/state").d.resolve(state([printer({ status: { state: "printing", progress: 44 } })]));
    await settle();
    assert.equal(page.doc.querySelector(".p3d-age").hidden, true, "the reconnect fetch clears it");
  } finally {
    vm.runInContext("Date.now = () => " + real, page.ctx);
  }
});

check("a printing job that stops moving is named, not left green", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer({ status: { state: "printing", progress: 42, layer: 10, bed: 60 } })]));
  await settle();
  assert.equal(page.doc.querySelector(".p3d-stall").hidden, true, "a moving job raises nothing");

  const real = Date.now(), future = real + 7 * 60 * 1000;
  try {
    vm.runInContext("Date.now = () => " + future, page.ctx);
    firePoll(page);
    page.api.last("/api/print3d/state").d.resolve(state([printer({ status: { state: "printing", progress: 42, layer: 10, bed: 61 } })]));
    await settle();

    const stall = page.doc.querySelector(".p3d-stall");
    assert.equal(stall.hidden, false, "six silent minutes raise the amber line");
    assert.match(text(stall), /^Pas de progrès depuis 7\u00A0min$/, text(stall));
    const say = page.doc.querySelector(".p3d-say");
    assert.ok(text(say).includes("n'avance plus"), "Elsea says it too");
    assert.ok(say.classList.contains("is-warn"), "and the line turns to warning");
  } finally {
    vm.runInContext("Date.now = () => " + real, page.ctx);
  }
});

check("hide() stops the poll and closes the camera", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  const card = page.doc.querySelector(".p3d-card");
  byText(card, "📷 En direct").click();
  assert.ok(page.doc.querySelector("img[data-live]").getAttribute("src"));

  page.view.hide();
  assert.equal(page.win.timers.size, 0, "no poll survives leaving the view");
  const img = page.doc.querySelector("img[data-live]");
  assert.ok(!img || !img.getAttribute("src"), "the MJPEG request is dropped");
});

check("a tab switch moves the underline and fades its pane in", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();

  const line = page.doc.querySelector(".p3d-tabline");
  assert.ok(line, "the tablist carries one moving underline");
  assert.equal(line.getAttribute("aria-hidden"), "true", "it is decoration, not a second tab");
  assert.match(line.style.transform, /^translateX\(/, "the underline is placed from the active tab");

  clickTab(page, "models");
  assert.ok(page.doc.querySelector("#p3d-pane-models").classList.contains("is-enter"), "the entered pane fades in");
  assert.ok(!page.doc.querySelector("#p3d-pane-printers").classList.contains("is-enter"), "the left pane does not");
  clickTab(page, "printers");
  assert.ok(page.doc.querySelector("#p3d-pane-printers").classList.contains("is-enter"), "a switch back animates again");
  assert.ok(!page.doc.querySelector("#p3d-pane-models").classList.contains("is-enter"));
});

check("a running print glides its bar and ticks the number only on a real change", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const running = (pct) => state([printer({ status: { state: "printing", progress: pct, nozzle: 210, bed: 60,
    job: "Pièce", total_layers: 100, layer: 40, remaining_sec: 600 } })]);
  page.api.calls[0].d.resolve(running(42));
  await settle();

  const fill = page.doc.querySelector(".p3d-progress span");
  const meta = page.doc.querySelector(".p3d-progress-wrap .p3d-meta");
  assert.equal(fill.style.width, "42.0%");
  assert.ok(meta.classList.contains("is-tick"), "a changed percentage ticks");

  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(running(42));
  await settle();
  assert.ok(!meta.classList.contains("is-tick"), "the same percentage does not tick again");

  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(running(43));
  await settle();
  assert.equal(fill.style.width, "43.0%", "the bar follows the new value");
  assert.ok(meta.classList.contains("is-tick"), "the next real change ticks");
});

check("Réindexer shows its work and cannot be launched twice", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [], tags: [], total: 0, indexed: 0 });
  await settle();

  const btn = byText(page.doc.querySelector("#p3d-pane-models"), "Réindexer");
  btn.click();
  btn.click();
  assert.equal(page.api.of("/api/print3d/models/rescan").length, 1, "the second click is a no-op");
  assert.equal(btn.disabled, true, "the button is disabled while it runs");
  assert.equal(text(btn), "Réindexation…", "the label says what is happening");
  assert.ok(btn.classList.contains("is-busy"));

  page.api.last("/api/print3d/models/rescan").d.resolve({});
  await settle();
  page.api.last("/api/print3d/models").d.resolve({ models: [], tags: [], total: 0, indexed: 0 });
  await settle();
  assert.equal(btn.disabled, false, "the button comes back");
  assert.equal(text(btn), "Réindexer", "with its own label");
  assert.ok(!btn.classList.contains("is-busy"));
});

check("saving twice sends one request, and a failed save releases the button", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  clickTab(page, "filament");
  page.api.last("/api/print3d/filament").d.resolve(filamentPayload());
  await settle();

  const form = page.doc.querySelector(".p3d-fil-price form");
  const save = form.querySelector('button[type="submit"]');
  form.dispatchEvent({ type: "submit" });
  form.dispatchEvent({ type: "submit" });
  assert.equal(page.api.of("/api/print3d/settings").length, 1, "one save, not two");
  assert.equal(save.disabled, true);
  assert.equal(text(save), "Enregistrement…");

  page.api.last("/api/print3d/settings").d.reject(new Error("disque plein"));
  await settle();
  assert.equal(save.disabled, false, "a refused save does not leave the button stuck");
  assert.equal(text(save), "Enregistrer");
});

check("the camera shimmers until its first frame, then pulses as live", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer()]));
  await settle();
  byText(page.doc.querySelector(".p3d-card"), "📷 En direct").click();

  const wrap = page.doc.querySelector(".p3d-cam");
  const img = page.doc.querySelector("img[data-live]");
  assert.ok(wrap.classList.contains("is-connecting"), "the sweep runs while the MJPEG attaches");
  assert.ok(page.doc.querySelector(".p3d-cam-live"), "the live dot is present but hidden");
  assert.ok(!wrap.classList.contains("is-live"));

  img.dispatchEvent({ type: "load" });
  assert.ok(wrap.classList.contains("is-live"), "the first frame marks the stream live");
  assert.ok(!wrap.classList.contains("is-connecting"), "and stops the sweep");

  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(state([printer()]));
  await settle();
  assert.equal(page.doc.querySelector("img[data-live]")._uid, img._uid, "a poll never restarts the stream");
  assert.ok(page.doc.querySelector(".p3d-cam").classList.contains("is-live"), "the live state survives the poll");
});

check("only a newly recorded job slides into the history", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const job = (id, at) => ({ id, outcome: "finished", at, job: "Pièce " + id, printer_name: "A1 mini", duration_sec: 600 });
  page.api.calls[0].d.resolve(state([printer()], { history: [job("a", 100)] }));
  await settle();
  const first = page.doc.querySelector(".p3d-history li");
  assert.ok(first && !first.classList.contains("is-new"), "history already there does not animate in");

  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(state([printer()], { history: [job("b", 200), job("a", 100)] }));
  await settle();
  const rows = page.doc.querySelectorAll(".p3d-history li");
  assert.ok(rows[0].classList.contains("is-new"), "the new job slides in");
  assert.ok(!rows[1].classList.contains("is-new"), "the older row stays still");

  firePoll(page);
  page.api.last("/api/print3d/state").d.resolve(state([printer()], { history: [job("b", 200), job("a", 100)] }));
  await settle();
  assert.equal(page.doc.querySelector(".p3d-history li")._uid, rows[0]._uid, "an unchanged list is not rebuilt");
});

check("settings printerForm exposes kind-filtered model dropdown and submits model", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([printer({ model: "A1 mini" })]));
  await settle();
  clickTab(page, "settings");
  const pane = page.doc.querySelector('[data-pane="settings"]');
  const form = pane.querySelector(".p3d-form");
  const kindSel = form.querySelectorAll("select")[0];
  const modelSel = form.querySelector('select[data-field="model"]');
  assert.ok(modelSel, "model dropdown rendered in printer settings");
  const bambuOpts = [].slice.call(modelSel.children).map((o) => o.value);
  assert.deepEqual(bambuOpts, ["A1", "A1 mini", "P1S", "X1C"]);
  kindSel.value = "flashforge";
  kindSel.dispatchEvent({ type: "change" });
  const ffOpts = [].slice.call(modelSel.children).map((o) => o.value);
  assert.deepEqual(ffOpts, ["Creator 5", "AD5X", "AD5M"]);
  modelSel.value = "AD5M";
  form.querySelector("input").value = "Atelier Gauche";
  form.querySelectorAll("input")[1].value = "192.168.1.99";
  form.dispatchEvent({ type: "submit" });
  const savedCall = page.api.last("/api/print3d/printer/save");
  assert.ok(savedCall, "printer/save dispatched");
  const body = JSON.parse(savedCall.opts.body);
  assert.equal(body.model, "AD5M");
});

check("studio propagates configured model, capabilities, material, plate and refuses missing model", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const printersPayload = [
    printer({ id: "p_ad5m", name: "Bureau AD5M", kind: "flashforge", model: "AD5M",
      capabilities: { model: "AD5M", kind: "flashforge", bed: { x: 220, y: 220, z: 220 }, origin: { x: -110, y: -110 }, nozzles: ["0.25", "0.4", "0.6", "0.8"], default_nozzle: "0.4", physical_extruders: 1, max_tools: 1 } }),
    printer({ id: "p_empty", name: "Sans Modele", kind: "bambu", model: "" }),
  ];
  const s = state(printersPayload, {
    config: { printers: printersPayload, makerworld: {}, filament: { currency: "$" } },
  });
  page.api.calls[0].d.resolve(s);
  await settle();

  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [{ id: "m1", name: "cube.stl", ext: "stl", size: 684 }], tags: [], total: 1, indexed: 1 });
  await settle();

  // Open Studio via card button or switch to studio after seeding an item
  clickTab(page, "studio");
  const side = page.doc.querySelector(".p3d-studio-side");
  const selects = side.querySelectorAll("select");
  const plateSel = selects[0];
  const nozSel = selects[1];
  const matSel = selects[2];
  const nozOpts = [].slice.call(nozSel.children).map((o) => o.value);
  assert.deepEqual(nozOpts, ["0.25", "0.4", "0.6", "0.8"], "AD5M exposes compatible nozzles");
  assert.equal(page.doc.querySelectorAll(".p3d-studio-tools .p3d-ctl-row").length, 1, "AD5M shows only 1 extruder T0");

  // Add item via '+ Ajouter'
  byText(page.doc.querySelector(".p3d-studio-bar"), "+ Ajouter").click();
  await settle();
  page.doc.querySelector(".p3d-studio-pick button").click();
  await settle();

  // Update plate, nozzle, material -> check global Matériau syncs T0 and payload reflects AD5M
  const side2 = page.doc.querySelector(".p3d-studio-side");
  const s2 = side2.querySelectorAll("select");
  s2[0].value = "smooth_pei"; s2[0].dispatchEvent({ type: "change" });
  s2[1].value = "0.6"; s2[1].dispatchEvent({ type: "change" });
  s2[2].value = "PETG"; s2[2].dispatchEvent({ type: "change" });
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  const sliceReq = page.api.last("/api/print3d/studio/slice");
  assert.ok(sliceReq, "studio/slice sent");
  const sb = JSON.parse(sliceReq.opts.body);
  assert.equal(sb.printer_id, "p_ad5m");
  assert.equal(sb.printer_model, "AD5M");
  assert.equal(sb.settings.plate_type, "smooth_pei");
  assert.equal(sb.settings.nozzle, "0.6");
  assert.equal(sb.settings.material, "PETG");
  assert.equal(sb.settings.tools[0].material, "PETG");

  // Switching to printer with empty model must NOT send 'A1' or call slice
  const prSel = page.doc.querySelector(".p3d-studio-bar").querySelector("select");
  prSel.value = "p_empty"; prSel.dispatchEvent({ type: "change" });
  await settle();
  const beforeCount = page.api.of("/api/print3d/studio/slice").length;
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  assert.equal(page.api.of("/api/print3d/studio/slice").length, beforeCount, "missing model blocks studio slice");
});

check("studio Imprimer requires explicit confirmation modal before printer/start", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const pr = printer({ id: "p1", name: "A1 Atelier", kind: "bambu", model: "A1" });
  page.api.calls[0].d.resolve(state([pr], { config: { printers: [pr], makerworld: {}, filament: { currency: "$" } } }));
  await settle();

  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [{ id: "m1", name: "cube.stl", ext: "stl", size: 684 }], tags: [], total: 1, indexed: 1 });
  await settle();
  clickTab(page, "studio");
  byText(page.doc.querySelector(".p3d-studio-bar"), "+ Ajouter").click();
  await settle();
  page.doc.querySelector(".p3d-studio-pick button").click();
  await settle();
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  page.api.last("/api/print3d/studio/slice").d.resolve({ model: { id: "m_sliced", name: "cube_studio.gcode.3mf", ext: "3mf" }, info: { printer_model: "A1", filaments: [{ id: 1, type: "PLA" }] } });
  await settle();

  // Clicking Imprimer opens confirmation dialog WITHOUT sending printer/start
  const printBtn = byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer");
  assert.ok(printBtn, "Imprimer button present after slice");
  printBtn.click();
  await settle();
  assert.equal(page.api.of("/api/print3d/printer/start").length, 0, "Imprimer alone sends 0 start requests");
  const modal = page.doc.querySelector(".p3d-print-confirm");
  assert.ok(modal, "confirmation sheet rendered");
  assert.ok(text(modal).includes("A1 Atelier") && text(modal).includes("cube_studio.gcode.3mf"));

  // Cancelling closes overlay with 0 start requests
  byText(modal, "Annuler").click();
  await settle();
  assert.equal(page.api.of("/api/print3d/printer/start").length, 0, "Annuler sends 0 start requests");

  // Confirming dispatches exactly 1 start request
  byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer").click();
  await settle();
  byText(page.doc.querySelector(".p3d-print-confirm"), "Confirmer et lancer").click();
  assert.equal(page.api.of("/api/print3d/printer/start").length, 1, "Confirm sends exactly 1 start request");
});

check("studio invalidates Imprimer on infill or printer change and shows slice-time settings in confirmation", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const printersPayload = [
    printer({ id: "p1", name: "A1 Atelier", kind: "bambu", model: "A1" }),
    printer({ id: "p2", name: "Mini Bureau", kind: "bambu", model: "A1 mini",
      capabilities: { model: "A1 mini", kind: "bambu", bed: { x: 180, y: 180, z: 180 }, origin: { x: 0, y: 0 }, nozzles: ["0.2", "0.4", "0.6", "0.8"], default_nozzle: "0.4", physical_extruders: 1, max_tools: 4 } }),
  ];
  page.api.calls[0].d.resolve(state(printersPayload, { config: { printers: printersPayload, makerworld: {}, filament: { currency: "$" } } }));
  await settle();

  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [{ id: "m1", name: "cube.stl", ext: "stl", size: 684 }], tags: [], total: 1, indexed: 1 });
  await settle();
  clickTab(page, "studio");
  byText(page.doc.querySelector(".p3d-studio-bar"), "+ Ajouter").click();
  await settle();
  page.doc.querySelector(".p3d-studio-pick button").click();
  await settle();

  // Slice at 15% infill
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  page.api.last("/api/print3d/studio/slice").d.resolve({
    model: { id: "m_s15", name: "cube_studio_aaa111.gcode.3mf", ext: "3mf", slice_settings: { printer_model: "A1", nozzle: "0.4", layer_height: "0.20", infill: "15%" } },
    info: { printer_model: "A1", filaments: [{ id: 1, type: "PLA" }] },
  });
  await settle();
  let printBtn = byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer");
  assert.ok(printBtn && !printBtn.hidden && !printBtn.disabled, "Imprimer ready right after slice");
  printBtn.click();
  await settle();
  assert.ok(text(page.doc.querySelector(".p3d-print-confirm")).includes("remplissage 15%"), "confirmation shows slice-time 15%");
  byText(page.doc.querySelector(".p3d-print-confirm"), "Annuler").click();
  await settle();

  // Changing infill immediately invalidates Imprimer until sliced again
  const infInput = page.doc.querySelectorAll(".p3d-studio-side input[type=\"number\"]")[1];
  infInput.value = "80";
  infInput.dispatchEvent({ type: "change" });
  await settle();
  assert.equal(page.doc.querySelector(".p3d-studio-bar") && byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer") && !byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer").hidden, false, "changing infill disables/hides stale Imprimer");

  // Re-slice at 80% -> Imprimer returns and modal displays 80%
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  page.api.last("/api/print3d/studio/slice").d.resolve({
    model: { id: "m_s80", name: "cube_studio_bbb222.gcode.3mf", ext: "3mf", slice_settings: { printer_model: "A1", nozzle: "0.4", layer_height: "0.20", infill: "80%" } },
    info: { printer_model: "A1", filaments: [{ id: 1, type: "PLA" }] },
  });
  await settle();
  printBtn = byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer");
  assert.ok(printBtn && !printBtn.hidden && !printBtn.disabled, "Imprimer re-enabled after new slice");

  // Switching printer invalidates slice until sliced for the new printer
  const prSel = page.doc.querySelector(".p3d-studio-bar").querySelector("select");
  prSel.value = "p2";
  prSel.dispatchEvent({ type: "change" });
  await settle();
  assert.equal(byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer"), null, "switching printer hides stale Imprimer button");
});

check("studio drops stale/out-of-order async slice responses when settings change mid-flight", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const pr = printer({ id: "p1", name: "A1 Atelier", kind: "bambu", model: "A1" });
  page.api.calls[0].d.resolve(state([pr], { config: { printers: [pr], makerworld: {}, filament: { currency: "$" } } }));
  await settle();

  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [{ id: "m1", name: "cube.stl", ext: "stl", size: 684 }], tags: [], total: 1, indexed: 1 });
  await settle();
  clickTab(page, "studio");
  byText(page.doc.querySelector(".p3d-studio-bar"), "+ Ajouter").click();
  await settle();
  page.doc.querySelector(".p3d-studio-pick button").click();
  await settle();

  // Start async slice A at 15% infill
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  const sliceA = page.api.last("/api/print3d/studio/slice");
  assert.equal(JSON.parse(sliceA.opts.body).settings.infill, 15);

  // User edits infill to 80% BEFORE slice A finishes
  const infInput = page.doc.querySelectorAll(".p3d-studio-side input[type=\"number\"]")[1];
  infInput.value = "80";
  infInput.dispatchEvent({ type: "change" });
  await settle();

  // Slice A resolves late -> MUST NOT expose Imprimer for stale 15% output
  sliceA.d.resolve({
    model: { id: "m_stale15", name: "cube_studio_stale15.gcode.3mf", ext: "3mf", slice_settings: { printer_model: "A1", nozzle: "0.4", layer_height: "0.20", infill: "15%" } },
    info: { printer_model: "A1", filaments: [{ id: 1, type: "PLA" }] },
  });
  await settle();
  assert.equal(byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer"), null, "mid-flight change rejects late slice A");

  // Trigger slice B at 80%, then re-render Studio (tab toggle) and trigger slice C at 45% concurrently
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  const sliceB = page.api.last("/api/print3d/studio/slice");
  assert.equal(JSON.parse(sliceB.opts.body).settings.infill, 80);

  infInput.value = "45";
  infInput.dispatchEvent({ type: "change" });
  byText(page.doc.querySelector(".p3d-studio-modes"), "2. Aperçu").click();
  byText(page.doc.querySelector(".p3d-studio-modes"), "1. Préparer").click();
  await settle();
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  const sliceC = page.api.last("/api/print3d/studio/slice");
  assert.equal(JSON.parse(sliceC.opts.body).settings.infill, 45);

  // C resolves first, then B resolves out-of-order -> C wins and confirmation displays 45% (never B's 80%)
  sliceC.d.resolve({
    model: { id: "m_c45", name: "cube_studio_c45.gcode.3mf", ext: "3mf" },
    info: { printer_model: "A1", filaments: [{ id: 1, type: "PLA" }] },
  });
  await settle();
  sliceB.d.resolve({
    model: { id: "m_b80", name: "cube_studio_b80.gcode.3mf", ext: "3mf" },
    info: { printer_model: "A1", filaments: [{ id: 1, type: "PLA" }] },
  });
  await settle();

  const printBtn = byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer");
  assert.ok(printBtn && !printBtn.hidden && !printBtn.disabled, "latest slice C keeps Imprimer enabled");
  printBtn.click();
  await settle();
  const modalTxt = text(page.doc.querySelector(".p3d-print-confirm"));
  assert.ok(modalTxt.includes("cube_studio_c45.gcode.3mf") && modalTxt.includes("remplissage 45%"), "out-of-order slice B did not overwrite C");
});

check("studio reads real STL dims, detects rotated OOB & SAT collisions, and Auto-placer separates objects", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const pr = printer({ id: "p1", name: "A1 Atelier", kind: "bambu", model: "A1" });
  page.api.calls[0].d.resolve(state([pr], { config: { printers: [pr], makerworld: {}, filament: { currency: "$" } } }));
  await settle();

  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [{ id: "m_big", name: "bar.stl", ext: "stl", size: 1200 }], tags: [], total: 1, indexed: 1 });
  await settle();
  clickTab(page, "studio");

  // Add STL -> triggers /api/print3d/models/mesh_check fallback (real dims 120 x 40 x 20, NOT stuck at 36x36x24)
  byText(page.doc.querySelector(".p3d-studio-bar"), "+ Ajouter").click();
  await settle();
  page.doc.querySelector(".p3d-studio-pick button").click();
  await settle();
  const mcCall = page.api.last("/api/print3d/models/mesh_check");
  assert.ok(mcCall, "mesh_check queried when HQModel absent");
  mcCall.d.resolve({ ok: true, dims_mm: [120, 40, 20] });
  await settle();
  assert.ok(text(page.doc.querySelector(".p3d-studio-dims")).includes("120.0 × 40.0 × 20.0 mm"), "real dims shown instead of 36x36x24");

  // Rotate 45 deg and move near edge (x=215 -> rotated half-span ~56.5 > 41 margin -> OOB!)
  const numInputs = page.doc.querySelectorAll('.p3d-studio-obj input[type="number"]');
  numInputs[0].value = "215";
  numInputs[2].value = "45";
  numInputs[0].dispatchEvent({ type: "change" });
  await settle();
  const warn1 = page.doc.querySelector(".p3d-studio-warn");
  assert.ok(warn1 && !warn1.hidden && text(warn1).includes("Hors plateau"), "rotated OOB flagged before slicing");
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  assert.equal(page.api.of("/api/print3d/studio/slice").length, 0, "Trancher refuses OOB item");

  // Center item back inside bed, then add second identical 120x40 item overlapping at center
  numInputs[0].value = "128";
  numInputs[2].value = "0";
  numInputs[0].dispatchEvent({ type: "change" });
  await settle();
  byText(page.doc.querySelector(".p3d-studio-bar"), "+ Ajouter").click();
  await settle();
  page.doc.querySelector(".p3d-studio-pick button").click();
  await settle();
  const warnCol = page.doc.querySelector(".p3d-studio-warn");
  assert.ok(warnCol && !warnCol.hidden && text(warnCol).includes("Collision"), "overlapping objects trigger SAT collision banner");
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  assert.equal(page.api.of("/api/print3d/studio/slice").length, 0, "Trancher refuses colliding items");

  // Click Auto-placer -> separates objects cleanly so warning clears and Trancher succeeds
  byText(page.doc.querySelector(".p3d-studio-bar"), "Auto-placer").click();
  await settle();
  const warnAfter = page.doc.querySelector(".p3d-studio-warn");
  assert.equal(warnAfter.hidden, true, "Auto-placer eliminates overlap");
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  assert.equal(page.api.of("/api/print3d/studio/slice").length, 1, "Trancher dispatches once clear");
});

check("studio CSS enforces stage-first mobile layout and 44px / 16px touch targets", async () => {
  const css = readFileSync(new URL("../assets/hq-print3d.css", import.meta.url), "utf8");
  assert.match(css, /@media\s*\(max-width:\s*820px\)[\s\S]*\.p3d-studio-stage\s*\{\s*order:\s*-1;/, "stage placed first on mobile");
  assert.match(css, /@media\s*\(max-width:\s*820px\)[\s\S]*\.p3d-studio-bar\s+\.p3d-btn\.is-small[\s\S]*min-height:\s*44px/, ".p3d-studio-bar .p3d-btn.is-small beats .p3d-btn.is-small 28px rule");
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.p3d-studio-side select[\s\S]*font-size:\s*16px/, "16px inputs prevent iOS Safari zoom");
});

check("HQPrepare canonical transform parity, lay-flat, and ray-triangle picking", async () => {
  const prep = require("../assets/hq-print3d-prepare.js");
  // Asymmetric wedge matching Python test_phase3_canonical_transform_rot_xyz_scale_z_and_lay_flat:
  // raw X [0..40], Y [0..20], Z [5..15]
  const rawPos = new Float32Array([
    0, 0, 5,  40, 0, 5,  10, 20, 5,
    0, 0, 5,  10, 20, 5, 0, 20, 5,
    0, 0, 15, 40, 0, 5,  0, 20, 15,
    0, 0, 5,  0, 20, 5,  0, 0, 15,
    0, 20, 5, 0, 20, 15, 0, 0, 15,
  ]);
  const rb = prep.computeRawBounds(rawPos);
  assert.deepEqual(rb.dims, [40, 20, 10]);

  const rx90 = prep.transformVertices(rawPos, { rot_x: 90, x: 128, y: 128, z: 4 }, rb);
  assert.deepEqual(rx90.stats.dims.map((v) => +v.toFixed(3)), [40, 10, 20]);
  assert.ok(Math.abs((rx90.worldBounds.min[0] + rx90.worldBounds.max[0]) * 0.5 - 128) < 1e-3);
  assert.ok(Math.abs((rx90.worldBounds.min[1] + rx90.worldBounds.max[1]) * 0.5 - 128) < 1e-3);
  assert.ok(Math.abs(rx90.worldBounds.min[2] - 4) < 1e-3 && Math.abs(rx90.worldBounds.max[2] - 24) < 1e-3);

  // Verify buildItemMatrix matches transformVertices point-for-point
  const params = { scale: 1.5, rot_x: 37, rot_y: -22.5, rot_z: 48, x: 90, y: 140, z: 2.5 };
  const vertX = prep.transformVertices(rawPos, params, rb);
  const mat = prep.buildItemMatrix(vertX.stats, params);
  for (let i = 0; i < rawPos.length; i += 3) {
    const x = rawPos[i], y = rawPos[i + 1], z = rawPos[i + 2];
    const wx = mat[0] * x + mat[4] * y + mat[8] * z + mat[12];
    const wy = mat[1] * x + mat[5] * y + mat[9] * z + mat[13];
    const wz = mat[2] * x + mat[6] * y + mat[10] * z + mat[14];
    assert.ok(Math.abs(wx - vertX.positions[i]) < 1e-3, "matrix X matches transformVertices");
    assert.ok(Math.abs(wy - vertX.positions[i + 1]) < 1e-3, "matrix Y matches transformVertices");
    assert.ok(Math.abs(wz - vertX.positions[i + 2]) < 1e-3, "matrix Z matches transformVertices");
  }

  // Lay-flat normal alignment
  const ang = prep.layFlatAnglesForNormal(1, 1, 1);
  const rxR = (ang[0] * Math.PI) / 180, ryR = (ang[1] * Math.PI) / 180;
  const invS = 1 / Math.sqrt(3);
  const y1 = invS * Math.cos(rxR) - invS * Math.sin(rxR);
  const z1 = invS * Math.sin(rxR) + invS * Math.cos(rxR);
  const x2 = invS * Math.cos(ryR) + z1 * Math.sin(ryR);
  const z2 = -invS * Math.sin(ryR) + z1 * Math.cos(ryR);
  assert.ok(Math.abs(x2) < 1e-3 && Math.abs(y1) < 1e-3 && Math.abs(z2 + 1) < 1e-3, "lay-flat maps (1,1,1) to (0,0,-1)");

  // Exact ray-triangle pick against tilted face vs empty plate miss
  const mId = prep.buildItemMatrix(rx90.stats, { rot_x: 90, x: 128, y: 128, z: 4, scale: 1 });
  const invM = prep.invert4x4(mId);
  const hit = prep.intersectRayMeshLocal({ positions: rawPos, rawBounds: rb }, invM, [120, 160, 14], [0, -1, 0]);
  assert.ok(hit && hit.faceIndex >= 0, "ray hits asymmetric mesh");
  const miss = prep.intersectRayMeshLocal({ positions: rawPos, rawBounds: rb }, invM, [20, 20, 60], [0, 0, -1]);
  assert.equal(miss, null, "ray on empty plate misses mesh");
});

check("HQPrepare mesh store reuses parsed buffers on duplicate and rejects unsupported formats", async () => {
  const prep = require("../assets/hq-print3d-prepare.js");
  let fetchCount = 0, parseCount = 0;
  const stlBuf = new Uint8Array(84 + 50);
  new DataView(stlBuf.buffer).setUint32(80, 1, true);
  const dv = new DataView(stlBuf.buffer);
  dv.setFloat32(96, 0, true); dv.setFloat32(108, 10, true); dv.setFloat32(124, 10, true);
  const store = prep.createMeshStore({
    fetchStl: async () => { fetchCount += 1; return stlBuf.buffer.slice(0); },
    parseStl: (_name, _buf) => {
      parseCount += 1;
      const pos = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
      return { format: "STL binaire", triangles: 1, positions: pos, normals: new Float32Array(9), bounds: { min: [0, 0, 0], max: [10, 10, 0], center: [5, 5, 0], radius: 7 } };
    },
  });
  const m1 = await store.acquire({ id: "m_dup", name: "part.stl", ext: "stl" });
  const m2 = await store.acquire({ id: "m_dup", name: "part.stl", ext: "stl" });
  assert.equal(fetchCount, 1, "second acquire reuses cache (1 fetch)");
  assert.equal(parseCount, 1, "second acquire reuses cache (1 parse)");
  assert.equal(m1.positions, m2.positions, "identical Float32Array shared");
  const glbRes = await store.acquire({ id: "m_glb", name: "scene.glb", ext: "glb" });
  assert.equal(glbRes.supported, false, "non-STL marked unsupported explicitly");
  store.dispose();
  assert.equal(store.size, 0, "dispose clears cache");
});

check("Studio undo/redo, below-plate warning, and slice invalidation across Phase 3 edits", async () => {
  const page = boot();
  page.view.show(page.host, page.api);
  const pr = printer({ id: "p1", name: "A1 Atelier", kind: "bambu", model: "A1" });
  page.api.calls[0].d.resolve(state([pr], { config: { printers: [pr], makerworld: {}, filament: { currency: "$" } } }));
  await settle();

  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [{ id: "m1", name: "cube.stl", ext: "stl", size: 684, bounds_mm: [20, 20, 10] }], tags: [], total: 1, indexed: 1 });
  await settle();
  clickTab(page, "studio");
  byText(page.doc.querySelector(".p3d-studio-bar"), "+ Ajouter").click();
  await settle();
  page.doc.querySelector(".p3d-studio-pick button").click();
  await settle();

  // Slice cleanly first
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  page.api.last("/api/print3d/studio/slice").d.resolve({
    model: { id: "m_ok", name: "cube_studio_aaa.gcode.3mf", ext: "3mf" },
    info: { printer_model: "A1", filaments: [{ id: 1, type: "PLA" }] },
  });
  await settle();
  byText(page.doc.querySelector(".p3d-studio-modes"), "1. Préparer").click();
  await settle();
  assert.ok(byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer"), "Imprimer ready before edit");

  // Edit Rot X (index 5 in inspector inputs) -> invalidates slice
  const nums = page.doc.querySelectorAll('.p3d-studio-obj input[type="number"]');
  assert.equal(nums.length, 7, "7 transform inputs (X, Y, RotZ, Scale, Z, RotX, RotY)");
  nums[5].value = "90";
  nums[5].dispatchEvent({ type: "change" });
  await settle();
  assert.equal(page.view._hooks.studio.items[0].rot_x, 90);
  const impBtn = byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer");
  assert.ok(!impBtn || impBtn.hidden, "Rot X invalidates Imprimer");

  // Set Z = -5 -> warns "Sous plateau" and refuses Trancher
  nums[4].value = "-5";
  nums[4].dispatchEvent({ type: "change" });
  await settle();
  const warnZ = page.doc.querySelector(".p3d-studio-warn");
  assert.ok(warnZ && !warnZ.hidden && text(warnZ).includes("Sous plateau"), "Z < 0 triggers below-plate warning");
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  assert.equal(page.api.of("/api/print3d/studio/slice").length, 1, "below-plate blocks Trancher");

  // Undo restores Z = 0, Redo re-applies Z = -5
  byText(page.doc.querySelector(".p3d-studio-bar"), "↶ Annuler").click();
  await settle();
  assert.equal(page.view._hooks.studio.items[0].z, 0, "Undo restores Z = 0");
  assert.equal(page.doc.querySelector(".p3d-studio-warn").hidden, true, "Undo clears Z warning");
  byText(page.doc.querySelector(".p3d-studio-bar"), "↷ Rétablir").click();
  await settle();
  assert.equal(page.view._hooks.studio.items[0].z, -5, "Redo reapplies Z = -5");
});

check("HQPrepare viewport supports software fallback, camera presets, zero idle loop, and dispose", async () => {
  const prep = require("../assets/hq-print3d-prepare.js");
  const drawn = [];
  const fakeCtx2d = { fillStyle: "", strokeStyle: "", lineWidth: 1, fillRect() {}, beginPath() { drawn.push("path"); }, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {} };
  const listenersMap = Object.create(null);
  const fakeCanvas = {
    width: 640, height: 460,
    getContext: (kind) => (kind === "2d" ? fakeCtx2d : null),
    addEventListener: (k, fn) => { listenersMap[k] = fn; },
    removeEventListener: (k) => { delete listenersMap[k]; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 460 }),
  };
  const vp = prep.createViewport(fakeCanvas);
  vp.setState({ bed: { x: 256, y: 256, z: 256 }, items: [{ model_id: "x", x: 128, y: 128, z: 0, rot_z: 0, scale: 1, dx: 20, dy: 20, dz: 10 }], selected: 0 });
  assert.ok(drawn.length > 0 && vp.getMetrics().drawCount >= 1, "software 2D fallback drew bed and item");
  assert.equal(vp.getMetrics().webgl, false);
  assert.equal(vp.getMetrics().rafPending, false, "no idle loop pending");
  vp.setCameraPreset("top");
  assert.ok(Math.abs(vp.getCamera().pitch - 1.52) < 1e-4, "top preset updates pitch");
  vp.setCameraPreset("side");
  assert.ok(Math.abs(vp.getCamera().yaw - Math.PI * 0.5) < 1e-4, "side preset updates yaw");
  vp.dispose();
  assert.equal(Object.keys(listenersMap).length, 0, "dispose removes all canvas listeners");
});

check("iphone_bridge loads hq-print3d-prepare.js before hq-print3d.js", async () => {
  const bridge = readFileSync(new URL("../iphone_bridge.py", import.meta.url), "utf8");
  const iPrep = bridge.indexOf("hqAssetUrl('hq-print3d-prepare.js')");
  const iMain = bridge.indexOf("hqAssetUrl('hq-print3d.js')");
  assert.ok(iPrep > 0 && iMain > iPrep, "bridge lazy loader sequences hq-print3d-prepare.js before hq-print3d.js");
});

check("Phase 3.1 H1: createMeshStore & Studio invalidate stale mesh/dims cache across same-ID same-triCount replacement and 409 source_changed", async () => {
  const prep = require("../assets/hq-print3d-prepare.js");
  function makeSingleTri(dx, tag) {
    const ab = new ArrayBuffer(84 + 50);
    new DataView(ab).setUint32(80, 1, true);
    const dv = new DataView(ab, 84);
    [0, 0, 1, 0, 0, 0, dx, 0, 0, 0, 10, 10].forEach((v, i) => dv.setFloat32(i * 4, v, true));
    Object.defineProperty(ab, "_hqVersion", { value: tag, configurable: true });
    return ab;
  }
  const sha1 = "a".repeat(64);
  const sha2 = "b".repeat(64);
  let activeVer = sha1;
  let fetchCount = 0;
  const prevHQModel = globalThis.window.HQModel;
  const parseMock = (_name, buf) => {
    const x = new DataView(buf, 84).getFloat32(24, true);
    const pos = new Float32Array([0, 0, 0, x, 0, 0, 0, 10, 10]);
    const norm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    return { format: "STL binaire", positions: pos, normals: norm, bounds: { min: [0, 0, 0], max: [x, 10, 10], center: [x * 0.5, 5, 5], size: [x, 10, 10] }, triangles: 1 };
  };
  globalThis.window.HQModel = {
    parse: parseMock,
    parseInWorker: async (name, buf) => parseMock(name, buf),
  };
  try {
    const store = prep.createMeshStore({
      fetchStl: async () => {
        fetchCount += 1;
        return makeSingleTri(activeVer === sha1 ? 10 : 85, activeVer);
      },
    });
    const m1 = await store.acquire({ id: "m_swap", name: "swap.stl", ext: "stl", source_sha256: sha1 });
    assert.equal(fetchCount, 1);
    assert.equal(Math.round(m1.rawBounds.dims[0]), 10);
    assert.equal(store.getCached("m_swap", sha1).meshRev, m1.meshRev);
    // Stale getCached against sha2 automatically invalidates sha1 entry
    assert.equal(store.getCached("m_swap", sha2), null);

    activeVer = sha2;
    const m2 = await store.acquire({ id: "m_swap", name: "swap.stl", ext: "stl", source_sha256: sha2 });
    assert.equal(fetchCount, 2, "must re-fetch when SHA/version changes even with equal 1-triangle count");
    assert.equal(Math.round(m2.rawBounds.dims[0]), 85);
    assert.ok(m2.meshRev > m1.meshRev, "meshRev must increment so GPU VBO re-uploads despite equal triCount");

    // Studio-level expected_sha256 propagation, syncStudioSourceVersions & 409 recovery
    const page = boot();
    const pr = printer({ id: "p1", name: "A1 Atelier", kind: "bambu", model: "A1" });
    page.view.show(page.host, page.api);
    page.api.calls[0].d.resolve(state([pr], { config: { printers: [pr], makerworld: {}, filament: { currency: "$" } } }));
    await settle();

    clickTab(page, "models");
    const modelV1 = { id: "m_swap", name: "swap.stl", ext: "stl", size: 134, mtime: 100, source_sha256: sha1, bounds_mm: [10, 10, 10] };
    page.api.last("/api/print3d/models").d.resolve({ models: [modelV1], total: 1, indexed: 1, tags: [] });
    await settle();

    clickTab(page, "studio");
    byText(page.doc.querySelector(".p3d-studio-bar"), "+ Ajouter").click();
    await settle();
    page.doc.querySelector(".p3d-studio-pick button").click();
    await settle();
    assert.equal(page.view._hooks.studio.items[0].sourceVersion, sha1);

    // Sync new version under same id -> updates bounds, dims cache, and item sourceVersion
    const modelV2 = { id: "m_swap", name: "swap.stl", ext: "stl", size: 134, mtime: 200, source_sha256: sha2, bounds_mm: [85, 10, 10] };
    page.view._hooks.syncStudioSourceVersions([modelV2]);
    await settle();
    assert.equal(page.view._hooks.studio.items[0].sourceVersion, sha2);
    assert.equal(page.view._hooks.studio.items[0].dx, 85);

    byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
    const sliceReq = page.api.last("/api/print3d/studio/slice");
    const sliceBody = JSON.parse(sliceReq.opts.body);
    assert.equal(sliceBody.items[0].expected_sha256, sha2, "Trancher attaches authoritative expected_sha256");
    const err409 = new Error("Modèle modifié sur le disque");
    err409.code = "source_changed";
    err409.status = 409;
    sliceReq.d.reject(err409);
    await settle();
    assert.equal(page.view._hooks.stlDimsCache["m_swap"], undefined, "409 source_changed evicts stlDimsCache");
  } finally {
    if (prevHQModel === undefined) delete globalThis.window.HQModel;
    else globalThis.window.HQModel = prevHQModel;
  }
});

check("Phase 3.1 H2: Fake-GL webglcontextlost/restored clears stale handles and binds zero gen-1 objects on restore", async () => {
  const prep = require("../assets/hq-print3d-prepare.js");
  let activeGen = 1;
  let contextLost = false;
  let nextId = 1;
  let deleteCallsWhileLost = 0;
  let staleGenBinds = 0;
  let staleGenPrograms = 0;
  let restoreDrawTris = 0;

  function makeFakeGL() {
    return {
      VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30, COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
      ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88E4, STREAM_DRAW: 0x88E0, FLOAT: 0x1406,
      TRIANGLES: 0x0004, LINES: 0x0001, DEPTH_TEST: 0x0B71, LEQUAL: 0x0203,
      BLEND: 0x0BE2, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
      CULL_FACE: 0x0B44, COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100,
      isContextLost: () => contextLost,
      getParameter: () => 65536,
      createShader: () => ({ id: nextId++, gen: activeGen }),
      shaderSource() {},
      compileShader() {},
      getShaderParameter: () => true,
      getShaderInfoLog: () => "",
      createProgram: () => ({ id: nextId++, gen: activeGen }),
      attachShader() {},
      linkProgram() {},
      getProgramParameter: () => true,
      getProgramInfoLog: () => "",
      deleteShader() { if (contextLost) deleteCallsWhileLost += 1; },
      deleteProgram() { if (contextLost) deleteCallsWhileLost += 1; },
      deleteBuffer() { if (contextLost) deleteCallsWhileLost += 1; },
      createBuffer: () => ({ id: nextId++, gen: activeGen }),
      bindBuffer(_t, buf) { if (!contextLost && buf && buf.gen !== activeGen) staleGenBinds += 1; },
      bufferData() {},
      getAttribLocation: () => 0,
      getUniformLocation: (_p, n) => ({ name: n }),
      useProgram(p) { if (!contextLost && p && p.gen !== activeGen) staleGenPrograms += 1; },
      uniformMatrix4fv() {}, uniformMatrix3fv() {}, uniform3f() {}, uniform3fv() {}, uniform4fv() {}, uniform1f() {},
      enableVertexAttribArray() {}, vertexAttribPointer() {},
      viewport() {}, clearColor() {}, clear() {}, enable() {}, disable() {}, depthFunc() {}, blendFunc() {}, depthMask() {},
      drawArrays(mode, _first, count) { if (!contextLost && activeGen >= 2 && mode === 0x0004) restoreDrawTris += count; },
    };
  }
  const fakeGL = makeFakeGL();
  const listeners = Object.create(null);
  const fakeCanvas = {
    width: 640, height: 460,
    getContext: (k) => (k === "webgl" ? fakeGL : null),
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    removeEventListener: (ev) => { delete listeners[ev]; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 460 }),
  };

  let lastLostFlag = null;
  const vp = prep.createViewport(fakeCanvas, { onContextChange: (l) => { lastLostFlag = l; } });
  const meshV1 = {
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 10]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    rawBounds: { min: [0, 0, 0], max: [10, 10, 10], dims: [10, 10, 10] },
    triangles: 1,
    triCount: 1,
    meshRev: 1,
  };
  vp.setState({
    bed: { x: 256, y: 256, z: 256 },
    items: [{ model_id: "cube", x: 128, y: 128, z: 0, rot_x: 0, rot_y: 0, rot_z: 0, scale: 1, dx: 10, dy: 10, dz: 10 }],
    meshes: { cube: meshV1 },
    selected: 0,
  });
  assert.equal(vp.getMetrics().webgl, true);
  assert.equal(vp.getMetrics().glGen, 1);
  assert.equal(vp.getMetrics().bedReady, true);
  assert.equal(vp.getMetrics().vboCount, 1);

  // Trigger webglcontextlost -> resets caches without calling delete* on dead handles
  contextLost = true;
  let prevented = false;
  listeners.webglcontextlost({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, "webglcontextlost must call preventDefault()");
  assert.equal(lastLostFlag, true);
  assert.equal(vp.getMetrics().contextLost, true);
  assert.equal(vp.getMetrics().glGen, 2);
  assert.equal(vp.getMetrics().bedReady, false);
  assert.equal(vp.getMetrics().vboCount, 0);
  assert.equal(deleteCallsWhileLost, 0, "must NOT delete stale handles while GL context is lost");
  const drawsWhenLost = vp.getMetrics().drawCount;
  vp.drawNow();
  assert.equal(vp.getMetrics().drawCount, drawsWhenLost, "drawNow must be a no-op while context is lost");

  // Restore GL -> generation increments to 3; even same triCount/meshRev re-uploads fresh gen-3 VBO + bed!
  activeGen = 3;
  contextLost = false;
  listeners.webglcontextrestored();
  assert.equal(lastLostFlag, false);
  assert.equal(vp.getMetrics().contextLost, false);
  assert.equal(vp.getMetrics().glGen, 3);
  assert.equal(vp.getMetrics().bedReady, true);
  assert.equal(vp.getMetrics().vboCount, 1);
  assert.equal(staleGenBinds, 0, "zero gen-1 buffers bound after restore");
  assert.equal(staleGenPrograms, 0, "zero gen-1 programs used after restore");
  assert.ok(restoreDrawTris > 0, "restored scene rendered triangles immediately");

  // Bonus: replacing meshV1 -> meshV2 with SAME triCount=1 but higher meshRev=2 re-uploads VBO
  const meshV2 = {
    positions: new Float32Array([0, 0, 0, 50, 0, 0, 0, 10, 10]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    rawBounds: { min: [0, 0, 0], max: [50, 10, 10], dims: [50, 10, 10] },
    triangles: 1,
    triCount: 1,
    meshRev: 2,
  };
  const drawsBeforeSwap = vp.getMetrics().drawCount;
  vp.setState({ meshes: { cube: meshV2 } });
  assert.ok(vp.getMetrics().drawCount > drawsBeforeSwap && staleGenBinds === 0);
  vp.dispose();
});

check("Phase 3.1 Obs #1-4: tight Z=-0.1, elevated Z>0 block, tilted stats cache hit, and hidden label", async () => {
  const prep = require("../assets/hq-print3d-prepare.js");
  assert.equal(prep.itemBelowPlate({ z: -0.1 }), true, "-0.1 mm must fail closed as belowPlate");
  assert.equal(prep.itemBelowPlate({ z: -0.005 }), false, "-0.005 mm rounding dust accepted");
  assert.equal(prep.itemElevated({ z: 2.0 }), true, "+2.0 mm flagged as elevated");
  assert.equal(prep.itemElevated({ z: 0 }), false);

  const cacheHost = {};
  const pos = new Float32Array([0, 0, 0, 20, 0, 0, 0, 10, 10]);
  const b = prep.computeRawBounds(pos);
  const s1 = prep.computeTiltedStats(pos, b, 1.0, 90, 0, cacheHost);
  const s2 = prep.computeTiltedStats(pos, b, 1.0, 90, 0, cacheHost);
  assert.equal(s1, s2, "computeTiltedStats memoizes identical tilt on cacheHost");

  const page = boot();
  const pr = printer({ id: "p1", name: "A1", kind: "bambu", model: "A1" });
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([pr], { config: { printers: [pr], makerworld: {}, filament: { currency: "$" } } }));
  await settle();

  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [{ id: "m1", name: "c.stl", ext: "stl", bounds_mm: [20, 20, 20] }], total: 1, indexed: 1, tags: [] });
  await settle();
  clickTab(page, "studio");
  byText(page.doc.querySelector(".p3d-studio-bar"), "+ Ajouter").click();
  await settle();
  page.doc.querySelector(".p3d-studio-pick button").click();
  await settle();

  // Set Z = 2.0 -> warns Surélevé and blocks Trancher; "Pose Z = 0" drops it back to 0
  const nums = page.doc.querySelectorAll('.p3d-studio-obj input[type="number"]');
  nums[4].value = "2";
  nums[4].dispatchEvent({ type: "change" });
  await settle();
  assert.ok(text(page.doc.querySelector(".p3d-studio-warn")).includes("Surélevé"), "Z=2 triggers Surélevé warning");
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  assert.equal(page.api.of("/api/print3d/studio/slice").length, 0, "elevated Z > 0 blocks Trancher");
  byText(page.doc.querySelector(".p3d-studio-obj-acts"), "Pose Z = 0").click();
  await settle();
  assert.equal(page.view._hooks.studio.items[0].z, 0);

  // Toggle eye button -> labels hidden item clearly as still sliced ("(masqué)" / "toujours tranché")
  const visBtn = page.doc.querySelectorAll(".p3d-studio-objrow-acts button").find((b) => String(b.getAttribute("aria-label") || "").includes("toujours tranché"));
  assert.ok(visBtn, "visibility toggle clarifies toujours tranché");
  visBtn.click();
  await settle();
  assert.equal(page.view._hooks.studio.items[0].visible, false);
  assert.ok(text(page.doc.querySelector(".p3d-studio-objrow")).includes("(masqué)"));
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  assert.equal(page.api.of("/api/print3d/studio/slice").length, 1, "hidden item remains included in sliced plate");
});

check("Phase 4A: Quality presets scale by nozzle and Advanced settings invalidate Imprimer", async () => {
  const page = boot();
  const pr = printer({ id: "p1", name: "A1", kind: "bambu", model: "A1" });
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([pr], { config: { printers: [pr], makerworld: {}, filament: { currency: "$" } } }));
  await settle();

  const q02 = page.view._hooks.qualityPresetDefaults("0.2", "fine");
  assert.equal(q02.layer_height, "0.06", "0.2 mm nozzle fine preset scales to 0.06 mm");
  const q08 = page.view._hooks.qualityPresetDefaults("0.8", "draft");
  assert.equal(q08.layer_height, "0.56", "0.8 mm nozzle draft preset scales to 0.56 mm");

  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [{ id: "m1", name: "c.stl", ext: "stl", bounds_mm: [20, 20, 10] }], tags: [], total: 1, indexed: 1 });
  await settle();
  clickTab(page, "studio");
  byText(page.doc.querySelector(".p3d-studio-bar"), "+ Ajouter").click();
  await settle();
  page.doc.querySelector(".p3d-studio-pick button").click();
  await settle();

  // Select Quality preset -> updates layer_height/infill, then Slice cleanly
  const sideSels = page.doc.querySelectorAll(".p3d-studio-side select");
  sideSels[3].value = "fine";
  sideSels[3].dispatchEvent({ type: "change" });
  await settle();
  assert.equal(page.view._hooks.studio.cfg.layer_height, "0.12");
  assert.equal(page.view._hooks.studio.cfg.infill, 20);

  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  page.api.last("/api/print3d/studio/slice").d.resolve({
    model: { id: "m_ok", name: "c_studio.gcode.3mf", ext: "3mf" },
    info: { printer_model: "A1", filaments: [{ id: 1, type: "PLA" }] },
  });
  await settle();
  byText(page.doc.querySelector(".p3d-studio-modes"), "1. Préparer").click();
  await settle();
  assert.ok(byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer"), "Imprimer visible after clean slice");

  // Edit Advanced setting (e.g. outer_wall_speed inside .p3d-studio-adv) -> must invalidate Imprimer!
  const advNums = page.doc.querySelectorAll('.p3d-studio-adv input[type="number"]');
  assert.ok(advNums.length >= 10, "Advanced panel exposes speed, accel, shell, and thermal controls");
  advNums[2].value = "85"; // outer_wall_speed
  advNums[2].dispatchEvent({ type: "change" });
  await settle();
  assert.equal(page.view._hooks.studio.cfg.outer_wall_speed, "85");
  const impBtn = byText(page.doc.querySelector(".p3d-studio-bar"), "Imprimer");
  assert.ok(!impBtn || impBtn.hidden, "Advanced setting change invalidates stale Imprimer");
});

check("Phase 4B: Material cards distinguish station roles, read-only import confirms overwrite, and thermal warning shows", async () => {
  const page = boot();
  const c5 = printer({ id: "p_c5", name: "C5", kind: "flashforge", model: "Creator 5" });
  const a1 = printer({ id: "p_a1", name: "A1", kind: "bambu", model: "A1" });
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([c5, a1], { config: { printers: [c5, a1], makerworld: {}, filament: { currency: "$" } } }));
  await settle();

  clickTab(page, "studio");
  assert.ok(text(page.doc.querySelector(".p3d-studio-materials-fold")).includes("Extrudeurs physiques"), "Creator 5 labels physical extruders");

  const prSel = page.doc.querySelector(".p3d-studio-bar select");
  prSel.value = "p_a1";
  prSel.dispatchEvent({ type: "change" });
  await settle();
  assert.ok(text(page.doc.querySelector(".p3d-studio-materials-fold")).includes("Station AMS"), "A1 labels AMS station");

  // Read-only material import from loaded_materials
  byText(page.doc.querySelector(".p3d-studio-materials-fold"), "Importer chargés (lecture seule)").click();
  const lmReq = page.api.last("/api/print3d/studio/loaded_materials");
  assert.ok(lmReq && lmReq.url.includes("printer_id=p_a1"), "requests read-only loaded_materials for A1");
  lmReq.d.resolve({
    ok: true, available: true, reason: "live_status",
    slots: [
      { slot: 1, material: "PLA", colour: "#112233", loaded: true },
      { slot: 2, material: "PETG", colour: "#445566", loaded: true },
    ],
  });
  await settle();
  assert.equal(page.view._hooks.studio.tools[1].material, "PETG");
  assert.equal(page.view._hooks.studio.tools[1].color, "#445566");

  // Thermal mismatch PLA + PC on shared single nozzle A1 shows explicit warning banner
  const cardSelects = page.doc.querySelectorAll(".p3d-studio-tools select");
  cardSelects[2].value = "PC";
  cardSelects[2].dispatchEvent({ type: "change" });
  await settle();
  assert.ok(text(page.doc.querySelector(".p3d-studio-materials-fold")).includes("Écart thermique élevé"));
});

check("Phase 4C: Contextual per-object slicing overrides track Inherited vs Modified, survive duplicate & undo", async () => {
  const page = boot();
  const pr = printer({ id: "p1", name: "A1", kind: "bambu", model: "A1" });
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([pr], { config: { printers: [pr], makerworld: {}, filament: { currency: "$" } } }));
  await settle();

  clickTab(page, "models");
  page.api.last("/api/print3d/models").d.resolve({ models: [{ id: "m1", name: "box.stl", ext: "stl", bounds_mm: [20, 20, 10] }], tags: [], total: 1, indexed: 1 });
  await settle();
  clickTab(page, "studio");
  byText(page.doc.querySelector(".p3d-studio-bar"), "+ Ajouter").click();
  await settle();
  page.doc.querySelector(".p3d-studio-pick button").click();
  await settle();

  const ovPanel = page.doc.querySelector(".p3d-studio-obj-slicing");
  assert.ok(ovPanel && text(ovPanel).includes("hérités du plateau"), "starts inherited cleanly");
  const ovNums = ovPanel.querySelectorAll('input[type="number"]');
  ovNums[0].value = "80"; // per-object infill override
  ovNums[0].dispatchEvent({ type: "change" });
  await settle();
  assert.equal(page.view._hooks.studio.items[0].overrides.infill, 80);
  assert.ok(text(page.doc.querySelector(".p3d-studio-obj-slicing")).includes("1 modifié(s)"));

  // Duplicate copies overrides cleanly; modifying Obj 1 must NOT mutate Obj 0!
  byText(page.doc.querySelector(".p3d-studio-bar"), "Dupliquer").click();
  await settle();
  assert.equal(page.view._hooks.studio.items.length, 2);
  page.doc.querySelector('.p3d-studio-obj-slicing input[type="number"]').value = "35";
  page.doc.querySelector('.p3d-studio-obj-slicing input[type="number"]').dispatchEvent({ type: "change" });
  await settle();
  assert.equal(page.view._hooks.studio.items[0].overrides.infill, 80, "Obj 0 kept 80%");
  assert.equal(page.view._hooks.studio.items[1].overrides.infill, 35, "Obj 1 changed to 35% independently");

  byText(page.doc.querySelector(".p3d-studio-bar"), "Auto-placer").click();
  await settle();
  byText(page.doc.querySelector(".p3d-studio-bar"), "Trancher").click();
  const sReq = JSON.parse(page.api.last("/api/print3d/studio/slice").opts.body);
  assert.equal(sReq.items[0].overrides.infill, 80);
  assert.equal(sReq.items[1].overrides.infill, 35);
});

check("Phase 4D: Projects save/reopen detects replaced source SHA, refuses stale Imprimer & strips secrets", async () => {
  const page = boot();
  const pr = printer({ id: "p1", name: "A1", kind: "bambu", model: "A1" });
  page.view.show(page.host, page.api);
  page.api.calls[0].d.resolve(state([pr], { config: { printers: [pr], makerworld: {}, filament: { currency: "$" } } }));
  await settle();

  clickTab(page, "models");
  const sha1 = "a".repeat(64);
  const sha2 = "b".repeat(64);
  page.api.last("/api/print3d/models").d.resolve({
    models: [{ id: "m1", name: "p.stl", ext: "stl", source_sha256: sha1, bounds_mm: [20, 20, 10] }],
    tags: [], total: 1, indexed: 1,
  });
  await settle();
  clickTab(page, "studio");
  byText(page.doc.querySelector(".p3d-studio-bar"), "+ Ajouter").click();
  await settle();
  page.doc.querySelector(".p3d-studio-pick button").click();
  await settle();

  byText(page.doc.querySelector(".p3d-studio-bar"), "Enregistrer").click();
  const saveCall = page.api.last("/api/print3d/projects/save");
  assert.ok(saveCall, "POST projects/save issued");
  const savedBody = JSON.parse(saveCall.opts.body);
  assert.equal(savedBody.items[0].source_sha256, sha1);
  assert.equal(page.api.of("/api/print3d/printer/start").length, 0, "Save never calls hardware print start");
  saveCall.d.resolve({ ok: true, project: { id: "prj_1", title: "Test", revision: 1 } });
  await settle();

  // Reopen with replaced source SHA and invalidated slice_valid=false -> Imprimer must remain hidden!
  page.view._hooks.studioApplyLoadedProject({
    ok: true,
    project: {
      id: "prj_1", title: "Test", revision: 1, schema_version: 1,
      target: { printer_model: "A1", printer_id: "p1", nozzle: "0.4", plate_type: "textured_pei" },
      settings: { infill: 42 },
      tools: [{ material: "PETG", color: "#123456" }],
      items: [{ uid: 1, model_id: "m1", model_name: "p.stl", source_sha256: sha1, current_sha256: sha2, source_status: "replaced", current_bounds_mm: [50, 20, 10], x: 120, y: 120, z: 0, tool: 0, overrides: { wall_loops: 4 } }],
      slice_ref: { sliced_model_id: "old_s", fingerprint: "old_fp" },
    },
    integrity: { missing_count: 0, replaced_count: 1, slice_valid: false, slice_reason: "source_changed" },
  });
  assert.equal(page.view._hooks.studio.items[0].sourceVersion, sha2);
  assert.equal(page.view._hooks.studio.items[0].dx, 50);
  assert.equal(page.view._hooks.studio.slicedModel, null, "reopened replaced project never restores stale Imprimer");

  // Phase 4.1 H2: Reopening a project with source_status: 'unverifiable' warns & clears stale slice readiness
  page.view._hooks.studioApplyLoadedProject({
    ok: true,
    project: {
      id: "prj_1", title: "TestUnverifiable", revision: 2, schema_version: 1,
      target: { printer_model: "A1", printer_id: "p1", nozzle: "0.4", plate_type: "textured_pei" },
      settings: { infill: 20 },
      tools: [{ material: "PLA", color: "#123456" }],
      items: [{ uid: 1, model_id: "m1", model_name: "p.stl", source_sha256: "", current_sha256: sha2, source_status: "unverifiable", current_bounds_mm: [20, 20, 10], x: 120, y: 120, z: 0, tool: 0, overrides: {} }],
      slice_ref: { sliced_model_id: "old_s", fingerprint: "old_fp" },
    },
    integrity: { missing_count: 0, replaced_count: 0, unverifiable_count: 1, slice_valid: false, slice_reason: "source_unverifiable" },
  });
  assert.equal(page.view._hooks.studio.items[0].sourceStatus, "unverifiable");
  assert.ok(page.view._hooks.studio.project.warnings.some((w) => w.includes("non vérifiable")), "unverifiable source SHA adds user warning");
  assert.equal(page.view._hooks.studio.slicedModel, null);

  // Phase 4.2 High #4 & Obs #7: Zero and negative coordinates (e.g. centered AD5M x=0, y=0 or x=-45, y=-30)
  // and 16-slot tool assignments (e.g. tool=11 on P1S/X1C) round-trip unchanged through reopen -> slice!
  const p1s = printer({ id: "p_p1s", name: "P1S", kind: "bambu", model: "P1S" });
  page.view.show(page.host, page.api);
  page.api.last("/api/print3d/state").d.resolve(state([p1s], { config: { printers: [p1s], makerworld: {}, filament: { currency: "$" } } }));
  await settle();
  clickTab(page, "studio");

  const tools16 = Array.from({ length: 16 }, (_, i) => ({
    slot_label: "T" + i,
    material: i === 11 ? "PETG" : "PLA",
    color: i === 11 ? "#abcdef" : "#112233",
    preset: "",
  }));
  page.view._hooks.studioApplyLoadedProject({
    ok: true,
    project: {
      id: "prj_zero", title: "ZeroCoord16Tools", revision: 1, schema_version: 1,
      target: { printer_model: "P1S", printer_id: "p_p1s", nozzle: "0.4", plate_type: "textured_pei" },
      settings: { infill: 20 },
      tools: tools16,
      items: [
        { uid: 1, model_id: "m1", model_name: "p.stl", source_sha256: sha1, current_sha256: sha1, source_status: "ok", current_bounds_mm: [20, 20, 10], x: 0, y: 0, z: 0, rot_x: 0, rot_y: 0, rot_z: 0, scale: 1, tool: 0 },
        { uid: 2, model_id: "m1", model_name: "p.stl", source_sha256: sha1, current_sha256: sha1, source_status: "ok", current_bounds_mm: [20, 20, 10], x: -45.5, y: 80, z: 0, rot_x: 0, rot_y: 0, rot_z: 0, scale: 1, tool: 11 },
      ],
    },
    integrity: { missing_count: 0, replaced_count: 0, unverifiable_count: 0, slice_valid: false, slice_reason: "not_sliced" },
  });
  assert.equal(page.view._hooks.studio.items[0].x, 0, "x=0 preserved on reopen (never replaced by 128)");
  assert.equal(page.view._hooks.studio.items[0].y, 0, "y=0 preserved on reopen (never replaced by 128)");
  assert.equal(page.view._hooks.studio.items[1].x, -45.5, "negative x preserved on reopen");
  assert.equal(page.view._hooks.studio.items[1].tool, 11, "tool T11 preserved on reopen");
  assert.equal(page.view._hooks.studio.tools[11].material, "PETG", "16-slot tool array preserves T11 material");

  // Save payload & Slice payload preserve (0, 0), (-45.5, 80) and tool=11
  byText(page.doc.querySelector(".p3d-studio-bar"), "Enregistrer").click();
  const zeroSaveBody = JSON.parse(page.api.last("/api/print3d/projects/save").opts.body);
  assert.equal(zeroSaveBody.items[0].x, 0);
  assert.equal(zeroSaveBody.items[0].y, 0);
  assert.equal(zeroSaveBody.items[1].x, -45.5);
  assert.equal(zeroSaveBody.items[1].tool, 11);
  assert.equal(zeroSaveBody.tools.length, 16);
  page.api.last("/api/print3d/projects/save").d.resolve({ ok: true, project: { id: "prj_zero", title: "ZeroCoord16Tools", revision: 2 } });
  await settle();

  // Phase 4.2 Medium #5 & #6: Rename active project in modal updates studio.project.revision (2 -> 3)
  // so subsequent quickSaveProject sends expected_revision=3, and Delete sends expected_revision
  page.win.prompt = () => "ZeroCoordRenommé";
  page.win.confirm = () => true;
  byText(page.doc.querySelector(".p3d-studio-bar"), "Projets").click();
  page.api.last("/api/print3d/projects").d.resolve({
    ok: true,
    projects: [{ id: "prj_zero", title: "ZeroCoord16Tools", revision: 2, printer_model: "P1S", nozzle: "0.4", item_count: 2 }],
  });
  await settle();
  byText(page.doc.querySelector(".p3d-projects-sheet"), "Renommer").click();
  const renCall = page.api.last("/api/print3d/projects/rename");
  assert.equal(JSON.parse(renCall.opts.body).expected_revision, 2);
  renCall.d.resolve({ ok: true, project: { id: "prj_zero", title: "ZeroCoordRenommé", revision: 3 } });
  await settle();
  assert.equal(page.view._hooks.studio.project.title, "ZeroCoordRenommé");
  assert.equal(page.view._hooks.studio.project.revision, 3, "active project revision updated after rename");

  page.api.last("/api/print3d/projects").d.resolve({
    ok: true,
    projects: [{ id: "prj_zero", title: "ZeroCoordRenommé", revision: 3, printer_model: "P1S", nozzle: "0.4", item_count: 2 }],
  });
  await settle();

  // Subsequent Enregistrer sends expected_revision=3 (not stale 2!)
  byText(page.doc.querySelector(".p3d-studio-bar"), "Enregistrer").click();
  const postRenSave = JSON.parse(page.api.last("/api/print3d/projects/save").opts.body);
  assert.equal(postRenSave.expected_revision, 3, "save after rename sends updated revision 3");
  page.api.last("/api/print3d/projects/save").d.resolve({ ok: true, project: { id: "prj_zero", title: "ZeroCoordRenommé", revision: 4 } });
  await settle();

  // Supprimer sends expected_revision from row
  byText(page.doc.querySelector(".p3d-projects-sheet"), "Supprimer").click();
  const delCall = page.api.last("/api/print3d/projects/delete");
  assert.equal(JSON.parse(delCall.opts.body).expected_revision, 3, "delete sends row expected_revision");
  delCall.d.resolve({ ok: true });
  await settle();
});

// ── run ──────────────────────────────────────────────────────────────────────
let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log("ok   " + name);
  } catch (error) {
    failed += 1;
    console.error("FAIL " + name + "\n     " + (error && error.message));
  }
}
if (failed) {
  console.error(`\n${failed} of ${cases.length} Atelier checks failed`);
  process.exit(1);
}
console.log(`\nhq print3d checks ok (${cases.length})`);
