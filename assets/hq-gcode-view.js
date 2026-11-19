/* Atelier 3D: self-hosted 3D G-code toolpath viewer wrapper over
 * @chestnutlabs/gcode-preview-element@0.24.0 + three@0.178.0 (MIT).
 * See docs/third-party-licenses-gcode.md. No CDN, no telemetry, ES2020.
 *
 * Exposes window.HQGcode = { createGcodeViewer, FEATURE_LEGEND, ... }.
 * Preview parsing is strictly read-only and never authorizes printing. */
(function (root) {
  "use strict";

  const DEFAULT_MAX_BYTES_DESKTOP = 128 * 1024 * 1024;
  const DEFAULT_MAX_BYTES_MOBILE = 64 * 1024 * 1024;
  const NEUTRAL_RGB = [0.68, 0.71, 0.76];
  const UNKNOWN_RGB = [0.58, 0.64, 0.72];

  // Ordered to match FeatureRole (1..14) in @chestnutlabs/toolpath-core.
  // Feature 0 (Unknown) always uses mode.fallback and is never guessed.
  const FEATURE_LEGEND = [
    { role: 2,  key: "outer",       label: "Paroi externe",         hex: "#f97316", rgb: [0.976, 0.451, 0.086] },
    { role: 1,  key: "inner",       label: "Paroi interne",         hex: "#fbbf24", rgb: [0.984, 0.749, 0.141] },
    { role: 3,  key: "infill",      label: "Remplissage",           hex: "#8b5cf6", rgb: [0.545, 0.361, 0.965] },
    { role: 4,  key: "solid",       label: "Surfaces haut/bas",     hex: "#ec4899", rgb: [0.925, 0.282, 0.600] },
    { role: 8,  key: "bridge",      label: "Ponts",                 hex: "#06b6d4", rgb: [0.024, 0.714, 0.831] },
    { role: 5,  key: "support",     label: "Supports / interfaces", hex: "#22c55e", rgb: [0.133, 0.773, 0.369] },
    { role: 6,  key: "skirt",       label: "Jupe (Skirt)",          hex: "#14b8a6", rgb: [0.078, 0.722, 0.651] },
    { role: 7,  key: "brim",        label: "Bordure (Brim)",        hex: "#2dd4bf", rgb: [0.176, 0.831, 0.749] },
    { role: 13, key: "raft",        label: "Radeau (Raft)",         hex: "#84cc16", rgb: [0.518, 0.800, 0.086] },
    { role: 11, key: "primeTower",  label: "Tour de purge",         hex: "#eab308", rgb: [0.918, 0.702, 0.031] },
    { role: 12, key: "wipeTower",   label: "Tour d'essuyage",       hex: "#f59e0b", rgb: [0.961, 0.620, 0.043] },
    { role: 14, key: "purge",       label: "Purge",                 hex: "#ef4444", rgb: [0.937, 0.267, 0.267] },
    { role: 10, key: "custom",      label: "Autre / personnalisé",  hex: "#a855f7", rgb: [0.659, 0.333, 0.969] },
    { role: 9,  key: "travel",      label: "Déplacements",          hex: "#64748b", rgb: [0.392, 0.455, 0.545] },
    { role: 0,  key: "unknown",     label: "Non classifié",         hex: "#94a3b8", rgb: UNKNOWN_RGB },
  ];

  // Palette indexed by (FeatureRole - 1), length 14 (roles 1..14).
  const FEATURE_PALETTE = (function () {
    const out = new Array(14).fill(UNKNOWN_RGB);
    FEATURE_LEGEND.forEach(function (entry) {
      if (entry.role >= 1 && entry.role <= 14) out[entry.role - 1] = entry.rgb;
    });
    return out;
  })();

  const SPEED_RAMP = [
    [0.231, 0.510, 0.965], // #3b82f6 (slow)
    [0.024, 0.714, 0.831], // #06b6d4
    [0.133, 0.773, 0.369], // #22c55e
    [0.980, 0.800, 0.082], // #facc15
    [0.937, 0.267, 0.267], // #ef4444 (fast)
  ];

  const TOOL_PALETTE_HEX = [
    "#38bdf8", "#f97316", "#22c55e", "#a855f7",
    "#ec4899", "#eab308", "#14b8a6", "#f43f5e",
  ];

  function hexToRgb01(hex) {
    if (typeof hex !== "string") return null;
    let h = hex.trim().replace(/^#/, "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 8) h = h.slice(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
    ];
  }

  const TOOL_PALETTE = TOOL_PALETTE_HEX.map(hexToRgb01);

  function isConstrainedDevice() {
    try {
      const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
      const mobileUa = /iPhone|iPad|iPod|Android|Mobile/i.test(ua);
      const narrow = typeof window !== "undefined" && window.innerWidth > 0 && window.innerWidth <= 900;
      const lowMem = typeof navigator !== "undefined" && typeof navigator.deviceMemory === "number" && navigator.deviceMemory <= 4;
      const touch = typeof navigator !== "undefined" && (navigator.maxTouchPoints || 0) > 1 && narrow;
      return mobileUa || lowMem || touch;
    } catch (_) {
      return false;
    }
  }

  function assetUrl(name) {
    if (typeof window !== "undefined" && typeof window.hqAssetUrl === "function") {
      return window.hqAssetUrl(name);
    }
    return "/assets/" + name;
  }

  function buildFilamentPaletteFromMeta(meta) {
    const list = (meta && Array.isArray(meta.filaments)) ? meta.filaments : [];
    let maxSlot = -1;
    const entries = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f) continue;
      // inspect_print_file uses 1-based id; parsed metadata uses 0-based slot
      const slot = Number.isInteger(f.slot) ? f.slot : (Number.isInteger(f.id) && f.id >= 1 ? f.id - 1 : i);
      if (slot < 0 || slot >= 64) continue;
      const rgb = hexToRgb01(f.colour || f.color);
      if (rgb) {
        if (slot > maxSlot) maxSlot = slot;
        entries.push({ slot, rgb, hex: (f.colour || f.color).slice(0, 7), type: f.type || "" });
      }
    }
    if (!entries.length) return null;
    const palette = new Array(maxSlot + 1).fill(NEUTRAL_RGB);
    for (let i = 0; i < entries.length; i++) palette[entries[i].slot] = entries[i].rgb;
    return palette;
  }

  function computeColorModeSpec(modeName, opts) {
    const o = opts || {};
    if (modeName === "feature") {
      return { mode: "feature", palette: FEATURE_PALETTE, fallback: UNKNOWN_RGB };
    }
    if (modeName === "feedrate") {
      return { mode: "feedrate", ramp: SPEED_RAMP, fallback: UNKNOWN_RGB };
    }
    if (modeName === "moveKind") {
      return {
        mode: "moveKind",
        cut: [0.220, 0.741, 0.973],    // #38bdf8 extrusion
        travel: [0.957, 0.247, 0.369], // #f43f5e travel
        fallback: UNKNOWN_RGB,
      };
    }
    if (modeName === "tool") {
      const custom = Array.isArray(o.toolColors) && o.toolColors.length
        ? o.toolColors.map(function (c, idx) { return hexToRgb01(c) || TOOL_PALETTE[idx % TOOL_PALETTE.length]; })
        : TOOL_PALETTE;
      return { mode: "tool", palette: custom, fallback: UNKNOWN_RGB };
    }
    // "filament" (default): prefer parsed G-code filament metadata; else inspect slice_info palette; else honest neutral.
    if (o.hasParsedFilamentColors) {
      return { mode: "filament", fallback: NEUTRAL_RGB };
    }
    const metaPalette = buildFilamentPaletteFromMeta(o.inspectMeta);
    if (metaPalette) {
      return { mode: "tool", palette: metaPalette, fallback: NEUTRAL_RGB };
    }
    return { mode: "filament", fallback: NEUTRAL_RGB };
  }

  function hasUsableFilamentColors(parsedMeta) {
    const list = parsedMeta && Array.isArray(parsedMeta.filaments) ? parsedMeta.filaments : [];
    for (let i = 0; i < list.length; i++) {
      if (list[i] && hexToRgb01(list[i].color || list[i].colour)) return true;
    }
    return false;
  }

  function formatApiError(status, bodyText) {
    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch (_) {}
    const msg = (parsed && parsed.error) || ("Erreur HTTP " + status);
    const err = new Error(msg);
    err.status = status;
    err.code = (parsed && parsed.code) || "http_error";
    return err;
  }

  async function fetchGcodeBytes(url, signal, maxBytes, onProgress, fetchImpl) {
    const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!doFetch) throw new Error("fetch indisponible");
    const res = await doFetch(url, { credentials: "same-origin", signal: signal });
    if (!res.ok) {
      let txt = "";
      try { txt = await res.text(); } catch (_) {}
      throw formatApiError(res.status, txt);
    }
    const lenHdr = res.headers && typeof res.headers.get === "function" ? res.headers.get("Content-Length") : null;
    const total = lenHdr ? Number(lenHdr) : 0;
    if (Number.isFinite(total) && total > maxBytes) {
      const e = new Error("G-code trop volumineux pour l'aperçu 3D (" + (total / 1048576).toFixed(1) + " Mo).");
      e.code = "too_large";
      throw e;
    }
    if (!res.body || typeof res.body.getReader !== "function") {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxBytes) {
        const e = new Error("G-code trop volumineux pour l'aperçu 3D.");
        e.code = "too_large";
        throw e;
      }
      if (onProgress) onProgress({ phase: "download", loaded: buf.byteLength, total: buf.byteLength });
      return new Uint8Array(buf);
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        if (signal && signal.aborted) {
          try { await reader.cancel(); } catch (_) {}
          const abortErr = new Error("Aborted");
          abortErr.name = "AbortError";
          throw abortErr;
        }
        const step = await reader.read();
        if (step.done) break;
        const chunk = step.value;
        received += chunk.byteLength;
        if (received > maxBytes) {
          try { await reader.cancel(); } catch (_) {}
          const e = new Error("G-code dépasse la limite mémoire (" + Math.round(maxBytes / 1048576) + " Mo).");
          e.code = "too_large";
          throw e;
        }
        chunks.push(chunk);
        if (onProgress) onProgress({ phase: "download", loaded: received, total: total > 0 ? total : 0 });
      }
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (let i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].byteLength;
    }
    return out;
  }

  function buildSummary(parseResult, ctrlState, inspectMeta, extra) {
    const ir = parseResult && parseResult.ir ? parseResult.ir : null;
    const layers = (ir && Array.isArray(ir.layers)) ? ir.layers : [];
    const layerZs = new Float32Array(layers.length);
    for (let i = 0; i < layers.length; i++) layerZs[i] = layers[i].z;

    function finiteBoxDims(b) {
      if (!b || !b.min || !b.max) return null;
      const s = b.min.x + b.min.y + b.min.z + b.max.x + b.max.y + b.max.z;
      if (!Number.isFinite(s) || b.max.x < b.min.x || b.max.y < b.min.y || b.max.z < b.min.z) return null;
      return [
        Math.max(0, +(b.max.x - b.min.x).toFixed(1)),
        Math.max(0, +(b.max.y - b.min.y).toFixed(1)),
        Math.max(0, +(b.max.z - b.min.z).toFixed(1)),
      ];
    }
    const modelDims = ir ? finiteBoxDims(ir.modelBounds) : null;
    const objDims = !modelDims && ir ? finiteBoxDims(ir.objectBounds) : null;
    const extDims = !modelDims && !objDims && ir ? finiteBoxDims(ir.bounds) : null;
    const dims = modelDims || objDims || extDims;
    const dimensionsSource = modelDims ? "model" : (objDims ? "object" : (extDims ? "extrusion" : null));

    const tools = (ir && Array.isArray(ir.tools)) ? ir.tools.map(function (t) {
      return {
        id: t.id,
        material: t.material || "",
        colorHex: t.color ? ("#" + [t.color.r, t.color.g, t.color.b].map(function (c) {
          return Math.max(0, Math.min(255, Math.round(c * 255))).toString(16).padStart(2, "0");
        }).join("").toUpperCase()) : "",
      };
    }) : [{ id: 0, material: "", colorHex: "" }];

    const pMeta = (parseResult && parseResult.metadata) || {};
    const parsedFils = Array.isArray(pMeta.filaments) ? pMeta.filaments : [];
    const inspectFils = (inspectMeta && Array.isArray(inspectMeta.filaments)) ? inspectMeta.filaments : [];
    const mergedFilaments = [];
    const bySlot = new Map();
    for (let i = 0; i < parsedFils.length; i++) {
      const f = parsedFils[i];
      if (f && Number.isInteger(f.slot)) {
        bySlot.set(f.slot, {
          slot: f.slot,
          type: f.type || "",
          colour: (f.color || f.colour || "").toUpperCase(),
          g: f.weightG ?? null,
          m: f.lengthMm != null ? +(f.lengthMm / 1000).toFixed(2) : null,
        });
      }
    }
    for (let i = 0; i < inspectFils.length; i++) {
      const f = inspectFils[i];
      if (!f) continue;
      const slot = Number.isInteger(f.slot) ? f.slot : (Number.isInteger(f.id) && f.id >= 1 ? f.id - 1 : i);
      const prev = bySlot.get(slot) || { slot: slot, type: "", colour: "", g: null, m: null };
      bySlot.set(slot, {
        slot: slot,
        type: f.type || prev.type,
        colour: (f.colour || f.color || prev.colour || "").toUpperCase(),
        g: f.g ?? prev.g,
        m: f.m ?? prev.m,
      });
    }
    Array.from(bySlot.keys()).sort(function (a, b) { return a - b; }).forEach(function (k) {
      mergedFilaments.push(bySlot.get(k));
    });

    const hasParsedColors = hasUsableFilamentColors(pMeta);
    const hasInspectColors = !!buildFilamentPaletteFromMeta(inspectMeta);
    const colorSource = hasParsedColors ? "gcode" : (hasInspectColors ? "slice_info" : "none");

    let feedRange = null;
    if (ir && extra && typeof extra.feedrateRange === "function") {
      try { feedRange = extra.feedrateRange(ir); } catch (_) {}
    }

    return {
      layerCount: layers.length,
      segmentCount: ir && ir.segments ? ir.segments.count : 0,
      layerZs: layerZs,
      dimensionsMm: dims,
      dimensionsSource: dimensionsSource,
      tools: tools.length ? tools : [{ id: 0, material: "", colorHex: "" }],
      filaments: mergedFilaments,
      filamentUsage: pMeta.filamentUsage || null,
      colorSource: colorSource,
      hasParsedFilamentColors: hasParsedColors,
      availableColorModes: (ctrlState && Array.isArray(ctrlState.availableColorModes))
        ? ctrlState.availableColorModes.slice()
        : ["single", "tool", "moveKind"],
      capabilities: (ir && ir.header && ir.header.capabilities) ? Object.assign({}, ir.header.capabilities) : {},
      hasRetractions: !!(ctrlState && ctrlState.hasRetractions),
      hasColorChanges: !!(ctrlState && ctrlState.hasColorChanges),
      totalTimeMs: (ctrlState && ctrlState.totalTimeMs != null) ? ctrlState.totalTimeMs : null,
      timeEstimateSource: (ctrlState && ctrlState.timeEstimateSource) || null,
      complete: ir && ir.header ? ir.header.complete !== false : true,
      stopReason: (ctrlState && ctrlState.summary && ctrlState.summary.stopReason) || null,
      disclosure: (ctrlState && ctrlState.disclosure) || "",
      feedrateRange: feedRange,
      warningsCount: (ir && ir.header && Array.isArray(ir.header.warnings)) ? ir.header.warnings.length : 0,
      dialects: Array.isArray(pMeta.dialects) ? pMeta.dialects.slice() : [],
      machineDiscovered: extra && extra.machineDiscovered ? extra.machineDiscovered : null,
      machineMismatch: extra && extra.machineMismatch ? extra.machineMismatch : "",
    };
  }

  function defaultEngineLoader() {
    return import(assetUrl("vendor-gcode-preview.mjs"));
  }

  function createGcodeViewer(container, options) {
    const opts = options || {};
    const constrained = typeof opts.constrained === "boolean" ? opts.constrained : isConstrainedDevice();
    const maxBytes = opts.maxBytes || (constrained ? DEFAULT_MAX_BYTES_MOBILE : DEFAULT_MAX_BYTES_DESKTOP);
    const engineLoader = opts.engineLoader || defaultEngineLoader;
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    const onStatus = typeof opts.onStatus === "function" ? opts.onStatus : null;
    const onFallback = typeof opts.onFallback === "function" ? opts.onFallback : null;
    const onStateChange = typeof opts.onStateChange === "function" ? opts.onStateChange : null;

    let disposed = false;
    let loadSeq = 0;
    let activeAbort = null;
    let controller = null;
    let engine = null;
    let canvas = null;
    let unsubEvents = null;
    let unsubState = null;
    let currentSummary = null;
    let currentInspectMeta = null;
    let currentColorMode = opts.colorMode || "feature";
    let showTravel = opts.showTravel !== false;
    let showRetractions = !!opts.showRetractions;
    let showVolumeCage = opts.showVolumeCage !== false;
    let buildVolume = opts.buildVolume || null;
    let toolColors = opts.toolColors || null;
    let currentMachineDiscovered = null;
    let currentMachineMismatch = "";
    let hiddenPaused = false;

    function createCanvas() {
      const c = document.createElement("canvas");
      c.className = "p3d-gcode-canvas";
      c.setAttribute("aria-label", "Aperçu G-code 3D interactif");
      c.setAttribute("tabindex", "0");
      c.style.width = "100%";
      c.style.height = "100%";
      c.style.display = "block";
      return c;
    }

    function handleVisibility() {
      if (disposed || !controller) return;
      hiddenPaused = !!(typeof document !== "undefined" && document.hidden);
      if (!hiddenPaused) {
        resize();
      }
    }

    function handleContextLost(ev) {
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      if (disposed) return;
      if (onStatus) onStatus({ kind: "contextlost", message: "Contexte WebGL interrompu…" });
    }

    function handleContextRestored() {
      if (disposed) return;
      if (onStatus) onStatus({ kind: "restored", message: "Contexte WebGL restauré." });
    }

    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    async function ensureController() {
      if (disposed) throw new Error("Viewer disposed");
      if (!engine) {
        engine = await engineLoader();
      }
      if (disposed) throw new Error("Viewer disposed");
      if (controller) return controller;

      canvas = createCanvas();
      if (typeof canvas.addEventListener === "function") {
        canvas.addEventListener("webglcontextlost", handleContextLost);
        canvas.addEventListener("webglcontextrestored", handleContextRestored);
      }
      if (container && typeof container.replaceChildren === "function") {
        container.replaceChildren(canvas);
      } else if (container && typeof container.append === "function") {
        container.innerHTML = "";
        container.append(canvas);
      }

      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) ? window.devicePixelRatio : 1;
      const pixelRatio = opts.pixelRatio !== undefined
        ? opts.pixelRatio
        : (constrained ? Math.min(dpr, 1.5) : "device");

      const createWorker = opts.createWorker || (function () {
        return new Worker(assetUrl("vendor-gcode-worker.js"));
      });

      const rendererCfg = {
        mode: "3d",
        quality: "auto",
        qualityMode: "adaptive",
        progressivePreview: "lines",
        cameraFov: engine.STUDIO_CAMERA_FOV || 32,
        pixelRatio: pixelRatio,
        interactionQuality: "auto",
        geometryConcurrency: constrained ? "off" : "auto",
        theme: typeof engine.studioTheme === "function" ? engine.studioTheme("dark") : undefined,
        ...(constrained ? { geometryMemoryBudgetBytes: 64 * 1024 * 1024 } : {}),
        ...(buildVolume ? { buildVolume: buildVolume } : {}),
        ...(opts.rendererOptions || {}),
      };

      const makeCtrl = opts.createController || engine.createPreviewController;
      controller = makeCtrl({
        createWorker: createWorker,
        renderer: rendererCfg,
      });

      unsubEvents = controller.onEvent(function (ev) {
        if (disposed) return;
        if (ev.type === "parse-progress" && onProgress) {
          const p = ev.progress || {};
          onProgress({ phase: p.phase || "parsing", loaded: p.bytesProcessed || 0, total: p.totalBytes || 0 });
        } else if (ev.type === "stage" && onProgress) {
          onProgress({ phase: ev.stage, fraction: ev.progress, detail: ev.detail });
        } else if (ev.type === "machine-geometry-discovered") {
          currentMachineDiscovered = ev.machine || null;
          // If the file uses a centered coordinate system (negative min) while the printer bed
          // has matching dimensions at [0..x], align the plate origin cleanly to the file's bed.
          if (ev.machine && ev.machine.bed && ev.machine.bed.kind === "rect" && buildVolume) {
            const b = ev.machine.bed;
            const fw = b.max.x - b.min.x;
            const fh = b.max.y - b.min.y;
            if ((b.min.x < -1 || b.min.y < -1) && Math.abs(fw - buildVolume.x) <= 2 && Math.abs(fh - buildVolume.y) <= 2) {
              try { controller.controls.setBuildVolume(ev.machine); } catch (_) {}
            }
          }
        } else if (ev.type === "error") {
          if (ev.code === "machine-geometry-mismatch") {
            currentMachineMismatch = ev.message || "Le volume du fichier diffère du plateau sélectionné.";
            if (currentSummary) currentSummary.machineMismatch = currentMachineMismatch;
            if (onStatus) onStatus({ kind: "mismatch", message: currentMachineMismatch });
          } else if (ev.code === "E_RENDERER_LOAD") {
            if (onFallback) onFallback({ code: ev.code, reason: ev.reason || "start", message: ev.message });
          } else if (onStatus) {
            onStatus({ kind: "error", code: ev.code, message: ev.message });
          }
        } else if (ev.type === "buildComplete") {
          if (currentSummary) {
            const st = controller.getState();
            currentSummary.disclosure = st.disclosure || "";
          }
          if (onStatus) onStatus({ kind: "buildComplete", summary: currentSummary });
        } else if (ev.type === "qualityFallback" && onStatus) {
          onStatus({ kind: "qualityFallback", from: ev.from, to: ev.to, reason: ev.reason });
        }
      });

      unsubState = controller.onStateChange(function (st) {
        if (disposed) return;
        if (currentSummary && st.disclosure !== undefined) {
          currentSummary.disclosure = st.disclosure || "";
        }
        if (onStateChange) onStateChange(st, currentSummary);
      });

      controller.bindCanvas(canvas);
      return controller;
    }

    function applyColorModeInternal(modeName, extraOpts) {
      if (disposed || !controller) return false;
      currentColorMode = modeName || "filament";
      const st = controller.getState();
      const avail = st.availableColorModes || [];
      if ((currentColorMode === "feature" || currentColorMode === "feedrate")
          && avail.length && avail.indexOf(currentColorMode) === -1) {
        return false;
      }
      const spec = computeColorModeSpec(currentColorMode, {
        hasParsedFilamentColors: currentSummary ? currentSummary.hasParsedFilamentColors : false,
        inspectMeta: currentInspectMeta,
        toolColors: (extraOpts && extraOpts.toolColors) || toolColors,
      });
      return controller.controls.setColorMode(spec);
    }

    async function load(loadOpts) {
      if (disposed) return { ok: false, cancelled: true };
      const lo = loadOpts || {};
      const seq = ++loadSeq;
      currentInspectMeta = lo.meta || null;
      currentMachineDiscovered = null;
      currentMachineMismatch = "";

      if (activeAbort) {
        try { activeAbort.abort(); } catch (_) {}
        activeAbort = null;
      }
      if (controller) {
        try { controller.cancel(); } catch (_) {}
      }

      const abortCtl = typeof AbortController !== "undefined" ? new AbortController() : null;
      activeAbort = abortCtl;
      let onExtAbort = null;
      if (lo.signal && abortCtl) {
        if (lo.signal.aborted) {
          abortCtl.abort();
          return { ok: false, cancelled: true };
        }
        onExtAbort = function () { abortCtl.abort(); };
        lo.signal.addEventListener("abort", onExtAbort, { once: true });
      }

      try {
        let bytes = lo.bytes ? (lo.bytes instanceof Uint8Array ? lo.bytes : new Uint8Array(lo.bytes)) : null;
        if (!bytes) {
          const plate = lo.plate != null ? lo.plate : 1;
          const url = lo.url || ("/api/print3d/models/gcode?id=" + encodeURIComponent(lo.modelId || "") + "&plate=" + encodeURIComponent(String(plate)));
          bytes = await fetchGcodeBytes(
            url,
            abortCtl ? abortCtl.signal : lo.signal,
            maxBytes,
            onProgress,
            opts.fetchFn
          );
        }
        if (disposed || seq !== loadSeq) return { ok: false, cancelled: true };

        const ctrl = await ensureController();
        if (disposed || seq !== loadSeq) return { ok: false, cancelled: true };

        if (lo.buildVolume) {
          buildVolume = lo.buildVolume;
          try { ctrl.controls.setBuildVolume(lo.buildVolume); } catch (_) {}
        }

        // Apply default visibility & requested color mode before parse resolves
        ctrl.controls.setKindVisible("travel", showTravel);
        ctrl.controls.setShowRetractions(showRetractions);
        ctrl.controls.setBuildVolumeCage(showVolumeCage);

        const parseLimits = {
          maxInputBytes: maxBytes,
          maxSegments: constrained ? 4_000_000 : 12_000_000,
          maxBufferBytes: constrained ? 384 * 1024 * 1024 : 1024 * 1024 * 1024,
        };
        const outcome = await ctrl.parse(bytes, { limits: parseLimits });
        if (disposed || seq !== loadSeq) return { ok: false, cancelled: true };

        if (!outcome || !outcome.ok) {
          if (outcome && outcome.cancelled) return { ok: false, cancelled: true };
          const errObj = (outcome && outcome.error) || { code: "E_PARSE", message: "Impossible d'analyser ce G-code." };
          const err = new Error(errObj.message || "Impossible d'analyser ce G-code.");
          err.code = errObj.code || "E_PARSE";
          throw err;
        }

        const ctrlState = ctrl.getState();
        currentSummary = buildSummary(outcome.result, ctrlState, currentInspectMeta, {
          feedrateRange: engine && engine.feedrateRange,
          machineDiscovered: currentMachineDiscovered,
          machineMismatch: currentMachineMismatch,
        });

        // Pick best available color mode if requested mode isn't supported by this file
        const avail = currentSummary.availableColorModes;
        let effectiveMode = currentColorMode;
        if ((effectiveMode === "feature" || effectiveMode === "feedrate") && avail.indexOf(effectiveMode) === -1) {
          effectiveMode = currentSummary.colorSource !== "none" ? "filament" : "moveKind";
        }
        applyColorModeInternal(effectiveMode);

        if (lo.layerRange && Array.isArray(lo.layerRange)) {
          ctrl.controls.setLayerRange(lo.layerRange[0], lo.layerRange[1]);
        }

        return { ok: true, summary: currentSummary, colorMode: effectiveMode };
      } catch (err) {
        if (err && (err.name === "AbortError" || err.code === "E_CANCELLED") && (disposed || seq !== loadSeq || (lo.signal && lo.signal.aborted))) {
          return { ok: false, cancelled: true };
        }
        throw err;
      } finally {
        if (lo.signal && onExtAbort) {
          try { lo.signal.removeEventListener("abort", onExtAbort); } catch (_) {}
        }
        if (activeAbort === abortCtl) activeAbort = null;
      }
    }

    function setLayerRange(startLayer, endLayer) {
      if (disposed || !controller) return;
      const s = Number.isFinite(startLayer) ? Math.max(0, Math.floor(startLayer)) : 0;
      const e = Number.isFinite(endLayer) ? Math.max(s, Math.floor(endLayer)) : Infinity;
      controller.controls.setLayerRange(s, e);
    }

    function setLayer(layerIdx, accumulated) {
      const idx = Math.max(0, Math.floor(Number(layerIdx) || 0));
      setLayerRange(accumulated ? 0 : idx, idx);
    }

    function getLayerZ(layerIdx) {
      if (!currentSummary || !currentSummary.layerZs) return null;
      const idx = Math.floor(Number(layerIdx) || 0);
      if (idx < 0 || idx >= currentSummary.layerZs.length) return null;
      return currentSummary.layerZs[idx];
    }

    function setColorMode(modeName, extraOpts) {
      if (extraOpts && Array.isArray(extraOpts.toolColors)) toolColors = extraOpts.toolColors;
      return applyColorModeInternal(modeName, extraOpts);
    }

    function setShowTravel(visible) {
      showTravel = !!visible;
      if (!disposed && controller) controller.controls.setKindVisible("travel", showTravel);
    }

    function setShowRetractions(visible) {
      showRetractions = !!visible;
      if (!disposed && controller) controller.controls.setShowRetractions(showRetractions);
    }

    function setShowVolumeCage(visible) {
      showVolumeCage = !!visible;
      if (!disposed && controller) controller.controls.setBuildVolumeCage(showVolumeCage);
    }

    function setFeatureRoleVisible(role, visible) {
      if (!disposed && controller) controller.controls.setFeatureRoleVisible(role, !!visible);
    }

    function setScrub(segIndexOrNull) {
      if (!disposed && controller) {
        controller.controls.setScrubPosition(segIndexOrNull == null ? null : Math.max(-1, Math.floor(segIndexOrNull)));
      }
    }

    function setView(view) {
      if (!disposed && controller) controller.controls.setView(view);
    }

    function resetCamera() {
      if (disposed || !controller) return;
      controller.controls.setView("iso");
      controller.controls.frame();
    }

    function setBuildVolume(def) {
      buildVolume = def || null;
      if (!disposed && controller && def) controller.controls.setBuildVolume(def);
    }

    function resize() {
      if (disposed || !controller || !canvas) return;
      const r = controller.raw && typeof controller.raw.renderer === "function" ? controller.raw.renderer() : null;
      if (r && typeof r.resize === "function") {
        const w = canvas.clientWidth || (container && container.clientWidth) || 640;
        const h = canvas.clientHeight || (container && container.clientHeight) || 460;
        if (w > 0 && h > 0) r.resize(w, h);
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      loadSeq += 1;
      if (activeAbort) {
        try { activeAbort.abort(); } catch (_) {}
        activeAbort = null;
      }
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
      if (canvas && typeof canvas.removeEventListener === "function") {
        canvas.removeEventListener("webglcontextlost", handleContextLost);
        canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      }
      if (unsubEvents) { try { unsubEvents(); } catch (_) {} unsubEvents = null; }
      if (unsubState) { try { unsubState(); } catch (_) {} unsubState = null; }
      if (controller) {
        try { controller.cancel(); } catch (_) {}
        try { controller.dispose(); } catch (_) {}
        controller = null;
      }
      if (canvas && typeof canvas.remove === "function") {
        try { canvas.remove(); } catch (_) {}
      }
      if (container && typeof container.replaceChildren === "function") {
        try { container.replaceChildren(); } catch (_) {}
      }
      canvas = null;
      currentSummary = null;
      currentInspectMeta = null;
      currentMachineDiscovered = null;
    }

    return {
      load: load,
      setLayerRange: setLayerRange,
      setLayer: setLayer,
      getLayerZ: getLayerZ,
      setColorMode: setColorMode,
      setShowTravel: setShowTravel,
      setShowRetractions: setShowRetractions,
      setShowVolumeCage: setShowVolumeCage,
      setFeatureRoleVisible: setFeatureRoleVisible,
      setScrub: setScrub,
      setView: setView,
      resetCamera: resetCamera,
      setBuildVolume: setBuildVolume,
      resize: resize,
      getSummary: function () { return currentSummary; },
      getState: function () { return controller ? controller.getState() : null; },
      isDisposed: function () { return disposed; },
      dispose: dispose,
    };
  }

  const api = {
    createGcodeViewer: createGcodeViewer,
    FEATURE_LEGEND: FEATURE_LEGEND,
    SPEED_RAMP: SPEED_RAMP,
    TOOL_PALETTE: TOOL_PALETTE,
    TOOL_PALETTE_HEX: TOOL_PALETTE_HEX,
    computeColorModeSpec: computeColorModeSpec,
    isConstrainedDevice: isConstrainedDevice,
    hexToRgb01: hexToRgb01,
  };

  root.HQGcode = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
