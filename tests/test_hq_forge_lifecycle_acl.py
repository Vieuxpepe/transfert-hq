"""Windows ACL checks for the lifecycle CSRF key.

Disposable directories only. These tests do not bind ports 8765 or 8776,
do not read production session files, and do not print key bytes.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_csrf_key as csrf_key  # noqa: E402

USER_SID = "S-1-5-21-1694431014-2109757714-444209346-1003"
BROAD = ("S-1-1-0", "S-1-5-32-545", "S-1-5-11")
EVIDENCE: list[dict] = []


def set_directory_acl(path: Path, extra_sids: list[str]) -> None:
    grants = [
        f"*{USER_SID}:(OI)(CI)M",
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
    ]
    grants.extend(f"*{sid}:(OI)(CI)R" for sid in extra_sids)
    granted = subprocess.run(["icacls", str(path), "/grant:r", *grants], capture_output=True, text=True, encoding="utf-8", errors="replace")
    removed = subprocess.run(["icacls", str(path), "/inheritance:r"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if granted.returncode != 0 or removed.returncode != 0:
        raise AssertionError(((granted.stderr or granted.stdout) + (removed.stderr or removed.stdout)).strip())


def _kernel():
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    kernel.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    return kernel


def raw_read(path: Path) -> bytes:
    """Read with the rights the runtime ACE grants. Python's generic open asks for more."""
    import ctypes
    from ctypes import wintypes

    kernel = _kernel()
    handle = kernel.CreateFileW(str(path), 0x1 | 0x100000, 1, None, 3, 0x80, None)
    invalid = wintypes.HANDLE(-1).value
    if not handle or handle == invalid:
        raise OSError(ctypes.get_last_error())
    try:
        return _read_handle(kernel, handle, path.stat().st_size)
    finally:
        kernel.CloseHandle(handle)


def _read_handle(kernel, handle, size: int) -> bytes:
    import ctypes
    from ctypes import wintypes

    buffer = ctypes.create_string_buffer(size)
    read = wintypes.DWORD()
    if not kernel.ReadFile(handle, buffer, size, ctypes.byref(read), None):
        raise OSError(ctypes.get_last_error())
    return buffer.raw[: read.value]


def raw_write(path: Path, data: bytes) -> None:
    import ctypes
    from ctypes import wintypes

    kernel = _kernel()
    handle = kernel.CreateFileW(str(path), csrf_key.OWNER_ACCESS_MASK, 0, None, 3, 0x80, None)
    invalid = wintypes.HANDLE(-1).value
    if not handle or handle == invalid:
        raise OSError(ctypes.get_last_error())
    try:
        kernel.SetFilePointer(handle, 0, None, 0)
        kernel.SetEndOfFile(handle)
        written = wintypes.DWORD()
        if data and not kernel.WriteFile(handle, data, len(data), ctypes.byref(written), None):
            raise OSError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(handle)


