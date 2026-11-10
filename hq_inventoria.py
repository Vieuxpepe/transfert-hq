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


def _name_score(a: str, b: str) -> float:
    return SequenceMatcher(None, a.casefold(), b.casefold()).ratio()


def _resolve_proposal(proposal: dict, inv: dict) -> dict:
    """Fill resolved refs from inventory snapshot (deterministic)."""
    out = dict(proposal)
    refs = dict(proposal.get("refs") or {})
    resolved = dict(proposal.get("resolved") or {})
    op = proposal["op"]
    items = inv.get("items") or []
    places = inv.get("places") or []
    by_item = {i["id"]: i for i in items}
    by_place = {p["id"]: p for p in places}
    by_code = {p["code"].upper(): p["id"] for p in places if isinstance(p.get("code"), str)}

    def conf_for(score: float) -> str:
        if score >= 0.92:
            return "high"
        if score >= 0.75:
            return "medium"
        return "low"

    item_id = refs.get("item_id") or resolved.get("item_id")
    if isinstance(item_id, str) and item_id in by_item:
        resolved["item_id"] = item_id
        resolved["confidence"] = "high"
    elif refs.get("name_hint"):
        hint = str(refs["name_hint"]).strip()
        best, score = None, 0.0
        for it in items:
            s = _name_score(hint, it["name"])
            if s > score:
                score, best = s, it
        if best is not None and score >= 0.5:
            resolved["item_id"] = best["id"]
            resolved["confidence"] = conf_for(score)
        else:
            resolved.setdefault("confidence", "low")
    place_id = refs.get("place_id") or resolved.get("place_id")
    if isinstance(place_id, str) and place_id in by_place:
        resolved["place_id"] = place_id
        if "confidence" not in resolved:
            resolved["confidence"] = "high"
    elif refs.get("place_code"):
        code = str(refs["place_code"]).upper()
        pid = by_code.get(code)
        if pid:
            resolved["place_id"] = pid
            resolved["confidence"] = "high"

    payload = dict(proposal.get("payload") or {})
    if op.startswith("item.") and resolved.get("item_id") and "id" not in payload and op != "item.create":
        payload["id"] = resolved["item_id"]
    if op.startswith("place.") and resolved.get("place_id") and "id" not in payload and op != "place.create":
        payload["id"] = resolved["place_id"]

    out["refs"] = refs
    out["resolved"] = resolved
    out["payload"] = payload
    schemas.validate_inventoria_proposal(out)
    return out


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
        try:
            rp = _resolve_proposal(p, inv)
            if rp["resolved"].get("confidence") == "low":
                issues.append({"op": rp["op"], "code": "low_confidence"})
            resolved.append(rp)
        except schemas.SchemaError as exc:
            issues.append({"op": p.get("op"), "error": str(exc), "code": exc.code})

    if issues and not resolved:
        raise InventoriaError("validation échouée", status=400, code="validation_error")

    validation = {"ok": not issues, "issues": issues, "proposals": resolved}
    now = _now()
    prev = row["status"]
    conn.execute(
        "UPDATE inventoria_operations SET status = ?, proposals_json = ?, "
        "validation_json = ?, updated_at = ?, rev = rev + 1 WHERE id = ?",
        ("validated", _safe_json(resolved), _safe_json(validation), now, op_id),
    )
    _audit(conn, household_id=household_id, operation_id=op_id, action="validate",
           prev_status=prev, next_status="validated")
    api = _op_row_to_api(conn.execute("SELECT * FROM inventoria_operations WHERE id = ?", (op_id,)).fetchone())
    return {"ok": True, "operation": api, "validation": validation}


def _preview_diff(proposals: list[dict], inv: dict) -> dict:
    changes: list[dict] = []
    for p in proposals:
        op = p["op"]
        payload = p["payload"]
        entry: dict[str, Any] = {"op": op, "label_fr": p.get("label_fr", ""), "refs": p.get("resolved", {})}
        if op == "item.adjust":
            iid = payload.get("id")
            item = next((i for i in inv["items"] if i["id"] == iid), None)
            if item:
                entry["before"] = {"qty": item["qty"]}
                entry["after"] = {"qty": item["qty"] + int(payload["delta"])}
        elif op == "item.update":
            iid = payload["id"]
            item = next((i for i in inv["items"] if i["id"] == iid), None)
            if item:
                entry["before"] = {k: item.get(k) for k in payload if k not in ("id", "rev")}
                entry["after"] = {k: payload[k] for k in payload if k not in ("id", "rev")}
        elif op == "item.create":
            entry["after"] = {k: payload[k] for k in payload if k != "id"}
        changes.append(entry)
    digest = hashlib.sha256(_safe_json(changes).encode("utf-8")).hexdigest()
    return {"changes": changes, "preview_digest": digest, "inventory_rev": inv["rev"]}


