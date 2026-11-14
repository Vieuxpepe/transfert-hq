"""Second-screen relay (hq_desk): mailboxes, cursors, long-poll wake-up, peer state, bounds, HTTP adapter."""

from __future__ import annotations

import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_desk as desk  # noqa: E402

PC, PHONE = "a1b2c3d4e5f60718", "0f1e2d3c4b5a6978"


class RelayTests(unittest.TestCase):
    def setUp(self):
        desk.reset_for_tests()

    def test_fresh_poll_has_no_backlog_then_messages_arrive_in_order(self):
        desk.send("pc", "pad", {"op": "begin"}, PHONE)  # before the PC joined: never replayed
        first = desk.poll("pc", PC, -1, 0)
        self.assertEqual(first["messages"], [])
        for i in range(3):
            desk.send("pc", "pad", {"op": "move", "i": i}, PHONE)
        got = desk.poll("pc", PC, first["seq"], 0)
        self.assertEqual([m["data"]["i"] for m in got["messages"]], [0, 1, 2])
        again = desk.poll("pc", PC, got["seq"], 0)
        self.assertEqual(again["messages"], [], "the cursor moves past delivered messages")

    def test_mailboxes_are_separate_and_a_client_never_hears_itself(self):
        start = desk.poll("phone", PHONE, -1, 0)["seq"]
        desk.send("pc", "remote", {"cmd": "toggle"}, PHONE)
        desk.send("phone", "ping", {}, PHONE)
        self.assertEqual(desk.poll("phone", PHONE, start, 0)["messages"], [])

    def test_long_poll_wakes_on_a_message(self):
        cur = desk.poll("pc", PC, -1, 0)["seq"]
        threading.Timer(0.2, lambda: desk.send("pc", "flick", {"rel": "Inbox/Photos/a.jpg"}, PHONE)).start()
        t0 = time.monotonic()
        got = desk.poll("pc", PC, cur, 5)
        self.assertLess(time.monotonic() - t0, 3)
        self.assertEqual(got["messages"][0]["type"], "flick")

    def test_long_poll_wakes_on_peer_state_and_times_out_otherwise(self):
        cur = desk.poll("phone", PHONE, -1, 0)["seq"]
        t0 = time.monotonic()
        quiet = desk.poll("phone", PHONE, cur, 0.3)
        self.assertGreaterEqual(time.monotonic() - t0, 0.25)
        self.assertFalse(quiet["peer"]["online"])
        threading.Timer(0.2, lambda: desk.publish("pc", PC, {"view": "dessiner", "sketch": {"w": 800, "h": 600}})).start()
        got = desk.poll("phone", PHONE, cur, 5)
        self.assertTrue(got["peer"]["online"])
        self.assertEqual(got["peer"]["state"]["view"], "dessiner")

    def test_peer_goes_offline_after_leave(self):
        desk.publish("pc", PC, {"view": "accueil"})
        self.assertTrue(desk.poll("phone", PHONE, -1, 0)["peer"]["online"])
        desk.leave("pc", PC)
        self.assertFalse(desk.poll("phone", PHONE, -1, 0)["peer"]["online"])

    def test_bounds_and_validation(self):
        with self.assertRaises(desk.DeskError):
            desk.send("tv", "pad", {}, PHONE)
        with self.assertRaises(desk.DeskError):
            desk.send("pc", "shell", {}, PHONE)
        with self.assertRaises(desk.DeskError):
            desk.send("pc", "pad", [], PHONE)
        with self.assertRaises(desk.DeskError):
            desk.send("pc", "pad", {"x": "y" * (desk.MSG_BYTES + 10)}, PHONE)
        with self.assertRaises(desk.DeskError):
            desk.send("pc", "pad", {}, "../etc")
        with self.assertRaises(desk.DeskError):
            desk.publish("pc", PC, {"x": "y" * (desk.STATE_BYTES + 10)})
        with self.assertRaises(desk.DeskError):
            desk.poll("pc", PC, True, 0)
        for i in range(desk.QUEUE_MAX + 50):
            desk.send("pc", "pad", {"i": i}, PHONE)
        self.assertLessEqual(len(desk._queues["pc"]), desk.QUEUE_MAX)

    def test_clients_are_bounded(self):
        for i in range(desk.CLIENTS_MAX + 5):
            desk.publish("pc", f"{i:016x}", None)
        self.assertLessEqual(len(desk._clients["pc"]), desk.CLIENTS_MAX)

    def test_old_messages_expire(self):
        cur = desk.poll("pc", PC, -1, 0)["seq"]
        desk.send("pc", "pad", {"op": "move"}, PHONE)
        desk._queues["pc"][0]["t"] -= desk.MSG_TTL + 1
        self.assertEqual(desk.poll("pc", PC, cur, 0)["messages"], [])


