import tempfile
import unittest
from pathlib import Path
from unittest import mock

import hq_engine as eng
import hq_librespot as lr


class LibrespotTests(unittest.TestCase):
    def test_registered_and_controllable(self):
        d = eng.get("librespot")
        self.assertIsNotNone(d)
        self.assertTrue(d.can("start"))
        self.assertTrue(d.can("stop"))

    def test_args_use_cache_and_name(self):
        args = lr.build_args(Path("x/librespot.exe"))
        self.assertIn("--cache", args)
        self.assertEqual(args[args.index("--name") + 1], lr.device_name())

    def test_missing_binary_is_down_and_start_is_noop(self):
        with mock.patch.object(lr, "exe_path", return_value=None), mock.patch.object(lr, "running_pids", return_value=[]):
            self.assertFalse(lr.start())
            self.assertEqual(lr.check()["state"], "down")

    def test_running_without_login_warns(self):
        with tempfile.TemporaryDirectory() as t, mock.patch.object(lr, "CACHE_DIR", Path(t)), \
                mock.patch.object(lr, "exe_path", return_value=Path("a")), mock.patch.object(lr, "running_pids", return_value=[5]):
            self.assertEqual(lr.check()["state"], "warn")
            (Path(t) / "credentials.json").write_text("{}")
            self.assertEqual(lr.check()["state"], "ready")


if __name__ == "__main__":
    unittest.main()