def preview_operation(conn: sqlite3.Connection, household_id: str, op_id: str, data: dict) -> dict:
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (op_id, household_id),
    ).fetchone()
    if row is None:
        raise InventoriaError("opération introuvable", status=404, code="not_found")
    if row["status"] not in ("validated", "previewed"):
        raise InventoriaError("valider avant preview", status=409, code="conflict")
    proposals = json.loads(row["proposals_json"] or "[]")
    inv = inventory.snapshot()
    preview = _preview_diff(proposals, inv)
    item_expectations: list[dict] = []
    for p in proposals:
        if p["op"] in ("item.update", "item.delete"):
            iid = p["payload"]["id"]
            item = next((i for i in inv["items"] if i["id"] == iid), None)
            if item:
                item_expectations.append({"item_id": iid, "rev": item["rev"]})

    confirm = bool(data.get("confirm"))
    now = _now()
    prev = row["status"]
    conn.execute(
        "UPDATE inventoria_operations SET status = ?, preview_json = ?, preview_digest = ?, "
        "expected_inventory_rev = ?, item_rev_expectations_json = ?, preview_confirmed = ?, "
        "updated_at = ?, rev = rev + 1 WHERE id = ?",
        (
            "previewed", _safe_json(preview), preview["preview_digest"],
            int(preview["inventory_rev"]),
            _safe_json(item_expectations) if item_expectations else None,
            1 if confirm else 0, now, op_id,
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
) -> dict | None:
    row = conn.execute(
        "SELECT request_hash, response_json FROM inventoria_commit_idempotency "
        "WHERE household_id = ? AND idempotency_key = ?",
        (household_id, key),
    ).fetchone()
    if row is None:
        return None
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
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (op_id, household_id),
    ).fetchone()
    if row is None:
        raise InventoriaError("opération introuvable", status=404, code="not_found")
    try:
        schemas.require_idempotency_key(data.get("idempotency_key"))
    except schemas.SchemaError as exc:
        raise InventoriaError(str(exc), code=exc.code) from exc

    key = str(data["idempotency_key"])
    body_for_hash = {
        "idempotency_key": key,
        "expected_inventory_rev": data.get("expected_inventory_rev", row["expected_inventory_rev"]),
        "item_rev_expectations": data.get("item_rev_expectations")
        or json.loads(row["item_rev_expectations_json"] or "null"),
        "preview_digest": data.get("preview_digest", row["preview_digest"]),
    }
    req_hash = _body_hash(body_for_hash)
    cached = _idem_lookup(conn, household_id, key, req_hash)
    if cached is not None:
        return cached

    if row["status"] != "previewed":
        raise InventoriaError("preview requis avant commit", status=409, code="conflict")

    digest = data.get("preview_digest") or row["preview_digest"]
    if digest != row["preview_digest"]:
        raise InventoriaError("preview_digest mismatch", status=409, code="conflict")

    exp_rev = data.get("expected_inventory_rev", row["expected_inventory_rev"])
    if exp_rev is None:
        raise InventoriaError("expected_inventory_rev requis", code="validation_error")
    inv = inventory.snapshot()
    if int(exp_rev) != inv["rev"]:
        raise InventoriaError("révision inventaire obsolète", status=409, code="conflict")

    item_exp = data.get("item_rev_expectations")
    if item_exp is None and row["item_rev_expectations_json"]:
        item_exp = json.loads(row["item_rev_expectations_json"])
    proposals = json.loads(row["proposals_json"] or "[]")

    inventory.bind(root=_root(), asset_exists=_cb.get("asset_exists"))
    result = commit_mod.run_inventoria_commit(
        conn,
        household_id=household_id,
        operation_id=op_id,
        proposals=proposals,
        idempotency_key=key,
        request_hash=req_hash,
        expected_inventory_rev=int(exp_rev),
        item_rev_expectations=item_exp,
        preview_digest=str(digest),
        now=_now(),
    )
    if result.get("ok"):
        out = {"ok": True, "commit": result, "operation_id": op_id}
        _idem_store(conn, household_id, key, op_id, req_hash, out)
        _audit(conn, household_id=household_id, operation_id=op_id, action="commit",
               prev_status="previewed", next_status="committed")
        return out
    if result.get("code") == "needs_reconcile":
        _audit(conn, household_id=household_id, operation_id=op_id, action="commit",
               prev_status="previewed", next_status="needs_reconcile", detail=result)
        return {
            "ok": False,
            "code": "needs_reconcile",
            "operation_id": op_id,
            "cross_store_op_id": result.get("cross_store_op_id"),
        }
    raise InventoriaError(result.get("error", "échec commit"), status=409, code=result.get("code", "conflict"))


def cancel_operation(conn: sqlite3.Connection, household_id: str, op_id: str) -> dict:
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (op_id, household_id),
    ).fetchone()
    if row is None:
        raise InventoriaError("opération introuvable", status=404, code="not_found")
    if row["status"] in ("committed", "committing"):
        raise InventoriaError("commit déjà lancé", status=409, code="conflict")
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
    reason = str(data.get("reason") or "")
    sub_key = data.get("idempotency_key")
    try:
        out = commit_mod.reconcile_cross_store(
            conn,
            household_id=household_id,
            operation_id=op_id,
            decision=decision,
            reason=reason,
            idempotency_key=str(sub_key) if sub_key else None,
            now=_now(),
        )
    except KeyError:
        raise InventoriaError("journal cross-store absent", status=404, code="not_found") from None
    except ValueError as exc:
        raise InventoriaError(str(exc), code="validation_error") from exc
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
    except (InventoriaError, schemas.SchemaError, hstore.HouseholdStoreError, finances.FinanceError) as exc:
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
    except (InventoriaError, schemas.SchemaError, hstore.HouseholdStoreError, finances.FinanceError) as exc:
        return _err(exc)
    except sqlite3.Error:
        return 503, {"ok": False, "error": "stockage indisponible", "code": "storage_error"}


set_test_hook = commit_mod.set_test_hook
