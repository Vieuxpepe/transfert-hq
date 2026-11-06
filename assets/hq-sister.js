/* Transfert HQ — Else ↔ Transferania sister stage director (shared bus + queue). */
(function (root) {
  "use strict";

  const LS_AMBIENT = "hq_else_sister_ambient_v1";
  const LS_REACT = "hq_else_sister_react_v1";
  const EV_LINE = "hq-sister-line";
  const EV_OPEN = "hq-sister-open";
  const EV_BUSY = "hq-sister-busy";
  const EV_PEEK = "hq-sister-peek";
  const EV_EVENT = "hq-sister-event";
  const EV_NUDGE = "hq-sister-nudge";
  const EV_T_LINE = "hq-transferania-line";
  const EV_ELSE_LINE = "hq-else-line";
  const EV_PREFS = "hq-sister-prefs";
  const EV_HISTORY = "hq-sister-history";
  const MSG_CAP = 40;
  const REACT_DELAY_MS = 1400;
  const PASS_BALL_DELAY_MS = 1700;
  const PASS_BALL_PCT = 4; // of 10

  function shouldAppendSisterRow(rows, speaker, text) {
    if (!speaker || speaker === "seed" || !text) return false;
    const list = Array.isArray(rows) ? rows : [];
    for (let i = list.length - 1; i >= Math.max(0, list.length - 6); i -= 1) {
      const m = list[i];
      if (m && m.speaker === speaker && String(m.text) === String(text)) return false;
    }
    return true;
  }

  function stripRows(messages, limit) {
    const lim = Math.max(1, Number(limit) || 6);
    return (Array.isArray(messages) ? messages : [])
      .filter((m) => m && m.speaker && m.speaker !== "seed" && m.text)
      .slice(-lim);
  }

  function labelSpeaker(speaker) {
    if (speaker === "else") return "Else";
    if (speaker === "transferania") return "Transferania";
    if (speaker === "master") return "Maître";
    return String(speaker || "");
  }

  /** Client-side gate mirroring server intent (idle addressable ambient). */
  function clientMayReactToAmbient(detail) {
    const d = detail || {};
    if (d.sister_cue !== true) return false;
    if (d.fallback === true) return false;
    if (d.nsfw === true) return false;
    const text = String(d.text || d.line || "").trim();
    return text.length >= 12;
  }

  /** Soft gate for Else Master-chat → Transferania react (sisterly mention or rare). */
  function clientMayReactToElse(detail) {
    const d = detail || {};
    if (d.fallback === true) return false;
    if (d.nsfw === true) return false;
    const text = String(d.text || d.line || "").trim();
    if (text.length < 12) return false;
    if (d.sister_cue === true) return true;
    return /else|sœur|soeur|transferania|transferina|sister/i.test(text)
      ? true
      : ((Date.now() / 17 | 0) % 20 === 0);
  }

  function clientShouldPassBall(detail) {
    const d = detail || {};
    if (!d.ambient) return false;
    const turns = Array.isArray(d.turns) ? d.turns : [];
    if (!turns.length) return false;
    const boost = d.event ? 2 : 0;
    return ((Date.now() / 37 | 0) % 10) < Math.min(7, PASS_BALL_PCT + boost);
  }

  /** Skip sister banter while Master is mid-chat / NSFW expanded / companion busy. */
  function attentionBlocksBanter(win) {
    const w = win || root;
    try {
      if (w.document && w.document.hidden) return true;
      const st = w.HqCompanion && w.HqCompanion.testIdle && w.HqCompanion.testIdle.state;
      if (st) {
        if (st.chatBusy || st.busy) return true;
        if (st.nsfwOn && st.expanded) return true;
      }
      const elseRoot = w.document && w.document.getElementById("hq-else");
      if (elseRoot && elseRoot.classList.contains("is-expanded") && elseRoot.classList.contains("is-busy")) return true;
    } catch (_) {}
    return false;
  }

  function shortDigest(win) {
    try {
      if (win.HqCompanion && typeof win.HqCompanion.digest === "function") {
        return String(win.HqCompanion.digest(win) || "").replace(/\s+/g, " ").trim().slice(0, 120);
      }
    } catch (_) {}
    return "";
  }

  function createSisterDirector(win) {
    const w = win || root;
    const doc = w.document;
    let busy = false;
    let queue = [];
    let pumpRunning = false;
    let messages = [];
    let suppressNote = false;
    let ambientOn = true;
    let reactOn = true;
    let reactTimer = null;
    let passBallTimer = null;
    let historyInflight = null;
    let lastNudgeAt = 0;

    function emit(name, detail) {
      try {
        w.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
      } catch (_) {}
    }

    function deviceId() {
      try {
        if (typeof w.hqDeviceId === "function") return String(w.hqDeviceId() || "");
        return String(w.localStorage.getItem("hq_device_id") || "");
      } catch (_) {
        return "";
      }
    }

    function withDevice(payload) {
      const did = deviceId();
      return did ? Object.assign({ device_id: did }, payload) : payload;
    }

    async function fetchJson(url, body) {
      if (typeof w.fetchJson === "function") return w.fetchJson(url, body);
      const opts = body == null
        ? { credentials: "same-origin" }
        : {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          };
      const res = await w.fetch(url, opts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error((data && data.error) || res.statusText || "Erreur");
        err.status = res.status;
        throw err;
      }
      return data;
    }

    function readFlag(key, defaultOn) {
      try {
        const v = w.localStorage.getItem(key);
        if (v == null) return defaultOn !== false;
        return v !== "0";
      } catch (_) {
        return defaultOn !== false;
      }
    }

    function writeFlag(key, on) {
      try {
        w.localStorage.setItem(key, on ? "1" : "0");
      } catch (_) {}
    }

    function cancelPendingReact() {
      if (reactTimer != null) {
        w.clearTimeout(reactTimer);
        reactTimer = null;
      }
      if (passBallTimer != null) {
        w.clearTimeout(passBallTimer);
        passBallTimer = null;
      }
    }

    function schedulePassBall(turns, meta) {
      cancelPendingReact();
      if (!reactEnabled() || isBusy() || attentionBlocksBanter(w)) return;
      const list = Array.isArray(turns) ? turns.filter((t) => t && t.text && (t.speaker === "else" || t.speaker === "transferania")) : [];
      if (!list.length) return;
      if (!clientShouldPassBall({ ambient: true, turns: list, event: meta && meta.event })) return;
      const last = list[list.length - 1];
      const speaker = last.speaker === "else" ? "transferania" : "else";
      const trigger = String(last.text || "").trim();
      if (!trigger) return;
      passBallTimer = w.setTimeout(() => {
        passBallTimer = null;
        if (!reactEnabled() || isBusy() || attentionBlocksBanter(w)) return;
        runReact(trigger, speaker);
      }, PASS_BALL_DELAY_MS);
    }

    function setBusy(on) {
      busy = !!on;
      emit(EV_BUSY, { busy });
      try {
        if (doc && doc.documentElement) doc.documentElement.classList.toggle("hq-sister-busy", busy);
      } catch (_) {}
    }

    function isBusy() {
      return busy || pumpRunning || queue.length > 0;
    }

    function ambientEnabled() {
      return ambientOn;
    }

    function reactEnabled() {
      return reactOn;
    }

    function emitPrefs(extra) {
      emit(EV_PREFS, Object.assign({
        sister_ambient_enabled: ambientOn,
        sister_react_enabled: reactOn,
      }, extra || {}));
    }

    function persistPrefs(patch) {
      return fetchJson("/api/ai", withDevice({
        action: "sister",
        op: "prefs",
        save: true,
        prefs: patch,
      })).catch(() => null);
    }

    function setAmbient(on, persistServer) {
      ambientOn = on !== false;
      writeFlag(LS_AMBIENT, ambientOn);
      emitPrefs();
      if (persistServer) persistPrefs({ sister_ambient_enabled: ambientOn });
      return ambientOn;
    }

    function setReact(on, persistServer) {
      reactOn = on !== false;
      writeFlag(LS_REACT, reactOn);
      if (!reactOn) cancelPendingReact();
      emitPrefs();
      if (persistServer) persistPrefs({ sister_react_enabled: reactOn });
      return reactOn;
    }

    function syncFromStatus(status) {
      const sis = status && status.sister;
      if (!sis || typeof sis !== "object") return;
      let changed = false;
      if ("ambient_enabled" in sis) {
        const next = sis.ambient_enabled !== false;
        if (next !== ambientOn) changed = true;
        ambientOn = next;
        writeFlag(LS_AMBIENT, ambientOn);
      }
      if ("react_enabled" in sis) {
        const next = sis.react_enabled !== false;
        if (next !== reactOn) changed = true;
        reactOn = next;
        writeFlag(LS_REACT, reactOn);
        if (!reactOn) cancelPendingReact();
      }
      if (changed) emitPrefs({ fromStatus: true });
    }

    function getMessages() {
      return messages.slice();
    }

    function setMessages(rows) {
      messages = (Array.isArray(rows) ? rows : []).slice(-MSG_CAP);
      emit(EV_HISTORY, { messages: messages.slice() });
    }

    function noteLine(speaker, text) {
      if (suppressNote) return false;
      if (!shouldAppendSisterRow(messages, speaker, text)) return false;
      messages.push({ speaker, text: String(text), ts: Date.now() });
      if (messages.length > MSG_CAP) messages = messages.slice(-MSG_CAP);
      emit(EV_HISTORY, { messages: messages.slice() });
      return true;
    }

    function publishTurn(row, ambient) {
      if (!row || !row.text) return;
      emit(EV_LINE, {
        speaker: row.speaker,
        text: String(row.text),
        ambient: !!ambient,
        kind: row.kind || null,
        aside: !!(row && row.aside),
      });
      // Micro-glance: no model call — the other sister "looks".
      emit("hq-sister-glance", {
        from: row.speaker,
        to: row.speaker === "else" ? "transferania" : "else",
        ambient: !!ambient,
      });
    }

    async function playTurns(turns, opts) {
      const o = opts || {};
      const list = Array.isArray(turns) ? turns.filter((r) => r && r.text) : [];
      if (!list.length) return;
      const gap = Math.max(400, Number(o.staggerMs) || (o.ambient ? 1100 : 700));
      const ambient = !!o.ambient;
      suppressNote = true;
      try {
        for (const row of list) {
          publishTurn(row, ambient);
          await new Promise((r) => w.setTimeout(r, gap));
        }
      } finally {
        suppressNote = false;
      }
    }

    function viewName() {
      return (doc && doc.body && doc.body.dataset.view) || "accueil";
    }

    async function request(op, extra) {
      return fetchJson("/api/ai", withDevice(Object.assign({
        action: "sister",
        op,
        view: viewName(),
        persona: "warm",
      }, extra || {})));
    }

    function peekTextFrom(out, job, type) {
      if (type === "react") {
        const turn = Array.isArray(out.turns) && out.turns[0];
        return turn && turn.text ? String(turn.text) : "";
      }
      if (job && job.trigger) return String(job.trigger);
      const last = Array.isArray(out.turns) && out.turns.length ? out.turns[out.turns.length - 1] : null;
      return last && last.text ? String(last.text) : (out.topic ? String(out.topic) : "");
    }

    async function runJob(job) {
      const type = (job && job.type) || "exchange";
      if (type === "ambient" || type === "nudge") {
        if (type === "ambient" && !ambientEnabled()) return { skipped: true, reason: "disabled" };
        if (doc && doc.hidden) return { skipped: true, reason: "hidden" };
        if (attentionBlocksBanter(w)) return { skipped: true, reason: "attention" };
      }
      if (type === "react") {
        if (!reactEnabled()) return { skipped: true, reason: "disabled" };
        if (doc && doc.hidden) return { skipped: true, reason: "hidden" };
        if (attentionBlocksBanter(w)) return { skipped: true, reason: "attention" };
      }

      const master = type === "exchange";
      setBusy(true);
      try {
        let out;
        if (type === "react") {
          out = await request("react", {
            trigger: job.trigger || undefined,
            speaker: job.speaker || "else",
          });
        } else if (type === "nudge") {
          out = await request("nudge", {
            toward: job.toward || "else",
            escalate: !!job.escalate,
            digest: shortDigest(w) || undefined,
          });
        } else if (type === "ambient") {
          out = await request("ambient", {
            ambient: true,
            turns: 2,
            digest: shortDigest(w) || undefined,
          });
        } else {
          out = await request("exchange", {
            topic: job.topic || undefined,
            turns: job.turns || 2,
            digest: shortDigest(w) || undefined,
          });
        }
        if (out && out.skipped) return out;

        if (master) {
          emit(EV_OPEN, { expanded: !!job.openExpanded });
        } else if (type === "ambient" || (type === "nudge" && out && out.escalate)) {
          // React peeks via hq-sister-line (ambient flag); avoid a double peek.
          const peek = peekTextFrom(out || {}, job, type === "nudge" ? "ambient" : type);
          if (peek) emit(EV_PEEK, { reason: type, text: peek });
          if (out && out.event && out.event.id) {
            emit(EV_EVENT, {
              id: out.event.id,
              kind: out.event.kind || "observe",
              label: out.event.label || "",
              topic: out.topic || "",
            });
          }
        }

        if (type === "nudge") {
          emit(EV_NUDGE, {
            toward: (out && out.toward) || job.toward || "else",
            soft: !!(out && out.soft),
            escalate: !!(out && out.escalate),
            glance: (out && out.glance) || null,
            peek: (out && out.peek) || null,
          });
          if (out && out.soft && out.peek && out.peek.text) {
            emit(EV_PEEK, { reason: "nudge", text: String(out.peek.text), speaker: out.peek.speaker || out.toward });
            emit("hq-sister-glance", {
              from: (out.glance && out.glance.from) || out.toward || "else",
              to: (out.glance && out.glance.to) || "transferania",
              soft: true,
              nudge: true,
            });
          }
        }

        if (Array.isArray(out.messages)) setMessages(out.messages);
        const turns = Array.isArray(out.turns) ? out.turns : [];
        if (turns.length) {
          await playTurns(turns, {
            ambient: type !== "exchange",
            staggerMs: type === "react" ? 600 : (type === "ambient" || type === "nudge" ? (out && out.event ? 1300 : 1100) : 700),
          });
        }
        if (master && turns.length && typeof w.hqToast === "function") {
          w.hqToast("Les sœurs se sont parlées", "tip", 2200);
        }
        if ((type === "ambient" || (type === "nudge" && out && out.escalate)) && turns.length) {
          schedulePassBall(turns, { event: out && out.event });
        }
        return out;
      } catch (e) {
        if (master && typeof w.hqToast === "function") {
          w.hqToast((e && e.message) || "Dialogue sœurs indisponible", "err");
        }
        return { ok: false, error: (e && e.message) || "error" };
      } finally {
        setBusy(false);
      }
    }

    async function pump() {
      if (pumpRunning) return;
      pumpRunning = true;
      try {
        while (queue.length) {
          const item = queue.shift();
          if (!item) continue;
          let out;
          try {
            out = await runJob(item.job);
          } catch (e) {
            out = { ok: false, error: (e && e.message) || "error" };
          }
          if (typeof item.resolve === "function") item.resolve(out);
        }
      } finally {
        pumpRunning = false;
        if (queue.length) pump();
      }
    }

    function enqueue(job) {
      if (!job || !job.type) return Promise.resolve({ skipped: true, reason: "bad_job" });
      if (job.type !== "exchange") {
        const hasSoft = queue.some((item) => item && item.job && (item.job.type === "ambient" || item.job.type === "react" || item.job.type === "nudge"));
        if (busy || pumpRunning || hasSoft) {
          return Promise.resolve({ skipped: true, reason: "busy" });
        }
      }
      return new Promise((resolve) => {
        queue.push({ job, resolve });
        pump();
      });
    }

    function runExchange(opts) {
      const o = opts || {};
      if (o.ambient) return runAmbient();
      cancelPendingReact();
      return enqueue({
        type: "exchange",
        topic: o.topic,
        turns: o.turns || 2,
        openExpanded: !!o.openExpanded,
      });
    }

    function runAmbient() {
      cancelPendingReact();
      return enqueue({ type: "ambient" });
    }

    function runReact(trigger, speaker) {
      return enqueue({ type: "react", trigger, speaker: speaker || "else" });
    }

    function runNudge(opts) {
      const o = opts || {};
      const now = Date.now();
      // Second nudge within 8s escalates into a short banter beat.
      const escalate = o.escalate === true || (now - lastNudgeAt < 8000 && lastNudgeAt > 0);
      lastNudgeAt = now;
      cancelPendingReact();
      return enqueue({
        type: "nudge",
        toward: o.toward === "transferania" ? "transferania" : "else",
        escalate: !!escalate,
      });
    }

    function loadHistory() {
      if (historyInflight) return historyInflight;
      historyInflight = request("history")
        .then((out) => {
          if (Array.isArray(out.messages)) setMessages(out.messages);
          return out;
        })
        .catch(() => ({ ok: false, messages: messages.slice() }))
        .finally(() => { historyInflight = null; });
      return historyInflight;
    }

    function handleTransferaniaLine(detail) {
      emit(EV_T_LINE, detail || {});
      // Soft glance toward Else whenever Transferania speaks to the Master.
      emit("hq-sister-glance", { from: "transferania", to: "else", ambient: true, soft: true });
      cancelPendingReact();
      if (!clientMayReactToAmbient(detail) || !reactEnabled() || isBusy()) return;
      if (attentionBlocksBanter(w)) return;
      const trigger = String((detail && (detail.text || detail.line)) || "").trim();
      if (!trigger) return;
      reactTimer = w.setTimeout(() => {
        reactTimer = null;
        if (!reactEnabled() || isBusy() || attentionBlocksBanter(w)) return;
        runReact(trigger, "else");
      }, REACT_DELAY_MS);
    }

    function handleElseLine(detail) {
      emit(EV_ELSE_LINE, detail || {});
      // Soft glance toward Transferania whenever Else speaks to the Master.
      emit("hq-sister-glance", { from: "else", to: "transferania", ambient: true, soft: true });
      cancelPendingReact();
      if (!clientMayReactToElse(detail) || !reactEnabled() || isBusy()) return;
      if (attentionBlocksBanter(w)) return;
      const trigger = String((detail && (detail.text || detail.line)) || "").trim();
      if (!trigger) return;
      reactTimer = w.setTimeout(() => {
        reactTimer = null;
        if (!reactEnabled() || isBusy() || attentionBlocksBanter(w)) return;
        runReact(trigger, "transferania");
      }, REACT_DELAY_MS);
    }

    if (!w.__hqSisterDirectorBound) {
      w.__hqSisterDirectorBound = true;
      w.addEventListener(EV_LINE, (ev) => {
        const d = (ev && ev.detail) || {};
        noteLine(d.speaker, d.text);
      });
    }

    ambientOn = readFlag(LS_AMBIENT, true);
    reactOn = readFlag(LS_REACT, true);

    return {
      LS_AMBIENT,
      LS_REACT,
      isBusy,
      ambientEnabled,
      reactEnabled,
      setAmbient,
      setReact,
      syncFromStatus,
      getMessages,
      setMessages,
      stripRows: (lim) => stripRows(messages, lim),
      labelSpeaker,
      noteLine,
      playTurns,
      enqueue,
      runExchange,
      runAmbient,
      runReact,
      runNudge,
      loadHistory,
      handleTransferaniaLine,
      handleElseLine,
      cancelPendingReact,
      request,
      withDevice,
      emit,
    };
  }

  function ensureSister(win) {
    const w = win || root;
    if (w.HqSister && w.HqSister.__ready) return w.HqSister;
    if (!w.document) return null;
    const director = createSisterDirector(w);
    director.__ready = true;
    w.HqSister = director;
    return director;
  }

  const api = {
    LS_AMBIENT,
    LS_REACT,
    EV_LINE,
    EV_OPEN,
    EV_BUSY,
    EV_PEEK,
    EV_EVENT,
    EV_NUDGE,
    EV_T_LINE,
    EV_ELSE_LINE,
    EV_PREFS,
    EV_HISTORY,
    MSG_CAP,
    shouldAppendSisterRow,
    stripRows,
    labelSpeaker,
    clientMayReactToAmbient,
    clientMayReactToElse,
    clientShouldPassBall,
    attentionBlocksBanter,
    shortDigest,
    createSisterDirector,
    ensureSister,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.HqSisterCore = api;

  function bootDirector() {
    const director = ensureSister(root);
    if (!director) return null;
    try {
      const did = typeof root.hqDeviceId === "function" ? root.hqDeviceId() : root.localStorage.getItem("hq_device_id");
      const q = did ? ("?device_id=" + encodeURIComponent(did)) : "";
      const apply = (st) => director.syncFromStatus(st);
      if (typeof root.fetchJson === "function") {
        root.fetchJson("/api/ai" + q).then(apply).catch(() => {});
      } else if (typeof root.fetch === "function") {
        root.fetch("/api/ai" + q, { credentials: "same-origin" })
          .then((r) => r.json())
          .then(apply)
          .catch(() => {});
      }
    } catch (_) {}
    return director;
  }

  if (root.document) {
    if (root.document.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", bootDirector, { once: true });
    } else {
      bootDirector();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
