"""Transferania's sense of life (hq_life.py + hq_ai wiring): time, true events, things to ask about, a mood that lasts."""
import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_ai as ai  # noqa: E402
import hq_life as life  # noqa: E402

DEV = "hqlifetestdevice01"


def reply(text):
    return 200, {"candidates": [{"content": {"parts": [{"text": text}]}}]}


def ts(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi).timestamp()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.clock = [ts(2026, 11, 1, 10)]
        self.calls, self.answers, self.activity, self.cal = [], [], [], []
        self.inv = {"items": [{"id": "itm-1", "name": "Vis M3 x 10", "qty": 12, "min": 20}]}
        self.spawned = []

        def post(url, body, headers, timeout):
            self.calls.append((url.split("/models/")[1].split(":")[0], body))
            return self.answers.pop(0) if self.answers else reply("ok")

        ai._minute.clear()
        ai.bind(companion_context_config=lambda: {}, root=self.root, extra_keys=lambda: [], key=lambda: "k", now=lambda: self.clock[0], post=post, companion_persona=lambda: "flirt",
                client_is_controller=lambda ip: False, nsfw_enabled=lambda: False,
                calendar=lambda a, b: list(self.cal), projects=lambda: {"projects": [], "tasks": []}, inventory=lambda: self.inv,
                carnet=lambda: {"pages": []}, files=lambda ws: [], activity=lambda n: list(self.activity), spawn=lambda fn: self.spawned.append(fn))

    def tearDown(self):
        self.tmp.cleanup()

    def ambient(self, **kw):
        body = {"action": "ambient", "view": "accueil", "digest": "Vue : Accueil", "persona": "warm", "device_id": DEV}
        body.update(kw)
        code, out = ai.http_post(body)
        if out.get("reason") == "cooldown":
            self.clock[0] += 120
            code, out = ai.http_post(body)
        if out.get("reason") == "duplicate":
            self.clock[0] += 300
            code, out = ai.http_post(body)
        if out.get("reason") == "coalescing":
            self.clock[0] += 8
            code, out = ai.http_post(body)
        self.assertEqual(code, 200, out)
        return out

    def prompt(self, i=-1):
        body = self.calls[i][1]
        return body["systemInstruction"]["parts"][0]["text"], body["contents"][-1]["parts"][0]["text"]


class TimeTests(Base):
    def test_return_after_absence_is_noted_once(self):
        self.clock[0] = ts(2026, 10, 29, 22)        # Thursday evening
        self.ambient()
        self.clock[0] = ts(2026, 11, 1, 10)         # Sunday morning
        self.ambient()
        _, user = self.prompt()
        self.assertIn("dernière visite jeudi 22 h (il y a 3 jours)", user)
        self.assertIn("Il est dimanche 10 h (matin)", user)
        self.clock[0] += 120
        self.ambient()
        self.assertNotIn("Retour après une absence", self.prompt()[1], "the return is mentioned once")

    def test_late_night_once_and_order_of_the_day(self):
        self.clock[0] = ts(2026, 11, 2, 1, 40)
        self.ambient(view="carnet")
        self.clock[0] += 120
        self.ambient(view="calendrier")
        _, first = self.prompt(0)
        _, second = self.prompt(1)
        self.assertIn("qu'il est tard", first)
        self.assertNotIn("qu'il est tard", second)
        self.assertIn("pages dans l'ordre : Carnet → Calendrier", second)


class EventTests(Base):
    def test_backup_print_and_folder_backup_from_the_journal(self):
        now = self.clock[0]
        self.activity = [
            {"id": "1", "kind": "backup", "message": "Backup → C:\\Backups\\Transfert\\20261101_095000", "at": now - 60},
            {"id": "2", "kind": "print", "message": "Impression Print/plan-bras.pdf → HP", "at": now - 30},
            {"id": "3", "kind": "backup", "message": "Sauvegarde « Uni » → D:\\x (12 fichiers)", "at": now - 10},
            {"id": "4", "kind": "backup", "message": "Backup purgé (plus de 14 j) → x", "at": now - 5},
            {"id": "5", "kind": "print", "message": "Impression vieux.pdf", "at": now - 3600},
        ]
        evs = life.from_activity(self.activity, now)
        self.assertEqual([e["kind"] for e in evs], ["backup_done", "print_sent", "folder_backup_done"], "purges and old news are not events")
        self.assertIn("« plan-bras.pdf » vient de partir à l'imprimante (HP).", evs[1]["text"])
        fail = life.from_activity([{"id": "6", "kind": "backup", "message": "Sauvegarde « Uni » impossible : disque plein", "at": now}], now)
        self.assertEqual(fail[0]["kind"], "backup_fail")

    def test_pulse_offers_the_most_urgent_true_thing_then_it_is_said_once(self):
        now = self.clock[0]
        self.activity = [{"id": "1", "kind": "backup", "message": "Backup → C:\\B\\x", "at": now - 60}]
        self.cal = [{"title": "Labo GIA1077", "start": "2026-11-01T10:30", "end": "2026-11-01T12:30"}]
        code, p = ai.http_post({"action": "pulse", "view": "accueil", "device_id": DEV})
        self.assertEqual(code, 200)
        self.assertEqual(p["event"]["kind"], "event_soon")
        self.assertIn("« Labo GIA1077 » commence dans 30 min (à 10 h 30)", p["event"]["text"])
        self.assertEqual(self.calls, [], "a pulse never calls the model")
        self.answers = [reply("Ton labo dans 30 min — t'as ton sarrau ?")]
        out = self.ambient(event_id=p["event"]["id"])
        self.assertEqual(out["event_id"], p["event"]["id"])
        _, user = self.prompt()
        self.assertIn("ÉVÉNEMENT RÉEL (vrai, à l'instant) : « Labo GIA1077 »", user)
        p2 = ai.http_post({"action": "pulse", "device_id": DEV})[1]
        self.assertEqual(p2["event"]["kind"], "backup_done", "the said event is gone, the next one comes up")

    def test_unknown_event_ids_are_ignored(self):
        out = self.ambient(event_id="act:made-up")
        self.assertIsNone(out["event_id"])
        self.assertNotIn("ÉVÉNEMENT RÉEL", self.prompt()[1])

    def test_low_stock_once_a_day(self):
        p = ai.http_post({"action": "pulse", "device_id": DEV})[1]
        self.assertEqual(p["event"]["text"], "Stock bas : Vis M3 x 10 (12/20).")
        self.ambient(event_id=p["event"]["id"])
        self.assertIsNone(ai.http_post({"action": "pulse", "device_id": DEV})[1]["event"])
        self.clock[0] += 86400
        self.assertEqual(ai.http_post({"action": "pulse", "device_id": DEV})[1]["event"]["kind"], "low_stock")

    def test_fallback_line_tells_the_event_without_the_model(self):
        ai.bind(key=lambda: "")
        self.activity = [{"id": "9", "kind": "backup", "message": "Backup → x", "at": self.clock[0]}]
        p = ai.http_post({"action": "pulse", "device_id": DEV})[1]
        self.inv = {"items": []}
        out = self.ambient(event_id=p["event"]["id"])
        self.assertEqual((out["line"], out["fallback"]), ("Backup terminé — tout est au chaud.", True))


