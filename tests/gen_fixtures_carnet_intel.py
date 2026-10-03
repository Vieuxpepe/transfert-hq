"""Regenerates tests/fixtures_carnet_intel.json from the PYTHON server (the source of truth) for the Phase-5 contract:
the real JSON the browser receives for the cockpit, a snapshot (cockpit view + verify), a checkpoint diff, a snapshot diff, and the
baseline list. Consumed by check_hq_carnet_intel.mjs; test_hq_carnet_intel.py fails when the SHAPE of the live responses drifts.

    python3 tests/gen_fixtures_carnet_intel.py
"""
from __future__ import annotations

import uuid
import copy
import json
import shutil
import sys
import tempfile
from pathlib import Path


def _rid() -> str:
    return uuid.uuid4().hex


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

AT = 1790000000


def shape(value):
    """The structure of a JSON value: keys and types, never the data (ids and times differ between runs)."""
    if isinstance(value, dict):
        if value and all(isinstance(k, str) and k.startswith(("block-", "page-", "proj-", "snap-", "hev-")) for k in value):
            return {"<id>": shape(next(iter(value.values())))}  # a map keyed by random ids
        return {k: shape(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [shape(value[0])] if value else []
    return type(value).__name__ if value is not None else "null"


def build() -> dict:
    import hq_carnet
    import hq_carnet_review as review
    import hq_carnet_snapshots as snaps

    tmp = Path(tempfile.mkdtemp(prefix="hq-intel-fixture-"))
    saved_cb, saved_ready = dict(hq_carnet._cb), hq_carnet._ready
    clock = [AT + 100000]
    try:
        for name in ("Inbox", "Uni", "Print"):
            (tmp / name).mkdir()
        (tmp / "Inbox" / "Drawings").mkdir()
        (tmp / "Inbox" / "Drawings" / "plan-1.hqdraw.json").write_bytes(b'{"v":1}')
        (tmp / "Inbox" / "a.pdf").write_bytes(b"%PDF-1.4\n%%EOF\n")
        hq_carnet.bind(root=tmp, now=lambda: clock[0])
        nb = hq_carnet.get_notebook()
        proj = hq_carnet.mutate({"action": "project_create", "expected_notebook_rev": nb["notebook_rev"], "name": "Banc d'essai"})["project"]

        def meas(label, v, tol, at, unit="mm", nominal="10"):
            return {"type": "measure", "text": "", "marks": [], "measure": {"label": label, "observed": {"v": v, "u": unit}, "mode": "sym", "nominal": {"v": nominal, "u": unit}, "tol": {"t": tol, "u": unit}, "at": at, "link": None}}

        def page(blocks):
            created = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})["page"]
            return hq_carnet.mutate({"action": "page_save", "id": created["id"], "expected_rev": created["rev"], "project_id": proj["id"], "content": {"version": 2, "blocks": blocks}})["page"]

        p1 = page([
            {"type": "paragraph", "text": "Banc d'essai arbre", "marks": []},
            {"type": "decision", "text": "Retenir l'alésage H7", "marks": [{"type": "link", "start": 0, "end": 6, "ref": {"kind": "file", "id": "Inbox/a.pdf"}}], "decision": {"at": AT + 10}},
            meas("Ø arbre", "10.01", "0.02", AT + 20), meas("Ø arbre", "10.04", "0.02", AT + 30), meas("Ø arbre", "10.03", "0.05", AT + 40),
            meas("Ø arbre", "0.395", "0.001", AT + 50, unit="in", nominal="0.394"),
            {"type": "drawing", "text": "", "marks": [], "drawing": {"id": "plan-1"}},
        ])
        page([{"type": "paragraph", "text": "Seconde note", "marks": []}, {"type": "drawing", "text": "", "marks": [], "drawing": {"id": "plan-9"}}])
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": p1["id"], "expected_rev": hq_carnet.mutate({"action": "page_save", "id": p1["id"], "expected_rev": p1["rev"], "content": {"version": 2, "blocks": copy.deepcopy(p1["content"]["blocks"])}})["page"]["rev"], "label": "avant essai"})[1]["event_id"]
        snap = hq_carnet.http_post({"action": "snapshot_create", "request_id": _rid(), "project_id": proj["id"], "label": "Gel conception", "note": "avant fabrication"})[1]["snapshot"]["id"]
        cur = hq_carnet.get_notebook()
        live = next(p for p in cur["pages"] if p["id"] == p1["id"])
        blocks = copy.deepcopy(live["content"]["blocks"])
        blocks[0]["text"] = "Banc d'essai arbre (rév. B)"
        blocks[2]["measure"]["observed"]["v"] = "10.2"
        blocks[6]["drawing"]["id"] = "plan-2"
        blocks.append({"type": "paragraph", "text": "Ajout après revue", "marks": []})
        del blocks[1]
        hq_carnet.mutate({"action": "page_save", "id": p1["id"], "expected_rev": live["rev"], "content": {"version": 2, "blocks": blocks}})
        (tmp / "Inbox" / "Drawings" / "plan-1.hqdraw.json").write_bytes(b'{"v":2}')
        return {
            "cockpit": review.cockpit(proj["id"]),
            "snapshot_cockpit": review.snapshot_cockpit(snap),
            "verify": snaps.verify(snap),
            "diff_checkpoint": review.diff(cp, None, None, None),
            "diff_snapshot": review.diff(snap, None, None, None),
            "baselines": review.baselines(proj["id"], p1["id"], str(AT + 200000)),
            "snapshots": snaps.list_snapshots(proj["id"]),
        }
    finally:
        hq_carnet._cb.clear()
        hq_carnet._cb.update(saved_cb)
        hq_carnet._ready = saved_ready
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    out = HERE / "fixtures_carnet_intel.json"
    out.write_text(json.dumps(build(), ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print("wrote", out.name)
