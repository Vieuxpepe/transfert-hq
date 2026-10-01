"""Carnet Stage 08: ONE reusable bulk-operation framework (stdlib only).

Flow (the same for every operation, never a one-off path)::

    scope -> affected count -> preview -> confirm -> revision-aware apply -> Undo -> ONE logical history event

Operations (``OPS``): ``replace`` (multi-note find/replace), ``context_move`` (project / category), ``trash``
(trash or restore pages), ``source_migrate`` (citations of edition A -> edition B, Stage-05 "à vérifier"
semantics), ``file_replace`` (the PDF an edition links to).

Contract
--------
* ``bulk_preview`` is READ-ONLY. It enumerates the exact targets with their revisions and DRY-RUNS the very code the
  apply uses on a copy of the state, so the preview already shows what will apply, be skipped or fail.
* ``bulk_apply`` needs ``confirm: true``, the previewed targets (id + revision) and ``expected_count`` (it never applies
  to MORE targets than were previewed). Every target is revalidated under the lock; a target whose revision moved is
  ``conflicted`` and left untouched. Nothing is retried against a newer revision.
* Per target the result is exactly one of ``applied`` / ``skipped`` / ``conflicted`` / ``failed``; the response carries an
  ``outcome`` (``complete`` | ``partial`` | ``none``): a global ``ok: true`` only when EVERY target applied.
* ONE history event records exactly what actually applied, with the BEFORE-state of each applied target (changed blocks
  only, never a whole-database snapshot) so that Undo never depends on an earlier checkpoint.
* ``bulk_undo`` is revision-aware: a target is reverted only while its revision still equals the one the bulk operation
  produced; every other target is reported ``conflicted`` and not touched (partial undo is explicit, never hidden).
  Only the ``UNDO_WINDOW`` newest bulk events can be undone, once, with no redo.

Persistence order (a crash can only leave an audit event, never lose a before-state): the history event is written as
``pending`` BEFORE the notebook / sources file, then finalized (``applied`` / ``failed``). Lock order: notebook lock ->
history lock; sources lock -> history lock.
"""

from __future__ import annotations

import contextlib
import copy
import re
import secrets
import threading
import time
from collections import OrderedDict
from typing import Any

import hq_carnet_history as history
import hq_carnet_rich as rich
import hq_carnet_sources as sources
import hq_state

OPS = ("replace", "context_move", "trash", "source_migrate", "file_replace")
TARGETS_MAX = history.TARGETS_MAX
FIND_MAX = 200
REPLACE_MAX = 200
SAMPLES_MAX = 3
EXCERPT_CONTEXT = 25
EXCERPT_MAX = 120
SEEN_MAX = 128
REASONS = {
    "stale": "Modifiée depuis l'aperçu — rien n'a été changé",
    "missing": "Page introuvable",
    "trashed": "Page dans la corbeille",
    "nothing": "Rien à changer",
    "draft": "Brouillon local non enregistré — page ignorée",
}
TEXT_TYPES = ("paragraph", "heading", "bullet", "number", "check", "decision")
LOC_PREFIX = {"page": "p. ", "section": "§ ", "clause": "art. ", "chapter": "chap. ", "figure": "fig. ", "table": "tab. ", "custom": ""}

_seen: "OrderedDict[str, dict]" = OrderedDict()
_seen_lock = threading.Lock()
_plans: "OrderedDict[str, dict]" = OrderedDict()  # preview plans (per process, like the request_id memory)
_plans_lock = threading.Lock()
PLAN_TTL_SECONDS = 900
PLANS_MAX = 64
_PLAN_RE = re.compile(r"^plan-[0-9a-f]{24}\Z")
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}\Z")
_PAGE_ID_RE = re.compile(r"^page-[A-Za-z0-9_-]{1,64}\Z")
_EVENT_ID_RE = re.compile(r"^hev-[0-9a-f]{24}\Z")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f  ]")


def _clock() -> float:
    return time.monotonic()


def _hc():
    import hq_carnet  # lazy: hq_carnet imports this module

    return hq_carnet


# ---------------------------------------------------------------- small helpers


def _err(message: str):
    return _hc().CarnetError(message)


def _u16(text: str) -> int:
    return rich.u16_len(text)


def _only(data: dict, allowed: set[str]) -> None:
    extra = set(data) - allowed
    if extra:
        raise _err("Champ non autorisé : " + ", ".join(sorted(str(k)[:40] for k in extra)))


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _line(value: Any, limit: int, label: str, *, required: bool) -> str:
    if not isinstance(value, str) or _CTRL_RE.search(value) or (required and not value) or _u16(value) > limit:
        raise _err(f"{label} invalide")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as e:
        raise _err(f"{label} invalide") from e
    return value


def _title(page: dict) -> str:
    hc = _hc()
    return hc.derive_title(rich.flat_text(page["content"]))


def _u16_prefix(text: str) -> list[int]:
    out = [0]
    total = 0
    for ch in text:
        total += 2 if ord(ch) > 0xFFFF else 1
        out.append(total)
    return out


def _excerpt(text: str, start: int, end: int, middle: str) -> str:
    left = text[max(0, start - EXCERPT_CONTEXT) : start]
    right = text[end : end + EXCERPT_CONTEXT]
    out = ("…" if start > EXCERPT_CONTEXT else "") + left + middle + right + ("…" if end + EXCERPT_CONTEXT < len(text) else "")
    return out if len(out) <= EXCERPT_MAX else out[: EXCERPT_MAX - 1] + "…"


# ---------------------------------------------------------------- parameters


