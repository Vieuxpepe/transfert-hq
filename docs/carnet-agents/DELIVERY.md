# Carnet stage delivery gate

Use only after review and explicit user authorization.

Working mode:
- project is `C:\Transfert`;
- current branch must remain `main`;
- do not create/switch branches, worktrees, clones, or PR branches;
- source changes may already be present uncommitted from several accepted stages.

1. Confirm `git branch --show-current` is `main`. If not, STOP.
2. Optionally attempt `git fetch --all --prune` once. If credentials are unavailable, report it; do not loop or alter auth.
3. `git status --short`
4. `git diff --check`
5. inspect the complete working-tree diff against HEAD
6. reject temp roots, screenshots, Playwright artifacts, runtime notebook/assets, secrets, line-ending-only mass rewrites, and unrelated files
7. execute the final required test matrix on the exact working tree; do not reuse prior claims
8. if any required check is red, STOP

Security gate:
- intended role/auth only
- CSRF/CSP/nosniff intact
- no secret/content URL/log leakage
- no external loads
- confined storage
- malformed-state fail-closed
- source files under `C:\Transfert` may be edited, but live Inbox/Uni/Print/state/runtime data must not be mutated by tests

Integrity gate as stage-relevant:
- revisions
- drafts
- conflicts
- atomicity
- backups
- migrations

Default behavior after a green gate:
- leave all reviewed changes uncommitted in the current `main` working tree
- report that the tree is ready for user review

Only if the user explicitly authorizes a COMMIT:
- create one focused commit on the existing `main`
- do not push unless push was also explicitly authorized

Only if the user explicitly authorizes a PUSH:
- push the reviewed `main` commit to `origin/main`
- never force-push
- if remote main advanced or the push is non-fast-forward, STOP and report; do not rebase/merge automatically

No PR is created in this workflow because no feature branch is used.

Return:
- HEAD SHA before delivery
- resulting commit SHA if a commit was authorized
- working branch (`main`)
- diff stat
- exact tests/results/skips
- git status
- fetch/push status if attempted
- confirmation that no branch/worktree/clone/merge/deploy was created/performed
