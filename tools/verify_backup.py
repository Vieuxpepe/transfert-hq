"""Phase 15 — verify a pre-deploy backup folder (``_backup_pre-<sha7>_<stamp>``). Read-only: opens, hashes, parses. Never restores,
never extracts to disk. Stdlib only. Optional ``--git`` also runs ``git bundle verify`` on any ``*.bundle`` (needs git on PATH).

    py -3 tools\\verify_backup.py C:\\Transfert\\_backup_pre-457c665_20261007T0057Z

Exit 0 = every check passed, 1 = a check failed, 2 = usage / folder missing.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
import tarfile

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
REQUIRED = ("hq-carnet-data.tar.gz", "tracked-worktree-as-deployed.tar.gz")


def first_line(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.readline().strip().lower()


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_hashes(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = re.match(r"^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$", line)
            if m:
                out[m.group(2).replace("\\", "/").lstrip("./")] = m.group(1).lower()
    return out


def check_tar(path: str) -> tuple[bool, str]:
    try:
        n = 0
        with tarfile.open(path, "r:*") as tf:
            for m in tf:  # streaming: nothing is extracted
                n += 1
                name = m.name.replace("\\", "/")
                if name.startswith("/") or re.match(r"^[A-Za-z]:", name) or ".." in name.split("/"):
                    return False, f"unsafe member path in archive ({n}th entry)"
        return (n > 0), f"{n} entries" if n else "archive is empty"
    except (tarfile.TarError, OSError, EOFError) as e:
        return False, f"cannot open: {type(e).__name__}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--git", action="store_true", help="also run `git bundle verify` on *.bundle (requires a repo cwd)")
    a = ap.parse_args(argv)
    d = os.path.abspath(a.folder)
    if not os.path.isdir(d):
        print("FAIL  folder - not a directory")
        return 2
    failed = 0

    def out(ok: bool, name: str, detail: str = "") -> None:
        nonlocal failed
        failed += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" - {detail}" if detail else ""))

    rs = os.path.join(d, "ROLLBACK-SHA.txt")
    if os.path.isfile(rs):
        val = first_line(rs)
        out(bool(SHA_RE.match(val)), "rollback_sha_parses", val if SHA_RE.match(val) else "not a 40-hex SHA")
    else:
        out(False, "rollback_sha_parses", "ROLLBACK-SHA.txt missing")
    for name in REQUIRED:
        p = os.path.join(d, name)
        if not os.path.isfile(p):
            out(False, f"present {name}", "missing")
            continue
        ok, det = check_tar(p)
        out(ok, f"archive_opens {name}", det)
    hp = os.path.join(d, "SHA256.txt")
    if not os.path.isfile(hp):
        out(False, "hash_file", "SHA256.txt missing")
    else:
        table = parse_hashes(hp)
        out(bool(table), "hash_file_parses", f"{len(table)} entries")
        for rel, want in sorted(table.items()):
            target = os.path.normpath(os.path.join(d, *rel.split("/")))
            if not target.startswith(d + os.sep):
                out(False, f"hash {rel}", "path escapes the backup folder")
            elif not os.path.isfile(target):
                out(False, f"hash {rel}", "listed file missing")
            else:
                out(sha256(target) == want, f"hash {rel}", "match" if sha256(target) == want else "MISMATCH")
        for name in REQUIRED:
            out(name in table, f"hash_covers {name}", "" if name in table else "not listed in SHA256.txt")
    if a.git:
        for f in sorted(os.listdir(d)):
            if f.endswith(".bundle"):
                try:
                    r = subprocess.run(["git", "bundle", "verify", os.path.join(d, f)], capture_output=True, text=True, timeout=60)
                    out(r.returncode == 0, f"git_bundle {f}", "ok" if r.returncode == 0 else "verify failed")
                except (OSError, subprocess.TimeoutExpired) as e:
                    out(False, f"git_bundle {f}", type(e).__name__)
    print(f"RESULT: {'FAIL' if failed else 'PASS'} ({failed} failed)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
