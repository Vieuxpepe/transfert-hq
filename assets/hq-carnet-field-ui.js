/* Transfert HQ — Carnet Field Capture UI (product phase 4): the DOM layer over hq-carnet-field.js.
 *
 * Surfaces (all opened by a DIRECT user action; nothing starts by itself, nothing runs in the background):
 *   - the mobile Field HUD (a launcher: five buttons that end in the existing insert paths; it persists nothing),
 *   - the document scanner (manual corners, perspective correction, rotate, three treatments, multi-page),
 *   - OCR (Tesseract.js, vendored, local; one worker at a time, sequential pages, cancellable, always terminated),
 *   - the voice recorder, the voice block card and the optional transcript panel,
 *   - the bounded IndexedDB recovery stash for uncommitted captures.
 *
 * The scan and the audio are canonical; OCR text / transcripts are derived text inserted through the host's single edit path with
 * canonical provenance. Nothing is uploaded to any third party: every request is same-origin through the page's own api().
 *
 * Plain ES2020, no build step, DOM built with createElement/textContent only (no HTML-string sinks), no dynamic code generation.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetFieldUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const OCR_LANGS = [{ id: "fra", label: "Français" }, { id: "eng", label: "English" }];
  const ASSET_URL = "/api/carnet/asset/";
  const VOICE_URL = "/api/carnet/voice/";
  const TESS = {
    script: "/assets/vendor-tesseract.min.js",
    worker: "/assets/vendor-tesseract-worker.min.js",
    core: "/assets/vendor-tesseract-core-simd-lstm.wasm.js",
    lang: "/assets",
  };
  const DB_NAME = "hq-carnet-field";
  const DB_STORE = "captures";

  const MSG = {
    readonly: "Page en lecture seule : ouvrez une page modifiable",
    stale: "La page a changé : rien n'a été inséré. La capture reste en réserve.",
    offline: "Hors ligne : la capture est gardée en réserve. Réessayez une fois connecté.",
    stashOff: "La récupération après fermeture n'est pas disponible sur ce navigateur : terminez cette capture avant de quitter.",
    inserted: "Inséré dans la page",
    refused: "Insertion refusée : rien n'a été inséré. La capture reste en réserve.",
  };

  function create(win) {
    const doc = win.document;

    function el(tag, attrs, kids) {
      const n = doc.createElement(tag);
      if (attrs) {
        for (const k of Object.keys(attrs)) {
          const v = attrs[k];
          if (v === false || v === null || v === undefined) continue;
          if (k === "text") n.textContent = String(v);
          else n.setAttribute(k, v === true ? "" : String(v));
        }
      }
      if (kids) for (const c of kids) if (c) n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
      return n;
    }

    function svg(path) {
      const s = doc.createElementNS(SVG_NS, "svg");
      s.setAttribute("viewBox", "0 0 24 24");
      s.setAttribute("width", "22");
      s.setAttribute("height", "22");
      s.setAttribute("fill", "none");
      s.setAttribute("stroke", "currentColor");
      s.setAttribute("stroke-width", "2");
      s.setAttribute("stroke-linecap", "round");
      s.setAttribute("stroke-linejoin", "round");
      s.setAttribute("aria-hidden", "true");
      s.setAttribute("focusable", "false");
      const p = doc.createElementNS(SVG_NS, "path");
      p.setAttribute("d", path);
      s.appendChild(p);
      return s;
    }

    function mount(host) {
      const F = host.field;
      const L = F.LIMITS;
      const S = {
        hud: null,
        banner: null,
        sheet: null, // {root, body, foot, title, live, opener, onClose, dirty}
        busy: false,
        ocr: null, // {worker, cancel}
        rec: null, // recorder runtime
        urls: new Set(),
        stashOk: null,
        stashWarned: false,
        vv: null,
      };

      // ---------------------------------------------------------------- small utilities
      const tick = () => new Promise((r) => (win.setTimeout ? win.setTimeout(r, 0) : r()));
      const nowMs = () => Date.now();
      const pad2 = (x) => (x < 10 ? "0" + x : String(x));

      function objectUrl(blob) {
        const u = win.URL.createObjectURL(blob);
        S.urls.add(u);
        return u;
      }

      function revoke(u) {
        if (u && S.urls.has(u)) {
          S.urls.delete(u);
          try {
            win.URL.revokeObjectURL(u);
          } catch (_) {
            /* ignore */
          }
        }
      }

      function revokeAll() {
        for (const u of Array.from(S.urls)) revoke(u);
      }

      function online() {
        return !(win.navigator && win.navigator.onLine === false);
      }

      function plural(n, one, many) {
        return n + " " + (n > 1 ? many : one);
      }

      function describe(err) {
        if (err && err.data && typeof err.data.error === "string") return err.data.error;
        if (err && err.name === "MediaError" && err.message) return err.message;
        const m = err && err.message ? String(err.message) : "";
        return m && m.length < 140 ? m : "Opération impossible";
      }

      // ---------------------------------------------------------------- sheet (one modal at a time)
      function say(text) {
        const live = S.sheet ? S.sheet.live : S.hud ? S.hud.live : null;
        if (!live) return;
        live.textContent = "";
        win.setTimeout(() => {
          live.textContent = text || "";
        }, 30); // a cleared-then-set live region is re-announced even for repeated text
      }

      function focusables(root) {
        return Array.from(root.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),audio[controls],[tabindex]:not([tabindex="-1"])')).filter((n) => !n.hidden && !n.closest("[hidden]"));
      }

      /** Open the single field sheet. `o` = {title, name, opener, onClose(reason) -> false to keep it open}. */
      function openSheet(o) {
        if (S.sheet) closeSheet("replace", true);
        const titleId = "hq-field-title";
        const live = el("div", { class: "carnet-field-live", role: "status", "aria-live": "polite", "aria-atomic": "true" });
        const title = el("h2", { id: titleId, class: "carnet-field-title", text: o.title, tabindex: "-1" });
        const close = el("button", { type: "button", class: "carnet-field-close", "aria-label": "Fermer", "data-field-close": "" }, [svg("M6 6l12 12M18 6L6 18")]);
        const head = el("div", { class: "carnet-field-head" }, [title, close]);
        const body = el("div", { class: "carnet-field-body" });
        const foot = el("div", { class: "carnet-field-foot" });
        const panel = el("div", { class: "carnet-field-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, "data-field-sheet": o.name || "" }, [head, body, foot, live]);
        const back = el("div", { class: "carnet-field-back", "aria-hidden": "true" });
        const rootEl = el("div", { class: "carnet-field-sheet", id: "hq-carnet-field-sheet" }, [back, panel]);
        S.sheet = { root: rootEl, panel, body, foot, title, live, opener: o.opener || doc.activeElement, onClose: o.onClose || null, name: o.name || "" };
        doc.body.appendChild(rootEl);
        doc.body.classList.add("carnet-field-open");
        placeSheet();
        close.addEventListener("click", () => closeSheet("user"));
        back.addEventListener("click", () => closeSheet("user"));
        panel.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            closeSheet("user");
          } else if (e.key === "Tab") {
            const list = focusables(panel);
            if (!list.length) return;
            const first = list[0];
            const last = list[list.length - 1];
            if (e.shiftKey && doc.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && doc.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        });
        // Focus can fall to <body> when the focused button is hidden by a state change: keep Esc / Tab working and pull focus back in.
        const onDoc = (e) => {
          if (!S.sheet || S.sheet.panel.contains(e.target)) return;
          if (e.key === "Escape") {
            e.preventDefault();
            closeSheet("user");
          } else if (e.key === "Tab") {
            e.preventDefault();
            const list = focusables(S.sheet.panel);
            (list[0] || S.sheet.title).focus({ preventScroll: true });
          }
        };
        doc.addEventListener("keydown", onDoc, true);
        S.sheet.offDoc = () => doc.removeEventListener("keydown", onDoc, true);
        title.focus({ preventScroll: true });
        return S.sheet;
      }

      /** Close the sheet. `reason` "user" lets the sheet veto (unsaved work); "force" never asks. Focus returns to the opener. */
      function closeSheet(reason, silent) {
        const sh = S.sheet;
        if (!sh) return true;
        if (sh.onClose && reason === "user" && sh.onClose(reason) === false) return false;
        if (sh.onClose && reason !== "user" && reason !== "replace") sh.onClose(reason);
        S.sheet = null;
        if (sh.offDoc) sh.offDoc();
        sh.root.remove();
        doc.body.classList.remove("carnet-field-open");
        refreshHud();
        if (!silent) {
          const op = sh.opener;
          if (op && op.isConnected && typeof op.focus === "function") op.focus({ preventScroll: true });
          else if (host.focusEditor) host.focusEditor();
        }
        return true;
      }

      /** Keyboard / safe-area aware: the sheet follows the visual viewport (a software keyboard shrinks it). */
      function placeSheet() {
        const sh = S.sheet;
        if (!sh) return;
        const vv = win.visualViewport;
        const h = vv ? vv.height : win.innerHeight;
        const top = vv ? vv.offsetTop : 0;
        sh.root.style.setProperty("--field-vh", Math.round(h) + "px");
        sh.root.style.setProperty("--field-top", Math.round(top) + "px");
      }

      function setBody(nodes) {
        const sh = S.sheet;
        sh.body.textContent = "";
        for (const n of nodes) if (n) sh.body.appendChild(n);
      }

      function setFoot(buttons) {
        const sh = S.sheet;
        sh.foot.textContent = "";
        for (const b of buttons) if (b) sh.foot.appendChild(b);
      }

      function btn(text, cls, onClick, attrs) {
        const b = el("button", Object.assign({ type: "button", class: "carnet-field-btn" + (cls ? " " + cls : ""), text }, attrs || {}));
        if (onClick) b.addEventListener("click", onClick);
        return b;
      }

      function para(text, cls, attrs) {
        return el("p", Object.assign({ class: "carnet-field-text" + (cls ? " " + cls : ""), text }, attrs || {}));
      }

      // ---------------------------------------------------------------- recovery stash (IndexedDB, bounded, no sync)
      function idb() {
        if (S.db) return S.db;
        S.db = new Promise((resolve) => {
          if (!win.indexedDB) return resolve(null);
          let req;
          try {
            req = win.indexedDB.open(DB_NAME, 1);
          } catch (_) {
            return resolve(null);
          }
          req.onupgradeneeded = () => {
            try {
              req.result.createObjectStore(DB_STORE, { keyPath: "id" });
            } catch (_) {
              /* handled by onsuccess */
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        });
        return S.db;
      }

      function tx(mode, fn) {
        return idb().then((db) => {
          if (!db) return null;
          return new Promise((resolve) => {
            let out = null;
            try {
              const t = db.transaction(DB_STORE, mode);
              const store = t.objectStore(DB_STORE);
              out = fn(store);
              t.oncomplete = () => resolve(out && "result" in out ? out.result : true);
              t.onerror = () => resolve(null);
              t.onabort = () => resolve(null);
            } catch (_) {
              resolve(null);
            }
          });
        });
      }

      const stash = {
        async available() {
          if (S.stashOk === null) S.stashOk = !!(await idb());
          return S.stashOk;
        },
        async list() {
          const r = await tx("readonly", (st) => st.getAll());
          return Array.isArray(r) ? r : [];
        },
        async get(id) {
          const r = await tx("readonly", (st) => st.get(id));
          return r && r.id ? r : null;
        },
        async del(id) {
          return !!(await tx("readwrite", (st) => st.delete(id)));
        },
        /** Remember the canonical server asset a stashed capture already became (bounded metadata; the TTL clock is NOT restarted). */
        async mark(id, uploaded) {
          if (!id || !uploaded || typeof uploaded.id !== "string") return false;
          const rec = await stash.get(id);
          if (!rec) return false;
          const slim = { id: uploaded.id, mime: String(uploaded.mime || "") };
          if (uploaded.w > 0 && uploaded.h > 0) {
            slim.w = uploaded.w | 0;
            slim.h = uploaded.h | 0;
          }
          return !!(await tx("readwrite", (st) => st.put(Object.assign({}, rec, { uploaded: slim }))));
        },
        /** Prune expired items, then admit by the bounded policy. Never evicts a live capture. Returns {ok, reason}. */
        async put(rec) {
          if (!(await stash.available())) return { ok: true, volatile: true };
          const all = await stash.list();
          const pr = F.stashPrune(all, nowMs());
          for (const d of pr.drop) await stash.del(d.id);
          const rest = pr.keep.filter((i) => i.id !== rec.id);
          const adm = F.stashAdmit(rest, rec);
          if (!adm.ok) return adm;
          const ok = await tx("readwrite", (st) => st.put(rec));
          return ok ? { ok: true } : { ok: false, reason: "bytes" };
        },
        async prune() {
          if (!(await stash.available())) return [];
          const all = await stash.list();
          const pr = F.stashPrune(all, nowMs());
          for (const d of pr.drop) await stash.del(d.id);
          return pr.keep;
        },
      };

      /** Does a previously uploaded canonical asset still exist? TRI-STATE: only an authoritative 404 is "missing"; a network error, a
       *  401/403, a 5xx or anything unexpected is "unknown" (never a licence to upload the same capture a second time).
       *  Same-origin; one byte requested (both routes honour a single bounded Range). */
      async function assetState(kind, id) {
        if (typeof id !== "string" || !/^[a-z]+-[0-9a-f]{24}$/.test(id) || !win.fetch) return "unknown";
        try {
          const r = await win.fetch((kind === "voice" ? "/api/carnet/voice/" : "/api/carnet/asset/") + encodeURIComponent(id), { credentials: "same-origin", headers: { Range: "bytes=0-0" } });
          if (r.body && r.body.cancel) r.body.cancel();
          if (r.status === 200 || r.status === 206) return "exists";
          return r.status === 404 ? "missing" : "unknown";
        } catch (_) {
          return "unknown";
        }
      }
      const UNVERIFIED = "Impossible de vérifier le fichier déjà envoyé. Réessayez.";

      /** Stash one capture; a refusal (full) is user-visible and stops the capture from being kept only in memory. */
      async function stashCapture(rec) {
        const r = await stash.put(rec);
        if (r.volatile && !S.stashWarned) {
          S.stashWarned = true;
          say(MSG.stashOff);
          host.status(MSG.stashOff, true);
        }
        if (!r.ok) {
          const m = F.STASH_MESSAGES[r.reason] || F.STASH_MESSAGES.bytes;
          say(m);
          host.status(m, true);
        }
        return r;
      }

      function newId(prefix) {
        let a = "";
        try {
          const u = new Uint8Array(8);
          win.crypto.getRandomValues(u);
          a = Array.from(u, (x) => (x < 16 ? "0" : "") + x.toString(16)).join("");
        } catch (_) {
          a = Math.random().toString(16).slice(2, 18).padEnd(16, "0");
        }
        return prefix + "-" + a;
      }

      // ---------------------------------------------------------------- HUD (launcher only)
      function mountHud(parent) {
        if (S.hud || !parent) return;
        const live = el("div", { class: "carnet-field-live", role: "status", "aria-live": "polite", "aria-atomic": "true" });
        const bar = el("div", { id: "hq-carnet-field-hud", class: "carnet-field-hud", role: "toolbar", "aria-label": "Capture terrain", "aria-orientation": "horizontal", "data-kb": "closed" });
        const buttons = [];
        for (const a of F.HUD_ACTIONS) {
          const b = el("button", { type: "button", class: "carnet-field-hud-btn", "data-field-action": a.id, "aria-label": a.hint, tabindex: buttons.length ? "-1" : "0" }, [svg(a.icon), el("span", { class: "carnet-field-hud-label", text: a.label })]);
          b.addEventListener("click", () => {
            const st = F.hudState({ editable: host.editable(), busy: S.busy || !!S.sheet }).find((x) => x.id === a.id);
            if (!st || !st.enabled) {
              host.status(st && st.reason ? st.reason : MSG.readonly, true);
              return;
            }
            host.command(a.command);
          });
          buttons.push(b);
          bar.appendChild(b);
        }
        bar.addEventListener("keydown", (e) => {
          const i = buttons.indexOf(doc.activeElement);
          if (i < 0) return;
          let n = -1;
          if (e.key === "ArrowRight") n = (i + 1) % buttons.length;
          else if (e.key === "ArrowLeft") n = (i - 1 + buttons.length) % buttons.length;
          else if (e.key === "Home") n = 0;
          else if (e.key === "End") n = buttons.length - 1;
          if (n < 0) return;
          e.preventDefault();
          buttons.forEach((b, k) => b.setAttribute("tabindex", k === n ? "0" : "-1"));
          buttons[n].focus();
        });
        bar.appendChild(live);
        parent.appendChild(bar);
        S.hud = { bar, buttons, live };
        refreshHud();
        const vv = win.visualViewport;
        if (vv) {
          const onVv = () => {
            const kb = Math.max(0, win.innerHeight - vv.height - vv.offsetTop);
            bar.setAttribute("data-kb", kb > 80 ? "open" : "closed");
            bar.style.setProperty("--field-kb", Math.round(kb) + "px");
            placeSheet();
          };
          vv.addEventListener("resize", onVv);
          vv.addEventListener("scroll", onVv);
          S.vv = { vv, onVv };
        }
      }

      function refreshHud() {
        if (!S.hud) return;
        const st = F.hudState({ editable: host.editable(), busy: S.busy || !!S.sheet });
        st.forEach((s, i) => {
          const b = S.hud.buttons[i];
          if (!b) return;
          b.setAttribute("aria-disabled", s.enabled ? "false" : "true");
          if (s.enabled) b.removeAttribute("title");
          else b.setAttribute("title", s.reason);
        });
      }

      // ---------------------------------------------------------------- image helpers
      async function decodeBitmap(blob) {
        if (win.createImageBitmap) {
          try {
            return await win.createImageBitmap(blob);
          } catch (_) {
            /* fall back to <img> */
          }
        }
        const url = objectUrl(blob);
        try {
          const img = new win.Image();
          img.decoding = "async";
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = () => rej(new Error("Image illisible"));
            img.src = url;
          });
          return img;
        } finally {
          revoke(url);
        }
      }

      function canvasOf(w, h) {
        const c = doc.createElement("canvas");
        c.width = w;
        c.height = h;
        return c;
      }

      function toBlob(canvas, type, q) {
        return new Promise((res) => canvas.toBlob((b) => res(b), type, q));
      }

      function ctx2d(canvas) {
        return canvas.getContext("2d", { willReadFrequently: true });
      }

      function sizeOf(bm) {
        return { w: bm.width || bm.naturalWidth, h: bm.height || bm.naturalHeight };
      }

      // ---------------------------------------------------------------- scanner
      const scan = { sc: null, cur: null, rot: 0, quad: null, filter: "color", src: null, focusHandle: -1, previewTimer: 0 };

      function openScanner(opener) {
        if (!host.editable()) return host.status(MSG.readonly, true);
        if (S.sheet || S.busy) return host.status("Une capture est déjà en cours", true);
        const target = host.captureTarget();
        if (!target) return host.status(MSG.readonly, true);
        scan.sc = F.scanNew();
        scan.sid = newId("scan");
        scan.pages = [];
        scan.target = target;
        scan.ocrOn = false;
        openSheet({ title: "Scanner un document", name: "scanner", opener, onClose: () => scanClose() });
        scanPrompt();
        refreshHud();
      }

      function scanClose() {
        if (scan.sc && (scan.sc.state === "processing" || scan.working)) {
          say("Traitement en cours : patientez ou annulez");
          return false;
        }
        if (scan.pages && scan.pages.length && scan.sc.state !== "done" && !scan.confirmDrop) {
          scan.confirmDrop = true;
          say("Les pages numérisées resteront récupérables. Fermer à nouveau pour quitter.");
          host.status("Les pages numérisées restent récupérables : fermez à nouveau pour quitter", false);
          win.setTimeout(() => {
            scan.confirmDrop = false;
          }, 4000);
          return false;
        }
        scanRelease();
        return true;
      }

      function scanRelease() {
        for (const p of scan.pages || []) revoke(p.url);
        if (scan.cur) scan.cur = null;
        scan.src = null;
        scan.quad = null;
        scan.confirmDrop = false;
        S.busy = false;
        scan.sc = F.scanReduce(scan.sc || F.scanNew(), { type: "cancel" });
        refreshHud();
      }

      function fileInput(kind, onFile) {
        const input = el("input", { type: "file", class: "carnet-field-file", accept: "image/jpeg,image/png,image/webp,image/*", tabindex: "-1", "aria-hidden": "true", "data-field-input": kind });
        if (kind === "camera") input.setAttribute("capture", "environment");
        input.addEventListener("change", () => {
          const f = input.files && input.files[0];
          input.value = "";
          if (f) onFile(f);
        });
        return input;
      }

      /** Step 1 / review: pick a source for the next page (camera or file) and list the pages kept so far. */
      function scanPrompt() {
        const sc = scan.sc;
        const kept = scan.pages.length;
        const cam = fileInput("camera", (f) => scanLoad(f));
        const pick = fileInput("photos", (f) => scanLoad(f));
        const nodes = [];
        if (!kept) nodes.push(para("Cadrez le document à plat, bien éclairé. Vous placerez ensuite les quatre coins à la main : la détection automatique n'existe pas encore."));
        if (sc.error === "limit") nodes.push(para("Maximum " + L.scanPagesMax + " pages par document.", "carnet-field-warn", { role: "alert" }));
        if (sc.error && sc.error !== "limit") nodes.push(para("Le traitement a échoué : aucune page n'a été insérée. Les pages sont conservées, réessayez.", "carnet-field-warn", { role: "alert" }));
        const row = el("div", { class: "carnet-field-actions" });
        const takeBtn = btn(kept ? "Ajouter une page (photo)" : "Prendre une photo", "primary", () => cam.click(), { "data-field-take": "", disabled: kept >= L.scanPagesMax });
        const pickBtn = btn(kept ? "Ajouter une page (image)" : "Choisir une image", "", () => pick.click(), { "data-field-pick": "", disabled: kept >= L.scanPagesMax });
        row.append(takeBtn, pickBtn, cam, pick);
        nodes.push(row);
        if (kept) {
          const list = el("ol", { class: "carnet-field-pages", "aria-label": "Pages numérisées" });
          scan.pages.forEach((p, i) => {
            const li = el("li", { class: "carnet-field-page", "data-page": String(i + 1) });
            li.appendChild(el("img", { class: "carnet-field-thumb", src: p.url, alt: "Page " + (i + 1) + " (" + p.w + " sur " + p.h + " pixels)", width: "56", height: "72" }));
            li.appendChild(el("span", { class: "carnet-field-page-name", text: "Page " + (i + 1) + " sur " + kept }));
            const acts = el("span", { class: "carnet-field-page-actions" });
            acts.appendChild(btn("Monter", "quiet", () => scanMove(i, -1), { "aria-label": "Monter la page " + (i + 1), disabled: i === 0 }));
            acts.appendChild(btn("Descendre", "quiet", () => scanMove(i, 1), { "aria-label": "Descendre la page " + (i + 1), disabled: i === kept - 1 }));
            acts.appendChild(btn("Refaire", "quiet", () => scanRetake(i), { "aria-label": "Refaire le cadrage de la page " + (i + 1) }));
            acts.appendChild(btn("Retirer", "quiet", () => scanRemove(i), { "aria-label": "Retirer la page " + (i + 1) }));
            li.appendChild(acts);
            list.appendChild(li);
          });
          nodes.push(list);
          const orphan = scan.pages.filter((p) => p.asset).length;
          if (orphan) nodes.push(para(plural(orphan, "page est déjà téléversée", "pages sont déjà téléversées") + " : si vous abandonnez, elle reste sans usage sur le serveur.", "carnet-field-note"));
          if (kept > L.ocrPagesMax) nodes.push(para("La reconnaissance du texte est limitée à " + L.ocrPagesMax + " pages par passage.", "carnet-field-note"));
        }
        setBody(nodes);
        const foot = [];
        foot.push(btn("Annuler", "quiet", () => closeSheet("user"), { "data-field-cancel": "" }));
        if (kept) {
          foot.push(btn(kept > 1 ? "Insérer " + kept + " pages" : "Insérer la page", "primary", () => scanFinish(false), { "data-field-insert": "" }));
          foot.push(btn("Insérer et lire le texte", "", () => scanFinish(true), { "data-field-insert-ocr": "", disabled: kept > L.ocrPagesMax }));
        }
        setFoot(foot);
        (kept ? sheetFocusFirst : sheetFocusTitle)();
      }

      function sheetFocusTitle() {
        if (S.sheet) S.sheet.title.focus({ preventScroll: true });
      }

      function sheetFocusFirst() {
        if (!S.sheet) return;
        const t = S.sheet.body.querySelector("[data-field-take]") || S.sheet.title;
        t.focus({ preventScroll: true });
      }

      function scanMove(i, d) {
        const to = i + d;
        if (to < 0 || to >= scan.pages.length) return;
        const p = scan.pages.splice(i, 1)[0];
        scan.pages.splice(to, 0, p);
        scan.sc = F.scanReduce(Object.assign({}, scan.sc, { state: "review", pages: scan.pages.map(() => 1) }), { type: "move", index: i, delta: 0 });
        scanPrompt();
        say("Page déplacée en position " + (i + d + 1));
      }

      async function scanRemove(i) {
        const p = scan.pages[i];
        if (!p) return;
        scan.sc = F.scanReduce(Object.assign({}, scan.sc, { pages: scan.pages.map(() => 1), state: "review" }), { type: "remove", index: i });
        scan.pages.splice(i, 1);
        revoke(p.url);
        await stash.del(p.stashId);
        if (!scan.pages.length) scan.sc = F.scanNew();
        scanPrompt();
        say("Page retirée");
      }

      function scanRetake(i) {
        scan.retake = i;
        const input = fileInput("photos", (f) => scanLoad(f, i));
        S.sheet.body.appendChild(input);
        input.click();
      }

      /** A source image was chosen: prepare it (EXIF orientation, <= 2560 px, source limits) and open the framing step. */
      async function scanLoad(file, retake) {
        const Media = host.media;
        if (!Media) return say("Traitement d'image indisponible");
        S.busy = true;
        scan.working = true;
        say("Préparation de l'image");
        try {
          const prepared = await Media.prepare(file);
          const bm = await decodeBitmap(prepared.blob);
          const d = sizeOf(bm);
          const c = canvasOf(d.w, d.h);
          ctx2d(c).drawImage(bm, 0, 0);
          if (bm.close) bm.close();
          scan.src = { canvas: c, w: d.w, h: d.h };
          scan.rot = 0;
          scan.filter = "color";
          scan.quad = F.defaultCorners(d.w, d.h);
          scan.retake = typeof retake === "number" ? retake : -1;
          scan.sc = F.scanReduce(Object.assign({}, scan.sc, { state: scan.pages.length ? "review" : "idle", pages: scan.pages.map(() => 1) }), typeof retake === "number" ? { type: "capture", index: retake } : { type: "capture" });
          if (scan.sc.state !== "editing") {
            S.busy = false;
            scan.working = false;
            return scanPrompt();
          }
          scanFrame();
        } catch (err) {
          const m = describe(err);
          say(m);
          host.status(m, true);
          scanPrompt();
        } finally {
          S.busy = false;
          scan.working = false;
          refreshHud();
        }
      }

      const HANDLES = ["Coin haut gauche", "Coin haut droit", "Coin bas droit", "Coin bas gauche"];

      /** The framing step: the source on a canvas, four draggable / arrow-key corner handles, rotate, treatment, live preview. */
      function scanFrame() {
        const src = scan.src;
        const stage = el("div", { class: "carnet-field-stage" });
        stage.style.setProperty("--ar", String(scan.src.w / scan.src.h));
        const view = canvasOf(src.w, src.h);
        view.className = "carnet-field-view";
        view.setAttribute("role", "img");
        view.setAttribute("aria-label", "Photo du document avec le cadre de recadrage");
        const overlay = doc.createElementNS(SVG_NS, "svg");
        overlay.setAttribute("class", "carnet-field-overlay");
        overlay.setAttribute("viewBox", "0 0 100 100");
        overlay.setAttribute("preserveAspectRatio", "none");
        overlay.setAttribute("aria-hidden", "true");
        const poly = doc.createElementNS(SVG_NS, "polygon");
        poly.setAttribute("class", "carnet-field-poly");
        overlay.appendChild(poly);
        stage.append(view, overlay);
        const handles = HANDLES.map((name, i) => {
          const h = el("button", { type: "button", class: "carnet-field-handle", "data-handle": String(i), "aria-label": name, "aria-describedby": "hq-field-handle-hint" });
          stage.appendChild(h);
          return h;
        });
        const hint = el("p", { id: "hq-field-handle-hint", class: "carnet-field-note", text: "Faites glisser chaque coin, ou sélectionnez-le puis utilisez les flèches (Maj : pas plus grand)." });
        const problem = el("p", { class: "carnet-field-warn", role: "alert", hidden: true });
        const preview = canvasOf(8, 8);
        preview.className = "carnet-field-preview";
        preview.setAttribute("role", "img");
        preview.setAttribute("aria-label", "Aperçu de la page redressée");

        const drawView = () => {
          const c = ctx2d(view);
          c.clearRect(0, 0, view.width, view.height);
          c.drawImage(src.canvas, 0, 0);
        };

        const place = () => {
          const q = scan.quad;
          poly.setAttribute("points", q.map((p) => (p.x / src.w) * 100 + "," + (p.y / src.h) * 100).join(" "));
          handles.forEach((h, i) => {
            h.style.left = (q[i].x / src.w) * 100 + "%";
            h.style.top = (q[i].y / src.h) * 100 + "%";
            h.setAttribute("aria-label", HANDLES[i] + ", horizontal " + Math.round((q[i].x / src.w) * 100) + " pour cent, vertical " + Math.round((q[i].y / src.h) * 100) + " pour cent");
          });
          const pr = F.quadProblem(q, src.w, src.h);
          problem.hidden = !pr;
          problem.textContent = pr ? "Le cadre n'est pas valide : " + ({ concave: "il se croise", small: "un côté est trop court", area: "il est trop petit", degenerate: "des coins sont alignés", outside: "un coin sort de l'image", shape: "forme inconnue" }[pr] || "forme invalide") + "." : "";
          accept.disabled = !!pr;
          accept.setAttribute("aria-disabled", pr ? "true" : "false");
          schedulePreview();
        };

        const schedulePreview = () => {
          if (scan.previewTimer) win.clearTimeout(scan.previewTimer);
          scan.previewTimer = win.setTimeout(renderPreview, 120);
        };

        const renderPreview = () => {
          scan.previewTimer = 0;
          if (!scan.src || F.quadProblem(scan.quad, src.w, src.h)) return;
          const full = F.outputSize(scan.quad, 360);
          const data = ctx2d(src.canvas).getImageData(0, 0, src.w, src.h);
          const out = F.warpPerspective(data.data, src.w, src.h, scan.quad, full.w, full.h);
          if (!out) return;
          F.applyFilter(out, full.w, full.h, scan.filter);
          preview.width = full.w;
          preview.height = full.h;
          ctx2d(preview).putImageData(new win.ImageData(out, full.w, full.h), 0, 0);
        };

        const setCorner = (i, x, y) => {
          const q = scan.quad.map((p) => ({ x: p.x, y: p.y }));
          q[i] = { x: Math.max(0, Math.min(src.w, x)), y: Math.max(0, Math.min(src.h, y)) };
          scan.quad = q;
          place();
        };

        handles.forEach((h, i) => {
          h.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            try {
              h.setPointerCapture(e.pointerId);
            } catch (_) {
              /* synthetic pointers */
            }
            h.setAttribute("data-drag", "");
            h.focus({ preventScroll: true });
          });
          h.addEventListener("pointermove", (e) => {
            if (!h.hasAttribute("data-drag")) return;
            const r = view.getBoundingClientRect();
            setCorner(i, ((e.clientX - r.left) / r.width) * src.w, ((e.clientY - r.top) / r.height) * src.h);
          });
          const end = (e) => {
            h.removeAttribute("data-drag");
            try {
              h.releasePointerCapture(e.pointerId);
            } catch (_) {
              /* ignore */
            }
          };
          h.addEventListener("pointerup", end);
          h.addEventListener("pointercancel", end);
          h.addEventListener("keydown", (e) => {
            const step = (e.shiftKey ? 0.05 : 0.01) * Math.max(src.w, src.h);
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
            if (!d) return;
            e.preventDefault();
            setCorner(i, scan.quad[i].x + d[0], scan.quad[i].y + d[1]);
            scan.focusHandle = i;
          });
        });

        const rotate = (dir) => {
          const t = dir > 0 ? 1 : 3;
          const c2 = canvasOf(src.h, src.w);
          const g = ctx2d(c2);
          g.translate(c2.width / 2, c2.height / 2);
          g.rotate((dir > 0 ? 1 : -1) * Math.PI / 2);
          g.drawImage(src.canvas, -src.w / 2, -src.h / 2);
          const oldW = src.w;
          const oldH = src.h;
          scan.quad = F.rotateQuad(scan.quad, oldW, oldH, t);
          scan.src = { canvas: c2, w: oldH, h: oldW };
          scan.rot = (scan.rot + t) % 4;
          scanFrame();
          say(dir > 0 ? "Rotation de 90 degrés vers la droite" : "Rotation de 90 degrés vers la gauche");
        };

        const filt = el("div", { class: "carnet-field-filters", role: "radiogroup", "aria-label": "Traitement de l'image" });
        for (const f of F.FILTERS) {
          const id = "hq-field-f-" + f.id;
          const r = el("input", { type: "radio", name: "hq-field-filter", id, value: f.id, class: "carnet-field-radio", checked: scan.filter === f.id });
          r.addEventListener("change", () => {
            scan.filter = f.id;
            schedulePreview();
            say("Traitement : " + f.label);
          });
          filt.append(r, el("label", { for: id, class: "carnet-field-chip", text: f.label }));
        }
        const tools = el("div", { class: "carnet-field-actions" }, [
          btn("Pivoter à gauche", "", () => rotate(-1), { "data-field-rotate": "left", "aria-label": "Pivoter à gauche de 90 degrés" }),
          btn("Pivoter à droite", "", () => rotate(1), { "data-field-rotate": "right", "aria-label": "Pivoter à droite de 90 degrés" }),
          btn("Réinitialiser le cadre", "quiet", () => {
            scan.quad = F.defaultCorners(src.w, src.h);
            place();
            say("Cadre réinitialisé");
          }),
        ]);
        const accept = btn("Valider la page", "primary", () => scanAccept(), { "data-field-accept": "" });
        setBody([el("p", { class: "carnet-field-text", text: scan.retake >= 0 ? "Refaire le cadrage de la page " + (scan.retake + 1) : "Page " + (scan.pages.length + 1) }), stage, hint, problem, tools, filt, el("p", { class: "carnet-field-note", text: "Aperçu du rendu" }), preview]);
        setFoot([btn("Annuler cette page", "quiet", () => scanDiscardEdit(), { "data-field-cancel-page": "" }), accept]);
        drawView();
        place();
        win.requestAnimationFrame ? win.requestAnimationFrame(() => handles[0].focus({ preventScroll: true })) : handles[0].focus();
      }

      function scanDiscardEdit() {
        scan.sc = F.scanReduce(scan.sc, { type: "discard-edit" });
        scan.src = null;
        scan.quad = null;
        if (scan.previewTimer) win.clearTimeout(scan.previewTimer);
        scanPrompt();
        say("Page annulée");
      }

      /** Rectify at full resolution (<= 2560 px long side), apply the treatment, encode, stash, keep. */
      async function scanAccept() {
        const src = scan.src;
        if (!src || F.quadProblem(scan.quad, src.w, src.h)) return;
        S.busy = true;
        scan.working = true;
        say("Traitement de la page");
        setFoot([btn("Traitement…", "primary", null, { disabled: true })]);
        await tick();
        try {
          const size = F.outputSize(scan.quad, L.scanLongSide);
          const data = ctx2d(src.canvas).getImageData(0, 0, src.w, src.h);
          const out = F.warpPerspective(data.data, src.w, src.h, scan.quad, size.w, size.h);
          if (!out) throw new Error("Cadre invalide");
          F.applyFilter(out, size.w, size.h, scan.filter);
          const c = canvasOf(size.w, size.h);
          ctx2d(c).putImageData(new win.ImageData(out, size.w, size.h), 0, 0);
          let blob = null;
          for (const q of [0.88, 0.8, 0.7, 0.6]) {
            blob = await toBlob(c, "image/jpeg", q);
            if (blob && blob.size <= L.imageFileMax) break;
            blob = null;
          }
          if (!blob) throw new Error("Page trop lourde, même réduite");
          const stashId = newId("cap");
          const r = await stashCapture({ id: stashId, kind: "scan", bytes: blob.size, at: nowMs(), meta: { session: scan.sid, w: size.w, h: size.h }, blob });
          if (!r.ok) {
            scanFrame();
            return;
          }
          const page = { id: stashId, blob, url: objectUrl(blob), w: size.w, h: size.h, mime: "image/jpeg", stashId, asset: null };
          if (scan.sc.editing >= 0 && scan.pages[scan.sc.editing]) {
            const old = scan.pages[scan.sc.editing];
            revoke(old.url);
            await stash.del(old.stashId);
            scan.pages[scan.sc.editing] = page;
          } else scan.pages.push(page);
          scan.sc = F.scanReduce(scan.sc, { type: "accept", page: 1 });
          scan.src = null;
          scan.quad = null;
          scanPrompt();
          say("Page " + scan.pages.length + " ajoutée");
        } catch (err) {
          const m = describe(err);
          say(m);
          host.status(m, true);
          scanFrame();
        } finally {
          S.busy = false;
          scan.working = false;
          refreshHud();
        }
      }

      /** Upload every page not yet uploaded (sequential), then insert in ONE logical mutation (images, then optional OCR text). */
      async function scanFinish(withOcr) {
        const sc = scan;
        if (!sc.pages.length || sc.working) return;
        if (!online()) {
          say(MSG.offline);
          host.status(MSG.offline, true);
          return;
        }
        sc.sc = F.scanReduce(Object.assign({}, sc.sc, { state: "review", pages: sc.pages.map(() => 1) }), { type: "process" });
        S.busy = true;
        sc.working = true;
        const pending = sc.pages.filter((p) => !p.asset);
        let done = 0;
        setBody([para("Téléversement des pages…", "", { "data-field-progress": "" })]);
        setFoot([btn("Annuler", "quiet", () => scanCancelUpload(), { "data-field-cancel": "" })]);
        sc.cancelled = false;
        try {
          for (const p of pending) {
            if (sc.cancelled) throw new Error("cancelled");
            say("Téléversement de la page " + (done + 1) + " sur " + pending.length);
            const a = await host.media.upload(p.blob, host.api);
            p.asset = { id: a.id, mime: a.mime, w: a.w, h: a.h };
            await stash.mark(p.stashId, p.asset); // a reload after this point still reuses the canonical asset
            done += 1;
          }
        } catch (err) {
          sc.working = false;
          S.busy = false;
          const cancelled = sc.cancelled;
          sc.sc = F.scanReduce(sc.sc, { type: "fail", reason: cancelled ? "cancelled" : "upload" });
          const left = sc.pages.filter((p) => p.asset).length;
          const m = cancelled ? "Téléversement annulé." : host.media.describeError(err) + ".";
          scanPrompt();
          const extra = left ? " " + plural(left, "page est déjà téléversée", "pages sont déjà téléversées") + " ; elle restera sans usage sur le serveur si vous abandonnez. Aucune page n'a été insérée." : " Aucune page n'a été insérée.";
          say(m + extra);
          host.status(m + extra, true);
          refreshHud();
          return;
        }
        sc.working = false;
        if (withOcr) return scanOcrStep();
        scanCommit(null);
      }

      function scanCancelUpload() {
        scan.cancelled = true;
        say("Annulation après la page en cours");
      }

      function pageItems() {
        const assets = scan.pages.map((p) => ({ id: p.asset.id, mime: p.asset.mime, w: p.asset.w, h: p.asset.h, width: 100, layout: "inline", caption: "" }));
        const items = [];
        let at = 0;
        for (const n of F.pageGroups(assets.length)) {
          if (n === 1) items.push({ type: "image", asset: assets[at] });
          else items.push({ type: "imagegroup", payload: host.rich.Struct.groupFrom(assets.slice(at, at + n).map((a) => ({ id: a.id, mime: a.mime, w: a.w, h: a.h, caption: "" })), null) });
          at += n;
        }
        return items;
      }

      /** The single insertion: images/groups (+ derived text) -> host.insert (atomic). On refusal nothing changed; pages stay. */
      async function scanCommit(derived) {
        const items = pageItems().concat(derived || []);
        const res = host.insert(items, scan.target);
        S.busy = false;
        if (!res || !res.ok) {
          const m = res && res.reason === "stale" ? MSG.stale : res && res.message ? res.message : MSG.refused;
          scan.sc = F.scanReduce(Object.assign({}, scan.sc, { state: "processing" }), { type: "fail", reason: "insert" });
          scanPrompt();
          say(m);
          host.status(m, true);
          refreshHud();
          return false;
        }
        const n = scan.pages.length;
        for (const p of scan.pages) await stash.del(p.stashId);
        scan.sc = F.scanReduce(Object.assign({}, scan.sc, { state: "processing" }), { type: "done" });
        for (const p of scan.pages) revoke(p.url);
        scan.pages = [];
        closeSheet("force", true);
        host.status(plural(n, "page insérée", "pages insérées") + (derived && derived.length ? " avec le texte" : ""));
        say(MSG.inserted);
        if (host.focusEditor) host.focusEditor();
        refreshHud();
        return true;
      }

      // ---------------------------------------------------------------- OCR
      function loadScript(src) {
        return new Promise((resolve, reject) => {
          const s = el("script", { src, "data-field-ocr": "" });
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("Moteur de reconnaissance indisponible"));
          doc.head.appendChild(s);
        });
      }

      async function tesseract() {
        if (win.Tesseract) return win.Tesseract;
        await loadScript(TESS.script);
        if (!win.Tesseract) throw new Error("Moteur de reconnaissance indisponible");
        return win.Tesseract;
      }

      /**
       * ONE worker at a time, pages strictly sequential, always terminated (success, failure or cancel). `onProgress(page, pct)`.
       * `jobs` = [{blob}] (<= 10). Resolves to the texts in order; rejects with name "Cancelled" when cancelled.
       */
      async function ocrRun(jobs, lang, onProgress) {
        if (S.ocr) throw new Error("Une reconnaissance est déjà en cours");
        const T = await tesseract();
        const run = { worker: null, cancelled: false, cancel: null };
        S.ocr = run;
        let page = 1;
        const cancelP = new Promise((_, rej) => {
          run.cancel = () => {
            run.cancelled = true;
            const e = new Error("Reconnaissance annulée");
            e.name = "Cancelled";
            rej(e);
          };
        });
        cancelP.catch(() => {});
        try {
          const wp = T.createWorker(lang, 1, {
            workerPath: TESS.worker,
            corePath: TESS.core,
            langPath: TESS.lang,
            workerBlobURL: false,
            gzip: true,
            cacheMethod: "none",
            logger: (m) => {
              if (m && m.status === "recognizing text" && typeof m.progress === "number") onProgress(page, Math.round(m.progress * 100));
            },
          });
          run.worker = await Promise.race([wp, cancelP]);
          const texts = [];
          for (let i = 0; i < jobs.length; i += 1) {
            page = i + 1;
            onProgress(page, 0);
            const r = await Promise.race([run.worker.recognize(jobs[i].blob), cancelP]);
            texts.push(r && r.data && typeof r.data.text === "string" ? r.data.text : "");
          }
          return texts;
        } finally {
          const w = run.worker;
          S.ocr = null;
          if (w) {
            try {
              await w.terminate();
            } catch (_) {
              /* already gone */
            }
          }
        }
      }

      function ocrCancel() {
        if (S.ocr && S.ocr.cancel) S.ocr.cancel();
      }

      /** Shared OCR panel body: language, a run button, progress, then one editable text per page with a count shown BEFORE insertion. */
      function ocrPanel(cfg) {
        // cfg: {jobs:[{blob, sourceId, label}], title, onInsert(chunksByPage), onSkip?, skipLabel?, insertLabel}
        const o = { st: F.ocrNew(cfg.jobs.length), lang: "fra", texts: [], areas: [] };
        const langSel = el("select", { class: "carnet-field-select", id: "hq-field-lang", "data-field-lang": "" });
        for (const l of OCR_LANGS) langSel.appendChild(el("option", { value: l.id, text: l.label }));
        langSel.addEventListener("change", () => {
          o.lang = langSel.value;
        });
        const status = el("p", { class: "carnet-field-text", role: "status", "aria-live": "polite", "data-field-ocr-status": "", text: F.ocrStatusText(o.st) });
        const bar = el("progress", { class: "carnet-field-progress", max: "100", value: "0", "aria-label": "Progression de la reconnaissance", hidden: true });
        const results = el("div", { class: "carnet-field-ocr-results" });
        const count = el("p", { class: "carnet-field-note", "data-field-ocr-count": "", role: "status", "aria-live": "polite" });

        const chunksNow = () => o.areas.map((a, i) => F.chunkOcrText(a.value));
        const planNow = () => {
          const per = chunksNow();
          const flat = [];
          per.forEach((c, i) => c.forEach((t) => flat.push(t)));
          return { per, flat, plan: F.planDerived("ocr", cfg.jobs[0].sourceId || "", flat, host.limits(), host.used(cfg.extraUsed || 0)) };
        };
        const refreshCount = () => {
          const { flat, plan } = planNow();
          if (!flat.length) count.textContent = "Aucun texte reconnu à insérer.";
          else if (!plan.ok) count.textContent = F.PLAN_MESSAGES[plan.reason] || "Insertion impossible";
          else count.textContent = plural(plan.count, "paragraphe sera inséré", "paragraphes seront insérés") + " (" + plan.chars + " caractères), chacun relié au scan d'origine.";
          insertBtn.disabled = !(plan && plan.ok);
          insertBtn.setAttribute("aria-disabled", insertBtn.disabled ? "true" : "false");
        };

        const insertBtn = btn(cfg.insertLabel || "Insérer le texte", "primary", () => {
          const { per, plan } = planNow();
          if (!plan.ok) return;
          cfg.onInsert(per);
        }, { "data-field-ocr-insert": "", disabled: true });
        const runBtn = btn("Lancer la reconnaissance", "primary", () => start(), { "data-field-ocr-run": "" });
        const cancelBtn = btn("Annuler la reconnaissance", "", () => {
          ocrCancel();
        }, { "data-field-ocr-cancel": "", hidden: true });

        const render = () => {
          const st = o.st.state;
          status.textContent = F.ocrStatusText(o.st);
          runBtn.hidden = st === "running" || st === "review";
          runBtn.textContent = st === "failed" || st === "cancelled" ? "Réessayer" : "Lancer la reconnaissance";
          cancelBtn.hidden = st !== "running";
          bar.hidden = st !== "running";
          langSel.disabled = st === "running";
          if (st === "refused") runBtn.disabled = true;
        };

        const start = async () => {
          if (o.st.state === "failed" || o.st.state === "cancelled") o.st = F.ocrReduce(o.st, { type: "retry" });
          o.st = F.ocrReduce(o.st, { type: "start" });
          render();
          S.busy = true;
          refreshHud();
          say("Reconnaissance du texte : page 1 sur " + cfg.jobs.length);
          let lastSaid = 0;
          try {
            const texts = await ocrRun(cfg.jobs, o.lang, (pg, pct) => {
              status.textContent = F.ocrStatusText(Object.assign({}, o.st, { page: pg }));
              bar.value = pct;
              if (pg !== lastSaid) {
                lastSaid = pg;
                say("Reconnaissance du texte : page " + pg + " sur " + cfg.jobs.length);
              }
            });
            texts.forEach((t) => {
              o.st = F.ocrReduce(o.st, { type: "page-done", text: t });
            });
            o.texts = texts;
            results.textContent = "";
            o.areas = [];
            texts.forEach((t, i) => {
              const id = "hq-field-ocr-" + i;
              const ta = el("textarea", { class: "carnet-field-textarea", id, rows: "6", maxlength: String(L.ocrBlockChars * L.ocrBlocksMax), spellcheck: "false", "data-field-ocr-text": String(i + 1) });
              ta.value = F.cleanOcrText(t);
              ta.addEventListener("input", refreshCount);
              o.areas.push(ta);
              results.appendChild(el("label", { class: "carnet-field-label", for: id, text: cfg.jobs.length > 1 ? "Texte de la page " + (i + 1) : "Texte reconnu (à relire)" }));
              results.appendChild(ta);
            });
            refreshCount();
            render();
            say(texts.every((t) => !F.cleanOcrText(t)) ? "Aucun texte reconnu" : "Texte reconnu : relisez-le avant de l'insérer");
            if (o.areas[0]) o.areas[0].focus({ preventScroll: true });
          } catch (err) {
            if (err && err.name === "Cancelled") o.st = F.ocrReduce(o.st, { type: "cancel" });
            else o.st = F.ocrReduce(o.st, { type: "fail", reason: "engine" });
            render();
            say(F.ocrStatusText(o.st));
            if (!(err && err.name === "Cancelled")) host.status(F.ocrStatusText(o.st) + " : le scan reste intact", true);
          } finally {
            S.busy = false;
            refreshHud();
          }
        };
        const nodes = [
          para(cfg.intro || "La reconnaissance se fait sur cet appareil et dans ce navigateur : rien n'est envoyé ailleurs.", "carnet-field-note"),
          el("label", { class: "carnet-field-label", for: "hq-field-lang", text: "Langue du document" }),
          langSel, status, bar, results, count,
        ];
        const foot = [];
        foot.push(btn("Fermer", "quiet", () => closeSheet("user"), { "data-field-cancel": "" }));
        if (cfg.onSkip) foot.push(btn(cfg.skipLabel || "Insérer sans texte", "", () => cfg.onSkip(), { "data-field-ocr-skip": "" }));
        foot.push(cancelBtn, runBtn, insertBtn);
        render();
        return { nodes, foot, destroy: () => ocrCancel() };
      }

      function derivedItems(per, jobs) {
        const items = [];
        per.forEach((chunks, i) => {
          if (chunks.length) items.push({ type: "derived", from: host.rich.fromOf("ocr", jobs[i].sourceId), chunks });
        });
        return items;
      }

      /** OCR step of the scanner: pages are already uploaded (their ids are the provenance sources). */
      function scanOcrStep() {
        const jobs = scan.pages.map((p) => ({ blob: p.blob, sourceId: p.asset.id }));
        const panel = ocrPanel({
          jobs,
          intro: "Les pages sont téléversées mais pas encore insérées. Lancez la reconnaissance du texte, relisez-la, puis insérez les pages avec leur texte.",
          insertLabel: "Insérer pages et texte",
          skipLabel: "Insérer sans texte",
          onSkip: () => {
            panel.destroy();
            scanCommit(null);
          },
          onInsert: (per) => {
            panel.destroy();
            scanCommit(derivedItems(per, jobs));
          },
          extraUsed: scan.pages.length,
        });
        const sh = S.sheet;
        sh.title.textContent = "Texte du document";
        sh.onClose = () => {
          if (S.ocr) {
            ocrCancel();
            return false;
          }
          scanRelease();
          return true;
        };
        setBody(panel.nodes);
        setFoot(panel.foot);
        sheetFocusTitle();
      }

      /** OCR of an image already in the page (selected image block, or a child of an image group). */
      function openOcr(opener, source) {
        if (!host.editable()) return host.status(MSG.readonly, true);
        if (S.sheet || S.busy) return host.status("Une capture est déjà en cours", true);
        const src = source || host.selectedImage();
        if (!src || !src.asset) return host.status("Sélectionnez d'abord une image de la page", true);
        const target = host.afterTarget(src.blockId);
        const sh = openSheet({ title: "Texte d'une image", name: "ocr", opener, onClose: () => (S.ocr ? (ocrCancel(), false) : true) });
        const jobs = [{ sourceId: src.asset.id, blob: null }];
        const thumb = el("img", { class: "carnet-field-thumb carnet-field-thumb-wide", src: ASSET_URL + src.asset.id, alt: "Image dont le texte sera lu", width: "120", height: "120" });
        const loading = para("Chargement de l'image…", "carnet-field-note");
        setBody([thumb, loading]);
        setFoot([btn("Fermer", "quiet", () => closeSheet("user"), { "data-field-cancel": "" })]);
        fetchBlob(ASSET_URL + src.asset.id).then((blob) => {
          if (S.sheet !== sh) return;
          jobs[0].blob = blob;
          const panel = ocrPanel({
            jobs,
            insertLabel: "Insérer le texte sous l'image",
            onInsert: (per) => {
              const items = derivedItems(per, jobs);
              const res = host.insert(items, target);
              if (!res || !res.ok) {
                const m = res && res.reason === "stale" ? MSG.stale : res && res.message ? res.message : MSG.refused;
                say(m);
                host.status(m, true);
                return;
              }
              panel.destroy();
              closeSheet("force", true);
              host.status("Texte inséré, relié à l'image d'origine");
              if (host.focusEditor) host.focusEditor();
            },
          });
          setBody([thumb].concat(panel.nodes));
          setFoot(panel.foot);
        }).catch(() => {
          if (S.sheet !== sh) return;
          loading.textContent = "Image indisponible";
          loading.setAttribute("role", "alert");
        });
      }

      async function fetchBlob(url) {
        const r = await win.fetch(url, { credentials: "same-origin" });
        if (!r.ok) throw new Error("Fichier indisponible");
        return r.blob();
      }

      // ---------------------------------------------------------------- voice
      function openVoice(opener) {
        if (!host.editable()) return host.status(MSG.readonly, true);
        if (S.sheet || S.busy) return host.status("Une capture est déjà en cours", true);
        const target = host.captureTarget();
        if (!target) return host.status(MSG.readonly, true);
        const v = { st: F.recNew(), target, blob: null, url: "", stashId: "", t0: 0, wall: 0, recorder: null, stream: null, timer: 0, chunks: [], mime: "", saved: false, confirm: false };
        S.rec = v;
        openSheet({ title: "Note vocale", name: "voice", opener, onClose: () => voiceClose(v) });
        voiceRender(v);
        refreshHud();
      }

      function voiceClose(v) {
        if (v.st.state === "uploading") {
          say("Enregistrement en cours : patientez");
          return false;
        }
        if ((v.st.state === "recording" || (v.st.state === "stopped" && !v.saved)) && !v.confirm) {
          v.confirm = true;
          const m = v.st.state === "recording" ? "L'enregistrement en cours sera arrêté et gardé en réserve. Fermer à nouveau pour quitter." : "L'enregistrement reste récupérable. Fermer à nouveau pour quitter.";
          say(m);
          host.status(m);
          win.setTimeout(() => {
            v.confirm = false;
          }, 4000);
          return false;
        }
        voiceStopTracks(v);
        if (v.st.state === "recording") {
          // recorded audio so far is stashed by the recorder's stop handler (recoverable); nothing is kept in a hidden recorder
          voiceStop(v, "close");
        }
        revoke(v.url);
        if (S.rec === v) S.rec = null;
        refreshHud();
        return true;
      }

      function voiceStopTracks(v) {
        if (v.timer) {
          win.clearInterval(v.timer);
          v.timer = 0;
        }
        if (v.stream) {
          for (const t of v.stream.getTracks()) {
            try {
              t.stop();
            } catch (_) {
              /* ignore */
            }
          }
          v.stream = null;
        }
      }

      async function voiceStart(v) {
        const nav = win.navigator;
        if (!win.MediaRecorder || !nav || !nav.mediaDevices || !nav.mediaDevices.getUserMedia) {
          v.st = F.recReduce(F.recReduce(v.st, { type: "request" }), { type: "unavailable", reason: "api" });
          return voiceRender(v);
        }
        v.st = F.recReduce(v.st, { type: "request" });
        voiceRender(v);
        say(F.recStatusText(v.st));
        let stream;
        try {
          stream = await nav.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        } catch (err) {
          const name = err && err.name;
          if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") v.st = F.recReduce(v.st, { type: "denied" });
          else v.st = F.recReduce(v.st, { type: "unavailable", reason: name || "device" });
          voiceRender(v);
          say(F.recStatusText(v.st));
          return;
        }
        if (S.rec !== v || !S.sheet) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        const mime = F.pickVoiceType((t) => win.MediaRecorder.isTypeSupported(t));
        if (!mime) {
          for (const t of stream.getTracks()) t.stop();
          v.st = F.recReduce(v.st, { type: "unavailable", reason: "format" });
          voiceRender(v);
          say(F.recStatusText(v.st));
          return;
        }
        let rec;
        try {
          rec = new win.MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: L.voiceBitrate });
        } catch (_) {
          for (const t of stream.getTracks()) t.stop();
          v.st = F.recReduce(v.st, { type: "unavailable", reason: "recorder" });
          voiceRender(v);
          return;
        }
        v.stream = stream;
        v.recorder = rec;
        v.mime = mime;
        v.chunks = [];
        let bytes = 0;
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size) {
            v.chunks.push(e.data);
            bytes += e.data.size;
          }
        };
        rec.onstop = () => voiceFinalize(v);
        rec.onerror = () => {
          v.st = F.recReduce(v.st, { type: "fail", reason: "recorder" });
          voiceStopTracks(v);
          voiceRender(v);
        };
        v.st = F.recReduce(v.st, { type: "granted", mime });
        v.t0 = win.performance.now();
        v.wall = nowMs();
        rec.start(1000);
        v.timer = win.setInterval(() => {
          const ms = Math.round(win.performance.now() - v.t0);
          v.st = F.recReduce(v.st, { type: "tick", ms, bytes });
          const why = F.recShouldStop(v.st);
          voiceTime(v);
          if (why) voiceStop(v, why);
        }, 250);
        voiceRender(v);
        say(F.recStatusText(v.st));
      }

      function voiceTime(v) {
        const t = S.sheet && S.sheet.body.querySelector("[data-field-time]");
        if (t) t.textContent = F.fmtElapsed(v.st.ms);
        // announce once per 30 s so a screen reader user knows the recording still runs, without chatter
        const step = Math.floor(v.st.ms / 30000);
        if (step > (v.announced || 0)) {
          v.announced = step;
          say(F.recStatusText(v.st));
        }
      }

      function voiceStop(v, reason) {
        if (v.st.state !== "recording") return;
        const ms = Math.round(win.performance.now() - v.t0);
        v.st = F.recReduce(v.st, { type: "tick", ms, bytes: v.st.bytes });
        v.st = F.recReduce(v.st, { type: "stop", reason: reason === "limit" || reason === "size" ? reason : "" });
        if (v.timer) {
          win.clearInterval(v.timer);
          v.timer = 0;
        }
        try {
          if (v.recorder && v.recorder.state !== "inactive") v.recorder.stop();
        } catch (_) {
          voiceFinalize(v);
        }
        for (const t of v.stream ? v.stream.getTracks() : []) {
          try {
            t.stop(); // the microphone is released the moment recording stops
          } catch (_) {
            /* ignore */
          }
        }
        v.stream = null;
      }

      async function voiceFinalize(v) {
        const base = v.mime.split(";")[0];
        const blob = new win.Blob(v.chunks, { type: base });
        v.chunks = [];
        if (!blob.size) {
          v.st = F.recReduce(F.recNew(), { type: "request" });
          v.st = F.recReduce(v.st, { type: "unavailable", reason: "empty" });
          if (S.sheet) voiceRender(v);
          return;
        }
        v.blob = blob;
        v.dur = Math.max(1, Math.min(L.voiceMsMax, v.st.ms));
        v.url = objectUrl(blob);
        v.stashId = newId("cap");
        const r = await stashCapture({ id: v.stashId, kind: "voice", bytes: blob.size, at: nowMs(), meta: { dur_ms: v.dur, recorded_at: new Date(v.wall).toISOString().slice(0, 19) + "Z", mime: base }, blob });
        v.stashed = r.ok && !r.volatile;
        if (S.sheet && S.rec === v) {
          voiceRender(v);
          say(F.recStatusText(v.st));
        }
      }

      function voiceRender(v) {
        if (!S.sheet || S.rec !== v) return;
        const st = v.st;
        const nodes = [];
        const status = el("p", { class: "carnet-field-text", "data-field-rec-status": "", text: F.recStatusText(st) });
        nodes.push(status);
        const time = el("p", { class: "carnet-field-time", role: "timer", "aria-label": "Durée écoulée", "data-field-time": "", text: F.fmtElapsed(st.ms) });
        if (st.state === "recording" || st.state === "stopped" || st.state === "uploading") nodes.push(time);
        if (st.state === "recording") nodes.push(el("p", { class: "carnet-field-recdot", "data-field-recording": "", text: "● Enregistrement" }));
        if (st.state === "stopped" || st.state === "uploading") {
          const audio = el("audio", { class: "carnet-field-audio", controls: true, src: v.url, preload: "metadata", "aria-label": "Réécouter l'enregistrement", "data-field-playback": "" });
          nodes.push(audio);
          nodes.push(para(Math.round(v.blob.size / 1024) + " Ko" + (v.stashed ? " · gardé en réserve sur cet appareil" : ""), "carnet-field-note"));
        }
        if (st.state === "denied") nodes.push(para("Autorisez le microphone pour ce site dans les réglages du navigateur, puis appuyez sur Réessayer.", "carnet-field-note"));
        if (st.error) nodes.push(para(st.error === "offline" ? MSG.offline : "Enregistrement impossible : " + st.error, "carnet-field-warn", { role: "alert" }));
        setBody(nodes);
        const foot = [];
        if (st.state === "idle") {
          foot.push(btn("Annuler", "quiet", () => closeSheet("user"), { "data-field-cancel": "" }));
          foot.push(btn("Enregistrer", "primary carnet-field-rec", () => voiceStart(v), { "data-field-record": "" }));
        } else if (st.state === "requesting") {
          foot.push(btn("Annuler", "quiet", () => closeSheet("user"), { "data-field-cancel": "" }));
        } else if (st.state === "recording") {
          foot.push(btn("Arrêter", "primary", () => voiceStop(v, ""), { "data-field-stop": "", "aria-label": "Arrêter l'enregistrement" }));
        } else if (st.state === "stopped") {
          foot.push(btn("Supprimer", "quiet", () => voiceDiscard(v), { "data-field-discard": "" }));
          foot.push(btn("Réenregistrer", "", () => voiceAgain(v), { "data-field-again": "" }));
          foot.push(btn("Insérer la note", "primary", () => voiceKeep(v), { "data-field-keep": "" }));
        } else if (st.state === "uploading") {
          foot.push(btn("Envoi…", "primary", null, { disabled: true }));
        } else {
          foot.push(btn("Fermer", "quiet", () => closeSheet("user"), { "data-field-cancel": "" }));
          if (st.state === "denied" || st.state === "failed") foot.push(btn("Réessayer", "primary", () => {
            v.st = F.recNew();
            voiceStart(v);
          }, { "data-field-retry": "" }));
        }
        setFoot(foot);
        const f = S.sheet.foot.querySelector("button.primary") || S.sheet.title;
        f.focus({ preventScroll: true });
      }

      async function voiceDiscard(v) {
        voiceStopTracks(v);
        revoke(v.url);
        if (v.stashId) await stash.del(v.stashId);
        v.st = F.recNew();
        v.blob = null;
        v.url = "";
        v.stashId = "";
        v.saved = false;
        voiceRender(v);
        say("Enregistrement supprimé");
      }

      async function voiceAgain(v) {
        await voiceDiscard(v);
        voiceStart(v);
      }

      /** Upload (same-origin, raw body) then insert ONE voice block. A failure keeps the recording (stash + sheet) for a retry. */
      async function voiceKeep(v) {
        if (v.st.state !== "stopped") return;
        if (!online()) {
          v.st = Object.assign({}, v.st, { error: "offline" });
          voiceRender(v);
          say(MSG.offline);
          return;
        }
        v.st = Object.assign(F.recReduce(v.st, { type: "upload" }), { error: "" });
        S.busy = true;
        voiceRender(v);
        let a = null;
        if (v.uploaded) {
          const known = await assetState("voice", v.uploaded.id); // retry after a failed insertion: reuse the SAME asset
          if (known === "unknown") {
            S.busy = false;
            v.st = Object.assign(F.recReduce(v.st, { type: "fail", reason: "verify" }), { error: UNVERIFIED });
            voiceRender(v);
            say(UNVERIFIED);
            return;
          }
          a = known === "exists" ? v.uploaded : null;
        }
        if (!a) {
          v.uploaded = null;
          let res;
          try {
            res = await host.api("/api/carnet/voice", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Carnet-Mime": v.blob.type }, body: v.blob, timeoutMs: 180000 });
          } catch (err) {
            S.busy = false;
            v.st = Object.assign(F.recReduce(v.st, { type: "fail", reason: "upload" }), { error: describe(err) });
            voiceRender(v);
            say(v.st.error);
            return;
          }
          const got = res && res.voice;
          if (!got || typeof got.id !== "string") {
            S.busy = false;
            v.st = Object.assign(F.recReduce(v.st, { type: "fail", reason: "bad" }), { error: "Réponse du serveur invalide" });
            voiceRender(v);
            return;
          }
          a = { id: got.id, mime: got.mime };
          v.uploaded = a;
          await stash.mark(v.stashId, a);
        }
        S.busy = false;
        const payload = { id: a.id, mime: a.mime, dur_ms: v.dur, recorded_at: new Date(v.wall).toISOString().slice(0, 19) + "Z" };
        const ins = host.insert([{ type: "voice", payload }], v.target);
        if (!ins || !ins.ok) {
          const m = ins && ins.reason === "stale" ? MSG.stale : ins && ins.message ? ins.message : MSG.refused;
          v.st = Object.assign(F.recReduce(v.st, { type: "fail", reason: "insert" }), { error: m });
          voiceRender(v);
          say(m + " L'enregistrement est déjà envoyé : il restera sans usage sur le serveur si vous abandonnez.");
          return;
        }
        v.saved = true;
        if (v.stashId) await stash.del(v.stashId);
        revoke(v.url);
        v.st = F.recReduce(v.st, { type: "uploaded" });
        closeSheet("force", true);
        S.rec = null;
        host.status("Note vocale insérée");
        say(F.recStatusText({ state: "done" }));
        if (host.focusEditor) host.focusEditor();
        refreshHud();
      }

      // ---------------------------------------------------------------- voice block card (rendered by the structured UI)
      /** The editor card of a voice block: a native player over the immutable voice asset, its text label and a Transcrire action. */
      function renderVoice(wrapper, payload, idx, box, readOnly) {
        const label = host.rich.Struct.voiceLabel(payload).slice(1, -1);
        const when = host.rich.localStampLabel(payload.recorded_at);
        const card = el("figure", { class: "carnet-voice", "data-voice-mime": payload.mime });
        card.appendChild(el("figcaption", { class: "carnet-voice-cap" }, [el("span", { class: "carnet-voice-label", text: label }), el("span", { class: "carnet-voice-when", text: when ? " · " + when : "" })]));
        const audio = el("audio", { class: "carnet-voice-audio", controls: true, preload: "none", src: VOICE_URL + payload.id, "aria-label": label + (when ? ", enregistrée le " + when : "") });
        const gone = el("p", { class: "carnet-field-warn", role: "alert", hidden: true, text: "Note vocale indisponible" });
        audio.addEventListener("error", () => {
          gone.hidden = false;
        });
        card.append(audio, gone);
        if (!readOnly) {
          const bar = el("div", { class: "carnet-struct-bar carnet-voice-bar", role: "toolbar", "aria-label": label });
          bar.appendChild(btn("Transcrire", "", () => openTranscript(bar.querySelector("button"), wrapper, payload), { "data-voice-transcribe": "", "aria-label": "Transcrire " + label }));
          card.appendChild(bar);
        }
        box.appendChild(card);
      }

      // ---------------------------------------------------------------- transcript panel
      async function wavOf(blob) {
        const AC = win.AudioContext || win.webkitAudioContext;
        const OAC = win.OfflineAudioContext || win.webkitOfflineAudioContext;
        if (!AC || !OAC) throw new Error("Décodage audio indisponible");
        const ac = new AC();
        let buf;
        try {
          buf = await ac.decodeAudioData(await blob.arrayBuffer());
        } finally {
          if (ac.close) ac.close();
        }
        const len = Math.max(1, Math.ceil(buf.duration * 16000));
        const off = new OAC(1, len, 16000);
        const s = off.createBufferSource();
        s.buffer = buf;
        s.connect(off.destination);
        s.start();
        const out = await off.startRendering();
        return new win.Blob([F.encodeWav(out.getChannelData(0), 16000)], { type: "audio/wav" });
      }

      function openTranscript(opener, wrapper, payload) {
        if (!host.editable()) return host.status(MSG.readonly, true);
        if (S.sheet || S.busy) return host.status("Une capture est déjà en cours", true);
        const blockId = wrapper ? wrapper.getAttribute("data-carnet-block-id") || "" : "";
        const target = host.afterTarget(blockId);
        const t = { st: F.trNew(), abort: false };
        const sh = openSheet({ title: "Transcription", name: "transcript", opener, onClose: () => (t.st.state === "preparing" || t.st.state === "running" ? (t.abort = true, say("Transcription annulée"), true) : true) });
        const status = el("p", { class: "carnet-field-text", role: "status", "aria-live": "polite", "data-field-tr-status": "" });
        const area = el("textarea", { class: "carnet-field-textarea", id: "hq-field-tr", rows: "8", maxlength: String(L.transcriptCharsMax), "data-field-tr-text": "", hidden: true });
        const lab = el("label", { class: "carnet-field-label", for: "hq-field-tr", text: "Transcription (modifiable)", hidden: true });
        const count = el("p", { class: "carnet-field-note", role: "status", "aria-live": "polite", "data-field-tr-count": "", hidden: true });
        const run = btn("Lancer la transcription", "primary", () => go(), { "data-field-tr-run": "" });
        const later = btn("Traiter plus tard", "", () => {
          t.st = F.trReduce(t.st, { type: "defer" });
          paint();
          say(F.trStatusText(t.st));
        }, { "data-field-tr-later": "" });
        const ins = btn("Insérer la transcription", "primary", () => insert(), { "data-field-tr-insert": "", hidden: true });
        const cancel = btn("Annuler", "quiet", () => {
          if (t.st.state === "preparing" || t.st.state === "running") {
            t.abort = true;
            t.st = F.trReduce(t.st, { type: "cancel" });
            paint();
            say("Transcription annulée");
          } else closeSheet("user");
        }, { "data-field-cancel": "" });
        const note = para("La transcription est un texte dérivé : la note vocale reste le document d'origine, jamais modifiée. Elle se fait avec le moteur local configuré sur votre serveur, sans service externe.", "carnet-field-note");
        setBody([note, status, lab, area, count]);
        setFoot([cancel, later, run, ins]);

        const planNow = () => {
          const chunks = F.chunkTranscript(area.value);
          return { chunks, plan: F.planDerived("transcript", payload.id, chunks, host.limits(), host.used(0)) };
        };
        const refresh = () => {
          const { chunks, plan } = planNow();
          count.hidden = !chunks.length;
          count.textContent = !chunks.length ? "" : plan.ok ? plural(plan.count, "paragraphe sera inséré", "paragraphes seront insérés") + " (" + plan.chars + " caractères), reliés à la note vocale." : F.PLAN_MESSAGES[plan.reason];
          ins.disabled = !plan.ok;
        };
        area.addEventListener("input", () => {
          t.st = F.trReduce(t.st, { type: "edit", text: area.value });
          refresh();
        });
        function paint() {
          const s = t.st.state;
          status.textContent = F.trStatusText(t.st) + (s === "failed" && t.st.error ? " : " + t.st.error : "");
          const busy = s === "preparing" || s === "running";
          run.hidden = busy || s === "editing";
          run.textContent = s === "failed" ? "Réessayer" : "Lancer la transcription";
          later.hidden = busy || s === "editing" || s === "deferred";
          area.hidden = lab.hidden = s !== "editing";
          ins.hidden = s !== "editing";
          if (s === "editing") {
            area.value = t.st.text;
            refresh();
          }
          S.busy = busy;
          refreshHud();
        }
        paint();

        async function go() {
          t.abort = false;
          t.st = F.trReduce(t.st, { type: "start" });
          paint();
          say("Préparation de l'audio");
          try {
            const stat = await host.api("/api/carnet/transcribe", { timeoutMs: 8000 });
            if (t.abort || S.sheet !== sh) return;
            if (!stat || !stat.configured) {
              t.st = F.trReduce(t.st, { type: "unconfigured" });
              paint();
              say(F.trStatusText(t.st));
              return;
            }
            const blob = await fetchBlob(VOICE_URL + payload.id);
            const wav = await wavOf(blob);
            if (t.abort || S.sheet !== sh) return;
            t.st = F.trReduce(t.st, { type: "running" });
            paint();
            say(F.trStatusText(t.st));
            const res = await host.api(VOICE_URL + payload.id + "/transcribe", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: wav, timeoutMs: 15 * 60 * 1000 });
            if (t.abort || S.sheet !== sh) return;
            t.st = F.trReduce(t.st, { type: "done", text: res && typeof res.text === "string" ? res.text : "" });
            paint();
            say(F.trStatusText(t.st));
            area.focus({ preventScroll: true });
          } catch (err) {
            if (t.abort || S.sheet !== sh) return;
            if (err && err.data && err.data.code === "transcribe_unconfigured") t.st = F.trReduce(t.st, { type: "unconfigured" });
            else t.st = F.trReduce(t.st, { type: "fail", reason: describe(err) });
            paint();
            say(F.trStatusText(t.st));
          }
        }

        function insert() {
          const { chunks, plan } = planNow();
          if (!plan.ok) return;
          const res = host.insert([{ type: "derived", from: host.rich.fromOf("transcript", payload.id), chunks }], target);
          if (!res || !res.ok) {
            const m = res && res.reason === "stale" ? MSG.stale : res && res.message ? res.message : MSG.refused;
            say(m);
            host.status(m, true);
            return;
          }
          closeSheet("force", true);
          host.status("Transcription insérée, reliée à la note vocale");
          if (host.focusEditor) host.focusEditor();
        }
      }

      // ---------------------------------------------------------------- source viewer (provenance badge -> the scan / the audio)
      function openSource(kind, id, opener) {
        if (S.sheet) return;
        openSheet({ title: kind === "ocr" ? "Scan d'origine" : "Note vocale d'origine", name: "source", opener });
        const nodes = [];
        if (kind === "ocr") nodes.push(el("img", { class: "carnet-field-source-img", src: ASSET_URL + id, alt: "Scan dont le texte a été extrait" }));
        else nodes.push(el("audio", { class: "carnet-field-audio", controls: true, preload: "metadata", src: VOICE_URL + id, "aria-label": "Note vocale d'origine" }));
        nodes.push(para("Document d'origine, conservé tel quel. Le texte de la page en est dérivé.", "carnet-field-note"));
        setBody(nodes);
        setFoot([btn("Fermer", "primary", () => closeSheet("user"), { "data-field-cancel": "" })]);
      }

      // ---------------------------------------------------------------- recovery of uncommitted captures
      async function recover(parent) {
        const items = await stash.prune();
        const live = items.filter((i) => i && i.blob);
        if (!S.banner && parent) {
          S.banner = el("div", { class: "carnet-field-recover carnet-banner", role: "status", "aria-live": "polite", hidden: true, "data-field-recover": "" });
          parent.insertBefore(S.banner, parent.firstChild);
        }
        if (!S.banner) return live.length;
        S.banner.textContent = "";
        if (!live.length) {
          S.banner.hidden = true;
          return 0;
        }
        const sessions = new Set(live.filter((i) => i.kind === "scan").map((i) => i.meta && i.meta.session));
        const voices = live.filter((i) => i.kind === "voice").length;
        const parts = [];
        if (sessions.size) parts.push(plural(live.filter((i) => i.kind === "scan").length, "page numérisée", "pages numérisées"));
        if (voices) parts.push(plural(voices, "note vocale", "notes vocales"));
        S.banner.appendChild(el("p", { class: "carnet-banner-msg", text: "Capture non enregistrée récupérable : " + parts.join(", ") + "." }));
        S.banner.appendChild(btn("Voir", "secondary", (e) => openRecovery(e.currentTarget), { "data-field-recover-open": "" }));
        S.banner.hidden = false;
        return live.length;
      }

      async function openRecovery(opener) {
        if (S.sheet || S.busy) return;
        const items = (await stash.prune()).filter((i) => i && i.blob);
        openSheet({ title: "Captures en attente", name: "recovery", opener });
        const render = async () => {
          const list = (await stash.prune()).filter((i) => i && i.blob);
          const nodes = [para("Ces captures n'ont pas été insérées dans une page. Elles restent sur cet appareil, au plus 24 heures, puis sont effacées. Aucune synchronisation.", "carnet-field-note")];
          const ul = el("ul", { class: "carnet-field-pages", "aria-label": "Captures en attente" });
          for (const it of list) {
            const li = el("li", { class: "carnet-field-page", "data-recover-kind": it.kind });
            if (it.kind === "scan") {
              const u = objectUrl(it.blob);
              li.appendChild(el("img", { class: "carnet-field-thumb", src: u, alt: "Page numérisée en attente", width: "56", height: "72" }));
              li.appendChild(el("span", { class: "carnet-field-page-name", text: "Page numérisée · " + Math.round(it.bytes / 1024) + " Ko" }));
            } else {
              const u = objectUrl(it.blob);
              li.appendChild(el("audio", { class: "carnet-field-audio", controls: true, src: u, preload: "metadata", "aria-label": "Note vocale en attente" }));
              li.appendChild(el("span", { class: "carnet-field-page-name", text: "Note vocale · " + F.fmtElapsed((it.meta && it.meta.dur_ms) || 0) }));
            }
            const acts = el("span", { class: "carnet-field-page-actions" });
            acts.appendChild(btn("Insérer", "", () => recoverInsert(it), { "data-recover-insert": "", "aria-label": it.kind === "scan" ? "Insérer cette page dans la page ouverte" : "Insérer cette note vocale dans la page ouverte" }));
            acts.appendChild(btn("Supprimer", "quiet", async () => {
              await stash.del(it.id);
              say("Capture supprimée");
              render();
              recover();
            }, { "data-recover-delete": "", "aria-label": "Supprimer cette capture en attente" }));
            li.appendChild(acts);
            ul.appendChild(li);
          }
          if (!list.length) nodes.push(para("Aucune capture en attente."));
          else nodes.push(ul);
          setBody(nodes);
          setFoot([btn("Fermer", "primary", () => closeSheet("user"), { "data-field-cancel": "" })]);
        };
        await render();
        void items;
      }

      async function recoverInsert(it) {
        if (!host.editable()) return say(MSG.readonly);
        if (!online()) return say(MSG.offline);
        const target = host.captureTarget();
        if (!target) return say(MSG.readonly);
        S.busy = true;
        try {
          if (it.kind === "scan") {
            let a = null;
            if (it.uploaded) {
              const known = await assetState("asset", it.uploaded.id);
              if (known === "unknown") throw new Error(UNVERIFIED);
              a = known === "exists" ? it.uploaded : null;
            }
            if (!a) {
              a = await host.media.upload(it.blob, host.api);
              await stash.mark(it.id, a);
              it.uploaded = { id: a.id, mime: a.mime, w: a.w, h: a.h };
            }
            const res = host.insert([{ type: "image", asset: { id: a.id, mime: a.mime, w: a.w, h: a.h, width: 100, layout: "inline", caption: "" } }], target);
            if (!res || !res.ok) throw new Error(res && res.message ? res.message : MSG.refused);
          } else {
            let v = null;
            if (it.uploaded) {
              const known = await assetState("voice", it.uploaded.id);
              if (known === "unknown") throw new Error(UNVERIFIED);
              v = known === "exists" ? it.uploaded : null;
            }
            if (!v) {
              const a = await host.api("/api/carnet/voice", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Carnet-Mime": it.blob.type || (it.meta && it.meta.mime) }, body: it.blob, timeoutMs: 180000 });
              v = a && a.voice;
              if (!v) throw new Error("Réponse du serveur invalide");
              await stash.mark(it.id, v);
              it.uploaded = { id: v.id, mime: v.mime };
            }
            const meta = it.meta || {};
            const res = host.insert([{ type: "voice", payload: { id: v.id, mime: v.mime, dur_ms: Math.max(1, meta.dur_ms | 0), recorded_at: meta.recorded_at } }], target);
            if (!res || !res.ok) throw new Error(res && res.message ? res.message : MSG.refused);
          }
          await stash.del(it.id);
          closeSheet("force", true);
          host.status("Capture insérée");
          recover();
        } catch (err) {
          const m = describe(err);
          say(m);
          host.status(m, true);
        } finally {
          S.busy = false;
          refreshHud();
        }
      }

      // ---------------------------------------------------------------- lifecycle
      function abort() {
        ocrCancel();
        const v = S.rec;
        if (v) voiceStopTracks(v);
        S.rec = null;
        if (S.sheet) closeSheet("force", true);
        if (scan.previewTimer) win.clearTimeout(scan.previewTimer);
        revokeAll();
        S.busy = false;
        if (S.vv) {
          S.vv.vv.removeEventListener("resize", S.vv.onVv);
          S.vv.vv.removeEventListener("scroll", S.vv.onVv);
          S.vv = null;
        }
        if (S.hud) S.hud.bar.remove();
        if (S.banner) S.banner.remove();
        S.hud = null;
        S.banner = null;
      }

      win.addEventListener("online", () => {
        if (S.sheet) say("Connexion rétablie : vous pouvez reprendre l'envoi");
      });

      return {
        mountHud, refreshHud, openScanner, openVoice, openOcr, openTranscript, openSource, openRecovery, recover, renderVoice, abort,
        busy: () => S.busy || !!S.sheet,
        _state: S,
        _stash: stash,
      };
    }

    return { mount };
  }

  /** Same contract as the other Carnet UI modules: `mount(host)`; `host.win` defaults to the global window. */
  function mount(host) {
    return create((host && host.win) || global).mount(host);
  }

  return { mount, create, SVG_NS };
});