class HttpTests(unittest.TestCase):
    def setUp(self):
        desk.reset_for_tests()

    def test_routes(self):
        code, body = desk.http_get("/api/desk/poll", {"role": ["pc"], "client": [PC], "wait": ["0"]})
        self.assertEqual(code, 200)
        self.assertEqual(desk.http_post("/api/desk/send", {"to": "pc", "type": "pad", "data": {"op": "begin"}, "client": PHONE})[0], 200)
        code, got = desk.http_get("/api/desk/poll", {"role": ["pc"], "client": [PC], "after": [str(body["seq"])], "wait": ["0"]})
        self.assertEqual(got["messages"][0]["data"], {"op": "begin"})
        self.assertEqual(desk.http_post("/api/desk/state", {"role": "pc", "client": PC, "state": {"view": "lecteur"}})[0], 200)
        self.assertEqual(desk.http_get("/api/desk/peer", {"role": ["phone"]})[1]["peer"]["state"]["view"], "lecteur")

    def test_refusals_are_stable(self):
        self.assertEqual(desk.http_get("/api/desk/poll", {"role": ["x"], "client": [PC]}), (400, {"error": "Rôle invalide", "code": "bad_role"}))
        self.assertEqual(desk.http_get("/api/desk/poll", {"role": ["pc"], "client": [PC], "after": ["z"]})[0], 400)
        self.assertEqual(desk.http_post("/api/desk/send", {"to": "pc", "type": "pad", "data": {}, "client": PHONE, "extra": 1})[0], 400)
        self.assertEqual(desk.http_post("/api/desk/nope", {})[0], 404)
        self.assertEqual(desk.http_get("/api/desk/nope", {})[0], 404)
        self.assertEqual(desk.http_post("/api/desk/send", {"to": "pc", "type": "pad", "data": {"x": "y" * 20000}, "client": PHONE})[0], 413)


class SnapshotTests(unittest.TestCase):
    JPEG = b"\xff\xd8\xff" + b"\x00" * 64
    WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 16

    def setUp(self):
        desk.reset_for_tests()
        desk.SNAP_INTERVAL = 0

    def tearDown(self):
        desk.SNAP_INTERVAL = 0.08

    def test_rev_replacement_and_leave(self):
        first = desk.put_snapshot(PC, "image/jpeg", self.JPEG)
        second = desk.put_snapshot(PC, "image/webp", self.WEBP)
        self.assertEqual(first["rev"], 1)
        self.assertGreater(second["rev"], first["rev"])
        got = desk.latest_snapshot()
        self.assertEqual(got["mime"], "image/webp")
        self.assertEqual(got["body"], self.WEBP)
        self.assertEqual(len(desk._snaps), 1, "one slot per PC client, replaced")
        desk.leave("pc", PC)
        self.assertIsNone(desk.latest_snapshot())

    def test_bounds(self):
        with self.assertRaises(desk.DeskError) as cm:
            desk.put_snapshot(PC, "image/png", self.JPEG)
        self.assertEqual(cm.exception.code, "bad_type")
        with self.assertRaises(desk.DeskError) as cm:
            desk.put_snapshot(PC, "image/jpeg", b"not-a-jpeg")
        self.assertEqual(cm.exception.code, "bad_image")
        with self.assertRaises(desk.DeskError) as cm:
            desk.put_snapshot(PC, "image/jpeg", self.JPEG + b"x" * desk.SNAP_BYTES)
        self.assertEqual(cm.exception.code, "too_large")
        desk.SNAP_INTERVAL = 10
        desk.put_snapshot(PC, "image/jpeg", self.JPEG, now=100)
        with self.assertRaises(desk.DeskError) as cm:
            desk.put_snapshot(PC, "image/jpeg", self.JPEG, now=100.01)
        self.assertEqual(cm.exception.code, "rate")
        self.assertEqual(desk.http_get("/api/desk/snapshot", {}), (404, {"error": "Inconnu", "code": "not_found"}))

    def test_pad_message_id_is_idempotent_and_bounded(self):
        cur = desk.poll("pc", PC, -1, 0)
        first = desk.send("pc", "pad", {"op": "move", "id": "ab12", "i": 1}, PHONE)
        again = desk.send("pc", "pad", {"op": "move", "id": "ab12", "i": 2}, PHONE)
        self.assertTrue(again.get("dup"))
        self.assertEqual(again["seq"], first["seq"])
        got = desk.poll("pc", PC, cur["seq"], 0)
        self.assertEqual(len(got["messages"]), 1)
        self.assertEqual(got["messages"][0]["data"]["i"], 1)
        desk.send("pc", "pad", {"op": "move", "i": 3}, PHONE)
        desk.send("pc", "pad", {"op": "move", "i": 4}, PHONE)
        both = desk.poll("pc", PC, got["seq"], 0)
        self.assertEqual([m["data"]["i"] for m in both["messages"]], [3, 4])
        with self.assertRaises(desk.DeskError) as cm:
            desk.send("pc", "pad", {"op": "move", "id": "../x"}, PHONE)
        self.assertEqual(cm.exception.code, "bad_id")
        for i in range(desk.SEEN_MAX + 5):
            desk.send("pc", "pad", {"op": "ping", "id": f"a{i:x}"[:16]}, PHONE)
        self.assertLessEqual(len(desk._seen), desk.SEEN_MAX)

    def test_ack_is_allowed_and_unknown_types_stay_closed(self):
        self.assertTrue(desk.send("phone", "ack", {"for": "save", "ok": True, "text": "Enregistré"}, PC)["ok"])
        with self.assertRaises(desk.DeskError):
            desk.send("phone", "snapshot", {}, PC)


if __name__ == "__main__":
    unittest.main()
