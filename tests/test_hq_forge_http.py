"""Forge Studio F1 HTTP boundary. Disposable root, fake PINs, mock Forge transport."""

from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from http.server import ThreadingHTTPServer
from pathlib import Path

from PIL import Image

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_diagnostics as D  # noqa: E402
import hq_forge as F  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import iphone_bridge as B  # noqa: E402
from unittest import mock

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
        # This class shares one root across its tests: leave each one a clean normal gallery.
        import hq_forge_gallery as gallery
        base = gallery.gallery_dir(self.root)
        for child in list(base.iterdir()) if base.is_dir() else []:
            if child.is_dir() and gallery.IMG_RE.fullmatch(child.name):
                shutil.rmtree(child, ignore_errors=True)

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

    def test_start_now_route_is_admin_only_and_csrf_gated(self):
        path = "/api/forge/jobs/job-" + "0" * 24 + "/start-now"
        self.assertEqual(self.anon.req(path, "POST", b"{}")[0], 401)
        self.assertEqual(self.upload.req(path, "POST", b"{}")[0], 403)
        self.assertEqual(self.admin.req(path, "POST", b"{}", {"Origin": "http://evil.example"}, origin=False)[0], 403)
        self.assertEqual(self.admin.req(path, "POST", b"{}")[0], 404)

    def test_triage_route_is_admin_only_csrf_gated_and_404_for_unknown(self):
        path = "/api/forge/gallery/img-" + "0" * 24 + "/triage"
        body = b'{"state": "keep"}'
        self.assertEqual(self.anon.req(path, "POST", body)[0], 401)
        self.assertEqual(self.upload.req(path, "POST", body)[0], 403)
        self.assertEqual(self.admin.req(path, "POST", body, {"Origin": "http://evil.example"}, origin=False)[0], 403)
        self.assertEqual(self.admin.req(path, "POST", body)[0], 404)
        self.assertEqual(self.admin.req("/api/forge/gallery/../triage", "POST", body)[0] in (400, 404), True)

    def test_gallery_backup_is_admin_only_and_restores_into_the_same_quota(self):
        import hq_forge_gallery as gallery
        gallery.reset_for_tests()
        buffer = io.BytesIO()
        Image.new("RGB", (64, 64), (3, 4, 5)).save(buffer, format="PNG")
        settings = {"prompt": "sauvegarde", "negative_prompt": "", "checkpoint": "example.safetensors",
                    "sampler_name": "Euler", "scheduler": "automatic", "width": 512, "height": 512, "steps": 4,
                    "cfg_scale": 5.0, "seed": 1, "n_iter": 1, "batch_size": 1}
        saved = gallery.store(self.root, buffer.getvalue(), settings)
        self.assertEqual(self.anon.req("/api/forge/gallery/export")[0], 401)
        self.assertEqual(self.upload.req("/api/forge/gallery/export")[0], 403)
        self.assertEqual(self.anon.req("/api/forge/gallery/export/plan")[0], 401)
        status, _plan_headers, plan_body = self.admin.req("/api/forge/gallery/export/plan")
        self.assertEqual(status, 200)
        plan = json.loads(plan_body.decode("utf-8"))
        self.assertEqual(plan["images"], 1)
        self.assertGreater(plan["bytes"], 0)
        self.assertTrue(plan["allowed"])
        status, headers, blob = self.admin.req("/api/forge/gallery/export")
        self.assertEqual(status, 200)
        self.assertIn("application/zip", headers.get("Content-Type", ""))
        self.assertEqual(int(headers.get("Content-Length")), len(blob))
        self.assertTrue(blob.startswith(b"PK"))
        # The archive is streamed from a temporary file, then removed: no 2 GiB copy stays behind.
        exports = Path(self.root) / ".hq-forge" / "exports"
        deadline = time.time() + 5
        while list(exports.glob("export-*.zip")) and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(list(exports.glob("export-*.zip")), [])
        self.assertEqual(self.anon.req("/api/forge/gallery/import", "POST", blob, {"Content-Type": "application/zip"})[0], 401)
        self.assertEqual(self.admin.req("/api/forge/gallery/import", "POST", b"nope", {"Content-Type": "application/zip"})[0], 400)
        gallery.delete(self.root, saved["id"])
        status, _headers, body = self.admin.req("/api/forge/gallery/import", "POST", blob, {"Content-Type": "application/zip"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body.decode("utf-8"))["imported"], 1)
        self.assertEqual(len(gallery.page(self.root)["images"]), 1)

    def test_gallery_restore_refuses_atomically_and_verify_does_not_import(self):
        import hq_forge_gallery as gallery
        gallery.reset_for_tests()
        self.addCleanup(gallery.reset_for_tests)
        base = gallery.gallery_dir(self.root)
        for child in list(base.iterdir()) if base.is_dir() else []:
            if child.is_dir() and gallery.IMG_RE.fullmatch(child.name):
                shutil.rmtree(child, ignore_errors=True)
        settings = {"prompt": "sauvegarde", "negative_prompt": "", "checkpoint": "example.safetensors",
                    "sampler_name": "Euler", "scheduler": "automatic", "width": 512, "height": 512, "steps": 4,
                    "cfg_scale": 5.0, "seed": 1, "n_iter": 1, "batch_size": 1}
        def png(color):
            buffer = io.BytesIO()
            Image.new("RGB", (64, 64), color).save(buffer, format="PNG")
            return buffer.getvalue()
        first = gallery.store(self.root, png((3, 4, 5)), settings)
        second = gallery.store(self.root, png((5, 6, 7)), settings)
        status, _headers, blob = self.admin.req("/api/forge/gallery/export")
        self.assertEqual(status, 200)
        gallery.delete(self.root, first["id"])
        gallery.delete(self.root, second["id"])
        self.assertEqual(self.anon.req("/api/forge/gallery/restore/verify", "POST", blob, {"Content-Type": "application/zip"})[0], 401)
        status, _headers, body = self.admin.req("/api/forge/gallery/restore/verify", "POST", blob, {"Content-Type": "application/zip"})
        self.assertEqual(status, 200)
        verified = json.loads(body.decode("utf-8"))
        self.assertEqual((verified["verified"], verified["imported"]), (2, 0))
        self.assertEqual(gallery.page(self.root)["images"], [], "verify never writes")
        gallery.set_quota_for_tests(image_cap=1)
        status, _headers, body = self.admin.req("/api/forge/gallery/import", "POST", blob, {"Content-Type": "application/zip"})
        self.assertEqual(status, 409)
        refused = json.loads(body.decode("utf-8"))
        self.assertEqual(refused["code"], "quota")
        self.assertEqual(refused["plan"]["images"], 2)
        self.assertEqual(gallery.page(self.root)["images"], [], "a refused restore leaves nothing behind")

    def test_gallery_subset_export_and_last_backup_marker(self):
        import zipfile
        import hq_forge_gallery as gallery
        gallery.reset_for_tests()
        self.addCleanup(gallery.reset_for_tests)
        base = gallery.gallery_dir(self.root)
        for child in list(base.iterdir()) if base.is_dir() else []:
            if child.is_dir() and gallery.IMG_RE.fullmatch(child.name):
                shutil.rmtree(child, ignore_errors=True)
        settings = {"prompt": "sauvegarde", "negative_prompt": "", "checkpoint": "example.safetensors",
                    "sampler_name": "Euler", "scheduler": "automatic", "width": 512, "height": 512, "steps": 4,
                    "cfg_scale": 5.0, "seed": 1, "n_iter": 1, "batch_size": 1}
        def png(color):
            buffer = io.BytesIO()
            Image.new("RGB", (64, 64), color).save(buffer, format="PNG")
            return buffer.getvalue()
        first = gallery.store(self.root, png((3, 4, 5)), settings)
        second = gallery.store(self.root, png((5, 6, 7)), settings)
        status, _headers, _blob = self.admin.req("/api/forge/gallery/export")
        self.assertEqual(status, 200)
        usage = gallery.usage(self.root)["backup"]
        deadline = time.monotonic() + 2.0
        while not usage.get("at") and time.monotonic() < deadline:
            time.sleep(0.02)
            usage = gallery.usage(self.root)["backup"]
        self.assertTrue(usage["at"])
        self.assertEqual(usage["images"], 2)
        status, _headers, blob = self.admin.req("/api/forge/gallery/export?ids=" + first["id"])
        self.assertEqual(status, 200)
        with zipfile.ZipFile(io.BytesIO(blob)) as bundle:
            names = bundle.namelist()
        self.assertTrue(any(name.startswith(first["id"] + "/") for name in names))
        self.assertFalse(any(name.startswith(second["id"] + "/") for name in names))
        self.assertEqual(self.admin.req("/api/forge/gallery/export?ids=../nope")[0], 400)

    def test_gallery_export_skips_backup_marker_when_stream_aborts(self):
        import hq_forge_gallery as gallery
        gallery.reset_for_tests()
        self.addCleanup(gallery.reset_for_tests)
        buffer = io.BytesIO()
        Image.new("RGB", (64, 64), (3, 4, 5)).save(buffer, format="PNG")
        settings = {"prompt": "sauvegarde", "negative_prompt": "", "checkpoint": "example.safetensors",
                    "sampler_name": "Euler", "scheduler": "automatic", "width": 512, "height": 512, "steps": 4,
                    "cfg_scale": 5.0, "seed": 1, "n_iter": 1, "batch_size": 1}
        gallery.store(self.root, buffer.getvalue(), settings)
        before = gallery.usage(self.root)["backup"]["at"]
        def aborted_send(handler_self, path, as_download=False, content_type=None):
            handler_self.send_response(200)
            handler_self.send_header("Content-Type", "application/zip")
            handler_self.send_header("Content-Length", "0")
            handler_self.end_headers()
            return False

        with mock.patch.object(B.Handler, "_send_file", aborted_send):
            status, _h, _b = self.admin.req("/api/forge/gallery/export")
            self.assertEqual(status, 200)
        self.assertEqual(gallery.usage(self.root)["backup"]["at"], before)

    def test_empty_trash_route_requires_admin_and_deletes_only_rejected(self):
        import hq_forge_gallery as gallery
        gallery.reset_for_tests()
        self.addCleanup(gallery.reset_for_tests)
        settings = {"prompt": "sauvegarde", "negative_prompt": "", "checkpoint": "example.safetensors",
                    "sampler_name": "Euler", "scheduler": "automatic", "width": 512, "height": 512, "steps": 4,
                    "cfg_scale": 5.0, "seed": 1, "n_iter": 1, "batch_size": 1}
        buffer = io.BytesIO()
        Image.new("RGB", (64, 64), (3, 4, 5)).save(buffer, format="PNG")
        kept = gallery.store(self.root, buffer.getvalue(), settings)
        rejected = gallery.store(self.root, buffer.getvalue(), settings)
        gallery.set_triage(self.root, rejected["id"], "reject")
        path = "/api/forge/gallery/trash/empty"
        body = b"{}"
        self.assertEqual(self.anon.req(path, "POST", body, {"Content-Type": "application/json"})[0], 401)
        self.assertEqual(self.upload.req(path, "POST", body, {"Content-Type": "application/json"})[0], 403)
        self.assertEqual(self.admin.req(path, "POST", body, {"Content-Type": "application/json"}, origin=False)[0], 403)
        status, _headers, out = self.admin.req(path, "POST", body, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(out.decode("utf-8"))["deleted"], 1)
        with self.assertRaises(gallery.GalleryError):
            gallery.get(self.root, rejected["id"])
        self.assertTrue(gallery.get(self.root, kept["id"])["id"])

    def test_vault_triage_route_is_admin_only_csrf_gated_locked_and_404_for_unknown(self):
        import hq_forge_vault as vault
        vault.set_root_for_tests(Path(self.tmp) / "vault-triage")
        vault.set_acl_for_tests(False)
        admin = Client(self.base, ADMIN_PIN)
        made = admin.json("/api/forge/vaults/new", "POST", data=json.dumps({"passphrase": "correct horse battery", "confirm": "correct horse battery", "label": "Tri"}).encode())
        self.assertEqual(made[0], 201)
        base = "/api/forge/vaults/" + made[1]["vault"]["id"]  # V4: per-vault routes only
        path = base + "/images/pvt-" + "0" * 24 + "/triage"
        body = b'{"state": "reject"}'
        self.assertEqual(self.anon.req(path, "POST", body)[0], 401)
        self.assertEqual(Client(self.base, UPLOAD_PIN).req(path, "POST", body)[0], 403)
        self.assertEqual(admin.req(path, "POST", body, {"Origin": "http://evil.example"}, origin=False)[0], 403)
        self.assertEqual(admin.req(path, "POST", body, origin=False)[0], 403)
        self.assertEqual(admin.req(path, "POST", body)[0], 401)  # locked
        opened, _ = admin.json(base + "/unlock", "POST", data=json.dumps({"passphrase": "correct horse battery"}).encode())
        self.assertEqual(opened, 200)
        try:
            self.assertEqual(admin.req(path, "POST", body)[0], 404)
            image = Image.new("RGB", (64, 64), (1, 2, 3))
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            status, _h, raw = admin.req(base + "/import", "POST", buffer.getvalue(), {"Content-Type": "application/octet-stream"})
            self.assertEqual(status, 201)
            image_id = json.loads(raw.decode("utf-8"))["id"]
            real = base + "/images/" + image_id + "/triage"
            self.assertEqual(admin.req(real, "POST", b'{"state": "nope"}')[0], 400)
            status, done = admin.json(real, "POST", data=body)
            self.assertEqual((status, done["triage"], done["previous"]), (200, "reject", "none"))
            self.assertEqual(admin.json(base + "/gallery")[1]["images"], [])
            self.assertEqual([row["id"] for row in admin.json(base + "/gallery?view=trash")[1]["images"]], [image_id])
            other = Client(self.base, ADMIN_PIN)
            self.assertEqual(other.req(real, "POST", b'{"state": "none"}')[0], 401)
        finally:
            admin.json("/api/forge/vaults/lock", "POST", data=b"{}")

    def test_lab_route_is_admin_only_read_only_and_has_no_prompt(self):
        import hq_forge_stats as stats
        stats.record(self.root, {"kind": "job", "outcome": "completed", "width": 512, "height": 512, "steps": 20,
                                 "duration_s": 3.0, "device_id": "local", "prompt": "zq-http-lab"})
        self.assertEqual(self.anon.req("/api/forge/lab")[0], 401)
        self.assertEqual(Client(self.base, UPLOAD_PIN).req("/api/forge/lab")[0], 403)
        admin = Client(self.base, ADMIN_PIN)
        status, _headers, body = admin.req("/api/forge/lab")
        self.assertEqual(status, 200)
        payload = json.loads(body.decode("utf-8"))
        self.assertGreaterEqual(payload["records"], 1)
        self.assertNotIn(b"zq-http-lab", body)
        self.assertEqual(admin.req("/api/forge/lab/extra")[0], 404)
        status, planned = admin.json("/api/forge/lab?plan=1&width=512&height=512&steps=20&count=4&checkpoint=x")
        self.assertEqual(status, 200)
        self.assertEqual(planned["plan"]["devices"][0]["samples"], 1)
        self.assertNotIn("zq-http-lab", json.dumps(planned))
        self.assertIsNone(admin.json("/api/forge/lab?plan=1&width=bad")[1]["plan"])
        # Read-only: there is no POST counterpart, and a cross-site POST is refused first.
        self.assertEqual(admin.req("/api/forge/lab", "POST", b"{}", {"Origin": "http://evil.example"}, origin=False)[0], 403)
        self.assertEqual(admin.req("/api/forge/lab", "POST", b"{}")[0], 404)

    def test_job_resolve_route_is_admin_only_csrf_gated_and_never_relaunches(self):
        job_id = "job-" + "b" * 24
        store = self.root / ".hq-forge" / "jobs.json"
        store.parent.mkdir(parents=True, exist_ok=True)
        store.write_text(json.dumps({"jobs": [{"id": job_id, "state": "generating", "destination": "normal", "settings": {"prompt": "zq-resolve"},
                                               "created": "2026-10-22T10:00:00Z", "submitted": True}], "idempotency": {}}), encoding="utf-8")
        J.reset_for_tests()
        path = "/api/forge/jobs/" + job_id + "/resolve"
        self.assertEqual(self.anon.req(path, "POST", b'{"action": "lost"}')[0], 401)
        self.assertEqual(Client(self.base, UPLOAD_PIN).req(path, "POST", b'{"action": "lost"}')[0], 403)
        admin = Client(self.base, ADMIN_PIN)
        self.assertEqual(admin.req(path, "POST", b'{"action": "lost"}', {"Origin": "http://evil.example"}, origin=False)[0], 403)
        self.assertEqual(admin.req("/api/forge/jobs/job-" + "0" * 24 + "/resolve", "POST", b'{"action": "lost"}')[0], 404)
        self.assertEqual(admin.req(path, "POST", b'{"action": "retry"}')[0], 400)
        status, payload = admin.json(path, "POST", data=b'{"action": "keep"}')
        self.assertEqual(status, 200, payload)
        self.assertEqual((payload["job"]["state"], payload["job"]["resolution"]), ("unknown", "kept"))
        jobs = json.loads(store.read_text(encoding="utf-8"))["jobs"]
        self.assertEqual(len(jobs), 1, "no new job was created")
        store.write_text(json.dumps({"jobs": [], "idempotency": {}}), encoding="utf-8")

    def test_preview_route_is_admin_only_csrf_gated_and_has_no_job_fallback(self):
        path = "/api/forge/preview"
        self.assertEqual(self.anon.req(path)[0], 401)
        self.assertEqual(self.upload.req(path)[0], 403)
        self.assertEqual(self.admin.req(path, "POST", b"{}", origin=False)[0], 403)
        self.assertEqual(self.admin.req(path, "POST", b"{}")[0], 400)
        self.assertEqual(self.admin.req("/api/forge/preview/nope")[0], 404)
        self.assertEqual(self.anon.req("/api/forge/preview/nope")[0], 401)

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
            elif url.endswith("/sdapi/v1/upscalers"):
                body = [{"name": "R-ESRGAN 4x+"}, {"name": "None"}]
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
        self.assertEqual(self.anon.req("/api/forge/vaults")[0], 401)
        self.assertEqual(self.upload.req("/api/forge/vaults")[0], 403)
        self.assertEqual(self.admin.req("/api/forge/vaults/new", "POST", b"{}", origin=False)[0], 403)
        status, payload = self.admin.json("/api/forge/vaults")
        self.assertEqual(status, 200)
        self.assertEqual(payload["vaults"], [])
        self.assertNotIn("images", payload)
        refused, body = self.admin.json("/api/forge/vaults/new", "POST", data=json.dumps({"passphrase": "123456", "confirm": "123456", "label": "A"}).encode())
        self.assertEqual(refused, 400)
        self.assertNotIn("recovery_key", body)
        created_status, created, headers = self._vault_setup()
        self.assertEqual(created_status, 201)
        self.assertIn("recovery_key", created)
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        base = "/api/forge/vaults/" + created["vault"]["id"]
        state = self.admin.json(base + "/status")[1]
        self.assertTrue(state["configured"] and state["private_generation"] and not state["unlocked"])
        self.assertNotIn("images", state)
        locked, _locked_body = self.admin.json(base + "/gallery")
        self.assertEqual(locked, 401)
        other = Client(self.base, ADMIN_PIN)
        opened, _opened = self.admin.json(base + "/unlock", "POST", data=json.dumps({"passphrase": "correct horse battery"}).encode())
        self.assertEqual(opened, 200)
        denied, _denied = other.json(base + "/gallery")
        self.assertEqual(denied, 401)
        self.admin.json("/api/forge/vaults/lock", "POST", data=b"{}")
        again, _again = self.admin.json(base + "/gallery")
        self.assertEqual(again, 401)
        self.admin.json(base + "/unlock", "POST", data=json.dumps({"passphrase": "correct horse battery"}).encode())
        changed, changed_body = self.admin.json(
            base + "/passphrase", "POST",
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
            self.assertEqual(self.admin.req(base + "/gallery")[0], 401)
        finally:
            B.CONFIG["auth_generation"] = saved

    def _vault_setup(self):
        status, headers, body = self.admin.req(
            "/api/forge/vaults/new", "POST",
            json.dumps({"passphrase": "correct horse battery", "confirm": "correct horse battery", "label": "Coffre"}).encode(),
            {"Content-Type": "application/json"},
        )
        return status, json.loads(body.decode("utf-8")), {key: value for key, value in headers.items()}


if __name__ == "__main__":
    unittest.main()
