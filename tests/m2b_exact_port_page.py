"""Worktree page launcher for the exact-port test.

Ordinary runs bind an ephemeral loopback port. The future fixed target is
127.0.0.1:8765, and that bind stays disabled. This process does not start the
planner, does not read production sessions, and does not call save_config.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
if str(SOURCE) not in sys.path:
    sys.path.insert(0, str(SOURCE))

import hq_forge_lifecycle_listener as gate  # noqa: E402

EXPECTED_HEAD = "75214254a7de365a58e239b2b1bf4103a209f14d"
PRODUCTION_HEAD = "17831623039814a7a010537848efa5424294cea8"
WORKTREE = Path(r"C:\Transfert-worktrees\forge-lifecycle-m1")
PRODUCTION_ROOT = Path(r"C:\Transfert")
PAGE_BIND_PERMITTED = False
PIN = "m2b-disposable-pin"
RESERVED = frozenset({7860, 8765, 8776})
REQUIRED_FILES = (
    "iphone_bridge.py",
    "hq_forge_lifecycle.py",
    "hq_forge_lifecycle_listener.py",
    "hq_forge_csrf_key.py",
    "hq_forge_exact_port_recovery.py",
    "tests/m2b_exact_port_page.py",
    "tests/m2b_exact_port_listener.py",
)
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF


def _git(root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(root), *args],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if completed.returncode != 0:
        raise RuntimeError("checkout identity mismatch")
    return completed.stdout.strip()


def _regular_file(path: Path) -> bool:
    if not path.is_file():
        return False
    kernel = __import__("ctypes").WinDLL("kernel32", use_last_error=True)
    kernel.GetFileAttributesW.argtypes = [__import__("ctypes").wintypes.LPCWSTR]
    kernel.GetFileAttributesW.restype = __import__("ctypes").wintypes.DWORD
    attrs = int(kernel.GetFileAttributesW(str(path)))
    if attrs == INVALID_FILE_ATTRIBUTES:
        return False
    return (attrs & FILE_ATTRIBUTE_REPARSE_POINT) == 0


def assert_checkout(*, fixed: bool) -> dict:
    """Require the reviewed worktree. A dirty tree can serve only an ephemeral port."""
    root = WORKTREE.resolve()
    production = PRODUCTION_ROOT.resolve()
    if root == production or production in root.parents or root in production.parents:
        raise RuntimeError("refusing the production checkout")
    if Path(_git(root, "rev-parse", "--show-toplevel")).resolve() != root:
        raise RuntimeError("checkout identity mismatch")
    head = _git(root, "rev-parse", "HEAD")
    if head != EXPECTED_HEAD:
        raise RuntimeError("checkout identity mismatch")
    if _git(production, "rev-parse", "HEAD") != PRODUCTION_HEAD:
        raise RuntimeError("production checkout mismatch")
    for name in REQUIRED_FILES:
        path = (root / name).resolve()
        if not _regular_file(path) or root not in path.parents or production in path.parents:
            raise RuntimeError("checkout file missing")
    clean = _git(root, "status", "--porcelain") == ""
    if fixed and not clean:
        raise RuntimeError("fixed page port requires a clean reviewed tree")
    return {"head": head, "clean": clean, "root": str(root)}


def fixed_page_decision(*, authorized: bool, clean: bool) -> tuple[str, int]:
    """Name 127.0.0.1:8765 only when every gate is open. This does not bind."""
    if authorized is not True or clean is not True or PAGE_BIND_PERMITTED is not True:
        raise RuntimeError("fixed page port is disabled")
    return ("127.0.0.1", 8765)


def assert_disposable_session_path(path: Path) -> Path:
    resolved = Path(path).resolve()
    production = PRODUCTION_ROOT.resolve()
    worktree = WORKTREE.resolve()
    if resolved == production or production in resolved.parents:
        raise RuntimeError("refusing a production session path")
    if resolved == worktree or worktree in resolved.parents:
        raise RuntimeError("refusing a worktree session path")
    return resolved


def _listener_pids() -> dict[int, int]:
    completed = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    found: dict[int, int] = {}
    for line in completed.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[3] != "LISTENING":
            continue
        local = parts[1]
        for port in (7860, 8765, 8766, 8776):
            if local.endswith(f":{port}"):
                found[port] = int(parts[4])
    return found


class PageHandle:
    def __init__(self, server, thread, sessions: Path, root: Path, identity: dict, restore) -> None:
        self.server = server
        self.thread = thread
        self.sessions = sessions
        self.root = root
        self.identity = identity
        self._restore = restore
        self.port = int(identity["port"])

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self._restore()
        if self.root.is_dir():
            import shutil
            shutil.rmtree(self.root, ignore_errors=True)


def _restore_config(config_path: Path, existed: bool, before: bytes | None, sessions_existed: bool) -> None:
    sessions_path = WORKTREE / "bridge_sessions.json"
    if not sessions_existed and sessions_path.is_file() and sessions_path.parent == WORKTREE:
        sessions_path.unlink()
    if not existed:
        if config_path.is_file() and config_path.parent == WORKTREE:
            config_path.unlink()
        return
    if before is not None and config_path.is_file() and config_path.read_bytes() != before:
        config_path.write_bytes(before)


def start_ephemeral_page(*, origin_file: Path | None = None) -> PageHandle:
    """Bind 127.0.0.1 on a free port. Never binds 8765, 8766, or 8776."""
    assert_checkout(fixed=False)
    if PAGE_BIND_PERMITTED is not False:
        raise RuntimeError("fixed page port is disabled")
    disposable = Path(tempfile.mkdtemp(prefix="m2b-exact-"))
    sessions = assert_disposable_session_path(disposable / "bridge_sessions.json")
    config_path = WORKTREE / "bridge_config.json"
    existed = config_path.is_file()
    before = config_path.read_bytes() if existed else None
    sessions_existed = (WORKTREE / "bridge_sessions.json").is_file()
    import iphone_bridge as bridge

    if Path(bridge.ROOT).resolve() != WORKTREE.resolve():
        _restore_config(config_path, existed, before, sessions_existed)
        raise RuntimeError("bridge import left the worktree")
    bridge.SESSIONS_PATH = sessions
    bridge._SESSIONS.clear()
    bridge.CONFIG["pin"] = PIN
    bridge.CONFIG["users"] = []
    before_ports = _listener_pids()

    class Server(ThreadingHTTPServer):
        allow_reuse_address = False

        def server_bind(self) -> None:
            if self.server_address[0] != "127.0.0.1":
                raise RuntimeError("page left loopback")
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()
            if self.server_address[0] != "127.0.0.1":
                raise RuntimeError("page left loopback")

    class Handler(bridge.Handler):
        def _refresh(self) -> None:
            if origin_file is None or not origin_file.is_file():
                return
            text = origin_file.read_text(encoding="ascii").strip()
            port = gate._port_of(gate._ORIGIN_RE, text)
            if port in RESERVED:
                return
            gate.set_browser_binding_for_tests(f"127.0.0.1:{bound_port[0]}", text)

        def do_GET(self):
            self._refresh()
            super().do_GET()

        def do_POST(self):
            self._refresh()
            super().do_POST()

        def log_message(self, fmt, *args):
            return

    bound_port = [0]
    server = None
    try:
        for _ in range(8):
            candidate = Server(("127.0.0.1", 0), Handler)
            port = int(candidate.server_address[1])
            if port not in RESERVED:
                server = candidate
                bound_port[0] = port
                break
            candidate.server_close()
        if server is None:
            raise RuntimeError("no free page port")
        after = _listener_pids()
        for port, pid in after.items():
            if before_ports.get(port) != pid or pid == os.getpid():
                if port in RESERVED or port == 8766:
                    raise RuntimeError("page disturbed a reserved listener")
        import hq_forge_lifecycle as life
        creation = life.process_creation(os.getpid())
        image = life.process_image(os.getpid())
        if creation is None or not image:
            raise RuntimeError("page identity unavailable")
        identity = {
            "pid": os.getpid(),
            "creation": creation,
            "executable": image,
            "script": str(Path(__file__).resolve()),
            "generation": int(bridge.auth_generation()),
            "port": bound_port[0],
            "sessions": str(sessions),
            "bridge_root": str(Path(bridge.ROOT).resolve()),
        }
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return PageHandle(
            server,
            thread,
            sessions,
            disposable,
            identity,
            lambda: _restore_config(config_path, existed, before, sessions_existed),
        )
    except Exception:
        if server is not None:
            server.server_close()
        _restore_config(config_path, existed, before, sessions_existed)
        import shutil
        shutil.rmtree(disposable, ignore_errors=True)
        raise


def start_fixed_page() -> None:
    """The fixed port is named and then refused. No socket is opened."""
    facts = assert_checkout(fixed=True)
    fixed_page_decision(authorized=True, clean=bool(facts["clean"]))
    if PAGE_BIND_PERMITTED is not True:
        raise RuntimeError("fixed page port is disabled")
    raise RuntimeError("fixed page port is disabled")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if any(item == "--fixed" or item.startswith("--port") or item.startswith("--bind") for item in args):
        try:
            fixed_page_decision(authorized=True, clean=True)
        except RuntimeError as exc:
            sys.stderr.write(str(exc) + "\n")
            return 2
        sys.stderr.write("fixed page port is disabled\n")
        return 2
    if len(args) != 4 or args[0] != "--ephemeral":
        sys.stderr.write("usage: --ephemeral identity.json stop.flag origin.txt\n")
        return 2
    identity_path = Path(args[1])
    stop_flag = Path(args[2])
    origin_file = Path(args[3])
    handle = start_ephemeral_page(origin_file=origin_file)
    try:
        identity_path.write_text(json.dumps(handle.identity, sort_keys=True) + "\n", encoding="utf-8")
        while not stop_flag.is_file():
            time.sleep(0.05)
    finally:
        gate.reset_browser_binding_for_tests()
        handle.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
