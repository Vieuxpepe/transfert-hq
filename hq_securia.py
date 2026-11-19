"""Securia — HQ cybersecurity & network telemetry AI steward.

Memory is separate from every other HQ assistant (roster: hq_personas).
Uses hq_ai.generate for replies; tools inspect hq_security traffic,
security events, active sessions, rate limiter, and tripwire state.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
import ipaddress
import json
import re
import secrets
import threading
import time

import hq_assistant_growth as assistant_growth
import hq_assistant_voice as assistant_voice
import hq_security
import hq_state

STATE_FOLDER = ".hq-security"
THREAD_FILE = "securia_thread.json"
GROWTH_FILE = "securia_growth.json"
MAX_THREAD = 40
MAX_MESSAGE = 4000
MAX_ROUNDS = 3
MAX_TOTAL_TOOLS = 6
DEFAULT_REPLY_ATTEMPTS = 3
MAX_REPLY_ATTEMPTS = 10
MAX_PROPOSALS = 3
CANCEL_TTL = 180.0
# These change real security state: the model may only queue them. They run from
# POST /api/securia/confirm, after the Master has seen a card in the chat.
MUTATING_TOOLS = frozenset({"block_ip", "unblock_ip", "rearm_tripwire", "revoke_session"})
_JOB_RE = re.compile(r"^[a-z0-9][a-z0-9-]{5,39}$")
_PROPOSAL_RE = re.compile(r"^scp-[0-9a-f]{8}$")
_cancelled: dict[str, float] = {}   # job -> when the Master pressed Arrêter

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
- Appelle Marc-Antoine « Maître » ou « Master ». Réponds toujours en anglais, même s'il écrit en français.
- Sois concise et factuelle : cite les vraies IPs, routes, fichiers, numéros de ligne, codes HTTP et compteurs retournés par tes outils.
- N'invente JAMAIS de métriques, de lignes de code ou d'événements. Si tu n'as pas vérifié, appelle un outil.
- Pour les actions sensibles (`revoke_session`, `block_ip`, `unblock_ip`, `rearm_tripwire`), tu ne disposes d'aucun accès direct : l'outil dépose une carte de confirmation que le Maître valide. Appelle-le quand il le demande explicitement, puis dis que l'action attend sa confirmation — ne prétends jamais qu'elle est déjà faite.
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
- get_honeypot_status args:{} -> Compteurs de sécurité observés. Aucune route leurre et aucun filtre d'user-agent n'est installé sur le pont : leurs compteurs valent 0, et tu dois le dire ainsi plutôt que d'annoncer une couverture. Inclut les quarantaines actives et les événements récents.
- get_weekly_security_report args:{"days":7} -> Bilan périodique de sécurité : compteurs observés dans le journal (aucun filtre UA ni leurre installé), quotas IA et registre de quarantaine.
- rearm_tripwire args:{"action":"rearm","threshold":2,"release_lockdown":false} -> Arme, réarme (`rearm`/`arm`), désarme (`disarm`) ou lève le lockdown du Tripwire. Dépose une carte de confirmation (jamais exécuté directement).
- check_ip_reputation args:{"ip":"1.2.3.4"} -> Dossier complet sur une IP : appareil connu éventuel, requêtes récentes, routes ciblées, codes HTTP, événements sécurité, état rate-limit et quarantaine.
- list_blocked_ips args:{} -> Liste des IPs actuellement mises en quarantaine/bloquées par Securia.
- block_ip args:{"ip":"1.2.3.4","duration_sec":0,"reason":"..."} -> Met une IP suspecte en quarantaine (`duration_sec`: 0 = permanente, sinon temporaire en secondes ; localhost et adresses locales sont refusés). Dépose une carte de confirmation (jamais exécuté directement).
- unblock_ip args:{"ip":"1.2.3.4"} -> Retire une IP de la quarantaine. Dépose une carte de confirmation.
- export_security_report args:{"title":"Audit incident"} -> Exporte un rapport d'incident Markdown horodaté dans `.hq-security/reports/` (trafic, alertes, sessions, IPs bloquées, appareils).
- list_project_files args:{"subdir":"","pattern":"*","limit":60} -> Liste les fichiers lisibles du projet Transfert HQ (code, logs, docs, assets).
- read_project_file args:{"path":"hq_security.py","start_line":1,"max_lines":120} -> Lit les lignes d'un fichier du projet (lecture seule, fichiers secrets bloqués).
- search_project_text args:{"query":"...","subdir":"","limit":25} -> Recherche un motif texte dans les fichiers du projet (.py, .js, .css, .md, .log, .json non-secrets).
- read_security_log_file args:{"limit":40,"filter_event":""} -> Lit les entrées persistées du journal de sécurité (.hq-security) ou SECURITY_LOG.
- revoke_session args:{"session_id_prefix":"..."} -> Révoque une session active dont le token commence par ce préfixe. Dépose une carte de confirmation (jamais exécuté directement).
Après avoir reçu les résultats d'un outil, synthétise clairement la situation avec tools:[]. Une action déposée pour confirmation n'est PAS encore appliquée : dis-le.
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


def growth_path() -> Path:
    return _state_dir() / GROWTH_FILE


def _record_growth(text: str) -> None:
    assistant_growth.record(growth_path(), text, "securia")


def _growth_hint(query: str) -> str:
    return assistant_growth.hint(_state_dir() / GROWTH_FILE, query)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _state_dir() -> Path:
    base = _bound_root or hq_state.state_root()
    d = base / STATE_FOLDER
    d.mkdir(parents=True, exist_ok=True)
    return d


def _thread_path() -> Path:
    return _state_dir() / THREAD_FILE


def _thread_revision(data: Any) -> int:
    rev = data.get("revision", 0) if isinstance(data, dict) else 0
    return rev if isinstance(rev, int) and not isinstance(rev, bool) and rev >= 0 else 0


def _thread_epoch(data: Any) -> int:
    """Conversation generation: only clear_thread() advances it."""
    epoch = data.get("clear_epoch", 0) if isinstance(data, dict) else 0
    return epoch if isinstance(epoch, int) and not isinstance(epoch, bool) and epoch >= 0 else 0


def _thread_schema_ok(data: Any) -> bool:
    if not isinstance(data, dict) or "messages" not in data:
        return False
    for key in ("revision", "clear_epoch"):
        if key in data and (isinstance(data[key], bool)
                            or not isinstance(data[key], int) or data[key] < 0):
            return False
    msgs = data["messages"]
    if not isinstance(msgs, list):
        return False
    return all(isinstance(m, dict) and m.get("role") in ("user", "assistant")
               and isinstance(m.get("text"), str) for m in msgs)


def _thread_unreadable() -> bool:
    """True when the thread exists but is not a valid message list (never replaced)."""
    p = _thread_path()
    if not p.is_file():
        return False
    try:
        return not _thread_schema_ok(json.loads(p.read_text(encoding="utf-8")))
    except Exception:
        return True


def _read_thread() -> dict[str, Any]:
    p = _thread_path()
    if not p.is_file():
        return {"messages": []}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SecuriaError("conversation illisible — fichier conservé", status=409, code="state_unreadable") from exc
    if not _thread_schema_ok(data):
        raise SecuriaError("conversation illisible — fichier conservé", status=409, code="state_unreadable")
    return data


def get_thread() -> dict[str, Any]:
    with _lock:
        data = _read_thread()
        msgs = data.get("messages")
        return {"messages": list(msgs) if isinstance(msgs, list) else [],
                "revision": _thread_revision(data), "clear_epoch": _thread_epoch(data)}


def _write_thread(data: dict[str, Any]) -> None:
    try:
        hq_state.write_json_atomic(_thread_path(), data)
    except RuntimeError as exc:
        raise SecuriaError(str(exc), status=409, code="state_unreadable") from exc


def _save_thread(messages: list[dict[str, Any]]) -> None:
    """Replace the thread and advance the epoch so in-flight replies are cancelled."""
    with _lock:
        if _thread_unreadable():
            raise SecuriaError("conversation illisible — fichier conservé", status=409, code="state_unreadable")
        data = _read_thread()
        updated = dict(data)
        updated.update({"messages": messages[-MAX_THREAD:],
                        "revision": _thread_revision(data) + 1,
                        "clear_epoch": _thread_epoch(data) + 1})
        _write_thread(updated)


def _append_turn(turn: list[dict[str, Any]], base_revision: int, base_epoch: int = 0) -> bool:
    """Append a completed turn without replacing turns saved meanwhile.

    Returns False without writing when ``base_epoch`` no longer matches: the
    conversation was cleared, so this turn belongs to the previous one and is
    dropped. Returns True when the turn had to rebase on newer messages.
    """
    with _lock:
        if _thread_unreadable():
            raise SecuriaError("conversation illisible — fichier conservé", status=409, code="state_unreadable")
        data = _read_thread()
        if _thread_epoch(data) != base_epoch:
            return False
        current = list(data["messages"])
        rebased = _thread_revision(data) != base_revision
        updated = dict(data)
        updated.update({"messages": (current + list(turn))[-MAX_THREAD:],
                        "revision": _thread_revision(data) + 1,
                        "clear_epoch": base_epoch})
        _write_thread(updated)
    return rebased


def _append_turn_if_current(turn: list[dict[str, Any]], base_revision: int, base_epoch: int = 0) -> bool:
    """Atomically append only if the thread is still in the same generation and
    at ``base_revision``; returns False without writing otherwise."""
    with _lock:
        if _thread_unreadable():
            raise SecuriaError("conversation illisible — fichier conservé", status=409, code="state_unreadable")
        data = _read_thread()
        if _thread_epoch(data) != base_epoch:
            return False
        revision = _thread_revision(data)
        if revision != base_revision:
            return False
        updated = dict(data)
        updated.update({"messages": (list(data["messages"]) + list(turn))[-MAX_THREAD:],
                        "revision": revision + 1, "clear_epoch": base_epoch})
        _write_thread(updated)
    return True


def clear_thread() -> dict[str, Any]:
    with _lock:
        _save_thread([])
        return {"ok": True, "messages": []}


def _clean_job(job: Any) -> str:
    return job if isinstance(job, str) and _JOB_RE.fullmatch(job) else ""


def cancel(job: Any) -> dict[str, Any]:
    """POST /api/securia/cancel: the turn stops at its next round or tool call and
    stores nothing, so a dismissed answer never turns up later in the thread."""
    job = _clean_job(job)
    if not job:
        return {"ok": True, "cancelled": False}
    now = time.time()
    with _lock:
        for old in [k for k, at in _cancelled.items() if now - at > CANCEL_TTL]:
            _cancelled.pop(old, None)
        _cancelled[job] = now
    return {"ok": True, "cancelled": True}


def _cancelled_now(job: str) -> bool:
    if not job:
        return False
    with _lock:
        return job in _cancelled


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
    return (_bound_root or hq_state.state_root()).resolve()


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


def _is_protected_ip(raw: str) -> bool:
    """Loopback, unspecified and this machine's own addresses are never blockable."""
    try:
        ip = ipaddress.ip_address(str(raw or "").strip())
    except ValueError:
        return False
    return bool(ip.is_loopback or ip.is_unspecified or ip.is_link_local)


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

        if name == "get_honeypot_status":
            blocked_ips = hq_security.IP_BLOCKLIST.list_blocked()
            honeypot_blocks = [b for b in blocked_ips if any(k in str(b.get("reason", "")).lower() for k in ("honeypot", "scraper", "traversal", "honeytoken", "scanner"))]
            recent_events = [e for e in _sec_log_tail(50) if e.get("event") in (hq_security.SecurityLog.EVENT_HONEYPOT_TRIGGERED, hq_security.SecurityLog.EVENT_AI_SCRAPER_BLOCKED, hq_security.SecurityLog.EVENT_POW_FAILED)]
            return {
                "name": name,
                "ok": True,
                "result": {
                    "decoy_routes_count": len(hq_security.HONEYPOT_DECOY_ROUTES),
                    "decoy_routes": sorted(list(hq_security.HONEYPOT_DECOY_ROUTES))[:10],
                    "ai_scrapers_blocked_signatures": len(hq_security.AI_SCRAPER_USER_AGENTS),
                    "malicious_scanners_blocked_signatures": len(hq_security.MALICIOUS_SCANNER_USER_AGENTS),
                    "active_honeypot_quarantines": honeypot_blocks,
                    "recent_honeypot_events": recent_events[-10:],
                },
            }

        if name == "get_weekly_security_report":
            days = max(1, min(30, int(args.get("days", 7) or 7)))
            return {"name": name, "ok": True, "result": generate_security_digest(days=days)}

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
            try:
                ipaddress.ip_address(target_ip)
            except ValueError:
                return {"name": name, "ok": False, "error": f"IP invalide : {target_ip[:40]}"}
            if _is_protected_ip(target_ip):
                # The schema already said it; this makes it true whatever the model asks.
                return {"name": name, "ok": False, "error": "Localhost et adresses locales ne sont jamais bloquables"}
            ok, msg = hq_security.IP_BLOCKLIST.block(target_ip, reason=reason[:200], duration_sec=duration)
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

    honeypot_events = [e for e in events if e.get("event") in (
        hq_security.SecurityLog.EVENT_HONEYPOT_TRIGGERED,
        hq_security.SecurityLog.EVENT_AI_SCRAPER_BLOCKED,
        hq_security.SecurityLog.EVENT_POW_FAILED,
    )]

    recent_traps: list[dict[str, Any]] = []
    try:
        import hq_events
        recent_traps = hq_events.list_events(kind="trappe_securite", limit=5).get("events") or []
    except Exception:
        pass

    # Count auth failures per IP for proactive non-spam alerts
    ip_fails: dict[str, int] = {}
    for e in events:
        if e.get("event") in ("auth.login.failure", "auth.rate_limited"):
            eip = str(e.get("ip") or "").strip()
            if eip:
                ip_fails[eip] = ip_fails.get(eip, 0) + 1

    proactive_alert: dict[str, Any] | None = None
    if recent_traps:
        top_trap = recent_traps[0]
        meta = top_trap.get("meta") or {}
        tip = str(meta.get("ip") or "").strip()
        proactive_alert = {
            "id": f"trap:{top_trap.get('id', top_trap.get('ts', ''))}",
            "level": "danger",
            "ip": tip,
            "device": None,
            "message": f"Alerte sentinelle : {top_trap.get('message', 'Trappe déclenchée')} ! Quarantaine automatique en place.",
        }
    elif honeypot_events:
        last_hp = honeypot_events[0]
        r = str(last_hp.get("reason") or "Intrusion détectée")
        proactive_alert = {
            "id": f"trap:{last_hp.get('timestamp', '')}:{r[:20]}",
            "level": "danger",
            "ip": "",
            "device": None,
            "message": f"Alerte sentinelle : trappe activée ({r}) ! Quarantaine automatique enclenchée.",
        }
    elif ip_fails:
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

    threat_count = failures + len(honeypot_events) + len(recent_traps) + len(blocked)
    if recent_traps:
        alert_level = "danger"
        headline = f"Alerte : {recent_traps[0].get('message', 'trappe de sécurité activée')}"
    elif honeypot_events:
        alert_level = "danger"
        headline = f"Alerte : trappe de sécurité activée ({honeypot_events[0].get('reason', '')})"
    elif len(blocked) > 0:
        alert_level = "danger"
        headline = f"{len(blocked)} IP(s) en quarantaine"
    elif failures > 0:
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
        "threat_count": threat_count,
        "honeypot_count": len(honeypot_events) + len(recent_traps),
        "blocked_count": len(blocked),
        "proactive_alert": proactive_alert,
        "thread": get_thread().get("messages", []),
    }


