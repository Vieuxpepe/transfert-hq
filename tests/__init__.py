# Makes ``tests.*`` imports work when running pytest from the repo root.

# The bridge binds its config, sessions and diagnostics paths when it is imported.
# Sandbox them before any test module imports it, so no test process can write
# into the live checkout.
import os as _os

if _os.environ.get("HQ_TEST_BRIDGE_SANDBOX", "").strip().lower() not in ("0", "off", "no"):
    try:
        from tests import hq_bridge_state as _bridge_state

        _bridge_state.sandbox()
    except Exception:  # noqa: BLE001 — never block a test run over the sandbox
        pass

# Assistant stores resolve to the checkout when nothing binds them: snapshot its
# store files now so the end of the run can name any test that wrote them.
try:
    from tests import hq_assistant_state as _assistant_state

    _assistant_state.watch_live_checkout()
except Exception:  # noqa: BLE001 — the guard must never block a test run
    pass

# Stale throwaway HQ copies in %TEMP% (~0.4–0.8 GB each, idle > 1 h) are swept in the background on every test run.
try:
    from tests import hq_temp_janitor as _janitor

    _janitor.prune_in_background()
except Exception:  # noqa: BLE001 — never block a test run over housekeeping
    pass
