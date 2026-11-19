"""Live personhood gate: her line must come out of real state, not a constant.

Signs in through the bridge's own /login (the PIN is read from
bridge_config.json and never printed), then drives six genuinely different
subject states for the session's own owner:

  hot        two turns about the subject inside the hour -> tier hot,  priority 98, share 530
  warm       one turn about it three hours ago          -> tier warm, priority 70, share 440
  cold       one turn about it twenty hours ago          -> tier cold, priority 40, share 380,
                                                            her line still carried, as a dated "SUJET ANCIEN";
                                                            he names the subject, so it opens again
  cold_unasked  the same old turn, a message that only         -> the same cold row, but dated and shut:
               greets her ("Salut, ça va ?")                   “ne pas le rouvrir de soi-même”
  repair_asked  an answer the Master corrected into another   -> one dated repair line, told once
                one, then the corrected topic returning          and silent on the next return
  repair_absent a store with no superseded answer              -> no repair line at all
  repair_view   the same correction, read through the recall   -> the ledger lists topic, both
                view (op memory), then asked again                answers, the date and both row
                                                                  ids; the read spends nothing, so
                                                                  the next real turn still says it
  repair_pruned the replaced answer pruned out of the archive  -> the view names topic and date,
                                                                  says "old" is missing, and the
                                                                  page carries "non reconstruite"
  repair_undated a journal correction with no change date      -> both texts named, "since"
                                                                  reported missing
  chapter_closed a project opened four days ago and closed     -> one dated chapter line, opened
                two minutes ago                                   and closed, said once
  corrected  the hot turns plus two corrections about it -> tier withheld, rung answering (pushback 2)
  recovered  those corrections, then two turns of his own -> back to hot, pushback 0
  burst      four corrections, five returns back to back    -> hot again, pushback 0, same row as hot
  climbing   four corrections, two returns                  -> tier answering, 95/518, offered (half-answered)
  deep       eight corrections, four returns                -> tier careful, 91/495, offered (four still open)
  deep_warm  sixteen corrections answered by eight older turns -> tier unready on the warm band, 48/390
  deep_hot   sixteen corrections answered by eight fresh turns -> tier unready on the hot band, 80/450

Her other trace-bearing lines are seeded too, each at both sides of the same warm
window, and each checked from the printed payload rather than from an assumed
string: fil_fresh/fil_stale carry a thread from Forgia's own visit log into
"FIL RÉCENT AVEC" / "FIL ANCIEN AVEC"; point_fresh/point_stale turn two
contradictory delivery signals into "POINT À ÉCLAIRCIR" / "POINT ANCIEN À
ÉCLAIRCIR"; visit_fresh/visit_stale put a visit in her own log so the recall
block itself is printed, as "VISITE RÉCENTE AVEC" / "VISITE ANCIENNE AVEC".

Every band is disjoint, so the deepest rung of a warmer band must outrank the
best row of the colder one: deepest warm (48/390) above best cold (40/380), and
deepest hot (80/450) above best warm (70/440). Every one of them is included in
the packet: each share covers the cost of her own line.

For each state it captures the live read-only /api/ai context_preview, compares
it with in-process assembly under the live companion config, and restores both
of the account's stores byte-for-byte. It fails closed when the bridge is stale
(``pending: true``) or when any predicted value does not match.

Run with the bridge up:  python scripts/verify_live_personhood.py
"""
from __future__ import annotations

import hashlib
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import hq_ai as ai  # noqa: E402
import hq_companion_memory as memory  # noqa: E402
import hq_personhood as ph  # noqa: E402
import hq_visit_memory as visits  # noqa: E402

BASE = "http://127.0.0.1:8765"
DEVICE = "hqtestdevice01ab"
# It names the subject (so the live pick cannot drift onto another recent turn)
# without being a recall request, which would hand the turn to the correction
# episode instead of letting her own salience decide.
MESSAGE = "La fermentation du chou, c'est intéressant."
# The subject of the closed chapter, named by his message so the pick can only
# land on it — the state is about how a closure reads, not about recall.
CHAPTER_MESSAGE = "Où en est le dossier fiscal ?"
COOKIE = "transfert_session"
SUBJECT = "Parle-moi de la fermentation du chou."

HOT = {"tier": "hot", "priority": 98, "share": 530, "selected": True, "pushback": 0}
WARM = {"tier": "warm", "priority": 70, "share": 440, "selected": True, "pushback": 0}
COLD = {"tier": "cold", "priority": 40, "share": 380, "selected": True, "pushback": 0}
PUSHED = {"tier": "withheld", "rung": "answering", "priority": 95, "share": 518,
          "selected": False, "withhold": True, "pushback": 2}
# Same recent evidence as hot, but the Master corrected this very subject twice:
# the offer is withdrawn instead of merely shrinking...
# ...and the same corrections followed by his own return to it twice restore her
# full salience: the fade is a pause, not a verdict.
RECOVERED = {"tier": "hot", "priority": 98, "share": 530, "selected": True, "pushback": 0}
# Four corrections answered by five returns in one burst: the store keeps only
# three sources per subject, so the row must come back from the ledger itself.
BURST = {"tier": "hot", "priority": 98, "share": 530, "selected": True, "pushback": 0}
# Half of four corrections answered: she is back in the offer, between the
# withdrawn subject and her own salience, rather than switched on abruptly.
CLIMBING = {"tier": "answering", "rung": "answering", "priority": 95, "share": 518,
            "selected": True, "pushback": 2, "progress": 0.5}
# Eight corrections, four answered: deep in a long recovery, exactly half
# answered, so the ladder keeps her named four rungs down instead of withheld.
DEEP = {"tier": "careful", "rung": "careful", "priority": 91, "share": 495,
        "selected": True, "pushback": 4, "progress": 0.5}
# The deepest rung of each band, so the bands can be compared where they meet.
DEEP_WARM = {"tier": "unready", "rung": "unready", "priority": 48, "share": 390,
             "selected": True, "pushback": 8, "progress": 0.5}
DEEP_HOT = {"tier": "unready", "rung": "unready", "priority": 80, "share": 450,
            "selected": True, "pushback": 8, "progress": 0.5}
# Her other three lines, in their own warm and cold bands: a thread, an open
# question, and the recall page (which is a page block, so it has no salience of
# its own — only the default priority and no declared byte share).
FIL_WARM = {"tier": "warm", "priority": 70, "share": 440, "selected": True, "basis": "visit"}
FIL_COLD = {"tier": "cold", "priority": 40, "share": 380, "selected": True, "basis": "visit"}
FIL_HOT = {"tier": "hot", "rung": "hot", "priority": 98, "share": 530, "selected": True, "basis": "visit"}
POINT_WARM = {"tier": "warm", "priority": 70, "share": 440, "selected": True, "basis": "contested"}
POINT_COLD = {"tier": "cold", "priority": 40, "share": 380, "selected": True, "basis": "contested"}
# The recall page ranks by the visit it quotes, in the same bands as her
# subject line: a fresh visit is warm, an old one is cold.
VISIT_PAGE = {"tier": "warm", "rung": "warm", "priority": 70, "share": 440, "selected": True,
              "basis": "visit_recall", "visit_page": True}
