// Offline proof of the Suivi tab, the item sheet, the offline queue, haptics and the language layer.
// Runs the real browser files in the small DOM of tests/hq_dom_stub.mjs: no browser, no server, no network.
//
//   node tests/check_inventoria_suivi_ui.mjs               normal run
//   HQ_UI_PROVE=1 node tests/check_inventoria_suivi_ui.mjs sabotage run: each case is replayed against a copy of the script with its
//                                                          key line changed and must fail (the assertions are load-bearing).
import assert from "node:assert/strict";
import { loadChip, byId, byText, tick } from "./hq_dom_stub.mjs";

const PROVE = process.env.HQ_UI_PROVE === "1";
const FILES = { chip: "hq-inventoria-chip.js", suivi: "hq-inventoria-suivi.js", i18n: "hq-inventoria-i18n.js" };

// mutation = { file, from, to }; the target must be present or the proof itself is wrong
const sabotage = (m) => (source, file) => {
  if (!m || file !== FILES[m.file]) return source;
  assert.ok(source.includes(m.from), "mutation target present: " + m.from);
  return source.replace(m.from, m.to);
};

const ITEM = "itm-0000000000000001";
function mount(mutation, { lang = "en", status = {}, routes = {}, seed = {} } = {}) {
  const h = loadChip(FILES.chip, {
    view: "inventaire",
    before: [FILES.i18n],
    also: [FILES.suivi],
    mutate: sabotage(mutation),
    win: { localStorage: Object.assign({ hq_inventoria_session: "ivo-0000000000000001" }, seed) },
    setup: (net) => {
      net.on("*", (call) => {
        const u = call.url.split("?")[0];
        if (routes[u]) return routes[u](call);
        if (u === "/api/inventoria/status") return { body: Object.assign({ ok: true, language: lang, alerts: [], shopping: { all: { items: [], count: 0, text: "" }, urgent: { items: [], count: 0, text: "" } },
          watches: [], memory: [], notify: {}, voice: {}, prefs: { auto_apply: true }, aliases: [], use_soon: [], filament: [], events: [], barcodes: [], greeting: {} }, status) };
        if (u === "/api/inventoria/sessions/ivo-0000000000000001") return { status: 404, body: { ok: false } };
        if (u === "/api/inventoria/sessions") return { body: { ok: true, session: { id: "ivo-0000000000000001" } } };
        return { body: { ok: true } };
      });
    },
  });
  return h;
}
const texts = (n) => (n.textContent || "");

// 1. the Suivi tab exists, in order, and its history lists what changed with a working Undo
async function historyAndUndo(m) {
  const h = mount(m, { routes: {
    "/api/inventoria/history": () => ({ body: { ok: true, items: [
      { id: "iop-0000000000000001", at: Math.floor(Date.now() / 1000), labels: ["Ajuster Lait de -1"], count: 1, auto: true, is_undo: false, undone: false, undoable: true },
      { id: "iop-0000000000000002", at: Math.floor(Date.now() / 1000) - 60, labels: ["Ajuster Riz de +2"], count: 1, auto: false, is_undo: false, undone: true, undoable: false }] } }),
    "/api/inventoria/ops/iop-0000000000000001/undo": () => ({ body: { ok: true, applied: [{ operation_id: "iop-0000000000000003" }] } }),
  } });
  await tick(10);
  const ids = h.doc.querySelectorAll(".hq-inventoria-tab").map((t) => t.dataset.tab);
  assert.deepEqual(ids, ["chat", "shop", "suivi", "settings"], "the Suivi tab sits between À acheter and Réglages");
  const pane = byId(h.doc, "hq-inv-pane-suivi");
  assert.ok(pane, "the Suivi pane exists");
  assert.equal(pane.children.filter((c) => c.tagName === "DETAILS").length, 5, "five sections: history, can-I, spending, filament, barcodes");
  const rows = pane.querySelectorAll(".hq-inventoria-history-row");
  assert.equal(rows.length, 2, "both batches are listed");
  assert.ok(texts(rows[0]).includes("Adjust Lait by -1"), "server labels are shown in English when the panel is English");
  assert.ok(texts(rows[1]).includes("undone"), "an undone batch is marked");
  assert.equal(rows[1].querySelectorAll(".hq-inventoria-history-undo").length, 0, "no Undo on a batch that was already undone");
  const undo = rows[0].querySelector(".hq-inventoria-history-undo");
  assert.ok(undo, "a live batch offers Undo");
  undo.click();
  await tick(8);
  const sent = h.net.callsTo("/api/inventoria/ops/iop-0000000000000001/undo");
  assert.equal(sent.length, 1, "one tap, one undo request");
  assert.equal(sent[0].body.apply, true, "the one-tap undo asks the server to apply the inverse at once");
}

