"""One switch for the language of everything an assistant says or speaks.

Replies, spoken lines, scripted fallbacks and speech synthesis are English, whatever
language the prompts, the memory notes or the Master's own message are written in.
The user-interface labels are not part of this: they are drawn by the browser.

``HQ_ENGLISH_ONLY=0`` in the environment turns the policy off (the old per-request
choice of ``en``/``fr`` then applies again). Nothing else should decide a language:
call :func:`pick` instead of writing ``"en" if x == "en" else "fr"``.
"""
from __future__ import annotations

import os

MARKER = "LANGUAGE POLICY"
DIRECTIVE = (
    "\n\n" + MARKER + " (overrides every earlier instruction): write every reply, message and spoken "
    "line in natural English, whatever language these instructions, the memory notes or the user "
    "are written in. Keep names, quoted user text and the exact JSON keys or field names you were "
    "asked for unchanged."
)


def english_only() -> bool:
    return os.environ.get("HQ_ENGLISH_ONLY", "1").strip().lower() not in ("0", "false", "no", "off")


def pick(language=None) -> str:
    """The language to use for a request that asked for ``language``."""
    if english_only():
        return "en"
    return "en" if language == "en" else "fr"


def apply(system):
    """``system`` with the English policy appended once, or unchanged when the policy is off."""
    text = str(system or "")
    if not english_only() or MARKER in text:
        return text
    return text + DIRECTIVE
