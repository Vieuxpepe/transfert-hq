"""Scripted multi-turn chat aliveness, fake provider, zero model calls.

What this proves is the delivered guidance, not generated wording: every turn
goes through the real ``transferania`` send path, so the captured payload is
exactly what the provider would receive. The aliveness contracts must be present
on social turns, must vary their forbidden opening turn after turn, must drop on
a refusal or a serious turn, and must stay out of comfort/recall turns.

Wording quality still needs a live model sample; this keeps the mechanism honest
and reproducible. CLI wrapper: ``python scripts/verify_chat_aliveness.py``.
"""
from __future__ import annotations

import json

import hq_ai as ai
import hq_companion_presence as presence
from tests.test_hq_ai import Base, DEV, reply

# Each canned reply is what a compliant model would say; the harness only checks
# that the guidance makes it possible and that the opening moves differ.
TURNS = (
    {"label": "social 1", "user": "Salut, j'ai enfin réparé la perceuse.",
     "reply": "Ah, ta perceuse revit — montre-moi la sciure.", "kind": "social", "persona": "warm"},
    {"label": "social 2", "user": "Tu sais quoi ? Café à 23 h.",
     "reply": "Tiens, minuit approche et tu carbures encore.", "kind": "social", "persona": "warm"},
    {"label": "comfort", "user": "Je me sens débordé ce soir.",
     "reply": "Viens là. On respire deux secondes ensemble.", "kind": "comfort", "persona": "warm"},
    {"label": "recall", "user": "Tu te souviens de la perceuse ?",
     "reply": "Oui — celle que tu viens de réparer.", "kind": "recall", "persona": "warm"},
    {"label": "refusal", "user": "Non, arrête, je n'ai pas envie de jouer.",
     "reply": "D'accord. Je me tais et je t'écoute.", "kind": "drop", "persona": "flirt"},
    {"label": "serious", "user": "Parlons sérieusement du projet.",
     "reply": "Alors parlons du projet, sans détour.", "kind": "drop", "persona": "flirt"},
)

SOCIAL_SHAPE = "FORME : réagis avant d'informer"
DROP_SHAPE = "FORME : redescends d'un cran"
WARM_CONTRACT = "une réplique, jamais un compte rendu"
FLIRT_CONTRACT = "Tu joues"


def _payload(call) -> str:
    return json.dumps(call[1], ensure_ascii=False) + json.dumps(call[2], ensure_ascii=False)


def run() -> dict:
    """Run the scripted exchange and return the captured evidence; asserts on failure."""
    fixture = Base()
    fixture.setUp()
    rows = []
    try:
        previous_reply = ""
        for turn in TURNS:
            fixture.answers = [reply(turn["reply"])]
            code, out = ai.http_post(
                {"action": "transferania", "op": "send", "message": turn["user"], "view": "accueil",
                 "persona": turn["persona"], "device_id": DEV},
                role="admin")
            assert code == 200, f'{turn["label"]}: send failed {code} {out}'
            assert out.get("reply") == turn["reply"], f'{turn["label"]}: reply not delivered verbatim'
            call = fixture.calls[-1]
            blob = _payload(call)
            expected_mode = "comfort" if turn["kind"] == "comfort" else "recall" if turn["kind"] == "recall" else "social"
            assert presence.classify(turn["user"]) == expected_mode, \
                f'{turn["label"]}: expected mode {expected_mode}, got {presence.classify(turn["user"])}'
            contract = WARM_CONTRACT if turn["persona"] == "warm" else FLIRT_CONTRACT
            assert contract in blob, f'{turn["label"]}: voice contract missing from the payload'
            avoided = presence.opening_avoid(previous_reply)
            guidance = f"N'ouvre pas comme avant (« {avoided} »)" if avoided else ""
            if turn["kind"] == "social":
                assert SOCIAL_SHAPE in blob, f'{turn["label"]}: social shape missing'
                assert DROP_SHAPE not in blob, f'{turn["label"]}: social turn wrongly asked to drop'
            elif turn["kind"] == "drop":
                assert DROP_SHAPE in blob, f'{turn["label"]}: refusal/serious turn did not drop the heat'
                assert SOCIAL_SHAPE not in blob, f'{turn["label"]}: refusal kept the social react prompt'
            else:
                assert "FORME :" not in blob, f'{turn["label"]}: {turn["kind"]} turn should stay unadorned'
                assert "TOUCHE FACULTATIVE" not in blob, f'{turn["label"]}: {turn["kind"]} turn got a habit'
            if avoided:
                assert guidance in blob, f'{turn["label"]}: previous opening « {avoided} » not named'
            if len(rows) >= 1:
                prior = rows[-1]
                assert prior["reply"] and prior["reply"] in blob, f'{turn["label"]}: previous reply missing from history'
            rows.append({
                "turn": len(rows) + 1, "label": turn["label"], "mode": presence.classify(turn["user"]),
                "persona": turn["persona"], "reply": turn["reply"], "opening": presence.opening_avoid(turn["reply"]),
                "avoided_this_turn": avoided,
                "guidance": guidance,
                "shape": DROP_SHAPE if turn["kind"] == "drop" else SOCIAL_SHAPE if turn["kind"] == "social" else "",
            })
            previous_reply = turn["reply"]
        openings = [row["opening"] for row in rows]
        avoided = [row["avoided_this_turn"] for row in rows if row["avoided_this_turn"]]
        assert len(set(openings)) == len(openings), f"openings repeated: {openings}"
        assert len(set(avoided)) == len(avoided), f"the same opening was forbidden twice: {avoided}"
        assert len(avoided) >= 4, "at least four turns must carry the anti-repetition cue"
        return {"turns": rows, "openings": openings, "avoided": avoided, "model_calls": 0}
    finally:
        fixture.tearDown()
