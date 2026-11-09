"""Publish a finished test record, then wait until that record is complete.

Opening a destination and writing it in place makes the file visible before
its contents are finished. Callers publish by writing a temporary file in the
same directory and replacing the destination. Readers accept a port, a JSON
object, or a loopback origin only when the whole record is present.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

PORT_MIN = 1
PORT_MAX = 65535


class PublicationError(RuntimeError):
    def __init__(self, code: str, *, returncode: int | None = None, stderr: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.returncode = returncode
        self.stderr = stderr


def publish_bytes(path: Path, payload: bytes) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.{time.time_ns()}.tmp")
    temporary.write_bytes(payload)
    deadline = time.monotonic() + 2
    try:
        while True:
            try:
                os.replace(temporary, destination)
                return
            except PermissionError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.01)
    finally:
        temporary.unlink(missing_ok=True)


def publish_port(path: Path, port: int) -> None:
    if type(port) is not int or port < PORT_MIN or port > PORT_MAX:
        raise PublicationError("malformed")
    publish_bytes(path, f"{port}\n".encode("ascii"))


def publish_json(path: Path, record: dict) -> None:
    if type(record) is not dict:
        raise PublicationError("malformed")
    payload = json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
    publish_bytes(path, payload)


def publish_origin(path: Path, origin: str) -> None:
    if type(origin) is not str:
        raise PublicationError("malformed")
    raw = (origin + "\n").encode("ascii")
    if parse_origin(raw) != origin:
        raise PublicationError("malformed")
    publish_bytes(path, raw)


def parse_port(raw: bytes) -> int | None:
    if raw == b"" or (raw.isdigit() and not raw.endswith(b"\n")):
        return None
    if not raw.endswith(b"\n"):
        raise PublicationError("malformed")
    body = raw[:-1]
    if not body.isdigit() or (len(body) > 1 and body.startswith(b"0")):
        raise PublicationError("malformed")
    port = int(body)
    if port < PORT_MIN or port > PORT_MAX:
        raise PublicationError("malformed")
    return port


def parse_json_record(raw: bytes) -> dict | None:
    if raw == b"" or not raw.endswith(b"\n"):
        return None
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise PublicationError("malformed") from None
    if type(value) is not dict:
        raise PublicationError("malformed")
    return value


def parse_origin(raw: bytes) -> str | None:
    prefix = b"http://127.0.0.1:"
    if raw == b"" or not raw.endswith(b"\n"):
        rest = raw[len(prefix):] if raw.startswith(prefix) else None
        if raw == b"" or raw == prefix or (rest is not None and rest.isdigit()):
            return None
        raise PublicationError("malformed")
    body = raw[:-1]
    prefix = b"http://127.0.0.1:"
    if not body.startswith(prefix):
        raise PublicationError("malformed")
    number = body[len(prefix):]
    try:
        port = parse_port(number + b"\n")
    except PublicationError:
        raise PublicationError("malformed") from None
    if port is None:
        raise PublicationError("malformed")
    return body.decode("ascii")


def stderr_text(path: Path | None) -> str:
    if path is None or not Path(path).is_file():
        return ""
    return Path(path).read_bytes()[-4000:].decode("utf-8", errors="replace")


def wait_until_ready(path: Path, parse, process, timeout: float, stderr_path: Path | None = None):
    """Return the parsed record. Fail on a malformed record, child exit, or timeout."""
    destination = Path(path)
    deadline = time.monotonic() + timeout
    while True:
        raw = None
        if destination.is_file():
            try:
                raw = destination.read_bytes()
            except OSError:
                raw = None
        if raw is not None:
            try:
                parsed = parse(raw)
            except PublicationError as exc:
                raise PublicationError(
                    "malformed",
                    returncode=None if process is None else process.poll(),
                    stderr=stderr_text(stderr_path),
                ) from exc
            if parsed is not None:
                return parsed
        if process is not None and process.poll() is not None:
            raise PublicationError("exited", returncode=process.returncode, stderr=stderr_text(stderr_path))
        if time.monotonic() >= deadline:
            code = None if process is None else process.poll()
            raise PublicationError("timeout", returncode=code, stderr=stderr_text(stderr_path))
        time.sleep(0.02)