def _params(op: str, raw: Any, *, preview: bool) -> dict:
    hc = _hc()
    if op not in OPS:
        raise _err("Opération groupée inconnue")
    if not isinstance(raw, dict):
        raise _err("Paramètres invalides")
    if op == "replace":
        _only(raw, {"find", "replace", "case_sensitive"})
        find = _line(raw.get("find"), FIND_MAX, "Texte cherché", required=True)
        repl = _line(raw.get("replace", ""), REPLACE_MAX, "Remplacement", required=False)
        cs = raw.get("case_sensitive", False)
        if not isinstance(cs, bool):
            raise _err("Paramètres invalides")
        return {"find": find, "replace": repl, "case_sensitive": cs}
    if op == "context_move":
        _only(raw, {"project_id", "category_id"})
        if not raw:
            raise _err("Choisis un projet et/ou une catégorie")
        out: dict[str, Any] = {}
        for key, kind in (("project_id", "proj"), ("category_id", "cat")):
            if key in raw:
                value = raw[key]
                if value is not None and (not isinstance(value, str) or not hc._ID_RE[kind].match(value)):
                    raise _err("Paramètres invalides")
                out[key] = value
        return out
    if op == "trash":
        _only(raw, {"mode"})
        if raw.get("mode") not in ("trash", "restore"):
            raise _err("Paramètres invalides")
        return {"mode": raw["mode"]}
    if op == "source_migrate":
        _only(raw, {"from_edition", "to_edition", "to_rev"})
        out = {}
        for key in ("from_edition", "to_edition"):
            value = raw.get(key)
            if not isinstance(value, str) or not sources._ID_RE["srce"].match(value):
                raise _err("Paramètres invalides")
            out[key] = value
        if out["from_edition"] == out["to_edition"]:
            raise _err("Les deux éditions doivent être différentes")
        if "to_rev" in raw:
            if not _is_int(raw["to_rev"]) or raw["to_rev"] < 1:
                raise _err("Paramètres invalides")
            out["to_rev"] = raw["to_rev"]
        elif not preview:
            raise _err("Paramètres invalides")
        return out
    _only(raw, {"edition_id", "file_ref"})  # file_replace
    ident = raw.get("edition_id")
    if not isinstance(ident, str) or not sources._ID_RE["srce"].match(ident):
        raise _err("Paramètres invalides")
    try:
        ref = sources.check_file_ref(raw.get("file_ref"), must_exist=False)
    except sources.SourceError as e:
        raise _err(str(e)) from e
    if not ref:
        raise _err("Référence PDF requise")
    return {"edition_id": ident, "file_ref": ref}


def _targets(value: Any, *, with_rev: bool, edition: bool = False) -> list[dict]:
    if not isinstance(value, list) or not value or len(value) > TARGETS_MAX:
        raise _err(f"Sélection invalide (1 à {TARGETS_MAX} cibles)")
    out: list[dict] = []
    seen: set[str] = set()
    for item in value:
        if with_rev:
            if not isinstance(item, dict) or set(item) != {"id", "rev"} or not _is_int(item["rev"]) or item["rev"] < 1:
                raise _err("Sélection invalide")
            ident = item["id"]
        else:
            ident = item
        rx = sources._ID_RE["srce"] if edition else _PAGE_ID_RE
        if not isinstance(ident, str) or not rx.match(ident) or ident in seen:
            raise _err("Sélection invalide")
        seen.add(ident)
        out.append({"id": ident, "rev": item["rev"]} if with_rev else {"id": ident})
    return out


# ---------------------------------------------------------------- citation migration (Stage-05 "à vérifier")


def locator_label(loc: dict, pdf: int | None) -> str:
    if loc and loc["text"]:
        return LOC_PREFIX.get(loc["kind"], "") + loc["text"]
    return f"p. PDF {pdf}" if pdf else "à vérifier"


def citation_label(cite: dict) -> str:
    """The visible label of a citation, byte for byte what ``HqCarnetRich.citationLabel`` produces."""
    snap = cite["snap"]
    return "[" + snap["title"] + (" " + snap["edition"] if snap.get("edition") else "") + ", " + locator_label(cite["loc"], cite["pdf"]) + "]"


def edition_snapshot(ed: dict) -> dict:
    snap: dict[str, Any] = {"title": ed["title"]}
    if ed.get("author"):
        snap["author"] = ed["author"]
    if ed.get("edition"):
        snap["edition"] = ed["edition"]
    if ed.get("year"):
        snap["year"] = ed["year"]
    if ed.get("identifier"):
        snap["ident"] = ed["identifier"]
    return snap


def migrate_cite_todo(old: dict, new_ed: dict) -> dict:
    """The citation for the NEWER edition: ``HqCarnetSources.migrateCite(old, ed, "todo")``.

    The old locator TEXT and PDF page are NEVER carried over (page numbers differ between editions): the new citation has
    an empty locator (kind only), no PDF page and ``ok: false``; ``from`` keeps the old edition, locator, PDF page and flag
    so the old citation stays reconstructible. No calibration is ever consulted.
    """
    origin = {"src": old["src"], "loc": {"kind": old["loc"]["kind"], "text": old["loc"]["text"]}, "pdf": old["pdf"], "ok": old["ok"]}
    cite = {"src": new_ed["id"], "loc": {"kind": old["loc"]["kind"], "text": ""}, "pdf": None, "ok": False, "snap": edition_snapshot(new_ed), "from": origin}
    return rich.check_cite(cite)


class _Partial(Exception):
    """A formatting mark partly overlaps a citation: the page is skipped, never rewritten."""


def _splice_mark(mark: dict, cs: int, ce: int, new_end: int, delta: int) -> dict:
    s, e = mark["start"], mark["end"]
    if e <= cs:
        return mark
    if s >= ce:
        return {**mark, "start": s + delta, "end": e + delta}
    if s <= cs and e >= ce:
        return {**mark, "end": e + delta}
    raise _Partial()


def _migrate_block(block: dict, from_id: str, new_ed: dict) -> tuple[dict, int] | None:
    marks = block["marks"]
    cites = [m for m in marks if m["type"] == "citation" and m["cite"]["src"] == from_id]
    if not cites:
        return None
    text = block["text"]
    units = text.encode("utf-16-le")
    for target in sorted(cites, key=lambda m: m["start"], reverse=True):  # right to left: earlier offsets never move
        cs, ce = target["start"], target["end"]
        new_cite = migrate_cite_todo(target["cite"], new_ed)
        label = citation_label(new_cite)
        new_len = _u16(label)
        delta = new_len - (ce - cs)
        units = units[: cs * 2] + label.encode("utf-16-le") + units[ce * 2 :]
        rebuilt = []
        for m in marks:
            if m is target:
                rebuilt.append({"type": "citation", "start": cs, "end": cs + new_len, "cite": new_cite})
            else:
                rebuilt.append(_splice_mark(m, cs, ce, cs + new_len, delta))
        marks = rebuilt
    return {**block, "text": units.decode("utf-16-le"), "marks": rich.canonical_marks(marks)}, len(cites)


