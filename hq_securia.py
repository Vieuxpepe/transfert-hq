"""Securia — HQ cybersecurity & network telemetry AI steward.

Memory is separate from every other HQ assistant (roster: hq_personas).
Uses hq_ai.generate for replies; tools inspect hq_security traffic,
security events, active sessions, rate limiter, and tripwire state.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
import json
import os
import re
import threading
import time

import hq_security

STATE_FOLDER = ".hq-security"
THREAD_FILE = "securia_thread.json"
MAX_THREAD = 40
MAX_MESSAGE = 4000
MAX_ROUNDS = 3
MAX_TOTAL_TOOLS = 6

_bound_root: Path | None = None
_sessions_getter: Callable[[], list[dict[str, Any]]] | None = None
_revoke_session_fn: Callable[[str], bool] | None = None
_rate_limiter_getter: Callable[[], dict[str, Any]] | None = None
_config_getter: Callable[[], dict[str, Any]] | None = None
_presence_getter: Callable[[], list[dict[str, Any]]] | None = None
_lock = threading.RLock()


class SecuriaError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "validation_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


import hq_personas

PERSONA_CORE = f"""Tu es Securia, la sentinelle IA de cybersécurité et d'inspection système de Transfert HQ.
Tu surveilles le trafic HTTP, la provenance des connexions (localhost, LAN, Tailscale), les tentatives de connexion, les sessions actives, le rate-limiting, le tripwire et les fichiers/logs du projet pour le Maître (Marc-Antoine).
Tu es distincte de {hq_personas.others_line('securia')} : ta mémoire est dédiée à la sécurité du pont.
Ta personnalité (stricte mais taquine / playful) :
- Discipline de fer sur le périmètre : tu ne laisses rien passer, tu recadres avec autorité les mauvaises pratiques (sessions oubliées, rafales douteuses, tentatives de PIN bancales) et tu prends la défense du serveur très au sérieux.
- Mais tu es complice et taquine avec le Maître : humour sec, piques légères, un brin joueuse quand un intrus se cogne au rate-limiter ou quand le Maître te demande un audit en plein milieu de la nuit.
- Appelle Marc-Antoine « Maître » ou « Master ». Réponds en français s'il écrit en français, en anglais s'il écrit en anglais.
- Sois concise et factuelle : cite les vraies IPs, routes, fichiers, numéros de ligne, codes HTTP et compteurs retournés par tes outils.
- N'invente JAMAIS de métriques, de lignes de code ou d'événements. Si tu n'as pas vérifié, appelle un outil.
- Pour les actions sensibles (`revoke_session`, `block_ip`, `unblock_ip`, `rearm_tripwire`), ne les exécute QUE si le Maître le demande explicitement.
"""

PERSONA_CORE += "\n" + hq_personas.quirks_line("securia")


TOOL_SCHEMA = """Réponds UNIQUEMENT en JSON valide (sans bloc markdown) avec cette structure :
{"reply":"réponse pour le Maître","tools":[{"name":"tool_name","args":{...}}]}
`tools` peut être [] si aucune inspection supplémentaire n'est requise. Max 3 outils par tour.
Outils autorisés :
- get_traffic_summary args:{} -> KPIs globaux, requêtes/min, répartition 2xx/4xx/5xx et provenance (localhost, tailscale, lan, unknown).
- get_recent_requests args:{"limit":25,"only_errors":false} -> Dernières requêtes HTTP enrichies avec l'appareil connu s'il correspond, IP, provenance, méthode, route, statut et format PIN tenté.
- get_security_events args:{"limit":25} -> Événements du journal SECURITY_LOG (connexions, échecs PIN, rate-limits, tripwire, révocations).
- list_active_sessions args:{} -> Sessions actuellement ouvertes (id abrégé, utilisateur, rôle, dernière activité, inactivité en sec).
- list_known_devices args:{} -> Appareils actuellement enregistrés dans Transfert HQ (`presence_list`) avec IP, nom, plateforme et statut en ligne.
- get_rate_limiter_status args:{} -> État du limiteur de débit et IPs en cooldown.
- get_tripwire_status args:{} -> État complet du Tripwire (state: armed/tripped/lockdown/disarmed, seuil, échecs récents, cooldown).
- rearm_tripwire args:{"action":"rearm","threshold":2,"release_lockdown":false} -> Arme, réarme (`rearm`/`arm`), désarme (`disarm`) ou lève le lockdown du Tripwire (uniquement sur demande explicite du Maître).
- check_ip_reputation args:{"ip":"1.2.3.4"} -> Dossier complet sur une IP : appareil connu éventuel, requêtes récentes, routes ciblées, codes HTTP, événements sécurité, état rate-limit et quarantaine.
- list_blocked_ips args:{} -> Liste des IPs actuellement mises en quarantaine/bloquées par Securia.
- block_ip args:{"ip":"1.2.3.4","duration_sec":0,"reason":"..."} -> Met une IP suspecte en quarantaine (`duration_sec`: 0 = permanente, sinon temporaire en secondes). Jamais sur localhost. Uniquement sur ordre explicite du Maître.
- unblock_ip args:{"ip":"1.2.3.4"} -> Retire une IP de la quarantaine (uniquement sur ordre explicite du Maître).
- export_security_report args:{"title":"Audit incident"} -> Exporte un rapport d'incident Markdown horodaté dans `.hq-security/reports/` (trafic, alertes, sessions, IPs bloquées, appareils).
- list_project_files args:{"subdir":"","pattern":"*","limit":60} -> Liste les fichiers lisibles du projet Transfert HQ (code, logs, docs, assets).
- read_project_file args:{"path":"hq_security.py","start_line":1,"max_lines":120} -> Lit les lignes d'un fichier du projet (lecture seule, fichiers secrets bloqués).
- search_project_text args:{"query":"...","subdir":"","limit":25} -> Recherche un motif texte dans les fichiers du projet (.py, .js, .css, .md, .log, .json non-secrets).
- read_security_log_file args:{"limit":40,"filter_event":""} -> Lit les entrées persistées du journal de sécurité (.hq-security) ou SECURITY_LOG.
- revoke_session args:{"session_id_prefix":"..."} -> Révoque une session active dont le token commence par ce préfixe (uniquement sur demande explicite du Maître).
Après avoir reçu les résultats d'un outil, synthétise clairement la situation avec tools:[].
"""


def bind(
    *,
    root: str | Path,
    sessions_getter: Callable[[], list[dict[str, Any]]] | None = None,
    revoke_session_fn: Callable[[str], bool] | None = None,
    rate_limiter_getter: Callable[[], dict[str, Any]] | None = None,
    config_getter: Callable[[], dict[str, Any]] | None = None,
    presence_getter: Callable[[], list[dict[str, Any]]] | None = None,
) -> None:
    global _bound_root, _sessions_getter, _revoke_session_fn, _rate_limiter_getter, _config_getter, _presence_getter
    _bound_root = Path(root)
    _sessions_getter = sessions_getter
    _revoke_session_fn = revoke_session_fn
    _rate_limiter_getter = rate_limiter_getter
    _config_getter = config_getter
    _presence_getter = presence_getter


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _state_dir() -> Path:
    base = _bound_root or Path(".")
    d = base / STATE_FOLDER
    d.mkdir(parents=True, exist_ok=True)
    return d


def _thread_path() -> Path:
    return _state_dir() / THREAD_FILE


def get_thread() -> dict[str, Any]:
    with _lock:
        p = _thread_path()
        if not p.is_file():
            return {"messages": []}
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("messages"), list):
                return data
        except Exception:
            pass
        return {"messages": []}


def _save_thread(messages: list[dict[str, Any]]) -> None:
    with _lock:
        trimmed = messages[-MAX_THREAD:]
        p = _thread_path()
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps({"messages": trimmed}, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, p)


def clear_thread() -> dict[str, Any]:
    with _lock:
        _save_thread([])
        return {"ok": True, "messages": []}


def _sec_log_tail(limit: int = 25) -> list[dict[str, Any]]:
    try:
        import hq_diagnostics
        return hq_diagnostics.SECURITY_LOG.tail(max(1, min(100, int(limit))))
    except Exception:
        return []


_BLOCKED_NAMES = {
    ".env", "config.json", "secrets.json", "credentials.json",
    "sessions.json", "tokens.json", "pins.json",
}
_BLOCKED_SUFFIXES = (".pem", ".key", ".pfx", ".p12", ".sqlite", ".db", ".pyc", ".exe", ".dll", ".webp", ".png", ".jpg", ".gif", ".mp3", ".wav")
_SEARCHABLE_SUFFIXES = (".py", ".js", ".css", ".html", ".md", ".txt", ".log", ".json", ".jsonl", ".ps1", ".yaml", ".yml")
_REDACT_KEY_RE = re.compile(r'((?:api_key|token|secret|password|pin|passphrase|resend_api_key|brevo_api_key|smtp_pass)\s*["\':=]+\s*)([^\s,"\'\n\r\}]+)', re.IGNORECASE)


def _project_root() -> Path:
    return (_bound_root or Path(".")).resolve()


def _is_sensitive_path(rel_parts: tuple[str, ...], name: str) -> bool:
    low_name = name.lower()
    if low_name in _BLOCKED_NAMES or low_name.startswith(".env"):
        return True
    if any(low_name.endswith(sfx) for sfx in _BLOCKED_SUFFIXES):
        return True
    if any(part.lower() in (".git", "__pycache__", "node_modules", ".venv", "venv") for part in rel_parts):
        return True
    if ".hq-security" in [p.lower() for p in rel_parts] and low_name not in ("securia_thread.json", "security.log", "security.jsonl", "events.jsonl"):
        return True
    return False


def _resolve_safe_path(rel_path: str) -> Path:
    root = _project_root()
    cleaned = (rel_path or "").strip().lstrip("/\\")
    target = (root / cleaned).resolve()
    try:
        rel = target.relative_to(root)
    except ValueError as exc:
        raise SecuriaError("Accès hors du répertoire projet interdit.") from exc
    if _is_sensitive_path(rel.parts, target.name):
        raise SecuriaError(f"Lecture refusée pour fichier sensible/binaire : {rel.as_posix()}")
    return target


def _redact_text(text: str) -> str:
    return _REDACT_KEY_RE.sub(r"\1[REDACTED]", text)


def _known_devices_by_ip() -> dict[str, dict[str, Any]]:
    mapping: dict[str, dict[str, Any]] = {}
    if not _presence_getter:
        return mapping
    try:
        devices = _presence_getter() or []
    except Exception:
        return mapping
    for d in devices:
        if not isinstance(d, dict):
            continue
        label = str(d.get("name") or d.get("device") or d.get("hostname") or d.get("id") or "Appareil HQ").strip()
        info = {
            "name": label,
            "kind": d.get("kind") or d.get("platform") or "",
            "online": bool(d.get("online", True)),
            "ago_sec": d.get("ago_sec"),
        }
        for key in ("ip", "tailscale_ip", "lan_ip", "client_ip"):
            val = str(d.get(key) or "").strip()
            if val:
                mapping[val] = info
    return mapping


def _label_ip(ip: str, devices_map: dict[str, dict[str, Any]] | None = None) -> str | None:
    clean = (ip or "").strip()
    if not clean:
        return None
    dmap = devices_map if devices_map is not None else _known_devices_by_ip()
    if clean in dmap:
        return dmap[clean]["name"]
    if clean in ("127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"):
        return "HQ Host (localhost)"
    return None


def _execute_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    try:
        if name == "get_traffic_summary":
            snap = hq_security.TRAFFIC_TRACKER.snapshot()
            return {
                "name": name,
                "ok": True,
                "result": {
                    "total_requests": snap.get("total_requests", 0),
                    "requests_last_minute": snap.get("requests_last_minute", 0),
                    "active_connections": snap.get("active_connections", 0),
                    "uptime_seconds": snap.get("uptime_seconds", 0),
                    "status_counts": snap.get("status_counts", {}),
                    "provenance_counts": snap.get("provenance_counts", {}),
                },
            }

        if name == "get_recent_requests":
            lim = max(1, min(50, int(args.get("limit", 25) or 25)))
            only_errors = bool(args.get("only_errors", False))
            snap = hq_security.TRAFFIC_TRACKER.snapshot()
            dmap = _known_devices_by_ip()
            reqs = list(snap.get("recent_requests") or [])
            if only_errors:
                reqs = [r for r in reqs if int(r.get("status", 200)) >= 400]
            enriched = []
            for r in reqs[-lim:]:
                item = dict(r)
                dev = _label_ip(str(r.get("ip") or ""), dmap)
                if dev:
                    item["known_device"] = dev
                enriched.append(item)
            return {"name": name, "ok": True, "result": enriched}

        if name == "list_known_devices":
            devices = _presence_getter() if _presence_getter else []
            out = [
                {
                    "name": d.get("name") or d.get("device") or d.get("id"),
                    "ip": d.get("ip"),
                    "tailscale_ip": d.get("tailscale_ip"),
                    "kind": d.get("kind") or d.get("platform"),
                    "online": bool(d.get("online", True)),
                    "ago_sec": d.get("ago_sec"),
                }
                for d in (devices or [])
                if isinstance(d, dict)
            ]
            return {"name": name, "ok": True, "result": out}

        if name == "get_security_events":
            lim = max(1, min(50, int(args.get("limit", 25) or 25)))
            return {"name": name, "ok": True, "result": _sec_log_tail(lim)}

        if name == "list_active_sessions":
            sessions = _sessions_getter() if _sessions_getter else []
            sanitized = [
                {
                    "id": s.get("id"),
                    "user": s.get("user"),
                    "role": s.get("role"),
                    "created_h": s.get("created_h"),
                    "last_seen_h": s.get("last_seen_h"),
                    "idle_sec": s.get("idle_sec"),
                }
                for s in sessions
            ]
            return {"name": name, "ok": True, "result": sanitized}

        if name == "get_rate_limiter_status":
            rl = _rate_limiter_getter() if _rate_limiter_getter else {}
            return {"name": name, "ok": True, "result": rl}

        if name == "get_tripwire_status":
            cfg = _config_getter() if _config_getter else {}
            return {
                "name": name,
                "ok": True,
                "result": hq_security.tripwire_status(cfg),
            }

        if name == "rearm_tripwire":
            cfg = _config_getter() if _config_getter else None
            if cfg is None:
                return {"name": name, "ok": False, "error": "Configuration indisponible"}
            action = str(args.get("action") or "rearm").strip().lower()
            threshold = args.get("threshold")
            thr_val = int(threshold) if threshold is not None else None
            release_ld = bool(args.get("release_lockdown", False))
            if action == "disarm":
                res = hq_security.arm_or_rearm_tripwire(cfg, enabled=False, threshold=thr_val)
            else:
                res = hq_security.arm_or_rearm_tripwire(cfg, enabled=True, threshold=thr_val, release_lockdown=release_ld)
            return {"name": name, "ok": True, "result": res}

        if name == "check_ip_reputation":
            target_ip = str(args.get("ip") or "").strip()
            if not target_ip:
                return {"name": name, "ok": False, "error": "Paramètre 'ip' requis"}
            snap = hq_security.TRAFFIC_TRACKER.snapshot()
            reqs = [r for r in (snap.get("recent_requests") or []) if str(r.get("ip") or "") == target_ip]
            events = [e for e in _sec_log_tail(100) if str(e.get("ip") or "") == target_ip]
            rl = _rate_limiter_getter() if _rate_limiter_getter else {}
            is_blk, blk_rec = hq_security.IP_BLOCKLIST.is_blocked(target_ip)
            status_breakdown: dict[str, int] = {}
            routes: dict[str, int] = {}
            for r in reqs:
                st = str(r.get("status", ""))
                status_breakdown[st] = status_breakdown.get(st, 0) + 1
                rt = str(r.get("path") or "")
                routes[rt] = routes.get(rt, 0) + 1
            return {
                "name": name,
                "ok": True,
                "result": {
                    "ip": target_ip,
                    "known_device": _label_ip(target_ip),
                    "blocked": is_blk,
                    "block_record": blk_rec,
                    "recent_request_count": len(reqs),
                    "status_breakdown": status_breakdown,
                    "top_routes": sorted(routes.items(), key=lambda x: x[1], reverse=True)[:10],
                    "recent_requests": reqs[-15:],
                    "security_events": events[-15:],
                    "rate_limiter_state": rl.get(target_ip) if isinstance(rl, dict) else None,
                },
            }

        if name == "list_blocked_ips":
            return {"name": name, "ok": True, "result": hq_security.IP_BLOCKLIST.list_blocked()}

        if name == "block_ip":
            target_ip = str(args.get("ip") or "").strip()
            reason = str(args.get("reason") or "").strip()
            duration = int(args.get("duration_sec", 0) or 0)
            ok, msg = hq_security.IP_BLOCKLIST.block(target_ip, reason=reason, duration_sec=duration)
            return {"name": name, "ok": ok, "result": {"ip": target_ip, "message": msg}}

        if name == "unblock_ip":
            target_ip = str(args.get("ip") or "").strip()
            ok, msg = hq_security.IP_BLOCKLIST.unblock(target_ip)
            return {"name": name, "ok": ok, "result": {"ip": target_ip, "message": msg}}

        if name == "export_security_report":
            title = str(args.get("title") or "Rapport d'incident Securia").strip()[:120]
            snap = hq_security.TRAFFIC_TRACKER.snapshot()
            events = _sec_log_tail(40)
            sessions = _sessions_getter() if _sessions_getter else []
            blocked = hq_security.IP_BLOCKLIST.list_blocked()
            dmap = _known_devices_by_ip()
            now_dt = datetime.now(timezone.utc)
            fname = f"incident_{now_dt.strftime('%Y%m%d_%H%M%S')}.md"
            rep_dir = _state_dir() / "reports"
            rep_dir.mkdir(parents=True, exist_ok=True)
            rep_path = rep_dir / fname

            err_reqs = [r for r in (snap.get("recent_requests") or []) if int(r.get("status", 200)) >= 400][-40:]
            lines = [
                f"# {title}",
                f"- **Généré (UTC)** : {now_dt.isoformat(timespec='seconds')}",
                f"- **Total requêtes** : {snap.get('total_requests', 0)} ({snap.get('requests_last_minute', 0)} req/min)",
                f"- **Statuts HTTP** : {json.dumps(snap.get('status_counts', {}), ensure_ascii=False)}",
                f"- **Provenances** : {json.dumps(snap.get('provenance_counts', {}), ensure_ascii=False)}",
                "",
                f"## Sessions actives ({len(sessions)})",
            ]
            for s in sessions:
                lines.append(f"- `{s.get('id')}` · {s.get('user')} ({s.get('role')}) · idle {s.get('idle_sec')}s")
            lines.extend(["", f"## IPs en quarantaine ({len(blocked)})"])
            for b in blocked:
                lines.append(f"- `{b.get('ip')}` · {b.get('reason')} · depuis {b.get('blocked_at')}")
            lines.extend(["", f"## Appareils connus ({len(dmap)})"])
            for ip_k, info in dmap.items():
                lines.append(f"- `{ip_k}` -> {info.get('name')} ({info.get('kind')})")
            lines.extend(["", f"## Requêtes en erreur récentes ({len(err_reqs)})"])
            for r in err_reqs:
                dev = _label_ip(str(r.get("ip") or ""), dmap) or r.get("provenance")
                lines.append(f"- `{r.get('time')}` `{r.get('ip')}` ({dev}) `{r.get('method')} {r.get('path')}` -> **{r.get('status')}** ({r.get('pin_hint') or '-'})")
            lines.extend(["", f"## Événements SECURITY_LOG ({len(events)})"])
            for ev in events:
                lines.append(f"- `{ev.get('ts', '')}` **{ev.get('event')}** `{ev.get('ip', '')}`")
            rep_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            rel_out = f"{STATE_FOLDER}/reports/{fname}"
            return {"name": name, "ok": True, "result": {"path": rel_out, "events": len(events), "errors": len(err_reqs)}}

        if name == "list_project_files":
            subdir = str(args.get("subdir") or "").strip()
            pattern = str(args.get("pattern") or "*").strip() or "*"
            lim = max(1, min(150, int(args.get("limit", 60) or 60)))
            root = _project_root()
            base = _resolve_safe_path(subdir) if subdir else root
            if not base.is_dir():
                return {"name": name, "ok": False, "error": f"Dossier introuvable : {subdir}"}
            files: list[str] = []
            for p in base.rglob(pattern):
                if not p.is_file():
                    continue
                rel = p.relative_to(root)
                if _is_sensitive_path(rel.parts, p.name):
                    continue
                files.append(rel.as_posix())
                if len(files) >= lim:
                    break
            return {"name": name, "ok": True, "result": {"count": len(files), "files": files}}

        if name == "read_project_file":
            rel_path = str(args.get("path") or "").strip()
            if not rel_path:
                return {"name": name, "ok": False, "error": "Paramètre 'path' requis"}
            target = _resolve_safe_path(rel_path)
            if not target.is_file():
                return {"name": name, "ok": False, "error": f"Fichier introuvable : {rel_path}"}
            start_line = max(1, int(args.get("start_line", 1) or 1))
            max_lines = max(1, min(180, int(args.get("max_lines", 120) or 120)))
            lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
            total = len(lines)
            chunk = lines[start_line - 1 : start_line - 1 + max_lines]
            numbered = [f"{start_line + idx}: {_redact_text(line)}" for idx, line in enumerate(chunk)]
            return {
                "name": name,
                "ok": True,
                "result": {
                    "path": target.relative_to(_project_root()).as_posix(),
                    "total_lines": total,
                    "start_line": start_line,
                    "end_line": start_line + len(chunk) - 1,
                    "content": "\n".join(numbered),
                },
            }

        if name == "search_project_text":
            query = str(args.get("query") or "").strip()
            if len(query) < 2:
                return {"name": name, "ok": False, "error": "Requête trop courte (min 2 caractères)"}
            subdir = str(args.get("subdir") or "").strip()
            lim = max(1, min(50, int(args.get("limit", 25) or 25)))
            root = _project_root()
            base = _resolve_safe_path(subdir) if subdir else root
            if not base.is_dir():
                return {"name": name, "ok": False, "error": f"Dossier introuvable : {subdir}"}
            q_low = query.lower()
            hits: list[dict[str, Any]] = []
            for p in base.rglob("*"):
                if not p.is_file():
                    continue
                rel = p.relative_to(root)
                if _is_sensitive_path(rel.parts, p.name):
                    continue
                if not any(p.name.lower().endswith(sfx) for sfx in _SEARCHABLE_SUFFIXES):
                    continue
                try:
                    if p.stat().st_size > 1_500_000:
                        continue
                    for idx, line in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                        if q_low in line.lower():
                            hits.append({
                                "file": rel.as_posix(),
                                "line": idx,
                                "text": _redact_text(line.strip())[:220],
                            })
                            if len(hits) >= lim:
                                return {"name": name, "ok": True, "result": {"query": query, "hits": hits, "truncated": True}}
                except Exception:
                    continue
            return {"name": name, "ok": True, "result": {"query": query, "hits": hits, "truncated": False}}

        if name == "read_security_log_file":
            lim = max(1, min(80, int(args.get("limit", 40) or 40)))
            filt = str(args.get("filter_event") or "").strip().lower()
            sec_dir = _state_dir()
            disk_entries: list[dict[str, Any]] = []
            for fname in ("security.jsonl", "events.jsonl", "security.log"):
                fp = sec_dir / fname
                if fp.is_file():
                    try:
                        raw_lines = fp.read_text(encoding="utf-8", errors="replace").splitlines()[-200:]
                        for ln in raw_lines:
                            ln = ln.strip()
                            if not ln:
                                continue
                            try:
                                obj = json.loads(ln)
                                if not filt or filt in str(obj.get("event", "")).lower():
                                    disk_entries.append(obj)
                            except Exception:
                                if not filt or filt in ln.lower():
                                    disk_entries.append({"raw": _redact_text(ln)[:240]})
                    except Exception:
                        pass
            if disk_entries:
                return {"name": name, "ok": True, "result": {"source": "disk", "entries": disk_entries[-lim:]}}
            mem_entries = [
                e for e in _sec_log_tail(100)
                if not filt or filt in str(e.get("event", "")).lower()
            ]
            return {"name": name, "ok": True, "result": {"source": "memory", "entries": mem_entries[-lim:]}}

        if name == "revoke_session":
            prefix = str(args.get("session_id_prefix") or "").strip().rstrip("…")
            if len(prefix) < 4:
                return {"name": name, "ok": False, "error": "Préfixe de session trop court (min 4 caractères)"}
            if not _sessions_getter or not _revoke_session_fn:
                return {"name": name, "ok": False, "error": "Révocation indisponible"}
            matches = [s for s in _sessions_getter() if str(s.get("token", "")).startswith(prefix)]
            if not matches:
                return {"name": name, "ok": False, "error": f"Aucune session trouvée pour '{prefix}'"}
            if len(matches) > 1:
                return {"name": name, "ok": False, "error": f"Préfixe ambigu ({len(matches)} sessions)"}
            ok = _revoke_session_fn(matches[0]["token"])
            return {"name": name, "ok": ok, "result": {"revoked_id": matches[0].get("id"), "user": matches[0].get("user")}}

        return {"name": name, "ok": False, "error": f"Outil inconnu: {name}"}
    except Exception as exc:
        return {"name": name, "ok": False, "error": str(exc)}


def _parse_model_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            reply = str(data.get("reply") or "").strip()
            tools = data.get("tools")
            if not isinstance(tools, list):
                tools = []
            clean_tools = []
            for t in tools:
                if isinstance(t, dict) and isinstance(t.get("name"), str):
                    args = t.get("args") if isinstance(t.get("args"), dict) else {}
                    clean_tools.append({"name": t["name"].strip(), "args": args})
            return {"reply": reply, "tools": clean_tools}
    except Exception:
        pass
    return {"reply": text, "tools": []}


def _history_contents(messages: list[dict[str, Any]], user_text: str) -> list[dict[str, Any]]:
    contents: list[dict[str, Any]] = []
    for m in messages[-16:]:
        role = "model" if m.get("role") == "assistant" else "user"
        txt = str(m.get("text") or "").strip()
        if txt:
            contents.append({"role": role, "parts": [{"text": txt}]})
    contents.append({"role": "user", "parts": [{"text": user_text}]})
    return contents


def status_summary() -> dict[str, Any]:
    snap = hq_security.TRAFFIC_TRACKER.snapshot()
    events = _sec_log_tail(30)
    failures = sum(1 for e in events if e.get("event") in ("auth.login.failure", "auth.rate_limited"))
    s5xx = (snap.get("status_counts") or {}).get("5xx", 0)
    rate = snap.get("requests_last_minute", 0)
    blocked = hq_security.IP_BLOCKLIST.list_blocked()
    dmap = _known_devices_by_ip()

    # Count auth failures per IP for proactive non-spam alerts
    ip_fails: dict[str, int] = {}
    for e in events:
        if e.get("event") in ("auth.login.failure", "auth.rate_limited"):
            eip = str(e.get("ip") or "").strip()
            if eip:
                ip_fails[eip] = ip_fails.get(eip, 0) + 1

    proactive_alert: dict[str, Any] | None = None
    if ip_fails:
        top_ip, top_cnt = max(ip_fails.items(), key=lambda x: x[1])
        if top_cnt >= 3:
            dev = _label_ip(top_ip, dmap)
            bucket = top_cnt // 3
            if dev:
                msg = f"Maître, {dev} ({top_ip}) vient d'enchaîner {top_cnt} échecs de PIN. Tu as oublié ton propre code ou tu me testes ?"
            else:
                msg = f"Alerte périmètre : l'IP inconnue {top_ip} a raté {top_cnt} tentatives d'accès. Je la mets en quarantaine si tu veux."
            proactive_alert = {
                "id": f"authfail:{top_ip}:{bucket}",
                "level": "warning",
                "ip": top_ip,
                "device": dev,
                "message": msg,
            }
    elif s5xx >= 3:
        proactive_alert = {
            "id": f"s5xx:{s5xx // 3}",
            "level": "warning",
            "ip": "",
            "device": None,
            "message": f"Maître, {s5xx} erreurs serveur 5xx détectées. Un module tousse — viens jeter un œil.",
        }

    if failures > 0:
        alert_level = "warning"
        headline = f"{failures} rejet(s) d'authentification récent(s)"
    elif s5xx > 0:
        alert_level = "warning"
        headline = f"{s5xx} erreur(s) serveur 5xx"
    elif rate > 120:
        alert_level = "busy"
        headline = f"Trafic intense ({rate} req/min)"
    else:
        alert_level = "ok"
        headline = "Périmètre sain"

    return {
        "ok": True,
        "alert_level": alert_level,
        "headline": headline,
        "requests_last_minute": rate,
        "total_requests": snap.get("total_requests", 0),
        "failures_recent": failures,
        "blocked_count": len(blocked),
        "proactive_alert": proactive_alert,
        "thread": get_thread().get("messages", []),
    }


def chat(message: Any) -> dict[str, Any]:
    import hq_ai

    if not isinstance(message, str) or not message.strip():
        raise SecuriaError("Message requis")
    text = message.strip()[:MAX_MESSAGE]

    thread = get_thread()
    messages = list(thread.get("messages") or [])
    contents = _history_contents(messages, text)

    system = f"{PERSONA_CORE}\n{TOOL_SCHEMA}"
    tools_used: list[str] = []
    reply = ""
    model = None

    for round_idx in range(MAX_ROUNDS):
        final_round = round_idx == MAX_ROUNDS - 1 or len(tools_used) >= MAX_TOTAL_TOOLS
        instructions = system
        if final_round:
            instructions += "\nBudget d'outils terminé. Donne ta réponse finale avec tools:[]."

        try:
            raw, model = hq_ai.generate(
                hq_ai.ASK_CHAIN,
                instructions,
                list(contents),
                json_out=True,
                temperature=0.3,
                max_tokens=1000,
            )
        except hq_ai.AiError as exc:
            if not tools_used:
                raise SecuriaError(str(exc), getattr(exc, "status", 502), getattr(exc, "code", "ai_error")) from exc
            reply = "La synthèse IA a échoué après inspection des outils."
            break

        parsed = _parse_model_json(raw)
        reply = parsed["reply"]
        requested_tools = parsed["tools"][: max(0, MAX_TOTAL_TOOLS - len(tools_used))]

        if final_round or not requested_tools:
            break

        tool_outputs = []
        for t in requested_tools:
            res = _execute_tool(t["name"], t["args"])
            tools_used.append(t["name"])
            tool_outputs.append(res)

        evidence_json = json.dumps(tool_outputs, ensure_ascii=False)
        contents.append({"role": "model", "parts": [{"text": json.dumps({"reply": reply, "tools": requested_tools}, ensure_ascii=False)}]})
        contents.append({"role": "user", "parts": [{"text": f"Résultats des outils :\n{evidence_json}"}]})

    if not reply:
        reply = "Télémétrie inspectée. Aucune anomalie critique signalée."

    now = _utcnow()
    messages.append({"role": "user", "text": text, "utc": now})
    messages.append({
        "role": "assistant",
        "text": reply,
        "utc": _utcnow(),
        "tools_used": tools_used,
        "model": model,
    })
    _save_thread(messages)

    return {
        "ok": True,
        "reply": reply,
        "tools_used": tools_used,
        "model": model,
        "messages": messages[-MAX_THREAD:],
    }


def http_get(raw: str) -> tuple[int, dict[str, Any]]:
    if raw == "/api/securia/status":
        return 200, status_summary()
    return 404, {"error": "Route Securia inconnue"}


def http_post(raw: str, data: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    try:
        if raw == "/api/securia/chat":
            return 200, chat(data.get("message"))
        if raw == "/api/securia/clear":
            return 200, clear_thread()
        return 404, {"error": "Route Securia inconnue"}
    except SecuriaError as exc:
        return exc.status, {"error": exc.message if hasattr(exc, "message") else str(exc), "code": exc.code}
