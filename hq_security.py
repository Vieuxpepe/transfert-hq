"""Phase 16 - Authentication Hardening & Security Telemetry for Transfert HQ.

Standard-library only, concurrency-safe, bounded, privacy-preserving.
"""

from __future__ import annotations

import collections
import html
import json
import math
import os
import re
import secrets
import shutil
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

# =============================================================================
# Constants & Defaults
# =============================================================================

# Session lifetimes (seconds)
DEFAULT_ADMIN_ABSOLUTE_SEC = 24 * 3600.0  # 24 hours
DEFAULT_ADMIN_IDLE_SEC = 45 * 60.0        # 45 minutes
DEFAULT_UPLOAD_ABSOLUTE_SEC = 24 * 3600.0 # 24 hours
DEFAULT_UPLOAD_IDLE_SEC = 60 * 60.0       # 60 minutes

SESSION_ABSOLUTE_MIN_SEC = 60.0           # 1 minute
SESSION_ABSOLUTE_MAX_SEC = 30 * 86400.0   # 30 days
SESSION_IDLE_MIN_SEC = 30.0               # 30 seconds
SESSION_IDLE_MAX_SEC = 7 * 86400.0        # 7 days

# Idle persistence throttle (seconds) to prevent disk thrashing on every request
IDLE_PERSIST_INTERVAL_SEC = 60.0

# Rate limiting defaults
RATE_LIMIT_WINDOW_SEC = 60.0
RATE_LIMIT_MAX_ATTEMPTS = 12
RATE_LIMIT_PROXY_MAX_ATTEMPTS = 24       # Shared proxy identity allowance
RATE_LIMIT_GLOBAL_WINDOW_SEC = 60.0
RATE_LIMIT_GLOBAL_MAX = 60
RATE_LIMIT_MAX_IDENTITIES = 256
RATE_LIMIT_MAX_COOLDOWN_SEC = 900.0       # 15 minutes max progressive cooldown

# Telemetry limits
SECURITY_RING_MAX = 100
SECURITY_LOG_ROTATE_BYTES = 128 * 1024    # 128 KB
SECURITY_LOG_NAME = "security.jsonl"


# =============================================================================
# 1. Session Lifecycle Management
# =============================================================================

def get_session_policy(config: dict | None, role: str) -> tuple[float, float]:
    """Return (absolute_ttl_sec, idle_ttl_sec) for the given role.

    Validated against safe bounds and guaranteed idle <= absolute.
    """
    cfg = config or {}
    role = role if role in ("admin", "upload") else "admin"

    # Legacy fallback: session_ttl_sec
    legacy_ttl = None
    if "session_ttl_sec" in cfg:
        try:
            val = float(cfg["session_ttl_sec"])
            if math.isfinite(val) and val > 0:
                legacy_ttl = max(SESSION_ABSOLUTE_MIN_SEC, min(SESSION_ABSOLUTE_MAX_SEC, val))
        except (TypeError, ValueError):
            pass

    if role == "admin":
        default_abs = legacy_ttl if legacy_ttl is not None else DEFAULT_ADMIN_ABSOLUTE_SEC
        default_idle = DEFAULT_ADMIN_IDLE_SEC
        raw_abs = cfg.get("session_admin_absolute_sec")
        raw_idle = cfg.get("session_admin_idle_sec")
    else:
        default_abs = legacy_ttl if legacy_ttl is not None else DEFAULT_UPLOAD_ABSOLUTE_SEC
        default_idle = DEFAULT_UPLOAD_IDLE_SEC
        raw_abs = cfg.get("session_upload_absolute_sec")
        raw_idle = cfg.get("session_upload_idle_sec")

    try:
        abs_ttl = float(raw_abs) if raw_abs is not None else default_abs
        if not math.isfinite(abs_ttl) or abs_ttl < SESSION_ABSOLUTE_MIN_SEC:
            abs_ttl = default_abs
        abs_ttl = min(SESSION_ABSOLUTE_MAX_SEC, max(SESSION_ABSOLUTE_MIN_SEC, abs_ttl))
    except (TypeError, ValueError):
        abs_ttl = default_abs

    try:
        idle_ttl = float(raw_idle) if raw_idle is not None else default_idle
        if not math.isfinite(idle_ttl) or idle_ttl < SESSION_IDLE_MIN_SEC:
            idle_ttl = default_idle
        idle_ttl = min(SESSION_IDLE_MAX_SEC, max(SESSION_IDLE_MIN_SEC, idle_ttl))
    except (TypeError, ValueError):
        idle_ttl = default_idle

    # Invariant: idle timeout cannot exceed absolute lifetime
    idle_ttl = min(idle_ttl, abs_ttl)
    return abs_ttl, idle_ttl


