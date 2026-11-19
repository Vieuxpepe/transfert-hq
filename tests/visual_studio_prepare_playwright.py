"""Playwright Chromium end-to-end verification & performance benchmarks for Atelier 3D Phase 3.

Runs against an isolated local HTTP server serving real assets/* and synthetic STL fixtures.
Never touches live Bridge state, settings, or physical printers (any printer/start fails the test).
"""
from __future__ import annotations

import hashlib
import http.server
import json
import os
import socketserver
import struct
import tempfile
import threading
import time
import unittest
import zlib
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

import hq_print3d_projects as hq_projects

REPO = Path(__file__).resolve().parents[1]


def _make_wedge_stl(dx: float = 40.0) -> bytes:
    """Asymmetric wedge binary STL: X [0..dx], Y [0..20], Z [0..15] (8 triangles)."""
    v = [
        (0, 0, 0), (dx, 0, 0), (dx, 20, 0), (0, 20, 0),
        (0, 0, 15), (0, 20, 15),
    ]
    tris = [
        (v[0], v[2], v[1]), (v[0], v[3], v[2]),  # bottom Z=0
        (v[0], v[1], v[4]),                      # front
        (v[3], v[5], v[2]),                      # back
        (v[0], v[4], v[3]), (v[3], v[4], v[5]),  # left X=0
        (v[1], v[2], v[4]), (v[2], v[5], v[4]),  # sloped hypotenuse
    ]
    buf = bytearray(84 + len(tris) * 50)
    buf[:80] = b"Atelier3D Phase3 Wedge Fixture".ljust(80, b" ")
    struct.pack_into("<I", buf, 80, len(tris))
    off = 84
    for p0, p1, p2 in tris:
        struct.pack_into("<12fH", buf, off, 0, 0, 0,
                         p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], 0)
        off += 50
    return bytes(buf)


def _make_benchmark_stl(n_tri: int) -> bytes:
    rec = struct.pack("<12fH", 0, 0, 1, 0, 0, 0, 25, 0, 0, 0, 25, 18, 0)
    return b"Phase3 Benchmark".ljust(80, b" ") + struct.pack("<I", n_tri) + (rec * n_tri)


