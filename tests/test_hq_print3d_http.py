"""Atelier 3D over the real bridge handler: models/get, the brief list, the single-read overview.

The bridge is a stdlib ``ThreadingHTTPServer`` (not Flask): this module runs the production
``Handler`` on a disposable root with fake PINs, the same arrangement as
``tests/test_hq_robotics_http.py`` and ``tests/carnet_test_server.py``. Nothing here reads the
live checkout, the real ``bridge_config.json`` or the network beyond 127.0.0.1.

One class is different on purpose: ``CameraFrameGateTests`` calls the camera method with a stub
``self`` and a fake hub on a fake clock. No socket, no server, no printer.
"""
import hashlib
import json
import os
import struct
import tempfile
import threading
import time
import types
import unittest
import zipfile
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import hq_print3d
import iphone_bridge as bridge
from tests import hq_temp_janitor
from tests.test_hq_diagnostics_http import Client

ADMIN, UPLOAD = "58390242", "97415689"
NOTE_WORD = "kalimba"          # lives only in a note: proves the search still reads it
NOTE = "Profil " + NOTE_WORD + " 0.2 mm, 4 périmètres, support arbre. " + "réglage " * 120
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


@contextmanager
def _root():
    root = Path(tempfile.mkdtemp(prefix="hq-print3d-http-"))
    hq_temp_janitor.mark(root)
    try:
        yield root
    finally:
        for _ in range(6):
            hq_temp_janitor.safe_rmtree(root)
            if not root.exists():
                break
            time.sleep(.05)
        if root.exists():
            hq_temp_janitor.mark(root)


@contextmanager
def fixture():
    with _root() as root:
        for name in ("Inbox", "Uni", "Print"):
            (root / name).mkdir()
        (root / "Print" / "bracket.stl").write_bytes(b"solid bracket\nendsolid bracket\n")
        with zipfile.ZipFile(root / "Print" / "vase.3mf", "w") as zf:
            zf.writestr("Metadata/plate_1.png", PNG)
            zf.writestr("3D/3dmodel.model", "<model/>")
        cfg = {**bridge.CONFIG, "pin": "", "users": [
            {"id": "p3d_admin", "name": "Atelier test", "pin": ADMIN, "role": "admin"},
            {"id": "p3d_upload", "name": "Uploader test", "pin": UPLOAD, "role": "upload"},
        ], "push_enabled": False, "discord_webhook_url": "", "public_base_urls": [],
            "client_debug_hud": False, "client_debug_agent": False,
            "backup_dir": str(root / "backups"), "emergency_lockdown": False}
        diag = {"root": None, "assets": None, "last_probe": None}

        class Quiet(bridge.Handler):
            def log_message(self, *_):
                pass

        # No printer link threads: a poll must not reach out to a LAN address from a test.
        with (patch.dict(os.environ, {"HQ_CLIENT_DEBUG": "0"}),
              patch.object(hq_print3d.Controller, "ensure_links", lambda self: None),
              patch.object(hq_print3d.Controller, "_restart_link", lambda self, pid: None),
              patch.multiple(bridge, ROOT=root, CONFIG=cfg, SESSIONS_PATH=root / "sessions.json",
                             CONFIG_PATH=root / "bridge_config.json", TMP_DIR=root / ".tmp",
                             _SESSIONS={}, _DIAG_STATE=diag, _HQ_BOUND=False),
              patch.object(bridge, "tailscale_ipv4", return_value=None),
              patch.object(bridge, "tailscale_dns_name", return_value=""),
              ThreadingHTTPServer(("127.0.0.1", 0), Quiet) as server):
            bridge.bind_cc_ext()
            bridge.bind_hq()
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            # The route builds the controller through hq_print3d.controller(ROOT): seeding it here
            # (same resolved key) gives the handler the Print share and the same Library instance.
            ctl = hq_print3d.controller(root, lambda: root / "Print")
            try:
                yield f"http://127.0.0.1:{server.server_address[1]}", ctl
            finally:
                server.shutdown()
                worker.join()
                ctl.shutdown()
                hq_print3d._controllers.pop(str(root.resolve()), None)


@contextmanager
def counting_reads():
    """Count ``Path.read_text`` calls per file name: a parse only happens when a file is read."""
    real = Path.read_text
    counts: dict[str, int] = {}

    def counting(self, *args, **kwargs):
        counts[self.name] = counts.get(self.name, 0) + 1
        return real(self, *args, **kwargs)

    with patch.object(Path, "read_text", counting):
        yield counts


def seed_model(ctl, name="bracket.stl"):
    """A real model on the Print share with notes the grid never shows."""
    row = next(m for m in ctl.library.scan(force=True) if m["name"] == name)
    ctl.library.update_meta(row["id"], {"tags": "bracket,pla", "origin": "designed",
                                        "printed_count": 4, "notes": NOTE})
    return row["id"]


