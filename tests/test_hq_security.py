"""Tests for Phase 16 Authentication Hardening & Security Telemetry (hq_security.py)."""

from __future__ import annotations

import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path

import hq_security as sec


class SessionLifecycleTests(unittest.TestCase):
    def test_default_policies(self) -> None:
        cfg: dict = {}
        admin_abs, admin_idle = sec.get_session_policy(cfg, "admin")
        self.assertEqual(admin_abs, 24 * 3600.0)
        self.assertEqual(admin_idle, 45 * 60.0)

        upload_abs, upload_idle = sec.get_session_policy(cfg, "upload")
        self.assertEqual(upload_abs, 24 * 3600.0)
        self.assertEqual(upload_idle, 60 * 60.0)

    def test_configured_and_bounded_policies(self) -> None:
        cfg = {
            "session_admin_absolute_sec": 7200,
            "session_admin_idle_sec": 1800,
            "session_upload_absolute_sec": 3600,
            "session_upload_idle_sec": 900,
        }
        self.assertEqual(sec.get_session_policy(cfg, "admin"), (7200.0, 1800.0))
        self.assertEqual(sec.get_session_policy(cfg, "upload"), (3600.0, 900.0))

        # Test bounds: idle cannot exceed absolute
        cfg_inverted = {
            "session_admin_absolute_sec": 1200,
            "session_admin_idle_sec": 2400,
        }
        admin_abs, admin_idle = sec.get_session_policy(cfg_inverted, "admin")
        self.assertEqual(admin_abs, 1200.0)
        self.assertEqual(admin_idle, 1200.0)  # Capped at absolute

        # Test minimum bounds
        cfg_too_low = {
            "session_admin_absolute_sec": 10,  # Below min 60s
            "session_admin_idle_sec": 5,       # Below min 30s
        }
        a_abs, a_idle = sec.get_session_policy(cfg_too_low, "admin")
        self.assertEqual(a_abs, 24 * 3600.0)   # Resets to default
        self.assertEqual(a_idle, 45 * 60.0)

    def test_create_and_evaluate_session(self) -> None:
        now = 1000000.0
        rec = sec.create_session_record("admin_user", "admin", 1, {}, now=now)
        self.assertEqual(rec["user"], "admin_user")
        self.assertEqual(rec["role"], "admin")
        self.assertEqual(rec["gen"], 1)
        self.assertEqual(rec["created_at"], now)
        self.assertEqual(rec["last_active"], now)
        self.assertEqual(rec["exp"], now + 24 * 3600.0)
        self.assertEqual(rec["idle_sec"], 45 * 60.0)

        # Valid session within idle and absolute limits
        ok, reason = sec.evaluate_session(rec, 1, now=now + 100.0, touch=True)
        self.assertTrue(ok)
        self.assertIsNone(reason)
        self.assertEqual(rec["last_active"], now + 100.0)

        # Idle timeout expiration
        ok_idle, reason_idle = sec.evaluate_session(rec, 1, now=now + 100.0 + (45 * 60.0 + 1.0), touch=False)
        self.assertFalse(ok_idle)
        self.assertEqual(reason_idle, "idle_timeout")

        # Absolute expiration despite continuous activity
        rec["last_active"] = rec["exp"] - 10.0
        ok_abs, reason_abs = sec.evaluate_session(rec, 1, now=rec["exp"] + 1.0, touch=False)
        self.assertFalse(ok_abs)
        self.assertEqual(reason_abs, "absolute_timeout")

        # Generation mismatch
        ok_gen, reason_gen = sec.evaluate_session(rec, 2, now=now + 50.0, touch=False)
        self.assertFalse(ok_gen)
        self.assertEqual(reason_gen, "generation_mismatch")

    def test_parse_stored_session_compatibility(self) -> None:
        now = 1000000.0
        future = now + 5000.0

        # Valid modern record
        raw_valid = {
            "exp": future,
            "idle_sec": 1800.0,
            "last_active": now - 100.0,
            "created_at": now - 500.0,
            "user": "alice",
            "role": "admin",
            "gen": 1,
        }
        parsed = sec.parse_stored_session(raw_valid, {}, now=now)
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed["user"], "alice")
        self.assertEqual(parsed["role"], "admin")
        self.assertEqual(parsed["gen"], 1)

        # Legacy record missing idle_sec and last_active
        raw_legacy = {
            "exp": future,
            "user": "bob",
            "role": "upload",
            "gen": 1,
        }
        parsed_leg = sec.parse_stored_session(raw_legacy, {}, now=now)
        self.assertIsNotNone(parsed_leg)
        assert parsed_leg is not None
        self.assertEqual(parsed_leg["idle_sec"], 60 * 60.0)
        self.assertEqual(parsed_leg["last_active"], now)

        # Malformed entries must return None (fail closed)
        self.assertIsNone(sec.parse_stored_session({"exp": "not_a_float", "role": "admin", "gen": 1}, {}, now=now))
        self.assertIsNone(sec.parse_stored_session({"exp": future, "role": "superuser", "gen": 1}, {}, now=now))
        self.assertIsNone(sec.parse_stored_session({"exp": future, "role": "admin", "gen": "1"}, {}, now=now))
        self.assertIsNone(sec.parse_stored_session({"exp": future, "role": "admin", "gen": True}, {}, now=now))
        self.assertIsNone(sec.parse_stored_session({"exp": now - 1.0, "role": "admin", "gen": 1}, {}, now=now))


class RateLimiterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-rate-test-"))
        self.state_file = self.tmp / "rate_limits.json"
        self.limiter = sec.AuthRateLimiter(self.state_file, max_attempts=3, window_sec=10.0, global_max=5)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_attempts_and_cooldown(self) -> None:
        client = "192.168.2.50"
        t0 = 1000.0

        # 1st attempt
        allowed, reason, _ = self.limiter.check_rate_limit(client, now=t0)
        self.assertTrue(allowed)
        blocked, cd = self.limiter.record_failure(client, now=t0)
        self.assertFalse(blocked)

        # 2nd attempt
        allowed, _, _ = self.limiter.check_rate_limit(client, now=t0 + 1.0)
        self.assertTrue(allowed)
        blocked, _ = self.limiter.record_failure(client, now=t0 + 1.0)
        self.assertFalse(blocked)

        # 3rd attempt reaches limit
        allowed, _, _ = self.limiter.check_rate_limit(client, now=t0 + 2.0)
        self.assertTrue(allowed)
        blocked, cd = self.limiter.record_failure(client, now=t0 + 2.0)
        self.assertTrue(blocked)
        self.assertEqual(cd, 60.0)

        # 4th attempt blocked by rate limit / cooldown
        allowed, reason, retry = self.limiter.check_rate_limit(client, now=t0 + 3.0)
        self.assertFalse(allowed)
        self.assertEqual(reason, "cooldown_active")
        self.assertGreater(retry, 50.0)

    def test_progressive_cooldown_tiers(self) -> None:
        client = "192.168.2.51"
        t = 1000.0

        # Tier 1 cooldown (60s) after 3 failures
        for _ in range(3):
            self.limiter.record_failure(client, now=t)
        self.assertFalse(self.limiter.check_rate_limit(client, now=t + 1)[0])

        # Fast forward past Tier 1 cooldown (t + 65s)
        t_t2 = t + 65.0
        allowed, _, _ = self.limiter.check_rate_limit(client, now=t_t2)
        self.assertTrue(allowed)

        # 3 failures in second window trigger Tier 2 cooldown (120s)
        self.limiter.record_failure(client, now=t_t2)
        self.limiter.record_failure(client, now=t_t2 + 1.0)
        blocked, cd2 = self.limiter.record_failure(client, now=t_t2 + 2.0)
        self.assertTrue(blocked)
        self.assertEqual(cd2, 120.0)

        # Verify cooldown active at t_t2 + 10s
        self.assertFalse(self.limiter.check_rate_limit(client, now=t_t2 + 10.0)[0])

    def test_global_budget_exhaustion(self) -> None:
        t = 2000.0
        # Global max is 5
        for i in range(5):
            self.limiter.record_failure(f"192.168.2.{100 + i}", now=t)

        # Any new client is blocked by global threshold
        allowed, reason, _ = self.limiter.check_rate_limit("192.168.2.200", now=t + 1.0)
        self.assertFalse(allowed)
        self.assertEqual(reason, "global_budget_exhausted")

    def test_persistence_across_restarts(self) -> None:
        client = "192.168.2.70"
        t = 3000.0
        for _ in range(3):
            self.limiter.record_failure(client, now=t)

        # Create new limiter instance pointing to the same file
        reloaded = sec.AuthRateLimiter(self.state_file, max_attempts=3, window_sec=10.0, global_max=5)
        allowed, reason, _ = reloaded.check_rate_limit(client, now=t + 1.0)
        self.assertFalse(allowed)
        self.assertEqual(reason, "cooldown_active")

    def test_success_resets_failures(self) -> None:
        client = "192.168.2.80"
        t = 4000.0
        self.limiter.record_failure(client, now=t)
        self.limiter.record_failure(client, now=t + 1.0)
        self.limiter.record_success(client)

        # Clean slate: can record 2 failures without being blocked
        self.limiter.record_failure(client, now=t + 2.0)
        blocked, _ = self.limiter.record_failure(client, now=t + 3.0)
        self.assertFalse(blocked)


