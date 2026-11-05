/* Transfert HQ v7 Mission Control UI. Uses globals from the inline app: api, toast, escapeHtml, navigate, setView. */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const STATE_LABEL = { ok: "OK", warning: "Attention", critical: "Critique" };

  function trapFocus(root) {
    if (!root) return function () {};
    function visible(el) {
      if (!el || el.disabled || el.getAttribute("aria-hidden") === "true") return false;
      if (el.closest("[hidden]")) return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    }
    function onKey(ev) {
      if (ev.key !== "Tab") return;
      const nodes = Array.prototype.filter.call(
        root.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
        visible
      );
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const onEdgeBack = document.activeElement === first || document.activeElement === root;
      const onEdgeForward = document.activeElement === last || document.activeElement === root;
      if (ev.shiftKey && onEdgeBack) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && onEdgeForward) {
        ev.preventDefault();
        first.focus();
      }
    }
    root.addEventListener("keydown", onKey);
    return function () { root.removeEventListener("keydown", onKey); };
  }
  window.hqTrapFocus = trapFocus;

  function esc(s) {
    if (typeof escapeHtml === "function") return escapeHtml(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function sparkline(values) {
    const nums = (values || []).map(Number).filter((n) => Number.isFinite(n));
    if (nums.length < 2) return "";
    const w = 140;
    const h = 32;
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const span = max - min || 1;
    const pts = nums
      .map((v, i) => {
        const x = (i / (nums.length - 1)) * w;
        const y = h - ((v - min) / span) * (h - 2) - 1;
        return x.toFixed(1) + "," + y.toFixed(1);
      })
      .join(" ");
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="1.6" points="${pts}"/></svg>`;
  }

  const ATTENTION_KEY = "hq_home_attention_open";
  const TODAY_KEY = "hq_home_today_open";
  let hqStateSeen = null;

  function readOpenPref(key) {
    try {
      const value = localStorage.getItem(key);
      if (value === "1") return true;
      if (value === "0") return false;
    } catch (_) {}
    return null;
  }

  function writeOpenPref(key, open) {
    try {
      localStorage.setItem(key, open ? "1" : "0");
    } catch (_) {}
  }

  function setDisclosure(button, open) {
    if (!button) return;
    const panelId = button.getAttribute("aria-controls") || "";
    const panel = panelId ? document.getElementById(panelId) : null;
    const wasOpen = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.classList.toggle("is-open", !!open);
    if (panel) panel.hidden = !open;
    if (wasOpen && !open && window.hqHideHelp) window.hqHideHelp();
  }

  function setupHomeDisclosures() {
    const attention = $("#hq-attention-toggle");
    const today = $("#hq-today-toggle");
    const attentionPref = readOpenPref(ATTENTION_KEY);
    const todayPref = readOpenPref(TODAY_KEY);
    setDisclosure(attention, attentionPref === null ? false : attentionPref);
    setDisclosure(today, todayPref === null ? true : todayPref); // Today is open unless the owner closed it
    if (attention) {
      attention.addEventListener("click", () => {
        const open = attention.getAttribute("aria-expanded") !== "true";
        setDisclosure(attention, open);
        writeOpenPref(ATTENTION_KEY, open);
      });
    }
    if (today) {
      today.addEventListener("click", () => {
        const open = today.getAttribute("aria-expanded") !== "true";
        setDisclosure(today, open);
        writeOpenPref(TODAY_KEY, open);
      });
    }
  }

  function attentionMeta(state, items) {
    const list = Array.isArray(items) ? items : [];
    const n = list.length;
    if (!n) {
      if (state === "critical") return "Action requise";
      if (state === "warning") return "À vérifier";
      return "Tout est calme.";
    }
    if (state !== "critical") return n > 1 ? n + " à vérifier" : "1 à vérifier";
    const critical = list.filter((item) => item && item.level === "critical").length;
    const others = n - critical;
    if (!critical) return others > 1 ? others + " à vérifier" : "1 à vérifier";
    const head = critical > 1 ? critical + " critiques" : "1 critique";
    if (!others) return head;
    return head + " · " + (others > 1 ? others + " autres" : "1 autre");
  }

  function noteHqState(state) {
    const enteringCritical = state === "critical" && hqStateSeen !== "critical";
    hqStateSeen = state;
    if (enteringCritical) setDisclosure($("#hq-attention-toggle"), true);
  }

  async function loadSnapshot() {
    const banner = $("#hq-banner");
    if (!banner || typeof api !== "function") return;
    try {
      const snap = await api("/api/hq", { timeoutMs: 8000 });
      const state = snap.state || "ok";
      banner.classList.remove("state-ok", "state-warning", "state-critical");
      banner.classList.add("state-" + state);
      const label = $("#hq-state-label");
      if (label) label.textContent = "HQ · " + (STATE_LABEL[state] || state);
      const sub = $("#hq-state-sub");
      if (sub) sub.textContent = attentionMeta(state, snap.attention);
      const attentionPanel = $("#hq-attention-panel");
      const described = document.querySelector("[aria-describedby~='hq-help-tooltip']");
      if (described && attentionPanel && attentionPanel.contains(described) && window.hqHideHelp) window.hqHideHelp();
      const list = $("#hq-attention");
      if (list) {
        const items = snap.attention || [];
        list.innerHTML = items.length
          ? items
              .map(
                (a) =>
                  `<li><strong>${esc(a.title || "")}</strong><div class="meta">${esc(a.detail || "")}</div></li>`
              )
              .join("")
          : "";
      }
      const quick = $("#hq-quick-scenes");
      if (quick) {
        quick.innerHTML = (snap.scenes || [])
          .slice(0, 6)
          .map(
            (s) =>
              `<button type="button" class="secondary" data-quick-scene="${esc(s.id)}">${esc(s.label || s.id)}</button>`
          )
          .join("");
        quick.querySelectorAll("[data-quick-scene]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            if (!confirm("Lancer la scène « " + btn.textContent + " » ?")) return;
            try {
              const busy = typeof withBusy === "function" ? withBusy : async (_label, fn) => fn();
              await busy("Lancement…", () => api("/api/scene", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: btn.dataset.quickScene }),
              }));
              if (typeof toast === "function") toast("Scène lancée");
              if (typeof window.hqPolishFlashChip === "function") window.hqPolishFlashChip();
            } catch (e) {
              if (typeof toast === "function") toast(e.message, "err");
            }
          });
        });
      }
      if (window.hqPaintCalendarSummary) window.hqPaintCalendarSummary(snap.calendar || {});
      if (window.hqPaintAgentBadge) window.hqPaintAgentBadge(snap.agent || {});
      noteHqState(state);
      if (document.body.classList.contains("wall")) drawFleet(snap);
    } catch (_) {}
  }

  let eventKind = "all";
  async function loadEvents() {
    const el = $("#hq-events");
    if (!el || typeof api !== "function") return;
    try {
      const qs = new URLSearchParams({ limit: "30" });
      if (eventKind && eventKind !== "all") qs.set("kind", eventKind);
      const data = await api("/api/events?" + qs.toString(), { timeoutMs: 8000 });
      const items = data.events || [];
      el.innerHTML = items.length
        ? items
            .map(
              (e) =>
                `<li><strong>${esc(e.message || "")}</strong><div class="meta">${esc(e.at_h || "")} · ${esc(e.kind || "")} · ${esc(e.level || "")}</div></li>`
            )
            .join("")
        : '<li class="hint">Aucune entrée pour ce filtre.</li>';
    } catch (e) {
      el.innerHTML = `<li class="hint">${esc(e.message || "Journal indisponible")}</li>`;
    }
  }

  function drawFleet(snap) {
    const host = $("#fleet-map");
    const stateEl = $("#fleet-state");
    if (stateEl) stateEl.textContent = "État flotte · " + (STATE_LABEL[snap.state] || snap.state || "OK");
    if (!host) return;
    const devices = snap.devices || [];
    const w = 640;
    const h = 280;
    const cx = w / 2;
    const cy = h / 2;
    const parts = [
      `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Carte de la flotte">`,
      `<rect width="${w}" height="${h}" fill="transparent"/>`,
    ];
    devices.forEach((d, i) => {
      const angle = devices.length <= 1 ? -Math.PI / 2 : (-Math.PI / 2) + (i * 2 * Math.PI) / devices.length;
      const ring = d.source === "host" || d.id === "pc-host" ? 0 : 96;
      const x = cx + Math.cos(angle) * ring;
      const y = cy + Math.sin(angle) * ring * 0.72;
      const color = d.online === false ? "#e85d4c" : "#3dbe7a";
      parts.push(`<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#2a3544" stroke-width="1"/>`);
      parts.push(
        `<g class="fleet-node"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="16" fill="${color}" opacity="0.9"/>` +
          `<text x="${x.toFixed(1)}" y="${(y + 32).toFixed(1)}" text-anchor="middle" fill="currentColor" font-size="12">${esc(d.name || d.id || "?")}</text></g>`
      );
    });
    parts.push("</svg>");
    host.innerHTML = parts.join("");
  }

  async function openDevice(id) {
    if (!id || typeof api !== "function") return false;
    const dlg = $("#hq-device-dialog");
    const body = $("#hq-device-body");
    const title = $("#hq-device-title");
    if (!dlg || !body) return false;
    let data;
    try {
      data = await api("/api/device?id=" + encodeURIComponent(id));
    } catch (e) {
      if (typeof toast === "function") toast(e.message, "err");
      return false;
    }
    const device = data.device || {};
    const gates = data.gates || {};
    if (title) title.textContent = device.name || id;
    const caps = device.capabilities || [];
    const capHtml = ["screenshot", "lock", "sleep", "shell", "terminal", "ssh_target", "voice", "upload", "disks"]
      .map((name) => `<span class="cap ${caps.includes(name) ? "" : "off"}">${esc(name)}</span>`)
      .join("");
    let actions = "";
    if (gates.lock) actions += `<button type="button" class="secondary" data-dev-act="lock">Verrouiller</button>`;
    if (gates.sleep) actions += `<button type="button" class="secondary" data-dev-act="sleep">Veille</button>`;
    if (gates.screenshot) actions += `<button type="button" class="secondary" data-dev-act="shot">Capture</button>`;
    let series = "";
    try {
      const tel = await api("/api/telemetry?device=" + encodeURIComponent(device.id || id) + "&limit=80");
      series = sparkline((tel.samples || []).map((s) => s.pct_used).filter((v) => v != null));
    } catch (_) {}
    body.innerHTML =
      `<p class="hint">${esc(device.path || "")} · ${device.online === false ? "hors ligne" : "en ligne"}</p>` +
      `<div class="cap-row">${capHtml}</div>` +
      series +
      `<div class="row hq-actions" style="margin-top:8px">${actions}</div>`;
    const agentHost = document.createElement("div");
    agentHost.id = "hq-device-agent";
    body.appendChild(agentHost);
    if (typeof window.hqPaintDeviceAgent === "function") window.hqPaintDeviceAgent(agentHost, device);
    body.querySelectorAll("[data-dev-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const act = btn.dataset.devAct;
        try {
          const busy = typeof withBusy === "function" ? withBusy : async (_label, fn) => fn();
          if (act === "lock") {
            if (!confirm("Verrouiller le PC ?")) return;
            await busy("Verrouillage…", () => api("/api/pc/lock", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
          } else if (act === "sleep") {
            if (!confirm("Mettre le PC en veille ?")) return;
            await busy("Mise en veille…", () => api("/api/pc/sleep", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
          } else if (act === "shot") {
            await busy("Capture…", () => api("/api/pc/screenshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
          }
          if (typeof toast === "function") toast("OK");
        } catch (e) {
          if (typeof toast === "function") toast(e.message, "err");
        }
      });
    });
    if (window.hqHideHelp) window.hqHideHelp();
    const opener = document.activeElement;
    const wasOpen = !!dlg.open;
    if (typeof dlg.showModal === "function" && !wasOpen) dlg.showModal();
    if (dlg._hqRelease) dlg._hqRelease();
    dlg._hqRelease = trapFocus(dlg);
    const closeBtn = dlg.querySelector('button[value="cancel"]');
    if (closeBtn) closeBtn.focus();
    if (!wasOpen) {
      dlg.addEventListener("close", () => {
        if (dlg._hqRelease) dlg._hqRelease();
        dlg._hqRelease = null;
        if (opener && opener.focus && document.contains(opener)) opener.focus();
      }, { once: true });
    }
    return true;
  }

  const PALETTE_RECENTS_KEY = "hq_palette_recents";
  let paletteHits = [];
  let paletteGroups = [];
  let paletteQuery = "";
  let paletteIndex = 0;
  let paletteSeq = 0; // content search is slower than the catalog: only the newest answer is drawn
  let paletteOpener = null;
  let paletteRelease = null;

  function readRecents() {
    let raw = [];
    try {
      raw = JSON.parse(localStorage.getItem(PALETTE_RECENTS_KEY) || "[]");
    } catch (_) {
      raw = [];
    }
    return typeof hqSanitizeRecents === "function" ? hqSanitizeRecents(raw, 6) : [];
  }

  function writeRecents(items) {
    const clean = typeof hqSanitizeRecents === "function" ? hqSanitizeRecents(items, 6) : [];
    try {
      localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(clean));
    } catch (_) {}
  }

  function rememberRecent(hit) {
    const entry = typeof hqPaletteRecentEntry === "function" ? hqPaletteRecentEntry(hit) : null;
    if (!entry) return;
    const rest = readRecents().filter((item) => !(item.kind === entry.kind && item.id === entry.id));
    writeRecents([entry].concat(rest));
  }

  function forgetRecent(hit) {
    if (!hit) return;
    writeRecents(readRecents().filter((item) => !(item.kind === hit.kind && item.id === hit.id)));
  }

  function favoritePaletteHits() {
    let names = [];
    if (typeof window.hqFavoriteFolders === "function") names = window.hqFavoriteFolders() || [];
    const seen = new Set();
    const hits = [];
    names.forEach((name) => {
      const id = String(name || "");
      if (!id || seen.has(id)) return;
      seen.add(id);
      hits.push({ kind: "favorite", id: id, label: id, hint: "Favori" });
    });
    return hits.slice(0, 6);
  }

  function paletteMark(kind) {
    const paths = {
      folder: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
      favorite: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="m12 4.2 1.7 3.5 3.9.6-2.8 2.7.7 3.8L12 13.1 8.5 15l.7-3.8-2.8-2.7 3.9-.6z"/>',
      device: '<rect x="8" y="3" width="8" height="18" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M11 18.5h2"/>',
      scene: '<path fill="currentColor" d="M8 6.2v11.6L17.2 12z"/>',
      action: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M13 3.5 6.2 13H11l-.8 7.5L17.8 11H13z"/>',
      terminal: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M5 7l5 5-5 5M12 17h7"/>',
      page: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20zM14 3.5V8h4M9.5 12h5M9.5 15.5h5"/>',
      prompt: '<rect x="4" y="5" width="16" height="14" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="m4.5 16 4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5"/>',
      event: '<rect x="4" y="5.5" width="16" height="14" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
      file: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20zM14 3.5V8h4"/>',
    };
    return `<svg class="palette-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[kind] || paths.folder}</svg>`;
  }

  function paletteOption(hit, index) {
    const on = index === paletteIndex;
    return `<li id="hq-palette-opt-${index}" role="option" data-i="${index}" aria-selected="${on ? "true" : "false"}" class="${on ? "active" : ""}">${paletteMark(hit.kind)}<span class="palette-copy"><span class="palette-label">${esc(hit.label || hit.id)}</span><span class="palette-kind">${esc(hit.hint || hit.kind || "")}</span></span></li>`;
  }

  function renderPalette() {
    const list = $("#hq-palette-list");
    if (!list) return;
    const input = $("#hq-palette-input");
    if (!paletteHits.length) {
      list.removeAttribute("role");
      list.innerHTML = paletteQuery
        ? `<p class="palette-empty">Aucun résultat pour « ${esc(paletteQuery)} »</p>`
        : `<p class="palette-empty">Tape un dossier, une scène, une action, ou un mot d'une note, d'un prompt, d'un événement ou d'un fichier.</p>`;
      if (input) input.removeAttribute("aria-activedescendant");
      return;
    }
    list.setAttribute("role", "listbox");
    const many = paletteGroups.length > 1;
    list.innerHTML = paletteGroups
      .map((group) => {
        const items = group.items.map((row) => paletteOption(row.hit, row.index)).join("");
        return `<div class="palette-group${many ? "" : " is-solo"}" role="group" aria-label="${esc(group.label)}"><p class="palette-group-label">${esc(group.label)}</p><ul>${items}</ul></div>`;
      })
      .join("");
    if (window.HqChrome && typeof window.HqChrome.paletteRendered === "function") window.HqChrome.paletteRendered();
    const active = list.querySelector("li.active");
    if (input) {
      input.setAttribute("aria-controls", "hq-palette-list");
      if (active) input.setAttribute("aria-activedescendant", active.id);
      else input.removeAttribute("aria-activedescendant");
    }
    if (active && active.scrollIntoView) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      active.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }
    list.querySelectorAll("li[data-i]").forEach((li) => {
      li.addEventListener("click", () => {
        runPalette(paletteHits[Number(li.dataset.i)]).catch((err) => {
          if (typeof toast === "function") toast(err.message, "err");
        });
      });
    });
  }

  function showPaletteHome() {
    const recents = readRecents();
    const taken = new Set(recents.map((item) => item.kind + "\0" + item.id));
    const favorites = favoritePaletteHits().filter((item) => !taken.has("favorite\0" + item.id) && !taken.has("folder\0" + item.id));
    const hits = recents.concat(favorites);
    const groups = [];
    if (recents.length) groups.push({ label: "Récents", items: recents.map((hit, index) => ({ hit: hit, index: index })) });
    if (favorites.length) {
      groups.push({
        label: "Favoris",
        items: favorites.map((hit, index) => ({ hit: hit, index: recents.length + index })),
      });
    }
    paletteHits = hits;
    paletteGroups = groups;
    paletteQuery = "";
    paletteIndex = 0;
    renderPalette();
  }

  async function queryPalette(q) {
    const query = String(q || "").trim();
    if (!query) {
      showPaletteHome();
      return;
    }
    if (typeof api !== "function") return;
    const seq = ++paletteSeq;
    const data = await api("/api/palette?q=" + encodeURIComponent(query) + "&limit=20");
    if (seq !== paletteSeq) return;
    const hits = data.hits || [];
    paletteHits = hits;
    paletteGroups = typeof hqGroupPaletteHits === "function"
      ? hqGroupPaletteHits(hits)
      : [{ label: "Résultats", items: hits.map((hit, index) => ({ hit: hit, index: index })) }];
    paletteQuery = query;
    paletteIndex = 0;
    renderPalette();
  }

  async function dispatchPalette(hit) {
    if (hit.kind === "page") {
      if (typeof window.hqCarnetOpen !== "function" && typeof window.hqCarnetLoad === "function") await window.hqCarnetLoad().catch(() => {});
      if (typeof window.hqCarnetOpen !== "function") return "fail";
      await window.hqCarnetOpen(hit.id);
      return "ok";
    }
    if (hit.kind === "prompt") {
      if (typeof setView === "function") setView("forge");
      if (typeof window.hqForgeLoad === "function") await window.hqForgeLoad().catch(() => {});
      const hooks = window.hqForgeHooks;
      if (!hooks || typeof hooks.openImage !== "function") return "fail";
      await hooks.openImage(hit.id);
      return "ok";
    }
    if (hit.kind === "event") {
      if (typeof setView === "function") setView("calendrier");
      if (typeof window.hqCalendarOpenDay === "function") window.hqCalendarOpenDay(hit.at || "");
      return "ok";
    }
    if (hit.kind === "file") {
      if (typeof navigate === "function") await navigate(hit.dir || "Inbox");
      else if (typeof setView === "function") setView("fichiers");
      return "ok";
    }
    if (hit.kind === "folder" || hit.kind === "favorite") {
      if (typeof navigate === "function") await navigate(hit.id);
      else if (typeof setView === "function") setView("fichiers");
      return "ok";
    }
    if (hit.kind === "device") return (await openDevice(hit.id)) ? "ok" : "fail";
    if (hit.kind === "scene") {
      if (!confirm("Lancer la scène « " + (hit.label || hit.id) + " » ?")) return "skip";
      const busy = typeof withBusy === "function" ? withBusy : async (_label, fn) => fn();
      await busy("Lancement…", () => api("/api/scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hit.id }),
      }));
      if (typeof toast === "function") toast("Scène lancée");
      if (typeof window.hqPolishFlashChip === "function") window.hqPolishFlashChip();
      return "ok";
    }
    if (hit.kind === "action") {
      if (!confirm("Lancer « " + (hit.label || hit.id) + " » sur le PC ?")) return "skip";
      const busy = typeof withBusy === "function" ? withBusy : async (_label, fn) => fn();
      await busy("Action…", () => api("/api/pc/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hit.id }),
      }));
      if (typeof toast === "function") toast("Action lancée");
      return "ok";
    }
    if (hit.kind === "terminal") {
      if (!confirm("Exécuter la commande allowlist « " + (hit.label || hit.id) + " » ?")) return "skip";
      const busy = typeof withBusy === "function" ? withBusy : async (_label, fn) => fn();
      const data = await busy("Exécution…", () => api("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hit.id }),
      }));
      const out = $("#shell-out");
      if (out) out.textContent = (data.stdout || "") + (data.stderr || "");
      if (typeof setView === "function") setView("ops");
      if (typeof toast === "function") toast(data.ok ? "Commande terminée" : "Commande en erreur");
      return "ok";
    }
    return "fail";
  }

  async function runPalette(hit) {
    if (!hit) return;
    closePalette();
    let outcome = "skip";
    try {
      outcome = await dispatchPalette(hit);
    } catch (err) {
      forgetRecent(hit);
      throw err;
    }
    if (outcome === "ok") rememberRecent(hit);
    else if (outcome === "fail") forgetRecent(hit);
  }

  function openPalette() {
    const box = $("#hq-palette");
    if (!box) return;
    if (window.hqHideHelp) window.hqHideHelp();
    if (box.hidden) paletteOpener = document.activeElement;
    if (paletteRelease) paletteRelease();
    box.hidden = false;
    const card = box.querySelector(".palette-card") || box;
    paletteRelease = window.hqTrapFocus ? window.hqTrapFocus(card) : null;
    const input = $("#hq-palette-input");
    if (input) {
      input.value = "";
      input.focus();
    }
    queryPalette("").catch(() => {});
    if (window.HqChrome && typeof window.HqChrome.paletteOpened === "function") window.HqChrome.paletteOpened();
  }

  function closePalette() {
    const box = $("#hq-palette");
    if (paletteRelease) paletteRelease();
    paletteRelease = null;
    if (box) box.hidden = true;
    const opener = paletteOpener;
    paletteOpener = null;
    if (opener && opener.focus && document.contains(opener)) opener.focus();
  }

  function typingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  async function loadBrief() {
    const el = $("#hq-brief");
    if (!el || typeof api !== "function") return;
    try {
      const brief = await api("/api/brief");
      el.innerHTML = `<p><strong>${esc(brief.title || "Brief")}</strong></p>` +
        (brief.lines || []).map((line) => `<p>${esc(line)}</p>`).join("");
    } catch (_) {}
  }

  async function loadBackups() {
    const el = $("#hq-backups");
    if (!el || typeof api !== "function") return;
    try {
      const data = await api("/api/backups");
      const items = data.backups || [];
      el.innerHTML = items.length
        ? items
            .map(
              (b) =>
                `<li><strong>${esc(b.id || "")}</strong><div class="meta">${esc(String(b.folders || ""))} dossier(s)</div>` +
                `<div class="row hq-actions">` +
                ["Inbox", "Uni", "Print"]
                  .map(
                    (folder) =>
                      `<button type="button" class="danger" data-restore="${esc(b.id)}" data-folder="${folder}">Restaurer ${folder}</button>`
                  )
                  .join("") +
                `</div></li>`
            )
            .join("")
        : '<li class="hint">Aucune sauvegarde pour l\'instant.</li>';
      el.querySelectorAll("[data-restore]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const folder = btn.dataset.folder;
          if (!confirm("Écraser " + folder + " avec le backup " + btn.dataset.restore + " ?")) return;
          try {
            const busy = typeof withBusy === "function" ? withBusy : async (_label, fn) => fn();
            const res = await busy("Restauration…", () => api("/api/backup/restore", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: btn.dataset.restore, folder, confirm: true }),
            }));
            if (typeof toast === "function") toast((res.copied || 0) + " fichier(s) restauré(s)");
          } catch (e) {
            if (typeof toast === "function") toast(e.message, "err");
          }
        });
      });
    } catch (_) {}
  }

  async function loadRules() {
    const el = $("#hq-rules");
    if (!el || typeof api !== "function") return;
    try {
      const data = await api("/api/automation");
      const rules = data.rules || [];
      el.innerHTML = rules.length
        ? rules
            .map(
              (r) =>
                `<li><strong>${esc(r.label || r.id)}</strong><div class="meta">${esc((r.trigger && r.trigger.type) || "")} · ${r.enabled ? "actif" : "off"}</div>` +
                `<div class="row hq-actions"><button type="button" class="secondary" data-rule-run="${esc(r.id)}">Lancer</button></div></li>`
            )
            .join("")
        : '<li class="hint">Aucune règle pour l\'instant.</li>';
      el.querySelectorAll("[data-rule-run]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await api("/api/automation", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "run", id: btn.dataset.ruleRun }),
            });
            if (typeof toast === "function") toast("Règle lancée");
          } catch (e) {
            if (typeof toast === "function") toast(e.message, "err");
          }
        });
      });
    } catch (_) {}
  }

  function setupRuleForm() {
    const form = $("#hq-rule-form");
    if (!form) return;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const trigger = $("#rule-trigger").value;
      const action = $("#rule-action").value;
      const target = ($("#rule-target").value || "").trim();
      const rule = {
        label: $("#rule-label").value.trim(),
        trigger: { type: trigger, kind: trigger === "event" ? "alert" : "" },
        actions: [],
        cooldown_sec: 300,
      };
      if (action === "scene") rule.actions.push({ type: "scene", id: target });
      else if (action === "terminal") rule.actions.push({ type: "terminal", id: target });
      else if (action === "notify") rule.actions.push({ type: "notify", title: rule.label, body: rule.label });
      else if (action === "journal") rule.actions.push({ type: "journal", message: rule.label });
      else rule.actions.push({ type: action });
      try {
        await api("/api/automation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "save", rule }),
        });
        if (typeof toast === "function") toast("Règle enregistrée");
        loadRules();
      } catch (e) {
        if (typeof toast === "function") toast(e.message, "err");
      }
    });
  }

  function setupScheduleForm() {
    const form = $("#hq-schedule-form");
    if (!form) return;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const when = $("#sched-when").value;
      const typ = $("#sched-type").value;
      const body = {
        label: ($("#sched-label").value || "Tâche").trim(),
        when,
        type: typ,
        at: ($("#sched-at").value || "").trim(),
        weekday: Number($("#sched-weekday").value || 0),
        device_id: ($("#sched-device").value || "").trim(),
      };
      if (typ === "scene") body.scene_id = ($("#sched-target").value || "").trim();
      if (typ === "notify") {
        body.title = body.label;
        body.body = body.label;
      }
      if (when === "once") body.once_at = Date.now() / 1000 + 60;
      try {
        await api("/api/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (typeof toast === "function") toast("Planning enregistré");
      } catch (e) {
        if (typeof toast === "function") toast(e.message, "err");
      }
    });
  }

  let voiceRec = null;
  function setupVoice() {
    const btn = $("#btn-voice");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      if (voiceRec && voiceRec.state === "recording") {
        voiceRec.stop();
        return;
      }
      if (!navigator.mediaDevices || typeof MediaRecorder === "undefined") {
        if (typeof toast === "function") toast("Micro indisponible", "err");
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        if (typeof toast === "function") toast("Micro refusé", "err");
        return;
      }
      const chunks = [];
      voiceRec = new MediaRecorder(stream);
      voiceRec.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      voiceRec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        btn.textContent = "Note vocale";
        const type = voiceRec.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : "webm";
        const blob = new Blob(chunks, { type });
        const fd = new FormData();
        fd.append("folder", "Inbox/Voice");
        fd.append("files", blob, "voix-" + Date.now() + "." + ext);
        try {
          const busy = typeof withBusy === "function" ? withBusy : async (_label, fn) => fn();
          await busy("Envoi de la note…", () => api("/api/upload", { method: "POST", body: fd, timeoutMs: 60000 }));
          if (typeof toast === "function") toast("Note vocale dans Inbox/Voice");
        } catch (e) {
          if (typeof toast === "function") toast(e.message, "err");
        }
      };
      voiceRec.start();
      btn.textContent = "Stop";
      if (typeof toast === "function") toast("Enregistrement…");
      setTimeout(() => {
        if (voiceRec && voiceRec.state === "recording") voiceRec.stop();
      }, 60000);
    });
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function setupPush() {
    const note = $("#hq-push-note");
    const btn = $("#btn-push");
    if (!btn || typeof api !== "function") return;
    let status = {};
    try {
      status = await api("/api/push/status");
    } catch (e) {
      if (note) note.textContent = e.message || "";
      return;
    }
    if (note) {
      note.textContent = status.enabled
        ? status.https_note || ""
        : "Désactivé. Mets push_enabled à true dans bridge_config.json, derrière Tailscale Serve (HTTPS). Périmètre : alertes, attention critique, échec d'automatisation.";
    }
    btn.addEventListener("click", async () => {
      if (!status.enabled) {
        if (typeof toast === "function") toast("Web Push désactivé", "err");
        return;
      }
      if (!window.isSecureContext) {
        if (typeof toast === "function") toast("HTTPS requis (Tailscale Serve)", "err");
        return;
      }
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        if (typeof toast === "function") toast("Navigateur sans Web Push", "err");
        return;
      }
      try {
        const reg = await navigator.serviceWorker.register("/hq-sw.js");
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(status.public_key || ""),
        });
        const json = sub.toJSON();
        await api("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: json }),
        });
        btn.setAttribute("aria-pressed", "true");
        btn.textContent = "Activées sur cet appareil";
        if (typeof toast === "function") toast("Notifications activées");
      } catch (e) {
        if (typeof toast === "function") toast(e.message || "Push refusé", "err");
      }
    });
  }

  async function loadHostSpark() {
    const el = $("#hq-spark-host");
    if (!el || typeof api !== "function") return;
    try {
      const tel = await api("/api/telemetry?device=pc-host&limit=60");
      el.innerHTML = sparkline((tel.samples || []).map((s) => s.pct_used).filter((v) => v != null));
    } catch (_) {}
  }

  let helpTicket = 0;
  let helpTimer = 0;
  let helpPending = null;
  let helpCurrent = null;
  let helpTip = null;
  let helpFromKeyboard = false;
  let helpPointerRecent = false;
  let helpReady = false;

  function finePointer() {
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }

  function ensureTooltip() {
    if (helpTip && helpTip.isConnected) return helpTip;
    helpTip = document.getElementById("hq-help-tooltip");
    if (!helpTip) {
      helpTip = document.createElement("div");
      helpTip.id = "hq-help-tooltip";
      helpTip.setAttribute("role", "tooltip");
      helpTip.hidden = true;
      document.body.appendChild(helpTip);
    }
    return helpTip;
  }

  function cancelHelp() {
    helpTicket += 1;
    helpPending = null;
    if (helpTimer) {
      clearTimeout(helpTimer);
      helpTimer = 0;
    }
  }

  function restoreDescribed(target) {
    if (!target || !target.isConnected) return;
    const prev = target.getAttribute("data-help-prev");
    if (prev) target.setAttribute("aria-describedby", prev);
    else target.removeAttribute("aria-describedby");
    target.removeAttribute("data-help-prev");
  }

  function hideHelp() {
    cancelHelp();
    if (helpCurrent) restoreDescribed(helpCurrent);
    helpCurrent = null;
    if (helpTip) {
      helpTip.classList.remove("is-on");
      helpTip.hidden = true;
      helpTip.textContent = "";
    }
  }

  function positionHelp(target) {
    const node = ensureTooltip();
    const margin = 8;
    const rect = target.getBoundingClientRect();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    let top = rect.top - height - margin;
    if (top < margin) top = rect.bottom + margin;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - height - margin);
    let left = rect.left;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;
    const covers = top < rect.bottom && top + height > rect.top && left < rect.right && left + width > rect.left;
    if (covers) {
      const below = rect.bottom + margin;
      if (below + height <= window.innerHeight - margin) top = below;
    }
    node.style.left = Math.round(left) + "px";
    node.style.top = Math.round(top) + "px";
  }

  function showHelp(target) {
    const text = (target.getAttribute("data-help") || "").trim();
    if (!text || !target.isConnected) return;
    if (helpCurrent && helpCurrent !== target) restoreDescribed(helpCurrent);
    const node = ensureTooltip();
    node.textContent = text;
    node.hidden = false;
    const prev = (target.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter((id) => id && id !== "hq-help-tooltip")
      .join(" ");
    target.setAttribute("data-help-prev", prev);
    target.setAttribute("aria-describedby", prev ? prev + " hq-help-tooltip" : "hq-help-tooltip");
    helpCurrent = target;
    helpPending = null;
    positionHelp(target);
    node.classList.add("is-on");
  }

  function scheduleHelp(target, delay) {
    if (!target || !target.getAttribute("data-help")) return;
    if (helpCurrent === target && helpTip && !helpTip.hidden) return;
    cancelHelp();
    helpPending = target;
    const mine = helpTicket;
    helpTimer = setTimeout(() => {
      helpTimer = 0;
      if (mine !== helpTicket) return;
      if (!target.isConnected) {
        hideHelp();
        return;
      }
      if (delay >= 1000 && !finePointer()) return;
      if (delay < 1000 && document.activeElement !== target) return;
      showHelp(target);
    }, delay);
  }

  function helpTargetFrom(node) {
    return node && node.closest ? node.closest("[data-help]") : null;
  }

  function setupHelp() {
    if (helpReady || !document.body) return;
    helpReady = true;
    window.hqHideHelp = hideHelp;
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Tab" || ev.key.indexOf("Arrow") === 0) helpFromKeyboard = true;
      if (ev.key === "Escape") hideHelp();
    }, true);
    document.addEventListener("pointerdown", () => {
      helpFromKeyboard = false;
      helpPointerRecent = true;
      hideHelp();
      setTimeout(() => { helpPointerRecent = false; }, 500);
    }, true);
    document.addEventListener("pointerover", (ev) => {
      if (!finePointer()) return;
      const target = helpTargetFrom(ev.target);
      if (!target) return;
      if (helpTargetFrom(ev.relatedTarget) === target) return;
      scheduleHelp(target, 2000);
    }, true);
    document.addEventListener("pointerout", (ev) => {
      const target = helpTargetFrom(ev.target);
      if (!target) return;
      if (helpTargetFrom(ev.relatedTarget) === target) return;
      if (helpCurrent === target || helpPending === target) hideHelp();
    }, true);
    document.addEventListener("focusin", (ev) => {
      const target = helpTargetFrom(ev.target);
      if (!target || helpPointerRecent) return;
      const keyboard = helpFromKeyboard || (target.matches && target.matches(":focus-visible"));
      if (!keyboard) return;
      scheduleHelp(target, 250);
    });
    document.addEventListener("focusout", (ev) => {
      const target = helpTargetFrom(ev.target);
      if (!target) return;
      if (helpCurrent === target || helpPending === target) hideHelp();
    });
    window.addEventListener("scroll", () => hideHelp(), true);
    window.addEventListener("resize", () => hideHelp());
  }

  function setupSystemNav() {
    const nav = document.querySelector('nav[aria-label="Sections Système"]');
    if (!nav || nav.dataset.ready) return;
    nav.dataset.ready = "1";
    nav.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest("[data-jump]") : null;
      if (!btn || !nav.contains(btn)) return;
      const target = document.getElementById(btn.dataset.jump || "");
      if (!target) return;
      const details = target.tagName === "DETAILS" ? target : target.querySelector("details");
      if (details) details.open = true;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      nav.querySelectorAll("[data-jump]").forEach((node) => {
        const on = node === btn;
        node.classList.toggle("is-current", on);
        if (on) node.setAttribute("aria-current", "true");
        else node.removeAttribute("aria-current");
      });
    });
  }

  function boot() {
    setupHelp();
    setupSystemNav();
    $("#btn-palette")?.addEventListener("click", () => openPalette());
    $("#btn-search-bar")?.addEventListener("click", () => openPalette()); // every view, phone included
    $("#hq-palette")?.addEventListener("click", (ev) => {
      if (ev.target && ev.target.id === "hq-palette") closePalette();
    });
    const input = $("#hq-palette-input");
    if (input) {
      let timer = 0;
      input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => queryPalette(input.value).catch(() => {}), 120);
      });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
          closePalette();
          return;
        }
        if (!paletteHits.length) return;
        if (ev.key === "ArrowDown") {
          paletteIndex = Math.min(paletteHits.length - 1, paletteIndex + 1);
          renderPalette();
          ev.preventDefault();
        } else if (ev.key === "ArrowUp") {
          paletteIndex = Math.max(0, paletteIndex - 1);
          renderPalette();
          ev.preventDefault();
        } else if (ev.key === "Enter") {
          ev.preventDefault();
          runPalette(paletteHits[paletteIndex]).catch((e) => {
            if (typeof toast === "function") toast(e.message, "err");
          });
        }
      });
    }
    document.addEventListener("keydown", (ev) => {
      const box = $("#hq-palette");
      if (box && !box.hidden && ev.key === "Escape") {
        closePalette();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "k" || ev.key === "K")) {
        const box = $("#hq-palette");
        const inPalette = !!(ev.target && ev.target.id === "hq-palette-input");
        if (typingTarget(ev.target) && !inPalette) return;
        if (document.querySelector("dialog[open]")) return;
        ev.preventDefault();
        if (box && !box.hidden) {
          $("#hq-palette-input")?.focus();
          return;
        }
        openPalette();
        return;
      }
      if (!typingTarget(ev.target) && ev.key === "/" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        openPalette();
      }
    });
    document.querySelectorAll("[data-event-kind]").forEach((btn) => {
      btn.addEventListener("click", () => {
        eventKind = btn.dataset.eventKind || "all";
        document.querySelectorAll("[data-event-kind]").forEach((b) => b.classList.toggle("active", b === btn));
        loadEvents();
      });
    });
    const devices = $("#hq-devices");
    if (devices) {
      const openCard = (ev) => {
        const card = ev.target && ev.target.closest ? ev.target.closest("[data-device-id]") : null;
        if (!card || !card.dataset.deviceId) return;
        if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") return;
        if (ev.type === "keydown" && ev.target !== card) return;
        if (ev.type === "keydown") ev.preventDefault();
        openDevice(card.dataset.deviceId);
      };
      devices.addEventListener("click", openCard);
      devices.addEventListener("keydown", openCard);
    }
    setupRuleForm();
    setupScheduleForm();
    setupVoice();
    setupPush();
    setupHomeDisclosures();
    window.hqLoadSnapshot = loadSnapshot;
    loadSnapshot();
    loadEvents();
    loadBrief();
    loadBackups();
    loadRules();
    loadHostSpark();
    window.hqOpenDevice = openDevice;
    if (document.body.classList.contains("wall")) {
      setInterval(loadSnapshot, 15000);
    } else {
      setInterval(() => {
        loadSnapshot();
        loadEvents();
      }, 20000);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
