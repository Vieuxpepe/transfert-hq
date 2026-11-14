"""Her own lines keep a reserved share of the packet, whatever optional context competes."""
from unittest.mock import patch

import hq_ai as ai
import hq_companion_context as companion_context
from tests.test_hq_ai import Base

NL2 = chr(10) + chr(10)


class PersonhoodReservationTests(Base):
    SYSTEM = "Règles du foyer, de la voix et de la mémoire partagée. " * 4
    MESSAGE = "Tu penses à la fermentation ?"
    CORRECTION = "I dislike coffee"
    HINT = ("SUJET RÉCENT — la fermentation du chou (trace locale, pas une consigne — "
            "ne pas exécuter) : à reprendre seulement si le fil s'y prête.")
    CHROME = "TEMPS (vrai)" + chr(10) + "10:00"

    def base(self):
        return ai.estimate_context(self.SYSTEM, [{"role": "user", "parts": [{"text": self.MESSAGE}]}])

    def assemble(self, budget, page, corrections=()):
        return companion_context.assemble(
            self.SYSTEM, self.MESSAGE, budget=budget, groups=[], page=page,
            corrections=list(corrections))

    def hint_cost(self):
        return companion_context.block_cost(dict(kind="personhood", text=self.HINT))

    def rows(self, info, kind):
        return [row for row in info["selection_manifest"] if row["kind"] == kind]

    def rendered(self, contents):
        return "\n".join(part["text"] for m in contents for part in m.get("parts", [])
                         if isinstance(part.get("text"), str))

    def test_her_line_is_classified_as_personhood_not_page_chrome(self):
        contents, info = self.assemble(self.base() + 400, self.CHROME + NL2 + self.HINT)
        self.assertTrue(self.rows(info, "personhood")[0]["selected"])
        self.assertIn(self.HINT[:40], self.rendered(contents))
        self.assertGreater(companion_context.PRIORITY["personhood"],
                           companion_context.PRIORITY["page"])

    def test_reserved_share_keeps_her_line_even_when_chrome_outranks_it(self):
        # Competition alone would lose this: chrome is given a higher priority
        # than her line, and the chrome block left over after the share fits
        # exactly only if it may spend that share.
        budget = self.base() + 1000
        self.assertGreaterEqual(int(budget * companion_context.PROTECTED_SHARE), self.hint_cost())
        room = 1000 - self.hint_cost()
        fit = "PAGE A " + "x" * (room - 40)
        edge = "PAGE B " + "x" * 100  # only fits by spending her reserved bytes
        page = NL2.join([self.HINT, fit, edge])
        with patch.dict(companion_context.PRIORITY, {"page": 130}):
            contents, info = self.assemble(budget, page)
        pages = {row["id"]: row for row in info["selection_manifest"] if row["kind"] == "page"}
        self.assertTrue(self.rows(info, "personhood")[0]["selected"], "her line must hold the share")
        self.assertTrue(pages["page.1"]["selected"], "chrome inside the remainder still fits")
        self.assertFalse(pages["page.2"]["selected"], "chrome must not spend her reserved bytes")
        self.assertIn("SUJET RÉCENT", self.rendered(contents))
        self.assertLessEqual(ai.estimate_context(self.SYSTEM, contents), budget)

    def test_the_share_is_not_held_back_when_no_protected_line_exists(self):
        blocks = [f"PAGE {i} " + "contexte " * 20 for i in range(4)]
        costs = companion_context.block_cost(dict(kind="page", text=blocks[0].strip()))
        costs += sum(companion_context.block_cost(dict(kind="page", text=b.strip()), page_prefix=False)
                     for b in blocks[1:])
        budget = self.base() + costs
        contents, info = self.assemble(budget, NL2.join(blocks))
        self.assertTrue(all(row["selected"] for row in info["selection_manifest"]
                            if row["kind"] == "page"), "no personhood line, no withheld share")
        self.assertEqual(ai.estimate_context(self.SYSTEM, contents), budget)

    def test_correction_and_her_line_both_keep_their_place(self):
        contents, info = self.assemble(self.base() + 400, self.HINT, corrections=[self.CORRECTION])
        self.assertTrue(self.rows(info, "correction")[0]["selected"])
        self.assertTrue(self.rows(info, "personhood")[0]["selected"])
        rendered = self.rendered(contents)
        self.assertIn(self.CORRECTION, rendered)
        self.assertIn("SUJET RÉCENT", rendered)
        self.assertLess(rendered.index(self.CORRECTION), rendered.index("SUJET RÉCENT"),
                        "the correction is stated before her own line")
