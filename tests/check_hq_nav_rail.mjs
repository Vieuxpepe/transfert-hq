// The nav's two shapes (assets/hq-nav-order.js + assets/hq-nav-plus.js + the nav CSS in iphone_bridge.py): the desk-
// top rail (collapse remembered per browser, 44px rows instead of squeezed ones, group hairlines that follow the
// position) and the phone's Plus panel (the rail's icons, a Récemment ouvert row, the folded Système wall, one name
// per shape). Runs the real scripts against the tiny DOM stub — no browser, no server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadChip } from "./hq_dom_stub.mjs";

const bridge = readFileSync(new URL("../iphone_bridge.py", import.meta.url), "utf8");
const source = readFileSync(new URL("../assets/hq-nav-order.js", import.meta.url), "utf8");

const VIEWS = ["accueil", "carnet", "calendrier", "dessiner", "forge", "ops", "plus"];
const COMPACT_KEY = "hq_desktop_nav_compact";
const ORDER_KEY = "hq_desktop_nav_order";

// The stub has no HTML parser at boot time, so the rail is built in the sandbox before the script runs. The collapse
// toggle is a real button with its own label, exactly as iphone_bridge.py ships it.
const DOM = `
(function () {
  var nav = document.createElement("nav");
  nav.className = "bottom-nav";
  var toggle = document.createElement("button");
  toggle.className = "hq-nav-collapse";
  var label = document.createElement("span");
  label.className = "nav-label";
  label.textContent = "Réduire";
  toggle.appendChild(label);
  nav.appendChild(toggle);
  ${JSON.stringify(VIEWS)}.forEach(function (view) {
    var b = document.createElement("button");
    b.setAttribute("data-nav", view);
    nav.appendChild(b);
  });
  document.body.appendChild(nav);
})();
`;

// matchMedia is asked once at boot; overriding it before the load is how the wide or the phone shape is exercised. The
// object is kept on the window so a test can flip the shape and fire the resize the scripts already listen for.
const media = (wide) =>
  'window.matchMedia = function () { window.__media = { matches: ' + (wide ? "true" : "false") +
  ', addEventListener: function () {}, removeEventListener: function () {} }; return window.__media; };\n';

// The stub's selector parser has no :scope, and the rail's children are exactly its buttons, so the one selector that
// needs it is widened. Doing it here keeps the shared stub untouched; if the source drops :scope the shim stops matching
// and the arrangement assertions below fail loudly.
const SCOPE = ':scope > button[data-nav]';
const shim = (src) => src.split(SCOPE).join('button[data-nav]');
assert.ok(source.includes(SCOPE), "the rail still selects its own rows with :scope — update this check's shim");

function boot({ wide = true, compact = null, order = null } = {}) {
  const seed = {};
  if (compact != null) seed[COMPACT_KEY] = compact;
  if (order) seed[ORDER_KEY] = JSON.stringify(order);
  const { doc, win } = loadChip("hq-nav-order.js", {
    bodyClass: "session-admin",
    win: { localStorage: seed },
    mutate: (src) => DOM + media(wide) + shim(src),
  });
  const nav = doc.querySelector(".bottom-nav");
  const toggle = nav.querySelector("button.hq-nav-collapse");
  const row = (view) => nav.querySelector('button[data-nav="' + view + '"]');
  // arrange() writes dataset.section / dataset.groupStart; the stub keeps attributes and dataset as two maps, so read the
  // one the script writes (a browser reflects it back onto the attribute the CSS matches).
  const attr = (view, key) => row(view).dataset[key];
  const collapsed = () => doc.body.classList.contains("nav-rail-compact");
  // The hairline rows in the order the rail actually renders them, which is the order the CSS sees.
  const starts = () => nav.children
    .filter((node) => node.nodeType === 1 && node.dataset.nav && node.dataset.groupStart === "1")
    .map((node) => node.dataset.nav);
  return { doc, win, nav, toggle, row, attr, collapsed, starts };
}

