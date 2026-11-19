"""Atelier 3D: printer adapters, secrets, model library confinement, MakerWorld parsing."""
import io
import json
import os
import struct
import sys
import tempfile
import unittest
import urllib.error
import zipfile
from email.message import Message
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import hq_makerworld
import hq_print3d
import hq_print3d_bambu as bambu
import hq_print3d_flashforge as flashforge
import hq_print3d_models as models

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def reader(data: bytes):
    buf = io.BytesIO(data)

    def recv(n):
        chunk = buf.read(n)
        if len(chunk) < n:
            raise ConnectionError("closed")
        return chunk
    return recv


class BambuCodecTests(unittest.TestCase):
    def test_length_varint_round_trip(self):
        for n in (0, 1, 127, 128, 16383, 16384, 2_097_151, 2_097_152):
            body = b"x" * min(n, 20000)
            if len(body) != n:
                continue
            first, out = bambu.read_packet(reader(bambu.packet(0x30, body)))
            self.assertEqual((first, out), (0x30, body))
        self.assertEqual(bambu.encode_length(321), b"\xc1\x02")

    def test_connect_carries_user_and_access_code(self):
        pkt = bambu.connect_packet("hq-1", "bblp", "12345678")
        first, body = bambu.read_packet(reader(pkt))
        self.assertEqual(first, 0x10)
        self.assertTrue(body.startswith(b"\x00\x04MQTT\x04\xc2"))
        self.assertTrue(body.endswith(b"\x00\x04bblp\x00\x0812345678"))

    def test_publish_round_trip(self):
        first, body = bambu.read_packet(reader(bambu.publish_packet("device/X/report", b'{"a":1}')))
        self.assertEqual(bambu.parse_publish(first, body), ("device/X/report", b'{"a":1}'))

    def test_oversized_packet_is_refused(self):
        with self.assertRaises(bambu.BambuError):
            bambu.read_packet(reader(b"\x30" + bambu.encode_length(bambu.MAX_PACKET + 1)))

    def test_partial_reports_merge_into_one_status(self):
        report = {}
        bambu.deep_merge(report, {"print": {"gcode_state": "RUNNING", "mc_percent": 42, "mc_remaining_time": 75,
                                            "layer_num": 30, "total_layer_num": 120, "subtask_name": "Benchy",
                                            "nozzle_temper": 219.6, "nozzle_target_temper": 220, "bed_temper": 60,
                                            "ams": {"tray_now": "1", "ams": [{"id": "0", "tray": [
                                                {"id": "0", "tray_type": "PLA", "tray_color": "FF0000FF", "remain": 80},
                                                {"id": "1", "tray_type": "PETG", "tray_color": "00ff00ff", "remain": -1}]}]}}})
        bambu.deep_merge(report, {"print": {"mc_percent": 43, "lights_report": [{"node": "chamber_light", "mode": "on"}]}})
        s = bambu.normalise(report)
        self.assertEqual(s["state"], "printing")
        self.assertEqual(s["progress"], 43)
        self.assertEqual(s["remaining_sec"], 75 * 60)
        self.assertEqual(s["job"], "Benchy")
        self.assertTrue(s["light"])
        self.assertEqual([(a["slot"], a["material"], a["colour"], a["active"]) for a in s["ams"]],
                         [(1, "PLA", "#FF0000", False), (2, "PETG", "#00FF00", True)])

    def test_ams_says_which_slots_hold_a_spool(self):
        s = bambu.normalise({"print": {"gcode_state": "IDLE", "ams": {"ams": [{"id": "0", "tray": [
            {"id": "0", "tray_type": "PLA"},
            {"id": "1", "tray_type": ""}]}]}}})
        self.assertEqual([a["loaded"] for a in s["ams"]], [True, False])

    def test_ams_falls_back_to_the_name_when_tray_type_is_empty(self):
        s = bambu.normalise({"print": {"gcode_state": "IDLE", "ams": {"ams": [{"id": "0", "tray": [
            {"id": "0", "tray_type": "", "tray_sub_brands": "PLA Basic"},
            {"id": "1", "tray_type": "", "tray_id_name": "PETG"},
            {"id": "2", "tray_type": "", "tray_sub_brands": ""}]}]}}})
        self.assertEqual([(a["material"], a["loaded"]) for a in s["ams"]],
                         [("PLA Basic", True), ("PETG", True), ("", False)])

    def test_camera_auth_and_frames(self):
        auth = bambu.camera_auth_packet("12345678")
        self.assertEqual(len(auth), 80)
        self.assertEqual(struct.unpack("<IIII", auth[:16]), (0x40, 0x3000, 0, 0))
        jpeg = b"\xff\xd8" + b"\x01" * 50 + b"\xff\xd9"
        frame = struct.pack("<I", len(jpeg)) + b"\x00" * 12 + jpeg
        self.assertEqual(bambu.read_camera_frame(reader(frame)), jpeg)
        with self.assertRaises(bambu.BambuError):
            bambu.read_camera_frame(reader(struct.pack("<I", 4) + b"\x00" * 12 + b"nope"))


