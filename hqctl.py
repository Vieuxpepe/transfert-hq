#!/usr/bin/env python3
"""Local structured CLI for Transfert HQ companions.

Runs in-process on the controller. Default origin is ``planner``, so a new
job that is not a pure read waits for a human. The planner cannot approve.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import hq_agent_ops as ops
import hq_companion
import hq_jobs


def _print(payload: dict, as_json: bool) -> None:
    if as_json:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    else:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def _bind(root: str) -> None:
    hq_companion.bind(Path(root))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Contrôle local des companions HQ")
    parser.add_argument("--root", default=".", help="dossier du pont (hq_agents.json)")
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("devices")
    sub.add_parser("jobs")

    token = sub.add_parser("enroll-token")
    token.add_argument("--label", default="")

    run = sub.add_parser("run")
    run.add_argument("--device", required=True)
    run.add_argument("--op", required=True)
    run.add_argument("--args", default="{}")
    run.add_argument("--origin", default="planner", choices=list(ops.ORIGINS))
    run.add_argument("--ttl", type=int, default=None)
    run.add_argument("--confirm", action="store_true", help="ignoré — n'approuve rien")

    approve = sub.add_parser("approve")
    approve.add_argument("id")
    approve.add_argument("--origin", default="planner", choices=list(ops.ORIGINS))

    cancel = sub.add_parser("cancel")
    cancel.add_argument("id")
    cancel.add_argument("--origin", default="planner", choices=list(ops.ORIGINS))

    reject = sub.add_parser("reject")
    reject.add_argument("id")
    reject.add_argument("--origin", default="planner", choices=list(ops.ORIGINS))

    imported = sub.add_parser("import-artifact")
    imported.add_argument("--rel", required=True)
    imported.add_argument("--dest", required=True, choices=("Inbox", "Uni", "Print"))

    args = parser.parse_args(argv)
    try:
        _bind(args.root)
        if args.cmd == "devices":
            payload = {"ok": True, "devices": hq_companion.list_devices()}
        elif args.cmd == "jobs":
            payload = hq_jobs.list_jobs(limit=50)
        elif args.cmd == "enroll-token":
            payload = hq_companion.create_enroll_token(label=args.label)
        elif args.cmd == "run":
            try:
                raw_args = json.loads(args.args or "{}")
            except json.JSONDecodeError as exc:
                raise ops.AgentOpError("arguments JSON invalides") from exc
            if not isinstance(raw_args, dict):
                raise ops.AgentOpError("arguments JSON invalides")
            granted = hq_companion.granted_for(args.device)
            if granted is None:
                raise ops.AgentOpError("appareil introuvable")
            job = hq_jobs.create_job(
                device_id=args.device,
                op=args.op,
                args=raw_args if isinstance(raw_args, dict) else {},
                origin=args.origin,
                ttl_sec=args.ttl,
                granted=granted,
                confirm=True if args.confirm else None,
            )
            payload = {"ok": True, "job": job}
        elif args.cmd == "approve":
            payload = {"ok": True, "job": hq_jobs.approve(args.id, actor=args.origin)}
        elif args.cmd == "cancel":
            payload = {"ok": True, "job": hq_jobs.cancel(args.id, actor=args.origin)}
        elif args.cmd == "reject":
            payload = {"ok": True, "job": hq_jobs.reject(args.id, actor=args.origin)}
        elif args.cmd == "import-artifact":
            payload = hq_companion.import_artifact(rel=args.rel, dest=args.dest)
        else:
            raise ops.AgentOpError("commande inconnue")
    except PermissionError as exc:
        _print({"ok": False, "error": str(exc)}, True)
        return 1
    except (ops.AgentOpError, RuntimeError, OSError, ValueError) as exc:
        _print({"ok": False, "error": str(exc)}, True)
        return 1
    _print(payload, bool(args.json))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
