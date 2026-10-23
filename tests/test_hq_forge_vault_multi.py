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

    def test_discret_name_survives_backup_and_restore_sealed(self):
        import zipfile
        vid = V.create_vault(self.hq, self.admin, PASS, PASS, label="Projet Hirondelle", discret=True)["vault"]["id"]
        V.unlock(self.hq, self.admin, PASS, vid=vid)
        V.store_image(self.hq, self.admin, _png(), None, vid=vid)
        payload = V.backup_bytes(self.hq, self.admin, vid=vid)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            self.assertIn("label.bin", archive.namelist())
            sealed = archive.read("label.bin")
            for name in archive.namelist():
                self.assertNotIn(b"Hirondelle", archive.read(name))
        self.assertNotIn(b"Hirondelle", sealed)
        self.assertNotIn(b"Hirondelle", payload)
        (self.store / "vaults" / vid / "label.bin").unlink()  # the live copy is lost
        V.restore_backup(self.hq, self.admin, payload, PASS, vid=vid)
        restored = (self.store / "vaults" / vid / "label.bin").read_bytes()
        self.assertEqual(restored, sealed)  # back on disk, still sealed
        self.assertNotIn(b"Hirondelle", restored)
        row = V.list_vaults(self.hq, self.admin)["vaults"][0]
        self.assertIsNone(row["label"])  # hidden while closed
        V.unlock(self.hq, self.admin, PASS, vid=vid)
        self.assertEqual(V.list_vaults(self.hq, self.admin)["vaults"][0]["label"], "Projet Hirondelle")
        self.assertNotIn("Hirondelle", (self.store / "registry.json").read_text(encoding="utf-8"))

    def test_restore_refuses_a_label_sealed_with_another_key(self):
        import zipfile
        vid = V.create_vault(self.hq, self.admin, PASS, PASS, label="Hirondelle", discret=True)["vault"]["id"]
        V.unlock(self.hq, self.admin, PASS, vid=vid)
        payload = V.backup_bytes(self.hq, self.admin, vid=vid)
        swapped = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(payload)) as src, zipfile.ZipFile(swapped, "w") as dst:
            for name in src.namelist():
                data = src.read(name)
                if name == "label.bin":
                    data = V._seal(os.urandom(32), json.dumps({"label": "Intrus"}).encode(), V._AAD_LABEL)
                dst.writestr(name, data)
        before = (self.store / "vaults" / vid / "label.bin").read_bytes()
        with self.assertRaises(V.VaultError) as caught:
            V.restore_backup(self.hq, self.admin, swapped.getvalue(), PASS, vid=vid)
        self.assertEqual(caught.exception.code, "corrupt")
        self.assertEqual((self.store / "vaults" / vid / "label.bin").read_bytes(), before)  # live vault untouched

    def test_drop_label(self):
        folder = self.store / "vaults" / VA
        folder.mkdir(parents=True)
        key = os.urandom(32)
        V._write_label(folder, key, "X")
        V._drop_label(folder)
        self.assertIsNone(V._read_label(folder, key))

