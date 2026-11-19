"""Hub d'édition partagée (hq_drawings_live): révisions, conflits, présence qui expire."""

import unittest
from urllib.parse import parse_qs

import hq_drawings_live as live


def doc(n=1):
    return {"format": "hqdraw", "version": 6, "units": "mm", "objects": [], "n": n}


class LiveTests(unittest.TestCase):
    def setUp(self):
        live.reset()

    def test_publish_then_poll_returns_head_once(self):
        first = live.publish("piece-a", doc(1), "pc", rev=0, name="PC atelier")
        self.assertTrue(first["ok"])
        self.assertEqual(first["rev"], 1)
        got = live.poll("piece-a", "pad", rev=0, name="iPad")
        self.assertTrue(got["changed"])
        self.assertEqual(got["doc"]["n"], 1)
        self.assertEqual(got["by"], "PC atelier")
        again = live.poll("piece-a", "pad", rev=got["rev"])
        self.assertFalse(again["changed"], "sans changement, aucun document renvoyé")
        self.assertIsNone(again["doc"])

    def test_stale_revision_is_a_conflict_with_the_server_head(self):
        live.publish("piece-a", doc(1), "pc", rev=0)
        live.publish("piece-a", doc(2), "pad", rev=1)
        with self.assertRaises(live.LiveError) as ctx:
            live.publish("piece-a", doc(99), "pc", rev=1)  # le PC n'a pas vu la révision 2
        self.assertEqual(ctx.exception.status, 409)
        payload = ctx.exception.payload
        self.assertEqual(payload["rev"], 2)
        self.assertEqual(payload["doc"]["n"], 2, "la tête du serveur sert à récupérer")
        self.assertEqual(payload["baseRev"], 1)
        # après avoir accepté la tête, on republie
        ok = live.publish("piece-a", doc(3), "pc", rev=payload["rev"])
        self.assertEqual(ok["rev"], 3)

    def test_publish_without_base_revision_is_allowed(self):
        live.publish("piece-a", doc(1), "pc", rev=0)
        self.assertEqual(live.publish("piece-a", doc(2), "pad")["rev"], 2)

    def test_presence_lists_the_other_device_without_self(self):
        live.poll("piece-a", "pc", name="PC")
        got = live.poll("piece-a", "pad", name="iPad", sel=["l1", "c2"], cursor=[12.5, -3])
        self.assertEqual([p["client"] for p in got["peers"]], ["pc"])
        self.assertEqual(got["peers"][0]["name"], "PC")
        mine = live.poll("piece-a", "pc")
        self.assertEqual([p["client"] for p in mine["peers"]], ["pad"])
        self.assertEqual(mine["peers"][0]["sel"], ["l1", "c2"])
        self.assertEqual(mine["peers"][0]["cursor"], [12.5, -3.0])

    def test_presence_expires_after_the_ttl(self):
        live.poll("piece-a", "pc", name="PC")
        real = live._now
        try:
            live._now = lambda: real() + live.PEER_TTL + 1
            got = live.poll("piece-a", "pad")
            self.assertEqual(got["peers"], [], "un pad endormi ne laisse pas de fantôme")
        finally:
            live._now = real

    def test_leave_removes_the_device(self):
        live.poll("piece-a", "pc")
        live.poll("piece-a", "pad")
        live.leave("piece-a", "pad")
        self.assertEqual(live.poll("piece-a", "pc")["peers"], [])
        self.assertTrue(live.leave("piece-a", "pad")["ok"], "partir deux fois ne casse rien")

    def test_two_drawings_do_not_mix(self):
        live.publish("piece-a", doc(1), "pc", rev=0)
        live.publish("piece-b", doc(2), "pc", rev=0)
        self.assertEqual(live.poll("piece-a", "pad", rev=0)["doc"]["n"], 1)
        self.assertEqual(live.poll("piece-b", "pad", rev=0)["doc"]["n"], 2)
        self.assertEqual(live.status("piece-a")["rev"], 1)

    def test_empty_room_is_forgotten_after_a_while(self):
        live.publish("piece-a", doc(1), "pc", rev=0)
        live.leave("piece-a", "pc")
        real = live._now
        try:
            live._now = lambda: real() + live.ROOM_TTL + 1
            self.assertEqual(live.status("piece-a")["rev"], 0)
            self.assertEqual(live.status()["rooms"], [])
        finally:
            live._now = real

    def test_bad_input_is_refused(self):
        for bad in ["", "../secret", "a/b", "x" * 200, ".hidden", None, 3]:
            with self.assertRaises(live.LiveError):
                live.publish(bad, doc(), "pc", rev=0)
        for bad in ["", "a b", "x" * 41, None]:
            with self.assertRaises(live.LiveError):
                live.publish("piece-a", doc(), bad, rev=0)
        with self.assertRaises(live.LiveError):
            live.publish("piece-a", ["pas", "un", "document"], "pc", rev=0)
        with self.assertRaises(live.LiveError):
            live.publish("piece-a", doc(), "pc", rev=-1)
        with self.assertRaises(live.LiveError):
            live.publish("piece-a", doc(), "pc", rev="2")
        with self.assertRaises(live.LiveError):
            live.poll("piece-a", "pc", sel=["ok", "../x"])
        with self.assertRaises(live.LiveError):
            live.poll("piece-a", "pc", cursor=[1, 2, 3])

    def test_a_huge_document_is_refused(self):
        fat = doc()
        fat["padding"] = "x" * (live.MAX_DOC_BYTES + 10)
        with self.assertRaises(live.LiveError) as ctx:
            live.publish("piece-a", fat, "pc", rev=0)
        self.assertEqual(ctx.exception.status, 413)

    def test_too_many_devices_on_one_drawing(self):
        for i in range(live.MAX_PEERS):
            live.poll("piece-a", f"pad{i}")
        with self.assertRaises(live.LiveError) as ctx:
            live.poll("piece-a", "intrus")
        self.assertEqual(ctx.exception.status, 429)
        self.assertTrue(live.poll("piece-a", "pad0")["ok"], "un appareil déjà présent reste bienvenu")

    def test_peer_never_gets_its_own_selection_back(self):
        live.poll("piece-a", "pc", sel=["l9"])
        got = live.poll("piece-a", "pc")
        self.assertEqual(got["peers"], [])


