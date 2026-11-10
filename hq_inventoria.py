# -*- coding: utf-8 -*-
"""Transfert HQ — Inventoria Engine (propose → validate → preview → commit → audit)."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import sqlite3
import threading
import time
from difflib import SequenceMatcher
from typing import Any, Callable

import hq_finances as finances
import hq_household_schemas as schemas
import hq_household_store as hstore
import hq_inventoria_commit as commit_mod
import hq_inventory as inventory

BODY_MAX = 1_048_576
MESSAGES_MAX = 100
PROPOSALS_MAX = 20
SESSION_RE = re.compile(r"^/api/inventoria/sessions(?:/(ivo-[0-9a-f]{16}))?(?:/message)?\Z")
OPS_RE = re.compile(r"^/api/inventoria/ops/(iop-[0-9a-f]{16})(?:/(validate|preview|commit|cancel|reconcile))?\Z")

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


class InventoriaError(Exception):
    def __init__(self, msg: str, *, status: int = 400, code: str = "validation_error"):
        super().__init__(msg)
        self.status = status
        self.code = code


def bind(**kwargs: Any) -> None:
    with _guard:
        for key in ("root", "actor", "now", "llm_adapter", "asset_exists"):
            if key in kwargs:
                _cb[key] = kwargs[key]


def reset_for_tests() -> None:
    with _guard:
        _cb.clear()
    commit_mod.set_test_hook(None)


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
    if isinstance(explicit_iid, str):
        if explicit_iid not in by_item:
            local_issues.append({"op": op, "code": "not_found", "item_id": explicit_iid})
        else:
            resolved["item_id"] = explicit_iid
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
    if op.startswith("item.") and resolved.get("item_id") and "id" not in payload and op != "item.create":
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
    from hq_inventory import QTY_MAX

    qty: dict[str, int] = {i["id"]: int(i["qty"]) for i in inv.get("items") or []}
    item_rev: dict[str, int] = {i["id"]: int(i["rev"]) for i in inv.get("items") or []}
    issues: list[dict] = []
    for step, p in enumerate(proposals):
        op = p["op"]
        payload = p.get("payload") or {}
        iid = payload.get("id")
        if op == "item.adjust":
            if not isinstance(iid, str) or iid not in qty:
                issues.append({"step": step, "code": "not_found", "op": op})
                continue
            delta = payload.get("delta")
            if not isinstance(delta, int) or isinstance(delta, bool) or delta == 0:
                issues.append({"step": step, "code": "invalid_delta", "op": op})
                continue
            new_q = qty[iid] + delta
            if new_q < 0 or new_q > QTY_MAX:
                issues.append({"step": step, "code": "batch_bounds", "op": op, "would_be": new_q})
                continue
            qty[iid] = new_q
            item_rev[iid] += 1
        elif op == "item.update":
            if not isinstance(iid, str) or iid not in qty:
                issues.append({"step": step, "code": "not_found", "op": op})
                continue
            want_rev = payload.get("rev")
            if want_rev != item_rev.get(iid):
                issues.append({"step": step, "code": "stale_item_rev", "op": op})
                continue
            if "qty" in payload:
                q = payload["qty"]
                if isinstance(q, int) and not isinstance(q, bool):
                    if q < 0 or q > QTY_MAX:
                        issues.append({"step": step, "code": "batch_bounds", "op": op})
                        continue
                    qty[iid] = q
            item_rev[iid] += 1
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
    return {"ok": True, "session": _session_row_to_api(row)}


def post_session_message(
    conn: sqlite3.Connection,
    household_id: str,
    session_id: str,
    data: dict,
) -> dict:
    row = conn.execute(
        "SELECT * FROM inventoria_sessions WHERE id = ? AND household_id = ?",
        (session_id, household_id),
    ).fetchone()
    if row is None:
        raise InventoriaError("session introuvable", status=404, code="not_found")
    if row["status"] != "open":
        raise InventoriaError("session fermée", status=409, code="conflict")
    messages = json.loads(row["messages_json"] or "[]")
    now = _now()
    proposals: list[dict] = []

    if "proposals" in data:
        raw = data["proposals"]
        if not isinstance(raw, list) or len(raw) > PROPOSALS_MAX:
            raise InventoriaError(f"proposals invalides (max {PROPOSALS_MAX})", code="validation_error")
        for p in raw:
            proposals.append(schemas.validate_inventoria_proposal(p))
    elif "text" in data:
        text = str(data["text"]).strip()
        if not text:
            raise InventoriaError("text requis", code="validation_error")
        messages.append({"role": "user", "text": text, "at": now})
        adapter = _cb.get("llm_adapter")
        if callable(adapter):
            try:
                draft = adapter(text, session_id=session_id)
                if isinstance(draft, dict) and isinstance(draft.get("proposals"), list):
                    for p in draft["proposals"]:
                        proposals.append(schemas.validate_inventoria_proposal(p))
            except InventoriaError:
                raise
            except Exception as exc:
                raise InventoriaError(str(exc)[:200], code="validation_error") from exc
        else:
            messages.append({
                "role": "assistant",
                "text": "Propositions structurées requises (champ proposals).",
                "at": now,
            })
    else:
        raise InventoriaError("text ou proposals requis", code="validation_error")

    if len(messages) > MESSAGES_MAX:
        raise InventoriaError(f"messages max {MESSAGES_MAX}", code="validation_error")

    op_id = None
    operation = None
    if proposals:
        op_id = _new_id("op")
        conn.execute(
            "INSERT INTO inventoria_operations("
            "id, household_id, session_id, status, proposals_json, rev, created_at, updated_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (op_id, household_id, session_id, "draft", _safe_json(proposals), 1, now, now),
        )
        _audit(conn, household_id=household_id, operation_id=op_id, action="propose",
               prev_status=None, next_status="draft", detail={"count": len(proposals)})
        operation = _op_row_to_api(conn.execute(
            "SELECT * FROM inventoria_operations WHERE id = ?", (op_id,),
        ).fetchone())

    conn.execute(
        "UPDATE inventoria_sessions SET messages_json = ?, updated_at = ?, rev = rev + 1 WHERE id = ?",
        (_safe_json(messages), now, session_id),
    )
    out: dict[str, Any] = {"ok": True, "messages": messages}
    if operation:
        out["operation"] = operation
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
    proposals = json.loads(row["proposals_json"] or "[]")
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
            item = next((i for i in inv["items"] if i["id"] == iid), None)
            if item:
                entry["before"] = {"qty": item["qty"], "rev": item["rev"]}
                entry["after"] = {"qty": item["qty"] + int(payload["delta"]), "rev": item["rev"] + 1}
        elif op == "item.update":
            iid = payload["id"]
            item = next((i for i in inv["items"] if i["id"] == iid), None)
            if item:
                entry["before"] = {k: item.get(k) for k in payload if k not in ("id", "rev")}
                entry["after"] = {k: payload[k] for k in payload if k not in ("id", "rev")}
        elif op == "item.create":
            entry["after"] = {k: payload[k] for k in payload if k != "id"}
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
    if row["cross_store_op_id"]:
        finalize_only = commit_mod.journal_ready_to_finalize(conn, row["cross_store_op_id"])
    if resume:
        xop = conn.execute(
            "SELECT step_results_json FROM cross_store_ops WHERE id = ?",
            (row["cross_store_op_id"],),
        ).fetchone()
        if xop and xop["step_results_json"]:
            last = json.loads(xop["step_results_json"])[-1]
            if isinstance(last, dict) and isinstance(last.get("inventory_rev"), int):
                exp_rev = int(last["inventory_rev"])
    if not finalize_only:
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
        return {
            "ok": False,
            "code": "needs_reconcile",
            "operation_id": op_id,
            "cross_store_op_id": result.get("cross_store_op_id"),
        }
    raise InventoriaError(result.get("error", "échec commit"), status=409, code=result.get("code", "conflict"))


_NON_CANCELLABLE = frozenset({
    "committed", "committing", "needs_reconcile", "failed",
})


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
    if step_index is not None and not isinstance(step_index, int):
        raise InventoriaError("step_index invalide", code="validation_error")
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
    _audit(conn, household_id=household_id, operation_id=op_id, action="reconcile",
           prev_status="needs_reconcile", next_status=row["status"], detail=out)
    return out


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
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    if isinstance(exc, inventory.InventoryError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code, **exc.extra}
    return 500, {"ok": False, "error": "erreur interne", "code": "internal"}


def http_get(path: str, qs: dict | None = None) -> tuple[int, dict]:
    try:
        st = _open_store(readonly=True)
        try:
            conn = st.conn
            household_id = finances.ensure_default_household(conn, create=False)
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


def http_post(path: str, data: Any) -> tuple[int, dict]:
    try:
        if not isinstance(data, dict):
            raise InventoriaError("JSON objet requis", code="validation_error")
        if len(json.dumps(data, ensure_ascii=False)) > BODY_MAX:
            raise InventoriaError("corps trop volumineux", status=413, code="validation_error")

        st = _open_store(readonly=False)
        try:
            conn = st.conn
            household_id = finances.ensure_default_household(conn, create=True)
            inventory.bind(root=_root(), asset_exists=_cb.get("asset_exists"))

            if path == "/api/inventoria/sessions":
                with st.transaction():
                    return 200, create_session(conn, household_id, data)

            m_sess = SESSION_RE.match(path)
            if m_sess and m_sess.group(1) and path.endswith("/message"):
                with st.transaction():
                    return 200, post_session_message(conn, household_id, m_sess.group(1), data)

            m_op = OPS_RE.match(path)
            if not m_op:
                raise InventoriaError("Route inconnue", status=404, code="not_found")
            op_id = m_op.group(1)
            action = m_op.group(2)
            if action == "validate":
                with st.transaction():
                    return 200, validate_operation(conn, household_id, op_id, data)
            if action == "preview":
                with st.transaction():
                    return 200, preview_operation(conn, household_id, op_id, data)
            if action == "commit":
                with st.transaction():
                    out = commit_operation(conn, household_id, op_id, data)
                    if out.get("ok") is False and out.get("code") == "needs_reconcile":
                        return 409, out
                    return 200, out
            if action == "cancel":
                with st.transaction():
                    return 200, cancel_operation(conn, household_id, op_id)
            if action == "reconcile":
                with st.transaction():
                    return 200, reconcile_operation(conn, household_id, op_id, data)
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
