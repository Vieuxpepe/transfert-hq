"""Multi-vault V5: photo icon sealed in its vault, manual order, glyph set, colour contrast (WCAG).
Disposable root and vault folder, fake PINs, no Forge, never the real vault."""

from __future__ import annotations

import io
import json
import re
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_hq_forge_vault_multi_http import JSON, PASS, PASS_B, MultiHttp, _png  # noqa: E402
import hq_forge_vault as V  # noqa: E402
import hq_forge_vault_registry as R  # noqa: E402
import iphone_bridge as B  # noqa: E402

SOURCE = Path(__file__).resolve().parents[1]


def _lum(hex_colour: str) -> float:
    rgb = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a: str, b: str) -> float:
    la, lb = sorted((_lum(a), _lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


class Palette(unittest.TestCase):
    def test_every_colour_has_a_css_tile_with_aa_contrast_for_white(self):
        css = (SOURCE / "assets" / "hq-forge.css").read_text(encoding="utf-8")
        found = dict(re.findall(r"\.forge-vault-tile\[data-colour=([a-z]+)\]\{background:(#[0-9a-fA-F]{6})\}", css))
        self.assertEqual(set(found), set(R.COLOURS))
        for name, value in found.items():
            self.assertGreaterEqual(contrast("#ffffff", value), 4.5, name + " " + value)

    def test_twenty_glyphs_each_drawn_in_the_ui(self):
        self.assertEqual(len(R.GLYPHS), 20)
        self.assertEqual(len(set(R.GLYPHS)), 20)
        js = (SOURCE / "assets" / "hq-forge.js").read_text(encoding="utf-8")
        block = js[js.index("const GLYPHS = {"):js.index("};", js.index("const GLYPHS = {"))]
        self.assertEqual(set(re.findall(r"\b([a-z]+): \[", block)), set(R.GLYPHS))

    def test_v4_registry_ids_are_still_valid(self):
        for glyph in ("coffre", "etoile", "lune", "soleil", "feuille", "fleur", "vague", "montagne", "nuage", "flamme", "coeur", "cle"):
            self.assertIn(glyph, R.GLYPHS)


class Icon(MultiHttp):
    def _open_with_image(self, vid, passphrase=PASS):
        base = "/api/forge/vaults/" + vid
        self.assertEqual(self.post(self.admin, base + "/unlock", {"passphrase": passphrase})[0], 200)
        status, _h, raw = self.admin.req(base + "/import", "POST", _png(), {"Content-Type": "application/octet-stream"})
        self.assertEqual(status, 201)
        return base, json.loads(raw)["id"]

    def test_icon_is_sealed_in_the_vault_and_shown_only_while_open(self):
        a = self.made("A")
        base, image_id = self._open_with_image(a)
        self.assertEqual(self.post(self.admin, base + "/icon", {"image_id": image_id}), (200, {"icon": True}))
        folder = self.store / "vaults" / a
        sealed = (folder / V.ICON_FILE).read_bytes()
        self.assertFalse(sealed.startswith((b"\x89PNG", b"\xff\xd8", b"RIFF")), "never in clear")
        reg = (self.store / "registry.json").read_text(encoding="utf-8")
        self.assertNotIn("icon", reg)
        status, headers, body = self.admin.req(base + "/icon")
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("Content-Type", "").startswith("image/"))
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        listing = self.admin.json("/api/forge/vaults")[1]
        self.assertTrue(next(v for v in listing["vaults"] if v["id"] == a)["icon"])
        self.post(self.admin, "/api/forge/vaults/lock", {})
        self.assertEqual(self.admin.req(base + "/icon")[0], 401)
        listing = self.admin.json("/api/forge/vaults")[1]
        self.assertFalse(next(v for v in listing["vaults"] if v["id"] == a)["icon"], "locked: glyph and colour only")
        self.assertFalse(any(image_id in line or "icone" in line for line in self.logged))

    def test_icon_travels_in_the_backup_and_can_be_cleared(self):
        a = self.made("A")
        base, image_id = self._open_with_image(a)
        self.post(self.admin, base + "/icon", {"image_id": image_id})
        # The per-vault backup route is V6; the module function already writes the ZIP.
        payload = V.backup_bytes(B.ROOT, self.token(self.admin), vid=a)
        self.assertIn(V.ICON_FILE, zipfile.ZipFile(io.BytesIO(payload)).namelist())
        self.assertEqual(self.post(self.admin, base + "/icon/clear", {}), (200, {"icon": False}))
        self.assertFalse((self.store / "vaults" / a / V.ICON_FILE).exists())
        self.assertEqual(self.admin.req(base + "/icon")[0], 404)

    def test_icon_from_another_vault_or_bad_id_is_refused(self):
        a, b = self.made("A"), self.made("B", PASS_B)
        _base_a, image_id = self._open_with_image(a)
        self.post(self.admin, "/api/forge/vaults/" + b + "/unlock", {"passphrase": PASS_B})
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + b + "/icon", {"image_id": image_id})[0], 404)
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + b + "/icon", {"image_id": "../x"})[0], 404)
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + a + "/icon", {"image_id": image_id})[0], 401, "a not open")

    def test_a_tampered_icon_blocks_restore(self):
        a = self.made("A")
        base, image_id = self._open_with_image(a)
        self.post(self.admin, base + "/icon", {"image_id": image_id})
        payload = V.backup_bytes(B.ROOT, self.token(self.admin), vid=a)
        src = zipfile.ZipFile(io.BytesIO(payload))
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as dst:
            for name in src.namelist():
                data = src.read(name)
                dst.writestr(name, data[:-1] + bytes([data[-1] ^ 1]) if name == V.ICON_FILE else data)
        with self.assertRaises(V.VaultError) as caught:
            V.restore_backup(B.ROOT, self.token(self.admin), out.getvalue(), PASS, vid=a)
        self.assertEqual(caught.exception.code, "corrupt")