VISIT_PAGE_STALE = {"tier": "cold", "rung": "cold", "priority": 40, "share": 380, "selected": True,
                    "basis": "visit_recall", "visit_page": True}
# The same sister, visited again and again: repeats comes from the log, so the
# recall page reaches the hot band exactly as a repeated subject does.
VISIT_PAGE_REPEAT = {"tier": "hot", "rung": "hot", "priority": 98, "share": 530, "selected": True,
                     "basis": "visit_recall", "visit_page": True}
# A correction that replaced an earlier answer: the repair line ranks by the
# moment the answer changed (warm band, one open correction -> almost herself).
REPAIR = {"tier": "almost_herself", "rung": "almost_herself", "priority": 68, "share": 431,
          "selected": True, "basis": "repair", "pushback": 1}
# The ledger read back, asked for in her own words: the same records, listed.
# A statement, not a recall question: the episode slot is not handed the turn,
# so the ledger is the one thing this message is asking for.
LEDGER_QUERY = "Montre-moi tes corrections du journal."
REPAIR_VIEW = {"view": "complete"}
REPAIR_LOST_OLD = {"view": "old"}
REPAIR_NO_DATE = {"view": "since"}
REPAIR_SEED = {"old": "J'aime la fermentation du chou.",
               "new": "Je n'aime pas la fermentation du chou."}
VISIT_ELSE_LINES = [{"who": "else", "text": "On a reparlé du chou, elle avait des chiffres."},
                    {"who": "transferania", "text": "Je lui ai dit que le chou fermentait encore."}]
VISIT_LINES = [{"who": "forgia", "text": "On a reparlé du chou et du bras robot."},
               {"who": "transferania", "text": "Je lui ai dit que le chou fermentait encore."}]
VISIT_QUERY = "Tu penses à Forgia ?"
ELSE_QUERY = "Tu penses à Else ?"
SOCIAL = "Salut, ça va ?"
# Both land on brevity, one per side, so the store has an open question to show.
CONCISE = "Sois plus court, c'est trop long."
DETAIL = "Explique davantage, plus de détail."
STATES = {
    "hot": {"expected": HOT, "ages": (3600, 1800)},
    "warm": {"expected": WARM, "ages": (3 * 3600,)},
    # The dated wording only suppresses the reopen when nothing in his message
    # touches the subject: naming it hands the reopen back to him.
    "cold": {"expected": {**COLD, "asked": True}, "ages": (20 * 3600,)},
    "cold_unasked": {"expected": COLD, "ages": (20 * 3600,), "message": SOCIAL},
    "pushed_back": {"expected": PUSHED, "ages": (3600, 1800), "corrections": 2},
    "recovered": {"expected": RECOVERED, "ages": (1800, 900), "corrections": 2,
                  "correction_age": 3 * 3600},
    "burst": {"expected": BURST, "ages": (1800, 1500, 1200, 900, 600), "corrections": 4,
              "correction_age": 4 * 3600},
    "climbing": {"expected": CLIMBING, "ages": (1800, 1500), "corrections": 4,
                 "correction_age": 4 * 3600},
    "deep": {"expected": DEEP, "ages": (1800, 1500, 1200, 900), "corrections": 8,
             "correction_age": 6 * 3600},
    # Eight open of sixteen, answered by turns old enough to stay out of the hot
    # window: the deepest warm rung, which must still outrank a cold subject.
    "deep_warm": {"expected": {**DEEP_WARM, "asked": True},
                  "ages": (63000, 62280, 61560, 60840, 60120, 59400, 58680, 57960),
                  "corrections": 16, "correction_age": 23 * 3600},
    # The same depth on the hot band: every return inside the recent window.
    "deep_hot": {"expected": DEEP_HOT,
                 "ages": (3000, 2700, 2400, 2100, 1800, 1500, 1200, 900),
                 "corrections": 16, "correction_age": 20 * 3600},
    # Her other trace-bearing lines, each seeded at both sides of the window the
    # code already declares. ``fil_*`` seeds the visit in the sister's own log,
    # which is the only way her thread line reaches the prompt unobstructed;
    # ``visit_*`` seeds it in her own, so the recall block owns the slot.
    "fil_fresh": {"expected": FIL_WARM, "message": VISIT_QUERY,
                  "visit": {"ages": (3600,), "log": "other", "other": "forgia", "name": "Forgia",
                            "lines": VISIT_LINES}},
    "fil_stale": {"expected": FIL_COLD, "message": VISIT_QUERY,
                  "visit": {"ages": (20 * 3600,), "log": "other", "other": "forgia", "name": "Forgia",
                            "lines": VISIT_LINES}},
    # The thread line for the same sister, read from *her* own log: the two
    # sisters' files are the same path, seen from the other side of the visit.
    "fil_else_fresh": {"expected": FIL_WARM, "message": ELSE_QUERY,
                       "visit": {"ages": (3600,), "log": "other", "other": "else", "name": "Else",
                                 "lines": VISIT_ELSE_LINES}},
    "fil_else_stale": {"expected": FIL_COLD, "message": ELSE_QUERY,
                       "visit": {"ages": (20 * 3600,), "log": "other", "other": "else", "name": "Else",
                                 "lines": VISIT_ELSE_LINES}},
    # The same sister visited three times inside the window, read from her own log:
    # the thread line must report the count and the rung the recall page does for
    # that same history, instead of calling it a one-off.
    "fil_repeat": {"expected": FIL_HOT, "message": VISIT_QUERY,
                   "visit": {"ages": (3600, 7200, 10800), "log": "other", "other": "forgia",
                             "name": "Forgia", "lines": VISIT_LINES}},
    "fil_else_repeat": {"expected": FIL_HOT, "message": ELSE_QUERY,
                        "visit": {"ages": (3600, 7200, 10800), "log": "other", "other": "else",
                                  "name": "Else", "lines": VISIT_ELSE_LINES}},
    "point_fresh": {"expected": POINT_WARM, "message": SOCIAL,
                    "feedback": ((3600, CONCISE), (1800, DETAIL))},
    "point_stale": {"expected": POINT_COLD, "message": SOCIAL,
                    "feedback": ((20 * 3600, CONCISE), (19 * 3600, DETAIL))},
    "visit_fresh": {"expected": VISIT_PAGE, "message": VISIT_QUERY,
                    "visit": {"ages": (3600,), "log": "own", "other": "forgia", "name": "Forgia",
                              "lines": VISIT_LINES, "page": True}},
    "visit_stale": {"expected": VISIT_PAGE_STALE, "message": VISIT_QUERY,
                    "visit": {"ages": (20 * 3600,), "log": "own", "other": "forgia", "name": "Forgia",
                              "lines": VISIT_LINES, "page": True}},
    # Growth over time: an answer the Master corrected into another one. The line
    # is derived from the archive, told once, and silent once it has been told.
    "repair_asked": {"expected": REPAIR, "message": MESSAGE,
                     "repair": {"old": "J'aime la fermentation du chou.",
                                "new": "Je n'aime pas la fermentation du chou."}},
    "repair_absent": {"expected": {"empty": True, "selected": False}, "message": MESSAGE},
    # The same correction, read through the recall view and then asked again.
    "repair_view": {"expected": REPAIR_VIEW, "message": LEDGER_QUERY,
                    "repair": REPAIR_SEED, "view": {"seed": "complete"}},
    # The archive it can no longer fully rebuild: named, not guessed.
    "repair_pruned": {"expected": REPAIR_LOST_OLD, "message": LEDGER_QUERY,
                      "repair": REPAIR_SEED, "view": {"seed": "prune"}},
    "repair_undated": {"expected": REPAIR_NO_DATE, "message": LEDGER_QUERY,
                       "repair": REPAIR_SEED, "view": {"seed": "undated"}},
    # A recorded outcome is a past chapter, not a pending thread: dated from its
    # opening, read from the stored episode that closed it, and said once.
    "chapter_closed": {"expected": {**ph.salience(120, 1), "basis": "chapter", "selected": True},
                       "message": CHAPTER_MESSAGE,
                       "chapter": {"topic": "le dossier fiscal",
                                   "opening": "Je travaille sur le dossier fiscal.",
                                   "outcome": "C'est fait pour le dossier fiscal.",
                                   "age": 4 * 86400}},
    "visit_repeat": {"expected": VISIT_PAGE_REPEAT, "message": VISIT_QUERY,
                     "visit": {"ages": (3600, 7200, 10800), "log": "own", "other": "forgia",
                               "name": "Forgia", "lines": VISIT_LINES, "page": True}},
    # The other sister through the same log and the same bands: one visit is warm,
    # one old visit is cold, three recent ones reach hot.
    "visit_else_fresh": {"expected": VISIT_PAGE, "message": ELSE_QUERY,
                         "visit": {"ages": (3600,), "log": "own", "other": "else", "name": "Else",
                                   "lines": VISIT_ELSE_LINES, "page": True}},
    "visit_else_stale": {"expected": VISIT_PAGE_STALE, "message": ELSE_QUERY,
                         "visit": {"ages": (20 * 3600,), "log": "own", "other": "else", "name": "Else",
                                   "lines": VISIT_ELSE_LINES, "page": True}},
    "visit_else_repeat": {"expected": VISIT_PAGE_REPEAT, "message": ELSE_QUERY,
                          "visit": {"ages": (3600, 7200, 10800), "log": "own", "other": "else",
                                    "name": "Else", "lines": VISIT_ELSE_LINES, "page": True}},
}
CORRECTIONS = ["J'aime la fermentation du chou.", "Je n'aime pas la fermentation du chou.",
               "J'aime beaucoup la fermentation du chou.",
               "Je me trompe souvent sur la fermentation du chou.",
               "La fermentation du chou me lasse.",
               "La fermentation du chou, c'est fade.",
               "Je préfère le chou cru, pas fermenté.",
               "La fermentation du chou sent trop fort.",
               "Le chou fermenté, c'est trop acide.",
               "Je n'en veux plus au petit-déjeuner.",
               "La texture du chou fermenté me déplaît.",
               "Je préfère le chou rôti.",
               "La fermentation du chou prend trop de place.",
               "Je trouve ça trop salé.",
               "Le chou fermenté, ça me fatigue.",
               "Je me suis lassé de la fermentation du chou."]


