"""Multi-vault V4 HTTP: the migration screen's routes for the single pre-migration vault, the offer
bound to one unlock, and the global lock. Disposable root and vault folder, fake PINs, no Forge."""

from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_hq_forge_vault_multi_http import JSON, PASS, PASS_B, B, V, MultiHttp  # noqa: E402

M = "/api/forge/vaults/migration"


class MigrationRoutes(MultiHttp):
    def legacy(self) -> None:
        V.setup(B.ROOT, PASS, PASS)

    def test_status_backup_then_migrate_in_one_unlock(self):
        self.legacy()
        status, info = self.admin.json(M)
        self.assertEqual((status, info), (200, {"layout": "legacy", "configured": True, "unlocked": False}))
        self.assertEqual(self.admin.req(M + "/backup")[0], 401)
        self.assertEqual(self.post(self.admin, M + "/unlock", {"passphrase": "wrong but long enough"})[0], 401)
        self.assertEqual(self.post(self.admin, M + "/unlock", {"passphrase": PASS})[0], 200)
        self.assertTrue(self.admin.json(M)[1]["unlocked"])
        status, headers, raw = self.admin.req(M + "/backup")
        self.assertEqual(status, 200)
        self.assertIn("vault.json", zipfile.ZipFile(io.BytesIO(raw)).namelist())
        self.assertEqual(V.layout(B.ROOT), "legacy")  # the download alone never migrates
        status, done = self.post(self.admin, "/api/forge/vaults/migrate", {})
        self.assertEqual(status, 200, done)
        self.assertTrue(done["migrated"])
        self.assertEqual(self.admin.json(M)[1], {"layout": "multi", "configured": False, "unlocked": False})
        self.assertEqual(self.admin.req(M + "/backup")[0], 404)
        self.assertEqual(self.post(self.admin, M + "/unlock", {"passphrase": PASS})[0], 404)
        listing = self.admin.json("/api/forge/vaults")[1]
        self.assertEqual([v["id"] for v in listing["vaults"]], [done["vid"]])

    def test_locking_cancels_the_offer(self):
        self.legacy()
        self.post(self.admin, M + "/unlock", {"passphrase": PASS})
        self.assertEqual(self.admin.req(M + "/backup")[0], 200)
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/lock", {})[0], 200)
        status, body = self.post(self.admin, "/api/forge/vaults/migrate", {})
        self.assertEqual((status, body["code"]), (401, "locked"))
        self.post(self.admin, M + "/unlock", {"passphrase": PASS})
        status, body = self.post(self.admin, "/api/forge/vaults/migrate", {})
        self.assertEqual((status, body["code"]), (409, "backup_first"))  # a new unlock needs a new offer
        self.assertEqual(V.layout(B.ROOT), "legacy")

    def test_idle_auto_lock_cancels_the_offer(self):
        self.legacy()
        self.post(self.admin, M + "/unlock", {"passphrase": PASS})
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/backup-offer", {})[0], 200)
        V._sessions[self.token(self.admin)]["expires"] = 0.0  # the 5 min idle TTL ran out
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/migrate", {})[1]["code"], "locked")
        self.post(self.admin, M + "/unlock", {"passphrase": PASS})
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/migrate", {})[1]["code"], "backup_first")
        self.assertEqual(V.layout(B.ROOT), "legacy")

    def test_the_offer_expires_after_fifteen_minutes(self):
        self.legacy()
        self.post(self.admin, M + "/unlock", {"passphrase": PASS})
        self.admin.req(M + "/backup")
        V._backup_offers[self.token(self.admin)] -= V.BACKUP_OFFER_TTL_SEC + 1
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/migrate", {})[1]["code"], "backup_first")

    def test_recovery_key_opens_the_single_vault(self):
        recovery = V.setup(B.ROOT, PASS, PASS)["recovery_key"]
        self.assertEqual(self.post(self.admin, M + "/recover", {"recovery_key": "nope"})[0], 401)
        self.assertEqual(self.post(self.admin, M + "/recover", {"recovery_key": recovery})[0], 200)
        self.assertTrue(self.admin.json(M)[1]["unlocked"])

    def test_global_lock_closes_a_listed_vault(self):
        vid = self.made("A")
        self.post(self.admin, "/api/forge/vaults/" + vid + "/unlock", {"passphrase": PASS})
        self.assertEqual(self.admin.json("/api/forge/vaults")[1]["open"], vid)
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/lock", {})[0], 200)
        self.assertIsNone(self.admin.json("/api/forge/vaults")[1]["open"])
        self.assertEqual(self.admin.json("/api/forge/vaults/" + vid + "/gallery")[0], 401)

    def test_empty_install_has_no_migration(self):
        self.assertEqual(self.admin.json(M)[1]["layout"], "empty")
        self.assertEqual(self.admin.req(M + "/backup")[0], 404)

    def test_secrets_never_logged(self):
        self.legacy()
        self.post(self.admin, M + "/unlock", {"passphrase": PASS})
        self.admin.req(M + "/backup")
        logged = "\n".join(type(self).logged)
        self.assertIn(M, logged)
        self.assertNotIn(PASS, logged)
        self.assertNotIn("passphrase", logged)


class MigrationAuthorisation(MultiHttp):
    def test_matrix(self):
        V.setup(B.ROOT, PASS, PASS)
        body = json.dumps({"passphrase": PASS}).encode()
        for path in (M, M + "/backup"):
            with self.subTest(get=path):
                self.assertEqual(self.anon.req(path)[0], 401)
                self.assertEqual(self.upload.req(path)[0], 403)
        for path in ("/api/forge/vaults/lock", M + "/unlock", M + "/recover"):
            with self.subTest(post=path):
                self.assertEqual(self.anon.req(path, "POST", body, JSON)[0], 401)
                self.assertEqual(self.upload.req(path, "POST", body, JSON)[0], 403)
                self.assertEqual(self.admin.req(path, "POST", body, JSON, origin=False)[0], 403)
                self.assertEqual(self.admin.req(path, "POST", body, {**JSON, "Origin": "http://evil.example"})[0], 403)
        self.assertFalse(self.admin.json(M)[1]["unlocked"])  # no refused call opened the vault

    def test_unknown_paths(self):
        V.setup(B.ROOT, PASS, PASS)
        for path in (M + "/", M + "/status", M + "/gallery", M + "/images/pvt-" + "0" * 24):
            with self.subTest(get=path):
                self.assertEqual(self.admin.req(path)[0], 404)
        for path in (M, M + "/backup", M + "/lock", M + "/import", M + "/setup"):
            with self.subTest(post=path):
                self.assertEqual(self.post(self.admin, path, {"passphrase": PASS})[0], 404)


if __name__ == "__main__":
    import unittest
    unittest.main()