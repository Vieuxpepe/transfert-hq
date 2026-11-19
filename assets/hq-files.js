/* Transfert HQ — Fichiers: a visual file browser.
 *
 * Folders are real folders (a tab in their root's colour, pictures peeking out), files are paper cards with a folded
 * corner and a type stamp; images show themselves. Click a file for a quick look (image, PDF, text, audio, video) with
 * rename, move, download, print and Corbeille. Drop files from the computer to upload them where you are (or onto a
 * folder), drag cards onto folders or breadcrumb tabs to move them, select several (Ctrl/Shift-click, long press or
 * « Sélection ») to move or delete together. « Supprimer » goes to a Corbeille that can be undone (30 days).
 *
 * Takes over the Fichiers list in place: navigate() / refreshFiles() stay the HQ entry points (the Accueil uploads,
 * the favourites and the search still call them). Talks to /api/list, /api/rename, /api/move, /api/mkdir, /api/read,
 * /api/write, /api/print, the chunked /api/upload/*, /api/files (Corbeille) and /api/files/peek. Never builds HTML from
 * strings. Plain ES2020; pure helpers exported for Node tests (tests/check_hq_files.mjs).
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else {
    root.HqFiles = api;
    if (root.document) api.start(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const ROOT_HUE = { Inbox: 168, Uni: 262, Print: 34 };
  const FAMILIES = [
    ["image", "Image", 150, ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic", "heif", "svg"]],
    ["pdf", "PDF", 4, ["pdf"]],
    ["doc", "Document", 214, ["doc", "docx", "odt", "rtf", "pages"]],
    ["sheet", "Tableur", 140, ["xls", "xlsx", "xlsm", "ods", "csv", "numbers"]],
    ["slides", "Présentation", 24, ["ppt", "pptx", "odp", "key"]],
    ["text", "Texte", 210, ["txt", "md", "log", "srt", "ini", "cfg", "yml", "yaml", "xml"]],
    ["code", "Code", 280, ["py", "js", "mjs", "ts", "css", "html", "htm", "json", "c", "cpp", "h", "java", "sh", "bat", "ps1", "m"]],
    ["audio", "Audio", 330, ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma"]],
    ["video", "Vidéo", 18, ["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv"]],
    ["model", "3D", 190, ["stl", "glb", "gltf", "obj", "step", "stp", "3mf", "f3d", "sldprt", "dxf", "dwg"]],
    ["archive", "Archive", 36, ["zip", "rar", "7z", "tar", "gz", "bz2"]],
  ];
  const EDITABLE = /\.(txt|md|csv|json|log|py|css|js|html?|xml|ya?ml|ini|cfg|srt)$/i;
  const PLAYABLE = /\.(mp3|m4a|aac|wav|flac|ogg|opus|mp4|m4v|mov|webm|glb|stl)$/i;
  // what the Lecteur takes: the playable files, plus containers it explains (« ne se lit pas dans un navigateur »)
  const FOR_LECTEUR = /\.(mp3|m4a|aac|wav|flac|ogg|opus|mp4|m4v|mov|webm|glb|stl|mkv|avi|wmv|flv|wma|mpg|mpeg|vob)$/i;
  const TRASH = "\u0000corbeille"; // a view, never a path
  const DOUBLE_TAP_MS = 300;
  const BAD_NAME = /[\\/:*?"<>|\x00-\x1f]/;

  // ------------------------------------------------------------------ pure helpers

  function extOf(name) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ""));
    return m ? m[1].toLowerCase() : "";
  }

  /** {family, label, hue, ext} for a file name. */
  function kindOf(name) {
    const ext = extOf(name);
    for (const [family, label, hue, exts] of FAMILIES) if (exts.includes(ext)) return { family, label, hue, ext };
    return { family: "file", label: "Fichier", hue: 220, ext };
  }

  function rootHue(rel) {
    return ROOT_HUE[String(rel || "").split("/")[0]] || 210;
  }

  function parentOf(rel) {
    const p = String(rel || "").split("/").filter(Boolean);
    p.pop();
    return p.join("/");
  }

  function joinRel(a, b) {
    return [a, b].filter(Boolean).join("/");
  }

  /** Is ``rel`` the folder ``dir`` itself or inside it? */
  function within(rel, dir) {
    return rel === dir || String(rel).startsWith(dir + "/");
  }

  /** Folders first, then by name (natural, accents ignored), by date (newest) or by size (largest). */
  function sortItems(items, mode) {
    const name = (a, b) => a.name.localeCompare(b.name, "fr", { numeric: true, sensitivity: "base" });
    const out = items.slice();
    out.sort((a, b) => {
      if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
      if (mode === "recent") return (b.mtime || 0) - (a.mtime || 0) || name(a, b);
      if (mode === "size") return (b.size || 0) - (a.size || 0) || name(a, b);
      return name(a, b);
    });
    return out;
  }

  function fold(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function filterItems(items, q) {
    const words = fold(q).split(/\s+/).filter(Boolean);
    if (!words.length) return items;
    return items.filter((i) => words.every((w) => fold(i.name).includes(w)));
  }

  function matchPill(it, filterId) {
    if (!filterId) return true;
    if (it.type === "dir") return false;
    const kd = kindOf(it.name);
    if (filterId === "image") return kd.family === "image";
    if (filterId === "doc_pdf") return kd.family === "pdf" || kd.family === "doc" || kd.family === "sheet" || kd.family === "slides" || kd.family === "text";
    if (filterId === "audio") return kd.family === "audio";
    if (filterId === "video") return kd.family === "video";
    if (filterId === "model") return kd.family === "model";
    if (filterId === "code") return kd.family === "code";
    return kd.family === filterId;
  }

  function countPillMatches(items, filterId) {
    if (!filterId) return items.length;
    let n = 0;
    for (const it of items) if (matchPill(it, filterId)) n += 1;
    return n;
  }

  function isLensMatch(it, lens, now, dupRels) {
    if (!lens || lens === "none" || !it || it.type === "dir") return false;
    if (lens === "heavy") return (it.size || 0) >= 50 * 1048576;
    if (lens === "zero") return (it.size || 0) === 0;
    if (lens === "recent") return (now - (it.mtime || 0)) <= 7200;
    if (lens === "duplicates") {
      if (dupRels && (dupRels.has ? dupRels.has(it.rel) : dupRels.includes(it.rel))) return true;
      if (typeof S !== "undefined" && S.dupRels && S.dupRels.has(it.rel)) return true;
    }
    return false;
  }

  function computeBatchRenames(names, mode, opts) {
    opts = opts || {};
    return (names || []).map((name, i) => {
      const extDot = name.lastIndexOf(".");
      const stem = extDot > 0 ? name.slice(0, extDot) : name;
      const ext = extDot > 0 ? name.slice(extDot) : "";
      let newStem = stem;

      if (mode === "prefix_suffix") {
        newStem = (opts.prefix || "") + stem + (opts.suffix || "");
      } else if (mode === "find_replace") {
        if (opts.find) {
          newStem = stem.split(opts.find).join(opts.replace || "");
        }
      } else if (mode === "sequence") {
        const start = Number(opts.start) || 1;
        const pad = Math.max(1, Number(opts.pad) || 2);
        const base = (opts.stem || "fichier").trim();
        newStem = base + "_" + String(start + i).padStart(pad, "0");
      } else if (mode === "case") {
        if (opts.target === "kebab") {
          newStem = stem.replace(/[\s_]+/g, "-").toLowerCase();
        } else if (opts.target === "snake") {
          newStem = stem.replace(/[\s-]+/g, "_").toLowerCase();
        } else {
          newStem = stem.toLowerCase();
        }
      }
      return { oldName: name, newName: (newStem || stem) + ext };
    });
  }

  /** Shift-click: every rel between the anchor and the target, in display order. */
  function rangeSelect(order, anchor, target) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(target);
    if (a < 0 || b < 0) return [target];
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return order.slice(lo, hi + 1);
  }

  function validName(name) {
    const n = String(name || "").trim();
    return !!n && n.length <= 200 && !BAD_NAME.test(n) && n !== "." && n !== "..";
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return Math.round(n) + " o";
    if (n < 1048576) return (n / 1024).toFixed(1).replace(".", ",") + " Ko";
    if (n < 1073741824) return (n / 1048576).toFixed(1).replace(".", ",") + " Mo";
    return (n / 1073741824).toFixed(2).replace(".", ",") + " Go";
  }

  function when(ts, now) {
    const s = Math.max(0, now - ts);
    if (s < 60) return "à l'instant";
    if (s < 3600) return "il y a " + Math.floor(s / 60) + " min";
    if (s < 86400) return "il y a " + Math.floor(s / 3600) + " h";
    const d = Math.floor(s / 86400);
    if (d === 1) return "hier";
    if (d < 7) return "il y a " + d + " j";
    const t = new Date(ts * 1000);
    const mo = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."][t.getMonth()];
    return t.getDate() + " " + mo + (t.getFullYear() !== new Date(now * 1000).getFullYear() ? " " + t.getFullYear() : "");
  }

  /** Where an upload goes: the folder you are in, or Inbox from the top level. */
  function uploadTarget(rel) {
    return rel && rel !== TRASH ? rel : "Inbox";
  }

  const fileUrl = (rel) => "/files/" + String(rel).split("/").map(encodeURIComponent).join("/");
  const dlUrl = (rel) => "/download/" + String(rel).split("/").map(encodeURIComponent).join("/");
  const mediaUrl = (rel) => "/media/" + String(rel).split("/").map(encodeURIComponent).join("/");

  const EVERY_LABEL = { hour: "Toutes les heures", day: "Chaque jour", week: "Chaque semaine" };
  const EVERY_SHORT = { hour: "toutes les heures", day: "chaque jour", week: "chaque semaine" };

  function untilText(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (sec < 60) return "dans un instant";
    if (sec < 3600) return "dans " + Math.round(sec / 60) + " min";
    if (sec < 86400) return "dans " + Math.round(sec / 3600) + " h";
    return "dans " + Math.round(sec / 86400) + " j";
  }

  /** One line about an automatic backup: {tone: run | bad | paused | ok | wait | none, text}. */
  function bkStatus(job, now) {
    if (!job) return { tone: "none", text: "" };
    const r = job.running;
    if (r && r.kind === "backup") return { tone: "run", text: r.total ? "Copie en cours… " + Math.round((100 * r.done) / r.total) + " %" : "Copie en cours…" };
    if (r && r.kind === "restore") return { tone: "run", text: "Restauration en cours…" };
    if (r) return { tone: "run", text: "Copie en attente…" };
    if (job.missing) return { tone: "bad", text: "Dossier introuvable — déplacé hors de Transfert ou supprimé ?" };
    if (job.last_error) return { tone: "bad", text: job.last_error };
    if (!job.enabled) return { tone: "paused", text: "En pause" };
    const n = (job.snapshots || []).length;
    const last = job.last_backup_at ? "Dernière copie " + when(job.last_backup_at, now) : "Aucune copie encore";
    const next = job.next_at ? " · prochaine " + untilText(job.next_at - now) : "";
    return { tone: n ? "ok" : "wait", text: last + next };
  }

  const EVERY_SEC = { hour: 3600, day: 86400, week: 604800 };
  const DAYS_SHORT = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
  const MONTHS_SHORT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

  /** « maintenant », then the next copies: 22 h 45 (hourly), demain 21 h 45 / lun. 21 h 45 (daily), 7 nov. (weekly). */
  function nextTimes(every, now, n) {
    const step = EVERY_SEC[every] || EVERY_SEC.day;
    const base = new Date(now * 1000);
    const out = ["maintenant"];
    for (let k = 1; k < n; k += 1) {
      const d = new Date((now + k * step) * 1000);
      const hm = d.getHours() + " h " + String(d.getMinutes()).padStart(2, "0");
      if (every === "hour") out.push(hm);
      else if (every === "week") out.push(d.getDate() + " " + MONTHS_SHORT[d.getMonth()]);
      else {
        const days = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(base.getFullYear(), base.getMonth(), base.getDate())) / 86400000);
        out.push((days === 1 ? "demain" : DAYS_SHORT[d.getDay()]) + " " + hm);
      }
    }
    return out;
  }

  /** How far along the wait for the next copy is (0 → 1), for the ring around the shield. */
  function ringFrac(job, now) {
    if (!job || !job.last_run_at) return 0;
    return Math.max(0, Math.min(1, (now - job.last_run_at) / (EVERY_SEC[job.every] || EVERY_SEC.day)));
  }

  const pure = { untilText, bkStatus, nextTimes, ringFrac, EVERY_LABEL, extOf, kindOf, matchPill, isLensMatch, computeBatchRenames, rootHue, parentOf, joinRel, within, sortItems, filterItems, rangeSelect, validName, fmtBytes, when, uploadTarget, fileUrl, dlUrl, mediaUrl, TRASH };

  // ------------------------------------------------------------------ browser layer

  const S = {
    started: false, win: null, doc: null, app: null, rel: "", items: [], crumbs: [], loading: false, error: "",
    view: "grid", sort: "name", q: "", familyFilter: "", lens: "none", sel: new Set(), anchor: "", selecting: false, peeks: new Map(), trash: null,
    pins: new Set(), tags: new Map(), dupRels: new Set(),
    history: [""], histIdx: 0, dualMode: false, dualActive: "left", relLeft: "", relRight: "Inbox",
    stash: new Set(), stashDockEl: null, stashBadgeEl: null, zeroCelebrated: false,
    enter: true, spillFrom: null, landed: new Set(), sheet: null, uploads: [], drag: null, toastEl: null, toastTimer: 0,
    listEl: null, barEl: null, trayEl: null, dropEl: null, pillsEl: null, telemetryEl: null, lensBarEl: null, marqueeEl: null, lensBtn: null, focusRel: "", ql: null, peekToken: 0,
  };

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICON = {
    grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    list: "M4 6h16M4 12h16M4 18h16",
    upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
    folderPlus: "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5zM12 11v5M9.5 13.5h5",
    check: "M5 12.5l4.2 4.2L19 7",
    select: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM15 17l2 2 3-4",
    trash: "M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13",
    move: "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5zM10 13.5h6M13.5 11l2.5 2.5-2.5 2.5",
    close: "M6 6l12 12M18 6L6 18",
    open: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
    download: "M12 4v12M7 11l5 5 5-5M5 20h14",
    edit: "M4 20l1.2-4.6L15.8 4.8a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8zM4 20h7",
    print: "M7 8V4h10v4M6 17H4v-7h16v7h-2M7 14h10v6H7z",
    play: "M8 5v14l11-7z",
    left: "M15 6l-6 6 6 6",
    right: "M9 6l6 6-6 6",
    up: "M12 19V5M6 11l6-6 6 6",
    restore: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4",
    search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.6-4.6",
    home: "M4 10.5 12 4l8 6.5V20H4z",
    shield: "M12 3l7 3v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6z",
    shieldOk: "M12 3l7 3v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6zM8.8 12.2l2.2 2.2 4.2-4.4",
    pause: "M8 5v14M16 5v14",
    minus: "M6 12h12",
    plus: "M12 6v12M6 12h12",
    zip: "M4 5h16v4H4zM5 9v10h14V9M10 13h4M12 11v4",
    cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
    book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5z",
    sparkles: "M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM19 16l.9 2.1 2.1.9-2.1.9L19 22l-.9-2.1-2.1-.9 2.1-.9z",
    pin: "M16 3l5 5-3 3-1-1-4 4v4l-2 2-2-2 4-4-1-1-4 4-2-2 3-3-1-1 4-4z",
    columns: "M4 4h7v16H4zm9 0h7v16h-7z",
    copy: "M8 4h10a2 2 0 0 1 2 2v10M4 8h10a2 2 0 0 1 2 2v10H4z",
    clock: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 10.4 3.5 2.1-.8 1.3-4.2-2.5V7h1.5z",
    mic: "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm5 9a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z",
    camera: "M4 7h4l2-3h4l2 3h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm8 11a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
    link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    stash: "M4 4h16v4H4zm2 5h12v11H6zM9 12h6",
  };
  const FAMILY_ICON = {
    image: "M5 5h14v14H5zM9 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5 17l4.5-4.5 3.5 3.5 2.5-2.5L19 17",
    pdf: "M7 3.5h7l4 4V20H7zM14 3.5V8h4M9.5 15.5h5M9.5 12h5",
    doc: "M7 3.5h7l4 4V20H7zM14 3.5V8h4M9.5 11h5M9.5 14h5M9.5 17h3",
    sheet: "M5 5h14v14H5zM5 10h14M5 15h14M10 5v14M15 5v14",
    slides: "M4 5h16v11H4zM12 16v4M8 20h8",
    text: "M6 6h12M6 10h12M6 14h9M6 18h6",
    code: "M9 8l-4 4 4 4M15 8l4 4-4 4M13.5 5l-3 14",
    audio: "M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
    video: "M4 6h12v12H4zM16 10l4-2.5v9L16 14",
    model: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
    archive: "M4 5h16v4H4zM5 9v10h14V9M10 13h4",
    file: "M7 3.5h7l4 4V20H7zM14 3.5V8h4",
  };

  function el(tag, attrs, kids) {
    const n = S.doc.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "text") n.textContent = String(v);
      else if (k === "on") for (const ev of Object.keys(v)) n.addEventListener(ev, v[ev]);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids || []) if (c) n.appendChild(typeof c === "string" ? S.doc.createTextNode(c) : c);
    return n;
  }

  function svgPath(d, cls) {
    const s = S.doc.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    s.setAttribute("class", "fx-ico" + (cls ? " " + cls : ""));
    const p = S.doc.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.8");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    s.appendChild(p);
    return s;
  }
  const icon = (name, cls) => svgPath(ICON[name] || FAMILY_ICON[name] || FAMILY_ICON.file, cls);

  function btn(label, o) {
    o = o || {};
    const b = el("button", { type: "button", class: o.cls || "fx-btn", "aria-label": o.aria || null, title: o.title || null, on: o.on ? { click: o.on } : null });
    if (o.icon) b.appendChild(icon(o.icon));
    if (label) b.appendChild(el("span", { text: label }));
    return b;
  }

  const calm = () => {
    try {
      return S.win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  };
  const fine = () => {
    try {
      return S.win.matchMedia("(hover:hover) and (pointer:fine)").matches;
    } catch (_) {
      return false;
    }
  };

  function anim(node, frames, opts) {
    if (!node || calm() || typeof node.animate !== "function") return null;
    try {
      return node.animate(frames, opts);
    } catch (_) {
      return null;
    }
  }
  const EASE = "cubic-bezier(.2,.8,.2,1)";
  const SPRING = "cubic-bezier(.2,1.35,.35,1)";

  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx && S.win) {
      const AC = S.win.AudioContext || S.win.webkitAudioContext;
      if (AC) {
        try {
          audioCtx = new AC();
        } catch (_) {}
      }
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function mechSound(type) {
    if (calm()) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const t = ctx.currentTime;
      if (type === "click" || type === "tick") {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(1400, t);
        osc.frequency.exponentialRampToValueAtTime(300, t + 0.018);
        g.gain.setValueAtTime(0.04, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.02);
      } else if (type === "switch") {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(1100, t);
        osc.frequency.exponentialRampToValueAtTime(260, t + 0.022);
        g.gain.setValueAtTime(0.06, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.022);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.025);
      } else if (type === "pop") {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(420, t);
        osc.frequency.exponentialRampToValueAtTime(1550, t + 0.032);
        g.gain.setValueAtTime(0.055, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.032);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.035);
      } else if (type === "latch") {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const g = ctx.createGain();
        osc1.type = "sine";
        osc2.type = "triangle";
        osc1.frequency.setValueAtTime(880, t);
        osc1.frequency.exponentialRampToValueAtTime(220, t + 0.05);
        osc2.frequency.setValueAtTime(440, t);
        osc2.frequency.exponentialRampToValueAtTime(110, t + 0.05);
        g.gain.setValueAtTime(0.06, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        osc1.connect(g);
        osc2.connect(g);
        g.connect(ctx.destination);
        osc1.start(t);
        osc2.start(t);
        osc1.stop(t + 0.055);
        osc2.stop(t + 0.055);
      } else if (type === "burst") {
        const freqs = [110, 164.8, 220, 277.2];
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.08, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
        g.connect(ctx.destination);
        freqs.forEach((f) => {
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.setValueAtTime(f, t);
          osc.connect(g);
          osc.start(t);
          osc.stop(t + 0.46);
        });
      } else if (type === "snap" || type === "select") {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(950, t);
        osc.frequency.exponentialRampToValueAtTime(120, t + 0.028);
        g.gain.setValueAtTime(0.05, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.03);
      } else if (type === "drop" || type === "thud") {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(160, t);
        osc.frequency.exponentialRampToValueAtTime(45, t + 0.07);
        g.gain.setValueAtTime(0.07, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.075);
      } else if (type === "lens" || type === "telemetry") {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(440, t);
        osc.frequency.exponentialRampToValueAtTime(880, t + 0.04);
        g.gain.setValueAtTime(0.03, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.045);
      }
    } catch (_) {}
  }

  function buzz(ms) {
    try {
      if (Array.isArray(ms)) {
        mechSound("burst");
      } else {
        mechSound(ms >= 12 ? "drop" : "click");
      }
      if (typeof S.win.hqPolishHaptic === "function") {
        S.win.hqPolishHaptic(Array.isArray(ms) ? "stock" : ms >= 12 ? "drop" : "tick");
        return;
      }
      if (S.win.navigator.vibrate) S.win.navigator.vibrate(ms);
    } catch (_) {}
  }

  function dopamineSurge(rel) {
    if (calm()) return;
    mechSound("burst");
    buzz([20, 60, 25, 45, 30]);
    if (S.doc && S.doc.body) {
      const wave = el("div", { class: "fx-shockwave", "aria-hidden": "true" });
      S.doc.body.appendChild(wave);
      S.win.setTimeout(() => wave.remove(), 1200);
    }
    toast("« Répertoire anéanti, Maître. Le disque respire sous votre coupe. »");
    if (typeof S.win.hqPolishBurst === "function" && S.listEl) {
      S.win.hqPolishBurst(S.listEl);
    }
  }

  function loadStash() {
    try {
      const raw = S.win.localStorage.getItem("hq_files_stash_v1");
      if (raw) S.stash = new Set(JSON.parse(raw));
    } catch (_) {}
  }

  function saveStash() {
    try {
      S.win.localStorage.setItem("hq_files_stash_v1", JSON.stringify(Array.from(S.stash)));
    } catch (_) {}
    paintStashBadge();
  }

  function paintStashBadge() {
    if (!S.stashBadgeEl) return;
    const c = S.stash.size;
    S.stashBadgeEl.textContent = String(c);
    S.stashBadgeEl.hidden = !c;
  }

  function wireStashDrop(dockEl) {
    dockEl.addEventListener("dragover", (ev) => {
      if (!S.drag && (!ev.dataTransfer || !ev.dataTransfer.types || !Array.prototype.includes.call(ev.dataTransfer.types, "Files"))) return;
      ev.preventDefault();
      ev.stopPropagation();
      dockEl.classList.add("is-drop-active");
    });
    dockEl.addEventListener("dragleave", (ev) => {
      if (!dockEl.contains(ev.relatedTarget)) {
        dockEl.classList.remove("is-drop-active");
      }
    });
    dockEl.addEventListener("drop", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      dockEl.classList.remove("is-drop-active");
      if (S.drag && S.drag.rels && S.drag.rels.length) {
        for (const r of S.drag.rels) S.stash.add(r);
        saveStash();
        mechSound("latch");
        buzz([12, 35, 12]);
        toast(S.drag.rels.length > 1 ? S.drag.rels.length + " éléments accrochés à l'établi" : "Élément accroché à l'établi");
        S.drag = null;
      }
    });
  }

  function openStashDrawer() {
    const items = Array.from(S.stash);
    const body = el("div", { class: "fx-stash-body" });
    if (!items.length) {
      body.appendChild(el("p", { class: "fx-hint", style: "padding:24px 12px;text-align:center", text: "L'établi est vide. Glissez n'importe quels fichiers ou dossiers sur l'établi pour les collecter et les déplacer en un clin d'œil." }));
    } else {
      const list = el("div", { class: "fx-stash-list" });
      items.forEach((rel) => {
        const row = el("div", { class: "fx-stash-item" });
        const kd = kindOf(rel);
        const name = rel.split("/").pop();
        const parent = parentOf(rel) || "Racine";
        const removeBtn = btn("", { cls: "fx-btn is-round", icon: "close", title: "Retirer de l'établi", on: () => {
          S.stash.delete(rel);
          saveStash();
          row.remove();
          if (S.stash.size === 0) closeSheet();
        } });
        row.append(
          svgPath(FAMILY_ICON[kd.family] || FAMILY_ICON.file, "fx-stash-item-ico"),
          el("div", { class: "fx-stash-item-meta" }, [
            el("span", { class: "fx-stash-item-name", text: name }),
            el("span", { class: "fx-stash-item-path", text: parent })
          ]),
          removeBtn
        );
        list.appendChild(row);
      });
      body.appendChild(list);
    }

    const actions = [];
    if (items.length) {
      if (S.rel && S.rel !== TRASH) {
        actions.push(btn("Déposer tout ici (" + items.length + ")", {
          cls: "fx-btn is-primary",
          icon: "move",
          on: async () => {
            closeSheet();
            const target = S.rel;
            toast("Déplacement vers « " + (target.split("/").pop() || "Racine") + " »…");
            try {
              await moveTo(items, target);
              S.stash.clear();
              saveStash();
              mechSound("thud");
              buzz([15, 45, 15]);
            } catch (e) {
              toast((e && e.message) || "Erreur de transfert", null, null, true);
            }
          }
        }));
      }
      actions.push(btn("Vider l'établi", {
        cls: "fx-btn is-danger",
        icon: "trash",
        on: () => {
          S.stash.clear();
          saveStash();
          closeSheet();
          toast("Établi vidé");
        }
      }));
    }
    actions.push(btn("Fermer", { on: () => closeSheet() }));
    openSheet("Établi Magnétique Escamotable (" + items.length + ")", body, actions);
  }

  let peepTimer = 0;
  let peepGlassEl = null;

  function hidePeep() {
    if (peepTimer) {
      S.win.clearTimeout(peepTimer);
      peepTimer = 0;
    }
    if (peepGlassEl) {
      peepGlassEl.remove();
      peepGlassEl = null;
    }
  }

  function wireQuickPeep(tile, it) {
    if (calm() || !fine() || it.type === "dir") return;
    if (!EDITABLE.test(it.name) && !(/\.(pdf|doc|docx|csv|tsv|json|py|js|css|html|md|txt)$/i.test(it.name))) return;

    tile.addEventListener("mouseenter", () => {
      hidePeep();
      peepTimer = S.win.setTimeout(async () => {
        try {
          const d = await postJson("/api/read", { rel: it.rel });
          const raw = String(d.content || "");
          const lines = raw.split("\n").slice(0, 8).join("\n");
          if (!lines.trim()) return;
          peepGlassEl = el("div", { class: "fx-peep-glass" }, [
            el("div", { class: "fx-peep-head" }, [
              el("span", { class: "fx-peep-title", text: it.name }),
              el("span", { class: "fx-peep-meta", text: it.size_h })
            ]),
            el("pre", { class: "fx-peep-body", text: lines + (raw.split("\n").length > 8 ? "\n…" : "") })
          ]);
          S.doc.body.appendChild(peepGlassEl);
          const rect = tile.getBoundingClientRect();
          const top = Math.max(12, rect.top - 130);
          const left = Math.min(S.win.innerWidth - 330, Math.max(12, rect.left));
          peepGlassEl.style.top = top + "px";
          peepGlassEl.style.left = left + "px";
          mechSound("tick");
        } catch (_) {}
      }, 380);
    });
    tile.addEventListener("mouseleave", hidePeep);
    tile.addEventListener("pointerdown", hidePeep);
  }

  // ---------------------------------------------------------------- network

  async function call(url, opts) {
    if (typeof S.win.api === "function") return S.win.api(url, opts);
    const res = await S.win.fetch(url, Object.assign({ credentials: "same-origin" }, opts));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error((data && data.error) || "Erreur " + res.status);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }
  const postJson = (url, body) => call(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  function syncGlobals() {
    // the HQ page keeps its own copy of where you are (favourites, notes, captures use it)
    try {
      currentRel = S.rel === TRASH ? "" : S.rel; // eslint-disable-line no-undef
    } catch (_) {}
    try {
      itemsCache = S.items; // eslint-disable-line no-undef
    } catch (_) {}
    const badge = S.doc.getElementById("file-count");
    if (badge) badge.textContent = String(S.rel === TRASH ? (S.trash ? S.trash.items.length : 0) : S.items.length);
  }

  async function load(rel, opts) {
    const o = opts || {};
    const target = rel === undefined ? S.rel : rel;
    const prevCount = S.items.length;
    const prevRel = S.rel;
    if (target !== S.rel) {
      S.enter = true;
      S.sel.clear();
      S.selecting = false;
      S.q = "";
      S.familyFilter = "";
      S.lens = "none";
      if (S.searchEl) S.searchEl.value = "";
    }
    S.loading = true;
    const token = (S.loadToken = (S.loadToken || 0) + 1); // a later navigation wins over a slower earlier one
    try {
      if (target === TRASH) {
        const t = await call("/api/files/trash");
        if (token !== S.loadToken) return;
        S.trash = t;
        S.rel = TRASH;
        S.items = [];
        S.crumbs = [{ name: "Racine", rel: "" }, { name: "Corbeille", rel: TRASH }];
        S.zeroCelebrated = false;
      } else {
        const qs = target ? "?path=" + encodeURIComponent(target) : "";
        const data = await call("/api/list" + qs);
        if (token !== S.loadToken) return;
        if (data.error) throw new Error(data.error);
        S.rel = data.rel || "";
        S.items = data.items || [];
        S.crumbs = data.breadcrumb || [{ name: "Racine", rel: "" }];
        if (target && target !== TRASH && prevRel === target && prevCount > 0 && S.items.length === 0) {
          S.zeroCelebrated = true;
          dopamineSurge(target);
        } else if (target !== prevRel) {
          S.zeroCelebrated = false;
        }
        if (!S.trash) call("/api/files/trash").then((t) => {
          S.trash = t;
          paintTrashCount();
        }, () => {});
      }
      S.error = "";
      if (S.bk && Date.now() - (S.bkLoadedAt || 0) > 30000) loadBackups(true);
      for (const r of [...S.sel]) if (!S.items.some((i) => i.rel === r)) S.sel.delete(r);
    } catch (e) {
      if (token !== S.loadToken) return;
      S.error = (e && e.message) || "Dossier indisponible";
      if (o.fallback !== false && target && target !== TRASH) {
        S.loading = false;
        toast(S.error, null, null, true);
        return load(parentOf(target), { fallback: false });
      }
    } finally {
      if (token === S.loadToken) S.loading = false;
    }
    syncGlobals();
    render();
    peekFolders();
  }

  async function peekFolders() {
    const want = S.items.filter((i) => i.type === "dir").map((i) => i.rel).slice(0, 60);
    if (!want.length) return;
    const token = (S.peekToken += 1);
    try {
      const qs = want.map((r) => "rel=" + encodeURIComponent(r)).join("&");
      const out = await call("/api/files/peek?" + qs);
      if (token !== S.peekToken) return;
      for (const [k, v] of Object.entries(out.folders || {})) S.peeks.set(k, v);
      for (const tile of S.listEl.querySelectorAll(".fx-folder[data-rel]")) paintPeek(tile);
    } catch (_) {
      /* previews are a bonus */
    }
  }

  // ---------------------------------------------------------------- automatic backups (hq_folder_backups.py)
  //
  // « Sauvegarde auto » in a folder sets up a copy every hour/day/week to the backup drive; only the newest N copies
  // (10 by default) are kept. The sheet shows the window as N slots: the newest copy on the left. A copy in progress
  // drops into the first slot and fills like a glass (with a scan light), then seals with a check and a burst of sparks;
  // the others slide right and the oldest tumbles out in a puff of dust. Around the shield, a ring fills up until the
  // next copy. Pausing frosts the copies; « Rien n'a changé » makes the newest copy nod. Folders with a backup wear a
  // shield that glints, orbits while copying and bursts when a copy lands. Every effect is off with reduced motion.

  const EVERY_ICON = {
    hour: "M12 7.5V12l3 2M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z",
    day: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4",
    week: "M4.5 6h15v14h-15zM4.5 10h15M8.5 3.5v4M15.5 3.5v4M8 14h2M12 14h2M8 17h2",
  };
  const SHIELD_D = "M12 3l7 3v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6z";
  const CHECK_D = "M8.6 12.3l2.4 2.4 4.4-4.6";

  function bkNow() {
    return Date.now() / 1000 + (S.bkSkew || 0);
  }

  // ---- little effects (all no-ops with reduced motion)

  function centerOf(n) {
    const r = n.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  /** A burst of confetti from a point; ``dust`` makes it grey and heavy (a copy leaving the window). */
  function bkSparks(x, y, hue, n, opts) {
    if (calm() || typeof S.doc.body.animate !== "function") return;
    const o = opts || {};
    for (let i = 0; i < n; i += 1) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.6;
      const d = (o.spread || 48) * (0.55 + Math.random() * 0.75);
      const p = el("span", { class: "fx-bk-spark" + (o.dust ? " is-dust" : i % 3 === 0 ? " is-dot" : i % 3 === 1 ? " is-long" : ""), "aria-hidden": "true" });
      p.style.left = x + "px";
      p.style.top = y + "px";
      p.style.setProperty("--hue", String(hue + Math.round(Math.random() * 60 - 30)));
      S.doc.body.appendChild(p);
      const dx = Math.cos(a) * d;
      const dy = Math.sin(a) * d - (o.dust ? 0 : 10);
      const r = Math.round(Math.random() * 360);
      const an = p.animate([
        { transform: "translate(0,0) rotate(" + r + "deg) scale(" + (o.dust ? 0.6 : 1) + ")", opacity: 1 },
        { transform: "translate(" + dx + "px," + dy + "px) rotate(" + (r + 200) + "deg) scale(1)", opacity: 1, offset: 0.5 },
        { transform: "translate(" + dx * 1.2 + "px," + (dy + (o.dust ? 40 : 30)) + "px) rotate(" + (r + 320) + "deg) scale(.2)", opacity: 0 },
      ], { duration: (o.dust ? 800 : 700) + Math.random() * 400, easing: "cubic-bezier(.12,.7,.3,1)", fill: "forwards" });
      an.finished.then(() => p.remove(), () => p.remove());
    }
  }

  function bkRipple(node, tone) {
    if (calm() || !node || typeof S.doc.body.animate !== "function") return;
    const r = node.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    for (let k = 0; k < 2; k += 1) {
      const ring = el("span", { class: "fx-bk-ripple" + (tone ? " is-" + tone : ""), "aria-hidden": "true" });
      ring.style.cssText = "left:" + (r.left + r.width / 2) + "px;top:" + (r.top + r.height / 2) + "px;width:" + size + "px;height:" + size + "px";
      S.doc.body.appendChild(ring);
      const a = ring.animate([{ transform: "translate(-50%,-50%) scale(.7)", opacity: 0.9 }, { transform: "translate(-50%,-50%) scale(" + (2.4 + k * 0.6) + ")", opacity: 0 }],
        { duration: 760 + k * 220, delay: k * 140, easing: "cubic-bezier(.2,.7,.3,1)", fill: "both" });
      a.finished.then(() => ring.remove(), () => ring.remove());
    }
  }

  /** A shield drawn stroke by stroke; ``sealed`` draws the check inside. */
  function bkShield(sealed) {
    const s = S.doc.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "fx-bk-shield" + (sealed ? " is-sealed" : ""));
    for (const [cls, d] of [["s-fill", SHIELD_D], ["s-out", SHIELD_D], ["s-check", CHECK_D]]) {
      const p = S.doc.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("class", cls);
      p.setAttribute("pathLength", "100");
      s.appendChild(p);
    }
    return s;
  }

  /** The emblem: a glowing shield inside a ring that fills up until the next copy. */
  function bkEmblem(sealed) {
    const ring = S.doc.createElementNS(SVG_NS, "svg");
    ring.setAttribute("viewBox", "0 0 64 64");
    ring.setAttribute("class", "fx-bk-ring");
    ring.setAttribute("aria-hidden", "true");
    for (const cls of ["r-bg", "r-fg"]) {
      const c = S.doc.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", "32");
      c.setAttribute("cy", "32");
      c.setAttribute("r", "29");
      c.setAttribute("class", cls);
      c.setAttribute("pathLength", "100");
      ring.appendChild(c);
    }
    return el("span", { class: "fx-bk-emblem", "aria-hidden": "true" }, [ring, bkShield(sealed)]);
  }

  function bkSetRing(emblem, frac) {
    const fg = emblem && emblem.querySelector(".r-fg");
    if (fg) fg.style.strokeDashoffset = String(100 - Math.round(Math.max(0, Math.min(1, frac)) * 1000) / 10);
  }

  /** The newest copy nods: nothing changed, so nothing was copied. */
  function bkNod(card) {
    if (!card || calm()) return;
    anim(card, [{ transform: "none" }, { transform: "rotate(-9deg) translateY(-3px)" }, { transform: "rotate(7deg)" }, { transform: "rotate(-4deg)" }, { transform: "none" }], { duration: 760, easing: "ease-in-out" });
    const [x, y] = centerOf(card);
    const chip = el("span", { class: "fx-bk-chip", text: "= identique", "aria-hidden": "true" });
    chip.style.left = x + "px";
    chip.style.top = y - 10 + "px";
    S.doc.body.appendChild(chip);
    const a = anim(chip, [{ transform: "translate(-50%,0) scale(.6)", opacity: 0 }, { transform: "translate(-50%,-26px) scale(1)", opacity: 1, offset: 0.3 }, { transform: "translate(-50%,-46px)", opacity: 0 }], { duration: 1500, easing: "ease-out", fill: "forwards" });
    if (a) a.finished.then(() => chip.remove(), () => chip.remove());
    else chip.remove();
  }

  /** A copy just landed: the card seals with a check, a ripple and a burst. */
  function bkCelebrate(card, hue) {
    if (!card || calm()) return;
    const tick = el("span", { class: "fx-bk-tick", "aria-hidden": "true" }, [bkShield(true)]);
    card.appendChild(tick);
    S.win.setTimeout(() => tick.remove(), 1500);
    anim(card, [{ transform: "scale(1.28)", filter: "brightness(1.8)" }, { transform: "scale(.94)", filter: "brightness(1.1)", offset: 0.55 }, { transform: "none", filter: "none" }], { duration: 700, easing: SPRING });
    const [x, y] = centerOf(card);
    bkSparks(x, y, hue, 22, { spread: 70 });
    bkRipple(card);
  }

  /** The folder's shield (and the toolbar button) celebrate a copy made while you look at them. */
  function bkCelebrateTile(rel) {
    if (S.sheet) return; // behind the sheet: the sheet celebrates instead
    const t = S.listEl && S.listEl.querySelector('.fx-folder[data-rel="' + cssEsc(rel) + '"] .fx-bk-badge');
    const b = S.rel === rel ? S.bkBtn : null;
    for (const n of [t, b]) {
      if (!n || calm()) continue;
      anim(n, [{ transform: "scale(1)" }, { transform: "scale(1.35) rotate(-10deg)", offset: 0.4 }, { transform: "none" }], { duration: 620, easing: SPRING });
      bkRipple(n);
      const [x, y] = centerOf(n);
      bkSparks(x, y, rootHue(rel), 12, { spread: 36 });
    }
  }

  // ---- data

  async function loadBackups(quiet) {
    if (S.bkTimer) {
      S.win.clearTimeout(S.bkTimer);
      S.bkTimer = 0;
    }
    try {
      const data = await call("/api/backups/folders");
      S.bkSkew = (Number(data.now) || Date.now() / 1000) - Date.now() / 1000;
      const prev = S.bkByRel ? new Map([...S.bkByRel.values()].map((j) => [j.id, j])) : null;
      S.bk = data;
      S.bkByRel = new Map((data.jobs || []).map((j) => [j.rel, j]));
      S.bkLoadedAt = Date.now();
      S.bkEvents = bkAnnounce(prev || new Map(), data.jobs || []);
    } catch (e) {
      if (e && (e.status === 404 || e.status === 403 || e.status === 401)) {
        S.bk = null; // an older bridge (or the upload role): no button at all
        S.bkByRel = new Map();
      } else if (!quiet) toast((e && e.message) || "Sauvegardes indisponibles", null, null, true);
    }
    paintBackups();
    S.bkEvents = null;
    if (S.bk && (S.bk.jobs || []).some((j) => j.running)) S.bkTimer = S.win.setTimeout(() => loadBackups(true), 900);
  }

  /** Say what happened when a copy or a restore finishes while the page is open: the ones you started (watched, even
   * when they finish before the next poll) and the ones seen running. Returns {jobId: "copied"|"unchanged"|...} so the
   * painters can play the matching effect once. */
  function bkAnnounce(prev, jobs) {
    const watch = S.bkWatch || (S.bkWatch = new Map());
    const events = new Map();
    for (const j of jobs) {
      if (j.running) continue;
      const p = prev.get(j.id);
      const w = watch.get(j.id);
      const lr = j.last_restore;
      const done = w ? (w.kind === "restore" ? !!(lr && lr.at) : j.last_try_at != null && j.last_try_at !== w.mark) : !!(p && p.running);
      if (!done) continue;
      watch.delete(j.id);
      const kind = w ? w.kind : p.running.kind === "restore" ? "restore" : "backup";
      if (kind === "restore") {
        events.set(j.id, lr && lr.rel ? "restored" : "error");
        if (lr && lr.rel) toast("Copie restaurée : « " + lr.rel.split("/").pop() + " »", "Ouvrir", () => {
          closeSheet();
          S.landed.add(lr.rel);
          go(parentOf(lr.rel) || lr.rel.split("/")[0]);
        });
        else if (lr && lr.error) toast(lr.error, null, null, true);
        continue;
      }
      events.set(j.id, j.last_result || "copied");
      if (j.last_result === "error" && j.last_error) toast("Sauvegarde impossible : " + j.last_error, null, null, true);
      else if (j.last_result === "unchanged") toast("Rien n'a changé depuis la dernière copie de « " + j.name + " »");
      else if (j.last_result === "copied" && j.snapshots && j.snapshots[0]) {
        const s = j.snapshots[0];
        toast("Copie de « " + j.name + " » faite · " + s.files + (s.files > 1 ? " fichiers" : " fichier") + (s.skipped ? " · " + s.skipped + " ignoré(s)" : ""));
        buzz([8, 40, 14]);
        S.win.requestAnimationFrame(() => bkCelebrateTile(j.rel));
      }
    }
    return events;
  }

  function bkWatch(id, kind, mark) {
    (S.bkWatch || (S.bkWatch = new Map())).set(id, { kind, mark });
  }

  function paintBackups() {
    const b = S.bkBtn;
    if (!b) return;
    const ok = !!S.bk && S.rel !== TRASH;
    b.hidden = !ok;
    if (ok) {
      const job = S.rel ? S.bkByRel.get(S.rel) : null;
      const st = bkStatus(job, bkNow());
      const n = (S.bk.jobs || []).length;
      b.querySelector("span").textContent = !S.rel ? "Sauvegardes" : job ? "Sauvegardé" : "Sauvegarde auto";
      b.classList.toggle("is-on", !!job);
      b.setAttribute("data-tone", job ? st.tone : !S.rel && (S.bk.jobs || []).some((j) => bkStatus(j, bkNow()).tone === "bad") ? "bad" : "none");
      b.title = job ? st.text : !S.rel ? n + (n > 1 ? " dossiers sauvegardés" : " dossier sauvegardé") : "Copier ce dossier automatiquement";
      const c = b.querySelector(".fx-n");
      c.textContent = String(n);
      c.hidden = !!S.rel || !n;
      const ico = b.querySelector("svg path");
      if (ico) ico.setAttribute("d", job ? ICON.shieldOk : ICON.shield);
      // the button is stamped when this folder becomes backed up
      const mark = S.rel + "\u0000" + (job ? job.id : "");
      if (S.bkBtnMark && S.bkBtnMark !== mark && job && S.bkBtnMark.split("\u0000")[0] === S.rel && !calm()) {
        anim(b, [{ transform: "scale(1.5) rotate(-8deg)", opacity: 0.4 }, { transform: "scale(.92)", opacity: 1, offset: 0.55 }, { transform: "none" }], { duration: 620, easing: SPRING });
        S.win.setTimeout(() => {
          const [x, y] = centerOf(b);
          bkSparks(x, y, rootHue(S.rel), 16, { spread: 44 });
          bkRipple(b);
        }, 260);
      }
      S.bkBtnMark = mark;
    }
    if (S.listEl) for (const t of S.listEl.querySelectorAll(".fx-folder[data-rel]")) paintShield(t);
    if (S.bkView) bkPaint();
  }

  function paintShield(t) {
    const job = S.bkByRel && S.bkByRel.get(t.getAttribute("data-rel"));
    let badge = t.querySelector(".fx-bk-badge");
    if (!job) {
      if (badge && !badge.classList.contains("is-off")) {
        badge.classList.add("is-off");
        const a = anim(badge, [{ transform: "none", opacity: 1 }, { transform: "translateY(-14px) scale(.2) rotate(40deg)", opacity: 0 }], { duration: 420, easing: "ease-in", fill: "forwards" });
        if (a) a.finished.then(() => badge.remove(), () => badge.remove());
        else badge.remove();
      }
      return;
    }
    const st = bkStatus(job, bkNow());
    if (!badge || badge.classList.contains("is-off")) {
      badge = el("span", { class: "fx-bk-badge", "aria-hidden": "true" }, [svgPath(ICON.shieldOk)]);
      t.querySelector(".fx-folder-art").appendChild(badge);
      if (S.bkLoadedAt && Date.now() - S.bkLoadedAt < 400 && !S.enter) {
        // stamped onto the folder
        anim(badge, [{ transform: "scale(2.6) rotate(-35deg)", opacity: 0 }, { transform: "scale(.8) rotate(6deg)", opacity: 1, offset: 0.6 }, { transform: "none" }], { duration: 560, easing: SPRING });
        S.win.setTimeout(() => bkRipple(badge), 300);
      }
    }
    badge.setAttribute("data-tone", st.tone);
    t.title = "Sauvegarde automatique : " + st.text;
  }

  // ---- the sheet

  function bkOpen(view) {
    const body = el("div", { class: "fx-bk" });
    const box = openSheet("Sauvegarde", body, null, "is-bk");
    S.bkView = Object.assign(view, { body, box, built: "" });
    bkPaint();
    if (!S.bkLoadedAt || Date.now() - S.bkLoadedAt > 5000) loadBackups(true);
    // a live clock: the ring creeps toward the next copy, « prochaine dans … » counts down, the list refreshes now and then
    view.tick = S.win.setInterval(() => {
      if (S.bkView !== view) return S.win.clearInterval(view.tick);
      if (view.mode === "job") bkClock(view);
      if (!S.bkTimer && Date.now() - (S.bkLoadedAt || 0) > 15000) loadBackups(true);
    }, 1000);
  }

  function openBackups() {
    if (!S.bk) return;
    if (!S.rel) return bkOpen({ mode: "all" });
    const job = S.bkByRel.get(S.rel);
    return bkOpen(job ? { mode: "job", id: job.id } : { mode: "setup", rel: S.rel });
  }

  /** Slide from one view of the sheet to the next. */
  function bkSwitch(v, change, dir) {
    const body = v.body;
    const dx = dir === "back" ? 28 : dir === "up" ? 0 : -28;
    const dy = dir === "up" ? -18 : 0;
    const out = anim(body, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translate(" + dx + "px," + dy + "px)" }], { duration: 150, easing: "ease-in", fill: "forwards" });
    const done = () => {
      change();
      if (out) out.cancel();
      anim(body, [{ opacity: 0, transform: "translate(" + -dx + "px," + -dy + "px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: EASE });
    };
    if (out) out.finished.then(done, done);
    else done();
  }

  function bkPaint() {
    const v = S.bkView;
    if (!v || !S.bk || v.lock) return;
    const head = v.box.querySelector(".fx-sheet-head h3");
    if (v.mode === "setup") {
      const job = S.bkByRel.get(v.rel);
      if (job) {
        v.mode = "job";
        v.id = job.id;
      }
    }
    if (v.mode === "job") {
      const job = (S.bk.jobs || []).find((j) => j.id === v.id);
      if (!job) return closeSheet();
      head.textContent = "Sauvegarde · " + job.name;
      paintJob(v, job);
    } else if (v.mode === "setup") {
      head.textContent = "Sauvegarde automatique";
      if (v.built !== "setup") paintSetup(v);
    } else {
      head.textContent = "Sauvegardes automatiques";
      paintAll(v);
    }
  }

  /** The rolling window: ``keep`` slots, the newest copy first; a copy in progress fills the first slot. */
  function bkStrip(job, keep, hue) {
    const snaps = job ? job.snapshots || [] : [];
    const run = job && job.running && job.running.kind !== "restore" ? job.running : null;
    const cards = (run ? [{ ghost: true, run }] : []).concat(snaps);
    const box = el("div", { class: "fx-bk-strip" + (job && !job.enabled ? " is-paused" : ""), role: "img", "aria-label": Math.min(snaps.length, keep) + " copies sur " + keep });
    box.style.setProperty("--cols", String(Math.min(keep, 10)));
    box.style.setProperty("--hue", String(hue));
    for (let i = 0; i < Math.max(keep, cards.length); i += 1) {
      const c = cards[i];
      const over = i >= keep;
      const slot = el("span", { class: "fx-bk-slot" + (over ? " is-over" : "") });
      slot.style.setProperty("--i", String(i));
      if (c) {
        const card = el("span", { class: "fx-bk-card" + (c.ghost ? " is-ghost" : "") + (over ? " is-leaving" : ""), "data-id": c.ghost ? "ghost" : c.id, title: c.ghost ? "Copie en cours" : c.label + " · " + c.files + (c.files > 1 ? " fichiers" : " fichier") + " · " + fmtBytes(c.bytes) });
        card.style.setProperty("--i", String(i));
        if (c.ghost) {
          const pct = c.run.total ? Math.round((100 * c.run.done) / c.run.total) : c.run.kind === "queued" ? 0 : 6;
          card.setAttribute("data-p", String(pct));
          card.append(el("span", { class: "fx-bk-liquid" }), el("span", { class: "fx-bk-pct", text: c.run.kind === "queued" ? "…" : pct + " %" }));
          card.querySelector(".fx-bk-liquid").style.height = Math.max(pct, 4) + "%";
        }
        slot.appendChild(card);
      }
      if (!over || c) box.appendChild(slot);
    }
    return box;
  }

  /** Swap in the new window. Copies slide to their slots (one after the other); the copy in progress drops in and its
   * liquid rises from where it was; a finished copy seals; the one pushed out tumbles away in dust; slots added or
   * removed with the stepper pop in or fall. */
  function bkSwapStrip(wrap, next, opts) {
    const o = opts || {};
    const old = wrap.firstChild;
    const before = new Map();
    const pctBefore = new Map();
    let oldSlots = 0;
    if (old) {
      oldSlots = old.querySelectorAll(".fx-bk-slot:not(.is-over)").length;
      for (const c of old.querySelectorAll(".fx-bk-card[data-id]")) {
        before.set(c.getAttribute("data-id"), c.getBoundingClientRect());
        if (c.hasAttribute("data-p")) pctBefore.set(c.getAttribute("data-id"), Number(c.getAttribute("data-p")));
      }
    }
    const oldSlotRects = old ? [...old.querySelectorAll(".fx-bk-slot:not(.is-over)")].map((s) => s.getBoundingClientRect()) : [];
    wrap.textContent = "";
    wrap.appendChild(next);
    if (calm()) return;
    const hue = Number(next.style.getPropertyValue("--hue")) || 210;
    if (!old) {
      // first paint: the slots unroll, then the copies are dealt into them
      next.querySelectorAll(".fx-bk-slot").forEach((s, k) => anim(s, [{ transform: "scale(.4)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 380, delay: k * 28, easing: SPRING, fill: "backwards" }));
      next.querySelectorAll(".fx-bk-card").forEach((c, k) => anim(c, [{ transform: "translate(-30px,-26px) rotate(-14deg) scale(.6)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 520, delay: 160 + k * 70, easing: SPRING, fill: "backwards" }));
      return;
    }
    const slots = [...next.querySelectorAll(".fx-bk-slot:not(.is-over)")];
    slots.forEach((s, k) => {
      if (k >= oldSlots) anim(s, [{ transform: "scale(0)", opacity: 0 }, { transform: "scale(1.15)", opacity: 1, offset: 0.6 }, { transform: "none" }], { duration: 420, easing: SPRING });
    });
    for (let k = slots.length; k < oldSlotRects.length; k += 1) {
      const r = oldSlotRects[k];
      const g = el("span", { class: "fx-bk-slot fx-bk-falling", "aria-hidden": "true" });
      g.style.cssText = "position:fixed;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;z-index:400";
      S.doc.body.appendChild(g);
      const a = anim(g, [{ transform: "none", opacity: 1 }, { transform: "translateY(26px) scale(.3) rotate(18deg)", opacity: 0 }], { duration: 380, easing: "ease-in", fill: "forwards" });
      if (a) a.finished.then(() => g.remove(), () => g.remove());
      else g.remove();
    }
    const seen = new Set();
    let k = 0;
    for (const c of next.querySelectorAll(".fx-bk-card[data-id]")) {
      const id = c.getAttribute("data-id");
      seen.add(id);
      const a = before.get(id);
      const b = c.getBoundingClientRect();
      if (a) {
        if (Math.abs(a.left - b.left) + Math.abs(a.top - b.top) > 1) {
          anim(c, [{ transform: "translate(" + (a.left - b.left) + "px," + (a.top - b.top) + "px)" }, { transform: "translate(" + (a.left - b.left) * 0.1 + "px,-6px) rotate(3deg)", offset: 0.55 }, { transform: "none" }], { duration: 560, delay: k * 45, easing: SPRING, fill: "backwards" });
        }
        if (id === "ghost" && pctBefore.has(id)) {
          const liq = c.querySelector(".fx-bk-liquid");
          const from = Math.max(pctBefore.get(id), 4);
          if (liq) anim(liq, [{ height: from + "%" }, { height: liq.style.height }], { duration: 850, easing: EASE });
        }
      } else if (id !== "ghost" && (before.has("ghost") || (o.landed && k === 0))) {
        bkCelebrate(c, hue);
      } else if (id === "ghost") {
        // the copy in progress drops into the first slot from above
        anim(c, [{ transform: "translateY(-40px) scale(.7) rotate(-8deg)", opacity: 0 }, { transform: "translateY(4px) scale(1.04)", opacity: 1, offset: 0.7 }, { transform: "none" }], { duration: 560, easing: SPRING });
      } else anim(c, [{ transform: "translateY(-22px) scale(.5)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 520, easing: SPRING });
      k += 1;
    }
    for (const [id, r] of before) {
      if (seen.has(id) || id === "ghost") continue;
      // pushed out of the window: it tumbles off the end and turns to dust
      const g = el("span", { class: "fx-bk-card fx-bk-falling", "aria-hidden": "true" });
      g.style.cssText = "position:fixed;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;z-index:400";
      g.style.setProperty("--hue", String(hue));
      S.doc.body.appendChild(g);
      const a = anim(g, [{ transform: "none", opacity: 1 }, { transform: "translate(16px,-14px) rotate(14deg)", opacity: 1, offset: 0.25 }, { transform: "translate(40px,90px) rotate(70deg) scale(.5)", opacity: 0 }], { duration: 900, delay: 220, easing: "cubic-bezier(.45,0,.8,.55)", fill: "both" });
      S.win.setTimeout(() => bkSparks(r.left + r.width / 2 + 34, r.top + r.height / 2 + 70, hue, 10, { dust: true, spread: 30 }), 980);
      if (a) a.finished.then(() => g.remove(), () => g.remove());
      else g.remove();
    }
  }

  /** Frequency choice with a pill that glides under the chosen option. */
  function bkOptions(value, onPick) {
    const g = el("div", { class: "fx-bk-opts", role: "group" });
    const ink = el("span", { class: "fx-bk-ink", "aria-hidden": "true" });
    g.appendChild(ink);
    for (const k of ["hour", "day", "week"]) {
      const b = btn(EVERY_LABEL[k], { cls: "fx-bk-opt", on: () => {
        if (b.getAttribute("aria-pressed") === "true") return;
        onPick(k);
        bkInk(g, true);
        anim(b.querySelector(".fx-ico"), [{ transform: "rotate(-200deg) scale(.4)" }, { transform: "rotate(10deg) scale(1.25)", offset: 0.7 }, { transform: "none" }], { duration: 560, easing: SPRING });
        buzz(6);
      } });
      b.insertBefore(svgPath(EVERY_ICON[k]), b.firstChild);
      b.setAttribute("data-every", k);
      b.setAttribute("aria-pressed", String(k === value));
      g.appendChild(b);
    }
    S.win.requestAnimationFrame(() => bkInk(g, false));
    return g;
  }

  function bkInk(g, animate) {
    const ink = g.querySelector(".fx-bk-ink");
    const on = g.querySelector('.fx-bk-opt[aria-pressed="true"]');
    if (!ink || !on) return;
    ink.classList.toggle("is-still", !animate);
    ink.style.width = on.offsetWidth + "px";
    ink.style.height = on.offsetHeight + "px";
    ink.style.transform = "translate(" + on.offsetLeft + "px," + on.offsetTop + "px)";
  }

  function bkStepper(value, max, onSet) {
    const out = el("output", { class: "fx-bk-num", text: String(value) });
    const set = (n) => {
      const cur = Number(out.textContent);
      n = Math.max(1, Math.min(max, n));
      if (n === cur) {
        anim(out, [{ transform: "translateX(0)" }, { transform: "translateX(-5px)" }, { transform: "translateX(5px)" }, { transform: "none" }], { duration: 260 });
        return;
      }
      out.textContent = String(n);
      // the number rolls up (more) or down (fewer)
      anim(out, [{ transform: "translateY(" + (n > cur ? 60 : -60) + "%) scale(.7)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 300, easing: SPRING });
      buzz(5);
      onSet(n);
    };
    const minus = btn("", { cls: "fx-btn is-round", icon: "minus", aria: "Une copie de moins", on: () => set(Number(out.textContent) - 1) });
    const plus = btn("", { cls: "fx-btn is-round", icon: "plus", aria: "Une copie de plus", on: () => set(Number(out.textContent) + 1) });
    return el("div", { class: "fx-bk-step" }, [minus, el("span", { class: "fx-bk-numbox" }, [out]), plus]);
  }

  /** « Prochaines copies : maintenant · 22 h 45 · 23 h 45 » — dealt in like cards when the frequency changes. */
  function bkNext(box, every, startNow, now) {
    box.textContent = "";
    box.appendChild(el("span", { class: "fx-bk-label", text: "Prochaines copies" }));
    const labels = nextTimes(every, now, 4);
    if (!startNow) labels.shift();
    labels.slice(0, 3).forEach((t, j) => {
      const chip = el("span", { class: "fx-bk-when" + (t === "maintenant" ? " is-now" : ""), text: t });
      chip.style.setProperty("--j", String(j));
      box.appendChild(chip);
    });
  }

  function bkTargetNote() {
    const t = S.bk.target || {};
    const bits = [];
    if (!t.ok) bits.push(el("p", { class: "fx-bk-warn is-bad", text: (t.error || "Destination des sauvegardes indisponible") + " — réglage backup_dir dans bridge_config.json." }));
    if (t.paused) bits.push(el("p", { class: "fx-bk-warn", text: "Les sauvegardes automatiques sont en pause (backup_auto_paused) ; « Sauvegarder maintenant » fonctionne quand même." }));
    return bits;
  }

  function paintSetup(v) {
    v.built = "setup";
    const body = v.body;
    body.textContent = "";
    const name = v.rel.split("/").pop();
    let every = "day";
    let keep = S.bk.keep_default || 10;
    const hue = rootHue(v.rel);
    body.style.setProperty("--hue", String(hue));
    const wrap = el("div", { class: "fx-bk-stripwrap" });
    const intro = el("p", { class: "fx-bk-intro" });
    const keepPill = el("b", { class: "fx-bk-pill", text: String(keep) });
    const everyPill = el("b", { class: "fx-bk-pill", text: EVERY_SHORT[every] });
    intro.append("« ", el("strong", { text: name }), " » est copié ", everyPill, " vers ", el("code", { text: S.bk.target.dir || "backup_dir" }),
      ". Les ", keepPill, " copies les plus récentes sont gardées : quand une nouvelle arrive, la plus ancienne part. Si rien n'a changé, aucune copie n'est faite.");
    const pop = (n) => anim(n, [{ transform: "scale(1.35)", filter: "brightness(1.4)" }, { transform: "none", filter: "none" }], { duration: 360, easing: SPRING });
    const next = el("div", { class: "fx-bk-next" });
    bkNext(next, every, true, bkNow());
    const opts = bkOptions(every, (k) => {
      every = k;
      for (const b of opts.querySelectorAll(".fx-bk-opt")) b.setAttribute("aria-pressed", String(b.getAttribute("data-every") === k));
      everyPill.textContent = EVERY_SHORT[k];
      pop(everyPill);
      bkNext(next, every, true, bkNow());
    });
    const step = bkStepper(keep, S.bk.keep_max || 50, (n) => {
      keep = n;
      bkSwapStrip(wrap, bkStrip(null, keep, hue));
      keepPill.textContent = String(n);
      pop(keepPill);
    });
    const emblem = bkEmblem(false);
    const go_ = btn("Activer la sauvegarde", { cls: "fx-btn is-primary fx-bk-go", icon: "shield", on: async () => {
      go_.disabled = true;
      go_.classList.add("is-busy");
      v.lock = true; // the seal plays out before the sheet turns into the backup's own view
      const shield = emblem.querySelector(".fx-bk-shield");
      shield.classList.add("is-sealed");
      if (!calm()) {
        anim(emblem, [{ transform: "scale(1)" }, { transform: "scale(.82)", offset: 0.25 }, { transform: "scale(1.18)", offset: 0.6 }, { transform: "none" }], { duration: 700, easing: SPRING });
        S.win.setTimeout(() => {
          const [x, y] = centerOf(emblem);
          bkSparks(x, y, hue, 30, { spread: 90 });
          bkRipple(emblem);
        }, 260);
        wrap.querySelectorAll(".fx-bk-slot").forEach((s, k) => anim(s, [{ borderColor: "var(--ok)", transform: "scale(1.1)" }, { transform: "none" }], { duration: 420, delay: 200 + k * 40, easing: SPRING }));
      }
      buzz([10, 50, 18]);
      const seal = new Promise((r) => S.win.setTimeout(r, calm() ? 0 : 750));
      try {
        const out = await postJson("/api/backups/folders", { action: "create", rel: v.rel, every, keep });
        bkWatch(out.job.id, "backup", undefined);
        toast("Sauvegarde activée — première copie en cours");
        await seal;
        await loadBackups(true);
        bkSwitch(v, () => {
          v.lock = false;
          v.mode = "job";
          v.id = out.job.id;
          v.built = "";
          bkPaint();
        }, "up");
      } catch (e) {
        v.lock = false;
        shield.classList.remove("is-sealed");
        go_.disabled = false;
        go_.classList.remove("is-busy");
        anim(go_, [{ transform: "translateX(0)" }, { transform: "translateX(-8px)" }, { transform: "translateX(8px)" }, { transform: "translateX(-4px)" }, { transform: "none" }], { duration: 360 });
        toast((e && e.message) || "Activation impossible", null, null, true);
      }
    } });
    go_.disabled = !(S.bk.target && S.bk.target.ok);
    body.append(
      el("div", { class: "fx-bk-hero" }, [emblem, intro]),
      wrap,
      el("p", { class: "fx-bk-cap" }, [el("span", { text: "← la plus récente" }), el("span", { text: "la plus ancienne →" })]),
      el("div", { class: "fx-bk-field" }, [el("span", { class: "fx-bk-label", text: "Fréquence" }), opts]),
      next,
      el("div", { class: "fx-bk-field" }, [el("span", { class: "fx-bk-label", text: "Copies gardées" }), step]),
      ...bkTargetNote(),
      el("div", { class: "fx-bk-actions" }, [btn("Annuler", { on: () => closeSheet() }), go_]),
    );
    bkSwapStrip(wrap, bkStrip(null, keep, hue));
    bkSetRing(emblem, 0);
  }

  /** Once a second while the backup is open: the ring and the countdown. */
  function bkClock(v) {
    const job = S.bk && (S.bk.jobs || []).find((j) => j.id === v.id);
    if (!job || !v.emblem) return;
    const now = bkNow();
    const st = bkStatus(job, now);
    if (v.statusText && v.statusText.textContent !== st.text) v.statusText.textContent = st.text;
    v.emblem.setAttribute("data-tone", st.tone);
    if (st.tone !== "run") bkSetRing(v.emblem, ringFrac(job, now));
  }

  function paintJob(v, job) {
    const now = bkNow();
    const hue = rootHue(job.rel);
    const ev = S.bkEvents && S.bkEvents.get(job.id);
    const first = v.built !== "job:" + job.id;
    if (first) {
      v.built = "job:" + job.id;
      const body = v.body;
      body.textContent = "";
      body.style.setProperty("--hue", String(hue));
      v.emblem = bkEmblem(true);
      v.statusText = el("span");
      v.status = el("p", { class: "fx-bk-status" }, [el("span", { class: "fx-bk-dot", "aria-hidden": "true" }), v.statusText]);
      v.sub = el("p", { class: "fx-bk-sub" });
      v.wrap = el("div", { class: "fx-bk-stripwrap" });
      v.wrap.addEventListener("click", (ev2) => {
        // a copy in the window points at its row below
        const c = ev2.target.closest && ev2.target.closest(".fx-bk-card[data-id]");
        const row = c && v.list.querySelector('.fx-bk-row[data-id="' + cssEsc(c.getAttribute("data-id")) + '"]');
        if (!row) return;
        row.scrollIntoView({ block: "nearest", behavior: calm() ? "auto" : "smooth" });
        row.classList.remove("is-flash");
        void row.offsetWidth;
        row.classList.add("is-flash");
      });
      v.meter = el("span", { class: "fx-bk-meter", "aria-hidden": "true" }, [el("i")]);
      v.cap = el("p", { class: "fx-bk-cap" });
      v.run = btn("Sauvegarder maintenant", { cls: "fx-btn is-primary fx-bk-go", icon: "shield", on: async () => {
        v.run.disabled = true;
        v.run.classList.add("is-busy");
        bkRipple(v.run);
        const cur = (S.bk.jobs || []).find((j) => j.id === job.id) || job;
        bkWatch(job.id, "backup", cur.last_try_at);
        try {
          await postJson("/api/backups/folders", { action: "run", id: job.id });
          await loadBackups(true);
        } catch (e) {
          toast((e && e.message) || "Copie impossible", null, null, true);
        }
      } });
      v.pause = btn("Pause", { cls: "fx-btn", icon: "pause", on: async () => {
        const cur = (S.bk.jobs || []).find((j) => j.id === job.id);
        try {
          await postJson("/api/backups/folders", { action: "update", id: job.id, enabled: !(cur && cur.enabled) });
          toast(cur && cur.enabled ? "Sauvegarde en pause" : "Sauvegarde reprise");
          buzz(8);
          await loadBackups(true);
        } catch (e) {
          toast((e && e.message) || "Échec", null, null, true);
        }
      } });
      const update = async (patch, msg) => {
        try {
          await postJson("/api/backups/folders", Object.assign({ action: "update", id: job.id }, patch));
          if (msg) toast(msg);
          await loadBackups(true);
        } catch (e) {
          toast((e && e.message) || "Échec", null, null, true);
          await loadBackups(true);
        }
      };
      v.next = el("div", { class: "fx-bk-next" });
      v.opts = bkOptions(job.every, (k) => {
        for (const b of v.opts.querySelectorAll(".fx-bk-opt")) b.setAttribute("aria-pressed", String(b.getAttribute("data-every") === k));
        update({ every: k }, "Copie " + EVERY_SHORT[k]);
      });
      let keepTimer = 0;
      v.step = bkStepper(job.keep, S.bk.keep_max || 50, (n) => {
        // preview at once, save when the clicks stop
        const cur = (S.bk.jobs || []).find((j) => j.id === job.id) || job;
        bkSwapStrip(v.wrap, bkStrip(Object.assign({}, cur, { snapshots: (cur.snapshots || []).slice(0, n) }), n, hue));
        S.win.clearTimeout(keepTimer);
        keepTimer = S.win.setTimeout(() => update({ keep: n }, n + " copies gardées"), 600);
      });
      v.list = el("div", { class: "fx-bk-list is-intro" });
      S.win.setTimeout(() => v.list.classList.remove("is-intro"), 1200);
      v.note = el("div", { class: "fx-bk-notes" });
      v.dest = el("p", { class: "fx-bk-dest" });
      const stop = btn("Arrêter la sauvegarde automatique", { cls: "fx-btn is-ghost is-danger", icon: "close", on: async () => {
        const cur = (S.bk.jobs || []).find((j) => j.id === job.id) || job;
        if (!S.win.confirm("Arrêter la sauvegarde automatique de « " + cur.name + " » ?\n\nLes copies déjà faites restent sur le disque de sauvegarde.")) return;
        try {
          await postJson("/api/backups/folders", { action: "delete", id: job.id });
          v.lock = true;
          // the copies float away, the shield lets go
          if (!calm()) {
            v.wrap.querySelectorAll(".fx-bk-card").forEach((c, k) => anim(c, [{ transform: "none", opacity: 1 }, { transform: "translateY(-30px) rotate(" + (k % 2 ? 12 : -12) + "deg) scale(.7)", opacity: 0 }], { duration: 480, delay: k * 50, easing: "ease-in", fill: "forwards" }));
            anim(v.emblem, [{ transform: "none", opacity: 1 }, { transform: "scale(.4) rotate(-25deg)", opacity: 0 }], { duration: 520, delay: 200, easing: "ease-in", fill: "forwards" });
            await new Promise((r) => S.win.setTimeout(r, 650));
          }
          closeSheet();
          toast("Sauvegarde automatique arrêtée — les copies restent sur le disque");
          await loadBackups(true);
        } catch (e) {
          toast((e && e.message) || "Échec", null, null, true);
        }
      } });
      const top = [];
      if (v.fromAll) top.push(btn("Toutes les sauvegardes", { cls: "fx-btn is-ghost fx-bk-back", icon: "left", on: () => bkSwitch(v, () => {
        v.mode = "all";
        v.built = "";
        bkPaint();
      }, "back") }));
      body.append(...top, el("div", { class: "fx-bk-hero is-job" }, [v.emblem, el("div", { class: "fx-bk-headline" }, [v.status, v.sub])]),
        v.wrap, v.meter, v.cap, el("div", { class: "fx-bk-actions is-top" }, [v.pause, v.run]), v.note,
        el("div", { class: "fx-bk-field" }, [el("span", { class: "fx-bk-label", text: "Fréquence" }), v.opts]), v.next,
        el("div", { class: "fx-bk-field" }, [el("span", { class: "fx-bk-label", text: "Copies gardées" }), v.step]),
        el("h4", { class: "fx-bk-h", text: "Copies" }), v.list, v.dest, el("div", { class: "fx-bk-actions is-end" }, [stop]));
      bkSetRing(v.emblem, 0);
    }
    const st = bkStatus(job, now);
    v.status.setAttribute("data-tone", st.tone);
    v.emblem.setAttribute("data-tone", st.tone);
    v.statusText.textContent = st.text;
    v.sub.textContent = (job.snapshots || []).length + " / " + job.keep + " copies · " + EVERY_SHORT[job.every] + (job.missing ? "" : " · " + job.rel);
    S.win.requestAnimationFrame(() => {
      if (st.tone === "run") bkSetRing(v.emblem, job.running && job.running.total ? job.running.done / job.running.total : 0.25);
      else bkSetRing(v.emblem, ringFrac(job, bkNow()));
    });
    bkSwapStrip(v.wrap, bkStrip(job, job.keep, hue), { landed: ev === "copied" });
    if (ev === "unchanged") S.win.setTimeout(() => bkNod(v.wrap.querySelector('.fx-bk-card:not(.is-ghost)')), 60);
    if (ev === "copied" && !first) {
      anim(v.emblem, [{ transform: "scale(1)" }, { transform: "scale(1.2)", offset: 0.4 }, { transform: "none" }], { duration: 560, easing: SPRING });
      bkRipple(v.emblem);
    }
    const n = Math.min((job.snapshots || []).length, job.keep);
    v.meter.querySelector("i").style.width = (100 * n) / job.keep + "%";
    v.cap.textContent = "";
    v.cap.append(el("span", { text: n + " / " + job.keep + " copies" }), el("span", { text: "la plus ancienne part quand une nouvelle arrive" }));
    v.run.disabled = !!job.running || job.missing;
    v.run.classList.toggle("is-busy", !!job.running);
    v.pause.querySelector("span").textContent = job.enabled ? "Pause" : "Reprendre";
    v.pause.querySelector("svg path").setAttribute("d", job.enabled ? ICON.pause : ICON.play);
    v.box.classList.toggle("is-paused", !job.enabled);
    for (const b of v.opts.querySelectorAll(".fx-bk-opt")) b.setAttribute("aria-pressed", String(b.getAttribute("data-every") === job.every));
    S.win.requestAnimationFrame(() => bkInk(v.opts, !first));
    if (v.nextKey !== job.every + ":" + job.last_run_at + ":" + job.enabled) {
      v.nextKey = job.every + ":" + job.last_run_at + ":" + job.enabled;
      if (job.enabled) {
        v.next.hidden = false;
        const fresh = job.last_run_at && job.last_run_at + (EVERY_SEC[job.every] || 86400) > now;
        bkNext(v.next, job.every, !fresh, fresh ? job.last_run_at : now);
      } else v.next.hidden = true;
    }
    v.note.textContent = "";
    v.note.append(...bkTargetNote());
    if (job.last_skipped && job.last_skipped.length && job.last_result === "copied") {
      v.note.appendChild(el("p", { class: "fx-bk-warn", text: job.last_skipped.length + " fichier(s) n'ont pas pu être copiés (ouverts dans un autre programme ?) : " + job.last_skipped.slice(0, 4).join(", ") + (job.last_skipped.length > 4 ? "…" : "") }));
    }
    // the list: rows keep their place (FLIP), a new copy slides in on top
    const rowsBefore = new Map();
    for (const r of v.list.querySelectorAll(".fx-bk-row[data-id]")) rowsBefore.set(r.getAttribute("data-id"), r.getBoundingClientRect().top);
    const restoring = job.running && job.running.kind === "restore";
    v.list.textContent = "";
    const snaps = job.snapshots || [];
    if (!snaps.length) v.list.appendChild(el("p", { class: "fx-hint", text: job.running ? "La première copie arrive…" : "Aucune copie pour l'instant." }));
    snaps.forEach((s, k) => {
      const mini = el("span", { class: "fx-bk-mini", "aria-hidden": "true" });
      const restore = btn("Restaurer", { cls: "fx-btn", icon: "restore", title: "Ramène cette copie à côté du dossier, sous un nouveau nom (rien n'est écrasé)", on: async () => {
        restore.disabled = true;
        bkFlyHome(mini, v.emblem, hue);
        try {
          bkWatch(job.id, "restore", null);
          v.restoring = s.id;
          await postJson("/api/backups/folders", { action: "restore", id: job.id, snap: s.id });
          toast("Restauration de la copie du " + s.label + "…");
          await loadBackups(true);
        } catch (e) {
          v.restoring = null;
          restore.disabled = false;
          toast((e && e.message) || "Restauration impossible", null, null, true);
        }
      } });
      restore.disabled = !!job.running;
      const row = el("div", { class: "fx-bk-row" + (k === 0 ? " is-newest" : "") + (restoring && v.restoring === s.id ? " is-restoring" : ""), "data-id": s.id }, [
        mini,
        el("span", { class: "fx-text" }, [el("span", { class: "fx-name", text: s.label }), el("span", { class: "fx-meta", text: s.files + (s.files > 1 ? " fichiers" : " fichier") + " · " + fmtBytes(s.bytes) + (s.skipped ? " · " + s.skipped + " ignoré(s)" : "") })]),
        restore,
      ]);
      row.style.setProperty("--hue", String(hue));
      row.style.setProperty("--k", String(k));
      v.list.appendChild(row);
      if (calm() || first) return;
      const was = rowsBefore.get(s.id);
      const nowTop = row.getBoundingClientRect().top;
      if (was == null) anim(row, [{ opacity: 0, transform: "translateY(-14px) scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: SPRING });
      else if (Math.abs(was - nowTop) > 1) anim(row, [{ transform: "translateY(" + (was - nowTop) + "px)" }, { transform: "none" }], { duration: 420, easing: EASE });
    });
    if (!restoring) v.restoring = null;
    v.dest.textContent = "Copies dans " + (S.bk.target.dir || "backup_dir") + (S.bk.target.dir && S.bk.target.dir.includes("\\") ? "\\" : "/") + job.dir;
  }

  /** « Restaurer »: the copy lifts out of its row and flies home to the shield. */
  function bkFlyHome(from, to, hue) {
    if (calm() || !from || !to) return;
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const g = el("span", { class: "fx-bk-card fx-bk-falling", "aria-hidden": "true" });
    g.style.cssText = "position:fixed;left:" + a.left + "px;top:" + a.top + "px;width:" + a.width + "px;height:" + a.height + "px;z-index:400";
    g.style.setProperty("--hue", String(hue));
    S.doc.body.appendChild(g);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    const an = anim(g, [{ transform: "none", opacity: 1 }, { transform: "translate(" + dx * 0.4 + "px," + (dy * 0.4 - 60) + "px) rotate(-12deg) scale(1.5)", opacity: 1, offset: 0.45 }, { transform: "translate(" + dx + "px," + dy + "px) rotate(0) scale(.3)", opacity: 0.2 }], { duration: 760, easing: "cubic-bezier(.3,.1,.3,1)", fill: "forwards" });
    const done = () => {
      g.remove();
      anim(to, [{ transform: "scale(1)" }, { transform: "scale(1.15)", offset: 0.4 }, { transform: "none" }], { duration: 420, easing: SPRING });
    };
    if (an) an.finished.then(done, done);
    else g.remove();
  }

  function paintAll(v) {
    const jobs = (S.bk.jobs || []).slice().sort((a, b) => a.rel.localeCompare(b.rel, "fr"));
    const now = bkNow();
    // repaint only when something shown changed; a repaint does not replay the entrance
    const key = jobs.map((j) => j.id + ":" + (j.snapshots || []).length + ":" + bkStatus(j, now).text).join("|") + "|" + JSON.stringify(S.bk.target || {});
    if (v.built === "all" && v.key === key) return;
    v.body.classList.toggle("is-calm", v.built === "all");
    v.built = "all";
    v.key = key;
    const body = v.body;
    body.textContent = "";
    const emblem = bkEmblem(jobs.length > 0);
    bkSetRing(emblem, jobs.length ? 1 : 0);
    const intro = el("p", { class: "fx-bk-intro", text: jobs.length ? "Ces dossiers sont copiés automatiquement vers " + (S.bk.target.dir || "backup_dir") + "." : "Aucun dossier n'est encore sauvegardé automatiquement. Ouvre un dossier, puis « Sauvegarde auto »." });
    body.appendChild(el("div", { class: "fx-bk-hero" }, [emblem, intro]));
    body.append(...bkTargetNote());
    jobs.forEach((j, k) => {
      const st = bkStatus(j, now);
      const n = Math.min((j.snapshots || []).length, j.keep);
      const win = el("span", { class: "fx-bk-win", "aria-hidden": "true" });
      for (let i = 0; i < Math.min(j.keep, 20); i += 1) {
        const tick = el("i", { class: i < n ? "on" : null });
        tick.style.setProperty("--j", String(i));
        win.appendChild(tick);
      }
      const row = el("button", { type: "button", class: "fx-bk-row is-job" }, [
        el("span", { class: "fx-bk-badge is-big", "data-tone": st.tone, "aria-hidden": "true" }, [svgPath(ICON.shieldOk)]),
        el("span", { class: "fx-text" }, [el("span", { class: "fx-name", text: j.name }), el("span", { class: "fx-meta", text: j.rel + " · " + n + "/" + j.keep + " · " + st.text }), win]),
        icon("right", "fx-sep"),
      ]);
      row.style.setProperty("--hue", String(rootHue(j.rel)));
      row.style.setProperty("--k", String(k));
      row.addEventListener("click", () => bkSwitch(v, () => {
        v.mode = "job";
        v.id = j.id;
        v.built = "";
        v.fromAll = true;
        bkPaint();
      }, "forward"));
      body.appendChild(row);
    });
  }

  // ---------------------------------------------------------------- toast

  function toast(text, action, onAction, bad) {
    const t = S.toastEl;
    if (!t) return;
    t.textContent = "";
    t.classList.toggle("is-bad", !!bad);
    t.appendChild(el("span", { text }));
    if (action && onAction) t.appendChild(btn(action, { cls: "fx-toast-act", on: () => {
      t.hidden = true;
      onAction();
    } }));
    t.hidden = false;
    t.classList.remove("is-in");
    void t.offsetWidth;
    t.classList.add("is-in");
    if (S.toastTimer) S.win.clearTimeout(S.toastTimer);
    S.toastTimer = S.win.setTimeout(() => (t.hidden = true), action ? 8000 : 3200);
  }

  // ---------------------------------------------------------------- build

  function build() {
    const app = S.app;
    app.textContent = "";
    app.hidden = false;
    app.classList.add("fx");
    // the old list and its tools give way; the favourites bar stays (it calls navigate())
    for (const sel of ["#crumbs", ".fm-tools", ".fm-filter", "#file-list"]) {
      const n = app.parentNode.querySelector(sel);
      if (n) n.hidden = true;
    }
    S.crumbEl = el("nav", { class: "fx-crumbs", "aria-label": "Chemin" });
    const viewSeg = el("div", { class: "fx-seg", role: "group", "aria-label": "Affichage" }, [
      btn("", { cls: "fx-seg-btn", icon: "grid", aria: "Vignettes", title: "Vignettes", on: () => setView("grid") }),
      btn("", { cls: "fx-seg-btn", icon: "list", aria: "Liste", title: "Liste", on: () => setView("list") }),
    ]);
    viewSeg.children[0].setAttribute("data-view", "grid");
    viewSeg.children[1].setAttribute("data-view", "list");
    S.viewSeg = viewSeg;
    S.sortEl = el("select", { class: "fx-sort", "aria-label": "Trier" }, [
      el("option", { value: "name", text: "Nom" }), el("option", { value: "recent", text: "Récents" }), el("option", { value: "size", text: "Taille" }),
    ]);
    S.sortEl.addEventListener("change", () => {
      S.sort = S.sortEl.value;
      try {
        S.win.localStorage.setItem("hq_files_sort", S.sort);
      } catch (_) {}
      render();
    });
    const search = el("label", { class: "fx-search" }, [icon("search")]);
    S.searchEl = el("input", { type: "search", placeholder: "Filtrer ce dossier…", "aria-label": "Filtrer ce dossier", autocomplete: "off" });
    S.searchEl.addEventListener("input", () => {
      S.q = S.searchEl.value;
      render();
    });
    search.appendChild(S.searchEl);
    S.uploadBtn = btn("Envoyer ici", { cls: "fx-btn is-primary", icon: "upload", on: () => pickUpload() });
    S.mkdirBtn = btn("Dossier", { cls: "fx-btn", icon: "folderPlus", on: () => newFolder() });
    S.selectBtn = btn("Sélection", { cls: "fx-btn", icon: "select", on: () => {
      S.selecting = !S.selecting;
      if (!S.selecting) S.sel.clear();
      render();
    } });
    S.lensBtn = btn("Lentille", { cls: "fx-btn", icon: "sparkles", title: "Lentille intelligente (Lourds, Vides, Récents, Doublons)", on: () => cycleLens() });
    S.recentBtn = btn("Récents", { cls: "fx-btn", icon: "clock", title: "Fichiers récents transversaux", on: () => openOmniRecent() });
    S.captureBtn = btn("Capture", { cls: "fx-btn", icon: "camera", title: "Capture directe (Photo / Note vocale)", on: () => openDirectCapture() });
    S.dualBtn = btn("Double volet", { cls: "fx-btn", icon: "columns", title: "Mode double-panneau (Norton Commander)", on: () => toggleDualMode() });
    S.bkBtn = btn("Sauvegarde auto", { cls: "fx-btn fx-bk-btn", icon: "shield", on: () => openBackups() });
    S.bkBtn.appendChild(el("span", { class: "fx-n", hidden: true }));
    S.bkBtn.hidden = true;
    S.trashBtn = btn("Corbeille", { cls: "fx-btn fx-trash-btn", icon: "trash", on: () => go(TRASH) });
    S.trashBtn.appendChild(el("span", { class: "fx-n", hidden: true }));
    S.inboxZeroBtn = btn("Tri Inbox", { cls: "fx-btn fx-inbox-btn", icon: "sparkles", title: "Ranger automatiquement avec Inbox-Zero", on: () => runInboxZero() });
    S.inboxZeroBtn.hidden = true;
    const navHistory = el("div", { class: "fx-nav-history" }, [
      btn("", { cls: "fx-btn", icon: "left", title: "Dossier précédent (Alt+←)", aria: "Précédent", on: () => goBack() }),
      btn("", { cls: "fx-btn", icon: "right", title: "Dossier suivant (Alt+→)", aria: "Suivant", on: () => goForward() }),
    ]);
    const top = el("div", { class: "fx-top" }, [navHistory, S.crumbEl, el("div", { class: "fx-top-right" }, [viewSeg, S.sortEl])]);
    const tools = el("div", { class: "fx-tools" }, [search, S.uploadBtn, S.mkdirBtn, S.selectBtn, S.lensBtn, S.recentBtn, S.captureBtn, S.dualBtn, S.inboxZeroBtn, S.bkBtn, S.trashBtn]);
    S.pillsEl = el("div", { class: "fx-pills", role: "toolbar", "aria-label": "Filtres par type" });
    S.telemetryEl = el("div", { class: "fx-telemetry", role: "region", "aria-label": "Télémétrie du dossier" });
    S.lensBarEl = el("div", { class: "fx-lens-bar", role: "region", "aria-label": "Lentille active", hidden: true });
    S.listEl = el("div", { class: "fx-list", role: "listbox", "aria-label": "Contenu du dossier", "aria-multiselectable": "true" });
    S.barEl = el("div", { class: "fx-selbar", role: "region", "aria-label": "Sélection", hidden: true });
    S.trayEl = el("div", { class: "fx-tray", "aria-live": "polite", hidden: true });
    S.dropEl = el("div", { class: "fx-drop", "aria-hidden": "true", hidden: true }, [el("div", { class: "fx-drop-card" }, [icon("upload", "fx-drop-ico"), el("strong", { class: "fx-drop-title" }), el("span", { class: "fx-drop-sub", text: "Lâche pour envoyer" })])]);
    S.toastEl = el("div", { class: "fx-toast", role: "status", hidden: true });
    S.marqueeEl = el("div", { class: "fx-marquee", "aria-hidden": "true", hidden: true });

    loadStash();
    S.stashBadgeEl = el("span", { class: "fx-stash-badge", hidden: true });
    S.stashDockEl = el("button", {
      class: "fx-stash-dock",
      title: "Établi Magnétique (Glissez des fichiers ici pour les déplacer)",
      "aria-label": "Établi Pocket",
      type: "button"
    }, [
      svgPath(ICON.stash, "fx-stash-ico"),
      el("span", { class: "fx-stash-label", text: "Établi" }),
      S.stashBadgeEl
    ]);
    S.stashDockEl.addEventListener("click", () => openStashDrawer());
    wireStashDrop(S.stashDockEl);
    paintStashBadge();

    app.append(top, tools, S.pillsEl, S.telemetryEl, S.lensBarEl, S.listEl, S.barEl, S.trayEl, S.dropEl, S.toastEl, S.marqueeEl, S.stashDockEl);
    bindMarquee();
    bindDrop();
    bindKeys();

    // Pull-to-refresh (touch)
    let pullStartY = 0;
    let pullIndicator = null;
    S.listEl.addEventListener("touchstart", (ev) => {
      if (ev.touches.length === 1 && (S.win.scrollY || S.doc.documentElement.scrollTop || 0) <= 0) {
        pullStartY = ev.touches[0].clientY;
      } else {
        pullStartY = 0;
      }
    }, { passive: true });
    S.listEl.addEventListener("touchmove", (ev) => {
      if (!pullStartY) return;
      const dy = ev.touches[0].clientY - pullStartY;
      if (dy > 40) {
        if (!pullIndicator) {
          pullIndicator = el("div", { class: "fx-pull-indicator", text: "Tirer pour actualiser" });
          S.app.appendChild(pullIndicator);
        }
        if (dy > 80) pullIndicator.textContent = "Relâcher pour actualiser";
      }
    }, { passive: true });
    S.listEl.addEventListener("touchend", async (ev) => {
      if (pullIndicator) {
        pullIndicator.remove();
        pullIndicator = null;
        if (pullStartY && ev.changedTouches[0].clientY - pullStartY > 80) {
          buzz(15);
          toast("Actualisation…");
          await load(S.rel);
        }
      }
      pullStartY = 0;
    }, { passive: true });
  }

  async function runInboxZero() {
    toast("Tri Inbox-Zero en cours…");
    try {
      const res = await postJson("/api/inbox-zero", { action: "sort" });
      const moved = (res && res.moved) || 0;
      toast(moved ? (moved === 1 ? "1 fichier rangé" : moved + " fichiers rangés") : "Inbox déjà triée");
      await load(S.rel);
    } catch (e) {
      toast((e && e.message) || "Erreur Inbox-Zero", null, null, true);
    }
  }

  function setView(v) {
    if (S.view === v) return;
    S.view = v;
    try {
      S.win.localStorage.setItem("hq_files_view", v);
    } catch (_) {}
    render(); // the cards morph from one layout to the other (FLIP)
  }

  function paintTrashCount() {
    const n = S.trashBtn && S.trashBtn.querySelector(".fx-n");
    if (!n) return;
    const c = S.trash ? S.trash.items.length : 0;
    n.textContent = String(c);
    n.hidden = !c;
  }

  // ---------------------------------------------------------------- render

  const PILL_FILTERS = [
    { id: "", label: "Tous", icon: "select" },
    { id: "image", label: "Images", icon: "image" },
    { id: "doc_pdf", label: "Docs", icon: "doc" },
    { id: "audio", label: "Audio", icon: "audio" },
    { id: "video", label: "Vidéos", icon: "video" },
    { id: "model", label: "3D", icon: "cube" },
    { id: "code", label: "Code", icon: "code" },
  ];

  function shown() {
    const matched = S.familyFilter ? filterItems(S.items, S.q).filter((it) => matchPill(it, S.familyFilter)) : filterItems(S.items, S.q);
    const sorted = sortItems(matched, S.sort);
    if (!S.pins || !S.pins.size) return sorted;
    const pinned = [];
    const rest = [];
    for (const it of sorted) {
      if (S.pins.has(it.rel)) pinned.push(it);
      else rest.push(it);
    }
    return pinned.concat(rest);
  }

  function renderPills() {
    if (!S.pillsEl) return;
    S.pillsEl.textContent = "";
    if (S.rel === TRASH) {
      S.pillsEl.hidden = true;
      return;
    }
    S.pillsEl.hidden = false;
    const items = filterItems(S.items, S.q);
    PILL_FILTERS.forEach((p) => {
      const count = countPillMatches(items, p.id);
      if (p.id && count === 0) return;
      const active = S.familyFilter === p.id;
      const b = el("button", {
        type: "button",
        class: "fx-pill",
        "aria-pressed": String(active),
        on: {
          click: () => {
            S.familyFilter = active && p.id ? "" : p.id;
            render();
          },
        },
      }, [
        icon(p.icon || "file"),
        el("span", { text: p.label }),
        el("span", { class: "fx-pill-n", text: String(count) }),
      ]);
      S.pillsEl.appendChild(b);
    });
  }

  function renderTelemetry() {
    if (!S.telemetryEl) return;
    if (S.rel === TRASH || !S.items.length) {
      S.telemetryEl.hidden = true;
      return;
    }
    S.telemetryEl.hidden = false;
    S.telemetryEl.textContent = "";

    let totalBytes = 0;
    let fileCount = 0;
    let dirCount = 0;
    const catBytes = {
      image: 0,
      doc: 0,
      audio: 0,
      video: 0,
      model: 0,
      code: 0,
      other: 0,
    };

    for (const it of S.items) {
      if (it.type === "dir") {
        dirCount += 1;
      } else {
        fileCount += 1;
        const b = it.size || 0;
        totalBytes += b;
        const kd = kindOf(it.name);
        if (kd.family === "image") catBytes.image += b;
        else if (kd.family === "pdf" || kd.family === "doc" || kd.family === "sheet" || kd.family === "slides" || kd.family === "text") catBytes.doc += b;
        else if (kd.family === "audio") catBytes.audio += b;
        else if (kd.family === "video") catBytes.video += b;
        else if (kd.family === "model") catBytes.model += b;
        else if (kd.family === "code") catBytes.code += b;
        else catBytes.other += b;
      }
    }

    const head = el("div", { class: "fx-telem-head" }, [
      el("span", {}, [
        el("strong", { text: fmtBytes(totalBytes) }),
        el("span", { text: " occupés" }),
      ]),
      el("span", {
        text: (fileCount ? fileCount + " fichier" + (fileCount > 1 ? "s" : "") : "") +
              (fileCount && dirCount ? " · " : "") +
              (dirCount ? dirCount + " dossier" + (dirCount > 1 ? "s" : "") : ""),
      }),
    ]);

    const bar = el("div", { class: "fx-telem-bar" });
    if (totalBytes > 0) {
      const segColors = {
        image: "hsl(150 65% 50%)",
        doc: "hsl(214 65% 55%)",
        audio: "hsl(330 75% 60%)",
        video: "hsl(18 80% 55%)",
        model: "hsl(190 70% 50%)",
        code: "hsl(280 65% 60%)",
        other: "hsl(220 15% 50%)",
      };
      for (const [k, bytes] of Object.entries(catBytes)) {
        if (!bytes) continue;
        const pct = ((bytes / totalBytes) * 100).toFixed(1);
        const seg = el("div", { class: "fx-telem-seg", title: k + ": " + fmtBytes(bytes) + " (" + pct + "%)" });
        seg.style.width = pct + "%";
        seg.style.backgroundColor = segColors[k] || segColors.other;
        bar.appendChild(seg);
      }
    }

    S.telemetryEl.append(head, bar);
  }

  async function cycleLens() {
    const order = ["none", "heavy", "zero", "recent", "duplicates"];
    const idx = order.indexOf(S.lens);
    S.lens = order[(idx + 1) % order.length];
    mechSound("lens");
    if (S.lens === "duplicates") {
      try {
        toast("Recherche des doublons…");
        const data = await getJson("/api/files/duplicates?rel=" + encodeURIComponent(S.rel || ""));
        S.dupRels = new Set(data.duplicate_rels || []);
        if (!S.dupRels.size) {
          toast("Aucun doublon trouvé dans ce dossier");
        } else {
          toast(S.dupRels.size + " doublon" + (S.dupRels.size > 1 ? "s" : "") + " détecté" + (S.dupRels.size > 1 ? "s" : ""));
        }
      } catch (e) {
        toast((e && e.message) || "Erreur de scan", null, null, true);
        S.dupRels = new Set();
      }
    } else {
      S.dupRels.clear();
    }
    render();
  }

  function renderLensBar() {
    if (!S.lensBarEl) return;
    if (S.lens === "none" || S.rel === TRASH || !S.items.length) {
      S.lensBarEl.hidden = true;
      S.app.classList.remove("has-lens");
      return;
    }
    S.lensBarEl.hidden = false;
    S.app.classList.add("has-lens");
    S.lensBarEl.textContent = "";

    const now = Date.now() / 1000;
    const matches = S.items.filter((it) => isLensMatch(it, S.lens, now, S.dupRels));
    const matchRels = matches.map((it) => it.rel);

    const labels = {
      heavy: "Lentille : Fichiers lourds (> 50 Mo)",
      zero: "Lentille : Fichiers vides (0 o)",
      recent: "Lentille : Récents (< 2 heures)",
      duplicates: "Lentille : Doublons (SHA-256 identiques)",
    };

    const info = el("div", { class: "fx-lens-info" }, [
      icon("sparkles"),
      el("strong", { text: labels[S.lens] || "Lentille" }),
      el("span", { text: "· " + matches.length + " élément" + (matches.length > 1 ? "s" : "") }),
    ]);

    const acts = el("div", { class: "fx-lens-acts" });

    if (matches.length > 0) {
      if (S.lens === "zero") {
        acts.appendChild(btn("Purger les " + matches.length + " fichiers vides", {
          cls: "fx-btn is-danger",
          icon: "trash",
          on: async () => {
            await trash(matchRels);
            S.lens = "none";
            render();
          },
        }));
      } else if (S.lens === "duplicates") {
        acts.appendChild(btn("Purger les " + matches.length + " doublons", {
          cls: "fx-btn is-danger",
          icon: "trash",
          on: async () => {
            await trash(matchRels);
            S.lens = "none";
            S.dupRels.clear();
            render();
          },
        }));
        acts.appendChild(btn("Sélectionner", {
          cls: "fx-btn is-primary",
          icon: "check",
          on: () => {
            matches.forEach((m) => S.sel.add(m.rel));
            S.selecting = true;
            render();
          },
        }));
      } else {
        acts.appendChild(btn("Sélectionner tout", {
          cls: "fx-btn is-primary",
          icon: "check",
          on: () => {
            matches.forEach((m) => S.sel.add(m.rel));
            S.selecting = true;
            render();
          },
        }));
      }
    }

    acts.appendChild(btn("", {
      cls: "fx-btn fx-x",
      icon: "close",
      title: "Désactiver la lentille",
      aria: "Désactiver la lentille",
      on: () => {
        S.lens = "none";
        render();
      },
    }));

    S.lensBarEl.append(info, acts);
  }

  function render() {
    if (!S.listEl) return;
    const before = S.enter ? null : capture();
    for (const b of S.viewSeg.children) b.setAttribute("aria-pressed", String(b.getAttribute("data-view") === S.view));
    S.sortEl.value = S.sort;
    S.app.classList.toggle("is-list", S.view === "list");
    S.app.classList.toggle("is-selecting", S.selecting || S.sel.size > 0);
    S.app.classList.toggle("is-trash", S.rel === TRASH);
    S.uploadBtn.hidden = S.rel === TRASH;
    S.mkdirBtn.hidden = S.rel === TRASH || !S.rel;
    S.selectBtn.hidden = S.rel === TRASH || !S.rel;
    S.selectBtn.setAttribute("aria-pressed", String(S.selecting));
    if (S.lensBtn) {
      S.lensBtn.hidden = S.rel === TRASH || !S.rel;
      S.lensBtn.setAttribute("aria-pressed", String(S.lens !== "none"));
    }
    if (S.dualBtn) {
      S.dualBtn.hidden = S.rel === TRASH;
      S.dualBtn.setAttribute("aria-pressed", String(S.dualMode));
    }
    S.inboxZeroBtn.hidden = !S.rel || (!S.rel.startsWith("Inbox") && S.rel !== "Inbox");
    S.trashBtn.hidden = S.rel === TRASH;
    paintTrashCount();
    renderCrumbs();
    renderPills();
    renderTelemetry();
    renderLensBar();
    const L = S.listEl;
    L.textContent = "";
    L.classList.toggle("is-enter", !!S.enter && !calm());
    if (S.rel === TRASH) {
      L.classList.remove("fx-dual-wrap");
      renderTrash(L);
    } else if (S.dualMode) {
      L.classList.add("fx-dual-wrap");
      const leftCol = el("div", {
        class: "fx-pane is-left" + (S.dualActive === "left" ? " is-active" : ""),
        on: {
          click: () => {
            if (S.dualActive !== "left") {
              S.dualActive = "left";
              S.rel = S.relLeft;
              render();
            }
          },
        },
      });
      const rightCol = el("div", {
        class: "fx-pane is-right" + (S.dualActive === "right" ? " is-active" : ""),
        on: {
          click: () => {
            if (S.dualActive !== "right") {
              S.dualActive = "right";
              S.rel = S.relRight;
              render();
            }
          },
        },
      });

      const leftHead = el("div", { class: "fx-pane-head" }, [
        el("span", {}, [icon("folder"), el("strong", { text: " " + (S.relLeft || "Racine") })]),
        el("span", { class: "fx-hint", text: S.dualActive === "left" ? "Actif (Tab pour basculer)" : "Cliquer pour activer" }),
      ]);
      const rightHead = el("div", { class: "fx-pane-head" }, [
        el("span", {}, [icon("folder"), el("strong", { text: " " + (S.relRight || "Racine") })]),
        el("span", { class: "fx-hint", text: S.dualActive === "right" ? "Actif (Tab pour basculer)" : "Cliquer pour activer" }),
      ]);
      dropTarget(leftCol, S.relLeft || "Inbox");
      dropTarget(rightCol, S.relRight || "Inbox");

      const items = shown();
      const leftList = el("div", { class: "fx-list" });
      if (!items.length) leftList.appendChild(empty());
      items.forEach((it, k) => leftList.appendChild(it.type === "dir" ? folderTile(it, k) : fileTile(it, k)));

      leftCol.append(leftHead, leftList);
      rightCol.append(rightHead, el("p", { class: "fx-hint", style: "padding:24px 12px;text-align:center", text: "Volet miroir : " + (S.relRight || "Racine") + ". Glissez des fichiers ici ou cliquez pour y naviguer." }));

      L.append(leftCol, rightCol);
    } else {
      L.classList.remove("fx-dual-wrap");
      const items = shown();
      if (!items.length) L.appendChild(empty());
      items.forEach((it, k) => L.appendChild(it.type === "dir" ? folderTile(it, k) : fileTile(it, k)));
      const first = (S.focusRel && L.querySelector('.fx-item[data-rel="' + cssEsc(S.focusRel) + '"]')) || L.querySelector(".fx-item[data-rel]");
      if (first) first.tabIndex = 0;
    }
    renderBar();
    paintBackups();
    afterRender(before);
  }

  function renderCrumbs() {
    const nav = S.crumbEl;
    nav.textContent = "";
    S.crumbs.forEach((c, k) => {
      const here = k === S.crumbs.length - 1;
      const tab = el(here ? "span" : "button", { type: here ? null : "button", class: "fx-tab" + (here ? " is-here" : ""), "data-rel": c.rel === TRASH ? null : c.rel, "aria-current": here ? "location" : null });
      tab.style.setProperty("--hue", String(c.rel === TRASH ? 0 : k === 0 ? 210 : rootHue(c.rel)));
      tab.style.setProperty("--k", String(k));
      if (k === 0) tab.appendChild(icon("home"));
      else if (c.rel === TRASH) tab.appendChild(icon("trash"));
      tab.appendChild(el("span", { text: k === 0 ? "Fichiers" : c.name }));
      if (!here) {
        tab.addEventListener("click", () => go(c.rel));
        dropTarget(tab, c.rel);
        let press = 0;
        tab.addEventListener("pointerdown", () => {
          press = S.win.setTimeout(() => {
            crumbJump(c.rel, c.name || "Racine");
          }, 450);
        });
        const cancel = () => {
          if (press) {
            S.win.clearTimeout(press);
            press = 0;
          }
        };
        tab.addEventListener("pointerup", cancel);
        tab.addEventListener("pointercancel", cancel);
        tab.addEventListener("pointermove", cancel);
        tab.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          crumbJump(c.rel, c.name || "Racine");
        });
      }
      nav.appendChild(tab);
    });
  }

  async function crumbJump(rel, label) {
    try {
      const qs = rel ? "?path=" + encodeURIComponent(rel) : "";
      const data = await call("/api/list" + qs);
      const dirs = (data.items || []).filter((it) => it.type === "dir");
      const list = el("div", { class: "fx-crumb-jump-list" });
      const jumpTo = (targetRel) => {
        closeSheet();
        go(targetRel);
      };
      const hereBtn = btn("Aller dans " + (label || "ce dossier"), {
        cls: "fx-btn is-primary",
        icon: "folder",
        on: () => jumpTo(rel),
      });
      list.appendChild(hereBtn);
      if (dirs.length) {
        const subHead = el("h4", { class: "fx-sheet-subhead", text: "Sous-dossiers (" + dirs.length + ")" });
        const subGrid = el("div", { class: "fx-sheet-subgrid" });
        dirs.forEach((d) => {
          const b = btn(d.name, {
            cls: "fx-btn",
            icon: "folder",
            on: () => jumpTo(d.rel),
          });
          subGrid.appendChild(b);
        });
        list.append(subHead, subGrid);
      } else {
        list.appendChild(el("p", { class: "fx-hint", text: "Aucun sous-dossier direct." }));
      }
      openSheet("Naviguer : " + (label || "Fichiers"), list, [btn("Fermer", { on: () => closeSheet() })]);
    } catch (e) {
      toast((e && e.message) || "Erreur de chargement", null, null, true);
    }
  }

  function empty() {
    if (S.q.trim()) return el("div", { class: "fx-empty" }, [el("p", { text: "Rien ne s'appelle « " + S.q.trim() + " » ici." })]);
    const isZeroDopamine = S.rel && S.rel !== TRASH && S.zeroCelebrated;
    const box = el("div", { class: "fx-empty is-drop" + (isZeroDopamine ? " is-dopamine-zero" : "") }, [
      emptyArt(),
      el("h3", { text: isZeroDopamine ? "Zéro Fichier · Maîtrise Totale" : "Ce dossier est vide" }),
      el("p", { text: isZeroDopamine ? "« Répertoire anéanti, Maître. Le disque respire sous votre coupe. »" : (fine() ? "Glisse des fichiers ici depuis ton ordinateur, ou envoie-les avec le bouton." : "Envoie des photos ou des fichiers depuis ton téléphone.") }),
      btn("Envoyer ici", { cls: "fx-btn is-primary", icon: "upload", on: () => pickUpload() }),
    ]);
    return box;
  }

  function emptyArt() {
    const s = S.doc.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 200 120");
    s.setAttribute("class", "fx-empty-art");
    s.setAttribute("aria-hidden", "true");
    const add = (tag, a) => {
      const n = S.doc.createElementNS(SVG_NS, tag);
      for (const k of Object.keys(a)) n.setAttribute(k, a[k]);
      s.appendChild(n);
      return n;
    };
    add("path", { d: "M30 34a6 6 0 0 1 6-6h34l10 10h84a6 6 0 0 1 6 6v58a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6z", class: "a-back" });
    add("rect", { x: 54, y: 22, width: 56, height: 70, rx: 4, class: "a-paper p1" });
    add("rect", { x: 86, y: 16, width: 56, height: 70, rx: 4, class: "a-paper p2" });
    add("path", { d: "M26 52a6 6 0 0 1 6-6h136a6 6 0 0 1 6 6l-6 50a6 6 0 0 1-6 6H38a6 6 0 0 1-6-6z", class: "a-front" });
    return s;
  }

  function hueStyle(node, rel) {
    node.style.setProperty("--hue", String(rootHue(rel)));
  }

  function selectedAttrs(rel) {
    return { "aria-selected": String(S.sel.has(rel)) };
  }

  function folderTile(it, k) {
    const t = el("div", Object.assign({ class: "fx-item fx-folder" + (S.landed.has(it.rel) ? " is-landed" : ""), role: "option", tabindex: "-1", "data-rel": it.rel, "data-flip": it.rel, draggable: S.rel ? "true" : null }, selectedAttrs(it.rel)));
    hueStyle(t, it.rel);
    t.style.setProperty("--k", String(Math.min(k, 16)));
    const art = el("span", { class: "fx-folder-art", "aria-hidden": "true" }, [
      el("span", { class: "fx-folder-back" }),
      el("span", { class: "fx-folder-papers" }),
      el("span", { class: "fx-folder-front" }),
    ]);
    const name = el("span", { class: "fx-name", text: it.name });
    const meta = el("span", { class: "fx-meta", text: when(it.mtime, Date.now() / 1000) });
    t.append(art, el("span", { class: "fx-text" }, [name, meta]), checkMark());
    if (S.pins.has(it.rel)) {
      t.appendChild(el("span", { class: "fx-pin-badge", title: "Épinglé", "aria-hidden": "true" }, [icon("pin")]));
    }
    if (S.tags.has(it.rel)) {
      const c = S.tags.get(it.rel);
      t.appendChild(el("span", { class: "fx-tag-dots", "aria-hidden": "true" }, [
        el("span", { class: "fx-tag-dot is-" + c })
      ]));
    }
    paintPeek(t);
    paintShield(t);
    wireFolderFan(t, it);
    wireItem(t, it);
    dropTarget(t, it.rel);
    return t;
  }

  function paintPeek(t) {
    const rel = t.getAttribute("data-rel");
    const pk = S.peeks.get(rel);
    if (!pk) return;
    const papers = t.querySelector(".fx-folder-papers");
    if (papers && !papers.childNodes.length) {
      pk.pics.slice(0, 3).forEach((p, j) => {
        const img = el("img", { class: "fx-peek", src: fileUrl(p), alt: "", loading: "lazy", decoding: "async" });
        img.style.setProperty("--j", String(j));
        img.style.setProperty("--n", String(Math.min(3, pk.pics.length)));
        papers.appendChild(img);
      });
      if (!pk.pics.length && pk.files + pk.dirs) for (let j = 0; j < Math.min(3, pk.files + pk.dirs); j += 1) {
        const sh = el("span", { class: "fx-sheet-paper" });
        sh.style.setProperty("--j", String(j));
        papers.appendChild(sh);
      }
    }
    const meta = t.querySelector(".fx-meta");
    if (meta) {
      const bits = [];
      if (pk.dirs) bits.push(pk.dirs + (pk.dirs > 1 ? " dossiers" : " dossier"));
      if (pk.files) bits.push(pk.files + (pk.files > 1 ? " fichiers" : " fichier"));
      meta.textContent = bits.length ? bits.join(", ") : "Vide";
    }
  }

  function checkMark() {
    return el("span", { class: "fx-check", "aria-hidden": "true" }, [icon("check")]);
  }

  function fileTile(it, k) {
    const kd = kindOf(it.name);
    const t = el("div", Object.assign({ class: "fx-item fx-file is-" + kd.family + (S.landed.has(it.rel) ? " is-landed" : ""), role: "option", tabindex: "-1", "data-rel": it.rel, "data-flip": it.rel, draggable: "true" }, selectedAttrs(it.rel)));
    t.style.setProperty("--kh", String(kd.hue));
    t.style.setProperty("--k", String(Math.min(k, 16)));
    const face = el("span", { class: "fx-face", "aria-hidden": "true" });
    if (kd.family === "image" && kd.ext !== "heic" && kd.ext !== "heif") {
      const img = el("img", { class: "fx-thumb", src: fileUrl(it.rel), alt: "", loading: "lazy", decoding: "async" });
      img.addEventListener("load", () => face.classList.add("is-loaded"));
      img.addEventListener("error", () => {
        img.remove();
        face.appendChild(svgPath(FAMILY_ICON.image, "fx-face-ico"));
      });
      face.appendChild(img);
      face.classList.add("has-thumb");
    } else {
      face.appendChild(svgPath(FAMILY_ICON[kd.family] || FAMILY_ICON.file, "fx-face-ico"));
      if (kd.family === "text" || kd.family === "code" || kd.family === "doc" || kd.family === "pdf") face.appendChild(el("span", { class: "fx-lines" }));
    }
    if (kd.family === "audio") {
      face.appendChild(el("span", { class: "fx-card-wave", "aria-hidden": "true" }, [
        el("span"), el("span"), el("span"), el("span"), el("span"),
      ]));
    } else if (kd.family === "video" && PLAYABLE.test(it.name)) {
      const v = el("video", { class: "fx-video-scrub", preload: "metadata", muted: "true", playsinline: "true" });
      v.src = mediaUrl(it.rel);
      v.addEventListener("error", () => v.remove());
      face.appendChild(v);
      face.classList.add("has-thumb");
      t.addEventListener("mousemove", (ev) => {
        if (!v.duration || calm()) return;
        const r = t.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        v.currentTime = pct * v.duration;
      });
    } else if (kd.family === "model") {
      face.appendChild(el("span", { class: "fx-card-badge-3d", title: "Modèle 3D", "aria-hidden": "true" }, [
        icon("cube"),
      ]));
      wireTurntable(face);
    }
    if (it.size && it.size >= 50 * 1024 * 1024) {
      t.classList.add("is-heavy-weight");
      t.appendChild(el("span", { class: "fx-weight-badge", title: "Masse tactile (>50 Mo)", "aria-hidden": "true" }, [
        icon("cube"),
        el("span", { text: it.size_h })
      ]));
    }
    if (S.lens !== "none") {
      const now = Date.now() / 1000;
      if (isLensMatch(it, S.lens, now, S.dupRels)) {
        t.classList.add("is-lens-match", "is-lens-" + S.lens);
      }
    }
    if (S.pins.has(it.rel)) {
      t.appendChild(el("span", { class: "fx-pin-badge", title: "Épinglé", "aria-hidden": "true" }, [icon("pin")]));
    }
    if (S.tags.has(it.rel)) {
      const c = S.tags.get(it.rel);
      t.appendChild(el("span", { class: "fx-tag-dots", "aria-hidden": "true" }, [
        el("span", { class: "fx-tag-dot is-" + c })
      ]));
    }
    face.appendChild(el("span", { class: "fx-stamp", text: (kd.ext || "?").toUpperCase().slice(0, 5) }));
    face.appendChild(el("span", { class: "fx-dogear" }));
    // the extension never disappears behind an ellipsis: « un-tres-long-nom….pdf »
    const dot = it.name.lastIndexOf(".");
    const name = el("span", { class: "fx-name is-file", title: it.name }, dot > 0 ? [el("span", { class: "fx-stem", text: it.name.slice(0, dot) }), el("span", { class: "fx-ext", text: it.name.slice(dot) })] : [el("span", { class: "fx-stem", text: it.name })]);
    const meta = el("span", { class: "fx-meta", text: it.size_h + " · " + when(it.mtime, Date.now() / 1000) });
    t.append(face, el("span", { class: "fx-text" }, [name, meta]), checkMark());
    wireItem(t, it);
    wireQuickPeep(t, it);
    return t;
  }

  // ---------------------------------------------------------------- motion

  function capture() {
    const map = new Map();
    if (calm()) return map;
    for (const n of S.listEl.querySelectorAll("[data-flip]")) map.set(n.getAttribute("data-flip"), n.getBoundingClientRect());
    return map;
  }

  function afterRender(before) {
    const L = S.listEl;
    if (S.spillFrom && !calm()) {
      // the folder you opened spills its contents: every card starts at the folder and lands in its place
      const from = S.spillFrom;
      Array.prototype.forEach.call(L.querySelectorAll(".fx-item"), (n, k) => {
        const r = n.getBoundingClientRect();
        if (r.top > S.win.innerHeight + 200) return;
        const dx = from.left + from.width / 2 - (r.left + r.width / 2);
        const dy = from.top + from.height / 2 - (r.top + r.height / 2);
        anim(n, [
          { transform: "translate(" + dx + "px," + dy + "px) scale(.25) rotate(" + ((k % 2 ? 1 : -1) * 8) + "deg)", opacity: 0 },
          { transform: "translate(0,0) scale(1.03) rotate(0)", opacity: 1, offset: 0.7 },
          { transform: "none", opacity: 1 },
        ], { duration: 560, delay: Math.min(k, 18) * 22, easing: EASE, fill: "backwards" });
      });
      S.spillFrom = null;
    } else if (before && before.size) {
      for (const n of L.querySelectorAll("[data-flip]")) {
        const was = before.get(n.getAttribute("data-flip"));
        const r = n.getBoundingClientRect();
        if (was) {
          const dx = was.left - r.left;
          const dy = was.top - r.top;
          const sx = was.width / (r.width || 1);
          const sy = was.height / (r.height || 1);
          if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(sx - 1) > 0.02) {
            anim(n, [{ transformOrigin: "0 0", transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")" }, { transformOrigin: "0 0", transform: "none" }], { duration: 420, easing: SPRING });
          }
        } else {
          anim(n, [{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: SPRING });
        }
      }
    }
    S.enter = false;
    S.landed.clear();
  }

  /** Cards crumple and fly to the Corbeille button. */
  async function flyToTrash(rels) {
    const target = S.trashBtn;
    if (calm() || !target) return;
    const tr = target.getBoundingClientRect();
    const runs = [];
    rels.slice(0, 12).forEach((rel, k) => {
      const n = S.listEl.querySelector('[data-rel="' + cssEsc(rel) + '"]');
      if (!n) return;
      const r = n.getBoundingClientRect();
      const dx = tr.left + tr.width / 2 - (r.left + r.width / 2);
      const dy = tr.top + tr.height / 2 - (r.top + r.height / 2);
      const a = anim(n, [
        { transform: "none", opacity: 1 },
        { transform: "scale(.82,.7) rotate(-6deg)", opacity: 1, offset: 0.3 },
        { transform: "translate(" + dx + "px," + dy + "px) scale(.12) rotate(-30deg)", opacity: 0.2 },
      ], { duration: 560, delay: k * 40, easing: "cubic-bezier(.5,0,.75,.25)", fill: "forwards" });
      if (a) runs.push(a.finished.catch(() => {}));
    });
    await Promise.all(runs);
    anim(target, [{ transform: "none" }, { transform: "scale(1.15) rotate(-6deg)", offset: 0.4 }, { transform: "none" }], { duration: 420, easing: SPRING });
  }

  /** Cards shrink into the folder they were dropped on, which gulps. */
  async function flyInto(rels, folderEl) {
    if (calm() || !folderEl) return;
    const fr = folderEl.getBoundingClientRect();
    const runs = [];
    rels.slice(0, 12).forEach((rel, k) => {
      const n = S.listEl.querySelector('[data-rel="' + cssEsc(rel) + '"]');
      if (!n) return;
      const r = n.getBoundingClientRect();
      const a = anim(n, [{ transform: "none", opacity: 1 }, { transform: "translate(" + (fr.left + fr.width / 2 - r.left - r.width / 2) + "px," + (fr.top + fr.height / 3 - r.top - r.height / 2) + "px) scale(.15)", opacity: 0 }], { duration: 440, delay: k * 35, easing: "cubic-bezier(.5,0,.75,.25)", fill: "forwards" });
      if (a) runs.push(a.finished.catch(() => {}));
    });
    await Promise.all(runs);
    anim(folderEl, [{ transform: "none" }, { transform: "scale(1.08,.94)", offset: 0.35 }, { transform: "scale(.98,1.03)", offset: 0.7 }, { transform: "none" }], { duration: 460, easing: "ease-out" });
  }

  function cssEsc(s) {
    return (S.win.CSS && S.win.CSS.escape) ? S.win.CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
  }

  // ---------------------------------------------------------------- navigation

  function go(rel, opts) {
    const o = opts || {};
    if (o.from && !calm()) S.spillFrom = o.from;
    if (!o.isNav && S.rel !== rel) {
      if (S.histIdx < S.history.length - 1) {
        S.history = S.history.slice(0, S.histIdx + 1);
      }
      S.history.push(rel);
      if (S.history.length > 50) {
        S.history.shift();
      }
      S.histIdx = S.history.length - 1;
    }
    if (S.dualMode) {
      if (S.dualActive === "left") S.relLeft = rel;
      else S.relRight = rel;
    }
    return load(rel);
  }

  function goBack() {
    if (S.histIdx > 0) {
      S.histIdx -= 1;
      return go(S.history[S.histIdx], { isNav: true });
    } else {
      toast("Début de l'historique");
    }
  }

  function goForward() {
    if (S.histIdx < S.history.length - 1) {
      S.histIdx += 1;
      return go(S.history[S.histIdx], { isNav: true });
    } else {
      toast("Fin de l'historique");
    }
  }

  function openFolder(tile, rel) {
    tile.classList.add("is-opening"); // the front flap swings open, then the folder spills its content
    const from = tile.getBoundingClientRect();
    S.win.setTimeout(() => go(rel, { from }), calm() ? 0 : 160);
  }

  // ---------------------------------------------------------------- items: click, select, drag

  function order() {
    return Array.prototype.map.call(S.listEl.querySelectorAll(".fx-item[data-rel]"), (n) => n.getAttribute("data-rel"));
  }

  function toggleSel(rel, on) {
    if (on === undefined ? !S.sel.has(rel) : on) S.sel.add(rel);
    else S.sel.delete(rel);
    S.anchor = rel;
    mechSound("pop");
    const n = S.listEl.querySelector('[data-rel="' + cssEsc(rel) + '"]');
    if (n) {
      n.setAttribute("aria-selected", String(S.sel.has(rel)));
      if (S.sel.has(rel)) anim(n.querySelector(".fx-check"), [{ transform: "scale(.4)" }, { transform: "scale(1.2)", offset: 0.6 }, { transform: "none" }], { duration: 320, easing: SPRING });
    }
    S.app.classList.toggle("is-selecting", S.selecting || S.sel.size > 0);
    renderBar();
  }

  function flyToLecteur(fromEl) {
    if (typeof S.win.hqPlayerFlyFrom !== "function" || !fromEl) return;
    const card = fromEl.closest ? fromEl.closest(".fx-card, li.file") : fromEl;
    if (!card) return;
    const img = card.querySelector("img");
    const rect = card.getBoundingClientRect();
    S.win.hqPlayerFlyFrom(rect, img && img.src ? img.src : "");
    if (typeof S.win.hqPolishLecteurHint === "function") S.win.hqPolishLecteurHint(true);
  }

  function wireParallax(t) {
    if (calm() || !fine()) return;
    const glare = el("span", { class: "fx-glare", "aria-hidden": "true" });
    t.appendChild(glare);

    t.addEventListener("pointermove", (ev) => {
      const r = t.getBoundingClientRect();
      const x = (ev.clientX - r.left) / r.width;
      const y = (ev.clientY - r.top) / r.height;
      const tiltX = ((y - 0.5) * -12).toFixed(2);
      const tiltY = ((x - 0.5) * 12).toFixed(2);
      t.style.setProperty("--tilt-x", tiltX + "deg");
      t.style.setProperty("--tilt-y", tiltY + "deg");
      t.style.setProperty("--glare-x", (x * 100).toFixed(1) + "%");
      t.style.setProperty("--glare-y", (y * 100).toFixed(1) + "%");
      t.style.setProperty("--mx", (ev.clientX - r.left) + "px");
      t.style.setProperty("--my", (ev.clientY - r.top) + "px");
    });

    t.addEventListener("pointerleave", () => {
      t.style.setProperty("--tilt-x", "0deg");
      t.style.setProperty("--tilt-y", "0deg");
    });
  }

  function wireTurntable(face) {
    if (calm() || !fine()) return;
    let canvas = null;
    let animId = 0;
    let rotX = 0.5;
    let rotY = 0;

    const renderFrame = () => {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      rotY += 0.024;
      const cx = w / 2;
      const cy = h / 2;
      const s = Math.min(w, h) * 0.28;

      const nodes = [
        [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
        [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
        [0, -1.6, 0], [0, 1.6, 0],
      ];
      const edges = [
        [0, 1], [1, 2], [2, 3], [3, 0],
        [4, 5], [5, 6], [6, 7], [7, 4],
        [0, 4], [1, 5], [2, 6], [3, 7],
        [8, 0], [8, 1], [8, 4], [8, 5],
        [9, 2], [9, 3], [9, 6], [9, 7],
      ];

      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);

      const proj = nodes.map(([x, y, z]) => {
        const x1 = x * cosY - z * sinY;
        const z1 = x * sinY + z * cosY;
        const y2 = y * cosX - z1 * sinX;
        const z2 = y * sinX + z1 * cosX;
        const scale = 300 / (300 + z2 * 40);
        return [cx + x1 * s * scale, cy + y2 * s * scale];
      });

      ctx.strokeStyle = "rgba(79, 209, 197, 0.75)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      edges.forEach(([i, j]) => {
        ctx.moveTo(proj[i][0], proj[i][1]);
        ctx.lineTo(proj[j][0], proj[j][1]);
      });
      ctx.stroke();

      ctx.fillStyle = "#fff";
      proj.forEach(([px, py]) => {
        ctx.beginPath();
        ctx.arc(px, py, 1.8, 0, Math.PI * 2);
        ctx.fill();
      });

      animId = S.win.requestAnimationFrame(renderFrame);
    };

    face.addEventListener("pointerenter", () => {
      if (!canvas) {
        canvas = el("canvas", { class: "fx-turntable-canvas", width: "128", height: "112" });
        face.appendChild(canvas);
      }
      if (!animId) animId = S.win.requestAnimationFrame(renderFrame);
    });

    face.addEventListener("pointerleave", () => {
      if (animId) {
        S.win.cancelAnimationFrame(animId);
        animId = 0;
      }
    });

    face.addEventListener("pointermove", (ev) => {
      const rect = face.getBoundingClientRect();
      const nx = (ev.clientX - rect.left) / rect.width;
      rotY += (nx - 0.5) * 0.12;
    });
  }

  function wireFolderFan(t, it) {
    if (calm() || !fine()) return;
    let fan = null;
    let timer = 0;

    const openFan = () => {
      const pk = S.peeks.get(it.rel);
      if (!pk || (!pk.pics.length && !pk.files)) return;
      if (!fan) {
        fan = el("div", { class: "fx-folder-fan", role: "region", "aria-label": "Aperçu de " + it.name });
        const samplePics = pk.pics.slice(0, 4);
        samplePics.forEach((p) => {
          const stem = p.split("/").pop();
          const chip = el("div", { class: "fx-fan-chip", title: stem, on: { click: (ev) => { ev.stopPropagation(); go(it.rel); } } }, [
            el("img", { class: "fx-fan-thumb", src: fileUrl(p), alt: "" }),
            el("span", { class: "fx-fan-name", text: stem }),
          ]);
          dropTarget(chip, it.rel);
          fan.appendChild(chip);
        });
        t.appendChild(fan);
      }
      fan.classList.add("is-open");
    };

    const closeFan = () => {
      if (timer) {
        S.win.clearTimeout(timer);
        timer = 0;
      }
      if (fan) fan.classList.remove("is-open");
    };

    t.addEventListener("pointerenter", () => {
      timer = S.win.setTimeout(openFan, 350);
    });
    t.addEventListener("pointerleave", closeFan);
    t.addEventListener("click", closeFan);
  }

  function bindMarquee() {
    let startX = 0;
    let startY = 0;
    let active = false;
    let initialSel = null;

    S.listEl.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest && ev.target.closest(".fx-item, button, input, a, .fx-empty")) return;
      startX = ev.clientX;
      startY = ev.clientY;
      active = false;
      initialSel = new Set(ev.shiftKey ? S.sel : []);

      const onPointerMove = (e) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!active) {
          if (Math.hypot(dx, dy) < 6) return;
          active = true;
          S.marqueeEl.hidden = false;
          S.app.classList.add("is-selecting");
        }
        const left = Math.min(startX, e.clientX);
        const top = Math.min(startY, e.clientY);
        const width = Math.abs(dx);
        const height = Math.abs(dy);
        S.marqueeEl.style.left = left + "px";
        S.marqueeEl.style.top = top + "px";
        S.marqueeEl.style.width = width + "px";
        S.marqueeEl.style.height = height + "px";

        const mRect = { left, top, right: left + width, bottom: top + height };
        let newlySelected = false;

        const tiles = S.listEl.querySelectorAll(".fx-item[data-rel]");
        for (let i = 0; i < tiles.length; i++) {
          const tile = tiles[i];
          const r = tile.getBoundingClientRect();
          const rel = tile.getAttribute("data-rel");
          if (!rel) continue;
          const overlaps = !(r.right < mRect.left || r.left > mRect.right || r.bottom < mRect.top || r.top > mRect.bottom);
          const wasSelected = S.sel.has(rel);
          if (overlaps) {
            if (!wasSelected) {
              S.sel.add(rel);
              tile.setAttribute("aria-selected", "true");
              newlySelected = true;
            }
          } else if (!initialSel.has(rel)) {
            if (wasSelected) {
              S.sel.delete(rel);
              tile.setAttribute("aria-selected", "false");
            }
          }
        }
        if (newlySelected) {
          mechSound("tick");
          renderBar();
        }
      };

      const onPointerUp = () => {
        S.win.removeEventListener("pointermove", onPointerMove);
        S.win.removeEventListener("pointerup", onPointerUp);
        S.win.removeEventListener("pointercancel", onPointerUp);
        if (active) {
          active = false;
          S.marqueeEl.hidden = true;
          S.selecting = S.sel.size > 0;
          renderBar();
        }
      };

      S.win.addEventListener("pointermove", onPointerMove);
      S.win.addEventListener("pointerup", onPointerUp);
      S.win.addEventListener("pointercancel", onPointerUp);
    });
  }

  function wireItem(t, it) {
    wireParallax(t);
    t.addEventListener("pointermove", (ev) => {
      const r = t.getBoundingClientRect();
      t.style.setProperty("--mx", (ev.clientX - r.left) + "px");
      t.style.setProperty("--my", (ev.clientY - r.top) + "px");
    }, { passive: true });
    const rel = it.rel;
    let press = 0;
    let pressXY = null;
    t.addEventListener("click", (ev) => {
      if (t.__longPressed) {
        t.__longPressed = false;
        return;
      }
      if (ev.shiftKey && S.anchor) {
        for (const r of rangeSelect(order(), S.anchor, rel)) S.sel.add(r);
        render();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey || S.selecting || S.sel.size) && S.rel) {
        toggleSel(rel);
        return;
      }
      S.focusRel = rel;
      if (it.type === "dir") openFolder(t, rel);
      else if (FOR_LECTEUR.test(it.name) && typeof S.win.hqPlayerOpen === "function") {
        // songs, videos, 3D: a double click / double tap plays in the Lecteur (iOS fires no dblclick, so taps are
        // counted here); a single one opens the quick look once the double-tap window has passed
        if (t.__tap) {
          S.win.clearTimeout(t.__tap);
          t.__tap = 0;
          closeSheet(true);
          flyToLecteur(t);
          S.win.hqPlayerOpen(rel, true);
          return;
        }
        t.__tap = S.win.setTimeout(() => {
          t.__tap = 0;
          quickLook(it, t);
        }, DOUBLE_TAP_MS);
      } else quickLook(it, t);
    });
    // touch: a long press starts selecting, swipe right selects, swipe left opens actions
    let touchStartX = 0;
    let touchStartY = 0;
    t.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "mouse") return;
      touchStartX = ev.clientX;
      touchStartY = ev.clientY;
      if (!S.rel) return; // the three top folders are not selectable
      pressXY = [ev.clientX, ev.clientY];
      press = S.win.setTimeout(() => {
        t.__longPressed = true;
        buzz(12);
        S.selecting = true;
        toggleSel(rel, true);
        S.app.classList.add("is-selecting");
      }, 480);
    });
    const cancel = (ev) => {
      if (press && (!ev || ev.type !== "pointermove" || (pressXY && Math.hypot(ev.clientX - pressXY[0], ev.clientY - pressXY[1]) > 10))) {
        S.win.clearTimeout(press);
        press = 0;
      }
    };
    t.addEventListener("pointermove", cancel);
    t.addEventListener("pointerup", (ev) => {
      if (pressXY && ev.pointerType !== "mouse" && S.rel) {
        const dx = ev.clientX - touchStartX;
        const dy = ev.clientY - touchStartY;
        if (Math.abs(dx) > 75 && Math.abs(dy) < 40) {
          t.__longPressed = true;
          if (dx > 0) {
            toggleSel(rel);
            buzz(10);
          } else {
            buzz(10);
            openSheet("Actions : " + it.name, el("div", { style: "display:flex;flex-direction:column;gap:10px;padding:8px 0" }, [
              btn("Déplacer", { cls: "fx-btn", icon: "move", on: () => { closeSheet(); movePicker([rel]); } }),
              btn("Télécharger", { cls: "fx-btn", icon: "download", on: () => { closeSheet(); S.win.location.href = dlUrl(rel); } }),
              btn("Corbeille", { cls: "fx-btn is-danger", icon: "trash", on: () => { closeSheet(); trash([rel]); } }),
            ]), [btn("Annuler", { on: () => closeSheet() })]);
          }
        }
      }
      cancel(ev);
    });
    t.addEventListener("pointercancel", cancel);
    t.addEventListener("contextmenu", (ev) => {
      if (!fine()) ev.preventDefault();
    });
    // desktop drag: move to a folder or a breadcrumb tab
    t.addEventListener("dragstart", (ev) => {
      const rels = S.sel.has(rel) ? [...S.sel] : [rel];
      S.drag = { rels };
      t.classList.add("is-dragging");
      try {
        ev.dataTransfer.setData("text/plain", rels.join("\n"));
        ev.dataTransfer.effectAllowed = "move";
        if (rels.length > 1) {
          const ghost = el("div", { class: "fx-drag-ghost" }, [el("strong", { text: String(rels.length) }), " éléments"]);
          S.doc.body.appendChild(ghost);
          ev.dataTransfer.setDragImage(ghost, 30, 20);
          S.win.setTimeout(() => ghost.remove(), 0);
        }
      } catch (_) {}
    });
    t.addEventListener("dragend", () => {
      t.classList.remove("is-dragging");
      S.drag = null;
      for (const n of S.app.querySelectorAll(".is-drop-over")) n.classList.remove("is-drop-over");
    });
  }

  let springTimer = 0;
  let springNode = null;

  function dropTarget(node, rel) {
    node.addEventListener("dragover", (ev) => {
      const files = ev.dataTransfer && Array.prototype.includes.call(ev.dataTransfer.types || [], "Files");
      if (!S.drag && !files) return;
      if (!rel) return; // the top level is not a folder you can write to
      if (S.drag && S.drag.rels.some((r) => within(rel, r) || parentOf(r) === rel)) return; // into itself, or where it already is
      ev.preventDefault();
      ev.stopPropagation();
      node.classList.add("is-drop-over");
      if (files) showDrop(rel);
      if (node.classList.contains("fx-folder")) {
        node.classList.add("is-magnetic-snap");
        if (S.drag && rel) {
          if (springNode !== node) {
            if (springTimer) S.win.clearTimeout(springTimer);
            springNode = node;
            springTimer = S.win.setTimeout(() => {
              if (springNode === node && S.drag) {
                node.classList.add("is-springing");
                mechSound("snap");
                go(rel);
              }
            }, 550);
          }
        }
      }
    });
    node.addEventListener("dragleave", (ev) => {
      if (!node.contains(ev.relatedTarget)) {
        node.classList.remove("is-drop-over", "is-magnetic-snap");
        if (springNode === node) {
          if (springTimer) S.win.clearTimeout(springTimer);
          springTimer = 0;
          node.classList.remove("is-springing");
          springNode = null;
        }
      }
    });
    node.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      node.classList.remove("is-drop-over", "is-magnetic-snap");
      if (springTimer) {
        S.win.clearTimeout(springTimer);
        springTimer = 0;
      }
      if (springNode) {
        springNode.classList.remove("is-springing");
        springNode = null;
      }
      hideDrop();
      if (!calm()) {
        node.classList.add("is-landing");
        S.win.setTimeout(() => node.classList.remove("is-landing"), 350);
      }
      mechSound("latch");
      buzz([10, 30, 10]);
      if (S.drag) {
        const rels = S.drag.rels;
        S.drag = null;
        await moveTo(rels, rel, node);
      } else if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length && rel) {
        upload(ev.dataTransfer.files, rel, node);
      }
    });
  }

  async function downloadZip(rels) {
    if (!rels || !rels.length) return;
    toast("Création du ZIP (" + rels.length + " éléments)…");
    try {
      const res = await S.win.fetch("/api/files/zip", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rels }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Erreur de téléchargement ZIP (" + res.status + ")");
      }
      const blob = await res.blob();
      const url = S.win.URL.createObjectURL(blob);
      const a = el("a", { href: url, download: "fichiers-selection.zip" });
      S.doc.body.appendChild(a);
      a.click();
      a.remove();
      S.win.setTimeout(() => S.win.URL.revokeObjectURL(url), 10000);
      toast("ZIP téléchargé");
    } catch (e) {
      toast((e && e.message) || "Échec du téléchargement", null, null, true);
    }
  }

  async function unzipArchive(rel, destRel) {
    if (!rel) return;
    toast("Décompression en cours…");
    try {
      const res = await postJson("/api/files/unzip", { rel, dest_rel: destRel });
      const n = (res && res.extracted) || 0;
      toast(n ? n + " fichiers extraits" : "Archive extraite");
      await load(S.rel);
    } catch (e) {
      toast((e && e.message) || "Échec de l'extraction", null, null, true);
    }
  }

  function openBatchRenamer(rels) {
    if (!rels || rels.length < 2) return;
    const names = rels.map((r) => r.split("/").pop());
    let currentMode = "prefix_suffix";
    const opts = { prefix: "", suffix: "", find: "", replace: "", start: 1, pad: 2, stem: "fichier", target: "kebab" };

    const modeWrap = el("div", { class: "fx-batch-modes" });
    const modes = [
      { id: "prefix_suffix", label: "Préfixe / Suffixe" },
      { id: "find_replace", label: "Chercher & Remplacer" },
      { id: "sequence", label: "Séquence numérotée" },
      { id: "case", label: "Minuscules / Kebab" },
    ];

    const fieldsWrap = el("div", { class: "fx-batch-fields" });
    const previewList = el("div", { class: "fx-batch-preview" });

    const updatePreview = () => {
      const renames = computeBatchRenames(names, currentMode, opts);
      previewList.textContent = "";
      renames.forEach((r) => {
        const row = el("div", { class: "fx-batch-row" }, [
          el("span", { class: "fx-batch-old", text: r.oldName }),
          el("span", { text: "→" }),
          el("span", { class: "fx-batch-new", text: r.newName }),
        ]);
        previewList.appendChild(row);
      });
    };

    const renderFields = () => {
      fieldsWrap.textContent = "";
      if (currentMode === "prefix_suffix") {
        const preIn = el("input", { type: "text", class: "fx-batch-input", placeholder: "Préfixe (ex: 2026-11-16_)", value: opts.prefix });
        preIn.addEventListener("input", () => { opts.prefix = preIn.value; updatePreview(); });
        const sufIn = el("input", { type: "text", class: "fx-batch-input", placeholder: "Suffixe", value: opts.suffix });
        sufIn.addEventListener("input", () => { opts.suffix = sufIn.value; updatePreview(); });
        fieldsWrap.append(preIn, sufIn);
      } else if (currentMode === "find_replace") {
        const findIn = el("input", { type: "text", class: "fx-batch-input", placeholder: "Rechercher…", value: opts.find });
        findIn.addEventListener("input", () => { opts.find = findIn.value; updatePreview(); });
        const repIn = el("input", { type: "text", class: "fx-batch-input", placeholder: "Remplacer par…", value: opts.replace });
        repIn.addEventListener("input", () => { opts.replace = repIn.value; updatePreview(); });
        fieldsWrap.append(findIn, repIn);
      } else if (currentMode === "sequence") {
        const stemIn = el("input", { type: "text", class: "fx-batch-input", placeholder: "Nom de base", value: opts.stem });
        stemIn.addEventListener("input", () => { opts.stem = stemIn.value; updatePreview(); });
        const startIn = el("input", { type: "number", class: "fx-batch-input", placeholder: "Début (1)", value: String(opts.start), min: "0" });
        startIn.addEventListener("input", () => { opts.start = Number(startIn.value) || 1; updatePreview(); });
        fieldsWrap.append(stemIn, startIn);
      } else if (currentMode === "case") {
        const kebabBtn = btn("kebab-case", { cls: "fx-btn" + (opts.target === "kebab" ? " is-primary" : ""), on: () => { opts.target = "kebab"; renderFields(); updatePreview(); } });
        const snakeBtn = btn("snake_case", { cls: "fx-btn" + (opts.target === "snake" ? " is-primary" : ""), on: () => { opts.target = "snake"; renderFields(); updatePreview(); } });
        const lowerBtn = btn("minuscules", { cls: "fx-btn" + (opts.target === "lower" ? " is-primary" : ""), on: () => { opts.target = "lower"; renderFields(); updatePreview(); } });
        fieldsWrap.append(kebabBtn, snakeBtn, lowerBtn);
      }
    };

    modes.forEach((m) => {
      const b = btn(m.label, {
        cls: "fx-btn" + (m.id === currentMode ? " is-primary" : ""),
        on: () => {
          currentMode = m.id;
          for (let i = 0; i < modeWrap.children.length; i++) {
            modeWrap.children[i].classList.toggle("is-primary", modes[i].id === currentMode);
          }
          renderFields();
          updatePreview();
        },
      });
      modeWrap.appendChild(b);
    });

    renderFields();
    updatePreview();

    const applyBtn = btn("Appliquer le renommage (" + rels.length + ")", {
      cls: "fx-btn is-primary",
      icon: "check",
      on: async () => {
        applyBtn.disabled = true;
        toast("Renommage en cours…");
        const renames = computeBatchRenames(names, currentMode, opts);
        let success = 0;
        for (let i = 0; i < rels.length; i++) {
          const oldRel = rels[i];
          const newName = renames[i].newName;
          if (newName && newName !== names[i]) {
            try {
              const p = parentOf(oldRel);
              const target = p ? p + "/" + newName : newName;
              await postJson("/api/rename", { old_path: oldRel, new_path: target });
              success += 1;
            } catch (_) {}
          }
        }
        closeSheet();
        toast(success ? success + " fichiers renommés" : "Aucun changement");
        S.sel.clear();
        await load(S.rel);
      },
    });

    const wrap = el("div", { class: "fx-batch-wrap" }, [modeWrap, fieldsWrap, previewList]);
    openSheet("Renommer " + rels.length + " fichiers", wrap, [btn("Annuler", { on: () => closeSheet() }), applyBtn], "is-batch");
  }

  async function openComparator(rels) {
    if (!rels || rels.length !== 2) return;
    const it1 = S.items.find((x) => x.rel === rels[0]);
    const it2 = S.items.find((x) => x.rel === rels[1]);
    if (!it1 || !it2) return;
    const kd1 = kindOf(it1.name);
    const kd2 = kindOf(it2.name);

    if (kd1.family === "image" && kd2.family === "image") {
      const stage = el("div", { class: "fx-curtain-stage" });
      stage.style.setProperty("--curtain", "50%");
      const img1 = el("img", { class: "fx-curtain-img", src: fileUrl(it1.rel), alt: it1.name });
      const img2 = el("img", { class: "fx-curtain-img fx-curtain-top", src: fileUrl(it2.rel), alt: it2.name });
      const line = el("div", { class: "fx-curtain-line" }, [
        el("div", { class: "fx-curtain-knob" }, [icon("columns")]),
      ]);
      stage.append(img1, img2, line);

      let isDragging = false;
      const updateCurtain = (clientX) => {
        const rect = stage.getBoundingClientRect();
        const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)).toFixed(1);
        stage.style.setProperty("--curtain", pct + "%");
      };

      stage.addEventListener("pointerdown", (ev) => {
        isDragging = true;
        updateCurtain(ev.clientX);
      });
      S.win.addEventListener("pointermove", (ev) => {
        if (isDragging) updateCurtain(ev.clientX);
      });
      S.win.addEventListener("pointerup", () => { isDragging = false; });

      const labels = el("div", { class: "fx-curtain-labels" }, [
        el("span", { text: "◀ " + it1.name + " (" + it1.size_h + ")" }),
        el("span", { text: it2.name + " (" + it2.size_h + ") ▶" }),
      ]);
      const body = el("div", { style: "display:flex;flex-direction:column;gap:8px" }, [labels, stage]);
      openSheet("Comparateur d'images", body, [btn("Fermer", { on: () => closeSheet() })], "is-compare");
    } else {
      toast("Chargement des contenus…");
      try {
        const [d1, d2] = await Promise.all([
          postJson("/api/read", { rel: it1.rel }),
          postJson("/api/read", { rel: it2.rel }),
        ]);
        const pre1 = el("pre", { class: "fx-diff-pre", text: d1.content || "(vide)" });
        const pre2 = el("pre", { class: "fx-diff-pre", text: d2.content || "(vide)" });
        pre1.addEventListener("scroll", () => { pre2.scrollTop = pre1.scrollTop; });
        pre2.addEventListener("scroll", () => { pre1.scrollTop = pre2.scrollTop; });

        const col1 = el("div", { class: "fx-diff-col" }, [el("span", { class: "fx-diff-head", text: it1.name }), pre1]);
        const col2 = el("div", { class: "fx-diff-col" }, [el("span", { class: "fx-diff-head", text: it2.name }), pre2]);
        const body = el("div", { class: "fx-diff-split" }, [col1, col2]);
        openSheet("Comparateur de texte", body, [btn("Fermer", { on: () => closeSheet() })], "is-compare");
      } catch (e) {
        toast((e && e.message) || "Erreur de comparaison", null, null, true);
      }
    }
  }

  function toggleDualMode() {
    S.dualMode = !S.dualMode;
    if (S.dualMode) {
      S.relLeft = S.rel || "";
      if (S.relRight === S.relLeft) S.relRight = S.relLeft === "Inbox" ? "Uni" : "Inbox";
      toast("Mode double-panneau activé (Tab pour basculer)");
    } else {
      toast("Mode volet unique");
    }
    render();
  }

  async function openOmniRecent() {
    toast("Chargement des fichiers récents…");
    try {
      const data = await getJson("/api/files/recent?limit=15");
      const files = data.files || [];
      if (!files.length) {
        toast("Aucun fichier récent");
        return;
      }
      const list = el("div", { class: "fx-recent-list" });
      files.forEach((f) => {
        const item = el("button", {
          type: "button",
          class: "fx-recent-item",
          on: {
            click: () => {
              closeSheet();
              const dir = parentOf(f.rel);
              go(dir).then(() => {
                const target = S.items.find((x) => x.rel === f.rel);
                if (target) quickLook(target);
              });
            },
          },
        }, [
          el("div", { class: "fx-recent-main" }, [
            el("span", { class: "fx-recent-name", text: f.name }),
            el("span", { class: "fx-recent-path", text: f.rel }),
          ]),
          el("div", { class: "fx-recent-meta" }, [
            el("span", { text: fmtBytes(f.size) }),
            el("span", { text: "· " + when(f.mtime, Date.now() / 1000) }),
          ]),
        ]);
        list.appendChild(item);
      });
      openSheet("Fichiers récents transversaux", list, [btn("Fermer", { on: () => closeSheet() })]);
    } catch (e) {
      toast((e && e.message) || "Erreur de chargement", null, null, true);
    }
  }

  function openDirectCapture() {
    const folder = uploadTarget(S.rel);
    const photoInput = el("input", {
      type: "file",
      accept: "image/*",
      capture: "environment",
      style: "display:none",
      on: {
        change: async () => {
          if (photoInput.files && photoInput.files.length) {
            toast("Téléversement de la photo…");
            await upload(photoInput.files, folder);
            closeSheet();
          }
        },
      },
    });
    S.app.appendChild(photoInput);

    const photoBtn = btn("Prendre une photo", {
      cls: "fx-btn is-primary",
      icon: "camera",
      on: () => {
        photoInput.click();
      },
    });

    const voiceBtn = btn("Enregistrer une note vocale", {
      cls: "fx-btn",
      icon: "mic",
      on: () => {
        closeSheet();
        openVoiceRecorder(folder);
      },
    });

    openSheet("Capture directe dans " + folder, el("div", { style: "display:flex;flex-direction:column;gap:14px;padding:12px 0" }, [
      el("p", { class: "fx-hint", text: "Prendre un instantané ou enregistrer un mémorandum audio directement dans ce dossier :" }),
      photoBtn,
      voiceBtn,
    ]), [btn("Fermer", { on: () => closeSheet() })]);
  }

  async function openVoiceRecorder(folder) {
    if (!S.win.navigator.mediaDevices || !S.win.navigator.mediaDevices.getUserMedia) {
      toast("Microphone non disponible sur cet appareil", null, null, true);
      return;
    }
    let stream = null;
    let recorder = null;
    let chunks = [];
    let sec = 0;
    let timer = 0;

    const dot = el("div", { class: "fx-rec-dot is-recording" });
    const timeEl = el("div", { class: "fx-rec-timer", text: "00:00" });
    const statusText = el("p", { class: "fx-hint", text: "Enregistrement en cours…" });

    const stopStream = () => {
      if (timer) { S.win.clearInterval(timer); timer = 0; }
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
    };

    try {
      stream = await S.win.navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/ogg";
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.start(250);
      timer = S.win.setInterval(() => {
        sec += 1;
        const m = String(Math.floor(sec / 60)).padStart(2, "0");
        const s = String(sec % 60).padStart(2, "0");
        timeEl.textContent = m + ":" + s;
      }, 1000);
    } catch (e) {
      toast("Accès micro refusé ou impossible", null, null, true);
      return;
    }

    const saveBtn = btn("Sauvegarder la note", {
      cls: "fx-btn is-primary",
      icon: "check",
      on: () => {
        saveBtn.disabled = true;
        if (recorder && recorder.state !== "inactive") {
          recorder.onstop = async () => {
            stopStream();
            const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
            const d = new Date();
            const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") + "_" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0") + String(d.getSeconds()).padStart(2, "0");
            const ext = blob.type.includes("ogg") ? ".ogg" : ".webm";
            const file = new File([blob], "Note_" + stamp + ext, { type: blob.type });
            toast("Sauvegarde de la note audio…");
            closeSheet();
            await upload([file], folder);
          };
          recorder.stop();
        } else {
          stopStream();
          closeSheet();
        }
      },
    });

    const cancelBtn = btn("Annuler", {
      on: () => {
        stopStream();
        if (recorder && recorder.state !== "inactive") recorder.stop();
        closeSheet();
      },
    });

    const body = el("div", { class: "fx-recorder-wrap" }, [dot, timeEl, statusText]);
    openSheet("Note vocale", body, [cancelBtn, saveBtn]);
  }

  // ---------------------------------------------------------------- selection bar

  function persistPins() {
    try {
      if (S.win && S.win.localStorage) {
        S.win.localStorage.setItem("hq_files_pins_v1", JSON.stringify(Array.from(S.pins)));
      }
    } catch (_) {}
  }

  function persistTags() {
    try {
      if (S.win && S.win.localStorage) {
        const obj = {};
        for (const [k, v] of S.tags.entries()) obj[k] = v;
        S.win.localStorage.setItem("hq_files_tags_v1", JSON.stringify(obj));
      }
    } catch (_) {}
  }

  function togglePin(rel) {
    if (!rel) return;
    if (S.pins.has(rel)) S.pins.delete(rel);
    else S.pins.add(rel);
    persistPins();
    render();
  }

  function renderBar() {
    const bar = S.barEl;
    const n = S.sel.size;
    if (!n || S.rel === TRASH) {
      if (!bar.hidden) {
        const a = anim(bar, [{ translate: "0 0", opacity: 1 }, { translate: "0 120%", opacity: 0 }], { duration: 200, easing: "ease-in" });
        if (a) a.finished.then(() => (bar.hidden = !S.sel.size), () => {});
        else bar.hidden = true;
      }
      return;
    }
    const wasHidden = bar.hidden;
    bar.textContent = "";
    const selRels = [...S.sel];
    bar.append(
      el("span", { class: "fx-selcount" }, [el("strong", { text: String(n) }), n > 1 ? " sélectionnés" : " sélectionné"]),
      btn("Tout", { cls: "fx-btn is-ghost", on: () => {
        for (const r of order()) S.sel.add(r);
        render();
      } }),
      btn("Déplacer", { cls: "fx-btn", icon: "move", aria: "Déplacer", on: () => movePicker(selRels) }),
      btn("ZIP", { cls: "fx-btn", icon: "zip", aria: "Télécharger la sélection en zip", title: "Télécharger la sélection en .zip", on: () => downloadZip(selRels) }),
    );
    if (n > 1) {
      bar.appendChild(btn("Renommer", { cls: "fx-btn", icon: "edit", title: "Renommer le lot", on: () => openBatchRenamer(selRels) }));
    }
    if (n === 2) {
      bar.appendChild(btn("Comparer", { cls: "fx-btn", icon: "columns", title: "Comparer les 2 fichiers", on: () => openComparator(selRels) }));
    }
    if (n === 1) {
      const one = selRels[0];
      if (one.toLowerCase().endsWith(".zip")) {
        bar.appendChild(btn("Extraire", { cls: "fx-btn", icon: "zip", title: "Extraire l'archive", on: () => unzipArchive(one) }));
      }
      bar.appendChild(btn("", { cls: "fx-btn is-ghost", icon: "pin", title: S.pins.has(one) ? "Désépingler" : "Épingler", on: () => togglePin(one) }));
    }
    if (S.dualMode) {
      const oppRel = S.dualActive === "left" ? (S.relRight || "Inbox") : (S.relLeft || "");
      bar.appendChild(btn("Transférer ➔ " + (oppRel || "Racine"), {
        cls: "fx-btn is-primary",
        icon: "move",
        title: "Transférer la sélection vers l'autre volet",
        on: async () => {
          await moveTo(selRels, oppRel);
          await load(S.rel);
        },
      }));
    }
    bar.append(
      btn("Corbeille", { cls: "fx-btn is-danger", icon: "trash", on: () => trash(selRels) }),
      btn("", { cls: "fx-btn is-ghost", icon: "close", aria: "Annuler la sélection", on: () => {
        S.sel.clear();
        S.selecting = false;
        render();
      } }),
    );
    bar.hidden = false;
    if (wasHidden) anim(bar, [{ translate: "0 120%", opacity: 0 }, { translate: "0 0", opacity: 1 }], { duration: 340, easing: SPRING });
  }

  // ---------------------------------------------------------------- actions

  const MOVE_RECENTS_KEY = "hq_files_move_recents";
  const MOVE_RECENTS_LIMIT = 5;

  function recentMoveFolders() {
    try {
      const paths = JSON.parse(S.win.localStorage.getItem(MOVE_RECENTS_KEY));
      return Array.isArray(paths) ? paths.filter(path => typeof path === "string").slice(0, MOVE_RECENTS_LIMIT) : [];
    } catch (_) {
      return [];
    }
  }

  function rememberMoveFolder(dest) {
    if (!dest) return;
    const recent = [dest, ...recentMoveFolders().filter(path => path !== dest)].slice(0, MOVE_RECENTS_LIMIT);
    try { S.win.localStorage.setItem(MOVE_RECENTS_KEY, JSON.stringify(recent)); } catch (_) {}
  }

  async function moveTo(rels, dest, folderEl) {
    if (!rels.length) return;
    const moved = [];
    const errors = [];
    const flight = folderEl ? flyInto(rels, folderEl) : Promise.resolve();
    for (const rel of rels) {
      try {
        const out = await postJson("/api/move", { rel, dest });
        moved.push({ from: rel, to: out.rel });
      } catch (e) {
        errors.push((e && e.message) || "Échec");
      }
    }
    await flight;
    S.sel.clear();
    if (moved.length) {
      rememberMoveFolder(dest);
      toast((moved.length > 1 ? moved.length + " éléments déplacés" : "Déplacé") + " dans « " + (dest.split("/").pop() || dest) + " »", "Annuler", async () => {
        for (const m of moved) {
          try {
            await postJson("/api/move", { rel: m.to, dest: parentOf(m.from) });
          } catch (_) {}
        }
        for (const m of moved) S.landed.add(m.from);
        await load(S.rel);
      });
    }
    if (errors.length) toast(errors[0], null, null, true);
    await load(S.rel);
    if (S.bk && moved.length) loadBackups(true); // automatic backups follow moved folders
  }

  async function trash(rels) {
    if (!rels.length) return;
    const fly = flyToTrash(rels);
    let out;
    try {
      out = await postJson("/api/files", { action: "trash", rels });
    } catch (e) {
      await fly;
      toast((e && e.message) || "Suppression impossible", null, null, true);
      await load(S.rel);
      return;
    }
    await fly;
    buzz(10);
    S.sel.clear();
    S.selecting = false;
    S.trash = null;
    const ids = (out.trashed || []).map((t) => t.id);
    toast((ids.length > 1 ? ids.length + " éléments mis" : "Mis") + " à la corbeille", "Annuler", () => restore(ids, true));
    if (out.failed && out.failed.length) S.win.setTimeout(() => toast(out.failed[0].error, null, null, true), 1500);
    await load(S.rel);
  }

  async function restore(ids, stay) {
    try {
      const out = await postJson("/api/files", { action: "restore", ids });
      for (const r of out.restored || []) S.landed.add(r.rel);
      S.trash = null;
      toast((out.restored || []).length > 1 ? out.restored.length + " éléments restaurés" : "Restauré");
    } catch (e) {
      toast((e && e.message) || "Restauration impossible", null, null, true);
    }
    await load(stay ? S.rel : S.rel);
  }

  async function rename(it, name, tile) {
    const n = String(name || "").trim();
    if (!n || n === it.name) return it.rel;
    if (!validName(n)) {
      toast("Nom invalide (pas de / \\ : * ? \" < > |)", null, null, true);
      return null;
    }
    try {
      const out = await postJson("/api/rename", { rel: it.rel, name: n });
      if (S.bk && it.type === "dir") loadBackups(true); // automatic backups follow renamed folders
      S.landed.add(out.rel);
      if (tile) anim(tile.querySelector(".fx-name"), [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: EASE });
      await load(S.rel);
      return out.rel;
    } catch (e) {
      toast((e && e.message) || "Renommage impossible", null, null, true);
      return null;
    }
  }

  /** F2 / « Renommer » on a card: the name becomes editable in place. */
  function inlineRename(it) {
    const tile = S.listEl.querySelector('[data-rel="' + cssEsc(it.rel) + '"]');
    const label = tile && tile.querySelector(".fx-name");
    if (!label) return;
    const input = el("input", { class: "fx-rename", type: "text", value: it.name, "aria-label": "Nouveau nom", maxlength: "200", autocomplete: "off" });
    label.replaceWith(input);
    input.focus();
    const dot = it.type === "dir" ? -1 : it.name.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : it.name.length);
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save) await rename(it, input.value, tile);
      else render();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      else if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (ev) => ev.stopPropagation());
  }

  /** « Dossier »: a new folder card appears with its name ready to type. */
  function newFolder() {
    if (!S.rel || S.rel === TRASH) return;
    const tile = el("div", { class: "fx-item fx-folder is-new", "data-rel": "" });
    hueStyle(tile, S.rel);
    const input = el("input", { class: "fx-rename", type: "text", value: "Nouveau dossier", "aria-label": "Nom du dossier", maxlength: "200", autocomplete: "off" });
    tile.append(el("span", { class: "fx-folder-art", "aria-hidden": "true" }, [el("span", { class: "fx-folder-back" }), el("span", { class: "fx-folder-papers" }), el("span", { class: "fx-folder-front" })]), el("span", { class: "fx-text" }, [input]));
    S.listEl.prepend(tile);
    const em = S.listEl.querySelector(".fx-empty");
    if (em) em.remove();
    anim(tile, [{ opacity: 0, transform: "scale(.6) rotate(-6deg)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: SPRING });
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (!save || !name) {
        render();
        return;
      }
      if (!validName(name)) {
        toast("Nom invalide (pas de / \\ : * ? \" < > |)", null, null, true);
        render();
        return;
      }
      try {
        await postJson("/api/mkdir", { path: S.rel, name });
        S.landed.add(joinRel(S.rel, name));
        await load(S.rel);
      } catch (e) {
        toast((e && e.message) || "Création impossible", null, null, true);
        render();
      }
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      else if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  // ---------------------------------------------------------------- upload (chunked, one ring per file)

  function pickUpload() {
    const inp = el("input", { type: "file", multiple: true, hidden: true });
    inp.addEventListener("change", () => {
      const files = Array.prototype.slice.call(inp.files || []);
      inp.remove();
      if (files.length) upload(files, uploadTarget(S.rel));
    });
    S.doc.body.appendChild(inp);
    inp.click();
  }

  function trayItem(file) {
    const ring = S.doc.createElementNS(SVG_NS, "svg");
    ring.setAttribute("viewBox", "0 0 36 36");
    ring.setAttribute("class", "fx-ring");
    const bg = S.doc.createElementNS(SVG_NS, "circle");
    bg.setAttribute("cx", "18");
    bg.setAttribute("cy", "18");
    bg.setAttribute("r", "15");
    bg.setAttribute("class", "fx-ring-bg");
    const fg = S.doc.createElementNS(SVG_NS, "circle");
    fg.setAttribute("cx", "18");
    fg.setAttribute("cy", "18");
    fg.setAttribute("r", "15");
    fg.setAttribute("class", "fx-ring-fg");
    fg.setAttribute("pathLength", "100");
    fg.style.strokeDasharray = "0 100";
    ring.append(bg, fg);
    const kd = kindOf(file.name);
    const row = el("div", { class: "fx-up is-" + kd.family }, [
      el("span", { class: "fx-up-ring" }, [ring, el("span", { class: "fx-up-pct", text: "0" })]),
      el("span", { class: "fx-up-text" }, [el("span", { class: "fx-up-name", text: file.name }), el("span", { class: "fx-up-meta", text: fmtBytes(file.size) })]),
    ]);
    row.__fg = fg;
    return row;
  }

  async function uploadOne(file, folder, row) {
    const init = await postJson("/api/upload/init", { name: file.name, size: file.size, folder });
    const chunk = init.chunk || 2 * 1024 * 1024;
    let off = 0;
    let index = 0;
    const t0 = S.win.performance.now();
    while (off < file.size) {
      const blob = file.slice(off, off + chunk);
      const res = await S.win.fetch("/api/upload/chunk", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream", "X-Upload-Id": init.id, "X-Chunk-Index": String(index) }, body: await blob.arrayBuffer() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Envoi interrompu");
      off += blob.size;
      index += 1;
      const pct = Math.round((off / file.size) * 100);
      row.__fg.style.strokeDasharray = pct + " 100";
      row.querySelector(".fx-up-pct").textContent = String(pct);
      const sec = (S.win.performance.now() - t0) / 1000;
      if (sec > 0.5) row.querySelector(".fx-up-meta").textContent = fmtBytes(file.size) + " · " + fmtBytes(off / sec) + "/s";
    }
    return postJson("/api/upload/complete", { id: init.id });
  }

  async function upload(fileList, folder, targetEl) {
    const files = Array.prototype.slice.call(fileList || []).filter((f) => f && f.size > 0);
    if (!files.length) {
      toast("Rien à envoyer (dossiers et fichiers vides ignorés)", null, null, true);
      return;
    }
    S.trayEl.hidden = false;
    if (targetEl) anim(targetEl, [{ transform: "none" }, { transform: "scale(1.06)", offset: 0.4 }, { transform: "none" }], { duration: 380, easing: SPRING });
    const rows = files.map((f) => {
      const r = trayItem(f);
      S.trayEl.appendChild(r);
      anim(r, [{ opacity: 0, transform: "translate3d(0,16px,0)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: SPRING });
      return r;
    });
    let ok = 0;
    for (let k = 0; k < files.length; k += 1) {
      const row = rows[k];
      row.classList.add("is-active");
      try {
        const out = await uploadOne(files[k], folder, row);
        ok += 1;
        row.classList.add("is-done");
        row.classList.remove("is-active");
        const rel = out && (out.rel || (out.files && out.files[0]));
        if (rel) S.landed.add(rel);
        else S.landed.add(joinRel(folder, files[k].name));
      } catch (e) {
        row.classList.add("is-failed");
        row.querySelector(".fx-up-meta").textContent = (e && e.message) || "Échec";
      }
    }
    if (ok) {
      buzz(10);
      toast(ok > 1 ? ok + " fichiers envoyés dans « " + folder.split("/").pop() + " »" : "Envoyé dans « " + folder.split("/").pop() + " »");
      if (typeof S.win.hqPolishBurst === "function") S.win.hqPolishBurst(S.trayEl);
      if (S.rel === folder || S.rel === "" ) await load(S.rel === "" ? folder : S.rel);
      else if (within(folder, S.rel)) await load(S.rel);
    }
    S.win.setTimeout(() => {
      for (const r of rows) {
        if (r.classList.contains("is-failed")) continue;
        const a = anim(r, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translate3d(40px,0,0)" }], { duration: 260, easing: "ease-in", fill: "forwards" });
        if (a) a.finished.then(() => r.remove(), () => r.remove());
        else r.remove();
      }
      S.win.setTimeout(() => {
        if (!S.trayEl.querySelector(".fx-up:not(.is-done)")) {
          S.trayEl.textContent = "";
          S.trayEl.hidden = true;
        }
      }, 400);
    }, 1400);
  }

  function showDrop(rel) {
    const d = S.dropEl;
    d.querySelector(".fx-drop-title").textContent = "Envoyer dans « " + (rel ? rel.split("/").pop() : "Inbox") + " »";
    if (d.hidden) {
      d.hidden = false;
      anim(d, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    }
  }

  function hideDrop() {
    S.dropEl.hidden = true;
  }

  function bindDrop() {
    let depth = 0;
    const hasFiles = (ev) => ev.dataTransfer && Array.prototype.includes.call(ev.dataTransfer.types || [], "Files");
    S.app.addEventListener("dragenter", (ev) => {
      if (!hasFiles(ev) || S.rel === TRASH) return;
      depth += 1;
      showDrop(uploadTarget(S.rel));
    });
    S.app.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) hideDrop();
    });
    S.app.addEventListener("dragover", (ev) => {
      if (!hasFiles(ev) || S.rel === TRASH) return;
      ev.preventDefault();
      if (!ev.target.closest || !ev.target.closest(".fx-folder,.fx-tab")) showDrop(uploadTarget(S.rel));
    });
    S.doc.addEventListener("dragover", (ev) => {
      if (!S.drag && !hasFiles(ev)) return;
      const y = ev.clientY;
      const h = S.win.innerHeight;
      if (y < 70) S.win.scrollBy(0, -14);
      else if (y > h - 70) S.win.scrollBy(0, 14);
    });
    S.app.addEventListener("drop", (ev) => {
      depth = 0;
      hideDrop();
      if (!hasFiles(ev) || S.rel === TRASH) return;
      ev.preventDefault();
      upload(ev.dataTransfer.files, uploadTarget(S.rel));
    });
  }

  // ---------------------------------------------------------------- sheets: quick look, move picker

  function openSheet(title, body, foot, cls) {
    closeSheet(true);
    const back = el("div", { class: "fx-sheet-back" });
    const box = el("div", { class: "fx-sheet" + (cls ? " " + cls : ""), role: "dialog", "aria-modal": "true", "aria-label": title });
    box.append(el("div", { class: "fx-sheet-head" }, [el("h3", { text: title }), btn("", { cls: "fx-x", icon: "close", aria: "Fermer", on: () => closeSheet() })]), el("div", { class: "fx-sheet-body" }, [body]));
    if (foot) box.appendChild(el("div", { class: "fx-sheet-foot" }, foot));
    back.appendChild(box);
    back.addEventListener("mousedown", (ev) => {
      if (ev.target === back) closeSheet();
    });
    S.sheet = { back, box, ret: S.doc.activeElement };
    S.doc.body.appendChild(back);
    S.win.requestAnimationFrame(() => {
      // the quick look keeps the keyboard for ←/→ (and no phone keyboard pops up over the picture)
      const f = (cls !== "is-ql" && box.querySelector("input,select,textarea")) || box.querySelector(".fx-sheet-head .fx-x");
      try {
        f.focus({ preventScroll: true });
      } catch (_) {}
    });
    return box;
  }

  function closeSheet(instant) {
    const s = S.sheet;
    if (!s) return;
    S.sheet = null;
    S.ql = null;
    S.bkView = null;
    S.qlStep = null;
    const done = () => s.back.remove();
    for (const m of s.box.querySelectorAll("video,audio")) {
      try {
        m.pause();
      } catch (_) {}
    }
    if (instant || calm() || typeof s.box.animate !== "function") done();
    else {
      s.back.classList.add("is-out");
      s.box.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translate3d(0,16px,0) scale(.98)" }], { duration: 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.then(done, done);
    }
    if (s.ret && s.ret.isConnected) {
      try {
        s.ret.focus({ preventScroll: true });
      } catch (_) {}
    }
  }

  function quickLook(it, tile) {
    const files = shown().filter((x) => x.type !== "dir");
    const idx = files.findIndex((x) => x.rel === it.rel);
    const kd = kindOf(it.name);
    const stage = el("div", { class: "fx-ql-stage is-" + kd.family });
    stage.style.setProperty("--kh", String(kd.hue));
    if (kd.family === "image" && kd.ext !== "heic" && kd.ext !== "heif") {
      stage.appendChild(el("img", { class: "fx-ql-img", src: fileUrl(it.rel), alt: it.name, decoding: "async" }));
    } else if (kd.family === "pdf") {
      stage.appendChild(el("iframe", { class: "fx-ql-pdf", src: fileUrl(it.rel), title: "Aperçu de " + it.name }));
    } else if (kd.family === "video" && PLAYABLE.test(it.name)) {
      stage.appendChild(el("video", { class: "fx-ql-video", src: mediaUrl(it.rel), controls: true, playsinline: true, preload: "metadata" }));
    } else if (kd.family === "audio" && PLAYABLE.test(it.name)) {
      stage.append(svgPath(FAMILY_ICON.audio, "fx-ql-big"), el("audio", { class: "fx-ql-audio", src: mediaUrl(it.rel), controls: true, preload: "metadata" }));
    } else if (EDITABLE.test(it.name)) {
      const pre = el("pre", { class: "fx-ql-text", text: "Chargement…" });
      stage.appendChild(pre);
      postJson("/api/read", { rel: it.rel }).then((d) => {
        pre.textContent = String(d.content || "").slice(0, 40000) || "(fichier vide)";
      }, (e) => {
        pre.textContent = (e && e.message) || "Lecture impossible";
      });
    } else {
      stage.append(svgPath(FAMILY_ICON[kd.family] || FAMILY_ICON.file, "fx-ql-big"), el("span", { class: "fx-ql-stamp", text: (kd.ext || "?").toUpperCase() }), el("p", { class: "fx-hint", text: kd.label + " · pas d'aperçu dans le navigateur" }));
    }
    const nameIn = el("input", { class: "fx-ql-name", type: "text", value: it.name, "aria-label": "Nom du fichier", maxlength: "200", autocomplete: "off" });
    nameIn.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") nameIn.blur();
      if (ev.key === "Escape") {
        nameIn.value = it.name;
        nameIn.blur();
      }
    });
    nameIn.addEventListener("change", async () => {
      const rel = await rename(it, nameIn.value);
      if (rel && rel !== it.rel) {
        const fresh = S.items.find((x) => x.rel === rel);
        if (fresh && S.sheet && S.qlStep) quickLook(fresh); // still looking (not closed meanwhile)
      } else nameIn.value = it.name;
    });
    const meta = el("p", { class: "fx-ql-meta", text: kd.label + " · " + it.size_h + " · modifié " + when(it.mtime, Date.now() / 1000) + " · " + (parentOf(it.rel) || "") });

    const hashVal = el("code", { class: "fx-ql-hash-val", text: "Calcul…" });
    const hashWrap = el("div", { class: "fx-ql-hash" }, [
      el("span", { class: "fx-ql-hash-label", text: "SHA-256 :" }),
      hashVal,
      btn("", {
        cls: "fx-btn fx-btn-copy",
        icon: "copy",
        title: "Copier le hash SHA-256",
        aria: "Copier le hash SHA-256",
        on: (ev) => {
          ev.stopPropagation();
          const full = hashVal.getAttribute("data-hash");
          if (full && S.win && S.win.navigator && S.win.navigator.clipboard) {
            S.win.navigator.clipboard.writeText(full);
            toast("Empreinte SHA-256 copiée");
          }
        },
      }),
    ]);
    getJson("/api/files/hash?rel=" + encodeURIComponent(it.rel)).then((res) => {
      if (res && res.sha256) {
        hashVal.textContent = res.sha256.slice(0, 16) + "…" + res.sha256.slice(-8);
        hashVal.setAttribute("data-hash", res.sha256);
        hashVal.setAttribute("title", res.sha256);
      }
    }, () => {
      hashVal.textContent = "Indisponible";
    });

    const TAG_COLORS = ["rose", "amber", "emerald", "cyan", "violet"];
    const tagDots = TAG_COLORS.map((c) => {
      const active = S.tags.get(it.rel) === c;
      return el("button", {
        type: "button",
        class: "fx-tag-dot is-" + c + (active ? " is-active" : ""),
        title: "Étiquette " + c,
        "aria-label": "Étiquette " + c,
        on: {
          click: (ev) => {
            ev.stopPropagation();
            if (S.tags.get(it.rel) === c) S.tags.delete(it.rel);
            else S.tags.set(it.rel, c);
            persistTags();
            render();
            quickLook(it, tile);
          },
        },
      });
    });
    const tagWrap = el("div", { class: "fx-tag-picker" }, [
      el("span", { class: "fx-hint", text: "Étiquette :" }),
      ...tagDots,
    ]);

    const nav = el("div", { class: "fx-ql-nav" }, [
      btn("", { cls: "fx-btn is-round", icon: "left", aria: "Fichier précédent", on: () => idx > 0 && quickLook(files[idx - 1]) }),
      el("span", { class: "fx-ql-pos", text: idx + 1 + " / " + files.length }),
      btn("", { cls: "fx-btn is-round", icon: "right", aria: "Fichier suivant", on: () => idx < files.length - 1 && quickLook(files[idx + 1]) }),
    ]);
    nav.children[0].disabled = idx <= 0;
    nav.children[2].disabled = idx >= files.length - 1;
    const body = el("div", { class: "fx-ql" }, [stage, el("div", { class: "fx-ql-info" }, [nameIn, meta, hashWrap, tagWrap, nav])]);
    const acts = [
      el("a", { class: "fx-btn", href: fileUrl(it.rel), target: "_blank", rel: "noopener" }, [icon("open"), el("span", { text: "Ouvrir" })]),
      el("a", { class: "fx-btn", href: dlUrl(it.rel), download: "" }, [icon("download"), el("span", { text: "Télécharger" })]),
    ];
    const isPinned = S.pins.has(it.rel);
    acts.push(btn(isPinned ? "Désépingler" : "Épingler", {
      icon: "pin",
      on: () => {
        if (S.pins.has(it.rel)) S.pins.delete(it.rel);
        else S.pins.add(it.rel);
        persistPins();
        render();
        quickLook(it, tile);
      },
    }));
    if (/\.zip$/i.test(it.name)) acts.push(btn("Extraire", {
      icon: "zip",
      on: async () => {
        closeSheet(true);
        await unzipArchive(it.rel);
      },
    }));
    if (kd.family === "image") acts.push(btn("Studio Forge", {
      icon: "sparkles",
      on: () => {
        closeSheet(true);
        if (typeof S.win.hqForgeLoadSource === "function") {
          S.win.hqForgeLoadSource(fileUrl(it.rel));
        }
        if (typeof S.win.setView === "function") S.win.setView("forge");
        toast("Envoyé au Studio Forge");
      },
    }));
    if (FOR_LECTEUR.test(it.name) && typeof S.win.hqPlayerOpen === "function") acts.push(btn("Lecteur", { icon: "play", on: () => {
      closeSheet(true);
      flyToLecteur(tile || stage);
      S.win.hqPlayerOpen(it.rel, true);
    } }));
    if (EDITABLE.test(it.name)) acts.push(btn("Éditer", { icon: "edit", on: () => editText(it) }));
    if (/\.(stl|3mf|gcode|glb|obj)$/i.test(it.name)) acts.push(btn("Atelier 3D", { icon: "cube", on: () => {
      closeSheet(true);
      if (typeof S.win.setView === "function") S.win.setView("atelier3d");
      toast("Ouvert dans l'Atelier 3D");
    } }));
    if (/\.(md|txt)$/i.test(it.name)) acts.push(btn("Carnet", { icon: "book", on: async () => {
      try {
        if (typeof S.win.hqCarnetLoad === "function") await S.win.hqCarnetLoad();
        if (typeof S.win.setView === "function") S.win.setView("carnet");
        toast("Ouvert dans Carnet");
      } catch (e) {
        toast((e && e.message) || "Erreur Carnet", null, null, true);
      }
    } }));
    if (it.rel.startsWith("Print/")) acts.push(btn("Imprimer", { icon: "print", on: async () => {
      try {
        if (typeof S.win.hqPolishPrintSend === "function") S.win.hqPolishPrintSend(it.name);
        await postJson("/api/print", { rel: it.rel });
        toast("Envoyé à l'imprimante");
        if (typeof S.win.hqPolishBurst === "function") S.win.hqPolishBurst(tile || stage);
      } catch (e) {
        toast((e && e.message) || "Impression impossible", null, null, true);
      }
    } }));
    acts.push(btn("Déplacer", { icon: "move", on: () => movePicker([it.rel]) }));
    acts.push(btn("Corbeille", { cls: "fx-btn is-danger", icon: "trash", on: () => {
      closeSheet();
      trash([it.rel]);
    } }));
    const wasOpen = !!S.ql;
    const box = openSheet(it.name, body, acts, "is-ql");
    S.ql = { rel: it.rel, files, idx };
    // the picture grows out of its card
    const from = tile && tile.querySelector(".fx-face");
    const img = stage.firstChild;
    if (from && img && !wasOpen && !calm()) {
      const a = from.getBoundingClientRect();
      S.win.requestAnimationFrame(() => {
        const b = img.getBoundingClientRect();
        if (b.width && a.width) anim(img, [{ transformOrigin: "0 0", transform: "translate(" + (a.left - b.left) + "px," + (a.top - b.top) + "px) scale(" + a.width / b.width + "," + a.height / b.height + ")", borderRadius: "14px" }, { transformOrigin: "0 0", transform: "none", borderRadius: "12px" }], { duration: 420, easing: EASE });
      });
    } else if (wasOpen) anim(stage, [{ opacity: 0, transform: "translate3d(" + (idx > (S.qlLast || 0) ? 30 : -30) + "px,0,0)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: EASE });
    S.qlLast = idx;
    S.qlStep = (d) => {
      const k = idx + d;
      if (k >= 0 && k < files.length) quickLook(files[k]);
    };
    // touch: swipe between files
    let sx = null;
    stage.addEventListener("touchstart", (ev) => {
      sx = ev.touches.length === 1 ? ev.touches[0].clientX : null;
    }, { passive: true });
    stage.addEventListener("touchend", (ev) => {
      if (sx === null) return;
      const dx = ev.changedTouches[0].clientX - sx;
      sx = null;
      if (Math.abs(dx) > 60) {
        if (dx < 0 && idx < files.length - 1) quickLook(files[idx + 1]);
        else if (dx > 0 && idx > 0) quickLook(files[idx - 1]);
      }
    }, { passive: true });
  }

  async function editText(it) {
    let d;
    try {
      d = await postJson("/api/read", { rel: it.rel });
    } catch (e) {
      toast((e && e.message) || "Lecture impossible", null, null, true);
      return;
    }
    const counter = el("span", { class: "fx-hint fx-editor-counter" });
    const ta = el("textarea", { class: "fx-editor", spellcheck: "false", "aria-label": "Contenu de " + it.name });
    ta.value = d.content || "";
    const updateStats = () => {
      const val = ta.value;
      const lines = val ? val.split("\n").length : 0;
      const chars = val.length;
      counter.textContent = lines + " ligne" + (lines > 1 ? "s" : "") + " · " + chars + " car.";
    };
    updateStats();
    ta.addEventListener("input", updateStats);
    const save = btn("Enregistrer", { cls: "fx-btn is-primary", icon: "check", on: async () => {
      save.disabled = true;
      try {
        await postJson("/api/write", { rel: it.rel, content: ta.value });
        toast("Enregistré");
        closeSheet();
        S.landed.add(it.rel);
        await load(S.rel);
      } catch (e) {
        toast((e && e.message) || "Enregistrement impossible", null, null, true);
      } finally {
        save.disabled = false;
      }
    } });
    openSheet("Éditer " + it.name, el("div", { class: "fx-editor-wrap" }, [counter, ta]), [btn("Annuler", { on: () => closeSheet() }), save], "is-editor");
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Tab") {
        ev.preventDefault();
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        ta.value = ta.value.substring(0, start) + "  " + ta.value.substring(end);
        ta.selectionStart = ta.selectionEnd = start + 2;
        updateStats();
      } else if (ev.key === "s" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        save.click();
      }
    });
  }

  /** Choose a destination by browsing folders (no typing paths). */
  function movePicker(rels) {
    let at = parentOf(rels[0]) || "";
    let paintTicket = 0;
    const shortcuts = el("div", { class: "fx-pick-shortcuts", hidden: true });
    const list = el("div", { class: "fx-pick" });
    const crumbs = el("div", { class: "fx-pick-crumbs" });
    const here = btn("Déplacer ici", { cls: "fx-btn is-primary", icon: "move" });
    const openFolder = path => {
      at = path;
      paint();
    };
    function allowed(path) {
      return typeof path === "string" && !!path && !path.includes("\\")
        && path.split("/").every(part => part && part !== "." && part !== "..")
        && !rels.some(rel => within(path, rel));
    }
    function showShortcuts(favorites) {
      const used = new Set();
      const groups = [];
      for (const [title, paths] of [["Favoris", favorites], ["Destinations récentes", recentMoveFolders()]]) {
        const rows = [];
        for (const path of paths) {
          if (!allowed(path) || used.has(path) || rels.every(rel => parentOf(rel) === path)) continue;
          used.add(path);
          const parts = path.split("/");
          const row = btn(parts.pop(), { cls: "fx-btn fx-pick-shortcut", icon: "move", on: () => openFolder(path) });
          if (parts.length) {
            row.appendChild(el("small", { text: parts.join(" › ") }));
          }
          rows.push(row);
        }
        if (rows.length) groups.push(el("section", { class: "fx-pick-group", "aria-label": title }, [
          el("h4", { text: title }), el("div", { class: "fx-pick-group-rows" }, rows),
        ]));
      }
      shortcuts.replaceChildren(...groups);
      shortcuts.hidden = !groups.length;
    }
    const paint = async () => {
      const ticket = ++paintTicket;
      const path = at;
      list.replaceChildren(el("p", { class: "fx-hint", text: "Chargement…" }));
      crumbs.textContent = "";
      here.disabled = true;
      mk.disabled = true;
      const caption = here.querySelector("span");
      caption.textContent = "Déplacer ici";
      const parts = path.split("/").filter(Boolean);
      const top = btn("Fichiers", { cls: "fx-pick-crumb", on: () => openFolder("") });
      crumbs.appendChild(top);
      parts.forEach((p, k) => {
        crumbs.appendChild(icon("right", "fx-sep"));
        const rel = parts.slice(0, k + 1).join("/");
        crumbs.appendChild(btn(p, { cls: "fx-pick-crumb", on: () => openFolder(rel) }));
      });
      let data;
      try {
        data = await call("/api/list" + (path ? "?path=" + encodeURIComponent(path) : ""));
        if (data.error) throw new Error(data.error);
      } catch (e) {
        if (ticket !== paintTicket || !list.isConnected) return;
        list.replaceChildren(el("p", { class: "fx-hint", text: (e && e.message) || "Dossier indisponible" }));
        return;
      }
      if (ticket !== paintTicket || !list.isConnected) return;
      list.textContent = "";
      const dirs = (data.items || []).filter((i) => i.type === "dir" && !rels.some((r) => within(i.rel, r)));
      if (!dirs.length) list.appendChild(el("p", { class: "fx-hint", text: at ? "Pas de sous-dossier ici." : "" }));
      for (const d of sortItems(dirs, "name")) {
        const b = el("button", { type: "button", class: "fx-pick-row" }, [el("span", { class: "fx-pick-folder", "aria-hidden": "true" }), el("span", { text: d.name }), icon("right", "fx-sep")]);
        b.style.setProperty("--hue", String(rootHue(d.rel)));
        b.addEventListener("click", () => openFolder(d.rel));
        list.appendChild(b);
      }
      const same = rels.every((r) => parentOf(r) === path);
      mk.disabled = !allowed(path);
      here.disabled = mk.disabled || same;
      caption.textContent = !path ? "Choisis un dossier" : same ? "Déjà ici" : "Déplacer dans « " + path.split("/").pop() + " »";
    };
    here.addEventListener("click", async () => {
      if (here.disabled) return;
      here.disabled = true;
      closeSheet();
      await moveTo(rels, at);
    });
    const mk = btn("Nouveau dossier ici", { cls: "fx-btn is-ghost", icon: "folderPlus", on: async () => {
      if (!at) return;
      const path = at;
      const name = S.win.prompt("Nom du dossier :", "Nouveau dossier");
      if (!name || !validName(name)) return;
      try {
        await postJson("/api/mkdir", { path, name });
        if (at === path && list.isConnected) openFolder(joinRel(path, name.trim()));
      } catch (e) {
        toast((e && e.message) || "Création impossible", null, null, true);
      }
    } });
    const favorites = S.win.hqFavoriteFolders?.() || [];
    showShortcuts(favorites);
    openSheet(rels.length > 1 ? "Déplacer " + rels.length + " éléments" : "Déplacer « " + rels[0].split("/").pop() + " »",
      el("div", { class: "fx-pick-scroll" }, [shortcuts, crumbs, list]), [mk, here], "is-pick");
    call("/api/favorites").then(data => {
      if (shortcuts.isConnected && Array.isArray(data.favorites) && JSON.stringify(data.favorites) !== JSON.stringify(favorites)) {
        showShortcuts(data.favorites);
      }
    }).catch(() => {});
    paint();
  }

  // ---------------------------------------------------------------- corbeille view

  function renderTrash(L) {
    const t = S.trash || { items: [], size: 0, keep_days: 30 };
    const head = el("div", { class: "fx-trash-head" }, [
      el("p", { text: t.items.length ? t.items.length + (t.items.length > 1 ? " éléments" : " élément") + " · " + fmtBytes(t.size) + " · vidés automatiquement après " + t.keep_days + " jours" : "La corbeille est vide." }),
      t.items.length ? btn("Vider la corbeille", { cls: "fx-btn is-danger", icon: "trash", on: () => emptyTrash() }) : null,
    ]);
    L.appendChild(head);
    t.items.forEach((x, k) => {
      const kd = x.type === "dir" ? { family: "folder", hue: rootHue(x.orig) } : kindOf(x.name);
      const row = el("div", { class: "fx-item fx-trashed", "data-flip": "t:" + x.id });
      row.style.setProperty("--kh", String(kd.hue));
      row.style.setProperty("--k", String(Math.min(k, 16)));
      row.append(
        el("span", { class: "fx-trashed-ico", "aria-hidden": "true" }, [x.type === "dir" ? el("span", { class: "fx-pick-folder" }) : svgPath(FAMILY_ICON[kd.family] || FAMILY_ICON.file, "fx-face-ico")]),
        el("span", { class: "fx-text" }, [el("span", { class: "fx-name", text: x.name }), el("span", { class: "fx-meta", text: "de " + (parentOf(x.orig) || "?") + " · " + fmtBytes(x.size) + " · " + when(x.at, Date.now() / 1000) })]),
        btn("Restaurer", { cls: "fx-btn", icon: "restore", on: () => restore([x.id]) }),
        btn("", { cls: "fx-btn is-ghost is-danger", icon: "close", aria: "Supprimer définitivement " + x.name, title: "Supprimer définitivement", on: async () => {
          if (!S.win.confirm("Supprimer définitivement « " + x.name + " » ?")) return;
          try {
            await postJson("/api/files", { action: "purge", id: x.id });
          } catch (e) {
            toast((e && e.message) || "Impossible", null, null, true);
          }
          await load(TRASH);
        } }),
      );
      L.appendChild(row);
    });
  }

  async function emptyTrash() {
    if (!S.win.confirm("Vider la corbeille ? Les éléments seront supprimés définitivement.")) return;
    try {
      await postJson("/api/files", { action: "empty" });
      toast("Corbeille vidée");
    } catch (e) {
      toast((e && e.message) || "Impossible", null, null, true);
    }
    await load(TRASH);
  }

  // ---------------------------------------------------------------- keyboard (PC)

  function bindKeys() {
    S.app.addEventListener("keydown", (ev) => {
      if (S.sheet || (ev.target.closest && ev.target.closest("input,textarea,select"))) return;
      if (ev.key === "/" && S.searchEl) {
        ev.preventDefault();
        S.searchEl.focus();
        S.searchEl.select();
        return;
      }
      if (ev.key === "Tab" && S.dualMode) {
        ev.preventDefault();
        S.dualActive = S.dualActive === "left" ? "right" : "left";
        toast("Volet actif : " + (S.dualActive === "left" ? "Gauche" : "Droite"));
        render();
        return;
      }
      if (ev.altKey && ev.key === "ArrowLeft") {
        ev.preventDefault();
        goBack();
        return;
      }
      if (ev.altKey && ev.key === "ArrowRight") {
        ev.preventDefault();
        goForward();
        return;
      }
      if (ev.altKey && ev.key >= "1" && ev.key <= "9") {
        const k = Number(ev.key) - 1;
        if (k < S.crumbs.length) {
          ev.preventDefault();
          go(S.crumbs[k].rel);
          return;
        }
      }
      const items = Array.prototype.slice.call(S.listEl.querySelectorAll(".fx-item[data-rel]"));
      const cur = ev.target.closest && ev.target.closest(".fx-item[data-rel]");
      const i = cur ? items.indexOf(cur) : -1;
      const it = cur && S.items.find((x) => x.rel === cur.getAttribute("data-rel"));
      const focusAt = (k) => {
        const n = items[Math.max(0, Math.min(items.length - 1, k))];
        if (n) {
          mechSound("switch");
          buzz(5);
          for (const x of items) {
            x.tabIndex = -1;
            x.classList.remove("is-keyboard-focus");
          }
          n.tabIndex = 0;
          n.classList.add("is-keyboard-focus");
          n.focus();
          S.focusRel = n.getAttribute("data-rel");
          n.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      };
      const cols = () => {
        if (S.view === "list" || items.length < 2) return 1;
        const top = items[0].offsetTop;
        let c = 0;
        while (c < items.length && items[c].offsetTop === top) c += 1;
        return Math.max(1, c);
      };
      if (ev.key === "ArrowRight" || ev.key === "l") focusAt(i + 1);
      else if (ev.key === "ArrowLeft" || ev.key === "h") focusAt(i - 1);
      else if (ev.key === "ArrowDown" || ev.key === "j") focusAt(i < 0 ? 0 : i + cols());
      else if (ev.key === "ArrowUp" || ev.key === "k") focusAt(i - cols());
      else if (ev.key === "Home") focusAt(0);
      else if (ev.key === "End") focusAt(items.length - 1);
      else if (ev.key === "Enter" && cur) cur.click();
      else if (ev.key === "x" && cur) toggleSel(cur.getAttribute("data-rel"));
      else if (ev.key === "u") {
        S.sel.clear();
        S.selecting = false;
        render();
      } else if (ev.key === "*") {
        for (const r of order()) S.sel.add(r);
        render();
      } else if (ev.key === " ") {
        if (it) {
          if (it.type !== "dir") quickLook(it, cur);
          else toggleSel(it.rel);
        } else if (cur) toggleSel(cur.getAttribute("data-rel"));
      } else if (ev.key === "m" && (S.sel.size || it)) {
        movePicker(S.sel.size ? [...S.sel] : [it.rel]);
      } else if (ev.key === "r" && (S.sel.size || it)) {
        const rels = S.sel.size ? [...S.sel] : [it.rel];
        if (rels.length > 1) openBatchRenamer(rels);
        else if (it) inlineRename(it);
      } else if (ev.key === "e" && it && EDITABLE.test(it.name)) {
        editText(it);
      } else if (ev.key === "z" && (S.sel.size || it)) {
        downloadZip(S.sel.size ? [...S.sel] : [it.rel]);
      } else if ((ev.key === "Delete" || (ev.key === "Backspace" && (ev.metaKey || ev.ctrlKey))) && (S.sel.size || it)) {
        trash(S.sel.size ? [...S.sel] : [it.rel]);
      } else if (ev.key === "F2" && it) inlineRename(it);
      else if ((ev.key === "Backspace" || (ev.key === "ArrowUp" && ev.altKey)) && S.rel) go(S.rel === TRASH ? "" : parentOf(S.rel));
      else if (ev.key === "a" && (ev.ctrlKey || ev.metaKey)) {
        for (const r of order()) S.sel.add(r);
        render();
      } else if (ev.key === "Escape" && S.sel.size) {
        S.sel.clear();
        S.selecting = false;
        render();
      } else return;
      ev.preventDefault();
    });
    S.listEl.addEventListener("focusin", (ev) => {
      const n = ev.target.closest && ev.target.closest(".fx-item[data-rel]");
      if (n) S.focusRel = n.getAttribute("data-rel");
    });
  }

  // ---------------------------------------------------------------- lifecycle

  function start(win) {
    if (S.started || !win || !win.document) return;
    S.started = true;
    S.win = win;
    S.doc = win.document;
    try {
      S.view = win.localStorage.getItem("hq_files_view") === "list" ? "list" : "grid";
      const s = win.localStorage.getItem("hq_files_sort");
      S.sort = s === "recent" || s === "size" ? s : "name";
    } catch (_) {}
    S.doc.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && S.sheet) {
        ev.preventDefault();
        ev.stopPropagation();
        closeSheet();
      } else if ((ev.key === "ArrowRight" || ev.key === "ArrowLeft") && S.sheet && S.qlStep && !(ev.target.closest && ev.target.closest("input,textarea,select"))) {
        ev.preventDefault();
        S.qlStep(ev.key === "ArrowRight" ? 1 : -1);
      }
    }, true);
    S.doc.addEventListener("paste", async (ev) => {
      if (S.doc.body.dataset.view !== "fichiers" || S.rel === TRASH) return;
      if (ev.target && ev.target.closest && ev.target.closest("input,textarea,[contenteditable]")) return;
      const cd = ev.clipboardData;
      if (!cd) return;
      const files = [];
      if (cd.files && cd.files.length) {
        for (let i = 0; i < cd.files.length; i++) files.push(cd.files[i]);
      } else if (cd.items && cd.items.length) {
        for (let i = 0; i < cd.items.length; i++) {
          const item = cd.items[i];
          if (item.kind === "file") {
            const f = item.getAsFile();
            if (f) files.push(f);
          }
        }
      }
      if (files.length) {
        ev.preventDefault();
        toast("Envoi depuis le presse-papiers…");
        await upload(files, uploadTarget(S.rel));
        return;
      }
      const text = cd.getData("text/plain");
      if (text && /^https?:\/\/\S+/i.test(text.trim())) {
        ev.preventDefault();
        const url = text.trim();
        const folder = uploadTarget(S.rel);
        const urlIn = el("input", { type: "text", class: "fx-name", value: url, "aria-label": "URL à aspirer" });
        const nameIn = el("input", { type: "text", class: "fx-name", placeholder: "Nom du fichier (optionnel)", "aria-label": "Nom du fichier cible" });
        const siphonBtn = btn("Aspirer le fichier", {
          cls: "fx-btn is-primary",
          icon: "download",
          on: async () => {
            siphonBtn.disabled = true;
            toast("Aspiration en cours…");
            try {
              const res = await postJson("/api/files/siphon", { url: urlIn.value.trim(), folder, name: nameIn.value.trim() || null });
              toast("Fichier aspiré : " + (res.name || "fichier"));
              closeSheet();
              await load(S.rel);
            } catch (e) {
              toast((e && e.message) || "Échec de l'aspiration", null, null, true);
            } finally {
              siphonBtn.disabled = false;
            }
          },
        });
        openSheet("Aspirer l'URL dans " + folder, el("div", { style: "display:flex;flex-direction:column;gap:12px;padding:8px 0" }, [
          el("p", { class: "fx-hint", text: "Télécharger directement ce fichier distant dans le dossier :" }),
          urlIn,
          nameIn,
        ]), [btn("Annuler", { on: () => closeSheet() }), siphonBtn]);
        return;
      }
      if (text && text.trim()) {
        ev.preventDefault();
        const d = new Date();
        const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") + "_" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0") + String(d.getSeconds()).padStart(2, "0");
        const defaultName = "presse-papiers_" + stamp + ".txt";
        const nameIn = el("input", { type: "text", class: "fx-name", value: defaultName, "aria-label": "Nom du fichier" });
        const ta = el("textarea", { class: "fx-editor", spellcheck: "false", "aria-label": "Contenu collé" });
        ta.value = text;
        const save = btn("Enregistrer", { cls: "fx-btn is-primary", icon: "check", on: async () => {
          save.disabled = true;
          try {
            await postJson("/api/create", { path: uploadTarget(S.rel), name: nameIn.value.trim() || defaultName, content: ta.value });
            toast("Fichier créé depuis le presse-papiers");
            closeSheet();
            await load(S.rel);
          } catch (e) {
            toast((e && e.message) || "Erreur de création", null, null, true);
          } finally {
            save.disabled = false;
          }
        } });
        openSheet("Coller le texte dans " + uploadTarget(S.rel), el("div", { class: "fx-paste-wrap" }, [nameIn, ta]), [btn("Annuler", { on: () => closeSheet() }), save], "is-editor");
      }
    });
    const boot = () => {
      S.app = S.doc.getElementById("hq-files-app");
      if (!S.app) return;
      build();
      // HQ entry points now lead here
      win.navigate = function (rel) {
        if (S.doc.body.dataset.view !== "fichiers" && typeof win.setView === "function") win.setView("fichiers");
        return go(rel || "");
      };
      win.refreshFiles = function () {
        // Fichiers stays empty until you open it: no folder previews (file names, pictures) on other pages, no requests.
        // setView("fichiers") calls refreshFiles() again when you get there.
        if (S.doc.body.dataset.view !== "fichiers") return Promise.resolve();
        return load(S.rel === TRASH ? "" : S.rel);
      };
      win.renderFiles = function () {
        render();
      };
      win.hqFilesUpload = (files, folder) => upload(files, folder || uploadTarget(S.rel));
      try {
        const savedPins = JSON.parse(win.localStorage.getItem("hq_files_pins_v1") || "[]");
        if (Array.isArray(savedPins)) S.pins = new Set(savedPins);
      } catch (_) {}
      try {
        const savedTags = JSON.parse(win.localStorage.getItem("hq_files_tags_v1") || "{}");
        if (savedTags && typeof savedTags === "object") {
          S.tags = new Map(Object.entries(savedTags));
        }
      } catch (_) {}
      loadBackups(true);
      let start = "";
      try {
        start = currentRel || ""; // eslint-disable-line no-undef
      } catch (_) {}
      if (S.doc.body.dataset.view === "fichiers") load(start);
      else S.rel = start;
    };
    if (S.doc.readyState === "loading") S.doc.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }

  return { start, pure };
});
