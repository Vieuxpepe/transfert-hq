"""Phase 15 — hq_diagnostics unit tests, INCLUDING failure injection.

A health check that only ever sees success proves nothing. Every typed state (ok / degraded / unavailable / not_configured / error)
is asserted to be reachable here by a forced failure, offline, in temp directories only. No network, no Git, no real root.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_carnet  # noqa: E402,F401  (registers the Carnet modules the readiness check expects)
import hq_diagnostics as D  # noqa: E402

ASSETS = ["hq-carnet.js", "hq-carnet.css", "hq.js"]
SECRET = "S3CR3T-WEBHOOK-TOKEN-0123456789abcdef0123456789abcdef"


def make_root(tmp: str, *, assets: list[str] | None = None, ocr: bool = True, notebook: bool = True) -> str:
    root = os.path.join(tmp, "root")
    os.makedirs(os.path.join(root, "assets"))
    for n in (ASSETS if assets is None else assets):
        Path(root, "assets", n).write_text("x" * 200, encoding="utf-8")
    if ocr:
        for n in D.OCR_ASSETS:
            p = Path(root, "assets", n)
            p.write_bytes(gzip.compress(b"lang") if n.endswith(".gz") else b"js" * 100)
    if notebook:
        os.makedirs(os.path.join(root, ".hq-carnet"))
        Path(root, ".hq-carnet", "notebook.json").write_text("{}", encoding="utf-8")
    return root


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="p15-unit-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.cfg_path = os.path.join(self.tmp, "bridge_config.json")
        Path(self.cfg_path).write_text(json.dumps({"pin": "", "discord_webhook_url": SECRET}), encoding="utf-8")
        self.config = {"pin": "", "discord_webhook_url": SECRET, "backup_dir": "", "folders": ["Inbox"]}

    def ready(self, root: str, **kw) -> dict:
        return D.readiness(root=root, config=kw.pop("config", self.config), config_path=kw.pop("config_path", self.cfg_path),
                           asset_names=kw.pop("asset_names", ASSETS))


class ScrubAndCategory(unittest.TestCase):
    def test_scrub_removes_paths_tokens_emails_and_bounds(self):
        s = D.scrub(r"open C:\Users\me\Transfert\.hq-carnet\notebook.json failed /home/x/y/z mail a.b@c.io tok " + SECRET, "C:\\Users\\me\\Transfert")
        for bad in ("Users", "/home/x", "a.b@c.io", SECRET):
            self.assertNotIn(bad, s)
        self.assertLessEqual(len(D.scrub("a" * 5000)), D.MESSAGE_MAX)
        self.assertNotIn("\n", D.scrub("a\nb\r\nc\x00d"))

    def test_scrub_never_raises(self):
        class Bad:
            def __str__(self):
                raise RuntimeError("no")
        self.assertEqual(D.scrub(Bad()), "<unprintable>")

    def test_path_category_drops_query_and_ids(self):
        self.assertEqual(D.path_category("/api/carnet?q=SECRET-TEXT&x=1"), "/api/carnet")
        self.assertEqual(D.path_category("/api/carnet/voice/voice-abc/transcribe"), "/api/carnet")
        self.assertEqual(D.path_category("/assets/hq.js?v=1"), "/assets")
        self.assertEqual(D.path_category("/diagnostics"), "/diagnostics")
        self.assertEqual(D.path_category(None), "/")
        self.assertEqual(D.path_category("/api/x%00SECRET"), "/api/other")  # unknown areas are never echoed
        self.assertEqual(D.path_category("/files/Inbox/private-name.pdf"), "/files")
        self.assertEqual(D.path_category("/whatever/secret-id"), "/other")


class Identity(Base):
    def git_dir(self, head: str, refs: dict[str, str] | None = None, packed: str = "") -> str:
        root = os.path.join(self.tmp, "co")
        os.makedirs(os.path.join(root, ".git", "refs", "heads"), exist_ok=True)
        Path(root, ".git", "HEAD").write_text(head, encoding="utf-8")
        for ref, sha in (refs or {}).items():
            p = Path(root, ".git", *ref.split("/"))
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(sha + "\n", encoding="utf-8")
        if packed:
            Path(root, ".git", "packed-refs").write_text(packed, encoding="utf-8")
        return root

    SHA = "457c665a643a737e812423f9922cd6bf33d8ba18"

    def test_branch_ref_detached_and_packed(self):
        root = self.git_dir("ref: refs/heads/main\n", {"refs/heads/main": self.SHA})
        self.assertEqual(D.read_git_head(root), (self.SHA, "git_ref"))
        shutil.rmtree(root)
        root = self.git_dir(self.SHA + "\n")
        self.assertEqual(D.read_git_head(root), (self.SHA, "git_head_detached"))
        shutil.rmtree(root)
        root = self.git_dir("ref: refs/heads/main\n", packed=f"# pack-refs\n{self.SHA} refs/heads/main\n")
        self.assertEqual(D.read_git_head(root), (self.SHA, "git_packed_refs"))

    def test_unknown_is_unknown_never_fabricated(self):
        for head in ("garbage\n", "ref: refs/heads/../../etc/passwd\n", "ref: refs/heads/nope\n", ""):
            root = self.git_dir(head)
            sha, _src = D.read_git_head(root)
            self.assertIsNone(sha, head)
            shutil.rmtree(root)
        self.assertEqual(D.read_git_head(os.path.join(self.tmp, "absent"))[0], None)
        self.assertEqual(D.read_git_head(self.tmp), (None, "not_a_checkout"))

    def test_worktree_git_pointer_file(self):
        main = os.path.join(self.tmp, "main", ".git")
        os.makedirs(os.path.join(main, "worktrees", "w", ), exist_ok=True)
        os.makedirs(os.path.join(main, "refs", "heads"))
        Path(main, "refs", "heads", "feat").write_text(self.SHA + "\n")
        wt = os.path.join(main, "worktrees", "w")
        Path(wt, "HEAD").write_text("ref: refs/heads/feat\n")
        Path(wt, "commondir").write_text("../..\n")
        co = os.path.join(self.tmp, "wtree")
        os.makedirs(co)
        Path(co, ".git").write_text("gitdir: " + wt + "\n")
        self.assertEqual(D.read_git_head(co)[0], self.SHA)

    def test_env_override_validated_and_identity_fields(self):
        ident = D.init_identity(self.tmp, version="7.0", env={"HQ_BUILD_SHA": "ABCDEF1234567"})
        self.assertEqual(ident["build_sha"], "abcdef1234567")
        self.assertEqual(ident["build_sha_source"], "env")
        ident = D.init_identity(self.tmp, version="7.0", env={"HQ_BUILD_SHA": "not hex; rm -rf"})
        self.assertIsNone(ident["build_sha"])
        self.assertEqual(ident["build_sha_source"], "not_a_checkout")
        for k in ("python", "platform", "pid", "started_at", "root_name", "data_dir", "run_mode", "version"):
            self.assertIn(k, ident)
        self.assertEqual(ident["root_name"], os.path.basename(self.tmp))
        self.assertNotIn(self.tmp, json.dumps(ident))  # a full path is never part of the identity

    def test_expected_comparison_and_restart_pending(self):
        root = self.git_dir("ref: refs/heads/main\n", {"refs/heads/main": self.SHA})
        D.init_identity(root, version="7.0", env={})
        self.assertTrue(D.identity(root, expect=self.SHA[:9])["expected"]["matches"])
        self.assertFalse(D.identity(root, expect="deadbeef")["expected"]["matches"])
        self.assertFalse(D.identity(root, expect="zz")["expected"]["valid"])
        self.assertFalse(D.identity(root)["restart_pending"])
        # a deployment moves HEAD under a running process: restart_pending must say so
        other = "f8c2ceec5548535f1575fcd7d23d4ca1b5cafd0d"
        Path(root, ".git", "refs", "heads", "main").write_text(other + "\n")
        info = D.identity(root)
        self.assertTrue(info["restart_pending"])
        self.assertEqual(info["checkout_sha"], other)
        self.assertEqual(info["build_sha"], self.SHA)

    def test_unknown_build_makes_expected_inconclusive_not_a_match(self):
        D.init_identity(self.tmp, version="7.0", env={})
        e = D.identity(self.tmp, expect=self.SHA)["expected"]
        self.assertIsNone(e["matches"])

    def test_liveness_is_cheap_and_has_no_filesystem_dependency(self):
        with mock.patch("os.stat", side_effect=AssertionError("liveness must not touch the filesystem")), mock.patch("os.scandir", side_effect=AssertionError):
            lv = D.liveness()
        self.assertEqual(lv["status"], "alive")


class ReadinessFailureInjection(Base):
    """Each injected failure must be DETECTED and CLASSIFIED; a healthy tree must be ``ready``."""

    def test_healthy_tree_is_ready_except_optional_not_configured(self):
        r = self.ready(make_root(self.tmp))
        self.assertEqual(r["checks"]["transcription"]["status"], "not_configured")
        self.assertEqual(r["checks"]["backup_dir"]["status"], "not_configured")
        self.assertEqual(r["status"], "ready", r["summary"])  # optional/unconfigured subsystems must not degrade readiness
        for c in r["checks"].values():
            self.assertIn(c["status"], D.STATUSES)

    def test_missing_data_directory_root(self):
        root = make_root(self.tmp)
        shutil.rmtree(root)
        r = self.ready(root)
        self.assertEqual(r["status"], "not_ready")
        self.assertEqual(r["checks"]["data_root"]["status"], "unavailable")
        self.assertEqual(r["checks"]["carnet_dir"]["detail"], "root_unavailable")

    def test_carnet_dir_uninitialised_is_degraded_not_failed(self):
        root = make_root(self.tmp, notebook=False)
        r = self.ready(root)
        self.assertEqual(r["checks"]["carnet_dir"]["status"], "degraded")
        self.assertEqual(r["status"], "degraded")

    def test_unwritable_or_unusable_data_location_data_dir_is_a_file(self):
        root = make_root(self.tmp, notebook=False)
        Path(root, ".hq-carnet").write_text("i am a file", encoding="utf-8")
        r = self.ready(root)
        self.assertEqual(r["checks"]["carnet_dir"]["status"], "unavailable")
        self.assertEqual(r["status"], "not_ready")

    @unittest.skipIf(os.name == "nt", "symlink creation needs privileges on Windows")
    def test_data_dir_symlink_is_refused(self):
        root = make_root(self.tmp, notebook=False)
        real = os.path.join(self.tmp, "elsewhere")
        os.makedirs(real)
        os.symlink(real, os.path.join(root, ".hq-carnet"))
        self.assertEqual(self.ready(root)["checks"]["carnet_dir"]["detail"], "data_dir_is_symlink")

    def test_missing_and_empty_static_asset(self):
        root = make_root(self.tmp)
        os.remove(os.path.join(root, "assets", "hq-carnet.js"))
        Path(root, "assets", "hq.js").write_text("", encoding="utf-8")
        r = self.ready(root)
        c = r["checks"]["static_assets"]
        self.assertEqual(c["status"], "unavailable")
        self.assertEqual(c["missing"], ["hq-carnet.js"])
        self.assertEqual(c["empty"], ["hq.js"])
        self.assertEqual(r["status"], "not_ready")

    def test_asset_list_unknown_is_degraded_never_silently_ok(self):
        self.assertEqual(self.ready(make_root(self.tmp), asset_names=[])["checks"]["static_assets"]["status"], "degraded")

    def test_corrupt_config_file_detected_while_running_instance_unaffected(self):
        Path(self.cfg_path).write_text('{"pin": ', encoding="utf-8")
        r = self.ready(make_root(self.tmp))
        c = r["checks"]["config"]
        self.assertEqual((c["status"], c["detail"]), ("error", "config_file_malformed"))
        self.assertEqual(r["status"], "not_ready")
        self.assertNotIn("pin", json.dumps(c))  # the broken text itself is never echoed
        Path(self.cfg_path).write_text("[1,2]", encoding="utf-8")
        self.assertEqual(self.ready(make_root(os.path.join(self.tmp, "b")) if False else make_root(tempfile.mkdtemp(dir=self.tmp)))["checks"]["config"]["detail"], "config_file_not_an_object")

    def test_config_not_loaded(self):
        r = self.ready(make_root(self.tmp), config={})
        self.assertEqual(r["checks"]["config"]["status"], "error")

    def test_missing_ocr_language_file_degrades_but_does_not_block(self):
        root = make_root(self.tmp)
        os.remove(os.path.join(root, "assets", "fra.traineddata.gz"))
        r = self.ready(root)
        self.assertEqual(r["checks"]["ocr_assets"]["status"], "unavailable")
        self.assertEqual(r["checks"]["ocr_assets"]["missing"], ["fra.traineddata.gz"])
        self.assertEqual(r["status"], "degraded")  # OCR is optional: Carnet still serves

    def test_corrupt_ocr_language_file_header(self):
        root = make_root(self.tmp)
        Path(root, "assets", "eng.traineddata.gz").write_bytes(b"not gzip at all")
        self.assertEqual(self.ready(root)["checks"]["ocr_assets"]["invalid"], ["eng.traineddata.gz"])

    def test_transcription_states(self):
        root = make_root(self.tmp)
        self.assertEqual(D.check_voice({})["status"], "not_configured")
        self.assertEqual(D.check_voice({"transcribe_command": "not a list"})["status"], "error")
        self.assertEqual(D.check_voice({"transcribe_command": ["relative.exe", "{input}"]})["status"], "error")
        self.assertEqual(D.check_voice({"transcribe_command": [os.path.join(self.tmp, "missing.exe")]})["status"], "unavailable")
        exe = os.path.join(self.tmp, "engine.exe")
        Path(exe).write_text("x")
        self.assertEqual(D.check_voice({"transcribe_command": [exe, "{input}"]})["status"], "ok")
        cfg = dict(self.config, transcribe_command=[os.path.join(self.tmp, "missing.exe")])
        self.assertEqual(self.ready(root, config=cfg)["status"], "degraded")

    def test_missing_required_module(self):
        with mock.patch.dict(sys.modules):
            sys.modules.pop("hq_carnet_reader", None)
            r = self.ready(make_root(self.tmp))
        self.assertEqual(r["checks"]["modules"]["status"], "error")
        self.assertEqual(r["status"], "not_ready")

    def test_readiness_never_writes(self):
        root = make_root(self.tmp)
        before = sorted(str(p) for p in Path(self.tmp).rglob("*"))
        with mock.patch("builtins.open", wraps=open) as op:
            self.ready(root)
            for call in op.call_args_list:
                mode = call.args[1] if len(call.args) > 1 else call.kwargs.get("mode", "r")
                self.assertTrue(set(str(mode)) <= set("rb"), f"readiness opened a file for writing: {call}")
        self.assertEqual(before, sorted(str(p) for p in Path(self.tmp).rglob("*")))

    def test_readiness_output_has_no_secret_or_full_path(self):
        root = make_root(self.tmp)
        blob = json.dumps(self.ready(root))
        self.assertNotIn(SECRET, blob)
        self.assertNotIn(self.tmp, blob)


class FakeCarnet:
    """Stand-in for the hq_carnet module's read paths (so Reader / Ask / read failures can be forced)."""

    def __init__(self, get=(200, {}), reader=(404, "", {"error": "x", "code": "reader_unknown"}), ask=(200, {}), raises=None):
        self.get, self.reader, self.ask, self.raises, self.calls = get, reader, ask, raises, []

    def http_get(self, qs):
        self.calls.append("get")
        if self.raises == "get":
            raise RuntimeError("boom " + SECRET)
        return self.get

    def http_reader_pdf(self, qs):
        self.calls.append("reader")
        if self.raises == "reader":
            raise OSError("disk gone")
        return self.reader

    def http_post(self, body):
        self.calls.append("ask")
        if self.raises == "ask":
            raise ValueError("bad")
        return self.ask