def generate_security_digest(days: int = 7) -> dict[str, Any]:
    """Generate comprehensive periodic security synthesis & autonomy registry."""
    events = _sec_log_tail(150)

    # 1. Deflected threat counts
    scanners = sum(1 for e in events if "malicious_ua" in str(e.get("reason", "")).lower() or "scanner" in str(e.get("reason", "")).lower())
    scrapers = sum(1 for e in events if e.get("event") == hq_security.SecurityLog.EVENT_AI_SCRAPER_BLOCKED or "ai_scraper" in str(e.get("reason", "")).lower())
    honeypots = sum(1 for e in events if e.get("event") == hq_security.SecurityLog.EVENT_HONEYPOT_TRIGGERED or "decoy" in str(e.get("reason", "")).lower())
    traversals = sum(1 for e in events if "traversal" in str(e.get("reason", "")).lower())
    honeytokens = sum(1 for e in events if "honeytoken" in str(e.get("reason", "")).lower())
    pow_fails = sum(1 for e in events if e.get("event") == hq_security.SecurityLog.EVENT_POW_FAILED)
    auth_fails = sum(1 for e in events if e.get("event") in ("auth.login.failure", "auth.rate_limited"))

    total_deflected = scanners + scrapers + honeypots + traversals + honeytokens + pow_fails

    # 2. Quota guard snapshot. The bridge has no global AI quota guard: hq_ai
    # enforces per-model quotas against its own store. Report nothing rather
    # than a defence that is not installed.
    q_stats: dict[str, Any] = {}

    # 3. IP Quarantine registry
    active_blocked = hq_security.IP_BLOCKLIST.list_blocked()
    recidivists_count = sum(1 for b in active_blocked if b.get("recidivist") or b.get("offenses", 0) > 1)

    # 4. Global Score (100 base, deductions for active high threat)
    health_score = max(50, 100 - (len(active_blocked) * 5) - (auth_fails * 2))

    return {
        "ok": True,
        "window": f"{days} derniers jours",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "health_score": health_score,
        "health_status": "Optimal" if health_score >= 90 else ("Sous surveillance" if health_score >= 70 else "Alerte"),
        "deflected_summary": {
            "total_deflected": total_deflected,
            "scanners_blocked": scanners,
            "ai_scrapers_blocked": scrapers,
            "honeypot_decoys_tripped": honeypots,
            "path_traversals_neutralized": traversals,
            "honeytokens_tripped": honeytokens,
            "pow_failures": pow_fails,
            "auth_failures": auth_fails,
        },
        "quota_guard": q_stats,
        "quarantine_registry": {
            "active_count": len(active_blocked),
            "recidivists_count": recidivists_count,
            "entries": active_blocked[:15],
        },
        "securia_assessment": (
            f"Bilan sentinelle {days}j : {total_deflected} intrusions/sondes interceptées. "
            f"{scrapers} moissonneurs d'IA bloqués, {honeypots} leurres déclenchés. "
            f"Quarantaine active : {len(active_blocked)} IP ({recidivists_count} récidivistes). "
            f"Score de santé du périmètre : {health_score}%."
        ),
    }


