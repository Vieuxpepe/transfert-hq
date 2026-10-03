"""Carnet Stage 08: report assembly (read-only, stdlib only).

``report_build`` turns an EXPLICIT, user-ordered list of already-written material into ordered Markdown (plus the same
material as structured sections for the print view). It organizes and renders; it never infers or authors anything:

* every line of the output is either a user-authored line (rendered by the existing Markdown renderer, so citations,
  measurements with their "non certifié" wording, image captions and decisions are preserved as written) or one of the
  fixed structural labels in ``LABELS`` (``Note``, ``Mesure``, ``Décision``, ``Photo``, ``Source``, ``Sources citées``…);
* the order is exactly the order of ``items``; nothing is added, merged or reordered, except the final
  "Sources citées" appendix (editions cited by the selected material, in order of first appearance);
* the notebook is never written. Each page item carries the revision the user selected; a page that changed since is
  reported ``409 report_stale`` and NOTHING is generated from newer content silently;
* no absolute path ever appears: images are package-relative (``<stem>.assets/figure-NN.<ext>``), a source file is shown as
  the stored RELATIVE reference.

With ``export`` the Markdown (+ images) is written below Inbox/Uni/Print by the same confined, never-overwriting writer as the
page export; otherwise it is only returned.
"""

from __future__ import annotations

import copy
import re
from typing import Any

import hq_carnet_ask as ask
import hq_carnet_media as media
import hq_carnet_intel as intel
import hq_carnet_portals as portals
import hq_carnet_review as review
import hq_carnet_evidence as evidence
import hq_carnet_reviews as reviews
import hq_carnet_rich as rich
import hq_carnet_snapshots as snapshots
import hq_carnet_sources as sources
import hq_state

ITEMS_MAX = 200
TITLE_MAX = 120
KINDS = ("note", "measure", "decision", "photo", "drawing", "source", "project_overview", "ask_evidence", "review_pack")  # a drawing is its OWN kind: never a photo
BLOCK_KIND = {"measure": "measure", "decision": "decision", "photo": "image", "drawing": "drawing"}
LABELS = {
    "note": "Note", "measure": "Mesure", "decision": "Décision", "photo": "Photo", "drawing": "Croquis", "source": "Source", "project_overview": "Synthèse du projet", "ask_evidence": "Preuves du carnet", "review_pack": "Dossier de revue",
    "sources_cited": "Sources citées", "default_title": "Rapport",
}
FIELD_LABELS = (("author", "Auteur"), ("edition", "Édition"), ("year", "Année"), ("publisher", "Éditeur"), ("identifier", "Identifiant"), ("type", "Type"), ("url", "Lien"), ("file_ref", "Fichier"))


def _hc():
    import hq_carnet

    return hq_carnet


def _err(message: str):
    return _hc().CarnetError(message)


def _item(raw: Any) -> dict:
    hc = _hc()
    if not isinstance(raw, dict) or raw.get("kind") not in KINDS:
        raise _err("Élément de rapport invalide")
    kind = raw["kind"]
    if kind == "source":
        if set(raw) != {"kind", "edition_id"} or not isinstance(raw["edition_id"], str) or not sources._ID_RE["srce"].match(raw["edition_id"]):
            raise _err("Élément de rapport invalide")
        return {"kind": kind, "edition_id": raw["edition_id"]}
    if kind == "project_overview":
        # LIVE (pinned by the fingerprint of the project's page revisions) or FROZEN (an immutable snapshot id)
        if set(raw) == {"kind", "snapshot_id"} and isinstance(raw["snapshot_id"], str) and snapshots.ID_RE.match(raw["snapshot_id"]):
            return {"kind": kind, "snapshot_id": raw["snapshot_id"]}
        if (set(raw) == {"kind", "project_id", "fingerprint"} and isinstance(raw["project_id"], str)
                and (raw["project_id"] == "none" or hc._ID_RE["proj"].match(raw["project_id"]))
                and isinstance(raw["fingerprint"], str) and re.match(r"^[0-9a-f]{32}\Z", raw["fingerprint"])):
            return {"kind": kind, "project_id": raw["project_id"], "fingerprint": raw["fingerprint"]}
        raise _err("Élément de rapport invalide")
    if kind == "review_pack":
        # HISTORICAL by default: the pack is rendered as it is stored (its own revision and seal are shown), with a separate freshness
        # observation made now. It is never "stale"-pinned: evidence that changed is marked in the section, not refused.
        if set(raw) != {"kind", "review_id"} or not isinstance(raw["review_id"], str) or not reviews.ID_RE.match(raw["review_id"]):
            raise _err("Élément de rapport invalide")
        return {"kind": kind, "review_id": raw["review_id"]}
    if kind == "ask_evidence":
        # an EXPLICIT user action: the search is re-run at build time and refused (report_stale) if its scope changed since
        q, sc = raw.get("question"), raw.get("scope")
        ok_scope = (isinstance(sc, dict) and sc.get("kind") in ask.SCOPES and set(sc) == ({"kind"} if sc.get("kind") == "notebook" else {"kind", "id"})
                    and (sc.get("kind") == "notebook" or isinstance(sc.get("id"), str)))
        if (set(raw) != {"kind", "question", "scope", "fingerprint"} or not isinstance(q, str) or not q.strip() or len(q) > ask.LIMITS["question_chars"]
                or not ok_scope or not isinstance(raw["fingerprint"], str) or not re.match(r"^[0-9a-f]{32}\Z", raw["fingerprint"])):
            raise _err("Élément de rapport invalide")
        return {"kind": kind, "question": q, "scope": dict(sc), "fingerprint": raw["fingerprint"]}
    keys = {"kind", "page_id", "rev"} | (set() if kind == "note" else {"block_id"})
    if set(raw) != keys or not isinstance(raw["page_id"], str) or not hc._ID_RE["page"].match(raw["page_id"]) or not hc._is_int(raw["rev"]) or raw["rev"] < 1:
        raise _err("Élément de rapport invalide")
    out = {"kind": kind, "page_id": raw["page_id"], "rev": raw["rev"]}
    if kind != "note":
        if not isinstance(raw["block_id"], str) or not hc._ID_RE["block"].match(raw["block_id"]):
            raise _err("Élément de rapport invalide")
        out["block_id"] = raw["block_id"]
    return out


