#!/usr/bin/env python3
"""Planner-only HTTP client for the loopback HQ planner API.

This process imports only the standard library. It does not import the
companion registry, the job store, or any other repository module, and it
cannot approve, reject, enroll, revoke, or change policy. Human approval
stays in the browser admin session.

Default URL: http://127.0.0.1:8766
Token: --token, HQ_PLANNER_TOKEN, or --token-file
(default {root}/.hq-agent-state/hq_planner.json).

``--root`` only locates the token file. It does not open controller state.
If this program runs as the same OS account as the controller, the account
can still read hq_agents.json. The CLI is not that boundary.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

AGENT_STATE_DIR = ".hq-agent-state"
TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")


def _planner_token_path(root: Path | str) -> Path:
    return Path(root) / AGENT_STATE_DIR / "hq_planner.json"
STOP_STATES = frozenset({"succeeded", "failed", "cancelled", "expired", "rejected", "uncertain", "awaiting_approval"})


def _print(payload: dict, as_json: bool) -> None:
    if as_json:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    else:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def _token(args: argparse.Namespace) -> str:
    direct = str(args.token or "").strip()
    if direct:
        return direct
    env = os.environ.get("HQ_PLANNER_TOKEN", "").strip()
    if env:
        return env
    path = Path(args.token_file) if args.token_file else _planner_token_path(args.root)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit("jeton planificateur illisible") from exc
    token = str(raw.get("token") or "") if isinstance(raw, dict) else ""
    if not TOKEN_RE.fullmatch(token):
        raise SystemExit("jeton planificateur illisible")
    return token


def _request(url: str, token: str, method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url.rstrip("/") + path,
        data=body,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
    except urllib.error.URLError as exc:
        raise SystemExit(f"planificateur injoignable: {exc.reason}") from exc
    try:
        data = json.loads(raw.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SystemExit("réponse planificateur illisible") from exc
    if not isinstance(data, dict):
        raise SystemExit("réponse planificateur illisible")
    return status, data


def _wait(url: str, token: str, job_id: str, timeout: float) -> dict:
    deadline = time.monotonic() + max(0.0, timeout)
    last: dict = {}
    while True:
        status, payload = _request(url, token, "GET", f"/local-agent/v1/jobs/{job_id}")
        if status != 200:
            raise SystemExit(payload.get("error") or "lecture refusée")
        job = payload.get("job") if isinstance(payload.get("job"), dict) else {}
        last = job
        if str(job.get("state") or "") in STOP_STATES:
            return job
        if time.monotonic() >= deadline:
            return last
        time.sleep(0.2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Client HTTP du planificateur HQ (loopback)")
    parser.add_argument("--url", default="http://127.0.0.1:8766")
    parser.add_argument("--root", default=".", help="dossier du fichier jeton, pas de l'état du pont")
    parser.add_argument("--token", default="")
    parser.add_argument("--token-file", default="")
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("devices")
    sub.add_parser("jobs")
    run = sub.add_parser("run")
    run.add_argument("--device", required=True)
    run.add_argument("--op", required=True)
    run.add_argument("--args", default="{}")
    run.add_argument("--wait", type=float, default=30.0)
    wait = sub.add_parser("wait")
    wait.add_argument("--id", required=True)
    wait.add_argument("--timeout", type=float, default=30.0)
    cancel = sub.add_parser("cancel")
    cancel.add_argument("--id", required=True)
    args = parser.parse_args(argv)
    parsed = urllib.parse.urlparse(args.url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
        sys.stderr.write("hqctl ne parle qu'à http://127.0.0.1\n")
        return 1
    try:
        token = _token(args)
    except SystemExit as exc:
        sys.stderr.write(str(exc) + "\n")
        return 1
    try:
        if args.cmd == "devices":
            status, payload = _request(args.url, token, "GET", "/local-agent/v1/devices")
        elif args.cmd == "jobs":
            status, payload = _request(args.url, token, "GET", "/local-agent/v1/jobs")
        elif args.cmd == "run":
            try:
                op_args = json.loads(args.args or "{}")
            except json.JSONDecodeError:
                sys.stderr.write("args JSON invalide\n")
                return 1
            if not isinstance(op_args, dict):
                sys.stderr.write("args JSON invalide\n")
                return 1
            status, payload = _request(
                args.url,
                token,
                "POST",
                "/local-agent/v1/jobs",
                {"device_id": args.device, "op": args.op, "args": op_args},
            )
            if status == 200 and isinstance(payload.get("job"), dict):
                payload["job"] = _wait(args.url, token, str(payload["job"].get("id") or ""), float(args.wait))
        elif args.cmd == "wait":
            job = _wait(args.url, token, args.id, float(args.timeout))
            status, payload = 200, {"ok": True, "job": job}
        elif args.cmd == "cancel":
            status, payload = _request(args.url, token, "POST", f"/local-agent/v1/jobs/{args.id}/cancel", {})
        else:
            return 2
    except SystemExit as exc:
        sys.stderr.write(str(exc) + "\n")
        return 1
    _print(payload, args.json)
    return 0 if status < 400 else 1


if __name__ == "__main__":
    raise SystemExit(main())
