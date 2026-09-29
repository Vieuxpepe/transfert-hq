# Carnet adversarial review packet

Use in a fresh context after each stage. Review the current `main` working-tree diff; do not create/switch branches or commit.

Read ONLY:
- CONTEXT.md
- current stage packet
- HANDOFF
- complete diff against accepted base
- changed tests
- surrounding code required by diff

Do not read builder transcript. Do not edit first.

Report findings first by CRITICAL/HIGH/MEDIUM/LOW. Focus on defects, not style.

Always attack:
- auth/role/CSRF/CSP/nosniff
- content/secrets in logs/URLs
- path confinement
- malformed-state preservation
- atomicity
- stale revisions
- draft privacy + old-response/new-input races when relevant
- poll/listener duplication
- unsafe HTML
- WebKit/iPhone/reduced-motion when relevant
- backup coherence
- throwaway-test-root guarantee
- test process/source isolation: no Python suite importing `iphone_bridge` may run from live `C:\\Transfert`
- scope creep / weakened existing tests / generated artifacts

Reproduce high-value issues with a test when practical.

Only after findings: fix confirmed in-scope defects. No cosmetic refactor.

Re-run focused tests + current relevant matrix + \`git diff --check\`.

Final response in HANDOFF-style:
findings, fixes, exact tests, residual risks, head SHA, diff stat, git status.

Leave fixes uncommitted in the same `main` working tree. No push/merge/deploy.
