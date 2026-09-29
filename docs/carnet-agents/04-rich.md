# 04 — Rich text / links / replace / export

Base accepted Stage 03. Branch \`feat/carnet-rich\`.

Read CONTEXT, TESTS, HANDOFF. Inspect current persisted content schema before editing.

If migration is required: version it, atomic/tested, no content loss.

Scope:
- structured formatting
- external/internal hyperlinks foundation
- checklists
- find/replace
- TXT/Markdown/print-PDF
- explicit publish snapshot into Transfert

No Sources/PDF source viewer. No image attachments.

## Content
Never arbitrary HTML. Structured blocks + marks.

Formatting: bold, italic, underline, highlight, heading, bullets, numbered list, checklist, monospace.

No permanent toolbar. Selection contextual actions; desktop shortcuts where safe. Preserve iOS selection behavior.

## Links
External link selected text. Allow only http/https. Render safely with \`noopener noreferrer\`; no server fetch.
Internal stable refs: Carnet note + allowed HQ file/drawing/model/media foundations.

## Find/replace
Default scope = current note.
Fields Find / Replace. Empty replacement deletes matches.
Previous/next, replace one/all, case, whole-word.
No regex default.
Replace-all shows count and Undo.
If any wider scope ships: explicit scope + occurrences + affected notes + preview + confirm + revision-aware apply + Undo.
Never rewrite structured citations as plain text.
Maintain unaffected marks correctly.

## Export
TXT; Markdown; print-optimized browser PDF path. Optional structured JSON.
No new pip PDF lib.

Publish:
\`Enregistrer une copie dans Transfert…\`
Only confined Inbox/Uni/Print/subfolder rules. Carnet remains source of truth; file is snapshot. Safe derived filename; editable; noclobber.
May remember export path + exported revision/time; later edit shows \`Modifié depuis l'export\`; update is explicit.

## Tests
migration; formatting persistence; selection + iOS; safe/unsafe URL; internal refs; checklist; replace empty/case/whole/marks/undo; TXT/MD/print; path confinement/noclobber; linked-export stale indicator; Stage-02 concurrency on structured content.

STOP before Sources.

Compact HANDOFF.
