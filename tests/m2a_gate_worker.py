"""Child process for the cross-process restart gate. Prints no cookies or tokens."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_jobs as jobs  # noqa: E402


def _transport(method, url, timeout, body=None):
    path = str(url).split("://", 1)[1]
    path = path[path.find("/"):].split("?", 1)[0]
    if method == "POST":
        return 200, b'{"images":[],"parameters":{},"info":"{}"}'
    table = {
        "/sdapi/v1/sd-models": [{"title": "example.safetensors [abcd]", "model_name": "example", "hash": "abcd", "sha256": None}],
        "/sdapi/v1/samplers": [{"name": "Euler"}],
        "/sdapi/v1/schedulers": [{"name": "automatic", "label": "Automatic"}],
        "/sdapi/v1/upscalers": [{"name": "R-ESRGAN 4x+"}, {"name": "None"}],
        "/sdapi/v1/options": {"sd_model_checkpoint": "example.safetensors"},
        "/internal/pending-tasks": {"size": 0, "tasks": []},
        "/sdapi/v1/progress": {"progress": 0, "state": {"job": "", "job_count": 0, "sampling_step": 0, "sampling_steps": 1}},
    }
    return 200, json.dumps(table[path]).encode("utf-8")


def _body() -> dict:
    return {
        "prompt": "a red circle",
        "negative_prompt": "blur",
        "checkpoint": "example.safetensors [abcd]",
        "sampler_name": "Euler",
        "scheduler": "automatic",
        "width": 512,
        "height": 512,
        "steps": 8,
        "cfg_scale": 6,
        "seed": -1,
        "n_iter": 1,
        "batch_size": 1,
    }


def _write_result(path: str, payload: dict) -> None:
    Path(path).write_text(json.dumps(payload), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--mode", required=True)
    parser.add_argument("--marker", default="")
    parser.add_argument("--token-file", default="")
    parser.add_argument("--release", default="")
    parser.add_argument("--result", default="")
    parser.add_argument("--timeout-ms", type=int, default=0)
    parser.add_argument("--sessions", default="")
    parser.add_argument("--cookie-file", default="")
    args = parser.parse_args()
    jobs.reset_for_tests()
    jobs.set_poll_interval_for_tests(0.05)
    if args.timeout_ms:
        jobs.set_admission_timeout_for_tests(args.timeout_ms)
    root = Path(args.root)

    if args.mode == "before-write":
        def before(point: str) -> None:
            if point != "before_gate_write":
                return
            Path(args.token_file).write_text(jobs.prepared_claim_token() or "", encoding="utf-8")
            Path(args.marker).write_text("before", encoding="utf-8")
            os._exit(91)

        jobs.set_admission_hook_for_tests(before)
        jobs.claim_restart(root)
        return 2

    if args.mode == "after-write":
        def after(point: str) -> None:
            if point != "after_gate_write":
                return
            Path(args.token_file).write_text(jobs.prepared_claim_token() or "", encoding="utf-8")
            Path(args.marker).write_text("after", encoding="utf-8")
            os._exit(92)

        jobs.set_admission_hook_for_tests(after)
        jobs.claim_restart(root)
        return 2

    if args.mode == "hold":
        def held(point: str) -> None:
            if point != "claim_held":
                return
            Path(args.token_file).write_text(jobs.prepared_claim_token() or "", encoding="utf-8")
            Path(args.marker).write_text("held", encoding="utf-8")
            release = Path(args.release)
            deadline = time.time() + 20
            while not release.exists() and time.time() < deadline:
                time.sleep(0.02)

        jobs.set_admission_hook_for_tests(held)
        ok, reason, _token = jobs.claim_restart(root)
        _write_result(args.result, {"ok": ok, "reason": reason})
        return 0 if ok else 1

    if args.mode == "claim":
        ok, reason, token = jobs.claim_restart(root)
        if args.token_file and token:
            Path(args.token_file).write_text(token, encoding="utf-8")
        gate = jobs.restart_gate(root)
        _write_result(args.result, {"ok": ok, "reason": reason, "pending": gate["pending"], "sealed": gate["sealed"]})
        return 0

    if args.mode == "release":
        token = Path(args.token_file).read_text(encoding="utf-8") if args.token_file else ""
        cleared = jobs.release_restart(root, token)
        gate = jobs.restart_gate(root)
        _write_result(args.result, {"cleared": cleared, "pending": gate["pending"], "sealed": gate["sealed"], "signaled": gate["signaled"]})
        return 0

    if args.mode == "admit":
        code, payload = jobs.create_job(root, _body(), "idem-cross-proc", transport=_transport)
        _write_result(args.result, {"status": code, "code": payload.get("code", "")})
        return 0

    if args.mode == "session":
        import hq_forge_lifecycle as life
        import iphone_bridge as bridge
        bridge.CONFIG["pin"] = "m2a-disposable-pin"
        bridge.SESSIONS_PATH = Path(args.sessions)
        life.reload_persisted_sessions(bridge)
        cookie = Path(args.cookie_file).read_text(encoding="utf-8")
        _write_result(args.result, {"role": bridge.session_role(cookie)})
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
