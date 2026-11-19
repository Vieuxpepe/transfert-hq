# -*- coding: utf-8 -*-
"""Transfert HQ — Inventoria Engine (propose → validate → preview → commit → audit)."""

from __future__ import annotations

import hq_language

import hashlib
import json
import re
import secrets
import sqlite3
import threading
import time
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable

import hq_finances as finances
import hq_household_schemas as schemas
import hq_household_store as hstore
import hq_inventoria_commit as commit_mod
import hq_inventory as inventory

BODY_MAX = 3_000_000          # transport cap (a message may carry one photo)
BODY_MAX_TEXT = 1_048_576     # every other request
MESSAGES_MAX = 100
PROPOSALS_MAX = 20
TEXT_MAX = 8_000
ADAPTER_OUTPUT_MAX = 64_000
SESSION_RE = re.compile(r"^/api/inventoria/sessions(?:/(ivo-[0-9a-f]{16}))?(?:/message)?\Z")
OPS_RE = re.compile(r"^/api/inventoria/ops/(iop-[0-9a-f]{16})(?:/(validate|preview|commit|cancel|reconcile|undo))?\Z")

PREVIEW_KEYS = frozenset({"confirm"})
COMMIT_KEYS = frozenset({"idempotency_key"})
RECONCILE_KEYS = frozenset({
    "decision", "reason", "idempotency_key", "evidence", "step_index",
})
AMBIGUOUS_NAME_THRESHOLD = 0.75
NAME_MATCH_MIN = 0.50
REASON_MIN_LEN = 8

_cb: dict[str, Any] = {}
_guard = threading.Lock()
# Single-process ownership for commit, cancel, preview, and state-changing reconcile.
# Held until the outer SQLite transaction commits or rolls back. Not multiprocess-safe.
_commit_owners_guard = threading.Lock()
_commit_owners: dict[str, tuple[int, int]] = {}
# Serializes the final write of a chat turn so a reply cannot overwrite a message
# that landed while the model was thinking (check + write under one lock).
_session_write_lock = threading.Lock()


class InventoriaError(Exception):
    def __init__(self, msg: str, *, status: int = 400, code: str = "validation_error", retryable: bool = False):
        super().__init__(msg)
        self.status = status
        self.code = code
        self.retryable = retryable


def bind(**kwargs: Any) -> None:
    with _guard:
        for key in ("root", "actor", "now", "llm_adapter", "asset_exists", "notify"):
            if key in kwargs:
                _cb[key] = kwargs[key]


def root() -> Path | None:
    """The bound HQ root, or None before bind (growth stays disabled then)."""
    with _guard:
        value = _cb.get("root")
    return Path(value) if value else None


def reset_for_tests() -> None:
    with _guard:
        _cb.clear()
    with _commit_owners_guard:
        _commit_owners.clear()
    commit_mod.set_test_hook(None)


def _claim_commit(op_id: str) -> bool:
    """Claim op_id for this thread. Re-entrant so reconcile can call commit work."""
    tid = threading.get_ident()
    with _commit_owners_guard:
        current = _commit_owners.get(op_id)
        if current is None:
            _commit_owners[op_id] = (tid, 1)
            return True
        owner, depth = current
        if owner != tid:
            return False
        _commit_owners[op_id] = (tid, depth + 1)
        return True


def _release_commit(op_id: str) -> None:
    tid = threading.get_ident()
    with _commit_owners_guard:
        current = _commit_owners.get(op_id)
        if current is None or current[0] != tid:
            return
        _owner, depth = current
        if depth <= 1:
            _commit_owners.pop(op_id, None)
        else:
            _commit_owners[op_id] = (tid, depth - 1)


def _commit_in_progress(op_id: str) -> dict:
    return {
        "ok": False,
        "code": "commit_in_progress",
        "operation_id": op_id,
        "http_status": 409,
    }


def _root() -> Any:
    root = _cb.get("root")
    if root is None:
        raise InventoriaError("module inventoria non initialisé", status=503, code="storage_error")
    return root


def _actor() -> str:
    fn = _cb.get("actor")
    return str(fn()) if callable(fn) else "admin"


def _now() -> float:
    fn = _cb.get("now")
    return float(fn()) if callable(fn) else time.time()


def _open_store(*, readonly: bool = False) -> hstore.HouseholdStore:
    return hstore.open_store(_root(), create=not readonly, readonly=readonly)


def _new_id(kind: str) -> str:
    if kind == "session":
        return f"ivo-{secrets.token_hex(8)}"
    if kind == "op":
        return f"iop-{secrets.token_hex(8)}"
    raise InventoriaError("kind id inconnu", code="validation_error")


def _safe_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _body_hash(payload: dict) -> str:
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _audit(
    conn: sqlite3.Connection,
    *,
    household_id: str,
    operation_id: str,
    action: str,
    prev_status: str | None,
    next_status: str | None,
    detail: dict | None = None,
) -> None:
    conn.execute(
        "INSERT INTO inventoria_operation_audit("
        "operation_id, household_id, actor, action, prev_status, next_status, detail_json, created_at"
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            operation_id, household_id, _actor(), action,
            prev_status, next_status, _safe_json(detail) if detail else None, _now(),
        ),
    )


def _reject_unknown_fields(data: dict, allowed: frozenset[str]) -> None:
    extra = set(data) - allowed
    if extra:
        sample = ", ".join(sorted(extra)[:8])
        raise InventoriaError(f"Champs inconnus ({sample})", code="validation_error")


def _name_score(a: str, b: str) -> float:
    return SequenceMatcher(None, a.casefold(), b.casefold()).ratio()


def _conf_for_score(score: float) -> str:
    if score >= 0.92:
        return "high"
    if score >= AMBIGUOUS_NAME_THRESHOLD:
        return "medium"
    return "low"


def _commit_preview_digest(
    proposals: list[dict],
    expected_inventory_rev: int,
    item_rev_expectations: list[dict] | None,
) -> str:
    normalized: list[dict] = []
    for p in proposals:
        normalized.append({
            "op": p["op"],
            "refs": p.get("refs") or {},
            "resolved": p.get("resolved") or {},
            "payload": p.get("payload") or {},
        })
    blob = {
        "proposals": normalized,
        "expected_inventory_rev": int(expected_inventory_rev),
        "item_rev_expectations": item_rev_expectations or [],
    }
    return hashlib.sha256(_safe_json(blob).encode("utf-8")).hexdigest()


def _simulate_proposal(p: dict, inv: dict) -> list[dict]:
    """Return simulation issues (bounds, existence) — read-only."""
    issues: list[dict] = []
    op = p["op"]
    payload = p.get("payload") or {}
    items = {i["id"]: i for i in inv.get("items") or []}
    places = {pl["id"]: pl for pl in inv.get("places") or []}
    from hq_inventory import QTY_MAX  # local import avoids cycle at module load

    if op == "item.adjust":
        iid = payload.get("id")
        item = items.get(iid) if isinstance(iid, str) else None
        if item is None:
            issues.append({"op": op, "code": "not_found", "item_id": iid})
            return issues
        delta = payload.get("delta")
        if not isinstance(delta, int) or isinstance(delta, bool) or delta == 0:
            issues.append({"op": op, "code": "invalid_delta"})
            return issues
        new_qty = int(item["qty"]) + int(delta)
        if new_qty < 0:
            issues.append({"op": op, "code": "negative_qty", "would_be": new_qty})
        elif new_qty > QTY_MAX:
            issues.append({"op": op, "code": "qty_out_of_range", "would_be": new_qty})
    elif op in ("item.update", "item.delete"):
        iid = payload.get("id")
        if iid not in items:
            issues.append({"op": op, "code": "not_found", "item_id": iid})
        elif op == "item.update" and "qty" in payload:
            q = payload["qty"]
            if isinstance(q, int) and not isinstance(q, bool) and (q < 0 or q > QTY_MAX):
                issues.append({"op": op, "code": "qty_out_of_range"})
    elif op == "item.move":
        for iid in payload.get("ids") or []:
            if iid not in items:
                issues.append({"op": op, "code": "not_found", "item_id": iid})
        dest = payload.get("place")
        if dest not in (None, "") and dest not in places:
            issues.append({"op": op, "code": "not_found", "place_id": dest})
    elif op.startswith("place."):
        pid = payload.get("id")
        if op != "place.create" and pid not in places:
            issues.append({"op": op, "code": "not_found", "place_id": pid})
    conf = (p.get("resolved") or {}).get("confidence")
    if conf in ("medium", "low"):
        issues.append({"op": op, "code": "needs_confirmation", "confidence": conf})
    return issues


def _alias_for(hint: Any) -> str | None:
    if not isinstance(hint, str) or not hint.strip():
        return None
    base = root()
    if base is None:
        return None
    try:
        import hq_inventoria_habits as habits
        return habits.alias_item(base, hint)
    except Exception:
        return None


def _prefs() -> dict:
    """Auto-apply preferences; anything unreadable means OFF (every change goes through review)."""
    base = root()
    if base is None:
        return {"auto_apply": False, "auto_delta_max": 0}
    try:
        import hq_inventoria_habits as habits
        if habits._load(base).get("_unreadable"):
            return {"auto_apply": False, "auto_delta_max": 0}
        return habits.get_prefs(base)
    except Exception:
        return {"auto_apply": False, "auto_delta_max": 0}


def _trusted_indexes(proposals: list[dict], inv: dict, cap: int) -> list[int]:
    """Which proposals may apply at once: quantity adjusts of an existing item, resolved with high confidence,
    within the size cap, one per item, on an item no other change in this message touches, and valid together.
    Creates, updates, moves, deletes and anything ambiguous always stay drafts for review."""
    touched: set[str] = set()
    for p in proposals:
        if p.get("op") != "item.adjust":
            pl = p.get("payload") or {}
            for x in [pl.get("id"), *(pl.get("ids") or [])]:
                if isinstance(x, str):
                    touched.add(x)
    picked: list[int] = []
    resolved: list[dict] = []
    seen: set[str] = set()
    items = {i["id"]: i for i in inv.get("items") or []}
    for i, p in enumerate(proposals):
        if p.get("op") != "item.adjust":
            continue
        rp, issues = _resolve_proposal(p, inv)
        pl = rp.get("payload") or {}
        iid, delta = pl.get("id"), pl.get("delta")
        if issues or (rp.get("resolved") or {}).get("confidence") != "high" or not isinstance(iid, str):
            continue
        if iid in touched or iid in seen:
            continue
        if isinstance(delta, bool) or not isinstance(delta, int) or delta == 0 or abs(delta) > _unit_cap(cap, items.get(iid)):
            continue
        seen.add(iid)
        picked.append(i)
        resolved.append(rp)
    if picked and _simulate_batch_sequential(resolved, inv):
        return []
    return picked


def _unit_cap(cap: int, item: dict | None) -> int:
    """The auto-apply cap counts pieces; an item kept in g/ml gets the same cap in 100 g / 100 ml steps
    (50 -> 5 000 g), and one kept in kg/L never less than the plain cap."""
    try:
        import hq_inventoria_links as links
        dim = links.unit_dim((item or {}).get("unit"))
    except Exception:
        dim = None
    if dim and dim[0] in ("g", "ml"):
        return max(cap, int(cap * 100 / dim[1]))
    return cap


def _fill_create_defaults(p: dict, inv: dict) -> dict:
    """An item.create without a shelf/unit gets the one this name had before (learned), when that shelf still exists."""
    if p.get("op") != "item.create":
        return p
    payload = dict(p.get("payload") or {})
    if payload.get("place") and payload.get("unit"):
        return p
    base = root()
    if base is None:
        return p
    try:
        import hq_inventoria_habits as habits
        learned = habits.name_defaults(base, payload.get("name"))
    except Exception:
        return p
    places = {pl["id"]: pl for pl in inv.get("places") or []}
    out = dict(p)
    if not payload.get("place") and learned.get("place") in places:
        payload["place"] = learned["place"]
        label = str(out.get("label_fr") or "")
        out["label_fr"] = label.replace(" (sans emplacement)", f" dans {places[learned['place']].get('name')}")
    if not payload.get("unit") and learned.get("unit"):
        payload["unit"] = learned["unit"]
    out["payload"] = payload
    return out


