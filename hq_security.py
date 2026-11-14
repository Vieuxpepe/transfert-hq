"""Phase 16 - Authentication Hardening & Security Telemetry for Transfert HQ.

Standard-library only, concurrency-safe, bounded, privacy-preserving.
"""

from __future__ import annotations

import base64
import collections
import hashlib
import hmac
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


def create_session_record(
    user: str,
    role: str,
    gen: int,
    config: dict | None,
    now: float | None = None,
    user_id: str | None = None,
) -> dict:
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
        "user_id": str(user_id or "")[:40],
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
        "user_id": str(raw.get("user_id") or "")[:40],
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
    EVENT_ACCOUNT_CREATED = "auth.account.created"
    EVENT_ACCOUNT_DELETED = "auth.account.deleted"
    EVENT_ACCOUNT_DISABLED = "auth.account.disabled"
    EVENT_ACCOUNT_ENABLED = "auth.account.enabled"
    EVENT_ACCOUNT_PIN_ROTATED = "auth.account.pin_rotated"
    EVENT_ACCOUNT_ROLE_CHANGED = "auth.account.role_changed"
    EVENT_ACCOUNT_RENAMED = "auth.account.renamed"
    EVENT_SESSIONS_REVOKED = "auth.account.sessions_revoked"
    EVENT_PASSKEY_REGISTERED = "auth.passkey.registered"
    EVENT_PASSKEY_LOGIN = "auth.passkey.login"
    EVENT_PASSKEY_DELETED = "auth.passkey.deleted"
    EVENT_TRIPWIRE_TRIGGERED = "auth.tripwire.triggered"
    EVENT_TRIPWIRE_LOCKDOWN = "auth.tripwire.lockdown"
    EVENT_TRIPWIRE_UNLOCKED = "auth.tripwire.unlocked"
    EVENT_TRIPWIRE_UNLOCK_FAILED = "auth.tripwire.unlock_failed"

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
        EVENT_ACCOUNT_CREATED,
        EVENT_ACCOUNT_DELETED,
        EVENT_ACCOUNT_DISABLED,
        EVENT_ACCOUNT_ENABLED,
        EVENT_ACCOUNT_PIN_ROTATED,
        EVENT_ACCOUNT_ROLE_CHANGED,
        EVENT_ACCOUNT_RENAMED,
        EVENT_SESSIONS_REVOKED,
        EVENT_PASSKEY_REGISTERED,
        EVENT_PASSKEY_LOGIN,
        EVENT_PASSKEY_DELETED,
        EVENT_TRIPWIRE_TRIGGERED,
        EVENT_TRIPWIRE_LOCKDOWN,
        EVENT_TRIPWIRE_UNLOCKED,
        EVENT_TRIPWIRE_UNLOCK_FAILED,
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
        "created",
        "deleted",
        "modified",
        "rotated",
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
        actor_user_id: str | None = None,
        target_user_id: str | None = None,
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

        if actor_user_id:
            entry["actor_user_id"] = re.sub(r"[^A-Za-z0-9_.-]", "", str(actor_user_id))[:40]
        if target_user_id:
            entry["target_user_id"] = re.sub(r"[^A-Za-z0-9_.-]", "", str(target_user_id))[:40]
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


# =============================================================================
# 5. Credential Security & User Management
# =============================================================================

# Slow KDF parameters (standard library hashlib.scrypt / PBKDF2)
SCRYPT_N = 16384          # CPU/memory cost parameter (2^14)
SCRYPT_R = 8              # Block size
SCRYPT_P = 1              # Parallelization
SCRYPT_MAXMEM = 32 * 1024 * 1024  # 32 MB max memory
SALT_BYTES = 16           # 128 bits of cryptographically secure random salt
PIN_MIN_LENGTH = 8        # Minimum 8 numeric digits or passphrase characters
PIN_MAX_LENGTH = 128
PBKDF2_ROUNDS = 100_000   # Fallback rounds for PBKDF2-HMAC-SHA256


def hash_pin(pin: str, salt: bytes | None = None) -> str:
    """Hash a PIN using slow, salted standard-library scrypt (or PBKDF2 fallback).

    Format:
    scrypt$<n>$<r>$<p>$<salt_hex>$<hash_hex>
    or
    pbkdf2$sha256$<rounds>$<salt_hex>$<hash_hex>
    """
    if not isinstance(pin, str):
        raise TypeError("PIN must be a string")
    pin_clean = pin.strip()
    if not pin_clean:
        raise ValueError("PIN cannot be empty")
    pin_bytes = pin_clean.encode("utf-8")

    if salt is None:
        salt = secrets.token_bytes(SALT_BYTES)
    elif not isinstance(salt, (bytes, bytearray)) or len(salt) < 8:
        raise ValueError("Salt must be at least 8 bytes")
    else:
        salt = bytes(salt)

    try:
        derived = hashlib.scrypt(
            pin_bytes,
            salt=salt,
            n=SCRYPT_N,
            r=SCRYPT_R,
            p=SCRYPT_P,
            maxmem=SCRYPT_MAXMEM,
        )
        return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${derived.hex()}"
    except (AttributeError, ValueError):
        # Fallback to PBKDF2-HMAC-SHA256 if scrypt is unavailable
        derived = hashlib.pbkdf2_hmac("sha256", pin_bytes, salt, PBKDF2_ROUNDS)
        return f"pbkdf2$sha256${PBKDF2_ROUNDS}${salt.hex()}${derived.hex()}"


