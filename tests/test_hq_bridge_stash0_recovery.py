"""Characterization and regression tests for Stage 2 bridge recovery from stash@{0} (53f5be3c745e).

Covers:
1. .hq-boot.json lifecycle (BOOT_FACTS_PATH, write_boot_facts, clear_boot_facts, early already_running
   guard in main(), and side_by_side_ports_ok(..., production_owner=production_owner_mode() or live_checkout)).
2. NVIDIA NIM fallback configuration (default_config()["nim_fallback"]) and bind_hq() wiring to hq_ai.bind.
3. Forge fresh=1 query forwarding on /api/forge/status and /api/forge/catalog (Handler._forge_get),
   including compatibility fallback when hq_forge.status / hq_forge.catalog do not yet accept fresh.
4. Terminal empty-state (#term-empty, hqTermEmptyRender), error-highlighting (HQ_TERM_ERR_RE,
   hqTermLineNode, .term-out .term-err), auto-grow textarea (#shell-cmd, hqTermGrowInput),
   plain-output copy stripping (hqTermPlainOutput), scroll guard (hqTermScrollGuard),
   and localStorage history cap (HQ_TERM_HISTORY_MAX = 50).
5. Cache-Control header deduplication in Handler._send (custom Cache-Control replaces no-store
   rather than emitting two Cache-Control headers).
6. Plus-view navigation aria-current="page" preservation (moreMarked = view === 'plus' ? prevView : view).
"""

from __future__ import annotations

import inspect
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1]
if str(SOURCE) not in sys.path:
    sys.path.insert(0, str(SOURCE))

import cc_ext  # noqa: E402
import hq_ai  # noqa: E402
import hq_diagnostics  # noqa: E402
import hq_forge  # noqa: E402
import hq_forge_jobs  # noqa: E402
import iphone_bridge as B  # noqa: E402


ADMIN_PIN = "424242"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class _HttpTestClient:
    def __init__(self, base: str, pin: str | None = None) -> None:
        self.base = base
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            _NoRedirect,
        )
        if pin:
            status, _msg, _body = self.raw_request(
                "/login",
                method="POST",
                data=("pin=" + pin).encode("utf-8"),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            assert status == 303, f"expected 303 on login, got {status}"

    def raw_request(
        self,
        path: str,
        *,
        method: str = "GET",
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ):
        hdrs = dict(headers or {})
        hdrs.setdefault("Origin", self.base)
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=hdrs)
        try:
            with self.opener.open(req, timeout=15) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, exc.read()


