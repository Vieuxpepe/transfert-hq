"""Per-application Windows WASAPI audio ducking for DJ Musica.

Lowers Spotify.exe smoothly in the Windows audio mixer while Musica or her
sisters speak on the PC station, leaving the browser/Spotify Connect volume bar
untouched and avoiding Spotify Web API volume-step rate limits. Falls back
no-op (`yields False`) on non-Windows hosts or when no local Spotify session exists.
"""

from __future__ import annotations

import contextlib
import ctypes
import os
import sys
import time
from typing import Iterator

TARGET_PROCESSES = frozenset({"spotify.exe", "soloist.exe"})

_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_E_RENDER = 0
_E_CONSOLE = 0
_CLSCTX_ALL = 23


def _process_basename(pid: int) -> str:
    if pid <= 0 or sys.platform != "win32":
        return ""
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(512)
        size = ctypes.c_uint32(len(buf))
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return ""
        return os.path.basename(buf.value).lower()
    finally:
        kernel32.CloseHandle(handle)


def _spotify_volume_controls():
    """Return a list of (ISimpleAudioVolume, original_level) for active Spotify.exe sessions."""
    if sys.platform != "win32":
        return []
    import comtypes
    from ctypes import POINTER, c_float, c_int, c_uint32, c_void_p
    from ctypes.wintypes import DWORD, LPWSTR
    from comtypes import COMMETHOD, GUID, HRESULT, IUnknown

    CLSID_MMDeviceEnumerator = GUID("{BCDE0395-E52F-467C-8E3D-C4579291692E}")

    class ISimpleAudioVolume(IUnknown):
        _iid_ = GUID("{87CE5498-68D6-44E5-9215-6DA47EF883D8}")
        _methods_ = [
            COMMETHOD([], HRESULT, "SetMasterVolume",
                      (["in"], c_float, "fLevel"),
                      (["in"], POINTER(GUID), "EventContext")),
            COMMETHOD([], HRESULT, "GetMasterVolume",
                      (["out"], POINTER(c_float), "pfLevel")),
            COMMETHOD([], HRESULT, "SetMute",
                      (["in"], c_int, "bMute"),
                      (["in"], POINTER(GUID), "EventContext")),
            COMMETHOD([], HRESULT, "GetMute",
                      (["out"], POINTER(c_int), "pbMute")),
        ]

    class IAudioSessionControl2(IUnknown):
        _iid_ = GUID("{BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D}")
        _methods_ = [
            COMMETHOD([], HRESULT, "GetState", (["out"], POINTER(c_int), "pRetVal")),
            COMMETHOD([], HRESULT, "GetDisplayName", (["out"], POINTER(LPWSTR), "pRetVal")),
            COMMETHOD([], HRESULT, "SetDisplayName", (["in"], LPWSTR, "Value"), (["in"], POINTER(GUID), "EventContext")),
            COMMETHOD([], HRESULT, "GetIconPath", (["out"], POINTER(LPWSTR), "pRetVal")),
            COMMETHOD([], HRESULT, "SetIconPath", (["in"], LPWSTR, "Value"), (["in"], POINTER(GUID), "EventContext")),
            COMMETHOD([], HRESULT, "GetGroupingParam", (["out"], POINTER(GUID), "pRetVal")),
            COMMETHOD([], HRESULT, "SetGroupingParam", (["in"], POINTER(GUID), "Override"), (["in"], POINTER(GUID), "EventContext")),
            COMMETHOD([], HRESULT, "RegisterAudioSessionNotification", (["in"], c_void_p, "NewNotifications")),
            COMMETHOD([], HRESULT, "UnregisterAudioSessionNotification", (["in"], c_void_p, "NewNotifications")),
            COMMETHOD([], HRESULT, "GetSessionIdentifier", (["out"], POINTER(LPWSTR), "pRetVal")),
            COMMETHOD([], HRESULT, "GetSessionInstanceIdentifier", (["out"], POINTER(LPWSTR), "pRetVal")),
            COMMETHOD([], HRESULT, "GetProcessId", (["out"], POINTER(DWORD), "pRetVal")),
            COMMETHOD([], HRESULT, "IsSystemSoundsSession"),
            COMMETHOD([], HRESULT, "SetDuckingPreference", (["in"], c_int, "optOut")),
        ]

    class IAudioSessionEnumerator(IUnknown):
        _iid_ = GUID("{E2F5BB11-0570-40CA-ACDD-3AA01277DEE8}")
        _methods_ = [
            COMMETHOD([], HRESULT, "GetCount", (["out"], POINTER(c_int), "SessionCount")),
            COMMETHOD([], HRESULT, "GetSession", (["in"], c_int, "SessionCount"),
                      (["out"], POINTER(POINTER(IAudioSessionControl2)), "Session")),
        ]

    class IAudioSessionManager2(IUnknown):
        _iid_ = GUID("{77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F}")
        _methods_ = [
            COMMETHOD([], HRESULT, "GetAudioSessionControl",
                      (["in"], POINTER(GUID), "AudioSessionGuid"),
                      (["in"], DWORD, "StreamFlags"),
                      (["out"], POINTER(c_void_p), "SessionControl")),
            COMMETHOD([], HRESULT, "GetSimpleAudioVolume",
                      (["in"], POINTER(GUID), "AudioSessionGuid"),
                      (["in"], DWORD, "StreamFlags"),
                      (["out"], POINTER(POINTER(ISimpleAudioVolume)), "AudioVolume")),
            COMMETHOD([], HRESULT, "GetSessionEnumerator",
                      (["out"], POINTER(POINTER(IAudioSessionEnumerator)), "SessionEnum")),
            COMMETHOD([], HRESULT, "RegisterSessionNotification", (["in"], c_void_p, "Notification")),
            COMMETHOD([], HRESULT, "UnregisterSessionNotification", (["in"], c_void_p, "Notification")),
            COMMETHOD([], HRESULT, "RegisterDuckNotification", (["in"], LPWSTR, "SessionID"), (["in"], c_void_p, "DuckNotification")),
            COMMETHOD([], HRESULT, "UnregisterDuckNotification", (["in"], c_void_p, "DuckNotification")),
        ]

    class IMMDevice(IUnknown):
        _iid_ = GUID("{D666063F-1587-4E43-81F1-B948E807363F}")
        _methods_ = [
            COMMETHOD([], HRESULT, "Activate",
                      (["in"], POINTER(GUID), "iid"),
                      (["in"], DWORD, "dwClsCtx"),
                      (["in"], c_void_p, "pActivationParams"),
                      (["out"], POINTER(POINTER(IAudioSessionManager2)), "ppInterface")),
        ]

    class IMMDeviceEnumerator(IUnknown):
        _iid_ = GUID("{A95664D2-9614-4F35-A746-DE8DB63617E6}")
        _methods_ = [
            COMMETHOD([], HRESULT, "EnumAudioEndpoints",
                      (["in"], c_int, "dataFlow"),
                      (["in"], DWORD, "dwStateMask"),
                      (["out"], POINTER(c_void_p), "ppDevices")),
            COMMETHOD([], HRESULT, "GetDefaultAudioEndpoint",
                      (["in"], c_int, "dataFlow"),
                      (["in"], c_int, "role"),
                      (["out"], POINTER(POINTER(IMMDevice)), "ppEndpoint")),
        ]

    enumerator = comtypes.CoCreateInstance(CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, comtypes.CLSCTX_ALL)
    endpoint = enumerator.GetDefaultAudioEndpoint(_E_RENDER, _E_CONSOLE)
    manager = endpoint.Activate(ctypes.byref(IAudioSessionManager2._iid_), _CLSCTX_ALL, None)
    sessions = manager.GetSessionEnumerator()
    count = sessions.GetCount()
    controls = []
    for idx in range(count):
        raw_ctrl = sessions.GetSession(idx)
        ctrl2 = raw_ctrl.QueryInterface(IAudioSessionControl2)
        pid = int(ctrl2.GetProcessId())
        if _process_basename(pid) not in TARGET_PROCESSES:
            continue
        vol = ctrl2.QueryInterface(ISimpleAudioVolume)
        level = float(vol.GetMasterVolume())
        controls.append((vol, level))
    return controls