def verify_pin(pin: str, stored_hash: str) -> bool:
    """Verify a candidate PIN against a stored hash or legacy credential.

    Constant-time comparison through hmac.compare_digest.
    Supports:
    - scrypt$<n>$<r>$<p>$<salt_hex>$<hash_hex>
    - pbkdf2$<algo>$<rounds>$<salt_hex>$<hash_hex>
    - legacy sha256 hex digest (transfert-bridge:<pin>)
    - direct sha256 hex digest
    - legacy plaintext comparison
    """
    if not isinstance(pin, str) or not isinstance(stored_hash, str):
        return False
    pin_clean = pin.strip()
    stored_clean = stored_hash.strip()
    if not pin_clean or not stored_clean:
        return False

    pin_bytes = pin_clean.encode("utf-8")

    # 1. scrypt format
    if stored_clean.startswith("scrypt$"):
        parts = stored_clean.split("$")
        if len(parts) == 6:
            try:
                n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
                salt = bytes.fromhex(parts[4])
                expected = bytes.fromhex(parts[5])
                derived = hashlib.scrypt(
                    pin_bytes,
                    salt=salt,
                    n=n,
                    r=r,
                    p=p,
                    maxmem=SCRYPT_MAXMEM,
                )
                return hmac.compare_digest(derived, expected)
            except Exception:
                return False

    # 2. pbkdf2 format
    if stored_clean.startswith("pbkdf2$"):
        parts = stored_clean.split("$")
        if len(parts) == 6:
            try:
                algo = parts[1]
                rounds = int(parts[2])
                salt = bytes.fromhex(parts[3])
                expected = bytes.fromhex(parts[4])
                derived = hashlib.pbkdf2_hmac(algo, pin_bytes, salt, rounds)
                return hmac.compare_digest(derived, expected)
            except Exception:
                return False

    # 3. Legacy SHA-256 (transfert-bridge:{pin})
    try:
        legacy_hash = hashlib.sha256(f"transfert-bridge:{pin_clean}".encode("utf-8")).hexdigest()
        if hmac.compare_digest(legacy_hash, stored_clean):
            return True
    except Exception:
        pass

    # 4. Direct SHA-256 hex digest
    try:
        direct_sha256 = hashlib.sha256(pin_bytes).hexdigest()
        if hmac.compare_digest(direct_sha256, stored_clean):
            return True
    except Exception:
        pass

    # 5. Legacy plaintext comparison (for unmigrated records during startup/transition)
    try:
        if hmac.compare_digest(pin_clean, stored_clean):
            return True
    except Exception:
        pass

    return False


def validate_pin_strength(pin: str) -> tuple[bool, str]:
    """Validate that a new PIN meets security requirements.

    Requirements:
    - 8 to 128 characters
    - No leading/trailing spaces
    - No control or unprintable characters
    - If numeric: reject all-identical digits or consecutive ascending/descending sequences
    """
    if not isinstance(pin, str):
        return False, "Le PIN doit être une chaîne de caractères."
    pin_clean = pin.strip()
    if len(pin) != len(pin_clean):
        return False, "Le PIN ne doit pas contenir d'espaces au début ou à la fin."
    if len(pin_clean) < PIN_MIN_LENGTH:
        return False, f"Le PIN doit contenir au moins {PIN_MIN_LENGTH} caractères ou chiffres."
    if len(pin_clean) > PIN_MAX_LENGTH:
        return False, f"Le PIN ne peut pas dépasser {PIN_MAX_LENGTH} caractères."

    # Reject non-printable / control characters
    if any(ord(c) < 32 or ord(c) == 127 for c in pin_clean):
        return False, "Le PIN contient des caractères non autorisés."

    # If numeric, reject trivial patterns
    if pin_clean.isdigit():
        if len(set(pin_clean)) == 1:
            return False, "Le PIN ne peut pas être composé d'un seul chiffre répété."
        is_asc = all(int(pin_clean[i]) == (int(pin_clean[i - 1]) + 1) % 10 for i in range(1, len(pin_clean)))
        is_desc = all(int(pin_clean[i]) == (int(pin_clean[i - 1]) - 1) % 10 for i in range(1, len(pin_clean)))
        if is_asc or is_desc:
            return False, "Le PIN ne peut pas être une séquence numérique consécutive triviale."

    return True, ""


def check_duplicate_pin(candidate_pin: str, users: list[dict], exclude_user_id: str | None = None) -> bool:
    """Check if candidate_pin matches the PIN of any other active user."""
    if not candidate_pin or not isinstance(users, list):
        return False
    for u in users:
        if not isinstance(u, dict):
            continue
        uid = str(u.get("id") or "")
        if exclude_user_id and uid == exclude_user_id:
            continue
        if not u.get("enabled", True):
            continue
        stored = str(u.get("pin_hash") or u.get("pin") or "").strip()
        if stored and verify_pin(candidate_pin, stored):
            return True
    return False


def generate_user_id() -> str:
    """Generate a stable, collision-resistant internal account ID."""
    return f"usr_{secrets.token_hex(6)}"


def count_enabled_admins(users: list[dict]) -> int:
    """Count the number of active, enabled administrator accounts."""
    if not isinstance(users, list):
        return 0
    return sum(
        1 for u in users
        if isinstance(u, dict)
        and u.get("role") == "admin"
        and bool(u.get("enabled", True))
        and bool(str(u.get("pin_hash") or u.get("pin") or "").strip())
    )


def find_user_by_id(users: list[dict], user_id: str) -> dict | None:
    """Find a user account dictionary by stable internal ID."""
    if not isinstance(users, list) or not user_id:
        return None
    for u in users:
        if isinstance(u, dict) and str(u.get("id") or "") == user_id:
            return u
    return None


def find_user_by_name(users: list[dict], name: str) -> dict | None:
    """Find a user account dictionary by display name (case-insensitive)."""
    if not isinstance(users, list) or not name:
        return None
    name_folded = name.strip().lower()
    for u in users:
        if isinstance(u, dict) and str(u.get("name") or "").strip().lower() == name_folded:
            return u
    return None


def migrate_users_config(config: dict) -> bool:
    """Safely migrate legacy PIN and user records to modern schema with KDF hashes.

    Guarantees:
    - Never locks out the original administrator.
    - If CONFIG["pin"] exists, ensures an enabled administrator account is present in CONFIG["users"].
    - Every account receives a stable unique internal ID.
    - Plaintext PINs in user records are upgraded to salted KDF hashes and wiped.
    - Preserves all unrelated configuration.
    """
    if not isinstance(config, dict):
        return False
    changed = False

    raw_users = config.get("users")
    if not isinstance(raw_users, list):
        raw_users = []
        config["users"] = raw_users
        changed = True

    users: list[dict] = []
    seen_ids: set[str] = set()

    # Step 1: Normalize and upgrade existing users
    for item in raw_users:
        if not isinstance(item, dict):
            changed = True
            continue
        u = dict(item)

        # ID assignment
        uid = str(u.get("id") or "").strip()
        if not uid or uid in seen_ids:
            uid = generate_user_id()
            changed = True
        u["id"] = uid
        seen_ids.add(uid)

        # Name normalization
        name = str(u.get("name") or "Utilisateur")[:40].strip() or "Utilisateur"
        if name != u.get("name"):
            u["name"] = name
            changed = True

        # Role normalization
        role = u.get("role")
        if role not in ("admin", "upload"):
            role = "upload" if "upload" in str(role).lower() else "admin"
            u["role"] = role
            changed = True

        # Enabled normalization
        enabled = bool(u.get("enabled", True))
        if "enabled" not in u or u.get("enabled") != enabled:
            u["enabled"] = enabled
            changed = True

        # Timestamp normalization
        now = time.time()
        if not isinstance(u.get("created_at"), (int, float)):
            u["created_at"] = now
            changed = True
        if not isinstance(u.get("updated_at"), (int, float)):
            u["updated_at"] = u["created_at"]
            changed = True
        if not isinstance(u.get("pin_updated_at"), (int, float)):
            u["pin_updated_at"] = u["created_at"]
            changed = True

        # Plaintext PIN migration to KDF hash
        plain_pin = str(u.get("pin") or "").strip()
        pin_hash_val = str(u.get("pin_hash") or "").strip()
        if plain_pin and not pin_hash_val:
            u["pin_hash"] = hash_pin(plain_pin)
            u.pop("pin", None)
            changed = True
        elif plain_pin and pin_hash_val:
            u.pop("pin", None)
            changed = True

        users.append(u)

    # Step 2: Ensure original administrator is NEVER locked out
    legacy_root_pin = str(config.get("pin") or "").strip()
    has_enabled_admin = any(
        u.get("role") == "admin" and u.get("enabled", True) and (u.get("pin_hash") or u.get("pin"))
        for u in users
    )

    if legacy_root_pin:
        matches_existing_admin = any(
            u.get("role") == "admin" and verify_pin(legacy_root_pin, str(u.get("pin_hash") or u.get("pin") or ""))
            for u in users
        )
        if not matches_existing_admin and not has_enabled_admin:
            # Create primary admin account from legacy root PIN
            admin_uid = "usr_admin" if "usr_admin" not in seen_ids else generate_user_id()
            now = time.time()
            admin_record = {
                "id": admin_uid,
                "name": "Administrateur",
                "role": "admin",
                "enabled": True,
                "pin_hash": hash_pin(legacy_root_pin),
                "created_at": now,
                "updated_at": now,
                "pin_updated_at": now,
            }
            users.insert(0, admin_record)
            seen_ids.add(admin_uid)
            changed = True
        elif not matches_existing_admin and has_enabled_admin and len(users) == 0:
            # Fallback
            pass

    config["users"] = users
    return changed


