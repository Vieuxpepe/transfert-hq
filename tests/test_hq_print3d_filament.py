"""Atelier 3D filament tracking, cost, and the hardening fixes that came with it."""
import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import hq_makerworld
import hq_print3d
import hq_print3d_bambu as bambu
import hq_print3d_filament as fil
import hq_print3d_flashforge as flashforge
import hq_print3d_models as models

TWO_PLATES = b"""<?xml version="1.0"?>
<config>
<plate><metadata key="index" value="1"/><metadata key="printer_model_id" value="N1"/>
<metadata key="prediction" value="600"/><metadata key="weight" value="5.0"/>
<filament id="1" type="PLA" color="#FF0000" used_m="1.70" used_g="5.00"/></plate>
<plate><metadata key="index" value="2"/><metadata key="prediction" value="1200"/><metadata key="weight" value="40.5"/>
<filament id="1" type="PLA" color="#FF0000" used_m="9.70" used_g="30.50"/>
<filament id="2" type="PETG" color="#000000" used_m="3.00" used_g="10.00"/></plate>
</config>"""


def project_3mf(data: bytes = TWO_PLATES) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Metadata/plate_1.gcode", "G28\n")
        zf.writestr("Metadata/plate_2.gcode", "G28\n")
        zf.writestr("Metadata/slice_info.config", data)
    return buf.getvalue()