class ModelsGetTests(unittest.TestCase):
    def test_full_record_while_the_list_stays_brief(self):
        with fixture() as (base, ctl):
            mid = seed_model(ctl)
            admin = Client(base, ADMIN)

            status, listing = admin.j("/api/print3d/models")
            self.assertEqual(status, 200)
            row = next(m for m in listing["models"] if m["id"] == mid)
            self.assertNotIn("notes", row)                  # the sheet reads them from models/get
            self.assertNotIn("printed_count", row)
            self.assertEqual(row["tags"], ["bracket", "pla"])   # the card still shows tags

            status, full = admin.j("/api/print3d/models/get?id=" + mid)
            self.assertEqual(status, 200)
            model = full["model"]
            self.assertEqual(model["id"], mid)
            self.assertIn(NOTE_WORD, model["notes"])
            self.assertEqual(model["notes"], NOTE)
            self.assertEqual((model["printed_count"], model["tags"], model["origin"]),
                             (4, ["bracket", "pla"], "designed"))
            self.assertEqual(model["size"], (ctl.library.get(mid))["size"])

    def test_unknown_id_is_a_clean_404(self):
        with fixture() as (base, _ctl):
            admin = Client(base, ADMIN)
            status, headers, body = admin.req("/api/print3d/models/get?id=nope123")
            self.assertEqual(status, 404)
            self.assertIn("application/json", headers.get("Content-Type", ""))
            self.assertNotIn(b"Traceback", body)
            payload = json.loads(body)
            self.assertEqual(payload["code"], "not_found")
            self.assertTrue(payload["error"])

    def test_requires_admin(self):
        with fixture() as (base, ctl):
            mid = seed_model(ctl)
            # No session at all: the bridge answers 401 "PIN requis" before any role check.
            # A signed-in upload role reaches the gate and is refused with 403.
            for client, expected, error in ((Client(base, None), 401, "PIN requis"),
                                            (Client(base, UPLOAD), 403, "Réservé admin")):
                status, headers, body = client.req("/api/print3d/models/get?id=" + mid)
                self.assertEqual(status, expected)
                self.assertIn("application/json", headers.get("Content-Type", ""))
                self.assertNotIn(b"Traceback", body)
                self.assertEqual(json.loads(body)["error"], error)
                # The list route is gated the same way, and neither leaks the notes.
                status, _h, body = client.req("/api/print3d/models")
                self.assertEqual(status, expected)
                self.assertNotIn(NOTE_WORD.encode(), body)


class ModelFileRangeTests(unittest.TestCase):
    def test_file_route_answers_the_header_range(self):
        with fixture() as (base, ctl):
            raw = (b"probe-range-" * 20)[:200]
            vase = next(m for m in ctl.library.scan(force=True) if m["name"] == "vase.3mf")
            filename = ctl.library.resolve(vase["id"]).parent / "range.stl"
            filename.write_bytes(raw)
            ctl.library.scan(force=True)
            mid = next(m for m in ctl.library.scan() if m["name"] == "range.stl")["id"]
            admin = Client(base, ADMIN)
            lower = lambda hs: {k.lower(): v for k, v in hs.items()}

            status, headers, body = admin.req("/api/print3d/models/file?id=" + mid,
                                              headers={"Range": "bytes=0-83"})
            self.assertEqual(status, 206)
            self.assertEqual(body, raw[:84])
            headers = lower(headers)
            self.assertEqual(headers.get("content-range"), "bytes 0-83/200")
            self.assertEqual(headers.get("accept-ranges"), "bytes")

            status, headers, full = admin.req("/api/print3d/models/file?id=" + mid)
            self.assertEqual(status, 200)
            self.assertEqual(full, raw)
            self.assertEqual(lower(headers).get("content-length"), "200")

            status, headers, body = admin.req("/api/print3d/models/file?id=" + mid,
                                              headers={"Range": "bytes=0-999"})
            self.assertEqual((status, len(body)), (206, 200))
            self.assertEqual(lower(headers).get("content-range"), "bytes 0-199/200")

            status, headers, body = admin.req("/api/print3d/models/file?id=" + mid,
                                              headers={"Range": "bytes=500-600"})
            self.assertEqual((status, body), (416, b""))
            self.assertEqual(lower(headers).get("content-range"), "bytes */200")

    def test_file_route_emits_fresh_sha256_on_overwrite_and_studio_slice_rejects_stale_hash(self):
        with fixture() as (base, ctl):
            vase = next(m for m in ctl.library.scan(force=True) if m["name"] == "vase.3mf")
            stl_path = ctl.library.resolve(vase["id"]).parent / "live_swap.stl"
            rec1 = struct.pack("<12fH", 0, 0, 1, 0, 0, 0, 12, 0, 0, 0, 10, 10, 0)
            b1 = b"swap1".ljust(80, b" ") + struct.pack("<I", 1) + rec1
            sha1 = hashlib.sha256(b1).hexdigest()
            stl_path.write_bytes(b1)
            mid = next(m for m in ctl.library.scan(force=True) if m["name"] == "live_swap.stl")["id"]

            admin = Client(base, ADMIN)
            lower = lambda hs: {k.lower(): v for k, v in hs.items()}
            status, headers, body = admin.req("/api/print3d/models/file?id=" + mid)
            self.assertEqual(status, 200)
            self.assertEqual(body, b1)
            h1 = lower(headers)
            self.assertEqual(h1.get("x-model-sha256"), sha1)
            self.assertIn("no-store", h1.get("cache-control", ""))

            # Replace file in-place with equal triangle count (1) and different geometry
            rec2 = struct.pack("<12fH", 0, 0, 1, 0, 0, 0, 48, 0, 0, 0, 10, 10, 0)
            b2 = b"swap2".ljust(80, b" ") + struct.pack("<I", 1) + rec2
            sha2 = hashlib.sha256(b2).hexdigest()
            stl_path.write_bytes(b2)
            status, headers, body = admin.req("/api/print3d/models/file?id=" + mid)
            self.assertEqual(status, 200)
            self.assertEqual(body, b2)
            self.assertEqual(lower(headers).get("x-model-sha256"), sha2)

            # POST /api/print3d/studio/slice rejects stale expected_sha256 with 409 source_changed
            ctl.save_printer({"name": "Atelier A1", "kind": "bambu", "model": "A1",
                              "ip": "192.168.1.51", "serial": "03919A000001", "code": "12345678"})
            pid = ctl.save_settings({})["printers"][0]["id"]
            with patch.object(ctl.library, "find_slicer", return_value="orca-slicer"):
                code, parsed = admin.j(
                    "/api/print3d/studio/slice",
                    "POST",
                    data=json.dumps({
                        "printer_id": pid, "printer_model": "A1", "settings": {"infill": 15},
                        "items": [{"model_id": mid, "x": 128, "y": 128, "z": 0, "expected_sha256": sha1}],
                    }).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                )
            self.assertEqual(code, 409)
            self.assertEqual(parsed.get("code"), "source_changed")


