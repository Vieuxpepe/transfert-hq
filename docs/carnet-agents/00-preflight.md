# 00 — Preflight only

Read: \`CONTEXT.md\`. Do not read full design unless a mismatch appears.

Do not edit code.

Run/inspect:
\`\`\`bash
git fetch --all --prune
git status --short
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
git remote -v
test -f .cursorrules && cat .cursorrules || true
\`\`\`

Use \`rg\` anchors from CONTEXT.md instead of reading all of \`iphone_bridge.py\`.

Confirm:
- current main vs design baseline
- auth/CSRF/role routing anchors
- \`hq_state\` atomic primitives
- Calendar conflict conventions
- backup function/result semantics
- current nav/setView/api anchors
- test helpers + browser harnesses
- current README commands

Output ONLY:
1. HEAD / origin/main / clean-or-dirty
2. material architecture changes since design baseline
3. Stage-01 CREATE/MODIFY file map
4. exact focused Stage-01 test commands
5. blockers/risks

No implementation plan essay. No edits/commit/push.
