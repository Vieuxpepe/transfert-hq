"""Engine agent: report this computer's daemons and resource use to Transfert HQ.

Runs on every extra PC you want to see in HQ's Engine tab. It only *sends* status (HQ never connects to it, and nothing HQ
shows can start or stop anything here).

Files needed on the PC: this script, ``hq_engine.py`` and ``hq_forge_worker.py`` (signing, DPAPI-protected credentials).

    py -3 scripts\\engine_agent.py pair --hq https://your-hq.tailnet.ts.net --name "PC salon"   (code is asked, or on stdin)
    py -3 scripts\\engine_agent.py run                                                          (leave it running / scheduled task)

Which daemons are watched comes from ``engine-agent.json`` next to the credentials (``%LOCALAPPDATA%\\TransfertHQ``):

    {"daemons": [{"id": "forge", "label": "Forge", "kind": "image", "port": 7860, "health_path": "/"},
                 {"id": "phonon", "label": "Phonon TTS", "kind": "voice", "port": 8058, "process_hint": "phonon_daemon"}]}

Without that file it watches Forge (7860), Phonon (8058) and XTTS (8057) by port.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import hq_engine as eng            # noqa: E402
import hq_forge_worker as wire     # noqa: E402

PREFIX = "/engine-agent/v1"
VERSION = 1
DEFAULT_DAEMONS = [
    {"id": "forge", "label": "Forge", "kind": "image", "port": 7860, "health_path": "/"},
    {"id": "phonon", "label": "Phonon TTS", "kind": "voice", "port": 8058, "process_hint": "phonon_daemon"},
    {"id": "xtts", "label": "Coqui XTTS", "kind": "voice", "port": 8057, "process_hint": "coqui_xtts_daemon"},
]
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def credentials_path() -> Path:
    return wire.default_credential_path().with_name("engine-agent.json")


def config_path() -> Path:
    return credentials_path().with_name("engine-agent-daemons.json")


def load_daemon_specs(path: Path | None = None) -> list[dict]:
    path = path or config_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        rows = data.get("daemons") if isinstance(data, dict) else None
        if isinstance(rows, list):
            return [r for r in rows if isinstance(r, dict) and ID_RE.fullmatch(str(r.get("id") or ""))][:24]
    except (OSError, ValueError):
        pass
    return list(DEFAULT_DAEMONS)


def register_specs(specs: list[dict]) -> None:
    """Observe-only daemons: the agent reports, it never controls."""
    eng._registry.clear()
    for s in specs:
        if not isinstance(s, dict) or not ID_RE.fullmatch(str(s.get("id") or "")):
            continue                                   # a hand-edited config must never crash the agent
        port = s.get("port")
        eng.register(eng.Daemon(
            id=s["id"], label=str(s.get("label") or s["id"])[:60], description="", observe_only=True,
            kind=s.get("kind") if s.get("kind") in ("core", "voice", "music", "apps", "image", "service") else "service",
            port=port if isinstance(port, int) and 0 < port < 65536 else None,
            health_path=s.get("health_path", "/health"), process_hint=str(s.get("process_hint") or "")))


def os_name() -> str:
    """platform.release() says "10" on Windows 11 under older Pythons; the build number tells them apart."""
    system, release = platform.system(), platform.release()
    if system == "Windows" and release == "10":
        try:
            if int(platform.version().split(".")[2]) >= 22000:
                release = "11"
        except (IndexError, ValueError):
            pass
    return f"{system} {release}"[:60]


def build_report() -> dict:
    st = eng.status()
    keep = ("id", "label", "kind", "state", "port", "pid", "rss_mb", "vram_mb", "cpu_pct", "uptime_s", "note")
    return {"host": platform.node()[:40], "os": os_name(), "version": VERSION,
            "system": {k: v for k, v in (st.get("system") or {}).items() if k != "history" and k != "host"},
            "daemons": [{k: d[k] for k in keep if d.get(k) is not None} for d in st.get("daemons", [])]}


class Agent:
    def __init__(self, base: str, machine_id: str, secret: str, *, transport=None) -> None:
        self.base, self.machine_id, self.secret = base.rstrip("/"), machine_id, secret
        self.transport = transport or wire.http_transport

    def post(self, route: str, payload: dict, *, signed: bool = True) -> dict:
        path = PREFIX + route
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if signed:
            headers.update(wire.signed_headers(self.machine_id, self.secret, "POST", path, body))
        status, raw = self.transport("POST", self.base + path, wire.HQ_TIMEOUT_SEC, body, headers, wire.MAX_HQ_RESPONSE)
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeError, ValueError):
            data = {}
        if status != 200:
            raise wire.HQError(status, data if isinstance(data, dict) else {})
        return data if isinstance(data, dict) else {}

    def report_once(self) -> dict:
        return self.post("/report", build_report())


def pair(hq: str, code: str, name: str, *, dev: bool = False, transport=None) -> dict:
    base = wire.validate_hq_url(hq, dev=dev)
    result = Agent(base, "", "", transport=transport).post("/enroll", {"code": code.strip(), "name": name[:40]}, signed=False)
    if not isinstance(result.get("machine_id"), str) or not isinstance(result.get("secret"), str):
        raise wire.HQError(500)
    return {"hq": base, "worker_id": result["machine_id"], "secret": result["secret"], "dev": bool(dev)}


def run_forever(agent: Agent, *, stop=None, log=print, sleep=time.sleep) -> None:
    delay = 1.0
    interval = 10.0
    while not (stop and stop.is_set()):
        try:
            interval = float(agent.report_once().get("report_sec") or 10)
            delay = interval
        except wire.HQError as exc:
            if exc.status == 401:
                log("HQ refuse la signature (appareil retiré ou horloge décalée). Relance « pair » avec un nouveau code.")
            delay = min(60.0, delay * 2)
        except (OSError, ValueError) as exc:
            log(f"HQ injoignable : {exc.__class__.__name__}")
            delay = min(60.0, delay * 2)
        sleep(max(2.0, delay))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Transfert HQ Engine agent", allow_abbrev=False)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("pair", help="Pair with HQ using the one-time code from the Engine tab.", allow_abbrev=False)
    p.add_argument("--hq", required=True)
    p.add_argument("--name", default=platform.node()[:40] or "PC")
    p.add_argument("--credentials", type=Path, default=credentials_path())
    p.add_argument("--code-file", type=Path)
    p.add_argument("--dev", action="store_true", help="Allow HTTP to a loopback HQ (tests only).")
    r = sub.add_parser("run", help="Report to HQ every few seconds.", allow_abbrev=False)
    r.add_argument("--credentials", type=Path, default=credentials_path())
    r.add_argument("--config", type=Path, default=config_path())
    args = parser.parse_args(argv)
    if args.command == "pair":
        if args.code_file:
            code = args.code_file.read_text(encoding="utf-8").strip()
        elif sys.stdin.isatty():
            import getpass
            code = getpass.getpass("Code d'appairage : ")
        else:
            code = sys.stdin.readline()
        try:
            creds = pair(args.hq, code, args.name, dev=args.dev)
        except (wire.HQError, ValueError, OSError) as exc:
            print(f"Appairage refusé : {getattr(exc, 'payload', {}).get('error') or exc.__class__.__name__}", file=sys.stderr)
            return 2
        state = wire.save_credentials(args.credentials, creds)
        print(f"Ordinateur appairé ({creds['worker_id']}). Identifiants : {args.credentials} (accès : {state}).")
        return 0
    creds = wire.load_credentials(args.credentials)
    wire.validate_hq_url(creds["hq"], dev=bool(creds.get("dev")))
    register_specs(load_daemon_specs(args.config))
    print(f"Agent {creds['worker_id']} actif.", file=sys.stderr)
    try:
        run_forever(Agent(creds["hq"], creds["worker_id"], creds["secret"]), log=lambda m: print(m, file=sys.stderr))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