def create_account(
    config: dict,
    name: str,
    role: str,
    pin: str,
) -> tuple[dict | None, str | None]:
    """Create a new user account with validated credentials and invariants.

    Returns (created_account, error_message).
    """
    if not isinstance(config, dict):
        return None, "Configuration invalide."

    # Name validation
    name_clean = str(name or "").strip()
    if not name_clean:
        return None, "Le nom du compte est obligatoire."
    if len(name_clean) > 40:
        return None, "Le nom du compte ne doit pas dépasser 40 caractères."
    if re.search(r"[<>&\"'\r\n]", name_clean):
        return None, "Le nom du compte contient des caractères non autorisés."

    # Role validation
    if role not in ("admin", "upload"):
        return None, "Rôle invalide. Choisissez 'admin' ou 'upload'."

    # PIN validation
    valid_pin, pin_err = validate_pin_strength(pin)
    if not valid_pin:
        return None, pin_err

    # Ensure users array exists and legacy migration is checked
    migrate_users_config(config)
    users = config.setdefault("users", [])

    # Check for duplicate PIN across all active users
    if check_duplicate_pin(pin, users):
        return None, "Ce code PIN est déjà utilisé par un autre compte actif."

    now = time.time()
    account = {
        "id": generate_user_id(),
        "name": name_clean,
        "role": role,
        "enabled": True,
        "pin_hash": hash_pin(pin),
        "created_at": now,
        "updated_at": now,
        "pin_updated_at": now,
    }
    users.append(account)
    return account, None


def update_account(
    config: dict,
    user_id: str,
    *,
    name: str | None = None,
    role: str | None = None,
    enabled: bool | None = None,
) -> tuple[dict | None, str | None, bool]:
    """Update account details with last-administrator protection.

    Returns (updated_account, error_message, permissions_changed).
    """
    if not isinstance(config, dict):
        return None, "Configuration invalide.", False

    users = config.get("users", [])
    account = find_user_by_id(users, user_id)
    if not account:
        return None, "Compte introuvable.", False

    current_role = account.get("role", "upload")
    current_enabled = bool(account.get("enabled", True))
    is_admin = current_role == "admin" and current_enabled

    # Check last administrator invariants if demoting or disabling
    will_demote = role is not None and role != "admin" and current_role == "admin"
    will_disable = enabled is not None and not enabled and current_enabled

    if (will_demote or will_disable) and is_admin:
        if count_enabled_admins(users) <= 1:
            return None, "Impossible de désactiver ou rétrograder le dernier administrateur actif.", False

    permissions_changed = False

    if name is not None:
        name_clean = str(name).strip()
        if not name_clean:
            return None, "Le nom du compte ne peut pas être vide.", False
        if len(name_clean) > 40:
            return None, "Le nom du compte ne doit pas dépasser 40 caractères.", False
        if re.search(r"[<>&\"'\r\n]", name_clean):
            return None, "Le nom du compte contient des caractères non autorisés.", False
        account["name"] = name_clean

    if role is not None and role in ("admin", "upload"):
        if role != account.get("role"):
            account["role"] = role
            permissions_changed = True

    if enabled is not None:
        new_enabled = bool(enabled)
        if new_enabled != account.get("enabled"):
            account["enabled"] = new_enabled
            permissions_changed = True

    account["updated_at"] = time.time()
    return account, None, permissions_changed


def rotate_account_pin(
    config: dict,
    user_id: str,
    new_pin: str,
) -> tuple[dict | None, str | None]:
    """Rotate an account's PIN, validating strength and uniqueness.

    Returns (updated_account, error_message).
    """
    if not isinstance(config, dict):
        return None, "Configuration invalide."

    users = config.get("users", [])
    account = find_user_by_id(users, user_id)
    if not account:
        return None, "Compte introuvable."

    valid_pin, pin_err = validate_pin_strength(new_pin)
    if not valid_pin:
        return None, pin_err

    if check_duplicate_pin(new_pin, users, exclude_user_id=user_id):
        return None, "Ce code PIN est déjà utilisé par un autre compte actif."

    now = time.time()
    account["pin_hash"] = hash_pin(new_pin)
    account["pin_updated_at"] = now
    account["updated_at"] = now
    return account, None


def delete_account(config: dict, user_id: str) -> tuple[bool, str | None]:
    """Delete an account, enforcing last-administrator protection.

    Returns (success, error_message).
    """
    if not isinstance(config, dict):
        return False, "Configuration invalide."

    users = config.get("users", [])
    idx = next((i for i, u in enumerate(users) if isinstance(u, dict) and u.get("id") == user_id), None)
    if idx is None:
        return False, "Compte introuvable."

    account = users[idx]
    if account.get("role") == "admin" and bool(account.get("enabled", True)):
        if count_enabled_admins(users) <= 1:
            return False, "Impossible de supprimer le dernier administrateur actif."

    users.pop(idx)
    return True, None