// 1. The rail keeps a 44px row and scrolls past it; it no longer distributes whatever height is left.
{
  const rail = bridge.match(/\.bottom-nav\{position:sticky[^}]*\}/);
  assert.ok(rail, "the wide rail rule is still there");
  assert.ok(/grid-auto-rows:minmax\(44px,auto\)/.test(rail[0]), "rows keep a 44px floor");
  assert.ok(/overflow-y:auto/.test(rail[0]), "the rail scrolls instead of squeezing its rows");
  assert.ok(/overflow-x:hidden/.test(rail[0]),
    "the rail never scrolls sideways: a stray wide child would add a horizontal scrollbar and eat rail height");
  // The rows are laid out before the rail knows it will scroll; without a reserved gutter the scrollbar appears on top
  // of a width that was measured without it, and the highlight's right edge ends up under it (147px ink in a 136px
  // content box at 768, clipped 3px). A stable gutter keeps the content width identical at every height.
  assert.ok(/scrollbar-gutter:stable/.test(rail[0]),
    "the rail reserves the scrollbar's width, so collapsing/expanding the scroll cycle never changes the row width");
  // Compact keeps the scrollbar (the "more below" cue) and pays its gutter back as left padding — but the gutter is
  // measured, not assumed: 11px classic, 0 for an overlay bar. A hard-coded 15px would sit ~5px right of centre there.
  assert.ok(/body\.nav-rail-compact \.bottom-nav\{scrollbar-gutter:stable;padding-left:calc\(4px \+ var\(--nav-gutter,0px\)\);padding-right:4px\}/.test(bridge),
    "the compact rail centres its icon column from the measured gutter, and still shows the scrollbar");
  assert.ok(!/nav-rail-compact \.bottom-nav\{[^}]*padding-left:15px/.test(bridge),
    "the compensation is not hard-coded to a classic 11px scrollbar");
  assert.ok(/setProperty\("--nav-gutter"/.test(source) && /Number\(nav\.offsetWidth\)/.test(source) &&
    /Number\(nav\.clientWidth\)/.test(source),
    "hq-nav-order.js writes --nav-gutter from offsetWidth − clientWidth, so the CSS follows the real scrollbar");
  assert.ok(!/grid-auto-rows:minmax\(0,1fr\)/.test(bridge), "no rule squeezes the rows to fit the window");
  assert.ok(/\.bottom-nav button\{display:flex[^}]*min-height:44px/.test(bridge), "a rail row is at least 44px tall");
}

