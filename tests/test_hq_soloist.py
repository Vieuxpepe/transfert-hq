from datetime import date
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading
import unittest
from unittest import mock

import hq_engine as eng
import hq_music_audio_duck as duck
import hq_soloist as sl
import hq_spotify as spotify


class SoloistTests(unittest.TestCase):
    def test_registered_and_ducking_configured(self):
        d = eng.get("soloist")
        self.assertIsNotNone(d)
        self.assertTrue(d.can("start"))
        self.assertTrue(d.can("stop"))
        self.assertIn("soloist.exe", duck.TARGET_PROCESSES)
        self.assertTrue(spotify._device_looks_local({"name": sl.device_name(), "type": "Speaker"}))

    def test_args_and_version_expiry_parsing(self):
        args = sl.build_args(Path("x/soloist.exe"), "spak_test")
        self.assertEqual(args[args.index("-n") + 1], sl.device_name())
        self.assertIn("-w", args)
        self.assertEqual(args[args.index("-w") + 1], "127.0.0.1:0")

        old_res = mock.Mock(stdout="soloist 1.0 (20200101) (windows/x86_64)", stderr="")
        with mock.patch.object(sl, "exe_path", return_value=Path("x/soloist.exe")), \
             mock.patch("subprocess.run", return_value=old_res):
            info = sl.build_info()
        self.assertTrue(info["expired"])
        self.assertEqual(info["days_remaining"], 0)

    def test_rotation_progress_starts_and_resets_on_key_change(self):
        with tempfile.TemporaryDirectory() as td:
            rot_path = Path(td) / "rot.json"
            with mock.patch.object(sl, "ROTATION_PATH", rot_path), \
                 mock.patch.object(sl, "_api_key", return_value="spak_first"), \
                 mock.patch.dict(os.environ, {"HQ_SOLOIST_ROTATION_DAYS": "90"}, clear=False):
                d0 = sl.rotation_info(today=date(2026, 11, 15))
                self.assertEqual(d0["rotated_at"], "2026-11-15")
                self.assertEqual(d0["reset_date"], "2027-02-13")
                self.assertEqual(d0["elapsed_days"], 0)
                self.assertEqual(d0["days_remaining"], 90)
                self.assertEqual(d0["pct"], 0.0)
                self.assertEqual(d0["level"], "")

                d70 = sl.rotation_info(today=date(2027, 1, 24))
                self.assertEqual(d70["elapsed_days"], 70)
                self.assertEqual(d70["days_remaining"], 20)
                self.assertEqual(d70["level"], "warm")

                d85 = sl.rotation_info(today=date(2027, 2, 8))
                self.assertEqual(d85["level"], "hot")

            with mock.patch.object(sl, "ROTATION_PATH", rot_path), \
                 mock.patch.object(sl, "_api_key", return_value="spak_rotated"), \
                 mock.patch.dict(os.environ, {"HQ_SOLOIST_ROTATION_DAYS": "90"}, clear=False):
                d_new = sl.rotation_info(today=date(2027, 2, 9))
                self.assertEqual(d_new["rotated_at"], "2027-02-09")
                self.assertEqual(d_new["elapsed_days"], 0)
                self.assertEqual(d_new["days_remaining"], 90)
                self.assertFalse(d_new["due"])

            # Verify raw secret is never stored in rotation state
            saved = rot_path.read_text(encoding="utf-8")
            self.assertNotIn("spak_", saved)

    def test_check_states_and_wake_fallback(self):
        with tempfile.TemporaryDirectory() as td:
            rot_path = Path(td) / "rot.json"
            with mock.patch.object(sl, "ROTATION_PATH", rot_path), \
                 mock.patch.object(sl, "exe_path", return_value=None), \
                 mock.patch.object(sl, "running_pids", return_value=[]):
                self.assertFalse(sl.start())
                self.assertEqual(sl.check()["state"], "down")

            with mock.patch.object(sl, "ROTATION_PATH", rot_path), \
                 mock.patch.object(sl, "exe_path", return_value=Path("x/soloist.exe")), \
                 mock.patch.object(sl, "_api_key", return_value="spak_test"), \
                 mock.patch.object(sl, "build_info", return_value={"days_remaining": 80, "age_days": 10, "expired": False}), \
                 mock.patch.object(sl, "running_pids", return_value=[123]), \
                 mock.patch.object(sl, "ctl_status", return_value={"running": True, "logged_in": False, "ws": "127.0.0.1:9000"}):
                c = sl.check()
                self.assertEqual(c["state"], "warn")
                self.assertEqual(len(c["meters"]), 2)
                self.assertEqual(c["meters"][0]["label"], "Rotation clé API")

            with mock.patch.object(sl, "ROTATION_PATH", rot_path), \
                 mock.patch.object(sl, "exe_path", return_value=Path("x/soloist.exe")), \
                 mock.patch.object(sl, "_api_key", return_value="spak_test"), \
                 mock.patch.object(sl, "build_info", return_value={"days_remaining": 80, "age_days": 10, "expired": False}), \
                 mock.patch.object(sl, "running_pids", return_value=[123]), \
                 mock.patch.object(sl, "ctl_status", return_value={"running": True, "logged_in": True, "ws": "127.0.0.1:9000"}):
                out_c = sl.check()
                self.assertEqual(out_c["state"], "ready")
                card = eng._probe_core(eng.get("soloist"))
                self.assertEqual(len(card["meters"]), 2)

        with mock.patch.dict(os.environ, {}, clear=False), \
             mock.patch.object(sl, "available", return_value=True), \
             mock.patch.object(sl, "running_pids", return_value=[]), \
             mock.patch.object(sl, "start", return_value=True):
            os.environ.pop("HQ_PREFER_DESKTOP", None)
            out = spotify.wake_local_spotify(wait_s=0)
        self.assertTrue(out["ok"])
        self.assertTrue(out["soloist"])

    def test_local_ctl_and_restriction_fallback(self):
        with mock.patch.object(sl, "ws_endpoint", return_value=None), \
             mock.patch.object(sl, "exe_path", return_value=Path("x/soloist.exe")), \
             mock.patch.object(sl, "running_pids", return_value=[123]), \
             mock.patch.object(sl, "ctl_status", return_value={"running": True, "logged_in": True}), \
             mock.patch("subprocess.run", return_value=mock.Mock(returncode=0)) as run_mock:
            self.assertTrue(sl.control("play"))
            self.assertEqual(run_mock.call_args[0][0][-1], "play")
            self.assertFalse(sl.control("play", {"uris": ["spotify:track:1", "spotify:track:2"]}))

        with mock.patch.object(sl, "ws_endpoint", return_value=("127.0.0.1", 9000)), \
             mock.patch.object(sl, "device_id", return_value="solo-1"), \
             mock.patch.object(sl, "control", return_value=True) as ctl_mock, \
             mock.patch.object(spotify, "api_request") as api_mock:
            res = spotify.player_action("play", {"device_id": "solo-1", "auto_device": False})
        self.assertTrue(res["ok"])
        self.assertTrue(res["soloist"])
        ctl_mock.assert_called_once()
        api_mock.assert_not_called()

        err_403 = spotify.SpotifyError("Restriction violated", 403, "spotify_restriction_violated")
        with mock.patch.object(sl, "ws_endpoint", return_value=None), \
             mock.patch.object(sl, "running_pids", return_value=[]), \
             mock.patch.object(spotify, "api_request", side_effect=err_403), \
             mock.patch.object(spotify, "get_player", return_value={"playing": True, "item": {"uri": "t"}}):
            res2 = spotify.player_action("play", {"auto_device": False})
        self.assertTrue(res2["ok"])
        self.assertTrue(res2["noop"])

    def test_ws_direct_control_roundtrip(self):
        received = []
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        port = srv.getsockname()[1]

        def serve():
            conn, _ = srv.accept()
            with conn:
                buf = b""
                while b"\r\n\r\n" not in buf:
                    buf += conn.recv(4096)
                key = [l.split(":", 1)[1].strip() for l in buf.decode().splitlines() if l.lower().startswith("sec-websocket-key:")][0]
                acc = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                conn.sendall(f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {acc}\r\n\r\n".encode())
                def send_txt(obj):
                    b = json.dumps(obj).encode()
                    conn.sendall(bytes([0x81, len(b)]) + b)
                send_txt({"type": "auth_state", "logged_in": True, "is_active": True})
                h = conn.recv(2)
                ln = h[1] & 127
                m = conn.recv(4)
                p = bytes(b ^ m[i & 3] for i, b in enumerate(conn.recv(ln)))
                cmd = json.loads(p.decode())
                received.append(cmd)
                send_txt({"type": "command_result", "command": cmd["command"]})

        t = threading.Thread(target=serve, daemon=True)
        t.start()
        try:
            with tempfile.TemporaryDirectory() as td:
                d = Path(td)
                (d / "ws.addr").write_text("127.0.0.1", encoding="utf-8")
                (d / "ws.port").write_text(str(port), encoding="utf-8")
                with mock.patch.object(sl, "DATA_DIR", d):
                    self.assertTrue(sl.control("pause"))
        finally:
            t.join(timeout=2)
            srv.close()
        self.assertEqual(received, [{"type": "command", "command": "pause"}])


if __name__ == "__main__":
    unittest.main()
