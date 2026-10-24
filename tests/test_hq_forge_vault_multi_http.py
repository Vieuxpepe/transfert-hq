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


class ListCreateSettings(MultiHttp):
    """V3.2: list (read-only, registry fields only), create, settings, and the explicit migration."""

    ALLOWED = {"id", "label", "number", "glyph", "colour", "discret", "order", "created", "last_used_day"}

    def create(self, label, passphrase=PASS, **extra):
        return self.post(self.admin, "/api/forge/vaults/new", {"passphrase": passphrase, "confirm": passphrase, "label": label, **extra})

    def test_create_and_list(self):
        status, made = self.create("Voyages", glyph="lune", colour="bleu")
        self.assertEqual(status, 201, made)
        self.assertIn("recovery_key", made)
        _s, headers, _b = self.admin.req("/api/forge/vaults")
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        status, listing = self.admin.json("/api/forge/vaults")
        self.assertEqual(status, 200)
        self.assertEqual(listing["layout"], "multi")
        self.assertEqual(listing["max"], 12)
        self.assertEqual([set(v) for v in listing["vaults"]], [self.ALLOWED])
        self.assertEqual((listing["vaults"][0]["label"], listing["vaults"][0]["glyph"], listing["vaults"][0]["number"]), ("Voyages", "lune", 1))
        self.assertNotIn("recovery_key", json.dumps(listing))

    def test_discret_name_only_while_open_here(self):
        _s, made = self.create("Projet Hirondelle", discret=True)
        vid = made["vault"]["id"]
        self.assertIsNone(made["vault"]["label"])
        listing = self.admin.json("/api/forge/vaults")[1]["vaults"][0]
        self.assertEqual((listing["label"], listing["number"], listing["discret"]), (None, 1, True))
        self.post(self.admin, "/api/forge/vaults/" + vid + "/unlock", {"passphrase": PASS})
        self.assertEqual(self.admin.json("/api/forge/vaults")[1]["vaults"][0]["label"], "Projet Hirondelle")
        other = Client(self.base, ADMIN_PIN)
        self.assertIsNone(other.json("/api/forge/vaults")[1]["vaults"][0]["label"])
        self.post(self.admin, "/api/forge/vaults/" + vid + "/lock", {})
        self.assertIsNone(self.admin.json("/api/forge/vaults")[1]["vaults"][0]["label"])
        self.assertNotIn(b"Hirondelle", (self.store / "registry.json").read_bytes())

    def test_settings(self):
        _s, made = self.create("A")
        vid = made["vault"]["id"]
        path = "/api/forge/vaults/" + vid + "/settings"
        status, row = self.post(self.admin, path, {"label": "Album", "glyph": "vague", "colour": "vert", "order": 5})
        self.assertEqual(status, 200, row)
        self.assertEqual((row["label"], row["glyph"], row["colour"], row["order"]), ("Album", "vague", "vert", 5))
        for bad in ({"label": ""}, {"glyph": "crane"}, {"colour": "#fff"}, {"order": -1}, {"id": "vlt-0000000000000000"},
                    {"created": "2020-01-01"}, {"last_used_day": "2020-01-01"}, {}):
            with self.subTest(bad=bad):
                self.assertEqual(self.post(self.admin, path, bad)[0], 400)
        # Discret needs the vault open in this session; then the name leaves the registry.
        self.assertEqual(self.post(self.admin, path, {"discret": True})[0], 401)
        self.post(self.admin, "/api/forge/vaults/" + vid + "/unlock", {"passphrase": PASS})
        status, row = self.post(self.admin, path, {"discret": True})
        self.assertEqual((status, row["label"], row["discret"]), (200, "Album", True))
        reg = json.loads((self.store / "registry.json").read_text(encoding="utf-8"))
        self.assertIsNone(reg["vaults"][0]["label"])
        self.assertNotIn(b"Album", (self.store / "registry.json").read_bytes())
        status, row = self.post(self.admin, path, {"discret": False})
        self.assertEqual((status, row["label"]), (200, "Album"))
        self.assertFalse((self.store / "vaults" / vid / "label.bin").exists())
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/vlt-ffffffffffffffff/settings", {"order": 1})[0], 404)

    def test_corrupt_registry_lists_nothing_and_says_so(self):
        self.create("A")
        self.create("B", PASS_B)
        raw = (self.store / "registry.json").read_text(encoding="utf-8")
        (self.store / "registry.json").write_text(raw.replace('"glyph":"coffre"', '"glyph":"crane"', 1), encoding="utf-8")
        status, body = self.admin.json("/api/forge/vaults")
        self.assertEqual(status, 409)
        self.assertEqual(body["code"], "registry")
        self.assertNotIn("vaults", body)
        self.assertNotIn('"B"', json.dumps(body))

    def test_migration_route_needs_the_backup_offer(self):
        V.setup(B.ROOT, PASS, PASS)
        status, listing = self.admin.json("/api/forge/vaults")
        self.assertEqual((status, listing["layout"], listing["vaults"]), (200, "legacy", []))
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/backup-offer", {})[0], 401)  # V4: vault open first
        self.assertEqual(self.post(self.admin, "/api/forge/vault/unlock", {"passphrase": PASS})[0], 200)
        for forged in ({}, {"backup_offered": "yes"}, {"backup_offered": True}, {"backup_offered": True, "offered": True}):
            with self.subTest(forged=forged):
                status, body = self.post(self.admin, "/api/forge/vaults/migrate", forged)
                self.assertEqual((status, body.get("code")), (409, "backup_first"))  # the client flag alone never migrates
        self.assertEqual(V.layout(B.ROOT), "legacy")
        self.assertEqual(self.create("Trop tot")[0], 409)
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/backup-offer", {})[0], 200)
        status, done = self.post(self.admin, "/api/forge/vaults/migrate", {})
        self.assertEqual(status, 200, done)
        self.assertTrue(done["migrated"])
        listing = self.admin.json("/api/forge/vaults")[1]
        self.assertEqual([(v["id"], v["label"]) for v in listing["vaults"]], [(done["vid"], "Coffre")])
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/migrate", {"backup_offered": True})[1]["migrated"], False)