def config() -> dict:
    return json.loads((ROOT / "bridge_config.json").read_text(encoding="utf-8"))


def self_path(owner: str) -> Path:
    with memory.owner_context(owner), memory.memory_scope("transferania"):
        with ph._scope("transferania", owner) as path:
            return Path(path)


def memory_path(owner: str) -> Path:
    with memory.owner_context(owner), memory.memory_scope("transferania"):
        return Path(memory.path())


def visit_path(owner: str, key: str) -> Path:
    with memory.owner_context(owner), memory.memory_scope("transferania"):
        return Path(ph._visit_path_for(key, owner))


def get(opener, path: str):
    request = urllib.request.Request(BASE + path, headers={"Referer": BASE + "/"}, method="GET")
    try:
        with opener.open(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def post(opener, path: str, *, data=None, form=None):
    body, headers = None, {"Origin": BASE, "Referer": BASE + "/"}
    if form is not None:
        body = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(BASE + path, data=body, headers=headers, method="POST")
    try:
        with opener.open(request, timeout=60) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers)


def freshness(opener) -> dict:
    status, raw = get(opener, "/api/pc/restart-bridge")
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return {"status": status, "readable": False}
    return {"status": status, "pending": data.get("pending"), "pid": data.get("pid"),
            "started_at": data.get("started_at")}


def pinned(usage: dict, contents: list, line: str = "") -> dict:
    text = json.dumps(contents, ensure_ascii=False)
    return {
        "budget": usage["input_budget"],
        "estimate": usage["estimated_input_tokens"],
        "totals": usage["selection_totals"],
        "rows": [(r["kind"], r["selected"], r["reason"], r["priority"], r.get("share"))
                 for r in usage["selection_manifest"]],
        "personhood": [r for r in usage["selection_manifest"] if r["kind"] == "personhood"],
        "hint_in_payload": bool(line) and line in text,
        "hint_text": next((part["text"] for m in contents for part in m.get("parts", [])
                           if isinstance(part.get("text"), str) and line and line in part["text"]), ""),
        "page_text": "\n".join(part["text"] for m in contents for part in m.get("parts", [])
                                if isinstance(part.get("text"), str)),
    }


def owner_for_token(token: str) -> str:
    raw = json.loads((ROOT / "bridge_sessions.json").read_text(encoding="utf-8"))
    return ((raw.get(token) if isinstance(raw, dict) else None) or {}).get("user") or "admin"


def _view_seed(data: dict, seed: str, live_id: str) -> dict:
    """Make the archive thin in one specific, honest way. Nothing is invented."""
    if seed == "complete":
        return data
    key = next((m.get("key") for m in data["memories"] if m.get("id") == live_id), "")
    if seed == "prune":
        # The replaced answer was pruned: the new words and their date survive.
        data["memories"] = [m for m in data["memories"] if m.get("status") != "superseded"]
        return data
    if seed == "undated":
        # A journal correction from before ``corrected_at`` existed: both texts
        # survive, the moment the answer changed was never kept.
        old = next((m for m in data["memories"] if m.get("key") == key
                    and m.get("status") == "superseded"), None)
        live = next((m for m in data["memories"] if m.get("key") == key
                     and m.get("status") == "active"), {})
        topic = live.get("subject") or ""
        data["memories"] = [m for m in data["memories"] if m.get("key") != key]
        data["episodes"].extend([
            {"id": "verify-old-side", "text": (old or {}).get("text") or "",
             "kind": "interest", "topic": topic, "source_device": DEVICE, "source_key": None,
             "at": time.time() - 3600, "evidence": "user_statement", "status": "superseded"},
            {"id": "verify-new-side", "text": live.get("text") or "",
             "kind": "interest", "topic": topic, "source_device": DEVICE, "source_key": None,
             "at": time.time() - 3600, "evidence": "user_correction", "status": "active"}])
        return data
    return data


