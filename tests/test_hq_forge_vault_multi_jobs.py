"""Multi-vault V2.4: a private job or private retouch goes to a named vault that is already open
in this session, never to "the last used". Mock Forge, temp folders only."""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_forge_inpaint as I  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import hq_forge_vault as V  # noqa: E402
from test_hq_forge_inpaint import IDLE, Base, png, settings  # noqa: E402
from test_hq_forge_jobs import Transport, _body  # noqa: E402
from test_hq_forge_vault import PASS, _token  # noqa: E402

PASS_B = "another long passphrase"


class Destination(Base):
    def setUp(self) -> None:
        super().setUp()
        V.set_private_generation_for_tests(True)
        J.set_poll_interval_for_tests(0.05)
        self.token = _token("admin")
        self.a = V.create_vault(self.root, self.token, PASS, PASS, label="A")["vault"]["id"]
        self.b = V.create_vault(self.root, self.token, PASS_B, PASS_B, label="B")["vault"]["id"]

    def objects(self, vid):
        folder = self.store / "vaults" / vid / "objects"
        return sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []

    def wait_job(self, job_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = J.get_job(self.root, job_id, self.token)[1]["job"]
            if job["state"] in J.TERMINAL:
                return job
            time.sleep(0.05)
        self.fail("job did not finish")

    def test_job_goes_to_the_named_open_vault(self):
        V.unlock(self.root, self.token, PASS_B, vid=self.b)
        code, payload = J.create_job(self.root, {**_body(destination="private"), "vault": self.b}, "idem-mv-1",
                                     transport=Transport(), session_token=self.token)
        self.assertEqual(code, 202, payload)
        job = self.wait_job(payload["job"]["job_id"])
        self.assertEqual(job["state"], "completed", job)
        self.assertEqual(len(job["images"]), 1)
        self.assertEqual(self.objects(self.b), [job["images"][0]["id"] + ".bin"])
        self.assertEqual(self.objects(self.a), [])
        raw_jobs = (self.root / ".hq-forge" / "jobs.json").read_text(encoding="utf-8")
        self.assertNotIn(self.b, raw_jobs)  # the destination is kept in memory only

    def test_named_vault_must_be_the_open_one(self):
        V.unlock(self.root, self.token, PASS_B, vid=self.b)
        transport = Transport()
        code, payload = J.create_job(self.root, {**_body(destination="private"), "vault": self.a}, "idem-mv-2",
                                     transport=transport, session_token=self.token)
        self.assertEqual((code, payload["code"]), (401, "locked"))
        self.assertEqual(transport.bodies, [])
        self.assertEqual(self.objects(self.a) + self.objects(self.b), [])

    def test_no_silent_default_once_there_are_vaults(self):
        V.unlock(self.root, self.token, PASS, vid=self.a)
        transport = Transport()
        code, payload = J.create_job(self.root, _body(destination="private"), "idem-mv-3", transport=transport, session_token=self.token)
        self.assertEqual((code, payload["code"]), (409, "use_vaults"))
        self.assertEqual(transport.bodies, [])

    def test_bad_vault_fields(self):
        V.unlock(self.root, self.token, PASS, vid=self.a)
        for value, expected in (("../" + self.a, 400), (7, 400), ("vlt-ffffffffffffffff", 404)):
            with self.subTest(value=value):
                code, payload = J.create_job(self.root, {**_body(destination="private"), "vault": value}, "idem-mv-%d" % expected,
                                             transport=Transport(), session_token=self.token)
                self.assertEqual(code, expected, payload)
        code, _payload = J.create_job(self.root, {**_body(destination="normal"), "vault": self.a}, "idem-mv-n",
                                      transport=Transport(), session_token=self.token)
        self.assertEqual(code, 400)

    def test_private_retouch_writes_to_the_source_vault(self):
        V.unlock(self.root, self.token, PASS_B, vid=self.b)
        source = V.store_image(self.root, self.token, png(), settings(), vid=self.b)["id"]
        status, payload = I.create(self.root, self.body({"kind": "private", "id": source, "vault": self.b}), self.token,
                                   transport=Transport(progress=IDLE))
        self.assertEqual(status, 202, payload)
        done = self.wait(payload["inpaint"]["id"])
        self.assertEqual(done["state"], "completed", done)
        self.assertIn(done["image_id"] + ".bin", self.objects(self.b))
        self.assertEqual(self.objects(self.a), [])

    def test_private_retouch_refusals(self):
        V.unlock(self.root, self.token, PASS_B, vid=self.b)
        source = V.store_image(self.root, self.token, png(), settings(), vid=self.b)["id"]
        cases = [
            ({"kind": "private", "id": source}, 409),                    # no vault named: no default
            ({"kind": "private", "id": source, "vault": self.a}, 401),   # A is not open
            ({"kind": "private", "id": source, "vault": "x"}, 400),
            ({"kind": "normal", "id": "img-" + "0" * 24, "vault": self.b}, 400),
        ]
        for src, expected in cases:
            with self.subTest(src=src):
                status, payload = I.create(self.root, self.body(src), self.token, transport=Transport(progress=IDLE))
                self.assertEqual(status, expected, payload)
        V.unlock(self.root, self.token, PASS, vid=self.a)
        status, payload = I.create(self.root, self.body({"kind": "private", "id": source, "vault": self.a}), self.token,
                                   transport=Transport(progress=IDLE))
        self.assertEqual(status, 404, payload)  # B's image id is unknown in A


if __name__ == "__main__":
    unittest.main()