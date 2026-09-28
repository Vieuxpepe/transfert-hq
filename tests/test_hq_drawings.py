"""Transfert HQ « Dessiner » — storage, validation, DXF, HTTP auth/CSRF.

Offline only: temporary HQ root, fake PIN, no Windows controller, no Companion.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import struct
import subprocess
import tempfile
import threading
import unittest
import zlib
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

import hq_drawings as D
import iphone_bridge

PIN = "424242"
UPLOAD_PIN = "135790"


def make_png(w: int = 2, h: int = 2) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\xff\xff\xff" * w for _ in range(h))
    return (D.PNG_SIG + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def png_url(data: bytes | None = None) -> str:
    return "data:image/png;base64," + base64.b64encode(data or make_png()).decode()


def sample_doc(units: str = "mm") -> dict:
    return {
        "format": "transfert-hq-sketch",
        "version": 1,
        "units": units,
        "mode": "construction",
        "grid": {"spacing": 10, "visible": True, "snap": True},
        "snap": {"angle": True, "angleStep": 15},
        "nextId": 20,
        "points": [
            {"id": "p1", "x": 0, "y": 0},
            {"id": "p2", "x": 25, "y": 0},
            {"id": "p3", "x": 25, "y": 10},
            {"id": "p4", "x": 50, "y": 50},
        ],
        "objects": [
            {"id": "l1", "type": "line", "p1": "p1", "p2": "p2"},
            {"id": "l2", "type": "line", "p1": "p2", "p2": "p3"},
            {"id": "a1", "type": "centerline", "p1": "p1", "p2": "p3"},
            {"id": "c1", "type": "circle", "center": "p4", "r": 7.5},
            {"id": "s1", "type": "stroke", "pts": [[0, 20], [5, 20.001], [10, 20], [10, 30]]},
            {"id": "t1", "type": "text", "x": 1, "y": 40, "text": "Percer Ø6 — été", "h": 5},
            {"id": "d1", "type": "dim_linear", "a": [0, 0], "b": [25, 0], "offset": -8, "label": "25 ±0.1"},
            {"id": "d2", "type": "dim_angle", "c": [25, 0], "a": [0, 0], "b": [25, 10], "r": 6, "label": ""},
        ],
        "constraints": [
            {"id": "k1", "type": "length", "line": "l1", "fixed": "p1", "value": 25},
            {"id": "k2", "type": "angle", "lines": ["l1", "l2"], "vertex": "p2", "value": 90},
        ],
    }


def dxf_pairs(text: str) -> list[tuple[int, str]]:
    lines = text.split("\r\n")
    if lines and lines[-1] == "":
        lines.pop()
    assert len(lines) % 2 == 0, "DXF must be code/value pairs"
    return [(int(lines[i].strip()), lines[i + 1]) for i in range(0, len(lines), 2)]


def dxf_entities(text: str) -> list[dict]:
    pairs = dxf_pairs(text)
    start = next(i for i, (c, v) in enumerate(pairs) if c == 2 and v == "ENTITIES")
    ents: list[dict] = []
    for code, value in pairs[start + 1:]:
        if code == 0:
            if value in ("ENDSEC", "EOF"):
                break
            ents.append({"_type": value, "_codes": []})
        elif ents:
            ents[-1]["_codes"].append((code, value))
            ents[-1].setdefault(code, value)
    return ents


class NamingTests(unittest.TestCase):
    def test_sanitize_base_name(self):
        cases = {
            "../../etc/passwd": "passwd",
            "C:\\Windows\\System32\\evil": "evil",
            "Pièce été #2": "Piece-ete-2",
            "": "croquis",
            "   ...  ": "croquis",
            "CON": "dessin-CON",
            "lpt1": "dessin-lpt1",
            "support.hqdraw.json": "support",
            "a" * 200: "a" * 60,
            ".hidden": "hidden",
        }
        for raw, want in cases.items():
            self.assertEqual(D.sanitize_base_name(raw), want, raw)

    def test_source_suffix_is_allowlisted(self):
        self.assertEqual(D.source_suffix("mobile"), "_HQWeb-Mobile")
        self.assertEqual(D.source_suffix("DESKTOP"), "_HQWeb-Desktop")
        self.assertEqual(D.source_suffix("iPhone 15 Pro/../../x"), "_HQWeb")

    def test_valid_stem_rejects_paths(self):
        for bad in ("../x", "a/b", "a\\b", ".hidden", "x.hqdraw", "", "-x", "a" * 121, "é"):
            with self.assertRaises(D.DrawingError, msg=bad):
                D.valid_stem(bad)
        self.assertEqual(D.valid_stem("support_HQWeb-Mobile-2"), "support_HQWeb-Mobile-2")


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="hq-draw-"))
        (self.root / "Inbox").mkdir()
        self.outside = Path(tempfile.mkdtemp(prefix="hq-draw-out-"))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.outside, ignore_errors=True)

    def _save(self, name="support", source="desktop", doc=None, png=None):
        return D.save_drawing(self.root, {"name": name, "source": source, "doc": doc or sample_doc(), "png": png or png_url()})

    def test_save_writes_json_png_dxf_with_same_stem(self):
        res = self._save()
        self.assertEqual(res["stem"], "support_HQWeb-Desktop")
        d = self.root / "Inbox" / "Drawings"
        self.assertEqual(sorted(p.name for p in d.iterdir()),
                         ["support_HQWeb-Desktop.dxf", "support_HQWeb-Desktop.hqdraw.json", "support_HQWeb-Desktop.png"])
        self.assertEqual(res["files"]["png"], "Inbox/Drawings/support_HQWeb-Desktop.png")
        doc = json.loads((d / "support_HQWeb-Desktop.hqdraw.json").read_text(encoding="utf-8"))
        self.assertEqual(doc["version"], 1)
        self.assertEqual(doc["meta"]["source"], "HQWeb-Desktop")
        self.assertEqual((d / "support_HQWeb-Desktop.png").read_bytes(), make_png())
        self.assertIn("$INSUNITS", (d / "support_HQWeb-Desktop.dxf").read_text(encoding="cp1252"))

    def test_collisions_never_overwrite(self):
        first = self._save()
        d = self.root / "Inbox" / "Drawings"
        before = {p.name: p.read_bytes() for p in d.iterdir()}
        second = self._save(png=png_url(make_png(3, 3)))
        third = self._save(source="mobile")
        self.assertEqual(second["stem"], "support-2_HQWeb-Desktop")
        self.assertEqual(third["stem"], "support_HQWeb-Mobile")
        for name, data in before.items():
            self.assertEqual((d / name).read_bytes(), data, name)
        # a stray file with only one of the three extensions still reserves the stem
        (d / "bracket_HQWeb-Desktop.png").write_bytes(b"not mine")
        res = self._save(name="bracket")
        self.assertEqual(res["stem"], "bracket-2_HQWeb-Desktop")
        self.assertEqual((d / "bracket_HQWeb-Desktop.png").read_bytes(), b"not mine")
        self.assertFalse([p for p in d.iterdir() if p.name.startswith(".")], "no temp leftovers")
        self.assertEqual(first["stem"], "support_HQWeb-Desktop")

    def test_client_path_is_never_used(self):
        res = self._save(name="../../../outside/evil")
        self.assertEqual(res["stem"], "evil_HQWeb-Desktop")
        self.assertTrue((self.root / "Inbox" / "Drawings" / "evil_HQWeb-Desktop.png").is_file())
        self.assertFalse((self.root / "outside").exists())

    def test_saved_document_is_normalized(self):
        doc = sample_doc()
        doc["objects"][0]["onclick"] = "alert(1)"
        doc["evil"] = {"path": "C:/Windows"}
        res = self._save(doc=doc)
        got = D.open_drawing(self.root, res["stem"])["doc"]
        self.assertNotIn("onclick", got["objects"][0])
        self.assertNotIn("evil", got)
        self.assertEqual(got["objects"][5]["text"], "Percer Ø6 — été")
        self.assertEqual(got["meta"]["stem"], res["stem"])

    def test_list_and_reopen_roundtrip(self):
        a = self._save(name="a")
        b = self._save(name="b", source="mobile")
        listing = D.list_drawings(self.root)
        self.assertEqual(listing["dir"], "Inbox/Drawings")
        self.assertEqual({i["stem"] for i in listing["items"]}, {a["stem"], b["stem"]})
        item = next(i for i in listing["items"] if i["stem"] == b["stem"])
        self.assertTrue(item["png"] and item["dxf"])
        self.assertEqual(item["source"], "Mobile")
        reopened = D.open_drawing(self.root, a["stem"])["doc"]
        self.assertEqual(reopened["constraints"], sample_doc()["constraints"])
        self.assertEqual([o["id"] for o in reopened["objects"]], [o["id"] for o in sample_doc()["objects"]])
        body, ctype, name = D.read_file(self.root, a["stem"], "png")
        self.assertEqual((body, ctype, name), (make_png(), "image/png", a["stem"] + ".png"))
        with self.assertRaises(D.DrawingError):
            D.read_file(self.root, a["stem"], "exe")

    def test_list_without_folder_is_empty(self):
        self.assertEqual(D.list_drawings(self.root)["items"], [])
        with self.assertRaises(D.DrawingError) as cm:
            D.open_drawing(self.root, "nope")
        self.assertEqual(cm.exception.status, 404)

    def test_traversal_stems_rejected(self):
        self._save()
        (self.root / "Inbox" / "secret.hqdraw.json").write_text(json.dumps(sample_doc()), encoding="utf-8")
        for stem in ("../secret", "..\\secret", "/etc/passwd", "%2e%2e/secret"):
            with self.assertRaises(D.DrawingError) as cm:
                D.open_drawing(self.root, stem)
            self.assertEqual(cm.exception.status, 400, stem)

    def test_corrupt_saved_document_is_reported(self):
        d = D.drawings_dir(self.root, create=True)
        (d / "bad.hqdraw.json").write_text("{nope", encoding="utf-8")
        (d / "bad2.hqdraw.json").write_text(json.dumps({"format": "x"}), encoding="utf-8")
        for stem in ("bad", "bad2"):
            with self.assertRaises(D.DrawingError) as cm:
                D.open_drawing(self.root, stem)
            self.assertEqual(cm.exception.status, 422)

    @unittest.skipIf(os.name == "nt", "POSIX symlink semantics")
    def test_symlinked_drawings_dir_rejected(self):
        os.symlink(self.outside, self.root / "Inbox" / "Drawings")
        with self.assertRaises(D.DrawingError):
            self._save()
        with self.assertRaises(D.DrawingError):
            D.list_drawings(self.root)
        with self.assertRaises(D.DrawingError):
            D.open_drawing(self.root, "x")
        self.assertEqual(list(self.outside.iterdir()), [])

    @unittest.skipIf(os.name == "nt", "POSIX symlink semantics")
    def test_symlinked_files_rejected_and_hidden(self):
        self._save(name="real")
        d = self.root / "Inbox" / "Drawings"
        secret = self.outside / "secret.hqdraw.json"
        secret.write_text(json.dumps(sample_doc()), encoding="utf-8")
        os.symlink(secret, d / "leak.hqdraw.json")
        os.symlink(self.outside / "x.png", d / "leak.png")
        (self.outside / "x.png").write_bytes(make_png())
        self.assertEqual([i["stem"] for i in D.list_drawings(self.root)["items"]], ["real_HQWeb-Desktop"])
        os.unlink(d / "real_HQWeb-Desktop.png")
        os.symlink(self.outside / "x.png", d / "real_HQWeb-Desktop.png")
        self.assertFalse(D.list_drawings(self.root)["items"][0]["png"], "linked companion not advertised")
        with self.assertRaises(D.DrawingError) as cm:
            D.open_drawing(self.root, "leak")
        self.assertEqual(cm.exception.status, 400)
        with self.assertRaises(D.DrawingError):
            D.read_file(self.root, "leak", "png")
        # a dangling symlink occupying a stem is skipped, never written through
        os.symlink(self.outside / "target.png", d / "trap_HQWeb-Desktop.png")
        res = self._save(name="trap")
        self.assertEqual(res["stem"], "trap-2_HQWeb-Desktop")
        self.assertFalse((self.outside / "target.png").exists())

    @unittest.skipIf(os.name == "nt", "POSIX symlink semantics")
    def test_symlinked_inbox_escape_rejected(self):
        # Drawings resolving outside the resolved Inbox (e.g. via a nested link) is refused
        inner = self.root / "Inbox" / "real"
        inner.mkdir()
        os.symlink(self.outside, self.root / "Inbox" / "Drawings")
        with self.assertRaises(D.DrawingError):
            D.drawings_dir(self.root, create=True)

    @unittest.skipUnless(os.name == "nt", "Windows junctions only")
    def test_windows_junction_rejected(self):  # pragma: no cover - runs on Windows only
        target = self.root / "Inbox" / "Drawings"
        r = subprocess.run(["cmd", "/c", "mklink", "/J", str(target), str(self.outside)], capture_output=True, text=True)
        if r.returncode != 0:
            self.skipTest("mklink /J unavailable: " + r.stderr)
        with self.assertRaises(D.DrawingError):
            self._save()
        with self.assertRaises(D.DrawingError):
            D.list_drawings(self.root)
        self.assertEqual(list(self.outside.iterdir()), [])

    def test_failed_publish_leaves_nothing_half_written(self):
        calls = {"n": 0}
        real = D._publish_noclobber

        def flaky(tmp, final):
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError("disk full")
            return real(tmp, final)

        D._publish_noclobber = flaky
        try:
            with self.assertRaises(OSError):
                self._save()
        finally:
            D._publish_noclobber = real
        self.assertEqual(list((self.root / "Inbox" / "Drawings").iterdir()), [])

    def test_publish_is_noclobber(self):
        d = D.drawings_dir(self.root, create=True)
        (d / "x.png").write_bytes(b"keep")
        tmp = D._write_temp(d, b"new")
        with self.assertRaises(FileExistsError):
            D._publish_noclobber(tmp, d / "x.png")
        self.assertEqual((d / "x.png").read_bytes(), b"keep")
        os.unlink(tmp)


class ValidationTests(unittest.TestCase):
    def assertBad(self, doc, status=400):
        with self.assertRaises(D.DrawingError) as cm:
            D.validate_document(doc)
        self.assertEqual(cm.exception.status, status, str(cm.exception))

    def test_valid_sample(self):
        out = D.validate_document(sample_doc())
        self.assertEqual(out["units"], "mm")
        self.assertEqual(len(out["objects"]), 8)

    def test_malformed_documents(self):
        def mut(fn):
            d = sample_doc()
            fn(d)
            return d

        bads = [
            None, [], "x",
            mut(lambda d: d.update(format="other")),
            mut(lambda d: d.update(version=2)),
            mut(lambda d: d.update(units="furlong")),
            mut(lambda d: d["objects"].append({"id": "z", "type": "script"})),
            mut(lambda d: d["objects"][0].update(p2="missing")),
            mut(lambda d: d["objects"][0].update(p2="p1")),
            mut(lambda d: d["points"][0].update(x=float("nan"))),
            mut(lambda d: d["points"][0].update(x=float("inf"))),
            mut(lambda d: d["points"][0].update(x=True)),
            mut(lambda d: d["points"][0].update(x="1")),
            mut(lambda d: d["points"][0].update(x=1e12)),
            mut(lambda d: d["objects"][1].update(id="l1")),
            mut(lambda d: d["objects"][1].update(id="../x")),
            mut(lambda d: d["objects"][3].update(r=0)),
            mut(lambda d: d["objects"][5].update(text="")),
            mut(lambda d: d["objects"][5].update(text="x" * 501)),
            mut(lambda d: d["objects"][4].update(pts=[])),
            mut(lambda d: d["objects"][4].update(pts=[[0, 0, 0]])),
            mut(lambda d: d["constraints"][0].update(fixed="p3")),
            mut(lambda d: d["constraints"][0].update(line="c1")),
            mut(lambda d: d["constraints"][1].update(vertex="p1")),
            mut(lambda d: d["constraints"][1].update(value=181)),
            mut(lambda d: d["constraints"].append({"id": "k9", "type": "coincident"})),
            mut(lambda d: d.update(grid={"spacing": 0})),
            mut(lambda d: d.update(points="nope")),
        ]
        for i, bad in enumerate(bads):
            with self.subTest(i=i):
                self.assertBad(bad)

    def test_size_limits(self):
        d = sample_doc()
        d["objects"] = [{"id": f"t{i}", "type": "text", "x": 0, "y": 0, "text": "x"} for i in range(D.MAX_OBJECTS + 1)]
        d["constraints"] = []
        self.assertBad(d, 413)
        d = sample_doc()
        d["objects"][4]["pts"] = [[i, 0] for i in range(D.MAX_STROKE_PTS + 1)]
        self.assertBad(d, 413)

    def test_png_validation(self):
        self.assertEqual(D.decode_png(png_url()), make_png())
        for bad in (None, "", "data:image/jpeg;base64,AAAA", "data:image/png;base64,@@@@",
                    "data:image/png;base64," + base64.b64encode(b"GIF89a" + b"\0" * 40).decode()):
            with self.assertRaises(D.DrawingError):
                D.decode_png(bad)
        huge_dims = bytearray(make_png())
        huge_dims[16:24] = struct.pack(">II", 100000, 10)
        with self.assertRaises(D.DrawingError):
            D.decode_png(png_url(bytes(huge_dims)))
        too_big = "data:image/png;base64," + "A" * (D.MAX_PNG_BYTES * 2)
        with self.assertRaises(D.DrawingError) as cm:
            D.decode_png(too_big)
        self.assertEqual(cm.exception.status, 413)


class DxfTests(unittest.TestCase):
    def setUp(self):
        self.doc = D.validate_document(sample_doc())
        self.text = D.build_dxf(self.doc)
        self.ents = dxf_entities(self.text)

    def test_header_units(self):
        pairs = dxf_pairs(self.text)
        i = pairs.index((9, "$INSUNITS"))
        self.assertEqual(pairs[i + 1], (70, "4"))
        self.assertIn((1, "AC1009"), pairs)
        for units, code in (("in", "1"), ("cm", "5"), ("m", "6")):
            t = D.build_dxf(D.validate_document(sample_doc(units)))
            p = dxf_pairs(t)
            self.assertEqual(p[p.index((9, "$INSUNITS")) + 1], (70, code), units)
        self.assertTrue(self.text.endswith("0\r\nEOF\r\n"))

    def test_construction_geometry_is_real_lines_and_circles_in_model_coordinates(self):
        geo = [e for e in self.ents if e.get(8) == "GEOMETRIE"]
        lines = [e for e in geo if e["_type"] == "LINE"]
        self.assertEqual(len(lines), 2)
        l1 = lines[0]
        self.assertEqual((l1[10], l1[20], l1[11], l1[21]), ("0", "0", "25", "0"))
        l2 = lines[1]
        self.assertEqual((l2[10], l2[20], l2[11], l2[21]), ("25", "0", "25", "10"), "Y-up kept (no screen flip)")
        circ = [e for e in geo if e["_type"] == "CIRCLE"]
        self.assertEqual(len(circ), 1)
        self.assertEqual((circ[0][10], circ[0][20], circ[0][40]), ("50", "50", "7.5"))
        axes = [e for e in self.ents if e.get(8) == "AXES"]
        self.assertEqual([e["_type"] for e in axes], ["LINE"])

    def test_freehand_is_simplified_reference_polyline(self):
        ref = [e for e in self.ents if e.get(8) == "REFERENCE_MAIN_LEVEE"]
        self.assertEqual(ref[0]["_type"], "POLYLINE")
        verts = [(e[10], e[20]) for e in ref if e["_type"] == "VERTEX"]
        self.assertEqual(verts, [("0", "20"), ("10", "20"), ("10", "30")], "collinear jitter removed")
        self.assertEqual(ref[-1]["_type"], "SEQEND")

    def test_notes_and_cotations_are_annotation_layers_only(self):
        notes = [e for e in self.ents if e.get(8) == "NOTES"]
        self.assertEqual([(e["_type"], e[1]) for e in notes], [("TEXT", "Percer Ø6 — été")])
        cot = [e for e in self.ents if e.get(8) == "COTATIONS"]
        self.assertTrue(cot)
        self.assertTrue({e["_type"] for e in cot} <= {"LINE", "TEXT", "ARC"})
        self.assertIn("25 ±0.1", [e.get(1) for e in cot if e["_type"] == "TEXT"])
        self.assertIn("90%%d", [e.get(1) for e in cot if e["_type"] == "TEXT"], "empty angle label -> measured value")
        types = {e["_type"] for e in self.ents}
        self.assertNotIn("DIMENSION", types, "manual cotations never become CAD dimensions/constraints")
        # driving constraints are sketch metadata; the DXF only carries resulting geometry
        self.assertFalse(any(e.get(8) not in D.LAYERS for e in self.ents))

    def test_text_cannot_inject_group_codes(self):
        doc = sample_doc()
        doc["objects"][5]["text"] = "ok\r\n0\r\nLINE\r\n8\r\nGEOMETRIE"
        doc["objects"][6]["label"] = "x\n0\nCIRCLE"
        out = D.validate_document(doc)
        ents = dxf_entities(D.build_dxf(out))
        self.assertEqual(sum(1 for e in ents if e.get(8) == "GEOMETRIE" and e["_type"] == "LINE"), 2)
        self.assertEqual(sum(1 for e in ents if e["_type"] == "CIRCLE"), 1)

    def test_dxf_encodes_to_cp1252(self):
        self.text.encode("cp1252", errors="strict")
        self.assertEqual(D.build_dxf(D.validate_document(sample_doc())), self.text, "deterministic")


def _http(port, method, path, *, body=None, headers=None, cookie=None):
    import http.client

    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    hdrs = {"Host": f"127.0.0.1:{port}"}
    if headers:
        hdrs.update(headers)
    if cookie:
        hdrs["Cookie"] = cookie
    if body is not None and "Content-Length" not in hdrs:
        hdrs["Content-Length"] = str(len(body))
    conn.request(method, path, body=body, headers=hdrs)
    resp = conn.getresponse()
    payload = resp.read()
    conn.close()
    return resp.status, dict(resp.getheaders()), payload


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._config = json.loads(json.dumps(iphone_bridge.CONFIG))
        cls._root = iphone_bridge.ROOT
        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-draw-http-"))
        (cls.tmp / "Inbox").mkdir()
        iphone_bridge.ROOT = cls.tmp
        iphone_bridge.CONFIG["pin"] = PIN
        iphone_bridge.CONFIG["users"] = [
            {"name": "admin", "pin": PIN, "role": "admin"},
            {"name": "phone", "pin": UPLOAD_PIN, "role": "upload"},
        ]
        iphone_bridge.CONFIG["discord_webhook_url"] = ""
        iphone_bridge.CONFIG["push_enabled"] = False
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), iphone_bridge.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.origin = f"http://127.0.0.1:{cls.port}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        iphone_bridge._LOGIN_FAILS.clear()
        cls.admin = cls._login(PIN)
        cls.phone = cls._login(UPLOAD_PIN)

    @classmethod
    def _login(cls, pin):
        status, headers, _ = _http(cls.port, "POST", "/login", body=urlencode({"pin": pin}).encode(),
                                   headers={"Origin": cls.origin, "Content-Type": "application/x-www-form-urlencoded"})
        if status != 303:
            raise AssertionError(f"login failed {status}")
        raw = headers.get("Set-Cookie") or headers.get("set-cookie") or ""
        return raw.split(";", 1)[0]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        iphone_bridge.ROOT = cls._root
        iphone_bridge.CONFIG.clear()
        iphone_bridge.CONFIG.update(cls._config)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _post(self, payload, *, cookie="admin", origin="self", raw=None, headers=None):
        hdrs = {"Content-Type": "application/json"}
        if origin == "self":
            hdrs["Origin"] = self.origin
        elif origin:
            hdrs["Origin"] = origin
        if headers:
            hdrs.update(headers)
        body = raw if raw is not None else json.dumps(payload).encode()
        ck = {"admin": self.admin, "phone": self.phone, None: None}[cookie]
        return _http(self.port, "POST", "/api/drawings", body=body, headers=hdrs, cookie=ck)

    def _get(self, path, cookie="admin"):
        ck = {"admin": self.admin, "phone": self.phone, None: None}[cookie]
        return _http(self.port, "GET", path, cookie=ck)

    def payload(self, name="piece"):
        return {"name": name, "source": "mobile", "doc": sample_doc(), "png": png_url()}

    def test_requires_session(self):
        for path in ("/api/drawings", "/api/drawings/open?stem=x", "/api/drawings/file?stem=x&kind=png"):
            status, _h, _b = self._get(path, cookie=None)
            self.assertEqual(status, 401, path)
        status, _h, _b = self._post(self.payload(), cookie=None)
        self.assertEqual(status, 401)

    def test_csrf_origin_enforced(self):
        status, _h, body = self._post(self.payload(), origin=None)
        self.assertEqual(status, 403)
        self.assertIn(b"CSRF", body)
        status, _h, _b = self._post(self.payload(), origin="http://evil.example")
        self.assertEqual(status, 403)
        self.assertFalse(list((self.tmp / "Inbox").glob("Drawings/*evil*")))

    def test_upload_role_is_refused(self):
        status, _h, _b = self._get("/api/drawings", cookie="phone")
        self.assertEqual(status, 403)
        status, _h, _b = self._post(self.payload("phone"), cookie="phone")
        self.assertEqual(status, 403)
        self.assertFalse(list((self.tmp / "Inbox").glob("Drawings/phone*")))

    def test_save_list_open_file_roundtrip(self):
        status, _h, body = self._post(self.payload("http-piece"))
        self.assertEqual(status, 200, body)
        res = json.loads(body)
        self.assertEqual(res["stem"], "http-piece_HQWeb-Mobile")
        self.assertTrue((self.tmp / "Inbox" / "Drawings" / "http-piece_HQWeb-Mobile.dxf").is_file())
        status, _h, body = self._post(self.payload("http-piece"))
        self.assertEqual(json.loads(body)["stem"], "http-piece-2_HQWeb-Mobile")
        status, _h, body = self._get("/api/drawings")
        self.assertEqual(status, 200)
        stems = [i["stem"] for i in json.loads(body)["items"]]
        self.assertIn("http-piece_HQWeb-Mobile", stems)
        status, _h, body = self._get("/api/drawings/open?stem=http-piece_HQWeb-Mobile")
        self.assertEqual(status, 200)
        doc = json.loads(body)["doc"]
        self.assertEqual(doc["objects"][6]["label"], "25 ±0.1")
        status, h, body = self._get("/api/drawings/file?stem=http-piece_HQWeb-Mobile&kind=png")
        self.assertEqual((status, h.get("Content-Type")), (200, "image/png"))
        self.assertEqual(body, make_png())
        self.assertEqual(h.get("X-Content-Type-Options"), "nosniff")
        status, h, body = self._get("/api/drawings/file?stem=http-piece_HQWeb-Mobile&kind=dxf")
        self.assertEqual(status, 200)
        self.assertIn("attachment", h.get("Content-Disposition", ""))
        self.assertIn(b"$INSUNITS", body)

    def test_bad_requests(self):
        status, _h, _b = self._post(None, raw=b"{not json")
        self.assertEqual(status, 400)
        bad = self.payload()
        bad["doc"]["version"] = 7
        status, _h, body = self._post(bad)
        self.assertEqual(status, 400)
        self.assertIn("Version", json.loads(body)["error"])
        bad = self.payload()
        bad["png"] = "data:image/png;base64,AAAA"
        status, _h, _b = self._post(bad)
        self.assertEqual(status, 400)
        for path in ("/api/drawings/open?stem=../../bridge_config", "/api/drawings/open?stem=..%2F..%2Fx",
                     "/api/drawings/file?stem=x&kind=exe"):
            status, _h, _b = self._get(path)
            self.assertEqual(status, 400, path)
        status, _h, _b = self._get("/api/drawings/open?stem=does-not-exist")
        self.assertEqual(status, 404)

    def test_body_size_limit(self):
        status, _h, body = self._post(None, raw=b"{}", headers={"Content-Length": str(D.MAX_BODY + 1)})
        self.assertEqual(status, 413)
        self.assertIn("volumineux", json.loads(body)["error"])

    def test_app_page_has_dessiner_tab(self):
        html = iphone_bridge.render_app().decode("utf-8")
        self.assertIn('data-nav="dessiner"', html)
        self.assertIn('<div data-panel="dessiner">', html)
        self.assertIn("/assets/hq-sketch-core.js", html)
        self.assertIn("/assets/hq-dessiner.js", html)
        self.assertIn("/api/drawings", iphone_bridge.ADMIN_PREFIXES)
        self.assertNotIn("/api/drawings", iphone_bridge.UPLOAD_POST_EXACT)
        for asset in ("hq-sketch-core.js", "hq-dessiner.js", "hq-dessiner.css"):
            self.assertTrue((Path(iphone_bridge.__file__).resolve().parent / "assets" / asset).is_file(), asset)


if __name__ == "__main__":
    unittest.main()