def create_session_record(user: str, role: str, gen: int, config: dict | None, now: float | None = None) -> dict:
    """Create a new session record with absolute expiration and idle timeout tracking."""
    if role not in ("admin", "upload"):
        raise ValueError(f"Invalid session role: {role}")
    t_now = time.time() if now is None else float(now)
    abs_ttl, idle_ttl = get_session_policy(config, role)
    return {
        "exp": t_now + abs_ttl,
        "idle_sec": idle_ttl,
        "last_active": t_now,
        "created_at": t_now,
        "user": str(user or "user")[:40],
        "role": role,
        "gen": int(gen),
    }


def parse_stored_session(raw: object, config: dict | None, now: float | None = None) -> dict | None:
    """Validate and deserialize a stored session record. Fails closed on malformed entries."""
    if not isinstance(raw, dict):
        return None

    # Expiration validation (reject boolean, non-number, NaN, inf, overflow)
    exp_val = raw.get("exp")
    if isinstance(exp_val, bool) or not isinstance(exp_val, (int, float)):
        return None
    try:
        exp = float(exp_val)
    except (OverflowError, TypeError, ValueError):
        return None
    if not math.isfinite(exp):
        return None

    t_now = time.time() if now is None else float(now)
    if exp <= t_now:
        return None

    # Role validation
    role = raw.get("role")
    if role not in ("admin", "upload"):
        return None

    # Generation validation
    gen_val = raw.get("gen")
    if isinstance(gen_val, bool) or not isinstance(gen_val, int):
        return None
    gen = int(gen_val)

    abs_ttl, default_idle = get_session_policy(config, role)

    # Idle duration validation
    idle_val = raw.get("idle_sec")
    if isinstance(idle_val, bool) or not isinstance(idle_val, (int, float)):
        idle_sec = default_idle
    else:
        try:
            f_idle = float(idle_val)
            idle_sec = f_idle if math.isfinite(f_idle) and f_idle >= SESSION_IDLE_MIN_SEC else default_idle
        except (OverflowError, TypeError, ValueError):
            idle_sec = default_idle
    idle_sec = min(idle_sec, abs_ttl)

    # Last active validation
    act_val = raw.get("last_active")
    if isinstance(act_val, bool) or not isinstance(act_val, (int, float)):
        # Legacy record without last_active: conservative default is current load time
        last_active = min(t_now, exp)
    else:
        try:
            f_act = float(act_val)
            last_active = f_act if math.isfinite(f_act) else min(t_now, exp)
        except (OverflowError, TypeError, ValueError):
            last_active = min(t_now, exp)

    # If last active was recorded in the future beyond exp, cap it
    last_active = min(last_active, exp)

    # Check if idle expired while offline
    if t_now - last_active > idle_sec:
        return None

    # Creation timestamp
    created_val = raw.get("created_at")
    if isinstance(created_val, bool) or not isinstance(created_val, (int, float)):
        created_at = max(0.0, exp - abs_ttl)
    else:
        try:
            f_cr = float(created_val)
            created_at = f_cr if math.isfinite(f_cr) else max(0.0, exp - abs_ttl)
        except (OverflowError, TypeError, ValueError):
            created_at = max(0.0, exp - abs_ttl)

    return {
        "exp": exp,
        "idle_sec": idle_sec,
        "last_active": last_active,
        "created_at": created_at,
        "user": str(raw.get("user") or "user")[:40],
        "role": role,
        "gen": gen,
    }


