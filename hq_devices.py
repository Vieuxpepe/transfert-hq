"""Normalized device / capability model for Transfert HQ v7.

Capabilities are derived here. Callers cannot invent dangerous capabilities
(raw shell, exec, admin bypass). Disk fields are whatever the caller already
cached — this module never probes the network.
"""

from __future__ import annotations

from typing import Any

# Stable capability ids the UI may gate on. Nothing here runs code.
HOST_CAPS = (
    "files",
    "clipboard",
    "screenshot",
    "lock",
    "sleep",
    "explore",
    "print",
    "backup",
    "terminal",
    "shell",
    "presence",
    "voice",
    "disks",
)
BROWSER_CAPS = ("presence", "upload", "voice")
PHONE_OS = ("ios", "android", "tvos", "watchos", "ipados")
# Never emitted. Kept so tests can assert the denylist.
FORBIDDEN_CAPS = frozenset(
    {
        "raw_shell",
        "exec",
        "arbitrary_shell",
        "arbitrary_command",
        "admin_bypass",
        "root_shell",
    }
)

# Companion capabilities. Granted only by intersection, never by a client claim.
AGENT_CAPS = (
    "status",
    "telemetry",
    "files_list",
    "files_read",
    "files_write",
    "files_copy",
    "screenshot",
    "clipboard_read",
    "clipboard_write",
    "apps_list",
    "apps_launch",
    "process_list",
    "process_kill",
    "power_lock",
    "power_sleep",
    "power_restart",
    "power_shutdown",
    "terminal_allowlisted",
    "terminal_interactive",
    "jobs",
    "artifacts",
)
# Interactive terminal stays out of the controller ceiling (off unless a future
# explicit build enables it — v1 never does).
CONTROLLER_ALLOWED = frozenset(c for c in AGENT_CAPS if c != "terminal_interactive")
DEFAULT_AGENT_POLICY = (
    "status",
    "telemetry",
    "files_list",
    "files_read",
    "files_copy",
    "screenshot",
    "apps_list",
    "process_list",
    "power_lock",
    "power_sleep",
    "jobs",
    "artifacts",
)
CAP_RISK = {
    "status": "read",
    "telemetry": "read",
    "files_list": "read",
    "files_read": "read",
    "files_write": "sensitive",
    "files_copy": "safe",
    "screenshot": "read",
    "clipboard_read": "sensitive",
    "clipboard_write": "sensitive",
    "apps_list": "read",
    "apps_launch": "safe",
    "process_list": "read",
    "process_kill": "sensitive",
    "power_lock": "safe",
    "power_sleep": "safe",
    "power_restart": "destructive",
    "power_shutdown": "destructive",
    "terminal_allowlisted": "sensitive",
    "terminal_interactive": "destructive",
    "jobs": "read",
    "artifacts": "read",
}

_KEEP = (
    "id",
    "name",
    "kind",
    "online",
    "source",
    "path",
    "os",
    "ip",
    "last_seen",
    "ago_sec",
    "free",
    "free_h",
    "total",
    "total_h",
    "disks",
    "disk_error",
    "battery",
)


def _os_name(device: dict) -> str:
    return str(device.get("os") or "").lower()


def _is_phone(device: dict) -> bool:
    os_name = _os_name(device)
    kind = str(device.get("kind") or "").lower()
    return is_phone_os(os_name) or kind in ("phone", "ios", "ipad")


def is_phone_os(name: str) -> bool:
    text = (name or "").lower()
    if any(p in text for p in PHONE_OS):
        return True
    return any(token in text for token in ("iphone", "ipad"))


def is_phone_device(device: dict) -> bool:
    return isinstance(device, dict) and _is_phone(device)


def intersect_capabilities(support, policy, controller_allowed=None) -> list[str]:
    """support ∩ policy ∩ controller ceiling. Unknown and forbidden names drop out."""
    ceiling = CONTROLLER_ALLOWED if controller_allowed is None else frozenset(controller_allowed)
    support_set = {str(x) for x in support} if isinstance(support, (list, tuple, set)) else set()
    policy_set = {str(x) for x in policy} if isinstance(policy, (list, tuple, set)) else set()
    return [
        cap
        for cap in AGENT_CAPS
        if cap in support_set and cap in policy_set and cap in ceiling and cap not in FORBIDDEN_CAPS
    ]


def agent_capabilities_for(device: dict) -> list[str]:
    """Only a controller-attached ``_granted`` list counts. Client claims do not."""
    if not isinstance(device, dict) or _is_phone(device):
        return []
    granted = device.get("_granted")
    if not isinstance(granted, list):
        return []
    allowed = [cap for cap in AGENT_CAPS if cap in granted and cap in CONTROLLER_ALLOWED and cap not in FORBIDDEN_CAPS]
    return allowed


