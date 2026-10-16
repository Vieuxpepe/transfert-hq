"""Private vault: Argon2id, AES-GCM, session isolation. Synthetic images only."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge as F  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import hq_forge_vault as V  # noqa: E402

PASS = "correct horse battery"


def _png() -> bytes:
    image = Image.new("RGB", (256, 256), (20, 180, 90))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _token(name: str) -> str:
    return ("session-" + name + "-0123456789abcdef").replace(" ", "")[:40]


class Vault(unittest.TestCase):
    def setUp(self) -> None:
        F.reset_for_tests()
        J.reset_for_tests()
        self.tmp = tempfile.TemporaryDirectory()
        self.hq = Path(self.tmp.name) / "hq"
        self.store = Path(self.tmp.name) / "vault"
        self.hq.mkdir()
        self.store.mkdir()
        V.set_root_for_tests(self.store)
        V.set_acl_for_tests(False)
        self.admin = _token("admin")
        self.other = _token("other")

    def tearDown(self) -> None:
        V.reset_for_tests()
        F.reset_for_tests()
        self.tmp.cleanup()

    def _setup(self) -> str:
        created = V.setup(self.hq, PASS, PASS)
        self.assertNotIn(PASS, json.dumps({k: v for k, v in created.items() if k != "recovery_key"}))
        return created["recovery_key"]

    def test_weak_and_numeric_passphrases_are_refused(self):
        for phrase in ("123456", "123456789012", "short-one", "pin"):
            with self.assertRaises(V.VaultError) as caught:
                V.setup(self.hq, phrase, phrase)
            self.assertEqual(caught.exception.code, "validation")
        self.assertFalse((self.store / "vault.json").exists())

    def test_wrong_passphrase_and_tampering_fail_closed(self):
        self._setup()
        with self.assertRaises(V.VaultError) as caught:
            V.unlock(self.hq, self.admin, "wrong horse battery")
        self.assertEqual(caught.exception.code, "passphrase")
        V.unlock(self.hq, self.admin, PASS)
        stored = V.store_image(self.hq, self.admin, _png(), None)
        path = self.store / "objects" / (stored["id"] + ".bin")
        blob = bytearray(path.read_bytes())
        blob[-1] ^= 0x01
        path.write_bytes(blob)
        with self.assertRaises(V.VaultError) as caught:
            V.detail(self.hq, self.admin, stored["id"])
        self.assertEqual(caught.exception.code, "corrupt")
        path.write_bytes(path.read_bytes()[:20])
        with self.assertRaises(V.VaultError):
            V.file_bytes(self.hq, self.admin, stored["id"], "original")

    def test_sessions_do_not_share_an_unlock(self):
        self._setup()
        V.unlock(self.hq, self.admin, PASS)
        with self.assertRaises(V.VaultError) as caught:
            V.page(self.hq, self.other)
        self.assertEqual(caught.exception.code, "locked")
        V.unlock(self.hq, self.other, PASS)
        V.lock(self.admin)
        with self.assertRaises(V.VaultError):
            V.page(self.hq, self.admin)
        self.assertEqual(V.page(self.hq, self.other)["images"], [])

    def test_expiry_logout_and_passphrase_change_drop_keys(self):
        recovery = self._setup()
        V.set_ttl_for_tests(0.05)
        V.unlock(self.hq, self.admin, PASS)
        time.sleep(0.08)
        with self.assertRaises(V.VaultError) as caught:
            V.page(self.hq, self.admin)
        self.assertEqual(caught.exception.code, "locked")
        V.set_ttl_for_tests(None)
        V.unlock(self.hq, self.admin, PASS)
        V.drop_session(self.admin)
        with self.assertRaises(V.VaultError):
            V.page(self.hq, self.admin)
        V.unlock(self.hq, self.admin, PASS)
        V.change_passphrase(self.hq, self.admin, PASS, "replacement horse", "replacement horse")
        with self.assertRaises(V.VaultError):
            V.unlock(self.hq, self.admin, PASS)
        V.unlock(self.hq, self.admin, "replacement horse")
        V.lock(self.admin)
        V.unlock_with_recovery(self.hq, self.other, recovery)
        V.change_passphrase(self.hq, self.other, "", "third horse shoe", "third horse shoe", recovery_key=recovery)
        V.unlock(self.hq, self.admin, "third horse shoe")

    def test_backup_restore_and_quota_keep_existing_objects(self):
        self._setup()
        V.unlock(self.hq, self.admin, PASS)
        first = V.store_image(self.hq, self.admin, _png(), None)
        payload = V.backup_bytes(self.hq, self.admin)
        self.assertNotIn(b"PNG", payload[:80])
        V.set_quota_for_tests(byte_cap=10, image_cap=1)
        with self.assertRaises(V.VaultError) as caught:
            V.store_image(self.hq, self.admin, _png(), None)
        self.assertEqual(caught.exception.code, "quota")
        self.assertTrue((self.store / "objects" / (first["id"] + ".bin")).is_file())
        V.set_quota_for_tests()
        V.lock_all()
        with self.assertRaises(V.VaultError):
            V.restore_backup(self.hq, self.admin, payload, "not the passphrase!!")
        V.restore_backup(self.hq, self.admin, payload, PASS)
        with self.assertRaises(V.VaultError):
            V.detail(self.hq, self.admin, first["id"])
        V.unlock(self.hq, self.admin, PASS)
        self.assertEqual(V.detail(self.hq, self.admin, first["id"])["id"], first["id"])

    def test_online_guesses_are_throttled(self):
        self._setup()
        for _ in range(5):
            with self.assertRaises(V.VaultError) as caught:
                V.unlock(self.hq, self.admin, "wrong horse battery")
            self.assertEqual(caught.exception.code, "passphrase")
        with self.assertRaises(V.VaultError) as caught:
            V.unlock(self.hq, self.admin, PASS)
        self.assertEqual(caught.exception.code, "throttled")

    def test_locked_status_has_no_inventory(self):
        self._setup()
        payload = V.status(self.hq, self.admin)
        self.assertTrue(payload["configured"])
        self.assertFalse(payload["unlocked"])
        self.assertNotIn("images", payload)
        self.assertNotIn("count", payload)
        blob = json.dumps(payload)
        self.assertNotIn(PASS, blob)
        self.assertNotIn(str(self.store), blob)

    def test_traversal_and_junction_do_not_escape(self):
        self._setup()
        V.unlock(self.hq, self.admin, PASS)
        for image_id in ("CON", "pvt-../abcdefghijkl", "pvt-" + "ab" * 12 + ":stream", "..\\pvt"):
            with self.assertRaises(V.VaultError):
                V.detail(self.hq, self.admin, image_id)
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        (outside / "marker.txt").write_text("keep", encoding="utf-8")
        objects = self.store / "objects"
        os.rmdir(objects)
        made = subprocess.run(["cmd", "/c", "mklink", "/J", str(objects), str(outside)], capture_output=True, text=True)
        if made.returncode != 0:
            self.skipTest("junction not available")
        with self.assertRaises(V.VaultError):
            V.store_image(self.hq, self.admin, _png(), None)
        self.assertEqual(list(outside.iterdir()), [outside / "marker.txt"])

    def test_private_generation_stays_disabled_and_does_not_call_forge(self):
        calls = []

        def transport(*_args, **_kwargs):
            calls.append(True)
            raise AssertionError("forge")

        code, payload = J.create_job(self.hq, {"destination": "private", "prompt": "secret"}, "idem-key-1", transport=transport)
        self.assertEqual(code, 403)
        self.assertEqual(payload["code"], "disabled")
        self.assertEqual(calls, [])
        self.assertFalse((self.hq / ".hq-forge" / "jobs.json").exists())

    def test_enabled_private_job_encrypts_and_skips_the_normal_gallery(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("forge_jobs_cases", SOURCE / "tests" / "test_hq_forge_jobs.py")
        cases = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cases)
        Transport, _body = cases.Transport, cases._body
        prompt = "zq-private-prompt-9913"
        self._setup()
        V.unlock(self.hq, self.admin, PASS)
        V.set_private_generation_for_tests(True)
        J.set_poll_interval_for_tests(0.05)
        transport = Transport()
        code, payload = J.create_job(
            self.hq, _body(prompt=prompt, destination="private"), "idem-priv-1",
            transport=transport, session_token=self.admin,
        )
        self.assertEqual(code, 202)
        deadline = time.monotonic() + 5
        job = {}
        while time.monotonic() < deadline:
            job = J.get_job(self.hq, payload["job"]["job_id"], self.admin)[1]["job"]
            if job["state"] in J.TERMINAL:
                break
            time.sleep(0.05)
        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["destination"], "private")
        self.assertFalse(job["settings"])
        raw_jobs = (self.hq / ".hq-forge" / "jobs.json").read_text(encoding="utf-8")
        self.assertNotIn(prompt, raw_jobs)
        self.assertFalse((self.hq / ".hq-forge" / "gallery").exists())
        image_id = job["images"][0]["id"]
        stored = (self.store / "objects" / (image_id + ".bin")).read_bytes()
        self.assertNotIn(prompt.encode("utf-8"), stored)
        sent = json.loads(transport.bodies[0].decode("utf-8"))
        self.assertFalse(sent["save_images"])
        self.assertFalse(any("interrupt" in url for url in transport.calls))
        hidden = J.get_job(self.hq, job["job_id"], self.other)[1]["job"]
        self.assertEqual(hidden["images"], [])
        self.assertTrue(hidden["locked"])
        V.lock(self.admin)
        with self.assertRaises(V.VaultError):
            V.file_bytes(self.hq, self.admin, image_id, "original")


if __name__ == "__main__":
    unittest.main()
