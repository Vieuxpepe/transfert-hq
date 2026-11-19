"""How Inventoria feels: calm line, quiet streak, "usual amount" only when true, checked marks, voice, and the ask budget."""
from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

import hq_finances as fin
import hq_household_store as store
import hq_inventoria as ivo
import hq_inventoria_feel as feel
import hq_inventoria_habits as habits
import hq_inventoria_links as links
import hq_inventoria_notify as notify
import hq_inventory as inv

DAY = 86400


def at(hour: int, day: int = 15) -> float:
    return time.mktime((2026, 11, day, hour, 0, 0, 0, 0, -1))


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="ivo-feel-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        inv.bind(root=self.root, now=lambda: 600.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0, llm_adapter=lambda text, session_id=None: {"reply": "ok"})
        inv.apply({"action": "place.create", "name": "Garde-manger", "kind": "shelf"})
        self.pantry = inv.snapshot()["places"][0]["id"]
        inv.apply({"action": "item.create", "name": "Lait", "qty": 6, "unit": "pcs", "place": self.pantry})
        self.lait = inv.snapshot()["items"][0]["id"]

    def tearDown(self) -> None:
        ivo.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()


class CalmTests(_Base):
    def test_calm_only_with_stock_and_nothing_to_do(self) -> None:
        snap = inv.snapshot()
        out = feel.calm(snap, [], [], 3, "en")
        self.assertTrue(out["calm"])
        self.assertEqual(out["line"], "Nothing to buy, nothing expiring, last count 3 days ago.")
        self.assertEqual(feel.calm(snap, [], [], None, "en")["line"], "Nothing to buy, nothing expiring.")
        self.assertIn("dernier compte il y a 3 j", feel.calm(snap, [], [], 3, "fr")["line"])

    def test_not_calm_when_something_needs_attention_or_there_is_no_stock(self) -> None:
        snap = inv.snapshot()
        self.assertFalse(feel.calm(snap, [{"level": "low"}], [], 1, "en")["calm"])
        self.assertFalse(feel.calm(snap, [], [{"name": "Lait", "days_left": 1}], 1, "en")["calm"])
        self.assertFalse(feel.calm({"items": []}, [], [], None, "en")["calm"])          # an empty inventory is not "all good"
        self.assertIsNone(feel.calm({"items": []}, [], [], None, "en")["line"])

    def test_the_status_carries_calm_tone_and_the_budget(self) -> None:
        st = ivo.status()
        self.assertTrue(st["calm"]["calm"], st["calm"])
        self.assertIn("applied", st["tone"])
        self.assertEqual(st["asks"]["max_per_day"], feel.DEFAULT_ASKS["max_per_day"])


class StreakTests(_Base):
    def test_no_claim_before_a_week_of_tracking(self) -> None:
        feel.observe(self.root, [], now=1000.0)
        self.assertIsNone(feel.streak_line(self.root, "en", now=1000.0 + 6 * DAY))
        self.assertEqual(feel.streak_line(self.root, "en", now=1000.0 + 12 * DAY), "Nothing ran out for 12 days.")
        self.assertEqual(feel.streak_line(self.root, "fr", now=1000.0 + 12 * DAY), "Rien n'a manqué depuis 12 jours.")

    def test_an_out_of_stock_restarts_the_count(self) -> None:
        feel.observe(self.root, [], now=1000.0)
        feel.observe(self.root, [{"level": "out"}], now=1000.0 + 10 * DAY)
        self.assertIsNone(feel.streak_line(self.root, "en", now=1000.0 + 12 * DAY))
        self.assertEqual(feel.streak_line(self.root, "en", now=1000.0 + 20 * DAY), "Nothing ran out for 10 days.")

    def test_an_unreadable_file_is_kept_and_nothing_is_claimed(self) -> None:
        p = self.root / ".hq-inventoria" / "feel.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{broken", encoding="utf-8")
        feel.observe(self.root, [{"level": "out"}], now=5.0)
        self.assertEqual(p.read_text(encoding="utf-8"), "{broken")
        self.assertIsNone(feel.streak_line(self.root, "en", now=99 * DAY))


