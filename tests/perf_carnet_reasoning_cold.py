"""Phase 12 perf: TRUE cold vs warm header-index timings for list / related / one resolve (drop_index() before the cold call).
Run: python3 -m unittest tests.perf_carnet_reasoning_cold -v   (prints PERF lines; asserts only generous ceilings)"""
import time
import unittest

import hq_carnet_reasoning as rsn
from tests.test_hq_carnet_reasoning import ASM, DEC, RBase


class Cold(RBase):
    def _ms(self, fn):
        t = time.perf_counter()
        fn()
        return (time.perf_counter() - t) * 1000

    def test_cold_vs_warm(self):
        n = 100
        recs = []
        for i in range(n):
            recs.append(self.rc(ASM if i % 2 else DEC, f"Perf {i}", evidence=[self.t_source()]))
        for label, call in (("list", lambda: rsn.list_records({"action": "reasoning_list"})),
                            ("related", lambda: rsn.related({"action": "reasoning_related", "targets": [self.t_source()]})),
                            ("resolve-one", lambda: rsn.resolve_one({"action": "reasoning_resolve", "id": recs[0]["id"]}))):
            rsn.drop_index()
            cold = self._ms(call)
            warm = self._ms(call)
            print(f"PERF {label} cold={cold:.1f} ms warm={warm:.1f} ms ({n} records)")
            self.assertLess(cold, 5000)


if __name__ == "__main__":
    unittest.main()
