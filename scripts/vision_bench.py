"""Benchmark Inventoria's photo recognition on labelled pictures.

Layout of the folder you pass in (one pair per case):
    shelf1.jpg
    shelf1.json   {"items": [{"name": "Lait", "qty": 4}, {"name": "Riz", "qty": 1}], "intent": "count"}

``intent`` is optional (stock | grocery | count).  Run against a live HQ (or the test harness):

    python scripts/vision_bench.py PHOTO_DIR --base http://127.0.0.1:8799 [--stress]

``--stress`` also replays every photo degraded (blur, noise, tilt, low light, heavy JPEG,
occlusion) to measure how much recall is lost.  Needs Pillow for --stress.
It prints recall (expected items found), precision (reported items that were expected),
count accuracy (found items whose quantity matches) and the box/count cross-check verdicts.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]+", " ", s).strip()


def same(a: str, b: str) -> bool:
    a, b = norm(a), norm(b)
    return bool(a and b) and (a == b or a in b or b in a or set(a.split()) & set(b.split()) == set(a.split()))


def post(base: str, path: str, body: dict, timeout: int = 180) -> dict:
    req = urllib.request.Request(base + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def data_url(raw: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(raw).decode()


def degrade(raw: bytes) -> dict[str, bytes]:
    from PIL import Image, ImageDraw, ImageEnhance, ImageFilter
    import random
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    out: dict[str, Image.Image] = {}
    out["blur"] = img.filter(ImageFilter.GaussianBlur(3))
    rnd = random.Random(7)
    noisy = img.copy()
    px = noisy.load()
    for _ in range(img.width * img.height // 12):
        x, y = rnd.randrange(img.width), rnd.randrange(img.height)
        v = rnd.randrange(256)
        px[x, y] = (v, v, v)
    out["noise"] = noisy
    out["tilt"] = img.rotate(12, expand=True, fillcolor=(128, 128, 128))
    out["lowlight"] = ImageEnhance.Brightness(img).enhance(0.35)
    occ = img.copy()
    ImageDraw.Draw(occ).rectangle([img.width * .35, img.height * .3, img.width * .6, img.height * .7], fill=(30, 30, 30))
    out["occluded"] = occ
    res: dict[str, bytes] = {}
    for k, im in out.items():
        b = io.BytesIO()
        im.save(b, "JPEG", quality=85)
        res[k] = b.getvalue()
    b = io.BytesIO()
    img.save(b, "JPEG", quality=12)
    res["jpeg12"] = b.getvalue()
    return res


def run_case(base: str, raw: bytes, intent: str | None) -> list[dict]:
    sid = post(base, "/api/inventoria/sessions", {})["session"]["id"]
    body = {"text": "", "image": data_url(raw), "force": True}
    if intent:
        body["intent"] = intent
    out = post(base, f"/api/inventoria/sessions/{sid}/message", body)
    det = out.get("detections") or {}
    return det.get("rows") or det.get("items") or []


def score(expected: list[dict], rows: list[dict]) -> dict:
    found = qty_ok = 0
    used: set[int] = set()
    for e in expected:
        for i, r in enumerate(rows):
            if i in used:
                continue
            if same(e["name"], r.get("name") or r.get("item_name") or ""):
                used.add(i)
                found += 1
                q = r.get("qty", r.get("quantity"))
                if "qty" in e and q is not None and abs(float(q) - float(e["qty"])) < 0.01:
                    qty_ok += 1
                break
    n_exp = len(expected) or 1
    return {
        "recall": found / n_exp,
        "precision": (len(used) / len(rows)) if rows else 0.0,
        "count_acc": (qty_ok / found) if found else 0.0,
        "verify": sorted({str(r.get("verify")) for r in rows}),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--base", default="http://127.0.0.1:8799")
    ap.add_argument("--stress", action="store_true")
    a = ap.parse_args()
    cases = sorted(Path(a.folder).glob("*.json"))
    if not cases:
        print("no <name>.json labels found", file=sys.stderr)
        return 2
    tot: dict[str, list[float]] = {}
    for js in cases:
        label = json.loads(js.read_text(encoding="utf-8"))
        pic = next((p for p in (js.with_suffix(".jpg"), js.with_suffix(".jpeg"), js.with_suffix(".png")) if p.exists()), None)
        if not pic:
            continue
        raw = pic.read_bytes()
        variants = {"original": raw}
        if a.stress:
            variants.update(degrade(raw))
        for vname, vraw in variants.items():
            try:
                s = score(label["items"], run_case(a.base, vraw, label.get("intent")))
            except Exception as exc:   # keep going: one bad call must not hide the rest
                print(f"{js.stem:20} {vname:10} ERROR {exc}")
                continue
            print(f"{js.stem:20} {vname:10} recall {s['recall']:.0%}  precision {s['precision']:.0%}  counts {s['count_acc']:.0%}  verify {s['verify']}")
            for k in ("recall", "precision", "count_acc"):
                tot.setdefault(f"{vname}:{k}", []).append(s[k])
    print("\n== averages ==")
    for k, v in tot.items():
        print(f"{k:22} {sum(v) / len(v):.0%}  (n={len(v)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
