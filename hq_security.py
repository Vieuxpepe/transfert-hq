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

# Legacy session duration constant (7 days) for migration policy
LEGACY_SESSION_TTL_SEC = 7 * 86400.0

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

# In-flight attempt reservation TTL (seconds) to prevent concurrency bypass
INFLIGHT_ATTEMPT_TTL_SEC = 30.0

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
        raw_abs = cfg.get("session_admin_absolute_sec") if cfg.get("session_admin_absolute_sec") is not None else cfg.get("admin_session_absolute_sec")
        raw_idle = cfg.get("session_admin_idle_sec") if cfg.get("session_admin_idle_sec") is not None else cfg.get("admin_session_idle_sec")
    else:
        default_abs = legacy_ttl if legacy_ttl is not None else DEFAULT_UPLOAD_ABSOLUTE_SEC
        default_idle = DEFAULT_UPLOAD_IDLE_SEC
        raw_abs = cfg.get("session_upload_absolute_sec") if cfg.get("session_upload_absolute_sec") is not None else cfg.get("upload_session_absolute_sec")
        raw_idle = cfg.get("session_upload_idle_sec") if cfg.get("session_upload_idle_sec") is not None else cfg.get("upload_session_idle_sec")

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
    """Validate, deserialize, and safely migrate a stored session record.

    Fail-Closed Migration Policy:
    1. Structural Validation:
       - The record must be a dict.
       - 'exp' must be a valid, finite number strictly greater than current time.
       - 'role' must be 'admin' or 'upload'.
       - 'gen' must be an integer (rejecting bool).
    2. Absolute Lifetime Enforcement (Legacy Migration):
       - Legacy sessions created under the previous 7-day policy must NOT silently exceed
         the newly configured absolute lifetime (abs_ttl).
       - If 'created_at' is absent, it is inferred as `exp - legacy_session_ttl`.
       - The session's expiration is clamped to `effective_exp = min(exp, created_at + abs_ttl)`.
       - If `effective_exp <= t_now`, the session has already exceeded its newly configured
         lifetime and is rejected (return None).
    3. Idle Timeout Enforcement (No Unearned Windows):
       - Missing 'last_active' timestamps in legacy records are NOT initialized to the current
         loading time, preventing stale offline sessions from claiming fresh idle windows.
       - If 'last_active' is absent, it defaults to 'created_at' (the only verifiable point of activity).
       - If `t_now - last_active >= idle_sec`, the session is expired on idle and rejected (return None).
       - If 'last_active' is present, it must be finite, >= created_at - 1.0, and <= t_now + 60.0.
    4. Bounds and Integrity:
       - 'created_at' must be finite, > 0.0, and <= t_now + 60.0 (allowing small clock skew).
       - 'last_active' is capped at 'effective_exp'.
    """
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

    # Legacy TTL resolution for creation inference
    cfg = config or {}
    legacy_ttl = LEGACY_SESSION_TTL_SEC
    if "session_ttl_sec" in cfg:
        try:
            val = float(cfg["session_ttl_sec"])
            if math.isfinite(val) and val > 0:
                legacy_ttl = max(SESSION_ABSOLUTE_MIN_SEC, min(SESSION_ABSOLUTE_MAX_SEC, val))
        except (TypeError, ValueError):
            pass

    # Creation timestamp validation & inference
    created_val = raw.get("created_at")
    if isinstance(created_val, bool):
        return None
    elif isinstance(created_val, (int, float)):
        try:
            created_at = float(created_val)
        except (OverflowError, TypeError, ValueError):
            return None
    else:
        # Legacy record without created_at: infer from legacy expiration
        created_at = exp - legacy_ttl

    if not math.isfinite(created_at) or created_at <= 0.0:
        return None
    if created_at > t_now + 60.0:
        return None

    # Absolute lifetime enforcement: clamp legacy expiration to newly configured abs_ttl
    effective_exp = min(exp, created_at + abs_ttl)
    if effective_exp <= t_now:
        return None

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

    # Last active validation & migration
    act_val = raw.get("last_active")
    if isinstance(act_val, bool):
        return None
    elif isinstance(act_val, (int, float)):
        try:
            last_active = float(act_val)
        except (OverflowError, TypeError, ValueError):
            return None
        if not math.isfinite(last_active):
            return None
        if last_active < created_at - 1.0:
            return None
        if last_active > t_now + 60.0:
            return None
    else:
        # Legacy record without last_active: conservative activity point is created_at
        last_active = created_at

    # Check if idle expired while offline
    if t_now - last_active >= idle_sec:
        return None

    # Cap last active so it never exceeds effective expiration
    last_active = min(last_active, effective_exp)

    return {
        "exp": effective_exp,
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
    Implements an observable degraded-security policy:
    - If persisted state is corrupt or unreadable, historical failure records cannot be parsed and
      are lost. Rather than pretending history is preserved or silently discarding the error, the
      limiter quarantines the corrupt file, starts with a fresh tracking state, and explicitly marks
      the system as degraded (`degraded=True`) in diagnostic status.
    - Write and permission failures increment `dropped_persists` and record `last_persist_error`.
    - Supports atomic attempt reservation to prevent concurrent requests from defeating limits.
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
        self._global_inflight: dict[str, float] = {}

        # Degraded-security policy metrics
        self.degraded: bool = False
        self.degraded_reason: str | None = None
        self.corrupt_files_quarantined: int = 0
        self.dropped_persists: int = 0
        self.last_persist_error: str | None = None
        self.last_persist_ok: float | None = None

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
                raise ValueError("Root JSON is not an object")
            identities = data.get("identities")
            if isinstance(identities, dict):
                for ident, record in identities.items():
                    if not isinstance(ident, str) or not isinstance(record, dict):
                        continue
                    fails = [float(t) for t in record.get("fails", []) if isinstance(t, (int, float))]
                    cooldown = float(record.get("cooldown_until", 0.0))
                    streak = int(record.get("streak", 0))
                    if fails or cooldown > 0:
                        rec = self._identities.setdefault(ident[:64], {"fails": [], "streak": 0, "cooldown_until": 0.0, "inflight": {}})
                        merged_fails = sorted(list(set(rec.get("fails", []) + fails)))
                        rec["fails"] = merged_fails
                        rec["streak"] = max(int(rec.get("streak", 0)), max(0, min(10, streak)))
                        rec["cooldown_until"] = max(float(rec.get("cooldown_until", 0.0)), cooldown)
            g_fails = data.get("global_fails")
            if isinstance(g_fails, list):
                loaded_g = [float(t) for t in g_fails if isinstance(t, (int, float))]
                self._global_fails = sorted(list(set(self._global_fails + loaded_g)))
        except Exception as exc:
            # Degraded-security policy: historical failure records in unreadable/corrupted files cannot
            # be salvaged and are lost. Mark degraded state so operators and telemetry observe the failure,
            # while preserving any existing in-memory state.
            self.degraded = True
            self.degraded_reason = f"corrupt_state_file: {type(exc).__name__}: {str(exc)[:60]}"
            # Quarantine the corrupt file so it does not poison subsequent reloads
            try:
                stamp = int(time.time())
                bak = self.state_path.with_name(f"{self.state_path.name}.corrupt-{stamp}")
                shutil.copy2(self.state_path, bak)
                self.corrupt_files_quarantined += 1
            except Exception:
                pass

    def _persist_locked(self) -> None:
        if not self.state_path:
            return
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            cleaned_identities = {}
            for ident, rec in self._identities.items():
                cleaned_identities[ident] = {
                    "fails": rec.get("fails", []),
                    "streak": rec.get("streak", 0),
                    "cooldown_until": rec.get("cooldown_until", 0.0),
                }
            payload = {
                "version": 1,
                "saved_at": time.time(),
                "identities": cleaned_identities,
                "global_fails": self._global_fails,
            }
            tmp = self.state_path.with_name(f".{self.state_path.name}.tmp-{os.getpid()}-{threading.get_ident()}")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(self.state_path)
            self.last_persist_ok = time.time()
            self.last_persist_error = None
            if self.degraded and self.degraded_reason and self.degraded_reason.startswith("persist_failure"):
                self.degraded = False
                self.degraded_reason = None
        except OSError as exc:
            self.dropped_persists += 1
            self.degraded = True
            self.last_persist_error = f"{type(exc).__name__}: {str(exc)[:80]}"
            if not self.degraded_reason or self.degraded_reason.startswith("persist_failure"):
                self.degraded_reason = f"persist_failure: {self.last_persist_error}"

    def _prune_locked(self, now: float) -> None:
        self._global_fails = [t for t in self._global_fails if now - t < self.global_window_sec]
        self._global_inflight = {k: t for k, t in self._global_inflight.items() if now - t < INFLIGHT_ATTEMPT_TTL_SEC}

        dead: list[str] = []
        STREAK_RETENTION_SEC = 1800.0  # 30 minutes to remember penalty streak
        for ident, rec in self._identities.items():
            rec["fails"] = [t for t in rec.get("fails", []) if now - t < self.window_sec]
            inflight = rec.get("inflight")
            if isinstance(inflight, dict):
                rec["inflight"] = {k: t for k, t in inflight.items() if now - t < INFLIGHT_ATTEMPT_TTL_SEC}
            else:
                rec["inflight"] = {}
            cooldown = float(rec.get("cooldown_until", 0.0))
            last_activity = max([cooldown] + rec.get("fails", []))
            if not rec["fails"] and not rec["inflight"] and cooldown <= now and (now - last_activity > STREAK_RETENTION_SEC):
                dead.append(ident)
        for k in dead:
            self._identities.pop(k, None)

        # Enforce bounded capacity
        if len(self._identities) > self.max_identities:
            sorted_items = sorted(
                self._identities.items(),
                key=lambda item: max(item[1].get("fails") or [0.0]),
            )
            to_remove = len(self._identities) - self.max_identities
            for k, _ in sorted_items[:to_remove]:
                self._identities.pop(k, None)

    def check_rate_limit(self, identity: str, now: float | None = None) -> tuple[bool, str | None, float]:
        """Passive check if an attempt is permitted without reserving an attempt ticket.

        Returns (allowed, reason, retry_after_sec).
        """
        t_now = time.time() if now is None else float(now)
        ident = (identity or "unknown").strip()[:64]
        is_proxy = ident.startswith("tailscale_") or ident == "proxy_shared"
        allowed_attempts = self.proxy_max_attempts if is_proxy else self.max_attempts

        with self._lock:
            self._prune_locked(t_now)

            # 1. Global budget check
            active_global = len(self._global_fails) + len(self._global_inflight)
            if active_global >= self.global_max:
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

            # 3. Sliding-window threshold check (fails + inflight)
            fails = [t for t in rec.get("fails", []) if t_now - t < self.window_sec]
            inflight = rec.get("inflight", {})
            total_active = len(fails) + len(inflight)
            if total_active >= allowed_attempts:
                earliest = min(fails) if fails else t_now
                retry_after = max(1.0, self.window_sec - (t_now - earliest))
                return False, "rate_limited", retry_after

            return True, None, 0.0

    def acquire_attempt(self, identity: str, now: float | None = None) -> tuple[bool, str | None, float, str | None]:
        """Reserve an in-flight attempt ticket if within rate limits.

        Prevents concurrent requests from defeating attempt limits by reserving
        capacity before authentication computation begins.
        Returns (allowed, reason, retry_after_sec, ticket).
        """
        t_now = time.time() if now is None else float(now)
        ident = (identity or "unknown").strip()[:64]
        is_proxy = ident.startswith("tailscale_") or ident == "proxy_shared"
        allowed_attempts = self.proxy_max_attempts if is_proxy else self.max_attempts

        with self._lock:
            self._prune_locked(t_now)

            # 1. Global budget check (fails + inflight)
            active_global = len(self._global_fails) + len(self._global_inflight)
            if active_global >= self.global_max:
                earliest = min(self._global_fails) if self._global_fails else t_now
                retry_after = max(1.0, self.global_window_sec - (t_now - earliest))
                return False, "global_budget_exhausted", retry_after, None

            rec = self._identities.setdefault(ident, {"fails": [], "streak": 0, "cooldown_until": 0.0, "inflight": {}})

            # 2. Cooldown check
            cooldown_until = float(rec.get("cooldown_until", 0.0))
            if t_now < cooldown_until:
                return False, "cooldown_active", max(1.0, cooldown_until - t_now), None

            # 3. Sliding-window threshold check (fails + inflight)
            fails = [t for t in rec.get("fails", []) if t_now - t < self.window_sec]
            rec["fails"] = fails
            inflight = rec.setdefault("inflight", {})
            total_active = len(fails) + len(inflight)
            if total_active >= allowed_attempts:
                earliest = min(fails) if fails else t_now
                retry_after = max(1.0, self.window_sec - (t_now - earliest))
                return False, "rate_limited", retry_after, None

            # Issue ticket and track in-flight
            ticket = secrets.token_hex(8)
            inflight[ticket] = t_now
            self._global_inflight[ticket] = t_now
            return True, None, 0.0, ticket

    def record_failure(self, identity: str, ticket: str | None = None, now: float | None = None) -> tuple[bool, float]:
        """Record an authentication failure and release any active reservation ticket.

        Returns (is_now_blocked, cooldown_sec).
        """
        t_now = time.time() if now is None else float(now)
        ident = (identity or "unknown").strip()[:64]
        is_proxy = ident.startswith("tailscale_") or ident == "proxy_shared"
        allowed_attempts = self.proxy_max_attempts if is_proxy else self.max_attempts

        with self._lock:
            self._prune_locked(t_now)
            if ticket:
                self._global_inflight.pop(ticket, None)
            self._global_fails.append(t_now)

            rec = self._identities.setdefault(ident, {"fails": [], "streak": 0, "cooldown_until": 0.0, "inflight": {}})
            if ticket and isinstance(rec.get("inflight"), dict):
                rec["inflight"].pop(ticket, None)

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

    def record_success(self, identity: str, ticket: str | None = None) -> None:
        """Reset failed attempts and clear in-flight reservation for a successfully authenticated identity."""
        ident = (identity or "unknown").strip()[:64]
        with self._lock:
            if ticket:
                self._global_inflight.pop(ticket, None)
            if ident in self._identities:
                rec = self._identities.pop(ident, None)
                if rec and ticket and isinstance(rec.get("inflight"), dict):
                    rec["inflight"].pop(ticket, None)
                self._persist_locked()

    def release_attempt(self, identity: str, ticket: str | None) -> None:
        """Release an in-flight attempt ticket without recording failure."""
        if not ticket:
            return
        ident = (identity or "unknown").strip()[:64]
        with self._lock:
            self._global_inflight.pop(ticket, None)
            rec = self._identities.get(ident)
            if rec and isinstance(rec.get("inflight"), dict):
                rec["inflight"].pop(ticket, None)

    def get_status(self) -> dict:
        """Sanitized telemetry overview of the rate limiter including degraded policy metrics."""
        with self._lock:
            now = time.time()
            return {
                "tracked_identities": len(self._identities),
                "global_recent_failures": len([t for t in self._global_fails if now - t < self.global_window_sec]),
                "global_inflight": len(self._global_inflight),
                "active_cooldowns": sum(1 for r in self._identities.values() if r.get("cooldown_until", 0.0) > now),
                "degraded": self.degraded,
                "degraded_reason": self.degraded_reason,
                "dropped_persists": self.dropped_persists,
                "last_persist_error": self.last_persist_error,
                "last_persist_ok": self.last_persist_ok,
                "corrupt_files_quarantined": self.corrupt_files_quarantined,
            }

    def clear_for_tests(self) -> None:
        with self._lock:
            self._identities.clear()
            self._global_fails.clear()
            self._global_inflight.clear()
            self.degraded = False
            self.degraded_reason = None
            self.corrupt_files_quarantined = 0
            self.dropped_persists = 0
            self.last_persist_error = None
            self.last_persist_ok = None
            if self.state_path and self.state_path.is_file():
                try:
                    self.state_path.unlink()
                except OSError:
                    pass
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
        tailscale_domain: str | None = None,
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

        if tailscale_domain:
            clean_ts = tailscale_domain.strip().lower().rstrip(".")
            if clean_ts and "." in clean_ts:
                add_entry(clean_ts, 443)
                add_entry(clean_ts, None)

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
    def build_approved_serve_hosts(
        public_base_urls: list[str] | None = None,
        tailscale_domain: str | None = None,
    ) -> set[str]:
        """Compile approved hostnames specifically for Tailscale Serve HTTPS reverse proxy.

        Environmental Trust Model & Zero-Authorization Guarantee:
        - Loopback TCP sockets in Python standard library on Windows cannot cryptographically
          prove peer process identity without low-level OS hooks.
        - Tailscale Serve runs on the host, terminates TLS, and proxies HTTP traffic to 127.0.0.1.
        - Under our single-tenant environmental trust model, untrusted local users cannot run code.
        - Zero-Authorization Guarantee: Classifying a connection as arriving via Tailscale Serve
          confers ZERO authorization:
          * It does NOT bypass PIN authentication.
          * It does NOT grant admin or upload privileges.
          * It does NOT bypass session tokens or generation checks.
          * It does NOT bypass CSRF origin verification.
          * It only:
            1. Enables the 'Secure' cookie attribute for HTTPS delivery to the client.
            2. Partitions rate-limiting into the shared tailnet proxy allowance.
            3. Sets the telemetry source class to 'tailscale_serve'.
        - To prevent proxy classification from matching local loopback requests, this allowlist
          STRICTLY includes configured public_base_urls and Tailscale domains, and EXCLUDES
          127.0.0.1, localhost, and LAN addresses.
        """
        approved: set[str] = set()
        for u in (public_base_urls or []):
            try:
                p = urlparse(str(u).strip())
                if p.hostname:
                    approved.add(p.hostname.lower())
                    if p.netloc:
                        approved.add(p.netloc.lower())
            except Exception:
                pass

        if tailscale_domain:
            clean_ts = tailscale_domain.strip().lower().rstrip(".")
            if clean_ts and "." in clean_ts:
                approved.add(clean_ts)
                approved.add(f"{clean_ts}:443")

        return approved

    @staticmethod
    def is_trusted_tailscale_proxy(
        client_address: tuple[str, int] | list[Any] | None,
        headers: Any,
        approved_serve_hosts: set[str],
        proxy_secret: str | None = None,
    ) -> bool:
        """Verify whether the request arrives via local Tailscale Serve HTTPS proxy under our trust model.

        Requires:
        1. Direct socket peer is loopback (127.0.0.1 or ::1). Non-loopback peers are NEVER trusted.
        2. X-Forwarded-Proto header is strictly 'https'.
        3. X-Forwarded-Host or Host matches an approved Tailscale Serve hostname.
        4. If proxy_secret is configured, X-HQ-Proxy-Secret must match via constant-time comparison.
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
        if not clean_fwd:
            return False

        bare_host = clean_fwd.split(":", 1)[0].lower()
        if clean_fwd.lower() not in approved_serve_hosts and bare_host not in approved_serve_hosts:
            return False

        if proxy_secret:
            incoming_secret = (headers.get("X-HQ-Proxy-Secret") or "").strip()
            if not secrets.compare_digest(incoming_secret, proxy_secret.strip()):
                return False

        return True

    @staticmethod
    def build_csrf_allowed_origins(
        server_port: int,
        lan_ip: str | None = None,
        ts_ip: str | None = None,
        public_base_urls: list[str] | None = None,
        trusted_hosts: list[str] | None = None,
        tailscale_domain: str | None = None,
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

        if tailscale_domain:
            clean_ts = tailscale_domain.strip().lower().rstrip(".")
            if clean_ts and "." in clean_ts:
                origins.add(f"https://{clean_ts}")
                origins.add(f"https://{clean_ts}:443")

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

    ALLOWED_RESULTS = frozenset({
        "allowed",
        "denied",
        "throttled",
        "revoked",
        "success",
        "failed",
        "attempted",
        "authorized",
        "scheduled",
        "accepted",
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
        res = result if result in self.ALLOWED_RESULTS else "denied"

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
            entry["action"] = re.sub(r"[^A-Za-z0-9_./-]", "", str(action))[:60]
        if path_category:
            entry["path_category"] = re.sub(r"[^A-Za-z0-9_./-]", "", str(path_category))[:40]

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

