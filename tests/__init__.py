# Makes ``tests.*`` imports work when running pytest from the repo root.

# Stale throwaway HQ copies in %TEMP% (~0.4–0.8 GB each, idle > 1 h) are swept in the background on every test run.
try:
    from tests import hq_temp_janitor as _janitor

    _janitor.prune_in_background()
except Exception:  # noqa: BLE001 — never block a test run over housekeeping
    pass
