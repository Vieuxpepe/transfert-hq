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
    if os.environ.get("HQ_FORGE_MOCK") == "ready":
        import base64
        import io
        from PIL import Image
        import hq_forge as forge_client

        image = Image.new("RGB", (256, 256), (24, 72, 48))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")

        def forge_transport(method, url, timeout, body=None):
            path = url.split("://", 1)[-1]
            path = path[path.find("/"):].split("?", 1)[0]
            if method == "POST" and body is not None and "mock-fail" in (body.decode("utf-8", "replace") if isinstance(body, (bytes, bytearray)) else json.dumps(body)):
                return 500, b'{"error": "mock failure"}'
            if method == "POST":
                payload = {"images": [encoded], "info": "{\"seed\": 4, \"all_seeds\": [4]}"}
                return 200, json.dumps(payload).encode("utf-8")
            table = {
                "/sdapi/v1/samplers": [{"name": "Euler"}],
                "/sdapi/v1/schedulers": [{"name": "automatic", "label": "Automatic"}],
                "/sdapi/v1/upscalers": [{"name": "R-ESRGAN 4x+"}, {"name": "None"}],
                "/sdapi/v1/sd-models": [{"title": "example.safetensors [abcd]", "model_name": "example", "hash": "abcd", "sha256": None}],
                "/sdapi/v1/options": {"sd_model_checkpoint": "example.safetensors"},
                "/sdapi/v1/progress": {"progress": 0, "state": {"job": "", "job_count": 0, "sampling_step": 0, "sampling_steps": 0}},
                "/internal/pending-tasks": {"size": 0, "tasks": []},
            }
            if path not in table:
                return 404, b"{}"
            return 200, json.dumps(table[path]).encode("utf-8")

        forge_client.set_transport_for_tests(forge_transport)
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
