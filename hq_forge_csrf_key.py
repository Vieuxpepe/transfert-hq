"""Windows ACL for the lifecycle CSRF key.

The key file is created with a protected DACL before its secret bytes are
written. An existing file is used only when that same descriptor is already
present. This module does not rewrite an untrusted file and does not log
the key.
"""

from __future__ import annotations

import ctypes
import os
import secrets
import time
from ctypes import wintypes
from pathlib import Path

PRODUCTION_ROOT = Path(r"C:\Transfert")
_FILE_READ_DATA = 0x0001
_FILE_WRITE_DATA = 0x0002
_FILE_READ_ATTRIBUTES = 0x0080
_READ_CONTROL = 0x00020000
_SYNCHRONIZE = 0x00100000
_OWNER_MASK = _FILE_READ_DATA | _FILE_WRITE_DATA | _FILE_READ_ATTRIBUTES | _READ_CONTROL | _SYNCHRONIZE
_READER_MASK = _FILE_READ_DATA | _FILE_READ_ATTRIBUTES | _READ_CONTROL | _SYNCHRONIZE
OWNER_ACCESS_MASK = _OWNER_MASK
READER_ACCESS_MASK = _READER_MASK
_CREATE_NEW = 1
_OPEN_EXISTING = 3
_FILE_ATTRIBUTE_NORMAL = 0x80
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400
_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
_FILE_SHARE_READ = 0x00000001
_FILE_SHARE_DELETE = 0x00000004
_INVALID_ATTRIBUTES = 0xFFFFFFFF
_ERROR_FILE_NOT_FOUND = 2
_ERROR_PATH_NOT_FOUND = 3
_ERROR_ACCESS_DENIED = 5
_ERROR_SHARING_VIOLATION = 32
_ERROR_FILE_EXISTS = 80
_SE_DACL_PRESENT = 0x0004
_SE_DACL_DEFAULTED = 0x0008
_SE_DACL_PROTECTED = 0x1000
_ACCESS_ALLOWED_ACE_TYPE = 0
_INHERITED_ACE = 0x10
_ACL_REVISION = 2
_SECURITY_DESCRIPTOR_REVISION = 1
_SE_FILE_OBJECT = 1
_OWNER_SECURITY_INFORMATION = 0x1
_DACL_SECURITY_INFORMATION = 0x4
_TOKEN_QUERY = 0x0008
_TOKEN_USER = 1
_WIN_LOCAL_SYSTEM_SID = 22
_WIN_BUILTIN_ADMINISTRATORS_SID = 26

_kernel = ctypes.WinDLL("kernel32", use_last_error=True)
_advapi = ctypes.WinDLL("advapi32", use_last_error=True)


class _SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = (
        ("nLength", wintypes.DWORD),
        ("lpSecurityDescriptor", ctypes.c_void_p),
        ("bInheritHandle", wintypes.BOOL),
    )


class _ACE_HEADER(ctypes.Structure):
    _pack_ = 1
    _fields_ = (
        ("AceType", ctypes.c_ubyte),
        ("AceFlags", ctypes.c_ubyte),
        ("AceSize", wintypes.WORD),
    )


