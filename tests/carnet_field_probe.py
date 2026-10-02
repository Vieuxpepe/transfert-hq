"""Out-of-process probe for the Phase-4 browser suite: run the REAL backup snapshot (Carnet part) against a throwaway root.

    python tests/carnet_field_probe.py <root> snapshot <dest-dir>

Binds hq_carnet exactly like the unit tests do, then prints the JSON report of hq_carnet.snapshot_to(root, dest). Read-only on
the root (the snapshot copies committed bytes), never touches a live root."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hq_carnet  # noqa: E402
import iphone_bridge  # noqa: E402


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    cmd = sys.argv[2]
    hq_carnet.bind(root=root, now=lambda: 1790000000.0, folders=lambda: ["Inbox", "Uni", "Print"],
                   system_names=iphone_bridge.SYSTEM_NAMES, safe_leaf_name=iphone_bridge.safe_leaf_name)
    if cmd == "snapshot":
        dest = Path(sys.argv[3]).resolve()
        print(json.dumps(hq_carnet.snapshot_to(root, dest)))
    else:
        raise SystemExit("unknown command")


if __name__ == "__main__":
    main()