def sanitize_account_for_api(account: dict, active_sessions: int = 0, is_current: bool = False) -> dict:
    """Return a safe representation of an account for client API consumption.

    GUARANTEE: Never exposes pin or pin_hash.
    """
    return {
        "id": str(account.get("id") or ""),
        "name": str(account.get("name") or ""),
        "role": str(account.get("role") or "upload"),
        "enabled": bool(account.get("enabled", True)),
        "created_at": float(account.get("created_at") or 0.0),
        "updated_at": float(account.get("updated_at") or 0.0),
        "pin_updated_at": float(account.get("pin_updated_at") or 0.0),
        "active_sessions": int(active_sessions),
        "is_current": bool(is_current),
    }


def revoke_sessions_for_user(
    sessions: dict,
    user_id: str,
    username: str | None = None,
    sessions_lock: threading.Lock | None = None,
) -> int:
    """Revoke all active sessions belonging to the given user ID (or legacy username).

    Concurrency-safe when sessions_lock is provided.
    Returns count of revoked sessions.
    """
    if not isinstance(sessions, dict) or not user_id:
        return 0

    revoked_count = 0
    to_delete = []

    def _scan():
        nonlocal revoked_count
        for tok, info in list(sessions.items()):
            if not isinstance(info, dict):
                continue
            sess_uid = str(info.get("user_id") or "")
            sess_user = str(info.get("user") or "")
            if sess_uid == user_id or (not sess_uid and username and sess_user == username):
                to_delete.append(tok)
        for tok in to_delete:
            sessions.pop(tok, None)
            revoked_count += 1

    if sessions_lock:
        with sessions_lock:
            _scan()
    else:
        _scan()

    return revoked_count


def count_user_sessions(sessions: dict, user_id: str, username: str | None = None) -> int:
    """Count active non-expired sessions for a specific user ID."""
    if not isinstance(sessions, dict) or not user_id:
        return 0
    now = time.time()
    count = 0
    for tok, info in sessions.items():
        if not isinstance(info, dict):
            continue
        if float(info.get("exp") or 0.0) <= now:
            continue
        sess_uid = str(info.get("user_id") or "")
        sess_user = str(info.get("user") or "")
        if sess_uid == user_id or (not sess_uid and username and sess_user == username):
            count += 1
    return count


# =============================================================================
# WebAuthn / Passkeys Engine (Face ID / Touch ID / Windows Hello)
# =============================================================================

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, rsa, padding
    HAS_WEBAUTHN_CRYPTO = True
except ImportError:
    HAS_WEBAUTHN_CRYPTO = False

_WEBAUTHN_CHALLENGES: dict[str, dict] = {}
_WEBAUTHN_LOCK = threading.Lock()
WEBAUTHN_CHALLENGE_TTL = 120.0  # seconds


def create_webauthn_challenge(user_id: str | None = None, purpose: str = "login") -> str:
    """Generate a high-entropy random base64url challenge and cache it with TTL."""
    raw = secrets.token_bytes(32)
    challenge = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    now = time.time()
    with _WEBAUTHN_LOCK:
        expired = [c for c, data in _WEBAUTHN_CHALLENGES.items() if data.get("exp", 0) <= now]
        for c in expired:
            _WEBAUTHN_CHALLENGES.pop(c, None)
        _WEBAUTHN_CHALLENGES[challenge] = {
            "user_id": user_id,
            "purpose": purpose,
            "exp": now + WEBAUTHN_CHALLENGE_TTL,
        }
    return challenge


def consume_webauthn_challenge(challenge: str) -> dict | None:
    """Validate and atomically consume a challenge. Returns associated data or None."""
    if not challenge:
        return None
    now = time.time()
    with _WEBAUTHN_LOCK:
        data = _WEBAUTHN_CHALLENGES.pop(challenge, None)
    if not data or float(data.get("exp", 0)) < now:
        return None
    return data


def register_passkey(
    config: dict,
    user_id: str,
    cred_id_b64: str,
    pubkey_der_b64: str,
    name: str = "",
) -> dict:
    """Register a new passkey credential in configuration for a user."""
    if not user_id or not cred_id_b64 or not pubkey_der_b64:
        raise ValueError("Données de clé d'accès manquantes")
    passkeys = config.setdefault("passkeys", [])
    if not isinstance(passkeys, list):
        passkeys = []
        config["passkeys"] = passkeys

    for p in passkeys:
        if isinstance(p, dict) and p.get("id") == cred_id_b64:
            raise ValueError("Cette clé d'accès est déjà enregistrée")

    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    record = {
        "id": cred_id_b64,
        "user_id": user_id,
        "public_key": pubkey_der_b64,
        "name": str(name or "Biométrie / Clé d'accès")[:60],
        "created_at": now_iso,
        "last_used_at": None,
    }
    passkeys.append(record)
    return record


def list_passkeys(config: dict, user_id: str | None = None) -> list[dict]:
    """List registered passkeys, optionally filtered by user ID (sanitized without public keys)."""
    passkeys = config.get("passkeys") or []
    if not isinstance(passkeys, list):
        return []
    out = []
    for p in passkeys:
        if not isinstance(p, dict):
            continue
        if user_id and p.get("user_id") != user_id:
            continue
        out.append({
            "id": p.get("id"),
            "user_id": p.get("user_id"),
            "name": p.get("name") or "Biométrie",
            "created_at": p.get("created_at"),
            "last_used_at": p.get("last_used_at"),
        })
    return out


def delete_passkey(config: dict, cred_id_b64: str, user_id: str | None = None) -> bool:
    """Delete a registered passkey."""
    passkeys = config.get("passkeys") or []
    if not isinstance(passkeys, list):
        return False
    idx_to_remove = None
    for i, p in enumerate(passkeys):
        if isinstance(p, dict) and p.get("id") == cred_id_b64:
            if user_id and p.get("user_id") != user_id:
                return False
            idx_to_remove = i
            break
    if idx_to_remove is not None:
        passkeys.pop(idx_to_remove)
        return True
    return False