class BriefListTests(unittest.TestCase):
    def test_brief_drops_notes_but_search_still_matches_them(self):
        with fixture() as (base, ctl):
            mid = seed_model(ctl)
            admin = Client(base, ADMIN)

            full = ctl.library.list()
            brief = ctl.library.list(brief=True)
            self.assertTrue(all("notes" in m and "printed_count" in m for m in full["models"]))
            self.assertTrue(all("notes" not in m and "printed_count" not in m for m in brief["models"]))
            self.assertEqual([m["id"] for m in full["models"]], [m["id"] for m in brief["models"]])
            self.assertEqual(full["total"], brief["total"])

            full_bytes = len(json.dumps(full["models"], ensure_ascii=False).encode("utf-8"))
            brief_bytes = len(json.dumps(brief["models"], ensure_ascii=False).encode("utf-8"))
            self.assertLess(brief_bytes, full_bytes // 2,
                            f"brief payload {brief_bytes} B should be much smaller than {full_bytes} B")

            # The unique word exists only in a note: the filter must still find the model.
            hit = ctl.library.list(query=NOTE_WORD, brief=True)
            self.assertEqual([m["id"] for m in hit["models"]], [mid])
            self.assertNotIn("notes", hit["models"][0])

            status, _headers, body = admin.req("/api/print3d/models?q=" + NOTE_WORD)
            self.assertEqual(status, 200)
            served = json.loads(body)
            self.assertEqual([m["id"] for m in served["models"]], [mid])
            self.assertNotIn(NOTE_WORD.encode(), body)      # no note text on the wire
            self.assertNotIn(b"printed_count", body)

            # The detail read is what still carries the notes, and the editor round-trips them.
            self.assertEqual(ctl.library.get(mid)["notes"], NOTE)

    def test_detail_saves_notes_and_rescan_stays_brief(self):
        with fixture() as (base, ctl):
            mid = seed_model(ctl)
            admin = Client(base, ADMIN)
            edited = "Réglage " + NOTE_WORD + " après pesée"
            status, saved = admin.j("/api/print3d/models/meta", "POST",
                                    data=json.dumps({"id": mid, "notes": edited}).encode(),
                                    headers={"Content-Type": "application/json"})
            self.assertEqual(status, 200)
            self.assertEqual(saved["model"]["notes"], edited)

            status, full = admin.j("/api/print3d/models/get?id=" + mid)
            self.assertEqual(status, 200)
            self.assertEqual(full["model"]["notes"], edited)

            status, listing = admin.j("/api/print3d/models")
            self.assertEqual(status, 200)
            self.assertNotIn("notes", next(m for m in listing["models"] if m["id"] == mid))

            # Reindexing returns the same brief rows; the grid ignores that response and
            # reloads with GET models, while the detail read remains the full record.
            status, rescanned = admin.j("/api/print3d/models/rescan", "POST",
                                        data=b"{}", headers={"Content-Type": "application/json"})
            self.assertEqual(status, 200)
            row = next(m for m in rescanned["models"] if m["id"] == mid)
            self.assertNotIn("notes", row)
            self.assertNotIn("printed_count", row)
            self.assertEqual(admin.j("/api/print3d/models/get?id=" + mid)[1]["model"]["notes"], edited)


