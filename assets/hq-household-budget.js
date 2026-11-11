/* Transfert HQ — Budget view.
   Mountable without shared navigation. The navigation agent registers the label "Budget".

   HqHouseholdBudget.mount(element, { request, today })
   HqHouseholdBudget.unmount(element)

   request({ method, path, body, credentials }) resolves { status, body }.
   POST uses a same-origin fetch so the bridge Origin check can pass.
   Amounts stay in integer cents. Currencies are never added together.
   This view does not post transactions, change limits, or create goals unless
   the person submits a form. Recurring items are saved with auto_post false.
   Existing transaction rows cannot be edited in place. A correction is a separate,
   explicit write to /api/finances/transactions/correct.
*/
(function (root) {
  "use strict";

  function parseIso(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const utc = new Date(Date.UTC(year, month - 1, day));
    if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
    return iso;
  }

  function monthBounds(iso) {
    const valid = parseIso(iso);
    if (!valid) return null;
    const year = Number(valid.slice(0, 4));
    const month = Number(valid.slice(5, 7));
    const start = valid.slice(0, 7) + "-01";
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { start: start, end: valid.slice(0, 7) + "-" + String(last).padStart(2, "0") };
  }

  function shiftMonth(iso, delta) {
    const bounds = monthBounds(iso);
    if (!bounds || !Number.isSafeInteger(delta)) return null;
    const year = Number(bounds.start.slice(0, 4));
    const month = Number(bounds.start.slice(5, 7));
    const utc = new Date(Date.UTC(year, month - 1 + delta, 1));
    const y = utc.getUTCFullYear();
    const m = String(utc.getUTCMonth() + 1).padStart(2, "0");
    return y + "-" + m + "-01";
  }

  function formatCadCents(cents) {
    if (!Number.isSafeInteger(cents)) return "";
    const sign = cents < 0 ? "−" : "";
    const abs = Math.abs(cents);
    const whole = Math.floor(abs / 100);
    const frac = String(abs % 100).padStart(2, "0");
    const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
    return sign + grouped + "," + frac + "\u00a0$";
  }

  function parseCadToCents(text) {
    const raw = String(text == null ? "" : text).trim().replace(/\s/g, "").replace(",", ".");
    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
    if (!match) return null;
    const frac = (match[3] || "").padEnd(2, "0");
    const combined = match[2].replace(/^0+(?=\d)/, "") + frac;
    if (combined.length > 15) return null;
    const cents = Number(combined);
    if (!Number.isSafeInteger(cents)) return null;
    return match[1] ? -cents : cents;
  }

  const TX_PAGE_LIMIT = 25;

  function accountCurrency(accounts, accountId) {
    if (!accountId) return null;
    const account = (accounts || []).find(function (item) { return item && item.id === accountId; });
    if (!account || typeof account.currency !== "string" || !/^[A-Z]{3}$/.test(account.currency)) return null;
    return account.currency;
  }

  function formatMoney(cents, currency) {
    if (!Number.isSafeInteger(cents)) return "";
    if (currency === "CAD") return formatCadCents(cents);
    if (!currency) return "devise inconnue";
    const sign = cents < 0 ? "−" : "";
    const abs = Math.abs(cents);
    const whole = Math.floor(abs / 100);
    const frac = String(abs % 100).padStart(2, "0");
    const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
    return sign + grouped + "," + frac + "\u00a0" + currency;
  }

  function monthTotals(transactions, categories, accounts, start, end) {
    const kinds = new Map((categories || []).map(function (category) { return [category.id, category.kind]; }));
    let income = 0;
    let expense = 0;
    let unknownCount = 0;
    const other = {};
    (transactions || []).forEach(function (tx) {
      if (!tx || tx.status !== "posted" || tx.transfer_pair_id) return;
      if (tx.booked_on < start || tx.booked_on > end) return;
      if (!Number.isSafeInteger(tx.amount_cents)) return;
      const currency = accountCurrency(accounts, tx.account_id);
      if (!currency) {
        unknownCount += 1;
        return;
      }
      const kind = kinds.get(tx.category_id);
      let bucketIncome = 0;
      let bucketExpense = 0;
      if (kind === "income" && tx.amount_cents > 0) bucketIncome = tx.amount_cents;
      else if (kind === "expense" && tx.amount_cents < 0) bucketExpense = tx.amount_cents;
      else return;
      if (currency === "CAD") {
        income += bucketIncome;
        expense += bucketExpense;
        return;
      }
      if (!other[currency]) other[currency] = { incomeCents: 0, expenseCents: 0 };
      other[currency].incomeCents += bucketIncome;
      other[currency].expenseCents += bucketExpense;
    });
    Object.keys(other).forEach(function (code) {
      other[code].remainingCents = other[code].incomeCents + other[code].expenseCents;
    });
    return {
      incomeCents: income,
      expenseCents: expense,
      remainingCents: income + expense,
      unknownCount: unknownCount,
      other: other,
    };
  }

  function transactionPath(start, end, cursor) {
    let path = "/api/finances/transactions?from=" + encodeURIComponent(start) + "&to=" + encodeURIComponent(end) + "&limit=200";
    if (cursor) path += "&cursor=" + encodeURIComponent(cursor);
    return path;
  }

  function takeTransactionPage(state, body, status) {
    if (state.complete || state.error) return state;
    if (status !== 200 || !body || !Array.isArray(body.items)) {
      return { items: [], cursor: state.cursor, seen: state.seen, complete: false, error: "request" };
    }
    const next = typeof body.next_cursor === "string" ? body.next_cursor : "";
    if (next && (state.seen.indexOf(next) !== -1 || next === state.cursor)) {
      return { items: [], cursor: next, seen: state.seen, complete: false, error: "repeated" };
    }
    const items = state.items.concat(body.items);
    if (!next) return { items: items, cursor: "", seen: state.seen, complete: true, error: null };
    if (state.seen.length + 1 >= TX_PAGE_LIMIT) {
      return { items: [], cursor: next, seen: state.seen.concat(next), complete: false, error: "bounded" };
    }
    return { items: items, cursor: next, seen: state.seen.concat(next), complete: false, error: null };
  }

  function foldTransactionPages(pages) {
    let state = { items: [], cursor: "", seen: [], complete: false, error: null };
    (pages || []).forEach(function (page) {
      state = takeTransactionPage(state, page.body, page.status);
    });
    if (!state.complete) return { items: [], cursor: state.cursor, seen: state.seen, complete: false, error: state.error || "incomplete" };
    return state;
  }

  function envelopeRemaining(envelope) {
    if (!envelope || !Number.isSafeInteger(envelope.allocated_cents) || !Number.isSafeInteger(envelope.spent_cents)) return null;
    return envelope.allocated_cents - envelope.spent_cents;
  }

  function cadBalance(summary) {
    const balances = (summary && summary.balances_by_currency) || {};
    const cad = balances.CAD;
    return Number.isSafeInteger(cad) ? cad : 0;
  }

  function otherCurrencies(summary) {
    const balances = (summary && summary.balances_by_currency) || {};
    return Object.keys(balances).filter(function (code) { return code !== "CAD"; }).sort();
  }

  function newKey(prefix) {
    const bytes = new Uint8Array(8);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return prefix + "-" + Array.from(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  async function browserRequest(call) {
    const response = await fetch(call.path, {
      method: call.method,
      credentials: "same-origin",
      headers: call.body
        ? { "Content-Type": "application/json", "Accept": "application/json" }
        : { "Accept": "application/json" },
      body: call.body ? JSON.stringify(call.body) : undefined,
    });
    let body = {};
    try { body = await response.json(); } catch (_err) { body = {}; }
    return { status: response.status, body: body };
  }

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (key) {
      if (key === "class") node.className = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  const sessions = new WeakMap();

  function mount(container, options) {
    if (!container) throw new Error("budget mount requires an element");
    unmount(container);
    const today = parseIso(options && options.today) || new Date().toISOString().slice(0, 10);
    const session = {
      container: container,
      request: (options && options.request) || browserRequest,
      month: monthBounds(today).start,
      summary: null,
      categories: [],
      transactions: [],
      totals: null,
      recurring: [],
      goals: [],
      status: "loading",
      message: "",
      alive: true,
    };
    sessions.set(container, session);
    container.classList.add("hq-budget");
    container.setAttribute("data-hq-view", "budget");
    paint(container);
    refresh(container);
    container.addEventListener("click", onClick);
    container.addEventListener("submit", onSubmit);
    return session;
  }

  function unmount(container) {
    const session = sessions.get(container);
    if (!session) return;
    session.alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
    sessions.delete(container);
    clear(container);
    container.classList.remove("hq-budget");
    container.removeAttribute("data-hq-view");
  }

  async function call(session, method, path, body) {
    const result = await session.request({ method: method, path: path, body: body, credentials: "same-origin" });
    return result || { status: 0, body: {} };
  }

  async function refresh(container) {
    const session = sessions.get(container);
    if (!session) return;
    session.status = "loading";
    paint(container);
    const bounds = monthBounds(session.month);
    try {
      const results = await Promise.all([
        call(session, "GET", "/api/finances/summary"),
        call(session, "GET", "/api/finances/categories"),
        call(session, "GET", "/api/finances/recurring"),
        call(session, "GET", "/api/finances/goals"),
      ]);
      if (!session.alive) return;
      const failed = results.find(function (item) { return item.status !== 200; });
      if (failed) {
        session.status = "error";
        session.message = (failed.body && failed.body.error) || "Les finances ne répondent pas.";
        session.transactions = [];
        session.totals = null;
        paint(container);
        return;
      }
      let pages = { items: [], cursor: "", seen: [], complete: false, error: null };
      for (let page = 0; page < TX_PAGE_LIMIT; page += 1) {
        const result = await call(session, "GET", transactionPath(bounds.start, bounds.end, pages.cursor));
        if (!session.alive) return;
        pages = takeTransactionPage(pages, result.body, result.status);
        if (pages.complete || pages.error) break;
      }
      if (!pages.complete) {
        session.summary = results[0].body;
        session.categories = results[1].body.items || [];
        session.transactions = [];
        session.totals = null;
        session.recurring = results[2].body.items || [];
        session.goals = results[3].body.items || [];
        session.status = "incomplete";
        session.message = pages.error === "repeated"
          ? "Le curseur des écritures se répète. Les totaux du mois ne sont pas affichés."
          : pages.error === "bounded"
            ? "Le mois dépasse la limite de lecture. Les totaux du mois ne sont pas affichés."
            : "Les écritures du mois n'ont pas pu être lues en entier. Les totaux ne sont pas affichés.";
        paint(container);
        return;
      }
      session.summary = results[0].body;
      session.categories = results[1].body.items || [];
      session.transactions = pages.items;
      session.recurring = results[2].body.items || [];
      session.goals = results[3].body.items || [];
      session.totals = monthTotals(pages.items, session.categories, session.summary.accounts || [], bounds.start, bounds.end);
      session.status = "ready";
      paint(container);
    } catch (err) {
      if (!session.alive) return;
      session.status = "error";
      session.message = err && err.message ? err.message : "Erreur réseau";
      paint(container);
    }
  }

  function categoryName(session, id) {
    const found = session.categories.find(function (category) { return category.id === id; });
    return found ? found.name : id;
  }

  function paint(container) {
    const session = sessions.get(container);
    if (!session) return;
    const bounds = monthBounds(session.month);
    clear(container);
    container.setAttribute("data-state", session.status);
    container.setAttribute("aria-busy", session.status === "loading" ? "true" : "false");
    const bar = el("div", { class: "hq-budget-bar" });
    bar.appendChild(el("button", { type: "button", class: "hq-budget-step", "data-action": "prev-month", "aria-label": "Mois précédent" }, "‹"));
    bar.appendChild(el("h2", { class: "hq-budget-title", id: "hq-budget-title" }, bounds.start.slice(0, 7)));
    bar.appendChild(el("button", { type: "button", class: "hq-budget-step", "data-action": "next-month", "aria-label": "Mois suivant" }, "›"));
    container.appendChild(bar);

    if (session.status === "loading") {
      container.appendChild(el("p", { class: "hq-budget-status", role: "status" }, "Chargement du budget…"));
      return;
    }
    if (session.status === "error" || session.status === "incomplete") {
      container.appendChild(el("p", { class: "hq-budget-status", role: "alert" }, session.message));
      container.appendChild(el("button", { type: "button", "data-action": "retry" }, "Réessayer"));
      container.setAttribute("data-totals", "incomplete");
      return;
    }

    const totals = session.totals || monthTotals(session.transactions, session.categories, (session.summary && session.summary.accounts) || [], bounds.start, bounds.end);
    const cards = el("div", { class: "hq-budget-cards", "data-totals": totals.unknownCount ? "incomplete" : "complete" });
    cards.appendChild(metric("Revenus CAD", formatCadCents(totals.incomeCents)));
    cards.appendChild(metric("Dépenses CAD", formatCadCents(totals.expenseCents)));
    cards.appendChild(metric("Reste CAD", formatCadCents(totals.remainingCents)));
    cards.appendChild(metric("Solde CAD", formatCadCents(cadBalance(session.summary))));
    container.appendChild(cards);
    container.setAttribute("data-totals", totals.unknownCount ? "incomplete" : "complete");
    if (totals.unknownCount) {
      container.appendChild(el("p", { class: "hq-budget-status", role: "alert" }, totals.unknownCount + " écriture(s) exclue(s) : la devise du compte est inconnue. Les totaux CAD ne couvrent pas tout le mois."));
    }
    Object.keys(totals.other).sort().forEach(function (code) {
      const bucket = totals.other[code];
      container.appendChild(el("p", { class: "hq-budget-status" }, "Mouvements " + code + " : revenus " + formatMoney(bucket.incomeCents, code) + ", dépenses " + formatMoney(bucket.expenseCents, code) + ". Non additionné au CAD."));
    });
    otherCurrencies(session.summary).forEach(function (code) {
      const cents = session.summary.balances_by_currency[code];
      container.appendChild(el("p", { class: "hq-budget-status" }, code + " : " + formatMoney(cents, code) + " — non additionné au CAD."));
    });
    if (session.message) container.appendChild(el("p", { class: "hq-budget-status", role: "status" }, session.message));

    const limits = el("section", { class: "hq-budget-section", "aria-labelledby": "hq-budget-limits" });
    limits.appendChild(el("h3", { id: "hq-budget-limits" }, "Plafonds"));
    const envelopes = ((session.summary && session.summary.envelopes) || []).filter(function (envelope) {
      return envelope.currency === "CAD" && envelope.period_start <= bounds.end && envelope.period_end >= bounds.start;
    });
    if (!envelopes.length) limits.appendChild(el("p", {}, "Aucun plafond CAD pour ce mois."));
    envelopes.forEach(function (envelope) {
      const row = el("div", { class: "hq-budget-limit" });
      const remaining = envelopeRemaining(envelope);
      row.appendChild(el("span", {}, categoryName(session, envelope.category_id)));
      row.appendChild(el("span", {}, formatCadCents(envelope.spent_cents) + " / " + formatCadCents(envelope.allocated_cents)));
      const meter = el("progress", { max: String(Math.max(envelope.allocated_cents, 1)), value: String(Math.max(envelope.spent_cents, 0)) });
      meter.setAttribute("aria-label", "Dépense " + categoryName(session, envelope.category_id));
      row.appendChild(meter);
      row.appendChild(el("span", {}, "Reste " + formatCadCents(remaining)));
      limits.appendChild(row);
    });
    container.appendChild(limits);

    const history = el("section", { class: "hq-budget-section" });
    history.appendChild(el("h3", {}, "Écritures"));
    if (!session.transactions.length) history.appendChild(el("p", {}, "Aucune écriture ce mois-ci."));
    session.transactions.forEach(function (tx) {
      const row = el("article", { class: "hq-budget-tx" });
      row.appendChild(el("p", {}, tx.booked_on + " · " + (tx.payee || categoryName(session, tx.category_id))));
      row.appendChild(el("p", {}, formatMoney(tx.amount_cents, accountCurrency(session.summary.accounts || [], tx.account_id)) + " · " + tx.status));
      if (!tx.transfer_pair_id && !tx.correction_of) {
        const correct = el("button", { type: "button", "data-action": "show-correct", "data-id": tx.id }, "Corriger");
        row.appendChild(correct);
      }
      history.appendChild(row);
    });
    history.appendChild(transactionForm(session, bounds.start));
    history.appendChild(el("p", { class: "hq-budget-status" }, "Une écriture existante ne se modifie pas sur place. La correction crée une nouvelle écriture, seulement si vous la confirmez."));
    container.appendChild(history);

    const recurring = el("section", { class: "hq-budget-section" });
    recurring.appendChild(el("h3", {}, "Récurrences"));
    if (!session.recurring.length) recurring.appendChild(el("p", {}, "Aucune récurrence."));
    session.recurring.forEach(function (item) {
      const recurringCurrency = typeof item.currency === "string" && /^[A-Z]{3}$/.test(item.currency) ? item.currency : null;
      recurring.appendChild(el("p", {}, categoryName(session, item.category_id) + " · " + formatMoney(item.amount_cents, recurringCurrency) + " · " + item.cadence + (item.auto_post ? " · auto_post enregistré ailleurs" : "")));
    });
    recurring.appendChild(recurringForm(session, bounds.start));
    recurring.appendChild(el("p", { class: "hq-budget-status" }, "Cette vue enregistre les récurrences avec auto_post désactivé. Elle ne poste rien toute seule."));
    container.appendChild(recurring);

    const goals = el("section", { class: "hq-budget-section" });
    goals.appendChild(el("h3", {}, "Objectifs"));
    if (!session.goals.length) goals.appendChild(el("p", {}, "Aucun objectif."));
    session.goals.forEach(function (goal) {
      const row = el("div", { class: "hq-budget-limit" });
      row.appendChild(el("span", {}, goal.name));
      const goalCurrency = typeof session.summary.household_currency === "string" && /^[A-Z]{3}$/.test(session.summary.household_currency)
        ? session.summary.household_currency
        : null;
      row.appendChild(el("span", {}, formatMoney(goal.saved_cents, goalCurrency) + " / " + formatMoney(goal.target_cents, goalCurrency)));
      const meter = el("progress", { max: String(Math.max(goal.target_cents, 1)), value: String(Math.max(goal.saved_cents, 0)) });
      meter.setAttribute("aria-label", "Objectif " + goal.name);
      row.appendChild(meter);
      goals.appendChild(row);
    });
    goals.appendChild(goalForm());
    container.appendChild(goals);

    const correct = el("section", { class: "hq-budget-section", id: "hq-budget-correct", hidden: "hidden" });
    correct.appendChild(el("h3", {}, "Correction"));
    const form = el("form", { "data-form": "correct" });
    form.appendChild(el("input", { name: "correction_of", type: "hidden" }));
    form.appendChild(el("label", {}, "Montant corrigé (CAD)"));
    form.appendChild(el("input", { name: "amount", "aria-label": "Montant corrigé", required: "required", inputmode: "decimal" }));
    form.appendChild(el("label", {}, "Raison"));
    form.appendChild(el("input", { name: "reason", "aria-label": "Raison de la correction", required: "required" }));
    form.appendChild(el("button", { type: "submit" }, "Enregistrer la correction"));
    correct.appendChild(form);
    container.appendChild(correct);
  }

  function metric(label, value) {
    const card = el("article", { class: "hq-budget-card" });
    card.appendChild(el("h3", {}, label));
    card.appendChild(el("p", {}, value));
    return card;
  }

  function transactionForm(session, bookedOn) {
    const form = el("form", { "data-form": "transaction" });
    form.appendChild(el("h3", {}, "Ajouter une écriture"));
    form.appendChild(selectAccounts(session));
    form.appendChild(selectCategories(session));
    form.appendChild(el("input", { name: "booked_on", type: "date", value: bookedOn, "aria-label": "Date", required: "required" }));
    form.appendChild(el("input", { name: "amount", "aria-label": "Montant en dollars canadiens", required: "required", inputmode: "decimal" }));
    form.appendChild(el("input", { name: "payee", "aria-label": "Bénéficiaire", maxlength: "160" }));
    form.appendChild(el("button", { type: "submit" }, "Ajouter l'écriture"));
    return form;
  }

  function recurringForm(session, nextOn) {
    const form = el("form", { "data-form": "recurring" });
    form.appendChild(selectAccounts(session));
    form.appendChild(selectCategories(session));
    form.appendChild(el("input", { name: "amount", "aria-label": "Montant récurrent", required: "required", inputmode: "decimal" }));
    const cadence = el("select", { name: "cadence", "aria-label": "Cadence" });
    ["weekly", "biweekly", "monthly", "yearly"].forEach(function (value) {
      cadence.appendChild(el("option", { value: value }, value));
    });
    form.appendChild(cadence);
    form.appendChild(el("input", { name: "next_on", type: "date", value: nextOn, "aria-label": "Prochaine date", required: "required" }));
    form.appendChild(el("button", { type: "submit" }, "Ajouter la récurrence"));
    return form;
  }

  function goalForm() {
    const form = el("form", { "data-form": "goal" });
    form.appendChild(el("input", { name: "name", "aria-label": "Nom de l'objectif", required: "required", maxlength: "120" }));
    form.appendChild(el("input", { name: "target", "aria-label": "Cible", required: "required", inputmode: "decimal" }));
    form.appendChild(el("input", { name: "saved", "aria-label": "Déjà épargné", value: "0", inputmode: "decimal" }));
    form.appendChild(el("button", { type: "submit" }, "Ajouter l'objectif"));
    return form;
  }

  function selectAccounts(session) {
    const select = el("select", { name: "account_id", "aria-label": "Compte", required: "required" });
    (session.summary.accounts || []).filter(function (account) { return account.currency === "CAD" && !account.archived; }).forEach(function (account) {
      select.appendChild(el("option", { value: account.id }, account.name));
    });
    return select;
  }

  function selectCategories(session) {
    const select = el("select", { name: "category_id", "aria-label": "Catégorie", required: "required" });
    session.categories.filter(function (category) { return !category.archived && category.kind !== "transfer"; }).forEach(function (category) {
      select.appendChild(el("option", { value: category.id }, category.name));
    });
    return select;
  }

  function onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const container = event.currentTarget;
    const session = sessions.get(container);
    if (!session) return;
    const action = button.getAttribute("data-action");
    if (action === "prev-month" || action === "next-month") {
      session.month = shiftMonth(session.month, action === "next-month" ? 1 : -1);
      session.message = "";
      refresh(container);
    } else if (action === "retry") {
      refresh(container);
    } else if (action === "show-correct") {
      const box = container.querySelector("#hq-budget-correct");
      box.hidden = false;
      box.querySelector("[name=correction_of]").value = button.getAttribute("data-id");
      box.querySelector("[name=amount]").focus();
    }
  }

  function onSubmit(event) {
    const form = event.target;
    if (!form || !form.getAttribute) return;
    const kind = form.getAttribute("data-form");
    if (!kind) return;
    event.preventDefault();
    const container = event.currentTarget;
    const session = sessions.get(container);
    if (!session) return;
    if (kind === "transaction") submitTransaction(session, form);
    else if (kind === "recurring") submitRecurring(session, form);
    else if (kind === "goal") submitGoal(session, form);
    else if (kind === "correct") submitCorrect(session, form);
  }

  async function submitTransaction(session, form) {
    const amount = parseCadToCents(form.amount.value);
    const booked = parseIso(form.booked_on.value);
    if (amount == null || !booked) {
      session.message = "Montant ou date invalide.";
      paint(session.container);
      return;
    }
    const result = await call(session, "POST", "/api/finances/transactions", {
      account_id: form.account_id.value,
      category_id: form.category_id.value,
      booked_on: booked,
      amount_cents: amount,
      payee: form.payee.value,
      status: "posted",
      idempotency_key: newKey("budget-tx"),
    });
    finishWrite(session, result, "Écriture ajoutée.");
  }

  async function submitRecurring(session, form) {
    const amount = parseCadToCents(form.amount.value);
    const nextOn = parseIso(form.next_on.value);
    if (amount == null || !nextOn) {
      session.message = "Récurrence invalide.";
      paint(session.container);
      return;
    }
    const result = await call(session, "POST", "/api/finances/recurring", {
      account_id: form.account_id.value,
      category_id: form.category_id.value,
      amount_cents: amount,
      currency: "CAD",
      cadence: form.cadence.value,
      next_on: nextOn,
      auto_post: false,
    });
    finishWrite(session, result, "Récurrence ajoutée, sans poste automatique.");
  }

  async function submitGoal(session, form) {
    const target = parseCadToCents(form.target.value);
    const saved = parseCadToCents(form.saved.value || "0");
    if (target == null || target < 0 || saved == null || saved < 0) {
      session.message = "Objectif invalide.";
      paint(session.container);
      return;
    }
    const result = await call(session, "POST", "/api/finances/goals", {
      name: form.name.value,
      target_cents: target,
      saved_cents: saved,
    });
    finishWrite(session, result, "Objectif ajouté.");
  }

  async function submitCorrect(session, form) {
    const amount = parseCadToCents(form.amount.value);
    if (amount == null || !form.reason.value.trim()) {
      session.message = "Correction invalide.";
      paint(session.container);
      return;
    }
    const result = await call(session, "POST", "/api/finances/transactions/correct", {
      correction_of: form.correction_of.value,
      amount_cents: amount,
      reason: form.reason.value.trim(),
      idempotency_key: newKey("budget-correct"),
    });
    finishWrite(session, result, "Correction enregistrée.");
  }

  function finishWrite(session, result, success) {
    if (!session.alive) return;
    if (result.status !== 200) {
      session.message = (result.body && result.body.error) || "Écriture refusée";
      paint(session.container);
      return;
    }
    session.message = success;
    refresh(session.container);
  }

  root.HqHouseholdBudget = {
    id: "budget",
    label: "Budget",
    mount: mount,
    unmount: unmount,
    pure: {
      parseIso: parseIso,
      monthBounds: monthBounds,
      shiftMonth: shiftMonth,
      formatCadCents: formatCadCents,
      formatMoney: formatMoney,
      accountCurrency: accountCurrency,
      parseCadToCents: parseCadToCents,
      monthTotals: monthTotals,
      transactionPath: transactionPath,
      takeTransactionPage: takeTransactionPage,
      foldTransactionPages: foldTransactionPages,
      envelopeRemaining: envelopeRemaining,
      cadBalance: cadBalance,
      otherCurrencies: otherCurrencies,
    },
  };
}(typeof globalThis !== "undefined" ? globalThis : this));