// 2. the item sheet: minimum, expiry, barcode unlink, all through their own routes
async function itemSheet(m) {
  const sheetData = { ok: true, item: { id: ITEM, name: "Lait", qty: 4, unit: "L", min: 2, rev: 3, place_id: "plc-1", where: "Atelier", photo: null },
    expiry: "2026-11-19", expiry_days: 2, barcodes: ["0123456789012"], aliases: ["Lolo"], usual: { add: 2, use: null },
    price: { count: 1, cheapest: { store: "Maxi", avg_unit_cents: 325 }, history: [{ date: "2026-11-02", store: "Maxi", unit_cents: 325 }] }, warn_at: null, filament: null, unit_dim: "ml" };
  const h = mount(m, { routes: {
    ["/api/inventoria/item/" + ITEM]: () => ({ body: sheetData }),
    "/api/inventoria/min": (c) => ({ body: Object.assign({}, sheetData, { item: Object.assign({}, sheetData.item, { min: c.body.min }) }) }),
  } });
  await tick(6);
  assert.equal(typeof h.win.HqInventoria.openItem, "function", "the extension publishes openItem");
  h.win.HqInventoria.openItem(ITEM);
  await tick(8);
  const sheet = h.doc.querySelector(".hq-inventoria-sheet");
  assert.ok(sheet, "the sheet opens");
  assert.equal(sheet.getAttribute("role"), "dialog", "it is a labelled dialog");
  for (const word of ["Lait", "Minimum", "Use by", "Barcodes", "Maxi", "Lolo"]) assert.ok(texts(sheet).includes(word), "the sheet shows " + word);
  assert.ok(texts(sheet).includes("In 2 d"), "the expiry says how soon");
  // minimum
  const min = sheet.querySelectorAll("input").find((i) => i.type === "number");
  min.value = "9";
  byText(sheet, "Save", "button").click();
  await tick(8);
  const minCalls = h.net.callsTo("/api/inventoria/min");
  assert.equal(minCalls.length, 1, "saving the threshold calls /min once");
  assert.deepEqual([minCalls[0].body.item_id, minCalls[0].body.min], [ITEM, 9], "with the item and the number typed");
  // expiry
  const day = h.doc.querySelector(".hq-inventoria-sheet").querySelectorAll("input").find((i) => i.type === "date");
  day.value = "2026-12-01";
  const saves = h.doc.querySelector(".hq-inventoria-sheet").querySelectorAll("button").filter((b) => b.textContent === "Save");
  saves[1].click();
  await tick(8);
  const exp = h.net.callsTo("/api/inventoria/expiry");
  assert.equal(exp.length, 1, "saving the date calls /expiry once");
  assert.deepEqual([exp[0].body.item_id, exp[0].body.date], [ITEM, "2026-12-01"], "with the date typed");
  // barcode unlink
  h.doc.querySelector(".hq-inventoria-sheet").querySelectorAll("button").find((b) => (b.getAttribute("aria-label") || "").startsWith("Unlink code")).click();
  await tick(8);
  const un = h.net.callsTo("/api/inventoria/barcode");
  assert.equal(un.length, 1, "unlinking calls /barcode once");
  assert.deepEqual([un[0].body.action, un[0].body.code], ["unlink", "0123456789012"], "for that code");
  // closing
  h.doc.dispatchEvent({ type: "keydown", key: "Escape", bubbles: true });   // on the page, not on the sheet: focus is lost after a re-render
  await tick(2);
  assert.ok(!h.doc.querySelector(".hq-inventoria-sheet"), "Escape closes the sheet");
}

