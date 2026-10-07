"""Phase 15 — deterministic post-deploy smoke for the Transfert HQ bridge. Stdlib only, offline, Windows-friendly.

    set HQ_SMOKE_PIN=<admin PIN>            (PIN comes from the environment, never from argv, never printed)
    py -3 tools\\smoke_deploy.py --base http://127.0.0.1:8765 --expect-sha <40-hex or 7+ prefix>

Read-only against real data. The ONLY write is the diagnostics write probe, which creates and removes one temporary file under
``.hq-carnet/diagnostics/`` and never touches a Carnet record. Exit 0 = every required check passed, 1 = any FAIL, 2 = usage /
cannot reach the bridge. ``WARN`` never fails the run unless ``--strict``.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

RESULTS: list[tuple[str, str, str]] = []


def say(level: str, name: str, detail: str = "") -> None:
    RESULTS.append((level, name, detail))
    print(f"{level:<5} {name}" + (f" - {detail}" if detail else ""), flush=True)


class Session:
    def __init__(self, base: str, timeout: float) -> None:
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.jar = http.cookiejar.CookieJar()

        class _NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):  # the login 303 is inspected, not followed
                return None

        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), _NoRedirect)

    def call(self, path: str, method: str = "GET", data: bytes | None = None, headers: dict | None = None, auth: bool = True):
        h = {"Origin": self.base}
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        opener = self.opener if auth else urllib.request.build_opener(_NoRedirectOnly())
        try:
            with opener.open(req, timeout=self.timeout) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()


class _NoRedirectOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def jbody(raw: bytes):
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def run(args: argparse.Namespace) -> int:
    started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    pin = os.environ.get("HQ_SMOKE_PIN", "")
    if not pin:
        print("FAIL  usage - set HQ_SMOKE_PIN in the environment (never pass it as an argument)")
        return 2
    s = Session(args.base, args.timeout)
    try:
        st, _h, _b = s.call("/api/diag/live", auth=False)
    except Exception as e:
        print(f"FAIL  reach_bridge - {type(e).__name__}")
        return 2
    say("PASS" if st == 401 else "FAIL", "diagnostics_require_login", f"unauthenticated /api/diag/live -> {st} (expected 401)")

    try:
        st, hdr, _b = s.call("/login", "POST", ("pin=" + urllib.parse.quote(pin)).encode(), {"Content-Type": "application/x-www-form-urlencoded"})
    except Exception as e:
        say("FAIL", "admin_login", type(e).__name__)
        return summary(args)
    if st != 303 or not any(c.name for c in s.jar):
        say("FAIL", "admin_login", f"login -> {st} (expected 303 + session cookie)")
        return summary(args)
    say("PASS", "admin_login", "303 + session cookie")

    st, _h, b = s.call("/api/diag/live")
    j = jbody(b) or {}
    say("PASS" if st == 200 and j.get("status") == "alive" else "FAIL", "liveness", f"{st} {j.get('status')}")

    st, _h, b = s.call("/api/health")
    j = jbody(b) or {}
    say("PASS" if st == 200 and "uptime_sec" in j else "FAIL", "legacy_health", f"{st}")

    st, _h, b = s.call("/api/diag/ready")
    j = jbody(b) or {}
    if st == 200 and j.get("status") == "ready":
        say("PASS", "readiness", "ready")
    elif st == 200 and j.get("status") == "degraded":
        say("WARN", "readiness", j.get("summary", "degraded"))
    else:
        say("FAIL", "readiness", f"{st} {j.get('summary', '')}")
    for k, v in (j.get("checks") or {}).items():
        if v.get("status") in ("unavailable", "error"):
            say("WARN" if k not in ("config", "data_root", "carnet_dir", "static_assets", "modules") else "FAIL", f"readiness.{k}", v.get("detail", ""))

    q = "/api/diag/info" + ("?expect=" + urllib.parse.quote(args.expect_sha) if args.expect_sha else "")
    st, _h, b = s.call(q)
    j = jbody(b) or {}
    if st != 200:
        say("FAIL", "identity", f"{st}")
    elif args.expect_sha:
        m = (j.get("expected") or {}).get("matches")
        say("PASS" if m is True else "FAIL", "expected_sha", f"running={str(j.get('build_sha'))[:12]} expected={args.expect_sha[:12]} matches={m}")
    else:
        say("WARN", "expected_sha", f"not supplied (running={str(j.get('build_sha'))[:12]})")
    if st == 200:
        rp = j.get("restart_pending")
        say("FAIL" if rp is True else ("PASS" if rp is False else "WARN"), "no_restart_pending", f"checkout_sha={str(j.get('checkout_sha'))[:12]} restart_pending={rp}")

    for path, kind in (("/assets/hq-carnet.js", "javascript"), ("/assets/hq-carnet.css", "css"), ("/assets/hq-diagnostics.js", "javascript")):
        st, h, b = s.call(path)
        ctype = (h.get("Content-Type") or h.get("content-type") or "").lower()
        ok = st == 200 and len(b) > 100 and kind in ctype
        say("PASS" if ok else "FAIL", "asset " + path.rsplit("/", 1)[-1], f"{st} {len(b)} bytes {ctype.split(';')[0]}")

    st, _h, b = s.call("/api/carnet")
    j = jbody(b)
    ok = st == 200 and isinstance(j, dict) and "error" not in j
    say("PASS" if ok else "FAIL", "carnet_read", f"{st}" + (f" pages={len(j.get('pages', []))}" if ok and isinstance(j.get("pages"), list) else ""))

    st, _h, b = s.call("/api/carnet/reader-pdf")
    j = jbody(b) or {}
    say("PASS" if 400 <= st < 500 and st not in (401, 403) and j.get("code") else "FAIL", "reader_route", f"no-identity request -> {st} {j.get('code', '')} (a structured refusal proves the route logic runs)")

    st, _h, b = s.call("/api/diag/subsystems")
    j = jbody(b) or {}
    if st != 200:
        say("FAIL", "subsystems", f"{st}")
    else:
        for name, v in sorted((j.get("subsystems") or {}).items()):
            req = name in ("carnet_read", "reader", "static_assets", "ask_search")
            if v.get("status") in ("error", "unavailable"):
                say("FAIL" if req or v.get("status") == "error" else "WARN", f"subsystem.{name}", f"{v.get('status')} {v.get('detail')}")
        say("PASS", "subsystems", " ".join(f"{k}={n}" for k, n in sorted((j.get("counts") or {}).items())))

    st, _h, b = s.call("/api/diag/write-probe", "POST", b"{}", {"Content-Type": "application/json"})
    j = jbody(b) or {}
    say("PASS" if st == 200 and j.get("status") == "ok" else "FAIL", "write_probe", f"{st} status={j.get('status')} failed_step={j.get('failed_step')}")

    st, _h, b = s.call("/api/diag/errors?limit=100")
    j = jbody(b) or {}
    recent = [e for e in (j.get("errors") or []) if str(e.get("at", "")) >= started and isinstance(e.get("status"), int) and e["status"] >= 500]
    say("PASS" if st == 200 and not recent else "FAIL", "no_server_errors_during_smoke", f"{len(recent)} 5xx recorded since {started}")
    return summary(args)


def summary(args: argparse.Namespace) -> int:
    fails = [r for r in RESULTS if r[0] == "FAIL"]
    warns = [r for r in RESULTS if r[0] == "WARN"]
    bad = bool(fails) or (args.strict and bool(warns))
    print(f"RESULT: {'FAIL' if bad else 'PASS'} ({len(fails)} fail, {len(warns)} warn, {sum(1 for r in RESULTS if r[0] == 'PASS')} pass)")
    return 1 if bad else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--base", default="http://127.0.0.1:8765")
    ap.add_argument("--expect-sha", default="", help="expected deployed commit (7-40 hex)")
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--strict", action="store_true", help="treat WARN as failure")
    a = ap.parse_args(argv)
    if a.expect_sha and not re.fullmatch(r"[0-9a-fA-F]{7,40}", a.expect_sha):
        print("FAIL  usage - --expect-sha must be 7-40 hex characters")
        return 2
    a.expect_sha = a.expect_sha.lower()
    if not re.match(r"^https?://", a.base):
        print("FAIL  usage - --base must be http(s)://host:port")
        return 2
    return run(a)


if __name__ == "__main__":
    sys.exit(main())
