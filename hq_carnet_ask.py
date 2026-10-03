"""Carnet Phase 6: Ask Carnet — EVIDENCE-ONLY retrieval over canonical Carnet data (stdlib only, nothing is stored).

Ask Carnet does NOT generate an answer. Given a question and an explicit scope it returns the canonical blocks that contain the
question's terms, as *evidence cards*: exact excerpt (with the matched spans), page / block, a stable deep link
``#carnet/<pageId>/<blockId>``, the canonical references already on that line, and — for text DERIVED from a scan (OCR) or a voice
note (transcript) — the provenance relation to its canonical source. It states plainly when the evidence is insufficient.

Hard rules (each one is pinned by tests):

* No model, no network, no summary, no inference. Nothing is persisted: a question and its result exist only in the response (and in
  an explicit report item, which re-runs the search and refuses a changed scope).
* Deterministic lexical matching: Unicode NFKD accent-folding, case-folding, tokens of letters/digits (decimal numbers kept whole,
  a decimal comma read as a point), a simple plural fold (a trailing ``s`` of tokens longer than 3). No fuzzy matching, no embeddings,
  no synonyms. Quoted phrases and adjacent terms only add a bonus, never a requirement.
* A card is evidence of what a block SAYS. It carries no author, approval, acceptance, status or rationale: none is recorded
  (a decision card is a journal line with its timestamp, nothing more).
* Derived text (``from``: ocr/transcript) is labelled DERIVED and always exposes its source relation: the source asset/voice id,
  whether it still exists, and the canonical block (image / voice) that holds it when that block is in scope. It is never presented
  as primary evidence. When the source is missing the card says so.
* A frozen snapshot is searched only when its seal verifies. Its cards carry the snapshot identity and no live link unless the very
  same block (exact payload) still exists in the live notebook.
* Everything is bounded (``LIMITS``); anything cut is reported (``incomplete``) and an insufficient result then says the scan was
  limited, because absence of evidence in a partial scan is not evidence of absence.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import unicodedata
from typing import Any, Callable

import hq_carnet_eng as eng
import hq_carnet_intel as intel
import hq_carnet_rich as rich

LIMITS = {
    "question_chars": 300,
    "terms": 12,
    "pages_scanned": 256,
    "units_scanned": 40000,
    "cards": 20,
    "cards_default": 10,
    "partial_cards": 5,
    "excerpt_chars": 240,
    "refs_per_card": 20,
    "cited_in": 5,
}
STATUSES = ("evidence", "partial", "insufficient", "empty_query")
SCOPES = ("page", "project", "notebook", "snapshot")
NOT_GENERATED = (
    "Aucune réponse n'est générée : seules les preuves du carnet sont listées, telles qu'elles sont écrites. "
    "Aucun auteur, statut, approbation ni justification n'est déduit."
)
DERIVED_LABEL = rich.DERIVED_LABEL

_STOP = frozenset(
    "a au aux avec ce ces dans de des du elle en et eux il ils je la le les leur lui ma mais me meme mes moi mon ne nos notre nous on ou par pas pour "
    "qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous c d j l m n s t y est sont etre ete suis es sommes etes fut ai as avons "
    "avez ont quel quelle quels quelles quoi comment pourquoi quand combien ou ci ca cela celui celle ceux "
    "the an of and or to in for on at by is are was were be been it its this that these those what which who whom whose why when where how with from as "
    "do does did has have had i you he she we they me my our your their not no".split()
)
_TOKEN_RE = re.compile(r"\d+(?:[.,]\d+)?|[^\W\d_]+\d*")
_PHRASE_RE = re.compile(r'"([^"]{1,200})"')


# ---------------------------------------------------------------- text normalisation (deterministic, no fuzziness)


def fold(text: Any) -> str:
    """Accent-folded, case-folded text (NFKD, combining marks dropped, ``œ``/``æ``/``ß`` expanded by casefold/NFKD)."""
    decomposed = unicodedata.normalize("NFKD", str(text or ""))
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold()


def _stem(token: str) -> str:
    return token[:-1] if len(token) > 3 and token.endswith("s") and not token.endswith("ss") and not token[-2].isdigit() else token


def tokens(text: Any) -> list[str]:
    out = []
    for m in _TOKEN_RE.finditer(fold(text)):
        t = m.group(0)
        out.append(_stem(t.replace(",", ".")))
    return out


def _token_spans(text: str) -> list[tuple[int, int, str]]:
    """Tokens of ``text`` with their character spans IN ``text``: the folding is done per character with a position map, so it
    stays exactly consistent with ``tokens`` even when one character folds to several (``ß`` -> ``ss``)."""
    folded: list[str] = []
    pos: list[int] = []
    for i, ch in enumerate(text):
        f = fold(ch)
        folded.append(f)
        pos.extend([i] * len(f))
    flat = "".join(folded)
    return [(pos[m.start()], pos[m.end() - 1] + 1, _stem(m.group(0).replace(",", "."))) for m in _TOKEN_RE.finditer(flat)]


def parse_question(question: Any) -> dict:
    """``{terms, phrases, truncated}``: unique non-stop terms in question order (max ``LIMITS['terms']``) and quoted phrases."""
    if not isinstance(question, str):
        return {"terms": [], "phrases": [], "truncated": False, "stop_only": False}
    phrases = []
    for m in _PHRASE_RE.finditer(question):
        toks = tokens(m.group(1))
        if len(toks) >= 2:
            phrases.append(toks)
    seen: set[str] = set()
    terms: list[str] = []
    raw = [m.group(0) for m in _TOKEN_RE.finditer(fold(question))]
    for r in raw:
        t = _stem(r.replace(",", "."))
        if r in _STOP or t in seen:
            continue
        seen.add(t)
        terms.append(t)
    truncated = len(terms) > LIMITS["terms"]
    return {"terms": terms[: LIMITS["terms"]], "phrases": phrases, "truncated": truncated, "stop_only": bool(raw) and not terms}


# ---------------------------------------------------------------- units of evidence


def _unit(page: dict, index: int, block: dict, kind: str, text: str, extra: dict | None = None) -> dict:
    return {"page": page, "index": index, "block": block, "kind": kind, "text": text, **(extra or {})}


def _measure_text(p: dict) -> str:
    obs = p["observed"]
    parts = [p["label"], f"{obs['v']} {obs['u']}".strip()]
    if p.get("nominal"):
        parts.append(f"{p['nominal']['v']} {p['nominal']['u']}".strip())
    if p.get("tol"):
        parts.append(f"{p['tol'].get('t', '')} {p['tol'].get('u', '')}".strip())
    return " ".join(x for x in parts if x)


def units_of(page: dict) -> list[dict]:
    """The searchable units of one page, in reading order: a text block, a table ROW, an image caption … Never an id, key or mark."""
    content = page.get("content") or {}
    blocks = content.get("blocks") or []
    out: list[dict] = []
    for i, block in enumerate(blocks):
        if not isinstance(block, dict):
            continue
        t = block.get("type")
        if t in ("paragraph", "heading", "bullet", "number", "check", "text"):
            if block.get("text"):
                out.append(_unit(page, i, block, "note", block["text"]))
        elif t == "decision":
            out.append(_unit(page, i, block, "decision", block.get("text", "")))
        elif t == "measure":
            out.append(_unit(page, i, block, "measure", _measure_text(block["measure"])))
        elif t == "calc":
            p = block["calc"]
            out.append(_unit(page, i, block, "calc", f"{p['expr']} = {p['result']}"))
        elif t == rich.TABLE_TYPE:
            for r, row in enumerate(block["table"]["rows"]):
                line = " | ".join(c for c in row if c)
                if line:
                    out.append(_unit(page, i, block, "table", line, {"row": r, "cells": list(row)}))
        elif t == rich.CALLOUT_TYPE:
            c = block["callout"]
            out.append(_unit(page, i, block, "callout", " — ".join(x for x in (c["title"], c["body"]) if x)))
        elif t == rich.TOGGLE_TYPE:
            c = block["toggle"]
            out.append(_unit(page, i, block, "toggle", " — ".join(x for x in (c["summary"], c["body"]) if x)))
        elif t == rich.IMAGE_TYPE:
            if block["asset"].get("caption"):
                out.append(_unit(page, i, block, "image", block["asset"]["caption"]))
        elif t == rich.GROUP_TYPE:
            for k, item in enumerate(block["group"]["items"]):
                if item.get("caption"):
                    out.append(_unit(page, i, block, "image", item["caption"], {"item": k}))
        elif t == rich.DRAWING_TYPE:
            out.append(_unit(page, i, block, "drawing", rich.drawing_label(block["drawing"]["id"])))
        elif t == rich.PORTAL_TYPE:
            # Phase 8: STORED identity only (fixed kind label + the id/path actually in the page). Never the target's current title,
            # contents or status: searching a frozen page must not mix its frozen reference with mutable live metadata.
            ref = block["portal"]["ref"]
            out.append(_unit(page, i, block, "portal", f"Portail {rich.PORTAL_LABEL[ref['kind']]} {ref['id']}"))
    return out


# ---------------------------------------------------------------- scoring


def _score(units: list[dict], parsed: dict) -> list[dict]:
    terms = parsed["terms"]
    n_units = len(units)
    toks = [tokens(u["text"]) for u in units]
    df = {t: sum(1 for tk in toks if t in tk) for t in terms}
    weight = {t: math.log(1 + (n_units + 1) / (df[t] + 1)) for t in terms}
    out = []
    for u, tk in zip(units, toks):
        hit = [t for t in terms if t in tk]
        if not hit:
            continue
        score = 0.0
        for t in hit:
            score += weight[t] * (1 + math.log(tk.count(t)))
        # adjacency bonus: consecutive query terms that are consecutive in the unit; quoted phrases count double
        for a, b in zip(terms, terms[1:]):
            if any(tk[i] == a and tk[i + 1] == b for i in range(len(tk) - 1)):
                score += 0.5
        for ph in parsed["phrases"]:
            if any(tk[i : i + len(ph)] == ph for i in range(len(tk) - len(ph) + 1)):
                score += 1.0
        score /= 1 + 0.1 * math.log(1 + len(tk))
        out.append({"unit": u, "hit": hit, "coverage": len(hit) / len(terms), "score": round(score, 6)})
    return out


def _needed(n_terms: int) -> int:
    if n_terms <= 2:
        return n_terms
    return math.ceil(n_terms * 0.6)


def _excerpt(text: str, terms: list[str]) -> tuple[str, list[list[int]]]:
    spans = [(s, e) for s, e, tok in _token_spans(text) if tok in terms]
    limit = LIMITS["excerpt_chars"]
    start = 0
    if len(text) > limit and spans:
        start = max(0, min(spans[0][0] - limit // 4, len(text) - limit))
    end = min(len(text), start + limit)
    shown = text[start:end]
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    marks = [[s - start + len(prefix), e - start + len(prefix)] for s, e in spans if s >= start and e <= end]
    return prefix + shown + suffix, marks


# ---------------------------------------------------------------- derived-text provenance


def _source_index(pages: list[dict]) -> dict[str, tuple[dict, dict]]:
    """``source id -> (page, block)`` for every image / image-group item / voice block of the scope (first one in page order wins)."""
    idx: dict[str, tuple[dict, dict]] = {}
    for page in pages:
        for block in (page.get("content") or {}).get("blocks") or []:
            if not isinstance(block, dict):
                continue
            t = block.get("type")
            if t == rich.IMAGE_TYPE:
                idx.setdefault(block["asset"]["id"], (page, block))
            elif t == rich.GROUP_TYPE:
                for item in block["group"]["items"]:
                    idx.setdefault(item["id"], (page, block))
            elif t == rich.VOICE_TYPE:
                idx.setdefault(block["voice"]["id"], (page, block))
    return idx


def _provenance(unit: dict, index: dict, state: Callable[[str, str], str], title: Callable[[dict], str], frozen: bool) -> dict | None:
    src = unit["block"].get("from")
    if not isinstance(src, dict) or src.get("kind") not in rich.FROM_KINDS:
        return None
    kind, source_kind, source_id = src["kind"], src["source_kind"], src["source_id"]
    holder = index.get(source_id)
    # the canonical block on the SAME page wins over one on another page of the scope
    for block in unit["page"]["content"]["blocks"]:
        if isinstance(block, dict) and (
            (block.get("type") == rich.IMAGE_TYPE and block["asset"]["id"] == source_id)
            or (block.get("type") == rich.GROUP_TYPE and any(i["id"] == source_id for i in block["group"]["items"]))
            or (block.get("type") == rich.VOICE_TYPE and block["voice"]["id"] == source_id)
        ):
            holder = (unit["page"], block)
            break
    row: dict[str, Any] = {
        "derived": True,
        "kind": kind,
        "label": DERIVED_LABEL[kind],
        "source": {"kind": source_kind, "id": source_id, "state": state(source_kind, source_id), "block": None},
    }
    if holder is not None:
        page, block = holder
        row["source"]["block"] = {
            "page_id": page["id"], "page_title": title(page), "block_id": block.get("id"), "type": block["type"],
            "link": None if frozen else intel._anchor(page["id"], block.get("id")),
        }
    return row


# ---------------------------------------------------------------- the search itself (pure)


def _card_id(page_id: str, block_id: str | None, row: Any) -> str:
    raw = f"{page_id}|{block_id}|{row}"
    return "ask-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _frozen_link(live_blocks: dict[tuple[str, str], dict] | None, page_id: str, block: dict) -> tuple[str | None, str]:
    """For a frozen card: ``(live link or None, unchanged|changed|gone)``. A live link exists ONLY if the exact same block is still there."""
    if live_blocks is None:
        return None, "gone"
    live = live_blocks.get((page_id, block.get("id")))
    if live is None:
        return None, "gone"
    return (intel._anchor(page_id, block["id"]), "unchanged") if intel._same_block(live, block) else (None, "changed")


def evidence_fingerprint(res: dict) -> str:
    """Seal of WHAT THE USER WOULD CITE: scope identity, effective terms, status, every card and source card as shown (text, spans, links,
    provenance, reference states, frozen/live comparison). Ranking scores are excluded. A report item pinned to it goes stale when any
    cited fact changes — page text, source metadata, the existence of a referenced source / drawing / image / voice note — and not when
    something unrelated to the cited evidence changes."""
    cards = [{k: v for k, v in c.items() if k != "score"} for c in res.get("cards") or []]
    payload = {
        "v": 2,
        "scope": {k: (res.get("scope") or {}).get(k) for k in ("kind", "id", "label")},
        "terms": res.get("terms"), "status": res.get("status"), "reason": res.get("reason"), "incomplete": res.get("incomplete"),
        "frozen": (res.get("frozen") or {}).get("fingerprint"), "cards": cards, "sources": res.get("sources") or [],
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("ascii")).hexdigest()[:32]


def search(question: Any, pages: list[dict], ctx: intel.Ctx, **kw: Any) -> dict:
    """Evidence cards for ``question`` (see ``_search``). ``fingerprint`` is the EVIDENCE seal; ``scope_fingerprint`` is the page-revision
    fingerprint of the scanned scope (informational: it moves on any edit, cited or not)."""
    out = _search(question, pages, ctx, **kw)
    out["scope_fingerprint"] = out["fingerprint"]
    out["fingerprint"] = evidence_fingerprint(out)
    return out


def _search(question: Any, pages: list[dict], ctx: intel.Ctx, *, scope: dict, sources: dict[str, dict] | None = None,
            limit: int = LIMITS["cards_default"], state: Callable[[str, str], str] | None = None, frozen: dict | None = None,
            live_blocks: dict[tuple[str, str], dict] | None = None, notebook_rev: int | None = None,
            current: Callable[[str, str], str] | None = None) -> dict:
    """Evidence cards for ``question`` over ``pages`` (already restricted to the scope by the caller). Pure and deterministic.
    In a frozen scope ``ctx`` / ``sources`` describe the snapshot and ``current`` gives the live state of a reference, reported separately."""
    if not isinstance(question, str):
        raise ValueError("question")
    limit = max(1, min(int(limit), LIMITS["cards"]))
    parsed = parse_question(question)
    state = state or ctx.state
    base = {
        "ok": True, "scope": scope, "question": question, "terms": parsed["terms"], "terms_truncated": parsed["truncated"],
        "fingerprint": frozen["fingerprint"] if frozen else intel.fingerprint(pages), "notebook_rev": notebook_rev,
        "frozen": frozen, "limits": dict(LIMITS), "note": NOT_GENERATED,
    }
    if not parsed["terms"]:
        return {**base, "status": "empty_query", "reason": "stop_words_only" if parsed["stop_only"] else "empty", "cards": [], "partial": False,
                "counts": {"pages": len(pages), "units": 0, "matched": 0, "evidence": 0}, "unmatched_terms": [], "incomplete": False}
    scanned_pages = pages[: LIMITS["pages_scanned"]]
    incomplete = len(pages) > len(scanned_pages)
    units: list[dict] = []
    for page in scanned_pages:
        for u in units_of(page):
            if len(units) >= LIMITS["units_scanned"]:
                incomplete = True
                break
            units.append(u)
    index = _source_index(scanned_pages)
    scored = _score(units, parsed)
    need = _needed(len(parsed["terms"]))
    order = lambda r: (-r["coverage"], -r["score"], 1 if r["unit"]["block"].get("from") else 0, r["unit"]["page"]["id"], r["unit"]["index"], r["unit"].get("row", -1))  # noqa: E731
    scored.sort(key=order)
    strong = [r for r in scored if len(r["hit"]) >= need and r["unit"]["kind"] != "portal"]  # a portal card is a REFERENCE, never primary evidence
    portal_hits = [r for r in scored if len(r["hit"]) >= need and r["unit"]["kind"] == "portal"]
    if strong:
        status, chosen = "evidence", strong[:limit] + portal_hits[: LIMITS["partial_cards"]]
    elif scored:
        status, chosen = "partial", scored[: LIMITS["partial_cards"]]
    else:
        status, chosen = "insufficient", []
    cards = []
    for r in chosen:
        u = r["unit"]
        page, block = u["page"], u["block"]
        text, marks = _excerpt(u["text"], parsed["terms"])
        bid = block.get("id")
        prov = _provenance(u, index, state, ctx.title, frozen is not None)
        if prov is not None and current is not None:
            prov["source"]["current_state"] = current(prov["source"]["kind"], prov["source"]["id"])
        card: dict[str, Any] = {
            "id": _card_id(page["id"], bid, u.get("row", u.get("item"))),
            "kind": u["kind"],
            "class": "reference" if u["kind"] == "portal" else ("derived" if prov else "primary"),
            "page_id": page["id"], "page_title": ctx.title(page), "block_id": bid,
            "link": None if frozen else intel._anchor(page["id"], bid),
            "excerpt": text, "marks": marks, "matched": r["hit"], "coverage": round(r["coverage"], 4), "score": round(r["score"], 3),
            "refs": [], "provenance": prov,
        }
        if "row" in u:
            card["row"] = u["row"]
        if frozen is not None:
            link, live_state = _frozen_link(live_blocks, page["id"], block)
            card["live_link"] = link
            card["live_state"] = live_state
        btype = block.get("type")
        if btype == "decision":
            card["at"] = block["decision"]["at"]
        elif btype == "measure":
            p = block["measure"]
            ev = eng.evaluate(p)
            card["at"] = p["at"]
            card["measure"] = {
                "label": p["label"], "value": p["observed"]["v"], "unit": p["observed"]["u"], "mode": p["mode"],
                "nominal": copy.deepcopy(p["nominal"]), "tol": copy.deepcopy(p["tol"]), "verdict": intel._verdict_text(ev["status"]),
                "lo": ev["lo"], "hi": ev["hi"],
            }
        elif btype == "portal":
            card["portal"] = {"kind": block["portal"]["ref"]["kind"], "id": block["portal"]["ref"]["id"]}  # the stored reference, nothing resolved
        elif btype == "drawing":
            card["drawing"] = {"stem": block["drawing"]["id"], "state": state("drawing", block["drawing"]["id"])}
            if current is not None:
                card["drawing"]["current_state"] = current("drawing", block["drawing"]["id"])
        refs = intel._evidence(ctx, block)
        if current is not None:
            for ref in refs:
                ref["current_state"] = current(ref["kind"], ref["id"])
        card["refs"] = refs[: LIMITS["refs_per_card"]]
        cards.append(card)
    matched_terms = {t for c in cards for t in c["matched"]}
    out = {
        **base, "status": status, "cards": cards, "partial": status == "partial", "incomplete": incomplete,
        "counts": {"pages": len(scanned_pages), "units": len(units), "matched": len(scored), "evidence": len(strong), "shown": len(cards),
                   "derived_shown": sum(1 for c in cards if c["class"] == "derived")},
        "unmatched_terms": [t for t in parsed["terms"] if t not in matched_terms],
        "reason": None,
    }
    if status == "insufficient":
        out["reason"] = "scope_empty" if not units else "no_match"
    elif status == "partial":
        out["reason"] = "weak_match"
    cited = _source_cards(question, parsed, scanned_pages, sources or {}, ctx, state, frozen is not None)
    if current is not None:
        for c in cited:
            c["current_state"] = current("source", c["id"])
    out["sources"] = cited
    if cited and status == "insufficient":
        out["reason"] = "source_metadata_only"
    return out


def _source_cards(question: str, parsed: dict, pages: list[dict], sources: dict[str, dict], ctx: intel.Ctx, state: Callable[[str, str], str], frozen: bool) -> list[dict]:
    """Cited source editions whose METADATA (title / author / year / edition) contains a question term. Never page text."""
    if not sources:
        return []
    cited_in: dict[str, list[dict]] = {}
    for page in pages:
        for block in (page.get("content") or {}).get("blocks") or []:
            if not isinstance(block, dict):
                continue
            for ref in intel.block_refs(block):
                if ref["kind"] == "source" and ref["id"] in sources:
                    cited_in.setdefault(ref["id"], []).append({
                        "page_id": page["id"], "page_title": ctx.title(page), "block_id": block.get("id"),
                        "link": None if frozen else intel._anchor(page["id"], block.get("id")),
                    })
    out = []
    for ident in sorted(cited_in):
        ed = sources[ident]
        text = " ".join(str(ed.get(k) or "") for k in ("title", "author", "year", "edition"))
        hit = [t for t in parsed["terms"] if t in tokens(text)]
        if not hit:
            continue
        shown, marks = _excerpt(ed.get("title") or "", parsed["terms"])
        out.append({
            "id": ident, "kind": "source", "title": ed.get("title"), "author": ed.get("author"), "year": ed.get("year"), "edition": ed.get("edition"),
            "state": state("source", ident), "matched": hit, "excerpt": shown, "marks": marks,
            "cited_in": cited_in[ident][: LIMITS["cited_in"]], "cited_total": len(cited_in[ident]),
        })
    out.sort(key=lambda s: (-len(s["matched"]), s["id"]))
    return out[: LIMITS["cards"]]


# ---------------------------------------------------------------- report rendering


def _md(text: Any) -> str:
    return rich._md_escape(str(text)) if hasattr(rich, "_md_escape") else str(text)


def render_markdown(res: dict, heading: bool = True) -> str:
    """Deterministic Markdown of an evidence result: the question, scope, every card with its deep link, derived provenance and the notice."""
    lines: list[str] = []
    scope = res["scope"]
    scope_text = {"page": "cette note", "project": "ce projet", "notebook": "tout le carnet", "snapshot": "un jalon figé"}[scope["kind"]]
    if heading:
        lines += [f"## Preuves — « {_md(res['question'])} »", ""]
    lines.append(f"Périmètre : {scope_text}" + (f" ({_md(scope.get('label'))})" if scope.get("label") else "") + ".")
    if res.get("frozen"):
        lines.append(f"Jalon figé : « {_md(res['frozen']['label'])} ».")
    status = {"evidence": "Preuves trouvées", "partial": "Correspondances partielles — elles ne répondent pas à toute la question",
              "insufficient": "Preuves insuffisantes dans ce périmètre", "empty_query": "Question sans terme exploitable"}[res["status"]]
    lines += [f"État : {status}.", ""]
    if res["incomplete"]:
        lines += ["Attention : le périmètre a été parcouru partiellement ; l'absence de résultat ne prouve rien.", ""]
    for c in res["cards"]:
        where = f"{_md(c['page_title'])}"
        head = f"- [{_md(c['kind'])}] {where}"
        if c["link"]:
            head += f" — {c['link']}"
        elif c.get("live_link"):
            head += f" — (bloc inchangé dans le carnet actuel) {c['live_link']}"
        elif res.get("frozen"):
            head += f" — (jalon figé ; bloc {c.get('live_state', 'gone')} dans le carnet actuel)"
        lines.append(head)
        lines.append(f"  > {_md(c['excerpt'])}")
        if c.get("at") is not None:
            lines.append(f"  Horodatage : {intel._when(c['at'])}")
        prov = c.get("provenance")
        if prov:
            src = prov["source"]
            rel = f"  **{prov['label']}** — source canonique : {src['kind']} {src['id']} ({'introuvable' if src['state'] == 'missing' else 'disponible' if src['state'] == 'ok' else 'état inconnu'})"
            if src.get("block") and src["block"].get("link"):
                rel += f" — {src['block']['link']}"
            lines.append(rel)
        for ref in c["refs"]:
            lines.append(f"  Référence : {ref['kind']} {_md(ref.get('title') or ref['id'])} ({ref['state']})")
    for s in res.get("sources", []):
        lines.append(f"- [source] {_md(s['title'])} ({s['state']}) — citée {s['cited_total']} fois")
    lines += ["", f"_{res['note']}_"]
    return "\n".join(lines)
