// The visits panel itself, driven in the project's headless DOM against the
// running bridge: assets/hq-assistant-visits.js is loaded as shipped, its own
// loadBanter() calls the real /api/assistant-visit-banter, its own run() paints
// the bubbles, and the bond badge is read back from the DOM.
//
//   node tests/check_hq_visit_panel.mjs culinia pistonia
//
// Credentials come from the environment only (HQ_COOKIE) and are never printed.
// Exit 0 means: the panel got a payload, both women speak, bubbles painted, and
// exactly the earned bond (or none) is shown.
import assert from "node:assert/strict";
import { loadChip, tick, all } from "./hq_dom_stub.mjs";

const host = String(process.argv[2] || "culinia").toLowerCase();
const guest = String(process.argv[3] || "pistonia").toLowerCase();
const base = String(process.env.HQ_BRIDGE || "http://127.0.0.1:8765");
const rawCookie = String(process.env.HQ_COOKIE || "");
assert.ok(rawCookie, "HQ_COOKIE must be set by the caller");
// Accept either the bare session token or a full cookie header, and send the
// name the bridge actually reads.
const cookie = rawCookie.includes("=")
  ? rawCookie
  : "transfert_session=" + rawCookie;

const seen = { banter: null };
const h = loadChip("hq-assistant-visits.js", {
  view: "accueil",
  // The panel exposes nothing, so the harness reaches its own render functions.
  // Nothing else in the shipped file is touched.
  mutate: (source) => source.replace(
    /\}\)\(\);\s*$/,
    ";window.__hqVisitTest={loadBanter:loadBanter,run:run,mapBanter:mapBanter,chipByKey:chipByKey};})();"),
  setup(net) {
    net.on("*", async (call) => {
      const response = await fetch(base + call.url, {
        method: call.method,
        headers: { "Content-Type": "application/json", "Cookie": cookie, "Origin": base },
        body: call.method === "GET" ? undefined : JSON.stringify(call.body || {}),
      });
      const body = await response.json().catch(() => ({}));
      if (call.url.startsWith("/api/assistant-visit-banter") && body && body.ok && !seen.banter) {
        seen.banter = body;
      }
      return { status: response.status, body };
    });
  },
});
const { doc, win } = h;

doc.body.innerHTML =
  `<button class="hq-${host}-chip" type="button"></button>` +
  `<button class="hq-${guest}-chip" type="button"></button>`;
const chips = { [host]: doc.querySelector(`.hq-${host}-chip`), [guest]: doc.querySelector(`.hq-${guest}-chip`) };
for (const el of Object.values(chips)) {
  assert.ok(el, "chip missing from the harness markup");
  el.offsetWidth = 54;
  el.offsetHeight = 54;
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 54, bottom: 54, width: 54, height: 54, x: 0, y: 0 });
}

const panel = win.__hqVisitTest;
assert.ok(panel && typeof panel.loadBanter === "function", "the panel's generation path is reachable");

const payload = await new Promise((resolve) => {
  panel.loadBanter(host, guest, "checkin", (result) => resolve(result));
  // Let the panel's own fetch resolve.
  const pump = setInterval(async () => {
    await tick(4);
    if (seen.banter) { clearInterval(pump); }
  }, 10);
  setTimeout(() => { clearInterval(pump); resolve({ lines: null, reason: "timeout" }); }, 60000);
});
void payload;

assert.ok(seen.banter, "the panel's own fetch never got a payload");
assert.equal(seen.banter.lines.length, 4, "a checkin exchange is four lines");
assert.ok(seen.banter.lines.some((l) => l.who === host), `${host} has no line`);
assert.ok(seen.banter.lines.some((l) => l.who === guest), `${guest} has no line`);

const hostChip = panel.chipByKey(host);
const guestChip = panel.chipByKey(guest);
const generated = panel.mapBanter(seen.banter.lines, hostChip, guestChip, "checkin");
assert.ok(generated, "the panel rejected its own payload");
panel.run({ chip: hostChip, el: chips[host] }, guestChip, null, generated, "",
          seen.banter.provider, "", "checkin", seen.banter.wants, seen.banter.bond);

/** Run the panel's queued timers until the exchange has painted. */
const plain = (text) => String(text).replace(/[\s   ​]+/g, " ").trim();
const waiter = { said: [], bond: [], text: "" };
for (let round = 0; round < 400; round++) {
  const nodes = all(doc.body).filter((n) => n.matches && n.matches(".hq-visit-bubble"));
  const bondNodes = all(doc.body).filter((n) => n.matches && n.matches(".hq-visit-bond"));
  // The panel keeps one bubble per speaker on stage, so lines are collected as
  // they appear rather than read from a single frame. Each one is taken with the
  // speaker the *rendered DOM* declares, never with the one we expected.
  for (const node of nodes) {
    const text = plain(node.textContent);
    const who = node.getAttribute ? node.getAttribute("data-speaker") : null;
    if (!text) continue;
    if (!waiter.said.some((entry) => entry.text === text && entry.who === who)) {
      waiter.said.push({ who: who || null, text });
    }
  }
  if (bondNodes.length) waiter.bond = bondNodes.map((n) => n.textContent.trim()).filter(Boolean);
  waiter.text = doc.body.textContent;
  if (waiter.said.length >= generated.length) break;
  const due = [...win.timers.entries()].filter(([, t]) => !t.interval)
    .sort((a, b) => (a[1].ms - b[1].ms) || (a[0] - b[0]));
  if (!due.length) { await tick(2); continue; }
  win.timers.delete(due[0][0]);
  due[0][1].fn();
  await tick(2);
}

// In order: the panel maps each line to a speaker, and the DOM must agree with
// that mapping for every bubble it painted.
assert.equal(waiter.said.length, generated.length,
             `painted ${waiter.said.length} bubbles for ${generated.length} lines: ${JSON.stringify(waiter.said)}`);
waiter.said.forEach((entry, index) => {
  const line = generated[index];
  assert.ok(entry.text.includes(plain(line.text)),
            `bubble ${index + 1} is not line ${index + 1}: ${entry.text} vs ${line.text}`);
  assert.ok(entry.who, `bubble ${index + 1} carries no data-speaker: ${entry.text}`);
  assert.equal(entry.who, line.who.key,
               `bubble ${index + 1} is attributed to ${entry.who}, not ${line.who.key}: ${entry.text}`);
});

const earned = Boolean(seen.banter.bond && seen.banter.bond.text);
if (earned) {
  assert.deepEqual(waiter.bond, [seen.banter.bond.text], "the earned bond is not shown");
} else {
  assert.deepEqual(waiter.bond, [], "a pair without an earned bond must stay plain");
}

console.log(JSON.stringify({
  host, visitor: guest,
  provider: seen.banter.provider,
  bond: earned ? waiter.bond[0] : null,
  bubbles: waiter.said.map((entry) => ({ speaker: entry.who, text: entry.text })),
}, null, 2));