class SubsystemFailureInjection(Base):
    def subs(self, root, carnet=None):
        return D.subsystems(root=root, config=self.config, carnet=carnet or FakeCarnet(), asset_names=ASSETS)["subsystems"]

    def test_all_ok_and_unconfigured_are_distinguished(self):
        s = self.subs(make_root(self.tmp))
        self.assertEqual((s["carnet_read"]["status"], s["reader"]["status"], s["ask_search"]["status"]), ("ok", "ok", "ok"))
        for name in D.CARNET_STORES:  # nothing created yet: NOT "ok" (misleading) and NOT failed
            self.assertEqual(s[name]["status"], "not_configured", name)
        self.assertEqual(s["transcription"]["status"], "not_configured")

    def test_simulated_internal_exception_is_classified_not_propagated(self):
        root = make_root(self.tmp)
        for where, key in (("get", "carnet_read"), ("reader", "reader"), ("ask", "ask_search")):
            s = self.subs(root, FakeCarnet(raises=where))
            self.assertEqual(s[key]["status"], "error", key)
            self.assertIn("type", s[key])
            self.assertNotIn(SECRET, json.dumps(s))  # exception TEXT is never copied into the result

    def test_reader_failure_modes(self):
        root = make_root(self.tmp)
        self.assertEqual(self.subs(root, FakeCarnet(reader=(500, "", {"error": "x"})))["reader"]["status"], "error")
        self.assertEqual(self.subs(root, FakeCarnet(reader=(503, "", {"error": "x", "code": "storage_error"})))["reader"]["status"], "unavailable")
        self.assertEqual(self.subs(root, FakeCarnet(reader=(200, "n.pdf", object())))["reader"]["status"], "error")  # an unidentified 200 is wrong

    def test_carnet_storage_error_is_unavailable(self):
        s = self.subs(make_root(self.tmp), FakeCarnet(get=(503, {"code": "storage_error"})))
        self.assertEqual(s["carnet_read"]["status"], "unavailable")
        self.assertEqual(s["carnet_read"]["code"], "storage_error")

    def test_read_paths_are_not_exercised_without_a_notebook(self):
        fc = FakeCarnet()
        s = self.subs(make_root(self.tmp, notebook=False), fc)
        self.assertEqual(fc.calls, [], "the real read path seeds notebook.json on a fresh root: diagnostics must not trigger that")
        self.assertEqual(s["carnet_read"]["status"], "not_configured")

    def test_corrupt_store_json_and_unreadable_dirs(self):
        root = make_root(self.tmp)
        Path(root, ".hq-carnet", "history.json").write_text("{not json", encoding="utf-8")
        Path(root, ".hq-carnet", "sources.json").write_text("{}", encoding="utf-8")
        os.makedirs(os.path.join(root, ".hq-carnet", "reviews"))
        Path(root, ".hq-carnet", "verifications").write_text("a file where a directory belongs")
        s = self.subs(root)
        self.assertEqual(s["history"]["status"], "error")
        self.assertEqual(s["sources"]["status"], "ok")
        self.assertEqual(s["reviews"]["status"], "ok")
        self.assertEqual(s["verifications"]["status"], "unavailable")

    def test_root_missing_everything_unavailable(self):
        root = make_root(self.tmp)
        shutil.rmtree(root)
        s = self.subs(root)
        self.assertTrue(all(v["status"] == "unavailable" for k, v in s.items() if k in ("carnet_read", "reader", "ask_search", "history", "media")))

    def test_counts_cover_every_status_type_seen(self):
        res = D.subsystems(root=make_root(self.tmp), config=self.config, carnet=FakeCarnet(raises="get"), asset_names=ASSETS)
        self.assertEqual(sum(res["counts"].values()), len(res["subsystems"]))