def _resolve_proposal(proposal: dict, inv: dict) -> tuple[dict, list[dict]]:
    """Fill resolved refs from inventory snapshot. Caller-supplied confidence is ignored."""
    out = dict(proposal)
    refs = dict(proposal.get("refs") or {})
    resolved: dict[str, Any] = {}
    local_issues: list[dict] = []
    op = proposal["op"]
    items = inv.get("items") or []
    places = inv.get("places") or []
    by_item = {i["id"]: i for i in items}
    by_place = {p["id"]: p for p in places}
    by_code = {p["code"].upper(): p["id"] for p in places if isinstance(p.get("code"), str)}

    explicit_iid = refs.get("item_id")
    alias_iid = _alias_for(refs.get("name_hint")) if not isinstance(explicit_iid, str) else None
    if isinstance(explicit_iid, str):
        if explicit_iid not in by_item:
            local_issues.append({"op": op, "code": "not_found", "item_id": explicit_iid})
        else:
            resolved["item_id"] = explicit_iid
            resolved["confidence"] = "high"
    elif alias_iid and alias_iid in by_item:
        resolved["item_id"] = alias_iid          # a nickname the Master taught ("PQ" = papier toilette)
        resolved["confidence"] = "high"
    elif refs.get("name_hint"):
        hint = str(refs["name_hint"]).strip()
        scored = [(it, _name_score(hint, it["name"])) for it in items]
        strong = [(it, s) for it, s in scored if s >= AMBIGUOUS_NAME_THRESHOLD]
        if len(strong) > 1:
            local_issues.append({
                "op": op,
                "code": "ambiguous_name",
                "candidates": [it["id"] for it, _ in strong[:5]],
            })
            resolved["confidence"] = "low"
        else:
            best = max(scored, key=lambda x: x[1], default=(None, 0.0))
            it, score = best
            if it is not None and score >= NAME_MATCH_MIN:
                resolved["item_id"] = it["id"]
                resolved["confidence"] = _conf_for_score(score)
            else:
                local_issues.append({"op": op, "code": "unresolved_reference"})
                resolved["confidence"] = "low"

    explicit_pid = refs.get("place_id")
    if isinstance(explicit_pid, str):
        if explicit_pid not in by_place:
            local_issues.append({"op": op, "code": "not_found", "place_id": explicit_pid})
        else:
            resolved["place_id"] = explicit_pid
            resolved.setdefault("confidence", "high")
    elif refs.get("place_code"):
        code = str(refs["place_code"]).upper()
        pid = by_code.get(code)
        if pid:
            resolved["place_id"] = pid
            resolved["confidence"] = "high"
        else:
            local_issues.append({"op": op, "code": "not_found", "place_code": code})

    payload = dict(proposal.get("payload") or {})
    if isinstance(refs.get("item_id"), str) and isinstance(payload.get("id"), str):
        if payload["id"] != refs["item_id"]:
            local_issues.append({
                "op": op,
                "code": "ref_payload_mismatch",
                "refs_item_id": refs["item_id"],
                "payload_id": payload["id"],
            })
    if isinstance(refs.get("place_id"), str) and isinstance(payload.get("id"), str) and op.startswith("place."):
        if payload["id"] != refs["place_id"]:
            local_issues.append({
                "op": op,
                "code": "ref_payload_mismatch",
                "refs_place_id": refs["place_id"],
                "payload_id": payload["id"],
            })
    if op == "item.move":
        ids = payload.get("ids")
        ref_item = refs.get("item_id")
        if isinstance(ref_item, str) and (not isinstance(ids, list) or ref_item not in ids):
            local_issues.append({
                "op": op,
                "code": "ref_payload_mismatch",
                "refs_item_id": ref_item,
                "payload_ids": ids if isinstance(ids, list) else None,
            })
        ref_place = refs.get("place_id")
        if isinstance(ref_place, str) and payload.get("place") != ref_place:
            local_issues.append({
                "op": op,
                "code": "ref_payload_mismatch",
                "refs_place_id": ref_place,
                "payload_place": payload.get("place"),
            })
    resolved_item = resolved.get("item_id")
    if isinstance(resolved_item, str):
        if op in ("item.adjust", "item.update", "item.delete") and payload.get("id") != resolved_item:
            local_issues.append({
                "op": op,
                "code": "ref_payload_mismatch",
                "resolved_item_id": resolved_item,
                "payload_id": payload.get("id"),
            })
        elif op == "item.move":
            ids = payload.get("ids")
            if not isinstance(ids, list) or resolved_item not in ids:
                local_issues.append({
                    "op": op,
                    "code": "ref_payload_mismatch",
                    "resolved_item_id": resolved_item,
                    "payload_ids": ids if isinstance(ids, list) else None,
                })
    resolved_place = resolved.get("place_id")
    if isinstance(resolved_place, str):
        if op.startswith("place.") and op != "place.create" and payload.get("id") != resolved_place:
            local_issues.append({
                "op": op,
                "code": "ref_payload_mismatch",
                "resolved_place_id": resolved_place,
                "payload_id": payload.get("id"),
            })
        elif op == "item.move" and payload.get("place") != resolved_place:
            local_issues.append({
                "op": op,
                "code": "ref_payload_mismatch",
                "resolved_place_id": resolved_place,
                "payload_place": payload.get("place"),
            })
        elif op == "item.update" and "place" in payload and payload.get("place") not in ("", None):
            if payload.get("place") != resolved_place:
                local_issues.append({
                    "op": op,
                    "code": "ref_payload_mismatch",
                    "resolved_place_id": resolved_place,
                    "payload_place": payload.get("place"),
                })
    if op in ("item.adjust", "item.update", "item.delete") and resolved.get("item_id") and "id" not in payload:
        payload["id"] = resolved["item_id"]
    if op.startswith("place.") and resolved.get("place_id") and "id" not in payload and op != "place.create":
        payload["id"] = resolved["place_id"]

    if "confidence" not in resolved:
        resolved["confidence"] = "low" if local_issues else "high"
    out["refs"] = refs
    out["resolved"] = resolved
    out["payload"] = payload
    try:
        schemas.validate_inventoria_proposal(out)
    except schemas.SchemaError as exc:
        local_issues.append({"op": op, "code": exc.code, "error": str(exc)})
    sim = _simulate_proposal(out, inv)
    local_issues.extend(sim)
    return out, local_issues


def _simulate_batch_sequential(proposals: list[dict], inv: dict) -> list[dict]:
    """Simulate ordered inventory effects — reject interdependent batches before any write."""
    from hq_inventory import DEPTH_MAX, QTY_MAX

    qty: dict[str, int] = {i["id"]: int(i["qty"]) for i in inv.get("items") or []}
    item_rev: dict[str, int] = {i["id"]: int(i["rev"]) for i in inv.get("items") or []}
    item_place: dict[str, str | None] = {i["id"]: i.get("place") for i in inv.get("items") or []}
    places: set[str] = {p["id"] for p in inv.get("places") or []}
    place_rev: dict[str, int] = {p["id"]: int(p["rev"]) for p in inv.get("places") or []}
    place_parent: dict[str, str | None] = {p["id"]: p.get("parent") for p in inv.get("places") or []}
    deleted_items: set[str] = set()
    deleted_places: set[str] = set()
    issues: list[dict] = []

    def _dead_item(iid: str | None, step: int, op: str) -> bool:
        if not isinstance(iid, str):
            issues.append({"step": step, "code": "not_found", "op": op})
            return True
        if iid in deleted_items or iid not in qty:
            issues.append({"step": step, "code": "batch_use_after_delete", "op": op, "item_id": iid})
            return True
        return False

    def _dead_place(pid: str | None, step: int, op: str) -> bool:
        if pid in (None, ""):
            return False
        if not isinstance(pid, str) or pid in deleted_places or pid not in places:
            issues.append({"step": step, "code": "batch_place_unavailable", "op": op, "place_id": pid})
            return True
        return False

    def _place_depth(start: str) -> int | None:
        depth = 0
        seen_d: set[str] = set()
        cur_d: str | None = start
        while cur_d is not None:
            if cur_d in seen_d or depth >= DEPTH_MAX:
                return None
            seen_d.add(cur_d)
            depth += 1
            cur_d = place_parent.get(cur_d)
        return depth

    def _subtree_height(node: str, moving: str) -> int:
        child_ids = [k for k, par in place_parent.items() if par == node and k != moving]
        if not child_ids:
            return 1
        return 1 + max(_subtree_height(k, moving) for k in child_ids)

    for step, p in enumerate(proposals):
        op = p["op"]
        payload = p.get("payload") or {}
        iid = payload.get("id")
        if op == "item.create":
            if step < len(proposals) - 1:
                issues.append({"step": step, "code": "batch_unsupported_create", "op": op})
            elif _dead_place(payload.get("place"), step, op):
                pass
            continue
        if op == "place.create":
            if step < len(proposals) - 1:
                issues.append({"step": step, "code": "batch_unsupported_create", "op": op})
            continue
        if op == "item.adjust":
            if _dead_item(iid, step, op):
                continue
            delta = payload.get("delta")
            if not isinstance(delta, int) or isinstance(delta, bool) or delta == 0:
                issues.append({"step": step, "code": "invalid_delta", "op": op})
                continue
            new_q = int(qty[iid]) + int(delta)
            if new_q < 0 or new_q > QTY_MAX:
                issues.append({"step": step, "code": "batch_bounds", "op": op, "would_be": new_q})
                continue
            qty[iid] = new_q
            item_rev[iid] += 1
        elif op == "item.update":
            if _dead_item(iid, step, op):
                continue
            want_rev = payload.get("rev")
            if want_rev != item_rev.get(iid):
                issues.append({"step": step, "code": "stale_item_rev", "op": op})
                continue
            new_place = item_place.get(iid)
            if "place" in payload:
                raw_place = payload.get("place")
                if raw_place in ("", None):
                    new_place = None
                elif _dead_place(raw_place, step, op):
                    continue
                else:
                    new_place = raw_place
            if "qty" in payload:
                q = payload["qty"]
                if isinstance(q, int) and not isinstance(q, bool):
                    if q < 0 or q > QTY_MAX:
                        issues.append({"step": step, "code": "batch_bounds", "op": op})
                        continue
                    qty[iid] = q
            item_place[iid] = new_place
            item_rev[iid] += 1
        elif op == "item.delete":
            if not isinstance(iid, str):
                issues.append({"step": step, "code": "not_found", "op": op})
                continue
            if iid in deleted_items:
                issues.append({"step": step, "code": "batch_duplicate_delete", "op": op, "item_id": iid})
                continue
            if iid not in qty:
                issues.append({"step": step, "code": "not_found", "op": op})
                continue
            want_rev = payload.get("rev")
            if want_rev != item_rev.get(iid):
                issues.append({"step": step, "code": "stale_item_rev", "op": op})
                continue
            deleted_items.add(iid)
            qty.pop(iid, None)
            item_rev.pop(iid, None)
            item_place.pop(iid, None)
        elif op == "item.move":
            ids = payload.get("ids") or []
            dest = payload.get("place")
            if _dead_place(dest, step, op):
                continue
            for mid in ids:
                if _dead_item(mid, step, op):
                    break
            else:
                dest_norm = dest if dest not in (None, "") else None
                for mid in dict.fromkeys(ids):
                    if item_place.get(mid) != dest_norm:
                        item_place[mid] = dest_norm
                        item_rev[mid] = item_rev.get(mid, 1) + 1
        elif op == "place.update":
            pid = payload.get("id")
            if _dead_place(pid, step, op):
                continue
            if pid not in places:
                issues.append({"step": step, "code": "not_found", "op": op})
                continue
            want_rev = payload.get("rev")
            if want_rev != place_rev.get(pid):
                issues.append({"step": step, "code": "stale_place_rev", "op": op, "place_id": pid})
                continue
            if "parent" in payload:
                parent = payload.get("parent")
                if parent in ("",):
                    parent = None
                if parent is not None and _dead_place(parent, step, op):
                    continue
                cur = parent if isinstance(parent, str) else None
                seen: set[str] = set()
                cycle = False
                while isinstance(cur, str):
                    if cur == pid or cur in seen:
                        cycle = True
                        break
                    seen.add(cur)
                    cur = place_parent.get(cur)
                if cycle:
                    issues.append({"step": step, "code": "batch_place_cycle", "op": op, "place_id": pid})
                    continue
                parent_norm = parent if isinstance(parent, str) else None
                if parent_norm is not None:
                    depth = _place_depth(parent_norm)
                    if depth is None or depth + _subtree_height(pid, pid) > DEPTH_MAX:
                        issues.append({"step": step, "code": "batch_place_too_deep", "op": op, "place_id": pid})
                        continue
                place_parent[pid] = parent_norm
            place_rev[pid] = int(place_rev.get(pid, 1)) + 1
        elif op == "place.delete":
            pid = payload.get("id")
            if not isinstance(pid, str) or pid in deleted_places:
                if pid in deleted_places:
                    issues.append({"step": step, "code": "batch_duplicate_delete", "op": op})
                else:
                    issues.append({"step": step, "code": "not_found", "op": op})
                continue
            if pid not in places:
                issues.append({"step": step, "code": "not_found", "op": op})
                continue
            want_rev = payload.get("rev")
            if want_rev != place_rev.get(pid):
                issues.append({"step": step, "code": "stale_place_rev", "op": op, "place_id": pid})
                continue
            occupied = any(pl == pid for pl in item_place.values()) or any(
                par == pid for par in place_parent.values()
            )
            if occupied:
                issues.append({"step": step, "code": "batch_place_not_empty", "op": op, "place_id": pid})
                continue
            deleted_places.add(pid)
            places.discard(pid)
            place_rev.pop(pid, None)
            place_parent.pop(pid, None)
        else:
            issues.append({"step": step, "code": "batch_op_unsupported", "op": op})
    return issues


