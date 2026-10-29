"""Multi-vault V6: per-vault backup ZIP, restore as a new vault (never in place), delete a vault
(passphrase + typed SUPPRIMER, best-effort overwrite, crash-safe), passphrase and recovery per vault.
Disposable root and vault folder, fake PINs, no Forge, never the real vault."""

from __future__ import annotations

import json
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_hq_forge_vault_multi_http import JSON, PASS, PASS_B, MultiHttp, _png  # noqa: E402
import hq_forge_vault as V  # noqa: E402
import iphone_bridge as B  # noqa: E402

BIN = {"Content-Type": "application/octet-stream"}


def framed(payload: bytes, **meta) -> bytes:
    head = json.dumps(meta).encode("utf-8")
    return struct.pack(">I", len(head)) + head + payload


class V6(MultiHttp):
    def open_with_image(self, vid, passphrase=PASS):
        base = "/api/forge/vaults/" + vid
        self.assertEqual(self.post(self.admin, base + "/unlock", {"passphrase": passphrase})[0], 200)
        status, _h, raw = self.admin.req(base + "/import", "POST", _png(), BIN)
        self.assertEqual(status, 201, raw)
        return base, json.loads(raw)["id"]

    def backup(self, vid, passphrase=PASS):
        base, image_id = self.open_with_image(vid, passphrase)
        status, headers, payload = self.admin.req(base + "/backup")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "application/zip")
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        return payload, image_id

    def restore(self, payload, **meta):
        return self.admin.json("/api/forge/vaults/restore", "POST", data=framed(payload, **meta), headers=BIN)

    def listing(self):
        return self.admin.json("/api/forge/vaults")[1]["vaults"]


class Backup(V6):
    def test_per_vault_backup_needs_that_vault_open(self):
        a, b = self.made("A"), self.made("B", PASS_B)
        self.assertEqual(self.admin.req("/api/forge/vaults/" + a + "/backup")[0], 401)
        self.open_with_image(a)
        self.assertEqual(self.admin.req("/api/forge/vaults/" + b + "/backup")[0], 401)  # only the open vault
        self.assertEqual(self.admin.req("/api/forge/vaults/vlt-ffffffffffffffff/backup")[0], 404)

    def test_zip_holds_only_sealed_files(self):
        payload, _image = self.backup(self.made("Visible"))
        self.assertNotIn(b"Visible", payload)
        self.assertNotIn(b"\x89PNG", payload)


