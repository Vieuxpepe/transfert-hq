"""Unit tests for user credential security and account management in hq_security."""

from __future__ import annotations

import copy
import hashlib
import json
import threading
import time
import unittest

import hq_security as SEC


class UserSecurityTests(unittest.TestCase):
    def test_kdf_hash_and_verify(self):
        pin = "987654321"
        h1 = SEC.hash_pin(pin)
        self.assertTrue(h1.startswith("scrypt$") or h1.startswith("pbkdf2$"))
        self.assertTrue(SEC.verify_pin(pin, h1))
        self.assertFalse(SEC.verify_pin("wrong-pin", h1))
        self.assertFalse(SEC.verify_pin("", h1))
        self.assertFalse(SEC.verify_pin(pin, ""))

        # Salt uniqueness
        h2 = SEC.hash_pin(pin)
        self.assertNotEqual(h1, h2)
        self.assertTrue(SEC.verify_pin(pin, h2))

    def test_verify_pin_backward_compatibility(self):
        pin = "legacy-admin-42"
        # 1. Legacy SHA-256 with transfert-bridge prefix
        legacy_hash = hashlib.sha256(f"transfert-bridge:{pin}".encode()).hexdigest()
        self.assertTrue(SEC.verify_pin(pin, legacy_hash))
        self.assertFalse(SEC.verify_pin("other-pin", legacy_hash))

        # 2. Plaintext
        self.assertTrue(SEC.verify_pin(pin, pin))
        self.assertFalse(SEC.verify_pin("other-pin", pin))

    def test_pin_strength_validation(self):
        # Too short (< 8 chars)
        ok, msg = SEC.validate_pin_strength("12345")
        self.assertFalse(ok)
        self.assertIn("au moins 8", msg)

        # Spaces at ends
        ok, msg = SEC.validate_pin_strength(" 12345678 ")
        self.assertFalse(ok)
        self.assertIn("espaces", msg)

        # Identical digits
        ok, msg = SEC.validate_pin_strength("00000000")
        self.assertFalse(ok)
        self.assertIn("répété", msg)

        ok, msg = SEC.validate_pin_strength("999999999")
        self.assertFalse(ok)

        # Sequential ascending / descending
        ok, msg = SEC.validate_pin_strength("12345678")
        self.assertFalse(ok)
        self.assertIn("séquence", msg)

        ok, msg = SEC.validate_pin_strength("87654321")
        self.assertFalse(ok)
        self.assertIn("séquence", msg)

        # Valid numeric PINs
        ok, msg = SEC.validate_pin_strength("72948103")
        self.assertTrue(ok)
        self.assertEqual(msg, "")

        # Valid passphrase
        ok, msg = SEC.validate_pin_strength("mon-mot-de-passe-solide")
        self.assertTrue(ok)

    def test_duplicate_pin_detection(self):
        config = {
            "users": [
                {"id": "u1", "name": "Admin", "role": "admin", "enabled": True, "pin_hash": SEC.hash_pin("84920156")},
                {"id": "u2", "name": "Phone", "role": "upload", "enabled": True, "pin_hash": SEC.hash_pin("58392014")},
                {"id": "u3", "name": "Old", "role": "upload", "enabled": False, "pin_hash": SEC.hash_pin("99887766")},
            ]
        }
        # Duplicate with u1
        self.assertTrue(SEC.check_duplicate_pin("84920156", config["users"]))
        # Excluding u1 (e.g. u1 keeping or rotating to same pin)
        self.assertFalse(SEC.check_duplicate_pin("84920156", config["users"], exclude_user_id="u1"))
        # Duplicate with u2
        self.assertTrue(SEC.check_duplicate_pin("58392014", config["users"]))
        # Disabled u3 does not block reuse if desired, or verify policy
        self.assertFalse(SEC.check_duplicate_pin("99887766", config["users"]))
        # Brand new PIN
        self.assertFalse(SEC.check_duplicate_pin("31415926", config["users"]))

    def test_legacy_migration_never_locks_out_admin(self):
        # Scenario: user only has legacy root CONFIG["pin"] = "master12345"
        config = {
            "pin": "master12345",
            "users": [],
            "custom_setting": "preserve-me",
        }
        changed = SEC.migrate_users_config(config)
        self.assertTrue(changed)
        self.assertEqual(config["custom_setting"], "preserve-me")
        self.assertEqual(len(config["users"]), 1)

        admin = config["users"][0]
        self.assertEqual(admin["role"], "admin")
        self.assertTrue(admin["enabled"])
        self.assertTrue(admin["id"].startswith("usr_"))
        self.assertTrue(admin["pin_hash"].startswith("scrypt$") or admin["pin_hash"].startswith("pbkdf2$"))
        self.assertTrue(SEC.verify_pin("master12345", admin["pin_hash"]))
        self.assertNotIn("pin", admin)

        # Now creating an upload user does NOT disable or erase the admin
        upload_user, err = SEC.create_account(config, "Scanner Phone", "upload", "92837416")
        self.assertIsNone(err)
        self.assertIsNotNone(upload_user)
        self.assertEqual(len(config["users"]), 2)

        # Admin is still enabled and accessible!
        self.assertEqual(SEC.count_enabled_admins(config["users"]), 1)
        self.assertTrue(SEC.verify_pin("master12345", config["users"][0]["pin_hash"]))
        self.assertTrue(SEC.verify_pin("92837416", upload_user["pin_hash"]))

    def test_legacy_users_plaintext_pin_upgrade(self):
        config = {
            "users": [
                {"name": "Admin", "pin": "plain-admin-123", "role": "admin"},
                {"name": "Phone", "pin": "plain-phone-456", "role": "upload"},
            ]
        }
        SEC.migrate_users_config(config)
        for u in config["users"]:
            self.assertNotIn("pin", u)
            self.assertTrue("pin_hash" in u)
            self.assertTrue(u["id"].startswith("usr_"))
        self.assertTrue(SEC.verify_pin("plain-admin-123", config["users"][0]["pin_hash"]))
        self.assertTrue(SEC.verify_pin("plain-phone-456", config["users"][1]["pin_hash"]))

    def test_last_administrator_protection(self):
        config = {
            "users": [
                {"id": "adm1", "name": "Admin1", "role": "admin", "enabled": True, "pin_hash": SEC.hash_pin("83920184")},
                {"id": "upl1", "name": "User1", "role": "upload", "enabled": True, "pin_hash": SEC.hash_pin("49201837")},
            ]
        }

        # 1. Attempt to delete last admin -> rejected
        ok, err = SEC.delete_account(config, "adm1")
        self.assertFalse(ok)
        self.assertIn("dernier administrateur", err)
        self.assertEqual(len(config["users"]), 2)

        # 2. Attempt to disable last admin -> rejected
        acc, err, changed = SEC.update_account(config, "adm1", enabled=False)
        self.assertIsNone(acc)
        self.assertIn("dernier administrateur", err)
        self.assertTrue(config["users"][0]["enabled"])

        # 3. Attempt to demote last admin -> rejected
        acc, err, changed = SEC.update_account(config, "adm1", role="upload")
        self.assertIsNone(acc)
        self.assertIn("dernier administrateur", err)
        self.assertEqual(config["users"][0]["role"], "admin")

        # 4. Add second admin, then demoting/deleting the first is permitted
        adm2, err = SEC.create_account(config, "Admin2", "admin", "71930284")
        self.assertIsNone(err)
        self.assertEqual(SEC.count_enabled_admins(config["users"]), 2)

        # Now demote adm1 is allowed
        acc, err, changed = SEC.update_account(config, "adm1", role="upload")
        self.assertIsNotNone(acc)
        self.assertIsNone(err)
        self.assertTrue(changed)
        self.assertEqual(SEC.count_enabled_admins(config["users"]), 1)

    def test_surgical_session_revocation(self):
        sessions = {
            "tok_adm_1": {"user_id": "usr_adm", "user": "Admin", "role": "admin", "exp": time.time() + 3600},
            "tok_adm_2": {"user_id": "usr_adm", "user": "Admin", "role": "admin", "exp": time.time() + 3600},
            "tok_upl_1": {"user_id": "usr_upl", "user": "Phone", "role": "upload", "exp": time.time() + 3600},
            "tok_leg_1": {"user_id": "", "user": "LegacyUser", "role": "upload", "exp": time.time() + 3600},
        }

        # Count before
        self.assertEqual(SEC.count_user_sessions(sessions, "usr_adm"), 2)
        self.assertEqual(SEC.count_user_sessions(sessions, "usr_upl"), 1)

        # Revoke only usr_adm
        lock = threading.Lock()
        revoked = SEC.revoke_sessions_for_user(sessions, "usr_adm", sessions_lock=lock)
        self.assertEqual(revoked, 2)
        self.assertNotIn("tok_adm_1", sessions)
        self.assertNotIn("tok_adm_2", sessions)
        self.assertIn("tok_upl_1", sessions)  # Unrelated user stays intact!
        self.assertIn("tok_leg_1", sessions)

        # Revoke legacy user by username
        revoked = SEC.revoke_sessions_for_user(sessions, "non_existent_id", username="LegacyUser", sessions_lock=lock)
        self.assertEqual(revoked, 1)
        self.assertNotIn("tok_leg_1", sessions)
        self.assertIn("tok_upl_1", sessions)

    def test_sanitize_account_for_api_never_exposes_secrets(self):
        account = {
            "id": "usr_test123",
            "name": "SecretAdmin",
            "role": "admin",
            "enabled": True,
            "pin": "plaintext-password",
            "pin_hash": "scrypt$16384$8$1$0123$4567",
            "created_at": 1700000000.0,
            "updated_at": 1700000000.0,
            "pin_updated_at": 1700000000.0,
        }
        safe = SEC.sanitize_account_for_api(account, active_sessions=3, is_current=True)
        self.assertEqual(safe["id"], "usr_test123")
        self.assertEqual(safe["name"], "SecretAdmin")
        self.assertEqual(safe["active_sessions"], 3)
        self.assertTrue(safe["is_current"])
        self.assertNotIn("pin", safe)
        self.assertNotIn("pin_hash", safe)

        serialized = json.dumps(safe)
        self.assertNotIn("plaintext-password", serialized)
        self.assertNotIn("scrypt", serialized)

    def test_webauthn_challenge_lifecycle(self):
        ch = SEC.create_webauthn_challenge(user_id="usr_abc", purpose="login")
        self.assertTrue(len(ch) >= 32)
        # Consuming it should return data
        data = SEC.consume_webauthn_challenge(ch)
        self.assertIsNotNone(data)
        self.assertEqual(data["user_id"], "usr_abc")
        self.assertEqual(data["purpose"], "login")

        # Second consumption should return None (one-time use)
        data2 = SEC.consume_webauthn_challenge(ch)
        self.assertIsNone(data2)

    def test_passkey_lifecycle_and_verification(self):
        if not SEC.HAS_WEBAUTHN_CRYPTO:
            self.skipTest("cryptography not installed")

        import base64
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        # 1. Generate keypair
        priv = ec.generate_private_key(ec.SECP256R1())
        pub_der = priv.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        pub_b64 = base64.b64encode(pub_der).decode("ascii")
        cred_id = "test_cred_id_123"

        config = {
            "users": [{"id": "usr_test", "name": "Tester", "role": "admin", "enabled": True}],
            "passkeys": [],
        }

        # 2. Register
        rec = SEC.register_passkey(config, "usr_test", cred_id, pub_b64, name="Test iPhone")
        self.assertEqual(rec["id"], cred_id)
        self.assertEqual(rec["name"], "Test iPhone")
        self.assertEqual(len(config["passkeys"]), 1)

        # Duplicate registration rejected
        with self.assertRaises(ValueError):
            SEC.register_passkey(config, "usr_test", cred_id, pub_b64)

        # 3. Listing
        listed = SEC.list_passkeys(config)
        self.assertEqual(len(listed), 1)
        self.assertNotIn("public_key", listed[0])

        # 4. Verify Assertion
        ch = SEC.create_webauthn_challenge(purpose="login")
        client_data = json.dumps({"type": "webauthn.get", "challenge": ch}).encode("utf-8")
        auth_data = b"authenticator_data_bytes_37_len!!"
        client_hash = hashlib.sha256(client_data).digest()
        signed_data = auth_data + client_hash
        sig = priv.sign(signed_data, ec.ECDSA(hashes.SHA256()))

        # Valid assertion
        matched_user = SEC.verify_passkey_assertion(config, cred_id, client_data, auth_data, sig, ch)
        self.assertIsNotNone(matched_user)
        self.assertEqual(matched_user["id"], "usr_test")

        # Bad challenge rejected
        bad_ch_user = SEC.verify_passkey_assertion(config, cred_id, client_data, auth_data, sig, "wrong_challenge")
        self.assertIsNone(bad_ch_user)

        # Bad signature rejected
        bad_sig_user = SEC.verify_passkey_assertion(config, cred_id, client_data, auth_data, b"wrong_sig", ch)
        self.assertIsNone(bad_sig_user)

        # 5. Deletion
        del_ok = SEC.delete_passkey(config, cred_id)
        self.assertTrue(del_ok)
        self.assertEqual(len(config["passkeys"]), 0)

    def test_tripwire_trigger_and_token_verification(self):
        config = {
            "secret_key": "test-secret-12345",
            "tripwire": {
                "enabled": True,
                "recipient_email": "autm_200895011@hotmail.com",
                "failed_threshold": 2,
            },
        }

        with SEC._TRIPWIRE_LOCK:
            SEC._TRIPWIRE_FAILURES.clear()
            SEC._LAST_ALERT_TIME = 0.0

        # Attempt 1 -> None
        alert1 = SEC.record_failed_attempt("192.168.1.50", "Mozilla/5.0", config, base_url="http://localhost:8765")
        self.assertIsNone(alert1)

        # Attempt 2 -> Triggers Alert!
        alert2 = SEC.record_failed_attempt("192.168.1.50", "Mozilla/5.0", config, base_url="http://localhost:8765")
        self.assertIsNotNone(alert2)
        self.assertEqual(alert2["failures"], 2)
        self.assertEqual(alert2["recipient"], "autm_200895011@hotmail.com")
        self.assertIn("emergency/lockdown?token=", alert2["action_url"])

        # Token verification
        token = alert2["token"]
        self.assertTrue(SEC.verify_lockdown_token(config, token))

        # Single-use: Second verification fails
        self.assertFalse(SEC.verify_lockdown_token(config, token))

        # Tampered token fails
        bad_token = token[:-5] + "aaaaa"
        self.assertFalse(SEC.verify_lockdown_token(config, bad_token))

    def test_emergency_lockdown_and_admin_unlock(self):
        admin_pin = "adminSecret123"
        upload_pin = "uploadSecret123"
        config = {
            "users": [
                {
                    "id": "usr_adm_1",
                    "name": "Marc-Antoine",
                    "role": "admin",
                    "enabled": True,
                    "pin_hash": SEC.hash_pin(admin_pin),
                },
                {
                    "id": "usr_upl_1",
                    "name": "UploadUser",
                    "role": "upload",
                    "enabled": True,
                    "pin_hash": SEC.hash_pin(upload_pin),
                },
            ],
            "emergency_lockdown": False,
        }

        # Engage lockdown
        self.assertFalse(SEC.is_locked_down(config))
        SEC.engage_lockdown(config)
        self.assertTrue(SEC.is_locked_down(config))

        # 1. Non-admin PIN fails to unlock
        ok, msg, user = SEC.unlock_system(config, upload_pin)
        self.assertFalse(ok)
        self.assertIsNone(user)
        self.assertTrue(SEC.is_locked_down(config))

        # 2. Wrong PIN fails to unlock
        ok, msg, user = SEC.unlock_system(config, "wrong-password")
        self.assertFalse(ok)
        self.assertIsNone(user)
        self.assertTrue(SEC.is_locked_down(config))

        # 3. Valid admin PIN unlocks!
        ok, msg, user = SEC.unlock_system(config, admin_pin)
        self.assertTrue(ok)
        self.assertIsNotNone(user)
        self.assertEqual(user["id"], "usr_adm_1")
        self.assertFalse(SEC.is_locked_down(config))


