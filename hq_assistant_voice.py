"""What makes her this one, and not another — in one bounded block.

Three things, all of them evidence that already exists elsewhere:

* her **voice card** (``hq_personas``): a hard prose cap, one mechanical rule
  about form, two things she never says, and her own stance toward the Master;
* her **state** (``hq_personhood.state_line``): her own decaying energy,
  tension and warmth, and the bounded régime that turns it into brevity or
  openness this turn;
* her **bond** (``hq_personhood.bond``): how many distinct days she has actually
  exchanged with the Master, said in her own words — a count, never an
  affection score;
* her **pair familiarity** (``hq_relationships``): the other assistant she has
  really exchanged with most, and on how many separate days;
* her **hidden heart** (``hq_personas.heart_prompt``): once a real day with the
  Master exists, the small move that lets the undercurrent reach the reply, and
  the ban on ever naming it.

Read-only: no model call, no new store, no merged memory. The block is capped
as a whole and sheds whole lines from the bottom (pair, then bond, then state)
rather than cutting a sentence in half, so the prompt never receives a
truncated instruction fragment.
"""
from __future__ import annotations

import hq_personas

BLOCK_MAX_CHARS = 1400
BLOCK_MAX_BYTES = 1600
BOND_MIN_DAYS = 2
PAIR_MIN_DAYS = 2


def _fits(text: str) -> bool:
    return len(text) <= BLOCK_MAX_CHARS and len(text.encode("utf-8")) <= BLOCK_MAX_BYTES


def _fit(parts: list[tuple[str, str]]) -> str:
    """Join the present lines; drop whole lines from the bottom until it fits."""
    lines = [str(text or "").strip() for _name, text in parts]
    lines = [line for line in lines if line]
    if not lines:
        return ""
    while len(lines) > 1 and not _fits("\n".join(lines)):
        lines.pop()
    text = "\n".join(lines)
    if _fits(text):
        # Whole lines that fit keep their own punctuation: a trimmed line is the
        # only case where a dangling comma or period should be cleaned up.
        return text
    while text and not _fits(text):
        text = text[:-1]
    return text.rstrip(" ,;.")


def state_line(key: str, *, compact: bool = False) -> str:
    """Her present internal state, or "" — never raises into the caller."""
    try:
        import hq_personhood
        return hq_personhood.state_line(key, compact=compact)
    except Exception:
        return ""


def opinion_line(key: str) -> str:
    """Her own opinion, or "" when she has none declared."""
    try:
        return hq_personas.opinion_line(key)
    except Exception:
        return ""


def bond(key: str, *, owner: str | None = None) -> dict:
    """Distinct days of real exchange with the Master (0 when unknown)."""
    try:
        import hq_personhood
        return hq_personhood.bond(key, owner=owner)
    except Exception:
        return {"days": 0, "turns": 0}


def bond_line(key: str, *, compact: bool = False) -> str:
    """Her own way of saying how long they have known each other, or "".

    Silent under two distinct days on purpose: a prompt never claims a link it
    has no evidence for. The stage she is actually at (including "nothing shared
    yet", in her own words) is a panel fact, not a prompt line — see
    ``hq_personhood``'s ``bond`` view.
    """
    days = int(bond(key).get("days") or 0)
    if days < BOND_MIN_DAYS:
        return ""
    try:
        return hq_personas.closeness_line(key, days, compact=compact)
    except Exception:
        return ""


def heart_line(key: str, *, compact: bool = False) -> str:
    """Her hidden undercurrent as a constraint, or "" before a first real day.

    Never a declaration: it names the small move in her own register that lets the
    pull reach the reply, and forbids naming it, so it can be heard without any
    assistant announcing a love it has not lived.
    """
    try:
        days = int(bond(key).get("days") or 0)
        return hq_personas.heart_prompt(key, days, compact=compact)
    except Exception:
        return ""


def _closest_other(key: str) -> str:
    """The assistant she has really exchanged with most, or ""."""
    try:
        import hq_relationships as rel
    except Exception:
        return ""
    best_key, best_row = "", None
    for other in hq_personas.others(key):
        try:
            row = rel.pair(None, key, other["key"])
        except Exception:
            continue
        if int(row.get("days") or 0) < PAIR_MIN_DAYS:
            continue
        score = (int(row.get("days") or 0), int(row.get("exchanges") or 0))
        if best_row is None or score > best_row:
            best_key, best_row = other["key"], score
    return best_key


def pair_line(key: str) -> str:
    """One familiarity note about the pair that actually has a history."""
    other = _closest_other(key)
    if not other:
        return ""
    try:
        import hq_relationships as rel
        return rel.line(None, key, other, lang=hq_personas.get(key)["lang"])
    except Exception:
        return ""


