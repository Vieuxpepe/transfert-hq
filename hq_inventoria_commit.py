# -*- coding: utf-8 -*-
"""Inventoria cross-store commit (F0–F6) — inventoria_commit journal steps."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import time
from typing import Any, Callable

import hq_household_schemas as schemas
import hq_inventory as inventory

_test_hook: Callable[[str], None] | None = None


class CommitAbort(RuntimeError):
    def __init__(self, phase: str):
        super().__init__(f"test_hook:{phase}")
        self.phase = phase


def set_test_hook(fn: Callable[[str], None] | None) -> None:
    global _test_hook
    _test_hook = fn


def _invoke_test_hook(phase: str) -> None:
    if _test_hook is not None:
        _test_hook(phase)
        return
    if os.environ.get("TEST_HOOK") == phase:
        raise CommitAbort(phase)


def proposal_to_inventory_action(proposal: dict) -> dict[str, Any]:
    op = proposal["op"]
    payload = dict(proposal["payload"])
    if op == "item.adjust":
        return {"action": "item.adjust", "id": payload["id"], "delta": payload["delta"]}
    if op == "item.create":
        body = {"action": "item.create"}
        for k in ("name", "qty", "unit", "place", "min", "tags", "note", "photos"):
            if k in payload:
                body[k] = payload[k]
        return body
    if op == "item.update":
        body = {"action": "item.update", "id": payload["id"], "rev": payload["rev"]}
        for k in ("place", "name", "qty", "unit", "min", "tags", "note", "photos"):
            if k in payload:
                body[k] = payload[k]
        return body
    if op == "item.delete":
        return {"action": "item.delete", "id": payload["id"], "rev": payload["rev"]}
    if op == "item.move":
        return {"action": "item.move", "ids": payload["ids"], "place": payload.get("place")}
    if op == "place.create":
        body = {"action": "place.create"}
        for k in ("name", "kind", "parent", "note", "photos"):
            if k in payload:
                body[k] = payload[k]
        return body
    if op == "place.update":
        body = {"action": "place.update", "id": payload["id"], "rev": payload["rev"]}
        for k in ("parent", "name", "kind", "note", "photos"):
            if k in payload:
                body[k] = payload[k]
        return body
    if op == "place.delete":
        out = {"action": "place.delete", "id": payload["id"], "rev": payload["rev"]}
        if "contents" in payload:
            out["contents"] = payload["contents"]
        return out
    raise ValueError(f"op inventoria inconnue: {op}")


def build_planned_steps(proposals: list[dict]) -> list[dict]:
    steps: list[dict] = []
    for p in proposals:
        action = p["op"]
        steps.append({
            "store": "inventory",
            "action": action,
            "attempt_phase": "not_started",
            "payload": dict(p["payload"]),
        })
    return steps


def _safe_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _commit_preview_digest(
    proposals: list[dict],
    expected_inventory_rev: int,
    item_rev_expectations: list[dict] | None,
) -> str:
    normalized = [
        {
            "op": p["op"],
            "refs": p.get("refs") or {},
            "resolved": p.get("resolved") or {},
            "payload": p.get("payload") or {},
        }
        for p in proposals
    ]
    blob = {
        "proposals": normalized,
        "expected_inventory_rev": int(expected_inventory_rev),
        "item_rev_expectations": item_rev_expectations or [],
    }
    return hashlib.sha256(_safe_json(blob).encode("utf-8")).hexdigest()


def _new_xop_id() -> str:
    return f"xop-{secrets.token_hex(8)}"


def _item_rev_filter(
    expectations: list[dict] | None,
    item_id: str | None,
) -> list[dict] | None:
    if not expectations or not item_id:
        return None
    return [e for e in expectations if e.get("item_id") == item_id]


def _cross_store_doc_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "status": row["status"],
        "idempotency_key": row["idempotency_key"],
        "request_hash": row["request_hash"],
        "planned_steps": json.loads(row["planned_steps_json"]),
        "step_index": int(row["step_index"]),
        "step_results": json.loads(row["step_results_json"] or "[]"),
        "uncertain_inventory": int(row["uncertain_inventory"]),
    }


def _finalize_preconditions(
    xop: sqlite3.Row,
    steps: list[dict],
    step_results: list[dict],
) -> bool:
    if int(xop["uncertain_inventory"]) != 0:
        return False
    if xop["status"] in ("needs_reconcile", "failed", "cancelled"):
        return False
    if not _all_inventory_steps_acknowledged(steps):
        return False
    ack_count = sum(1 for s in steps if s.get("attempt_phase") == "acknowledged")
    if len(step_results) < ack_count:
        return False
    for res in step_results:
        if not isinstance(res, dict) or "step_index" not in res:
            return False
        idx = int(res["step_index"])
        if idx < 0 or idx >= len(steps):
            return False
        if steps[idx].get("attempt_phase") != "acknowledged":
            return False
    return True


def journal_ready_to_finalize(conn: sqlite3.Connection, xop_id: str) -> bool:
    row = conn.execute(
        "SELECT * FROM cross_store_ops WHERE id = ?",
        (xop_id,),
    ).fetchone()
    if row is None:
        return False
    if row["status"] == "committed":
        return False
    steps = json.loads(row["planned_steps_json"])
    step_results = json.loads(row["step_results_json"] or "[]")
    return _finalize_preconditions(row, steps, step_results)


def _validate_xop_row(conn: sqlite3.Connection, xop_id: str) -> None:
    row = conn.execute("SELECT * FROM cross_store_ops WHERE id = ?", (xop_id,)).fetchone()
    if row is None:
        return
    schemas.validate_cross_store_op(_cross_store_doc_from_row(row))


def _expectations_for_step(
    step: dict,
    item_rev_expectations: list[dict] | None,
) -> list[dict] | None:
    action = step.get("action")
    payload = step.get("payload") or {}
    if action in ("item.update", "item.delete"):
        iid = payload.get("id")
        rev = payload.get("rev")
        if isinstance(iid, str) and isinstance(rev, int) and not isinstance(rev, bool):
            return [{"item_id": iid, "rev": rev}]
    if action == "item.adjust":
        iid = payload.get("id")
        if isinstance(iid, str):
            doc = inventory.snapshot()
            it = next((i for i in doc["items"] if i["id"] == iid), None)
            if it:
                return [{"item_id": iid, "rev": it["rev"]}]
    return _item_rev_filter(item_rev_expectations, payload.get("id"))


def _all_inventory_steps_acknowledged(steps: list[dict]) -> bool:
    for st in steps:
        if st.get("store") == "inventory" and st.get("attempt_phase") != "acknowledged":
            return False
    return True


def finalize_commit_if_ready(
    conn: sqlite3.Connection,
    *,
    household_id: str,
    operation_id: str,
    xop_id: str,
    steps: list[dict],
    step_results: list[dict],
    cur_expected_rev: int,
    now: float,
) -> dict[str, Any]:
    """F6 only — no inventory apply."""
    xop = conn.execute("SELECT * FROM cross_store_ops WHERE id = ?", (xop_id,)).fetchone()
    if xop is None or not _finalize_preconditions(xop, steps, step_results):
        return {
            "ok": False,
            "code": "needs_reconcile",
            "cross_store_op_id": xop_id,
            "error": "finalisation refusée — journal incertain ou incomplet",
        }
    conn.execute(
        "UPDATE cross_store_ops SET status = ?, step_index = ?, uncertain_inventory = 0, "
        "inventory_rev_after = ?, closed_at = ?, updated_at = ? WHERE id = ?",
        ("committed", len(steps), cur_expected_rev, now, now, xop_id),
    )
    commit_result = {
        "ok": True,
        "cross_store_op_id": xop_id,
        "inventory_rev_after": cur_expected_rev,
        "steps_applied": len(step_results),
    }
    conn.execute(
        "UPDATE inventoria_operations SET status = ?, commit_result_json = ?, updated_at = ? WHERE id = ?",
        ("committed", _safe_json(commit_result), now, operation_id),
    )
    _validate_xop_row(conn, xop_id)
    return commit_result


def run_inventoria_commit(
    conn: sqlite3.Connection,
    *,
    household_id: str,
    operation_id: str,
    proposals: list[dict],
    idempotency_key: str,
    request_hash: str,
    expected_inventory_rev: int,
    item_rev_expectations: list[dict] | None,
    preview_digest: str,
    now: float,
    resume: bool = False,
) -> dict[str, Any]:
    """Execute F0–F6 inside an open SQLite transaction (caller commits)."""
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (operation_id, household_id),
    ).fetchone()
    if row is None:
        raise KeyError("operation_not_found")
    xop_id = row["cross_store_op_id"]
    if resume and xop_id:
        xop = conn.execute(
            "SELECT * FROM cross_store_ops WHERE id = ?", (xop_id,),
        ).fetchone()
        if xop is None:
            raise KeyError("cross_store_missing")
        steps = json.loads(xop["planned_steps_json"])
        step_results = json.loads(xop["step_results_json"] or "[]")
        if _finalize_preconditions(xop, steps, step_results) and xop["status"] != "committed":
            cur = int(xop["inventory_rev_after"] or expected_inventory_rev)
            conn.execute(
                "UPDATE cross_store_ops SET uncertain_inventory = 0, status = ?, updated_at = ? WHERE id = ?",
                ("finalizing", now, xop_id),
            )
            _invoke_test_hook("F6")
            return finalize_commit_if_ready(
                conn,
                household_id=household_id,
                operation_id=operation_id,
                xop_id=xop_id,
                steps=steps,
                step_results=step_results,
                cur_expected_rev=cur,
                now=now,
            )
    else:
        xop_id = _new_xop_id()
        steps = build_planned_steps(proposals)
        schemas.validate_cross_store_op({
            "id": xop_id,
            "kind": "inventoria_commit",
            "status": "accepted",
            "idempotency_key": idempotency_key,
            "request_hash": request_hash,
            "planned_steps": steps,
            "step_index": 0,
            "step_results": [],
            "uncertain_inventory": 0,
        })
        _invoke_test_hook("F0")
        conn.execute(
            "INSERT INTO cross_store_ops("
            "id, household_id, kind, idempotency_key, status, request_hash, "
            "planned_steps_json, step_index, step_results_json, uncertain_inventory, "
            "created_at, updated_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                xop_id, household_id, "inventoria_commit", idempotency_key, "accepted",
                request_hash, _safe_json(steps), 0, "[]", 0, now, now,
            ),
        )
        _invoke_test_hook("F1")
        conn.execute(
            "UPDATE cross_store_ops SET status = ?, planned_steps_json = ?, updated_at = ? WHERE id = ?",
            ("preparing", _safe_json(steps), now, xop_id),
        )
        conn.execute(
            "UPDATE inventoria_operations SET status = ?, cross_store_op_id = ?, "
            "commit_idempotency_key = ?, request_hash = ?, expected_inventory_rev = ?, "
            "item_rev_expectations_json = ?, preview_digest = ?, updated_at = ? WHERE id = ?",
            (
                "committing", xop_id, idempotency_key, request_hash,
                expected_inventory_rev,
                _safe_json(item_rev_expectations) if item_rev_expectations else None,
                preview_digest, now, operation_id,
            ),
        )
        xop = conn.execute("SELECT * FROM cross_store_ops WHERE id = ?", (xop_id,)).fetchone()

    _invoke_test_hook("F2")
    conn.execute(
        "UPDATE cross_store_ops SET status = ?, updated_at = ? WHERE id = ?",
        ("applying_sqlite", now, xop_id),
    )

    steps = json.loads(xop["planned_steps_json"])
    step_index = int(xop["step_index"])
    step_results = json.loads(xop["step_results_json"] or "[]")
    uncertain = int(xop["uncertain_inventory"])

    inv_doc = inventory.snapshot()
    rev_before = int(inv_doc["rev"])
    _invoke_test_hook("F3")
    conn.execute(
        "UPDATE cross_store_ops SET status = ?, inventory_rev_before = ?, updated_at = ? WHERE id = ?",
        ("applying_inventory", rev_before, now, xop_id),
    )

    cur_expected_rev = expected_inventory_rev
    if resume and step_results:
        last = step_results[-1]
        if isinstance(last, dict) and "inventory_rev" in last:
            cur_expected_rev = int(last["inventory_rev"])

    while step_index < len(steps):
        step = steps[step_index]
        phase = step.get("attempt_phase", "not_started")
        action = step["action"]
        recovery = schemas.recovery_for_inventory_step(
            action=action,
            attempt_phase=phase,
            uncertain_inventory=uncertain,
        )
        if recovery == "skip_already_acknowledged":
            step_index += 1
            continue
        if recovery == "needs_reconcile":
            conn.execute(
                "UPDATE cross_store_ops SET status = ?, uncertain_inventory = 1, updated_at = ? WHERE id = ?",
                ("needs_reconcile", now, xop_id),
            )
            conn.execute(
                "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
                ("needs_reconcile", now, operation_id),
            )
            return {"ok": False, "code": "needs_reconcile", "cross_store_op_id": xop_id}

        if phase == "not_started" and not schemas.may_auto_replay_inventory_step(
            action=action,
            uncertain_inventory=uncertain,
            attempt_phase=phase,
        ):
            conn.execute(
                "UPDATE cross_store_ops SET status = ?, uncertain_inventory = 1, updated_at = ? WHERE id = ?",
                ("needs_reconcile", now, xop_id),
            )
            conn.execute(
                "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
                ("needs_reconcile", now, operation_id),
            )
            return {"ok": False, "code": "needs_reconcile", "cross_store_op_id": xop_id}

        step["attempt_phase"] = "in_flight"
        steps[step_index] = step
        _invoke_test_hook("F3b")
        conn.execute(
            "UPDATE cross_store_ops SET planned_steps_json = ?, step_index = ?, updated_at = ? WHERE id = ?",
            (_safe_json(steps), step_index, now, xop_id),
        )
        conn.commit()
        _invoke_test_hook("F3c")

        try:
            apply_body = proposal_to_inventory_action({"op": action, "payload": step["payload"]})
            item_id = step["payload"].get("id")
            strict_adj = action == "item.adjust"
            _invoke_test_hook("F4")
            step_expectations = _expectations_for_step(step, item_rev_expectations)
            result = inventory.apply_guarded(
                apply_body,
                expected_inventory_rev=cur_expected_rev,
                item_rev_expectations=step_expectations,
                strict_adjust=strict_adj,
            )
        except inventory.InventoryError as exc:
            conn.execute(
                "UPDATE cross_store_ops SET status = ?, uncertain_inventory = 1, "
                "error_code = ?, updated_at = ? WHERE id = ?",
                ("needs_reconcile", exc.code, now, xop_id),
            )
            conn.execute(
                "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
                ("needs_reconcile", now, operation_id),
            )
            _validate_xop_row(conn, xop_id)
            return {
                "ok": False,
                "code": "needs_reconcile",
                "error": str(exc),
                "http_status": exc.status,
                "cross_store_op_id": xop_id,
            }
        except CommitAbort:
            conn.execute(
                "UPDATE cross_store_ops SET status = ?, uncertain_inventory = 1, updated_at = ? WHERE id = ?",
                ("needs_reconcile", now, xop_id),
            )
            conn.execute(
                "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
                ("needs_reconcile", now, operation_id),
            )
            _validate_xop_row(conn, xop_id)
            return {"ok": False, "code": "needs_reconcile", "cross_store_op_id": xop_id}

        try:
            _invoke_test_hook("F4b")
        except CommitAbort:
            conn.execute(
                "UPDATE cross_store_ops SET status = ?, uncertain_inventory = 1, updated_at = ? WHERE id = ?",
                ("needs_reconcile", now, xop_id),
            )
            conn.execute(
                "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
                ("needs_reconcile", now, operation_id),
            )
            _validate_xop_row(conn, xop_id)
            return {"ok": False, "code": "needs_reconcile", "cross_store_op_id": xop_id}

        def _uncertain_after_apply(exc: BaseException) -> dict[str, Any]:
            """Apply succeeded but F5 ack is not durable — stay in_flight, never replay."""
            conn.execute(
                "UPDATE cross_store_ops SET status = ?, uncertain_inventory = 1, "
                "error_code = ?, updated_at = ? WHERE id = ?",
                ("needs_reconcile", "ack_uncertain", now, xop_id),
            )
            conn.execute(
                "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
                ("needs_reconcile", now, operation_id),
            )
            conn.commit()
            _validate_xop_row(conn, xop_id)
            http = exc.status if isinstance(exc, inventory.InventoryError) else 409
            return {
                "ok": False,
                "code": "needs_reconcile",
                "error": str(exc),
                "http_status": http,
                "cross_store_op_id": xop_id,
            }

        try:
            _invoke_test_hook("F5")
        except Exception as exc:
            return _uncertain_after_apply(exc)
        step["attempt_phase"] = "acknowledged"
        steps[step_index] = step
        ack_results = step_results + [{
            "step_index": step_index,
            "action": action,
            "inventory_rev": result.get("rev"),
            "result": {k: v for k, v in result.items() if k in ("item", "place", "items", "deleted", "moved")},
        }]
        next_rev = int(result["rev"])
        next_index = step_index + 1
        try:
            conn.execute(
                "UPDATE cross_store_ops SET planned_steps_json = ?, step_results_json = ?, "
                "step_index = ?, inventory_rev_after = ?, updated_at = ? WHERE id = ?",
                (_safe_json(steps), _safe_json(ack_results), next_index, next_rev, now, xop_id),
            )
            conn.commit()
        except Exception as exc:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
            return _uncertain_after_apply(exc)
        step_results = ack_results
        cur_expected_rev = next_rev
        step_index = next_index
        _validate_xop_row(conn, xop_id)

    xop = conn.execute("SELECT * FROM cross_store_ops WHERE id = ?", (xop_id,)).fetchone()
    if _finalize_preconditions(xop, steps, step_results):
        try:
            conn.execute(
                "UPDATE cross_store_ops SET uncertain_inventory = 0, status = ?, updated_at = ? WHERE id = ?",
                ("finalizing", now, xop_id),
            )
            _invoke_test_hook("F6")
        except CommitAbort:
            conn.execute(
                "UPDATE cross_store_ops SET status = ?, uncertain_inventory = 0, updated_at = ? WHERE id = ?",
                ("finalizing", now, xop_id),
            )
            conn.execute(
                "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
                ("committing", now, operation_id),
            )
            _validate_xop_row(conn, xop_id)
            return {"ok": False, "code": "needs_reconcile", "cross_store_op_id": xop_id}
        return finalize_commit_if_ready(
            conn,
            household_id=household_id,
            operation_id=operation_id,
            xop_id=xop_id,
            steps=steps,
            step_results=step_results,
            cur_expected_rev=cur_expected_rev,
            now=now,
        )
    conn.execute(
        "UPDATE cross_store_ops SET status = ?, uncertain_inventory = 1, updated_at = ? WHERE id = ?",
        ("needs_reconcile", now, xop_id),
    )
    conn.execute(
        "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
        ("needs_reconcile", now, operation_id),
    )
    return {"ok": False, "code": "needs_reconcile", "cross_store_op_id": xop_id}


def reconcile_cross_store(
    conn: sqlite3.Connection,
    *,
    household_id: str,
    operation_id: str,
    decision: str,
    reason: str,
    idempotency_key: str | None,
    evidence: dict | None = None,
    step_index: int | None = None,
    now: float,
) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM inventoria_operations WHERE id = ? AND household_id = ?",
        (operation_id, household_id),
    ).fetchone()
    if row is None:
        raise KeyError("operation_not_found")
    xop_id = row["cross_store_op_id"]
    if not xop_id:
        raise KeyError("no_cross_store")
    xop = conn.execute("SELECT * FROM cross_store_ops WHERE id = ?", (xop_id,)).fetchone()
    if xop is None:
        raise KeyError("cross_store_missing")

    if decision == "inspect":
        return {
            "ok": True,
            "operation_status": row["status"],
            "cross_store": {
                "id": xop_id,
                "status": xop["status"],
                "step_index": int(xop["step_index"]),
                "uncertain_inventory": int(xop["uncertain_inventory"]),
                "planned_steps": json.loads(xop["planned_steps_json"]),
                "step_results": json.loads(xop["step_results_json"] or "[]"),
            },
        }

    if decision == "confirm_already_applied":
        if not isinstance(evidence, dict):
            raise ValueError("evidence requis pour confirm_already_applied")
        idx = step_index if isinstance(step_index, int) else int(xop["step_index"])
        steps = json.loads(xop["planned_steps_json"])
        if idx < 0 or idx >= len(steps):
            raise ValueError("step_index hors bornes")
        st = steps[idx]
        if st.get("attempt_phase") != "in_flight":
            raise ValueError("seule une étape in_flight peut être acquittée manuellement")
        inv_rev = evidence.get("inventory_rev")
        if isinstance(inv_rev, bool) or type(inv_rev) is not int:
            raise ValueError("evidence.inventory_rev requis (entier strict)")
        st["attempt_phase"] = "acknowledged"
        steps[idx] = st
        step_results = json.loads(xop["step_results_json"] or "[]")
        step_results.append({
            "step_index": idx,
            "action": st.get("action"),
            "inventory_rev": inv_rev,
            "result": {"operator_evidence": evidence, "manual_ack": True},
        })
        conn.execute(
            "UPDATE cross_store_ops SET planned_steps_json = ?, step_results_json = ?, "
            "uncertain_inventory = 0, inventory_rev_after = ?, step_index = ?, "
            "status = ?, updated_at = ? WHERE id = ?",
            (
                _safe_json(steps),
                _safe_json(step_results),
                inv_rev,
                idx + 1,
                "applying_inventory" if not _all_inventory_steps_acknowledged(steps) else "finalizing",
                now,
                xop_id,
            ),
        )
        if _all_inventory_steps_acknowledged(steps):
            finalize_commit_if_ready(
                conn,
                household_id=household_id,
                operation_id=operation_id,
                xop_id=xop_id,
                steps=steps,
                step_results=step_results,
                cur_expected_rev=inv_rev,
                now=now,
            )
            conn.execute(
                "UPDATE inventoria_operations SET preview_confirmed = 1, updated_at = ? WHERE id = ?",
                (now, operation_id),
            )
        else:
            conn.execute(
                "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
                ("needs_reconcile", now, operation_id),
            )
        return {"ok": True, "decision": decision, "step_index": idx}

    if decision == "confirm_not_applied":
        if not idempotency_key:
            raise ValueError("idempotency_key required")
        schemas.require_idempotency_key(idempotency_key)
        if step_index is None:
            raise ValueError("step_index requis")
        if isinstance(step_index, bool) or type(step_index) is not int:
            raise ValueError("step_index doit être un entier")
        idx = int(step_index)
        sub_key = f"{operation_id}|{idempotency_key}|confirm_not_applied|{idx}"
        req_hash = hashlib.sha256(
            _safe_json({
                "decision": decision,
                "operation_id": operation_id,
                "step_index": idx,
                "reason": reason,
                "idempotency_key": idempotency_key,
            }).encode(),
        ).hexdigest()
        prev = conn.execute(
            "SELECT request_hash, response_json FROM inventoria_commit_idempotency "
            "WHERE household_id = ? AND idempotency_key = ? AND operation_id = ?",
            (household_id, sub_key, operation_id),
        ).fetchone()
        if prev:
            if prev["request_hash"] != req_hash:
                raise ValueError("idempotency conflict reconcile")
            return json.loads(prev["response_json"])
        steps = json.loads(xop["planned_steps_json"])
        if idx >= len(steps):
            raise ValueError("step_index invalide")
        if steps[idx].get("attempt_phase") != "in_flight":
            raise ValueError("confirm_not_applied cible une étape in_flight uniquement")
        steps[idx]["attempt_phase"] = "not_started"
        cur_rev = int(inventory.snapshot()["rev"])
        conn.execute(
            "UPDATE cross_store_ops SET planned_steps_json = ?, uncertain_inventory = 0, "
            "status = ?, updated_at = ? WHERE id = ?",
            (_safe_json(steps), "applying_inventory", now, xop_id),
        )
        row = conn.execute(
            "SELECT * FROM inventoria_operations WHERE id = ?", (operation_id,),
        ).fetchone()
        proposals = json.loads(row["proposals_json"])
        item_exp: list[dict] = []
        for p in proposals:
            payload = p.get("payload") or {}
            if p["op"] in ("item.update", "item.delete", "item.adjust"):
                iid = payload.get("id")
                if isinstance(iid, str):
                    it = next((i for i in inventory.snapshot()["items"] if i["id"] == iid), None)
                    if it:
                        item_exp.append({"item_id": iid, "rev": it["rev"]})
        digest = _commit_preview_digest(proposals, cur_rev, item_exp)
        conn.execute(
            "UPDATE inventoria_operations SET status = ?, expected_inventory_rev = ?, "
            "preview_digest = ?, item_rev_expectations_json = ?, "
            "preview_confirmed = 1, updated_at = ? WHERE id = ?",
            (
                "previewed",
                cur_rev,
                digest,
                _safe_json(item_exp) if item_exp else None,
                now,
                operation_id,
            ),
        )
        result = run_inventoria_commit(
            conn,
            household_id=household_id,
            operation_id=operation_id,
            proposals=proposals,
            idempotency_key=sub_key,
            request_hash=req_hash,
            expected_inventory_rev=cur_rev,
            item_rev_expectations=item_exp,
            preview_digest=str(digest),
            now=now,
            resume=True,
        )
        wrapped: dict[str, Any] = {"ok": result.get("ok", False), "decision": decision, "commit": result}
        if not result.get("ok"):
            wrapped["code"] = result.get("code", "needs_reconcile")
            return wrapped
        conn.execute(
            "INSERT INTO inventoria_commit_idempotency("
            "household_id, idempotency_key, operation_id, request_hash, response_json, created_at"
            ") VALUES (?, ?, ?, ?, ?, ?)",
            (household_id, sub_key, operation_id, req_hash, _safe_json(wrapped), now),
        )
        _validate_xop_row(conn, xop_id)
        return wrapped

    if decision == "abort_compensate":
        conn.execute(
            "UPDATE cross_store_ops SET status = ?, error_code = ?, uncertain_inventory = 1, "
            "updated_at = ? WHERE id = ?",
            ("needs_reconcile", "abort_no_compensation", now, xop_id),
        )
        conn.execute(
            "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
            ("needs_reconcile", now, operation_id),
        )
        _validate_xop_row(conn, xop_id)
        return {
            "ok": True,
            "decision": decision,
            "warning": "aucune compensation inventaire appliquée — reconcile requis",
        }

    raise ValueError(f"decision inconnue: {decision}")