# ---------------------------------------------------------------- per-operation page analysis
#
# Each ``_do_*`` mutates ``state`` exactly like a normal (revision-checked) page action, returns a result dict and raises
# CarnetError (-> failed) / CarnetConflict (-> conflicted). ``before`` is what Undo needs.


class _NoChange(Exception):
    """The save would not change the page (same revision): reported as skipped, never as applied."""


def _save(state: dict, page: dict, now: float, **fields: Any) -> int:
    hc = _hc()
    before = page["rev"]
    hc._page_save(state, {"action": "page_save", "id": page["id"], "expected_rev": before, **fields}, now)
    if page["rev"] == before:
        raise _NoChange()
    return page["rev"]


def _result(status: str, reason: str = "", **extra: Any) -> dict:
    return {"status": status, "reason": reason, **extra}


def _do_replace(state: dict, page: dict, params: dict, now: float, ctx: dict) -> dict:
    flags = 0 if params["case_sensitive"] else re.IGNORECASE
    pattern = re.compile(re.escape(params["find"]), flags)
    repl = params["replace"]
    content = page["content"]
    changes = skipped_occ = 0
    samples: list[dict] = []

    def one(text: str, marks: list[dict]) -> tuple[str, list[dict], int, int]:
        nonlocal samples
        prefix = _u16_prefix(text)
        parts: list[str] = []
        spans: list[tuple[int, int, int]] = []
        last = n = skipped = 0
        for m in pattern.finditer(text):
            s, e = m.span()
            us, ue = prefix[s], prefix[e]
            if any(mk["start"] < ue and us < mk["end"] for mk in marks):
                skipped += 1  # formatted / linked / cited text is never rewritten
                continue
            parts.append(text[last:s])
            parts.append(repl)
            last = e
            spans.append((us, ue, _u16(repl) - (ue - us)))
            if len(samples) < SAMPLES_MAX:
                samples.append({"before": _excerpt(text, s, e, text[s:e]), "after": _excerpt(text, s, e, repl)})
            n += 1
        if not n:
            return text, marks, 0, skipped
        parts.append(text[last:])
        shifted = []
        for mk in marks:
            shift = sum(d for (us, ue, d) in spans if ue <= mk["start"])
            shifted.append({**mk, "start": mk["start"] + shift, "end": mk["end"] + shift})
        return "".join(parts), shifted, n, skipped

    if content["version"] == rich.LEGACY_CONTENT_VERSION:
        block = content["blocks"][0]
        new_text, _, n, skipped_occ = one(block["text"], [])
        if not n:
            return _result("skipped", "Aucune occurrence" if not skipped_occ else "Occurrences dans du texte mis en forme — ignorées", changes=0, samples=[], skipped_occurrences=skipped_occ)
        rev_before = page["rev"]
        try:
            rev_after = _save(state, page, now, content={"version": rich.LEGACY_CONTENT_VERSION, "blocks": [{"id": block["id"], "type": "text", "text": new_text, "marks": []}]})
        except _NoChange:
            return _result("skipped", REASONS["nothing"], changes=0, samples=[])
        except _hc().CarnetError as e:
            return _result("failed", str(e), changes=n, samples=samples)
        return _result("applied", "", changes=n, samples=samples, skipped_occurrences=skipped_occ, rev_before=rev_before, rev_after=rev_after, before={"text": block["text"]})
    new_blocks = copy.deepcopy(content["blocks"])
    before_blocks: list[dict] = []
    for block in new_blocks:
        if block["type"] not in TEXT_TYPES or not block["text"]:
            continue
        original = {"id": block["id"], "text": block["text"], "marks": copy.deepcopy(block["marks"])}
        text, marks, n, skipped = one(block["text"], block["marks"])
        skipped_occ += skipped
        if n:
            block["text"], block["marks"] = text, marks
            before_blocks.append(original)
            changes += n
    if not changes:
        return _result("skipped", "Aucune occurrence" if not skipped_occ else "Occurrences dans du texte mis en forme — ignorées", changes=0, samples=[], skipped_occurrences=skipped_occ)
    rev_before = page["rev"]
    try:
        rev_after = _save(state, page, now, content={"version": rich.CONTENT_VERSION, "blocks": new_blocks})
    except _NoChange:
        return _result("skipped", REASONS["nothing"], changes=0, samples=[])
    except _hc().CarnetError as e:
        return _result("failed", str(e), changes=changes, samples=samples)
    return _result("applied", "", changes=changes, samples=samples, skipped_occurrences=skipped_occ, rev_before=rev_before, rev_after=rev_after, before={"blocks": before_blocks})


def _do_migrate(state: dict, page: dict, params: dict, now: float, ctx: dict) -> dict:
    content = page["content"]
    if content["version"] != rich.CONTENT_VERSION:
        return _result("skipped", "Aucune citation", changes=0, samples=[])
    new_blocks = copy.deepcopy(content["blocks"])
    before_blocks: list[dict] = []
    samples: list[dict] = []
    changes = 0
    try:
        for index, block in enumerate(new_blocks):
            if block["type"] not in TEXT_TYPES:
                continue
            old_marks = copy.deepcopy(block["marks"])
            old_text = block["text"]
            done = _migrate_block(block, params["from_edition"], ctx["to"])
            if done is None:
                continue
            new_blocks[index], n = done
            before_blocks.append({"id": block["id"], "text": old_text, "marks": old_marks})
            changes += n
            for mark in old_marks:  # the OLD locator is displayed for human context only; it is never persisted as the new one
                if mark["type"] == "citation" and mark["cite"]["src"] == params["from_edition"] and len(samples) < SAMPLES_MAX:
                    samples.append({"before": citation_label(mark["cite"]), "after": citation_label(migrate_cite_todo(mark["cite"], ctx["to"]))})
    except _Partial:
        return _result("skipped", "Mise en forme partielle autour d'une citation — migre-la à la main", changes=0, samples=[])
    except rich.ContentError as e:
        return _result("failed", str(e), changes=0, samples=[])
    if not changes:
        return _result("skipped", "Aucune citation de cette édition", changes=0, samples=[])
    rev_before = page["rev"]
    try:
        rev_after = _save(state, page, now, content={"version": rich.CONTENT_VERSION, "blocks": new_blocks})
    except _NoChange:
        return _result("skipped", REASONS["nothing"], changes=0, samples=[])
    except _hc().CarnetError as e:
        return _result("failed", str(e), changes=changes, samples=samples)
    return _result("applied", "", changes=changes, samples=samples, rev_before=rev_before, rev_after=rev_after, before={"blocks": before_blocks})


