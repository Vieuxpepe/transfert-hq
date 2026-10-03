"""Carnet Phase 5: Engineering Intelligence — DERIVED views (pure functions, stdlib only, nothing is stored here).

Everything below is computed on demand from canonical Carnet data (pages and their structured blocks) that the caller passes in.
There is no second project database, no cached state and no AI: every number and every list item points back to a page and,
where a block exists, to ``#carnet/<pageId>/<blockId>`` (the Phase-3.5 deep link).

What is derived, and from what ONLY:

* ``cockpit``  counts, recent notes, the decision trail, measurement series, drawings, sources and file references of the
  (non-trashed) pages of one project (or of the pages without project). Tasks are NOT included: no canonical page/project <->
  Kanban association exists, so the cockpit says so instead of inventing one.
* decision trail  one row per ``decision`` block: its text, its ``at`` timestamp, page and block, and as EVIDENCE only the
  canonical references already attached to that very line (link marks with a ``ref``, citations). No status, rationale or author
  is inferred: the decision block has none.
* measurement series  ``measure`` blocks grouped by (Unicode-normalised, trimmed, whitespace-collapsed, case-folded label, exact
  observed unit label). No unit conversion, ever: ``mm`` and ``in`` are two series. Each point keeps its own nominal, tolerance,
  mode and verdict (``hq_carnet_eng.evaluate``: none | in | out | incompatible); a tolerance band is offered only when every
  point carries the same exact bounds, otherwise the series says its tolerance varies.
* diff  exact, by stable block id and canonical payload. Never fuzzy: a block whose id changed (a restore re-mints ids of blocks
  that no longer exist) is reported as removed + added. Reordering is not reported. No authorship is ever claimed (none is recorded).

Bounds are explicit constants (``LIMITS``); anything cut is reported through ``*_total`` / ``truncated``.
"""

from __future__ import annotations

import copy
import hashlib
import json
import unicodedata
from typing import Any, Callable

import hq_carnet_eng as eng
import hq_carnet_rich as rich

LIMITS = {
    "pages_scanned": 256,  # the system maximum (128 active + 128 trash): a cockpit never scans more
    "recent_activity": 100,
    "recent_notes": 50,
    "decisions": 500,
    "series": 200,
    "points_per_series": 1000,
    "refs_per_item": 20,
    "diff_items": 500,
}
VERDICTS = ("in", "out", "none", "incompatible")
EVIDENCE_REF_KINDS = ("note", "project", "file", "drawing", "model", "media")
SUMMARY_MAX = 160


def norm_label(label: Any) -> str:
    """The series identity of a measure label: NFC, trimmed, inner whitespace collapsed, case-folded."""
    text = unicodedata.normalize("NFC", str(label or ""))
    return " ".join(text.split()).casefold()


def fingerprint(pages: list[dict]) -> str:
    """Pins exactly which page revisions a derived view / snapshot / report was built from."""
    raw = "|".join(sorted(f"{p['id']}:{p['rev']}" for p in pages))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _blocks(page: dict) -> list[dict]:
    content = page.get("content") or {}
    return content["blocks"] if content.get("version") == rich.CONTENT_VERSION else []


def _short(text: str, limit: int = SUMMARY_MAX) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _anchor(page_id: str, block_id: str | None) -> str:
    return "#carnet/" + page_id + ("/" + block_id if block_id else "")


PORTAL_SNAPSHOT_KINDS = ("source", "file", "model", "media")  # the portal kinds Phase 5 already seals; snapshot/review portals stay reference-only


def portal_refs(block: dict) -> list[dict]:
    """The canonical references a PORTAL block adds to a snapshot's closure. Deliberately separate from ``block_refs``: a source
    portal is a document-level card, not a citation, so it must never be counted as one (Ask, cockpit, diff all use ``block_refs``)."""
    if block.get("type") != rich.PORTAL_TYPE or not isinstance(block.get("portal"), dict):
        return []
    ref = block["portal"]["ref"]
    return [{"kind": ref["kind"], "id": ref["id"]}] if ref["kind"] in PORTAL_SNAPSHOT_KINDS else []


# ---------------------------------------------------------------- evidence of one block (canonical refs already on that line)