class WriteProbe(Base):
    def files(self, root):
        return sorted(str(p.relative_to(root)) for p in Path(root).rglob("*"))

    def test_success_leaves_no_trace_and_names_every_step(self):
        root = make_root(self.tmp)
        before = self.files(root)
        res = D.write_probe(root)
        self.assertEqual(res["status"], "ok")
        self.assertEqual([s["step"] for s in res["steps"]], ["root_exists", "no_symlinks", "mkdir", "write_tmp", "fsync", "atomic_replace", "read_back", "remove", "verify_removed"])
        self.assertEqual(self.files(root), before, "success must leave no probe file and no new directory")

    def test_fresh_root_dirs_created_by_the_probe_are_removed(self):
        root = make_root(self.tmp, notebook=False)
        self.assertEqual(D.write_probe(root)["status"], "ok")
        self.assertFalse(os.path.exists(os.path.join(root, ".hq-carnet")))

    def test_never_touches_real_records(self):
        root = make_root(self.tmp)
        nb = os.path.join(root, ".hq-carnet", "notebook.json")
        Path(nb).write_text('{"real": "record"}', encoding="utf-8")
        h = hashlib.sha256(Path(nb).read_bytes()).hexdigest()
        mt = os.stat(nb).st_mtime_ns
        D.write_probe(root)
        self.assertEqual(hashlib.sha256(Path(nb).read_bytes()).hexdigest(), h)
        self.assertEqual(os.stat(nb).st_mtime_ns, mt)

    def test_each_failing_step_is_named_exactly(self):
        for step, patch_target, exc in (
            ("fsync", "os.fsync", OSError("disk")),
            ("atomic_replace", "os.replace", PermissionError("ro")),
        ):
            with self.subTest(step=step):
                root = make_root(tempfile.mkdtemp(dir=self.tmp))
                with mock.patch(patch_target, side_effect=exc):
                    res = D.write_probe(root)
                self.assertEqual((res["status"], res["failed_step"]), ("error", step))
                left = [p for p in Path(root, ".hq-carnet", "diagnostics").glob(D.PROBE_PREFIX + "*")] if os.path.isdir(os.path.join(root, ".hq-carnet", "diagnostics")) else []
                self.assertEqual(left, [], "a failed probe must clean up after itself")

    def test_unwritable_location_simulated_permission_error_on_write(self):
        root = make_root(self.tmp)
        real_open = open

        def deny(path, mode="r", *a, **k):
            if "w" in str(mode) and D.PROBE_PREFIX in str(path):
                raise PermissionError(13, "read-only file system")
            return real_open(path, mode, *a, **k)
        with mock.patch("builtins.open", side_effect=deny):
            res = D.write_probe(root)
        self.assertEqual((res["status"], res["failed_step"]), ("error", "write_tmp"))

    def test_data_dir_is_a_file_fails_at_mkdir(self):
        root = make_root(self.tmp, notebook=False)
        Path(root, ".hq-carnet").write_text("file")
        res = D.write_probe(root)
        self.assertEqual((res["status"], res["failed_step"]), ("error", "mkdir"))

    def test_read_back_mismatch_and_removal_not_verified(self):
        root = make_root(self.tmp)
        real_open = open

        def corrupt(path, mode="r", *a, **k):
            fh = real_open(path, mode, *a, **k)
            if "rb" == mode and str(path).endswith(".json") and D.PROBE_PREFIX in str(path):
                import io
                fh.close()
                return io.BytesIO(b"tampered")
            return fh
        with mock.patch("builtins.open", side_effect=corrupt):
            res = D.write_probe(root)
        self.assertEqual((res["status"], res["failed_step"]), ("error", "read_back"))
        root2 = make_root(tempfile.mkdtemp(dir=self.tmp))
        with mock.patch("os.remove", side_effect=lambda p: None):  # removal silently does nothing
            res = D.write_probe(root2)
        self.assertEqual((res["status"], res["failed_step"]), ("error", "verify_removed"))

    def test_missing_root_and_symlink(self):
        self.assertEqual(D.write_probe(os.path.join(self.tmp, "nope"))["status"], "unavailable")
        if os.name != "nt":
            root = make_root(self.tmp, notebook=False)
            real = os.path.join(self.tmp, "elsewhere")
            os.makedirs(real)
            os.symlink(real, os.path.join(root, ".hq-carnet"))
            res = D.write_probe(root)
            self.assertEqual(res["failed_step"], "no_symlinks")
            self.assertEqual(os.listdir(real), [], "a symlinked data dir must not be written through")

    def test_concurrent_probe_is_refused_not_stacked(self):
        root = make_root(self.tmp)
        gate, entered = threading.Event(), threading.Event()
        real_fsync = os.fsync

        def slow(fd):
            entered.set()
            gate.wait(5)
            return real_fsync(fd)
        results: list[dict] = []
        with mock.patch("os.fsync", side_effect=slow):
            t = threading.Thread(target=lambda: results.append(D.write_probe(root)))
            t.start()
            self.assertTrue(entered.wait(5))
            second = D.write_probe(root)
            gate.set()
            t.join(10)
        self.assertEqual(second["note"], "probe_in_progress")
        self.assertEqual(results[0]["status"], "ok")

    def test_stale_probe_files_from_an_earlier_failure_are_cleaned(self):
        root = make_root(self.tmp)
        d = os.path.join(root, ".hq-carnet", "diagnostics")
        os.makedirs(d)
        Path(d, D.PROBE_PREFIX + "deadbeef.tmp").write_text("x")
        Path(d, "keep-me.txt").write_text("not ours")
        self.assertEqual(D.write_probe(root)["status"], "ok")
        self.assertEqual(sorted(os.listdir(d)), ["keep-me.txt"])

    def test_probe_accepts_no_caller_input(self):
        import inspect
        self.assertEqual(list(inspect.signature(D.write_probe).parameters), ["root"])


