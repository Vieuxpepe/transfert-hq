"""The assistant (hq_ai.py) with a fake Gemini: context, model fallback, quotas, proposals checked and applied."""
import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_ai as ai  # noqa: E402


def reply(text, thought=None):
    parts = ([{"text": thought, "thought": True}] if thought else []) + [{"text": text}]
    return 200, {"candidates": [{"content": {"parts": parts}}]}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.calls = []
        self.answers = []
        self.written = []
        self.clock = [datetime(2026, 11, 1, 10, 0).timestamp()]
        self.projects = {"projects": [{"id": "prj-a", "name": "Bras robot", "status": "active", "goal": "Un bras 4 axes", "resume": "Imprimer la base",
                                       "milestones": [{"title": "Base imprimée", "due": "2026-11-10", "done": False}], "bom": []}],
                         "tasks": [{"id": "c-1", "title": "Commander servos", "project": "prj-a", "column": "todo"}, {"id": "c-2", "title": "Ranger le bureau", "column": "todo"}]}
        self.inv = {"places": [{"id": "plc-1", "name": "Atelier", "parent": None}, {"id": "plc-2", "name": "Tiroir B2", "parent": "plc-1", "code": "B2"}],
                    "items": [{"id": "itm-1", "name": "Vis M3 x 10", "qty": 12, "unit": "", "place": "plc-2", "min": 20, "tags": ["visserie"]}]}

        def post(url, body, headers, timeout):
            self.calls.append((url.split("/models/")[1].split(":")[0], body, headers))
            return self.answers.pop(0) if self.answers else reply("ok")

        ai._minute.clear()
        ai.bind(root=self.root, key=lambda: "test-key", now=lambda: self.clock[0], post=post,
                calendar=lambda a, b: [{"title": "Labo GIA1077", "start": "2026-11-05T14:00", "end": "2026-11-05T16:00", "category": "study"}],
                projects=lambda: self.projects, inventory=lambda: self.inv,
                carnet=lambda: {"pages": [{"id": "page-1", "title": "Statique ch. 4", "text": "Moment d'inertie : I = somme y² dA", "block": "block-1", "updated": 1}]},
                files=lambda ws: ["Uni/GIA1077/plan-bras.pdf"] if "bras" in ws else [],
                save_event=lambda p: self.written.append(("event", p)), projects_apply=lambda d: self.written.append(("projects", d)) or {},
                inventory_apply=lambda d: self.written.append(("inventory", d)) or {"item": {"id": "itm-9"}},
                carnet_note=lambda lines: self.written.append(("note", lines)) or {"id": "page-9", "block": "block-9"})

    def tearDown(self):
        self.tmp.cleanup()


class AskTests(Base):
    def test_answer_with_context_and_sources(self):
        self.answers = [reply("La base est à imprimer [2], puis commander les servos [2]. Plan : [5]")]
        code, out = ai.http_post({"action": "ask", "q": "Où en est le bras robot ?"})
        self.assertEqual(code, 200, out)
        model, body, headers = self.calls[0]
        self.assertEqual((model, headers["x-goog-api-key"]), ("gemini-3.1-flash-lite", "test-key"))
        prompt = body["contents"][-1]["parts"][0]["text"]
        for bit in ("Labo GIA1077", "Bras robot", "Imprimer la base", "Commander servos", "plan-bras.pdf"):
            self.assertIn(bit, prompt)
        self.assertNotIn("test-key", json.dumps(out), "the key never goes back to the browser")
        kinds = [s["kind"] for s in out["sources"]]
        self.assertIn("project", kinds)
        self.assertEqual(out["sources"][1]["href"], "#projets/prj-a")
        self.assertIn(2, out["cited"])

    def test_busy_models_fall_back_and_thoughts_are_dropped(self):
        self.answers = [(503, {"error": {"message": "high demand"}}), (429, {}), reply("Réponse finale", thought="je réfléchis…")]
        code, out = ai.http_post({"action": "ask", "q": "Bonjour ?"})
        self.assertEqual((code, out["answer"], out["model"]), (200, "Réponse finale", "gemma-4-31b-it"))
        self.assertEqual([c[0] for c in self.calls], list(ai.ASK_CHAIN))

    def test_daily_quota_is_respected(self):
        (self.root / ai.STORE).mkdir()
        (self.root / ai.STORE / ai.USAGE).write_text(json.dumps({"day": "2026-11-01", "count": {"gemini-3.1-flash-lite": 500}}))
        self.answers = [reply("ok")]
        ai.http_post({"action": "ask", "q": "test ?"})
        self.assertEqual(self.calls[0][0], "gemini-3.5-flash-lite", "a used-up model is skipped")
        self.assertEqual(ai.usage()["count"]["gemini-3.5-flash-lite"], 1)
        self.clock[0] += 86400
        self.assertEqual(ai.usage()["count"], {}, "a new day starts from zero")

    def test_no_key(self):
        ai.bind(key=lambda: "")
        code, out = ai.http_post({"action": "ask", "q": "x ?"})
        self.assertEqual((code, out["code"]), (503, "no_key"))
        self.assertFalse(ai.status()["configured"])