def block_refs(block: dict) -> list[dict]:
    """``[{kind, id}]`` canonical references attached to ONE block: link marks with a ``ref`` and citations (+ a measure's link).
    External ``href`` links are not canonical evidence and are ignored."""
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add(kind: str, ident: str) -> None:
        if (kind, ident) not in seen:
            seen.add((kind, ident))
            out.append({"kind": kind, "id": ident})

    for mark in block.get("marks", []):
        if mark["type"] == "link" and "ref" in mark:
            add(mark["ref"]["kind"], mark["ref"]["id"])
        elif mark["type"] == "citation":
            add("source", mark["cite"]["src"])
    if block["type"] == rich.DRAWING_TYPE:
        add("drawing", block["drawing"]["id"])
    if block["type"] == "measure":
        link = block["measure"].get("link")
        if isinstance(link, dict) and isinstance(link.get("kind"), str) and isinstance(link.get("id"), str):
            add(link["kind"], link["id"])
    return out


class Ctx:
    """What the pure functions need from the outside, all read-only: page titles and the existence state of references."""

    def __init__(self, title: Callable[[dict], str], ref_state: Callable[[str, str], str], source_info: Callable[[str], dict | None]):
        self._title = title
        self._ref_state = ref_state
        self._source = source_info
        self._cache: dict[tuple[str, str], str] = {}

    def title(self, page: dict) -> str:
        return self._title(page)

    def state(self, kind: str, ident: str) -> str:
        """``ok`` | ``missing`` | ``unknown`` (a failed lookup is NEVER reported as present)."""
        key = (kind, ident)
        if key not in self._cache:
            try:
                got = self._ref_state(kind, ident)
            except Exception:  # noqa: BLE001 - a failing lookup is "unknown", never a silent default
                got = "unknown"
            self._cache[key] = got if got in ("ok", "missing", "unknown") else "unknown"
        return self._cache[key]

    def source(self, ident: str) -> dict | None:
        try:
            return self._source(ident)
        except Exception:  # noqa: BLE001
            return None


def _evidence(ctx: Ctx, block: dict) -> list[dict]:
    out = []
    for ref in block_refs(block):
        row = {"kind": ref["kind"], "id": ref["id"], "state": ctx.state(ref["kind"], ref["id"])}
        if ref["kind"] == "source":
            info = ctx.source(ref["id"])
            if info:
                row["title"] = info.get("title")
        out.append(row)
    return out


# ---------------------------------------------------------------- cockpit


def _verdict_text(status: str) -> str:
    return status if status in VERDICTS else "none"


def _series_band(points: list[dict]) -> dict:
    """``{state: exact|none|variable, lo, hi, unit}``: a band only when EVERY point has the same exact bounds."""
    bounded = [p for p in points if p["lo"] is not None and p["hi"] is not None]
    if not bounded:
        return {"state": "none"}
    if len(bounded) == len(points) and len({(p["lo"], p["hi"]) for p in bounded}) == 1:
        return {"state": "exact", "lo": bounded[0]["lo"], "hi": bounded[0]["hi"], "unit": bounded[0]["unit"]}
    return {"state": "variable"}


