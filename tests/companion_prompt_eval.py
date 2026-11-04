"""Reusable synthetic evaluation, with fake provider and isolated owner storage."""
import json
from pathlib import Path

import hq_ai as ai
import hq_companion_memory as memory
import hq_companion_presence as presence
from tests.test_hq_ai import Base, DEV

CASES = json.loads((Path(__file__).parent / "fixtures/companion_prompt_eval.json").read_text(encoding="utf-8"))


def evaluate_case(case):
    fixture = Base()
    fixture.setUp()
    try:
        if case.get("budget"):
            ai.bind(companion_context_config=lambda: {"chat_input_budget": case["budget"]})
        for text in case.get("prelude", []):
            memory.observe_user(text, DEV)
            fixture.clock[0] += 1
        history = list(case.get("history", []))
        for i in range(case.get("history_pairs", 0)):
            text = "robot calibration older evidence" if i == 0 else "unrelated gardening archived" if i < case["history_pairs"]-2 else "recent small talk"
            history.extend([{"role":"user", "text":text}, {"role":"assistant", "text":"noted"}])
        if history:
            thread = ai._empty_transferania()
            thread["messages"] = history
            ai.save_transferania(thread, DEV)
        code, out = ai.http_post({"action":"transferania", "op":"context_preview", "kind":"chat",
            "device_id":DEV, "persona":"warm", "message":case["message"]}, role="admin")
        assert code == 200, f"preview status {code}"
        usage = out["context_usage"]
        payload = json.dumps(out["contents"], ensure_ascii=False)
        assert out["read_only"] and out["model_calls"] == 0 and not fixture.calls
        assert usage["estimated_input_tokens"] <= usage["input_budget"]
        assert presence.classify(case["message"]) == case["mode"], "conversation mode"
        assert out["expression"]["primary"] == case["expression"], "response expression"
        assert ("TOUCHE FACULTATIVE" in payload) == case["quirk"], "quirk selection"
        assert payload.count("CONTEXTE ACTUEL:") <= 1, "duplicate context heading"
        assert payload.count("TOUCHE FACULTATIVE") <= 1, "repeated optional cue"
        assert out["system"].count("plus intense qu'Else") == 1, "character distinction/ownership"
        assert "recul technique et la retenue" in out["system"], "Else contrast"
        for required in case.get("required", []):
            assert required in payload, "missing grounded evidence"
        for forbidden in case.get("forbidden", []):
            assert forbidden not in payload, "irrelevant or invented context"
        if case.get("selected_kind"):
            assert any(row["kind"] == case["selected_kind"] and row["selected"] for row in usage["selection_manifest"]), "priority selection"
        return {"id":case["id"], "passed":True, "input_estimate":usage["estimated_input_tokens"],
            "budget":usage["input_budget"], "mode":case["mode"], "expression":out["expression"]["primary"],
            "quirk_selected":case["quirk"], "omitted_history_count":usage["omitted_history_count"],
            "selection_totals":usage["selection_totals"], "model_calls":0}
    finally:
        fixture.tearDown()