def verify_passkey_assertion(
    config: dict,
    cred_id_b64: str,
    client_data_bytes: bytes,
    auth_data_bytes: bytes,
    signature_bytes: bytes,
    expected_challenge: str,
) -> dict | None:
    """
    Cryptographically verify a WebAuthn assertion signature against a registered passkey.
    Returns the associated user dict if valid, or None.
    """
    if not HAS_WEBAUTHN_CRYPTO:
        return None
    if not cred_id_b64 or not client_data_bytes or not auth_data_bytes or not signature_bytes:
        return None

    try:
        client_data = json.loads(client_data_bytes.decode("utf-8"))
        if client_data.get("type") != "webauthn.get":
            return None
        ch = str(client_data.get("challenge") or "").rstrip("=")
        if not hmac.compare_digest(ch, expected_challenge.rstrip("=")):
            return None
    except Exception:
        return None

    passkeys = config.get("passkeys") or []
    matching_cred = None
    for p in passkeys:
        if isinstance(p, dict) and p.get("id") == cred_id_b64:
            matching_cred = p
            break
    if not matching_cred:
        return None

    client_hash = hashlib.sha256(client_data_bytes).digest()
    data_to_verify = auth_data_bytes + client_hash

    try:
        raw_der = base64.b64decode(matching_cred["public_key"])
        pubkey = serialization.load_der_public_key(raw_der)
    except Exception:
        return None

    verified = False
    try:
        pubkey.verify(signature_bytes, data_to_verify, ec.ECDSA(hashes.SHA256()))
        verified = True
    except Exception:
        pass

    if not verified:
        try:
            pubkey.verify(signature_bytes, data_to_verify, padding.PKCS1v15(), hashes.SHA256())
            verified = True
        except Exception:
            pass

    if not verified:
        return None

    matching_cred["last_used_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    user_id = matching_cred.get("user_id")
    for u in config.get("users") or []:
        if isinstance(u, dict) and u.get("id") == user_id:
            if u.get("disabled"):
                return None
            return u

    if user_id == "usr_root":
        return {"id": "usr_root", "name": "Admin", "role": "admin", "disabled": False}

    return None


# =============================================================================
# Safety Tripwire & Hotmail Emergency Lockdown
# =============================================================================

import smtplib
import urllib.request
import urllib.error
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

_TRIPWIRE_FAILURES: list[dict] = []
_TRIPWIRE_LOCK = threading.RLock()
_TRIPWIRE_TOKENS: dict[str, dict] = {}
_LAST_ALERT_TIME: float = 0.0

DEFAULT_TRIPWIRE_RECIPIENT = "autm_200895011@hotmail.com"
DEFAULT_TRIPWIRE_SMTP_HOST = "smtp-mail.outlook.com"
DEFAULT_TRIPWIRE_SMTP_PORT = 587
TRIPWIRE_THRESHOLD = 2
TRIPWIRE_FAIL_WINDOW = 600.0  # 10 minutes
TRIPWIRE_ALERT_COOLDOWN = 180.0  # 3 minutes cooldown between emails to avoid mailbombing
LOCKDOWN_TOKEN_TTL = 86400.0  # 24 hours


def get_tripwire_config(config: dict) -> dict:
    """Retrieve or default the tripwire configuration."""
    cfg = config.get("tripwire")
    if not isinstance(cfg, dict):
        cfg = {}
    return {
        "enabled": bool(cfg.get("enabled", True)),
        "recipient_email": str(cfg.get("recipient_email") or DEFAULT_TRIPWIRE_RECIPIENT).strip(),
        "smtp_host": str(cfg.get("smtp_host") or DEFAULT_TRIPWIRE_SMTP_HOST).strip(),
        "smtp_port": int(cfg.get("smtp_port") or DEFAULT_TRIPWIRE_SMTP_PORT),
        "smtp_user": str(cfg.get("smtp_user") or DEFAULT_TRIPWIRE_RECIPIENT).strip(),
        "smtp_password": str(cfg.get("smtp_password") or "").strip(),
        "resend_api_key": str(cfg.get("resend_api_key") or "").strip(),
        "brevo_api_key": str(cfg.get("brevo_api_key") or "").strip(),
        "base_url": str(cfg.get("base_url") or "").strip(),
        "failed_threshold": int(cfg.get("failed_threshold") or TRIPWIRE_THRESHOLD),
    }


def create_lockdown_token(config: dict) -> str:
    """Create a single-use, cryptographically signed emergency lockdown token."""
    secret = str(config.get("secret_key") or "transfert-hq-emergency-secret")
    nonce = secrets.token_hex(16)
    timestamp = str(int(time.time()))
    payload = f"{timestamp}:{nonce}"
    sig = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    token = f"{payload}:{sig}"

    with _TRIPWIRE_LOCK:
        _TRIPWIRE_TOKENS[token] = {
            "exp": time.time() + LOCKDOWN_TOKEN_TTL,
            "used": False,
        }
    return token


def verify_lockdown_token(config: dict, token: str) -> bool:
    """Verify and consume a single-use emergency lockdown token."""
    if not token or token.count(":") != 2:
        return False
    timestamp, nonce, sig = token.split(":")
    secret = str(config.get("secret_key") or "transfert-hq-emergency-secret")
    payload = f"{timestamp}:{nonce}"
    expected_sig = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(sig, expected_sig):
        return False

    now = time.time()
    try:
        ts_val = float(timestamp)
        if now - ts_val > LOCKDOWN_TOKEN_TTL or ts_val > now + 300:
            return False
    except ValueError:
        return False

    with _TRIPWIRE_LOCK:
        token_data = _TRIPWIRE_TOKENS.get(token)
        if token_data:
            if token_data.get("used") or token_data.get("exp", 0) < now:
                return False
            token_data["used"] = True
            return True
        else:
            _TRIPWIRE_TOKENS[token] = {"exp": ts_val + LOCKDOWN_TOKEN_TTL, "used": True}
            return True


def record_failed_attempt(
    ip: str,
    user_agent: str,
    config: dict,
    base_url: str = "",
) -> dict | None:
    """
    Record a failed login attempt. Returns alert payload if tripwire threshold (2 tries) is reached.
    """
    global _LAST_ALERT_TIME
    now = time.time()
    tw_cfg = get_tripwire_config(config)
    if not tw_cfg["enabled"]:
        return None

    threshold = tw_cfg["failed_threshold"]

    with _TRIPWIRE_LOCK:
        _TRIPWIRE_FAILURES[:] = [f for f in _TRIPWIRE_FAILURES if now - f["t"] <= TRIPWIRE_FAIL_WINDOW]
        _TRIPWIRE_FAILURES.append({
            "t": now,
            "ip": ip,
            "ua": user_agent[:120],
        })

        recent_count = len(_TRIPWIRE_FAILURES)
        if recent_count >= threshold and (now - _LAST_ALERT_TIME >= TRIPWIRE_ALERT_COOLDOWN):
            _LAST_ALERT_TIME = now
            token = create_lockdown_token(config)
            configured_base = tw_cfg.get("base_url") or ""
            if configured_base:
                clean_base = configured_base.rstrip("/")
            elif base_url and not any(h in base_url for h in ("localhost", "127.0.0.1")):
                clean_base = base_url.rstrip("/")
            elif config.get("public_base_urls"):
                clean_base = str(config["public_base_urls"][0]).rstrip("/")
            else:
                clean_base = base_url.rstrip("/") if base_url else ""
            action_url = f"{clean_base}/emergency/lockdown?token={token}"
            unlock_url = f"{clean_base}/emergency/unlock"
            wifi_action_url = f"http://192.168.2.110:8765/emergency/lockdown?token={token}"
            wifi_unlock_url = f"http://192.168.2.110:8765/emergency/unlock"

            return {
                "failures": recent_count,
                "ip": ip,
                "user_agent": user_agent,
                "token": token,
                "action_url": action_url,
                "wifi_action_url": wifi_action_url,
                "unlock_url": unlock_url,
                "wifi_unlock_url": wifi_unlock_url,
                "recipient": tw_cfg["recipient_email"],
                "timestamp_str": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(now)),
            }
    return None


