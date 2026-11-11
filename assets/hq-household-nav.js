/* Mounts the existing Meal Planner and Budget views from HQ navigation.
   The page still owns the buttons, history and view state. This file only
   attaches and detaches those two views, and it never creates Household storage.
*/
(function (root) {
  "use strict";

  var UNAVAILABLE = "Le foyer n'est pas activé. Aucune donnée n'a été créée.";
  var VIEWS = { repas: "HqHouseholdMeals", budget: "HqHouseholdBudget" };
  var HOSTS = { repas: "hq-repas-app", budget: "hq-budget-app" };
  var unavailable = false;
  var historyInstalled = false;

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
    if (response.status === 404 && body && body.code === "not_found") {
      unavailable = true;
      body = { ok: false, code: "not_found", error: UNAVAILABLE };
    } else if (response.ok && method === "GET") {
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
}(typeof globalThis !== "undefined" ? globalThis : this));
