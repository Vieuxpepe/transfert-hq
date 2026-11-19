"""Intent-first modelling for Dessiner, built on the existing v6/OpenCascade pipeline.

A described plate, L-bracket or plate with cylindrical bosses becomes an ordinary, editable v6 document:

* named parameters (``width``, ``depth``, ``height`` for an L-bracket, ``thickness``, ``hole_inset``,
  ``fillet_radius``, and ``boss_inset`` / ``boss_diameter`` / ``boss_height`` when bosses are present);
* real constraints on the profile;
* a real feature history (base extrusion, optional vertical leg and boss extrusions, then a standard hole feature);
* visible named assumptions for every value the intent did not supply;
* an exact OpenCascade solid before the document is returned.

The plate profile is a rounded rectangle made of lines and arcs. An L-bracket adds a second rectangle on
the XZ plane; bosses are separate circles on a sketch offset by the plate thickness. Every value stays in
the sketch/parameter history, so thickness, height, boss and hole edits flow through the normal driven-feature
rebuild without stale picked edges.

Command line::

    python hq_intent.py "plate 100x60x6, four M6 holes 10mm from the edges, 3mm fillets" --out artifacts/plate
    python hq_intent.py "L bracket 80x60x6" --out artifacts/bracket
    python hq_intent.py "plate 100x60x6, four cylindrical bosses 10mm diameter 5mm high" --out artifacts/bosses
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import hq_dfm
import hq_drawings
import hq_inventory
import hq_params
import hq_print3d_filament
import hq_projects
import hq_solid
import hq_solid_occ
import hq_solid_ops
import hq_state

FORMAT = "transfert-hq-sketch"
MAX_DIM = 100000.0
COUNT_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
               "un": 1, "deux": 2, "trois": 3, "quatre": 4, "cinq": 5, "six": 6, "huit": 8}
MATERIALS = ("PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC")


class IntentError(ValueError):
    """The intent cannot be represented by this builder without guessing silently."""


class ManufacturingError(IntentError):
    """The exact part was built, but a required manufacturing check failed."""

    def __init__(self, message: str, report: dict | None = None):
        super().__init__(message)
        self.report = report or {}


# ---------------------------------------------------------------- parsing
def _number(value: Any, field: str, *, lo: float = 1e-9, hi: float = MAX_DIM) -> float:
    if isinstance(value, bool):
        raise IntentError(f"{field} invalide")
    if isinstance(value, str):
        text = value.strip().replace(",", ".")
        try:
            value = float(text)
        except ValueError as exc:
            raise IntentError(f"{field} invalide") from exc
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise IntentError(f"{field} invalide")
    value = float(value)
    if value < lo or value > hi:
        raise IntentError(f"{field} hors limites")
    return round(value, 6)


def _text(value: Any, field: str, cap: int = 120) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > cap:
        raise IntentError(f"{field} invalide")
    return re.sub(r"\s{2,}", " ", value.strip())


def _normal_material(value: Any) -> str:
    text = _text(value, "Matière", 16).upper()
    base = hq_print3d_filament.base_material(text)
    if base not in MATERIALS:
        raise IntentError("Matière non prise en charge : " + text)
    return base


def _normal_orientation(value: Any) -> str:
    text = str(value or "").strip().upper()
    if text in ("Z", "X", "Y"):
        return text
    if text in ("Z UP", "Z-UP", "SUR PLAT", "FLAT", "À PLAT", "A PLAT"):
        return "Z"
    raise IntentError("Orientation d'impression invalide (Z, X ou Y)")


def _standard(value: Any) -> str:
    text = str(value or "").strip().upper().replace(" ", "")
    if text not in hq_solid_ops.HOLES_MM:
        raise IntentError("Norme de vis non prise en charge : " + text)
    return text


def _fit(value: Any) -> str:
    text = str(value or "clearance").strip().lower()
    aliases = {"clearance": "clearance", "libre": "clearance", "passage": "clearance",
               "tap": "tap", "taraudé": "tap", "taraude": "tap",
               "insert": "insert",
               "countersunk": "countersunk", "fraisé": "countersunk", "fraisse": "countersunk"}
    text = aliases.get(text, text)
    if text not in hq_solid_ops.FITS:
        raise IntentError("Ajustement de trou inconnu : " + str(value))
    return text


def _blank_spec(data: dict) -> dict:
    out = {
        "kind": "plate",
        "width": None, "depth": None, "height": None, "thickness": None,
        "hole_count": 0, "hole_standard": "M6", "hole_fit": "clearance", "hole_inset": 10.0,
        "boss_count": 0, "boss_diameter": 10.0, "boss_height": 5.0, "boss_inset": None,
        "fillet_radius": 0.0,
        "material": "PLA", "print_orientation": "Z", "quantity": 1,
        "units": "mm", "min_wall_mm": hq_dfm.DEFAULT_MIN_WALL_MM,
        "overhang_deg": hq_dfm.DEFAULT_OVERHANG_DEG,
        "name": "", "source": "", "assumed": {}, "natural": False,
    }
    out.update(data)
    return out


BRACKET_KINDS = ("l_bracket", "l-bracket", "lbracket", "bracket", "angle", "equerre", "équerre")
PLATE_KINDS = ("plate", "plaque", "panneau", "panel")


def _kind(value: Any) -> str:
    text = re.sub(r"[\s_-]+", "_", str(value or "plate").strip().lower())
    if text in BRACKET_KINDS or text in ("angle_bracket", "l_shaped_bracket", "angle"):
        return "l_bracket"
    if text in PLATE_KINDS:
        return "plate"
    raise IntentError("Type de pièce non pris en charge : " + text + " (plaque ou équerre en L)")


def _structured(data: dict) -> dict:
    allowed = {"kind", "width", "length", "depth", "height", "thickness", "holes", "hole_count",
               "hole_standard", "hole_fit", "hole_inset", "edge_offset", "fillet_radius", "fillets",
               "bosses", "boss_count", "boss_diameter", "boss_height", "boss_inset",
               "material", "print_orientation", "quantity", "units", "min_wall_mm", "overhang_deg", "name"}
    unknown = sorted(set(data) - allowed)
    if unknown:
        raise IntentError("Champ de spécification inconnu : " + ", ".join(unknown))
    kind = _kind(data.get("kind"))
    w = data.get("width", data.get("length"))
    d = data.get("depth", data.get("height")) if kind != "l_bracket" else data.get("depth")
    t = data.get("thickness")
    h = data.get("height") if kind == "l_bracket" else None
    if w is None or d is None or t is None or (kind == "l_bracket" and h is None):
        missing = "width, depth, height et thickness" if kind == "l_bracket" else "width, depth et thickness"
        raise IntentError("La spécification doit fournir " + missing)
    spec = _blank_spec({
        "kind": kind,
        "width": _number(w, "Largeur"),
        "depth": _number(d, "Longueur de l'aile" if kind == "l_bracket" else "Profondeur"),
        "height": _number(h, "Hauteur") if h is not None else None,
        "thickness": _number(t, "Épaisseur"),
        "name": _text(data.get("name"), "Nom", 60) if data.get("name") else "",
        "source": json.dumps(data, ensure_ascii=False, sort_keys=True),
    })
    spec["assumed"].update({"width": False, "depth": False, "height": False, "thickness": False, "units": "units" not in data,
                            "material": "material" not in data, "orientation": "print_orientation" not in data,
                            "quantity": "quantity" not in data})
    if "units" in data:
        spec["units"] = str(data["units"]).lower()
        if spec["units"] not in hq_solid_ops.UNIT_MM:
            raise IntentError("Unités invalides")
    if "material" in data:
        spec["material"] = _normal_material(data["material"])
    if "print_orientation" in data:
        spec["print_orientation"] = _normal_orientation(data["print_orientation"])
    if "quantity" in data:
        q = data["quantity"]
        if isinstance(q, bool) or not isinstance(q, int) or not 1 <= q <= 10000:
            raise IntentError("Quantité invalide")
        spec["quantity"] = q
    if "min_wall_mm" in data:
        mw = _number(data["min_wall_mm"], "Épaisseur minimale", lo=0.05, hi=100)
        spec["min_wall_mm"] = mw
        spec["assumed"]["min_wall"] = False
    else:
        spec["assumed"]["min_wall"] = True
    if "overhang_deg" in data:
        spec["overhang_deg"] = _number(data["overhang_deg"], "Angle de surplomb", lo=1, hi=89)
    holes = data.get("holes")
    top_holes = ("hole_count", "hole_standard", "hole_fit", "hole_inset", "edge_offset")
    if holes is not None and any(k in data for k in top_holes):
        raise IntentError("Utiliser soit holes, soit les champs hole_*, pas les deux")
    if holes is None:
        count = data.get("hole_count", 0)
        standard = data.get("hole_standard", "M6")
        fit = data.get("hole_fit", "clearance")
        inset = data.get("hole_inset", data.get("edge_offset", 10.0))
        spec["assumed"].update({"hole_standard": "hole_standard" not in data,
                                "hole_fit": "hole_fit" not in data,
                                "hole_inset": "hole_inset" not in data and "edge_offset" not in data})
    elif isinstance(holes, int) and not isinstance(holes, bool):
        count, standard, fit, inset = holes, "M6", "clearance", 10.0
        spec["assumed"].update({"hole_standard": True, "hole_fit": True, "hole_inset": True})
    elif isinstance(holes, dict):
        allowed_h = {"count", "standard", "fit", "inset", "edge_offset"}
        unknown_h = sorted(set(holes) - allowed_h)
        if unknown_h:
            raise IntentError("Champ de perçage inconnu : " + ", ".join(unknown_h))
        count = holes.get("count", 4)
        standard = holes.get("standard", "M6")
        fit = holes.get("fit", "clearance")
        inset = holes.get("inset", holes.get("edge_offset", 10.0))
        spec["assumed"].update({"hole_standard": "standard" not in holes, "hole_fit": "fit" not in holes,
                                "hole_inset": "inset" not in holes and "edge_offset" not in holes})
    else:
        raise IntentError("holes doit être un entier ou un objet")
    if isinstance(count, bool) or not isinstance(count, int) or count < 0 or count > 8:
        raise IntentError("Nombre de trous invalide")
    if count not in (0, 1, 2, 4):
        raise IntentError("Motif de perçage non pris en charge (0, 1, 2 ou 4 trous)")
    spec["hole_count"] = count
    spec["hole_standard"] = _standard(standard)
    spec["hole_fit"] = _fit(fit)
    spec["hole_inset"] = _number(inset, "Distance au bord")
    spec["assumed"]["no_holes"] = count == 0 and holes is None and "hole_count" not in data
    bosses = data.get("bosses")
    top_bosses = ("boss_count", "boss_diameter", "boss_height", "boss_inset")
    if bosses is not None and any(k in data for k in top_bosses):
        raise IntentError("Utiliser soit bosses, soit les champs boss_*, pas les deux")
    if bosses is None:
        boss_count = data.get("boss_count", 0)
        boss_diameter = data.get("boss_diameter", 10.0)
        boss_height = data.get("boss_height", 5.0)
        boss_inset = data.get("boss_inset", spec["hole_inset"])
        spec["assumed"].update({"boss_diameter": "boss_diameter" not in data,
                                "boss_height": "boss_height" not in data,
                                "boss_inset": "boss_inset" not in data,
                                "no_bosses": boss_count == 0 and "boss_count" not in data})
    elif isinstance(bosses, int) and not isinstance(bosses, bool):
        boss_count, boss_diameter, boss_height, boss_inset = bosses, 10.0, 5.0, spec["hole_inset"]
        spec["assumed"].update({"boss_diameter": True, "boss_height": True, "boss_inset": True,
                                "no_bosses": bosses == 0})
    elif isinstance(bosses, dict):
        allowed_b = {"count", "diameter", "height", "inset", "edge_offset"}
        unknown_b = sorted(set(bosses) - allowed_b)
        if unknown_b:
            raise IntentError("Champ de bossage inconnu : " + ", ".join(unknown_b))
        boss_count = bosses.get("count", 4)
        boss_diameter = bosses.get("diameter", 10.0)
        boss_height = bosses.get("height", 5.0)
        boss_inset = bosses.get("inset", bosses.get("edge_offset", spec["hole_inset"]))
        spec["assumed"].update({"boss_diameter": "diameter" not in bosses,
                                "boss_height": "height" not in bosses,
                                "boss_inset": "inset" not in bosses and "edge_offset" not in bosses,
                                "no_bosses": boss_count == 0})
    else:
        raise IntentError("bosses doit être un entier ou un objet")
    if isinstance(boss_count, bool) or not isinstance(boss_count, int) or boss_count < 0 or boss_count > 8:
        raise IntentError("Nombre de bossages invalide")
    if boss_count not in (0, 1, 2, 4):
        raise IntentError("Motif de bossages non pris en charge (0, 1, 2 ou 4)")
    spec["boss_count"] = boss_count
    spec["boss_diameter"] = _number(boss_diameter, "Diamètre de bossage", lo=1.0)
    spec["boss_height"] = _number(boss_height, "Hauteur de bossage", lo=0.1)
    spec["boss_inset"] = _number(boss_inset, "Distance au bord des bossages")
    if boss_count and count:
        hole_diameter = hq_solid_ops.hole_geometry(spec["hole_standard"], spec["hole_fit"], spec["units"])["r"] * 2
        if spec["boss_diameter"] <= hole_diameter + 1.0:
            raise IntentError("Le diamètre des bossages doit dépasser celui des trous d'au moins 1 mm")
    if "fillet_radius" in data or "fillets" in data:
        spec["fillet_radius"] = _number(data.get("fillet_radius", data.get("fillets")), "Rayon de congé", lo=0)
        spec["assumed"]["fillet"] = False
    else:
        spec["assumed"]["fillet"] = True
    return spec


def _natural(text: str) -> dict:
    src = text.strip()
    if not src:
        raise IntentError("Intention vide")
    low = src.lower().replace("\u00d7", "x").replace("\u2013", "-")
    bracket = bool(re.search(r"\bl\s*[- ]*(?:shaped\s+)?bracket\b|\b(?:l\s*)?(?:angle\s*)?bracket\b|\bequerre\b|\béquerre\b", low))
    for unsupported in ("support", "boîte", "boite", "box", "tube", "cylindre", "cylinder", "engrenage", "gear"):
        if re.search(r"\b" + re.escape(unsupported) + r"\b", low):
            raise IntentError("Type de pièce non pris en charge : " + unsupported + " (plaque ou équerre en L)")
    number = r"(?<![\d.])(\d+(?:[.,]\d+)?)\s*(?:mm)?"
    three = number + r"\s*[x*]\s*" + number + r"\s*[x*]\s*" + number
    m = re.search(three, low)
    if bracket:
        width_given = False
        w, d, h, t = 20.0, None, None, None
        if m:
            dims = [float(x.replace(",", ".")) for x in m.groups()]
            four = re.search(three + r"\s*[x*]\s*" + number, low)
            if four:
                w, d, h, t = (float(x.replace(",", ".")) for x in four.groups())
                width_given = True
            else:
                # The common shop shorthand is leg x leg x thickness; the bracket width is the only
                # value that cannot be read from it, so it stays a named assumption instead of a guess.
                d, h, t = dims
        legs = re.search(r"\blegs?\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*[x*]\s*(\d+(?:[.,]\d+)?)", low)
        if legs:
            d, h = (float(x.replace(",", ".")) for x in legs.groups())
        labelled = {
            "width": r"(?:width|largeur)",
            "depth": r"(?:depth|aile|longueur)",
            "height": r"(?:height|hauteur|montant)",
            "thickness": r"(?:thickness|épaisseur|epaisseur)",
        }
        for key, label in labelled.items():
            found = re.search(r"\b" + label + r"\s*[:=]?\s*(\d+(?:[.,]\d+)?)(?:\s*mm)?\b", low)
            if found:
                value = float(found.group(1).replace(",", "."))
                if key == "width":
                    w, width_given = value, True
                elif key == "depth":
                    d = value
                elif key == "height":
                    h = value
                else:
                    t = value
        if d is None or h is None or t is None:
            raise IntentError("Dimensions d'équerre introuvables : fournir largeur, ailes et épaisseur")
    else:
        if not m:
            raise IntentError("Dimensions introuvables : attendu largeur x profondeur x épaisseur, par exemple 100x60x6")
        w, d, t = (float(x.replace(",", ".")) for x in m.groups())
        h = None
        width_given = True
    spec = _blank_spec({
        "kind": "l_bracket" if bracket else "plate",
        "width": _number(w, "Largeur"), "depth": _number(d, "Longueur de l'aile" if bracket else "Profondeur"),
        "height": _number(h, "Hauteur") if h is not None else None,
        "thickness": _number(t, "Épaisseur"), "source": src, "natural": True,
    })
    if re.search(r"\b(inch|inches|pouce|pouces)\b", low):
        raise IntentError("Unités en pouces non prises en charge par cette commande (utiliser mm)")
    spec["assumed"].update({"units": not re.search(r"\bmm\b", low), "material": True, "orientation": True,
                            "quantity": True, "fillet": not bracket, "hole_standard": True, "hole_fit": True,
                            "hole_inset": True, "no_holes": True, "width": not width_given,
                            "height": False, "boss_diameter": True, "boss_height": True, "boss_inset": True,
                            "no_bosses": True})
    mat = re.search(r"(?:material|mati[eè]re)\s*[:=]?\s*([a-z0-9+\-]{2,16})", low)
    if mat:
        spec["material"] = _normal_material(mat.group(1))
        spec["assumed"]["material"] = False
    ori = re.search(r"(?:orientation|impression|print)\s*[:=]?\s*([xyz])(?:\s*(?:up|vers le haut))?", low)
    if ori:
        spec["print_orientation"] = _normal_orientation(ori.group(1))
        spec["assumed"]["orientation"] = False
    qty = re.search(r"\b(\d{1,4})\s*(?:pi[eè]ces?|pcs?|units?)\b", low)
    if qty:
        spec["quantity"] = int(qty.group(1))
        spec["assumed"]["quantity"] = False
    if re.search(r"\b(no|sans|without)\s+(?:holes?|trous?|per[cç]ages?)\b", low):
        spec["hole_count"] = 0
        spec["assumed"]["no_holes"] = False
    else:
        hm = re.search(r"\b(one|two|three|four|five|six|seven|eight|un|deux|trois|quatre|cinq|huit|[1-8])\s*(?:x\s*)?(?:m(\d+(?:\.\d+)?))\b", low)
        if not hm:
            hm = re.search(r"\bm(\d+(?:\.\d+)?)\s*(?:x\s*([1-8]))?", low)
            if hm:
                count = int(hm.group(2) or 4)
                std = hm.group(1)
                spec["assumed"]["no_holes"] = False
            else:
                count, std = 0, None
        else:
            raw_count = hm.group(1)
            count = COUNT_WORDS.get(raw_count)
            if count is None:
                count = int(raw_count) if raw_count.isdigit() else 0
            std = hm.group(2)
            spec["assumed"]["no_holes"] = False
        if count:
            spec["hole_count"] = count
            if std:
                spec["hole_standard"] = _standard("M" + std)
                spec["assumed"]["hole_standard"] = False
            if re.search(r"\b(tapped?|taraud[eé]s?|threaded)\b", low):
                spec["hole_fit"] = "tap"
                spec["assumed"]["hole_fit"] = False
            elif re.search(r"\b(insert|inserts?|filet[eé]s?)\b", low):
                spec["hole_fit"] = "insert"
                spec["assumed"]["hole_fit"] = False
            elif re.search(r"\b(countersunk|frais[eé]s?)\b", low):
                spec["hole_fit"] = "countersunk"
                spec["assumed"]["hole_fit"] = False
            elif re.search(r"\b(clearance|passage|libre)\b", low):
                spec["hole_fit"] = "clearance"
                spec["assumed"]["hole_fit"] = False
            off = re.search(r"(\d+(?:[.,]\d+)?)\s*mm\s*(?:from|of|des|du|de la|de)\s*(?:the\s*)?(?:edge|edges|bord|bords|contour)", low)
            if off:
                spec["hole_inset"] = _number(float(off.group(1).replace(",", ".")), "Distance au bord")
                spec["assumed"]["hole_inset"] = False
    boss = re.search(r"\b(?:cylindrical\s+)?boss(?:es)?\b|\bbossages?\b|\bbosses?\s+cylindriques?\b", low)
    if boss:
        bm = re.search(r"\b(one|two|three|four|five|six|seven|eight|un|deux|trois|quatre|cinq|huit|[1-8])\s*(?:x\s*)?(?:(?:cylindrical|cylindriques?)\s*)?(?:boss(?:es)?|bossages?)\b", low)
        count = COUNT_WORDS.get(bm.group(1)) if bm else 4
        if count is None and bm:
            count = int(bm.group(1))
        spec["boss_count"] = int(count or 4)
        spec["assumed"]["no_bosses"] = False
        dm = (re.search(r"(\d+(?:[.,]\d+)?)\s*mm\s*(?:de\s*)?(?:diameter|diam[eè]tre|dia)\b", low)
              or re.search(r"(?:diameter|diam[eè]tre|dia)\s*(?:of|de|:)?\s*(\d+(?:[.,]\d+)?)\s*mm", low))
        if dm:
            spec["boss_diameter"] = _number(float(dm.group(1).replace(",", ".")), "Diamètre de bossage", lo=1.0)
            spec["assumed"]["boss_diameter"] = False
        hm = (re.search(r"(\d+(?:[.,]\d+)?)\s*mm\s*(?:high|tall|haut|hauteur|height)\b", low)
              or re.search(r"(?:height|hauteur|haut)\s*(?:of|de|:)?\s*(\d+(?:[.,]\d+)?)\s*mm", low))
        if hm:
            spec["boss_height"] = _number(float(hm.group(1).replace(",", ".")), "Hauteur de bossage", lo=0.1)
            spec["assumed"]["boss_height"] = False
        bi = re.search(r"(\d+(?:[.,]\d+)?)\s*mm\s*(?:from|of|des|du|de la|de)\s*(?:the\s*)?(?:edge|edges|bord|bords|contour)", low)
        if bi:
            spec["boss_inset"] = _number(float(bi.group(1).replace(",", ".")), "Distance au bord des bossages")
            spec["assumed"]["boss_inset"] = False
        if spec["boss_inset"] is None:
            spec["boss_inset"] = spec["hole_inset"]
    fm = re.search(r"(\d+(?:[.,]\d+)?)\s*mm\s*(?:radius\s*)?(?:fillets?|corner\s*radius|rounded|rayons?|cong[eé]s?)", low)
    if not fm:
        fm = re.search(r"(?:fillets?|rayons?|cong[eé]s?)\s*(?:of|de|:)?\s*(\d+(?:[.,]\d+)?)\s*mm", low)
    if fm:
        spec["fillet_radius"] = _number(float(fm.group(1).replace(",", ".")), "Rayon de congé", lo=0)
        spec["assumed"]["fillet"] = False
    return spec


def parse_intent(intent: Any) -> dict:
    """Parse a natural-language sentence or a structured specification into a checked spec."""
    if isinstance(intent, dict):
        return _structured(intent)
    if isinstance(intent, str):
        return _natural(intent)
    raise IntentError("Intention invalide")


def _assumptions(spec: dict) -> list[dict]:
    out = []

    def add(name: str, value: str, reason: str) -> None:
        label = f"A{len(out) + 1} {name}"
        out.append({"id": f"asm-{len(out) + 1}", "name": label, "value": value, "reason": reason})

    assumed = spec.get("assumed") or {}
    if assumed.get("units"):
        add("Unités", "millimètres", "aucune unité fournie")
    if spec.get("natural"):
        if spec.get("kind") == "l_bracket":
            add("Cotes", f"{spec['width']:g} = largeur, {spec['depth']:g} = aile horizontale, "
                f"{spec['height']:g} = hauteur, {spec['thickness']:g} = épaisseur",
                "équerre en L, dimensions dans l'ordre largeur × aile × hauteur × épaisseur")
        else:
            add("Cotes", f"{spec['width']:g} = X (largeur), {spec['depth']:g} = Y (profondeur)",
                "ordre largeur × profondeur × épaisseur")
    if spec.get("assumed", {}).get("width"):
        add("Largeur de l'équerre", f"{spec['width']:g} mm", "aucune largeur fournie pour l'équerre")
    if assumed.get("material"):
        add("Matière", str(spec["material"]), "aucune matière fournie")
    if assumed.get("orientation"):
        add("Orientation", f"{spec['print_orientation']} vers le haut", "aucune orientation d'impression fournie")
    if assumed.get("quantity"):
        add("Quantité", str(spec["quantity"]), "aucune quantité fournie")
    if assumed.get("no_holes"):
        add("Perçages", "aucun", "aucun perçage demandé")
    if spec.get("hole_count"):
        if assumed.get("hole_standard"):
            add("Norme de vis", str(spec["hole_standard"]), "aucune norme de vis fournie")
        if assumed.get("hole_fit"):
            add("Ajustement des trous", str(spec["hole_fit"]), "aucun ajustement fourni")
        if assumed.get("hole_inset"):
            add("Distance au bord", f"{spec['hole_inset']:g} mm", "aucune distance au bord fournie")
    if spec.get("boss_count"):
        if assumed.get("boss_diameter"):
            add("Diamètre des bossages", f"{spec['boss_diameter']:g} mm", "aucun diamètre de bossage fourni")
        if assumed.get("boss_height"):
            add("Hauteur des bossages", f"{spec['boss_height']:g} mm", "aucune hauteur de bossage fournie")
        if assumed.get("boss_inset"):
            add("Distance au bord des bossages", f"{spec['boss_inset']:g} mm",
                "aucune distance au bord fournie pour les bossages")
    if assumed.get("fillet"):
        add("Congés", "aucun", "aucun rayon de congé demandé")
    elif spec.get("fillet_radius"):
        add("Congés", f"{spec['fillet_radius']:g} mm aux quatre angles", "même rayon sur les angles")
    if assumed.get("min_wall"):
        add("Épaisseur minimale", f"{spec['min_wall_mm']:g} mm", "seuil FDM par défaut")
    return out


# ---------------------------------------------------------------- the v6 document
def _pattern_positions(width: float, depth: float, inset: float, count: int) -> list[tuple[float, float]]:
    if count == 0:
        return []
    if count == 1:
        return [(width / 2, depth / 2)]
    if count == 2:
        return [(inset, depth / 2), (width - inset, depth / 2)]
    return [(inset, inset), (width - inset, inset), (width - inset, depth - inset), (inset, depth - inset)]


def _hole_positions(spec: dict) -> list[tuple[float, float]]:
    return _pattern_positions(spec["width"], spec["depth"], spec["hole_inset"], spec["hole_count"])


def _profile_ids(objects: list[dict], sketch: str = "") -> list[str]:
    return [o["id"] for o in objects if o["type"] in ("line", "arc") and (o.get("sketch") or "") == sketch]


def _geometry(spec: dict) -> tuple[list[dict], list[dict], list[dict]]:
    kind = spec.get("kind", "plate")
    w, d, r = spec["width"], spec["depth"], spec["fillet_radius"]
    t = spec["thickness"]
    if r < 0 or r > min(w, d) / 2 - 1e-9:
        raise IntentError("Rayon de congé trop grand pour cette plaque")
    if kind == "l_bracket":
        h = spec.get("height")
        if h is None or h <= 0:
            raise IntentError("Hauteur d'équerre positive requise")
        if h <= t + 1e-9 or d <= t + 1e-9:
            raise IntentError("L'épaisseur de l'équerre doit rester inférieure à ses ailes")
    points: list[dict] = []
    objects: list[dict] = []
    constraints: list[dict] = []
    if r <= 1e-9:
        coords = [(0, 0), (w, 0), (w, d), (0, d)]
        for i, (x, y) in enumerate(coords):
            points.append({"id": f"pp{i}", "x": x, "y": y})
        for i in range(4):
            objects.append({"id": f"pe{i}", "type": "line", "p1": f"pp{i}", "p2": f"pp{(i + 1) % 4}"})
        profile = [f"pe{i}" for i in range(4)]
        for i, val in enumerate((w, d, w, d)):
            constraints.append({"id": f"cs{i}", "type": "length", "line": f"pe{i}", "fixed": f"pp{i}", "value": val})
        for i in range(4):
            constraints.append({"id": f"ch{i}", "type": "horizontal" if i % 2 == 0 else "vertical", "line": f"pe{i}"})
    else:
        coords = [(r, 0), (w - r, 0), (w, r), (w, d - r), (w - r, d), (r, d), (0, d - r), (0, r)]
        for i, (x, y) in enumerate(coords):
            points.append({"id": f"pp{i}", "x": x, "y": y})
        centres = [(w - r, r), (w - r, d - r), (r, d - r), (r, r)]
        for i, (x, y) in enumerate(centres):
            points.append({"id": f"pc{i}", "x": x, "y": y})
        for i in range(4):
            objects.append({"id": f"pe{i}", "type": "line", "p1": f"pp{2 * i}", "p2": f"pp{2 * i + 1}"})
            objects.append({"id": f"pa{i}", "type": "arc", "center": f"pc{i}",
                            "p1": f"pp{(2 * i + 1) % 8}", "p2": f"pp{(2 * i + 2) % 8}"})
        profile = []
        for i in range(4):
            profile += [f"pe{i}", f"pa{i}"]
        straight = (w - 2 * r, d - 2 * r, w - 2 * r, d - 2 * r)
        for i, val in enumerate(straight):
            constraints.append({"id": f"cs{i}", "type": "length", "line": f"pe{i}", "fixed": f"pp{2 * i}", "value": val})
            constraints.append({"id": f"ch{i}", "type": "horizontal" if i % 2 == 0 else "vertical", "line": f"pe{i}"})
        for i in range(4):
            constraints.append({"id": f"cr{i}", "type": "radius", "item": f"pa{i}", "value": r})
    constraints.append({"id": "cfixed", "type": "fixed", "point": "pp0"})
    if kind == "l_bracket":
        h = spec["height"]
        for i, (x, y) in enumerate(((0, 0), (w, 0), (w, h), (0, h))):
            points.append({"id": f"lp{i}", "sketch": "sk-leg", "x": x, "y": y})
        for i in range(4):
            objects.append({"id": f"le{i}", "type": "line", "sketch": "sk-leg",
                            "p1": f"lp{i}", "p2": f"lp{(i + 1) % 4}"})
            constraints.append({"id": f"lb{i}", "type": "length", "line": f"le{i}",
                                "fixed": f"lp{i}", "value": (w, h, w, h)[i]})
            constraints.append({"id": f"lh{i}", "type": "horizontal" if i % 2 == 0 else "vertical", "line": f"le{i}"})
        constraints.append({"id": "lfixed", "type": "fixed", "point": "lp0"})
    boss_centres: list[tuple[float, float]] = []
    if spec.get("boss_count"):
        boss_r = spec["boss_diameter"] / 2
        boss_inset = spec.get("boss_inset") if spec.get("boss_inset") is not None else spec["hole_inset"]
        boss_centres = _pattern_positions(w, d, boss_inset, spec["boss_count"])
        for i, (x, y) in enumerate(boss_centres):
            points.append({"id": f"bp{i}", "sketch": "sk-boss", "x": x, "y": y})
            objects.append({"id": f"bc{i}", "type": "circle", "sketch": "sk-boss",
                            "center": f"bp{i}", "r": boss_r})
            if x - boss_r < -1e-9 or y - boss_r < -1e-9 or x + boss_r > w + 1e-9 or y + boss_r > d + 1e-9:
                raise IntentError("Un bossage sort de la plaque")
            if r > 1e-9:
                cx = r if x < w / 2 else w - r
                cy = r if y < d / 2 else d - r
                if math.hypot(x - cx, y - cy) < r + boss_r - 1e-9:
                    raise IntentError("Un bossage coupe un congé")
        if len(boss_centres) > 1:
            for i, (x1, y1) in enumerate(boss_centres):
                for x2, y2 in boss_centres[i + 1:]:
                    if math.hypot(x1 - x2, y1 - y2) < 2 * boss_r - 1e-9:
                        raise IntentError("Deux bossages se chevauchent")
    hole_objects = []
    if spec["hole_count"]:
        row = hq_solid_ops.HOLES_MM[spec["hole_standard"]]
        fit = spec["hole_fit"]
        geo = hq_solid_ops.hole_geometry(spec["hole_standard"], fit, spec["units"])
        radius = geo["r"]
        for i, (x, y) in enumerate(_hole_positions(spec)):
            points.append({"id": f"hp{i}", "x": x, "y": y})
            objects.append({"id": f"ph{i}", "type": "circle", "center": f"hp{i}", "r": radius})
            hole_objects.append(f"ph{i}")
        # Keep every hole inside the outline, including the rounded corners.
        for centre in _hole_positions(spec):
            if centre[0] - radius < -1e-9 or centre[1] - radius < -1e-9 or centre[0] + radius > w + 1e-9 or centre[1] + radius > d + 1e-9:
                raise IntentError("Un trou sort de la plaque")
            if r > 1e-9:
                cx = r if centre[0] < w / 2 else w - r
                cy = r if centre[1] < d / 2 else d - r
                if math.hypot(centre[0] - cx, centre[1] - cy) < r + radius - 1e-9:
                    raise IntentError("Un trou coupe un congé")
    return points, objects, constraints


def _make_document(spec: dict) -> dict:
    w, d, t = spec["width"], spec["depth"], spec["thickness"]
    if t <= 0 or w <= 0 or d <= 0:
        raise IntentError("Dimensions positives requises")
    points, objects, constraints = _geometry(spec)
    params = [
        {"id": "param-width", "name": "width", "expr": f"{w:g}"},
        {"id": "param-depth", "name": "depth", "expr": f"{d:g}"},
    ]
    if spec["kind"] == "l_bracket":
        params.append({"id": "param-height", "name": "height", "expr": f"{spec['height']:g}"})
    params += [
        {"id": "param-thickness", "name": "thickness", "expr": f"{t:g}"},
        {"id": "param-inset", "name": "hole_inset", "expr": f"{spec['hole_inset']:g}"},
        {"id": "param-fillet", "name": "fillet_radius", "expr": f"{spec['fillet_radius']:g}"},
    ]
    if spec["boss_count"]:
        params += [
            {"id": "param-boss-inset", "name": "boss_inset", "expr": f"{spec['boss_inset']:g}"},
            {"id": "param-boss-diameter", "name": "boss_diameter", "expr": f"{spec['boss_diameter']:g}"},
            {"id": "param-boss-height", "name": "boss_height", "expr": f"{spec['boss_height']:g}"},
        ]
    profile = _profile_ids(objects)
    features = [{
        "id": "f-base", "type": "extrude", "profile": profile, "depth": t, "extent": "blind",
        "op": "add", "name": "Plaque de base", "driven": {"depth": "thickness"},
    }]
    if spec["kind"] == "l_bracket":
        features.append({
            "id": "f-leg", "type": "extrude", "profile": _profile_ids(objects, "sk-leg"), "depth": t,
            "extent": "blind", "op": "add", "reverse": True, "name": "Aile verticale",
            "driven": {"depth": "thickness"},
        })
    for i in range(spec["boss_count"]):
        features.append({
            "id": f"f-boss-{i}", "type": "extrude", "profile": [f"bc{i}"], "depth": spec["boss_height"],
            "extent": "blind", "op": "add", "name": f"Bossage cylindrique {i + 1}",
            "driven": {"depth": "boss_height"},
        })
    if spec["hole_count"]:
        features.append({
            "id": "f-holes", "type": "hole", "at": [f"ph{i}" for i in range(spec["hole_count"])],
            "standard": spec["hole_standard"], "fit": spec["hole_fit"], "extent": "throughAll",
            "depth": 0, "name": f"Perçages {spec['hole_standard']}",
        })
    doc = {
        "format": FORMAT, "version": 6, "units": spec["units"], "mode": "construction",
        "grid": {"spacing": 10, "visible": True, "snap": True},
        "snap": {"angle": True, "angleStep": 15},
        "nextId": 1000,
        "sketches": ([{"id": "sk-main", "name": "Contour", "plane": "XY", "offset": 0}]
                     + ([{"id": "sk-leg", "name": "Aile verticale", "plane": "XZ", "offset": 0}]
                        if spec["kind"] == "l_bracket" else [])
                     + ([{"id": "sk-boss", "name": "Bossages", "plane": "XY", "offset": t}]
                        if spec["boss_count"] else [])),
        "params": params,
        "assumptions": _assumptions(spec),
        "points": points,
        "objects": objects,
        "constraints": constraints,
        "features": features,
        "faceFeatures": [],
        "roundFeatures": [],
    }
    return doc


def _canonical(doc: dict) -> bool:
    points = {p.get("id") for p in doc.get("points") or []}
    objects = {o.get("id") for o in doc.get("objects") or []}
    features = doc.get("features") or []
    bracket = any(f.get("id") == "f-leg" for f in features)
    bosses = [f for f in features if str(f.get("id") or "").startswith("f-boss-")]
    required_points = {f"pp{i}" for i in range(4)}
    required_objects = {f"pe{i}" for i in range(4)}
    if bracket:
        required_points |= {f"lp{i}" for i in range(4)}
        required_objects |= {f"le{i}" for i in range(4)}
    for i in range(len(bosses)):
        required_points.add(f"bp{i}")
        required_objects.add(f"bc{i}")
    return (required_points <= points and required_objects <= objects
            and all(o.get("type") in ("line", "arc", "circle") for o in doc.get("objects") or []))


def _sync_plate_geometry(doc: dict) -> dict:
    """Regenerate the intent profile, boss and hole positions from the current parameter values.

    Only documents still carrying the canonical intent geometry are touched. An edited drawing with
    extra annotations keeps its own geometry and still rebuilds through the driven feature values.
    """
    if not _canonical(doc):
        return doc
    values = hq_params.parameter_values(doc)
    features = doc.get("features") or []
    bracket = any(f.get("id") == "f-leg" for f in features)
    boss_features = [f for f in features if str(f.get("id") or "").startswith("f-boss-")]
    feature = next((f for f in doc.get("features") or [] if f.get("id") == "f-holes"), None)
    standard = feature.get("standard") if feature else "M6"
    fit = feature.get("fit") if feature else "clearance"
    count = len(feature.get("at") or []) if feature else 0
    objects_by_id = {o.get("id"): o for o in doc.get("objects") or []}
    boss_diameter = values.get("boss_diameter")
    if boss_diameter is None and boss_features:
        boss_diameter = float(objects_by_id["bc0"]["r"]) * 2
    boss_height = values.get("boss_height")
    if boss_height is None and boss_features:
        boss_height = float(boss_features[0].get("depth") or 5.0)
    spec = {
        "kind": "l_bracket" if bracket else "plate",
        "width": values["width"], "depth": values["depth"], "thickness": values["thickness"],
        "height": values.get("height", values["depth"]),
        "hole_count": count, "hole_standard": standard, "hole_fit": fit,
        "hole_inset": values.get("hole_inset", 10.0), "fillet_radius": values.get("fillet_radius", 0.0),
        "boss_count": len(boss_features), "boss_diameter": boss_diameter or 10.0,
        "boss_height": boss_height or 5.0, "boss_inset": values.get("boss_inset", values.get("hole_inset", 10.0)),
        "units": doc.get("units") or "mm",
    }
    points, objects, constraints = _geometry(spec)
    doc["points"] = points
    doc["objects"] = objects
    doc["constraints"] = constraints
    sketches = doc.get("sketches") or []
    if bracket:
        leg = next((s for s in sketches if s.get("id") == "sk-leg"), None)
        if leg is not None:
            leg["offset"] = 0
    if boss_features:
        boss_sketch = next((s for s in sketches if s.get("id") == "sk-boss"), None)
        if boss_sketch is not None:
            boss_sketch["offset"] = values["thickness"]
    if feature:
        feature["at"] = [f"ph{i}" for i in range(count)]
    base = next((f for f in doc.get("features") or [] if f.get("id") == "f-base"), None)
    if base:
        base["profile"] = _profile_ids(objects)
    leg = next((f for f in doc.get("features") or [] if f.get("id") == "f-leg"), None)
    if leg:
        leg["profile"] = _profile_ids(objects, "sk-leg")
    for i, boss in enumerate(boss_features):
        boss["profile"] = [f"bc{i}"]
        boss["depth"] = spec["boss_height"]
    return doc


# ---------------------------------------------------------------- exact rebuild
def _solid_info(doc: dict, shape=None) -> tuple[Any, list, dict]:
    if not hq_solid_occ.uses_occ(doc):
        raise IntentError("Le document doit être une pièce exacte (version 6)")
    shape = hq_solid_occ.build_shape(doc) if shape is None else shape
    if shape is None or shape.IsNull():
        raise IntentError("OpenCascade n'a produit aucun solide")
    try:
        from OCP.BRepCheck import BRepCheck_Analyzer
        valid = bool(BRepCheck_Analyzer(shape).IsValid())
    except ImportError:  # pragma: no cover - OCP is required for this path
        valid = False
    solids = hq_solid_occ._solids(shape)
    volume = hq_solid_occ._volume(shape)
    bounds, _span = hq_solid_occ._bounds(shape)
    mesh = hq_solid_occ.triangles(shape)
    if not valid or solids != 1 or volume <= 1e-9 or not mesh:
        raise IntentError("Solide OpenCascade invalide (BRep, volume ou maillage)")
    if not hq_dfm.watertight(mesh):
        raise IntentError("Le maillage exact n'est pas étanche")
    return shape, mesh, {"valid": valid, "solids": solids, "volume_mm3": volume,
                         "bounds": list(bounds), "triangles": len(mesh)}


def rebuild(doc: dict) -> dict:
    """Resolve parameters, regenerate the plate dimensions, validate and rebuild through OCC."""
    if not isinstance(doc, dict):
        raise IntentError("Document invalide")
    try:
        resolved = hq_params.resolve(doc)
    except hq_params.ParamError as exc:
        raise IntentError(str(exc)) from exc
    if _canonical(resolved):
        resolved = _sync_plate_geometry(resolved)
    try:
        validated = hq_drawings.validate_document(resolved, build=False)
    except hq_drawings.DrawingError as exc:
        raise IntentError(str(exc)) from exc
    shape, mesh, info = _solid_info(validated)
    return {"doc": validated, "shape": shape, "mesh": mesh, "solid": info}


def set_parameter(doc: dict, name: str, expr: str) -> dict:
    """Change one named parameter and perform a full, validated rebuild."""
    if not isinstance(doc, dict) or not any(p.get("name") == name for p in doc.get("params") or []):
        raise IntentError("Paramètre introuvable : " + str(name))
    try:
        resolved = hq_params.resolve(doc, {name: expr})
    except hq_params.ParamError as exc:
        raise IntentError(str(exc)) from exc
    if _canonical(resolved):
        resolved = _sync_plate_geometry(resolved)
    try:
        validated = hq_drawings.validate_document(resolved, build=False)
    except hq_drawings.DrawingError as exc:
        raise IntentError(str(exc)) from exc
    shape, mesh, info = _solid_info(validated)
    return {"doc": validated, "shape": shape, "mesh": mesh, "solid": info}


def build_document(intent: Any) -> dict:
    """Spec -> ordinary v6 document -> exact OpenCascade solid. Nothing unvalidated is returned."""
    spec = parse_intent(intent)
    raw = _make_document(spec)
    built = rebuild(raw)
    built["spec"] = spec
    return built


# ---------------------------------------------------------------- manufacturing context
def _safe_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _filament_context(root: Path | None, material: str) -> tuple[dict, list[dict]]:
    state = hq_state.agent_state_dir(root) if root else None
    cfg = _safe_json(state / "print3d.json") if state else None
    try:
        settings = hq_print3d_filament.clean_settings((cfg or {}).get("filament"), None)
    except hq_print3d_filament.FilamentError:
        settings = hq_print3d_filament.clean_settings(None, None)
    spools = []
    if state:
        try:
            spools = [s for s in hq_print3d_filament.list_spools(state)
                      if hq_print3d_filament.base_material(s.get("material")) == material]
        except Exception:
            spools = []
    return settings, spools


def _inventory_items(root: Path | None) -> list[dict]:
    if not root:
        return []
    path = hq_inventory.inventory_path(root)
    data = _safe_json(path)
    if not data or not hq_inventory.validate_doc(data):
        return []
    return data.get("items") or []


def _matches(item: dict, words: tuple[str, ...]) -> bool:
    hay = " ".join([item.get("name") or "", item.get("note") or "", " ".join(item.get("tags") or [])]).lower()
    return all(w.lower() in hay for w in words)


def _project(root: Path | None, wanted: str | None) -> dict | None:
    if not root or not wanted:
        return None
    path = hq_projects.projects_path(root)
    data = _safe_json(path)
    if not data:
        return None
    for project in data.get("projects") or []:
        if project.get("id") == wanted or str(project.get("name") or "").casefold() == wanted.casefold():
            return {"id": project.get("id"), "name": project.get("name"),
                    "bom": copy.deepcopy(project.get("bom") or [])}
    return None


def _bom_id(label: str) -> str:
    return "bom-" + hashlib.sha1(label.encode("utf-8")).hexdigest()[:10]


def manufacturing_context(doc: dict, solid: dict, *, root: Path | str | None = None,
                          material: str | None = None, quantity: int | None = None,
                          project: str | None = None) -> dict:
    """Cost, filament, stock and existing BOM context attached to the exact part."""
    root = Path(root) if root else None
    mat = _normal_material(material) if material else _normal_material(
        next((a["value"] for a in doc.get("assumptions") or [] if a.get("name") == "Matière"), "PLA"))
    qty = int(quantity or 1)
    settings, spools = _filament_context(root, mat)
    items = _inventory_items(root)
    density = hq_print3d_filament.density(mat)
    volume_mm3 = float(solid["volume_mm3"])
    mass_one = volume_mm3 / 1000.0 * density
    mass = mass_one * qty
    metres = hq_print3d_filament.grams_to_metres(mass, mat)
    price_kg = hq_print3d_filament.price_per_kg(mat, settings)
    cost = round(mass / 1000.0 * price_kg, 2)
    currency = settings.get("currency") or "$"
    spool_g = round(sum(float(s.get("remaining_g") or 0) for s in spools), 1)
    material_items = [i for i in items if _matches(i, ("filament",)) or _matches(i, (mat,))]
    material_stock = sum(int(i.get("qty") or 0) for i in material_items)
    enough = spool_g >= mass if spools else (material_stock >= mass if material_items else None)
    stock_status = "available" if enough is True else ("missing" if enough is False else "unknown")
    feature = next((f for f in doc.get("features") or [] if f.get("type") == "hole"), None)
    fasteners = 0
    standard = ""
    if feature:
        fasteners = sum(len(f.get("at") or []) for f in doc.get("features") or [] if f.get("type") == "hole")
        standard = str(feature.get("standard") or "")
    fastener_items = [i for i in items if _matches(i, (standard.lower(),)) or _matches(i, ("vis", standard.lower()))] if standard else []
    fastener_stock = sum(int(i.get("qty") or 0) for i in fastener_items)
    bom = [{
        "id": _bom_id("filament-" + mat), "item": None, "name": f"Filament {mat}",
        "qty": max(1, math.ceil(mass)), "unit": "g", "cost": int(round(cost * 100)),
        "status": "have" if enough else "need", "note": f"{mass:.1f} g ≈ {metres:.1f} m", "used": False,
    }]
    if fasteners:
        bom.append({
            "id": _bom_id("fastener-" + standard), "item": None, "name": f"Vis {standard}",
            "qty": fasteners * qty, "unit": "pcs", "cost": None,
            "status": "have" if fastener_stock >= fasteners * qty else "need",
            "note": "visserie standard, longueur à choisir selon l'usage", "used": False,
        })
    proj = _project(root, project)
    return {
        "material": mat,
        "quantity": qty,
        "density_g_cm3": density,
        "volume_mm3": round(volume_mm3, 3),
        "mass_g": round(mass, 2),
        "mass_one_g": round(mass_one, 2),
        "filament_m": round(metres, 2),
        "price_per_kg": price_kg,
        "cost": cost,
        "currency": currency,
        "print3d": {"settings": settings, "spools": spools, "spool_remaining_g": spool_g},
        "stock": {
            "status": stock_status,
            "enough": enough,
            "spool_remaining_g": spool_g,
            "material_items": material_items,
            "material_qty": material_stock,
            "fastener_standard": standard,
            "fastener_items": fastener_items,
            "fastener_qty": fastener_stock,
        },
        "bom": bom,
        "project": proj,
    }


# ---------------------------------------------------------------- one action
def _slug(value: str) -> str:
    return hq_drawings.sanitize_base_name(value or "piece") or "piece"


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def manufacture(intent: Any, out_dir: Path | str, *, root: Path | str | None = None,
                overrides: dict[str, str] | None = None, material: str | None = None,
                orientation: str | None = None, quantity: int | None = None,
                min_wall_mm: float | None = None, overhang_deg: float | None = None,
                project: str | None = None, require_dfm: bool = True, allow_risky: bool = False,
                name: str | None = None) -> dict:
    """One action: intent -> validated v6 document -> DFM + STL/STEP/PDF + BOM context."""
    built = build_document(intent)
    spec = built["spec"]
    if material:
        spec["material"] = _normal_material(material)
        spec["assumed"]["material"] = False
    if orientation:
        spec["print_orientation"] = _normal_orientation(orientation)
        spec["assumed"]["orientation"] = False
    if quantity:
        spec["quantity"] = int(quantity)
        spec["assumed"]["quantity"] = False
    if min_wall_mm is not None:
        spec["min_wall_mm"] = _number(min_wall_mm, "Épaisseur minimale", lo=0.05, hi=100)
        spec["assumed"]["min_wall"] = False
    if overhang_deg is not None:
        spec["overhang_deg"] = _number(overhang_deg, "Angle de surplomb", lo=1, hi=89)
    doc = built["doc"]
    doc["assumptions"] = _assumptions(spec)
    # Revalidate after the assumption text changed, then apply each requested parameter edit normally.
    doc = hq_drawings.validate_document(doc, build=False)
    current = {"doc": doc, "shape": built["shape"], "mesh": built["mesh"], "solid": built["solid"]}
    for key, expr in (overrides or {}).items():
        current = set_parameter(current["doc"], key, str(expr))
    doc, shape, mesh, solid = current["doc"], current["shape"], current["mesh"], current["solid"]
    values = hq_params.parameter_values(doc)
    for key in ("width", "depth", "height", "thickness", "hole_inset", "fillet_radius",
                "boss_inset", "boss_diameter", "boss_height"):
        if key in values:
            spec[key] = values[key]
    dfm = hq_dfm.analyze(doc, mesh, bounds=solid["bounds"], orientation=spec["print_orientation"],
                         min_wall_mm=spec["min_wall_mm"], overhang_deg=spec["overhang_deg"],
                         required_fit=spec["hole_fit"], valid=solid["valid"])
    dfm["validity"].update({"solids": solid["solids"], "volume_mm3": round(solid["volume_mm3"], 3)})
    stem = _slug(name or spec.get("name") or "piece")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    context = manufacturing_context(doc, solid, root=root, material=spec["material"],
                                     quantity=spec["quantity"], project=project)
    report = {
        "ok": bool(dfm["ok"]),
        "name": stem,
        "spec": {k: v for k, v in spec.items() if k not in ("assumed",)},
        "document": doc,
        "solid": {**solid, "volume_mm3": round(solid["volume_mm3"], 3)},
        "dfm": dfm,
        "assumptions": doc.get("assumptions") or [],
        "manufacturing": context,
        "artifacts": {},
    }
    if not dfm["ok"] and require_dfm and not allow_risky:
        report_path = out / f"{stem}.dfm.json"
        _write(report_path, (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        report["artifacts"] = {"dfm": str(report_path)}
        reasons = []
        if not dfm["wall"]["pass"]:
            reasons.append(f"paroi {dfm['wall']['measured_mm']} mm < {dfm['wall']['required_mm']} mm")
        if not dfm["holes"]["ok"]:
            reasons.append("trous hors norme")
        if not dfm["validity"]["brep_valid"] or not dfm["validity"]["watertight"]:
            reasons.append("solide invalide")
        raise ManufacturingError("Pièce non imprimable : " + ", ".join(reasons or ["contrôle DFM échoué"]), report)
    stl = hq_solid.binary_stl(mesh, doc["units"])
    step = hq_solid_occ.step_bytes(doc)
    stock_short = {"available": "ok", "missing": "manque", "unknown": "?"}.get(context["stock"]["status"], "?")
    fastener_count = sum(len(f.get("at") or []) for f in doc["features"] if f.get("type") == "hole")
    fastener_note = (f" · {fastener_count}x{context['stock']['fastener_standard']}"
                     if context["stock"]["fastener_standard"] and fastener_count else "")
    note = (f"BOM {context['mass_g']:.0f} g {spec['material']} {context['cost']:.2f} {context['currency']}"
            f"{fastener_note} · stock {stock_short} · support {'oui' if dfm['overhang']['needs_support'] else 'non'}")
    pdf = hq_drawings.build_pdf(doc, name=stem, material=spec["material"], note=note)
    doc_out = copy.deepcopy(doc)
    doc_out["meta"] = {
        "stem": stem, "name": stem, "source": "intent", "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "files": {"stl": stem + ".stl", "step": stem + ".step", "pdf": stem + ".pdf", "dfm": stem + ".dfm.json"},
    }
    paths = {
        "document": out / f"{stem}.hqdraw.json",
        "stl": out / f"{stem}.stl",
        "step": out / f"{stem}.step",
        "pdf": out / f"{stem}.pdf",
        "dfm": out / f"{stem}.dfm.json",
    }
    _write(paths["document"], (json.dumps(doc_out, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    _write(paths["stl"], stl)
    _write(paths["step"], step)
    _write(paths["pdf"], pdf)
    if len(stl) < 84 or int.from_bytes(stl[80:84], "little") <= 0:
        raise IntentError("STL vide")
    if not step.startswith(b"ISO-10303-21"):
        raise IntentError("STEP invalide")
    if not pdf.startswith(b"%PDF"):
        raise IntentError("PDF invalide")
    report["artifacts"] = {k: str(v) for k, v in paths.items()}
    _write(paths["dfm"], (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    return report


def summary(report: dict) -> dict:
    m = report.get("manufacturing") or {}
    d = report.get("dfm") or {}
    return {
        "ok": report.get("ok"),
        "name": report.get("name"),
        "parameters": {p["name"]: p["expr"] for p in report.get("document", {}).get("params") or []},
        "solid": {k: report.get("solid", {}).get(k) for k in ("volume_mm3", "triangles", "solids", "valid")},
        "dfm": {
            "printable": d.get("printable"),
            "wall_mm": (d.get("wall") or {}).get("measured_mm"),
            "wall_required_mm": (d.get("wall") or {}).get("required_mm"),
            "holes": (d.get("holes") or {}).get("count"),
            "hole_check": (d.get("holes") or {}).get("ok"),
            "support": (d.get("overhang") or {}).get("needs_support"),
            "overhang_mm2": (d.get("overhang") or {}).get("area_mm2"),
        },
        "manufacturing": {k: m.get(k) for k in ("material", "mass_g", "filament_m", "price_per_kg", "cost", "currency")},
        "stock": m.get("stock"),
        "bom": m.get("bom"),
        "assumptions": report.get("assumptions"),
        "artifacts": report.get("artifacts"),
    }


def main(argv: list[str] | None = None) -> int:
    try:  # the Windows console is often cp1252; report text is UTF-8 like the rest of HQ
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    parser = argparse.ArgumentParser(description="Dessiner intent -> plaque/équerre L/bossages -> v6 document + STL/STEP/PDF + DFM")
    parser.add_argument("intent", nargs="?", help="natural-language part intent")
    parser.add_argument("--spec", help="JSON structured specification")
    parser.add_argument("--out", default="artifacts/intent", help="output directory")
    parser.add_argument("--name", help="base name for the artifacts")
    parser.add_argument("--root", default=".", help="HQ root for print3d / inventory / project context")
    parser.add_argument("--material")
    parser.add_argument("--orientation")
    parser.add_argument("--quantity", type=int)
    parser.add_argument("--min-wall", type=float)
    parser.add_argument("--overhang", type=float)
    parser.add_argument("--project", help="project id or name whose BOM is included")
    parser.add_argument("--set", action="append", default=[], metavar="NAME=EXPR", help="parameter override, e.g. thickness=8")
    parser.add_argument("--allow-risky", action="store_true", help="write artifacts even when DFM fails")
    args = parser.parse_args(argv)
    if bool(args.intent) == bool(args.spec):
        parser.error("fournir une intention ou --spec (un seul)")
    try:
        intent = json.loads(Path(args.spec).read_text(encoding="utf-8")) if args.spec else args.intent
        overrides = {}
        for item in args.set:
            if "=" not in item:
                parser.error("--set attend NAME=EXPR")
            key, expr = item.split("=", 1)
            overrides[key.strip()] = expr.strip()
        report = manufacture(intent, args.out, root=args.root, overrides=overrides, material=args.material,
                             orientation=args.orientation, quantity=args.quantity, min_wall_mm=args.min_wall,
                             overhang_deg=args.overhang, project=args.project, allow_risky=args.allow_risky,
                             name=args.name)
        print(json.dumps(summary(report), ensure_ascii=False, indent=2))
        return 0
    except (IntentError, hq_drawings.DrawingError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
