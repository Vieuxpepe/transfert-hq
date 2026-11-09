"""M1 sleeper supervisor.

This module can create, recover, and terminate only a disposable sleeper it
started itself. It does not launch Forge. The Forge command constant is inert
while FORGE_LAUNCH_ENABLED is false. HTTP handlers in this file are fixtures
for tests; production startup does not bind them.
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import threading
from ctypes import wintypes
from pathlib import Path
from typing import Callable

FORGE_LAUNCH_ENABLED = False
FORGE_COMMAND = (
    'C:\\Windows\\System32\\cmd.exe /c set PYTHON="C:\\Program Files\\Python310\\python.exe"'
    "&& set COMMANDLINE_ARGS=--api&& call webui.bat"
)
PRODUCT_JOB_NAME = "Local\\TransfertHQ-Forge"
PRODUCT_MUTEX_NAME = "Local\\TransfertHQ-Forge-Lifecycle"
PRODUCT_LISTENER_ENABLED = False
LISTENER_PROCESS = "separate"
PAGE_ORIGIN = "http://127.0.0.1:8765"
LISTENER_ORIGIN = "http://127.0.0.1:8776"
RACE_CODE = "forge_ui_race"
RACE_WARNING = "Forge's own interface can accept work after the last check."
UNCERTAIN = frozenset({"busy", "progress_stale", "error", "timeout", "unavailable", "uncertain"})

try:
    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
except (AttributeError, OSError):
    _kernel = None

CREATE_SUSPENDED = 0x00000004
CREATE_NO_WINDOW = 0x08000000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_TERMINATE = 0x0001
DUPLICATE_SAME_ACCESS = 0x0002
STILL_ACTIVE = 259
JOB_OBJECT_ALL_ACCESS = 0x1F001F
JobObjectBasicProcessIdList = 3
JobObjectExtendedLimitInformation = 9
WAIT_OBJECT_0 = 0
WAIT_ABANDONED = 0x00000080
WAIT_TIMEOUT = 258
ERROR_ALREADY_EXISTS = 183

if _kernel is not None:
    _kernel.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    _kernel.CreateJobObjectW.restype = wintypes.HANDLE
    _kernel.OpenJobObjectW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    _kernel.OpenJobObjectW.restype = wintypes.HANDLE
    _kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    _kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _kernel.TerminateJobObject.restype = wintypes.BOOL
    _kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    _kernel.SetInformationJobObject.restype = wintypes.BOOL
    _kernel.QueryInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)
    ]
    _kernel.QueryInformationJobObject.restype = wintypes.BOOL
    _kernel.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    _kernel.IsProcessInJob.restype = wintypes.BOOL
    _kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    _kernel.CreateMutexW.restype = wintypes.HANDLE
    _kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    _kernel.WaitForSingleObject.restype = wintypes.DWORD
    _kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
    _kernel.ReleaseMutex.restype = wintypes.BOOL
    _kernel.CreateProcessW.argtypes = [
        wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.LPVOID, wintypes.LPVOID, wintypes.BOOL,
        wintypes.DWORD, wintypes.LPVOID, wintypes.LPCWSTR, wintypes.LPVOID, wintypes.LPVOID,
    ]
    _kernel.CreateProcessW.restype = wintypes.BOOL
    _kernel.ResumeThread.argtypes = [wintypes.HANDLE]
    _kernel.ResumeThread.restype = wintypes.DWORD
    _kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _kernel.OpenProcess.restype = wintypes.HANDLE
    _kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _kernel.TerminateProcess.restype = wintypes.BOOL
    _kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    _kernel.GetExitCodeProcess.restype = wintypes.BOOL
    _kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel.CloseHandle.restype = wintypes.BOOL
    _kernel.DuplicateHandle.argtypes = [
        wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.HANDLE),
        wintypes.DWORD, wintypes.BOOL, wintypes.DWORD,
    ]
    _kernel.DuplicateHandle.restype = wintypes.BOOL
    _kernel.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)
    ]
    _kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
    _kernel.GetProcessTimes.argtypes = [
        wintypes.HANDLE, wintypes.LPVOID, wintypes.LPVOID, wintypes.LPVOID, wintypes.LPVOID
    ]
    _kernel.GetProcessTimes.restype = wintypes.BOOL
    _kernel.GetCurrentProcess.argtypes = []
    _kernel.GetCurrentProcess.restype = wintypes.HANDLE
    _kernel.GetSystemDirectoryW.argtypes = [wintypes.LPWSTR, wintypes.UINT]
    _kernel.GetSystemDirectoryW.restype = wintypes.UINT


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD),
        ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD),
        ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.POINTER(wintypes.BYTE)),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
    ]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]


class _PID_LIST(ctypes.Structure):
    _fields_ = [
        ("NumberOfAssignedProcesses", wintypes.DWORD),
        ("NumberOfProcessIdsInList", wintypes.DWORD),
        ("ProcessIdList", ctypes.c_size_t * 64),
    ]


def system_directory() -> str:
    buffer = ctypes.create_unicode_buffer(260)
    length = _kernel.GetSystemDirectoryW(buffer, 260)
    if not length:
        raise OSError(ctypes.get_last_error())
    return buffer.value


def sleeper_command(kind: str) -> str:
    system = system_directory()
    cmd = str(Path(system) / "cmd.exe")
    ping = str(Path(system) / "PING.EXE")
    if kind == "wait":
        return f"{cmd} /c {ping} -n 30 127.0.0.1 > NUL"
    if kind == "detach":
        return f"{cmd} /c start /b {ping} -n 30 127.0.0.1 > NUL"
    raise ValueError("sleeper kind")


def _filetime(value: FILETIME) -> int:
    return (int(value.dwHighDateTime) << 32) | int(value.dwLowDateTime)


def process_alive(pid: int) -> bool:
    handle = _kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not _kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return int(code.value) == STILL_ACTIVE
    finally:
        _kernel.CloseHandle(handle)


def process_creation(pid: int) -> int | None:
    handle = _kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        return _creation_of(handle)
    finally:
        _kernel.CloseHandle(handle)


def process_image(pid: int) -> str | None:
    handle = _kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        return _image_of(handle)
    finally:
        _kernel.CloseHandle(handle)


def _creation_of(handle) -> int:
    created, exited, kernel_time, user_time = FILETIME(), FILETIME(), FILETIME(), FILETIME()
    if not _kernel.GetProcessTimes(
        handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel_time), ctypes.byref(user_time)
    ):
        raise OSError(ctypes.get_last_error())
    return _filetime(created)


def _image_of(handle) -> str:
    size = wintypes.DWORD(32768)
    buffer = ctypes.create_unicode_buffer(size.value)
    if not _kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
        raise OSError(ctypes.get_last_error())
    return buffer.value


def _is_system_cmd(image: str) -> bool:
    expected = str(Path(system_directory()) / "cmd.exe")
    return os.path.normcase(image) == os.path.normcase(expected)


def _job_pids(job) -> list[int]:
    data = _PID_LIST()
    returned = wintypes.DWORD()
    if not _kernel.QueryInformationJobObject(
        job, JobObjectBasicProcessIdList, ctypes.byref(data), ctypes.sizeof(data), ctypes.byref(returned)
    ):
        raise OSError(ctypes.get_last_error())
    count = int(data.NumberOfProcessIdsInList)
    return [int(data.ProcessIdList[index]) for index in range(count)]


def _in_job(pid: int, job) -> bool:
    handle = _kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        result = wintypes.BOOL()
        if not _kernel.IsProcessInJob(handle, job, ctypes.byref(result)):
            raise OSError(ctypes.get_last_error())
        return bool(result.value)
    finally:
        _kernel.CloseHandle(handle)


def _limit_flags(job) -> int:
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    returned = wintypes.DWORD()
    if not _kernel.QueryInformationJobObject(
        job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info), ctypes.byref(returned)
    ):
        raise OSError(ctypes.get_last_error())
    return int(info.BasicLimitInformation.LimitFlags)


def retain_empty_job(name: str):
    if not name.startswith("Local\\TransfertHQ-M1-"):
        raise RuntimeError("test job only")
    handle = _kernel.CreateJobObjectW(None, name)
    if not handle:
        raise OSError(ctypes.get_last_error())
    return handle


def release_handle(handle) -> None:
    if handle:
        _kernel.CloseHandle(handle)


def harness_stop(pid: int, creation: int, image_suffix: str) -> str:
    """Stop one process the caller recorded. Refuse when identity does not match."""
    import time
    handle = _kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, False, pid)
    if not handle:
        return "already-gone"
    try:
        if _creation_of(handle) != creation:
            return "refused-creation-mismatch"
        image = None
        for _ in range(10):
            try:
                image = _image_of(handle)
                break
            except OSError:
                code = wintypes.DWORD()
                if not _kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or int(code.value) != STILL_ACTIVE:
                    return "already-gone"
                time.sleep(0.05)
        if not image:
            return "refused-image-unreadable"
        if not image.lower().endswith(image_suffix.lower()):
            return "refused-image"
        if not _kernel.TerminateProcess(handle, 1):
            return f"terminate-error-{ctypes.get_last_error()}"
        return "stopped-by-harness"
    finally:
        _kernel.CloseHandle(handle)


class LifecycleLock:
    def __init__(self, name: str) -> None:
        self._name = name
        self._handle = None
        self._lock_file = None
        self.busy = False

    def __enter__(self):
        if _kernel is not None:
            self._handle = _kernel.CreateMutexW(None, False, self._name)
            if not self._handle:
                raise OSError(ctypes.get_last_error())
            waited = _kernel.WaitForSingleObject(self._handle, 0)
            self.busy = waited == WAIT_TIMEOUT
            if self.busy:
                return self
            if waited not in (WAIT_OBJECT_0, WAIT_ABANDONED):
                self.busy = True
            return self
        else:
            try:
                import fcntl
                import tempfile
                clean_name = re.sub(r"[^a-zA-Z0-9_.-]", "_", self._name)
                lock_path = Path(tempfile.gettempdir()) / f"{clean_name}.lock"
                self._lock_file = open(lock_path, "a+b")
                fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.busy = False
            except (BlockingIOError, OSError):
                self.busy = True
            return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if _kernel is not None:
            if self._handle and not self.busy:
                _kernel.ReleaseMutex(self._handle)
            if self._handle:
                _kernel.CloseHandle(self._handle)
                self._handle = None
        else:
            if self._lock_file is not None:
                try:
                    if not self.busy:
                        import fcntl
                        fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_UN)
                    self._lock_file.close()
                except Exception:
                    pass
                self._lock_file = None


class Supervisor:
    """Own one disposable sleeper tree, addressed by a test-only job name."""

    def __init__(
        self,
        root: Path,
        job_name: str,
        mutex_name: str,
        *,
        kind: str = "wait",
        occupant: Callable[[], bool] | None = None,
        pause_s: float = 0.0,
        retain_handle: bool = True,
        jobs_root: Path | None = None,
    ) -> None:
        if job_name == PRODUCT_JOB_NAME or mutex_name == PRODUCT_MUTEX_NAME:
            raise RuntimeError("product job name is not used in M1")
        if not job_name.startswith("Local\\TransfertHQ-M1-"):
            raise RuntimeError("job name must be an M1 test name")
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.job_name = job_name
        self.mutex_name = mutex_name
        self.kind = kind
        self.command = sleeper_command(kind)
        self.occupant = occupant or (lambda: False)
        self.pause_s = pause_s
        self.retain_handle = retain_handle
        self.jobs_root = Path(jobs_root) if jobs_root is not None else None
        self.on_locked: Callable[[], None] | None = None
        self.events: list[str] = []
        self._job = None
        self._process = None
        self._thread = None
        self._guard = threading.Lock()
        self._restart_token: str | None = None

    def start_product(self) -> dict:
        self.events.append("product_refused")
        return self._result(False, "forge_disabled", self._state_name(), signaled=False)

    def start(self) -> dict:
        with self._guard:
            with LifecycleLock(self.mutex_name) as lock:
                if lock.busy:
                    return self._result(False, "lifecycle_busy", self._state_name(), signaled=False)
                if self.on_locked:
                    self.on_locked()
                if self.pause_s:
                    import time
                    time.sleep(self.pause_s)
                if self.occupant():
                    self._write_state("unmanaged", restart_pending=False, identity=None)
                    return self._result(False, "unmanaged", "unmanaged", signaled=False)
                current = self.recover_unlocked()
                if current["state"] in {"starting", "ready", "busy", "unmanaged", "failed"}:
                    return self._result(False, "unmanaged" if current["state"] == "unmanaged" else "lifecycle_busy", current["state"], signaled=False)
                return self._spawn_unlocked()

    def recover(self) -> dict:
        with self._guard:
            with LifecycleLock(self.mutex_name) as lock:
                if lock.busy:
                    return self._result(False, "lifecycle_busy", self._state_name(), signaled=False)
                return self.recover_unlocked()

    def restart(self, probe: Callable[[], str]) -> dict:
        with self._guard:
            with LifecycleLock(self.mutex_name) as lock:
                if lock.busy:
                    return self._result(False, "lifecycle_busy", self._state_name(), signaled=False)
                if self.on_locked:
                    self.on_locked()
                if self.pause_s:
                    import time
                    time.sleep(self.pause_s)
                record = self._read()
                if not record or record.get("state") != "ready" or record.get("restart_pending"):
                    return self._result(False, "not_ready", self._state_name(), signaled=False)
                if self.jobs_root is not None:
                    import hq_forge_jobs as jobs
                    claimed, reason, token = jobs.claim_restart(self.jobs_root)
                    if not claimed:
                        return self._result(False, reason, "ready", signaled=False)
                    self._restart_token = token
                self._write_state("ready", restart_pending=True, identity=record)
                try:
                    first = str(probe() or "uncertain")
                    if first in UNCERTAIN or first != "ready":
                        self._clear_unsignaled(record)
                        return self._result(False, "uncertain", "ready", signaled=False)
                    second = str(probe() or "uncertain")
                    if second in UNCERTAIN or second != "ready":
                        self._clear_unsignaled(record)
                        return self._result(False, "uncertain", "ready", signaled=False)
                    if self.jobs_root is not None:
                        import hq_forge_jobs as jobs
                        confirmed, reason = jobs.confirm_restart(self.jobs_root, getattr(self, "_restart_token", None))
                        if not confirmed:
                            self._clear_unsignaled(record)
                            return self._result(False, reason, "ready", signaled=False)
                    proof = self._prove(record)
                    job = proof.get("job")
                    try:
                        if not proof["ok"]:
                            if self.jobs_root is not None:
                                import hq_forge_jobs as jobs
                                jobs.seal_restart(self.jobs_root, getattr(self, "_restart_token", None))
                            self._write_state("unmanaged", restart_pending=True, identity=record)
                            return self._result(False, "unmanaged", "unmanaged", signaled=False)
                        if self.jobs_root is not None:
                            import hq_forge_jobs as jobs
                            if not jobs.mark_restart_signaled(self.jobs_root, getattr(self, "_restart_token", None)):
                                self._write_state("failed", restart_pending=True, identity=record)
                                return self._result(False, "uncertain", "failed", signaled=False)
                        if not self._terminate_proven(job, record):
                            self._write_state("failed", restart_pending=True, identity=record)
                            return self._result(False, "terminate_failed", "failed", signaled=False)
                        self._write_state("absent", restart_pending=False, identity=None, members=[])
                        if self.jobs_root is not None:
                            import hq_forge_jobs as jobs
                            jobs.finish_signaled_restart(self.jobs_root, getattr(self, "_restart_token", None))
                        result = self._result(True, RACE_CODE, "absent", signaled=True)
                        result["warning"] = RACE_WARNING
                        result["interruption_free"] = False
                        return result
                    finally:
                        if job:
                            _kernel.CloseHandle(job)
                except Exception:
                    self._clear_unsignaled(record)
                    raise

    def _clear_unsignaled(self, record: dict) -> None:
        if self.jobs_root is not None:
            import hq_forge_jobs as jobs
            if jobs.restart_gate(self.jobs_root)["signaled"] or jobs.restart_gate(self.jobs_root)["sealed"]:
                return
            jobs.release_restart(self.jobs_root, getattr(self, "_restart_token", None))
        self._write_state("ready", restart_pending=False, identity=record)

    def create_simulated_job(self) -> dict:
        if self.jobs_root is not None:
            import hq_forge_jobs as jobs
            if jobs.restart_gate(self.jobs_root)["pending"]:
                return {"status": 409, "error": "lifecycle_busy", "launch": False}
        record = self._read()
        pending = bool(record and record.get("restart_pending"))
        state = (record or {}).get("state") or "absent"
        if pending or state in {"starting", "unmanaged", "failed"}:
            return {"status": 409, "error": "lifecycle_busy", "launch": False}
        return {"status": 200, "id": "simulated", "launch": False}

    def mark_ready(self, probe: Callable[[], str]) -> dict:
        record = self._read()
        if not record:
            return self._result(False, "missing_record", "absent", signaled=False)
        observed = str(probe() or "uncertain")
        if observed in UNCERTAIN:
            return self._result(False, "uncertain", record.get("state") or "starting", signaled=False)
        proof = self._prove(record)
        if not proof["ok"]:
            self._write_state("unmanaged", restart_pending=bool(record.get("restart_pending")), identity=record)
            if proof["job"]:
                _kernel.CloseHandle(proof["job"])
            return self._result(False, "unmanaged", "unmanaged", signaled=False)
        _kernel.CloseHandle(proof["job"])
        state = "busy" if observed == "busy" else "ready"
        self._write_state(state, restart_pending=bool(record.get("restart_pending")), identity=record)
        return self._result(True, state, state, signaled=False, identity=record)

    def close_supervisor_handles(self) -> None:
        for handle in (self._thread, self._process, self._job):
            if handle:
                _kernel.CloseHandle(handle)
        self._thread = None
        self._process = None
        self._job = None

    def recover_unlocked(self) -> dict:
        record = self._read()
        job, error = self._open_job()
        if not job:
            self.events.append(f"open_failed:{error}")
            self.events.append("create_job_on_recover:no")
            identity_alive = bool(record and self._matching_survivor(record))
            if identity_alive or self.occupant():
                self._write_state("unmanaged", restart_pending=bool(record and record.get("restart_pending")), identity=record)
                return self._result(False, "unmanaged", "unmanaged", signaled=False, identity=record)
            if record:
                self._write_state("absent", restart_pending=False, identity=None, members=[])
                return self._result(True, "stale", "absent", signaled=False)
            return self._result(True, "absent", "absent", signaled=False)
        if not record:
            self.events.append("missing_record")
            self.events.append("terminate_job:no")
            _kernel.CloseHandle(job)
            self._write_state("unmanaged", restart_pending=False, identity=None)
            return self._result(False, "unmanaged", "unmanaged", signaled=False)
        proof = self._prove(record, job=job)
        _kernel.CloseHandle(job)
        if not proof["ok"]:
            self._write_state("unmanaged", restart_pending=bool(record.get("restart_pending")), identity=record)
            return self._result(False, "unmanaged", "unmanaged", signaled=False, identity=record)
        state = record.get("state") if record.get("state") in {"ready", "busy", "starting"} else "starting"
        self._write_state(state, restart_pending=bool(record.get("restart_pending")), identity=record)
        return self._result(True, "recovered", state, signaled=False, identity=record)

    def _spawn_unlocked(self) -> dict:
        if self.command == FORGE_COMMAND or not FORGE_LAUNCH_ENABLED and "webui.bat" in self.command.lower():
            self.events.append("forge_command_refused")
            return self._result(False, "forge_disabled", "absent", signaled=False)
        if "listen" in self.command.lower():
            return self._result(False, "listen_refused", "failed", signaled=False)
        job = _kernel.CreateJobObjectW(None, self.job_name)
        if not job:
            return self._result(False, "job_create_failed", "failed", signaled=False)
        self.events.append("create_job")
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        if not _kernel.SetInformationJobObject(
            job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)
        ):
            _kernel.CloseHandle(job)
            return self._result(False, "job_limit_failed", "failed", signaled=False)
        if _limit_flags(job) != 0:
            _kernel.CloseHandle(job)
            return self._result(False, "job_limits_not_zero", "failed", signaled=False)
        startup = STARTUPINFOW()
        startup.cb = ctypes.sizeof(startup)
        process = PROCESS_INFORMATION()
        command = ctypes.create_unicode_buffer(self.command)
        created_process = _kernel.CreateProcessW(
            None, command, None, None, False,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            None, system_directory(), ctypes.byref(startup), ctypes.byref(process),
        )
        if not created_process:
            _kernel.CloseHandle(job)
            return self._result(False, "create_process_failed", "failed", signaled=False)
        self.events.append("create_process_suspended")
        assigned = bool(_kernel.AssignProcessToJobObject(job, process.hProcess))
        if not assigned:
            self._destroy_suspended(process, "assign_failed")
            _kernel.CloseHandle(job)
            return self._result(False, "assign_failed", "failed", signaled=False)
        duplicated = False
        if self.retain_handle:
            target = wintypes.HANDLE()
            duplicated = bool(_kernel.DuplicateHandle(
                _kernel.GetCurrentProcess(), job, process.hProcess, ctypes.byref(target),
                0, False, DUPLICATE_SAME_ACCESS,
            ))
            if not duplicated:
                self._destroy_suspended(process, "duplicate_failed")
                _kernel.CloseHandle(job)
                return self._result(False, "duplicate_failed", "failed", signaled=False)
        try:
            image = _image_of(process.hProcess)
            creation = _creation_of(process.hProcess)
        except OSError:
            self._destroy_suspended(process, "identity_unreadable")
            _kernel.CloseHandle(job)
            return self._result(False, "identity_unreadable", "failed", signaled=False)
        if not _is_system_cmd(image):
            self._destroy_suspended(process, "image_mismatch")
            _kernel.CloseHandle(job)
            return self._result(False, "image_mismatch", "failed", signaled=False)
        identity = {"pid": int(process.dwProcessId), "creation": creation, "image": image}
        self._write_state("starting", restart_pending=False, identity=identity)
        if _kernel.ResumeThread(process.hThread) == 0xFFFFFFFF:
            self._write_state("failed", restart_pending=False, identity=identity)
            self._destroy_suspended(process, "resume_failed")
            _kernel.CloseHandle(job)
            return self._result(False, "resume_failed", "failed", signaled=False)
        self.events.append("resume")
        self._job = job
        self._process = process.hProcess
        self._thread = process.hThread
        self._capture_members(identity)
        return self._result(True, "starting", "starting", signaled=False, identity=identity)

    def _capture_members(self, identity: dict) -> None:
        import time
        found: list[dict] = []
        deadline = time.time() + 3
        while time.time() < deadline:
            if not self._job:
                break
            found = []
            for pid in _job_pids(self._job):
                creation = process_creation(pid)
                image = process_image(pid)
                if creation is None or not image:
                    continue
                found.append({"pid": pid, "creation": creation, "image": image})
            descendants = [item for item in found if item["pid"] != int(identity["pid"])]
            if self.kind == "detach" and not process_alive(int(identity["pid"])) and descendants:
                break
            if self.kind == "wait" and descendants:
                break
            time.sleep(0.05)
        record = self._read() or identity
        self._write_state("starting", restart_pending=False, identity=record, members=found)

    def terminate_if_proven(self) -> dict:
        with self._guard:
            with LifecycleLock(self.mutex_name) as lock:
                if lock.busy:
                    return self._result(False, "lifecycle_busy", self._state_name(), signaled=False)
                record = self._read()
                if not record or "pid" not in record:
                    self.events.append("terminate_job:no")
                    return self._result(False, "missing_record", "unmanaged", signaled=False)
                proof = self._prove(record)
                job = proof.get("job")
                try:
                    if not proof["ok"]:
                        self.events.append("terminate_job:no")
                        self._write_state("unmanaged", restart_pending=bool(record.get("restart_pending")), identity=record)
                        return self._result(False, "unmanaged", "unmanaged", signaled=False, identity=record)
                    if not self._terminate_proven(job, record):
                        self._write_state("failed", restart_pending=True, identity=record)
                        return self._result(False, "terminate_failed", "failed", signaled=False, identity=record)
                    self._write_state("absent", restart_pending=False, identity=None, members=[])
                    return self._result(True, "terminated", "absent", signaled=True, identity=record)
                finally:
                    if job:
                        _kernel.CloseHandle(job)

    def _matching_survivor(self, record: dict) -> bool:
        candidates = list(record.get("members") or [])
        if "pid" in record and "creation" in record:
            candidates.append({"pid": record["pid"], "creation": record["creation"]})
        for item in candidates:
            pid = int(item["pid"])
            if process_alive(pid) and process_creation(pid) == int(item["creation"]):
                self.events.append(f"survivor:{pid}")
                return True
        return False

    def _prove(self, record: dict, job=None) -> dict:
        opened = job is None
        if job is None:
            job, _error = self._open_job()
        if not job:
            return {"ok": False, "job": None}

        def reject(reason: str) -> dict:
            self.events.append(reason)
            if opened:
                _kernel.CloseHandle(job)
            return {"ok": False, "job": None}

        pid = int(record["pid"])
        try:
            members = _job_pids(job)
        except OSError:
            return reject("membership_rejected")
        if pid not in members or not _in_job(pid, job):
            return reject("membership_rejected")
        handle = _kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return reject("pid_unopenable")
        try:
            creation = _creation_of(handle)
            image = _image_of(handle)
        finally:
            _kernel.CloseHandle(handle)
        if creation != int(record["creation"]) or not _is_system_cmd(image):
            return reject("identity_rejected")
        if os.path.normcase(image) != os.path.normcase(str(record.get("image") or "")):
            return reject("identity_rejected")
        for member in members:
            member_creation = process_creation(member)
            if member_creation is None or member_creation < creation:
                return reject("member_rejected")
        return {"ok": True, "job": job}

    def _terminate_proven(self, job, record: dict) -> bool:
        import time
        if job is None:
            return False
        self.events.append("terminate_job")
        if not _kernel.TerminateJobObject(job, 1):
            self.events.append("terminate_job_failed")
            return False
        for _ in range(40):
            if not process_alive(int(record["pid"])):
                return True
            time.sleep(0.05)
        return False

    def _destroy_suspended(self, process: PROCESS_INFORMATION, reason: str) -> None:
        self.events.append(f"terminate_suspended:{reason}")
        _kernel.TerminateProcess(process.hProcess, 1)
        _kernel.CloseHandle(process.hThread)
        _kernel.CloseHandle(process.hProcess)

    def _open_job(self):
        handle = _kernel.OpenJobObjectW(JOB_OBJECT_ALL_ACCESS, False, self.job_name)
        if handle:
            return handle, 0
        return None, ctypes.get_last_error()

    def _state_path(self) -> Path:
        return self.root / "lifecycle.json"

    def _read(self) -> dict | None:
        path = self._state_path()
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(data, dict) or data.get("version") != 1:
            return None
        return data

    def _write_state(self, state: str, *, restart_pending: bool, identity: dict | None, members: list | None = None) -> None:
        payload = {
            "version": 1,
            "state": state,
            "restart_pending": restart_pending,
            "job_name": self.job_name,
            "members": members if members is not None else (self._read() or {}).get("members") or [],
        }
        if identity:
            payload.update({
                "pid": int(identity["pid"]),
                "creation": int(identity["creation"]),
                "image": identity["image"],
            })
        temporary = self._state_path().with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self._state_path())

    def _state_name(self) -> str:
        record = self._read()
        return str(record.get("state")) if record else "absent"

    def _result(self, ok: bool, code: str, state: str, *, signaled: bool, identity: dict | None = None) -> dict:
        result = {
            "ok": ok,
            "code": code,
            "state": state,
            "signaled": signaled,
            "warning": None,
            "interruption_free": False,
            "pid": int(identity["pid"]) if identity else None,
            "creation": int(identity["creation"]) if identity else None,
            "image": identity.get("image") if identity else None,
        }
        return result


_SECRET_RE = re.compile(
    r"(?i)(transfert_session=|[\"']?(?:pin|cookie|token|authorization|session)[\"']?\s*[:=]\s*)\S+"
)


def redact_diagnostics(text: str) -> str:
    """Remove cookies, PINs, and session identifiers from diagnostic text."""
    cleaned = _SECRET_RE.sub(r"\1<redacted>", str(text))
    cleaned = re.sub(r"(?i)\b(?:pin|token|cookie|session)[-_ ]?[a-z0-9]{6,}\b", "<redacted>", cleaned)
    return cleaned


def session_role_from_cookie(cookie_header: str) -> str:
    """Read the HQ session cookie and return the authoritative role.

    The listener is a separate process, so each check reloads the session file
    HQ persisted and then uses session_role. The cookie header is not logged.
    """
    token = ""
    for part in str(cookie_header or "").split(";"):
        name, separator, value = part.strip().partition("=")
        if separator and name == "transfert_session":
            token = value
            break
    if not token:
        return ""
    import iphone_bridge as bridge
    reload_persisted_sessions(bridge)
    return bridge.session_role(token)


def reload_persisted_sessions(bridge) -> None:
    """Replace this process's session table with the file HQ last persisted."""
    path = bridge.SESSIONS_PATH
    try:
        raw = path.read_text(encoding="utf-8") if path.is_file() else "{}"
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError, UnicodeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    import time
    now = time.time()
    fresh = {}
    for tok, info in data.items():
        if not isinstance(tok, str) or not isinstance(info, dict):
            continue
        try:
            exp = float(info.get("exp") or 0)
            generation = int(info.get("gen") or 0)
        except (TypeError, ValueError):
            continue
        if exp <= now:
            continue
        fresh[tok] = {
            "exp": exp,
            "user": str(info.get("user") or "admin")[:40],
            "role": str(info.get("role") or "admin"),
            "gen": generation,
        }
    with bridge._SESSIONS_LOCK:
        bridge._SESSIONS.clear()
        bridge._SESSIONS.update(fresh)