def icacls(path: Path) -> str:
    completed = subprocess.run(
        ["icacls", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return (completed.stdout or "") + (completed.stderr or "")


class CsrfKeyAcl(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="m2b-acl-")
        self.root = Path(self.tmp.name)
        self.sessions = self.root / "bridge_sessions.json"
        self.sessions.write_text("{}", encoding="utf-8")

    def tearDown(self) -> None:
        for name in ("junction", "lifecycle-csrf.key"):
            path = self.root / name
            if path.exists():
                if path.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    subprocess.run(["cmd", "/c", "rmdir", str(path)], check=False)
                else:
                    subprocess.run(["cmd", "/c", "icacls", str(path), "/reset"], capture_output=True, check=False)
                    try:
                        path.unlink()
                    except Exception:
                        pass
        try:
            self.tmp.cleanup()
        except Exception:
            pass

    def assert_tight(self, facts: dict) -> None:
        self.assertTrue(facts["acceptable"], facts)
        self.assertTrue(facts["protected"])
        self.assertEqual(facts["owner"], USER_SID)
        masks = {ace["sid"]: ace["mask"] for ace in facts["aces"]}
        self.assertEqual(masks[USER_SID], csrf_key.OWNER_ACCESS_MASK)
        self.assertEqual(masks["S-1-5-18"], csrf_key.READER_ACCESS_MASK)
        self.assertEqual(masks["S-1-5-32-544"], csrf_key.READER_ACCESS_MASK)
        self.assertTrue(all(ace["inherited"] is False for ace in facts["aces"]))
        for sid in BROAD:
            self.assertNotIn(sid, masks)

    def test_permissive_parent_does_not_inherit(self) -> None:
        set_directory_acl(self.root, list(BROAD))
        before = self.sessions.read_bytes()
        first = csrf_key.ensure_csrf_key(self.sessions)
        second = csrf_key.ensure_csrf_key(self.sessions)
        self.assertEqual(len(first), 32)
        self.assertEqual(first, second)
        self.assertEqual(self.sessions.read_bytes(), before)
        facts = csrf_key.describe_csrf_key_acl(self.sessions)
        self.assert_tight(facts)
        listed = icacls(self.root / "lifecycle-csrf.key")
        self.assertNotIn("(I)", listed)
        self.assertNotIn("Everyone", listed)
        self.assertNotIn("Authenticated Users", listed)
        self.assertNotIn("Utilisateurs", listed)
        EVIDENCE.append({"test": "permissive-parent", "acceptable": True, "inherited": False, "broad": False})

    def test_restrictive_parent_and_second_process(self) -> None:
        set_directory_acl(self.root, [])
        code = (
            "import sys\nfrom pathlib import Path\n"
            f"sys.path.insert(0, {str(SOURCE)!r})\n"
            "import hq_forge_csrf_key as key\n"
            "value = key.ensure_csrf_key(Path(sys.argv[1]))\n"
            "Path(sys.argv[2]).write_bytes(value)\n"
        )
        left = self.root / "left.bin"
        right = self.root / "right.bin"
        subprocess.check_call([sys.executable, "-c", code, str(self.sessions), str(left)])
        subprocess.check_call([sys.executable, "-c", code, str(self.sessions), str(right)])
        self.assertEqual(left.read_bytes(), right.read_bytes())
        self.assertEqual(len(left.read_bytes()), 32)
        left.unlink()
        right.unlink()
        self.assert_tight(csrf_key.describe_csrf_key_acl(self.sessions))
        EVIDENCE.append({"test": "two-process", "equal": True, "acceptable": True})

    def test_planted_broad_file_is_not_repaired(self) -> None:
        key_path = self.root / "lifecycle-csrf.key"
        key_path.write_bytes(b"\x11" * 32)
        subprocess.check_call(["icacls", str(key_path), "/grant", "*S-1-1-0:R"], stdout=subprocess.DEVNULL)
        before = raw_read(key_path)
        with self.assertRaises(RuntimeError) as caught:
            csrf_key.ensure_csrf_key(self.sessions)
        self.assertEqual(str(caught.exception), "csrf key rejected")
        self.assertEqual(raw_read(key_path), before)
        self.assertIsNone(csrf_key.load_csrf_key(self.sessions))
        facts = csrf_key.describe_csrf_key_acl(self.sessions)
        self.assertFalse(facts["acceptable"])
        self.assertTrue(any(ace["sid"] == "S-1-1-0" for ace in facts["aces"]))
        EVIDENCE.append({"test": "planted", "repaired": False, "message": str(caught.exception)})

    def test_inherited_and_alternate_principal_are_rejected(self) -> None:
        inherited = self.root / "lifecycle-csrf.key"
        inherited.write_bytes(b"\x22" * 32)
        before = raw_read(inherited)
        with self.assertRaises(RuntimeError):
            csrf_key.ensure_csrf_key(self.sessions)
        self.assertEqual(raw_read(inherited), before)
        facts = csrf_key.describe_csrf_key_acl(self.sessions)
        self.assertTrue(any(ace["inherited"] for ace in facts["aces"]))
        inherited.unlink()
        csrf_key.ensure_csrf_key(self.sessions)
        key_path = self.root / "lifecycle-csrf.key"
        original = raw_read(key_path)
        subprocess.check_call(["icacls", str(key_path), "/grant", "*S-1-5-32-546:R"], stdout=subprocess.DEVNULL)
        with self.assertRaises(RuntimeError) as caught:
            csrf_key.ensure_csrf_key(self.sessions)
        self.assertEqual(str(caught.exception), "csrf key rejected")
        self.assertEqual(raw_read(key_path), original)
        self.assertFalse(csrf_key.describe_csrf_key_acl(self.sessions)["acceptable"])
        EVIDENCE.append({"test": "inherited-and-guests", "repaired": False})

    def test_dangerous_admin_rights_are_rejected(self) -> None:
        original = csrf_key.ensure_csrf_key(self.sessions)
        key_path = self.root / "lifecycle-csrf.key"
        subprocess.check_call(["icacls", str(key_path), "/grant", "*S-1-5-32-544:F"], stdout=subprocess.DEVNULL)
        with self.assertRaises(RuntimeError):
            csrf_key.ensure_csrf_key(self.sessions)
        self.assertEqual(raw_read(key_path), original)
        masks = {ace["sid"]: ace["mask"] for ace in csrf_key.describe_csrf_key_acl(self.sessions)["aces"]}
        self.assertNotEqual(masks.get("S-1-5-32-544"), csrf_key.READER_ACCESS_MASK)
        EVIDENCE.append({"test": "admin-full-control", "repaired": False})

    def test_malformed_and_unreadable_keys_stay_in_place(self) -> None:
        csrf_key.ensure_csrf_key(self.sessions)
        key_path = self.root / "lifecycle-csrf.key"
        raw_write(key_path, b"\x33" * 31)
        with self.assertRaises(RuntimeError) as caught:
            csrf_key.ensure_csrf_key(self.sessions)
        self.assertEqual(str(caught.exception), "csrf key unreadable")
        self.assertEqual(key_path.stat().st_size, 31)
        key_path.unlink()
        original = csrf_key.ensure_csrf_key(self.sessions)
        kernel = _kernel()
        held = kernel.CreateFileW(str(key_path), 0x1 | 0x100000, 7, None, 3, 0x80, None)
        self.assertTrue(held)
        try:
            subprocess.check_call(["icacls", str(key_path), "/deny", f"*{USER_SID}:(R)"], stdout=subprocess.DEVNULL)
            with self.assertRaises(RuntimeError):
                csrf_key.ensure_csrf_key(self.sessions)
            self.assertEqual(key_path.stat().st_size, 32)
            self.assertEqual(_read_handle(kernel, held, 32), original)
        finally:
            kernel.CloseHandle(held)
        EVIDENCE.append({"test": "malformed-and-deny", "replaced": False})

    def test_junction_and_reparse_file_are_not_followed(self) -> None:
        target = self.root / "target"
        target.mkdir()
        (target / "bridge_sessions.json").write_text("{}", encoding="utf-8")
        junction = self.root / "junction"
        completed = subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(target)], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        with self.assertRaises(RuntimeError) as caught:
            csrf_key.ensure_csrf_key(junction / "bridge_sessions.json")
        self.assertEqual(str(caught.exception), "csrf key path rejected")
        self.assertFalse((target / "lifecycle-csrf.key").exists())
        self.assertIsNone(csrf_key.load_csrf_key(junction / "bridge_sessions.json"))
        link = self.root / "lifecycle-csrf.key"
        link_target = self.root / "elsewhere"
        link_target.mkdir()
        completed = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(link_target)], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        with self.assertRaises(RuntimeError):
            csrf_key.ensure_csrf_key(self.sessions)
        self.assertEqual(list(link_target.iterdir()), [])
        EVIDENCE.append({"test": "junction", "followed": False})

    def test_concurrent_creators_share_one_protected_key(self) -> None:
        code = (
            "import sys\nfrom pathlib import Path\n"
            f"sys.path.insert(0, {str(SOURCE)!r})\n"
            "import hq_forge_csrf_key as key\n"
            "value = key.ensure_csrf_key(Path(sys.argv[1]))\n"
            "Path(sys.argv[2]).write_bytes(value)\n"
        )
        procs = []
        outs = []
        for index in range(8):
            out = self.root / f"child-{index}.bin"
            outs.append(out)
            procs.append(subprocess.Popen(
                [sys.executable, "-c", code, str(self.sessions), str(out)],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            ))
        failures = []
        for proc in procs:
            _stdout, err = proc.communicate(timeout=30)
            if proc.returncode != 0:
                failures.append((err or b"").decode("utf-8", errors="replace")[-180:])
        blobs = [path.read_bytes() for path in outs if path.is_file()]
        for path in outs:
            if path.exists():
                path.unlink()
        self.assertEqual(failures, [])
        self.assertEqual(len(blobs), 8)
        self.assertTrue(all(item == blobs[0] for item in blobs))
        self.assertEqual(len(blobs[0]), 32)
        self.assertEqual((self.root / "lifecycle-csrf.key").stat().st_size, 32)
        self.assert_tight(csrf_key.describe_csrf_key_acl(self.sessions))
        EVIDENCE.append({"test": "concurrent", "processes": 8, "equal": True, "acceptable": True})

    def test_zero_byte_exact_key_is_recovered_once(self) -> None:
        csrf_key.ensure_csrf_key(self.sessions)
        key_path = self.root / "lifecycle-csrf.key"
        raw_write(key_path, b"")
        self.assertEqual(key_path.stat().st_size, 0)
        recovered = csrf_key.ensure_csrf_key(self.sessions)
        self.assertEqual(len(recovered), 32)
        self.assertEqual(raw_read(key_path), recovered)
        self.assertEqual(csrf_key.ensure_csrf_key(self.sessions), recovered)
        self.assert_tight(csrf_key.describe_csrf_key_acl(self.sessions))
        EVIDENCE.append({"test": "zero-recovery", "completed": True, "stable": True})

    def test_unsafe_zero_byte_file_is_not_recovered(self) -> None:
        key_path = self.root / "lifecycle-csrf.key"
        key_path.write_bytes(b"")
        with self.assertRaises(RuntimeError) as caught:
            csrf_key.ensure_csrf_key(self.sessions)
        self.assertEqual(str(caught.exception), "csrf key rejected")
        self.assertEqual(key_path.stat().st_size, 0)
        self.assertFalse(csrf_key.describe_csrf_key_acl(self.sessions)["acceptable"])
        self.assertIsNone(csrf_key.load_csrf_key(self.sessions))
        EVIDENCE.append({"test": "unsafe-zero", "repaired": False})

    def test_missing_parent_fails_closed(self) -> None:
        missing = self.root / "missing-parent" / "bridge_sessions.json"
        with self.assertRaises(RuntimeError) as caught:
            csrf_key.ensure_csrf_key(missing)
        self.assertEqual(str(caught.exception), "csrf key path rejected")
        self.assertFalse(missing.parent.exists())
        EVIDENCE.append({"test": "missing-parent", "created": False})

    def test_symlink_and_mount_point_tag_are_rejected(self) -> None:
        target = self.root / "mount-target"
        target.mkdir()
        (target / "bridge_sessions.json").write_text("{}", encoding="utf-8")
        junction = self.root / "mount-junction"
        completed = subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(target)], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        tag = _reparse_tag(junction)
        self.assertEqual(tag, 0xA0000003)
        with self.assertRaises(RuntimeError):
            csrf_key.ensure_csrf_key(junction / "bridge_sessions.json")
        self.assertFalse((target / "lifecycle-csrf.key").exists())
        link = self.root / "sym-dir"
        completed = subprocess.run(["cmd", "/c", "mklink", "/D", str(link), str(target)], capture_output=True, text=True)
        if completed.returncode == 0:
            with self.assertRaises(RuntimeError):
                csrf_key.ensure_csrf_key(link / "bridge_sessions.json")
            self.assertFalse((target / "lifecycle-csrf.key").exists())
            symlink = "rejected"
        else:
            symlink = "not-created"
        EVIDENCE.append({"test": "mount-point", "tag": hex(tag), "symlink": symlink, "followed": False})

    def test_concurrent_recovery_agrees(self) -> None:
        csrf_key.ensure_csrf_key(self.sessions)
        raw_write(self.root / "lifecycle-csrf.key", b"")
        code = (
            "import sys\nfrom pathlib import Path\n"
            f"sys.path.insert(0, {str(SOURCE)!r})\n"
            "import hq_forge_csrf_key as key\n"
            "value = key.ensure_csrf_key(Path(sys.argv[1]))\n"
            "Path(sys.argv[2]).write_bytes(value)\n"
        )
        procs = []
        outs = []
        for index in range(8):
            out = self.root / f"recover-{index}.bin"
            outs.append(out)
            procs.append(subprocess.Popen(
                [sys.executable, "-c", code, str(self.sessions), str(out)],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            ))
        failures = []
        for proc in procs:
            _stdout, err = proc.communicate(timeout=30)
            if proc.returncode != 0:
                failures.append((err or b"").decode("utf-8", errors="replace")[-240:])
        blobs = [path.read_bytes() for path in outs if path.is_file()]
        for path in outs:
            if path.exists():
                path.unlink()
        self.assertEqual(failures, [])
        self.assertEqual(len(blobs), 8)
        self.assertTrue(all(item == blobs[0] for item in blobs))
        self.assertEqual(len(blobs[0]), 32)
        self.assert_tight(csrf_key.describe_csrf_key_acl(self.sessions))
        EVIDENCE.append({"test": "concurrent-recovery", "processes": 8, "equal": True})

    def test_production_path_is_refused(self) -> None:
        with self.assertRaises(RuntimeError):
            csrf_key.ensure_csrf_key(Path(r"C:\Transfert\bridge_sessions.json"))
        self.assertFalse(Path(r"C:\Transfert\lifecycle-csrf.key").exists())


def _reparse_tag(path: Path) -> int:
    import ctypes
    from ctypes import wintypes

    kernel = _kernel()
    handle = kernel.CreateFileW(str(path), 0x80, 1, None, 3, 0x02200000, None)
    invalid = wintypes.HANDLE(-1).value
    if not handle or handle == invalid:
        raise OSError(ctypes.get_last_error())
    try:
        class Tag(ctypes.Structure):
            _fields_ = (("FileAttributes", wintypes.DWORD), ("ReparseTag", wintypes.DWORD))
        kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
        kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
        info = Tag()
        if not kernel.GetFileInformationByHandleEx(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            raise OSError(ctypes.get_last_error())
        return int(info.ReparseTag)
    finally:
        kernel.CloseHandle(handle)


def tearDownModule() -> None:
    destination = os.environ.get("HQ_ACL_EVIDENCE")
    if destination:
        Path(destination).write_text(json.dumps({"cases": EVIDENCE}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