def evaluate_session(
    record: dict,
    current_gen: int,
    now: float | None = None,
    touch: bool = True,
) -> tuple[bool, str | None]:
    """Evaluate whether an active in-memory session is valid.

    Returns (is_valid, reject_reason). If valid and touch=True, updates last_active.
    Never extends last_active beyond absolute expiration.
    """
    t_now = time.time() if now is None else float(now)

    if record.get("gen") != current_gen:
        return False, "generation_mismatch"

    exp = float(record.get("exp") or 0.0)
    if t_now >= exp:
        return False, "absolute_timeout"

    last_active = float(record.get("last_active") or 0.0)
    idle_sec = float(record.get("idle_sec") or DEFAULT_ADMIN_IDLE_SEC)
    if last_active <= 0.0:
        last_active = float(record.get("created_at") or t_now)
        record["last_active"] = last_active
    if t_now - last_active >= idle_sec:
        return False, "idle_timeout"

    if touch:
        # Update activity timestamp, but never beyond absolute expiration
        record["last_active"] = min(t_now, exp)

    return True, None


# =============================================================================
# 2. Persistent Bounded Rate Limiter
# =============================================================================

class AuthRateLimiter:
    """Sliding-window authentication rate limiter with progressive cooldowns and global failure budget.

    Persists failure state across restarts, bounds identity count, and prunes expired records.
    """

    def __init__(
        self,
        state_path: Path | str | None = None,
        *,
        window_sec: float = RATE_LIMIT_WINDOW_SEC,
        max_attempts: int = RATE_LIMIT_MAX_ATTEMPTS,
        proxy_max_attempts: int = RATE_LIMIT_PROXY_MAX_ATTEMPTS,
        global_window_sec: float = RATE_LIMIT_GLOBAL_WINDOW_SEC,
        global_max: int = RATE_LIMIT_GLOBAL_MAX,
        max_identities: int = RATE_LIMIT_MAX_IDENTITIES,
    ) -> None:
        self.state_path = Path(state_path) if state_path else None
        self.window_sec = float(window_sec)
        self.max_attempts = int(max_attempts)
        self.proxy_max_attempts = int(proxy_max_attempts)
        self.global_window_sec = float(global_window_sec)
        self.global_max = int(global_max)
        self.max_identities = int(max_identities)

        self._lock = threading.Lock()
        self._identities: dict[str, dict] = {}
        self._global_fails: list[float] = []

        if self.state_path:
            self._load()

    def attach(self, root: Path | str) -> None:
        """Attach to the diagnostics directory under the given project root."""
        with self._lock:
            p = Path(root) / ".hq-carnet" / "diagnostics" / "rate_limit.json"
            self.state_path = p
            self._load()

    def _load(self) -> None:
        if not self.state_path or not self.state_path.is_file():
            return
        try:
            raw = self.state_path.read_text(encoding="utf-8")
            data = json.loads(raw)
            if not isinstance(data, dict):
                return
            identities = data.get("identities")
            if isinstance(identities, dict):
                for ident, record in identities.items():
                    if not isinstance(ident, str) or not isinstance(record, dict):
                        continue
                    fails = [float(t) for t in record.get("fails", []) if isinstance(t, (int, float))]
                    cooldown = float(record.get("cooldown_until", 0.0))
                    streak = int(record.get("streak", 0))
                    if fails or cooldown > 0:
                        self._identities[ident[:64]] = {
                            "fails": fails,
                            "streak": max(0, min(10, streak)),
                            "cooldown_until": cooldown,
                        }
            g_fails = data.get("global_fails")
            if isinstance(g_fails, list):
                self._global_fails = [float(t) for t in g_fails if isinstance(t, (int, float))]
        except Exception:
            # Corrupted rate limit state must never crash authentication or deny all logins
            self._identities.clear()
            self._global_fails.clear()

    def _persist_locked(self) -> None:
        if not self.state_path:
            return
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "version": 1,
                "saved_at": time.time(),
                "identities": self._identities,
                "global_fails": self._global_fails,
            }
            tmp = self.state_path.with_name(f".{self.state_path.name}.tmp-{os.getpid()}-{threading.get_ident()}")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(self.state_path)
        except OSError:
            pass

    def _prune_locked(self, now: float) -> None:
        self._global_fails = [t for t in self._global_fails if now - t < self.global_window_sec]
        dead: list[str] = []
        STREAK_RETENTION_SEC = 1800.0  # 30 minutes to remember penalty streak
        for ident, rec in self._identities.items():
            rec["fails"] = [t for t in rec.get("fails", []) if now - t < self.window_sec]
            cooldown = float(rec.get("cooldown_until", 0.0))
            last_activity = max([cooldown] + rec.get("fails", []))
            if not rec["fails"] and cooldown <= now and (now - last_activity > STREAK_RETENTION_SEC):
                dead.append(ident)
        for k in dead:
            self._identities.pop(k, None)

        # Enforce bounded capacity
        if len(self._identities) > self.max_identities:
            # Evict entries with earliest last activity
            sorted_items = sorted(
                self._identities.items(),
                key=lambda item: max(item[1].get("fails") or [0.0]),
            )
            to_remove = len(self._identities) - self.max_identities
            for k, _ in sorted_items[:to_remove]:
                self._identities.pop(k, None)

    def check_rate_limit(self, identity: str, now: float | None = None) -> tuple[bool, str | None, float]:
        """Check if an attempt is permitted.

        Returns (allowed, reason, retry_after_sec).
        """
        t_now = time.time() if now is None else float(now)
        ident = (identity or "unknown").strip()[:64]
        is_proxy = ident.startswith("tailscale_") or ident == "proxy_shared"
        allowed_attempts = self.proxy_max_attempts if is_proxy else self.max_attempts

        with self._lock:
            self._prune_locked(t_now)

            # 1. Global budget check
            if len(self._global_fails) >= self.global_max:
                earliest = min(self._global_fails) if self._global_fails else t_now
                retry_after = max(1.0, self.global_window_sec - (t_now - earliest))
                return False, "global_budget_exhausted", retry_after

            rec = self._identities.get(ident)
            if not rec:
                return True, None, 0.0

            # 2. Cooldown check
            cooldown_until = float(rec.get("cooldown_until", 0.0))
            if t_now < cooldown_until:
                return False, "cooldown_active", max(1.0, cooldown_until - t_now)

            # 3. Sliding-window threshold check
            fails = [t for t in rec.get("fails", []) if t_now - t < self.window_sec]
            if len(fails) >= allowed_attempts:
                earliest = min(fails)
                retry_after = max(1.0, self.window_sec - (t_now - earliest))
                return False, "rate_limited", retry_after

            return True, None, 0.0

    def record_failure(self, identity: str, now: float | None = None) -> tuple[bool, float]:
        """Record an authentication failure.

        Returns (is_now_blocked, cooldown_sec).
        """
        t_now = time.time() if now is None else float(now)
        ident = (identity or "unknown").strip()[:64]
        is_proxy = ident.startswith("tailscale_") or ident == "proxy_shared"
        allowed_attempts = self.proxy_max_attempts if is_proxy else self.max_attempts

        with self._lock:
            self._prune_locked(t_now)
            self._global_fails.append(t_now)

            rec = self._identities.setdefault(ident, {"fails": [], "streak": 0, "cooldown_until": 0.0})
            fails = [t for t in rec.get("fails", []) if t_now - t < self.window_sec]
            fails.append(t_now)
            rec["fails"] = fails

            blocked = False
            cooldown_sec = 0.0
            if len(fails) >= allowed_attempts:
                blocked = True
                streak = int(rec.get("streak", 0))
                # Progressive cooldown tiers: 60s, 120s, 300s, 900s
                if streak == 0:
                    cd = 60.0
                elif streak == 1:
                    cd = 120.0
                elif streak == 2:
                    cd = 300.0
                else:
                    cd = RATE_LIMIT_MAX_COOLDOWN_SEC
                rec["streak"] = min(10, streak + 1)
                rec["cooldown_until"] = t_now + cd
                cooldown_sec = cd

            self._persist_locked()
            return blocked, cooldown_sec

    def record_success(self, identity: str) -> None:
        """Reset failed attempts for a successfully authenticated identity."""
        ident = (identity or "unknown").strip()[:64]
        with self._lock:
            if ident in self._identities:
                self._identities.pop(ident, None)
                self._persist_locked()

    def get_status(self) -> dict:
        """Sanitized telemetry overview of the rate limiter."""
        with self._lock:
            now = time.time()
            return {
                "tracked_identities": len(self._identities),
                "global_recent_failures": len([t for t in self._global_fails if now - t < self.global_window_sec]),
                "active_cooldowns": sum(1 for r in self._identities.values() if r.get("cooldown_until", 0.0) > now),
            }

    def clear_for_tests(self) -> None:
        with self._lock:
            self._identities.clear()
            self._global_fails.clear()
            if self.state_path and self.state_path.is_file():
                try:
                    self.state_path.unlink()
                except OSError:
                    pass


