# Carnet canonical test fixtures

Use these values in tests so agents do not waste time inventing scenarios. Exact server-generated IDs in production remain opaque; tests may seed these IDs directly only through fixture/state setup, never through public create APIs.

## Users

Admin:
- username: \`admin-test\`
- role: \`admin\`

Restricted:
- username: \`upload-test\`
- role: \`upload\`

Use existing test PIN/session helpers; do not create a second auth mechanism.

## Basic notebook

\`\`\`json
{
  "version":1,
  "notebook_rev":4,
  "projects":[
    {
      "id":"proj-fixture",
      "name":"Fixture redesign",
      "archived":false,
      "created_at":1790680000.0,
      "updated_at":1790680000.0
    }
  ],
  "categories":[
    {
      "id":"cat-measures",
      "name":"Mesures",
      "color":"amber",
      "created_at":1790680000.0,
      "updated_at":1790680000.0
    }
  ],
  "pages":[
    {
      "id":"page-shaft",
      "rev":3,
      "project_id":"proj-fixture",
      "category_id":"cat-measures",
      "pinned":true,
      "deleted_at":null,
      "created_at":1790680010.0,
      "updated_at":1790680300.0,
      "content":{
        "version":1,
        "blocks":[
          {
            "id":"block-shaft",
            "type":"text",
            "text":"Shaft inspection\\nØ12.034 mm\\nCheck bearing preload",
            "marks":[]
          }
        ]
      }
    },
    {
      "id":"page-idea",
      "rev":1,
      "project_id":null,
      "category_id":null,
      "pinned":false,
      "deleted_at":null,
      "created_at":1790680400.0,
      "updated_at":1790680400.0,
      "content":{
        "version":1,
        "blocks":[
          {
            "id":"block-idea",
            "type":"text",
            "text":"Try a split clamp instead",
            "marks":[]
          }
        ]
      }
    }
  ]
}
\`\`\`

Expected derived title:
- page-shaft -> \`Shaft inspection\`
- page-idea -> \`Try a split clamp instead\`
- blank page -> \`Page sans titre\`

## Page conflict

Client A loads \`page-shaft@rev=3\`.
Client B saves it -> server rev 4.
Client A sends expected_rev 3.

Expected:
HTTP 409:
\`\`\`json
{
  "error":"Page modifiée ailleurs",
  "code":"revision_conflict",
  "page":{
    "id":"page-shaft",
    "rev":4
  },
  "notebook_rev":4
}
\`\`\`

The real payload returns the complete current page. Test assertion should verify local client A text remains untouched.

## Late-success race

Initial:
- server rev 3
- client generation 10
- text A = \`first edit\`

Begin save A with generation 10 / expected_rev 3.

Before response:
- user types text B = \`first edit + newer text\`
- generation becomes 11
- local draft stores B

Server returns save A success rev 4.

Expected client:
- serverRev = 4
- generation = 11
- dirty remains true
- draft B remains
- immediately queues B expected_rev 4
- never displays/reverts to A
- after B success rev 5, dirty/draft may clear iff no newer generation

## Different-page concurrency

A edits page-shaft rev 3.
B edits page-idea rev 1.
Both save successfully independent of notebook structural rev, unless either action changes structure.

## Category deletion stale-client case

Start page-shaft rev 3 category cat-measures.
Delete cat-measures structurally:
- category disappears
- page-shaft category_id -> null
- page-shaft rev -> 4
- notebook_rev increments

A stale client with rev 3 attempts page_save retaining cat-measures.
Expected 409; category must not resurrect.

## Offline multiple-page case

1. edit page-shaft -> dirty draft
2. network offline
3. navigate page-idea
4. edit page-idea -> second dirty draft
5. reload
6. admin identity confirmed
7. both drafts remain recoverable

## localStorage failure

Stub \`localStorage.setItem\` to throw.
Expected:
- current memory edit remains visible
- dirty remains true
- warning text exactly:
  \`Sauvegarde locale indisponible — ne ferme pas cette page.\`
- no false "Enregistré"

## Malformed disk

Write exact bytes:
\`\`\`text
{ this is not valid json
\`\`\`

Attempt any mutation.
Expected:
- controlled error/conflict
- exact bytes remain unchanged
- no replacement valid notebook created
- no leftover successful-looking state

## UTF-8 limit

Use multi-byte characters so tests count bytes, not JS/Python character count.

Example:
\`é\` = 2 UTF-8 bytes.
Construct exact boundary and boundary+1 byte payloads.

## Search

Pages:
- \`Ébauche moteur\`
- body \`diamètre arbre\`
- category \`Mesures\`
- project \`Fixture redesign\`

Queries should prove:
- \`ebauche\` matches \`Ébauche\`
- title match outranks body match
- pinned tie-break works
- text is rendered safely via textContent

## Source-stage fixture

Family:
\`Shigley's Mechanical Engineering Design\`

Edition A:
- \`11e\`
- semantic page \`394\`
- actual PDF page \`416\`

Edition B:
- \`12e\`
- semantic page \`417\`
- actual PDF page \`439\`

Migration must never infer 417/439 automatically. Test explicitly supplies it and preserves old 11e/394 provenance.
