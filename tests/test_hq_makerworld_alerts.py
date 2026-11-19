import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_makerworld as mw
import hq_print3d

NOW = 2_000_000_000
S = mw.clean_alert_settings(None)


def design(i, title, dl=10, pr=5, lk=3, cm=0, slug=""):
    return {"id": i, "title": title, "slug": slug, "downloads": dl, "prints": pr, "likes": lk, "collections": 0, "comments": cm}


def point(age_h, designs):
    return {"at": NOW - age_h * 3600, "designs": {str(d["id"]): [d["downloads"], d["prints"], d["likes"], d["comments"]]
                                                 for d in designs}}


class AlertTests(unittest.TestCase):
    def test_settings_are_clamped_and_strict(self):
        s = mw.clean_alert_settings({"enabled": "x", "push": 1, "min_jump": 0, "ratio_pct": 99999})
        self.assertEqual((s["enabled"], s["push"], s["min_jump"], s["ratio_pct"]), (False, False, 1, 1000))
        self.assertTrue(S["enabled"] and not S["push"])

    def test_spike_needs_both_an_absolute_and_a_relative_jump(self):
        before = [design(1, "Goblin", dl=100), design(2, "Tiny", dl=2), design(3, "Big", dl=1000)]
        hist = [point(24, before)]
        now = [design(1, "Goblin", dl=170), design(2, "Tiny", dl=5), design(3, "Big", dl=1100)]
        alerts = mw.detect_alerts(None, {"designs": now}, hist, NOW, S)
        self.assertEqual([a["design_id"] for a in alerts], [1])         # Tiny: +3 < 10; Big: +10% < 50%
        self.assertIn("+70 downloads", alerts[0]["text"])

    def test_a_design_published_since_is_not_a_spike(self):
        alerts = mw.detect_alerts(None, {"designs": [design(9, "New", dl=500)]}, [point(24, [design(1, "x")])], NOW, S)
        self.assertEqual(alerts, [])

    def test_no_baseline_in_the_window_means_no_spike(self):
        hist = [point(3, [design(1, "x", dl=1)]), point(100, [design(1, "x", dl=1)])]
        self.assertEqual(mw.detect_alerts(None, {"designs": [design(1, "x", dl=900)]}, hist, NOW, S), [])

    def test_new_comments_are_counted_against_the_previous_snapshot(self):
        prev = {"designs": [design(1, "Goblin", cm=2)]}
        a = mw.detect_alerts(prev, {"designs": [design(1, "Goblin", cm=5)]}, [], NOW, S)
        self.assertEqual(a[0]["kind"], "comments")
        self.assertIn("3 new comments", a[0]["text"])
        self.assertEqual(mw.detect_alerts(prev, {"designs": [design(1, "Goblin", cm=2)]}, [], NOW, S), [])
        self.assertEqual(mw.detect_alerts(None, {"designs": [design(1, "Goblin", cm=5)]}, [], NOW, S), [])

    def test_disabled_gives_nothing(self):
        off = mw.clean_alert_settings({"enabled": False})
        prev = {"designs": [design(1, "G", cm=0)]}
        self.assertEqual(mw.detect_alerts(prev, {"designs": [design(1, "G", cm=9)]}, [], NOW, off), [])

    def test_same_alert_has_a_stable_id(self):
        hist = [point(24, [design(1, "G", dl=10)])]
        snap = {"designs": [design(1, "G", dl=60)]}
        self.assertEqual(mw.detect_alerts(None, snap, hist, NOW, S)[0]["id"], mw.detect_alerts(None, snap, hist, NOW + 60, S)[0]["id"])


class MatchTests(unittest.TestCase):
    DS = [design(1, "Goblin Warrior | Tabletop | Removable Base", dl=33), design(2, "Shieldmaiden Knight | Tabletop sized RPG Warrior", dl=66)]

    def test_file_names_find_their_design(self):
        self.assertEqual(mw.match_designs("Goblin_Warrior_v2_final.stl", self.DS)[0]["id"], 1)
        self.assertEqual(mw.match_designs("shieldmaiden-knight.3mf", self.DS)[0]["id"], 2)

    def test_unrelated_or_tiny_names_match_nothing(self):
        self.assertEqual(mw.match_designs("benchy.stl", self.DS), [])
        self.assertEqual(mw.match_designs("a.stl", self.DS), [])


class ControllerTests(unittest.TestCase):
    def test_models_get_their_design_numbers_and_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ctl = hq_print3d.Controller(root)
            sd = ctl.state_dir()
            sd.mkdir(parents=True, exist_ok=True)
            designs = [design(77, "Goblin Warrior", dl=40, pr=20, lk=9, cm=1, slug="goblin-warrior")]
            (sd / hq_print3d.MAKERWORLD_FILE).write_text(json.dumps({
                "last": {"at": NOW, "designs": designs}, "last_attempt": NOW,
                "history": [point(30, [design(77, "Goblin Warrior", dl=30, pr=15, lk=5)]), point(0, designs)]}), encoding="utf-8")
            rows = ctl.attach_makerworld([{"makerworld_design_id": 77}, {"makerworld_design_id": 0}, {"makerworld_design_id": 5}])
            self.assertEqual(rows[0]["mw"]["downloads"], 40)
            self.assertTrue(rows[0]["mw"]["url"].endswith("/models/77-goblin-warrior"))
            self.assertNotIn("mw", rows[1])
            self.assertIsNone(rows[2]["mw"])                          # linked to a design not in the snapshot
            self.assertEqual(ctl.public_config()["mw_alerts"]["enabled"], True)
            ctl.save_settings({"mw_alerts": {"push": True, "min_jump": 20}})
            cfg = ctl.public_config()["mw_alerts"]
            self.assertEqual((cfg["push"], cfg["min_jump"], cfg["enabled"]), (True, 20, True))

    def test_refresh_stores_a_comment_alert_once_and_pushes_only_when_asked(self):
        import time as _t
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(hq_print3d.Controller, "ensure_links", lambda self: None):
                ctl = hq_print3d.Controller(Path(tmp))
                pushed = []
                ctl._watch_notify = lambda title, body: pushed.append(body)
                ctl.save_settings({"handle": "marc_makes", "uid": 777})
                ctl._mw_path().parent.mkdir(parents=True, exist_ok=True)
                old = {"at": 1, "uid": 777, "designs": [design(1, "Goblin", cm=0)], "totals": {}}
                ctl._mw_path().write_text(json.dumps({"last": old, "history": [], "last_attempt": 0}), encoding="utf-8")
                new = {"at": int(_t.time()), "uid": 777, "handle": "marc_makes", "profile": None, "profile_error": "",
                       "design_total": 1, "totals": {}, "designs": [design(1, "Goblin", cm=2)]}
                with patch.object(hq_print3d.hq_makerworld, "fetch", lambda *a, **k: dict(new)):
                    out = ctl.refresh_makerworld()
                    self.assertEqual([a["kind"] for a in out["alerts"]], ["comments"])
                    self.assertEqual(pushed, [])                                   # push is off by default
                    out = ctl.refresh_makerworld()                                 # same numbers again: nothing new
                    self.assertEqual(len(out["alerts"]), 1)
                    ctl.save_settings({"mw_alerts": {"push": True}})
                    new["designs"] = [design(1, "Goblin", cm=3)]
                    ctl.refresh_makerworld()
                    self.assertEqual(len(pushed), 1)


if __name__ == "__main__":
    unittest.main()