def _do_move(state: dict, page: dict, params: dict, now: float, ctx: dict) -> dict:
    if page["deleted_at"] is not None:
        return _result("skipped", REASONS["trashed"], changes=0, samples=[])
    if all(page[key] == value for key, value in params.items()):
        return _result("skipped", "Déjà dans ce contexte", changes=0, samples=[])
    before = {"project_id": page["project_id"], "category_id": page["category_id"]}
    rev_before = page["rev"]
    try:
        rev_after = _save(state, page, now, **params)
    except _NoChange:
        return _result("skipped", REASONS["nothing"], changes=0, samples=[])
    except _hc().CarnetError as e:
        return _result("failed", str(e), changes=1, samples=[])
    return _result("applied", "", changes=1, samples=[], rev_before=rev_before, rev_after=rev_after, before=before)


def _do_trash(state: dict, page: dict, params: dict, now: float, ctx: dict) -> dict:
    hc = _hc()
    trashing = params["mode"] == "trash"
    if trashing and page["deleted_at"] is not None:
        return _result("skipped", "Déjà dans la corbeille", changes=0, samples=[])
    if not trashing and page["deleted_at"] is None:
        return _result("skipped", "Page non supprimée", changes=0, samples=[])
    if trashing and len(hc._active(state)) <= 1:
        return _result("skipped", "Dernière page active — conservée", changes=0, samples=[])
    handler = hc._page_trash if trashing else hc._page_restore
    rev_before = page["rev"]
    try:
        handler(state, {"action": "page_trash", "id": page["id"], "expected_rev": page["rev"], "expected_notebook_rev": state["notebook_rev"]}, now)
    except hc.CarnetError as e:
        return _result("failed", str(e), changes=1, samples=[])
    return _result("applied", "", changes=1, samples=[], rev_before=rev_before, rev_after=page["rev"], before={"mode": params["mode"]})


_PAGE_OPS = {"replace": _do_replace, "context_move": _do_move, "trash": _do_trash, "source_migrate": _do_migrate}


# ---------------------------------------------------------------- execution (shared by preview, apply)


def _run_pages(state: dict, op: str, params: dict, targets: list[dict], now: float, ctx: dict, client_skipped: list[str]) -> list[dict]:
    """Run ``op`` on every target against ``state`` (mutated in place). One result per target, in request order."""
    hc = _hc()
    fn = _PAGE_OPS[op]
    out: list[dict] = []
    for target in targets:
        page = next((p for p in state["pages"] if p["id"] == target["id"]), None)
        row: dict[str, Any] = {"kind": "page", "id": target["id"], "rev_before": None, "rev_after": None, "before": None, "title": "", "changes": 0, "samples": []}
        if page is None:
            row.update(status="conflicted", reason=REASONS["missing"])
        elif target.get("rev") is not None and page["rev"] != target["rev"]:
            row.update(status="conflicted", reason=REASONS["stale"], title=_title(page))
        else:
            row["title"] = _title(page)
            if page["deleted_at"] is not None and op != "trash":
                row.update(status="skipped", reason=REASONS["trashed"])
            else:
                try:
                    res = fn(state, page, params, now, ctx)
                except hc.CarnetConflict:
                    res = _result("conflicted", REASONS["stale"])
                row.update({k: v for k, v in res.items() if k != "skipped_occurrences"})
                if res.get("skipped_occurrences"):
                    row["skipped_occurrences"] = res["skipped_occurrences"]
        out.append(row)
    for ident in client_skipped:
        out.append({"kind": "page", "id": ident, "status": "skipped", "reason": REASONS["draft"], "rev_before": None, "rev_after": None, "before": None, "title": "", "changes": 0, "samples": []})
    return out


def _counts(rows: list[dict]) -> dict:
    return {s: sum(1 for r in rows if r["status"] == s) for s in history.TARGET_STATUSES}


def _public(row: dict) -> dict:
    out = {k: row[k] for k in ("kind", "id", "status", "reason", "rev_before", "rev_after", "title", "changes", "samples") if k in row}
    if row.get("skipped_occurrences"):
        out["skipped_occurrences"] = row["skipped_occurrences"]
    return out


def _outcome(counts: dict, total: int) -> str:
    if total and counts["applied"] == total:
        return "complete"
    return "partial" if counts["applied"] else "none"


