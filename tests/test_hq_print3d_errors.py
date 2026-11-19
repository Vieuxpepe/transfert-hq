"""Plain-language printer errors: Bambu's catalog, code decoding, cache and download rules."""
import io
import json
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import hq_elsea
import hq_print3d
import hq_print3d_bambu as bambu
import hq_print3d_errors as errors

AMS_MOTOR = "0701230000020013"            # real entry shape from Bambu's file
AMS_TEXT = "AMS B slot 4 feeder unit motor has no signal, which may be due to poor contact in the motor connector or a motor fault."


def catalog_file(extra_hms=(), extra_err=()):
    hms = [{"ecode": AMS_MOTOR, "intro": AMS_TEXT}, {"ecode": "0500020000030012", "intro": ""}]
    hms += [{"ecode": f"0500{i:04X}00020001", "intro": f"Warning {i}"} for i in range(60)]
    hms += list(extra_hms)
    err = [{"ecode": "07004001", "intro": "The AMS has been disabled for a print, but it still has filament loaded."}]
    err += [{"ecode": f"0300{i:04X}", "intro": f"Error {i}"} for i in range(30)]
    err += list(extra_err)
    return json.dumps({"result": 0, "t": 1, "ver": 1, "data": {"device_hms": {"ver": 1, "en": hms},
                                                                "device_error": {"ver": 1, "en": err}}}).encode()


class Resp(io.BytesIO):
    pass


def opener_for(raw, log=None):
    def opener(req, timeout):
        if log is not None:
            log.append(req.full_url)
        if isinstance(raw, Exception):
            raise raw
        return Resp(raw)
    return opener


