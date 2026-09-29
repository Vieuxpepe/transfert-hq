# Carnet stage handoff template

Keep this short. Later agents should read this instead of the previous agent's full transcript.

\`\`\`text
STAGE:
BASE_SHA:
HEAD_SHA:
BRANCH:
STATUS: accepted | needs-fix | draft

FILES_CHANGED:
- ...

CONTRACT_NOW_TRUE:
- ...

PUBLIC_API/SCHEMA_CHANGES:
- ...

TESTS:
- command -> PASS/FAIL/SKIP

KNOWN_GAPS:
- ...

REAL_DEVICE:
- not tested | details

NEXT_STAGE_BASE:
- exact SHA

GIT_STATUS:
- ...

DO_NOT_REDISCOVER:
- only facts that materially save the next agent work
\`\`\`

Rules:
- maximum ~80 lines
- facts only
- no implementation diary
- exact SHAs/test commands
- record deviations from frozen decisions explicitly
