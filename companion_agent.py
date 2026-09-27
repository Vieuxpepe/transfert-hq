#!/usr/bin/env python3
"""Transfert HQ Companion — outbound poller for a trusted computer.

No inbound port. No iOS. HTTPS to the controller (Tailscale Serve) unless
``--dev`` is talking to loopback. There is no self-update.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

import companion_ops
import hq_agent_ops as ops
import hq_agent_protocol as proto
import hq_devices
import hq_state

SUPPORT = [
    "status",
    "telemetry",
    "files_list",
    "files_read",
    "files_write",
    "files_copy",
    "screenshot",
    "clipboard_read",
    "clipboard_write",
    "apps_list",
    "apps_launch",
    "process_list",
    "process_kill",
    "power_lock",
    "power_sleep",
    "power_restart",
    "power_shutdown",
    "terminal_allowlisted",
    "jobs",
    "artifacts",
]


def default_config_path() -> Path:
    if os.name == "nt":
        base = os.environ.get("PROGRAMDATA") or r"C:\ProgramData"
        return Path(base) / "TransfertHQ" / "agent_config.json"
    return Path.cwd() / "agent_config.json"


def load_config(path: Path) -> dict:
    if not path.is_file():
        raise ops.AgentOpError("configuration companion absente")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ops.AgentOpError("configuration companion illisible") from exc
    if not isinstance(data, dict):
        raise ops.AgentOpError("configuration companion illisible")
    return data


def save_config(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    hq_state.write_json_atomic(path, data)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _request(url: str, *, method: str, body: bytes, headers: dict[str, str], timeout: float = 20) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
            status = int(resp.status)
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        status = int(exc.code)
    if not payload:
        return status, {}
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ops.AgentOpError("réponse HQ illisible") from exc
    if not isinstance(parsed, dict):
        raise ops.AgentOpError("réponse HQ illisible")
    return status, parsed


def signed_headers(secret: str, device_id: str, method: str, path: str, body: bytes, now: float | None = None) -> dict[str, str]:
    stamp = int(now if now is not None else time.time())
    nonce = secrets.token_urlsafe(18)
    signature = proto.sign(secret, method, path, stamp, nonce, body)
    return {
        proto.HEADER_DEVICE: device_id,
        proto.HEADER_TIME: str(stamp),
        proto.HEADER_NONCE: nonce,
        proto.HEADER_SIGNATURE: signature,
        "Content-Type": "application/json",
    }


def enroll_with_controller(config_path: Path, *, controller: str, token: str, name: str, workspaces: list[str], dev: bool) -> dict:
    if hq_devices.is_phone_os(platform.system()) or hq_devices.is_phone_os(platform.platform()):
        raise ops.AgentOpError("les appareils iOS ne peuvent pas exécuter le companion")
    try:
        base = proto.validate_controller_url(controller, dev=dev)
    except ValueError as exc:
        raise ops.AgentOpError(str(exc)) from exc
    body_obj = {
        "token": token,
        "name": name or platform.node(),
        "hostname": platform.node(),
        "os": platform.system().lower(),
        "protocol_version": proto.PROTOCOL_VERSION,
        "support": SUPPORT,
    }
    body = json.dumps(body_obj).encode("utf-8")
    status, payload = _request(
        base + "/agent/v1/enroll",
        method="POST",
        body=body,
        headers={"Content-Type": "application/json"},
    )
    if status != 200 or not payload.get("device_secret"):
        raise ops.AgentOpError(str(payload.get("error") or "enrôlement refusé"))
    ws = workspaces or [str(config_path.parent / "work")]
    data = {
        "controller_url": base,
        "device_id": payload["device_id"],
        "device_secret": payload["device_secret"],
        "protocol_version": proto.PROTOCOL_VERSION,
        "workspaces": ws,
        "terminal_allowlist": [],
        "apps": [],
        "clipboard_enabled": False,
        "destructive_power_enabled": False,
        "poll_sec": payload.get("poll_sec") or proto.POLL_SEC,
        "idle_poll_sec": payload.get("idle_poll_sec") or proto.IDLE_POLL_SEC,
        "dev": bool(dev),
    }
    save_config(config_path, data)
    return {"ok": True, "device_id": payload["device_id"], "config": str(config_path), "granted": payload.get("granted") or []}


def _post_signed(config: dict, path: str, payload: dict | None = None, extra_headers: dict | None = None, raw: bytes | None = None) -> tuple[int, dict]:
    try:
        base = proto.validate_controller_url(str(config.get("controller_url") or ""), dev=bool(config.get("dev")))
    except ValueError as exc:
        raise ops.AgentOpError(str(exc)) from exc
    body = raw if raw is not None else json.dumps(payload or {}).encode("utf-8")
    headers = signed_headers(
        str(config.get("device_secret") or ""),
        str(config.get("device_id") or ""),
        "POST",
        path,
        body,
    )
    if extra_headers:
        headers.update(extra_headers)
    return _request(base + path, method="POST", body=body, headers=headers)


def _safe_artifact_name(name: str) -> str:
    import re

    base = Path(name).name
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._")
    if not cleaned or not cleaned[0].isalnum():
        cleaned = "f" + cleaned
    return (cleaned or "artifact.bin")[:80]


def execute_job(config: dict, job: dict, host: companion_ops.RealHost, granted: list[str]) -> dict:
    token = str(job.get("dispatch_token") or "")
    status, started = _post_signed(
        config,
        "/agent/v1/start",
        {"id": job.get("id"), "dispatch_token": token},
    )
    if status != 200:
        return {"http": status, "result": started, "ok": False, "artifact": None, "error": str(started.get("error") or "démarrage refusé")}
    outcome = companion_ops.execute(job, host, granted=granted)
    artifact = None
    data = outcome.get("artifact_bytes")
    if isinstance(data, (bytes, bytearray)) and data:
        name = _safe_artifact_name(str(outcome.get("artifact_name") or "artifact.bin"))
        status, uploaded = _post_signed(
            config,
            "/agent/v1/artifact",
            raw=bytes(data),
            extra_headers={
                proto.HEADER_JOB: str(job.get("id") or ""),
                proto.HEADER_ARTIFACT_NAME: name,
                proto.HEADER_DISPATCH: token,
                "Content-Type": "application/octet-stream",
            },
        )
        if status != 200:
            outcome = {"ok": False, "summary": "", "output": "", "error": str(uploaded.get("error") or "artifact refusé")}
        else:
            artifact = uploaded.get("artifact")
    result_body = {
        "id": job.get("id"),
        "dispatch_token": token,
        "ok": bool(outcome.get("ok")),
        "summary": str(outcome.get("summary") or "")[:240],
        "output": str(outcome.get("output") or "")[: proto.OUTPUT_MAX],
        "error": str(outcome.get("error") or "")[:300],
    }
    status, payload = _post_signed(config, "/agent/v1/result", result_body)
    return {"http": status, "result": payload, "ok": bool(outcome.get("ok")), "artifact": artifact}


def run_once(config: dict, host: companion_ops.RealHost | None = None) -> dict:
    """One heartbeat + one poll. Returns whether a job ran."""
    if hq_devices.is_phone_os(str(config.get("os") or "")) or hq_devices.is_phone_os(platform.system()):
        raise ops.AgentOpError("les appareils iOS ne peuvent pas exécuter le companion")
    host = host or companion_ops.RealHost(config)
    status, heart = _post_signed(
        config,
        "/agent/v1/heartbeat",
        {
            "protocol_version": proto.PROTOCOL_VERSION,
            "hostname": platform.node(),
            "os": platform.system().lower(),
            "support": SUPPORT,
            "tailscale_ips": [ip for ip in (config.get("tailscale_ips") or []) if isinstance(ip, str)][:8],
        },
    )
    if status != 200:
        raise ops.AgentOpError(str(heart.get("error") or "battement refusé"))
    granted = [cap for cap in (heart.get("granted") or []) if isinstance(cap, str)]
    status, polled = _post_signed(config, "/agent/v1/poll", {"protocol_version": proto.PROTOCOL_VERSION})
    if status != 200:
        raise ops.AgentOpError(str(polled.get("error") or "poll refusé"))
    if isinstance(polled.get("granted"), list):
        granted = [cap for cap in polled["granted"] if isinstance(cap, str)]
    job = polled.get("job")
    if not isinstance(job, dict):
        return {"ok": True, "job": None, "granted": granted}
    finished = execute_job(config, job, host, granted)
    return {"ok": finished["ok"], "job": job.get("id"), "granted": granted, "result": finished}


def serve(config: dict, *, once: bool = False, sleep: Callable[[float], None] | None = None, host: companion_ops.RealHost | None = None) -> None:
    sleeper = sleep or time.sleep
    idle_streak = 0
    error_streak = 0
    poll_sec = float(config.get("poll_sec") or proto.POLL_SEC)
    idle_sec = float(config.get("idle_poll_sec") or proto.IDLE_POLL_SEC)
    while True:
        had_job = False
        try:
            outcome = run_once(config, host=host)
            had_job = bool(outcome.get("job"))
            error_streak = 0
            idle_streak = 0 if had_job else idle_streak + 1
            poll_sec = float(config.get("poll_sec") or poll_sec)
        except Exception as exc:
            error_streak += 1
            idle_streak = 0
            sys.stderr.write(f"companion: {exc}\n")
        if once:
            if error_streak:
                raise SystemExit(1)
            return
        delay = proto.next_delay(poll_sec=poll_sec, idle_sec=idle_sec, idle_streak=idle_streak, error_streak=error_streak)
        sleeper(delay)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Transfert HQ Companion")
    parser.add_argument("--config", default="")
    parser.add_argument("--controller", default="")
    parser.add_argument("--enroll", default="", help="jeton à usage unique")
    parser.add_argument("--name", default="")
    parser.add_argument("--workspace", action="append", default=[])
    parser.add_argument("--dev", action="store_true", help="HTTP loopback seulement")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    path = Path(args.config) if args.config else default_config_path()
    try:
        if args.enroll:
            if not args.controller:
                raise ops.AgentOpError("contrôleur requis")
            result = enroll_with_controller(
                path,
                controller=args.controller,
                token=args.enroll,
                name=args.name,
                workspaces=list(args.workspace or []),
                dev=bool(args.dev),
            )
            if args.json:
                sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
            else:
                sys.stdout.write(f"Companion enrôlé : {result['device_id']}\n")
            return 0
        config = load_config(path)
        config["dev"] = bool(args.dev or config.get("dev"))
        serve(config, once=bool(args.once))
        return 0
    except (ops.AgentOpError, RuntimeError, OSError) as exc:
        if args.json:
            sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False) + "\n")
        else:
            sys.stderr.write(str(exc) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