def _proposal_summary(name: str, args: dict[str, Any]) -> str:
    if name == "block_ip":
        dur = args.get("duration_sec") or 0
        when = "permanent" if not dur else f"{max(1, int(dur) // 60)} min"
        why = str(args.get("reason") or "").strip()[:80]
        return f"Bloquer {args.get('ip')} ({when})" + (f" — {why}" if why else "")
    if name == "unblock_ip":
        return f"Retirer {args.get('ip')} de la quarantaine"
    if name == "rearm_tripwire":
        action = str(args.get("action") or "rearm").lower()
        verb = {"disarm": "Désarmer", "arm": "Armer"}.get(action, "Réarmer")
        thr = args.get("threshold")
        return verb + " le Tripwire" + (f" (seuil {thr})" if isinstance(thr, int) else "")
    if name == "revoke_session":
        return f"Révoquer la session {args.get('session_id_prefix')}…"
    return name


def _clean_args(args: Any) -> dict[str, Any]:
    """Only the simple values a security action takes, bounded: a proposal is data the Master confirms."""
    out: dict[str, Any] = {}
    for key, value in (args if isinstance(args, dict) else {}).items():
        if not isinstance(key, str) or len(key) > 40:
            continue
        if isinstance(value, bool):
            out[key] = value
        elif isinstance(value, int):
            out[key] = max(-86400, min(86400, value))
        elif isinstance(value, str):
            out[key] = value.strip()[:200]
    return out