def capture_state(opener, owner: str, live_cfg: dict, ages: tuple = (), corrections: int = 0,
                  correction_age: float = 600, *, message: str = MESSAGE,
                  visit: dict | None = None, feedback: tuple = (),
                  repair: dict | None = None, view: dict | None = None,
                  chapter: dict | None = None) -> dict:
    """Seed one state, capture live + in-process, restore every store it touched."""
    path = self_path(owner)
    store = memory_path(owner)
    logs = {key: visit_path(owner, key) for key in ("transferania", "forgia", "else")}
    def snapshot(file: Path):
        if not file.exists():
            return None
        stat = file.stat()
        return file.read_bytes(), stat.st_atime_ns, stat.st_mtime_ns

    original = snapshot(path)
    other = snapshot(store)
    log_originals = {log: snapshot(log) for log in logs.values()}
    before = hashlib.sha256(original[0] if original else b"").hexdigest()
    seed_ages = list(ages) + (list(visit["ages"]) if visit else []) + [age for age, _ in feedback]
    out = {"ages": list(ages), "message": message, "store_restored": False,
           "seed_age_s": max(seed_ages) if seed_ages else None}
    try:
        with memory.owner_context(owner), memory.memory_scope("transferania"):
            # The store only surfaces its two most recent threads, so a capture
            # must start from just this subject: otherwise real traffic decides
            # the pick. The original file is put back in ``finally``.
            with ph._scope("transferania", owner) as store_path:
                with ph._lock:
                    data = ph._load(Path(store_path), "transferania")
                    data["events"] = []
                    ph._write(Path(store_path), data)
            for age in ages:
                ph.observe_chat("transferania", SUBJECT, now=time.time() - age)
            for age, phrase in feedback:
                ph.observe_chat("transferania", phrase, now=time.time() - age)
            # Both visit logs start empty: a real visit would otherwise be picked
            # ahead of the seeded one and decide the state. They are restored in
            # ``finally`` like the other stores.
            for log in logs.values():
                log.parent.mkdir(parents=True, exist_ok=True)
                log.write_text('{"v": 1, "visits": []}\n', encoding="utf-8")
            # Oldest first: a record prunes against its own timestamp, so writing
            # a more recent visit first would drop the next one.
            for age in sorted((visit or {}).get("ages", ()), reverse=True):
                stamp = time.time() - float(age)
                if visit.get("log") == "own":
                    visits.record(logs["transferania"], self_key="transferania",
                                  other_key=visit["other"], other_name=visit["name"],
                                  lines=visit["lines"], now=stamp)
                else:
                    # A visit the sister recorded in her own log: the same visit,
                    # seen from the other side of it.
                    visits.record(logs[visit["other"]], self_key=visit["other"],
                                  other_key="transferania", other_name="Transferania",
                                  lines=visit["lines"], now=stamp)
            if repair:
                # Growth over time: an answer she used to give, then the Master's
                # correction replacing it. Both texts stay in the archive.
                memory.observe_user(repair["old"], DEVICE)
                wanted = memory.fold(repair["old"]).strip(" .!")
                target = next((m for m in memory.snapshot()["memories"]
                               if memory.fold(m["text"]).strip(" .!") == wanted), None)
                if target is None:
                    raise RuntimeError(f"repair seed: {repair['old']!r} did not become a memory")
                memory.correct(target["id"], repair["new"])
                if view:
                    memory._save(_view_seed(memory._load(), str(view.get("seed") or ""), target["id"]))
            if corrections:
                # The archive keeps one active correction per subject; the earlier
                # ones stay as superseded evidence of the repetition.
                mem = memory._load()
                for index in range(corrections):
                    mem["episodes"].append({
                        "id": f"verify-correction{index}",
                        "text": CORRECTIONS[index], "kind": "correction",
                        "topic": "fermentation du chou", "source_device": DEVICE,
                        "source_key": "preference:fermentation du chou",
                        "at": time.time() - correction_age, "evidence": "user_correction",
                        "status": "active" if index == corrections - 1 else "superseded"})
                memory._save(mem)
            if chapter:
                # A closed chapter, held in the archive itself: an opening episode
                # and the outcome episode that closed it, both dated.
                mem = memory._load()
                mem["episodes"].append({
                    "id": "verify-chapter-opening", "text": chapter["opening"], "kind": "interest",
                    "topic": chapter["topic"], "source_device": DEVICE, "source_key": None,
                    "at": time.time() - float(chapter["age"]), "evidence": "explicit_statement",
                    "status": "active"})
                mem["episodes"].append({
                    "id": "verify-chapter-outcome", "text": chapter["outcome"], "kind": "outcome",
                    "topic": chapter["topic"], "source_device": DEVICE, "source_key": None,
                    "at": time.time() - 120, "evidence": "explicit_statement", "status": "active"})
                memory._save(mem)
        # Read-only salience: the same helper the pipeline uses, without
        # recording a turn that would take the continuity slot from her line.
        with memory.owner_context(owner), memory.memory_scope("transferania"):
            archive = memory._load().get("episodes", [])
        pushback = [{"topic": e.get("topic") or "", "text": e.get("text") or "", "at": e.get("at")}
                    for e in archive if e.get("kind") == "correction"]
        # Read-only: the repair records the archive already implies, unmarked, so
        # the live and in-process previews stay deterministic.
        repairs = []
        if repair:
            with memory.owner_context(owner), memory.memory_scope("transferania"):
                repairs = [dict(row, quoted=False) for row in memory.repair_records(memory._load(), time.time())]
            out["repair"] = repairs[0] if repairs else None
        chapters = []
        if chapter:
            with memory.owner_context(owner), memory.memory_scope("transferania"):
                chapters = [dict(row, quoted=False)
                            for row in memory.chapter_records(memory._load(), time.time())]
            wanted = memory.fold(chapter["topic"])
            out["chapter"] = next((row for row in chapters
                                   if memory.fold(row["topic"]) == wanted), None)
        if visit and visit.get("page"):
            # A visit recall owns the continuity slot before her own salience is
            # even consulted, so this state has no salience of its own to report.
            # The clock is passed explicitly: ``memory._now`` is only bound once
            # the bridge has, and this script runs before that.
            out["line"], visit_age, visit_repeats = visits.hint_detail(
                logs["transferania"], self_key="transferania", query=message, now=time.time(),
                stale_after=ph.SALIENCE_WARM_S)
            out["salience"] = {**ph.salience(visit_age, visit_repeats), "basis": "visit_recall"}
        else:
            detail = ph.hint_detail("transferania", message, owner=owner, now=time.time(),
                                    pushback=pushback, repairs=repairs, chapters=chapters)
            out["salience"] = {k: detail[k] for k in ("tier", "rung", "base", "score", "priority",
                                                      "share", "basis", "age_s", "repeats", "pushback",
                                                      "corrected", "progress", "withhold")
                               if k in detail}
            out["line"] = detail.get("line") or ""

        if view:
            # The recall surface the operator actually reads: the same ledger,
            # listed. Read before any real turn, so what follows proves the read
            # cost nothing.
            status, body, _ = post(opener, "/api/ai", data={"action": "transferania", "op": "memory",
                                                           "device_id": DEVICE})
            out["view_status"] = status
            out["view"] = (json.loads(body.decode("utf-8")).get("repairs")
                           if status == 200 else None)
        payload = {"action": "transferania", "op": "context_preview", "kind": "chat",
                   "device_id": DEVICE, "persona": "warm", "message": message}
        status, body, _ = post(opener, "/api/ai", data=payload)
        out["preview_status"] = status
        live = json.loads(body.decode("utf-8"))
        out["read_only"] = live.get("read_only")
        out["model_calls"] = live.get("model_calls")
        out["live"] = pinned(live["context_usage"], live["contents"], out["line"])
        out["system_bytes"] = len(live["system"].encode("utf-8"))

        ai.bind(root=ROOT, companion_context_config=lambda: live_cfg)
        code, inproc = ai.http_post(dict(payload), role="admin", owner_id=owner)
        out["inproc_status"] = code
        out["inproc"] = pinned(inproc["context_usage"], inproc["contents"], out["line"])
        out["system_identical"] = live["system"] == inproc["system"]
        if repair:
            # The line is told once, on a real turn; a second return has to stay quiet.
            with memory.owner_context(owner), memory.memory_scope("transferania"):
                first = memory.context_packet(message, conversation_text=message, reserve_followup=True)
                second = memory.context_packet(message, conversation_text=message, reserve_followup=True)
            out["repair_once"] = {"first": first.get("repair"), "second": second.get("repair"),
                                  "line": first.get("continuity") or "",
                                  "second_line": second.get("continuity") or ""}
        if chapter:
            # The line is said once, on a real turn; a second return stays quiet.
            with memory.owner_context(owner), memory.memory_scope("transferania"):
                first = memory.context_packet(message, conversation_text=message, reserve_followup=True)
                second = memory.context_packet(message, conversation_text=message, reserve_followup=True)
            out["chapter_once"] = {"first": first.get("chapter"), "second": second.get("chapter"),
                                   "line": first.get("continuity") or "",
                                   "second_line": second.get("continuity") or ""}
        if view and view.get("seed") == "complete":
            # A real turn about the corrected subject, after the read: the one-time
            # line must still be there.
            with memory.owner_context(owner), memory.memory_scope("transferania"):
                after_view = memory.context_packet(MESSAGE, conversation_text=MESSAGE, reserve_followup=True)
            out["view_then_turn"] = after_view.get("repair")
    finally:
        def restore(file: Path, saved) -> None:
            # Put the bytes back and give the file its old timestamps, so a store
            # this run seeded is indistinguishable from one nobody touched.
            if saved is None:
                if file.exists():
                    file.unlink()
                return
            data, atime_ns, mtime_ns = saved
            if not file.exists() or file.read_bytes() != data:
                file.write_bytes(data)
            os.utime(file, ns=(atime_ns, mtime_ns))

        restore(path, original)
        restore(store, other)
        for log, saved in log_originals.items():
            restore(log, saved)
        after = hashlib.sha256(path.read_bytes() if path.exists() else b"").hexdigest()
        out["visits_restored"] = all((log.read_bytes() if log.exists() else None) == (saved[0] if saved else None)
                                     for log, saved in log_originals.items())
        out["memory_restored"] = (hashlib.sha256(store.read_bytes() if store.exists() else b"").hexdigest()
                                  == hashlib.sha256(other[0] if other else b"").hexdigest())
        out["store_restored"] = after == before
        out["store_sha256"] = after[:16]
    return out