class _SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = (("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD))


class _TOKEN_USER_INFO(ctypes.Structure):
    _fields_ = (("User", _SID_AND_ATTRIBUTES),)


class _BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
    _fields_ = (
        ("dwFileAttributes", wintypes.DWORD),
        ("ftCreationTime", wintypes.FILETIME),
        ("ftLastAccessTime", wintypes.FILETIME),
        ("ftLastWriteTime", wintypes.FILETIME),
        ("dwVolumeSerialNumber", wintypes.DWORD),
        ("nFileSizeHigh", wintypes.DWORD),
        ("nFileSizeLow", wintypes.DWORD),
        ("nNumberOfLinks", wintypes.DWORD),
        ("nFileIndexHigh", wintypes.DWORD),
        ("nFileIndexLow", wintypes.DWORD),
    )


def _setup() -> None:
    _kernel.CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
    ]
    _kernel.CreateFileW.restype = wintypes.HANDLE
    _kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel.CloseHandle.restype = wintypes.BOOL
    _kernel.WriteFile.argtypes = [
        wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
    ]
    _kernel.WriteFile.restype = wintypes.BOOL
    _kernel.ReadFile.argtypes = [
        wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
    ]
    _kernel.ReadFile.restype = wintypes.BOOL
    _kernel.FlushFileBuffers.argtypes = [wintypes.HANDLE]
    _kernel.FlushFileBuffers.restype = wintypes.BOOL
    _kernel.DeleteFileW.argtypes = [wintypes.LPCWSTR]
    _kernel.DeleteFileW.restype = wintypes.BOOL
    _kernel.GetFileAttributesW.argtypes = [wintypes.LPCWSTR]
    _kernel.GetFileAttributesW.restype = wintypes.DWORD
    _kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    _kernel.GetFileInformationByHandle.restype = wintypes.BOOL
    _kernel.GetCurrentProcess.restype = wintypes.HANDLE
    _kernel.LocalFree.argtypes = [ctypes.c_void_p]
    _kernel.LocalFree.restype = ctypes.c_void_p
    _kernel.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    _kernel.OpenProcessToken.restype = wintypes.BOOL
    _advapi.GetTokenInformation.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
    ]
    _advapi.GetTokenInformation.restype = wintypes.BOOL
    _advapi.CopySid.argtypes = [wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p]
    _advapi.CopySid.restype = wintypes.BOOL
    _advapi.GetLengthSid.argtypes = [ctypes.c_void_p]
    _advapi.GetLengthSid.restype = wintypes.DWORD
    _advapi.EqualSid.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    _advapi.EqualSid.restype = wintypes.BOOL
    _advapi.CreateWellKnownSid.argtypes = [
        wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD),
    ]
    _advapi.CreateWellKnownSid.restype = wintypes.BOOL
    _advapi.InitializeSecurityDescriptor.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    _advapi.InitializeSecurityDescriptor.restype = wintypes.BOOL
    _advapi.InitializeAcl.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD]
    _advapi.InitializeAcl.restype = wintypes.BOOL
    _advapi.AddAccessAllowedAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    _advapi.AddAccessAllowedAce.restype = wintypes.BOOL
    _advapi.SetSecurityDescriptorDacl.argtypes = [ctypes.c_void_p, wintypes.BOOL, ctypes.c_void_p, wintypes.BOOL]
    _advapi.SetSecurityDescriptorDacl.restype = wintypes.BOOL
    _advapi.SetSecurityDescriptorControl.argtypes = [ctypes.c_void_p, wintypes.WORD, wintypes.WORD]
    _advapi.SetSecurityDescriptorControl.restype = wintypes.BOOL
    _advapi.GetSecurityInfo.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    _advapi.GetSecurityInfo.restype = wintypes.DWORD
    _advapi.GetSecurityDescriptorDacl.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL),
    ]
    _advapi.GetSecurityDescriptorDacl.restype = wintypes.BOOL
    _advapi.GetSecurityDescriptorOwner.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL),
    ]
    _advapi.GetSecurityDescriptorOwner.restype = wintypes.BOOL
    _advapi.GetSecurityDescriptorControl.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.DWORD),
    ]
    _advapi.GetSecurityDescriptorControl.restype = wintypes.BOOL
    _advapi.GetAclInformation.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD]
    _advapi.GetAclInformation.restype = wintypes.BOOL
    _advapi.GetAce.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    _advapi.GetAce.restype = wintypes.BOOL
    _advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
    _advapi.ConvertSidToStringSidW.restype = wintypes.BOOL


_setup()
_user_sid: ctypes.Array[ctypes.c_char] | None = None
_system_sid: ctypes.Array[ctypes.c_char] | None = None
_admins_sid: ctypes.Array[ctypes.c_char] | None = None


def _invalid_handle(handle: int) -> bool:
    return handle in (0, -1, 0xFFFFFFFF, 0xFFFFFFFFFFFFFFFF)


def _copy_sid(source: ctypes.c_void_p | int) -> ctypes.Array[ctypes.c_char]:
    length = _advapi.GetLengthSid(source)
    if not length or length > 68:
        raise RuntimeError("csrf key rejected")
    buffer = ctypes.create_string_buffer(length)
    if not _advapi.CopySid(length, buffer, source):
        raise RuntimeError("csrf key rejected")
    return buffer


def _well_known_sid(kind: int) -> ctypes.Array[ctypes.c_char]:
    size = wintypes.DWORD(68)
    buffer = ctypes.create_string_buffer(68)
    if not _advapi.CreateWellKnownSid(kind, None, buffer, ctypes.byref(size)):
        raise RuntimeError("csrf key rejected")
    return _copy_sid(buffer)