class Restore(V6):
    def test_restore_creates_a_new_vault_with_a_new_id_and_never_replaces(self):
        a = self.made("Album")
        payload, image_id = self.backup(a)
        status, body = self.restore(payload, passphrase=PASS, label="Copie")
        self.assertEqual(status, 201, body)
        new = body["vault"]["id"]
        self.assertNotEqual(new, a)
        self.assertEqual((body["vault"]["label"], body["unlocked"], body["renamed"]), ("Copie", False, False))
        self.assertEqual([v["id"] for v in self.listing()], [a, new])
        header = json.loads((self.store / "vaults" / new / "vault.json").read_text(encoding="utf-8"))
        self.assertEqual(header["vid"], new)
        # the source vault is still open and untouched; the copy opens with the same phrase and holds the image
        self.assertEqual(self.admin.json("/api/forge/vaults/" + a + "/gallery")[0], 200)
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + new + "/unlock", {"passphrase": PASS})[0], 200)
        page = self.admin.json("/api/forge/vaults/" + new + "/gallery")[1]
        self.assertEqual([i["id"] for i in page["images"]], [image_id])

    def test_name_already_taken_gets_a_number(self):
        a = self.made("Album")
        payload, _image = self.backup(a)
        first = self.restore(payload, passphrase=PASS, label="album")[1]
        second = self.restore(payload, passphrase=PASS, label="Album")[1]
        self.assertEqual((first["vault"]["label"], first["renamed"]), ("album (2)", True))
        self.assertEqual(second["vault"]["label"], "Album (3)")

    def test_default_name_and_long_name_stays_within_limit(self):
        payload, _image = self.backup(self.made("Coffre restauré"))
        body = self.restore(payload, passphrase=PASS)[1]
        self.assertEqual(body["vault"]["label"], "Coffre restauré (2)")
        long = "L" * V.registry.LABEL_MAX
        self.made(long, PASS_B)
        body = self.restore(payload, passphrase=PASS, label=long)[1]
        self.assertEqual(len(body["vault"]["label"]), V.registry.LABEL_MAX)
        self.assertTrue(body["vault"]["label"].endswith(" (2)"))

    def test_discret_backup_comes_back_discret_with_its_sealed_name(self):
        token = self.token(self.admin)
        a = V.create_vault(B.ROOT, token, PASS, PASS, label="Hirondelle", discret=True)["vault"]["id"]
        payload, _image = self.backup(a)
        body = self.restore(payload, passphrase=PASS, label="ignored")[1]
        new = body["vault"]["id"]
        self.assertTrue(body["vault"]["discret"])
        self.assertIsNone(body["vault"]["label"])
        self.assertNotIn("Hirondelle", (self.store / "registry.json").read_text(encoding="utf-8"))
        self.post(self.admin, "/api/forge/vaults/" + new + "/unlock", {"passphrase": PASS})
        row = next(v for v in self.listing() if v["id"] == new)
        self.assertEqual(row["label"], "Hirondelle")

    def test_wrong_phrase_corrupt_zip_and_full_list_leave_nothing_behind(self):
        a = self.made("A")
        payload, _image = self.backup(a)
        before = sorted(p.name for p in (self.store / "vaults").iterdir())
        self.assertEqual(self.restore(payload, passphrase="not the phrase at all")[0], 401)
        self.assertEqual(self.restore(b"PK\x03\x04" + b"x" * 64, passphrase=PASS)[0], 409)
        self.assertEqual(self.restore(payload, passphrase=PASS, label="<b>")[0], 400)
        self.assertEqual(sorted(p.name for p in (self.store / "vaults").iterdir()), before)
        self.assertEqual(len(self.listing()), 1)
        for n in range(V.registry.MAX_VAULTS - 1):
            self.made("V%d" % n)
        self.assertEqual(self.restore(payload, passphrase=PASS)[0], 409)

    def test_global_quota_is_checked(self):
        payload, _image = self.backup(self.made("A"))
        V.set_quota_for_tests(global_images=1)
        status, body = self.restore(payload, passphrase=PASS)
        self.assertEqual((status, body.get("code")), (409, "quota"))
        self.assertEqual(len(self.listing()), 1)

    def test_restore_in_place_is_never_routed(self):
        a = self.made("A")
        payload, _image = self.backup(a)
        status, _h, _b = self.admin.req("/api/forge/vaults/" + a + "/restore", "POST", framed(payload, passphrase=PASS), BIN)
        self.assertIn(status, (400, 404))  # a binary body is refused as JSON before routing; never a restore
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + a + "/restore", {"passphrase": PASS})[0], 404)
        self.assertEqual([v["id"] for v in self.listing()], [a])


