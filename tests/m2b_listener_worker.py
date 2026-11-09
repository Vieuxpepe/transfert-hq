"""Separate-process lifecycle listener for development tests.

Refuses ports 7860, 8765, and 8776. Prints nothing about cookies or sessions.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_lifecycle as life  # noqa: E402
import hq_forge_lifecycle_listener as listener  # noqa: E402
import importlib.util  # noqa: E402

_PUBLICATION_SPEC = importlib.util.spec_from_file_location(
    "m2b_publication",
    SOURCE / "tests" / "m2b_publication.py",
)
publication = importlib.util.module_from_spec(_PUBLICATION_SPEC)
_PUBLICATION_SPEC.loader.exec_module(publication)


def main() -> int:
    sessions = Path(sys.argv[1])
    root = Path(sys.argv[2])
    origin = sys.argv[3]
    generation = int(sys.argv[4])
    hq_pid = int(sys.argv[5])
    hq_creation = int(sys.argv[6])
    port_file = Path(sys.argv[7])
    nonce = sys.argv[8]
    listener.assert_isolated_session_path(sessions)
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
    publication.publish_port(port_file, int(server.port))
    try:
        threading.Event().wait()
    finally:
        server.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
