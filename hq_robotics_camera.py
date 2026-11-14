"""One on-demand, authenticated H.264 remux via the optional go2rtc gateway."""

from __future__ import annotations

import base64
from contextlib import contextmanager
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from urllib.parse import quote

from hq_robotics_arm import DeviceError, pinned_ip

TRACK = {"standard": "stream2", "high": "stream1"}
CONTENT_TYPE = re.compile(r'video/mp4; codecs="avc1\.[0-9a-fA-F]{6}"')


@contextmanager
def pinned_rtsp(address):
    """Accept a single gateway connection and relay to the pinned Tapo only.

    The gateway sees a local RTSP address. A redirect would have to be handled
    by the gateway, so its RTSP responses are checked before forwarding.
    """
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(.2)
        port = listener.getsockname()[1]
        stopped = threading.Event()

        def relay():
            try:
                while not stopped.is_set():
                    try:
                        gateway, _ = listener.accept()
                    except TimeoutError:
                        continue
                    break
                else:
                    return
                with gateway, socket.create_connection((address, 554), timeout=3) as camera:
                    relay_rtsp(gateway, camera, stopped)
            except (OSError, ValueError):
                pass

        worker = threading.Thread(target=relay, daemon=True, name="hq-robotics-rtsp")
        worker.start()
        try:
            yield port
        finally:
            stopped.set()
            worker.join(timeout=.3)


def relay_rtsp(gateway, camera, stopped):
    from select import select

    for conn in (gateway, camera):
        conn.settimeout(.5)
    pending = bytearray()
    body_left = 0
    while not stopped.is_set():
        ready, _, _ = select([gateway, camera], [], [], .2)
        for conn in ready:
            chunk = conn.recv(65536)
            if not chunk:
                return
            if conn is gateway:
                camera.sendall(chunk)
                continue
            pending.extend(chunk)
            while pending:
                if body_left:
                    size = min(body_left, len(pending))
                    gateway.sendall(pending[:size])
                    del pending[:size]
                    body_left -= size
                elif pending[0] == ord("$"):
                    if len(pending) < 4:
                        break
                    body_left = int.from_bytes(pending[2:4], "big") + 4
                else:
                    end = pending.find(b"\r\n\r\n")
                    if end < 0:
                        if len(pending) > 16384:
                            raise ValueError
                        break
                    end += 4
                    lines = pending[:end].split(b"\r\n")
                    status = lines[0].split()
                    if len(status) < 2 or status[0] != b"RTSP/1.0" or not status[1].isdigit():
                        raise ValueError
                    if 300 <= int(status[1]) < 400:
                        raise ValueError
                    for line in lines[1:]:
                        name, _, value = line.partition(b":")
                        if name.lower() == b"content-length":
                            body_left = int(value)
                            if not 0 <= body_left <= 65536:
                                raise ValueError
                    gateway.sendall(pending[:end])
                    del pending[:end]


def executable(root):
    local = Path(root) / ".hq-agent-state" / "go2rtc.exe"
    return str(local) if local.is_file() else shutil.which("go2rtc")


def own_windows_process(process):
    if os.name != "nt":
        return lambda: None
    import ctypes
    from hq_forge_lifecycle import _kernel, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation

    job = _kernel.CreateJobObjectW(None, None)
    if not job:
        raise OSError("Job Windows indisponible")
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (not _kernel.SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                            ctypes.byref(info), ctypes.sizeof(info))
            or not _kernel.AssignProcessToJobObject(job, int(process._handle))):
        _kernel.CloseHandle(job)
        raise OSError("Impossible de confiner le processus vidéo au pont")
    return lambda: _kernel.CloseHandle(job)


class Camera:
    """Single consumer. The bridge owns the child process and its loopback API."""

    def __init__(self, root):
        self.root = root
        self.lock = threading.Lock()
        self.active = None
        self.finished = threading.Event()
        self.finished.set()

    def stop(self):
        with self.lock:
            if self.active:
                self.active.kill()

    def close(self):
        self.stop()
        self.finished.wait(timeout=4)

    @contextmanager
    def stream(self, config, quality):
        binary = executable(self.root)
        if not binary:
            raise DeviceError("Passerelle go2rtc indisponible")
        address = pinned_ip(config["camera_ip"])
        with pinned_rtsp(address) as port:
            with self.remux(binary, port, config, quality) as result:
                yield result

    @contextmanager
    def remux(self, binary, rtsp_port, config, quality):
        user = quote(config["camera_user"], safe="")
        password = quote(config["camera_password"], safe="")
        uri = f"rtsp://{user}:{password}@127.0.0.1:{rtsp_port}/{TRACK[quality]}#transport=tcp#media=video#timeout=4"
        with self.lock:
            if self.active is not None:
                raise DeviceError("Un flux caméra est déjà ouvert")
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            key = secrets.token_urlsafe(32)
            settings = {
                "app": {"modules": ["api", "streams", "rtsp", "mp4"]},
                "api": {"listen": f"127.0.0.1:{port}", "local_auth": True, "username": "hq",
                        "password": "${HQ_ROBOTICS_GATEWAY_KEY}",
                        "allow_paths": ["/api/stream.mp4"]},
                "rtsp": {"listen": ""},
                "streams": {"camera": "${HQ_ROBOTICS_RTSP}"},
            }
            process = None
            config_file = None
            try:
                # go2rtc expands environment references only in file-based configuration.
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".json",
                                                 prefix="hq-robotics-gateway-", delete=False) as handle:
                    config_file = Path(handle.name)
                    json.dump(settings, handle)
                env = {k: v for k, v in os.environ.items() if k.upper() != "CREDENTIALS_DIRECTORY"}
                process = subprocess.Popen([binary, "-config", str(config_file)], cwd=self.root,
                                           env={**env, "HQ_ROBOTICS_RTSP": uri,
                                                "HQ_ROBOTICS_GATEWAY_KEY": key},
                                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL,
                                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                close_job = own_windows_process(process)
            except OSError:
                if process is not None:
                    process.kill()
                    process.wait()
                if config_file:
                    config_file.unlink(missing_ok=True)
                raise DeviceError("Démarrage de go2rtc impossible") from None
            self.active = process
            self.finished.clear()
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=config["camera_timeout"])
        try:
            deadline = time.monotonic() + 3
            while True:
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise DeviceError("Passerelle vidéo indisponible")
                try:
                    conn.connect()
                    config_file.unlink(missing_ok=True)
                    break
                except ConnectionRefusedError:
                    time.sleep(.05)
            auth = base64.b64encode(("hq:" + key).encode()).decode()
            conn.request("GET", "/api/stream.mp4?src=camera&video=h264",
                         headers={"Authorization": "Basic " + auth, "Connection": "close"})
            response = conn.getresponse()
            mime = response.getheader("Content-Type", "")
            if response.status != 200 or not CONTENT_TYPE.fullmatch(mime):
                raise DeviceError("Flux H.264 Tapo indisponible")
            yield mime, response
        except (OSError, ValueError, http.client.HTTPException):
            raise DeviceError("Flux Tapo interrompu ou inaccessible") from None
        finally:
            conn.close()
            with self.lock:
                if process.poll() is None:
                    process.kill()
                process.wait()
                close_job()
                config_file.unlink(missing_ok=True)
                self.active = None
                self.finished.set()
