"""Carnet: descriptor-bound reads and copies of canonical store files (shared by the annotation, comment, verification, snapshot and review stores).

A store file is read through the descriptor that was actually opened: ``lstat`` (refuse symlink / non-regular / oversize), open with
``O_NOFOLLOW`` (+ ``O_NONBLOCK`` so a FIFO cannot hang us), ``fstat`` must be the SAME regular file (device + inode), bytes come from that
descriptor only. A redirected, replaced or vanished file is never followed. Standard library only; no network, no shell.
"""

from __future__ import annotations

import os
import stat as _stat
from pathlib import Path


class Noncanonical(Exception):
    """The named store file is not a plain regular file of acceptable size (symlink, directory, device, oversize, or swapped while opening)."""


def read_regular(path: Path, limit: int) -> bytes:
    """Read ONE canonical store file bound to the descriptor actually opened: ``lstat`` (refuse symlink / non-regular / oversize), open with
    ``O_NOFOLLOW`` (+ ``O_NONBLOCK`` so a FIFO cannot hang us), ``fstat`` must be the SAME regular file (device + inode), and the bytes come from
    that descriptor only. ``FileNotFoundError`` = absent; anything redirected or swapped raises ``Noncanonical`` and is NEVER followed."""
    st = os.lstat(path)
    if _stat.S_ISLNK(st.st_mode) or not _stat.S_ISREG(st.st_mode) or st.st_size > limit + 4096:
        raise Noncanonical()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        raise
    except OSError as e:  # ELOOP (symlink swapped in), ENXIO, EISDIR ...
        raise Noncanonical() from e
    try:
        fst = os.fstat(fd)
        if not _stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino) or fst.st_size > limit + 4096:
            raise Noncanonical()
        chunks, left = [], limit + 4097
        while left > 0:
            chunk = os.read(fd, min(left, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > limit + 4096:
            raise Noncanonical()
        return raw
    finally:
        os.close(fd)


def copy_canonical(directory: Path, dest: Path, names: list[str], name_ok, limit: int, refused: list | None = None) -> int:
    """Byte-for-byte copy of the named canonical files (each bound to its own opened descriptor). A redirected / replaced / vanished file is
    NEVER followed: it is skipped and named in ``refused`` (the caller then reports the backup as not valid). Corrupt-but-regular bytes copy as they are."""
    total = 0
    for name in names:
        if not name.endswith(".json") or not name_ok(name[:-5]):
            continue
        try:
            raw = read_regular(directory / name, limit)
        except (FileNotFoundError, Noncanonical, OSError):
            if refused is not None:
                refused.append(name)
            continue
        (dest / name).write_bytes(raw)
        total += len(raw)
    return total