class OverviewTests(unittest.TestCase):
    def test_state_carries_the_matching_plate(self):
        with fixture() as (base, ctl):
            vase = next(m for m in ctl.library.scan(force=True) if m["name"] == "vase.3mf")
            cfg = ctl.save_printer({"name": "Creator 5", "kind": "flashforge", "ip": "192.168.1.61",
                                    "serial": "SNMOMC9901", "code": "check99"})
            pid = cfg["printers"][0]["id"]
            ctl._on_link(pid, True, "")
            ctl._on_status(pid, {"state": "printing", "job": vase["name"], "progress": 10})
            status, state = Client(base, ADMIN).j("/api/print3d/state")
            self.assertEqual(status, 200)
            plate = state["printers"][0]["plate"]
            self.assertEqual((plate["id"], plate["name"], plate["has_thumb"]),
                             (vase["id"], "vase.3mf", True))
            self.assertNotIn("notes", plate)

    def test_overview_payload_and_one_parse_per_file(self):
        with fixture() as (_base, ctl):
            ctl.save_printer({"name": "Creator 5", "kind": "flashforge", "ip": "192.168.1.60",
                              "serial": "SNMOMC9900", "code": "check99"})
            ctl.save_settings({"handle": "marc_makes", "uid": 777})
            # A stored snapshot, so the makerworld parse is part of the measurement.
            (ctl.state_dir() / hq_print3d.MAKERWORLD_FILE).write_text(json.dumps({
                "last": {"at": 1, "profile": {"followers": 42}, "totals": {"downloads": 40},
                         "designs": [], "design_total": 0},
                "history": [{"at": 1, "downloads": 40}], "alerts": [], "last_attempt": 1}),
                encoding="utf-8")

            ctl._cfg_cache = None
            ctl._mw_cache = None
            with counting_reads() as counts:
                code, payload = ctl.http_get("/api/print3d/state", {})
                cold = dict(counts)
            self.assertEqual(code, 200)
            printer = payload["printers"][0]
            self.assertEqual((printer["name"], printer["kind"]), ("Creator 5", "flashforge"))
            self.assertNotIn("check99", json.dumps(payload))          # the code never leaves the file
            self.assertTrue(printer["has_code"])
            self.assertEqual(payload["config"]["makerworld"]["handle"], "marc_makes")
            self.assertTrue(payload["makerworld"]["configured"])
            self.assertEqual(payload["makerworld"]["last"]["totals"]["downloads"], 40)
            self.assertIsInstance(payload["history"], list)
            self.assertEqual(cold.get("print3d.json"), 1)
            self.assertEqual(cold.get("makerworld.json"), 1)

            # A second poll of unchanged files parses nothing at all.
            with counting_reads() as counts:
                ctl.http_get("/api/print3d/state", {})
                warm = dict(counts)
            self.assertNotIn("print3d.json", warm)
            self.assertNotIn("makerworld.json", warm)

            # Four _read_config callers per poll (unchanged), but only one parse.
            calls = []
            real = hq_print3d.Controller._read_config

            def counting_config(controller_self):
                calls.append(1)
                return real(controller_self)

            with counting_reads() as counts:
                with patch.object(hq_print3d.Controller, "_read_config", counting_config):
                    ctl.overview()
            # One call site: overview() passes the config down instead of each block reading it.
            self.assertEqual(len(calls), 1)
            self.assertNotIn("print3d.json", counts)

            # Counterfactual with the same code: no cache, four calls, four parses — the old cost.
            with counting_reads() as counts:
                for _ in range(4):
                    ctl._cfg_cache = None
                    ctl.public_config()
            self.assertEqual(counts.get("print3d.json"), 4)

    def test_a_write_invalidates_the_cache(self):
        with fixture() as (_base, ctl):
            ctl.http_get("/api/print3d/state", {})                # warm the cache
            ctl.save_settings({"handle": "marc_makes"})
            # save_settings re-reads to return the saved config, so the cache is valid again.
            with counting_reads() as counts:
                code, payload = ctl.http_get("/api/print3d/state", {})
            self.assertEqual(code, 200)
            self.assertEqual(payload["config"]["makerworld"]["handle"], "marc_makes")
            self.assertIsNone(counts.get("print3d.json"))

            # An edit made outside the process is still picked up: the key is (mtime, size), so a
            # longer handle alone invalidates the cache even on a coarse filesystem clock.
            path = ctl._config_path()
            data = json.loads(path.read_text(encoding="utf-8"))
            data["makerworld"]["handle"] = "someone_else"
            path.write_text(json.dumps(data), encoding="utf-8")
            with counting_reads() as counts:
                code, payload = ctl.http_get("/api/print3d/state", {})
            self.assertEqual(code, 200)
            self.assertEqual(payload["config"]["makerworld"]["handle"], "someone_else")
            self.assertEqual(counts.get("print3d.json"), 1)


class ChannelTests(unittest.TestCase):
    def test_unsupported_method_and_unknown_route_stay_json(self):
        with fixture() as (base, _ctl):
            admin = Client(base, ADMIN)
            status, headers, body = admin.req("/api/print3d/models/get", "POST", b"{}",
                                              {"Content-Type": "application/json"})
            self.assertEqual(status, 404)                        # no POST route of that name
            self.assertNotIn(b"Traceback", body)
            status, _h, body = admin.req("/api/print3d/nope")
            self.assertEqual(status, 404)
            self.assertEqual(json.loads(body)["code"], "not_found")
            self.assertNotIn(b"Traceback", body)


if __name__ == "__main__":
    unittest.main()