def _session_row_to_api(row: sqlite3.Row) -> dict:
    msgs = json.loads(row["messages_json"] or "[]")
    return {
        "id": row["id"],
        "device_id": row["device_id"],
        "owner": row["owner"],
        "status": row["status"],
        "messages": msgs,
        "rev": int(row["rev"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _op_row_to_api(row: sqlite3.Row) -> dict:
    def _loads(col: str, default: Any = None) -> Any:
        raw = row[col]
        if raw is None:
            return default
        return json.loads(raw)

    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "status": row["status"],
        "proposals": _loads("proposals_json", []),
        "validation": _loads("validation_json"),
        "preview": _loads("preview_json"),
        "expected_inventory_rev": row["expected_inventory_rev"],
        "item_rev_expectations": _loads("item_rev_expectations_json"),
        "preview_digest": row["preview_digest"],
        "preview_confirmed": bool(int(row["preview_confirmed"])),
        "commit_idempotency_key": row["commit_idempotency_key"],
        "cross_store_op_id": row["cross_store_op_id"],
        "commit_result": _loads("commit_result_json"),
        "rev": int(row["rev"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def create_session(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    device_id = str(data.get("device_id") or "unknown")[:120]
    owner = str(data.get("owner") or _actor())[:120]
    sid = _new_id("session")
    now = _now()
    conn.execute(
        "INSERT INTO inventoria_sessions("
        "id, household_id, device_id, owner, status, messages_json, rev, created_at, updated_at"
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (sid, household_id, device_id, owner, "open", "[]", 1, now, now),
    )
    return {"ok": True, "session": _session_row_to_api(conn.execute(
        "SELECT * FROM inventoria_sessions WHERE id = ?", (sid,),
    ).fetchone())}


def get_session(conn: sqlite3.Connection, household_id: str, session_id: str) -> dict:
    row = conn.execute(
        "SELECT * FROM inventoria_sessions WHERE id = ? AND household_id = ?",
        (session_id, household_id),
    ).fetchone()
    if row is None:
        raise InventoriaError("session introuvable", status=404, code="not_found")
    pending = conn.execute(
        "SELECT * FROM inventoria_operations WHERE session_id = ? AND status IN ('draft', 'validated', 'previewed') "
        "ORDER BY created_at DESC LIMIT 10", (session_id,)).fetchall()
    return {"ok": True, "session": _session_row_to_api(row), "pending_operations": [_op_row_to_api(r) for r in reversed(pending)]}


CREATE_OPS = ("item.create", "place.create")


def split_commit_batches(proposals: list[dict]) -> list[list[dict]]:
    """A commit batch may hold only ONE create and only as its LAST step (a later step cannot reference an id that does not
    exist yet). Group a drafted list accordingly: every non-create first plus the first create, then one batch per extra create."""
    creates = [p for p in proposals if p.get("op") in CREATE_OPS]
    if not creates:
        return [proposals]
    base = [p for p in proposals if p.get("op") not in CREATE_OPS]
    return [base + [creates[0]]] + [[c] for c in creates[1:]]


def _card_operation(operations: list[dict], rows: list[dict], inv: dict) -> str | None:
    """The one drafted operation that touches a review card's rows (by item id, or by item
    name resolved through the inventory), else None. Never guesses by position."""
    ids = {str(r["item_id"]) for r in rows if isinstance(r, dict) and r.get("item_id")}
    names = {str(r["name"]).strip().casefold() for r in rows if isinstance(r, dict) and isinstance(r.get("name"), str)}
    if not ids and not names:
        return None
    item_names = {i["id"]: str(i.get("name") or "").strip().casefold() for i in inv.get("items") or []}
    hits: list[str] = []
    for op in operations:
        for p in op.get("proposals") or []:
            payload = p.get("payload") or {}
            refs = p.get("refs") or {}
            op_ids = {x for x in [payload.get("id"), refs.get("item_id"), *(payload.get("ids") or [])] if isinstance(x, str)}
            op_names = {item_names[x] for x in op_ids if x in item_names}
            if isinstance(payload.get("name"), str):
                op_names.add(payload["name"].strip().casefold())
            if (op_ids & ids) or (op_names & names):
                hits.append(op["id"])
                break
    return hits[0] if len(hits) == 1 else None


def post_session_message(
    conn: sqlite3.Connection,
    household_id: str,
    session_id: str,
    data: dict,
    *,
    split: bool = False,
    auto: bool = False,
) -> dict:
    """Store a turn and its drafts. ``auto`` (set by the routes, and for model replies) lets trusted quantity
    adjusts go into their own batch, listed in the internal ``_auto`` key for http_post to apply after the save."""
    row = conn.execute(
        "SELECT * FROM inventoria_sessions WHERE id = ? AND household_id = ?",
        (session_id, household_id),
    ).fetchone()
    if row is None:
        raise InventoriaError("session introuvable", status=404, code="not_found")
    if row["status"] != "open":
        raise InventoriaError("session fermée", status=409, code="conflict")
    messages = json.loads(row["messages_json"] or "[]")
    base_rev = int(row["rev"] or 0)      # revision this turn is based on
    base_messages = list(messages)
    now = _now()
    proposals: list[dict] = []
    image: dict | None = None
    split_ok = False  # only model-drafted lists are re-grouped into valid commit batches
    grocery_lines: list[dict] = []
    detections: dict | None = None

    if "proposals" in data:
        raw = data["proposals"]
        if not isinstance(raw, list) or len(raw) > PROPOSALS_MAX:
            raise InventoriaError(f"proposals invalides (max {PROPOSALS_MAX})", code="validation_error")
        for p in raw:
            proposals.append(schemas.validate_inventoria_proposal(p))
        split_ok = bool(split)      # server-built lists (photo review) are grouped into valid commit batches
    elif "text" in data or "image" in data:
        text = str(data.get("text") or "").strip()
        if data.get("image") is not None:
            image = parse_photo(data.get("image"))
            if image is None:
                raise InventoriaError("photo invalide (png, jpeg ou webp, 2 Mo max)", code="validation_error")
            text = text or "(photo)"
            import hq_inventoria_photos as photos
            fp = photos.fingerprint(image)
            prior = None if data.get("force") is True else photos.seen(_root(), fp, _now())
            if prior is not None:
                # The same picture was analysed before: ask before spending a model call (and risking a doubled stock update).
                applied = conn.execute(
                    "SELECT COUNT(*) FROM inventoria_operations WHERE session_id = ? AND status = 'committed' AND created_at >= ?",
                    (prior.get("session"), float(prior.get("at", 0)) - 1.0)).fetchone()[0]
                return {"ok": True, "messages": messages, "duplicate_photo": {"at": prior.get("at"), "applied": bool(applied)}}
        if not text:
            raise InventoriaError("text requis", code="validation_error")
        if len(text) > TEXT_MAX:
            raise InventoriaError("text trop long", code="validation_error")
        messages.append({"role": "user", "text": ("\U0001F4F7 " + text) if image else text, "at": now})
        adapter = _cb.get("llm_adapter")
        if callable(adapter):
            _ctx.history = [m for m in messages[:-1] if isinstance(m, dict)]
            _ctx.image = image
            _ctx.intent = data.get("intent") if data.get("intent") in ("stock", "grocery", "count") else None
            _ctx.conn, _ctx.household_id = conn, household_id
            _ctx.job = data.get("job") if isinstance(data.get("job"), str) else ""
            try:
                draft = adapter(text, session_id=session_id)
            except InventoriaError:
                raise
            except Exception as exc:
                import hq_ai
                if isinstance(exc, hq_ai.AiError):
                    msg, retry = _friendly_model_error(exc)
                    raise InventoriaError(msg, status=503 if retry else 502, code="model_busy" if retry else "model_error",
                                          retryable=retry) from exc
                raise InventoriaError(str(exc)[:200], code="validation_error") from exc
            finally:
                _ctx.history = None
                _ctx.image = None
                _ctx.intent = None
                _ctx.conn = None
                _ctx.job = None
            if isinstance(draft, dict) and draft.get("cancelled"):
                # The Master pressed Cancel: the turn stops at its next round or tool
                # call, so no message and no stock draft is stored. Notes, watches or a
                # store preference she saved before stopping are kept; say how many.
                kept = draft.get("kept_changes")
                kept = kept if isinstance(kept, int) and not isinstance(kept, bool) and kept > 0 else 0
                return {"ok": True, "cancelled": True, "kept_changes": kept, "messages": base_messages}
            raw_out = json.dumps(draft, ensure_ascii=False, default=str)
            if len(raw_out) > ADAPTER_OUTPUT_MAX:
                raise InventoriaError("réponse modèle trop volumineuse", code="validation_error")
            if not isinstance(draft, dict):
                raise InventoriaError("réponse modèle invalide", code="validation_error")
            raw_props = draft.get("proposals")
            raw_grocery = draft.get("grocery_lines")
            raw_detect = draft.get("detections")
            if isinstance(raw_detect, dict) and isinstance(raw_detect.get("rows"), list):
                detections = {"mode": "count" if raw_detect.get("mode") == "count" else "add",
                              "rows": [r for r in raw_detect["rows"][:60] if isinstance(r, dict)],
                              "truncated": int(raw_detect.get("truncated") or 0)}
            if isinstance(raw_grocery, list):
                grocery_lines = [g for g in raw_grocery[:40] if isinstance(g, dict) and isinstance(g.get("name"), str)]
            reply_text = draft.get("reply")
            has_reply = isinstance(reply_text, str) and bool(reply_text.strip())
            if has_reply:
                messages.append({"role": "assistant", "text": reply_text.strip()[:REPLY_TEXT_MAX], "at": now})
            if raw_props is not None:
                if not isinstance(raw_props, list) or len(raw_props) > PROPOSALS_MAX:
                    raise InventoriaError(
                        f"proposals invalides (max {PROPOSALS_MAX})",
                        code="validation_error",
                    )
                for p in raw_props:
                    proposals.append(schemas.validate_inventoria_proposal(p))
                split_ok = True
                auto = True          # her drafted adjusts may apply at once when the Master allows it
        else:
            messages.append({
                "role": "assistant",
                "text": "Propositions structurées requises (champ proposals).",
                "at": now,
            })
    else:
        raise InventoriaError("text ou proposals requis", code="validation_error")

    # Reviews she is waiting on (photo rows, grocery lines) are kept with her message so they survive a reload.
    card_meta: dict | None = None
    inv_now: dict | None = None
    if (detections and detections["rows"]) or grocery_lines:
        last = messages[-1] if messages and isinstance(messages[-1], dict) and messages[-1].get("role") == "assistant" else None
        inv_now = inventory.snapshot()
        if detections and detections["rows"]:
            detections["places"] = [{"id": p["id"], "name": p.get("name")} for p in inv_now.get("places", [])][:80]
        if last is not None:
            card_meta = last.setdefault("meta", {})
            if detections and detections["rows"]:
                card_meta["detections"] = detections
            if grocery_lines:
                card_meta["grocery"] = grocery_lines
    # This turn's own messages, taken before any trim: a merge below must append them,
    # and slicing after the trim would lose them on a long conversation.
    added = messages[len(base_messages):]
    if len(messages) > MESSAGES_MAX and "text" in data and callable(_cb.get("llm_adapter")):
        messages = messages[-(MESSAGES_MAX - 10):]  # chat transcript: keep the newest, never block a conversation
    if len(messages) > MESSAGES_MAX:
        raise InventoriaError(f"messages max {MESSAGES_MAX}", code="validation_error")

    with _session_write_lock:
        fresh = conn.execute(
            "SELECT rev, messages_json FROM inventoria_sessions WHERE id = ? AND household_id = ?",
            (session_id, household_id),
        ).fetchone()
        if fresh is None:
            raise InventoriaError("session introuvable", status=404, code="not_found")
        expect_rev = base_rev
        if int(fresh["rev"] or 0) != base_rev:
            # A message landed while the model was thinking: keep that turn and
            # append ours after it, and save against the revision just read.
            try:
                existing = json.loads(fresh["messages_json"] or "[]")
            except ValueError:
                existing = []
            messages = ([m for m in existing if isinstance(m, dict)] + added)[-MESSAGES_MAX:]
            expect_rev = int(fresh["rev"] or 0)

        batches = split_commit_batches(proposals) if (proposals and split_ok) else ([proposals] if proposals else [])
        trusted_first = False
        if auto and proposals:
            prefs = _prefs()
            if prefs.get("auto_apply"):
                idx = _trusted_indexes(proposals, inventory.snapshot(), int(prefs.get("auto_delta_max") or 0))
                if idx:
                    chosen = set(idx)
                    rest = [p for i, p in enumerate(proposals) if i not in chosen]
                    batches = [[proposals[i] for i in idx]] + (
                        (split_commit_batches(rest) if split_ok else [rest]) if rest else [])
                    trusted_first = True
        operations: list[dict] = []
        for batch in batches:
            op_id = _new_id("op")
            conn.execute(
                "INSERT INTO inventoria_operations("
                "id, household_id, session_id, status, proposals_json, rev, created_at, updated_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (op_id, household_id, session_id, "draft", _safe_json(batch), 1, now, now),
            )
            _audit(conn, household_id=household_id, operation_id=op_id, action="propose",
                   prev_status=None, next_status="draft", detail={"count": len(batch)})
            operations.append(_op_row_to_api(conn.execute(
                "SELECT * FROM inventoria_operations WHERE id = ?", (op_id,),
            ).fetchone()))
        operation = operations[0] if operations else None

        # Which drafted operation each review card belongs to, decided here from item ids and
        # names (never from label wording), so the card's Ignorer cancels exactly that one.
        cards: dict[str, str | None] = {}
        if detections and detections["rows"]:
            cards["detections"] = _card_operation(operations, detections["rows"], inv_now or {})
        if grocery_lines:
            cards["grocery"] = _card_operation(operations, grocery_lines, inv_now or {})
        if card_meta is not None:
            for kind, op_ref in cards.items():
                if op_ref:
                    card_meta[kind + "_op"] = op_ref

        written = conn.execute(
            "UPDATE inventoria_sessions SET messages_json = ?, updated_at = ?, rev = ? WHERE id = ? AND rev = ?",
            (_safe_json(messages), now, expect_rev + 1, session_id, expect_rev),
        )
        if written.rowcount != 1:
            raise InventoriaError("conversation modifiée — réessaie", status=409, code="conflict", retryable=True)
    if image is not None:
        # Only a turn that was actually saved counts as "already analysed"; a failed save
        # must not make the retry answer "you already sent this picture".
        try:
            import hq_inventoria_photos as photos
            photos.record(_root(), photos.fingerprint(image), session_id, now)
        except Exception:
            pass
    out: dict[str, Any] = {"ok": True, "messages": messages}
    if trusted_first and operations:
        out["_auto"] = [operations[0]["id"]]     # internal: http_post applies it after this transaction commits
    if cards:
        out["cards"] = cards
    if detections and detections["rows"]:
        out["detections"] = detections      # editable review card in the chip; drafts are built only after the Master confirms
    if grocery_lines:
        out["grocery"] = {"lines": grocery_lines}    # needed items: the chip asks the Master before they reach the grocery list
    if operation:
        out["operation"] = operation
        if len(operations) > 1:
            out["operations"] = operations  # applied in order by the client; each is previewed and committed on its own
    return out


def validate_operation(
    conn: sqlite3.Connection,
    household_id: str,
    op_id: str,
    data: dict | None = None,
) -> dict:
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (op_id, household_id),
    ).fetchone()
    if row is None:
        raise InventoriaError("opération introuvable", status=404, code="not_found")
    if row["status"] not in ("draft", "validated"):
        raise InventoriaError("statut incompatible validate", status=409, code="conflict")
    inv = inventory.snapshot()
    proposals = [_fill_create_defaults(p, inv) for p in json.loads(row["proposals_json"] or "[]")]
    resolved: list[dict] = []
    issues: list[dict] = []
    for p in proposals:
        rp, local = _resolve_proposal(p, inv)
        issues.extend(local)
        resolved.append(rp)

    if not issues:
        issues.extend(_simulate_batch_sequential(resolved, inv))
    validation = {"ok": not issues, "issues": issues, "proposals": resolved}
    now = _now()
    prev = row["status"]
    next_status = "validated" if validation["ok"] else "draft"
    conn.execute(
        "UPDATE inventoria_operations SET status = ?, proposals_json = ?, "
        "validation_json = ?, preview_json = NULL, preview_digest = NULL, "
        "preview_confirmed = 0, expected_inventory_rev = NULL, "
        "item_rev_expectations_json = NULL, updated_at = ?, rev = rev + 1 WHERE id = ?",
        (next_status, _safe_json(resolved), _safe_json(validation), now, op_id),
    )
    _audit(conn, household_id=household_id, operation_id=op_id, action="validate",
           prev_status=prev, next_status=next_status)
    api = _op_row_to_api(conn.execute("SELECT * FROM inventoria_operations WHERE id = ?", (op_id,)).fetchone())
    return {"ok": True, "operation": api, "validation": validation}


def _preview_diff(
    proposals: list[dict],
    inv: dict,
    item_expectations: list[dict],
) -> dict:
    changes: list[dict] = []
    for p in proposals:
        op = p["op"]
        payload = p["payload"]
        entry: dict[str, Any] = {"op": op, "label_fr": p.get("label_fr", ""), "refs": p.get("resolved", {})}
        if op == "item.adjust":
            iid = payload.get("id")
            entry["item_id"] = iid
            item = next((i for i in inv["items"] if i["id"] == iid), None)
            if item:
                entry["before"] = {"qty": item["qty"], "rev": item["rev"]}
                entry["after"] = {"qty": item["qty"] + int(payload["delta"]), "rev": item["rev"] + 1}
        elif op == "item.update":
            iid = payload["id"]
            entry["item_id"] = iid
            item = next((i for i in inv["items"] if i["id"] == iid), None)
            if item:
                entry["before"] = {k: item.get(k) for k in payload if k not in ("id", "rev")}
                entry["after"] = {k: payload[k] for k in payload if k not in ("id", "rev")}
            if "place" in payload:
                dest = payload.get("place")
                if dest in ("",):
                    dest = None
                place = next((pl for pl in inv.get("places") or [] if pl["id"] == dest), None) if dest else None
                entry["destination"] = {"id": dest, "name": place.get("name") if place else None}
        elif op == "item.create":
            entry["effect"] = "create"
            entry["after"] = {k: payload[k] for k in payload if k != "id"}
        elif op == "item.delete":
            iid = payload.get("id")
            item = next((i for i in inv["items"] if i["id"] == iid), None)
            entry["item_id"] = iid
            entry["effect"] = "delete"
            if item:
                entry["before"] = {
                    "id": item["id"],
                    "name": item.get("name"),
                    "rev": item.get("rev"),
                    "qty": item.get("qty"),
                    "place": item.get("place"),
                    "unit": item.get("unit"),
                }
            entry["after"] = {"deleted": True}
        elif op == "place.create":
            parent = payload.get("parent")
            parent_row = next((pl for pl in inv.get("places") or [] if pl["id"] == parent), None) if parent else None
            entry["effect"] = "create"
            entry["after"] = {k: payload[k] for k in payload if k != "id"}
            if parent:
                entry["parent"] = {"id": parent, "name": parent_row.get("name") if parent_row else None}
        elif op == "place.update":
            pid = payload.get("id")
            place = next((pl for pl in inv.get("places") or [] if pl["id"] == pid), None)
            entry["place_id"] = pid
            entry["effect"] = "update"
            if place:
                entry["before"] = {
                    "id": place["id"],
                    "name": place.get("name"),
                    "rev": place.get("rev"),
                    "parent": place.get("parent"),
                    "kind": place.get("kind"),
                }
            entry["after"] = {k: payload[k] for k in payload if k not in ("id", "rev")}
            if "parent" in payload:
                dest = payload.get("parent")
                dest_row = next((pl for pl in inv.get("places") or [] if pl["id"] == dest), None) if dest else None
                entry["parent"] = {"id": dest, "name": dest_row.get("name") if dest_row else None}
        elif op == "place.delete":
            pid = payload.get("id")
            place = next((pl for pl in inv.get("places") or [] if pl["id"] == pid), None)
            entry["place_id"] = pid
            entry["effect"] = "delete"
            if place:
                entry["before"] = {
                    "id": place["id"],
                    "name": place.get("name"),
                    "rev": place.get("rev"),
                    "parent": place.get("parent"),
                    "kind": place.get("kind"),
                }
            entry["occupancy"] = {
                "items": sum(1 for i in inv.get("items") or [] if i.get("place") == pid),
                "child_places": sum(1 for pl in inv.get("places") or [] if pl.get("parent") == pid),
            }
            entry["after"] = {"deleted": True}
        elif op == "item.move":
            ids = [i for i in (payload.get("ids") or []) if isinstance(i, str)]
            entry["items"] = [
                {
                    "id": iid,
                    "name": next((i.get("name") for i in inv["items"] if i["id"] == iid), None),
                }
                for iid in ids
            ]
            dest = payload.get("place")
            place = next((p for p in inv.get("places") or [] if p["id"] == dest), None) if dest else None
            entry["destination"] = {
                "id": dest if dest not in ("",) else None,
                "name": place.get("name") if place else None,
            }
        changes.append(entry)
    digest = _commit_preview_digest(proposals, int(inv["rev"]), item_expectations)
    return {"changes": changes, "preview_digest": digest, "inventory_rev": inv["rev"]}


def preview_operation(conn: sqlite3.Connection, household_id: str, op_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, PREVIEW_KEYS)
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (op_id, household_id),
    ).fetchone()
    if row is None:
        raise InventoriaError("opération introuvable", status=404, code="not_found")
    if row["status"] not in ("validated", "previewed"):
        raise InventoriaError("valider avant preview", status=409, code="conflict")
    val = json.loads(row["validation_json"] or "{}")
    if not val.get("ok"):
        raise InventoriaError("validation incomplète", status=409, code="validation_error")
    proposals = json.loads(row["proposals_json"] or "[]")
    inv = inventory.snapshot()
    issues: list[dict] = []
    re_resolved: list[dict] = []
    for p in proposals:
        rp, local = _resolve_proposal(p, inv)
        issues.extend(local)
        re_resolved.append(rp)
    if issues:
        raise InventoriaError(
            "preview refusé — références ou bornes",
            status=409,
            code="validation_error",
        )
    batch_issues = _simulate_batch_sequential(re_resolved, inv)
    if batch_issues:
        raise InventoriaError(
            "preview refusé — lot incompatible",
            status=409,
            code="validation_error",
        )
    item_expectations: list[dict] = []
    for p in re_resolved:
        payload = p["payload"]
        if p["op"] in ("item.update", "item.delete", "item.adjust"):
            iid = payload.get("id")
            item = next((i for i in inv["items"] if i["id"] == iid), None)
            if item:
                item_expectations.append({"item_id": iid, "rev": item["rev"]})
    preview = _preview_diff(re_resolved, inv, item_expectations)
    confirm = schemas.require_bool(data.get("confirm", False), "confirm")
    now = _now()
    prev = row["status"]
    confirmed_int = 1 if confirm else 0
    conn.execute(
        "UPDATE inventoria_operations SET status = ?, proposals_json = ?, "
        "preview_json = ?, preview_digest = ?, "
        "expected_inventory_rev = ?, item_rev_expectations_json = ?, preview_confirmed = ?, "
        "updated_at = ?, rev = rev + 1 WHERE id = ?",
        (
            "previewed", _safe_json(re_resolved), _safe_json(preview), preview["preview_digest"],
            int(preview["inventory_rev"]),
            _safe_json(item_expectations) if item_expectations else None,
            confirmed_int, now, op_id,
        ),
    )
    _audit(conn, household_id=household_id, operation_id=op_id, action="preview",
           prev_status=prev, next_status="previewed")
    api = _op_row_to_api(conn.execute("SELECT * FROM inventoria_operations WHERE id = ?", (op_id,)).fetchone())
    return {"ok": True, "operation": api, "preview": preview}


def _idem_lookup(
    conn: sqlite3.Connection,
    household_id: str,
    key: str,
    req_hash: str,
    operation_id: str,
) -> dict | None:
    row = conn.execute(
        "SELECT request_hash, response_json, operation_id FROM inventoria_commit_idempotency "
        "WHERE household_id = ? AND idempotency_key = ?",
        (household_id, key),
    ).fetchone()
    if row is None:
        return None
    if row["operation_id"] != operation_id:
        raise InventoriaError(
            "clé idempotency liée à une autre opération",
            status=409,
            code="conflict",
        )
    if row["request_hash"] != req_hash:
        raise InventoriaError("idempotency conflict", status=409, code="conflict")
    return json.loads(row["response_json"])


def _idem_store(
    conn: sqlite3.Connection,
    household_id: str,
    key: str,
    op_id: str,
    req_hash: str,
    response: dict,
) -> None:
    conn.execute(
        "INSERT INTO inventoria_commit_idempotency("
        "household_id, idempotency_key, operation_id, request_hash, response_json, created_at"
        ") VALUES (?, ?, ?, ?, ?, ?)",
        (household_id, key, op_id, req_hash, _safe_json(response), _now()),
    )


def commit_operation(conn: sqlite3.Connection, household_id: str, op_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, COMMIT_KEYS)
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (op_id, household_id),
    ).fetchone()
    if row is None:
        raise InventoriaError("opération introuvable", status=404, code="not_found")
    if int(row["preview_confirmed"] or 0) != 1:
        raise InventoriaError("preview non confirmé", status=409, code="conflict")
    try:
        schemas.require_idempotency_key(data.get("idempotency_key"))
    except schemas.SchemaError as exc:
        raise InventoriaError(str(exc), code=exc.code) from exc

    key = str(data["idempotency_key"])
    if (
        row["status"] == "committed"
        and row["commit_idempotency_key"] == key
        and row["request_hash"]
    ):
        cached_final = _idem_lookup(conn, household_id, key, str(row["request_hash"]), op_id)
        if cached_final is not None:
            return cached_final
    if row["preview_digest"] is None or row["expected_inventory_rev"] is None:
        raise InventoriaError("preview approuvé manquant", status=409, code="conflict")
    item_exp = json.loads(row["item_rev_expectations_json"] or "[]") if row["item_rev_expectations_json"] else []
    proposals = json.loads(row["proposals_json"] or "[]")
    stored_digest = str(row["preview_digest"])
    exp_rev = int(row["expected_inventory_rev"])
    expected_digest = _commit_preview_digest(proposals, exp_rev, item_exp)
    if expected_digest != stored_digest:
        raise InventoriaError("preview obsolète", status=409, code="conflict")

    body_for_hash = {
        "operation_id": op_id,
        "idempotency_key": key,
        "preview_digest": stored_digest,
        "expected_inventory_rev": exp_rev,
        "item_rev_expectations": item_exp,
    }
    req_hash = _body_hash(body_for_hash)
    cached = _idem_lookup(conn, household_id, key, req_hash, op_id)
    if cached is not None:
        return cached
    if not _claim_commit(op_id):
        return _commit_in_progress(op_id)
    try:
        return _commit_operation_owned(
            conn, household_id, op_id, row, key, req_hash, proposals, stored_digest, exp_rev, item_exp,
        )
    finally:
        _release_commit(op_id)


def _commit_operation_owned(
    conn: sqlite3.Connection,
    household_id: str,
    op_id: str,
    row: sqlite3.Row,
    key: str,
    req_hash: str,
    proposals: list[dict],
    stored_digest: str,
    exp_rev: int,
    item_exp: list[dict],
) -> dict:
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (op_id, household_id),
    ).fetchone()
    cached = _idem_lookup(conn, household_id, key, req_hash, op_id)
    if cached is not None:
        return cached
    if row["status"] == "cancelled":
        raise InventoriaError("opération annulée", status=409, code="conflict")
    if row["status"] == "previewed":
        if int(row["preview_confirmed"] or 0) != 1:
            raise InventoriaError("preview non confirmé", status=409, code="conflict")
        fresh_digest = str(row["preview_digest"] or "")
        fresh_rev = row["expected_inventory_rev"]
        if fresh_digest != stored_digest or fresh_rev is None or int(fresh_rev) != exp_rev:
            raise InventoriaError("preview obsolète", status=409, code="conflict")
    if row["status"] == "committed":
        if row["commit_idempotency_key"] not in (None, key):
            raise InventoriaError("opération déjà engagée", status=409, code="conflict")
        body = json.loads(row["commit_result_json"] or "{}")
        out = {"ok": True, "commit": body, "operation_id": op_id}
        if row["commit_idempotency_key"] == key and row["request_hash"] == req_hash:
            _idem_store(conn, household_id, key, op_id, req_hash, out)
        return out

    if row["status"] not in ("previewed", "committing", "needs_reconcile"):
        raise InventoriaError("preview requis avant commit", status=409, code="conflict")

    val = json.loads(row["validation_json"] or "{}")
    if not val.get("ok"):
        raise InventoriaError("validation invalide", status=409, code="validation_error")

    inv = inventory.snapshot()
    rev_before = int(inv["rev"])
    inventory.bind(root=_root(), asset_exists=_cb.get("asset_exists"))
    resume = row["status"] in ("committing", "needs_reconcile") and row["cross_store_op_id"]
    finalize_only = False
    uncertain_resume = False
    if row["cross_store_op_id"]:
        finalize_only = commit_mod.journal_ready_to_finalize(conn, row["cross_store_op_id"])
        xstat = conn.execute(
            "SELECT status, uncertain_inventory FROM cross_store_ops WHERE id = ?",
            (row["cross_store_op_id"],),
        ).fetchone()
        if xstat is not None and (
            int(xstat["uncertain_inventory"]) == 1 or xstat["status"] == "needs_reconcile"
        ):
            uncertain_resume = True
    if resume:
        xop = conn.execute(
            "SELECT step_results_json FROM cross_store_ops WHERE id = ?",
            (row["cross_store_op_id"],),
        ).fetchone()
        if xop and xop["step_results_json"]:
            parsed = json.loads(xop["step_results_json"])
            if parsed:
                last = parsed[-1]
                if isinstance(last, dict) and isinstance(last.get("inventory_rev"), int):
                    exp_rev = int(last["inventory_rev"])
    if not finalize_only and not uncertain_resume:
        if rev_before != exp_rev:
            raise InventoriaError("révision inventaire obsolète", status=409, code="conflict")
        batch_issues = _simulate_batch_sequential(proposals, inv)
        if batch_issues:
            raise InventoriaError(
                "commit refusé — lot incompatible",
                status=409,
                code="validation_error",
            )
    result = commit_mod.run_inventoria_commit(
        conn,
        household_id=household_id,
        operation_id=op_id,
        proposals=proposals,
        idempotency_key=key,
        request_hash=req_hash,
        expected_inventory_rev=exp_rev,
        item_rev_expectations=item_exp or None,
        preview_digest=stored_digest,
        now=_now(),
        resume=bool(resume),
    )
    if result.get("ok"):
        out = {"ok": True, "commit": result, "operation_id": op_id}
        if row["status"] != "committed":
            _idem_store(conn, household_id, key, op_id, req_hash, out)
        _audit(conn, household_id=household_id, operation_id=op_id, action="commit",
               prev_status=row["status"], next_status="committed")
        return out
    if result.get("code") == "needs_reconcile":
        _audit(conn, household_id=household_id, operation_id=op_id, action="commit",
               prev_status=row["status"], next_status="needs_reconcile", detail=result)
        failed = {
            "ok": False,
            "code": "needs_reconcile",
            "operation_id": op_id,
            "cross_store_op_id": result.get("cross_store_op_id"),
        }
        if result.get("error"):
            failed["error"] = result["error"]
        if result.get("http_status"):
            failed["http_status"] = int(result["http_status"])
        return failed
    if result.get("cross_store_op_id"):
        _audit(conn, household_id=household_id, operation_id=op_id, action="commit",
               prev_status=row["status"], next_status="needs_reconcile", detail=result)
        return {
            "ok": False,
            "code": result.get("code", "needs_reconcile"),
            "error": result.get("error"),
            "operation_id": op_id,
            "cross_store_op_id": result.get("cross_store_op_id"),
            "http_status": result.get("http_status", 409),
        }
    raise InventoriaError(result.get("error", "échec commit"), status=409, code=result.get("code", "conflict"))


_NON_CANCELLABLE = frozenset({
    "committed", "committing", "needs_reconcile", "failed",
})


def undo_operation(conn: sqlite3.Connection, household_id: str, op_id: str) -> dict:
    """Create an inverse DRAFT for a committed batch. Nothing is applied; the Master previews and confirms it."""
    import hq_inventoria_undo as undo_mod
    row = conn.execute("SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?", (op_id, household_id)).fetchone()
    if row is None:
        raise InventoriaError("opération introuvable", status=404, code="not_found")
    if row["status"] != "committed":
        raise InventoriaError("seul un lot appliqué peut être annulé", status=409, code="conflict")
    entry = undo_mod.get(_root(), op_id)
    if entry is None:
        raise InventoriaError("ce lot n'a pas de journal d'annulation", status=409, code="conflict")
    prior = entry.get("undone_by")
    if prior:
        prow = conn.execute("SELECT * FROM inventoria_operations WHERE id = ?", (prior,)).fetchone()
        if prow is not None and prow["status"] in ("draft", "validated", "previewed"):
            return {"ok": True, "operation": _op_row_to_api(prow), "existing": True}   # idempotent: same pending undo
        if prow is not None and prow["status"] == "committed":
            raise InventoriaError("ce lot est déjà annulé", status=409, code="conflict")
        undo_mod.clear_undo_mark(_root(), op_id)
    inv = inventory.snapshot()
    props, skipped = undo_mod.inverse(entry, inv)
    if not props:
        raise InventoriaError("rien à annuler" + (" (" + ", ".join(skipped[:3]) + ")" if skipped else ""), status=409, code="conflict")
    for p in props:
        schemas.validate_inventoria_proposal(p)
    resolved, issues = [], []
    for p in props:
        rp, local = _resolve_proposal(p, inv)
        resolved.append(rp)
        issues.extend(local)
    issues.extend(_simulate_batch_sequential(resolved, inv))
    if issues:
        raise InventoriaError("annulation impossible : le stock a changé depuis", status=409, code="conflict")
    new_id = _new_id("op")
    now = _now()
    conn.execute(
        "INSERT INTO inventoria_operations(id, household_id, session_id, status, proposals_json, rev, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (new_id, household_id, row["session_id"], "draft", _safe_json(props), 1, now, now),
    )
    _audit(conn, household_id=household_id, operation_id=new_id, action="propose", prev_status=None, next_status="draft",
           detail={"count": len(props), "undo_of": op_id})
    undo_mod.mark_undo(_root(), op_id, new_id)
    api = _op_row_to_api(conn.execute("SELECT * FROM inventoria_operations WHERE id = ?", (new_id,)).fetchone())
    return {"ok": True, "operation": api, "skipped": skipped}


def cancel_operation(conn: sqlite3.Connection, household_id: str, op_id: str) -> dict:
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (op_id, household_id),
    ).fetchone()
    if row is None:
        raise InventoriaError("opération introuvable", status=404, code="not_found")
    if row["status"] in _NON_CANCELLABLE:
        raise InventoriaError("annulation interdite pour cet état", status=409, code="conflict")
    if row["cross_store_op_id"]:
        xop = conn.execute(
            "SELECT status, planned_steps_json, uncertain_inventory FROM cross_store_ops WHERE id = ?",
            (row["cross_store_op_id"],),
        ).fetchone()
        if xop:
            steps = json.loads(xop["planned_steps_json"] or "[]")
            if any(st.get("attempt_phase") == "in_flight" for st in steps):
                raise InventoriaError(
                    "journal cross-store incertain — annulation refusée",
                    status=409,
                    code="conflict",
                )
            if int(xop["uncertain_inventory"]) == 1 or xop["status"] == "needs_reconcile":
                raise InventoriaError(
                    "réconciliation requise — annulation refusée",
                    status=409,
                    code="conflict",
                )
    now = _now()
    prev = row["status"]
    conn.execute(
        "UPDATE inventoria_operations SET status = ?, updated_at = ?, rev = rev + 1 WHERE id = ?",
        ("cancelled", now, op_id),
    )
    _audit(conn, household_id=household_id, operation_id=op_id, action="cancel",
           prev_status=prev, next_status="cancelled")
    return {"ok": True, "operation": _op_row_to_api(conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ?", (op_id,),
    ).fetchone())}