class ErrorRing(Base):
    def new(self, root=None):
        log = D.ErrorLog()
        if root:
            log.attach(root)
        return log

    def test_ring_is_bounded(self):
        log = self.new()
        for i in range(D.RING_MAX * 5):
            log.record("x", message=f"m{i}")
        self.assertEqual(len(log.recent(10**6)), D.RING_MAX)
        self.assertEqual(log.recent(1)[0]["message"], f"m{D.RING_MAX * 5 - 1}")  # newest first

    def test_file_log_is_bounded_by_rotation(self):
        root = make_root(self.tmp)
        log = self.new(root)
        for i in range(4000):
            log.record("x", exc=ValueError("e" * 300), path="/api/carnet?q=" + "z" * 50)
        d = os.path.join(root, ".hq-carnet", "diagnostics")
        total = sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d))
        self.assertLess(total, D.LOG_ROTATE_BYTES * 2 + 4096)
        self.assertEqual(sorted(os.listdir(d)), ["errors.jsonl", "errors.jsonl.1"])

    def test_never_stores_secrets_paths_bodies_or_query_text(self):
        root = make_root(self.tmp)
        log = self.new(root)
        try:
            raise RuntimeError(f"cannot open {root}/.hq-carnet/notebook.json for user a@b.co token={SECRET}")
        except RuntimeError as e:
            log.record("/api/carnet", exc=e, path="/api/carnet?question=my%20private%20question&pin=424242", status=500)
        blob = json.dumps(log.recent(5)) + Path(root, ".hq-carnet", "diagnostics", "errors.jsonl").read_text(encoding="utf-8")
        for bad in (SECRET, "private", "424242", root, "a@b.co", "question"):
            self.assertNotIn(bad, blob)
        e = log.recent(1)[0]
        self.assertEqual(e["path_category"], "/api/carnet")
        self.assertEqual(e["type"], "RuntimeError")
        self.assertTrue(all(":" in f and "in " in f for f in e["trace"]))
        self.assertTrue(all(os.sep not in f for f in e["trace"]), "frames are file:line in func only")

    def test_include_trace_flag_for_non_admin_views(self):
        log = self.new()
        try:
            raise KeyError("k")
        except KeyError as e:
            log.record("s", exc=e)
        self.assertNotIn("trace", log.recent(1, include_trace=False)[0])
        self.assertTrue(log.recent(1)[0]["trace"])

    def test_errors_survive_a_restart(self):
        root = make_root(self.tmp)
        a = self.new(root)
        a.record("s1", message="first")
        a.record("s2", message="second")
        b = self.new(root)  # a new process re-attaching to the same files
        msgs = [e["message"] for e in b.recent(10)]
        self.assertEqual(msgs, ["second", "first"])
        self.assertTrue(all(e.get("restored") for e in b.recent(10)))

    def test_logging_never_raises_or_creates_the_data_dir(self):
        root = make_root(self.tmp, notebook=False)  # no .hq-carnet
        log = self.new(root)
        self.assertTrue(log.record("s", message="m"))
        self.assertFalse(os.path.exists(os.path.join(root, ".hq-carnet")), "logging must not create the data directory")
        self.assertEqual(len(log.recent(5)), 1)  # still kept in memory
        log.record(object(), exc=object(), message=object(), path=object(), status="x")  # garbage in, no exception out

    def test_unwritable_log_counts_dropped_writes_but_keeps_ring(self):
        root = make_root(self.tmp)
        log = self.new(root)
        with mock.patch("builtins.open", side_effect=PermissionError("ro")):
            log.record("s", message="m")
        self.assertEqual(log.dropped_writes, 1)
        self.assertEqual(len(log.recent(5)), 1)

    def test_startup_fatal_is_scrubbed_and_bounded(self):
        D.record_startup_fatal(self.tmp, f"FATAL: bridge_config.json is malformed\n  Path: {self.tmp}/bridge_config.json\n  Error: {SECRET} " + "x" * 2000)
        txt = Path(self.tmp, D.STARTUP_FATAL_NAME).read_text(encoding="utf-8")
        self.assertNotIn(SECRET, txt)
        self.assertNotIn(self.tmp, txt)
        self.assertLess(len(txt), 700)
        self.assertEqual(D.startup_fatal(self.tmp)["message"][:5], "FATAL")