class MathTests(unittest.TestCase):
    def test_slice_info_reads_the_requested_plate_and_its_grams_and_metres(self):
        one = models.parse_slice_info(TWO_PLATES, 1)
        two = models.parse_slice_info(TWO_PLATES, 2)
        self.assertEqual([(f["type"], f["g"], f["m"]) for f in one["filaments"]], [("PLA", 5.0, 1.7)])
        self.assertEqual([(f["type"], f["g"], f["m"]) for f in two["filaments"]], [("PLA", 30.5, 9.7), ("PETG", 10.0, 3.0)])
        self.assertEqual(two["weight_g"], 40.5)

    def test_grams_and_metres_convert_with_the_material_density(self):
        self.assertAlmostEqual(fil.grams_to_metres(30.0, "PLA"), 10.06, places=1)
        self.assertAlmostEqual(fil.metres_to_grams(10.0, "PETG"), 30.55, places=1)
        self.assertEqual(fil.base_material("PLA-S"), "PLA")
        self.assertEqual(fil.base_material("pla basic"), "PLA")
        self.assertEqual(fil.base_material("PETG-CF"), "PETG")
        self.assertEqual(fil.base_material("PAHT"), "PAHT")
        self.assertEqual(fil.base_material(""), "PLA")

    def test_a_finished_job_uses_the_whole_estimate_a_failed_one_is_scaled(self):
        est = fil.estimate_from_slice([{"type": "PLA", "g": 30.0, "m": 9.7}, {"type": "PETG", "g": 10.0, "m": 3.0}])
        done = fil.compute(est, 1.0)
        self.assertEqual((done["g"], done["m"], done["source"]), (40.0, 12.7, "slice"))
        half = fil.compute(est, 0.25)
        self.assertEqual((half["g"], half["by_material"]["PLA"]["g"], half["by_material"]["PETG"]["g"]), (10.0, 7.5, 2.5))
        self.assertEqual(fil.compute(est, 0.0)["g"], 0.0)

    def test_fallbacks_ams_then_counter_then_nothing(self):
        start = fil.ams_snapshot([{"slot": 1, "material": "PLA", "remain": 80}, {"slot": 2, "material": "PETG", "remain": 50}])
        end = fil.ams_snapshot([{"slot": 1, "material": "PLA", "remain": 77}, {"slot": 2, "material": "PETG", "remain": 50}])
        ams = fil.compute(None, 1.0, ams_start=start, ams_end=end, spool_g=1000)
        self.assertEqual((ams["source"], ams["g"]), ("ams", 30.0))        # 3 % of a 1 kg spool
        counter = fil.compute(None, 1.0, counter_start=100.0, counter_end=112.5, materials=["PETG"])
        self.assertEqual((counter["source"], counter["m"]), ("counter", 12.5))
        self.assertGreater(counter["g"], 30)
        self.assertIsNone(fil.compute(None, 1.0))
        self.assertIsNone(fil.compute(None, 1.0, counter_start=100.0, counter_end=99.0))
        self.assertIsNone(fil.compute(None, 1.0, counter_start=0.0, counter_end=90000.0))   # a reset counter is not usage

    def test_printer_estimate_and_length_unit(self):
        mm = flashforge.normalise_detail({"status": "printing", "estimatedRightWeight": 12.0, "estimatedRightLen": 4000.0,
                                          "rightFilamentType": "PLA;PLA", "cumulativeFilament": 593.6})
        self.assertEqual((mm["est_weight_g"], mm["est_len_m"], mm["materials"][0], mm["counter_m"]), (12.0, 4.0, "PLA", 593.6))
        metres = flashforge.normalise_detail({"status": "printing", "estimatedRightWeight": 12.0, "estimatedRightLen": 4.0})
        self.assertEqual(metres["est_len_m"], 4.0)
        idle = flashforge.normalise_detail({"status": "ready", "estimatedRightWeight": 0.0, "estimatedRightLen": 0})
        self.assertIsNone(idle["est_weight_g"])
        self.assertEqual(fil.estimate_from_printer(mm)["filaments"][0]["g"], 12.0)
        self.assertIsNone(fil.estimate_from_printer(idle))

    def test_prices_validate_and_cost_follows_them(self):
        s = fil.clean_settings({"currency": "CA$", "default_price_kg": 30, "spool_g": 750,
                                "prices": {"pla": 20, "PETG-CF": 40}})
        self.assertEqual((s["currency"], s["spool_g"], s["prices"]), ("CA$", 750, {"PLA": 20.0, "PETG-CF": 40.0}))
        job = {"by_material": {"PLA": {"g": 500, "m": 0}, "PETG": {"g": 500, "m": 0}, "TPU": {"g": 100, "m": 0}}}
        # PETG has no entry of its own, nor does TPU: both use the default; PLA uses 20.
        self.assertEqual(fil.job_cost(job, s), round(0.5 * 20 + 0.5 * 30 + 0.1 * 30, 2))
        for bad in ({"currency": ""}, {"default_price_kg": -1}, {"spool_g": 5}, {"prices": {"a b": 1}},
                    {"prices": {"PLA": "x"}}, {"prices": {"PLA": 99999}}, {"prices": [1]}):
            with self.assertRaises(fil.FilamentError, msg=str(bad)):
                fil.clean_settings(bad)

    def test_manual_grams_keep_the_material_proportions(self):
        base = {"by_material": {"PLA": {"g": 30.0, "m": 9.7}, "PETG": {"g": 10.0, "m": 3.0}}}
        out = fil.with_manual_grams(base, 80.0)
        self.assertEqual((out["source"], out["g"], out["by_material"]["PLA"]["g"], out["by_material"]["PETG"]["g"]),
                         ("manual", 80.0, 60.0, 20.0))
        self.assertFalse(out["estimated"])
        for bad in (0, -5, 99999):
            with self.assertRaises(fil.FilamentError):
                fil.with_manual_grams(base, bad)

    def test_summary_groups_and_separates_waste(self):
        s = fil.clean_settings({"prices": {"PLA": 20}, "default_price_kg": 30})
        job = lambda at, outcome, g, printer="A": {"at": at, "outcome": outcome, "printer_name": printer,  # noqa: E731
                                                   "filament": {"g": g, "m": g / 3, "by_material": {"PLA": {"g": g, "m": g / 3}}}}
        jobs = [job(1_700_000_000, "finished", 100), job(1_700_086_400, "failed", 50, "B"), job(1_700_090_000, "finished", 10, "B"),
                {"at": 1_700_100_000, "outcome": "finished", "printer_name": "A", "filament": None}]
        out = fil.summarize(jobs, s, since=0, now=1_700_200_000)
        t = out["totals"]
        self.assertEqual((t["jobs"], t["with_data"], t["without_data"], t["g"], t["cost"]), (4, 3, 1, 160.0, 3.2))
        self.assertEqual((t["wasted_g"], t["wasted_cost"], t["failed"]), (50.0, 1.0, 1))
        self.assertEqual([r["printer"] for r in out["by_printer"]], ["A", "B"])
        self.assertEqual(len(out["by_day"]), 2)
        self.assertEqual(fil.summarize(jobs, s, since=1_700_080_000, now=1_700_200_000)["totals"]["jobs"], 3)


class TrackingTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="hq-print3d-fil-")
        self.root = Path(self._tmp.name)
        self.share = self.root / "Print"
        self.share.mkdir()
        (self.share / "Clip.gcode.3mf").write_bytes(project_3mf())
        self._patches = [patch.object(hq_print3d.Controller, "ensure_links", lambda self: None),
                         patch.object(hq_print3d.Controller, "_restart_link", lambda self, pid: None)]
        for p in self._patches:
            p.start()
        self.ctl = hq_print3d.Controller(self.root, lambda: self.share)
        cfg = self.ctl.save_printer({"name": "A1 mini", "kind": "bambu", "ip": "192.168.1.40",
                                     "serial": "0309DA1234567", "code": "12345678"})
        self.pid = cfg["printers"][0]["id"]
        self.ctl._kinds[self.pid] = "bambu"
        cfg = self.ctl.save_printer({"name": "Creator 5", "kind": "flashforge", "ip": "192.168.1.41",
                                     "serial": "SNMOMC9900", "code": "check99"})
        self.ff = cfg["printers"][1]["id"]

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def run_job(self, pid, steps):
        # The slice lookup is a background thread in production; inline here, so it can never
        # still be reading a fixture file when the temp folder is removed.
        with patch.object(threading.Thread, "start", lambda t: t.run()):
            for st in steps:
                self.ctl._on_status(pid, st)

    def test_bambu_job_is_priced_from_the_library_slice_when_it_finishes(self):
        with patch.object(threading.Thread, "start", lambda t: t.run()):
            self.run_job(self.pid, [
                {"state": "preparing", "job": "Clip", "plate": 2, "progress": 0, "ams": [
                    {"slot": 1, "material": "PLA", "remain": 90}, {"slot": 2, "material": "PETG", "remain": 60}]},
                {"state": "printing", "job": "Clip", "plate": 2, "progress": 50},
                {"state": "finished", "job": "Clip", "plate": 2, "progress": 100}])
        row = self.ctl.history()[0]
        self.assertEqual((row["outcome"], row["filament"]["source"], row["filament"]["g"]), ("finished", "slice", 40.5))
        self.assertEqual(row["filament"]["by_material"]["PETG"]["g"], 10.0)
        self.assertGreater(row["filament"]["cost"], 0)

    def test_a_stopped_job_costs_only_what_it_printed(self):
        with patch.object(threading.Thread, "start", lambda t: t.run()):
            self.run_job(self.pid, [{"state": "printing", "job": "Clip", "plate": 2, "progress": 25},
                                    {"state": "idle", "job": "Clip", "plate": 2, "progress": 25}])
        row = self.ctl.history()[0]
        self.assertEqual(row["outcome"], "stopped")
        self.assertEqual(row["filament"]["g"], 10.12)          # 25 % of 40.5 g

    def test_a_print_that_ran_to_the_end_is_finished_even_if_the_printer_went_straight_to_idle(self):
        with patch.object(threading.Thread, "start", lambda t: t.run()):
            self.run_job(self.pid, [{"state": "printing", "job": "Clip", "plate": 2, "progress": 98},
                                    {"state": "idle", "job": "Clip", "plate": 2, "progress": 0}])
        row = self.ctl.history()[0]
        self.assertEqual((row["outcome"], row["filament"]["g"]), ("finished", 40.5))

    def test_a_job_that_never_printed_is_not_recorded(self):
        self.run_job(self.pid, [{"state": "preparing", "job": "Clip"}, {"state": "idle", "job": "Clip"}])
        self.assertEqual(self.ctl.history(), [])

    def test_a_job_the_printer_kept_is_read_from_its_own_storage(self):
        calls = []

        def fetch(ip, code, names, opener=None):
            calls.append((ip, code, names))
            return project_3mf()

        with patch.object(threading.Thread, "start", lambda t: t.run()), patch.object(bambu, "fetch_file", fetch):
            self.run_job(self.pid, [{"state": "printing", "job": "From Studio", "plate": 1, "progress": 10},
                                    {"state": "finished", "job": "From Studio", "plate": 1, "progress": 100}])
        self.assertEqual(calls, [("192.168.1.40", "12345678", ["From Studio.gcode.3mf", "From Studio.3mf"])])
        self.assertEqual(self.ctl.history()[0]["filament"]["g"], 5.0)      # plate 1 only

    def test_no_slice_anywhere_falls_back_to_the_spools_then_to_nothing(self):
        def missing(*a, **k):
            raise bambu.BambuError("Fichier introuvable sur l'imprimante")
        ams = lambda r: [{"slot": 1, "material": "PLA", "remain": r}]  # noqa: E731
        with patch.object(threading.Thread, "start", lambda t: t.run()), patch.object(bambu, "fetch_file", missing):
            self.run_job(self.pid, [{"state": "printing", "job": "Mystery", "progress": 10, "ams": ams(80)},
                                    {"state": "finished", "job": "Mystery", "progress": 100, "ams": ams(78)}])
            self.run_job(self.pid, [{"state": "printing", "job": "Other", "progress": 10},
                                    {"state": "finished", "job": "Other", "progress": 100}])
        newest, older = self.ctl.history()[:2]
        self.assertIsNone(newest["filament"])
        self.assertEqual((older["filament"]["source"], older["filament"]["g"]), ("ams", 20.0))

    def test_flashforge_uses_the_printers_own_estimate(self):
        self.run_job(self.ff, [
            {"state": "printing", "job": "gear.3mf", "progress": 10, "est_weight_g": 12.0, "est_len_m": 4.0, "materials": ["PLA"]},
            {"state": "printing", "job": "gear.3mf", "progress": 60, "est_weight_g": 12.0, "est_len_m": 4.0, "materials": ["PLA"]},
            {"state": "failed", "job": "gear.3mf", "progress": 60}])
        row = self.ctl.history()[0]
        self.assertEqual((row["outcome"], row["filament"]["source"], row["filament"]["g"]), ("failed", "printer", 7.2))

    def test_the_printer_counter_is_the_last_resort_and_is_labelled_so(self):
        self.run_job(self.ff, [{"state": "printing", "job": "gear.3mf", "progress": 10, "counter_m": 593.6,
                                "materials": ["PLA", "PLA"]},
                               {"state": "finished", "job": "gear.3mf", "progress": 100, "counter_m": 601.1}])
        row = self.ctl.history()[0]
        self.assertEqual((row["filament"]["source"], row["filament"]["m"], row["counter_delta"]), ("counter", 7.5, 7.5))
        self.assertAlmostEqual(row["filament"]["g"], 22.37, places=1)         # 7.5 m of PLA
        self.assertTrue(row["filament"]["estimated"])

    def test_a_better_source_wins_over_the_counter_and_a_counter_reset_is_ignored(self):
        self.run_job(self.ff, [{"state": "printing", "job": "a.3mf", "progress": 10, "counter_m": 600.0,
                                "est_weight_g": 10.0, "materials": ["PLA"]},
                               {"state": "finished", "job": "a.3mf", "progress": 100, "counter_m": 650.0}])
        self.assertEqual(self.ctl.history()[0]["filament"]["source"], "printer")
        self.run_job(self.ff, [{"state": "printing", "job": "b.3mf", "progress": 10, "counter_m": 650.0},
                               {"state": "finished", "job": "b.3mf", "progress": 100, "counter_m": 3.0}])   # counter reset
        self.assertIsNone(self.ctl.history()[0]["filament"])

    def test_stats_edit_delete_and_price_changes_reprice_history(self):
        with patch.object(threading.Thread, "start", lambda t: t.run()):
            self.run_job(self.pid, [{"state": "printing", "job": "Clip", "plate": 2, "progress": 5},
                                    {"state": "finished", "job": "Clip", "plate": 2, "progress": 100}])
        stats = self.ctl.filament_stats("30d")
        self.assertEqual((stats["totals"]["g"], stats["totals"]["jobs"]), (40.5, 1))
        before = stats["totals"]["cost"]
        self.ctl.save_settings({"filament": {"prices": {"PLA": 100, "PETG": 100}}})
        self.assertGreater(self.ctl.filament_stats("30d")["totals"]["cost"], before)
        job_id = self.ctl.history()[0]["id"]
        edited = self.ctl.edit_job(job_id, {"grams": 81})
        self.assertEqual((edited["filament"]["g"], edited["filament"]["source"]), (81.0, "manual"))
        with self.assertRaises(hq_print3d.Print3dError):
            self.ctl.edit_job(job_id, {"grams": "abc"})
        with self.assertRaises(hq_print3d.Print3dError):
            self.ctl.edit_job("nope", {"grams": 5})
        self.assertEqual(self.ctl.http_post("/api/print3d/history/delete", {"id": job_id})[0], 200)
        self.assertEqual(self.ctl.filament_stats("all")["totals"]["jobs"], 0)
        with self.assertRaises(hq_print3d.Print3dError):
            self.ctl.filament_stats("forever")
        with self.assertRaises(hq_print3d.Print3dError):
            self.ctl.save_settings({"filament": {"prices": {"PLA": -3}}})

    def test_two_printers_cannot_share_an_address(self):
        with self.assertRaises(hq_print3d.Print3dError) as ctx:
            self.ctl.save_printer({"name": "Twin", "kind": "bambu", "ip": "192.168.1.40", "serial": "ABC123456", "code": "1234"})
        self.assertEqual(ctx.exception.code, "duplicate")
        self.ctl.save_printer({"id": self.pid, "name": "A1 mini", "kind": "bambu", "ip": "192.168.1.40",
                               "serial": "0309DA1234567", "code": ""})       # editing itself is fine

    def test_a_second_start_on_the_same_printer_is_refused_while_one_is_running(self):
        gate, entered = threading.Event(), threading.Event()

        def slow(self, pid, mid, plate):
            entered.set()
            gate.wait(2)
            return {"ok": True}

        results = []
        with patch.object(hq_print3d.Controller, "_start_print", slow):
            t = threading.Thread(target=lambda: results.append(self.ctl.start_print(self.pid, "m", None)))
            t.start()
            entered.wait(2)
            with self.assertRaises(hq_print3d.Print3dError) as ctx:
                self.ctl.start_print(self.pid, "m", None)
            gate.set()
            t.join(3)
        self.assertEqual(ctx.exception.code, "printer_busy")
        self.assertEqual(results, [{"ok": True}])