// 3. a change made with no signal is kept, shown, sent once on reconnect with its own client id
async function offlineQueue(m) {
  let online = false;
  const h = mount(m, { routes: {
    "/api/inventoria/quick": () => { if (!online) throw new TypeError("Failed to fetch"); return { body: { ok: true, applied: [{ operation_id: "iop-0000000000000009", changes: [] }] } }; },
  } });
  await tick(6);
  const ui = h.win.HqInventoria.ui;
  await ui.quickAdjust(ITEM, -1, "Lait −1");
  await tick(4);
  const queue = () => JSON.parse(h.win.localStorage.getItem("hq_inventoria_queue_v1") || "[]");
  assert.equal(queue().length, 1, "the failed change is queued, not lost");
  assert.match(queue()[0].cid, /^cid-[a-z0-9]+$/, "with a client id for duplicate-safe retries");
  const banner = h.doc.querySelector(".hq-inventoria-offline");
  assert.ok(banner && !banner.hidden && texts(banner).includes("1 waiting"), "a banner says what is waiting");
  assert.ok(texts(banner).includes("Lait −1"), "and lists it");
  const firstCid = queue()[0].cid;
  online = true;
  h.win.dispatchEvent({ type: "online" });
  await tick(12);
  const posts = h.net.callsTo("/api/inventoria/quick");
  const last = posts[posts.length - 1];
  assert.equal(last.body.client_id, firstCid, "the retry carries the same client id the first attempt had");
  assert.equal(last.body.item_id, ITEM, "and the same change");
  assert.equal(queue().length, 0, "the queue empties once the server accepted it");
  assert.ok(h.doc.querySelector(".hq-inventoria-offline").hidden, "the banner goes away");
}

// 4. an offline sentence is kept, and discarding works
async function offlineSay(m) {
  const h = mount(m);
  await tick(6);
  h.win.navigator.onLine = false;
  const input = h.doc.querySelector(".hq-inventoria-chat-input");
  input.value = "j'ai acheté du lait";
  h.doc.querySelector(".hq-inventoria-chat").dispatchEvent({ type: "submit", bubbles: true });
  await tick(4);
  assert.equal(h.net.callsTo("/api/inventoria/sessions/ivo-0000000000000001/message").length, 0, "no request is sent while offline");
  const q = JSON.parse(h.win.localStorage.getItem("hq_inventoria_queue_v1") || "[]");
  assert.deepEqual([q.length, q[0] && q[0].kind, q[0] && q[0].body.text], [1, "say", "j'ai acheté du lait"], "the sentence is kept for later");
  const banner = h.doc.querySelector(".hq-inventoria-offline");
  banner.querySelectorAll("button").find((b) => (b.getAttribute("aria-label") || "").startsWith("Discard")).click();
  await tick(2);
  assert.equal(JSON.parse(h.win.localStorage.getItem("hq_inventoria_queue_v1") || "[]").length, 0, "a queued item can be discarded");
}

// 5. haptics: a vibration when applied, none when switched off
async function haptics(m) {
  const buzz = [];
  const h = mount(m);
  h.win.navigator.vibrate = (p) => { buzz.push(p); return true; };
  await tick(6);
  const ui = h.win.HqInventoria.ui;
  ui.feedback("applied");
  assert.deepEqual(buzz, [14], "a short vibration when a change is applied");
  h.win.localStorage.setItem("hq_inventoria_haptics", "0");
  ui.feedback("applied");
  assert.equal(buzz.length, 1, "nothing once the switch is off");
}