def get_operation(conn: sqlite3.Connection, household_id: str, op_id: str) -> dict:
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (op_id, household_id),
    ).fetchone()
    if row is None:
        raise InventoriaError("opération introuvable", status=404, code="not_found")
    audit = [
        dict(r) for r in conn.execute(
            "SELECT action, prev_status, next_status, actor, detail_json, created_at "
            "FROM inventoria_operation_audit WHERE operation_id = ? ORDER BY id",
            (op_id,),
        ).fetchall()
    ]
    return {"ok": True, "operation": _op_row_to_api(row), "audit": audit}


def reconcile_operation(conn: sqlite3.Connection, household_id: str, op_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, RECONCILE_KEYS)
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (op_id, household_id),
    ).fetchone()
    if row is None:
        raise InventoriaError("opération introuvable", status=404, code="not_found")
    if row["status"] not in ("needs_reconcile", "committing"):
        raise InventoriaError("reconcile non requis", status=409, code="conflict")
    decision = str(data.get("decision") or "")
    if decision not in ("inspect", "confirm_already_applied", "confirm_not_applied", "abort_compensate"):
        raise InventoriaError("decision invalide", code="validation_error")
    reason = str(data.get("reason") or "").strip()
    if decision != "inspect" and len(reason) < REASON_MIN_LEN:
        raise InventoriaError(
            f"reason requis (min {REASON_MIN_LEN} caractères)",
            code="validation_error",
        )
    sub_key = data.get("idempotency_key")
    evidence = data.get("evidence") if isinstance(data.get("evidence"), dict) else None
    step_index = data.get("step_index")
    if step_index is not None and (isinstance(step_index, bool) or type(step_index) is not int):
        raise InventoriaError("step_index invalide", code="validation_error")
    state_change = decision != "inspect"
    if state_change and not _claim_commit(op_id):
        return _commit_in_progress(op_id)
    try:
        return _reconcile_owned(
            conn, household_id, op_id, decision, reason, sub_key, evidence, step_index,
        )
    finally:
        if state_change:
            _release_commit(op_id)


