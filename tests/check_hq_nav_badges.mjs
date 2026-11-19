// Nav badges (assets/hq-nav-badges.js): the four sources, and the single dot Plus folds them into on a phone.
// Runs the real script against the tiny DOM stub — no browser, no server.
import assert from "node:assert/strict";
import { loadChip } from "./hq_dom_stub.mjs";

const VIEWS = ["accueil", "carnet", "calendrier", "fichiers", "plus", "forge", "securite"];

// The stub has no HTML parser at boot time, so the nav is built in the sandbox before the script runs.
// data-nav goes through setAttribute: the stub keeps attributes and dataset as two maps.
const DOM = `
(function () {
  var nav = document.createElement("nav");
  nav.className = "bottom-nav";
  ${JSON.stringify(VIEWS)}.forEach(function (view) {
    var b = document.createElement("button");
    b.setAttribute("data-nav", view);
    nav.appendChild(b);
  });
  document.body.appendChild(nav);
})();
`;

// The script asks window.matchMedia each paint; overriding it before load is how the wide branch is exercised.
const WIDE = 'window.matchMedia = function () { return { matches: true, addEventListener: function () {}, removeEventListener: function () {} }; };\n';

const pad = (n) => (n < 10 ? "0" + n : String(n));
const now = () => Date.now();

function iso(hoursFromNow) {
  const d = new Date(now() + hoursFromNow * 3600 * 1000);
  return {
    start: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()),
    hhmm: pad(d.getHours()) + ":" + pad(d.getMinutes()),
  };
}

