"""Throwaway loopback HQ for Node/Playwright Carnet browser checks (no live root, fake PINs).

    python tests/carnet_test_server.py <fresh-empty-root-dir> [notebook-seed.json]

Prints one JSON line {"base": "http://127.0.0.1:PORT", "admin_pin": ..., "upload_pin": ...} then serves
until killed. The root is a temp directory chosen by the caller; assets are copied into it (the bridge
serves /assets from ROOT). Never run this against the live Transfert root.
"""
import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    if any(root.iterdir()):
        raise SystemExit("root must be an empty temp directory")
    import iphone_bridge as B

    for name in ("Inbox", "Uni", "Print"):
        (root / name).mkdir()
    shutil.copytree(SOURCE / "assets", root / "assets")
    B.ROOT = root
    B.SESSIONS_PATH = root / "bridge_sessions.json"
    B.CONFIG.update({
        "pin": "", "discord_webhook_url": "", "push_enabled": False,
        "users": [{"name": "admin-test", "pin": "424242", "role": "admin"}, {"name": "upload-test", "pin": "111111", "role": "upload"}],
    })
    engine = os.environ.get("CARNET_TEST_ENGINE")
    if engine:
        # Phase 4: a FAKE transcription engine (never a real model): ok | empty | fail | slow. Lives outside the empty root.
        eng_dir = Path(tempfile.mkdtemp(prefix="hq-fake-engine-"))
        script = eng_dir / "fake_engine.py"
        script.write_text(
            "import sys, time\n"
            "mode = %r\n"
            "if mode == 'fail':\n    sys.exit(3)\n"
            "if mode == 'slow':\n    time.sleep(4)\n"
            "if mode == 'empty':\n    sys.exit(0)\n"
            "sys.stdout.write('Premier paragraphe dicté.\\nDeuxième ligne de la note.')\n" % engine,
            encoding="utf-8",
        )
        B.CONFIG["transcribe_command"] = [sys.executable, str(script), "{input}"]
    B.bind_cc_ext()
    B.bind_hq()
    if len(sys.argv) > 2:
        nb = root / ".hq-carnet" / "notebook.json"
        nb.parent.mkdir(parents=True, exist_ok=True)
        nb.write_text(Path(sys.argv[2]).read_text(encoding="utf-8"), encoding="utf-8")

    class Quiet(B.Handler):
        def log_message(self, *_a):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
    print(json.dumps({"base": f"http://127.0.0.1:{httpd.server_address[1]}", "admin_pin": "424242", "upload_pin": "111111"}), flush=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        sys.stdin.read()  # exits when the parent closes stdin
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
