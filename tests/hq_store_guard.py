"""Fail a pytest session when a test reads or writes a live-checkout assistant store.

``tests/hq_assistant_state.py`` binds and checks the modules that opt in. This
module closes the other door: a test module that never binds and never calls the
helper can still resolve a store to the checkout (``Path(".")`` defaults) and read
the Master's real state, or write over it, and the session used to exit 0 with a
banner on stderr.

So the guard hooks the actual paths a store is read and written through —
``Path.read_text``/``read_bytes``, ``open``, ``os.replace``, ``os.remove`` — and
attributes every hit to the test node that was running. ``conftest.py`` arms it
and turns a hit into that test's failure, naming the store and the node.

Reads are filtered to store files (``*_self.json``, ``*_visits.json``, …):
touching another file in a ``.hq-*`` folder is not an assistant-store read.
Reads outside a test — import and collection, before any module can bind — are
reported at the end of the session and never fail it: every module that merely
imports an assistant package would otherwise go red. Writes are never legitimate
here, so any create, rewrite or delete inside a ``.hq-*`` store folder fails.
"""
from __future__ import annotations

import builtins
import fnmatch
import io
import os
import pathlib as _pathlib
import threading
from pathlib import Path

from tests import hq_assistant_state as state

ROOT = state.LIVE_ROOT
STORE_DIRS = frozenset(state.LIVE_STORE_DIRS)
STORE_NAMES = tuple(state.LIVE_STORE_NAMES)

_lock = threading.RLock()
_armed = False
_in_test = False
_node = ""
_current: list[dict] = []      # what this test did
_unattributed: list[dict] = []  # reads at import/collection time: reported, not failed
_seen: set[tuple[str, str, str]] = set()
_originals: dict[str, object] = {}


# --------------------------------------------------------------------------- paths

def _store_path(path) -> str | None:
    """The checkout-relative path when ``path`` is inside one of its store folders."""
    try:
        resolved = Path(os.fspath(path)).resolve()
    except (TypeError, ValueError, OSError):
        return None
    try:
        relative = resolved.relative_to(ROOT)
    except ValueError:
        return None
    parts = relative.parts
    if len(parts) < 2 or parts[0] not in STORE_DIRS:
        return None
    return relative.as_posix()


def _is_store_file(relative: str) -> bool:
    name = relative.rsplit("/", 1)[-1]
    return any(fnmatch.fnmatch(name, pattern) for pattern in STORE_NAMES)


def _note(kind: str, path) -> None:
    """Record a read/write of a live store, against the test that is running."""
    relative = _store_path(path)
    if relative is None:
        return
    if kind == "read" and not _is_store_file(relative):
        return
    with _lock:
        node = _node
        key = (kind, relative, node if _in_test else "")
        if key in _seen:
            return
        _seen.add(key)
        entry = {"kind": kind, "path": relative, "test": node}
        if _in_test:
            _current.append(entry)
        else:
            _unattributed.append(entry)


# ---------------------------------------------------------------------- instrument

def _wrap_read(method):
    def hook(self, *args, **kwargs):
        _note("read", self)
        return method(self, *args, **kwargs)

    hook.__name__ = getattr(method, "__name__", "read")
    hook.__doc__ = getattr(method, "__doc__", None)
    return hook


def _wrap_open(original):
    def hook(file, mode="r", *args, **kwargs):
        if isinstance(file, (str, bytes, os.PathLike)):
            writing = any(flag in str(mode or "r") for flag in ("w", "a", "x", "+"))
            _note("write" if writing else "read", file)
        return original(file, mode, *args, **kwargs)

    hook.__name__ = "open"
    return hook


def _wrap_two_arg(original, kind: str, index: int):
    def hook(*args, **kwargs):
        if len(args) > index:
            _note(kind, args[index])
        return original(*args, **kwargs)

    hook.__name__ = getattr(original, "__name__", kind)
    return hook


def _wrap_accessor_open(original):
    """``pathlib`` routes ``Path.open`` (and so write_text/write_bytes) here."""

    def hook(path, mode="r", *args, **kwargs):
        if isinstance(path, (str, bytes, os.PathLike)):
            writing = any(flag in str(mode or "r") for flag in ("w", "a", "x", "+"))
            _note("write" if writing else "read", path)
        return original(path, mode, *args, **kwargs)

    return staticmethod(hook)


def _wrap_accessor_unlink(original):
    def hook(path, *args, **kwargs):
        if isinstance(path, (str, bytes, os.PathLike)):
            _note("delete", path)
        return original(path, *args, **kwargs)

    return staticmethod(hook)


def arm() -> None:
    """Install the hooks once; harmless to call twice."""
    global _armed
    with _lock:
        if _armed:
            return
        _armed = True
    _originals["read_text"] = Path.read_text
    _originals["read_bytes"] = Path.read_bytes
    _originals["open"] = builtins.open
    _originals["io.open"] = io.open
    _originals["os.replace"] = os.replace
    _originals["os.rename"] = os.rename
    _originals["os.remove"] = os.remove
    _originals["os.unlink"] = os.unlink
    Path.read_text = _wrap_read(Path.read_text)
    Path.read_bytes = _wrap_read(Path.read_bytes)
    builtins.open = _wrap_open(builtins.open)
    io.open = builtins.open
    os.replace = _wrap_two_arg(os.replace, "write", 1)
    os.rename = _wrap_two_arg(os.rename, "write", 1)
    os.remove = _wrap_two_arg(os.remove, "delete", 0)
    os.unlink = _wrap_two_arg(os.unlink, "delete", 0)
    # ``Path.write_text``/``write_bytes``/``unlink`` go through these bound
    # staticmethods, not through ``io``/``os``: without this the most common test
    # write would be invisible.
    accessor = getattr(_pathlib, "_NormalAccessor", None)
    if accessor is not None:
        accessor.open = _wrap_accessor_open(accessor.open)
        accessor.unlink = _wrap_accessor_unlink(accessor.unlink)


# ------------------------------------------------------------------ pytest session

def begin(nodeid: str) -> None:
    global _node, _in_test
    with _lock:
        _node = nodeid
        _in_test = True
        _current.clear()


def end(nodeid: str) -> list[dict]:
    """Close the test window and return what it did."""
    global _node, _in_test
    with _lock:
        found = list(_current)
        _current.clear()
        _in_test = False
        _node = ""
    return [entry for entry in found if entry["test"] == nodeid]


def report(entries: list[dict]) -> str:
    """The failure message: every store touched, and the test it happened in."""
    node = entries[0]["test"] if entries else ""
    lines = ["ASSISTANT STORE GUARD: this test touched the live checkout's assistant store."]
    for entry in entries:
        lines.append(f"  {entry['kind']:<6} {entry['path']}  ({ROOT / entry['path']})")
    lines.append(f"  test node: {node}")
    lines.append("  Fix: bind the store to a temporary root first —"
                 " tests.hq_assistant_state.set_up() (setUpModule), bind(root) in setUp,"
                 " or guard(self) — the checkout is the Master's real state.")
    return "\n".join(lines)


def session_report() -> list[str]:
    """Reads seen before any test ran: named, but not a failure."""
    with _lock:
        rows = list(_unattributed)
    return [f"  {entry['kind']:<6} {entry['path']}" for entry in rows]


def unattributed() -> list[dict]:
    with _lock:
        return list(_unattributed)