def _runtime_sid() -> ctypes.Array[ctypes.c_char]:
    global _user_sid
    if _user_sid is not None:
        return _user_sid
    token = wintypes.HANDLE()
    if not _kernel.OpenProcessToken(_kernel.GetCurrentProcess(), _TOKEN_QUERY, ctypes.byref(token)):
        raise RuntimeError("csrf key rejected")
    try:
        needed = wintypes.DWORD()
        _advapi.GetTokenInformation(token, _TOKEN_USER, None, 0, ctypes.byref(needed))
        raw = ctypes.create_string_buffer(needed.value)
        if not _advapi.GetTokenInformation(token, _TOKEN_USER, raw, needed, ctypes.byref(needed)):
            raise RuntimeError("csrf key rejected")
        user = ctypes.cast(raw, ctypes.POINTER(_TOKEN_USER_INFO)).contents
        _user_sid = _copy_sid(user.User.Sid)
        return _user_sid
    finally:
        _kernel.CloseHandle(token)


def _known() -> tuple[ctypes.Array[ctypes.c_char], ctypes.Array[ctypes.c_char], ctypes.Array[ctypes.c_char]]:
    global _system_sid, _admins_sid
    user = _runtime_sid()
    if _system_sid is None:
        _system_sid = _well_known_sid(_WIN_LOCAL_SYSTEM_SID)
    if _admins_sid is None:
        _admins_sid = _well_known_sid(_WIN_BUILTIN_ADMINISTRATORS_SID)
    if _advapi.EqualSid(user, _system_sid) or _advapi.EqualSid(user, _admins_sid):
        raise RuntimeError("csrf key rejected")
    return user, _system_sid, _admins_sid


def _sid_text(sid: ctypes.c_void_p | int) -> str:
    text = ctypes.c_wchar_p()
    if not _advapi.ConvertSidToStringSidW(sid, ctypes.byref(text)):
        raise RuntimeError("csrf key rejected")
    try:
        return text.value or ""
    finally:
        _kernel.LocalFree(text)


def assert_isolated_session_path(path: Path) -> None:
    resolved = Path(os.path.abspath(path))
    if resolved == PRODUCTION_ROOT or PRODUCTION_ROOT in resolved.parents:
        raise RuntimeError("refusing a production session path")


def assert_direct_path(path: Path) -> Path:
    """Absolute path whose existing components are not reparse points."""
    absolute = Path(os.path.abspath(path))
    assert_isolated_session_path(absolute)
    built = Path(absolute.anchor)
    missing_final_only = False
    parts = absolute.parts
    for index, part in enumerate(parts[1:], start=1):
        built = built / part
        attrs = _kernel.GetFileAttributesW(str(built))
        if attrs == _INVALID_ATTRIBUTES:
            error = ctypes.get_last_error()
            final = index == len(parts) - 1
            if error in (_ERROR_FILE_NOT_FOUND, _ERROR_PATH_NOT_FOUND) and final:
                missing_final_only = True
                break
            raise RuntimeError("csrf key path rejected")
        if attrs & _FILE_ATTRIBUTE_REPARSE_POINT:
            raise RuntimeError("csrf key path rejected")
    if missing_final_only:
        return absolute
    return absolute


def csrf_key_path(sessions: Path) -> Path:
    absolute = assert_direct_path(Path(sessions))
    return assert_direct_path(absolute.with_name("lifecycle-csrf.key"))


def _attributes(path: Path) -> int | None:
    attrs = _kernel.GetFileAttributesW(str(path))
    if attrs == _INVALID_ATTRIBUTES:
        error = ctypes.get_last_error()
        if error in (_ERROR_FILE_NOT_FOUND, _ERROR_PATH_NOT_FOUND):
            return None
        raise RuntimeError("csrf key path rejected")
    return int(attrs)


def _security_attributes() -> tuple[_SECURITY_ATTRIBUTES, list[object]]:
    user, system, admins = _known()
    kept: list[object] = [user, system, admins]
    acl = ctypes.create_string_buffer(512)
    kept.append(acl)
    if not _advapi.InitializeAcl(acl, 512, _ACL_REVISION):
        raise RuntimeError("csrf key rejected")
    for sid, mask in ((user, _OWNER_MASK), (system, _READER_MASK), (admins, _READER_MASK)):
        if not _advapi.AddAccessAllowedAce(acl, _ACL_REVISION, mask, sid):
            raise RuntimeError("csrf key rejected")
    descriptor = ctypes.create_string_buffer(64)
    kept.append(descriptor)
    if not _advapi.InitializeSecurityDescriptor(descriptor, _SECURITY_DESCRIPTOR_REVISION):
        raise RuntimeError("csrf key rejected")
    if not _advapi.SetSecurityDescriptorDacl(descriptor, True, acl, False):
        raise RuntimeError("csrf key rejected")
    if not _advapi.SetSecurityDescriptorControl(descriptor, _SE_DACL_PROTECTED, _SE_DACL_PROTECTED):
        raise RuntimeError("csrf key rejected")
    attributes = _SECURITY_ATTRIBUTES()
    attributes.nLength = ctypes.sizeof(_SECURITY_ATTRIBUTES)
    attributes.lpSecurityDescriptor = ctypes.cast(descriptor, ctypes.c_void_p)
    attributes.bInheritHandle = False
    kept.append(attributes)
    return attributes, kept


