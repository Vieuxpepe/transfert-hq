"""perf15: dangling member renderCurve row-hoist (static checks; equivalence verified by node harness)."""
import re
from pathlib import Path

JS = Path(__file__).resolve().parents[1] / "assets" / "hq-dangling-member.js"


def _render_curve():
    src = JS.read_text(encoding="utf-8")
    start = src.index("function renderCurve()")
    return src[start:src.index("function paintGlisten(", start)]


def test_bulge_hoisted_out_of_pixel_loop():
    body = _render_curve()
    inner = body[body.index("for (let u = left; u <= right; u += 1)"):]
    inner = inner[: inner.index("deposit(")]
    assert "throbBump(" not in inner
    assert "oralBulgeScale(" not in inner
    assert "Math.sin" not in inner


def test_bulge_expression_unchanged():
    body = _render_curve()
    assert "throbBump(along) * 0.18 * (0.62 + 0.38 * Math.sin(along * Math.PI))" in body
    assert "jiggle * Math.sin(jigglePhase * 1.15) * 0.07 * Math.sin(along * Math.PI)" in body
    assert "const bulge = bulgeBase * oralBulgeScale(t);" in body
    assert "const ox = (u - halfCw + 0.5) * bulge;" in body


def test_unified_paint_scheduler():
    src = JS.read_text(encoding="utf-8")
    assert "function danglePaintLoop(" in src and "function tick(" in src
    assert "const GLISTEN_IDLE_MS = 60;" in src
    assert "const VEIN_IDLE_MS = 80;" in src
    assert "if (hot && ensureVeinSwellField()) warpVeinOverlay" in src
    assert "veinRenderHot() || !veinSwellBaked" in src
    assert "function paintVeinPulseCold(" in src
    assert "function strokeVeinPulseMaroon(" in src
    assert "function scheduleDanglePaint(" in src
    hot_merge = src[src.index("function paintVeinPulse(") : src.index("function paintVeinHighlight(")]
    assert "getImageData(0, 0, bufW, bufH)" in hot_merge
    assert "paintVeinPulseCold" in hot_merge