def check_view(name: str, expected: dict, result: dict, failures: list[str]) -> None:
    """The recall view lists what the ledger holds, and says what it no longer does."""
    if result.get("view_status") != 200:
        failures.append(f"{name}: the recall view answered {result.get('view_status')}")
        return
    view = result.get("view") or {}
    rows = view.get("rows") or []
    if not rows:
        failures.append(f"{name}: the recall view listed no repair")
        return
    row, want = rows[0], expected["view"]
    if memory.fold(row.get("topic") or "") != "fermentation du chou":
        failures.append(f"{name}: the view names {row.get('topic')!r} instead of the corrected topic")
    if row.get("basis") != "repair":
        failures.append(f"{name}: the view row is not marked with basis repair")
    evidence = row.get("evidence") or {}
    if not evidence.get("live"):
        failures.append(f"{name}: the view does not name the row that carries the new answer")
    shown = (result["live"].get("page_text") or "")
    if want == "complete":
        if not row.get("complete") or row.get("missing"):
            failures.append(f"{name}: a fully held repair is not reported as complete")
        if "aime la fermentation" not in memory.fold(row.get("old") or ""):
            failures.append(f"{name}: the view lost the old answer")
        if "n'aime pas la fermentation" not in memory.fold(row.get("new") or ""):
            failures.append(f"{name}: the view lost the new answer")
        if not evidence.get("superseded"):
            failures.append(f"{name}: the view does not name the row that carried the old answer")
        if evidence.get("superseded") == evidence.get("live"):
            failures.append(f"{name}: the view names one row as both sides of the repair")
        since = row.get("since")
        if not isinstance(since, (int, float)) or not 0 <= time.time() - float(since) <= 3600:
            failures.append(f"{name}: the view dates the change as {since!r}")
        if "RÉPARATIONS DU JOURNAL" not in shown:
            failures.append(f"{name}: the ledger page did not reach the packet")
        if "journal : " + str(evidence.get("live"))[:8] not in shown:
            failures.append(f"{name}: the page does not carry the evidence ids")
        if (result.get("view_then_turn") or {}).get("basis") != "repair":
            failures.append(f"{name}: reading the view spent the one-time line")
        return
    if row.get("complete"):
        failures.append(f"{name}: a ledger it cannot rebuild is reported as complete")
    if want not in (row.get("missing") or []):
        failures.append(f"{name}: the view does not say {want!r} is missing")
    if want == "old":
        if row.get("old") is not None:
            failures.append(f"{name}: the view invented an old answer it does not hold")
        if not row.get("since"):
            failures.append(f"{name}: the view lost the date it does hold")
    if want == "since":
        if row.get("since") is not None:
            failures.append(f"{name}: the view dated a change it never recorded")
        if not row.get("old"):
            failures.append(f"{name}: the view lost the old answer it does hold")
    if "non reconstruite" not in shown:
        failures.append(f"{name}: the page does not say the repair is incomplete")


