# Carnet exact integration map

Baseline: \`main@d7e7eb3f2a293303ab258c69fda7f104c245022d\`.

Line numbers are hints only; after edits use the anchor text. Do not reread whole files.

## Stage 01 server patch sites

### \`iphone_bridge.py\`

Imports:
- around line 35: \`import hq_calendar\`
- add \`import hq_carnet\` beside other HQ modules.

Binding:
- \`def bind_hq()\` around line 2073.
- Calendar binding begins around 2104.
- add one \`hq_carnet.bind(root=ROOT,...)\` call near other state modules.
- do not touch companion/planner privilege code.

GET API router:
- \`def _hq_get(self, raw, parsed)\` around line 5641.
- add Carnet dispatch near Calendar/admin HQ APIs.
- authenticated GET flow reaches \`_guard_admin_path()\` before \`_hq_get()\`, around lines 5985–5996.
- therefore Carnet gets admin-only behavior automatically as long as it is NOT added to upload allowlists.

POST API router:
- \`def _hq_post(self, raw)\` around line 5773.
- route Carnet POST here.
- global POST CSRF/auth/role flow happens in \`_do_POST()\`; inspect only that small range before wiring.
- do not add custom Carnet CSRF.

Upload-role controls:
- \`UPLOAD_GET_EXACT\` near line 86.
- \`UPLOAD_POST_EXACT\` near line 107.
- \`_upload_allowed()\` near 5481.
- \`_guard_admin_path()\` near 5495.
- Carnet must NOT appear in either allowlist.

JSON/body:
- \`_read_json()\` near 5468 has global 8 MiB cap.
- Carnet domain applies much smaller own limits.

### \`hq_state.py\`

Only relevant functions:
- \`path_lock\` line ~83
- \`write_json_atomic\` line ~93

Do not duplicate them.

### \`hq_calendar.py\`

Use as pattern, not as base class:
- malformed-state conflict: ~390–417
- revision validation: \`_expect_rev\` ~427
- lock + validate + write pattern: ~447–500

Carnet needs independent per-page revisions, not Calendar's event structure.

### \`cc_ext.py\`

Backup:
- \`run_backup\` ~1629
- legacy Inbox/Uni/Print copy loop ~1647
- legacy \`folders\` catalog count ~1669/1675

Add Carnet snapshot without changing what \`folders\` means.

## Stage 02 UI patch sites

### \`iphone_bridge.py\` embedded SPA

Global JS:
- \`APP_JS\` begins ~2407
- \`VIEW_LABELS\` ~2423
- \`setView()\` ~2516
- \`setupNav()\` ~2563
- global \`api()\` ~2589

CSS:
- panel visibility selector ~4245–4252
- bottom nav CSS ~4395
- desktop breakpoint \`@media (min-width:900px)\` ~4418

Rendered HTML:
- \`render_app()\` ~4635
- first-party stylesheet tags ~4672
- bottom nav markup: Accueil ~4679, Calendrier ~4680
- Accueil panel begins ~4700
- Calendar panel begins ~4815
- insert Carnet panel logically between Accueil and Calendrier
- script tags ~5207–5216; load Carnet same-origin with other feature scripts

Recommended Stage-02 changes:
1. stylesheet tag: \`/assets/hq-carnet.css\`
2. \`VIEW_LABELS.carnet = "Carnet"\`
3. guarded \`hqCarnetShow\` hook in \`setView\`
4. panel visibility selector adds carnet
5. nav button inserted after Accueil
6. \`<div data-panel="carnet">...\`
7. \`/assets/hq-carnet.js\` script
8. backward-compatible \`api()\` error status/data support if Stage 01 did not add it

Do not put the whole Carnet implementation in embedded APP_JS. Keep feature code in \`assets/hq-carnet.js\`.

## Stage 03 desktop/mobile shell

Existing breakpoint is 900px:
- below 900: fixed bottom nav
- >=900: 164px sticky left HQ nav and \`.wrap max-width:980px\`

Carnet may override its own panel/wrap width at desktop, but do not globally widen every HQ view.

Library:
- phone: bottom sheet
- iPad: responsive sheet/sidebar depending width/orientation
- desktop: Carnet-local left sidebar

Use one editor/state instance, not one per layout.

## Stage 04 file/export integration

Existing file URL helpers:
- \`fmtRel()\` ~2575
- \`dlRel()\` ~2578

Existing safe file routes:
- \`/files/\`
- \`/download/\`

Do not invent direct absolute-path serving.

## Stage 05 PDF/source integration

Current \`/media/\` allowlist does NOT include PDF.
Ordinary \`/files/<safe-relative-path>\` can serve a PDF inline according to browser support.

Do not add PDF to media player merely for Sources.
A dedicated Source/PDF viewer may get a dedicated confined route if required, but should reuse existing safe path resolution and HTTP security headers.

## Rule for agents

Before modifying a patch site:
1. \`rg -n "<anchor>" <file>\`
2. inspect at most ~80–160 surrounding lines
3. patch
4. only expand reading if a called helper is materially unclear

If current main moved substantially, record changed integration anchors in HANDOFF rather than re-documenting the repository.