class PerVaultTests(MultiBase):
    """V1.4: every function takes a vid; own keys, own folder, own quota; global cap; at most 12."""

    def create(self, label="Voyages", passphrase=PASS, **kw):
        return V.create_vault(self.hq, self.admin, passphrase, passphrase, label=label, **kw)

    def test_create_lists_and_isolates(self):
        a = self.create("Voyages")
        b = self.create("Famille", PASS_B, glyph="coeur", colour="rose")
        va, vb = a["vault"]["id"], b["vault"]["id"]
        self.assertNotEqual(va, vb)
        self.assertNotEqual(a["recovery_key"], b["recovery_key"])
        reg = json.loads((self.store / "registry.json").read_text(encoding="utf-8"))
        self.assertEqual([e["id"] for e in reg["vaults"]], [va, vb])
        self.assertIsNone(reg["legacy"])
        for vid in (va, vb):
            header = json.loads((self.store / "vaults" / vid / "vault.json").read_text(encoding="utf-8"))
            self.assertEqual(header["vid"], vid)
        V.unlock(self.hq, self.admin, PASS, vid=va)
        stored = V.store_image(self.hq, self.admin, _png(), None, vid=va)
        self.assertEqual(len(V.page(self.hq, self.admin, vid=va)["images"]), 1)
        # B's passphrase never opens A, A's never opens B.
        with self.assertRaises(V.VaultError) as caught:
            V.unlock(self.hq, self.other, PASS_B, vid=va)
        self.assertEqual(caught.exception.code, "passphrase")
        V.unlock(self.hq, self.other, PASS_B, vid=vb)
        self.assertEqual(V.page(self.hq, self.other, vid=vb)["images"], [])
        with self.assertRaises(V.VaultError) as caught:
            V.detail(self.hq, self.other, stored["id"], vid=vb)
        self.assertEqual(caught.exception.code, "bad_id")

    def test_create_needs_a_session_and_valid_fields(self):
        with self.assertRaises(V.VaultError) as caught:
            V.create_vault(self.hq, None, PASS, PASS, label="X")
        self.assertEqual(caught.exception.code, "locked")
        for kw in ({"label": ""}, {"label": "x" * 41}, {"glyph": "crane"}, {"colour": "#000"}, {"discret": "oui"}):
            with self.subTest(kw=kw), self.assertRaises(V.VaultError) as caught:
                V.create_vault(self.hq, self.admin, PASS, PASS, **{"label": "Ok", **kw})
            self.assertEqual(caught.exception.code, "validation")
        with self.assertRaises(V.VaultError):
            V.create_vault(self.hq, self.admin, PASS, PASS + "x", label="Ok")
        self.assertFalse((self.store / "vaults").exists() and any((self.store / "vaults").iterdir()))

    def test_legacy_vault_must_migrate_before_another_is_created(self):
        V.setup(self.hq, PASS, PASS)
        with self.assertRaises(V.VaultError) as caught:
            self.create()
        self.assertEqual(caught.exception.code, "migration")

    def test_at_most_twelve(self):
        V.set_acl_for_tests(False)
        import hq_forge_vault as mod
        saved = mod._initialise
        mod._initialise = lambda root, passphrase, *, vid=None, discret_label=None: (
            (root / "vault.json").write_text(json.dumps({"version": 1, "epoch": 1, "vid": vid}), encoding="utf-8"),
            {"recovery_key": "x", "acl": "skipped"})[1]
        try:
            for index in range(R.MAX_VAULTS):
                self.create("V%d" % index)
            with self.assertRaises(V.VaultError) as caught:
                self.create("Treize")
            self.assertEqual(caught.exception.code, "too_many")
        finally:
            mod._initialise = saved
        self.assertEqual(len(list((self.store / "vaults").iterdir())), R.MAX_VAULTS)

    def test_quota_per_vault_and_global(self):
        a = self.create("A")["vault"]["id"]
        b = self.create("B", PASS_B)["vault"]["id"]
        V.set_quota_for_tests(image_cap=1, global_images=3)
        V.unlock(self.hq, self.admin, PASS, vid=a)
        V.store_image(self.hq, self.admin, _png(), None, vid=a)
        with self.assertRaises(V.VaultError) as caught:
            V.store_image(self.hq, self.admin, _png(), None, vid=a)
        self.assertEqual(caught.exception.code, "quota")
        V.set_quota_for_tests(image_cap=5, global_images=2)
        V.unlock(self.hq, self.other, PASS_B, vid=b)
        V.store_image(self.hq, self.other, _png(), None, vid=b)
        with self.assertRaises(V.VaultError) as caught:
            V.store_image(self.hq, self.other, _png(), None, vid=b)
        self.assertEqual(caught.exception.code, "quota")
        V.set_quota_for_tests(global_bytes=1)
        with self.assertRaises(V.VaultError) as caught:
            V.store_image(self.hq, self.other, _png(), None, vid=b)
        self.assertEqual(caught.exception.code, "quota")

    def test_discret_name_never_in_clear_on_disk(self):
        made = self.create("Hirondelle secrete", discret=True)
        self.assertIsNone(made["vault"]["label"])
        reg = (self.store / "registry.json").read_bytes()
        self.assertNotIn(b"Hirondelle", reg)
        allowed = set(R.ENTRY_KEYS)
        for entry in json.loads(reg)["vaults"]:
            self.assertEqual(set(entry), allowed)
        V.unlock(self.hq, self.admin, PASS, vid=made["vault"]["id"])
        V.store_image(self.hq, self.admin, _png(), {"prompt": "phare rouge sous la pluie", "negative_prompt": "", "checkpoint": "m",
                      "sampler_name": "Euler", "scheduler": "", "width": 256, "height": 256, "steps": 4, "n_iter": 1,
                      "batch_size": 1, "seed": 1, "cfg_scale": 5.0}, vid=made["vault"]["id"])
        for path in self.store.rglob("*"):
            if path.is_file():
                raw = path.read_bytes()
                for needle in ("Hirondelle", "phare rouge"):
                    self.assertNotIn(needle.encode("utf-8"), raw, path)
                    self.assertNotIn(needle.encode("utf-16-le"), raw, path)

    def test_cleanup_reaches_every_vault(self):
        a = self.create("A")["vault"]["id"]
        stray = self.store / "vaults" / a / "index.bin.partial"
        stray.write_bytes(b"x")
        V.cleanup_partials(self.hq)
        self.assertFalse(stray.exists())

