"""Dry-run recovery for a future exact-port maintenance window.

The state file cannot name a command. A checksum detects accidental
corruption; it is not an authentication seal. Access is enforced by an exact
protected DACL on the file and on its parent directory. Live stops, HQ
startup, and Tailscale Serve changes stay disabled.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from ctypes import wintypes
from pathlib import Path

MAX_AGE_SEC = 7200
PRODUCTION_HEAD = "17831623039814a7a010537848efa5424294cea8"
WORKTREE_HEAD = "75214254a7de365a58e239b2b1bf4103a209f14d"
PRODUCTION_ROOT = Path(r"C:\Transfert")
PYTHON_EXE = r"C:\Python313\python.exe"
PY_EXE = r"C:\Windows\py.exe"
FORGE_EXECUTABLE = r"C:\Program Files\Python310\python.exe"
FORGE_SCRIPT = "launch.py"
PRODUCTION_SCRIPT = r"C:\Transfert\iphone_bridge.py"
PAGE_SCRIPT = r"C:\Transfert-worktrees\forge-lifecycle-m1\tests\m2b_exact_port_page.py"
LISTENER_SCRIPT = r"C:\Transfert-worktrees\forge-lifecycle-m1\tests\m2b_exact_port_listener.py"
TEST_EXECUTABLES = frozenset({PYTHON_EXE.casefold(), PY_EXE.casefold()})
HQ_LAUNCH = (
    r"C:\Windows\System32\wscript.exe",
    r"C:\Transfert\start_bridge_hidden.vbs",
)
SERVE_RESTORE = (
    "tailscale",
    "serve",
    "--bg",
    "--https=443",
    "--set-path=/",
    "http://127.0.0.1:8765",
)
MAINTENANCE_RECOVERY_ENABLED = False
PHASES = frozenset({
    "serve-paused",
    "hq-stopped",
    "test-running",
    "listener-down",
    "ports-free",
    "hq-verified",
    "restored",
})
PORT_NAMES = ("8765", "8766", "7860", "8776")
BROAD_SIDS = frozenset({
    "S-1-1-0",
    "S-1-5-32-545",
    "S-1-5-11",
    "S-1-5-32-546",
})
SYSTEM_SID = "S-1-5-18"
ADMINS_SID = "S-1-5-32-544"
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
INHERITED_ACE = 0x10
FILE_OWNER_MASK = 0x12019F
FILE_READER_MASK = 0x120089
DIR_OWNER_MASK = 0x1300EF
DIR_READER_MASK = 0x1200A9
STATE_NAME = "window-state.json"
SERVE_NAME = "serve-snapshot.json"
CANONICAL_SERVE_BYTES = (
    b'{"TCP":{"443":{"HTTPS":true}},'
    b'"Web":{"vieuxpeepee.taila4d470.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8765"}}}}}'
)
WORKTREE_ROOT = Path(r"C:\Transfert-worktrees\forge-lifecycle-m1")


class RecoveryError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _norm(value: str) -> str:
    return str(Path(value)).casefold()


def _exe(value: str) -> str:
    return str(value).casefold()


def canonical_payload(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def checksum_wrapper(payload: dict) -> dict:
    """Pair a payload with a corruption checksum. This does not authenticate the writer."""
    body = canonical_payload(payload)
    return {"payload": payload, "checksum": hashlib.sha256(body).hexdigest()}


def assert_state_path(path: Path) -> Path:
    resolved = Path(path).resolve()
    parent = resolved.parent
    temp = Path(tempfile.gettempdir()).resolve()
    production = PRODUCTION_ROOT.resolve()
    worktree = WORKTREE_ROOT.resolve()
    if resolved.name != STATE_NAME or parent.parent != temp or not parent.name.startswith("m2b-exact-"):
        raise RecoveryError("unauthorized")
    if resolved == production or production in resolved.parents or worktree in resolved.parents:
        raise RecoveryError("unauthorized")
    return resolved


def assert_serve_path(state: Path, serve: Path) -> Path:
    resolved_state = assert_state_path(state)
    resolved_serve = Path(serve).resolve()
    if resolved_serve.parent != resolved_state.parent or resolved_serve.name != SERVE_NAME:
        raise RecoveryError("unauthorized")
    return resolved_serve


def _kernel():
    import ctypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    return ctypes, kernel


def _reparse(path: Path) -> bool:
    ctypes, kernel = _kernel()
    kernel.GetFileAttributesW.argtypes = [wintypes.LPCWSTR]
    kernel.GetFileAttributesW.restype = wintypes.DWORD
    attrs = int(kernel.GetFileAttributesW(str(path)))
    if attrs == 0xFFFFFFFF:
        return True
    return (attrs & FILE_ATTRIBUTE_REPARSE_POINT) != 0


def current_user_sid() -> str:
    import ctypes
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    advapi.OpenProcessToken.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    advapi.OpenProcessToken.restype = wintypes.BOOL
    advapi.GetTokenInformation.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)
    ]
    advapi.GetTokenInformation.restype = wintypes.BOOL
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
    advapi.ConvertSidToStringSidW.restype = wintypes.BOOL
    token = ctypes.c_void_p()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
        raise OSError(ctypes.get_last_error())
    try:
        needed = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        buf = ctypes.create_string_buffer(max(needed.value, 8))
        if not advapi.GetTokenInformation(token, 1, buf, len(buf), ctypes.byref(needed)):
            raise OSError(ctypes.get_last_error())
        sid_ptr = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
        text = ctypes.c_wchar_p()
        if not advapi.ConvertSidToStringSidW(sid_ptr, ctypes.byref(text)):
            raise OSError(ctypes.get_last_error())
        try:
            return text.value
        finally:
            kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))
    finally:
        kernel.CloseHandle(token)


def _icacls(path: Path, args: list[str]) -> None:
    completed = subprocess.run(
        ["icacls", str(path), *args],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        raise RecoveryError("unauthorized")


def protect_state_file(path: Path) -> None:
    sid = current_user_sid()
    _icacls(path, [
        "/inheritance:r",
        "/grant:r", f"*{sid}:(R,W)",
        "/grant:r", "*S-1-5-18:(R)",
        "/grant:r", "*S-1-5-32-544:(R)",
    ])
    if not dacl_acceptable(path, kind="file"):
        raise RecoveryError("unauthorized")


def protect_state_directory(path: Path) -> None:
    sid = current_user_sid()
    _icacls(path, ["/inheritance:r"])
    _icacls(path, ["/remove:g", "*S-1-5-18", "*S-1-5-32-544", "*S-1-1-0", "*S-1-5-32-545", "*S-1-5-11", "*S-1-3-4", f"*{sid}"])
    _icacls(path, [
        "/grant:r", f"*{sid}:(RD,WD,AD,X,DC,RA,REA,RC,S,DE)",
        "/grant:r", "*S-1-5-18:(RD,X,RA,REA,RC,S)",
        "/grant:r", "*S-1-5-32-544:(RD,X,RA,REA,RC,S)",
    ])
    if not dacl_acceptable(path, kind="directory"):
        raise RecoveryError("unauthorized")


def dacl_acceptable(path: Path, *, kind: str) -> bool:
    import ctypes
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    advapi.GetNamedSecurityInfoW.argtypes = [
        wintypes.LPCWSTR,
        ctypes.c_int,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    advapi.GetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi.GetSecurityDescriptorControl.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.DWORD)
    ]
    advapi.GetSecurityDescriptorControl.restype = wintypes.BOOL
    advapi.GetSecurityDescriptorDacl.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(wintypes.BOOL),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.BOOL),
    ]
    advapi.GetSecurityDescriptorDacl.restype = wintypes.BOOL
    advapi.GetAclInformation.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.c_int]
    advapi.GetAclInformation.restype = wintypes.BOOL
    advapi.GetAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    advapi.GetAce.restype = wintypes.BOOL
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
    advapi.ConvertSidToStringSidW.restype = wintypes.BOOL

    class AclSize(ctypes.Structure):
        _fields_ = [("AceCount", wintypes.DWORD), ("AclBytesInUse", wintypes.DWORD), ("AclBytesFree", wintypes.DWORD)]

    owner = ctypes.c_void_p()
    dacl = ctypes.c_void_p()
    sd = ctypes.c_void_p()
    status = advapi.GetNamedSecurityInfoW(
        str(path), 1, 0x1 | 0x4, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(sd)
    )
    if status != 0 or not sd:
        return False
    try:
        control = wintypes.WORD()
        revision = wintypes.DWORD()
        if not advapi.GetSecurityDescriptorControl(sd, ctypes.byref(control), ctypes.byref(revision)):
            return False
        if (int(control.value) & 0x1000) == 0:
            return False
        owner_text = ctypes.c_wchar_p()
        if not advapi.ConvertSidToStringSidW(owner, ctypes.byref(owner_text)):
            return False
        try:
            if owner_text.value != current_user_sid():
                return False
        finally:
            kernel.LocalFree(ctypes.cast(owner_text, ctypes.c_void_p))
        present = wintypes.BOOL()
        defaulted = wintypes.BOOL()
        acl = ctypes.c_void_p()
        if not advapi.GetSecurityDescriptorDacl(sd, ctypes.byref(present), ctypes.byref(acl), ctypes.byref(defaulted)):
            return False
        if not present.value or not acl or defaulted.value:
            return False
        info = AclSize()
        if not advapi.GetAclInformation(acl, ctypes.byref(info), ctypes.sizeof(info), 2):
            return False
        if int(info.AceCount) != 3:
            return False
        user = current_user_sid()
        owner_mask = FILE_OWNER_MASK if kind == "file" else DIR_OWNER_MASK
        reader_mask = FILE_READER_MASK if kind == "file" else DIR_READER_MASK
        expected = {user: owner_mask, SYSTEM_SID: reader_mask, ADMINS_SID: reader_mask}
        seen: dict[str, int] = {}
        for index in range(3):
            ace = ctypes.c_void_p()
            if not advapi.GetAce(acl, index, ctypes.byref(ace)):
                return False
            header = ctypes.cast(ace, ctypes.POINTER(ctypes.c_ubyte))
            ace_type = int(header[0])
            ace_flags = int(header[1])
            if ace_type != 0 or ace_flags != 0 or (ace_flags & INHERITED_ACE):
                return False
            mask = int.from_bytes(ctypes.string_at(ace.value + 4, 4), "little")
            sid_text = ctypes.c_wchar_p()
            if not advapi.ConvertSidToStringSidW(ace.value + 8, ctypes.byref(sid_text)):
                return False
            try:
                sid = sid_text.value
            finally:
                kernel.LocalFree(ctypes.cast(sid_text, ctypes.c_void_p))
            if sid in BROAD_SIDS or sid in seen or sid not in expected or mask != expected[sid]:
                return False
            seen[sid] = mask
        return set(seen) == set(expected)
    finally:
        kernel.LocalFree(sd)


def process_argv(pid: int) -> list[str] | None:
    """Return exact argv elements. None when the process cannot be read."""
    import ctypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    ntdll.NtQueryInformationProcess.argtypes = [
        wintypes.HANDLE, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)
    ]
    ntdll.NtQueryInformationProcess.restype = ctypes.c_long
    handle = kernel.OpenProcess(0x1000, False, int(pid))
    if not handle:
        return None
    try:
        needed = ctypes.c_ulong(0)
        size = 4096
        command = None
        for _ in range(6):
            buf = ctypes.create_string_buffer(size)
            status = int(ntdll.NtQueryInformationProcess(handle, 60, buf, size, ctypes.byref(needed)))
            if status == 0:
                length = int.from_bytes(buf.raw[0:2], "little")
                pointer = int.from_bytes(buf.raw[8:16], "little")
                command = ctypes.wstring_at(pointer, length // 2) if pointer and length else ""
                break
            if ctypes.c_uint32(status).value != 0xC0000004:
                return None
            size = max(int(needed.value), size * 2)
        if command is None:
            return None
    finally:
        kernel.CloseHandle(handle)
    shell32.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    shell32.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
    count = ctypes.c_int()
    array = shell32.CommandLineToArgvW(command, ctypes.byref(count))
    if not array:
        return None
    try:
        return [array[index] for index in range(int(count.value))]
    finally:
        kernel.LocalFree(ctypes.cast(array, ctypes.c_void_p))


def _record_keys(value: dict, script_rule) -> None:
    if type(value) is not dict or set(value) != {"pid", "creation", "executable", "script"}:
        raise RecoveryError("malformed")
    if type(value["pid"]) is not int or type(value["creation"]) is not int:
        raise RecoveryError("malformed")
    if value["pid"] <= 0 or value["creation"] <= 0:
        raise RecoveryError("malformed")
    if type(value["executable"]) is not str or type(value["script"]) is not str:
        raise RecoveryError("malformed")
    script_rule(value)


def _page_rule(value: dict) -> None:
    if _exe(value["executable"]) not in TEST_EXECUTABLES or _norm(value["script"]) != _norm(PAGE_SCRIPT):
        raise RecoveryError("inconsistent")


def _listener_rule(value: dict) -> None:
    if _exe(value["executable"]) not in TEST_EXECUTABLES or _norm(value["script"]) != _norm(LISTENER_SCRIPT):
        raise RecoveryError("inconsistent")


def _production_rule(value: dict) -> None:
    if _exe(value["executable"]) != _exe(PYTHON_EXE) or _norm(value["script"]) != _norm(PRODUCTION_SCRIPT):
        raise RecoveryError("inconsistent")


def _forge_rule(value: dict) -> None:
    if _exe(value["executable"]) != _exe(FORGE_EXECUTABLE) or value["script"] != FORGE_SCRIPT:
        raise RecoveryError("inconsistent")


def _optional_record(value, rule) -> None:
    if value is None:
        return
    _record_keys(value, rule)


def _port_record(value) -> None:
    if value is None:
        return
    if type(value) is not dict or set(value) != {"pid", "creation", "executable", "script"}:
        raise RecoveryError("malformed")
    if type(value["pid"]) is not int or type(value["creation"]) is not int or value["pid"] <= 0 or value["creation"] <= 0:
        raise RecoveryError("malformed")
    if type(value["executable"]) is not str or type(value["script"]) is not str or not value["executable"] or not value["script"]:
        raise RecoveryError("malformed")


def validate_payload(payload: dict, *, now: int) -> dict:
    if type(payload) is not dict:
        raise RecoveryError("malformed")
    expected = {
        "version", "written_at", "production_head", "worktree_head", "phase",
        "maintenance_authorized", "forge", "production_hq", "stopped_hq",
        "test_page", "listener", "ports", "serve",
    }
    if set(payload) != expected:
        raise RecoveryError("malformed")
    if payload["version"] != 1 or type(payload["written_at"]) is not int or type(now) is not int:
        raise RecoveryError("malformed")
    if payload["written_at"] > now + 300:
        raise RecoveryError("inconsistent")
    if now - payload["written_at"] > MAX_AGE_SEC:
        raise RecoveryError("stale")
    if payload["production_head"] != PRODUCTION_HEAD or payload["worktree_head"] != WORKTREE_HEAD:
        raise RecoveryError("inconsistent")
    if payload["maintenance_authorized"] is not False:
        raise RecoveryError("inconsistent")
    if payload["phase"] not in PHASES:
        raise RecoveryError("malformed")
    _record_keys(payload["forge"], _forge_rule)
    _optional_record(payload["production_hq"], _production_rule)
    _optional_record(payload["stopped_hq"], _production_rule)
    _optional_record(payload["test_page"], _page_rule)
    _optional_record(payload["listener"], _listener_rule)
    ports = payload["ports"]
    if type(ports) is not dict or set(ports) != set(PORT_NAMES):
        raise RecoveryError("malformed")
    for name in PORT_NAMES:
        _port_record(ports[name])
    serve = payload["serve"]
    if type(serve) is not dict or set(serve) != {"paused", "config_checksum", "funnel"}:
        raise RecoveryError("malformed")
    if type(serve["paused"]) is not bool or serve["funnel"] is not False:
        raise RecoveryError("inconsistent")
    digest = serve["config_checksum"]
    if type(digest) is not str or len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
        raise RecoveryError("malformed")
    _phase_consistent(payload)
    return payload


def _same_pair(left: dict | None, right: dict | None) -> bool:
    if left is None or right is None:
        return left is right
    return (
        left["pid"] == right["pid"]
        and left["creation"] == right["creation"]
        and _exe(left["executable"]) == _exe(right["executable"])
        and _norm(left["script"]) == _norm(right["script"])
    )


def _phase_consistent(payload: dict) -> None:
    ports = payload["ports"]
    phase = payload["phase"]
    if phase == "serve-paused":
        if payload["serve"]["paused"] is not True or payload["production_hq"] is None:
            raise RecoveryError("inconsistent")
        if payload["test_page"] is not None or payload["listener"] is not None or payload["stopped_hq"] is not None:
            raise RecoveryError("inconsistent")
        if not _same_pair(ports["8765"], payload["production_hq"]) or not _same_pair(ports["8766"], payload["production_hq"]):
            raise RecoveryError("inconsistent")
        if ports["8776"] is not None:
            raise RecoveryError("inconsistent")
    elif phase == "test-running":
        if payload["test_page"] is None or payload["listener"] is None or payload["production_hq"] is not None:
            raise RecoveryError("inconsistent")
        if not _same_pair(ports["8765"], payload["test_page"]) or not _same_pair(ports["8776"], payload["listener"]):
            raise RecoveryError("inconsistent")
    elif phase == "listener-down":
        if payload["test_page"] is None or payload["listener"] is not None or ports["8776"] is not None:
            raise RecoveryError("inconsistent")
        if payload["production_hq"] is not None or not _same_pair(ports["8765"], payload["test_page"]):
            raise RecoveryError("inconsistent")
    elif phase in {"hq-stopped", "ports-free"}:
        if ports["8765"] is not None or ports["8766"] is not None or ports["8776"] is not None:
            raise RecoveryError("inconsistent")
        if payload["production_hq"] is not None or payload["test_page"] is not None or payload["listener"] is not None:
            raise RecoveryError("inconsistent")
        if payload["serve"]["paused"] is not True:
            raise RecoveryError("inconsistent")
    elif phase in {"hq-verified", "restored"}:
        if payload["production_hq"] is None or payload["test_page"] is not None or payload["listener"] is not None:
            raise RecoveryError("inconsistent")
        if not _same_pair(ports["8765"], payload["production_hq"]) or not _same_pair(ports["8766"], payload["production_hq"]):
            raise RecoveryError("inconsistent")
        if ports["8776"] is not None:
            raise RecoveryError("inconsistent")
        if phase == "restored" and payload["serve"]["paused"] is not False:
            raise RecoveryError("inconsistent")
        if phase == "hq-verified" and payload["serve"]["paused"] is not True:
            raise RecoveryError("inconsistent")
    if payload["forge"]["pid"] == (payload["test_page"] or {}).get("pid"):
        raise RecoveryError("inconsistent")
    if payload["production_hq"] is not None and payload["production_hq"]["pid"] == payload["forge"]["pid"]:
        raise RecoveryError("inconsistent")


def write_state(path: Path, payload: dict, *, now: int) -> None:
    resolved = assert_state_path(path)
    validate_payload(payload, now=now)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(json.dumps(checksum_wrapper(payload), sort_keys=True) + "\n", encoding="ascii")
    try:
        protect_state_file(resolved)
        protect_state_directory(resolved.parent)
    except Exception:
        release_disposable(resolved.parent)
        raise


def release_disposable(path: Path) -> None:
    """Restore delete rights on one disposable directory. Refuses every other path."""
    resolved = Path(path).resolve()
    temp = Path(tempfile.gettempdir()).resolve()
    if resolved.parent != temp or not resolved.name.startswith("m2b-exact-"):
        return
    sid = current_user_sid()
    subprocess.run(
        ["icacls", str(resolved), "/grant", f"*{sid}:(OI)(CI)(F)"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def load_state(path: Path, *, now: int) -> dict:
    resolved = assert_state_path(path)
    if not resolved.is_file():
        raise RecoveryError("absent")
    if _reparse(resolved) or _reparse(resolved.parent):
        raise RecoveryError("malformed")
    if not dacl_acceptable(resolved.parent, kind="directory") or not dacl_acceptable(resolved, kind="file"):
        raise RecoveryError("unauthorized")
    try:
        wrapper = json.loads(resolved.read_text(encoding="ascii"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise RecoveryError("malformed") from None
    if type(wrapper) is not dict or set(wrapper) != {"payload", "checksum"}:
        raise RecoveryError("malformed")
    payload = wrapper["payload"]
    try:
        body = canonical_payload(payload)
    except (TypeError, UnicodeEncodeError):
        raise RecoveryError("malformed") from None
    digest = hashlib.sha256(body).hexdigest()
    if type(wrapper["checksum"]) is not str or not hmac_equal(wrapper["checksum"], digest):
        raise RecoveryError("malformed")
    return validate_payload(payload, now=now)


def hmac_equal(left: str, right: str) -> bool:
    import hmac
    return hmac.compare_digest(left, right)


def serve_document_ok(document: dict) -> bool:
    if type(document) is not dict or "Funnel" in document or "funnel" in document:
        return False
    tcp = document.get("TCP")
    web = document.get("Web")
    if type(tcp) is not dict or type(web) is not dict or set(web) != {"vieuxpeepee.taila4d470.ts.net:443"}:
        return False
    https = tcp.get("443")
    if type(https) is not dict or https.get("HTTPS") is not True:
        return False
    handler = web["vieuxpeepee.taila4d470.ts.net:443"]
    if type(handler) is not dict:
        return False
    handlers = handler.get("Handlers")
    if type(handlers) is not dict or set(handlers) != {"/"}:
        return False
    proxy = handlers["/"].get("Proxy") if type(handlers["/"]) is dict else None
    return proxy == "http://127.0.0.1:8765"


def _script_matches(argv: list[str], script: str) -> bool:
    if script == FORGE_SCRIPT:
        return any(item == FORGE_SCRIPT for item in argv)
    wanted = _norm(script)
    return any(_norm(item) == wanted for item in argv)


def same_identity(observed: dict | None, expected: dict | None) -> bool:
    if observed is None or expected is None:
        return False
    if type(observed) is not dict or type(observed.get("argv")) is not list:
        return False
    if observed.get("pid") != expected["pid"] or observed.get("creation") != expected["creation"]:
        return False
    if _exe(str(observed.get("executable") or "")) != _exe(expected["executable"]):
        return False
    return _script_matches([str(item) for item in observed["argv"]], expected["script"])


def is_production(observed: dict | None) -> bool:
    if observed is None or type(observed.get("argv")) is not list:
        return False
    return _exe(str(observed.get("executable") or "")) == _exe(PYTHON_EXE) and _script_matches(observed["argv"], PRODUCTION_SCRIPT)


def is_forge(observed: dict | None, forge: dict) -> bool:
    if same_identity(observed, forge):
        return True
    if observed is None or type(observed.get("argv")) is not list:
        return False
    return _exe(str(observed.get("executable") or "")) == _exe(FORGE_EXECUTABLE) and any(
        item == FORGE_SCRIPT for item in observed["argv"]
    )


def _confirmed(expected: dict, observer) -> bool:
    first = observer(expected["pid"])
    second = observer(expected["pid"])
    return same_identity(first, expected) and same_identity(second, expected)


def _blocked(reason: str) -> dict:
    return {
        "next": "blocked",
        "performed": False,
        "restore_serve": False,
        "stop": None,
        "command": None,
        "report": reason,
    }


def _plan(next_action: str, *, stop: dict | None = None, command: tuple[str, ...] | None = None, report: str) -> dict:
    return {
        "next": next_action,
        "performed": False,
        "restore_serve": next_action == "restore-serve",
        "stop": stop,
        "command": list(command) if command is not None else None,
        "report": report,
    }


def build_plan(payload: dict, ports: dict, observer, *, serve_bytes: bytes | None) -> dict:
    """Choose one next action from a live port snapshot. Never performs it."""
    if set(ports) != set(PORT_NAMES):
        return _blocked("port snapshot is incomplete")
    serve_document = None
    if serve_bytes is not None:
        try:
            parsed = json.loads(serve_bytes.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            parsed = None
        serve_document = parsed if serve_document_ok(parsed) else None
    forge = payload["forge"]
    for name in PORT_NAMES:
        occupant = ports[name]
        if is_forge(occupant, forge):
            continue
        if occupant is not None and occupant.get("pid") == forge["pid"]:
            return _blocked("forge pid changed identity; no process will be stopped")
    listener_occupant = ports["8776"]
    page_occupant = ports["8765"]
    planner_occupant = ports["8766"]
    if is_forge(page_occupant, forge) or is_forge(listener_occupant, forge) or is_forge(planner_occupant, forge):
        return _blocked("forge occupies a lifecycle port; Serve stays untouched")
    if listener_occupant is not None:
        expected = payload["listener"]
        if (
            expected is None
            or is_production(listener_occupant)
            or is_forge(listener_occupant, forge)
            or not same_identity(listener_occupant, expected)
            or not _confirmed(expected, observer)
        ):
            return _blocked("port 8776 is not the recorded listener; Serve stays paused")
        return _plan("stop-listener", stop=expected, report="stop the recorded listener and run recovery again")
    if page_occupant is not None and not is_production(page_occupant):
        expected = payload["test_page"]
        if (
            expected is None
            or is_forge(page_occupant, forge)
            or not same_identity(page_occupant, expected)
            or not _confirmed(expected, observer)
        ):
            return _blocked("port 8765 is not the recorded test page; Serve stays paused")
        return _plan("stop-page", stop=expected, report="stop the recorded test page and run recovery again")
    if is_production(page_occupant):
        production = payload["production_hq"]
        if production is None or not _confirmed(production, observer):
            return _blocked("production HQ identity is not confirmed; it will not be stopped")
        if not is_production(planner_occupant) or planner_occupant.get("pid") != page_occupant.get("pid"):
            return _blocked("production HQ is not listening on both 8765 and 8766")
        if ports["8776"] is not None:
            return _blocked("listener still occupies 8776")
        if serve_bytes is None or serve_document is None:
            return _blocked("saved Serve configuration is missing or not the tailnet-only proxy")
        digest = hashlib.sha256(serve_bytes).hexdigest()
        if digest != payload["serve"]["config_checksum"]:
            return _blocked("saved Serve configuration does not match the state record")
        if payload["serve"]["paused"] is False:
            return _plan("none", report="production HQ and Serve already match; Serve was not reset")
        return _plan("restore-serve", command=SERVE_RESTORE, report="restore the saved tailnet-only Serve proxy")
    if page_occupant is None and planner_occupant is not None:
        return _blocked("port 8766 is occupied while 8765 is free; HQ will not be started")
    if page_occupant is None and planner_occupant is None:
        return _plan("start-hq", command=HQ_LAUNCH, report="start production HQ with the fixed launcher and run recovery again")
    return _blocked("no safe recovery action")


def commit_stop(expected: dict, observer) -> None:
    """Terminate only a rechecked test process, and only in a future authorization."""
    if MAINTENANCE_RECOVERY_ENABLED is not True:
        raise RecoveryError("disabled")
    if expected.get("script") not in {PAGE_SCRIPT, LISTENER_SCRIPT}:
        raise RecoveryError("blocked")
    if not _confirmed(expected, observer):
        raise RecoveryError("blocked")
    _terminate_checked(expected)


def commit_launch(command: tuple[str, ...]) -> None:
    if MAINTENANCE_RECOVERY_ENABLED is not True or tuple(command) != HQ_LAUNCH:
        raise RecoveryError("disabled")
    raise RecoveryError("disabled")


def commit_serve(command: tuple[str, ...]) -> None:
    if MAINTENANCE_RECOVERY_ENABLED is not True or tuple(command) != SERVE_RESTORE:
        raise RecoveryError("disabled")
    if "reset" in command or "funnel" in command:
        raise RecoveryError("blocked")
    raise RecoveryError("disabled")


def _terminate_checked(expected: dict) -> None:
    """Recheck the live process, then terminate it. Unreachable while recovery is disabled."""
    import ctypes
    import hq_forge_lifecycle as life

    pid = int(expected["pid"])
    observed = {
        "pid": pid,
        "creation": life.process_creation(pid),
        "executable": life.process_image(pid) or "",
        "argv": process_argv(pid) or [],
    }
    if not same_identity(observed, expected) or is_production(observed) or is_forge(observed, {
        "pid": pid, "creation": observed["creation"], "executable": FORGE_EXECUTABLE, "script": FORGE_SCRIPT
    }):
        raise RecoveryError("blocked")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.TerminateProcess.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x1001, False, pid)
    if not handle:
        raise RecoveryError("blocked")
    try:
        again = {
            "pid": pid,
            "creation": life.process_creation(pid),
            "executable": life.process_image(pid) or "",
            "argv": process_argv(pid) or [],
        }
        if again != observed or not same_identity(again, expected):
            raise RecoveryError("blocked")
        if not kernel.TerminateProcess(handle, 1):
            raise RecoveryError("blocked")
    finally:
        kernel.CloseHandle(handle)


def collect_ports() -> dict[str, dict | None]:
    """Read listeners on the four reserved ports. This does not stop a process."""
    import hq_forge_lifecycle as life

    completed = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    found: dict[str, dict | None] = {name: None for name in PORT_NAMES}
    for line in completed.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[3] != "LISTENING":
            continue
        for name in PORT_NAMES:
            if parts[1].endswith(":" + name):
                pid = int(parts[4])
                found[name] = {
                    "pid": pid,
                    "creation": life.process_creation(pid),
                    "executable": life.process_image(pid) or "",
                    "argv": process_argv(pid) or [],
                }
    return found


def live_observer(pid: int) -> dict | None:
    import hq_forge_lifecycle as life

    argv = process_argv(int(pid))
    image = life.process_image(int(pid))
    creation = life.process_creation(int(pid))
    if argv is None or not image or creation is None:
        return None
    return {"pid": int(pid), "creation": creation, "executable": image, "argv": argv}


def recover(path: Path, ports: dict, observer, *, now: int, serve_bytes: bytes | None, dry_run: bool) -> dict:
    """Validate the record and return a plan. This authorization never applies it."""
    try:
        payload = load_state(path, now=now)
    except RecoveryError as exc:
        return _blocked(exc.code)
    plan = build_plan(payload, ports, observer, serve_bytes=serve_bytes)
    plan["performed"] = False
    if dry_run is not True or MAINTENANCE_RECOVERY_ENABLED is not False:
        plan["next"] = "blocked"
        plan["restore_serve"] = False
        plan["stop"] = None
        plan["command"] = None
        plan["report"] = "maintenance recovery is disabled"
    return plan


def load_serve_file(path: Path) -> bytes:
    resolved = Path(path).resolve()
    if resolved.name != SERVE_NAME or _reparse(resolved) or not resolved.is_file():
        raise RecoveryError("malformed")
    if not dacl_acceptable(resolved, kind="file") or not dacl_acceptable(resolved.parent, kind="directory"):
        raise RecoveryError("unauthorized")
    raw = resolved.read_bytes()
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise RecoveryError("malformed") from None
    if not serve_document_ok(document):
        raise RecoveryError("inconsistent")
    return raw


def write_serve_file(path: Path, raw: bytes = CANONICAL_SERVE_BYTES) -> None:
    resolved = Path(path).resolve()
    if resolved.name != SERVE_NAME:
        raise RecoveryError("unauthorized")
    assert_state_path(resolved.parent / STATE_NAME)
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise RecoveryError("malformed") from None
    if not serve_document_ok(document):
        raise RecoveryError("inconsistent")
    resolved.write_bytes(raw)
    protect_state_file(resolved)


def write_observed_pause(state: Path, serve: Path) -> None:
    """Record the live production listener in a disposable state file. Stops nothing."""
    import time

    ports = collect_ports()
    page = ports.get("8765")
    planner = ports.get("8766")
    if ports.get("8776") is not None or not is_production(page) or not is_production(planner):
        raise RecoveryError("blocked")
    if page["pid"] != planner["pid"] or page["creation"] != planner["creation"]:
        raise RecoveryError("blocked")
    live_forge = (ports.get("7860") or {}).get("pid")
    forge_pid = 424242 if live_forge != 424242 else 424243
    hq = {
        "pid": int(page["pid"]),
        "creation": int(page["creation"]),
        "executable": PYTHON_EXE,
        "script": PRODUCTION_SCRIPT,
    }
    payload = {
        "version": 1,
        "written_at": int(time.time()),
        "production_head": PRODUCTION_HEAD,
        "worktree_head": WORKTREE_HEAD,
        "phase": "serve-paused",
        "maintenance_authorized": False,
        "forge": {"pid": forge_pid, "creation": 100, "executable": FORGE_EXECUTABLE, "script": FORGE_SCRIPT},
        "production_hq": hq,
        "stopped_hq": None,
        "test_page": None,
        "listener": None,
        "ports": {"8765": dict(hq), "8766": dict(hq), "7860": None, "8776": None},
        "serve": {
            "paused": True,
            "config_checksum": hashlib.sha256(CANONICAL_SERVE_BYTES).hexdigest(),
            "funnel": False,
        },
    }
    write_serve_file(serve, CANONICAL_SERVE_BYTES)
    write_state(state, payload, now=payload["written_at"])


def format_plan(plan: dict) -> str:
    command = plan.get("command")
    allowed = None
    if command == list(HQ_LAUNCH):
        allowed = list(HQ_LAUNCH)
    elif command == list(SERVE_RESTORE):
        allowed = list(SERVE_RESTORE)
    public = {
        "next": plan.get("next"),
        "performed": False,
        "restore_serve": plan.get("restore_serve") is True and plan.get("next") == "restore-serve",
        "executed": False,
        "report": plan.get("report"),
        "command": allowed,
    }
    return json.dumps(public, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    """Read-only recovery. The only form is --dry-run --state PATH --serve PATH."""
    import sys
    import time

    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] != ["--dry-run"] or args.count("--state") != 1 or args.count("--serve") != 1 or len(args) != 5:
        sys.stderr.write("usage: --dry-run --state window-state.json --serve serve-snapshot.json\n")
        return 2
    if args[1] != "--state" or args[3] != "--serve":
        sys.stderr.write("usage: --dry-run --state window-state.json --serve serve-snapshot.json\n")
        return 2
    try:
        state = assert_state_path(Path(args[2]))
        serve = assert_serve_path(state, Path(args[4]))
        serve_bytes = load_serve_file(serve)
        plan = recover(
            state,
            collect_ports(),
            live_observer,
            now=int(time.time()),
            serve_bytes=serve_bytes,
            dry_run=True,
        )
    except RecoveryError as exc:
        plan = _blocked(exc.code)
    except OSError:
        plan = _blocked("malformed")
    sys.stdout.write(format_plan(plan))
    if plan.get("next") in {"none", "start-hq", "stop-listener", "stop-page", "restore-serve"} and plan.get("performed") is False:
        return 0
    sys.stderr.write(str(plan.get("report") or "blocked") + "\n")
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