def loopback_bindable(port: int) -> bool:
    """True when this process can bind 127.0.0.1:port. Does not keep the socket.

    Ports 7860, 8765, and 8776 are refused here so a test cannot bind them.
    """
    if int(port) in (7860, 8765, 8776):
        raise RuntimeError("refusing to bind a reserved port")
    import socket
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", int(port)))
    except OSError:
        return False
    finally:
        probe.close()
    return True


def loopback_open(port: int) -> bool:
    """True when something already accepts TCP on 127.0.0.1:port. Does not bind."""
    import socket
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(0.4)
    try:
        probe.connect(("127.0.0.1", int(port)))
    except OSError:
        return False
    finally:
        probe.close()
    return True


class ActionFixture:
    """Loopback-only test listener. It never reads an executable path from HTTP."""

    def __init__(self, supervisor: Supervisor, allowed_origin: str, role_for_cookie: Callable[[str], str] | None, probe: Callable[[], str], *, use_hq_session: bool = False) -> None:
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        self.supervisor = supervisor
        self.allowed_origin = allowed_origin
        self.role_for_cookie = role_for_cookie
        self.use_hq_session = use_hq_session
        self.probe = probe
        self.calls: list[dict] = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                return

            def _seen(self, kind: str) -> None:
                owner.calls.append({
                    "kind": kind,
                    "origin": self.headers.get("Origin") or "",
                    "cookie_present": bool(self.headers.get("Cookie")),
                    "referer": bool(self.headers.get("Referer")),
                    "private_network": (self.headers.get("Access-Control-Request-Private-Network") or "").lower() == "true",
                    "request_headers": self.headers.get("Access-Control-Request-Headers") or "",
                    "request_method": self.headers.get("Access-Control-Request-Method") or "",
                })

            def _cors(self, allow: bool) -> None:
                if not allow:
                    return
                self.send_header("Access-Control-Allow-Origin", owner.allowed_origin)
                self.send_header("Access-Control-Allow-Credentials", "true")
                self.send_header("Access-Control-Allow-Methods", "POST")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Max-Age", "0")
                self.send_header("Vary", "Origin")

            def _send(self, status: int, body: bytes, allow: bool) -> None:
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self._cors(allow)
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                    return

            def _preflight_ok(self) -> bool:
                origin = self.headers.get("Origin") or ""
                method = (self.headers.get("Access-Control-Request-Method") or "").upper()
                headers = [part.strip().lower() for part in (self.headers.get("Access-Control-Request-Headers") or "").split(",") if part.strip()]
                private = (self.headers.get("Access-Control-Request-Private-Network") or "").lower() == "true"
                return origin == owner.allowed_origin and method == "POST" and headers == ["content-type"] and not private

            def do_OPTIONS(self):
                self._seen("preflight")
                allow = self._preflight_ok()
                self._send(204 if allow else 403, b"", allow)

            def do_POST(self):
                origin = self.headers.get("Origin") or ""
                self._seen("action")
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length) if length else b""
                allow = origin == owner.allowed_origin
                if not allow:
                    self._send(403, b'{"error":"origin"}', False)
                    return
                try:
                    payload = json.loads(raw.decode("utf-8") or "{}")
                except (UnicodeError, json.JSONDecodeError):
                    self._send(400, b'{"error":"json"}', True)
                    return
                if not isinstance(payload, dict) or payload != {}:
                    self._send(400, b'{"error":"body"}', True)
                    return
                role = session_role_from_cookie(self.headers.get("Cookie") or "") if owner.use_hq_session else owner.role_for_cookie(self.headers.get("Cookie") or "")
                if role == "":
                    self._send(401, b'{"error":"anonymous"}', True)
                    return
                if role != "admin":
                    self._send(403, b'{"error":"admin"}', True)
                    return
                path = self.path.split("?", 1)[0]
                if path == "/lifecycle/start":
                    result = owner.supervisor.start()
                elif path == "/lifecycle/restart":
                    result = owner.supervisor.restart(owner.probe)
                else:
                    self._send(404, b'{"error":"unknown"}', True)
                    return
                encoded = json.dumps({"code": result["code"], "signaled": result["signaled"]}).encode("utf-8")
                self._send(200 if result["ok"] else 409, encoded, True)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        if self._server.server_address[0] != "127.0.0.1":
            raise RuntimeError("listener left loopback")
        self.port = int(self._server.server_address[1])
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