class MigrationTests(MultiBase):
    """V1.5: the single vault moves by rename into vaults/<vid>/, safely resumable and reversible."""

    def legacy_with_images(self):
        V.setup(self.hq, PASS, PASS)
        V.unlock(self.hq, self.admin, PASS)
        first = V.store_image(self.hq, self.admin, _png(), None)
        V.store_image(self.hq, self.admin, _png((200, 30, 30)), None)
        V.set_labels(self.hq, self.admin, first["id"], ["mer"], "ete")
        V.lock(self.admin)
        return self.snapshot(self.store)

    @staticmethod
    def snapshot(folder: Path) -> dict:
        return {p.relative_to(folder).as_posix(): p.read_bytes() for p in folder.rglob("*") if p.is_file()}

    def check_migrated(self, before: dict, vid: str) -> None:
        folder = self.store / "vaults" / vid
        self.assertEqual(self.snapshot(folder), before)  # same bytes: no copy, no re-encryption
        reg = json.loads((self.store / "registry.json").read_text(encoding="utf-8"))
        self.assertEqual(reg["legacy"], vid)
        self.assertEqual([(e["id"], e["label"], e["glyph"], e["discret"]) for e in reg["vaults"]], [(vid, "Coffre", "coffre", False)])
        self.assertFalse((self.store.parent / "forge-vault.migration.json").exists())
        self.assertFalse((self.store.parent / "forge-vault.migrating").exists())
        V.unlock(self.hq, self.admin, PASS)  # old alias
        self.assertEqual(len(V.page(self.hq, self.admin)["images"]), 2)
        V.unlock(self.hq, self.admin, PASS, vid=vid)
        rows = V.page(self.hq, self.admin, vid=vid)["images"]
        self.assertEqual(sorted(r["tags"] for r in rows), [[], ["mer"]])

    def test_migrate_and_replay(self):
        before = self.legacy_with_images()
        V.unlock(self.hq, self.admin, PASS)
        result = V._migrate(self.hq)
        self.assertTrue(result["migrated"])
        self.assertEqual(V.status(self.hq, self.admin)["unlocked"], False)  # every session was closed
        self.check_migrated(before, result["vid"])
        again = V._migrate(self.hq)
        self.assertEqual(again, {"migrated": False, "vid": result["vid"]})
        self.check_migrated(before, result["vid"])

    def test_cut_at_every_step_then_restart(self):
        for step in ("after_journal", "after_move", "after_container", "after_place", "after_registry"):
            with self.subTest(step=step):
                self.tearDown()
                self.setUp()
                before = self.legacy_with_images()
                V.set_migration_fault_for_tests(step)
                with self.assertRaises(OSError):
                    V._migrate(self.hq)
                V.set_migration_fault_for_tests(None)
                V.cleanup_partials(self.hq)  # what the next HQ start does
                if step == "after_journal":
                    self.assertEqual(self.snapshot(self.store), before)  # nothing had moved
                    self.assertFalse((self.store.parent / "forge-vault.migration.json").exists())
                    vid = V._migrate(self.hq)["vid"]
                else:
                    vid = json.loads((self.store / "registry.json").read_text(encoding="utf-8"))["legacy"]
                self.check_migrated(before, vid)

    def test_cancel_after_success_and_midway(self):
        before = self.legacy_with_images()
        V._migrate(self.hq)
        self.assertEqual(V.cancel_migration(self.hq), {"cancelled": True})
        self.assertEqual(self.snapshot(self.store), before)
        V.unlock(self.hq, self.admin, PASS)
        self.assertEqual(len(V.page(self.hq, self.admin)["images"]), 2)
        V.set_migration_fault_for_tests("after_container")
        with self.assertRaises(OSError):
            V._migrate(self.hq)
        V.set_migration_fault_for_tests(None)
        V.cancel_migration(self.hq)
        self.assertEqual(self.snapshot(self.store), before)
        self.assertFalse((self.store.parent / "forge-vault.migrating").exists())

    def test_cancel_refused_once_another_vault_exists(self):
        before = self.legacy_with_images()
        V._migrate(self.hq)
        V.create_vault(self.hq, self.admin, PASS_B, PASS_B, label="Deux")
        with self.assertRaises(V.VaultError):
            V.cancel_migration(self.hq)
        vid = json.loads((self.store / "registry.json").read_text(encoding="utf-8"))["legacy"]
        self.assertEqual(self.snapshot(self.store / "vaults" / vid), before)

    def test_two_copies_are_never_guessed(self):
        before = self.legacy_with_images()
        V.set_migration_fault_for_tests("after_move")
        with self.assertRaises(OSError):
            V._migrate(self.hq)
        V.set_migration_fault_for_tests(None)
        # Someone recreates a vault at the top meanwhile: resume refuses, both stay.
        self.store.mkdir()
        (self.store / "vault.json").write_text("{}", encoding="utf-8")
        with self.assertRaises(V.VaultError):
            V.resume_migration(self.hq)
        self.assertEqual(self.snapshot(self.store.parent / "forge-vault.migrating"), before)

    def test_empty_or_tampered_journal(self):
        with self.assertRaises(V.VaultError):
            V._migrate(self.hq)  # nothing to migrate
        self.legacy_with_images()
        (self.store.parent / "forge-vault.migration.json").write_text('{"version":1,"vid":"../x"}', encoding="utf-8")
        with self.assertRaises(V.VaultError) as caught:
            V.resume_migration(self.hq)
        self.assertEqual(caught.exception.code, "registry")
        self.assertTrue((self.store / "vault.json").is_file())

