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


def _new_xop_id() -> str:
    return f"xop-{secrets.token_hex(8)}"


def _item_rev_filter(
    expectations: list[dict] | None,
    item_id: str | None,
) -> list[dict] | None:
    if not expectations or not item_id:
        return None
    return [e for e in expectations if e.get("item_id") == item_id]


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
        conn.execute("BEGIN IMMEDIATE")

        try:
            apply_body = proposal_to_inventory_action({"op": action, "payload": step["payload"]})
            item_id = step["payload"].get("id")
            strict_adj = action == "item.adjust"
            _invoke_test_hook("F4")
            result = inventory.apply_guarded(
                apply_body,
                expected_inventory_rev=cur_expected_rev if strict_adj or action.startswith("item.") else cur_expected_rev,
                item_rev_expectations=_item_rev_filter(item_rev_expectations, item_id),
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
            return {
                "ok": False,
                "code": "needs_reconcile" if exc.status == 409 else exc.code,
                "error": str(exc),
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
            return {"ok": False, "code": "needs_reconcile", "cross_store_op_id": xop_id}

        _invoke_test_hook("F5")
        step["attempt_phase"] = "acknowledged"
        steps[step_index] = step
        step_results.append({
            "step_index": step_index,
            "action": action,
            "inventory_rev": result.get("rev"),
            "result": {k: v for k, v in result.items() if k in ("item", "place", "items", "deleted", "moved")},
        })
        cur_expected_rev = int(result["rev"])
        step_index += 1
        conn.execute(
            "UPDATE cross_store_ops SET planned_steps_json = ?, step_results_json = ?, "
            "step_index = ?, inventory_rev_after = ?, updated_at = ? WHERE id = ?",
            (_safe_json(steps), _safe_json(step_results), step_index, cur_expected_rev, now, xop_id),
        )

    try:
        _invoke_test_hook("F6")
    except CommitAbort:
        conn.execute(
            "UPDATE cross_store_ops SET status = ?, uncertain_inventory = 1, updated_at = ? WHERE id = ?",
            ("needs_reconcile", now, xop_id),
        )
        conn.execute(
            "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
            ("needs_reconcile", now, operation_id),
        )
        return {"ok": False, "code": "needs_reconcile", "cross_store_op_id": xop_id}

    conn.execute(
        "UPDATE cross_store_ops SET status = ?, step_index = ?, closed_at = ?, updated_at = ? WHERE id = ?",
        ("committed", len(steps), now, now, xop_id),
    )
    commit_result = {
        "ok": True,
        "cross_store_op_id": xop_id,
        "inventory_rev_after": cur_expected_rev,
        "steps_applied": len(steps),
    }
    conn.execute(
        "UPDATE inventoria_operations SET status = ?, commit_result_json = ?, updated_at = ? WHERE id = ?",
        ("committed", _safe_json(commit_result), now, operation_id),
    )
    return commit_result


def reconcile_cross_store(
    conn: sqlite3.Connection,
    *,
    household_id: str,
    operation_id: str,
    decision: str,
    reason: str,
    idempotency_key: str | None,
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
        conn.execute(
            "UPDATE cross_store_ops SET uncertain_inventory = 0, status = ?, updated_at = ? WHERE id = ?",
            ("finalizing", now, xop_id),
        )
        steps = json.loads(xop["planned_steps_json"])
        for i, st in enumerate(steps):
            if st.get("store") == "inventory" and st.get("attempt_phase") == "in_flight":
                st["attempt_phase"] = "acknowledged"
                steps[i] = st
        conn.execute(
            "UPDATE cross_store_ops SET planned_steps_json = ?, status = ?, step_index = ?, "
            "closed_at = ?, updated_at = ? WHERE id = ?",
            (_safe_json(steps), "committed", len(steps), now, now, xop_id),
        )
        conn.execute(
            "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
            ("committed", now, operation_id),
        )
        return {"ok": True, "decision": decision}

    if decision == "confirm_not_applied":
        if not idempotency_key:
            raise ValueError("idempotency_key required")
        sub_key = f"{idempotency_key}|not-applied"
        prev = conn.execute(
            "SELECT 1 FROM inventoria_commit_idempotency WHERE household_id = ? AND idempotency_key = ?",
            (household_id, sub_key),
        ).fetchone()
        if prev:
            return {"ok": True, "decision": decision, "already_recorded": True}
        steps = json.loads(xop["planned_steps_json"])
        idx = int(xop["step_index"])
        if idx < len(steps):
            steps[idx]["attempt_phase"] = "not_started"
        conn.execute(
            "UPDATE cross_store_ops SET planned_steps_json = ?, uncertain_inventory = 0, "
            "status = ?, updated_at = ? WHERE id = ?",
            (_safe_json(steps), "applying_inventory", now, xop_id),
        )
        conn.execute(
            "INSERT INTO inventoria_commit_idempotency("
            "household_id, idempotency_key, operation_id, request_hash, response_json, created_at"
            ") VALUES (?, ?, ?, ?, ?, ?)",
            (household_id, sub_key, operation_id, hashlib.sha256(reason.encode()).hexdigest(), "{}", now),
        )
        return {"ok": True, "decision": decision, "may_retry": True}

    if decision == "abort_compensate":
        conn.execute(
            "UPDATE cross_store_ops SET status = ?, error_code = ?, closed_at = ?, updated_at = ? WHERE id = ?",
            ("failed", "aborted", now, now, xop_id),
        )
        conn.execute(
            "UPDATE inventoria_operations SET status = ?, updated_at = ? WHERE id = ?",
            ("failed", now, operation_id),
        )
        return {"ok": True, "decision": decision}

    raise ValueError(f"decision inconnue: {decision}")
