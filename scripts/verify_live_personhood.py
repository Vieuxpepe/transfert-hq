"""Live personhood gate: the running bridge must classify and keep her own line.

Signs in through the bridge's own /login (the PIN is read from
bridge_config.json and never printed), asks /api/ai for the read-only
context_preview as the session's own owner, seeds one personhood subject for
that owner, compares the live selection manifest with the in-process assembly
under the live companion config, then restores the store byte-for-byte.

Run with the bridge up:  python scripts/verify_live_personhood.py
Exit code 0 only when the values match; 1 otherwise.
"""
from __future__ import annotations

import hashlib
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import hq_ai as ai  # noqa: E402
import hq_companion_memory as memory  # noqa: E402
import hq_personhood as ph  # noqa: E402

BASE = "http://127.0.0.1:8765"
DEVICE = "hqtestdevice01ab"
MESSAGE = "Tu penses à la fermentation du chou ?"
COOKIE = "transfert_session"
SUBJECT = "Parle-moi de la fermentation du chou."
PERSONHOOD_PRIORITY = 96


def config() -> dict:
    return json.loads((ROOT / "bridge_config.json").read_text(encoding="utf-8"))


def self_path(owner: str) -> Path:
    with memory.owner_context(owner), memory.memory_scope("transferania"):
        with ph._scope("transferania", owner) as path:
            return Path(path)


def get(opener, path: str):
    request = urllib.request.Request(BASE + path, headers={"Referer": BASE + "/"}, method="GET")
    try:
        with opener.open(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def post(opener, path: str, *, data=None, form=None):
    body, headers = None, {"Origin": BASE, "Referer": BASE + "/"}
    if form is not None:
        body = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(BASE + path, data=body, headers=headers, method="POST")
    try:
        with opener.open(request, timeout=60) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers)


def pinned(usage: dict, contents: list) -> dict:
    text = json.dumps(contents, ensure_ascii=False)
    return {
        "budget": usage["input_budget"],
        "estimate": usage["estimated_input_tokens"],
        "totals": usage["selection_totals"],
        "rows": [(r["kind"], r["selected"], r["reason"], r["priority"])
                 for r in usage["selection_manifest"]],
        "personhood": [r for r in usage["selection_manifest"] if r["kind"] == "personhood"],
        "hint_in_payload": "SUJET RÉCENT" in text,
        "hint_text": next((part["text"] for m in contents for part in m.get("parts", [])
                           if isinstance(part.get("text"), str) and "SUJET RÉCENT" in part["text"]), ""),
    }


def owner_for_token(token: str) -> str:
    raw = json.loads((ROOT / "bridge_sessions.json").read_text(encoding="utf-8"))
    return ((raw.get(token) if isinstance(raw, dict) else None) or {}).get("user") or "admin"


def main() -> int:
    cfg = config()
    live_cfg = cfg.get("companion_context") or {}
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    status, _, headers = post(opener, "/login", form={"pin": str(cfg.get("pin") or "")})
    token = next((c.value for c in jar if c.name == COOKIE), "")
    if status not in (200, 303) or not token:
        print(f"verify_live_personhood: FAIL login status={status} cookie={bool(token)}")
        return 1
    owner = owner_for_token(token)

    fresh_status, fresh_raw = get(opener, "/api/pc/restart-bridge")
    fresh = json.loads(fresh_raw.decode("utf-8")) if fresh_status == 200 else {}
    started = fresh.get("started_at")

    path = self_path(owner)
    original = path.read_bytes() if path.exists() else None
    before = hashlib.sha256(original or b"").hexdigest()
    failures: list[str] = []
    try:
        with memory.owner_context(owner), memory.memory_scope("transferania"):
            ph.observe_chat("transferania", SUBJECT, now=time.time() - 3600)
        payload = {"action": "transferania", "op": "context_preview", "kind": "chat",
                   "device_id": DEVICE, "persona": "warm", "message": MESSAGE}
        status, body, _ = post(opener, "/api/ai", data=payload)
        live_raw = body.decode("utf-8")
        if status != 200:
            print(f"verify_live_personhood: FAIL preview status={status}")
            return 1
        live = json.loads(live_raw)

        ai.bind(root=ROOT, companion_context_config=lambda: live_cfg)
        code, out = ai.http_post(dict(payload), role="admin", owner_id=owner)
        live_pins = pinned(live["context_usage"], live["contents"])
        inproc_pins = pinned(out["context_usage"], out["contents"])

        rows = live_pins["personhood"]
        if not rows or not rows[0]["selected"]:
            failures.append("her line is missing or unselected in the live manifest")
        elif rows[0]["priority"] != PERSONHOOD_PRIORITY:
            failures.append(f"personhood priority {rows[0]['priority']} != {PERSONHOOD_PRIORITY}")
        if not live_pins["hint_in_payload"]:
            failures.append("SUJET RÉCENT absent from the live payload")
        if live.get("read_only") is not True or live.get("model_calls") != 0:
            failures.append("the live preview was not read-only")
        if live_pins["rows"] != inproc_pins["rows"]:
            failures.append("live manifest rows differ from in-process assembly")
        for key in ("budget", "estimate", "totals", "hint_in_payload"):
            if live_pins[key] != inproc_pins[key]:
                failures.append(f"live {key} differs from in-process")
        if live["system"] != out["system"]:
            failures.append("live system prompt differs from in-process")
        if fresh.get("pending") is not False:
            failures.append("the bridge is stale: source is newer than the process")

        print(json.dumps({
            "owner": owner, "pid": fresh.get("pid"), "started_at": started,
            "pending": fresh.get("pending"), "preview_status": status,
            "read_only": live.get("read_only"), "model_calls": live.get("model_calls"),
            "system_bytes": len(live["system"].encode("utf-8")),
            "budget": live_pins["budget"], "estimate": live_pins["estimate"],
            "slack": live_pins["budget"] - live_pins["estimate"],
            "totals": live_pins["totals"], "personhood": rows,
            "hint_in_payload": live_pins["hint_in_payload"],
            "hint_excerpt": live_pins["hint_text"][:180],
            "matches_inprocess": not failures,
        }, ensure_ascii=False, indent=2))

        post(opener, "/logout", form={})
    finally:
        if original is not None:
            path.write_bytes(original)
        after = hashlib.sha256(path.read_bytes() if path.exists() else b"").hexdigest()
        if after != before:
            failures.append("personhood store was not restored")

    if failures:
        print("verify_live_personhood: FAIL")
        for item in failures:
            print("  -", item)
        return 1
    print("verify_live_personhood: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
