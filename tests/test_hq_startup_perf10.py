"""perf10 startup fixes: cached Forge status probe, cached Tailscale peers for /api/status,
shared /api/me request, single companion art GET at startup. No network, no live state."""
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import hq_companion_art as A
import iphone_bridge as B

SOURCE = Path(B.__file__).resolve().parent


class ForgeStatusCache(unittest.TestCase):
    def setUp(self):
        self.calls = 0
        self._status = A.forge.status
        self._open = A._forge_port_open
        self._tt = A.forge._test_transport
        A.forge._test_transport = None

        def fake_status(**_k):
            self.calls += 1
            return {"forge": "ready", "model": None, "message": "", "code": "ready"}

        A.forge.status = fake_status
        A.invalidate_status_cache()

    def tearDown(self):
        A.forge.status = self._status
        A._forge_port_open = self._open
        A.forge._test_transport = self._tt
        A.invalidate_status_cache()

    def test_second_call_is_cached(self):
        A._forge_port_open = lambda _o: True
        self.assertEqual(A.cached_forge_status()["forge"], "ready")
        self.assertEqual(A.cached_forge_status()["forge"], "ready")
        self.assertEqual(self.calls, 1)

    def test_invalidate_forces_new_probe(self):
        A._forge_port_open = lambda _o: True
        A.cached_forge_status()
        A.invalidate_status_cache()
        A.cached_forge_status()
        self.assertEqual(self.calls, 2)

    def test_offline_precheck_skips_slow_probe(self):
        A._forge_port_open = lambda _o: False
        snap = A.cached_forge_status()
        self.assertEqual(snap["code"], "forge_offline")
        self.assertEqual(snap["forge"], "offline")
        self.assertEqual(self.calls, 0)

    def test_test_transport_bypasses_cache(self):
        A.forge._test_transport = object()
        A.cached_forge_status()
        A.cached_forge_status()
        self.assertEqual(self.calls, 2)

    def test_post_action_invalidates(self):
        A._forge_port_open = lambda _o: True
        A.cached_forge_status()
        tmp = Path(tempfile.mkdtemp(prefix="hq-perf10-"))
        try:
            A.http_post(tmp, {"action": "controlnet_off"}, role="admin", nsfw=False)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        A.cached_forge_status()
        self.assertEqual(self.calls, 2)

    def test_closed_port_reports_fast(self):
        import socket, time
        s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
        t = time.monotonic()
        self.assertFalse(self._open(f"http://127.0.0.1:{port}"))
        self.assertLess(time.monotonic() - t, 1.5)


class StatusPeersCache(unittest.TestCase):
    def setUp(self):
        self._peers = B.tailscale_peers
        self.calls = 0

        def fake():
            self.calls += 1
            return [{"id": "ts:x", "name": "box", "os": "linux", "ip": "100.64.0.9", "online": True}]

        B.tailscale_peers = fake
        B._TS_PEERS_CACHE.update({"at": None, "peers": []})

    def tearDown(self):
        B.tailscale_peers = self._peers
        B._TS_PEERS_CACHE.update({"at": None, "peers": []})

    def test_peers_cached_and_copied(self):
        a = B._tailscale_peers_for_status()
        a[0]["name"] = "mutated"
        b = B._tailscale_peers_for_status()
        self.assertEqual(self.calls, 1)
        self.assertEqual(b[0]["name"], "box")

    def test_status_uses_cached_peers(self):
        B.bridge_status()
        B.bridge_status()
        self.assertEqual(self.calls, 1)


class FrontEndDedupe(unittest.TestCase):
    def test_companion_art_get_shared(self):
        js = (SOURCE / "assets" / "hq-companion.js").read_text(encoding="utf-8")
        self.assertIn("forgeUiDefaultsInflight", js)
        self.assertEqual(js.count('fetchJson(win, "/api/companion/art", null'), 1)

    @unittest.skipUnless(shutil.which("node"), "node missing")
    def test_api_me_shared_in_node(self):
        html = B.__dict__.get("APP_HTML") or (SOURCE / "iphone_bridge.py").read_text(encoding="utf-8")
        start = html.index("let _hqMeMemo = null;")
        end = html.index("function renderCrumbs(", start)
        code = html[start:end]
        harness = """
let n = 0; const sessionStorage = { getItem(){return null}, setItem(){}, removeItem(){} };
const navigator = { onLine: true }; const location = { replace(){} };
globalThis.fetch = async (u) => { n++; return { status: 200, ok: true, headers: { get(){ return 'application/json'; } }, json: async () => ({ user: 'u', role: 'admin' }) }; };
""" + code + """
(async () => {
  const r = await Promise.all([api('/api/me', { timeoutMs: 8000 }), api('/api/me', { timeoutMs: 8000 }), api('/api/me')]);
  r[0].role = 'x';
  const again = await api('/api/me', { timeoutMs: 8000 });
  await api('/api/me', { hqFresh: true });
  await api('/api/me', { method: 'GET', cache: 'no-store' });
  if (n !== 3 || again.role !== 'admin' || r[1].role !== 'admin') { console.log('bad', n, again.role); process.exit(1); }
  console.log('ok', n);
})();
"""
        tmp = Path(tempfile.mkdtemp(prefix="hq-perf10-"))
        try:
            f = tmp / "h.js"
            f.write_text(harness, encoding="utf-8")
            out = subprocess.run(["node", str(f)], capture_output=True, text=True, timeout=30)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)


if __name__ == "__main__":
    unittest.main()