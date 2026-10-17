"""Forge Studio F1 HTTP boundary. Disposable root, fake PINs, mock Forge transport."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from http.server import ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_diagnostics as D  # noqa: E402
import hq_forge as F  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import iphone_bridge as B  # noqa: E402

ADMIN_PIN, UPLOAD_PIN = "424242", "111111"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Client:
    def __init__(self, base: str, pin: str | None) -> None:
        self.base = base
        self.jar = CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect)
        if pin:
            status, _headers, _body = self.req("/login", "POST", ("pin=" + pin).encode(), {"Content-Type": "application/x-www-form-urlencoded"})
            assert status == 303, status

    def req(self, path: str, method: str = "GET", data: bytes | None = None, headers: dict | None = None, origin: bool = True):
        hdrs = dict(headers or {})
        if origin:
            hdrs.setdefault("Origin", self.base)
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=hdrs)
        try:
            with self.op.open(request, timeout=20) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    def json(self, path: str, method: str = "GET", **kwargs):
        status, _headers, body = self.req(path, method, **kwargs)
        return status, json.loads(body.decode("utf-8"))


class ForgeHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="forge-f1-")
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
        B.CONFIG.update({
            "pin": "",
            "users": [
                {"name": "admin-test", "pin": ADMIN_PIN, "role": "admin"},
                {"name": "upload-test", "pin": UPLOAD_PIN, "role": "upload"},
            ],
        })
        B.bind_cc_ext()
        B.bind_hq()
        D.ERRORS.clear_for_tests()
        B._DIAG_STATE.update(root=None, assets=None, last_probe=None)

        class Quiet(B.Handler):
            def log_message(self, *_args):
                pass

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.admin = Client(cls.base, ADMIN_PIN)
        cls.upload = Client(cls.base, UPLOAD_PIN)
        cls.anon = Client(cls.base, None)

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
        F.set_transport_for_tests(lambda method, url, timeout: (_ for _ in ()).throw(ConnectionRefusedError()))

    def tearDown(self) -> None:
        F.set_transport_for_tests(None)

    def test_admin_status_is_offline_without_calling_a_real_forge(self):
        urls = []

        def transport(method, url, timeout):
            urls.append(url)
            raise ConnectionRefusedError()

        F.set_transport_for_tests(transport)
        status, payload = self.admin.json("/api/forge/status?upstream=http://evil.example")
        self.assertEqual(status, 200)
        self.assertEqual(payload["forge"], "offline")
        self.assertTrue(urls)
        self.assertTrue(all(url.startswith("http://127.0.0.1:7860/") for url in urls))
        self.assertNotIn("evil.example", json.dumps(payload))

    def test_upload_and_anonymous_are_rejected(self):
        self.assertEqual(self.anon.req("/api/forge/status")[0], 401)
        self.assertEqual(self.anon.req("/api/forge/catalog")[0], 401)
        self.assertEqual(self.upload.req("/api/forge/status")[0], 403)
        self.assertEqual(self.upload.req("/api/forge/catalog")[0], 403)

    def _clear_presets(self) -> None:
        path = self.root / ".hq-forge" / "presets.json"
        if path.exists():
            path.unlink()

    def test_presets_are_admin_only_and_csrf_gated(self):
        self._clear_presets()
        self.assertEqual(self.anon.req("/api/forge/presets")[0], 401)
        self.assertEqual(self.upload.req("/api/forge/presets")[0], 403)
        self.assertEqual(self.admin.req("/api/forge/presets", "POST", b"{}", origin=False)[0], 403)
        status, payload = self.admin.json("/api/forge/presets")
        self.assertEqual(status, 200)
        self.assertEqual(payload["presets"], [])
        body = json.dumps({
            "action": "create",
            "name": "Rapide",
            "kind": "technical",
            "prompt": "secret de prompt",
            "negative_prompt": "flou",
            "checkpoint": "example.safetensors [abcd]",
            "sampler_name": "Euler a",
            "scheduler": "automatic",
            "width": 512,
            "height": 512,
            "steps": 20,
            "cfg_scale": 7,
            "seed": -1,
            "n_iter": 1,
            "batch_size": 1,
        }).encode()
        created, stored = self.admin.json("/api/forge/presets", "POST", data=body, headers={"Content-Type": "application/json"})
        self.assertEqual(created, 200)
        self.assertEqual(stored["presets"][0]["prompt"], "")
        self.assertEqual(self.upload.req("/api/forge/presets", "POST", body)[0], 403)

    def _preset(self, **overrides) -> bytes:
        body = {
            "action": "create",
            "name": "Rapide",
            "kind": "technical",
            "prompt": "",
            "negative_prompt": "",
            "checkpoint": "example.safetensors [abcd]",
            "sampler_name": "Euler a",
            "scheduler": "automatic",
            "width": 512,
            "height": 512,
            "steps": 20,
            "cfg_scale": 7,
            "seed": -1,
            "n_iter": 1,
            "batch_size": 1,
        }
        body.update(overrides)
        return json.dumps(body).encode()

    def test_multiline_prompts_round_trip_over_http(self):
        self._clear_presets()
        positive = "  first line  \r\nsecond line\n"
        negative = "blur\r\nwatermark  "
        status, stored = self.admin.json(
            "/api/forge/presets", "POST",
            data=self._preset(kind="creative", name="Lignes", prompt=positive, negative_prompt=negative),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(stored["presets"][-1]["prompt"], positive)
        self.assertEqual(stored["presets"][-1]["negative_prompt"], negative)
        ident = stored["presets"][-1]["id"]
        revised = "alpha  beta\r\n\ngamma  "
        status, updated = self.admin.json(
            "/api/forge/presets", "POST",
            data=self._preset(action="update", id=ident, prompt=revised, negative_prompt="une\ndeux"),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        current = next(item for item in updated["presets"] if item["id"] == ident)
        self.assertEqual(current["prompt"], revised)
        self.assertEqual(current["negative_prompt"], "une\ndeux")
        status, listed = self.admin.json("/api/forge/presets")
        exported = next(item for item in listed["presets"] if item["id"] == ident)
        self.assertEqual(exported["prompt"], revised)
        status, removed = self.admin.json(
            "/api/forge/presets", "POST",
            data=json.dumps({"action": "delete", "id": ident}).encode(),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        status, imported = self.admin.json(
            "/api/forge/presets", "POST",
            data=json.dumps({"action": "import", "version": 1, "presets": [exported]}).encode(),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        restored = next(item for item in imported["presets"] if item["name"] == "Lignes")
        self.assertNotEqual(restored["id"], ident)
        self.assertEqual(restored["prompt"], revised)
        self.assertEqual(restored["negative_prompt"], "une\ndeux")
        status, again = self.admin.json("/api/forge/presets")
        reloaded = next(item for item in again["presets"] if item["name"] == "Lignes")
        self.assertEqual(reloaded["prompt"], revised)

    def test_http_presets_keep_multiline_negatives_and_reject_controls_and_overlong_text(self):
        self._clear_presets()
        status, technical = self.admin.json(
            "/api/forge/presets", "POST",
            data=self._preset(name="Technique lignes", prompt="first\nsecond", negative_prompt="blur\nwatermark"),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        stored = next(item for item in technical["presets"] if item["name"] == "Technique lignes")
        self.assertEqual(stored["prompt"], "")
        self.assertEqual(stored["negative_prompt"], "blur\nwatermark")
        status, creative = self.admin.json(
            "/api/forge/presets", "POST",
            data=self._preset(kind="creative", name="Créatif lignes", prompt="première\ndeuxième", negative_prompt="flou\r\ntexte"),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        creative_row = next(item for item in creative["presets"] if item["name"] == "Créatif lignes")
        self.assertEqual(creative_row["prompt"], "première\ndeuxième")
        self.assertEqual(creative_row["negative_prompt"], "flou\r\ntexte")
        for prompt in ("a\x00b", "\x01", "\x7f"):
            status, _payload = self.admin.json(
                "/api/forge/presets", "POST",
                data=self._preset(kind="creative", name="Interdit", prompt=prompt),
                headers={"Content-Type": "application/json"},
            )
            self.assertEqual(status, 400)
        status, _payload = self.admin.json(
            "/api/forge/presets", "POST",
            data=self._preset(name="Négatif interdit", negative_prompt="blur\x00watermark"),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)
        status, _payload = self.admin.json(
            "/api/forge/presets", "POST",
            data=self._preset(name="Nom\nligne", prompt="ok"),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)
        status, accepted = self.admin.json(
            "/api/forge/presets", "POST",
            data=self._preset(kind="creative", name="Pile", prompt=("x" * 1999) + "\n", negative_prompt="y" * 1000),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(len(next(item for item in accepted["presets"] if item["name"] == "Pile")["prompt"]), 2000)
        status, _payload = self.admin.json(
            "/api/forge/presets", "POST",
            data=self._preset(kind="creative", name="Trop long", prompt=("x" * 2000) + "\n"),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)
        status, _payload = self.admin.json(
            "/api/forge/presets", "POST",
            data=self._preset(name="Négatif trop long", negative_prompt=("y" * 999) + "\r\n"),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)

    def test_post_is_csrf_gated_and_empty_generation_is_rejected(self):
        self.assertEqual(self.admin.req("/api/forge/status", "POST", b"{}", origin=False)[0], 403)
        self.assertEqual(self.admin.req("/api/forge/jobs", "POST", b"{}", {"Origin": "http://evil.example"}, origin=False)[0], 403)
        self.assertEqual(self.admin.req("/api/forge/jobs", "POST", b"{}")[0], 400)
        self.assertEqual(self.admin.req("/api/forge/jobs/job-1/cancel", "POST", b"{}")[0], 404)

    def test_readiness_does_not_depend_on_forge(self):
        self.assertNotIn("hq_forge", D.REQUIRED_MODULES)
        status, _headers, body = self.admin.req("/api/diag/ready")
        payload = json.loads(body.decode("utf-8"))
        self.assertIn(status, (200, 503))
        self.assertNotIn("forge", payload.get("checks", {}))
        self.assertNotIn("forge", payload.get("summary", "").lower())

    def test_catalog_response_has_no_filename(self):
        def transport(method, url, timeout):
            if url.endswith("/sdapi/v1/sd-models"):
                body = [{"title": "example", "model_name": "example", "hash": "abcd", "sha256": None, "filename": r"C:\hidden\a.safetensors"}]
            elif url.endswith("/sdapi/v1/samplers"):
                body = [{"name": "Euler", "aliases": []}]
            elif url.endswith("/sdapi/v1/schedulers"):
                body = [{"name": "automatic", "label": "Automatic"}]
            else:
                raise AssertionError(url)
            return 200, json.dumps(body).encode("utf-8")

        F.set_transport_for_tests(transport)
        status, payload = self.admin.json("/api/forge/catalog")
        self.assertEqual(status, 200)
        self.assertNotIn("filename", json.dumps(payload))
        self.assertNotIn("hidden", json.dumps(payload))
        self.assertEqual(payload["models"][0]["title"], "example")

    def test_vault_is_admin_only_and_locked_until_its_own_secret(self):
        import hq_forge_vault as vault
        vault.set_root_for_tests(Path(self.tmp) / "vault")
        vault.set_acl_for_tests(False)
        self.assertEqual(self.anon.req("/api/forge/vault/status")[0], 401)
        self.assertEqual(self.upload.req("/api/forge/vault/status")[0], 403)
        self.assertEqual(self.admin.req("/api/forge/vault/setup", "POST", b"{}", origin=False)[0], 403)
        status, payload = self.admin.json("/api/forge/vault/status")
        self.assertEqual(status, 200)
        self.assertFalse(payload["configured"])
        self.assertNotIn("images", payload)
        self.assertTrue(payload["private_generation"])
        refused, body = self.admin.json("/api/forge/vault/setup", "POST", data=json.dumps({"passphrase": "123456", "confirm": "123456"}).encode())
        self.assertEqual(refused, 400)
        self.assertNotIn("recovery_key", body)
        created_status, created, headers = self._vault_setup()
        self.assertEqual(created_status, 201)
        self.assertIn("recovery_key", created)
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        locked, _locked_body = self.admin.json("/api/forge/vault/gallery")
        self.assertEqual(locked, 401)
        other = Client(self.base, ADMIN_PIN)
        opened, _opened = self.admin.json("/api/forge/vault/unlock", "POST", data=json.dumps({"passphrase": "correct horse battery"}).encode())
        self.assertEqual(opened, 200)
        denied, _denied = other.json("/api/forge/vault/gallery")
        self.assertEqual(denied, 401)
        self.admin.json("/api/forge/vault/lock", "POST", data=b"{}")
        again, _again = self.admin.json("/api/forge/vault/gallery")
        self.assertEqual(again, 401)
        self.admin.json("/api/forge/vault/unlock", "POST", data=json.dumps({"passphrase": "correct horse battery"}).encode())
        changed, changed_body = self.admin.json(
            "/api/forge/vault/passphrase", "POST",
            data=json.dumps({
                "current": "correct horse battery",
                "passphrase": "replacement horse",
                "confirm": "replacement horse",
            }).encode(),
        )
        self.assertEqual(changed, 200)
        self.assertTrue(changed_body["recovery_key_unchanged"])
        self.assertNotIn("recovery_key", changed_body)
        token = next(cookie.value for cookie in self.admin.jar if cookie.name == "transfert_session")
        saved = B.CONFIG.get("auth_generation")
        try:
            B.CONFIG["auth_generation"] = int(saved or 0) + 1
            self.assertIsNone(B.session_info(token))
            self.assertEqual(self.admin.req("/api/forge/vault/gallery")[0], 401)
        finally:
            B.CONFIG["auth_generation"] = saved

    def _vault_setup(self):
        status, headers, body = self.admin.req(
            "/api/forge/vault/setup", "POST",
            json.dumps({"passphrase": "correct horse battery", "confirm": "correct horse battery"}).encode(),
            {"Content-Type": "application/json"},
        )
        return status, json.loads(body.decode("utf-8")), {key: value for key, value in headers.items()}


if __name__ == "__main__":
    unittest.main()
