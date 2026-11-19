"""Headless layout probe for tests/check_hq_sketch_layout.mjs.

The Node guard builds a valid populated document, sends it on stdin, and asserts the
JSON measured here. This file starts a throwaway HQ (never the live bridge), seeds the
draft, and reads real DOM rectangles at the widths named in the guard.

Run only through the guard:
    node tests/check_hq_sketch_layout.mjs
"""
from __future__ import annotations

import json
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SERVER = HERE / "carnet_test_server.py"
DRAFT_KEY = "tf_hq_sketch_draft_v1"
MEASURE = """() => {
  const rect = e => {
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, top: b.top, right: b.right };
  };
  const box = (root, selector) => rect(root.querySelector(selector));
  const bar = document.querySelector('.sk-bar');
  const seg = document.querySelector('.sk-seg');
  const acts = document.querySelector('.sk-acts');
  const buttons = [...document.querySelectorAll('.sk-acts .sk-btn')];
  const byTop = new Map();
  for (const button of buttons) {
    const top = Math.round(button.getBoundingClientRect().top);
    byTop.set(top, (byTop.get(top) || 0) + 1);
  }
  const params = [...document.querySelectorAll('.sk-param')].map(row => ({
    row: rect(row),
    name: box(row, '.sk-param-name'),
    val: box(row, '.sk-param-val'),
    expr: box(row, '.sk-param-expr'),
    del: box(row, '.sk-param-del'),
  }));
  const sketches = [...document.querySelectorAll('.sk-sk-row')].map(row => ({
    row: rect(row),
    name: box(row, '.sk-sk-name'),
    primary: [...row.querySelectorAll('[data-sk-act="use"], [data-sk-act="hide"], [data-sk-act="lock"], [data-sk-act="rename"]')].map(rect),
    up: box(row, '[data-sk-act="up"]'),
    down: box(row, '[data-sk-act="down"]'),
    del: box(row, '[data-sk-act="del"]'),
  }));
  return {
    win: innerWidth,
    docW: document.documentElement.scrollWidth,
    bar: rect(bar),
    seg: rect(seg),
    acts: rect(acts),
    sameRow: !!(seg && acts) && Math.abs(seg.getBoundingClientRect().top - acts.getBoundingClientRect().top) < 3,
    actionRows: [...byTop.values()],
    dirtyChip: [...document.querySelectorAll('.sk-dirty-chip')].some(e => !e.hidden),
    params,
    sketches,
  };
}"""


def start_server() -> tuple[Path, subprocess.Popen, dict]:
    root = Path(tempfile.mkdtemp(prefix="hq-sketch-layout-"))
    proc = subprocess.Popen(
        [sys.executable, str(SERVER), str(root)],
        stdin=subprocess.PIPE,  # carnet_test_server serves until stdin closes
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    lines: queue.Queue[str] = queue.Queue()

    def read() -> None:
        if proc.stdout is None:
            return
        for line in proc.stdout:
            lines.put(line)

    threading.Thread(target=read, daemon=True).start()
    seen: list[str] = []
    deadline = time.time() + 45
    while time.time() < deadline:
        try:
            line = lines.get(timeout=0.5)
        except queue.Empty:
            if proc.poll() is not None:
                raise RuntimeError("throwaway server exited: " + "".join(seen)[-2000:])
            continue
        seen.append(line)
        if '{"base"' in line:
            return root, proc, json.loads(line[line.index('{"base"'):])
    proc.kill()
    raise RuntimeError("throwaway server did not become ready: " + "".join(seen)[-2000:])


def stop_server(root: Path, proc: subprocess.Popen) -> None:
    try:
        proc.kill()
        proc.wait(timeout=10)
    except OSError:
        pass
    shutil.rmtree(root, ignore_errors=True)


def login(page, base: str, pin: str) -> None:
    page.goto(base + "/", wait_until="domcontentloaded")
    field = page.locator('input[name="pin"]')
    if field.count():
        field.fill(pin)
        page.click('button[type="submit"]')
    page.wait_for_selector("#btn-timemachine", timeout=25000)


def measure(page, width: int) -> dict:
    page.set_viewport_size({"width": width, "height": 900})
    page.wait_for_timeout(450)
    return page.evaluate(MEASURE)


def main() -> None:
    try:
        doc = json.loads(sys.stdin.read())
    except Exception as exc:
        raise SystemExit(f"invalid document on stdin: {exc}") from exc
    root, server, info = start_server()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            try:
                page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
                login(page, info["base"], info["admin_pin"])
                page.evaluate(
                    """([key, doc]) => localStorage.setItem(key, JSON.stringify({
                      v: 1, at: Date.now(), name: 'layout-guard', stem: '', dirty: true, doc
                    }))""",
                    [DRAFT_KEY, doc],
                )
                page.evaluate("setView('dessiner')")
                page.wait_for_selector(".sk-tool", timeout=20000)
                # The sketch list is part of the v6 construction panel. The guard is about CSS
                # geometry, not about OpenCascade being installed: enable the panel and let the
                # page render the real sketchPanel() markup.
                page.evaluate("""() => { const s = window.hqSketchState(); if (s && s.caps) s.caps.exact = true; }""")
                page.locator('[data-tool="select"]').first.click()
                page.wait_for_timeout(300)
                page.wait_for_selector(".sk-sk-row", timeout=10000)
                page.wait_for_selector(".sk-param", timeout=10000)
                page.wait_for_timeout(900)
                result = {
                    "wide": [measure(page, 1440), measure(page, 1280)],
                    "params640": measure(page, 640),
                    "phone520": measure(page, 520),
                    "phone390": measure(page, 390),
                }
                print(json.dumps(result, ensure_ascii=False), flush=True)
            finally:
                browser.close()
    finally:
        stop_server(root, server)


if __name__ == "__main__":
    main()
