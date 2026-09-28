"""Bounded operations executed on a companion computer.

Paths stay inside configured workspaces. Terminal and apps run by id,
never from a command string in the job. Destructive power is off unless
the companion config opts in, and even then only on Windows.
"""

from __future__ import annotations

import os
import platform
import shutil
import signal
import subprocess
from pathlib import Path
from typing import Any

import hq_agent_ops as ops
import hq_agent_protocol as proto

PROTECTED_PROCESS_NAMES = frozenset(
    {
        "system",
        "idle",
        "csrss",
        "lsass",
        "wininit",
        "services",
        "smss",
        "systemd",
        "init",
        "launchd",
        "kernel",
        "kthreadd",
    }
)
LIST_LIMIT = 200
READ_MAX = 256 * 1024


def parse_workspaces(raw: Any) -> dict[str, Path]:
    out: dict[str, Path] = {}
    if isinstance(raw, list):
        for index, item in enumerate(raw):
            if isinstance(item, str) and item.strip():
                key = "default" if index == 0 else f"ws{index}"
                out[key] = Path(item)
        return out
    if isinstance(raw, dict):
        for key, value in raw.items():
            if isinstance(key, str) and isinstance(value, str) and value.strip():
                out[str(key)[:40]] = Path(value)
    return out


def resolve_in_workspace(workspaces: dict[str, Path], workspace: str, rel: str) -> Path:
    root = workspaces.get(workspace or "default")
    if root is None:
        raise ops.AgentOpError("espace de travail inconnu")
    base = root.resolve()
    parts = [part for part in (rel or "").split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise ops.AgentOpError("chemin refusé")
    candidate = base.joinpath(*parts).resolve() if parts else base
    try:
        candidate.relative_to(base)
    except ValueError as exc:
        raise ops.AgentOpError("chemin refusé") from exc
    return candidate


def _allow_argv(entry: Any) -> list[str] | None:
    if not isinstance(entry, dict):
        return None
    argv = entry.get("argv")
    ident = entry.get("id")
    if not isinstance(ident, str) or not isinstance(argv, list) or not argv:
        return None
    if len(argv) > 8:
        return None
    cleaned = []
    for part in argv:
        if not isinstance(part, str) or not part or len(part) > 200:
            return None
        cleaned.append(part)
    return cleaned


class RealHost:
    """Local OS adapter. User-supplied strings never become a shell command."""

    def __init__(self, config: dict | None = None):
        self.config = config if isinstance(config, dict) else {}
        self.workspaces = parse_workspaces(self.config.get("workspaces"))

    def status(self) -> dict:
        return {
            "hostname": platform.node()[:80],
            "os": platform.system().lower()[:40],
            "platform": platform.platform()[:120],
            "protocol_version": proto.PROTOCOL_VERSION,
        }

    def telemetry(self) -> dict:
        info: dict[str, Any] = {"os": platform.system().lower()}
        root = self.workspaces.get("default")
        if root is not None:
            try:
                usage = shutil.disk_usage(root if root.exists() else root.parent)
                info["free_bytes"] = int(usage.free)
                info["total_bytes"] = int(usage.total)
            except OSError:
                pass
        return info

    def list_dir(self, workspace: str, rel: str, depth: int) -> dict:
        anchor = self.workspaces.get(workspace)
        if anchor is None:
            raise ops.AgentOpError("espace de travail inconnu")
        start = resolve_in_workspace(self.workspaces, workspace, rel)
        base = anchor.resolve()
        if not start.exists() or not start.is_dir():
            raise ops.AgentOpError("dossier introuvable")
        entries: list[dict] = []
        truncated = False

        def walk(path: Path, remaining: int, prefix: str) -> None:
            nonlocal truncated
            if len(entries) >= LIST_LIMIT:
                truncated = True
                return
            try:
                children = sorted(path.iterdir(), key=lambda item: item.name.lower())
            except OSError as exc:
                raise ops.AgentOpError("dossier illisible") from exc
            for child in children:
                if len(entries) >= LIST_LIMIT:
                    truncated = True
                    return
                try:
                    resolved = child.resolve()
                    resolved.relative_to(base)
                except (OSError, ValueError):
                    continue
                name = child.name if not prefix else f"{prefix}/{child.name}"
                try:
                    stat = child.stat()
                    size = int(stat.st_size)
                    mtime = int(stat.st_mtime)
                except OSError:
                    size = 0
                    mtime = 0
                is_dir = child.is_dir() and not child.is_symlink()
                entries.append({"name": name[:240], "dir": is_dir, "size": size, "mtime": mtime})
                if is_dir and remaining > 1:
                    walk(child, remaining - 1, name)

        walk(start, max(1, min(4, int(depth or 1))), "")
        return {"entries": entries, "truncated": truncated}

    def read_file(self, workspace: str, rel: str) -> str:
        path = resolve_in_workspace(self.workspaces, workspace, rel)
        if not path.is_file():
            raise ops.AgentOpError("fichier introuvable")
        if path.stat().st_size > READ_MAX:
            raise ops.AgentOpError("fichier trop grand — utiliser fs.stage")
        data = path.read_bytes()
        if b"\x00" in data:
            raise ops.AgentOpError("fichier binaire — utiliser fs.stage")
        return data.decode("utf-8", errors="replace")

    def stage_file(self, workspace: str, rel: str) -> tuple[str, bytes]:
        path = resolve_in_workspace(self.workspaces, workspace, rel)
        if not path.is_file():
            raise ops.AgentOpError("fichier introuvable")
        size = path.stat().st_size
        if size <= 0 or size > proto.ARTIFACT_MAX:
            raise ops.AgentOpError("fichier hors limite")
        return path.name, path.read_bytes()

    def write_file(self, workspace: str, rel: str, text: str) -> None:
        path = resolve_in_workspace(self.workspaces, workspace, rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            path.parent.resolve().relative_to(self.workspaces[workspace].resolve())
        except (KeyError, ValueError) as exc:
            raise ops.AgentOpError("chemin refusé") from exc
        path.write_text(text, encoding="utf-8")

    def copy_file(self, workspace: str, src: str, dest: str) -> str:
        source = resolve_in_workspace(self.workspaces, workspace, src)
        target = resolve_in_workspace(self.workspaces, workspace, dest)
        if not source.is_file():
            raise ops.AgentOpError("fichier introuvable")
        if target.exists():
            raise ops.AgentOpError("destination déjà présente")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        return target.name

    def screenshot(self) -> tuple[str, bytes]:
        if platform.system().lower() != "windows":
            raise ops.AgentOpError("capture indisponible sur cette plateforme")
        import tempfile

        handle, raw_path = tempfile.mkstemp(prefix="hq-shot-", suffix=".png")
        os.close(handle)
        dest = Path(raw_path)
        script = (
            "param([string]$Dest)\n"
            "Add-Type -AssemblyName System.Windows.Forms\n"
            "Add-Type -AssemblyName System.Drawing\n"
            "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen\n"
            "$bmp = New-Object System.Drawing.Bitmap ([Math]::Max(1,$b.Width)), ([Math]::Max(1,$b.Height))\n"
            "$g = [System.Drawing.Graphics]::FromImage($bmp)\n"
            "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)\n"
            "$bmp.Save($Dest, [System.Drawing.Imaging.ImageFormat]::Png)\n"
        )
        script_path = dest.with_suffix(".ps1")
        try:
            script_path.write_text(script, encoding="utf-8")
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-File", str(script_path), str(dest)],
                check=False,
                timeout=20,
                capture_output=True,
                shell=False,
            )
            if proc.returncode != 0 or not dest.is_file() or dest.stat().st_size <= 0:
                raise ops.AgentOpError("capture échouée")
            data = dest.read_bytes()
            if len(data) > proto.ARTIFACT_MAX:
                raise ops.AgentOpError("capture trop volumineuse")
            return "capture.png", data
        finally:
            for path in (dest, script_path):
                try:
                    path.unlink()
                except OSError:
                    pass

    def apps(self) -> list[dict]:
        rows = []
        for entry in self.config.get("apps") or []:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str) and _allow_argv(entry):
                rows.append({"id": entry["id"][:64]})
        return rows

    def launch_app(self, app_id: str) -> None:
        for entry in self.config.get("apps") or []:
            if isinstance(entry, dict) and entry.get("id") == app_id:
                argv = _allow_argv(entry)
                if not argv:
                    break
                subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
        raise ops.AgentOpError("application inconnue")

    def processes(self) -> list[dict]:
        system = platform.system().lower()
        if system == "windows":
            return _windows_processes()
        return _linux_processes()

    def kill(self, pid: int, name: str) -> None:
        if pid <= 1 or name.lower() in PROTECTED_PROCESS_NAMES:
            raise ops.AgentOpError("processus protégé")
        current = _process_name(pid)
        if current is None or current.lower() != name.lower():
            raise ops.AgentOpError("processus différent")
        if platform.system().lower() == "windows":
            subprocess.run(["taskkill", "/PID", str(int(pid)), "/F"], check=False, timeout=15, capture_output=True)
            return
        os.kill(pid, signal.SIGTERM)

    def power(self, action: str, *, approved: bool) -> str:
        if action in ("restart", "shutdown"):
            if approved is not True or not self.config.get("destructive_power_enabled"):
                raise ops.AgentOpError("alimentation destructive refusée")
            if platform.system().lower() != "windows":
                raise ops.AgentOpError("non pris en charge sur cette plateforme")
            flag = "/r" if action == "restart" else "/s"
            subprocess.run(["shutdown.exe", flag, "/t", "30"], check=False, timeout=15)
            return action
        if platform.system().lower() != "windows":
            raise ops.AgentOpError("non pris en charge sur cette plateforme")
        if action == "lock":
            argv = ["rundll32.exe", "user32.dll,LockWorkStation"]
        elif action == "sleep":
            argv = ["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"]
        else:
            raise ops.AgentOpError("action inconnue")
        subprocess.run(argv, check=False, timeout=15)
        return action

    def clipboard_read(self) -> str:
        self._require_clipboard()
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
            check=False,
            timeout=10,
            capture_output=True,
            shell=False,
            text=True,
        )
        if proc.returncode != 0:
            raise ops.AgentOpError("lecture du presse-papiers échouée")
        return (proc.stdout or "")[:4000]

    def clipboard_write(self, text: str) -> None:
        self._require_clipboard()
        proc = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t",
            ],
            input=text,
            check=False,
            timeout=10,
            capture_output=True,
            shell=False,
            text=True,
        )
        if proc.returncode != 0:
            raise ops.AgentOpError("écriture du presse-papiers échouée")

    def _require_clipboard(self) -> None:
        if not self.config.get("clipboard_enabled"):
            raise ops.AgentOpError("presse-papiers désactivé sur ce companion")
        if platform.system().lower() != "windows":
            raise ops.AgentOpError("presse-papiers indisponible sur cette plateforme")

    def run_allowlisted(self, ident: str, timeout_sec: int) -> dict:
        for entry in self.config.get("terminal_allowlist") or []:
            if isinstance(entry, dict) and entry.get("id") == ident:
                argv = _allow_argv(entry)
                if not argv:
                    break
                proc = subprocess.run(
                    argv,
                    check=False,
                    timeout=max(1, min(60, int(timeout_sec or 20))),
                    capture_output=True,
                    shell=False,
                )
                output = (proc.stdout or b"") + (proc.stderr or b"")
                text = output[: proto.OUTPUT_MAX].decode("utf-8", errors="replace")
                return {"code": int(proc.returncode), "output": text}
        raise ops.AgentOpError("commande inconnue")