def is_locked_down(config: dict) -> bool:
    """Return True if emergency lockdown is active."""
    return bool(config.get("emergency_lockdown"))


def engage_lockdown(config: dict) -> None:
    """Engage emergency lockdown."""
    config["emergency_lockdown"] = True


def unlock_system(config: dict, admin_pin: str) -> tuple[bool, str, dict | None]:
    """
    Unlock the system ONLY if a valid administrator PIN is provided.
    Returns (success, message, admin_user_dict).
    """
    if not admin_pin:
        return False, "Code PIN requis", None

    migrate_users_config(config)

    # 1. Check enabled admin users in CONFIG["users"]
    users = config.get("users") or []
    for u in users:
        if not isinstance(u, dict):
            continue
        if u.get("role") == "admin" and not u.get("disabled"):
            h = str(u.get("pin_hash") or "")
            p = str(u.get("pin") or "")
            if (h and verify_pin(admin_pin, h)) or (p and verify_pin(admin_pin, p)):
                config["emergency_lockdown"] = False
                with _TRIPWIRE_LOCK:
                    _TRIPWIRE_FAILURES.clear()
                return True, "Système déverrouillé avec succès", u

    # 2. Check legacy root PIN fallback if admin
    root_h = str(config.get("pin_hash") or "")
    root_p = str(config.get("pin") or "")
    if (root_h and verify_pin(admin_pin, root_h)) or (root_p and verify_pin(admin_pin, root_p)):
        config["emergency_lockdown"] = False
        with _TRIPWIRE_LOCK:
            _TRIPWIRE_FAILURES.clear()
        return True, "Système déverrouillé avec succès", {"id": "usr_root", "name": "Admin", "role": "admin"}

    return False, "Code PIN administrateur incorrect", None


def tripwire_status(config: dict) -> dict:
    """Return live interactive Tripwire state, counters, and cooldown."""
    global _LAST_ALERT_TIME
    tw_cfg = get_tripwire_config(config)
    now = time.time()
    locked = is_locked_down(config)
    with _TRIPWIRE_LOCK:
        _TRIPWIRE_FAILURES[:] = [f for f in _TRIPWIRE_FAILURES if now - f["t"] <= TRIPWIRE_FAIL_WINDOW]
        recent_count = len(_TRIPWIRE_FAILURES)
        cooldown_rem = max(0, int(TRIPWIRE_ALERT_COOLDOWN - (now - _LAST_ALERT_TIME))) if _LAST_ALERT_TIME > 0 else 0

    enabled = bool(tw_cfg.get("enabled", False))
    threshold = int(tw_cfg.get("failed_threshold") or TRIPWIRE_THRESHOLD)
    if locked:
        state = "lockdown"
    elif not enabled:
        state = "disarmed"
    elif recent_count >= threshold or cooldown_rem > 0:
        state = "tripped"
    else:
        state = "armed"

    return {
        "state": state,
        "enabled": enabled,
        "locked_down": locked,
        "failed_threshold": threshold,
        "recent_failures": recent_count,
        "window_sec": int(TRIPWIRE_FAIL_WINDOW),
        "cooldown_remaining_sec": cooldown_rem,
        "recipient_email": tw_cfg.get("recipient_email", ""),
    }


def arm_or_rearm_tripwire(
    config: dict,
    *,
    enabled: bool = True,
    threshold: int | None = None,
    release_lockdown: bool = False,
) -> dict:
    """Arm or rearm the Tripwire (resets failure window & alert cooldown)."""
    global _LAST_ALERT_TIME
    tw = config.setdefault("tripwire", {})
    if not isinstance(tw, dict):
        tw = {}
        config["tripwire"] = tw
    tw["enabled"] = bool(enabled)
    if threshold is not None:
        tw["failed_threshold"] = max(1, min(20, int(threshold)))
    if release_lockdown:
        config["emergency_lockdown"] = False
    with _TRIPWIRE_LOCK:
        _TRIPWIRE_FAILURES.clear()
        _LAST_ALERT_TIME = 0.0
    return tripwire_status(config)