// 6. language: the chip hands the panel to the language layer with the setting's language (the layer itself is tested in
//    check_inventoria_i18n.mjs and in the real browser; this DOM stub has no real text nodes to rewrite)
async function language(m) {
  const asked = [];
  for (const lang of ["en", "fr"]) {
    const h = mount(m, { lang });
    const I = h.win.HqInventoriaI18n;
    const original = I.apply;
    I.apply = (root, l) => { asked.push(lang + ">" + l); return original(root, l); };
    await tick(8);
  }
  assert.ok(asked.includes("en>en"), "an English setting asks for English");
  assert.ok(asked.includes("fr>fr"), "a French setting asks for French (so a flip back restores the original words)");
  const h = mount(m, { lang: "en" });
  await tick(8);
  assert.equal(h.win.localStorage.getItem("hq_inventoria_lang"), "en", "the language is remembered so the next visit never flashes the wrong one");
}

// 7. the calm "all good" line and the quiet streak (only when it is true)
async function calmAndStreak(m) {
  const calm = mount(m, { status: { calm: { calm: true, line: "Nothing to buy, nothing expiring, last count 3 days ago." }, streak: "Nothing ran out for 12 days." } });
  await tick(8);
  const empty = calm.doc.querySelector(".hq-inventoria-shop-empty"), streak = calm.doc.querySelector(".hq-inventoria-streak");
  assert.equal(empty.textContent, "Nothing to buy, nothing expiring, last count 3 days ago.", "the calm line replaces the generic one");
  assert.equal(empty.hidden, false, "it is shown when nothing needs attention");
  assert.equal(streak.textContent, "Nothing ran out for 12 days.", "the quiet streak line");
  assert.equal(streak.hidden, false, "the streak shows while calm");
  const busy = mount(m, { status: { calm: { calm: false, line: null }, streak: "Nothing ran out for 12 days." } });
  await tick(8);
  assert.equal(busy.doc.querySelector(".hq-inventoria-streak").hidden, true, "no streak line when something needs attention");
}

// 8. a tap is acknowledged at once, then answered in her voice, with "Usual amount" only when the server says it is true
async function savingAck(m) {
  let answer;
  const h = mount(m, { routes: { "/api/inventoria/quick": () => new Promise((res) => { answer = res; }) } });
  await tick(8);
  h.win.HqInventoria.ui.quickAdjust(ITEM, -2);
  await tick(3);
  const toast = h.doc.querySelector(".hq-inventoria-toast");
  assert.equal(toast.hidden, false, "the toast is up before the server answers");
  assert.ok(toast.textContent.includes("Saving…"), "it says it is saving");
  assert.ok(!toast.querySelector(".hq-inventoria-toast-undo"), "no Undo until something was applied");
  answer({ body: { ok: true, applied: [{ operation_id: "iop-0000000000000009", changes: [{ op: "item.adjust", item_id: ITEM, label_fr: "Ajuster Lait de -2", before: { qty: 6 }, after: { qty: 4 } }] }] } });
  await tick(8);
  assert.ok(!toast.textContent.includes("Saving"), "the real answer replaces it");
  assert.ok(toast.querySelector(".hq-inventoria-toast-undo"), "now there is an Undo");
}
async function voiceAndUsualMark(m) {
  const tone = { applied: ["Done — {c}."], applied_line: ["Done. The stock is current."], usual: "Usual amount", undone: ["Undone. Back to how it was."] };
  const run = async (usual) => {
    const h = mount(m, { status: { tone }, routes: { "/api/inventoria/quick": () => ({ body: { ok: true, applied: [{ operation_id: "iop-0000000000000009",
      changes: [{ op: "item.adjust", item_id: ITEM, label_fr: "Ajuster Lait de -2", before: { qty: 6 }, after: { qty: 4 }, usual }] }] } }) } });
    await tick(8);
    h.win.HqInventoria.ui.quickAdjust(ITEM, -2);
    await tick(8);
    return h.doc.querySelector(".hq-inventoria-toast");
  };
  const marked = await run(true);
  assert.ok(marked.textContent.startsWith("Done — "), "the toast uses her words, not the neutral label: " + marked.textContent);
  assert.ok(marked.querySelector(".hq-inventoria-mark"), "a usual amount carries a quiet mark");
  assert.equal(marked.querySelector(".hq-inventoria-mark").textContent, "Usual amount");
  const plain = await run(false);
  assert.ok(!plain.querySelector(".hq-inventoria-mark"), "no mark when the amount was not the usual one");
}

