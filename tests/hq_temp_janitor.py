"""Deletes stale throwaway HQ roots that tests leave in the temp folder.

Fixture servers and HTTP tests copy HQ (``assets`` is ~0.8 GB) into ``%TEMP%\\hq-<name>-<random>``. Visual scripts
kill their server and often never delete that root, and an agent run that is interrupted leaks the rest; hundreds
piled up in a day (2026-11). This janitor runs when the fixture server or the tests package starts and removes a
root only when all of these hold:

- it is a direct child of ``tempfile.gettempdir()`` (the live HQ root never lives there), whatever its name
  (tests use dozens of prefixes: hq-*, p15-*, test-login*, plain tmp*…);
- it is a test copy of HQ: the ``.hq-test-root`` marker, or HQ's own ``assets/hq.js`` directly inside it or one
  folder down (``<tmp>/root/assets``) — never some other program's temp files;
- nothing at its top level changed for ``STALE_HOURS`` (no test runs that long).

Deletion never enters a symlink or junction (Python 3.10's ``shutil.rmtree`` can follow junctions on Windows, and
some Carnet tests plant links on purpose): links are removed as links, their targets are never touched.
"""
from __future__ import annotations

import os
import stat
import tempfile
import threading
import time
from pathlib import Path

STALE_HOURS = 1.0  # agents can create ~50 copies an hour: a longer window still means tens of GB
MARKER = ".hq-test-root"
_started = False


def _is_link(entry: os.DirEntry) -> bool:
    try:
        st = entry.stat(follow_symlinks=False)
    except OSError:
        return True  # unreadable: treat as a link, never descend
    return entry.is_symlink() or bool(getattr(st, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def safe_rmtree(path: Path) -> None:
    """Delete ``path`` without following links or junctions anywhere below it."""
    try:
        entries = list(os.scandir(path))
    except OSError:
        return  # already gone (another sweep, or the test cleaned up) or unreadable
    for entry in entries:
        try:
            if _is_link(entry):
                try:
                    os.unlink(entry.path)
                except OSError:
                    os.rmdir(entry.path)  # a directory junction/symlink: removes the link only
            elif entry.is_dir(follow_symlinks=False):
                safe_rmtree(Path(entry.path))
            else:
                try:
                    os.unlink(entry.path)
                except PermissionError:
                    os.chmod(entry.path, stat.S_IWRITE)
                    os.unlink(entry.path)
        except OSError:
            continue  # in use or vanished: the next pass gets it
    try:
        os.rmdir(path)
    except OSError:
        pass


def _is_hq_copy(root: Path) -> bool:
    if (root / MARKER).exists() or (root / "assets" / "hq.js").is_file():
        return True
    try:
        children = [e for e in os.scandir(root) if not _is_link(e) and e.is_dir(follow_symlinks=False)]
    except OSError:
        return False
    return any((Path(e.path) / "assets" / "hq.js").is_file() for e in children[:20])


def _last_touched(root: Path) -> float:
    stamps = [root.stat().st_mtime]
    for name in (MARKER, "assets", "bridge_sessions.json"):
        try:
            stamps.append((root / name).stat().st_mtime)
        except OSError:
            pass
    return max(stamps)


def stale_roots(*, now: float | None = None, max_age_hours: float = STALE_HOURS, base: Path | None = None) -> list[Path]:
    base = Path(base or tempfile.gettempdir()).resolve()
    now = time.time() if now is None else now
    out = []
    try:
        entries = list(os.scandir(base))
    except OSError:
        return out
    for entry in entries:
        if _is_link(entry) or not entry.is_dir(follow_symlinks=False):
            continue
        root = Path(entry.path)
        try:
            if not _is_hq_copy(root):
                continue
            if now - _last_touched(root) >= max_age_hours * 3600:
                out.append(root)
        except OSError:
            continue
    return out


def prune(*, max_age_hours: float = STALE_HOURS, base: Path | None = None) -> int:
    roots = stale_roots(max_age_hours=max_age_hours, base=base)
    for root in roots:
        safe_rmtree(root)
    return len(roots)


def prune_in_background() -> None:
    """Once per process, in a daemon thread: never slows a test down; an unfinished pass resumes next time."""
    global _started
    if _started or os.environ.get("HQ_KEEP_TEST_ROOTS"):
        return
    _started = True
    threading.Thread(target=prune, daemon=True, name="hq-temp-janitor").start()


def mark(root: Path) -> None:
    """Tag a fresh temp root as a test copy of HQ (lets the janitor recognise it even before assets are copied)."""
    (Path(root) / MARKER).write_text("throwaway HQ test root; deleted by tests/hq_temp_janitor.py when stale\n",
                                     encoding="utf-8")
