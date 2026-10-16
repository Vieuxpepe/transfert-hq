"""Private vault: Argon2id, AES-GCM, session isolation. Synthetic images only."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zipfile
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
        V.bind_session_checker(None)
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

    def test_new_session_and_logout_do_not_reset_the_guess_budget(self):
        self._setup()
        for _ in range(5):
            with self.assertRaises(V.VaultError) as caught:
                V.unlock(self.hq, self.admin, "wrong horse battery")
            self.assertEqual(caught.exception.code, "passphrase")
        V.drop_session(self.admin)
        with self.assertRaises(V.VaultError) as caught:
            V.unlock(self.hq, self.other, PASS)
        self.assertEqual(caught.exception.code, "throttled")

    def test_concurrent_guesses_share_one_budget_and_the_map_stays_bounded(self):
        self._setup()
        codes = []
        lock = threading.Lock()

        def guess(index: int) -> None:
            try:
                V.unlock(self.hq, _token(f"c{index:02d}"), "wrong horse battery")
            except V.VaultError as exc:
                with lock:
                    codes.append(exc.code)

        threads = [threading.Thread(target=guess, args=(index,)) for index in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(codes), 8)
        self.assertLessEqual(codes.count("passphrase"), 5)
        self.assertGreaterEqual(codes.count("throttled"), 1)
        for index in range(40):
            try:
                V.unlock(self.hq, _token(f"g{index:02d}"), "wrong horse battery")
            except V.VaultError:
                pass
        self.assertLessEqual(V.failure_slots_for_tests(), 32)

    def test_revoked_session_and_retain_only_drop_unlock_keys(self):
        self._setup()
        V.unlock(self.hq, self.admin, PASS)
        V.unlock(self.hq, self.other, PASS)
        live = {self.admin, self.other}
        V.bind_session_checker(lambda token: token in live)
        self.assertEqual(V.page(self.hq, self.admin)["images"], [])
        live.remove(self.admin)
        with self.assertRaises(V.VaultError) as caught:
            V.page(self.hq, self.admin)
        self.assertEqual(caught.exception.code, "locked")
        V.retain_only(set(live))
        self.assertEqual(V.page(self.hq, self.other)["images"], [])

    def test_passphrase_change_keeps_recovery_and_rotation_revokes_it(self):
        recovery = self._setup()
        before = json.loads((self.store / "vault.json").read_text(encoding="utf-8"))["recovery"]["wrap"]
        V.unlock(self.hq, self.admin, PASS)
        changed = V.change_passphrase(self.hq, self.admin, PASS, "replacement horse", "replacement horse")
        after = json.loads((self.store / "vault.json").read_text(encoding="utf-8"))["recovery"]["wrap"]
        self.assertEqual(before, after)
        self.assertTrue(changed["recovery_key_unchanged"])
        self.assertNotIn("recovery_key", changed)
        V.unlock(self.hq, self.admin, "replacement horse")
        rotated = V.rotate_recovery(self.hq, self.admin, "replacement horse")
        renewed = json.loads((self.store / "vault.json").read_text(encoding="utf-8"))["recovery"]["wrap"]
        self.assertNotEqual(before, renewed)
        self.assertEqual(rotated["previous_recovery_key"], "revoked")
        with self.assertRaises(V.VaultError) as caught:
            V.unlock_with_recovery(self.hq, self.other, recovery)
        self.assertEqual(caught.exception.code, "passphrase")
        V.unlock_with_recovery(self.hq, self.other, rotated["recovery_key"])
        V.lock(self.other)
        V.unlock(self.hq, self.admin, "replacement horse")

    def test_zip_limits_leave_the_original_vault(self):
        self._setup()
        V.unlock(self.hq, self.admin, PASS)
        stored = V.store_image(self.hq, self.admin, _png(), None)
        many = io.BytesIO()
        with zipfile.ZipFile(many, "w") as archive:
            archive.writestr("vault.json", b"{}")
            for index in range(500):
                archive.writestr(f"objects/pvt-{index:024x}.bin", b"x")
        with self.assertRaises(V.VaultError) as caught:
            V.restore_backup(self.hq, self.admin, many.getvalue(), PASS)
        self.assertEqual(caught.exception.code, "validation")
        huge = io.BytesIO()
        with zipfile.ZipFile(huge, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("vault.json", b"\0" * (2 * 1024 * 1024))
        with self.assertRaises(V.VaultError) as caught:
            V.restore_backup(self.hq, self.admin, huge.getvalue(), PASS)
        self.assertEqual(caught.exception.code, "validation")
        self.assertEqual(len(list((self.store / "objects").glob("*.bin"))), 1)
        self.assertEqual(V.detail(self.hq, self.admin, stored["id"])["id"], stored["id"])

    def test_restore_and_write_faults_keep_committed_data(self):
        self._setup()
        V.unlock(self.hq, self.admin, PASS)
        first = V.store_image(self.hq, self.admin, _png(), None)
        payload = V.backup_bytes(self.hq, self.admin)
        second = V.store_image(self.hq, self.admin, _png(), None)
        for fault in ("before_retire", "after_retire"):
            V.set_restore_fault_for_tests(fault)
            with self.assertRaises(V.VaultError) as caught:
                V.restore_backup(self.hq, self.admin, payload, PASS)
            self.assertEqual(caught.exception.code, "corrupt")
            V.set_restore_fault_for_tests(None)
            self.assertEqual(V.detail(self.hq, self.admin, first["id"])["id"], first["id"])
            self.assertEqual(V.detail(self.hq, self.admin, second["id"])["id"], second["id"])
        V.set_restore_fault_for_tests("after_promote")
        with self.assertRaises(V.VaultError):
            V.restore_backup(self.hq, self.admin, payload, PASS)
        V.set_restore_fault_for_tests(None)
        previous = self.store.with_name(self.store.name + ".previous")
        self.assertTrue((previous / "objects" / (second["id"] + ".bin")).is_file())
        self.assertEqual(V.detail(self.hq, self.admin, first["id"])["id"], first["id"])
        with self.assertRaises(V.VaultError):
            V.detail(self.hq, self.admin, second["id"])
        V.set_write_fault_for_tests("replace")
        with self.assertRaises(V.VaultError) as caught:
            V.store_image(self.hq, self.admin, _png(), None)
        self.assertEqual(caught.exception.code, "disk")
        V.set_write_fault_for_tests("fsync")
        with self.assertRaises(V.VaultError) as caught:
            V.change_passphrase(self.hq, self.admin, PASS, "replacement horse", "replacement horse")
        self.assertEqual(caught.exception.code, "disk")
        V.set_write_fault_for_tests(None)
        self.assertFalse(list(self.store.rglob("*.partial")))
        V.lock(self.admin)
        V.unlock(self.hq, self.admin, PASS)
        self.assertEqual(V.detail(self.hq, self.admin, first["id"])["id"], first["id"])

    def test_cleanup_does_not_follow_junctions_or_drop_a_crash_copy(self):
        self._setup()
        V.unlock(self.hq, self.admin, PASS)
        stored = V.store_image(self.hq, self.admin, _png(), None)
        outside = Path(self.tmp.name) / "outside-staging"
        outside.mkdir()
        (outside / "marker.txt").write_text("keep", encoding="utf-8")
        staging = self.store.with_name(self.store.name + ".restore")
        made = subprocess.run(["cmd", "/c", "mklink", "/J", str(staging), str(outside)], capture_output=True, text=True)
        if made.returncode != 0:
            self.skipTest("junction not available")
        with self.assertRaises(V.VaultError) as caught:
            V.restore_backup(self.hq, self.admin, b"PK\x03\x04" + b"x" * 32, PASS)
        self.assertEqual(caught.exception.code, "bad_root")
        V.cleanup_partials(self.hq)
        self.assertEqual((outside / "marker.txt").read_text(encoding="utf-8"), "keep")
        self.assertEqual(V.detail(self.hq, self.admin, stored["id"])["id"], stored["id"])
        os.rmdir(staging)
        parent = Path(self.tmp.name) / "linked-parent"
        real = Path(self.tmp.name) / "real-target"
        real.mkdir()
        (real / "marker.txt").write_text("keep", encoding="utf-8")
        made = subprocess.run(["cmd", "/c", "mklink", "/J", str(parent), str(real)], capture_output=True, text=True)
        if made.returncode != 0:
            self.skipTest("junction not available")
        V.set_root_for_tests(parent / "forge-vault")
        with self.assertRaises(V.VaultError) as caught:
            V.setup(self.hq, PASS, PASS)
        self.assertEqual(caught.exception.code, "bad_root")
        self.assertFalse((real / "forge-vault").exists())
        self.assertEqual((real / "marker.txt").read_text(encoding="utf-8"), "keep")

    def test_cleanup_keeps_previous_when_the_live_header_is_gone(self):
        self._setup()
        previous = self.store.with_name(self.store.name + ".previous")
        previous.mkdir()
        (previous / "keep.txt").write_text("keep", encoding="utf-8")
        V.cleanup_partials(self.hq)
        self.assertFalse(previous.exists())
        previous.mkdir()
        (previous / "keep.txt").write_text("keep", encoding="utf-8")
        (self.store / "vault.json").unlink()
        V.cleanup_partials(self.hq)
        self.assertEqual((previous / "keep.txt").read_text(encoding="utf-8"), "keep")


if __name__ == "__main__":
    unittest.main()
