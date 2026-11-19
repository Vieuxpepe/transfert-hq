#!/usr/bin/env python3
"""Shim — use scripts/benchmark_atelier_models.py (canonical mesh benchmark)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from benchmark_atelier_models import main  # noqa: E402

if __name__ == "__main__":
    main()