class ThumbCacheTests(unittest.TestCase):
    """A thumbnail is cacheable by content: the ETag is the bytes, so a redraw costs a 304."""

    def test_thumb_etag_revalidates_to_an_empty_304(self):
        with fixture() as (base, ctl):
            admin = Client(base, ADMIN)
            vase = next(m for m in ctl.library.scan(force=True) if m["name"] == "vase.3mf")
            path = "/api/print3d/models/thumb?id=" + vase["id"]
            lower = lambda hs: {k.lower(): v for k, v in hs.items()}

            status, headers, body = admin.req(path)
            self.assertEqual(status, 200)
            headers = lower(headers)
            etag = headers.get("etag", "")
            self.assertTrue(etag.startswith('"') and etag.endswith('"') and len(etag) > 20, etag)
            self.assertEqual(headers.get("cache-control"), "private, max-age=300")
            self.assertEqual(headers.get("content-type"), "image/png")
            self.assertEqual(body, PNG)                     # 200 carries the bytes

            status, headers, body = admin.req(path, headers={"If-None-Match": etag})
            self.assertEqual(status, 304)
            self.assertEqual(body, b"")                     # no body on a 304
            headers = lower(headers)
            self.assertEqual(headers.get("etag"), etag)     # same validator
            self.assertEqual(headers.get("cache-control"), "private, max-age=300")

            status, headers, body = admin.req(path, headers={"If-None-Match": '"stale"'})
            self.assertEqual(status, 200)                   # a stale tag cannot hide the image
            self.assertEqual(body, PNG)
            self.assertEqual(lower(headers).get("etag"), etag)

            status, _headers, body = admin.req(path)        # no validator at all
            self.assertEqual(status, 200)
            self.assertEqual(body, PNG)

            # Two different images must never share a tag.
            second = ctl.library.resolve(vase["id"]).parent / "vase2.3mf"
            other = PNG + b"\x00different"
            with zipfile.ZipFile(second, "w") as zf:
                zf.writestr("Metadata/plate_1.png", other)
                zf.writestr("3D/3dmodel.model", "<model/>")
            row = next(m for m in ctl.library.scan(force=True) if m["name"] == "vase2.3mf")
            status, headers, body = admin.req("/api/print3d/models/thumb?id=" + row["id"])
            self.assertEqual(status, 200)
            self.assertEqual(body, other)
            self.assertNotEqual(lower(headers).get("etag"), etag)

            # The path guard is untouched: an id outside the share is still refused.
            status, _headers, _body = admin.req("/api/print3d/models/thumb?id=../bridge_config.json")
            self.assertEqual(status, 404)


class HistoryCacheTests(unittest.TestCase):
    """The overview reads ten rows out of history.json every few seconds; the file only grows."""

    def _seed(self, ctl):
        ctl._write_jobs([
            {"id": "h1", "at": 1, "printer": "p1", "printer_name": "A1", "job": "Un",
             "outcome": "finished", "filament": {"g": 10, "m": 3}},
            {"id": "h2", "at": 2, "printer": "p1", "printer_name": "A1", "job": "Deux",
             "outcome": "finished", "filament": {"g": 20, "m": 6}},
        ])
        ctl._hist_cache = None

    def test_history_is_parsed_once_per_file_version(self):
        with fixture() as (_base, ctl):
            self._seed(ctl)
            with counting_reads() as counts:
                code, payload = ctl.http_get("/api/print3d/state", {})
                cold = dict(counts)
            self.assertEqual(code, 200)
            self.assertEqual([j["id"] for j in payload["history"]], ["h2", "h1"])
            self.assertEqual(cold.get("history.json"), 1)

            with counting_reads() as counts:
                ctl.http_get("/api/print3d/state", {})
                warm = dict(counts)
            self.assertNotIn("history.json", warm)          # no parse at all on a warm poll

            with counting_reads() as counts:
                ctl.edit_job("h1", {"grams": 42})
                self.assertEqual(counts.get("history.json"), 1, "an edit re-reads once")
            row = next(j for j in ctl.history(10) if j["id"] == "h1")
            self.assertEqual(row["filament"]["g"], 42.0)

            # Cached rows are shared: a write that fails must not leave its edit in memory.
            with patch.object(hq_print3d.hq_state, "write_json_atomic", side_effect=RuntimeError("disque plein")):
                with self.assertRaises(hq_print3d.Print3dError):
                    ctl.edit_job("h1", {"grams": 7})
            self.assertEqual(next(j for j in ctl.history(10) if j["id"] == "h1")["filament"]["g"], 42.0)

    def test_an_outside_write_is_still_seen(self):
        with fixture() as (_base, ctl):
            self._seed(ctl)
            ctl.http_get("/api/print3d/state", {})            # warm
            path = ctl._history_path()
            data = json.loads(path.read_text(encoding="utf-8"))
            data["jobs"].append({"id": "h3", "at": 3, "printer": "p1", "job": "Trois",
                                 "outcome": "finished", "filament": {"g": 1, "m": 1}})
            path.write_text(json.dumps(data), encoding="utf-8")
            self.assertIn("h3", [j["id"] for j in ctl.history(10)])


class OfflineSinceTests(unittest.TestCase):
    def test_since_is_when_the_outage_started_not_the_last_retry(self):
        with fixture() as (_base, ctl):
            clock = [1000]
            with patch.object(hq_print3d, "_now", lambda: clock[0]):
                ctl._on_link("p1", False, "refusé")
                self.assertEqual(ctl._link["p1"]["since"], 1000)
                clock[0] = 1030
                ctl._on_link("p1", False, "refusé")
                self.assertEqual(ctl._link["p1"]["since"], 1000)   # the streak, not the retry
                self.assertEqual(ctl._link["p1"]["at"], 1030)      # at still says when it tried
                clock[0] = 1040
                ctl._on_link("p1", True, "")
                self.assertEqual((ctl._link["p1"]["online"], ctl._link["p1"]["since"]), (True, 0))
                clock[0] = 1050
                ctl._on_link("p1", False, "encore")
                self.assertEqual(ctl._link["p1"]["since"], 1050)  # a new outage starts now


