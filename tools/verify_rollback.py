"""Phase 15 — "can this deployment be rolled back safely?" Read-only. Stdlib + the ``git`` executable (operator tool, not the bridge).

    py -3 tools\\verify_rollback.py --root C:\\Transfert [--rollback-sha <40-hex>] [--current-sha <sha>]

Answers: current SHA; the previous known-good SHA (from --rollback-sha or the newest ``_backup_pre-*/ROLLBACK-SHA.txt``); whether
the rollback is an ancestor (a pure code revert); whether any Carnet storage module or schema/format constant differs between the
two builds; whether a pre-deploy backup for that SHA exists and verifies; whether the restart path files exist. It never resets,
checks out, restores or restarts anything. Exit 0 = rollback looks safe, 1 = a FAIL, 2 = usage.

Limits (stated, not hidden): "no irreversible migration" is a HEURISTIC over the diff (constants + the word "migrat"), not a proof.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import hq_diagnostics as D  # noqa: E402
import verify_backup as VB  # noqa: E402  (same folder)

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
CONST_RE = re.compile(r"^([A-Z][A-Z0-9_]*(?:SCHEMA|FORMAT|VERSION|MAGIC)[A-Z0-9_]*)\s*=\s*(.+?)\s*$", re.M)
STORAGE_GLOBS = re.compile(r"^(hq_carnet[a-z_]*\.py|cc_ext\.py)$")


def git(root: str, *args: str) -> tuple[int, str]:
    try:
        r = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, timeout=60)
        return r.returncode, r.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.dirname(HERE))
    ap.add_argument("--rollback-sha", default="")
    ap.add_argument("--current-sha", default="")
    a = ap.parse_args(argv)
    root = os.path.abspath(a.root)
    fails = 0
    warns = 0

    def out(level: str, name: str, detail: str = "") -> None:
        nonlocal fails, warns
        fails += level == "FAIL"
        warns += level == "WARN"
        print(f"{level:<5} {name}" + (f" - {detail}" if detail else ""))

    if not os.path.isdir(root):
        print("FAIL  root - not a directory")
        return 2
    cur = a.current_sha.lower() or (D.read_git_head(root)[0] or "")
    if not SHA_RE.match(cur):
        out("FAIL", "current_sha", "cannot determine the current SHA (not a checkout?)")
        cur = ""
    else:
        out("PASS", "current_sha", cur)

    backups = sorted((d for d in os.listdir(root) if d.startswith(D.DEPLOY_BACKUP_PREFIX) and os.path.isdir(os.path.join(root, d))),
                     key=lambda d: os.path.getmtime(os.path.join(root, d)), reverse=True)
    roll = a.rollback_sha.lower()
    src_backup = ""
    if not roll and backups:
        src_backup = backups[0]
        p = os.path.join(root, src_backup, "ROLLBACK-SHA.txt")
        if os.path.isfile(p):
            roll = VB.first_line(p)
    if not SHA_RE.match(roll):
        out("FAIL", "rollback_sha", "no valid previous known-good SHA (pass --rollback-sha or keep a _backup_pre-* folder with ROLLBACK-SHA.txt)")
        roll = ""
    else:
        out("PASS", "rollback_sha", roll + (f" (from {src_backup})" if src_backup else " (argument)"))

    if cur and roll:
        rc, _ = git(root, "cat-file", "-e", roll + "^{commit}")
        if rc == 127:
            out("WARN", "git_available", "git not on PATH: ancestry and diff checks skipped")
        elif rc != 0:
            out("FAIL", "rollback_commit_exists", "the rollback commit is not in this repository")
        else:
            out("PASS", "rollback_commit_exists")
            rc, _ = git(root, "merge-base", "--is-ancestor", roll, cur)
            out("PASS" if rc == 0 else "FAIL", "rollback_is_ancestor", "pure code revert (history is linear)" if rc == 0 else "rollback is NOT an ancestor of the current build")
            rc, names = git(root, "diff", "--name-only", f"{roll}..{cur}")
            changed = [n for n in names.splitlines() if STORAGE_GLOBS.match(os.path.basename(n)) and "/" not in n]
            if not changed:
                out("PASS", "storage_modules_unchanged", "no hq_carnet*.py / cc_ext.py change between the two builds")
            else:
                out("WARN", "storage_modules_changed", ", ".join(changed[:8]))
            diffs = []
            for f in changed:
                _, old = git(root, "show", f"{roll}:{f}")
                _, new = git(root, "show", f"{cur}:{f}")
                o, n = dict(CONST_RE.findall(old)), dict(CONST_RE.findall(new))
                diffs += [f"{f}:{k}" for k in sorted(set(o) | set(n)) if o.get(k) != n.get(k)]
            out("PASS" if not diffs else "FAIL", "format_constants_unchanged", "none changed" if not diffs else "CHANGED: " + ", ".join(diffs[:8]) + " - the older build may not read data written by the newer one")
            rc, patch = git(root, "diff", "-U0", f"{roll}..{cur}", "--", *changed) if changed else (0, "")
            mig = [l for l in patch.splitlines() if l.startswith("+") and not l.startswith("+++") and re.search(r"migrat", l, re.I)]
            out("PASS" if not mig else "WARN", "no_migration_markers", "none added" if not mig else f"{len(mig)} added line(s) mention a migration - review before rolling back (heuristic)")

    if roll:
        match = ""
        for b in backups:
            p = os.path.join(root, b, "ROLLBACK-SHA.txt")
            if os.path.isfile(p) and VB.first_line(p) == roll:
                match = b
                break
        if not match:
            out("FAIL", "backup_for_rollback", "no pre-deploy backup folder records this rollback SHA")
        else:
            rc = VB.main([os.path.join(root, match)])  # prints its own PASS/FAIL lines
            out("PASS" if rc == 0 else "FAIL", "backup_verifies", match)

    for f in ("Restart-Bridge.bat", "Restart-Bridge.ps1", "start_bridge_hidden.vbs"):
        out("PASS" if os.path.isfile(os.path.join(root, f)) else "FAIL", f"restart_path {f}")
    ps = os.path.join(root, "Restart-Bridge.ps1")
    if os.path.isfile(ps):
        with open(ps, "r", encoding="utf-8", errors="replace") as fh:
            ps_text = fh.read()
        out("PASS" if re.search(r"\$port\s*=\s*8765", ps_text) else "WARN", "restart_port_8765")
    if roll:
        print(f"ROLLBACK COMMAND (not run): git -C \"{root}\" reset --hard {roll}   then run Restart-Bridge.bat")
    print(f"RESULT: {'FAIL' if fails else 'PASS'} ({fails} fail, {warns} warn)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
