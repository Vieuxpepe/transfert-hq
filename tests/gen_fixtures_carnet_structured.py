"""Regenerates tests/fixtures_carnet_structured.json from the PYTHON implementation (the source of truth).

The fixture is then consumed by BOTH test_hq_carnet_structured.py (which fails when it drifts from Python) and
check_hq_carnet_structured.mjs (which fails when the browser core drifts from Python).
    python3 tests/gen_fixtures_carnet_structured.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import hq_carnet_rich as rich  # noqa: E402
import hq_drawings as dr  # noqa: E402

A = {"id": "asset-" + "a" * 24, "mime": "image/png", "w": 10, "h": 8, "caption": ""}
B = {"id": "asset-" + "b" * 24, "mime": "image/jpeg", "w": 16, "h": 12, "caption": "avant"}
C = {"id": "asset-" + "c" * 24, "mime": "image/webp", "w": 20, "h": 20, "caption": ""}
PATHS = {A["id"]: "n.assets/figure-01.png", B["id"]: "n.assets/figure-02.jpg", C["id"]: "n.assets/figure 03#.webp"}

CASES = [
    # (name, type, payload)
    ("table ok", "table", {"header": True, "rows": [["A", "B"], ["1", "2,5"]]}),
    ("table headerless", "table", {"header": False, "rows": [["A", "B"], ["C", "D"]]}),
    ("table 1x1", "table", {"header": False, "rows": [[""]]}),
    ("table 20x10", "table", {"header": True, "rows": [[str(r * 10 + c) for c in range(10)] for r in range(20)]}),
    ("table 21 rows", "table", {"header": True, "rows": [["x"]] * 21}),
    ("table 11 cols", "table", {"header": True, "rows": [["x"] * 11]}),
    ("table empty rows", "table", {"header": True, "rows": []}),
    ("table empty row", "table", {"header": True, "rows": [[]]}),
    ("table ragged", "table", {"header": True, "rows": [["a", "b"], ["c"]]}),
    ("table int cell", "table", {"header": True, "rows": [[1]]}),
    ("table bool cell", "table", {"header": True, "rows": [[True]]}),
    ("table null cell", "table", {"header": True, "rows": [[None]]}),
    ("table header int", "table", {"header": 1, "rows": [["a"]]}),
    ("table header missing", "table", {"rows": [["a"]]}),
    ("table extra key", "table", {"header": True, "rows": [["a"]], "cols": 1}),
    ("table not object", "table", [["a"]]),
    ("table newline", "table", {"header": True, "rows": [["a\nb"]]}),
    ("table tab", "table", {"header": True, "rows": [["a\tb"]]}),
    ("table NEL", "table", {"header": True, "rows": [["a\u0085b"]]}),
    ("table LS", "table", {"header": True, "rows": [["a b"]]}),
    ("table cell 200", "table", {"header": True, "rows": [["x" * 200]]}),
    ("table cell 201", "table", {"header": True, "rows": [["x" * 201]]}),
    ("table astral 100", "table", {"header": True, "rows": [["\U0001F600" * 100]]}),
    ("table astral 101", "table", {"header": True, "rows": [["\U0001F600" * 101]]}),
    ("table lone surrogate", "table", {"header": True, "rows": [["a\ud800"]]}),
    ("table html is text", "table", {"header": True, "rows": [["<b>x</b>&amp;"]]}),
    ("table over 16 KiB", "table", {"header": True, "rows": [["é" * 100] * 10 for _ in range(20)]}),
    ("callout ok", "callout", {"kind": "warning", "title": "Chaud", "body": "l1\n\nl2"}),
    ("callout empty", "callout", {"kind": "note", "title": "", "body": ""}),
    ("callout bad kind", "callout", {"kind": "danger", "title": "", "body": ""}),
    ("callout kind int", "callout", {"kind": 1, "title": "", "body": ""}),
    ("callout title 120", "callout", {"kind": "info", "title": "t" * 120, "body": ""}),
    ("callout title 121", "callout", {"kind": "info", "title": "t" * 121, "body": ""}),
    ("callout title newline", "callout", {"kind": "info", "title": "a\nb", "body": ""}),
    ("callout body 2000", "callout", {"kind": "info", "title": "", "body": "x" * 2000}),
    ("callout body 2001", "callout", {"kind": "info", "title": "", "body": "x" * 2001}),
    ("callout 20 lines", "callout", {"kind": "info", "title": "", "body": "\n".join(["l"] * 20)}),
    ("callout 21 lines", "callout", {"kind": "info", "title": "", "body": "\n".join(["l"] * 21)}),
    ("callout CR", "callout", {"kind": "info", "title": "", "body": "a\rb"}),
    ("callout tab", "callout", {"kind": "info", "title": "", "body": "a\tb"}),
    ("callout extra key", "callout", {"kind": "info", "title": "", "body": "", "color": "red"}),
    ("callout missing key", "callout", {"kind": "info", "title": ""}),
    ("toggle ok", "toggle", {"summary": "Détails", "body": "a\n\nb"}),
    ("toggle empty body", "toggle", {"summary": "s", "body": ""}),
    ("toggle empty summary", "toggle", {"summary": "", "body": ""}),
    ("toggle summary 160", "toggle", {"summary": "s" * 160, "body": ""}),
    ("toggle summary 161", "toggle", {"summary": "s" * 161, "body": ""}),
    ("toggle summary newline", "toggle", {"summary": "a\nb", "body": ""}),
    ("toggle 50 lines", "toggle", {"summary": "s", "body": "\n".join(["l"] * 50)}),
    ("toggle 51 lines", "toggle", {"summary": "s", "body": "\n".join(["l"] * 51)}),
    ("toggle body 4001", "toggle", {"summary": "s", "body": "x" * 4001}),
    ("toggle children", "toggle", {"summary": "s", "body": "", "children": []}),
    ("group two", "imagegroup", {"layout": "two", "items": [A, B]}),
    ("group three", "imagegroup", {"layout": "three", "items": [A, B, C]}),
    ("group compare", "imagegroup", {"layout": "compare", "items": [B, C]}),
    ("group one child", "imagegroup", {"layout": "two", "items": [A]}),
    ("group two for three", "imagegroup", {"layout": "three", "items": [A, B]}),
    ("group three for two", "imagegroup", {"layout": "two", "items": [A, B, C]}),
    ("group compare of three", "imagegroup", {"layout": "compare", "items": [A, B, C]}),
    ("group bad layout", "imagegroup", {"layout": "grid", "items": [A, B]}),
    ("group duplicate", "imagegroup", {"layout": "two", "items": [A, A]}),
    ("group width key", "imagegroup", {"layout": "two", "items": [{**A, "width": 50}, B]}),
    ("group layout key", "imagegroup", {"layout": "two", "items": [{**A, "layout": "right"}, B]}),
    ("group missing caption", "imagegroup", {"layout": "two", "items": [{k: v for k, v in A.items() if k != "caption"}, B]}),
    ("group caption 300", "imagegroup", {"layout": "two", "items": [{**A, "caption": "c" * 300}, B]}),
    ("group caption 301", "imagegroup", {"layout": "two", "items": [{**A, "caption": "c" * 301}, B]}),
    ("group caption newline", "imagegroup", {"layout": "two", "items": [{**A, "caption": "a\nb"}, B]}),
    ("group bad id", "imagegroup", {"layout": "two", "items": [{**A, "id": "asset-../x"}, B]}),
    ("group bad mime", "imagegroup", {"layout": "two", "items": [{**A, "mime": "image/gif"}, B]}),
    ("group zero width px", "imagegroup", {"layout": "two", "items": [{**A, "w": 0}, B]}),
    ("group huge px", "imagegroup", {"layout": "two", "items": [{**A, "w": 2561}, B]}),
    ("group bool dim", "imagegroup", {"layout": "two", "items": [{**A, "w": True}, B]}),
    ("group extra key", "imagegroup", {"layout": "two", "items": [A, B], "extra": 1}),
    ("drawing ok", "drawing", {"id": "Plan-A_HQWeb-Mobile"}),
    ("drawing plain stem", "drawing", {"id": "Croquis1"}),
    ("drawing 120", "drawing", {"id": "a" * 120}),
    ("drawing 121", "drawing", {"id": "a" * 121}),
    ("drawing empty", "drawing", {"id": ""}),
    ("drawing leading dash", "drawing", {"id": "-x"}),
    ("drawing slash", "drawing", {"id": "../x"}),
    ("drawing dot", "drawing", {"id": "a.hqdraw"}),
    ("drawing space", "drawing", {"id": "a b"}),
    ("drawing int id", "drawing", {"id": 1}),
    ("drawing extra key", "drawing", {"id": "ok", "url": "/api/x"}),
    ("drawing thumb key", "drawing", {"id": "ok", "png": "data:x"}),
    ("drawing missing id", "drawing", {}),
    ("drawing not object", "drawing", "ok"),
]


def verdict(kind: str, payload):
    try:
        return rich.check_struct(kind, json.loads(json.dumps(payload)))
    except rich.ContentError:
        return None


def build() -> dict:
    out = {"payload": [], "render": [], "search": []}
    for name, kind, payload in CASES:
        out["payload"].append({"name": name, "type": kind, "in": payload, "out": verdict(kind, payload)})
    renders = [
        ("all four", [
            ("table", {"header": True, "rows": [["Nom", "Val|x"], ["a", "1"]]}),
            ("table", {"header": False, "rows": [["A", "B"], ["C", "D"]]}),
            ("callout", {"kind": "warning", "title": "Chaud", "body": "ligne1\n\nligne2"}),
            ("callout", {"kind": "note", "title": "", "body": "seul"}),
            ("toggle", {"summary": "Détails", "body": "un\ndeux"}),
            ("imagegroup", {"layout": "compare", "items": [B, C]}),
            ("imagegroup", {"layout": "three", "items": [A, B, C]}),
        ]),
        ("markdown specials", [
            ("table", {"header": True, "rows": [["<script>x</script>", "*b*"], ["a|b", "`c`"]]}),
            ("callout", {"kind": "info", "title": "<b>", "body": "[l](http://x)\n- item\n# h\n> q"}),
            ("toggle", {"summary": "<i>", "body": "`c`\n1. n\n| p"}),
        ]),
        ("drawings", [
            ("drawing", {"id": "Plan-A_HQWeb-Mobile"}),
            ("drawing", {"id": "Cote_HQWeb"}),
            ("drawing", {"id": "Croquis_2"}),
            ("table", {"header": True, "rows": [["a", "b"]]}),
        ]),
    ]
    for name, blocks in renders:
        content = {"version": 2, "blocks": [{"id": f"block-{i}", "type": k, "text": "", "marks": [], rich.STRUCT_KEY[k]: verdict(k, p)} for i, (k, p) in enumerate(blocks)]}
        out["render"].append({
            "name": name, "blocks": [{"type": k, "payload": verdict(k, p)} for k, p in blocks], "paths": PATHS,
            "txt": rich.render_txt(content), "md": rich.render_markdown(content, PATHS), "md_nopaths": rich.render_markdown(content, None),
            "search": rich.search_text(content),
            "search_struct": "\n".join(x for b in content["blocks"] for x in rich.structured_strings(b)),
            "bytes": rich.structured_bytes(content),
        })
    out["underlay"] = []
    for units in ("mm", "cm", "m", "in", "km", "", None):
        for w, h in ((100, 100), (4, 3), (3, 4), (2560, 1920), (1, 2560), (1, 1), (0, 5), (5, -1), (True, 5)):
            try:
                r = dr.underlay_rect(units, w, h)
            except dr.DrawingError:
                r = None
            out["underlay"].append({"units": units, "w": w, "h": h, "rect": r})
    out["underlay_check"] = []
    good = {"asset_id": "asset-" + "a" * 24, "fit": "contain"}
    for name, val, ver in (
        ("ok v3", good, 3), ("v2 refuses", good, 2), ("fit cover", {**good, "fit": "cover"}, 3), ("extra key", {**good, "x": 0}, 3),
        ("short id", {"asset_id": "asset-abc", "fit": "contain"}, 3), ("upper hex", {"asset_id": "asset-" + "A" * 24, "fit": "contain"}, 3),
        ("not object", "asset", 3), ("missing fit", {"asset_id": good["asset_id"]}, 3),
    ):
        try:
            res = dr.check_underlay(val, ver)
        except dr.DrawingError:
            res = None
        out["underlay_check"].append({"name": name, "value": val, "version": ver, "out": res})
    return out


if __name__ == "__main__":
    (HERE / "fixtures_carnet_structured.json").write_text(json.dumps(build(), ensure_ascii=True, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print("written", len(CASES), "payload vectors")
