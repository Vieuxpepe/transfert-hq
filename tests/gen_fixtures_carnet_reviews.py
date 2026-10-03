"""Regenerates tests/fixtures_carnet_reviews.json from the PYTHON server (the source of truth) for the Phase-7 contract: the real JSON the
browser receives for the review list / a pack with every evidence kind / its freshness observation / a 409 conflict. Consumed by
check_hq_carnet_reviews.mjs; test_hq_carnet_reviews.py fails when the SHAPE of the live responses drifts.

    python3 tests/gen_fixtures_carnet_reviews.py
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

AT = 1790000000


def shape(value):
    if isinstance(value, dict):
        if value and all(k.startswith("ri-") for k in value):  # maps keyed by random item ids: shape of one entry
            return {"<item-id>": shape(next(iter(value.values())))}
        return {k: shape(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [shape(value[0])] if value else []
    return type(value).__name__ if value is not None else "null"


def build() -> dict:
    import hq_carnet
    import hq_carnet_review as review

    tmp = Path(tempfile.mkdtemp(prefix="hq-rv-fixture-"))
    saved_cb, saved_ready = dict(hq_carnet._cb), hq_carnet._ready
    try:
        for name in ("Inbox", "Uni", "Print"):
            (tmp / name).mkdir()
        (tmp / "Inbox" / "Drawings").mkdir()
        (tmp / "Inbox" / "Drawings" / "plan-1.hqdraw.json").write_bytes(b'{"v":1}')
        hq_carnet.bind(root=tmp, now=lambda: AT + 100000)
        proj = hq_carnet.mutate({"action": "project_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"], "name": "Banc d'essai"})["project"]
        created = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})["page"]
        blocks = [
            {"type": "paragraph", "text": "Le palier avant est usiné en H7", "marks": []},
            {"type": "decision", "text": "Retenir H7", "marks": [], "decision": {"at": AT + 10}},
            {"type": "measure", "text": "", "marks": [], "measure": {"label": "Alésage", "observed": {"v": "30.012", "u": "mm"}, "mode": "sym", "nominal": {"v": "30", "u": "mm"}, "tol": {"t": "0.02", "u": "mm"}, "at": AT + 20, "link": None}},
        ]
        page = hq_carnet.mutate({"action": "page_save", "id": created["id"], "expected_rev": created["rev"], "project_id": proj["id"], "content": {"version": 2, "blocks": blocks}})["page"]
        bl = page["content"]["blocks"]
        post = lambda **d: hq_carnet.http_post(d)  # noqa: E731
        st, out = post(action="snapshot_create", request_id=uuid.uuid4().hex, project_id=proj["id"], label="Gel conception")
        sid = out["snapshot"]["id"]
        st, out = post(action="review_create", project_id=proj["id"], title="Revue conception banc", note="Avant fabrication", request_id=uuid.uuid4().hex)
        pack = out["review"]
        res = review.ask({"action": "ask", "question": "palier H7", "scope": {"kind": "project", "id": proj["id"]}})
        specs = [
            {"kind": "page", "page_id": page["id"]},
            {"kind": "decision", "page_id": page["id"], "block_id": bl[1]["id"]},
            {"kind": "measurement", "page_id": page["id"], "block_id": bl[2]["id"]},
            {"kind": "drawing", "stem": "plan-1"},
            {"kind": "snapshot", "snapshot_id": sid},
            {"kind": "project_overview"},
            {"kind": "ask_result", "question": "palier H7", "scope": {"kind": "project", "id": proj["id"]}, "limit": 10, "fingerprint": res["fingerprint"]},
            {"kind": "diff", "base": sid, "to": None, "page_id": None, "project_id": None},
        ]
        for spec in specs:
            st, out = post(action="review_item_add", id=pack["id"], expected_rev=pack["rev"], item=spec)
            assert st == 200, out
            pack = out["review"]
        st, out = post(action="review_check_add", id=pack["id"], expected_rev=pack["rev"], text="Vérifier l'ajustement H7", refs=[pack["items"][0]["id"]])
        pack = out["review"]
        st, out = post(action="review_check_update", id=pack["id"], expected_rev=pack["rev"], check_id=pack["checklist"][0]["id"], checked=True)
        pack = out["review"]
        st, out = post(action="review_question_add", id=pack["id"], expected_rev=pack["rev"], text="Qui valide la cote ?")
        pack = out["review"]
        # a changed page: the observation differs from the stored seal
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [dict(bl[0], text="Le palier avant est usiné en H6")] + bl[1:]}})
        listing = hq_carnet.http_get({"reviews": ["1"], "project": [proj["id"]]})[1]
        got = hq_carnet.http_get({"review": [pack["id"]]})[1]
        fresh = hq_carnet.http_get({"review": [pack["id"]], "freshness": ["1"]})[1]
        st, conflict = post(action="review_update", id=pack["id"], expected_rev=pack["rev"] - 1, title="x")
        assert st == 409
        return {"list": listing, "pack": got, "freshness": fresh, "conflict": conflict, "shape": {"list": shape(listing), "pack": shape(got), "freshness": shape(fresh)}}
    finally:
        hq_carnet._cb.clear()
        hq_carnet._cb.update(saved_cb)
        hq_carnet._ready = saved_ready
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    out = HERE / "fixtures_carnet_reviews.json"
    out.write_text(json.dumps(build(), ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print("wrote", out.name)
