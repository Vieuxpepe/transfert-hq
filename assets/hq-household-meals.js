/* Transfert HQ — Meal Planner view.
   Mountable without shared navigation. The navigation agent registers the label "Repas".

   HqHouseholdMeals.mount(element, { request, today })
   HqHouseholdMeals.unmount(element)

   request({ method, path, body, credentials }) must resolve { status, body }.
   Writes are same-origin fetches so the bridge can check the Origin CSRF header.
   This view never deducts inventory, never posts a purchase, and never writes finances.
   Dietary restrictions have no meals API: the view says so instead of inventing one.
   Grocery quantities come from saved recipe qty_milli. Changing servings updates the recipe
   only after an explicit save. Stock availability is requested with subtract_available_stock;
   the API returns the quantity still to buy, not a separate available count.
*/
(function (root) {
  "use strict";

  const MEALS = [
    ["breakfast", "Déjeuner"],
    ["lunch", "Dîner"],
    ["dinner", "Souper"],
    ["snack", "Collation"],
  ];
  const DOW = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

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

  function addDays(iso, days) {
    const valid = parseIso(iso);
    if (!valid || !Number.isSafeInteger(days)) return null;
    const [year, month, day] = valid.split("-").map(Number);
    const utc = new Date(Date.UTC(year, month - 1, day + days));
    const y = utc.getUTCFullYear();
    const m = String(utc.getUTCMonth() + 1).padStart(2, "0");
    const d = String(utc.getUTCDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }

  function weekBounds(iso) {
    const valid = parseIso(iso);
    if (!valid) return null;
    const [year, month, day] = valid.split("-").map(Number);
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const start = addDays(valid, mondayOffset);
    return { start: start, end: addDays(start, 6), days: Array.from({ length: 7 }, function (_, i) { return addDays(start, i); }) };
  }

  function formatMilli(qty, unit) {
    if (!Number.isSafeInteger(qty)) return "";
    const sign = qty < 0 ? "-" : "";
    const abs = Math.abs(qty);
    const whole = Math.floor(abs / 1000);
    const frac = String(abs % 1000).padStart(3, "0").replace(/0+$/, "");
    return sign + whole + (frac ? "," + frac : "") + " " + (unit || "");
  }

  function slotMap(slots) {
    const map = new Map();
    (slots || []).forEach(function (slot) {
      if (slot && slot.date && slot.meal) map.set(slot.date + "|" + slot.meal, slot);
    });
    return map;
  }

  function groceryPreviewBody() {
    return { mode: "preview", subtract_available_stock: true };
  }

  function groceryCommitBody(digest, idempotencyKey) {
    return {
      mode: "commit",
      subtract_available_stock: true,
      preview_digest: digest,
      idempotency_key: idempotencyKey,
    };
  }

  function newIdempotencyKey(prefix) {
    const bytes = new Uint8Array(8);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    const hex = Array.from(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    return String(prefix || "meal") + "-" + hex;
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
    if (!container) throw new Error("meal mount requires an element");
    unmount(container);
    const session = {
      options: options || {},
      request: (options && options.request) || browserRequest,
      today: parseIso(options && options.today) || new Date().toISOString().slice(0, 10),
      week: null,
      recipes: [],
      plan: null,
      selected: null,
      preview: null,
      idempotencyKey: "",
      status: "loading",
      message: "",
      alive: true,
    };
    session.week = weekBounds(session.today);
    session.container = container;
    sessions.set(container, session);
    container.classList.add("hq-meals");
    container.setAttribute("data-hq-view", "repas");
    paint(container);
    refresh(container);
    container.addEventListener("click", onClick);
    return session;
  }

  function unmount(container) {
    const session = sessions.get(container);
    if (!session) return;
    session.alive = false;
    container.removeEventListener("click", onClick);
    sessions.delete(container);
    clear(container);
    container.classList.remove("hq-meals");
    container.removeAttribute("data-hq-view");
  }

  async function call(session, method, path, body) {
    const result = await session.request({
      method: method,
      path: path,
      body: body,
      credentials: "same-origin",
    });
    return result || { status: 0, body: {} };
  }

  async function refresh(container) {
    const session = sessions.get(container);
    if (!session) return;
    session.status = "loading";
    session.message = "";
    paint(container);
    try {
      const recipes = await call(session, "GET", "/api/meals/recipes");
      const plans = await call(session, "GET", "/api/meals/plans");
      if (!session.alive) return;
      if (recipes.status !== 200 || plans.status !== 200) {
        session.status = "error";
        session.message = (recipes.body && recipes.body.error) || (plans.body && plans.body.error) || "Les repas ne répondent pas.";
        paint(container);
        return;
      }
      session.recipes = (recipes.body && recipes.body.items) || [];
      const items = (plans.body && plans.body.items) || [];
      session.plan = items.find(function (plan) {
        return plan.period_start === session.week.start && plan.period_end === session.week.end;
      }) || null;
      if (session.selected) {
        const chosen = slotMap(session.plan && session.plan.slots).get(session.selected.date + "|" + session.selected.meal);
        session.selected.recipe = chosen && chosen.recipe_id ? recipeById(session, chosen.recipe_id) : null;
      }
      session.status = session.recipes.length || session.plan ? "ready" : "empty";
      paint(container);
    } catch (err) {
      if (!session.alive) return;
      session.status = "error";
      session.message = err && err.message ? err.message : "Erreur réseau";
      paint(container);
    }
  }

  function recipeById(session, id) {
    return session.recipes.find(function (recipe) { return recipe.id === id; }) || null;
  }

  function paint(container) {
    const session = sessions.get(container);
    if (!session) return;
    clear(container);
    container.setAttribute("data-state", session.status);
    container.setAttribute("aria-busy", session.status === "loading" ? "true" : "false");

    const bar = el("div", { class: "hq-meals-bar" });
    bar.appendChild(el("button", { type: "button", class: "hq-meals-step", "data-action": "prev-week", "aria-label": "Semaine précédente" }, "‹"));
    bar.appendChild(el("h2", { class: "hq-meals-title", id: "hq-meals-title" }, session.week.start + " — " + session.week.end));
    bar.appendChild(el("button", { type: "button", class: "hq-meals-step", "data-action": "next-week", "aria-label": "Semaine suivante" }, "›"));
    container.appendChild(bar);

    const note = el("p", { class: "hq-meals-note" }, "Les restrictions alimentaires ne sont pas exposées par l'API des repas.");
    container.appendChild(note);

    if (session.status === "loading") {
      container.appendChild(el("p", { class: "hq-meals-status", role: "status" }, "Chargement des repas…"));
      return;
    }
    if (session.status === "error") {
      container.appendChild(el("p", { class: "hq-meals-status", role: "alert" }, session.message));
      container.appendChild(el("button", { type: "button", "data-action": "retry" }, "Réessayer"));
      return;
    }

    if (!session.plan) {
      container.appendChild(el("p", { class: "hq-meals-status" }, "Aucun plan pour cette semaine."));
      container.appendChild(el("button", { type: "button", "data-action": "create-week" }, "Créer la semaine"));
    }

    const grid = el("div", { class: "hq-meals-grid", role: "grid", "aria-labelledby": "hq-meals-title" });
    grid.appendChild(el("div", { class: "hq-meals-corner" }, ""));
    session.week.days.forEach(function (day, index) {
      grid.appendChild(el("div", { class: "hq-meals-dow", role: "columnheader" }, DOW[index] + " " + day.slice(8)));
    });
    const slots = slotMap(session.plan && session.plan.slots);
    MEALS.forEach(function (meal) {
      grid.appendChild(el("div", { class: "hq-meals-meal", role: "rowheader" }, meal[1]));
      session.week.days.forEach(function (day) {
        const key = day + "|" + meal[0];
        const slot = slots.get(key);
        const recipe = slot && slot.recipe_id ? recipeById(session, slot.recipe_id) : null;
        const label = recipe ? recipe.title : "Vide";
        const button = el("button", {
          type: "button",
          class: "hq-meals-slot",
          role: "gridcell",
          "data-action": "open-slot",
          "data-date": day,
          "data-meal": meal[0],
          "aria-label": meal[1] + " " + day + (recipe ? ", " + recipe.title : ", vide"),
        }, label);
        grid.appendChild(button);
      });
    });
    container.appendChild(grid);

    if (session.recipes.length === 0) {
      container.appendChild(el("p", { class: "hq-meals-status" }, "Aucune recette enregistrée."));
    }

    const detail = el("section", { class: "hq-meals-detail", "aria-live": "polite" });
    if (session.selected) paintDetail(detail, session);
    else detail.appendChild(el("p", {}, "Choisissez un repas pour voir la recette, les ingrédients et les portions."));
    container.appendChild(detail);

    const grocery = el("section", { class: "hq-meals-grocery" });
    grocery.appendChild(el("h3", {}, "Liste d'épicerie"));
    grocery.appendChild(el("p", {}, "La génération ne déduit pas l'inventaire et n'enregistre ni achat ni dépense."));
    const preview = el("button", { type: "button", "data-action": "grocery-preview" }, "Préparer la liste");
    if (!session.plan) preview.disabled = true;
    grocery.appendChild(preview);
    if (session.preview) {
      (session.preview.lines || []).forEach(function (line) {
        grocery.appendChild(el("p", { class: "hq-meals-line" }, (line.name || "Ingrédient") + " — " + formatMilli(line.qty_milli, line.unit)));
      });
      if ((session.preview.lines || []).length === 0) grocery.appendChild(el("p", {}, "Rien à acheter."));
      grocery.appendChild(el("p", {}, "Le stock disponible a été soustrait. L'API ne renvoie pas le détail du stock, seulement la quantité à acheter."));
      grocery.appendChild(el("button", { type: "button", "data-action": "grocery-commit" }, "Enregistrer la liste d'épicerie"));
    }
    if (session.message && session.status === "ready") grocery.appendChild(el("p", { class: "hq-meals-status", role: "status" }, session.message));
    container.appendChild(grocery);
  }

  function paintDetail(detail, session) {
    const recipe = session.selected.recipe;
    detail.appendChild(el("h3", {}, recipe ? recipe.title : "Créneau vide"));
    detail.appendChild(el("p", {}, session.selected.date + " · " + (MEALS.find(function (meal) { return meal[0] === session.selected.meal; }) || ["", ""])[1]));
    if (!recipe) {
      detail.appendChild(el("p", {}, "Aucune recette dans ce créneau."));
    } else {
      detail.appendChild(el("p", {}, "Portions enregistrées : " + recipe.servings));
      (recipe.ingredients || []).forEach(function (ing) {
        detail.appendChild(el("p", {}, (ing.name || "") + " — " + formatMilli(ing.qty_milli, ing.unit)));
      });
      (recipe.steps || []).forEach(function (step, index) {
        detail.appendChild(el("p", {}, (index + 1) + ". " + step));
      });
      const form = el("form", { "data-action": "save-servings" });
      const input = el("input", { type: "number", min: "1", max: "100", step: "1", name: "servings", "aria-label": "Portions", value: String(recipe.servings) });
      form.appendChild(input);
      form.appendChild(el("button", { type: "submit" }, "Enregistrer les portions"));
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        saveServings(session, recipe, input.value);
      });
      detail.appendChild(form);
    }
    if (session.recipes.length) {
      const picker = el("label", {}, "Recette");
      const select = el("select", { "aria-label": "Choisir une recette" });
      select.appendChild(el("option", { value: "" }, "Aucune"));
      session.recipes.forEach(function (item) {
        const option = el("option", { value: item.id }, item.title);
        if (recipe && item.id === recipe.id) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener("change", function () { assignRecipe(session, select.value); });
      picker.appendChild(select);
      detail.appendChild(picker);
    }
  }

  function onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button || button.tagName === "FORM") return;
    const container = event.currentTarget;
    const session = sessions.get(container);
    if (!session) return;
    const action = button.getAttribute("data-action");
    if (action === "prev-week" || action === "next-week") {
      const start = addDays(session.week.start, action === "next-week" ? 7 : -7);
      session.week = weekBounds(start);
      session.preview = null;
      session.selected = null;
      refresh(container);
    } else if (action === "retry") {
      refresh(container);
    } else if (action === "create-week") {
      createWeek(container);
    } else if (action === "open-slot") {
      const date = button.getAttribute("data-date");
      const meal = button.getAttribute("data-meal");
      const slots = slotMap(session.plan && session.plan.slots);
      const slot = slots.get(date + "|" + meal);
      session.selected = {
        date: date,
        meal: meal,
        recipe: slot && slot.recipe_id ? recipeById(session, slot.recipe_id) : null,
      };
      session.status = "ready";
      paint(container);
    } else if (action === "grocery-preview") {
      previewGrocery(container);
    } else if (action === "grocery-commit") {
      commitGrocery(container);
    }
  }

  async function createWeek(container) {
    const session = sessions.get(container);
    const result = await call(session, "POST", "/api/meals/plans", {
      period_start: session.week.start,
      period_end: session.week.end,
      slots: [],
    });
    if (!session.alive) return;
    if (result.status !== 200) {
      session.status = "error";
      session.message = (result.body && result.body.error) || "Création refusée";
      paint(container);
      return;
    }
    session.message = "Semaine créée.";
    refresh(container);
  }

  async function assignRecipe(session, recipeId) {
    const container = findContainer(session);
    if (!container || !session.plan) return;
    const slots = (session.plan.slots || []).filter(function (slot) {
      return !(slot.date === session.selected.date && slot.meal === session.selected.meal);
    });
    if (recipeId) slots.push({ date: session.selected.date, meal: session.selected.meal, recipe_id: recipeId, notes: null });
    const result = await call(session, "POST", "/api/meals/plans", {
      id: session.plan.id,
      rev: session.plan.rev,
      slots: slots,
    });
    if (!session.alive) return;
    if (result.status !== 200) {
      session.message = (result.body && result.body.error) || "Enregistrement refusé";
      paint(container);
      return;
    }
    session.message = "Repas enregistré.";
    session.preview = null;
    refresh(container);
  }

  async function saveServings(session, recipe, raw) {
    const container = findContainer(session);
    const servings = Number(raw);
    if (!Number.isSafeInteger(servings) || servings < 1 || servings > 100) {
      session.message = "Portions invalides.";
      if (container) paint(container);
      return;
    }
    const result = await call(session, "POST", "/api/meals/recipes", {
      id: recipe.id,
      rev: recipe.rev,
      servings: servings,
    });
    if (!session.alive) return;
    session.message = result.status === 200 ? "Portions enregistrées." : ((result.body && result.body.error) || "Portions refusées");
    session.preview = null;
    if (container) refresh(container);
  }

  async function previewGrocery(container) {
    const session = sessions.get(container);
    if (!session.plan) return;
    const result = await call(session, "POST", "/api/meals/plans/" + encodeURIComponent(session.plan.id) + "/build-list", groceryPreviewBody());
    if (!session.alive) return;
    if (result.status !== 200) {
      session.message = (result.body && result.body.error) || "Aperçu refusé";
      paint(container);
      return;
    }
    session.preview = result.body;
    session.idempotencyKey = newIdempotencyKey("meal-list");
    session.message = "Aperçu prêt. Rien n'est encore enregistré.";
    session.status = "ready";
    paint(container);
  }

  async function commitGrocery(container) {
    const session = sessions.get(container);
    if (!session.plan || !session.preview || !session.preview.preview_digest) return;
    const result = await call(
      session,
      "POST",
      "/api/meals/plans/" + encodeURIComponent(session.plan.id) + "/build-list",
      groceryCommitBody(session.preview.preview_digest, session.idempotencyKey),
    );
    if (!session.alive) return;
    session.message = result.status === 200 ? "Liste d'épicerie enregistrée." : ((result.body && result.body.error) || "Enregistrement refusé");
    paint(container);
  }

  function findContainer(session) {
    return session && session.container ? session.container : null;
  }

  root.HqHouseholdMeals = {
    id: "repas",
    label: "Repas",
    mount: mount,
    unmount: unmount,
    pure: {
      parseIso: parseIso,
      addDays: addDays,
      weekBounds: weekBounds,
      formatMilli: formatMilli,
      groceryPreviewBody: groceryPreviewBody,
      groceryCommitBody: groceryCommitBody,
      slotMap: slotMap,
    },
  };
}(typeof globalThis !== "undefined" ? globalThis : this));