def _png_non_bg_samples(png_bytes: bytes) -> int:
    """Decode an 8-bit non-interlaced PNG using stdlib zlib and count non-background pixels."""
    if not png_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return 0
    pos = 8
    w = h = color_type = 0
    idat = bytearray()
    while pos + 8 <= len(png_bytes):
        length = struct.unpack(">I", png_bytes[pos:pos + 4])[0]
        ctype = png_bytes[pos + 4:pos + 8]
        chunk = png_bytes[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            w, h, _bd, color_type = struct.unpack(">IIBB", chunk[:10])
        elif ctype == b"IDAT":
            idat.extend(chunk)
        elif ctype == b"IEND":
            break
    if not (w and h) or color_type not in (2, 6):
        return 0
    bpp = 4 if color_type == 6 else 3
    stride = w * bpp
    raw = zlib.decompress(bytes(idat))
    prev = bytearray(stride)
    non_bg = 0
    r0 = g0 = b0 = None
    idx = 0
    for _y in range(h):
        ftype = raw[idx]
        idx += 1
        row = bytearray(raw[idx:idx + stride])
        idx += stride
        if ftype == 1:
            for i in range(bpp, stride):
                row[i] = (row[i] + row[i - bpp]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                row[i] = (row[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = row[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                a = row[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                row[i] = (row[i] + pr) & 0xFF
        if r0 is None:
            r0, g0, b0 = row[0], row[1], row[2]
        for x in range(0, stride, bpp * 2):
            if abs(row[x] - r0) + abs(row[x + 1] - g0) + abs(row[x + 2] - b0) > 18:
                non_bg += 1
        prev = row
    return non_bg


class _SandboxState:
    def __init__(self, state_dir: Path | None = None) -> None:
        self.wedge_bytes = _make_wedge_stl(40.0)
        self.wedge_bounds = [40, 20, 15]
        self.bench_cache: dict[str, bytes] = {
            "m_10k": _make_benchmark_stl(10000),
            "m_100k": _make_benchmark_stl(100000),
            "m_300k": _make_benchmark_stl(300000),
        }
        self.file_requests: list[str] = []
        self.slice_payloads: list[dict] = []
        self.hardware_calls: list[str] = []
        self.state_dir = state_dir


def _start_server(state: _SandboxState):
    assets_dir = REPO / "assets"

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            return

        def _send(self, status: int, ctype: str, data: bytes, extra_headers: dict[str, str] | None = None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "private, no-store")
            if extra_headers:
                for hk, hv in extra_headers.items():
                    self.send_header(hk, hv)
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            u = urlparse(self.path)
            path = u.path
            qs = parse_qs(u.query)
            if path == "/" or path == "/harness.html":
                html = (
                    "<!DOCTYPE html><html><head><meta charset='utf-8'>"
                    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                    "<link rel='stylesheet' href='/assets/hq-print3d.css'>"
                    "<style>body{margin:0;padding:12px;background:#0d1017;color:#e5e7eb;font-family:system-ui,sans-serif}</style>"
                    "</head><body><div id='host'></div>"
                    "<script src='/assets/hq-model-view.js'></script>"
                    "<script src='/assets/hq-gcode-view.js'></script>"
                    "<script src='/assets/hq-print3d-prepare.js'></script>"
                    "<script src='/assets/hq-print3d.js'></script>"
                    "<script>"
                    "window.toast = function(){};"
                    "window.api = function(url, opts){"
                    "  opts = opts || {};"
                    "  return fetch(url, opts).then(function(r){ return r.json().then(function(j){ if(!r.ok){ var e = new Error(j.error||'HTTP '+r.status); e.status = r.status; e.code = j.code || ''; throw e; } return j; }); });"
                    "};"
                    "</script></body></html>"
                ).encode("utf-8")
                self._send(200, "text/html; charset=utf-8", html)
                return
            if path.startswith("/assets/"):
                rel = path[len("/assets/"):]
                fpath = (assets_dir / rel).resolve()
                if assets_dir not in fpath.parents or not fpath.is_file():
                    self._send(404, "text/plain", b"not found")
                    return
                ctype = "application/javascript; charset=utf-8" if rel.endswith((".js", ".mjs")) else (
                    "text/css; charset=utf-8" if rel.endswith(".css") else "application/octet-stream"
                )
                self._send(200, ctype, fpath.read_bytes())
                return
            if path == "/api/print3d/state":
                payload = {
                    "printers": [{"id": "p1", "name": "A1 Atelier", "kind": "bambu", "model": "A1", "ip": "127.0.0.1", "state": "idle"}],
                    "config": {
                        "printers": [{"id": "p1", "name": "A1 Atelier", "kind": "bambu", "model": "A1", "ip": "127.0.0.1",
                                      "capabilities": {"model": "A1", "bed": {"x": 256, "y": 256, "z": 256},
                                                       "origin": {"x": 0, "y": 0}, "nozzles": ["0.4"], "default_nozzle": "0.4",
                                                       "physical_extruders": 1, "max_tools": 4}}],
                        "makerworld": {},
                        "filament": {"currency": "$", "default_price_kg": 25},
                    },
                    "history": [],
                }
                self._send(200, "application/json", json.dumps(payload).encode("utf-8"))
                return
            if path == "/api/print3d/jobs":
                self._send(200, "application/json", b'{"jobs":[],"stats":{"total":0}}')
                return
            if path == "/api/print3d/models":
                w_sha = hashlib.sha256(state.wedge_bytes).hexdigest()
                rows = [
                    {"id": "m_wedge", "name": "wedge.stl", "ext": "stl", "size": len(state.wedge_bytes),
                     "source_sha256": w_sha, "version": w_sha, "bounds_mm": state.wedge_bounds},
                    {"id": "m_10k", "name": "bench_10k.stl", "ext": "stl", "size": len(state.bench_cache["m_10k"])},
                    {"id": "m_100k", "name": "bench_100k.stl", "ext": "stl", "size": len(state.bench_cache["m_100k"])},
                    {"id": "m_300k", "name": "bench_300k.stl", "ext": "stl", "size": len(state.bench_cache["m_300k"])},
                ]
                self._send(200, "application/json", json.dumps({"models": rows, "tags": [], "total": len(rows), "indexed": len(rows)}).encode("utf-8"))
                return
            if path == "/api/print3d/models/file":
                mid = (qs.get("id") or [""])[0]
                state.file_requests.append(mid)
                if mid == "m_wedge":
                    w_sha = hashlib.sha256(state.wedge_bytes).hexdigest()
                    self._send(200, "application/octet-stream", state.wedge_bytes, {"X-Model-Sha256": w_sha, "ETag": f'"{w_sha}"'})
                    return
                if mid in state.bench_cache:
                    b_sha = hashlib.sha256(state.bench_cache[mid]).hexdigest()
                    self._send(200, "application/octet-stream", state.bench_cache[mid], {"X-Model-Sha256": b_sha, "ETag": f'"{b_sha}"'})
                    return
                if mid == "m_sliced":
                    self._send(200, "text/plain", b"; sliced gcode mock\nG90\nG1 X10 Y10 Z0.2\nG1 X40 Y10 E1.2\n")
                    return
                self._send(404, "application/json", b'{"error":"not found"}')
                return
            if path == "/api/print3d/models/layers":
                self._send(200, "application/json", json.dumps({
                    "layers": [{"z": 0.2, "paths": [{"t": "outer", "e": 0, "pts": [[100, 100], [140, 100], [140, 140], [100, 140]]}]}],
                    "bounds": [0, 0, 256, 256],
                }).encode("utf-8"))
                return
            if path == "/api/print3d/models/inspect":
                self._send(200, "application/json", json.dumps({
                    "info": {"kind": "gcode", "printer_model": "A1", "plates": [1], "filaments": [{"id": 1, "type": "PLA"}]}
                }).encode("utf-8"))
                return
            if path == "/api/print3d/studio/loaded_materials":
                self._send(200, "application/json", json.dumps({
                    "ok": True, "available": True, "reason": "live_status",
                    "slots": [
                        {"slot": 1, "material": "PLA", "colour": "#38BDF8", "loaded": True},
                        {"slot": 2, "material": "PETG", "colour": "#10B981", "loaded": True},
                    ],
                }).encode("utf-8"))
                return
            if path == "/api/print3d/projects" and state.state_dir:
                self._send(200, "application/json", json.dumps({"ok": True, "projects": hq_projects.list_projects(state.state_dir)}).encode("utf-8"))
                return
            if path == "/api/print3d/projects/get" and state.state_dir:
                pid = (qs.get("id") or [""])[0]
                res = hq_projects.open_project(state.state_dir, pid, None)
                # Resolve source model bounds & SHA inline from sandbox wedge state
                w_sha = hashlib.sha256(state.wedge_bytes).hexdigest()
                for it in res["project"].get("items") or []:
                    if it.get("model_id") == "m_wedge":
                        it["source_status"] = "replaced" if (it.get("source_sha256") and it["source_sha256"] != w_sha) else "ok"
                        it["current_sha256"] = w_sha
                        it["current_bounds_mm"] = state.wedge_bounds
                self._send(200, "application/json", json.dumps(res).encode("utf-8"))
                return
            self._send(404, "application/json", b'{"error":"unknown route"}')

        def do_POST(self):
            ln = int(self.headers.get("Content-Length") or "0")
            body = self.rfile.read(ln) if ln > 0 else b"{}"
            if self.path.startswith("/api/print3d/printer/"):
                state.hardware_calls.append(self.path)
                self._send(500, "application/json", b'{"error":"forbidden in test"}')
                return
            if self.path == "/api/print3d/projects/save" and state.state_dir:
                prj = hq_projects.save_project(state.state_dir, json.loads(body.decode("utf-8")))
                self._send(200, "application/json", json.dumps({"ok": True, "project": prj}).encode("utf-8"))
                return
            if self.path == "/api/print3d/projects/duplicate" and state.state_dir:
                prj = hq_projects.duplicate_project(state.state_dir, str(json.loads(body.decode("utf-8")).get("id") or ""))
                self._send(200, "application/json", json.dumps({"ok": True, "project": prj}).encode("utf-8"))
                return
            if self.path == "/api/print3d/studio/slice":
                state.slice_payloads.append(json.loads(body.decode("utf-8")))
                self._send(200, "application/json", json.dumps({
                    "ok": True,
                    "model": {"id": "m_sliced", "name": "wedge_studio_mock.gcode.3mf", "ext": "3mf", "slice_settings": {"infill": 15}},
                    "info": {"kind": "gcode", "printer_model": "A1", "plates": [1], "filaments": [{"id": 1, "type": "PLA"}]},
                }).encode("utf-8"))
                return
            self._send(404, "application/json", b'{"error":"unknown post"}')

    class ReusableTCPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True

    srv = ReusableTCPServer(("127.0.0.1", 0), Handler)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    return srv


class StudioPreparePlaywrightTests(unittest.TestCase):
    def test_phase3_desktop_mobile_e2e_and_benchmarks(self) -> None:
        state = _SandboxState()
        srv = _start_server(state)
        base_url = f"http://127.0.0.1:{srv.server_port}/harness.html"
        results: dict = {"viewports": {}, "benchmarks": {}, "scenarios": {}}
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(
                    headless=True,
                    args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"],
                )
                try:
                    # 1. Desktop 1440x900 full 12-scenario walkthrough
                    page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
                    page.goto(base_url, wait_until="networkidle")
                    page.evaluate("""() => {
                        window._longTasks = [];
                        if (typeof PerformanceObserver === 'function') {
                            try {
                                new PerformanceObserver((list) => {
                                    for (const e of list.getEntries()) window._longTasks.push(Math.round(e.duration));
                                }).observe({ entryTypes: ['longtask'] });
                            } catch (_) {}
                        }
                        window.HqPrint3d.show(document.getElementById('host'), window.api, 'studio');
                    }""")
                    page.wait_for_selector(".p3d-studio-cvs")
                    page.wait_for_timeout(150)

                    # Scenario 1: Load wedge STL & verify real WebGL mesh + pixels
                    page.get_by_role("button", name="+ Ajouter").click()
                    page.wait_for_selector(".p3d-studio-pick button")
                    page.locator(".p3d-studio-pick button", has_text="wedge.stl").click()
                    page.wait_for_function("""() => {
                        const cvs = document.querySelector('.p3d-studio-cvs');
                        const st = window.HqPrint3d._hooks.studio;
                        return st.items.length === 1 && st.items[0].loadState === 'ready' && cvs && cvs.hqPrepareMetrics && cvs.hqPrepareMetrics().drawCount > 0;
                    }""")
                    m0 = page.evaluate("""() => {
                        const cvs = document.querySelector('.p3d-studio-cvs');
                        return Object.assign({ nonZeroCanvas: cvs.width > 0 && cvs.height > 0 }, cvs.hqPrepareMetrics());
                    }""")
                    self.assertTrue(m0["webgl"], f"Expected WebGL active in headless Chromium, got {m0}")
                    self.assertEqual(m0["vboCount"], 1)
                    results["scenarios"]["stl_loaded_webgl"] = m0

                    # Verify idle CPU/GPU = 0 draws over 500ms
                    draws_before_idle = m0["drawCount"]
                    page.wait_for_timeout(550)
                    draws_after_idle = page.evaluate("() => document.querySelector('.p3d-studio-cvs').hqPrepareMetrics().drawCount")
                    self.assertEqual(draws_after_idle, draws_before_idle, "Idle scene must not burn a perpetual rAF loop")
                    results["scenarios"]["idle_extra_draws"] = draws_after_idle - draws_before_idle

                    # Scenario 2: Click empty plate -> deselects; raycast rendered mesh position -> selects
                    box = page.locator(".p3d-studio-cvs").bounding_box()
                    assert box is not None
                    page.mouse.click(box["x"] + 24, box["y"] + 24)  # empty plate top-left corner
                    page.wait_for_timeout(60)
                    self.assertEqual(page.evaluate("() => window.HqPrint3d._hooks.studio.selected"), -1)
                    mesh_pt = page.evaluate("""() => {
                        const cvs = document.querySelector('.p3d-studio-cvs');
                        const it = window.HqPrint3d._hooks.studio.items[0];
                        return cvs.hqPrepareProject([it.x, it.y, (it.z || 0) + (it.dz * it.scale) * 0.3]);
                    }""")
                    assert mesh_pt is not None
                    page.mouse.click(mesh_pt[0], mesh_pt[1])
                    page.wait_for_timeout(60)
                    self.assertEqual(page.evaluate("() => window.HqPrint3d._hooks.studio.selected"), 0)

                    # Scenario 3: Switch to 'Déplacer' mode and drag mesh across canvas
                    page.locator(".p3d-studio-cam-bar button", has_text="Déplacer").click()
                    x_before = page.evaluate("() => window.HqPrint3d._hooks.studio.items[0].x")
                    past_before = page.evaluate("() => window.HqPrint3d._hooks.studio.history.past.length")
                    cx, cy = mesh_pt[0], mesh_pt[1]
                    page.mouse.move(cx, cy)
                    page.mouse.down()
                    page.mouse.move(cx + 45, cy - 20, steps=6)
                    page.mouse.up()
                    page.wait_for_timeout(80)
                    x_after = page.evaluate("() => window.HqPrint3d._hooks.studio.items[0].x")
                    past_after = page.evaluate("() => window.HqPrint3d._hooks.studio.history.past.length")
                    self.assertNotEqual(x_after, x_before, "Dragging object in Déplacer mode moved object")
                    self.assertEqual(past_after, past_before + 1, "Continuous drag created 1 single undo entry")

                    # Scenario 4 & 5: Rotate X=90, Scale 150%, Poser à plat, Centrer, Réinitialiser
                    inputs = page.locator('.p3d-studio-obj input[type="number"]')
                    inputs.nth(5).fill("90")
                    inputs.nth(5).dispatch_event("change")
                    page.wait_for_timeout(60)
                    dims_txt = page.locator(".p3d-studio-dims").inner_text()
                    self.assertIn("40.0 × 15.0 × 20.0", dims_txt, f"Unexpected rotated dims: {dims_txt}")

                    page.locator(".p3d-studio-obj-acts button", has_text="Poser à plat").click()
                    page.wait_for_timeout(60)
                    page.locator(".p3d-studio-obj-acts button", has_text="Centrer").click()
                    page.wait_for_timeout(60)
                    self.assertEqual(page.evaluate("() => window.HqPrint3d._hooks.studio.items[0].x"), 128)

                    page.locator(".p3d-studio-obj-acts button", has_text="Réinitialiser").click()
                    page.wait_for_timeout(60)
                    self.assertEqual(page.evaluate("() => window.HqPrint3d._hooks.studio.items[0].scale"), 1.0)
                    self.assertEqual(page.evaluate("() => window.HqPrint3d._hooks.studio.items[0].rot_x"), 0)

                    # Scenario 6: Duplicate shares single GPU VBO and reuses cache (still 1 wedge download!)
                    wedge_fetches_before = state.file_requests.count("m_wedge")
                    page.locator(".p3d-studio-bar button", has_text="Dupliquer").click()
                    page.wait_for_timeout(120)
                    wedge_fetches_after = state.file_requests.count("m_wedge")
                    vbo_dup = page.evaluate("() => document.querySelector('.p3d-studio-cvs').hqPrepareMetrics().vboCount")
                    self.assertEqual(wedge_fetches_before, 1)
                    self.assertEqual(wedge_fetches_after, 1, "Duplicating must NOT re-download STL")
                    self.assertEqual(vbo_dup, 1, "Duplicating must share 1 GPU VBO")
                    self.assertEqual(page.locator(".p3d-studio-objrow").count(), 2)

                    # Scenario 7 & 8: Force collision -> warn visible -> Auto-placer clears collision
                    page.locator('.p3d-studio-obj input[type="number"]').nth(0).fill("128")
                    page.locator('.p3d-studio-obj input[type="number"]').nth(0).dispatch_event("change")
                    page.wait_for_timeout(60)
                    self.assertTrue(page.locator(".p3d-studio-warn").is_visible())
                    self.assertIn("Collision", page.locator(".p3d-studio-warn").inner_text())

                    page.locator(".p3d-studio-bar button", has_text="Auto-placer").click()
                    page.wait_for_timeout(80)
                    self.assertFalse(page.locator(".p3d-studio-warn").is_visible())

                    # Scenario 9: Undo & Redo
                    page.locator(".p3d-studio-bar button", has_text="Annuler").click()
                    page.wait_for_timeout(60)
                    self.assertTrue(page.locator(".p3d-studio-warn").is_visible(), "Undo restores colliding state")
                    page.locator(".p3d-studio-bar button", has_text="Rétablir").click()
                    page.wait_for_timeout(60)
                    self.assertFalse(page.locator(".p3d-studio-warn").is_visible(), "Redo restores separated Auto-placer layout")

                    # Scenario 10 & 12: Mock slice -> Aperçu -> Back to Préparer -> Edit invalidates Imprimer
                    page.locator(".p3d-studio-bar button", has_text="Trancher").click()
                    page.wait_for_selector(".p3d-gcode-panel")
                    self.assertEqual(page.locator(".p3d-studio-bar button", has_text="Imprimer").count(), 1)
                    page.locator(".p3d-studio-modes button", has_text="1. Préparer").click()
                    page.wait_for_selector(".p3d-studio-cvs")
                    # Verify camera preset button preserved & working
                    page.locator(".p3d-studio-cam-bar button", has_text="Dessus").click()
                    page.wait_for_timeout(50)
                    pitch_top = page.evaluate("() => document.querySelector('.p3d-studio-cvs').hqPrepareMetrics().camera.pitch")
                    self.assertAlmostEqual(pitch_top, 1.52, places=2)
                    # Changing Rot Z invalidates stale Imprimer
                    page.locator('.p3d-studio-obj input[type="number"]').nth(2).fill("35")
                    page.locator('.p3d-studio-obj input[type="number"]').nth(2).dispatch_event("change")
                    page.wait_for_timeout(60)
                    imp_loc = page.locator(".p3d-studio-bar button", has_text="Imprimer")
                    self.assertTrue(imp_loc.count() == 0 or not imp_loc.is_visible())

                    # Desktop layout assertion: zero horizontal overflow
                    desktop_metrics = page.evaluate("""() => ({
                        viewport: [innerWidth, innerHeight],
                        overflow: document.documentElement.scrollWidth > innerWidth,
                        longTasks: window._longTasks || []
                    })""")
                    self.assertFalse(desktop_metrics["overflow"])
                    results["viewports"]["desktop_1440x900"] = desktop_metrics

                    # Scenario 13 (Phase 3.1 H2): Real Chromium WEBGL_lose_context lose + restore + non-empty pixel proof
                    lost_res = page.evaluate("""() => {
                        const cvs = document.querySelector('.p3d-studio-cvs');
                        const gl = cvs.getContext('webgl2') || cvs.getContext('webgl') || cvs.getContext('experimental-webgl');
                        const ext = gl && gl.getExtension('WEBGL_lose_context');
                        if (!ext) return { supported: false, hasGl: !!gl };
                        window._testLoseExt = ext;
                        ext.loseContext();
                        return Object.assign({ supported: true }, cvs.hqPrepareMetrics());
                    }""")
                    self.assertTrue(lost_res["supported"], "WEBGL_lose_context extension required in Chromium SwiftShader")
                    page.wait_for_function("() => document.querySelector('.p3d-studio-cvs').hqPrepareMetrics().contextLost === true")
                    lost_m = page.evaluate("() => document.querySelector('.p3d-studio-cvs').hqPrepareMetrics()")
                    self.assertFalse(lost_m["bedReady"])
                    self.assertEqual(lost_m["vboCount"], 0)
                    page.evaluate("() => window._testLoseExt && window._testLoseExt.restoreContext()")
                    page.wait_for_function("""() => {
                        const m = document.querySelector('.p3d-studio-cvs').hqPrepareMetrics();
                        return !m.contextLost && m.glGen >= 2 && m.bedReady && m.vboCount >= 1;
                    }""")
                    page.wait_for_timeout(120)
                    shot_png = page.locator(".p3d-studio-cvs").screenshot()
                    non_bg = _png_non_bg_samples(shot_png)
                    restored_pixels = page.evaluate("() => document.querySelector('.p3d-studio-cvs').hqPrepareMetrics()")
                    restored_pixels["nonBgSamples"] = non_bg
                    restored_pixels["pngBytes"] = len(shot_png)
                    self.assertGreater(non_bg, 200, f"Restored WebGL canvas drew empty/flat composited frame: {restored_pixels}")
                    results["scenarios"]["webgl_context_restore"] = restored_pixels

                    # Scenario 14 (Phase 3.1 H1): Replace wedge.stl under SAME id & equal 8-tri count -> dims & mesh reload cleanly
                    state.wedge_bytes = _make_wedge_stl(80.0)
                    state.wedge_bounds = [80, 20, 15]
                    new_sha = hashlib.sha256(state.wedge_bytes).hexdigest()
                    fetches_before_swap = state.file_requests.count("m_wedge")
                    page.evaluate("""async () => {
                        const res = await fetch('/api/print3d/models');
                        const data = await res.json();
                        window.HqPrint3d._hooks.syncStudioSourceVersions(data.models);
                    }""")
                    page.wait_for_function(f"""() => {{
                        const st = window.HqPrint3d._hooks.studio;
                        return st.items.length > 0 && st.items[0].sourceVersion === '{new_sha}' && st.items[0].loadState === 'ready' && Math.round(st.items[0].dx) === 80;
                    }}""")
                    self.assertEqual(state.file_requests.count("m_wedge"), fetches_before_swap + 1, "Source swap must re-fetch updated STL bytes")
                    results["scenarios"]["source_replacement_h1"] = {
                        "dx": page.evaluate("() => window.HqPrint3d._hooks.studio.items[0].dx"),
                        "sourceVersion": page.evaluate("() => window.HqPrint3d._hooks.studio.items[0].sourceVersion"),
                    }

                    # Scenario 11: Rapid hide -> resources released
                    page.evaluate("() => window.HqPrint3d.hide()")
                    page.wait_for_timeout(60)
                    self.assertEqual(len(state.hardware_calls), 0, "No hardware endpoint contacted")

                    # 2. Responsive viewports: Mobile portrait 390x844, Landscape 844x390, Tablet 768x1024
                    for label, vw, vh in [
                        ("mobile_390x844", 390, 844),
                        ("landscape_844x390", 844, 390),
                        ("tablet_768x1024", 768, 1024),
                    ]:
                        vpage = browser.new_page(viewport={"width": vw, "height": vh}, device_scale_factor=2, has_touch=True)
                        vpage.goto(base_url, wait_until="networkidle")
                        vpage.evaluate("() => window.HqPrint3d.show(document.getElementById('host'), window.api, 'studio')")
                        vpage.wait_for_selector(".p3d-studio-cvs")
                        vpage.get_by_role("button", name="+ Ajouter").click()
                        vpage.wait_for_selector(".p3d-studio-pick button")
                        vpage.locator(".p3d-studio-pick button", has_text="wedge.stl").click()
                        vpage.wait_for_function("() => window.HqPrint3d._hooks.studio.items.some(i => i.loadState === 'ready')")
                        vpage.wait_for_timeout(80)
                        vp_m = vpage.evaluate("""() => {
                            const rect = s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) } : null; };
                            return {
                                viewport: [innerWidth, innerHeight],
                                overflow: document.documentElement.scrollWidth > innerWidth,
                                stage: rect('.p3d-studio-stage'),
                                side: rect('.p3d-studio-side'),
                                toolbarBtn: rect('.p3d-studio-bar button'),
                                camBtn: rect('.p3d-studio-cam-bar button'),
                                objBtn: rect('.p3d-studio-obj button'),
                                objInput: rect('.p3d-studio-obj input'),
                            };
                        }""")
                        self.assertFalse(vp_m["overflow"], f"{label} overflowed horizontally: {vp_m}")
                        self.assertGreaterEqual(vp_m["toolbarBtn"]["h"], 44, f"{label} toolbar button < 44px")
                        self.assertGreaterEqual(vp_m["camBtn"]["h"], 44, f"{label} cam button < 44px")
                        self.assertGreaterEqual(vp_m["objBtn"]["h"], 44, f"{label} obj button < 44px")
                        self.assertGreaterEqual(vp_m["objInput"]["h"], 44, f"{label} obj input < 44px")
                        if vw <= 820:
                            self.assertLess(vp_m["stage"]["top"], vp_m["side"]["top"], f"{label} stage must precede sidebar")
                        results["viewports"][label] = vp_m
                        vpage.evaluate("() => window.HqPrint3d.hide()")
                        vpage.close()

                    # 3. Synthetic STL Benchmarks: 10k, 100k, 300k triangles (worker + main thread + orbit frame cost)
                    bpage = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
                    bpage.goto(base_url, wait_until="networkidle")
                    for mid, n_tri in [("m_10k", 10000), ("m_100k", 100000), ("m_300k", 300000)]:
                        bench = bpage.evaluate(f"""async () => {{
                            const r = await fetch('/api/print3d/models/file?id={mid}');
                            const rawBuf = await r.arrayBuffer();
                            const tMain0 = performance.now();
                            window.HQModel.parse('bench.stl', rawBuf);
                            const mainParseMs = +(performance.now() - tMain0).toFixed(2);

                            const tW0 = performance.now();
                            const workerModel = await window.HQModel.parseInWorker('bench.stl', rawBuf.slice(0));
                            const workerParseMs = +(performance.now() - tW0).toFixed(2);

                            const cvs = document.createElement('canvas');
                            cvs.width = 900; cvs.height = 600;
                            document.body.appendChild(cvs);
                            const vp = window.HQPrepare.createViewport(cvs);
                            const meshes = {{}};
                            meshes['{mid}'] = {{ positions: workerModel.positions, normals: workerModel.normals, rawBounds: workerModel.bounds, triangles: workerModel.triangles }};
                            const tF0 = performance.now();
                            vp.setState({{ bed: {{x:256,y:256,z:256}}, items: [{{model_id:'{mid}', x:128, y:128, z:0, rot_z:0, scale:1, dx:25, dy:25, dz:18}}], selected: 0, meshes }});
                            vp.drawNow();
                            const firstFrameMs = +(performance.now() - tF0).toFixed(2);

                            // Measure 12 simulated orbit/drag draws
                            const tOrb0 = performance.now();
                            for (let k = 0; k < 12; k++) {{
                                vp.setState({{ items: [{{model_id:'{mid}', x:128 + k, y:128, z:0, rot_z:k * 5, scale:1, dx:25, dy:25, dz:18}}] }});
                                vp.drawNow();
                            }}
                            const avgDragFrameMs = +((performance.now() - tOrb0) / 12).toFixed(2);
                            const heapMB = performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null;
                            vp.dispose();
                            cvs.remove();
                            return {{ triangles: {n_tri}, mainParseMs, workerParseMs, firstFrameMs, avgDragFrameMs, heapMB }};
                        }}""")
                        results["benchmarks"][mid] = bench
                    bpage.close()
                    page.close()
                finally:
                    browser.close()
        finally:
            srv.shutdown()
            srv.server_close()

        print("PHASE3_PLAYWRIGHT_METRICS:", json.dumps(results))

    def test_phase4_advanced_multitool_perobject_project_e2e_and_perf(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            state = _SandboxState(state_dir=Path(td))
            srv = _start_server(state)
            base_url = f"http://127.0.0.1:{srv.server_port}/harness.html"
            metrics: dict = {"desktop": {}, "mobile_390x844": {}, "landscape_844x390": {}}
            try:
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(
                        headless=True,
                        args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"],
                    )
                    try:
                        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
                        page.on("dialog", lambda d: d.accept())
                        page.goto(base_url, wait_until="networkidle")
                        page.evaluate("() => window.HqPrint3d.show(document.getElementById('host'), window.api, 'studio')")
                        page.wait_for_selector(".p3d-studio-cvs")

                        # 1-2. Open Studio & add two STL objects
                        page.get_by_role("button", name="+ Ajouter").click()
                        page.wait_for_selector(".p3d-studio-pick button")
                        page.locator(".p3d-studio-pick button", has_text="wedge.stl").click()
                        page.wait_for_function("() => window.HqPrint3d._hooks.studio.items.length === 1 && window.HqPrint3d._hooks.studio.items[0].loadState === 'ready'")

                        # 3-4. Choose Fine preset & expand Paramètres avancés (measure open ms)
                        page.locator(".p3d-studio-side select").nth(3).select_option("fine")
                        page.wait_for_timeout(40)
                        t_adv0 = time.perf_counter()
                        page.locator(".p3d-studio-adv > summary").click()
                        page.wait_for_timeout(30)
                        metrics["desktop"]["adv_open_ms"] = round((time.perf_counter() - t_adv0) * 1000, 1)
                        adv_inputs = page.locator('.p3d-studio-adv input[type="number"]')
                        self.assertGreaterEqual(adv_inputs.count(), 10)
                        adv_inputs.nth(2).fill("90")  # outer_wall_speed
                        adv_inputs.nth(2).dispatch_event("change")

                        # 5. Read-only loaded materials import
                        page.locator(".p3d-studio-materials-fold", has_text="Importer chargés").get_by_role("button", name="Importer chargés (lecture seule)").click()
                        page.wait_for_function("() => window.HqPrint3d._hooks.studio.tools[1].material === 'PETG'")

                        # 6-7. Duplicate + Auto-placer + apply Per-Object override on Object 2
                        page.locator(".p3d-studio-bar button", has_text="Dupliquer").click()
                        page.wait_for_timeout(60)
                        page.locator(".p3d-studio-bar button", has_text="Auto-placer").click()
                        page.wait_for_timeout(60)
                        t_ov0 = time.perf_counter()
                        page.locator(".p3d-studio-obj-slicing > summary").click()
                        ov_inf = page.locator('.p3d-studio-obj-slicing input[type="number"]').nth(0)
                        ov_inf.fill("75")
                        ov_inf.dispatch_event("change")
                        page.wait_for_timeout(40)
                        metrics["desktop"]["per_obj_override_ms"] = round((time.perf_counter() - t_ov0) * 1000, 1)
                        self.assertEqual(page.evaluate("() => window.HqPrint3d._hooks.studio.items[1].overrides.infill"), 75)

                        # 8-10. Save .hq3d project -> New Project -> Open saved Project -> Verify overrides + NO Imprimer
                        t_save0 = time.perf_counter()
                        page.locator(".p3d-studio-bar button", has_text="Enregistrer").click()
                        page.wait_for_function("() => !!window.HqPrint3d._hooks.studio.project.id")
                        metrics["desktop"]["project_save_ms"] = round((time.perf_counter() - t_save0) * 1000, 1)
                        saved_id = page.evaluate("() => window.HqPrint3d._hooks.studio.project.id")

                        page.locator(".p3d-studio-bar button", has_text="Projets").click()
                        page.wait_for_selector(".p3d-projects-sheet")
                        page.locator(".p3d-projects-sheet button", has_text="Nouveau projet").click()
                        page.wait_for_function("() => window.HqPrint3d._hooks.studio.items.length === 0")

                        t_open0 = time.perf_counter()
                        page.locator(".p3d-studio-bar button", has_text="Projets").click()
                        page.wait_for_selector(".p3d-project-row button")
                        page.locator(".p3d-project-row button", has_text="Ouvrir").first.click()
                        page.wait_for_function(f"() => window.HqPrint3d._hooks.studio.project.id === '{saved_id}' && window.HqPrint3d._hooks.studio.items.length === 2")
                        metrics["desktop"]["project_open_ms"] = round((time.perf_counter() - t_open0) * 1000, 1)
                        self.assertEqual(page.evaluate("() => window.HqPrint3d._hooks.studio.items[1].overrides.infill"), 75)
                        self.assertEqual(page.evaluate("() => window.HqPrint3d._hooks.studio.tools[1].material"), "PETG")
                        imp_pre = page.locator(".p3d-studio-bar button", has_text="Imprimer")
                        self.assertTrue(imp_pre.count() == 0 or not imp_pre.is_visible(), "Reopened project must NOT restore Imprimer")

                        # 11-13. Slice -> Aperçu -> Back -> Edit setting invalidates Imprimer
                        page.wait_for_function("() => window.HqPrint3d._hooks.studio.items.every(i => i.loadState === 'ready')")
                        page.locator(".p3d-studio-bar button", has_text="Trancher").click()
                        page.wait_for_selector(".p3d-gcode-panel")
                        self.assertEqual(state.slice_payloads[-1]["items"][1]["overrides"]["infill"], 75)
                        self.assertEqual(state.slice_payloads[-1]["settings"]["quality_preset"], "fine")
                        page.locator(".p3d-studio-modes button", has_text="1. Préparer").click()
                        page.wait_for_selector(".p3d-studio-cvs")
                        self.assertEqual(page.locator(".p3d-studio-bar button", has_text="Imprimer").count(), 1)
                        page.locator(".p3d-studio-side select").nth(3).select_option("draft")
                        page.wait_for_timeout(50)
                        imp_post = page.locator(".p3d-studio-bar button", has_text="Imprimer")
                        self.assertTrue(imp_post.count() == 0 or not imp_post.is_visible())
                        page.close()

                        # Mobile Portrait 390x844 & Landscape 844x390 Phase 4 UX checks
                        for label, vw, vh in [("mobile_390x844", 390, 844), ("landscape_844x390", 844, 390)]:
                            mp = browser.new_page(viewport={"width": vw, "height": vh}, device_scale_factor=2, has_touch=True)
                            mp.goto(base_url, wait_until="networkidle")
                            mp.evaluate("() => window.HqPrint3d.show(document.getElementById('host'), window.api, 'studio')")
                            mp.wait_for_selector(".p3d-studio-subnav")
                            mp.locator(".p3d-studio-subnav button", has_text="Matériaux").click()
                            mp.wait_for_timeout(40)
                            info = mp.evaluate("""() => {
                                const r = s => { const el = document.querySelector(s); if(!el) return null; const b = el.getBoundingClientRect(); return { h: Math.round(b.height), w: Math.round(b.width), top: Math.round(b.top) }; };
                                return {
                                    overflow: document.documentElement.scrollWidth > innerWidth,
                                    subBtn: r('.p3d-studio-subnav .p3d-tag'),
                                    matBtn: r('.p3d-studio-materials-fold button'),
                                    stage: r('.p3d-studio-stage'),
                                    side: r('.p3d-studio-side'),
                                };
                            }""")
                            self.assertFalse(info["overflow"], f"{label} horizontal overflow: {info}")
                            self.assertGreaterEqual(info["subBtn"]["h"], 44, f"{label} subnav pill < 44px")
                            self.assertGreaterEqual(info["matBtn"]["h"], 44, f"{label} material button < 44px")
                            if vw <= 820:
                                self.assertLess(info["stage"]["top"], info["side"]["top"], f"{label} stage first")
                            metrics[label] = info
                            mp.close()

                        self.assertEqual(len(state.hardware_calls), 0, "Zero hardware calls allowed")
                    finally:
                        browser.close()
            finally:
                srv.shutdown()
                srv.server_close()

            print("PHASE4_PLAYWRIGHT_METRICS:", json.dumps(metrics))


if __name__ == "__main__":
    unittest.main()
