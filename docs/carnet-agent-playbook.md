# Carnet — Local Agent Implementation Playbook

> Canonical working mode: edit the existing `C:\\Transfert` working tree directly on `main`. Do not create/switch feature branches, worktrees, or clones. Leave changes uncommitted/unpushed unless the user explicitly authorizes delivery.

Status: implementation prompts prepared from the Carnet design specification.

Design source: \`design.md\` on branch \`docs/carnet-design\`.

At the time this playbook was prepared, \`main\` was:
\`d7e7eb3f2a293303ab258c69fda7f104c245022d\`

Never assume that SHA is still current. Every implementation stage begins by fetching and inspecting current \`main\` or the accepted previous Carnet stage.

---

# How to use this playbook

This project is intentionally split into small sequential implementation stages.

Do not ask one agent to implement the entire Carnet vision in one pass.

Recommended order:

1. Stage 0 — local preflight + design assimilation
2. Stage 1 — Carnet persistence/domain/API
3. Stage 2 — core editor, paper UI, local drafts, autosave, conflicts
4. Stage 3 — library, projects, categories, pinning, search, recents, trash, Home integration
5. Stage 4 — rich text, hyperlinks, find/replace, exports, publish-to-Transfert
6. Stage 5 — Sources library, citations, edition lineage, exact local-PDF page jumps
7. Stage 6 — images/media attachments, resize/layout, captions
8. Stage 7 — engineering tools and deep HQ integration
9. Stage 8 — history, bulk-operation hardening, reports, backlinks/QR, final polish
10. Reusable adversarial review gate after EVERY stage

Each stage should start only after the previous stage is accepted.

Do not silently pull work from future stages into an earlier one.

The reason for this split is quota efficiency and reviewability:
- agents spend fewer tokens rediscovering architecture;
- regressions have smaller search spaces;
- concurrency/storage correctness is frozen before document richness;
- media/source work cannot destabilize the core editor unnoticed.

---

# Shared non-negotiable constraints

These apply to every stage.

- Repository: \`Vieuxpepe/transfert-hq\`.
- Work locally on the user's PC.
- Inspect current repository instructions before editing. If \`.cursorrules\` or equivalent exists, follow it.
- Python server remains standard-library-only.
- No Flask, FastAPI, Node server, new pip dependency, frontend framework or build step without explicit approval.
- Browser JS remains plain ES2020.
- No CDN/external fonts/external script dependency.
- Preserve CSP, CSRF, role/auth and \`X-Content-Type-Options: nosniff\`.
- Carnet APIs/content are admin-only unless a later explicit design says otherwise.
- Do not add Carnet routes to upload-role allowlists.
- Never put PINs, session tokens, enrollment/device secrets or note contents into URLs, argv, logs or diagnostics.
- Do not weaken planner/companion architecture.
- Do not convert the companion into SYSTEM/service/admin.
- Use throwaway test roots. Never run feature tests against live \`C:\\Transfert\`.
- Do not silently overwrite malformed runtime state.
- Prefer existing HQ patterns over inventing parallel frameworks.
- Never merge or deploy unless explicitly instructed.
- Keep each stage focused.
- Run \`git diff --check\` before presenting completion.
- Report exact tests, skips and failures. Never claim tests that were not executed.
- Do not claim physical iPhone validation unless it actually happened.

Existing architecture to understand before touching code:
- \`iphone_bridge.py\`
- \`hq_state.py\`
- \`hq_calendar.py\`
- \`cc_ext.py\`
- \`assets/hq-calendar.js/css\`
- \`assets/hq-dessiner.js/css\`
- existing role/CSRF tests
- existing WebKit/Chromium visual tests
- README testing instructions
- \`design.md\`

Important known repository facts from the design session:
- \`hq_state.path_lock(path)\` gives a per-path RLock.
- \`hq_state.write_json_atomic(path, data)\` uses a sibling temp file, flush/fsync and \`os.replace\`.
- malformed existing JSON conventions are fail-closed/preserve.
- global \`api()\` currently throws ordinary Errors for non-2xx JSON and may need a backward-compatible status/data attachment for 409 handling.
- upload role is enforced via explicit allowlists; new admin routes should not be allowlisted.
- \`setView()\` feature hooks must be narrowly guarded by try/catch + \`console.error\` so a broken feature cannot abort HQ startup.
- existing navigation has Accueil, Calendrier, Dessiner, Fichiers, Lecteur, Terminal, Plus.
- startup root migration skips directories and code files; runtime Carnet data belongs under a dedicated hidden directory, not root.
- assets are same-origin and have deterministic MIME mappings.
- existing normal file serving already confines paths to allowed Transfert folders.
- backup currently treats Inbox/Uni/Print specially; do not casually change legacy counter semantics.

---

# STAGE 0 — Local preflight and design assimilation

Use this prompt first. It should not implement the feature.

\`\`\`text
You are the local technical-preflight agent for Transfert HQ Carnet.

Repository: Vieuxpepe/transfert-hq

Goal: prepare an exact implementation map before any Carnet code is written.

DO NOT IMPLEMENT CARNET IN THIS STAGE.
DO NOT MODIFY SOURCE CODE.
Small notes in your response are enough; do not create files unless explicitly asked.

1. Fetch current main and report:
   - current branch
   - HEAD SHA
   - git status --short
   - remotes
   - whether local main matches origin/main

2. Read repository instructions:
   - .cursorrules if present
   - README testing instructions
   - design.md, especially the Carnet section
   If design.md is not on current main, read it from branch docs/carnet-design or commit fe828d6f83396007d300fefd1c44f50fee002294.

3. Inspect and summarize exact integration points:
   - iphone_bridge.py:
     - imports
     - bind_hq / ensure_hq
     - render_app head/assets
     - VIEW_LABELS
     - bottom-nav markup
     - setView()
     - global api()
     - GET routing
     - POST routing
     - upload-role allowlists
     - CSRF path
     - _guard_admin_path
     - existing file/media routes
   - hq_state.py:
     - path_lock
     - write_json_atomic
     - malformed-state conventions
   - hq_calendar.py:
     - binding
     - validation
     - revision conflict conventions
   - cc_ext.py:
     - backup implementation
     - return payload semantics
   - tests:
     - auth/role/CSRF helpers
     - temporary ROOT setup patterns
     - Chromium/WebKit visual harnesses
     - current Node/ES2020 checks
   - current UI CSS breakpoints and bottom-nav layout.

4. Check current main for changes since the Carnet design was prepared.
   List any material mismatch with the design.

5. Produce an exact proposed file map for Stage 1 only:
   CREATE/MODIFY and purpose.
   Do not include future UI files unless Stage 1 truly needs them.

6. Produce an exact command list for validating Stage 1 locally.

7. Identify risks that could invalidate Stage 1 design.

Do not edit.
Do not commit.
Do not push.
Do not merge.
Do not deploy.
\`\`\`

Expected outcome:
- current architecture confirmed;
- exact Stage 1 file list;
- no code changes.

---

# STAGE 1 — Persistence, domain model and HTTP API

Suggested branch:
\`feat/carnet-core\`

This stage deliberately has NO rich UI. Build the reliable server/domain foundation first.

\`\`\`text
You are implementing Stage 1 of Carnet for Transfert HQ.

Read design.md and the Stage 0 report first.

Stay on the existing `main` branch. Do not create or switch branches.

Scope is STRICTLY:
- Carnet persistent domain model
- validation
- optimistic concurrency
- categories/projects domain data required by later UI
- trash semantics
- GET/POST API
- auth/CSRF/role behavior
- backup inclusion
- focused Python/static tests

DO NOT implement:
- Carnet visual tab/editor
- autosave JS
- rich text UI
- source viewer
- PDF viewer
- images
- engineering calculator
- formatting
- exports
- Home Carnet card

A. STORAGE

Create focused module:
hq_carnet.py

Runtime state:
<ROOT>/.hq-carnet/notebook.json

Add .hq-carnet/ to .gitignore.

Use:
hq_state.path_lock(path)
hq_state.write_json_atomic(path, data)

Never accept a client filesystem path.

Malformed/unsupported state:
- preserve existing bytes;
- do not silently reset;
- return controlled error.

No runtime notebook file at repo root.

B. DATA MODEL

Implement a versioned notebook with server-generated IDs.

Long-term schema must be compatible with block content.

Preferred initial page shape:

{
  "id": "page-...",
  "rev": 1,
  "project_id": null,
  "category_id": null,
  "pinned": false,
  "deleted_at": null,
  "created_at": ...,
  "updated_at": ...,
  "content_version": 1,
  "blocks": [
    {
      "id": "block-...",
      "type": "text",
      "text": "",
      "marks": []
    }
  ]
}

If implementing blocks in Stage 1 would materially destabilize autosave, a temporary one-text-block representation is acceptable ONLY if the persisted version explicitly supports migration before Stage 4. Do not store arbitrary HTML.

Notebook fields:
- version
- notebook_rev
- projects
- categories
- pages

Initial limits:
- 128 active pages
- 24 categories
- 48 KiB UTF-8 text per active page
- 1 MiB total active textual content
- bounded project/category names
- server-side enforcement

Server-generated:
- IDs
- revs
- timestamps

Client cannot forge:
- IDs where creation generates them
- rev
- notebook_rev
- created_at
- updated_at
- deleted_at except via explicit actions

C. PROJECTS / CATEGORIES

Implement domain support now even though UI is Stage 3.

Categories:
- id
- name
- color
- created_at
- active/archived only if truly required

Allowed color keys ONLY:
blue, green, amber, coral, violet, pink, teal, graphite

Prefer case-insensitive duplicate category-name rejection.

Projects:
- id
- name
- created_at
- optional preferred_folder field only if safe/necessary; otherwise defer folder linking

Do not add nested category/project trees.

Deleting category:
- never deletes pages
- affected pages category_id -> null
- affected page rev increments
- affected updated_at increments
- notebook_rev increments
- all changes atomic

Deleting/archiving project:
- must not delete pages
- choose/document safe orphan behavior
- affected page revisions must reflect metadata changes if project_id changes

D. PAGE OPERATIONS

Support actions approximately:
- create
- save
- trash
- restore
- permanent_delete only if needed for Corbeille
- category_create/update/delete
- project_create/update/delete or archive

Create:
- expected_notebook_rev
- optional after_id
- optional project_id/category_id
- creates blank page
- server IDs/timestamps

Save:
- expected_rev
- complete editable page state for Stage 1:
  - textual block content
  - project_id
  - category_id
  - pinned
- successful mutation increments page rev/update timestamp

Trash:
- expected page rev
- expected notebook rev if structural ordering changes
- sets deleted_at
- increments page rev
- does not destroy content

Restore:
- expected rev
- clears deleted_at
- increments rev

Permanent delete:
- deep/explicit operation only
- must not accidentally leave zero usable active pages
- if final active page disappears, create safe blank replacement according to documented invariant

E. CONCURRENCY

No silent last-write-wins.

Page mutations require expected_rev.

Stale page save:
HTTP/domain conflict
no disk change
return current page

Structural mutations use expected_notebook_rev.

Different pages must be independently editable without unnecessary conflict.

F. HTTP

Add:
GET /api/carnet
GET /api/carnet?meta=1
POST /api/carnet

Admin-only.

Do NOT add Carnet to upload-role allowlists.

All state mutation uses existing global CSRF flow.

Full GET:
- version
- notebook_rev
- projects
- categories
- pages
- limits

meta=1:
- no complete note bodies
- page id/rev/project/category/pinned/deleted/timestamps
- safe bounded derived first-line preview where practical

Reject invalid query values.

POST action payloads are strict.

Errors:
- 400 invalid payload/limit
- 404 missing entity
- 409 revision conflict
- controlled 5xx for storage failure
No traceback leakage.

G. GLOBAL api() COMPATIBILITY

If needed for later 409 UI, enhance existing browser api() helper backward-compatibly:
- JSON non-2xx Error keeps current message behavior
- attach error.status
- attach error.data
- preserve 401 redirect logic
- preserve 403 behavior
- preserve existing callers

Do not add Carnet-specific auth/network duplication.

If changing api() in this server-only stage is awkward, add explicit tests and defer actual JS use to Stage 2, but freeze the behavior contract.

H. BACKUP

Include the committed Carnet notebook in normal HQ backups.

Preferred snapshot:
<backup>/<timestamp>/Carnet/notebook.json

Use same hq_state.path_lock(notebook_path) while taking coherent snapshot.

Never copy notebook.json.tmp.

Do NOT change historical meaning of existing backup folders count.
Return a separate carnet status field.

Missing Carnet is harmless.

Do NOT add live Carnet restore UI.

I. TESTS

Create focused test_hq_carnet.py or equivalent.

Test:
- initial notebook
- path location
- no runtime root file
- IDs
- create/order
- save/rev
- different-page independence
- stale save conflict/no disk change
- trash/restore
- permanent delete/final-page invariant
- timestamps
- project/category validation
- category color allowlist
- duplicate category policy
- category deletion keeps pages and bumps affected page revs
- stale client cannot resurrect deleted category
- project orphan behavior
- 128-page max
- 24-category max
- 48 KiB UTF-8 page limit
- 1 MiB total limit
- wrong types
- forbidden client metadata
- malformed state preserved byte-for-byte
- unsupported version preserved
- write_json_atomic integration
- concurrent thread writes
- no tmp residue on success
- simulated write failure preserves previous valid file

HTTP tests:
- anonymous 401
- upload role 403 GET/POST
- admin GET
- admin mutation with valid CSRF
- missing/bad CSRF 403 through existing policy
- 400/404/409 payloads
- no Carnet upload allowlist entries
- CSP/nosniff unchanged
- no secrets/note content in logs/URLs

Backup tests:
- existing Inbox/Uni/Print unchanged
- Carnet coherent snapshot
- no .tmp
- missing Carnet safe
- folders count semantics unchanged

Run current repository normal tests appropriate for this change.

Before completion:
git diff --check
git status --short
review full diff

Do not implement Stage 2.
Do not merge/deploy.
Report:
- base SHA
- working branch (`main`)
- files
- schema
- API contract
- exact tests/results
- risks
- git status
\`\`\`

Acceptance gate for Stage 1:
- server model is trustworthy before any editor exists.

---

# STAGE 2 — Core editor, paper UI, local drafts, autosave and conflicts

Suggested branch:
\`feat/carnet-editor\`

Base:
accepted Stage 1 state in the same working tree.

\`\`\`text
You are implementing Stage 2 of Carnet.

Base this work on the accepted Stage 1 Carnet core.

Scope:
- first-class Carnet tab
- beautiful paper editor
- direct typing/focus
- page navigation
- local drafts
- autosave
- pagehide/visibility protection
- multi-device conflict UI
- lightweight remote refresh
- copy/share basic actions
- engineering symbol strip + insert time
- reduced-motion page flip
- responsive/mobile accessibility

DO NOT implement Stage 3 library organization UI beyond the minimum selectors needed to edit existing project/category metadata.
DO NOT implement rich formatting.
DO NOT implement Sources/PDF viewer.
DO NOT implement images.
DO NOT implement calculator/measurements.

A. UI INTEGRATION

Create:
assets/hq-carnet.js
assets/hq-carnet.css
browser tests as needed

Add Carnet immediately after Accueil in main nav if current layout permits without regressing tap targets.

Add:
carnet: "Carnet"
to current view label system.

Add data-panel="carnet" host.

Load same-origin Carnet CSS/JS through current asset mechanism.

setView hook MUST be narrow:
if (view === 'carnet' && window.hqCarnetShow) {
  try { window.hqCarnetShow(); } catch (e) { console.error(e); }
}

Adapt syntax to current code style.

A Carnet JS failure must not break HQ startup or other tabs.

Avoid repeating the old Dessiner failure mode where a missing module leaves permanent "Chargement…" with no durable error.

Provide a real Carnet initialization error surface + retry where appropriate.

B. MOBILE PRODUCT SURFACE

Default Carnet should be mostly paper.

Always-visible minimal controls:
- project/category context pill
- pin
- library placeholder/control
- overflow/tools
- paper
- previous / Page X/Y / next
- new page
- copy

No Save button.
No title input.
No mandatory modal.

Editor text >=16px.

Tap Carnet:
- synchronously create/show editor
- focus current text editor immediately where user-activation allows
- do not wait for network before focusing when safe cached state exists
- never overwrite text typed before a slower network response returns

If first-ever load has no cached server page, preserve integrity: do not invent fake persistent client page IDs. Prefer fast server load/default page path while keeping shell responsive.

C. PAPER LOOK

Use CSS only:
- warm off-white paper
- ruled lines via repeating-linear-gradient
- subtle margin rule
- restrained paper texture via gradients
- system/local handwriting-friendly stack
- dark readable ink
- safe-area support
- no horizontal overflow

No external fonts/assets.

D. PAGE NAVIGATION

Buttons:
- previous
- next
- new page
- quick page indicator
- copy

Keyboard:
- Alt+Left previous
- Alt+Right next while textarea/editable focused
- ordinary Left/Right remain caret movement

Swipe:
- left -> next
- right -> previous
- threshold ~60 CSS px
- abs(dx) > 1.4*abs(dy)
- ignore multitouch
- no early preventDefault
- do not turn text selection/caret gestures into flips

Page switching must not wait for network save.

E. PAGE FLIP

CSS 3D only:
- perspective
- rotateY
- transform-origin based on direction
- backface-visibility
- transform/opacity/shadow only
- ~200–240ms
- no JS rAF loop
- temporary aria-hidden ghost sheet
- cleanup after transitionend

prefers-reduced-motion:
- no 3D flip
- navigation remains fully functional
- no JS waiting for transition that will not happen

F. LOCAL DRAFT PRIVACY

Before reading/rendering local note drafts:
- call/use /api/me
- require role === admin

Namespace draft store by non-secret username:
hq_carnet_drafts_v1:<encoded user>

Prefer a map keyed by page ID so multiple dirty pages can coexist safely when user flips pages offline.

Never store auth/session/PIN data.

Draft record includes enough to recover:
- page id
- base/server rev
- content
- project/category
- pinned
- local generation
- timestamp

If localStorage throws:
- keep in-memory dirty state
- show:
  Sauvegarde locale indisponible — ne ferme pas cette page.
- never falsely show Enregistré

G. SAVE STATE MACHINE

This is the most important part of Stage 2.

Per page track approximately:
- serverRev
- generation
- savedGeneration
- dirty
- inFlight
- conflict
- retry state

On EVERY input:
1. generation += 1
2. synchronously update local draft
3. dirty = true
4. schedule save ~450ms

Also local-draft/update metadata changes such as pin/project/category through the same state machinery.

Only ONE ordinary save may be in flight per page.

When save begins capture:
- sendGeneration
- exact editable payload
- expected_rev

On successful response:
- update serverRev
- set inFlight false

ONLY clear local draft and dirty if:
- current generation === sendGeneration
AND
- current editable state exactly equals sent payload

Otherwise:
- keep draft
- keep dirty
- immediately save newer state against returned serverRev

An older successful response must NEVER clear newer typing.

Network failure:
- inFlight false
- dirty stays true
- draft remains
- show:
  Hors ligne — conservé sur cet appareil
- safe retry on reconnect/activation/new input

H. LIFECYCLE

Attempt immediate flush on:
- blur
- visibilitychange -> hidden
- pagehide
- page switch
- leaving Carnet

Use fetch keepalive where appropriate.

Do not use sendBeacon if CSRF/current headers cannot be preserved safely.

Do not depend on beforeunload.

48 KiB page limit intentionally leaves room for keepalive JSON overhead.

Local draft is the actual durability fallback; never claim pagehide network delivery is guaranteed.

I. CONFLICT UI

On 409:
- never change local text
- preserve local draft
- pause autosave for that page
- retain returned remote page separately

Show durable banner:
Modifié ailleurs. Ta saisie est conservée sur cet appareil.

Actions:
- Charger la version distante
- Remplacer avec ma version

Remote action:
- explicit replacement
- clear only corresponding local draft
- adopt remote rev

Keep local:
- resend CURRENT local state against latest remote rev
- if another remote write occurred, allow another 409 normally

Do not auto-merge.

J. REMOTE REFRESH

While Carnet view AND document are visible:
- lightweight meta refresh around 5–12 seconds (choose/document one value)
- no duplicate intervals
- refresh on activation/visibility return

Clean page with newer remote rev:
- fetch/adopt safely
- subtle "Modifié ailleurs"

Dirty page:
- NEVER overwrite
- let revision logic conflict if save attempted

Coordinate polls with in-flight local saves to avoid false conflict UI from observing own just-saved revision.

K. COPY / SHARE

Copier:
- selected substring if non-empty
- else complete current textual page

navigator.clipboard.writeText first.

Fallback:
- temporary offscreen textarea
- select/setSelectionRange
- execCommand("copy")
- cleanup
- restore focus/selection

Feedback:
Copié
Copie impossible

If navigator.share is safe/easy, expose Share behind overflow, but do not expand Stage 2 if it creates instability.

L. ENGINEERING QUICK STRIP

Collapsible:
Ø ± ° µ Δ × → ≤ ≥ ² ³

Common subset visible.
More behind overflow.

Insert at current cursor/selection.
Preserve focus.

Clock action inserts:
HH:MM — 

Use local display time for insertion unless product architecture explicitly chooses server time; document choice.

Do not interfere with iOS dictation/native textarea behavior.

M. ACCESSIBILITY

- real labels
- >=44px controls
- textarea >=16px
- pin aria-pressed
- page/save status aria-live polite
- conflict announced
- ghost sheet aria-hidden
- visible focus
- reduced motion
- safe bottom-sheet/focus behavior for any Stage-2 overlay

N. TESTS

Add unit/static/browser tests proving:
- tab integration
- hook try/catch + console.error
- initialization failure UI
- immediate focus
- typing
- synchronous local draft
- debounce server save
- delayed save A + newer typing B race
- network failure
- reconnect
- blur/hidden/pagehide
- page switching with multiple dirty drafts
- reload draft recovery
- localStorage failure warning
- admin draft namespace
- upload role cannot see drafts
- same-page two-context conflict
- different-page two-context independence
- conflict remote/local choices
- polling clean vs dirty
- no duplicate timer/listeners
- buttons
- swipe
- vertical gesture no flip
- textarea selection no flip
- keyboard Alt arrows
- clipboard full/selection/fallback
- symbol insertion
- time insertion
- reduced motion
- no external requests
- no pageerror
- no unexpected console errors

Run Chromium iPhone + WebKit iPhone where installed.
Use temp ROOT/fake PIN only.

Run existing relevant visual tests to catch nav regressions.

Do not implement Stage 3.

Before completion:
git diff --check
git status --short
full diff review

Report exact test results and real-device gaps.
\`\`\`

Acceptance gate:
- Carnet is already an excellent simple notebook even if no library exists yet.

---

# STAGE 3 — Library, projects, categories, search, recents, trash and Home integration

Suggested branch:
\`feat/carnet-library\`

Base:
accepted Stage 2.

\`\`\`text
Implement Stage 3 of Carnet on top of the accepted core editor.

Scope:
- polished Bibliothèque
- projects/categories UX
- À classer
- pinned notes
- recents/time grouping
- search
- trash/restore/permanent delete
- desktop sidebar
- mobile bottom sheet
- Home Carnet summary/launcher
- Focus mode

Do NOT implement rich text/links/images/sources/PDF tools.

A. LIBRARY UX

Mobile:
- bottom sheet ~85–90% height
- search at top
- filters:
  Toutes
  Épinglées
  Récentes
  À classer
  custom projects/categories
- result cards
- close
- tap result -> select note -> close -> editor

Desktop >= current project breakpoint:
- left sidebar ~260–300px
- collapsible
- same data/state as mobile
- no second editor

Remember library search/filter within session while opening a note and returning.

B. RESULT CARD

Derived title:
- first non-empty line
- fallback "Page sans titre"

Show:
- title
- 1–2 line safe preview
- project/category
- pin
- relative/short modified time

Use textContent/DOM nodes, never note innerHTML.

C. SEARCH

Client-side.

Normalize:
- lowercase
- accent-insensitive

Search:
- title/first line
- body
- category
- project

Ranking:
1. title match
2. pin
3. body
4. category/project
5. recency tie-break

No network request per search keystroke.

Avoid rebuilding the full editor on search input.

D. PROJECT/CATEGORY UX

Top page context pill compactly shows current context.

Tap -> accessible sheet/popover.

Assignment:
- one/two taps
- include À classer
- include create category/project where appropriate

Category management:
- create
- rename
- recolor from fixed palette
- delete confirmation:
  Supprimer « <name> » ? Les pages seront conservées dans À classer.

Project management similarly avoids destructive page deletion.

When create note from filtered category/project:
- inherit that context automatically

Creating from global/Toutes:
- unclassified by default

E. PIN / RECENTS

Pin control on page.
Pinned virtual filter.

Recents:
- Aujourd'hui
- Hier
- Cette semaine
- older

Use automatic server timestamps.

F. TRASH

Main delete:
- soft delete
- immediate Undo affordance

Corbeille:
- separate/deeper library section
- trashed notes read-only
- restore action
- permanent delete requires explicit confirmation
- no accidental edit that silently restores

G. FOCUS MODE

Provide explicit Focus mode.

Mobile/iPad:
- hide nonessential HQ chrome where safe
- hide library/context clutter
- preserve page/navigation/essential status

Desktop:
- library collapses
- tools stay hidden
- center paper dominates

Escape exits on desktop.
Visible exit action always exists.

H. HOME INTEGRATION

Add a prominent read-only Carnet summary near top of Accueil.

Show safe compact data:
- page count
- pinned count
- up to ~3 recent/pinned derived titles
- project/category markers

Actions:
- Ouvrir le Carnet
- optional Nouvelle note if it uses same single editor/state machine

DO NOT create another editable textarea/autosave system on Home.

For unauthorized/upload role:
- do not expose private Carnet previews.

I. TESTS

Test:
- library sheet mobile
- desktop split layout
- search cases
- accent/case
- ranking
- no HTML execution
- category CRUD
- project CRUD
- context inheritance on new note
- pinning
- recents grouping
- À classer
- soft delete/undo
- trash read-only
- restore
- permanent delete
- Focus mode
- Home summary
- unauthorized Home privacy
- launcher
- no duplicate editor
- target sizes
- nav density
- WebKit/Chromium
- editor autosave regressions from Stage 2

Do not implement Stage 4.

Report exact results.
\`\`\`

Acceptance gate:
- Carnet is now a flagship daily-use notes product before rich documents exist.

---

# STAGE 4 — Rich text, hyperlinks, find/replace, export and publish-to-Transfert

Suggested branch:
\`feat/carnet-rich\`

Base:
accepted Stage 3.

\`\`\`text
Implement Stage 4: rich textual documents.

Before coding, review persisted schema from Stage 1–3 and design.md.

If migration is needed, design a versioned, tested, atomic migration. Never silently discard old pages.

Scope:
- structured text formatting
- contextual selection toolbar
- external hyperlinks
- internal note/HQ links foundation
- checklists
- find/replace
- TXT/Markdown export
- print/PDF presentation path
- explicit publish snapshot into allowed Transfert folders

DO NOT implement Sources/PDF source viewer.
DO NOT implement arbitrary images yet unless schema requires placeholders.

A. DOCUMENT MODEL

Do NOT persist arbitrary HTML.

Use structured blocks/marks.

Formatting:
- bold
- italic
- underline
- highlight
- heading
- bullets
- numbered lists
- checklist
- monospace

Preserve stable block IDs.

Text replacement/editing must keep unaffected marks intact.

B. EDITOR UX

Default remains paper-first.

No permanent formatting ribbon.

On text selection:
compact contextual bar:
B I U Highlight Lien Décision/À faire placeholders if future-safe, •••

Desktop hardware shortcuts:
Ctrl/Cmd+B
Ctrl/Cmd+I
Ctrl/Cmd+U where safe

Do not break iOS selection handles/native editing.

C. EXTERNAL HYPERLINKS

Selected word/sentence -> Lien.

Smart-paste may offer selected-text linking.

Allow only:
http:
https:

Reject javascript:, data:, file:, custom unsafe schemes.

Render normal link safely:
target=_blank
rel=noopener noreferrer

Do not fetch URL server-side.

D. INTERNAL LINKS

Support structured references to:
- another Carnet note
- allowed Transfert file
- Dessiner drawing/model/media where current routes safely support it

Store stable entity references, not brittle generated HTML.

Provide visible UI; [[note]] autocomplete may be optional if simple.

Do not introduce backlink graph complexity yet unless trivial.

E. CHECKLISTS

Clickable checklist items remain part of document.
Changing check state uses normal page revision/autosave.

F. FIND / REPLACE

••• -> Rechercher et remplacer

Default scope:
Cette note

Fields:
Rechercher
Remplacer par

Empty replacement is valid and deletes matches.

Controls:
previous/next
replace one
replace all
optional:
- case-sensitive
- whole word

No regex in default UI.

For active-note replace-all:
- show occurrence count
- confirm meaningful destructive operation
- support immediate Undo in memory/history mechanism available

If wider scopes are implemented in this stage:
- must be explicit selection
- show count of occurrences AND affected notes
- preview
- confirmation
- revision-aware application
- Undo

Structured citations (future) are not plain-text replaced.

G. EXPORT

TXT:
- portable text
- optional metadata header

Markdown:
- headings
- lists/checklists
- formatting
- hyperlinks
- stable readable metadata

Print/PDF:
- print-optimized browser view
- no new pip dependency
- let Safari/Chrome Print -> PDF initially

JSON:
- optional advanced structured export if useful

H. PUBLISH TO TRANSFERT

Explicit:
Enregistrer une copie dans Transfert…

Allowed destinations follow current confined file model:
Inbox
Uni
Print
safe subfolders

Live Carnet remains source of truth.
Published file is a snapshot.

No silent overwrite.
Generate safe filename from:
date + derived title
Allow user edit.

Remember optional linked export:
- path
- exported revision/time

If note changes later:
Modifié depuis l'export

Explicit:
Mettre à jour la copie

Do not make external file edits sync back into Carnet.

I. TESTS

Test:
- schema migration
- old plain notes retained
- formatting persistence
- selection formatting
- iOS selection regression
- safe hyperlinks
- unsafe schemes rejected
- internal links
- checklist
- find/replace current note
- empty replacement deletion
- whole-word/case
- mark preservation
- undo
- TXT
- Markdown
- print layout
- path confinement
- noclobber
- export metadata
- linked export dirty state
- existing autosave/conflict behavior with structured content

Do not implement Stage 5.
\`\`\`

Acceptance gate:
- Carnet can now replace many commercial text-note workflows while remaining quick.

---

# STAGE 5 — Sources, citations, edition lineage and exact PDF-page navigation

Suggested branch:
\`feat/carnet-sources\`

Base:
accepted Stage 4.

\`\`\`text
Implement Stage 5: engineering Sources / Références.

This stage is about precision, provenance and fast verification.

Scope:
- source library
- source families + editions/revisions
- citations
- locator types
- project-preferred/recent sources
- local Transfert PDF linking
- exact PDF-page navigation
- source-viewer return-to-note workflow
- citation creation from source viewer
- verified-locator status
- source supersession/migration
- safe bulk source migration

Do not implement media note attachments here.

A. SOURCE MODEL

Separate:
source_family
source_edition

Family example:
Shigley's Mechanical Engineering Design

Edition records:
11e
12e

Fields as appropriate:
- id
- family_id
- title
- author/organization
- edition/revision
- year
- publisher
- ISBN/document number
- type
- URL
- linked Transfert file reference
- notes
- created_at/updated_at
- archived/superseded metadata

Types:
book
standard
article
datasheet
manufacturer_catalogue
internal_procedure
web
other

Changing edition/revision creates a new edition record.
Do not mutate old edition into new edition.

Source removal/archive must not break old citations.

B. CITATION MODEL

Citation stores:
- source edition ID
- semantic locator
- optional actual PDF page
- snapshot of essential display metadata for historical readability
- verified_location boolean + verification time/user if useful
- supersession history when migrated

Locator kinds:
page
section
clause
chapter
figure
table
custom

Examples:
Shigley 12e · p. 417
ASME Y14.5-2018 · §7.4.2
ISO 286-2 · Table 2

C. FAST INSERT UX

From note:
Référence

Picker prioritizes:
1. recent sources
2. project-preferred sources
3. library search

Then optional locator entry.

Optimize common path to ~3 interactions:
Référence -> Shigley -> 417 -> done

Do not require a full bibliography form during citation insertion.

D. LOCAL DOCUMENT LINK

A source edition may point to an existing allowed Transfert PDF.

Store a safe confined relative file reference, never arbitrary absolute path.

Citation tap:
- open exact source
- ideally exact page
- preserve back-to-note context

E. PDF PAGE MODEL

Keep distinct:
- printed/semantic page shown to user
- actual PDF page index

Example:
visible p.417
pdf_page 439

Do not assume they match.

Support optional calibration:
"Définir comme page 1"

Store offset/mapping safely.

Future mapping ranges may support:
- Roman front matter
- appendices
- discontinuous numbering

F. SOURCE VIEWER

Long-term reliability must not depend solely on browser #page=.

If introducing a locally vendored PDF renderer:
- no CDN
- first-party static assets
- license tracked in repo
- CSP compatible
- no new server runtime dependency
- deterministic asset MIME
- review bundle provenance/license carefully

Viewer capabilities:
- exact page
- current page display
- prev/next
- zoom
- source title/edition
- Retour à la note
- Citer cette page

If a full bundled viewer is too large for one safe PR, implement a reviewed first step with browser #page= fallback plus the data model and a follow-up viewer substage. Do not pretend cross-browser reliability is solved if it is not.

G. VERIFIED LOCATION

Allow:
✓ Emplacement vérifié

Meaning only:
user verified the citation points to the claimed place.

Never label the information itself "true" or create automated trust scores.

H. SUPERSESSION / REPLACEMENT

When newer edition exists:
old citation remains historically correct.

Show:
Nouvelle édition disponible

Migration UI:
old edition + old locator
new edition + required/optional new locator

NEVER automatically carry old page number to new edition.

Allow:
- keep old
- migrate with verified new locator
- migrate with "emplacement à vérifier"

Preserve:
replaced_from edition + locator.

I. BULK SOURCE MIGRATION

For source edition with many citations:
- count citations
- list affected notes
- review individually
- allow per-citation new locator
- skip
- preview
- explicit confirm
- revision-aware updates
- Undo/history event if history foundation exists

Never blind-rewrite all citations.

J. TESTS

Test:
- source CRUD
- edition families
- archive/remove preserves citations
- citation snapshots
- locator types
- recent/project source ranking
- safe local PDF path
- page mapping/calibration
- exact jump request generation
- browser viewer behavior in Chromium/WebKit
- return-to-note
- cite-this-page
- verified-location semantics
- new-edition notice
- single migration
- unknown new location
- bulk migration preview/skip/undo
- old provenance retained
- no unsafe external URLs
- no cross-root file access

Do not implement Stage 6.
\`\`\`

Acceptance gate:
- a citation can answer "where exactly did this come from?" in seconds.

---

# STAGE 6 — Images and media attachments

Suggested branch:
\`feat/carnet-media\`

Base:
accepted Stage 5.

\`\`\`text
Implement Stage 6: images/media inside Carnet.

Scope:
- camera/photos/files insertion
- confined asset storage
- image downscale/compression path
- inline image blocks
- resize
- captions
- optional safe free-position mode if robust
- export/backup integration

Do not build full annotation/Dessiner subset unless core media is stable.

A. STORAGE

Binary assets under:
<ROOT>/.hq-carnet/assets/

Never in notebook JSON.

Notebook stores:
- generated asset ID
- MIME
- dimensions
- block layout
- caption
- metadata

No client path.

Initial formats:
JPEG
PNG
WebP

HEIC only if target browsers/server handling is proven; otherwise reject/convert client-side if reliable.

Define explicit per-image and total quotas.

Suggested initial:
- max 12–16 MiB upload input
- browser downscale long side to ~2560px for notebook copy
- global notebook media quota around 250 MiB, configurable only if architecture supports safely

Do not silently discard original when user expected archival quality; document that Carnet stores an optimized notebook copy.

B. UPLOAD

Reuse proven HQ streaming/chunk patterns where appropriate.

Require:
- admin auth
- CSRF
- content-length limits
- signature/type validation
- generated asset names
- atomic finalize
- confined directory
- cleanup failed partial uploads

C. UI

Add image via:
- camera
- photos
- files

Default layout:
INLINE.

Image appears between content blocks.

Resize:
~30% to 100% page width
touch-friendly handles
preserve aspect ratio default

Selection shows contextual tools only.

Caption supported.

Optional:
Position libre
only if robust across iPhone/iPad/desktop and exports.

Do not make free-floating default.

D. FREE POSITION, IF IMPLEMENTED

Store relative page coordinates, not raw desktop pixels.
Keep within paper bounds.
Responsive strategy must be explicit.
Dragging must not fight page swipe/text selection.
Resize handles >=44px touch affordance where practical.

If this cannot be made robust in Stage 6, defer it. Inline media is more important.

E. BACKUP / EXPORT

Carnet backups include referenced assets coherently.

Never back up temp/partial uploads.

Markdown export:
relative asset folder or documented packaging.

Print/PDF:
images render with correct size/caption.

Publish-to-Transfert:
copy all required referenced assets safely or flatten where format requires.

F. TESTS

Test:
- JPEG/PNG/WebP
- invalid signatures
- oversized input
- quotas
- path traversal
- interrupted upload cleanup
- binary not embedded in JSON
- insert
- resize
- caption
- reload
- conflict/edit
- backup
- export
- mobile camera/file input where automation permits
- WebKit layout
- no memory explosion with large image

Do not implement full annotation unless separately approved.
\`\`\`

Acceptance gate:
- photos become useful engineering evidence without destabilizing notes.

---

# STAGE 7 — Engineering tools and deep HQ integration

Suggested branch:
\`feat/carnet-engineering\`

Base:
accepted Stage 6.

\`\`\`text
Implement Stage 7: focused engineering superpowers.

These tools must remain behind contextual/collapsible UI.
Do not pollute the default paper surface.

Scope:
- unit conversion
- safe calculator
- calculation blocks
- measurement/tolerance blocks
- Engineering Journal / Session mode
- decision markers
- task extraction
- richer links to HQ files/drawings/models
- optional image annotation integration if mature

A. SAFE CALCULATOR

Never eval/new Function.

Implement a small parser with explicit allowed grammar.

Start with:
+ - * / ^ parentheses
common functions only if tested
explicit angle convention

Errors are controlled.

No arbitrary identifiers/code execution.

B. UNIT CONVERSION

Support a curated engineering set first:
- mm <-> in
- N <-> lbf
- N·m <-> lb·ft
- bar <-> psi
- °C <-> °F
- kg <-> lb

Selection-based contextual action.

Prefer inserting converted result adjacent to source rather than destroying original.

Preserve appropriate precision/significant digits policy; do not invent false measurement precision.

C. CALCULATION BLOCK

Structured block keeps:
- expression/input
- result
- units
- optional timestamp

Example:
F = 350 N
r = 0.125 m
T = 43.75 N·m

D. MEASUREMENT BLOCK

Fields:
- label
- observed value/unit
- optional nominal
- optional tolerance
- timestamp
- optional linked source/photo/drawing

If tolerance present:
calculate deviation and in/out result.

Make clear this is convenience notation, not certified metrology.

Avoid false precision.

E. ENGINEERING JOURNAL / SESSION

Provide:
Journal du jour
and/or explicit Session mode.

Session remains a note, not a form.

One-tap timestamp insertion.

Optional session metadata:
- project
- start/end
- context

F. DECISION MARKER

Structured:
DÉCISION · time
text

Filterable later in library/project.

G. TASK EXTRACTION

Selected text -> Ajouter à À faire

Use existing HQ task/queue system only if semantics fit.
Leave original text unchanged.
Link created task back to note where possible.

Do not create a second task framework.

H. HQ LINKS

Make internal links excellent:
- files
- Dessiner
- Lecteur
- other notes
- project

From Dessiner/Lecteur/File views, optional:
Ajouter une note liée
only if it can route into the single Carnet editor safely.

I. IMAGE ANNOTATION

If implemented:
reuse a deliberately small subset of Dessiner concepts:
- arrow
- circle
- freehand
- dimension line
- text label

Store annotations as structured overlay data, not burned into original asset unless exporting a flattened copy.

Do not fork the full Dessiner application into Carnet.

J. TESTS

Test:
- parser safety
- conversion correctness
- precision rules
- tolerance boundaries
- Celsius/Fahrenheit affine conversion
- calc persistence
- session timestamps
- decisions
- task extraction
- HQ link navigation/back
- no arbitrary command execution
- no unsafe path
- mobile contextual tools remain collapsed by default
- accessibility
- performance

Do not implement Stage 8 extras unless explicitly requested.
\`\`\`

Acceptance gate:
- engineering tools save time but do not make capture slower.

---

# STAGE 8 — History, bulk operations, reports, backlinks/QR and final product hardening

Suggested branch:
\`feat/carnet-history-reports\`

Base:
accepted Stage 7.

\`\`\`text
Implement the final planned refinement stage.

Scope only after previous stages are stable:
- note version history
- robust reusable bulk-operation framework
- wider-scope find/replace
- source migration history
- backlinks
- QR/physical links if safe
- engineering report assembly/export
- final performance/accessibility polish

A. VERSION HISTORY

History behind:
••• -> Historique

Do not spam a full snapshot for every keystroke if that causes unreasonable growth.

Create meaningful checkpoints/events:
- user edit consolidation
- find/replace
- source migration
- restore
- bulk category/project move

Restoring:
- creates a new current revision
- never deletes intervening history

B. BULK OPERATION FRAMEWORK

Common flow:
1. scope
2. affected count
3. preview
4. confirm
5. revision-aware application
6. Undo
7. one logical history event

Use for:
- multi-note find/replace
- project/category moves
- source migration
- archive/trash
- linked-file replacement

Partial failures must be explicit; do not leave ambiguous state.

C. BACKLINKS

Internal note links should surface:
Liée depuis…

No expensive global rebuild on every keystroke.
Use bounded/indexed metadata or compute from small notebook content safely.

D. QR / PHYSICAL LINKS

Optional:
generate QR for note/project.

QR must contain a safe HQ URL/reference, never secrets/session tokens/PINs.

Scanning should still require normal HQ authentication.

E. REPORT GENERATION

Select project notes/measurements/photos/decisions/sources.

Generate an ordered report view/export:
- title/project
- date range
- selected notes
- measurements
- decisions
- citations
- images
- source list

Outputs:
- Markdown
- print/PDF
- possibly HTML download-only if security reviewed

Do not auto-author engineering conclusions.
Preserve source note content and references.

F. FINAL HARDENING

Profile:
- editor input latency
- large-notebook search
- many citations
- many images
- library rendering
- WebKit memory
- source viewer transitions

Audit:
- accessibility
- reduced motion
- keyboard
- touch targets
- local draft privacy
- backup footprint
- recovery
- logs
- path confinement
- CSP/CSRF

G. TESTS

Add stress-ish tests at project limits:
- 128 pages
- near 1MiB text
- many categories/projects
- many citations
- realistic image count
- history retention policy
- bulk replace
- undo
- report
- backlinks
- QR no-secret check

Run full regression suite.

Final report should explicitly separate:
- proven automated behavior
- desktop browser validation
- WebKit automation
- physical iPhone/iPad validation if any
- remaining long-term risks
\`\`\`

---

# REUSABLE ADVERSARIAL REVIEW GATE — run after every stage

Use this after the implementation agent finishes a stage and before accepting the stage.

\`\`\`text
You are the adversarial reviewer for the current Carnet stage.

Do NOT begin by editing.

1. Identify:
   - base SHA
   - head SHA
   - branch
   - git status
   - diff stat
   - complete changed-file list

2. Read:
   - complete diff against accepted base
   - design.md Carnet specification
   - this stage's original prompt
   - all new/modified tests
   - surrounding existing code

3. First report findings only, severity ordered:
   CRITICAL
   HIGH
   MEDIUM
   LOW

Focus on defects, not style preferences.

4. Attack the stage's core guarantees.

Always check:
- auth/role/CSRF
- CSP/nosniff
- secrets/content in logs/URLs
- path confinement
- malformed-state preservation
- atomic writes
- stale revision behavior
- local draft privacy where relevant
- old-response/new-typing races where relevant
- duplicate listeners/timers
- unsafe innerHTML
- WebKit/iPhone behavior
- reduced motion
- backup coherence
- test-root safety

5. Check scope:
   - no unrelated refactor
   - no accidental future-stage features
   - no weakened existing tests
   - no generated/temp artifacts

6. Reproduce meaningful issues with tests where possible.

7. ONLY AFTER reporting findings:
   fix confirmed defects that are clearly in scope.

Do not perform cosmetic refactors.

8. Re-run:
   - focused tests
   - full relevant suite
   - current py_compile/SyntaxWarning checks
   - Node checks
   - browser tests relevant to changed UI
   - git diff --check

9. Final report:
   - findings
   - fixes
   - exact test results
   - remaining risks
   - final diff stat
   - git status

Do not merge/deploy.
\`\`\`

---

# FINAL DELIVERY GATE — use when a stage is ready for GitHub

\`\`\`text
You are the release gate for the current accepted Carnet stage.

Do not redesign the feature.

1. Fetch current remote refs.
2. Verify current branch is still `main` and the working tree contains the intended accepted predecessor.
3. git status --short
4. git diff --check
5. review complete diff
6. verify no temp roots/screenshots/browser artifacts/runtime notebook/secrets
7. run final required test suite again on final tree
8. if anything is red, stop and report

Security gate:
- role/auth unchanged except intentional routes
- CSRF unchanged
- CSP unchanged
- nosniff unchanged
- no secret/content URL leakage
- no external loads
- fixed confined storage
- no malformed-state overwrite
- no live C:\Transfert test data

Data-integrity gate as relevant:
- revisions
- local drafts
- conflicts
- atomic writes
- backups
- migrations

If green and explicitly authorized:
- create one focused commit on current `main`
- push `main` only if push is also explicitly authorized
- do not create a PR/feature branch in this workflow
- do not merge
- do not deploy

PR body:
- Summary
- Scope
- Architecture
- Security
- Data integrity
- Tests
- Browser/real-device status
- Out of scope / next stage

Return:
- base/head SHA
- commit SHA
- branch
- diff stat
- exact tests
- GitHub checks if visible
- final git status
- confirmation no branch/worktree/clone/merge/deploy
\`\`\`

---

# Quota-saving operating instructions for local agents

To minimize agent token/quota consumption:

1. Give the agent ONLY the current stage prompt plus access to \`design.md\`.
2. Do not paste the entire conversation.
3. Ask it to inspect named files directly instead of restating them.
4. Reuse existing tests/helpers instead of generating duplicate harnesses.
5. Tell the implementation agent not to explain every trivial edit; require concise checkpoints only.
6. Keep one stage per fresh context if the coding environment benefits from context isolation.
7. Run the adversarial reviewer in a separate context so it does not inherit implementation assumptions.
8. Feed the reviewer the working-tree diff, not the builder's narrative.
9. Do not ask agents to "improve anything else they notice."
10. Freeze out-of-scope future stages explicitly.
11. If a stage encounters an architectural mismatch, require a short report before expanding scope.
12. Prefer tests that encode invariants so later agents can rely on executable behavior rather than rereading prose.

# Working-tree progression

All accepted stages accumulate in the same local `C:\Transfert` working tree on `main`:

```text
main working tree
  Stage 01 core
  + Stage 02 editor
  + Stage 03 library
  + Stage 04 rich
  + Stage 05 sources
  + Stage 06 media
  + Stage 07 engineering
  + Stage 08 history/reports
```

Do not create/switch feature branches, worktrees, or clones. Review after each stage. Commit/push only when explicitly authorized.

# Product invariant to repeat to every agent

Carnet may become extremely powerful, but opening it should always feel like opening a small engineering notebook:

**paper, cursor, type.**

Every advanced capability must earn its place without making that first interaction slower or more confusing.
