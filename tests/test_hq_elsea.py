"""Elsea (Atelier 3D assistant): thread contract, confirm-only commands, chip status."""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import hq_elsea
import hq_personas
import hq_print3d
from tests import hq_assistant_state

setUpModule = hq_assistant_state.set_up
tearDownModule = hq_assistant_state.tear_down


class TestHqElsea(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="hq-elsea-")
        self.root = Path(self._tmp.name)
        self._saved_root = hq_elsea._bound_root
        hq_elsea.bind(root=self.root)
        # No live link may start in a test: printers are written to config only.
        self._patches = [patch.object(hq_print3d.Controller, "ensure_links", lambda self: None),
                         patch.object(hq_print3d.Controller, "_restart_link", lambda self, pid: None)]
        for p in self._patches:
            p.start()
        self.ctl = hq_print3d.controller(self.root)
        self.ctl.save_printer({"name": "A1 mini AMS", "kind": "bambu", "ip": "192.168.1.40",
                               "serial": "0309DA123456789", "code": "12345678"})
        self.pid = self.ctl.public_config()["printers"][0]["id"]

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        hq_print3d._controllers.pop(str(self.root.resolve()), None)
        hq_elsea._bound_root = self._saved_root
        self._tmp.cleanup()

    def _thread_file(self) -> Path:
        return self.root / ".hq-print3d" / "elsea_thread.json"

    def test_persona_is_english_and_names_her_mother_and_the_roster(self) -> None:
        core = hq_elsea.PERSONA_CORE
        self.assertIn("Always answer in English", core)
        self.assertIn("Else's daughter", core)
        self.assertIn(hq_personas.others_line("elsea", lang="en"), core)
        self.assertEqual(core.count(hq_personas.quirks_line("elsea")), 1)
        self.assertIn("SFW", core)
        self.assertEqual(hq_personas.parent_of("elsea"), "else")
        self.assertIn("elsea", hq_personas.children_of("else"))
        for other in hq_personas.keys():
            if other != "elsea":
                self.assertNotIn(hq_personas.get(other)["alias"], core)

    def test_thread_write_is_atomic_and_carries_revision_and_epoch(self) -> None:
        with patch("hq_ai.generate", return_value=(json.dumps({"reply": "All quiet, Master.", "tools": []}), "mock")):
            res = hq_elsea.chat("how are the printers?")
        self.assertTrue(res["ok"])
        data = json.loads(self._thread_file().read_text(encoding="utf-8"))
        self.assertEqual(len(data["messages"]), 2)
        self.assertGreaterEqual(data["revision"], 1)
        self.assertEqual(data["clear_epoch"], 0)
        self.assertFalse(self._thread_file().with_suffix(".json.tmp").exists())

    def test_clear_during_generation_discards_the_reply(self) -> None:
        def generate(*_args, **_kwargs):
            hq_elsea.clear_thread()
            return json.dumps({"reply": "Too late!", "tools": []}), "mock"

        with patch("hq_ai.generate", side_effect=generate):
            res = hq_elsea.chat("status?")
        self.assertTrue(res["cancelled"])
        self.assertEqual(hq_elsea.get_thread()["messages"], [])

    def test_cancelled_turn_stores_nothing(self) -> None:
        hq_elsea.cancel("el-testjob1")
        code, res = hq_elsea.http_post("/api/elsea/chat", {"message": "status", "job": "el-testjob1"})
        self.assertEqual(code, 200)
        self.assertTrue(res["cancelled"])
        self.assertEqual(hq_elsea.get_thread()["messages"], [])

    def test_read_tool_reports_printers_without_secrets(self) -> None:
        out = hq_elsea._execute_tool("printers_status", {})
        self.assertTrue(out["ok"])
        self.assertEqual(out["result"][0]["name"], "A1 mini AMS")
        self.assertNotIn("12345678", json.dumps(out))

    def test_pause_is_queued_and_runs_only_on_confirm_once(self) -> None:
        sent = []
        replies = [
            (json.dumps({"reply": "Pausing it for you.",
                         "tools": [{"name": "printer_pause", "args": {"printer": "a1 mini"}}]}), "mock"),
            (json.dumps({"reply": "The card is waiting for your tap, Master.", "tools": []}), "mock"),
        ]
        with patch("hq_ai.generate", side_effect=replies), \
             patch.object(hq_print3d.Controller, "command", lambda self, pid, name: sent.append((pid, name)) or {"ok": True}):
            hq_elsea.chat("pause the A1 mini")
        self.assertEqual(sent, [])
        prop = hq_elsea.get_thread()["messages"][-1]["proposals"][0]
        self.assertEqual(prop["status"], "pending")
        self.assertEqual(prop["args"]["printer_id"], self.pid)
        self.assertIn("A1 mini AMS", prop["summary"])

        with patch.object(hq_print3d.Controller, "command", lambda self, pid, name: sent.append((pid, name)) or {"ok": True}):
            out = hq_elsea.confirm(prop["id"])
            self.assertTrue(out["ok"])
            with self.assertRaises(hq_elsea.ElseaError) as ctx:
                hq_elsea.confirm(prop["id"])
        self.assertEqual(ctx.exception.code, "already_resolved")
        self.assertEqual(sent, [(self.pid, "pause")])
        self.assertEqual(hq_elsea.get_thread()["messages"][-1]["proposals"][0]["status"], "done")

    def test_unknown_printer_gets_no_card(self) -> None:
        replies = [
            (json.dumps({"reply": "Stopping it.", "tools": [{"name": "printer_stop", "args": {"printer": "prusa"}}]}), "mock"),
            (json.dumps({"reply": "I can't find that printer.", "tools": []}), "mock"),
        ]
        with patch("hq_ai.generate", side_effect=replies):
            res = hq_elsea.chat("stop the prusa")
        self.assertEqual(res["proposals"], [])
        self.assertNotIn("proposals", hq_elsea.get_thread()["messages"][-1])

    def test_dismissed_card_never_runs(self) -> None:
        sent = []
        replies = [
            (json.dumps({"reply": "Light on?", "tools": [{"name": "printer_light", "args": {"printer": self.pid, "on": True}}]}), "mock"),
            (json.dumps({"reply": "Card ready.", "tools": []}), "mock"),
        ]
        with patch("hq_ai.generate", side_effect=replies):
            hq_elsea.chat("turn the light on")
        prop = hq_elsea.get_thread()["messages"][-1]["proposals"][0]
        with patch.object(hq_print3d.Controller, "command", lambda self, pid, name: sent.append(name)):
            hq_elsea.dismiss(prop["id"])
            with self.assertRaises(hq_elsea.ElseaError):
                hq_elsea.confirm(prop["id"])
        self.assertEqual(sent, [])

    def test_unreadable_thread_is_preserved(self) -> None:
        path = self._thread_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{broken", encoding="utf-8")
        before = path.read_bytes()
        with patch("hq_ai.generate", return_value=(json.dumps({"reply": "ok", "tools": []}), "mock")):
            with self.assertRaises(hq_elsea.ElseaError) as ctx:
                hq_elsea.chat("status?")
        self.assertEqual(ctx.exception.code, "state_unreadable")
        self.assertEqual(path.read_bytes(), before)

    def test_camera_look_puts_the_frame_in_front_of_the_model(self) -> None:
        jpeg = b"\xff\xd8" + b"\x10" * 40 + b"\xff\xd9"
        seen = []

        def generate(_chain, _system, contents, **_kw):
            seen.append(contents)
            if len(seen) == 1:
                return json.dumps({"reply": "Let me look.", "tools": [{"name": "camera_look", "args": {"printer": "a1"}}]}), "mock"
            return json.dumps({"reply": "First layer looks clean!", "tools": []}), "mock"

        with patch("hq_ai.generate", side_effect=generate), \
             patch.object(hq_print3d.Controller, "camera_frame", lambda self, pid: jpeg):
            res = hq_elsea.chat("is the first layer ok?")
        parts = seen[1][-1]["parts"]
        self.assertEqual(parts[1]["inlineData"]["mimeType"], "image/jpeg")
        import base64
        self.assertEqual(base64.b64decode(parts[1]["inlineData"]["data"]), jpeg)
        self.assertNotIn("_image", parts[0]["text"])
        self.assertEqual(res["tools_used"], ["camera_look"])
        # The frame is never stored in the thread.
        self.assertNotIn("inlineData", self._thread_file().read_text(encoding="utf-8"))

    def test_start_print_is_a_card_and_runs_only_on_confirm(self) -> None:
        plan = {"printer_id": self.pid, "printer_name": "A1 mini AMS", "kind": "bambu", "model_id": "m1",
                "file": "clip.gcode.3mf", "size": 10, "prediction_sec": 5400, "weight_g": 12.3,
                "sliced_for": "A1 mini", "plate": 1, "use_ams": True, "ams_mapping": [0],
                "filament_plan": ["PLA #FF0000 → fente 1"]}
        started = []
        replies = [
            (json.dumps({"reply": "Ready to print!", "tools": [{"name": "printer_start",
                                                                 "args": {"printer": "a1", "id": "m1"}}]}), "mock"),
            (json.dumps({"reply": "Tap the card when you're ready, Master.", "tools": []}), "mock"),
        ]
        with patch("hq_ai.generate", side_effect=replies), \
             patch.object(hq_print3d.Controller, "plan_print", lambda self, pid, mid, plate=None: plan), \
             patch.object(hq_print3d.Controller, "start_print", lambda self, pid, mid, plate=None: started.append((pid, mid, plate)) or {"ok": True}):
            hq_elsea.chat("print the clip on the A1")
            self.assertEqual(started, [])
            prop = hq_elsea.get_thread()["messages"][-1]["proposals"][0]
            self.assertIn("START clip.gcode.3mf on A1 mini AMS", prop["summary"])
            self.assertIn("1 h 30", prop["summary"])
            self.assertIn("starts right away", prop["summary"])
            hq_elsea.confirm(prop["id"])
        self.assertEqual(started, [(self.pid, "m1", 1)])

    def test_unprintable_file_gets_no_card(self) -> None:
        def refuse(self, pid, mid, plate=None):
            raise hq_print3d.Print3dError("not sliced", 422, "not_sliced")
        replies = [
            (json.dumps({"reply": "Printing!", "tools": [{"name": "printer_start", "args": {"printer": "a1", "id": "m2"}}]}), "mock"),
            (json.dumps({"reply": "That one needs slicing first.", "tools": []}), "mock"),
        ]
        with patch("hq_ai.generate", side_effect=replies), patch.object(hq_print3d.Controller, "plan_print", refuse):
            res = hq_elsea.chat("print the arm stl")
        self.assertEqual(res["proposals"], [])

    def test_she_is_wired_into_visits_family_and_memory(self) -> None:
        import hq_assistant_visits as visits
        import hq_companion_memory as memory
        import hq_personhood
        self.assertIn("elsea", visits.KEYS)
        self.assertIn("elsea", visits.FAMILY_KEYS)
        self.assertEqual(visits.VOICE_MAX_WORDS["elsea"], 11)
        self.assertEqual(visits._paths()["elsea"], hq_elsea.growth_path())
        self.assertIn("mother", visits._family_note("else", "elsea"))
        self.assertIn("aunt", visits._family_note("elsea", "forgia"))
        self.assertIn("wholesome", visits._family_note("pistonia", "elsea"))
        self.assertEqual(visits._family_note("forgia", "securia"), "")
        self.assertIn("elsea", hq_personhood.DOMAIN_KEYS)
        self.assertIn("elsea", hq_personas.memory_scopes())
        with memory.memory_scope("elsea"):
            self.assertIn("elsea", memory.path().parts)

    def test_status_whispers_a_finished_print(self) -> None:
        self.ctl._on_status(self.pid, {"state": "printing", "job": "Benchy"})
        self.ctl._on_status(self.pid, {"state": "finished", "job": "Benchy"})
        status = hq_elsea.status_summary()
        self.assertEqual(status["printers"], 1)
        self.assertIn("Benchy", status["proactive_alert"]["message"])
        self.assertTrue(status["proactive_alert"]["id"].startswith("job:" + self.pid))


if __name__ == "__main__":
    unittest.main()
