"""Forge Studio F1 adapter. Mock transport only. No socket to a real Forge."""

from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge as F  # noqa: E402


def _body(payload) -> bytes:
    return json.dumps(payload).encode("utf-8")


class Transport:
    def __init__(self, routes: dict[tuple[str, str], tuple[int, bytes] | Exception]):
        self.routes = routes
        self.calls: list[tuple[str, str, float]] = []

    def __call__(self, method: str, url: str, timeout: float) -> tuple[int, bytes]:
        self.calls.append((method, url, timeout))
        if not url.startswith(F.UPSTREAM_ORIGIN + "/"):
            raise AssertionError(url)
        path = url[len(F.UPSTREAM_ORIGIN):]
        query = ""
        if "?" in path:
            path, query = path.split("?", 1)
            path = path
            query = "?" + query
        key = (method, path + query)
        if key not in self.routes and (method, path) in self.routes:
            key = (method, path)
        result = self.routes[key]
        if isinstance(result, Exception):
            raise result
        return result


class Adapter(unittest.TestCase):
    def setUp(self) -> None:
        F.reset_for_tests()

    def test_upstream_is_fixed_loopback(self):
        self.assertEqual(F.UPSTREAM_ORIGIN, "http://127.0.0.1:7860")
        methods = {method for method, _path in F.ALLOWED_ROUTES}
        self.assertEqual(methods, {"GET"})
        paths = {path for _method, path in F.ALLOWED_ROUTES}
        for banned in ("/sdapi/v1/txt2img", "/sdapi/v1/interrupt", "/sdapi/v1/cmd-flags", "/sdapi/v1/scripts"):
            self.assertNotIn(banned, paths)
        self.assertIn(("/sdapi/v1/options", "POST") if False else ("GET", "/sdapi/v1/options"), F.ALLOWED_ROUTES)
        self.assertNotIn(("POST", "/sdapi/v1/options"), F.ALLOWED_ROUTES)

    def test_connection_refused_is_offline(self):
        transport = Transport({("GET", "/sdapi/v1/samplers"): ConnectionRefusedError()})
        got = F.status(transport=transport)
        self.assertEqual(got["forge"], "offline")
        self.assertEqual(got["message"], "Forge n'est pas démarré.")
        self.assertIsNone(got["model"])
        text = json.dumps(got, ensure_ascii=False)
        self.assertNotIn("7860", text)
        self.assertNotIn("\\", text)

    def test_timeout_is_error_and_does_not_call_interrupt(self):
        transport = Transport({("GET", "/sdapi/v1/samplers"): TimeoutError()})
        got = F.status(transport=transport)
        self.assertEqual(got["forge"], "error")
        self.assertEqual(got["code"], "forge_timeout")
        self.assertFalse(any("interrupt" in url for _m, url, _t in transport.calls))

    def test_http_404_is_api_disabled(self):
        transport = Transport({("GET", "/sdapi/v1/samplers"): (404, b"missing")})
        got = F.status(transport=transport)
        self.assertEqual(got["forge"], "api_disabled")
        self.assertEqual(got["message"], "Forge est ouvert, mais son API n'est pas activée.")
        self.assertNotEqual(got["code"], "catalog_empty")

    def test_http_401_does_not_echo_a_body(self):
        transport = Transport({("GET", "/sdapi/v1/samplers"): (401, b"secret-token")})
        got = F.status(transport=transport)
        self.assertEqual(got["forge"], "error")
        self.assertNotIn("secret-token", json.dumps(got))

    def test_malformed_json_is_error(self):
        transport = Transport({("GET", "/sdapi/v1/samplers"): (200, b"not-json")})
        got = F.status(transport=transport)
        self.assertEqual(got["forge"], "error")
        self.assertEqual(got["code"], "forge_malformed")
        self.assertNotIn("not-json", json.dumps(got))

    def test_ready_strips_model_paths_and_preview(self):
        model = {
            "title": "example.safetensors [abcd]",
            "model_name": "example",
            "hash": "abcd",
            "sha256": "ab" * 32,
            "filename": r"C:\secret\models\example.safetensors",
            "config": r"C:\secret\config.yaml",
        }
        progress = {
            "progress": 0,
            "current_image": "QUJD",
            "state": {"job": "", "job_count": 0, "sampling_step": 0, "sampling_steps": 0},
        }
        options = {"sd_model_checkpoint": "example.safetensors", "outdir_samples": r"C:\secret\outputs"}
        transport = Transport({
            ("GET", "/sdapi/v1/samplers"): (200, _body([{"name": "Euler", "aliases": ["euler"], "options": {}}])),
            ("GET", "/sdapi/v1/progress"): (200, _body(progress)),
            ("GET", "/internal/pending-tasks"): (200, _body({"size": 0, "tasks": ["task(foreign)"]})),
            ("GET", "/sdapi/v1/options"): (200, _body(options)),
        })
        got = F.status(transport=transport)
        self.assertEqual(got["forge"], "ready")
        self.assertEqual(got["model"], "example.safetensors")
        blob = json.dumps(got)
        self.assertNotIn("filename", blob)
        self.assertNotIn("QUJD", blob)
        self.assertNotIn("foreign", blob)
        self.assertNotIn("secret", blob)
        self.assertTrue(any("skip_current_image=true" in url for _m, url, _t in transport.calls))

    def test_busy_when_another_job_is_active(self):
        progress = {"progress": 0.2, "current_image": None, "state": {"job": "scripts_txt2img", "job_count": 1}}
        transport = Transport({
            ("GET", "/sdapi/v1/samplers"): (200, _body([{"name": "Euler"}])),
            ("GET", "/sdapi/v1/progress"): (200, _body(progress)),
            ("GET", "/internal/pending-tasks"): (200, _body({"size": 1, "tasks": ["task(other)"]})),
            ("GET", "/sdapi/v1/options"): (200, _body({"sd_model_checkpoint": "example.safetensors"})),
        })
        got = F.status(transport=transport)
        self.assertEqual(got["forge"], "busy")
        self.assertNotIn("other", json.dumps(got))

    def test_catalog_filters_fields_and_caches(self):
        models = [{
            "title": "example.safetensors [abcd]",
            "model_name": "example",
            "hash": "abcd",
            "sha256": "cd" * 32,
            "filename": r"D:\private\model.safetensors",
            "config": r"D:\private\v.yaml",
        }]
        transport = Transport({
            ("GET", "/sdapi/v1/sd-models"): (200, _body(models)),
            ("GET", "/sdapi/v1/samplers"): (200, _body([
                {"name": "Euler", "aliases": ["euler"], "options": {"path": r"C:\x"}},
                {"name": "DPM++ 2M", "aliases": ["k_dpmpp_2m"]},
            ])),
            ("GET", "/sdapi/v1/schedulers"): (200, _body([{"name": "automatic", "label": "Automatic", "aliases": None}])),
        })
        first = F.catalog(transport=transport)
        second = F.catalog(transport=transport)
        self.assertEqual(first, second)
        self.assertEqual(len(transport.calls), 3)
        self.assertEqual(set(first["models"][0]), {"title", "model_name", "hash", "sha256"})
        self.assertNotIn("filename", json.dumps(first))
        self.assertNotIn("private", json.dumps(first))
        self.assertEqual(first["samplers"][0]["name"], "Euler")
        self.assertEqual(first["samplers"][1]["name"], "DPM++ 2M")
        self.assertNotIn("options", first["samplers"][0])
        self.assertEqual(first["schedulers"][0], {"name": "automatic", "label": "Automatic"})

    def test_missing_schedulers_fails_catalog_only(self):
        transport = Transport({
            ("GET", "/sdapi/v1/samplers"): (200, _body([{"name": "Euler"}])),
            ("GET", "/sdapi/v1/progress"): (200, _body({"state": {"job": "", "job_count": 0}})),
            ("GET", "/internal/pending-tasks"): (200, _body({"size": 0, "tasks": []})),
            ("GET", "/sdapi/v1/options"): (200, _body({"sd_model_checkpoint": "example.safetensors"})),
            ("GET", "/sdapi/v1/sd-models"): (200, _body([])),
            ("GET", "/sdapi/v1/schedulers"): (200, _body({"unexpected": True})),
        })
        status = F.status(transport=transport)
        catalog = F.catalog(transport=transport)
        self.assertEqual(status["forge"], "ready")
        self.assertEqual(catalog["forge"], "error")
        self.assertEqual(catalog["schedulers"], [])

    def test_oversized_body_is_rejected(self):
        transport = Transport({("GET", "/sdapi/v1/samplers"): (200, b"{" + b" " * (F.MAX_RESPONSE_BYTES + 8))})
        got = F.status(transport=transport)
        self.assertEqual(got["forge"], "error")

    def test_timeouts_are_bounded(self):
        transport = Transport({("GET", "/sdapi/v1/samplers"): ConnectionRefusedError()})
        F.status(transport=transport)
        self.assertLessEqual(transport.calls[0][2], F.PROBE_TIMEOUT_SEC)

    def test_catalog_cache_is_bounded_and_drops_expired_entries(self):
        F.set_catalog_ttl_for_tests(0.05)
        transports = []
        for index in range(12):
            transport = Transport({
                ("GET", "/sdapi/v1/sd-models"): (200, _body([{"title": "example.safetensors [abcd]", "model_name": "example", "hash": "abcd"}])),
                ("GET", "/sdapi/v1/samplers"): (200, _body([{"name": "Euler"}])),
                ("GET", "/sdapi/v1/schedulers"): (200, _body([{"name": "automatic", "label": "Automatic"}])),
            })
            transport.forge_cache_key = f"slot-{index}"
            transports.append(transport)
            self.assertEqual(F.catalog(transport=transport)["forge"], "ready")
        self.assertLessEqual(F.cache_entry_count_for_tests(), F.MAX_CACHE_ENTRIES)
        time.sleep(0.08)
        again = F.catalog(transport=transports[-1])
        self.assertEqual(again["forge"], "ready")
        self.assertEqual(len(transports[-1].calls), 6)
        self.assertLessEqual(F.cache_entry_count_for_tests(), F.MAX_CACHE_ENTRIES)

    def test_empty_catalog_is_not_a_ready_list(self):
        transport = Transport({
            ("GET", "/sdapi/v1/sd-models"): (200, _body([])),
            ("GET", "/sdapi/v1/samplers"): (200, _body([{"name": "Euler"}])),
            ("GET", "/sdapi/v1/schedulers"): (200, _body([{"name": "automatic", "label": "Automatic"}])),
        })
        got = F.catalog(transport=transport)
        self.assertEqual(got["code"], "catalog_empty")
        self.assertEqual(got["forge"], "error")
        self.assertEqual(got["models"], [])
        self.assertNotEqual(got["code"], "api_disabled")

    def test_upstream_override_rejects_non_loopback(self):
        with self.assertRaises(ValueError):
            F.set_upstream_for_tests("http://evil.example:7860")
        with self.assertRaises(ValueError):
            F.set_upstream_for_tests("http://127.0.0.1:7860/sdapi")
        self.assertEqual(F.UPSTREAM_ORIGIN, "http://127.0.0.1:7860")


if __name__ == "__main__":
    unittest.main()
