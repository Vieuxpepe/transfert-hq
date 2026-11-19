"""Carnet "by meaning": suggestions found with an embedding model on the voice-worker PC.

This is NOT Ask Carnet. Ask Carnet (``hq_carnet_ask``) is evidence-only and its contract forbids models, embeddings and
fuzziness; it is left untouched. This module is a separate, clearly labelled feature: it points at blocks whose MEANING is close to
a question ("vis et couple de serrage" finds "Tightening torque for the M3 screws"). A suggestion is a pointer, never evidence: it
shows the block's current canonical text (read from the live page, never from the index), a similarity score, and a link.

Rules:

* The notebook is only read. The index is one sidecar file next to HQ's other state (``hq_carnet_semantic.json``): per block a
  hash of the text it was computed from and a half-precision unit vector. A block whose text changed is stale and never returned.
* Text leaves HQ only for the voice-worker PC (the owner's own laptop, over Tailscale) and only through the embed job; the model
  runs on its CPU. Nothing here calls Gemini or any cloud service.
* Everything is bounded (units per run, batch size, characters per unit, results). When the worker is offline nothing is
  indexed and a search says it is unavailable; the lexical Ask Carnet keeps working as before.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import struct
import threading
import time
from pathlib import Path
from typing import Any, Callable

import hq_carnet_ask as ask
import hq_state

MODEL_TAG = "embeddinggemma-300m-q8"
DOC_PREFIX = "title: none | text: "
QUERY_PREFIX = "task: search result | query: "
KINDS = ("note", "decision", "callout", "toggle", "table", "image")
MIN_CHARS = 12
MAX_UNIT_CHARS = 600
BATCH = 8
MAX_PER_RUN = 64
MIN_SCORE = 0.30       # real run (EmbeddingGemma, 4 synthetic FR/EN notes): relevant queries 0.36-0.62, unrelated 0.10-0.20
TOP_K = 8
MAX_QUERY = 300
EXCERPT = 240
MIN_GAP = 300.0        # seconds between two background sync attempts
FILE_V = 1
_lock = threading.Lock()
_state: dict[str, Any] = {"last_try": 0.0, "running": False, "last": {}}


def _norm(vec: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / n for x in vec]


def _pack(vec: list[float]) -> str:
    return base64.b64encode(struct.pack(f"<{len(vec)}e", *_norm(vec))).decode("ascii")


def _unpack(blob: str, dim: int) -> list[float] | None:
    try:
        raw = base64.b64decode(blob, validate=True)
        return list(struct.unpack(f"<{dim}e", raw)) if len(raw) == dim * 2 else None
    except (ValueError, struct.error, TypeError):
        return None


def unit_key(text: str) -> str:
    return hashlib.sha1(f"{MODEL_TAG}\0{text}".encode("utf-8")).hexdigest()[:20]


def wanted_units(pages: list[dict]) -> dict[str, dict]:
    """``{unit id: {page, block, kind, text, key, derived}}`` for every embeddable canonical unit of the live pages."""
    out: dict[str, dict] = {}
    for page in pages:
        try:
            units = ask.units_of(page)
        except Exception:  # noqa: BLE001 — one odd page never stops the index
            continue
        for u in units:
            if u["kind"] not in KINDS or not isinstance(u.get("block"), dict) or not u["block"].get("id"):
                continue
            text = " ".join(str(u["text"] or "").split())[:MAX_UNIT_CHARS]
            if len(text) < MIN_CHARS:
                continue
            part = u.get("row", u.get("item", 0))
            uid = f"{page['id']}|{u['block']['id']}|{part}"
            out[uid] = {"page": page["id"], "block": u["block"]["id"], "kind": u["kind"], "text": text, "key": unit_key(text),
                        "derived": bool((u["block"].get("from") or {}).get("kind"))}
    return out


def _empty() -> dict:
    return {"v": FILE_V, "model": MODEL_TAG, "dim": 0, "items": {}}


def load(path: Path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _empty()
    if not isinstance(data, dict) or data.get("v") != FILE_V or data.get("model") != MODEL_TAG or not isinstance(data.get("items"), dict):
        return _empty()  # another model or an unreadable file: start over (it only costs a re-index)
    dim = data.get("dim")
    return {"v": FILE_V, "model": MODEL_TAG, "dim": dim if isinstance(dim, int) and 8 <= dim <= 4096 else 0, "items": data["items"]}


def save(path: Path, index: dict) -> None:
    with hq_state.path_lock(Path(path)):
        hq_state.write_json_atomic(Path(path), index, compact=True)


def sync(path: Path, pages: list[dict], embed: Callable[..., Any], *, max_units: int = MAX_PER_RUN) -> dict:
    """Bring the index up to date with the live pages: drop what is gone or changed, embed what is missing (at most
    ``max_units`` per run, ``BATCH`` per call). Stops at the first call the worker cannot answer; the next run carries on."""
    want = wanted_units(pages)
    index = load(path)
    items = index["items"]
    removed = [uid for uid, row in items.items() if uid not in want or not isinstance(row, dict) or row.get("h") != want[uid]["key"]]
    for uid in removed:
        items.pop(uid, None)
    todo = [uid for uid in want if uid not in items][:max_units]
    done = 0
    for start in range(0, len(todo), BATCH):
        chunk = todo[start:start + BATCH]
        vectors = embed([DOC_PREFIX + want[uid]["text"] for uid in chunk])
        if not vectors or len(vectors) != len(chunk):
            break
        dims = {len(v) for v in vectors}
        if len(dims) != 1 or (index["dim"] and dims != {index["dim"]}):
            break
        index["dim"] = dims.pop()
        for uid, vec in zip(chunk, vectors):
            items[uid] = {"h": want[uid]["key"], "v": _pack(vec)}
        done += len(chunk)
    if removed or done:
        save(path, index)
    pending = sum(1 for uid in want if uid not in items)
    return {"embedded": done, "removed": len(removed), "pending": pending, "indexed": len(items)}


def status(path: Path, pages: list[dict]) -> dict:
    want = wanted_units(pages)
    items = load(path)["items"]
    fresh = sum(1 for uid, w in want.items() if isinstance(items.get(uid), dict) and items[uid].get("h") == w["key"])
    return {"units": len(want), "indexed": fresh, "pending": len(want) - fresh, "model": MODEL_TAG, "last": dict(_state["last"])}


def search(path: Path, query: Any, pages: list[dict], embed: Callable[..., Any], *, k: int = TOP_K, min_score: float = MIN_SCORE) -> dict:
    """Blocks whose meaning is close to ``query``: ``{"available", "results": [card], "indexed", "pending"}``. A card shows the
    CURRENT canonical text of the block (never the index), its score and a link; it is a suggestion, not evidence."""
    text = " ".join(str(query or "").split())[:MAX_QUERY] if isinstance(query, str) else ""
    st = status(path, pages)
    base = {"available": False, "results": [], "indexed": st["indexed"], "pending": st["pending"], "query": text,
            "note": "Suggestions par le sens, calculées par un modèle : ce ne sont pas des preuves. Ouvre le bloc pour vérifier ce qu'il dit."}
    if len(text) < 2 or not st["indexed"]:
        return {**base, "available": bool(st["indexed"])}
    got = embed([QUERY_PREFIX + text], urgent=True)
    if not got or len(got) != 1:
        return base
    index = load(path)
    dim = index["dim"]
    q = _norm(got[0])
    if len(q) != dim:
        return base
    want = wanted_units(pages)
    scored: list[tuple[float, str]] = []
    for uid, w in want.items():
        row = index["items"].get(uid)
        if not isinstance(row, dict) or row.get("h") != w["key"]:
            continue  # stale or not indexed yet: never shown
        vec = _unpack(row.get("v", ""), dim)
        if vec is None:
            continue
        score = sum(a * b for a, b in zip(q, vec))
        if score >= min_score:
            scored.append((score, uid))
    scored.sort(reverse=True)
    results = []
    for score, uid in scored[:max(1, min(int(k), 20))]:
        w = want[uid]
        results.append({"page_id": w["page"], "block_id": w["block"], "kind": w["kind"], "score": round(score, 3),
                        "excerpt": w["text"][:EXCERPT], "derived": w["derived"], "link": f"#carnet/{w['page']}/{w['block']}"})
    return {**base, "available": True, "results": results}


def kick(path: Path, pages_fn: Callable[[], list[dict]], embed: Callable[..., Any], ready: Callable[[], bool],
         after: Callable[[], None] | None = None) -> bool:
    """Start a background sync when the worker is ready and the last attempt is not recent. Never blocks the caller; one at a
    time. ``after`` runs in the same thread once the sync is done (used for the page digests). True when a thread started."""
    now = time.time()
    with _lock:
        if _state["running"] or now - float(_state["last_try"]) < MIN_GAP:
            return False
        try:
            if not ready():
                return False
        except Exception:  # noqa: BLE001
            return False
        _state.update(running=True, last_try=now)

    def work() -> None:
        try:
            _state["last"] = {**sync(path, pages_fn(), embed), "at": int(time.time())}
            if after is not None:
                after()
        except Exception as error:  # noqa: BLE001 — background work must never raise
            _state["last"] = {"error": str(error)[:120], "at": int(time.time())}
        finally:
            with _lock:
                _state["running"] = False

    threading.Thread(target=work, daemon=True, name="hq-carnet-semantic").start()
    return True


def http_get(query: dict, *, root: Path, enabled: bool, pages_fn: Callable[[], list[dict]], title_fn: Callable[[dict], str],
             embed: Callable[..., Any], ask_llm: Callable[..., Any], embed_ready: Callable[[], bool],
             llm_ready: Callable[[], bool]) -> tuple[int, dict]:
    """``GET /api/carnet-semantic[?q=…&k=…]``. Without ``q``: the index status and the generated page digests. With ``q``: the
    suggestions by meaning (each with its page title and digest). Reading it may start a background sync of the index and the
    digests on the worker PC (at most one per ``MIN_GAP``); it never waits for it. Read-only for the notebook."""
    if not enabled:
        return 200, {"ok": True, "enabled": False}
    import hq_carnet_digest as digest

    root = Path(root)
    sem_path, dig_path = root / "hq_carnet_semantic.json", root / "hq_carnet_digests.json"
    pages = pages_fn()
    kick(sem_path, pages_fn, embed, lambda: embed_ready() or llm_ready(),
         after=lambda: digest.refresh(dig_path, pages_fn(), ask_llm) if llm_ready() else None)
    titles = {p["id"]: title_fn(p) for p in pages}
    notes = digest.digests(dig_path, pages)
    caps = {"embed": bool(embed_ready()), "llm": bool(llm_ready())}
    q = (query.get("q") or [""])[0]
    if q.strip():
        try:
            k = int((query.get("k") or [TOP_K])[0])
        except (TypeError, ValueError):
            k = TOP_K
        res = search(sem_path, q, pages, embed, k=k)
        for card in res["results"]:
            card["title"] = titles.get(card["page_id"], "")
            if card["page_id"] in notes:
                card["digest"] = notes[card["page_id"]]
        return 200, {"ok": True, "enabled": True, "worker": caps, **res}
    rows = [{"page_id": pid, "title": titles.get(pid, ""), **notes[pid]} for pid in list(notes)[:100]]
    return 200, {"ok": True, "enabled": True, "worker": caps, "status": status(sem_path, pages), "digests": rows,
                 "digest_note": "Résumés et mots-clés générés par un modèle local : ils ne font pas partie des notes."}