class Order(MultiHttp):
    def test_reorder_is_a_full_permutation(self):
        a, b, c = self.made("A"), self.made("B", PASS_B), self.made("C")
        status, out = self.post(self.admin, "/api/forge/vaults/order", {"ids": [c, a, b]})
        self.assertEqual(status, 200)
        self.assertEqual([v["id"] for v in out["vaults"]], [c, a, b])
        self.assertEqual([v["id"] for v in self.admin.json("/api/forge/vaults")[1]["vaults"]], [c, a, b])
        for bad in ([a, b], [a, b, c, c], [a, b, "vlt-" + "0" * 16], "x", [], [a, b, 3]):
            self.assertEqual(self.post(self.admin, "/api/forge/vaults/order", {"ids": bad})[0], 400, repr(bad))


class Boundary(MultiHttp):
    """V5 routes: admin + CSRF; 401 anonymous, 403 upload role or bad origin, 404 unknown."""

    def test_new_routes_are_admin_and_csrf(self):
        a = self.made("A")
        posts = ["/api/forge/vaults/order", "/api/forge/vaults/" + a + "/icon", "/api/forge/vaults/" + a + "/icon/clear"]
        body = json.dumps({"ids": [a], "image_id": "pvt-" + "0" * 24}).encode()
        for path in posts:
            with self.subTest(path=path):
                self.assertEqual(self.anon.req(path, "POST", body, JSON)[0], 401)
                self.assertEqual(self.upload.req(path, "POST", body, JSON)[0], 403)
                self.assertEqual(self.admin.req(path, "POST", body, JSON, origin=False)[0], 403)
                self.assertEqual(self.admin.req(path, "POST", body, {**JSON, "Origin": "http://evil.example"})[0], 403)
        get = "/api/forge/vaults/" + a + "/icon"
        self.assertEqual(self.anon.req(get)[0], 401)
        self.assertEqual(self.upload.req(get)[0], 403)
        unknown = "vlt-" + "f" * 16
        self.assertEqual(self.admin.req("/api/forge/vaults/" + unknown + "/icon")[0], 404)
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + unknown + "/icon", {"image_id": "pvt-" + "0" * 24})[0], 404)
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + a + "/icon/nope", {})[0], 404)


if __name__ == "__main__":
    unittest.main()