def _aces(handle: int) -> tuple[str, bool, list[tuple[str, int, bool]]]:
    owner = ctypes.c_void_p()
    group = ctypes.c_void_p()
    dacl = ctypes.c_void_p()
    sacl = ctypes.c_void_p()
    descriptor = ctypes.c_void_p()
    status = _advapi.GetSecurityInfo(
        handle, _SE_FILE_OBJECT, _OWNER_SECURITY_INFORMATION | _DACL_SECURITY_INFORMATION,
        ctypes.byref(owner), ctypes.byref(group), ctypes.byref(dacl), ctypes.byref(sacl), ctypes.byref(descriptor),
    )
    if status != 0 or not descriptor:
        raise RuntimeError("csrf key rejected")
    try:
        present = wintypes.BOOL()
        defaulted = wintypes.BOOL()
        dacl_ptr = ctypes.c_void_p()
        if not _advapi.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl_ptr), ctypes.byref(defaulted)):
            raise RuntimeError("csrf key rejected")
        control = wintypes.WORD()
        revision = wintypes.DWORD()
        if not _advapi.GetSecurityDescriptorControl(descriptor, ctypes.byref(control), ctypes.byref(revision)):
            raise RuntimeError("csrf key rejected")
        protected = bool(control.value & _SE_DACL_PROTECTED) and bool(control.value & _SE_DACL_PRESENT) and not bool(control.value & _SE_DACL_DEFAULTED)
        owner_ptr = ctypes.c_void_p()
        owner_defaulted = wintypes.BOOL()
        if not _advapi.GetSecurityDescriptorOwner(descriptor, ctypes.byref(owner_ptr), ctypes.byref(owner_defaulted)) or not owner_ptr:
            raise RuntimeError("csrf key rejected")
        rows: list[tuple[str, int, bool, bool]] = []
        if present.value and dacl_ptr and not defaulted.value:
            class _ACL_SIZE(ctypes.Structure):
                _fields_ = (("AceCount", wintypes.DWORD), ("AclBytesInUse", wintypes.DWORD), ("AclBytesFree", wintypes.DWORD))
            info = _ACL_SIZE()
            if not _advapi.GetAclInformation(dacl_ptr, ctypes.byref(info), ctypes.sizeof(info), 2):
                raise RuntimeError("csrf key rejected")
            for index in range(info.AceCount):
                ace_ptr = ctypes.c_void_p()
                if not _advapi.GetAce(dacl_ptr, index, ctypes.byref(ace_ptr)) or not ace_ptr:
                    raise RuntimeError("csrf key rejected")
                header = ctypes.cast(ace_ptr, ctypes.POINTER(_ACE_HEADER)).contents
                if header.AceSize < 8:
                    raise RuntimeError("csrf key rejected")
                mask = ctypes.cast(ace_ptr.value + 4, ctypes.POINTER(wintypes.DWORD)).contents.value
                sid = ace_ptr.value + 8
                rows.append((
                    _sid_text(sid), int(mask), bool(header.AceFlags & _INHERITED_ACE),
                    header.AceType == _ACCESS_ALLOWED_ACE_TYPE,
                ))
        return _sid_text(owner_ptr), protected, rows
    finally:
        _kernel.LocalFree(descriptor)


def _policy_holds(owner: str, protected: bool, rows: list[tuple[str, int, bool, bool]]) -> bool:
    if not protected or len(rows) != 3 or any(inherited or not allowed for _sid, _mask, inherited, allowed in rows):
        return False
    user, system, admins = _known()
    expected = {
        _sid_text(user): _OWNER_MASK,
        _sid_text(system): _READER_MASK,
        _sid_text(admins): _READER_MASK,
    }
    if owner != _sid_text(user):
        return False
    return {sid: mask for sid, mask, _inherited, _allowed in rows} == expected


def _verify_handle(handle: int) -> None:
    owner, protected, rows = _aces(handle)
    if not _policy_holds(owner, protected, rows):
        raise RuntimeError("csrf key rejected")


def _open(path: Path, access: int, share: int, disposition: int, security: object | None) -> int:
    security_ptr = None if security is None else ctypes.cast(ctypes.addressof(security), ctypes.c_void_p)
    handle = _kernel.CreateFileW(
        str(path), access, share, security_ptr, disposition,
        _FILE_ATTRIBUTE_NORMAL | _FILE_FLAG_OPEN_REPARSE_POINT, None,
    )
    if _invalid_handle(handle):
        return 0
    return handle


