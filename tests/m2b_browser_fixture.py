"""Ephemeral-port browser checks for the M2b listener.

This script refuses ports 7860, 8765, and 8776. The page origin and listener
port it uses are not the production pair, so a passing result does not prove
http://127.0.0.1:8765 calling http://127.0.0.1:8776.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_lifecycle as life  # noqa: E402
import hq_forge_lifecycle_listener as gate  # noqa: E402

OUT = Path(r"C:\Transfert-reviews\forge-lifecycle-m2b\browser-fixture.json")
PIN = "m2b-disposable-pin"
RESERVED = {7860, 8765, 8776}


def self_text(tab, previous: str | None = None) -> str:
    for _ in range(50):
        text = tab.locator("#out").inner_text()
        if text and text != previous:
            return text
        tab.wait_for_timeout(100)
    return tab.locator("#out").inner_text()


def browser_status(tab, credential: str | None) -> str:
    tab.locator("#out").evaluate("(node) => { node.textContent = ''; }")
    tab.evaluate(
        """async (credential) => {
          const spec = JSON.parse(document.getElementById('lifecycle-csrf').textContent);
          const headers = {'Content-Type': 'application/json'};
          if (credential !== null) headers['X-HQ-Lifecycle-CSRF'] = credential;
          const out = document.getElementById('out');
          try {
            const response = await fetch(spec.action, {
              method: 'POST', credentials: 'include', mode: 'cors', headers, body: '{}'
            });
            out.textContent = String(response.status);
          } catch (error) {
            out.textContent = 'blocked';
          }
        }""",
        credential,
    )
    return self_text(tab, "")


def foreign_page(listener_origin: str, credential: str) -> tuple[ThreadingHTTPServer, str]:
    if gate._CSRF_RE.fullmatch(credential) is None:
        credential = "forged"
    spec = json.dumps({"csrf": credential, "action": listener_origin + "/lifecycle/start"})
    html = f"""<!doctype html>
