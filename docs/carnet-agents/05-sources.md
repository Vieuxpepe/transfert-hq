# 05 — Engineering Sources / citations / exact PDF location

**Working mode:** edit the existing `C:\Transfert` working tree directly. Do not create/switch branches or worktrees. Do not commit/push unless separately authorized. Never run feature tests against live runtime state; use throwaway roots.

Base: accepted Stage 04 state already present in the same current `main` working tree. Stay on `main`.

Read CONTEXT, TESTS, HANDOFF. This stage optimizes provenance and fast verification.

## Model

Separate source family from edition/revision.

Edition fields as needed:
title, author/org, edition/revision, year, publisher, ISBN/doc no., type, URL, confined Transfert file ref, notes, lifecycle/supersession metadata.

Types: book, standard, article, datasheet, manufacturer catalogue, internal procedure, web, other.

Never mutate an old edition into a new one. Archive/removal cannot break historical citations.

Citation:
- source edition ID
- semantic locator
- optional actual PDF page
- essential metadata snapshot
- verified-location flag
- migration provenance

Locators: page, section, clause, chapter, figure, table, custom.

## Fast insertion

\`Référence\` picker order:
1. recent
2. project-preferred
3. search

Common path should be ~Référence -> source -> locator -> done.

## Local file + exact page

Store confined relative PDF reference, never arbitrary absolute path.

Distinguish:
- semantic/printed locator, e.g. p.417
- actual PDF page index, e.g. 439

Optional calibration: user navigates to printed page 1 and defines mapping. Do not assume printed page == PDF page.

Citation click must preserve back-to-note context.

## Viewer

Goal: exact local PDF page, current page, zoom, prev/next, Retour à la note, Citer cette page.

Do not claim browser \`#page=\` is universally reliable. If using a locally vendored PDF renderer:
- no CDN
- license/provenance committed
- CSP compatible
- static browser assets only; server stays stdlib
- deterministic asset MIME

If full viewer is too large for a safe PR, split this stage into 05a source/citation model + browser fallback and 05b dedicated viewer. State limitations honestly.

## Verified locator

\`✓ Emplacement vérifié\` means user verified location only, never that information is certified true. No automated trust score.

## Edition replacement

Show newer edition but keep old citation correct.
Never copy old page number automatically.

Migration choices:
- keep old
- new edition + verified locator
- new edition + emplacement à vérifier

Preserve \`replaced_from\` edition+locator.

Bulk migration: count citations/notes, review each, skip allowed, preview, confirm, revision-aware, Undo/history if available. Never blind rewrite.

## Tests
source CRUD/families/editions/archive; citation snapshots; all locator kinds; picker ranking; confined PDF path; calibration/mapping; exact jump; Chromium/WebKit viewer; return-to-note; cite-this-page; verified semantics; supersession; unknown new locator; bulk preview/skip/undo; provenance remains; unsafe URLs/path traversal rejected.

STOP before note media attachments.

Compact HANDOFF; include current HEAD SHA and working-tree diff status.
