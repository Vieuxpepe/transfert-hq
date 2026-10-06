/* Transfert HQ — Carnet Phase 10: live annotations panel (DOM). Used by the Reader.
 *
 * Commentary stays commentary: this panel lists, adds, edits, resolves, reopens and deletes ANNOTATIONS only. It never touches the
 * evidence it is attached to, and it labels itself as CURRENT (never frozen) wherever the evidence on screen is a frozen copy.
 *
 *   - ONE batched read (annotation_list) for every target shown; never a request per annotation.
 *   - Every body is rendered with textContent: a hostile "<script>" is text.
 *   - A stale edit / delete (409) reloads the server version, KEEPS the typed text in the box and never retries on its own.
 *   - A create retried after a lost answer reuses the SAME request id (so it cannot duplicate); a changed text gets a new one.
 * Plain ES2020.
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqCarnetAnnotationsUi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  const node = typeof module === "object" && module && module.exports;
  const A = node ? require("./hq-carnet-annotations.js") : global.HqCarnetAnnotations;
  const MSG = A.MSG;

  function el(doc, tag, attrs, kids) {
    const n = doc.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (attrs[k] === null || attrs[k] === undefined || attrs[k] === false) continue;
        if (k === "text") n.textContent = attrs[k];
        else n.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
      }
    }
    if (kids) for (const c of kids) if (c) n.appendChild(c);
    return n;
  }

  function fmt(ts) {
    if (!Number.isFinite(ts)) return "";
    try {
      return new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
    } catch (_) {
      return "";
    }
  }

  function mount(host) {
    const doc = host.doc;
    const online = () => (typeof host.online === "function" ? !!host.online() : true);
    const rid = () => A.newRequestId(host.crypto || (doc.defaultView && doc.defaultView.crypto));

    /**
     * spec: {id, targets:[{key,label,target}], defaultKey, frozen, evidenceLabel, getPage():number|null, getAnchor():{loc,pdf}|null,
     *        onView(result|row)?, say(text)?}
     * `target` is what the server needs to LOCATE the evidence (a source id, or page/block + the citation as seen). Returns {node, reload, destroy}.
     */
    function panel(spec) {
      const st = {
        results: new Map(), loading: true, failed: false, truncated: false, busy: false, notice: "", error: "",
        expanded: false, draft: "", choice: spec.defaultKey, attachPage: false, pending: null, editing: null, editDraft: "", confirm: null, stale: false, alive: true,
      };
      const root = el(doc, "section", { class: "carnet-ann", id: spec.id || "hq-carnet-ann", "aria-labelledby": (spec.id || "hq-carnet-ann") + "-h", "data-frozen": spec.frozen ? "1" : "0" });
      let token = 0;

      const say = (t) => {
        if (typeof spec.say === "function") spec.say(t);
      };

      async function load() {
        const mine = ++token;
        st.loading = true;
        st.failed = false;
        paint();
        const body = A.listBody(spec.targets.map((t) => t.target));
        let res = null;
        try {
          res = body ? await host.api.post(body) : null;
        } catch (_) {
          res = null;
        }
        if (mine !== token || !st.alive) return;
        st.loading = false;
        if (!res || !Array.isArray(res.results)) {
          st.failed = true;
          paint();
          return;
        }
        st.truncated = !!res.truncated;
        st.results = new Map();
        res.results.forEach((r, i) => {
          if (spec.targets[i]) st.results.set(spec.targets[i].key, r);
        });
        paint();
      }

      function targetOf(key) {
        const t = spec.targets.find((x) => x.key === key);
        return t || spec.targets[0];
      }

      function setNotice(t, isError) {
        st.notice = isError ? "" : t;
        st.error = isError ? t : "";
        say(t);
      }

      /** Exactly one mutation at a time; the typed text is never discarded by a failure. */
      async function run(bodyObj, onOk) {
        if (st.busy) return null;
        if (!bodyObj) {
          setNotice("Saisie invalide : rien n'a été envoyé.", true);
          paint();
          return null;
        }
        if (!online()) {
          setNotice(MSG.offline, true);
          paint();
          return null;
        }
        st.busy = true;
        paint();
        try {
          const res = await host.api.post(bodyObj);
          st.busy = false;
          onOk(res);
          await load();
          return res;
        } catch (err) {
          st.busy = false;
          const info = A.errorInfo(err);
          if (info.conflict) {
            st.confirm = null;
            setNotice(bodyObj.action === "annotation_delete" ? MSG.conflictDelete : MSG.conflict, true);
            await load(); // the server version replaces the list; st.draft / st.editDraft are left exactly as typed
          } else {
            if (info.definite) st.pending = null;
            setNotice(info.full ? MSG.full : info.corrupt ? MSG.corrupt : info.message, true);
            paint();
          }
          return null;
        }
      }

      function create() {
        const t = targetOf(st.choice);
        const v = A.validateBody(st.draft);
        if (!v.ok) {
          setNotice(v.reason, true);
          paint();
          return;
        }
        const page = st.attachPage && typeof spec.getPage === "function" ? spec.getPage() : null;
        const base = typeof spec.getAnchor === "function" ? spec.getAnchor() : null;
        const anchor = st.attachPage ? A.anchorFor(page, base && base.loc) : base && base.loc ? A.anchorFor(null, base.loc) : null;
        const sig = JSON.stringify([t.key, anchor, st.draft]);
        if (!st.pending || st.pending.sig !== sig) st.pending = { sig, requestId: rid() }; // same intent after a lost answer => same id
        const body = A.createBody(t.target, anchor, st.draft, st.pending.requestId);
        run(body, () => {
          st.draft = "";
          st.pending = null;
          st.attachPage = false; // the page anchor is chosen per annotation, never carried over silently
          setNotice(MSG.saved, false);
        });
      }

      function row(r, tr) {
        const a = r;
        const corrupt = a.integrity !== "ok";
        const li = el(doc, "li", { class: "carnet-ann-item", "data-ann": a.id, "data-status": a.status, "data-integrity": a.integrity });
        const head = el(doc, "p", { class: "carnet-ask-meta" }, [
          el(doc, "span", { class: "carnet-chip", text: a.status === "resolved" ? "Résolue" : "Ouverte" }),
          el(doc, "span", { class: "hint", text: "modifiée " + fmt(a.updated_at) }),
          a.anchor ? el(doc, "span", { class: "hint", "data-ann-anchor": "1", text: "repère : " + A.anchorText(a.anchor) }) : null,
        ]);
        li.appendChild(head);
        if (corrupt) li.appendChild(el(doc, "p", { class: "carnet-src-warn", role: "alert", text: MSG.corrupt }));
        if (st.editing === a.id && !corrupt) {
          const ta = el(doc, "textarea", { id: "hq-ann-edit-" + a.id, class: "carnet-ann-text", rows: "3", "aria-label": MSG.label, maxlength: String(A.BODY_MAX * 2) });
          ta.value = st.editDraft;
          ta.addEventListener("input", () => {
            st.editDraft = ta.value;
          });
          li.appendChild(ta);
          const save = el(doc, "button", { type: "button", class: "carnet-small", "data-ann-act": "save", text: MSG.save, "aria-disabled": st.busy ? "true" : null });
          save.addEventListener("click", () => {
            const v = A.validateBody(st.editDraft);
            if (!v.ok) {
              setNotice(v.reason, true);
              paint();
              return;
            }
            run(A.updateBody(a, { body: st.editDraft }), () => {
              st.editing = null;
              st.editDraft = "";
              setNotice(MSG.saved, false);
            });
          });
          const cancel = el(doc, "button", { type: "button", class: "carnet-small", "data-ann-act": "cancel", text: MSG.cancel });
          cancel.addEventListener("click", () => {
            st.editing = null;
            st.editDraft = "";
            paint();
            focusId("hq-ann-edit-btn-" + a.id);
          });
          li.appendChild(el(doc, "div", { class: "carnet-panel-row" }, [save, cancel]));
          return li;
        }
        li.appendChild(el(doc, "p", { class: "carnet-ann-body", text: a.body })); // textContent: never interpreted
        if (corrupt) return li;
        const acts = el(doc, "div", { class: "carnet-panel-row" });
        const mk = (act, label, fn, id) => {
          const b = el(doc, "button", { type: "button", class: "carnet-small", "data-ann-act": act, id, text: label, "aria-disabled": st.busy || !online() ? "true" : null, "aria-label": label + " : annotation du " + fmt(a.updated_at) });
          b.addEventListener("click", fn);
          return b;
        };
        acts.appendChild(mk("edit", MSG.edit, () => {
          st.editing = a.id;
          st.editDraft = a.body;
          paint();
          focusId("hq-ann-edit-" + a.id);
        }, "hq-ann-edit-btn-" + a.id));
        acts.appendChild(mk(a.status === "resolved" ? "reopen" : "resolve", a.status === "resolved" ? MSG.reopen : MSG.resolve, () => run(A.updateBody(a, { status: a.status === "resolved" ? "open" : "resolved" }), () => setNotice(MSG.saved, false))));
        acts.appendChild(mk("delete", MSG.del, () => {
          st.confirm = { id: a.id, rev: a.rev };
          paint();
          focusId("hq-ann-confirm-" + a.id);
        }));
        if (typeof spec.onView === "function" && tr && tr.target_state !== "unavailable") {
          const v = el(doc, "button", { type: "button", class: "carnet-small", "data-ann-act": "view", text: MSG.viewEvidence, "aria-label": MSG.viewEvidence + " : " + tr.label });
          v.addEventListener("click", () => spec.onView(a, tr));
          acts.appendChild(v);
        }
        li.appendChild(acts);
        if (st.confirm && st.confirm.id === a.id) {
          const yes = el(doc, "button", { type: "button", class: "carnet-small", id: "hq-ann-confirm-" + a.id, "data-ann-act": "confirm-delete", text: MSG.confirmYes });
          yes.addEventListener("click", () => {
            const confirmed = { id: st.confirm.id, rev: st.confirm.rev };
            // the revision the person SAW when asking: a newer one gets 409, never a silently refreshed delete
            run(A.deleteBody(Object.assign({}, a, { rev: confirmed.rev }), true), () => {
              st.confirm = null;
              setNotice(MSG.deleted, false);
            });
          });
          const no = el(doc, "button", { type: "button", class: "carnet-small", "data-ann-act": "cancel-delete", text: MSG.cancel });
          no.addEventListener("click", () => {
            st.confirm = null;
            paint();
          });
          li.appendChild(el(doc, "div", { class: "carnet-ann-confirm", role: "alertdialog", "aria-label": MSG.confirmDelete }, [el(doc, "p", { text: MSG.confirmDelete }), el(doc, "div", { class: "carnet-panel-row" }, [yes, no])]));
        }
        return li;
      }

      function focusId(id) {
        const n = root.querySelector("#" + id);
        if (n) n.focus({ preventScroll: true });
      }

      function group(t, r) {
        const g = el(doc, "div", { class: "carnet-ann-group", "data-ann-target": t.key });
        g.appendChild(el(doc, "h4", { text: t.label }));
        g.appendChild(el(doc, "p", { class: "hint", "data-ann-state": r.target_state, text: A.targetStateText(r) }));
        const note = A.identicalNote(r);
        if (note) g.appendChild(el(doc, "p", { class: "hint", "data-ann-identical": "1", text: note }));
        if (r.unavailable) g.appendChild(el(doc, "p", { class: "carnet-src-warn", role: "alert", text: r.unavailable + " " + MSG.unavailable }));
        if (!r.annotations.length) g.appendChild(el(doc, "p", { class: "hint", text: MSG.none }));
        else {
          const ul = el(doc, "ul", { class: "carnet-ann-list", "aria-label": MSG.section + " : " + t.label });
          for (const a of r.annotations) ul.appendChild(row(a, Object.assign({}, r, { label: t.label })));
          g.appendChild(ul);
        }
        return g;
      }

      function form() {
        const f = el(doc, "div", { class: "carnet-ann-form" });
        if (spec.targets.length > 1) {
          const fs = el(doc, "fieldset", { class: "carnet-ann-target" }, [el(doc, "legend", { text: "Attacher à" })]);
          for (const t of spec.targets) {
            const id = "hq-ann-target-" + t.key;
            const inp = el(doc, "input", { type: "radio", name: (spec.id || "ann") + "-target", id, value: t.key, checked: st.choice === t.key ? "checked" : null });
            inp.addEventListener("change", () => {
              st.choice = t.key;
            });
            fs.appendChild(el(doc, "label", { for: id }, [inp, doc.createTextNode(" " + t.label)]));
          }
          f.appendChild(fs);
        }
        const ta = el(doc, "textarea", { id: (spec.id || "hq-carnet-ann") + "-new", class: "carnet-ann-text", rows: "3", "aria-label": MSG.label, "aria-describedby": (spec.id || "hq-carnet-ann") + "-help" });
        ta.value = st.draft;
        const left = el(doc, "span", { class: "hint", "aria-live": "off", text: String(A.remaining(st.draft)) });
        ta.addEventListener("input", () => {
          st.draft = ta.value;
          left.textContent = String(A.remaining(st.draft));
        });
        f.appendChild(ta);
        f.appendChild(left);
        const page = typeof spec.getPage === "function" ? spec.getPage() : null;
        if (page) {
          const cid = (spec.id || "hq-carnet-ann") + "-page";
          const cb = el(doc, "input", { type: "checkbox", id: cid, checked: st.attachPage ? "checked" : null });
          cb.addEventListener("change", () => {
            st.attachPage = cb.checked;
          });
          f.appendChild(el(doc, "label", { for: cid }, [cb, doc.createTextNode(" " + MSG.attachPage + " " + page)]));
        }
        const add = el(doc, "button", { type: "button", id: (spec.id || "hq-carnet-ann") + "-add", class: "carnet-small", "data-ann-act": "add", text: MSG.add, "aria-disabled": st.busy || !online() ? "true" : null });
        add.addEventListener("click", create);
        f.appendChild(add);
        return f;
      }

      function paint() {
        if (!st.alive) return;
        const had = root.contains(doc.activeElement) ? doc.activeElement : null;
        const hadId = had && had.id ? had.id : null;
        root.textContent = "";
        // Phase 13: a quiet collapsed summary with the count (the Reader answers « what am I reading? » first); the whole panel is one click away
        const pid = spec.id || "hq-carnet-ann";
        let open = 0;
        let resolved = 0;
        for (const r of st.results.values()) for (const a of (r && Array.isArray(r.annotations) ? r.annotations : [])) (a && a.status === "resolved" ? resolved++ : open++);
        const summary = st.loading && !st.results.size ? MSG.loading : st.failed ? MSG.loadFailed : open + resolved === 0 ? MSG.none : (open + resolved) + (open + resolved > 1 ? " annotations" : " annotation") + (resolved ? " (" + open + " ouverte" + (open > 1 ? "s" : "") + " · " + resolved + " résolue" + (resolved > 1 ? "s" : "") + ")" : "");
        const toggle = el(doc, "button", { type: "button", class: "carnet-small carnet-ann-toggle", id: pid + "-toggle", "data-reader-panel": "ann", "aria-expanded": st.expanded ? "true" : "false", "aria-controls": pid + "-body" });
        toggle.appendChild(el(doc, "span", { class: "carnet-ann-heading", text: (spec.frozen ? MSG.frozenHeading : MSG.liveHeading) + " : " }));
        toggle.appendChild(el(doc, "span", { "data-ann-summary": "1", text: summary }));
        toggle.addEventListener("click", () => { st.expanded = !st.expanded; paint(); });
        root.appendChild(el(doc, "h3", { id: pid + "-h" }, [toggle]));
        if (st.failed && !st.expanded) {
          const retry0 = el(doc, "button", { type: "button", class: "carnet-small", "data-ann-act": "retry", text: "Réessayer" });
          retry0.addEventListener("click", load);
          root.appendChild(retry0);
        }
        if (!st.expanded) {
          if (hadId) {
            const again = root.querySelector("#" + hadId.replace(/([^\w-])/g, "\\$1"));
            if (again && again !== doc.activeElement) again.focus({ preventScroll: true });
          }
          return;
        }
        const bodyBox = el(doc, "div", { class: "carnet-ann-body-box", id: pid + "-body" });
        bodyBox.appendChild(el(doc, "p", { class: "hint", id: (spec.id || "hq-carnet-ann") + "-help", text: MSG.sectionHelp }));
        if (spec.frozen) bodyBox.appendChild(el(doc, "p", { class: "hint", "data-ann": "not-frozen", text: "Ces annotations sont lues maintenant : elles ne font pas partie de la copie figée affichée." }));
        if (st.notice) bodyBox.appendChild(el(doc, "p", { class: "hint", role: "status", "data-ann": "notice", text: st.notice }));
        if (st.error) bodyBox.appendChild(el(doc, "p", { class: "carnet-src-warn", role: "alert", "data-ann": "error", text: st.error }));
        if (st.loading && !st.results.size) bodyBox.appendChild(el(doc, "p", { class: "hint", role: "status", text: MSG.loading }));
        else if (st.failed) {
          bodyBox.appendChild(el(doc, "p", { class: "carnet-src-warn", role: "alert", text: MSG.loadFailed }));
          const retry = el(doc, "button", { type: "button", class: "carnet-small", "data-ann-act": "retry", text: "Réessayer" });
          retry.addEventListener("click", load);
          bodyBox.appendChild(retry);
        } else {
          for (const t of spec.targets) {
            const r = st.results.get(t.key);
            if (r) bodyBox.appendChild(group(t, r));
          }
          if (st.truncated) bodyBox.appendChild(el(doc, "p", { class: "hint", text: MSG.truncated }));
        }
        bodyBox.appendChild(form());
        root.appendChild(bodyBox);
        if (hadId) {
          const again = root.querySelector("#" + hadId.replace(/([^\w-])/g, "\\$1"));
          if (again && again !== doc.activeElement) again.focus({ preventScroll: true });
        }
      }

      paint();
      load();
      return { node: root, reload: load, destroy: () => { st.alive = false; token++; }, state: () => st };
    }

    return { panel };
  }

  return { mount, el, fmt };
});
