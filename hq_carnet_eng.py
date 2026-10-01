"""Carnet Stage 07 — engineering blocks (declarative payloads, pure, no I/O).

Three block kinds extend the structured V2 content model (same pattern as the Stage-06 ``image`` atom):

``calc``      an ATOM (text "", no marks). Payload ``{expr, result, unit, at, v}``: the typed arithmetic expression, the
              result that was displayed, an optional unit label, the creation time (epoch seconds) and the grammar
              version ``v`` the result was computed under. Declarative only: the server NEVER evaluates ``expr``; a
              stored result is never recomputed silently (recalculation is an explicit, visible user action).
``measure``   an ATOM. Payload ``{label, observed, mode, nominal, tol, at, link}``. The tolerance ``mode`` is explicit
              (``none`` | ``sym`` | ``bounds`` | ``pct``): nothing is guessed. Deviation and in/out are DERIVED at
              render time by :func:`evaluate` (exact decimal arithmetic, inclusive bounds) and never stored. A
              convenience notebook aid, NOT certified metrology.
``decision``  a text line (text + marks behave like any other line). Payload ``{at}``; rendered ``DÉCISION · time``.

Every persisted number that matters is a canonical DECIMAL STRING (never a float), so Python and the browser
(assets/hq-carnet-eng.js) accept and reject exactly the same payloads; the shared vectors live in
tests/fixtures_carnet_eng.json. Unknown keys are refused, ``bool`` is never an ``int``, and every string is bounded
in UTF-16 code units with no control character and no unpaired surrogate.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Callable

ENG_TYPES = ("calc", "measure", "decision")
ATOM_TYPES = ("calc", "measure")  # no text, no marks, no caret inside

CALC_VERSION = 1
UNITS = ("mm", "in", "N", "lbf", "N·m", "lb·ft", "bar", "psi", "°C", "°F", "kg", "lb")
MODES = ("none", "sym", "bounds", "pct")
LINK_KINDS = ("source", "media", "drawing", "file")

EXPR_MAX = 200
RESULT_MAX = 40
LABEL_MAX = 80
DIGITS_MAX = 15  # digit characters of a stored decimal (integer + fraction)
DEC_LEN_MAX = 18
PCT_MAX = 100
AT_MIN = 946684800  # 2000-01-01T00:00:00Z
AT_MAX = 4102444800  # 2100-01-01T00:00:00Z

_CTRL_RE = re.compile("[\x00-\x1f\x7f-\x9f\u2028\u2029]")  # one line: no C0/DEL/C1, no U+2028/U+2029
_BLANK_RE = re.compile("^[ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]*\\Z")  # explicit set, same as the browser (never the language default)
_DEC_RE = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?\Z")
_RESULT_RE = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?(e[+-][0-9]{1,3})?\Z")
_EXPR_RE = re.compile(r"^[0-9+\-*/^().eE ]+\Z")  # the calculator grammar's whole alphabet (ASCII only)
_SRC_RE = re.compile(r"^srce-[A-Za-z0-9_-]{1,64}\Z")

CALC_KEYS = {"expr", "result", "unit", "at", "v"}
MEASURE_KEYS = {"label", "observed", "mode", "nominal", "tol", "at", "link"}


class EngError(ValueError):
    """Invalid engineering payload (the caller maps it to its own validation error)."""


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def u16_len(text: str) -> int:
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text)


def _line(value: Any, lo: int, hi: int, message: str) -> str:
    if not isinstance(value, str) or _CTRL_RE.search(value) or not lo <= u16_len(value) <= hi:
        raise EngError(message)
    try:
        value.encode("utf-8")  # an unpaired surrogate cannot be encoded
    except UnicodeEncodeError as e:
        raise EngError(message) from e
    return value


def _label(value: Any, message: str) -> str:
    text = _line(value, 1, LABEL_MAX, message)
    if _BLANK_RE.match(text):
        raise EngError(message)  # a label of only blanks is not a label
    return text


def _at(value: Any, message: str) -> int:
    if not _is_int(value) or not AT_MIN <= value <= AT_MAX:
        raise EngError(message)
    return value


def _neg_zero(text: str) -> bool:
    mantissa = text.split("e")[0]
    return mantissa.startswith("-") and not mantissa.strip("-0.")


def check_decimal(value: Any, message: str = "Nombre invalide") -> str:
    """Canonical plain decimal: ``-?int(.frac)?``, at most 15 digits, no exponent, no ``+``, no ``-0``."""
    if not isinstance(value, str) or len(value) > DEC_LEN_MAX or not _DEC_RE.match(value):
        raise EngError(message)
    if sum(ch.isdigit() for ch in value) > DIGITS_MAX or _neg_zero(value):
        raise EngError(message)
    return value


def check_unit(value: Any, *, allow_empty: bool, message: str) -> str:
    if not isinstance(value, str) or not (value in UNITS or (allow_empty and value == "")):
        raise EngError(message)
    return value


# ------------------------------------------------------------------ calc


def check_calc(payload: Any) -> dict:
    msg = "Calcul invalide"
    if not isinstance(payload, dict) or set(payload) != CALC_KEYS:
        raise EngError(msg)
    expr = _line(payload["expr"], 1, EXPR_MAX, msg)
    if not _EXPR_RE.match(expr):
        raise EngError(msg)
    result = payload["result"]
    if not isinstance(result, str) or len(result) > RESULT_MAX or not _RESULT_RE.match(result) or _neg_zero(result):
        raise EngError(msg)
    unit = payload["unit"]
    if unit is not None:
        check_unit(unit, allow_empty=False, message=msg)
    if not _is_int(payload["v"]) or payload["v"] != CALC_VERSION:
        raise EngError(msg)
    return {"expr": expr, "result": result, "unit": unit, "at": _at(payload["at"], msg), "v": CALC_VERSION}


# ------------------------------------------------------------------ measure


def _quantity(value: Any, msg: str) -> dict:
    if not isinstance(value, dict) or set(value) != {"v", "u"}:
        raise EngError(msg)
    return {"v": check_decimal(value["v"], msg), "u": check_unit(value["u"], allow_empty=True, message=msg)}


def _tol(mode: str, tol: Any, msg: str) -> dict | None:
    if mode == "none":
        if tol is not None:
            raise EngError(msg)
        return None
    if not isinstance(tol, dict):
        raise EngError(msg)
    if mode == "sym":
        if set(tol) != {"t", "u"}:
            raise EngError(msg)
        t = check_decimal(tol["t"], msg)
        if t.startswith("-"):
            raise EngError(msg)
        return {"t": t, "u": check_unit(tol["u"], allow_empty=True, message=msg)}
    if mode == "bounds":
        if set(tol) != {"lo", "hi", "u"}:
            raise EngError(msg)
        lo, hi = check_decimal(tol["lo"], msg), check_decimal(tol["hi"], msg)
        if _cmp(_dec(lo), _dec(hi)) > 0:
            raise EngError(msg)
        return {"lo": lo, "hi": hi, "u": check_unit(tol["u"], allow_empty=True, message=msg)}
    if set(tol) != {"p"}:  # pct
        raise EngError(msg)
    p = check_decimal(tol["p"], msg)
    if p.startswith("-") or _cmp(_dec(p), (PCT_MAX, 0)) > 0:
        raise EngError(msg)
    return {"p": p}


def check_measure(payload: Any, link_check: Callable[[Any], Any] | None = None) -> dict:
    """Validate a measurement payload. ``link_check`` validates the optional link (it owns the path rules)."""
    msg = "Mesure invalide"
    if not isinstance(payload, dict) or set(payload) != MEASURE_KEYS:
        raise EngError(msg)
    mode = payload["mode"]
    if not isinstance(mode, str) or mode not in MODES:
        raise EngError(msg)
    nominal = payload["nominal"]
    nominal = None if nominal is None else _quantity(nominal, msg)
    if mode in ("sym", "pct") and nominal is None:
        raise EngError(msg)  # a nominal-relative tolerance without a nominal has no meaning
    link = payload["link"]
    if link is not None:
        link = link_check(link) if link_check is not None else _check_link_shape(link, msg)
    return {
        "label": _label(payload["label"], msg),
        "observed": _quantity(payload["observed"], msg),
        "mode": mode,
        "nominal": nominal,
        "tol": _tol(mode, payload["tol"], msg),
        "at": _at(payload["at"], msg),
        "link": link,
    }


def _check_link_shape(link: Any, msg: str) -> dict:
    if not isinstance(link, dict) or set(link) != {"kind", "id"} or link["kind"] not in LINK_KINDS or not isinstance(link["id"], str):
        raise EngError(msg)
    if link["kind"] == "source" and not _SRC_RE.match(link["id"]):
        raise EngError(msg)
    return {"kind": link["kind"], "id": link["id"]}


def check_source_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_SRC_RE.match(value))


# ------------------------------------------------------------------ decision


def check_decision(payload: Any) -> dict:
    msg = "Décision invalide"
    if not isinstance(payload, dict) or set(payload) != {"at"}:
        raise EngError(msg)
    return {"at": _at(payload["at"], msg)}


def check_payload(kind: str, payload: Any, link_check: Callable[[Any], Any] | None = None) -> dict:
    if kind == "calc":
        return check_calc(payload)
    if kind == "measure":
        return check_measure(payload, link_check)
    if kind == "decision":
        return check_decision(payload)
    raise EngError("Bloc invalide")


# ------------------------------------------------------------------ exact decimal arithmetic
# (unscaled integer, scale): value = n / 10**scale. Used only for the measurement verdict.


def _dec(text: str) -> tuple[int, int]:
    neg = text.startswith("-")
    body = text[1:] if neg else text
    whole, _, frac = body.partition(".")
    n = int(whole + frac)
    return (-n if neg else n), len(frac)


def _align(a: tuple[int, int], b: tuple[int, int]) -> tuple[int, int, int]:
    scale = max(a[1], b[1])
    return a[0] * 10 ** (scale - a[1]), b[0] * 10 ** (scale - b[1]), scale


def _cmp(a: tuple[int, int], b: tuple[int, int]) -> int:
    x, y, _ = _align(a, b)
    return (x > y) - (x < y)


def _add(a: tuple[int, int], b: tuple[int, int]) -> tuple[int, int]:
    x, y, s = _align(a, b)
    return x + y, s


def _neg(a: tuple[int, int]) -> tuple[int, int]:
    return -a[0], a[1]


def _fmt(a: tuple[int, int]) -> str:
    n, scale = a
    sign = "-" if n < 0 else ""
    digits = str(abs(n)).rjust(scale + 1, "0")
    whole, frac = (digits[:-scale], digits[-scale:]) if scale else (digits, "")
    frac = frac.rstrip("0")
    text = whole + ("." + frac if frac else "")
    return "0" if text == "0" else sign + text


def evaluate(measure: dict) -> dict:
    """Derived verdict of a (valid) measure payload: ``{deviation, lo, hi, status}``.

    status: ``none`` (no tolerance) | ``in`` | ``out`` (inclusive bounds) | ``incompatible`` (units differ: nothing
    is compared, nothing is converted). ``deviation`` is ``observed - nominal`` when a nominal exists in the same unit.
    """
    obs = measure["observed"]
    nom = measure["nominal"]
    mode = measure["mode"]
    tol = measure["tol"]
    value = _dec(obs["v"])
    deviation = None
    if nom is not None and nom["u"] == obs["u"]:
        deviation = _fmt(_add(value, _neg(_dec(nom["v"]))))
    out = {"deviation": deviation, "lo": None, "hi": None, "status": "none"}
    if mode == "none":
        return out
    if mode == "bounds":
        if tol["u"] != obs["u"]:
            out["status"] = "incompatible"
            return out
        lo, hi = _dec(tol["lo"]), _dec(tol["hi"])
    else:
        if nom["u"] != obs["u"] or (mode == "sym" and tol["u"] != obs["u"]):
            out["status"] = "incompatible"
            return out
        centre = _dec(nom["v"])
        if mode == "sym":
            half = _dec(tol["t"])
        else:
            p = _dec(tol["p"])
            half = (abs(centre[0]) * p[0], centre[1] + p[1] + 2)
        lo, hi = _add(centre, _neg(half)), _add(centre, half)
    out["lo"], out["hi"] = _fmt(lo), _fmt(hi)
    out["status"] = "in" if _cmp(lo, value) <= 0 and _cmp(value, hi) <= 0 else "out"
    return out


# ------------------------------------------------------------------ readable representation (TXT / Markdown)
# Deterministic and timezone-free (UTC) so that Python and the browser print byte-identical text.

STATUS_TEXT = {
    "in": "dans la tolérance",
    "out": "hors tolérance",
    "incompatible": "unités incompatibles (comparaison non faite)",
}
DISCLAIMER = "aide de carnet, non certifié"


def fmt_time(at: int) -> str:
    return datetime.fromtimestamp(at, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _with_unit(value: str, unit: str | None) -> str:
    return value + (" " + unit if unit else "")


def describe_calc(p: dict) -> str:
    return f"Calcul : {p['expr']} = {_with_unit(p['result'], p['unit'])} — {fmt_time(p['at'])}"


def describe_measure(p: dict) -> str:
    verdict = evaluate(p)
    obs = p["observed"]
    parts = [f"Mesure : {p['label']} — observé {_with_unit(obs['v'], obs['u'])}"]
    nom = p["nominal"]
    if nom is not None:
        parts.append("nominal " + _with_unit(nom["v"], nom["u"]))
    tol = p["tol"]
    if p["mode"] == "sym":
        parts.append("±" + _with_unit(tol["t"], tol["u"]))
    elif p["mode"] == "pct":
        parts.append("±" + tol["p"] + " %")
    elif p["mode"] == "bounds":
        parts.append("limites " + tol["lo"] + " … " + _with_unit(tol["hi"], tol["u"]))
    if verdict["deviation"] is not None:
        dev = verdict["deviation"]
        parts.append("écart " + _with_unit(("+" + dev) if dev != "0" and not dev.startswith("-") else dev, obs["u"]))
    if verdict["status"] in STATUS_TEXT:
        parts.append(STATUS_TEXT[verdict["status"]])
    return parts[0] + (" ; " + " ; ".join(parts[1:]) if len(parts) > 1 else "") + f" — {DISCLAIMER} — {fmt_time(p['at'])}"


def decision_label(p: dict) -> str:
    return f"DÉCISION · {fmt_time(p['at'])}"