def _make_proposal(name: str, args: dict[str, Any]) -> dict[str, Any]:
    clean = _clean_args(args)
    return {"id": "scp-" + secrets.token_hex(4), "name": name, "args": clean,
            "summary": _proposal_summary(name, clean), "status": "pending",
            "created_utc": _utcnow()}


def _find_proposal(messages: list[dict[str, Any]], token: str) -> dict[str, Any] | None:
    for message in messages:
        if not isinstance(message, dict):
            continue
        for prop in message.get("proposals") or []:
            if isinstance(prop, dict) and prop.get("id") == token:
                return prop
    return None


def confirm(token: Any) -> dict[str, Any]:
    """POST /api/securia/confirm: run one queued security action, once."""
    if not isinstance(token, str) or not _PROPOSAL_RE.fullmatch(token):
        raise SecuriaError("Proposition inconnue", status=404, code="not_found")
    with _lock:
        if _thread_unreadable():
            raise SecuriaError("conversation illisible — fichier conservé", 409, "state_unreadable")
        data = _read_thread()
        prop = _find_proposal(data["messages"], token)
        if prop is None:
            raise SecuriaError("Proposition inconnue ou effacée", 404, "not_found")
        if prop.get("status") != "pending":
            raise SecuriaError("Proposition déjà traitée", 409, "already_resolved")
        name = str(prop.get("name") or "")
        if name not in MUTATING_TOOLS:
            raise SecuriaError("Proposition non exécutable", 409, "not_executable")
        args = dict(prop.get("args") or {})
        prop["status"] = "running"      # claim under the lock: a double click cannot run twice
        claimed = dict(data)
        claimed.update({"revision": _thread_revision(data) + 1})
        _write_thread(claimed)
        base_epoch = _thread_epoch(data)

    result = _execute_tool(name, args)
    ok = bool(result.get("ok"))
    with _lock:
        try:
            data = _read_thread()
        except SecuriaError:
            data = None
        if data is not None and _thread_epoch(data) == base_epoch:
            prop = _find_proposal(data["messages"], token)
            if prop is not None:
                detail = result.get("error") or json.dumps(result.get("result") or {}, ensure_ascii=False)
                prop.update({"status": "done" if ok else "failed", "ok": ok,
                             "resolved_utc": _utcnow(), "result": str(detail)[:300]})
                updated = dict(data)
                updated.update({"revision": _thread_revision(data) + 1})
                _write_thread(updated)
    return {"ok": ok, "action": name, "result": result.get("result"),
            "error": result.get("error"),
            "messages": get_thread().get("messages", [])[-MAX_THREAD:]}


