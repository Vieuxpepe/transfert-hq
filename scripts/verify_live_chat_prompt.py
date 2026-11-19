"""Confirm the running bridge serves the current chat contracts (read-only).

Calls the admin-only ``context_preview`` op over HTTP: it assembles the outgoing
payload exactly as chat would and calls no model. Prints only probe results and
byte counts — never the PIN, the prompt or any memory text.

The PIN comes from ``bridge_config.json`` (``pin``) so it never appears on a
command line or in this chat; ``--pin-file`` accepts a one-line file instead.

  python scripts/verify_live_chat_prompt.py
  python scripts/verify_live_chat_prompt.py --base http://127.0.0.1:8765
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

WARM_PROBES = (
    ("warm chat contract", "une réplique, jamais un compte rendu"),
    ("social shape", "FORME : réagis avant d'informer"),
    ("closing restraint", "slogan ni question finale systématique"),
)
DEVICE = "hqverifydevice01"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


def _login(base: str, pin: str) -> urllib.request.OpenerDirector:
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), _NoRedirect)
    req = urllib.request.Request(
        base.rstrip("/") + "/login",
        data=("pin=" + pin).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": base.rstrip("/")},
    )
    try:
        with op.open(req, timeout=20) as resp:
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
        e.close()
    if status not in (302, 303):
        raise SystemExit(f"login failed: HTTP {status}")
    return op


def _preview(op: urllib.request.OpenerDirector, base: str, message: str) -> tuple[int, dict]:
    body = json.dumps({"action": "transferania", "op": "context_preview", "kind": "chat",
                       "device_id": DEVICE, "persona": "warm", "message": message}).encode("utf-8")
    req = urllib.request.Request(base.rstrip("/") + "/api/ai", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Origin": base.rstrip("/")})
    try:
        with op.open(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode("utf-8", "replace")[:200]}


def _pin_from(path: Path) -> str:
    data = json.loads(path.read_text(encoding="utf-8"))
    pin = str(data.get("pin") or "").strip()
    if not pin:
        raise SystemExit(f"no 'pin' in {path.name}")
    return pin


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8765")
    parser.add_argument("--pin-file", type=Path, default=ROOT / "bridge_config.json")
    args = parser.parse_args()
    pin = _pin_from(args.pin_file) if args.pin_file.name.endswith(".json") else args.pin_file.read_text("utf-8").strip()
    op = _login(args.base, pin)

    code, warm = _preview(op, args.base, "Salut, ça va ?")
    if code != 200:
        raise SystemExit(f"context_preview HTTP {code}: {warm.get('error', '')}")
    warm_blob = json.dumps(warm, ensure_ascii=False)
    failed = False
    for label, probe in WARM_PROBES:
        hit = probe in warm_blob
        failed |= not hit
        print(("HIT  " if hit else "MISS ") + label + f" — « {probe} »")
    code, comfort = _preview(op, args.base, "Je me sens débordé ce soir.")
    if code != 200:
        raise SystemExit(f"context_preview HTTP {code}: {comfort.get('error', '')}")
    comfort_blob = json.dumps(comfort, ensure_ascii=False)
    scoped = "FORME :" not in comfort_blob
    failed |= not scoped
    print(("HIT  " if scoped else "MISS ") + "comfort turn stays unadorned (no FORME block)")
    print(f"running payload: warm {len(warm_blob.encode())} B, comfort {len(comfort_blob.encode())} B, model calls 0")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
