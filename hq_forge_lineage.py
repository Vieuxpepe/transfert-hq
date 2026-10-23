"""Forge Studio phase J2: an image's lineage tree in the normal gallery.

The tree is built from links the gallery already records in each image's meta.json:
``origin.finish_of`` (a hires 'finition' of a gallery image, phase E) and
``origin.inpaint_of`` (a finger retouch of a gallery image, phase I). Nothing new is stored.

Only the normal gallery is read (meta.json, never pixels). The private vault is never
traversed: a private retouch records no gallery origin, and vault ids are not accepted here,
so private lineage is excluded rather than shown.
"""

from __future__ import annotations

from pathlib import Path

import hq_forge_gallery as gallery

RELATIONS = (("finish_of", "finish"), ("inpaint_of", "inpaint"))
MAX_NODES = 200
MAX_DEPTH = 50


def _links(root: Path) -> dict:
    """image id -> (parent id or None, relation or None, created, triage). Meta only."""
    out = {}
    base = gallery.gallery_dir(root)
    if not base.is_dir() or base.is_symlink():
        return out
    for child in base.iterdir():
        if child.is_symlink() or not gallery.IMG_RE.fullmatch(child.name):
            continue
        try:
            meta = gallery._meta(root, child.name)
        except gallery.GalleryError:
            continue
        origin = meta.get("origin") if isinstance(meta.get("origin"), dict) else {}
        parent, relation = None, None
        for key, name in RELATIONS:
            value = origin.get(key)
            if isinstance(value, str) and gallery.IMG_RE.fullmatch(value) and value != child.name:
                parent, relation = value, name
                break
        out[child.name] = (parent, relation, str(meta.get("created") or ""), gallery.triage_of(meta))
    return out


def lineage(root: Path, image_id: str) -> tuple[int, dict]:
    if not isinstance(image_id, str) or not gallery.IMG_RE.fullmatch(image_id):
        return 404, {"error": "Introuvable"}
    links = _links(root)
    if image_id not in links:
        return 404, {"error": "Introuvable"}
    # Walk up to the oldest ancestor still in the gallery (cycle-safe).
    top, seen = image_id, {image_id}
    parent_missing = False
    for _ in range(MAX_DEPTH):
        parent = links[top][0]
        if parent is None:
            break
        if parent not in links:
            parent_missing = True
            break
        if parent in seen:
            break
        seen.add(parent)
        top = parent
    children: dict = {}
    for node, (parent, _rel, created, _tri) in links.items():
        if parent is not None:
            children.setdefault(parent, []).append((created, node))
    nodes, queue, placed = [], [(top, 0)], set()
    truncated = False
    while queue:
        node, depth = queue.pop(0)
        if node in placed:
            continue
        if len(nodes) >= MAX_NODES:
            truncated = True
            break
        placed.add(node)
        parent, relation, created, triage = links[node]
        nodes.append({
            "id": node,
            "parent": parent if node != top else None,
            "relation": relation if node != top else None,
            "depth": depth,
            "created": created,
            "triage": triage,
            "thumb": f"/api/forge/gallery/{node}/thumb",
        })
        if depth < MAX_DEPTH:
            for _created, kid in sorted(children.get(node, [])):
                queue.append((kid, depth + 1))
    return 200, {"root": top, "focus": image_id, "nodes": nodes, "truncated": truncated,
                 "root_parent_missing": parent_missing}


def serve_get(root: Path, raw: str) -> tuple[int, dict] | None:
    prefix = "/api/forge/gallery/"
    if raw.startswith(prefix) and raw.endswith("/lineage"):
        return lineage(root, raw[len(prefix):-len("/lineage")])
    return None
