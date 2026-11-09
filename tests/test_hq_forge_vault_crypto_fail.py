"""Tests verifying fail-closed cryptographic security in hq_forge_vault.

Ensures that if cryptographic dependencies (AESGCM, Argon2id) are missing,
all vault operations fail explicitly with VaultError("no_crypto"), returning HTTP 503,
without ever creating unencrypted files, leaking plaintext, or weakening security.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import hq_forge_vault as vault


class VaultCryptoFailClosedTests(unittest.TestCase):
    def setUp(self) -> None:
        vault.reset_for_tests()
        self.tmp = tempfile.TemporaryDirectory(prefix="vault-crypto-test-")
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        vault.reset_for_tests()
        self.tmp.cleanup()

    def test_crypto_available_when_libraries_present(self) -> None:
        self.assertTrue(vault.crypto_available())

    def test_require_crypto_raises_when_aesgcm_missing(self) -> None:
        with patch.object(vault, "AESGCM", None):
            self.assertFalse(vault.crypto_available())
            with self.assertRaises(vault.VaultError) as ctx:
                vault._require_crypto()
            self.assertEqual(ctx.exception.code, "no_crypto")

    def test_require_crypto_raises_when_argon2id_missing(self) -> None:
        with patch.object(vault, "Argon2id", None):
            self.assertFalse(vault.crypto_available())
            with self.assertRaises(vault.VaultError) as ctx:
                vault._require_crypto()
            self.assertEqual(ctx.exception.code, "no_crypto")

    def test_seal_and_open_fail_closed_without_crypto(self) -> None:
        with patch.object(vault, "AESGCM", None):
            with self.assertRaises(vault.VaultError) as ctx:
                vault._seal(b"0" * 32, b"hello", b"aad")
            self.assertEqual(ctx.exception.code, "no_crypto")

            with self.assertRaises(vault.VaultError) as ctx:
                vault._open(b"0" * 32, b"0" * 32, b"aad")
            self.assertEqual(ctx.exception.code, "no_crypto")

    def test_derive_fails_closed_without_crypto(self) -> None:
        params = {
            "name": "argon2id",
            "salt": "AAAAAAAAAAAAAAAAAAAAAA==",
            "iterations": vault.KDF_TIME,
            "lanes": vault.KDF_LANES,
            "memory_cost": vault.KDF_MEMORY,
            "length": vault.KDF_LENGTH,
        }
        with patch.object(vault, "Argon2id", None):
            with self.assertRaises(vault.VaultError) as ctx:
                vault._derive(params, b"secret")
            self.assertEqual(ctx.exception.code, "no_crypto")

    def test_create_vault_fails_closed_without_crypto_and_writes_no_files(self) -> None:
        with patch.object(vault, "AESGCM", None):
            with self.assertRaises(vault.VaultError) as ctx:
                vault.create_vault(self.root, "test-token", "myPassphrase123!", "myPassphrase123!", label="Private")
            self.assertEqual(ctx.exception.code, "no_crypto")
        # Ensure no vault directory was initialized
        vaults_dir = self.root / ".hq-vault" / "vaults"
        self.assertFalse(vaults_dir.exists())

    def test_unlock_fails_closed_without_crypto(self) -> None:
        with patch.object(vault, "Argon2id", None):
            with self.assertRaises(vault.VaultError) as ctx:
                vault.unlock(self.root, "test-token", "myPassphrase123!")
            self.assertEqual(ctx.exception.code, "no_crypto")

    def test_unlock_with_recovery_fails_closed_without_crypto(self) -> None:
        with patch.object(vault, "AESGCM", None):
            with self.assertRaises(vault.VaultError) as ctx:
                vault.unlock_with_recovery(self.root, "test-token", "AAAA-BBBB-CCCC")
            self.assertEqual(ctx.exception.code, "no_crypto")

    def test_http_status_and_public_error_mapping(self) -> None:
        self.assertEqual(vault.http_status("no_crypto"), 503)
        msg = vault.public_error("no_crypto")
        self.assertIn("chiffrement", msg.lower())


if __name__ == "__main__":
    unittest.main()