class MigrationGateTests(MultiBase):
    """V1.6: migration only when explicitly asked after the backup offer; never silently."""

    def test_nothing_migrates_by_itself(self):
        V.setup(self.hq, PASS, PASS)
        V.unlock(self.hq, self.admin, PASS)
        V.status(self.hq, self.admin)
        V.cleanup_partials(self.hq)
        J.recover(self.hq)
        V.page(self.hq, self.admin)
        self.assertTrue((self.store / "vault.json").is_file())
        self.assertFalse((self.store / "registry.json").exists())
        self.assertEqual(V.layout(self.hq), "legacy")

    def test_migration_needs_a_session_and_the_backup_offer(self):
        V.setup(self.hq, PASS, PASS)
        with self.assertRaises(V.VaultError) as caught:
            V.migrate_legacy(self.hq, None, backup_offered=True)
        self.assertEqual(caught.exception.code, "locked")
        for offered in (True, False, None, "true", 1):
            with self.subTest(offered=offered), self.assertRaises(V.VaultError) as caught:
                V.migrate_legacy(self.hq, self.admin, backup_offered=offered)
            self.assertEqual(caught.exception.code, "backup_first")  # a client flag alone never migrates
        self.assertEqual(V.layout(self.hq), "legacy")
        V.acknowledge_backup_offer(self.hq, self.admin)
        result = V.migrate_legacy(self.hq, self.admin)
        self.assertTrue(result["migrated"])
        self.assertEqual(V.layout(self.hq), "multi")

    def test_downloading_the_backup_counts_as_the_offer(self):
        V.setup(self.hq, PASS, PASS)
        V.unlock(self.hq, self.admin, PASS)
        self.assertTrue(V.backup_bytes(self.hq, self.admin))
        self.assertTrue(V.migrate_legacy(self.hq, self.admin)["migrated"])

    def test_the_offer_belongs_to_one_session_and_is_used_once(self):
        other = "other-session-token-0123456789"
        V.setup(self.hq, PASS, PASS)
        V.acknowledge_backup_offer(self.hq, other)
        with self.assertRaises(V.VaultError) as caught:
            V.migrate_legacy(self.hq, self.admin, backup_offered=True)
        self.assertEqual(caught.exception.code, "backup_first")
        V.acknowledge_backup_offer(self.hq, self.admin)
        V.set_migration_fault_for_tests("after_journal")
        with self.assertRaises(V.VaultError):
            V.migrate_legacy(self.hq, self.admin)
        V.set_migration_fault_for_tests(None)
        with self.assertRaises(V.VaultError) as caught:
            V.migrate_legacy(self.hq, self.admin)  # the record was used up by the failed attempt
        self.assertEqual(caught.exception.code, "backup_first")
        V.drop_session(other)  # logout forgets the offer
        with self.assertRaises(V.VaultError) as caught:
            V.migrate_legacy(self.hq, other)
        self.assertEqual(caught.exception.code, "backup_first")
        self.assertEqual(V.layout(self.hq), "legacy")

    def test_the_offer_expires(self):
        V.setup(self.hq, PASS, PASS)
        V.acknowledge_backup_offer(self.hq, self.admin)
        V._backup_offers[self.admin] -= V.BACKUP_OFFER_TTL_SEC + 1
        with self.assertRaises(V.VaultError) as caught:
            V.migrate_legacy(self.hq, self.admin)
        self.assertEqual(caught.exception.code, "backup_first")

    def test_no_offer_outside_the_single_layout(self):
        with self.assertRaises(V.VaultError) as caught:
            V.acknowledge_backup_offer(self.hq, self.admin)  # nothing to back up yet
        self.assertEqual(caught.exception.code, "validation")

    def test_failed_rename_reports_and_loses_nothing(self):
        V.setup(self.hq, PASS, PASS)
        V.set_migration_fault_for_tests("after_journal")
        V.acknowledge_backup_offer(self.hq, self.admin)
        with self.assertRaises(V.VaultError) as caught:
            V.migrate_legacy(self.hq, self.admin)
        self.assertEqual(caught.exception.code, "migration_failed")
        self.assertEqual(V.layout(self.hq), "legacy")
        V.unlock(self.hq, self.admin, PASS)

