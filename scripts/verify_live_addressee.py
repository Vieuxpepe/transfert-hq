"""Drive the live bridge chat routes and print what each woman actually answered.

No ``addressee`` is passed anywhere: the bridge calls ``hq_culinia.http_post`` and
``hq_pistonia.message`` exactly as the UI does, and the reply path derives who is
speaking from the turn itself. Used to hear the two halves of one shared secret
side by side, plus a Master turn and a pair that shares nothing.

    python -X utf8 scripts/verify_live_addressee.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:8765"

CULINIA_TURN = ("Pistonia, à Culinia : « La salle est calme et le Maître rentre tard. "
                "Réponds-moi, à moi et pas à lui : as-tu de quoi le nourrir ce soir ? »")
PISTONIA_TURN = ("Culinia, à Pistonia : « La cuisine est vide et le Maître rentre fatigué. "
                 "Réponds-moi, à moi et pas à lui : que surveilles-tu pendant qu'il se repose ? »")
MASTER_TURN = "Comment va la machine ce soir ?"
STRANGER_TURN = "Forgia, à Pistonia : « Le four tient de mon côté, et toi ? »"


def _admin_token() -> str:
    sessions = json.loads((ROOT / "bridge_sessions.json").read_text(encoding="utf-8"))
    rows = [(entry.get("last_active", 0), key) for key, entry in sessions.items()
            if isinstance(entry, dict) and entry.get("user") == "Administrateur" and entry.get("role") == "admin"]
    if not rows:
        raise SystemExit("no admin session")
    return sorted(rows)[-1][1]


def _csrf(token: str) -> str:
    sys.path.insert(0, str(ROOT))
    import hq_forge_lifecycle_listener as lifecycle
    return lifecycle.mint_csrf_for_session(ROOT / "bridge_sessions.json", token)


def _post(path: str, body: dict, token: str, csrf: str) -> dict:
    request = urllib.request.Request(
        BASE + path, method="POST",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Cookie": f"transfert_session={token}",
                 "X-CSRF-Token": csrf, "Origin": BASE})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", "replace")
        try:
            data = json.loads(payload)
        except ValueError:
            data = {"error": payload[:200]}
        if exc.code == 429:
            time.sleep(32)
            return _post(path, body, token, csrf)
        data["_status"] = exc.code
        return data


def _reply(payload: dict) -> str:
    for key in ("reply", "text", "message"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return json.dumps(payload, ensure_ascii=False)[:300]


def banter(host: str = "culinia", visitor: str = "pistonia", shape: str = "checkin") -> dict:
    """The sister-visit UI's own generation route, exactly as the browser calls it."""
    token = _admin_token()
    csrf = _csrf(token)
    payload = _post("/api/assistant-visit-banter",
                    {"host": host, "visitor": visitor, "shape": shape, "place": "hq"},
                    token, csrf)
    names = {host: host.capitalize(), visitor: visitor.capitalize()}
    print(f"\n=== sister-visit banter  host={host} visitor={visitor} shape={shape}")
    print(f"provider: {payload.get('provider') or '-'}   ok: {payload.get('ok')}   code: {payload.get('code') or '-'}")
    for line in payload.get("lines") or []:
        who = names.get(str(line.get("who")), str(line.get("who")))
        print(f"{who:9} {line.get('text')}")
    target = ROOT / "live-visit.json"
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def main() -> int:
    if "--banter" in sys.argv:
        banter()
        return 0
    token = _admin_token()
    csrf = _csrf(token)
    cases = [
        ("Culinia answers Pistonia  (POST /api/culinia/chat)", "/api/culinia/chat",
         {"message": CULINIA_TURN}),
        ("Pistonia answers Culinia  (POST /api/engine/pistonia/message)",
         "/api/engine/pistonia/message", {"text": PISTONIA_TURN}),
        ("Pistonia, Master turn     (POST /api/engine/pistonia/message)",
         "/api/engine/pistonia/message", {"text": MASTER_TURN}),
        ("Pistonia, no-secret pair  (POST /api/engine/pistonia/message)",
         "/api/engine/pistonia/message", {"text": STRANGER_TURN}),
    ]
    out = {}
    for label, path, body in cases:
        payload = _post(path, body, token, csrf)
        text = _reply(payload)
        out[label] = text
        print(f"\n=== {label}\n{text}")
        time.sleep(22)                      # Pistonia's own rate limit
    target = ROOT / "live-addressee.json"
    target.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
