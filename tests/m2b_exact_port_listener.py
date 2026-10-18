"""Ephemeral lifecycle listener process for the exact-port infrastructure.

The fixed endpoint 127.0.0.1:8776 is refused. This file is the script path the
recovery program recognizes. It does not accept a bind address from argv.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
if str(SOURCE) not in sys.path:
    sys.path.insert(0, str(SOURCE))

import hq_forge_lifecycle as life  # noqa: E402
import hq_forge_lifecycle_listener as listener  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if any(item == "--fixed" or item.startswith("--port") or item.startswith("--bind") for item in args):
        try:
            listener.assert_fixed_listener_bind(8776, authorized=True)
        except RuntimeError as exc:
            sys.stderr.write(str(exc) + "\n")
            return 2
        sys.stderr.write("fixed listener port is disabled\n")
        return 2
    if len(args) != 9:
        sys.stderr.write("listener arguments were not accepted\n")
        return 2
    sessions = Path(args[0])
    root = Path(args[1])
    origin = args[2]
    generation = int(args[3])
    hq_pid = int(args[4])
    hq_creation = int(args[5])
    port_file = Path(args[6])
    identity_file = Path(args[7])
    stop_flag = Path(args[8])
    listener.assert_isolated_session_path(sessions)
    nonce = identity_file.stem
    supervisor = life.Supervisor(
        root,
        f"Local\\TransfertHQ-M1-{nonce}",
        f"Local\\TransfertHQ-M1-Mutex-{nonce}",
    )
    server = listener.LifecycleListener(
        supervisor,
        origin,
        sessions,
        generation,
        hq_pid,
        hq_creation,
        lambda: "ready",
    )
    try:
        if server.port in listener.RESERVED_PORTS:
            raise RuntimeError("listener selected a reserved port")
        import os
        creation = life.process_creation(os.getpid())
        image = life.process_image(os.getpid())
        identity = {
            "pid": os.getpid(),
            "creation": creation,
            "executable": image,
            "script": str(Path(__file__).resolve()),
            "port": server.port,
        }
        identity_file.write_text(json.dumps(identity, sort_keys=True) + "\n", encoding="utf-8")
        port_file.write_text(str(server.port), encoding="ascii")
        while not stop_flag.is_file():
            time.sleep(0.05)
    finally:
        server.close()
        supervisor.terminate_if_proven()
        record = root / "lifecycle.json"
        if record.is_file():
            payload = json.loads(record.read_text(encoding="utf-8"))
            if "pid" in payload and "creation" in payload:
                life.harness_stop(int(payload["pid"]), int(payload["creation"]), "cmd.exe")
        supervisor.close_supervisor_handles()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