def _cited_editions(blocks: list[dict]) -> list[str]:
    out: list[str] = []
    for block in blocks:
        for mark in block["marks"]:
            if mark["type"] == "citation" and mark["cite"]["src"] not in out:
                out.append(mark["cite"]["src"])
        if block["type"] == "measure":
            link = block["measure"].get("link")
            if isinstance(link, dict) and link.get("kind") == "source" and link["id"] not in out:
                out.append(link["id"])
    return out


def _md_edition(ed: dict | None, ident: str) -> str:
    if ed is None:
        return f"- {rich._md_escape(ident)} (édition introuvable)"
    head = "**" + rich._md_escape(ed["title"]) + "**"
    parts = []
    for key, label in FIELD_LABELS:
        value = ed.get(key)
        if value in (None, "", 0):
            continue
        parts.append(f"{label} : {rich._md_escape(str(value))}")
    return "- " + head + (" — " + " ; ".join(parts) if parts else "")


def build(data: Any) -> dict:
    hc = _hc()
    if not isinstance(data, dict):
        raise _err("Requête invalide")
    hc._only_keys(data, {"action", "title", "items", "include_sources", "export"})
    title = data.get("title")
    if title is not None and (not isinstance(title, str) or len(title) > TITLE_MAX or any(ord(c) < 32 or 0x7F <= ord(c) <= 0x9F for c in title)):
        raise _err("Titre invalide")
    title = (title or "").strip() or LABELS["default_title"]
    raw_items = data.get("items")
    if not isinstance(raw_items, list) or not raw_items or len(raw_items) > ITEMS_MAX:
        raise _err(f"Sélection invalide (1 à {ITEMS_MAX} éléments)")
    items = [_item(r) for r in raw_items]
    include_sources = data.get("include_sources", True)
    if not isinstance(include_sources, bool):
        raise _err("include_sources invalide")
    export = data.get("export")
    parts: list[str] | None = None
    filename = None
    if export is not None:
        if not isinstance(export, dict) or set(export) - {"dir", "filename"}:
            raise _err("Export invalide")
        parts = hc._export_parts(export.get("dir"))
        filename = export.get("filename")
        if filename is not None and (not isinstance(filename, str) or len(filename) > 200):
            raise _err("Nom de fichier invalide")
    sections: list[dict] = []
    overview_items: list[tuple[int, dict]] = []
    ask_items: list[tuple[int, dict]] = []
    review_items: list[tuple[int, dict]] = []
    stale: list[str] = []
    page_revs: dict[str, int] = {}
    with hq_state.path_lock(hc._path()):  # ONE consistent snapshot of the notebook
        state = hc._load_locked(create=False)
        pages = {p["id"]: p for p in state["pages"]}
        for item in items:
            if item["kind"] == "source":
                sections.append({"kind": "source", "edition_id": item["edition_id"]})
                continue
            if item["kind"] == "project_overview":
                overview_items.append((len(sections), item))
                sections.append({"kind": "project_overview"})
                continue
            if item["kind"] == "review_pack":
                review_items.append((len(sections), item))
                sections.append({"kind": "review_pack"})
                continue
            if item["kind"] == "ask_evidence":
                ask_items.append((len(sections), item))
                sections.append({"kind": "ask_evidence"})
                continue
            page = pages.get(item["page_id"])
            if page is None:
                raise hc.CarnetNotFound("Page introuvable")
            if page["rev"] != item["rev"]:
                if page["id"] not in stale:
                    stale.append(page["id"])
                continue
            if page["deleted_at"] is not None:
                raise _err("Page dans la corbeille — restaure-la d'abord")
            page_revs[page["id"]] = page["rev"]
            ptitle = hc.derive_title(rich.flat_text(page["content"]))
            content = page["content"]
            if item["kind"] == "note":
                blocks = copy.deepcopy(content["blocks"]) if content["version"] == rich.CONTENT_VERSION else [
                    {"id": f"block-{i}", "type": "paragraph", "text": line, "marks": []} for i, line in enumerate(content["blocks"][0]["text"].split("\n"))
                ]
            else:
                found = next((b for b in content["blocks"] if b["id"] == item["block_id"]), None) if content["version"] == rich.CONTENT_VERSION else None
                want = (BLOCK_KIND[item["kind"]], rich.GROUP_TYPE) if item["kind"] == "photo" else (BLOCK_KIND[item["kind"]],)  # a photo item may be an image group
                if found is None or found["type"] not in want:
                    raise hc.CarnetNotFound("Bloc introuvable")
                blocks = [copy.deepcopy(found)]
            sections.append({"kind": item["kind"], "page_id": page["id"], "page_title": ptitle, "blocks": blocks})
        notebook_rev = state["notebook_rev"]
    for index, item in overview_items:  # derived views, computed after the page capture; a changed project is STALE, never silently newer
        if "snapshot_id" in item:
            ov = review.snapshot_cockpit(item["snapshot_id"], trusted=True)
            sections[index].update(overview=ov, snapshot=ov["snapshot"])
        else:
            ov = review.cockpit(item["project_id"])
            if ov["fingerprint"] != item["fingerprint"]:
                stale.append(item["project_id"])
                continue
            sections[index].update(overview=ov, snapshot=None)
    for index, item in ask_items:  # evidence is searched NOW; a scope that changed since the selection is stale, never silently newer
        res = review.ask({"action": "ask", "question": item["question"], "scope": item["scope"]})
        if res["fingerprint"] != item["fingerprint"]:
            stale.append(item["scope"].get("id") or "notebook")
            continue
        sections[index].update(ask=res)
    for index, item in review_items:  # the stored pack + a separate observation; one unreadable pack refuses the report, nothing is guessed
        got = reviews.get(item["review_id"])
        sections[index].update(review=got["review"], integrity=got["integrity"], freshness=evidence.freshness(got["review"]))
    refs_seen: dict[tuple[str, str], dict] = {}
    for sec in sections:  # Phase 8: the CURRENT state of every portal in the rendered blocks, resolved in bounded batches (read-only)
        for b in sec.get("blocks", ()):
            if b.get("type") == rich.PORTAL_TYPE:
                r = b["portal"]["ref"]
                refs_seen.setdefault((r["kind"], r["id"]), {"kind": r["kind"], "id": r["id"]})
    portal_states: dict[tuple[str, str], dict] = {}
    pending = list(refs_seen.values())
    for at in range(0, len(pending), portals.REFS_MAX):
        for row in portals.resolve({"action": "portal_resolve", "refs": pending[at : at + portals.REFS_MAX]})["results"]:
            portal_states[(row["ref"]["kind"], row["ref"]["id"])] = row
    if stale:
        raise hc.CarnetConflict({"error": "Des pages ont changé depuis la sélection — rien n'a été généré", "code": "report_stale", "stale": stale, "notebook_rev": notebook_rev})
    try:
        with hq_state.path_lock(sources.confined_path()):
            sstate = copy.deepcopy(sources._load_locked())
    except sources.SourceStorageError as e:
        raise hc.CarnetStorageError(str(e), e.status) from e
    editions = {e["id"]: e for e in sstate["editions"]}
    for sec in sections:
        if sec["kind"] == "source":
            sec["edition"] = editions.get(sec["edition_id"])
    cited: list[str] = []
    for sec in sections:
        if sec["kind"] in ("note", "measure", "decision", "photo"):
            for ident in _cited_editions(sec["blocks"]):
                if ident not in cited:
                    cited.append(ident)
    images: list[dict] = []
    for sec in sections:
        if sec["kind"] in ("note", "photo"):
            images.extend(a for b in sec["blocks"] for a in rich.block_assets(b))
    package_images = [a for n, a in enumerate(images) if a["id"] not in {x["id"] for x in images[:n]}]

    def render(asset_paths: dict[str, str] | None) -> str:
        out = ["# " + rich._md_escape(title)]
        for sec in sections:
            label = LABELS[sec["kind"]]
            if sec["kind"] == "project_overview":
                out.append(f"## {label} — " + rich._md_escape(sec["overview"]["project"]["name"] or "Sans projet"))
                out.append(intel.render_overview_markdown(sec["overview"], sec["snapshot"], heading=False))
                continue
            if sec["kind"] == "review_pack":
                body = evidence.render_markdown(sec["review"], sec["freshness"], sec["integrity"]).splitlines()
                out.append(f"## {label} — " + rich._md_escape(sec["review"]["title"]))
                out.append("\n".join(("##" + ln) if ln.startswith("#") else ln for ln in body[1:]).strip("\n"))
                continue
            if sec["kind"] == "ask_evidence":
                out.append(f"## {label} — « " + rich._md_escape(sec["ask"]["question"]) + " »")
                out.append(ask.render_markdown(sec["ask"], heading=False))
                continue
            if sec["kind"] == "source":
                ed = sec["edition"]
                out.append(f"## {label} — " + rich._md_escape(ed["title"] if ed else sec["edition_id"]))
                out.append(_md_edition(ed, sec["edition_id"]))
                continue
            out.append(f"## {label} — " + rich._md_escape(sec["page_title"]))
            out.append(rich.render_markdown({"version": rich.CONTENT_VERSION, "blocks": sec["blocks"]}, asset_paths, portal_states).rstrip("\n"))
        if include_sources and cited:
            out.append("## " + LABELS["sources_cited"])
            out.append("\n".join(_md_edition(editions.get(i), i) for i in cited))
        return "\n\n".join(out) + "\n"

    name_stem = title
    result: dict[str, Any] = {
        "ok": True, "title": title, "items": len(items), "page_revs": page_revs, "sources_rev": sstate["sources_rev"], "notebook_rev": notebook_rev,
        "sections": [_public_section(s, portal_states) for s in sections], "cited": [_public_edition(editions.get(i), i) for i in cited] if include_sources else [],
    }
    if parts is None:
        stem = rich.sanitize_stem(name_stem, "rapport")
        paths = {a["id"]: f"{stem}.assets/figure-{n + 1:02d}{media.MIME_EXT[a['mime']]}" for n, a in enumerate(package_images)}
        result["markdown"] = render(paths or None)
        result["assets"] = [{"id": i, "path": p} for i, p in paths.items()]
        return result
    name = rich.export_filename(filename, name_stem, "md")
    leaf_ok = hc._cb.get("safe_leaf_name")
    if callable(leaf_ok) and leaf_ok(name) is None:
        raise _err("Nom de fichier invalide")
    directory = hc._export_dir(hc._cb["root"], parts)
    size, package, assets = hc._write_export(directory, name, package_images, render, leaf_ok)
    result.update(path="/".join(parts + [name]), name=name, bytes=size, format="md", exported_at=hc._now())
    if package is not None:
        result.update(assets_dir="/".join(parts + [package.name]), assets_count=assets)
    return result