class UsualMarkTests(_Base):
    def adjusted(self, delta: int) -> list[dict]:
        return [{"operation_id": "op", "changes": [{"op": "item.adjust", "item_id": self.lait, "before": {"qty": 6}, "after": {"qty": 6 + delta}}]}]

    def learn_usual_use(self, n: int) -> None:
        for _ in range(habits.USUAL_MIN_COUNT):
            habits.record_commit(self.root, [{"op": "item.adjust", "payload": {"id": self.lait, "delta": -n}}], inv.snapshot())

    def test_marked_only_when_no_number_was_said_and_the_amount_is_the_usual_one(self) -> None:
        self.learn_usual_use(2)
        a = self.adjusted(-2)
        feel.mark_usual(self.root, a, "j'ai utilisé du lait")
        self.assertTrue(a[0]["changes"][0].get("usual"))
        for said in ("j'ai utilisé 2 lait", "used two milks", "utilisé une brique de lait", "", None):
            b = self.adjusted(-2)
            feel.mark_usual(self.root, b, said)
            self.assertFalse(b[0]["changes"][0].get("usual"), said)
        other = self.adjusted(-3)                                         # not the usual amount
        feel.mark_usual(self.root, other, "used some milk")
        self.assertFalse(other[0]["changes"][0].get("usual"))

    def test_nothing_is_marked_without_a_learned_amount(self) -> None:
        a = self.adjusted(-1)
        feel.mark_usual(self.root, a, "used some milk")
        self.assertFalse(a[0]["changes"][0].get("usual"))


class CheckedMarkTests(_Base):
    def test_a_counted_item_is_marked_checked_and_the_last_count_is_known(self) -> None:
        snap = inv.snapshot()
        self.assertIsNone(links.last_count_days(self.root, now=at(12)))
        links.record_count(self.root, snap, [{"item_id": self.lait, "qty": 6}], now=at(12, 10))
        self.assertEqual(links.item_checked_days(self.root, self.lait, now=at(12, 15)), 5)
        self.assertEqual(links.last_count_days(self.root, now=at(12, 15)), 5)
        self.assertIsNone(links.item_checked_days(self.root, "nope", now=at(12)))
        self.assertEqual(ivo.item_sheet(self.lait)["checked_days"], 0 if links.item_checked_days(self.root, self.lait) == 0 else
                         links.item_checked_days(self.root, self.lait))


class VoiceTests(unittest.TestCase):
    def test_both_languages_have_the_same_keys_and_a_stable_pick(self) -> None:
        self.assertEqual(set(feel.VOICE["en"]), set(feel.VOICE["fr"]))
        for lang in ("en", "fr"):
            for line in feel.VOICE[lang]["applied"]:
                self.assertIn("{c}", line)
        lines = feel.VOICE["en"]["applied"]
        self.assertEqual(feel.pick(lines, "op-1"), feel.pick(lines, "op-1"))
        self.assertIn(feel.pick(lines, "op-2"), lines)


class AskBudgetTests(_Base):
    def test_quiet_hours_wrap_midnight_and_can_be_switched_off(self) -> None:
        feel.asks_set(self.root, quiet_start=22, quiet_end=7)
        self.assertEqual(feel.ask_allowed(self.root, "instant", at(23)), (False, "quiet"))
        self.assertEqual(feel.ask_allowed(self.root, "instant", at(3)), (False, "quiet"))
        self.assertEqual(feel.ask_allowed(self.root, "instant", at(12)), (True, ""))
        feel.asks_set(self.root, quiet_start=0, quiet_end=0)
        self.assertEqual(feel.ask_allowed(self.root, "instant", at(3)), (True, ""))

    def test_the_daily_cap_stops_pings_but_never_the_digest(self) -> None:
        feel.asks_set(self.root, quiet_start=0, quiet_end=0, max_per_day=2)
        for _ in range(2):
            self.assertTrue(feel.ask_allowed(self.root, "instant", at(12))[0])
            feel.ask_spend(self.root, at(12))
        self.assertEqual(feel.ask_allowed(self.root, "instant", at(13)), (False, "budget"))
        self.assertTrue(feel.ask_allowed(self.root, "digest", at(13))[0])
        self.assertTrue(feel.ask_allowed(self.root, "instant", at(12, 16))[0])           # a new day starts at zero

    def test_snooze_blocks_everything_and_resume_clears_it(self) -> None:
        feel.asks_set(self.root, quiet_start=0, quiet_end=0, snooze_days=1, now=at(12))
        self.assertEqual(feel.ask_allowed(self.root, "digest", at(13)), (False, "snoozed"))
        self.assertTrue(feel.asks_get(self.root, at(13))["snoozed"])
        self.assertTrue(feel.ask_allowed(self.root, "digest", at(12, 17))[0])             # it ended by itself
        feel.asks_set(self.root, snooze_days=3, now=at(12))
        feel.asks_set(self.root, snooze_days=0, now=at(12))
        self.assertTrue(feel.ask_allowed(self.root, "digest", at(13))[0])

    def test_spot_check_can_be_paused_on_its_own(self) -> None:
        self.assertFalse(feel.spot_hidden(self.root))
        feel.asks_set(self.root, spot_snooze_days=1)
        self.assertTrue(feel.spot_hidden(self.root))

    def test_bad_values_are_refused(self) -> None:
        for kw in ({"max_per_day": 99}, {"quiet_start": 24}, {"quiet_end": -1}, {"snooze_days": 400}, {"max_per_day": True}):
            with self.assertRaises(ValueError):
                feel.asks_set(self.root, **kw)

    def test_the_prefs_route_saves_and_validates_them(self) -> None:
        code, out = ivo.http_post("/api/inventoria/prefs", {"asks": {"max_per_day": 3, "quiet_start": 21, "quiet_end": 6}})
        self.assertEqual(code, 200, out)
        self.assertEqual((out["asks"]["max_per_day"], out["asks"]["quiet_start"], out["asks"]["quiet_end"]), (3, 21, 6))
        code, out = ivo.http_post("/api/inventoria/prefs", {"asks": {"max_per_day": 99}})
        self.assertEqual(code, 400, out)