def access_for(device: dict) -> list[str]:
    """Channel class: local / ssh / browser / agent. Phones are always browser."""
    if not isinstance(device, dict) or _is_phone(device):
        return ["browser"]
    source = str(device.get("source") or "")
    ident = str(device.get("id") or "")
    if source == "browser":
        return ["browser"]
    modes: list[str] = []
    if source == "host" or ident == "pc-host":
        modes.append("local")
    elif source == "tailscale":
        modes.append("ssh")
    elif source == "agent":
        modes.append("agent")
    if device.get("_agent_id") and "agent" not in modes:
        modes.append("agent")
    return modes or ["browser"]


def capabilities_for(device: dict) -> list[str]:
    """Derive a safe capability list. Ignores any client-supplied capabilities."""
    if not isinstance(device, dict):
        return ["presence"]
    source = str(device.get("source") or "")
    ident = str(device.get("id") or "")
    if source == "host" or ident == "pc-host":
        return list(HOST_CAPS)
    if source == "browser":
        return list(BROWSER_CAPS)
    if source == "tailscale":
        caps = ["presence"]
        if device.get("online"):
            caps.append("disks")
        if not _is_phone(device) and device.get("online"):
            # Eligible as an existing allowlisted SSH target. Not a raw-exec grant.
            caps.append("ssh_target")
        return caps
    return ["presence"]


def normalize(device: dict) -> dict:
    src = device if isinstance(device, dict) else {}
    out: dict[str, Any] = {}
    for key in _KEEP:
        if key in src:
            out[key] = src.get(key)
    out["id"] = str(out.get("id") or "")
    out["name"] = str(out.get("name") or out["id"] or "Appareil")[:80]
    caps = [c for c in capabilities_for(src) if c not in FORBIDDEN_CAPS]
    out["capabilities"] = caps
    out["access"] = access_for(src)
    out["agent_capabilities"] = agent_capabilities_for(src)
    agent_id = str(src.get("_agent_id") or "")
    if str(src.get("source") or "") == "agent" and not agent_id:
        agent_id = str(src.get("id") or "")
    if agent_id and not _is_phone(src):
        out["agent_id"] = agent_id[:80]
    out["online"] = bool(src.get("online", True)) if src.get("online") is not False else False
    return out


def normalize_all(devices: list[dict] | None) -> list[dict]:
    return [normalize(d) for d in (devices or []) if isinstance(d, dict)]


def present(device: dict) -> dict:
    """Roster row plus derived access. Drops controller-only ``_granted``."""
    src = device if isinstance(device, dict) else {}
    out = dict(src)
    out["access"] = access_for(src)
    out["agent_capabilities"] = agent_capabilities_for(src)
    agent_id = str(src.get("_agent_id") or "")
    if str(src.get("source") or "") == "agent" and not agent_id:
        agent_id = str(src.get("id") or "")
    if agent_id and not _is_phone(src):
        out["agent_id"] = agent_id[:80]
    out.pop("_granted", None)
    out.pop("_agent_id", None)
    out.pop("secret", None)
    return out


def gates_for(device: dict) -> dict[str, bool]:
    caps = set(normalize(device).get("capabilities") or [])
    interesting = (
        "screenshot",
        "lock",
        "sleep",
        "clipboard",
        "shell",
        "terminal",
        "print",
        "backup",
        "explore",
        "ssh_target",
        "disks",
        "voice",
        "upload",
        "files",
    )
    return {name: name in caps for name in interesting}


def fuzzy_score(query: str, text: str) -> int:
    q = (query or "").strip().lower()
    t = (text or "").lower()
    if not q:
        return 1
    if q == t:
        return 200
    idx = t.find(q)
    if idx >= 0:
        return 120 - min(idx, 40)
    i = 0
    for ch in q:
        i = t.find(ch, i)
        if i < 0:
            return 0
        i += 1
    return 8


def search_catalog(query: str, items: list[dict], *, limit: int = 20) -> list[dict]:
    ranked: list[tuple[int, dict]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "")
        hint = str(item.get("hint") or "")
        ident = str(item.get("id") or "")
        score = max(fuzzy_score(query, label), fuzzy_score(query, ident), fuzzy_score(query, hint) // 2)
        if score <= 0:
            continue
        safe = {
            "kind": str(item.get("kind") or "")[:32],
            "id": ident[:120],
            "label": label[:120],
            "hint": hint[:160],
        }
        # Never surface raw shell text even if a caller stuffed it into the catalog.
        for banned in ("cmd", "command", "shell"):
            safe.pop(banned, None)
        ranked.append((score, safe))
    ranked.sort(key=lambda pair: (-pair[0], pair[1]["label"].lower()))
    return [item for _score, item in ranked[: max(0, int(limit))]]
