"""Mock Forge servers and simulated workers for multi-device tests.

Every server binds 127.0.0.1 on a random port. The production ports
8765/8766/8776/7860 are refused outright. No real Forge, GPU or vault is used.
"""

from __future__ import annotations

import base64
import io
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_worker as W  # noqa: E402

FORBIDDEN_PORTS = {8765, 8766, 8776, 7860}
MODEL = "example.safetensors [abcd]"


def png_bytes(width: int = 256, height: int = 256, colour=(24, 72, 48)) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buffer, format="PNG")
    return buffer.getvalue()


def safe_server(handler) -> ThreadingHTTPServer:
    for _ in range(20):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        if server.server_address[1] not in FORBIDDEN_PORTS:
            return server
        server.server_close()
    raise RuntimeError("no safe port")


class MockForge:
    """A minimal Forge API: catalog routes, progress and txt2img."""

    def __init__(self, *, models=(MODEL,), samplers=("Euler", "Euler a"), delay: float = 0.0, mode: str = "ok",
                 colour=(24, 72, 48)) -> None:
        self.models = list(models)
        self.samplers = list(samplers)
        self.delay = delay
        self.mode = mode
        self.colour = colour
        self.calls: list[dict] = []
        self.bodies: list[bytes] = []
        self.interrupts = 0
        self.lock = threading.Lock()
        self.active = 0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _send(self, status: int, payload) -> None:
                raw = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                path = self.path.split("?", 1)[0]
                if owner.mode == "offline":
                    self._send(503, {})
                    return
                table = {
                    "/sdapi/v1/samplers": [{"name": name} for name in owner.samplers],
                    "/sdapi/v1/schedulers": [{"name": "automatic", "label": "Automatic"}],
                    "/sdapi/v1/upscalers": [{"name": "R-ESRGAN 4x+"}],
                    "/sdapi/v1/sd-models": [{"title": title, "model_name": title.split(".")[0]} for title in owner.models],
                    "/sdapi/v1/options": {"sd_model_checkpoint": owner.models[0] if owner.models else ""},
                    "/sdapi/v1/progress": {"progress": 0.5 if owner.active else 0,
                                           "state": {"job": "", "job_count": 0, "sampling_step": 5 if owner.active else 0, "sampling_steps": 10}},
                    "/internal/pending-tasks": {"size": 0, "tasks": []},
                }
                if path not in table:
                    self._send(404, {})
                    return
                self._send(200, table[path])

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0") or 0)
                body = self.rfile.read(length)
                path = self.path.split("?", 1)[0]
                if path != "/sdapi/v1/txt2img":
                    if path.endswith("/interrupt"):
                        owner.interrupts += 1
                    self._send(404, {})
                    return
                data = json.loads(body.decode("utf-8"))
                started = time.monotonic()
                with owner.lock:
                    owner.active += 1
                    owner.bodies.append(body)
                time.sleep(owner.delay)
                with owner.lock:
                    owner.active -= 1
                    owner.calls.append({"start": started, "end": time.monotonic(), "seed": data.get("seed"), "body": data})
                if owner.mode == "fail":
                    self._send(500, {"error": "mock failure"})
                    return
                if owner.mode == "badpng":
                    image = base64.b64encode(b"GIF89a-not-a-png").decode("ascii")
                else:
                    image = base64.b64encode(png_bytes(data.get("width", 256), data.get("height", 256), owner.colour)).decode("ascii")
                self._send(200, {"images": [image], "info": json.dumps({"seed": data.get("seed"), "all_seeds": [data.get("seed")]})})

        self.server = safe_server(Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class SimWorker:
    """A real hq_forge_worker.Worker over HTTP to a loopback test HQ, with its own MockForge."""

    def __init__(self, base: str, code: str, name: str, forge: MockForge, *, hardware=None) -> None:
        self.forge_mock = forge
        hw = hardware if hardware is not None else {"gpus": [{"name": "Mock GPU " + name, "vram_mb": 8192, "source": "nvidia-smi"}],
                                                    "cpu": "Mock CPU", "ram_mb": 32768, "os": "Windows 11"}
        self.creds = W.pair(base, code, name, dev=True, hardware=hw)
        self.client = W.HQClient(self.creds["hq"], self.creds["worker_id"], self.creds["secret"])
        self.worker = W.Worker(self.client, W.ForgeLocal(forge.port), hardware=hw)
        self.thread: threading.Thread | None = None

    @property
    def id(self) -> str:
        return self.creds["worker_id"]

    def start(self) -> None:
        self.thread = threading.Thread(target=self.worker.run_forever, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.worker.stop.set()
        if self.thread:
            self.thread.join(timeout=10)
