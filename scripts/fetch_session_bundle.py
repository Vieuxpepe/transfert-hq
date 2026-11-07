#!/usr/bin/env python3
"""Fetch admin GET /api/diag/session-bundle and print or save JSON.

Example:
  python scripts/fetch_session_bundle.py --pin 424242 --base http://127.0.0.1:8765 -o bundle.json
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def login(base: str, pin: str) -> urllib.request.OpenerDirector:
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)
    data = ("pin=" + pin).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + "/login",
        data=data,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": base.rstrip("/")},
    )
    try:
        with op.open(req, timeout=30) as resp:
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
        e.close()
    if status != 303:
        raise SystemExit(f"login failed: HTTP {status}")
    return op


def fetch_bundle(base: str, pin: str, limit: int, *, brief: bool = False, session_id: str = "") -> dict:
    op = login(base, pin)
    path = "/api/diag/agent-brief" if brief else "/api/diag/session-bundle"
    url = base.rstrip("/") + f"{path}?limit={int(limit)}"
    sid = (session_id or "").strip()
    if sid:
        url += "&session_id=" + urllib.parse.quote(sid, safe="")
    req = urllib.request.Request(url, method="GET", headers={"Origin": base.rstrip("/")})
    try:
        with op.open(req, timeout=60) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"session-bundle HTTP {e.code}: {body[:400]}") from e
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError as e:
        raise SystemExit("session-bundle response is not JSON") from e


def main() -> None:
    p = argparse.ArgumentParser(description="Download HQ session-bundle (admin PIN required).")
    p.add_argument("--base", default="http://127.0.0.1:8765", help="Bridge base URL (default: %(default)s)")
    p.add_argument("--pin", required=True, help="Admin PIN for /login")
    p.add_argument("--limit", type=int, default=50, help="Tail limit (default: %(default)s)")
    p.add_argument(
        "--session-id",
        dest="session_id",
        default="",
        help="Filter client log tail to this browser session (optional)",
    )
    p.add_argument("--brief", action="store_true", help="Use GET /api/diag/agent-brief (triage + brief_md)")
    p.add_argument("-o", "--output", help="Write JSON to this file instead of stdout")
    p.add_argument("--md", action="store_true", help="With --brief, print brief_md to stdout instead of JSON")
    p.add_argument(
        "--packet",
        action="store_true",
        help="With --brief, print packet_md (brief + config_effective + request_id_index appendix)",
    )
    args = p.parse_args()
    payload = fetch_bundle(args.base, args.pin, args.limit, brief=args.brief, session_id=args.session_id)
    if args.brief and args.packet and isinstance(payload.get("packet_md"), str):
        text = payload["packet_md"] + "\n"
    elif args.brief and args.md and isinstance(payload.get("brief_md"), str):
        text = payload["brief_md"] + "\n"
    else:
        text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(args.output, file=sys.stderr)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