def cockpit(project: dict | None, pages: list[dict], ctx: Ctx, events: list[dict] | None = None, notebook_rev: int | None = None) -> dict:
    """The derived overview of ``pages`` (already filtered to ONE project, trash excluded). ``project`` None = pages without project."""
    scanned = pages[: LIMITS["pages_scanned"]]
    decisions: list[dict] = []
    measures: list[dict] = []
    series: dict[tuple[str, str], dict] = {}
    drawings: dict[str, dict] = {}
    sources: dict[str, dict] = {}
    files: dict[tuple[str, str], dict] = {}
    asset_ids: set[str] = set()
    voice_ids: set[str] = set()
    activity: list[dict] = []
    counts = {"in": 0, "out": 0, "none": 0, "incompatible": 0}

    def ref_row(bucket: dict, key: Any, base: dict, page: dict, block_id: str | None) -> None:
        row = bucket.get(key)
        if row is None:
            row = bucket[key] = dict(base, refs=[], refs_total=0)
        row["refs_total"] += 1
        if len(row["refs"]) < LIMITS["refs_per_item"]:
            row["refs"].append({"page_id": page["id"], "block_id": block_id, "page_title": ctx.title(page)})

    for page in scanned:
        title = ctx.title(page)
        activity.append({"at": page["updated_at"], "kind": "page", "page_id": page["id"], "block_id": None, "label": title})
        content = page.get("content") or {}
        if content.get("version") == rich.CONTENT_VERSION:
            asset_ids.update(a["id"] for a in rich.assets_of(content))
            asset_ids.update(x for b in content["blocks"] for x in rich.block_provenance_assets(b))
            voice_ids.update(rich.voices_of(content))
        for block in _blocks(page):
            btype = block["type"]
            if btype == "decision":
                at = block["decision"]["at"]
                decisions.append({
                    "page_id": page["id"], "block_id": block["id"], "page_title": title, "at": at, "text": block["text"],
                    "anchor": _anchor(page["id"], block["id"]), "evidence": _evidence(ctx, block),
                })
                activity.append({"at": at, "kind": "decision", "page_id": page["id"], "block_id": block["id"], "label": _short(block["text"], 80)})
            elif btype == "measure":
                p = block["measure"]
                ev = eng.evaluate(p)
                verdict = _verdict_text(ev["status"])
                counts[verdict] += 1
                point = {
                    "page_id": page["id"], "block_id": block["id"], "page_title": title, "anchor": _anchor(page["id"], block["id"]),
                    "at": p["at"], "label": p["label"], "value": p["observed"]["v"], "unit": p["observed"]["u"], "mode": p["mode"],
                    "nominal": copy.deepcopy(p["nominal"]), "tol": copy.deepcopy(p["tol"]), "verdict": verdict,
                    "lo": ev["lo"], "hi": ev["hi"], "deviation": ev["deviation"],
                    "link": copy.deepcopy(p.get("link")),
                }
                measures.append(point)
                activity.append({"at": p["at"], "kind": "measure", "page_id": page["id"], "block_id": block["id"], "label": _short(p["label"], 80)})
                key = (norm_label(p["label"]), p["observed"]["u"])
                row = series.get(key)
                if row is None:
                    row = series[key] = {"key": key[0] + "\u0000" + key[1], "label": p["label"], "unit": p["observed"]["u"], "points": []}
                row["points"].append(point)
            for ref in block_refs(block):
                kind, ident = ref["kind"], ref["id"]
                if kind == "drawing":
                    ref_row(drawings, ident, {"stem": ident, "state": ctx.state("drawing", ident)}, page, block["id"])
                elif kind == "source":
                    info = ctx.source(ident)
                    ref_row(sources, ident, {"edition_id": ident, "state": ctx.state("source", ident), "title": (info or {}).get("title"),
                                             "archived": bool((info or {}).get("archived")), "file_state": (info or {}).get("file_state")}, page, block["id"])
                elif kind in ("file", "model", "media"):
                    ref_row(files, (kind, ident), {"kind": kind, "path": ident, "state": ctx.state(kind, ident)}, page, block["id"])

    decisions.sort(key=lambda d: (-d["at"], d["page_id"], d["block_id"]))
    decisions_total = len(decisions)
    series_rows = []
    for row in series.values():
        pts = sorted(row["points"], key=lambda p: (p["at"], p["page_id"], p["block_id"]))
        total = len(pts)
        pts = pts[-LIMITS["points_per_series"]:]  # the newest points are kept
        series_rows.append({
            "key": row["key"], "label": row["label"], "unit": row["unit"], "points": pts, "points_total": total,
            "truncated": total > len(pts), "band": _series_band(pts),
            "out": sum(1 for p in pts if p["verdict"] == "out"),
        })
    series_rows.sort(key=lambda s: (-len(s["points"]), norm_label(s["label"]), s["unit"]))
    series_total = len(series_rows)
    for ev in events or []:
        activity.append({"at": ev["at"], "kind": "checkpoint", "page_id": ev.get("page_id"), "block_id": None, "label": ev.get("label") or ev.get("title") or ""})
    activity.sort(key=lambda a: (-a["at"], a["kind"], a["page_id"] or "", a["block_id"] or ""))
    recent = sorted(scanned, key=lambda p: (-p["updated_at"], p["id"]))[: LIMITS["recent_notes"]]
    return {
        "ok": True,
        "project": {"id": project["id"], "name": project["name"], "archived": bool(project.get("archived"))} if project else {"id": None, "name": None, "archived": False},
        "notebook_rev": notebook_rev,
        "fingerprint": fingerprint(scanned),
        "counts": {
            "pages": len(scanned), "decisions": decisions_total, "measurements": len(measures), "out_of_tolerance": counts["out"],
            "images": len(asset_ids), "drawings": len(drawings), "sources": len(sources), "files": len(files), "voices": len(voice_ids),
        },
        "tasks": {"available": False, "reason": "no_canonical_project_association"},
        "measurements": {"total": len(measures), **counts},
        "recent_notes": [{
            "page_id": p["id"], "title": ctx.title(p), "updated_at": p["updated_at"], "category_id": p.get("category_id"),
            "project_id": p.get("project_id"), "anchor": _anchor(p["id"], None),
        } for p in recent],
        "decisions": decisions[: LIMITS["decisions"]],
        "decisions_total": decisions_total,
        "series": series_rows[: LIMITS["series"]],
        "series_total": series_total,
        "drawings": sorted(drawings.values(), key=lambda d: d["stem"]),
        "sources": sorted(sources.values(), key=lambda s: (s["title"] or "", s["edition_id"])),
        "files": sorted(files.values(), key=lambda f: (f["kind"], f["path"])),
        "activity": activity[: LIMITS["recent_activity"]],
        "limits": dict(LIMITS),
        "truncated": {
            "pages": len(pages) > len(scanned), "decisions": decisions_total > LIMITS["decisions"], "series": series_total > LIMITS["series"],
            "points": any(s["truncated"] for s in series_rows),
        },
    }


