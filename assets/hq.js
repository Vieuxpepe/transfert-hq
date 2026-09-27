/* Transfert HQ v7 Mission Control UI. Uses globals from the inline app: api, toast, escapeHtml, navigate, setView. */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const STATE_LABEL = { ok: "OK", warning: "Attention", critical: "Critique" };

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
      if (sub) {
        const n = (snap.attention || []).length;
        sub.textContent = n ? n + " point(s) demandent attention" : "Rien à signaler";
      }
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
              await api("/api/scene", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: btn.dataset.quickScene }),
              });
              if (typeof toast === "function") toast("Scène lancée");
            } catch (e) {
              if (typeof toast === "function") toast(e.message, "err");
            }
          });
        });
      }
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
        : '<li class="hint">Journal vide</li>';
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
    if (!id || typeof api !== "function") return;
    const dlg = $("#hq-device-dialog");
    const body = $("#hq-device-body");
    const title = $("#hq-device-title");
    if (!dlg || !body) return;
    let data;
    try {
      data = await api("/api/device?id=" + encodeURIComponent(id));
    } catch (e) {
      if (typeof toast === "function") toast(e.message, "err");
      return;
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
    body.querySelectorAll("[data-dev-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const act = btn.dataset.devAct;
        try {
          if (act === "lock") {
            if (!confirm("Verrouiller le PC ?")) return;
            await api("/api/pc/lock", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          } else if (act === "sleep") {
            if (!confirm("Mettre le PC en veille ?")) return;
            await api("/api/pc/sleep", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          } else if (act === "shot") {
            await api("/api/pc/screenshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          }
          if (typeof toast === "function") toast("OK");
        } catch (e) {
          if (typeof toast === "function") toast(e.message, "err");
        }
      });
    });
    if (typeof dlg.showModal === "function") dlg.showModal();
  }

  let paletteHits = [];
  let paletteIndex = 0;

  function renderPalette() {
    const list = $("#hq-palette-list");
    if (!list) return;
    list.innerHTML = paletteHits.length
      ? paletteHits
          .map(
            (hit, i) =>
              `<li data-i="${i}" class="${i === paletteIndex ? "active" : ""}"><span>${esc(hit.label || hit.id)}</span><span class="palette-kind">${esc(hit.hint || hit.kind || "")}</span></li>`
          )
          .join("")
      : '<li class="hint">Aucun résultat</li>';
    list.querySelectorAll("li[data-i]").forEach((li) => {
      li.addEventListener("click", () => runPalette(paletteHits[Number(li.dataset.i)]));
    });
  }

  async function queryPalette(q) {
    if (typeof api !== "function") return;
    const data = await api("/api/palette?q=" + encodeURIComponent(q || "") + "&limit=20");
    paletteHits = data.hits || [];
    paletteIndex = 0;
    renderPalette();
  }

  async function runPalette(hit) {
    if (!hit) return;
    closePalette();
    if (hit.kind === "folder" || hit.kind === "favorite") {
      if (typeof navigate === "function") navigate(hit.id);
      else if (typeof setView === "function") setView("fichiers");
      return;
    }
    if (hit.kind === "device") {
      openDevice(hit.id);
      return;
    }
    if (hit.kind === "scene") {
      if (!confirm("Lancer la scène « " + (hit.label || hit.id) + " » ?")) return;
      await api("/api/scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hit.id }),
      });
      if (typeof toast === "function") toast("Scène lancée");
      return;
    }
    if (hit.kind === "action") {
      if (!confirm("Lancer « " + (hit.label || hit.id) + " » sur le PC ?")) return;
      await api("/api/pc/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hit.id }),
      });
      if (typeof toast === "function") toast("Action lancée");
      return;
    }
    if (hit.kind === "terminal") {
      if (!confirm("Exécuter la commande allowlist « " + (hit.label || hit.id) + " » ?")) return;
      const data = await api("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: hit.id }),
      });
      const out = $("#shell-out");
      if (out) out.textContent = (data.stdout || "") + (data.stderr || "");
      if (typeof setView === "function") setView("ops");
      if (typeof toast === "function") toast(data.ok ? "Commande terminée" : "Commande en erreur");
    }
  }

  function openPalette() {
    const box = $("#hq-palette");
    if (!box) return;
    box.hidden = false;
    const input = $("#hq-palette-input");
    if (input) {
      input.value = "";
      input.focus();
    }
    queryPalette("").catch(() => {});
  }

  function closePalette() {
    const box = $("#hq-palette");
    if (box) box.hidden = true;
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
                      `<button type="button" class="secondary" data-restore="${esc(b.id)}" data-folder="${folder}">Restaurer ${folder}</button>`
                  )
                  .join("") +
                `</div></li>`
            )
            .join("")
        : '<li class="hint">Aucune sauvegarde cataloguée</li>';
      el.querySelectorAll("[data-restore]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const folder = btn.dataset.folder;
          if (!confirm("Écraser " + folder + " avec le backup " + btn.dataset.restore + " ?")) return;
          try {
            const res = await api("/api/backup/restore", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: btn.dataset.restore, folder, confirm: true }),
            });
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
        : '<li class="hint">Aucune règle</li>';
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
          await api("/api/upload", { method: "POST", body: fd, timeoutMs: 60000 });
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

  function boot() {
    $("#btn-palette")?.addEventListener("click", () => openPalette());
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
        ev.preventDefault();
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
      devices.addEventListener("click", (ev) => {
        const card = ev.target && ev.target.closest ? ev.target.closest("[data-device-id]") : null;
        if (card && card.dataset.deviceId) openDevice(card.dataset.deviceId);
      });
    }
    setupRuleForm();
    setupScheduleForm();
    setupVoice();
    setupPush();
    loadSnapshot();
    loadEvents();
    loadBrief();
    loadBackups();
    loadRules();
    loadHostSpark();
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
