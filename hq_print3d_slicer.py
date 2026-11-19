"""OrcaSlicer / Bambu Studio / Flashforge preset resolution and printer capabilities.

Pure-stdlib module imported by ``hq_print3d_models`` (no import cycle back to
``hq_print3d`` or ``iphone_bridge``). Resolves complete vendor ``machine``,
``process``, and ``filament`` inheritance chains and emits self-contained
``"from": "User"`` configuration JSONs for headless ``orca-slicer`` runs.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
from typing import Any


class SlicerConfigError(ValueError):
    """Configuration or compatibility failure mapped cleanly by ModelError."""

    def __init__(self, message: str, status: int = 422, code: str = "unsupported") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


CANONICAL_PROFILES: dict[str, dict[str, Any]] = {
    "A1": {
        "model": "A1",
        "kind": "bambu",
        "vendor_model": "Bambu Lab A1",
        "model_id": "N2S",
        "dialect": "bambu",
        "bed": (256.0, 256.0, 256.0),
        "origin": (0.0, 0.0),
        "travel_box": (-50.0, 270.0, -5.0, 265.0, -6.0, 258.0),
        "max_nozzle_temp": 300.0,
        "max_bed_temp": 100.0,
        "physical_extruders": 1,
        "max_tools": 4,
        "station_kind": "ams_lite",
        "supports_prime_tower": True,
        "nozzles": ("0.2", "0.4", "0.6", "0.8"),
        "default_nozzle": "0.4",
    },
    "A1 mini": {
        "model": "A1 mini",
        "kind": "bambu",
        "vendor_model": "Bambu Lab A1 mini",
        "model_id": "N1",
        "dialect": "bambu",
        "bed": (180.0, 180.0, 180.0),
        "origin": (0.0, 0.0),
        "travel_box": (-32.0, 190.0, -5.0, 188.0, -2.0, 182.0),
        "max_nozzle_temp": 300.0,
        "max_bed_temp": 80.0,
        "physical_extruders": 1,
        "max_tools": 4,
        "station_kind": "ams_lite",
        "supports_prime_tower": True,
        "nozzles": ("0.2", "0.4", "0.6", "0.8"),
        "default_nozzle": "0.4",
    },
    "P1S": {
        "model": "P1S",
        "kind": "bambu",
        "vendor_model": "Bambu Lab P1S",
        "model_id": "C12",
        "dialect": "bambu",
        "bed": (256.0, 256.0, 256.0),
        "origin": (0.0, 0.0),
        "travel_box": (-5.0, 261.0, -5.0, 268.0, -2.0, 258.0),
        "max_nozzle_temp": 300.0,
        "max_bed_temp": 100.0,
        "physical_extruders": 1,
        "max_tools": 16,
        "station_kind": "ams",
        "supports_prime_tower": True,
        "nozzles": ("0.2", "0.4", "0.6", "0.8"),
        "default_nozzle": "0.4",
    },
    "X1C": {
        "model": "X1C",
        "kind": "bambu",
        "vendor_model": "Bambu Lab X1 Carbon",
        "model_id": "BL-P001",
        "dialect": "bambu",
        "bed": (256.0, 256.0, 256.0),
        "origin": (0.0, 0.0),
        "travel_box": (-5.0, 261.0, -5.0, 268.0, -2.0, 258.0),
        "max_nozzle_temp": 300.0,
        "max_bed_temp": 110.0,
        "physical_extruders": 1,
        "max_tools": 16,
        "station_kind": "ams",
        "supports_prime_tower": True,
        "nozzles": ("0.2", "0.4", "0.6", "0.8"),
        "default_nozzle": "0.4",
    },
    "Creator 5": {
        "model": "Creator 5",
        "kind": "flashforge",
        "vendor_model": "Flashforge Creator 5",
        "model_id": "",
        "dialect": "marlin_ff",
        "bed": (256.0, 256.0, 256.0),
        "origin": (0.0, 0.0),
        "travel_box": (-5.0, 261.0, -5.0, 261.0, -2.0, 258.0),
        "max_nozzle_temp": 280.0,
        "max_bed_temp": 110.0,
        "physical_extruders": 4,
        "max_tools": 4,
        "station_kind": "physical_toolheads",
        "supports_prime_tower": True,
        "nozzles": ("0.4", "0.6", "0.8"),
        "default_nozzle": "0.4",
    },
    "AD5X": {
        "model": "AD5X",
        "kind": "flashforge",
        "vendor_model": "Flashforge AD5X",
        "model_id": "",
        "dialect": "klipper_ff",
        "bed": (220.0, 220.0, 220.0),
        "origin": (0.0, 0.0),
        "travel_box": (-5.0, 225.0, -5.0, 225.0, -2.0, 222.0),
        "max_nozzle_temp": 280.0,
        "max_bed_temp": 110.0,
        "physical_extruders": 1,
        "max_tools": 4,
        "station_kind": "ifs",
        "supports_prime_tower": True,
        "nozzles": ("0.25", "0.4", "0.6", "0.8"),
        "default_nozzle": "0.4",
    },
    "AD5M": {
        "model": "AD5M",
        "kind": "flashforge",
        "vendor_model": "Flashforge Adventurer 5M",
        "model_id": "",
        "dialect": "klipper_ff",
        "bed": (220.0, 220.0, 220.0),
        "origin": (-110.0, -110.0),
        "travel_box": (-115.0, 115.0, -115.0, 115.0, -2.0, 222.0),
        "max_nozzle_temp": 280.0,
        "max_bed_temp": 110.0,
        "physical_extruders": 1,
        "max_tools": 1,
        "station_kind": "external_spool",
        "supports_prime_tower": False,
        "nozzles": ("0.25", "0.4", "0.6", "0.8"),
        "default_nozzle": "0.4",
    },
}

FAMILY_MODELS: dict[str, tuple[str, ...]] = {
    "bambu": ("A1", "A1 mini", "P1S", "X1C"),
    "flashforge": ("Creator 5", "AD5X", "AD5M"),
}

VENDOR_MODEL_ALIASES: dict[str, str] = {
    "bambu lab a1": "A1",
    "a1": "A1",
    "bambu lab a1 mini": "A1 mini",
    "a1 mini": "A1 mini",
    "bambu lab p1s": "P1S",
    "p1s": "P1S",
    "bambu lab p1p": "P1P",
    "p1p": "P1P",
    "bambu lab x1 carbon": "X1C",
    "x1 carbon": "X1 Carbon",
    "x1c": "X1C",
    "flashforge creator 5": "Creator 5",
    "creator 5": "Creator 5",
    "flashforge ad5x": "AD5X",
    "ad5x": "AD5X",
    "flashforge adventurer 5m": "AD5M",
    "adventurer 5m": "AD5M",
    "ad5m": "AD5M",
}

PLATE_TYPE_MAP: dict[str, str] = {
    "textured_pei": "Textured PEI Plate",
    "textured pei plate": "Textured PEI Plate",
    "smooth_pei": "High Temp Plate",
    "high temp plate": "High Temp Plate",
    "smooth pei plate": "High Temp Plate",
    "cool": "Cool Plate",
    "cool plate": "Cool Plate",
    "engineering": "Engineering Plate",
    "engineering plate": "Engineering Plate",
}

INFILL_PATTERN_MAP: dict[str, str] = {
    "gyroid": "gyroid",
    "grid": "grid",
    "cubic": "cubic",
    "rectilinear": "rectilinear",
    "alignedrectilinear": "alignedrectilinear",
    "honeycomb": "honeycomb",
    "3dhoneycomb": "3dhoneycomb",
    "triangles": "triangles",
    "lightning": "lightning",
    "crosshatch": "crosshatch",
}

SUPPORT_TYPE_MAP: dict[str, str] = {
    "tree": "tree(auto)",
    "tree(auto)": "tree(auto)",
    "normal": "normal(auto)",
    "normal(auto)": "normal(auto)",
}

BRIM_TYPE_MAP: dict[str, str] = {
    "no_brim": "no_brim",
    "outer_only": "outer_only",
    "inner_only": "inner_only",
    "outer_and_inner": "outer_and_inner",
    "auto": "auto_brim",
    "auto_brim": "auto_brim",
}

SEAM_POSITION_MAP: dict[str, str] = {
    "nearest": "nearest",
    "aligned": "aligned",
    "back": "back",
    "random": "random",
}

IRONING_TYPE_MAP: dict[str, str] = {
    "no_ironing": "no ironing",
    "no ironing": "no ironing",
    "none": "no ironing",
    "top": "top",
    "topmost": "topmost",
    "solid": "solid",
}

WALL_GENERATOR_MAP: dict[str, str] = {
    "classic": "classic",
    "arachne": "arachne",
}

QUALITY_PRESETS: tuple[str, ...] = ("draft", "standard", "fine", "custom")
SPEED_PRESET_FACTORS: dict[str, float] = {
    "quiet": 0.65,
    "standard": 1.0,
    "fast": 1.25,
}

# Verified OrcaSlicer 2.5.1.0 per-object Metadata/model_settings.config schema
OBJECT_OVERRIDE_KEYS: tuple[str, ...] = (
    "infill",
    "infill_pattern",
    "wall_loops",
    "top_shell_layers",
    "bottom_shell_layers",
    "supports",
    "support_type",
    "support_on_build_plate_only",
    "seam_position",
    "ironing_type",
    "wall_generator",
    "outer_wall_speed",
    "inner_wall_speed",
    "sparse_infill_speed",
    "brim_type",
    "brim_width",
)

# Authoritative Phase 4A parameter inventory (key -> OrcaSlicer key, unit, requires_reslice)
ADVANCED_PARAM_SCHEMA: dict[str, dict[str, Any]] = {
    "quality_preset": {"orca_key": "(process profile)", "unit": "preset", "requires_reslice": True, "label": "Préréglage qualité"},
    "layer_height": {"orca_key": "layer_height", "unit": "mm", "min": 0.04, "max": 0.68, "requires_reslice": True, "label": "Hauteur de couche"},
    "first_layer_height": {"orca_key": "initial_layer_print_height", "unit": "mm", "min": 0.04, "max": 0.68, "requires_reslice": True, "label": "Première couche"},
    "wall_loops": {"orca_key": "wall_loops", "unit": "parois", "min": 1, "max": 16, "requires_reslice": True, "label": "Parois (boucles)"},
    "top_shell_layers": {"orca_key": "top_shell_layers", "unit": "couches", "min": 0, "max": 30, "requires_reslice": True, "label": "Couches supérieures"},
    "bottom_shell_layers": {"orca_key": "bottom_shell_layers", "unit": "couches", "min": 0, "max": 30, "requires_reslice": True, "label": "Couches inférieures"},
    "infill": {"orca_key": "sparse_infill_density", "unit": "%", "min": 0, "max": 100, "requires_reslice": True, "label": "Remplissage"},
    "infill_pattern": {"orca_key": "sparse_infill_pattern", "unit": "enum", "requires_reslice": True, "label": "Motif remplissage"},
    "seam_position": {"orca_key": "seam_position", "unit": "enum", "requires_reslice": True, "label": "Position couture"},
    "ironing_type": {"orca_key": "ironing_type", "unit": "enum", "requires_reslice": True, "label": "Repassage"},
    "wall_generator": {"orca_key": "wall_generator", "unit": "enum", "requires_reslice": True, "label": "Générateur de parois"},
    "speed_preset": {"orca_key": "(scaled speeds)", "unit": "preset", "requires_reslice": True, "label": "Mode vitesse"},
    "outer_wall_speed": {"orca_key": "outer_wall_speed", "unit": "mm/s", "min": 10, "max": 600, "requires_reslice": True, "label": "Vitesse paroi ext."},
    "inner_wall_speed": {"orca_key": "inner_wall_speed", "unit": "mm/s", "min": 10, "max": 600, "requires_reslice": True, "label": "Vitesse paroi int."},
    "sparse_infill_speed": {"orca_key": "sparse_infill_speed", "unit": "mm/s", "min": 10, "max": 600, "requires_reslice": True, "label": "Vitesse remplissage"},
    "initial_layer_speed": {"orca_key": "initial_layer_speed", "unit": "mm/s", "min": 5, "max": 200, "requires_reslice": True, "label": "Vitesse 1re couche"},
    "travel_speed": {"orca_key": "travel_speed", "unit": "mm/s", "min": 20, "max": 1000, "requires_reslice": True, "label": "Vitesse déplacement"},
    "default_acceleration": {"orca_key": "default_acceleration", "unit": "mm/s²", "min": 200, "max": 30000, "requires_reslice": True, "label": "Accélération par défaut"},
    "outer_wall_acceleration": {"orca_key": "outer_wall_acceleration", "unit": "mm/s²", "min": 200, "max": 25000, "requires_reslice": True, "label": "Accélération paroi ext."},
    "supports": {"orca_key": "enable_support", "unit": "bool", "requires_reslice": True, "label": "Supports"},
    "support_type": {"orca_key": "support_type", "unit": "enum", "requires_reslice": True, "label": "Type de support"},
    "support_on_build_plate_only": {"orca_key": "support_on_build_plate_only", "unit": "bool", "requires_reslice": True, "label": "Sur plateau uniquement"},
    "support_threshold_angle": {"orca_key": "support_threshold_angle", "unit": "°", "min": 5, "max": 80, "requires_reslice": True, "label": "Angle porte-à-faux"},
    "support_base_pattern_spacing": {"orca_key": "support_base_pattern_spacing", "unit": "mm", "min": 0.5, "max": 10.0, "requires_reslice": True, "label": "Espacement supports"},
    "support_interface_top_layers": {"orca_key": "support_interface_top_layers", "unit": "couches", "min": 0, "max": 6, "requires_reslice": True, "label": "Couches interface support"},
    "support_interface_filament": {"orca_key": "support_interface_filament", "unit": "outil (0=auto)", "min": 0, "max": 16, "requires_reslice": True, "label": "Outil interface support"},
    "brim": {"orca_key": "brim_type", "unit": "bool", "requires_reslice": True, "label": "Bordure (Brim)"},
    "brim_type": {"orca_key": "brim_type", "unit": "enum", "requires_reslice": True, "label": "Type de bordure"},
    "brim_width": {"orca_key": "brim_width", "unit": "mm", "min": 0.0, "max": 30.0, "requires_reslice": True, "label": "Largeur bordure"},
    "skirt_loops": {"orca_key": "skirt_loops", "unit": "tours", "min": 0, "max": 10, "requires_reslice": True, "label": "Jupe (boucles)"},
    "raft_layers": {"orca_key": "raft_layers", "unit": "couches", "min": 0, "max": 6, "requires_reslice": True, "label": "Radeau (couches)"},
    "nozzle_temperature_initial_layer": {"orca_key": "nozzle_temperature_initial_layer", "unit": "°C", "min": 150, "max": 320, "requires_reslice": True, "label": "Temp. buse 1re couche"},
    "nozzle_temperature": {"orca_key": "nozzle_temperature", "unit": "°C", "min": 150, "max": 320, "requires_reslice": True, "label": "Temp. buse autres couches"},
    "bed_temperature_initial_layer": {"orca_key": "*_plate_temp_initial_layer", "unit": "°C", "min": 0, "max": 120, "requires_reslice": True, "label": "Temp. plateau 1re couche"},
    "bed_temperature": {"orca_key": "*_plate_temp", "unit": "°C", "min": 0, "max": 120, "requires_reslice": True, "label": "Temp. plateau autres couches"},
    "fan_min_speed": {"orca_key": "fan_min_speed", "unit": "%", "min": 0, "max": 100, "requires_reslice": True, "label": "Ventilateur min."},
    "fan_max_speed": {"orca_key": "fan_max_speed", "unit": "%", "min": 0, "max": 100, "requires_reslice": True, "label": "Ventilateur max."},
    "close_fan_the_first_x_layers": {"orca_key": "close_fan_the_first_x_layers", "unit": "couches", "min": 0, "max": 10, "requires_reslice": True, "label": "Couches sans ventilateur"},
    "filament_max_volumetric_speed": {"orca_key": "filament_max_volumetric_speed", "unit": "mm³/s", "min": 0.5, "max": 50.0, "requires_reslice": True, "label": "Débit volumique max."},
    "prime_tower_enabled": {"orca_key": "enable_prime_tower", "unit": "bool", "requires_reslice": True, "label": "Tour de purge"},
    "prime_tower_width": {"orca_key": "prime_tower_width", "unit": "mm", "min": 10.0, "max": 80.0, "requires_reslice": True, "label": "Largeur tour de purge"},
    "prime_tower_x": {"orca_key": "wipe_tower_x", "unit": "mm", "requires_reslice": True, "label": "Position X tour"},
    "prime_tower_y": {"orca_key": "wipe_tower_y", "unit": "mm", "requires_reslice": True, "label": "Position Y tour"},
    "flush_multiplier": {"orca_key": "prime_volume", "unit": "facteur", "min": 0.0, "max": 2.0, "requires_reslice": True, "label": "Multiplicateur purge"},
    "flush_into_infill": {"orca_key": "flush_into_infill", "unit": "bool", "requires_reslice": True, "label": "Purger dans remplissage"},
    "flush_into_support": {"orca_key": "flush_into_support", "unit": "bool", "requires_reslice": True, "label": "Purger dans supports"},
}

_TEMPLATE_GCODE_KEYS = (
    "machine_start_gcode",
    "machine_end_gcode",
    "layer_change_gcode",
    "before_layer_change_gcode",
    "change_filament_gcode",
    "time_lapse_gcode",
)

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def resolve_vendor_model_name(raw: str) -> str:
    """Map an OrcaSlicer/Bambu ``project_settings.config`` printer_model to a local key."""
    key = str(raw or "").strip().casefold()
    return VENDOR_MODEL_ALIASES.get(key, "")


def printer_capabilities(model: str) -> dict[str, Any]:
    """Serialisable printer capabilities exported to ``public_config()`` and Studio."""
    row = CANONICAL_PROFILES.get(str(model or "").strip())
    if not row:
        return {}
    bx, by, bz = row["bed"]
    ox, oy = row["origin"]
    return {
        "model": row["model"],
        "kind": row["kind"],
        "bed": {"x": bx, "y": by, "z": bz},
        "origin": {"x": ox, "y": oy},
        "nozzles": list(row["nozzles"]),
        "default_nozzle": row["default_nozzle"],
        "physical_extruders": int(row["physical_extruders"]),
        "max_tools": int(row["max_tools"]),
        "station_kind": str(row.get("station_kind") or "external_spool"),
        "supports_prime_tower": bool(row.get("supports_prime_tower", int(row["max_tools"]) > 1)),
        "max_nozzle_temp": float(row["max_nozzle_temp"]),
        "max_bed_temp": float(row["max_bed_temp"]),
        "dialect": row["dialect"],
    }


def printer_catalog() -> dict[str, dict[str, Any]]:
    """Catalog of every supported canonical printer model keyed by name."""
    return {k: printer_capabilities(k) for k in CANONICAL_PROFILES}


def _normalize_nozzle(value: Any, default: str = "0.4") -> str:
    raw = str(value if value not in (None, "") else default).strip()
    try:
        num = float(raw)
    except ValueError:
        raise SlicerConfigError(f"Diamètre de buse invalide : {raw}") from None
    if num <= 0 or num > 2.0:
        raise SlicerConfigError(f"Diamètre de buse hors limites : {raw}")
    txt = f"{num:.2f}".rstrip("0").rstrip(".")
    return txt


def discover_profile_roots(kind: str, slicer_path: str = "",
                           profile_roots: list[Path] | tuple[Path, ...] | None = None) -> list[Path]:
    """Return existing vendor profile root directories for ``kind`` (or test overrides)."""
    if profile_roots is not None:
        return [Path(p) for p in profile_roots if Path(p).is_dir()]
    appdata = Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming"))
    orca_sys = appdata / "OrcaSlicer" / "system"
    candidates: list[Path] = []
    if kind == "bambu":
        candidates.extend([
            orca_sys / "BBL",
            Path(r"C:\Program Files\Bambu Studio\resources\profiles\BBL"),
            Path(r"C:\Program Files (x86)\Bambu Studio\resources\profiles\BBL"),
        ])
    elif kind == "flashforge":
        candidates.extend([
            orca_sys / "Flashforge",
            Path(r"C:\Program Files\Flashforge\Flash Studio Desktop\resources\profiles\Flashforge"),
            Path(r"C:\Program Files\Orca-Flashforge\resources\profiles\Flashforge"),
        ])
    if slicer_path:
        sdir = Path(slicer_path).resolve().parent
        sub = "BBL" if kind == "bambu" else "Flashforge"
        candidates.append(sdir / "resources" / "profiles" / sub)
        candidates.append(sdir / "resources" / "profiles" / "OrcaFilamentLibrary")
    candidates.append(orca_sys / "OrcaFilamentLibrary")
    out: list[Path] = []
    seen: set[Path] = set()
    for p in candidates:
        try:
            rp = p.resolve(strict=True)
        except OSError:
            continue
        if rp.is_dir() and rp not in seen:
            seen.add(rp)
            out.append(rp)
    return out


class _PresetIndex:
    """In-memory index over vendor ``machine``, ``process``, and ``filament`` JSONs."""

    def __init__(self, roots: list[Path]) -> None:
        self.categories: dict[str, dict[str, tuple[Path, dict[str, Any]]]] = {
            "machine": {}, "process": {}, "filament": {},
        }
        self.templates: dict[str, dict[str, dict[str, Any]]] = {
            "machine": {}, "process": {}, "filament": {},
        }
        for root in roots:
            for cat in ("machine", "process", "filament"):
                cdir = root / cat
                if not cdir.is_dir():
                    continue
                for path in sorted(cdir.rglob("*.json")):
                    if path.is_symlink():
                        continue
                    try:
                        data = json.loads(path.read_text(encoding="utf-8"))
                    except json.JSONDecodeError as exc:
                        raise SlicerConfigError(
                            f"Profil JSON invalide ({path.name}) : {exc.msg}", 422, "invalid_profile"
                        ) from None
                    except OSError:
                        continue
                    if not isinstance(data, dict):
                        continue
                    if " template " in path.stem:
                        base_stem, _, _ = path.stem.partition(" template ")
                        bucket = self.templates[cat].setdefault(base_stem, {})
                        for k in _TEMPLATE_GCODE_KEYS:
                            if k in data and isinstance(data[k], str):
                                bucket[k] = data[k]
                        continue
                    name = str(data.get("name") or "").strip()
                    if not name:
                        continue
                    if name not in self.categories[cat]:
                        self.categories[cat][name] = (path, data)

    def flatten(self, category: str, name: str) -> dict[str, Any]:
        """Resolve full ``inherits`` chain for ``name`` and emit a ``User`` preset."""
        table = self.categories[category]
        if name not in table:
            raise SlicerConfigError(f"Profil {category} introuvable : {name}", 422, "invalid_profile")
        chain: list[tuple[Path, dict[str, Any]]] = []
        seen: set[str] = set()
        cur: str | None = name
        while cur:
            if cur in seen:
                raise SlicerConfigError(f"Cycle d'héritage détecté ({category}: {cur})", 422, "invalid_profile")
            seen.add(cur)
            entry = table.get(cur)
            if entry is None:
                raise SlicerConfigError(
                    f"Profil parent manquant ({category}: {cur} requis par {name})",
                    422, "invalid_profile",
                )
            chain.append(entry)
            parent = entry[1].get("inherits")
            cur = str(parent).strip() if parent else None
        merged: dict[str, Any] = {}
        for _, data in reversed(chain):
            merged.update(data)
        leaf_path, _leaf_raw = chain[0]
        tmpl = self.templates[category].get(leaf_path.stem)
        if not tmpl and category == "machine":
            sib_stem = re.sub(r"\s+\d+(?:\.\d+)?\s+nozzle$", " 0.4 nozzle", leaf_path.stem, flags=re.I)
            if sib_stem != leaf_path.stem:
                tmpl = self.templates[category].get(sib_stem)
        if tmpl:
            merged.update(tmpl)
        merged.pop("inherits", None)
        merged["from"] = "User"
        merged["type"] = category
        return merged


def _select_machine(idx: _PresetIndex, profile: dict[str, Any], nozzle: str) -> tuple[str, dict[str, Any]]:
    vendor_model = profile["vendor_model"]
    candidates: list[tuple[int, str, dict[str, Any]]] = []
    for name, (_p, raw) in idx.categories["machine"].items():
        if raw.get("type") != "machine":
            continue
        pm = str(raw.get("printer_model") or "").strip()
        if pm.casefold() != vendor_model.casefold():
            continue
        nd = raw.get("nozzle_diameter") or []
        nd_vals = [str(v).strip() for v in nd] if isinstance(nd, list) else [str(nd).strip()]
        if not nd_vals:
            continue
        try:
            n0 = _normalize_nozzle(nd_vals[0])
        except SlicerConfigError:
            continue
        if n0 != nozzle:
            continue
        score = 0
        if " hf " in name.casefold():
            score += 10
        if name.casefold().endswith(f"{nozzle} nozzle"):
            score -= 5
        candidates.append((score, name, raw))
    if not candidates:
        raise SlicerConfigError(
            f"Aucun profil machine trouvé pour {profile['model']} ({nozzle} mm)",
            422, "invalid_profile",
        )
    candidates.sort(key=lambda item: (item[0], item[1]))
    chosen_name = candidates[0][1]
    flat = idx.flatten("machine", chosen_name)
    flat_pm = str(flat.get("printer_model") or "").strip()
    if flat_pm.casefold() != vendor_model.casefold():
        raise SlicerConfigError(
            f"Profil machine incohérent ({flat_pm} != {vendor_model})", 422, "invalid_profile"
        )
    return chosen_name, flat


def _is_compatible(preset: dict[str, Any], machine_name: str) -> bool:
    comp = preset.get("compatible_printers")
    if comp is None:
        return True
    if not isinstance(comp, list):
        return False
    target = machine_name.casefold()
    return any(str(item).strip().casefold() == target for item in comp)


def _select_process(idx: _PresetIndex, machine_name: str, machine_flat: dict[str, Any],
                    layer_height: float | None) -> tuple[str, dict[str, Any]]:
    target_lh = f"{round(float(layer_height), 2):.2f}mm" if layer_height is not None else None
    default_proc = str(machine_flat.get("default_print_profile") or "").strip()
    candidates: list[tuple[int, str]] = []
    for name, (_p, raw) in idx.categories["process"].items():
        if raw.get("type") not in (None, "process"):
            continue
        if raw.get("instantiation") == "false":
            continue
        if not _is_compatible(raw, machine_name):
            continue
        score = 50
        low = name.casefold()
        if "standard" in low:
            score -= 20
        if target_lh and target_lh in low:
            score -= 15
        if default_proc and name == default_proc:
            score -= 10
        if low.startswith("0.20mm"):
            score -= 5
        candidates.append((score, name))
    if not candidates and default_proc and default_proc in idx.categories["process"]:
        candidates.append((100, default_proc))
    if not candidates:
        raise SlicerConfigError(
            f"Aucun profil de processus compatible trouvé pour {machine_name}",
            422, "invalid_profile",
        )
    candidates.sort(key=lambda item: (item[0], item[1]))
    chosen_name = candidates[0][1]
    return chosen_name, idx.flatten("process", chosen_name)


def _match_material(ft: str, wanted: str) -> int | None:
    """Return lower=better score if flattened filament_type ``ft`` matches ``wanted``."""
    f_up = ft.strip().upper()
    w_up = wanted.strip().upper()
    if not f_up or not w_up:
        return None
    if f_up == w_up:
        return 0
    if w_up == "TPU" and (f_up.startswith("TPU-") or f_up.startswith("TPU ")):
        return 5
    return None


def _select_filament(idx: _PresetIndex, machine_name: str, material: str,
                     nozzle: str, explicit_preset: str | None = None) -> tuple[str, dict[str, Any]]:
    wanted = str(material or "PLA").strip()
    if explicit_preset:
        pname = str(explicit_preset).strip()
        entry = idx.categories["filament"].get(pname)
        if not entry:
            raise SlicerConfigError(f"Profil filament introuvable : {pname}", 422, "invalid_profile")
        _p, raw = entry
        if raw.get("type") not in (None, "filament") or not _is_compatible(raw, machine_name):
            raise SlicerConfigError(f"Profil filament '{pname}' incompatible avec {machine_name}", 422, "unsupported")
        flat = idx.flatten("filament", pname)
        ft_val = flat.get("filament_type")
        ft_str = str(ft_val[0] if isinstance(ft_val, list) and ft_val else (ft_val or "")).strip()
        if wanted and _match_material(ft_str, wanted) is None:
            raise SlicerConfigError(
                f"Profil filament '{pname}' ({ft_str or '?'}) ne correspond pas au matériau '{wanted}'",
                422, "unsupported",
            )
        return pname, flat
    candidates: list[tuple[int, str, dict[str, Any]]] = []
    for name, (_p, raw) in idx.categories["filament"].items():
        if raw.get("type") not in (None, "filament"):
            continue
        if raw.get("instantiation") == "false":
            continue
        if not _is_compatible(raw, machine_name):
            continue
        try:
            flat = idx.flatten("filament", name)
        except SlicerConfigError:
            continue
        ft_val = flat.get("filament_type")
        ft_str = str(ft_val[0] if isinstance(ft_val, list) and ft_val else (ft_val or "")).strip()
        m_score = _match_material(ft_str, wanted)
        if m_score is None:
            continue
        low = name.casefold()
        score = m_score
        if "basic" in low or "generic" in low:
            score -= 10
        if f"{nozzle} nozzle".casefold() in low:
            score -= 4
        for penalty in ("aero", "silk", "matte", "sparkle", "galaxy", "metal", "wood", "marble", "-cf", "-gf"):
            if penalty in low:
                score += 20
        candidates.append((score, name, flat))
    if not candidates:
        raise SlicerConfigError(
            f"Matériau '{wanted}' non supporté ou sans profil compatible pour {machine_name}",
            422, "unsupported",
        )
    candidates.sort(key=lambda item: (item[0], item[1]))
    return candidates[0][1], candidates[0][2]


def _first_float(value: Any) -> float | None:
    v = value[0] if isinstance(value, list) and value else value
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _set_cfg_value(target: dict[str, Any], key: str, value_str: str) -> None:
    """Assign an OrcaSlicer JSON field preserving original string-vs-list shape."""
    if isinstance(target.get(key), list):
        target[key] = [value_str]
    else:
        target[key] = value_str


def _parse_int_bound(raw: Any, label: str, lo: int, hi: int) -> int:
    if isinstance(raw, bool):
        raise SlicerConfigError(f"{label} invalide : booléen inattendu", 422, "unsupported")
    try:
        fv = float(raw)
    except (TypeError, ValueError):
        raise SlicerConfigError(f"{label} invalide : {raw}", 422, "unsupported") from None
    if not math.isfinite(fv) or abs(fv - round(fv)) > 1e-4:
        raise SlicerConfigError(f"{label} doit être entier : {raw}", 422, "unsupported")
    iv = int(round(fv))
    if iv < lo or iv > hi:
        raise SlicerConfigError(f"{label} hors limites ({iv}, autorisé {lo}–{hi})", 422, "unsupported")
    return iv


def _parse_float_bound(raw: Any, label: str, lo: float, hi: float) -> float:
    if isinstance(raw, bool):
        raise SlicerConfigError(f"{label} invalide", 422, "unsupported")
    try:
        fv = float(raw)
    except (TypeError, ValueError):
        raise SlicerConfigError(f"{label} invalide : {raw}", 422, "unsupported") from None
    if not math.isfinite(fv) or fv < lo - 1e-6 or fv > hi + 1e-6:
        raise SlicerConfigError(f"{label} hors limites ({fv:g}, autorisé {lo:g}–{hi:g})", 422, "unsupported")
    return fv


def _clean_opt(val: Any) -> Any:
    return None if val in (None, "") else val


def quality_preset_defaults(nozzle: Any, preset: str = "standard") -> dict[str, Any]:
    """Compute nozzle-compatible baseline quality settings for draft/standard/fine."""
    noz_str = _normalize_nozzle(nozzle, default="0.4")
    d = float(noz_str)
    key = str(preset or "standard").strip().casefold()
    if key not in QUALITY_PRESETS:
        raise SlicerConfigError(f"Préréglage qualité inconnu : {preset}", 422, "unsupported")
    min_lh = max(0.04, round(d * 0.2, 2))
    max_lh = round(d * 0.75, 2)
    def clamp_lh(v: float) -> float:
        return round(max(min_lh, min(max_lh, v)), 2)

    if key == "draft":
        return {
            "quality_preset": "draft",
            "layer_height": clamp_lh(d * 0.70),
            "first_layer_height": clamp_lh(d * 0.60),
            "wall_loops": 2,
            "top_shell_layers": 4,
            "bottom_shell_layers": 3,
            "infill": 12,
        }
    if key == "fine":
        return {
            "quality_preset": "fine",
            "layer_height": clamp_lh(d * 0.30),
            "first_layer_height": clamp_lh(d * 0.45),
            "wall_loops": 3,
            "top_shell_layers": 6,
            "bottom_shell_layers": 4,
            "infill": 20,
        }
    return {
        "quality_preset": "standard" if key != "custom" else "custom",
        "layer_height": clamp_lh(d * 0.50),
        "first_layer_height": clamp_lh(d * 0.50),
        "wall_loops": 2,
        "top_shell_layers": 5,
        "bottom_shell_layers": 3,
        "infill": 15,
    }


def validate_and_normalize_object_overrides(
    raw: Any,
    profile: dict[str, Any] | None = None,
    machine: dict[str, Any] | None = None,
) -> dict[str, str]:
    """Validate per-object slicing overrides against verified OrcaSlicer 2.5.1 keys."""
    if not isinstance(raw, dict) or not raw:
        return {}
    max_spd_raw = _first_float((machine or {}).get("machine_max_speed_x")) or 600.0
    max_spd = max(100.0, min(1000.0, float(max_spd_raw)))
    out: dict[str, str] = {}
    for k in OBJECT_OVERRIDE_KEYS:
        val = _clean_opt(raw.get(k))
        if val is None:
            continue
        if k == "infill":
            out["sparse_infill_density"] = f"{_parse_int_bound(val, 'Remplissage objet', 0, 100)}%"
        elif k == "infill_pattern":
            pat = INFILL_PATTERN_MAP.get(str(val).strip().casefold())
            if not pat:
                raise SlicerConfigError(f"Motif objet inconnu : {val}", 422, "unsupported")
            out["sparse_infill_pattern"] = pat
        elif k == "wall_loops":
            out["wall_loops"] = str(_parse_int_bound(val, "Parois objet", 1, 16))
        elif k == "top_shell_layers":
            out["top_shell_layers"] = str(_parse_int_bound(val, "Couches hautes objet", 0, 30))
        elif k == "bottom_shell_layers":
            out["bottom_shell_layers"] = str(_parse_int_bound(val, "Couches basses objet", 0, 30))
        elif k == "supports":
            out["enable_support"] = "1" if bool(val) else "0"
        elif k == "support_type":
            st = SUPPORT_TYPE_MAP.get(str(val).strip().casefold())
            if not st:
                raise SlicerConfigError(f"Type support objet inconnu : {val}", 422, "unsupported")
            out["support_type"] = st
        elif k == "support_on_build_plate_only":
            out["support_on_build_plate_only"] = "1" if bool(val) else "0"
        elif k == "seam_position":
            sp = SEAM_POSITION_MAP.get(str(val).strip().casefold())
            if not sp:
                raise SlicerConfigError(f"Couture objet inconnue : {val}", 422, "unsupported")
            out["seam_position"] = sp
        elif k == "ironing_type":
            it_v = IRONING_TYPE_MAP.get(str(val).strip().casefold())
            if not it_v:
                raise SlicerConfigError(f"Repassage objet inconnu : {val}", 422, "unsupported")
            out["ironing_type"] = it_v
        elif k == "wall_generator":
            wg = WALL_GENERATOR_MAP.get(str(val).strip().casefold())
            if not wg:
                raise SlicerConfigError(f"Générateur parois objet inconnu : {val}", 422, "unsupported")
            out["wall_generator"] = wg
        elif k in ("outer_wall_speed", "inner_wall_speed", "sparse_infill_speed"):
            spd = _parse_float_bound(val, f"Vitesse objet ({k})", 10.0, max_spd)
            out[k] = str(int(round(spd)))
        elif k == "brim_type":
            bt = BRIM_TYPE_MAP.get(str(val).strip().casefold())
            if not bt:
                raise SlicerConfigError(f"Bordure objet inconnue : {val}", 422, "unsupported")
            out["brim_type"] = bt
        elif k == "brim_width":
            bw = _parse_float_bound(val, "Largeur bordure objet", 0.0, 30.0)
            out["brim_width"] = f"{bw:g}"
    return out


def _check_plate_compat(filament: dict[str, Any], mat_name: str, bed_enum: str,
                        profile: dict[str, Any]) -> None:
    max_bed = float(profile.get("max_bed_temp") or 110.0)
    if bed_enum == "Cool Plate":
        cool_t = _first_float(filament.get("cool_plate_temp"))
        if cool_t is not None and cool_t <= 0:
            raise SlicerConfigError(
                f"{mat_name} incompatible avec le plateau Cool Plate (consigne plateau {cool_t:.0f}°C)",
                422, "unsupported",
            )
    key_map = {
        "Cool Plate": "cool_plate_temp",
        "High Temp Plate": "hot_plate_temp",
        "Textured PEI Plate": "textured_plate_temp",
        "Engineering Plate": "eng_plate_temp",
    }
    t_key = key_map.get(bed_enum)
    if t_key:
        bed_t = _first_float(filament.get(t_key))
        if bed_t is not None and bed_t > max_bed + 0.1:
            raise SlicerConfigError(
                f"{mat_name} requiert {bed_t:.0f}°C > limite plateau {profile['model']} ({max_bed:.0f}°C)",
                422, "unsupported",
            )


@dataclass
class ResolvedSlicerConfig:
    """Resolved, flattened OrcaSlicer preset bundle ready for CLI execution."""

    profile: dict[str, Any]
    machine_name: str
    process_name: str
    filament_names: list[str]
    machine: dict[str, Any]
    process: dict[str, Any]
    filaments: list[dict[str, Any]]
    bed_type: str
    nozzle: str
    prime_tower_box: tuple[float, float, float, float] | None = None
    quality_preset: str = "standard"
    speed_preset: str = "standard"

    def write_files(self, tmp_dir: Path) -> tuple[list[Path], list[Path]]:
        """Write resolved machine/process/filament JSONs into ``tmp_dir``."""
        m_path = tmp_dir / "resolved_machine.json"
        p_path = tmp_dir / "resolved_process.json"
        m_path.write_text(json.dumps(self.machine), encoding="utf-8")
        p_path.write_text(json.dumps(self.process), encoding="utf-8")
        fil_paths: list[Path] = []
        for idx, fil in enumerate(self.filaments):
            fp = tmp_dir / f"resolved_filament_{idx}.json"
            fp.write_text(json.dumps(fil), encoding="utf-8")
            fil_paths.append(fp)
        return [m_path, p_path], fil_paths


def _list_compatible_filaments(idx: _PresetIndex, machine_name: str) -> list[dict[str, str]]:
    """Return sorted compatible instantiable filament presets for a machine."""
    rows: list[dict[str, str]] = []
    for name, (_p, raw) in idx.categories["filament"].items():
        if raw.get("type") not in (None, "filament") or raw.get("instantiation") == "false":
            continue
        if not _is_compatible(raw, machine_name):
            continue
        try:
            flat = idx.flatten("filament", name)
        except SlicerConfigError:
            continue
        ft_val = flat.get("filament_type")
        ft_str = str(ft_val[0] if isinstance(ft_val, list) and ft_val else (ft_val or "")).strip()
        if not ft_str:
            continue
        rows.append({"name": name, "material": ft_str})
    rows.sort(key=lambda r: (r["material"], r["name"]))
    return rows


def _bed_temp_keys(bed_enum: str) -> tuple[str, str]:
    key_map = {
        "Cool Plate": ("cool_plate_temp_initial_layer", "cool_plate_temp"),
        "High Temp Plate": ("hot_plate_temp_initial_layer", "hot_plate_temp"),
        "Textured PEI Plate": ("textured_plate_temp_initial_layer", "textured_plate_temp"),
        "Engineering Plate": ("eng_plate_temp_initial_layer", "eng_plate_temp"),
    }
    return key_map.get(bed_enum, ("textured_plate_temp_initial_layer", "textured_plate_temp"))


def _compute_prime_tower_box(
    process: dict[str, Any],
    profile: dict[str, Any],
    n_tools: int,
    adv: dict[str, Any],
) -> tuple[float, float, float, float] | None:
    """Validate and resolve prime tower placement box ``(xmin, ymin, xmax, ymax)``."""
    ox, oy = profile.get("origin") or (0.0, 0.0)
    bx, by, _bz = profile["bed"]
    req_enabled = _clean_opt(adv.get("prime_tower_enabled"))
    if req_enabled is not None and not bool(req_enabled):
        process["enable_prime_tower"] = "0"
        return None
    active = (n_tools > 1 and bool(profile.get("supports_prime_tower", True))) or bool(req_enabled)
    if req_enabled and not profile.get("supports_prime_tower", True):
        raise SlicerConfigError(f"Tour de purge non supportée sur {profile['model']}", 422, "unsupported")
    if not active:
        return None
    process["enable_prime_tower"] = "1"
    raw_w = _clean_opt(adv.get("prime_tower_width"))
    w = _parse_float_bound(raw_w if raw_w is not None else (_first_float(process.get("prime_tower_width")) or 35.0),
                           "Largeur tour de purge", 10.0, min(80.0, bx - 4.0))
    process["prime_tower_width"] = f"{w:g}"

    def_x = round(ox + max(w * 0.5 + 8.0, bx * 0.15), 1)
    def_y = round(oy + max(w * 0.5 + 8.0, min(by - w * 0.5 - 8.0, by * 0.65)), 1)
    raw_x = _clean_opt(adv.get("prime_tower_x"))
    raw_y = _clean_opt(adv.get("prime_tower_y"))
    ptx = float(raw_x) if raw_x is not None else def_x
    pty = float(raw_y) if raw_y is not None else def_y
    if not (math.isfinite(ptx) and math.isfinite(pty)):
        raise SlicerConfigError("Coordonnées tour de purge invalides", 422, "unsupported")
    xmin, xmax = ptx, ptx + w
    ymin, ymax = pty, pty + w
    if xmin < ox + 1.0 or xmax > ox + bx - 1.0 or ymin < oy + 1.0 or ymax > oy + by - 1.0:
        raise SlicerConfigError(
            f"Tour de purge ({ptx:.1f}, {pty:.1f}, {w:g} mm) hors du plateau {bx:g}×{by:g} mm",
            422, "prime_tower_out_of_bounds",
        )
    process["wipe_tower_x"] = [str(round(ptx, 1))]
    process["wipe_tower_y"] = [str(round(pty, 1))]
    return (xmin, ymin, xmax, ymax)


def resolve_slicer_config(
    printer_model: str,
    *,
    nozzle: Any = None,
    material: str | None = None,
    tools: list[dict[str, Any]] | None = None,
    used_tool_count: int = 1,
    plate_type: str = "textured_pei",
    quality_preset: str | None = None,
    speed_preset: str | None = None,
    layer_height: float | None = None,
    first_layer_height: float | None = None,
    wall_loops: int | None = None,
    infill: int | None = None,
    infill_pattern: str | None = None,
    supports: bool = False,
    support_type: str | None = None,
    brim: bool = False,
    brim_type: str | None = None,
    advanced: dict[str, Any] | None = None,
    bed_override: tuple[float, float, float] | None = None,
    profile_roots: list[Path] | tuple[Path, ...] | None = None,
    slicer_path: str = "",
) -> ResolvedSlicerConfig:
    """Resolve vendor presets + validated Phase 4 advanced parameters for OrcaSlicer CLI."""
    adv = dict(advanced) if isinstance(advanced, dict) else {}
    q_preset = str(quality_preset or adv.get("quality_preset") or "custom").strip().casefold()
    if q_preset not in QUALITY_PRESETS:
        raise SlicerConfigError(f"Préréglage qualité inconnu : {q_preset}", 422, "unsupported")
    s_preset = str(speed_preset or adv.get("speed_preset") or "standard").strip().casefold()
    if s_preset not in (*SPEED_PRESET_FACTORS.keys(), "custom"):
        raise SlicerConfigError(f"Mode vitesse inconnu : {s_preset}", 422, "unsupported")

    model_key = str(printer_model or "").strip()
    profile_base = CANONICAL_PROFILES.get(model_key)
    if not profile_base:
        raise SlicerConfigError(f"Profil imprimante inconnu ou générique : {model_key}", 422, "unknown_printer_profile")
    profile = dict(profile_base)
    if bed_override and len(bed_override) == 3:
        bx_o, by_o, bz_o = (float(v) for v in bed_override)
        cx_b, cy_b, cz_b = profile_base["bed"]
        if not (math.isfinite(bx_o) and math.isfinite(by_o) and math.isfinite(bz_o)):
            raise SlicerConfigError("Dimensions plateau personnalisées invalides", 422, "validation_error")
        if bx_o < 20.0 or by_o < 20.0 or bz_o < 20.0:
            raise SlicerConfigError("Dimensions plateau personnalisées trop petites (< 20 mm)", 422, "out_of_bounds")
        if bx_o > cx_b + 1e-6 or by_o > cy_b + 1e-6 or bz_o > cz_b + 1e-6:
            raise SlicerConfigError(
                f"Dimensions plateau ({bx_o:g}×{by_o:g}×{bz_o:g} mm) dépassent le volume physique de {model_key} ({cx_b:g}×{cy_b:g}×{cz_b:g} mm)",
                422, "out_of_bounds",
            )
        profile["bed"] = (bx_o, by_o, bz_o)
        ox0, oy0 = profile_base.get("origin") or (0.0, 0.0)
        if ox0 < 0 or oy0 < 0:
            profile["origin"] = (-bx_o / 2.0, -by_o / 2.0)

    noz = _normalize_nozzle(nozzle, default=profile["default_nozzle"])
    if noz not in profile["nozzles"]:
        raise SlicerConfigError(
            f"Buse {noz} mm non supportée sur {model_key} (disponibles : {', '.join(profile['nozzles'])})",
            422, "unsupported",
        )

    plate_key = str(plate_type or "textured_pei").strip().casefold()
    bed_enum = PLATE_TYPE_MAP.get(plate_key)
    if not bed_enum:
        raise SlicerConfigError(f"Type de plateau inconnu : {plate_type}", 422, "unsupported")

    max_tools = int(profile["max_tools"])
    n_tools = max(1, int(used_tool_count))
    if n_tools > max_tools:
        raise SlicerConfigError(
            f"{model_key} supporte au maximum {max_tools} outil(s)/emplacement(s) (demandé : {n_tools})",
            422, "tool_out_of_range",
        )

    q_defaults = quality_preset_defaults(noz, q_preset) if q_preset != "custom" else {}
    eff_lh = layer_height if layer_height is not None else _clean_opt(adv.get("layer_height"))
    eff_flh = first_layer_height if first_layer_height is not None else _clean_opt(adv.get("first_layer_height"))
    eff_wl = wall_loops if wall_loops is not None else _clean_opt(adv.get("wall_loops"))
    eff_inf = infill if infill is not None else _clean_opt(adv.get("infill"))
    eff_top = _clean_opt(adv.get("top_shell_layers"))
    eff_bot = _clean_opt(adv.get("bottom_shell_layers"))
    if q_preset != "custom":
        if eff_lh is None:
            eff_lh = q_defaults["layer_height"]
        if eff_flh is None:
            eff_flh = q_defaults["first_layer_height"]
        if eff_wl is None:
            eff_wl = q_defaults["wall_loops"]
        if eff_inf is None:
            eff_inf = q_defaults["infill"]
        if eff_top is None:
            eff_top = q_defaults["top_shell_layers"]
        if eff_bot is None:
            eff_bot = q_defaults["bottom_shell_layers"]

    max_layer = round(float(noz) * 0.85, 3)
    if eff_lh is not None:
        eff_lh = _parse_float_bound(eff_lh, "Hauteur de couche", 0.04, max_layer)
    if eff_flh is not None:
        eff_flh = _parse_float_bound(eff_flh, "Première couche", 0.04, max_layer)

    roots = discover_profile_roots(profile["kind"], slicer_path=slicer_path, profile_roots=profile_roots)
    if not roots:
        raise SlicerConfigError(
            f"Aucun répertoire de profils système détecté pour {model_key} ({profile['kind']})",
            422, "invalid_profile",
        )
    idx = _PresetIndex(roots)
    machine_name, machine = _select_machine(idx, profile, noz)
    process_name, process = _select_process(idx, machine_name, machine, eff_lh)

    ox, oy = profile.get("origin") or (0.0, 0.0)
    bx, by, bz = profile["bed"]
    machine["printer_settings_id"] = machine_name
    machine["printable_area"] = [
        f"{ox:g}x{oy:g}",
        f"{ox + bx:g}x{oy:g}",
        f"{ox + bx:g}x{oy + by:g}",
        f"{ox:g}x{oy + by:g}",
    ]
    machine["printable_height"] = str(int(bz))
    machine["nozzle_diameter"] = [noz] * max(1, int(profile["physical_extruders"]))
    if profile["model_id"]:
        machine["printer_model_id"] = profile["model_id"]

    process["curr_bed_type"] = bed_enum
    if eff_lh is not None:
        process["layer_height"] = str(round(float(eff_lh), 2))
    if eff_flh is not None:
        process["initial_layer_print_height"] = str(round(float(eff_flh), 2))
    if eff_wl is not None:
        process["wall_loops"] = str(_parse_int_bound(eff_wl, "Nombre de parois", 1, 16))
    if eff_top is not None:
        process["top_shell_layers"] = str(_parse_int_bound(eff_top, "Couches supérieures", 0, 30))
    if eff_bot is not None:
        process["bottom_shell_layers"] = str(_parse_int_bound(eff_bot, "Couches inférieures", 0, 30))
    if eff_inf is not None:
        process["sparse_infill_density"] = f"{_parse_int_bound(eff_inf, 'Densité de remplissage', 0, 100)}%"
    eff_pat = infill_pattern if infill_pattern not in (None, "") else _clean_opt(adv.get("infill_pattern"))
    if eff_pat is not None:
        pat = INFILL_PATTERN_MAP.get(str(eff_pat).strip().casefold())
        if not pat:
            raise SlicerConfigError(f"Motif de remplissage inconnu : {eff_pat}", 422, "unsupported")
        process["sparse_infill_pattern"] = pat

    seam_raw = _clean_opt(adv.get("seam_position"))
    if seam_raw is not None:
        seam_v = SEAM_POSITION_MAP.get(str(seam_raw).strip().casefold())
        if not seam_v:
            raise SlicerConfigError(f"Position de couture inconnue : {seam_raw}", 422, "unsupported")
        process["seam_position"] = seam_v
    iron_raw = _clean_opt(adv.get("ironing_type"))
    if iron_raw is not None:
        iron_v = IRONING_TYPE_MAP.get(str(iron_raw).strip().casefold())
        if not iron_v:
            raise SlicerConfigError(f"Mode de repassage inconnu : {iron_raw}", 422, "unsupported")
        process["ironing_type"] = iron_v
    wgen_raw = _clean_opt(adv.get("wall_generator"))
    if wgen_raw is not None:
        wgen_v = WALL_GENERATOR_MAP.get(str(wgen_raw).strip().casefold())
        if not wgen_v:
            raise SlicerConfigError(f"Générateur de parois inconnu : {wgen_raw}", 422, "unsupported")
        process["wall_generator"] = wgen_v

    max_mach_spd = max(100.0, _first_float(machine.get("machine_max_speed_x")) or 600.0)
    max_mach_acc = max(500.0, _first_float(machine.get("machine_max_acceleration_x")) or 12000.0)
    spd_factor = SPEED_PRESET_FACTORS.get(s_preset)
    if spd_factor is not None and abs(spd_factor - 1.0) > 1e-4:
        for sp_key in ("outer_wall_speed", "inner_wall_speed", "sparse_infill_speed", "initial_layer_speed"):
            if _clean_opt(adv.get(sp_key)) is None:
                base_v = _first_float(process.get(sp_key))
                if base_v:
                    cap = min(max_mach_spd, 200.0 if sp_key == "initial_layer_speed" else 600.0)
                    scaled = max(5.0 if sp_key == "initial_layer_speed" else 10.0, min(cap, round(base_v * spd_factor)))
                    _set_cfg_value(process, sp_key, str(int(scaled)))
    for sp_key, label, lo, hi_cap in (
        ("outer_wall_speed", "Vitesse paroi ext.", 10.0, min(600.0, max_mach_spd)),
        ("inner_wall_speed", "Vitesse paroi int.", 10.0, min(600.0, max_mach_spd)),
        ("sparse_infill_speed", "Vitesse remplissage", 10.0, min(600.0, max_mach_spd)),
        ("initial_layer_speed", "Vitesse 1re couche", 5.0, min(200.0, max_mach_spd)),
        ("travel_speed", "Vitesse déplacement", 20.0, max(1000.0, max_mach_spd)),
    ):
        raw_sp = _clean_opt(adv.get(sp_key))
        if raw_sp is not None:
            v = _parse_float_bound(raw_sp, label, lo, hi_cap)
            _set_cfg_value(process, sp_key, str(int(round(v))))
    for acc_key, label, hi_cap in (
        ("default_acceleration", "Accélération par défaut", min(30000.0, max_mach_acc)),
        ("outer_wall_acceleration", "Accélération paroi ext.", min(25000.0, max_mach_acc)),
    ):
        raw_ac = _clean_opt(adv.get(acc_key))
        if raw_ac is not None:
            v = _parse_float_bound(raw_ac, label, 200.0, hi_cap)
            _set_cfg_value(process, acc_key, str(int(round(v))))

    eff_supports = supports or bool(adv.get("supports"))
    if eff_supports:
        process["enable_support"] = "1"
        st_key = str(support_type or adv.get("support_type") or "tree").strip().casefold()
        st_val = SUPPORT_TYPE_MAP.get(st_key)
        if not st_val:
            raise SlicerConfigError(f"Type de support inconnu : {st_key}", 422, "unsupported")
        process["support_type"] = st_val
        if _clean_opt(adv.get("support_on_build_plate_only")) is not None:
            process["support_on_build_plate_only"] = "1" if bool(adv.get("support_on_build_plate_only")) else "0"
        if _clean_opt(adv.get("support_threshold_angle")) is not None:
            process["support_threshold_angle"] = str(_parse_int_bound(adv["support_threshold_angle"], "Angle porte-à-faux", 5, 80))
        if _clean_opt(adv.get("support_base_pattern_spacing")) is not None:
            process["support_base_pattern_spacing"] = f"{_parse_float_bound(adv['support_base_pattern_spacing'], 'Espacement supports', 0.5, 10.0):g}"
        if _clean_opt(adv.get("support_interface_top_layers")) is not None:
            process["support_interface_top_layers"] = str(_parse_int_bound(adv["support_interface_top_layers"], "Couches interface support", 0, 6))
        if _clean_opt(adv.get("support_interface_filament")) is not None:
            sif = _parse_int_bound(adv["support_interface_filament"], "Outil interface support", 0, max_tools)
            if sif > n_tools:
                raise SlicerConfigError(
                    f"Outil d'interface support T{sif - 1} non assigné ({n_tools} outil(s) configuré(s))",
                    422, "tool_out_of_range",
                )
            process["support_interface_filament"] = str(sif)
    else:
        process["enable_support"] = "0"

    eff_brim = brim or bool(adv.get("brim"))
    eff_bt = brim_type if brim_type not in (None, "") else _clean_opt(adv.get("brim_type"))
    if eff_brim:
        bt_key = str(eff_bt or "outer_only").strip().casefold()
        bt_val = BRIM_TYPE_MAP.get(bt_key)
        if not bt_val:
            raise SlicerConfigError(f"Type de bordure inconnu : {bt_key}", 422, "unsupported")
        process["brim_type"] = bt_val
    elif eff_bt is not None:
        bt_val = BRIM_TYPE_MAP.get(str(eff_bt).strip().casefold(), "no_brim")
        process["brim_type"] = bt_val
    if _clean_opt(adv.get("brim_width")) is not None:
        process["brim_width"] = f"{_parse_float_bound(adv['brim_width'], 'Largeur bordure', 0.0, 30.0):g}"
    if _clean_opt(adv.get("skirt_loops")) is not None:
        process["skirt_loops"] = str(_parse_int_bound(adv["skirt_loops"], "Boucles jupe", 0, 10))
    if _clean_opt(adv.get("raft_layers")) is not None:
        process["raft_layers"] = str(_parse_int_bound(adv["raft_layers"], "Couches radeau", 0, 6))

    prime_box = _compute_prime_tower_box(process, profile, n_tools, adv)
    if _clean_opt(adv.get("flush_multiplier")) is not None:
        fm = _parse_float_bound(adv["flush_multiplier"], "Multiplicateur purge", 0.0, 2.0)
        base_pv = _first_float(process.get("prime_volume")) or 35.0
        _set_cfg_value(process, "prime_volume", str(round(max(5.0, base_pv * max(0.1, fm)), 1)))
    if _clean_opt(adv.get("flush_into_infill")) is not None:
        process["flush_into_infill"] = "1" if bool(adv["flush_into_infill"]) else "0"
    if _clean_opt(adv.get("flush_into_support")) is not None:
        process["flush_into_support"] = "1" if bool(adv["flush_into_support"]) else "0"

    tools_list = tools if isinstance(tools, list) else []
    fallback_mat = str(material or "PLA").strip()
    fil_names: list[str] = []
    fil_dicts: list[dict[str, Any]] = []
    max_noz_t = float(profile.get("max_nozzle_temp") or 280.0)
    max_bed_t = float(profile.get("max_bed_temp") or 100.0)
    bed_init_k, bed_other_k = _bed_temp_keys(bed_enum)
    slot_noz_temps: list[float] = []

    for slot_idx in range(n_tools):
        slot_cfg = tools_list[slot_idx] if slot_idx < len(tools_list) and isinstance(tools_list[slot_idx], dict) else {}
        mat_name = str(slot_cfg.get("material") or fallback_mat).strip() or "PLA"
        explicit_pre = str(slot_cfg.get("preset") or "").strip() or None
        fn, ff = _select_filament(idx, machine_name, mat_name, noz, explicit_preset=explicit_pre)
        _check_plate_compat(ff, mat_name, bed_enum, profile)
        colour = str(slot_cfg.get("color") or "").strip()
        if colour and _HEX_RE.fullmatch(colour):
            ff["filament_colour"] = [colour.upper()]
        ff["filament_settings_id"] = [fn]

        r_lo = _first_float(ff.get("nozzle_temperature_range_low")) or 160.0
        r_hi = _first_float(ff.get("nozzle_temperature_range_high")) or max_noz_t
        if slot_idx == 0:
            for t_key, label in (
                ("nozzle_temperature_initial_layer", "Température buse 1re couche"),
                ("nozzle_temperature", "Température buse"),
            ):
                raw_t = _clean_opt(adv.get(t_key))
                if raw_t is not None:
                    tv = _parse_float_bound(raw_t, label, max(150.0, r_lo - 25.0), min(max_noz_t, r_hi + 25.0))
                    _set_cfg_value(ff, t_key, str(int(round(tv))))
            for bt_req, f_key, label in (
                ("bed_temperature_initial_layer", bed_init_k, "Température plateau 1re couche"),
                ("bed_temperature", bed_other_k, "Température plateau"),
            ):
                raw_bt = _clean_opt(adv.get(bt_req))
                if raw_bt is not None:
                    bv = _parse_float_bound(raw_bt, label, 0.0, max_bed_t)
                    _set_cfg_value(ff, f_key, str(int(round(bv))))
            fmin_req = _clean_opt(adv.get("fan_min_speed"))
            fmax_req = _clean_opt(adv.get("fan_max_speed"))
            eff_fmin = _parse_int_bound(fmin_req, "Ventilateur min.", 0, 100) if fmin_req is not None else int(_first_float(ff.get("fan_min_speed")) or 0)
            eff_fmax = _parse_int_bound(fmax_req, "Ventilateur max.", 0, 100) if fmax_req is not None else int(_first_float(ff.get("fan_max_speed")) or 100)
            if eff_fmin > eff_fmax:
                raise SlicerConfigError(f"Ventilateur min. ({eff_fmin}%) supérieur au max. ({eff_fmax}%)", 422, "unsupported")
            if fmin_req is not None:
                _set_cfg_value(ff, "fan_min_speed", str(eff_fmin))
            if fmax_req is not None:
                _set_cfg_value(ff, "fan_max_speed", str(eff_fmax))
            if _clean_opt(adv.get("close_fan_the_first_x_layers")) is not None:
                cf = _parse_int_bound(adv["close_fan_the_first_x_layers"], "Couches sans ventilateur", 0, 10)
                _set_cfg_value(ff, "close_fan_the_first_x_layers", str(cf))
            if _clean_opt(adv.get("filament_max_volumetric_speed")) is not None:
                base_flow = _first_float(ff.get("filament_max_volumetric_speed")) or 21.0
                flow_v = _parse_float_bound(adv["filament_max_volumetric_speed"], "Débit volumique max.", 0.5, min(50.0, base_flow * 1.35))
                _set_cfg_value(ff, "filament_max_volumetric_speed", f"{flow_v:g}")

        nt_eff = _first_float(ff.get("nozzle_temperature")) or 220.0
        if nt_eff > max_noz_t + 0.1:
            raise SlicerConfigError(f"{mat_name} requiert {nt_eff:.0f}°C > limite buse {profile['model']} ({max_noz_t:.0f}°C)", 422, "unsupported")
        slot_noz_temps.append(nt_eff)
        fil_names.append(fn)
        fil_dicts.append(ff)

    if int(profile.get("physical_extruders") or 1) == 1 and len(slot_noz_temps) > 1:
        if max(slot_noz_temps) - min(slot_noz_temps) > 60.0:
            raise SlicerConfigError(
                f"Écart thermique trop élevé entre filaments sur buse unique ({min(slot_noz_temps):.0f}°C vs {max(slot_noz_temps):.0f}°C)",
                422, "incompatible_materials",
            )

    sif_val = _first_float(process.get("support_interface_filament"))
    if sif_val and int(sif_val) >= 1 and int(sif_val) <= len(slot_noz_temps) and int(profile.get("physical_extruders") or 1) == 1:
        iface_t = slot_noz_temps[int(sif_val) - 1]
        if abs(iface_t - slot_noz_temps[0]) > 60.0:
            raise SlicerConfigError(
                f"Matériau interface support ({iface_t:.0f}°C) incompatible thermiquement avec le modèle ({slot_noz_temps[0]:.0f}°C)",
                422, "incompatible_materials",
            )

    return ResolvedSlicerConfig(
        profile=profile,
        machine_name=machine_name,
        process_name=process_name,
        filament_names=fil_names,
        machine=machine,
        process=process,
        filaments=fil_dicts,
        bed_type=bed_enum,
        nozzle=noz,
        prime_tower_box=prime_box,
        quality_preset=q_preset,
        speed_preset=s_preset,
    )


def inspect_printer_slicer_defaults(
    printer_model: str,
    *,
    nozzle: Any = None,
    material: str = "PLA",
    plate_type: str = "textured_pei",
    quality_preset: str = "standard",
    profile_roots: list[Path] | tuple[Path, ...] | None = None,
    slicer_path: str = "",
) -> dict[str, Any]:
    """Return authoritative vendor-derived defaults, preset values, limits, and compatible filaments."""
    res = resolve_slicer_config(
        printer_model,
        nozzle=nozzle,
        material=material,
        plate_type=plate_type,
        quality_preset=quality_preset,
        profile_roots=profile_roots,
        slicer_path=slicer_path,
    )
    roots = discover_profile_roots(res.profile["kind"], slicer_path=slicer_path, profile_roots=profile_roots)
    idx = _PresetIndex(roots)
    bed_init_k, bed_other_k = _bed_temp_keys(res.bed_type)
    f0 = res.filaments[0] if res.filaments else {}
    p = res.process
    fil_rows = _list_compatible_filaments(idx, res.machine_name)
    supported_mats = sorted({r["material"] for r in fil_rows})
    return {
        "ok": True,
        "printer_model": res.profile["model"],
        "capabilities": printer_capabilities(res.profile["model"]),
        "nozzle": res.nozzle,
        "plate_type": plate_type,
        "quality_presets": {q: quality_preset_defaults(res.nozzle, q) for q in ("draft", "standard", "fine")},
        "speed_presets": dict(SPEED_PRESET_FACTORS),
        "schema": ADVANCED_PARAM_SCHEMA,
        "object_override_keys": list(OBJECT_OVERRIDE_KEYS),
        "supported_materials": supported_mats,
        "available_filaments": fil_rows[:120],
        "effective_defaults": {
            "quality_preset": res.quality_preset,
            "layer_height": _first_float(p.get("layer_height")),
            "first_layer_height": _first_float(p.get("initial_layer_print_height")),
            "wall_loops": int(_first_float(p.get("wall_loops")) or 2),
            "top_shell_layers": int(_first_float(p.get("top_shell_layers")) or 5),
            "bottom_shell_layers": int(_first_float(p.get("bottom_shell_layers")) or 3),
            "infill": int(str(p.get("sparse_infill_density") or "15%").rstrip("%") or 15),
            "infill_pattern": str(p.get("sparse_infill_pattern") or "grid"),
            "seam_position": str(p.get("seam_position") or "aligned"),
            "ironing_type": str(p.get("ironing_type") or "no ironing"),
            "wall_generator": str(p.get("wall_generator") or "classic"),
            "outer_wall_speed": _first_float(p.get("outer_wall_speed")),
            "inner_wall_speed": _first_float(p.get("inner_wall_speed")),
            "sparse_infill_speed": _first_float(p.get("sparse_infill_speed")),
            "initial_layer_speed": _first_float(p.get("initial_layer_speed")),
            "travel_speed": _first_float(p.get("travel_speed")),
            "default_acceleration": _first_float(p.get("default_acceleration")),
            "outer_wall_acceleration": _first_float(p.get("outer_wall_acceleration")),
            "support_type": str(p.get("support_type") or "tree(auto)"),
            "support_threshold_angle": int(_first_float(p.get("support_threshold_angle")) or 30),
            "support_base_pattern_spacing": _first_float(p.get("support_base_pattern_spacing")) or 2.5,
            "support_interface_top_layers": int(_first_float(p.get("support_interface_top_layers")) or 2),
            "brim_width": _first_float(p.get("brim_width")) or 5.0,
            "skirt_loops": int(_first_float(p.get("skirt_loops")) or 0),
            "raft_layers": int(_first_float(p.get("raft_layers")) or 0),
            "nozzle_temperature_initial_layer": _first_float(f0.get("nozzle_temperature_initial_layer")),
            "nozzle_temperature": _first_float(f0.get("nozzle_temperature")),
            "bed_temperature_initial_layer": _first_float(f0.get(bed_init_k)),
            "bed_temperature": _first_float(f0.get(bed_other_k)),
            "fan_min_speed": _first_float(f0.get("fan_min_speed")),
            "fan_max_speed": _first_float(f0.get("fan_max_speed")),
            "close_fan_the_first_x_layers": _first_float(f0.get("close_fan_the_first_x_layers")),
            "filament_max_volumetric_speed": _first_float(f0.get("filament_max_volumetric_speed")),
            "prime_tower_width": _first_float(p.get("prime_tower_width")) or 35.0,
        },
        "limits": {
            "max_layer_height": round(float(res.nozzle) * 0.85, 3),
            "max_nozzle_temp": float(res.profile["max_nozzle_temp"]),
            "max_bed_temp": float(res.profile["max_bed_temp"]),
            "filament_temp_low": _first_float(f0.get("nozzle_temperature_range_low")),
            "filament_temp_high": _first_float(f0.get("nozzle_temperature_range_high")),
            "machine_max_speed": _first_float(res.machine.get("machine_max_speed_x")),
            "machine_max_accel": _first_float(res.machine.get("machine_max_acceleration_x")),
        },
    }
