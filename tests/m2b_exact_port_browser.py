"""Ephemeral browser check for the exact-port launcher.

The page and listener processes are the worktree scripts. Their ports are not
8765 and 8776. A passing result is not the fixed-port proof.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_lifecycle as life  # noqa: E402
import hq_forge_lifecycle_listener as gate  # noqa: E402
import importlib.util  # noqa: E402

_PAGE_SPEC = importlib.util.spec_from_file_location("m2b_exact_port_page", Path(__file__).with_name("m2b_exact_port_page.py"))
page_launcher = importlib.util.module_from_spec(_PAGE_SPEC)
_PAGE_SPEC.loader.exec_module(page_launcher)
PIN = page_launcher.PIN

PYTHON = Path(r"C:\Python313\python.exe")
OUT = Path(r"C:\Transfert-reviews\forge-lifecycle-exact-port\browser-fixture.json")
RESERVED = {7860, 8765, 8776}


def wait_file(path: Path, process: subprocess.Popen, seconds: float = 20) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.is_file():
            return True
        if process.poll() is not None:
            return False
        time.sleep(0.05)
    return path.is_file()


def self_text(tab, previous: str | None = None) -> str:
    for _ in range(50):
        text = tab.locator("#out").inner_text()
        if text and text != previous:
            return text
        tab.wait_for_timeout(100)
    return tab.locator("#out").inner_text()


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="m2b-exact-"))
    page_identity_path = root / "page.json"
    page_stop = root / "page.stop"
    origin_file = root / "origin.txt"
    listener_identity_path = root / "listener.json"
    listener_port_path = root / "listener.port"
    listener_stop = root / "listener.stop"
    report: dict = {
        "production_pair_exercised": False,
        "document_served_from_8765": False,
        "listener_bound_to_8776": False,
        "fixed_port_mode": False,
    }
    page = None
    listener = None
    try:
        page = subprocess.Popen(
            [str(PYTHON), str(SOURCE / "tests" / "m2b_exact_port_page.py"), "--ephemeral", str(page_identity_path), str(page_stop), str(origin_file)],
            cwd=str(SOURCE),
        )
        if not wait_file(page_identity_path, page):
            raise RuntimeError("page process did not start")
        page_identity = json.loads(page_identity_path.read_text(encoding="utf-8"))
        if int(page_identity["port"]) in RESERVED:
            raise RuntimeError("page selected a reserved port")
        origin = f"http://127.0.0.1:{page_identity['port']}"
        listener = subprocess.Popen(
            [
                str(PYTHON),
                str(SOURCE / "tests" / "m2b_exact_port_listener.py"),
                page_identity["sessions"],
                str(Path(page_identity["sessions"]).parent),
                origin,
                str(page_identity["generation"]),
                str(page_identity["pid"]),
                str(page_identity["creation"]),
                str(listener_port_path),
                str(listener_identity_path),
                str(listener_stop),
            ],
            cwd=str(SOURCE),
        )
        if not wait_file(listener_identity_path, listener):
            raise RuntimeError("listener process did not start")
        listener_identity = json.loads(listener_identity_path.read_text(encoding="utf-8"))
        if int(listener_identity["port"]) in RESERVED:
            raise RuntimeError("listener selected a reserved port")
        listener_origin = f"http://127.0.0.1:{listener_identity['port']}"
        origin_file.write_text(listener_origin + "\n", encoding="ascii")
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context()
            login = context.request.post(origin + "/login", form={"pin": PIN}, headers={"Origin": origin}, max_redirects=0)
            if login.status != 303:
                raise RuntimeError("login did not set a session")
            tab = context.new_page()
            tab.goto(origin + "/lifecycle-probe", wait_until="domcontentloaded")
            tab.click("#go")
            report["authenticated_status"] = self_text(tab)
            browser.close()
        report["page_port"] = page_identity["port"]
        report["listener_port"] = listener_identity["port"]
        report["page_executable"] = page_identity["executable"]
        report["listener_executable"] = listener_identity["executable"]
        report["ok"] = report["authenticated_status"] == "200" and report["production_pair_exercised"] is False
    except Exception as exc:
        report["ok"] = False
        report["error_type"] = type(exc).__name__
        message = str(exc).replace(PIN, "<redacted>")
        message = gate._CSRF_RE.sub("<redacted>", message)
        report["error"] = message[:500]
    finally:
        disposable = None
        if page_identity_path.is_file():
            try:
                disposable = Path(json.loads(page_identity_path.read_text(encoding="utf-8"))["sessions"]).parent
            except (OSError, json.JSONDecodeError, KeyError):
                disposable = None
        if disposable is not None:
            record = disposable / "lifecycle.json"
            if record.is_file():
                try:
                    payload = json.loads(record.read_text(encoding="utf-8"))
                    life.harness_stop(int(payload["pid"]), int(payload["creation"]), "cmd.exe")
                except (OSError, json.JSONDecodeError, KeyError, ValueError):
                    pass
        if listener is not None:
            listener_stop.write_text("stop\n", encoding="ascii")
            try:
                listener.wait(timeout=15)
            except subprocess.TimeoutExpired:
                listener.kill()
                listener.wait(timeout=5)
        if page is not None:
            page_stop.write_text("stop\n", encoding="ascii")
            try:
                page.wait(timeout=15)
            except subprocess.TimeoutExpired:
                page.kill()
                page.wait(timeout=5)
        import shutil
        shutil.rmtree(root, ignore_errors=True)
        if disposable is not None:
            shutil.rmtree(disposable, ignore_errors=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": report.get("ok"), "error_type": report.get("error_type"), "error": report.get("error")}))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
