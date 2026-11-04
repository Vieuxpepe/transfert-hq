"""perf7: events skip re-parse only when file unchanged; compact telemetry; local interval clamp."""
import json, os, sys, tempfile, time, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hq_state, hq_events, hq_automation


class StateCompact(unittest.TestCase):
    def test_default_bytes_unchanged_and_compact(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.json"; data = {"a": [1, 2], "é": "ü"}
            hq_state.write_json_atomic(p, data)
            self.assertEqual(p.read_text(encoding="utf-8"), json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            hq_state.write_json_atomic(p, data, compact=True)
            self.assertEqual(p.read_text(encoding="utf-8"), '{"a":[1,2],"é":"ü"}\n')
            self.assertEqual(json.loads(p.read_text(encoding="utf-8")), data)


class EventsPersist(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory(); self.root = Path(self.d.name)
        self.saved = (hq_events._root, list(hq_events._events), hq_events._malformed, hq_events._disk_sig)
        self.calls = []; self.orig = hq_state.write_json_atomic
        def spy(path, data, **kw):
            self.calls.append(kw.get("verify_existing", True)); return self.orig(path, data, **kw)
        hq_state.write_json_atomic = spy

    def tearDown(self):
        hq_state.write_json_atomic = self.orig
        hq_events._root, hq_events._events, hq_events._malformed, hq_events._disk_sig = self.saved
        self.d.cleanup()

    def test_skip_verify_only_when_unchanged(self):
        hq_events.bind(self.root)
        hq_events.record("info", "a"); hq_events.record("info", "b")
        self.assertEqual(self.calls, [True, False])

    def test_outside_corruption_is_preserved(self):
        hq_events.bind(self.root); hq_events.record("info", "a")
        p = self.root / hq_events.EVENTS_NAME
        time.sleep(0.02); p.write_text("{broken", encoding="utf-8")
        hq_events.record("info", "b")
        self.assertEqual(p.read_text(encoding="utf-8"), "{broken")
        self.assertTrue(hq_events.malformed())

    def test_malformed_at_load_never_written(self):
        p = self.root / hq_events.EVENTS_NAME; p.write_text("nope", encoding="utf-8")
        hq_events.bind(self.root); hq_events.record("info", "x")
        self.assertEqual(p.read_text(encoding="utf-8"), "nope"); self.assertEqual(self.calls, [])


class TelemetryCompact(unittest.TestCase):
    def test_reader_handles_indented_then_compact(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); orig = hq_automation._root
            hq_automation._root = lambda: root
            try:
                (root / hq_automation.TELEMETRY_NAME).write_text(json.dumps({"samples": []}, indent=2), encoding="utf-8")
                hq_automation.record_sample("pc", free=10, total=100, scope="local")
                text = (root / hq_automation.TELEMETRY_NAME).read_text(encoding="utf-8")
                self.assertNotIn("\n  ", text)
                self.assertEqual(len(json.loads(text)["samples"]), 1)
                hq_automation.record_sample("pc", free=11, total=100, scope="local")
                self.assertEqual(len(json.loads((root / hq_automation.TELEMETRY_NAME).read_text(encoding="utf-8"))["samples"]), 2)
            finally:
                hq_automation._root = orig


if __name__ == "__main__":
    unittest.main()