class LibraryPageTests(unittest.TestCase):
    def test_offset_pages_through_a_library_bigger_than_one_page(self):
        with fixture() as (base, ctl):
            vase = next(m for m in ctl.library.scan(force=True) if m["name"] == "vase.3mf")
            (ctl.library.resolve(vase["id"]).parent / "third.stl").write_bytes(b"solid third\nendsolid third\n")
            ctl.library.scan(force=True)
            admin = Client(base, ADMIN)

            status, _headers, body = admin.req("/api/print3d/models?limit=2")
            self.assertEqual(status, 200)
            first = json.loads(body)
            self.assertEqual((len(first["models"]), first["total"]), (2, 3))

            status, _headers, body = admin.req("/api/print3d/models?limit=2&offset=2")
            self.assertEqual(status, 200)
            second = json.loads(body)
            self.assertEqual((len(second["models"]), second["total"]), (1, 3))
            self.assertFalse({m["id"] for m in first["models"]} & {m["id"] for m in second["models"]})

            # A page asked past the end is empty, and the total still says how many exist.
            status, _headers, body = admin.req("/api/print3d/models?limit=2&offset=9")
            self.assertEqual(status, 200)
            self.assertEqual((json.loads(body)["models"], json.loads(body)["total"]), ([], 3))

            # A negative or garbage offset cannot rewind or 500.
            status, _headers, body = admin.req("/api/print3d/models?offset=-4")
            self.assertEqual(status, 200)
            self.assertEqual(len(json.loads(body)["models"]), 3)


class StateValidatorTests(unittest.TestCase):
    def test_unchanged_state_revalidates_to_an_empty_304(self):
        with fixture() as (base, ctl):
            admin = Client(base, ADMIN)
            lower = lambda hs: {k.lower(): v for k, v in hs.items()}

            status, headers, body = admin.req("/api/print3d/state")
            self.assertEqual(status, 200)
            etag = json.loads(body).get("etag", "")
            self.assertTrue(etag.startswith('"') and etag.endswith('"') and len(etag) > 20, etag)
            self.assertEqual(lower(headers).get("etag"), etag)

            status, headers, body = admin.req("/api/print3d/state", headers={"If-None-Match": etag})
            self.assertEqual(status, 304)
            self.assertEqual(body, b"")
            self.assertEqual(lower(headers).get("etag"), etag)

            status, _headers, body = admin.req("/api/print3d/state", headers={"If-None-Match": '"stale"'})
            self.assertEqual(status, 200)                    # a stale tag cannot hide a state
            self.assertEqual(json.loads(body)["etag"], etag)

            ctl.save_settings({"handle": "marc_makes"})
            status, _headers, body = admin.req("/api/print3d/state", headers={"If-None-Match": etag})
            self.assertEqual(status, 200)
            self.assertNotEqual(json.loads(body)["etag"], etag)


class CameraFrameGateTests(unittest.TestCase):
    """``?fps=`` caps the writes; no ``fps`` (or 0) takes every frame.

    No socket and no printer: the production handler method is called with a stub ``self`` and a hub
    that hands out frames on a fake clock, so the only thing under test is the gate. A real clock
    would make the assertion depend on how fast this machine runs; a fake one makes the budget exact
    and pins the very thing that regressed: the gap between two writes.
    """

    FRAMES, STEP = 40, 0.125          # 8 fps for 5 s of hub time, exactly representable in binary

    def _stream(self, fps):
        clock = [1000.0]
        writes = []                   # (monotonic at the write, bytes)

        class Hub:
            def __init__(self):
                self.n, self.released = 0, False

            def acquire(self):
                self.acquired = True

            def release(self):
                self.released = True

            def wait_frame(self, seq, timeout):
                clock[0] += self_outer.STEP
                self.n += 1
                if self.n > self_outer.FRAMES:
                    raise OSError("test stream over")   # the handler's except OSError ends the loop
                return seq + 1, b"\xff\xd8f%02d\xff\xd9" % self.n, ""

        self_outer = self

        class Out:
            def write(self, chunk):
                writes.append((clock[0], bytes(chunk)))

        class Stub:
            close_connection = False

            def __init__(self):
                self.code = 0
                self.wfile = Out()
                self.connection = types.SimpleNamespace(settimeout=lambda t: None)

            def send_response(self, code):
                self.code = code

            def send_header(self, key, value):
                pass

            def _security_headers(self):
                pass

            def end_headers(self):
                pass

            def _token(self):
                return "tok"

        hub, stub = Hub(), Stub()
        ctl = types.SimpleNamespace(camera_hub=lambda pid: hub)
        # The bridge's own clock is replaced only for this call: no server thread runs here.
        with patch.object(bridge, "session_role", lambda token: "admin"), \
                patch.object(bridge.hq_security, "is_locked_down", lambda cfg: False), \
                patch.object(bridge, "time", types.SimpleNamespace(monotonic=lambda: clock[0])):
            bridge.Handler._print3d_camera(stub, ctl, "p1", fps)

        self.assertTrue(hub.acquired)
        self.assertTrue(hub.released, "the viewer is released even when the stream ends by error")
        self.assertEqual(stub.code, 200)
        return writes

    def test_a_capped_stream_writes_at_the_requested_rate(self):
        writes = self._stream(2.0)
        gaps = [b[0] - a[0] for a, b in zip(writes, writes[1:])]
        self.assertEqual(len(writes), 10, "one immediate frame, then one every 0.5 s")
        self.assertEqual(set(gaps), {0.5}, f"writes were {sorted(set(gaps))} s apart")
        self.assertIn(b"\xff\xd8f01\xff\xd9", writes[0][1], "the first frame is not delayed")
        self.assertEqual(len(writes), len({w[1] for w in writes}), "no frame is repeated")

    def test_the_uncapped_stream_takes_every_frame(self):
        writes = self._stream(0)
        self.assertEqual(len(writes), self.FRAMES)
        gaps = [b[0] - a[0] for a, b in zip(writes, writes[1:])]
        self.assertTrue(all(g == self.STEP for g in gaps), "no frame is dropped or throttled")
        self.assertIn(b"\xff\xd8f40\xff\xd9", writes[-1][1], "the last frame arrives too")