def check_state(name: str, expected: dict, result: dict, failures: list[str]) -> None:
    live, inproc = result["live"], result["inproc"]
    rows = live["personhood"]
    if expected.get("view"):
        check_view(name, expected, result, failures)
        return
    if expected.get("empty"):
        # The legitimate silence: nothing superseded, so nothing may be claimed.
        if result.get("line") or rows:
            failures.append(f"{name}: a line was offered with nothing to derive it from")
        if "RÉPARATION" in (live.get("hint_text") or ""):
            failures.append(f"{name}: a repair was printed without a superseded answer")
        return
    if not rows and not expected.get("withhold"):
        failures.append(f"{name}: no personhood row in the live manifest")
        return
    row = rows[0] if rows else {}
    if expected.get("withhold"):
        if rows:
            failures.append(f"{name}: a corrected subject still has a personhood row")
        if result["salience"].get("withhold") is not True:
            failures.append(f"{name}: withhold not set in the in-process salience")
        if result["salience"].get("pushback") != 2:
            failures.append(f"{name}: pushback {result['salience'].get('pushback')} != 2")
        if live["hint_in_payload"] or result.get("line"):
            failures.append(f"{name}: the withdrawn subject still reaches the prompt")
        if "personhood" in live["totals"]:
            failures.append(f"{name}: a withdrawn line is counted as selected")
    if "basis" in expected and result["salience"].get("basis") != expected["basis"]:
        failures.append(f"{name}: basis {result['salience'].get('basis')} != {expected['basis']}")
    if expected.get("tier") is not None and result["salience"].get("tier") != expected["tier"]:
        failures.append(f"{name}: tier {result['salience'].get('tier')} != {expected['tier']}")
    if "pushback" in expected and result["salience"].get("pushback") != expected["pushback"]:
        failures.append(f"{name}: net pushback {result['salience'].get('pushback')} != {expected['pushback']}")
    if "progress" in expected and result["salience"].get("progress") != expected["progress"]:
        failures.append(f"{name}: climb progress {result['salience'].get('progress')} != {expected['progress']}")
    if "rung" in expected and result["salience"].get("rung") != expected["rung"]:
        failures.append(f"{name}: rung {result['salience'].get('rung')} != {expected['rung']}")
    if expected.get("basis") == "repair":
        # The line must name both answers and the moment the answer changed,
        # and it must be the line the payload really carries.
        told = result.get("repair") or {}
        shown = result.get("printed_line") or ""
        if not result.get("line", "").startswith("RÉPARATION — "):
            failures.append(f"{name}: the repair line does not announce itself")
        for piece in ("je disais", "je dis"):
            if piece not in result.get("line", ""):
                failures.append(f"{name}: the repair line does not say {piece!r}")
        if told.get("old") and told["old"].split()[0] not in result.get("line", ""):
            failures.append(f"{name}: the repair line does not name the old answer")
        if told.get("new") and told["new"].split()[0] not in result.get("line", ""):
            failures.append(f"{name}: the repair line does not name the new answer")
        if told.get("since") and ph._date(float(told["since"])) not in result.get("line", ""):
            failures.append(f"{name}: the repair line does not date the change")
        if len(result.get("line", "").encode("utf-8")) > ph.MAX_HINT_BYTES:
            failures.append(f"{name}: the repair line overruns the hint budget")
        if shown and not shown.startswith("RÉPARATION — "):
            failures.append(f"{name}: the printed line is not the repair")
    if expected.get("basis") == "chapter":
        told = result.get("chapter") or {}
        line = result.get("line") or ""
        printed = live.get("hint_text") or ""
        if not line.startswith("CHAPITRE CLOS — "):
            failures.append(f"{name}: the chapter line does not announce itself")
        if not told:
            failures.append(f"{name}: the chapter was not read from stored episodes")
        else:
            for stamp in (told.get("opened_at"), told.get("closed_at")):
                if stamp and ph._date(float(stamp)) not in line:
                    failures.append(f"{name}: the chapter line does not date its own evidence")
            if "jours" not in line:
                failures.append(f"{name}: the chapter line does not say how long it ran")
            if told.get("topic", "").split()[-1] not in line:
                failures.append(f"{name}: the chapter line does not name the closed subject")
            if not str(told.get("closed_id") or "").startswith("verify-chapter-outcome"):
                failures.append(f"{name}: the chapter does not point at the episode that closed it")
        if len(line.encode("utf-8")) > ph.MAX_HINT_BYTES:
            failures.append(f"{name}: the chapter line overruns the hint budget")
        once = result.get("chapter_once") or {}
        if (once.get("first") or {}).get("basis") != "chapter":
            failures.append(f"{name}: a real turn about the closed subject did not say the chapter")
        if once.get("second") is not None:
            failures.append(f"{name}: the chapter was said twice")
        if "CHAPITRE CLOS" not in (once.get("line") or ""):
            failures.append(f"{name}: the reserved turn did not carry the chapter line")
        if "CHAPITRE CLOS" not in printed:
            failures.append(f"{name}: the printed payload does not carry the chapter line")
    if expected.get("share") is not None and (result["salience"].get("share") or 0) != expected["share"] \
            and not expected.get("withhold"):
        failures.append(f"{name}: in-process share {result['salience'].get('share')} != {expected['share']}")

    if row and row.get("priority") != expected["priority"]:
        failures.append(f"{name}: live priority {row['priority']} != {expected['priority']}")
    if row and expected.get("share") is not None and row.get("share") != expected["share"]:
        failures.append(f"{name}: live share {row.get('share')} != {expected['share']}")
    if row and expected.get("visit_page") and not row.get("rung"):
        failures.append(f"{name}: the recall page did not carry the rung its visit implies")
    if row and "rung" in expected and row.get("rung") != expected["rung"]:
        failures.append(f"{name}: live row rung {row.get('rung')} != {expected['rung']}")
    if expected["selected"] and row.get("selected") is not True:
        failures.append(f"{name}: live selected {row['selected']} != {expected['selected']}")
    if expected["selected"] and live["hint_in_payload"] is not True:
        failures.append(f"{name}: her line is selected but absent from the payload")
    if not expected["selected"] and not expected.get("withhold"):
        if live["hint_in_payload"]:
            failures.append(f"{name}: a refused line reached the payload")
        if row["reason"] != "budget":
            failures.append(f"{name}: refusal reason {row['reason']} != budget")
        if "personhood" in live["totals"]:
            failures.append(f"{name}: refused line still counted as selected")
    if live["rows"] != inproc["rows"]:
        failures.append(f"{name}: live rows differ from in-process")
    for key in ("budget", "estimate", "totals", "hint_in_payload"):
        if live[key] != inproc[key]:
            failures.append(f"{name}: live {key} differs from in-process")
    if not result.get("system_identical"):
        failures.append(f"{name}: live system prompt differs from in-process")
    if live["budget"] != (live["estimate"] + (live["budget"] - live["estimate"])):
        failures.append(f"{name}: budget arithmetic broken")
    if result.get("read_only") is not True or result.get("model_calls") != 0:
        failures.append(f"{name}: the live preview was not read-only")
    if not result.get("store_restored"):
        failures.append(f"{name}: personhood store was not restored")
    if not result.get("memory_restored"):
        failures.append(f"{name}: companion memory store was not restored")
    if not result.get("line") and not result["salience"].get("withhold"):
        failures.append(f"{name}: the store offered no line for this state")

    # What the payload actually prints, not what a test expected it to print:
    # the block must begin with the line the pipeline assembled, and its own age
    # must be readable there.
    if expected["selected"] and row:
        printed = live.get("hint_text") or ""
        shown = next((ln.strip() for ln in printed.splitlines() if ln.strip() == result["line"].strip()), "")
        result["printed_line"] = shown
        if not shown:
            failures.append(f"{name}: the printed payload does not carry the assembled line as its own line")
        seed_age = result.get("seed_age_s")
        old = seed_age is not None and seed_age > ph.SALIENCE_WARM_S
        if shown and old and "trace locale du" not in shown:
            failures.append(f"{name}: a trace past the warm window is printed as current")
        if shown and not old and "trace locale du" in shown:
            failures.append(f"{name}: a fresh trace is printed as an old one")
        if shown and old:
            if expected.get("asked"):
                if "il y revient maintenant" not in shown:
                    failures.append(f"{name}: he came back to this subject and the old trace still stays shut")
                if "rouvrir de soi-même" in shown.lower():
                    failures.append(f"{name}: an old trace he asked about still closes itself")
            elif "rouvrir de soi-même" not in shown.lower():
                failures.append(f"{name}: an old trace does not close itself in the payload")
            if "si le fil s'y prête" in shown or "clin d'œil" in shown:
                failures.append(f"{name}: an old trace still licenses unprompted resumption")
        if shown and not old and ("rouvrir de soi-même" in shown.lower() or "trace locale du" in shown):
            failures.append(f"{name}: a fresh trace is printed as closed or dated")


