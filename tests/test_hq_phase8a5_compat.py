"""Phase 8A.5 pre-cutover compatibility hardening tests:
- Task 1: Shared configurable ACE-Step root (legacy + split layout + traversal/link refusal + engine check)
- Task 2: AI LoRA path separation (mutable .hq-ai state vs external immutable checkpoints)
- Task 4: P5-22 bounded retry on transient Windows PermissionError in hq_state.write_json_atomic
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import hq_ai
import hq_engine
import hq_music_studio
import hq_state


def _make_fake_ace(base: Path) -> Path:
    py = base / ".venv" / "Scripts" / "python.exe"
    py.parent.mkdir(parents=True, exist_ok=True)
    py.write_bytes(b"")
    ckpt = base / "checkpoints" / "acestep_stub.safetensors"
    ckpt.parent.mkdir(parents=True, exist_ok=True)
    ckpt.write_bytes(b"stub-model")
    return base


class AceStepResolutionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-ace-compat-")
        self.root = Path(self.tmp.name)
        self._orig_code = hq_music_studio._code_root
        self._orig_cfg = hq_music_studio._config_getter
        self._orig_eng_state = hq_engine._state_root
        self._orig_eng_cfg = hq_engine._config_getter
        self._orig_ace_dir = hq_engine.ACE_DIR
        self._orig_studio_dir = hq_engine.STUDIO_DIR

    def tearDown(self):
        hq_music_studio._code_root = self._orig_code
        hq_music_studio._config_getter = self._orig_cfg
        hq_engine._state_root = self._orig_eng_state
        hq_engine._config_getter = self._orig_eng_cfg
        hq_engine.ACE_DIR = self._orig_ace_dir
        hq_engine.STUDIO_DIR = self._orig_studio_dir
        self.tmp.cleanup()

    def test_legacy_single_root_layout_resolves_and_finds_model_file(self):
        legacy = self.root / "legacy"
        ace = _make_fake_ace(legacy / "ACE-Step-1.5")
        resolved, src, err = hq_music_studio.resolve_ace_root(state_root=legacy, code_root=legacy, config={}, env={})
        self.assertEqual(err, "")
        self.assertEqual(src, "state_root")
        self.assertEqual(resolved, ace.resolve())
        self.assertTrue((resolved / "checkpoints" / "acestep_stub.safetensors").is_file())

    def test_split_layout_uses_configured_shared_ace_root_for_studio_and_engine(self):
        release = self.root / "release"
        state = self.root / "state"
        ext_ace = _make_fake_ace(self.root / "shared-models" / "ACE-Step-1.5")
        release.mkdir()
        state.mkdir()

        cfg = {"ace_step_root": str(ext_ace)}
        hq_music_studio.configure(code_root=release, config_getter=lambda: cfg)
        hq_engine._state_root = state
        hq_engine._config_getter = lambda: cfg
        hq_engine.ACE_DIR = hq_engine.PROJECT_ROOT / "ACE-Step-1.5"

        resolved, src, err = hq_music_studio.resolve_ace_root(state_root=state, code_root=release, config=cfg, env={})
        self.assertEqual((src, err), ("config", ""))
        self.assertEqual(resolved, ext_ace.resolve())
        self.assertTrue((resolved / "checkpoints" / "acestep_stub.safetensors").is_file())

        # Create a finished job under StateRoot/.hq-music/studio and confirm hq_engine finds it there.
        job_dir = state / ".hq-music" / "studio" / ("a" * 32)
        job_dir.mkdir(parents=True)
        (job_dir / "job.json").write_text(json.dumps({"id": "a" * 32}), encoding="utf-8")
        (job_dir / "result.json").write_text(json.dumps({"status": "completed", "elapsed_seconds": 12.4}), encoding="utf-8")

        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HQ_ACESTEP_ROOT", None)
            with mock.patch.object(hq_engine, "_find_by_hint", return_value=None):
                chk = hq_engine.music_check()
        self.assertEqual(chk["state"], "idle")
        self.assertEqual(chk["facts"].get("Source ACE-Step"), "config")
        self.assertEqual(chk["facts"].get("Dernière création"), "terminée")

    def test_env_overrides_config_and_invalid_explicit_fails_closed(self):
        state = self.root / "state"
        _make_fake_ace(state / "ACE-Step-1.5")
        env_ace = _make_fake_ace(self.root / "env-ace")

        resolved, src, err = hq_music_studio.resolve_ace_root(
            state_root=state, config={"ace_step_root": str(self.root / "missing")}, env={"HQ_ACESTEP_ROOT": str(env_ace)}
        )
        self.assertEqual((resolved, src, err), (env_ace.resolve(), "env", ""))

        # Invalid explicit env must NOT silently fall back to state_root/ACE-Step-1.5
        for bad in ("relative/path", str(self.root / ".." / "escape"), str(self.root / "does-not-exist")):
            r2, src2, err2 = hq_music_studio.resolve_ace_root(state_root=state, config={}, env={"HQ_ACESTEP_ROOT": bad})
            self.assertIsNone(r2, bad)
            self.assertEqual(src2, "env_invalid")
            self.assertTrue(err2)

        # Missing venv inside configured dir fails closed with clear message
        empty_dir = self.root / "empty-ace"
        empty_dir.mkdir()
        r3, src3, err3 = hq_music_studio.resolve_ace_root(state_root=state, config={"ace_step_root": str(empty_dir)}, env={})
        self.assertIsNone(r3)
        self.assertEqual(src3, "config_missing_venv")
        self.assertIn(".venv", err3)


class LoraPathSeparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-lora-compat-")
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_legacy_and_separated_lora_roots_preserve_mutable_state(self):
        state = self.root / "state"
        mutable = state / ".hq-ai"
        mutable.mkdir(parents=True)
        (mutable / "transferania.json").write_text('{"v":1}', encoding="utf-8")

        # Legacy fallback when unconfigured
        st_leg = hq_ai.lora_storage_status(state_root=state, config={}, env={})
        self.assertTrue(st_leg["ok"])
        self.assertEqual(st_leg["source"], "state_root_legacy")
        self.assertFalse(st_leg["separated"])

        # Separated external immutable LoRA checkpoints root
        ext_loras = self.root / "models" / "companion-loras"
        else_out = ext_loras / "else_lora_output"
        else_out.mkdir(parents=True)
        (else_out / "else_char.safetensors").write_bytes(b"stub-lora")

        st_sep = hq_ai.lora_storage_status(state_root=state, config={"lora_models_root": str(ext_loras)}, env={})
        self.assertTrue(st_sep["ok"])
        self.assertEqual(st_sep["source"], "config")
        self.assertTrue(st_sep["separated"])
        self.assertEqual(st_sep["checkpoints_count"], 1)
        self.assertIn("else_lora_output/else_char.safetensors", st_sep["checkpoints_sample"])
        # Mutable runtime file untouched and still under StateRoot/.hq-ai
        self.assertEqual((mutable / "transferania.json").read_text(encoding="utf-8"), '{"v":1}')

    def test_lora_traversal_and_relative_paths_rejected(self):
        state = self.root / "state"
        (state / ".hq-ai").mkdir(parents=True)
        for bad in ("relative/loras", str(self.root / ".." / "escape"), str(self.root / "nope")):
            p, src, err = hq_ai.resolve_lora_root(state_root=state, config={"lora_models_root": bad}, env={})
            self.assertIsNone(p, bad)
            self.assertEqual(src, "config_invalid")
            self.assertTrue(err)


class AtomicWriteRetryFaultInjectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-p522-retry-")
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_transient_permission_error_recovers_atomically(self):
        dest = self.root / "state.json"
        dest.write_text('{"v": 1}\n', encoding="utf-8")
        real_replace = os.replace
        calls = {"n": 0}

        def flaky_replace(src, dst):
            calls["n"] += 1
            if calls["n"] <= 2:
                raise PermissionError(13, "transient sharing violation")
            return real_replace(src, dst)

        with mock.patch.object(hq_state.os, "name", "nt"), \
             mock.patch.object(hq_state.os, "replace", side_effect=flaky_replace), \
             mock.patch.object(hq_state.time, "sleep") as sleep_mock:
            hq_state.write_json_atomic(dest, {"v": 2})

        self.assertEqual(calls["n"], 3)
        self.assertEqual(sleep_mock.call_count, 2)
        self.assertEqual(json.loads(dest.read_text(encoding="utf-8")), {"v": 2})
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_persistent_permission_error_raises_cleans_tmp_and_preserves_dest(self):
        dest = self.root / "state.json"
        original = '{"v": 1}\n'
        dest.write_text(original, encoding="utf-8")
        calls = {"n": 0}

        def always_denied(src, dst):
            calls["n"] += 1
            raise PermissionError(13, "persistent lock")

        with mock.patch.object(hq_state.os, "name", "nt"), \
             mock.patch.object(hq_state.os, "replace", side_effect=always_denied), \
             mock.patch.object(hq_state.time, "sleep") as sleep_mock:
            with self.assertRaises(PermissionError):
                hq_state.write_json_atomic(dest, {"v": 99})

        self.assertEqual(calls["n"], hq_state._REPLACE_RETRIES)
        self.assertEqual(sleep_mock.call_count, hq_state._REPLACE_RETRIES - 1)
        self.assertEqual(dest.read_text(encoding="utf-8"), original)
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_non_permission_oserror_does_not_retry_and_preserves_dest(self):
        dest = self.root / "state.json"
        original = '{"v": 1}\n'
        dest.write_text(original, encoding="utf-8")
        calls = {"n": 0}

        def disk_full(src, dst):
            calls["n"] += 1
            raise OSError(28, "No space left on device")

        with mock.patch.object(hq_state.os, "name", "nt"), \
             mock.patch.object(hq_state.os, "replace", side_effect=disk_full), \
             mock.patch.object(hq_state.time, "sleep") as sleep_mock:
            with self.assertRaises(OSError):
                hq_state.write_json_atomic(dest, {"v": 99})

        self.assertEqual(calls["n"], 1)
        self.assertEqual(sleep_mock.call_count, 0)
        self.assertEqual(dest.read_text(encoding="utf-8"), original)
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_concurrent_writers_under_transient_permission_errors(self):
        dest = self.root / "concurrent.json"
        dest.write_text('{"seq": 0}\n', encoding="utf-8")
        real_replace = os.replace
        lock = threading.Lock()
        counter = {"n": 0}
        errors: list[Exception] = []

        def flaky_replace(src, dst):
            with lock:
                counter["n"] += 1
                fail = (counter["n"] % 3) == 1
            if fail:
                raise PermissionError(13, "transient")
            return real_replace(src, dst)

        def worker(tid: int):
            for step in range(5):
                try:
                    hq_state.write_json_atomic(dest, {"tid": tid, "step": step})
                except Exception as exc:
                    errors.append(exc)

        with mock.patch.object(hq_state.os, "name", "nt"), \
             mock.patch.object(hq_state.os, "replace", side_effect=flaky_replace), \
             mock.patch.object(hq_state.time, "sleep"):
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

        self.assertEqual(errors, [])
        parsed = json.loads(dest.read_text(encoding="utf-8"))
        self.assertIn("tid", parsed)
        self.assertEqual(list(self.root.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