def _linux_processes() -> list[dict]:
    root = Path("/proc")
    rows: list[dict] = []
    if not root.is_dir():
        return rows
    for entry in root.iterdir():
        if len(rows) >= LIST_LIMIT:
            break
        if not entry.name.isdigit():
            continue
        try:
            name = (entry / "comm").read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            continue
        rows.append({"pid": int(entry.name), "name": name[:80]})
    return rows


def _windows_processes() -> list[dict]:
    try:
        proc = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            check=False,
            timeout=15,
            capture_output=True,
            shell=False,
            text=True,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    rows: list[dict] = []
    for line in (proc.stdout or "").splitlines():
        if len(rows) >= LIST_LIMIT:
            break
        parts = [part.strip().strip('"') for part in line.split(",")]
        if len(parts) < 2 or not parts[1].isdigit():
            continue
        rows.append({"pid": int(parts[1]), "name": parts[0][:80]})
    return rows


def _process_name(pid: int) -> str | None:
    system = platform.system().lower()
    if system == "windows":
        for row in _windows_processes():
            if row["pid"] == pid:
                return str(row["name"])
        return None
    comm = Path(f"/proc/{int(pid)}/comm")
    try:
        return comm.read_text(encoding="utf-8", errors="replace").strip()[:80]
    except OSError:
        return None


