"""Vault health check: a read-only summary of every vault (no key) and a deep check of the open vault
(every object decrypted). Counts and codes only, nothing repaired. Disposable root and vault folder,
fake PINs, no Forge, never the real vault."""

from __future__ import annotations

import datetime
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_hq_forge_vault_multi_http import JSON, PASS, PASS_B, MultiHttp, _png  # noqa: E402
import hq_forge_vault as V  # noqa: E402
import iphone_bridge as B  # noqa: E402

BIN = {"Content-Type": "application/octet-stream"}


class Health(MultiHttp):
    def open_with_images(self, vid, n=1, passphrase=PASS):
        base = "/api/forge/vaults/" + vid
        self.assertEqual(self.post(self.admin, base + "/unlock", {"passphrase": passphrase})[0], 200)
        ids = []
        for _ in range(n):
            status, _h, raw = self.admin.req(base + "/import", "POST", _png(), BIN)
            self.assertEqual(status, 201, raw)
            ids.append(json.loads(raw)["id"])
        return base, ids

    def summary(self):
        status, body = self.admin.json("/api/forge/vaults/health")
        self.assertEqual(status, 200, body)
        return body

    def row(self, vid):
        return next(r for r in self.summary()["vaults"] if r["id"] == vid)

    def header(self, vid):
        path = self.store / "vaults" / vid / "vault.json"
        return path, json.loads(path.read_text(encoding="utf-8"))


class Summary(Health):
    def test_fresh_vault_warns_only_about_backup(self):
        a = self.made("A")
        row = self.row(a)
        self.assertEqual((row["state"], row["problems"], row["images"], row["number"]), ("warn", ["never_backed_up"], 0, 1))
        self.assertIsNone(row["backup_day"])

    def test_backup_records_the_day_and_clears_the_warning(self):
        a = self.made("A")
        base, _ids = self.open_with_images(a, 2)
        self.assertEqual(self.admin.req(base + "/backup")[0], 200)
        self.post(self.admin, "/api/forge/vaults/lock", {})
        row = self.row(a)  # works locked: no key needed
        self.assertEqual((row["state"], row["problems"], row["images"], row["backup_age_days"]), ("ok", [], 2, 0))
        self.assertEqual(row["backup_day"], datetime.date.today().isoformat())
        self.assertGreater(row["bytes"], 0)
        totals = self.summary()["totals"]
        self.assertEqual((totals["images"], totals["vaults"], totals["unlisted_folders"]), (2, 1, 0))

    def test_old_backup_is_flagged(self):
        a = self.made("A")
        path, header = self.header(a)
        header["backup_day"] = (datetime.date.today() - datetime.timedelta(days=V.BACKUP_STALE_DAYS + 1)).isoformat()
        path.write_text(json.dumps(header), encoding="utf-8")
        self.assertEqual(self.row(a)["problems"], ["backup_old"])

    def test_disk_problems_are_reported_not_repaired(self):
        a, b, c = self.made("A"), self.made("B", PASS_B), self.made("C")
        (self.store / "vaults" / a / "index.bin").unlink()
        (self.store / "vaults" / b / "objects" / "note.txt").write_text("x", encoding="utf-8")
        (self.store / "vaults" / b / "objects" / ("pvt-" + "1" * 24 + ".bin.partial")).write_bytes(b"x")
        path, header = self.header(c)
        header["vid"] = "vlt-" + "0" * 16
        path.write_text(json.dumps(header), encoding="utf-8")
        rows = {r["id"]: r for r in self.summary()["vaults"]}
        self.assertEqual(rows[a]["state"], "error")
        self.assertIn("index", rows[a]["problems"])
        self.assertEqual(rows[b]["state"], "warn")
        self.assertIn("stray", rows[b]["problems"])
        self.assertIn("partials", rows[b]["problems"])
        self.assertEqual((rows[c]["state"], rows[c]["problems"]), ("error", ["binding"]))
        self.assertTrue((self.store / "vaults" / b / "objects" / "note.txt").exists(), "nothing is removed")

    def test_missing_folder_and_unlisted_folder(self):
        a = self.made("A")
        (self.store / "vaults" / a).rename(self.store / "vaults" / "elsewhere")
        (self.store / "vaults" / ("vlt-" + "e" * 16)).mkdir()
        body = self.summary()
        self.assertEqual(body["vaults"][0]["problems"][:1], ["missing"])
        self.assertEqual(body["totals"]["unlisted_folders"], 1)

    def test_no_names_in_the_summary(self):
        token = self.token(self.admin)
        V.create_vault(B.ROOT, token, PASS, PASS, label="Hirondelle", discret=True)
        self.made("Album clair")
        raw = self.admin.req("/api/forge/vaults/health")[2].decode("utf-8")
        self.assertNotIn("Hirondelle", raw)
        self.assertNotIn("Album clair", raw)
        self.assertNotIn("pvt-", raw)

    def test_before_any_vault(self):
        self.assertEqual(self.summary(), {"layout": "empty", "vaults": [], "totals": None})


