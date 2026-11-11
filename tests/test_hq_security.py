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

        # Legacy 7-day session created 10 minutes ago
        legacy_created = now - 600.0
        raw_legacy = {
            "exp": legacy_created + sec.LEGACY_SESSION_TTL_SEC,
            "user": "bob",
            "role": "upload",
            "gen": 1,
        }
        parsed_leg = sec.parse_stored_session(raw_legacy, {}, now=now)
        self.assertIsNotNone(parsed_leg)
        assert parsed_leg is not None
        self.assertEqual(parsed_leg["idle_sec"], 60 * 60.0)
        self.assertEqual(parsed_leg["last_active"], legacy_created)
        self.assertEqual(parsed_leg["exp"], legacy_created + 24 * 3600.0)

        # Malformed entries must return None (fail closed)
        self.assertIsNone(sec.parse_stored_session({"exp": "not_a_float", "role": "admin", "gen": 1}, {}, now=now))
        self.assertIsNone(sec.parse_stored_session({"exp": future, "role": "superuser", "gen": 1}, {}, now=now))
        self.assertIsNone(sec.parse_stored_session({"exp": future, "role": "admin", "gen": "1"}, {}, now=now))
        self.assertIsNone(sec.parse_stored_session({"exp": future, "role": "admin", "gen": True}, {}, now=now))
        self.assertIsNone(sec.parse_stored_session({"exp": now - 1.0, "role": "admin", "gen": 1}, {}, now=now))

    def test_legacy_session_migration_exceeding_abs_ttl_rejected(self) -> None:
        now = 1000000.0
        # Created 5 days ago under 7-day policy: exp is still 2 days in the future,
        # but 5 days exceeds newly configured 24h absolute lifetime!
        created_5d_ago = now - (5 * 86400.0)
        legacy_7d = {
            "exp": created_5d_ago + sec.LEGACY_SESSION_TTL_SEC,
            "user": "old_admin",
            "role": "admin",
            "gen": 1,
        }
        # Under default 24h policy, must fail closed
        parsed = sec.parse_stored_session(legacy_7d, {}, now=now)
        self.assertIsNone(parsed)

    def test_legacy_session_migration_exceeding_idle_ttl_rejected(self) -> None:
        now = 1000000.0
        # Created 2 hours ago without last_active under 7-day policy.
        # Under 45-minute admin idle timeout, it cannot claim an unearned fresh idle window!
        created_2h_ago = now - 7200.0
        legacy_2h = {
            "exp": created_2h_ago + sec.LEGACY_SESSION_TTL_SEC,
            "user": "idle_admin",
            "role": "admin",
            "gen": 1,
        }
        parsed = sec.parse_stored_session(legacy_2h, {}, now=now)
        self.assertIsNone(parsed)

    def test_legacy_session_migration_future_timestamp_rejected(self) -> None:
        now = 1000000.0
        future_rec = {
            "exp": now + 100000.0,
            "created_at": now + 3600.0,
            "user": "future_user",
            "role": "admin",
            "gen": 1,
        }
        self.assertIsNone(sec.parse_stored_session(future_rec, {}, now=now))

    def test_session_policy_key_compatibility(self) -> None:
        """Verify both primary (session_<role>_<kind>_sec) and alternate (<role>_session_<kind>_sec) keys work."""
        # 1. Primary keys
        cfg_primary = {
            "session_admin_absolute_sec": 7200,
            "session_admin_idle_sec": 1200,
            "session_upload_absolute_sec": 3600,
            "session_upload_idle_sec": 600,
        }
        a_abs, a_idle = sec.get_session_policy(cfg_primary, "admin")
        u_abs, u_idle = sec.get_session_policy(cfg_primary, "upload")
        self.assertEqual((a_abs, a_idle), (7200.0, 1200.0))
        self.assertEqual((u_abs, u_idle), (3600.0, 600.0))

        # 2. Alternate keys
        cfg_alt = {
            "admin_session_absolute_sec": 10800,
            "admin_session_idle_sec": 1800,
            "upload_session_absolute_sec": 5400,
            "upload_session_idle_sec": 900,
        }
        a_abs2, a_idle2 = sec.get_session_policy(cfg_alt, "admin")
        u_abs2, u_idle2 = sec.get_session_policy(cfg_alt, "upload")
        self.assertEqual((a_abs2, a_idle2), (10800.0, 1800.0))
        self.assertEqual((u_abs2, u_idle2), (5400.0, 900.0))


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

    def test_degraded_policy_on_corrupt_file(self) -> None:
        self.state_file.write_text("{corrupt json", encoding="utf-8")
        lim = sec.AuthRateLimiter(self.state_file, max_attempts=3)
        st = lim.get_status()
        self.assertTrue(st["degraded"])
        self.assertIn("corrupt_state_file", str(st["degraded_reason"]))
        self.assertGreaterEqual(st["corrupt_files_quarantined"], 1)

    def test_degraded_policy_on_write_error(self) -> None:
        lim = sec.AuthRateLimiter(self.state_file, max_attempts=3)
        import unittest.mock as mock
        with mock.patch("pathlib.Path.replace", side_effect=OSError("Disk write error")):
            lim.record_failure("192.168.2.99")
        st = lim.get_status()
        self.assertTrue(st["degraded"])
        self.assertGreaterEqual(st["dropped_persists"], 1)
        self.assertIn("Disk write error", str(st["last_persist_error"]))

    def test_rate_limiter_recovery_behavior(self) -> None:
        """Verify that when state is unreadable, historical failures are lost, degradation is observable,
        and new failures are tracked and persisted normally going forward."""
        # Create unreadable corrupt state
        self.state_file.write_text('{"identities": {"corrupt_truncated": ', encoding="utf-8")
        lim = sec.AuthRateLimiter(self.state_file, max_attempts=3)

        # 1. Observable degradation: degraded is True, corrupt files quarantined
        st = lim.get_status()
        self.assertTrue(st["degraded"])
        self.assertEqual(st["tracked_identities"], 0)  # Historical failure state cannot be preserved
        self.assertGreaterEqual(st["corrupt_files_quarantined"], 1)

        # 2. Subsequent failures are tracked and persisted
        lim.record_failure("192.168.2.200")
        st2 = lim.get_status()
        self.assertEqual(st2["tracked_identities"], 1)

        # Verify state file was repaired and contains valid JSON
        repaired_text = self.state_file.read_text(encoding="utf-8")
        repaired_data = json.loads(repaired_text)
        self.assertIn("192.168.2.200", repaired_data["identities"])

        # 3. New restart from the repaired file loads cleanly without degradation
        lim_restarted = sec.AuthRateLimiter(self.state_file, max_attempts=3)
        st3 = lim_restarted.get_status()
        self.assertFalse(st3["degraded"])
        self.assertEqual(st3["tracked_identities"], 1)

    def test_concurrency_attempt_reservation(self) -> None:
        lim = sec.AuthRateLimiter(self.state_file, max_attempts=3, window_sec=10.0)
        client = "192.168.2.150"

        # Three concurrent attempts acquire tickets successfully
        ok1, _, _, t1 = lim.acquire_attempt(client)
        ok2, _, _, t2 = lim.acquire_attempt(client)
        ok3, _, _, t3 = lim.acquire_attempt(client)
        self.assertTrue(ok1)
        self.assertTrue(ok2)
        self.assertTrue(ok3)

        # 4th concurrent attempt is rejected before computation begins
        ok4, reason4, retry4, t4 = lim.acquire_attempt(client)
        self.assertFalse(ok4)
        self.assertEqual(reason4, "rate_limited")
        self.assertIsNone(t4)

        # Release one attempt
        lim.release_attempt(client, t1)

        # Capacity is restored for another attempt
        ok5, _, _, t5 = lim.acquire_attempt(client)
        self.assertTrue(ok5)

        # Consuming ticket with failure records failure
        blocked, cd = lim.record_failure(client, ticket=t2)
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

    def test_build_approved_serve_hosts_excludes_loopback_and_lan(self) -> None:
        serve_hosts = sec.HostProxyCSRFValidator.build_approved_serve_hosts(
            public_base_urls=["https://vieuxpeepee.taila4d470.ts.net/"],
            tailscale_domain="ts.net",
        )
        self.assertIn("vieuxpeepee.taila4d470.ts.net", serve_hosts)
        self.assertIn("ts.net", serve_hosts)
        self.assertNotIn("127.0.0.1", serve_hosts)
        self.assertNotIn("localhost", serve_hosts)
        self.assertNotIn("::1", serve_hosts)
        self.assertNotIn("192.168.2.1", serve_hosts)

    def test_trusted_proxy_secret_validation(self) -> None:
        serve_hosts = {"vieuxpeepee.taila4d470.ts.net"}
        headers = {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "vieuxpeepee.taila4d470.ts.net",
        }
        # When secret configured, missing secret fails
        self.assertFalse(sec.HostProxyCSRFValidator.is_trusted_tailscale_proxy(
            ("127.0.0.1", 54321), headers, serve_hosts, proxy_secret="expected-secret"
        ))
        # Wrong secret fails
        headers_wrong = dict(headers, **{"X-HQ-Proxy-Secret": "wrong-secret"})
        self.assertFalse(sec.HostProxyCSRFValidator.is_trusted_tailscale_proxy(
            ("127.0.0.1", 54321), headers_wrong, serve_hosts, proxy_secret="expected-secret"
        ))
        # Correct secret passes
        headers_ok = dict(headers, **{"X-HQ-Proxy-Secret": "expected-secret"})
        self.assertTrue(sec.HostProxyCSRFValidator.is_trusted_tailscale_proxy(
            ("127.0.0.1", 54321), headers_ok, serve_hosts, proxy_secret="expected-secret"
        ))

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


    def test_privileged_action_lifecycle_results(self) -> None:
        log = sec.SecurityLog(maxlen=10)
        for res in ("attempted", "authorized", "scheduled", "accepted", "success", "failed"):
            log.record(
                sec.SecurityLog.EVENT_PRIVILEGED_ACTION,
                result=res,
                action="/api/pc/lock",
            )
        tail = log.tail(10)
        results = [e["result"] for e in tail]
        self.assertEqual(results, ["attempted", "authorized", "scheduled", "accepted", "success", "failed"])


if __name__ == "__main__":
    unittest.main()
