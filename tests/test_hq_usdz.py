"""AR Quick Look export (hq_usdz): a valid, 64-byte aligned USDZ of the part, in metres, Y up, on the table."""
import io
import re
import struct
import unittest
import zipfile

import hq_drawings as D
import hq_solid as S
import hq_usdz as U
from tests.test_hq_solid import sample


class UsdzTests(unittest.TestCase):
    def setUp(self):
        U.reset_for_tests()

    def test_package_is_a_stored_zip_with_aligned_data(self):
        data = U.package([("model.usda", b"#usda 1.0\n"), ("b.txt", b"x" * 7)])
        zf = zipfile.ZipFile(io.BytesIO(data))
        self.assertEqual(zf.namelist(), ["model.usda", "b.txt"])
        self.assertEqual(zf.read("b.txt"), b"x" * 7)
        for info in zf.infolist():
            self.assertEqual(info.compress_type, zipfile.ZIP_STORED)
            name_len, extra_len = struct.unpack("<HH", data[info.header_offset + 26:info.header_offset + 30])
            start = info.header_offset + 30 + name_len + extra_len
            self.assertEqual(start % 64, 0, "USDZ needs every file on a 64-byte boundary")

    def test_part_in_metres_y_up_resting_on_the_table(self):
        mesh = S.build_mesh(D.validate_document(sample()))  # 100 x 60 x 20 mm box
        text = U.usda(mesh, "mm", "support moteur")
        self.assertIn('upAxis = "Y"', text)
        self.assertIn("metersPerUnit = 1", text)
        self.assertIn('def Xform "support_moteur"', text)
        pts = [tuple(float(v) for v in m.groups()) for m in re.finditer(r"\(([-\d.e]+), ([-\d.e]+), ([-\d.e]+)\)", text.split("point3f[] points = [", 1)[1].split("]", 1)[0])]
        self.assertEqual(len(pts), len(mesh) * 3)
        ys = [p[1] for p in pts]
        xs = [p[0] for p in pts]
        self.assertAlmostEqual(min(ys), 0)
        self.assertAlmostEqual(max(ys), 0.02, msg="20 mm tall, in metres, along Y")
        self.assertAlmostEqual(max(xs) - min(xs), 0.1)
        self.assertAlmostEqual(min(xs), -0.05, msg="centred on the origin")
        self.assertEqual(text.count("int[] faceVertexCounts"), 1)

    def test_keep_and_expire(self):
        fid = U.keep(b"abc", now=100)
        self.assertEqual(U.fetch(fid, now=200), b"abc")
        self.assertIsNone(U.fetch(fid, now=100 + U.KEEP_SEC + 1))
        self.assertIsNone(U.fetch("../etc/passwd"))
        ids = [U.keep(b"x", now=300 + i) for i in range(U.KEEP_MAX + 2)]
        self.assertIsNone(U.fetch(ids[0], now=310), "only the most recent few are kept")
        self.assertEqual(U.fetch(ids[-1], now=310), b"x")

    def test_drawing_route(self):
        out = D.ar_model({"doc": sample(), "name": "Boîte"})
        self.assertTrue(out["url"].endswith(".usdz"))
        data = U.fetch(out["id"])
        self.assertIn(b"#usda 1.0", data)
        empty = sample()
        empty["features"] = []
        with self.assertRaises(D.DrawingError):
            D.ar_model({"doc": empty})


if __name__ == "__main__":
    unittest.main()
