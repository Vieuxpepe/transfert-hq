"""Multi-vault V3 HTTP boundary: /api/forge/vaults/<vid>/..., list, create, settings, migrate, and the
old /api/forge/vault/* alias. Disposable root and vault folder, fake PINs, no Forge."""

from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from PIL import Image

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_diagnostics as D  # noqa: E402
import hq_forge as F  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import hq_forge_vault as V  # noqa: E402
import iphone_bridge as B  # noqa: E402
from test_hq_forge_http import ADMIN_PIN, UPLOAD_PIN, Client  # noqa: E402

PASS = "correct horse battery"
PASS_B = "another long passphrase"
JSON = {"Content-Type": "application/json"}


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (256, 256), (20, 180, 90)).save(buffer, format="PNG")
    return buffer.getvalue()


class MultiHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="forge-mv-")
        cls.root = Path(cls.tmp) / "root"
        cls.root.mkdir()
        for name in ("Inbox", "Uni", "Print"):
            (cls.root / name).mkdir()
        shutil.copytree(SOURCE / "assets", cls.root / "assets")
        cls.saved = (B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH, dict(B.CONFIG), dict(B._DIAG_STATE))
        B.ROOT = cls.root
        B.SESSIONS_PATH = cls.root / "bridge_sessions.json"
        B.CONFIG_PATH = cls.root / "bridge_config.json"
        B.CONFIG_PATH.write_text("{}", encoding="utf-8")
        B.CONFIG.update({"pin": "", "users": [
            {"name": "admin-test", "pin": ADMIN_PIN, "role": "admin"},
            {"name": "upload-test", "pin": UPLOAD_PIN, "role": "upload"},
        ]})
        B.bind_cc_ext()
        B.bind_hq()
        D.ERRORS.clear_for_tests()
        B._DIAG_STATE.update(root=None, assets=None, last_probe=None)
        cls.logged: list[str] = []

        class Logged(B.Handler):
            def log_message(self, fmt, *args):
                cls.logged.append(fmt % args)

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Logged)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        assert cls.httpd.server_address[1] not in (8765, 8766, 8776, 7860)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        F.reset_for_tests()
        B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH = cls.saved[0], cls.saved[1], cls.saved[2]
        B.CONFIG.clear()
        B.CONFIG.update(cls.saved[3])
        B._DIAG_STATE.clear()
        B._DIAG_STATE.update(cls.saved[4])
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self) -> None:
        F.reset_for_tests()
        J.reset_for_tests()
        V.reset_for_tests()
        V.bind_session_checker(B.session_valid)
        F.set_transport_for_tests(lambda method, url, timeout, body=None: (_ for _ in ()).throw(ConnectionRefusedError()))
        self.store = Path(tempfile.mkdtemp(prefix="vault-", dir=self.tmp)) / "forge-vault"
        self.store.mkdir()
        V.set_root_for_tests(self.store)
        V.set_acl_for_tests(False)
        self.admin = Client(self.base, ADMIN_PIN)
        self.upload = Client(self.base, UPLOAD_PIN)
        self.anon = Client(self.base, None)
        type(self).logged.clear()

    def tearDown(self) -> None:
        F.set_transport_for_tests(None)
        V.reset_for_tests()

    @staticmethod
    def token(client: Client) -> str:
        return next(c.value for c in client.jar if c.name == B.COOKIE_NAME)

    def post(self, client: Client, path: str, data: dict, **kw):
        return client.json(path, "POST", data=json.dumps(data).encode("utf-8"), headers=JSON, **kw)

    def made(self, label="A", passphrase=PASS) -> str:
        return V.create_vault(B.ROOT, self.token(self.admin), passphrase, passphrase, label=label)["vault"]["id"]


class PerVaultPaths(MultiHttp):
    """V3.1: every vault operation under /api/forge/vaults/<vid>/; ids only in paths."""

    def test_unlock_import_gallery_and_lock_by_path(self):
        a, b = self.made("A"), self.made("B", PASS_B)
        base_a = "/api/forge/vaults/" + a
        self.assertEqual(self.post(self.admin, base_a + "/unlock", {"passphrase": PASS})[0], 200)
        status, _h, raw = self.admin.req(base_a + "/import", "POST", _png(), {"Content-Type": "application/octet-stream"})
        self.assertEqual(status, 201, raw)
        image_id = json.loads(raw)["id"]
        status, page = self.admin.json(base_a + "/gallery")
        self.assertEqual((status, [i["id"] for i in page["images"]]), (200, [image_id]))
        self.assertEqual(self.admin.json(base_a + "/images/" + image_id)[0], 200)
        self.assertEqual(self.admin.req(base_a + "/images/" + image_id + "/thumb")[0], 200)
        self.assertEqual(self.admin.json("/api/forge/vaults/" + b + "/status")[1]["unlocked"], False)
        self.assertEqual(self.admin.json("/api/forge/vaults/" + b + "/gallery")[0], 401)
        self.assertEqual(self.admin.json("/api/forge/vaults/" + b + "/images/" + image_id)[0], 401)
        self.assertEqual(self.post(self.admin, base_a + "/lock", {})[0], 200)
        self.assertEqual(self.admin.json(base_a + "/gallery")[0], 401)

    def test_another_vaults_image_id_is_not_found(self):
        a, b = self.made("A"), self.made("B", PASS_B)
        self.post(self.admin, "/api/forge/vaults/" + a + "/unlock", {"passphrase": PASS})
        image_id = self.admin.req("/api/forge/vaults/" + a + "/import", "POST", _png(), {"Content-Type": "application/octet-stream"})[2]
        image_id = json.loads(image_id)["id"]
        self.post(self.admin, "/api/forge/vaults/" + b + "/unlock", {"passphrase": PASS_B})
        for path in ("/images/" + image_id, "/images/" + image_id + "/original"):
            self.assertEqual(self.admin.req("/api/forge/vaults/" + b + path)[0], 404, path)
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + b + "/images/" + image_id + "/delete", {})[0], 404)

    def test_bad_or_unknown_ids_and_traversal_are_404(self):
        a = self.made("A")
        for path in ("/api/forge/vaults/vlt-ffffffffffffffff/status", "/api/forge/vaults/" + a.upper() + "/status",
                     "/api/forge/vaults/../vault/status", "/api/forge/vaults/" + a + "/../" + a + "/status",
                     "/api/forge/vaults/%2e%2e/status", "/api/forge/vaults/" + a, "/api/forge/vaults/" + a + "/",
                     "/api/forge/vaults/" + a + "/backup", "/api/forge/vaults/" + a + "/nothing"):
            with self.subTest(path=path):
                status, _h, _b = self.admin.req(path)
                self.assertIn(status, (400, 404), path)
        for path in ("/setup", "/restore", "/backup"):
            self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + a + path, {"passphrase": PASS, "confirm": PASS})[0], 404, path)


if __name__ == "__main__":
    unittest.main()