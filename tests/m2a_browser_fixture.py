"""Browser authorization on disposable loopback ports.

This is not the production pair. The HQ page stays on port 8765 and the
lifecycle listener is specified as port 8776. This script refuses those ports.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_lifecycle as life  # noqa: E402

OUT = Path(r"C:\Transfert-reviews\forge-lifecycle-m2a\browser-fixture.json")
RESERVED = {7860, 8765, 8776}


def serve_page(listener_origin: str, connect_src: str) -> tuple[ThreadingHTTPServer, str]:
    html = f"""<!doctype html>
<meta charset="utf-8">
<button id="go" type="button">go</button>
<pre id="out"></pre>
<script>
document.getElementById("go").addEventListener("click", async () => {{
  const out = document.getElementById("out");
  try {{
    const response = await fetch("{listener_origin}/lifecycle/start", {{
      method: "POST",
      credentials: "include",
      headers: {{"Content-Type": "application/json"}},
      body: "{{}}"
    }});
    out.textContent = String(response.status);
  }} catch (error) {{
    out.textContent = "error";
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
                f"default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src {connect_src}",
            )
            self.end_headers()
            self.wfile.write(html)

    for _ in range(5):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = int(server.server_address[1])
        if port not in RESERVED:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            return server, f"http://127.0.0.1:{port}"
        server.server_close()
    raise RuntimeError("no free page port")


def self_text(tab, previous: str | None = None) -> str:
    for _ in range(50):
        text = tab.locator("#out").inner_text()
        if text and text != previous:
            return text
        tab.wait_for_timeout(100)
    return tab.locator("#out").inner_text()


def main() -> int:
    config_path = SOURCE / "bridge_config.json"
    existed = config_path.is_file()
    import iphone_bridge as bridge

    bridge.SESSIONS_PATH = Path(tempfile.mkdtemp(prefix="m2a-sessions-")) / "bridge_sessions.json"
    bridge._SESSIONS.clear()
    bridge.CONFIG["pin"] = "m2a-disposable-pin"
    bridge.CONFIG["users"] = []
    admin = bridge.issue_session("admin", "admin")
    report = {
        "production_pair": {"page": life.PAGE_ORIGIN, "listener": life.LISTENER_ORIGIN},
        "production_pair_exercised": False,
        "document_served_from_8765": False,
        "listener_bound_to_8776": False,
        "fixture_csp_is_not_production_csp": True,
    }
    supervisor = None
    fixture = None
    page = None
    tracked = []
    try:
        from playwright.sync_api import sync_playwright

        root = Path(tempfile.mkdtemp(prefix="m2a-browser-"))
        nonce = "browser" + root.name[-8:]
        supervisor = life.Supervisor(
            root,
            f"Local\\TransfertHQ-M1-{nonce}",
            f"Local\\TransfertHQ-M1-Mutex-{nonce}",
        )
        fixture = life.ActionFixture(supervisor, "http://127.0.0.1:9", None, lambda: "ready", use_hq_session=True)
        if int(fixture.port) in RESERVED:
            raise RuntimeError("listener selected a reserved port")
        listener = f"http://127.0.0.1:{fixture.port}"
        fixture.allowed_origin = "pending"
        page, origin = serve_page(listener, listener)
        fixture.allowed_origin = origin
        blocked_page, blocked_origin = serve_page(listener, "'self'")
        report.update({
            "fixture_page_origin": origin,
            "fixture_listener": listener,
            "csp_blocked_page_origin": blocked_origin,
        })
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context()
            context.add_cookies([{
                "name": "transfert_session",
                "value": admin,
                "url": origin,
                "httpOnly": True,
                "sameSite": "Lax",
            }])
            tab = context.new_page()
            tab.goto(origin + "/", wait_until="domcontentloaded")
            tab.click("#go")
            report["authenticated_status"] = self_text(tab)
            bridge.revoke_session(admin)
            tab.click("#go")
            report["revoked_status"] = self_text(tab, previous=report["authenticated_status"])
            anonymous = browser.new_context()
            anon = anonymous.new_page()
            anon.goto(origin + "/", wait_until="domcontentloaded")
            anon.click("#go")
            report["anonymous_status"] = self_text(anon)
            blocked = browser.new_context()
            blocked.add_cookies([{
                "name": "transfert_session",
                "value": admin,
                "url": blocked_origin,
                "httpOnly": True,
                "sameSite": "Lax",
            }])
            denied = blocked.new_page()
            denied.goto(blocked_origin + "/", wait_until="domcontentloaded")
            before = len(fixture.calls)
            denied.click("#go")
            report["csp_self_status"] = self_text(denied)
            report["csp_self_new_calls"] = len(fixture.calls) - before
            browser.close()
        record_path = root / "lifecycle.json"
        if record_path.is_file():
            record = json.loads(record_path.read_text(encoding="utf-8"))
            if "pid" in record and "creation" in record:
                tracked.append((int(record["pid"]), int(record["creation"]), "cmd.exe"))
                report["sleeper_alive_after_start"] = life.process_alive(int(record["pid"]))
        report["listener_log_contains_session"] = admin in json.dumps(fixture.calls)
        report["ok"] = (
            report["authenticated_status"] == "200"
            and report["revoked_status"] == "401"
            and report["anonymous_status"] == "401"
            and report["csp_self_status"] == "error"
            and report["csp_self_new_calls"] == 0
            and report["listener_log_contains_session"] is False
        )
    except Exception as exc:
        report["ok"] = False
        report["error_type"] = type(exc).__name__
        message = str(exc)
        if "m2a-disposable-pin" in message or (admin and admin in message):
            message = "<redacted>"
        report["error"] = message[:500]
    finally:
        if fixture is not None:
            fixture.close()
        if page is not None:
            page.shutdown()
            page.server_close()
        if "blocked_page" in locals() and blocked_page is not None:
            blocked_page.shutdown()
            blocked_page.server_close()
        if supervisor is not None:
            supervisor.terminate_if_proven()
            supervisor.close_supervisor_handles()
        for pid, creation, suffix in tracked:
            life.harness_stop(pid, creation, suffix)
        bridge.SESSIONS_PATH = SOURCE / "bridge_sessions.json"
        bridge._SESSIONS.clear()
        if not existed and config_path.is_file():
            config_path.unlink()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in report if key != "error_type" or True}))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
