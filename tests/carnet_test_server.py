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
    if httpd.server_address[1] in (8765, 8766, 8776, 7860):
        raise SystemExit("refusing a production port")
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    fleet = os.environ.get("HQ_FORGE_FLEET_MOCK")
    sims = []
    if fleet:
        # Simulated generation PCs: real hq_forge_worker clients over loopback HTTP, each with its own mock Forge.
        sys.path.insert(0, str(SOURCE / "tests"))
        import hq_forge_fleet
        import hq_forge_worker
        from forge_fleet_mocks import MockForge, SimWorker

        hq_forge_worker.POLL_SEC, hq_forge_worker.IDLE_MAX_SEC, hq_forge_worker.PROGRESS_SEC = 0.3, 0.6, 0.4
        hq_forge_fleet.bind(root)
        delay = float(os.environ.get("HQ_FORGE_FLEET_DELAY", "1.2"))
        specs = [
            ("PC salon", {"gpus": [{"name": "NVIDIA GeForce RTX 4070", "vram_mb": 12282, "source": "nvidia-smi"}], "cpu": "AMD Ryzen 7 7700X", "ram_mb": 32695, "os": "Windows 11"}, {}),
            ("Portable", {"gpus": [{"name": "Intel(R) Iris(R) Xe Graphics", "vram_mb": None, "source": "cim"}], "cpu": "Intel(R) Core(TM) i7-1165G7", "ram_mb": 16110, "os": "Windows 11"}, {}),
            ("Atelier", {"gpus": [{"name": "NVIDIA GeForce RTX 3060", "vram_mb": 12288, "source": "nvidia-smi"}], "cpu": None, "ram_mb": None, "os": "Windows 10"}, {"models": ("autre-modele.safetensors [ffff]",)}),
        ][: max(0, min(3, int(fleet)))]
        for name, hardware, extra in specs:
            code = hq_forge_fleet.create_code()["code"]
            mock = MockForge(delay=delay, **extra)
            sim = SimWorker(base, code, name, mock, hardware=hardware)
            sim.start()
            sims.append(sim)
    if os.environ.get("HQ_FORGE_FLEET_DIAG"):
        # Diagnostic states, each from real telemetry of a simulated worker (no faked fields on HQ's side).
        sys.path.insert(0, str(SOURCE / "tests"))
        import time as _time
        import hq_forge_fleet
        import hq_forge_worker
        from forge_fleet_mocks import MockForge, SimWorker

        hq_forge_worker.POLL_SEC, hq_forge_worker.IDLE_MAX_SEC, hq_forge_worker.PROGRESS_SEC = 0.3, 0.6, 0.4
        hq_forge_fleet.ONLINE_SEC = float(os.environ.get("HQ_FORGE_FLEET_ONLINE_SEC", "4"))
        hq_forge_fleet.bind(root)
        full = {"gpus": [{"name": "NVIDIA GeForce RTX 4070 Ti SUPER Founders Edition 16 Go", "vram_mb": 16376, "source": "nvidia-smi"}],
                "cpu": "AMD Ryzen 9 7950X3D 16-Core Processor with Radeon Graphics", "ram_mb": 65243, "os": "Windows 11"}

        def add(name, hardware=None, **forge):
            code = hq_forge_fleet.create_code()["code"]
            mock = MockForge(**forge)
            sim = SimWorker(base, code, name, mock, hardware=hardware if hardware is not None else full)
            sims.append(sim)
            return sim

        add("Studio graphique du fond, poste n°1").start()
        add("Sans Forge", mode="offline").start()
        add("Forge occup\u00e9", mode="busy").start()
        add("Sans pilote", hardware={"gpus": [], "cpu": None, "ram_mb": None, "os": "Windows 10"}).start()
        add("Autre mod\u00e8le", models=("autre-modele.safetensors [ffff]",), samplers=("DPM++ 2M",)).start()
        sleepy = add("En veille")
        sleepy.worker.poll_once()  # one heartbeat, then silence
        net = add("R\u00e9seau instable")
        stamp = int(_time.time())
        net.worker.net_report = {"code": "hq_unreachable", "since": stamp - 300, "until": stamp - 20}
        net.start()
        revoked = add("Identifiants refus\u00e9s")
        revoked.client.secret = "0" * 64
        revoked.start()
        legacy = add("Ancien secret")
        with hq_forge_fleet._LOCK:
            row = hq_forge_fleet._worker(legacy.id)
            row["secret"] = {"kind": "plain", "value": "legacy-not-a-real-secret"}
        legacy.start()
    print(json.dumps({"base": base, "admin_pin": "424242", "upload_pin": "111111", "workers": [sim.id for sim in sims]}), flush=True)
    try:
        sys.stdin.read()  # exits when the parent closes stdin
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
