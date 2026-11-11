/* Mounts the existing Meal Planner and Budget views from HQ navigation.
   The page still owns the buttons, history and view state. This file only
   attaches and detaches those two views, and it never creates Household storage.
*/
(function (root) {
  "use strict";

  var UNAVAILABLE = "Le foyer n'est pas activé. Aucune donnée n'a été créée.";
  var STORE_ABSENT = { "Base household absente": true, "foyer non initialisé": true };
  var VIEWS = { repas: "HqHouseholdMeals", budget: "HqHouseholdBudget" };
  var HOSTS = { repas: "hq-repas-app", budget: "hq-budget-app" };
  var unavailable = false;
  var historyInstalled = false;

  function isStoreAbsent(status, body) {
    if (!body || status !== 404) return false;
    if (body.code === "store_absent") return true;
    return body.code === "not_found" && STORE_ABSENT[body.error] === true;
  }

  function isHouseholdRead(path, method) {
    var value = String(path || "");
    return method === "GET" && (value.indexOf("/api/meals/") === 0 || value.indexOf("/api/finances/") === 0);
  }

  function host(name) {
    return document.getElementById(HOSTS[name]);
  }

  async function request(call) {
    var method = String((call && call.method) || "GET").toUpperCase();
    if (unavailable && method !== "GET") {
      return { status: 404, body: { ok: false, code: "not_found", error: UNAVAILABLE } };
    }
    var response = await fetch(call.path, {
      method: method,
      credentials: "same-origin",
      headers: call.body
        ? { "Content-Type": "application/json", "Accept": "application/json" }
        : { "Accept": "application/json" },
      body: call.body ? JSON.stringify(call.body) : undefined,
    });
    var body = {};
    try { body = await response.json(); } catch (_err) { body = {}; }
    if (isStoreAbsent(response.status, body)) {
      unavailable = true;
      body = { ok: false, code: "not_found", error: UNAVAILABLE };
    } else if (response.ok && isHouseholdRead(call.path, method)) {
      unavailable = false;
    }
    return { status: response.status, body: body };
  }

  function sync(view) {
    Object.keys(VIEWS).forEach(function (name) {
      var el = host(name);
      var api = root[VIEWS[name]];
      if (!el || !api || typeof api.unmount !== "function") return;
      if (name !== view) api.unmount(el);
    });
    var apiName = VIEWS[view];
    if (!apiName) return;
    var target = host(view);
    var api = root[apiName];
    if (!target || !api || typeof api.mount !== "function") return;
    api.mount(target, { request: request });
  }

  function noteNavigation(view, previous) {
    if (root.__hqHouseholdSilent) return;
    if (view === previous) return;
    if (view !== "repas" && view !== "budget" && previous !== "repas" && previous !== "budget") return;
    var next = "#" + view;
    if (String(location.hash || "") === next) return;
    history.pushState({ hqView: view }, "", next);
  }

  function installHistory(setView) {
    if (historyInstalled || typeof setView !== "function") return;
    historyInstalled = true;
    root.addEventListener("popstate", function () {
      var name = (location.hash || "").replace(/^#/, "").split("/")[0];
      root.__hqHouseholdSilent = true;
      try { setView(name || "accueil"); } finally { root.__hqHouseholdSilent = false; }
    });
  }

  root.hqHouseholdSync = sync;
  root.hqHouseholdRequest = request;
  root.hqHouseholdNoteNavigation = noteNavigation;
  root.hqHouseholdInstallHistory = installHistory;
  root.hqHouseholdUnavailableMessage = UNAVAILABLE;
  root.hqHouseholdIsStoreAbsent = isStoreAbsent;
}(typeof globalThis !== "undefined" ? globalThis : this));