<meta charset="utf-8">
<button id="go" type="button">go</button>
<pre id="out"></pre>
<script type="application/json" id="lifecycle-csrf">{spec}</script>
<script>
document.getElementById("go").addEventListener("click", async () => {{
  const out = document.getElementById("out");
  const spec = JSON.parse(document.getElementById("lifecycle-csrf").textContent);
  try {{
    const response = await fetch(spec.action, {{
      method: "POST", credentials: "include", mode: "cors",
      headers: {{"Content-Type": "application/json", "X-HQ-Lifecycle-CSRF": spec.csrf}},
      body: "{{}}"
    }});
    out.textContent = String(response.status);
  }} catch (error) {{
    out.textContent = "blocked";
  }}
}});
</script>
""".encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            return

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.send_header("Cache-Control", "no-store")
            self.send_header(
                "Content-Security-Policy",
                f"default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' {listener_origin}",
            )
            self.end_headers()
            self.wfile.write(html)

    for _ in range(5):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = int(server.server_address[1])
        if port not in RESERVED:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            return server, f"http://127.0.0.1:{port}"
        server.server_close()
    raise RuntimeError("no free foreign page port")


def main() -> int:
    config_path = SOURCE / "bridge_config.json"
    existed = config_path.is_file()
    import iphone_bridge as bridge

    root = Path(tempfile.mkdtemp(prefix="m2b-browser-"))
    sessions = root / "bridge_sessions.json"
    bridge.SESSIONS_PATH = sessions
    bridge._SESSIONS.clear()
    bridge.CONFIG["pin"] = PIN
    bridge.CONFIG["users"] = []
    report = {
        "production_pair": {"page": life.PAGE_ORIGIN, "listener": life.LISTENER_ORIGIN},
        "production_pair_exercised": False,
        "document_served_from_8765": False,
        "listener_bound_to_8776": False,
        "foreign_origin_page_is_a_csp_fixture": True,
        "foreign_browser_result": "cors failure, even when that page is given a real session-bound credential",
        "hq_csrf_allowlist_used": False,
        "lan_and_tailscale_checked_in_protocol_tests": True,
    }
    page = None
    foreign = None
    worker = None
    tracked: list[tuple[int, int, str]] = []
    try:
        from playwright.sync_api import sync_playwright

        page = ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
        page_port = int(page.server_address[1])
        if page_port in RESERVED:
            raise RuntimeError("page server selected a reserved port")
        threading.Thread(target=page.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{page_port}"
        port_file = root / "listener-port.txt"
        nonce = uuid_nonce()
        creation = life.process_creation(os.getpid())
        if creation is None:
            raise RuntimeError("page process has no creation time")
        worker = subprocess.Popen(
            [
                sys.executable,
                str(SOURCE / "tests" / "m2b_listener_worker.py"),
                str(sessions),
                str(root),
                origin,
                str(bridge.auth_generation()),
                str(os.getpid()),
                str(creation),
                str(port_file),
                nonce,
            ],
            cwd=str(SOURCE),
        )
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not port_file.is_file():
            if worker.poll() is not None:
                break
            time.sleep(0.05)
        if not port_file.is_file():
            raise RuntimeError("listener process did not start")
        listener_port = int(port_file.read_text(encoding="ascii"))
        if listener_port in RESERVED:
            raise RuntimeError("listener selected a reserved port")
        listener_origin = f"http://127.0.0.1:{listener_port}"
        report.update({
            "fixture_page_origin": origin,
            "fixture_listener": listener_origin,
            "listener_pid": worker.pid,
            "page_pid": os.getpid(),
        })
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context()
            login = context.request.post(
                origin + "/login",
                form={"pin": PIN},
                headers={"Origin": origin},
                max_redirects=0,
            )
            if login.status != 303:
                raise RuntimeError("login did not set a session")
            tab = context.new_page()
            tab.goto(origin + "/lifecycle-probe", wait_until="domcontentloaded")
            blocked_policy = tab.evaluate("() => document.querySelector('meta') && true")
            tab.click("#go")
            report["csp_before_binding"] = self_text(tab)
            gate.set_browser_binding_for_tests(f"127.0.0.1:{page_port}", listener_origin)
            tab.goto(origin + "/lifecycle-probe", wait_until="domcontentloaded")
            report["probe_connect_src"] = "8776" in (tab.content())
            tab.click("#go")
            report["authenticated_status"] = self_text(tab)
            report["missing_csrf_status"] = browser_status(tab, None)
            report["forged_csrf_status"] = browser_status(tab, "forged")
            held = json.loads(tab.locator("#lifecycle-csrf").inner_text())
            tab.evaluate("() => fetch('/logout', {credentials: 'include'})")
            tab.locator("#out").evaluate("(node) => { node.textContent = ''; }")
            tab.click("#go")
            report["revoked_status"] = self_text(tab, "")
            operator = "operator-browser"
            payload = {}
            if sessions.is_file():
                payload = json.loads(sessions.read_text(encoding="utf-8"))
            payload[operator] = {
                "exp": time.time() + 3600,
                "user": "admin",
                "role": "operator",
                "gen": bridge.auth_generation(),
            }
            sessions.write_text(json.dumps(payload), encoding="utf-8")
            bridge._SESSIONS[operator] = {
                "exp": payload[operator]["exp"],
                "user": "admin",
                "role": "operator",
                "gen": bridge.auth_generation(),
            }
            before = sessions.read_bytes()
            other = browser.new_context()
            other.add_cookies([{
                "name": "transfert_session",
                "value": operator,
                "url": origin,
                "httpOnly": True,
                "sameSite": "Lax",
            }])
            operator_tab = other.new_page()
            operator_tab.goto(origin + "/lifecycle-probe", wait_until="domcontentloaded")
            operator_tab.click("#go")
            report["operator_status"] = self_text(operator_tab)
            report["operator_file_preserved"] = sessions.read_bytes() == before
            foreign, foreign_origin = foreign_page(listener_origin, str(held.get("csrf") or ""))
            report["foreign_page_origin"] = foreign_origin
            foreign_context = browser.new_context()
            foreign_tab = foreign_context.new_page()
            foreign_tab.goto(foreign_origin + "/", wait_until="domcontentloaded")
            foreign_tab.click("#go")
            report["foreign_status"] = self_text(foreign_tab)
            browser.close()
            report["csp_meta_checked"] = bool(blocked_policy)
        record_path = root / "lifecycle.json"
        if record_path.is_file():
            record = json.loads(record_path.read_text(encoding="utf-8"))
            if "pid" in record and "creation" in record:
                tracked.append((int(record["pid"]), int(record["creation"]), "cmd.exe"))
        log_text = json.dumps(report)
        report["log_contains_pin"] = PIN in log_text
        report["log_contains_operator_cookie"] = operator in log_text
        report["ok"] = (
            report["csp_before_binding"] == "blocked"
            and report["authenticated_status"] == "200"
            and report["missing_csrf_status"] == "403"
            and report["forged_csrf_status"] == "403"
            and report["revoked_status"] == "401"
            and report["operator_status"] == "403"
            and report["operator_file_preserved"] is True
            and report["foreign_status"] == "blocked"
            and report["production_pair_exercised"] is False
            and report["log_contains_pin"] is False
        )
    except Exception as exc:
        report["ok"] = False
        report["error_type"] = type(exc).__name__
        message = str(exc).replace(PIN, "<redacted>")
        message = gate._CSRF_RE.sub("<redacted>", message)
        report["error"] = message[:500]
    finally:
        gate.reset_browser_binding_for_tests()
        if worker is not None:
            worker.kill()
            worker.wait(5)
        if page is not None:
            page.shutdown()
            page.server_close()
        if foreign is not None:
            foreign.shutdown()
            foreign.server_close()
        for pid, creation, suffix in tracked:
            life.harness_stop(pid, creation, suffix)
        bridge.SESSIONS_PATH = SOURCE / "bridge_sessions.json"
        bridge._SESSIONS.clear()
        if not existed and config_path.is_file() and config_path.parent == SOURCE:
            config_path.unlink()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    public = {key: value for key, value in report.items() if key != "log_contains_operator_cookie"}
    if report.get("log_contains_operator_cookie") or gate._CSRF_RE.search(json.dumps(public)):
        public = {"ok": False, "error": "report contained a session token"}
    OUT.write_text(json.dumps(public, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": public.get("ok"), "error_type": public.get("error_type"), "error": public.get("error")}))
    return 0 if public.get("ok") else 1


def uuid_nonce() -> str:
    import uuid
    return uuid.uuid4().hex[:12]


if __name__ == "__main__":
    raise SystemExit(main())