// 9. a guessed match shows the guess and the nearest alternatives; one tap swaps it. A sure match shows nothing.
async function guessFix(m) {
  const run = async (confidence) => {
    const op = { id: "ivo-op-1", status: "draft", proposals: [{ op: "item.adjust", label_fr: "Ajuster Lait 2% de +2", payload: { id: "itm-a", delta: 2 }, refs: { name_hint: "lait" } }] };
    const h = mount(m, { routes: {
      "/api/inventoria/sessions/ivo-0000000000000001/message": () => ({ body: { ok: true, messages: [{ role: "assistant", text: "Draft.", at: 1 }], operations: [op] } }),
      "/api/inventoria/ops/ivo-op-1/validate": () => ({ body: { ok: true, validation: { ok: true } } }),
      "/api/inventoria/ops/ivo-op-1/preview": () => ({ body: { ok: true, preview: { changes: [{ op: "item.adjust", item_id: "itm-a", label_fr: "Ajuster Lait 2% de +2",
        before: { qty: 1 }, after: { qty: 3 }, refs: { confidence } }] } } }),
      "/api/inventory": () => ({ body: { ok: true, items: [{ id: "itm-a", name: "Lait 2%" }, { id: "itm-b", name: "Lait d'amande" }, { id: "itm-c", name: "Riz" }], places: [] } }),
    } });
    await tick(8);
    const input = h.doc.querySelector(".hq-inventoria-chat-input");
    input.value = "ajoute 2 lait";
    h.doc.querySelector(".hq-inventoria-chat").dispatchEvent({ type: "submit", bubbles: true });
    await tick(14);
    return h;
  };
  const sure = await run("high");
  assert.ok(!sure.doc.querySelector(".hq-inventoria-guess"), "a sure match offers no 'not it?'");
  const h = await run("medium");
  const box = h.doc.querySelector(".hq-inventoria-guess");
  assert.ok(box, "a guess offers a fix in place");
  const alts = box.querySelectorAll("button").map((b) => b.textContent);
  assert.deepEqual(alts, ["Lait d'amande"], "only the nearest other items, not unrelated ones");
  box.querySelector("button").click();
  await tick(10);
  assert.equal(h.net.callsTo("/api/inventoria/ops/ivo-op-1/cancel").length, 1, "the wrong draft is dropped");
  const quick = h.net.callsTo("/api/inventoria/quick");
  assert.equal(quick.length, 1, "the chosen item gets the same change at once");
  assert.deepEqual([quick[0].body.item_id, quick[0].body.delta], ["itm-b", 2]);
}