class SessionTests(MultiBase):
    """V2.1: sessions keyed by (token, vault), with TTL; lock_all, logout and leaving close everything."""

    def two(self):
        a = V.create_vault(self.hq, self.admin, PASS, PASS, label="A")["vault"]["id"]
        b = V.create_vault(self.hq, self.admin, PASS_B, PASS_B, label="B")["vault"]["id"]
        return a, b

    def test_open_key_serves_only_its_vault(self):
        a, b = self.two()
        V.unlock(self.hq, self.admin, PASS, vid=a)
        for call in (lambda: V.page(self.hq, self.admin, vid=b), lambda: V.store_image(self.hq, self.admin, _png(), None, vid=b),
                     lambda: V.backup_bytes(self.hq, self.admin, vid=b), lambda: V.search(self.hq, self.admin, {"q": ""}, vid=b)):
            with self.assertRaises(V.VaultError) as caught:
                call()
            self.assertEqual(caught.exception.code, "locked")
        self.assertTrue(V.status(self.hq, self.admin, vid=a)["unlocked"])
        self.assertFalse(V.status(self.hq, self.admin, vid=b)["unlocked"])
        self.assertEqual(list((self.store / "vaults" / b / "objects").iterdir()), [])

    def test_last_used_day_recorded_on_unlock(self):
        a, b = self.two()
        V.unlock(self.hq, self.admin, PASS, vid=a)
        reg = {e["id"]: e for e in json.loads((self.store / "registry.json").read_text(encoding="utf-8"))["vaults"]}
        self.assertEqual(reg[a]["last_used_day"], R.today())
        self.assertIsNone(reg[b]["last_used_day"])
        self.assertRegex(reg[a]["last_used_day"], r"^\d{4}-\d{2}-\d{2}$")

    def test_ttl_per_vault(self):
        a, _b = self.two()
        V.set_ttl_for_tests(0.05)
        V.unlock(self.hq, self.admin, PASS, vid=a)
        import time
        time.sleep(0.1)
        self.assertFalse(V.status(self.hq, self.admin, vid=a)["unlocked"])
        self.assertEqual(V._sessions, {})

    def test_lock_all_logout_and_leaving_close_everything(self):
        a, b = self.two()
        for close in (lambda: V.lock_all(), lambda: (V.drop_session(self.admin), V.drop_session(self.other)),
                      lambda: (V.lock(self.admin), V.lock(self.other)), lambda: V.retain_only(set())):
            V.unlock(self.hq, self.admin, PASS, vid=a)
            V.unlock(self.hq, self.other, PASS_B, vid=b)
            V.store_image(self.hq, self.admin, _png(), None, vid=a)
            V.search(self.hq, self.admin, {"q": "phare"}, vid=a)
            self.assertGreater(V.search_cache_size_for_tests(), 0)
            close()
            self.assertEqual(V._sessions, {})  # keys and cached index rows gone from memory
            self.assertEqual(V.search_cache_size_for_tests(), 0)
            for token, vid in ((self.admin, a), (self.other, b)):
                self.assertFalse(V.status(self.hq, token, vid=vid)["unlocked"])