class FlashforgeTests(unittest.TestCase):
    def test_detail_normalises(self):
        s = flashforge.normalise_detail({"status": "printing", "printProgress": 0.5, "printFileName": "clip.gx",
                                         "rightTemp": 210, "rightTargetTemp": 215, "platTemp": 55,
                                         "platTargetTemp": 55, "printLayer": 10, "targetPrintLayer": 40,
                                         "estimatedTime": 3600, "printDuration": 1200, "lightStatus": "open"})
        self.assertEqual((s["state"], s["progress"], s["remaining_sec"], s["light"]), ("printing", 50.0, 2400, True))
        self.assertEqual(s["nozzle_target"], 215)

    def test_slots_say_which_hold_a_spool(self):
        s = flashforge.normalise_detail({"status": "ready", "matlStationInfo": {"slotInfos": [
            {"slotId": 1, "materialName": "PLA", "materialColor": "#1B1B1B", "hasFilament": True},
            {"slotId": 2, "materialName": "", "materialColor": "", "hasFilament": False}]}})
        self.assertEqual([(a["slot"], a["loaded"]) for a in s["ams"]], [(1, True), (2, False)])

    def test_slots_fall_back_to_the_material_name_when_the_flag_is_absent(self):
        s = flashforge.normalise_detail({"status": "ready", "matlStationInfo": {"slotInfos": [
            {"slotId": 1, "materialName": "PLA"},
            {"slotId": 2, "materialName": "PLA", "hasFilament": False},
            {"slotId": 3, "materialName": ""}]}})
        # No flag: the name is the evidence. A real False still wins over a leftover name.
        self.assertEqual([a["loaded"] for a in s["ams"]], [True, False, False])

    def test_legacy_parse(self):
        s = flashforge.parse_legacy("MachineStatus: BUILDING_FROM_SD\nMoveMode: MOVING\nCurrentFile: cube.gx\nok",
                                    "T0:205.0 /210.0 B:60.0 /60.0\nok", "SD printing byte 25/100\nLayer: 5/20\nok")
        self.assertEqual((s["state"], s["progress"], s["layer"], s["nozzle"], s["job"]), ("printing", 25.0, 5.0, 205.0, "cube.gx"))

    def test_mjpeg_split_keeps_partial_frames(self):
        a = b"\xff\xd8AAA\xff\xd9"
        b = b"\xff\xd8BBBB\xff\xd9"
        buf = bytearray(b"--boundary\r\n" + a + b"\r\n--boundary\r\n" + b[:4])
        self.assertEqual(flashforge.split_jpegs(buf), [a])
        buf.extend(b[4:])
        self.assertEqual(flashforge.split_jpegs(buf), [b])


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="hq-print3d-")
        self.root = Path(self._tmp.name)
        self.share = self.root / "Print"
        self.share.mkdir()
        self._patches = [patch.object(hq_print3d.Controller, "ensure_links", lambda self: None),
                         patch.object(hq_print3d.Controller, "_restart_link", lambda self, pid: None),
                         # The slice lookup runs off a daemon thread: its zip handle would outlive the
                         # temporary share this class deletes in tearDown. Materials are tested sync.
                         patch.object(hq_print3d.Controller, "_resolve_slice", lambda self, *a: None)]
        for p in self._patches:
            p.start()
        self.ctl = hq_print3d.Controller(self.root, lambda: self.share)

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def test_printer_validation_and_secret_stripping(self):
        with self.assertRaises(hq_print3d.Print3dError):
            self.ctl.save_printer({"name": "X", "kind": "bambu", "ip": "8.8.8.8", "serial": "ABC123456", "code": "1234"})
        with self.assertRaises(hq_print3d.Print3dError):
            self.ctl.save_printer({"name": "X", "kind": "bambu", "ip": "192.168.1.9", "serial": "ABC123456"})
        cfg = self.ctl.save_printer({"name": "Creator 5", "kind": "flashforge", "ip": "192.168.1.9",
                                     "serial": "SNMOMC9900", "code": "secret99",
                                     "bed": {"x": 210, "y": 190, "z": 200}})
        printer = cfg["printers"][0]
        self.assertEqual(printer["bed"], {"x": 210.0, "y": 190.0, "z": 200.0})
        with self.assertRaises(hq_print3d.Print3dError):
            self.ctl.save_printer({"name": "Bad bed", "kind": "flashforge", "ip": "192.168.1.11",
                                   "serial": "SNMOMC9901", "code": "secret99",
                                   "bed": {"x": 0, "y": 190, "z": 200}})
        self.assertTrue(printer["has_code"])
        self.assertNotIn("secret99", json.dumps(cfg))
        # A blank code on edit keeps the stored one.
        self.ctl.save_printer({"id": printer["id"], "name": "Creator 5 Pro", "kind": "flashforge",
                               "ip": "192.168.1.10", "serial": "SNMOMC9900", "code": ""})
        self.assertEqual(self.ctl._printer_cfg(printer["id"])["code"], "secret99")
        code, state = self.ctl.http_get("/api/print3d/state", {})
        self.assertEqual(code, 200)
        self.assertNotIn("secret99", json.dumps(state))

    def test_a_known_printer_reports_its_default_plate(self):
        cfg = self.ctl.save_printer({"name": "A1 mini", "kind": "bambu", "ip": "192.168.1.12",
                                     "serial": "ABC123456", "code": "1234"})
        self.assertEqual(cfg["printers"][0]["bed"], {"x": 180.0, "y": 180.0, "z": 180.0})

    def test_a_running_job_reports_its_library_plate_without_notes(self):
        with zipfile.ZipFile(self.share / "vase.3mf", "w") as zf:
            zf.writestr("Metadata/plate_1.png", PNG)
            zf.writestr("3D/3dmodel.model", "<model/>")
        cfg = self.ctl.save_printer({"name": "Creator 5", "kind": "flashforge", "ip": "192.168.1.13",
                                     "serial": "SNMOMC9900", "code": "check99"})
        pid = cfg["printers"][0]["id"]
        self.ctl._on_link(pid, True, "")
        self.ctl._on_status(pid, {"state": "printing", "job": "vase.3mf", "progress": 10})

        row = self.ctl.overview()["printers"][0]
        self.assertEqual(row["plate"]["name"], "vase.3mf")
        self.assertEqual(row["plate"]["ext"], "3mf")
        self.assertTrue(row["plate"]["has_thumb"])
        self.assertNotIn("notes", row["plate"])

    def test_commands_have_no_http_route_and_unknown_command_is_refused(self):
        self.assertEqual(self.ctl.http_post("/api/print3d/command", {"id": "p-000000", "command": "stop"})[0], 404)
        with self.assertRaises(hq_print3d.Print3dError):
            self.ctl.command("p-000000", "format_disk")

    def test_finished_job_lands_in_history(self):
        cfg = self.ctl.save_printer({"name": "A1", "kind": "bambu", "ip": "10.0.0.5", "serial": "ABC123456", "code": "1234"})
        pid = cfg["printers"][0]["id"]
        self.ctl._on_status(pid, {"state": "printing", "job": "Clip"})
        self.ctl._on_status(pid, {"state": "failed", "job": "Clip", "total_layers": 80})
        jobs = self.ctl.history()
        self.assertEqual((jobs[0]["job"], jobs[0]["outcome"], jobs[0]["printer_name"]), ("Clip", "failed", "A1"))

    def test_camera_hub_serves_frames_and_closes_when_idle(self):
        frames = [b"\xff\xd8one\xff\xd9", b"\xff\xd8two\xff\xd9"]

        def source(stop, cb):
            for f in frames:
                cb(f)
            stop.wait(0.2)

        hub = hq_print3d.CameraHub(source)
        hub.acquire()
        seq, frame, _err = hub.wait_frame(0, 2.0)
        self.assertGreaterEqual(seq, 1)
        self.assertIn(frame, frames)
        hub.release()
        hub.stop()

    def test_settings_validate_and_hide_the_cookie(self):
        cfg = self.ctl.save_settings({"handle": "@marc_makes", "cookie": "cf_clearance=abc; token=xyz123", "ua": "Mozilla/5.0 test agent"})
        self.assertEqual(cfg["makerworld"]["handle"], "marc_makes")
        self.assertTrue(cfg["makerworld"]["has_cookie"])
        self.assertNotIn("xyz123", json.dumps(cfg))
        with self.assertRaises(hq_print3d.Print3dError):
            self.ctl.save_settings({"handle": "bad handle!"})
        with self.assertRaises(hq_print3d.Print3dError):
            self.ctl.save_settings({"models_extra_root": "relative/path"})
        cfg = self.ctl.save_settings({"clear_cookie": True})
        self.assertFalse(cfg["makerworld"]["has_cookie"])


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="hq-print3d-lib-")
        base = Path(self._tmp.name)
        self.share = base / "Print"
        (self.share / "brackets").mkdir(parents=True)
        (self.share / "brackets" / "arm.stl").write_bytes(b"solid x\nendsolid x\n")
        with zipfile.ZipFile(self.share / "vase.3mf", "w") as zf:
            zf.writestr("Metadata/plate_1.png", PNG)
            zf.writestr("3D/3dmodel.model", "<model/>")
        (self.share / "notes.txt").write_text("not a model")
        (self.share / ".hidden.stl").write_bytes(b"x")
        self.outside = base / "outside"
        self.outside.mkdir()
        (self.outside / "secret.stl").write_bytes(b"solid secret")
        self.state = base / "state"
        self.state.mkdir()
        self.lib = models.Library(self.state, lambda: {"print": self.share, "extra": None})

    def tearDown(self):
        self._tmp.cleanup()

    def test_index_lists_models_only(self):
        res = self.lib.list()
        self.assertEqual(sorted(m["name"] for m in res["models"]), ["arm.stl", "vase.3mf"])
        vase = next(m for m in res["models"] if m["name"] == "vase.3mf")
        self.assertTrue(vase["has_thumb"])
        self.assertEqual(self.lib.thumbnail(vase["id"]), PNG)

    def test_gcode_headers_name_their_filaments(self):
        (self.share / "headed.gcode").write_text(
            "; HEADER_BLOCK_START\n; filament_type = PLA;PETG\n; filament_colour = #FF0000;#00FF00\nG28\n",
            encoding="utf-8")
        (self.share / "plain.gcode").write_text("G28\n", encoding="utf-8")
        self.lib.scan(force=True)
        ids = {m["name"]: m["id"] for m in self.lib.list()["models"]}
        headed = self.lib.inspect_print_file(ids["headed.gcode"])
        self.assertEqual((headed["kind"], [f["type"] for f in headed["filaments"]]), ("gcode", ["PLA", "PETG"]))
        self.assertEqual([f["colour"] for f in headed["filaments"]], ["#FF0000", "#00FF00"])
        self.assertEqual(self.lib.inspect_print_file(ids["plain.gcode"])["filaments"], [],
                         "no header, no invented material")

    def test_symlinks_are_skipped(self):
        try:
            os.symlink(self.outside / "secret.stl", self.share / "link.stl")
            os.symlink(self.outside, self.share / "linkdir", target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlink privilege unavailable")
        names = [m["name"] for m in self.lib.scan(force=True)]
        self.assertNotIn("link.stl", names)
        self.assertNotIn("secret.stl", names)

    def test_oversized_or_fake_thumbnail_is_refused(self):
        with zipfile.ZipFile(self.share / "big.3mf", "w") as zf:
            zf.writestr("Metadata/plate_1.png", b"\x89PNG" + b"\x00" * (models.MAX_THUMB + 10))
        with zipfile.ZipFile(self.share / "fake.3mf", "w") as zf:
            zf.writestr("Metadata/plate_1.png", b"<script>")
        rows = {m["name"]: m["id"] for m in self.lib.scan(force=True)}
        with self.assertRaises(models.ModelError):
            self.lib.thumbnail(rows["big.3mf"])
        with self.assertRaises(models.ModelError):
            self.lib.thumbnail(rows["fake.3mf"])

    def test_metadata_is_normalised_and_unknown_ids_refused(self):
        mid = next(m["id"] for m in self.lib.list()["models"] if m["name"] == "arm.stl")
        out = self.lib.update_meta(mid, {"tags": "Bracket, bracket ,  PETG", "origin": "designed", "printed_count": 3})
        self.assertEqual((out["tags"], out["origin"], out["printed_count"]), (["bracket", "petg"], "designed", 3))
        with self.assertRaises(models.ModelError):
            self.lib.update_meta(mid, {"origin": "stolen"})
        with self.assertRaises(models.ModelError):
            self.lib.get("../../secret")
        fh, size, name = self.lib.open_file(mid)
        with fh:
            self.assertEqual(fh.read(), b"solid x\nendsolid x\n")


def _opener(routes):
    def opener(req, timeout):
        url = req.full_url
        for prefix, result in routes:
            if url.startswith(prefix):
                if isinstance(result, Exception):
                    raise result
                return io.BytesIO(result)
        raise AssertionError("unexpected URL " + url)
    return opener


def _challenge(url):
    headers = Message()
    headers["cf-mitigated"] = "challenge"
    return urllib.error.HTTPError(url, 403, "Forbidden", headers, io.BytesIO(b""))


DESIGNS = json.dumps({"total": 2, "hits": [
    {"id": 11, "title": "Clip", "downloadCount": 30, "printCount": 12, "likeCount": 5, "collectionCount": 2,
     "coverUrl": "https://makerworld.bblmw.com/x.jpg"},
    {"id": 12, "title": "Hook", "downloadCount": 10, "printCount": 3, "likeCount": 1, "collectionCount": 0,
     "coverUrl": "https://evil.example/x.jpg"}]}).encode()
PROFILE = ('<html><script id="__NEXT_DATA__" type="application/json">'
           + json.dumps({"props": {"pageProps": {"selfFlag": True, "userInfo": {
               "uid": 777, "name": "Marc", "handle": "marc_makes", "fanCount": 42, "likeCount": 6,
               "boostGained": 9, "point": 120, "MWCount": {"myDesignDownloadCount": 40}}}}})
           + "</script></html>").encode()


class MakerWorldTests(unittest.TestCase):
    def test_profile_and_designs(self):
        snap = hq_makerworld.fetch("marc_makes", opener=_opener([
            ("https://makerworld.com/en/@marc_makes", PROFILE),
            ("https://makerworld.com/api/v1/design-service/published/777/design", DESIGNS)]))
        self.assertEqual(snap["uid"], 777)
        self.assertEqual(snap["profile"]["followers"], 42)
        self.assertEqual(snap["profile"]["points"], 120)
        self.assertEqual(snap["totals"]["downloads"], 40)
        self.assertEqual(snap["designs"][1]["cover"], "")        # off-host cover dropped

    def test_challenged_profile_falls_back_to_designs_with_known_uid(self):
        snap = hq_makerworld.fetch("marc_makes", uid=777, opener=_opener([
            ("https://makerworld.com/en/@", _challenge("https://makerworld.com/en/@marc_makes")),
            ("https://makerworld.com/api/v1/design-service/published/777/design", DESIGNS)]))
        self.assertIsNone(snap["profile"])
        self.assertEqual(snap["profile_error"], "makerworld_blocked")
        self.assertEqual(snap["totals"]["prints"], 15)

    def test_blocked_without_uid_is_a_clear_error(self):
        with self.assertRaises(hq_makerworld.MakerWorldError) as ctx:
            hq_makerworld.fetch("marc_makes", opener=_opener([
                ("https://makerworld.com/en/@", _challenge("https://makerworld.com/en/@marc_makes"))]))
        self.assertEqual(ctx.exception.code, "makerworld_blocked")

    def test_only_makerworld_is_contacted(self):
        with self.assertRaises(hq_makerworld.MakerWorldError):
            hq_makerworld._get("https://evil.example/", cookie="c", ua="", accept="*/*", opener=_opener([]))

    def test_refresh_keeps_history_and_last_snapshot_on_failure(self):
        with tempfile.TemporaryDirectory(prefix="hq-print3d-mw-") as tmp:
            with patch.object(hq_print3d.Controller, "ensure_links", lambda self: None):
                ctl = hq_print3d.Controller(Path(tmp))
                ctl.save_settings({"handle": "marc_makes", "uid": 777})
                good = _opener([("https://makerworld.com/en/@", PROFILE),
                                ("https://makerworld.com/api/v1/design-service/published/777/design", DESIGNS)])
                out = ctl.refresh_makerworld(opener=good)
                self.assertEqual(out["last"]["totals"]["downloads"], 40)
                self.assertEqual(len(out["history"]), 1)
                bad = _opener([("https://makerworld.com/", urllib.error.URLError("down"))])
                with self.assertRaises(hq_print3d.Print3dError):
                    ctl.refresh_makerworld(manual=True, opener=bad)     # rate-limited a minute after the last try
                out = ctl.refresh_makerworld(opener=bad)
                self.assertEqual(out["last_error"]["code"], "makerworld_unreachable")
                self.assertEqual(out["last"]["totals"]["downloads"], 40)


SLICE_INFO = b"""<?xml version="1.0" encoding="UTF-8"?>
<config><plate>
<metadata key="index" value="1"/><metadata key="printer_model_id" value="N1"/>
<metadata key="prediction" value="5400"/><metadata key="weight" value="12.34"/>
<filament id="1" type="PLA" color="#FF0000" used_g="10"/>
<filament id="3" type="PETG" color="#00FF00FF" used_g="2"/>
</plate></config>"""


def sliced_3mf(path: Path, plates=(1,), slice_info=SLICE_INFO) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        for n in plates:
            zf.writestr(f"Metadata/plate_{n}.gcode", "G28\n")
        if slice_info is not None:
            info_text = slice_info
            if slice_info is SLICE_INFO and len(plates) > 1:
                blocks = [
                    f'<plate><metadata key="index" value="{n}"/><metadata key="printer_model_id" value="N1"/>'
                    '<metadata key="prediction" value="5400"/><metadata key="weight" value="12.34"/>'
                    '<filament id="1" type="PLA" color="#FF0000" used_g="10"/>'
                    '<filament id="3" type="PETG" color="#00FF00FF" used_g="2"/></plate>'
                    for n in plates
                ]
                info_text = '<?xml version="1.0" encoding="UTF-8"?>\n<config>' + "".join(blocks) + "</config>"
            zf.writestr("Metadata/slice_info.config", info_text)
        zf.writestr("Metadata/plate_1.png", PNG)


class StartPrintTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="hq-print3d-start-")
        self.root = Path(self._tmp.name)
        self.share = self.root / "Print"
        self.share.mkdir()
        sliced_3mf(self.share / "clip.gcode.3mf", plates=(1, 2))
        with zipfile.ZipFile(self.share / "project.3mf", "w") as zf:
            zf.writestr("3D/3dmodel.model", "<model/>")
        (self.share / "cube.gcode").write_bytes(b"G28\n")
        (self.share / "arm.stl").write_bytes(b"solid x")
        self._patches = [patch.object(hq_print3d.Controller, "ensure_links", lambda self: None),
                         patch.object(hq_print3d.Controller, "_restart_link", lambda self, pid: None)]
        for p in self._patches:
            p.start()
        self.ctl = hq_print3d.Controller(self.root, lambda: self.share)
        cfg = self.ctl.save_printer({"name": "A1 mini", "kind": "bambu", "ip": "192.168.1.40",
                                     "serial": "0309DA1234567", "code": "12345678"})
        self.bambu_id = cfg["printers"][0]["id"]
        cfg = self.ctl.save_printer({"name": "Creator 5", "kind": "flashforge", "ip": "192.168.1.41",
                                     "serial": "SNMOMC9900", "code": "check99"})
        self.ff_id = cfg["printers"][1]["id"]
        self.ids = {m["name"]: m["id"] for m in self.ctl.library.list()["models"]}
        self.ams = [{"slot": 1, "material": "PLA", "colour": "#FF0000", "remain": 80, "active": False},
                    {"slot": 2, "material": "PETG", "colour": "#000000", "remain": 50, "active": False}]

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def ready(self, pid, state="idle", ams=None):
        self.ctl._on_link(pid, True, "")
        self.ctl._on_status(pid, {"state": state, "ams": self.ams if ams is None else ams})

    def test_bambu_slice_names_the_materials_the_job_needs(self):
        pid = self.bambu_id
        self.ready(pid, state="printing")
        self.ctl._status[pid]["job"] = "clip.gcode"
        self.ctl._jobs[pid] = {"start": 0, "name": "clip.gcode", "max_progress": 0, "estimate": None,
                               "tried": True, "printed": True, "ams_start": {}, "ams_last": {},
                               "materials": [], "counter_start": None, "counter_last": None,
                               "layers": None, "error_codes": []}
        with patch.object(self.ctl.library, "find_slice_file", lambda n: "m1"), \
                patch.object(self.ctl.library, "inspect_print_file",
                             lambda i, p: {"filaments": [{"type": "PLA", "g": 10.0}]}):
            self.ctl._resolve_slice(pid, "clip.gcode", 1)
        self.assertEqual(self.ctl._status[pid]["required"],
                         {"job": "clip.gcode", "materials": ["PLA"]})

    def test_flashforge_materials_come_from_the_sliced_file(self):
        pid = self.ff_id
        self.ready(pid, state="printing")
        self.ctl._status[pid]["job"] = "clip.3mf"
        self.ctl._jobs[pid] = {"name": "clip.3mf", "estimate": None}
        self.ctl._resolve_slice(pid, "clip.3mf", 1)
        self.assertEqual(self.ctl._status[pid]["required"],
                         {"job": "clip.3mf", "materials": ["PETG", "PLA"]})
        self.assertIsNone(self.ctl._jobs[pid]["estimate"],
                          "the alert does not touch the FlashForge filament estimate")

    def test_flashforge_stays_silent_without_slice_data(self):
        pid = self.ff_id
        self.ready(pid, state="printing")
        self.ctl._status[pid]["job"] = "unknown.gcode"
        self.ctl._jobs[pid] = {"name": "unknown.gcode", "estimate": None}
        self.ctl._resolve_slice(pid, "unknown.gcode", 1)
        self.assertNotIn("required", self.ctl._status[pid])

        # A G-code whose header names no filament stays silent too.
        self.ctl._status[pid]["job"] = "cube.gcode"
        self.ctl._jobs[pid] = {"name": "cube.gcode", "estimate": None}
        self.ctl._resolve_slice(pid, "cube.gcode", 1)
        self.assertNotIn("required", self.ctl._status[pid])

    def test_flashforge_gcode_headers_name_the_materials(self):
        pid = self.ff_id
        (self.share / "headed.gcode").write_text(
            "; filament_type = PLA;PETG\nG28\n", encoding="utf-8")
        self.ctl.library.scan(force=True)
        self.ready(pid, state="printing")
        self.ctl._status[pid]["job"] = "headed.gcode"
        self.ctl._jobs[pid] = {"name": "headed.gcode", "estimate": None}
        self.ctl._resolve_slice(pid, "headed.gcode", 1)
        self.assertEqual(self.ctl._status[pid]["required"],
                         {"job": "headed.gcode", "materials": ["PETG", "PLA"]})
        self.assertIsNone(self.ctl._jobs[pid]["estimate"],
                          "a G-code header gives materials, not a FlashForge estimate")

    def test_a_flashforge_printing_status_schedules_the_slice_lookup(self):
        pid = self.ff_id
        (self.share / "headed.gcode").write_text("; filament_type = PLA;PETG\nG28\n", encoding="utf-8")
        self.ctl.library.scan(force=True)
        started = []

        class Recorder:
            def __init__(self, target=None, args=(), **_kw):
                self.target, self.args = target, args

            def start(self):
                started.append(self)          # record only: nothing touches the share in the background

        with patch.object(hq_print3d.threading, "Thread", Recorder):
            self.ctl._on_link(pid, True, "")
            self.ctl._on_status(pid, {"state": "printing", "job": "headed.gcode"})
            self.assertEqual(len(started), 1, "the status schedules the lookup by itself")
            self.assertEqual(started[0].target.__name__, "_resolve_slice")
            self.assertEqual(tuple(started[0].args), (pid, "headed.gcode", 1))
            self.ctl._on_status(pid, {"state": "printing", "job": "headed.gcode", "progress": 2})
            self.assertEqual(len(started), 1, "the same job is looked up once, not every report")

        started[0].target(*started[0].args)    # run it as the thread would, deterministically
        self.assertEqual(self.ctl._status[pid]["required"],
                         {"job": "headed.gcode", "materials": ["PETG", "PLA"]})

    def test_a_finished_job_forgets_its_material_list(self):
        pid = self.ff_id
        with patch.object(self.ctl, "_resolve_slice", lambda *a: None):
            self.ctl._on_link(pid, True, "")
            self.ctl._on_status(pid, {"state": "printing", "job": "clip.3mf"})
            self.ctl._required[pid] = {"job": "clip.3mf", "materials": ["PETG"]}
            self.ctl._status[pid]["required"] = dict(self.ctl._required[pid])
            self.ctl._on_status(pid, {"state": "finished", "job": "clip.3mf"})
            self.assertNotIn(pid, self.ctl._required)
            self.assertNotIn("required", self.ctl._status[pid])

            # A later job with the same name must not inherit the old list.
            self.ctl._on_status(pid, {"state": "printing", "job": "clip.3mf"})
            self.assertNotIn("required", self.ctl._status[pid])

            self.ctl._required[pid] = {"job": "clip.3mf", "materials": ["PETG"]}
            self.ctl._on_status(pid, {"state": "idle"})
            self.assertNotIn(pid, self.ctl._required, "idle alone drops the stored list")

    def test_slice_info_is_read_from_bytes(self):
        info = self.ctl.library.inspect_print_file(self.ids["clip.gcode.3mf"])
        self.assertEqual((info["kind"], info["plates"], info["printer_model"]), ("bambu3mf", [1, 2], "A1 mini"))
        self.assertEqual((info["prediction_sec"], info["weight_g"]), (5400, 12.3))
        self.assertEqual([f["id"] for f in info["filaments"]], [1, 3])
        self.assertEqual(self.ctl.library.inspect_print_file(self.ids["project.3mf"])["kind"], "")
        self.assertEqual(self.ctl.library.inspect_print_file(self.ids["cube.gcode"])["kind"], "gcode")
        self.assertEqual(models.parse_slice_info(b'<!DOCTYPE x [<!ENTITY a "b">]><config/>'), {})

    def test_plan_refuses_offline_busy_unsliced_and_wrong_plate(self):
        with self.assertRaises(hq_print3d.Print3dError) as ctx:
            self.ctl.plan_print(self.bambu_id, self.ids["clip.gcode.3mf"])
        self.assertEqual(ctx.exception.code, "printer_offline")
        self.ready(self.bambu_id, state="printing")
        with self.assertRaises(hq_print3d.Print3dError) as ctx:
            self.ctl.plan_print(self.bambu_id, self.ids["clip.gcode.3mf"])
        self.assertEqual(ctx.exception.code, "printer_busy")
        self.ready(self.bambu_id)
        for name in ("project.3mf", "arm.stl", "cube.gcode"):
            with self.assertRaises(hq_print3d.Print3dError) as ctx:
                self.ctl.plan_print(self.bambu_id, self.ids[name])
            self.assertEqual(ctx.exception.code, "not_sliced", name)
        with self.assertRaises(hq_print3d.Print3dError) as ctx:
            self.ctl.plan_print(self.bambu_id, self.ids["clip.gcode.3mf"], plate=5)
        self.assertEqual(ctx.exception.code, "bad_plate")

    def test_plan_maps_filaments_to_loaded_slots(self):
        self.ready(self.bambu_id)
        plan = self.ctl.plan_print(self.bambu_id, self.ids["clip.gcode.3mf"], plate=2)
        self.assertEqual((plan["plate"], plan["use_ams"], plan["ams_mapping"]), (2, True, [0, -1, 1]))
        self.ready(self.bambu_id, ams=[self.ams[0]])
        with self.assertRaises(hq_print3d.Print3dError) as ctx:
            self.ctl.plan_print(self.bambu_id, self.ids["clip.gcode.3mf"])
        self.assertEqual(ctx.exception.code, "filament_mismatch")

    def test_bambu_start_uploads_then_sends_project_file(self):
        self.ready(self.bambu_id)
        sent, uploads = [], []

        class Link:
            def start_print(self, payload):
                sent.append(payload)
        self.ctl._links[self.bambu_id] = Link()
        with patch.object(bambu, "upload", lambda ip, code, path, remote: uploads.append((ip, code, Path(path).name, remote))):
            out = self.ctl.start_print(self.bambu_id, self.ids["clip.gcode.3mf"])
        self.assertTrue(out["ok"])
        self.assertEqual(uploads, [("192.168.1.40", "12345678", "clip.gcode.3mf", "clip.gcode.3mf")])
        body = sent[0]["print"]
        self.assertEqual((body["command"], body["param"], body["url"]),
                         ("project_file", "Metadata/plate_1.gcode", "file:///sdcard/clip.gcode.3mf"))
        self.assertEqual(body["ams_mapping"], [0, -1, 1])
        self.assertEqual(self.ctl.library.get(self.ids["clip.gcode.3mf"])["printed_count"], 1)

    def test_flashforge_start_streams_the_file_with_print_now(self):
        self.ready(self.ff_id, ams=[])
        calls = {}

        class Conn:
            def __init__(self, ip, port, timeout):
                calls["target"] = (ip, port)
                calls["headers"] = {}
                calls["body"] = b""

            def putrequest(self, method, path):
                calls["request"] = (method, path)

            def putheader(self, k, v):
                calls["headers"][k] = v

            def endheaders(self):
                pass

            def send(self, data):
                calls["body"] += data

            def getresponse(self):
                return type("R", (), {"status": 200, "read": lambda self, n: b'{"code":0}'})()

            def close(self):
                pass

        real = flashforge.upload_and_print

        class Link:
            def start_print(self, path, remote):
                real("192.168.1.41", "SNMOMC9900", "check99", path, remote, connection=Conn)
        self.ctl._links[self.ff_id] = Link()
        self.ctl.start_print(self.ff_id, self.ids["cube.gcode"])
        self.assertEqual(calls["target"], ("192.168.1.41", 8898))
        self.assertEqual(calls["request"], ("POST", "/uploadGcode"))
        self.assertEqual((calls["headers"]["printNow"], calls["headers"]["serialNumber"]), ("true", "SNMOMC9900"))
        self.assertIn(b"G28\n", calls["body"])
        self.assertEqual(int(calls["headers"]["Content-Length"]), len(calls["body"]))

    def test_bambu_upload_logs_in_and_maps_refusals(self):
        log = []

        class FakeFTP:
            def __init__(self, context=None, timeout=None):
                pass

            def connect(self, ip, port):
                log.append(("connect", ip, port))

            def login(self, user, pw):
                if pw != "12345678":
                    raise bambu.ftplib.error_perm("530 Login incorrect")
                log.append(("login", user))

            def prot_p(self):
                log.append("prot_p")

            def storbinary(self, cmd, fh, blocksize=0):
                log.append((cmd, fh.read()))

            def quit(self):
                pass

        path = self.share / "cube.gcode"
        bambu.upload("192.168.1.40", "12345678", str(path), "cube.gcode", opener=FakeFTP)
        self.assertEqual(log, [("connect", "192.168.1.40", 990), ("login", "bblp"), "prot_p", ("STOR cube.gcode", b"G28\n")])
        with self.assertRaises(bambu.BambuError):
            bambu.upload("192.168.1.40", "wrong", str(path), "cube.gcode", opener=FakeFTP)
        with self.assertRaises(bambu.BambuError):
            bambu.upload("192.168.1.40", "12345678", str(path), "../evil", opener=FakeFTP)


class MultiToolheadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.share = self.root / "share"
        self.share.mkdir()

    @staticmethod
    def _tiny_stl(path: Path) -> None:
        import struct
        buf = bytearray(84 + 50)
        buf[:80] = b"tiny".ljust(80, b" ")
        struct.pack_into("<I", buf, 80, 1)
        struct.pack_into("<12fH", buf, 84, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 10, 0, 0)
        path.write_bytes(bytes(buf))

    def test_flashforge_upload_encodes_material_mappings(self):
        import base64
        import json as _json
        gcode = self.share / "dual.gcode"
        gcode.write_text("; filament_type = PLA;PETG\nG28\n", encoding="utf-8")
        captured = {}

        class Conn:
            def __init__(self, ip, port, timeout=None):
                captured["headers"] = {}

            def putrequest(self, m, p):
                pass

            def putheader(self, k, v):
                captured["headers"][k] = v

            def endheaders(self):
                pass

            def send(self, d):
                pass

            def getresponse(self):
                return type("R", (), {"status": 200, "read": lambda s, n=0: b'{"code":0}'})()

            def close(self):
                pass

        flashforge.upload_and_print(
            "192.168.1.50", "SN1", "1234", str(gcode), "dual.gcode",
            use_matl_station=True, gcode_tool_cnt=2,
            material_mappings=[
                {"toolId": 0, "slotId": 1, "materialName": "PLA", "toolMaterialColor": "#112233", "slotMaterialColor": "#112233"},
                {"toolId": 1, "slotId": 2, "materialName": "PETG", "toolMaterialColor": "#445566", "slotMaterialColor": "#445566"},
            ],
            connection=Conn,
        )
        self.assertEqual(captured["headers"]["useMatlStation"], "true")
        self.assertEqual(captured["headers"]["gcodeToolCnt"], "2")
        decoded = _json.loads(base64.b64decode(captured["headers"]["materialMappings"]).decode("utf-8"))
        self.assertEqual(len(decoded), 2)
        self.assertEqual(decoded[1]["slotId"], 2)
        self.assertEqual(decoded[1]["materialName"], "PETG")

    def test_gcode_layers_tracks_tool_changes(self):
        gcode = self.share / "multi.gcode"
        gcode.write_text(
            ";LAYER_CHANGE\n;Z:0.2\nT0\n;TYPE:Outer wall\nG1 X10 Y10 E1.0\nG1 X20 Y10 E1.0\n"
            "T1\n;TYPE:Inner wall\nG1 X20 Y20 E1.0\nG1 X10 Y20 E1.0\n",
            encoding="utf-8",
        )
        lib = models.Library(self.root / "state", lambda: {"share": self.share})
        row = next(r for r in lib.scan() if r["name"] == "multi.gcode")
        res = lib.gcode_layers(row["id"])
        self.assertEqual(res["tools"], [0, 1])
        self.assertEqual(res["layers"][0]["paths"][0]["e"], 0)
        self.assertEqual(res["layers"][0]["paths"][1]["e"], 1)

    def test_multitool_3mf_and_bounds_guard(self):
        syn = self.root / "syn_c5"
        for sub in ("machine", "process", "filament"):
            (syn / sub).mkdir(parents=True)
        (syn / "machine" / "m.json").write_text(json.dumps({
            "type": "machine", "name": "Flashforge Creator 5 0.4 nozzle",
            "printer_model": "Flashforge Creator 5", "nozzle_diameter": ["0.4"],
        }), encoding="utf-8")
        (syn / "process" / "p.json").write_text(json.dumps({
            "type": "process", "name": "0.20mm Standard @Flashforge",
            "compatible_printers": ["Flashforge Creator 5 0.4 nozzle"],
        }), encoding="utf-8")
        for mat in ("PLA", "PETG"):
            (syn / "filament" / f"{mat}.json").write_text(json.dumps({
                "type": "filament", "name": f"Flashforge Generic {mat}",
                "compatible_printers": ["Flashforge Creator 5 0.4 nozzle"], "filament_type": [mat],
            }), encoding="utf-8")
        stl1 = self.share / "a.stl"
        stl2 = self.share / "b.stl"
        self._tiny_stl(stl1)
        self._tiny_stl(stl2)
        lib = models.Library(self.root / "state", lambda: {"share": self.share})
        rows = {r["name"]: r["id"] for r in lib.scan()}
        # Out-of-bounds object must be refused before slicing
        with patch.object(lib, "find_slicer", return_value="orca-slicer"):
            with self.assertRaises(models.ModelError) as ctx:
                lib.assemble_and_slice_plate(
                    [{"model_id": rows["a.stl"], "x": 400, "y": 400, "tool": 0}],
                    "Creator 5",
                    profile_roots=[syn],
                )
            self.assertEqual(ctx.exception.code, "out_of_bounds")

        # Multi-toolhead assembly writes studio_plate.3mf with extruder=1 and extruder=2
        built = {}

        def fake_run(cmd, **kw):
            inp = Path(cmd[-1])
            built["ext"] = inp.suffix
            with zipfile.ZipFile(inp) as zf:
                built["cfg"] = zf.read("Metadata/model_settings.config").decode("utf-8")
            out_dir = Path(cmd[cmd.index("--outputdir") + 1])
            out_name = cmd[cmd.index("--export-3mf") + 1]
            with zipfile.ZipFile(out_dir / out_name, "w") as zf:
                zf.writestr("Metadata/plate_1.gcode", "; filament_type = PLA;PETG\nG28\n")
            return type("P", (), {"returncode": 0})()

        with patch.object(lib, "find_slicer", return_value="orca-slicer"), \
             patch("subprocess.run", side_effect=fake_run):
            res = lib.assemble_and_slice_plate([
                {"model_id": rows["a.stl"], "x": 80, "y": 110, "tool": 0},
                {"model_id": rows["b.stl"], "x": 140, "y": 110, "tool": 1},
            ], "Creator 5", profile_roots=[syn])
        self.assertEqual(built["ext"], ".3mf")
        self.assertIn('key="extruder" value="1"', built["cfg"])
        self.assertIn('key="extruder" value="2"', built["cfg"])
        self.assertTrue(res.get("model"))

    def test_flashforge_plan_rejects_missing_material_and_over_2_tools_without_station(self):
        gcode4 = self.share / "four.gcode"
        gcode4.write_text("; filament_type = PLA;PLA;PLA;PLA\nG28\n", encoding="utf-8")
        with patch.object(hq_print3d.Controller, "ensure_links", lambda self: None), \
             patch.object(hq_print3d.Controller, "_restart_link", lambda self, pid: None):
            ctl = hq_print3d.Controller(self.root, lambda: self.share)
            cfg = ctl.save_printer({"name": "Creator 5", "kind": "flashforge", "ip": "192.168.1.50", "serial": "SNMOMC9900", "code": "check99"})
            pid = cfg["printers"][0]["id"]
            ctl._on_link(pid, True, "")
            ctl._on_status(pid, {"state": "idle", "ams": []})
            rows = {r["name"]: r["id"] for r in ctl.library.scan()}
            with self.assertRaises(hq_print3d.Print3dError) as ctx:
                ctl.plan_print(pid, rows["four.gcode"])
            self.assertEqual(ctx.exception.code, "filament_mismatch")


class AuditSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.share = self.root / "Print"
        self.share.mkdir()
        self._patches = [patch.object(hq_print3d.Controller, "ensure_links", lambda self: None),
                         patch.object(hq_print3d.Controller, "_restart_link", lambda self, pid: None)]
        for p in self._patches:
            p.start()
        self.ctl = hq_print3d.Controller(self.root, lambda: self.share)
        cfg = self.ctl.save_printer({"name": "A1", "kind": "bambu", "ip": "192.168.1.40",
                                     "serial": "0309DA1234567", "code": "12345678"})
        self.pid = cfg["printers"][0]["id"]

    def tearDown(self):
        for p in self._patches:
            p.stop()

    def test_unknown_and_cancel_states_fail_closed(self):
        self.assertEqual(bambu.normalise({"print": {"gcode_state": "WEIRD_NEW_STATE"}})["state"], "unknown")
        self.assertEqual(flashforge.normalise_detail({"status": "cancel"})["state"], "unknown")
        self.assertEqual(flashforge.normalise_detail({"status": "weird"})["state"], "unknown")
        self.assertEqual(flashforge.parse_legacy("MachineStatus: WEIRD\n", "", "")["state"], "unknown")
        sliced_3mf(self.share / "ok.gcode.3mf", plates=(1,))
        mid = next(r["id"] for r in self.ctl.library.scan() if r["name"] == "ok.gcode.3mf")
        self.ctl._on_link(self.pid, True, "")
        for bad in ("finished", "failed", "unknown", "preparing"):
            self.ctl._on_status(self.pid, {"state": bad})
            with self.assertRaises(hq_print3d.Print3dError) as ctx:
                self.ctl.plan_print(self.pid, mid)
            self.assertEqual(ctx.exception.code, "printer_busy")
        # Stale status (>60s) must also be refused
        self.ctl._on_status(self.pid, {"state": "idle"})
        self.ctl._status[self.pid]["updated"] = 1
        with self.assertRaises(hq_print3d.Print3dError) as ctx:
            self.ctl.plan_print(self.pid, mid)
        self.assertEqual(ctx.exception.code, "stale_status")

    def test_client_cannot_override_server_mappings(self):
        sliced_3mf(self.share / "ok.gcode.3mf", plates=(1,))
        mid = next(r["id"] for r in self.ctl.library.scan() if r["name"] == "ok.gcode.3mf")
        self.ctl._on_link(self.pid, True, "")
        self.ctl._on_status(self.pid, {"state": "idle", "ams": [{"slot": 1, "material": "PLA", "colour": "#FF0000"}]})
        with self.assertRaises(hq_print3d.Print3dError) as ctx:
            self.ctl.start_print(self.pid, mid, 1, {"ams_mapping": [3]})
        self.assertEqual(ctx.exception.code, "mapping_override")
        with self.assertRaises(hq_print3d.Print3dError) as ctx:
            self.ctl.start_sd_print(self.pid, "ok.gcode.3mf", 1, {"ams_mapping": [3]})
        self.assertEqual(ctx.exception.code, "mapping_override")

    def test_plate_2_uses_plate_2_filaments_and_missing_plate_empty(self):
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?><config>'
            '<plate><metadata key="index" value="1"/><metadata key="printer_model_id" value="N2S"/><filament id="1" type="PLA" used_g="10" used_m="3"/></plate>'
            '<plate><metadata key="index" value="2"/><metadata key="printer_model_id" value="N2S"/><filament id="1" type="PETG" used_g="20" used_m="6"/></plate>'
            '</config>'
        ).encode("utf-8")
        self.assertEqual(models.parse_slice_info(xml, 9), {})
        p3mf = self.share / "two.gcode.3mf"
        with zipfile.ZipFile(p3mf, "w") as zf:
            zf.writestr("Metadata/slice_info.config", xml)
            zf.writestr("Metadata/plate_1.gcode", "G28\n")
            zf.writestr("Metadata/plate_2.gcode", "G28\n")
        mid = next(r["id"] for r in self.ctl.library.scan() if r["name"] == "two.gcode.3mf")
        self.ctl._on_link(self.pid, True, "")
        self.ctl._on_status(self.pid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#111111"},
            {"slot": 2, "material": "PETG", "colour": "#222222"},
        ]})
        plan = self.ctl.plan_print(self.pid, mid, plate=2)
        self.assertEqual(plan["ams_mapping"], [1])

    def test_link_generation_ignores_stale_callbacks(self):
        self.ctl._link_gen[self.pid] = 2
        self.ctl._on_status(self.pid, {"state": "idle"}, gen=1)
        self.assertNotIn(self.pid, self.ctl._status)
        self.ctl._on_status(self.pid, {"state": "idle"}, gen=2)
        self.assertEqual(self.ctl._status[self.pid]["state"], "idle")

    def test_timelapse_capture_uses_cond_and_frame_at(self):
        hub = hq_print3d.CameraHub(lambda s, cb: None)
        hub._on_frame(b"\xff\xd8\xff\xd9")
        self.assertGreater(hub._frame_at, 0.0)
        self.ctl._hubs[self.pid] = hub
        self.ctl._jobs[self.pid] = {"printed": True}
        self.ctl._capture_timelapse()
        self.assertTrue(list((self.ctl.state_dir() / "timelapses" / "_active" / self.pid).glob("frame_*.jpg")))

    def test_multitool_3mf_escapes_quotes_and_rejects_nan(self):
        import struct
        import xml.etree.ElementTree as ET
        stl = self.share / "a&b.stl"
        buf = bytearray(84 + 50)
        buf[:80] = b"tiny".ljust(80, b" ")
        struct.pack_into("<I", buf, 80, 1)
        struct.pack_into("<12fH", buf, 84, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 10, 0, 0)
        stl.write_bytes(bytes(buf))
        out_3mf = self.root / "out.3mf"
        models.Library._write_multitool_3mf(out_3mf, [('a"b&c', 1, [((0, 0, 0), (1, 0, 0), (0, 1, 0))])])
        with zipfile.ZipFile(out_3mf) as zf:
            ET.fromstring(zf.read("Metadata/model_settings.config"))
        mid = next(r["id"] for r in self.ctl.library.scan() if r["name"] == "a&b.stl")
        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"):
            with self.assertRaises(models.ModelError) as ctx:
                self.ctl.library.assemble_and_slice_plate([{"model_id": mid, "x": float("nan"), "y": 100}])
            self.assertEqual(ctx.exception.code, "unreadable")

    def test_flashforge_missing_code_rejected(self):
        gcode = self.share / "ok.gcode"
        gcode.write_text("G28\n", encoding="utf-8")

        class Conn:
            def __init__(self, *a, **kw): pass
            def putrequest(self, *a): pass
            def putheader(self, *a): pass
            def endheaders(self): pass
            def send(self, *a): pass
            def getresponse(self): return type("R", (), {"status": 200, "read": lambda s, n=0: b"{}"})()
            def close(self): pass

        with self.assertRaises(flashforge.FlashforgeError):
            flashforge.upload_and_print("192.168.1.50", "SN1", "1234", str(gcode), "ok.gcode", connection=Conn)

    def test_preflight_gcode_rejects_overtemp_oob_and_bad_tool(self):
        prof = models.PRINTER_PROFILES["Creator 5"]
        for name, body, code in (
            ("hot_noz.gcode", "M104 S340\nG28\n", "temp_out_of_range"),
            ("hot_bed.gcode", "M140 S140\nG28\n", "temp_out_of_range"),
            ("oob.gcode", "G90\nG1 X300 Y10 Z1\n", "out_of_bounds"),
        ):
            p = self.share / name
            p.write_text(body, encoding="utf-8")
            with self.assertRaises(models.ModelError) as ctx:
                models.preflight_gcode(p, 1, prof)
            self.assertEqual(ctx.exception.code, code)
        p_t = self.share / "bad_tool.gcode"
        p_t.write_text("T5\nG1 X10 Y10\n", encoding="utf-8")
        with self.assertRaises(models.ModelError) as ctx:
            models.preflight_gcode(p_t, 1, models.PRINTER_PROFILES["AD5X"])
        self.assertEqual(ctx.exception.code, "tool_out_of_range")

    def test_studio_rejects_unknown_profile_over_16_items_and_bad_slice_output(self):
        import struct
        stl = self.share / "cube.stl"
        buf = bytearray(84 + 50)
        buf[:80] = b"tiny".ljust(80, b" ")
        struct.pack_into("<I", buf, 80, 1)
        struct.pack_into("<12fH", buf, 84, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 10, 0, 0)
        stl.write_bytes(bytes(buf))
        mid = next(r["id"] for r in self.ctl.library.scan() if r["name"] == "cube.stl")
        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"):
            with self.assertRaises(models.ModelError) as ctx1:
                self.ctl.library.assemble_and_slice_plate([{"model_id": mid}], "NoSuchPrinter")
            self.assertEqual(ctx1.exception.code, "unknown_printer_profile")
            with self.assertRaises(models.ModelError) as ctx2:
                self.ctl.library.assemble_and_slice_plate([{"model_id": mid}] * 17, "Creator 5")
            self.assertEqual(ctx2.exception.code, "too_many_items")

            def bad_slice(cmd, **kw):
                assert "--load-filaments" in cmd
                out_dir = Path(cmd[cmd.index("--outputdir") + 1])
                out_name = cmd[cmd.index("--export-3mf") + 1]
                with zipfile.ZipFile(out_dir / out_name, "w") as zf:
                    zf.writestr("Metadata/plate_1.gcode", "G90\nG1 X400 Y10\n")
                return type("P", (), {"returncode": 0})()

            syn = self.root / "syn_c5_bad"
            for sub in ("machine", "process", "filament"):
                (syn / sub).mkdir(parents=True)
            (syn / "machine" / "m.json").write_text(json.dumps({
                "type": "machine", "name": "Flashforge Creator 5 0.4 nozzle",
                "printer_model": "Flashforge Creator 5", "nozzle_diameter": ["0.4"],
            }), encoding="utf-8")
            (syn / "process" / "p.json").write_text(json.dumps({
                "type": "process", "name": "0.20mm Standard @Flashforge",
                "compatible_printers": ["Flashforge Creator 5 0.4 nozzle"],
            }), encoding="utf-8")
            (syn / "filament" / "PLA.json").write_text(json.dumps({
                "type": "filament", "name": "Flashforge Generic PLA",
                "compatible_printers": ["Flashforge Creator 5 0.4 nozzle"], "filament_type": ["PLA"],
            }), encoding="utf-8")
            with patch("subprocess.run", side_effect=bad_slice):
                with self.assertRaises(models.ModelError) as ctx3:
                    self.ctl.library.assemble_and_slice_plate(
                        [{"model_id": mid, "x": 100, "y": 100}],
                        "Creator 5",
                        {"tools": [{"material": "PLA", "color": "#FFFFFF"}]},
                        profile_roots=[syn],
                    )
                self.assertEqual(ctx3.exception.code, "out_of_bounds")

    def test_v2_reaudit_bypasses_and_regressions_fixed(self):
        prof = models.PRINTER_PROFILES["AD5M"]
        for name, body in (
            ("c_arc.gcode", "G2 X900 Y10 I100 J0\n"),
            ("c_temp.gcode", "M104S900\n"),
            ("c_move.gcode", "G1X900 Y10\n"),
            ("c_tool.gcode", "T999\n"),
            ("c_nan.gcode", "G1 Xabc Y12\n"),
            ("c_unk.gcode", "M810 X900 S999\n"),
        ):
            p = self.share / name
            p.write_text(body, encoding="utf-8")
            with self.assertRaises(models.ModelError, msg=name):
                models.preflight_gcode(p, 1, prof)

        # Disconnect clears status so reconnect without new status cannot authorize
        self.ctl._on_link(self.pid, True, "")
        self.ctl._on_status(self.pid, {"state": "idle"})
        self.ctl._on_link(self.pid, False, "down")
        self.assertNotIn(self.pid, self.ctl._status)

        # Unloaded AMS slot is never picked
        with self.assertRaises(hq_print3d.Print3dError) as ctx:
            self.ctl._map_filaments(
                [{"id": 1, "type": "PLA", "colour": "#FF0000"}],
                [{"slot": 1, "material": "PLA", "colour": "#FF0000", "loaded": False}],
            )
        self.assertEqual(ctx.exception.code, "filament_mismatch")

        # Spool save works end-to-end (no atomic_write_json AttributeError)
        import hq_print3d_filament as filament
        sp = filament.save_spool(self.ctl.state_dir(), {"material": "PLA", "colour": "#112233", "initial_g": 1000})
        self.assertTrue(sp["id"].startswith("s-"))

        # Malformed queue schema raises state_unreadable instead of overwriting
        self.ctl._queue_path().write_text('{"items":"bad"}', encoding="utf-8")
        with self.assertRaises(hq_print3d.Print3dError) as qctx:
            self.ctl.queue_list()
        self.assertEqual(qctx.exception.code, "state_unreadable")

    def test_remaining_m1_m8_h9_fixes(self):
        # M1: ams_load refuses during printing & uses slot material temperature
        link = bambu.BambuLink("192.168.1.40", "0309DA1234567", "12345678", lambda s: None, lambda ok, e: None)
        sent = []
        link._send = lambda pkt: sent.append(pkt)
        link._report = {"print": {"gcode_state": "RUNNING"}}
        with self.assertRaises(bambu.BambuError):
            link.control("ams_load", {"slot": 1})
        link._report = {"print": {"gcode_state": "IDLE", "ams": {"ams": [{"id": "0", "tray": [{"id": "0", "tray_type": "PETG"}]}]}}}
        link.control("ams_load", {"slot": 1})
        self.assertIn(b'"tar_temp": 245', sent[0])

        # M8: subscribe_events signals evicted listener with None
        qs = [self.ctl.subscribe_events() for _ in range(9)]
        self.assertIsNone(qs[0].get_nowait())

        # H9: _open_tls pins TOFU cert and rejects mismatch
        pinned = []
        fake_sock = type("S", (), {"getpeercert": lambda self, binary_form=False: b"certA", "close": lambda self: None})()
        with patch("socket.create_connection", return_value=type("R", (), {"close": lambda self: None})()), \
             patch("hq_print3d_bambu._tls_context") as ctx_fn:
            ctx_fn.return_value.wrap_socket.return_value = fake_sock
            s = bambu._open_tls("192.168.1.40", 8883, on_pin=pinned.append)
            self.assertIs(s, fake_sock)
            self.assertEqual(len(pinned), 1)
            with self.assertRaises(bambu.BambuError):
                bambu._open_tls("192.168.1.40", 8883, expected_fp="deadbeef")

    def test_v3_reaudit_blockers_fixed(self):
        # M109 R900, extreme F, extreme E rejected
        prof = models.PRINTER_PROFILES["Creator 5"]
        for name, body in (
            ("rtemp.gcode", "M109 R900\n"),
            ("fast.gcode", "G1 X10 Y10 F999999\n"),
            ("ext.gcode", "G1 X10 Y10 E99999\n"),
        ):
            p = self.share / name
            p.write_text(body, encoding="utf-8")
            with self.assertRaises(models.ModelError, msg=name):
                models.preflight_gcode(p, 1, prof)

        # AMS load/unload refused in paused/unknown states
        link = bambu.BambuLink("192.168.1.40", "0309DA1234567", "12345678", lambda s: None, lambda ok, e: None)
        for st in ("PAUSE", ""):
            link._report = {"print": {"gcode_state": st}}
            with self.assertRaises(bambu.BambuError):
                link.control("ams_load", {"slot": 1})

        # save_printer preserves tls_fp when IP & serial unchanged
        self.ctl._pin_tls_fp(self.pid, "abc123pin")
        self.ctl.save_printer({"id": self.pid, "name": "A1 Renamed", "kind": "bambu",
                               "ip": "192.168.1.40", "serial": "0309DA1234567", "code": ""})
        self.assertEqual(self.ctl._printer_cfg(self.pid).get("tls_fp"), "abc123pin")

        # SSE full-queue eviction still delivers None sentinel
        qs = [self.ctl.subscribe_events() for _ in range(8)]
        for i in range(16):
            qs[0].put_nowait(i)
        self.ctl.subscribe_events()
        drained = []
        while not qs[0].empty():
            drained.append(qs[0].get_nowait())
        self.assertIn(None, drained)

        # queue_list rejects malformed row inside items list
        self.ctl._queue_path().write_text('{"items":["bad"]}', encoding="utf-8")
        with self.assertRaises(hq_print3d.Print3dError) as qctx:
            self.ctl.queue_list()
        self.assertEqual(qctx.exception.code, "state_unreadable")

    def test_v4_reaudit_fixes(self):
        # V4-H1: M220/M221/M204 extreme overrides rejected
        prof = models.PRINTER_PROFILES["AD5M"]
        for name, body in (
            ("m220.gcode", "M220 S999999\n"),
            ("m221.gcode", "M221 S999999\n"),
            ("m204.gcode", "M204 S999999\n"),
        ):
            p = self.share / name
            p.write_text(body, encoding="utf-8")
            with self.assertRaises(models.ModelError, msg=name):
                models.preflight_gcode(p, 1, prof)

        # V4-H2: Unknown model and AD5X T1 without station rejected
        (self.share / "t1.gcode").write_text("T1\nG1 X10 Y10\n", encoding="utf-8")
        mid_t1 = next(r["id"] for r in self.ctl.library.scan() if r["name"] == "t1.gcode")
        cfg_u = self.ctl.save_printer({"name": "Unknown Model", "kind": "flashforge", "ip": "192.168.1.77", "serial": "SNMOMC9901", "code": "check99"})
        uid = next(p["id"] for p in cfg_u["printers"] if p["name"] == "Unknown Model")
        self.ctl._on_link(uid, True, "")
        self.ctl._on_status(uid, {"state": "idle"})
        with self.assertRaises(hq_print3d.Print3dError) as uctx:
            self.ctl.plan_print(uid, mid_t1)
        self.assertEqual(uctx.exception.code, "unknown_printer_profile")

        cfg_ax = self.ctl.save_printer({"name": "AD5X", "kind": "flashforge", "ip": "192.168.1.78", "serial": "SNMOMC9902", "code": "check99"})
        axid = next(p["id"] for p in cfg_ax["printers"] if p["name"] == "AD5X")
        self.ctl._on_link(axid, True, "")
        self.ctl._on_status(axid, {"state": "idle", "ams": []})
        with self.assertRaises(hq_print3d.Print3dError) as axctx:
            self.ctl.plan_print(axid, mid_t1)
        self.assertEqual(axctx.exception.code, "filament_mismatch")

        # V4-H3: _pending_start survives stale idle and blocks second start (and A1 rejects A1 mini file)
        sliced_3mf(self.share / "ok.gcode.3mf", plates=(1,))
        mid_ok = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "ok.gcode.3mf")
        self.ctl._on_link(self.pid, True, "")
        self.ctl._on_status(self.pid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        with self.assertRaises(hq_print3d.Print3dError) as mctx:
            self.ctl.plan_print(self.pid, mid_ok)
        self.assertEqual(mctx.exception.code, "printer_mismatch")

        cfg_m = self.ctl.save_printer({"name": "A1 mini", "kind": "bambu", "ip": "192.168.1.79", "serial": "0309DA1234568", "code": "12345678"})
        mid_pr = next(p["id"] for p in cfg_m["printers"] if p["name"] == "A1 mini")
        self.ctl._on_link(mid_pr, True, "")
        self.ctl._on_status(mid_pr, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        self.ctl._links[mid_pr] = type("L", (), {"start_print": lambda s, p: None})()
        with patch.object(bambu, "upload", lambda *a: None):
            self.ctl.start_print(mid_pr, mid_ok)
        self.ctl._on_status(mid_pr, {"state": "idle"})
        with self.assertRaises(hq_print3d.Print3dError) as pctx:
            self.ctl.plan_print(mid_pr, mid_ok)
        self.assertEqual(pctx.exception.code, "printer_busy")

        # V4-H4: queue_dispatch aborts on first printer_error without failover
        qitem = self.ctl.queue_add(mid_ok, 1, "auto")
        calls = []
        def fail_start(pid, *a):
            calls.append(pid)
            raise hq_print3d.Print3dError("timeout", 502, "printer_error")
        with patch.object(self.ctl, "start_print", side_effect=fail_start):
            with self.assertRaises(hq_print3d.Print3dError):
                self.ctl.queue_dispatch(qitem["id"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.ctl.queue_list()[0]["status"], "ambiguous")

        # V4-H5: ams_load rejects missing slot instead of defaulting to PLA
        link = bambu.BambuLink("192.168.1.40", "0309DA1234567", "12345678", lambda s: None, lambda ok, e: None)
        link._report = {"print": {"gcode_state": "IDLE", "ams": {"ams": [{"id": "0", "tray": [{"id": "1", "tray_type": "PETG"}]}]}}}
        with self.assertRaises(bambu.BambuError):
            link.control("ams_load", {"slot": 1})

        # Empty cert rejected when expected_fp is set
        no_cert = type("S", (), {"getpeercert": lambda self, binary_form=False: None, "close": lambda self: None})()
        with patch("socket.create_connection", return_value=type("R", (), {"close": lambda self: None})()), \
             patch("hq_print3d_bambu._tls_context") as ctx_fn:
            ctx_fn.return_value.wrap_socket.return_value = no_cert
            with self.assertRaises(bambu.BambuError):
                bambu._open_tls("192.168.1.40", 8883, expected_fp="deadbeef")

        # Legacy queue JSON schema validator rejects incomplete dict row {}
        self.ctl._queue_path().write_text('{"items":[{}]}', encoding="utf-8")
        with self.assertRaises(hq_print3d.Print3dError) as qctx2:
            self.ctl._read_queue_json()
        self.assertEqual(qctx2.exception.code, "state_unreadable")

    def test_v5_reaudit_fixes(self):
        # 1. Ordinary controls (light_on) do NOT create _pending_start or block plan_print
        sliced_3mf(self.share / "ok.gcode.3mf", plates=(1,))
        mid_ok = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "ok.gcode.3mf")
        cfg_m = self.ctl.save_printer({"name": "A1 mini", "kind": "bambu", "ip": "192.168.1.80", "serial": "0309DA1234569", "code": "12345678"})
        mpid = next(p["id"] for p in cfg_m["printers"] if p["name"] == "A1 mini")
        self.ctl._on_link(mpid, True, "")
        self.ctl._on_status(mpid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        self.ctl._links[mpid] = type("L", (), {
            "command": lambda s, c: None,
            "control": lambda s, a, p=None: None,
            "start_print": lambda s, p: None,
        })()
        self.ctl.command(mpid, "light_on")
        self.ctl.direct_command(mpid, "light_on")
        self.assertNotIn(mpid, self.ctl._pending_start)
        self.assertEqual(self.ctl.plan_print(mpid, mid_ok)["plate"], 1)

        # 2. Unrelated preparing->idle does NOT clear _pending_start; ambiguous error retains reservation
        with patch.object(bambu, "upload", lambda *a: None):
            self.ctl.start_print(mpid, mid_ok)
        self.ctl._on_status(mpid, {"state": "preparing", "job": "other_job"})
        self.ctl._on_status(mpid, {"state": "idle"})
        with self.assertRaises(hq_print3d.Print3dError) as pctx:
            self.ctl.plan_print(mpid, mid_ok)
        self.assertEqual(pctx.exception.code, "printer_busy")

        # Ambiguous direct start error retains _pending_start
        self.ctl._release_pending_start(mpid)
        self.ctl._on_status(mpid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        def boom_start(p):
            raise bambu.BambuError("timeout after send")
        self.ctl._links[mpid].start_print = boom_start
        with patch.object(bambu, "upload", lambda *a: None):
            with self.assertRaises(hq_print3d.Print3dError):
                self.ctl.start_print(mpid, mid_ok)
        self.assertTrue(self.ctl._pending_start[mpid]["ambiguous"])
        with self.assertRaises(hq_print3d.Print3dError) as pctx2:
            self.ctl.start_print(mpid, mid_ok)
        self.assertEqual(pctx2.exception.code, "printer_busy")

        # 3. Unrecognized sliced_for rejected
        bad_3mf = self.share / "unrec.gcode.3mf"
        bad_xml = '<?xml version="1.0"?><config><plate><metadata key="index" value="1"/><metadata key="printer_model_id" value="UNRECOGNIZED"/></plate></config>'
        sliced_3mf(bad_3mf, plates=(1,), slice_info=bad_xml)
        mid_bad = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "unrec.gcode.3mf")
        self.ctl._release_pending_start(mpid)
        self.ctl._on_status(mpid, {"state": "idle", "ams": [{"slot": 1, "material": "PLA", "colour": "#FF0000"}]})
        with self.assertRaises(hq_print3d.Print3dError) as mctx:
            self.ctl.plan_print(mpid, mid_bad)
        self.assertEqual(mctx.exception.code, "printer_mismatch")

        # 4. M205 X30000 and M220 Q999999 rejected
        for name, body in (("m205.gcode", "M205 X30000\n"), ("m220q.gcode", "M220 Q999999\n")):
            gp = self.share / name
            gp.write_text(body, encoding="utf-8")
            with self.assertRaises(models.ModelError, msg=name):
                models.preflight_gcode(gp, 1, models.PRINTER_PROFILES["A1 mini"])

    def test_v6_reaudit_fixes(self):
        # 1. Empty job in printing followed by idle does NOT clear _pending_start
        sliced_3mf(self.share / "ok.gcode.3mf", plates=(1,))
        mid_ok = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "ok.gcode.3mf")
        cfg_m = self.ctl.save_printer({"name": "A1 mini", "kind": "bambu", "ip": "192.168.1.81",
                                       "serial": "0309DA1234570", "code": "12345678", "model": "A1 mini"})
        mpid = next(p["id"] for p in cfg_m["printers"] if p["ip"] == "192.168.1.81")
        self.assertEqual(self.ctl._printer_cfg(mpid)["model"], "A1 mini")
        self.ctl._on_link(mpid, True, "")
        self.ctl._on_status(mpid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        self.ctl._links[mpid] = type("L", (), {"start_print": lambda s, p: None})()
        with patch.object(bambu, "upload", lambda *a: None):
            self.ctl.start_print(mpid, mid_ok)
        self.ctl._on_status(mpid, {"state": "printing", "job": ""})
        self.ctl._on_status(mpid, {"state": "idle"})
        with self.assertRaises(hq_print3d.Print3dError) as e1:
            self.ctl.start_print(mpid, mid_ok)
        self.assertEqual(e1.exception.code, "printer_busy")

        # 2. Disconnect + reconnect + fresh idle after ambiguous timeout retains _pending_start
        self.ctl._release_pending_start(mpid)
        self.ctl._on_status(mpid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        self.ctl._links[mpid] = type("L", (), {"start_print": lambda s, p: (_ for _ in ()).throw(bambu.BambuError("timeout"))})()
        with patch.object(bambu, "upload", lambda *a: None):
            with self.assertRaises(hq_print3d.Print3dError):
                self.ctl.start_print(mpid, mid_ok)
        self.ctl._on_link(mpid, False, "dropped")
        self.ctl._on_link(mpid, True, "")
        self.ctl._on_status(mpid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        with self.assertRaises(hq_print3d.Print3dError) as e2:
            self.ctl.start_print(mpid, mid_ok)
        self.assertEqual(e2.exception.code, "printer_busy")

        # 3. M221 T15 on AD5M, M104 T999 S220, and G1 X10 S999999 rejected
        for name, body in (
            ("m221t.gcode", "M221 T15 S100\n"),
            ("m104t.gcode", "M104 T999 S220\n"),
            ("g1s.gcode", "G1 X10 S999999\n"),
        ):
            gp = self.share / name
            gp.write_text(body, encoding="utf-8")
            with self.assertRaises(models.ModelError, msg=name):
                models.preflight_gcode(gp, 1, models.PRINTER_PROFILES["AD5M"])

    def test_v7_reaudit_fixes(self):
        # 1. Family mismatch rejected in save_printer(); public_config() exposes model; plan_print() uses stored model
        with self.assertRaises(hq_print3d.Print3dError):
            self.ctl.save_printer({"name": "Creator 5", "kind": "flashforge", "model": "A1 mini",
                                   "ip": "192.168.1.82", "serial": "SNMOMC9903", "code": "check99"})
        cfg_ff = self.ctl.save_printer({"name": "Creator 5", "kind": "flashforge", "model": "AD5M",
                                        "ip": "192.168.1.82", "serial": "SNMOMC9903", "code": "check99"})
        ff_row = next(p for p in cfg_ff["printers"] if p["ip"] == "192.168.1.82")
        self.assertEqual(ff_row["model"], "AD5M")
        (self.share / "t1_only.gcode").write_text("T1\nG1 X10 Y10\n", encoding="utf-8")
        mid_t1 = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "t1_only.gcode")
        self.ctl._on_link(ff_row["id"], True, "")
        self.ctl._on_status(ff_row["id"], {"state": "idle"})
        with self.assertRaises(hq_print3d.Print3dError):
            self.ctl.plan_print(ff_row["id"], mid_t1)

        # 2. Substring job name ('clip-some-other-job') does NOT clear pending_start for 'clip'
        sliced_3mf(self.share / "clip_v7.gcode.3mf", plates=(1,))
        mid_clip = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "clip_v7.gcode.3mf")
        cfg_m = self.ctl.save_printer({"name": "A1 mini", "kind": "bambu", "model": "A1 mini",
                                       "ip": "192.168.1.83", "serial": "0309DA1234571", "code": "12345678"})
        mpid = next(p["id"] for p in cfg_m["printers"] if p["ip"] == "192.168.1.83")
        self.ctl._on_link(mpid, True, "")
        self.ctl._on_status(mpid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        self.ctl._links[mpid] = type("L", (), {"start_print": lambda s, p: None})()
        with patch.object(bambu, "upload", lambda *a: None):
            self.ctl.start_print(mpid, mid_clip)
        self.ctl._on_status(mpid, {"state": "printing", "job": "clip_v7-some-other-job"})
        self.ctl._on_status(mpid, {"state": "idle"})
        with self.assertRaises(hq_print3d.Print3dError) as sub_ctx:
            self.ctl.start_print(mpid, mid_clip)
        self.assertEqual(sub_ctx.exception.code, "printer_busy")

        # 3. Restart-persistent pending_starts.json survives new Controller instance
        ctl2 = hq_print3d.Controller(self.root, lambda: self.share)
        ctl2._on_link(mpid, True, "")
        ctl2._on_status(mpid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        with self.assertRaises(hq_print3d.Print3dError) as rst_ctx:
            ctl2.plan_print(mpid, mid_clip)
        self.assertEqual(rst_ctx.exception.code, "printer_busy")

        # 4. Bambu 3MF with empty sliced_for (missing slice_info) rejected
        no_meta = self.share / "nometa.gcode.3mf"
        sliced_3mf(no_meta, plates=(1,), slice_info=None)
        mid_nm = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "nometa.gcode.3mf")
        self.ctl._release_pending_start(mpid)
        self.ctl._on_status(mpid, {"state": "idle", "ams": [{"slot": 1, "material": "PLA", "colour": "#FF0000"}]})
        with self.assertRaises(hq_print3d.Print3dError) as nm_ctx:
            self.ctl.plan_print(mpid, mid_nm)
        self.assertEqual(nm_ctx.exception.code, "not_sliced")

        # 5. M900 K999999, M620 S999999, G4 P999999999, M221 T0.5, and M83 E4999 rejected
        for name, body in (
            ("m900.gcode", "M900 K999999\n"),
            ("m620.gcode", "M620 S999999\n"),
            ("g4.gcode", "G4 P999999999\n"),
            ("m221f.gcode", "M221 T0.5 S100\n"),
            ("m83e.gcode", "M83\nG1 E4999\n"),
        ):
            gp = self.share / name
            gp.write_text(body, encoding="utf-8")
            with self.assertRaises(models.ModelError, msg=name):
                models.preflight_gcode(gp, 1, models.PRINTER_PROFILES["A1 mini"])

    def test_v8_reaudit_fixes(self):
        import hq_state
        sliced_3mf(self.share / "clip_v8.gcode.3mf", plates=(1,))
        mid_clip = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "clip_v8.gcode.3mf")
        cfg_m = self.ctl.save_printer({"name": "A1 mini", "kind": "bambu", "model": "A1 mini",
                                       "ip": "192.168.1.84", "serial": "0309DA1234572", "code": "12345678"})
        mpid = next(p["id"] for p in cfg_m["printers"] if p["ip"] == "192.168.1.84")
        self.ctl._on_link(mpid, True, "")
        self.ctl._on_status(mpid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        calls = []
        self.ctl._links[mpid] = type("L", (), {"start_print": lambda s, p: calls.append(p)})()

        # HIGH-1: write failure on pending_starts.json aborts BEFORE link.start_print (0 calls)
        orig_write = hq_state.write_json_atomic
        def fail_pending(path, data, **kw):
            if Path(path).name == "pending_starts.json":
                raise OSError("simulated disk full")
            return orig_write(path, data, **kw)
        with patch.object(bambu, "upload", lambda *a: None), \
             patch.object(hq_state, "write_json_atomic", side_effect=fail_pending):
            with self.assertRaises(hq_print3d.Print3dError) as wctx:
                self.ctl.start_print(mpid, mid_clip)
        self.assertEqual(wctx.exception.code, "state_unwritable")
        self.assertEqual(len(calls), 0)

        # HIGH-2: corrupted pending_starts.json fails closed with state_unreadable & preserves bytes
        self.ctl._pending_start.clear()
        self.ctl._pending_path().write_text("{bad json", encoding="utf-8")
        with self.assertRaises(hq_print3d.Print3dError) as cctx:
            self.ctl.plan_print(mpid, mid_clip)
        self.assertEqual(cctx.exception.code, "state_unreadable")
        self.assertEqual(self.ctl._pending_path().read_text(encoding="utf-8"), "{bad json")
        self.ctl._pending_path().unlink()

        # HIGH-3: Two Controllers sharing one root cannot both dispatch
        ctl_b = hq_print3d.Controller(self.root, lambda: self.share)
        ctl_b._on_link(mpid, True, "")
        ctl_b._on_status(mpid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        ctl_b._links[mpid] = self.ctl._links[mpid]
        with patch.object(bambu, "upload", lambda *a: None):
            self.ctl.start_print(mpid, mid_clip)
            with self.assertRaises(hq_print3d.Print3dError) as two_ctx:
                ctl_b.start_print(mpid, mid_clip)
        self.assertEqual(two_ctx.exception.code, "printer_busy")
        self.assertEqual(len(calls), 1)

        # HIGH-4: Unverified remote SD file rejected
        self.ctl._release_pending_start(mpid)
        self.ctl._on_status(mpid, {"state": "idle", "ams": [{"slot": 1, "material": "PLA", "colour": "#FF0000"}]})
        with self.assertRaises(hq_print3d.Print3dError) as sd_ctx:
            self.ctl.start_sd_print(mpid, "mystery_remote.gcode.3mf", 1)
        self.assertEqual(sd_ctx.exception.code, "unverified_sd_file")

        # MEDIUM-1 & MEDIUM-2: G92 E0 accepted, G92 X0 rejected, M83 E500 rejected
        good_g92 = self.share / "good_g92.gcode"
        good_g92.write_text("M83\nG92 E0\nG1 X10 Y10 E2.5 F1200\nG92 E0\n", encoding="utf-8")
        models.preflight_gcode(good_g92, 1, models.PRINTER_PROFILES["A1 mini"])
        for name, body in (("bad_g92x.gcode", "G92 X0\n"), ("bad_m83e.gcode", "M83\nG1 E500 F1200\n")):
            gp = self.share / name
            gp.write_text(body, encoding="utf-8")
            with self.assertRaises(models.ModelError, msg=name):
                models.preflight_gcode(gp, 1, models.PRINTER_PROFILES["A1 mini"])

    def test_v9_reaudit_fixes(self):
        # 1. FlashForge becoming busy between plan_print and dispatch is refused
        (self.share / "ff.gcode").write_text("G1 X10 Y10\n", encoding="utf-8")
        mid_ff = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "ff.gcode")
        cfg_ff = self.ctl.save_printer({"name": "Creator 5", "kind": "flashforge", "model": "Creator 5",
                                        "ip": "192.168.1.85", "serial": "SNMOMC9905", "code": "check99"})
        fpid = next(p["id"] for p in cfg_ff["printers"] if p["ip"] == "192.168.1.85")
        self.ctl._on_link(fpid, True, "")
        self.ctl._on_status(fpid, {"state": "idle"})
        ff_calls = []
        self.ctl._links[fpid] = type("L", (), {"start_print": lambda s, p, r: ff_calls.append(r)})()
        orig_plan = self.ctl.plan_print
        def plan_then_busy(*a):
            res = orig_plan(*a)
            self.ctl._on_status(fpid, {"state": "printing", "job": "other"})
            return res
        with patch.object(self.ctl, "plan_print", side_effect=plan_then_busy):
            with self.assertRaises(hq_print3d.Print3dError) as fctx:
                self.ctl.start_print(fpid, mid_ff)
        self.assertEqual(fctx.exception.code, "printer_busy")
        self.assertEqual(len(ff_calls), 0)

        # 2. start_sd_print rejects remote SD file whose bytes differ from local verified file
        sliced_3mf(self.share / "sd_ok.gcode.3mf", plates=(1,))
        cfg_m = self.ctl.save_printer({"name": "A1 mini", "kind": "bambu", "model": "A1 mini",
                                       "ip": "192.168.1.86", "serial": "0309DA1234575", "code": "12345678"})
        mpid = next(p["id"] for p in cfg_m["printers"] if p["ip"] == "192.168.1.86")
        self.ctl._on_link(mpid, True, "")
        self.ctl._on_status(mpid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        self.ctl._links[mpid] = type("L", (), {"start_print": lambda s, p: None})()
        with patch.object(bambu, "fetch_file", return_value=b"tampered-remote-bytes"):
            with self.assertRaises(hq_print3d.Print3dError) as sdctx:
                self.ctl.start_sd_print(mpid, "sd_ok.gcode.3mf", 1)
        self.assertEqual(sdctx.exception.code, "unverified_sd_file")

        # 3. Cross-process SQLite BEGIN IMMEDIATE blocks duplicate claim even if JSON cache bypassed
        self.ctl._claim_pending_start(mpid, {"at": 1, "job": "sd_ok", "gen": 0, "ambiguous": False})
        ctl2 = hq_print3d.Controller(self.root, lambda: self.share)
        ctl2._pending_start.clear()
        with self.assertRaises(hq_print3d.Print3dError) as dbctx:
            ctl2._claim_pending_start(mpid, {"at": 2, "job": "sd_ok", "gen": 0, "ambiguous": False})
        self.assertEqual(dbctx.exception.code, "printer_busy")

        # 4. Stationary extrusion G1 X0 E100 when X is already 0 is rejected
        stat_g = self.share / "stat_e.gcode"
        stat_g.write_text("M83\nG1 X0 E100\n", encoding="utf-8")
        with self.assertRaises(models.ModelError) as ectx:
            models.preflight_gcode(stat_g, 1, models.PRINTER_PROFILES["A1 mini"])
        self.assertEqual(ectx.exception.code, "unsafe_gcode")

    def test_v10_reaudit_fixes(self):
        import subprocess
        import sys

        # 1. V10-M1: Tiny XYZ movement cannot bypass stationary-extrusion guard
        tiny1 = self.share / "tiny1.gcode"
        tiny1.write_text("G91\nM83\nG1 X0.0002 E100\n", encoding="utf-8")
        with self.assertRaises(models.ModelError) as c1:
            models.preflight_gcode(tiny1, 1, models.PRINTER_PROFILES["A1 mini"])
        self.assertEqual(c1.exception.code, "unsafe_gcode")

        tiny2 = self.share / "tiny2.gcode"
        tiny2.write_text("G91\nM83\nG1 X0.0002 E40\nG1 X0.0002 E40\n", encoding="utf-8")
        with self.assertRaises(models.ModelError) as c2:
            models.preflight_gcode(tiny2, 1, models.PRINTER_PROFILES["A1 mini"])
        self.assertEqual(c2.exception.code, "unsafe_gcode")

        tiny3 = self.share / "tiny3.gcode"
        tiny3.write_text("G91\nM83\nG1 X0.1 E10\n", encoding="utf-8")
        with self.assertRaises(models.ModelError) as c3:
            models.preflight_gcode(tiny3, 1, models.PRINTER_PROFILES["A1 mini"])
        self.assertEqual(c3.exception.code, "unsafe_gcode")

        ok_g = self.share / "purge_ok.gcode"
        ok_g.write_text("G91\nM83\nG1 E15\nG1 X60 E10\nG1 E-5\n", encoding="utf-8")
        models.preflight_gcode(ok_g, 1, models.PRINTER_PROFILES["A1 mini"])

        # 2. V10-H2: Source file mutated after SHA-256 check cannot alter uploaded bytes
        src_3mf = self.share / "toctou.gcode.3mf"
        sliced_3mf(src_3mf, plates=(1,))
        orig_bytes = src_3mf.read_bytes()
        cfg_t = self.ctl.save_printer({"name": "A1 mini", "kind": "bambu", "model": "A1 mini",
                                       "ip": "192.168.1.90", "serial": "0309DA1234580", "code": "12345678"})
        pid_t = next(p["id"] for p in cfg_t["printers"] if p["ip"] == "192.168.1.90")
        self.ctl._on_link(pid_t, True, "")
        self.ctl._on_status(pid_t, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        self.ctl._links[pid_t] = type("L", (), {"start_print": lambda s, p: None})()
        mid_t = next(i["id"] for i in self.ctl.library.scan(force=True) if i["name"] == "toctou.gcode.3mf")
        uploaded_blobs = []
        staged_paths = []
        real_sha = models.file_sha256

        def _sha_and_mutate(p):
            digest = real_sha(p)
            src_3mf.write_bytes(b"UNVALIDATED BYTES AFTER SHA256 CHECK")
            return digest

        def _fake_upload(ip, code, local_path, remote):
            staged_paths.append(Path(local_path))
            uploaded_blobs.append(Path(local_path).read_bytes())

        with patch.object(models, "file_sha256", side_effect=_sha_and_mutate), \
             patch.object(bambu, "upload", side_effect=_fake_upload):
            self.ctl.start_print(pid_t, mid_t, 1)
        self.assertEqual(len(uploaded_blobs), 1)
        self.assertEqual(uploaded_blobs[0], orig_bytes)
        self.assertFalse(staged_paths[0].exists())

        # 3. V10-H1: Two separate OS processes racing queue_dispatch on an 'auto' item
        q_3mf = self.share / "queue_race.gcode.3mf"
        sliced_3mf(q_3mf, plates=(1,))
        cfg_q1 = self.ctl.save_printer({"name": "P0", "kind": "bambu", "model": "A1 mini",
                                        "ip": "192.168.1.91", "serial": "0309DA1234581", "code": "12345678"})
        cfg_q2 = self.ctl.save_printer({"name": "P1", "kind": "bambu", "model": "A1 mini",
                                        "ip": "192.168.1.92", "serial": "0309DA1234582", "code": "12345678"})
        p0 = next(p["id"] for p in cfg_q1["printers"] if p["ip"] == "192.168.1.91")
        p1 = next(p["id"] for p in cfg_q2["printers"] if p["ip"] == "192.168.1.92")
        mid_q = next(i["id"] for i in self.ctl.library.scan(force=True) if i["name"] == "queue_race.gcode.3mf")
        qrow = self.ctl.queue_add(mid_q, 1, "auto")

        worker = (
            "import json, sys, time\n"
            "from pathlib import Path\n"
            "from unittest.mock import patch\n"
            "import hq_print3d, hq_print3d_bambu as bambu\n"
            "root, share, item_id, p0, p1 = sys.argv[1:6]\n"
            "ctl = hq_print3d.Controller(Path(root), lambda: Path(share))\n"
            "for pid in (p0, p1):\n"
            "    ctl._on_link(pid, True, '')\n"
            "    ctl._on_status(pid, {'state': 'idle', 'ams': [{'slot': 1, 'material': 'PLA', 'colour': '#FF0000'}, {'slot': 2, 'material': 'PETG', 'colour': '#00FF00'}]})\n"
            "    ctl._links[pid] = type('L', (), {'start_print': lambda s, payload: None, 'alive': lambda s: True})()\n"
            "ctl.library.scan(force=True)\n"
            "with patch.object(bambu, 'upload', return_value=None):\n"
            "    try:\n"
            "        res = ctl.queue_dispatch(item_id)\n"
            "        print(json.dumps({'ok': True, 'printer_id': res.get('printer_id')}))\n"
            "    except hq_print3d.Print3dError as exc:\n"
            "        print(json.dumps({'ok': False, 'code': exc.code}))\n"
        )
        procs = [
            subprocess.Popen(
                [sys.executable, "-c", worker, str(self.root), str(self.share), qrow["id"], p0, p1],
                cwd=str(Path(__file__).resolve().parent.parent),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            for _ in range(2)
        ]
        results = []
        for pr in procs:
            out, err = pr.communicate(timeout=15)
            self.assertEqual(pr.returncode, 0, f"worker stderr: {err}")
            results.append(json.loads(out.strip().splitlines()[-1]))
        self.assertEqual(sum(1 for r in results if r["ok"]), 1, f"expected 1 winner, got {results}")
        self.assertEqual(sum(1 for r in results if not r["ok"] and r["code"] in ("printer_busy", "not_found")), 1)

    def test_v11_reaudit_fixes(self):
        import subprocess
        import sys
        import threading

        # 1. Small extrusion move with excessive ratio (<= 5 mm) is rejected
        small_ratio = self.share / "small_ratio.gcode"
        small_ratio.write_text("G91\nM83\nG1 X0.1 E4\n", encoding="utf-8")
        with self.assertRaises(models.ModelError) as rctx:
            models.preflight_gcode(small_ratio, 1, models.PRINTER_PROFILES["A1 mini"])
        self.assertEqual(rctx.exception.code, "unsafe_gcode")

        # 2. _staged_local is initialized eagerly in Controller.__init__
        self.assertIsInstance(self.ctl._staged_local, threading.local)

        # 3. Bambu reservation is claimed BEFORE upload, blocking concurrent overwrite
        col_3mf = self.share / "col.gcode.3mf"
        sliced_3mf(col_3mf, plates=(1,))
        cfg_c = self.ctl.save_printer({"name": "A1 mini", "kind": "bambu", "model": "A1 mini",
                                       "ip": "192.168.1.95", "serial": "0309DA1234590", "code": "12345678"})
        pid_c = next(p["id"] for p in cfg_c["printers"] if p["ip"] == "192.168.1.95")
        self.ctl._on_link(pid_c, True, "")
        self.ctl._on_status(pid_c, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        self.ctl._links[pid_c] = type("L", (), {"start_print": lambda s, p: None})()
        mid_c = next(i["id"] for i in self.ctl.library.scan(force=True) if i["name"] == "col.gcode.3mf")

        ctl_b = hq_print3d.Controller(self.root, lambda: self.share)
        ctl_b._on_link(pid_c, True, "")
        ctl_b._on_status(pid_c, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        ctl_b._links[pid_c] = type("L", (), {"start_print": lambda s, p: None})()
        ctl_b.library.scan(force=True)

        upload_calls = []
        second_err = []

        def _upload_while_racing(ip, code, local_path, remote):
            upload_calls.append(Path(local_path).read_bytes())
            try:
                ctl_b.start_print(pid_c, mid_c, 1)
            except hq_print3d.Print3dError as exc:
                second_err.append(exc.code)

        with patch.object(bambu, "upload", side_effect=_upload_while_racing):
            self.ctl.start_print(pid_c, mid_c, 1)
        self.assertEqual(len(upload_calls), 1)
        self.assertEqual(second_err, ["printer_busy"])

        # 4. SD verification stages immutable copy so source mutation after preflight cannot alter sha256
        sd_3mf = self.share / "sd_toctou.gcode.3mf"
        sliced_3mf(sd_3mf, plates=(1,))
        self.ctl.library.scan(force=True)
        orig_sd_bytes = sd_3mf.read_bytes()
        real_preflight = models.preflight_gcode

        def _preflight_and_mutate(p, plate, profile):
            res = real_preflight(p, plate, profile)
            sd_3mf.write_bytes(b"TAMPERED_AFTER_PREFLIGHT")
            return res

        # Clear pending start on pid_c to reuse idle printer
        self.ctl._release_pending_start(pid_c)
        self.ctl._on_status(pid_c, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        with patch.object(models, "preflight_gcode", side_effect=_preflight_and_mutate), \
             patch.object(bambu, "fetch_file", return_value=b"TAMPERED_AFTER_PREFLIGHT"):
            with self.assertRaises(hq_print3d.Print3dError) as sctx:
                self.ctl.start_sd_print(pid_c, "sd_toctou.gcode.3mf", 1)
        self.assertEqual(sctx.exception.code, "unverified_sd_file")
        with patch.object(bambu, "fetch_file", return_value=orig_sd_bytes):
            sd_3mf.write_bytes(orig_sd_bytes)
            ok_sd = self.ctl.start_sd_print(pid_c, "sd_toctou.gcode.3mf", 1)
        self.assertTrue(ok_sd["ok"])

        # 5. Concurrent cross-process queue_add preserves both items
        qadd_3mf = self.share / "qadd.gcode.3mf"
        sliced_3mf(qadd_3mf, plates=(1,))
        mid_qa = next(i["id"] for i in self.ctl.library.scan(force=True) if i["name"] == "qadd.gcode.3mf")
        add_worker = (
            "import sys\n"
            "from pathlib import Path\n"
            "import hq_print3d\n"
            "root, share, mid = sys.argv[1:4]\n"
            "ctl = hq_print3d.Controller(Path(root), lambda: Path(share))\n"
            "ctl.library.scan(force=True)\n"
            "ctl.queue_add(mid, 1, 'auto')\n"
        )
        procs = [
            subprocess.Popen(
                [sys.executable, "-c", add_worker, str(self.root), str(self.share), mid_qa],
                cwd=str(Path(__file__).resolve().parent.parent),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            for _ in range(2)
        ]
        for pr in procs:
            _, err = pr.communicate(timeout=15)
            self.assertEqual(pr.returncode, 0, f"queue_add worker stderr: {err}")
        self.assertEqual(len(self.ctl.queue_list()), 2)

    def test_v12_reaudit_fixes(self):
        # 1. V12-1: Failed queue_remove after successful start_print never fails over to P2 or resets to pending
        v12_3mf = self.share / "v12_q.gcode.3mf"
        sliced_3mf(v12_3mf, plates=(1,))
        cfg1 = self.ctl.save_printer({"name": "P1", "kind": "bambu", "model": "A1 mini",
                                      "ip": "192.168.1.96", "serial": "0309DA1234596", "code": "12345678"})
        cfg2 = self.ctl.save_printer({"name": "P2", "kind": "bambu", "model": "A1 mini",
                                      "ip": "192.168.1.97", "serial": "0309DA1234597", "code": "12345678"})
        p1 = next(p["id"] for p in cfg1["printers"] if p["ip"] == "192.168.1.96")
        p2 = next(p["id"] for p in cfg2["printers"] if p["ip"] == "192.168.1.97")
        for pid in (p1, p2):
            self.ctl._on_link(pid, True, "")
            self.ctl._on_status(pid, {"state": "idle", "ams": [
                {"slot": 1, "material": "PLA", "colour": "#FF0000"},
                {"slot": 2, "material": "PETG", "colour": "#00FF00"},
            ]})
            self.ctl._links[pid] = type("L", (), {"start_print": lambda s, p: None, "alive": lambda s: True})()
        mid = next(i["id"] for i in self.ctl.library.scan(force=True) if i["name"] == "v12_q.gcode.3mf")
        qrow = self.ctl.queue_add(mid, 1, "auto")
        started_on = []

        def _fake_start(pid, model_id, plate=None, options=None):
            started_on.append(pid)
            return {"ok": True, "printer_id": pid}

        with patch.object(self.ctl, "start_print", side_effect=_fake_start), \
             patch.object(self.ctl, "queue_remove", side_effect=hq_print3d.Print3dError("unwritable", 503, "state_unwritable")):
            with self.assertRaises(hq_print3d.Print3dError):
                self.ctl.queue_dispatch(qrow["id"])
        self.assertEqual(len(started_on), 1)
        items_after = self.ctl.queue_list()
        self.assertEqual(len(items_after), 1)
        self.assertEqual(items_after[0]["status"], "ambiguous")

        # 2. V12-2: Stale/corrupt queue.json after migration cannot be re-imported when DB is empty
        self.ctl._pending_db_conn().execute("DELETE FROM queue_items").connection.close()
        self.ctl._pending_db_conn().execute("DELETE FROM queue_claims").connection.close()
        self.ctl._queue_path().write_text(json.dumps({"items": [{"id": "q-ghost", "model_id": mid}]}), encoding="utf-8")
        self.assertEqual(self.ctl.queue_list(), [])
        self.ctl.queue_add(mid, 1, "auto")
        self.assertEqual(len(self.ctl.queue_list()), 1)
        self.assertNotEqual(self.ctl.queue_list()[0]["id"], "q-ghost")

        # 3. V12-3: Queue capacity is strictly enforced at 100 items in SQLite
        while len(self.ctl.queue_list()) < 100:
            self.ctl.queue_add(mid, 1, "auto")
        self.assertEqual(len(self.ctl.queue_list()), 100)
        with self.assertRaises(hq_print3d.Print3dError) as qfull:
            self.ctl.queue_add(mid, 1, "auto")
        self.assertEqual(qfull.exception.code, "queue_full")
        self.assertEqual(len(self.ctl.queue_list()), 100)

    def test_v13_reaudit_fix(self):
        # In-flight ('dispatching') or 'ambiguous' queue items cannot be removed without explicit reconciliation
        v13_3mf = self.share / "v13_q.gcode.3mf"
        sliced_3mf(v13_3mf, plates=(1,))
        cfg = self.ctl.save_printer({"name": "P1", "kind": "bambu", "model": "A1 mini",
                                     "ip": "192.168.1.98", "serial": "0309DA1234598", "code": "12345678"})
        pid = next(p["id"] for p in cfg["printers"] if p["ip"] == "192.168.1.98")
        self.ctl._on_link(pid, True, "")
        self.ctl._on_status(pid, {"state": "idle", "ams": [
            {"slot": 1, "material": "PLA", "colour": "#FF0000"},
            {"slot": 2, "material": "PETG", "colour": "#00FF00"},
        ]})
        self.ctl._links[pid] = type("L", (), {"start_print": lambda s, p: None, "alive": lambda s: True})()
        mid = next(i["id"] for i in self.ctl.library.scan(force=True) if i["name"] == "v13_q.gcode.3mf")
        qrow = self.ctl.queue_add(mid, 1, "auto")

        remove_err = []

        def _start_while_removing(p, m, pl=None, opts=None):
            try:
                self.ctl.queue_remove(qrow["id"])
            except hq_print3d.Print3dError as exc:
                remove_err.append((exc.status, exc.code))
            raise hq_print3d.Print3dError("post-send ambiguous", 502, "printer_error")

        with patch.object(self.ctl, "start_print", side_effect=_start_while_removing):
            with self.assertRaises(hq_print3d.Print3dError):
                self.ctl.queue_dispatch(qrow["id"])
        self.assertEqual(remove_err, [(409, "queue_busy")])
        # Ambiguous item also refuses removal
        with self.assertRaises(hq_print3d.Print3dError) as amb_rm:
            self.ctl.queue_remove(qrow["id"])
        self.assertEqual((amb_rm.exception.status, amb_rm.exception.code), (409, "queue_busy"))
        self.assertEqual(len(self.ctl.queue_list()), 1)
        self.assertEqual(self.ctl.queue_list()[0]["status"], "ambiguous")
        # Pending item can still be removed normally
        qpending = self.ctl.queue_add(mid, 1, "auto")
        self.assertTrue(self.ctl.queue_remove(qpending["id"]))


if __name__ == "__main__":
    unittest.main()
