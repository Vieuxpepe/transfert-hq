# Carnet frozen implementation contracts

These names exist to eliminate avoidable agent decisions. If current code makes one impossible, change the smallest thing and record the deviation in HANDOFF.

## V1 persisted notebook

\`\`\`json
{
  "version": 1,
  "notebook_rev": 1,
  "projects": [],
  "categories": [],
  "pages": [
    {
      "id": "page-<server-generated>",
      "rev": 1,
      "project_id": null,
      "category_id": null,
      "pinned": false,
      "deleted_at": null,
      "created_at": 0.0,
      "updated_at": 0.0,
      "content": {
        "version": 1,
        "blocks": [
          {
            "id": "block-<server-generated>",
            "type": "text",
            "text": "",
            "marks": []
          }
        ]
      }
    }
  ]
}
\`\`\`

Foundation accepts exactly one text block/page and empty \`marks\`. This intentionally leaves a migration path for Stage 04 without storing arbitrary HTML.

Derived title is NEVER persisted in V1. It comes from first non-empty text line.

## IDs

Generate opaque server IDs; preferred readable prefixes:
- \`page-\`
- \`block-\`
- \`cat-\`
- \`proj-\`

Use cryptographically strong stdlib randomness/UUID. Never derive IDs from note text/user input.

## Limits

Frozen:
- page text <= 48 KiB UTF-8
- active notebook text <= 1 MiB
- categories <= 24
- category name <= 40 Unicode characters
- project name <= 60 Unicode characters
- fixed category colors:
  \`blue green amber coral violet pink teal graphite\`

Page-count handling must remain bounded. If trash-count semantics are not already fixed by accepted Stage 01 tests, choose the safest bounded interpretation and record it in HANDOFF; do not leave unbounded deleted pages.

## Project semantics

Foundation project fields:
\`\`\`json
{
  "id": "proj-...",
  "name": "Fixture redesign",
  "archived": false,
  "created_at": 0.0,
  "updated_at": 0.0
}
\`\`\`

Prefer archive/unarchive over destructive project deletion. Notes keep \`project_id\` when a project is archived. Archived projects disappear from normal create pickers but remain visible/searchable for historical notes.

Do not build nested projects in V1.

## Category semantics

\`\`\`json
{
  "id": "cat-...",
  "name": "Mesures",
  "color": "amber",
  "created_at": 0.0,
  "updated_at": 0.0
}
\`\`\`

Case-insensitive duplicate names rejected.

Category delete:
- removes category record
- every referencing page gets \`category_id:null\`
- every affected page \`rev++\`, \`updated_at=server_now\`
- \`notebook_rev++\`
- note content preserved

## HTTP surface

### GET \`/api/carnet\`

200:
\`\`\`json
{
  "ok": true,
  "version": 1,
  "notebook_rev": 7,
  "projects": [],
  "categories": [],
  "pages": [],
  "limits": {
    "page_text_bytes": 49152,
    "notebook_text_bytes": 1048576,
    "categories": 24
  }
}
\`\`\`

### GET \`/api/carnet?meta=1\`

No full body text.

Each page metadata item:
\`\`\`json
{
  "id": "page-...",
  "rev": 3,
  "project_id": null,
  "category_id": "cat-...",
  "pinned": true,
  "deleted_at": null,
  "created_at": 0.0,
  "updated_at": 0.0,
  "title": "First line",
  "preview": "bounded plain-text preview"
}
\`\`\`

Title/preview are derived server output, never trusted client persistence.

Reject unknown/non-\`1\` \`meta\` values.

## POST \`/api/carnet\`

Use one endpoint with \`action\`.

Canonical action names:
- \`page_create\`
- \`page_save\`
- \`page_trash\`
- \`page_restore\`
- \`page_delete_permanent\`
- \`category_create\`
- \`category_update\`
- \`category_delete\`
- \`project_create\`
- \`project_update\`
- \`project_archive\`

### page_create

\`\`\`json
{
  "action": "page_create",
  "expected_notebook_rev": 7,
  "after_id": "page-..." ,
  "project_id": null,
  "category_id": null
}
\`\`\`
\`after_id\` may be null/omitted.

### page_save

\`\`\`json
{
  "action": "page_save",
  "id": "page-...",
  "expected_rev": 3,
  "project_id": null,
  "category_id": null,
  "pinned": false,
  "content": {
    "version": 1,
    "blocks": [
      {"id":"block-...","type":"text","text":"...","marks":[]}
    ]
  }
}
\`\`\`

Client may send existing block ID for the one V1 block. Server validates it belongs to that page. Client cannot create arbitrary extra V1 blocks.

### structural page actions

Trash/restore/permanent-delete include:
- \`id\`
- \`expected_rev\`
- \`expected_notebook_rev\`

This avoids ambiguity around the final-active-page replacement invariant.

### category/project actions

All include \`expected_notebook_rev\`.

Project archive:
\`\`\`json
{
  "action":"project_archive",
  "id":"proj-...",
  "expected_notebook_rev":7,
  "archived":true
}
\`\`\`

## Success response convention

Mutation success:
\`\`\`json
{
  "ok": true,
  "notebook_rev": 8,
  "page": { }
}
\`\`\`

Use the entity key relevant to action (\`page\`, \`category\`, \`project\`) and include current \`notebook_rev\`.

## Error contracts

Validation:
\`\`\`json
{"error":"...","code":"validation_error"}
\`\`\`

Not found:
\`\`\`json
{"error":"...","code":"not_found"}
\`\`\`

Page conflict:
HTTP 409
\`\`\`json
{
  "error":"Page modifiée ailleurs",
  "code":"revision_conflict",
  "page":{ },
  "notebook_rev":8
}
\`\`\`

Structural conflict:
HTTP 409
\`\`\`json
{
  "error":"Carnet modifié ailleurs",
  "code":"notebook_revision_conflict",
  "notebook_rev":8
}
\`\`\`

Malformed persisted file:
controlled conflict/storage response; never overwrite bytes.

## Browser \`api()\`

For non-401/403 JSON error:
\`\`\`js
const err = new Error(data.error || ('Erreur ' + res.status));
err.status = res.status;
err.data = data;
throw err;
\`\`\`

Preserve existing special 401 redirect and 403 message behavior.

## Local draft key

\`hq_carnet_drafts_v1:<encodeURIComponent(username)>\`

Value:
\`\`\`json
{
  "version":1,
  "pages":{
    "page-...":{
      "server_rev":3,
      "generation":12,
      "saved_generation":9,
      "updated_local_at":0,
      "project_id":null,
      "category_id":null,
      "pinned":false,
      "content":{}
    }
  }
}
\`\`\`

Do not store full clean notebook here. Dirty/recovery state only.

## Poll interval

Freeze foundation metadata polling at **5 seconds** while:
- current view is Carnet
- \`document.visibilityState === "visible"\`

Stop/pause otherwise. Refresh immediately on activation/visibility return.

## Timestamp display

Persist epoch seconds/floats generated by server.

Display in browser local timezone via \`Intl.DateTimeFormat\`.

Explicit inserted \`HH:MM — \` marker uses the device's local current time and becomes ordinary note content.