# =============================================================================
# 3. Host, Proxy & CSRF Validation
# =============================================================================

class HostProxyCSRFValidator:
    """Strict validation for Host headers, trusted reverse proxies, and CSRF origins."""

    @staticmethod
    def sanitize_host_header(raw_host: str | None) -> str | None:
        """Parse, validate, and sanitize an incoming Host header.

        Rejects malformed headers, control characters, slashes, or whitespace.
        """
        if not raw_host:
            return None
        host = raw_host.split(",")[0].strip()
        if not host:
            return None
        # Reject control chars, path delimiters, and whitespace
        if any(c in host for c in ("/", "\\", " ", "\t", "\r", "\n", "@", "?", "#")):
            return None
        if len(host) > 128:
            return None
        return host

    @staticmethod
    def build_approved_hosts(
        server_port: int,
        lan_ip: str | None = None,
        ts_ip: str | None = None,
        public_base_urls: list[str] | None = None,
        trusted_hosts_config: list[str] | None = None,
    ) -> set[str]:
        """Compile the complete set of approved Host values (host and host:port)."""
        approved: set[str] = set()

        def add_entry(h: str, default_port: int | None = server_port) -> None:
            clean = h.strip().lower()
            if not clean:
                return
            # If already has port:
            if ":" in clean and not clean.startswith("["):
                approved.add(clean)
                bare = clean.split(":", 1)[0]
                approved.add(bare)
            else:
                approved.add(clean)
                if default_port:
                    approved.add(f"{clean}:{default_port}")

        # Local loopback entries
        add_entry("127.0.0.1")
        add_entry("localhost")
        add_entry("[::1]")

        if lan_ip and lan_ip != "127.0.0.1":
            add_entry(lan_ip)

        if ts_ip and ts_ip != "127.0.0.1":
            add_entry(ts_ip)

        for u in (public_base_urls or []):
            try:
                p = urlparse(str(u).strip())
                if p.hostname:
                    # Tailscale Serve hostnames typically use standard 443/80
                    port = p.port if p.port else (443 if p.scheme == "https" else 80)
                    add_entry(p.hostname, port)
                    add_entry(p.hostname, None)
                    if p.netloc:
                        approved.add(p.netloc.lower())
            except Exception:
                pass

        for h in (trusted_hosts_config or []):
            add_entry(str(h), server_port)

        return approved

    @staticmethod
    def validate_host(
        raw_host: str | None,
        approved_hosts: set[str],
    ) -> tuple[bool, str]:
        """Validate whether the incoming Host header matches an approved endpoint."""
        clean = HostProxyCSRFValidator.sanitize_host_header(raw_host)
        if not clean:
            return False, "missing_or_malformed_host"
        if clean.lower() in approved_hosts:
            return True, "ok"
        return False, "untrusted_host"

    @staticmethod
    def is_trusted_tailscale_proxy(
        client_address: tuple[str, int] | list[Any] | None,
        headers: Any,
        approved_hosts: set[str],
    ) -> bool:
        """Verify whether the request is demonstrably arriving via local Tailscale Serve proxy.

        Requires:
        1. Direct socket peer is loopback (127.0.0.1 or ::1).
        2. X-Forwarded-Proto header is 'https'.
        3. X-Forwarded-Host or Host matches an approved host.
        """
        if not client_address:
            return False
        peer_ip = str(client_address[0])
        if peer_ip not in ("127.0.0.1", "::1", "localhost"):
            return False

        proto_hdr = (headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        if proto_hdr != "https":
            return False

        fwd_host = (headers.get("X-Forwarded-Host") or headers.get("Host") or "").split(",")[0].strip().lower()
        if not fwd_host:
            return False

        clean_fwd = HostProxyCSRFValidator.sanitize_host_header(fwd_host)
        if not clean_fwd or clean_fwd.lower() not in approved_hosts:
            return False

        return True

    @staticmethod
    def build_csrf_allowed_origins(
        server_port: int,
        lan_ip: str | None = None,
        ts_ip: str | None = None,
        public_base_urls: list[str] | None = None,
        trusted_hosts: list[str] | None = None,
    ) -> set[str]:
        """Derive the strict server-controlled CSRF allowlist.

        NEVER includes arbitrary client-supplied Host headers!
        """
        origins: set[str] = set()

        origins.add(f"http://127.0.0.1:{server_port}")
        origins.add(f"http://localhost:{server_port}")

        if lan_ip and lan_ip != "127.0.0.1":
            origins.add(f"http://{lan_ip}:{server_port}")

        if ts_ip and ts_ip != "127.0.0.1":
            origins.add(f"http://{ts_ip}:{server_port}")

        for u in (public_base_urls or []):
            try:
                p = urlparse(str(u).strip())
                if p.scheme in ("http", "https") and p.netloc:
                    origins.add(f"{p.scheme}://{p.netloc.lower()}")
            except Exception:
                pass

        for th in (trusted_hosts or []):
            try:
                clean = str(th).strip()
                if "://" in clean:
                    p = urlparse(clean)
                    if p.scheme in ("http", "https") and p.netloc:
                        origins.add(f"{p.scheme}://{p.netloc.lower()}")
                else:
                    origins.add(f"http://{clean}")
                    origins.add(f"https://{clean}")
            except Exception:
                pass

        return origins

    @staticmethod
    def validate_csrf(
        path: str,
        method: str,
        headers: Any,
        allowed_origins: set[str],
        has_session: bool,
    ) -> tuple[bool, str]:
        """Enforce fail-closed CSRF validation on state-changing requests."""
        m = (method or "GET").upper()
        p = path or "/"

        # Determine if request is state-changing
        is_candidate = m in ("POST", "PUT", "PATCH", "DELETE") or p == "/logout"
        if not is_candidate and p == "/api/inbox" and m == "GET":
            # clear parameter in query
            is_candidate = True

        if not is_candidate:
            return True, "not_candidate"

        if not has_session and p != "/login":
            return True, "unauthenticated_non_login"

        origin = (headers.get("Origin") or "").strip()
        referer = (headers.get("Referer") or "").strip()

        def match_url(raw: str) -> bool:
            if not raw:
                return False
            try:
                u = urlparse(raw)
                if not u.scheme or not u.netloc:
                    return False
                cand = f"{u.scheme}://{u.netloc.lower()}"
                return cand in allowed_origins
            except Exception:
                return False

        if origin:
            if match_url(origin):
                return True, "ok"
            return False, "origin_rejected"

        if referer:
            if match_url(referer):
                return True, "ok"
            return False, "referer_rejected"

        return False, "origin_and_referer_missing"


# =============================================================================
# 4. Structured Security Telemetry
# =============================================================================

class SecurityLog:
    """Structured, privacy-preserving security event logging channel.

    Maintains a bounded in-memory ring and an append-only, rotated JSONL log file.
    Guarantees that credentials, tokens, session cookies, and query strings are never recorded.
    """

    EVENT_LOGIN_SUCCESS = "auth.login.success"
    EVENT_LOGIN_FAILURE = "auth.login.failure"
    EVENT_RATE_LIMITED = "auth.rate_limited"
    EVENT_SESSION_EXPIRED = "auth.session.expired"
    EVENT_SESSION_REVOKED = "auth.session.revoked"
    EVENT_CSRF_REJECTED = "auth.csrf.rejected"
    EVENT_HOST_REJECTED = "auth.host.rejected"
    EVENT_PROXY_REJECTED = "auth.proxy.rejected"
    EVENT_ROLE_DENIED = "auth.role.denied"
    EVENT_PRIVILEGED_ACTION = "auth.privileged_action"

    ALLOWED_EVENTS = frozenset({
        EVENT_LOGIN_SUCCESS,
        EVENT_LOGIN_FAILURE,
        EVENT_RATE_LIMITED,
        EVENT_SESSION_EXPIRED,
        EVENT_SESSION_REVOKED,
        EVENT_CSRF_REJECTED,
        EVENT_HOST_REJECTED,
        EVENT_PROXY_REJECTED,
        EVENT_ROLE_DENIED,
        EVENT_PRIVILEGED_ACTION,
    })

    def __init__(self, maxlen: int = SECURITY_RING_MAX) -> None:
        self._ring: collections.deque[dict] = collections.deque(maxlen=maxlen)
        self._lock = threading.Lock()
        self._log_path: Path | None = None
        self._seq = 0
        self.dropped_writes = 0

    def attach(self, root: Path | str) -> None:
        """Attach to the diagnostics directory under the given project root."""
        with self._lock:
            p = Path(root) / ".hq-carnet" / "diagnostics" / SECURITY_LOG_NAME
            self._log_path = p
            self._load_tail_locked()

    def _load_tail_locked(self) -> None:
        if not self._log_path or not self._log_path.is_file():
            return
        try:
            size = self._log_path.stat().st_size
            with open(self._log_path, "rb") as fh:
                if size > SECURITY_LOG_ROTATE_BYTES:
                    fh.seek(size - SECURITY_LOG_ROTATE_BYTES)
                    fh.readline()
                raw = fh.read().decode("utf-8", errors="replace")
            for line in raw.splitlines()[-self._ring.maxlen:]:
                try:
                    e = json.loads(line)
                    if isinstance(e, dict) and e.get("event") in self.ALLOWED_EVENTS:
                        self._seq += 1
                        e["seq"] = self._seq
                        self._ring.append(e)
                except Exception:
                    continue
        except Exception:
            pass

    def record(
        self,
        event: str,
        *,
        severity: str = "info",
        actor_role: str = "anonymous",
        source_class: str = "unknown",
        result: str = "denied",
        reason: str | None = None,
        action: str | None = None,
        path_category: str | None = None,
        request_id: str | None = None,
    ) -> None:
        """Record a sanitized security event. Completely privacy-preserving."""
        if event not in self.ALLOWED_EVENTS:
            return

        rid = str(request_id or secrets.token_hex(4))[:16]
        role = actor_role if actor_role in ("admin", "upload", "anonymous") else "unknown"
        s_class = source_class if source_class in ("localhost", "lan", "tailscale_serve", "unknown") else "unknown"
        sev = severity if severity in ("info", "warning", "error", "critical") else "info"
        res = result if result in ("allowed", "denied", "throttled", "revoked", "success", "failed") else "denied"

        entry: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "event": event,
            "severity": sev,
            "actor_role": role,
            "source_class": s_class,
            "result": res,
            "request_id": rid,
        }

        if reason:
            entry["reason"] = re.sub(r"[^A-Za-z0-9_.-]", "", str(reason))[:60]
        if action:
            entry["action"] = re.sub(r"[^A-Za-z0-9_.-]", "", str(action))[:60]
        if path_category:
            entry["path_category"] = re.sub(r"[^A-Za-z0-9_.-]", "", str(path_category))[:40]

        with self._lock:
            self._seq += 1
            entry["seq"] = self._seq
            self._ring.append(entry)
            self._append_file_locked(entry)

    def _append_file_locked(self, entry: dict) -> None:
        if not self._log_path:
            return
        try:
            self._log_path.parent.mkdir(parents=True, exist_ok=True)
            if self._log_path.exists() and self._log_path.stat().st_size > SECURITY_LOG_ROTATE_BYTES:
                bak = self._log_path.with_name(f"{SECURITY_LOG_NAME}.1")
                try:
                    self._log_path.replace(bak)
                except OSError:
                    pass

            with open(self._log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            self.dropped_writes += 1

    def tail(self, limit: int = 50) -> list[dict]:
        """Return the most recent recorded security events (sanitized, admin only)."""
        with self._lock:
            items = list(self._ring)
            return items[-max(1, min(SECURITY_RING_MAX, int(limit))):]

    def summary(self) -> dict:
        """Sanitized telemetry summary of security events."""
        with self._lock:
            n = len(self._ring)
            last = self._ring[-1]["timestamp"] if n else None
            counts: dict[str, int] = {}
            for e in self._ring:
                ev = str(e.get("event", "unknown"))
                counts[ev] = counts.get(ev, 0) + 1
            return {
                "count": n,
                "capacity": self._ring.maxlen,
                "last_at": last,
                "persistent": bool(self._log_path),
                "dropped_writes": self.dropped_writes,
                "event_counts": counts,
            }

    def clear_for_tests(self) -> None:
        with self._lock:
            self._ring.clear()
            self._seq = 0
            self.dropped_writes = 0
            if self._log_path and self._log_path.is_file():
                try:
                    self._log_path.unlink()
                except OSError:
                    pass


# Module singleton instances
SECURITY_LOG = SecurityLog()
AUTH_RATE_LIMITER = AuthRateLimiter()