def _reconcile_owned(
    conn: sqlite3.Connection,
    household_id: str,
    op_id: str,
    decision: str,
    reason: str,
    sub_key: Any,
    evidence: dict | None,
    step_index: int | None,
) -> dict:
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (op_id, household_id),
    ).fetchone()
    if row["status"] not in ("needs_reconcile", "committing"):
        raise InventoriaError("reconcile non requis", status=409, code="conflict")
    inventory.bind(root=_root(), asset_exists=_cb.get("asset_exists"))
    try:
        out = commit_mod.reconcile_cross_store(
            conn,
            household_id=household_id,
            operation_id=op_id,
            decision=decision,
            reason=reason,
            idempotency_key=str(sub_key) if sub_key else None,
            evidence=evidence,
            step_index=step_index,
            now=_now(),
        )
    except KeyError:
        raise InventoriaError("journal cross-store absent", status=404, code="not_found") from None
    except ValueError as exc:
        msg = str(exc)
        if "idempotency conflict" in msg:
            raise InventoriaError(msg, status=409, code="conflict") from exc
        raise InventoriaError(msg, code="validation_error") from exc
    next_status = conn.execute(
        "SELECT status FROM inventoria_operations WHERE id = ?", (op_id,),
    ).fetchone()["status"]
    if next_status == "committed" and out.get("ok") and decision in (
        "confirm_already_applied", "confirm_not_applied",
    ):
        _persist_original_commit(conn, household_id, op_id)
    _audit(conn, household_id=household_id, operation_id=op_id, action="reconcile",
           prev_status=row["status"], next_status=next_status, detail=out)
    return out


def _persist_original_commit(conn: sqlite3.Connection, household_id: str, op_id: str) -> None:
    """Cache the original commit key only after the operation is actually committed."""
    row = conn.execute(
        "SELECT commit_idempotency_key, request_hash, cross_store_op_id, commit_result_json "
        "FROM inventoria_operations WHERE id = ?",
        (op_id,),
    ).fetchone()
    if row is None:
        return
    key = row["commit_idempotency_key"]
    req_hash = row["request_hash"]
    if not isinstance(key, str) or not key or not isinstance(req_hash, str) or not req_hash:
        return
    existing = conn.execute(
        "SELECT operation_id, request_hash FROM inventoria_commit_idempotency "
        "WHERE household_id = ? AND idempotency_key = ?",
        (household_id, key),
    ).fetchone()
    if existing is not None:
        if existing["operation_id"] != op_id or existing["request_hash"] != req_hash:
            raise InventoriaError(
                "clé idempotency liée à une autre opération",
                status=409,
                code="conflict",
            )
        return
    body = json.loads(row["commit_result_json"] or "{}")
    if not isinstance(body, dict) or not body:
        body = {"ok": True, "cross_store_op_id": row["cross_store_op_id"]}
    _idem_store(conn, household_id, key, op_id, req_hash, {
        "ok": True,
        "operation_id": op_id,
        "commit": body,
    })


