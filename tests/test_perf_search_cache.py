"""hq_search fold memo: cached results are identical to the uncached computation."""
import unittest

import hq_search


class FoldCacheTests(unittest.TestCase):
    def test_fold_equivalence(self):
        for t in ["Éléphant", "ÇA va", "naïve", "x" * 600 + "É", "", "plain"]:
            self.assertEqual(hq_search.fold(t), hq_search._fold_uncached(t))
            self.assertEqual(hq_search.fold(t), hq_search.fold(t))
        self.assertEqual(hq_search.fold(None), "")
        self.assertEqual(hq_search.words("Élé  Phant"), ["ele", "phant"])


if __name__ == "__main__":
    unittest.main()