# ---------------------------------------------------------------- diff (exact: stable block ids + canonical payloads)

_PAYLOAD_KEYS = tuple(["asset", "group", "drawing", "voice", "table", "callout", "toggle", "portal"]) + eng.ENG_TYPES


def _canon(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def block_summary(block: dict) -> str:
    """A short, deterministic, human description of one block (never longer than ``SUMMARY_MAX``)."""
    t = block["type"]
    if t == "measure":
        p = block["measure"]
        return _short(f"{p['label']} : {p['observed']['v']}{(' ' + p['observed']['u']) if p['observed']['u'] else ''}")
    if t == "calc":
        p = block["calc"]
        return _short(f"{p['expr']} = {p['result']}")
    if t == "decision":
        return _short(block["text"])
    if t == "drawing":
        return _short(rich.drawing_label(block["drawing"]["id"]))
    if t == "image":
        a = block["asset"]
        return _short(a.get("caption") or a["id"])
    if t == "imagegroup":
        return f"{len(block['group']['items'])} images"
    if t == "voice":
        return f"Note vocale {block['voice']['dur_ms'] // 1000} s"
    if t == "table":
        rows = block["table"]["rows"]
        return f"Tableau {len(rows)}×{len(rows[0]) if rows else 0}"
    if t == "callout":
        return _short(block["callout"]["title"] or block["callout"]["body"])
    if t == "toggle":
        return _short(block["toggle"]["summary"])
    if t == "portal":  # the STORED reference only (a fixed label + the id): the target's current title is never read here
        return _short(rich.portal_label(block["portal"])[1:-1])
    return _short(block.get("text", ""))


def _payload_of(block: dict) -> Any:
    for key in _PAYLOAD_KEYS:
        if key in block:
            return block[key]
    return None


def _ref_keys(block: dict) -> set[tuple[str, str]]:
    return {(r["kind"], r["id"]) for r in block_refs(block)}


def _measure_detail(a: dict, b: dict) -> list[str]:
    out = []
    for key, name in (("label", "label"), ("observed", "value"), ("nominal", "nominal"), ("tol", "tolerance"), ("mode", "tolerance"), ("link", "link"), ("at", "date")):
        if a.get(key) != b.get(key) and name not in out:
            out.append(name)
    return out


def classify_change(old: dict, new: dict) -> tuple[list[str], dict]:
    """``(tags, detail)`` for two blocks with the same id and different canonical content. Exact comparison only."""
    tags: list[str] = []
    detail: dict[str, Any] = {}
    if old["type"] != new["type"]:
        tags.append("type")
    if old.get("text", "") != new.get("text", ""):
        tags.append("text")
    if old.get("checked") != new.get("checked"):
        tags.append("checked")
    if _canon(old.get("marks", [])) != _canon(new.get("marks", [])):
        before, after = _ref_keys(old), _ref_keys(new)
        src_changed = {k for k in before ^ after if k[0] == "source"}
        ref_changed = {k for k in before ^ after if k[0] != "source"}
        if src_changed:
            tags.append("source")
        if ref_changed:
            tags.append("ref")
        if not (before ^ after):
            tags.append("format")
    if _canon(old.get("from")) != _canon(new.get("from")):
        tags.append("provenance")
    if new.get("from"):
        detail["from"] = copy.deepcopy(new["from"])  # derived text edits are ordinary text changes; the source stays visible
    if old["type"] == new["type"]:
        t = new["type"]
        if t == "decision" and _canon(old["decision"]) != _canon(new["decision"]):
            tags.append("decision")
        elif t == "measure" and _canon(old["measure"]) != _canon(new["measure"]):
            tags.append("measure")
            detail["fields"] = _measure_detail(old["measure"], new["measure"])
        elif t == "calc" and _canon(old["calc"]) != _canon(new["calc"]):
            tags.append("calc")
        elif t == "drawing" and old["drawing"]["id"] != new["drawing"]["id"]:
            tags.append("drawing_version")
            detail["from_stem"], detail["to_stem"] = old["drawing"]["id"], new["drawing"]["id"]
        elif t in ("image", "imagegroup") and _canon(_payload_of(old)) != _canon(_payload_of(new)):
            tags.append("image_group" if t == "imagegroup" else "image")
        elif t == "voice" and _canon(old["voice"]) != _canon(new["voice"]):
            tags.append("voice")
        elif t in ("table", "callout", "toggle") and _canon(_payload_of(old)) != _canon(_payload_of(new)):
            tags.append(t)
        elif t == "portal" and _canon(old["portal"]) != _canon(new["portal"]):
            tags.append("portal_ref" if old["portal"]["ref"] != new["portal"]["ref"] else "portal_view")
            detail["from_ref"], detail["to_ref"] = copy.deepcopy(old["portal"]["ref"]), copy.deepcopy(new["portal"]["ref"])
    if not tags:
        tags.append("other")
    return tags, detail


def _same_block(a: dict, b: dict) -> bool:
    return (
        a["type"] == b["type"] and a.get("text", "") == b.get("text", "") and a.get("checked") == b.get("checked")
        and _canon(a.get("marks", [])) == _canon(b.get("marks", [])) and _canon(_payload_of(a)) == _canon(_payload_of(b))
        and _canon(a.get("from")) == _canon(b.get("from"))
    )


def _legacy_blocks(content: dict) -> list[dict] | None:
    """Content that is not V2 has no stable block ids: it can only be compared as flat text."""
    return content["blocks"] if content.get("version") == rich.CONTENT_VERSION else None


def diff_page(base: dict, cur: dict) -> dict:
    """Exact block diff of two stored page contents (``base`` -> ``cur``)."""
    bb, cb = _legacy_blocks(base), _legacy_blocks(cur)
    if bb is None or cb is None:
        same = rich.flat_text(base) == rich.flat_text(cur)
        return {
            "mode": "text_only", "added": [], "removed": [], "changed": [] if same else [{"id": None, "type": "text", "tags": ["text"], "before": "", "after": "", "detail": {}}],
            "unchanged": 1 if same else 0, "states": {}, "truncated": False,
            "counts": {"added": 0, "removed": 0, "changed": 0 if same else 1},
            "note": "Contenu sans identifiants de bloc stables : comparaison du texte seulement.",
        }
    base_by = {b["id"]: b for b in bb}
    cur_by = {b["id"]: b for b in cb}
    added = [{"id": b["id"], "type": b["type"], "summary": block_summary(b)} for b in cb if b["id"] not in base_by]
    removed = []
    prev_alive: str | None = None
    for b in bb:
        if b["id"] in cur_by:
            prev_alive = b["id"]
        else:
            removed.append({"id": b["id"], "type": b["type"], "summary": block_summary(b), "after_id": prev_alive})
    changed = []
    unchanged = 0
    for b in cb:
        old = base_by.get(b["id"])
        if old is None:
            continue
        if _same_block(old, b):
            unchanged += 1
            continue
        tags, detail = classify_change(old, b)
        changed.append({"id": b["id"], "type": b["type"], "tags": tags, "before": block_summary(old), "after": block_summary(b), "detail": detail})
    states = {a["id"]: "added" for a in added}
    states.update({c["id"]: "changed" for c in changed})
    cap = LIMITS["diff_items"]
    truncated = len(added) > cap or len(removed) > cap or len(changed) > cap
    return {
        "mode": "blocks", "added": added[:cap], "removed": removed[:cap], "changed": changed[:cap], "unchanged": unchanged,
        "states": states if len(states) <= 4 * cap else {}, "truncated": truncated,
        "counts": {"added": len(added), "removed": len(removed), "changed": len(changed)},
    }


def diff_pages(base_pages: list[dict], cur_pages: list[dict], page_state: Callable[[str], str], ctx: Ctx) -> dict:
    """Project level: pages matched by page id. ``page_state(id)`` explains a page absent from ``cur_pages``
    (``trashed`` | ``moved`` | ``deleted``)."""
    cur = {p["id"]: p for p in cur_pages}
    base = {p["id"]: p for p in base_pages}
    rows = []
    for pid, bp in base.items():
        cp = cur.get(pid)
        if cp is None:
            rows.append({"page_id": pid, "title": ctx.title(bp), "status": "removed", "reason": page_state(pid), "counts": None})
            continue
        d = diff_page(bp["content"], cp["content"])
        n = d["counts"]
        status = "changed" if (n["added"] or n["removed"] or n["changed"]) else "unchanged"
        rows.append({"page_id": pid, "title": ctx.title(cp), "status": status, "rev_before": bp["rev"], "rev_after": cp["rev"], "diff": d if status == "changed" else None, "counts": n})
    for pid, cp in cur.items():
        if pid not in base:
            rows.append({"page_id": pid, "title": ctx.title(cp), "status": "added", "rev_after": cp["rev"], "counts": None})
    order = {"changed": 0, "added": 1, "removed": 2, "unchanged": 3}
    rows.sort(key=lambda r: (order[r["status"]], r["title"].casefold(), r["page_id"]))
    return {
        "pages": rows,
        "counts": {s: sum(1 for r in rows if r["status"] == s) for s in order},
    }


# ---------------------------------------------------------------- Markdown of an overview (used by the report builder)

_VERDICT_LABEL = {"in": "dans la tolérance", "out": "hors tolérance", "none": "sans tolérance", "incompatible": "unités incompatibles"}


def _md(text: Any) -> str:
    return rich._md_escape(str(text))


def _when(at: Any) -> str:
    try:
        return eng.fmt_time(int(at))
    except (OverflowError, ValueError, OSError):
        return ""


def render_overview_markdown(ov: dict, snapshot: dict | None = None, heading: bool = True) -> str:
    """Deterministic Markdown of a cockpit (live or from a snapshot): counts, decision trail, measurement series, drawings, sources.
    Every line is a count, a stored value or a fixed label; links are the in-app deep links; nothing is concluded."""
    name = ov["project"]["name"] or "Sans projet"
    out = [f"### Synthèse du projet — {_md(name)}"] if heading else []
    if snapshot:
        out.append(f"**Jalon figé** : {_md(snapshot['label'])} — {_when(snapshot['created_at'])} — `{snapshot['id']}`")
        if snapshot.get("note"):
            out.append(_md(snapshot["note"]))
    c = ov["counts"]
    out.append("\n".join([
        f"- Notes : {c['pages']}", f"- Décisions : {c['decisions']}", f"- Mesures : {c['measurements']} (hors tolérance : {c['out_of_tolerance']})",
        f"- Images : {c['images']}", f"- Croquis : {c['drawings']}", f"- Sources : {c['sources']}", f"- Fichiers référencés : {c['files']}",
    ]))
    if ov["decisions"]:
        out.append("#### Journal des décisions")
        rows = []
        for d in ov["decisions"]:
            ev = ", ".join(f"{e['kind']} {_md(e.get('title') or e['id'])}" + ("" if e["state"] == "ok" else " (indisponible)") for e in d["evidence"])
            rows.append(f"- {_when(d['at'])} — [{_md(d['text'])}]({d['anchor']}) · {_md(d['page_title'])}" + (f" · preuves : {ev}" if ev else ""))
        out.append("\n".join(rows))
    if ov["series"]:
        out.append("#### Mesures")
        for s in ov["series"]:
            unit = f" ({_md(s['unit'])})" if s["unit"] else ""
            band = s["band"]
            tol = f"tolérance {band['lo']} à {band['hi']}" if band["state"] == "exact" else ("tolérance variable" if band["state"] == "variable" else "sans tolérance")
            out.append(f"**{_md(s['label'])}**{unit} — {tol}")
            out.append("\n".join(
                f"- {_when(p['at'])} — [{p['value']}]({p['anchor']}) — {_VERDICT_LABEL[p['verdict']]}" for p in s["points"]
            ))
    if ov["drawings"]:
        out.append("#### Croquis")
        out.append("\n".join(f"- `{d['stem']}`" + ("" if d["state"] == "ok" else " (introuvable)" if d["state"] == "missing" else " (état inconnu)") for d in ov["drawings"]))
    if ov["sources"]:
        out.append("#### Sources")
        out.append("\n".join(f"- {_md(s['title'] or s['edition_id'])}" + ("" if s["state"] == "ok" else " (introuvable)") for s in ov["sources"]))
    return "\n\n".join(out)
