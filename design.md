# Design notes

## Planned: 3D view translation pan

**Status:** not implemented (requested by Emie; kept here so it is not lost).

**Current behavior** (`assets/hq-solid-view.js`):
- One-finger / mouse drag orbits the model. The yaw direction was fixed so the model follows the drag horizontally; pitch already followed it vertically (clamped to ±1.48 rad).
- Wheel and two-finger pinch zoom (0.15×–10×).
- `state.panX` / `state.panY` exist and are applied in `projectPoint`, but no gesture changes them, so the model can't be moved sideways. `reset()` already zeroes them.

**Proposed gestures** (same vocabulary as 2D Dessiner and the face sketch):
- Touch: two-finger drag pans (combined with the existing pinch zoom, as in the face sketch). One finger keeps orbiting.
- Mouse: right-button or middle-button drag, or Shift + left drag, pans. Plain left drag keeps orbiting. Suppress the context menu on the canvas.
- Wheel keeps zooming.

**Behavior:**
- The model follows the pointer: a drag of (dx, dy) CSS px moves the projected model by exactly (dx, dy) on screen, whatever the orbit angle or zoom. Pan is in screen space: convert the pixel delta to clip space (account for the aspect divisor on x and the canvas CSS size vs backing size) and add it to `panX` / `panY`.
- Zoom should stay anchored sensibly with a pan applied (ideally zoom around the pinch centre or the cursor).
- A fit / "Recadrer" action (and the existing reset) sets `panX = panY = 0` and re-frames the model.
- Taps under 6 px must still select faces or edges, and a pan gesture must never select.

**What to test:**
- Offline (`tests/check_hq_3d_nav.mjs` style, stub canvas): after a pan drag, a projected vertex moves by the drag delta in screen pixels, in both axes, at several yaw/pitch/zoom values; orbit and zoom directions are unchanged; reset/Recadrer clears the pan.
- Browser (`tests/visual_dessiner_3d_playwright.py`): right-drag and Shift+drag on desktop, and a two-finger CDP touch drag on the iPhone profile, move the model with the pointer; one-finger drag still orbits; face and edge picking still hit the right element after panning (`faceAt` / `edgeAt` go through the same projection).


---

# Carnet — flagship engineering notebook design

**Status:** design / architecture specification only. Not implemented yet.