def execute(job: dict, host: RealHost, *, granted: list[str]) -> dict:
    """Run one dispatched job. Refuses anything the controller did not approve."""
    try:
        spec = ops.get_op(str(job.get("op") or ""))
        if spec.capability not in (granted or []):
            raise ops.AgentOpError("capacité refusée")
        if job.get("approved") is not True:
            raise ops.AgentOpError("approbation requise")
        args = ops.validate_args(spec.name, job.get("args") or {})
        timeout = int(job.get("timeout_sec") or 20)
        summary, output, artifact = _dispatch(spec.name, args, host, timeout)
        result = {"ok": True, "summary": summary[:240], "output": output[: proto.OUTPUT_MAX], "error": ""}
        if artifact is not None:
            name, data = artifact
            result["artifact_name"] = name
            result["artifact_bytes"] = data
        return result
    except ops.AgentOpError as exc:
        return {"ok": False, "summary": "", "output": "", "error": str(exc)[:300]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "summary": "", "output": "", "error": "délai dépassé"}
    except OSError as exc:
        return {"ok": False, "summary": "", "output": "", "error": str(exc)[:300]}


def _dispatch(name: str, args: dict, host: RealHost, timeout: int) -> tuple[str, str, tuple[str, bytes] | None]:
    if name == "system.status":
        payload = host.status()
        return "état lu", _fmt(payload), None
    if name == "system.telemetry":
        return "télémétrie lue", _fmt(host.telemetry()), None
    if name == "fs.list":
        listed = host.list_dir(args.get("workspace") or "default", args.get("path") or "", int(args.get("depth") or 1))
        return f"{len(listed['entries'])} entrées", _fmt(listed), None
    if name == "fs.read":
        text = host.read_file(args["workspace"], args["path"])
        return "fichier lu", text, None
    if name == "fs.write":
        host.write_file(args["workspace"], args["path"], args["text"])
        return "fichier écrit", args["path"], None
    if name == "fs.copy":
        written = host.copy_file(args["workspace"], args["src"], args["dest"])
        return "fichier copié", written, None
    if name == "fs.stage":
        artifact_name, data = host.stage_file(args["workspace"], args["path"])
        return "fichier préparé", artifact_name, (artifact_name, data)
    if name == "screenshot.capture":
        artifact_name, data = host.screenshot()
        return "capture prise", artifact_name, (artifact_name, data)
    if name == "apps.list":
        rows = host.apps()
        return f"{len(rows)} applications", _fmt({"apps": rows}), None
    if name == "apps.launch":
        host.launch_app(args["id"])
        return "application lancée", args["id"], None
    if name == "process.list":
        rows = host.processes()
        return f"{len(rows)} processus", _fmt({"processes": rows[:LIST_LIMIT]}), None
    if name == "process.kill":
        host.kill(int(args["pid"]), str(args["name"]))
        return "processus arrêté", str(args["pid"]), None
    if name == "power.lock":
        host.power("lock", approved=True)
        return "session verrouillée", "", None
    if name == "power.sleep":
        host.power("sleep", approved=True)
        return "mise en veille", "", None
    if name == "power.restart":
        host.power("restart", approved=True)
        return "redémarrage demandé", "", None
    if name == "power.shutdown":
        host.power("shutdown", approved=True)
        return "arrêt demandé", "", None
    if name == "clipboard.read":
        return "presse-papiers lu", host.clipboard_read(), None
    if name == "clipboard.write":
        host.clipboard_write(args["text"])
        return "presse-papiers écrit", "", None
    if name == "terminal.run_allowlisted":
        ran = host.run_allowlisted(args["id"], timeout)
        summary = "commande allowlist terminée" if ran["code"] == 0 else "commande allowlist en erreur"
        return summary, ran["output"], None
    raise ops.AgentOpError("opération inconnue")


def _fmt(payload: dict) -> str:
    import json

    return json.dumps(payload, ensure_ascii=False)[: proto.OUTPUT_MAX]