def send_tripwire_email(config: dict, alert_data: dict) -> tuple[bool, str]:
    """
    Deliver emergency security alert email to Hotmail using Resend HTTPS API, Brevo, or SMTP STARTTLS.
    """
    tw_cfg = get_tripwire_config(config)
    recipient = alert_data.get("recipient") or tw_cfg["recipient_email"]
    smtp_host = tw_cfg["smtp_host"]
    smtp_port = tw_cfg["smtp_port"]
    smtp_user = tw_cfg["smtp_user"]
    smtp_pass = tw_cfg["smtp_password"]
    resend_key = tw_cfg.get("resend_api_key") or (smtp_pass if smtp_pass.startswith("re_") else "")
    brevo_key = tw_cfg.get("brevo_api_key") or (smtp_pass if smtp_pass.startswith("xkeysib-") else "")

    if not smtp_pass and not resend_key and not brevo_key:
        return False, "Aucune clé de relais (Resend re_..., Brevo ou mot de passe SMTP) configurée"

    ip = html.escape(str(alert_data.get("ip") or "inconnue"))
    t_str = html.escape(str(alert_data.get("timestamp_str") or ""))
    ua = html.escape(str(alert_data.get("user_agent") or "inconnu"))
    action_url = str(alert_data.get("action_url") or "")
    wifi_action_url = str(alert_data.get("wifi_action_url") or "")
    unlock_url = str(alert_data.get("unlock_url") or "")
    wifi_unlock_url = str(alert_data.get("wifi_unlock_url") or "")

    text_body = f"""ALERTE SÉCURITÉ TRANSFERT HQ
=============================================
Deux tentatives de connexion ont échoué consécutivement.

Détails de l'incident :
- Adresse IP : {ip}
- Horodatage : {t_str}
- Navigateur : {ua}

COUPE-CIRCUIT D'URGENCE :
Si vous n'êtes pas à l'origine de ces tentatives, verrouillez immédiatement Transfert HQ en cliquant sur ce lien sécurisé (Tailscale / Distant) :
{action_url}

Si vous êtes connecté sur votre Wi-Fi local sans Tailscale :
{wifi_action_url}

Le verrouillage révoquera toutes les sessions et bloquera tout accès futur.

RÉACTIVATION ET DÉVERROUILLAGE :
Pour rouvrir ou déverrouiller l'accès, saisissez votre code PIN administrateur sur :
- Via Tailscale / Distant : {unlock_url}
- Via Wi-Fi local : {wifi_unlock_url}
"""

    html_body = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:24px;background-color:#0a0d14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f8fafc;">
  <div style="max-width:540px;margin:0 auto;background-color:#121824;border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:32px 28px;box-shadow:0 10px 30px rgba(0,0,0,0.6);">
    <div style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(244,63,94,0.12);border:1px solid rgba(244,63,94,0.35);color:#fda4af;font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:16px;">
      🚨 Coupe-circuit d'urgence
    </div>
    <h1 style="font-size:22px;font-weight:700;color:#ffffff;margin:0 0 10px;">Tentatives suspectes sur Transfert HQ</h1>
    <p style="font-size:14px;line-height:1.5;color:#94a3b8;margin:0 0 24px;">
      Deux tentatives de connexion consécutives ont échoué sur votre passerelle.
    </p>

    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:16px 18px;margin-bottom:28px;font-size:13px;line-height:1.6;">
      <div style="color:#94a3b8;"><strong style="color:#ffffff;">Adresse IP :</strong> <code>{ip}</code></div>
      <div style="color:#94a3b8;"><strong style="color:#ffffff;">Date & Heure :</strong> {t_str}</div>
      <div style="color:#94a3b8;margin-top:4px;"><strong style="color:#ffffff;">Client :</strong> <span style="font-size:12px;">{ua}</span></div>
    </div>

    <div style="text-align:center;margin-bottom:16px;">
      <a href="{action_url}" style="background:linear-gradient(135deg, #e11d48 0%, #be123c 100%);color:#ffffff;padding:16px 28px;text-decoration:none;border-radius:14px;font-weight:700;font-size:15px;display:inline-block;box-shadow:0 6px 20px rgba(225,29,72,0.45);letter-spacing:0.02em;">
        🛑 VERROUILLER TRANSFERT HQ IMMÉDIATEMENT
      </a>
    </div>

    <div style="text-align:center;margin-bottom:24px;">
      <a href="{wifi_action_url}" style="color:#fda4af;font-size:12px;text-decoration:underline;">
        Lien direct de verrouillage si vous êtes sur le Wi-Fi local (sans Tailscale)
      </a>
    </div>

    <div style="margin-top:24px;padding-top:22px;border-top:1px solid rgba(255,255,255,0.08);text-align:center;">
      <div style="font-size:13px;color:#94a3b8;margin-bottom:14px;">Faux signal ou besoin de rouvrir l'accès ?</div>
      <a href="{unlock_url}" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18);color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:12px;font-weight:600;font-size:14px;display:inline-block;">
        🔓 DÉVERROUILLER / RÉACTIVER (AVEC PIN ADMIN)
      </a>
      <div style="margin-top:10px;">
        <a href="{wifi_unlock_url}" style="color:#64748b;font-size:11px;text-decoration:underline;">
          (Lien de déverrouillage via Wi-Fi local sans Tailscale)
        </a>
      </div>
    </div>

    <p style="font-size:12px;line-height:1.5;color:#64748b;margin:0;border-top:1px solid rgba(255,255,255,0.06);padding-top:18px;margin-top:22px;">
      Le verrouillage d'urgence est réversible à tout moment uniquement en fournissant votre <strong>PIN administrateur</strong>.
    </p>
  </div>
