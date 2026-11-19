/* Transfert HQ — the nav chrome both shapes share (assets/hq-nav-plus.js).
   - measures the real bottom bar into --nav-h instead of trusting the 64px fallback, so every floating panel
     (toasts, FABs, carnet bar, chips) sits above the bar whatever the font scale or safe area does;
   - gives the Plus panel the rail's icons, a "Récemment ouvert" row and a folded Système chip wall.
   Plain ES2020, no dependencies, never throws into the page. */
(function () {
  "use strict";

  var nav = document.querySelector(".bottom-nav");
  var root = document.documentElement;
  var wide = window.matchMedia("(min-width: 900px)");
  var RECENT_KEY = "tf_hq_view";
  var LAST_SPACE_KEY = "hq_nav_last_space";
  var VIEW_RE = /^[a-z]+$/;

  // The row can only jump to a space the panel actually lists; the five bar tabs are already one tap away.
  function panelLink(view) {
    return !!view && VIEW_RE.test(view) && !!document.querySelector('.hq-more-nav [data-view-link="' + view + '"]');
  }

  // setView stores the view it just opened, so tf_hq_view is "plus" (or a bar tab) by the time the panel is shown;
  // keep the last panel space separately or the Reprendre row would erase itself the first time it is used.
  function remember(view) {
    if (!panelLink(view)) return;
    try {
      localStorage.setItem(LAST_SPACE_KEY, view);
    } catch (_) {}
  }

  function lastSpace() {
    var stored = "", fallback = "";
    try {
      stored = localStorage.getItem(RECENT_KEY) || "";
      fallback = localStorage.getItem(LAST_SPACE_KEY) || "";
    } catch (_) {}
    // Prefer what is open now, then the last panel space, and only ever a view the panel can link to.
    var candidates = [stored, fallback];
    for (var i = 0; i < candidates.length; i += 1) {
      if (candidates[i] !== "plus" && candidates[i] !== "accueil" && panelLink(candidates[i])) return candidates[i];
    }
    return "";
  }

  // The space the nav steals from the bottom of the viewport, measured — never a constant. On the phone that is the
  // bar's own height (62px at the default font scale, more under font scaling or a safe area). At desktop the same
  // element IS the left rail: it hugs the bottom edge but spans the whole window, and it takes no room at the bottom,
  // so its contribution is 0. Publishing the rail's 100vh would fling every toast above the viewport.
  function bottomInset() {
    if (!nav) return 0;
    var box = nav.getBoundingClientRect();
    var pinsToBottom = Math.abs(box.bottom - window.innerHeight) <= 1;
    var isBar = box.height > 0 && box.height <= window.innerHeight / 2;
    return pinsToBottom && isBar ? Math.round(box.height) : 0;
  }

  function measureNav() {
    if (!nav) return;
    var height = bottomInset();
    var current = parseFloat(root.style.getPropertyValue("--nav-h"));
    if (!isFinite(current) || Math.abs(current - height) > 0.5) root.style.setProperty("--nav-h", height + "px");
  }

  function labelFor(view) {
    if (!nav) return "";
    var button = nav.querySelector('button[data-nav="' + view + '"]');
    if (!button) return "";
    var label = button.querySelector(".nav-label");
    return (label && label.textContent ? label.textContent : "").trim();
  }

  function decorateLinks(more) {
    more.querySelectorAll("[data-view-link]").forEach(function (link) {
      if (link.querySelector(".nav-ico")) return;
      var view = link.dataset.viewLink;
      if (!VIEW_RE.test(view || "")) return;
      var source = nav && nav.querySelector('button[data-nav="' + view + '"] .nav-ico');
      if (!source) return;
      var icon = source.cloneNode(true);
      icon.setAttribute("aria-hidden", "true");
      link.insertBefore(icon, link.firstChild);
    });
  }

  function paintRecent(more) {
    var view = lastSpace();
    var usable = view && more.querySelector('[data-view-link="' + view + '"]');
    var chip = more.querySelector(".hq-more-recent");
    if (!usable) {
      if (chip) chip.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement("button");
      chip.type = "button";
      chip.className = "hq-more-recent";
      chip.addEventListener("click", function () {
        var target = chip.dataset.view;
        if (target && typeof window.setView === "function") window.setView(target);
      });
      more.insertBefore(chip, more.firstChild);
    }
    if (chip.dataset.view === view && chip.childElementCount) return;
    chip.dataset.view = view;
    chip.replaceChildren();
    var tag = document.createElement("span");
    tag.className = "hq-more-recent-tag";
    tag.textContent = "Récemment ouvert";
    var name = document.createElement("strong");
    name.textContent = labelFor(view) || view;
    chip.append(tag, name);
  }

  // The Système disclosure belongs to whoever opened it: it starts folded at every width (the section under it opens
  // with its title anyway), and once it has been opened or closed by hand that choice survives a resize and a reload.
  var FOLD_KEY = "hq_nav_system_fold";

  function foldSystem() {
    var fold = document.getElementById("hq-sys-fold");
    if (!fold) return;
    if (!fold.hqFoldBound) {
      fold.hqFoldBound = true;
      fold.addEventListener("toggle", function () {
        // Setting .open from here fires toggle too; only a change the user made is worth remembering.
        if (fold.hqFoldApplied === fold.open) { fold.hqFoldApplied = null; return; }
        fold.hqFoldApplied = fold.open;
        try { localStorage.setItem(FOLD_KEY, fold.open ? "1" : "0"); } catch (_) {}
      });
    }
    var stored = null;
    try { stored = localStorage.getItem(FOLD_KEY); } catch (_) {}
    var open = stored === "1";
    if (fold.open === open) return;
    fold.hqFoldApplied = open;
    fold.open = open;
  }

  // One title per page: when one of the open panel's top headings already names the view, the small view label in the
  // view bar steps aside instead of repeating it. The label keeps its text — it is the page's h1, the shape-aware title
  // and the hash/focus target — and only `body.view-own-title` hides it from sight.
  function normTitle(text) {
    return (text || "").replace(/\s+/g, " ").trim().replace(/^[^0-9A-Za-z\u00C0-\u024F]+/, "");
  }

  // « Fichiers 0 », « Carnet · 3 », « Projets (12) »: the counter is a badge painted after the name, not a second name.
  // A heading that adds real words (« Fichiers 3 nouveaux ») is a section of its own and leaves the label in place.
  function sameViewName(labelText, headText) {
    var own = normTitle(labelText);
    var name = normTitle(headText);
    if (!own || !name) return false;
    if (name === own) return true;
    if (name.slice(0, own.length) !== own) return false;
    return /^[\s·•|:/—–()[\]-]*\d+[\s·•»()[\]+-]*$/.test(name.slice(own.length));
  }

  // The repeated name is not always the panel's first heading: Fichiers opens on « Recherche globale » and names the
  // space in the next one (« Fichiers 0 »). Scan the panel's top headings, and only the ones actually shown.
  function namedHeading(panel, labelText) {
    if (!panel) return null;
    var heads = Array.prototype.slice.call(panel.querySelectorAll("h1, h2"), 0, 4);
    for (var i = 0; i < heads.length; i += 1) {
      var head = heads[i];
      if (!normTitle(head.textContent) || !sameViewName(labelText, head.textContent)) continue;
      if (typeof head.checkVisibility === "function" &&
        !head.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
      return head;
    }
    return null;
  }

  // A lazy panel paints its heading after the switch, sometimes a placeholder first and the real name later. Stay armed
  // on the open panel instead of disarming on any heading: re-decide whenever its heading tree changes, so the moment a
  // heading actually names the view the label steps aside — and if that heading is replaced or edited away, it returns.
  var headWatch = null;

  function watchHeading(panel) {
    if (headWatch && headWatch.panel === panel) return;
    if (headWatch) { headWatch.disconnect(); headWatch = null; }
    if (!panel || typeof MutationObserver !== "function") return;
    headWatch = new MutationObserver(function () { dedupeViewTitle(); });
    headWatch.panel = panel;
    headWatch.observe(panel, { childList: true, subtree: true, characterData: true });
  }

  // The heading is in the DOM before it is painted: while the panel fades in it reads as an invisible heading and
  // the label would stay twice. The end of that paint is the second post-render signal, and a panel first judged
  // in a hidden tab is judged again when the tab is shown.
  function watchPaint(panel) {
    if (!panel || panel.hqPaintBound) return;
    panel.hqPaintBound = true;
    panel.addEventListener("animationend", dedupeViewTitle);
    panel.addEventListener("transitionend", dedupeViewTitle);
    if (!document.hqPaintBound) {
      document.hqPaintBound = true;
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) dedupeViewTitle();
      });
    }
  }

  function dedupeViewTitle() {
    var label = document.getElementById("view-label");
    var view = document.body.dataset.view;
    if (!label || !view) return;
    var panel = document.querySelector('[data-panel="' + view + '"]');
    document.body.classList.toggle("view-own-title", !!namedHeading(panel, label.textContent));
    watchHeading(panel);
    watchPaint(panel);
  }

  // On the wide shape this panel is Système, not the overflow: the twelve space links (the phone's navigation) would
  // push status below the fold there, so they move into the disclosure. The phone keeps them first, where they belong.
  var launcherPanel = null;
  var launcherFold = null;

  function placeLauncher() {
    var panel = document.querySelector('[data-panel="plus"]');
    var more = panel ? panel.querySelector(".hq-more-nav") : null;
    var fold = document.getElementById("hq-sys-fold");
    if (!panel || !more || !fold) return;
    launcherPanel = panel;
    launcherFold = fold;
    if (wide.matches) {
      if (more.parentElement !== fold) fold.appendChild(more);
    } else if (more.parentElement !== panel) {
      panel.insertBefore(more, fold);
    }
  }

  function paintPlus() {
    // The remembered choice is re-applied only when it differs, so a paint costs nothing once the fold is settled.
    foldSystem();
    var more = document.querySelector(".hq-more-nav");
    if (!more) return;
    decorateLinks(more);
    paintRecent(more);
  }

  function boot() {
    measureNav();
    if (nav && typeof ResizeObserver === "function") {
      try {
        new ResizeObserver(measureNav).observe(nav);
      } catch (_) {}
    }
    window.addEventListener("resize", measureNav);
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(measureNav).catch(function () {});
    }
    paintPlus();
    foldSystem();
    placeLauncher();
    dedupeViewTitle();
    var wasWide = wide.matches;
    function syncWide() {
      if (wide.matches === wasWide) return;
      wasWide = wide.matches;
      measureNav();
      foldSystem();
      paintPlus();
      placeLauncher();
      // The label changes with the shape (« Plus » on the phone, « Système » on the rail): re-read it.
      dedupeViewTitle();
    }
    wide.addEventListener("change", syncWide);
    // Some embedded webviews resize without firing the media-query event; the guard keeps this cheap.
    window.addEventListener("resize", syncWide);
    // The last opened space changes with every setView; refresh the row when Plus is shown again.
    remember(document.body.dataset.view);
    new MutationObserver(function () {
      var view = document.body.dataset.view;
      remember(view);
      if (view === "plus") paintPlus();
      dedupeViewTitle();
    }).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