def _event_targets(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        reason = (row.get("reason") or "")[: history.REASON_MAX]
        out.append({"kind": row["kind"], "id": row["id"], "status": row["status"], "reason": reason, "rev_before": row["rev_before"], "rev_after": row["rev_after"], "before": row["before"] if row["status"] == "applied" else None})
    return out


# ---------------------------------------------------------------- context (sources) and scope


def _read_sources() -> dict:
    try:
        with hq_state.path_lock(sources.confined_path()):
            return copy.deepcopy(sources._load_locked())
    except sources.SourceStorageError as e:
        raise _hc().CarnetStorageError(str(e), e.status) from e


def _edition(sstate: dict, ident: str) -> dict | None:
    return next((e for e in sstate["editions"] if e["id"] == ident), None)


def _migration_context(params: dict, locked: bool = False) -> dict:
    if locked:  # the caller already holds the sources lock
        try:
            sstate = copy.deepcopy(sources._load_locked())
        except sources.SourceStorageError as e:
            raise _hc().CarnetStorageError(str(e), e.status) from e
    else:
        sstate = _read_sources()
    old = _edition(sstate, params["from_edition"])
    new = _edition(sstate, params["to_edition"])
    if old is None or new is None:
        raise _err("Édition introuvable")
    if old["family_id"] != new["family_id"]:
        raise _err("Les deux éditions doivent appartenir à la même famille")
    if new["archived"]:
        raise _err("Édition cible archivée")
    if "to_rev" in params and params["to_rev"] != new["rev"]:
        raise _hc().CarnetConflict({"error": "Édition cible modifiée depuis l'aperçu", "code": "source_revision_conflict", "sources_rev": sstate["sources_rev"]})
    return {"to": new, "from": old, "sources_rev": sstate["sources_rev"]}


def _citing_pages(state: dict, from_id: str) -> list[dict]:
    out = []
    for page in state["pages"]:
        if page["deleted_at"] is not None or page["content"]["version"] != rich.CONTENT_VERSION:
            continue
        if any(m["type"] == "citation" and m["cite"]["src"] == from_id for b in page["content"]["blocks"] for m in b["marks"]):
            out.append(page)
    return out


def _page_scope(state: dict, op: str, params: dict, ids: list[str] | None) -> tuple[list[dict], int]:
    """The exact targets (id + live revision) and how many candidates were left out (cap)."""
    by_id = {p["id"]: p for p in state["pages"]}
    if ids is not None:
        out = []
        for ident in ids:
            if not isinstance(ident, str) or not _PAGE_ID_RE.match(ident):
                raise _err("Sélection invalide")
            page = by_id.get(ident)
            out.append({"id": ident, "rev": page["rev"] if page else None})
        return out, 0
    if op != "source_migrate":
        raise _err("Sélection requise")
    pages = _citing_pages(state, params["from_edition"])
    return [{"id": p["id"], "rev": p["rev"]} for p in pages[:TARGETS_MAX]], max(0, len(pages) - TARGETS_MAX)


# ---------------------------------------------------------------- preview


def _preview_inner(data: Any) -> dict:
    hc = _hc()
    if not isinstance(data, dict):
        raise _err("Requête invalide")
    _only(data, {"action", "op", "params", "page_ids"})
    op = data.get("op")
    params = _params(op, data.get("params"), preview=True) if isinstance(op, str) else _params("", None, preview=True)
    if op == "file_replace":
        return _preview_file(params)
    ctx: dict = {}
    if op == "source_migrate":
        ctx = _migration_context(params)
        params = {**params, "to_rev": ctx["to"]["rev"]}
    ids = data.get("page_ids")
    if ids is not None:
        ids = [t["id"] for t in _targets(ids, with_rev=False)]
    with hq_state.path_lock(hc._path()):
        state = hc._load_locked(create=False)
        targets, truncated = _page_scope(state, op, params, ids)
        if not targets:
            return {"ok": True, "op": op, "params": params, "count": 0, "targets": [], "truncated": 0, "notebook_rev": state["notebook_rev"], "history": history.available()}
        dry = copy.deepcopy(state)
        rows = _run_pages(dry, op, params, targets, hc._now(), ctx, [])
        counts = _counts(rows)
        notebook_rev = state["notebook_rev"]
    out = {
        "ok": True, "op": op, "params": params, "count": counts["applied"], "counts": {**counts, "applied": counts["applied"]},
        "targets": [{**_public(r), "rev": t["rev"], "status": "will_apply" if r["status"] == "applied" else r["status"]} for r, t in zip(rows, targets)],
        "truncated": truncated, "notebook_rev": notebook_rev, "total_changes": sum(r["changes"] for r in rows if r["status"] == "applied"),
        "history": history.available(), "limits": {"targets": TARGETS_MAX},
    }
    if op == "source_migrate":
        out["info"] = {"from": ctx["from"]["title"] + " " + ctx["from"]["edition"], "to": ctx["to"]["title"] + " " + ctx["to"]["edition"], "rule": "Rien n'est repris de l'ancien emplacement : les nouvelles citations sont « à vérifier »."}
    return out


def preview(data: Any) -> dict:
    """Dry run of the exact apply code. When something would change, the result carries ``plan``: an opaque, short-lived,
    server-side record of exactly {op, normalized params, target ids + revisions}. ``apply`` refuses anything that is not
    covered by a live plan (no apply without a preview, none for different parameters/targets/revisions)."""
    out = _preview_inner(data)
    rows = {t["id"]: t["rev"] for t in out.get("targets", []) if t.get("status") == "will_apply"}
    if rows:
        token = "plan-" + secrets.token_hex(12)
        with _plans_lock:
            _plans[token] = {"op": out["op"], "params": copy.deepcopy(out["params"]), "targets": rows, "busy": False, "exp": _clock() + PLAN_TTL_SECONDS}
            while len(_plans) > PLANS_MAX:
                _plans.popitem(last=False)
        out["plan"] = token
        out["plan_ttl"] = PLAN_TTL_SECONDS
    return out


def _check_plan(data: dict, op: str, params: dict, targets: list[dict], skipped: list[str], expected: int) -> str:
    """Validate the confirmation against the plan AND reserve the plan (ready -> in flight) in ONE critical section.

    The plan is the exact confirmed operation: the submitted targets plus the declared client skips must account for EXACTLY the
    previewed set (no omission, no extra, no duplicate), every submitted revision must equal the previewed one, and
    ``expected_count`` must equal the previewed count minus the declared skips. A second request with the same token while the
    first is in flight is refused (``plan_in_use``), so one preview can never become two bulk events."""
    hc = _hc()
    token = data.get("plan")
    if not isinstance(token, str) or not _PLAN_RE.match(token):
        raise _err("Aperçu requis : lance l'aperçu puis confirme")
    ids = [t["id"] for t in targets]
    with _plans_lock:
        plan = _plans.get(token)
        if plan is not None and plan["exp"] < _clock():
            del _plans[token]
            plan = None
        if plan is None:
            raise hc.CarnetConflict({"error": "Aperçu expiré ou inconnu — relance l'aperçu", "code": "plan_expired"})
        if plan["busy"]:
            raise hc.CarnetConflict({"error": "Cet aperçu est déjà en cours d'application", "code": "plan_in_use"})
        bad = (
            plan["op"] != op or plan["params"] != params
            or len(set(ids)) != len(ids) or len(set(skipped)) != len(skipped)
            or set(ids) | set(skipped) != set(plan["targets"]) or len(ids) + len(skipped) != len(plan["targets"])
            or any(plan["targets"][t["id"]] != t["rev"] for t in targets)
            or expected != len(plan["targets"]) - len(skipped)
        )
        if bad:
            raise hc.CarnetConflict({"error": "La confirmation ne correspond pas à l'aperçu — relance l'aperçu", "code": "plan_mismatch"})
        plan["busy"] = True
    return token


def _plan_release(token: str) -> None:
    """The apply failed without committing (conflict, stale, history down...): the same confirmed plan may be retried."""
    with _plans_lock:
        plan = _plans.get(token)
        if plan is not None:
            plan["busy"] = False


def _plan_done(token: str) -> None:
    with _plans_lock:
        _plans.pop(token, None)


# ---------------------------------------------------------------- linked-file replacement (one edition, sources.json)


def _citation_stats(edition_id: str) -> dict:
    hc = _hc()
    with hq_state.path_lock(hc._path()):
        state = hc._load_locked(create=False)
    total = pdf_pages = 0
    for page in state["pages"]:
        content = page["content"]
        if page["deleted_at"] is not None or content["version"] != rich.CONTENT_VERSION:
            continue
        for block in content["blocks"]:
            for mark in block["marks"]:
                if mark["type"] == "citation" and mark["cite"]["src"] == edition_id:
                    total += 1
                    if mark["cite"]["pdf"] is not None:
                        pdf_pages += 1
    return {"citations": total, "pdf_page_citations": pdf_pages}


def _file_row(ed: dict, new_ref: str, status: str, reason: str, **extra: Any) -> dict:
    row = {"kind": "edition", "id": ed["id"], "status": status, "reason": reason, "rev_before": None, "rev_after": None, "before": None, "title": ed["title"], "changes": 1 if status == "applied" else 0, "samples": [{"before": ed["file_ref"] or "(aucun fichier)", "after": new_ref}]}
    row.update(extra)
    return row


def _preview_file(params: dict) -> dict:
    sstate = _read_sources()
    ed = _edition(sstate, params["edition_id"])
    if ed is None:
        raise _err("Édition introuvable")
    problem = ""
    if params["file_ref"] == ed["file_ref"]:
        problem = "Même fichier"
    else:
        try:
            sources.check_file_ref(params["file_ref"], must_exist=True)
        except sources.SourceError as e:
            problem = str(e)
    stats = _citation_stats(ed["id"])
    cal = ed["calibration"]
    warnings = []
    if cal:
        warnings.append({"code": "calibration_cleared", "text": f"Le calibrage existant (page imprimée {cal['printed']} = page PDF {cal['pdf']}) sera EFFACÉ : il ne vaut que pour l'ancien fichier. Aucun recalibrage automatique."})
    if stats["pdf_page_citations"]:
        warnings.append({"code": "pdf_pages_to_recheck", "text": f"{stats['pdf_page_citations']} citation(s) portent un numéro de page PDF de l'ancien fichier : elles ne sont pas modifiées, à revérifier."})
    row = _file_row(ed, params["file_ref"], "skipped" if problem else "applied", problem)
    return {
        "ok": True, "op": "file_replace", "params": params, "count": 0 if problem else 1,
        "targets": [{**_public(row), "rev": ed["rev"], "status": "skipped" if problem else "will_apply"}],
        "truncated": 0, "sources_rev": sstate["sources_rev"], "calibration": cal, "warnings": warnings, "stats": stats,
        "requires_calibration_ack": bool(cal), "history": history.available(),
    }


# ---------------------------------------------------------------- apply


def _seen_get(key: str) -> dict | None:
    with _seen_lock:
        got = _seen.get(key)
        return copy.deepcopy(got) if got is not None else None


def _seen_put(key: str, value: dict) -> None:
    with _seen_lock:
        _seen[key] = copy.deepcopy(value)
        while len(_seen) > SEEN_MAX:
            _seen.popitem(last=False)


def _summary(op: str, counts: dict, changes: int) -> str:
    label = {"replace": "Remplacement", "context_move": "Changement de contexte", "trash": "Corbeille", "source_migrate": "Migration de source", "file_replace": "Fichier lié remplacé"}[op]
    parts = [f"{counts['applied']} appliquée(s)"]
    for key, word in (("skipped", "ignorée(s)"), ("conflicted", "en conflit"), ("failed", "en échec")):
        if counts[key]:
            parts.append(f"{counts[key]} {word}")
    extra = f" · {changes} modification(s)" if changes else ""
    return f"{label} : " + ", ".join(parts) + extra


def _respond(op: str, rows: list[dict], event_id: str | None, confirmed: bool, extra: dict | None = None) -> dict:
    counts = _counts(rows)
    outcome = _outcome(counts, len(rows))
    payload = {
        "ok": outcome == "complete", "outcome": outcome, "op": op, "counts": counts, "event_id": event_id, "history_confirmed": confirmed,
        "targets": [_public(r) for r in rows],
    }
    payload.update(extra or {})
    return payload


def _confirm(data: dict) -> int:
    if data.get("confirm") is not True:
        raise _err("Confirmation explicite requise")
    expected = data.get("expected_count")
    if not _is_int(expected) or expected < 0 or expected > TARGETS_MAX:
        raise _err("expected_count invalide")
    return expected


def _require_history() -> None:
    if not history.available():
        raise history.HistoryStorageError("Historique indisponible — l'opération groupée est refusée (rien n'a été modifié)")


def _finish_none(op: str, rows: list[dict]) -> None:
    hc = _hc()
    payload = _respond(op, rows, None, True)
    payload.update(error="Aucune cible appliquée", code="bulk_none_applied")
    raise hc.CarnetConflict(payload)


def apply(data: Any) -> dict:
    hc = _hc()
    if not isinstance(data, dict):
        raise _err("Requête invalide")
    _only(data, {"action", "op", "params", "targets", "client_skipped", "confirm", "expected_count", "request_id", "ack_calibration", "plan"})
    op = data.get("op")
    if not isinstance(op, str):
        raise _err("Opération groupée inconnue")
    params = _params(op, data.get("params"), preview=False)
    expected = _confirm(data)
    request_id = data.get("request_id")
    if not isinstance(request_id, str) or not _REQUEST_ID_RE.match(request_id):
        raise _err("request_id invalide")
    known = _seen_get(request_id)
    if known is not None:
        known["duplicate"] = True
        return known
    targets = _targets(data.get("targets"), with_rev=True, edition=(op == "file_replace"))
    skipped_ids = data.get("client_skipped", [])
    if not isinstance(skipped_ids, list) or len(skipped_ids) > TARGETS_MAX or any(not isinstance(i, str) or not _PAGE_ID_RE.match(i) for i in skipped_ids):
        raise _err("Sélection invalide")
    if len(targets) + len(skipped_ids) > TARGETS_MAX or set(skipped_ids) & {t["id"] for t in targets}:
        raise _err("Sélection invalide")
    token = _check_plan(data, op, params, targets, skipped_ids, expected)
    try:
        _require_history()
        if op == "file_replace":
            result = _apply_file(params, targets, data.get("ack_calibration"), expected)
        else:
            result = _apply_pages(op, params, targets, skipped_ids, expected)
    except BaseException:
        _plan_release(token)
        raise
    _plan_done(token)
    _seen_put(request_id, result)
    return result


def _apply_pages(op: str, params: dict, targets: list[dict], client_skipped: list[str], expected: int) -> dict:
    hc = _hc()
    with contextlib.ExitStack() as stack:
        # Lock order notebook -> sources -> history (sources never takes the notebook lock: no cycle). For a migration the
        # target edition is re-read and its revision re-checked UNDER the held sources lock, which stays held until the
        # notebook is written: a concurrent source edit either happens before (fail closed) or after (not part of this write).
        stack.enter_context(hq_state.path_lock(hc._path()))
        if op == "source_migrate":
            stack.enter_context(hq_state.path_lock(sources.confined_path()))
            ctx: dict = _migration_context(params, locked=True)
        else:
            ctx = {}
        state = hc._load_locked(create=False)
        rows = _run_pages(state, op, params, targets, hc._now(), ctx, client_skipped)
        counts = _counts(rows)
        if counts["applied"] > expected:
            raise hc.CarnetConflict({"error": "Aperçu obsolète — relance l'aperçu", "code": "preview_stale", "notebook_rev": state["notebook_rev"]})
        if counts["applied"] == 0:
            _finish_none(op, rows)
        changes = sum(r["changes"] for r in rows if r["status"] == "applied")
        data = {"op": op, "params": params, "targets": _event_targets(rows), "counts": counts, "undone": None}
        event_id = history.append("bulk", "pending", _summary(op, counts, changes), data)
        try:
            hc._write(state)
        except Exception:
            try:
                history.set_status(event_id, "failed")
            except history.HistoryStorageError:
                pass
            raise
        confirmed = True
        try:
            history.set_status(event_id, "applied")
        except history.HistoryStorageError:
            confirmed = False
        return _respond(op, rows, event_id, confirmed, {"notebook_rev": state["notebook_rev"]})


def _apply_file(params: dict, targets: list[dict], ack: Any, expected: int) -> dict:
    hc = _hc()
    if len(targets) != 1 or targets[0]["id"] != params["edition_id"]:
        raise _err("Sélection invalide")
    target = targets[0]
    with hq_state.path_lock(sources.confined_path()):
        try:
            sstate = sources._load_locked()
        except sources.SourceStorageError as e:
            raise hc.CarnetStorageError(str(e), e.status) from e
        ed = _edition(sstate, params["edition_id"])
        if ed is None:
            rows = [{"kind": "edition", "id": params["edition_id"], "status": "conflicted", "reason": "Édition introuvable", "rev_before": None, "rev_after": None, "before": None, "title": "", "changes": 0, "samples": []}]
            _finish_none("file_replace", rows)
        if ed["rev"] != target["rev"]:
            _finish_none("file_replace", [_file_row(ed, params["file_ref"], "conflicted", "Source modifiée depuis l'aperçu — rien n'a été changé")])
        if ed["calibration"] and ack is not True:
            raise _err("Confirme l'effacement du calibrage (ack_calibration)")
        if expected < 1:
            raise hc.CarnetConflict({"error": "Aperçu obsolète — relance l'aperçu", "code": "preview_stale"})
        try:
            if params["file_ref"] == ed["file_ref"]:
                raise sources.SourceError("Même fichier")
            sources.check_file_ref(params["file_ref"], must_exist=True)
        except sources.SourceError as e:
            _finish_none("file_replace", [_file_row(ed, params["file_ref"], "failed", str(e))])
        before = {"file_ref": ed["file_ref"], "calibration": copy.deepcopy(ed["calibration"])}
        rev_before = ed["rev"]
        row_pre = _file_row(ed, params["file_ref"], "applied", "")
        ed["file_ref"] = params["file_ref"]
        ed["calibration"] = None  # a calibration maps printed pages to PDF pages of the OLD concrete file
        sources._bump(sstate, ed, hc._now())
        row = {**row_pre, "rev_before": rev_before, "rev_after": ed["rev"], "before": before, "changes": 1}
        counts = _counts([row])
        data = {"op": "file_replace", "params": params, "targets": _event_targets([row]), "counts": counts, "undone": None}
        event_id = history.append("bulk", "pending", _summary("file_replace", counts, 1) + (" · calibrage effacé" if before["calibration"] else ""), data)
        try:
            sources._write(sstate)
        except Exception:
            try:
                history.set_status(event_id, "failed")
            except history.HistoryStorageError:
                pass
            raise
        confirmed = True
        try:
            history.set_status(event_id, "applied")
        except history.HistoryStorageError:
            confirmed = False
        return _respond("file_replace", [row], event_id, confirmed, {"sources_rev": sstate["sources_rev"], "calibration_cleared": bool(before["calibration"])})


# ---------------------------------------------------------------- undo


def _revert_page(state: dict, page: dict, op: str, before: dict, now: float) -> int:
    hc = _hc()
    if op in ("replace", "source_migrate"):
        if "text" in before:  # legacy V1 page: whole text
            first = page["content"]["blocks"][0]["id"]
            return _save(state, page, now, content={"version": rich.LEGACY_CONTENT_VERSION, "blocks": [{"id": first, "type": "text", "text": before["text"], "marks": []}]})
        blocks = copy.deepcopy(page["content"]["blocks"])
        index = {b["id"]: i for i, b in enumerate(blocks)}
        for saved in before["blocks"]:
            if saved["id"] not in index:
                raise hc.CarnetError("Ligne introuvable")
            blocks[index[saved["id"]]]["text"] = saved["text"]
            blocks[index[saved["id"]]]["marks"] = saved["marks"]
        return _save(state, page, now, content={"version": rich.CONTENT_VERSION, "blocks": blocks})
    if op == "context_move":
        return _save(state, page, now, project_id=before["project_id"], category_id=before["category_id"])
    handler = hc._page_restore if before["mode"] == "trash" else hc._page_trash  # trash -> restore, restore -> trash
    handler(state, {"action": "page_restore", "id": page["id"], "expected_rev": page["rev"], "expected_notebook_rev": state["notebook_rev"]}, now)
    return page["rev"]


def undo(data: Any) -> dict:
    hc = _hc()
    if not isinstance(data, dict):
        raise _err("Requête invalide")
    _only(data, {"action", "event_id", "confirm"})
    event_id = data.get("event_id")
    if not isinstance(event_id, str) or not _EVENT_ID_RE.match(event_id):
        raise _err("Événement invalide")
    if data.get("confirm") is not True:
        raise _err("Confirmation explicite requise")
    _require_history()
    event = history.get_event(event_id)
    if event["kind"] != "bulk" or event["status"] != "applied":
        raise _err("Cette opération ne peut pas être annulée")
    if event["data"]["undone"] is not None:
        raise hc.CarnetConflict({"error": "Déjà annulée", "code": "already_undone"})
    if event_id not in history.undo_candidates():
        raise _err("Trop ancienne pour être annulée (seules les dernières opérations groupées le peuvent)")
    op = event["data"]["op"]
    if op == "file_replace":
        return _undo_file(event)
    now = hc._now()
    with hq_state.path_lock(hc._path()):
        state = hc._load_locked(create=False)
        rows: list[dict] = []
        for target in event["data"]["targets"]:
            if target["status"] != "applied":
                continue
            row: dict[str, Any] = {"kind": "page", "id": target["id"], "rev_before": target["rev_after"], "rev_after": None, "before": None, "title": "", "changes": 0, "samples": []}
            page = next((p for p in state["pages"] if p["id"] == target["id"]), None)
            if page is None:
                row.update(status="conflicted", reason="Page supprimée depuis")
            elif page["rev"] != target["rev_after"]:
                row.update(status="conflicted", reason="Modifiée depuis l'opération — non annulée", title=_title(page))
            else:
                row["title"] = _title(page)
                try:
                    row["rev_after"] = _revert_page(state, page, op, target["before"], now)
                    row.update(status="applied", reason="", before={"restored": True}, changes=1)
                except hc.CarnetError as e:
                    row.update(status="failed", reason=str(e))
                except _NoChange:
                    row.update(status="failed", reason="Aucun changement à annuler")
                except hc.CarnetConflict:
                    row.update(status="conflicted", reason=REASONS["stale"])
            rows.append(row)
        counts = _counts(rows)
        if counts["applied"] == 0:
            _finish_none(op, rows)
        undo_data = {"of": event_id, "targets": _event_targets(rows), "counts": counts}
        summary = "Annulation : " + f"{counts['applied']} annulée(s)" + (f", {counts['conflicted']} en conflit" if counts["conflicted"] else "") + (f", {counts['failed']} en échec" if counts["failed"] else "")
        undo_id = history.append("undo", "pending", summary, undo_data)
        try:
            hc._write(state)
        except Exception:
            try:
                history.set_status(undo_id, "failed")
            except history.HistoryStorageError:
                pass
            raise
        confirmed = True
        try:
            history.set_status(undo_id, "applied")
            history.mark_undone(event_id, undo_id, counts)
        except history.HistoryStorageError:
            confirmed = False
        return _respond(op, rows, undo_id, confirmed, {"undo_of": event_id, "notebook_rev": state["notebook_rev"]})


def _undo_file(event: dict) -> dict:
    hc = _hc()
    target = next(t for t in event["data"]["targets"] if t["status"] == "applied")
    with hq_state.path_lock(sources.confined_path()):
        try:
            sstate = sources._load_locked()
        except sources.SourceStorageError as e:
            raise hc.CarnetStorageError(str(e), e.status) from e
        ed = _edition(sstate, target["id"])
        row: dict[str, Any] = {"kind": "edition", "id": target["id"], "rev_before": target["rev_after"], "rev_after": None, "before": None, "title": ed["title"] if ed else "", "changes": 0, "samples": []}
        if ed is None:
            row.update(status="conflicted", reason="Édition supprimée depuis")
        elif ed["rev"] != target["rev_after"]:
            row.update(status="conflicted", reason="Source modifiée depuis l'opération — non annulée")
        else:
            before = target["before"]
            try:
                ref = sources.check_file_ref(before["file_ref"], must_exist=False)
                cal = sources.check_calibration(before["calibration"])
            except sources.SourceError as e:
                row.update(status="failed", reason=str(e))
            else:
                ed["file_ref"] = ref
                ed["calibration"] = cal  # the exact old calibration comes back with the old file
                sources._bump(sstate, ed, hc._now())
                row.update(status="applied", reason="", rev_after=ed["rev"], before={"restored": True}, changes=1)
        rows = [row]
        counts = _counts(rows)
        if counts["applied"] == 0:
            _finish_none("file_replace", rows)
        undo_id = history.append("undo", "pending", "Annulation : fichier lié et calibrage restaurés", {"of": event["id"], "targets": _event_targets(rows), "counts": counts})
        try:
            sources._write(sstate)
        except Exception:
            try:
                history.set_status(undo_id, "failed")
            except history.HistoryStorageError:
                pass
            raise
        confirmed = True
        try:
            history.set_status(undo_id, "applied")
            history.mark_undone(event["id"], undo_id, counts)
        except history.HistoryStorageError:
            confirmed = False
        return _respond("file_replace", rows, undo_id, confirmed, {"undo_of": event["id"], "sources_rev": sstate["sources_rev"]})
