"""Operation catalog for companion jobs.

The controller and the companion both validate arguments here.
A job cannot smuggle a shell string, a host, or a confirm flag.
"""

from __future__ import annotations

import json
from typing import Any

import hq_agent_protocol as proto
import hq_devices

RISKS = ("read", "safe", "sensitive", "destructive")
ORIGINS = ("human", "planner", "automation")

# Keys that must never be accepted, whatever the operation.
BANNED_ARG_KEYS = frozenset({"command", "cmd", "shell", "host", "confirm", "argv", "script"})


class AgentOpError(ValueError):
    pass


class OpSpec:
    def __init__(self, name: str, capability: str, risk: str, allowed: tuple[str, ...] = ()):
        if risk not in RISKS:
            raise ValueError(risk)
        if capability not in hq_devices.AGENT_CAPS:
            raise ValueError(capability)
        self.name = name
        self.capability = capability
        self.risk = risk
        self.allowed = frozenset(allowed)


OPS: dict[str, OpSpec] = {
    spec.name: spec
    for spec in (
        OpSpec("system.status", "status", "read"),
        OpSpec("system.telemetry", "telemetry", "read"),
        OpSpec("fs.list", "files_list", "read", ("workspace", "path", "depth")),
        OpSpec("fs.read", "files_read", "read", ("workspace", "path")),
        OpSpec("fs.write", "files_write", "sensitive", ("workspace", "path", "text")),
        OpSpec("fs.copy", "files_copy", "safe", ("workspace", "src", "dest")),
        OpSpec("fs.stage", "files_read", "read", ("workspace", "path")),
        OpSpec("screenshot.capture", "screenshot", "read"),
        OpSpec("apps.list", "apps_list", "read"),
        OpSpec("apps.launch", "apps_launch", "safe", ("id",)),
        OpSpec("process.list", "process_list", "read"),
        OpSpec("process.kill", "process_kill", "sensitive", ("pid", "name")),
        OpSpec("power.lock", "power_lock", "safe"),
        OpSpec("power.sleep", "power_sleep", "safe"),
        OpSpec("power.restart", "power_restart", "destructive"),
        OpSpec("power.shutdown", "power_shutdown", "destructive"),
        OpSpec("clipboard.read", "clipboard_read", "sensitive"),
        OpSpec("clipboard.write", "clipboard_write", "sensitive", ("text",)),
        OpSpec("terminal.run_allowlisted", "terminal_allowlisted", "sensitive", ("id",)),
    )
}


def get_op(name: str) -> OpSpec:
    spec = OPS.get(str(name or ""))
    if spec is None:
        raise AgentOpError("opération inconnue")
    return spec


def _text(value: Any, *, max_len: int, field: str) -> str:
    if not isinstance(value, str):
        raise AgentOpError(f"{field} invalide")
    text = value.strip()
    if not text or len(text) > max_len:
        raise AgentOpError(f"{field} invalide")
    return text


def _rel_path(value: Any, *, field: str, allow_empty: bool = False) -> str:
    if value is None and allow_empty:
        return ""
    if not isinstance(value, str):
        raise AgentOpError(f"{field} invalide")
    text = value.replace("\\", "/").strip()
    if not text and allow_empty:
        return ""
    if not text or len(text) > 240:
        raise AgentOpError(f"{field} invalide")
    if text.startswith("/") or text.startswith("~") or ":" in text:
        raise AgentOpError("chemin refusé")
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise AgentOpError("chemin refusé")
    return "/".join(parts)


def _workspace(value: Any) -> str:
    if value is None or value == "":
        return "default"
    return _text(value, max_len=40, field="workspace")


def validate_args(op_name: str, args: Any) -> dict:
    spec = get_op(op_name)
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise AgentOpError("arguments invalides")
    if any(key in BANNED_ARG_KEYS for key in args):
        raise AgentOpError("argument refusé")
    unknown = set(args) - spec.allowed
    if unknown:
        raise AgentOpError("argument refusé")
    try:
        encoded = json.dumps(args, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise AgentOpError("arguments invalides") from exc
    if len(encoded) > proto.ARGS_MAX:
        raise AgentOpError("arguments trop volumineux")

    clean: dict[str, Any] = {}
    if "workspace" in spec.allowed and ("workspace" in args or spec.name.startswith("fs.")):
        if spec.name.startswith("fs."):
            clean["workspace"] = _workspace(args.get("workspace"))
    if spec.name in ("fs.list", "fs.read", "fs.stage"):
        clean["path"] = _rel_path(args.get("path"), field="path", allow_empty=spec.name == "fs.list")
    if spec.name == "fs.list" and "depth" in args:
        depth = args.get("depth")
        if isinstance(depth, bool) or not isinstance(depth, int) or depth < 1 or depth > 4:
            raise AgentOpError("profondeur invalide")
        clean["depth"] = depth
    elif spec.name == "fs.list":
        clean["depth"] = 1
    if spec.name == "fs.write":
        clean["path"] = _rel_path(args.get("path"), field="path")
        text = args.get("text")
        if not isinstance(text, str) or len(text) > 32 * 1024:
            raise AgentOpError("texte invalide")
        clean["text"] = text
    if spec.name == "fs.copy":
        clean["src"] = _rel_path(args.get("src"), field="src")
        clean["dest"] = _rel_path(args.get("dest"), field="dest")
    if spec.name == "apps.launch":
        clean["id"] = _text(args.get("id"), max_len=64, field="id")
    if spec.name == "process.kill":
        pid = args.get("pid")
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1 or pid > 2**31:
            raise AgentOpError("pid invalide")
        clean["pid"] = pid
        clean["name"] = _text(args.get("name"), max_len=80, field="name")
    if spec.name == "clipboard.write":
        text = args.get("text")
        if not isinstance(text, str) or len(text) > 4000:
            raise AgentOpError("texte invalide")
        clean["text"] = text
    if spec.name == "terminal.run_allowlisted":
        clean["id"] = _text(args.get("id"), max_len=64, field="id")
    return clean


def needs_approval(origin: str, risk: str) -> bool:
    """Planner cannot clear sensitive or destructive work by itself.

    ``confirm: true`` is not an input here on purpose.
    """
    if origin not in ORIGINS:
        raise AgentOpError("origine invalide")
    if risk not in RISKS:
        raise AgentOpError("risque invalide")
    if risk == "read":
        return False
    if origin == "human" and risk in ("safe", "sensitive"):
        return False
    return True


def default_ttl(risk: str) -> int:
    if risk == "destructive":
        return 120
    if risk == "sensitive":
        return 300
    return 600


def clamp_ttl(risk: str, requested: int | None) -> int:
    default = default_ttl(risk)
    if requested is None:
        return default
    if isinstance(requested, bool) or not isinstance(requested, int):
        raise AgentOpError("ttl invalide")
    upper = 600 if risk == "destructive" else 24 * 3600
    return max(30, min(upper, requested))


def clamp_timeout(risk: str, requested: int | None) -> int:
    default = 20 if risk != "destructive" else 30
    if requested is None:
        return default
    if isinstance(requested, bool) or not isinstance(requested, int):
        raise AgentOpError("timeout invalide")
    upper = 30 if risk == "destructive" else 60
    return max(1, min(upper, requested))
