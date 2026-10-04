"""Phase 11 perf: TRUE cold vs warm header-index timings for list / related (drop_index() before the cold call).
Run: python3 -m unittest tests.perf_carnet_verifications_cold -v   (prints PERF lines; asserts only generous ceilings)"""
import time
import unittest

import hq_carnet_verifications as ver
from tests.test_hq_carnet_verifications import VBase


class Cold(VBase):
    def _ms(self, fn):
        t = time.perf_counter()
        fn()
        return (time.perf_counter() - t) * 1000

    def test_cold_vs_warm(self):
        n = 100
        for i in range(n):
            self.vc(self.t_block(i % 3), question=f"Perf {i} ?")
        for label, call in (("list", lambda: ver.read({"action": "verification_list"}) if False else self.list_all()),
                            ("related", lambda: self.related_call())):
            ver.drop_index()
            cold = self._ms(call)
            warm = self._ms(call)
            print(f"PERF {label} cold={cold:.1f} ms warm={warm:.1f} ms ({n} verifications)")
            self.assertLess(cold, 5000)

    def list_all(self):
        return ver.list_verifications({"action": "verification_list"})

    def related_call(self):
        return ver.related({"action": "verification_related", "targets": [self.t_block(0)]})


if __name__ == "__main__":
    unittest.main()
