"""Named parameters for Dessiner v6 documents.

The editor already evaluated parameters and driven feature values in JavaScript. The server did not,
so a document whose ``params`` changed could be validated and rebuilt with the old numeric feature
values. This module makes the document self-describing on the server too: every build validates and
resolves the same arithmetic expressions, so changing ``thickness = 6`` to ``thickness = 8`` and
validating the document rebuilds it at 8 mm.

Supported language (deliberately the same small one as assets/hq-sketch-core.js):
numbers, parameter names, + - * / ^, parentheses, commas, ``pi`` and the functions abs, floor, ceil,
sqrt, min, max, round, sin, cos, tan. Angles are degrees. A decimal comma between digits is accepted.
"""
from __future__ import annotations

import copy
import math
import re
from typing import Any

MAX_PARAMS = 40
MAX_EXPR = 120
MAX_VALUE = 1e6
DRIVABLE = ("depth", "thickness", "radius", "distance", "angle", "dx", "dy", "cx", "cy")
PARAM_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,30}\Z")
PARAM_RESERVED = {"__proto__", "constructor", "prototype"}
_NUM_RE = re.compile(r"^[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?")
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*")


class ParamError(ValueError):
    """A parameter or driven expression that cannot be evaluated."""


def _tokenize(src: str) -> list[tuple[str, Any]]:
    text = str(src or "").replace("\u00a0", " ")
    text = re.sub(r"(\d),(\d)", r"\1.\2", text)
    out: list[tuple[str, Any]] = []
    i = 0
    while i < len(text):
        c = text[i]
        if c in " \t\r\n":
            i += 1
            continue
        if c.isdigit() or c == ".":
            m = _NUM_RE.match(text[i:])
            if not m:
                raise ParamError("Nombre invalide")
            out.append(("num", float(m.group(0))))
            i += len(m.group(0))
            continue
        if c.isalpha() or c == "_":
            m = _NAME_RE.match(text[i:])
            assert m
            out.append(("name", m.group(0)))
            i += len(m.group(0))
            continue
        if c in "+-*/^(),":
            out.append((c, c))
            i += 1
            continue
        raise ParamError("Caractère invalide : " + c)
    return out


_FUNCS = {
    "abs": abs,
    "floor": math.floor,
    "ceil": math.ceil,
    "sqrt": math.sqrt,
    "min": min,
    "max": max,
    "round": lambda v, n=0: round(v, int(n)),
    "sin": lambda d: math.sin(math.radians(d)),
    "cos": lambda d: math.cos(math.radians(d)),
    "tan": lambda d: math.tan(math.radians(d)),
}
_CONSTS = {"pi": math.pi}


def evaluate(src: str, scope: dict[str, float] | None = None) -> float:
    """Evaluate one expression. Unknown names are reported, never treated as zero."""
    toks = _tokenize(src)
    if not toks:
        raise ParamError("Expression vide")
    pos = 0

    def peek():
        return toks[pos] if pos < len(toks) else None

    def eat(kind: str):
        nonlocal pos
        tok = peek()
        if tok is None or tok[0] != kind:
            raise ParamError("Expression invalide")
        pos += 1
        return tok

    def expr():
        nonlocal pos
        value = term()
        while peek() and peek()[0] in ("+", "-"):
            op = toks[pos][0]
            pos += 1
            right = term()
            value = value + right if op == "+" else value - right
        return value

    def term():
        nonlocal pos
        value = power()
        while peek() and peek()[0] in ("*", "/"):
            op = toks[pos][0]
            pos += 1
            right = power()
            if op == "/" and abs(right) < 1e-12:
                raise ParamError("Division par zéro")
            value = value * right if op == "*" else value / right
        return value

    def power():
        nonlocal pos
        value = unary()
        if peek() and peek()[0] == "^":
            pos += 1
            return math.pow(value, power())
        return value

    def unary():
        nonlocal pos
        tok = peek()
        if tok and tok[0] == "-":
            pos += 1
            return -unary()
        if tok and tok[0] == "+":
            pos += 1
            return unary()
        return primary()

    def primary():
        nonlocal pos
        tok = peek()
        if tok is None:
            raise ParamError("Expression incomplète")
        kind, val = tok
        if kind == "num":
            pos += 1
            return float(val)
        if kind == "(":
            pos += 1
            value = expr()
            eat(")")
            return value
        if kind == "name":
            pos += 1
            name = str(val)
            if peek() and peek()[0] == "(":
                pos += 1
                args = []
                if peek() and peek()[0] != ")":
                    args.append(expr())
                    while peek() and peek()[0] == ",":
                        pos += 1
                        args.append(expr())
                eat(")")
                fn = _FUNCS.get(name)
                if fn is None:
                    raise ParamError("Fonction inconnue : " + name)
                try:
                    return float(fn(*args))
                except (TypeError, ValueError, ZeroDivisionError) as exc:
                    raise ParamError("Expression invalide : " + name) from exc
            if name in _CONSTS:
                return _CONSTS[name]
            if scope and name in scope:
                return float(scope[name])
            raise ParamError("Nom inconnu : " + name)
        raise ParamError("Expression invalide")

    value = expr()
    if peek() is not None:
        raise ParamError("Expression invalide")
    if not math.isfinite(value):
        raise ParamError("Résultat infini")
    if abs(value) > MAX_VALUE:
        raise ParamError("Résultat hors limites")
    return round(value, 6)