class NotifyRespectsTheBudgetTests(_Base):
    def setUp(self) -> None:
        super().setUp()
        rev = next(i["rev"] for i in inv.snapshot()["items"] if i["id"] == self.lait)
        inv.apply({"action": "item.update", "id": self.lait, "rev": rev, "min": 2})        # an alert needs a minimum to cross

    def run_tick(self, now: float, sent: list) -> dict:
        return notify.tick(self.root, lambda t, b, *, url="/", actions=None: sent.append((t, b)), inv=inv.snapshot(), now=now)

    def test_an_alert_that_arrives_in_quiet_hours_is_told_afterwards_not_lost(self) -> None:
        feel.asks_set(self.root, quiet_start=22, quiet_end=7)
        notify.save_settings(self.root, enabled=True, digest_hour=23, inv=inv.snapshot())
        inv.apply({"action": "item.adjust", "id": self.lait, "delta": -6})
        sent: list = []
        self.assertEqual(self.run_tick(at(2), sent)["instant"], [])
        self.assertEqual(sent, [])
        out = self.run_tick(at(9), sent)
        self.assertEqual(out["instant"], ["Lait"])
        self.assertEqual(len(sent), 1)

    def test_a_pause_holds_the_digest_until_it_ends(self) -> None:
        feel.asks_set(self.root, quiet_start=0, quiet_end=0, snooze_days=1, now=at(8))
        notify.save_settings(self.root, enabled=True, instant=False, digest_hour=8, inv=inv.snapshot())
        inv.apply({"action": "item.adjust", "id": self.lait, "delta": -6})
        sent: list = []
        self.assertFalse(self.run_tick(at(9), sent)["digest"])
        self.assertTrue(self.run_tick(at(9, 17), sent)["digest"])

    def test_the_digest_speaks_in_her_voice(self) -> None:
        feel.asks_set(self.root, quiet_start=0, quiet_end=0)
        notify.save_settings(self.root, enabled=True, instant=False, digest_hour=0, inv=inv.snapshot())
        inv.apply({"action": "item.adjust", "id": self.lait, "delta": -6})
        sent: list = []
        self.assertTrue(self.run_tick(at(9), sent)["digest"])
        lang = ivo.status()["language"]
        self.assertIn(feel.voice(lang)["digest_head"].format(n=1), sent[-1][1])


class PanelContractTests(unittest.TestCase):
    CHIP = (Path(__file__).resolve().parent.parent / "assets" / "hq-inventoria-chip.js").read_text(encoding="utf-8")
    CSS = (Path(__file__).resolve().parent.parent / "assets" / "hq-inventoria.css").read_text(encoding="utf-8")

    def test_the_tap_is_acknowledged_before_the_server_answers(self) -> None:
        body = self.CHIP[self.CHIP.index("const quickAdjust = (itemId, delta, label) => {"):]
        body = body[:body.index("const copyText")]
        self.assertTrue(body.index("showSaving()") < body.index('oneTap("quick"'))

    def test_shop_mode_keeps_ticks_when_the_app_is_closed_and_the_row_is_the_checkbox(self) -> None:
        self.assertIn("hq_inventoria_checked_v1", self.CHIP)
        self.assertIn('paneShop.classList.contains("is-shopping")', self.CHIP)
        self.assertIn("min-height:56px", self.CSS)

    def test_the_usual_mark_and_the_fix_row_only_appear_from_server_facts(self) -> None:
        self.assertIn("allChanges.some((c) => c && c.usual)", self.CHIP)
        self.assertIn('conf === "high"', self.CHIP)                       # a sure match never shows "not it?"
        self.assertIn("hq-inventoria-guess-alt", self.CSS)


if __name__ == "__main__":
    unittest.main()