def main() -> int:
    cfg = config()
    live_cfg = cfg.get("companion_context") or {}
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    status, _, _ = post(opener, "/login", form={"pin": str(cfg.get("pin") or "")})
    token = next((c.value for c in jar if c.name == COOKIE), "")
    if status not in (200, 303) or not token:
        print(f"verify_live_personhood: FAIL login status={status} cookie={bool(token)}")
        return 1
    owner = owner_for_token(token)

    before = freshness(opener)
    if before.get("pending") is not False:
        print(f"verify_live_personhood: FAIL the bridge is stale (pending={before.get('pending')}) "
              f"pid={before.get('pid')} — run Restart-Bridge.ps1")
        return 1

    failures: list[str] = []
    report = {"owner": owner, "pid": before.get("pid"), "started_at": before.get("started_at"),
              "pending_before": before.get("pending"), "config_budget": live_cfg.get("chat_input_budget"),
              "states": {}}
    for name, spec in STATES.items():
        expected = spec["expected"]
        result = capture_state(opener, owner, live_cfg, spec.get("ages", ()), spec.get("corrections", 0),
                               spec.get("correction_age", 600), message=spec.get("message", MESSAGE),
                               visit=spec.get("visit"), feedback=spec.get("feedback", ()),
                               repair=spec.get("repair"), view=spec.get("view"),
                               chapter=spec.get("chapter"))
        check_state(name, expected, result, failures)
        report["states"][name] = {
            "expected": expected,
            "seeded_ages_s": result["ages"],
            "salience": result["salience"],
            "live": {k: result["live"][k] for k in ("budget", "estimate", "totals", "personhood",
                                                    "hint_in_payload", "page_text")},
            "inproc": {k: result["inproc"][k] for k in ("budget", "estimate", "totals", "personhood",
                                                        "hint_in_payload")},
            "read_only": result.get("read_only"),
            "model_calls": result.get("model_calls"),
            "system_bytes": result.get("system_bytes"),
            "matches_inprocess": (result["live"]["rows"] == result["inproc"]["rows"]
                                  and result.get("system_identical")),
            "store_restored": result.get("store_restored"),
            "memory_restored": result.get("memory_restored"),
            "visits_restored": result.get("visits_restored"),
            "seed_age_s": result.get("seed_age_s"),
            "repeats": result["salience"].get("repeats"),
            "line_bytes": len(result.get("line", "").encode("utf-8")),
            "printed_line": result.get("printed_line", ""),
            "repair": result.get("repair"),
            "repair_once": result.get("repair_once"),
            "chapter": result.get("chapter"),
            "chapter_once": result.get("chapter_once"),
            "view": result.get("view"),
            "view_status": result.get("view_status"),
            "view_then_turn": result.get("view_then_turn"),
            "hint_excerpt": result["live"]["hint_text"][:150],
            "preview_status": result.get("preview_status"),
        }

    hot = report["states"]["hot"]["live"]
    cold = report["states"]["cold"]["live"]
    pushed = report["states"]["pushed_back"]["live"]
    if pushed["personhood"]:
        failures.append("a subject corrected twice still has a live personhood row")
    recovered = report["states"]["recovered"]["live"]
    burst = report["states"]["burst"]["live"]
    climbing = report["states"]["climbing"]["live"]
    if not climbing["personhood"]:
        failures.append("a half-answered subject was not offered at all")
    if report["states"]["climbing"]["salience"].get("tier") != "answering":
        failures.append("the climbing state did not report its own rung name")
    if report["states"]["pushed_back"]["salience"].get("tier") != "withheld":
        failures.append("a closed subject did not report the withheld rung")
    deep = report["states"]["deep"]
    if deep["salience"].get("withhold") or deep["salience"].get("pushback") != 4:
        failures.append("a deep half-answered subject was withheld instead of named")
    if deep["live"]["personhood"] and deep["live"]["personhood"][0].get("rung") != "careful":
        failures.append("the deep subject's manifest row did not carry its rung name")
    deep_warm = report["states"]["deep_warm"]["live"]["personhood"]
    deep_hot = report["states"]["deep_hot"]["live"]["personhood"]
    best_cold = report["states"]["cold"]["live"]["personhood"]
    best_warm = report["states"]["warm"]["live"]["personhood"]
    if not (deep_warm and deep_hot and best_cold and best_warm):
        failures.append("a band comparison lost its manifest row")
    else:
        if deep_warm[0]["priority"] <= best_cold[0]["priority"] or \
                deep_warm[0]["share"] <= best_cold[0]["share"]:
            failures.append("the deepest warm rung did not outrank the best cold subject")
        if deep_hot[0]["priority"] <= best_warm[0]["priority"] or \
                deep_hot[0]["share"] <= best_warm[0]["share"]:
            failures.append("the deepest hot rung did not outrank the best warm subject")
    if burst["personhood"] and (climbing["personhood"][0]["priority"]
                                >= burst["personhood"][0]["priority"]):
        failures.append("the climb did not stay below full salience")
    if not burst["personhood"]:
        failures.append("a burst of returns did not bring her line back")
    elif hot["personhood"] and (burst["personhood"][0]["priority"], burst["personhood"][0].get("share"),
                                burst["personhood"][0]["estimated_bytes"]) != (
            hot["personhood"][0]["priority"], hot["personhood"][0].get("share"),
            hot["personhood"][0]["estimated_bytes"]):
        failures.append("the burst state did not match an uncorrected hot subject")
    recall_fresh = report["states"]["visit_fresh"]["live"]["personhood"]
    recall_stale = report["states"]["visit_stale"]["live"]["personhood"]
    if not (recall_fresh and recall_stale):
        failures.append("a recall state lost its manifest row")
    elif (recall_stale[0]["priority"] >= recall_fresh[0]["priority"]
          or recall_stale[0]["share"] >= recall_fresh[0]["share"]):
        failures.append("a stale visit recall did not rank below a fresh one")
    # Both sisters, through the same log and the same bands: one visit is warm,
    # three recent ones are hot, and the words do not move while the rank does.
    for sister, single, repeated in (("Forgia", "visit_fresh", "visit_repeat"),
                                     ("Else", "visit_else_fresh", "visit_else_repeat")):
        one, many = report["states"][single], report["states"][repeated]
        rows_one, rows_many = one["live"]["personhood"], many["live"]["personhood"]
        if not (rows_one and rows_many):
            failures.append(f"a {sister} recall state lost its manifest row")
            continue
        if one["repeats"] != 1:
            failures.append(f"{sister}: a single visit reported repeats {one['repeats']} != 1")
        if many["repeats"] < 2:
            failures.append(f"{sister}: three visits reported repeats {many['repeats']} < 2")
        if rows_many[0]["priority"] != 98 or rows_many[0].get("rung") != "hot":
            failures.append(f"{sister}: a repeatedly visited sister did not reach the hot band")
        if (rows_many[0]["priority"], rows_many[0]["share"]) != (98, 530):
            failures.append(f"{sister}: the repeated recall row is not the hot row")
        if one["printed_line"] != many["printed_line"]:
            failures.append(f"{sister}: repetition changed the recall page's words")
    # One history, one reading: the recall page and the thread line for the same
    # three visits must agree on the count, the tier, the priority and the share —
    # and the thread line must still name her.
    for sister, recall_state, thread_state in (("Forgia", "visit_repeat", "fil_repeat"),
                                               ("Else", "visit_else_repeat", "fil_else_repeat")):
        recall, thread = report["states"][recall_state], report["states"][thread_state]
        if recall["repeats"] != thread["repeats"]:
            failures.append(f"{sister}: recall repeats {recall['repeats']} != thread repeats {thread['repeats']}")
        if thread["repeats"] is None or thread["repeats"] < 3:
            failures.append(f"{sister}: three visits printed as repeats {thread['repeats']} in the thread line")
        reading = lambda state: (state["salience"].get("tier"), state["salience"].get("priority"),
                                 state["salience"].get("share"))
        if reading(recall) != reading(thread):
            failures.append(f"{sister}: recall {reading(recall)} != thread {reading(thread)} for the same visits")
        if f"FIL RÉCENT AVEC {sister}" not in thread["printed_line"]:
            failures.append(f"{sister}: the repeated thread line does not name her")
    # The thread line through her own log, for both sisters: same bands, and the
    # line must name the sister it is actually about.
    for sister, fresh_state, stale_state in (("Forgia", "fil_fresh", "fil_stale"),
                                             ("Else", "fil_else_fresh", "fil_else_stale")):
        fresh, stale = report["states"][fresh_state], report["states"][stale_state]
        if f"FIL RÉCENT AVEC {sister}" not in fresh["printed_line"]:
            failures.append(f"{sister}: the fresh thread line does not name her")
        if f"FIL ANCIEN AVEC {sister}" not in stale["printed_line"]:
            failures.append(f"{sister}: the stale thread line does not name her")
    if hot["estimate"] <= pushed["estimate"]:
        failures.append("the corrected subject did not free the room its line took")
    if not recovered["personhood"]:
        failures.append("his return to the subject did not bring her line back")
    elif recovered["personhood"][0]["priority"] != 98:
        failures.append("the recovered subject did not return to full priority")
    if hot["estimate"] <= pushed["estimate"]:
        failures.append("a withdrawn subject still took her line's bytes")
    if not hot["personhood"] or not cold["personhood"]:
        failures.append("one of the states has no personhood row")
    else:
        if hot["personhood"][0]["priority"] <= cold["personhood"][0]["priority"]:
            failures.append("hot priority is not above cold")
        if (hot["personhood"][0].get("share") or 0) <= (cold["personhood"][0].get("share") or 0):
            failures.append("hot byte share is not above cold")
        if not (cold["personhood"][0]["selected"] and hot["personhood"][0]["selected"]):
            failures.append("a named state was dropped from the packet")

    # Growth over time: the correction is told once, and only when the corrected
    # topic comes back; a store with no superseded answer says nothing.
    repair_state = report["states"].get("repair_asked") or {}
    once = repair_state.get("repair_once") or {}
    if not once.get("first"):
        failures.append("repair: the corrected topic did not yield a repair on a real turn")
    elif once["first"].get("basis") != "repair":
        failures.append("repair: the packet repair is not marked with basis repair")
    if once.get("second"):
        failures.append("repair: the line repeated on a second return")
    if "RÉPARATION" not in (once.get("line") or ""):
        failures.append("repair: the told line does not announce itself")
    if "RÉPARATION" in (once.get("second_line") or ""):
        failures.append("repair: the second return still carries the line")
    absent = report["states"].get("repair_absent") or {}
    if absent.get("repair") or "RÉPARATION" in (absent.get("printed_line") or ""):
        failures.append("repair: a line appeared without a superseded answer")

    after = freshness(opener)
    report["pending_after"] = after.get("pending")
    if after.get("pending") is not False:
        failures.append("the bridge went stale during the run")

    post(opener, "/logout", form={})
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    if failures:
        print("verify_live_personhood: FAIL")
        for item in failures:
            print("  -", item)
        return 1
    print("verify_live_personhood: OK (hot, warm, stale, cold_unasked, corrected, recovered, burst, climbing, repair_asked, repair_absent, repair_view, repair_pruned, repair_undated, chapter_closed, deep, "
          "deep_warm, deep_hot, fil_fresh, fil_stale, fil_repeat, fil_else_fresh, fil_else_stale, "
          "fil_else_repeat, point_fresh, point_stale, visit_fresh, visit_stale, visit_repeat, "
          "visit_else_fresh, visit_else_stale and visit_else_repeat states)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
