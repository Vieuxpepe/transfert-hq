# Carnet stage delivery gate

Use only after review and explicit authorization to commit/push/PR.

1. Fetch refs; verify intended accepted predecessor/base.
2. \`git status --short\`
3. \`git diff --check\`
4. inspect complete diff
5. reject temp roots/screenshots/Playwright artifacts/runtime state/secrets/unrelated files
6. execute final test matrix on final tree; do not reuse prior claims
7. if red: STOP

Security gate:
- intended role/auth only
- CSRF/CSP/nosniff intact
- no secret/content URL/log leakage
- no external loads
- confined storage
- malformed-state fail-closed
- live \`C:\Transfert\` untouched

Integrity gate as stage-relevant:
revisions, drafts, conflicts, atomicity, backups, migrations.

If green and authorized:
- one focused commit
- push current stage branch
- one Draft PR against intended base
- do not merge/deploy

PR sections:
Summary; Scope; Architecture; Security; Data integrity; Tests; Browser/real-device status; Out of scope/next stage.

Return exact base/head/commit, branch, PR URL, diff stat, test results, visible checks, git status, Draft/unmerged/not-deployed confirmations.