async function run({ wide = false, admin = true, seen = {}, carnet = [], calendar = [], forge = [], securia = 0 }) {
  const seed = {};
  if (Object.keys(seen).length) seed.hq_nav_seen_v1 = JSON.stringify(seen);
  const { doc, net } = loadChip("hq-nav-badges.js", {
    bodyClass: admin ? "session-admin" : "session-upload",
    win: { localStorage: seed },
    mutate: (src) => DOM + "\n" + (wide ? WIDE : "") + src,
    setup(n) {
      n.on("*", (call) => {
        const url = call.url;
        if (url.startsWith("/api/carnet")) return { body: { pages: carnet } };
        if (url.startsWith("/api/calendar")) return { body: { items: calendar } };
        if (url.startsWith("/api/forge/jobs")) return { body: { jobs: forge } };
        if (url.startsWith("/api/securia/status")) return { body: { failures_recent: securia, alert_level: securia ? "warning" : "ok" } };
        return { body: {} };
      });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const badge = (view) => {
    const node = doc.querySelector('[data-nav="' + view + '"] .hq-nav-badge');
    if (!node) return null;
    return {
      text: node.textContent,
      dot: node.classList.contains("is-dot"),
      warn: node.classList.contains("is-warn"),
      aria: node.getAttribute("aria-label"),
    };
  };
  // A badge is expected here: say so plainly instead of failing on null.text.
  const must = (view, why) => {
    const found = badge(view);
    assert.ok(found, (why || view) + " — no badge was drawn");
    return found;
  };
  const help = doc.querySelector('[data-nav="calendrier"]').getAttribute("data-help");
  return { doc, net, badge, must, help };
}

const soon = iso(2);
const later = iso(4);
const page = (updatedAt) => ({ id: "p" + updatedAt, updated_at: updatedAt / 1000, deleted_at: null });
const everything = {
  carnet: [page(now() - 60_000), page(now() - 120_000), page(now() - 600_000)],
  seen: { carnet: (now() - 300_000) / 1000 },
  calendar: [
    { id: "a", title: "Dentiste", start: soon.start },
    { id: "b", title: "Souper", start: later.start },
    { id: "c", title: "Planifié", start: later.start, read_only: true },
  ],
  forge: [{ id: "j1", state: "generating" }, { id: "j2", state: "queued" }, { id: "j3", state: "done" }],
  securia: 2,
};

// 1. Desktop: each source paints its own count, and nothing is folded onto Plus.
{
  const { net, must, badge, help } = await run({ ...everything, wide: true });
  assert.equal(net.calls.length, 4, "one request per source");
  assert.ok(net.calls.some((c) => c.url.startsWith("/api/calendar?from=")), "the calendar is asked for a range");
  assert.equal(must("carnet", "desktop: unread Carnet").text, "2", "carnet: only pages changed since the last visit");
  assert.equal(must("calendrier", "desktop: today's calendar").text, "2", "calendrier: today's items, read_only activity excluded");
  assert.equal(must("forge", "desktop: running jobs").text, "2", "forge: only queued/starting/generating/saving count");
  assert.equal(must("securite", "desktop: recent failures").text, "2", "securite: the failures_recent count");
  assert.equal(badge("securite").warn, true, "securite is the warn-coloured one");
  assert.equal(badge("carnet").warn, false);
  assert.equal(badge("plus"), null, "desktop: no Plus dot, the rail shows the entries themselves");
  assert.equal(help, "Prochain : Dentiste à " + soon.hhmm, "the calendar tooltip names the next event");
}

// 2. Phone: the two bar tabs keep their own counts, the buried sources fold into one Plus dot.
{
  const { badge, must } = await run(everything);
  const carnet = must("carnet", "phone: carnet stays on its own tab");
  assert.equal(carnet.text, "2");
  assert.equal(carnet.dot, false);
  assert.equal(must("calendrier", "phone: calendrier stays on its own tab").text, "2");
  const plus = must("plus", "phone: Plus carries the folded badge");
  assert.equal(plus.dot, true, "the folded badge is a dot, not a number");
  assert.equal(plus.text, "", "the dot shows no digits");
  assert.equal(plus.warn, true, "one warning source is enough to warn the dot");
  assert.equal(plus.aria, "4 nouveautés", "the dot still counts forge 2 + securite 2 for screen readers");
  assert.equal(badge("forge"), null, "phone: forge is not drawn outside the bar");
  assert.equal(badge("securite"), null, "phone: securite is not drawn outside the bar");
}

// 3. Phone with the buried sources empty: no dot at all, the bar counts stay.
{
  const { badge, must } = await run({ ...everything, forge: [], securia: 0 });
  assert.equal(badge("plus"), null, "nothing folded: no dot");
  assert.equal(must("carnet").text, "2");
  assert.equal(must("calendrier").text, "2");
}

// 4. Phone with everything at zero: no badge anywhere.
{
  const { badge } = await run({ carnet: [], calendar: [], forge: [], securia: 0 });
  assert.equal(badge("plus"), null);
  assert.equal(badge("carnet"), null);
  assert.equal(badge("calendrier"), null);
}

// 5. The count is capped at 9+, the accessible label keeps the real number.
{
  const busy = Array.from({ length: 12 }, (_, i) => ({ id: "j" + i, state: "saving" }));
  const phone = await run({ forge: busy });
  const plus = phone.must("plus", "phone: a dozen jobs still fold");
  assert.equal(plus.dot, true);
  assert.equal(plus.aria, "12 nouveautés", "the dot reports the true count");

  const wide = await run({ wide: true, forge: busy });
  assert.equal(wide.must("forge").text, "9+", "a number badge caps at 9+");
  assert.equal(wide.badge("forge").aria, "12 nouveautés");
}

// 6. Calendrier clears once opened today, the tooltip does not.
{
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const opened = await run({ ...everything, wide: true, seen: { calendrier: midnight.getTime() / 1000 + 60 } });
  assert.equal(opened.badge("calendrier"), null, "opened today: no calendar badge");
  assert.equal(opened.help, "Prochain : Dentiste à " + soon.hhmm, "the tooltip still says what is coming");

  const yesterday = await run({ ...everything, wide: true, seen: { calendrier: midnight.getTime() / 1000 - 3 * 86400 } });
  assert.equal(yesterday.must("calendrier", "a visit three days ago").text, "2", "a visit three days ago does not silence today");
}

// 7. Signed out: the script asks for nothing and draws nothing.
{
  const { net, badge } = await run({ admin: false, ...everything });
  assert.equal(net.calls.length, 0, "no polling without an admin session");
  assert.equal(badge("carnet"), null);
  assert.equal(badge("plus"), null);
}

console.log("check_hq_nav_badges: ok");
