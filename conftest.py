"""pytest session hooks: the assistant store guard.

``tests/hq_store_guard`` hooks the paths a store is read and written through.
These hooks make a hit fail the test it happened in — message with the store path
and the node — so a module that never binds and never calls
``tests.hq_assistant_state`` cannot get a silent pass. Reads at import/collection
time are only listed at the end: importing an assistant package is not a leak.

Nothing here runs under ``python -m unittest``; that path is covered by the
module hooks in ``tests/hq_assistant_state.py``.
"""
import os
import stat
import tempfile

import pytest

from tests import hq_store_guard as guard


# Windows without Developer Mode refuses os.symlink with WinError 1314.  The
# stores deliberately treat junctions as redirects too, so exercise the same
# refusal contract with a real NTFS junction rather than skipping the test.
_ORIGINAL_SYMLINK = None
_ORIGINAL_UNLINK = None
_JUNCTION_TARGETS = []


def _is_reparse_directory(path) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    attrs = getattr(st, "st_file_attributes", 0) or 0
    return bool(attrs & 0x400) and stat.S_ISDIR(st.st_mode)


def _install_windows_junction_fallback() -> None:
    global _ORIGINAL_SYMLINK, _ORIGINAL_UNLINK
    if os.name != "nt" or _ORIGINAL_SYMLINK is not None:
        return
    import _winapi

    original_symlink = os.symlink
    original_unlink = os.unlink

    def junction_symlink(src, dst, target_is_directory=False, **kwargs):
        try:
            return original_symlink(src, dst, target_is_directory, **kwargs)
        except OSError as exc:
            if getattr(exc, "winerror", None) != 1314:
                raise
            source = os.fspath(src)
            destination = os.fspath(dst)
            if os.path.isdir(source):
                _winapi.CreateJunction(source, destination)
                return None
            # A file target gets a junction to an empty directory outside the store:
            # the path is still a reparse point, and code must refuse rather than read it.
            target = tempfile.mkdtemp(prefix="hq-link-")
            _JUNCTION_TARGETS.append(target)
            _winapi.CreateJunction(target, destination)
            return None

    def junction_unlink(path, *args, **kwargs):
        if _is_reparse_directory(path):
            os.rmdir(path)
            return None
        return original_unlink(path, *args, **kwargs)

    os.symlink = junction_symlink
    os.unlink = junction_unlink
    _ORIGINAL_SYMLINK = original_symlink
    _ORIGINAL_UNLINK = original_unlink


def _restore_windows_junction_fallback() -> None:
    global _ORIGINAL_SYMLINK, _ORIGINAL_UNLINK
    if _ORIGINAL_SYMLINK is None:
        return
    os.symlink = _ORIGINAL_SYMLINK
    os.unlink = _ORIGINAL_UNLINK
    _ORIGINAL_SYMLINK = _ORIGINAL_UNLINK = None
    for target in _JUNCTION_TARGETS:
        try:
            os.rmdir(target)
        except OSError:
            pass
    _JUNCTION_TARGETS.clear()


def pytest_configure(config):
    _install_windows_junction_fallback()
    guard.arm()


def pytest_runtest_setup(item):
    guard.begin(item.nodeid)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if report.when != "teardown":
        return
    found = guard.end(item.nodeid)
    if found:
        report.outcome = "failed"
        report.longrepr = guard.report(found)


def pytest_sessionfinish(session, exitstatus):
    _restore_windows_junction_fallback()
    # Belt and braces: if a hit could not be attached to its test (an early skip,
    # an interrupted item), the session still fails.
    if guard.unattributed() and exitstatus == 0:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    rows = guard.session_report()
    if not rows:
        return
    terminalreporter.write_sep("-", "assistant store guard: reads at import/collection time")
    terminalreporter.write_line(
        "These resolved a store to the checkout before any test bound it. This is not a "
        "failure (a module may import an assistant package), but it means the store was "
        "unbound when it was read:")
    for row in rows[:20]:
        terminalreporter.write_line(row)
    if len(rows) > 20:
        terminalreporter.write_line(f"  … {len(rows) - 20} more")