class DecodeTests(unittest.TestCase):
    def test_codes_and_severity(self):
        self.assertEqual(errors.ecode_from_hms({"attr": 0x07012300, "code": 0x00020013}), AMS_MOTOR)
        self.assertEqual(errors.ecode_from_hms({"attr": "x", "code": 1}), "")
        self.assertEqual(errors.ecode_from_hms({"attr": -1, "code": 1}), "")
        self.assertEqual(errors.ecode_from_hms("nope"), "")
        self.assertEqual(errors.display_code(AMS_MOTOR), "0701-2300-0002-0013")
        self.assertEqual(errors.display_code("07004001"), "0700-4001")
        self.assertEqual([errors.severity_of(f"00000000000{n}0001") for n in (1, 2, 3, 4)], ["fatal", "serious", "common", "info"])
        self.assertEqual(errors.severity_of("07004001"), "serious")          # a print_error stops the job

    def test_bambu_status_carries_the_raw_codes(self):
        s = bambu.normalise({"print": {"gcode_state": "PAUSE", "print_error": 0x07004001,
                                       "hms": [{"attr": 0x07012300, "code": 0x00020013}, {"attr": "bad"}, "junk"]}})
        self.assertEqual((s["error_ecode"], s["hms"], s["hms_count"], s["state"]), ("07004001", [AMS_MOTOR], 2, "paused"))
        clean = bambu.normalise({"print": {"gcode_state": "IDLE", "print_error": 0, "hms": []}})
        self.assertEqual((clean["error_ecode"], clean["hms"]), ("", []))

    def test_flashforge_only_has_an_opaque_code(self):
        self.assertEqual(errors.flashforge_problem(None), [])
        self.assertEqual(errors.flashforge_problem("0"), [])
        p = errors.flashforge_problem("E0042")[0]
        self.assertEqual((p["code"], p["known"], p["severity"]), ("E0042", False, "serious"))
        self.assertIn("printer's screen", p["text"])

    def test_text_from_outside_is_cleaned_and_bounded(self):
        self.assertEqual(errors.clean_text("a\x00b\x1b[31mred\n"), "a b [31mred")
        self.assertEqual(len(errors.clean_text("x" * 5000)), errors.MAX_TEXT)


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="hq-print3d-err-")
        self.path = Path(self._tmp.name) / "bambu_errors.json"

    def tearDown(self):
        self._tmp.cleanup()

    def test_download_parse_cache_and_lookup(self):
        log = []
        cat = errors.Catalog(self.path, opener_for(catalog_file(), log))
        self.assertTrue(cat.needs_refresh())
        self.assertTrue(cat.refresh())
        self.assertEqual(log, ["https://e.bambulab.com/query.php?lang=en"])
        self.assertEqual(cat.lookup(AMS_MOTOR), AMS_TEXT)
        self.assertEqual(cat.lookup("07004001")[:20], "The AMS has been dis")
        self.assertEqual(cat.lookup("0500020000030012"), "")          # empty descriptions are not stored
        self.assertEqual(cat.lookup("zz"), "")
        self.assertFalse(cat.needs_refresh())
        fresh = errors.Catalog(self.path, opener_for(urllib.error.URLError("offline")))   # survives a restart
        self.assertEqual(fresh.lookup(AMS_MOTOR), AMS_TEXT)
        self.assertFalse(fresh.needs_refresh())

    def test_a_bad_download_changes_nothing(self):
        cat = errors.Catalog(self.path, opener_for(catalog_file()))
        cat.refresh()
        before = self.path.read_bytes()
        for bad in (urllib.error.URLError("offline"), b"<html>blocked</html>", b'{"data": {}}',
                    json.dumps({"data": {"device_hms": {"en": []}, "device_error": {"en": []}}}).encode(),   # truncated
                    b"x" * (errors.MAX_BODY + 5)):
            self.assertFalse(errors.Catalog(self.path, opener_for(bad)).refresh(), repr(bad)[:40])
        self.assertEqual(self.path.read_bytes(), before)

    def test_only_https_bambu_and_no_redirect_elsewhere(self):
        handler = errors._SameHost()
        req = urllib.request.Request(errors.URL)
        args = (req, io.BytesIO(b""), 302, "Found", {})
        self.assertIsNone(handler.redirect_request(*args, "https://evil.example/x"))
        self.assertIsNone(handler.redirect_request(*args, "http://e.bambulab.com/x"))
        self.assertIsNotNone(handler.redirect_request(*args, "https://e.bambulab.com/other"))
        self.assertTrue(errors.URL.startswith("https://e.bambulab.com/"))

    def test_background_refresh_runs_once_an_hour_and_only_when_due(self):
        log = []
        cat = errors.Catalog(self.path, opener_for(catalog_file(), log))
        with patch.object(threading.Thread, "start", lambda t: t.run()):
            self.assertTrue(cat.ensure_async())
            self.assertFalse(cat.ensure_async())                 # fresh copy: nothing to do
            self.assertEqual(len(log), 1)
            cat._data["fetched"] = int(time.time()) - 40 * 86400
            self.assertFalse(cat.ensure_async())                 # stale, but tried a moment ago
            self.assertTrue(cat.ensure_async(time.time() + 2 * 3600))
        self.assertEqual(len(log), 2)

    def test_explain_dedupes_caps_and_admits_what_it_does_not_know(self):
        cat = errors.Catalog(self.path, opener_for(catalog_file()))
        cat.refresh()
        out = cat.explain([AMS_MOTOR, AMS_MOTOR, "0500020000030012", "07004001"])
        self.assertEqual([p["code"] for p in out], ["0701-2300-0002-0013", "0500-0200-0003-0012", "0700-4001"])
        self.assertEqual((out[0]["known"], out[0]["severity"], out[0]["text"]), (True, "serious", AMS_TEXT))
        self.assertFalse(out[1]["known"])
        self.assertIn("not in the catalog", out[1]["text"])
        many = cat.explain([f"{i:016X}" for i in range(40)])
        self.assertEqual(len(many), errors.MAX_PROBLEMS)


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="hq-print3d-errc-")
        self.root = Path(self._tmp.name)
        self._patches = [patch.object(hq_print3d.Controller, "ensure_links", lambda self: None),
                         patch.object(hq_print3d.Controller, "_restart_link", lambda self, pid: None)]
        for p in self._patches:
            p.start()
        self.ctl = hq_print3d.Controller(self.root)
        self.ctl.errors._opener = opener_for(catalog_file())
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

    def test_no_problem_means_no_download(self):
        self.ctl._on_status(self.pid, {"state": "idle", "hms": [], "error_ecode": ""})
        with patch.object(errors.Catalog, "ensure_async") as fetch:
            rows = self.ctl.printers()
        fetch.assert_not_called()
        self.assertEqual(rows[0]["status"]["problems"], [])

    def test_a_problem_starts_the_download_then_reads_in_words(self):
        self.ctl._on_status(self.pid, {"state": "paused", "hms": [AMS_MOTOR], "error_ecode": "07004001"})
        with patch.object(errors.Catalog, "ensure_async") as fetch:
            first = self.ctl.printers()[0]["status"]["problems"]
        fetch.assert_called_once()                                          # the first problem asks for the table
        self.assertEqual([p["known"] for p in first], [False, False])        # in the background: not there yet
        self.assertIn("code", first[0]["text"])                             # still tells him what to do
        self.ctl.errors.refresh()                                           # ...and a moment later it is
        again = self.ctl.printers()[0]["status"]["problems"]
        self.assertEqual([p["text"] for p in again], [self.ctl.errors.lookup("07004001"), AMS_TEXT])
        with patch.object(errors.Catalog, "ensure_async") as fetch:
            self.ctl.printers()
        fetch.assert_not_called()                                           # fresh now: no more downloads

    def test_flashforge_problem_is_a_code_with_a_pointer_to_the_screen(self):
        self.ctl._on_status(self.ff, {"state": "failed", "error_code": "E0042"})
        row = next(r for r in self.ctl.printers() if r["id"] == self.ff)
        self.assertEqual(row["status"]["problems"][0]["code"], "E0042")

    def test_a_failed_job_remembers_why(self):
        self.ctl.errors.refresh()
        self.ctl._on_status(self.pid, {"state": "printing", "job": "Clip", "progress": 10})
        self.ctl._on_status(self.pid, {"state": "paused", "job": "Clip", "progress": 12, "hms": [AMS_MOTOR]})
        self.ctl._on_status(self.pid, {"state": "failed", "job": "Clip", "progress": 12, "hms": [AMS_MOTOR]})
        row = self.ctl.history()[0]
        self.assertEqual(row["outcome"], "failed")
        self.assertEqual((row["problems"][0]["code"], row["problems"][0]["text"]), ("0701-2300-0002-0013", AMS_TEXT))

    def test_a_finished_job_carries_no_problem(self):
        self.ctl._on_status(self.pid, {"state": "printing", "job": "Clip", "progress": 10, "hms": [AMS_MOTOR]})
        self.ctl._on_status(self.pid, {"state": "finished", "job": "Clip", "progress": 100})
        self.assertEqual(self.ctl.history()[0]["problems"], [])

    def test_elsea_sees_the_problems_and_the_chip_whispers_a_serious_one(self):
        import hq_elsea
        self.ctl.errors.refresh()
        self.ctl._on_status(self.pid, {"state": "paused", "job": "Clip", "hms": [AMS_MOTOR]})
        saved = hq_elsea._bound_root
        hq_elsea.bind(root=self.root)
        try:
            with patch.object(hq_print3d, "controller", lambda root, print_root=None: self.ctl):
                brief = hq_elsea._execute_tool("printers_status", {})["result"][0]
                self.assertEqual(brief["problems"][0]["text"], AMS_TEXT)
                alert = hq_elsea.status_summary()["proactive_alert"]
        finally:
            hq_elsea._bound_root = saved
        self.assertTrue(alert["id"].startswith(f"err:{self.pid}:"))
        self.assertIn("feeder unit motor", alert["message"])


if __name__ == "__main__":
    unittest.main()
