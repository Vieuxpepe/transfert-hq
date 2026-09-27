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
    return any(p in os_name for p in PHONE_OS) or kind in ("phone", "ios", "ipad")


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
    out["online"] = bool(src.get("online", True)) if src.get("online") is not False else False
    return out


def normalize_all(devices: list[dict] | None) -> list[dict]:
    return [normalize(d) for d in (devices or []) if isinstance(d, dict)]


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