class Delete(V6):
    def destroy(self, vid, passphrase=PASS, confirm="SUPPRIMER"):
        return self.post(self.admin, "/api/forge/vaults/" + vid + "/destroy", {"passphrase": passphrase, "confirm": confirm})

    def test_delete_needs_phrase_and_typed_word(self):
        a, b = self.made("A"), self.made("B", PASS_B)
        self.assertEqual(self.destroy(a, confirm="supprime")[1]["code"], "confirm")
        self.assertEqual(self.destroy(a, passphrase=PASS_B)[0], 401)
        self.assertEqual(len(self.listing()), 2)
        status, body = self.destroy(a, confirm=" supprimer ")
        self.assertEqual((status, body), (200, {"deleted": True, "wiped": True}))
        self.assertEqual([v["id"] for v in self.listing()], [b])
        self.assertEqual(sorted(p.name for p in (self.store / "vaults").iterdir()), [b])
        self.assertEqual(self.destroy(a)[0], 404)

    def test_delete_closes_the_open_vault_and_keeps_others(self):
        a = self.made("A")
        base, _image = self.open_with_image(a)
        self.assertEqual(self.destroy(a)[0], 200)
        self.assertEqual(self.admin.json(base + "/gallery")[0], 404)
        listing = self.admin.json("/api/forge/vaults")[1]
        self.assertIsNone(listing["open"])

    def test_tries_are_counted(self):
        a = self.made("A")
        for _ in range(V.FAILS_BEFORE_THROTTLE):
            self.destroy(a, passphrase="wrong but long enough")
        self.assertEqual(self.destroy(a)[0], 429)
        self.assertEqual(len(self.listing()), 1)

    def test_files_are_overwritten_before_removal(self):
        a = self.made("A")
        self.open_with_image(a)
        seen: list[tuple[str, bool]] = []
        real_unlink = Path.unlink
        originals = {p.name: p.read_bytes() for p in (self.store / "vaults" / a).rglob("*") if p.is_file()}

        def spy(path, *args, **kw):
            if path.name in originals:
                now = path.read_bytes()
                seen.append((path.name, len(now) == len(originals[path.name]) and now != originals[path.name]))
            return real_unlink(path, *args, **kw)

        Path.unlink = spy
        try:
            self.assertEqual(self.destroy(a)[0], 200)
        finally:
            Path.unlink = real_unlink
        self.assertEqual(sorted(name for name, _ok in seen), sorted(originals))
        self.assertTrue(all(ok for _name, ok in seen), seen)

    def test_cut_before_registry_puts_the_vault_back(self):
        a = self.made("A")
        V.set_delete_fault_for_tests("after_rename")
        self.assertEqual(self.destroy(a)[0], 409)
        V.set_delete_fault_for_tests(None)
        self.assertTrue((self.store / "vaults" / a / "vault.json").is_file())
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + a + "/unlock", {"passphrase": PASS})[0], 200)

    def test_cut_after_registry_is_finished_by_cleanup(self):
        a, b = self.made("A"), self.made("B", PASS_B)
        V.set_delete_fault_for_tests("after_registry")
        self.assertEqual(self.destroy(a)[1], {"deleted": True, "wiped": False})
        V.set_delete_fault_for_tests(None)
        self.assertTrue((self.store / "vaults" / (a + ".deleted")).is_dir())
        V.cleanup_partials(B.ROOT)
        self.assertEqual(sorted(p.name for p in (self.store / "vaults").iterdir()), [b])

    def test_tombstone_still_listed_is_put_back_by_cleanup(self):
        a = self.made("A")
        folder = self.store / "vaults" / a
        folder.rename(folder.with_name(a + ".deleted"))  # as if cut between the rename and the registry write
        V.cleanup_partials(B.ROOT)
        self.assertTrue((folder / "vault.json").is_file())

    def test_deleting_the_migrated_vault_clears_the_alias(self):
        a = self.made("A")
        reg = json.loads((self.store / "registry.json").read_text(encoding="utf-8"))
        reg["legacy"] = a
        (self.store / "registry.json").write_text(json.dumps(reg), encoding="utf-8")
        header = json.loads((self.store / "vaults" / a / "vault.json").read_text(encoding="utf-8"))
        header.pop("vid")
        (self.store / "vaults" / a / "vault.json").write_text(json.dumps(header), encoding="utf-8")
        self.assertEqual(self.destroy(a)[0], 200)
        self.assertIsNone(json.loads((self.store / "registry.json").read_text(encoding="utf-8"))["legacy"])

    def test_names_never_in_logs(self):
        a = self.made("Hirondelle")
        self.destroy(a)
        self.assertFalse(any("Hirondelle" in line for line in self.logged))


class Markup(unittest.TestCase):
    def test_forge_element_ids_are_unique(self):
        # V6 once reused forge-vault-delete (the viewer's image delete) for the vault-delete form:
        # getElementById then bound the image handler to the wrong element.
        import collections
        import re
        source = (Path(__file__).resolve().parents[1] / "iphone_bridge.py").read_text(encoding="utf-8")
        counts = collections.Counter(re.findall(r'id="(forge-[^"]+)"', source))
        self.assertEqual([name for name, n in counts.items() if n > 1], [])


class PhraseAndRecovery(V6):
    def test_change_phrase_and_rotate_recovery_close_only_that_vault(self):
        a, b = self.made("A"), self.made("B", PASS_B)
        new = "a brand new long phrase"
        self.post(self.admin, "/api/forge/vaults/" + a + "/unlock", {"passphrase": PASS})
        status, body = self.post(self.admin, "/api/forge/vaults/" + a + "/passphrase", {"current": PASS, "passphrase": new, "confirm": new})
        self.assertEqual((status, body["changed"]), (200, True))
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + a + "/unlock", {"passphrase": PASS})[0], 401)
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + a + "/unlock", {"passphrase": new})[0], 200)
        status, body = self.post(self.admin, "/api/forge/vaults/" + a + "/recovery", {"passphrase": new})
        self.assertEqual(status, 200)
        self.assertTrue(body["recovery_key"])
        self.assertEqual(self.post(self.admin, "/api/forge/vaults/" + b + "/unlock", {"passphrase": PASS_B})[0], 200)


if __name__ == "__main__":
    unittest.main()