class OneOpenTests(MultiBase):
    """V2.2: one vault open per session; opening one locks the other."""

    def test_opening_b_locks_a_and_wipes_its_key(self):
        a = V.create_vault(self.hq, self.admin, PASS, PASS, label="A")["vault"]["id"]
        b = V.create_vault(self.hq, self.admin, PASS_B, PASS_B, label="B")["vault"]["id"]
        V.unlock(self.hq, self.admin, PASS, vid=a)
        key_a = V._sessions[self.admin]["key"]
        V.unlock(self.hq, self.admin, PASS_B, vid=b)
        self.assertEqual(bytes(key_a), b"\x00" * len(key_a))  # the old key buffer was wiped
        self.assertFalse(V.status(self.hq, self.admin, vid=a)["unlocked"])
        self.assertTrue(V.status(self.hq, self.admin, vid=b)["unlocked"])
        self.assertEqual(len(V._sessions), 1)

    def test_failed_try_on_b_keeps_a(self):
        a = V.create_vault(self.hq, self.admin, PASS, PASS, label="A")["vault"]["id"]
        b = V.create_vault(self.hq, self.admin, PASS_B, PASS_B, label="B")["vault"]["id"]
        V.unlock(self.hq, self.admin, PASS, vid=a)
        with self.assertRaises(V.VaultError):
            V.unlock(self.hq, self.admin, "wrong but long enough", vid=b)
        self.assertTrue(V.status(self.hq, self.admin, vid=a)["unlocked"])