</body>
</html>"""

    email_subject = alert_data.get("subject") or "🚨 [Alerte Sécurité HQ] 2 tentatives de connexion suspectes détectées"

    # 1. Delivery via Resend HTTPS API (Recommended)
    if resend_key:
        try:
            payload = json.dumps({
                "from": "Transfert HQ <onboarding@resend.dev>",
                "to": [recipient],
                "subject": email_subject,
                "html": html_body,
                "text": text_body,
            }).encode("utf-8")
            req = urllib.request.Request(
                "https://api.resend.com/emails",
                data=payload,
                headers={
                    "Authorization": f"Bearer {resend_key}",
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=12) as resp:
                if 200 <= resp.status < 300:
                    return True, "Courriel d'alerte envoyé avec succès via Resend"
                return False, f"Erreur Resend HTTP {resp.status}"
        except urllib.error.HTTPError as e:
            err_msg = e.read().decode("utf-8", errors="replace")
            return False, f"Erreur Resend ({e.code}) : {err_msg}"
        except Exception as e:
            return False, f"Erreur connexion Resend : {e}"

    # 2. Delivery via Brevo HTTPS API
    if brevo_key:
        try:
            payload = json.dumps({
                "sender": {"name": "Transfert HQ", "email": "transfert-hq@notify.local"},
                "to": [{"email": recipient}],
                "subject": email_subject,
                "htmlContent": html_body,
                "textContent": text_body,
            }).encode("utf-8")
            req = urllib.request.Request(
                "https://api.brevo.com/v3/smtp/email",
                data=payload,
                headers={
                    "api-key": brevo_key,
                    "Content-Type": "application/json",
                    "User-Agent": "TransfertHQ/7.0",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=12) as resp:
                if 200 <= resp.status < 300:
                    return True, "Courriel d'alerte envoyé avec succès via Brevo"
                return False, f"Erreur Brevo HTTP {resp.status}"
        except urllib.error.HTTPError as e:
            err_msg = e.read().decode("utf-8", errors="replace")
            return False, f"Erreur Brevo ({e.code}) : {err_msg}"
        except Exception as e:
            return False, f"Erreur connexion Brevo : {e}"

    # 3. Fallback: Delivery via Standard SMTP
    msg = MIMEMultipart("alternative")
    msg["Subject"] = email_subject
    msg["From"] = f"Transfert HQ <{smtp_user}>"
    msg["To"] = recipient
    msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        server = smtplib.SMTP(smtp_host, smtp_port, timeout=12)
        server.ehlo()
        server.starttls()
        server.ehlo()
        server.login(smtp_user, smtp_pass)
        server.sendmail(smtp_user, [recipient], msg.as_string())
        server.quit()
        return True, "Courriel d'alerte envoyé via SMTP"
    except Exception as e:
        return False, f"Erreur envoi courriel : {e}"


def send_tripwire_email_async(config: dict, alert_data: dict) -> None:
    """Launch email transmission in background thread so HTTP requests are never blocked."""
    def _worker():
        send_tripwire_email(config, alert_data)
    t = threading.Thread(target=_worker, name="TripwireEmailThread", daemon=True)
    t.start()


# =============================================================================
# 9. Real-Time Traffic & Provenance Tracker
# =============================================================================

class TrafficTracker:
    """Thread-safe sliding-window traffic tracker for Transfert HQ.

    Tracks requests per minute (last 60 minutes), response status distribution,
    client IP provenance, active concurrent requests, and recent request logs.
    """
    def __init__(self, history_minutes: int = 60, recent_maxlen: int = 100) -> None:
        self._lock = threading.Lock()
        self._history_minutes = history_minutes
        self._recent_requests: collections.deque[dict] = collections.deque(maxlen=recent_maxlen)
        self._minutes: dict[int, dict[str, int]] = {}
        self._total_requests = 0
        self._status_counts = {"2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0}
        self._prov_counts = {"localhost": 0, "lan": 0, "tailscale": 0, "unknown": 0}
        self._start_time = time.time()
        self._active_connections = 0

    def start_request(self) -> None:
        with self._lock:
            self._active_connections += 1

    def end_request(self) -> None:
        with self._lock:
            self._active_connections = max(0, self._active_connections - 1)

    def record(
        self,
        ip: str,
        method: str,
        path: str,
        status: int,
        duration_ms: float,
        provenance: str,
        role: str,
        pin_hint: str | None = None,
    ) -> None:
        now = time.time()
        minute_bucket = int(now // 60) * 60
        s_group = f"{status // 100}xx" if 100 <= status < 600 else "other"
        prov = provenance if provenance in ("localhost", "lan", "tailscale", "tailscale_serve") else "unknown"
        if prov == "tailscale_serve":
            prov = "tailscale"

        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "ip": ip,
            "method": method,
            "path": path.split("?")[0],
            "status": status,
            "duration_ms": round(duration_ms, 1),
            "provenance": prov,
            "role": role or "anonymous",
            "pin_hint": pin_hint,
        }

        with self._lock:
            self._total_requests += 1
            if s_group in self._status_counts:
                self._status_counts[s_group] += 1
            if prov in self._prov_counts:
                self._prov_counts[prov] += 1
            else:
                self._prov_counts["unknown"] += 1

            self._recent_requests.append(entry)

            if minute_bucket not in self._minutes:
                self._minutes[minute_bucket] = {
                    "total": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0,
                    "localhost": 0, "lan": 0, "tailscale": 0, "unknown": 0
                }
            b = self._minutes[minute_bucket]
            b["total"] += 1
            if s_group in b:
                b[s_group] += 1
            if prov in b:
                b[prov] += 1
            else:
                b["unknown"] += 1

            # Prune old minutes
            cutoff = minute_bucket - (self._history_minutes * 60)
            stale = [m for m in self._minutes if m < cutoff]
            for m in stale:
                del self._minutes[m]

    def snapshot(self) -> dict:
        now = time.time()
        current_minute = int(now // 60) * 60
        with self._lock:
            timeline = []
            for i in range(29, -1, -1):
                m = current_minute - (i * 60)
                b = self._minutes.get(m, {
                    "total": 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0,
                    "localhost": 0, "lan": 0, "tailscale": 0, "unknown": 0
                })
                timeline.append({
                    "minute": m,
                    "time": datetime.fromtimestamp(m, timezone.utc).strftime("%H:%M"),
                    **b
                })

            last_b = self._minutes.get(current_minute, {})
            req_last_min = last_b.get("total", 0)

            return {
                "total_requests": self._total_requests,
                "requests_last_minute": req_last_min,
                "active_connections": self._active_connections,
                "uptime_seconds": int(now - self._start_time),
                "status_counts": dict(self._status_counts),
                "provenance_counts": dict(self._prov_counts),
                "timeline": timeline,
                "recent_requests": list(self._recent_requests)[-50:],
            }


TRAFFIC_TRACKER = TrafficTracker()


_PROTECTED_IPS = {"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"}


class IpBlocklist:
    """Thread-safe IP quarantine/blocklist managed by Securia & HQ security."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, dict] = {}
        self._path: Path | None = None

    def attach(self, root: str | Path) -> None:
        p = Path(root) / ".hq-security" / "ip_blocklist.json"
        with self._lock:
            self._path = p
            if p.is_file():
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                    if isinstance(data, dict):
                        self._entries = {str(k): dict(v) for k, v in data.items() if isinstance(v, dict)}
                except Exception:
                    pass

    def _persist(self) -> None:
        if not self._path:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._entries, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError:
            pass

    def _prune_expired_locked(self, now: float) -> bool:
        expired = [ip for ip, rec in self._entries.items() if rec.get("expires_at") and float(rec["expires_at"]) <= now]
        for ip in expired:
            del self._entries[ip]
        return bool(expired)

    def block(self, ip: str, *, reason: str = "", duration_sec: int = 0) -> tuple[bool, str]:
        clean_ip = (ip or "").strip()
        if not clean_ip:
            return False, "Adresse IP requise."
        if clean_ip in _PROTECTED_IPS:
            return False, f"Impossible de bloquer une adresse locale protégée ({clean_ip})."
        now = time.time()
        dur = max(0, int(duration_sec or 0))
        expires_at = (now + dur) if dur > 0 else 0
        with self._lock:
            self._entries[clean_ip] = {
                "ip": clean_ip,
                "reason": (reason or "Quarantaine Securia")[:240],
                "blocked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "duration_sec": dur,
                "expires_at": expires_at,
            }
            self._persist()
        return True, f"IP {clean_ip} mise en quarantaine" + (f" pour {dur}s" if dur else " (permanente)")

    def unblock(self, ip: str) -> tuple[bool, str]:
        clean_ip = (ip or "").strip()
        with self._lock:
            if clean_ip in self._entries:
                del self._entries[clean_ip]
                self._persist()
                return True, f"IP {clean_ip} retirée de la liste de blocage."
        return False, f"IP {clean_ip} non présente dans la liste de blocage."

    def is_blocked(self, ip: str) -> tuple[bool, dict | None]:
        clean_ip = (ip or "").strip()
        if not clean_ip or clean_ip in _PROTECTED_IPS:
            return False, None
        now = time.time()
        with self._lock:
            if self._prune_expired_locked(now):
                self._persist()
            rec = self._entries.get(clean_ip)
            if rec:
                return True, dict(rec)
        return False, None

    def list_blocked(self) -> list[dict]:
        now = time.time()
        with self._lock:
            if self._prune_expired_locked(now):
                self._persist()
            return [dict(v) for v in self._entries.values()]

    def clear_for_tests(self) -> None:
        with self._lock:
            self._entries.clear()
            if self._path and self._path.is_file():
                try:
                    self._path.unlink()
                except OSError:
                    pass


IP_BLOCKLIST = IpBlocklist()






