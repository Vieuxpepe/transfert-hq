import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import hq_forge
import hq_forge_jobs
import hq_forge_presets
import hq_forgia
import hq_state


class TestHqForgia(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_root = Path(self._tmp.name)
        hq_forgia.bind(root=self.tmp_root)

    def tearDown(self) -> None:
        # Back to the run's sandbox root, never the live checkout.
        hq_forgia.bind(root=hq_state.state_root())
        self._tmp.cleanup()

    def test_status_and_readonly_forge_tools(self) -> None:
        with patch.object(hq_forge, "status", return_value={"online": True, "checkpoint": "waiIllustrious.safetensors"}), \
             patch.object(hq_forge, "catalog", return_value={"checkpoints": ["waiIllustrious.safetensors"], "samplers": ["Euler a"], "schedulers": ["Automatic"], "loras": ["detailer"]}), \
             patch.object(hq_forge_presets, "list_presets", return_value={"presets": [{"name": "Anime Crisp"}]}), \
             patch.object(hq_forge_jobs, "summary_rows", return_value=[{"id": "j1", "status": "done"}]):
            code, st = hq_forgia.http_get("/api/forgia/status")
            self.assertEqual(code, 200)
            self.assertEqual(st["headline"], "waiIllustrious")

            cat = hq_forgia._execute_tool("get_forge_catalog", {})
            self.assertTrue(cat["ok"])
            self.assertIn("detailer", cat["result"]["loras"])

            pr = hq_forgia._execute_tool("list_presets", {})
            self.assertTrue(pr["ok"])
            self.assertEqual(pr["result"]["presets"][0]["name"], "Anime Crisp")

            jb = hq_forgia._execute_tool("list_jobs", {})
            self.assertTrue(jb["ok"])
            self.assertEqual(jb["result"]["count"], 1)

    def test_preferences_chat_and_ambient(self) -> None:
        saved = hq_forgia._execute_tool(
            "save_preferences",
            {"styles": ["anime crisp"], "favorite_checkpoints": ["waiIllustrious"], "negative_staples": "lowres, blurry"},
        )
        self.assertTrue(saved["ok"])
        self.assertIn("anime crisp", hq_forgia._prefs_prompt_block())

        fake_ai = [
            (json.dumps({"reply": "Je regarde le catalogue...", "tools": [{"name": "get_forge_status", "args": {}}]}), "gemini-mock"),
            (json.dumps({"reply": "Voici ton prompt, Maître : `masterpiece, cinematic lighting`", "tools": []}), "gemini-mock"),
        ]
        with patch.object(hq_forge, "status", return_value={"online": True, "checkpoint": "wai.safetensors"}), \
             patch("hq_ai.generate", side_effect=fake_ai):
            code, chat_res = hq_forgia.http_post("/api/forgia/chat", {"message": "Fais-moi un prompt"})
        self.assertEqual(code, 200)
        self.assertTrue(chat_res["ok"])
        self.assertEqual(chat_res["tools_used"], ["get_forge_status"])

        with patch.object(hq_forge, "status", return_value={"online": True, "checkpoint": "wai.safetensors"}), \
             patch.object(hq_forge, "read_progress", return_value={"progress": 0.42}), \
             patch.object(hq_forge_jobs, "summary_rows", return_value=[]), \
             patch("hq_ai.generate", side_effect=RuntimeError("offline")):
            code2, amb = hq_forgia.http_post("/api/forgia/ambient", {"trigger": "timer", "nsfw": False})
        self.assertEqual(code2, 200)
        self.assertIn("42%", amb["line"])

    def test_cancel_stops_the_turn_before_it_is_stored(self) -> None:
        hq_forgia.cancel("fg-testjob")
        code, res = hq_forgia.http_post("/api/forgia/chat", {"message": "Fais un prompt", "job": "fg-testjob"})
        self.assertEqual(code, 200)
        self.assertTrue(res["cancelled"])
        self.assertEqual(hq_forgia.get_thread()["messages"], [])

    def test_cancel_lands_between_tool_rounds(self) -> None:
        def generate(*_args, **_kwargs):
            hq_forgia.cancel("fg-midjob")      # the Master pressed Arrêter while a round was in flight
            return json.dumps({"reply": "Je regarde.", "tools": [{"name": "get_forge_status", "args": {}}]}), "mock"

        with patch("hq_ai.generate", side_effect=generate), \
             patch.object(hq_forge, "status", return_value={"online": True}):
            res = hq_forgia.chat("état ?", job="fg-midjob")
        self.assertTrue(res["cancelled"])
        self.assertEqual(hq_forgia.get_thread()["messages"], [])


if __name__ == "__main__":
    unittest.main()
