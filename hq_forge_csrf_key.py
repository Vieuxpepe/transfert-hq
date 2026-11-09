"""Windows ACL for the lifecycle CSRF key.

Directory components are opened with NtCreateFile relative to the previous
handle and FILE_OPEN_REPARSE_POINT. A reparse tag rejects that component, so
a junction or symlink is not followed. The key is created relative to the
verified parent handle, with the protected DACL set before any secret bytes
are written.

An existing regular file is read only when its owner and DACL match that
policy and its length is 32. A length of 0 with that same policy is completed
on the same handle. Any other file is left unchanged. This module does not
log the key.
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
_FILE_ATTRIBUTE_NORMAL = 0x80
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400
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

try:
    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    _ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
except (AttributeError, OSError):
    _kernel = _advapi = _ntdll = None

# NT dispositions. FILE_CREATE is 2 here; Win32 CREATE_NEW is a different number.
_FILE_OPEN = 1
_FILE_CREATE = 2
_FILE_DIRECTORY_FILE = 0x00000001
_FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020
_FILE_NON_DIRECTORY_FILE = 0x00000040
_FILE_OPEN_REPARSE_POINT_NT = 0x00200000
_OBJ_CASE_INSENSITIVE = 0x00000040
_FILE_LIST_DIRECTORY = 0x0001
_FILE_TRAVERSE = 0x0020
_FILE_SHARE_READ_NT = 0x00000001
_FILE_SHARE_WRITE_NT = 0x00000002
_FILE_SHARE_DELETE_NT = 0x00000004
_STATUS_ACCESS_DENIED = 0xC0000022
_STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034
_STATUS_OBJECT_NAME_COLLISION = 0xC0000035
_STATUS_OBJECT_PATH_NOT_FOUND = 0xC000003A
_STATUS_SHARING_VIOLATION = 0xC0000043
_FILE_NAME_OPENED = 0x8
_FileAttributeTagInfo = 9
_DIR_ACCESS = _FILE_LIST_DIRECTORY | _FILE_TRAVERSE | _FILE_READ_ATTRIBUTES | _READ_CONTROL | _SYNCHRONIZE
_PARENT_ACCESS = _DIR_ACCESS | _FILE_WRITE_DATA
_DIR_OPTIONS = _FILE_DIRECTORY_FILE | _FILE_OPEN_REPARSE_POINT_NT | _FILE_SYNCHRONOUS_IO_NONALERT
_FILE_OPTIONS = _FILE_NON_DIRECTORY_FILE | _FILE_OPEN_REPARSE_POINT_NT | _FILE_SYNCHRONOUS_IO_NONALERT
_DIR_SHARE = _FILE_SHARE_READ_NT | _FILE_SHARE_WRITE_NT | _FILE_SHARE_DELETE_NT


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


class _UNICODE_STRING(ctypes.Structure):
    _fields_ = (
        ("Length", wintypes.USHORT),
        ("MaximumLength", wintypes.USHORT),
        ("Buffer", wintypes.LPWSTR),
    )


class _IO_STATUS_BLOCK(ctypes.Structure):
    class _Union(ctypes.Union):
        _fields_ = (("Status", wintypes.LONG), ("Pointer", ctypes.c_void_p))

    _anonymous_ = ("_union",)
    _fields_ = (("_union", _Union), ("Information", ctypes.c_size_t))


class _OBJECT_ATTRIBUTES(ctypes.Structure):
    _fields_ = (
        ("Length", wintypes.ULONG),
        ("RootDirectory", wintypes.HANDLE),
        ("ObjectName", ctypes.POINTER(_UNICODE_STRING)),
        ("Attributes", wintypes.ULONG),
        ("SecurityDescriptor", ctypes.c_void_p),
        ("SecurityQualityOfService", ctypes.c_void_p),
    )


class _FILE_ATTRIBUTE_TAG_INFO(ctypes.Structure):
    _fields_ = (("FileAttributes", wintypes.DWORD), ("ReparseTag", wintypes.DWORD))


def _setup() -> None:
    if _kernel is None or _advapi is None or _ntdll is None:
        return
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
    _kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
    _kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
    _kernel.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    _kernel.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    _ntdll.NtCreateFile.argtypes = [
        ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD, ctypes.POINTER(_OBJECT_ATTRIBUTES),
        ctypes.POINTER(_IO_STATUS_BLOCK), ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
        wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
    ]
    _ntdll.NtCreateFile.restype = wintypes.LONG


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


def _nt_status(status: int) -> int:
    return status & 0xFFFFFFFF


def _component_ok(name: str) -> bool:
    return bool(name) and name not in {".", ".."} and "\\" not in name and "/" not in name and ":" not in name


def _unicode(text: str) -> tuple[_UNICODE_STRING, ctypes.Array]:
    buffer = ctypes.create_unicode_buffer(text)
    item = _UNICODE_STRING()
    item.Buffer = ctypes.cast(buffer, wintypes.LPWSTR)
    item.Length = len(text) * 2
    item.MaximumLength = (len(text) + 1) * 2
    return item, buffer


def _nt_create(
    root: int | None,
    name: str,
    access: int,
    share: int,
    disposition: int,
    options: int,
    security: ctypes.c_void_p | None,
) -> tuple[int, int]:
    """Return a handle and an NTSTATUS. The name is one component, or the DOS device path."""
    item, _buffer = _unicode(name)
    attributes = _OBJECT_ATTRIBUTES()
    attributes.Length = ctypes.sizeof(_OBJECT_ATTRIBUTES)
    attributes.RootDirectory = root or None
    attributes.ObjectName = ctypes.pointer(item)
    attributes.Attributes = _OBJ_CASE_INSENSITIVE
    attributes.SecurityDescriptor = security
    attributes.SecurityQualityOfService = None
    handle = wintypes.HANDLE()
    iosb = _IO_STATUS_BLOCK()
    status = _nt_status(_ntdll.NtCreateFile(
        ctypes.byref(handle), access, ctypes.byref(attributes), ctypes.byref(iosb),
        None, _FILE_ATTRIBUTE_NORMAL, share, disposition, options, None, 0,
    ))
    if status & 0x80000000:
        return 0, status
    value = int(handle.value or 0)
    if _invalid_handle(value):
        return 0, status
    return value, status


def _reject_reparse(handle: int) -> None:
    info = _FILE_ATTRIBUTE_TAG_INFO()
    if not _kernel.GetFileInformationByHandleEx(
        handle, _FileAttributeTagInfo, ctypes.byref(info), ctypes.sizeof(info),
    ):
        raise RuntimeError("csrf key path rejected")
    if info.ReparseTag != 0 or info.FileAttributes & _FILE_ATTRIBUTE_REPARSE_POINT:
        raise RuntimeError("csrf key path rejected")


def _opened_path(handle: int) -> str:
    # FILE_NAME_OPENED reports the path that was opened. It is compared with the
    # requested path; the reparse tag, not this string, is what stops a junction.
    buffer = ctypes.create_unicode_buffer(1024)
    length = _kernel.GetFinalPathNameByHandleW(handle, buffer, 1024, _FILE_NAME_OPENED)
    if length == 0 or length >= 1024:
        raise RuntimeError("csrf key path rejected")
    return buffer.value


def _same_path(opened: str, expected: Path) -> bool:
    wanted = "\\\\?\\" + os.path.abspath(expected)
    return os.path.normcase(opened.rstrip("\\")) == os.path.normcase(wanted.rstrip("\\"))


def _identity(handle: int) -> tuple[int, int, int]:
    info = _BY_HANDLE_FILE_INFORMATION()
    if not _kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
        raise RuntimeError("csrf key unreadable")
    return int(info.dwVolumeSerialNumber), int(info.nFileIndexHigh), int(info.nFileIndexLow)


def _file_size(handle: int) -> int:
    info = _BY_HANDLE_FILE_INFORMATION()
    if not _kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
        raise RuntimeError("csrf key unreadable")
    return (int(info.nFileSizeHigh) << 32) | int(info.nFileSizeLow)


def _close_all(handles: list[int]) -> None:
    for handle in reversed(handles):
        if handle:
            _kernel.CloseHandle(handle)


def _open_directories(path: Path) -> tuple[int, list[int]]:
    """Open each existing directory component and return the parent handle.

    FILE_OPEN_REPARSE_POINT makes a junction or symlink the opened object.
    A non-zero reparse tag rejects it before the next component is opened.
    The returned parent handle stays open so the key create cannot switch to
    a directory substituted under the same path string.
    """
    absolute = Path(os.path.abspath(path))
    assert_isolated_session_path(absolute)
    drive = absolute.drive
    if len(drive) != 2 or drive[1] != ":":
        raise RuntimeError("csrf key path rejected")
    names = list(absolute.parts[1:])
    if not names or any(not _component_ok(name) for name in names):
        raise RuntimeError("csrf key path rejected")
    opened: list[int] = []
    try:
        root, status = _nt_create(
            None, "\\??\\" + drive + "\\", _DIR_ACCESS, _DIR_SHARE, _FILE_OPEN, _DIR_OPTIONS, None,
        )
        if root == 0:
            raise RuntimeError("csrf key path rejected")
        opened.append(root)
        _reject_reparse(root)
        if not _same_path(_opened_path(root), Path(drive + "\\")):
            raise RuntimeError("csrf key path rejected")
        parent = root
        built = Path(drive + "\\")
        for name in names[:-1]:
            built = built / name
            handle, status = _nt_create(
                parent, name, _PARENT_ACCESS if name == names[-2] else _DIR_ACCESS,
                _DIR_SHARE, _FILE_OPEN, _DIR_OPTIONS, None,
            )
            if handle == 0:
                raise RuntimeError("csrf key path rejected")
            opened.append(handle)
            _reject_reparse(handle)
            if not _same_path(_opened_path(handle), built):
                raise RuntimeError("csrf key path rejected")
            parent = handle
        return parent, opened
    except Exception:
        _close_all(opened)
        raise


def assert_direct_path(path: Path) -> Path:
    """Absolute path whose existing components are not reparse points."""
    absolute = Path(os.path.abspath(path))
    if _kernel is None:
        current = Path(absolute.anchor) if absolute.anchor else Path(".")
        for part in absolute.parts[1 if absolute.anchor else 0:]:
            current = current / part
            if current.is_symlink():
                raise RuntimeError("csrf key path rejected")
        return absolute
    _parent, opened = _open_directories(absolute)
    try:
        leaf, status = _nt_create(
            _parent, absolute.name, _DIR_ACCESS, _DIR_SHARE, _FILE_OPEN, _FILE_OPTIONS, None,
        )
        if leaf == 0:
            if status in (_STATUS_OBJECT_NAME_NOT_FOUND, _STATUS_OBJECT_PATH_NOT_FOUND):
                return absolute
            raise RuntimeError("csrf key path rejected")
        try:
            _reject_reparse(leaf)
        finally:
            _kernel.CloseHandle(leaf)
        return absolute
    finally:
        _close_all(opened)


def csrf_key_path(sessions: Path) -> Path:
    absolute = assert_direct_path(Path(sessions))
    return assert_direct_path(absolute.with_name("lifecycle-csrf.key"))


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


def _write_secret(handle: int, secret: bytes, identity: tuple[int, int, int]) -> None:
    """Write 32 bytes on this handle. A short write is left in place and refused later."""
    if _identity(handle) != identity:
        raise RuntimeError("csrf key rejected")
    _verify_handle(handle)
    _reject_reparse(handle)
    written = wintypes.DWORD()
    buffer = ctypes.create_string_buffer(secret)
    if not _kernel.WriteFile(handle, buffer, 32, ctypes.byref(written), None) or written.value != 32:
        raise RuntimeError("csrf key unreadable")
    if not _kernel.FlushFileBuffers(handle):
        raise RuntimeError("csrf key unreadable")
    if _identity(handle) != identity or _file_size(handle) != 32:
        raise RuntimeError("csrf key unreadable")
    _verify_handle(handle)


def _read_secret(handle: int, identity: tuple[int, int, int]) -> bytes:
    if _identity(handle) != identity or _file_size(handle) != 32:
        raise RuntimeError("csrf key unreadable")
    _verify_handle(handle)
    buffer = ctypes.create_string_buffer(32)
    read = wintypes.DWORD()
    if not _kernel.ReadFile(handle, buffer, 32, ctypes.byref(read), None) or read.value != 32:
        raise RuntimeError("csrf key unreadable")
    if _identity(handle) != identity:
        raise RuntimeError("csrf key rejected")
    return buffer.raw


def _use_existing(parent: int, name: str, *, recover: bool) -> bytes | None:
    """Read a verified key. Recovery writes only a zero-length exact file."""
    deadline = time.monotonic() + 2
    while True:
        handle, status = _nt_create(
            parent, name, _OWNER_MASK, 0, _FILE_OPEN, _FILE_OPTIONS, None,
        )
        if handle == 0:
            if status == _STATUS_SHARING_VIOLATION and time.monotonic() < deadline:
                time.sleep(0.02)
                continue
            if status in (_STATUS_OBJECT_NAME_NOT_FOUND, _STATUS_OBJECT_PATH_NOT_FOUND):
                return None
            raise RuntimeError("csrf key rejected" if status == _STATUS_ACCESS_DENIED else "csrf key unreadable")
        try:
            _reject_reparse(handle)
            identity = _identity(handle)
            _verify_handle(handle)
            size = _file_size(handle)
            if size == 32:
                return _read_secret(handle, identity)
            if size == 0 and recover:
                # Exclusive share is 0, so another recovery cannot write a second secret.
                # A crash during WriteFile can leave 1 to 31 bytes. That length is not
                # recovered, truncated, or deleted.
                secret = secrets.token_bytes(32)
                _write_secret(handle, secret, identity)
                return secret
            raise RuntimeError("csrf key unreadable")
        finally:
            _kernel.CloseHandle(handle)


def _create_child(parent: int, name: str) -> bytes:
    secret = secrets.token_bytes(32)
    attributes, kept = _security_attributes()
    security = ctypes.c_void_p(attributes.lpSecurityDescriptor)
    handle, status = _nt_create(
        parent, name, _OWNER_MASK, 0, _FILE_CREATE, _FILE_OPTIONS, security,
    )
    del kept, attributes
    if handle == 0:
        if status == _STATUS_OBJECT_NAME_COLLISION:
            existing = _use_existing(parent, name, recover=True)
            if existing is None:
                raise RuntimeError("csrf key unreadable")
            return existing
        raise RuntimeError("csrf key unreadable")
    try:
        _reject_reparse(handle)
        _verify_handle(handle)
        identity = _identity(handle)
        if _file_size(handle) != 0:
            raise RuntimeError("csrf key unreadable")
        _write_secret(handle, secret, identity)
        return secret
    finally:
        _kernel.CloseHandle(handle)


def _with_parent(sessions: Path):
    path = Path(os.path.abspath(sessions)).with_name("lifecycle-csrf.key")
    parent, opened = _open_directories(path)
    return path, parent, opened


def describe_csrf_key_acl(sessions: Path) -> dict:
    """Return the key file's owner and DACL. Does not read the secret."""
    if _kernel is None:
        return {
            "owner": "posix",
            "protected": True,
            "aces": [],
            "acceptable": True,
        }
    path, parent, opened = _with_parent(sessions)
    try:
        handle, status = _nt_create(
            parent, path.name, _READ_CONTROL | _FILE_READ_ATTRIBUTES | _SYNCHRONIZE,
            _DIR_SHARE, _FILE_OPEN, _FILE_OPTIONS, None,
        )
        if handle == 0:
            raise RuntimeError("csrf key rejected" if status == _STATUS_ACCESS_DENIED else "csrf key unreadable")
        try:
            _reject_reparse(handle)
            owner, protected, rows = _aces(handle)
        finally:
            _kernel.CloseHandle(handle)
    finally:
        _close_all(opened)
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
    if _kernel is None:
        try:
            key_file = csrf_key_path(sessions)
            if not key_file.is_file():
                return None
            data = key_file.read_bytes()
            return data if len(data) == 32 else None
        except Exception:
            return None
    try:
        path, parent, opened = _with_parent(sessions)
    except RuntimeError:
        return None
    try:
        return _use_existing(parent, path.name, recover=False)
    except RuntimeError:
        return None
    finally:
        _close_all(opened)


def ensure_csrf_key(sessions: Path) -> bytes:
    """Create the key, or read one that already has the protected DACL.

    A zero-length file with that DACL is completed. Any other descriptor or
    length is left unchanged and refused.
    """
    if _kernel is None:
        key_file = csrf_key_path(sessions)
        key_file.parent.mkdir(parents=True, exist_ok=True)
        try:
            if key_file.exists():
                data = key_file.read_bytes()
                if len(data) == 32:
                    return data
                if len(data) != 0:
                    raise RuntimeError("csrf key rejected")
            secret = secrets.token_bytes(32)
            flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if not key_file.exists() else 0)
            fd = os.open(str(key_file), flags, 0o600)
            try:
                os.write(fd, secret)
            finally:
                os.close(fd)
            try:
                os.chmod(str(key_file), 0o600)
            except Exception:
                pass
            return secret
        except Exception as e:
            if isinstance(e, RuntimeError):
                raise
            raise RuntimeError(f"csrf key rejected: {e}") from e
    path, parent, opened = _with_parent(sessions)
    try:
        existing = _use_existing(parent, path.name, recover=True)
        if existing is not None:
            return existing
        return _create_child(parent, path.name)
    finally:
        _close_all(opened)
