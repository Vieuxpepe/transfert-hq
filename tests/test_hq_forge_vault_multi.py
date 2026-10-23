"""Multi-vault V1 to V3: storage, migration, sessions, attempts. Temp folders only, never the real vault."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge as F  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import hq_forge_vault as V  # noqa: E402
import hq_forge_vault_registry as R  # noqa: E402

PASS = "correct horse battery"
PASS_B = "another long passphrase"
VA = "vlt-00000000000000aa"
VB = "vlt-00000000000000bb"


def _png(colour=(20, 180, 90)) -> bytes:
    image = Image.new("RGB", (256, 256), colour)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _token(name: str) -> str:
    return ("session-" + name + "-0123456789abcdef").replace(" ", "")[:40]


def _entry(vid, order=0, label="Coffre", discret=False):
    return {"id": vid, "label": None if discret else label, "glyph": "coffre", "colour": "ardoise",
            "discret": discret, "order": order, "created": "2026-10-23", "last_used_day": None}


class MultiBase(unittest.TestCase):
    def setUp(self) -> None:
        V.bind_session_checker(None)
        F.reset_for_tests()
        J.reset_for_tests()
        self.tmp = tempfile.TemporaryDirectory()
        self.hq = Path(self.tmp.name) / "hq"
        self.store = Path(self.tmp.name) / "forge-vault"
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

    def write_registry(self, data) -> None:
        (self.store / "registry.json").write_text(json.dumps(data), encoding="utf-8")

    def make_dirs(self, *vids, bind=True) -> None:
        for vid in vids:
            folder = self.store / "vaults" / vid
            folder.mkdir(parents=True, exist_ok=True)
            header = {"version": 1, "epoch": 1}
            if bind:
                header["vid"] = vid
            (folder / "vault.json").write_text(json.dumps(header), encoding="utf-8")


class ResolveTests(MultiBase):
    """V1.2: vaults/<vid>/ folders, resolved only through a valid registry."""

    def test_legacy_layout_is_the_top_folder(self):
        V.setup(self.hq, PASS, PASS)
        self.assertEqual(V._root(self.hq), self.store)
        with self.assertRaises(V.VaultError) as caught:
            V._root(self.hq, vid=VA)
        self.assertEqual(caught.exception.code, "bad_vault")

    def test_multi_layout_resolves_listed_ids_only(self):
        self.make_dirs(VA, VB)
        self.write_registry({"version": 1, "legacy": None, "vaults": [_entry(VA)]})
        self.assertEqual(V._root(self.hq, vid=VA), self.store / "vaults" / VA)
        for vid in (VB, "vlt-0000000000000000", "../" + VA, VA + "/..", "vlt-00000000000000AA", VA + "\\x", "", 7):
            with self.subTest(vid=vid), self.assertRaises(V.VaultError) as caught:
                V._root(self.hq, vid=vid)
            self.assertEqual(caught.exception.code, "bad_vault")

    def test_alias_is_the_migrated_vault_only(self):
        self.make_dirs(VA, VB)
        self.write_registry({"version": 1, "legacy": None, "vaults": [_entry(VA), _entry(VB, 1)]})
        with self.assertRaises(V.VaultError) as caught:
            V._root(self.hq)
        self.assertEqual(caught.exception.code, "use_vaults")

    def test_corrupt_or_tampered_registry_opens_nothing(self):
        self.make_dirs(VA)
        for raw in ("{", json.dumps({"version": 1, "legacy": None, "vaults": [{**_entry(VA), "label": "<x>"}]}),
                    json.dumps({"version": 1, "legacy": None, "vaults": [_entry(VA), _entry(VA, 1)]}),
                    json.dumps({"version": 1, "legacy": None, "vaults": [{**_entry(VA), "path": "C:/"}]})):
            (self.store / "registry.json").write_text(raw, encoding="utf-8")
            for vid in (VA, None):
                with self.subTest(raw=raw[:30], vid=vid), self.assertRaises(V.VaultError) as caught:
                    V._root(self.hq, vid=vid)
                self.assertEqual(caught.exception.code, "registry")
                self.assertEqual(V.public_error("registry"), "La liste des coffres est illisible. Aucun coffre n'est ouvert.")

    def test_registry_beside_a_legacy_vault_is_refused(self):
        V.setup(self.hq, PASS, PASS)
        self.write_registry({"version": 1, "legacy": None, "vaults": []})
        with self.assertRaises(V.VaultError) as caught:
            V._root(self.hq)
        self.assertEqual(caught.exception.code, "registry")

    def test_swapped_folders_are_refused(self):
        # vaults/A holds B's header: a folder rename cannot make one id open the other vault.
        self.make_dirs(VA, VB)
        a, b = self.store / "vaults" / VA, self.store / "vaults" / VB
        os.replace(a, self.store / "tmp")
        os.replace(b, a)
        os.replace(self.store / "tmp", b)
        self.write_registry({"version": 1, "legacy": None, "vaults": [_entry(VA), _entry(VB, 1)]})
        for vid in (VA, VB):
            with self.subTest(vid=vid), self.assertRaises(V.VaultError) as caught:
                V._root(self.hq, vid=vid)
            self.assertEqual(caught.exception.code, "registry")

    def test_unbound_header_only_for_the_migrated_vault(self):
        self.make_dirs(VA, VB, bind=False)
        self.write_registry({"version": 1, "legacy": VA, "vaults": [_entry(VA), _entry(VB, 1)]})
        self.assertEqual(V._root(self.hq), self.store / "vaults" / VA)
        with self.assertRaises(V.VaultError) as caught:
            V._root(self.hq, vid=VB)
        self.assertEqual(caught.exception.code, "registry")

    @unittest.skipUnless(hasattr(os, "symlink"), "no symlink")
    def test_linked_vault_folder_is_refused(self):
        self.make_dirs(VA)
        self.write_registry({"version": 1, "legacy": None, "vaults": [_entry(VA), _entry(VB, 1)]})
        try:
            os.symlink(self.store / "vaults" / VA, self.store / "vaults" / VB, target_is_directory=True)
        except OSError:
            self.skipTest("symlinks need a privilege here")
        with self.assertRaises(V.VaultError) as caught:
            V._root(self.hq, vid=VB)
        self.assertIn(caught.exception.code, ("bad_root", "registry"))


class DiscretLabelTests(MultiBase):
    """V1.3: a Discret name is stored only sealed in its own vault."""

    def test_label_is_sealed_and_bound_to_its_key(self):
        folder = self.store / "vaults" / VA
        folder.mkdir(parents=True)
        key, other = os.urandom(32), os.urandom(32)
        V._write_label(folder, key, "Projet Hirondelle")
        raw = (folder / "label.bin").read_bytes()
        self.assertNotIn(b"Hirondelle", raw)
        self.assertNotIn("Hirondelle".encode("utf-16-le"), raw)
        self.assertEqual(V._read_label(folder, key), "Projet Hirondelle")
        with self.assertRaises(V.VaultError) as caught:
            V._read_label(folder, other)
        self.assertEqual(caught.exception.code, "corrupt")

    def test_index_key_cannot_open_a_label_and_back(self):
        folder = self.store / "vaults" / VA
        folder.mkdir(parents=True)
        key = os.urandom(32)
        V._write_index(folder, key, [])
        os.replace(folder / "index.bin", folder / "label.bin")
        with self.assertRaises(V.VaultError):
            V._read_label(folder, key)

    def test_drop_label(self):
        folder = self.store / "vaults" / VA
        folder.mkdir(parents=True)
        key = os.urandom(32)
        V._write_label(folder, key, "X")
        V._drop_label(folder)
        self.assertIsNone(V._read_label(folder, key))

if __name__ == "__main__":
    unittest.main()