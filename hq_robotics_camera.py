"""On-demand H.264 video and WebRTC audio via the loopback go2rtc API."""

from __future__ import annotations

import base64
from contextlib import contextmanager
from hashlib import sha256
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
AUDIO_SDP_LIMIT = 12000


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


def local_audio_offer(sdp, talk):
    """Forward a single G.711 audio offer and let the browser initiate ICE."""
    if not isinstance(sdp, str) or not 0 < len(sdp) <= AUDIO_SDP_LIMIT or not sdp.isascii():
        raise ValueError("invalid audio offer")
    lines = sdp.splitlines()
    media = [line.split() for line in lines if line.startswith("m=")]
    direction = "a=sendrecv" if talk else "a=recvonly"
    directions = [line for line in lines if line in ("a=sendrecv", "a=sendonly", "a=recvonly", "a=inactive")]
    if (not lines or lines[0] != "v=0" or len(media) != 1 or len(media[0]) != 4
            or media[0][0] != "m=audio" or media[0][2:] != ["UDP/TLS/RTP/SAVPF", "8"]
            or directions != [direction]):
        raise ValueError("invalid audio offer")
    # The gateway uses a local UDP socket and never dials addresses in a client SDP.
    blocked = ("a=candidate:", "a=remote-candidates:", "a=end-of-candidates")
    return "\r\n".join(line for line in lines if not line.lower().startswith(blocked)) + "\r\n"


class Camera:
    """Single consumer. The bridge owns the child process and its loopback API."""

    def __init__(self, root):
        self.root = root
        self.lock = threading.Lock()
        self.audio_lock = threading.Lock()
        self.active = None
        self.audio_gateway = None
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
    def stream(self, config, quality, *, audio_host=None, stream_key=None):
        binary = executable(self.root)
        if not binary:
            raise DeviceError("Passerelle go2rtc indisponible")
        address = pinned_ip(config["camera_ip"])
        with pinned_rtsp(address) as port:
            with self.remux(binary, port, config, quality, audio_host=audio_host, stream_key=stream_key) as result:
                yield result

    def audio_answer(self, stream_key, offer, talk):
        sdp = local_audio_offer(offer, talk)
        if not self.audio_lock.acquire(blocking=False):
            raise DeviceError("Une connexion audio est en cours")
        try:
            with self.lock:
                if self.audio_gateway is None or self.audio_gateway[0] != stream_key:
                    raise DeviceError("Flux caméra indisponible pour l’audio")
                _, port, auth = self.audio_gateway
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=6)
            try:
                headers = {"Authorization": "Basic " + auth, "Connection": "close"}
                conn.request("POST", "/api/webrtc?src=camera", sdp.encode("ascii"),
                             {**headers, "Content-Type": "application/sdp"})
                with conn.getresponse() as reply:
                    answer = reply.read(AUDIO_SDP_LIMIT + 1)
                    if reply.status != 201 or not answer.startswith(b"v=0") or len(answer) > AUDIO_SDP_LIMIT:
                        raise DeviceError("Audio Tapo indisponible")
                if talk:
                    conn.request("GET", "/api/streams?src=camera", headers=headers)
                    with conn.getresponse() as reply:
                        info = json.loads(reply.read(32768)) if reply.status == 200 else {}
                    if not isinstance(info, dict) or not any(
                        source.get("format_name") == "tapo" and source.get("senders")
                        for source in info.get("producers") or []
                    ):
                        raise DeviceError("Haut-parleur Tapo indisponible")
                return answer.decode("ascii")
            except (OSError, ValueError, http.client.HTTPException):
                raise DeviceError("Audio Tapo interrompu ou inaccessible") from None
            finally:
                conn.close()
        finally:
            self.audio_lock.release()

    @contextmanager
    def remux(self, binary, rtsp_port, config, quality, *, audio_host=None, stream_key=None):
        user = quote(config["camera_user"], safe="")
        password = quote(config["camera_password"], safe="")
        media = "#backchannel=0" if audio_host else "#media=video"
        uri = f"rtsp://{user}:{password}@127.0.0.1:{rtsp_port}/{TRACK[quality]}#transport=tcp{media}#timeout=4"
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
            variables = {"HQ_ROBOTICS_RTSP": uri, "HQ_ROBOTICS_GATEWAY_KEY": key}
            if audio_host:
                settings["app"]["modules"].extend(["webrtc", "tapo"])
                settings["api"]["allow_paths"].extend(["/api/preload", "/api/webrtc", "/api/streams"])
                settings["webrtc"] = {
                    "listen": f"{audio_host}:0/udp", "ice_servers": [],
                    "filters": {"loopback": audio_host == "127.0.0.1", "ips": [audio_host], "networks": ["udp4"]},
                }
                # The C200 only sends RTSP audio when the video track is also set up.
                # Attach both tracks before PLAY; the fMP4 consumer still selects H.264 only.
                settings["preload"] = {"camera": "video=h264&audio=pcma"}
                settings["streams"]["camera"] = ["${HQ_ROBOTICS_RTSP}"]
                if cloud_password := config.get("camera_cloud_password"):
                    hashed = sha256(cloud_password.encode()).hexdigest().upper()
                    address = pinned_ip(config["camera_ip"])
                    settings["streams"]["camera"].append("${HQ_ROBOTICS_TALK}")
                    variables["HQ_ROBOTICS_TALK"] = f"tapo://admin:{hashed}@{address}:8800"
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
                                           env={**env, **variables},
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
            headers = {"Authorization": "Basic " + auth, "Connection": "close"}
            if audio_host:
                deadline = time.monotonic() + 4
                while time.monotonic() < deadline and process.poll() is None:
                    conn.request("GET", "/api/preload", headers=headers)
                    with conn.getresponse() as reply:
                        if reply.status == 200 and "camera" in json.loads(reply.read(32768)):
                            break
                    time.sleep(.08)
                else:
                    raise DeviceError("Flux vidéo Tapo indisponible")
            conn.request("GET", "/api/stream.mp4?src=camera&video=h264",
                         headers=headers)
            response = conn.getresponse()
            mime = response.getheader("Content-Type", "")
            if response.status != 200 or not CONTENT_TYPE.fullmatch(mime):
                raise DeviceError("Flux H.264 Tapo indisponible")
            if audio_host:
                with self.lock:
                    self.audio_gateway = stream_key, port, auth
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
                self.audio_gateway = None
                self.finished.set()