class Backups(Base):
    def mk_backup(self, root_dir: str, stamp: str, *, notebook: str | None = "{}", readme=True, hashes: str | None = None) -> str:
        p = os.path.join(root_dir, stamp)
        os.makedirs(os.path.join(p, "Carnet"))
        if notebook is not None:
            Path(p, "Carnet", "notebook.json").write_text(notebook, encoding="utf-8")
        if readme:
            Path(p, "README.txt").write_text("Transfert backup", encoding="utf-8")
        if hashes is not None:
            Path(p, "SHA256.txt").write_text(hashes, encoding="utf-8")
        return p

    def cfg(self, bdir, **kw):
        return dict(self.config, backup_dir=bdir, **kw)

    def stamp(self, hours_ago: float) -> str:
        return time.strftime("%Y%m%d_%H%M%S", time.localtime(time.time() - hours_ago * 3600))

    def test_backup_missing_not_configured_empty(self):
        root = make_root(self.tmp)
        self.assertEqual(D.backup_report(config=self.cfg(os.path.join(self.tmp, "nope")), root=root)["status"], "unavailable")
        self.assertEqual(D.backup_report(config=self.cfg(""), root=root)["status"], "not_configured")
        empty = os.path.join(self.tmp, "b")
        os.makedirs(empty)
        r = D.backup_report(config=self.cfg(empty), root=root)
        self.assertEqual((r["status"], r["detail"]), ("degraded", "no_backups_found"))

    def test_recent_vs_stale_and_threshold_documented(self):
        root, b = make_root(self.tmp), os.path.join(self.tmp, "b")
        os.makedirs(b)
        self.mk_backup(b, self.stamp(2))
        r = D.backup_report(config=self.cfg(b), root=root)
        self.assertEqual(r["status"], "ok")
        self.assertTrue(r["latest"]["carnet_included"])
        self.assertFalse(r["checksum_available"], "the legacy backup writes no checksum: must be reported honestly")
        self.assertEqual(r["verified"], "not_run")
        shutil.rmtree(os.path.join(b, os.listdir(b)[0]))
        self.mk_backup(b, self.stamp(80))
        r = D.backup_report(config=self.cfg(b), root=root)
        self.assertEqual((r["status"], r["detail"]), ("degraded", "backup_stale"))
        self.assertEqual(r["stale_after_hours"], 36.0)
        r = D.backup_report(config=self.cfg(b, backup_every_hours=48), root=root)
        self.assertEqual(r["stale_after_hours"], 72.0)

    def test_existence_alone_is_not_health_verify_detects_corruption_and_hash_mismatch(self):
        root, b = make_root(self.tmp), os.path.join(self.tmp, "b")
        os.makedirs(b)
        p = self.mk_backup(b, self.stamp(1), notebook="{broken")
        self.assertEqual(D.backup_report(config=self.cfg(b), root=root)["status"], "ok")  # existence says ok …
        r = D.backup_report(config=self.cfg(b), root=root, verify=True)  # … verification says otherwise
        self.assertEqual((r["status"], r["detail"]), ("error", "verification_failed"))
        self.assertEqual(r["verified"]["carnet_notebook"], "json_corrupt")
        shutil.rmtree(p)
        data = "{}"
        p = self.mk_backup(b, self.stamp(1), notebook=data, hashes=hashlib.sha256(b"WRONG").hexdigest() + "  Carnet/notebook.json\n")
        r = D.backup_report(config=self.cfg(b), root=root, verify=True)
        self.assertEqual(r["verified"]["checksums"], "mismatch")
        self.assertEqual(r["status"], "error")
        Path(p, "SHA256.txt").write_text(hashlib.sha256(data.encode()).hexdigest() + "  Carnet/notebook.json\n")
        r = D.backup_report(config=self.cfg(b), root=root, verify=True)
        self.assertEqual((r["verified"]["checksums"], r["status"]), ("match", "ok"))

    def test_hash_file_path_traversal_is_not_followed(self):
        root, b = make_root(self.tmp), os.path.join(self.tmp, "b")
        os.makedirs(b)
        outside = os.path.join(self.tmp, "outside.txt")
        Path(outside).write_text("x")
        self.mk_backup(b, self.stamp(1), hashes=hashlib.sha256(b"x").hexdigest() + "  ../../outside.txt\n")
        self.assertEqual(D.backup_report(config=self.cfg(b), root=root, verify=True)["verified"]["checksums"], "mismatch")

    def test_unparseable_timestamp_and_future_timestamp(self):
        root, b = make_root(self.tmp), os.path.join(self.tmp, "b")
        os.makedirs(b)
        self.mk_backup(b, "20991231_235959")
        self.assertEqual(D.backup_report(config=self.cfg(b), root=root)["detail"], "timestamp_in_future")

    def test_report_omits_config_secrets_and_full_paths(self):
        root, b = make_root(self.tmp), os.path.join(self.tmp, "b")
        os.makedirs(b)
        self.mk_backup(b, self.stamp(1))
        blob = json.dumps(D.backup_report(config=self.cfg(b), root=root, verify=True))
        self.assertNotIn(SECRET, blob)
        self.assertNotIn(self.tmp, blob)

    def test_deployment_backups_rollback_sha(self):
        root = make_root(self.tmp)
        d = os.path.join(root, "_backup_pre-457c665_20261007T0057Z")
        os.makedirs(d)
        Path(d, "ROLLBACK-SHA.txt").write_text("f8c2ceec5548535f1575fcd7d23d4ca1b5cafd0d\n")
        Path(d, "hq-carnet-data.tar.gz").write_bytes(b"data")
        Path(d, "SHA256.txt").write_text(hashlib.sha256(b"data").hexdigest() + "  hq-carnet-data.tar.gz\n")
        r = D.deployment_backups(root, verify=True)
        self.assertEqual(r["count"], 1)
        self.assertTrue(r["latest"]["rollback_sha_valid"])
        self.assertEqual(r["latest"]["hashes"], "match")
        self.assertFalse(r["latest"]["members"]["tracked-worktree-as-deployed.tar.gz"])
        Path(d, "ROLLBACK-SHA.txt").write_text("not-a-sha")
        self.assertFalse(D.deployment_backups(root)["latest"]["rollback_sha_valid"])
        Path(d, "hq-carnet-data.tar.gz").write_bytes(b"tampered")
        self.assertEqual(D.deployment_backups(root, verify=True)["latest"]["hashes"], "mismatch")
        self.assertEqual(D.deployment_backups(os.path.join(self.tmp, "nope"))["count"], 0)

    def test_label_dir_hides_full_path(self):
        self.assertEqual(D._label_dir("D:/Backups/Transfert"), "D:/…/Transfert")
        self.assertEqual(D._label_dir("D:\\Backups\\Transfert\\"), "D:/…/Transfert")


class RequiredAssets(unittest.TestCase):
    def test_extracts_asset_names_from_real_html_bytes_or_str(self):
        html = b'<script src="/assets/a.js"></script><link href="/assets/b.css"/> load(\'/assets/c-d.js\')'
        self.assertEqual(D.required_assets(lambda: html), ["a.js", "b.css", "c-d.js"])
        self.assertEqual(D.required_assets(lambda: html.decode()), ["a.js", "b.css", "c-d.js"])
        self.assertEqual(D.required_assets(None), [])

        def boom():
            raise RuntimeError
        self.assertEqual(D.required_assets(boom), [])


if __name__ == "__main__":
    unittest.main()