def redact_for_logs(payload: Any) -> dict:
    if not isinstance(payload, dict):
        return {"redacted": True}
    out: dict[str, Any] = {"ok": payload.get("ok")}
    if payload.get("code"):
        out["code"] = payload["code"]
    if payload.get("operation_id"):
        out["operation_id"] = payload["operation_id"]
    return out


def _err(exc: BaseException) -> tuple[int, dict]:
    if isinstance(exc, schemas.SchemaError):
        return 400, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    if isinstance(exc, hstore.HouseholdStoreError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    if isinstance(exc, finances.FinanceError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    if isinstance(exc, InventoriaError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code, **({"retryable": True} if exc.retryable else {})}
    if isinstance(exc, inventory.InventoryError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code, **exc.extra}
    return 500, {"ok": False, "error": "erreur interne", "code": "internal"}


def http_get(path: str, qs: dict | None = None) -> tuple[int, dict]:
    if path == "/api/inventoria/status":  # no database needed
        try:
            return 200, status()
        except InventoriaError as exc:
            return _err(exc)
    m_item = ITEM_RE.match(path)
    if m_item or path == "/api/inventoria/spending":     # file-backed: no database needed
        try:
            return 200, (item_sheet(m_item.group(1)) if m_item else spending_get(qs))
        except (InventoriaError, inventory.InventoryError) as exc:
            return _err(exc)
    try:
        st = _open_store(readonly=True)
        try:
            conn = st.conn
            household_id = finances.ensure_default_household(conn, create=False)
            if path == "/api/inventoria/history":
                lim = ((qs or {}).get("limit") or ["40"])[0]
                return 200, history(conn, household_id, int(lim) if str(lim).isdigit() else 40)
            if path == "/api/inventoria/recipes":
                return 200, recipes_get(conn, household_id)
            m_sess = SESSION_RE.match(path)
            if m_sess:
                sid = m_sess.group(1)
                if sid:
                    return 200, get_session(conn, household_id, sid)
                raise InventoriaError("session id requis", status=404, code="not_found")
            m_op = OPS_RE.match(path)
            if m_op and not m_op.group(2):
                return 200, get_operation(conn, household_id, m_op.group(1))
            raise InventoriaError("Route inconnue", status=404, code="not_found")
        finally:
            st.close()
    except (InventoriaError, schemas.SchemaError, hstore.HouseholdStoreError, finances.FinanceError, inventory.InventoryError) as exc:
        return _err(exc)
    except sqlite3.Error:
        return 503, {"ok": False, "error": "stockage indisponible", "code": "storage_error"}


MAX_SPEAK_CHARS = 600
REPLY_TEXT_MAX = 1_500
_ctx = threading.local()


_PHOTO_RE = re.compile(r"^data:(image/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$", re.I)
PHOTO_B64_MAX = 2_700_000    # about 2 MB of image data: room for a high-resolution receipt


def parse_photo(raw: Any) -> dict | None:
    """data URL -> Gemini inlineData, or None when it is not a png / jpeg / webp image within the size limit."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    m = _PHOTO_RE.match(raw.strip())
    if not m:
        return None
    mime = "image/jpeg" if m.group(1).lower() == "image/jpg" else m.group(1).lower()
    b64 = re.sub(r"\s+", "", m.group(2))
    if not b64 or len(b64) > PHOTO_B64_MAX:
        return None
    return {"mimeType": mime, "data": b64}


def _friendly_model_error(exc: BaseException) -> tuple[str, bool]:
    """(message for the Master, retryable). Never echoes the provider's raw text."""
    import hq_inventoria_ai as ai
    transient = ai.is_transient(exc)
    en = ai.language() == "en"
    if transient:
        return ("The AI model is very busy right now. Please try again in a moment." if en
                else "Le modèle d'IA est très sollicité en ce moment. Réessaie dans un instant."), True
    return ("The AI model could not handle this request." if en else "Le modèle d'IA n'a pas pu traiter cette demande."), False


def current_image() -> dict | None:
    """The photo (Gemini inlineData) attached to the message being answered, if any."""
    return getattr(_ctx, "image", None)


def current_intent() -> str | None:
    """What the Master said the photo is: 'stock', 'grocery' or None (let her decide)."""
    return getattr(_ctx, "intent", None)


def current_db() -> tuple | None:
    """(connection, household_id) while a model turn runs inside post_session_message; used by read-only module tools."""
    conn = getattr(_ctx, "conn", None)
    return (conn, _ctx.household_id) if conn is not None else None


def current_job() -> str:
    return str(getattr(_ctx, "job", "") or "")


def current_history() -> list[dict]:
    """Earlier messages of the session whose message is being answered (empty outside an adapter call)."""
    return list(getattr(_ctx, "history", None) or [])


def speak(data: dict) -> tuple[int, dict]:
    """Speak a short line in Inventoria's saved voice. The caller supplies the text; nothing here
    reads or changes inventory state. Phonon failures return ok=false so the client stays silent
    or uses browser speech; XTTS (Else) is never substituted."""
    import re
    import hq_voice
    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        raise InventoriaError("Texte vocal requis", code="validation_error")
    text = re.sub(r"<[^>]+>|[`*_#]", "", text)[:MAX_SPEAK_CHARS]
    res = hq_voice.synthesize(text, language=hq_language.pick(data.get("language")),
                              style="neutral", timeout_sec=30, character="inventoria")
    url = res.get("audio_url") if res and res.get("ok") else None
    if not isinstance(url, str) or not re.fullmatch(
            r"/assets/companion/chat/voice_cache/voice_ph[0-9a-f]{16}\.wav", url):
        return 503, {"ok": False, "error": (res or {}).get("error") or "Voix indisponible",
                     "code": "voice_unavailable"}
    return 200, {"ok": True, "audio_url": url, "visemes": res.get("visemes") or [], "engine": res.get("engine")}


def append_or_create_grocery(conn: sqlite3.Connection, household_id: str, lines: list[dict]) -> tuple[dict, bool]:
    """Add lines to the newest OPEN grocery list that is not tied to a meal plan (those are never edited), else create one.
    A name+unit already on the list keeps the larger quantity, so sending twice never doubles anything."""
    import hq_grocery
    row = conn.execute(
        "SELECT * FROM grocery_lists WHERE household_id = ? AND status = 'open' AND meal_plan_id IS NULL "
        "ORDER BY created_at DESC LIMIT 1", (household_id,)).fetchone()
    if row is None:
        return hq_grocery.create_grocery_list(conn, household_id, {"lines": lines}), False
    merged = [dict(x) for x in json.loads(row["lines_json"] or "[]")]
    index = {(str(m.get("name", "")).casefold(), m.get("unit")): m for m in merged}
    for ln in lines:
        key = (ln["name"].casefold(), ln["unit"])
        if key in index:
            index[key]["qty_milli"] = max(int(index[key]["qty_milli"]), int(ln["qty_milli"]))
        else:
            merged.append(dict(ln))
            index[key] = merged[-1]
    if len(merged) > 500:
        raise InventoriaError("liste de courses pleine (500 lignes)", status=409, code="conflict")
    return hq_grocery.update_grocery_list(conn, household_id, {"id": row["id"], "rev": int(row["rev"]), "lines": merged}), True


def status() -> dict:
    """Chip status: deterministic greeting, her saved notes, voice and model readiness. No model call."""
    import hq_inventoria_ai as ai
    import hq_inventoria_memory as mem
    voice: dict = {}
    try:
        import hq_voice_phonon
        prof = hq_voice_phonon.load_profiles().get("inventoria") or {}
        voice = {"engine": prof.get("engine"), "voice": prof.get("voice"), "selected": bool(prof.get("selected"))}
    except Exception:
        pass
    import hq_inventory
    import hq_inventoria_watch as watch
    _sync_filament()                                      # finished prints subtract their filament (opt-in links)
    inv = hq_inventory.snapshot()
    try:
        import hq_inventoria_history
        hq_inventoria_history.observe(_root(), inv)      # usage history for the run-out estimates
    except Exception:
        pass
    import hq_inventoria_notify as notify
    out = {"ok": True, "greeting": ai.greeting(inv), "alerts": ai.alerts(inv)[:12], "notify": notify.get_settings(_root()),
            "shopping": {"all": ai.shopping_list(inv, include_soon=True), "urgent": ai.shopping_list(inv, include_soon=False)},
            "watches": watch.list_watches(_root(), inv.get("items", [])), "memory": mem.list_notes(_root()),
            "voice": voice, "max_notes": mem.MAX_NOTES, "language": ai.language(),
            "prefs": _prefs(), "aliases": _alias_rows(), **_link_status(inv)}
    out.update(_feel_status(inv, out))
    return out


def _feel_status(inv: dict, st: dict) -> dict:
    """The calm line, the quiet streak, the voice lines and the ask budget. Data only, never fatal."""
    try:
        import hq_inventoria_feel as feel
        import hq_inventoria_links as links
        root_, lang = _root(), st.get("language")
        feel.observe(root_, st.get("alerts") or [])
        return {"calm": feel.calm(inv, st.get("alerts") or [], st.get("use_soon") or [], links.last_count_days(root_), lang),
                "streak": feel.streak_line(root_, lang), "tone": feel.voice(lang), "asks": feel.asks_get(root_)}
    except Exception:
        return {"calm": {"calm": False, "line": None}, "streak": None, "tone": {}, "asks": None}


def _link_status(inv: dict) -> dict:
    """Use-soon dates, this week's spot-check, record accuracy, filament links: data only, never fatal."""
    try:
        import hq_inventoria_links as links
        import hq_inventoria_habits as habits_mod
        root_ = _root()
        conn_hh = None
        st = None
        try:
            st = _open_store(readonly=True)
            conn_hh = (st.conn, finances.ensure_default_household(st.conn, create=False))
        except Exception:
            conn_hh = None
        try:
            soon = links.use_soon(root_, inv, conn=conn_hh[0] if conn_hh else None, household_id=conn_hh[1] if conn_hh else None)
        finally:
            if st is not None:
                st.close()
        names = {i["id"]: i.get("name") for i in inv.get("items") or []}
        import hq_inventoria_feel as feel_mod
        spot = None if feel_mod.spot_hidden(root_) else links.spot_check(root_, inv)       # snoozed asks stay out of the panel too
        return {"use_soon": soon[:12], "spot_check": spot, "accuracy": links.accuracy(root_),
                "filament": [{"material": m, "item_id": i, "item_name": names.get(i)} for m, i in sorted(links.filament_links(root_).items())],
                "barcodes": [{**b, "item_name": names.get(b["item_id"])} for b in habits_mod.all_barcodes(root_) if b["item_id"] in names],
                "events": links.recent_events(root_)}
    except Exception:
        return {"use_soon": [], "spot_check": None, "accuracy": None, "filament": [], "events": [], "barcodes": []}


def notify_post(data: dict) -> tuple[int, dict]:
    import hq_inventoria_notify as notify
    try:
        cfg = notify.save_settings(_root(), enabled=data.get("enabled"), instant=data.get("instant"), digest_hour=data.get("digest_hour"))
    except ValueError as exc:
        raise InventoriaError(str(exc), code="validation_error") from exc
    sent = False
    if data.get("test") is True:
        fn = _cb.get("notify")
        if callable(fn):
            try:
                import hq_inventoria_ai as _ai
                fn("Inventoria", "Test: offline alerts work." if _ai.language() == "en" else "Test : les alertes hors ligne fonctionnent.")
                sent = True
            except Exception:
                sent = False
    return 200, {"ok": True, "notify": cfg, "test_sent": sent}


def watch_post(data: dict) -> tuple[int, dict]:
    import hq_inventory
    import hq_inventoria_watch as watch
    action = data.get("action")
    if action == "remove":
        ok = watch.remove_watch(_root(), data.get("item_id"))
        if not ok:
            return 404, {"ok": False, "error": "surveillance introuvable", "code": "not_found"}
    elif action == "set":
        it = next((i for i in hq_inventory.snapshot()["items"] if i["id"] == data.get("item_id")), None)
        if it is None:
            raise InventoriaError("article introuvable", status=404, code="not_found")
        try:
            watch.set_watch(_root(), it["id"], data.get("warn_at"), name=str(it.get("name") or ""))
        except watch.WatchError as exc:
            raise InventoriaError(str(exc), code="validation_error") from exc
    else:
        raise InventoriaError("action inconnue (set|remove)", code="validation_error")
    return 200, {"ok": True, "watches": watch.list_watches(_root(), hq_inventory.snapshot()["items"])}


def memory_post(data: dict) -> tuple[int, dict]:
    import hq_inventoria_memory as mem
    action = data.get("action")
    if action == "forget":
        try:
            ok = mem.forget(_root(), data.get("id"))
        except mem.MemoryError_ as exc:
            raise InventoriaError(str(exc), code="validation_error") from exc
        return (200, {"ok": True, "memory": mem.list_notes(_root())}) if ok else (404, {"ok": False, "error": "note introuvable", "code": "not_found"})
    if action == "add":
        try:
            out = mem.add(_root(), data.get("text"), corrects_id=data.get("corrects_id"),
                          expect=data.get("expect"))
        except mem.MemoryError_ as exc:
            raise InventoriaError(str(exc), code="validation_error") from exc
        if out.get("needs_target"):
            # Nothing was saved; the panel must choose the note to correct.
            return 409, {"ok": False, "code": "needs_target", "needs_target": True,
                         "candidates": out.get("candidates") or [], "pending": out.get("pending") or ""}
        return 200, {"ok": True, "memory": mem.list_notes(_root())}
    raise InventoriaError("action inconnue (add|forget)", code="validation_error")


def _remember_request(client_id: str | None, out: dict) -> dict:
    """Store a small summary of what a one-tap request did, keyed by the client's id (see hq_inventoria_dedupe)."""
    if client_id:
        try:
            import hq_inventoria_dedupe as dedupe
            dedupe.remember(_root(), client_id, {
                "applied": [{"operation_id": a.get("operation_id"), "changes": a.get("changes") or []} for a in out.get("applied") or []],
                "operation_ids": [o.get("id") for o in (out.get("operations") or ([out["operation"]] if out.get("operation") else []))]})
        except Exception:
            pass
    return out


def _commit_route(st: Any, conn: sqlite3.Connection, household_id: str, op_id: str, data: dict) -> tuple[int, dict]:
    """Commit one operation (claim + transaction), then journal it for undo and learn usual amounts from it."""
    if not _claim_commit(op_id):
        return 409, _commit_in_progress(op_id)
    try:
        with st.transaction():
            import hq_inventoria_undo as undo_mod
            prow = conn.execute("SELECT proposals_json FROM inventoria_operations WHERE id = ?", (op_id,)).fetchone()
            pre_inv = inventory.snapshot()
            out = commit_operation(conn, household_id, op_id, data)
            commit_mod._invoke_test_hook("F7")
            if not out.get("ok"):
                return int(out.get("http_status", 409)), out
            try:  # journal for "undo this batch"; a repeated (idempotent) commit must not overwrite it
                if prow is not None and undo_mod.get(_root(), op_id) is None:
                    props = json.loads(prow["proposals_json"] or "[]")
                    undo_mod.record(_root(), op_id, props, pre_inv, inventory.snapshot())
                    import hq_inventoria_habits as habits
                    habits.record_commit(_root(), props, pre_inv)
            except Exception:
                pass
            return 200, out
    finally:
        _release_commit(op_id)


def _auto_apply(st: Any, conn: sqlite3.Connection, household_id: str, op_id: str) -> dict | None:
    """validate -> confirmed preview -> commit for one trusted operation. None when any step refuses
    (the operation is then left for the Master to review in the chip, exactly like a normal draft)."""
    try:
        with st.transaction():
            v = validate_operation(conn, household_id, op_id, {})
        if not v["validation"]["ok"]:
            return None
        if not _claim_commit(op_id):
            return None
        try:
            with st.transaction():
                p = preview_operation(conn, household_id, op_id, {"confirm": True})
        finally:
            _release_commit(op_id)
        code, out = _commit_route(st, conn, household_id, op_id, {"idempotency_key": "auto-" + op_id})
        if code != 200 or not out.get("ok"):
            return None
        return {"operation_id": op_id, "changes": p["preview"].get("changes") or []}
    except (InventoriaError, schemas.SchemaError, hstore.HouseholdStoreError, inventory.InventoryError, sqlite3.Error):
        return None


def _finish_auto(st: Any, conn: sqlite3.Connection, household_id: str, out: dict, text: Any = None) -> dict:
    """Apply the operations a turn marked trusted; report them as ``applied`` (for the Undo toast) and drop
    them from the drafts and card bindings the chip would otherwise show."""
    todo = out.pop("_auto", None) or []
    applied = [a for a in (_auto_apply(st, conn, household_id, op_id) for op_id in todo) if a]
    if not applied:
        return out
    done = {a["operation_id"] for a in applied}
    ops = [o for o in (out.get("operations") or ([out["operation"]] if out.get("operation") else [])) if o.get("id") not in done]
    out.pop("operations", None)
    out.pop("operation", None)
    if ops:
        out["operation"] = ops[0]
        if len(ops) > 1:
            out["operations"] = ops
    if isinstance(out.get("cards"), dict):
        out["cards"] = {k: (v if v not in done else None) for k, v in out["cards"].items()}
    try:
        import hq_inventoria_feel as feel
        feel.mark_usual(_root(), applied, text)           # "Usual amount" only when no number was said and the amount is the usual one
    except Exception:
        pass
    out["applied"] = applied
    return out


def _quick_proposal(item_id: Any, delta: Any) -> dict:
    """One item.adjust built server-side (barcode scan, notification, one-tap buttons): no model call."""
    it = next((i for i in inventory.snapshot()["items"] if i["id"] == item_id), None) if isinstance(item_id, str) else None
    if it is None:
        raise InventoriaError("article introuvable", status=404, code="not_found")
    if isinstance(delta, bool) or not isinstance(delta, int) or delta == 0 or abs(delta) > inventory.QTY_MAX:
        raise InventoriaError("delta invalide", code="validation_error")
    return schemas.validate_inventoria_proposal({
        "op": "item.adjust", "refs": {"item_id": it["id"]}, "resolved": {"confidence": "high"},
        "payload": {"id": it["id"], "delta": delta}, "label_fr": f"Ajuster {it.get('name')} de {delta:+d}"})


def _session_arg(data: dict) -> str:
    sid = data.get("session_id")
    if not isinstance(sid, str) or not re.fullmatch(r"ivo-[0-9a-f]{16}", sid):
        raise InventoriaError("session_id requis", code="validation_error")
    return sid


def prefs_post(data: dict) -> tuple[int, dict]:
    import hq_inventoria_habits as habits
    try:
        cfg = habits.set_prefs(_root(), auto_apply=data.get("auto_apply"), auto_delta_max=data.get("auto_delta_max"))
    except habits.HabitError as exc:
        raise InventoriaError(str(exc), code="validation_error") from exc
    out: dict[str, Any] = {"ok": True, "prefs": cfg}
    asks = data.get("asks")
    if isinstance(asks, dict):                       # quiet hours, daily cap, snooze for the pushed asks and the weekly spot-check
        import hq_inventoria_feel as feel
        try:
            out["asks"] = feel.asks_set(_root(), max_per_day=asks.get("max_per_day"), quiet_start=asks.get("quiet_start"),
                                        quiet_end=asks.get("quiet_end"), snooze_days=asks.get("snooze_days"),
                                        spot_snooze_days=asks.get("spot_snooze_days"))
        except ValueError as exc:
            raise InventoriaError(str(exc), code="validation_error") from exc
    return 200, out


def alias_post(data: dict) -> tuple[int, dict]:
    import hq_inventoria_habits as habits
    action = data.get("action")
    try:
        if action == "set":
            it = next((i for i in inventory.snapshot()["items"] if i["id"] == data.get("item_id")), None)
            if it is None:
                raise InventoriaError("article introuvable", status=404, code="not_found")
            habits.set_alias(_root(), data.get("alias"), it["id"], item_name=str(it.get("name") or ""))
        elif action == "remove":
            if not habits.remove_alias(_root(), data.get("alias")):
                return 404, {"ok": False, "error": "surnom introuvable", "code": "not_found"}
        else:
            raise InventoriaError("action inconnue (set|remove)", code="validation_error")
    except habits.HabitError as exc:
        raise InventoriaError(str(exc), code="validation_error") from exc
    return 200, {"ok": True, "aliases": _alias_rows()}


def _alias_rows() -> list[dict]:
    import hq_inventoria_habits as habits
    names = {i["id"]: i.get("name") for i in inventory.snapshot()["items"]}
    return sorted(({"alias": r.get("alias"), "item_id": r["item_id"], "item_name": names.get(r["item_id"])}
                   for r in habits.aliases(_root()).values() if r["item_id"] in names),
                  key=lambda r: str(r["alias"]).casefold())


def barcode_post(data: dict) -> tuple[int, dict]:
    """lookup | link | unlink a product barcode. Touches no stock: a scan's +/- goes through /quick."""
    import hq_inventoria_habits as habits
    action = data.get("action")
    try:
        code = habits.check_code(data.get("code"))
    except habits.HabitError as exc:
        raise InventoriaError(str(exc), code="validation_error") from exc
    inv = inventory.snapshot()
    by_id = {i["id"]: i for i in inv["items"]}
    if action == "lookup":
        iid = habits.barcode_item(_root(), code)
        it = by_id.get(iid) if iid else None
        if it is None:
            return 200, {"ok": True, "code": code, "item": None}
        return 200, {"ok": True, "code": code, "item": {"id": it["id"], "name": it.get("name"), "qty": it.get("qty"),
                                                         "unit": it.get("unit") or ""}, "usual": habits.usual(_root(), it["id"])}
    if action == "link":
        it = by_id.get(data.get("item_id")) if isinstance(data.get("item_id"), str) else None
        if it is None:
            raise InventoriaError("article introuvable", status=404, code="not_found")
        try:
            habits.link_barcode(_root(), code, it["id"])
        except habits.HabitError as exc:
            raise InventoriaError(str(exc), code="validation_error") from exc
        return 200, {"ok": True, "code": code, "item": {"id": it["id"], "name": it.get("name"), "qty": it.get("qty"),
                                                         "unit": it.get("unit") or ""}, "usual": habits.usual(_root(), it["id"])}
    if action == "unlink":
        return 200, {"ok": True, "removed": habits.unlink_barcode(_root(), code)}
    raise InventoriaError("action inconnue (lookup|link|unlink)", code="validation_error")


ITEM_RE = re.compile(r"^/api/inventoria/item/(itm-[0-9a-f]{8,32})\Z")


def item_sheet(item_id: str) -> dict:
    """Everything the item sheet shows: basics, minimum, expiry, barcodes, nicknames, usual amounts, prices, alert, filament link."""
    import hq_inventoria_habits as habits
    import hq_inventoria_links as links
    import hq_inventoria_watch as watch
    inv = inventory.snapshot()
    it = next((i for i in inv["items"] if i["id"] == item_id), None)
    if it is None:
        raise InventoriaError("article introuvable", status=404, code="not_found")
    base = _root()
    expiry = links.get_expiry(base, item_id)
    photo = next((x for x in it.get("photos") or [] if isinstance(x, str)), None)
    place = next((pl for pl in inv.get("places") or [] if pl.get("id") == it.get("place")), None)
    return {"ok": True, "item": {
        "id": it["id"], "name": it.get("name"), "qty": it.get("qty"), "unit": it.get("unit") or "", "min": it.get("min"),
        "rev": it.get("rev"), "place_id": it.get("place"), "where": links.place_path(inv, it.get("place")) or None,
        "photo": photo or (place.get("photos") or [None])[0] if place else photo, "note": it.get("note") or ""},
        "expiry": expiry, "expiry_days": links.days_left(expiry) if expiry else None,
        "barcodes": habits.barcodes_for(base, item_id), "aliases": habits.aliases_for(base, item_id),
        "usual": habits.usual(base, item_id), "price": links.price_info(base, item_id),
        "warn_at": watch.thresholds(base).get(item_id), "filament": links.filament_material(base, item_id),
        "unit_dim": (links.unit_dim(it.get("unit")) or (None,))[0], "checked_days": links.item_checked_days(base, item_id)}


def min_post(data: dict) -> tuple[int, dict]:
    """Low-stock threshold for one item (None clears it). Not a stock change: no draft, no undo journal."""
    it = next((i for i in inventory.snapshot()["items"] if i["id"] == data.get("item_id")), None)
    if it is None:
        raise InventoriaError("article introuvable", status=404, code="not_found")
    value = data.get("min")
    if value in ("", None):
        value = None
    elif isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= inventory.QTY_MAX:
        raise InventoriaError(f"seuil : entier de 0 à {inventory.QTY_MAX}", code="validation_error")
    inventory.apply({"action": "item.update", "id": it["id"], "rev": it["rev"], "min": value})
    return 200, item_sheet(it["id"])


def history(conn: sqlite3.Connection, household_id: str, limit: int = 40) -> dict:
    """Committed batches, newest first: what changed, whether the chip applied it on its own, and whether it can still be undone."""
    import hq_inventoria_undo as undo_mod
    limit = max(1, min(int(limit), 100))
    out = []
    for r in conn.execute(
            "SELECT id, proposals_json, commit_idempotency_key, updated_at FROM inventoria_operations "
            "WHERE household_id = ? AND status = 'committed' ORDER BY updated_at DESC, rowid DESC LIMIT ?", (household_id, limit)).fetchall():
        try:
            props = json.loads(r["proposals_json"] or "[]")
        except ValueError:
            props = []
        labels = [str(p.get("label_fr") or p.get("op") or "") for p in props if isinstance(p, dict)]
        entry = undo_mod.get(_root(), r["id"])
        is_undo = bool(labels) and labels[0].startswith("Annuler")
        out.append({"id": r["id"], "at": r["updated_at"], "labels": labels[:6], "count": len(labels),
                    "auto": str(r["commit_idempotency_key"] or "").startswith("auto-"), "is_undo": is_undo,
                    "undone": bool(entry and entry.get("undone_by")),
                    "undoable": bool(entry) and not entry.get("undone_by") and not is_undo})
    return {"ok": True, "items": out}


def spending_get(qs: dict | None) -> dict:
    import hq_inventoria_links as links
    month = ((qs or {}).get("month") or [""])[0] or None
    return {"ok": True, **_links_call(lambda: links.spending(_root(), inventory.snapshot(), month)), "months": links.price_months(_root())}


def recipes_get(conn: sqlite3.Connection, household_id: str) -> dict:
    import hq_inventoria_links as links
    rows = [{"id": r["id"], "title": r.get("title"), "servings": r.get("servings"), "ingredients": len(r.get("ingredients") or [])}
            for r in links._recipes(conn, household_id)]
    return {"ok": True, "items": sorted(rows, key=lambda r: str(r["title"]).casefold())[:200]}


def cook_check_post(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    import hq_inventoria_links as links
    import hq_meals
    rid = data.get("recipe_id")
    if not isinstance(rid, str):
        raise InventoriaError("recipe_id requis", code="validation_error")
    try:
        recipe = hq_meals.get_recipe(conn, household_id, rid)
    except Exception as exc:
        raise InventoriaError("recette introuvable", status=404, code="not_found") from exc
    return {"ok": True, **links.cook_check_recipe(inventory.snapshot(), recipe, data.get("servings"), _root())}


def _links_call(fn: Callable[[], Any]) -> Any:
    import hq_inventoria_links as links
    try:
        return fn()
    except links.LinkError as exc:
        raise InventoriaError(str(exc), code="validation_error") from exc


def where_post(data: dict) -> tuple[int, dict]:
    """'Where is X?' without a model call: shelf path, quantity and a photo id (item photo, else the place's)."""
    import hq_inventoria_links as links
    return 200, {"ok": True, **_links_call(lambda: links.where_is(inventory.snapshot(), data.get("q"), _root()))}


def parts_post(data: dict) -> tuple[int, dict]:
    import hq_inventoria_links as links
    return 200, {"ok": True, **_links_call(lambda: links.check_parts(inventory.snapshot(), data.get("parts"), _root()))}


def expiry_post(data: dict) -> tuple[int, dict]:
    import hq_inventoria_links as links
    it = next((i for i in inventory.snapshot()["items"] if i["id"] == data.get("item_id")), None)
    if it is None:
        raise InventoriaError("article introuvable", status=404, code="not_found")
    return 200, {"ok": True, **_links_call(lambda: links.set_expiry(_root(), it["id"], data.get("date")))}


def filament_post(data: dict) -> tuple[int, dict]:
    import hq_inventoria_links as links
    item_id = data.get("item_id") or None
    if item_id is not None:
        it = next((i for i in inventory.snapshot()["items"] if i["id"] == item_id), None)
        if it is None:
            raise InventoriaError("article introuvable", status=404, code="not_found")
        dim = links.unit_dim(it.get("unit"))
        if dim is None or dim[0] != "g":
            raise InventoriaError("le filament doit être compté en g ou en kg", code="validation_error")
    return 200, {"ok": True, "filament": _links_call(lambda: links.link_filament(_root(), data.get("material"), item_id))}


def _sync_filament() -> list[dict]:
    """Subtract finished prints from linked filament items (opt-in per material); never raises."""
    try:
        import hq_inventoria_links as links
        return links.sync_filament(_root(), inventory.snapshot(), inventory.apply)
    except Exception:
        return []


def http_post(path: str, data: Any) -> tuple[int, dict]:
    try:
        if not isinstance(data, dict):
            raise InventoriaError("JSON objet requis", code="validation_error")
        if len(json.dumps(data, ensure_ascii=False)) > (BODY_MAX if "image" in data else BODY_MAX_TEXT):
            raise InventoriaError("corps trop volumineux", status=413, code="validation_error")

        if path == "/api/inventoria/voice":  # speech only; touches no household data
            return speak(data)
        if path == "/api/inventoria/memory":  # her own notes; touches no household data
            return memory_post(data)
        if path == "/api/inventoria/watch":  # alert thresholds only; never changes stock
            return watch_post(data)
        if path == "/api/inventoria/notify":  # offline-alert settings; touches no household data
            return notify_post(data)
        if path == "/api/inventoria/cancel":  # stop a chat turn from the chip's Cancel button; no store needed
            import hq_inventoria_ai as ai_cancel
            return 200, {"ok": True, **ai_cancel.request_cancel(data.get("job"))}
        if path == "/api/inventoria/prefs":  # auto-apply switch and size cap; touches no household data
            return prefs_post(data)
        if path == "/api/inventoria/alias":  # nicknames for items; never changes stock
            return alias_post(data)
        if path == "/api/inventoria/barcode":  # barcode <-> item links; never changes stock
            return barcode_post(data)
        if path == "/api/inventoria/where":  # where is X: read-only, no model call
            return where_post(data)
        if path == "/api/inventoria/parts":  # can I build / cook it: read-only parts check
            return parts_post(data)
        if path == "/api/inventoria/expiry":  # use-soon date for one item; never changes stock
            return expiry_post(data)
        if path == "/api/inventoria/filament":  # material -> filament item link for finished 3D prints (opt-in)
            return filament_post(data)
        if path == "/api/inventoria/min":  # low-stock threshold of one item; not a stock change
            return min_post(data)

        st = _open_store(readonly=False)
        try:
            conn = st.conn
            household_id = finances.ensure_default_household(conn, create=True)
            if conn.in_transaction:
                # First run inserted the household row: commit it now, so a chat turn does not
                # hold the write lock (and block every household writer) while the model thinks.
                conn.commit()
            inventory.bind(root=_root(), asset_exists=_cb.get("asset_exists"))

            if path == "/api/inventoria/sessions":
                with st.transaction():
                    return 200, create_session(conn, household_id, data)

            m_sess = SESSION_RE.match(path)
            if m_sess and m_sess.group(1) and path.endswith("/message"):
                with st.transaction():
                    out = post_session_message(conn, household_id, m_sess.group(1), data)
                return 200, _finish_auto(st, conn, household_id, out, data.get("text"))

            if path == "/api/inventoria/cook-check":  # can I cook this recipe from the stock: read-only
                return 200, cook_check_post(conn, household_id, data)

            import hq_inventoria_dedupe as dedupe
            client_id = dedupe.check_id(data.get("client_id")) if path in ("/api/inventoria/quick", "/api/inventoria/purchased",
                                                                            "/api/inventoria/cooked") else None
            if client_id:                       # a retry of a request the server already applied: answer, never apply twice
                prior = dedupe.seen(_root(), client_id)
                if prior is not None:
                    return 200, {"ok": True, "duplicate": True, **prior}

            if path == "/api/inventoria/purchased":  # ticked-off shopping items -> applied at once when trusted, else a draft
                import hq_inventoria_ai as ai
                sid = _session_arg(data)
                try:
                    props = ai.purchased_proposals(data.get("items"), inventory.snapshot())
                except (ValueError, schemas.SchemaError) as exc:
                    raise InventoriaError(str(exc)[:200], code="validation_error") from exc
                with st.transaction():
                    out = post_session_message(conn, household_id, sid, {"proposals": props}, auto=True)
                return 200, _remember_request(client_id, _finish_auto(st, conn, household_id, out))

            if path == "/api/inventoria/detections":  # reviewed photo rows -> trusted adjusts applied, the rest a draft
                import hq_inventoria_ai as ai
                sid = _session_arg(data)
                snap = inventory.snapshot()
                try:
                    props = ai.detection_proposals(data.get("rows"), data.get("mode"), snap)
                except (ValueError, schemas.SchemaError) as exc:
                    raise InventoriaError(str(exc)[:200], code="validation_error") from exc
                if data.get("mode") == "count":   # a shelf count is a spot-check: log how far the records were off
                    try:
                        import hq_inventoria_links as links
                        links.record_count(_root(), snap, data.get("rows"))
                    except Exception:
                        pass
                with st.transaction():
                    out = post_session_message(conn, household_id, sid, {"proposals": props}, split=True, auto=True)
                return 200, _finish_auto(st, conn, household_id, out)

            if path == "/api/inventoria/cooked":  # a meal was cooked: its ingredients leave the stock (trusted adjusts + Undo)
                import hq_inventoria_links as links
                sid = _session_arg(data)
                recipe = None
                if isinstance(data.get("recipe_id"), str):
                    import hq_meals
                    try:
                        recipe = hq_meals.get_recipe(conn, household_id, data["recipe_id"])
                    except Exception:
                        recipe = None
                elif isinstance(data.get("recipe"), str):
                    recipe = links.find_recipe(conn, household_id, data["recipe"])
                if not recipe:
                    raise InventoriaError("recette introuvable", status=404, code="not_found")
                props, skipped = links.cooked_proposals(inventory.snapshot(), recipe, data.get("servings"), _root())
                if not props:
                    return 200, {"ok": True, "skipped": skipped, "applied": [], "note": "rien à retirer du stock"}
                props = [schemas.validate_inventoria_proposal(p) for p in props]
                with st.transaction():
                    out = post_session_message(conn, household_id, sid, {"proposals": props}, auto=True)
                out = _finish_auto(st, conn, household_id, out)
                out["skipped"] = skipped
                return 200, _remember_request(client_id, out)

            if path == "/api/inventoria/quick":  # one +/- on one item (barcode scan, one-tap button): no model call
                sid = _session_arg(data)
                prop = _quick_proposal(data.get("item_id"), data.get("delta"))
                with st.transaction():
                    out = post_session_message(conn, household_id, sid, {"proposals": [prop]}, auto=True)
                return 200, _remember_request(client_id, _finish_auto(st, conn, household_id, out))

            if path == "/api/inventoria/to-grocery":  # shopping list or confirmed photo lines -> the open grocery list
                import hq_grocery
                import hq_inventoria_ai as ai
                if isinstance(data.get("lines"), list):
                    items = []
                    for ln in data["lines"][:40]:
                        if not isinstance(ln, dict) or not isinstance(ln.get("name"), str) or not ln["name"].strip():
                            raise InventoriaError("ligne invalide", code="validation_error")
                        qty = ln.get("qty", 1)
                        if isinstance(qty, bool) or not isinstance(qty, int) or not 1 <= qty <= 100000:
                            raise InventoriaError("quantité invalide", code="validation_error")
                        items.append({"name": ln["name"].strip()[:160], "buy": qty, "unit": str(ln.get("unit") or "")[:20],
                                      "store": str(ln.get("store") or "")[:60]})
                else:
                    shop = ai.shopping_list(inventory.snapshot(), include_soon=data.get("include_soon") is not False)
                    items = shop["items"]
                if not items:
                    raise InventoriaError("rien à envoyer", status=409, code="conflict")
                merchants = {m["name"].casefold(): m["id"] for m in hq_grocery.list_merchants(conn, household_id, {}).get("items", [])}
                lines = ai.grocery_lines(items, merchants)
                with st.transaction():
                    created, appended = append_or_create_grocery(conn, household_id, lines)
                return 200, {"ok": True, "list": created, "count": len(lines), "appended": appended}

            m_op = OPS_RE.match(path)
            if not m_op:
                raise InventoriaError("Route inconnue", status=404, code="not_found")
            op_id = m_op.group(1)
            action = m_op.group(2)
            if action == "validate":
                with st.transaction():
                    return 200, validate_operation(conn, household_id, op_id, data)
            if action == "preview":
                if not _claim_commit(op_id):
                    return 409, _commit_in_progress(op_id)
                try:
                    with st.transaction():
                        return 200, preview_operation(conn, household_id, op_id, data)
                finally:
                    _release_commit(op_id)
            if action == "commit":
                return _commit_route(st, conn, household_id, op_id, data)
            if action == "undo":
                if set(data) - {"apply"}:
                    _reject_unknown_fields(data, frozenset({"apply"}))
                with st.transaction():
                    out = undo_operation(conn, household_id, op_id)
                # {"apply": true} = the toast's one-tap Undo: the inverse is applied at once, but only when it is
                # made of quantity adjusts alone; anything else stays a draft to review.
                op = out.get("operation") or {}
                if data.get("apply") is True and op.get("proposals") and all(
                        p.get("op") == "item.adjust" for p in op["proposals"]):
                    res = _auto_apply(st, conn, household_id, op["id"])
                    if res:
                        out["applied"] = [res]
                return 200, out
            if action == "cancel":
                if not _claim_commit(op_id):
                    return 409, _commit_in_progress(op_id)
                try:
                    with st.transaction():
                        return 200, cancel_operation(conn, household_id, op_id)
                finally:
                    _release_commit(op_id)
            if action == "reconcile":
                state_change = str(data.get("decision") or "") != "inspect"
                if state_change and not _claim_commit(op_id):
                    return 409, _commit_in_progress(op_id)
                try:
                    with st.transaction():
                        out = reconcile_operation(conn, household_id, op_id, data)
                        if not out.get("ok"):
                            return 409, out
                        inner = out.get("commit")
                        if isinstance(inner, dict) and not inner.get("ok"):
                            return 409, out
                        return 200, out
                finally:
                    if state_change:
                        _release_commit(op_id)
            raise InventoriaError("Route inconnue", status=404, code="not_found")
        finally:
            st.close()
    except (InventoriaError, schemas.SchemaError, hstore.HouseholdStoreError, finances.FinanceError, inventory.InventoryError) as exc:
        return _err(exc)
    except sqlite3.Error:
        return 503, {"ok": False, "error": "stockage indisponible", "code": "storage_error"}
    except Exception:
        return 500, {"ok": False, "error": "erreur interne", "code": "internal"}


set_test_hook = commit_mod.set_test_hook
