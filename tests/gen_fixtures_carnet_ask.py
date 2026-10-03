"""Regenerates tests/fixtures_carnet_ask.json from the PYTHON server (the source of truth) for the Phase-6 contract: the real JSON the
browser receives from {action: "ask"} for evidence / partial / insufficient / empty / frozen-snapshot answers. Consumed by
check_hq_carnet_ask.mjs; test_hq_carnet_ask.py fails when the SHAPE of the live responses drifts.

    python3 tests/gen_fixtures_carnet_ask.py
"""
from __future__ import annotations

import io
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
        return {k: shape(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [shape(value[0])] if value else []
    return type(value).__name__ if value is not None else "null"


def build() -> dict:
    import hq_carnet
    import hq_carnet_media as media
    import hq_carnet_review as review
    from test_hq_carnet_links_report import image_block, png

    tmp = Path(tempfile.mkdtemp(prefix="hq-ask-fixture-"))
    saved_cb, saved_ready = dict(hq_carnet._cb), hq_carnet._ready
    saved_media = dict(media._cb)
    try:
        for name in ("Inbox", "Uni", "Print"):
            (tmp / name).mkdir()
        hq_carnet.bind(root=tmp, now=lambda: AT + 100000)
        proj = hq_carnet.mutate({"action": "project_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"], "name": "Banc d'essai"})["project"]
        asset = media.store_upload(io.BytesIO(png()).read, len(png()), "image/png")["asset"]

        def page(blocks):
            created = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})["page"]
            return hq_carnet.mutate({"action": "page_save", "id": created["id"], "expected_rev": created["rev"], "project_id": proj["id"], "content": {"version": 2, "blocks": blocks}})["page"]

        p = page([
            {"type": "paragraph", "text": "Le couple de serrage du palier avant est de 40 N·m", "marks": []},
            image_block(asset),
            {"type": "paragraph", "text": "serrage palier arrière 35 Nm", "marks": [], "from": {"kind": "ocr", "source_kind": "asset", "source_id": asset["id"]}},
            {"type": "decision", "text": "Retenir le serrage de 40 N·m", "marks": [], "decision": {"at": AT + 10}},
            {"type": "measure", "text": "", "marks": [], "measure": {"label": "Couple de serrage", "observed": {"v": "39.5", "u": "N·m"}, "mode": "sym", "nominal": {"v": "40", "u": "N·m"}, "tol": {"t": "1", "u": "N·m"}, "at": AT + 20, "link": None}},
        ])
        scope = {"kind": "project", "id": proj["id"]}

        def ask(q, sc=scope, **kw):
            return review.ask({"action": "ask", "question": q, "scope": sc, **kw})

        snap = hq_carnet.http_post({"action": "snapshot_create", "request_id": uuid.uuid4().hex, "project_id": proj["id"], "label": "Gel conception"})[1]["snapshot"]["id"]
        live = hq_carnet.get_notebook()
        page_now = next(x for x in live["pages"] if x["id"] == p["id"])
        blocks = json.loads(json.dumps(page_now["content"]["blocks"]))
        blocks[0]["text"] = "Le couple de serrage du palier avant est de 45 N·m"
        hq_carnet.mutate({"action": "page_save", "id": p["id"], "expected_rev": page_now["rev"], "content": {"version": 2, "blocks": blocks}})
        return {
            "evidence": ask("couple de serrage palier avant"),
            "partial": ask("serrage palier rectifié grenaillé"),
            "insufficient": ask("turbine hydraulique"),
            "empty": ask("le la de"),
            "frozen": ask("serrage palier", {"kind": "snapshot", "id": snap}),
        }
    finally:
        hq_carnet._cb.clear()
        hq_carnet._cb.update(saved_cb)
        hq_carnet._ready = saved_ready
        media._cb.clear()
        media._cb.update(saved_media)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    out = HERE / "fixtures_carnet_ask.json"
    out.write_text(json.dumps(build(), ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print("wrote", out.name)