// 10. shop mode: bigger rows, the row is the checkbox, ticks survive a closed app, one gesture marks them bought
async function shopMode(m) {
  const items = [{ id: "itm-a", name: "Lait", unit: "", buy: 2, store: "Maxi", level: "low" }, { id: "itm-b", name: "Riz", unit: "kg", buy: 1, store: "Maxi", level: "out" }];
  const list = { items, count: 2, text: "t", text_grouped: "g" };
  const h = mount(m, { status: { shopping: { all: list, urgent: list }, alerts: [{ id: "itm-a", name: "Lait", level: "low" }] },
    routes: { "/api/inventoria/purchased": () => ({ body: { ok: true, applied: [{ operation_id: "iop-0000000000000009", changes: [] }] } }) } });
  await tick(8);
  const pane = byId(h.doc, "hq-inv-pane-shop");
  const btn = h.doc.querySelector(".hq-inventoria-shopmode");
  assert.equal(btn.hidden, false, "shop mode is offered when there is a list");
  btn.click();
  assert.ok(pane.className.split(/\s+/).includes("is-shopping"), "shop mode is on");
  const row = pane.querySelectorAll(".hq-inventoria-checks li").find((li) => li.querySelector("input"));
  row.click();
  assert.equal(row.querySelectorAll("input")[0].checked, true, "tapping the row ticks it");
  assert.ok(JSON.parse(h.win.localStorage.getItem("hq_inventoria_checked_v1") || "{}")["itm-a"], "the tick is kept in case the app is closed in the store");
  // the offline DOM keeps `type` as a property only; the chip reads the attribute selector, as a real browser's DOM would allow
  pane.querySelectorAll(".hq-inventoria-checks input").forEach((i, k) => i.setAttribute("type", k % 2 === 0 ? "checkbox" : "number"));
  const bought = pane.querySelector("button.is-primary");
  assert.ok(bought.textContent.includes("(1)") && !bought.disabled, "one gesture marks the ticked items bought");
  bought.click();
  await tick(8);
  const sent = h.net.callsTo("/api/inventoria/purchased");
  assert.equal(sent.length, 1, "one purchase request");
  assert.deepEqual(sent[0].body.items, [{ id: "itm-a", qty: 2 }], "exactly what was ticked, at the suggested quantity");
  assert.equal(JSON.parse(h.win.localStorage.getItem("hq_inventoria_checked_v1") || "{}")["itm-a"], undefined, "ticks are cleared once bought");
  // the list empties while shop mode is on: it must not trap the user in a mode with nothing left to show
  h.net.on("/api/inventoria/status", () => ({ body: { ok: true, language: "en", alerts: [], shopping: { all: { items: [], count: 0, text: "" }, urgent: { items: [], count: 0, text: "" } },
    watches: [], memory: [], notify: {}, voice: {}, prefs: { auto_apply: true }, aliases: [], use_soon: [], filament: [], events: [], barcodes: [], greeting: {} } }));
  await h.win.HqInventoria.ui.refreshStatus({ force: true });
  await tick(6);
  assert.ok(!pane.className.split(/\s+/).includes("is-shopping"), "shop mode ends by itself once the list is empty");
}

// 11. the budget: settings are saved through the prefs route, and a spot-check can be put off
async function quietSettings(m) {
  const h = mount(m, { status: { asks: { max_per_day: 4, quiet_start: 22, quiet_end: 7, snoozed: false } },
    routes: { "/api/inventoria/prefs": () => ({ body: { ok: true, prefs: {}, asks: { max_per_day: 2, quiet_start: 22, quiet_end: 7, snoozed: true, snooze_until: Math.floor(Date.now() / 1000) + 86400 } } }) } });
  await tick(8);
  const box = h.doc.querySelector(".hq-inventoria-quietbox");
  assert.ok(box, "a Quiet & limits section exists");
  const nums = box.querySelectorAll("input");
  assert.deepEqual(nums.map((i) => i.value), ["4", "22", "7"], "it shows the current budget");
  nums[0].value = "2";
  nums[0].dispatchEvent({ type: "change", bubbles: true });
  await tick(6);
  const saved = h.net.callsTo("/api/inventoria/prefs").filter((c) => c.body && c.body.asks);
  assert.equal(saved.length, 1, "one save");
  assert.equal(saved[0].body.asks.max_per_day, 2);
  assert.ok(box.querySelector(".hq-inventoria-quiet-status").textContent.startsWith("Paused until"), "a pause is said out loud");
}
async function spotNotToday(m) {
  const h = mount(m, { status: { spot_check: { place_id: "plc-1", name: "Garage", items: 4, days_since: null } },
    routes: { "/api/inventoria/prefs": () => ({ body: { ok: true, prefs: {}, asks: {} } }) } });
  await tick(8);
  const later = h.doc.querySelectorAll(".hq-inventoria-insights button").find((b) => b.textContent === "Not today");
  assert.ok(later, "the weekly check can be put off");
  later.click();
  await tick(4);
  const c = h.net.callsTo("/api/inventoria/prefs").filter((x) => x.body && x.body.asks && x.body.asks.spot_snooze_days === 1);
  assert.equal(c.length, 1, "it snoozes only the spot-check, for a day");
}