class GcodeDeliveryTests(unittest.TestCase):
    @staticmethod
    def _add_file(ctl, name: str, raw: bytes) -> str:
        share = ctl.library._roots()["print"]
        target = share / name
        target.write_bytes(raw)
        ctl.library.scan(force=True)
        return next(m["id"] for m in ctl.library.scan() if m["name"] == name)

    @staticmethod
    def _add_zip(ctl, name: str, entries: dict[str, bytes], compress=zipfile.ZIP_DEFLATED) -> str:
        share = ctl.library._roots()["print"]
        target = share / name
        with zipfile.ZipFile(target, "w", compression=compress) as zf:
            for k, v in entries.items():
                zf.writestr(k, v)
        ctl.library.scan(force=True)
        return next(m["id"] for m in ctl.library.scan() if m["name"] == name)

    def test_plain_gcode_gx_range_etag_and_headers(self):
        with fixture() as (base, ctl):
            gcode_bytes = b"; generated by OrcaSlicer 2.2.0\nG90\nG1 X10 Y10 E1.0\n"
            gx_body = b"; generated by ffslicer\nG28\nG1 X5 Y5 E0.5\n"
            gx_bytes = b"xgcode 1.0\n\x00\x00\x00\x00BMPDATA\x00\x01\x02\n" + gx_body
            gid = self._add_file(ctl, "part.gcode", gcode_bytes)
            gxid = self._add_file(ctl, "flash.gx", gx_bytes)
            admin = Client(base, ADMIN)
            lower = lambda hs: {k.lower(): v for k, v in hs.items()}

            st, hdrs, body = admin.req("/api/print3d/models/gcode?id=" + gid)
            self.assertEqual(st, 200)
            self.assertEqual(body, gcode_bytes)
            h = lower(hdrs)
            self.assertIn("text/plain", h.get("content-type", ""))
            self.assertEqual(h.get("accept-ranges"), "bytes")
            self.assertEqual(h.get("x-content-type-options"), "nosniff")
            self.assertIn("sandbox", h.get("content-security-policy", ""))
            self.assertIn("default-src 'none'", h.get("content-security-policy", ""))
            self.assertEqual(h.get("x-gcode-source-kind"), "gcode")
            etag = h.get("etag")
            self.assertTrue(etag)

            # ETag revalidation
            st304, _, b304 = admin.req("/api/print3d/models/gcode?id=" + gid, headers={"If-None-Match": etag})
            self.assertEqual((st304, b304), (304, b""))

            # Byte range support for plain G-code
            st206, h206, b206 = admin.req("/api/print3d/models/gcode?id=" + gid, headers={"Range": "bytes=0-15"})
            self.assertEqual((st206, b206), (206, gcode_bytes[:16]))
            self.assertEqual(lower(h206).get("content-range"), f"bytes 0-15/{len(gcode_bytes)}")

            st416, h416, _ = admin.req("/api/print3d/models/gcode?id=" + gid, headers={"Range": "bytes=99999-100010"})
            self.assertEqual(st416, 416)
            self.assertEqual(lower(h416).get("content-range"), f"bytes */{len(gcode_bytes)}")

            # Binary xgcode .gx header is skipped cleanly to ASCII G-code start
            stx, hx, bx = admin.req("/api/print3d/models/gcode?id=" + gxid)
            self.assertEqual(stx, 200)
            self.assertEqual(bx, gx_body)
            self.assertEqual(lower(hx).get("x-gcode-source-kind"), "gx")

    def test_multiplate_3mf_missing_plate_and_unsliced_3mf(self):
        with fixture() as (base, ctl):
            p1 = b"; plate 1\nG1 X10 Y10 E1.0\n"
            p2 = b"; plate 2\nG1 X20 Y20 E2.0\n"
            mid = self._add_zip(ctl, "multi.gcode.3mf", {
                "Metadata/plate_1.gcode": p1,
                "Metadata/plate_2.gcode": p2,
            })
            vase_id = next(m["id"] for m in ctl.library.scan() if m["name"] == "vase.3mf")
            stl_id = next(m["id"] for m in ctl.library.scan() if m["name"] == "bracket.stl")
            admin = Client(base, ADMIN)
            lower = lambda hs: {k.lower(): v for k, v in hs.items()}

            st1, h1, b1 = admin.req(f"/api/print3d/models/gcode?id={mid}&plate=1")
            self.assertEqual((st1, b1), (200, p1))
            self.assertEqual(lower(h1).get("accept-ranges"), "none")
            self.assertEqual(lower(h1).get("x-gcode-plate"), "1")

            st2, h2, b2 = admin.req(f"/api/print3d/models/gcode?id={mid}&plate=2")
            self.assertEqual((st2, b2), (200, p2))
            self.assertEqual(lower(h2).get("x-gcode-plate"), "2")

            # Missing plate -> 404 bad_plate
            stm, _, bm = admin.req(f"/api/print3d/models/gcode?id={mid}&plate=5")
            self.assertEqual(stm, 404)
            self.assertEqual(json.loads(bm)["code"], "bad_plate")

            # Invalid plate parameter -> 400 validation_error
            stb, _, bb = admin.req(f"/api/print3d/models/gcode?id={mid}&plate=abc")
            self.assertEqual(stb, 400)
            self.assertEqual(json.loads(bb)["code"], "validation_error")

            # Unsliced 3MF and STL -> 422 not_sliced
            for bad_id in (vase_id, stl_id):
                stu, _, bu = admin.req(f"/api/print3d/models/gcode?id={bad_id}")
                self.assertEqual(stu, 422)
                self.assertEqual(json.loads(bu)["code"], "not_sliced")

    def test_malformed_zip_oversized_and_zip_bomb_guards(self):
        import hq_print3d_models as models
        with fixture() as (base, ctl):
            corrupt_id = self._add_file(ctl, "bad.3mf", b"not-a-zip-at-all")
            fake_gcode_zip = self._add_file(ctl, "fake.gcode", b"PK\x03\x04fakezip")
            big_gcode_id = self._add_file(ctl, "big.gcode", b"G1 X1 Y1 E1\n" * 200)
            big_3mf_id = self._add_zip(ctl, "big.gcode.3mf", {
                "Metadata/plate_1.gcode": b"G1 X1 Y1 E1\n" * 200,
            })
            admin = Client(base, ADMIN)

            for bad_id in (corrupt_id, fake_gcode_zip):
                st, _, body = admin.req(f"/api/print3d/models/gcode?id={bad_id}")
                self.assertEqual(st, 422)
                self.assertEqual(json.loads(body)["code"], "unreadable")
                self.assertNotIn(b"Traceback", body)

            # Oversized plain G-code and 3MF plate entry -> 413 too_large
            with patch.object(models, "MAX_GCODE_BYTES", 256):
                for over_id in (big_gcode_id, big_3mf_id):
                    st, _, body = admin.req(f"/api/print3d/models/gcode?id={over_id}")
                    self.assertEqual(st, 413)
                    self.assertEqual(json.loads(body)["code"], "too_large")

            # High compression ratio ZIP bomb guard -> 413 too_large
            # Test GcodeStream.read() hard cap when decompressed stream exceeds max_bytes
            with ctl.library.open_gcode(big_3mf_id, 1) as stream:
                stream._max_bytes = 64
                with self.assertRaises(models.ModelError) as ctx:
                    stream.read(128)
                self.assertEqual(ctx.exception.code, "too_large")

            # Too many ZIP entries -> 422 unreadable
            with patch.object(models, "MAX_GCODE_ZIP_ENTRIES", 0):
                st, _, body = admin.req(f"/api/print3d/models/gcode?id={big_3mf_id}")
                self.assertEqual(st, 422)
                self.assertEqual(json.loads(body)["code"], "unreadable")

    def test_auth_traversal_symlink_and_stream_interruption(self):
        import hq_print3d_models as models
        with fixture() as (base, ctl):
            gid = self._add_file(ctl, "safe.gcode", b"G1 X1 Y1 E1\n" * 100)
            for client, expected in ((Client(base, None), 401), (Client(base, UPLOAD), 403)):
                st, _, body = client.req(f"/api/print3d/models/gcode?id={gid}")
                self.assertEqual(st, expected)
                self.assertNotIn(b"G1", body)

            admin = Client(base, ADMIN)
            # Traversal / unknown id must never leak filesystem paths
            for bad_id in ("../bridge_config.json", "..%2Fsecret", "missing123"):
                st, _, body = admin.req(f"/api/print3d/models/gcode?id={bad_id}")
                self.assertEqual(st, 404)
                self.assertNotIn(b"Print", body)
                self.assertNotIn(b"\\", body)

            # Symlink confinement check refuses symlinks/junctions
            with patch.object(models, "_is_link", return_value=True):
                st, _, body = admin.req(f"/api/print3d/models/gcode?id={gid}")
                self.assertEqual(st, 403)
                self.assertEqual(json.loads(body)["code"], "forbidden")

            # Streaming interruption closes underlying handles cleanly without raising
            mid = self._add_zip(ctl, "stream.gcode.3mf", {"Metadata/plate_1.gcode": b"G1 X1 Y1 E1\n" * 500})
            opened_streams = []
            real_open = ctl.library.open_gcode

            def tracked_open(model_id, plate=1):
                s = real_open(model_id, plate)
                opened_streams.append(s)
                return s

            class BrokenOut:
                def write(self, _chunk):
                    raise BrokenPipeError("client aborted")

            stub = types.SimpleNamespace(
                command="GET",
                path=f"/api/print3d/models/gcode?id={mid}&plate=1",
                headers={},
                wfile=BrokenOut(),
                close_connection=False,
                _require_admin=lambda: True,
                _print3d_ctl=lambda: ctl,
                send_response=lambda _c: None,
                send_header=lambda _k, _v: None,
                _security_headers=lambda *a, **k: None,
                end_headers=lambda: None,
            )
            with patch.object(ctl.library, "open_gcode", side_effect=tracked_open):
                from urllib.parse import urlparse
                ok = bridge.Handler._print3d_get(stub, "/api/print3d/models/gcode", urlparse(stub.path))
            self.assertTrue(ok)
            self.assertTrue(stub.close_connection)
            self.assertEqual(len(opened_streams), 1)
            self.assertTrue(opened_streams[0]._closed)
