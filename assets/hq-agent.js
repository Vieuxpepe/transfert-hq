/* Centre agents — fiche appareil et approbations. Pas de terminal libre. */
(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);

  function esc(value) {
    if (typeof escapeHtml === "function") return escapeHtml(value);
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  const RISK = { read: "lecture", safe: "sûr", sensitive: "sensible", destructive: "destructeur" };
  const STATE = {
    queued: "en file",
    awaiting_approval: "à approuver",
    dispatched: "envoyé",
    succeeded: "réussi",
    failed: "échoué",
    cancelled: "annulé",
    expired: "expiré",
    rejected: "refusé",
  };

  function post(action, extra) {
    return api("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ action: action }, extra || {})),
    });
  }

  function agentIdOf(device) {
    if (!device) return "";
    if (device.agent_id) return String(device.agent_id);
    if (device.source === "agent") return String(device.id || "");
    return "";
  }

  function phoneCopy(device) {
    const os = String((device && device.os) || "").toLowerCase();
    const access = (device && device.access) || [];
    if (/ios|ipad|iphone/.test(os)) {
      return "Cet iPhone reste un client navigateur. Aucun companion, aucun contrôle distant.";
    }
    if (/android/.test(os) && access.indexOf("agent") < 0) {
      return "Cet appareil mobile reste un client navigateur. Aucun companion.";
    }
    if (access.indexOf("agent") >= 0) return "";
    if (access.indexOf("ssh") >= 0) return "Accès SSH conservé. Pas encore de companion HQ sur cet appareil.";
    if (access.indexOf("local") >= 0 && access.indexOf("agent") < 0) {
      return "Ce PC est le pont. Les actions locales restent ici ; un companion sert aux autres ordinateurs.";
    }
    if (access.length === 1 && access[0] === "browser") {
      return "Client navigateur seulement. Pas de companion.";
    }
    return "";
  }

  function jobRow(job) {
    const risk = RISK[job.risk] || job.risk || "";
    const state = STATE[job.state] || job.state || "";
    const klass = job.risk === "destructive" ? "risk-destructive" : "";
    let buttons = "";
    if (job.state === "awaiting_approval") {
      buttons =
        `<button type="button" data-agent-approve="${esc(job.id)}">Approuver</button>` +
        `<button type="button" class="secondary" data-agent-reject="${esc(job.id)}">Refuser</button>`;
    } else if (job.state === "queued" || job.state === "dispatched") {
      buttons = `<button type="button" class="secondary" data-agent-cancel="${esc(job.id)}">Annuler</button>`;
    }
    const artifact = job.artifact && job.artifact.rel ? `<div class="meta">Fichier · ${esc(job.artifact.rel)}</div>` : "";
    return (
      `<div class="job-row">` +
      `<strong class="${klass}">${esc(job.op || "")}</strong>` +
      `<div class="meta">${esc(state)} · ${esc(risk)} · ${esc(job.origin || "")}</div>` +
      (job.summary ? `<div class="meta">${esc(job.summary)}</div>` : "") +
      (job.error ? `<div class="meta">${esc(job.error)}</div>` : "") +
      artifact +
      `<div class="row hq-actions">${buttons}</div>` +
      `</div>`
    );
  }

  function bindJobButtons(root, rerender) {
    root.querySelectorAll("[data-agent-approve]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await post("approve", { id: btn.getAttribute("data-agent-approve") });
          if (typeof toast === "function") toast("Approuvé");
          await rerender();
        } catch (err) {
          if (typeof toast === "function") toast(err.message, "err");
        }
      });
    });
    root.querySelectorAll("[data-agent-reject]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await post("reject", { id: btn.getAttribute("data-agent-reject") });
          await rerender();
        } catch (err) {
          if (typeof toast === "function") toast(err.message, "err");
        }
      });
    });
    root.querySelectorAll("[data-agent-cancel]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await post("cancel", { id: btn.getAttribute("data-agent-cancel") });
          await rerender();
        } catch (err) {
          if (typeof toast === "function") toast(err.message, "err");
        }
      });
    });
  }

  async function loadJobs(id) {
    const data = await api("/api/agent/jobs?device=" + encodeURIComponent(id) + "&limit=30");
    return data.jobs || [];
  }

  function paintJobs(host, jobs, rerender) {
    host.innerHTML = jobs.length ? jobs.map(jobRow).join("") : '<p class="hint">Aucun travail.</p>';
    bindJobButtons(host, rerender);
  }

  window.hqPaintDeviceAgent = function (host, device) {
    if (!host) return;
    const note = phoneCopy(device);
    const id = agentIdOf(device);
    const caps = (device && device.agent_capabilities) || [];
    if (!id) {
      host.innerHTML = note ? `<p class="hint">${esc(note)}</p>` : "";
      return;
    }
    let actions = "";
    if (caps.indexOf("status") >= 0) actions += `<button type="button" class="secondary" data-agent-op="system.status">État</button>`;
    if (caps.indexOf("files_list") >= 0) actions += `<button type="button" class="secondary" data-agent-op="fs.list">Lister</button>`;
    if (caps.indexOf("screenshot") >= 0) actions += `<button type="button" class="secondary" data-agent-op="screenshot.capture">Capture distante</button>`;
    if (caps.indexOf("power_lock") >= 0) actions += `<button type="button" class="secondary" data-agent-op="power.lock">Verrouiller</button>`;
    if (caps.indexOf("power_sleep") >= 0) actions += `<button type="button" class="secondary" data-agent-op="power.sleep">Veille</button>`;
    if (caps.indexOf("power_restart") >= 0) actions += `<button type="button" class="danger-outline" data-agent-op="power.restart">Demander un redémarrage</button>`;
    if (caps.indexOf("power_shutdown") >= 0) actions += `<button type="button" class="danger-outline" data-agent-op="power.shutdown">Demander un arrêt</button>`;

    host.innerHTML =
      `<div class="agent-tabs" role="tablist">` +
      `<button type="button" class="chip active" data-agent-tab="caps">Capacités</button>` +
      `<button type="button" class="chip" data-agent-tab="jobs">Travaux</button>` +
      `<button type="button" class="chip" data-agent-tab="approve">Approbations</button>` +
      `</div>` +
      `<div data-agent-panel="caps"><div class="cap-row">${caps.map((cap) => `<span class="cap">${esc(cap)}</span>`).join("") || '<span class="hint">Aucune capacité accordée.</span>'}</div>` +
      `<div class="row hq-actions" style="margin-top:8px">${actions}</div>` +
      `<p class="hint">Le terminal interactif reste désactivé. SSH, s'il est proposé, est un accès séparé.</p></div>` +
      `<div data-agent-panel="jobs" hidden></div>` +
      `<div data-agent-panel="approve" hidden></div>`;

    async function show(tab) {
      host.querySelectorAll("[data-agent-tab]").forEach((btn) => {
        const on = btn.getAttribute("data-agent-tab") === tab;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
      });
      host.querySelectorAll("[data-agent-panel]").forEach((panel) => {
        panel.hidden = panel.getAttribute("data-agent-panel") !== tab;
      });
      if (tab === "caps") return;
      const panel = host.querySelector(`[data-agent-panel="${tab}"]`);
      try {
        const jobs = await loadJobs(id);
        const rows = tab === "approve" ? jobs.filter((job) => job.state === "awaiting_approval") : jobs;
        paintJobs(panel, rows, () => show(tab));
      } catch (err) {
        panel.innerHTML = `<p class="hint">${esc(err.message || "Travaux indisponibles")}</p>`;
      }
    }

    host.querySelectorAll("[data-agent-tab]").forEach((btn) => {
      btn.addEventListener("click", () => show(btn.getAttribute("data-agent-tab")));
    });
    host.querySelectorAll("[data-agent-op]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const op = btn.getAttribute("data-agent-op");
        if ((op === "power.lock" || op === "power.sleep") && !confirm("Envoyer cette action au companion ?")) return;
        if ((op === "power.restart" || op === "power.shutdown") && !confirm("Créer une demande ? Un humain devra encore l'approuver.")) return;
        try {
          const busy = typeof withBusy === "function" ? withBusy : async (_label, fn) => fn();
          const data = await busy("Envoi…", () => post("job", { device_id: id, op: op, args: op === "fs.list" ? { path: "", depth: 1 } : {} }));
          const state = data.job && data.job.state;
          if (typeof toast === "function") toast(state === "awaiting_approval" ? "En attente d'approbation" : "Travail en file");
          await show(state === "awaiting_approval" ? "approve" : "jobs");
        } catch (err) {
          if (typeof toast === "function") toast(err.message, "err");
        }
      });
    });
    if (note) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = note;
      host.prepend(hint);
    }
  };

  window.hqPaintAgentBadge = function (agent) {
    const btn = $("#btn-agent-center");
    if (!btn) return;
    const pending = Number((agent && agent.pending_approvals) || 0);
    btn.textContent = pending > 0 ? "Centre agents (" + pending + ")" : "Centre agents";
  };

  async function openCenter() {
    const dlg = $("#hq-agent-dialog");
    const body = $("#hq-agent-body");
    if (!dlg || !body || typeof api !== "function") return;
    body.innerHTML = '<p class="hint">Chargement…</p>';
    if (typeof dlg.showModal === "function" && !dlg.open) dlg.showModal();
    if (dlg._hqRelease) dlg._hqRelease();
    if (window.hqTrapFocus) dlg._hqRelease = window.hqTrapFocus(dlg);
    const opener = document.activeElement;
    dlg.addEventListener("close", () => {
      if (dlg._hqRelease) dlg._hqRelease();
      dlg._hqRelease = null;
      if (opener && opener.focus && document.contains(opener)) opener.focus();
    }, { once: true });
    try {
      const data = await api("/api/agent");
      const jobs = await api("/api/agent/jobs?state=awaiting_approval&limit=20");
      const devices = data.devices || [];
      const pending = (jobs.jobs || []).map(jobRow).join("") || '<p class="hint">Rien à approuver.</p>';
      const rows = devices.length
        ? devices.map((device) => {
            const flag = device.revoked ? "révoqué" : (device.online ? "en ligne" : "hors ligne");
            const revoke = device.revoked ? "" : `<button type="button" class="danger-outline" data-agent-revoke="${esc(device.id)}">Révoquer</button>`;
            return `<div class="job-row"><strong>${esc(device.name || device.id)}</strong><div class="meta">${esc(flag)} · ${esc(device.os || "")}</div><div class="row">${revoke}</div></div>`;
          }).join("")
        : '<p class="hint">Aucun companion enrôlé.</p>';
      body.innerHTML =
        `<p class="hint">Les companions appellent ce pont en HTTPS (Tailscale). Les iPhone ne s'enrôlent pas.</p>` +
        `<div class="row hq-actions"><button type="button" id="btn-agent-token">Créer un jeton</button></div>` +
        `<p id="hq-agent-token" class="token-once" hidden></p>` +
        `<h3>À approuver</h3><div id="hq-agent-pending">${pending}</div>` +
        `<h3>Companions</h3><div id="hq-agent-devices">${rows}</div>`;
      bindJobButtons($("#hq-agent-pending"), openCenter);
      const tokenBtn = $("#btn-agent-token", body);
      if (tokenBtn) {
        tokenBtn.addEventListener("click", async () => {
          try {
            const created = await post("enroll-token", { label: "companion" });
            const slot = $("#hq-agent-token", body);
            if (slot) {
              slot.hidden = false;
              slot.textContent = "Jeton (une seule fois) : " + (created.token || "");
            }
          } catch (err) {
            if (typeof toast === "function") toast(err.message, "err");
          }
        });
      }
      body.querySelectorAll("[data-agent-revoke]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Révoquer ce companion ? Les travaux en attente seront annulés.")) return;
          try {
            await post("revoke", { device_id: btn.getAttribute("data-agent-revoke") });
            if (typeof toast === "function") toast("Companion révoqué");
            await openCenter();
          } catch (err) {
            if (typeof toast === "function") toast(err.message, "err");
          }
        });
      });
      const closeBtn = dlg.querySelector('button[value="cancel"]');
      if (closeBtn) closeBtn.focus();
    } catch (err) {
      body.textContent = err.message || "Centre indisponible";
    }
  }

  const center = $("#btn-agent-center");
  if (center) center.addEventListener("click", () => { openCenter(); });
})();
