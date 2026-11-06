/* Perf HUD + agent-friendly client logs → /api/hq/client-log (see docs/client-debug-log.md). */
(function () {
  "use strict";
  var doc = document;
  if (!doc || !doc.body || doc.body.getAttribute("data-hq-debug") !== "1") return;

  var win = window;
  var body = doc.body;
  var agentMode = body.getAttribute("data-hq-debug-agent") === "1";
  var perfSec = parseInt(body.getAttribute("data-hq-debug-perf-sec") || "15", 10);
  if (!isFinite(perfSec) || perfSec < 0) perfSec = 15;
  if (agentMode) perfSec = 0;
  var logWhenCollapsed = body.getAttribute("data-hq-debug-log-collapsed") === "1";
  var sessionId = (body.getAttribute("data-hq-session") || "").trim();
  var copyMax = agentMode ? 50 : 20;

  var panel = doc.createElement("aside");
  panel.id = "hq-debug-panel";
  panel.setAttribute("aria-label", "Diagnostics performance");
  panel.innerHTML =
    '<div class="hq-debug-head">' +
    '<span class="hq-debug-title" title="Glisser pour déplacer · cliquer pour replier">Perf debug</span>' +
    '<button type="button" class="hq-debug-copy" title="Copier les dernières lignes">Copy</button>' +
    '<button type="button" class="hq-debug-brief" title="Copier agent-brief (brief_md, admin)">Brief</button>' +
    '<button type="button" class="hq-debug-packet" title="Copier agent packet (brief + index, admin)">Packet</button>' +
    '<button type="button" class="hq-debug-snap" title="Télécharger session-bundle.json (admin)">Snap</button>' +
    '<button type="button" class="hq-debug-bundle" title="Copier le bundle diagnostic (admin)">Bundle</button>' +
    '<button type="button" class="hq-debug-note" title="Note de repro liée à la session">Note</button>' +
    '<button type="button" class="hq-debug-spike" title="Copier dernier spike (capture + lignes)">Spike</button>' +
    '<select class="hq-debug-motion" title="Mode animation HQ" aria-label="Mode animation">' +
    '<option value="auto">Motion auto</option><option value="lite">Motion lite</option><option value="smooth">Motion smooth</option>' +
    "</select>" +
    '<span class="hq-debug-fps">— fps</span>' +
    "</div>" +
    '<div class="hq-debug-body">' +
    '<div class="hq-debug-grid" id="hq-debug-metrics"></div>' +
    '<div class="hq-debug-log" id="hq-debug-recent" hidden></div>' +
    "</div>";
  body.appendChild(panel);

  var metricsEl = panel.querySelector("#hq-debug-metrics");
  var recentEl = panel.querySelector("#hq-debug-recent");
  var fpsEl = panel.querySelector(".hq-debug-fps");
  var titleEl = panel.querySelector(".hq-debug-title");
  var copyBtn = panel.querySelector(".hq-debug-copy");
  var briefBtn = panel.querySelector(".hq-debug-brief");
  var packetBtn = panel.querySelector(".hq-debug-packet");
  var snapBtn = panel.querySelector(".hq-debug-snap");
  var bundleBtn = panel.querySelector(".hq-debug-bundle");
  var noteBtn = panel.querySelector(".hq-debug-note");
  var spikeBtn = panel.querySelector(".hq-debug-spike");
  var motionSel = panel.querySelector(".hq-debug-motion");
  var SS_PENDING = "hq-debug-pending-v1";
  var SS_POS = "hq-debug-pos-v1";
  var headEl = panel.querySelector(".hq-debug-head");
  var dragState = null;
  var suppressTitleClick = false;

  function clampPanelPos(x, y) {
    var rect = panel.getBoundingClientRect();
    var pad = 8;
    var maxX = Math.max(pad, win.innerWidth - rect.width - pad);
    var maxY = Math.max(pad, win.innerHeight - rect.height - pad);
    return [Math.max(pad, Math.min(x, maxX)), Math.max(pad, Math.min(y, maxY))];
  }

  function applyPanelPos(x, y) {
    var c = clampPanelPos(x, y);
    panel.classList.add("is-floating");
    panel.style.left = c[0] + "px";
    panel.style.top = c[1] + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    return c;
  }

  function savePanelPos(x, y) {
    if (win.localStorage) {
      win.localStorage.setItem(SS_POS, JSON.stringify({ x: x, y: y }));
    }
  }

  function loadPanelPos() {
    var raw = win.localStorage && win.localStorage.getItem(SS_POS);
    if (!raw) return;
    try {
      var p = JSON.parse(raw);
      if (typeof p.x === "number" && typeof p.y === "number") {
        applyPanelPos(p.x, p.y);
      }
    } catch (_) {}
  }

  loadPanelPos();

  win.addEventListener("resize", function () {
    if (!panel.classList.contains("is-floating")) return;
    var rect = panel.getBoundingClientRect();
    var c = applyPanelPos(rect.left, rect.top);
    savePanelPos(c[0], c[1]);
  });

  headEl.addEventListener("pointerdown", function (ev) {
    if (ev.button !== 0 || ev.target.closest("button")) return;
    var rect = panel.getBoundingClientRect();
    if (!panel.classList.contains("is-floating")) {
      applyPanelPos(rect.left, rect.top);
      rect = panel.getBoundingClientRect();
    }
    dragState = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      origX: rect.left,
      origY: rect.top,
      moved: false,
    };
    headEl.setPointerCapture(ev.pointerId);
  });

  function finishDrag(ev) {
    if (!dragState || ev.pointerId !== dragState.pointerId) return;
    if (dragState.moved) {
      var rect = panel.getBoundingClientRect();
      savePanelPos(rect.left, rect.top);
      suppressTitleClick = true;
    }
    try {
      headEl.releasePointerCapture(ev.pointerId);
    } catch (_) {}
    dragState = null;
  }

  headEl.addEventListener("pointermove", function (ev) {
    if (!dragState || ev.pointerId !== dragState.pointerId) return;
    var dx = ev.clientX - dragState.startX;
    var dy = ev.clientY - dragState.startY;
    if (!dragState.moved && Math.abs(dx) + Math.abs(dy) > 5) dragState.moved = true;
    if (dragState.moved) {
      applyPanelPos(dragState.origX + dx, dragState.origY + dy);
    }
  });
  headEl.addEventListener("pointerup", finishDrag);
  headEl.addEventListener("pointercancel", finishDrag);

  var collapsed = win.localStorage && win.localStorage.getItem("hq-debug-collapsed") === "1";
  if (collapsed) panel.classList.add("is-collapsed");
  titleEl.addEventListener("click", function () {
    if (suppressTitleClick) {
      suppressTitleClick = false;
      return;
    }
    panel.classList.toggle("is-collapsed");
    if (win.localStorage) {
      win.localStorage.setItem("hq-debug-collapsed", panel.classList.contains("is-collapsed") ? "1" : "0");
    }
  });

  function copyText(text, btn) {
    if (win.navigator.clipboard && win.navigator.clipboard.writeText) {
      win.navigator.clipboard.writeText(text).catch(function () {});
    } else {
      try {
        var ta = doc.createElement("textarea");
        ta.value = text;
        doc.body.appendChild(ta);
        ta.select();
        doc.execCommand("copy");
        ta.remove();
      } catch (_) {}
    }
    if (btn) {
      var old = btn.textContent;
      btn.textContent = "OK";
      win.setTimeout(function () {
        btn.textContent = old;
      }, 900);
    }
  }

  copyBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    var text = copyRing.length ? copyRing.slice().reverse().join("\n") : "(aucune ligne)";
    if (lastFail.status) {
      text =
        "session=" +
        sessionId +
        "\nlast_fail=" +
        JSON.stringify(lastFail) +
        "\n---\n" +
        text;
    }
    copyText(text, copyBtn);
  });

  briefBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    win
      .fetch("/api/diag/agent-brief?limit=50", { credentials: "same-origin", cache: "no-store", headers: hqHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error("brief " + r.status);
        return r.json();
      })
      .then(function (j) {
        var md = j.brief_md;
        if (typeof md === "string" && md.trim()) copyText(md, briefBtn);
        else copyText(JSON.stringify(j.agent_triage || j, null, 2), briefBtn);
      })
      .catch(function () {
        copyText(
          "agent-brief requires admin GET /api/diag/agent-brief\n\nlocal session=" +
            sessionId +
            "\nsee docs/agent-debugging.md",
          briefBtn
        );
      });
  });

  bundleBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    win
      .fetch("/api/diag/session-bundle?limit=50", { credentials: "same-origin", cache: "no-store", headers: hqHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error("bundle " + r.status);
        return r.json();
      })
      .then(function (j) {
        copyText(JSON.stringify(j, null, 2), bundleBtn);
      })
      .catch(function () {
        copyText(
          JSON.stringify(
            {
              session_id: sessionId,
              last_fail: lastFail,
              local_lines: copyRing.slice().reverse(),
              note: "session-bundle requires admin; local buffer copied instead",
            },
            null,
            2
          ),
          bundleBtn
        );
      });
  });

  packetBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    win
      .fetch("/api/diag/agent-brief?limit=50", { credentials: "same-origin", cache: "no-store", headers: hqHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error("brief " + r.status);
        return r.json();
      })
      .then(function (j) {
        var md = j.packet_md || j.brief_md;
        if (typeof md === "string" && md.trim()) copyText(md, packetBtn);
        else copyText(JSON.stringify(j, null, 2), packetBtn);
      })
      .catch(function () {
        copyText("agent-brief/packet requires admin GET /api/diag/agent-brief", packetBtn);
      });
  });

  snapBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    win
      .fetch("/api/diag/session-bundle?limit=50", { credentials: "same-origin", cache: "no-store", headers: hqHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error("bundle " + r.status);
        return r.json();
      })
      .then(function (j) {
        var blob = new Blob([JSON.stringify(j, null, 2)], { type: "application/json" });
        var a = doc.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "hq-session-bundle-" + (sessionId || "snap") + ".json";
        doc.body.appendChild(a);
        a.click();
        a.remove();
        var old = snapBtn.textContent;
        snapBtn.textContent = "OK";
        win.setTimeout(function () {
          snapBtn.textContent = old;
        }, 900);
      })
      .catch(function () {
        copyText("Snap requires admin GET /api/diag/session-bundle", snapBtn);
      });
  });

  noteBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    var note = win.prompt("Note de repro (session " + (sessionId || "?") + "):", "");
    if (note == null || !String(note).trim()) return;
    win
      .fetch("/api/hq/repro-note", {
        method: "POST",
        credentials: "same-origin",
        headers: hqHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ session_id: sessionId, view: currentView(), note: String(note).trim() }),
      })
      .then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error(j.error || "fail");
          pushEntry("info", "repro note saved", String(note).trim().slice(0, 120), { kind: "meta", force: true });
          copyText("note saved", noteBtn);
        });
      })
      .catch(function () {
        copyText("repro-note failed", noteBtn);
      });
  });

  spikeBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    if (!lastSpike) {
      copyText("No spike yet", spikeBtn);
      return;
    }
    var lines = [];
    lines.push("lag screenshot: " + (lastSpike.screenshot_rel || lastSpike.screenshot_path || ""));
    if (lastSpike.hq_view_rel) lines.push("hq view: " + lastSpike.hq_view_rel);
    lines.push("reason: " + (lastSpike.reason || "") + " view=" + (lastSpike.view || ""));
    var tail = entries.slice(-10);
    for (var ti = 0; ti < tail.length; ti++) {
      var e = tail[ti];
      lines.push(
        (e.ts || "") +
          " [" +
          (e.level || "") +
          "] " +
          (e.message || "") +
          (e.requestId ? " rid=" + e.requestId : "")
      );
    }
    win
      .fetch("/api/diag/agent-brief?limit=40&session_id=" + encodeURIComponent(sessionId || ""), {
        credentials: "same-origin",
        headers: hqHeaders(),
      })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j && j.top_issues && j.top_issues.length) {
          lines.push("brief: " + j.top_issues.slice(0, 2).join(" | "));
        }
        copyText(lines.join("\n"), spikeBtn);
      })
      .catch(function () {
        copyText(lines.join("\n"), spikeBtn);
      });
  });

  var fps = 0;
  var frames = 0;
  var lastFpsAt = win.performance && win.performance.now ? win.performance.now() : Date.now();
  var longTasks = 0;
  var lastLongAt = "";
  var onFpsSample = null;
  var lastFail = { status: 0, path: "", request_id: "", view: "", at: "" };

  function hqHeaders(extra) {
    var h = extra ? Object.assign({}, extra) : {};
    if (sessionId) h["X-HQ-Session"] = sessionId;
    return h;
  }

  function loop(now) {
    frames += 1;
    var t = now || (win.performance && win.performance.now ? win.performance.now() : Date.now());
    if (t - lastFpsAt >= 1000) {
      fps = Math.round((frames * 1000) / (t - lastFpsAt));
      frames = 0;
      lastFpsAt = t;
      if (fpsEl) fpsEl.textContent = fps + " fps";
      if (typeof onFpsSample === "function") onFpsSample(fps, t);
    }
    win.requestAnimationFrame(loop);
  }
  win.requestAnimationFrame(loop);

  if (win.PerformanceObserver) {
    try {
      var po = new win.PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (e.duration >= 50) {
            longTasks += 1;
            lastLongAt = Math.round(e.duration) + "ms";
          }
          if (e.duration >= 120) {
            maybeLagCapture("longtask", { ms: Math.round(e.duration) });
          }
        });
      });
      po.observe({ entryTypes: ["longtask"] });
    } catch (_) {}
  }

  var LAG_CAPTURE_GAP_MS = 45000;
  var lastLagCaptureAt = 0;
  var lagCaptureInflight = false;
  var lastSpike = null;

  function hqLagMeta() {
    return {
      view: currentView(),
      scrollY: win.scrollY || 0,
      innerWidth: win.innerWidth || 0,
      innerHeight: win.innerHeight || 0,
      hidden: !!doc.hidden,
    };
  }

  function captureHqViewB64(done) {
    try {
      var canvases = doc.querySelectorAll("canvas");
      var best = null;
      var area = 0;
      for (var ci = 0; ci < canvases.length; ci++) {
        var c = canvases[ci];
        if (!c.width || !c.height) continue;
        var rect = c.getBoundingClientRect();
        if (rect.width < 48 || rect.height < 48) continue;
        var a = rect.width * rect.height;
        if (a > area) {
          area = a;
          best = c;
        }
      }
      if (!best) {
        done(null);
        return;
      }
      var maxW = 480;
      var scale = Math.min(1, maxW / best.width);
      var w = Math.max(1, Math.round(best.width * scale));
      var h = Math.max(1, Math.round(best.height * scale));
      var out = doc.createElement("canvas");
      out.width = w;
      out.height = h;
      var ctx = out.getContext("2d");
      if (!ctx) {
        done(null);
        return;
      }
      ctx.drawImage(best, 0, 0, w, h);
      var dataUrl = out.toDataURL("image/png");
      var b64 = dataUrl.indexOf(",") >= 0 ? dataUrl.split(",")[1] : "";
      done(b64 && b64.length > 120 ? b64 : null);
    } catch (_) {
      done(null);
    }
  }

  function maybeLagCapture(reason, extra) {
    if (agentMode || doc.hidden) return;
    var now = Date.now();
    if (lagCaptureInflight || now - lastLagCaptureAt < LAG_CAPTURE_GAP_MS) return;
    lagCaptureInflight = true;
    captureHqViewB64(function (hqB64) {
      var payload = {
        session_id: sessionId,
        view: currentView(),
        reason: String(reason || "lag").slice(0, 80),
        hq_meta: hqLagMeta(),
      };
      if (hqB64) payload.hq_view_b64 = hqB64;
      if (extra && typeof extra === "object") payload.detail = extra;
      win
        .fetch("/api/hq/lag-capture", {
          method: "POST",
          credentials: "same-origin",
          headers: hqHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(payload),
        })
        .then(function (r) {
          if (!r.ok) return null;
          return r.json();
        })
        .then(function (j) {
          if (!j || !j.ok) return;
          lastLagCaptureAt = Date.now();
          var rel = j.screenshot_rel || j.rel || "";
          var hqView = j.hq_view_rel || "";
          var data = { reason: reason, screenshot: rel, screenshot_rel: rel, hq_view: hqView, hq_view_rel: hqView };
          if (extra && typeof extra === "object") {
            Object.keys(extra).forEach(function (k) {
              data[k] = extra[k];
            });
          }
          if (j.hq_meta && typeof j.hq_meta === "object") data.hq_meta = j.hq_meta;
          lastSpike = {
            at: new Date().toISOString(),
            reason: reason,
            screenshot_rel: rel,
            hq_view_rel: hqView,
            view: currentView(),
            session_id: sessionId,
            data: data,
          };
          pushEntry("warn", "lag spike: " + reason, rel ? "screenshot=" + rel : null, {
            kind: "lag-spike",
            force: true,
            data: data,
          });
        })
        .catch(function () {})
        .finally(function () {
          lagCaptureInflight = false;
        });
    });
  }

  function currentView() {
    return (body.getAttribute("data-view") || "").trim();
  }

  function pagePath() {
    try {
      return (win.location && win.location.pathname) || "/";
    } catch (_) {
      return "/";
    }
  }

  function memLine() {
    var m = win.performance && win.performance.memory;
    if (!m) return "n/a (Chrome)";
    var used = Math.round(m.usedJSHeapSize / 1048576);
    var total = Math.round(m.totalJSHeapSize / 1048576);
    return used + " / " + total + " Mo heap";
  }

  function navMs() {
    var n = win.performance && win.performance.timing;
    if (!n || !n.loadEventEnd || !n.navigationStart) return "—";
    return n.loadEventEnd - n.navigationStart + " ms load";
  }

  function companionLine() {
    if (typeof win.hqCompanionPerf !== "function") return "companion: —";
    try {
      var p = win.hqCompanionPerf();
      return (
        "companion: " +
        (p.perfPressure ? "pressure " : "") +
        (p.perfLite ? "lite " : "") +
        (p.hidden ? "hidden " : "") +
        (p.view ? "view=" + p.view : "")
      ).trim();
    } catch (_) {
      return "companion: err";
    }
  }

  function motionLine() {
    if (!win.HqMotion) return "motion: —";
    try {
      var s = win.HqMotion.getState();
      return (
        "motion: " +
        s.mode +
        " / " +
        s.tier +
        (s.autoLite ? " autoLite" : "") +
        (s.emaLive2d ? " l2d~" + s.emaLive2d + "ms" : "")
      );
    } catch (_) {
      return "motion: err";
    }
  }

  function syncMotionSelect() {
    if (!motionSel || !win.HqMotion) return;
    var m = win.HqMotion.getMode();
    if (motionSel.value !== m) motionSel.value = m;
  }

  if (motionSel) {
    motionSel.addEventListener("change", function () {
      if (win.HqMotion) win.HqMotion.setMode(motionSel.value);
      paintMetrics();
    });
    win.addEventListener("hq:motion-mode", syncMotionSelect);
    syncMotionSelect();
  }

  function perfSnapshotText() {
    var parts = [
      "view=" + (currentView() || "—"),
      "fps=" + fps,
      "mem=" + memLine(),
      "longTasks=" + longTasks,
      "tab=" + (doc.hidden ? "hidden" : "visible"),
    ];
    if (lastLongAt) parts.push("lastLong=" + lastLongAt);
    var cl = companionLine();
    if (cl !== "companion: —") parts.push(cl.replace(/^companion:\s*/, "companion="));
    var ml = motionLine();
    if (ml !== "motion: —") parts.push(ml.replace(/^motion:\s*/, "motion="));
    return parts.join(" ");
  }

  function setMetric(label, value, cls) {
    var dt = doc.createElement("div");
    dt.textContent = label;
    var dd = doc.createElement("div");
    dd.textContent = value;
    if (cls) dd.className = cls;
    metricsEl.appendChild(dt);
    metricsEl.appendChild(dd);
  }

  function paintMetrics() {
    metricsEl.textContent = "";
    setMetric("Session", sessionId || "—");
    setMetric("Vue", currentView() || "—");
    setMetric("FPS", String(fps), fps < 45 ? "hq-debug-warn" : "");
    setMetric("Mémoire", memLine());
    setMetric("Chargement", navMs());
    setMetric("Long tasks", String(longTasks) + (lastLongAt ? " (last " + lastLongAt + ")" : ""), longTasks ? "hq-debug-warn" : "");
    if (lastFail.status) {
      setMetric(
        "Dernier échec API",
        lastFail.status + " " + lastFail.path + (lastFail.request_id ? " #" + lastFail.request_id : ""),
        "hq-debug-bad"
      );
    } else {
      setMetric("Dernier échec API", "—");
    }
    setMetric("Mode", agentMode ? "agent" : "standard");
    var perfHint = perfSec > 0 ? perfSec + "s" : "départ/sortie";
    setMetric("Logs", "2 fichiers · 200 lignes · perf " + perfHint);
    setMetric("Agents", "Brief → agent-brief · Snap/Bundle");
    setMetric("Animation", motionLine());
  }
  win.setInterval(paintMetrics, 500);

  var queue = [];
  var recent = [];
  var copyRing = [];
  var flushing = false;
  var flushTimer = 0;

  function isCollapsed() {
    return panel.classList.contains("is-collapsed");
  }

  function shouldSkipWhenCollapsed(level, kind) {
    if (logWhenCollapsed || !isCollapsed()) return false;
    if (level === "error") return false;
    if (kind === "api") return false;
    return true;
  }

  function pushEntry(level, message, detail, opts) {
    opts = opts || {};
    var kind = opts.kind || "";
    if (!opts.force && shouldSkipWhenCollapsed(level, kind)) return;
    var msg = String(message || "").slice(0, 400);
    if (!msg) return;
    var view = currentView();
    var rid = opts.requestId != null ? String(opts.requestId).slice(0, 16) : null;
    var row = {
      level: level,
      message: msg,
      detail: detail != null ? String(detail).slice(0, 400) : null,
      view: view || null,
      request_id: rid,
      session_id: sessionId || null,
      kind: kind || null,
      data: opts.data && typeof opts.data === "object" ? opts.data : null,
    };
    queue.push(row);
    persistPending();
    var line =
      (sessionId ? "#" + sessionId + " " : "") +
      (view ? "[" + view + "] " : "") +
      (kind ? "{" + kind + "} " : "") +
      level +
      ": " +
      msg +
      (detail != null && detail !== "" ? " — " + detail : "") +
      (rid ? " req=" + rid : "");
    recent.unshift(line);
    if (recent.length > 8) recent.length = 8;
    recentEl.textContent = recent.join("\n");
    recentEl.hidden = false;
    copyRing.unshift(line);
    if (copyRing.length > copyMax) copyRing.length = copyMax;
    win.clearTimeout(flushTimer);
    flushTimer = win.setTimeout(flush, 1200);
  }

  function flush() {
    if (flushing || !queue.length) return;
    flushing = true;
    var batch = queue.splice(0, 40);
    persistPending();
    win
      .fetch("/api/hq/client-log", {
        method: "POST",
        credentials: "same-origin",
        headers: hqHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ page: pagePath(), view: currentView(), session_id: sessionId, entries: batch }),
      })
      .then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
      })
      .catch(function () {
        queue = batch.concat(queue);
        persistPending();
      })
      .finally(function () {
        flushing = false;
        if (queue.length) flushTimer = win.setTimeout(flush, 800);
      });
  }

  function persistPending() {
    try {
      if (!win.sessionStorage) return;
      if (queue.length) win.sessionStorage.setItem(SS_PENDING, JSON.stringify(queue));
      else win.sessionStorage.removeItem(SS_PENDING);
    } catch (_) {}
  }

  function restorePending() {
    try {
      if (!win.sessionStorage) return;
      var raw = win.sessionStorage.getItem(SS_PENDING);
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) return;
      queue = arr.concat(queue);
      flush();
    } catch (_) {}
  }

  function logPerfSnapshot(label, force) {
    pushEntry(
      "info",
      label || "perf snapshot",
      perfSnapshotText(),
      { kind: "perf", force: !!force, data: { fps: fps, longTasks: longTasks, hidden: !!doc.hidden } }
    );
  }

  win.hqClientLog = function (payload) {
    if (!payload || typeof payload !== "object") return;
    pushEntry(payload.level || "info", payload.message || "", payload.detail, {
      kind: payload.kind || "carnet",
      force: payload.force !== false,
      requestId: payload.request_id,
      data: payload.data,
    });
  };

  win.hqClientLogView = function (from, to) {
    var a = String(from || "").trim();
    var b = String(to || "").trim();
    if (!b || a === b) return;
    pushEntry("info", "view change " + (a || "—") + " → " + b, null, {
      kind: "view",
      force: agentMode,
      data: { from: a || null, to: b },
    });
    if (win.hqPerfMark) win.hqPerfMark("nav", { op: "view", from: a || null, to: b, ms: 0 });
  };

  var markThrottle = Object.create(null);
  var markPressureState = Object.create(null);
  win.hqPerfMark = function (subsystem, data, opts) {
    if (!subsystem) return;
    opts = opts || {};
    data = data && typeof data === "object" ? data : {};
    var sub = String(subsystem).slice(0, 24);
    var op = String(data.op || "mark").slice(0, 32);
    var ms = data.ms != null ? Number(data.ms) : 0;
    if (!isFinite(ms)) ms = 0;
    var key = sub + "\0" + op;
    var now = Date.now();
    var gap = agentMode ? 2000 : 4000;
    var slow = ms >= 20;
    var heavy = ms >= 50;
    var pressure = !!data.pressure;
    var pressureKey = key + ":p";
    var pressureChanged = pressure !== markPressureState[pressureKey];
    if (pressureChanged) markPressureState[pressureKey] = pressure;
    var force = !!opts.force || heavy || pressureChanged;
    if (!force && slow) gap = 12000;
    if (!force && now - (markThrottle[key] || 0) < gap) return;
    markThrottle[key] = now;
    if (heavy && sub === "companion" && op === "live2d-frame") {
      maybeLagCapture("live2d-frame", { ms: ms, ema: data.ema, view: currentView() });
    }
    var payload = { subsystem: sub, op: op, view: currentView() || null };
    Object.keys(data).forEach(function (k) {
      if (k !== "subsystem") payload[k] = data[k];
    });
    pushEntry(slow ? "warn" : "info", "perf-mark " + sub + " " + op + (ms ? " " + Math.round(ms * 10) / 10 + "ms" : ""), null, {
      kind: "perf-mark",
      force: force,
      data: payload,
    });
  };

  var origFetch = win.fetch;
  if (typeof origFetch === "function") {
    win.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url ? input.url : "";
      init = init || {};
      var hdrs = new Headers(init.headers || {});
      if (sessionId && !hdrs.has("X-HQ-Session")) hdrs.set("X-HQ-Session", sessionId);
      init = Object.assign({}, init, { headers: hdrs });
      var t0 = win.performance && win.performance.now ? win.performance.now() : Date.now();
      return origFetch.call(this, input, init).then(function (res) {
        try {
          var ms = Math.round((win.performance && win.performance.now ? win.performance.now() : Date.now()) - t0);
          if (url.indexOf("/api/") >= 0 && res.ok && ms >= 800) {
            res
              .clone()
              .text()
              .then(function (t) {
                var rid = "";
                try {
                  var j = JSON.parse(t);
                  rid = j.request_id || j.requestId || "";
                } catch (_) {}
                if (win.hqPerfMark) {
                  win.hqPerfMark("api", { op: "fetch-slow", path: url.split("?")[0], ms: ms, status: res.status });
                }
                pushEntry("warn", "fetch slow " + ms + "ms " + path, rid ? "request_id=" + rid : null, {
                  kind: "api",
                  requestId: rid,
                  force: false,
                  data: { status: res.status, path: path, ms: ms },
                });
              })
              .catch(function () {
                if (win.hqPerfMark) {
                  win.hqPerfMark("api", { op: "fetch-slow", path: url.split("?")[0], ms: ms, status: res.status });
                }
              });
          }
          if (url.indexOf("/api/") >= 0 && !res.ok) {
            var path = url.split("?")[0];
            var status = res.status;
            ms = Math.round((win.performance && win.performance.now ? win.performance.now() : Date.now()) - t0);
            res
              .clone()
              .text()
              .then(function (t) {
                var rid = "";
                try {
                  var j = JSON.parse(t);
                  rid = j.request_id || j.requestId || "";
                } catch (_) {}
                lastFail = {
                  status: status,
                  path: path,
                  request_id: rid,
                  view: currentView(),
                  at: new Date().toISOString(),
                };
                pushEntry("warn", "fetch " + status + " " + path, rid ? "request_id=" + rid : t.slice(0, 120), {
                  kind: "api",
                  requestId: rid,
                  force: true,
                  data: { status: status, path: path, ms: ms },
                });
              })
              .catch(function () {
                pushEntry("warn", "fetch " + status + " " + path, null, {
                  kind: "api",
                  force: true,
                  data: { status: status, path: path, ms: ms },
                });
              });
          }
        } catch (_) {}
        return res;
      });
    };
  }

  ["log", "info", "warn", "error"].forEach(function (level) {
    var orig = win.console && win.console[level];
    if (typeof orig !== "function") return;
    win.console[level] = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i += 1) {
          var a = arguments[i];
          parts.push(a && a.stack ? a.stack : String(a));
        }
        pushEntry(level, parts.join(" "), null, {
          kind: level === "error" || level === "warn" ? "console" : "console-quiet",
          force: level === "error" || level === "warn",
        });
      } catch (_) {}
      return orig.apply(win.console, arguments);
    };
  });

  win.addEventListener("error", function (ev) {
    pushEntry("error", ev.message || "error", (ev.filename || "") + ":" + (ev.lineno || 0), {
      kind: "error",
      force: true,
    });
  });
  win.addEventListener("unhandledrejection", function (ev) {
    var r = ev.reason;
    pushEntry("error", "unhandledrejection", r && r.message ? r.message : String(r), { kind: "error", force: true });
  });

  win.addEventListener("visibilitychange", function () {
    pushEntry("info", "visibility:" + (doc.hidden ? "hidden" : "visible"), "view=" + currentView(), { kind: "meta" });
  });

  win.addEventListener("pagehide", function () {
    logPerfSnapshot("perf exit", true);
    flush();
  });

  pushEntry("info", "debug panel active", "view=" + currentView(), { kind: "meta", force: true });
  restorePending();
  logPerfSnapshot("perf start", true);

  if (perfSec > 0) {
    win.setInterval(function () {
      logPerfSnapshot("perf snapshot", false);
    }, perfSec * 1000);
  }

  var LOW_FPS = 45;
  var LOW_FPS_LOG_GAP_MS = 20000;
  var lastLowFpsLogAt = 0;

  onFpsSample = function (sample, t) {
    if (agentMode || doc.hidden) return;
    if (sample < 28) {
      maybeLagCapture("low-fps", { fps: sample });
    }
    if (sample >= LOW_FPS) return;
    if (t - lastLowFpsLogAt < LOW_FPS_LOG_GAP_MS) return;
    lastLowFpsLogAt = t;
    pushEntry("warn", "perf low fps=" + sample, perfSnapshotText(), { kind: "perf", data: { fps: sample } });
  };
})();
