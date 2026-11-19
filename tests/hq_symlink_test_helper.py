"""Shared symlink privilege check for Carnet tests on Windows hosts without symlink privilege."""

from __future__ import annotations

import functools
import os
import tempfile
import unittest
from pathlib import Path

_SYMLINK_RESULT: tuple[bool, str] | None = None


def _check_symlinks() -> tuple[bool, str]:
    global _SYMLINK_RESULT
    if _SYMLINK_RESULT is not None:
        return _SYMLINK_RESULT
    try:
        with tempfile.TemporaryDirectory(prefix="hq-sym-probe-") as td:
            base = Path(td)
            f_tgt = base / "f_tgt"
            f_tgt.write_bytes(b"")
            os.symlink(f_tgt, base / "f_link")
            d_tgt = base / "d_tgt"
            d_tgt.mkdir()
            os.symlink(d_tgt, base / "d_link", target_is_directory=True)
        _SYMLINK_RESULT = (True, "")
    except (OSError, NotImplementedError) as exc:
        _SYMLINK_RESULT = (
            False,
            f"symlinks unavailable here ({type(exc).__name__}: needs privilege/Developer Mode on Windows)",
        )
    return _SYMLINK_RESULT


def skip_without_symlinks(fn):
    """Decorator: skip a symlink-dependent test cleanly when the OS refuses symlink creation."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        ok, reason = _check_symlinks()
        if not ok:
            raise unittest.SkipTest(reason)
        return fn(*args, **kwargs)
    return wrapper
