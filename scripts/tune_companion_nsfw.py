#!/usr/bin/env py3
"""One-shot tuning helper: POST /api/ai preview (dry or live). Run on the bridge PC with HQ up + admin session cookie, or offline via hq_ai.preview."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SAMPLE_DIGEST = """Vue : Fichiers
Titre : Fichiers
Dossier : Inbox
Éléments visibles : 8"""

BODY = {
    "action": "preview",
    "kind": "ambient",
    "view": "fichiers",
    "digest": SAMPLE_DIGEST,
    "persona": "flirt",
    "nsfw": True,
    "live": "--live" in sys.argv,
}


def offline() -> None:
    import hq_ai as ai

    ai.bind(
        root=ROOT,
        key=lambda: "",
        companion_persona=lambda: "flirt",
        client_is_controller=lambda ip: True,
        nsfw_enabled=lambda: True,
        calendar=lambda a, b: [],
        projects=lambda: {"projects": [], "tasks": []},
        inventory=lambda: {"places": [], "items": []},
        carnet=lambda: {"pages": []},
        files=lambda w: [],
        save_event=lambda p: None,
        projects_apply=lambda d: {},
        inventory_apply=lambda d: {},
        carnet_note=lambda l: {},
    )
    code, out = ai.http_post(BODY, client_ip="127.0.0.1", role="admin")
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    offline()
