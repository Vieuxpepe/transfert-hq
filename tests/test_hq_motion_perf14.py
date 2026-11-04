"""Static checks for the motion1 companion optimizations (perf14)."""
import pathlib, re, shutil, subprocess, unittest

ASSETS = pathlib.Path(__file__).resolve().parent.parent / "assets"
JS = (ASSETS / "hq-companion.js").read_text(encoding="utf-8")
CSS = (ASSETS / "hq-companion.css").read_text(encoding="utf-8")
ADULT = (ASSETS / "hq-companion-adult-fx.css").read_text(encoding="utf-8")


def _strip(css):
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def _keyframes(css, name):
    m = re.search(r"@keyframes\s+" + re.escape(name) + r"\s*\{", css)
    assert m, name
    i, depth = m.end(), 1
    while depth:
        depth += {"{": 1, "}": -1}.get(css[i], 0)
        i += 1
    return css[m.end():i]


class MotionPerf14(unittest.TestCase):
    def test_timer_guards(self):
        self.assertIn("const tick = () => { if (!win.document.hidden) syncCompanionAttention(win); };", JS)
        self.assertIn("if (!win.document.hidden) syncCompanionFrame(win); }, 1000)", JS)
        self.assertIn("if (!win.document.hidden) syncMusicGroove(); }, 2800)", JS)
        self.assertRegex(JS, r"async function pulse\(win\) \{\s*if \(win\.document\.hidden")

    def test_pause_toggle(self):
        self.assertIn('S.el.classList.toggle("is-anim-paused", off)', JS)
        self.assertIn('win.document.addEventListener("visibilitychange", syncAnimPause)', JS)
        self.assertIn('classList.contains("hq-ai-open") || S.el.hidden', JS)
        self.assertRegex(CSS, r"\.hq-companion\.is-anim-paused \*::after\{animation-play-state:paused!important\}")

    def test_reduced_motion_blocks(self):
        for css in (CSS, ADULT):
            self.assertRegex(css, r"@media \(prefers-reduced-motion:reduce\)\{\s*[^{}]*\.hq-companion \*::after\{animation-iteration-count:1!important\}")

    def test_compositor_only_keyframes(self):
        for name in ("hq-companion-warm-rim", "hq-companion-shim", "hq-companion-breathe", "hq-companion-idle-breathe"):
            body = _keyframes(_strip(CSS), name)
            self.assertNotIn("filter", body, name)
            self.assertNotIn("box-shadow", body, name)

    def test_css_braces_balanced(self):
        for css in (CSS, ADULT):
            s = _strip(css)
            self.assertEqual(s.count("{"), s.count("}"))

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_js_parses(self):
        r = subprocess.run(["node", "--check", str(ASSETS / "hq-companion.js")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main()