class MemoryTests(Base):
    def test_exam_in_the_calendar_is_asked_about_after(self):
        self.inv = {"items": []}
        self.cal = [{"title": "Examen intra Statique", "start": "2026-10-31T09:00", "end": "2026-10-31T12:00"}]
        p = ai.http_post({"action": "pulse", "device_id": DEV})[1]
        self.assertEqual(p["event"]["kind"], "ask_after")
        self.assertIn("Hier : « Examen intra Statique ». Demande comment ça s'est passé.", p["event"]["text"])
        self.cal.append({"title": "Épicerie", "start": "2026-10-31T15:00", "end": "2026-10-31T16:00"})
        self.ambient(event_id=p["event"]["id"])
        self.assertIsNone(ai.http_post({"action": "pulse", "device_id": DEV})[1]["event"], "asked once; errands are not moments")

    def test_moment_from_chat_is_remembered_then_asked_the_day_after(self):
        self.inv = {"items": []}
        self.answers = [reply("Bonne chance pour jeudi !"), reply(json.dumps({"moments": [{"what": "examen de statique", "date": "2026-11-05"}, {"what": "x", "date": "pas une date"}]}))]
        code, out = ai.http_post({"action": "transferania", "op": "send", "message": "J'ai mon examen de statique jeudi", "view": "accueil", "persona": "warm", "device_id": DEV})
        self.assertEqual(code, 200, out)
        self.assertEqual(len(self.spawned), 1, "the extraction runs in the background")
        self.spawned.pop()()
        self.assertEqual([m["what"] for m in life.load(DEV)["moments"]], ["examen de statique"])
        self.answers = [reply("ok")]
        ai.http_post({"action": "transferania", "op": "send", "message": "salut", "view": "accueil", "persona": "warm", "device_id": DEV})
        self.assertIn("TU TE SOUVIENS (il te l'a dit) : examen de statique (jeudi)", "\n".join(self.prompt()))
        self.assertEqual(self.spawned, [], "no extraction for small talk")
        self.clock[0] = ts(2026, 11, 5, 18)
        self.assertIsNone(ai.http_post({"action": "pulse", "device_id": DEV})[1]["event"], "not the same day")
        self.clock[0] = ts(2026, 11, 6, 9)
        p = ai.http_post({"action": "pulse", "device_id": DEV})[1]
        self.assertEqual(p["event"]["text"], "Hier : « examen de statique ». Demande comment ça s'est passé.")


class MoodTests(Base):
    def test_mood_moves_with_the_day_and_fades(self):
        self.clock[0] = ts(2026, 11, 1, 9)
        m = ai.http_post({"action": "pulse", "device_id": DEV})[1]["mood"]
        self.assertEqual((m["soft"], m["warm"]), life.baseline(9))
        out = self.ambient(signals={"error": "Échec de l'envoi"})
        self.assertGreater(out["mood"]["soft"], 0.8)
        self.assertIn("plus douce depuis le pépin de tantôt", "\n".join(self.prompt()))
        self.clock[0] += 3 * 3600
        m = ai.http_post({"action": "pulse", "device_id": DEV})[1]["mood"]
        self.assertLess(m["soft"], 0.45, "it fades over the hours")
        self.clock[0] = ts(2026, 11, 1, 21)
        m = ai.http_post({"action": "pulse", "device_id": DEV})[1]["mood"]
        self.assertGreater(m["warm"], 0.55, "warmer at night")
        self.clock[0] = ts(2026, 11, 2, 9)
        m = ai.http_post({"action": "pulse", "device_id": DEV})[1]["mood"]
        self.assertEqual((m["soft"], m["why"]), (life.baseline(9)[0], "return"), "a new day starts fresh: last night's pépin is gone, only « contente de te revoir »")

    def test_quirks_and_life_rule_in_the_system(self):
        self.ambient()
        system, _ = self.prompt()
        self.assertIn("GOÛTS STABLES", system)
        self.assertIn("HUMEUR DU JOUR", "\n".join(self.prompt()))
        self.assertTrue(system.rstrip().endswith(ai.PRIORITE), "priority stays last")


if __name__ == "__main__":
    unittest.main()