const CASES = [
  { name: "history-and-undo", run: historyAndUndo, mutation: { file: "suivi", from: 'post(ui.opUrl(h.id, "undo"), { apply: true })', to: 'post(ui.opUrl(h.id, "undo-removed"), { apply: true })' } },
  { name: "item-sheet", run: itemSheet, mutation: { file: "suivi", from: 'post("/api/inventoria/min", { item_id: it.id, min: val })', to: 'post("/api/inventoria/min-removed", { item_id: it.id, min: val })' } },
  { name: "offline-queue", run: offlineQueue, mutation: { file: "chip", from: "if (isNetErr(e)) { offlineFlag = true; enqueue(kind, body, label, cid); return { queued: true }; }", to: "if (false) { return { queued: true }; }" } },
  { name: "offline-say", run: offlineSay, mutation: { file: "chip", from: 'enqueue("say", { text }, text.slice(0, 60), newCid());', to: "void 0;" } },
  { name: "haptics", run: haptics, mutation: { file: "chip", from: "navigator.vibrate(HAPTIC[kind] || 10); return; }", to: "void 0; }" } },
  { name: "language", run: language, mutation: { file: "chip", from: "try { I.apply(root, uiLang); } catch (_) {}", to: "void 0;" } },
  { name: "calm-and-streak", run: calmAndStreak, mutation: { file: "chip", from: "streakEl.hidden = !(calmNow && r.data.streak);", to: "streakEl.hidden = true;" } },
  { name: "saving-ack", run: savingAck, mutation: { file: "chip", from: "showSaving();", to: "void 0;" } },
  { name: "voice-and-usual-mark", run: voiceAndUsualMark, mutation: { file: "chip", from: "if (usualMark) toastBox.appendChild(usualMark);", to: "void 0;" } },
  { name: "guess-fix", run: guessFix, mutation: { file: "chip", from: 'conf === "high" || change.op', to: 'false || change.op' } },
  { name: "shop-mode", run: shopMode, mutation: { file: "chip", from: 'paneShop.classList.toggle("is-shopping", on);', to: "void 0;" } },
  { name: "quiet-settings", run: quietSettings, mutation: { file: "chip", from: '[capIn, qsIn, qeIn].forEach((inp) => inp.addEventListener("change", () => saveAsks()));', to: "void 0;" } },
  { name: "spot-not-today", run: spotNotToday, mutation: { file: "chip", from: "asks: { spot_snooze_days: 1 }", to: "asks: { spot_snooze_days: 0 }" } },
];
const ONLY = process.env.HQ_UI_CASE || "";
const selected = ONLY ? CASES.filter((c) => c.name === ONLY) : CASES;

if (!PROVE) {
  for (const c of selected) { await c.run(null); console.log("  ok  " + c.name); }
  console.log("check_inventoria_suivi_ui: ok (" + selected.length + " cases, offline DOM)");
} else {
  let proven = 0;
  for (const c of selected) {
    let failed = false;
    try { await c.run(c.mutation); } catch (_) { failed = true; }
    assert.ok(failed, c.name + ": assertions must fail once the wiring is removed");
    proven++;
    console.log("  ok  " + c.name + " fails without its key line");
  }
  console.log("check_inventoria_suivi_ui: load-bearing (mutations detected: " + proven + "/" + selected.length + ")");
}
