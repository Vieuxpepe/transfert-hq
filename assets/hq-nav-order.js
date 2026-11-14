/* Desktop sidebar ordering is local to this browser. */
(() => {
  const STORAGE_KEY = "hq_desktop_nav_order";
  const MOBILE_FIRST = ["accueil", "carnet", "calendrier", "fichiers", "plus"];
  const HOLD_MS = 650;
  const MOVE_TOLERANCE = 8;

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

    nav.addEventListener("pointerdown", event => {
      const tab = event.target.closest("button[data-nav]");
      if (!event.isPrimary || event.button !== 0 || !tab) return;
      suppressClick = false;
      if (!desktop.matches || press) return;
      const { pointerId, clientX: x, clientY: y } = event;
      press = { tab, pointerId, x, y, startY: y, startScroll: nav.scrollTop };
      press.timer = setTimeout(() => {
        if (!press || !tab.offsetWidth) { finish(); return; }
        press.dragging = true;
        suppressClick = true;
        tab.setPointerCapture(pointerId);
        tab.classList.add("is-nav-dragging");
        preview();
        press.dragScroll = setInterval(() => {
          const bounds = nav.getBoundingClientRect();
          const delta = press.y < bounds.top + 28 ? -10 : press.y > bounds.bottom - 28 ? 10 : 0;
          if (delta) nav.scrollTop += delta;
        }, 30);
      }, HOLD_MS);
    });
    window.addEventListener("pointermove", event => {
      if (press?.pointerId !== event.pointerId) return;
      press.y = event.clientY;
      if (press.dragging) preview();
      else if (Math.hypot(event.clientX - press.x, press.y - press.startY) > MOVE_TOLERANCE) finish();
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
    nav.addEventListener("contextmenu", event => { if (press) event.preventDefault(); });
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

    function applyLayout() {
      finish();
      for (const tab of tabs()) {
        if (desktop.matches) {
          tab.title = "Maintenir pour déplacer";
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
    desktop.addEventListener("change", applyLayout);
    applyLayout();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