**Design baseline:** this specification was consolidated while \`main\` was at \`d7e7eb3f2a293303ab258c69fda7f104c245022d\` (2026-09-29). Implementation agents must always inspect current \`main\` before coding and adapt to repository changes.

## 1. Product vision

Carnet should become one of Transfert HQ's defining features: a fast, trustworthy, long-lived engineering notebook that feels as immediate as paper while taking advantage of everything HQ already knows about files, drawings, models, projects, backups, phones and PCs.

The north star is:

> Capture a thought in under one second, and find / verify / reuse it months or years later in a few seconds.

Carnet must not become a generic "mini Notion". It should remain paper-first, quiet, fast and confidence-inspiring.

The default interaction is always:

1. Open Carnet.
2. Cursor is ready.
3. Type.
4. Forget about saving.

Organization, sources, formatting, images, calculations and engineering tools appear only when requested.

## 2. Core product principles

### 2.1 Capture before organization

No title prompt. No mandatory project. No mandatory category. No Save button. No blocking modal before typing.

A new note may inherit the currently selected project/category, otherwise it goes to a virtual "À classer" state.

### 2.2 Paper first

On mobile, approximately 90% of the visible experience should be the page. Controls stay compact and contextual.

The empty state is simply clean paper with a blinking cursor.

### 2.3 Progressive disclosure

Always-visible controls should be minimal:
- project/category context pill;
- pin;
- Bibliothèque;
- overflow / tools;
- previous/page/next;
- new note;
- copy.

Everything else belongs one tap deeper.

### 2.4 Reliability over cleverness

Never silently lose or overwrite user text.

No silent last-write-wins. Local drafts protect keystrokes. Server saves use optimistic revisions. Conflicts are explicit.

### 2.5 Precision and provenance

Engineering notes should make it fast to answer:
- What did I write?
- When?
- For which project?
- What source supported it?
- Which edition/revision?
- Which page/section?
- Can I open the exact source location now?
- What changed later?

### 2.6 Long-term ownership

All important data stays in Transfert HQ controlled storage and backups. The system should remain useful without external cloud services, external fonts, CDNs or vendor lock-in.

## 3. Architecture constraints inherited from Transfert HQ

Implementation must preserve current project invariants:

- Python standard-library server only.
- No Flask/FastAPI/Node runtime/new pip dependency without an explicit future architectural decision.
- Browser-only clients on phone/iPad/desktop.
- Plain ES2020 JavaScript/CSS; no build step.
- No external/CDN assets.
- Existing CSP, CSRF, role/auth and nosniff protections remain.
- Carnet API is admin-only; upload role remains denied.
- Secrets never appear in URLs, logs, UI diagnostics or process arguments.
- Runtime data does not create arbitrary files at repository root.
- Use \`hq_state.path_lock()\` and \`hq_state.write_json_atomic()\` for committed JSON state.
- Malformed existing state is preserved, not silently reset.
- Tests use throwaway roots, never live \`C:\\Transfert\`.

## 4. Phased delivery

The complete vision is large and must not ship as one giant PR.

### Phase A — Foundation / flagship Carnet

Ship the dependable notebook:
- instant editing;
- beautiful paper UI;
- autosave + local drafts;
- multi-device conflicts;
- automatic timestamps;
- projects;
- categories / À classer;
- pinning;
- recents;
- local search;
- Bibliothèque;
- trash + undo;
- engineering symbol strip;
- time insertion;
- copy/share;
- backup;
- Accueil integration;
- block-capable document schema, even if first implementation uses only text blocks.

### Phase B — Rich text + export

Add:
- bold / italic / underline / highlight;
- headings;
- bullets / numbered lists / checklists;
- monospace;
- external hyperlinks;
- internal note links;
- TXT export;
- Markdown export;
- print/PDF flow;
- publish snapshot into Transfert folders;
- linked-export metadata.

### Phase C — Sources / references

Add:
- engineering source library;
- books, standards, articles, datasheets, manufacturer catalogues, internal procedures, web pages;
- editions / revisions;
- citations;
- optional page/section/clause/table/figure locators;
- exact local-PDF page jumps;
- source families and supersession;
- verified locator status;
- project-preferred sources;
- source replacement / migration workflow.

### Phase D — Media

Add:
- photos/images from camera/photos/files;
- confined attachment storage;
- image compression/downscaling;
- inline sizing;
- optional free positioning;
- captions;
- export integration;
- later annotation.

### Phase E — Engineering tools

Add:
- unit conversion;
- safe calculator;
- measurements / tolerance checks;
- engineering journal / test sessions;
- decision markers;
- calculations;
- task extraction;
- drawing/model/file links;
- report generation.

Each phase should be independently reviewable and preserve the simple core experience.

## 5. Foundation data model

Do not permanently lock Carnet to one raw page string if rich content is expected later.

Recommended long-term page shape:

\`\`\`json
{
  "version": 1,
  "notebook_rev": 14,
  "projects": [],
  "categories": [],
  "pages": [
    {
      "id": "page-e3977ce845694312",
      "rev": 12,
      "project_id": null,
      "category_id": null,
      "pinned": false,
      "deleted_at": null,
      "created_at": 1790680010.0,
      "updated_at": 1790680300.0,
      "content_version": 1,
      "blocks": [
        {
          "id": "block-...",
          "type": "text",
          "text": "Check bearing preload",
          "marks": []
        }
      ]
    }
  ]
}
\`\`\`

The initial implementation may use a simpler text representation if that materially reduces risk, but migration to block content must be planned before schema commitment.

### Limits for foundation

Initial target:
- max 128 active pages;
- max 24 custom categories;
- max 48 KiB UTF-8 textual content per page for lifecycle-save safety;
- max 1 MiB total textual notebook content before media;
- category/project names bounded and server validated.

Future media gets a separate binary quota and must not be stored in notebook JSON.

## 6. Automatic timestamps

Every note gets server-generated:
- \`created_at\`;
- \`updated_at\`.

Users do not manually edit these.

The page UI shows them subtly, e.g.:
- \`Aujourd’hui · 14:42\`
- \`Modifiée 14:47\`.

Bibliothèque groups by time:
- Aujourd’hui;
- Hier;
- Cette semaine;
- older.

A note-info sheet can show exact creation and modification timestamps.

### Time insertion

Separate from metadata, an explicit quick action inserts a timestamp at the cursor:

\`14:47 — \`

This is especially useful for experiments, troubleshooting and lab/test sessions.

The engineering quick strip may expose a small clock button for this.

## 7. Projects and categories

Use both because they answer different questions.

- **Project:** what is this work for?
- **Category:** what kind of note is this?

Neither is mandatory for capture.

### Virtual filters

Always available:
- Toutes;
- Épinglées;
- Récentes;
- À classer.

"À classer" is preferred UX wording over "Sans catégorie".

### Custom categories

User-created, up to 24 initially.

Fields:
- id;
- name;
- fixed palette color;
- created_at.

Allowed color keys only:
- blue;
- green;
- amber;
- coral;
- violet;
- pink;
- teal;
- graphite.

No arbitrary CSS strings from clients.

Deleting a category never deletes pages. Pages become unclassified.

Every affected page must have its page revision incremented when category deletion changes its \`category_id\`, so stale clients cannot silently resurrect deleted classification.

### Projects

Projects should be similarly optional and lightweight.

A new note created while browsing a project inherits that project automatically.

Projects can later define:
- preferred Transfert folder;
- preferred engineering sources;
- linked files/drawings/models.

## 8. Pinning, recents and retrieval

Pin is first-class page metadata.

Bibliothèque prioritizes:
1. relevant search results;
2. pinned notes;
3. today/recent notes;
4. older notes.

Opening an old note always reopens it as a normal editable page. There is no separate "view mode" for ordinary notes.

Trashed notes remain read-only until restored.

## 9. Search

Foundation search should be client-side while notebook text remains capped around 1 MiB.

Search over:
- derived title / first non-empty line;
- body text;
- category;
- project.

Case-insensitive and accent-insensitive.

Ranking should favor:
1. title/first-line matches;
2. pinned notes;
3. body matches;
4. category/project matches;
5. more recently modified items as tie-breaker.

Search highlighting must never mutate actual note text or use unsafe HTML.

## 10. Mobile UI

The default mobile view should be extremely restrained.

Concept:

\`\`\`text
┌──────────────────────────────────┐
│ Atelier · Projet moteur ▾  ★  •••│
│                                  │
│   Aujourd'hui · 14:42            │
│                                  │
│   ───────────────────────────    │
│   shaft Ø12 ±0.02 mm             │
│   ───────────────────────────    │
│   check bearing preload          │
│   ───────────────────────────    │
│                                  │
│                                  │
│ ‹          Page 3 / 18         › │
│        +          Copier          │
└──────────────────────────────────┘
\`\`\`

No permanent formatting ribbon.

No giant empty-state card.

No Save button.

### Bibliothèque on mobile

Open as a polished bottom sheet occupying roughly 85–90% height.

Contains:
- search;
- Toutes;
- Épinglées;
- Récentes;
- À classer;
- projects;
- categories;
- create/manage category;
- matching/recent notes;
- Corbeille.

Tap result -> select page -> close sheet -> return to editing.

## 11. Desktop UI

At desktop widths, use a two-pane or optional three-pane workspace:

- collapsible left library;
- dominant center paper;
- optional collapsed engineering tools rail on the right.

The left sidebar may show:
- search;
- virtual filters;
- projects;
- categories;
- recent/matching notes.

The right tools rail stays collapsed by default.

Same document/editor state drives mobile and desktop. Do not build two independent editors.

## 12. Focus mode

Provide an optional Focus mode, especially valuable on iPad.

Focus mode hides:
- global HQ chrome where practical;
- library;
- category management;
- extra controls.

Keep only:
- paper;
- minimal navigation;
- keyboard / quick symbols.

Escape or a clear visible control exits Focus mode.

## 13. Progressive engineering tool UI

Do not expose engineering complexity by default.

A compact \`•••\` / \`Outils\` action can reveal:
- symbols;
- insert time;
- calculation;
- unit conversion;
- measurement;
- decision;
- share/export;
- info;
- trash.

Deeper tools appear only after selecting the relevant action.

## 14. Engineering symbol strip

A compact, collapsible strip above the lower controls/keyboard:

\`Ø  ±  °  µ  Δ  ×  →  ≤  ≥  ²  ³\`

Most common subset visible first; \`•••\` expands.

User can hide it and the preference is remembered locally.

This should never interfere with native keyboard dictation.

## 15. Autosave and local durability

Every text input must synchronously protect the current editable state locally before waiting for the network.

Per-page client state should track approximately:
- server revision;
- local generation;
- last saved generation;
- dirty;
- in-flight;
- conflict.

Input:
1. generation++;
2. update local draft immediately;
3. mark dirty;
4. debounce network save (~450 ms).

Flush attempts on:
- debounce;
- blur;
- visibility hidden;
- pagehide;
- page switch;
- leaving Carnet.

Lifecycle network delivery is best effort. Local draft is the durability fallback.

### Local draft privacy

Do not read/render Carnet local drafts until \`/api/me\` confirms an admin session.

Namespace drafts by authenticated username (non-secret), so a later upload-role session or another admin identity using the same browser cannot see another user's unsynced content.

If localStorage fails, keep memory state and show:

> Sauvegarde locale indisponible — ne ferme pas cette page.

Never falsely say "Enregistré".

## 16. Save ordering / late responses

Never run two ordinary saves concurrently for the same page.

When a save starts, capture:
- generation;
- content;
- project/category;
- pin;
- expected server revision.

On success:
- adopt returned server rev;
- clear dirty/local draft only if the current generation and editable state still exactly match the sent payload;
- otherwise immediately queue the newer state against the new server rev.

An older successful response must never clear a newer draft.

## 17. Multi-device conflict model

No silent last-write-wins.

Page mutations use optimistic \`expected_rev\`.

Stale save -> HTTP 409 with current server page.

Client keeps local text exactly as typed and shows:

> Modifié ailleurs. Ta saisie est conservée sur cet appareil.

Actions:
- Charger la version distante;
- Remplacer avec ma version.

Automatic save pauses for that page until conflict is resolved.

Different pages should remain independently editable.

Structural operations use \`notebook_rev\`.

## 18. Cross-device refresh

While Carnet is visible and the document is visible, perform lightweight metadata refreshes.

Pause when hidden.

Refresh on return to visibility / Carnet activation.

A clean local page can adopt a newer remote revision.

A dirty local page must never be silently overwritten.

## 19. Trash and Undo

Delete from the main editor should be soft delete.

Page gets \`deleted_at\` and revision bump.

Immediately offer Undo.

Bibliothèque includes Corbeille.

Trashed notes are read-only until restored.

Permanent deletion is a deeper explicit action.

Do not auto-purge in the initial version.

## 20. Text formatting

Rich content phase should support a restrained set:
- bold;
- italic;
- underline;
- highlight;
- heading;
- bullets;
- numbered lists;
- checklist;
- monospace/code.

Do not show a Word-style toolbar permanently.

When text is selected, show a compact contextual toolbar such as:

\`B  I  U  Lien  Décision  À faire  •••\`

Keyboard shortcuts should work on desktop/iPad hardware keyboards.

### Storage

Do not store arbitrary HTML.

Use structured text + formatting marks/ranges or block-level structures.

This keeps:
- sanitization manageable;
- export predictable;
- search independent of HTML;
- future migrations possible.

## 21. Hyperlinks

Selected words/sentences can receive a hyperlink.

Supported external schemes initially:
- \`https:\`;
- \`http:\`.

Open in a new browsing context with \`noopener noreferrer\`.

Smart paste may offer to turn a selected phrase into a link when a URL is pasted.

### Internal links

Support links to:
- another Carnet note;
- Transfert file;
- Dessiner drawing;
- Lecteur model/media;
- future project entity.

A future \`[[note]]\` syntax may provide fast internal-link autocomplete, but visible UI must always exist.

Backlinks should eventually show which notes reference the current note.

## 22. Images and media

Images are highly valuable for engineering notes:
- damaged part;
- machine setup;
- caliper reading;
- prototype;
- whiteboard;
- CAD screenshot;
- hand sketch.

Input choices on phone:
- camera;
- photo library;
- files.

### Storage

Never put binary image bytes into notebook JSON.

Use confined storage under something like:

\`.hq-carnet/assets/\`

JSON stores generated asset IDs and layout metadata only.

Use strict:
- auth;
- CSRF;
- generated names;
- type/signature validation;
- size limits;
- atomic finalize;
- no client filesystem paths.

Initial formats should favor JPEG/PNG/WebP.

Large phone photos should be downscaled client-side (e.g. around 2560 px long side) for notebook use.

### Layout

Default: inline image between text blocks, resizable from roughly 30–100% page width.

Optional later: free-position mode inside page bounds.

Free-floating layout should never be the default because it is fragile on phones.

### Image tools

On selection:
- resize;
- crop;
- caption;
- delete;
- optional free positioning.

Later:
- arrows;
- circles;
- freehand;
- dimensions;
- labels;
reusing a small subset of Dessiner concepts where practical.

## 23. Export and saving into Transfert

Distinguish:

### Internal notebook state

Autosaved, editable source of truth under \`.hq-carnet\`.

### Published/exported snapshot

Explicit user action creates a file under allowed Transfert folders.

The snapshot does not become a second live editor.

Possible targets:
- Inbox;
- Uni;
- Print;
- safe subfolder selection using existing confined file rules.

Never overwrite silently.

### Export formats

Priority:
1. TXT;
2. Markdown;
3. Print/PDF;
4. JSON interchange/backup;
5. possibly HTML later, download-only with active-content safeguards.

Markdown is especially suitable for engineering text, headings, checklists and relative image links.

PDF may initially use a print-optimized browser view rather than introducing a server PDF dependency.

### Linked export

A note may remember:
- exported file path;
- exported revision/time.

If edited afterward, show:
- \`Modifié depuis l'export\`.

Allow explicit:
- \`Mettre à jour la copie\`.

## 24. Engineering Sources / Références

Sources are a first-class engineering knowledge feature.

A source library may contain:
- book;
- standard;
- article;
- datasheet;
- manufacturer catalogue;
- internal procedure;
- web page;
- other.

Fields may include:
- source family ID;
- edition/revision ID;
- title;
- author/organization;
- edition/revision;
- year;
- publisher;
- ISBN/document number;
- URL;
- linked Transfert file;
- type;
- notes;
- active/archived status.

Sources are user-managed:
- add;
- edit;
- archive;
- remove from active library.

Removing a source from the active shelf must not destroy historical citations.

## 25. Source families and editions

A logical source family can have several editions/revisions.

Example:

\`\`\`text
Shigley's Mechanical Engineering Design
    ├── 11th edition
    └── 12th edition  ← current
\`\`\`

Do not mutate 11e into 12e because page mappings and content may differ.

Fixing metadata typos is an edit.

Changing edition/revision creates a new edition record and may mark the older edition superseded/archived.

## 26. Citations

While writing:
1. select or place cursor;
2. choose Référence;
3. choose recent/project source;
4. optionally enter locator;
5. insert compact citation.

Locator types:
- page;
- section;
- clause;
- chapter;
- figure;
- table;
- custom text.

Examples:
- \`Shigley 12e · p. 417\`
- \`ASME Y14.5-2018 · §7.4.2\`
- \`ISO 286-2 · Table 2\`.

Citations should be structured objects/marks, not plain text only.

Every citation should preserve enough metadata snapshot for historical readability even if the source record later changes.

## 27. Exact local PDF page jumps

This is a signature engineering feature.

If a source's PDF exists in Transfert, tapping the citation should open that exact local document at the exact relevant PDF page.

Important distinction:
- printed page / semantic locator;
- actual PDF page index.

Example:

\`\`\`json
{
  "locator": "p. 417",
  "pdf_page": 439
}
\`\`\`

because front matter shifts physical PDF pages.

### Dedicated Source Viewer

Long-term reliability should not depend solely on browser-specific \`#page=\` handling.

Plan a first-party local PDF viewer (e.g. locally vendored PDF renderer assets, no CDN) capable of:
- exact page navigation;
- current page display;
- zoom;
- next/previous;
- "Retour à la note";
- "Citer cette page";
- source metadata.

Python server architecture can remain stdlib-only because viewer code is static browser assets.

### Printed-page calibration

Optional source calibration:
- navigate to printed page 1;
- choose "Définir comme page 1";
- store offset or explicit mapping.

More complex sources may later support mapping ranges:
- front matter;
- normal Arabic pages;
- appendices;
- Roman numerals.

## 28. Verified source location

Allow a user-controlled factual state:

> ✓ Emplacement vérifié

Meaning:
- the user confirmed that this citation points to the claimed location in the actual source.

It does **not** mean:
- the information is automatically certified as true.

Possible source status indicators:
- document attached/local;
- edition specified;
- locator specified;
- location verified;
- URL available.

Avoid fake "trust scores".

## 29. Source replacement / supersession workflow

When a newer edition exists, old citations remain historically correct.

Show:
- newer edition available.

User may explicitly migrate a citation.

Never automatically copy an old page number to a new edition.

Migration UI should show:

\`\`\`text
Shigley
11e · p. 394
        ↓
12e · [ page / section ______ ]

[Conserver l’ancienne référence]
[Mettre à jour]
\`\`\`

If new location is unknown:
- allow "emplacement à vérifier";
- preserve old locator visibly in provenance.

After verified migration:

> Shigley 12e · p. 417  
> formerly 11e · p. 394

Keep both old and new provenance internally.

### Bulk source migration

If many citations use an older standard/book:
- show affected count;
- review citations;
- enter new locator per citation;
- skip/keep old where needed;
- confirm;
- preserve undo/history.

Never blindly rewrite all citations.

## 30. Find and Replace

Provide \`••• → Rechercher et remplacer\`.

Default scope:
- current note only.

UI:
- Rechercher;
- Remplacer par;
- occurrence count;
- previous/next;
- Remplacer;
- Tout remplacer.

An empty replacement means delete all matched occurrences in the chosen scope.

Optional controls:
- respect case;
- whole word.

Regex, if ever added, belongs under Advanced and must never be default.

### Wider scopes

Future explicit scope choices:
- this note;
- this project;
- this category;
- entire Carnet.

Any multi-note operation must show:
- number of occurrences;
- number of affected notes;
- preview;
- explicit confirmation;
- Undo.

Structured citations are not modified by ordinary text replacement.

Formatting marks should survive unaffected text replacement.

## 31. Safe bulk-operation framework

Reuse one interaction pattern for all potentially large changes:

1. choose scope;
2. count affected objects;
3. preview;
4. confirm;
5. apply revision-aware / atomically where possible;
6. offer Undo;
7. record one meaningful history event.

Applicable to:
- text replace;
- category change;
- project move;
- source migration;
- archive;
- linked-file replacement;
- future metadata updates.

## 32. Version history

Long-term professional use benefits from optional per-note history.

History stays behind \`••• → Historique\`.

Store meaningful snapshots/events rather than noisy UI.

Examples:
- normal edit;
- global replacement;
- source migration;
- restore.

Restoring an old version creates a new current revision; it does not erase later history.

Bulk operations should appear as one logical event, e.g.:

> 15:42 · Remplacement global — "M6" → "M8" · 14 occurrences

## 33. Engineering calculations and units

Later engineering tools should remain explicit and non-destructive.

### Unit conversion

Select:
- \`25.4 mm\`

Offer:
- \`1.000 in\`.

Useful families include:
- mm/in;
- N/lbf;
- N·m/lb·ft;
- bar/psi;
- °C/°F;
- kg/lb.

Prefer inserting converted value next to the original rather than silently replacing source data.

### Calculator

Provide a safe parser/evaluator.

Never use \`eval()\` / \`new Function()\`.

Possible expressions:
- arithmetic;
- common trig;
- engineering constants later.

### Calculation block

Structured example:

\`\`\`text
F = 350 N
r = 0.125 m
T = F × r = 43.75 N·m
\`\`\`

Keep inputs and result together.

## 34. Measurements and tolerances

Potential structured measurement block:

\`\`\`text
Ø Shaft
12.034 mm
Nominal 12.000 ±0.020 mm
\`\`\`

Future behavior:
- calculate deviation;
- indicate within/outside tolerance;
- link photo/source/drawing;
- timestamp automatically.

Avoid turning Carnet into formal metrology software; this is fast field/lab notation.

## 35. Engineering Journal / test sessions

Provide a daily engineering journal or optional Session mode.

Example:

\`\`\`text
Essai vibration moteur — 29 sept. 2026

10:13 — Démarrage, 1200 rpm
10:18 — vibration perceptible côté palier
10:21 — 48.2 °C
10:27 — arrêté, bruit disparu sous 800 rpm
\`\`\`

Time insertion should be one tap.

Session mode remains paper-like, not a mandatory form.

## 36. Decisions

Allow an explicit structured decision marker:

> DÉCISION · 15:06  
> Passage du support en 6061-T6, épaisseur 6 mm.

Bibliothèque/project views can later filter:
- Décisions.

This creates an informal engineering decision log without a separate application.

## 37. Checklists and task extraction

Rich text phase should support real clickable checklist items.

Selected text may offer:
- \`Ajouter à À faire\`.

Future HQ integration can create a task while leaving the original note text intact and linking back to it.

## 38. HQ deep links

Carnet should eventually link to:
- Transfert file;
- Dessiner drawing;
- Lecteur STL/GLB/media;
- another note;
- project.

From the other direction, HQ surfaces may later offer:
- Ajouter une note liée.

This makes Carnet the memory layer connecting HQ assets.

## 39. QR / physical-object links

Future optional feature:
- generate a small QR code for a note/project;
- attach to test rig, prototype, machine/toolbox;
- scan -> exact HQ note/project.

Useful for physical engineering context.

Not part of foundation.

## 40. Templates

New note default is always blank paper.

Long-press or secondary create may offer optional templates:
- Essai;
- Inspection;
- Réunion;
- Calcul;
- Mesures.

Templates insert useful content/blocks but are never mandatory forms.

## 41. Share

Where supported:
- native \`navigator.share()\`.

Fallback:
- copy.

Sharing never changes the live notebook source.

## 42. Clipboard

Copy selected text if non-empty selection exists; otherwise copy whole page.

Primary:
- \`navigator.clipboard.writeText()\`.

Fallback:
- temporary offscreen textarea;
- select;
- \`document.execCommand("copy")\`;
- restore focus/selection.

Feedback:
- \`Copié\`;
- \`Copie impossible\`.

Never log note content.

## 43. Page navigation and animation

Required:
- previous/next buttons;
- quick jump;
- left/right swipe;
- desktop keyboard.

Keyboard:
- Alt+Left / Alt+Right while editing;
- do not steal normal caret Left/Right.

Swipe:
- threshold around 60 CSS px;
- clear horizontal dominance;
- vertical scrolling unaffected;
- text selection gestures should not accidentally flip pages.

Animation:
- CSS 3D transform only;
- roughly 200–240 ms;
- no JS frame loop;
- temporary aria-hidden ghost sheet;
- cleanup after transition.

Reduced-motion:
- no 3D flip;
- navigation still works.

## 44. Home / global quick capture

Carnet should be prominent in main navigation, ideally immediately after Accueil.

Accueil may contain a read-only Carnet summary:
- number of pages;
- pinned count;
- a few recent/pinned titles;
- project/category markers;
- Ouvrir le Carnet;
- optional Nouvelle note.

Do not create a second editable textarea/autosave system on Accueil.

Desktop shortcut candidate:
- Ctrl/Cmd + Shift + N -> new note.

Global command palette may expose:
- Nouvelle note.

All routes open the same editor/state machine.

## 45. API direction for foundation

Prefer a small surface:

- \`GET /api/carnet\`
- \`GET /api/carnet?meta=1\`
- \`POST /api/carnet\`

Possible POST actions:
- save;
- create;
- delete / trash;
- restore;
- category_create;
- category_update;
- category_delete;
- project operations if projects ship in the same phase.

All mutations use existing CSRF and admin auth.

The current central \`api()\` helper should likely be enhanced backward-compatibly so JSON error responses expose status + parsed payload (needed for 409 conflict pages) while preserving existing 401/403 behavior.

## 46. Backup

Carnet is critical data.

Include committed notebook JSON in normal HQ backups.

Keep existing Inbox/Uni/Print backup semantics unchanged.

Do not change the historical meaning of the existing \`folders\` count; add a separate Carnet status field.

Coordinate snapshot read with the same notebook path lock.

Never copy \`.tmp\` files.

A live automatic Carnet restore UI should be a separate design/review because autosaving state makes restore coordination non-trivial.

Future attachments/source metadata must also be covered by backup design.

## 47. Security and privacy

- admin-only API;
- no upload-role access;
- no content in logs;
- no content in URLs;
- no unsafe \`innerHTML\`;
- external hyperlinks restricted to safe schemes;
- fixed storage paths;
- no client-supplied filesystem paths;
- generated attachment IDs/names;
- corrupted state preserved;
- bounded payloads;
- server-side limits;
- no external assets/CDNs;
- local drafts isolated by authenticated identity;
- source/document links confined to allowed Transfert paths.

## 48. Accessibility

- native editor semantics where possible;
- real labels;
- >=44px interactive targets;
- >=16px editor font on iOS;
- visible focus rings;
- pin uses \`aria-pressed\`;
- polite live status for save/page changes;
- conflict status announced;
- library bottom sheet restores focus;
- Escape closes sheets on desktop;
- reduced motion;
- ghost animation elements aria-hidden;
- adequate contrast.

## 49. Performance

Typing must never wait on network.

Avoid:
- full library DOM rebuild on every keystroke;
- duplicate event listeners;
- duplicate poll intervals;
- large synchronous transforms;
- animation JS loops.

Search stays local for small notebook size.

Media loading should be lazy.

Page flips should use composited transforms.

## 50. Testing philosophy

Carnet tests must focus especially on failure and races, not only happy-path CRUD.

Critical scenarios:
- typing during an in-flight save;
- old response arrives after newer typing;
- network failure;
- reload with unsent local draft;
- localStorage failure;
- pagehide/visibility transitions;
- two clients same page conflict;
- two clients different pages;
- category deletion while stale page is open;
- trash/restore;
- search safety;
- role privacy;
- no duplicate handlers/timers;
- reduced motion;
- WebKit iPhone;
- Chromium iPhone;
- desktop keyboard;
- clipboard fallback;
- malformed disk state;
- atomic write failure;
- backup coherence;
- source migration once implemented;
- exact PDF-page mapping once implemented;
- find/replace preview/undo once implemented.

Never claim real-iPhone validation unless run on a physical iPhone.

## 51. Things deliberately avoided

Even with an ambitious long-term vision, avoid features that destroy the core identity or create unjustified complexity:

- mandatory forms before capture;
- permanent giant toolbars;
- arbitrary HTML storage;
- arbitrary CSS from note data;
- silent conflict resolution;
- silent global find/replace;
- silent source-edition migration;
- auto-generated trust scores;
- automatic AI rewriting of engineering notes;
- external fonts/CDNs;
- duplicated independent editor surfaces.

AI assistance may exist later only as explicit, reversible actions that never mutate source notes without user intent.

## 52. Product identity

Carnet should feel like:

> a small physical engineering notebook that happens to know where all your files, drawings, models, measurements and references live.

The UI may become powerful, but the first screen must remain deceptively simple.

The feature succeeds if:
- quick capture is faster than reaching for another app;
- old information is easier to find than in paper notebooks;
- citations are faster to verify than manually reopening books/standards;
- engineering context survives months/years;
- no feature makes the user hesitate before typing.