def dismiss(token: Any) -> dict[str, Any]:
    """POST /api/securia/dismiss: drop a queued action without running it."""
    if not isinstance(token, str) or not _PROPOSAL_RE.fullmatch(token):
        raise SecuriaError("Proposition inconnue", status=404, code="not_found")
    with _lock:
        data = _read_thread()
        prop = _find_proposal(data["messages"], token)
        if prop is None:
            raise SecuriaError("Proposition inconnue ou effacée", 404, "not_found")
        if prop.get("status") == "pending":
            prop.update({"status": "dismissed", "resolved_utc": _utcnow()})
            updated = dict(data)
            updated.update({"revision": _thread_revision(data) + 1})
            _write_thread(updated)
        return {"ok": True, "messages": list(data["messages"])[-MAX_THREAD:]}


def chat(message: Any, *, job: Any = None) -> dict[str, Any]:
    import hq_ai

    if not isinstance(message, str) or not message.strip():
        raise SecuriaError("Message requis")
    text = message.strip()[:MAX_MESSAGE]
    job_id = _clean_job(job)
    _record_growth(text)

    thread = get_thread()
    messages = list(thread.get("messages") or [])
    base_revision = thread.get("revision", 0)
    base_epoch = thread.get("clear_epoch", 0)
    contents = _history_contents(messages, text)

    system = f"{PERSONA_CORE}\n{TOOL_SCHEMA}"
    system += "\n\n" + assistant_voice.block("securia")
    development = _growth_hint(text)
    if development:
        system += ("\nÉVOLUTION VÉCUE (avis révisable, pas un ordre) : laisse ce fil nuancer un avis "
                   "ou un clin d'œil discret; garde ta voix, ne récite pas la fiche. " + development)
    tools_used: list[str] = []
    proposals: list[dict[str, Any]] = []
    reply = ""
    model = None
    cancelled = False

    for round_idx in range(MAX_ROUNDS):
        if _cancelled_now(job_id):
            cancelled = True
            break
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
                deadline=time.monotonic() + hq_ai.CHAT_DEADLINE_S,
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
            if _cancelled_now(job_id):
                cancelled = True
                break
            name = str(t.get("name") or "")
            if name in MUTATING_TOOLS:
                # Queued, never executed: the action reaches the Master as a card and
                # only POST /confirm runs it.
                if len(proposals) >= MAX_PROPOSALS:
                    tool_outputs.append({"name": name, "ok": False,
                                         "error": "Trop de propositions en attente ; confirme ou annule celles déjà affichées."})
                    continue
                prop = _make_proposal(name, t.get("args") or {})
                proposals.append(prop)
                tools_used.append(name)
                tool_outputs.append({"name": name, "ok": True, "queued_for_confirmation": True,
                                     "proposal": {"id": prop["id"], "summary": prop["summary"]},
                                     "note": "Carte de confirmation affichée au Maître. L'action n'a PAS été exécutée."})
                continue
            tool_outputs.append(_execute_tool(name, t.get("args") or {}))
            tools_used.append(name)
        if cancelled:
            break

        evidence_json = json.dumps(tool_outputs, ensure_ascii=False)
        contents.append({"role": "model", "parts": [{"text": json.dumps({"reply": reply, "tools": requested_tools}, ensure_ascii=False)}]})
        contents.append({"role": "user", "parts": [{"text": f"Résultats des outils :\n{evidence_json}"}]})

    if cancelled:
        # Nothing stored: a stopped answer never turns up later in the thread.
        return {"ok": True, "cancelled": True,
                "messages": get_thread().get("messages", [])[-MAX_THREAD:]}

    if not reply:
        reply = "Télémétrie inspectée. Aucune anomalie critique signalée."

    now = _utcnow()
    assistant: dict[str, Any] = {"role": "assistant", "text": reply, "utc": _utcnow(),
                                 "tools_used": tools_used, "model": model}
    if proposals:
        assistant["proposals"] = proposals
    turn = [{"role": "user", "text": text, "utc": now}, assistant]

    rebased = False
    if not _append_turn_if_current(turn, base_revision, base_epoch):
        if not _append_turn(turn, base_revision, base_epoch):
            return {"ok": True, "cancelled": True,
                    "messages": get_thread().get("messages", [])[-MAX_THREAD:]}
        rebased = True

    try:
        import hq_personhood
        hq_personhood.observe_reply("securia", tools=tools_used,
                                     outcome="ok" if not rebased else "fallback")
    except Exception:
        pass

    return {
        "ok": True,
        "reply": reply,
        "tools_used": tools_used,
        "proposals": proposals,
        "model": model,
        "cancelled": False,
        "rebased": rebased,
        "messages": get_thread().get("messages", [])[-MAX_THREAD:],
    }


def http_get(raw: str) -> tuple[int, dict[str, Any]]:
    if raw == "/api/securia/status":
        return 200, status_summary()
    if raw.startswith("/api/securia/digest"):
        return 200, generate_security_digest()
    return 404, {"error": "Route Securia inconnue"}


def http_post(raw: str, data: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    try:
        if raw == "/api/securia/chat":
            return 200, chat(data.get("message"), job=data.get("job"))
        if raw == "/api/securia/clear":
            return 200, clear_thread()
        if raw == "/api/securia/cancel":
            return 200, cancel(data.get("job"))
        if raw == "/api/securia/confirm":
            return 200, confirm(data.get("id"))
        if raw == "/api/securia/dismiss":
            return 200, dismiss(data.get("id"))
        if raw == "/api/securia/prune-quarantine":
            return 200, hq_security.IP_BLOCKLIST.prune_penitence()
        return 404, {"error": "Route Securia inconnue"}
    except SecuriaError as exc:
        return exc.status, {"error": exc.message if hasattr(exc, "message") else str(exc), "code": exc.code}