def _delete(path: Path) -> None:
    _kernel.DeleteFileW(str(path))


def _create_key(path: Path) -> bytes:
    key = secrets.token_bytes(32)
    attributes, kept = _security_attributes()
    handle = _open(path, _OWNER_MASK, _FILE_SHARE_DELETE, _CREATE_NEW, attributes)
    del kept
    if handle == 0:
        if ctypes.get_last_error() == _ERROR_FILE_EXISTS:
            return _read_existing(path)
        raise RuntimeError("csrf key unreadable")
    try:
        try:
            _verify_handle(handle)
        except RuntimeError:
            _delete(path)
            raise
        written = wintypes.DWORD()
        buffer = ctypes.create_string_buffer(key)
        if not _kernel.WriteFile(handle, buffer, 32, ctypes.byref(written), None) or written.value != 32:
            _delete(path)
            raise RuntimeError("csrf key unreadable")
        if not _kernel.FlushFileBuffers(handle):
            _delete(path)
            raise RuntimeError("csrf key unreadable")
    finally:
        _kernel.CloseHandle(handle)
    return key


def _read_handle(handle: int) -> bytes:
    info = _BY_HANDLE_FILE_INFORMATION()
    if not _kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
        raise RuntimeError("csrf key unreadable")
    if info.dwFileAttributes & _FILE_ATTRIBUTE_REPARSE_POINT:
        raise RuntimeError("csrf key path rejected")
    size = (int(info.nFileSizeHigh) << 32) | int(info.nFileSizeLow)
    if size != 32:
        raise RuntimeError("csrf key unreadable")
    _verify_handle(handle)
    buffer = ctypes.create_string_buffer(32)
    read = wintypes.DWORD()
    if not _kernel.ReadFile(handle, buffer, 32, ctypes.byref(read), None) or read.value != 32:
        raise RuntimeError("csrf key unreadable")
    return buffer.raw


def _read_existing(path: Path) -> bytes:
    deadline = time.monotonic() + 2
    while True:
        attrs = _attributes(path)
        if attrs is None:
            raise RuntimeError("csrf key unreadable")
        if attrs & _FILE_ATTRIBUTE_REPARSE_POINT:
            raise RuntimeError("csrf key path rejected")
        handle = _open(path, _READER_MASK, _FILE_SHARE_READ | _FILE_SHARE_DELETE, _OPEN_EXISTING, None)
        if handle == 0:
            error = ctypes.get_last_error()
            if error == _ERROR_SHARING_VIOLATION and time.monotonic() < deadline:
                time.sleep(0.02)
                continue
            raise RuntimeError("csrf key rejected" if error == _ERROR_ACCESS_DENIED else "csrf key unreadable")
        try:
            return _read_handle(handle)
        finally:
            _kernel.CloseHandle(handle)


def describe_csrf_key_acl(sessions: Path) -> dict:
    """Return the key file's owner and DACL. Does not read the secret."""
    path = csrf_key_path(sessions)
    attrs = _attributes(path)
    if attrs is None:
        raise RuntimeError("csrf key unreadable")
    if attrs & _FILE_ATTRIBUTE_REPARSE_POINT:
        raise RuntimeError("csrf key path rejected")
    handle = _open(path, _READ_CONTROL | _FILE_READ_ATTRIBUTES, _FILE_SHARE_READ | _FILE_SHARE_DELETE, _OPEN_EXISTING, None)
    if handle == 0:
        raise RuntimeError("csrf key rejected")
    try:
        owner, protected, rows = _aces(handle)
    finally:
        _kernel.CloseHandle(handle)
    return {
        "owner": owner,
        "protected": protected,
        "aces": [
            {"sid": sid, "mask": mask, "inherited": inherited, "allowed": allowed}
            for sid, mask, inherited, allowed in rows
        ],
        "acceptable": _policy_holds(owner, protected, rows),
    }


def load_csrf_key(sessions: Path) -> bytes | None:
    try:
        path = csrf_key_path(sessions)
        if _attributes(path) is None:
            return None
        return _read_existing(path)
    except RuntimeError:
        return None


def ensure_csrf_key(sessions: Path) -> bytes:
    """Create the key, or read one that already has the protected DACL.

    A file with any other descriptor is left unchanged and refused.
    """
    path = csrf_key_path(sessions)
    if _attributes(path) is None:
        return _create_key(path)
    return _read_existing(path)
