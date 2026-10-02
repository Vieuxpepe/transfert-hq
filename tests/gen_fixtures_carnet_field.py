"""Regenerates tests/fixtures_carnet_field.json from the PYTHON implementation (the source of truth) for the Phase-4 contract:
voice payloads, derived-text provenance, and the TXT / Markdown exports of voice notes and derived runs.

Consumed by test_hq_carnet_voice.py (fails when the fixture drifts from Python) and check_hq_carnet_field.mjs (fails when the
browser core drifts from Python).
    python3 tests/gen_fixtures_carnet_field.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import hq_carnet_rich as rich  # noqa: E402

V1 = "voice-" + "a" * 24
V2 = "voice-" + "b" * 24
A1 = "asset-" + "c" * 24
A2 = "asset-" + "d" * 24
STAMP = "2026-10-02T14:05:09Z"


def voice(**kw):
    base = {"id": V1, "mime": "audio/webm", "dur_ms": 83000, "recorded_at": STAMP}
    base.update(kw)
    return base


VOICE_CASES = [
    ("ok webm", voice()),
    ("ok mp4", voice(mime="audio/mp4")),
    ("ok ogg", voice(mime="audio/ogg")),
    ("ok 1 ms", voice(dur_ms=1)),
    ("ok 10 min", voice(dur_ms=600000)),
    ("zero ms", voice(dur_ms=0)),
    ("over 10 min", voice(dur_ms=600001)),
    ("float ms", voice(dur_ms=1.5)),
    ("bool ms", voice(dur_ms=True)),
    ("string ms", voice(dur_ms="5")),
    ("bad mime", voice(mime="audio/wav")),
    ("mime params", voice(mime="audio/webm;codecs=opus")),
    ("asset id", voice(id=A1)),
    ("short id", voice(id="voice-abc")),
    ("upper id", voice(id="voice-" + "A" * 24)),
    ("block id", voice(id="block-000001")),
    ("no stamp tz", voice(recorded_at="2026-10-02T14:05:09")),
    ("stamp millis", voice(recorded_at="2026-10-02T14:05:09.000Z")),
    ("stamp offset", voice(recorded_at="2026-10-02T14:05:09+02:00")),
    ("stamp bad month", voice(recorded_at="2026-13-02T14:05:09Z")),
    ("stamp feb 30", voice(recorded_at="2026-02-30T14:05:09Z")),
    ("stamp hour 24", voice(recorded_at="2026-10-02T24:05:09Z")),
    ("stamp year 1999", voice(recorded_at="1999-10-02T14:05:09Z")),
    ("extra key", {**voice(), "path": "x"}),
    ("missing key", {k: v for k, v in voice().items() if k != "recorded_at"}),
    ("not object", [V1]),
]

FROM_CASES = [
    ("ocr asset", {"kind": "ocr", "source_kind": "asset", "source_id": A1}),
    ("transcript voice", {"kind": "transcript", "source_kind": "voice", "source_id": V1}),
    ("ocr voice", {"kind": "ocr", "source_kind": "voice", "source_id": V1}),
    ("transcript asset", {"kind": "transcript", "source_kind": "asset", "source_id": A1}),
    ("unknown kind", {"kind": "ai", "source_kind": "asset", "source_id": A1}),
    ("path source", {"kind": "ocr", "source_kind": "asset", "source_id": "/etc/passwd"}),
    ("url source", {"kind": "ocr", "source_kind": "asset", "source_id": "https://x/a.png"}),
    ("extra key", {"kind": "ocr", "source_kind": "asset", "source_id": A1, "confidence": 0.9}),
    ("missing key", {"kind": "ocr", "source_kind": "asset"}),
    ("short id", {"kind": "ocr", "source_kind": "asset", "source_id": "asset-abc"}),
    ("not object", "ocr"),
]


def ok(fn, v):
    try:
        return fn(v)
    except rich.ContentError:
        return None


def para(text, frm=None):
    b = {"type": "paragraph", "text": text, "marks": []}
    if frm:
        b["from"] = frm
    return b


def vblock(**kw):
    return {"type": "voice", "text": "", "marks": [], "voice": voice(**kw)}


O1 = {"kind": "ocr", "source_kind": "asset", "source_id": A1}
O2 = {"kind": "ocr", "source_kind": "asset", "source_id": A2}
T1 = {"kind": "transcript", "source_kind": "voice", "source_id": V1}
RENDERS = [
    ("voice only", [vblock()]),
    ("voice rounding", [vblock(dur_ms=499), vblock(dur_ms=500), vblock(dur_ms=1499), vblock(dur_ms=1500), vblock(dur_ms=59500), vblock(dur_ms=600000)]),
    ("ocr run", [para("avant"), para("Un", O1), para("Deux", O1), para("après")]),
    ("two ocr runs", [para("Un", O1), para("Deux", O2), para("Trois", O2)]),
    ("transcript after voice", [vblock(), para("Dicté", T1), para("Suite", T1)]),
    ("mixed", [para("x"), para("A", O1), para("B", T1), para("C", O1), vblock(dur_ms=7000), para("fin")]),
    ("markdown specials", [para("# titre *gras* <b>", O1), para("- liste | pipe", O1)]),
]


def build() -> dict:
    out: dict = {"voice": [], "from": [], "render": []}
    for name, v in VOICE_CASES:
        out["voice"].append({"name": name, "in": v, "out": ok(rich.check_voice, v)})
    for name, f in FROM_CASES:
        out["from"].append({"name": name, "in": f, "out": ok(rich.check_from, f)})
    for name, blocks in RENDERS:
        content = {"version": 2, "blocks": [dict(b, id=f"block-{i:06x}") for i, b in enumerate(blocks)]}
        out["render"].append({
            "name": name, "blocks": blocks, "txt": rich.render_txt(content), "md": rich.render_markdown(content, None),
        })
    return out


if __name__ == "__main__":
    (HERE / "fixtures_carnet_field.json").write_text(json.dumps(build(), ensure_ascii=True, indent=1, sort_keys=True) + "\n", encoding="utf-8")
