/* Mini-Quêtes UI — lives under Plus / Système (no new primary nav tab).
 * Talks to /api/mini-quests/* only. Plain ES2020, no HTML string injection of API text into tags.
 * Active simmer job id survives Plus view reloads so polling continues across setView.
 */
(function (root) {
  "use strict";

  var STATE_LABEL = {
    available: "Disponible",
    running: "En cours",
    done: "Terminé",
    refused: "Refusé",
    error: "Erreur",
  };

  var rootEl = null;
  var statusEl = null;
  var resultEl = null;
  var pollTimer = null;
  var busy = false;
  var activeJobId = null;
  var loadGen = 0;

  function apiFn() {
    return typeof root.api === "function" ? root.api : null;
  }

  function setState(state) {
    if (!rootEl) return;
    var next = STATE_LABEL[state] ? state : "available";
    rootEl.setAttribute("data-mq-state", next);
    if (statusEl) {
      statusEl.textContent = STATE_LABEL[next];
    }
  }

  function setResult(text) {
    if (!resultEl) return;
    if (!text) {
      resultEl.hidden = true;
      resultEl.textContent = "";
      return;
    }
    resultEl.hidden = false;
    resultEl.textContent = text;
  }

  function mapHttpState(status, payload) {
    if (status === 401 || status === 403 || status === 429) return "refused";
    if (status >= 400) return "error";
    if (payload && payload.status === "running") return "running";
    if (payload && payload.status === "done") return "done";
    if (payload && payload.job && payload.job.status === "running") return "running";
    if (payload && payload.job && payload.job.status === "done") return "done";
    if (payload && payload.job && payload.job.status === "error") return "error";
    return "done";
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function clearActiveJob() {
    activeJobId = null;
  }

  function summarize(payload) {
    if (!payload || typeof payload !== "object") return "";
    if (payload.note) return String(payload.note);
    if (payload.job && payload.job.result && payload.job.result.message) {
      return String(payload.job.result.message);
    }
    if (payload.message) return String(payload.message);
    if (payload.error) return String(payload.error);
    if (payload.quest === "pulse" && payload.beat != null) {
      return "Pulse synthétique · beat " + payload.beat + " · simulated=" + String(!!payload.simulated);
    }
    if (payload.quest === "gear_whisper") return "Whisper enregistré (journal borné).";
    if (payload.job && payload.job.id) return "Tâche " + payload.job.id + " · " + (payload.job.status || "");
    return "OK";
  }

  function findRunningSimmer(catalog) {
    if (!catalog || !Array.isArray(catalog.jobs)) return null;
    var found = null;
    catalog.jobs.forEach(function (j) {
      if (j && j.quest === "simmer" && j.status === "running" && j.id) found = j.id;
    });
    return found;
  }

  function startPolling(jobId) {
    if (!jobId) return;
    activeJobId = jobId;
    busy = true;
    stopPoll();
    setState("running");
    setResult("Simmer en cours…");
    pollTimer = setInterval(function () {
      pollJob(jobId);
    }, 400);
    pollJob(jobId);
  }

  async function pollJob(jobId) {
    var api = apiFn();
    if (!api || !jobId) return;
    if (activeJobId && jobId !== activeJobId) return;
    try {
      var data = await api("/api/mini-quests/jobs/" + encodeURIComponent(jobId), { timeoutMs: 8000 });
      var st = (data && data.job && data.job.status) || "running";
      if (st === "running") {
        setState("running");
        setResult("Simmer en cours…");
        return;
      }
      stopPoll();
      busy = false;
      clearActiveJob();
      setState(st === "done" ? "done" : "error");
      setResult(summarize(data));
    } catch (err) {
      stopPoll();
      busy = false;
      clearActiveJob();
      setState("error");
      setResult((err && err.message) || "Erreur de suivi");
    }
  }

  async function runQuest(questId) {
    if (busy) return;
    var api = apiFn();
    if (!api) {
      setState("error");
      setResult("API indisponible");
      return;
    }
    var path =
      questId === "simmer"
        ? "/api/mini-quests/simmer"
        : questId === "pulse"
          ? "/api/mini-quests/pulse"
          : questId === "gear_whisper"
            ? "/api/mini-quests/whisper"
            : null;
    if (!path) return;

    busy = true;
    stopPoll();
    clearActiveJob();
    setState("running");
    setResult("Démarrage…");
    try {
      var body = questId === "gear_whisper" ? { context: "hq-ui" } : {};
      var data = await api(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 12000,
      });
      var state = mapHttpState(200, data);
      if (questId === "simmer" && data && data.job && data.job.id && data.status === "running") {
        setResult("Simmer lancé · suivi…");
        startPolling(data.job.id);
        return;
      }
      busy = false;
      setState(state);
      setResult(summarize(data));
    } catch (err) {
      busy = false;
      clearActiveJob();
      var msg = (err && err.message) || "Échec";
      var code = err && (err.status || err.code);
      if (code === 401 || code === 403 || code === 429) setState("refused");
      else setState("error");
      setResult(msg);
    }
  }

  function build(catalog) {
    if (!rootEl) return;
    while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);

    var banner = document.createElement("p");
    banner.className = "mq-banner";
    banner.textContent =
      (catalog && catalog.note) ||
      "Toutes les Mini-Quêtes sont simulées. Aucune mesure matérielle ou biologique.";
    rootEl.appendChild(banner);

    var row = document.createElement("div");
    row.className = "mq-status";
    var dot = document.createElement("span");
    dot.className = "mq-dot";
    dot.setAttribute("aria-hidden", "true");
    statusEl = document.createElement("span");
    statusEl.id = "mq-status-label";
    statusEl.textContent = STATE_LABEL.available;
    row.appendChild(dot);
    row.appendChild(statusEl);
    rootEl.appendChild(row);

    var list = document.createElement("ul");
    list.className = "mq-list";
    list.setAttribute("aria-label", "Mini-Quêtes disponibles");

    var quests = (catalog && catalog.quests) || [
      { id: "simmer", label: "Simmer", summary: "Échauffement borné." },
      { id: "pulse", label: "Pulse", summary: "Lecture synthétique." },
      { id: "gear_whisper", label: "Gear whisper", summary: "Note de journal." },
    ];

    quests.forEach(function (q) {
      var li = document.createElement("li");
      li.className = "mq-item";

      var copy = document.createElement("div");
      copy.className = "mq-copy";
      var title = document.createElement("strong");
      title.textContent = q.label || q.id;
      var summary = document.createElement("p");
      summary.textContent = q.summary || "";
      copy.appendChild(title);
      copy.appendChild(summary);

      var actions = document.createElement("div");
      actions.className = "mq-actions";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "secondary";
      btn.textContent = "Lancer";
      btn.setAttribute("aria-label", "Lancer " + (q.label || q.id));
      btn.addEventListener("click", function () {
        runQuest(q.id);
      });
      actions.appendChild(btn);

      li.appendChild(copy);
      li.appendChild(actions);
      list.appendChild(li);
    });

    rootEl.appendChild(list);

    resultEl = document.createElement("p");
    resultEl.className = "mq-result";
    resultEl.id = "mq-result";
    resultEl.hidden = true;
    rootEl.appendChild(resultEl);
  }

  function restoreActive(catalog) {
    var jobId = activeJobId || findRunningSimmer(catalog);
    if (jobId) {
      startPolling(jobId);
      return;
    }
    setState("available");
  }

  async function load() {
    rootEl = document.getElementById("hq-mini-quests");
    if (!rootEl) return;
    var gen = ++loadGen;
    var api = apiFn();
    if (!api) {
      build(null);
      if (gen !== loadGen) return;
      setState("error");
      setResult("API indisponible");
      return;
    }
    try {
      var data = await api("/api/mini-quests/", { timeoutMs: 8000 });
      if (gen !== loadGen) return;
      build(data);
      restoreActive(data);
    } catch (err) {
      if (gen !== loadGen) return;
      build(null);
      if (activeJobId) {
        // Keep tracking a simmer even if catalog reload failed.
        restoreActive(null);
        return;
      }
      var code = err && (err.status || err.code);
      if (code === 401 || code === 403) setState("refused");
      else setState("error");
      setResult((err && err.message) || "Chargement impossible");
    }
  }

  function onView() {
    if (document.body && document.body.dataset && document.body.dataset.view === "plus") {
      load();
    }
  }

  function start() {
    if (!document.getElementById("hq-mini-quests")) return;
    load();
    document.addEventListener("hq:view", onView);
    // Fallback: Plus jump / setView may not always dispatch hq:view on older builds.
    var lastView = document.body ? document.body.dataset.view : "";
    var obs = new MutationObserver(function () {
      var view = document.body ? document.body.dataset.view : "";
      if (view === "plus" && view !== lastView) onView();
      lastView = view;
    });
    if (document.body) {
      obs.observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
    }
  }

  root.HqMiniQuests = {
    start: start,
    load: load,
    runQuest: runQuest,
    // Test/debug hooks: active simmer survives panel rebuilds.
    getActiveJobId: function () {
      return activeJobId;
    },
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