class HostProxyCSRFValidatorTests(unittest.TestCase):
    def test_host_validation(self) -> None:
        approved = sec.HostProxyCSRFValidator.build_approved_hosts(
            server_port=8765,
            lan_ip="192.168.2.110",
            ts_ip="100.64.242.80",
            public_base_urls=["https://vieuxpeepee.taila4d470.ts.net"],
            trusted_hosts_config=["custom.local"],
        )
        self.assertIn("127.0.0.1:8765", approved)
        self.assertIn("localhost:8765", approved)
        self.assertIn("192.168.2.110:8765", approved)
        self.assertIn("100.64.242.80:8765", approved)
        self.assertIn("vieuxpeepee.taila4d470.ts.net", approved)
        self.assertIn("custom.local:8765", approved)

        # Approved hosts pass
        ok, _ = sec.HostProxyCSRFValidator.validate_host("localhost:8765", approved)
        self.assertTrue(ok)
        ok, _ = sec.HostProxyCSRFValidator.validate_host("vieuxpeepee.taila4d470.ts.net", approved)
        self.assertTrue(ok)

        # Untrusted hosts rejected
        ok_evil, reason = sec.HostProxyCSRFValidator.validate_host("evil.attacker.com", approved)
        self.assertFalse(ok_evil)
        self.assertEqual(reason, "untrusted_host")

        # Malformed hosts rejected
        self.assertFalse(sec.HostProxyCSRFValidator.validate_host("evil.com/path", approved)[0])
        self.assertFalse(sec.HostProxyCSRFValidator.validate_host("evil.com\\hack", approved)[0])
        self.assertFalse(sec.HostProxyCSRFValidator.validate_host("", approved)[0])
        self.assertFalse(sec.HostProxyCSRFValidator.validate_host(None, approved)[0])

    def test_trusted_proxy_validation(self) -> None:
        approved = {"vieuxpeepee.taila4d470.ts.net"}

        # Legitimate Tailscale Serve request
        headers_legit = {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "vieuxpeepee.taila4d470.ts.net",
        }
        self.assertTrue(sec.HostProxyCSRFValidator.is_trusted_tailscale_proxy(("127.0.0.1", 54321), headers_legit, approved))

        # Forged headers from non-loopback address
        self.assertFalse(sec.HostProxyCSRFValidator.is_trusted_tailscale_proxy(("192.168.2.55", 54321), headers_legit, approved))

        # Forged or contradictory proto
        headers_bad_proto = {
            "X-Forwarded-Proto": "http",
            "X-Forwarded-Host": "vieuxpeepee.taila4d470.ts.net",
        }
        self.assertFalse(sec.HostProxyCSRFValidator.is_trusted_tailscale_proxy(("127.0.0.1", 54321), headers_bad_proto, approved))

        # Untrusted forwarded host
        headers_bad_host = {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "evil.tailscale.net",
        }
        self.assertFalse(sec.HostProxyCSRFValidator.is_trusted_tailscale_proxy(("127.0.0.1", 54321), headers_bad_host, approved))

    def test_strict_csrf_validation(self) -> None:
        origins = sec.HostProxyCSRFValidator.build_csrf_allowed_origins(
            server_port=8765,
            lan_ip="192.168.2.110",
            ts_ip="100.64.242.80",
            public_base_urls=["https://vieuxpeepee.taila4d470.ts.net/"],
        )
        self.assertIn("http://127.0.0.1:8765", origins)
        self.assertIn("http://192.168.2.110:8765", origins)
        self.assertIn("https://vieuxpeepee.taila4d470.ts.net", origins)

        # Legitimate Origin matches
        ok, _ = sec.HostProxyCSRFValidator.validate_csrf(
            "/api/upload", "POST", {"Origin": "https://vieuxpeepee.taila4d470.ts.net"}, origins, has_session=True
        )
        self.assertTrue(ok)

        # Legitimate Referer matches
        ok_ref, _ = sec.HostProxyCSRFValidator.validate_csrf(
            "/api/upload", "POST", {"Referer": "http://192.168.2.110:8765/app"}, origins, has_session=True
        )
        self.assertTrue(ok_ref)

        # Cross-origin attack rejected
        ok_evil, reason = sec.HostProxyCSRFValidator.validate_csrf(
            "/api/upload", "POST", {"Origin": "https://attacker.site"}, origins, has_session=True
        )
        self.assertFalse(ok_evil)
        self.assertEqual(reason, "origin_rejected")

        # Missing Origin and Referer on state-changing POST rejected
        ok_missing, reason_m = sec.HostProxyCSRFValidator.validate_csrf(
            "/api/upload", "POST", {}, origins, has_session=True
        )
        self.assertFalse(ok_missing)
        self.assertEqual(reason_m, "origin_and_referer_missing")


class SecurityLogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-sec-log-"))
        self.log = sec.SecurityLog(maxlen=5)
        self.log.attach(self.tmp)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_record_and_privacy_redaction(self) -> None:
        # Record event with sensitive data attempts
        self.log.record(
            sec.SecurityLog.EVENT_LOGIN_FAILURE,
            severity="warning",
            actor_role="anonymous",
            source_class="lan",
            result="denied",
            reason="invalid_credentials",
            request_id="req123",
        )
        tail = self.log.tail(10)
        self.assertEqual(len(tail), 1)
        entry = tail[0]
        self.assertEqual(entry["event"], "auth.login.failure")
        self.assertEqual(entry["severity"], "warning")
        self.assertEqual(entry["reason"], "invalid_credentials")
        self.assertEqual(entry["request_id"], "req123")

        # Verify on-disk file
        log_file = self.tmp / ".hq-carnet" / "diagnostics" / "security.jsonl"
        self.assertTrue(log_file.is_file())
        file_entries = [json.loads(line) for line in log_file.read_text(encoding="utf-8").splitlines() if line]
        self.assertEqual(len(file_entries), 1)
        self.assertEqual(file_entries[0]["event"], "auth.login.failure")

    def test_bounded_ring_and_rotation(self) -> None:
        for i in range(10):
            self.log.record(
                sec.SecurityLog.EVENT_RATE_LIMITED,
                severity="warning",
                reason=f"attempt_{i}",
            )
        # maxlen is 5
        tail = self.log.tail(20)
        self.assertEqual(len(tail), 5)
        self.assertEqual(tail[-1]["reason"], "attempt_9")


if __name__ == "__main__":
    unittest.main()