class LiveRouteTests(unittest.TestCase):
    def setUp(self):
        live.reset()

    def test_get_and_post_route_payloads(self):
        code, got = live.serve_post({"key": "piece-a", "doc": doc(1), "client": "pc", "rev": 0, "name": "PC"})
        self.assertEqual(code, 201, got)
        self.assertEqual(got["rev"], 1)
        code, got = live.serve_get(parse_qs("key=piece-a&client=pad&rev=0&name=iPad&sel=l1,c2&cursor=12.5,-3"))
        self.assertEqual(code, 200, got)
        self.assertTrue(got["changed"])
        self.assertEqual(got["doc"]["n"], 1)
        self.assertEqual(got["peers"][0]["client"], "pc")
        self.assertEqual(got["peers"][0]["name"], "PC")
        code, mine = live.serve_get(parse_qs("key=piece-a&client=pc&rev=1"))
        self.assertEqual(mine["peers"][0]["sel"], ["l1", "c2"])
        self.assertEqual(mine["peers"][0]["cursor"], [12.5, -3.0])
        code, again = live.serve_get(parse_qs("key=piece-a&client=pad&rev=1"))
        self.assertEqual((code, again["changed"], again["doc"]), (200, False, None))

    def test_conflict_route_carries_the_server_head(self):
        live.serve_post({"key": "piece-a", "doc": doc(1), "client": "pc", "rev": 0})
        code, got = live.serve_post({"key": "piece-a", "doc": doc(9), "client": "pad", "rev": 0})
        self.assertEqual(code, 409)
        self.assertEqual(got["code"], "conflict")
        self.assertEqual(got["rev"], 1)
        self.assertEqual(got["doc"]["n"], 1)
        self.assertEqual(got["baseRev"], 0)

    def test_bad_queries_and_bodies_are_400s(self):
        for query in ("", "key=piece-a", "client=pad", "key=piece-a&client=pad&rev=x",
                      "key=piece-a&client=pad&cursor=1", "key=piece-a&client=pad&sel=a,%2E%2E%2Fx"):
            code, got = live.serve_get(parse_qs(query))
            self.assertEqual(code, 400, (query, got))
            self.assertEqual(got["code"], "bad_request")
        code, got = live.serve_post(["pas", "un", "objet"])
        self.assertEqual((code, got["code"]), (400, "bad_request"))
        code, got = live.serve_post({"key": "piece-a", "doc": doc(), "client": "pc", "rev": "0"})
        self.assertEqual((code, got["code"]), (400, "bad_request"))


if __name__ == "__main__":
    unittest.main()