class HardeningTests(unittest.TestCase):
    def test_an_idle_timeout_never_splits_a_packet(self):
        pkt = bambu.publish_packet("device/X/report", b'{"print":{"mc_percent":5}}')
        first, body = bambu.read_packet(lambda n, buf=io.BytesIO(pkt[1:]): buf.read(n), pkt[0])
        self.assertEqual(bambu.parse_publish(first, body), ("device/X/report", b'{"print":{"mc_percent":5}}'))

    def test_fetch_file_tries_names_in_order_and_refuses_odd_ones(self):
        class FTP:
            def __init__(self, context=None, timeout=None):
                self.encoding = ""

            def connect(self, ip, port): pass
            def login(self, u, p): pass
            def prot_p(self): pass
            def close(self): pass

            def retrbinary(self, cmd, cb, blocksize=0):
                if cmd != "RETR second.3mf":
                    raise bambu.ftplib.error_perm("550 not found")
                cb(b"abc")
                cb(b"def")
        self.assertEqual(bambu.fetch_file("192.168.1.2", "1234", ["first.3mf", "second.3mf"], opener=FTP), b"abcdef")
        with self.assertRaises(bambu.BambuError):
            bambu.fetch_file("192.168.1.2", "1234", ["a.3mf"], opener=FTP)
        for bad in ("../x", "a/b", "a\\b", "x" * 200, "a\nb"):
            with self.assertRaises(bambu.BambuError, msg=repr(bad)):
                bambu.fetch_file("192.168.1.2", "1234", [bad], opener=FTP)

    def test_fetch_file_is_size_bounded(self):
        class Big:
            def __init__(self, context=None, timeout=None): pass
            def connect(self, ip, port): pass
            def login(self, u, p): pass
            def prot_p(self): pass
            def close(self): pass

            def retrbinary(self, cmd, cb, blocksize=0):
                for _ in range(3):
                    cb(b"x" * (30 * 1024 * 1024))
        with self.assertRaises(bambu.BambuError):
            bambu.fetch_file("192.168.1.2", "1234", ["big.3mf"], opener=Big)

    def test_a_camera_held_by_another_app_is_explained(self):
        class Refusing:
            def __init__(self, *a, **k): pass
            def request(self, *a, **k): raise flashforge.http.client.RemoteDisconnected("closed")
            def close(self): pass
        with patch.object(flashforge.http.client, "HTTPConnection", Refusing):
            with self.assertRaises(flashforge.FlashforgeError) as ctx:
                flashforge.camera_frames("192.168.1.41", "/?action=stream", threading.Event(), lambda f: None)
        self.assertIn("un seul client", str(ctx.exception))
        with patch.object(bambu, "_open_tls", side_effect=ConnectionResetError()):
            with self.assertRaises(bambu.BambuError) as ctx:
                bambu.camera_frames("192.168.1.40", "12345678", threading.Event(), lambda f: None)
        self.assertIn("un seul client", str(ctx.exception))

    def test_the_makerworld_cookie_never_follows_a_redirect_off_site(self):
        handler = hq_makerworld._SameHostRedirect()
        req = urllib.request.Request("https://makerworld.com/en/@me", headers={"Cookie": "secret=1"})
        args = (req, io.BytesIO(b""), 302, "Found", {})
        self.assertIsNone(handler.redirect_request(*args, "https://evil.example/steal"))
        self.assertIsNone(handler.redirect_request(*args, "http://makerworld.com/plain"))
        self.assertIsNone(handler.redirect_request(*args, "https://makerworld.com.evil.example/x"))
        ok = handler.redirect_request(*args, "https://makerworld.com/en/other")
        self.assertEqual(ok.full_url, "https://makerworld.com/en/other")

    def test_one_failed_status_call_does_not_strand_a_flashforge_on_the_legacy_port(self):
        link = flashforge.FlashforgeLink("192.168.1.41", "SN123456", "code99", lambda s: None, lambda ok, e: None)
        legacy = {"state": "idle"}
        with patch.object(flashforge, "legacy_status", lambda ip: legacy), \
             patch.object(flashforge, "detail", side_effect=flashforge.FlashforgeError("Imprimante injoignable")):
            with self.assertRaises(flashforge.FlashforgeError):
                link._poll_once()                          # one hiccup: reported, not switched
            self.assertFalse(link._legacy)
            for _ in range(2):
                try:
                    link._poll_once()
                except flashforge.FlashforgeError:
                    pass
            self.assertTrue(link._legacy)                  # three in a row: the API really is gone
        good = {"status": "printing", "printProgress": 0.2}
        link._polls = 11
        with patch.object(flashforge, "detail", return_value=good):
            self.assertEqual(link._poll_once()["state"], "printing")     # the 12th poll tries HTTP again
        self.assertFalse(link._legacy)


if __name__ == "__main__":
    unittest.main()
