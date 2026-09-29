# Carnet compact test matrix

Always inspect current README because commands can change. Baseline at design time:

\`\`\`bash
python -m unittest discover -s tests -v
python -W error::SyntaxWarning -m py_compile iphone_bridge.py cc_ext.py hq_events.py hq_devices.py hq_automation.py hq_calendar.py hq_state.py hq_companion.py hq_jobs.py hq_agent_ops.py hq_agent_protocol.py companion_agent.py companion_ops.py hqctl.py hq_planner.py hq_drawings.py hq_solid.py hq_face_solid.py hq_round_solid.py hq_earcut.py
node tests/check_hq_features.mjs
node tests/check_hq_sketch.mjs
node tests/check_hq_solid.mjs
node tests/check_hq_3d_nav.mjs
node tests/check_hq_model.mjs
\`\`\`

Add new Python modules to py_compile.

Existing optional browser suites:
\`\`\`bash
python tests/visual_dessiner_playwright.py
python tests/visual_dessiner_3d_playwright.py
python tests/visual_face_playwright.py
python tests/visual_dessiner_webkit.py --repeat 3
python tests/visual_media_playwright.py
python tests/visual_model_playwright.py
\`\`\`
Skip honestly when optional dependencies/browsers are absent.

Every stage:
- focused new tests first
- existing relevant tests second
- full unittest before delivery
- py_compile with SyntaxWarning error
- current Node checks when browser JS changed
- \`node --check\` on each new/modified JS
- current ES2020 checker convention if present
- relevant Chromium/WebKit visual tests for UI stages
- \`git diff --check\`
- \`git status --short\`

Never weaken existing tests merely to make Carnet pass.

## Required invariant tests by stage

01 core:
atomicity, malformed preservation, size limits, rev conflicts, role/CSRF, backup coherence.

02 editor:
old-response/new-typing race, offline draft, reload recovery, localStorage failure, two-client conflict, polling dirty protection, duplicate timer/listener prevention, WebKit gestures/reduced motion.

03 library:
search safety/ranking, project/category inheritance, trash/restore, Home privacy, mobile sheet/desktop sidebar.

04 rich:
schema migration, formatting persistence, safe links, find/replace + empty replacement + undo, export path confinement/noclobber.

05 sources:
edition lineage, citation snapshot, locator mapping, source-path confinement, exact page navigation, migration provenance.

06 media:
signature/size/quota/path checks, interrupted upload cleanup, resize/reload/export/backup.

07 engineering:
parser safety, conversion math/precision, tolerance boundaries, task/HQ-link behavior.

08 history:
history restore, bulk preview/undo, reports, backlinks, QR contains no secret, limit-scale tests.
