"""Run a Chromium-only Forge visual test under Playwright WebKit, unchanged.

python tests/run_forge_visual_webkit.py tests/visual_forge_presets_playwright.py

The wrapper swaps playwright.chromium for playwright.webkit before the test
module imports sync_playwright. WebKit here is Playwright's build, not Safari.
"""

from __future__ import annotations

import runpy
import sys

import playwright.sync_api as api

_original = api.sync_playwright


class _Proxy:
    def __init__(self, inner):
        self._inner = inner

    def __getattr__(self, name):
        return self._inner.webkit if name == "chromium" else getattr(self._inner, name)


class _Wrapped:
    def __init__(self):
        self._cm = _original()

    def __enter__(self):
        return _Proxy(self._cm.__enter__())

    def __exit__(self, *exc):
        return self._cm.__exit__(*exc)


api.sync_playwright = _Wrapped


# WebKit applies HQ's CSP (no unsafe-eval) to Playwright's wait_for_function
# predicate even with bypass_csp. Poll with page.evaluate instead, which the
# CSP does not block. Test harness only; the served policy is unchanged.
def _wait_for_function(self, expression, *, arg=None, timeout=None, polling=None):
    import time

    deadline = time.monotonic() + (30000 if timeout is None else timeout) / 1000
    while True:
        value = self.evaluate(expression, arg)
        if value:
            return value
        if time.monotonic() > deadline:
            raise api.TimeoutError("wait_for_function (polled) timed out: " + str(expression)[:120])
        time.sleep(0.1)


api.Page.wait_for_function = _wait_for_function
if __name__ == "__main__":
    target = sys.argv[1]
    sys.argv = [target] + sys.argv[2:]
    runpy.run_path(target, run_name="__main__")
