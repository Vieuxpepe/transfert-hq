"""Rename an existing vault: only while it is open in this session; Discret names stay sealed.
Disposable root and vault folder, fake PINs, no Forge, never the real vault."""

from __future__ import annotations

import io
import json
import sys
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_hq_forge_vault_multi_http import JSON, PASS, PASS_B, MultiHttp  # noqa: E402
import hq_forge_vault as V  # noqa: E402
import iphone_bridge as B  # noqa: E402

SECRET = "Projet Hirondelle"
NEW_SECRET = "Plan Martinet"


class Rename(MultiHttp):
    def path(self, vid):
        return "/api/forge/vaults/" + vid + "/rename"

    def unlock(self, vid, passphrase=PASS):
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + vid + "/unlock", {"passphrase": passphrase})[0], 200)

    def listed(self, vid):
        return next(v for v in self.admin.json("/api/forge/vaults")[1]["vaults"] if v["id"] == vid)

    def test_clear_vault_renamed_only_while_open(self):
        a = self.made("Voyages")
        self.assertEqual(self.post(self.admin, self.path(a), {"label": "Vacances"})[0], 401, "locked")
        self.assertEqual(self.listed(a)["label"], "Voyages")
        self.unlock(a)
        status, row = self.post(self.admin, self.path(a), {"label": "  Vacances  "})
        self.assertEqual((status, row["label"]), (200, "Vacances"))
        self.post(self.admin, "/api/forge/vaults/lock", {})
        self.assertEqual(self.listed(a)["label"], "Vacances", "a clear name stays readable while locked")
        self.assertIn("Vacances", (self.store / "registry.json").read_text(encoding="utf-8"))

    def test_another_open_vault_does_not_allow_renaming_this_one(self):
        a, b = self.made("A"), self.made("B", PASS_B)
        self.unlock(b, PASS_B)
        self.assertEqual(self.post(self.admin, self.path(a), {"label": "Autre"})[0], 401)
        self.assertEqual(self.listed(a)["label"], "A")

    def test_settings_route_also_needs_the_vault_open_to_rename(self):
        a = self.made("A")
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + a + "/settings", {"label": "Autre"})[0], 401)
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + a + "/settings", {"glyph": "lune"})[0], 200, "glyph alone still works locked")

    def test_discret_name_is_sealed_never_in_clear(self):
        _s, made = self.post(self.admin, "/api/forge/vaults/new", {"passphrase": PASS, "confirm": PASS, "label": SECRET, "discret": True})
        vid = made["vault"]["id"]
        self.unlock(vid)
        before = (self.store / "vaults" / vid / V.LABEL_FILE).read_bytes()
        status, row = self.post(self.admin, self.path(vid), {"label": NEW_SECRET})
        self.assertEqual((status, row["label"], row["discret"]), (200, NEW_SECRET, True))
        after = (self.store / "vaults" / vid / V.LABEL_FILE).read_bytes()
        self.assertNotEqual(before, after)
        self.assertNotIn(NEW_SECRET.encode(), after)
        self.assertEqual(self.listed(vid)["label"], NEW_SECRET, "shown while open")
        self.post(self.admin, "/api/forge/vaults/lock", {})
        self.assertIsNone(self.listed(vid)["label"])
        for path in self.store.rglob("*"):
            if path.is_file():
                self.assertNotIn(NEW_SECRET.encode(), path.read_bytes(), str(path))
        self.assertFalse(any(NEW_SECRET in line or SECRET in line for line in self.logged))
        self.unlock(vid)
        self.assertEqual(self.listed(vid)["label"], NEW_SECRET)

    def test_same_rules_as_creation(self):
        a = self.made("A")
        self.unlock(a)
        for bad in ("", "   ", "x" * 41, "<b>", "a\u0007b", None, 3, ["x"]):
            self.assertEqual(self.post(self.admin, self.path(a), {"label": bad})[0], 400, repr(bad))
        self.assertEqual(self.post(self.admin, self.path(a), {"label": "x" * 40})[0], 200)
        # Creation has no uniqueness rule (Discret names cannot be compared while sealed), so neither does rename.
        b = self.made("B", PASS_B)
        self.assertEqual(self.post(self.admin, self.path(a), {"label": "B"})[0], 200)
        self.assertEqual(self.listed(b)["label"], "B")

    def test_crash_during_write_keeps_the_old_name(self):
        a = self.made("A")
        self.unlock(a)
        with mock.patch.object(V.os, "replace", side_effect=OSError("disk")):
            status = self.post(self.admin, self.path(a), {"label": "Neuf"})[0]
        self.assertGreaterEqual(status, 400)
        self.assertEqual(self.listed(a)["label"], "A")
        json.loads((self.store / "registry.json").read_text(encoding="utf-8"))
        self.assertEqual([p.name for p in self.store.glob("*.tmp*")], [])

    def test_discret_crash_keeps_the_old_sealed_name(self):
        _s, made = self.post(self.admin, "/api/forge/vaults/new", {"passphrase": PASS, "confirm": PASS, "label": SECRET, "discret": True})
        vid = made["vault"]["id"]
        self.unlock(vid)
        with mock.patch.object(V.os, "replace", side_effect=OSError("disk")):
            self.assertGreaterEqual(self.post(self.admin, self.path(vid), {"label": NEW_SECRET})[0], 400)
        self.assertEqual(self.listed(vid)["label"], SECRET)

    def test_backup_carries_the_new_name(self):
        _s, made = self.post(self.admin, "/api/forge/vaults/new", {"passphrase": PASS, "confirm": PASS, "label": SECRET, "discret": True})
        vid = made["vault"]["id"]
        self.unlock(vid)
        self.post(self.admin, self.path(vid), {"label": NEW_SECRET})
        payload = V.backup_bytes(B.ROOT, self.token(self.admin), vid=vid)
        sealed = zipfile.ZipFile(io.BytesIO(payload)).read(V.LABEL_FILE)
        self.assertEqual(sealed, (self.store / "vaults" / vid / V.LABEL_FILE).read_bytes())
        self.assertNotIn(NEW_SECRET.encode(), payload)

    def test_boundary(self):
        a = self.made("A")
        body = json.dumps({"label": "X"}).encode()
        path = self.path(a)
        self.assertEqual(self.anon.req(path, "POST", body, JSON)[0], 401)
        self.assertEqual(self.upload.req(path, "POST", body, JSON)[0], 403)
        self.assertEqual(self.admin.req(path, "POST", body, JSON, origin=False)[0], 403)
        self.assertEqual(self.admin.req(path, "POST", body, {**JSON, "Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.post(self.admin, self.path("vlt-" + "f" * 16), {"label": "X"})[0], 404)
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + a + "/rename/x", {"label": "X"})[0], 404)
        self.assertEqual(self.post(self.admin, path, {"label": "X"})[0], 401, "locked")
        self.assertEqual(self.anon.req(path + "?label=X", "POST", b"{}", JSON)[0], 401)


if __name__ == "__main__":
    unittest.main()