def _ramp_controls(controls, targets: list[float], *, seconds: float, steps: int = 5) -> None:
    if not controls or not targets:
        return
    starts = []
    for vol, _ in controls:
        try:
            starts.append(float(vol.GetMasterVolume()))
        except Exception:  # noqa: BLE001
            starts.append(targets[0])
    steps = max(1, steps)
    delay = max(0.0, seconds) / steps
    for step in range(1, steps + 1):
        frac = step / steps
        for (vol, _orig), start, end in zip(controls, starts, targets):
            level = max(0.02, min(1.0, start + (end - start) * frac))
            try:
                vol.SetMasterVolume(level, None)
            except Exception:  # noqa: BLE001
                pass
        if delay and step < steps:
            time.sleep(delay)


def has_spotify_audio_session() -> bool:
    """Return True if a local Windows WASAPI Spotify.exe audio session is accessible."""
    if sys.platform != "win32":
        return False
    try:
        import comtypes
        comtypes.CoInitialize()
        try:
            return bool(_spotify_volume_controls())
        finally:
            comtypes.CoUninitialize()
    except Exception:  # noqa: BLE001
        return False


@contextlib.contextmanager
def duck_spotify(factor: float = 0.22, *, down_sec: float = 0.35, up_sec: float = 0.55) -> Iterator[bool]:
    """Smoothly duck local Spotify.exe WASAPI sessions inside the block, then restore."""
    if sys.platform != "win32":
        yield False
        return
    try:
        import comtypes
    except Exception:  # noqa: BLE001
        yield False
        return

    controls = []
    co_init = False
    try:
        comtypes.CoInitialize()
        co_init = True
        controls = _spotify_volume_controls()
    except Exception:  # noqa: BLE001
        controls = []

    if not controls:
        if co_init:
            try:
                comtypes.CoUninitialize()
            except Exception:  # noqa: BLE001
                pass
        yield False
        return

    factor = max(0.05, min(0.85, float(factor)))
    originals = [orig for _, orig in controls]
    ducked_targets = [max(0.04, round(orig * factor, 3)) for orig in originals]
    try:
        _ramp_controls(controls, ducked_targets, seconds=down_sec, steps=5)
        yield True
    finally:
        try:
            _ramp_controls(controls, originals, seconds=up_sec, steps=6)
        except Exception:  # noqa: BLE001
            pass
        if co_init:
            try:
                comtypes.CoUninitialize()
            except Exception:  # noqa: BLE001
                pass
