"""Dessiner exports and scratch storage: DXF layers per sketch + Ø/R cotes + a real round trip, the A4 shop sheet,
and the bounded draft history (keep K, TTL, orphans). Offline, temporary root only.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
from pathlib import Path

import hq_drawings as D


def _doc(sketches=None, objects=None, points=None) -> dict:
    return {
        "format": "transfert-hq-sketch",
        "version": 6,
        "units": "mm",
        "mode": "construction",
        "grid": {"spacing": 10, "visible": True, "snap": True},
        "snap": {"angle": True, "angleStep": 15},
        "points": points if points is not None else [
            {"id": "p1", "x": 0, "y": 0},
            {"id": "p2", "x": 40, "y": 0},
            {"id": "p3", "x": 40, "y": 25},
            {"id": "p4", "x": 0, "y": 25},
            {"id": "p5", "x": 20, "y": 12},
        ],
        "objects": objects if objects is not None else [
            {"id": "l1", "type": "line", "p1": "p1", "p2": "p2"},
            {"id": "l2", "type": "line", "p1": "p2", "p2": "p3"},
            {"id": "l3", "type": "line", "p1": "p3", "p2": "p4"},
            {"id": "l4", "type": "line", "p1": "p4", "p2": "p1"},
            {"id": "c1", "type": "circle", "center": "p5", "r": 4},
        ],
        "constraints": [],
        "sketches": sketches if sketches is not None else [],
    }


def _radial_doc() -> dict:
    """The sample drawing plus one Ø cote on its circle (r 4): the label the app builds is ⌀8."""
    doc = _doc()
    doc["objects"] = list(doc["objects"]) + [
        {"id": "d1", "type": "dim_diameter", "item": "c1", "ang": 0.6, "label": "", "ref": False, "tol": ""},
    ]
    return doc


def parse_dxf(text: str) -> dict:
    """A tiny reader for what build_dxf writes: layers, entities and header extents. Not a general DXF parser."""
    lines = text.splitlines()
    pairs = [(int(lines[i].strip()), lines[i + 1]) for i in range(0, len(lines) - 1, 2) if lines[i].strip().lstrip("-").isdigit()]
    out = {"layers": {}, "entities": [], "header": {}}
    i = 0
    in_tables = in_entities = False
    while i < len(pairs):
        code, value = pairs[i]
        if code == 9:
            key = value.strip()
            if key in ("$EXTMIN", "$EXTMAX"):
                nums = {}
                j = i + 1
                while j < len(pairs) and pairs[j][0] not in (0, 9):  # a header value run, never the next variable
                    if pairs[j][0] in (10, 20):
                        nums[pairs[j][0]] = float(pairs[j][1])
                    j += 1
                out["header"][key] = (nums.get(10, 0.0), nums.get(20, 0.0))
            i += 1
            continue
        if code != 0:
            i += 1
            continue
        name = value.strip()
        if name == "SECTION":
            section = pairs[i + 1][1].strip() if i + 1 < len(pairs) and pairs[i + 1][0] == 2 else ""
            in_tables, in_entities = section == "TABLES", section == "ENTITIES"
            i += 2
            continue
        if name == "ENDSEC":
            in_tables = in_entities = False
            i += 1
            continue
        if (in_tables and name == "LAYER") or (in_entities and name in ("LINE", "CIRCLE", "ARC", "TEXT", "LWPOLYLINE", "POLYLINE", "VERTEX")):
            j = i + 1
            codes = []
            while j < len(pairs) and pairs[j][0] != 0:
                codes.append(pairs[j])
                j += 1
            if in_tables:
                table = dict(codes)
                out["layers"][table.get(2, "")] = {"color": table.get(62), "ltype": table.get(6)}
            else:
                out["entities"].append({"type": name, "codes": codes})
            i = j
            continue
        i += 1
    return out


def codes_of(ent) -> dict:
    return {c: v for c, v in ent["codes"]}


class DxfLayersTests(unittest.TestCase):
    def test_each_base_plane_sketch_gets_its_own_layer(self):
        doc = _doc(sketches=[
            {"id": "sk1", "name": "Face avant", "plane": "XY", "offset": 0},
            {"id": "sk2", "name": "Perçage", "plane": "XY", "offset": 0},
            {"id": "sk3", "name": "Profil 3D", "plane": "XZ", "offset": 12},
        ])
        doc["objects"][0]["sketch"] = "sk1"
        doc["objects"][1]["sketch"] = "sk2"
        doc["objects"][2]["sketch"] = "sk3"  # a 3D sketch stays out of the flat DXF
        dxf = parse_dxf(D.build_dxf(doc))
        self.assertIn("ESQ_FACE_AVANT", dxf["layers"])
        self.assertIn("ESQ_PERCAGE", dxf["layers"])
        self.assertIn("GEOMETRIE", dxf["layers"])
        lines = [e for e in dxf["entities"] if e["type"] == "LINE"]
        layers = [codes_of(e)[8] for e in lines]
        self.assertIn("ESQ_FACE_AVANT", layers)
        self.assertIn("ESQ_PERCAGE", layers)
        self.assertEqual(len(lines), 3, "the XZ sketch must not be exported to the flat DXF")
        self.assertTrue(dxf["layers"]["ESQ_FACE_AVANT"]["color"])

    def test_radial_dimension_export(self):
        doc = _doc()
        doc["objects"].append({"id": "d1", "type": "dim_diameter", "item": "c1", "ang": 0, "label": "", "ref": False, "tol": ""})
        doc["objects"].append({"id": "d2", "type": "dim_radius", "item": "c1", "ang": 1.0, "label": "", "ref": True, "tol": "±0,1"})
        dxf = parse_dxf(D.build_dxf(doc))
        cot = [e for e in dxf["entities"] if codes_of(e).get(8) == "COTATIONS"]
        texts = [codes_of(e)[1] for e in cot if e["type"] == "TEXT"]
        self.assertTrue(any(v.startswith("%%c8") for v in texts), texts)  # diameter 2×4, as the DXF glyph for Ø
        self.assertTrue(any(v.startswith("(R4") for v in texts), texts)   # reference cote in parentheses
        self.assertTrue(any("±0,1" in v for v in texts), texts)
        self.assertGreaterEqual(len([e for e in cot if e["type"] == "LINE"]), 4, "leader + ticks")


class CurveExportTests(unittest.TestCase):
    def _curve_doc(self, closed=True, mixed=False):
        doc = _doc(objects=[], points=[
            {"id": "ec", "x": 0, "y": 0},
            {"id": "s0", "x": 20, "y": 0}, {"id": "s1", "x": 40, "y": 0},
            {"id": "s2", "x": 40, "y": 20}, {"id": "s3", "x": 20, "y": 20},
        ])
        doc["objects"] = [
            {"id": "el", "type": "ellipse", "center": "ec", "rx": 10, "ry": 5},
            {"id": "sp", "type": "spline", "pts": ["s0", "s1", "s2", "s3"], "closed": closed},
        ]
        if mixed:
            doc["objects"].append({"id": "ln", "type": "line", "p1": "s0", "p2": "s1"})
        doc["features"] = [{"id": "f1", "type": "extrude", "profile": ["el", "ln"] if mixed else ["sp"], "depth": 5, "extent": "blind"}]
        return doc

    def test_closed_curves_validate_and_export_as_polylines(self):
        out = D.validate_document(self._curve_doc(), build=False)
        self.assertEqual([o["type"] for o in out["objects"]], ["ellipse", "spline"])
        dxf = parse_dxf(D.build_dxf(out))
        polys = [e for e in dxf["entities"] if e["type"] == "POLYLINE"]
        self.assertEqual(len(polys), 2, "the ellipse and the spline are both exported")
        self.assertTrue(all(codes_of(p).get(70) == "1" for p in polys), "both curves are closed polylines")
        verts = [e for e in dxf["entities"] if e["type"] == "VERTEX"]
        self.assertGreater(len(verts), 48)
        self.assertLessEqual(dxf["header"]["$EXTMIN"][0], -10 + 1e-6)
        self.assertGreaterEqual(dxf["header"]["$EXTMAX"][0], 40 - 1e-6)

    def test_curves_reach_the_pdf_sheet(self):
        pdf = D.build_pdf(D.validate_document(self._curve_doc(), build=False), name="Courbes")
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertGreater(len(pdf), 2000)

    def test_open_spline_and_mixed_curves_are_refused(self):
        with self.assertRaisesRegex(D.DrawingError, "ouverte"):
            D.validate_document(self._curve_doc(closed=False), build=False)
        with self.assertRaisesRegex(D.DrawingError, "seule"):
            D.validate_document(self._curve_doc(mixed=True), build=False)
        short = self._curve_doc()
        short["objects"][1]["pts"] = short["objects"][1]["pts"][:2]
        with self.assertRaisesRegex(D.DrawingError, "trois points"):
            D.validate_document(short, build=False)


class DxfRoundTripTests(unittest.TestCase):
    def test_entity_count_extents_and_closed_profile(self):
        doc = D.validate_document(_doc())
        dxf = parse_dxf(D.build_dxf(doc))
        kinds = [e["type"] for e in dxf["entities"]]
        self.assertEqual(kinds.count("LINE"), 4)
        self.assertEqual(kinds.count("CIRCLE"), 1)
        # extents: the square plus the circle's own bounding box
        (x0, y0), (x1, y1) = dxf["header"]["$EXTMIN"], dxf["header"]["$EXTMAX"]
        self.assertAlmostEqual(x0, 0.0, places=6)
        self.assertAlmostEqual(y0, 0.0, places=6)
        self.assertAlmostEqual(x1, 40.0, places=6)
        self.assertAlmostEqual(y1, 25.0, places=6)
        # the four lines form one closed rectangle: every endpoint appears exactly twice
        ends = []
        for e in dxf["entities"]:
            if e["type"] != "LINE":
                continue
            c = codes_of(e)
            ends.append((round(float(c[10]), 6), round(float(c[20]), 6)))
            ends.append((round(float(c[11]), 6), round(float(c[21]), 6)))
        counts = {}
        for p in ends:
            counts[p] = counts.get(p, 0) + 1
        self.assertEqual(sorted(counts.values()), [2, 2, 2, 2], "le contour n'est pas fermé : " + repr(counts))

    def test_insunits_follows_the_document(self):
        dxf = D.build_dxf(D.validate_document(_doc()))
        self.assertIn("$INSUNITS", dxf)
        self.assertIn("\r\n70\r\n4\r\n", dxf)  # millimetres


class PdfSheetTests(unittest.TestCase):
    def test_a4_landscape_sheet_with_a_title_block(self):
        doc = D.validate_document(_doc())
        pdf = D.build_pdf(doc, name="Support moteur", material="6061-T6", note="2 pièces")
        self.assertTrue(pdf.startswith(b"%PDF-1.4"))
        self.assertIn(b"/MediaBox [0 0 842 595]", pdf)
        self.assertIn(b"/Type /Page", pdf)
        self.assertIn(b"startxref", pdf)
        self.assertIn(b"Support moteur", pdf)
        self.assertIn(b"6061-T6", pdf)
        self.assertIn("Échelle".encode("cp1252"), pdf)  # the stated scale, whatever it is
        # WinAnsi cannot carry ⌀: the sheet must print Ø, never "?"
        sheet = D.build_pdf(_radial_doc(), name="trou")
        self.assertIn(b"(\xd88) Tj", sheet, "the Ø cote must print as Ø8")
        self.assertNotIn(b"?8", sheet, "no ? where a glyph was simply not WinAnsi")
        self.assertLess(len(pdf), 200_000)

    def test_read_file_serves_the_sheet_on_demand(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Inbox" / "Drawings").mkdir(parents=True)
            saved = D.save_drawing(root, {"name": "plan", "source": "desktop", "doc": _doc(), "png": _png_url()})
            body, ctype, name = D.read_file(root, saved["stem"], "pdf")
            self.assertEqual(ctype, "application/pdf")
            self.assertTrue(name.endswith(".pdf"))
            self.assertTrue(body.startswith(b"%PDF-1.4"))
            # and nothing extra appeared next to the drawing
            files = sorted(p.name for p in (root / "Inbox" / "Drawings").iterdir())
            self.assertFalse(any(f.endswith(".pdf") for f in files), files)


def _png_url() -> str:
    import base64
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\xff\xff\xff" * 2 for _ in range(2))
    png = (D.PNG_SIG + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    return "data:image/png;base64," + base64.b64encode(png).decode()


class DraftHistoryTests(unittest.TestCase):
    def _root(self, tmp: str) -> Path:
        root = Path(tmp)
        (root / "Inbox" / "Drawings").mkdir(parents=True)
        return root

    def test_keeps_the_last_drafts_and_prunes_orphans(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._root(tmp)
            saved = D.save_drawing(root, {"name": "plan", "source": "desktop", "doc": _doc(), "png": _png_url()})
            t = 1_000_000.0
            for i in range(8):
                D.write_draft(root, {"stem": saved["stem"], "name": "plan", "doc": _doc()}, now=lambda i=i: t + i * 60)
            store = root / "Inbox" / "Drawings" / D.DRAFTS_DIR
            snaps = sorted(p.name for p in store.iterdir() if "draft-" in p.name)
            self.assertLessEqual(len(snaps), D.DRAFT_KEEP - 1, snaps)
            self.assertTrue((store / (saved["stem"] + D.DRAFT_SUFFIX)).is_file(), "the latest draft is always kept")
            draft = json.loads((store / (saved["stem"] + D.DRAFT_SUFFIX)).read_text("utf-8"))
            self.assertEqual(draft["objects"], len(_doc()["objects"]), "the draft says what it holds")

            # the drawing is deleted: its scratch copies go at the next listing
            D.delete_drawing(root, saved["stem"])
            D.list_drawings(root)
            self.assertEqual([p.name for p in store.iterdir() if p.name.startswith(saved["stem"])], [])

    def test_old_snapshots_are_pruned_by_ttl(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._root(tmp)
            saved = D.save_drawing(root, {"name": "plan", "source": "desktop", "doc": _doc(), "png": _png_url()})
            t = 1_000_000.0
            for i in range(4):
                D.write_draft(root, {"stem": saved["stem"], "doc": _doc()}, now=lambda i=i: t + i * 60)
            store = root / "Inbox" / "Drawings" / D.DRAFTS_DIR
            self.assertTrue(any("draft-" in p.name for p in store.iterdir()), "un instantané doit exister")
            # the TTL follows each file's write time (a listing must not parse every draft): age them on disk
            for p in store.iterdir():
                os.utime(p, (t, t))
            D.prune_drafts(root, now=lambda: t + D.DRAFT_TTL_DAYS * 86400 + 1)
            self.assertEqual([p.name for p in store.iterdir()], [], "TTL dépassé : tout doit être effacé")


if __name__ == "__main__":
    unittest.main()
