# 03 — Library / organization / retrieval

**Working mode:** edit the existing `C:\Transfert` working tree directly. Do not create/switch branches or worktrees. Do not commit/push unless separately authorized. Never run feature tests against live runtime state; use throwaway roots.

Base: accepted Stage 02 state in the current working tree.

Read CONTEXT, TESTS, HANDOFF. Do not read full design unless current schema differs.

Targets are equally important: Windows PC, iPad and iPhone. Do not treat desktop as a stretched mobile fallback.

Scope only: Bibliothèque, project/category UI, À classer, pins, recents, search, trash UX, Focus mode, Home summary.

## Phone
Library = ~85–90% bottom sheet:
- search
- Toutes / Épinglées / Récentes / À classer
- projects/categories
- management controls
- result cards
Tap result -> close sheet -> current editor.

## iPad
Use available width intelligently:
- bottom sheet or collapsible sidebar depending responsive breakpoint/orientation;
- never cover the paper unnecessarily on wide landscape;
- touch targets remain comfortable;
- hardware keyboard/Escape behavior works.

## Desktop PC
First-class desktop workspace:
- collapsible 260–300px left library/sidebar;
- paper remains dominant;
- mouse/keyboard interactions;
- no forced full-screen mobile bottom sheet at desktop widths;
- same data/state/one editor as mobile.

Result:
- title = first non-empty line; fallback `Page sans titre`
- safe 1–2 line preview
- context/pin/modified time
- textContent only

Search locally: lowercase + accent folding. Search title/body/category/project. Ranking: title > pinned > body > context; recency tie-break. No request per keystroke.

Project/category assignment from compact context sheet/popover appropriate to viewport, max 1–2 taps/clicks. Create in filtered context inherits project/category; global create stays À classer.

Pin is page metadata via existing Stage-02 save queue.

Recents: Aujourd'hui / Hier / Cette semaine / older.

Trash: delete = soft-delete + Undo. Corbeille separate. Trashed note read-only until restore. Permanent delete deep confirmation.

Focus mode: hides nonessential chrome/library; explicit exit; Escape desktop/hardware keyboard.

Home: read-only Carnet summary near top, page/pin counts + up to ~3 recent/pinned safe titles. Ouvrir, optional Nouvelle note only through same editor. Upload role sees no private previews.

## Tests
Search case/accent/rank/safety; context CRUD/inheritance; pin; recents; trash/undo/read-only/restore/permanent; Focus; phone/iPad/desktop responsive modes; mouse + keyboard; Home privacy + launcher; no duplicate editor; touch targets >=44px; nav density; Stage-02 autosave/conflict regression; same note navigates/edits consistently across desktop and mobile contexts.

STOP before rich formatting/links/images/sources.

Compact HANDOFF; include current HEAD SHA and working-tree diff status.
