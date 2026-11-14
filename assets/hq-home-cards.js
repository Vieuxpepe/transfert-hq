/* Accueil — complementary cards.
   Everything here is read-only and optional: a card whose endpoint fails (upload role, module
   absent, network) stays hidden instead of showing an error on the home page. */
(() => {
  "use strict";

  const RESUME_KEY = "hq_home_resume";
  const $ = (id) => document.getElementById(id);
  const api = (path) => (typeof window.api === "function" ? window.api(path, { timeoutMs: 9000 }) : Promise.reject(new Error("api")));

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function show(node, on) {
    if (!node) return;
    node.hidden = !on;
    // First time a card has something to say, it slides in — once, not on every re-render.
    if (on && !node.dataset.entered && (node.classList.contains("home-mini") || node.classList.contains("home-brief"))) {
      node.dataset.entered = "1";
      node.classList.add("is-fresh");
      window.setTimeout(() => node.classList.remove("is-fresh"), 1100);
    }
    // An empty card has no business carrying arrange controls in "Modifier l'accueil".
    if (node.classList && (node.classList.contains("home-mini") || node.classList.contains("home-brief"))) {
      const bar = node.querySelector(":scope > .home-edit-bar");
      if (bar) bar.hidden = !on;
    }
  }

  function syncBars() {
    document.querySelectorAll(".home-v2 .home-mini, .home-v2 .home-brief").forEach((node) => {
      const bar = node.querySelector(":scope > .home-edit-bar");
      if (bar) bar.hidden = node.hidden;
    });
  }

  function go(view) {
    const nav = document.querySelector('[data-nav="' + view + '"]');
    if (nav && !nav.hidden) {
      nav.click();
      return true;
    }
    return false;
  }

  // A week-strip day opens that exact day, not "today": the calendar exposes hqCalendarOpenDay.
  function openDay(key) {
    if (!go("calendrier")) return;
    let tries = 0;
    const apply = () => {
      if (typeof window.hqCalendarOpenDay === "function") {
        try { window.hqCalendarOpenDay(key); } catch (_) {}
        return;
      }
      if (++tries < 40) window.setTimeout(apply, 150);
    };
    window.setTimeout(apply, 80);
  }

  function money(cents, currency) {
    const value = Number(cents || 0) / 100;
    try {
      return new Intl.NumberFormat("fr-CA", { style: "currency", currency: currency || "CAD", maximumFractionDigits: value % 1 ? 2 : 0 }).format(value);
    } catch (_) {
      return value.toFixed(2) + " " + (currency || "CAD");
    }
  }

  function dayKey(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function startMs(value) {
    if (typeof value === "number") return value < 1e11 ? value * 1000 : value;
    const parsed = Date.parse(String(value || ""));
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  /* ---- Hero: now playing ------------------------------------------------------------- */
  const nowBtn = $("home-now");
  const nowText = $("home-now-text");
  if (nowBtn) {
    nowBtn.addEventListener("click", () => go("musique"));
  }

  function applyNow(playing, track, artist) {
    if (!nowBtn) return;
    if (!playing || !track) {
      show(nowBtn, false);
      syncLiveRow();
      return;
    }
    nowText.textContent = artist ? track + " — " + artist : String(track);
    // The app's own tooltip (data-help), not title: no second bubble from the browser.
    nowBtn.setAttribute("data-help", "En lecture : " + nowText.textContent);
    if (!nowBtn.querySelector(".home-live-eq")) {
      const eq = document.createElement("span");
      eq.className = "home-live-eq";
      eq.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 3; i += 1) eq.appendChild(document.createElement("i"));
      nowBtn.appendChild(eq);
    }
    show(nowBtn, true);
    syncLiveRow();
  }

  async function paintNow() {
    if (!nowBtn) return;
    try {
      const data = await api("/api/spotify/player");
      const item = data && data.item;
      const artists = item && Array.isArray(item.artists) ? item.artists.map((a) => (a && a.name) || "").filter(Boolean).join(", ") : String((item && item.artist) || "");
      applyNow(!!(data && data.playing && item), item && item.name, artists);
    } catch (_) {
      applyNow(false);
    }
  }

  // The Musica chip already polls the player; it publishes each result instead of us polling again.
  window.addEventListener("hq:playback", (ev) => {
    const detail = (ev && ev.detail) || {};
    applyNow(!!detail.playing, detail.track, detail.artist);
  });

  /* ---- Hero: bridge health dot -------------------------------------------------------- */
  const health = $("home-health");
  async function paintHealth() {
    if (!health) return;
    try {
      const data = await api("/api/health");
      const bridge = (data && data.bridge) || {};
      const backup = (data && data.backup) || {};
      const disk = (data && data.disk_d) || {};
      if (data.ok === false || bridge.ok === false) {
        show(health, false);
        return;
      }
      const bits = ["Pont en ligne"];
      if (disk.free_h) bits.push("D: " + disk.free_h + " libres");
      if (backup.ok === false) bits.push("sauvegarde à vérifier");
      health.classList.toggle("is-warn", backup.ok === false);
      health.setAttribute("data-help", bits.join(" · "));
      health.setAttribute("aria-label", bits.join(", "));
      show(health, true);
    } catch (_) {
      show(health, false);
    }
    syncLiveRow();
  }

  /* ---- Hero: resume where I was ------------------------------------------------------- */
  const resumeBtn = $("home-resume");
  const resumeText = $("home-resume-text");
  if (resumeBtn) {
    resumeBtn.addEventListener("click", () => {
      const saved = readResume();
      if (!saved || !go(saved.view)) show(resumeBtn, false);
    });
  }

  function readResume() {
    try {
      const raw = JSON.parse(localStorage.getItem(RESUME_KEY) || "null");
      if (!raw || !raw.view || raw.view === "accueil" || !raw.label) return null;
      if (Date.now() - Number(raw.at || 0) > 7 * 864e5) return null;
      return raw;
    } catch (_) {
      return null;
    }
  }

  function rememberView(view, label) {
    if (!view || view === "accueil" || !label) return;
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify({ view: view, label: label, at: Date.now() }));
    } catch (_) {}
  }

  function paintResume() {
    const saved = readResume();
    if (!saved || !resumeBtn) {
      show(resumeBtn, false);
      syncLiveRow();
      return;
    }
    resumeText.textContent = "Reprendre : " + saved.label;
    resumeBtn.setAttribute("data-help", "Revenir à " + saved.label);
    show(resumeBtn, true);
    syncLiveRow();
  }

  function syncLiveRow() {
    const row = $("home-live");
    if (!row) return;
    const any = ["home-now", "home-resume", "home-health"].some((id) => {
      const node = $(id);
      return node && !node.hidden;
    });
    row.hidden = !any;
  }

  /* ---- Main: brief -------------------------------------------------------------------- */
  const briefCard = $("home-brief-card");
  const briefLines = $("home-brief-lines");
  const briefMore = $("home-brief-more");
  if (briefMore) {
    briefMore.addEventListener("click", () => {
      if (!go("plus")) return;
      setTimeout(() => {
        const target = $("system-brief");
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 450);
    });
  }

  async function paintBrief() {
    if (!briefCard || !briefLines) return;
    try {
      const data = await api("/api/brief");
      const lines = (data && Array.isArray(data.lines) ? data.lines : []).slice(0, 3);
      if (!data || !lines.length) {
        show(briefCard, false);
        return;
      }
      briefLines.textContent = "";
      lines.forEach((text, index) => {
        const value = String(text || "").trim();
        if (!value) return;
        const item = el("li", "home-brief-line is-fresh", value);
        item.style.setProperty("--i", String(index));
        briefLines.appendChild(item);
      });
      show(briefCard, briefLines.childElementCount > 0);
    } catch (_) {
      show(briefCard, false);
    }
  }

  /* ---- Main: seven-day strip inside Aujourd'hui --------------------------------------- */
  const week = $("home-week");
  async function paintWeek() {
    if (!week) return;
    const days = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(today.getTime() + i * 864e5);
      days.push(day);
    }
    const last = new Date(days[6].getTime() + 864e5);
    let counts = {};
    try {
      const data = await api("/api/calendar?from=" + dayKey(days[0]) + "&to=" + dayKey(last));
      (data && Array.isArray(data.items) ? data.items : []).forEach((item) => {
        if (!item || item.read_only) return;
        const at = startMs(item.start);
        if (!at) return;
        const key = dayKey(new Date(at));
        counts[key] = (counts[key] || 0) + 1;
      });
    } catch (_) {
      show(week, false);
      return;
    }
    week.textContent = "";
    const letters = ["D", "L", "M", "M", "J", "V", "S"];
    days.forEach((day, index) => {
      const key = dayKey(day);
      const count = counts[key] || 0;
      const cell = el("button", "home-week-day is-fresh" + (index === 0 ? " is-today" : "") + (count ? " has-events" : ""));
      cell.type = "button";
      cell.style.setProperty("--i", String(index));
      cell.setAttribute("aria-label", day.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }) + (count ? ", " + count + " événement" + (count > 1 ? "s" : "") : ", libre"));
      cell.appendChild(el("span", "home-week-letter", letters[day.getDay()]));
      cell.appendChild(el("span", "home-week-num", String(day.getDate())));
      cell.appendChild(el("span", "home-week-dot", count ? String(count) : ""));
      cell.addEventListener("click", () => openDay(key));
      week.appendChild(cell);
    });
    show(week, true);
  }

  /* ---- Side: small cards -------------------------------------------------------------- */
  function card(id, bodyId) {
    const root = $(id);
    const body = bodyId ? $(bodyId) : root && root.querySelector(".home-mini-body");
    return { root, body };
  }

  function fill(root, body, nodes) {
    if (!root || !body) return;
    body.textContent = "";
    nodes.forEach((node) => node && body.appendChild(node));
    show(root, body.childElementCount > 0);
  }

  function line(main, sub) {
    const wrap = el("div", "home-mini-main");
    wrap.appendChild(el("strong", "home-mini-value is-fresh", main));
    if (sub) wrap.appendChild(el("span", "home-mini-sub", sub));
    return wrap;
  }

  function link(text, view) {
    const btn = el("button", "ghost home-link home-mini-link", text);
    btn.type = "button";
    btn.addEventListener("click", () => go(view));
    return btn;
  }

  async function paintBudget() {
    const { root, body } = card("home-budget");
    if (!root) return;
    try {
      const data = await api("/api/finances/summary");
      const currency = (data && data.household_currency) || "CAD";
      const by = (data && data.balances_by_currency) || {};
      const accounts = (data && Array.isArray(data.accounts) ? data.accounts : []).filter((a) => !a.archived);
      if (!accounts.length) {
        show(root, false); // rien à montrer tant que la maison n'a pas de compte
        return;
      }
      const total = Number(by[currency] != null ? by[currency] : accounts.filter((a) => a.currency === currency).reduce((sum, a) => sum + Number(a.balance_cents || 0), 0));
      fill(root, body, [
        line(money(total, currency), accounts.length + " compte" + (accounts.length > 1 ? "s" : "")),
        link("Budget ›", "budget"),
      ]);
    } catch (_) {
      show(root, false);
    }
  }

  async function paintMeals() {
    const { root, body } = card("home-meals");
    if (!root) return;
    try {
      const [plans, recipes] = await Promise.all([api("/api/meals/plans"), api("/api/meals/recipes")]);
      const today = dayKey(new Date());
      const names = {};
      (recipes && Array.isArray(recipes.items) ? recipes.items : []).forEach((recipe) => {
        if (recipe && recipe.id) names[recipe.id] = recipe.name || recipe.title || "";
      });
      const plan = (plans && Array.isArray(plans.items) ? plans.items : []).find((p) => p && p.period_start <= today && p.period_end >= today);
      const slots = (plan && Array.isArray(plan.slots) ? plan.slots : []).filter((slot) => slot && slot.date === today && slot.recipe_id);
      const order = ["dinner", "lunch", "breakfast", "snack"];
      const chosen = order.map((meal) => slots.find((slot) => slot.meal === meal)).find(Boolean) || slots[0];
      if (!chosen) {
        show(root, false); // pas de plan cette semaine : la carte reste discrète
        return;
      }
      const label = chosen.meal === "dinner" ? "Souper" : chosen.meal === "lunch" ? "Dîner" : chosen.meal === "breakfast" ? "Déjeuner" : "Collation";
      fill(root, body, [line(names[chosen.recipe_id] || "Recette planifiée", label), link("Repas ›", "repas")]);
    } catch (_) {
      show(root, false);
    }
  }

  async function paintStock() {
    const { root, body } = card("home-stock");
    if (!root) return;
    try {
      const data = await api("/api/inventoria/status");
      const alerts = (data && Array.isArray(data.alerts) ? data.alerts : []).length;
      const shopping = data && data.shopping && data.shopping.all ? Number(data.shopping.all.count || 0) : 0;
      if (!alerts && !shopping) {
        fill(root, body, [line("Tout est approvisionné", "Aucune alerte de stock"), link("Inventaire ›", "inventaire")]);
        return;
      }
      const parts = [];
      if (alerts) parts.push(alerts + " sous le seuil");
      if (shopping) parts.push(shopping + " à acheter");
      fill(root, body, [line(parts.join(" · "), alerts ? "Ravitaille bientôt" : "Liste d'épicerie prête"), link("Inventaire ›", "inventaire")]);
    } catch (_) {
      show(root, false);
    }
  }

  async function paintForge() {
    const { root, body } = card("home-forge");
    if (!root) return;
    try {
      const data = await api("/api/forge/status");
      const state = (data && (data.forge || data.state)) || "error";
      const labels = {
        ready: ["Forge prête", "API accessible"],
        offline: ["Forge arrêtée", "Le lanceur API n'est pas démarré"],
        api_disabled: ["API désactivée", "Forge est ouvert sans API"],
        error: ["Forge injoignable", "La lecture a échoué"],
      };
      const pair = labels[state] || labels.error;
      const queue = data && (Array.isArray(data.queue) ? data.queue.length : Array.isArray(data.jobs) ? data.jobs.length : 0);
      fill(root, body, [line(pair[0], queue ? queue + " en file" : pair[1]), link("Forge ›", "forge")]);
    } catch (_) {
      show(root, false);
    }
  }

  async function paintProjects() {
    const { root, body } = card("home-projects");
    if (!root) return;
    try {
      const data = await api("/api/projects");
      const items = (data && (Array.isArray(data.projects) ? data.projects : Array.isArray(data.items) ? data.items : [])) || [];
      const active = items.filter((p) => p && !["done", "archived", "termine", "terminé"].includes(String(p.status || "")));
      if (!items.length) {
        show(root, false);
        return;
      }
      const first = active[0] || items[0];
      fill(root, body, [
        line(active.length + " actif" + (active.length > 1 ? "s" : ""), first && first.name ? String(first.name).slice(0, 48) : ""),
        link("Projets ›", "projets"),
      ]);
    } catch (_) {
      show(root, false);
    }
  }

  async function paintQuests() {
    const { root, body } = card("home-quests");
    if (!root) return;
    try {
      const data = await api("/api/mini-quests/");
      const quests = (data && (Array.isArray(data.quests) ? data.quests : Array.isArray(data.items) ? data.items : [])) || [];
      const active = Number((data && data.active) || 0);
      if (!active) {
        show(root, false); // le catalogue seul n'apprend rien : on n'affiche que l'activité
        return;
      }
      fill(root, body, [line(active + " mini-quête" + (active > 1 ? "s" : "") + " en cours", quests.length + " disponibles")]);
    } catch (_) {
      show(root, false);
    }
  }

  /* ---- Musica: what is on air, what airs next, and the daily challenge ------------------- */
  function openMusic(tab) {
    try { window.sessionStorage.setItem("hq_music_tab", tab || "lecture"); } catch (_) {}
    go("musique");
  }

  function musicaButton(text, tab, primary) {
    const btn = el("button", (primary ? "home-link home-mini-link" : "ghost home-link home-mini-link"), text);
    btn.type = "button";
    btn.addEventListener("click", () => openMusic(tab));
    return btn;
  }

  async function paintMusica() {
    const { root, body } = card("home-musica");
    if (!root) return;
    try {
      const data = await api("/api/musica/dj/station");
      if (!data || data.ok === false) {
        show(root, false);
        return;
      }
      const air = data.on_air;
      const next = (data.upcoming || [])[0];
      const ready = (data.ready || [])[0];
      const daily = data.daily || {};
      const nodes = [];
      if (air) {
        nodes.push(line("En ondes · " + (air.title || "Musica"), air.track ? air.track + (air.artist ? " — " + air.artist : "") : "La suite arrive"));
      } else if (ready) {
        nodes.push(line((ready.label || "Une émission") + " est prête", "Ouvre Musica pour la lancer"));
      } else if (next) {
        const when = new Date(next.ts * 1000);
        const day = next.today ? "aujourd’hui" : when.toLocaleDateString("fr-CA", { weekday: "long" });
        nodes.push(line("Prochain : " + (next.icon || "") + " " + next.label, day + " " + String(when.getHours()).padStart(2, "0") + ":" + String(when.getMinutes()).padStart(2, "0")));
      } else {
        nodes.push(line("Musica t’attend", "Une émission, un duel ou le défi du jour."));
      }
      const chips = el("div", "home-musica-chips");
      if (daily.done_today === false) chips.appendChild(el("span", "home-musica-chip is-hot", "🔥 Défi du jour" + (daily.streak ? " · série " + daily.streak : "")));
      else if (daily.streak) chips.appendChild(el("span", "home-musica-chip", "✔ Défi fait · série " + daily.streak));
      if (data.tournament) chips.appendChild(el("span", "home-musica-chip", "🏆 Tournoi · " + (data.tournament.round || "en cours")));
      if (chips.childElementCount) nodes.push(chips);
      const prev = data.previously && !data.previously.first_visit && data.previously.items && data.previously.items.length ? data.previously.line : "";
      if (prev) nodes.push(el("p", "home-mini-sub home-musica-prev", prev));
      nodes.push(musicaButton(daily.done_today === false ? "Jouer le défi ›" : "Ouvrir Musica ›", daily.done_today === false ? "quiz" : "lecture", true));
      fill(root, body, nodes);
    } catch (_) {
      show(root, false);
    }
  }

  /* ---- Quick actions ------------------------------------------------------------------ */
  document.querySelectorAll("[data-home-open]").forEach((btn) => {
    if (btn.closest(".home-mini")) return; // the card's own link
    btn.addEventListener("click", () => go(btn.dataset.homeOpen));
  });

  /* ---- Lifecycle ---------------------------------------------------------------------- */
  let view = "";
  const PAINTS = [
    [null, paintNow],
    [null, paintHealth],
    [null, paintResume],
    ["home-brief-card", paintBrief],
    ["home-week", paintWeek],
    ["home-budget", paintBudget],
    ["home-meals", paintMeals],
    ["home-stock", paintStock],
    ["home-forge", paintForge],
    ["home-projects", paintProjects],
    ["home-quests", paintQuests],
    ["home-musica", paintMusica],
  ];

  const idle = (fn) =>
    typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(fn, { timeout: 1200 }) : window.setTimeout(fn, 40);

  // Eleven endpoints at once on every Accueil entry: three per idle slice, and none for a card
  // the owner has hidden in "Modifier l'accueil".
  function refresh() {
    const jobs = PAINTS.filter(([id]) => {
      if (!id) return true;
      const node = $(id);
      return !node || !node.classList.contains("is-user-hidden");
    }).map(([, fn]) => fn);
    const slice = () => {
      jobs.splice(0, 3).forEach((fn) => {
        try { fn(); } catch (_) {}
      });
      if (jobs.length) idle(slice);
      else window.setTimeout(syncBars, 0);
    };
    slice();
  }

  function boot() {
    const body = document.body;
    if (!body || body.dataset.view !== "accueil") {
      // Keep remembering where the owner goes, even when the cards are not on screen.
      watchViews();
      return;
    }
    view = "accueil";
    // Stagger drivers, in display order: the cards and their values arrive in a cascade.
    document.querySelectorAll(".home-v2 .home-brief, .home-v2 .home-mini").forEach((node, index) => {
      node.style.setProperty("--i", String(index));
    });
    refresh();
    watchViews();
    // The arrange bars are built by hq-home.js once the saved layout arrives.
    [400, 1200, 2500].forEach((ms) => window.setTimeout(syncBars, ms));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && document.body.dataset.view === "accueil") paintNow();
    });
  }

  function watchViews() {
    const body = document.body;
    let last = body.dataset.view;
    const onChange = () => {
      const now = body.dataset.view;
      if (now === last) return;
      const label = ($("view-label") || {}).textContent || "";
      rememberView(last, label);
      last = now;
      if (now === "accueil") {
        view = "accueil";
        refresh();
      }
      paintResume();
    };
    new MutationObserver(onChange).observe(body, { attributes: true, attributeFilter: ["data-view"] });
    // First paint already sits on a view that is not Accueil: remember it too.
    if (last && last !== "accueil") rememberView(last, ($("view-label") || {}).textContent || "");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