def _public_edition(ed: dict | None, ident: str) -> dict:
    if ed is None:
        return {"id": ident, "missing": True}
    return {"id": ed["id"], "title": ed["title"], "author": ed["author"], "edition": ed["edition"], "year": ed["year"], "publisher": ed["publisher"], "identifier": ed["identifier"], "type": ed["type"], "url": ed["url"], "file_ref": ed["file_ref"]}


def _public_section(sec: dict, portal_states: dict | None = None) -> dict:
    if sec["kind"] == "project_overview":
        return {"kind": "project_overview", "label": LABELS["project_overview"], "overview": sec["overview"], "snapshot": sec["snapshot"]}
    if sec["kind"] == "review_pack":
        return {"kind": "review_pack", "label": LABELS["review_pack"], "review": sec["review"], "integrity": sec["integrity"], "freshness": sec["freshness"]}
    if sec["kind"] == "ask_evidence":
        return {"kind": "ask_evidence", "label": LABELS["ask_evidence"], "ask": sec["ask"]}
    if sec["kind"] == "source":
        return {"kind": "source", "edition": _public_edition(sec["edition"], sec["edition_id"])}
    out = {"kind": sec["kind"], "label": LABELS[sec["kind"]], "page_id": sec["page_id"], "page_title": sec["page_title"], "blocks": sec["blocks"]}
    found = [(portal_states or {}).get((b["portal"]["ref"]["kind"], b["portal"]["ref"]["id"])) for b in sec["blocks"] if b.get("type") == rich.PORTAL_TYPE]
    if found:  # the state resolved at build time, beside (never inside) the stored blocks
        out["portals"] = [{"ref": r["ref"], "kind_label": r["kind_label"], "state": r["state"], "state_label": r["state_label"], "title": r["title"]} for r in found if r is not None]
    return out
