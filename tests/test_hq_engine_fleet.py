"""Engine fleet: pairing, signed reports, validation, admin view, and the agent end to end (no network, fake clock)."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["HQ_ENGINE_FLEET_TEST_PLAINTEXT"] = "1"
import hq_engine as eng  # noqa: E402
import hq_engine_fleet as fleet  # noqa: E402
import hq_forge_worker as wire  # noqa: E402

_spec = importlib.util.spec_from_file_location("engine_agent", ROOT / "scripts" / "engine_agent.py")
agent_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(agent_mod)


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


def signed(machine_id, secret, body: dict, *, path=fleet.PREFIX + "/report", now=None, method="POST"):
    raw = json.dumps(body, separators=(",", ":")).encode()
    headers = wire.signed_headers(machine_id, secret, method, path, raw, now=now)
    return method, path, headers, raw


class FleetBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="engfleet-"))
        self.clock = Clock()
        fleet.reset_for_tests(self.tmp, clock=self.clock, wrap=False)
        self.addCleanup(lambda: fleet.reset_for_tests(tempfile.mkdtemp(prefix="engfleet-"), wrap=True))

    def pair(self, name="PC salon", ip="100.64.0.9"):
        code = fleet.create_code()["code"]
        status, out = fleet.enroll({"code": code, "name": name}, ip)
        self.assertEqual(status, 200, out)
        return out["machine_id"], out["secret"]

    def report(self, mid, secret, body, **kw):
        m, p, h, raw = signed(mid, secret, body, now=kw.pop("now", self.clock()), **kw)
        return fleet.handle_agent(m, p, h, raw, "100.64.0.9")


GOOD = {"host": "PC-SALON", "os": "Windows 11", "version": 1,
        "system": {"cpu_pct": 12.5, "cpu_count": 8, "ram_total_mb": 16000, "ram_used_mb": 8000, "disk_free_gb": 100, "disk_total_gb": 500,
                   "gpus": [{"name": "RTX 3060", "util_pct": 40, "vram_used_mb": 3000, "vram_total_mb": 12000, "temp_c": 55}]},
        "daemons": [{"id": "forge", "label": "Forge", "kind": "image", "state": "ready", "port": 7860, "pid": 123, "rss_mb": 4000,
                     "vram_mb": 3000, "cpu_pct": 5.5, "uptime_s": 99}]}


class EnrollTests(FleetBase):
    def test_pairing_creates_a_machine_and_consumes_the_code(self):
        code = fleet.create_code()["code"]
        self.assertRegex(code, r"^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$")
        status, out = fleet.enroll({"code": code, "name": "  Bureau\n"}, "1.2.3.4")
        self.assertEqual(status, 200)
        self.assertRegex(out["machine_id"], r"^pc_[0-9a-f]{16}$")
        self.assertEqual(len(out["secret"]), 64)
        self.assertEqual(fleet.enroll({"code": code, "name": "again"}, "1.2.3.4")[0], 403)    # single use
        self.assertEqual(fleet.machines_view()[0]["name"], "Bureau")

    def test_code_is_stored_hashed_only(self):
        code = fleet.create_code()["code"]
        text = (self.tmp / ".hq-engine" / "machines.json").read_text()
        self.assertNotIn(code.replace("-", ""), text)
        self.assertNotIn(code, text)

    def test_wrong_and_expired_codes(self):
        code = fleet.create_code()["code"]
        self.assertEqual(fleet.enroll({"code": "AAAA-BBBB-CCCC"}, "1.1.1.1")[0], 403)
        self.clock.t += fleet.CODE_TTL_SEC + 1
        self.assertEqual(fleet.enroll({"code": code}, "1.1.1.1")[0], 403)

    def test_enroll_rate_limit_per_ip(self):
        for _ in range(fleet.ENROLL_MAX_PER_IP):
            self.assertEqual(fleet.enroll({"code": "NOPE"}, "9.9.9.9")[0], 403)
        self.assertEqual(fleet.enroll({"code": "NOPE"}, "9.9.9.9")[0], 429)
        self.assertEqual(fleet.enroll({"code": "NOPE"}, "8.8.8.8")[0], 403)                  # other IPs are unaffected

    def test_machine_cap(self):
        for i in range(fleet.MAX_MACHINES):
            self.pair(name=f"pc{i}", ip=f"10.0.0.{i}")
        code = fleet.create_code()["code"]
        self.assertEqual(fleet.enroll({"code": code}, "10.9.9.9")[0], 409)

    def test_secret_protection_failure_changes_nothing(self):
        code = fleet.create_code()["code"]
        old = fleet._wrap
        fleet._wrap = lambda s: None
        self.addCleanup(lambda: setattr(fleet, "_wrap", old))
        self.assertEqual(fleet.enroll({"code": code}, "1.1.1.1")[0], 503)
        self.assertEqual(fleet.machines_view(), [])
        fleet._wrap = old
        self.assertEqual(fleet.enroll({"code": code}, "1.1.1.1")[0], 200)                    # the code was NOT consumed


class AuthTests(FleetBase):
    def test_signed_report_is_accepted(self):
        mid, secret = self.pair()
        self.assertEqual(self.report(mid, secret, GOOD)[0], 200)

    def test_rejections(self):
        mid, secret = self.pair()
        m, p, h, raw = signed(mid, secret, GOOD, now=self.clock())
        self.assertEqual(fleet.handle_agent(m, p, h, raw, "x")[0], 200)
        self.assertEqual(fleet.handle_agent(m, p, h, raw, "x")[0], 401)                      # replay (same nonce)
        self.assertEqual(self.report(mid, "0" * 64, GOOD)[0], 401)                           # wrong secret
        self.assertEqual(self.report("pc_" + "0" * 16, secret, GOOD)[0], 401)                # unknown machine
        self.assertEqual(self.report(mid, secret, GOOD, now=self.clock() - 500)[0], 401)     # clock skew
        m, p, h, raw = signed(mid, secret, GOOD, now=self.clock())
        self.assertEqual(fleet.handle_agent(m, p, h, raw + b" ", "x")[0], 401)               # body tampered
        m, p, h, raw = signed(mid, secret, GOOD, now=self.clock())
        self.assertEqual(fleet.handle_agent(m, fleet.PREFIX + "/enroll", h, raw, "x")[0] in (401, 403), True)  # path swapped

    def test_forge_worker_signature_does_not_work_here(self):
        mid, secret = self.pair()
        path = "/forge-worker/v1/report"
        raw = b"{}"
        h = wire.signed_headers(mid, secret, "POST", path, raw, now=self.clock())
        self.assertEqual(fleet.handle_agent("POST", path, h, raw, "x")[0], 404)

    def test_method_size_and_json(self):
        mid, secret = self.pair()
        self.assertEqual(fleet.handle_agent("GET", fleet.PREFIX + "/report", {}, b"", "x")[0], 405)
        self.assertEqual(fleet.handle_agent("POST", fleet.PREFIX + "/report", {}, b"x" * (fleet.REPORT_MAX + 1), "x")[0], 413)
        self.assertEqual(fleet.handle_agent("POST", fleet.PREFIX + "/report", {}, b"{nope", "x")[0], 400)
        self.assertEqual(fleet.handle_agent("POST", fleet.PREFIX + "/report", {}, b"[]", "x")[0], 400)
        self.assertEqual(fleet.handle_agent("POST", fleet.PREFIX + "/nope", {}, b"{}", "x")[0], 404)

    def test_removed_machine_is_locked_out(self):
        mid, secret = self.pair()
        self.assertEqual(self.report(mid, secret, GOOD)[0], 200)
        self.assertEqual(fleet.remove(mid)[0], 200)
        self.assertEqual(self.report(mid, secret, GOOD)[0], 401)
        self.assertEqual(fleet.remove(mid)[0], 404)


class ReportTests(FleetBase):
    def test_validation_clips_and_drops(self):
        mid, secret = self.pair()
        evil = {"host": "H" * 500 + "\x00\x1b[31m", "os": 5, "version": True,
                "system": {"cpu_pct": 900, "ram_total_mb": "lots", "ram_used_mb": float("nan"), "disk_free_gb": -4, "junk": {"x": 1},
                           "gpus": [{"name": "G" * 200, "util_pct": 101, "vram_used_mb": 5}, {"name": 7}, "str"] + [{"name": "x"}] * 9},
                "daemons": [{"id": "../etc", "label": "bad id"}, {"id": "ok", "label": "<img src=x onerror=1>", "kind": "evil", "state": "pwned",
                                                                 "port": 70000, "pid": True, "rss_mb": 12.7, "note": "n" * 999}] +
                           [{"id": f"d{i}", "state": "ready"} for i in range(40)]}
        self.assertEqual(self.report(mid, secret, evil)[0], 200)
        v = fleet.machines_view()[0]
        self.assertLessEqual(len(v["host"]), 40)
        self.assertNotIn("\x00", v["host"])
        self.assertIsNone(v["os"])
        self.assertEqual(v["system"].get("cpu_pct"), None)                                  # 900 is out of range
        self.assertNotIn("ram_total_mb", v["system"])
        self.assertNotIn("ram_used_mb", v["system"])
        self.assertNotIn("disk_free_gb", v["system"])
        self.assertNotIn("junk", v["system"])
        self.assertEqual(len(v["system"]["gpus"]), 4)
        self.assertEqual(v["system"]["gpus"][0]["name"], "G" * 60)
        self.assertNotIn("util_pct", v["system"]["gpus"][0])
        self.assertEqual(len(v["daemons"]), fleet.MAX_DAEMONS)
        ok = v["daemons"][0]
        self.assertEqual((ok["id"], ok["kind"], ok["state"]), ("ok", "service", "error"))
        self.assertEqual(ok["label"], "<img src=x onerror=1>")                              # kept as TEXT; the UI never uses innerHTML
        self.assertNotIn("port", ok)
        self.assertNotIn("pid", ok)
        self.assertEqual(ok["rss_mb"], 13)
        self.assertLessEqual(len(ok["note"]), 160)

    def test_view_online_offline_and_no_secrets(self):
        mid, secret = self.pair("Salon")
        self.assertFalse(fleet.machines_view()[0]["online"])
        self.assertIsNone(fleet.machines_view()[0]["seen_ago"])
        self.report(mid, secret, GOOD)
        v = fleet.machines_view()[0]
        self.assertTrue(v["online"])
        self.assertEqual((v["name"], v["host"], v["daemons"][0]["id"]), ("Salon", "PC-SALON", "forge"))
        self.clock.t += fleet.ONLINE_SEC + 5
        v = fleet.machines_view()[0]
        self.assertFalse(v["online"])
        self.assertGreaterEqual(v["seen_ago"], fleet.ONLINE_SEC)
        blob = json.dumps(fleet.machines_view())
        self.assertNotIn(secret, blob)
        self.assertNotIn("secret", blob)

    def test_history_is_bounded(self):
        mid, secret = self.pair()
        for _ in range(fleet.HIST_MAX + 15):
            self.clock.t += 1
            self.report(mid, secret, GOOD)
        h = fleet.machines_view()[0]["history"]
        self.assertEqual((len(h["cpu"]), len(h["ram"])), (fleet.HIST_MAX, fleet.HIST_MAX))
        self.assertEqual(h["ram"][-1], 50.0)

    def test_persistence_across_restart(self):
        mid, secret = self.pair("Salon")
        self.report(mid, secret, GOOD)
        saved_secret = secret
        fleet.reset_for_tests(self.tmp, clock=self.clock, wrap=False)                       # "restart": reload from disk
        v = fleet.machines_view()
        self.assertEqual([m["name"] for m in v], ["Salon"])
        self.assertFalse(v[0]["online"])                                                     # live data is not persisted...
        self.assertIsNotNone(v[0]["seen_ago"])                                               # ...but "last seen" is
        self.assertEqual(self.report(mid, saved_secret, GOOD)[0], 200)                       # and the credentials still work

    def test_rename(self):
        mid, _ = self.pair()
        self.assertEqual(fleet.rename(mid, "Chambre")[0], 200)
        self.assertEqual(fleet.machines_view()[0]["name"], "Chambre")
        self.assertEqual(fleet.rename(mid, "   ")[0], 400)
        self.assertEqual(fleet.rename("pc_" + "1" * 16, "x")[0], 404)
        self.assertEqual(fleet.rename("../x", "x")[0], 404)


@unittest.skipUnless(os.name == "nt", "DPAPI is Windows only")
class DpapiTests(unittest.TestCase):
    def test_secret_is_wrapped_on_disk(self):
        tmp = Path(tempfile.mkdtemp(prefix="engfleet-"))
        fleet.reset_for_tests(tmp, wrap=True)
        self.addCleanup(lambda: fleet.reset_for_tests(tempfile.mkdtemp(prefix="engfleet-"), wrap=True))
        code = fleet.create_code()["code"]
        status, out = fleet.enroll({"code": code, "name": "x"}, "1.1.1.1")
        self.assertEqual(status, 200)
        disk = (tmp / ".hq-engine" / "machines.json").read_text()
        self.assertNotIn(out["secret"], disk)
        self.assertIn('"dpapi"', disk)
        m, p, h, raw = signed(out["machine_id"], out["secret"], GOOD)
        self.assertEqual(fleet.handle_agent(m, p, h, raw, "x")[0], 200)                      # round trip through DPAPI


class AgentEndToEndTests(FleetBase):
    """scripts/engine_agent.py talking to the real handler through an in-memory transport."""

    def transport(self, method, url, timeout, body, headers, max_bytes):
        path = url.split("://", 1)[1].split("/", 1)[1]
        code, payload = fleet.handle_agent(method, "/" + path, headers, body or b"", "100.64.0.5")
        return code, json.dumps(payload).encode()

    def test_pair_then_report(self):
        eng_before = dict(eng._registry)
        self.addCleanup(lambda: (eng._registry.clear(), eng._registry.update(eng_before)))
        self.clock.t = __import__("time").time()                                           # the agent signs with the real clock
        code = fleet.create_code()["code"]
        creds = agent_mod.pair("https://hq.example.ts.net", code, "PC bureau", transport=self.transport)
        self.assertEqual(creds["hq"], "https://hq.example.ts.net")
        agent_mod.register_specs([{"id": "forge", "label": "Forge", "kind": "image", "port": 1, "health_path": "/"},
                                  {"id": "bad id!", "label": "x"}])
        agent_mod.register_specs(agent_mod.load_daemon_specs(self.tmp / "missing.json"))   # defaults when no config file
        agent = agent_mod.Agent(creds["hq"], creds["worker_id"], creds["secret"], transport=self.transport)
        self.assertEqual(agent.report_once()["ok"], True)
        v = fleet.machines_view()[0]
        self.assertEqual(v["name"], "PC bureau")
        self.assertTrue(v["online"])
        self.assertEqual({d["id"] for d in v["daemons"]}, {"forge", "phonon", "xtts"})
        self.assertIn("cpu_count", v["system"])
        self.assertTrue(all(d["state"] in fleet.STATES for d in v["daemons"]))              # real ports: whatever runs here

    def test_agent_never_controls_anything(self):
        agent_mod.register_specs([{"id": "forge", "label": "Forge", "port": 7860}])
        self.addCleanup(eng.register_defaults)
        d = eng.get("forge")
        self.assertTrue(d.observe_only)
        self.assertFalse(any(d.can(a) for a in eng.ACTIONS))

    def test_wrong_code_is_refused_cleanly(self):
        with self.assertRaises(wire.HQError) as cm:
            agent_mod.pair("https://hq.example.ts.net", "AAAA-BBBB-CCCC", "x", transport=self.transport)
        self.assertEqual(cm.exception.status, 403)

    def test_http_hq_url_is_refused(self):
        with self.assertRaises(ValueError):
            agent_mod.pair("http://hq.example.com", "x", "x", transport=self.transport)

    def test_run_loop_backs_off_and_stops(self):
        import threading
        calls, sleeps = [], []
        stop = threading.Event()

        class Bad:
            def report_once(self):
                calls.append(1)
                if len(calls) >= 4:
                    stop.set()
                raise OSError("down")

        agent_mod.run_forever(Bad(), stop=stop, log=lambda m: None, sleep=lambda s: sleeps.append(s))
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(b >= a for a, b in zip(sleeps, sleeps[1:])))                     # exponential backoff, never faster
        self.assertLessEqual(max(sleeps), 60)


class AdminApiTests(FleetBase):
    def test_status_and_routes(self):
        mid, secret = self.pair("Salon")
        self.report(mid, secret, GOOD)
        st = eng.status()
        self.assertTrue(st["fleet"])
        self.assertEqual([m["name"] for m in st["machines"]], ["Salon"])
        self.assertIn("system", st)
        code, out = eng.http_post("/api/engine/machines/code", {})
        self.assertEqual(code, 200)
        self.assertIn("code", out)
        self.assertEqual(eng.http_post(f"/api/engine/machines/{mid}/rename", {"name": "Chambre"})[0], 200)
        self.assertEqual(eng.http_post(f"/api/engine/machines/{mid}/rename", {})[0], 400)
        self.assertEqual(eng.http_post("/api/engine/machines/pc_zzzz/rename", {"name": "x"})[0], 404)
        self.assertEqual(eng.http_post(f"/api/engine/machines/{mid}/remove", {})[0], 200)
        self.assertEqual(eng.status()["machines"], [])


if __name__ == "__main__":
    unittest.main()