class Deep(Health):
    def check(self, vid):
        return self.post(self.admin, "/api/forge/vaults/" + vid + "/check", {})

    def test_healthy_vault(self):
        a = self.made("A")
        base, ids = self.open_with_images(a, 3)
        self.post(self.admin, base + "/images/" + ids[0] + "/triage", {"state": "reject"})
        status, body = self.check(a)
        self.assertEqual(status, 200)
        self.assertEqual({k: body[k] for k in ("index", "checked", "ok", "unreadable", "missing", "orphans", "trash", "healthy")},
                         {"index": "ok", "checked": 3, "ok": 3, "unreadable": 0, "missing": 0, "orphans": 0, "trash": 1, "healthy": True})

    def test_needs_the_vault_open_here(self):
        a, b = self.made("A"), self.made("B", PASS_B)
        self.assertEqual(self.check(a)[0], 401)
        self.open_with_images(a)
        self.assertEqual(self.check(b)[0], 401)
        self.assertEqual(self.check("vlt-ffffffffffffffff")[0], 404)

    def test_damage_is_counted(self):
        a = self.made("A")
        _base, ids = self.open_with_images(a, 3)
        objects = self.store / "vaults" / a / "objects"
        blob = bytearray((objects / (ids[0] + ".bin")).read_bytes())
        blob[-1] ^= 0xFF
        (objects / (ids[0] + ".bin")).write_bytes(bytes(blob))
        (objects / (ids[1] + ".bin")).unlink()
        (objects / ("pvt-" + "a" * 24 + ".bin")).write_bytes(b"orphan")
        status, body = self.check(a)
        self.assertEqual(status, 200)
        self.assertEqual((body["checked"], body["ok"], body["unreadable"], body["missing"], body["orphans"], body["healthy"]),
                         (2, 1, 1, 1, 1, False))
        self.assertTrue((objects / ("pvt-" + "a" * 24 + ".bin")).exists(), "the orphan is left alone")

    def test_sealed_name_and_icon_are_checked(self):
        token = self.token(self.admin)
        a = V.create_vault(B.ROOT, token, PASS, PASS, label="Hirondelle", discret=True)["vault"]["id"]
        base, ids = self.open_with_images(a)
        self.post(self.admin, base + "/icon", {"image_id": ids[0]})
        body = self.check(a)[1]
        self.assertEqual((body["label"], body["icon"], body["healthy"]), ("ok", "ok", True))
        (self.store / "vaults" / a / V.ICON_FILE).write_bytes(b"garbage" * 8)
        body = self.check(a)[1]
        self.assertEqual((body["icon"], body["healthy"]), ("unreadable", False))
        raw = json.dumps(body)
        self.assertNotIn("Hirondelle", raw)
        self.assertNotIn("pvt-", raw)

    def test_changes_nothing(self):
        a = self.made("A")
        self.open_with_images(a, 2)
        folder = self.store / "vaults" / a
        before = {p.relative_to(folder).as_posix(): p.read_bytes() for p in folder.rglob("*") if p.is_file()}
        self.check(a)
        after = {p.relative_to(folder).as_posix(): p.read_bytes() for p in folder.rglob("*") if p.is_file()}
        self.assertEqual(before, after)


class Routes(Health):
    def test_admin_and_csrf(self):
        a = self.made("A")
        body = json.dumps({}).encode()
        self.assertEqual(self.anon.req("/api/forge/vaults/health")[0], 401)
        self.assertEqual(self.upload.req("/api/forge/vaults/health")[0], 403)
        path = "/api/forge/vaults/" + a + "/check"
        self.assertEqual(self.anon.req(path, "POST", body, JSON)[0], 401)
        self.assertEqual(self.upload.req(path, "POST", body, JSON)[0], 403)
        self.assertEqual(self.admin.req(path, "POST", body, JSON, origin=False)[0], 403)
        self.assertEqual(self.admin.req(path, "POST", body, {**JSON, "Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.admin.req("/api/forge/vaults/" + a + "/check")[0], 404)  # POST only


if __name__ == "__main__":
    unittest.main()