// 1b. The rail carries the toggle itself: a real button in the nav, before the rows, never a row of its own.
{
  const start = bridge.indexOf('<nav class="bottom-nav"');
  const nav = bridge.slice(start, bridge.indexOf("</nav>", start));
  const toggle = nav.match(/<button[^>]*class="hq-nav-collapse"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(toggle, "the rail carries its collapse toggle");
  assert.ok(toggle[0].includes('id="hq-nav-collapse"'), "the toggle keeps its id");
  assert.ok(toggle[0].includes('aria-expanded="true"'), "it starts expanded, like the rail it belongs to");
  assert.ok(toggle[0].includes('aria-controls="hq-nav"'), "a disclosure names the region it opens and closes");
  assert.ok(/type="button"/.test(toggle[0]), "a real button, so Enter and Space reach it without a form submit");
  assert.ok(toggle[0].includes("data-help="), "it explains itself like every other nav control");
  assert.ok(!/data-nav=/.test(toggle[0]),
    "the toggle is not a nav row, so the order and the section markers never pick it up");
  assert.ok(nav.indexOf('class="hq-nav-collapse"') < nav.indexOf("data-nav="),
    "the toggle sits above the rows, where a sticky header belongs");
  assert.ok(/class="nav-label"/.test(toggle[0]), "it carries a label that the compact rule hides");
}

// 1c. Both persisted choices keep their keys: renaming either would silently forget what the browser already stored.
{
  assert.ok(source.includes('const STORAGE_KEY = "hq_desktop_nav_order";'), "the order key is unchanged");
  assert.ok(source.includes('const COMPACT_KEY = "hq_desktop_nav_compact";'), "the collapse key is unchanged");
}

// 2. One hairline rule, keyed on the marker the script writes — never on the entry a group used to start with.
{
  assert.ok(/\.bottom-nav button\[data-group-start="1"\]\{[^}]*border-top:1px solid var\(--line\)/.test(bridge),
    "the group hairline is drawn from data-group-start");
  assert.ok(!/\.bottom-nav \[data-nav="(?:dessiner|ops)"\][^{]*\{[^}]*border-top/.test(bridge),
    "no hairline is glued to the dessiner / ops entries");
  assert.ok(/\.nav-rail-compact\{--nav-w:56px\}/.test(bridge), "the collapsed rail is 56px wide");
  assert.ok(/\.nav-rail-compact \.bottom-nav \.nav-label\{display:none\}/.test(bridge),
    "the collapsed rail keeps the icons and hides the labels");
  const phone = bridge.match(/@media \(max-width:899px\)\{[\s\S]*?\n\}/);
  assert.ok(phone && /\.bottom-nav button\.hq-nav-collapse\{display:none\}/.test(phone[0]),
    "the phone bar has no rail toggle");
}

// 2b. Backstop: the gliding highlight can never be wider than the rail it sits in. hq-theme.js writes its width in px
//     from the active row; if that re-place cannot run, a stale expanded width overflowed the 56px rail into a
//     horizontal scrollbar that ate 11px of rail height (clientHeight 889 of 900, 11px of scroll at 900px).
{
  // The file holds several min-width:900px blocks, so the rail is the rule that makes it sticky, up to the next @media.
  const start = bridge.indexOf(".bottom-nav{position:sticky");
  assert.ok(start > 0, "the wide rail rule is still there");
  const next = bridge.indexOf("@media", start);
  // overflow-x:hidden is the single mechanism: a stale, px-placed layer (the ink keeps its expanded width and its old
  // translate if the re-place never runs) is clipped instead of generating a scrollbar. No second clamp necessary.
  assert.ok(!/\.nav-ink\{[^}]*max-width/.test(bridge.slice(start, next > start ? next : undefined)),
    "one mechanism only: the ink is not also clamped, overflow-x:hidden already guarantees no horizontal scrollbar");
}

// 3. A remembered collapse is applied at boot, with the toggle announcing what it will do next.
{
  const { toggle, collapsed } = boot({ compact: "1" });
  assert.equal(collapsed(), true, "the stored collapse folds the rail on load");
  assert.equal(toggle.getAttribute("aria-expanded"), "false", "a folded rail is an unexpanded disclosure");
  assert.equal(toggle.getAttribute("aria-label"), "Déployer le menu");
  assert.equal(toggle.textContent, "Déployer");
}

// 4. Nothing stored: wide rail, and each click is written where the next load reads it.
{
  const { win, toggle, collapsed } = boot();
  assert.equal(collapsed(), false, "an unset preference leaves the rail wide");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.textContent, "Réduire");

  toggle.click();
  assert.equal(win.localStorage.getItem(COMPACT_KEY), "1", "collapsing is remembered");
  assert.equal(collapsed(), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false", "collapsing reports itself as unexpanded");
  assert.equal(toggle.getAttribute("aria-label"), "Déployer le menu");

  toggle.click();
  assert.equal(win.localStorage.getItem(COMPACT_KEY), "0", "expanding is remembered too");
  assert.equal(collapsed(), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true", "expanding reports itself as expanded again");
}

// 4b. Collapsing re-places the ink synchronously. hq-theme.js measures the active row when it hears hq:nav-order; a
//     dispatch deferred to requestAnimationFrame never ran in a paused/occluded window, so the ink kept its 144px
//     expanded width inside the 56px rail (scrollWidth 144 vs clientWidth 55) and the rail scrolled by the 11px the
//     horizontal scrollbar stole. The event must be heard by the time the click returns.
{
  const paint = source.match(/function paintToggle\(\) \{[\s\S]*?\n    \}/);
  assert.ok(paint, "the collapse still paints itself through paintToggle");
  assert.ok(/nav\.dispatchEvent\(new Event\("hq:nav-order"\)\)/.test(paint[0]),
    "paintToggle tells the highlight to re-place after the rail changes width");
  assert.ok(!/requestAnimationFrame/.test(paint[0]),
    "the re-place is not deferred to a frame a paused or occluded window never gets");
  assert.ok(!/requestAnimationFrame\([^)]*=> nav\.dispatchEvent\(new Event\("hq:nav-order"\)\)\)/.test(source),
    "no rAF-wrapped re-place survives anywhere in the file");

  const { nav, toggle } = boot();
  let heard = 0;
  nav.addEventListener("hq:nav-order", () => { heard += 1; });
  toggle.click();
  assert.ok(heard >= 1, "collapsing has already dispatched hq:nav-order when click() returns");
  const afterCollapse = heard;
  toggle.click();
  assert.ok(heard > afterCollapse, "expanding re-places it again, not just once");
}

// 5. The phone bar never folds, and a visit on the phone does not forget the desktop choice.
{
  const { win, toggle, collapsed } = boot({ wide: false, compact: "1" });
  assert.equal(collapsed(), false, "the phone shape is unaffected by the desktop preference");
  assert.equal(toggle.getAttribute("aria-expanded"), "true", "a bar that cannot collapse still says it is expanded");
  assert.equal(win.localStorage.getItem(COMPACT_KEY), "1", "loading on the phone keeps the stored choice");
}

// 5b. The reorder gesture is shaped by the device: a mouse drags on movement, touch keeps the hold that protects scrolling.
{
  const pointer = (type, extra) => ({
    type, bubbles: true, cancelable: true, isPrimary: true, button: 0, buttons: 1, pointerId: 7, clientX: 10, clientY: 10,
    ...extra,
  });
  // The stub has no layout engine, so the rows are given the size a real rail renders them at.
  const size = (ctx) => {
    for (const node of ctx.nav.children) if (node.dataset.nav) { node.offsetWidth = 164; node.offsetHeight = 44; }
  };
  const mouse = boot();
  size(mouse);
  const mrow = mouse.row("carnet");
  const mouseTimers = mouse.win.timers.size;
  mrow.dispatchEvent(pointer("pointerdown", { pointerType: "mouse" }));
  assert.equal(mouse.win.timers.size, mouseTimers, "a mouse press waits for no hold timer");
  mouse.win.dispatchEvent(pointer("pointermove", { clientY: 40 }));
  assert.ok(mrow.className.includes("is-nav-dragging"), "a mouse drag starts as soon as the pointer moves");

  const touch = boot();
  size(touch);
  const trow = touch.row("carnet");
  const touchTimers = touch.win.timers.size;
  trow.dispatchEvent(pointer("pointerdown", { pointerType: "touch" }));
  assert.equal(touch.win.timers.size, touchTimers + 1, "a touch press starts the hold timer");
  touch.win.dispatchEvent(pointer("pointermove", { clientY: 40 }));
  assert.ok(!trow.className.includes("is-nav-dragging"), "a moving finger scrolls the page instead of dragging the rail");
  assert.equal(touch.win.timers.size, touchTimers, "and the cancelled hold leaves no timer behind");

  // A press that never moves is a tap: it must stay a tap on touch, and a click on the mouse must never be swallowed.
  const tap = boot();
  size(tap);
  tap.row("carnet").dispatchEvent(pointer("pointerdown", { pointerType: "touch" }));
  tap.win.dispatchEvent(pointer("pointerup", { clientY: 10 }));
  assert.ok(!tap.row("carnet").className.includes("is-nav-dragging"), "an unmoved touch press never arms a drag");
}

// 6. Grouping is read from the current order: every row carries its kind, the row after a change carries the hairline.
{
  const { collapsed, attr, starts } = boot();
  assert.equal(collapsed(), false);
  assert.equal(attr("accueil", "section"), "quotidien");
  assert.equal(attr("forge", "section"), "espaces");
  assert.equal(attr("plus", "section"), "systeme");
  for (const view of VIEWS) assert.ok(attr(view, "section"), view + ": every row is stamped with its section");
  assert.deepEqual(starts(), ["dessiner", "ops"], "one hairline where the kind changes");
}

// 7. The same rows in a dragged order: the hairline stays on the boundary in the list, not on the entry that moved.
{
  const moved = ["ops", "accueil", "carnet", "dessiner", "calendrier", "forge", "plus"];
  const { starts, attr } = boot({ order: moved });
  assert.equal(attr("calendrier", "section"), "quotidien");
  assert.equal(attr("ops", "section"), "systeme");
  assert.deepEqual(starts(), ["accueil", "dessiner", "calendrier", "forge", "plus"],
    "a boundary entry dragged into another group does not drag a hairline with it");
  assert.ok(!starts().includes("ops"), "ops is no longer a group start just because it is ops");
}

// 8. Moving a group into the middle moves its boundary with it.
{
  const moved = ["accueil", "plus", "carnet", "calendrier", "dessiner", "forge", "ops"];
  const { starts } = boot({ order: moved });
  assert.deepEqual(starts(), ["plus", "carnet", "dessiner", "ops"],
    "the systeme group takes its hairline wherever it is dropped");
}

// ---- the phone's other shape: the Plus panel (assets/hq-nav-plus.js) ----------------------------------------------

const plusSource = readFileSync(new URL("../assets/hq-nav-plus.js", import.meta.url), "utf8");
const FOLD_KEY = "hq_nav_system_fold";
const NAMES = {
  dessiner: "Dessiner", forge: "Forge Studio", projets: "Projets", inventaire: "Inventaire",
  playground: "Playground", lecteur: "Lecteur", musique: "Musique", intime: "Tête-à-tête",
  engine: "Engine", robotique: "Robotique", securite: "Sécurité", ops: "Terminal",
};
// The panel's twelve links, in the order the four groups list them.
const PANEL = ["dessiner", "forge", "projets", "inventaire", "playground", "lecteur", "musique", "intime", "engine", "robotique", "securite", "ops"];

// The rail's rows (each with the icon the panel has to borrow), the panel's four links, and the Système disclosure.
const PANEL_DOM = `
(function () {
  window.__opened = null;
  window.setView = function (view) { window.__opened = view; };
  var names = ${JSON.stringify(NAMES)};
  var nav = document.createElement("nav");
  nav.className = "bottom-nav";
  Object.keys(names).forEach(function (view) {
    var row = document.createElement("button");
    row.setAttribute("data-nav", view);
    var ico = document.createElement("span");
    ico.className = "nav-ico";
    ico.innerHTML = '<svg class="nav-svg" data-icon="' + view + '"></svg>';
    var label = document.createElement("span");
    label.className = "nav-label";
    label.textContent = names[view];
    row.append(ico, label);
    nav.appendChild(row);
  });
  document.body.appendChild(nav);
  var more = document.createElement("nav");
  more.className = "hq-more-nav";
  ${JSON.stringify(PANEL)}.forEach(function (view) {
    var link = document.createElement("a");
    link.setAttribute("data-view-link", view);
    link.textContent = names[view];
    more.appendChild(link);
  });
  document.body.appendChild(more);
  var fold = document.createElement("details");
  fold.className = "hq-sys-fold";
  fold.id = "hq-sys-fold";
  fold.open = true;
  document.body.appendChild(fold);
})();
`;

function bootPlus({ wide = false, view = "plus", recent = null, last = null, fold = null } = {}) {
  const seed = {};
  if (recent != null) seed.tf_hq_view = recent;
  if (last != null) seed.hq_nav_last_space = last;
  if (fold != null) seed[FOLD_KEY] = fold;
  const { doc, win } = loadChip("hq-nav-plus.js", {
    view,
    win: { localStorage: seed },
    mutate: (src) => PANEL_DOM + media(wide) + src,
  });
  const more = doc.querySelector(".hq-more-nav");
  return {
    doc,
    win,
    more,
    links: () => more.querySelectorAll("[data-view-link]"),
    chip: () => more.querySelector(".hq-more-recent"),
    fold: () => doc.getElementById("hq-sys-fold"),
  };
}

// 9. Every panel link wears the rail's own icon for that space, ahead of its name.
{
  const { links } = bootPlus();
  assert.equal(links().length, PANEL.length, "the four groups are still the panel's own links");
  for (const link of links()) {
    const view = link.dataset.viewLink;
    const icon = link.querySelector(".nav-ico");
    assert.ok(icon, view + ": the link carries the rail's icon instead of being text only");
    assert.equal(link.children[0].className, "nav-ico", view + ": the icon leads, the name follows");
    const svg = icon.querySelector(".nav-svg");
    assert.ok(svg, view + ": the copied node is the rail's svg, not a new glyph");
    assert.equal(svg.getAttribute("data-icon"), view, view + ": the icon belongs to that space");
    assert.equal(link.querySelectorAll(".nav-ico").length, 1, view + ": one icon, not a stack of them");
  }
}

// 9b. A second paint (the rail changing shape repaints the panel) must not stack a second icon on a link.
{
  const { links, win } = bootPlus();
  win.__media.matches = true;
  win.dispatchEvent({ type: "resize" });
  for (const link of links()) {
    assert.equal(link.querySelectorAll(".nav-ico").length, 1,
      link.dataset.viewLink + ": one icon, not a stack of them, after the panel repaints");
  }
}

// 10. The remembered space draws the row, names it like the rail does, and opens it on tap.
{
  const { chip, win } = bootPlus({ recent: "forge" });
  const row = chip();
  assert.ok(row, "a remembered space draws the row");
  assert.equal(row.dataset.view, "forge");
  assert.equal(row.querySelector(".hq-more-recent-tag").textContent, "Récemment ouvert");
  assert.equal(row.querySelector("strong").textContent, "Forge Studio", "the row uses the rail's name for the space");
  row.click();
  assert.equal(win.__opened, "forge", "tapping the row reopens that space");
}

// 11. It degrades silently: nothing stored, garbage, a space the panel does not list, the panel itself, a bar tab.
{
  const cases = [
    ["nothing stored", {}],
    ["a malformed value", { recent: "{'not':'json'" }],
    ["an unknown space", { recent: "bogus" }],
    ["the panel itself", { recent: "plus" }],
    ["a bar tab", { recent: "accueil" }],
  ];
  for (const [label, opts] of cases) {
    const row = bootPlus(opts).chip();
    assert.ok(!row, label + ": no row, and the panel still renders" + (row ? " (drew " + row.dataset.view + ")" : ""));
  }
  // A bar tab in tf_hq_view is the normal state (setView writes it), so the last panel space is the fallback.
  const { chip } = bootPlus({ recent: "accueil", last: "lecteur" });
  assert.ok(chip(), "a bar tab in tf_hq_view still falls back to the last panel space");
  assert.equal(chip().dataset.view, "lecteur");
}

// 12. Système is a disclosure after the four groups, folded at every width until someone opens it: the page's own
// cards are the content, the wall is a shortcut.
{
  const start = bridge.indexOf('<details class="hq-sys-fold"');
  const groups = bridge.indexOf('<nav class="hq-more-nav"');
  assert.ok(groups > 0 && start > groups, "the Système disclosure comes after the link groups");
  const sys = bridge.slice(start, bridge.indexOf("</details>", start));
  const entries = (sys.match(/data-jump="system-/g) || []).length + (sys.match(/id="system-robotics-settings"/g) || []).length;
  assert.equal(entries, 13, "twelve sections + the robotics action stay inside the disclosure");
  assert.ok(!/<nav class="hq-more-links">[\s\S]*?data-jump=/.test(bridge.slice(0, start)), "no Système chip leaked into the groups");

  assert.equal(bootPlus({ wide: false }).fold().open, false, "a phone opens the panel with the groups first");
  assert.equal(bootPlus({ wide: true }).fold().open, false, "the wide rail starts folded too, instead of pushing the page down");
}

// 12b. Once the wall is opened or closed by hand, that choice outlives a resize and a reload instead of being re-decided
// by the closed default.
{
  assert.ok(plusSource.includes('var FOLD_KEY = "hq_nav_system_fold";'), "the fold key is the one this check seeds");
  const { doc, win } = bootPlus({ wide: false });
  const fold = doc.getElementById("hq-sys-fold");
  assert.equal(fold.open, false, "the phone still starts folded");
  fold.open = true;
  fold.dispatchEvent({ type: "toggle" });
  assert.equal(win.localStorage.getItem(FOLD_KEY), "1", "opening the wall on a phone is remembered");
  fold.open = false;
  fold.dispatchEvent({ type: "toggle" });
  assert.equal(win.localStorage.getItem(FOLD_KEY), "0", "closing it is remembered too");

  assert.equal(bootPlus({ wide: false, fold: "1" }).fold().open, true, "a phone reload keeps it open");
  assert.equal(bootPlus({ wide: true, fold: "1" }).fold().open, true,
    "the wide default does not close what was opened on a phone");
  assert.equal(bootPlus({ wide: true, fold: "0" }).fold().open, false,
    "a choice to close it survives the wide rail too");
  assert.equal(bootPlus({ wide: false, fold: "0" }).fold().open, false, "and survives a phone reload");
  assert.equal(bootPlus({ wide: true, fold: "junk" }).fold().open, false, "a malformed value falls back to the closed default");
}

// 13. One view, two names, from one source: Plus on the phone, Système on the rail, never contradicting each other.
{
  const button = bridge.match(/<button[^>]*data-nav="plus"[^>]*>.*?<\/button>/);
  assert.ok(button, "the Plus entry is still in the rail markup");
  const mobile = button[0].match(/nav-label nav-label-mobile">([^<]+)</);
  const desktop = button[0].match(/nav-label nav-label-desktop">([^<]+)</);
  assert.ok(mobile && desktop, "the entry carries one label per shape through nav-label / nav-label-desktop");
  assert.equal(mobile[1], "Plus", "the phone's bar still says Plus");
  assert.equal(desktop[1], "Système", "the wide rail says Système");
  assert.equal((bridge.match(/nav-label nav-label-desktop/g) || []).length, 1, "plus is the only view with two names");

  const labels = bridge.match(/const VIEW_LABELS = \{([^}]*)\}/);
  assert.ok(labels && new RegExp("plus: '" + mobile[1] + "'").test(labels[1]), "VIEW_LABELS keeps the phone's word");
  assert.ok(bridge.includes("const VIEW_LABELS_WIDE = { plus: '" + desktop[1] + "' }"),
    "the wide name lives beside VIEW_LABELS and matches the rail");
  assert.ok(bridge.includes("if (VIEW_LABELS_WIDE[view] && window.matchMedia('(min-width: 900px)').matches)"),
    "viewTitle asks the shape before naming the view, so the heading never contradicts the rail");
  assert.ok(!/VIEW_LABELS_WIDE:\s*'Système'/.test(bridge), "plus is not renamed inside the hash whitelist");
  // Widening the window must not leave the rail on Système while the heading still says Plus.
  assert.ok(/function applyViewLabel\(\) \{\r?\n  const title = viewTitle\(document\.body\.dataset\.view \|\| 'accueil'\);/.test(bridge),
    "applyViewLabel names the open view through viewTitle, so heading and rail cannot drift apart");
  const applyLabel = bridge.match(/function applyViewLabel\(\) \{[\s\S]*?\r?\n\}/);
  assert.ok(applyLabel, "applyViewLabel is a whole function, not a call site");
  assert.ok(applyLabel[0].includes("document.getElementById('view-label')") && applyLabel[0].includes("document.title ="),
    "applyViewLabel repaints the visible heading and the document title, not just one of them");
  assert.ok(bridge.includes("const VIEW_SHAPE_QUERY = window.matchMedia('(min-width: 900px)');") &&
    bridge.includes("VIEW_SHAPE_QUERY.addEventListener('change', applyViewLabel);"),
    "the shape change re-labels the open view");
}

// 14. One title per page: the small view label steps aside when the open panel's own heading already names the view.
//     `plus` is the case where it stays — the disclosure under it is a control, not a second heading.
{
  const css = readFileSync(new URL("../assets/hq.css", import.meta.url), "utf8");
  assert.ok(plusSource.includes("function dedupeViewTitle("), "the shared nav script owns the comparison");
  assert.ok(plusSource.includes('panel.querySelectorAll("h1, h2")'), "it reads the panel's own headings");
  assert.ok(plusSource.includes("function namedHeading("), "a later heading can be the one repeating the name");
  assert.ok(plusSource.includes('classList.toggle("view-own-title"'), "the body class is what the CSS keys on");
  assert.ok(plusSource.includes("dedupeViewTitle();"), "it runs on boot and on every view change");
  assert.ok(!plusSource.includes("setTimeout(dedupeViewTitle"),
    "no timer guesses when the heading renders");
  assert.ok(plusSource.includes("headWatch.observe(panel, { childList: true, subtree: true, characterData: true })"),
    "a MutationObserver on the open panel is the post-render signal");
  assert.ok(plusSource.includes("if (headWatch && headWatch.panel === panel) return;"),
    "the watch stays armed on the open panel instead of disarming on any heading");
  assert.ok(plusSource.includes("new MutationObserver(function () { dedupeViewTitle(); })"),
    "every heading render re-decides, so a placeholder or a replaced heading is re-read");
  assert.ok(!plusSource.includes("firstHeading("),
    "no 'the first heading is enough' shortcut left in the watch");
  assert.ok(css.includes("body.view-own-title .view-bar #view-label{"), "the duplicated label is hidden, not deleted");
  assert.ok(/body\.view-own-title \.view-bar #view-label\{[^}]*clip-path:inset\(50%\)/.test(css),
    "the label stays in the DOM (h1, focus target), only its sight is removed");
  assert.ok(css.includes(".hq-sys-fold > summary{font-size:var(--text-xs)"),
    "the Système disclosure reads as a control, not as a second page heading");
  assert.ok(!/body\[data-view="[a-z0-9]+"\][^{]*\.view-label\s*\{/.test(css),
    "one rule keyed on the body class, not a per-view hiding list to maintain");
}

// 14b. The comparison tolerates a badge painted after the name, and refuses a section that adds real words.
{
  const bootTitle = ({ view, label, headings }) => {
    const prelude = `(function () {
  var l = document.createElement("h1");
  l.id = "view-label";
  l.className = "view-label";
  l.textContent = ${JSON.stringify(label)};
  document.body.appendChild(l);
  var panel = document.createElement("section");
  panel.setAttribute("data-panel", ${JSON.stringify(view)});
  ${JSON.stringify(headings)}.forEach(function (html) {
    var h = document.createElement("h2");
    h.innerHTML = html;
    panel.appendChild(h);
  });
  document.body.appendChild(panel);
})();`;
    const { doc } = loadChip("hq-nav-plus.js", { view, mutate: (src) => prelude + media(false) + src });
    return doc.body.classList.contains("view-own-title");
  };
  const cases = [
    ["the same name", "carnet", "Carnet", ["Carnet"], true],
    ["a bare counter", "fichiers", "Fichiers", ['Fichiers <span class="pill">0</span>'], true],
    ["a dot counter", "carnet", "Carnet", ["Carnet · 3"], true],
    ["a bracketed counter", "projets", "Projets", ["Projets (12)"], true],
    ["an em dash and a counter", "projets", "Projets", ["Projets — 12"], true],
    ["a counter in the second heading", "fichiers", "Fichiers",
      ["Recherche globale", 'Fichiers <span class="pill">0</span>'], true],
    ["a section that adds words", "fichiers", "Fichiers", ["Fichiers 3 nouveaux"], false],
    ["another name altogether", "fichiers", "Fichiers", ["Recherche globale"], false],
    ["plus keeps its label", "plus", "Système", ["Session"], false],
    ["no heading yet", "plus", "Système", [], false],
  ];
  for (const [why, view, label, headings, want] of cases) {
    assert.equal(bootTitle({ view, label, headings }), want,
      why + ": " + label + " / " + (headings.length ? headings.join(" then ") : "(none)"));
  }
}

console.log("check_hq_nav_rail: ok");