class AttemptTests(MultiBase):
    """V2.3: tries limited per (session, vault) and globally; N vaults never multiply the rate."""

    WRONG = "definitely the wrong phrase"

    def vaults(self, n=3):
        return [V.create_vault(self.hq, self.admin, PASS, PASS, label="V%d" % i)["vault"]["id"] for i in range(n)]

    def wrong(self, token, vid):
        with self.assertRaises(V.VaultError) as caught:
            V.unlock(self.hq, token, self.WRONG, vid=vid)
        return caught.exception.code

    def test_spreading_over_vaults_and_sessions_hits_the_same_global_cap(self):
        ids = self.vaults(3)
        tokens = [self.admin, self.other, _token("third")]
        codes = [self.wrong(tokens[i % 3], ids[i % 3]) for i in range(V.FAILS_BEFORE_THROTTLE)]
        self.assertEqual(codes, ["passphrase"] * V.FAILS_BEFORE_THROTTLE)
        for token in tokens:
            for vid in ids:
                self.assertEqual(self.wrong(token, vid), "throttled")
        with self.assertRaises(V.VaultError) as caught:
            V.unlock(self.hq, self.admin, PASS, vid=ids[0])  # even the right phrase waits
        self.assertEqual(caught.exception.code, "throttled")

    def test_counts_are_per_session_and_vault(self):
        a, b = self.vaults(2)
        for _ in range(3):
            self.wrong(self.admin, a)
        with V._FAIL_LOCK:
            slots = dict(V._failures)
        self.assertEqual(set(slots), {self.admin + "|" + a})
        self.assertEqual(slots[self.admin + "|" + a][0], 3)
        self.assertNotIn(a, json.dumps(V.status(self.hq, self.admin, vid=b)))

    def test_knowing_one_phrase_does_not_reset_the_global_count(self):
        a, b = self.vaults(2)
        # Both vaults share PASS here: the guesser knows B's phrase and keeps guessing A.
        for _ in range(V.FAILS_BEFORE_THROTTLE - 1):
            self.wrong(self.other, a)
        V.unlock(self.hq, self.other, PASS, vid=b)  # success elsewhere
        self.wrong(self.other, a)
        self.assertEqual(self.wrong(self.admin, a), "throttled")

    def test_global_count_decays_after_a_quiet_window(self):
        a, = self.vaults(1)
        saved = V.THROTTLE_SEC
        V.THROTTLE_SEC = 0.05
        try:
            for _ in range(V.FAILS_BEFORE_THROTTLE - 1):
                self.wrong(self.admin, a)
            import time
            time.sleep(0.1)
            self.assertEqual(self.wrong(self.other, a), "passphrase")
            self.assertEqual(self.wrong(self.other, a), "passphrase")
        finally:
            V.THROTTLE_SEC = saved

    def test_logout_does_not_reset_guessing(self):
        a, = self.vaults(1)
        for _ in range(V.FAILS_BEFORE_THROTTLE):
            self.wrong(self.admin, a)
        V.drop_session(self.admin)
        V.lock_all()
        self.assertEqual(self.wrong(self.admin, a), "throttled")

if __name__ == "__main__":
    unittest.main()