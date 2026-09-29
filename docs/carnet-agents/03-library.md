# 03 — Library / organization / retrieval

Base: accepted Stage 02. Branch: \`feat/carnet-library\`.

Read CONTEXT, TESTS, HANDOFF. Do not read full design unless current schema differs.

Scope only: Bibliothèque, project/category UI, À classer, pins, recents, search, trash UX, Focus mode, Home summary.

## Mobile
Library = ~85–90% bottom sheet:
- search
- Toutes / Épinglées / Récentes / À classer
- projects/categories
- management controls
- result cards
Tap result -> close sheet -> current editor.

## Desktop
Collapsible 260–300px left library, same state/logic, no second editor.

Result:
- title = first non-empty line; fallback \`Page sans titre\`
- safe 1–2 line preview
- context/pin/modified time
- textContent only

Search locally: lowercase + accent folding. Search title/body/category/project. Ranking: title > pinned > body > context; recency tie-break. No request per keystroke.

Project/category assignment from compact context sheet, max 1–2 taps. Create in filtered context inherits project/category; global create stays À classer.

Pin is page metadata via existing Stage-02 save queue.

Recents: Aujourd'hui / Hier / Cette semaine / older.

Trash: delete = soft-delete + Undo. Corbeille separate. Trashed note read-only until restore. Permanent delete deep confirmation.

Focus mode: hides nonessential chrome/library; explicit exit; Escape desktop.

Home: read-only Carnet summary near top, page/pin counts + up to ~3 recent/pinned safe titles. Ouvrir, optional Nouvelle note only through same editor. Upload role sees no private previews.

## Tests
Search case/accent/rank/safety; context CRUD/inheritance; pin; recents; trash/undo/read-only/restore/permanent; Focus; mobile/desktop; Home privacy + launcher; no duplicate editor; >=44px; nav density; Stage-02 autosave/conflict regression.

STOP before rich formatting/links/images/sources.

Compact HANDOFF.
