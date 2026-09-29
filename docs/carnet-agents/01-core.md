# 01 — Carnet core: storage/domain/API

**Working mode:** edit the existing `C:\Transfert` working tree directly. Do not create/switch branches or worktrees. Do not commit/push unless separately authorized. Never run feature tests against live runtime state; use throwaway roots.

Base: current `main` working tree after accepted preflight. Stay on `main`; do not switch branches.

Read only:
- CONTEXT.md
- TESTS.md
- prior HANDOFF if present

Inspect via:
\`\`\`bash
rg -n "def path_lock|def write_json_atomic" hq_state.py
rg -n "expected_rev|Conflict|path_lock|write_json_atomic|def bind" hq_calendar.py
rg -n "UPLOAD_GET_EXACT|UPLOAD_POST_EXACT|_guard_admin_path|_check_csrf|def _hq_get|def _hq_post|def ensure_hq|def bind_hq" iphone_bridge.py
rg -n "def run_backup|folders" cc_ext.py
rg -n "note_backup|_note_backup_locked|folders" hq_automation.py
\`\`\`
Read only surrounding ranges required to implement.

## Deliver

Create \`hq_carnet.py\`. Runtime:
\`<ROOT>/.hq-carnet/notebook.json\`.
Gitignore \`.hq-carnet/\`.

Use \`path_lock\` + \`write_json_atomic\`; fixed server path only. Malformed/unsupported file remains byte-for-byte untouched.

Persist versioned notebook:
- \`version\`
- \`notebook_rev\`
- projects
- categories
- pages

Page:
- server ID
- \`rev\`
- project/category IDs or null
- pinned bool
- \`deleted_at\`
- server created/updated timestamps
- versioned content; no arbitrary HTML
- choose blocks now if clean; otherwise one text block with explicit migration/version contract before Stage 04

Limits: 128 active pages, 24 categories, 48 KiB UTF-8/page, 1 MiB active text total.

Category colors: blue green amber coral violet pink teal graphite. Reject case-insensitive duplicate names.

Implement domain actions:
- page create/save/trash/restore/permanent-delete
- category create/update/delete
- project create/update/delete-or-archive

Rules:
- page save uses \`expected_rev\`
- structural mutations use \`expected_notebook_rev\`
- stale -> conflict, no disk write
- different pages edit independently
- deleting category/project never deletes notes
- if association is cleared, affected page rev + updated_at bump
- always keep a usable active blank page invariant
- client cannot forge IDs/revs/timestamps/deleted state outside actions

HTTP:
- \`GET /api/carnet\`
- \`GET /api/carnet?meta=1\`
- \`POST /api/carnet\`
Admin only. Never add upload allowlist entries. Existing CSRF handles POST.

Full GET includes state + limits.
Meta GET omits full bodies and returns bounded safe preview + IDs/revs/metadata.

Errors: strict 400 / 404 / 409 / controlled storage error.

If central \`api()\` change is needed now, only add backward-compatible JSON error \`status\` + parsed \`data\`; preserve 401/403/current callers.

Backup:
\`<backup>/<stamp>/Carnet/notebook.json\`, under same notebook path lock. Never temp file. Preserve legacy \`folders\` count meaning; separate Carnet flag.

## Tests required

Focused Python:
- init/path/default page
- create/order/save/rev
- stale save no disk change
- different-page independence
- trash/restore/final-page invariant
- IDs/timestamps/client-forgery rejection
- category/project validation/orphan semantics
- category delete bumps affected pages
- stale client cannot resurrect deleted category
- all limits by UTF-8 bytes
- malformed + unsupported version preservation
- atomic writer used
- concurrent threads
- write failure preserves last-good
- no temp residue

HTTP:
401 anonymous; 403 upload; admin success; CSRF rejection; 400/404/409; no allowlist change; CSP/nosniff unchanged; no content/secret URL/log leakage.

Backup:
legacy folders unchanged; coherent Carnet; missing safe; no temp; legacy count unchanged.

Run TESTS.md matrix appropriate to server changes.

**Test-location rule:** do not run any Python test importing `iphone_bridge` from live `C:\\Transfert`. Use the disposable isolated source-copy procedure from TESTS.md. In-place execution is allowed only for tests proven not to touch/import runtime-bound code.

STOP before UI/editor work.

Output compact HANDOFF-format report. No merge/deploy.
