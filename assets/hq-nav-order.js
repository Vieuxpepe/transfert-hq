/* Desktop sidebar ordering is local to this browser; group hairlines follow the order, not the entry. */
(() => {
  const STORAGE_KEY = "hq_desktop_nav_order";
  const COMPACT_KEY = "hq_desktop_nav_compact";
  const MOBILE_FIRST = ["accueil", "carnet", "calendrier", "fichiers", "plus"];
  // Which kind of space each entry belongs to. The rail draws a hairline wherever the kind changes, so the marker is
  // recomputed from the current order instead of being glued to the two entries that happened to start a group.
  const SECTIONS = {
    quotidien: ["accueil", "intime", "carnet", "calendrier", "repas", "budget"],
    espaces: ["dessiner", "playground", "forge", "fichiers", "projets", "inventaire", "lecteur", "musique", "atelier3d"],
    systeme: ["ops", "engine", "securite", "robotique", "plus"],
  };
  const HOLD_MS = 650;
  const MOVE_TOLERANCE = 8;

  function sectionOf(key) {
    for (const name of Object.keys(SECTIONS)) if (SECTIONS[name].includes(key)) return name;
    return "";
  }

  function start() {
    const nav = document.querySelector(".bottom-nav");
    if (!nav) return;
    const desktop = window.matchMedia("(min-width: 900px)");
    const tabs = () => [...nav.querySelectorAll(":scope > button[data-nav]")];
    const defaultOrder = tabs().map(tab => tab.dataset.nav);
    const mobileOrder = [...new Set([...MOBILE_FIRST, ...defaultOrder])].filter(key => defaultOrder.includes(key));
    let saved;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (_) {}
    const order = Array.isArray(saved) ? saved.filter(key => defaultOrder.includes(key)) : [];
    let desktopOrder = [...new Set([...order, ...defaultOrder])];
    let press = null;
    let suppressClick = false;

    const marker = document.createElement("span");
    marker.className = "hq-nav-drop-marker";
    marker.hidden = true;
    marker.setAttribute("aria-hidden", "true");
    nav.append(marker);
    const announcement = document.createElement("span");
    announcement.className = "visually-hidden";
    announcement.setAttribute("role", "status");
    nav.append(announcement);

    function arrange() {
      const focused = document.activeElement;
      const nodes = new Map(tabs().map(tab => [tab.dataset.nav, tab]));
      const keys = desktop.matches ? desktopOrder : mobileOrder;
      nav.append(...keys.map(key => nodes.get(key)));
      // Grouping is a property of position, not of an entry: every row carries the section it belongs to, and the row
      // where that section changes is the one drawn with a hairline. Dragging an entry therefore leaves the group
      // boundaries on the groups instead of carrying a border into the middle of another group.
      let previous = "";
      for (const key of keys) {
        const node = nodes.get(key);
        if (!node) continue;
        const section = sectionOf(key);
        node.dataset.section = section;
        if (!!section && !!previous && section !== previous) node.dataset.groupStart = "1";
        else delete node.dataset.groupStart;
        if (section) previous = section;
      }
      if (nodes.get(focused?.dataset.nav) === focused) focused.focus({ preventScroll: true });
      nav.dispatchEvent(new Event("hq:nav-order"));
    }

    function revealMobileTab() {
      if (desktop.matches) return;
      const active = nav.querySelector("button.active[data-nav]");
      if (!active?.offsetWidth) return;
      const bounds = nav.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      const left = tab.left < bounds.left ? tab.left - bounds.left
        : tab.right > bounds.right ? tab.right - bounds.right : 0;
      if (left) nav.scrollBy({ left, behavior: "instant" });
    }

    const visible = () => tabs().filter(tab => tab.offsetWidth > 0);
    const label = tab => tab.querySelector(".nav-label-desktop, .nav-label:not(.nav-label-mobile)")?.textContent || tab.textContent.trim();

    function saveMove(tab, position) {
      const current = visible();
      if (!current.includes(tab)) return;
      const reordered = current.filter(node => node !== tab);
      reordered.splice(position, 0, tab);
      if (current.every((node, i) => node === reordered[i])) return;
      const visibleKeys = new Set(current.map(node => node.dataset.nav));
      let i = 0;
      desktopOrder = desktopOrder.map(key => visibleKeys.has(key) ? reordered[i++].dataset.nav : key);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(desktopOrder)); } catch (_) {}
      arrange();
      announcement.textContent = label(tab) + " · position " + (position + 1) + " sur " + current.length;
    }

    function preview() {
      if (!press?.dragging) return;
      const { tab, y, startY, startScroll } = press;
      const others = visible().filter(node => node !== tab);
      const next = others.findIndex(node => {
        const box = node.getBoundingClientRect();
        return y < box.top + box.height / 2;
      });
      press.position = next < 0 ? others.length : next;
      const anchor = others[press.position] || others.at(-1);
      if (!anchor) return;
      const edge = anchor.offsetTop + (next < 0 ? anchor.offsetHeight : 0);
      marker.style.top = (edge + (next < 0 ? 3 : -3)) + "px";
      marker.hidden = false;
      tab.style.setProperty("--hq-nav-drag-y", (y - startY + nav.scrollTop - startScroll) + "px");
    }

    function finish(commit = false) {
      if (!press) return;
      const { tab, timer, dragScroll, dragging, position } = press;
      press = null;
      clearTimeout(timer);
      clearInterval(dragScroll);
      marker.hidden = true;
      tab.classList.remove("is-nav-dragging");
      tab.style.removeProperty("--hq-nav-drag-y");
      if (commit && dragging) saveMove(tab, position);
    }

    function arm() {
      if (!press || press.dragging) return;
      const { tab, pointerId } = press;
      if (!tab.offsetWidth) { finish(); return; }
      press.dragging = true;
      suppressClick = true;
      // Capture keeps the gesture alive once the pointer leaves the row. A synthetic pointer has nothing to capture, and
      // losing the whole drag over that would be worse than losing capture.
      try { tab.setPointerCapture(pointerId); } catch (_) {}
      tab.classList.add("is-nav-dragging");
      preview();
      press.dragScroll = setInterval(() => {
        if (!press?.dragging) return;
        const bounds = nav.getBoundingClientRect();
        const delta = press.y < bounds.top + 28 ? -10 : press.y > bounds.bottom - 28 ? 10 : 0;
        if (delta) nav.scrollTop += delta;
      }, 30);
    }

    nav.addEventListener("pointerdown", event => {
      const tab = event.target.closest("button[data-nav]");
      if (!event.isPrimary || event.button !== 0 || !tab) return;
      suppressClick = false;
      if (!desktop.matches || press) return;
      const { pointerId, clientX: x, clientY: y } = event;
      // Touch needs the hold: without it a swipe that starts on a row would drag the rail instead of scrolling the page.
      // A mouse has no such ambiguity, so it drags as soon as the pointer really moves — no unexplained pause first.
      press = { tab, pointerId, x, y, startY: y, startScroll: nav.scrollTop, hold: event.pointerType === "touch" };
      if (press.hold) press.timer = setTimeout(arm, HOLD_MS);
    });
    window.addEventListener("pointermove", event => {
      if (press?.pointerId !== event.pointerId) return;
      press.y = event.clientY;
      if (press.dragging) preview();
      else if (Math.hypot(event.clientX - press.x, press.y - press.startY) > MOVE_TOLERANCE) {
        if (press.hold) finish();
        else arm();
      }
    });
    window.addEventListener("pointerup", event => {
      if (press?.pointerId !== event.pointerId) return;
      const bounds = nav.getBoundingClientRect();
      press.y = event.clientY;
      preview();
      finish(event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom);
    });
    for (const type of ["pointercancel", "lostpointercapture"]) {
      nav.addEventListener(type, event => { if (press?.pointerId === event.pointerId) finish(); });
    }
    window.addEventListener("blur", () => finish());
    nav.addEventListener("scroll", preview, { passive: true });
    // In the rail every press on a row is the start of the reorder gesture, so the context menu never opens there —
    // whether or not a press is in flight (iPadOS raises the same menu on a long press). The phone's bar is untouched.
    nav.addEventListener("contextmenu", event => {
      if (press || (desktop.matches && event.target.closest?.("button"))) event.preventDefault();
    });
    nav.addEventListener("click", event => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    nav.addEventListener("keydown", event => {
      if (event.key === "Escape" && press) { finish(); event.preventDefault(); return; }
      const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (!desktop.matches || !event.altKey || !step) return;
      const list = visible();
      const position = list.indexOf(event.target);
      if (position < 0) return;
      event.preventDefault();
      saveMove(event.target, Math.max(0, Math.min(list.length - 1, position + step)));
    });

    // Collapse: icons only, remembered per browser like the order above. The rail keeps a 44px row either way.
    const toggle = nav.querySelector("button.hq-nav-collapse");
    let compact = false;
    try { compact = localStorage.getItem(COMPACT_KEY) === "1"; } catch (_) {}
    // The scrollbar's own width, measured rather than assumed: 11px on a classic desktop bar, 0 where the bar overlays
    // the content. The compact rail pays that width back as left padding, so a hard-coded 11px would push its icon
    // column ~5px right of centre on an overlay-bar platform.
    function paintGutter() {
      const border = parseFloat(getComputedStyle(nav).borderRightWidth);
      const gutter = Math.max(0, (Number(nav.offsetWidth) || 0) - (Number(nav.clientWidth) || 0)
        - (Number.isFinite(border) ? border : 0));
      if (nav.style && typeof nav.style.setProperty === "function") nav.style.setProperty("--nav-gutter", gutter + "px");
    }
    function paintToggle() {
      const on = compact && desktop.matches;
      document.body.classList.toggle("nav-rail-compact", on);
      // Before the highlight re-places: its offsetLeft is measured from the padding edge, which this writes.
      paintGutter();
      if (!toggle) return;
      // A disclosure, not a toggle button: the repo already announces its folds this way, and "expanded" is what the
      // rail is doing when the labels are showing.
      toggle.setAttribute("aria-expanded", on ? "false" : "true");
      toggle.setAttribute("aria-label", on ? "Déployer le menu" : "Réduire le menu");
      const text = toggle.querySelector(".nav-label");
      if (text) text.textContent = on ? "Déployer" : "Réduire";
      // The gliding highlight measures the active row, so re-place it once the rail has its new width.
      // Dispatched synchronously: the listener reads getBoundingClientRect, which forces the new layout. A
      // rAF waited for a frame this code may never get (a paused/occluded window), and the ink then kept its
      // 144px expanded width inside the 56px rail — an 11px horizontal scrollbar eating 11px of rail height.
      nav.dispatchEvent(new Event("hq:nav-order"));
    }
    if (toggle) {
      toggle.addEventListener("click", () => {
        compact = !compact;
        try { localStorage.setItem(COMPACT_KEY, compact ? "1" : "0"); } catch (_) {}
        paintToggle();
      });
    }

    function applyLayout() {
      finish();
      paintToggle();
      for (const tab of tabs()) {
        if (desktop.matches) {
          tab.title = "Glisser pour déplacer";
          tab.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
        } else {
          tab.removeAttribute("title");
          tab.removeAttribute("aria-keyshortcuts");
        }
      }
      arrange();
      revealMobileTab();
    }

    new MutationObserver(revealMobileTab).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
    let wasDesktop = desktop.matches;
    function syncShape() {
      if (desktop.matches === wasDesktop) return;
      wasDesktop = desktop.matches;
      applyLayout();
    }
    desktop.addEventListener("change", syncShape);
    // Some embedded webviews resize without firing the media-query event; the guard keeps this cheap.
    window.addEventListener("resize", syncShape);
    // Zoom or a platform change can alter the scrollbar's width without changing the shape; re-measure it.
    window.addEventListener("resize", paintGutter, { passive: true });
    applyLayout();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