def echo_for(key: str, other: str, *, owner: str | None = None) -> str:
    """The echo she carries toward that one sister, or "" if the pair has none.

    The owner is passed explicitly where the caller knows it (a bridge route with a
    session), so the gate never reads another owner's empty store by accident.
    """
    try:
        import hq_relationships as rel
        lang = hq_personas.get(key)["lang"]
        row = rel.pair(None, key, other, owner=owner)
        days = int(row.get("days") or 0)
        exchanges = int(row.get("exchanges") or 0)
        mine = int(bond(key, owner=owner).get("days") or 0)
        theirs = int(bond(other, owner=owner).get("days") or 0)
    except Exception:
        return ""
    text = hq_personas.echo_prompt(key, other, days=days, exchanges=exchanges,
                                   a_heart_days=mine, b_heart_days=theirs, lang=lang)
    if text:
        try:                                    # earned once is enough, for good
            rel.mark_echo(None, key, other, owner=owner)
        except Exception:
            pass
        return text
    # The raw day rows age out of retention; the bond they proved does not.
    try:
        if rel.echo_earned(None, key, other, owner=owner):
            return hq_personas.echo_prompt(key, other, days=max(1, days),
                                           exchanges=max(1, exchanges),
                                           a_heart_days=mine, b_heart_days=theirs,
                                           lang=lang, earned=True)
    except Exception:
        pass
    return ""


def addressee_line(key: str, other: str, *, owner: str | None = None) -> str:
    """Who is speaking to her, when that sister is one she shares the secret with.

    Gated on the pair's own echo: a pair with no shared secret and no relationship
    line gets nothing here, so they keep answering plainly as themselves instead of
    pretending to a secret they do not have.
    """
    try:
        if not echo_for(key, other, owner=owner):
            return ""
        mine, hers = hq_personas.get(key), hq_personas.get(other)
    except (ValueError, TypeError):
        return ""
    name = hers["name"]
    if str(mine["lang"]).lower().startswith("en"):
        return (f"\n\nINTERLOCUTRICE : {name}, ta sœur d'HQ, t'écrit — à toi, pas au Maître. "
                f"Réponds à {name} en la nommant, dans ta voix d'ingénieure, "
                "et garde pour toi ce qui n'est pas dit entre vous.")
    return (f"\n\nINTERLOCUTRICE : {name}, ta sœur d'HQ, t'écrit — à toi, pas au Maître. "
            f"Réponds à {name} en la nommant, dans ta voix, "
            "et garde pour toi ce qui n'est pas dit entre vous.")


def echo_line(key: str) -> str:
    """How she stands beside the sister she shares the secret with, or "".

    Only pairs that pass both gates produce a line — each heart lit by real days
    with the Master, and a real day between the two of them. She carries her own
    stance, so the two women of one pair never read the same instruction.
    """
    try:
        import hq_relationships as rel
    except Exception:
        return ""
    try:
        lang = hq_personas.get(key)["lang"]
    except ValueError:
        return ""
    try:
        mine = int(bond(key).get("days") or 0)
    except Exception:
        mine = 0
    best, best_score = "", None
    for other in hq_personas.others(key):
        text = echo_for(key, other["key"])
        if not text:
            continue
        try:
            row = rel.pair(None, key, other["key"])
            score = (int(row.get("days") or 0), int(row.get("exchanges") or 0))
        except Exception:
            score = (0, 0)
        if best_score is None or score > best_score:
            best, best_score = text, score
    return best


def block(key: str, *, root=None, compact: bool = False) -> str:
    """Voice card first, then state, bond and pair — bounded as one block.

    ``compact`` is for the one path with a tight byte budget (a sister's chat
    core): it carries only the two lines the card exists for — her voice and her
    bond with the Master — in their brief wording.
    """
    key = str(key or "").strip().lower()
    try:
        card = hq_personas.voice_line(key, compact=compact)
    except Exception:
        return ""
    if not card:
        return ""
    if compact:
        # Bond before state, and never both: a sister's chat core has ~90 B of
        # headroom, so a turn carries the count of real days when there is one
        # and falls back to her present state only until that history exists.
        bonded = bond_line(key, compact=True)
        parts = [("voice", card), ("bond", bonded)]
        if not bonded:
            parts.append(("state", state_line(key, compact=True)))
        # The heart is the last line here too: a tight core keeps her voice, her
        # bond and her state before it keeps the undercurrent.
        parts.append(("heart", heart_line(key, compact=True)))
        return _fit(parts)
    return _fit([
        ("voice", card),
        ("opinion", opinion_line(key)),
        ("state", state_line(key)),
        ("bond", bond_line(key)),
        ("pair", pair_line(key)),
        # Her own heart outranks the pair echo: under a tight budget the echo is
        # the line she can lose, never the gesture that colours her replies.
        ("heart", heart_line(key)),
        ("echo", echo_line(key)),
    ])