def parameter_values(doc: dict) -> dict[str, float]:
    """Evaluate every parameter in dependency order."""
    params = doc.get("params") or []
    if not isinstance(params, list) or len(params) > MAX_PARAMS:
        raise ParamError("Paramètres invalides")
    pending: dict[str, str] = {}
    for i, item in enumerate(params):
        if not isinstance(item, dict):
            raise ParamError(f"Paramètre {i} invalide")
        name, expr = item.get("name"), item.get("expr")
        if not isinstance(name, str) or not PARAM_RE.match(name) or name in PARAM_RESERVED:
            raise ParamError(f"Paramètre {i} : nom invalide")
        if name in pending:
            raise ParamError("Paramètre en double : " + name)
        if not isinstance(expr, str) or not expr.strip() or len(expr) > MAX_EXPR:
            raise ParamError(f"Paramètre {name} : expression invalide")
        pending[name] = expr.strip()
    values: dict[str, float] = {}
    for _ in range(len(pending) + 2):
        progressed = False
        for name, expr in list(pending.items()):
            try:
                values[name] = evaluate(expr, values)
            except ParamError as exc:
                if str(exc).startswith("Nom inconnu :") and ":" in str(exc):
                    continue
                raise ParamError(f"Paramètre {name} : {exc}") from exc
            pending.pop(name)
            progressed = True
        if not pending:
            break
        if not progressed:
            names = ", ".join(pending)
            raise ParamError("Dépendance circulaire ou inconnue : " + names)
    return values


def _clamp(field: str, value: float) -> float:
    if field == "angle":
        return max(1.0, min(360.0, value))
    if field == "depth":
        return max(0.0, value)
    if field in ("thickness", "radius", "distance"):
        return max(1e-6, value)
    return value


def resolve(doc: Any, overrides: dict[str, str] | None = None) -> dict:
    """Return a copy of a v6 document with ``params`` applied to every driven feature value.

    Structural validation still belongs to ``hq_drawings.validate_document``; this function only
    resolves the arithmetic, and raises :class:`ParamError` on an expression it cannot evaluate.
    """
    if not isinstance(doc, dict):
        raise ParamError("Document invalide")
    out = copy.deepcopy(doc)
    if int(doc.get("version") or 0) < 6:
        if overrides:
            raise ParamError("Les paramètres exigent la version 6")
        return out
    if overrides:
        if not isinstance(overrides, dict):
            raise ParamError("Paramètres invalides")
        params = out.setdefault("params", [])
        if not isinstance(params, list):
            raise ParamError("Paramètres invalides")
        by_name = {p.get("name"): p for p in params if isinstance(p, dict)}
        for name, expr in overrides.items():
            if name not in by_name:
                raise ParamError("Paramètre introuvable : " + str(name))
            if not isinstance(expr, str) or not expr.strip() or len(expr) > MAX_EXPR:
                raise ParamError(f"Paramètre {name} : expression invalide")
            by_name[name]["expr"] = expr.strip()
    values = parameter_values(out)
    features = out.get("features") or []
    if not isinstance(features, list):
        raise ParamError("Fonctions 3D invalides")
    for feature in features:
        if not isinstance(feature, dict):
            continue
        driven = feature.get("driven")
        if not driven:
            continue
        if not isinstance(driven, dict):
            raise ParamError("Valeur pilotée invalide")
        for field, expr in driven.items():
            if field not in DRIVABLE:
                raise ParamError("Valeur pilotée invalide : " + str(field))
            if not isinstance(expr, str):
                raise ParamError("Valeur pilotée invalide")
            try:
                feature[field] = _clamp(field, evaluate(expr, values))
            except ParamError as exc:
                raise ParamError(f"{feature.get('id') or 'fonction'} {field} : {exc}") from exc
    return out