class CaptureTests(Base):
    def test_one_sentence_many_actions_checked(self):
        self.answers = [reply(json.dumps({"reply": "Noté.", "actions": [
            {"kind": "event", "title": "Labo GIA1077", "start": "2026-11-05T14:00", "end": "", "all_day": False, "category": "study"},
            {"kind": "stock", "item": "itm-1", "delta": 20},
            {"kind": "task", "title": "Imprimer support", "project": "prj-a", "due": "2026-11-08"},
            {"kind": "note", "text": "ignored, only 3"}]}))]
        code, out = ai.http_post({"action": "capture", "text": "Labo jeudi 14h, acheté 20 vis, imprimer le support du bras"})
        self.assertEqual(code, 200, out)
        self.assertEqual(self.calls[0][0], "gemma-4-26b-a4b-it")
        self.assertIn("itm-1=Vis M3", self.calls[0][1]["systemInstruction"]["parts"][0]["text"])
        p = out["proposals"]
        self.assertEqual(len(p), 3)
        self.assertEqual(p[0]["end"], "2026-11-05T15:00", "an hour when no end is given")
        self.assertIn("(→ 32)", p[1]["label"])
        self.assertIn("Bras robot", p[2]["label"])
        self.assertEqual(self.written, [], "nothing is written before the confirmation")

    def test_unknown_ids_are_refused(self):
        self.answers = [reply('```json\n{"actions":[{"kind":"project_note","project":"prj-zzz","text":"x"},{"kind":"stock","item":"itm-404","delta":-3}]}\n```')]
        out = ai.http_post({"action": "capture", "text": "x"})[1]
        self.assertEqual(out["proposals"], [])
        self.assertEqual(len(out["refused"]), 2)

    def test_apply_writes_through_each_module(self):
        props = [ai.normalize(a, ai._capture_lists("")[3]) for a in [
            {"kind": "event", "title": "Dentiste", "start": "2026-11-03", "all_day": True, "category": "appointment"},
            {"kind": "project_note", "project": "prj-a", "text": "Base imprimée", "mode": "append"},
            {"kind": "stock", "item": None, "name": "Servo MG996R", "delta": 4, "place": "plc-2"}]]
        code, out = ai.http_post({"action": "apply", "proposals": props})
        self.assertEqual(code, 200, out)
        kinds = [w[0] for w in self.written]
        self.assertEqual(kinds, ["event", "projects", "inventory"])
        self.assertEqual(self.written[0][1]["end"], "2026-11-04")
        self.assertEqual(self.written[1][1], {"action": "project.resume", "id": "prj-a", "text": "Imprimer la base\nBase imprimée"})
        self.assertEqual(self.written[2][1]["action"], "item.create")
        self.assertEqual(out["done"][2]["href"], "#inventaire/objet/itm-9")
        code, out = ai.http_post({"action": "apply", "proposals": [{"kind": "note", "text": "Idée\nsupport téléphone"}]})
        self.assertEqual(self.written[-1], ("note", ["Idée", "support téléphone"]))
        self.assertEqual(out["done"][0]["href"], "#carnet/page-9/block-9")

    def test_apply_rechecks_and_reports(self):
        code, out = ai.http_post({"action": "apply", "proposals": [{"kind": "stock", "item": "itm-404", "delta": 1}]})
        self.assertEqual((code, len(out["failed"])), (400, 1))
        self.assertEqual(ai.http_post({"action": "apply", "proposals": []})[0], 400)
        self.assertEqual(ai.http_post({"action": "nope"})[0], 400)


class PureTests(unittest.TestCase):
    def test_helpers(self):
        self.assertEqual(ai.words("Où sont mes vis M3 ?"), ["vis"])
        self.assertEqual(ai.words("Résumé des notes de GIA1077"), ["resume", "notes", "gia1077"])
        self.assertEqual(ai.extract_json('voilà : {"a": 1} merci'), {"a": 1})
        with self.assertRaises(ai.AiError):
            ai.extract_json("rien")


class WiringTests(unittest.TestCase):
    def test_bridge(self):
        src = (Path(__file__).resolve().parents[1] / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertIn('raw == "/api/ai"', src)
        self.assertIn("hq_ai.bind(", src)
        self.assertIn('id="btn-ai"', src)
        self.assertNotIn("AQ.", src, "no API key in the code")


if __name__ == "__main__":
    unittest.main()
