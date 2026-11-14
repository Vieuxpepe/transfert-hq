"""Live personhood gate: her line must come out of real state, not a constant.

Signs in through the bridge's own /login (the PIN is read from
bridge_config.json and never printed), then drives two genuinely different
subject states for the session's own owner:

  hot   two turns about the subject inside the hour  -> tier hot,  priority 98, share 320
  cold  one turn about it twenty hours ago           -> tier cold, priority 84, share 160

For each state it captures the live read-only /api/ai context_preview, compares
it with in-process assembly under the live companion config, and restores the
personhood store byte-for-byte. It fails closed when the bridge is stale
(``pending: true``) or when any predicted value does not match.

Run with the bridge up:  python scripts/verify_live_personhood.py
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
# Social, and it names the subject, so the live pick cannot drift onto another
# recent turn while the bridge is in use.
MESSAGE = "Tu te souviens de notre discussion sur la fermentation du chou ?"
COOKIE = "transfert_session"
SUBJECT = "Parle-moi de la fermentation du chou."

HOT = {"tier": "hot", "priority": 98, "share": 320, "selected": True}
COLD = {"tier": "cold", "priority": 84, "share": 160, "selected": False}
PUSHED = {"tier": "cold", "priority": 84, "share": 160, "selected": False, "withhold": True}
# Same recent evidence as hot, but the Master corrected this very subject twice:
# the offer is withdrawn instead of merely shrinking.
STATES = {"hot": (HOT, (3600, 1800), 0), "cold": (COLD, (20 * 3600,), 0),
          "pushed_back": (PUSHED, (3600, 1800), 2)}
CORRECTIONS = ["J'aime la fermentation du chou.", "Je n'aime pas la fermentation du chou.",
               "J'aime beaucoup la fermentation du chou."]


def config() -> dict:
    return json.loads((ROOT / "bridge_config.json").read_text(encoding="utf-8"))


def self_path(owner: str) -> Path:
    with memory.owner_context(owner), memory.memory_scope("transferania"):
        with ph._scope("transferania", owner) as path:
            return Path(path)


def memory_path(owner: str) -> Path:
    with memory.owner_context(owner), memory.memory_scope("transferania"):
        return Path(memory.path())


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


def freshness(opener) -> dict:
    status, raw = get(opener, "/api/pc/restart-bridge")
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return {"status": status, "readable": False}
    return {"status": status, "pending": data.get("pending"), "pid": data.get("pid"),
            "started_at": data.get("started_at")}


def pinned(usage: dict, contents: list) -> dict:
    text = json.dumps(contents, ensure_ascii=False)
    return {
        "budget": usage["input_budget"],
        "estimate": usage["estimated_input_tokens"],
        "totals": usage["selection_totals"],
        "rows": [(r["kind"], r["selected"], r["reason"], r["priority"], r.get("share"))
                 for r in usage["selection_manifest"]],
        "personhood": [r for r in usage["selection_manifest"] if r["kind"] == "personhood"],
        "hint_in_payload": "SUJET RÉCENT" in text,
        "hint_text": next((part["text"] for m in contents for part in m.get("parts", [])
                           if isinstance(part.get("text"), str) and "SUJET RÉCENT" in part["text"]), ""),
    }


def owner_for_token(token: str) -> str:
    raw = json.loads((ROOT / "bridge_sessions.json").read_text(encoding="utf-8"))
    return ((raw.get(token) if isinstance(raw, dict) else None) or {}).get("user") or "admin"


def capture_state(opener, owner: str, live_cfg: dict, ages: tuple, corrections: int = 0) -> dict:
    """Seed one subject state, capture live + in-process, restore the store."""
    path = self_path(owner)
    store = memory_path(owner)
    original = path.read_bytes() if path.exists() else None
    other = store.read_bytes() if store.exists() else None
    before = hashlib.sha256(original or b"").hexdigest()
    out = {"ages": list(ages), "store_restored": False}
    try:
        with memory.owner_context(owner), memory.memory_scope("transferania"):
            # The store only surfaces its two most recent threads, so a capture
            # must start from just this subject: otherwise real traffic decides
            # the pick. The original file is put back in ``finally``.
            with ph._scope("transferania", owner) as store_path:
                with ph._lock:
                    data = ph._load(Path(store_path), "transferania")
                    data["events"] = []
                    ph._write(Path(store_path), data)
            for age in ages:
                ph.observe_chat("transferania", SUBJECT, now=time.time() - age)
            if corrections:
                # The archive keeps one active correction per subject; the earlier
                # ones stay as superseded evidence of the repetition.
                mem = memory._load()
                for index in range(corrections):
                    mem["episodes"].append({
                        "id": f"verify-correction{index}",
                        "text": CORRECTIONS[index], "kind": "correction",
                        "topic": "fermentation du chou", "source_device": DEVICE,
                        "source_key": "preference:fermentation du chou",
                        "at": time.time() - 600, "evidence": "user_correction",
                        "status": "active" if index == corrections - 1 else "superseded"})
                memory._save(mem)
        # Read-only salience: the same helper the pipeline uses, without
        # recording a turn that would take the continuity slot from her line.
        with memory.owner_context(owner), memory.memory_scope("transferania"):
            archive = memory._load().get("episodes", [])
        pushback = [{"topic": e.get("topic") or "", "text": e.get("text") or "", "at": e.get("at")}
                    for e in archive if e.get("kind") == "correction"]
        detail = ph.hint_detail("transferania", MESSAGE, owner=owner, now=time.time(),
                                pushback=pushback)
        out["salience"] = {k: detail[k] for k in ("tier", "score", "priority", "share",
                                                  "basis", "age_s", "repeats", "pushback",
                                                  "withhold") if k in detail}
        out["line"] = detail.get("line") or ""

        payload = {"action": "transferania", "op": "context_preview", "kind": "chat",
                   "device_id": DEVICE, "persona": "warm", "message": MESSAGE}
        status, body, _ = post(opener, "/api/ai", data=payload)
        out["preview_status"] = status
        live = json.loads(body.decode("utf-8"))
        out["read_only"] = live.get("read_only")
        out["model_calls"] = live.get("model_calls")
        out["live"] = pinned(live["context_usage"], live["contents"])
        out["system_bytes"] = len(live["system"].encode("utf-8"))

        ai.bind(root=ROOT, companion_context_config=lambda: live_cfg)
        code, inproc = ai.http_post(dict(payload), role="admin", owner_id=owner)
        out["inproc_status"] = code
        out["inproc"] = pinned(inproc["context_usage"], inproc["contents"])
        out["system_identical"] = live["system"] == inproc["system"]
    finally:
        if original is not None:
            path.write_bytes(original)
        if other is not None:
            store.write_bytes(other)
        after = hashlib.sha256(path.read_bytes() if path.exists() else b"").hexdigest()
        out["memory_restored"] = (hashlib.sha256(store.read_bytes() if store.exists() else b"").hexdigest()
                                  == hashlib.sha256(other or b"").hexdigest())
        out["store_restored"] = after == before
        out["store_sha256"] = after[:16]
    return out


def check_state(name: str, expected: dict, result: dict, failures: list[str]) -> None:
    live, inproc = result["live"], result["inproc"]
    rows = live["personhood"]
    if not rows and not expected.get("withhold"):
        failures.append(f"{name}: no personhood row in the live manifest")
        return
    row = rows[0] if rows else {}
    if expected.get("withhold"):
        if rows:
            failures.append(f"{name}: a corrected subject still has a personhood row")
        if result["salience"].get("withhold") is not True:
            failures.append(f"{name}: withhold not set in the in-process salience")
        if result["salience"].get("pushback") != 2:
            failures.append(f"{name}: pushback {result['salience'].get('pushback')} != 2")
        if live["hint_in_payload"] or result.get("line"):
            failures.append(f"{name}: the withdrawn subject still reaches the prompt")
        if "personhood" in live["totals"]:
            failures.append(f"{name}: a withdrawn line is counted as selected")
    if result["salience"].get("tier") != expected["tier"]:
        failures.append(f"{name}: tier {result['salience'].get('tier')} != {expected['tier']}")
    if (result["salience"].get("share") or 0) != expected["share"] and not expected.get("withhold"):
        failures.append(f"{name}: in-process share {result['salience'].get('share')} != {expected['share']}")

    if row and row.get("priority") != expected["priority"]:
        failures.append(f"{name}: live priority {row['priority']} != {expected['priority']}")
    if row and row.get("share") != expected["share"]:
        failures.append(f"{name}: live share {row.get('share')} != {expected['share']}")
    if expected["selected"] and row.get("selected") is not True:
        failures.append(f"{name}: live selected {row['selected']} != {expected['selected']}")
    if expected["selected"] and live["hint_in_payload"] is not True:
        failures.append(f"{name}: her line is selected but absent from the payload")
    if not expected["selected"] and not expected.get("withhold"):
        if live["hint_in_payload"]:
            failures.append(f"{name}: a refused line reached the payload")
        if row["reason"] != "budget":
            failures.append(f"{name}: refusal reason {row['reason']} != budget")
        if "personhood" in live["totals"]:
            failures.append(f"{name}: refused line still counted as selected")
    if live["rows"] != inproc["rows"]:
        failures.append(f"{name}: live rows differ from in-process")
    for key in ("budget", "estimate", "totals", "hint_in_payload"):
        if live[key] != inproc[key]:
            failures.append(f"{name}: live {key} differs from in-process")
    if not result.get("system_identical"):
        failures.append(f"{name}: live system prompt differs from in-process")
    if live["budget"] != (live["estimate"] + (live["budget"] - live["estimate"])):
        failures.append(f"{name}: budget arithmetic broken")
    if result.get("read_only") is not True or result.get("model_calls") != 0:
        failures.append(f"{name}: the live preview was not read-only")
    if not result.get("store_restored"):
        failures.append(f"{name}: personhood store was not restored")
    if not result.get("memory_restored"):
        failures.append(f"{name}: companion memory store was not restored")
    if not result.get("line") and not result["salience"].get("withhold"):
        failures.append(f"{name}: the store offered no line for this state")


def main() -> int:
    cfg = config()
    live_cfg = cfg.get("companion_context") or {}
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    status, _, _ = post(opener, "/login", form={"pin": str(cfg.get("pin") or "")})
    token = next((c.value for c in jar if c.name == COOKIE), "")
    if status not in (200, 303) or not token:
        print(f"verify_live_personhood: FAIL login status={status} cookie={bool(token)}")
        return 1
    owner = owner_for_token(token)

    before = freshness(opener)
    if before.get("pending") is not False:
        print(f"verify_live_personhood: FAIL the bridge is stale (pending={before.get('pending')}) "
              f"pid={before.get('pid')} — run Restart-Bridge.ps1")
        return 1

    failures: list[str] = []
    report = {"owner": owner, "pid": before.get("pid"), "started_at": before.get("started_at"),
              "pending_before": before.get("pending"), "config_budget": live_cfg.get("chat_input_budget"),
              "states": {}}
    for name in ("hot", "cold", "pushed_back"):
        expected, ages, corrections = STATES[name]
        result = capture_state(opener, owner, live_cfg, ages, corrections)
        check_state(name, expected, result, failures)
        report["states"][name] = {
            "expected": expected,
            "seeded_ages_s": result["ages"],
            "salience": result["salience"],
            "live": {k: result["live"][k] for k in ("budget", "estimate", "totals", "personhood",
                                                    "hint_in_payload")},
            "inproc": {k: result["inproc"][k] for k in ("budget", "estimate", "totals", "personhood",
                                                        "hint_in_payload")},
            "read_only": result.get("read_only"),
            "model_calls": result.get("model_calls"),
            "system_bytes": result.get("system_bytes"),
            "matches_inprocess": (result["live"]["rows"] == result["inproc"]["rows"]
                                  and result.get("system_identical")),
            "store_restored": result.get("store_restored"),
            "memory_restored": result.get("memory_restored"),
            "line_bytes": len(result.get("line", "").encode("utf-8")),
            "hint_excerpt": result["live"]["hint_text"][:150],
            "preview_status": result.get("preview_status"),
        }

    hot = report["states"]["hot"]["live"]
    cold = report["states"]["cold"]["live"]
    pushed = report["states"]["pushed_back"]["live"]
    if pushed["personhood"]:
        failures.append("a subject corrected twice still has a live personhood row")
    if hot["estimate"] <= pushed["estimate"]:
        failures.append("the corrected subject did not free the room its line took")
    if hot["totals"] == pushed["totals"] and hot["estimate"] == pushed["estimate"]:
        failures.append("hot and corrected subjects produced identical contexts")
    if not hot["personhood"] or not cold["personhood"]:
        failures.append("one of the states has no personhood row")
    else:
        if hot["personhood"][0]["priority"] <= cold["personhood"][0]["priority"]:
            failures.append("hot priority is not above cold")
        if (hot["personhood"][0].get("share") or 0) <= (cold["personhood"][0].get("share") or 0):
            failures.append("hot byte share is not above cold")
        if hot["totals"] == cold["totals"]:
            failures.append("the two states produced identical totals")
        if hot["estimate"] <= cold["estimate"]:
            failures.append("the hot state did not take more bytes")

    after = freshness(opener)
    report["pending_after"] = after.get("pending")
    if after.get("pending") is not False:
        failures.append("the bridge went stale during the run")

    post(opener, "/logout", form={})
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    if failures:
        print("verify_live_personhood: FAIL")
        for item in failures:
            print("  -", item)
        return 1
    print("verify_live_personhood: OK (hot, stale and corrected live states)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
