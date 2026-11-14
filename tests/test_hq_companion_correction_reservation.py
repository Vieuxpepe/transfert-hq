"""An explicit correction keeps its room in the packet by rule, not by leftover bytes."""
from unittest.mock import patch

import hq_ai as ai
import hq_companion_context as companion_context
from tests.test_hq_ai import Base


class CorrectionReservationTests(Base):
    SYSTEM = "Règles du foyer, de la voix et de la mémoire partagée. " * 4
    MESSAGE = "Do you remember coffee?"
    CORRECTION = "I dislike coffee"
    PAGE = "TEMPS (vrai)\n10:00\n\nPRÉSENCE\nseule"

    def base(self):
        # The assembly's mandatory floor is the real reported estimate of
        # system + current message, so the tests measure the same bytes the
        # assertion checks.
        return ai.estimate_context(self.SYSTEM, [{"role": "user", "parts": [{"text": self.MESSAGE}]}])

    def block(self, heading=None):
        label = heading or companion_context.HEADINGS["correction"]
        return len((label + ":\n" + self.CORRECTION).encode("utf-8")) + 2

    def rendered(self, contents):
        return "\n".join(part["text"] for m in contents for part in m.get("parts", [])
                         if isinstance(part.get("text"), str))

    def correction_rows(self, info):
        return [row for row in info["selection_manifest"] if row["kind"] == "correction"]

    def test_correction_is_reserved_even_when_an_optional_block_outranks_it(self):
        # Competition is what makes the reservation observable: give the page
        # block a higher priority than the correction, so only the reservation
        # keeps the correction from being crowded out.
        budget = self.base() + self.block() + 8
        with patch.dict(companion_context.PRIORITY, {"time": 120}):
            contents, info = companion_context.assemble(
                self.SYSTEM, self.MESSAGE, budget=budget, groups=[], page=self.PAGE,
                corrections=[self.CORRECTION])
        kinds = {row["kind"]: row for row in info["selection_manifest"]}
        self.assertTrue(kinds["correction"]["selected"], "the correction must hold its reserved room")
        self.assertFalse(kinds["time"]["selected"], "an optional block must not take the reserved room")
        self.assertIn(self.CORRECTION, self.rendered(contents))
        self.assertNotIn("TEMPS (vrai)", self.rendered(contents))
        self.assertLessEqual(ai.estimate_context(self.SYSTEM, contents), budget)

    def test_reservation_does_not_depend_on_the_short_heading(self):
        # The guarantee is the reservation, not the label's size: with the
        # original longer heading the correction is still selected.
        heading = "CORRECTION EXPLICITE"
        with patch.dict(companion_context.HEADINGS, {"correction": heading}):
            budget = self.base() + self.block(heading=heading)
            contents, info = companion_context.assemble(
                self.SYSTEM, self.MESSAGE, budget=budget, groups=[],
                corrections=[self.CORRECTION])
            self.assertTrue(any(row["selected"] for row in self.correction_rows(info)))
            self.assertLessEqual(ai.estimate_context(self.SYSTEM, contents), budget)
        self.assertIn(self.CORRECTION, self.rendered(contents))

    def test_correction_is_selected_across_a_margin_of_its_own_block_size(self):
        cost = self.block()
        for margin in range(0, cost * 2 + 1):
            with self.subTest(margin=margin):
                budget = self.base() + cost + margin
                contents, info = companion_context.assemble(
                    self.SYSTEM, self.MESSAGE, budget=budget, groups=[], page=self.PAGE,
                    corrections=[self.CORRECTION])
                self.assertTrue(any(row["selected"] for row in self.correction_rows(info)))
                self.assertIn(self.CORRECTION, self.rendered(contents))
                self.assertLessEqual(ai.estimate_context(self.SYSTEM, contents), budget)

    def test_reservation_is_withdrawn_rather_than_overspending_the_budget(self):
        budget = self.base() + 5
        contents, info = companion_context.assemble(
            self.SYSTEM, self.MESSAGE, budget=budget, groups=[], corrections=[self.CORRECTION])
        self.assertFalse(any(row["selected"] for row in self.correction_rows(info)))
        self.assertNotIn(self.CORRECTION, self.rendered(contents))
        self.assertLessEqual(ai.estimate_context(self.SYSTEM, contents), budget)

    def test_a_duplicated_correction_releases_its_reserved_room(self):
        sep = chr(10) + chr(10)
        system = self.SYSTEM + sep + self.CORRECTION
        base = ai.estimate_context(system, [{"role": "user", "parts": [{"text": self.MESSAGE}]}])
        page = "TEMPS (vrai)\n10:00"
        page_cost = len(page.encode("utf-8")) + 2 + len("CONTEXTE ACTUEL:\n".encode("utf-8"))
        budget = base + page_cost + 4
        contents, info = companion_context.assemble(
            system, self.MESSAGE, budget=budget, groups=[], page=page,
            corrections=[self.CORRECTION])
        kinds = {row["kind"]: row for row in info["selection_manifest"]}
        self.assertFalse(kinds["correction"]["selected"], "already in the system: nothing to repeat")
        self.assertEqual(kinds["correction"]["reason"], "duplicate")
        self.assertTrue(kinds["time"]["selected"], "the released room must be usable again")
        # The fact already lives in the system prompt; it must not be repeated in the page.
        self.assertEqual(self.rendered(contents).count("I dislike coffee"), 0)
        self.assertLessEqual(ai.estimate_context(system, contents), budget)