class Authorisation(MultiHttp):
    """V3.3: every multi-vault route is admin + CSRF; 401 anonymous, 403 other roles or bad origin, 404 unknown."""

    def routes(self, vid):
        v = "/api/forge/vaults/" + vid
        gets = ["/api/forge/vaults", v + "/status", v + "/gallery", v + "/images/pvt-" + "0" * 24, v + "/images/pvt-" + "0" * 24 + "/thumb"]
        posts = ["/api/forge/vaults/new", "/api/forge/vaults/migrate", "/api/forge/vaults/backup-offer", v + "/settings", v + "/unlock", v + "/recover", v + "/lock",
                 v + "/passphrase", v + "/recovery", v + "/search", v + "/images/pvt-" + "0" * 24 + "/triage",
                 v + "/images/pvt-" + "0" * 24 + "/labels", v + "/images/pvt-" + "0" * 24 + "/delete", v + "/import"]
        return gets, posts

    def test_matrix(self):
        vid = self.made("Matrice")
        gets, posts = self.routes(vid)
        body = json.dumps({"passphrase": PASS, "confirm": PASS, "label": "X"}).encode()
        for path in gets:
            with self.subTest(get=path):
                self.assertEqual(self.anon.req(path)[0], 401)
                self.assertEqual(self.upload.req(path)[0], 403)
        for path in posts:
            with self.subTest(post=path):
                self.assertEqual(self.anon.req(path, "POST", body, JSON)[0], 401)
                self.assertEqual(self.upload.req(path, "POST", body, JSON)[0], 403)
                self.assertEqual(self.admin.req(path, "POST", body, JSON, origin=False)[0], 403)
                self.assertEqual(self.admin.req(path, "POST", body, {**JSON, "Origin": "http://evil.example"})[0], 403)
        self.assertEqual(len(V.list_vaults(B.ROOT, self.token(self.admin))["vaults"]), 1)  # nothing was created by refused calls

    def test_unknown_paths(self):
        vid = self.made("A")
        for path in ("/api/forge/vaults/", "/api/forge/vaults/list", "/api/forge/vaults/" + vid + "/delete",
                     "/api/forge/vaults/" + vid + "/registry", "/api/forge/vaults/vlt-ffffffffffffffff/gallery"):
            with self.subTest(path=path):
                self.assertEqual(self.admin.req(path)[0], 404)
        for path in ("/api/forge/vaults/" + vid + "/delete", "/api/forge/vaults/" + vid + "/remove", "/api/forge/vaults/remove",
                     "/api/forge/vaults/vlt-ffffffffffffffff/unlock"):
            with self.subTest(post=path):
                self.assertEqual(self.post(self.admin, path, {"passphrase": PASS})[0], 404)

    def test_names_never_reach_logs_or_error_records(self):
        names = ("Hirondelle", "Album Secret")
        _s, made = self.post(self.admin, "/api/forge/vaults/new", {"passphrase": PASS, "confirm": PASS, "label": names[0], "discret": True})
        vid = made["vault"]["id"]
        self.post(self.admin, "/api/forge/vaults/new", {"passphrase": PASS_B, "confirm": PASS_B, "label": names[1]})
        self.post(self.admin, "/api/forge/vaults/" + vid + "/unlock", {"passphrase": "wrong but long enough"})
        self.post(self.admin, "/api/forge/vaults/" + vid + "/unlock", {"passphrase": PASS})
        self.post(self.admin, "/api/forge/vaults/" + vid + "/settings", {"label": names[0] + " 2"})
        self.admin.json("/api/forge/vaults")
        logged = "\n".join(type(self).logged)
        self.assertIn("/api/forge/vaults/" + vid, logged)  # paths are logged: ids only
        records = json.dumps(D.ERRORS.recent(), default=str)
        stored = "".join(p.read_text(encoding="utf-8", errors="ignore") for p in B.ROOT.rglob("*") if p.is_file() and p.suffix in (".json", ".log", ".txt", ".jsonl"))
        for name in names:
            for where, text in (("log", logged), ("errors", records), ("hq files", stored)):
                self.assertNotIn(name, text, where)

    def test_forge_allowlists_unchanged(self):
        import subprocess
        out = subprocess.run(["git", "diff", "--name-only", "0c0edfa", "--", "hq_forge.py", "hq_forge_worker.py", "hq_forge_fleet.py"],
                             cwd=SOURCE, capture_output=True, text=True)
        if out.returncode != 0:
            self.skipTest("not a git checkout")
        self.assertEqual(out.stdout.strip(), "")