class BootFactsLifecycleTests(unittest.TestCase):
    """Verify .hq-boot.json creation, scratch-port guard, PID ownership guard, and main() order."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-boot-facts-")
        self.tmp_path = Path(self.tmp.name)
        self.fake_boot_path = self.tmp_path / ".hq-boot.json"
        self.fake_lock_path = self.tmp_path / ".hq-boot.publish.lock"
        self.orig_boot_path = B.BOOT_FACTS_PATH
        self.orig_lock_path = B.BOOT_FACTS_LOCK_PATH
        self.orig_port = B.PORT
        self.orig_root = B.ROOT
        B.BOOT_FACTS_PATH = self.fake_boot_path
        B.BOOT_FACTS_LOCK_PATH = self.fake_lock_path
        code_root = Path(B.__file__).resolve().parent
        self.repo_boot_path = code_root / ".hq-boot.json"
        self.repo_lock_path = code_root / ".hq-boot.publish.lock"
        self.repo_boot_existed = self.repo_boot_path.exists()
        self.repo_lock_existed = self.repo_lock_path.exists()

    def tearDown(self) -> None:
        B.BOOT_FACTS_PATH = self.orig_boot_path
        B.BOOT_FACTS_LOCK_PATH = self.orig_lock_path
        B.PORT = self.orig_port
        B.ROOT = self.orig_root
        B._release_boot_publish_lock()
        self.tmp.cleanup()
        if not self.repo_boot_existed:
            self.assertFalse(self.repo_boot_path.exists(), "tests must not create .hq-boot.json in the code root")
        if not self.repo_lock_existed:
            self.assertFalse(self.repo_lock_path.exists(), "tests must not create .hq-boot.publish.lock in the code root")

    def test_write_boot_facts_writes_atomic_json_on_port_8765(self) -> None:
        B.PORT = 8765
        B.ROOT = self.tmp_path
        with mock.patch.object(B, "production_owner_mode", return_value=False):
            B.write_boot_facts()
        self.assertTrue(self.fake_boot_path.is_file())
        tmps = list(self.fake_boot_path.parent.glob(".hq-boot.json.*.tmp"))
        self.assertEqual(tmps, [])
        facts = json.loads(self.fake_boot_path.read_text(encoding="utf-8"))
        self.assertEqual(facts["pid"], os.getpid())
        self.assertEqual(facts["port"], 8765)
        self.assertEqual(facts["state_root"], str(self.tmp_path))
        self.assertIs(facts["production_owner"], False)
        self.assertEqual(facts["code_root"], str(Path(B.__file__).resolve().parent))
        self.assertIsInstance(facts["started"], int)
        self.assertEqual(facts.get("instance_id"), B._BOOT_INSTANCE_ID)

    def test_write_boot_facts_skips_non_production_port(self) -> None:
        B.PORT = 18765
        B.ROOT = self.tmp_path
        B.write_boot_facts()
        self.assertFalse(self.fake_boot_path.exists())

    def test_clear_boot_facts_removes_file_only_when_instance_matches(self) -> None:
        foreign = {
            "instance_id": "foreign-instance-abc",
            "pid": os.getpid(),
            "port": 8765,
            "started": int(time.time()),
        }
        self.fake_boot_path.write_text(json.dumps(foreign), encoding="utf-8")
        B.clear_boot_facts()
        self.assertTrue(self.fake_boot_path.is_file(), "foreign instance_id must not be removed")

        own = {
            "instance_id": B._BOOT_INSTANCE_ID,
            "pid": os.getpid(),
            "port": 8765,
            "started": int(time.time()),
        }
        self.fake_boot_path.write_text(json.dumps(own), encoding="utf-8")
        B.clear_boot_facts()
        self.assertFalse(self.fake_boot_path.exists(), "own .hq-boot.json must be removed")

    def test_write_boot_facts_refuses_to_overwrite_live_foreign_owner(self) -> None:
        B.PORT = 8765
        B.ROOT = self.tmp_path
        foreign_pid = os.getpid()
        self.fake_boot_path.write_text(
            json.dumps(
                {
                    "instance_id": "other-live-bridge",
                    "pid": foreign_pid,
                    "port": 8765,
                    "started": int(time.time()),
                }
            ),
            encoding="utf-8",
        )
        with (
            mock.patch.object(B, "production_owner_mode", return_value=False),
            mock.patch.object(B, "_pid_is_alive", return_value=True),
        ):
            B.write_boot_facts()
        facts = json.loads(self.fake_boot_path.read_text(encoding="utf-8"))
        self.assertEqual(facts.get("instance_id"), "other-live-bridge")

    def test_clear_boot_facts_tolerates_missing_or_corrupt_file(self) -> None:
        B.clear_boot_facts()  # Missing file -> no exception
        self.fake_boot_path.write_text("{not-valid-json", encoding="utf-8")
        B.clear_boot_facts()  # Corrupt JSON -> no exception

    def test_clear_boot_facts_always_releases_publish_lock(self) -> None:
        cases = [
            ("missing_file", lambda: None),
            ("corrupt_json", lambda: self.fake_boot_path.write_text("{bad", encoding="utf-8")),
            (
                "foreign_instance",
                lambda: self.fake_boot_path.write_text(
                    json.dumps({"instance_id": "foreign", "pid": os.getpid() + 1, "port": 8765}),
                    encoding="utf-8",
                ),
            ),
        ]
        for label, prep in cases:
            with self.subTest(label):
                prep()
                with mock.patch.object(
                    B, "_release_boot_publish_lock", wraps=B._release_boot_publish_lock
                ) as release:
                    B.clear_boot_facts()
                    release.assert_called_once()

    def test_write_boot_facts_keeps_publish_lock_after_success(self) -> None:
        B.PORT = 8765
        B.ROOT = self.tmp_path
        with mock.patch.object(B, "production_owner_mode", return_value=False):
            B.write_boot_facts()
        self.assertIsNotNone(B._BOOT_PUBLISH_LOCK_HANDLE)
        B._release_boot_publish_lock()

    def test_main_live_checkout_duplicate_is_clean_exit_not_fatal(self) -> None:
        """Default live checkout: second start prints and returns 0 (not SystemExit)."""
        with (
            mock.patch.object(B, "production_owner_mode", return_value=False),
            mock.patch.object(B, "ensure_startup_lock"),
            mock.patch.object(B, "already_running", return_value=True),
            mock.patch.object(B, "_startup_release"),
        ):
            orig = B.STATE_ROOT_EXPLICIT
            try:
                B.STATE_ROOT_EXPLICIT = False
                B.main()  # must not raise
            finally:
                B.STATE_ROOT_EXPLICIT = orig

    def test_main_refuses_duplicate_before_migrations_or_orphan_reconcile(self) -> None:
        with (
            mock.patch.object(B, "production_owner_mode", return_value=False),
            mock.patch.object(B, "ensure_startup_lock") as take_lock,
            mock.patch.object(B, "already_running", return_value=True),
            mock.patch.object(B, "_startup_release") as rel,
            mock.patch.object(B, "load_config") as load_cfg,
            mock.patch.object(B, "ensure_folders_and_migrate") as migrate,
            mock.patch.object(cc_ext, "reconcile_orphans") as reconcile,
        ):
            orig_explicit = B.STATE_ROOT_EXPLICIT
            try:
                B.STATE_ROOT_EXPLICIT = False
                B.main()
                take_lock.assert_called_once()
                rel.assert_called_once()
                load_cfg.assert_not_called()
                migrate.assert_not_called()
                reconcile.assert_not_called()

                rel.reset_mock()
                take_lock.reset_mock()
                B.STATE_ROOT_EXPLICIT = True
                with self.assertRaises(SystemExit) as ctx:
                    B.main()
                self.assertIn("address already in use", str(ctx.exception))
                rel.assert_called_once()
                load_cfg.assert_not_called()
                migrate.assert_not_called()
                reconcile.assert_not_called()
            finally:
                B.STATE_ROOT_EXPLICIT = orig_explicit


class NimFallbackConfigAndBindTests(unittest.TestCase):
    """Verify default_config()['nim_fallback'] and bind_hq() wiring to hq_ai.bind."""

    def test_default_config_contains_nim_fallback_false(self) -> None:
        cfg = B.default_config()
        self.assertIn("nim_fallback", cfg)
        self.assertIs(cfg["nim_fallback"], False)
        self.assertIn("nvidia_api_key", cfg)
        self.assertIn("nvidia_visit_model", cfg)

    def test_bind_hq_wires_nvidia_key_and_nim_fallback_into_hq_ai(self) -> None:
        saved_cfg = dict(B.CONFIG)
        saved_cb = dict(hq_ai._cb)
        try:
            B.CONFIG["nvidia_api_key"] = "nvapi-synthetic-unit-test-key"
            B.CONFIG["nim_fallback"] = True
            B.bind_hq()
            self.assertIn("nvidia_key", hq_ai._cb)
            self.assertIn("nim_fallback", hq_ai._cb)
            self.assertEqual(hq_ai._cb["nvidia_key"](), "nvapi-synthetic-unit-test-key")
            self.assertIs(hq_ai._cb["nim_fallback"](), True)

            B.CONFIG["nim_fallback"] = False
            self.assertIs(hq_ai._cb["nim_fallback"](), False)
        finally:
            B.CONFIG.clear()
            B.CONFIG.update(saved_cfg)
            hq_ai._cb.clear()
            hq_ai._cb.update(saved_cb)


class BridgeHttpStashRecoveryTests(unittest.TestCase):
    """Verify Forge fresh=1 query forwarding and Cache-Control header deduplication over HTTP."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="hq-stage2-http-")
        cls.root = Path(cls.tmp) / "root"
        cls.root.mkdir()
        for name in ("Inbox", "Uni", "Print"):
            (cls.root / name).mkdir()
        (cls.root / "assets").mkdir()
        cls.saved = (
            B.ROOT,
            B.SESSIONS_PATH,
            B.CONFIG_PATH,
            dict(B.CONFIG),
            dict(B._DIAG_STATE),
        )
        B.ROOT = cls.root
        B.SESSIONS_PATH = cls.root / "bridge_sessions.json"
        B.CONFIG_PATH = cls.root / "bridge_config.json"
        B.CONFIG_PATH.write_text("{}", encoding="utf-8")
        B.CONFIG.update(
            {
                "pin": "",
                "users": [
                    {"name": "admin-test", "pin": ADMIN_PIN, "role": "admin"},
                ],
            }
        )
        B.bind_cc_ext()
        B.bind_hq()
        hq_diagnostics.ERRORS.clear_for_tests()
        B._DIAG_STATE.update(root=None, assets=None, last_probe=None)

        class QuietHandler(B.Handler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.path == "/__test/cache-override":
                    self._send(
                        200,
                        b"cached-thumb",
                        "image/jpeg",
                        [("Cache-Control", "private, max-age=31536000, immutable")],
                    )
                    return
                if self.path == "/__test/cache-default":
                    self._send(200, b"uncached-default", "text/plain; charset=utf-8")
                    return
                super().do_GET()

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.admin = _HttpTestClient(cls.base, ADMIN_PIN)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        hq_forge.reset_for_tests()
        hq_forge_jobs.reset_for_tests()
        B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH = cls.saved[0], cls.saved[1], cls.saved[2]
        B.CONFIG.clear()
        B.CONFIG.update(cls.saved[3])
        B._DIAG_STATE.clear()
        B._DIAG_STATE.update(cls.saved[4])
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_forge_status_and_catalog_forward_fresh_query_param(self) -> None:
        seen_status: list[bool] = []
        seen_catalog: list[bool] = []

        def fake_status(*, fresh: bool = False):
            seen_status.append(fresh)
            return {"forge": "offline", "fresh_seen": fresh}

        def fake_catalog(*, fresh: bool = False):
            seen_catalog.append(fresh)
            return {"forge": "offline", "models": [], "fresh_seen": fresh}

        with (
            mock.patch.object(hq_forge, "status", side_effect=fake_status),
            mock.patch.object(hq_forge, "catalog", side_effect=fake_catalog),
        ):
            code1, _hdr1, body1 = self.admin.raw_request("/api/forge/status")
            self.assertEqual(code1, 200)
            self.assertEqual(json.loads(body1.decode("utf-8"))["fresh_seen"], False)

            code2, _hdr2, body2 = self.admin.raw_request("/api/forge/status?fresh=1")
            self.assertEqual(code2, 200)
            self.assertEqual(json.loads(body2.decode("utf-8"))["fresh_seen"], True)

            code3, _hdr3, body3 = self.admin.raw_request("/api/forge/catalog")
            self.assertEqual(code3, 200)
            self.assertEqual(json.loads(body3.decode("utf-8"))["fresh_seen"], False)

            code4, _hdr4, body4 = self.admin.raw_request("/api/forge/catalog?fresh=1")
            self.assertEqual(code4, 200)
            self.assertEqual(json.loads(body4.decode("utf-8"))["fresh_seen"], True)

        self.assertEqual(seen_status, [False, True])
        self.assertEqual(seen_catalog, [False, True])

    def test_forge_status_and_catalog_without_fresh_kwarg_still_work(self) -> None:
        """Signature-based compatibility: no fresh= when hq_forge omits the keyword."""

        def baseline_status(*, transport=None):
            return {"forge": "ready", "compat": "no-fresh-kw"}

        def baseline_catalog(*, transport=None):
            return {"forge": "ready", "models": [], "compat": "no-fresh-kw"}

        with (
            mock.patch.object(hq_forge, "status", baseline_status),
            mock.patch.object(hq_forge, "catalog", baseline_catalog),
        ):
            code_s, _h, body_s = self.admin.raw_request("/api/forge/status?fresh=1")
            self.assertEqual(code_s, 200)
            self.assertEqual(json.loads(body_s.decode("utf-8"))["compat"], "no-fresh-kw")
            code_c, _h2, body_c = self.admin.raw_request("/api/forge/catalog?fresh=1")
            self.assertEqual(code_c, 200)
            self.assertEqual(json.loads(body_c.decode("utf-8"))["compat"], "no-fresh-kw")

    def test_forge_internal_typeerror_propagates_not_masked(self) -> None:
        def boom(*, fresh: bool = False):
            raise TypeError("sampler row was None")

        with mock.patch.object(hq_forge, "status", boom):
            with self.assertRaises(TypeError):
                B._forge_call_status(fresh=True)

    def test_send_cache_control_override_replaces_default_instead_of_stacking(self) -> None:
        code_def, hdr_def, _body_def = self.admin.raw_request("/__test/cache-default")
        self.assertEqual(code_def, 200)
        cc_def = hdr_def.get_all("Cache-Control") or []
        self.assertEqual(cc_def, ["no-store"])

        code_ovr, hdr_ovr, _body_ovr = self.admin.raw_request("/__test/cache-override")
        self.assertEqual(code_ovr, 200)
        cc_ovr = hdr_ovr.get_all("Cache-Control") or []
        self.assertEqual(
            cc_ovr,
            ["private, max-age=31536000, immutable"],
            "Caller-supplied Cache-Control must replace no-store, not stack a second header",
        )


class TerminalAndNavigationFrontendRecoveryTests(unittest.TestCase):
    """Verify recovered Terminal HTML/CSS/JS helpers and Plus-view highlight behavior."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.html = B.render_app().decode("utf-8")
        cls.app_js = B.APP_JS

    def test_terminal_dom_and_css_contracts(self) -> None:
        panel = self.html.split('<div data-panel="ops"', 1)[1].split('<div data-panel="forge"', 1)[0]
        # Auto-growing textarea replaces single-line input
        self.assertIn('<textarea id="shell-cmd" rows="1"', panel)
        self.assertNotIn('<input id="shell-cmd"', panel)
        # Empty state container and quick commands host
        self.assertIn('<div class="term-empty" id="term-empty" hidden>', panel)
        self.assertIn('<div class="row hq-actions" id="term-empty-cmds"></div>', panel)
        # Recovered CSS rules
        self.assertIn(".term-out .term-err{color:#ffb3a7}", self.html)
        self.assertIn(".term-empty{margin-top:10px;display:flex;flex-direction:column;gap:8px}", self.html)
        self.assertIn(".term-console.is-empty .term-out{min-height:96px}", self.html)
        self.assertIn(".term-job-sub{", self.html)
        self.assertIn(".term-cmd-line textarea{resize:none;overflow:hidden;min-height:44px;max-height:132px", self.html)
        # Plus view mark logic
        self.assertIn("const moreMarked = view === 'plus' ? prevView : view;", self.app_js)

    def test_terminal_js_helpers_execute_correctly_in_node(self) -> None:
        """Execute the recovered JS functions in Node to verify runtime behavior."""
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")

        # Extract the recovered helper definitions directly from APP_JS
        js_harness = r"""
const assert = require('node:assert/strict');
const appJs = __APP_JS__;

function extractBetween(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, 'Missing marker: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  assert.ok(j > i, 'Missing end marker: ' + endMarker);
  return src.slice(i, j);
}

const errSnippet = extractBetween(
  appJs,
  'const HQ_TERM_ERR_RE =',
  'function hqTermAppend(text)'
);
const histSnippet = extractBetween(
  appJs,
  'const HQ_TERM_HISTORY_MAX = 50;',
  'function hqTermHistoryRender()'
);

const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
global.document = {
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  createElement: (tag) => ({ nodeType: 1, tagName: tag.toUpperCase(), className: '', textContent: '' }),
};
global.$ = () => null;
global.$$ = () => [];
global.hqTermJob = null;
global.hqShellHistIndex = -1;
global.hqTermHistoryRender = () => {};

eval(errSnippet + '\n' + histSnippet);

// 1. HQ_TERM_ERR_RE and hqTermLineNode
const okNode = hqTermLineNode(' Service Transfert actif sur 8765');
assert.equal(okNode.nodeType, 3);
assert.equal(okNode.textContent, ' Service Transfert actif sur 8765');

for (const errLine of [
  "foo n'est pas reconnu comme commande interne",
  "Accès refusé",
  "Fatal: cannot bind port",
  "Délai dépassé après 20s",
  " Fichier introuvable "
]) {
  const node = hqTermLineNode(errLine);
  assert.equal(node.nodeType, 1, 'Expected span for: ' + errLine);
  assert.equal(node.className, 'term-err');
  assert.equal(node.textContent, errLine);
}

// 2. hqTermPlainOutput strips header ($ cmd, # meta) and footer (exit 0 / — arrêtée)
const rawTranscript = [
  '$ Get-Process',
  '# Ce PC (local) · powershell',
  'Handles  NPM(K)    PM(K)      WS(K)     CPU(s)',
  '    412      24    18420      29100       1.25',
  '',
  'exit 0 · 142 ms',
  ''
].join('\n');
assert.equal(
  hqTermPlainOutput(rawTranscript),
  'Handles  NPM(K)    PM(K)      WS(K)     CPU(s)\n    412      24    18420      29100       1.25'
);

const stoppedTranscript = '$ ping -t 127.0.0.1\nPinging 127.0.0.1\n\n— arrêtée\n';
assert.equal(hqTermPlainOutput(stoppedTranscript), 'Pinging 127.0.0.1');

// 3. localStorage command history deduplicates and caps at HQ_TERM_HISTORY_MAX = 50
for (let i = 1; i <= 60; i++) {
  hqTermHistoryAdd('cmd-' + i);
}
const list = hqTermHistoryList();
assert.equal(list.length, 50);
assert.equal(list[0], 'cmd-60');
assert.equal(list[49], 'cmd-11');

// Re-adding cmd-20 moves it to index 0 without growing past 50
hqTermHistoryAdd('cmd-20');
const list2 = hqTermHistoryList();
assert.equal(list2.length, 50);
assert.equal(list2[0], 'cmd-20');
console.log('node-term-helpers-ok');
""".replace("__APP_JS__", json.dumps(self.app_js))

        proc = subprocess.run(
            [node, "-"],
            input=js_harness,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=15,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)
        self.assertIn("node-term-helpers-ok", proc.stdout)

    def test_terminal_history_sensitive_commands_are_not_persisted(self) -> None:
        self.assertIn("HQ_TERM_HISTORY_SENSITIVE_RE", self.app_js)
        self.assertIn("HQ_TERM_HISTORY_SENSITIVE_RE.test(text)", self.app_js)

    def test_terminal_history_sensitive_filter_in_node(self) -> None:
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        js = r"""
const assert = require('node:assert/strict');
const appJs = __APP_JS__;
function extractBetween(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i);
  return src.slice(i, j);
}
const hist = extractBetween(appJs, 'const HQ_TERM_HISTORY_MAX = 50;', 'function hqTermHistoryRender()');
const store = new Map();
global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
global.hqShellHistIndex = -1;
global.hqTermHistoryRender = () => {};
eval(hist);
const benign = ['Get-Process', 'dir C:\\\\', 'Get-Service Spooler', 'api request'];
for (const cmd of benign) {
  hqTermHistoryAdd(cmd);
  assert.ok(hqTermHistoryList().includes(cmd), 'benign command kept: ' + cmd);
}
const blocked = [
  'export API_KEY=abc',
  'curl -H BeArEr deadbeef',
  'https://user:pass@host.example/path',
  'set pin=424242',
  'my NVAPI-key-here',
];
for (const cmd of blocked) {
  store.clear();
  hqTermHistoryAdd(cmd);
  assert.equal(hqTermHistoryList().length, 0, 'sensitive blocked: ' + cmd.replace(/./g, 'x'));
}
console.log('node-history-privacy-ok');
""".replace("__APP_JS__", json.dumps(self.app_js))
        proc = subprocess.run(
            [node, "-"], input=js, capture_output=True, text=True, encoding="utf-8", timeout=15, check=False
        )
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)
        self.assertIn("node-history-privacy-ok", proc.stdout)


class BridgeStartupAndForgeSemanticsTests(unittest.TestCase):
    def test_bridge_probe_hosts_includes_configured_bind_host(self) -> None:
        saved = dict(B.CONFIG)
        try:
            B.CONFIG["bind_host"] = "192.168.50.2"
            hosts = B._bridge_probe_hosts()
            self.assertIn("192.168.50.2", hosts)
            self.assertIn("127.0.0.1", hosts)
        finally:
            B.CONFIG.clear()
            B.CONFIG.update(saved)

    def test_callable_accepts_keyword_detection(self) -> None:
        self.assertTrue(B._callable_accepts_keyword(hq_forge.status, "fresh"))
        self.assertTrue(B._callable_accepts_keyword(hq_forge.catalog, "fresh"))

        def legacy(*, transport=None):
            return None

        self.assertFalse(B._callable_accepts_keyword(legacy, "fresh"))

    def test_catalog_fresh_bypasses_ttl_cache(self) -> None:
        hq_forge.reset_for_tests()

        def transport(method, url, timeout, body=None, max_bytes=None):
            raise ConnectionRefusedError()

        hq_forge.set_transport_for_tests(transport)
        key = "id:" + format(id(hq_forge._test_transport), "x")
        stale = {"forge": "ready", "models": [], "marker": "stale-catalog"}
        with hq_forge._lock:
            hq_forge._catalog_cache[key] = (time.monotonic(), stale)
        fresh_out = hq_forge.catalog(fresh=True)
        self.assertNotEqual(fresh_out.get("marker"), "stale-catalog")
        self.assertEqual(fresh_out.get("forge"), "offline")
        hq_forge.reset_for_tests()

    def test_print3d_state_handler_sets_private_no_store(self) -> None:
        bridge = Path(B.__file__).resolve().parent / "iphone_bridge.py"
        src = bridge.read_text(encoding="utf-8")
        block = src.split("print3d_no_store = (", 1)[1].split("self._json(code, payload)", 1)[0]
        self.assertIn('"Cache-Control", "private, no-store")', block)
        self.assertIn("self.send_header(*print3d_no_store)", block)
        self.assertNotIn('"no-cache"', block)

    def test_send_preserves_explicit_private_no_store(self) -> None:
        """Caller-supplied private, no-store must remain the sole Cache-Control (Print3D-style)."""
        saved_root = B.ROOT
        tmp = tempfile.mkdtemp(prefix="hq-send-cache-")
        try:
            B.ROOT = Path(tmp)
            B.SESSIONS_PATH = B.ROOT / "bridge_sessions.json"
            B.CONFIG_PATH = B.ROOT / "bridge_config.json"
            B.CONFIG_PATH.write_text("{}", encoding="utf-8")
            B.CONFIG.update({"pin": "", "users": [{"name": "a", "pin": ADMIN_PIN, "role": "admin"}]})
            B.bind_cc_ext()
            B.bind_hq()

            class Quiet(B.Handler):
                def log_message(self, *_):
                    pass

                def do_GET(self):
                    if self.path == "/__test/print3d-state-cache":
                        self._json(
                            200,
                            {"ok": True},
                            headers=[("Cache-Control", "private, no-store"), ("ETag", '"abc"')],
                        )
                        return
                    super().do_GET()

            httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            admin = _HttpTestClient(base, ADMIN_PIN)
            code, hdrs, _ = admin.raw_request("/__test/print3d-state-cache")
            self.assertEqual(code, 200)
            cc = hdrs.get_all("Cache-Control") or []
            self.assertEqual(cc, ["private, no-store"])
        finally:
            B.ROOT = saved_root
            shutil.rmtree(tmp, ignore_errors=True)


class ForgeSignatureCompatibilityTests(unittest.TestCase):
    def test_status_signature_in_worktree_accepts_fresh(self) -> None:
        sig = inspect.signature(hq_forge.status)
        self.assertIn("fresh", sig.parameters)


if __name__ == "__main__":
    unittest.main()