class Alias(MultiHttp):
    """V3.4: /api/forge/vault/* keeps working, as the migrated vault, until V4."""

    def test_old_routes_follow_the_migrated_vault(self):
        self.assertEqual(self.post(self.admin, "/api/forge/vault/setup", {"passphrase": PASS, "confirm": PASS})[0], 201)
        self.post(self.admin, "/api/forge/vault/unlock", {"passphrase": PASS})
        status, _h, raw = self.admin.req("/api/forge/vault/import", "POST", _png(), {"Content-Type": "application/octet-stream"})
        self.assertEqual(status, 201)
        image_id = json.loads(raw)["id"]
        self.assertEqual(self.admin.req("/api/forge/vault/backup")[0], 200)  # downloading the ZIP is the offer
        _s, migrated = self.post(self.admin, "/api/forge/vaults/migrate", {"backup_offered": True})
        vid = migrated["vid"]
        self.assertEqual(self.admin.json("/api/forge/vault/gallery")[0], 401)  # migration closed every session
        self.post(self.admin, "/api/forge/vault/unlock", {"passphrase": PASS})
        self.assertEqual([i["id"] for i in self.admin.json("/api/forge/vault/gallery")[1]["images"]], [image_id])
        self.assertEqual([i["id"] for i in self.admin.json("/api/forge/vaults/" + vid + "/gallery")[1]["images"]], [image_id])
        self.assertEqual(self.admin.req("/api/forge/vault/backup")[0], 200)
        self.assertEqual(self.post(self.admin, "/api/forge/vault/setup", {"passphrase": PASS, "confirm": PASS})[0], 409)
        # Another vault open in this session: the alias is locked, never silently that one.
        _s, other = self.post(self.admin, "/api/forge/vaults/new", {"passphrase": PASS_B, "confirm": PASS_B, "label": "B"})
        self.post(self.admin, "/api/forge/vaults/" + other["vault"]["id"] + "/unlock", {"passphrase": PASS_B})
        self.assertEqual(self.admin.json("/api/forge/vault/gallery")[0], 401)
        self.assertFalse(self.admin.json("/api/forge/vault/status")[1]["unlocked"])

    def test_alias_without_a_migrated_vault_asks_to_choose(self):
        self.post(self.admin, "/api/forge/vaults/new", {"passphrase": PASS, "confirm": PASS, "label": "Neuf"})
        status, body = self.post(self.admin, "/api/forge/vault/unlock", {"passphrase": PASS})
        self.assertEqual((status, body["code"]), (409, "use_vaults"))
        self.assertEqual(self.post(self.admin, "/api/forge/vault/setup", {"passphrase": PASS, "confirm": PASS})[0], 409)

if __name__ == "__main__":
    unittest.main()